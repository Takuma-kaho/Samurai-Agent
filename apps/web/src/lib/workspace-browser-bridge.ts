import {
  browserWorkspaceHealth,
  browserWorkspaceRequest,
  createBrowserWorkspaceConnectionState,
  loadBrowserWorkspaceConnection,
  loadBrowserWorkspaceConnections,
  registerBrowserWorkspaceAccount,
  selectBrowserWorkspaceConnection,
  selectBrowserWorkspaceCandidate,
  subscribeBrowserWorkspaceRealtime
} from "./workspace-browser-auth";
import { DomainApiClient, PublicAgentBackendRecordSchema, type DomainApiTransportRequest, type PublicRoomRecord } from "@samurai-agent/domain-api";
import type {
  AgentBackendAvailability,
  ArtifactDetail,
  AuditPayload,
  ChatTurnResult,
  ChatSurfaceOperationResult,
  DesktopRoomMemberPreview,
  DesktopRoomMovePreview,
  DesktopWorkspaceConnection,
  DesktopWorkspaceConnectionState,
  DesktopWorkspaceDirectoryEntry,
  DesktopWorkspaceDirectoryResult,
  DesktopWorkspaceAgent,
  DesktopWorkspaceRoomAgentMember,
  DesktopWorkspaceRoomAgentMemberList,
  DesktopWorkspaceAgentDm,
  DesktopWorkspaceLearningSettings,
  DesktopWorkspaceRoom,
  DesktopWorkspaceRoomDefaultAgent,
  DesktopWorkspaceRoomMembership,
  DesktopWorkspaceRoomWork,
  DesktopWorkspaceRoomWorkAssignee,
  DesktopWorkspaceRoomWorkComment,
  DesktopWorkspaceRoomWorkControl,
  DesktopWorkspaceRoomWorkExecutionReservation,
  DesktopWorkspaceRoomWorkInstruction,
  DesktopWorkspaceRoomWorkListResult,
  DesktopWorkspaceRoomWorkReaction,
  DesktopWorkspaceRoomWorkView,
  DesktopWorkspacePublicEvent,
  DesktopWorkspacePublicEventPage,
  DesktopWorkspaceServerStatus,
  DomainCommandInputSource,
  GeneratedSurfaceBundleDetail,
  GeneratedSurfaceDetail,
  GeneratedSurfaceExportPayload,
  SearchResult,
  SessionDetail,
  SkillOptimizationDetail,
  SurfaceContractPayload,
  WorkspaceCompletionResourceBody,
  WorkspaceCompletionResourceDetail,
  WorkspaceCompletionResourceView,
  WorkspaceAttachmentUploadResult,
  WorkspaceKnowledgeMemoryPage,
  WorkspaceKnowledgeWikiPage
} from "./api";
import {
  WorkspaceFileResourceRefSchema,
  type ActivityInboxItem,
  type AutomationJobRecord,
  type BackendEventRecord,
  type BackendRunRecord,
  type CollectionRecord,
  type CollectionSchema,
  type ArtifactRecord,
  type JsonValue,
  type MemoryFrontmatter,
  type ResourceRef,
  type SessionRecord,
  type SettingsRecord,
  type SupportedLocale,
  type WikiFrontmatter
} from "@samurai-agent/core-schemas";
import type { SurfaceOperation, SurfaceOperationResultEnvelope } from "@samurai-agent/ui-protocol";
import type { AutomationRunSummary } from "./api";
import type { NativeRoomCreateInput } from "../native-app/types";

type DesktopBridge = NonNullable<Window["samuraiDesktop"]>;
type RoomWorkReassignInput = {
  roomId: string;
  workId: string;
  assigneeId: string;
  agentId: string;
  expectedVersion?: number;
  expectedGeneration?: number;
  operationId: string;
};

type RoomWorkDelegateInput = {
  roomId: string;
  workId: string;
  assigneeId: string;
  agentId: string;
  instruction: string;
  dependencyAssigneeIds?: string[];
  attachments?: ResourceRef[];
  expectedVersion?: number;
  expectedGeneration?: number;
  operationId: string;
};

type RoomWorkDelegateBridge = {
  delegateWorkspaceRoomWorkAssignee: (input: RoomWorkDelegateInput) => Promise<DesktopWorkspaceRoomWorkAssignee & { replayed: boolean }>;
};

/**
 * Browser counterpart of the Desktop Workspace bridge.
 *
 * Each method is a fixed Domain Operation or Query. The browser never gets a
 * generic signed-request function from this module; the private Ed25519 key
 * remains a CryptoKey in IndexedDB and the server still performs all Room/RLS
 * checks.
 */
