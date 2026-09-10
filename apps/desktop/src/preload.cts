const { contextBridge, ipcRenderer } = require("electron") as typeof import("electron");
import {
  workspaceGeneratedSurfaceActionRequest,
  workspaceGeneratedSurfaceBundleRequest,
  workspaceGeneratedSurfaceExportRequest,
  workspaceGeneratedSurfaceRoomRequest,
  workspaceGeneratedSurfaceStateRequest
} from "./workspace-generated-surface-requests.js";
import {
  sanitizeWorkspaceBundleExportInput,
  sanitizeWorkspaceBundleRestoreInput,
  sanitizeWorkspaceChatSessionInput,
  sanitizeWorkspaceCreateInput,
  sanitizeWorkspaceArtifactRevisionInput,
  sanitizeWorkspaceGeneratedSurfaceMutationInput,
  sanitizeWorkspaceInteractionRequestCancelInput,
  sanitizeWorkspaceInteractionRequestListInput,
  sanitizeWorkspaceInteractionRequestResultInput,
  sanitizeWorkspaceInteractionRequestRespondInput,
  sanitizeWorkspaceOperationHistoryInput,
  sanitizeWorkspaceRoomWorkResourceRefs
} from "./preload-sanitizers.js";
import { workspaceAttachmentResourceRef, workspaceAttachmentUploadResult } from "./workspace-attachment-requests.js";

const apiBaseUrl = readArg("--samurai-api-base-url=");
const workspaceServerUrl = readArg("--samurai-workspace-server-url=");
const workspaceId = readArg("--samurai-workspace-id=");
const accountId = readArg("--samurai-account-id=");

