import {
  browserWorkspaceHealth,
  browserWorkspaceBinaryRequest,
  browserWorkspaceRequest,
  browserShareSourceRequest,
  createBrowserShareDelegation,
  createBrowserWorkspaceConnectionState,
  loadBrowserWorkspaceConnection,
  loadBrowserWorkspaceConnections,
  registerBrowserWorkspaceAccount,
  selectBrowserWorkspaceConnection,
  selectBrowserWorkspaceCandidate,
  subscribeBrowserWorkspaceRealtime
} from "./workspace-browser-auth";
import {
  DomainApiClient,
  PublicAccountInvitationNotificationsPageSchema,
  PublicAccountWorkspaceNotificationSummariesSchema,
  PublicAgentBackendRecordSchema,
  PublicCompletionResourceBodySchema,
  PublicCompletionResourceDetailSchema,
  PublicCompletionResourceMutationResponseSchema,
  PublicCompletionResourcePageSchema,
  PublicNotificationMarkReadResultSchema,
  PublicNotificationPageSchema,
  PublicNotificationSummarySchema,
  PublicRoomWorkResultResourceRefSchema,
  PublicShareDelegationSchema,
  PublicShareDraftCreateInputSchema,
  PublicShareDraftDiscardInputSchema,
  PublicShareDraftDiscardResultSchema,
  PublicShareDraftSchema,
  PublicShareDraftUpdateInputSchema,
  PublicShareDraftViewInputSchema,
  PublicShareImportInputSchema,
  PublicShareImportResultSchema,
  PublicShareListInputSchema,
  PublicShareLocatorSchema,
  PublicShareOriginSchema,
  PublicSharePageSchema,
  PublicSharePublishInputSchema,
  PublicSharePublishResultSchema,
  PublicShareRevokeInputSchema,
  PublicShareRevokeResultSchema,
  PublicShareManifestSchema,
  PublicShareVisibilitySchema,
  PublicShareImportStatusInputSchema,
  PublicTargetSchema,
  PublicWorkspaceSearchPageSchema,
  type DomainApiRequest,
  type DomainApiTransportRequest,
  type PublicSearchItem,
  type PublicTarget,
  type PublicRoomRecord
} from "@samurai-agent/domain-api";
import { beginActiveWorkspaceRoomSelection, currentActiveWorkspaceRoomId, isCurrentActiveWorkspaceRoomSelection } from "./workspace-navigation-state";
import type {
  AgentBackendAvailability,
  ArtifactDetail,
  ArtifactMutationResult,
  ArtifactRevisionDetail,
  AuditPayload,
  ChatTurnResult,
  ChatSurfaceOperationResult,
  PersonalPreferencesSnapshot,
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
  WorkspaceAttachmentReadResult,
  WorkspaceAttachmentUploadResult,
  AccountInvitationNotificationListInput,
  AccountWorkspaceNotificationSummaries,
  AccountWorkspaceNotificationSummariesInput,
  WorkspaceContextSearchInput,
  WorkspaceContextSearchPage,
  WorkspaceContextSearchItem,
  WorkspaceContextTarget,
  WorkspaceNotification,
  WorkspaceNotificationListInput,
  WorkspaceNotificationMarkReadResult,
  WorkspaceNotificationPage,
  WorkspaceNotificationSummary,
  WorkspaceKnowledgeMemoryPage,
  WorkspaceKnowledgeWikiPage,
  DesktopWorkspaceTarget,
  WorkspaceShareDraft,
  WorkspaceShareDraftCreateInput,
  WorkspaceShareDraftDiscardInput,
  WorkspaceShareDraftDiscardResult,
  WorkspaceShareDraftUpdateInput,
  WorkspaceShareDraftViewInput,
  WorkspaceShareImportInput,
  WorkspaceShareImportResult,
  WorkspaceShareImportStatusInput,
  WorkspaceShareLinkImportInput,
  WorkspaceShareLinkView,
  WorkspaceShareLinkViewInput,
  WorkspaceShareListInput,
  WorkspaceSharePage,
  WorkspaceSharePublishInput,
  WorkspaceSharePublishResult,
  WorkspaceShareRevokeInput,
  WorkspaceShareRevokeResult
} from "./api";
import {
  ResourceRefSchema,
  WorkspaceFileResourceRefSchema,
  supportedLocales,
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

/**
 * Validate the renderer-provided private preference snapshot before it enters
 * the signed Domain API input. The Account identity is supplied by the
 * selected connection, so it is deliberately not part of this value.
 */
function normalizeBrowserPersonalPreferences(value: unknown): PersonalPreferencesSnapshot | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("personal_preferences_invalid");
  const record = value as Record<string, unknown>;
  const allowedKeys = ["schema_version", "revision", "display_name", "output_locale", "instructions"] as const;
  if (Object.keys(record).some((key) => !(allowedKeys as readonly string[]).includes(key))) {
    throw new Error("personal_preferences_invalid");
  }
  if (record.schema_version !== 1
    || typeof record.revision !== "number"
    || !Number.isSafeInteger(record.revision)
    || record.revision < 0
    || typeof record.display_name !== "string"
    || typeof record.instructions !== "string") {
    throw new Error("personal_preferences_invalid");
  }
  const displayName = record.display_name.trim();
  if (!displayName || displayName.length > 200 || record.instructions.length > 20_000) {
    throw new Error("personal_preferences_invalid");
  }
  const outputLocale = record.output_locale;
  if (outputLocale !== null
    && (typeof outputLocale !== "string" || !(supportedLocales as readonly string[]).includes(outputLocale))) {
    throw new Error("personal_preferences_invalid");
  }
  return {
    schema_version: 1,
    revision: record.revision,
    display_name: displayName,
    output_locale: outputLocale as SupportedLocale | null,
    instructions: record.instructions
  };
}

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

type DesktopWorkspaceRoomWorkAssignmentResult = {
  summary?: string;
  resource_refs?: Array<{
    kind: string;
    id: string;
    uri: string;
    parent_id?: string;
    version?: string;
    label?: string;
  }>;
};

