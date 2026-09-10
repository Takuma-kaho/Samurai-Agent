import {
  ActivityFailureSchema,
  ActivityVerificationRecordSchema,
  ArtifactContentEncodingSchema,
  ArtifactRecordSchema,
  ArtifactRevisionRecordSchema,
  GeneratedSurfaceDefinitionSchema,
  GeneratedSurfaceActionDeclarationSchema,
  GeneratedSurfaceRevisionRecordSchema,
  SurfaceInteractionRecordSchema,
  PublicAgentDmRecordSchema as CorePublicAgentDmRecordSchema,
  PublicRoomWorkAssigneeSchema as CorePublicRoomWorkAssigneeSchema,
  PublicRoomWorkAssignmentResultSchema as CorePublicRoomWorkAssignmentResultSchema,
  PublicRoomWorkCommentSchema as CorePublicRoomWorkCommentSchema,
  PublicRoomWorkControlSchema as CorePublicRoomWorkControlSchema,
  PublicRoomWorkInstructionSchema as CorePublicRoomWorkInstructionSchema,
  PublicRoomWorkReactionSchema as CorePublicRoomWorkReactionSchema,
  PublicRoomWorkRecordSchema as CorePublicRoomWorkRecordSchema,
  PublicRoomWorkViewSchema as CorePublicRoomWorkViewSchema,
  PublicRoomWorkResultResourceRefSchema as CorePublicRoomWorkResultResourceRefSchema,
  ResourceRefSchema,
  WorkspaceFileResourceRefSchema,
  RoomKindSchema as CoreRoomKindSchema,
  RoomWorkAssignmentStatusSchema as CoreRoomWorkAssignmentStatusSchema,
  RoomWorkStatusSchema as CoreRoomWorkStatusSchema,
  ResourceUsageRecordSchema,
  AgentBackendKindSchema,
  BackendConnectionStateSchema,
  AutomationAuthorizationStateSchema,
  AutomationJobStatusSchema,
  AutomationManagementStateSchema,
  AutomationRunStatusSchema,
  CaptureModeSchema,
  ExternalProviderRoleSchema,
  SupportedLocaleSchema,
  jsonValueSchema,
  toStrictJsonSchema,
  type JsonValue,
  type ResourceRef
} from "@samurai-agent/core-schemas";
import { z } from "zod";

/** Public API version. This is independent from an individual Event version. */
export const domainApiVersion = "1" as const;
export const DomainApiVersionSchema = z.literal(domainApiVersion);
export type DomainApiVersion = z.infer<typeof DomainApiVersionSchema>;

/** Only app-owned references cross the public boundary. Authority is rebuilt by the Server. */
export const PublicRequestContextSchema = z.object({
  room_id: z.string().trim().min(1).max(512).optional(),
  session_id: z.string().trim().min(1).max(512).optional()
}).strict();
export type PublicRequestContext = z.infer<typeof PublicRequestContextSchema>;

export const DomainApiRequestSchema = z.object({
  context: PublicRequestContextSchema,
  input: jsonValueSchema
}).strict();
export type DomainApiRequest = z.infer<typeof DomainApiRequestSchema>;

export const DomainApiResponseSchema = z.object({
  api_version: DomainApiVersionSchema,
  request_id: z.string().trim().min(1),
  result: jsonValueSchema,
  replayed: z.boolean()
}).strict();
export type DomainApiResponse<T = JsonValue> = Omit<z.infer<typeof DomainApiResponseSchema>, "result"> & { result: T };

export const DomainApiErrorSchema = z.object({
  code: z.string().trim().min(1).max(256),
  request_id: z.string().trim().min(1),
  details: z.record(jsonValueSchema).optional()
}).strict();
export type DomainApiError = z.infer<typeof DomainApiErrorSchema>;

export const DomainApiErrorResponseSchema = z.object({ error: DomainApiErrorSchema }).strict();

/** Public Workspace projections retain the fields required by the existing
 * Room/Agent clients while keeping authority out of the request context. */
export const PublicRoomRecordSchema = z.object({
  id: z.string().trim().min(1),
  workspace_id: z.string().trim().min(1),
  parent_room_id: z.string().trim().min(1).optional(),
  name: z.string().trim().min(1).max(200),
  /** Existing Rooms may be read before the default Agent is configured. */
  kind: CoreRoomKindSchema.optional(),
  default_agent_id: z.string().trim().min(1).optional(),
  default_agent_version: z.number().int().positive().optional(),
  version: z.number().int().nonnegative(),
  can_manage: z.boolean().optional(),
  can_execute: z.boolean().optional(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime()
}).strict();
export type PublicRoomRecord = z.infer<typeof PublicRoomRecordSchema>;

/** Room creation may select an existing Agent or create one together with its
 * initial permission and default assignment. The Server owns the transaction
 * and the authenticated creator; neither is accepted from this DTO. */
export const PublicRoomAgentPermissionSchema = z.object({
  can_view: z.boolean(),
  can_edit: z.boolean(),
  can_execute: z.boolean()
}).strict().refine((value) => (!value.can_edit && !value.can_execute) || value.can_view, "room_agent_view_required");
export type PublicRoomAgentPermission = z.infer<typeof PublicRoomAgentPermissionSchema>;

export const PublicRoomNewAgentSchema = z.object({
  name: z.string().trim().min(1).max(200),
  role: z.string().trim().min(1).max(500),
  instructions: z.string().trim().min(1).max(20_000),
  backend_id: z.string().trim().min(1).max(512),
  enabled: z.boolean().default(true),
  permission: PublicRoomAgentPermissionSchema.optional()
}).strict();
export type PublicRoomNewAgent = z.input<typeof PublicRoomNewAgentSchema>;

export const PublicRoomCreateInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  parent_room_id: z.string().trim().min(1).max(512).optional(),
  default_agent_id: z.string().trim().min(1).max(512).optional(),
  default_agent_version: z.number().int().positive().optional(),
  new_agent: PublicRoomNewAgentSchema.optional(),
  agent_permission: PublicRoomAgentPermissionSchema.optional()
}).strict().superRefine((value, issue) => {
  if (value.default_agent_id !== undefined && value.new_agent !== undefined) {
    issue.addIssue({ code: z.ZodIssueCode.custom, path: ["default_agent_id"], message: "room_default_agent_selection_conflict" });
  }
  if (value.agent_permission !== undefined && value.default_agent_id === undefined && value.new_agent === undefined) {
    issue.addIssue({ code: z.ZodIssueCode.custom, path: ["agent_permission"], message: "room_agent_permission_target_required" });
  }
  if (value.default_agent_version !== undefined && value.default_agent_id === undefined) {
    issue.addIssue({ code: z.ZodIssueCode.custom, path: ["default_agent_version"], message: "room_default_agent_required" });
  }
  const defaultPermission = value.agent_permission ?? value.new_agent?.permission;
  if ((value.default_agent_id !== undefined || value.new_agent !== undefined)
    && defaultPermission !== undefined
    && (!defaultPermission.can_view || !defaultPermission.can_execute)) {
    issue.addIssue({ code: z.ZodIssueCode.custom, path: ["agent_permission"], message: "room_default_agent_permission_required" });
  }
  if (value.agent_permission !== undefined && value.new_agent?.permission !== undefined
    && (value.agent_permission.can_view !== value.new_agent.permission.can_view
      || value.agent_permission.can_edit !== value.new_agent.permission.can_edit
      || value.agent_permission.can_execute !== value.new_agent.permission.can_execute)) {
    issue.addIssue({ code: z.ZodIssueCode.custom, path: ["agent_permission"], message: "room_agent_permission_conflict" });
  }
});
export type PublicRoomCreateInput = z.input<typeof PublicRoomCreateInputSchema>;

export const PublicAgentRecordSchema = z.object({
  id: z.string().trim().min(1),
  workspace_id: z.string().trim().min(1),
  name: z.string().trim().min(1).max(200),
  description: z.string(),
  role: z.string().trim().min(1).max(500),
  instructions: z.string().trim().min(1).max(20_000),
  backend_id: z.string().trim().min(1),
  enabled: z.boolean(),
  status: z.string().trim().min(1),
  version: z.number().int().nonnegative(),
  created_by: z.string().trim().min(1),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime()
}).strict();
export type PublicAgentRecord = z.infer<typeof PublicAgentRecordSchema>;

/** Host-owned backend availability projection. Sensitive backend metadata,
 * credentials, paths, runtime capabilities, and diagnostics are excluded. */
export const PublicAgentBackendRecordSchema = z.object({
  id: z.string().trim().min(1).max(512),
  kind: AgentBackendKindSchema,
  label: z.string().trim().min(1).max(200),
  configured: z.boolean(),
  enabled: z.boolean(),
  connection_state: BackendConnectionStateSchema,
  reason: z.string().trim().min(1).max(256).optional()
}).strict();
export type PublicAgentBackendRecord = z.infer<typeof PublicAgentBackendRecordSchema>;

/**
 * Room-first collaboration DTOs. These projections intentionally contain
 * only identifiers, user-authored text, versions, and state needed by a
 * client. Backend Session references, credentials, and raw diagnostics stay
 * behind the Server boundary.
 */
const publicCollaborationId = z.string().trim().min(1).max(512);
const publicCollaborationVersion = z.number().int().positive();
const publicCollaborationGeneration = z.number().int().nonnegative();
const publicCollaborationTimestamp = z.string().datetime();

export const PublicRoomKindSchema = CoreRoomKindSchema;
export type PublicRoomKind = z.infer<typeof PublicRoomKindSchema>;

/** Server-issued resource references used by work, instruction, and comment attachments. */
export const PublicRoomWorkAttachmentSchema = WorkspaceFileResourceRefSchema;
export type PublicRoomWorkAttachment = z.infer<typeof PublicRoomWorkAttachmentSchema>;

/**
 * A Completion resource reference that has already been resolved by the
 * Server.  Room Work never accepts a generic ResourceRef here: a caller may
 * reference only a Knowledge or Skill, and the URI/label are always rebuilt
 * from the selected immutable Completion version on the Server.
 */
export const PublicRoomWorkResourceRefSchema = z.object({
  kind: z.enum(["knowledge", "skill"]),
  id: publicCollaborationId,
  uri: z.string().trim().min(1).max(4_096),
  version: z.string().regex(/^[1-9][0-9]*$/),
  label: z.string().trim().min(1).max(4_096).optional()
}).strict();
export type PublicRoomWorkResourceRef = z.infer<typeof PublicRoomWorkResourceRefSchema>;

/** Client-side selector for a server-owned Completion resource. */
export const PublicRoomWorkResourceRefInputSchema = z.object({
  kind: z.enum(["knowledge", "skill"]),
  id: publicCollaborationId,
  version: z.union([
    z.number().int().positive(),
    z.string().regex(/^[1-9][0-9]*$/)
  ])
}).strict();
export type PublicRoomWorkResourceRefInput = z.input<typeof PublicRoomWorkResourceRefInputSchema>;

/** Server-issued completion refs exposed on a finished Work assignment. */
export const PublicRoomWorkResultResourceRefSchema = CorePublicRoomWorkResultResourceRefSchema;
export type PublicRoomWorkResultResourceRef = z.infer<typeof PublicRoomWorkResultResourceRefSchema>;

export const PublicRoomDefaultAgentRecordSchema = z.object({
  room_id: publicCollaborationId,
  agent_id: publicCollaborationId,
  agent_version: publicCollaborationVersion,
  enabled: z.boolean(),
  can_execute: z.boolean(),
  version: publicCollaborationVersion,
  updated_at: publicCollaborationTimestamp
}).strict();
export type PublicRoomDefaultAgentRecord = z.infer<typeof PublicRoomDefaultAgentRecordSchema>;
/** Short alias used by clients that treat the default Agent as a Room field. */
export const PublicRoomDefaultAgentSchema = PublicRoomDefaultAgentRecordSchema;
export type PublicRoomDefaultAgent = PublicRoomDefaultAgentRecord;

export const PublicRoomWorkStatusSchema = CoreRoomWorkStatusSchema;
export type PublicRoomWorkStatus = z.infer<typeof PublicRoomWorkStatusSchema>;

export const PublicRoomWorkAssigneeSchema = CorePublicRoomWorkAssigneeSchema;
export type PublicRoomWorkAssignee = z.infer<typeof PublicRoomWorkAssigneeSchema>;
export const PublicRoomWorkAssignmentResultSchema = CorePublicRoomWorkAssignmentResultSchema;
export type PublicRoomWorkAssignmentResult = z.infer<typeof PublicRoomWorkAssignmentResultSchema>;

export const PublicRoomWorkInstructionSchema = CorePublicRoomWorkInstructionSchema.extend({
  resource_refs: z.array(PublicRoomWorkResourceRefSchema).max(32).default([])
}).strict();
export type PublicRoomWorkInstruction = z.infer<typeof PublicRoomWorkInstructionSchema>;

export const PublicRoomWorkCommentSchema = CorePublicRoomWorkCommentSchema;
export type PublicRoomWorkComment = z.infer<typeof PublicRoomWorkCommentSchema>;

/** Explicit human reaction state. It is not an approval and does not start a Run. */
export const PublicRoomWorkReactionSchema = CorePublicRoomWorkReactionSchema;
export type PublicRoomWorkReaction = z.infer<typeof PublicRoomWorkReactionSchema>;
/** Compatibility alias for callers that name all public projections `Record`. */
export const PublicRoomWorkReactionRecordSchema = PublicRoomWorkReactionSchema;
export type PublicRoomWorkReactionRecord = PublicRoomWorkReaction;

export const PublicRoomWorkControlSchema = CorePublicRoomWorkControlSchema;
export type PublicRoomWorkControl = z.infer<typeof PublicRoomWorkControlSchema>;

export const PublicRoomWorkRecordSchema = CorePublicRoomWorkRecordSchema.extend({
  resource_refs: z.array(PublicRoomWorkResourceRefSchema).max(32).default([])
}).strict();
export type PublicRoomWorkRecord = z.infer<typeof PublicRoomWorkRecordSchema>;

export const PublicRoomWorkViewSchema = CorePublicRoomWorkViewSchema.extend({
  resource_refs: z.array(PublicRoomWorkResourceRefSchema).max(32).default([]),
  instructions: z.array(PublicRoomWorkInstructionSchema).max(1_000)
}).strict();
export type PublicRoomWorkView = z.infer<typeof PublicRoomWorkViewSchema>;

/** Agent DM is a private Room projection. The caller's Account is inferred by the Server. */
export const PublicAgentDmRecordSchema = CorePublicAgentDmRecordSchema;
export type PublicAgentDmRecord = z.infer<typeof PublicAgentDmRecordSchema>;

export const PublicRoomRequestContextSchema = z.object({ room_id: publicCollaborationId }).strict();
export type PublicRoomRequestContext = z.infer<typeof PublicRoomRequestContextSchema>;

const publicRoomWorkInstructionOrAttachment = (bodyField: "instruction" | "body") => z.object({
  ...(bodyField === "instruction"
    ? { instruction: z.string().trim().min(1).max(1_000_000).optional() }
    : { body: z.string().max(100_000).optional() }),
  attachments: z.array(PublicRoomWorkAttachmentSchema).max(100).default([])
}).strict();

const publicRoomWorkInstructionOrAttachmentOrResource = (bodyField: "instruction" | "body") => publicRoomWorkInstructionOrAttachment(bodyField).extend({
  resource_refs: z.array(PublicRoomWorkResourceRefInputSchema).max(32).default([])
}).strict();