contextBridge.exposeInMainWorld("samuraiDesktop", {
  apiBaseUrl,
  workspaceServerUrl,
  workspaceId,
  accountId,
  getStatus: () => ipcRenderer.invoke("samurai:get-status"),
  listWorkspaceConnections: () => ipcRenderer.invoke("samurai:workspace-connections:list"),
  listWorkspaceDirectory: () => ipcRenderer.invoke("samurai:workspace-directory:list"),
  createWorkspace: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:workspace:create", sanitizeWorkspaceCreateInput(input)),
  exportWorkspaceBundle: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:bundle:export", sanitizeWorkspaceBundleExportInput(input)),
  restoreWorkspaceBundle: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:bundle:restore", sanitizeWorkspaceBundleRestoreInput(input)),
  cutoverWorkspaceTarget: (input: unknown) => ipcRenderer.invoke("samurai:workspace-connections:cutover", sanitizeWorkspaceTargetCutoverInput(input)),
  preflightWorkspaceTransfer: (input: unknown) => ipcRenderer.invoke("samurai:workspace-transfer:preflight", sanitizeWorkspaceTransferInput(input)),
  executeWorkspaceTransfer: (input: unknown) => ipcRenderer.invoke("samurai:workspace-transfer:execute", sanitizeWorkspaceTransferInput(input)),
  getWorkspaceTransferStatus: (input: unknown) => ipcRenderer.invoke("samurai:workspace-transfer:status", sanitizeWorkspaceTransferInput(input)),
  listWorkspaceTransfers: () => ipcRenderer.invoke("samurai:workspace-transfer:list"),
  upsertWorkspaceConnection: (input: unknown) => ipcRenderer.invoke("samurai:workspace-connections:upsert", sanitizeWorkspaceConnectionInput(input)),
  selectWorkspaceConnection: (connectionId: unknown) => ipcRenderer.invoke("samurai:workspace-connections:select", typeof connectionId === "string" ? connectionId.slice(0, 160) : ""),
  selectOrganizationCandidate: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:selection:organization", sanitizeWorkspaceSelectionInput(input, "organization")),
  selectWorkspaceCandidate: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:selection:workspace", sanitizeWorkspaceSelectionInput(input, "workspace")),
  selectWorkspaceTarget: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:selection:workspace", sanitizeWorkspaceSelectionInput(input, "workspace")),
  selectRoomCandidate: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:selection:room", sanitizeWorkspaceSelectionInput(input, "room")),
  importActiveWorkspaceIdentityFromClipboard: () => ipcRenderer.invoke("samurai:workspace-identity:import-active-from-clipboard"),
  registerWorkspaceServerAccount: (displayName: unknown) => ipcRenderer.invoke("samurai:workspace-server:register-active-account", typeof displayName === "string" ? displayName.slice(0, 160) : ""),
  getWorkspaceServerStatus: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:status", sanitizeWorkspaceTargetInput(input)),
  listOrganizations: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:organization:list", sanitizeOrganizationIdInput(input)),
  getOrganization: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:organization:get", sanitizeOrganizationIdInput(input)),
  createOrganization: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:organization:create", sanitizeOrganizationMutationInput(input, ["name", "description", "icon", "operationId"])),
  patchOrganization: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:organization:patch", sanitizeOrganizationMutationInput(input, ["organizationId", "name", "description", "icon", "operationId", "expectedVersion"])),
  deleteOrganization: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:organization:delete", sanitizeOrganizationMutationInput(input, ["organizationId", "confirm", "expectedVersion", "operationId"])),
  listOrganizationMembers: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:organization:members:list", sanitizeOrganizationIdInput(input)),
  changeOrganizationMemberRole: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:organization:member:role", sanitizeOrganizationMutationInput(input, ["organizationId", "accountId", "role", "expectedVersion", "operationId"])),
  removeOrganizationMember: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:organization:member:remove", sanitizeOrganizationMutationInput(input, ["organizationId", "accountId", "expectedVersion", "operationId"])),
  leaveOrganization: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:organization:member:leave", sanitizeOrganizationMutationInput(input, ["organizationId", "expectedVersion", "operationId"])),
  listOrganizationInvitations: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:organization:invitations:list", sanitizeOrganizationIdInput(input)),
  createOrganizationInvitation: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:organization:invitation:create", sanitizeOrganizationInvitationInput(input)),
  acceptOrganizationInvitation: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:organization:invitation:accept", sanitizeOrganizationInvitationAcceptInput(input)),
  revokeOrganizationInvitation: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:organization:invitation:revoke", sanitizeOrganizationMutationInput(input, ["organizationId", "invitationId", "operationId", "expectedVersion"])),
  reissueOrganizationInvitation: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:organization:invitation:reissue", sanitizeOrganizationMutationInput(input, ["organizationId", "invitationId", "expectedVersion", "operationId"])),
  extendOrganizationInvitation: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:organization:invitation:extend", sanitizeOrganizationMutationInput(input, ["organizationId", "invitationId", "operationId", "expiresAt", "expectedVersion"])),
  listOrganizationWorkspaces: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:organization:workspaces:list", sanitizeOrganizationIdInput(input)),
  createOrganizationWorkspace: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:organization:workspace:create", sanitizeOrganizationMutationInput(input, ["organizationId", "name", "operationId"])),
  attachWorkspaceToOrganization: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:organization:workspace:attach", sanitizeOrganizationMutationInput(input, ["organizationId", "workspaceId", "expectedWorkspaceVersion", "confirmGuestMemberships", "operationId"])),
  detachWorkspaceFromOrganization: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:organization:workspace:detach", sanitizeOrganizationMutationInput(input, ["organizationId", "workspaceId", "expectedWorkspaceVersion", "operationId"])),
  patchOrganizationWorkspace: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:organization:workspace:patch", sanitizeOrganizationMutationInput(input, ["organizationId", "workspaceId", "name", "operationId", "expectedVersion"])),
  grantOrganizationWorkspaceMember: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:organization:workspace:member:grant", sanitizeOrganizationMutationInput(input, ["organizationId", "workspaceId", "accountId", "role", "operationId"])),
  revokeOrganizationWorkspaceMember: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:organization:workspace:member:revoke", sanitizeOrganizationMutationInput(input, ["organizationId", "workspaceId", "accountId", "operationId", "expectedVersion"])),
  setOrganizationWorkspaceLifecycle: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:organization:workspace:lifecycle", sanitizeOrganizationMutationInput(input, ["organizationId", "workspaceId", "lifecycle", "confirm", "expectedVersion", "operationId"])),
  previewOrganizationWorkspaceMove: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:organization:workspace:move-preview", sanitizeOrganizationMutationInput(input, ["organizationId", "workspaceId", "targetOrganizationId", "operationId", "expectedWorkspaceVersion"])),
  moveOrganizationWorkspace: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:organization:workspace:move", sanitizeOrganizationMutationInput(input, ["organizationId", "workspaceId", "targetOrganizationId", "operationId", "preflightId", "confirmGuestMembership", "expectedWorkspaceVersion"])),
  getOrganizationWorkspaceMoveStatus: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:organization:workspace:move-status", sanitizeOrganizationMutationInput(input, ["organizationId", "workspaceId", "operationId"])),
  exportOrganizationWorkspaceBundle: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:organization:bundle:export", sanitizeOrganizationMutationInput(input, ["organizationId", "workspaceId", "operationId", "expectedWorkspaceVersion"])),
  restoreOrganizationBundle: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:organization:bundle:restore", sanitizeOrganizationBundleRestoreInput(input)),
  listWorkspaceRooms: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:rooms:list", sanitizeWorkspaceAgentTargetInput(input)),
  listWorkspaceAgents: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:agents:list-target", sanitizeWorkspaceAgentTargetInput(input)),
  viewWorkspaceAgent: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:agent:view", sanitizeWorkspaceAgentOperationInput(input, ["agentId", "target"])),
  createWorkspaceAgent: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:agent:create", sanitizeWorkspaceAgentOperationInput(input, ["name", "role", "instructions", "backendId", "enabled", "operationId", "target"])),
  patchWorkspaceAgent: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:agent:patch", sanitizeWorkspaceAgentOperationInput(input, ["agentId", "name", "role", "instructions", "enabled", "expectedVersion", "operationId", "target"])),
  bindWorkspaceAgentBackend: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:agent:backend-bind", sanitizeWorkspaceAgentOperationInput(input, ["agentId", "backendId", "expectedVersion", "operationId", "target"])),
  listWorkspaceRoomAgentMembers: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:room-agent-members:list", sanitizeWorkspaceAgentOperationInput(input, ["roomId", "target"])),
  setWorkspaceRoomAgentPermission: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:room-agent-permission:set", sanitizeWorkspaceAgentOperationInput(input, ["roomId", "agentId", "canView", "canEdit", "canExecute", "operationId", "target"])),
  removeWorkspaceRoomAgent: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:room-agent:remove", sanitizeWorkspaceAgentOperationInput(input, ["roomId", "agentId", "operationId", "target"])),
  listWorkspaceAgentBackends: async (input: unknown) => sanitizeWorkspaceAgentBackendList(await ipcRenderer.invoke("samurai:workspace-server:agent-backends:list-target", sanitizeWorkspaceAgentTargetInput(input))),
  getWorkspaceSettings: (input?: unknown) => ipcRenderer.invoke("samurai:workspace-server:settings:get", sanitizeWorkspaceAgentTargetInput(input)),
  patchWorkspaceSettings: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:settings:patch", sanitizeWorkspaceSettingsPatch(input)),
  getWorkspaceSurfaceContract: (source: unknown) => ipcRenderer.invoke("samurai:workspace-server:surface:contract", sanitizeWorkspaceSurfaceContractInput(source)),
  listWorkspaceChatSessions: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:chat:sessions:list", sanitizeWorkspaceAgentTargetInput(input)),
  createWorkspaceChatSession: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:chat:session:create", sanitizeWorkspaceChatSessionInput(input)),
  getWorkspaceChatSession: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:chat:session:get", sanitizeWorkspaceChatSessionIdInput(input)),
  sendWorkspaceChatMessage: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:chat:message:send", sanitizeWorkspaceChatTurnInput(input)),
  writeWorkspaceAttachment: async (input: unknown) => workspaceAttachmentUploadResult(await ipcRenderer.invoke("samurai:workspace-server:files:attachment:write", sanitizeWorkspaceAttachmentInput(input))),
  searchWorkspace: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:chat:search", sanitizeWorkspaceRuntimeQuery(input)),
  listWorkspaceBackendRuns: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:chat:runs:list", sanitizeWorkspaceRuntimeQuery(input)),
  getWorkspaceBackendRun: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:chat:run:get", sanitizeWorkspaceRuntimeQuery(input)),
  listWorkspaceBackendEvents: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:chat:events:list", sanitizeWorkspaceRuntimeQuery(input)),
  listWorkspaceChanges: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:chat:changes:list", sanitizeWorkspaceRuntimeQuery(input)),
  listWorkspaceActivity: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:chat:activity:list", sanitizeWorkspaceRuntimeQuery(input)),
  cancelWorkspaceBackendRun: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:chat:run:cancel", sanitizeWorkspaceRunControlInput(input)),
  stopWorkspaceChatRun: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:chat:run:stop", sanitizeWorkspaceRunControlInput(input)),
  retryWorkspaceBackendRun: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:chat:run:retry", sanitizeWorkspaceRunControlInput(input)),
  reconnectWorkspaceServer: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:reconnect", sanitizeWorkspaceReconnectInput(input)),
  readWorkspaceEvidence: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:evidence:read", sanitizeWorkspaceEvidenceInput(input)),
  getWorkspaceAudit: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:audit:get", sanitizeWorkspaceAgentTargetInput(input)),
  listWorkspaceCompletionResources: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:completion:resources:list", sanitizeWorkspaceCompletionOperation(input)),
  getWorkspaceCompletionResource: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:completion:resource:get", sanitizeWorkspaceCompletionOperation(input)),
  getWorkspaceCompletionResourceBody: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:completion:resource:body", sanitizeWorkspaceCompletionOperation(input)),
  createWorkspaceCompletionResource: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:completion:resource:create", sanitizeWorkspaceCompletionOperation(input)),
  updateWorkspaceCompletionResource: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:completion:resource:update", sanitizeWorkspaceCompletionOperation(input)),
  setWorkspaceCompletionResourceFixed: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:completion:resource:fixed", sanitizeWorkspaceCompletionOperation(input)),
  archiveWorkspaceCompletionResource: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:completion:resource:archive", sanitizeWorkspaceCompletionOperation(input)),
  searchWorkspaceCompletionKnowledge: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:completion:knowledge:search", sanitizeWorkspaceCompletionOperation(input)),
  listWorkspaceCompletionSkills: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:completion:skills:list", sanitizeWorkspaceCompletionOperation(input)),
  getWorkspaceCompletionSkill: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:completion:skills:get", sanitizeWorkspaceCompletionOperation(input)),
  listWorkspaceSkillOptimizations: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:skill-optimizations:list", sanitizeWorkspaceSkillOptimizationInput(input)),
  getWorkspaceSkillOptimization: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:skill-optimizations:get", sanitizeWorkspaceSkillOptimizationInput(input)),
  startWorkspaceSkillOptimization: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:skill-optimizations:start", sanitizeWorkspaceSkillOptimizationInput(input)),
  runWorkspaceSkillOptimizationAction: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:skill-optimizations:action", sanitizeWorkspaceSkillOptimizationInput(input)),
  listWorkspaceKnowledgeWiki: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:knowledge-wiki:list", sanitizeWorkspaceWikiOperation(input)),
  getWorkspaceKnowledgeWiki: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:knowledge-wiki:get", sanitizeWorkspaceWikiOperation(input)),
  createWorkspaceKnowledgeWiki: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:knowledge-wiki:create", sanitizeWorkspaceWikiOperation(input)),
  updateWorkspaceKnowledgeWiki: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:knowledge-wiki:update", sanitizeWorkspaceWikiOperation(input)),
  setWorkspaceKnowledgeWikiState: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:knowledge-wiki:state", sanitizeWorkspaceWikiOperation(input)),
  reindexWorkspaceKnowledgeWiki: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:knowledge-wiki:reindex", sanitizeWorkspaceWikiOperation(input)),
  getWorkspaceKnowledgeWikiGraph: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:knowledge-wiki:graph", sanitizeWorkspaceWikiOperation(input)),
  getWorkspaceKnowledgeWikiLint: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:knowledge-wiki:lint", sanitizeWorkspaceWikiOperation(input)),
  getWorkspaceKnowledgeWikiBacklinks: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:knowledge-wiki:backlinks", sanitizeWorkspaceWikiOperation(input)),
  listWorkspaceKnowledgeMemory: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:knowledge-memory:list", sanitizeWorkspaceMemoryOperation(input)),
  getWorkspaceKnowledgeMemory: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:knowledge-memory:get", sanitizeWorkspaceMemoryOperation(input)),
  searchWorkspaceKnowledgeMemory: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:knowledge-memory:search", sanitizeWorkspaceMemoryOperation(input)),
  archiveWorkspaceKnowledgeMemory: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:knowledge-memory:archive", sanitizeWorkspaceMemoryOperation(input)),
  listWorkspaceCollectionSchemas: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:collections:schemas:list", sanitizeWorkspaceCollectionOperation(input)),
  getWorkspaceCollectionSchema: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:collections:schema:get", sanitizeWorkspaceCollectionOperation(input)),
  saveWorkspaceCollectionSchema: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:collections:schema:save", sanitizeWorkspaceCollectionOperation(input)),
  listWorkspaceCollectionRecords: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:collections:records:list", sanitizeWorkspaceCollectionOperation(input)),
  createWorkspaceCollectionRecord: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:collections:record:create", sanitizeWorkspaceCollectionOperation(input)),
  patchWorkspaceCollectionRecord: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:collections:record:patch", sanitizeWorkspaceCollectionOperation(input)),
  deleteWorkspaceCollectionRecord: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:collections:record:delete", sanitizeWorkspaceCollectionOperation(input)),
  listWorkspaceCollectionNotes: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:collections:notes:list", sanitizeWorkspaceCollectionOperation(input)),
  reindexWorkspaceCollections: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:collections:reindex", sanitizeWorkspaceCollectionOperation(input)),
  runWorkspaceCollectionSurfaceOperation: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:collections:surface", sanitizeWorkspaceCollectionOperation(input)),
  listWorkspaceAutomationJobs: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:automation:jobs:list", sanitizeWorkspaceAutomationOperation(input)),
  createWorkspaceAutomationJob: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:automation:jobs:create", sanitizeWorkspaceAutomationOperation(input)),
  listWorkspaceAutomationRuns: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:automation:runs:list", sanitizeWorkspaceAutomationOperation(input)),
  listWorkspaceAutomationJobRuns: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:automation:job:runs", sanitizeWorkspaceAutomationOperation(input)),
  setWorkspaceAutomationManagement: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:automation:management", sanitizeWorkspaceAutomationOperation(input)),
  runWorkspaceAutomationNow: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:automation:run-now", sanitizeWorkspaceAutomationOperation(input)),
  listWorkspaceArtifacts: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:artifacts:list", sanitizeWorkspaceArtifactOperation(input)),
  getWorkspaceArtifact: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:artifact:get", sanitizeWorkspaceArtifactOperation(input)),
  createWorkspaceArtifact: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:artifact:create", sanitizeWorkspaceArtifactOperation(input)),
  listWorkspaceArtifactRevisions: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:artifact:revisions:list", sanitizeWorkspaceArtifactOperation(input)),
  getWorkspaceArtifactRevision: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:artifact:revision:get", sanitizeWorkspaceArtifactOperation(input)),
  reviseWorkspaceArtifact: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:artifact:revise", sanitizeWorkspaceArtifactRevisionInput(input)),
  restoreWorkspaceArtifactRevision: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:artifact:restore", sanitizeWorkspaceArtifactRevisionInput(input)),
  runWorkspaceArtifactSurfaceOperation: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:artifact:surface", sanitizeWorkspaceArtifactOperation(input)),
  listWorkspaceGeneratedSurfaces: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:generated-surface:list", sanitizeWorkspaceArtifactOperation(input)),
  getWorkspaceGeneratedSurface: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:generated-surface:get", workspaceGeneratedSurfaceRoomRequest(input)),
  queryWorkspaceGeneratedSurface: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:generated-surface:get", workspaceGeneratedSurfaceRoomRequest(input)),
  getWorkspaceGeneratedSurfaceBundle: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:generated-surface:bundle", workspaceGeneratedSurfaceBundleRequest(input)),
  createWorkspaceGeneratedSurface: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:generated-surface:create", sanitizeWorkspaceGeneratedSurfaceMutationInput(input)),
  reviseWorkspaceGeneratedSurface: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:generated-surface:revise", sanitizeWorkspaceGeneratedSurfaceMutationInput(input)),
  runWorkspaceGeneratedSurfaceAction: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:generated-surface:action", workspaceGeneratedSurfaceActionRequest(input)),
  runWorkspaceGeneratedSurfaceState: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:generated-surface:state", workspaceGeneratedSurfaceStateRequest(input)),
  exportWorkspaceGeneratedSurface: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:generated-surface:export", workspaceGeneratedSurfaceExportRequest(input)),
  listWorkspaceInteractionRequests: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:interaction-requests:list", sanitizeWorkspaceInteractionRequestListInput(input)),
  getWorkspaceInteractionRequestResult: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:interaction-requests:result", sanitizeWorkspaceInteractionRequestResultInput(input)),
  listWorkspaceOperationHistory: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:operation-history:list", sanitizeWorkspaceOperationHistoryInput(input)),
  respondWorkspaceInteractionRequest: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:interaction-requests:respond", sanitizeWorkspaceInteractionRequestRespondInput(input)),
  cancelWorkspaceInteractionRequest: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:interaction-requests:cancel", sanitizeWorkspaceInteractionRequestCancelInput(input)),
  listWorkspaceRoomMembers: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:room-members:list", sanitizeWorkspaceRoomMemberListInput(input)),
  listWorkspaceRoomWorks: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:room-work:list", sanitizeWorkspaceRoomWorkListInput(input)),
  getWorkspaceRoomWork: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:room-work:view", sanitizeWorkspaceRoomWorkViewInput(input)),
  createWorkspaceRoomWork: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:room-work:create", sanitizeWorkspaceRoomWorkCreateInput(input)),
  replyWorkspaceRoomWork: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:room-work:reply", sanitizeWorkspaceRoomWorkReplyInput(input)),
  createWorkspaceRoomWorkComment: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:room-work:comment:create", sanitizeWorkspaceRoomWorkCommentCreateInput(input)),
  applyWorkspaceRoomWorkComment: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:room-work:comment:apply", sanitizeWorkspaceRoomWorkCommentApplyInput(input)),
  reactWorkspaceRoomWorkComment: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:room-work:comment:reaction", sanitizeWorkspaceRoomWorkCommentReactionInput(input)),
  stopWorkspaceRoomWork: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:room-work:stop", sanitizeWorkspaceRoomWorkControlInput(input)),
  stopWorkspaceRoomWorkAssignee: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:room-work:assignee:stop", sanitizeWorkspaceRoomWorkAssigneeStopInput(input)),
  reassignWorkspaceRoomWork: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:room-work:assignee:reassign", sanitizeWorkspaceRoomWorkReassignInput(input)),
  reassignWorkspaceRoomWorkAssignee: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:room-work:assignee:reassign", sanitizeWorkspaceRoomWorkReassignInput(input)),
  delegateWorkspaceRoomWorkAssignee: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:room-work:assignee:delegate", sanitizeWorkspaceRoomWorkDelegateInput(input)),
  setWorkspaceRoomDefaultAgent: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:room:default-agent:set", sanitizeWorkspaceRoomDefaultAgentInput(input)),
  openWorkspaceAgentDm: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:agent:dm:open", sanitizeWorkspaceAgentDmInput(input)),
  listWorkspaceEvents: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:events:list", sanitizeWorkspaceEventsInput(input)),
  createWorkspaceRoom: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:room:create", sanitizeWorkspaceRoomOperation(input)),
  previewWorkspaceRoomMove: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:room:move-preview", sanitizeWorkspaceRoomOperation(input)),
  moveWorkspaceRoom: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:room:move", sanitizeWorkspaceRoomOperation(input)),
  previewWorkspaceRoomMember: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:room-member:preview", sanitizeWorkspaceRoomOperation(input)),
  setWorkspaceRoomMember: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:room-member:set", sanitizeWorkspaceRoomOperation(input)),
  getWorkspaceLearningSettings: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:learning:settings:get", sanitizeWorkspaceLearningSettingsReadInput(input)),
  updateWorkspaceLearningSettings: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:learning:settings:put", sanitizeWorkspaceLearningOperation(input)),
  onWorkspaceServerEvent: (listener: unknown) => {
    if (typeof listener !== "function") return () => undefined;
    const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => listener(sanitizeWorkspaceRealtimeNotice(payload));
    ipcRenderer.on("samurai:workspace-server:event", handler);
    return () => ipcRenderer.removeListener("samurai:workspace-server:event", handler);
  },
  openMainWindow: () => ipcRenderer.invoke("samurai:window:open"),
  reloadMainWindow: () => ipcRenderer.invoke("samurai:window:reload"),
  quitApp: () => ipcRenderer.invoke("samurai:app:quit"),
  closeAppShot: () => ipcRenderer.invoke("samurai:app-shot:close"),
  closeQuickAsk: () => ipcRenderer.invoke("samurai:quick-ask:close"),
  submitAppShot: (input: unknown) => ipcRenderer.invoke("samurai:app-shot:submit", sanitizeAppShotInput(input)),
  submitQuickAsk: (input: unknown) => ipcRenderer.invoke("samurai:quick-ask:submit", sanitizeQuickAskInput(input))
});