export function createBrowserWorkspaceBridge(): DesktopBridge {
  const bridge: DesktopBridge & RoomWorkDelegateBridge = {
    listWorkspaceConnections: async () => browserConnectionState(),
    listWorkspaceDirectory: listBrowserWorkspaceDirectory,
    listWorkspaceAccountWorkspaces: async (input) => listBrowserWorkspaceDirectory(input?.connectionId),
    createWorkspace: async (input) => browserWorkspaceRequest({
      method: "POST",
      path: "/api/workspaces",
      ...(input.operationId ? { operationId: input.operationId, idempotencyKey: input.operationId } : {}),
      body: {
        workspace_id: input.workspaceId ?? `workspace_${crypto.randomUUID()}`,
        name: input.name
      }
    }),
    exportWorkspaceBundle: (input) => workspaceRequest(
      "POST",
      "/bundle/export",
      input.expectedWorkspaceVersion === undefined ? {} : { expected_workspace_version: input.expectedWorkspaceVersion },
      input.operationId,
      input.operationId
    ),
    restoreWorkspaceBundle: (input) => browserWorkspaceRequest({
      method: "POST",
      path: "/api/workspaces/bundles/restore",
      ...(input.operationId ? { operationId: input.operationId, idempotencyKey: input.operationId } : {}),
      body: {
        bundle_id: input.bundleId,
        confirm: true,
        ...(input.targetWorkspaceId ? { target_workspace_id: input.targetWorkspaceId } : {})
      }
    }),
    upsertWorkspaceConnection: async () => {
      throw new Error("workspace_browser_identity_required");
    },
    selectWorkspaceConnection: async (connectionId) => {
      await selectBrowserWorkspaceConnection(connectionId);
      return browserConnectionState();
    },
    selectWorkspaceCandidate: async (input) => {
      await selectBrowserWorkspaceCandidate(input);
      return browserConnectionState();
    },
    selectWorkspaceTarget: async (target) => {
      await selectBrowserWorkspaceCandidate(target);
      return browserConnectionState();
    },
    registerWorkspaceServerAccount: (displayName) => registerBrowserWorkspaceAccount(displayName),
    getWorkspaceServerStatus: browserWorkspaceServerStatus,
    getWorkspaceSettings: () => workspaceRequest<SettingsRecord>("GET", "/settings"),
    patchWorkspaceSettings: (input) => workspaceRequest("PATCH", "/settings", input.patch, input.operationId),
    listWorkspaceAgents: async (input) => {
      const connection = await requireBrowserWorkspaceConnection();
      assertBrowserAgentTarget(connection, input?.target);
      const snapshot = { id: connection.id, workspaceId: connection.workspaceId };
      const response = await browserSnapshotDomainApiClient(snapshot).executeQuery<unknown>(connection.workspaceId, "agent.list", { context: {}, input: {} });
      await assertBrowserWorkspaceSnapshot(snapshot);
      return { agents: toDesktopWorkspaceAgentList(response.result, connection.workspaceId) };
    },
    viewWorkspaceAgent: async (input) => {
      const agentId = requirePublicId(input.agentId, "agentId");
      const connection = await requireBrowserWorkspaceConnection();
      assertBrowserAgentTarget(connection, input.target);
      const snapshot = { id: connection.id, workspaceId: connection.workspaceId };
      const response = await browserSnapshotDomainApiClient(snapshot).executeQuery<unknown>(connection.workspaceId, "agent.view", { context: {}, input: { id: agentId } });
      await assertBrowserWorkspaceSnapshot(snapshot);
      const agent = toDesktopWorkspaceAgentDetail(response.result, connection.workspaceId);
      if (agent.id !== agentId) throw new Error("workspace_agent_response_scope_invalid");
      return agent;
    },
    createWorkspaceAgent: async (input) => {
      const connection = await requireBrowserWorkspaceConnection();
      assertBrowserAgentTarget(connection, input.target);
      const snapshot = { id: connection.id, workspaceId: connection.workspaceId };
      const response = await browserSnapshotDomainApiClient(snapshot).executeOperation<unknown>(connection.workspaceId, "agent.create", {
        context: {},
        input: { name: input.name, role: input.role, instructions: input.instructions, backend_id: input.backendId, enabled: input.enabled }
      }, { operationId: input.operationId, idempotencyKey: input.operationId });
      await assertBrowserWorkspaceSnapshot(snapshot);
      return { ...toDesktopWorkspaceAgentDetail(response.result, connection.workspaceId), replayed: response.replayed };
    },
    patchWorkspaceAgent: async (input) => {
      const agentId = requirePublicId(input.agentId, "agentId");
      const connection = await requireBrowserWorkspaceConnection();
      assertBrowserAgentTarget(connection, input.target);
      const snapshot = { id: connection.id, workspaceId: connection.workspaceId };
      const response = await browserSnapshotDomainApiClient(snapshot).executeOperation<unknown>(connection.workspaceId, "agent.patch", {
        context: {},
        input: {
          id: agentId,
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.role === undefined ? {} : { role: input.role }),
          ...(input.instructions === undefined ? {} : { instructions: input.instructions }),
          ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
          ...(input.expectedVersion === undefined ? {} : { expected_version: input.expectedVersion })
        }
      }, { operationId: input.operationId, idempotencyKey: input.operationId });
      await assertBrowserWorkspaceSnapshot(snapshot);
      const agent = toDesktopWorkspaceAgentDetail(response.result, connection.workspaceId);
      if (agent.id !== agentId) throw new Error("workspace_agent_response_scope_invalid");
      return { ...agent, replayed: response.replayed };
    },
    bindWorkspaceAgentBackend: async (input) => {
      const agentId = requirePublicId(input.agentId, "agentId");
      const backendId = requirePublicId(input.backendId, "backendId");
      const connection = await requireBrowserWorkspaceConnection();
      assertBrowserAgentTarget(connection, input.target);
      const snapshot = { id: connection.id, workspaceId: connection.workspaceId };
      const response = await browserSnapshotDomainApiClient(snapshot).executeOperation<unknown>(connection.workspaceId, "agent.backend.bind", {
        context: {},
        input: { id: agentId, backend_id: backendId, ...(input.expectedVersion === undefined ? {} : { expected_version: input.expectedVersion }) }
      }, { operationId: input.operationId, idempotencyKey: input.operationId });
      await assertBrowserWorkspaceSnapshot(snapshot);
      const agent = toDesktopWorkspaceAgentDetail(response.result, connection.workspaceId);
      if (agent.id !== agentId) throw new Error("workspace_agent_response_scope_invalid");
      return { ...agent, replayed: response.replayed };
    },
    listWorkspaceRoomAgentMembers: async (input) => {
      const roomId = requirePublicId(input.roomId, "roomId");
      const connection = await requireBrowserWorkspaceConnection();
      assertBrowserAgentTarget(connection, input.target);
      const snapshot = { id: connection.id, workspaceId: connection.workspaceId };
      const response = await browserSnapshotDomainApiClient(snapshot).executeQuery<unknown>(connection.workspaceId, "room.member.list", { context: { room_id: roomId }, input: {} });
      await assertBrowserWorkspaceSnapshot(snapshot);
      return toDesktopWorkspaceRoomAgentMemberList(response.result, roomId);
    },
    setWorkspaceRoomAgentPermission: async (input) => {
      const roomId = requirePublicId(input.roomId, "roomId");
      const agentId = requirePublicId(input.agentId, "agentId");
      const connection = await requireBrowserWorkspaceConnection();
      assertBrowserAgentTarget(connection, input.target);
      const snapshot = { id: connection.id, workspaceId: connection.workspaceId };
      const response = await browserSnapshotDomainApiClient(snapshot).executeOperation<unknown>(connection.workspaceId, "room.agent.permission.set", {
        context: { room_id: roomId },
        input: { agent_id: agentId, can_view: input.canView, can_edit: input.canEdit, can_execute: input.canExecute }
      }, { operationId: input.operationId, idempotencyKey: input.operationId });
      await assertBrowserWorkspaceSnapshot(snapshot);
      const permission = toDesktopWorkspaceRoomAgentMember(response.result, roomId);
      if (permission.agentId !== agentId) throw new Error("workspace_room_agent_response_scope_invalid");
      return { ...permission, replayed: response.replayed };
    },
    removeWorkspaceRoomAgent: async (input) => {
      const roomId = requirePublicId(input.roomId, "roomId");
      const agentId = requirePublicId(input.agentId, "agentId");
      const connection = await requireBrowserWorkspaceConnection();
      assertBrowserAgentTarget(connection, input.target);
      const snapshot = { id: connection.id, workspaceId: connection.workspaceId };
      const response = await browserSnapshotDomainApiClient(snapshot).executeOperation<unknown>(connection.workspaceId, "room.agent.remove", {
        context: { room_id: roomId },
        input: { agent_id: agentId }
      }, { operationId: input.operationId, idempotencyKey: input.operationId });
      await assertBrowserWorkspaceSnapshot(snapshot);
      const permission = toDesktopWorkspaceRoomAgentMember(response.result, roomId);
      if (permission.agentId !== agentId) throw new Error("workspace_room_agent_response_scope_invalid");
      return { ...permission, replayed: response.replayed };
    },
    listWorkspaceRooms: async () => {
      const connection = await requireBrowserWorkspaceConnection();
      const response = await browserDomainApiClient.executeQuery<PublicRoomRecord[]>(connection.workspaceId, "room.list", { context: {}, input: {} });
      await assertBrowserWorkspaceSnapshot(connection);
      return { rooms: response.result.map(toDesktopWorkspaceRoom) };
    },
    listWorkspaceRoomWorks: async (input) => {
      const roomId = requirePublicId(input.roomId, "roomId");
      const connection = await requireBrowserWorkspaceConnection();
      const response = await browserDomainApiClient.executeQuery<unknown>(connection.workspaceId, "room.work.list", {
        context: { room_id: roomId },
        input: {
          ...(input.status ? { status: input.status } : {}),
          ...(input.cursor ? { cursor: input.cursor } : {}),
          ...(input.limit === undefined ? {} : { limit: input.limit })
        }
      });
      await assertBrowserWorkspaceSnapshot(connection);
      return toDesktopRoomWorkList(response.result, roomId);
    },
    getWorkspaceRoomWork: async (input) => {
      const roomId = requirePublicId(input.roomId, "roomId");
      const workId = requirePublicId(input.workId, "workId");
      const connection = await requireBrowserWorkspaceConnection();
      const response = await browserDomainApiClient.executeQuery<unknown>(connection.workspaceId, "room.work.view", {
        context: { room_id: roomId },
        input: { work_id: workId }
      });
      await assertBrowserWorkspaceSnapshot(connection);
      const work = toDesktopRoomWorkView(response.result);
      assertRoomWorkScope(work, roomId, workId);
      return work;
    },
    createWorkspaceRoomWork: async (input) => {
      const roomId = requirePublicId(input.roomId, "roomId");
      const attachments = strictRoomWorkAttachments(input.attachments);
      const connection = await requireBrowserWorkspaceConnection();
      const response = await browserDomainApiClient.executeOperation<unknown>(connection.workspaceId, "room.work.create", {
        context: { room_id: roomId },
        input: {
          ...(input.instruction === undefined ? {} : { instruction: input.instruction }),
          ...(attachments.length ? { attachments } : {}),
          ...(input.agentId ? { agent_id: input.agentId } : {})
        }
      }, { operationId: input.operationId, idempotencyKey: input.operationId });
      await assertBrowserWorkspaceSnapshot(connection);
      const work = toDesktopRoomWork(response.result);
      assertRoomWorkScope(work, roomId);
      return withReplayed(work, response.replayed);
    },
    replyWorkspaceRoomWork: async (input) => {
      const roomId = requirePublicId(input.roomId, "roomId");
      const workId = requirePublicId(input.workId, "workId");
      const attachments = strictRoomWorkAttachments(input.attachments);
      const connection = await requireBrowserWorkspaceConnection();
      const response = await browserDomainApiClient.executeOperation<unknown>(connection.workspaceId, "room.work.reply", {
        context: { room_id: roomId },
        input: {
          work_id: workId,
          ...(input.assigneeId ? { assignee_id: input.assigneeId } : {}),
          ...(input.instruction === undefined ? {} : { instruction: input.instruction }),
          ...(attachments.length ? { attachments } : {}),
          ...(input.expectedVersion === undefined ? {} : { expected_version: input.expectedVersion }),
          ...(input.expectedGeneration === undefined ? {} : { expected_generation: input.expectedGeneration })
        }
      }, { operationId: input.operationId, idempotencyKey: input.operationId });
      await assertBrowserWorkspaceSnapshot(connection);
      const instruction = toDesktopRoomWorkInstruction(response.result);
      assertRoomWorkScope(instruction, roomId, workId);
      return withReplayed(instruction, response.replayed);
    },
    createWorkspaceRoomWorkComment: async (input) => {
      const roomId = requirePublicId(input.roomId, "roomId");
      const workId = requirePublicId(input.workId, "workId");
      const attachments = strictRoomWorkAttachments(input.attachments);
      const connection = await requireBrowserWorkspaceConnection();
      const response = await browserDomainApiClient.executeOperation<unknown>(connection.workspaceId, "room.work.comment.create", {
        context: { room_id: roomId },
        input: {
          work_id: workId,
          ...(input.body === undefined ? {} : { body: input.body }),
          ...(attachments.length ? { attachments } : {}),
          ...(input.expectedVersion === undefined ? {} : { expected_version: input.expectedVersion })
        }
      }, { operationId: input.operationId, idempotencyKey: input.operationId });
      await assertBrowserWorkspaceSnapshot(connection);
      const comment = toDesktopRoomWorkComment(response.result);
      assertRoomWorkScope(comment, roomId, workId);
      return withReplayed(comment, response.replayed);
    },
    applyWorkspaceRoomWorkComment: async (input) => {
      const roomId = requirePublicId(input.roomId, "roomId");
      const workId = requirePublicId(input.workId, "workId");
      const commentId = requirePublicId(input.commentId, "commentId");
      const connection = await requireBrowserWorkspaceConnection();
      const response = await browserDomainApiClient.executeOperation<unknown>(connection.workspaceId, "room.work.comment.apply", {
        context: { room_id: roomId },
        input: {
          work_id: workId,
          comment_id: commentId,
          comment_version: input.commentVersion,
          ...(input.assigneeId ? { assignee_id: input.assigneeId } : {}),
          ...(input.expectedVersion === undefined ? {} : { expected_version: input.expectedVersion }),
          ...(input.expectedGeneration === undefined ? {} : { expected_generation: input.expectedGeneration })
        }
      }, { operationId: input.operationId, idempotencyKey: input.operationId });
      await assertBrowserWorkspaceSnapshot(connection);
      const instruction = toDesktopRoomWorkInstruction(response.result);
      assertRoomWorkScope(instruction, roomId, workId);
      return withReplayed(instruction, response.replayed);
    },
    reactWorkspaceRoomWorkComment: async (input) => {
      const roomId = requirePublicId(input.roomId, "roomId");
      const workId = requirePublicId(input.workId, "workId");
      const commentId = requirePublicId(input.commentId, "commentId");
      const connection = await requireBrowserWorkspaceConnection();
      const response = await browserDomainApiClient.executeOperation<unknown>(connection.workspaceId, "room.work.comment.reaction.set", {
        context: { room_id: roomId },
        input: {
          work_id: workId,
          comment_id: commentId,
          reaction: input.reaction ?? "like",
          enabled: input.enabled ?? true,
          ...(input.expectedVersion === undefined ? {} : { expected_version: input.expectedVersion })
        }
      }, { operationId: input.operationId, idempotencyKey: input.operationId });
      await assertBrowserWorkspaceSnapshot(connection);
      const reaction = toDesktopRoomWorkReaction(response.result);
      assertRoomWorkScope(reaction, roomId, workId);
      if (reaction.commentId !== commentId) throw new Error("room_work_reaction_scope_invalid");
      return withReplayed(reaction, response.replayed);
    },
    stopWorkspaceRoomWork: async (input) => {
      const roomId = requirePublicId(input.roomId, "roomId");
      const workId = requirePublicId(input.workId, "workId");
      const connection = await requireBrowserWorkspaceConnection();
      const response = await browserDomainApiClient.executeOperation<unknown>(connection.workspaceId, "room.work.stop", {
        context: { room_id: roomId },
        input: {
          work_id: workId,
          ...(input.reason ? { reason: input.reason } : {}),
          ...(input.expectedVersion === undefined ? {} : { expected_version: input.expectedVersion }),
          ...(input.expectedGeneration === undefined ? {} : { expected_generation: input.expectedGeneration })
        }
      }, { operationId: input.operationId, idempotencyKey: input.operationId });
      await assertBrowserWorkspaceSnapshot(connection);
      const control = toDesktopRoomWorkControl(response.result);
      assertRoomWorkScope(control, roomId, workId);
      return withReplayed(control, response.replayed);
    },
    stopWorkspaceRoomWorkAssignee: async (input) => {
      const roomId = requirePublicId(input.roomId, "roomId");
      const workId = requirePublicId(input.workId, "workId");
      const assigneeId = requirePublicId(input.assigneeId, "assigneeId");
      const connection = await requireBrowserWorkspaceConnection();
      const response = await browserDomainApiClient.executeOperation<unknown>(connection.workspaceId, "room.work.assignee.stop", {
        context: { room_id: roomId },
        input: {
          work_id: workId,
          assignee_id: assigneeId,
          ...(input.reason ? { reason: input.reason } : {}),
          ...(input.expectedVersion === undefined ? {} : { expected_version: input.expectedVersion }),
          ...(input.expectedGeneration === undefined ? {} : { expected_generation: input.expectedGeneration })
        }
      }, { operationId: input.operationId, idempotencyKey: input.operationId });
      await assertBrowserWorkspaceSnapshot(connection);
      const control = toDesktopRoomWorkControl(response.result);
      assertRoomWorkScope(control, roomId, workId);
      if (control.assigneeId !== assigneeId) throw new Error("room_work_control_scope_invalid");
      return withReplayed(control, response.replayed);
    },
    reassignWorkspaceRoomWorkAssignee: reassignBrowserRoomWork,
    reassignWorkspaceRoomWork: reassignBrowserRoomWork,
    delegateWorkspaceRoomWorkAssignee: delegateBrowserRoomWork,
    setWorkspaceRoomDefaultAgent: async (input) => {
      const roomId = requirePublicId(input.roomId, "roomId");
      const agentId = requirePublicId(input.agentId, "agentId");
      const connection = await requireBrowserWorkspaceConnection();
      assertBrowserAgentTarget(connection, input.target);
      const snapshot = { id: connection.id, workspaceId: connection.workspaceId };
      const response = await browserSnapshotDomainApiClient(snapshot).executeOperation<unknown>(connection.workspaceId, "room.default_agent.set", {
        context: { room_id: roomId },
        input: {
          agent_id: agentId,
          ...(input.expectedVersion === undefined ? {} : { expected_version: input.expectedVersion })
        }
      }, { operationId: input.operationId, idempotencyKey: input.operationId });
      await assertBrowserWorkspaceSnapshot(snapshot);
      const defaultAgent = toDesktopRoomWorkDefaultAgent(response.result);
      if (defaultAgent.roomId !== roomId || defaultAgent.agentId !== agentId) throw new Error("room_default_agent_response_scope_invalid");
      return withReplayed(defaultAgent, response.replayed);
    },
    openWorkspaceAgentDm: async (input) => {
      const agentId = requirePublicId(input.agentId, "agentId");
      const connection = await requireBrowserWorkspaceConnection();
      assertBrowserAgentTarget(connection, input.target);
      const snapshot = { id: connection.id, workspaceId: connection.workspaceId };
      const response = await browserSnapshotDomainApiClient(snapshot).executeOperation<unknown>(connection.workspaceId, "agent.dm.open", {
        context: {},
        input: { agent_id: agentId }
      }, { operationId: input.operationId, idempotencyKey: input.operationId });
      await assertBrowserWorkspaceSnapshot(snapshot);
      const dm = toDesktopAgentDm(response.result);
      if (dm.workspaceId !== snapshot.workspaceId || dm.agentId !== agentId || dm.kind !== "agent_dm") throw new Error("agent_dm_response_scope_invalid");
      return withReplayed(dm, response.replayed);
    },
    listWorkspaceEvents: async (input) => {
      const connection = await requireBrowserWorkspaceConnection();
      const page = await browserDomainApiClient.listEvents(connection.workspaceId, {
        ...(input.roomId ? { roomId: requirePublicId(input.roomId, "roomId") } : {}),
        ...(input.afterCursor ? { afterCursor: input.afterCursor } : {}),
        ...(input.limit === undefined ? {} : { limit: input.limit })
      });
      await assertBrowserWorkspaceSnapshot(connection);
      return toDesktopPublicEventPage(page, input.roomId);
    },
    listWorkspaceAgentBackends: async (input) => {
      const connection = await requireBrowserWorkspaceConnection();
      assertBrowserAgentTarget(connection, input?.target);
      const snapshot = { id: connection.id, workspaceId: connection.workspaceId };
      const response = await browserSnapshotDomainApiClient(snapshot).executeQuery<unknown>(connection.workspaceId, "agent.backend.list", { context: {}, input: {} });
      await assertBrowserWorkspaceSnapshot(snapshot);
      return toDesktopWorkspaceAgentBackendList(response.result);
    },
    getWorkspaceSurfaceContract: (source) => {
      const query = source ? `?source=${encodeURIComponent(source)}` : "";
      return workspaceRequest<SurfaceContractPayload>("GET", `/surface/contract${query}`);
    },
    listWorkspaceChatSessions: () => workspaceRequest<SessionRecord[]>("GET", "/chat/sessions"),
    createWorkspaceChatSession: async (input) => {
      const connection = await requireBrowserWorkspaceConnection();
      const response = await browserDomainApiClient.executeOperation<SessionRecord>(connection.workspaceId, "session.create", {
        context: { room_id: input.roomId },
        input: {
          ...(input.title ? { title: input.title } : {}),
          ...(input.uiLocale ? { ui_locale: input.uiLocale } : {}),
          ...(input.outputLocale ? { output_locale: input.outputLocale } : {})
        }
      }, { operationId: input.operationId, idempotencyKey: input.operationId });
      return response.result;
    },
    getWorkspaceChatSession: (input) => workspaceRequest<SessionDetail>("GET", `/chat/sessions/${encodeURIComponent(input.sessionId)}`),
    sendWorkspaceChatMessage: async (input) => {
      const connection = await requireBrowserWorkspaceConnection();
      const response = await browserDomainApiClient.executeOperation<ChatTurnResult>(connection.workspaceId, "chat.turn.run", {
        context: { session_id: input.sessionId },
        input: {
          content: input.content,
          ...(input.inputLocale ? { input_locale: input.inputLocale } : {}),
          ...(input.outputLocale ? { output_locale: input.outputLocale } : {}),
          ...(input.backendId ? { backend_id: input.backendId } : {}),
          ...(input.metadata ? { metadata: input.metadata } : {}),
          ...(input.attachments?.length ? { attachments: input.attachments } : {})
        }
      }, { operationId: input.idempotencyKey, idempotencyKey: input.idempotencyKey });
      return response.result;
    },
    writeWorkspaceAttachment: async (input) => {
      const connection = await requireBrowserWorkspaceConnection();
      if (input.target && (input.target.connectionId !== connection.id || input.target.workspaceId !== connection.workspaceId)) {
        throw new Error("workspace_navigation_changed");
      }
      const result = await browserWorkspaceRequest<unknown>({
        method: "PUT",
        connectionId: connection.id,
        path: `/api/workspaces/${encodeURIComponent(connection.workspaceId)}/files/${workspaceAttachmentPath(input.path)}`,
        workspaceScoped: true,
        operationId: input.operationId,
        body: {
          room_id: input.roomId,
          content_base64: input.contentBase64,
          expected_version: input.expectedVersion
        }
      });
      await assertBrowserWorkspaceSnapshot(connection);
      return sanitizeWorkspaceAttachmentUploadResult(result);
    },
    searchWorkspace: (input) => workspaceRequest<SearchResult[]>("GET", `/chat/search?room_id=${encodeURIComponent(input.roomId)}&q=${encodeURIComponent(input.query)}`),
    listWorkspaceBackendRuns: (input) => workspaceRequest<BackendRunRecord[]>("GET", `/chat/runs${input.sessionId ? `?session_id=${encodeURIComponent(input.sessionId)}` : ""}`),
    getWorkspaceBackendRun: (input) => workspaceRequest<BackendRunRecord>("GET", `/chat/runs/${encodeURIComponent(input.runId)}`),
    listWorkspaceBackendEvents: (input) => workspaceRequest<BackendEventRecord[]>("GET", `/chat/runs/${encodeURIComponent(input.runId)}/events`),
    cancelWorkspaceBackendRun: (input) => workspaceRequest<BackendRunRecord>("POST", `/chat/runs/${encodeURIComponent(input.runId)}/cancel`, {}, input.operationId),
    retryWorkspaceBackendRun: (input) => workspaceRequest<ChatSurfaceOperationResult>("POST", `/chat/runs/${encodeURIComponent(input.runId)}/retry`, {}, input.operationId),
    listWorkspaceChanges: (input) => workspaceRequest("GET", `/chat/changes${input.sessionId ? `?session_id=${encodeURIComponent(input.sessionId)}` : ""}`),
    listWorkspaceActivity: (input) => workspaceRequest<ActivityInboxItem[]>("GET", `/chat/activity?room_id=${encodeURIComponent(input.roomId)}`),
    getWorkspaceAudit: async () => {
      const body = await workspaceRequest<{ entries?: AuditPayload["workspaceEntries"] }>("GET", "/audit");
      if (!Array.isArray(body.entries)) throw new Error("workspace_audit_response_invalid");
      return { auditRecords: [], operations: [], policyDecisions: [], approvalRequests: [], rollbackPoints: [], workspaceEntries: body.entries } satisfies AuditPayload;
    },
    listWorkspaceCompletionResources: (input) => {
      const query = new URLSearchParams();
      if (input.scopeKind === "room") query.set("room_id", input.roomId ?? "");
      if (input.kind) query.set("kind", input.kind);
      if (input.includeArchived) query.set("include_archived", "true");
      return workspaceRequest<{ resources: WorkspaceCompletionResourceView[]; next_cursor?: string }>("GET", `/completion/resources?${query.toString()}`);
    },
    getWorkspaceCompletionResource: (input) => workspaceRequest<WorkspaceCompletionResourceDetail>("GET", `/completion/resources/${encodeURIComponent(input.resourceId)}`),
    getWorkspaceCompletionResourceBody: (input) => workspaceRequest<WorkspaceCompletionResourceBody>("GET", `/completion/resources/${encodeURIComponent(input.resourceId)}/body`),
    createWorkspaceCompletionResource: (input) => workspaceRequest("POST", "/completion/resources", {
      scope_kind: input.scopeKind,
      ...(input.roomId ? { room_id: input.roomId } : {}),
      kind: input.kind,
      ...(input.knowledgeKind ? { knowledge_kind: input.knowledgeKind } : {}),
      title: input.title,
      content: input.content,
      ...(input.metadata ? { metadata: input.metadata } : {}),
      reason: input.reason
    }, input.operationId),
    updateWorkspaceCompletionResource: (input) => workspaceRequest("PUT", `/completion/resources/${encodeURIComponent(input.resourceId)}`, {
      scope_kind: input.scopeKind,
      ...(input.roomId ? { room_id: input.roomId } : {}),
      kind: input.kind,
      ...(input.knowledgeKind ? { knowledge_kind: input.knowledgeKind } : {}),
      title: input.title,
      content: input.content,
      ...(input.metadata ? { metadata: input.metadata } : {}),
      expected_version: input.expectedVersion,
      reason: input.reason
    }, input.operationId),
    setWorkspaceCompletionResourceFixed: (input) => workspaceRequest("POST", `/completion/resources/${encodeURIComponent(input.resourceId)}/fixed`, { fixed: input.fixed, expected_version: input.expectedVersion, reason: input.reason }, input.operationId),
    archiveWorkspaceCompletionResource: (input) => workspaceRequest("POST", `/completion/resources/${encodeURIComponent(input.resourceId)}/archive`, { archived: input.archived, expected_version: input.expectedVersion, reason: input.reason }, input.operationId),
    searchWorkspaceCompletionKnowledge: (input) => workspaceRequest("GET", `/completion/knowledge/search?room_id=${encodeURIComponent(input.roomId)}&q=${encodeURIComponent(input.query)}${input.limit === undefined ? "" : `&limit=${input.limit}`}`),
    listWorkspaceCompletionSkills: (input) => workspaceRequest("GET", `/completion/skills?room_id=${encodeURIComponent(input.roomId)}`),
    getWorkspaceCompletionSkill: (input) => workspaceRequest("GET", `/completion/skills/${encodeURIComponent(input.resourceId)}`),
    listWorkspaceSkillOptimizations: (input) => {
      const query = new URLSearchParams();
      if (input.skillId) query.set("skill_id", input.skillId);
      if (input.roomId) query.set("room_id", input.roomId);
      if (input.limit !== undefined) query.set("limit", String(input.limit));
      return workspaceRequest<SkillOptimizationDetail["run"][]>("GET", `/skill-optimizations${query.size ? `?${query.toString()}` : ""}`);
    },
    getWorkspaceSkillOptimization: (input) => workspaceRequest<SkillOptimizationDetail>("GET", `/skill-optimizations/${encodeURIComponent(input.runId)}`),
    startWorkspaceSkillOptimization: (input) => workspaceRequest("POST", `/skills/${encodeURIComponent(input.skillId)}/optimizations`, {
      ...(input.roomId ? { room_id: input.roomId } : {}),
      ...(input.objective ? { objective: input.objective } : {}),
      ...(input.goldenExamples ? { golden_examples: input.goldenExamples } : {}),
      ...(input.syntheticExamples ? { synthetic_examples: input.syntheticExamples } : {})
    }, input.operationId),
    runWorkspaceSkillOptimizationAction: (input) => workspaceRequest<Record<string, unknown>>(
      "POST",
      `/skill-optimizations/${encodeURIComponent(input.runId)}/${input.action}`,
      {
        ...(input.candidateId ? { candidate_id: input.candidateId } : {}),
        ...(input.promotionId ? { promotion_id: input.promotionId } : {}),
        ...(input.snapshotId ? { snapshot_id: input.snapshotId } : {})
      },
      input.operationId
    ),
    listWorkspaceKnowledgeWiki: (input) => workspaceRequest("GET", `/knowledge-wiki?room_id=${encodeURIComponent(input.roomId)}${input.includeArchived ? "&include_archived=true" : ""}`),
    getWorkspaceKnowledgeWiki: (input) => workspaceRequest<WorkspaceKnowledgeWikiPage>("GET", `/knowledge-wiki/${encodeURIComponent(input.wikiId)}`),
    createWorkspaceKnowledgeWiki: (input) => workspaceRequest("POST", "/knowledge-wiki/proposals", {
      room_id: input.roomId,
      title: input.title,
      content: input.content,
      ...(input.slug ? { slug: input.slug } : {}),
      ...(input.tags ? { tags: input.tags } : {}),
      ...(input.contentLocale ? { content_locale: input.contentLocale } : {}),
      ...(input.knowledgeKind ? { knowledge_kind: input.knowledgeKind } : {}),
      reason: input.reason
    }, input.operationId),
    updateWorkspaceKnowledgeWiki: (input) => workspaceRequest("PATCH", `/knowledge-wiki/${encodeURIComponent(input.wikiId)}`, {
      ...(input.title ? { title: input.title } : {}),
      ...(input.content !== undefined ? { content: input.content } : {}),
      ...(input.tags ? { tags: input.tags } : {}),
      ...(input.contentLocale ? { content_locale: input.contentLocale } : {}),
      reason: input.reason
    }, input.operationId),
    setWorkspaceKnowledgeWikiState: (input) => workspaceRequest("POST", `/knowledge-wiki/${encodeURIComponent(input.wikiId)}/${input.state === "accept" ? "accept" : input.state === "reject" ? "reject" : "archive"}`, { reason: input.reason }, input.operationId),
    reindexWorkspaceKnowledgeWiki: (input) => workspaceRequest("POST", "/knowledge-wiki/reindex", { room_id: input.roomId }),
    getWorkspaceKnowledgeWikiGraph: (input) => workspaceRequest("GET", `/knowledge-wiki/graph?room_id=${encodeURIComponent(input.roomId)}${input.query ? `&query=${encodeURIComponent(input.query)}` : ""}`),
    getWorkspaceKnowledgeWikiLint: (input) => workspaceRequest("GET", `/knowledge-wiki/lint?room_id=${encodeURIComponent(input.roomId)}`),
    getWorkspaceKnowledgeWikiBacklinks: (input) => workspaceRequest("GET", `/knowledge-wiki/${encodeURIComponent(input.wikiId)}/backlinks?room_id=${encodeURIComponent(input.roomId)}`),
    listWorkspaceKnowledgeMemory: (input) => workspaceRequest<{ memories: WorkspaceKnowledgeMemoryPage[] }>("GET", `/knowledge-memory?room_id=${encodeURIComponent(input.roomId)}${input.includeArchived ? "&include_archived=true" : ""}`),
    getWorkspaceKnowledgeMemory: (input) => workspaceRequest<WorkspaceKnowledgeMemoryPage>("GET", `/knowledge-memory/${encodeURIComponent(input.memoryId)}`),
    searchWorkspaceKnowledgeMemory: (input) => workspaceRequest("GET", `/knowledge-memory/search?room_id=${encodeURIComponent(input.roomId)}&q=${encodeURIComponent(input.query)}${input.limit === undefined ? "" : `&limit=${input.limit}`}`),
    archiveWorkspaceKnowledgeMemory: (input) => workspaceRequest("POST", `/knowledge-memory/${encodeURIComponent(input.memoryId)}/archive`, { reason: input.reason }, input.operationId),
    listWorkspaceCollectionSchemas: (input) => workspaceRequest("GET", `/collections/schemas?room_id=${encodeURIComponent(input.roomId)}`),
    getWorkspaceCollectionSchema: (input) => workspaceRequest("GET", `/collections/${encodeURIComponent(input.collectionId)}/schema?room_id=${encodeURIComponent(input.roomId)}`),
    saveWorkspaceCollectionSchema: (input) => workspaceRequest("POST", "/collections/schemas", { room_id: input.roomId, schema: input.schema, ...(input.expectedVersion === undefined ? {} : { expected_version: input.expectedVersion }) }, input.operationId),
    listWorkspaceCollectionRecords: (input) => workspaceRequest("GET", `/collections/${encodeURIComponent(input.collectionId)}/records?room_id=${encodeURIComponent(input.roomId)}`),
    createWorkspaceCollectionRecord: (input) => workspaceRequest("POST", `/collections/${encodeURIComponent(input.collectionId)}/records`, { room_id: input.roomId, record_id: input.recordId, data: input.data }, input.operationId),
    patchWorkspaceCollectionRecord: (input) => workspaceRequest("POST", `/collections/${encodeURIComponent(input.collectionId)}/records/${encodeURIComponent(input.recordId)}/patches`, { room_id: input.roomId, ...(input.patchId ? { patch_id: input.patchId } : {}), changes: input.changes, ...(input.expectedVersion === undefined ? {} : { expected_version: input.expectedVersion }) }, input.operationId),
    deleteWorkspaceCollectionRecord: (input) => workspaceRequest("DELETE", `/collections/${encodeURIComponent(input.collectionId)}/records/${encodeURIComponent(input.recordId)}`, { room_id: input.roomId, expected_version: input.expectedVersion }, input.operationId),
    listWorkspaceCollectionNotes: (input) => workspaceRequest("GET", `/collections/${encodeURIComponent(input.collectionId)}/notes?room_id=${encodeURIComponent(input.roomId)}`),
    reindexWorkspaceCollections: (input) => workspaceRequest("POST", "/collections/reindex", { room_id: input.roomId }),
    runWorkspaceCollectionSurfaceOperation: (input) => workspaceSurfaceRequest("/collections/surface/operations", input.roomId, input.operation),
    listWorkspaceArtifacts: async (input) => {
      const connection = await requireBrowserWorkspaceConnection();
      const response = await browserDomainApiClient.executeQuery<ArtifactRecord[]>(connection.workspaceId, "artifact.list", { context: { room_id: input.roomId }, input: {} });
      return { artifacts: response.result };
    },
    getWorkspaceArtifact: async (input) => {
      const connection = await requireBrowserWorkspaceConnection();
      const response = await browserDomainApiClient.executeQuery<{ artifact: ArtifactRecord; content: string }>(connection.workspaceId, "artifact.view", { context: { room_id: input.roomId }, input: { id: input.artifactId } });
      return { ...response.result, auditRecords: [] };
    },
    createWorkspaceArtifact: async (input) => {
      const connection = await requireBrowserWorkspaceConnection();
      if (typeof input.content !== "string") {
        // The legacy Handler still supports structured artifact content. Keep
        // that compatibility input until the public artifact.create schema is
        // intentionally expanded in a later phase.
        return workspaceRequest("POST", "/artifacts", {
          room_id: input.roomId,
          title: input.title,
          content: input.content,
          ...(input.kind ? { kind: input.kind } : {}),
          ...(input.locale ? { locale: input.locale } : {}),
          ...(input.sourceLocales?.length ? { source_locales: input.sourceLocales } : {}),
          ...(input.metadata ? { metadata: input.metadata } : {})
        }, input.operationId, input.operationId);
      }
      const response = await browserDomainApiClient.executeOperation<{ artifact: ArtifactRecord; content: string; replayed: boolean }>(connection.workspaceId, "artifact.create", {
        context: { room_id: input.roomId },
        input: {
          title: input.title,
          content: input.content,
          ...(input.kind ? { kind: input.kind } : {}),
          ...(input.locale ? { output_locale: input.locale } : {}),
          ...(input.sourceLocales?.[0] ? { input_locale: input.sourceLocales[0] } : {}),
          ...(input.metadata ? { metadata: input.metadata } : {})
        }
      }, { operationId: input.operationId, idempotencyKey: input.operationId });
      return response.result;
    },
    runWorkspaceArtifactSurfaceOperation: (input) => workspaceSurfaceRequest("/artifacts/surface/operations", input.roomId, input.operation),
    getWorkspaceGeneratedSurface: (input) => workspaceRequest<GeneratedSurfaceDetail>("GET", `/generated-surfaces/${encodeURIComponent(input.surfaceId)}?room_id=${encodeURIComponent(input.roomId)}`),
    getWorkspaceGeneratedSurfaceBundle: (input) => workspaceRequest<GeneratedSurfaceBundleDetail>("GET", `/generated-surfaces/${encodeURIComponent(input.surfaceId)}/revisions/${encodeURIComponent(input.revisionId)}/bundle?room_id=${encodeURIComponent(input.roomId)}`),
    runWorkspaceGeneratedSurfaceAction: (input) => workspaceRequest<Record<string, unknown>>("POST", `/generated-surfaces/${encodeURIComponent(input.surfaceId)}/actions/${encodeURIComponent(input.actionId)}/run`, {
      room_id: input.roomId,
      ...(input.revisionId ? { revision_id: input.revisionId } : {}),
      ...(input.interactionId ? { interaction_id: input.interactionId } : {}),
      ...(input.messageId ? { message_id: input.messageId } : {}),
      ...(input.confirmed === true ? { confirmed: true } : {}),
      ...(input.actionPayload ? { action_payload: input.actionPayload } : {})
    }, input.operationId),
    runWorkspaceGeneratedSurfaceState: (input) => workspaceRequest("POST", `/generated-surfaces/${encodeURIComponent(input.surfaceId)}/state`, {
      room_id: input.roomId,
      action: input.action,
      ...(input.interactionId ? { interaction_id: input.interactionId } : {}),
      ...(input.messageId ? { message_id: input.messageId } : {})
    }, input.operationId),
    exportWorkspaceGeneratedSurface: (input) => workspaceRequest<GeneratedSurfaceExportPayload>("GET", `/generated-surfaces/${encodeURIComponent(input.surfaceId)}/export?room_id=${encodeURIComponent(input.roomId)}${input.revisionId ? `&revision_id=${encodeURIComponent(input.revisionId)}` : ""}&format=${input.format}`),
    listWorkspaceAutomationJobs: (input) => workspaceRequest("GET", `/automation/jobs${input.roomId ? `?room_id=${encodeURIComponent(input.roomId)}` : ""}`),
    createWorkspaceAutomationJob: (input) => workspaceRequest("POST", "/automation/jobs", {
      room_id: input.roomId,
      title: input.title,
      kind: input.kind,
      schedule: input.schedule,
      target_instruction: input.targetInstruction,
      ...(input.deliveryTarget ? { delivery_target: input.deliveryTarget } : {}),
      ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
      ...(input.nextRunAt ? { next_run_at: input.nextRunAt } : {}),
      ...(input.maxAttempts === undefined ? {} : { max_attempts: input.maxAttempts }),
      ...(input.connectionId ? { connection_id: input.connectionId } : {}),
      ...(input.sessionRef ? { session_ref: input.sessionRef } : {})
    }, input.operationId),
    listWorkspaceAutomationRuns: (input) => workspaceRequest("GET", `/automation/runs${input.roomId ? `?room_id=${encodeURIComponent(input.roomId)}` : ""}`),
    listWorkspaceAutomationJobRuns: (input) => workspaceRequest("GET", `/automation/jobs/${encodeURIComponent(input.jobId)}/runs`),
    setWorkspaceAutomationManagement: (input) => workspaceRequest("POST", `/automation/jobs/${encodeURIComponent(input.jobId)}/management`, { state: input.state }, input.operationId),
    runWorkspaceAutomationNow: (input) => workspaceRequest("POST", "/automation/run-now", { room_id: input.roomId, ...(input.kind ? { kind: input.kind } : {}) }, input.operationId),
    listWorkspaceRoomMembers: (roomId) => workspaceRequest<{ members: DesktopWorkspaceRoomMembership[] }>("GET", `/rooms/${encodeURIComponent(roomId)}/members`),
    createWorkspaceRoom: async (input) => {
      const roomInput = input as unknown as NativeRoomCreateInput;
      const connection = await requireBrowserWorkspaceConnection();
      if (roomInput.target && (roomInput.target.connectionId !== connection.id || roomInput.target.workspaceId !== connection.workspaceId)) {
        throw new Error("workspace_navigation_changed");
      }
      if (roomInput.newAgent?.enabled === false) throw new Error("room_default_agent_enabled_required");
      const snapshot = { id: connection.id, workspaceId: connection.workspaceId };
      const snapshotClient = new DomainApiClient(async <T>(request: DomainApiTransportRequest): Promise<T> => {
        await assertBrowserWorkspaceSnapshot(snapshot);
        return browserWorkspaceRequest<T>({
          method: request.method,
          path: request.path,
          connectionId: snapshot.id,
          workspaceScoped: true,
          ...(request.operationId ? { operationId: request.operationId } : {}),
          ...(request.idempotencyKey ? { idempotencyKey: request.idempotencyKey } : {}),
          ...(request.body === undefined ? {} : { body: request.body })
        });
      });
      const response = await snapshotClient.createRoom<PublicRoomRecord>(connection.workspaceId, {
        name: roomInput.name,
        ...(roomInput.parentRoomId ? { parent_room_id: roomInput.parentRoomId } : {}),
        ...(roomInput.defaultAgentId ? { default_agent_id: roomInput.defaultAgentId } : {}),
        ...(roomInput.defaultAgentVersion === undefined ? {} : { default_agent_version: roomInput.defaultAgentVersion }),
        ...(roomInput.newAgent ? {
          new_agent: {
            name: roomInput.newAgent.name,
            role: roomInput.newAgent.role,
            instructions: roomInput.newAgent.instructions,
            backend_id: roomInput.newAgent.backendId,
            enabled: roomInput.newAgent.enabled,
            ...(roomInput.newAgent.permission ? {
              permission: {
                can_view: roomInput.newAgent.permission.canView,
                can_edit: roomInput.newAgent.permission.canEdit,
                can_execute: roomInput.newAgent.permission.canExecute
              }
            } : {})
          }
        } : {}),
        ...(roomInput.agentPermission ? {
          agent_permission: {
            can_view: roomInput.agentPermission.canView,
            can_edit: roomInput.agentPermission.canEdit,
            can_execute: roomInput.agentPermission.canExecute
          }
        } : {})
      }, { operationId: roomInput.operationId, idempotencyKey: roomInput.operationId });
      await assertBrowserWorkspaceSnapshot(connection);
      if (response.result.workspace_id !== connection.workspaceId) throw new Error("workspace_room_response_scope_invalid");
      return {
        room: toDesktopWorkspaceRoom(response.result),
        target: { connectionId: connection.id, workspaceId: connection.workspaceId },
        replayed: response.replayed
      };
    },
    previewWorkspaceRoomMove: (input) => workspaceRequest<{ preview: DesktopRoomMovePreview }>("POST", `/rooms/${encodeURIComponent(input.roomId)}/parent/preview`, { parent_room_id: input.parentRoomId }),
    moveWorkspaceRoom: (input) => workspaceRequest("PUT", `/rooms/${encodeURIComponent(input.roomId)}/parent`, { parent_room_id: input.parentRoomId, expected_room_version: input.expectedRoomVersion, expected_workspace_version: input.expectedWorkspaceVersion }, input.operationId),
    previewWorkspaceRoomMember: (input) => workspaceRequest<{ preview: DesktopRoomMemberPreview }>("POST", `/rooms/${encodeURIComponent(input.roomId)}/members/${encodeURIComponent(input.accountId)}/preview`, { role: input.role, state: input.state }),
    setWorkspaceRoomMember: (input) => workspaceRequest("PUT", `/rooms/${encodeURIComponent(input.roomId)}/members/${encodeURIComponent(input.accountId)}`, { role: input.role, state: input.state, expected_version: input.expectedVersion }, input.operationId),
    getWorkspaceLearningSettings: (roomId) => workspaceRequest<{ settings: DesktopWorkspaceLearningSettings; workspace_settings?: DesktopWorkspaceLearningSettings; room_settings?: DesktopWorkspaceLearningSettings }>("GET", `/learning/settings?room_id=${encodeURIComponent(roomId)}`),
    updateWorkspaceLearningSettings: (input) => workspaceRequest("PUT", "/learning/settings", {
      scope_kind: input.scopeKind,
      ...(input.roomId ? { room_id: input.roomId } : {}),
      ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
      ...(input.engineId ? { engine_id: input.engineId } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.secretRef ? { secret_ref: input.secretRef } : {}),
      ...(input.currencyLimit === undefined ? {} : { currency_limit: input.currencyLimit }),
      ...(input.tokenLimit === undefined ? {} : { token_limit: input.tokenLimit }),
      ...(input.clearEngineId === undefined ? {} : { clear_engine_id: input.clearEngineId }),
      ...(input.clearModel === undefined ? {} : { clear_model: input.clearModel }),
      ...(input.clearSecretRef === undefined ? {} : { clear_secret_ref: input.clearSecretRef }),
      ...(input.clearCurrencyLimit === undefined ? {} : { clear_currency_limit: input.clearCurrencyLimit }),
      ...(input.clearTokenLimit === undefined ? {} : { clear_token_limit: input.clearTokenLimit }),
      ...(input.removeOverride === undefined ? {} : { remove_override: input.removeOverride }),
      ...(input.expectedVersion === undefined ? {} : { expected_version: input.expectedVersion })
    }, input.operationId),
    onWorkspaceServerEvent: (listener) => subscribeBrowserWorkspaceRealtime(listener)
  };
  return bridge;
}