const requirePublicRoomWorkTextOrAttachment = <T extends z.ZodTypeAny>(schema: T, bodyField: "instruction" | "body") => schema.superRefine((input: Record<string, unknown>, issue) => {
  const text = input[bodyField];
  const attachments = input.attachments;
  const resourceRefs = input.resource_refs;
  if (!(typeof text === "string" && text.trim())
    && !(Array.isArray(attachments) && attachments.length > 0)
    && !(Array.isArray(resourceRefs) && resourceRefs.length > 0)) {
    issue.addIssue({ code: z.ZodIssueCode.custom, path: [bodyField], message: "room_work_requires_text_or_attachment" });
  }
});

export const PublicRoomWorkCreateInputSchema = requirePublicRoomWorkTextOrAttachment(publicRoomWorkInstructionOrAttachmentOrResource("instruction").extend({
  agent_id: publicCollaborationId.optional()
}).strict(), "instruction");
export type PublicRoomWorkCreateInput = z.input<typeof PublicRoomWorkCreateInputSchema>;

export const PublicRoomWorkReplyInputSchema = requirePublicRoomWorkTextOrAttachment(publicRoomWorkInstructionOrAttachmentOrResource("instruction").extend({
  work_id: publicCollaborationId,
  assignee_id: publicCollaborationId.optional(),
  expected_version: publicCollaborationVersion.optional(),
  expected_generation: publicCollaborationGeneration.optional()
}).strict(), "instruction");
export type PublicRoomWorkReplyInput = z.input<typeof PublicRoomWorkReplyInputSchema>;

export const PublicRoomWorkCommentCreateInputSchema = requirePublicRoomWorkTextOrAttachment(publicRoomWorkInstructionOrAttachment("body").extend({
  work_id: publicCollaborationId,
  expected_version: publicCollaborationVersion.optional()
}).strict(), "body");
export type PublicRoomWorkCommentCreateInput = z.input<typeof PublicRoomWorkCommentCreateInputSchema>;

export const PublicRoomWorkCommentApplyInputSchema = z.object({
  work_id: publicCollaborationId,
  comment_id: publicCollaborationId,
  comment_version: publicCollaborationVersion,
  expected_version: publicCollaborationVersion.optional(),
  expected_generation: publicCollaborationGeneration.optional(),
  assignee_id: publicCollaborationId.optional()
}).strict();
export type PublicRoomWorkCommentApplyInput = z.input<typeof PublicRoomWorkCommentApplyInputSchema>;

export const PublicRoomWorkCommentReactionSetInputSchema = z.object({
  work_id: publicCollaborationId,
  comment_id: publicCollaborationId,
  reaction: z.literal("like"),
  enabled: z.boolean(),
  expected_version: publicCollaborationVersion.optional()
}).strict();
export type PublicRoomWorkCommentReactionSetInput = z.infer<typeof PublicRoomWorkCommentReactionSetInputSchema>;

export const PublicRoomDefaultAgentSetInputSchema = z.object({
  agent_id: publicCollaborationId,
  expected_version: publicCollaborationVersion.optional()
}).strict();
export type PublicRoomDefaultAgentSetInput = z.input<typeof PublicRoomDefaultAgentSetInputSchema>;

/** Room-local Agent membership is managed separately from the Agent profile.
 * Setting a permission creates the membership when it does not exist. */
export const PublicRoomAgentPermissionSetInputSchema = z.object({
  agent_id: publicCollaborationId,
  can_view: z.boolean(),
  can_edit: z.boolean(),
  can_execute: z.boolean()
}).strict().refine((value) => (!value.can_edit && !value.can_execute) || value.can_view, "room_agent_view_required");
export type PublicRoomAgentPermissionSetInput = z.infer<typeof PublicRoomAgentPermissionSetInputSchema>;

/** Removing a Room Agent is a permission revocation. The Server keeps the
 * historical row and returns it with all capabilities disabled. */
export const PublicRoomAgentRemoveInputSchema = z.object({
  agent_id: publicCollaborationId
}).strict();
export type PublicRoomAgentRemoveInput = z.infer<typeof PublicRoomAgentRemoveInputSchema>;

export const PublicRoomAgentPermissionRecordSchema = z.object({
  id: publicCollaborationId,
  room_id: publicCollaborationId,
  agent_id: publicCollaborationId,
  can_view: z.boolean(),
  can_edit: z.boolean(),
  can_execute: z.boolean(),
  version: publicCollaborationVersion,
  created_by: publicCollaborationId,
  created_at: publicCollaborationTimestamp,
  updated_at: publicCollaborationTimestamp,
  removed: z.boolean()
}).strict();
export type PublicRoomAgentPermissionRecord = z.infer<typeof PublicRoomAgentPermissionRecordSchema>;

export const PublicRoomMemberRecordSchema = z.object({
  id: publicCollaborationId,
  room_id: publicCollaborationId,
  account_id: publicCollaborationId,
  role: z.enum(["owner", "admin", "member", "guest"]),
  state: z.enum(["active", "revoked"]),
  version: publicCollaborationVersion,
  created_at: publicCollaborationTimestamp,
  updated_at: publicCollaborationTimestamp,
  revoked_at: publicCollaborationTimestamp.optional()
}).strict();
export type PublicRoomMemberRecord = z.infer<typeof PublicRoomMemberRecordSchema>;

export const PublicRoomMemberListRecordSchema = z.object({
  humans: z.array(PublicRoomMemberRecordSchema),
  agents: z.array(PublicRoomAgentPermissionRecordSchema)
}).strict();
export type PublicRoomMemberListRecord = z.infer<typeof PublicRoomMemberListRecordSchema>;

export const PublicAgentDmOpenInputSchema = z.object({ agent_id: publicCollaborationId }).strict();
export type PublicAgentDmOpenInput = z.infer<typeof PublicAgentDmOpenInputSchema>;

export const PublicRoomWorkListInputSchema = z.object({
  status: PublicRoomWorkStatusSchema.optional(),
  cursor: z.string().trim().min(1).max(512).optional(),
  limit: z.number().int().positive().max(200).default(50)
}).strict();
export type PublicRoomWorkListInput = z.input<typeof PublicRoomWorkListInputSchema>;

export const PublicRoomWorkViewInputSchema = z.object({ work_id: publicCollaborationId }).strict();
export type PublicRoomWorkViewInput = z.input<typeof PublicRoomWorkViewInputSchema>;

export const PublicRoomWorkStopInputSchema = z.object({
  work_id: publicCollaborationId,
  reason: z.string().trim().min(1).max(2_000).optional(),
  expected_version: publicCollaborationVersion.optional(),
  expected_generation: publicCollaborationGeneration.optional()
}).strict();
export type PublicRoomWorkStopInput = z.input<typeof PublicRoomWorkStopInputSchema>;

export const PublicRoomWorkAssigneeStopInputSchema = z.object({
  work_id: publicCollaborationId,
  assignee_id: publicCollaborationId,
  reason: z.string().trim().min(1).max(2_000).optional(),
  expected_version: publicCollaborationVersion.optional(),
  expected_generation: publicCollaborationGeneration.optional()
}).strict();
export type PublicRoomWorkAssigneeStopInput = z.input<typeof PublicRoomWorkAssigneeStopInputSchema>;

export const PublicRoomWorkAssigneeReassignInputSchema = z.object({
  work_id: publicCollaborationId,
  assignee_id: publicCollaborationId,
  agent_id: publicCollaborationId,
  expected_version: publicCollaborationVersion.optional(),
  expected_generation: publicCollaborationGeneration.optional()
}).strict();
export type PublicRoomWorkAssigneeReassignInput = z.input<typeof PublicRoomWorkAssigneeReassignInputSchema>;

/** Delegation accepts only the child intent and graph references. The Server
 * derives the authenticated requester, Work, and parent binding from the
 * operation context; none of those authority fields are client-controlled. */
export const PublicRoomWorkAssigneeDelegateInputSchema = z.object({
  work_id: publicCollaborationId,
  assignee_id: publicCollaborationId,
  agent_id: publicCollaborationId,
  instruction: z.string().trim().min(1).max(1_000_000),
  dependency_assignee_ids: z.array(publicCollaborationId).max(100).default([]),
  attachments: z.array(PublicRoomWorkAttachmentSchema).max(100).default([]),
  expected_version: publicCollaborationVersion.optional(),
  expected_generation: publicCollaborationGeneration.optional()
}).strict();
export type PublicRoomWorkAssigneeDelegateInput = z.input<typeof PublicRoomWorkAssigneeDelegateInputSchema>;

export const PublicRoomDomainApiRequestSchema = z.object({
  context: PublicRoomRequestContextSchema,
  input: jsonValueSchema
}).strict();
export type PublicRoomDomainApiRequest = z.infer<typeof PublicRoomDomainApiRequestSchema>;

/**
 * Account-scoped Workspace metadata.  Organization membership is deliberately
 * not part of the access contract: a missing organization_id means that the
 * Workspace is standalone on this Server.
 */
export const PublicWorkspaceSummarySchema = z.object({
  id: z.string().trim().min(1).max(512),
  organization_id: z.string().trim().min(1).max(512).optional(),
  name: z.string().trim().min(1).max(200),
  state: z.enum(["active", "archived", "deleted", "read_only"]),
  version: z.number().int().nonnegative(),
  hosting_mode: z.enum(["hosted", "self_host"]).optional(),
  database_placement: z.enum(["shared", "dedicated"]).optional(),
  role: z.enum(["owner", "admin", "member", "guest"]).optional(),
  access: z.enum(["granted", "none"]).optional(),
  created_by: z.string().trim().min(1).max(512).optional(),
  created_at: z.string().datetime().optional(),
  updated_at: z.string().datetime().optional()
}).strict();
export type PublicWorkspaceSummary = z.infer<typeof PublicWorkspaceSummarySchema>;

/** A stable account directory envelope used by Native and Browser clients. */
export const PublicWorkspaceDirectorySchema = z.object({
  workspaces: z.array(PublicWorkspaceSummarySchema).max(10_000),
  errors: z.array(z.object({
    connection_id: z.string().trim().min(1).max(512),
    code: z.string().trim().min(1).max(256),
    message: z.string().trim().min(1).max(2_000)
  }).strict()).max(256).optional()
}).strict();
export type PublicWorkspaceDirectory = z.infer<typeof PublicWorkspaceDirectorySchema>;

/** Organization projections expose tenant metadata, not Workspace/Room content. */
export const PublicOrganizationRecordSchema = z.object({
  id: z.string().trim().min(1).max(512),
  name: z.string().trim().min(1).max(200),
  icon: z.string().trim().max(1_024).optional(),
  description: z.string().max(20_000).optional(),
  status: z.enum(["active", "deleted"]),
  version: z.number().int().positive(),
  created_by: z.string().trim().min(1).max(512),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  deleted_at: z.string().datetime().optional()
}).strict();
export type PublicOrganizationRecord = z.infer<typeof PublicOrganizationRecordSchema>;

/** Member projections intentionally omit email, credentials, and private account fields. */
export const PublicOrganizationMembershipRecordSchema = z.object({
  id: z.string().trim().min(1).max(512),
  organization_id: z.string().trim().min(1).max(512),
  account_id: z.string().trim().min(1).max(512),
  role: z.enum(["owner", "admin", "member", "guest"]),
  state: z.enum(["active", "removed"]),
  version: z.number().int().positive(),
  joined_at: z.string().datetime(),
  removed_at: z.string().datetime().optional(),
  created_by: z.string().trim().min(1).max(512),
  updated_by: z.string().trim().min(1).max(512).optional(),
  display_name: z.string().trim().min(1).max(200).optional(),
  updated_at: z.string().datetime()
}).strict();
export type PublicOrganizationMembershipRecord = z.infer<typeof PublicOrganizationMembershipRecordSchema>;