function sanitizeAppShotInput(input: unknown): { sourceId: string; content: string } {
  if (!input || typeof input !== "object" || !("sourceId" in input) || !("content" in input)) {
    return { sourceId: "", content: "" };
  }
  const sourceId = typeof input.sourceId === "string" ? input.sourceId : "";
  const content = typeof input.content === "string" ? input.content : "";
  return {
    sourceId: sourceId.slice(0, 300),
    content: content.slice(0, 2000)
  };
}

function sanitizeWorkspaceConnectionInput(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object") return {};
  const value = input as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const key of ["id", "label", "serverUrl", "workspaceId", "accountId", "lastOrganizationId", "lastWorkspaceId", "lastRoomId"]) {
    if (typeof value[key] === "string") output[key] = value[key].slice(0, key === "label" ? 100 : 500);
  }
  if (Array.isArray(value.targets)) {
    output.targets = value.targets.slice(0, 500).flatMap((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const target = item as Record<string, unknown>;
      if (typeof target.connectionId !== "string" || typeof target.workspaceId !== "string") return [];
      return [{
        connectionId: target.connectionId.slice(0, 160),
        workspaceId: target.workspaceId.slice(0, 128),
        ...(typeof target.lastOrganizationId === "string" ? { lastOrganizationId: target.lastOrganizationId.slice(0, 128) } : {}),
        ...(typeof target.lastRoomId === "string" ? { lastRoomId: target.lastRoomId.slice(0, 128) } : {})
      }];
    });
  }
  return output;
}