type DesktopWorkspaceRoomWorkAssigneeWithResult = DesktopWorkspaceRoomWorkAssignee & {
  result?: DesktopWorkspaceRoomWorkAssignmentResult;
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
      if (Object.prototype.hasOwnProperty.call(input as object, "personal_preferences")) {
        throw new Error("personal_preferences_invalid");
      }
      const personalPreferences = normalizeBrowserPersonalPreferences(input.personalPreferences);
      const snapshot = await captureBrowserWorkspaceSnapshot(browserTargetFromInput(input));
      const response = await browserSnapshotDomainApiClient(snapshot).executeOperation<ChatTurnResult>(snapshot.workspaceId, "chat.turn.run", {
        context: { session_id: input.sessionId },
        input: {
          content: input.content,
          ...(input.inputLocale ? { input_locale: input.inputLocale } : {}),
          ...(input.outputLocale ? { output_locale: input.outputLocale } : {}),
          ...(input.backendId ? { backend_id: input.backendId } : {}),
          ...(input.metadata ? { metadata: input.metadata } : {}),
          ...(input.attachments?.length ? { attachments: input.attachments } : {}),
          ...(personalPreferences === undefined ? {} : { personal_preferences: personalPreferences })
        } as unknown as DomainApiRequest["input"]
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
    readWorkspaceAttachment: async (input) => {
      const resource = WorkspaceFileResourceRefSchema.parse(input.resourceRef);
      const snapshot = await captureBrowserWorkspaceSnapshot(browserTargetFromInput(input));
      const result = await browserSnapshotWorkspaceBinaryRequest(snapshot, {
        method: "GET",
        path: `/api/workspaces/${encodeURIComponent(snapshot.workspaceId)}/files/${workspaceAttachmentPath(resource.uri)}?room_id=${encodeURIComponent(input.roomId)}&version=${encodeURIComponent(resource.version)}&sha256=${encodeURIComponent(resource.id)}`
      });
      const bytes = result.bytes;
      if (result.fileVersion !== undefined && result.fileVersion !== String(resource.version)) {
        throw new Error("workspace_attachment_read_version_mismatch");
      }
      if (result.fileSha256 !== undefined && result.fileSha256 !== resource.id) {
        throw new Error("workspace_attachment_read_hash_mismatch");
      }
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes)));
      const actualSha256 = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
      if (actualSha256 !== resource.id) throw new Error("workspace_attachment_read_hash_mismatch");
      return sanitizeWorkspaceAttachmentReadResult({
        file: { path: resource.uri, version: Number(resource.version), sha256: resource.id, size: bytes.length },
        bytes,
        ...(result.mimeType ? { mimeType: result.mimeType } : {})
      });
    },
    searchWorkspace: (input) => workspaceInputRequest<SearchResult[]>(input, "GET", `/chat/search?room_id=${encodeURIComponent(input.roomId)}&q=${encodeURIComponent(input.query)}`),
    searchWorkspaceContext: (input) => searchBrowserWorkspaceContext(input),
    listWorkspaceNotifications: (input = {}) => listBrowserWorkspaceNotifications(input),
    getWorkspaceNotificationSummary: (input = {}) => getBrowserWorkspaceNotificationSummary(input),
    markWorkspaceNotificationsRead: (input) => markBrowserWorkspaceNotificationsRead(input),
    getAccountWorkspaceNotificationSummaries: (input) => getBrowserAccountWorkspaceNotificationSummaries(input),
    listAccountInvitationNotifications: (input = {}) => listBrowserAccountInvitationNotifications(input),
    markAccountInvitationNotificationsRead: (input) => markBrowserAccountInvitationNotificationsRead(input),
    createWorkspaceShareDraft: (input) => createBrowserWorkspaceShareDraft(input),
    viewWorkspaceShareDraft: (input) => viewBrowserWorkspaceShareDraft(input),
    updateWorkspaceShareDraft: (input) => updateBrowserWorkspaceShareDraft(input),
    discardWorkspaceShareDraft: (input) => discardBrowserWorkspaceShareDraft(input),
    listWorkspaceShares: (input) => listBrowserWorkspaceShares(input),
    publishWorkspaceShare: (input) => publishBrowserWorkspaceShare(input),
    revokeWorkspaceShare: (input) => revokeBrowserWorkspaceShare(input),
    importWorkspaceShare: (input) => importBrowserWorkspaceShare(input),
    getWorkspaceShareImportStatus: (input) => getBrowserWorkspaceShareImportStatus(input),
    viewWorkspaceShareLink: (input) => viewBrowserWorkspaceShareLink(input),
    importWorkspaceShareLink: (input) => importBrowserWorkspaceShareLink(input),
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
      if (isBrowserAgentCompletionInput(input)) return listBrowserAgentCompletionResources(input);
      const query = new URLSearchParams();
      query.set("scope_kind", input.scopeKind);
      if (input.scopeKind === "room") query.set("room_id", input.roomId ?? "");
      if (input.kind) query.set("kind", input.kind);
      if (input.includeArchived) query.set("include_archived", "true");
      if (input.cursor) query.set("cursor", input.cursor);
      return workspaceV1InputRequest<{ resources: WorkspaceCompletionResourceView[]; next_cursor?: string }>(input, "GET", `/completion/resources?${query.toString()}`);
    },
    getWorkspaceCompletionResource: (input) => isBrowserAgentCompletionInput(input)
      ? getBrowserAgentCompletionResource(input)
      : workspaceV1InputRequest<WorkspaceCompletionResourceDetail>(input, "GET", `/completion/resources/${encodeURIComponent(input.resourceId)}`),
    getWorkspaceCompletionResourceBody: (input) => isBrowserAgentCompletionInput(input)
      ? getBrowserAgentCompletionResourceBody(input)
      : workspaceV1InputRequest<WorkspaceCompletionResourceBody>(input, "GET", `/completion/resources/${encodeURIComponent(input.resourceId)}/body`),
    createWorkspaceCompletionResource: (input) => isBrowserAgentCompletionInput(input)
      ? createBrowserAgentCompletionResource(input)
      : workspaceV1InputRequest(input, "POST", "/completion/resources", {
      scope_kind: input.scopeKind,
      ...(input.roomId ? { room_id: input.roomId } : {}),
      kind: input.kind,
      ...(input.knowledgeKind ? { knowledge_kind: input.knowledgeKind } : {}),
      title: input.title,
      content: input.content,
      ...(input.metadata ? { metadata: input.metadata } : {}),
      reason: input.reason
    }, input.operationId),
    updateWorkspaceCompletionResource: (input) => isBrowserAgentCompletionInput(input)
      ? updateBrowserAgentCompletionResource(input)
      : workspaceV1InputRequest(input, "PATCH", `/completion/resources/${encodeURIComponent(input.resourceId)}`, {
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
    archiveWorkspaceCompletionResource: (input) => isBrowserAgentCompletionInput(input)
      ? archiveBrowserAgentCompletionResource(input)
      : workspaceV1InputRequest(input, "POST", `/completion/resources/${encodeURIComponent(input.resourceId)}/archive`, { archived: input.archived, expected_version: input.expectedVersion, reason: input.reason }, input.operationId),
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
    getWorkspaceKnowledgeMemory: (input) => {
      const roomId = input.target?.roomId ?? currentActiveWorkspaceRoomId();
      if (!roomId) throw new Error("knowledge_memory_room_id_required");
      return workspaceInputRequest<WorkspaceKnowledgeMemoryPage>(input, "GET", `/knowledge-memory/${encodeURIComponent(input.memoryId)}?room_id=${encodeURIComponent(roomId)}`);
    },
    searchWorkspaceKnowledgeMemory: (input) => workspaceInputRequest(input, "GET", `/knowledge-memory/search?room_id=${encodeURIComponent(input.roomId)}&q=${encodeURIComponent(input.query)}${input.limit === undefined ? "" : `&limit=${input.limit}`}`),
    archiveWorkspaceKnowledgeMemory: (input) => {
      const roomId = input.target?.roomId ?? currentActiveWorkspaceRoomId();
      if (!roomId) throw new Error("knowledge_memory_room_id_required");
      return workspaceInputRequest(input, "POST", `/knowledge-memory/${encodeURIComponent(input.memoryId)}/archive?room_id=${encodeURIComponent(roomId)}`, { reason: input.reason }, input.operationId);
    },
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

async function searchBrowserWorkspaceContext(input: WorkspaceContextSearchInput): Promise<WorkspaceContextSearchPage> {
  const normalized = normalizeWorkspaceContextSearchInput(input);
  const snapshot = await captureBrowserWorkspaceSnapshot(browserTargetFromInput(input));
  const response = await browserSnapshotDomainApiClient(snapshot).executeQuery<unknown>(snapshot.workspaceId, "workspace.search", {
    context: {},
    input: normalized
  });
  await assertBrowserWorkspaceSnapshot(snapshot);
  return sanitizeBrowserWorkspaceContextSearchResponse(response.result);
}

async function listBrowserWorkspaceNotifications(input: WorkspaceNotificationListInput): Promise<WorkspaceNotificationPage> {
  const normalized = normalizeWorkspaceNotificationListInput(input);
  const snapshot = await captureBrowserWorkspaceSnapshot(browserTargetFromInput(input));
  const response = await browserSnapshotDomainApiClient(snapshot).executeQuery<unknown>(snapshot.workspaceId, "notification.list", {
    context: {},
    input: normalized
  });
  await assertBrowserWorkspaceSnapshot(snapshot);
  return sanitizeBrowserNotificationPageResponse(response.result, false);
}

async function getBrowserWorkspaceNotificationSummary(input: { target?: DesktopWorkspaceTarget }): Promise<WorkspaceNotificationSummary> {
  const snapshot = await captureBrowserWorkspaceSnapshot(browserTargetFromInput(input));
  const response = await browserSnapshotDomainApiClient(snapshot).executeQuery<unknown>(snapshot.workspaceId, "notification.summary", {
    context: {},
    input: {}
  });
  await assertBrowserWorkspaceSnapshot(snapshot);
  return sanitizeBrowserNotificationSummaryResponse(response.result);
}

async function markBrowserWorkspaceNotificationsRead(input: { notificationIds: string[]; operationId: string; target?: DesktopWorkspaceTarget }): Promise<WorkspaceNotificationMarkReadResult> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("workspace_notification_mark_read_input_invalid");
  const notificationIds = normalizeBrowserNotificationIds(input.notificationIds);
  const operationId = requirePublicId(input.operationId, "operationId");
  const snapshot = await captureBrowserWorkspaceSnapshot(browserTargetFromInput(input));
  const response = await browserSnapshotDomainApiClient(snapshot).executeOperation<unknown>(snapshot.workspaceId, "notification.mark_read", {
    context: {},
    input: { notification_ids: notificationIds }
  }, { operationId, idempotencyKey: operationId });
  await assertBrowserWorkspaceSnapshot(snapshot);
  return sanitizeBrowserNotificationMarkReadResponse(response.result, notificationIds);
}

async function getBrowserAccountWorkspaceNotificationSummaries(input: AccountWorkspaceNotificationSummariesInput): Promise<AccountWorkspaceNotificationSummaries> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("account_workspace_notification_summary_input_invalid");
  const workspaceIds = normalizeBrowserWorkspaceIds(input.workspaceIds);
  const snapshot = await captureBrowserWorkspaceSnapshot(browserTargetFromInput(input));
  const response = await browserSnapshotAccountDomainApiClient(snapshot).executeAccountQuery<unknown>("account.workspace_notification_summaries", {
    context: {},
    input: { workspace_ids: workspaceIds }
  });
  await assertBrowserWorkspaceSnapshot(snapshot);
  return sanitizeBrowserAccountWorkspaceNotificationSummariesResponse(response.result, workspaceIds);
}

async function listBrowserAccountInvitationNotifications(input: AccountInvitationNotificationListInput): Promise<WorkspaceNotificationPage> {
  const normalized = normalizeBrowserAccountInvitationListInput(input);
  const snapshot = await captureBrowserWorkspaceSnapshot(browserTargetFromInput(input));
  const response = await browserSnapshotAccountDomainApiClient(snapshot).executeAccountQuery<unknown>("account.invitation_notifications", {
    context: {},
    input: normalized
  });
  await assertBrowserWorkspaceSnapshot(snapshot);
  return sanitizeBrowserNotificationPageResponse(response.result, true);
}

async function markBrowserAccountInvitationNotificationsRead(input: { notificationIds: string[]; operationId: string; target?: DesktopWorkspaceTarget }): Promise<WorkspaceNotificationMarkReadResult> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("account_invitation_notification_read_input_invalid");
  const notificationIds = normalizeBrowserNotificationIds(input.notificationIds);
  const operationId = requirePublicId(input.operationId, "operationId");
  const snapshot = await captureBrowserWorkspaceSnapshot(browserTargetFromInput(input));
  const response = await browserSnapshotAccountDomainApiClient(snapshot).executeAccountOperation<unknown>("account.invitation_notification_read", {
    context: {},
    input: { notification_ids: notificationIds }
  }, { operationId, idempotencyKey: operationId });
  await assertBrowserWorkspaceSnapshot(snapshot);
  return sanitizeBrowserNotificationMarkReadResponse(response.result, notificationIds);
}

async function createBrowserWorkspaceShareDraft(input: WorkspaceShareDraftCreateInput): Promise<WorkspaceShareDraft> {
  const operationId = requireWorkspaceShareOperationId(input, ["sourceKind", "sourceId", "resourceRefs", "baseShareId", "operationId", "target"]);
  const normalized = normalizeWorkspaceShareDraftCreateInput(input);
  const snapshot = await captureBrowserWorkspaceSnapshot(browserShareTargetFromInput(input));
  const response = await browserSnapshotDomainApiClient(snapshot).createShareDraft(snapshot.workspaceId, normalized, {
    operationId,
    idempotencyKey: operationId
  });
  await assertBrowserWorkspaceSnapshot(snapshot);
  return sanitizeBrowserWorkspaceShareDraftResponse(response.result);
}

async function viewBrowserWorkspaceShareDraft(input: WorkspaceShareDraftViewInput): Promise<WorkspaceShareDraft> {
  const normalized = normalizeWorkspaceShareDraftViewInput(input);
  const snapshot = await captureBrowserWorkspaceSnapshot(browserShareTargetFromInput(input));
  const response = await browserSnapshotDomainApiClient(snapshot).viewShareDraft(snapshot.workspaceId, normalized);
  await assertBrowserWorkspaceSnapshot(snapshot);
  return sanitizeBrowserWorkspaceShareDraftResponse(response.result);
}

async function updateBrowserWorkspaceShareDraft(input: WorkspaceShareDraftUpdateInput): Promise<WorkspaceShareDraft> {
  const operationId = requireWorkspaceShareOperationId(input, ["draftId", "expectedVersion", "manifest", "visibility", "recipientAccountIds", "operationId", "target"]);
  const normalized = normalizeWorkspaceShareDraftUpdateInput(input);
  const snapshot = await captureBrowserWorkspaceSnapshot(browserShareTargetFromInput(input));
  const response = await browserSnapshotDomainApiClient(snapshot).updateShareDraft(snapshot.workspaceId, normalized, {
    operationId,
    idempotencyKey: operationId
  });
  await assertBrowserWorkspaceSnapshot(snapshot);
  return sanitizeBrowserWorkspaceShareDraftResponse(response.result);
}

async function discardBrowserWorkspaceShareDraft(input: WorkspaceShareDraftDiscardInput): Promise<WorkspaceShareDraftDiscardResult> {
  const operationId = requireWorkspaceShareOperationId(input, ["draftId", "expectedVersion", "operationId", "target"]);
  const normalized = normalizeWorkspaceShareDraftDiscardInput(input);
  const snapshot = await captureBrowserWorkspaceSnapshot(browserShareTargetFromInput(input));
  const response = await browserSnapshotDomainApiClient(snapshot).discardShareDraft(snapshot.workspaceId, normalized, {
    operationId,
    idempotencyKey: operationId
  });
  await assertBrowserWorkspaceSnapshot(snapshot);
  return sanitizeBrowserWorkspaceShareDiscardResponse(response.result);
}

async function listBrowserWorkspaceShares(input: WorkspaceShareListInput): Promise<WorkspaceSharePage> {
  const normalized = normalizeWorkspaceShareListInput(input);
  const snapshot = await captureBrowserWorkspaceSnapshot(browserShareTargetFromInput(input));
  const response = await browserSnapshotDomainApiClient(snapshot).listShares(snapshot.workspaceId, normalized);
  await assertBrowserWorkspaceSnapshot(snapshot);
  return sanitizeBrowserWorkspaceSharePageResponse(response.result);
}