/** Invitation projections never contain a raw invitation token. */
export const PublicOrganizationInvitationRecordSchema = z.object({
  id: z.string().trim().min(1).max(512),
  organization_id: z.string().trim().min(1).max(512),
  target_account_id: z.string().trim().min(1).max(512).optional(),
  role: z.enum(["owner", "admin", "member", "guest"]),
  status: z.enum(["pending", "accepted", "revoked", "expired"]),
  expires_at: z.string().datetime(),
  accepted_at: z.string().datetime().optional(),
  revoked_at: z.string().datetime().optional(),
  issued_by: z.string().trim().min(1).max(512),
  version: z.number().int().positive(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime()
}).strict();
export type PublicOrganizationInvitationRecord = z.infer<typeof PublicOrganizationInvitationRecordSchema>;

/** Only the issue response may carry an ephemeral one-time token. */
export const PublicOrganizationInvitationIssueResultSchema = z.object({
  invitation: PublicOrganizationInvitationRecordSchema,
  one_time_token: z.string().trim().min(1).max(2_048).optional()
}).strict();
export type PublicOrganizationInvitationIssueResult = z.infer<typeof PublicOrganizationInvitationIssueResultSchema>;

/** Workspace list results are metadata-only and contain no Room or message data. */
export const PublicOrganizationWorkspaceRecordSchema = z.object({
  id: z.string().trim().min(1).max(512),
  /** Omitted for a standalone Workspace projection. */
  organization_id: z.string().trim().min(1).max(512).optional(),
  name: z.string().trim().min(1).max(200),
  state: z.enum(["active", "archived", "deleted"]),
  version: z.number().int().positive(),
  created_by: z.string().trim().min(1).max(512),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  deleted_at: z.string().datetime().optional(),
  can_access: z.boolean(),
  role: z.enum(["owner", "admin", "member", "guest"]).optional()
}).strict();
export type PublicOrganizationWorkspaceRecord = z.infer<typeof PublicOrganizationWorkspaceRecordSchema>;

export const PublicOrganizationWorkspaceMembershipRecordSchema = z.object({
  id: z.string().trim().min(1).max(512),
  /** Organization provenance is optional for direct Workspace membership. */
  organization_id: z.string().trim().min(1).max(512).optional(),
  workspace_id: z.string().trim().min(1).max(512),
  account_id: z.string().trim().min(1).max(512),
  role: z.enum(["owner", "admin", "member", "guest"]),
  state: z.enum(["active", "revoked"]),
  version: z.number().int().positive(),
  joined_at: z.string().datetime(),
  revoked_at: z.string().datetime().optional(),
  created_by: z.string().trim().min(1).max(512),
  updated_by: z.string().trim().min(1).max(512).optional(),
  updated_at: z.string().datetime()
}).strict();
export type PublicOrganizationWorkspaceMembershipRecord = z.infer<typeof PublicOrganizationWorkspaceMembershipRecordSchema>;

/** Result of the explicit optional Organization association commands. */
export const PublicWorkspaceOrganizationAssociationResultSchema = z.object({
  workspace: PublicOrganizationWorkspaceRecordSchema,
  organization_id: z.string().trim().min(1).max(512).optional(),
  previous_organization_id: z.string().trim().min(1).max(512).optional(),
  added_guest_account_ids: z.array(z.string().trim().min(1).max(512)).max(10_000),
  event_id: z.string().trim().min(1).max(512).optional()
}).strict();
export type PublicWorkspaceOrganizationAssociationResult = z.infer<typeof PublicWorkspaceOrganizationAssociationResultSchema>;

export const PublicWorkspaceMoveMemberSummarySchema = z.object({
  account_id: z.string().trim().min(1).max(512),
  workspace_role: z.enum(["owner", "admin", "member", "guest"]),
  target_organization_role: z.enum(["owner", "admin", "member", "guest"]).optional(),
  will_add_as_guest: z.boolean()
}).strict();
export type PublicWorkspaceMoveMemberSummary = z.infer<typeof PublicWorkspaceMoveMemberSummarySchema>;

export const PublicWorkspaceMovePreflightSchema = z.object({
  operation_id: z.string().trim().min(1).max(512),
  /** One side is omitted when attaching from or detaching to standalone. */
  source_organization_id: z.string().trim().min(1).max(512).optional(),
  target_organization_id: z.string().trim().min(1).max(512).optional(),
  workspace_id: z.string().trim().min(1).max(512),
  workspace_version: z.number().int().positive(),
  workspace_state: z.enum(["active", "archived", "deleted"]),
  existing_members: z.array(PublicWorkspaceMoveMemberSummarySchema).max(10_000),
  missing_members: z.array(PublicWorkspaceMoveMemberSummarySchema).max(10_000),
  requires_guest_confirmation: z.boolean(),
  write_blocked: z.boolean(),
  failure_conditions: z.array(z.string().trim().min(1).max(1_000)).max(100),
  expires_at: z.string().datetime(),
  created_at: z.string().datetime()
}).strict();
export type PublicWorkspaceMovePreflight = z.infer<typeof PublicWorkspaceMovePreflightSchema>;

export const PublicWorkspaceMoveResultSchema = z.object({
  operation_id: z.string().trim().min(1).max(512),
  workspace_id: z.string().trim().min(1).max(512),
  source_organization_id: z.string().trim().min(1).max(512).optional(),
  target_organization_id: z.string().trim().min(1).max(512).optional(),
  status: z.enum(["preflight", "queued", "running", "committed", "failed", "rolled_back"]),
  guest_membership_account_ids: z.array(z.string().trim().min(1).max(512)).max(10_000),
  event_id: z.string().trim().min(1).max(512).optional(),
  committed_at: z.string().datetime().optional(),
  failure_code: z.string().trim().min(1).max(256).optional()
}).strict();
export type PublicWorkspaceMoveResult = z.infer<typeof PublicWorkspaceMoveResultSchema>;

export const PublicWorkspaceMoveStatusRecordSchema = PublicWorkspaceMoveResultSchema.extend({ updated_at: z.string().datetime() }).strict();
export type PublicWorkspaceMoveStatusRecord = z.infer<typeof PublicWorkspaceMoveStatusRecordSchema>;

export const PublicWorkspaceBundleManifestSchema = z.object({
  schema_version: z.number().int().positive(),
  workspace_id: z.string().trim().min(1).max(512),
  /** Organization provenance is not imported into a standalone Workspace. */
  source_organization_id: z.string().trim().min(1).max(512).optional(),
  integrity_hash: z.string().regex(/^[a-f0-9]{64}$/i),
  record_counts: z.record(z.number().int().nonnegative())
}).strict();
export type PublicWorkspaceBundleManifest = z.infer<typeof PublicWorkspaceBundleManifestSchema>;

export const PublicWorkspaceBundleExportResultSchema = z.object({
  bundle_id: z.string().trim().min(1).max(512),
  workspace_id: z.string().trim().min(1).max(512),
  source_organization_id: z.string().trim().min(1).max(512).optional(),
  schema_version: z.number().int().positive(),
  integrity_hash: z.string().regex(/^[a-f0-9]{64}$/i),
  file_count: z.number().int().nonnegative(),
  byte_size: z.number().int().nonnegative(),
  manifest: PublicWorkspaceBundleManifestSchema,
  created_at: z.string().datetime()
}).strict();
export type PublicWorkspaceBundleExportResult = z.infer<typeof PublicWorkspaceBundleExportResultSchema>;

export const PublicWorkspaceBundleRestoreResultSchema = z.object({
  bundle_id: z.string().trim().min(1).max(512),
  workspace_id: z.string().trim().min(1).max(512),
  source_organization_id: z.string().trim().min(1).max(512).optional(),
  /** Restore defaults to standalone; attaching is a separate operation. */
  target_organization_id: z.string().trim().min(1).max(512).optional(),
  schema_version: z.number().int().positive(),
  integrity_hash: z.string().regex(/^[a-f0-9]{64}$/i),
  status: z.enum(["restored", "failed"]),
  restored_at: z.string().datetime(),
  event_id: z.string().trim().min(1).max(512).optional(),
  failure_code: z.string().trim().min(1).max(256).optional()
}).strict();
export type PublicWorkspaceBundleRestoreResult = z.infer<typeof PublicWorkspaceBundleRestoreResultSchema>;

/** Portable transfer metadata is safe to expose: file names are relative,
 * hashes are integrity evidence, and Organization provenance is optional. */
export const PublicWorkspaceTransferManifestSchema = z.object({
  format_version: z.literal(4),
  workspace_id: z.string().trim().min(1).max(512),
  exported_at: z.string().datetime(),
  source_organization_id: z.string().trim().min(1).max(512).optional(),
  schema_revision: z.number().int().positive().optional(),
  schema_version: z.number().int().positive().optional(),
  transfer_id: z.string().trim().min(1).max(512),
  base_v3_integrity_hash: z.string().regex(/^[a-f0-9]{64}$/i),
  excluded_maintenance_account_ids: z.array(z.string().trim().min(1).max(512)).max(10_000),
  files: z.record(z.string().regex(/^[a-f0-9]{64}$/i)),
  record_counts: z.record(z.number().int().nonnegative()),
  integrity_hash: z.string().regex(/^[a-f0-9]{64}$/i)
}).strict();
export type PublicWorkspaceTransferManifest = z.infer<typeof PublicWorkspaceTransferManifestSchema>;

export const PublicWorkspaceTransferStartResultSchema = z.object({
  transfer_id: z.string().trim().min(1).max(512),
  manifest: PublicWorkspaceTransferManifestSchema,
  bundle_download_path: z.string().trim().min(1).max(2_048)
}).strict();
export type PublicWorkspaceTransferStartResult = z.infer<typeof PublicWorkspaceTransferStartResultSchema>;

export const PublicWorkspaceTransferManifestResultSchema = z.object({
  manifest: PublicWorkspaceTransferManifestSchema
}).strict();
export type PublicWorkspaceTransferManifestResult = z.infer<typeof PublicWorkspaceTransferManifestResultSchema>;

/** Receipt is the only target-side proof accepted before source cutover. */
export const PublicWorkspaceTransferReceiptSchema = z.object({
  format_version: z.literal(1),
  transfer_id: z.string().trim().min(1).max(512),
  source_workspace_id: z.string().trim().min(1).max(512),
  source_integrity_hash: z.string().regex(/^[a-f0-9]{64}$/i),
  target_workspace_id: z.string().trim().min(1).max(512),
  imported_at: z.string().datetime(),
  target_integrity_hash: z.string().regex(/^[a-f0-9]{64}$/i)
}).strict().refine((value) => value.source_integrity_hash === value.target_integrity_hash, {
  message: "workspace_transfer_integrity_hash_mismatch"
});
export type PublicWorkspaceTransferReceipt = z.infer<typeof PublicWorkspaceTransferReceiptSchema>;

const publicManagementId = z.string().trim().min(1).max(512);
const publicManagementTimestamp = z.string().datetime();

export const PublicCompletionScopeSchema = z.object({
  kind: z.enum(["workspace", "room"]),
  roomId: publicManagementId.optional()
}).strict().superRefine((scope, issue) => {
  if (scope.kind === "room" && !scope.roomId) issue.addIssue({ code: z.ZodIssueCode.custom, path: ["roomId"], message: "room_id_required" });
  if (scope.kind === "workspace" && scope.roomId) issue.addIssue({ code: z.ZodIssueCode.custom, path: ["roomId"], message: "workspace_scope_room_forbidden" });
});
export type PublicCompletionScope = z.infer<typeof PublicCompletionScopeSchema>;

const publicCompletionWriteBase = z.object({
  resource_id: publicManagementId.optional(),
  scope_kind: z.enum(["workspace", "room"]),
  room_id: publicManagementId.optional(),
  kind: z.enum(["knowledge", "skill"]),
  knowledge_kind: z.enum(["fact", "decision", "explanation", "experience_rule"]).optional(),
  title: z.string().trim().min(1).max(200),
  content: z.string().min(1).max(8 * 1024 * 1024),
  metadata: z.record(jsonValueSchema).default({}),
  reason: z.string().trim().min(1).max(4_000),
  expected_version: z.number().int().nonnegative().optional(),
  ai_managed: z.boolean().optional(),
  support_files: z.array(z.object({
    path: z.string().trim().min(1).max(1_024),
    content_base64: z.string().min(1).max(8 * 1024 * 1024)
  }).strict()).max(99).optional()
}).strict();

function refinePublicCompletionWrite(value: z.infer<typeof publicCompletionWriteBase>, issue: z.RefinementCtx): void {
  if (value.scope_kind === "room" && !value.room_id) issue.addIssue({ code: z.ZodIssueCode.custom, path: ["room_id"], message: "room_id_required" });
  if (value.scope_kind === "workspace" && value.room_id) issue.addIssue({ code: z.ZodIssueCode.custom, path: ["room_id"], message: "workspace_scope_room_forbidden" });
  if (value.kind === "knowledge" && !value.knowledge_kind) issue.addIssue({ code: z.ZodIssueCode.custom, path: ["knowledge_kind"], message: "knowledge_kind_required" });
  if (value.kind === "skill" && value.knowledge_kind) issue.addIssue({ code: z.ZodIssueCode.custom, path: ["knowledge_kind"], message: "skill_knowledge_kind_forbidden" });
}

export const PublicCompletionResourceCreateInputSchema = publicCompletionWriteBase.superRefine(refinePublicCompletionWrite);
export type PublicCompletionResourceCreateInput = z.input<typeof PublicCompletionResourceCreateInputSchema>;
export const PublicCompletionResourceUpdateInputSchema = publicCompletionWriteBase.extend({
  resource_id: publicManagementId,
  expected_version: z.number().int().positive()
}).superRefine(refinePublicCompletionWrite);
export type PublicCompletionResourceUpdateInput = z.input<typeof PublicCompletionResourceUpdateInputSchema>;

export const PublicCompletionResourceListInputSchema = z.object({
  scope_kind: z.enum(["workspace", "room"]).optional(),
  room_id: publicManagementId.optional(),
  kind: z.enum(["knowledge", "skill", "policy"]).optional(),
  include_archived: z.boolean().default(false),
  limit: z.number().int().positive().max(100).default(50),
  cursor: publicManagementId.optional()
}).strict().superRefine((value, issue) => {
  if (value.scope_kind === "room" && !value.room_id) issue.addIssue({ code: z.ZodIssueCode.custom, path: ["room_id"], message: "room_id_required" });
  if (value.scope_kind === "workspace" && value.room_id) issue.addIssue({ code: z.ZodIssueCode.custom, path: ["room_id"], message: "workspace_scope_room_forbidden" });
});
export type PublicCompletionResourceListInput = z.input<typeof PublicCompletionResourceListInputSchema>;

export const PublicCompletionKnowledgeSearchInputSchema = z.object({
  room_id: publicManagementId,
  q: z.string().trim().min(1).max(4_000),
  limit: z.number().int().positive().max(100).default(50),
  cursor: publicManagementId.optional()
}).strict();
export type PublicCompletionKnowledgeSearchInput = z.input<typeof PublicCompletionKnowledgeSearchInputSchema>;

export const PublicCompletionResourceViewInputSchema = z.object({
  resource_id: publicManagementId,
  room_id: publicManagementId.optional(),
  kind: z.enum(["knowledge", "skill"]).optional(),
  versions_limit: z.number().int().positive().max(100).default(50),
  evidence_limit: z.number().int().positive().max(100).default(50)
}).strict();
export const PublicCompletionResourceBodyInputSchema = z.object({
  resource_id: publicManagementId,
  room_id: publicManagementId.optional(),
  kind: z.enum(["knowledge", "skill"]).optional(),
  version: z.number().int().positive().optional()
}).strict();
export const PublicCompletionResourceStateInputSchema = z.object({
  resource_id: publicManagementId,
  expected_version: z.number().int().positive(),
  reason: z.string().trim().min(1).max(4_000),
  archived: z.boolean().optional(),
  fixed: z.boolean().optional()
}).strict().superRefine((value, issue) => {
  if ((value.archived === undefined) === (value.fixed === undefined)) issue.addIssue({ code: z.ZodIssueCode.custom, path: ["resource_id"], message: "completion_state_action_required" });
});
export const PublicCompletionResourceArchiveInputSchema = z.object({
  resource_id: publicManagementId,
  room_id: publicManagementId.optional(),
  archived: z.boolean(),
  expected_version: z.number().int().positive(),
  reason: z.string().trim().min(1).max(4_000)
}).strict();
export const PublicCompletionResourceFixInputSchema = z.object({
  resource_id: publicManagementId,
  room_id: publicManagementId.optional(),
  fixed: z.boolean(),
  expected_version: z.number().int().positive(),
  reason: z.string().trim().min(1).max(4_000)
}).strict();

export const PublicCompletionResourceSchema = z.object({
  workspaceId: publicManagementId,
  id: publicManagementId,
  scope: PublicCompletionScopeSchema,
  kind: z.enum(["knowledge", "skill", "policy"]),
  knowledgeKind: z.enum(["fact", "decision", "explanation", "experience_rule"]).optional(),
  title: z.string().trim().min(1),
  evidenceState: z.enum(["provisional", "confirmed", "contradicted", "review_required"]),
  lifecycleState: z.enum(["active", "stale", "archived"]),
  aiProtection: z.enum(["editable", "fixed"]),
  creationSource: z.enum(["human", "ai", "import", "machine_verified", "physical_file_import"]),
  aiManaged: z.boolean(),
  version: z.number().int().positive(),
  currentConfirmedVersion: z.number().int().positive().optional(),
  currentProvisionalVersion: z.number().int().positive().optional(),
  candidateVersion: z.number().int().positive().optional(),
  archivedAt: publicManagementTimestamp.optional(),
  createdBy: publicManagementId,
  updatedBy: publicManagementId,
  createdAt: publicManagementTimestamp,
  updatedAt: publicManagementTimestamp
}).strict();
export type PublicCompletionResource = z.infer<typeof PublicCompletionResourceSchema>;

export const PublicCompletionResourceVersionSchema = z.object({
  workspaceId: publicManagementId,
  id: publicManagementId,
  resourceId: publicManagementId,
  version: z.number().int().positive(),
  parentVersion: z.number().int().positive().optional(),
  contentHash: z.string().trim().min(1),
  contentSize: z.number().int().nonnegative(),
  evidenceState: z.enum(["provisional", "confirmed", "contradicted", "review_required"]),
  lifecycleState: z.enum(["active", "stale", "archived"]),
  aiProtection: z.enum(["editable", "fixed"]),
  creationSource: z.enum(["human", "ai", "import", "machine_verified", "physical_file_import"]),
  metadata: z.record(jsonValueSchema),
  reason: z.string(),
  actorAccountId: publicManagementId,
  createdAt: publicManagementTimestamp
}).strict();
export type PublicCompletionResourceVersion = z.infer<typeof PublicCompletionResourceVersionSchema>;

export const PublicCompletionEvidenceSchema = z.object({
  workspaceId: publicManagementId,
  id: publicManagementId,
  resourceId: publicManagementId,
  resourceVersion: z.number().int().positive(),
  activityId: publicManagementId.optional(),
  episodeId: publicManagementId.optional(),
  kind: z.enum(["activity", "human_edit", "explicit_remember", "use_outcome", "machine_attestation", "physical_file_import", "unverified_claim"]),
  attestationId: publicManagementId.optional(),
  summary: z.string(),
  createdAt: publicManagementTimestamp
}).strict();

export const PublicCompletionResourcePageSchema = z.object({
  resources: z.array(PublicCompletionResourceSchema),
  next_cursor: publicManagementId.optional()
}).strict();
export const PublicCompletionKnowledgeSearchResourceSchema = PublicCompletionResourceSchema.extend({
  rank: z.number().finite()
}).strict();
export const PublicCompletionKnowledgeSearchPageSchema = z.object({
  resources: z.array(PublicCompletionKnowledgeSearchResourceSchema),
  next_cursor: publicManagementId.optional()
}).strict();
export const PublicCompletionResourceDetailSchema = z.object({
  resource: PublicCompletionResourceSchema,
  current_version: PublicCompletionResourceVersionSchema,
  versions: z.array(PublicCompletionResourceVersionSchema),
  evidence: z.array(PublicCompletionEvidenceSchema)
}).strict();
export const PublicCompletionResourceBodySchema = z.object({
  resource: PublicCompletionResourceSchema,
  version: PublicCompletionResourceVersionSchema,
  content: z.string()
}).strict();
export const PublicCompletionResourceMutationResultSchema = z.object({
  resource: PublicCompletionResourceSchema
}).strict();
export const PublicCompletionResourceMutationResponseSchema = PublicCompletionResourceMutationResultSchema.extend({ replayed: z.boolean() }).strict();

export const PublicRuntimeSettingsSchema = z.object({
  workspace_name: z.string().optional(),
  workspace_rules: z.array(z.string()).optional(),
  ui_locale: SupportedLocaleSchema,
  output_locale: SupportedLocaleSchema,
  memory_capture_mode: CaptureModeSchema,
  knowledge_wiki_capture_mode: CaptureModeSchema,
  skill_capture_mode: CaptureModeSchema,
  learning_enabled: z.boolean(),
  learning_budget_ratio: z.number().min(0).max(1),
  learning_budget_window_days: z.number().int().positive(),
  external_provider_role: ExternalProviderRoleSchema,
  default_backend_id: publicManagementId.optional(),
  default_room_id: publicManagementId.optional(),
  default_agent_id: publicManagementId.optional(),
  updated_at: publicManagementTimestamp
}).strict();
export type PublicRuntimeSettings = z.infer<typeof PublicRuntimeSettingsSchema>;

/** Public mutation input for Workspace Runtime settings. Keep this separate
 * from the stored settings projection so a caller cannot submit read-only
 * fields such as `updated_at`. */
export const PublicRuntimeSettingsPatchInputSchema = z.object({
  default_agent_id: publicManagementId.optional(),
  default_room_id: publicManagementId.optional(),
  external_provider_role: ExternalProviderRoleSchema.optional(),
  knowledge_wiki_capture_mode: CaptureModeSchema.optional(),
  learning_enabled: z.boolean().optional(),
  learning_budget_ratio: z.number().min(0).max(1).optional(),
  learning_budget_window_days: z.number().int().positive().max(90).optional(),
  memory_capture_mode: CaptureModeSchema.optional(),
  output_locale: SupportedLocaleSchema.optional(),
  skill_capture_mode: CaptureModeSchema.optional(),
  ui_locale: SupportedLocaleSchema.optional()
}).strict();

export const PublicLearningScopeSchema = z.object({
  kind: z.enum(["workspace", "room"]),
  roomId: publicManagementId.optional()
}).strict().superRefine((scope, issue) => {
  if (scope.kind === "room" && !scope.roomId) issue.addIssue({ code: z.ZodIssueCode.custom, path: ["roomId"], message: "room_id_required" });
  if (scope.kind === "workspace" && scope.roomId) issue.addIssue({ code: z.ZodIssueCode.custom, path: ["roomId"], message: "workspace_scope_room_forbidden" });
});
export const PublicLearningSettingsSchema = z.object({
  workspaceId: publicManagementId,
  id: publicManagementId,
  scope: PublicLearningScopeSchema,
  enabled: z.boolean(),
  engineId: publicManagementId.optional(),
  model: z.string().optional(),
  currencyLimit: z.number().nonnegative().optional(),
  tokenLimit: z.number().int().nonnegative().optional(),
  currencyUsed: z.number().nonnegative(),
  tokensUsed: z.number().int().nonnegative(),
  currencyReserved: z.number().nonnegative(),
  tokensReserved: z.number().int().nonnegative(),
  version: z.number().int().nonnegative(),
  updatedBy: publicManagementId,
  updatedAt: publicManagementTimestamp
}).strict();
export const PublicLearningSettingsLayersSchema = z.object({
  settings: PublicLearningSettingsSchema,
  workspace_settings: PublicLearningSettingsSchema.optional(),
  room_settings: PublicLearningSettingsSchema.optional()
}).strict();
export const PublicLearningSettingsPatchInputSchema = z.object({
  scope_kind: z.enum(["workspace", "room"]),
  room_id: publicManagementId.optional(),
  enabled: z.boolean().optional(),
  engine_id: publicManagementId.optional(),
  model: z.string().trim().max(512).optional(),
  secret_ref: publicManagementId.optional(),
  currency_limit: z.number().nonnegative().optional(),
  token_limit: z.number().int().nonnegative().optional(),
  clear_engine_id: z.boolean().optional(),
  clear_model: z.boolean().optional(),
  clear_secret_ref: z.boolean().optional(),
  clear_currency_limit: z.boolean().optional(),
  clear_token_limit: z.boolean().optional(),
  remove_override: z.boolean().optional(),
  expected_version: z.number().int().nonnegative().optional()
}).strict().superRefine((value, issue) => {
  if (value.scope_kind === "room" && !value.room_id) issue.addIssue({ code: z.ZodIssueCode.custom, path: ["room_id"], message: "room_id_required" });
  if (value.scope_kind === "workspace" && value.room_id) issue.addIssue({ code: z.ZodIssueCode.custom, path: ["room_id"], message: "workspace_scope_room_forbidden" });
});

export const PublicAutomationJobSchema = z.object({
  id: publicManagementId,
  title: z.string().trim().min(1),
  kind: z.enum(["memory_review", "learning_evaluation", "skill_curator", "wiki_reindex", "daily_digest", "custom_instruction", "resource_translation"]),
  status: AutomationJobStatusSchema,
  schedule: z.string().trim().min(1),
  target_instruction: z.string().trim().min(1),
  delivery_target: z.record(jsonValueSchema),
  workspace_id: publicManagementId,
  room_id: publicManagementId,
  authorization_state: AutomationAuthorizationStateSchema,
  authorization_error_code: publicManagementId.optional(),
  authorized_at: publicManagementTimestamp.optional(),
  blocked_at: publicManagementTimestamp.optional(),
  rebound_at: publicManagementTimestamp.optional(),
  management_state: AutomationManagementStateSchema,
  management_operation_id: publicManagementId.optional(),
  created_operation_id: publicManagementId.optional(),
  next_run_at: publicManagementTimestamp.optional(),
  last_run_at: publicManagementTimestamp.optional(),
  retry_after_at: publicManagementTimestamp.optional(),
  failure_count: z.number().int().nonnegative(),
  max_attempts: z.number().int().positive(),
  last_error: z.string().optional(),
  created_at: publicManagementTimestamp,
  updated_at: publicManagementTimestamp
}).strict();
export const PublicAutomationJobListSchema = z.object({ jobs: z.array(PublicAutomationJobSchema) }).strict();
export const PublicAutomationRunSchema = z.object({
  id: publicManagementId,
  kind: z.string().trim().min(1),
  source: z.string().trim().min(1),
  backend_run_id: publicManagementId.optional(),
  status: AutomationRunStatusSchema,
  operation_id: publicManagementId.optional(),
  job_id: publicManagementId,
  workspace_id: publicManagementId,
  room_id: publicManagementId,
  connector_id: publicManagementId.optional(),
  app_id: publicManagementId.optional(),
  activity_id: publicManagementId.optional(),
  error_code: publicManagementId.optional(),
  scheduled_at: publicManagementTimestamp,
  started_at: publicManagementTimestamp,
  completed_at: publicManagementTimestamp.optional(),
  blocked_at: publicManagementTimestamp.optional(),
  error: z.string().optional(),
  attempt_no: z.number().int().positive()
}).strict();
export const PublicAutomationJobListInputSchema = z.object({ room_id: publicManagementId.optional() }).strict();
export const PublicAutomationRunListInputSchema = z.object({
  room_id: publicManagementId.optional(),
  job_id: publicManagementId.optional()
}).strict().superRefine((value, issue) => {
  if (!value.room_id && !value.job_id) issue.addIssue({ code: z.ZodIssueCode.custom, path: ["room_id"], message: "room_id_or_job_id_required" });
  if (value.room_id && value.job_id) issue.addIssue({ code: z.ZodIssueCode.custom, path: ["job_id"], message: "room_id_and_job_id_are_mutually_exclusive" });
});
export const PublicAutomationRunNowInputSchema = z.object({
  room_id: publicManagementId,
  kind: z.enum(["memory_review", "learning_evaluation", "skill_curator", "wiki_reindex", "daily_digest", "custom_instruction", "resource_translation"])
}).strict();
export const PublicAutomationJobSaveInputSchema = z.object({
  delivery_target: z.record(jsonValueSchema).default({ channel: "activity" }),
  enabled: z.boolean().optional(),
  kind: z.enum(["memory_review", "learning_evaluation", "skill_curator", "wiki_reindex", "daily_digest", "resource_translation", "custom_instruction"]),
  max_attempts: z.number().int().positive().default(3),
  next_run_at: z.string().datetime().optional(),
  schedule: z.string().trim().min(1),
  target_instruction: z.string().trim().min(1),
  title: z.string().trim().min(1)
}).strict();
export const PublicAutomationJobManagerStopInputSchema = z.object({
  job_id: publicManagementId,
  note: z.string().trim().min(1).max(500).optional()
}).strict();
export const PublicAutomationJobManagerResumeInputSchema = z.object({
  job_id: publicManagementId
}).strict();

export type PublicManagementContractDefinition = Readonly<{
  id: string;
  kind: "command" | "query";
  version: string;
  availability: "active";
  input: z.ZodTypeAny;
  output: z.ZodTypeAny;
  idempotency: "required" | "optional" | "none" | "external";
  concurrency: "optimistic_version" | "state_transition" | "append_or_unique" | "external_idempotency" | "none";
  sources: readonly string[];
}>;

const managementQuery = (id: string, input: z.ZodTypeAny, output: z.ZodTypeAny): PublicManagementContractDefinition => ({
  id, kind: "query", version: "1.0", availability: "active", input, output, idempotency: "none", concurrency: "none", sources: ["runtime_api"]
});
const managementCommand = (
  id: string,
  input: z.ZodTypeAny,
  output: z.ZodTypeAny,
  concurrency: PublicManagementContractDefinition["concurrency"],
  options: { version?: string; sources?: readonly string[] } = {}
): PublicManagementContractDefinition => ({
  id,
  kind: "command",
  version: options.version ?? "1.0",
  availability: "active",
  input,
  output,
  idempotency: "required",
  concurrency,
  sources: options.sources ?? ["runtime_api"]
});

export const publicManagementContractDefinitions: readonly PublicManagementContractDefinition[] = Object.freeze([
  managementQuery("completion.resource.list", PublicCompletionResourceListInputSchema, PublicCompletionResourcePageSchema),
  managementQuery("completion.knowledge.search", PublicCompletionKnowledgeSearchInputSchema, PublicCompletionKnowledgeSearchPageSchema),
  managementQuery("completion.resource.view", PublicCompletionResourceViewInputSchema, PublicCompletionResourceDetailSchema),
  managementQuery("completion.resource.body", PublicCompletionResourceBodyInputSchema, PublicCompletionResourceBodySchema),
  managementCommand("completion.resource.create", PublicCompletionResourceCreateInputSchema, PublicCompletionResourceMutationResultSchema, "append_or_unique"),
  managementCommand("completion.resource.update", PublicCompletionResourceUpdateInputSchema, PublicCompletionResourceMutationResultSchema, "optimistic_version"),
  managementCommand("completion.resource.archive", PublicCompletionResourceArchiveInputSchema, PublicCompletionResourceMutationResultSchema, "state_transition"),
  managementCommand("completion.resource.fix", PublicCompletionResourceFixInputSchema, PublicCompletionResourceMutationResultSchema, "state_transition"),
  managementQuery("settings.view", z.object({}).strict(), PublicRuntimeSettingsSchema),
  managementCommand("settings.patch", PublicRuntimeSettingsPatchInputSchema, PublicRuntimeSettingsSchema, "optimistic_version", {
    version: "2.1",
    sources: ["runtime_api", "surface_operation"]
  }),
  managementQuery("learning.settings.view", z.object({ room_id: publicManagementId }).strict(), PublicLearningSettingsLayersSchema),
  managementCommand("learning.settings.patch", PublicLearningSettingsPatchInputSchema, z.object({ settings: PublicLearningSettingsSchema }).strict(), "optimistic_version"),
  managementQuery("automation.job.list", PublicAutomationJobListInputSchema, PublicAutomationJobListSchema),
  managementQuery("automation.run.list", PublicAutomationRunListInputSchema, z.object({ runs: z.array(PublicAutomationRunSchema) }).strict()),
  managementCommand("automation.job.save", PublicAutomationJobSaveInputSchema, PublicAutomationJobSchema, "append_or_unique", {
    version: "4.0",
    sources: ["runtime_api", "external_app"]
  }),
  managementCommand("automation.job.manager_stop", PublicAutomationJobManagerStopInputSchema, PublicAutomationJobSchema, "state_transition", {
    sources: ["runtime_api", "provider_tool_call", "surface_operation"]
  }),
  managementCommand("automation.job.manager_resume", PublicAutomationJobManagerResumeInputSchema, PublicAutomationJobSchema, "state_transition", {
    sources: ["runtime_api", "provider_tool_call", "surface_operation"]
  }),
  managementCommand("automation.job.run_now", PublicAutomationRunNowInputSchema, PublicAutomationJobSchema, "append_or_unique")
]);

export function publicManagementContractFor(operationId: string): PublicManagementContractDefinition | undefined {
  return publicManagementContractDefinitions.find((definition) => definition.id === operationId);
}

/** The normal Room-first public product slice. Keep legacy Session entry
 * points out of this list so a catalog consumer cannot discover them as the
 * supported way to start work. */
export const publicDomainOperationIds = Object.freeze([
  "room.list", "room.view", "room.create", "room.patch",
  "room.member.list", "room.agent.permission.set", "room.agent.remove",
  "room.work.list", "room.work.view", "room.work.create", "room.work.reply", "room.work.comment.create", "room.work.comment.apply", "room.work.comment.reaction.set",
  "room.default_agent.set", "room.work.stop", "room.work.assignee.stop", "room.work.assignee.reassign", "room.work.assignee.delegate", "agent.dm.open",
  "agent.backend.list", "agent.list", "agent.view", "agent.create", "agent.patch", "agent.backend.bind",
  "artifact.list", "artifact.view", "artifact.create", "artifact.revise", "artifact.restore_revision", "artifact.repair",
  "generated_surface.create", "generated_surface.revise", "generated_surface.action.run", "generated_surface.state", "generated_surface.export",
  "completion.resource.list", "completion.resource.view", "completion.resource.body", "completion.knowledge.search", "completion.resource.create", "completion.resource.update", "completion.resource.archive", "completion.resource.fix",
  "settings.view", "settings.patch",
  "learning.settings.view", "learning.settings.patch",
  "automation.job.list", "automation.run.list", "automation.job.save", "automation.job.manager_stop", "automation.job.manager_resume", "automation.job.run_now",
  "organization.list", "organization.view", "organization.create", "organization.patch", "organization.delete",
  "organization.member.list", "organization.member.invite", "organization.member.accept", "organization.member.role.change", "organization.member.remove", "organization.member.leave",
  "organization.invitation.list", "organization.invitation.revoke", "organization.invitation.reissue", "organization.invitation.extend",
  "organization.workspace.member.grant", "organization.workspace.member.revoke",
  "workspace.organization.move.preflight", "workspace.organization.move.commit", "workspace.organization.move.status",
  "workspace.bundle.export", "workspace.bundle.restore"
] as const);
export type PublicDomainOperationId = (typeof publicDomainOperationIds)[number];

/** Explicit compatibility-only entries. They remain callable through a
 * Server legacy allowlist, but are deliberately absent from the normal
 * catalog and Room-first SDK surface. */
export const publicLegacyDomainOperationIds = Object.freeze([
  "session.create", "chat.turn.run"
] as const);
export const legacyPublicDomainOperationIds = publicLegacyDomainOperationIds;
export type PublicLegacyDomainOperationId = (typeof publicLegacyDomainOperationIds)[number];

/**
 * Legacy Session entry points are intentionally described outside the normal
 * catalog.  A compatibility caller may use them only after the Server has
 * resolved the legacy Session to an authorized Room/work context; this table
 * is not an invitation to create a Session from a Room-first client.
 */
export const PublicLegacyDomainOperationCompatibilitySchema = z.object({
  id: z.enum(["session.create", "chat.turn.run"]),
  availability: z.literal("deprecated_command"),
  replacement_operation_ids: z.array(z.string().trim().min(1).max(512)).min(1).max(8),
  scope: z.literal("legacy_session_compatibility"),
  description: z.string().trim().min(1).max(2_000)
}).strict();
export type PublicLegacyDomainOperationCompatibility = z.infer<typeof PublicLegacyDomainOperationCompatibilitySchema>;

export const publicLegacyDomainOperationCompatibility: readonly PublicLegacyDomainOperationCompatibility[] = Object.freeze([
  {
    id: "session.create",
    availability: "deprecated_command",
    replacement_operation_ids: ["room.work.create"],
    scope: "legacy_session_compatibility",
    description: "Resolve the legacy Session request to an authorized Room before continuing; Room-first clients use room.work.create."
  },
  {
    id: "chat.turn.run",
    availability: "deprecated_command",
    replacement_operation_ids: ["room.work.create", "room.work.reply"],
    scope: "legacy_session_compatibility",
    description: "Resolve the legacy Session to an authorized Room work before execution; Room-first clients use room.work.create or room.work.reply."
  }
].map((entry) => PublicLegacyDomainOperationCompatibilitySchema.parse(entry)));
export const legacyPublicDomainOperationCompatibility = publicLegacyDomainOperationCompatibility;

const publicArtifactContentInputSchema = z.union([
  z.string(),
  z.record(jsonValueSchema),
  z.array(jsonValueSchema).max(50_000_000)
]);
const publicArtifactBase64InputSchema = z.string().max(12 * 1024 * 1024).refine(isCanonicalBase64, "artifact_content_base64_invalid");

function refinePublicArtifactContentInput(value: { content?: unknown; content_base64?: string; encoding?: "utf8" | "binary" }, issue: z.RefinementCtx): void {
  const hasContent = value.content !== undefined;
  const hasBase64 = value.content_base64 !== undefined;
  if (hasContent === hasBase64) {
    issue.addIssue({ code: z.ZodIssueCode.custom, path: [hasContent ? "content_base64" : "content"], message: "artifact_content_transport_required" });
  }
  if (hasBase64 && value.encoding !== "binary") {
    issue.addIssue({ code: z.ZodIssueCode.custom, path: ["encoding"], message: "artifact_binary_content_transport_required" });
  }
}

const publicArtifactCreateInputSchema = z.object({
  content: publicArtifactContentInputSchema.optional(),
  content_base64: publicArtifactBase64InputSchema.optional(),
  input_locale: SupportedLocaleSchema.optional(),
  kind: z.enum(["markdown", "document", "table", "chart", "graph", "image", "pdf", "structured_draft", "generated_report", "note"]).optional(),
  metadata: z.record(jsonValueSchema).default({}),
  mime_type: z.string().trim().min(1).max(255).optional(),
  encoding: ArtifactContentEncodingSchema.optional(),
  output_locale: SupportedLocaleSchema.optional(),
  title: z.string().trim().min(1).max(512)
}).strict().superRefine(refinePublicArtifactContentInput);

const publicArtifactReviseInputSchema = z.object({
  artifact_id: z.string().trim().min(1),
  base_revision_id: z.string().trim().min(1).optional(),
  change_summary: z.string().trim().min(1).optional(),
  content: publicArtifactContentInputSchema.optional(),
  content_base64: publicArtifactBase64InputSchema.optional(),
  editor_source: z.enum(["chat", "surface", "provider", "image_provider", "restore", "system"]).optional(),
  expected_revision: z.number().int().positive().optional(),
  extension: z.string().trim().min(1).optional(),
  mime_type: z.string().trim().min(1).max(255).optional(),
  encoding: ArtifactContentEncodingSchema.optional(),
  provenance: z.record(jsonValueSchema).default({})
}).strict().superRefine(refinePublicArtifactContentInput);

const publicArtifactContentOutputFields = {
  content: z.string().optional(),
  content_base64: z.string().refine(isCanonicalBase64, "artifact_content_base64_invalid").optional(),
  mime_type: z.string().trim().min(1).max(255).optional(),
  encoding: ArtifactContentEncodingSchema.optional()
} as const;

const publicArtifactContentOutputSchema = z.object(publicArtifactContentOutputFields).strict().superRefine(refinePublicArtifactContentOutput);

const publicArtifactMutationOutputSchema = z.object({
  artifact: ArtifactRecordSchema,
  ...publicArtifactContentOutputFields,
  revision: ArtifactRevisionRecordSchema.optional(),
  repair: z.object({ repaired: z.boolean() }).strict().optional(),
  replayed: z.boolean()
}).strict().superRefine((value, issue) => {
  refinePublicArtifactContentOutput(value, issue);
});

const publicArtifactViewOutputSchema = z.object({
  artifact: ArtifactRecordSchema,
  content: z.string(),
  content_base64: z.string().refine(isCanonicalBase64, "artifact_content_base64_invalid").optional(),
  mime_type: z.string().trim().min(1).max(255),
  encoding: ArtifactContentEncodingSchema,
  revision: ArtifactRevisionRecordSchema.optional()
}).strict().superRefine((value, issue) => {
  refinePublicArtifactContentOutput(value, issue);
});

export const PublicGeneratedSurfaceExportAssetSchema = z.object({
  path: z.string().trim().min(1).max(1_024).refine(isSafePublicGeneratedSurfaceAssetPath, "generated_surface_asset_path_invalid"),
  content_base64: z.string().refine(isCanonicalBase64, "generated_surface_asset_content_base64_invalid"),
  mime_type: z.string().trim().min(1).max(255).regex(/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/, "generated_surface_asset_mime_type_invalid")
}).strict();

const publicGeneratedSurfaceExportBundleSchema = z.object({
  html: z.string(),
  css: z.string().optional(),
  script: z.string().optional(),
  assets: z.array(PublicGeneratedSurfaceExportAssetSchema)
}).strict();

const publicGeneratedSurfaceMutationOutputSchema = z.object({
  definition: GeneratedSurfaceDefinitionSchema.optional(),
  revision: GeneratedSurfaceRevisionRecordSchema.optional(),
  replayed: z.boolean().optional()
}).strict();

const publicGeneratedSurfaceActionOutputSchema = z.object({
  surface: GeneratedSurfaceDefinitionSchema,
  action: GeneratedSurfaceActionDeclarationSchema,
  command: z.object({ result: z.record(jsonValueSchema) }).strict(),
  interaction: SurfaceInteractionRecordSchema,
  target_result: jsonValueSchema
}).strict();

/** Output projections are part of the public contract. The PostgreSQL v1
 * adapter returns these projections instead of the internal legacy records. */
export function publicOperationOutputSchemaFor(operationId: string, fallback: z.ZodTypeAny): z.ZodTypeAny {
  const managementContract = publicManagementContractFor(operationId);
  if (managementContract) return managementContract.output;
  if (operationId === "room.list") return z.array(PublicRoomRecordSchema);
  if (["room.view", "room.create", "room.patch"].includes(operationId)) return PublicRoomRecordSchema;
  if (operationId === "room.member.list") return PublicRoomMemberListRecordSchema;
  if (["room.agent.permission.set", "room.agent.remove"].includes(operationId)) return PublicRoomAgentPermissionRecordSchema;
  if (operationId === "room.work.list") return z.array(PublicRoomWorkRecordSchema);
  if (operationId === "room.work.view") return PublicRoomWorkViewSchema;
  if (["room.work.create"].includes(operationId)) return PublicRoomWorkRecordSchema;
  if (["room.work.reply", "room.work.comment.apply"].includes(operationId)) return PublicRoomWorkInstructionSchema;
  if (operationId === "room.work.comment.create") return PublicRoomWorkCommentSchema;
  if (operationId === "room.work.comment.reaction.set") return PublicRoomWorkReactionRecordSchema;
  if (operationId === "room.default_agent.set") return PublicRoomDefaultAgentRecordSchema;
  if (["room.work.stop", "room.work.assignee.stop"].includes(operationId)) return PublicRoomWorkControlSchema;
  if (["room.work.assignee.reassign", "room.work.assignee.delegate"].includes(operationId)) return PublicRoomWorkAssigneeSchema;
  if (operationId === "agent.dm.open") return PublicAgentDmRecordSchema;
  if (operationId === "agent.backend.list") return z.array(PublicAgentBackendRecordSchema);
  if (operationId === "agent.list") return z.array(PublicAgentRecordSchema);
  if (["agent.view", "agent.create", "agent.patch", "agent.backend.bind"].includes(operationId)) return PublicAgentRecordSchema;
  if (operationId === "artifact.view") return publicArtifactViewOutputSchema;
  if (["artifact.create", "artifact.revise", "artifact.restore_revision", "artifact.repair"].includes(operationId)) return publicArtifactMutationOutputSchema;
  if (["generated_surface.create", "generated_surface.revise"].includes(operationId)) return publicGeneratedSurfaceMutationOutputSchema;
  if (operationId === "generated_surface.action.run") return publicGeneratedSurfaceActionOutputSchema;
  if (operationId === "generated_surface.state") return GeneratedSurfaceDefinitionSchema;
  if (operationId === "generated_surface.export") return z.object({
    surface: GeneratedSurfaceDefinitionSchema,
    revision: GeneratedSurfaceRevisionRecordSchema,
    bundle: publicGeneratedSurfaceExportBundleSchema,
    format: z.enum(["html", "zip"]),
    file_name: z.string().trim().min(1)
  }).strict();
  if (operationId === "organization.list") return z.array(PublicOrganizationRecordSchema);
  if (["organization.view", "organization.create", "organization.patch", "organization.delete"].includes(operationId)) return PublicOrganizationRecordSchema;
  if (operationId === "organization.member.list") return z.array(PublicOrganizationMembershipRecordSchema);
  if (["organization.member.invite", "organization.invitation.reissue"].includes(operationId)) return PublicOrganizationInvitationIssueResultSchema;
  if (operationId === "organization.member.accept") return z.object({ membership: PublicOrganizationMembershipRecordSchema, workspace_grants: z.array(PublicOrganizationWorkspaceMembershipRecordSchema).max(100) }).strict();
  if (["organization.member.role.change", "organization.member.remove", "organization.member.leave"].includes(operationId)) return PublicOrganizationMembershipRecordSchema;
  if (operationId === "organization.invitation.list") return z.array(PublicOrganizationInvitationRecordSchema);
  if (["organization.invitation.revoke", "organization.invitation.extend"].includes(operationId)) return PublicOrganizationInvitationRecordSchema;
  if (operationId === "organization.workspace.list") return z.array(PublicOrganizationWorkspaceRecordSchema);
  if (["organization.workspace.create", "organization.workspace.archive", "organization.workspace.restore", "organization.workspace.delete"].includes(operationId)) return PublicOrganizationWorkspaceRecordSchema;
  if (["organization.workspace.member.grant", "organization.workspace.member.revoke"].includes(operationId)) return PublicOrganizationWorkspaceMembershipRecordSchema;
  if (operationId === "workspace.organization.move.preflight") return PublicWorkspaceMovePreflightSchema;
  if (operationId === "workspace.organization.move.commit") return PublicWorkspaceMoveResultSchema;
  if (operationId === "workspace.organization.move.status") return PublicWorkspaceMoveStatusRecordSchema;
  if (operationId === "workspace.bundle.export") return PublicWorkspaceBundleExportResultSchema;
  if (operationId === "workspace.bundle.restore") return PublicWorkspaceBundleRestoreResultSchema;
  return fallback;
}

/** Public input projections may intentionally be narrower than the internal
 * operation definition. Keep the Room Agent membership commands on the same
 * versioned contract as the rest of the Room-first API. */
export function publicOperationInputSchemaFor(operationId: string, fallback: z.ZodTypeAny): z.ZodTypeAny {
  const managementContract = publicManagementContractFor(operationId);
  if (managementContract) return managementContract.input;
  if (operationId === "room.member.list") return z.object({}).strict();
  if (operationId === "room.agent.permission.set") return PublicRoomAgentPermissionSetInputSchema;
  if (operationId === "room.agent.remove") return PublicRoomAgentRemoveInputSchema;
  if (operationId === "room.work.create") return PublicRoomWorkCreateInputSchema;
  if (operationId === "room.work.reply") return PublicRoomWorkReplyInputSchema;
  if (operationId === "artifact.create") return publicArtifactCreateInputSchema;
  if (operationId === "artifact.revise") return publicArtifactReviseInputSchema;
  return fallback;
}

export const DomainContractKindSchema = z.enum(["command", "query"]);
export const DomainContractAvailabilitySchema = z.enum(["active", "deprecated_command"]);
export const DomainContractCatalogEntrySchema = z.object({
  id: z.string().trim().min(1),
  kind: DomainContractKindSchema,
  version: z.string().trim().min(1),
  availability: DomainContractAvailabilitySchema,
  input_schema: z.record(jsonValueSchema),
  output_schema: z.record(jsonValueSchema),
  idempotency: z.enum(["required", "optional", "none", "external"]),
  concurrency: z.enum(["optimistic_version", "state_transition", "append_or_unique", "external_idempotency", "none"]),
  sources: z.array(z.string().trim().min(1)).max(32)
}).strict();
export type DomainContractCatalogEntry = z.infer<typeof DomainContractCatalogEntrySchema>;

export const RunControlActionSchema = z.enum(["cancel", "resume", "sync", "recover", "retry"]);
export type RunControlAction = z.infer<typeof RunControlActionSchema>;

export const RunControlInputSchema = z.object({
  context: PublicRequestContextSchema,
  input: z.record(jsonValueSchema).default({})
}).strict();
export type RunControlInput = z.infer<typeof RunControlInputSchema>;

const runControlPayloadSchemas = {
  cancel: z.object({}).strict(),
  resume: z.record(jsonValueSchema),
  sync: z.object({}).strict(),
  recover: z.object({}).strict(),
  retry: z.object({ confirm_unknown: z.boolean().optional() }).strict()
} as const;

export const RunControlContractEntrySchema = z.object({
  action: RunControlActionSchema,
  allowed_states: z.array(z.string().trim().min(1)).max(32),
  idempotency: z.enum(["replay_safe", "new_attempt"]),
  input_schema: z.record(jsonValueSchema),
  output_schema: z.record(jsonValueSchema)
}).strict();
export type RunControlContractEntry = z.infer<typeof RunControlContractEntrySchema>;

const runControlOutputSchema = z.record(jsonValueSchema);
const runControlDefinitions = [
  { action: "cancel", allowed_states: ["queued", "running", "waiting_for_backend_input", "cancelling"], idempotency: "replay_safe", input: runControlPayloadSchemas.cancel },
  { action: "resume", allowed_states: ["waiting_for_backend_input"], idempotency: "replay_safe", input: runControlPayloadSchemas.resume },
  { action: "sync", allowed_states: ["queued", "running", "waiting_for_backend_input", "cancelling"], idempotency: "replay_safe", input: runControlPayloadSchemas.sync },
  { action: "recover", allowed_states: ["queued", "running", "waiting_for_backend_input", "cancelling"], idempotency: "replay_safe", input: runControlPayloadSchemas.recover },
  { action: "retry", allowed_states: ["failed", "outcome_unknown"], idempotency: "new_attempt", input: runControlPayloadSchemas.retry }
] as const;

export const runControlCatalog: readonly RunControlContractEntry[] = Object.freeze(runControlDefinitions.map((definition) => ({
  action: definition.action,
  allowed_states: [...definition.allowed_states],
  idempotency: definition.idempotency,
  input_schema: toStrictJsonSchema(z.object({ context: PublicRequestContextSchema, input: definition.input }).strict(), `run.control.${definition.action}.input`),
  output_schema: toStrictJsonSchema(runControlOutputSchema, `run.control.${definition.action}.output`)
})));

export function runControlRequestSchemaFor(action: RunControlAction): z.ZodTypeAny {
  const definition = runControlDefinitions.find((candidate) => candidate.action === action);
  if (!definition) throw new Error(`run_control_action_not_defined:${action}`);
  return z.object({ context: PublicRequestContextSchema, input: definition.input }).strict();
}

export const EventCatalogEntrySchema = z.object({
  event_type: z.string().regex(/^[a-z][a-z0-9._-]{0,127}$/),
  event_version: z.string().regex(/^\d+\.\d+$/),
  payload_schema: z.record(jsonValueSchema),
  resources: z.array(z.string().trim().min(1)).max(32)
}).strict();
export type EventCatalogEntry = z.infer<typeof EventCatalogEntrySchema>;

const eventPayloadSchemas = {
  "workspace.record.changed": z.object({ record_type: z.string().trim().min(1), record_id: z.string().trim().min(1), action: z.string().trim().min(1) }).strict(),
  "workspace.operation.completed": z.object({ operation_id: z.string().trim().min(1), status: z.string().trim().min(1) }).strict(),
  "workspace.activity.ingested": z.object({ activity_id: z.string().trim().min(1), status: z.string().trim().min(1), source_event_id: z.string().trim().min(1), payload_hash: z.string().regex(/^[a-f0-9]{64}$/i) }).strict(),
  "workspace.run.changed": z.object({ run_id: z.string().trim().min(1), status: z.string().trim().min(1), action: z.string().trim().min(1) }).strict(),
  "workspace.room.changed": z.object({ room_id: z.string().trim().min(1), action: z.enum(["created", "patched"]) }).strict(),
  "workspace.room_work.changed": z.object({
    room_id: publicCollaborationId,
    work_id: publicCollaborationId,
    action: z.enum(["created", "updated", "replied", "comment_applied", "stopped", "assignee_stopped", "assignee_reassigned"]),
    status: PublicRoomWorkStatusSchema.optional(),
    generation: publicCollaborationGeneration.optional(),
    version: publicCollaborationVersion.optional()
  }).strict(),
  "workspace.room_work.comment.changed": z.object({
    room_id: publicCollaborationId,
    work_id: publicCollaborationId,
    comment_id: publicCollaborationId,
    action: z.enum(["created", "applied", "reaction_changed"]),
    version: publicCollaborationVersion.optional()
  }).strict(),
  "workspace.room_work.assignee.changed": z.object({
    room_id: publicCollaborationId,
    work_id: publicCollaborationId,
    assignee_id: publicCollaborationId,
    action: z.enum(["created", "updated", "stopped", "reassigned", "delegated"]),
    delegated: z.boolean().optional(),
    agent_id: publicCollaborationId.optional(),
    parent_assignee_id: publicCollaborationId.optional(),
    status: CoreRoomWorkAssignmentStatusSchema.optional(),
    generation: publicCollaborationGeneration.optional(),
    version: publicCollaborationVersion.optional()
  }).strict(),
  "workspace.room_default_agent.changed": z.object({
    room_id: publicCollaborationId,
    agent_id: publicCollaborationId,
    agent_version: publicCollaborationVersion.optional(),
    version: publicCollaborationVersion.optional()
  }).strict(),
  "workspace.room_agent.changed": z.object({
    room_id: publicCollaborationId,
    agent_id: publicCollaborationId,
    action: z.enum(["permission_changed", "removed"]),
    can_view: z.boolean(),
    can_edit: z.boolean(),
    can_execute: z.boolean(),
    version: publicCollaborationVersion.optional()
  }).strict(),
  "workspace.agent_dm.changed": z.object({
    room_id: publicCollaborationId,
    agent_id: publicCollaborationId,
    action: z.enum(["opened", "reused"]),
    version: publicCollaborationVersion.optional()
  }).strict(),
  "workspace.agent.changed": z.object({ agent_id: z.string().trim().min(1), action: z.enum(["created", "patched", "backend_bound"]) }).strict(),
  "workspace.artifact.changed": z.object({ artifact_id: z.string().trim().min(1), action: z.enum(["created", "revised", "restored", "repaired"]), revision_id: z.string().trim().min(1).optional() }).strict(),
  "workspace.generated_surface.changed": z.object({ surface_id: z.string().trim().min(1), action: z.enum(["created", "revised", "action", "state_changed", "exported"]), revision_id: z.string().trim().min(1).optional() }).strict(),
  "completion.resource.created": z.object({ resource_id: publicManagementId, kind: z.enum(["knowledge", "skill"]), version: z.number().int().positive() }).strict(),
  "completion.resource.updated": z.object({ resource_id: publicManagementId, kind: z.enum(["knowledge", "skill"]), version: z.number().int().positive() }).strict(),
  "completion.resource.archived": z.object({ resource_id: publicManagementId, kind: z.enum(["knowledge", "skill"]), version: z.number().int().positive(), archived: z.boolean() }).strict(),
  "completion.resource.fixed": z.object({ resource_id: publicManagementId, kind: z.enum(["knowledge", "skill"]), version: z.number().int().positive(), fixed: z.boolean() }).strict(),
  "workspace.settings.changed": z.object({ workspace_id: publicManagementId, action: z.literal("patched") }).strict(),
  "learning.settings.updated": z.object({ scope_kind: z.enum(["workspace", "room"]), room_id: publicManagementId.optional(), version: z.number().int().nonnegative() }).strict(),
  "automation.job.created": z.object({ job_id: publicManagementId, room_id: publicManagementId.optional(), kind: z.string().trim().min(1), status: z.string().trim().min(1), authorization_state: z.string().trim().min(1).optional() }).strict(),
  "automation.job.management_changed": z.object({ job_id: publicManagementId, room_id: publicManagementId.optional(), management_state: z.enum(["allowed", "manager_stopped"]), status: z.string().trim().min(1) }).strict(),
  "workspace.interaction_request.changed": z.object({
    request_id: z.string().trim().min(1),
    kind: z.enum(["approval", "backend_input"]),
    status: z.enum(["pending", "accepted", "denied", "cancelled", "expired", "executing", "completed", "failed"]),
    action: z.enum(["created", "responded", "cancelled", "executing", "completed", "failed", "expired"])
  }).strict(),
  // Organization events carry stable resource IDs and role/state facts only.
  // They deliberately omit raw invitation tokens, private Account fields, and
  // all Room/Message/Knowledge content.
  "organization.created": z.object({ organization_id: z.string().trim().min(1).max(512), name: z.string().trim().min(1).max(200) }).strict(),
  "organization.member.invited": z.object({ organization_id: z.string().trim().min(1).max(512), invitation_id: z.string().trim().min(1).max(512), role: z.enum(["owner", "admin", "member", "guest"]) }).strict(),
  "organization.member.accepted": z.object({ organization_id: z.string().trim().min(1).max(512), membership_id: z.string().trim().min(1).max(512) }).strict(),
  "organization.member.role_changed": z.object({ organization_id: z.string().trim().min(1).max(512), membership_id: z.string().trim().min(1).max(512), role: z.enum(["owner", "admin", "member", "guest"]) }).strict(),
  "organization.member.removed": z.object({ organization_id: z.string().trim().min(1).max(512), membership_id: z.string().trim().min(1).max(512) }).strict(),
  "workspace.organization.moved": z.object({ workspace_id: z.string().trim().min(1).max(512), source_organization_id: z.string().trim().min(1).max(512), target_organization_id: z.string().trim().min(1).max(512), operation_id: z.string().trim().min(1).max(512) }).strict(),
  "workspace.archived": z.object({ workspace_id: z.string().trim().min(1).max(512), organization_id: z.string().trim().min(1).max(512) }).strict(),
  "workspace.restored": z.object({ workspace_id: z.string().trim().min(1).max(512), organization_id: z.string().trim().min(1).max(512) }).strict(),
  "workspace.deleted": z.object({ workspace_id: z.string().trim().min(1).max(512), organization_id: z.string().trim().min(1).max(512) }).strict()
} as const;

const eventResourceKinds: Record<keyof typeof eventPayloadSchemas, string[]> = {
  "workspace.record.changed": ["record"],
  "workspace.operation.completed": ["operation"],
  "workspace.activity.ingested": ["activity"],
  "workspace.run.changed": ["backend_run"],
  "workspace.room.changed": ["room"],
  "workspace.room_work.changed": ["room", "room_work"],
  "workspace.room_work.comment.changed": ["room", "room_work", "room_work_comment"],
  "workspace.room_work.assignee.changed": ["room", "room_work", "room_work_assignee"],
  "workspace.room_default_agent.changed": ["room", "agent"],
  "workspace.room_agent.changed": ["room", "room_agent", "agent"],
  "workspace.agent_dm.changed": ["room", "agent"],
  "workspace.agent.changed": ["agent"],
  "workspace.artifact.changed": ["artifact", "artifact_revision"],
  "workspace.generated_surface.changed": ["generated_surface", "generated_surface_revision"],
  "completion.resource.created": ["completion_resource", "completion_resource_version"],
  "completion.resource.updated": ["completion_resource", "completion_resource_version"],
  "completion.resource.archived": ["completion_resource", "completion_resource_version"],
  "completion.resource.fixed": ["completion_resource", "completion_resource_version"],
  "workspace.settings.changed": ["settings"],
  "learning.settings.updated": ["learning_settings", "room"],
  "automation.job.created": ["automation_job", "room"],
  "automation.job.management_changed": ["automation_job", "room"],
  "workspace.interaction_request.changed": ["interaction_request", "room", "backend_run", "generated_surface", "generated_surface_revision"],
  "organization.created": ["organization"],
  "organization.member.invited": ["organization", "organization_invitation"],
  "organization.member.accepted": ["organization", "organization_membership"],
  "organization.member.role_changed": ["organization", "organization_membership"],
  "organization.member.removed": ["organization", "organization_membership"],
  "workspace.organization.moved": ["workspace", "organization"],
  "workspace.archived": ["workspace"],
  "workspace.restored": ["workspace"],
  "workspace.deleted": ["workspace"]
};

export function eventPayloadSchemaFor(eventType: string): z.ZodTypeAny {
  return eventPayloadSchemas[eventType as keyof typeof eventPayloadSchemas] ?? z.record(jsonValueSchema);
}

export function parsePublicEventPayload(eventType: string, payload: unknown): Record<string, JsonValue> {
  const parsed = eventPayloadSchemaFor(eventType).parse(payload) as Record<string, JsonValue>;
  if (eventType in eventPayloadSchemas) return parsed;
  return sanitizeLegacyEventPayload(parsed);
}

const legacyEventSensitiveKey = /secret|token|password|credential|authorization|private[_-]?key|api[_-]?key/i;
const legacyEventBodyKey = /^(content|body|prompt|message|text)$/i;
const legacyEventMaxStringLength = 4_096;
const legacyEventMaxItems = 100;
const legacyEventMaxDepth = 6;
const legacyEventMaxBytes = 32_768;

/**
 * Old event rows predate the public catalog and may contain arbitrary JSON.
 * Keep the compatibility fallback, but never expose obvious credentials or
 * full message bodies through the new public Event boundary.
 */
export function sanitizeLegacyEventPayload(payload: Record<string, JsonValue>): Record<string, JsonValue> {
  const sanitized = sanitizeLegacyEventValue(payload, 0);
  if (JSON.stringify(sanitized).length > legacyEventMaxBytes) {
    return { redacted: true, reason: "payload_too_large" };
  }
  return sanitized as Record<string, JsonValue>;
}

function sanitizeLegacyEventValue(value: JsonValue, depth: number): JsonValue {
  if (typeof value === "string") return value.slice(0, legacyEventMaxStringLength);
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (depth >= legacyEventMaxDepth) return Array.isArray(value) ? [] : {};
  if (Array.isArray(value)) return value.slice(0, legacyEventMaxItems).map((item) => sanitizeLegacyEventValue(item, depth + 1));
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !legacyEventSensitiveKey.test(key) && !legacyEventBodyKey.test(key))
    .slice(0, legacyEventMaxItems)
    .map(([key, item]) => [key, sanitizeLegacyEventValue(item, depth + 1)]));
}