function sanitizeWorkspaceSelectionInput(input: unknown, kind: "organization" | "workspace" | "room"): Record<string, string> {
  if (typeof input === "string") {
    const key = kind === "organization" ? "organizationId" : kind === "workspace" ? "workspaceId" : "roomId";
    return { [key]: input.slice(0, 128) };
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const value = input as Record<string, unknown>;
  const output: Record<string, string> = {};
  for (const key of ["connectionId", "organizationId", "workspaceId", "roomId"]) {
    if (typeof value[key] === "string") output[key] = value[key].slice(0, 128);
  }
  const target = value.target;
  if (target && typeof target === "object" && !Array.isArray(target)) {
    const targetValue = target as Record<string, unknown>;
    for (const key of ["connectionId", "workspaceId"] as const) {
      if (output[key] === undefined && typeof targetValue[key] === "string") output[key] = targetValue[key].slice(0, 128);
    }
    if (kind === "room" && output.roomId === undefined && typeof targetValue.roomId === "string") {
      output.roomId = targetValue.roomId.slice(0, 128);
    }
  }
  return output;
}

function sanitizeWorkspaceTargetInput(input: unknown): { connectionId: string; workspaceId: string; roomId?: string; selectionGeneration?: number } | undefined {
  if (input === undefined || input === null) return undefined;
  if (!input || typeof input !== "object" || Array.isArray(input)) return { connectionId: "", workspaceId: "" };
  const value = input as Record<string, unknown>;
  const target: { connectionId: string; workspaceId: string; roomId?: string; selectionGeneration?: number } = {
    connectionId: typeof value.connectionId === "string" ? value.connectionId.slice(0, 128) : "",
    workspaceId: typeof value.workspaceId === "string" ? value.workspaceId.slice(0, 128) : ""
  };
  if (value.roomId !== undefined) target.roomId = typeof value.roomId === "string" ? value.roomId.slice(0, 128) : "";
  if (value.selectionGeneration !== undefined) {
    target.selectionGeneration = typeof value.selectionGeneration === "number" ? value.selectionGeneration : -1;
  }
  return target;
}

function sanitizeWorkspaceAgentTargetInput(input: unknown): Record<string, unknown> {
  const value = plainObject(input);
  if (!("target" in value)
    && (!input || typeof input !== "object" || Array.isArray(input)
      || (!("connectionId" in value) && !("workspaceId" in value)))) return {};
  const target = sanitizeWorkspaceTargetInput(value.target ?? input);
  return target?.connectionId && target.workspaceId ? { target } : { target: { connectionId: "", workspaceId: "" } };
}

function sanitizeWorkspaceSurfaceContractInput(input: unknown): unknown {
  if (typeof input === "string") return input.slice(0, 80);
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const value = input as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  if (typeof value.source === "string") output.source = value.source.slice(0, 80);
  copyWorkspaceTargetInput(value, output);
  return output;
}

function sanitizeWorkspaceAgentOperationInput(input: unknown, keys: string[]): Record<string, unknown> {
  const value = plainObject(input);
  const output: Record<string, unknown> = {};
  for (const key of keys) {
    if (key === "target") {
      if (!(key in value)) continue;
      const target = sanitizeWorkspaceTargetInput(value.target);
      output.target = target?.connectionId && target.workspaceId ? target : { connectionId: "", workspaceId: "" };
      continue;
    }
    if (key === "enabled" || key === "canView" || key === "canEdit" || key === "canExecute") {
      if (typeof value[key] === "boolean") output[key] = value[key];
      continue;
    }
    if (key === "expectedVersion") {
      if (typeof value[key] === "number" && Number.isSafeInteger(value[key])) output[key] = value[key];
      continue;
    }
    if (typeof value[key] === "string") output[key] = value[key].trim().slice(0, key === "instructions" ? 20_000 : key === "role" ? 500 : key === "name" ? 200 : 512);
  }
  return output;
}

/** Keep the caller's Workspace target explicit at the IPC boundary. */
function copyWorkspaceTargetInput(value: Record<string, unknown>, output: Record<string, unknown>): void {
  if (!("target" in value)) return;
  const target = sanitizeWorkspaceTargetInput(value.target);
  output.target = target?.connectionId && target.workspaceId
    ? target
    : { connectionId: "", workspaceId: "" };
}

function sanitizeWorkspaceTargetCutoverInput(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const value = input as Record<string, unknown>;
  const target = (candidate: unknown): Record<string, string> => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return {};
    const item = candidate as Record<string, unknown>;
    return {
      connectionId: typeof item.connectionId === "string" ? item.connectionId.slice(0, 128) : "",
      workspaceId: typeof item.workspaceId === "string" ? item.workspaceId.slice(0, 128) : ""
    };
  };
  const output: Record<string, unknown> = {
    source: target(value.source),
    destination: target(value.destination)
  };
  for (const key of ["lastOrganizationId", "lastRoomId"]) {
    if (typeof value[key] === "string") output[key] = value[key].slice(0, 128);
  }
  return output;
}