async function reassignBrowserRoomWork(input: RoomWorkReassignInput): Promise<DesktopWorkspaceRoomWorkAssignee & { replayed: boolean }> {
  const roomId = requirePublicId(input.roomId, "roomId");
  const workId = requirePublicId(input.workId, "workId");
  const assigneeId = requirePublicId(input.assigneeId, "assigneeId");
  const agentId = requirePublicId(input.agentId, "agentId");
  const connection = await requireBrowserWorkspaceConnection();
  const response = await browserDomainApiClient.executeOperation<unknown>(connection.workspaceId, "room.work.assignee.reassign", {
    context: { room_id: roomId },
    input: {
      work_id: workId,
      assignee_id: assigneeId,
      agent_id: agentId,
      ...(input.expectedVersion === undefined ? {} : { expected_version: input.expectedVersion }),
      ...(input.expectedGeneration === undefined ? {} : { expected_generation: input.expectedGeneration })
    }
  }, { operationId: input.operationId, idempotencyKey: input.operationId });
  await assertBrowserWorkspaceSnapshot(connection);
  const assignee = toDesktopRoomWorkAssignee(response.result);
  assertRoomWorkScope(assignee, roomId, workId);
  if (assignee.id !== assigneeId || assignee.agentId !== agentId) throw new Error("room_work_assignee_scope_invalid");
  return withReplayed(assignee, response.replayed);
}

