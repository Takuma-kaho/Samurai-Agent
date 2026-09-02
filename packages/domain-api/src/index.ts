import {
  ActivityFailureSchema,
  ActivityVerificationRecordSchema,
  ArtifactRecordSchema,
  ArtifactRevisionRecordSchema,
  ResourceRefSchema,
  ResourceUsageRecordSchema,
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
  version: z.number().int().nonnegative(),
  can_manage: z.boolean().optional(),
  can_execute: z.boolean().optional(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime()
}).strict();
export type PublicRoomRecord = z.infer<typeof PublicRoomRecordSchema>;

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
  organization_id: z.string().trim().min(1).max(512),
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
  organization_id: z.string().trim().min(1).max(512),
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

export const PublicWorkspaceMoveMemberSummarySchema = z.object({
  account_id: z.string().trim().min(1).max(512),
  workspace_role: z.enum(["owner", "admin", "member", "guest"]),
  target_organization_role: z.enum(["owner", "admin", "member", "guest"]).optional(),
  will_add_as_guest: z.boolean()
}).strict();
export type PublicWorkspaceMoveMemberSummary = z.infer<typeof PublicWorkspaceMoveMemberSummarySchema>;

export const PublicWorkspaceMovePreflightSchema = z.object({
  operation_id: z.string().trim().min(1).max(512),
  source_organization_id: z.string().trim().min(1).max(512),
  target_organization_id: z.string().trim().min(1).max(512),
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
  source_organization_id: z.string().trim().min(1).max(512),
  target_organization_id: z.string().trim().min(1).max(512),
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
  source_organization_id: z.string().trim().min(1).max(512),
  integrity_hash: z.string().regex(/^[a-f0-9]{64}$/i),
  record_counts: z.record(z.number().int().nonnegative())
}).strict();
export type PublicWorkspaceBundleManifest = z.infer<typeof PublicWorkspaceBundleManifestSchema>;

export const PublicWorkspaceBundleExportResultSchema = z.object({
  bundle_id: z.string().trim().min(1).max(512),
  workspace_id: z.string().trim().min(1).max(512),
  source_organization_id: z.string().trim().min(1).max(512),
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
  target_organization_id: z.string().trim().min(1).max(512),
  schema_version: z.number().int().positive(),
  integrity_hash: z.string().regex(/^[a-f0-9]{64}$/i),
  status: z.enum(["restored", "failed"]),
  restored_at: z.string().datetime(),
  event_id: z.string().trim().min(1).max(512).optional(),
  failure_code: z.string().trim().min(1).max(256).optional()
}).strict();
export type PublicWorkspaceBundleRestoreResult = z.infer<typeof PublicWorkspaceBundleRestoreResultSchema>;

/** The first public product slice. Keep this list in the shared contract
 * package so the Server catalog and generated documentation cannot drift. */
export const publicDomainOperationIds = Object.freeze([
  "room.list", "room.view", "room.create", "room.patch",
  "agent.list", "agent.view", "agent.create", "agent.patch", "agent.backend.bind",
  "artifact.list", "artifact.view", "artifact.create", "artifact.revise", "artifact.restore_revision", "artifact.repair",
  "session.create", "chat.turn.run",
  "organization.list", "organization.view", "organization.create", "organization.patch", "organization.delete",
  "organization.member.list", "organization.member.invite", "organization.member.accept", "organization.member.role.change", "organization.member.remove", "organization.member.leave",
  "organization.invitation.list", "organization.invitation.revoke", "organization.invitation.reissue", "organization.invitation.extend",
  "organization.workspace.list", "organization.workspace.create", "organization.workspace.member.grant", "organization.workspace.member.revoke", "organization.workspace.archive", "organization.workspace.restore", "organization.workspace.delete",
  "workspace.organization.move.preflight", "workspace.organization.move.commit", "workspace.organization.move.status",
  "workspace.bundle.export", "workspace.bundle.restore"
] as const);
export type PublicDomainOperationId = (typeof publicDomainOperationIds)[number];

const publicArtifactMutationOutputSchema = z.object({
  artifact: ArtifactRecordSchema,
  content: z.string().optional(),
  revision: ArtifactRevisionRecordSchema.optional(),
  repair: z.object({ repaired: z.boolean() }).strict().optional(),
  replayed: z.boolean()
}).strict();

/** Output projections are part of the public contract. The PostgreSQL v1
 * adapter returns these projections instead of the internal legacy records. */
export function publicOperationOutputSchemaFor(operationId: string, fallback: z.ZodTypeAny): z.ZodTypeAny {
  if (operationId === "room.list") return z.array(PublicRoomRecordSchema);
  if (["room.view", "room.create", "room.patch"].includes(operationId)) return PublicRoomRecordSchema;
  if (operationId === "agent.list") return z.array(PublicAgentRecordSchema);
  if (["agent.view", "agent.create", "agent.patch", "agent.backend.bind"].includes(operationId)) return PublicAgentRecordSchema;
  if (["artifact.create", "artifact.revise", "artifact.restore_revision", "artifact.repair"].includes(operationId)) return publicArtifactMutationOutputSchema;
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
  "workspace.agent.changed": z.object({ agent_id: z.string().trim().min(1), action: z.enum(["created", "patched", "backend_bound"]) }).strict(),
  "workspace.artifact.changed": z.object({ artifact_id: z.string().trim().min(1), action: z.enum(["created", "revised", "restored", "repaired"]), revision_id: z.string().trim().min(1).optional() }).strict(),
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
  "workspace.agent.changed": ["agent"],
  "workspace.artifact.changed": ["artifact", "artifact_revision"],
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

  executeQuery<T = JsonValue>(workspaceId: string, queryId: string, request: DomainApiRequest): Promise<DomainApiResponse<T>> {
    return this.transport<DomainApiResponse<T>>({
      method: "POST",
      path: `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/domain/queries/${encodeURIComponent(queryId)}`,
      body: request
    });
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