function sanitizeWorkspaceTransferInput(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const value = input as Record<string, unknown>;
  const target = (candidate: unknown): Record<string, string> => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return {};
    const item = candidate as Record<string, unknown>;
    return {
      connectionId: typeof item.connectionId === "string" ? item.connectionId.slice(0, 128) : "",
      workspaceId: typeof item.workspaceId === "string" ? item.workspaceId.slice(0, 128) : ""
    };
  };
  const output: Record<string, unknown> = {
    source: target(value.source),
    destination: target(value.destination)
  };
  for (const key of ["operationId", "transferId", "lastRoomId"]) {
    if (typeof value[key] === "string") output[key] = value[key].slice(0, 160);
  }
  if (typeof value.targetWorkspaceName === "string") output.targetWorkspaceName = value.targetWorkspaceName.slice(0, 500);
  return output;
}

function sanitizeOrganizationIdInput(input: unknown): Record<string, unknown> {
  const output = sanitizeWorkspaceSelectionInput(input, "organization") as Record<string, unknown>;
  if (input && typeof input === "object" && !Array.isArray(input)) copyWorkspaceTargetInput(input as Record<string, unknown>, output);
  return output;
}

function sanitizeOrganizationMutationInput(input: unknown, keys: string[]): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const value = input as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const key of keys) {
    if (typeof value[key] === "string") output[key] = value[key].slice(0, key === "name" ? 240 : key === "description" ? 20_000 : 160);
    if ((key === "description" || key === "icon") && value[key] === null) output[key] = null;
    if (typeof value[key] === "boolean") output[key] = value[key];
    if (typeof value[key] === "number" && Number.isSafeInteger(value[key])) output[key] = value[key];
  }
  copyWorkspaceTargetInput(value, output);
  return output;
}

function sanitizeOrganizationInvitationInput(input: unknown): Record<string, unknown> {
  const output = sanitizeOrganizationMutationInput(input, ["organizationId", "accountId", "role", "operationId", "expiresAt"]);
  if (!input || typeof input !== "object" || Array.isArray(input)) return output;
  const value = input as Record<string, unknown>;
  if (Array.isArray(value.workspaceGrants)) {
    output.workspaceGrants = value.workspaceGrants.slice(0, 100).flatMap((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const grant = item as Record<string, unknown>;
      if (typeof grant.workspaceId !== "string" || typeof grant.role !== "string") return [];
      return [{
        workspaceId: grant.workspaceId.slice(0, 128),
        role: grant.role.slice(0, 16),
        ...(Array.isArray(grant.roomIds) ? { roomIds: grant.roomIds.filter((roomId): roomId is string => typeof roomId === "string").slice(0, 500).map((roomId) => roomId.slice(0, 128)) } : {})
      }];
    });
  }
  return output;
}

function sanitizeOrganizationInvitationAcceptInput(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const value = input as Record<string, unknown>;
  const output: Record<string, unknown> = {
    token: typeof value.token === "string" ? value.token.slice(0, 512) : "",
    operationId: typeof value.operationId === "string" ? value.operationId.slice(0, 128) : ""
  };
  copyWorkspaceTargetInput(value, output);
  return output;
}

function sanitizeOrganizationBundleRestoreInput(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const value = input as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const key of ["organizationId", "bundleId", "operationId"]) {
    if (typeof value[key] === "string") output[key] = value[key].slice(0, 160);
  }
  if (typeof value.confirm === "boolean") output.confirm = value.confirm;
  copyWorkspaceTargetInput(value, output);
  return output;
}

function sanitizeWorkspaceRunControlInput(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const value = input as Record<string, unknown>;
  const output: Record<string, unknown> = {
    runId: typeof value.runId === "string" ? value.runId.slice(0, 128) : "",
    operationId: typeof value.operationId === "string" ? value.operationId.slice(0, 128) : "",
    ...(typeof value.confirmUnknown === "boolean" ? { confirmUnknown: value.confirmUnknown } : {})
  };
  copyWorkspaceTargetInput(value, output);
  return output;
}

function sanitizeWorkspaceReconnectInput(input: unknown): Record<string, string> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const value = input as Record<string, unknown>;
  return typeof value.connectionId === "string" ? { connectionId: value.connectionId.slice(0, 160) } : {};
}

function sanitizeWorkspaceEvidenceInput(input: unknown): Record<string, string> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const value = input as Record<string, unknown>;
  const output: Record<string, string> = {};
  for (const key of ["workspaceId", "roomId", "messageId", "runId"]) {
    if (typeof value[key] === "string") output[key] = value[key].slice(0, 128);
  }
  return output;
}

function sanitizeWorkspaceChatSessionIdInput(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const value = input as Record<string, unknown>;
  const output: Record<string, unknown> = { sessionId: typeof value.sessionId === "string" ? value.sessionId.slice(0, 128) : "" };
  copyWorkspaceTargetInput(value, output);
  return output;
}

function sanitizeWorkspaceRuntimeQuery(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const value = input as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const key of ["roomId", "sessionId", "runId", "query"]) {
    if (typeof value[key] === "string") output[key] = value[key].slice(0, 200_000);
  }
  copyWorkspaceTargetInput(value, output);
  return output;
}

function sanitizeWorkspaceSkillOptimizationInput(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const value = input as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  copyWorkspaceTargetInput(value, output);
  for (const key of ["skillId", "roomId", "runId", "action", "candidateId", "promotionId", "snapshotId", "operationId", "objective"]) {
    if (typeof value[key] === "string") output[key] = value[key].slice(0, key === "objective" ? 10_000 : 160);
  }
  if (typeof value.limit === "number" && Number.isSafeInteger(value.limit)) output.limit = value.limit;
  for (const key of ["goldenExamples", "syntheticExamples"]) {
    if (Array.isArray(value[key])) output[key] = value[key].slice(0, 1_000);
  }
  return output;
}

function sanitizeWorkspaceSettingsPatch(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const value = input as Record<string, unknown>;
  const patch = value.patch && typeof value.patch === "object" && !Array.isArray(value.patch) ? value.patch as Record<string, unknown> : {};
  const output: Record<string, unknown> = {
    operationId: typeof value.operationId === "string" ? value.operationId.slice(0, 128) : "",
    patch
  };
  copyWorkspaceTargetInput(value, output);
  return output;
}

function sanitizeWorkspaceChatTurnInput(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const value = input as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  copyWorkspaceTargetInput(value, output);
  for (const key of ["sessionId", "idempotencyKey", "agentId", "backendId", "inputLocale", "outputLocale"]) {
    if (typeof value[key] === "string") output[key] = value[key].slice(0, key === "idempotencyKey" ? 256 : key.includes("Locale") ? 32 : 128);
  }
  if (typeof value.content === "string") output.content = value.content.slice(0, 200_000);
  if (value.metadata && typeof value.metadata === "object" && !Array.isArray(value.metadata)) {
    output.metadata = value.metadata;
  }
  if (Array.isArray(value.attachments)) {
    output.attachments = value.attachments.slice(0, 32).flatMap((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const attachment = item as Record<string, unknown>;
      if (typeof attachment.kind !== "string" || typeof attachment.id !== "string" || typeof attachment.uri !== "string") return [];
      const result: Record<string, string> = {
        kind: attachment.kind.slice(0, 256),
        id: attachment.id.slice(0, 512),
        uri: attachment.uri.slice(0, 2_000)
      };
      if (typeof attachment.label === "string") result.label = attachment.label.slice(0, 2_000);
      if (typeof attachment.version === "string") result.version = attachment.version.slice(0, 128);
      return [result];
    });
  }
  return output;
}