async function publishBrowserWorkspaceShare(input: WorkspaceSharePublishInput): Promise<WorkspaceSharePublishResult> {
  const operationId = requireWorkspaceShareOperationId(input, ["draftId", "expectedVersion", "expectedContentHash", "operationId", "target"]);
  const normalized = normalizeWorkspaceSharePublishInput(input);
  const snapshot = await captureBrowserWorkspaceSnapshot(browserShareTargetFromInput(input));
  const response = await browserSnapshotDomainApiClient(snapshot).publishShare(snapshot.workspaceId, normalized, {
    operationId,
    idempotencyKey: operationId
  });
  await assertBrowserWorkspaceSnapshot(snapshot);
  return sanitizeBrowserWorkspaceSharePublishResponse(response.result);
}

async function revokeBrowserWorkspaceShare(input: WorkspaceShareRevokeInput): Promise<WorkspaceShareRevokeResult> {
  const operationId = requireWorkspaceShareOperationId(input, ["shareId", "expectedVersion", "operationId", "target"]);
  const normalized = normalizeWorkspaceShareRevokeInput(input);
  const snapshot = await captureBrowserWorkspaceSnapshot(browserShareTargetFromInput(input));
  const response = await browserSnapshotDomainApiClient(snapshot).revokeShare(snapshot.workspaceId, normalized, {
    operationId,
    idempotencyKey: operationId
  });
  await assertBrowserWorkspaceSnapshot(snapshot);
  return sanitizeBrowserWorkspaceShareRevokeResponse(response.result);
}

async function importBrowserWorkspaceShare(input: WorkspaceShareImportInput): Promise<WorkspaceShareImportResult> {
  const operationId = requireWorkspaceShareOperationId(input, ["sourceOrigin", "locator", "claimId", "contentHash", "delegation", "targetRoomId", "operationId", "target"]);
  const normalized = normalizeWorkspaceShareImportInput(input);
  const snapshot = await captureBrowserWorkspaceSnapshot(browserShareTargetFromInput(input));
  await assertBrowserWorkspaceShareDelegationTarget(snapshot, normalized, operationId);
  const response = await browserSnapshotDomainApiClient(snapshot).importShare(snapshot.workspaceId, normalized, {
    operationId,
    idempotencyKey: operationId
  });
  await assertBrowserWorkspaceSnapshot(snapshot);
  return sanitizeBrowserWorkspaceShareImportResponse(response.result);
}

async function getBrowserWorkspaceShareImportStatus(input: WorkspaceShareImportStatusInput): Promise<WorkspaceShareImportResult> {
  const normalized = normalizeWorkspaceShareImportStatusInput(input);
  const snapshot = await captureBrowserWorkspaceSnapshot(browserShareTargetFromInput(input));
  const response = await browserSnapshotDomainApiClient(snapshot).getShareImportStatus(snapshot.workspaceId, normalized);
  await assertBrowserWorkspaceSnapshot(snapshot);
  return sanitizeBrowserWorkspaceShareImportResponse(response.result);
}

async function viewBrowserWorkspaceShareLink(input: WorkspaceShareLinkViewInput): Promise<WorkspaceShareLinkView> {
  const normalized = normalizeBrowserWorkspaceShareLinkViewInput(input);
  const snapshot = await captureBrowserWorkspaceSnapshot(normalized.target);
  const response = await browserShareSourceRequest({
    connectionId: snapshot.id,
    operation: "view",
    sourceOrigin: normalized.sourceOrigin,
    locator: normalized.locator
  });
  await assertBrowserWorkspaceSnapshot(snapshot);
  if (response.status !== 200) throw new Error(`workspace_share_source_response_invalid:${response.status}`);
  return sanitizeBrowserWorkspaceShareLinkViewResponse(response.body, normalized);
}

async function importBrowserWorkspaceShareLink(input: WorkspaceShareLinkImportInput): Promise<WorkspaceShareImportResult> {
  const normalized = normalizeBrowserWorkspaceShareLinkImportInput(input);
  const snapshot = await captureBrowserWorkspaceSnapshot(normalized.target);
  await assertBrowserWorkspaceSnapshot(snapshot);
  if (normalized.targetRoomId !== undefined && snapshot.roomId !== normalized.targetRoomId) {
    throw new Error("room_navigation_changed");
  }

  const viewResponse = await browserShareSourceRequest({
    connectionId: snapshot.id,
    operation: "view",
    sourceOrigin: normalized.sourceOrigin,
    locator: normalized.locator
  });
  await assertBrowserWorkspaceSnapshot(snapshot);
  if (viewResponse.status !== 200) throw new Error(`workspace_share_source_response_invalid:${viewResponse.status}`);
  const view = sanitizeBrowserWorkspaceShareLinkViewResponse(viewResponse.body, normalized);

  // Re-capture the complete target after reading the public source and again
  // before the Account-authenticated claim.  The claim must never be sent for
  // a Room/Workspace/connection/selection generation that changed while the
  // source view was in flight.
  const claimSnapshot = await captureBrowserWorkspaceSnapshot(normalized.target);
  await assertBrowserWorkspaceSnapshot(claimSnapshot);
  if (!sameBrowserWorkspaceSnapshot(snapshot, claimSnapshot)) {
    throw new Error("workspace_navigation_changed");
  }
  const claimConnection = await requireBrowserWorkspaceConnection(claimSnapshot.id);
  await assertBrowserWorkspaceSnapshot(claimSnapshot);
  const claimTargetOrigin = `${new URL(claimConnection.serverUrl).origin}/`;
  if (normalized.targetRoomId !== undefined && claimSnapshot.roomId !== normalized.targetRoomId) {
    throw new Error("room_navigation_changed");
  }
  await assertBrowserWorkspaceSnapshot(claimSnapshot);

  const claimResponse = await browserShareSourceRequest({
    connectionId: claimSnapshot.id,
    operation: "claim",
    sourceOrigin: normalized.sourceOrigin,
    locator: normalized.locator,
    operationId: normalized.operationId,
    body: {
      target_origin: claimTargetOrigin,
      target_workspace_id: claimSnapshot.workspaceId,
      operation_id: normalized.operationId,
      content_hash: view.contentHash
    }
  });
  await assertBrowserWorkspaceSnapshot(claimSnapshot);
  if (claimResponse.status !== 200 && claimResponse.status !== 201) throw new Error(`workspace_share_claim_response_invalid:${claimResponse.status}`);
  const claim = sanitizeBrowserWorkspaceShareLinkClaimResponse(claimResponse.body);
  if (claim.recipientAccountId !== claimConnection.accountId
    || claim.targetOrigin !== claimTargetOrigin
    || claim.targetWorkspaceId !== claimSnapshot.workspaceId
    || claim.operationId !== normalized.operationId
    || claim.contentHash !== view.contentHash) {
    throw new Error("workspace_share_claim_scope_invalid");
  }

  const issuedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 4 * 60_000).toISOString();
  const delegation = await createBrowserShareDelegation(claimSnapshot.id, {
    version: 1,
    source_origin: normalized.sourceOrigin,
    share_id: claim.shareId,
    claim_id: claim.claimId,
    recipient_account_id: claimConnection.accountId,
    target_origin: claimTargetOrigin,
    target_workspace_id: claimSnapshot.workspaceId,
    operation_id: normalized.operationId,
    content_hash: view.contentHash,
    issued_at: issuedAt,
    expires_at: expiresAt
  });
  await assertBrowserWorkspaceSnapshot(claimSnapshot);
  return importBrowserWorkspaceShare({
    sourceOrigin: normalized.sourceOrigin,
    locator: normalized.locator,
    claimId: claim.claimId,
    contentHash: view.contentHash,
    delegation: {
      payload: {
        version: delegation.payload.version,
        sourceOrigin: delegation.payload.source_origin,
        shareId: delegation.payload.share_id,
        claimId: delegation.payload.claim_id,
        recipientAccountId: delegation.payload.recipient_account_id,
        targetOrigin: delegation.payload.target_origin,
        targetWorkspaceId: delegation.payload.target_workspace_id,
        operationId: delegation.payload.operation_id,
        contentHash: delegation.payload.content_hash,
        issuedAt: delegation.payload.issued_at,
        expiresAt: delegation.payload.expires_at
      },
      publicKey: delegation.publicKey,
      signature: delegation.signature
    },
    ...(normalized.targetRoomId === undefined ? {} : { targetRoomId: normalized.targetRoomId }),
    operationId: normalized.operationId,
    ...(normalized.target === undefined ? {} : { target: normalized.target })
  });
}

function normalizeBrowserWorkspaceShareLinkViewInput(input: WorkspaceShareLinkViewInput): {
  sourceUrl: string;
  sourceOrigin: string;
  locator: string;
  target?: BrowserWorkspaceTargetRef;
} {
  const record = browserShareInputRecord(input, ["sourceUrl", "target"], "workspace_share_link_input_invalid");
  const source = normalizeBrowserWorkspaceShareSourceUrl(record.sourceUrl);
  const target = browserShareTargetFromInput(input);
  return { ...source, ...(target ? { target } : {}) };
}

function normalizeBrowserWorkspaceShareLinkImportInput(input: WorkspaceShareLinkImportInput): {
  sourceUrl: string;
  sourceOrigin: string;
  locator: string;
  targetRoomId?: string;
  operationId: string;
  target?: BrowserWorkspaceTargetRef;
} {
  const record = browserShareInputRecord(input, ["sourceUrl", "targetRoomId", "operationId", "target"], "workspace_share_link_import_input_invalid");
  const source = normalizeBrowserWorkspaceShareSourceUrl(record.sourceUrl);
  const operationId = requirePublicId(record.operationId, "workspace_share_operation_id");
  const targetRoomId = record.targetRoomId === undefined ? undefined : requirePublicId(record.targetRoomId, "workspace_share_target_room_id");
  const target = browserShareTargetFromInput(input);
  return { ...source, ...(targetRoomId === undefined ? {} : { targetRoomId }), operationId, ...(target ? { target } : {}) };
}

function browserShareInputRecord(input: unknown, allowedKeys: readonly string[], errorCode: string): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error(errorCode);
  const record = input as Record<string, unknown>;
  if (Object.keys(record).some((key) => !allowedKeys.includes(key)) || "workspaceId" in record || "accountId" in record || "connectionId" in record) {
    throw new Error(errorCode);
  }
  return record;
}

function normalizeBrowserWorkspaceShareSourceUrl(value: unknown): { sourceUrl: string; sourceOrigin: string; locator: string } {
  if (typeof value !== "string" || !value || value.length > 4_096) throw new Error("workspace_share_link_source_invalid");
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("workspace_share_link_source_invalid");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash || value.includes("?") || value.includes("#")) {
    throw new Error("workspace_share_link_source_scope_invalid");
  }
  const locator = /^\/s\/([A-Za-z0-9_-]{43})$/.exec(parsed.pathname)?.[1];
  if (!locator) throw new Error("workspace_share_link_locator_invalid");
  return { sourceUrl: parsed.toString(), sourceOrigin: new URL("/", parsed.origin).toString(), locator };
}

function browserShareTargetFromInput(input: unknown): BrowserWorkspaceTargetRef | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("workspace_share_input_invalid");
  const record = input as Record<string, unknown>;
  const target = record.target;
  if (target !== undefined) {
    if (!target || typeof target !== "object" || Array.isArray(target)) throw new Error("workspace_share_target_invalid");
    const targetRecord = target as Record<string, unknown>;
    const allowed = new Set(["connectionId", "workspaceId", "roomId", "selectionGeneration"]);
    if (Object.keys(targetRecord).some((key) => !allowed.has(key))) throw new Error("workspace_share_target_invalid");
  }
  if ("workspaceId" in record || "accountId" in record || "connectionId" in record) {
    throw new Error("workspace_share_target_must_be_selected");
  }
  return browserTargetFromInput(input);
}

