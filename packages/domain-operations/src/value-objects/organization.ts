import { z } from "zod";

/** Identifiers crossing the Organization API are opaque and never display names or emails. */
export const organizationIdSchema = z.string().trim().min(1).max(512);
export const accountIdSchema = z.string().trim().min(1).max(512);
export const workspaceIdSchema = z.string().trim().min(1).max(512);
export const operationIdSchema = z.string().trim().min(1).max(512);

export const organizationRoleSchema = z.enum(["owner", "admin", "member", "guest"]);
export const organizationMembershipStateSchema = z.enum(["active", "removed"]);
export const organizationStatusSchema = z.enum(["active", "deleted"]);
export const workspaceLifecycleStateSchema = z.enum(["active", "archived", "deleted"]);
export const workspaceMembershipRoleSchema = z.enum(["owner", "admin", "member", "guest"]);
export const workspaceMembershipStateSchema = z.enum(["active", "revoked"]);
export const invitationStatusSchema = z.enum(["pending", "accepted", "revoked", "expired"]);
export const workspaceMoveStatusSchema = z.enum(["preflight", "queued", "running", "committed", "failed", "rolled_back"]);

const versionSchema = z.number().int().positive();
const timestampSchema = z.string().datetime();

export const organizationRecordSchema = z.object({
  id: organizationIdSchema,
  name: z.string().trim().min(1).max(200),
  icon: z.string().trim().max(1_024).optional(),
  description: z.string().max(20_000).optional(),
  status: organizationStatusSchema,
  version: versionSchema,
  created_by: accountIdSchema,
  created_at: timestampSchema,
  updated_at: timestampSchema,
  deleted_at: timestampSchema.optional()
}).strict();
export type OrganizationRecord = z.infer<typeof organizationRecordSchema>;

/** Member projections intentionally omit email and other account-private fields. */
export const organizationMembershipRecordSchema = z.object({
  id: organizationIdSchema,
  organization_id: organizationIdSchema,
  account_id: accountIdSchema,
  role: organizationRoleSchema,
  state: organizationMembershipStateSchema,
  version: versionSchema,
  joined_at: timestampSchema,
  removed_at: timestampSchema.optional(),
  created_by: accountIdSchema,
  updated_by: accountIdSchema.optional(),
  display_name: z.string().trim().min(1).max(200).optional(),
  updated_at: timestampSchema
}).strict();
export type OrganizationMembershipRecord = z.infer<typeof organizationMembershipRecordSchema>;

/** Invitation records never contain a raw token; only the one-time issue result may. */
export const organizationInvitationRecordSchema = z.object({
  id: organizationIdSchema,
  organization_id: organizationIdSchema,
  target_account_id: accountIdSchema.optional(),
  role: organizationRoleSchema,
  status: invitationStatusSchema,
  expires_at: timestampSchema,
  accepted_at: timestampSchema.optional(),
  revoked_at: timestampSchema.optional(),
  issued_by: accountIdSchema,
  version: versionSchema,
  created_at: timestampSchema,
  updated_at: timestampSchema
}).strict();
export type OrganizationInvitationRecord = z.infer<typeof organizationInvitationRecordSchema>;

export const organizationInvitationIssueResultSchema = z.object({
  invitation: organizationInvitationRecordSchema,
  /** Ephemeral token returned only at issue time; never persisted or emitted in Events. */
  one_time_token: z.string().trim().min(1).max(2_048).optional()
}).strict();
export type OrganizationInvitationIssueResult = z.infer<typeof organizationInvitationIssueResultSchema>;

/** Workspace list output is metadata only. It contains no Room, Message, or Knowledge content. */
export const organizationWorkspaceRecordSchema = z.object({
  id: workspaceIdSchema,
  organization_id: organizationIdSchema,
  name: z.string().trim().min(1).max(200),
  state: workspaceLifecycleStateSchema,
  version: versionSchema,
  created_by: accountIdSchema,
  created_at: timestampSchema,
  updated_at: timestampSchema,
  deleted_at: timestampSchema.optional(),
  can_access: z.boolean(),
  role: workspaceMembershipRoleSchema.optional()
}).strict();
export type OrganizationWorkspaceRecord = z.infer<typeof organizationWorkspaceRecordSchema>;