export const eventCatalog: readonly EventCatalogEntry[] = Object.freeze(Object.entries(eventPayloadSchemas).map(([event_type, schema]) => ({
  event_type,
  event_version: "1.0",
  payload_schema: toStrictJsonSchema(schema, `${event_type}.payload`),
  resources: eventResourceKinds[event_type as keyof typeof eventPayloadSchemas]
})));

export const DomainApiCatalogSchema = z.object({
  api_version: DomainApiVersionSchema,
  contracts: z.array(DomainContractCatalogEntrySchema),
  events: z.array(EventCatalogEntrySchema),
  run_controls: z.array(RunControlContractEntrySchema)
}).strict();
export type DomainApiCatalog = z.infer<typeof DomainApiCatalogSchema>;

const activityOutcomeValues = ["completed", "failed", "cancelled", "unknown", "not_run"] as const;
export const ActivityIngestOutcomeSchema = z.enum(activityOutcomeValues);
export type ActivityIngestOutcome = z.infer<typeof ActivityIngestOutcomeSchema>;

/** Canonical evidence input. The Server supplies actor, source and permission context. */
export const ActivityIngestRequestSchema = z.object({
  context: PublicRequestContextSchema.extend({ room_id: z.string().trim().min(1).max(512) }),
  activity_id: z.string().trim().min(1).max(512).optional(),
  source_event_id: z.string().trim().min(1).max(512),
  payload_hash: z.string().regex(/^[a-f0-9]{64}$/i),
  dedupe_key: z.string().trim().min(1).max(512),
  occurred_at: z.string().datetime(),
  instruction_summary: z.string().trim().min(1).max(20_000),
  outcome: ActivityIngestOutcomeSchema,
  result_summary: z.string().trim().min(1).max(20_000).optional(),
  verification: z.array(ActivityVerificationRecordSchema).max(200).default([]),
  failure: ActivityFailureSchema.optional(),
  backend_run_id: z.string().trim().min(1).max(512).optional(),
  domain_operation_ids: z.array(z.string().trim().min(1).max(512)).max(200).default([]),
  resource_usage: z.array(ResourceUsageRecordSchema).max(500).default([])
}).strict().superRefine((input, issue) => {
  if (input.outcome === "completed" && !input.result_summary) {
    issue.addIssue({ code: z.ZodIssueCode.custom, path: ["result_summary"], message: "completed_activity_requires_result" });
  }
  if (input.outcome !== "completed" && !input.failure) {
    issue.addIssue({ code: z.ZodIssueCode.custom, path: ["failure"], message: "non_completed_activity_requires_failure" });
  }
  if (input.outcome === "unknown" && input.failure !== undefined && input.failure.code === "success") {
    issue.addIssue({ code: z.ZodIssueCode.custom, path: ["failure", "code"], message: "unknown_activity_cannot_be_success" });
  }
});
export type ActivityIngestRequest = z.infer<typeof ActivityIngestRequestSchema>;