function sanitizeWorkspaceAttachmentInput(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const value = input as Record<string, unknown>;
  const output: Record<string, unknown> = {
    roomId: typeof value.roomId === "string" ? value.roomId.slice(0, 128) : "",
    path: typeof value.path === "string" ? value.path.slice(0, 240) : "",
    contentBase64: typeof value.contentBase64 === "string" ? value.contentBase64.slice(0, 11_184_812) : "",
    expectedVersion: typeof value.expectedVersion === "number" && Number.isSafeInteger(value.expectedVersion) ? value.expectedVersion : -1,
    operationId: typeof value.operationId === "string" ? value.operationId.slice(0, 128) : ""
  };
  copyWorkspaceTargetInput(value, output);
  return output;
}

function sanitizeWorkspaceRealtimeNotice(input: unknown): { type: string; workspaceId: string; connectionId?: string; roomId?: string; kind?: string; eventId?: string; eventVersion?: string; cursor?: string; operationId?: string; correlationId?: string } | undefined {
  if (!input || typeof input !== "object") return undefined;
  const value = input as Record<string, unknown>;
  const type = typeof value.type === "string" && /^(?:event|access_changed|access_revoked|room_access_changed|room_access_revoked)$/.test(value.type)
    ? value.type
    : undefined;
  const workspaceId = typeof value.workspaceId === "string" && opaque(value.workspaceId) ? value.workspaceId : undefined;
  if (!type || !workspaceId) return undefined;
  const output: { type: string; workspaceId: string; connectionId?: string; roomId?: string; kind?: string; eventId?: string; eventVersion?: string; cursor?: string; operationId?: string; correlationId?: string } = { type, workspaceId };
  if (typeof value.connectionId === "string" && opaque(value.connectionId)) output.connectionId = value.connectionId;
  if (typeof value.roomId === "string" && opaque(value.roomId)) output.roomId = value.roomId;
  if (typeof value.kind === "string" && /^[a-z][a-z0-9._-]{0,80}$/.test(value.kind)) output.kind = value.kind;
  if (typeof value.eventId === "string" && opaque(value.eventId)) output.eventId = value.eventId;
  if (typeof value.eventVersion === "string" && /^\d+\.\d+$/.test(value.eventVersion)) output.eventVersion = value.eventVersion;
  if (typeof value.cursor === "string" && value.cursor.length <= 512) output.cursor = value.cursor;
  if (typeof value.operationId === "string" && opaque(value.operationId)) output.operationId = value.operationId;
  if (typeof value.correlationId === "string" && opaque(value.correlationId)) output.correlationId = value.correlationId;
  return output;
}

/**
 * Room work IPC inputs deliberately form a small allowlist.  In particular,
 * Session IDs, external Backend Session handles and credentials cannot be
 * smuggled into the normal Room surface through an arbitrary object.
 */
function sanitizeWorkspaceRoomWorkListInput(input: unknown): Record<string, unknown> {
  const value = plainObject(input);
  const output: Record<string, unknown> = {};
  copyWorkspaceTargetInput(value, output);
  copyRoomWorkId(value, output, "roomId");
  copyRoomWorkId(value, output, "cursor", 512);
  if (typeof value.status === "string" && /^(?:queued|running|waiting|completed|failed|stopping|cancelled|outcome_unknown)$/.test(value.status)) output.status = value.status;
  if (typeof value.limit === "number" && Number.isSafeInteger(value.limit)) output.limit = value.limit;
  return output;
}

function sanitizeWorkspaceRoomWorkViewInput(input: unknown): Record<string, unknown> {
  const value = plainObject(input);
  const output: Record<string, unknown> = {};
  copyWorkspaceTargetInput(value, output);
  copyRoomWorkId(value, output, "roomId");
  copyRoomWorkId(value, output, "workId");
  return output;
}

function sanitizeWorkspaceRoomWorkCreateInput(input: unknown): Record<string, unknown> {
  const value = plainObject(input);
  const output: Record<string, unknown> = {};
  copyWorkspaceTargetInput(value, output);
  copyRoomWorkId(value, output, "roomId");
  copyRoomWorkId(value, output, "agentId");
  copyRoomWorkString(value, output, "instruction", 1_000_000);
  copyRoomWorkString(value, output, "operationId", 256);
  copyRoomWorkAttachments(value, output);
  if (value.resourceRefs !== undefined) output.resourceRefs = sanitizeWorkspaceRoomWorkResourceRefs(value.resourceRefs);
  return output;
}

function sanitizeWorkspaceRoomWorkReplyInput(input: unknown): Record<string, unknown> {
  const value = plainObject(input);
  const output: Record<string, unknown> = {};
  copyWorkspaceTargetInput(value, output);
  for (const key of ["roomId", "workId", "assigneeId"]) copyRoomWorkId(value, output, key);
  copyRoomWorkString(value, output, "instruction", 1_000_000);
  copyRoomWorkString(value, output, "operationId", 256);
  copyRoomWorkString(value, output, "reason", 2_000);
  copyRoomWorkAttachments(value, output);
  copyRoomWorkVersions(value, output);
  if (value.resourceRefs !== undefined) output.resourceRefs = sanitizeWorkspaceRoomWorkResourceRefs(value.resourceRefs);
  return output;
}

function sanitizeWorkspaceRoomWorkCommentCreateInput(input: unknown): Record<string, unknown> {
  const value = plainObject(input);
  const output: Record<string, unknown> = {};
  copyWorkspaceTargetInput(value, output);
  for (const key of ["roomId", "workId"]) copyRoomWorkId(value, output, key);
  copyRoomWorkString(value, output, "body", 100_000);
  copyRoomWorkString(value, output, "operationId", 256);
  copyRoomWorkAttachments(value, output);
  copyRoomWorkVersions(value, output, false);
  return output;
}

function sanitizeWorkspaceRoomWorkCommentApplyInput(input: unknown): Record<string, unknown> {
  const value = plainObject(input);
  const output: Record<string, unknown> = {};
  copyWorkspaceTargetInput(value, output);
  for (const key of ["roomId", "workId", "commentId", "assigneeId"]) copyRoomWorkId(value, output, key);
  copyRoomWorkString(value, output, "operationId", 256);
  copyRoomWorkVersions(value, output);
  if (typeof value.commentVersion === "number" && Number.isSafeInteger(value.commentVersion)) output.commentVersion = value.commentVersion;
  return output;
}

function sanitizeWorkspaceRoomWorkCommentReactionInput(input: unknown): Record<string, unknown> {
  const value = plainObject(input);
  const output: Record<string, unknown> = {};
  copyWorkspaceTargetInput(value, output);
  for (const key of ["roomId", "workId", "commentId"]) copyRoomWorkId(value, output, key);
  copyRoomWorkString(value, output, "operationId", 256);
  if (value.reaction === undefined || value.reaction === "like") output.reaction = "like";
  if (typeof value.enabled === "boolean") output.enabled = value.enabled;
  if (typeof value.expectedVersion === "number" && Number.isSafeInteger(value.expectedVersion)) output.expectedVersion = value.expectedVersion;
  return output;
}

function sanitizeWorkspaceRoomWorkControlInput(input: unknown): Record<string, unknown> {
  const value = plainObject(input);
  const output: Record<string, unknown> = {};
  copyWorkspaceTargetInput(value, output);
  for (const key of ["roomId", "workId"]) copyRoomWorkId(value, output, key);
  copyRoomWorkString(value, output, "reason", 2_000);
  copyRoomWorkString(value, output, "operationId", 256);
  copyRoomWorkVersions(value, output);
  return output;
}