function requireWorkspaceShareOperationId(input: unknown, allowed: readonly string[]): string {
  const record = workspaceShareInputRecord(input, allowed, "workspace_share_input_invalid");
  return requirePublicId(record.operationId, "share_operation_id");
}

function workspaceShareInputRecord(value: unknown, allowedKeys: readonly string[], error: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(error);
  const record = value as Record<string, unknown>;
  const allowed = new Set(allowedKeys);
  if (Object.keys(record).some((key) => !allowed.has(key))) throw new Error(error);
  return record;
}

function normalizeWorkspaceShareDraftCreateInput(input: WorkspaceShareDraftCreateInput): import("@samurai-agent/domain-api").PublicShareDraftCreateInput {
  const record = workspaceShareInputRecord(input, ["sourceKind", "sourceId", "resourceRefs", "baseShareId", "operationId", "target"], "workspace_share_draft_create_input_invalid");
  const hasBase = Object.prototype.hasOwnProperty.call(record, "baseShareId");
  const hasSource = Object.prototype.hasOwnProperty.call(record, "sourceKind")
    || Object.prototype.hasOwnProperty.call(record, "sourceId")
    || Object.prototype.hasOwnProperty.call(record, "resourceRefs");
  if (hasBase === hasSource) throw new Error("workspace_share_draft_create_input_invalid");
  const body = hasBase
    ? { base_share_id: requirePublicId(record.baseShareId, "share_base_id") }
    : {
      source_kind: normalizeWorkspaceShareKind(record.sourceKind),
      source_id: requirePublicId(record.sourceId, "share_source_id"),
      resource_refs: normalizeWorkspaceShareResourceRefs(record.resourceRefs)
    };
  const parsed = PublicShareDraftCreateInputSchema.safeParse(body);
  if (!parsed.success) throw new Error("workspace_share_draft_create_input_invalid");
  return parsed.data;
}

function normalizeWorkspaceShareDraftViewInput(input: WorkspaceShareDraftViewInput): import("@samurai-agent/domain-api").PublicShareDraftViewInput {
  const record = workspaceShareInputRecord(input, ["draftId", "target"], "workspace_share_draft_view_input_invalid");
  const parsed = PublicShareDraftViewInputSchema.safeParse({ draft_id: requirePublicId(record.draftId, "share_draft_id") });
  if (!parsed.success) throw new Error("workspace_share_draft_view_input_invalid");
  return parsed.data;
}

function normalizeWorkspaceShareDraftUpdateInput(input: WorkspaceShareDraftUpdateInput): import("@samurai-agent/domain-api").PublicShareDraftUpdateInput {
  const record = workspaceShareInputRecord(input, ["draftId", "expectedVersion", "manifest", "visibility", "recipientAccountIds", "operationId", "target"], "workspace_share_draft_update_input_invalid");
  const parsed = PublicShareDraftUpdateInputSchema.safeParse({
    draft_id: requirePublicId(record.draftId, "share_draft_id"),
    expected_version: normalizeWorkspaceShareVersion(record.expectedVersion, "share_expected_version"),
    manifest: normalizeWorkspaceShareManifestInput(record.manifest),
    visibility: normalizeWorkspaceShareVisibility(record.visibility),
    recipient_account_ids: normalizeWorkspaceShareRecipients(record.recipientAccountIds)
  });
  if (!parsed.success) throw new Error("workspace_share_draft_update_input_invalid");
  return parsed.data;
}

function normalizeWorkspaceShareDraftDiscardInput(input: WorkspaceShareDraftDiscardInput): import("@samurai-agent/domain-api").PublicShareDraftDiscardInput {
  const record = workspaceShareInputRecord(input, ["draftId", "expectedVersion", "operationId", "target"], "workspace_share_draft_discard_input_invalid");
  const parsed = PublicShareDraftDiscardInputSchema.safeParse({
    draft_id: requirePublicId(record.draftId, "share_draft_id"),
    expected_version: normalizeWorkspaceShareVersion(record.expectedVersion, "share_expected_version")
  });
  if (!parsed.success) throw new Error("workspace_share_draft_discard_input_invalid");
  return parsed.data;
}

function normalizeWorkspaceShareVisibility(value: unknown): "restricted" | "public" {
  const parsed = PublicShareVisibilitySchema.safeParse(value);
  if (!parsed.success) throw new Error("workspace_share_visibility_invalid");
  return parsed.data;
}

function normalizeWorkspaceShareRecipients(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 1_000) throw new Error("workspace_share_recipient_ids_invalid");
  const recipients = value.map((item) => requirePublicId(item, "workspace_share_recipient_id_invalid"));
  if (new Set(recipients).size !== recipients.length) throw new Error("workspace_share_recipient_ids_invalid");
  return recipients;
}

function normalizeWorkspaceShareManifestInput(value: unknown): import("@samurai-agent/domain-api").PublicShareManifest {
  const record = workspaceShareInputRecord(value, ["formatVersion", "kind", "title", "entries", "agent"], "workspace_share_manifest_input_invalid");
  const entries = Array.isArray(record.entries)
    ? record.entries.map((entry, index) => {
      const item = workspaceShareInputRecord(entry, ["entryId", "kind", "title", "content", "knowledgeKind", "files"], `workspace_share_manifest_entry_${index}_invalid`);
      const files = item.files === undefined ? [] : Array.isArray(item.files)
        ? item.files.map((file, fileIndex) => {
          const fileRecord = workspaceShareInputRecord(file, ["path", "encoding", "content", "byteSize", "sha256"], `workspace_share_manifest_file_${index}_${fileIndex}_invalid`);
          return {
            path: fileRecord.path,
            encoding: fileRecord.encoding,
            content: fileRecord.content,
            byte_size: fileRecord.byteSize,
            sha256: fileRecord.sha256
          };
        })
        : (() => { throw new Error("workspace_share_manifest_files_invalid"); })();
      return {
        entry_id: requirePublicId(item.entryId, "workspace_share_manifest_entry_id_invalid"),
        kind: item.kind,
        title: item.title,
        content: item.content,
        ...(item.knowledgeKind === undefined ? {} : { knowledge_kind: item.knowledgeKind }),
        files
      };
    })
    : (() => { throw new Error("workspace_share_manifest_entries_invalid"); })();
  const agent = record.agent === undefined ? undefined : (() => {
    const agent = workspaceShareInputRecord(record.agent, ["name", "role", "instructions"], "workspace_share_manifest_agent_invalid");
    return {
      name: agent.name,
      role: agent.role,
      instructions: agent.instructions
    };
  })();
  const parsed = PublicShareManifestSchema.safeParse({
    format_version: record.formatVersion,
    kind: record.kind,
    title: record.title,
    entries,
    ...(agent === undefined ? {} : { agent })
  });
  if (!parsed.success) throw new Error("workspace_share_manifest_input_invalid");
  return parsed.data;
}

function normalizeWorkspaceShareListInput(input: WorkspaceShareListInput): import("@samurai-agent/domain-api").PublicShareListInput {
  const record = workspaceShareInputRecord(input, ["sourceKind", "sourceId", "limit", "cursor", "target"], "workspace_share_list_input_invalid");
  const page = normalizeBrowserPageInput(record.limit, record.cursor, "workspace_share_list");
  const parsed = PublicShareListInputSchema.safeParse({
    source_kind: normalizeWorkspaceShareKind(record.sourceKind),
    source_id: requirePublicId(record.sourceId, "share_source_id"),
    ...(page.limit === undefined ? {} : { limit: page.limit }),
    ...(page.cursor === undefined ? {} : { cursor: page.cursor })
  });
  if (!parsed.success) throw new Error("workspace_share_list_input_invalid");
  return parsed.data;
}

function normalizeWorkspaceSharePublishInput(input: WorkspaceSharePublishInput): import("@samurai-agent/domain-api").PublicSharePublishInput {
  const record = workspaceShareInputRecord(input, ["draftId", "expectedVersion", "expectedContentHash", "operationId", "target"], "workspace_share_publish_input_invalid");
  const parsed = PublicSharePublishInputSchema.safeParse({
    draft_id: requirePublicId(record.draftId, "share_draft_id"),
    expected_version: normalizeWorkspaceShareVersion(record.expectedVersion, "share_expected_version"),
    expected_content_hash: normalizeWorkspaceShareHash(record.expectedContentHash, "share_expected_content_hash")
  });
  if (!parsed.success) throw new Error("workspace_share_publish_input_invalid");
  return parsed.data;
}

function normalizeWorkspaceShareRevokeInput(input: WorkspaceShareRevokeInput): import("@samurai-agent/domain-api").PublicShareRevokeInput {
  const record = workspaceShareInputRecord(input, ["shareId", "expectedVersion", "operationId", "target"], "workspace_share_revoke_input_invalid");
  const parsed = PublicShareRevokeInputSchema.safeParse({
    share_id: requirePublicId(record.shareId, "share_id"),
    expected_version: normalizeWorkspaceShareVersion(record.expectedVersion, "share_expected_version")
  });
  if (!parsed.success) throw new Error("workspace_share_revoke_input_invalid");
  return parsed.data;
}

function normalizeWorkspaceShareImportInput(input: WorkspaceShareImportInput): import("@samurai-agent/domain-api").PublicShareImportInput {
  const record = workspaceShareInputRecord(input, ["sourceOrigin", "locator", "claimId", "contentHash", "delegation", "targetRoomId", "operationId", "target"], "workspace_share_import_input_invalid");
  const sourceOrigin = normalizeWorkspaceShareOrigin(record.sourceOrigin, "share_source_origin");
  const locator = normalizeWorkspaceShareLocator(record.locator, "share_locator");
  const claimId = requirePublicId(record.claimId, "share_claim_id");
  const contentHash = normalizeWorkspaceShareHash(record.contentHash, "share_content_hash");
  const delegation = normalizeWorkspaceShareDelegation(record.delegation);
  const targetRoomId = record.targetRoomId === undefined ? undefined : requirePublicId(record.targetRoomId, "share_target_room_id");
  const parsed = PublicShareImportInputSchema.safeParse({
    source_origin: sourceOrigin,
    locator,
    claim_id: claimId,
    content_hash: contentHash,
    delegation,
    ...(targetRoomId === undefined ? {} : { target_room_id: targetRoomId })
  });
  if (!parsed.success) throw new Error("workspace_share_import_input_invalid");
  return parsed.data;
}

function normalizeWorkspaceShareImportStatusInput(input: WorkspaceShareImportStatusInput): import("@samurai-agent/domain-api").PublicShareImportStatusInput {
  const record = workspaceShareInputRecord(input, ["operationId", "target"], "workspace_share_import_status_input_invalid");
  const parsed = PublicShareImportStatusInputSchema.safeParse({ operation_id: requirePublicId(record.operationId, "share_operation_id") });
  if (!parsed.success) throw new Error("workspace_share_import_status_input_invalid");
  return parsed.data;
}