export const EventActorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("human"), id: z.string().trim().min(1).max(512) }).strict(),
  z.object({ kind: z.literal("agent"), id: z.string().trim().min(1).max(512) }).strict(),
  z.object({ kind: z.literal("system"), id: z.string().trim().min(1).max(512).optional() }).strict()
]);
export type EventActor = z.infer<typeof EventActorSchema>;

export const EventScopeSchema = z.object({
  organization_id: z.string().trim().min(1).max(512).optional(),
  workspace_id: z.string().trim().min(1).max(512).optional(),
  room_id: z.string().trim().min(1).max(512).optional()
}).strict().superRefine((scope, issue) => {
  if (!scope.organization_id && !scope.workspace_id) {
    issue.addIssue({ code: z.ZodIssueCode.custom, path: [], message: "event_scope_requires_organization_or_workspace" });
  }
  if (scope.room_id && !scope.workspace_id) {
    issue.addIssue({ code: z.ZodIssueCode.custom, path: ["workspace_id"], message: "room_scope_requires_workspace" });
  }
});
export type EventScope = z.infer<typeof EventScopeSchema>;

export const PublicEventEnvelopeSchema = z.object({
  event_id: z.string().trim().min(1).max(512),
  event_type: z.string().regex(/^[a-z][a-z0-9._-]{0,127}$/),
  event_version: z.string().regex(/^\d+\.\d+$/),
  cursor: z.string().trim().min(1).max(512),
  occurred_at: z.string().datetime(),
  actor: EventActorSchema,
  scope: EventScopeSchema,
  resources: z.array(ResourceRefSchema).max(100),
  operation_id: z.string().trim().min(1).max(512).optional(),
  correlation_id: z.string().trim().min(1).max(512).optional(),
  payload: z.record(jsonValueSchema)
}).strict();
export type PublicEventEnvelope = z.infer<typeof PublicEventEnvelopeSchema>;

