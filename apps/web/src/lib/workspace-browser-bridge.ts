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
import { DomainApiClient, type DomainApiTransportRequest, type PublicRoomRecord } from "@samurai-agent/domain-api";
import type {
  AgentBackendStatus,
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
  DesktopWorkspaceLearningSettings,
  DesktopWorkspaceRoom,
  DesktopWorkspaceRoomMembership,
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
  WorkspaceKnowledgeMemoryPage,
  WorkspaceKnowledgeWikiPage
} from "./api";
import type {
  ActivityInboxItem,
  AutomationJobRecord,
  BackendEventRecord,
  BackendRunRecord,
  CollectionRecord,
  CollectionSchema,
  ArtifactRecord,
  JsonValue,
  MemoryFrontmatter,
  ResourceRef,
  SessionRecord,
  SettingsRecord,
  SupportedLocale,
  WikiFrontmatter
} from "@samurai-agent/core-schemas";
import type { SurfaceOperation, SurfaceOperationResultEnvelope } from "@samurai-agent/ui-protocol";
import type { AutomationRunSummary } from "./api";

type DesktopBridge = NonNullable<Window["samuraiDesktop"]>;

/**
 * Browser counterpart of the Desktop Workspace bridge.
 *
 * Each method is a fixed Domain Operation or Query. The browser never gets a
 * generic signed-request function from this module; the private Ed25519 key
 * remains a CryptoKey in IndexedDB and the server still performs all Room/RLS
 * checks.
 */
export function createBrowserWorkspaceBridge(): DesktopBridge {
  const bridge: DesktopBridge = {
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
    listWorkspaceRooms: async () => {
      const connection = await requireBrowserWorkspaceConnection();
      const response = await browserDomainApiClient.executeQuery<PublicRoomRecord[]>(connection.workspaceId, "room.list", { context: {}, input: {} });
      return { rooms: response.result.map(toDesktopWorkspaceRoom) };
    },
    listWorkspaceAgentBackends: () => workspaceRequest<AgentBackendStatus[]>("GET", "/agent-backends"),
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
    writeWorkspaceAttachment: (input) => workspaceRequest(
      "PUT",
      `/files/${workspaceAttachmentPath(input.path)}`,
      {
        room_id: input.roomId,
        content_base64: input.contentBase64,
        expected_version: input.expectedVersion
      },
      input.operationId
    ),
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
      if (input.parentRoomId) {
        return workspaceRequest("POST", "/rooms", { name: input.name, parent_room_id: input.parentRoomId, expected_workspace_version: input.expectedWorkspaceVersion }, input.operationId);
      }
      const connection = await requireBrowserWorkspaceConnection();
      const response = await browserDomainApiClient.executeOperation<PublicRoomRecord>(connection.workspaceId, "room.create", {
        context: {},
        input: { name: input.name }
      }, { operationId: input.operationId, idempotencyKey: input.operationId });
      return { room: toDesktopWorkspaceRoom(response.result), replayed: response.replayed };
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

function workspaceAttachmentPath(value: string): string {
  if (!/^attachments\/[A-Za-z0-9._-]{1,220}$/.test(value)) throw new Error("workspace_attachment_path_invalid");
  return value.split("/").map((part) => encodeURIComponent(part)).join("/");
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

async function requireBrowserWorkspaceConnection(): Promise<NonNullable<Awaited<ReturnType<typeof loadBrowserWorkspaceConnection>>>> {
  const connection = await loadBrowserWorkspaceConnection();
  if (!connection) throw new Error("workspace_connection_required");
  return connection;
}

function toDesktopWorkspaceRoom(room: PublicRoomRecord): DesktopWorkspaceRoom {
  return {
    id: room.id,
    workspaceId: room.workspace_id,
    ...(room.parent_room_id ? { parentRoomId: room.parent_room_id } : {}),
    name: room.name,
    version: room.version,
    ...(room.can_manage === undefined ? {} : { canManage: room.can_manage }),
    ...(room.can_execute === undefined ? {} : { canExecute: room.can_execute }),
    createdAt: room.created_at,
    updatedAt: room.updated_at
  };
}

async function workspaceSurfaceRequest<T = unknown>(suffix: string, roomId: string, operation: SurfaceOperation): Promise<SurfaceOperationResultEnvelope<T>> {
  return workspaceRequest<SurfaceOperationResultEnvelope<T>>("POST", suffix, { room_id: roomId, operation }, operation.id);
}