async function delegateBrowserRoomWork(input: RoomWorkDelegateInput): Promise<DesktopWorkspaceRoomWorkAssignee & { replayed: boolean }> {
  const roomId = requirePublicId(input.roomId, "roomId");
  const workId = requirePublicId(input.workId, "workId");
  const assigneeId = requirePublicId(input.assigneeId, "assigneeId");
  const agentId = requirePublicId(input.agentId, "agentId");
  const instruction = input.instruction.trim();
  if (!instruction) throw new Error("room_work_instruction_required");
  const attachments = strictRoomWorkAttachments(input.attachments);
  const connection = await requireBrowserWorkspaceConnection();
  const snapshot = { id: connection.id, workspaceId: connection.workspaceId };
  const response = await browserSnapshotDomainApiClient(snapshot).executeOperation<unknown>(snapshot.workspaceId, "room.work.assignee.delegate", {
    context: { room_id: roomId },
    input: {
      work_id: workId,
      assignee_id: assigneeId,
      agent_id: agentId,
      instruction,
      ...(input.dependencyAssigneeIds?.length ? { dependency_assignee_ids: input.dependencyAssigneeIds } : {}),
      ...(attachments.length ? { attachments } : {}),
      ...(input.expectedVersion === undefined ? {} : { expected_version: input.expectedVersion }),
      ...(input.expectedGeneration === undefined ? {} : { expected_generation: input.expectedGeneration })
    }
  }, { operationId: input.operationId, idempotencyKey: input.operationId });
  await assertBrowserWorkspaceSnapshot(snapshot);
  const assignee = toDesktopRoomWorkAssignee(response.result);
  assertRoomWorkScope(assignee, roomId, workId);
  if (assignee.id === assigneeId
    || assignee.workId !== workId
    || assignee.agentId !== agentId
    || (assignee.parentAssigneeId !== undefined && assignee.parentAssigneeId !== assigneeId)) {
    throw new Error("room_work_delegate_response_scope_invalid");
  }
  return withReplayed(assignee, response.replayed);
}