export const organizationWorkspaceMembershipRecordSchema = z.object({
  id: organizationIdSchema,
  organization_id: organizationIdSchema,
  workspace_id: workspaceIdSchema,
  account_id: accountIdSchema,
  role: workspaceMembershipRoleSchema,
  state: workspaceMembershipStateSchema,
  version: versionSchema,
  joined_at: timestampSchema,
  revoked_at: timestampSchema.optional(),
  created_by: accountIdSchema,
  updated_by: accountIdSchema.optional(),
  updated_at: timestampSchema
}).strict();
export type OrganizationWorkspaceMembershipRecord = z.infer<typeof organizationWorkspaceMembershipRecordSchema>;

/** Move previews expose only membership IDs/roles required for explicit confirmation. */
export const workspaceMoveMemberSummarySchema = z.object({
  account_id: accountIdSchema,
  workspace_role: workspaceMembershipRoleSchema,
  target_organization_role: organizationRoleSchema.optional(),
  will_add_as_guest: z.boolean()
}).strict();

export const workspaceMovePreflightSchema = z.object({
  operation_id: operationIdSchema,
  source_organization_id: organizationIdSchema,
  target_organization_id: organizationIdSchema,
  workspace_id: workspaceIdSchema,
  workspace_version: versionSchema,
  workspace_state: workspaceLifecycleStateSchema,
  existing_members: z.array(workspaceMoveMemberSummarySchema).max(10_000),
  missing_members: z.array(workspaceMoveMemberSummarySchema).max(10_000),
  requires_guest_confirmation: z.boolean(),
  write_blocked: z.boolean(),
  failure_conditions: z.array(z.string().trim().min(1).max(1_000)).max(100),
  expires_at: timestampSchema,
  created_at: timestampSchema
}).strict();
export type WorkspaceMovePreflight = z.infer<typeof workspaceMovePreflightSchema>;

export const workspaceMoveResultSchema = z.object({
  operation_id: operationIdSchema,
  workspace_id: workspaceIdSchema,
  source_organization_id: organizationIdSchema,
  target_organization_id: organizationIdSchema,
  status: workspaceMoveStatusSchema,
  guest_membership_account_ids: z.array(accountIdSchema).max(10_000),
  event_id: operationIdSchema.optional(),
  committed_at: timestampSchema.optional(),
  failure_code: z.string().trim().min(1).max(256).optional()
}).strict();
export type WorkspaceMoveResult = z.infer<typeof workspaceMoveResultSchema>;

export const workspaceMoveStatusRecordSchema = workspaceMoveResultSchema.extend({
  updated_at: timestampSchema
}).strict();
export type WorkspaceMoveStatusRecord = z.infer<typeof workspaceMoveStatusRecordSchema>;

/** Bundle metadata is deliberately detached from the bundle's private JSONL content. */
export const workspaceBundleManifestSchema = z.object({
  schema_version: z.number().int().positive(),
  workspace_id: workspaceIdSchema,
  source_organization_id: organizationIdSchema,
  integrity_hash: z.string().regex(/^[a-f0-9]{64}$/i),
  record_counts: z.record(z.number().int().nonnegative())
}).strict();

export const workspaceBundleExportResultSchema = z.object({
  bundle_id: operationIdSchema,
  workspace_id: workspaceIdSchema,
  source_organization_id: organizationIdSchema,
  schema_version: z.number().int().positive(),
  integrity_hash: z.string().regex(/^[a-f0-9]{64}$/i),
  file_count: z.number().int().nonnegative(),
  byte_size: z.number().int().nonnegative(),
  manifest: workspaceBundleManifestSchema,
  created_at: timestampSchema
}).strict();
export type WorkspaceBundleExportResult = z.infer<typeof workspaceBundleExportResultSchema>;

export const workspaceBundleRestoreResultSchema = z.object({
  bundle_id: operationIdSchema,
  workspace_id: workspaceIdSchema,
  source_organization_id: organizationIdSchema.optional(),
  target_organization_id: organizationIdSchema,
  schema_version: z.number().int().positive(),
  integrity_hash: z.string().regex(/^[a-f0-9]{64}$/i),
  status: z.enum(["restored", "failed"]),
  restored_at: timestampSchema,
  event_id: operationIdSchema.optional(),
  failure_code: z.string().trim().min(1).max(256).optional()
}).strict();
export type WorkspaceBundleRestoreResult = z.infer<typeof workspaceBundleRestoreResultSchema>;

export const paginationInputSchema = z.object({
  cursor: z.string().trim().min(1).max(512).optional(),
  limit: z.number().int().min(1).max(200).optional()
}).strict();

export const expectedVersionInputSchema = z.object({
  expected_version: z.number().int().positive().optional()
}).strict();