function normalizeWorkspaceShareResourceRefs(value: unknown): import("@samurai-agent/domain-api").PublicShareResourceRef[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 1_000) throw new Error("workspace_share_resource_refs_invalid");
  const refs = value.map((item, index) => {
    const record = workspaceShareInputRecord(item, ["id", "version"], `workspace_share_resource_ref_${index}_invalid`);
    return {
      id: requirePublicId(record.id, `share_resource_ref_${index}_id`),
      version: normalizeWorkspaceShareVersion(record.version, `share_resource_ref_${index}_version`)
    };
  });
  if (new Set(refs.map((ref) => ref.id)).size !== refs.length) throw new Error("workspace_share_resource_refs_invalid");
  return refs;
}

function normalizeWorkspaceShareDelegation(value: unknown): import("@samurai-agent/domain-api").PublicShareDelegation {
  const record = workspaceShareInputRecord(value, ["payload", "publicKey", "signature"], "workspace_share_delegation_invalid");
  const payload = workspaceShareInputRecord(record.payload, ["version", "sourceOrigin", "shareId", "claimId", "recipientAccountId", "targetOrigin", "targetWorkspaceId", "operationId", "contentHash", "issuedAt", "expiresAt"], "workspace_share_delegation_payload_invalid");
  const candidate = {
    payload: {
      version: payload.version,
      source_origin: normalizeWorkspaceShareOrigin(payload.sourceOrigin, "share_delegation_source_origin"),
      share_id: requirePublicId(payload.shareId, "share_delegation_share_id"),
      claim_id: requirePublicId(payload.claimId, "share_delegation_claim_id"),
      recipient_account_id: requirePublicId(payload.recipientAccountId, "share_delegation_recipient_account_id"),
      target_origin: normalizeWorkspaceShareOrigin(payload.targetOrigin, "share_delegation_target_origin"),
      target_workspace_id: requirePublicId(payload.targetWorkspaceId, "share_delegation_workspace_id"),
      operation_id: requirePublicId(payload.operationId, "share_delegation_operation_id"),
      content_hash: normalizeWorkspaceShareHash(payload.contentHash, "share_delegation_content_hash"),
      issued_at: payload.issuedAt,
      expires_at: payload.expiresAt
    },
    public_key: requireWorkspaceShareBlob(record.publicKey, "share_delegation_public_key"),
    signature: requireWorkspaceShareBlob(record.signature, "share_delegation_signature")
  };
  const parsed = PublicShareDelegationSchema.safeParse(candidate);
  if (!parsed.success) throw new Error("workspace_share_delegation_invalid");
  return parsed.data;
}

async function assertBrowserWorkspaceShareDelegationTarget(
  snapshot: BrowserWorkspaceSnapshot,
  input: import("@samurai-agent/domain-api").PublicShareImportInput,
  operationId: string
): Promise<void> {
  const connection = await requireBrowserWorkspaceConnection();
  if (connection.id !== snapshot.id || connection.workspaceId !== snapshot.workspaceId) throw new Error("workspace_navigation_changed");
  let targetOrigin: string;
  try {
    targetOrigin = `${new URL(connection.serverUrl).origin}/`;
  } catch {
    throw new Error("workspace_share_target_origin_invalid");
  }
  const delegation = input.delegation.payload;
  if (delegation.source_origin !== input.source_origin
    || delegation.claim_id !== input.claim_id
    || delegation.content_hash !== input.content_hash
    || delegation.operation_id !== operationId
    || delegation.target_workspace_id !== snapshot.workspaceId
    || delegation.target_origin !== targetOrigin
    || delegation.recipient_account_id !== connection.accountId
    || (snapshot.roomId !== undefined && input.target_room_id !== undefined && input.target_room_id !== snapshot.roomId)) {
    throw new Error("workspace_share_delegation_target_invalid");
  }
}

function normalizeWorkspaceShareKind(value: unknown): "room_knowledge" | "agent" {
  if (value !== "room_knowledge" && value !== "agent") throw new Error("share_kind_invalid");
  return value;
}

function normalizeWorkspaceShareVersion(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new Error(`${field}_invalid`);
  return value;
}

function normalizeWorkspaceShareHash(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`${field}_invalid`);
  return value;
}

function normalizeWorkspaceShareOrigin(value: unknown, field: string): string {
  const parsed = PublicShareOriginSchema.safeParse(value);
  if (!parsed.success) throw new Error(`${field}_invalid`);
  return parsed.data;
}

function normalizeWorkspaceShareLocator(value: unknown, field: string): string {
  const parsed = PublicShareLocatorSchema.safeParse(value);
  if (!parsed.success) throw new Error(`${field}_invalid`);
  return parsed.data;
}

function requireWorkspaceShareBlob(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 8_192) throw new Error(`${field}_invalid`);
  return value;
}

function sanitizeBrowserWorkspaceShareDraftResponse(value: unknown): WorkspaceShareDraft {
  const parsed = PublicShareDraftSchema.safeParse(value);
  if (!parsed.success) throw new Error("workspace_share_draft_response_invalid");
  return {
    draftId: requirePublicId(parsed.data.draft_id, "share_draft_id"),
    version: normalizeWorkspaceShareVersion(parsed.data.version, "share_draft_version"),
    manifest: sanitizeBrowserWorkspaceShareManifest(parsed.data.manifest),
    contentHash: normalizeWorkspaceShareHash(parsed.data.content_hash, "share_content_hash"),
    visibility: parsed.data.visibility,
    recipientCount: parsed.data.recipient_account_ids.length,
    removedReferenceCount: parsed.data.removed_references.length
  };
}

function sanitizeBrowserWorkspaceShareDiscardResponse(value: unknown): WorkspaceShareDraftDiscardResult {
  const parsed = PublicShareDraftDiscardResultSchema.safeParse(value);
  if (!parsed.success) throw new Error("workspace_share_draft_discard_response_invalid");
  return { draftId: requirePublicId(parsed.data.draft_id, "share_draft_id"), discarded: true };
}

function sanitizeBrowserWorkspaceShareManifest(value: import("@samurai-agent/domain-api").PublicShareManifest): import("./api").WorkspaceShareManifest {
  return {
    formatVersion: 1,
    kind: value.kind,
    title: value.title,
    entries: value.entries.map((entry) => ({
      entryId: requirePublicId(entry.entry_id, "share_manifest_entry_id"),
      kind: entry.kind,
      title: entry.title,
      content: entry.content,
      ...(entry.knowledge_kind === undefined ? {} : { knowledgeKind: entry.knowledge_kind }),
      files: entry.files.map((file) => ({
        path: file.path,
        encoding: file.encoding,
        content: file.content,
        byteSize: file.byte_size,
        sha256: normalizeWorkspaceShareHash(file.sha256, "share_manifest_file_hash")
      }))
    })),
    ...(value.agent === undefined ? {} : { agent: value.agent })
  };
}

function sanitizeBrowserWorkspaceSharePageResponse(value: unknown): WorkspaceSharePage {
  const parsed = PublicSharePageSchema.safeParse(value);
  if (!parsed.success) throw new Error("workspace_share_list_response_invalid");
  return {
    items: parsed.data.items.map((item) => sanitizeBrowserWorkspaceShareSummary(item)),
    nextCursor: parsed.data.next_cursor
  };
}

function sanitizeBrowserWorkspaceShareSummary(value: import("@samurai-agent/domain-api").PublicShareSummary): import("./api").WorkspaceShareSummary {
  if (value.url !== null) sanitizeWorkspaceShareUrl(value.url, "share_summary_url");
  return {
    shareId: requirePublicId(value.share_id, "share_id"),
    version: normalizeWorkspaceShareVersion(value.version, "share_version"),
    title: value.title,
    status: value.status,
    visibility: value.visibility,
    recipientCount: value.recipient_account_ids.length,
    createdAt: value.created_at,
    publishedAt: value.published_at,
    revokedAt: value.revoked_at
  };
}

function sanitizeBrowserWorkspaceSharePublishResponse(value: unknown): WorkspaceSharePublishResult {
  const parsed = PublicSharePublishResultSchema.safeParse(value);
  if (!parsed.success) throw new Error("workspace_share_publish_response_invalid");
  return {
    shareId: requirePublicId(parsed.data.share_id, "share_id"),
    version: normalizeWorkspaceShareVersion(parsed.data.version, "share_version"),
    url: sanitizeWorkspaceShareUrl(parsed.data.url, "share_publish_url"),
    contentHash: normalizeWorkspaceShareHash(parsed.data.content_hash, "share_content_hash"),
    publishedAt: parsed.data.published_at
  };
}

function sanitizeBrowserWorkspaceShareRevokeResponse(value: unknown): WorkspaceShareRevokeResult {
  const parsed = PublicShareRevokeResultSchema.safeParse(value);
  if (!parsed.success) throw new Error("workspace_share_revoke_response_invalid");
  return {
    shareId: requirePublicId(parsed.data.share_id, "share_id"),
    version: normalizeWorkspaceShareVersion(parsed.data.version, "share_version"),
    status: "revoked",
    revokedAt: parsed.data.revoked_at
  };
}

function sanitizeBrowserWorkspaceShareImportResponse(value: unknown): WorkspaceShareImportResult {
  const parsed = PublicShareImportResultSchema.safeParse(value);
  if (!parsed.success) throw new Error("workspace_share_import_response_invalid");
  return {
    importId: requirePublicId(parsed.data.import_id, "share_import_id"),
    kind: parsed.data.kind,
    status: parsed.data.status,
    phase: parsed.data.phase,
    retryable: parsed.data.retryable,
    failureCode: parsed.data.failure_code === null ? null : requirePublicId(parsed.data.failure_code, "share_failure_code"),
    createdResourceIds: parsed.data.created_resource_ids.map((id) => requirePublicId(id, "share_created_resource_id")),
    createdAgentId: parsed.data.created_agent_id === null ? null : requirePublicId(parsed.data.created_agent_id, "share_created_agent_id"),
    committedAt: parsed.data.committed_at
  };
}

function sanitizeBrowserWorkspaceShareLinkViewResponse(
  value: unknown,
  source: { sourceUrl: string; sourceOrigin: string; locator: string }
): WorkspaceShareLinkView {
  const record = publicRecord(value, "workspace_share_link_view_response_invalid");
  assertBrowserAllowedKeys(record, ["title", "visibility", "manifest", "content_hash", "published_at"], "workspace_share_link_view_response_invalid");
  const title = requireBrowserText(record.title, "workspace_share_link_title", 200);
  if (record.visibility !== "public" && record.visibility !== "restricted") throw new Error("workspace_share_link_visibility_invalid");
  const manifest = PublicShareManifestSchema.safeParse(record.manifest);
  if (!manifest.success) throw new Error("workspace_share_link_manifest_invalid");
  const contentHash = normalizeWorkspaceShareHash(record.content_hash, "share_link_content_hash");
  if (typeof record.published_at !== "string" || !Number.isFinite(Date.parse(record.published_at))) throw new Error("workspace_share_link_published_at_invalid");
  return {
    sourceUrl: source.sourceUrl,
    sourceOrigin: source.sourceOrigin,
    locator: source.locator,
    title,
    visibility: record.visibility,
    manifest: sanitizeBrowserWorkspaceShareManifest(manifest.data),
    contentHash,
    publishedAt: new Date(record.published_at).toISOString()
  };
}