export const EventReplayPageSchema = z.object({
  events: z.array(PublicEventEnvelopeSchema),
  next_cursor: z.string().trim().min(1).optional(),
  has_more: z.boolean()
}).strict();
export type EventReplayPage = z.infer<typeof EventReplayPageSchema>;

export function schemaForPublicContract(schema: z.ZodTypeAny, name: string): Record<string, JsonValue> {
  return toStrictJsonSchema(schema, name);
}

/** API version compatibility is deliberately small and explicit for Phase 1. */
export function isApiVersionCompatible(actual: string, expected = domainApiVersion): boolean {
  return actual === expected;
}

export function isEventVersionCompatible(actual: string, expectedMajor = 1): boolean {
  const major = Number(actual.split(".")[0]);
  return Number.isInteger(major) && major === expectedMajor;
}

export interface DomainApiTransportRequest {
  method: "GET" | "POST" | "PATCH";
  path: string;
  body?: unknown;
  operationId?: string;
  idempotencyKey?: string;
}

export type DomainApiTransport = <T>(request: DomainApiTransportRequest) => Promise<T>;

/** Typed transport client. Signing and private-key handling stay in the caller's Main/Browser boundary. */
export class DomainApiClient {
  constructor(private readonly transport: DomainApiTransport) {}

  /** Account-scoped directory; no Organization or Workspace path is needed. */
  listAccountWorkspaces<T = PublicWorkspaceDirectory>(): Promise<T> {
    return this.transport<T>({ method: "GET", path: "/api/account/workspaces" });
  }