/** Uploads still use the dedicated attachment namespace; refs may point to any
 * server-issued safe relative Workspace file path. */
const workspaceAttachmentWritePathPattern = /^attachments\/[A-Za-z0-9._-]{1,220}$/;

function safeWorkspaceFilePath(value: unknown): string | undefined {
  const parsed = WorkspaceFileResourceRefSchema.shape.uri.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function strictRoomWorkAttachment(value: unknown, errorCode = "room_work_attachment_invalid"): ResourceRef {
  const parsed = WorkspaceFileResourceRefSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(errorCode);
  }
  return { ...parsed.data, label: parsed.data.label ?? parsed.data.uri };
}

function strictRoomWorkAttachments(value: unknown, errorCode = "room_work_attachment_invalid"): ResourceRef[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(errorCode);
  if (value.length > 100) throw new Error("room_work_attachment_count_invalid");
  return value.map((item) => strictRoomWorkAttachment(item, errorCode));
}

function workspaceAttachmentPath(value: string): string {
  if (!workspaceAttachmentWritePathPattern.test(value)) throw new Error("workspace_attachment_path_invalid");
  return value.split("/").map((part) => encodeURIComponent(part)).join("/");
}

function sanitizeWorkspaceAttachmentUploadResult(value: unknown): WorkspaceAttachmentUploadResult {
  const body = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const file = body.file && typeof body.file === "object" && !Array.isArray(body.file) ? body.file as Record<string, unknown> : {};
  const resource = body.resource_ref && typeof body.resource_ref === "object" && !Array.isArray(body.resource_ref) ? body.resource_ref as Record<string, unknown> : {};
  const filePath = safeWorkspaceFilePath(file.path);
  const sha256 = typeof file.sha256 === "string" && /^[a-f0-9]{64}$/.test(file.sha256) ? file.sha256 : undefined;
  const version = typeof file.version === "number" && Number.isSafeInteger(file.version) && file.version > 0 ? file.version : undefined;
  const size = typeof file.size === "number" && Number.isSafeInteger(file.size) && file.size >= 0 && file.size <= 8 * 1024 * 1024 ? file.size : undefined;
  const parsedResource = WorkspaceFileResourceRefSchema.safeParse(resource);
  if (!filePath || !sha256 || version === undefined || size === undefined || !parsedResource.success
    || parsedResource.data.id !== sha256 || parsedResource.data.uri !== filePath || parsedResource.data.version !== String(version)) {
    throw new Error("workspace_attachment_response_invalid");
  }
  const resourceRef = { ...parsedResource.data, label: parsedResource.data.label ?? parsedResource.data.uri };
  return {
    file: { path: filePath, version, sha256, size },
    resource_ref: resourceRef,
    ...(body.replayed === true ? { replayed: true } : {})
  };
}

