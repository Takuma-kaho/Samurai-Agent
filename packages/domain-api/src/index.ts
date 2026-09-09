import {
  ActivityFailureSchema,
  ActivityVerificationRecordSchema,
  ArtifactContentEncodingSchema,
  ArtifactRecordSchema,
  ArtifactRevisionRecordSchema,
  GeneratedSurfaceDefinitionSchema,
  GeneratedSurfaceRevisionRecordSchema,
  PublicAgentDmRecordSchema as CorePublicAgentDmRecordSchema,
  PublicRoomWorkAssigneeSchema as CorePublicRoomWorkAssigneeSchema,
  PublicRoomWorkCommentSchema as CorePublicRoomWorkCommentSchema,
  PublicRoomWorkControlSchema as CorePublicRoomWorkControlSchema,
  PublicRoomWorkInstructionSchema as CorePublicRoomWorkInstructionSchema,
  PublicRoomWorkReactionSchema as CorePublicRoomWorkReactionSchema,
  PublicRoomWorkRecordSchema as CorePublicRoomWorkRecordSchema,
  PublicRoomWorkViewSchema as CorePublicRoomWorkViewSchema,
  ResourceRefSchema,
  WorkspaceFileResourceRefSchema,
  RoomKindSchema as CoreRoomKindSchema,
  RoomWorkAssignmentStatusSchema as CoreRoomWorkAssignmentStatusSchema,
  RoomWorkStatusSchema as CoreRoomWorkStatusSchema,
  ResourceUsageRecordSchema,
  AgentBackendKindSchema,
  BackendConnectionStateSchema,
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

const publicArtifactMutationOutputSchema = z.object({
  artifact: ArtifactRecordSchema,
  content: z.string().optional(),
  content_bytes: z.array(z.number().int().min(0).max(255)).optional(),
  mime_type: z.string().trim().min(1).max(255).optional(),
  encoding: ArtifactContentEncodingSchema.optional(),
  revision: ArtifactRevisionRecordSchema.optional(),
  repair: z.object({ repaired: z.boolean() }).strict().optional(),
  replayed: z.boolean()
}).strict();

const publicArtifactViewOutputSchema = z.object({
  artifact: ArtifactRecordSchema,
  content: z.string(),
  content_bytes: z.array(z.number().int().min(0).max(255)).optional(),
  mime_type: z.string().trim().min(1).max(255),
  encoding: ArtifactContentEncodingSchema,
  revision: ArtifactRevisionRecordSchema.optional()
}).strict();

const publicGeneratedSurfaceMutationOutputSchema = z.object({
  definition: GeneratedSurfaceDefinitionSchema.optional(),
  revision: GeneratedSurfaceRevisionRecordSchema.optional(),
  replayed: z.boolean().optional()
}).strict();

const publicGeneratedSurfaceActionOutputSchema = z.object({
  surface: GeneratedSurfaceDefinitionSchema,
  action: z.record(jsonValueSchema),
  command: z.record(jsonValueSchema),
  interaction: z.record(jsonValueSchema).optional(),
  target_result: jsonValueSchema.optional()
}).strict();

/** Output projections are part of the public contract. The PostgreSQL v1
 * adapter returns these projections instead of the internal legacy records. */
export function publicOperationOutputSchemaFor(operationId: string, fallback: z.ZodTypeAny): z.ZodTypeAny {
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
    bundle: z.object({ html: z.string(), css: z.string().optional(), script: z.string().optional() }).strict(),
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
  if (operationId === "room.member.list") return z.object({}).strict();
  if (operationId === "room.agent.permission.set") return PublicRoomAgentPermissionSetInputSchema;
  if (operationId === "room.agent.remove") return PublicRoomAgentRemoveInputSchema;
  if (operationId === "room.work.create") return PublicRoomWorkCreateInputSchema;
  if (operationId === "room.work.reply") return PublicRoomWorkReplyInputSchema;
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
  method: "GET" | "POST";
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

  runArtifactSurfaceOperation<T = JsonValue>(workspaceId: string, roomId: string, operation: JsonValue, options: { operationId: string; idempotencyKey?: string }): Promise<T> {
    return this.transport<T>({
      method: "POST",
      path: `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/artifacts/surface/operations`,
      body: { room_id: roomId, operation },
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

export function publicEventResources(event: PublicEventEnvelope): ResourceRef[] {
  return event.resources.map((resource) => ({ ...resource }));
}