function sanitizeBrowserWorkspaceShareLinkClaimResponse(value: unknown): {
  claimId: string;
  shareId: string;
  recipientAccountId: string;
  targetOrigin: string;
  targetWorkspaceId: string;
  operationId: string;
  contentHash: string;
  createdAt: string;
} {
  const record = publicRecord(value, "workspace_share_link_claim_response_invalid");
  assertBrowserAllowedKeys(record, ["claim_id", "share_id", "recipient_account_id", "target_origin", "target_workspace_id", "operation_id", "content_hash", "created_at"], "workspace_share_link_claim_response_invalid");
  if (typeof record.target_origin !== "string") throw new Error("workspace_share_target_origin_invalid");
  let targetOrigin: string;
  try {
    const parsed = new URL(record.target_origin);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) throw new Error();
    targetOrigin = new URL("/", parsed.origin).toString();
  } catch {
    throw new Error("workspace_share_target_origin_invalid");
  }
  if (typeof record.created_at !== "string" || !Number.isFinite(Date.parse(record.created_at))) throw new Error("workspace_share_claim_created_at_invalid");
  return {
    claimId: requirePublicId(record.claim_id, "share_claim_id"),
    shareId: requirePublicId(record.share_id, "share_id"),
    recipientAccountId: requirePublicId(record.recipient_account_id, "share_recipient_account_id"),
    targetOrigin,
    targetWorkspaceId: requirePublicId(record.target_workspace_id, "share_target_workspace_id"),
    operationId: requirePublicId(record.operation_id, "share_operation_id"),
    contentHash: normalizeWorkspaceShareHash(record.content_hash, "share_claim_content_hash"),
    createdAt: new Date(record.created_at).toISOString()
  };
}