  /** Create a standalone Workspace through the same account command path used by HTTP. */
  createWorkspace<T = JsonValue>(input: { workspace_id: string; name: string }, options: { operationId: string; idempotencyKey?: string }): Promise<T> {
    return this.transport<T>({
      method: "POST",
      path: "/api/workspaces",
      body: input,
      operationId: options.operationId,
      ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {})
    });
  }

  /** Restore a portable Workspace as standalone; attach to an Organization separately. */
  importWorkspaceBundle<T = JsonValue>(input: {
    target_workspace_id: string;
    bundle: JsonValue;
    target_workspace_name?: string;
  }, options: { operationId: string; idempotencyKey?: string }): Promise<T> {
    return this.transport<T>({
      method: "POST",
      path: "/api/workspaces/imports",
      body: input,
      operationId: options.operationId,
      ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {})
    });
  }

  /** Restore a server-managed export as a standalone Workspace. */
  restoreWorkspaceBundle<T = PublicWorkspaceBundleRestoreResult>(input: {
    bundle_id: string;
    workspace_id?: string;
    target_workspace_id?: string;
    confirm: true;
  }, options: { operationId: string; idempotencyKey?: string }): Promise<T> {
    return this.transport<T>({
      method: "POST",
      path: "/api/workspaces/bundles/restore",
      body: input,
      operationId: options.operationId,
      idempotencyKey: options.idempotencyKey ?? options.operationId
    });
  }

  /** Export a Workspace without requiring an Organization route segment. */
  exportWorkspaceBundle<T = PublicWorkspaceBundleExportResult>(workspaceId: string, options: { operationId: string; idempotencyKey?: string; expectedWorkspaceVersion?: number }): Promise<T> {
    return this.transport<T>({
      method: "POST",
      path: `/api/workspaces/${encodeURIComponent(workspaceId)}/bundle/export`,
      body: options.expectedWorkspaceVersion === undefined ? {} : { expected_workspace_version: options.expectedWorkspaceVersion },
      operationId: options.operationId,
      idempotencyKey: options.idempotencyKey ?? options.operationId
    });
  }

  /** Explicitly attach a standalone Workspace to a same-Server Organization. */
  attachWorkspaceToOrganization<T = PublicWorkspaceOrganizationAssociationResult>(organizationId: string, workspaceId: string, options: { operationId: string; idempotencyKey?: string; expectedWorkspaceVersion?: number; confirmGuestMemberships?: boolean }): Promise<T> {
    return this.transport<T>({
      method: "POST",
      path: `/api/organizations/${encodeURIComponent(organizationId)}/workspaces/${encodeURIComponent(workspaceId)}/attach`,
      body: {
        ...(options.expectedWorkspaceVersion === undefined ? {} : { expected_workspace_version: options.expectedWorkspaceVersion }),
        ...(options.confirmGuestMemberships === undefined ? {} : { confirm_guest_memberships: options.confirmGuestMemberships })
      },
      operationId: options.operationId,
      idempotencyKey: options.idempotencyKey ?? options.operationId
    });
  }

  /** Explicitly detach a Workspace while preserving its content and members. */
  detachWorkspaceFromOrganization<T = PublicWorkspaceOrganizationAssociationResult>(organizationId: string, workspaceId: string, options: { operationId: string; idempotencyKey?: string; expectedWorkspaceVersion?: number }): Promise<T> {
    return this.transport<T>({
      method: "POST",
      path: `/api/organizations/${encodeURIComponent(organizationId)}/workspaces/${encodeURIComponent(workspaceId)}/detach`,
      body: options.expectedWorkspaceVersion === undefined ? {} : { expected_workspace_version: options.expectedWorkspaceVersion },
      operationId: options.operationId,
      idempotencyKey: options.idempotencyKey ?? options.operationId
    });
  }

  /** Begin a resumable, read-only transfer from this Workspace. */
  beginWorkspaceTransfer<T = PublicWorkspaceTransferStartResult>(workspaceId: string, options: { operationId: string; idempotencyKey?: string }): Promise<T> {
    return this.transport<T>({
      method: "POST",
      path: `/api/workspaces/${encodeURIComponent(workspaceId)}/transfers`,
      operationId: options.operationId,
      idempotencyKey: options.idempotencyKey ?? options.operationId
    });
  }

  /** Read the verified transfer manifest before sending it to the target. */
  getWorkspaceTransferManifest<T = PublicWorkspaceTransferManifestResult>(workspaceId: string, transferId: string): Promise<T> {
    return this.transport<T>({
      method: "GET",
      path: `/api/workspaces/${encodeURIComponent(workspaceId)}/transfers/${encodeURIComponent(transferId)}/manifest`
    });
  }

  /** Record target integrity proof; source remains active until complete. */
  recordWorkspaceTransferReceipt<T = void>(workspaceId: string, transferId: string, input: { target_workspace_id: string; receipt: PublicWorkspaceTransferReceipt }, options: { operationId: string; idempotencyKey?: string }): Promise<T> {
    return this.transport<T>({
      method: "POST",
      path: `/api/workspaces/${encodeURIComponent(workspaceId)}/transfers/${encodeURIComponent(transferId)}/receipt`,
      body: input,
      operationId: options.operationId,
      idempotencyKey: options.idempotencyKey ?? options.operationId
    });
  }

  /** Cancel a transfer and release the source read-only state. */
  rollbackWorkspaceTransfer<T = void>(workspaceId: string, transferId: string, options: { operationId: string; idempotencyKey?: string }): Promise<T> {
    return this.transport<T>({
      method: "POST",
      path: `/api/workspaces/${encodeURIComponent(workspaceId)}/transfers/${encodeURIComponent(transferId)}/rollback`,
      operationId: options.operationId,
      idempotencyKey: options.idempotencyKey ?? options.operationId
    });
  }

  /** Cut over only after receipt verification; the source is archived by Core. */
  completeWorkspaceTransfer<T = void>(workspaceId: string, transferId: string, options: { operationId: string; idempotencyKey?: string }): Promise<T> {
    return this.transport<T>({
      method: "POST",
      path: `/api/workspaces/${encodeURIComponent(workspaceId)}/transfers/${encodeURIComponent(transferId)}/complete`,
      operationId: options.operationId,
      idempotencyKey: options.idempotencyKey ?? options.operationId
    });
  }

  getCatalog<T = DomainApiCatalog>(workspaceId: string): Promise<T> {
    return this.transport<T>({ method: "GET", path: `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/domain/catalog` });
  }

  executeOperation<T = JsonValue>(workspaceId: string, operationId: string, request: DomainApiRequest, options: { operationId?: string; idempotencyKey?: string } = {}): Promise<DomainApiResponse<T>> {
    return this.transport<DomainApiResponse<T>>({
      method: "POST",
      path: `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/domain/operations/${encodeURIComponent(operationId)}`,
      body: request,
      ...(options.operationId ? { operationId: options.operationId } : {}),
      ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {})
    });
  }

  async runArtifactSurfaceOperation<T = JsonValue>(workspaceId: string, roomId: string, operation: JsonValue, options: { operationId: string; idempotencyKey?: string }): Promise<T> {
    if (!isJsonObject(operation)) throw new Error("artifact_surface_operation_invalid");
    return this.transport<T>({
      method: "POST",
      path: `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/artifacts/surface/operations`,
      // The Server binds the public operation identity to the transport
      // idempotency key.  Normalize a caller-provided operation copy here so
      // a retry cannot be rejected merely because the renderer used a local
      // operation ID.
      body: { room_id: roomId, operation: { ...operation, id: options.operationId } },
      operationId: options.operationId,
      idempotencyKey: options.idempotencyKey ?? options.operationId
    });
  }

  executeQuery<T = JsonValue>(workspaceId: string, queryId: string, request: DomainApiRequest): Promise<DomainApiResponse<T>> {
    return this.transport<DomainApiResponse<T>>({
      method: "POST",
      path: `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/domain/queries/${encodeURIComponent(queryId)}`,
      body: request
    });
  }

  /** Completion management routes are the canonical v1 surface used by
   * Native management clients. They intentionally return the same safe
   * projections as the Domain Query/Operation contracts. */
  listCompletionResources<T = z.infer<typeof PublicCompletionResourcePageSchema>>(workspaceId: string, input: PublicCompletionResourceListInput = {}): Promise<T> {
    const query = new URLSearchParams();
    if (input.scope_kind) query.set("scope_kind", input.scope_kind);
    if (input.room_id) query.set("room_id", input.room_id);
    if (input.kind) query.set("kind", input.kind);
    if (input.include_archived !== undefined) query.set("include_archived", String(input.include_archived));
    if (input.limit !== undefined) query.set("limit", String(input.limit));
    if (input.cursor) query.set("cursor", input.cursor);
    return this.transport<T>({
      method: "GET",
      path: `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/completion/resources${query.size ? `?${query.toString()}` : ""}`
    });
  }

  searchCompletionKnowledge<T = z.infer<typeof PublicCompletionKnowledgeSearchPageSchema>>(workspaceId: string, input: PublicCompletionKnowledgeSearchInput): Promise<T> {
    const query = new URLSearchParams({ room_id: input.room_id, q: input.q });
    if (input.limit !== undefined) query.set("limit", String(input.limit));
    if (input.cursor) query.set("cursor", input.cursor);
    return this.transport<T>({
      method: "GET",
      path: `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/completion/knowledge/search?${query.toString()}`
    });
  }

  getCompletionResource<T = z.infer<typeof PublicCompletionResourceDetailSchema>>(workspaceId: string, resourceId: string, input: { room_id?: string; kind?: "knowledge" | "skill"; versions_limit?: number; evidence_limit?: number } = {}): Promise<T> {
    const query = new URLSearchParams();
    if (input.room_id) query.set("room_id", input.room_id);
    if (input.kind) query.set("kind", input.kind);
    if (input.versions_limit !== undefined) query.set("versions_limit", String(input.versions_limit));
    if (input.evidence_limit !== undefined) query.set("evidence_limit", String(input.evidence_limit));
    return this.transport<T>({
      method: "GET",
      path: `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/completion/resources/${encodeURIComponent(resourceId)}${query.size ? `?${query.toString()}` : ""}`
    });
  }

  getCompletionResourceBody<T = z.infer<typeof PublicCompletionResourceBodySchema>>(workspaceId: string, resourceId: string, input: { room_id?: string; kind?: "knowledge" | "skill"; version?: number } = {}): Promise<T> {
    const query = new URLSearchParams();
    if (input.room_id) query.set("room_id", input.room_id);
    if (input.kind) query.set("kind", input.kind);
    if (input.version !== undefined) query.set("version", String(input.version));
    return this.transport<T>({
      method: "GET",
      path: `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/completion/resources/${encodeURIComponent(resourceId)}/body${query.size ? `?${query.toString()}` : ""}`
    });
  }

  createCompletionResource<T = z.infer<typeof PublicCompletionResourceMutationResponseSchema>>(workspaceId: string, input: PublicCompletionResourceCreateInput, options: { operationId: string; idempotencyKey?: string }): Promise<T> {
    return this.transport<T>({
      method: "POST",
      path: `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/completion/resources`,
      body: input,
      operationId: options.operationId,
      idempotencyKey: options.idempotencyKey ?? options.operationId
    });
  }

  updateCompletionResource<T = z.infer<typeof PublicCompletionResourceMutationResponseSchema>>(workspaceId: string, resourceId: string, input: Omit<PublicCompletionResourceUpdateInput, "resource_id">, options: { operationId: string; idempotencyKey?: string }): Promise<T> {
    return this.transport<T>({
      method: "PATCH",
      path: `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/completion/resources/${encodeURIComponent(resourceId)}`,
      body: input,
      operationId: options.operationId,
      idempotencyKey: options.idempotencyKey ?? options.operationId
    });
  }

  setCompletionResourceArchived<T = z.infer<typeof PublicCompletionResourceMutationResponseSchema>>(workspaceId: string, resourceId: string, input: { room_id?: string; archived: boolean; expected_version: number; reason: string }, options: { operationId: string; idempotencyKey?: string }): Promise<T> {
    return this.transport<T>({
      method: "POST",
      path: `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/completion/resources/${encodeURIComponent(resourceId)}/archive`,
      body: input,
      operationId: options.operationId,
      idempotencyKey: options.idempotencyKey ?? options.operationId
    });
  }

  setCompletionResourceFixed<T = z.infer<typeof PublicCompletionResourceMutationResponseSchema>>(workspaceId: string, resourceId: string, input: { room_id?: string; fixed: boolean; expected_version: number; reason: string }, options: { operationId: string; idempotencyKey?: string }): Promise<T> {
    return this.transport<T>({
      method: "POST",
      path: `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/completion/resources/${encodeURIComponent(resourceId)}/fix`,
      body: input,
      operationId: options.operationId,
      idempotencyKey: options.idempotencyKey ?? options.operationId
    });
  }

  getRuntimeSettings<T = z.infer<typeof PublicRuntimeSettingsSchema>>(workspaceId: string): Promise<T> {
    return this.transport<T>({ method: "GET", path: `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/settings` });
  }

  patchRuntimeSettings<T = { settings: z.infer<typeof PublicRuntimeSettingsSchema>; replayed: boolean }>(workspaceId: string, input: Record<string, JsonValue>, options: { operationId: string; idempotencyKey?: string }): Promise<T> {
    return this.transport<T>({
      method: "PATCH",
      path: `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/settings`,
      body: input,
      operationId: options.operationId,
      idempotencyKey: options.idempotencyKey ?? options.operationId
    });
  }

  getLearningSettings<T = z.infer<typeof PublicLearningSettingsLayersSchema>>(workspaceId: string, roomId: string): Promise<T> {
    return this.transport<T>({ method: "GET", path: `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/learning/settings?room_id=${encodeURIComponent(roomId)}` });
  }

  patchLearningSettings<T = { settings: z.infer<typeof PublicLearningSettingsSchema>; replayed: boolean }>(workspaceId: string, input: z.input<typeof PublicLearningSettingsPatchInputSchema>, options: { operationId: string; idempotencyKey?: string }): Promise<T> {
    return this.transport<T>({
      method: "PATCH",
      path: `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/learning/settings`,
      body: input,
      operationId: options.operationId,
      idempotencyKey: options.idempotencyKey ?? options.operationId
    });
  }

  listAutomationJobs<T = z.infer<typeof PublicAutomationJobListSchema>>(workspaceId: string, roomId?: string): Promise<T> {
    const query = roomId ? `?room_id=${encodeURIComponent(roomId)}` : "";
    return this.transport<T>({ method: "GET", path: `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/automation/jobs${query}` });
  }

  createAutomationJob<T = { job: z.infer<typeof PublicAutomationJobSchema>; replayed: boolean }>(workspaceId: string, input: Record<string, JsonValue>, options: { operationId: string; idempotencyKey?: string }): Promise<T> {
    return this.transport<T>({ method: "POST", path: `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/automation/jobs`, body: input, operationId: options.operationId, idempotencyKey: options.idempotencyKey ?? options.operationId });
  }

  listAutomationRuns<T = { runs: z.infer<typeof PublicAutomationRunSchema>[] }>(workspaceId: string, input: { room_id?: string; job_id?: string }): Promise<T> {
    const query = new URLSearchParams();
    if (input.room_id) query.set("room_id", input.room_id);
    if (input.job_id) query.set("job_id", input.job_id);
    return this.transport<T>({ method: "GET", path: `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/automation/runs?${query.toString()}` });
  }

  setAutomationManagement<T = { job: z.infer<typeof PublicAutomationJobSchema>; replayed: boolean }>(workspaceId: string, jobId: string, state: "allowed" | "manager_stopped", options: { operationId: string; idempotencyKey?: string }): Promise<T> {
    return this.transport<T>({ method: "POST", path: `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/automation/jobs/${encodeURIComponent(jobId)}/management`, body: { state }, operationId: options.operationId, idempotencyKey: options.idempotencyKey ?? options.operationId });
  }

  /** Fixed Room-scoped Artifact revision reads. Body bytes are returned as a
   * numeric byte array for JSON transports; the Desktop route may also expose
   * the same revision through its authenticated file endpoint. */
  listArtifactRevisions<T = JsonValue>(workspaceId: string, roomId: string, artifactId: string): Promise<T> {
    return this.transport<T>({
      method: "GET",
      path: `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/artifacts/${encodeURIComponent(artifactId)}/revisions?room_id=${encodeURIComponent(roomId)}`
    });
  }

  getArtifactRevision<T = JsonValue>(workspaceId: string, roomId: string, artifactId: string, revisionId: string): Promise<T> {
    return this.transport<T>({
      method: "GET",
      path: `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/artifacts/${encodeURIComponent(artifactId)}/revisions/${encodeURIComponent(revisionId)}?room_id=${encodeURIComponent(roomId)}`
    });
  }

  listGeneratedSurfaces<T = JsonValue>(workspaceId: string, roomId: string): Promise<T> {
    return this.transport<T>({
      method: "GET",
      path: `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/generated-surfaces?room_id=${encodeURIComponent(roomId)}`
    });
  }

  getGeneratedSurface<T = JsonValue>(workspaceId: string, roomId: string, surfaceId: string): Promise<T> {
    return this.transport<T>({
      method: "GET",
      path: `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/generated-surfaces/${encodeURIComponent(surfaceId)}?room_id=${encodeURIComponent(roomId)}`
    });
  }

  getGeneratedSurfaceBundle<T = JsonValue>(workspaceId: string, roomId: string, surfaceId: string, revisionId: string): Promise<T> {
    return this.transport<T>({
      method: "GET",
      path: `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/generated-surfaces/${encodeURIComponent(surfaceId)}/revisions/${encodeURIComponent(revisionId)}/bundle?room_id=${encodeURIComponent(roomId)}`
    });
  }

  runGeneratedSurfaceAction<T = JsonValue>(workspaceId: string, roomId: string, surfaceId: string, actionId: string, input: Record<string, JsonValue>, options: { operationId: string; idempotencyKey?: string }): Promise<T> {
    return this.transport<T>({
      method: "POST",
      path: `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/generated-surfaces/${encodeURIComponent(surfaceId)}/actions/${encodeURIComponent(actionId)}/run`,
      body: { room_id: roomId, ...input },
      operationId: options.operationId,
      idempotencyKey: options.idempotencyKey ?? options.operationId
    });
  }

  runGeneratedSurfaceState<T = JsonValue>(workspaceId: string, roomId: string, surfaceId: string, input: Record<string, JsonValue>, options: { operationId: string; idempotencyKey?: string }): Promise<T> {
    return this.transport<T>({
      method: "POST",
      path: `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/generated-surfaces/${encodeURIComponent(surfaceId)}/state`,
      body: { room_id: roomId, ...input },
      operationId: options.operationId,
      idempotencyKey: options.idempotencyKey ?? options.operationId
    });
  }

  exportGeneratedSurface<T = JsonValue>(workspaceId: string, roomId: string, surfaceId: string, input: { revision_id?: string; format: "html" | "zip" }): Promise<T> {
    const query = new URLSearchParams({ room_id: roomId, format: input.format });
    if (input.revision_id) query.set("revision_id", input.revision_id);
    return this.transport<T>({
      method: "GET",
      path: `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/generated-surfaces/${encodeURIComponent(surfaceId)}/export?${query.toString()}`
    });
  }

  createRoom<T = PublicRoomRecord>(workspaceId: string, input: PublicRoomCreateInput, options: { operationId: string; idempotencyKey?: string }): Promise<DomainApiResponse<T>> {
    return this.executeOperation<T>(workspaceId, "room.create", { context: {}, input }, options);
  }

  listRoomWorks<T = PublicRoomWorkRecord[]>(workspaceId: string, roomId: string, input: PublicRoomWorkListInput = {}): Promise<DomainApiResponse<T>> {
    return this.executeQuery<T>(workspaceId, "room.work.list", { context: { room_id: roomId }, input });
  }

  viewRoomWork<T = PublicRoomWorkView>(workspaceId: string, roomId: string, input: PublicRoomWorkViewInput): Promise<DomainApiResponse<T>> {
    return this.executeQuery<T>(workspaceId, "room.work.view", { context: { room_id: roomId }, input });
  }

  createRoomWork<T = PublicRoomWorkRecord>(workspaceId: string, roomId: string, input: PublicRoomWorkCreateInput, options: { operationId: string; idempotencyKey?: string }): Promise<DomainApiResponse<T>> {
    return this.executeOperation<T>(workspaceId, "room.work.create", { context: { room_id: roomId }, input }, options);
  }

  replyRoomWork<T = PublicRoomWorkInstruction>(workspaceId: string, roomId: string, input: PublicRoomWorkReplyInput, options: { operationId: string; idempotencyKey?: string }): Promise<DomainApiResponse<T>> {
    return this.executeOperation<T>(workspaceId, "room.work.reply", { context: { room_id: roomId }, input }, options);
  }

  createRoomWorkComment<T = PublicRoomWorkComment>(workspaceId: string, roomId: string, input: PublicRoomWorkCommentCreateInput, options: { operationId: string; idempotencyKey?: string }): Promise<DomainApiResponse<T>> {
    return this.executeOperation<T>(workspaceId, "room.work.comment.create", { context: { room_id: roomId }, input }, options);
  }

  applyRoomWorkComment<T = PublicRoomWorkInstruction>(workspaceId: string, roomId: string, input: PublicRoomWorkCommentApplyInput, options: { operationId: string; idempotencyKey?: string }): Promise<DomainApiResponse<T>> {
    return this.executeOperation<T>(workspaceId, "room.work.comment.apply", { context: { room_id: roomId }, input }, options);
  }

  setRoomWorkCommentReaction<T = PublicRoomWorkReactionRecord>(workspaceId: string, roomId: string, input: PublicRoomWorkCommentReactionSetInput, options: { operationId: string; idempotencyKey?: string }): Promise<DomainApiResponse<T>> {
    return this.executeOperation<T>(workspaceId, "room.work.comment.reaction.set", { context: { room_id: roomId }, input }, options);
  }

  setRoomDefaultAgent<T = PublicRoomDefaultAgentRecord>(workspaceId: string, roomId: string, input: PublicRoomDefaultAgentSetInput, options: { operationId: string; idempotencyKey?: string }): Promise<DomainApiResponse<T>> {
    return this.executeOperation<T>(workspaceId, "room.default_agent.set", { context: { room_id: roomId }, input }, options);
  }

  listRoomMembers<T = PublicRoomMemberListRecord>(workspaceId: string, roomId: string): Promise<DomainApiResponse<T>> {
    return this.executeQuery<T>(workspaceId, "room.member.list", { context: { room_id: roomId }, input: {} });
  }

  listAgentBackends<T = PublicAgentBackendRecord[]>(workspaceId: string): Promise<DomainApiResponse<T>> {
    return this.executeQuery<T>(workspaceId, "agent.backend.list", { context: {}, input: {} });
  }

  setRoomAgentPermission<T = PublicRoomAgentPermissionRecord>(workspaceId: string, roomId: string, input: PublicRoomAgentPermissionSetInput, options: { operationId: string; idempotencyKey?: string }): Promise<DomainApiResponse<T>> {
    return this.executeOperation<T>(workspaceId, "room.agent.permission.set", { context: { room_id: roomId }, input }, options);
  }

  removeRoomAgent<T = PublicRoomAgentPermissionRecord>(workspaceId: string, roomId: string, input: PublicRoomAgentRemoveInput, options: { operationId: string; idempotencyKey?: string }): Promise<DomainApiResponse<T>> {
    return this.executeOperation<T>(workspaceId, "room.agent.remove", { context: { room_id: roomId }, input }, options);
  }

  openAgentDm<T = PublicAgentDmRecord>(workspaceId: string, input: PublicAgentDmOpenInput, options: { operationId: string; idempotencyKey?: string }): Promise<DomainApiResponse<T>> {
    return this.executeOperation<T>(workspaceId, "agent.dm.open", { context: {}, input }, options);
  }

  stopRoomWork<T = PublicRoomWorkControl>(workspaceId: string, roomId: string, input: PublicRoomWorkStopInput, options: { operationId: string; idempotencyKey?: string }): Promise<DomainApiResponse<T>> {
    return this.executeOperation<T>(workspaceId, "room.work.stop", { context: { room_id: roomId }, input }, options);
  }

  stopRoomWorkAssignee<T = PublicRoomWorkControl>(workspaceId: string, roomId: string, input: PublicRoomWorkAssigneeStopInput, options: { operationId: string; idempotencyKey?: string }): Promise<DomainApiResponse<T>> {
    return this.executeOperation<T>(workspaceId, "room.work.assignee.stop", { context: { room_id: roomId }, input }, options);
  }

  reassignRoomWorkAssignee<T = PublicRoomWorkAssignee>(workspaceId: string, roomId: string, input: PublicRoomWorkAssigneeReassignInput, options: { operationId: string; idempotencyKey?: string }): Promise<DomainApiResponse<T>> {
    return this.executeOperation<T>(workspaceId, "room.work.assignee.reassign", { context: { room_id: roomId }, input }, options);
  }

  delegateRoomWorkAssignee<T = PublicRoomWorkAssignee>(workspaceId: string, roomId: string, input: PublicRoomWorkAssigneeDelegateInput, options: { operationId: string; idempotencyKey?: string }): Promise<DomainApiResponse<T>> {
    return this.executeOperation<T>(workspaceId, "room.work.assignee.delegate", { context: { room_id: roomId }, input }, options);
  }

  ingestActivity<T = JsonValue>(workspaceId: string, request: ActivityIngestRequest, options: { operationId?: string; idempotencyKey?: string } = {}): Promise<DomainApiResponse<T>> {
    return this.transport<DomainApiResponse<T>>({
      method: "POST",
      path: `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/activities`,
      body: request,
      ...(options.operationId ? { operationId: options.operationId } : {}),
      ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {})
    });
  }

  controlRun<T = JsonValue>(workspaceId: string, runId: string, action: RunControlAction, request: RunControlInput, options: { operationId?: string; idempotencyKey?: string } = {}): Promise<DomainApiResponse<T>> {
    return this.transport<DomainApiResponse<T>>({
      method: "POST",
      path: `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/runs/${encodeURIComponent(runId)}/actions/${encodeURIComponent(action)}`,
      body: request,
      ...(options.operationId ? { operationId: options.operationId } : {}),
      ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {})
    });
  }

  listEvents(workspaceId: string, input: { roomId?: string; afterCursor?: string; limit?: number } = {}): Promise<EventReplayPage> {
    const query = new URLSearchParams();
    if (input.roomId) query.set("room_id", input.roomId);
    if (input.afterCursor) query.set("after_cursor", input.afterCursor);
    if (input.limit !== undefined) query.set("limit", String(input.limit));
    return this.transport<EventReplayPage>({
      method: "GET",
      path: `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/events${query.size ? `?${query.toString()}` : ""}`
    });
  }
}