let cachedBrowserBridge: DesktopBridge | undefined;

export function browserWorkspaceBridge(): DesktopBridge {
  return cachedBrowserBridge ??= createBrowserWorkspaceBridge();
}

async function browserConnectionState(): Promise<DesktopWorkspaceConnectionState> {
  const state = await createBrowserWorkspaceConnectionState();
  const active = state.connections.find((connection) => connection.id === state.activeConnectionId);
  return {
    ...(state.activeConnectionId ? { activeConnectionId: state.activeConnectionId } : {}),
    ...(active?.workspaceId ? { activeTarget: { connectionId: active.id, workspaceId: active.workspaceId } } : {}),
    connections: state.connections.map(toDesktopConnection)
  };
}

async function listBrowserWorkspaceDirectory(connectionId?: string): Promise<DesktopWorkspaceDirectoryResult> {
  const connections = await loadBrowserWorkspaceConnections();
  const selectedConnections = connectionId ? connections.filter((connection) => connection.id === connectionId) : connections;
  if (connectionId && !selectedConnections.length) throw new Error("workspace_connection_not_found");
  const workspaces: DesktopWorkspaceDirectoryEntry[] = [];
  const errors: DesktopWorkspaceDirectoryResult["errors"] = [];
  await Promise.all(selectedConnections.map(async (connection) => {
    try {
      const payload = await browserWorkspaceRequest<unknown>({
        method: "GET",
        path: "/api/account/workspaces",
        connectionId: connection.id
      });
      for (const workspace of normalizeBrowserDirectoryRows(payload)) {
        workspaces.push({
          ...workspace,
          connectionId: connection.id,
          accountId: connection.accountId,
          serverUrl: connection.serverUrl,
          serverLabel: connection.label,
          availability: "connected"
        });
      }
    } catch (error) {
      errors.push({
        connectionId: connection.id,
        serverUrl: connection.serverUrl,
        serverLabel: connection.label,
        code: browserErrorCode(error),
        message: browserErrorMessage(error)
      });
    }
  }));
  return { workspaces: workspaces.sort((left, right) => left.name.localeCompare(right.name, "ja") || left.connectionId.localeCompare(right.connectionId)), ...(errors.length ? { errors } : {}) };
}

async function browserWorkspaceServerStatus(target?: { connectionId?: string; workspaceId?: string }): Promise<DesktopWorkspaceServerStatus> {
  const connection = target?.connectionId
    ? (await loadBrowserWorkspaceConnections()).find((item) => item.id === target.connectionId)
    : await loadBrowserWorkspaceConnection();
  if (!connection) return { identityAvailable: false };
  const desktopConnection = toDesktopConnection(connection);
  const workspaceId = target?.workspaceId ?? connection.workspaceId;
  if (!workspaceId) return { connection: desktopConnection, identityAvailable: true };
  let health: { status: number; body: unknown };
  try {
    health = { status: 200, body: await browserWorkspaceHealth(connection.id) };
  } catch (error) {
    health = { status: 0, body: { error: browserErrorMessage(error) } };
  }
  try {
    const workspace = await browserWorkspaceRequest({ method: "GET", path: `/api/workspaces/${encodeURIComponent(workspaceId)}`, connectionId: connection.id, workspaceScoped: true });
    const rooms = await browserWorkspaceRequest({ method: "GET", path: `/api/workspaces/${encodeURIComponent(workspaceId)}/rooms`, connectionId: connection.id, workspaceScoped: true });
    return { connection: desktopConnection, identityAvailable: true, health, workspace: { status: 200, body: workspace }, rooms: { status: 200, body: rooms } };
  } catch (error) {
    return { connection: desktopConnection, identityAvailable: true, health, workspace: { status: 0, body: { error: browserErrorMessage(error) } } };
  }
}

function toDesktopConnection(connection: Awaited<ReturnType<typeof loadBrowserWorkspaceConnections>>[number]): DesktopWorkspaceConnection {
  return {
    id: connection.id,
    label: connection.label,
    serverUrl: connection.serverUrl,
    workspaceId: connection.workspaceId,
    accountId: connection.accountId,
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt
  };
}

function normalizeBrowserDirectoryRows(value: unknown): DesktopWorkspaceDirectoryEntry[] {
  const body = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const rows = Array.isArray(value) ? value : Array.isArray(body.workspaces) ? body.workspaces : [];
  return rows.map((entry) => {
    const item = entry && typeof entry === "object" && !Array.isArray(entry) ? entry as Record<string, unknown> : {};
    const workspaceId = stringValue(item.id ?? item.workspace_id);
    return {
      connectionId: "",
      workspaceId,
      organizationId: optionalString(item.organization_id ?? item.organizationId),
      name: stringValue(item.name, "名称未設定のWorkspace"),
      state: item.state === "archived" || item.state === "read_only" ? item.state : "active",
      ...(item.role === "owner" || item.role === "admin" || item.role === "member" || item.role === "guest" ? { role: item.role } : {}),
      access: item.access === "none" || item.can_access === false || item.has_access === false ? "none" : "granted",
      ...(typeof item.version === "number" ? { version: item.version } : {}),
      ...(optionalString(item.created_at ?? item.createdAt) ? { createdAt: optionalString(item.created_at ?? item.createdAt) } : {}),
      ...(optionalString(item.updated_at ?? item.updatedAt) ? { updatedAt: optionalString(item.updated_at ?? item.updatedAt) } : {})
    } satisfies DesktopWorkspaceDirectoryEntry;
  }).filter((entry) => entry.workspaceId.length > 0);
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function browserErrorCode(error: unknown): string {
  return error instanceof Error ? error.message.split(":", 1)[0] || "workspace_server_request_failed" : "workspace_server_request_failed";
}

function browserErrorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "Workspace Serverに接続できません。";
}

async function workspaceRequest<T>(
  method: string,
  suffix: string,
  body?: unknown,
  operationId?: string,
  idempotencyKey?: string
): Promise<T> {
  const connection = await loadBrowserWorkspaceConnection();
  if (!connection) throw new Error("workspace_connection_required");
  return browserWorkspaceRequest<T>({
    method,
    path: `/api/workspaces/${encodeURIComponent(connection.workspaceId)}${suffix}`,
    workspaceScoped: true,
    ...(operationId ? { operationId } : {}),
    ...(idempotencyKey ? { idempotencyKey } : {}),
    ...(body === undefined ? {} : { body })
  });
}

const browserDomainApiClient = new DomainApiClient(async <T>(request: DomainApiTransportRequest): Promise<T> => {
  return browserWorkspaceRequest<T>({
    method: request.method,
    path: request.path,
    workspaceScoped: true,
    ...(request.operationId ? { operationId: request.operationId } : {}),
    ...(request.idempotencyKey ? { idempotencyKey: request.idempotencyKey } : {}),
    ...(request.body === undefined ? {} : { body: request.body })
  });
});

function browserSnapshotDomainApiClient(snapshot: { id: string; workspaceId: string }): DomainApiClient {
  return new DomainApiClient(async <T>(request: DomainApiTransportRequest): Promise<T> => {
    await assertBrowserWorkspaceSnapshot(snapshot);
    const result = await browserWorkspaceRequest<T>({
      method: request.method,
      path: request.path,
      connectionId: snapshot.id,
      workspaceScoped: true,
      ...(request.operationId ? { operationId: request.operationId } : {}),
      ...(request.idempotencyKey ? { idempotencyKey: request.idempotencyKey } : {}),
      ...(request.body === undefined ? {} : { body: request.body })
    });
    await assertBrowserWorkspaceSnapshot(snapshot);
    return result;
  });
}

async function requireBrowserWorkspaceConnection(): Promise<NonNullable<Awaited<ReturnType<typeof loadBrowserWorkspaceConnection>>>> {
  const connection = await loadBrowserWorkspaceConnection();
  if (!connection) throw new Error("workspace_connection_required");
  return connection;
}

/** Discard a response that completed after the active Workspace changed. */
async function assertBrowserWorkspaceSnapshot(connection: { id: string; workspaceId: string }): Promise<void> {
  const current = await loadBrowserWorkspaceConnection();
  if (!current || current.id !== connection.id || current.workspaceId !== connection.workspaceId) {
    throw new Error("workspace_navigation_changed");
  }
}

function assertBrowserAgentTarget(connection: { id: string; workspaceId: string }, target?: { connectionId: string; workspaceId: string }): void {
  if (!target) return;
  if (target.connectionId !== connection.id || target.workspaceId !== connection.workspaceId) throw new Error("workspace_navigation_changed");
}

function toDesktopWorkspaceRoom(room: PublicRoomRecord): DesktopWorkspaceRoom {
  const extendedRoom = room as PublicRoomRecord & {
    default_agent_enabled?: unknown;
    default_agent_can_execute?: unknown;
    default_agent?: unknown;
  };
  const defaultAgent = extendedRoom.default_agent && typeof extendedRoom.default_agent === "object" && !Array.isArray(extendedRoom.default_agent)
    ? extendedRoom.default_agent as Record<string, unknown>
    : {};
  const defaultAgentEnabled = typeof extendedRoom.default_agent_enabled === "boolean"
    ? extendedRoom.default_agent_enabled
    : typeof defaultAgent.enabled === "boolean" ? defaultAgent.enabled : undefined;
  const defaultAgentCanExecute = typeof extendedRoom.default_agent_can_execute === "boolean"
    ? extendedRoom.default_agent_can_execute
    : typeof defaultAgent.can_execute === "boolean" ? defaultAgent.can_execute : undefined;
  return {
    id: room.id,
    workspaceId: room.workspace_id,
    ...(room.parent_room_id ? { parentRoomId: room.parent_room_id } : {}),
    name: room.name,
    version: room.version,
    kind: room.kind ?? "normal",
    ...(room.default_agent_id ? { defaultAgentId: room.default_agent_id } : {}),
    ...(room.default_agent_version === undefined ? {} : { defaultAgentVersion: room.default_agent_version }),
    ...(defaultAgentEnabled === undefined ? {} : { defaultAgentEnabled }),
    ...(defaultAgentCanExecute === undefined ? {} : { defaultAgentCanExecute }),
    ...(room.can_manage === undefined ? {} : { canManage: room.can_manage }),
    ...(room.can_execute === undefined ? {} : { canExecute: room.can_execute }),
    createdAt: room.created_at,
    updatedAt: room.updated_at
  };
}

function toDesktopWorkspaceAgentList(value: unknown, workspaceId: string): DesktopWorkspaceAgent[] {
  const rows = Array.isArray(value)
    ? value
    : Array.isArray(publicRecord(value, "workspace_agent_list").agents)
      ? publicRecord(value, "workspace_agent_list").agents as unknown[]
      : [];
  return rows.map((entry) => toDesktopWorkspaceAgent(entry, workspaceId));
}

function toDesktopWorkspaceAgent(value: unknown, workspaceId: string): DesktopWorkspaceAgent {
  const record = publicRecord(value, "workspace_agent");
  const agentWorkspaceId = publicString(record, "workspace_id", "workspace_agent");
  if (agentWorkspaceId !== workspaceId) throw new Error("workspace_agent_workspace_scope_invalid");
  const id = publicString(record, "id", "workspace_agent");
  const displayName = typeof record.name === "string"
    ? record.name
    : typeof record.display_name === "string" ? record.display_name : undefined;
  if (!displayName?.trim()) throw new Error("workspace_agent_response_invalid");
  return {
    id,
    workspaceId,
    displayName: displayName.trim().slice(0, 200),
    ...(typeof record.role === "string" ? { role: record.role.slice(0, 500) } : {}),
    ...(typeof record.backend_id === "string" ? { backendId: record.backend_id.slice(0, 512) } : {}),
    enabled: publicBoolean(record, "enabled", "workspace_agent"),
    ...(typeof record.status === "string" ? { status: record.status.slice(0, 128) } : {}),
    ...(typeof record.can_execute === "boolean" ? { canExecute: record.can_execute } : {}),
    ...(typeof record.version === "number" ? { version: publicNumber(record, "version", "workspace_agent") } : {})
  };
}