function sanitizeWorkspaceRoomWorkAssigneeStopInput(input: unknown): Record<string, unknown> {
  const output = sanitizeWorkspaceRoomWorkControlInput(input);
  copyRoomWorkId(plainObject(input), output, "assigneeId");
  return output;
}

function sanitizeWorkspaceRoomWorkReassignInput(input: unknown): Record<string, unknown> {
  const value = plainObject(input);
  const output: Record<string, unknown> = {};
  copyWorkspaceTargetInput(value, output);
  for (const key of ["roomId", "workId", "assigneeId", "agentId"]) copyRoomWorkId(value, output, key);
  copyRoomWorkString(value, output, "operationId", 256);
  copyRoomWorkVersions(value, output);
  return output;
}

function sanitizeWorkspaceRoomWorkDelegateInput(input: unknown): Record<string, unknown> {
  const value = plainObject(input);
  const output: Record<string, unknown> = {};
  copyWorkspaceTargetInput(value, output);
  for (const key of ["roomId", "workId", "assigneeId", "agentId"]) copyRoomWorkId(value, output, key);
  copyRoomWorkString(value, output, "instruction", 1_000_000);
  copyRoomWorkString(value, output, "operationId", 256);
  copyRoomWorkVersions(value, output);
  if (Array.isArray(value.dependencyAssigneeIds)) {
    output.dependencyAssigneeIds = value.dependencyAssigneeIds.slice(0, 100).flatMap((item) => {
      if (typeof item !== "string") return [];
      const id = item.trim().slice(0, 128);
      return id && opaque(id) ? [id] : [];
    });
  }
  copyRoomWorkAttachments(value, output);
  return output;
}

function sanitizeWorkspaceRoomDefaultAgentInput(input: unknown): Record<string, unknown> {
  return sanitizeWorkspaceAgentOperationInput(input, ["roomId", "agentId", "operationId", "expectedVersion", "target"]);
}

function sanitizeWorkspaceAgentDmInput(input: unknown): Record<string, unknown> {
  return sanitizeWorkspaceAgentOperationInput(input, ["agentId", "operationId", "target"]);
}

function sanitizeWorkspaceEventsInput(input: unknown): Record<string, unknown> {
  const value = plainObject(input);
  const output: Record<string, unknown> = {};
  copyWorkspaceTargetInput(value, output);
  copyRoomWorkId(value, output, "roomId");
  copyRoomWorkString(value, output, "afterCursor", 512);
  if (typeof value.limit === "number" && Number.isSafeInteger(value.limit)) output.limit = value.limit;
  return output;
}

function plainObject(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
}

function copyRoomWorkId(value: Record<string, unknown>, output: Record<string, unknown>, key: string, max = 128): void {
  if (typeof value[key] === "string") output[key] = value[key].trim().slice(0, max);
}

function copyRoomWorkString(value: Record<string, unknown>, output: Record<string, unknown>, key: string, max: number): void {
  if (typeof value[key] === "string") output[key] = value[key].slice(0, max);
}

function copyRoomWorkVersions(value: Record<string, unknown>, output: Record<string, unknown>, includeGeneration = true): void {
  for (const key of ["expectedVersion", ...(includeGeneration ? ["expectedGeneration"] : [])]) {
    if (typeof value[key] === "number" && Number.isSafeInteger(value[key])) output[key] = value[key];
  }
}

function copyRoomWorkAttachments(value: Record<string, unknown>, output: Record<string, unknown>): void {
  if (!Array.isArray(value.attachments)) return;
  if (value.attachments.length > 100) throw new Error("workspace_attachment_count_invalid");
  output.attachments = value.attachments.map((item) => workspaceAttachmentResourceRef(item));
}

function opaque(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

function sanitizeWorkspaceRoomOperation(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const value = input as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const key of ["roomId", "accountId", "name", "operationId", "role", "state", "defaultAgentId"]) {
    if (typeof value[key] === "string") output[key] = value[key].slice(0, key === "name" ? 240 : 128);
  }
  if (value.parentRoomId === null) output.parentRoomId = null;
  if (typeof value.parentRoomId === "string") output.parentRoomId = value.parentRoomId.slice(0, 128);
  for (const key of ["expectedWorkspaceVersion", "expectedRoomVersion", "expectedVersion"]) {
    if (typeof value[key] === "number" && Number.isSafeInteger(value[key])) output[key] = value[key];
  }
  if (typeof value.defaultAgentVersion === "number" && Number.isSafeInteger(value.defaultAgentVersion)) output.defaultAgentVersion = value.defaultAgentVersion;
  copyWorkspaceTargetInput(value, output);
  const permission = sanitizeWorkspaceRoomAgentPermission(value.agentPermission);
  if (permission) output.agentPermission = permission;
  const newAgent = sanitizeWorkspaceRoomNewAgent(value.newAgent);
  if (newAgent) output.newAgent = newAgent;
  return output;
}

function sanitizeWorkspaceRoomAgentPermission(input: unknown): Record<string, boolean> | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const value = input as Record<string, unknown>;
  const canView = typeof value.canView === "boolean" ? value.canView : value.can_view;
  const canEdit = typeof value.canEdit === "boolean" ? value.canEdit : value.can_edit;
  const canExecute = typeof value.canExecute === "boolean" ? value.canExecute : value.can_execute;
  if (typeof canView !== "boolean" || typeof canEdit !== "boolean" || typeof canExecute !== "boolean") return undefined;
  return { can_view: canView, can_edit: canEdit, can_execute: canExecute };
}

function sanitizeWorkspaceRoomNewAgent(input: unknown): Record<string, unknown> | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const value = input as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  const name = typeof value.name === "string" ? value.name.slice(0, 200) : "";
  const role = typeof value.role === "string" ? value.role.slice(0, 500) : "";
  const instructions = typeof value.instructions === "string" ? value.instructions.slice(0, 20_000) : "";
  const backendId = typeof value.backendId === "string" ? value.backendId : value.backend_id;
  if (name) output.name = name;
  if (role) output.role = role;
  if (instructions) output.instructions = instructions;
  if (typeof backendId === "string") output.backend_id = backendId.slice(0, 128);
  if (typeof value.enabled === "boolean") output.enabled = value.enabled;
  const permission = sanitizeWorkspaceRoomAgentPermission(value.permission);
  if (permission) output.permission = permission;
  return Object.keys(output).length > 0 ? output : undefined;
}

function sanitizeWorkspaceAgentBackendList(input: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(input)) throw new Error("workspace_agent_backend_response_invalid");
  return input.map((entry) => {
    const value = plainObject(entry);
    const id = typeof value.id === "string" ? value.id.slice(0, 512) : "";
    const kind = typeof value.kind === "string" ? value.kind : "";
    const connectionState = typeof value.connection_state === "string" ? value.connection_state : "";
    if (!id || !["mock", "samurai_native", "claude_code", "codex", "external"].includes(kind)
      || !["ready", "unconfigured", "disabled", "degraded", "unverified"].includes(connectionState)
      || typeof value.configured !== "boolean" || typeof value.enabled !== "boolean"
      || typeof value.label !== "string" || !value.label.trim()) {
      throw new Error("workspace_agent_backend_response_invalid");
    }
    const output: Record<string, unknown> = {
      id,
      kind,
      label: value.label.trim().slice(0, 200),
      configured: value.configured,
      enabled: value.enabled,
      connection_state: connectionState
    };
    if (typeof value.reason === "string" && value.reason.trim()) output.reason = value.reason.trim().slice(0, 256);
    return output;
  });
}

