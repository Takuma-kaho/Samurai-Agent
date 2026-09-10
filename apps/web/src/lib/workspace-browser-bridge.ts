import {
  browserWorkspaceHealth,
  browserWorkspaceBinaryRequest,
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
import { beginActiveWorkspaceRoomSelection, currentActiveWorkspaceRoomId, isCurrentActiveWorkspaceRoomSelection } from "./workspace-navigation-state";
import type {
  AgentBackendAvailability,
  ArtifactDetail,
  ArtifactMutationResult,
  ArtifactRevisionDetail,
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
  DesktopWorkspaceRoomWorkResourceRefInput,
  DesktopWorkspaceRoomWorkReaction,
  DesktopWorkspaceRoomWorkView,
  DesktopWorkspacePublicEvent,
  DesktopWorkspacePublicEventPage,
  DesktopWorkspaceInteractionMutationResult,
  DesktopWorkspaceInteractionResult,
  DesktopWorkspaceInteractionRequest,
  DesktopWorkspaceServerStatus,
  DomainCommandInputSource,
  GeneratedSurfaceBundleDetail,
  GeneratedSurfaceDetail,
  GeneratedSurfaceExportPayload,
  GeneratedSurfaceMutationResult,
  GeneratedSurfaceWriteBundle,
  GeneratedSurfaceWriteRequest,
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
  ResourceRefSchema,
  WorkspaceFileResourceRefSchema,
  type ActivityInboxItem,
  type AutomationJobRecord,
  type BackendEventRecord,
  type BackendRunRecord,
  type CollectionRecord,
  type CollectionSchema,
  type ArtifactRecord,
  type ArtifactRevisionRecord,
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
import type { NativeRoomCreateInput, NativeWorkspaceTarget } from "../native-app/types";

type DesktopBridge = NonNullable<Window["samuraiDesktop"]>;
type BrowserWorkspaceTargetRef = NativeWorkspaceTarget;
type BrowserWorkspaceSnapshot = {
  id: string;
  workspaceId: string;
  roomId?: string;
  selectionGeneration?: number;
};
const browserWorkspaceOpaqueIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
type RoomWorkReassignInput = {
  roomId: string;
  workId: string;
  assigneeId: string;
  agentId: string;
  expectedVersion?: number;
  expectedGeneration?: number;
  operationId: string;
  target?: BrowserWorkspaceTargetRef;
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
  target?: BrowserWorkspaceTargetRef;
};

type RoomWorkDelegateBridge = {
  delegateWorkspaceRoomWorkAssignee: (input: RoomWorkDelegateInput) => Promise<DesktopWorkspaceRoomWorkAssignee & { replayed: boolean }>;
};

/** Durable operation evidence used to recover a logical UI retry after restart. */
export const workspaceOperationHistoryRecordTypes = [
  "interaction_request",
  "domain_operation",
  "generated_surface_action_result",
  "generated_surface_operation_result",
  "surface_interaction",
  "collection_record",
  "collection_patch"
] as const;

export type WorkspaceOperationHistoryRecordType = (typeof workspaceOperationHistoryRecordTypes)[number];

export interface WorkspaceOperationHistoryRecord {
  workspaceId: string;
  roomId: string;
  recordType: WorkspaceOperationHistoryRecordType;
  id: string;
  version: number;
  payload: Record<string, JsonValue>;
  contentHash?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface WorkspaceOperationHistoryBridge {
  listWorkspaceOperationHistory?: (input: {
    roomId: string;
    recordType: WorkspaceOperationHistoryRecordType;
    target?: NativeWorkspaceTarget;
  }) => Promise<{ records: WorkspaceOperationHistoryRecord[] }>;
}

/**
 * Browser counterpart of the Desktop Workspace bridge.
 *
 * Each method is a fixed Domain Operation or Query. The browser never gets a
 * generic signed-request function from this module; the private Ed25519 key
 * remains a CryptoKey in IndexedDB and the server still performs all Room/RLS
 * checks.
 */
export function createBrowserWorkspaceBridge(): DesktopBridge & RoomWorkDelegateBridge & WorkspaceOperationHistoryBridge {
  const bridge: DesktopBridge & RoomWorkDelegateBridge & WorkspaceOperationHistoryBridge = {
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
    exportWorkspaceBundle: (input) => workspaceInputRequest(
      input,
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
    selectRoomCandidate: async (input) => {
      const roomId = requirePublicId(input.roomId, "roomId");
      const selectionGeneration = beginActiveWorkspaceRoomSelection(roomId);
      const target = input.target;
      const workspaceTarget = target
        ? {
          connectionId: target.connectionId,
          workspaceId: target.workspaceId,
          ...(target.roomId === undefined ? {} : { roomId: target.roomId }),
          ...(target.selectionGeneration === undefined ? {} : { selectionGeneration: target.selectionGeneration })
        }
        : undefined;
      await captureBrowserWorkspaceSnapshot(workspaceTarget);
      if (!isCurrentActiveWorkspaceRoomSelection(selectionGeneration)) throw new Error("room_navigation_changed");
      return browserConnectionState();
    },
    registerWorkspaceServerAccount: (displayName) => registerBrowserWorkspaceAccount(displayName),
    getWorkspaceServerStatus: browserWorkspaceServerStatus,
    getWorkspaceSettings: (input?: unknown) => workspaceV1InputRequest<SettingsRecord>(input, "GET", "/settings"),
    patchWorkspaceSettings: (input) => workspaceV1InputRequest(input, "PATCH", "/settings", input.patch, input.operationId),
    listWorkspaceAgents: async (input) => {
      const snapshot = await captureBrowserWorkspaceSnapshot(browserTargetFromInput(input));
      const response = await browserSnapshotDomainApiClient(snapshot).executeQuery<unknown>(snapshot.workspaceId, "agent.list", { context: {}, input: {} });
      await assertBrowserWorkspaceSnapshot(snapshot);
      return { agents: toDesktopWorkspaceAgentList(response.result, snapshot.workspaceId) };
    },
    viewWorkspaceAgent: async (input) => {
      const agentId = requirePublicId(input.agentId, "agentId");
      const snapshot = await captureBrowserWorkspaceSnapshot(browserTargetFromInput(input));
      const response = await browserSnapshotDomainApiClient(snapshot).executeQuery<unknown>(snapshot.workspaceId, "agent.view", { context: {}, input: { id: agentId } });
      await assertBrowserWorkspaceSnapshot(snapshot);
      const agent = toDesktopWorkspaceAgentDetail(response.result, snapshot.workspaceId);
      if (agent.id !== agentId) throw new Error("workspace_agent_response_scope_invalid");
      return agent;
    },
    createWorkspaceAgent: async (input) => {
      const snapshot = await captureBrowserWorkspaceSnapshot(browserTargetFromInput(input));
      const response = await browserSnapshotDomainApiClient(snapshot).executeOperation<unknown>(snapshot.workspaceId, "agent.create", {
        context: {},
        input: { name: input.name, role: input.role, instructions: input.instructions, backend_id: input.backendId, enabled: input.enabled }
      }, { operationId: input.operationId, idempotencyKey: input.operationId });
      await assertBrowserWorkspaceSnapshot(snapshot);
      return { ...toDesktopWorkspaceAgentDetail(response.result, snapshot.workspaceId), replayed: response.replayed };
    },
    patchWorkspaceAgent: async (input) => {
      const agentId = requirePublicId(input.agentId, "agentId");
      const snapshot = await captureBrowserWorkspaceSnapshot(browserTargetFromInput(input));
      const response = await browserSnapshotDomainApiClient(snapshot).executeOperation<unknown>(snapshot.workspaceId, "agent.patch", {
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
      const agent = toDesktopWorkspaceAgentDetail(response.result, snapshot.workspaceId);
      if (agent.id !== agentId) throw new Error("workspace_agent_response_scope_invalid");
      return { ...agent, replayed: response.replayed };
    },
    bindWorkspaceAgentBackend: async (input) => {
      const agentId = requirePublicId(input.agentId, "agentId");
      const backendId = requirePublicId(input.backendId, "backendId");
      const snapshot = await captureBrowserWorkspaceSnapshot(browserTargetFromInput(input));
      const response = await browserSnapshotDomainApiClient(snapshot).executeOperation<unknown>(snapshot.workspaceId, "agent.backend.bind", {
        context: {},
        input: { id: agentId, backend_id: backendId, ...(input.expectedVersion === undefined ? {} : { expected_version: input.expectedVersion }) }
      }, { operationId: input.operationId, idempotencyKey: input.operationId });
      await assertBrowserWorkspaceSnapshot(snapshot);
      const agent = toDesktopWorkspaceAgentDetail(response.result, snapshot.workspaceId);
      if (agent.id !== agentId) throw new Error("workspace_agent_response_scope_invalid");
      return { ...agent, replayed: response.replayed };
    },
    listWorkspaceRoomAgentMembers: async (input) => {
      const roomId = requirePublicId(input.roomId, "roomId");
      const snapshot = await captureBrowserWorkspaceSnapshot(browserTargetFromInput(input));
      const response = await browserSnapshotDomainApiClient(snapshot).executeQuery<unknown>(snapshot.workspaceId, "room.member.list", { context: { room_id: roomId }, input: {} });
      await assertBrowserWorkspaceSnapshot(snapshot);
      return toDesktopWorkspaceRoomAgentMemberList(response.result, roomId);
    },
    setWorkspaceRoomAgentPermission: async (input) => {
      const roomId = requirePublicId(input.roomId, "roomId");
      const agentId = requirePublicId(input.agentId, "agentId");
      const snapshot = await captureBrowserWorkspaceSnapshot(browserTargetFromInput(input));
      const response = await browserSnapshotDomainApiClient(snapshot).executeOperation<unknown>(snapshot.workspaceId, "room.agent.permission.set", {
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
      const snapshot = await captureBrowserWorkspaceSnapshot(browserTargetFromInput(input));
      const response = await browserSnapshotDomainApiClient(snapshot).executeOperation<unknown>(snapshot.workspaceId, "room.agent.remove", {
        context: { room_id: roomId },
        input: { agent_id: agentId }
      }, { operationId: input.operationId, idempotencyKey: input.operationId });
      await assertBrowserWorkspaceSnapshot(snapshot);
      const permission = toDesktopWorkspaceRoomAgentMember(response.result, roomId);
      if (permission.agentId !== agentId) throw new Error("workspace_room_agent_response_scope_invalid");
      return { ...permission, replayed: response.replayed };
    },
    listWorkspaceRooms: async (input?: unknown) => {
      const snapshot = await captureBrowserWorkspaceSnapshot(browserTargetFromInput(input));
      const response = await browserSnapshotDomainApiClient(snapshot).executeQuery<PublicRoomRecord[]>(snapshot.workspaceId, "room.list", { context: {}, input: {} });
      await assertBrowserWorkspaceSnapshot(snapshot);
      return { rooms: response.result.map(toDesktopWorkspaceRoom) };
    },
    listWorkspaceRoomWorks: async (input) => {
      const roomId = requirePublicId(input.roomId, "roomId");
      const snapshot = await captureBrowserWorkspaceSnapshot(browserTargetFromInput(input));
      const response = await browserSnapshotDomainApiClient(snapshot).executeQuery<unknown>(snapshot.workspaceId, "room.work.list", {
        context: { room_id: roomId },
        input: {
          ...(input.status ? { status: input.status } : {}),
          ...(input.cursor ? { cursor: input.cursor } : {}),
          ...(input.limit === undefined ? {} : { limit: input.limit })
        }
      });
      await assertBrowserWorkspaceSnapshot(snapshot);
      return toDesktopRoomWorkList(response.result, roomId);
    },
    getWorkspaceRoomWork: async (input) => {
      const roomId = requirePublicId(input.roomId, "roomId");
      const workId = requirePublicId(input.workId, "workId");
      const snapshot = await captureBrowserWorkspaceSnapshot(browserTargetFromInput(input));
      const response = await browserSnapshotDomainApiClient(snapshot).executeQuery<unknown>(snapshot.workspaceId, "room.work.view", {
        context: { room_id: roomId },
        input: { work_id: workId }
      });
      await assertBrowserWorkspaceSnapshot(snapshot);
      const work = toDesktopRoomWorkView(response.result);
      assertRoomWorkScope(work, roomId, workId);
      return work;
    },
    createWorkspaceRoomWork: async (input) => {
      const roomId = requirePublicId(input.roomId, "roomId");
      const attachments = strictRoomWorkAttachments(input.attachments);
      const resourceRefs = strictRoomWorkResourceRefs(input.resourceRefs);
      const snapshot = await captureBrowserWorkspaceSnapshot(browserTargetFromInput(input));
      const response = await browserSnapshotDomainApiClient(snapshot).executeOperation<unknown>(snapshot.workspaceId, "room.work.create", {
        context: { room_id: roomId },
        input: {
          ...(input.instruction === undefined ? {} : { instruction: input.instruction }),
          ...(attachments.length ? { attachments } : {}),
          ...(resourceRefs.length ? { resource_refs: resourceRefs.map(({ kind, id, version }) => ({ kind, id, version })) } : {}),
          ...(input.agentId ? { agent_id: input.agentId } : {})
        }
      }, { operationId: input.operationId, idempotencyKey: input.operationId });
      await assertBrowserWorkspaceSnapshot(snapshot);
      const work = toDesktopRoomWork(response.result);
      assertRoomWorkScope(work, roomId);
      return withReplayed(work, response.replayed);
    },
    replyWorkspaceRoomWork: async (input) => {
      const roomId = requirePublicId(input.roomId, "roomId");
      const workId = requirePublicId(input.workId, "workId");
      const attachments = strictRoomWorkAttachments(input.attachments);
      const resourceRefs = strictRoomWorkResourceRefs(input.resourceRefs);
      const snapshot = await captureBrowserWorkspaceSnapshot(browserTargetFromInput(input));
      const response = await browserSnapshotDomainApiClient(snapshot).executeOperation<unknown>(snapshot.workspaceId, "room.work.reply", {
        context: { room_id: roomId },
        input: {
          work_id: workId,
          ...(input.assigneeId ? { assignee_id: input.assigneeId } : {}),
          ...(input.instruction === undefined ? {} : { instruction: input.instruction }),
          ...(attachments.length ? { attachments } : {}),
          ...(resourceRefs.length ? { resource_refs: resourceRefs.map(({ kind, id, version }) => ({ kind, id, version })) } : {}),
          ...(input.expectedVersion === undefined ? {} : { expected_version: input.expectedVersion }),
          ...(input.expectedGeneration === undefined ? {} : { expected_generation: input.expectedGeneration })
        }
      }, { operationId: input.operationId, idempotencyKey: input.operationId });
      await assertBrowserWorkspaceSnapshot(snapshot);
      const instruction = toDesktopRoomWorkInstruction(response.result);
      assertRoomWorkScope(instruction, roomId, workId);
      return withReplayed(instruction, response.replayed);
    },
    createWorkspaceRoomWorkComment: async (input) => {
      const roomId = requirePublicId(input.roomId, "roomId");
      const workId = requirePublicId(input.workId, "workId");
      const attachments = strictRoomWorkAttachments(input.attachments);
      const snapshot = await captureBrowserWorkspaceSnapshot(browserTargetFromInput(input));
      const response = await browserSnapshotDomainApiClient(snapshot).executeOperation<unknown>(snapshot.workspaceId, "room.work.comment.create", {
        context: { room_id: roomId },
        input: {
          work_id: workId,
          ...(input.body === undefined ? {} : { body: input.body }),
          ...(attachments.length ? { attachments } : {}),
          ...(input.expectedVersion === undefined ? {} : { expected_version: input.expectedVersion })
        }
      }, { operationId: input.operationId, idempotencyKey: input.operationId });
      await assertBrowserWorkspaceSnapshot(snapshot);
      const comment = toDesktopRoomWorkComment(response.result);
      assertRoomWorkScope(comment, roomId, workId);
      return withReplayed(comment, response.replayed);
    },
    applyWorkspaceRoomWorkComment: async (input) => {
      const roomId = requirePublicId(input.roomId, "roomId");
      const workId = requirePublicId(input.workId, "workId");
      const commentId = requirePublicId(input.commentId, "commentId");
      const snapshot = await captureBrowserWorkspaceSnapshot(browserTargetFromInput(input));
      const response = await browserSnapshotDomainApiClient(snapshot).executeOperation<unknown>(snapshot.workspaceId, "room.work.comment.apply", {
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
      await assertBrowserWorkspaceSnapshot(snapshot);
      const instruction = toDesktopRoomWorkInstruction(response.result);
      assertRoomWorkScope(instruction, roomId, workId);
      return withReplayed(instruction, response.replayed);
    },
    reactWorkspaceRoomWorkComment: async (input) => {
      const roomId = requirePublicId(input.roomId, "roomId");
      const workId = requirePublicId(input.workId, "workId");
      const commentId = requirePublicId(input.commentId, "commentId");
      const snapshot = await captureBrowserWorkspaceSnapshot(browserTargetFromInput(input));
      const response = await browserSnapshotDomainApiClient(snapshot).executeOperation<unknown>(snapshot.workspaceId, "room.work.comment.reaction.set", {
        context: { room_id: roomId },
        input: {
          work_id: workId,
          comment_id: commentId,
          reaction: input.reaction ?? "like",
          enabled: input.enabled ?? true,
          ...(input.expectedVersion === undefined ? {} : { expected_version: input.expectedVersion })
        }
      }, { operationId: input.operationId, idempotencyKey: input.operationId });
      await assertBrowserWorkspaceSnapshot(snapshot);
      const reaction = toDesktopRoomWorkReaction(response.result);
      assertRoomWorkScope(reaction, roomId, workId);
      if (reaction.commentId !== commentId) throw new Error("room_work_reaction_scope_invalid");
      return withReplayed(reaction, response.replayed);
    },
    stopWorkspaceRoomWork: async (input) => {
      const roomId = requirePublicId(input.roomId, "roomId");
      const workId = requirePublicId(input.workId, "workId");
      const snapshot = await captureBrowserWorkspaceSnapshot(browserTargetFromInput(input));
      const response = await browserSnapshotDomainApiClient(snapshot).executeOperation<unknown>(snapshot.workspaceId, "room.work.stop", {
        context: { room_id: roomId },
        input: {
          work_id: workId,
          ...(input.reason ? { reason: input.reason } : {}),
          ...(input.expectedVersion === undefined ? {} : { expected_version: input.expectedVersion }),
          ...(input.expectedGeneration === undefined ? {} : { expected_generation: input.expectedGeneration })
        }
      }, { operationId: input.operationId, idempotencyKey: input.operationId });
      await assertBrowserWorkspaceSnapshot(snapshot);
      const control = toDesktopRoomWorkControl(response.result);
      assertRoomWorkScope(control, roomId, workId);
      return withReplayed(control, response.replayed);
    },
    stopWorkspaceRoomWorkAssignee: async (input) => {
      const roomId = requirePublicId(input.roomId, "roomId");
      const workId = requirePublicId(input.workId, "workId");
      const assigneeId = requirePublicId(input.assigneeId, "assigneeId");
      const snapshot = await captureBrowserWorkspaceSnapshot(browserTargetFromInput(input));
      const response = await browserSnapshotDomainApiClient(snapshot).executeOperation<unknown>(snapshot.workspaceId, "room.work.assignee.stop", {
        context: { room_id: roomId },
        input: {
          work_id: workId,
          assignee_id: assigneeId,
          ...(input.reason ? { reason: input.reason } : {}),
          ...(input.expectedVersion === undefined ? {} : { expected_version: input.expectedVersion }),
          ...(input.expectedGeneration === undefined ? {} : { expected_generation: input.expectedGeneration })
        }
      }, { operationId: input.operationId, idempotencyKey: input.operationId });
      await assertBrowserWorkspaceSnapshot(snapshot);
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
      const snapshot = await captureBrowserWorkspaceSnapshot(browserTargetFromInput(input));
      const response = await browserSnapshotDomainApiClient(snapshot).executeOperation<unknown>(snapshot.workspaceId, "room.default_agent.set", {
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
      const snapshot = await captureBrowserWorkspaceSnapshot(browserTargetFromInput(input));
      const response = await browserSnapshotDomainApiClient(snapshot).executeOperation<unknown>(snapshot.workspaceId, "agent.dm.open", {
        context: {},
        input: { agent_id: agentId }
      }, { operationId: input.operationId, idempotencyKey: input.operationId });
      await assertBrowserWorkspaceSnapshot(snapshot);
      const dm = toDesktopAgentDm(response.result);
      if (dm.workspaceId !== snapshot.workspaceId || dm.agentId !== agentId || dm.kind !== "agent_dm") throw new Error("agent_dm_response_scope_invalid");
      return withReplayed(dm, response.replayed);
    },
    listWorkspaceEvents: async (input) => {
      const snapshot = await captureBrowserWorkspaceSnapshot(browserTargetFromInput(input));
      const page = await browserSnapshotDomainApiClient(snapshot).listEvents(snapshot.workspaceId, {
        ...(input.roomId ? { roomId: requirePublicId(input.roomId, "roomId") } : {}),
        ...(input.afterCursor ? { afterCursor: input.afterCursor } : {}),
        ...(input.limit === undefined ? {} : { limit: input.limit })
      });
      await assertBrowserWorkspaceSnapshot(snapshot);
      return toDesktopPublicEventPage(page, input.roomId);
    },
    listWorkspaceAgentBackends: async (input) => {
      const snapshot = await captureBrowserWorkspaceSnapshot(browserTargetFromInput(input));
      const response = await browserSnapshotDomainApiClient(snapshot).executeQuery<unknown>(snapshot.workspaceId, "agent.backend.list", { context: {}, input: {} });
      await assertBrowserWorkspaceSnapshot(snapshot);
      return toDesktopWorkspaceAgentBackendList(response.result);
    },
    getWorkspaceSurfaceContract: (source) => {
      const value = source && typeof source === "object" && !Array.isArray(source) ? source as Record<string, unknown> : undefined;
      const sourceValue = typeof source === "string" ? source : typeof value?.source === "string" ? value.source : undefined;
      const query = sourceValue ? `?source=${encodeURIComponent(sourceValue)}` : "";
      return workspaceRequest<SurfaceContractPayload>("GET", `/surface/contract${query}`, undefined, undefined, undefined, browserTargetFromInput(value));
    },
    listWorkspaceChatSessions: (input?: unknown) => workspaceRequest<SessionRecord[]>("GET", "/chat/sessions", undefined, undefined, undefined, browserTargetFromInput(input)),
    createWorkspaceChatSession: async (input) => {
      const snapshot = await captureBrowserWorkspaceSnapshot(browserTargetFromInput(input));
      const response = await browserSnapshotDomainApiClient(snapshot).executeOperation<SessionRecord>(snapshot.workspaceId, "session.create", {
        context: { room_id: input.roomId },
        input: {
          ...(input.title ? { title: input.title } : {}),
          ...(input.uiLocale ? { ui_locale: input.uiLocale } : {}),
          ...(input.outputLocale ? { output_locale: input.outputLocale } : {})
        }
      }, { operationId: input.operationId, idempotencyKey: input.operationId });
      await assertBrowserWorkspaceSnapshot(snapshot);
      return response.result;
    },
    getWorkspaceChatSession: (input) => workspaceRequest<SessionDetail>("GET", `/chat/sessions/${encodeURIComponent(input.sessionId)}`, undefined, undefined, undefined, browserTargetFromInput(input)),
    sendWorkspaceChatMessage: async (input) => {
      const snapshot = await captureBrowserWorkspaceSnapshot(browserTargetFromInput(input));
      const response = await browserSnapshotDomainApiClient(snapshot).executeOperation<ChatTurnResult>(snapshot.workspaceId, "chat.turn.run", {
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
      await assertBrowserWorkspaceSnapshot(snapshot);
      return response.result;
    },
    writeWorkspaceAttachment: async (input) => {
      const snapshot = await captureBrowserWorkspaceSnapshot(browserTargetFromInput(input));
      const result = await browserSnapshotWorkspaceRequest<unknown>(snapshot, {
        method: "PUT",
        path: `/api/workspaces/${encodeURIComponent(snapshot.workspaceId)}/files/${workspaceAttachmentPath(input.path)}`,
        operationId: input.operationId,
        body: {
          room_id: input.roomId,
          content_base64: input.contentBase64,
          expected_version: input.expectedVersion
        }
      });
      await assertBrowserWorkspaceSnapshot(snapshot);
      return sanitizeWorkspaceAttachmentUploadResult(result);
    },
    searchWorkspace: (input) => workspaceInputRequest<SearchResult[]>(input, "GET", `/chat/search?room_id=${encodeURIComponent(input.roomId)}&q=${encodeURIComponent(input.query)}`),
    listWorkspaceBackendRuns: (input) => workspaceInputRequest<BackendRunRecord[]>(input, "GET", `/chat/runs${input.sessionId ? `?session_id=${encodeURIComponent(input.sessionId)}` : ""}`),
    getWorkspaceBackendRun: (input) => workspaceInputRequest<BackendRunRecord>(input, "GET", `/chat/runs/${encodeURIComponent(input.runId)}`),
    listWorkspaceBackendEvents: (input) => workspaceInputRequest<BackendEventRecord[]>(input, "GET", `/chat/runs/${encodeURIComponent(input.runId)}/events`),
    cancelWorkspaceBackendRun: (input) => workspaceInputRequest<BackendRunRecord>(input, "POST", `/chat/runs/${encodeURIComponent(input.runId)}/cancel`, {}, input.operationId),
    retryWorkspaceBackendRun: (input) => workspaceInputRequest<ChatSurfaceOperationResult>(input, "POST", `/chat/runs/${encodeURIComponent(input.runId)}/retry`, {}, input.operationId),
    listWorkspaceChanges: (input) => workspaceInputRequest(input, "GET", `/chat/changes${input.sessionId ? `?session_id=${encodeURIComponent(input.sessionId)}` : ""}`),
    listWorkspaceActivity: (input) => workspaceInputRequest<ActivityInboxItem[]>(input, "GET", `/chat/activity?room_id=${encodeURIComponent(input.roomId)}`),
    getWorkspaceAudit: async (input?: unknown) => {
      const body = await workspaceInputRequest<{ entries?: AuditPayload["workspaceEntries"] }>(input, "GET", "/audit");
      if (!Array.isArray(body.entries)) throw new Error("workspace_audit_response_invalid");
      return { auditRecords: [], operations: [], policyDecisions: [], approvalRequests: [], rollbackPoints: [], workspaceEntries: body.entries } satisfies AuditPayload;
    },
    listWorkspaceCompletionResources: (input) => {
      const query = new URLSearchParams();
      query.set("scope_kind", input.scopeKind);
      if (input.scopeKind === "room") query.set("room_id", input.roomId ?? "");
      if (input.kind) query.set("kind", input.kind);
      if (input.includeArchived) query.set("include_archived", "true");
      if (input.cursor) query.set("cursor", input.cursor);
      return workspaceV1InputRequest<{ resources: WorkspaceCompletionResourceView[]; next_cursor?: string }>(input, "GET", `/completion/resources?${query.toString()}`);
    },
    getWorkspaceCompletionResource: (input) => workspaceV1InputRequest<WorkspaceCompletionResourceDetail>(input, "GET", `/completion/resources/${encodeURIComponent(input.resourceId)}`),
    getWorkspaceCompletionResourceBody: (input) => workspaceV1InputRequest<WorkspaceCompletionResourceBody>(input, "GET", `/completion/resources/${encodeURIComponent(input.resourceId)}/body`),
    createWorkspaceCompletionResource: (input) => workspaceV1InputRequest(input, "POST", "/completion/resources", {
      scope_kind: input.scopeKind,
      ...(input.roomId ? { room_id: input.roomId } : {}),
      kind: input.kind,
      ...(input.knowledgeKind ? { knowledge_kind: input.knowledgeKind } : {}),
      title: input.title,
      content: input.content,
      ...(input.metadata ? { metadata: input.metadata } : {}),
      reason: input.reason
    }, input.operationId),
    updateWorkspaceCompletionResource: (input) => workspaceV1InputRequest(input, "PATCH", `/completion/resources/${encodeURIComponent(input.resourceId)}`, {
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
    setWorkspaceCompletionResourceFixed: (input) => workspaceV1InputRequest(input, "POST", `/completion/resources/${encodeURIComponent(input.resourceId)}/fix`, { fixed: input.fixed, expected_version: input.expectedVersion, reason: input.reason }, input.operationId),
    archiveWorkspaceCompletionResource: (input) => workspaceV1InputRequest(input, "POST", `/completion/resources/${encodeURIComponent(input.resourceId)}/archive`, { archived: input.archived, expected_version: input.expectedVersion, reason: input.reason }, input.operationId),
    searchWorkspaceCompletionKnowledge: (input) => workspaceV1InputRequest(input, "GET", `/completion/knowledge/search?room_id=${encodeURIComponent(input.roomId)}&q=${encodeURIComponent(input.query)}${input.limit === undefined ? "" : `&limit=${input.limit}`}${input.cursor ? `&cursor=${encodeURIComponent(input.cursor)}` : ""}`),
    listWorkspaceCompletionSkills: (input) => workspaceV1InputRequest(input, "GET", `/completion/skills?room_id=${encodeURIComponent(input.roomId)}${input.includeArchived ? "&include_archived=true" : ""}${input.cursor ? `&cursor=${encodeURIComponent(input.cursor)}` : ""}`),
    getWorkspaceCompletionSkill: (input) => workspaceV1InputRequest(input, "GET", `/completion/skills/${encodeURIComponent(input.resourceId)}${input.version === undefined ? "" : `?version=${input.version}`}`),
    listWorkspaceSkillOptimizations: (input) => {
      const query = new URLSearchParams();
      if (input.skillId) query.set("skill_id", input.skillId);
      if (input.roomId) query.set("room_id", input.roomId);
      if (input.limit !== undefined) query.set("limit", String(input.limit));
      return workspaceInputRequest<SkillOptimizationDetail["run"][]>(input, "GET", `/skill-optimizations${query.size ? `?${query.toString()}` : ""}`);
    },
    getWorkspaceSkillOptimization: (input) => workspaceInputRequest<SkillOptimizationDetail>(input, "GET", `/skill-optimizations/${encodeURIComponent(input.runId)}`),
    startWorkspaceSkillOptimization: (input) => workspaceInputRequest(input, "POST", `/skills/${encodeURIComponent(input.skillId)}/optimizations`, {
      ...(input.roomId ? { room_id: input.roomId } : {}),
      ...(input.objective ? { objective: input.objective } : {}),
      ...(input.goldenExamples ? { golden_examples: input.goldenExamples } : {}),
      ...(input.syntheticExamples ? { synthetic_examples: input.syntheticExamples } : {})
    }, input.operationId),
    runWorkspaceSkillOptimizationAction: (input) => workspaceInputRequest<Record<string, unknown>>(
      input,
      "POST",
      `/skill-optimizations/${encodeURIComponent(input.runId)}/${input.action}`,
      {
        ...(input.candidateId ? { candidate_id: input.candidateId } : {}),
        ...(input.promotionId ? { promotion_id: input.promotionId } : {}),
        ...(input.snapshotId ? { snapshot_id: input.snapshotId } : {})
      },
      input.operationId
    ),
    listWorkspaceKnowledgeWiki: (input) => workspaceInputRequest(input, "GET", `/knowledge-wiki?room_id=${encodeURIComponent(input.roomId)}${input.includeArchived ? "&include_archived=true" : ""}`),
    getWorkspaceKnowledgeWiki: (input) => workspaceInputRequest<WorkspaceKnowledgeWikiPage>(input, "GET", `/knowledge-wiki/${encodeURIComponent(input.wikiId)}`),
    createWorkspaceKnowledgeWiki: (input) => workspaceInputRequest(input, "POST", "/knowledge-wiki/proposals", {
      room_id: input.roomId,
      title: input.title,
      content: input.content,
      ...(input.slug ? { slug: input.slug } : {}),
      ...(input.tags ? { tags: input.tags } : {}),
      ...(input.contentLocale ? { content_locale: input.contentLocale } : {}),
      ...(input.knowledgeKind ? { knowledge_kind: input.knowledgeKind } : {}),
      reason: input.reason
    }, input.operationId),
    updateWorkspaceKnowledgeWiki: (input) => workspaceInputRequest(input, "PATCH", `/knowledge-wiki/${encodeURIComponent(input.wikiId)}`, {
      ...(input.title ? { title: input.title } : {}),
      ...(input.content !== undefined ? { content: input.content } : {}),
      ...(input.tags ? { tags: input.tags } : {}),
      ...(input.contentLocale ? { content_locale: input.contentLocale } : {}),
      reason: input.reason
    }, input.operationId),
    setWorkspaceKnowledgeWikiState: (input) => workspaceInputRequest(input, "POST", `/knowledge-wiki/${encodeURIComponent(input.wikiId)}/${input.state === "accept" ? "accept" : input.state === "reject" ? "reject" : "archive"}`, { reason: input.reason }, input.operationId),
    reindexWorkspaceKnowledgeWiki: (input) => workspaceInputRequest(input, "POST", "/knowledge-wiki/reindex", { room_id: input.roomId }),
    getWorkspaceKnowledgeWikiGraph: (input) => workspaceInputRequest(input, "GET", `/knowledge-wiki/graph?room_id=${encodeURIComponent(input.roomId)}${input.query ? `&query=${encodeURIComponent(input.query)}` : ""}`),
    getWorkspaceKnowledgeWikiLint: (input) => workspaceInputRequest(input, "GET", `/knowledge-wiki/lint?room_id=${encodeURIComponent(input.roomId)}`),
    getWorkspaceKnowledgeWikiBacklinks: (input) => workspaceInputRequest(input, "GET", `/knowledge-wiki/${encodeURIComponent(input.wikiId)}/backlinks?room_id=${encodeURIComponent(input.roomId)}`),
    listWorkspaceKnowledgeMemory: (input) => workspaceInputRequest<{ memories: WorkspaceKnowledgeMemoryPage[] }>(input, "GET", `/knowledge-memory?room_id=${encodeURIComponent(input.roomId)}${input.includeArchived ? "&include_archived=true" : ""}`),
    getWorkspaceKnowledgeMemory: (input) => workspaceInputRequest<WorkspaceKnowledgeMemoryPage>(input, "GET", `/knowledge-memory/${encodeURIComponent(input.memoryId)}`),
    searchWorkspaceKnowledgeMemory: (input) => workspaceInputRequest(input, "GET", `/knowledge-memory/search?room_id=${encodeURIComponent(input.roomId)}&q=${encodeURIComponent(input.query)}${input.limit === undefined ? "" : `&limit=${input.limit}`}`),
    archiveWorkspaceKnowledgeMemory: (input) => workspaceInputRequest(input, "POST", `/knowledge-memory/${encodeURIComponent(input.memoryId)}/archive`, { reason: input.reason }, input.operationId),
    listWorkspaceCollectionSchemas: (input) => workspaceInputRequest(input, "GET", `/collections/schemas?room_id=${encodeURIComponent(input.roomId)}`),
    getWorkspaceCollectionSchema: (input) => workspaceInputRequest(input, "GET", `/collections/${encodeURIComponent(input.collectionId)}/schema?room_id=${encodeURIComponent(input.roomId)}`),
    saveWorkspaceCollectionSchema: (input) => workspaceInputRequest(input, "POST", "/collections/schemas", { room_id: input.roomId, schema: input.schema, ...(input.expectedVersion === undefined ? {} : { expected_version: input.expectedVersion }) }, input.operationId),
    listWorkspaceCollectionRecords: (input) => workspaceInputRequest(input, "GET", `/collections/${encodeURIComponent(input.collectionId)}/records?room_id=${encodeURIComponent(input.roomId)}`),
    createWorkspaceCollectionRecord: (input) => workspaceInputRequest(input, "POST", `/collections/${encodeURIComponent(input.collectionId)}/records`, { room_id: input.roomId, record_id: input.recordId, data: input.data }, input.operationId),
    patchWorkspaceCollectionRecord: (input) => workspaceInputRequest(input, "POST", `/collections/${encodeURIComponent(input.collectionId)}/records/${encodeURIComponent(input.recordId)}/patches`, { room_id: input.roomId, ...(input.patchId ? { patch_id: input.patchId } : {}), changes: input.changes, ...(input.expectedVersion === undefined ? {} : { expected_version: input.expectedVersion }) }, input.operationId),
    deleteWorkspaceCollectionRecord: (input) => workspaceInputRequest(input, "DELETE", `/collections/${encodeURIComponent(input.collectionId)}/records/${encodeURIComponent(input.recordId)}`, { room_id: input.roomId, expected_version: input.expectedVersion }, input.operationId),
    listWorkspaceCollectionNotes: (input) => workspaceInputRequest(input, "GET", `/collections/${encodeURIComponent(input.collectionId)}/notes?room_id=${encodeURIComponent(input.roomId)}`),
    reindexWorkspaceCollections: (input) => workspaceInputRequest(input, "POST", "/collections/reindex", { room_id: input.roomId }),
    runWorkspaceCollectionSurfaceOperation: (input) => workspaceSurfaceRequest("/collections/surface/operations", input.roomId, input.operation, browserTargetFromInput(input)),
    listWorkspaceOperationHistory: async (input) => {
      const recordType = workspaceOperationHistoryRecordType(input.recordType);
      const records: WorkspaceOperationHistoryRecord[] = [];
      for (let offset = 0; ; ) {
        const response = await workspaceInputRequest<unknown>(
          input,
          "GET",
          `/records?room_id=${encodeURIComponent(input.roomId)}&record_type=${encodeURIComponent(recordType)}&limit=500&offset=${offset}`
        );
        const page = sanitizeWorkspaceOperationHistoryResponse(response, input, recordType).records;
        records.push(...page);
        if (page.length < 500) break;
        offset += page.length;
        if (offset > 100_000) throw new Error("workspace_operation_history_too_large");
      }
      return { records };
    },
    listWorkspaceArtifacts: async (input) => {
      const snapshot = await captureBrowserWorkspaceSnapshot(browserTargetFromInput(input));
      const response = await browserSnapshotDomainApiClient(snapshot).executeQuery<ArtifactRecord[]>(snapshot.workspaceId, "artifact.list", { context: { room_id: input.roomId }, input: {} });
      await assertBrowserWorkspaceSnapshot(snapshot);
      return { artifacts: response.result };
    },
    getWorkspaceArtifact: async (input) => {
      const snapshot = await captureBrowserWorkspaceSnapshot(browserTargetFromInput(input));
      const response = await browserSnapshotDomainApiClient(snapshot).executeQuery<ArtifactDetail>(snapshot.workspaceId, "artifact.view", { context: { room_id: input.roomId }, input: { id: input.artifactId } });
      await assertBrowserWorkspaceSnapshot(snapshot);
      if (response.result.artifact.id !== input.artifactId) throw new Error("workspace_artifact_response_scope_invalid");
      if (response.result.encoding !== "binary") return { ...response.result, auditRecords: [] };
      const content = await browserSnapshotWorkspaceBinaryRequest(snapshot, {
        method: "GET",
        path: `/api/v1/workspaces/${encodeURIComponent(snapshot.workspaceId)}/artifacts/${encodeURIComponent(input.artifactId)}/content?room_id=${encodeURIComponent(input.roomId)}`
      });
      await assertBrowserWorkspaceSnapshot(snapshot);
      await assertBrowserArtifactBinaryMetadata(response.result, content);
      return {
        ...response.result,
        content: "",
        content_bytes: content.bytes,
        ...(content.mimeType ? { mime_type: content.mimeType } : {}),
        encoding: "binary",
        auditRecords: []
      };
    },
    listWorkspaceArtifactRevisions: async (input) => {
      const snapshot = await captureBrowserWorkspaceSnapshot(browserTargetFromInput(input));
      const response = await browserSnapshotDomainApiClient(snapshot).listArtifactRevisions<{ revisions: ArtifactRevisionRecord[] }>(snapshot.workspaceId, input.roomId, input.artifactId);
      await assertBrowserWorkspaceSnapshot(snapshot);
      if (!Array.isArray(response.revisions) || response.revisions.some((revision) => revision.artifact_id !== input.artifactId)) throw new Error("workspace_artifact_revision_response_scope_invalid");
      return response.revisions;
    },
    getWorkspaceArtifactRevision: async (input) => {
      const snapshot = await captureBrowserWorkspaceSnapshot(browserTargetFromInput(input));
      const detail = await browserSnapshotDomainApiClient(snapshot).getArtifactRevision<ArtifactRevisionDetail>(snapshot.workspaceId, input.roomId, input.artifactId, input.revisionId);
      await assertBrowserWorkspaceSnapshot(snapshot);
      if (detail.artifact.id !== input.artifactId || detail.revision.id !== input.revisionId || detail.revision.artifact_id !== input.artifactId) throw new Error("workspace_artifact_revision_response_scope_invalid");
      if (detail.encoding !== "binary") return detail;
      const content = await browserSnapshotWorkspaceBinaryRequest(snapshot, {
        method: "GET",
        path: `/api/v1/workspaces/${encodeURIComponent(snapshot.workspaceId)}/artifacts/${encodeURIComponent(input.artifactId)}/content?room_id=${encodeURIComponent(input.roomId)}&revision_id=${encodeURIComponent(input.revisionId)}`
      });
      await assertBrowserWorkspaceSnapshot(snapshot);
      await assertBrowserArtifactBinaryMetadata(detail, content);
      return {
        ...detail,
        content: "",
        content_bytes: content.bytes,
        ...(content.mimeType ? { mime_type: content.mimeType } : {}),
        encoding: "binary"
      };
    },
    reviseWorkspaceArtifact: async (input) => {
      const snapshot = await captureBrowserWorkspaceSnapshot(browserTargetFromInput(input));
      const response = await browserSnapshotDomainApiClient(snapshot).executeOperation<ArtifactMutationResult>(snapshot.workspaceId, "artifact.revise", {
        context: { room_id: input.roomId },
        input: {
          artifact_id: input.artifactId,
          content: bridgeArtifactContent(input.content),
          ...(input.baseRevisionId ? { base_revision_id: input.baseRevisionId } : {}),
          ...(input.expectedRevision === undefined ? {} : { expected_revision: input.expectedRevision }),
          ...(input.changeSummary ? { change_summary: input.changeSummary } : {}),
          ...(input.mimeType ? { mime_type: input.mimeType } : {}),
          ...(input.encoding ? { encoding: input.encoding } : {})
        }
      }, { operationId: input.operationId, idempotencyKey: input.operationId });
      await assertBrowserWorkspaceSnapshot(snapshot);
      if (response.result.artifact.id !== input.artifactId) throw new Error("workspace_artifact_response_scope_invalid");
      return response.result;
    },
    restoreWorkspaceArtifactRevision: async (input) => {
      const snapshot = await captureBrowserWorkspaceSnapshot(browserTargetFromInput(input));
      const response = await browserSnapshotDomainApiClient(snapshot).executeOperation<ArtifactMutationResult>(snapshot.workspaceId, "artifact.restore_revision", {
        context: { room_id: input.roomId },
        input: {
          artifact_id: input.artifactId,
          revision_id: input.revisionId,
          ...(input.baseRevisionId ? { base_revision_id: input.baseRevisionId } : {}),
          ...(input.expectedRevision === undefined ? {} : { expected_revision: input.expectedRevision }),
          ...(input.changeSummary ? { change_summary: input.changeSummary } : {})
        }
      }, { operationId: input.operationId, idempotencyKey: input.operationId });
      await assertBrowserWorkspaceSnapshot(snapshot);
      if (response.result.artifact.id !== input.artifactId || response.result.revision?.artifact_id !== input.artifactId) throw new Error("workspace_artifact_response_scope_invalid");
      return response.result;
    },
    createWorkspaceArtifact: async (input) => {
      const snapshot = await captureBrowserWorkspaceSnapshot(browserTargetFromInput(input));
      const response = await browserSnapshotDomainApiClient(snapshot).executeOperation<ArtifactMutationResult>(snapshot.workspaceId, "artifact.create", {
        context: { room_id: input.roomId },
        input: {
          title: input.title,
          content: toBridgeJson(bridgeArtifactCreateContent(input.content)),
          ...(input.kind ? { kind: input.kind } : {}),
          ...(input.locale ? { output_locale: input.locale } : {}),
          ...(input.sourceLocales?.[0] ? { input_locale: input.sourceLocales[0] } : {}),
          ...(input.metadata ? { metadata: input.metadata } : {}),
          ...(input.mimeType ? { mime_type: input.mimeType } : {}),
          ...(input.encoding ? { encoding: input.encoding } : {})
        }
      }, { operationId: input.operationId, idempotencyKey: input.operationId });
      await assertBrowserWorkspaceSnapshot(snapshot);
      return response.result;
    },
    runWorkspaceArtifactSurfaceOperation: async (input) => {
      const snapshot = await captureBrowserWorkspaceSnapshot(browserTargetFromInput(input));
      const response = await browserSnapshotDomainApiClient(snapshot).runArtifactSurfaceOperation<SurfaceOperationResultEnvelope>(snapshot.workspaceId, input.roomId, toBridgeJson(input.operation), { operationId: input.operation.id, idempotencyKey: input.operation.id });
      await assertBrowserWorkspaceSnapshot(snapshot);
      return response;
    },
    listWorkspaceGeneratedSurfaces: async (input) => {
      const snapshot = await captureBrowserWorkspaceSnapshot(browserTargetFromInput(input));
      const response = await browserSnapshotDomainApiClient(snapshot).listGeneratedSurfaces<{ surfaces: import("@samurai-agent/core-schemas").GeneratedSurfaceDefinition[] }>(snapshot.workspaceId, input.roomId);
      await assertBrowserWorkspaceSnapshot(snapshot);
      return response.surfaces;
    },
    getWorkspaceGeneratedSurface: async (input) => {
      const snapshot = await captureBrowserWorkspaceSnapshot(browserTargetFromInput(input));
      const detail = await browserSnapshotDomainApiClient(snapshot).getGeneratedSurface<GeneratedSurfaceDetail>(snapshot.workspaceId, input.roomId, input.surfaceId);
      await assertBrowserWorkspaceSnapshot(snapshot);
      if (detail.surface.id !== input.surfaceId) throw new Error("workspace_generated_surface_response_scope_invalid");
      return detail;
    },
    queryWorkspaceGeneratedSurface: async (input) => {
      const snapshot = await captureBrowserWorkspaceSnapshot(browserTargetFromInput(input));
      const detail = await browserSnapshotDomainApiClient(snapshot).getGeneratedSurface<GeneratedSurfaceDetail>(snapshot.workspaceId, input.roomId, input.surfaceId);
      await assertBrowserWorkspaceSnapshot(snapshot);
      if (detail.surface.id !== input.surfaceId) throw new Error("workspace_generated_surface_response_scope_invalid");
      return detail;
    },
    createWorkspaceGeneratedSurface: async (input) => {
      const snapshot = await captureBrowserWorkspaceSnapshot(browserTargetFromInput(input));
      const response = await browserSnapshotDomainApiClient(snapshot).executeOperation<GeneratedSurfaceMutationResult>(snapshot.workspaceId, "generated_surface.create", {
        context: { room_id: input.roomId },
        input: { bundle: toBridgeJson(input.bundle), request: toBridgeJson(input.request) }
      }, { operationId: input.operationId, idempotencyKey: input.operationId });
      await assertBrowserWorkspaceSnapshot(snapshot);
      if (response.result.definition?.id !== undefined && response.result.revision?.surface_id !== response.result.definition.id) throw new Error("workspace_generated_surface_response_scope_invalid");
      return response.result;
    },
    reviseWorkspaceGeneratedSurface: async (input) => {
      const snapshot = await captureBrowserWorkspaceSnapshot(browserTargetFromInput(input));
      const response = await browserSnapshotDomainApiClient(snapshot).executeOperation<GeneratedSurfaceMutationResult>(snapshot.workspaceId, "generated_surface.revise", {
        context: { room_id: input.roomId },
        input: { surface_id: input.surfaceId, bundle: toBridgeJson(input.bundle), request: toBridgeJson(input.request) }
      }, { operationId: input.operationId, idempotencyKey: input.operationId });
      await assertBrowserWorkspaceSnapshot(snapshot);
      if (response.result.definition?.id !== input.surfaceId || response.result.revision?.surface_id !== input.surfaceId) throw new Error("workspace_generated_surface_response_scope_invalid");
      return response.result;
    },
    getWorkspaceGeneratedSurfaceBundle: async (input) => {
      const snapshot = await captureBrowserWorkspaceSnapshot(browserTargetFromInput(input));
      const bundle = await browserSnapshotDomainApiClient(snapshot).getGeneratedSurfaceBundle<GeneratedSurfaceBundleDetail>(snapshot.workspaceId, input.roomId, input.surfaceId, input.revisionId);
      await assertBrowserWorkspaceSnapshot(snapshot);
      if (bundle.surface.id !== input.surfaceId || bundle.revision.id !== input.revisionId) throw new Error("workspace_generated_surface_response_scope_invalid");
      return bundle;
    },
    runWorkspaceGeneratedSurfaceAction: async (input) => {
      const snapshot = await captureBrowserWorkspaceSnapshot(browserTargetFromInput(input));
      const result = await browserSnapshotDomainApiClient(snapshot).runGeneratedSurfaceAction<Record<string, unknown>>(snapshot.workspaceId, input.roomId, input.surfaceId, input.actionId, {
        ...(input.revisionId ? { revision_id: input.revisionId } : {}),
        ...(input.interactionId ? { interaction_id: input.interactionId } : {}),
        ...(input.messageId ? { message_id: input.messageId } : {}),
        ...(input.actionPayload ? { action_payload: input.actionPayload } : {})
      }, { operationId: input.operationId, idempotencyKey: input.operationId });
      await assertBrowserWorkspaceSnapshot(snapshot);
      return result;
    },
    runWorkspaceGeneratedSurfaceState: async (input) => {
      const snapshot = await captureBrowserWorkspaceSnapshot(browserTargetFromInput(input));
      const result = await browserSnapshotDomainApiClient(snapshot).runGeneratedSurfaceState<import("@samurai-agent/core-schemas").GeneratedSurfaceDefinition>(snapshot.workspaceId, input.roomId, input.surfaceId, {
        action: input.action,
        ...(input.interactionId ? { interaction_id: input.interactionId } : {}),
        ...(input.messageId ? { message_id: input.messageId } : {})
      }, { operationId: input.operationId, idempotencyKey: input.operationId });
      await assertBrowserWorkspaceSnapshot(snapshot);
      if (result.id !== input.surfaceId) throw new Error("workspace_generated_surface_response_scope_invalid");
      return result;
    },
    exportWorkspaceGeneratedSurface: async (input) => {
      const snapshot = await captureBrowserWorkspaceSnapshot(browserTargetFromInput(input));
      const result = await browserSnapshotDomainApiClient(snapshot).exportGeneratedSurface<GeneratedSurfaceExportPayload>(snapshot.workspaceId, input.roomId, input.surfaceId, { ...(input.revisionId ? { revision_id: input.revisionId } : {}), format: input.format });
      await assertBrowserWorkspaceSnapshot(snapshot);
      return result;
    },
    listWorkspaceInteractionRequests: async (input) => {
      const value = interactionInputRecord(input);
      const roomId = interactionRequiredId(value.roomId, "roomId");
      const includeResolved = strictInteractionBoolean(value.includeResolved, "includeResolved", false);
      const snapshot = await captureBrowserWorkspaceSnapshot(browserTargetFromInput(input));
      const requests: DesktopWorkspaceInteractionRequest[] = [];
      for (let offset = 0; ; ) {
        const response = await browserSnapshotWorkspaceRequest<unknown>(snapshot, {
          method: "GET",
          path: `/api/v1/workspaces/${encodeURIComponent(snapshot.workspaceId)}/interaction-requests?room_id=${encodeURIComponent(roomId)}&include_resolved=${includeResolved ? "true" : "false"}&limit=500&offset=${offset}`
        });
        const page = sanitizeBrowserInteractionListResponse(response, snapshot.workspaceId, roomId).requests;
        requests.push(...page);
        if (page.length < 500) break;
        offset += page.length;
        if (offset > 100_000) throw new Error("workspace_interaction_request_list_too_large");
      }
      return { requests };
    },
    getWorkspaceInteractionRequestResult: async (input) => {
      const value = interactionInputRecord(input);
      const roomId = interactionRequiredId(value.roomId, "roomId");
      const requestId = interactionRequiredId(value.requestId, "requestId");
      const operationId = interactionRequiredId(value.operationId, "operationId");
      const snapshot = await captureBrowserWorkspaceSnapshot(browserTargetFromInput(input));
      const response = await browserSnapshotWorkspaceRequest<unknown>(snapshot, {
        method: "GET",
        operationId,
        path: `/api/v1/workspaces/${encodeURIComponent(snapshot.workspaceId)}/interaction-requests/${encodeURIComponent(requestId)}/result?room_id=${encodeURIComponent(roomId)}`
      });
      return sanitizeBrowserInteractionResultResponse(response, snapshot.workspaceId, roomId, requestId);
    },
    respondWorkspaceInteractionRequest: async (input) => {
      const value = interactionInputRecord(input);
      const roomId = interactionRequiredId(value.roomId, "roomId");
      const requestId = interactionRequiredId(value.requestId, "requestId");
      const expectedVersion = strictInteractionVersion(value.expectedVersion, "expectedVersion");
      const optionId = interactionRequiredId(value.optionId, "optionId");
      const operationId = interactionRequiredId(value.operationId, "operationId");
      const values = value.values === undefined ? undefined : strictInteractionJsonObject(value.values, "values", 256 * 1024);
      const snapshot = await captureBrowserWorkspaceSnapshot(browserTargetFromInput(input));
      const response = await browserSnapshotWorkspaceRequest<unknown>(snapshot, {
        method: "POST",
        path: `/api/v1/workspaces/${encodeURIComponent(snapshot.workspaceId)}/interaction-requests/${encodeURIComponent(requestId)}/respond`,
        operationId,
        idempotencyKey: operationId,
        body: {
          room_id: roomId,
          expected_version: expectedVersion,
          option_id: optionId,
          ...(values === undefined ? {} : { values })
        }
      });
      return sanitizeBrowserInteractionMutationResponse(response, snapshot.workspaceId, roomId, requestId);
    },
    cancelWorkspaceInteractionRequest: async (input) => {
      const value = interactionInputRecord(input);
      const roomId = interactionRequiredId(value.roomId, "roomId");
      const requestId = interactionRequiredId(value.requestId, "requestId");
      const expectedVersion = strictInteractionVersion(value.expectedVersion, "expectedVersion");
      const operationId = interactionRequiredId(value.operationId, "operationId");
      const snapshot = await captureBrowserWorkspaceSnapshot(browserTargetFromInput(input));
      const response = await browserSnapshotWorkspaceRequest<unknown>(snapshot, {
        method: "POST",
        path: `/api/v1/workspaces/${encodeURIComponent(snapshot.workspaceId)}/interaction-requests/${encodeURIComponent(requestId)}/cancel`,
        operationId,
        idempotencyKey: operationId,
        body: { room_id: roomId, expected_version: expectedVersion }
      });
      return sanitizeBrowserInteractionMutationResponse(response, snapshot.workspaceId, roomId, requestId);
    },
    listWorkspaceAutomationJobs: (input) => workspaceV1InputRequest(input, "GET", `/automation/jobs${input.roomId ? `?room_id=${encodeURIComponent(input.roomId)}` : ""}`),
    createWorkspaceAutomationJob: (input) => workspaceV1InputRequest(input, "POST", "/automation/jobs", {
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
    listWorkspaceAutomationRuns: (input) => workspaceV1InputRequest(input, "GET", `/automation/runs${input.roomId ? `?room_id=${encodeURIComponent(input.roomId)}` : ""}`),
    listWorkspaceAutomationJobRuns: (input) => workspaceV1InputRequest(input, "GET", `/automation/jobs/${encodeURIComponent(input.jobId)}/runs`),
    setWorkspaceAutomationManagement: (input) => workspaceV1InputRequest(input, "POST", `/automation/jobs/${encodeURIComponent(input.jobId)}/management`, { state: input.state }, input.operationId),
    runWorkspaceAutomationNow: (input) => workspaceV1InputRequest(input, "POST", "/automation/run-now", { room_id: input.roomId, ...(input.kind ? { kind: input.kind } : {}) }, input.operationId),
    listWorkspaceRoomMembers: (input) => {
      const raw = input as unknown;
      const value = typeof raw === "string" ? { roomId: raw } : raw as { roomId: string };
      return workspaceInputRequest<{ members: DesktopWorkspaceRoomMembership[] }>(value, "GET", `/rooms/${encodeURIComponent(value.roomId)}/members`);
    },
    createWorkspaceRoom: async (input) => {
      const roomInput = input as unknown as NativeRoomCreateInput;
      const snapshot = await captureBrowserWorkspaceSnapshot(browserTargetFromInput(roomInput));
      if (roomInput.newAgent?.enabled === false) throw new Error("room_default_agent_enabled_required");
      const response = await browserSnapshotDomainApiClient(snapshot).createRoom<PublicRoomRecord>(snapshot.workspaceId, {
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
      await assertBrowserWorkspaceSnapshot(snapshot);
      if (response.result.workspace_id !== snapshot.workspaceId) throw new Error("workspace_room_response_scope_invalid");
      return {
        room: toDesktopWorkspaceRoom(response.result),
        target: { connectionId: snapshot.id, workspaceId: snapshot.workspaceId },
        replayed: response.replayed
      };
    },
    previewWorkspaceRoomMove: (input) => workspaceInputRequest<{ preview: DesktopRoomMovePreview }>(input, "POST", `/rooms/${encodeURIComponent(input.roomId)}/parent/preview`, { parent_room_id: input.parentRoomId }),
    moveWorkspaceRoom: (input) => workspaceInputRequest(input, "PUT", `/rooms/${encodeURIComponent(input.roomId)}/parent`, { parent_room_id: input.parentRoomId, expected_room_version: input.expectedRoomVersion, expected_workspace_version: input.expectedWorkspaceVersion }, input.operationId),
    previewWorkspaceRoomMember: (input) => workspaceInputRequest<{ preview: DesktopRoomMemberPreview }>(input, "POST", `/rooms/${encodeURIComponent(input.roomId)}/members/${encodeURIComponent(input.accountId)}/preview`, { role: input.role, state: input.state }),
    setWorkspaceRoomMember: (input) => workspaceInputRequest(input, "PUT", `/rooms/${encodeURIComponent(input.roomId)}/members/${encodeURIComponent(input.accountId)}`, { role: input.role, state: input.state, expected_version: input.expectedVersion }, input.operationId),
    getWorkspaceLearningSettings: (input) => {
      const raw = input as unknown;
      const value = typeof raw === "string" ? { roomId: raw } : raw as { roomId: string };
      return workspaceV1InputRequest<{ settings: DesktopWorkspaceLearningSettings; workspace_settings?: DesktopWorkspaceLearningSettings; room_settings?: DesktopWorkspaceLearningSettings }>(value, "GET", `/learning/settings?room_id=${encodeURIComponent(value.roomId)}`);
    },
    updateWorkspaceLearningSettings: (input) => workspaceV1InputRequest(input, "PATCH", "/learning/settings", {
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
  const snapshot = await captureBrowserWorkspaceSnapshot(browserTargetFromInput(input));
  const response = await browserSnapshotDomainApiClient(snapshot).executeOperation<unknown>(snapshot.workspaceId, "room.work.assignee.reassign", {
    context: { room_id: roomId },
    input: {
      work_id: workId,
      assignee_id: assigneeId,
      agent_id: agentId,
      ...(input.expectedVersion === undefined ? {} : { expected_version: input.expectedVersion }),
      ...(input.expectedGeneration === undefined ? {} : { expected_generation: input.expectedGeneration })
    }
  }, { operationId: input.operationId, idempotencyKey: input.operationId });
  await assertBrowserWorkspaceSnapshot(snapshot);
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
  const snapshot = await captureBrowserWorkspaceSnapshot(browserTargetFromInput(input));
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

const roomWorkResourceRefKinds = ["knowledge", "skill"] as const;

/**
 * Convert the renderer's display selection into the only shape accepted by
 * the public Room Work API.  URI, label, and any future client fields are not
 * copied across the HTTP boundary.
 */
function strictRoomWorkResourceRefs(value: unknown, errorCode = "room_work_resource_ref_invalid"): DesktopWorkspaceRoomWorkResourceRefInput[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(errorCode);
  if (value.length > 32) throw new Error("room_work_resource_ref_count_invalid");
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(errorCode);
    const source = item as Record<string, unknown>;
    const kind = source.kind;
    const id = typeof source.id === "string" ? source.id.trim() : "";
    const version = source.version;
    if (!roomWorkResourceRefKinds.includes(kind as (typeof roomWorkResourceRefKinds)[number])
      || !id
      || id.length > 512
      || typeof version !== "number"
      || !Number.isSafeInteger(version)
      || version <= 0) {
      throw new Error(errorCode);
    }
    return { kind: kind as DesktopWorkspaceRoomWorkResourceRefInput["kind"], id, version };
  });
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
  const activeRoomId = currentActiveWorkspaceRoomId();
  return {
    ...(state.activeConnectionId ? { activeConnectionId: state.activeConnectionId } : {}),
    ...(active?.workspaceId ? {
      activeTarget: {
        connectionId: active.id,
        workspaceId: active.workspaceId,
        ...(activeRoomId ? { roomId: activeRoomId } : {})
      }
    } : {}),
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

function bridgeArtifactContent(content: string | Uint8Array): string | number[] {
  return typeof content === "string" ? content : Array.from(content);
}

function bridgeArtifactCreateContent(content: string | Uint8Array | Record<string, JsonValue> | JsonValue[]): string | number[] | Record<string, JsonValue> | JsonValue[] {
  if (typeof content === "string") return content;
  if (content instanceof Uint8Array) return Array.from(content);
  return content;
}

function toBridgeJson(value: unknown): JsonValue {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("workspace_json_value_invalid");
  return JSON.parse(encoded) as JsonValue;
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

type BrowserSnapshotWorkspaceRequestInput = {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  operationId?: string;
  idempotencyKey?: string;
  body?: unknown;
  /** Explicit scope supplied by an adapter when the request body is opaque. */
  requestRoomId?: string;
};

/** Fixed interaction-request transport; no generic signed request is exposed. */
async function browserSnapshotWorkspaceRequest<T>(
  snapshot: BrowserWorkspaceSnapshot,
  input: BrowserSnapshotWorkspaceRequestInput
): Promise<T> {
  await assertBrowserWorkspaceSnapshot(snapshot);
  assertBrowserWorkspaceRequestRoom(snapshot, input);
  const result = await browserWorkspaceRequest<T>({
    method: input.method,
    path: input.path,
    connectionId: snapshot.id,
    workspaceScoped: true,
    ...(input.operationId ? { operationId: input.operationId } : {}),
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    ...(input.body === undefined ? {} : { body: input.body })
  });
  assertBrowserWorkspaceRequestRoom(snapshot, input);
  await assertBrowserWorkspaceSnapshot(snapshot);
  return result;
}

async function browserSnapshotWorkspaceBinaryRequest(
  snapshot: BrowserWorkspaceSnapshot,
  input: Pick<BrowserSnapshotWorkspaceRequestInput, "path"> & { method: "GET" }
): ReturnType<typeof browserWorkspaceBinaryRequest> {
  await assertBrowserWorkspaceSnapshot(snapshot);
  assertBrowserWorkspaceRequestRoom(snapshot, input);
  const result = await browserWorkspaceBinaryRequest({
    method: input.method,
    path: input.path,
    connectionId: snapshot.id,
    workspaceScoped: true
  });
  assertBrowserWorkspaceRequestRoom(snapshot, input);
  await assertBrowserWorkspaceSnapshot(snapshot);
  return result;
}

async function assertBrowserArtifactBinaryMetadata(
  value: { encoding?: string; mime_type?: string; revision?: { content_bytes?: number; content_hash?: string; mime_type?: string } },
  content: { bytes: number[]; mimeType?: string; encoding?: string }
): Promise<void> {
  if (value.encoding !== "binary" || content.encoding !== "binary") {
    throw new Error("workspace_artifact_binary_response_encoding_invalid");
  }
  const expectedMimeType = value.mime_type ?? value.revision?.mime_type;
  if (!expectedMimeType || !content.mimeType || expectedMimeType.toLowerCase() !== content.mimeType.toLowerCase()) {
    throw new Error("workspace_artifact_binary_response_mime_invalid");
  }
  if (value.revision?.content_bytes !== undefined && value.revision.content_bytes !== content.bytes.length) {
    throw new Error("workspace_artifact_binary_response_size_invalid");
  }
  const expectedHash = value.revision?.content_hash;
  if (!expectedHash || !/^[a-f0-9]{64}$/.test(expectedHash)) {
    throw new Error("workspace_artifact_binary_response_hash_missing");
  }
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(content.bytes)));
  const actualHash = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  if (actualHash !== expectedHash) throw new Error("workspace_artifact_binary_response_hash_mismatch");
}

function sanitizeBrowserInteractionListResponse(
  value: unknown,
  workspaceId: string,
  roomId: string
): { requests: DesktopWorkspaceInteractionRequest[] } {
  const rows = Array.isArray(value)
    ? value
    : (() => {
      const body = publicRecord(value, "workspace_interaction_request_list");
      if (!Array.isArray(body.requests)) throw new Error("workspace_interaction_request_list_response_invalid");
      return body.requests;
    })();
  return { requests: rows.map((row) => sanitizeBrowserInteractionRequest(row, workspaceId, roomId)) };
}

function sanitizeBrowserInteractionMutationResponse(
  value: unknown,
  workspaceId: string,
  roomId: string,
  requestId: string
): DesktopWorkspaceInteractionMutationResult {
  const body = publicRecord(value, "workspace_interaction_request_mutation");
  const request = sanitizeBrowserInteractionRequest(body.request, workspaceId, roomId);
  if (request.id !== requestId) throw new Error("workspace_interaction_request_response_scope_invalid");
  if (body.replayed !== undefined && typeof body.replayed !== "boolean") throw new Error("workspace_interaction_request_response_invalid");
  return { request, ...(body.replayed === undefined ? {} : { replayed: body.replayed }) };
}

function sanitizeBrowserInteractionResultResponse(
  value: unknown,
  workspaceId: string,
  roomId: string,
  requestId: string
): DesktopWorkspaceInteractionResult {
  const body = publicRecord(value, "workspace_interaction_request_result");
  const request = sanitizeBrowserInteractionRequest(body.request, workspaceId, roomId);
  if (request.id !== requestId) throw new Error("workspace_interaction_request_result_scope_invalid");
  const targetResult = body.target_result === undefined
    ? undefined
    : strictInteractionJsonValue(body.target_result, "target_result", 256 * 1024);
  return { request, ...(targetResult === undefined ? {} : { targetResult }) };
}

function sanitizeBrowserInteractionRequest(
  value: unknown,
  workspaceId: string,
  roomId: string
): DesktopWorkspaceInteractionRequest {
  const record = publicRecord(value, "workspace_interaction_request");
  const actualWorkspaceId = interactionRequiredId(interactionField(record, "workspaceId", "workspace_id"), "workspaceId");
  const actualRoomId = interactionRequiredId(interactionField(record, "roomId", "room_id"), "roomId");
  if (actualWorkspaceId !== workspaceId || actualRoomId !== roomId) throw new Error("workspace_interaction_request_response_scope_invalid");

  const kind = interactionEnum(interactionField(record, "kind"), ["approval", "backend_input"] as const, "kind");
  const status = interactionEnum(interactionField(record, "status"), interactionRequestStatuses, "status");
  const optionsValue = interactionField(record, "options");
  if (!Array.isArray(optionsValue) || optionsValue.length === 0 || optionsValue.length > 128) throw new Error("workspace_interaction_request_options_invalid");
  const options = optionsValue.map((option, index) => {
    const optionRecord = publicRecord(option, `workspace_interaction_request_option_${index}`);
    return {
      id: interactionRequiredId(interactionField(optionRecord, "id"), `options_${index}_id`),
      label: interactionRequiredText(interactionField(optionRecord, "label"), `options_${index}_label`, 2_000),
      decision: interactionEnum(interactionField(optionRecord, "decision"), interactionDecisions, `options_${index}_decision`),
      ...(interactionOptionalText(interactionField(optionRecord, "description"), `options_${index}_description`, 20_000) ? { description: interactionOptionalText(interactionField(optionRecord, "description"), `options_${index}_description`, 20_000) } : {})
    };
  });
  if (new Set(options.map((option) => option.id)).size !== options.length) throw new Error("workspace_interaction_request_options_invalid");

  const inputSchemaValue = interactionField(record, "inputSchema", "input_schema");
  const inputSchema = inputSchemaValue === undefined || inputSchemaValue === null
    ? undefined
    : sanitizeBrowserInteractionInputSchema(inputSchemaValue);
  const outcomeValue = interactionField(record, "outcome");
  const executionValue = interactionField(record, "execution");
  const outcome = outcomeValue === undefined || outcomeValue === null ? undefined : sanitizeBrowserInteractionOutcome(outcomeValue);
  const execution = executionValue === undefined || executionValue === null ? undefined : sanitizeBrowserInteractionExecution(executionValue);
  const executionSummary = execution?.summary;
  const actionIdValue = interactionField(record, "actionId", "action_id");
  const targetLabelValue = interactionField(record, "targetLabel", "target_label");
  return {
    id: interactionRequiredId(interactionField(record, "id"), "id"),
    workspaceId: actualWorkspaceId,
    roomId: actualRoomId,
    version: interactionVersion(interactionField(record, "version"), "version"),
    kind,
    status,
    title: interactionRequiredText(interactionField(record, "title"), "title", 20_000),
    summary: interactionRequiredText(interactionField(record, "summary"), "summary", 20_000, false),
    ...(interactionOptionalId(interactionField(record, "runId", "run_id"), "runId") ? { runId: interactionOptionalId(interactionField(record, "runId", "run_id"), "runId") } : {}),
    ...(interactionOptionalId(interactionField(record, "surfaceId", "surface_id"), "surfaceId") ? { surfaceId: interactionOptionalId(interactionField(record, "surfaceId", "surface_id"), "surfaceId") } : {}),
    ...(interactionOptionalId(interactionField(record, "revisionId", "revision_id"), "revisionId") ? { revisionId: interactionOptionalId(interactionField(record, "revisionId", "revision_id"), "revisionId") } : {}),
    actionTarget: sanitizeBrowserInteractionActionTarget(interactionField(record, "actionTarget", "action_target")),
    options,
    ...(inputSchema === undefined ? {} : { inputSchema }),
    expiresAt: interactionRequiredText(interactionField(record, "expiresAt", "expires_at"), "expiresAt", 128),
    ...(outcome === undefined ? {} : { outcome }),
    ...(execution === undefined ? {} : { execution }),
    createdAt: interactionRequiredText(interactionField(record, "createdAt", "created_at"), "createdAt", 128),
    updatedAt: interactionRequiredText(interactionField(record, "updatedAt", "updated_at"), "updatedAt", 128),
    ...(interactionOptionalId(actionIdValue, "actionId") ? { actionId: interactionOptionalId(actionIdValue, "actionId") } : {}),
    ...(interactionOptionalText(targetLabelValue, "targetLabel", 2_000) ? { targetLabel: interactionOptionalText(targetLabelValue, "targetLabel", 2_000) } : {}),
    ...(execution?.status === "failed" && executionSummary ? { failureSummary: executionSummary } : {}),
    ...(execution?.status !== "failed" && executionSummary ? { resultSummary: executionSummary } : {}),
    ...(execution?.errorCode ? { errorCode: execution.errorCode } : {})
  };
}

function sanitizeBrowserInteractionActionTarget(value: unknown): Record<string, JsonValue> {
  const target = strictInteractionJsonObject(value, "actionTarget", 64 * 1024);
  for (const key of ["input", "input_values", "execution_input", "result", "values"]) delete target[key];
  return target;
}

function sanitizeBrowserInteractionInputSchema(value: unknown): NonNullable<DesktopWorkspaceInteractionRequest["inputSchema"]> {
  const source = strictInteractionJsonObject(value, "inputSchema", 64 * 1024);
  if (source.type !== undefined && source.type !== "object") throw new Error("workspace_interaction_request_input_schema_invalid");
  const properties: NonNullable<DesktopWorkspaceInteractionRequest["inputSchema"]>["properties"] = {};
  if (source.properties !== undefined) {
    if (!source.properties || typeof source.properties !== "object" || Array.isArray(source.properties)) throw new Error("workspace_interaction_request_input_schema_invalid");
    for (const [id, propertyValue] of Object.entries(source.properties as Record<string, unknown>)) {
      if (!id.trim() || id.length > 256) throw new Error("workspace_interaction_request_input_schema_invalid");
      const property = strictInteractionJsonObject(propertyValue, "inputSchema", 8 * 1024);
      const type = property.type;
      if (type !== undefined && type !== "string" && type !== "number" && type !== "integer" && type !== "boolean") throw new Error("workspace_interaction_request_input_schema_invalid");
      const enumValue = property.enum;
      if (enumValue !== undefined && (!Array.isArray(enumValue) || enumValue.length > 128 || enumValue.some((candidate) => typeof candidate !== "string" && typeof candidate !== "number" && typeof candidate !== "boolean" || typeof candidate === "number" && !Number.isFinite(candidate)))) throw new Error("workspace_interaction_request_input_schema_invalid");
      const minLength = interactionOptionalNonNegativeInteger(property.minLength, "inputSchema");
      const maxLength = interactionOptionalNonNegativeInteger(property.maxLength, "inputSchema");
      if (minLength !== undefined && maxLength !== undefined && minLength > maxLength) throw new Error("workspace_interaction_request_input_schema_invalid");
      properties[id] = {
        ...(type === undefined ? {} : { type }),
        ...(typeof property.title === "string" ? { title: property.title.slice(0, 2_000) } : property.title === undefined ? {} : (() => { throw new Error("workspace_interaction_request_input_schema_invalid"); })()),
        ...(typeof property.description === "string" ? { description: property.description.slice(0, 20_000) } : property.description === undefined ? {} : (() => { throw new Error("workspace_interaction_request_input_schema_invalid"); })()),
        ...(enumValue === undefined ? {} : { enum: enumValue as Array<string | number | boolean> }),
        ...(minLength === undefined ? {} : { minLength }),
        ...(maxLength === undefined ? {} : { maxLength })
      };
    }
  }
  const required = source.required;
  if (required !== undefined && (!Array.isArray(required) || required.length > 256 || required.some((item) => typeof item !== "string" || !item.trim() || !Object.prototype.hasOwnProperty.call(properties, item)))) throw new Error("workspace_interaction_request_input_schema_invalid");
  if (source.additionalProperties !== undefined && typeof source.additionalProperties !== "boolean") throw new Error("workspace_interaction_request_input_schema_invalid");
  return {
    ...(source.type === undefined ? {} : { type: "object" as const }),
    ...(Object.keys(properties).length ? { properties } : {}),
    ...(required === undefined ? {} : { required: required as string[] }),
    ...(source.additionalProperties === undefined ? {} : { additionalProperties: source.additionalProperties })
  };
}

function sanitizeBrowserInteractionOutcome(value: unknown): NonNullable<DesktopWorkspaceInteractionRequest["outcome"]> {
  const record = publicRecord(value, "workspace_interaction_request_outcome");
  const kind = interactionEnum(interactionField(record, "kind"), ["response", "cancelled", "expired"] as const, "outcome_kind");
  if (kind === "response") {
    return {
      kind,
      optionId: interactionRequiredId(interactionField(record, "optionId", "option_id"), "outcome_option_id"),
      decision: interactionEnum(interactionField(record, "decision"), interactionDecisions, "outcome_decision"),
      decidedAt: interactionRequiredText(interactionField(record, "decidedAt", "decided_at"), "outcome_decided_at", 128)
    };
  }
  if (kind === "cancelled") return { kind, decidedAt: interactionRequiredText(interactionField(record, "decidedAt", "decided_at"), "outcome_decided_at", 128) };
  return { kind, expiredAt: interactionRequiredText(interactionField(record, "expiredAt", "expired_at"), "outcome_expired_at", 128) };
}

function sanitizeBrowserInteractionExecution(value: unknown): NonNullable<DesktopWorkspaceInteractionRequest["execution"]> {
  const record = publicRecord(value, "workspace_interaction_request_execution");
  const status = interactionEnum(interactionField(record, "status"), interactionExecutionStatuses, "execution_status");
  const summary = interactionOptionalText(interactionField(record, "summary"), "execution_summary", 20_000);
  const errorCode = interactionOptionalText(interactionField(record, "errorCode", "error_code"), "execution_error_code", 256);
  return {
    status,
    startedAt: interactionRequiredText(interactionField(record, "startedAt", "started_at"), "execution_started_at", 128),
    ...(interactionOptionalText(interactionField(record, "finishedAt", "finished_at"), "execution_finished_at", 128) ? { finishedAt: interactionOptionalText(interactionField(record, "finishedAt", "finished_at"), "execution_finished_at", 128) } : {}),
    ...(summary ? { summary } : {}),
    ...(errorCode ? { errorCode } : {})
  };
}

const interactionRequestStatuses = ["pending", "accepted", "denied", "cancelled", "expired", "executing", "completed", "failed"] as const;
const interactionExecutionStatuses = ["executing", "completed", "failed"] as const;
const interactionDecisions = ["approve", "deny", "submit_input"] as const;
const interactionOpaqueIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function interactionField(record: Record<string, unknown>, camelKey: string, snakeKey = camelKey.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)): unknown {
  return record[camelKey] === undefined ? record[snakeKey] : record[camelKey];
}

function interactionInputRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("workspace_interaction_request_input_invalid");
  return value as Record<string, unknown>;
}

function interactionRequiredId(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`${field}_invalid`);
  const normalized = value.trim();
  if (!interactionOpaqueIdPattern.test(normalized)) throw new Error(`${field}_invalid`);
  return normalized;
}

function interactionOptionalId(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return interactionRequiredId(value, field);
}

function interactionRequiredText(value: unknown, field: string, maxLength: number, allowEmpty = true): string {
  if (typeof value !== "string" || value.length > maxLength || (!allowEmpty && !value.trim())) throw new Error(`${field}_response_invalid`);
  return value;
}

function interactionOptionalText(value: unknown, field: string, maxLength: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  return interactionRequiredText(value, field, maxLength);
}

function interactionVersion(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new Error(`${field}_response_invalid`);
  return value;
}

function strictInteractionVersion(value: unknown, field: string): number {
  return interactionVersion(value, field);
}

function strictInteractionBoolean(value: unknown, field: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error(`${field}_invalid`);
  return value;
}

function interactionOptionalNonNegativeInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 1_000_000) throw new Error(`workspace_interaction_request_${field.toLowerCase()}_invalid`);
  return value;
}

function interactionEnum<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) throw new Error(`${field}_response_invalid`);
  return value as T;
}

function strictInteractionJsonObject(value: unknown, field: string, maxBytes: number): Record<string, JsonValue> {
  if (!isInteractionJsonObject(value)) throw new Error(`${field}_invalid`);
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new Error(`${field}_invalid`);
  }
  if (encoded.length > maxBytes) throw new Error(`${field}_invalid`);
  try {
    const parsed: unknown = JSON.parse(encoded);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, JsonValue>;
  } catch {
    throw new Error(`${field}_invalid`);
  }
}

function strictInteractionJsonValue(value: unknown, field: string, maxBytes: number): JsonValue {
  if (!isInteractionJsonValue(value, 0, new WeakSet<object>())) throw new Error(`${field}_invalid`);
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new Error(`${field}_invalid`);
  }
  if (encoded.length > maxBytes) throw new Error(`${field}_invalid`);
  try {
    return JSON.parse(encoded) as JsonValue;
  } catch {
    throw new Error(`${field}_invalid`);
  }
}

function isInteractionJsonObject(value: unknown): value is Record<string, JsonValue> {
  return isInteractionJsonObjectValue(value, 0, new WeakSet<object>());
}

function isInteractionJsonObjectValue(value: unknown, depth: number, seen: WeakSet<object>): value is Record<string, JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value) || depth > 8 || seen.has(value)) return false;
  seen.add(value);
  const entries = Object.entries(value as Record<string, unknown>);
  return entries.length <= 2_000 && entries.every(([key, item]) => key.length <= 512 && isInteractionJsonValue(item, depth + 1, seen));
}

function isInteractionJsonValue(value: unknown, depth: number, seen: WeakSet<object>): value is JsonValue {
  if (depth > 8) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) {
    if (seen.has(value) || value.length > 2_000) return false;
    seen.add(value);
    return value.every((item) => isInteractionJsonValue(item, depth + 1, seen));
  }
  if (typeof value === "object") return isInteractionJsonObjectValue(value, depth, seen);
  return false;
}

async function workspaceRequest<T>(
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  suffix: string,
  body?: unknown,
  operationId?: string,
  idempotencyKey?: string,
  target?: BrowserWorkspaceTargetRef,
  workspaceRoot: "/api/workspaces" | "/api/v1/workspaces" = "/api/workspaces",
  requestRoomId?: string
): Promise<T> {
  const snapshot = await captureBrowserWorkspaceSnapshot(target);
  return browserSnapshotWorkspaceRequest<T>(snapshot, {
    method,
    path: `${workspaceRoot}/${encodeURIComponent(snapshot.workspaceId)}${suffix}`,
    ...(operationId ? { operationId } : {}),
    ...(idempotencyKey ? { idempotencyKey } : {}),
    ...(body === undefined ? {} : { body }),
    ...(requestRoomId === undefined ? {} : { requestRoomId })
  });
}

async function workspaceInputRequest<T>(
  input: unknown,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  suffix: string,
  body?: unknown,
  operationId?: string,
  idempotencyKey?: string
): Promise<T> {
  return workspaceRequest<T>(method, suffix, body, operationId, idempotencyKey, browserTargetFromInput(input), "/api/workspaces", browserRequestRoomIdFromInput(input));
}

async function workspaceV1InputRequest<T>(
  input: unknown,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  suffix: string,
  body?: unknown,
  operationId?: string,
  idempotencyKey?: string
): Promise<T> {
  return workspaceRequest<T>(method, suffix, body, operationId, idempotencyKey, browserTargetFromInput(input), "/api/v1/workspaces", browserRequestRoomIdFromInput(input));
}

function browserSnapshotDomainApiClient(snapshot: BrowserWorkspaceSnapshot): DomainApiClient {
  return new DomainApiClient(async <T>(request: DomainApiTransportRequest): Promise<T> => {
    await assertBrowserWorkspaceSnapshot(snapshot);
    const result = await browserSnapshotWorkspaceRequest<T>(snapshot, {
      method: request.method,
      path: request.path,
      ...(request.operationId ? { operationId: request.operationId } : {}),
      ...(request.idempotencyKey ? { idempotencyKey: request.idempotencyKey } : {}),
      ...(request.body === undefined ? {} : { body: request.body })
    });
    return result;
  });
}

async function requireBrowserWorkspaceConnection(): Promise<NonNullable<Awaited<ReturnType<typeof loadBrowserWorkspaceConnection>>>> {
  const connection = await loadBrowserWorkspaceConnection();
  if (!connection) throw new Error("workspace_connection_required");
  return connection;
}

function browserTargetFromInput(input: unknown): BrowserWorkspaceTargetRef | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const value = input as Record<string, unknown>;
  if (!("target" in value)) return undefined;
  const target = value.target;
  if (!target || typeof target !== "object" || Array.isArray(target)) throw new Error("workspace_target_invalid");
  const candidate = target as Record<string, unknown>;
  if (typeof candidate.connectionId !== "string" || !browserWorkspaceOpaqueIdPattern.test(candidate.connectionId)
    || typeof candidate.workspaceId !== "string" || !browserWorkspaceOpaqueIdPattern.test(candidate.workspaceId)) {
    throw new Error("workspace_target_invalid");
  }
  const roomId = candidate.roomId;
  const selectionGeneration = candidate.selectionGeneration;
  if (roomId !== undefined && (typeof roomId !== "string" || !browserWorkspaceOpaqueIdPattern.test(roomId))) {
    throw new Error("workspace_target_invalid");
  }
  if (selectionGeneration !== undefined && (typeof selectionGeneration !== "number" || !Number.isSafeInteger(selectionGeneration) || selectionGeneration < 0)) {
    throw new Error("workspace_target_invalid");
  }
  const normalizedSelectionGeneration = selectionGeneration as number | undefined;
  return {
    connectionId: candidate.connectionId,
    workspaceId: candidate.workspaceId,
    ...(roomId === undefined ? {} : { roomId }),
    ...(normalizedSelectionGeneration === undefined ? {} : { selectionGeneration: normalizedSelectionGeneration })
  };
}

function browserRequestRoomIdFromInput(input: unknown): string | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const value = input as Record<string, unknown>;
  const candidate = value.roomId ?? value.room_id;
  if (candidate === undefined || candidate === null || candidate === "") return undefined;
  if (typeof candidate !== "string" || !browserWorkspaceOpaqueIdPattern.test(candidate)) {
    throw new Error("workspace_request_room_invalid");
  }
  return candidate;
}

/**
 * A Room-scoped request must agree with the renderer's current Room before it
 * is signed.  This covers compatibility calls that do not carry a full
 * target, while the Server remains the final authorization authority.
 */
function assertBrowserWorkspaceRequestRoom(
  snapshot: BrowserWorkspaceSnapshot,
  input: Pick<BrowserSnapshotWorkspaceRequestInput, "path" | "body" | "requestRoomId">
): void {
  const requestRoomIds = browserWorkspaceRequestRoomIds(input);
  if (requestRoomIds.length > 1) throw new Error("workspace_request_room_ambiguous");
  const requestRoomId = requestRoomIds[0];
  if (!requestRoomId) return;
  const activeRoomId = currentActiveWorkspaceRoomId();
  if (activeRoomId !== undefined && activeRoomId !== requestRoomId) throw new Error("room_navigation_changed");
  if (snapshot.roomId !== undefined && snapshot.roomId !== requestRoomId) throw new Error("room_navigation_changed");
}

function browserWorkspaceRequestRoomIds(input: Pick<BrowserSnapshotWorkspaceRequestInput, "path" | "body" | "requestRoomId">): string[] {
  const roomIds = new Set<string>();
  const add = (value: unknown): void => {
    if (value === undefined || value === null || value === "") return;
    if (typeof value !== "string" || !browserWorkspaceOpaqueIdPattern.test(value)) throw new Error("workspace_request_room_invalid");
    roomIds.add(value);
  };
  add(input.requestRoomId);

  const url = new URL(input.path, "https://workspace.invalid");
  add(url.searchParams.get("room_id"));
  const roomPath = /\/rooms\/([^/]+)/.exec(url.pathname)?.[1];
  if (roomPath) {
    try {
      add(decodeURIComponent(roomPath));
    } catch {
      throw new Error("workspace_request_path_invalid");
    }
  }
  browserCollectWorkspaceRequestRoomIds(input.body, roomIds, add, 0, new WeakSet<object>());
  return [...roomIds];
}

function browserCollectWorkspaceRequestRoomIds(
  value: unknown,
  roomIds: Set<string>,
  add: (value: unknown) => void,
  depth: number,
  seen: WeakSet<object>
): void {
  if (!value || typeof value !== "object" || depth > 3 || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) browserCollectWorkspaceRequestRoomIds(item, roomIds, add, depth + 1, seen);
    return;
  }
  const record = value as Record<string, unknown>;
  add(record.room_id);
  add(record.roomId);
  for (const key of ["context", "input", "request", "body"] as const) {
    browserCollectWorkspaceRequestRoomIds(record[key], roomIds, add, depth + 1, seen);
  }
}

async function captureBrowserWorkspaceSnapshot(target?: BrowserWorkspaceTargetRef): Promise<BrowserWorkspaceSnapshot> {
  const connection = await requireBrowserWorkspaceConnection();
  if (target && (target.connectionId !== connection.id || target.workspaceId !== connection.workspaceId)) {
    throw new Error("workspace_navigation_changed");
  }
  const activeRoomId = currentActiveWorkspaceRoomId();
  if (target?.roomId !== undefined && activeRoomId !== undefined && target.roomId !== activeRoomId) {
    throw new Error("room_navigation_changed");
  }
  return {
    id: connection.id,
    workspaceId: connection.workspaceId,
    ...(target?.roomId ?? activeRoomId ? { roomId: target?.roomId ?? activeRoomId } : {}),
    ...(target?.selectionGeneration === undefined ? {} : { selectionGeneration: target.selectionGeneration })
  };
}

/** Discard a response that completed after the active Workspace changed. */
async function assertBrowserWorkspaceSnapshot(connection: BrowserWorkspaceSnapshot): Promise<void> {
  const current = await loadBrowserWorkspaceConnection();
  if (!current || current.id !== connection.id || current.workspaceId !== connection.workspaceId) {
    throw new Error("workspace_navigation_changed");
  }
  const activeRoomId = currentActiveWorkspaceRoomId();
  if (connection.roomId !== undefined && activeRoomId !== undefined && connection.roomId !== activeRoomId) {
    throw new Error("room_navigation_changed");
  }
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

function workspaceOperationHistoryRecordType(value: unknown): WorkspaceOperationHistoryRecordType {
  if (typeof value !== "string" || !workspaceOperationHistoryRecordTypes.includes(value as WorkspaceOperationHistoryRecordType)) {
    throw new Error("workspace_operation_history_record_type_invalid");
  }
  return value as WorkspaceOperationHistoryRecordType;
}

function sanitizeWorkspaceOperationHistoryResponse(
  value: unknown,
  input: { roomId: string; target?: NativeWorkspaceTarget },
  recordType: WorkspaceOperationHistoryRecordType
): { records: WorkspaceOperationHistoryRecord[] } {
  const body = publicRecord(value, "workspace_operation_history");
  const rows = publicArray(body, "records", "workspace_operation_history");
  return {
    records: rows.map((value, index) => {
      const field = `workspace_operation_history_${index}`;
      const record = publicRecord(value, field);
      const workspaceId = publicString(record, "workspaceId", field);
      const roomId = publicString(record, "roomId", field);
      const actualRecordType = workspaceOperationHistoryRecordType(record.recordType);
      const id = publicString(record, "id", field);
      const version = publicNumber(record, "version", field);
      const payload = record.payload;
      if (!isInteractionJsonObject(payload)
        || roomId !== input.roomId
        || actualRecordType !== recordType
        || (input.target?.workspaceId !== undefined && workspaceId !== input.target.workspaceId)) {
        throw new Error("workspace_operation_history_response_scope_invalid");
      }
      return {
        workspaceId,
        roomId,
        recordType: actualRecordType,
        id,
        version,
        payload,
        ...(optionalPublicString(record, "contentHash") ? { contentHash: record.contentHash as string } : {}),
        ...(optionalPublicString(record, "createdAt") ? { createdAt: record.createdAt as string } : {}),
        ...(optionalPublicString(record, "updatedAt") ? { updatedAt: record.updatedAt as string } : {})
      };
    })
  };
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

function publicRoomWorkResourceRefs(record: Record<string, unknown>): ResourceRef[] {
  if (record.resource_refs === undefined) return [];
  const values = publicArray(record, "resource_refs", "room_work_resource_refs");
  if (values.length > 32) throw new Error("room_work_resource_ref_count_response_invalid");
  return values.map((item, index) => {
    const parsed = ResourceRefSchema.safeParse(item);
    if (!parsed.success
      || (parsed.data.kind !== "knowledge" && parsed.data.kind !== "skill")
      || typeof parsed.data.version !== "string"
      || !/^[1-9][0-9]*$/.test(parsed.data.version)) {
      throw new Error(`room_work_resource_refs_${index}_response_invalid`);
    }
    return parsed.data;
  });
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
    resourceRefs: publicRoomWorkResourceRefs(record),
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
    resourceRefs: publicRoomWorkResourceRefs(record),
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

async function workspaceSurfaceRequest<T = unknown>(
  suffix: string,
  roomId: string,
  operation: SurfaceOperation,
  target?: BrowserWorkspaceTargetRef
): Promise<SurfaceOperationResultEnvelope<T>> {
  return workspaceRequest<SurfaceOperationResultEnvelope<T>>("POST", suffix, { room_id: roomId, operation }, operation.id, operation.id, target);
}