function toDesktopWorkspaceAgentBackendList(value: unknown): AgentBackendAvailability[] {
  const parsed = PublicAgentBackendRecordSchema.array().max(100).safeParse(value);
  if (!parsed.success) throw new Error("workspace_agent_backend_response_invalid");
  return parsed.data;
}

function toDesktopWorkspaceAgentDetail(value: unknown, workspaceId: string): DesktopWorkspaceAgent {
  const record = publicRecord(value, "workspace_agent");
  const agentWorkspaceId = publicString(record, "workspace_id", "workspace_agent");
  if (agentWorkspaceId !== workspaceId) throw new Error("workspace_agent_workspace_scope_invalid");
  if (typeof record.instructions !== "string" || !record.instructions.trim()) throw new Error("workspace_agent_detail_missing");
  return {
    ...toDesktopWorkspaceAgent(record, workspaceId),
    instructions: record.instructions.slice(0, 20_000),
    ...(typeof record.description === "string" ? { description: record.description.slice(0, 2_000) } : {}),
    ...(typeof record.created_by === "string" ? { createdBy: record.created_by.slice(0, 512) } : {}),
    ...(typeof record.created_at === "string" ? { createdAt: record.created_at.slice(0, 64) } : {}),
    ...(typeof record.updated_at === "string" ? { updatedAt: record.updated_at.slice(0, 64) } : {})
  };
}

function toDesktopWorkspaceRoomAgentMember(value: unknown, roomId: string): DesktopWorkspaceRoomAgentMember {
  const record = publicRecord(value, "room_agent_permission");
  const nested = record.permission && typeof record.permission === "object" && !Array.isArray(record.permission)
    ? record.permission as Record<string, unknown>
    : record;
  const actualRoomId = publicString(nested, "room_id", "room_agent_permission");
  if (actualRoomId !== roomId) throw new Error("workspace_room_agent_room_scope_invalid");
  const canView = publicBoolean(nested, "can_view", "room_agent_permission");
  const canEdit = publicBoolean(nested, "can_edit", "room_agent_permission");
  const canExecute = publicBoolean(nested, "can_execute", "room_agent_permission");
  return {
    id: optionalPublicString(nested, "id") ?? `room_agent:${roomId}:${publicString(nested, "agent_id", "room_agent_permission")}`,
    roomId,
    agentId: publicString(nested, "agent_id", "room_agent_permission"),
    canView,
    canEdit,
    canExecute,
    version: publicNumber(nested, "version", "room_agent_permission"),
    ...(optionalPublicString(nested, "created_by") ? { createdBy: nested.created_by as string } : {}),
    ...(optionalPublicString(nested, "created_at") ? { createdAt: nested.created_at as string } : {}),
    ...(optionalPublicString(nested, "updated_at") ? { updatedAt: nested.updated_at as string } : {}),
    removed: nested.removed === true || (!canView && !canEdit && !canExecute)
  };
}

function toDesktopWorkspaceRoomAgentMemberList(value: unknown, roomId: string): DesktopWorkspaceRoomAgentMemberList {
  const record = publicRecord(value, "room_member_list");
  const rows = publicArray(record, "agents", "room_member_list");
  return { roomId, agents: rows.map((entry) => toDesktopWorkspaceRoomAgentMember(entry, roomId)) };
}

function requirePublicId(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`${field}_invalid`);
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/.test(normalized)) throw new Error(`${field}_invalid`);
  return normalized;
}

function publicRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field}_response_invalid`);
  return value as Record<string, unknown>;
}

function publicString(record: Record<string, unknown>, key: string, field = key): string {
  if (typeof record[key] !== "string") throw new Error(`${field}_response_invalid`);
  return record[key] as string;
}

function publicNumber(record: Record<string, unknown>, key: string, field = key): number {
  if (typeof record[key] !== "number" || !Number.isSafeInteger(record[key])) throw new Error(`${field}_response_invalid`);
  return record[key] as number;
}

function publicBoolean(record: Record<string, unknown>, key: string, field = key): boolean {
  if (typeof record[key] !== "boolean") throw new Error(`${field}_response_invalid`);
  return record[key] as boolean;
}

function optionalPublicString(record: Record<string, unknown>, key: string): string | undefined {
  return typeof record[key] === "string" ? record[key] as string : undefined;
}

function publicArray(record: Record<string, unknown>, key: string, field = key): unknown[] {
  if (!Array.isArray(record[key])) throw new Error(`${field}_response_invalid`);
  return record[key] as unknown[];
}

function publicAttachments(record: Record<string, unknown>, key = "attachments"): ResourceRef[] {
  const values = publicArray(record, key, "room_work_attachments");
  return values.map((item, index) => strictRoomWorkAttachment(item, `room_work_attachments_${index}`));
}

function publicResources(record: Record<string, unknown>, key: string, field = key): ResourceRef[] {
  return publicArray(record, key, field).map((item, index) => {
    const resource = publicRecord(item, `${field}_${index}`);
    return {
      kind: publicString(resource, "kind", `${field}_${index}`),
      id: publicString(resource, "id", `${field}_${index}`),
      uri: publicString(resource, "uri", `${field}_${index}`),
      ...(optionalPublicString(resource, "version") ? { version: resource.version as string } : {}),
      ...(optionalPublicString(resource, "label") ? { label: resource.label as string } : {})
    };
  });
}

function withReplayed<T extends object>(value: T, replayed: boolean): T & { replayed: boolean } {
  return { ...value, replayed };
}

function publicEnum<T extends string>(record: Record<string, unknown>, key: string, allowed: readonly T[], field: string): T {
  const value = publicString(record, key, field);
  if (!allowed.includes(value as T)) throw new Error(field + "_response_invalid");
  return value as T;
}

function optionalPublicEnum<T extends string>(record: Record<string, unknown>, key: string, allowed: readonly T[], field: string): T | undefined {
  if (record[key] === undefined || record[key] === null) return undefined;
  return publicEnum(record, key, allowed, field);
}

const desktopRoomWorkStatuses = ["queued", "running", "waiting", "blocked", "completed", "failed", "stopping", "cancelled", "outcome_unknown"] as const;
const desktopRoomWorkAssigneeStatuses = ["queued", "ready", "running", "waiting", "blocked", "completed", "failed", "stopping", "cancelled", "outcome_unknown"] as const;
const desktopRoomWorkInstructionStatuses = ["pending", "accepted", "queued", "delivered", "applied", "failed", "rejected"] as const;
const desktopRoomWorkControlActions = ["stop", "assignee.stop", "assignee.reassign"] as const;
const desktopRoomWorkControlStatuses = ["accepted", "pending", "requested", "running", "completed", "confirmed", "failed", "unconfirmed", "rejected"] as const;
const desktopRoomWorkStopRequestStatuses = ["requested", "accepted", "rejected"] as const;
const desktopRoomWorkTerminalStatuses = ["pending", "confirmed", "unconfirmed"] as const;

function toDesktopRoomWorkAssignee(value: unknown): DesktopWorkspaceRoomWorkAssignee {
  const record = publicRecord(value, "room_work_assignee");
  return {
    id: publicString(record, "id", "room_work_assignee"),
    workId: publicString(record, "work_id", "room_work_assignee"),
    agentId: publicString(record, "agent_id", "room_work_assignee"),
    ...(optionalPublicString(record, "parent_assignee_id") ? { parentAssigneeId: record.parent_assignee_id as string } : {}),
    status: publicEnum(record, "status", desktopRoomWorkAssigneeStatuses, "room_work_assignee"),
    instructionVersion: publicNumber(record, "instruction_version", "room_work_assignee"),
    generation: publicNumber(record, "generation", "room_work_assignee"),
    ...(typeof record.agent_configuration_version === "number" ? { agentConfigurationVersion: publicNumber(record, "agent_configuration_version", "room_work_assignee") } : {}),
    ...(typeof record.attempt === "number" ? { attempt: publicNumber(record, "attempt", "room_work_assignee") } : {}),
    version: publicNumber(record, "version", "room_work_assignee"),
    createdAt: publicString(record, "created_at", "room_work_assignee"),
    updatedAt: publicString(record, "updated_at", "room_work_assignee")
  };
}

function toDesktopRoomWorkInstruction(value: unknown): DesktopWorkspaceRoomWorkInstruction {
  const record = publicRecord(value, "room_work_instruction");
  return {
    id: publicString(record, "id", "room_work_instruction"),
    workId: publicString(record, "work_id", "room_work_instruction"),
    ...(optionalPublicString(record, "assignee_id") ? { assigneeId: record.assignee_id as string } : {}),
    kind: publicString(record, "kind", "room_work_instruction") as DesktopWorkspaceRoomWorkInstruction["kind"],
    instruction: publicString(record, "instruction", "room_work_instruction"),
    attachments: publicAttachments(record),
    version: publicNumber(record, "version", "room_work_instruction"),
    generation: publicNumber(record, "generation", "room_work_instruction"),
    status: publicEnum(record, "status", desktopRoomWorkInstructionStatuses, "room_work_instruction"),
    ...(optionalPublicString(record, "accepted_at") ? { acceptedAt: record.accepted_at as string } : {}),
    ...(optionalPublicString(record, "delivered_at") ? { deliveredAt: record.delivered_at as string } : {}),
    ...(optionalPublicString(record, "applied_at") ? { appliedAt: record.applied_at as string } : {}),
    createdBy: publicString(record, "created_by", "room_work_instruction"),
    ...(optionalPublicString(record, "source_comment_id") ? { sourceCommentId: record.source_comment_id as string } : {}),
    createdAt: publicString(record, "created_at", "room_work_instruction"),
    updatedAt: publicString(record, "updated_at", "room_work_instruction")
  };
}

function toDesktopRoomWorkComment(value: unknown): DesktopWorkspaceRoomWorkComment {
  const record = publicRecord(value, "room_work_comment");
  const applied = publicArray(record, "applied_instruction_ids", "room_work_comment");
  return {
    id: publicString(record, "id", "room_work_comment"),
    workId: publicString(record, "work_id", "room_work_comment"),
    authorId: publicString(record, "author_id", "room_work_comment"),
    body: publicString(record, "body", "room_work_comment"),
    attachments: publicAttachments(record),
    version: publicNumber(record, "version", "room_work_comment"),
    ...(typeof record.reaction_count === "number" ? { reactionCount: record.reaction_count } : {}),
    appliedInstructionIds: applied.filter((item): item is string => typeof item === "string"),
    createdAt: publicString(record, "created_at", "room_work_comment"),
    updatedAt: publicString(record, "updated_at", "room_work_comment")
  };
}

function toDesktopRoomWorkControl(value: unknown): DesktopWorkspaceRoomWorkControl {
  const record = publicRecord(value, "room_work_control");
  const unconfirmed = publicArray(record, "unconfirmed_assignee_ids", "room_work_control");
  return {
    id: publicString(record, "id", "room_work_control"),
    ...(optionalPublicString(record, "operation_id") ? { operationId: record.operation_id as string } : {}),
    workId: publicString(record, "work_id", "room_work_control"),
    ...(optionalPublicString(record, "assignee_id") ? { assigneeId: record.assignee_id as string } : {}),
    ...(optionalPublicString(record, "target_agent_id") ? { targetAgentId: record.target_agent_id as string } : {}),
    action: publicEnum(record, "action", desktopRoomWorkControlActions, "room_work_control"),
    status: publicEnum(record, "status", desktopRoomWorkControlStatuses, "room_work_control"),
    generation: publicNumber(record, "generation", "room_work_control"),
    version: publicNumber(record, "version", "room_work_control"),
    ...(optionalPublicEnum(record, "stop_request_status", desktopRoomWorkStopRequestStatuses, "room_work_control") ? { stopRequestStatus: optionalPublicEnum(record, "stop_request_status", desktopRoomWorkStopRequestStatuses, "room_work_control") } : {}),
    ...(optionalPublicEnum(record, "terminal_status", desktopRoomWorkTerminalStatuses, "room_work_control") ? { terminalStatus: optionalPublicEnum(record, "terminal_status", desktopRoomWorkTerminalStatuses, "room_work_control") } : {}),
    unconfirmedAssigneeIds: unconfirmed.filter((item): item is string => typeof item === "string"),
    createdAt: publicString(record, "created_at", "room_work_control"),
    updatedAt: publicString(record, "updated_at", "room_work_control"),
    ...(optionalPublicString(record, "completed_at") ? { completedAt: record.completed_at as string } : {})
  };
}

function toDesktopRoomWork(value: unknown): DesktopWorkspaceRoomWork {
  const record = publicRecord(value, "room_work");
  return {
    id: publicString(record, "id", "room_work"),
    roomId: publicString(record, "room_id", "room_work"),
    ...(optionalPublicString(record, "objective_id") ? { objectiveId: record.objective_id as string } : {}),
    requesterId: publicString(record, "requester_id", "room_work"),
    ...(optionalPublicString(record, "front_agent_id") ? { frontAgentId: record.front_agent_id as string } : {}),
    defaultAgentId: publicString(record, "default_agent_id", "room_work"),
    ...(typeof record.default_agent_version === "number" ? { defaultAgentVersion: publicNumber(record, "default_agent_version", "room_work") } : {}),
    title: publicString(record, "title", "room_work"),
    objective: publicString(record, "objective", "room_work"),
    ...(Array.isArray(record.completion_criteria) ? { completionCriteria: record.completion_criteria.filter((item): item is string => typeof item === "string") } : {}),
    ...(record.kind === "human" ? { kind: "human" as const } : {}),
    status: publicEnum(record, "status", desktopRoomWorkStatuses, "room_work"),
    ...(record.stop_state === "none" || record.stop_state === "requested" || record.stop_state === "confirmed" || record.stop_state === "unconfirmed"
      ? { stopState: record.stop_state }
      : {}),
    instructionVersion: publicNumber(record, "instruction_version", "room_work"),
    generation: publicNumber(record, "generation", "room_work"),
    version: publicNumber(record, "version", "room_work"),
    assignees: publicArray(record, "assignees", "room_work").map(toDesktopRoomWorkAssignee),
    ...(Array.isArray(record.execution_reservations) ? { executionReservations: record.execution_reservations.map(toDesktopRoomWorkExecutionReservation) } : {}),
    createdAt: publicString(record, "created_at", "room_work"),
    updatedAt: publicString(record, "updated_at", "room_work")
  };
}

function toDesktopRoomWorkView(value: unknown): DesktopWorkspaceRoomWorkView {
  const record = publicRecord(value, "room_work_view");
  return {
    ...toDesktopRoomWork(record),
    instructions: publicArray(record, "instructions", "room_work_view").map(toDesktopRoomWorkInstruction),
    comments: publicArray(record, "comments", "room_work_view").map(toDesktopRoomWorkComment),
    reactions: publicArray(record, "reactions", "room_work_view").map(toDesktopRoomWorkReaction),
    controls: publicArray(record, "controls", "room_work_view").map(toDesktopRoomWorkControl)
  };
}

function toDesktopRoomWorkExecutionReservation(value: unknown): DesktopWorkspaceRoomWorkExecutionReservation {
  const record = publicRecord(value, "room_work_execution_reservation");
  const status = publicString(record, "status", "room_work_execution_reservation");
  if (status !== "reserved" && status !== "claimed" && status !== "released" && status !== "cancelled") {
    throw new Error("room_work_execution_reservation_response_invalid");
  }
  return {
    id: publicString(record, "id", "room_work_execution_reservation"),
    workId: publicString(record, "work_id", "room_work_execution_reservation"),
    assignmentId: publicString(record, "assignment_id", "room_work_execution_reservation"),
    roomId: publicString(record, "room_id", "room_work_execution_reservation"),
    generation: publicNumber(record, "generation", "room_work_execution_reservation"),
    status,
    scheduledAt: publicString(record, "scheduled_at", "room_work_execution_reservation"),
    ...(optionalPublicString(record, "claimed_at") ? { claimedAt: record.claimed_at as string } : {}),
    ...(optionalPublicString(record, "released_at") ? { releasedAt: record.released_at as string } : {}),
    createdAt: publicString(record, "created_at", "room_work_execution_reservation"),
    updatedAt: publicString(record, "updated_at", "room_work_execution_reservation")
  };
}

function toDesktopRoomWorkReaction(value: unknown): DesktopWorkspaceRoomWorkReaction {
  const record = publicRecord(value, "room_work_reaction");
  if (record.reaction !== "like") throw new Error("room_work_reaction_response_invalid");
  return {
    id: publicString(record, "id", "room_work_reaction"),
    workId: publicString(record, "work_id", "room_work_reaction"),
    commentId: publicString(record, "comment_id", "room_work_reaction"),
    reaction: "like",
    enabled: publicBoolean(record, "enabled", "room_work_reaction"),
    version: publicNumber(record, "version", "room_work_reaction"),
    createdAt: publicString(record, "created_at", "room_work_reaction"),
    updatedAt: publicString(record, "updated_at", "room_work_reaction")
  };
}

const publicEventSensitiveKey = /(?:private|secret|credential|password|token|authorization|api[_-]?key|session)/i;
const publicEventBodyKey = /^(?:content|body|prompt|message|text)$/i;

function publicEventPayload(value: unknown): Record<string, JsonValue> {
  return publicEventValue(publicRecord(value, "workspace_event_payload"), 0) as Record<string, JsonValue>;
}

function publicEventValue(value: unknown, depth: number): JsonValue | undefined {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") return value.slice(0, 4_096);
  if (depth > 6) return undefined;
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => publicEventValue(item, depth + 1)).filter((item): item is JsonValue => item !== undefined);
  }
  if (!value || typeof value !== "object") return undefined;
  const output: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (publicEventSensitiveKey.test(key) || publicEventBodyKey.test(key)) continue;
    const sanitized = publicEventValue(item, depth + 1);
    if (sanitized !== undefined) output[key.slice(0, 128)] = sanitized;
  }
  return output;
}

function toDesktopRoomWorkDefaultAgent(value: unknown): DesktopWorkspaceRoomDefaultAgent {
  const record = publicRecord(value, "room_default_agent");
  return {
    roomId: publicString(record, "room_id", "room_default_agent"),
    agentId: publicString(record, "agent_id", "room_default_agent"),
    agentVersion: publicNumber(record, "agent_version", "room_default_agent"),
    enabled: publicBoolean(record, "enabled", "room_default_agent"),
    canExecute: publicBoolean(record, "can_execute", "room_default_agent"),
    version: publicNumber(record, "version", "room_default_agent"),
    updatedAt: publicString(record, "updated_at", "room_default_agent")
  };
}

function toDesktopAgentDm(value: unknown): DesktopWorkspaceAgentDm {
  const record = publicRecord(value, "agent_dm");
  if (record.kind !== "agent_dm") throw new Error("agent_dm_kind_scope_invalid");
  return {
    id: publicString(record, "id", "agent_dm"),
    roomId: publicString(record, "room_id", "agent_dm"),
    workspaceId: publicString(record, "workspace_id", "agent_dm"),
    kind: "agent_dm",
    agentId: publicString(record, "agent_id", "agent_dm"),
    agentVersion: publicNumber(record, "agent_version", "agent_dm"),
    version: publicNumber(record, "version", "agent_dm"),
    ...(record.visibility === "private" ? { visibility: "private" as const } : {}),
    ...(record.membership_mode === "explicit_participants" ? { membershipMode: "explicit_participants" as const } : {}),
    createdAt: publicString(record, "created_at", "agent_dm"),
    updatedAt: publicString(record, "updated_at", "agent_dm")
  };
}

function toDesktopRoomWorkList(value: unknown, roomId?: string): DesktopWorkspaceRoomWorkListResult {
  if (Array.isArray(value)) {
    const works = value.map(toDesktopRoomWork);
    if (roomId) works.forEach((work) => assertRoomWorkScope(work, roomId));
    return { works, ...(roomId ? { roomId } : {}) };
  }
  const record = publicRecord(value, "room_work_list");
  const works = Array.isArray(record.works) ? record.works : Array.isArray(record.room_works) ? record.room_works : [];
  const parsedWorks = works.map(toDesktopRoomWork);
  if (roomId) parsedWorks.forEach((work) => assertRoomWorkScope(work, roomId));
  return {
    works: parsedWorks,
    ...(roomId ? { roomId } : {}),
    ...(typeof record.next_cursor === "string" ? { nextCursor: record.next_cursor } : {})
  };
}

function assertRoomWorkScope(value: { roomId?: string; workId?: string; id?: string }, roomId: string, workId?: string): void {
  if (value.roomId !== undefined && value.roomId !== roomId) throw new Error("room_work_room_scope_invalid");
  const actualWorkId = value.workId ?? value.id;
  if (workId !== undefined && actualWorkId !== workId) throw new Error("room_work_scope_invalid");
}

function toDesktopPublicEvent(value: unknown): DesktopWorkspacePublicEvent {
  const record = publicRecord(value, "workspace_event");
  const actor = publicRecord(record.actor, "workspace_event_actor");
  const scope = publicRecord(record.scope, "workspace_event_scope");
  const kind = publicString(actor, "kind", "workspace_event_actor");
  if (kind !== "human" && kind !== "agent" && kind !== "system") throw new Error("workspace_event_response_invalid");
  const resources = publicResources(record, "resources", "workspace_event");
  const payload = publicEventPayload(record.payload);
  return {
    eventId: publicString(record, "event_id", "workspace_event"),
    eventType: publicString(record, "event_type", "workspace_event"),
    eventVersion: publicString(record, "event_version", "workspace_event"),
    cursor: publicString(record, "cursor", "workspace_event"),
    occurredAt: publicString(record, "occurred_at", "workspace_event"),
    actor: { kind, ...(optionalPublicString(actor, "id") ? { id: actor.id as string } : {}) },
    scope: {
      ...(optionalPublicString(scope, "workspace_id") ? { workspaceId: scope.workspace_id as string } : {}),
      ...(optionalPublicString(scope, "room_id") ? { roomId: scope.room_id as string } : {})
    },
    resources,
    ...(optionalPublicString(record, "operation_id") ? { operationId: record.operation_id as string } : {}),
    ...(optionalPublicString(record, "correlation_id") ? { correlationId: record.correlation_id as string } : {}),
    payload
  };
}

function toDesktopPublicEventPage(value: unknown, roomId?: string): DesktopWorkspacePublicEventPage {
  const record = publicRecord(value, "workspace_event_page");
  const events = publicArray(record, "events", "workspace_event_page")
    .map(toDesktopPublicEvent)
    .filter((event) => !roomId || event.scope.roomId === roomId);
  return {
    events,
    ...(typeof record.next_cursor === "string" ? { nextCursor: record.next_cursor } : {}),
    hasMore: publicBoolean(record, "has_more", "workspace_event_page")
  };
}

async function workspaceSurfaceRequest<T = unknown>(suffix: string, roomId: string, operation: SurfaceOperation): Promise<SurfaceOperationResultEnvelope<T>> {
  return workspaceRequest<SurfaceOperationResultEnvelope<T>>("POST", suffix, { room_id: roomId, operation }, operation.id);
}