function isJsonObject(value: JsonValue): value is Record<string, JsonValue> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isCanonicalBase64(value: string): boolean {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return false;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  if (padding === 0) return true;
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const lastDataCharacter = value[value.length - padding - 1];
  const sextet = lastDataCharacter === undefined ? -1 : alphabet.indexOf(lastDataCharacter);
  if (sextet < 0) return false;
  return (sextet & (padding === 1 ? 0b11 : 0b1111)) === 0;
}

function isSafePublicGeneratedSurfaceAssetPath(value: string): boolean {
  if (value.startsWith("/") || value.includes("\\") || value.includes("//")) return false;
  return value.split("/").every((part) => part !== "" && part !== "." && part !== "..")
    && /^[A-Za-z0-9._~/-]+$/.test(value);
}

function refinePublicArtifactContentOutput(
  value: { content?: string; content_base64?: string; encoding?: "utf8" | "binary" },
  issue: z.RefinementCtx
): void {
  if (value.content_base64 !== undefined && value.encoding !== "binary") {
    issue.addIssue({ code: z.ZodIssueCode.custom, path: ["encoding"], message: "artifact_binary_content_encoding_required" });
  }
  if (value.encoding === "binary" && value.content_base64 === undefined) {
    issue.addIssue({ code: z.ZodIssueCode.custom, path: ["content_base64"], message: "artifact_binary_content_base64_required" });
  }
}

export function publicEventResources(event: PublicEventEnvelope): ResourceRef[] {
  return event.resources.map((resource) => ({ ...resource }));
}