function sanitizeWorkspaceShareUrl(value: string, field: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${field}_invalid`);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !/^\/s\/[A-Za-z0-9_-]{43}$/.test(url.pathname)) {
    throw new Error(`${field}_invalid`);
  }
  return url.toString();
}

function normalizeWorkspaceContextSearchInput(input: WorkspaceContextSearchInput): Record<string, JsonValue> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("workspace_search_input_invalid");
  const query = typeof input.query === "string" ? input.query.trim() : "";
  if (!query || query.length > 512) throw new Error("workspace_search_query_invalid");
  const types = input.types === undefined
    ? undefined
    : normalizeWorkspaceSearchTypes(input.types);
  const roomId = input.roomId === undefined ? undefined : requirePublicId(input.roomId, "roomId");
  const page = normalizeBrowserPageInput(input.limit, input.cursor, "workspace_search");
  return {
    q: query,
    ...(types === undefined ? {} : { types }),
    ...(roomId === undefined ? {} : { room_id: roomId }),
    ...(page.limit === undefined ? {} : { limit: page.limit }),
    ...(page.cursor === undefined ? {} : { cursor: page.cursor })
  };
}

function normalizeWorkspaceSearchTypes(value: WorkspaceContextSearchInput["types"]): WorkspaceContextSearchInput["types"] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3) throw new Error("workspace_search_types_invalid");
  const allowed = new Set(["room", "conversation", "knowledge"]);
  if (value.some((type) => typeof type !== "string" || !allowed.has(type)) || new Set(value).size !== value.length) {
    throw new Error("workspace_search_types_invalid");
  }
  return [...value];
}

function normalizeWorkspaceNotificationListInput(input: WorkspaceNotificationListInput): Record<string, JsonValue> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("workspace_notification_input_invalid");
  if (input.unreadOnly !== undefined && typeof input.unreadOnly !== "boolean") throw new Error("workspace_notification_unread_only_invalid");
  const page = normalizeBrowserPageInput(input.limit, input.cursor, "workspace_notification");
  return {
    unread_only: input.unreadOnly ?? false,
    ...(page.limit === undefined ? {} : { limit: page.limit }),
    ...(page.cursor === undefined ? {} : { cursor: page.cursor })
  };
}

function normalizeBrowserAccountInvitationListInput(input: AccountInvitationNotificationListInput): Record<string, JsonValue> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("account_invitation_notification_input_invalid");
  const page = normalizeBrowserPageInput(input.limit, input.cursor, "account_invitation_notification");
  return {
    ...(page.limit === undefined ? {} : { limit: page.limit }),
    ...(page.cursor === undefined ? {} : { cursor: page.cursor })
  };
}

function normalizeBrowserPageInput(limit: unknown, cursor: unknown, prefix: string): { limit?: number; cursor?: string } {
  if (limit !== undefined && (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)) {
    throw new Error(`${prefix}_limit_invalid`);
  }
  if (cursor !== undefined && (typeof cursor !== "string" || !cursor.trim() || cursor.length > 4_096)) {
    throw new Error(`${prefix}_cursor_invalid`);
  }
  return {
    ...(limit === undefined ? {} : { limit }),
    ...(cursor === undefined ? {} : { cursor })
  };
}

function normalizeBrowserNotificationIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) throw new Error("notification_ids_invalid");
  const ids = value.map((id) => requirePublicId(id, "notification_id"));
  if (new Set(ids).size !== ids.length) throw new Error("notification_ids_invalid");
  return ids;
}

function normalizeBrowserWorkspaceIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) throw new Error("workspace_ids_invalid");
  const ids = value.map((id) => requirePublicId(id, "workspace_id"));
  if (new Set(ids).size !== ids.length) throw new Error("workspace_ids_invalid");
  return ids;
}

function sanitizeBrowserWorkspaceContextSearchResponse(value: unknown): WorkspaceContextSearchPage {
  const parsed = PublicWorkspaceSearchPageSchema.safeParse(value);
  if (!parsed.success) throw new Error("workspace_search_response_invalid");
  return {
    items: parsed.data.items.map((item, index) => sanitizeBrowserWorkspaceContextSearchItem(item, index)),
    nextCursor: parsed.data.next_cursor
  };
}

function sanitizeBrowserWorkspaceContextSearchItem(item: PublicSearchItem, index: number): WorkspaceContextSearchItem {
  const roomId = requirePublicId(item.room_id, `workspace_search_item_${index}_room_id`);
  const target = sanitizeBrowserContextTarget(item.target, `workspace_search_item_${index}_target`);
  if (target.kind === "invitation" || target.roomId !== roomId) throw new Error("workspace_search_target_scope_invalid");
  return {
    type: item.type,
    id: requirePublicId(item.id, `workspace_search_item_${index}_id`),
    roomId,
    title: item.title,
    snippet: item.snippet,
    updatedAt: item.updated_at,
    target
  };
}

function sanitizeBrowserNotificationPageResponse(value: unknown, invitationOnly: boolean): WorkspaceNotificationPage {
  const parsed = (invitationOnly ? PublicAccountInvitationNotificationsPageSchema : PublicNotificationPageSchema).safeParse(value);
  if (!parsed.success) throw new Error(invitationOnly ? "account_invitation_notification_response_invalid" : "workspace_notification_response_invalid");
  return {
    items: parsed.data.items.map((item, index) => sanitizeBrowserNotification(item, index)),
    nextCursor: parsed.data.next_cursor
  };
}

function sanitizeBrowserNotification(value: {
  id: string;
  kind: string;
  created_at: string;
  read_at: string | null;
  title: string;
  summary: string;
  target: PublicTarget | null;
  action_state: "not_required" | "pending" | "resolved";
}, index: number): WorkspaceNotification {
  return {
    id: requirePublicId(value.id, `workspace_notification_${index}_id`),
    kind: value.kind,
    createdAt: value.created_at,
    readAt: value.read_at,
    title: value.title,
    summary: value.summary,
    target: value.target === null ? null : sanitizeBrowserContextTarget(value.target, `workspace_notification_${index}_target`),
    actionState: value.action_state
  };
}

function sanitizeBrowserContextTarget(value: PublicTarget, field: string): WorkspaceContextTarget {
  const parsed = PublicTargetSchema.safeParse(value);
  if (!parsed.success) throw new Error(`${field}_invalid`);
  switch (parsed.data.kind) {
    case "room": return { kind: "room", roomId: requirePublicId(parsed.data.room_id, `${field}_room_id`) };
    case "work": return {
      kind: "work",
      roomId: requirePublicId(parsed.data.room_id, `${field}_room_id`),
      workId: requirePublicId(parsed.data.work_id, `${field}_work_id`),
      ...(parsed.data.message_id === undefined ? {} : { messageId: requirePublicId(parsed.data.message_id, `${field}_message_id`) })
    };
    case "knowledge": return {
      kind: "knowledge",
      roomId: requirePublicId(parsed.data.room_id, `${field}_room_id`),
      resourceId: requirePublicId(parsed.data.resource_id, `${field}_resource_id`)
    };
    case "interaction_request": return {
      kind: "interaction_request",
      roomId: requirePublicId(parsed.data.room_id, `${field}_room_id`),
      requestId: requirePublicId(parsed.data.request_id, `${field}_request_id`)
    };
    case "invitation": return { kind: "invitation", invitationId: requirePublicId(parsed.data.invitation_id, `${field}_invitation_id`) };
  }
}

function sanitizeBrowserNotificationSummaryResponse(value: unknown): WorkspaceNotificationSummary {
  const parsed = PublicNotificationSummarySchema.safeParse(value);
  if (!parsed.success) throw new Error("workspace_notification_summary_response_invalid");
  return { unreadCount: parsed.data.unread_count, asOf: parsed.data.as_of };
}

function sanitizeBrowserNotificationMarkReadResponse(value: unknown, requestedIds: readonly string[]): WorkspaceNotificationMarkReadResult {
  const parsed = PublicNotificationMarkReadResultSchema.safeParse(value);
  if (!parsed.success) throw new Error("workspace_notification_mark_read_response_invalid");
  const updatedIds = parsed.data.updated_ids.map((id) => requirePublicId(id, "notification_id"));
  const alreadyReadIds = parsed.data.already_read_ids.map((id) => requirePublicId(id, "notification_id"));
  const requested = new Set(requestedIds);
  if (new Set(updatedIds).size !== updatedIds.length
    || new Set(alreadyReadIds).size !== alreadyReadIds.length
    || updatedIds.some((id) => !requested.has(id))
    || alreadyReadIds.some((id) => !requested.has(id))
    || updatedIds.some((id) => alreadyReadIds.includes(id))
    || new Set([...updatedIds, ...alreadyReadIds]).size !== requested.size) {
    throw new Error("workspace_notification_mark_read_response_scope_invalid");
  }
  return { updatedIds, alreadyReadIds, readAt: parsed.data.read_at };
}

function sanitizeBrowserAccountWorkspaceNotificationSummariesResponse(value: unknown, requestedWorkspaceIds: readonly string[]): AccountWorkspaceNotificationSummaries {
  const parsed = PublicAccountWorkspaceNotificationSummariesSchema.safeParse(value);
  if (!parsed.success) throw new Error("account_workspace_notification_summary_response_invalid");
  const requested = new Set(requestedWorkspaceIds);
  const items = parsed.data.items.map((item) => ({
    workspaceId: requirePublicId(item.workspace_id, "workspace_id"),
    unreadCount: item.unread_count,
    asOf: item.as_of
  }));
  if (new Set(items.map((item) => item.workspaceId)).size !== items.length || items.some((item) => !requested.has(item.workspaceId))) {
    throw new Error("account_workspace_notification_summary_response_scope_invalid");
  }
  return { items };
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

function sanitizeWorkspaceAttachmentReadResult(value: unknown): WorkspaceAttachmentReadResult {
  const body = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const file = body.file && typeof body.file === "object" && !Array.isArray(body.file) ? body.file as Record<string, unknown> : {};
  const filePath = safeWorkspaceFilePath(file.path);
  const sha256 = typeof file.sha256 === "string" && /^[a-f0-9]{64}$/.test(file.sha256) ? file.sha256 : undefined;
  const version = typeof file.version === "number" && Number.isSafeInteger(file.version) && file.version > 0 ? file.version : undefined;
  const size = typeof file.size === "number" && Number.isSafeInteger(file.size) && file.size >= 0 && file.size <= 8 * 1024 * 1024 ? file.size : undefined;
  const bytes = Array.isArray(body.bytes) && body.bytes.length <= 8 * 1024 * 1024 && body.bytes.every((item) => typeof item === "number" && Number.isInteger(item) && item >= 0 && item <= 255)
    ? body.bytes as number[]
    : undefined;
  const mimeType = body.mimeType === undefined
    ? undefined
    : typeof body.mimeType === "string" && /^[\x20-\x7e]{1,255}$/.test(body.mimeType)
      ? body.mimeType
      : undefined;
  if (!filePath || !sha256 || version === undefined || size === undefined || !bytes || bytes.length !== size) {
    throw new Error("workspace_attachment_read_response_invalid");
  }
  if (body.mimeType !== undefined && mimeType === undefined) throw new Error("workspace_attachment_read_response_invalid");
  return { file: { path: filePath, version, sha256, size }, bytes, ...(mimeType ? { mimeType } : {}) };
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

type BrowserSnapshotAccountRequestInput = Pick<BrowserSnapshotWorkspaceRequestInput, "method" | "path" | "operationId" | "idempotencyKey" | "body">;

async function browserSnapshotAccountRequest<T>(
  snapshot: BrowserWorkspaceSnapshot,
  input: BrowserSnapshotAccountRequestInput
): Promise<T> {
  await assertBrowserWorkspaceSnapshot(snapshot);
  const result = await browserWorkspaceRequest<T>({
    method: input.method,
    path: input.path,
    connectionId: snapshot.id,
    ...(input.operationId ? { operationId: input.operationId } : {}),
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    ...(input.body === undefined ? {} : { body: input.body })
  });
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

type BrowserAgentCompletionInput = {
  scopeKind: "agent";
  agentId: string;
  kind?: "knowledge" | "skill";
  includeArchived?: boolean;
  cursor?: string;
  resourceId?: string;
  version?: number;
  title?: string;
  content?: string;
  metadata?: Record<string, unknown>;
  knowledgeKind?: "fact" | "decision" | "explanation" | "experience_rule";
  reason?: string;
  expectedVersion?: number;
  operationId?: string;
  archived?: boolean;
  target?: BrowserWorkspaceTargetRef;
};

function isBrowserAgentCompletionInput(input: unknown): boolean {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const value = input as Record<string, unknown>;
  return value.scopeKind === "agent" || value.agentId !== undefined;
}

function browserAgentCompletionInput(input: unknown): BrowserAgentCompletionInput {
  const value = publicRecord(input, "completion_agent_input");
  const allowed = new Set([
    "scopeKind", "agentId", "roomId", "kind", "includeArchived", "cursor", "resourceId", "version",
    "title", "content", "metadata", "knowledgeKind", "reason", "expectedVersion", "operationId", "archived", "target"
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error("completion_agent_input_invalid");
  if (value.scopeKind !== "agent") throw new Error("completion_agent_scope_invalid");
  const agentId = browserCompletionId(value.agentId, "completion_agent_id_invalid");
  if (value.roomId !== undefined) throw new Error("completion_agent_scope_room_forbidden");
  const target = browserAgentTarget(value.target);
  const kind = value.kind === undefined ? undefined : browserCompletionKind(value.kind);
  const includeArchived = value.includeArchived === undefined ? undefined : browserCompletionBoolean(value.includeArchived, "completion_agent_include_archived_invalid");
  const cursor = value.cursor === undefined ? undefined : browserCompletionId(value.cursor, "completion_agent_cursor_invalid");
  const resourceId = value.resourceId === undefined ? undefined : browserCompletionId(value.resourceId, "completion_agent_resource_id_invalid");
  const version = value.version === undefined ? undefined : browserCompletionPositiveInteger(value.version, "completion_agent_version_invalid");
  const title = value.title === undefined ? undefined : browserCompletionText(value.title, "completion_agent_title_invalid", 200);
  const content = value.content === undefined ? undefined : browserCompletionContent(value.content);
  const knowledgeKind = value.knowledgeKind === undefined ? undefined : browserCompletionKnowledgeKind(value.knowledgeKind);
  const metadata = value.metadata === undefined ? undefined : browserCompletionMetadata(value.metadata);
  const reason = value.reason === undefined ? undefined : browserCompletionText(value.reason, "completion_agent_reason_invalid", 4_000);
  const expectedVersion = value.expectedVersion === undefined ? undefined : browserCompletionPositiveInteger(value.expectedVersion, "completion_agent_expected_version_invalid");
  const operationId = value.operationId === undefined ? undefined : browserCompletionId(value.operationId, "completion_agent_operation_id_invalid");
  const archived = value.archived === undefined ? undefined : browserCompletionBoolean(value.archived, "completion_agent_archived_invalid");
  return {
    scopeKind: "agent",
    agentId,
    ...(kind === undefined ? {} : { kind }),
    ...(includeArchived === undefined ? {} : { includeArchived }),
    ...(cursor === undefined ? {} : { cursor }),
    ...(resourceId === undefined ? {} : { resourceId }),
    ...(version === undefined ? {} : { version }),
    ...(title === undefined ? {} : { title }),
    ...(content === undefined ? {} : { content }),
    ...(metadata === undefined ? {} : { metadata }),
    ...(knowledgeKind === undefined ? {} : { knowledgeKind }),
    ...(reason === undefined ? {} : { reason }),
    ...(expectedVersion === undefined ? {} : { expectedVersion }),
    ...(operationId === undefined ? {} : { operationId }),
    ...(archived === undefined ? {} : { archived }),
    ...(target === undefined ? {} : { target })
  };
}

function assertBrowserAgentCompletionOperationKeys(input: unknown, keys: readonly string[]): void {
  const value = publicRecord(input, "completion_agent_input");
  const allowed = new Set(keys);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error("completion_agent_input_invalid");
}

function browserAgentTarget(value: unknown): BrowserWorkspaceTargetRef | undefined {
  if (value === undefined) return undefined;
  const target = publicRecord(value, "completion_agent_target_invalid");
  const allowed = new Set(["connectionId", "workspaceId", "roomId", "selectionGeneration"]);
  if (Object.keys(target).some((key) => !allowed.has(key))) throw new Error("completion_agent_target_invalid");
  return browserTargetFromInput({ target });
}

function browserCompletionId(value: unknown, errorCode: string): string {
  if (typeof value !== "string" || !browserWorkspaceOpaqueIdPattern.test(value.trim())) throw new Error(errorCode);
  return value.trim();
}

function browserCompletionText(value: unknown, errorCode: string, maxLength: number): string {
  if (typeof value !== "string") throw new Error(errorCode);
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) throw new Error(errorCode);
  return normalized;
}

function browserCompletionContent(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 8 * 1024 * 1024) throw new Error("completion_agent_content_invalid");
  return value.trim();
}

function browserCompletionKind(value: unknown): "knowledge" | "skill" {
  if (value !== "knowledge" && value !== "skill") throw new Error("completion_agent_kind_invalid");
  return value;
}

function browserCompletionKnowledgeKind(value: unknown): "fact" | "decision" | "explanation" | "experience_rule" {
  if (value !== "fact" && value !== "decision" && value !== "explanation" && value !== "experience_rule") {
    throw new Error("completion_agent_knowledge_kind_invalid");
  }
  return value;
}

function browserCompletionBoolean(value: unknown, errorCode: string): boolean {
  if (typeof value !== "boolean") throw new Error(errorCode);
  return value;
}

function browserCompletionPositiveInteger(value: unknown, errorCode: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new Error(errorCode);
  return value;
}

function browserCompletionMetadata(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("completion_agent_metadata_invalid");
  try {
    const encoded = JSON.stringify(value);
    if (encoded.length > 200_000 || !browserCompletionJsonValue(value)) throw new Error("completion_agent_metadata_invalid");
  } catch {
    throw new Error("completion_agent_metadata_invalid");
  }
  return value as Record<string, unknown>;
}

function browserCompletionJsonValue(value: unknown): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(browserCompletionJsonValue);
  if (!value || typeof value !== "object") return false;
  return Object.values(value as Record<string, unknown>).every(browserCompletionJsonValue);
}

function browserAgentCompletionWriteBody(value: BrowserAgentCompletionInput): Record<string, unknown> {
  if (!value.kind) throw new Error("completion_agent_kind_invalid");
  const knowledgeKind = value.kind === "knowledge"
    ? value.knowledgeKind ?? (() => { throw new Error("completion_agent_knowledge_kind_invalid"); })()
    : value.knowledgeKind === undefined
      ? undefined
      : (() => { throw new Error("completion_agent_skill_knowledge_kind_forbidden"); })();
  return {
    scope_kind: "agent",
    agent_id: value.agentId,
    kind: value.kind,
    ...(knowledgeKind === undefined ? {} : { knowledge_kind: knowledgeKind }),
    title: value.title ?? (() => { throw new Error("completion_agent_title_invalid"); })(),
    content: value.content ?? (() => { throw new Error("completion_agent_content_invalid"); })(),
    metadata: value.metadata ?? {},
    reason: value.reason ?? (() => { throw new Error("completion_agent_reason_invalid"); })()
  };
}

function browserAgentCompletionResourceId(value: BrowserAgentCompletionInput): string {
  return value.resourceId ?? (() => { throw new Error("completion_agent_resource_id_invalid"); })();
}

function browserAgentCompletionOperationId(value: BrowserAgentCompletionInput): string {
  return value.operationId ?? (() => { throw new Error("completion_agent_operation_id_invalid"); })();
}

function browserAgentCompletionExpectedVersion(value: BrowserAgentCompletionInput): number {
  return value.expectedVersion ?? (() => { throw new Error("completion_agent_expected_version_invalid"); })();
}

function browserAgentCompletionArchived(value: BrowserAgentCompletionInput): boolean {
  return value.archived ?? (() => { throw new Error("completion_agent_archived_invalid"); })();
}

function assertBrowserAgentCompletionResourceScope(resource: { scope: { kind: string; agentId?: string }; kind: string; aiManaged: boolean }, agentId: string): void {
  if (resource.scope.kind !== "agent" || resource.scope.agentId !== agentId || (resource.kind !== "knowledge" && resource.kind !== "skill") || resource.aiManaged) {
    throw new Error("completion_agent_response_scope_invalid");
  }
}

function sanitizeBrowserAgentCompletionListResponse(value: unknown, agentId: string): { resources: WorkspaceCompletionResourceView[]; next_cursor?: string } {
  const parsed = PublicCompletionResourcePageSchema.safeParse(value);
  if (!parsed.success) throw new Error("completion_agent_response_invalid");
  parsed.data.resources.forEach((resource) => assertBrowserAgentCompletionResourceScope(resource, agentId));
  return parsed.data as { resources: WorkspaceCompletionResourceView[]; next_cursor?: string };
}

function sanitizeBrowserAgentCompletionDetailResponse(value: unknown, agentId: string): WorkspaceCompletionResourceDetail {
  const parsed = PublicCompletionResourceDetailSchema.safeParse(value);
  if (!parsed.success) throw new Error("completion_agent_response_invalid");
  assertBrowserAgentCompletionResourceScope(parsed.data.resource, agentId);
  return parsed.data as WorkspaceCompletionResourceDetail;
}

function sanitizeBrowserAgentCompletionBodyResponse(value: unknown, agentId: string): WorkspaceCompletionResourceBody {
  const parsed = PublicCompletionResourceBodySchema.safeParse(value);
  if (!parsed.success) throw new Error("completion_agent_response_invalid");
  assertBrowserAgentCompletionResourceScope(parsed.data.resource, agentId);
  return parsed.data as WorkspaceCompletionResourceBody;
}

function sanitizeBrowserAgentCompletionMutationResponse(value: unknown, agentId: string): { resource: WorkspaceCompletionResourceView; replayed?: boolean } {
  const parsed = PublicCompletionResourceMutationResponseSchema.safeParse(value);
  if (!parsed.success) throw new Error("completion_agent_response_invalid");
  assertBrowserAgentCompletionResourceScope(parsed.data.resource, agentId);
  return parsed.data as { resource: WorkspaceCompletionResourceView; replayed?: boolean };
}

async function listBrowserAgentCompletionResources(input: unknown): Promise<{ resources: WorkspaceCompletionResourceView[]; next_cursor?: string }> {
  assertBrowserAgentCompletionOperationKeys(input, ["scopeKind", "agentId", "kind", "includeArchived", "cursor", "target"]);
  const value = browserAgentCompletionInput(input);
  const snapshot = await captureBrowserWorkspaceSnapshot(value.target);
  const response = await browserSnapshotDomainApiClient(snapshot).listCompletionResources(snapshot.workspaceId, {
    scope_kind: "agent",
    agent_id: value.agentId,
    ...(value.kind ? { kind: value.kind } : {}),
    ...(value.includeArchived === undefined ? {} : { include_archived: value.includeArchived }),
    ...(value.cursor ? { cursor: value.cursor } : {})
  });
  return sanitizeBrowserAgentCompletionListResponse(response, value.agentId);
}

async function getBrowserAgentCompletionResource(input: unknown): Promise<WorkspaceCompletionResourceDetail> {
  assertBrowserAgentCompletionOperationKeys(input, ["scopeKind", "agentId", "resourceId", "kind", "target"]);
  const value = browserAgentCompletionInput(input);
  const snapshot = await captureBrowserWorkspaceSnapshot(value.target);
  const response = await browserSnapshotDomainApiClient(snapshot).getCompletionResource(snapshot.workspaceId, browserAgentCompletionResourceId(value), {
    scope_kind: "agent",
    agent_id: value.agentId,
    ...(value.kind ? { kind: value.kind } : {})
  });
  return sanitizeBrowserAgentCompletionDetailResponse(response, value.agentId);
}

async function getBrowserAgentCompletionResourceBody(input: unknown): Promise<WorkspaceCompletionResourceBody> {
  assertBrowserAgentCompletionOperationKeys(input, ["scopeKind", "agentId", "resourceId", "kind", "version", "target"]);
  const value = browserAgentCompletionInput(input);
  const snapshot = await captureBrowserWorkspaceSnapshot(value.target);
  const response = await browserSnapshotDomainApiClient(snapshot).getCompletionResourceBody(snapshot.workspaceId, browserAgentCompletionResourceId(value), {
    scope_kind: "agent",
    agent_id: value.agentId,
    ...(value.kind ? { kind: value.kind } : {}),
    ...(value.version === undefined ? {} : { version: value.version })
  });
  return sanitizeBrowserAgentCompletionBodyResponse(response, value.agentId);
}

async function createBrowserAgentCompletionResource(input: unknown): Promise<{ resource: WorkspaceCompletionResourceView; replayed?: boolean }> {
  assertBrowserAgentCompletionOperationKeys(input, ["scopeKind", "agentId", "kind", "knowledgeKind", "title", "content", "metadata", "reason", "operationId", "target"]);
  const value = browserAgentCompletionInput(input);
  const snapshot = await captureBrowserWorkspaceSnapshot(value.target);
  const operationId = browserAgentCompletionOperationId(value);
  const response = await browserSnapshotDomainApiClient(snapshot).createCompletionResource(snapshot.workspaceId, browserAgentCompletionWriteBody(value) as never, { operationId, idempotencyKey: operationId });
  return sanitizeBrowserAgentCompletionMutationResponse(response, value.agentId);
}

async function updateBrowserAgentCompletionResource(input: unknown): Promise<{ resource: WorkspaceCompletionResourceView; replayed?: boolean }> {
  assertBrowserAgentCompletionOperationKeys(input, ["scopeKind", "agentId", "resourceId", "kind", "knowledgeKind", "title", "content", "metadata", "reason", "expectedVersion", "operationId", "target"]);
  const value = browserAgentCompletionInput(input);
  const snapshot = await captureBrowserWorkspaceSnapshot(value.target);
  const operationId = browserAgentCompletionOperationId(value);
  const body = { ...browserAgentCompletionWriteBody(value), expected_version: browserAgentCompletionExpectedVersion(value) };
  const response = await browserSnapshotDomainApiClient(snapshot).updateCompletionResource(snapshot.workspaceId, browserAgentCompletionResourceId(value), body as never, { operationId, idempotencyKey: operationId });
  return sanitizeBrowserAgentCompletionMutationResponse(response, value.agentId);
}

async function archiveBrowserAgentCompletionResource(input: unknown): Promise<{ resource: WorkspaceCompletionResourceView; replayed?: boolean }> {
  assertBrowserAgentCompletionOperationKeys(input, ["scopeKind", "agentId", "resourceId", "archived", "expectedVersion", "reason", "operationId", "target"]);
  const value = browserAgentCompletionInput(input);
  const snapshot = await captureBrowserWorkspaceSnapshot(value.target);
  const operationId = browserAgentCompletionOperationId(value);
  const response = await browserSnapshotDomainApiClient(snapshot).setCompletionResourceArchived(snapshot.workspaceId, browserAgentCompletionResourceId(value), {
    scope_kind: "agent",
    agent_id: value.agentId,
    archived: browserAgentCompletionArchived(value),
    expected_version: browserAgentCompletionExpectedVersion(value),
    reason: value.reason ?? (() => { throw new Error("completion_agent_reason_invalid"); })()
  }, { operationId, idempotencyKey: operationId });
  return sanitizeBrowserAgentCompletionMutationResponse(response, value.agentId);
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

/** Account-scoped Domain API client. It deliberately omits Workspace routing
 * and headers while retaining the same target snapshot checks as Workspace
 * queries and operations. */
function browserSnapshotAccountDomainApiClient(snapshot: BrowserWorkspaceSnapshot): DomainApiClient {
  return new DomainApiClient(async <T>(request: DomainApiTransportRequest): Promise<T> => {
    await assertBrowserWorkspaceSnapshot(snapshot);
    const result = await browserSnapshotAccountRequest<T>(snapshot, {
      method: request.method,
      path: request.path,
      ...(request.operationId ? { operationId: request.operationId } : {}),
      ...(request.idempotencyKey ? { idempotencyKey: request.idempotencyKey } : {}),
      ...(request.body === undefined ? {} : { body: request.body })
    });
    return result;
  });
}

async function requireBrowserWorkspaceConnection(connectionId?: string): Promise<NonNullable<Awaited<ReturnType<typeof loadBrowserWorkspaceConnection>>>> {
  const connection = connectionId
    ? (await loadBrowserWorkspaceConnections()).find((candidate) => candidate.id === connectionId)
    : await loadBrowserWorkspaceConnection();
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
  // A renderer-supplied Room is a claim about the currently selected Room,
  // not a routing override.  In particular, an unselected Room must not be
  // synthesized from targetRoomId or another stale UI value.
  if (target?.roomId !== undefined && target.roomId !== activeRoomId) {
    throw new Error("room_navigation_changed");
  }
  if (target?.selectionGeneration !== undefined
    && !isCurrentActiveWorkspaceRoomSelection(target.selectionGeneration)) {
    throw new Error("workspace_navigation_changed");
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
  if (connection.roomId !== activeRoomId) {
    throw new Error("room_navigation_changed");
  }
  if (connection.selectionGeneration !== undefined
    && !isCurrentActiveWorkspaceRoomSelection(connection.selectionGeneration)) {
    throw new Error("workspace_navigation_changed");
  }
}

function sameBrowserWorkspaceSnapshot(left: BrowserWorkspaceSnapshot, right: BrowserWorkspaceSnapshot): boolean {
  return left.id === right.id
    && left.workspaceId === right.workspaceId
    && left.roomId === right.roomId
    && left.selectionGeneration === right.selectionGeneration;
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
    ...(room.can_edit === undefined ? {} : { canEdit: room.can_edit }),
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

function assertBrowserAllowedKeys(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
  const accepted = new Set(allowed);
  if (Object.keys(value).some((key) => !accepted.has(key))) throw new Error(field);
}

function requireBrowserText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string") throw new Error(`${field}_invalid`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) throw new Error(`${field}_invalid`);
  return normalized;
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

function roomWorkAssignmentResultSummary(value: unknown, depth = 0): string | undefined {
  if (typeof value === "string") {
    const normalized = value.trim();
    return normalized || undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value) || depth > 3) return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["summary", "result_summary", "resultSummary", "output_summary", "outputSummary", "message", "answer"]) {
    const summary = roomWorkAssignmentResultSummary(record[key], depth + 1);
    if (summary) return summary;
  }
  return roomWorkAssignmentResultSummary(record.output, depth + 1);
}

function roomWorkAssignmentResultRefs(value: unknown): DesktopWorkspaceRoomWorkAssignmentResult["resource_refs"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const rawRefs = record.resource_refs ?? record.resourceRefs;
  if (rawRefs === undefined || rawRefs === null) return undefined;
  if (!Array.isArray(rawRefs)) throw new Error("room_work_result_resource_refs_response_invalid");
  const refs = rawRefs.map((entry, index) => {
    const parsed = PublicRoomWorkResultResourceRefSchema.safeParse(entry);
    if (!parsed.success) throw new Error(`room_work_result_resource_refs_${index}_response_invalid`);
    return {
      kind: parsed.data.kind,
      id: parsed.data.id,
      uri: parsed.data.uri,
      ...(parsed.data.parent_id ? { parent_id: parsed.data.parent_id } : {}),
      ...(parsed.data.version ? { version: parsed.data.version } : {}),
      ...(parsed.data.label ? { label: parsed.data.label } : {})
    };
  });
  return refs.length ? refs : undefined;
}

/** Preserve only the public completion evidence needed by the Native work surface. */
function toDesktopRoomWorkAssignmentResult(value: unknown): DesktopWorkspaceRoomWorkAssignmentResult | undefined {
  const source = value === undefined || value === null ? undefined : value;
  const summary = roomWorkAssignmentResultSummary(source);
  const resourceRefs = roomWorkAssignmentResultRefs(source);
  if (!summary && !resourceRefs?.length) return undefined;
  return {
    ...(summary ? { summary } : {}),
    ...(resourceRefs?.length ? { resource_refs: resourceRefs } : {})
  };
}

function toDesktopRoomWorkAssignee(value: unknown): DesktopWorkspaceRoomWorkAssigneeWithResult {
  const record = publicRecord(value, "room_work_assignee");
  const result = toDesktopRoomWorkAssignmentResult(record.result ?? record.output ?? record);
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
    ...(result ? { result } : {}),
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