function sanitizeWorkspaceLearningOperation(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const value = input as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  copyWorkspaceTargetInput(value, output);
  for (const key of ["scopeKind", "roomId", "operationId", "engineId", "model", "secretRef"]) {
    if (typeof value[key] === "string") output[key] = value[key].slice(0, key === "model" ? 512 : 128);
  }
  for (const key of ["enabled", "clearEngineId", "clearModel", "clearSecretRef", "clearCurrencyLimit", "clearTokenLimit", "removeOverride"]) {
    if (typeof value[key] === "boolean") output[key] = value[key];
  }
  for (const key of ["expectedVersion", "currencyLimit", "tokenLimit"]) {
    if (typeof value[key] === "number" && Number.isFinite(value[key])) output[key] = value[key];
  }
  return output;
}

function sanitizeWorkspaceRoomMemberListInput(input: unknown): Record<string, unknown> {
  if (typeof input === "string") return { roomId: input.slice(0, 128) };
  const value = plainObject(input);
  const output: Record<string, unknown> = {};
  copyWorkspaceTargetInput(value, output);
  copyRoomWorkId(value, output, "roomId");
  return output;
}

function sanitizeWorkspaceLearningSettingsReadInput(input: unknown): Record<string, unknown> {
  if (typeof input === "string") return { roomId: input.slice(0, 128) };
  const value = plainObject(input);
  const output: Record<string, unknown> = {};
  copyWorkspaceTargetInput(value, output);
  copyRoomWorkId(value, output, "roomId");
  return output;
}

function sanitizeWorkspaceCompletionOperation(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const value = input as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  copyWorkspaceTargetInput(value, output);
  for (const key of ["scopeKind", "roomId", "kind", "resourceId", "operationId", "knowledgeKind", "expectedVersion"]) {
    if (typeof value[key] === "string") output[key] = value[key].slice(0, 128);
    if (key === "expectedVersion" && typeof value[key] === "number" && Number.isSafeInteger(value[key])) output[key] = value[key];
  }
  for (const key of ["title", "content", "reason", "query"]) {
    if (typeof value[key] === "string") output[key] = value[key].slice(0, key === "content" ? 200_000 : key === "query" ? 2_000 : key === "reason" ? 4_000 : 20_000);
  }
  if (typeof value.fixed === "boolean") output.fixed = value.fixed;
  if (typeof value.archived === "boolean") output.archived = value.archived;
  if (value.includeArchived === true) output.includeArchived = true;
  if (typeof value.limit === "number" && Number.isSafeInteger(value.limit)) output.limit = value.limit;
  if (value.metadata && typeof value.metadata === "object" && !Array.isArray(value.metadata)) output.metadata = value.metadata;
  if (!input || typeof input !== "object" || Array.isArray(input)) return output;
  return output;
}

function sanitizeWorkspaceWikiOperation(input: unknown): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  if (!input || typeof input !== "object" || Array.isArray(input)) return output;
  const value = input as Record<string, unknown>;
  copyWorkspaceTargetInput(value, output);
  for (const key of ["roomId", "wikiId", "operationId", "contentLocale", "knowledgeKind", "state"]) {
    if (typeof value[key] === "string") output[key] = value[key].slice(0, key === "state" ? 16 : 128);
  }
  for (const key of ["title", "content", "slug", "reason", "query"]) {
    if (typeof value[key] === "string") output[key] = value[key].slice(0, key === "content" ? 200_000 : key === "reason" || key === "query" ? 4_000 : 20_000);
  }
  if (Array.isArray(value.tags)) output.tags = value.tags.filter((tag): tag is string => typeof tag === "string").slice(0, 100).map((tag) => tag.slice(0, 240));
  if (value.includeArchived === true) output.includeArchived = true;
  return output;
}

function sanitizeWorkspaceCollectionOperation(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const value = input as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  copyWorkspaceTargetInput(value, output);
  for (const key of ["roomId", "collectionId", "recordId", "patchId", "operationId"]) {
    if (typeof value[key] === "string") output[key] = value[key].slice(0, 160);
  }
  if (typeof value.expectedVersion === "number" && Number.isSafeInteger(value.expectedVersion)) output.expectedVersion = value.expectedVersion;
  for (const key of ["schema", "data", "changes"]) {
    if (value[key] && typeof value[key] === "object" && !Array.isArray(value[key])) output[key] = value[key];
  }
  if (value.operation && typeof value.operation === "object" && !Array.isArray(value.operation)) output.operation = value.operation;
  return output;
}

function sanitizeWorkspaceAutomationOperation(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const value = input as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  copyWorkspaceTargetInput(value, output);
  for (const key of ["roomId", "jobId", "operationId", "kind", "state", "connectionId", "nextRunAt"]) {
    if (typeof value[key] === "string") output[key] = value[key].slice(0, key === "nextRunAt" ? 80 : 160);
  }
  for (const key of ["title", "schedule", "targetInstruction"]) {
    if (typeof value[key] === "string") output[key] = value[key].slice(0, key === "targetInstruction" ? 20_000 : 4_000);
  }
  for (const key of ["deliveryTarget", "sessionRef"]) {
    if (value[key] && typeof value[key] === "object" && !Array.isArray(value[key])) output[key] = value[key];
  }
  if (typeof value.enabled === "boolean") output.enabled = value.enabled;
  if (typeof value.maxAttempts === "number" && Number.isSafeInteger(value.maxAttempts)) output.maxAttempts = value.maxAttempts;
  return output;
}

function sanitizeWorkspaceArtifactOperation(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const value = input as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  copyWorkspaceTargetInput(value, output);
  for (const key of ["roomId", "artifactId", "revisionId", "baseRevisionId", "operationId", "kind", "locale", "mimeType", "encoding"]) {
    if (typeof value[key] === "string") output[key] = value[key].slice(0, 160);
  }
  if (typeof value.title === "string") output.title = value.title.slice(0, 20_000);
  if (typeof value.content === "string") output.content = value.content.slice(0, 50_000_000);
  else if (value.content instanceof Uint8Array) output.content = Array.from(value.content.slice(0, 50_000_000));
  else if (Array.isArray(value.content) && value.content.length <= 50_000_000 && value.content.every((item) => typeof item === "number" && Number.isInteger(item) && item >= 0 && item <= 255)) output.content = value.content;
  else if (value.content && typeof value.content === "object") output.content = value.content;
  if (Array.isArray(value.sourceLocales)) output.sourceLocales = value.sourceLocales.filter((item): item is string => typeof item === "string").slice(0, 20);
  if (value.metadata && typeof value.metadata === "object" && !Array.isArray(value.metadata)) output.metadata = value.metadata;
  if (value.operation && typeof value.operation === "object" && !Array.isArray(value.operation)) output.operation = value.operation;
  return output;
}

function sanitizeWorkspaceMemoryOperation(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const value = input as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  copyWorkspaceTargetInput(value, output);
  for (const key of ["roomId", "memoryId", "operationId"]) {
    if (typeof value[key] === "string") output[key] = value[key].slice(0, 160);
  }
  for (const key of ["query", "reason"]) {
    if (typeof value[key] === "string") output[key] = value[key].slice(0, key === "query" ? 2_000 : 4_000);
  }
  if (typeof value.limit === "number" && Number.isSafeInteger(value.limit)) output.limit = value.limit;
  if (value.includeArchived === true) output.includeArchived = true;
  return output;
}

function sanitizeQuickAskInput(input: unknown): { content: string; sourceFeature: "quick_ask" | "clipboard_text" | "selected_text" } {
  if (!input || typeof input !== "object" || !("content" in input)) {
    return { content: "", sourceFeature: "quick_ask" };
  }
  const content = typeof input.content === "string" ? input.content : "";
  const sourceFeature = "sourceFeature" in input && (input.sourceFeature === "clipboard_text" || input.sourceFeature === "selected_text")
    ? input.sourceFeature
    : "quick_ask";
  return { content: content.slice(0, 8000), sourceFeature };
}

function readArg(prefix: string): string | undefined {
  const value = process.argv.find((arg) => arg.startsWith(prefix));
  return value ? value.slice(prefix.length) : undefined;
}
