import { createHash } from "node:crypto";
import { z } from "zod";
import { ConnectorEvidenceSchema, SessionRefSchema, type ConnectorEvidence, type JsonValue, type SessionRef } from "./core-schemas-compat.js";

export const externalIntegrationVersion = "05.1" as const;
export const mcpProtocolVersion = "2025-11-25" as const;

export const externalClientKinds = ["codex", "claude_code", "hermes", "opencode", "openclaw", "other"] as const;
export type ExternalClientKind = (typeof externalClientKinds)[number];

export const externalOperatingSystems = ["darwin", "win32", "linux"] as const;
export type ExternalOperatingSystem = (typeof externalOperatingSystems)[number];

export const externalTransportKinds = ["streamable_http", "stdio"] as const;
export type ExternalTransportKind = (typeof externalTransportKinds)[number];

export const externalOAuthScopes = [
  "workspace.read",
  "room.read",
  "knowledge.read",
  "skill.read",
  "artifact.read",
  "collection.read",
  "activity.read",
  "resource.write",
  "activity.ingest",
  "approval.execute",
  "room.binding.write"
] as const;
export type ExternalOAuthScope = (typeof externalOAuthScopes)[number];

export const dangerousExternalOperations = [
  "artifact.revise",
  "artifact.restore_revision",
  "collection.schema.save",
  "collection.record.delete",
  "wiki.patch",
  "wiki.archive",
  "skill.patch",
  "resource.copy",
  "resource.move",
  "resource.promote",
  "resource.redact",
  "room.binding.change",
] as const;
export type DangerousExternalOperation = (typeof dangerousExternalOperations)[number];

export const externalCaptureRecordKinds = ["conversation", "terminal", "intermediate_log"] as const;
export type ExternalCaptureRecordKind = (typeof externalCaptureRecordKinds)[number];

export const externalCaptureAvailability = ["captured", "disabled", "unsupported", "partial", "quota_exceeded"] as const;
export type ExternalCaptureAvailability = (typeof externalCaptureAvailability)[number];

export const externalRetentionDays = [7, 30, 90] as const;
export type ExternalRetentionDays = (typeof externalRetentionDays)[number];

export const approvalStates = ["pending", "approved", "executing", "denied", "expired", "executed", "failed", "outcome_unknown"] as const;
export type ApprovalState = (typeof approvalStates)[number];

export const externalIntegrationErrorCodes = [
  "oauth_client_not_found",
  "oauth_redirect_uri_mismatch",
  "oauth_scope_invalid",
  "oauth_resource_invalid",
  "oauth_pkce_required",
  "oauth_state_invalid",
  "oauth_code_invalid",
  "oauth_code_expired",
  "oauth_code_replayed",
  "oauth_authorization_denied",
  "oauth_grant_revoked",
  "oauth_token_expired",
  "oauth_refresh_replayed",
  "oauth_account_mismatch",
  "oauth_browser_session_required",
  "oauth_client_registration_forbidden",
  "oauth_rate_limited",
  "connection_not_found",
  "connection_revoked",
  "connector_disabled",
  "room_binding_required",
  "room_binding_version_conflict",
  "room_binding_room_denied",
  "external_session_restart_required",
  "context_snapshot_too_large",
  "approval_required",
  "approval_not_found",
  "approval_expired",
  "approval_account_mismatch",
  "approval_room_mismatch",
  "approval_input_changed",
  "approval_version_changed",
  "approval_replayed",
  "approval_outcome_unknown",
  "activity_event_conflict",
  "capture_policy_invalid",
  "capture_disabled",
  "capture_unsupported",
  "capture_quota_exceeded",
  "connector_manifest_invalid",
  "connector_version_unsupported",
  "mcp_session_required",
  "mcp_auth_required",
  "mcp_tool_not_found",
  "mcp_invalid_arguments",
  "mcp_invalid_result",
  "mcp_method_not_found",
  "mcp_protocol_version_unsupported",
  "mcp_origin_invalid",
  "mcp_session_expired",
  "mcp_session_limit",
  "mcp_session_identity_changed",
  "mcp_transport_method_not_allowed",
  "mcp_timeout",
  "mcp_cancelled",
  "mcp_outcome_unknown"
] as const;
export type ExternalIntegrationErrorCode = (typeof externalIntegrationErrorCodes)[number];

export class ExternalIntegrationError extends Error {
  constructor(
    readonly code: ExternalIntegrationErrorCode,
    message: string = code,
    readonly retryable = false,
    readonly status = statusForExternalError(code)
  ) {
    super(message);
    this.name = "ExternalIntegrationError";
  }
}

/** Converts errors raised by the formal Runtime ingress into the public
 * External Integration error vocabulary. The Runtime package deliberately
 * does not depend on this package, so the HTTP/MCP boundary performs this
 * structural translation instead of leaking an internal error or stack. */
export function normalizeExternalIntegrationError(error: unknown): ExternalIntegrationError | undefined {
  if (error instanceof ExternalIntegrationError) return error;
  if (!error || typeof error !== "object") return undefined;
  const candidate = error as { code?: unknown; message?: unknown; scope?: unknown };
  if (typeof candidate.code !== "string") return undefined;
  const message = typeof candidate.message === "string" ? candidate.message : candidate.code;
  switch (candidate.code) {
    case "external_app_connection_not_found":
      return new ExternalIntegrationError("connection_not_found", message);
    case "external_app_connection_revoked":
      return new ExternalIntegrationError("connection_revoked", message);
    case "external_app_connector_mismatch":
    case "external_app_app_mismatch":
    case "external_app_delegated_principal_inactive":
      return new ExternalIntegrationError("oauth_account_mismatch", message);
    case "external_app_connection_room_scope_denied":
    case "external_app_room_permission_denied":
      return new ExternalIntegrationError("room_binding_room_denied", message);
    case "external_app_ingress_class_denied":
      return new ExternalIntegrationError("oauth_scope_invalid", message);
    case "external_app_requested_room_invalid":
      return new ExternalIntegrationError("mcp_invalid_arguments", message);
    case "source_not_allowed":
      return new ExternalIntegrationError(
        /domain_operation_source_not_allowed/.test(message) ? "mcp_method_not_found" : "room_binding_room_denied",
        message
      );
    case "outcome_unknown":
      return new ExternalIntegrationError("mcp_outcome_unknown", message, false);
    case "forbidden":
      return new ExternalIntegrationError("room_binding_room_denied", message);
    case "validation":
    case "invalid_input":
    case "bad_request":
      return new ExternalIntegrationError("mcp_invalid_arguments", message);
    case "conflict":
      return new ExternalIntegrationError(message.includes("room") ? "room_binding_version_conflict" : "approval_version_changed", message);
    case "not_found":
      return new ExternalIntegrationError("mcp_invalid_arguments", message);
    case "unavailable":
    case "backend_cancelled":
      return new ExternalIntegrationError(/cancel|abort|deadline/i.test(message) ? "mcp_cancelled" : "mcp_invalid_result", message, /cancel|abort|deadline/i.test(message));
    default:
      return undefined;
  }
}

function statusForExternalError(code: ExternalIntegrationErrorCode): number {
  if (code === "oauth_rate_limited") return 429;
  if (code === "mcp_timeout") return 504;
  if (code === "mcp_cancelled") return 499;
  if (code === "mcp_outcome_unknown") return 409;
  if (code === "oauth_redirect_uri_mismatch" || code === "oauth_pkce_required" || code === "oauth_state_invalid" || code === "oauth_code_invalid" || code === "oauth_code_expired" || code === "oauth_code_replayed" || code === "oauth_refresh_replayed") return 400;
  if (code === "oauth_authorization_denied") return 403;
  if (code === "oauth_client_registration_forbidden" || code === "oauth_scope_invalid" || code === "oauth_resource_invalid") return 403;
  if (code.startsWith("oauth_") || code === "mcp_auth_required") return 401;
  if (code === "connection_revoked" || code === "connector_disabled") return 403;
  if (code.includes("not_found") || code === "mcp_tool_not_found") return 404;
  if (code.includes("version_conflict") || code.includes("changed") || code === "approval_replayed" || code === "approval_outcome_unknown") return 409;
  if (code === "activity_event_conflict") return 409;
  if (code === "capture_quota_exceeded") return 413;
  if (code === "approval_required" || code === "room_binding_required") return 428;
  if (code.startsWith("mcp_")) return 400;
  return 422;
}

export const OAuthClientRegistrationSchema = z.object({
  client_id: z.string().trim().min(1).max(200),
  client_name: z.string().trim().min(1).max(200),
  /** Present only for a dynamically registered client. Pre-registered
   * official clients stay shared Connector configuration. */
  workspace_id: z.string().trim().min(1).optional(),
  connector_id: z.string().trim().min(1).max(200),
  redirect_uris: z.array(z.string().url()).min(1).max(20),
  allowed_scopes: z.array(z.enum(externalOAuthScopes)).min(1),
  public_client: z.boolean(),
  client_secret_hash: z.string().trim().min(1).max(256).optional(),
  created_at: z.string().datetime(),
  disabled_at: z.string().datetime().optional()
}).strict().superRefine((client, issue) => {
  if (!client.public_client && !client.client_secret_hash) {
    issue.addIssue({ code: z.ZodIssueCode.custom, message: "confidential_client_requires_secret_hash", path: ["client_secret_hash"] });
  }
  if (new Set(client.redirect_uris).size !== client.redirect_uris.length) {
    issue.addIssue({ code: z.ZodIssueCode.custom, message: "duplicate_redirect_uri", path: ["redirect_uris"] });
  }
  if (new Set(client.allowed_scopes).size !== client.allowed_scopes.length) {
    issue.addIssue({ code: z.ZodIssueCode.custom, message: "duplicate_oauth_scope", path: ["allowed_scopes"] });
  }
});
export type OAuthClientRegistration = z.infer<typeof OAuthClientRegistrationSchema>;

export const OAuthAuthorizationRequestSchema = z.object({
  id: z.string().trim().min(1),
  workspace_id: z.string().trim().min(1),
  state: z.string().trim().min(1).max(2_000),
  state_hash: z.string().length(64),
  client_id: z.string().trim().min(1),
  connector_id: z.string().trim().min(1),
  redirect_uri: z.string().url(),
  scopes: z.array(z.enum(externalOAuthScopes)).min(1),
  code_challenge: z.string().trim().min(43).max(128),
  code_challenge_method: z.literal("S256"),
  response_type: z.literal("code"),
  resource: z.string().url().optional(),
  created_at: z.string().datetime(),
  expires_at: z.string().datetime(),
  authorized_account_id: z.string().trim().min(1).optional(),
  authorized_subject: z.string().trim().min(1).optional(),
  approved_at: z.string().datetime().optional(),
  denied_at: z.string().datetime().optional(),
  denied_by: z.string().trim().min(1).optional(),
  consumed_at: z.string().datetime().optional()
}).strict();
export type OAuthAuthorizationRequest = z.infer<typeof OAuthAuthorizationRequestSchema>;

export const OAuthAuthorizationCodeSchema = z.object({
  id: z.string().trim().min(1),
  workspace_id: z.string().trim().min(1),
  code_hash: z.string().length(64),
  request_id: z.string().trim().min(1),
  client_id: z.string().trim().min(1),
  account_id: z.string().trim().min(1),
  subject: z.string().trim().min(1),
  scopes: z.array(z.enum(externalOAuthScopes)).min(1),
  redirect_uri: z.string().url(),
  /** The protected MCP Resource selected at authorization time.  Optional
   * only for records created before Server 05 began audience binding. */
  resource: z.string().url().optional(),
  code_challenge: z.string().trim().min(43).max(128),
  created_at: z.string().datetime(),
  expires_at: z.string().datetime(),
  consumed_at: z.string().datetime().optional()
}).strict();
export type OAuthAuthorizationCode = z.infer<typeof OAuthAuthorizationCodeSchema>;

export const OAuthGrantSchema = z.object({
  id: z.string().trim().min(1),
  workspace_id: z.string().trim().min(1),
  client_id: z.string().trim().min(1),
  connection_id: z.string().trim().min(1),
  account_id: z.string().trim().min(1),
  subject: z.string().trim().min(1),
  scope: z.array(z.enum(externalOAuthScopes)).min(1),
  /** OAuth Resource Indicator.  Tokens are never accepted by another MCP
   * endpoint merely because they came from the same authorization server. */
  resource: z.string().url().optional(),
  access_token_hash: z.string().length(64),
  refresh_token_hash: z.string().length(64),
  issued_at: z.string().datetime(),
  access_expires_at: z.string().datetime(),
  refresh_expires_at: z.string().datetime(),
  token_version: z.number().int().positive(),
  refresh_token_hash_history: z.array(z.string().length(64)).max(10).default([]),
  revoked_at: z.string().datetime().optional()
}).strict();
export type OAuthGrant = z.infer<typeof OAuthGrantSchema>;

export const RoomBindingSchema = z.object({
  id: z.string().trim().min(1),
  workspace_id: z.string().trim().min(1),
  connection_id: z.string().trim().min(1),
  account_id: z.string().trim().min(1),
  project_ref: z.string().trim().min(1).max(2_000),
  room_id: z.string().trim().min(1),
  binding_version: z.number().int().positive(),
  created_at: z.string().datetime(),
  changed_at: z.string().datetime(),
  changed_by: z.string().trim().min(1)
}).strict();
export type RoomBinding = z.infer<typeof RoomBindingSchema>;

export const ExternalSessionRecordSchema = z.object({
  id: z.string().trim().min(1),
  external_session_id: z.string().trim().min(1).max(2_000),
  /** Project is part of the external Session boundary. Optional only for
   * records written before Server 05 began persisting this identity. */
  project_ref: z.string().trim().min(1).max(2_000).optional(),
  workspace_id: z.string().trim().min(1),
  connection_id: z.string().trim().min(1),
  account_id: z.string().trim().min(1),
  room_id: z.string().trim().min(1),
  binding_version: z.number().int().positive(),
  connector_id: z.string().trim().min(1),
  connector_version: z.string().trim().min(1),
  capabilities: z.record(z.boolean()),
  started_at: z.string().datetime(),
  ended_at: z.string().datetime().optional(),
  capture_completeness: z.enum(["full", "partial", "unsupported"])
}).strict();
export type ExternalSessionRecord = z.infer<typeof ExternalSessionRecordSchema>;

export const ContextSnapshotSchema = z.object({
  id: z.string().trim().min(1),
  workspace_id: z.string().trim().min(1),
  connection_id: z.string().trim().min(1).optional(),
  account_id: z.string().trim().min(1).optional(),
  connector_id: z.string().trim().min(1).optional(),
  app_id: z.string().trim().min(1).optional(),
  room_id: z.string().trim().min(1),
  external_session_id: z.string().trim().min(1),
  binding_version: z.number().int().positive(),
  resource_versions: z.array(z.object({ resource_id: z.string(), version: z.union([z.number().int().positive(), z.string().trim().min(1)]) }).strict()),
  content: z.string().min(1),
  omitted_sections: z.array(z.string().trim().min(1)).default([]),
  token_count: z.number().int().positive().max(1_500),
  content_hash: z.string().length(64),
  snapshot_version: z.number().int().positive(),
  created_at: z.string().datetime(),
  frozen: z.literal(true)
}).strict();
export type ContextSnapshot = z.infer<typeof ContextSnapshotSchema>;

export const ApprovalRequestSchema = z.object({
  id: z.string().trim().min(1),
  workspace_id: z.string().trim().min(1),
  operation: z.string().trim().min(1).max(200),
  target: z.record(z.unknown()),
  canonical_input: z.string().min(1),
  input_hash: z.string().length(64),
  account_id: z.string().trim().min(1),
  room_id: z.string().trim().min(1),
  expected_versions: z.record(z.number().int().positive()),
  idempotency_key: z.string().trim().min(1),
  state: z.enum(approvalStates),
  approval_token_hash: z.string().length(64),
  created_at: z.string().datetime(),
  expires_at: z.string().datetime(),
  approved_at: z.string().datetime().optional(),
  approved_by: z.string().trim().min(1).optional(),
  executing_at: z.string().datetime().optional(),
  executed_at: z.string().datetime().optional(),
  execution_result: z.record(z.unknown()).optional(),
  failure_code: z.string().trim().min(1).optional()
}).strict();
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

export const CapturePolicySchema = z.object({
  id: z.string().trim().min(1),
  workspace_id: z.string().trim().min(1),
  connection_id: z.string().trim().min(1),
  account_id: z.string().trim().min(1),
  enabled: z.boolean().default(false),
  conversation: z.boolean().default(false),
  terminal: z.boolean().default(false),
  intermediate_log: z.boolean().default(false),
  retention_days: z.union([z.literal(7), z.literal(30), z.literal(90)]).default(30),
  quota_bytes: z.number().int().positive().max(10 * 1024 * 1024 * 1024),
  redaction_policy_version: z.string().trim().min(1),
  updated_at: z.string().datetime()
}).strict();
export type CapturePolicy = z.infer<typeof CapturePolicySchema>;

export const RawExternalRecordSchema = z.object({
  id: z.string().trim().min(1),
  workspace_id: z.string().trim().min(1),
  connection_id: z.string().trim().min(1),
  account_id: z.string().trim().min(1).default("legacy"),
  project_ref: z.string().trim().min(1).max(2_000).optional(),
  external_session_id: z.string().trim().min(1),
  room_id: z.string().trim().min(1),
  kind: z.enum(externalCaptureRecordKinds),
  encrypted_payload: z.string().min(1),
  iv: z.string().min(1),
  auth_tag: z.string().min(1),
  key_id: z.string().trim().min(1).max(200).default("legacy"),
  content_hash: z.string().length(64),
  size_bytes: z.number().int().nonnegative(),
  created_at: z.string().datetime(),
  delete_at: z.string().datetime(),
  availability: z.enum(externalCaptureAvailability),
  truncated: z.boolean(),
  missing_reason: z.string().trim().min(1).optional()
}).strict();
export type RawExternalRecord = z.infer<typeof RawExternalRecordSchema>;

/** Counter used only for atomic Capture quota reservation.  Workspace content
 * remains outside this operational integration state. */
export const CaptureQuotaUsageSchema = z.object({
  id: z.string().trim().min(1),
  workspace_id: z.string().trim().min(1),
  connection_id: z.string().trim().min(1),
  used_bytes: z.number().int().nonnegative(),
  updated_at: z.string().datetime()
}).strict();
export type CaptureQuotaUsage = z.infer<typeof CaptureQuotaUsageSchema>;

export const ConnectorManifestSchema = z.object({
  connector_id: z.string().trim().min(1).max(200),
  display_name: z.string().trim().min(1).max(200),
  provider: z.string().trim().min(1).max(200),
  version: z.string().trim().min(1).max(100),
  supported_os: z.array(z.enum(externalOperatingSystems)).min(1),
  required_samurai_version: z.string().trim().min(1),
  transport: z.enum(externalTransportKinds),
  oauth_redirect_uris: z.array(z.string().url()).max(20),
  /** Exact callbacks are the normal case.  Official local Clients may use a
   * loopback callback selected during DCR; the URI is still saved exactly and
   * must match every later authorization/token exchange. */
  oauth_redirect_uri_policy: z.enum(["exact", "loopback"]).default("exact"),
  requested_scopes: z.array(z.enum(externalOAuthScopes)).min(1),
  supported_events: z.array(z.string().trim().min(1)).default([]),
  context_injection: z.enum(["server_instructions", "startup_tool", "project_config", "unsupported"]),
  full_capture: z.enum(["supported", "partial", "unsupported"]),
  url_elicitation: z.enum(["supported", "fallback", "unsupported"]),
  hook_command: z.string().trim().min(1).max(2_000).optional(),
  package_checksum: z.string().trim().min(1).max(256),
  disabled_at: z.string().datetime().optional()
}).strict().superRefine((manifest, issue) => {
  if (new Set(manifest.oauth_redirect_uris).size !== manifest.oauth_redirect_uris.length) {
    issue.addIssue({ code: z.ZodIssueCode.custom, message: "duplicate_connector_redirect_uri", path: ["oauth_redirect_uris"] });
  }
  if (new Set(manifest.requested_scopes).size !== manifest.requested_scopes.length) {
    issue.addIssue({ code: z.ZodIssueCode.custom, message: "duplicate_connector_scope", path: ["requested_scopes"] });
  }
});
export type ConnectorManifest = z.infer<typeof ConnectorManifestSchema>;

export const ConnectorInstallationSchema = z.object({
  id: z.string().trim().min(1),
  workspace_id: z.string().trim().min(1),
  connector_id: z.string().trim().min(1),
  version: z.string().trim().min(1),
  package_checksum: z.string().trim().min(1).max(256).optional(),
  enabled: z.boolean(),
  installed_at: z.string().datetime(),
  disabled_at: z.string().datetime().optional()
}).strict();
export type ConnectorInstallation = z.infer<typeof ConnectorInstallationSchema>;

export const ConnectorEventSchema = z.object({
  connector_id: z.string().trim().min(1),
  connector_version: z.string().trim().min(1),
  event_id: z.string().trim().min(1),
  event_kind: z.string().trim().min(1),
  external_session_id: z.string().trim().min(1),
  app_id: z.string().trim().min(1),
  instruction: z.string().trim().min(1).optional(),
  result: z.string().trim().min(1).optional(),
  changed_resources: z.array(z.string().trim().min(1)).default([]),
  verification: z.enum(["confirmed", "failed", "not_run", "unknown"]).default("unknown"),
  failure: z.string().trim().min(1).optional(),
  outcome: z.enum(["completed", "failed", "cancelled", "unknown"]).default("unknown"),
  occurred_at: z.string().datetime(),
  payload: z.record(z.unknown()).default({})
}).strict();
export type ConnectorEvent = z.infer<typeof ConnectorEventSchema>;

export const AuditEventSchema = z.object({
  id: z.string().trim().min(1),
  event_type: z.string().trim().min(1).max(200),
  actor_id: z.string().trim().min(1).optional(),
  workspace_id: z.string().trim().min(1).optional(),
  connection_id: z.string().trim().min(1).optional(),
  connector_id: z.string().trim().min(1).optional(),
  account_id: z.string().trim().min(1).optional(),
  resource_type: z.string().trim().min(1).max(200),
  resource_id: z.string().trim().min(1),
  data: z.record(z.unknown()).default({}),
  created_at: z.string().datetime()
}).strict();
export type AuditEvent = z.infer<typeof AuditEventSchema>;

export interface ExternalIntegrationRecordMap {
  oauth_client: OAuthClientRegistration;
  oauth_authorization_request: OAuthAuthorizationRequest;
  oauth_authorization_code: OAuthAuthorizationCode;
  oauth_grant: OAuthGrant;
  room_binding: RoomBinding;
  external_session: ExternalSessionRecord;
  context_snapshot: ContextSnapshot;
  approval_request: ApprovalRequest;
  capture_policy: CapturePolicy;
  raw_external_record: RawExternalRecord;
  capture_quota_usage: CaptureQuotaUsage;
  connector_manifest: ConnectorManifest;
  connector_installation: ConnectorInstallation;
  activity_event: {
    id: string;
    identity_key: string;
    payload_hash: string;
    dedupe_key: string;
    created_at: string;
    /** Optional durable scope for integrations that share one SQLite database
     * across Workspaces. Legacy Activity records may omit these fields. */
    workspace_id?: string;
    connection_id?: string;
    account_id?: string;
    project_ref?: string;
    event: ConnectorEvent;
  };
  audit_event: AuditEvent;
}

export type ExternalIntegrationRecordType = keyof ExternalIntegrationRecordMap;

export type ExternalIntegrationAtomicMutation =
  | { kind: "create"; type: ExternalIntegrationRecordType; record: ExternalIntegrationRecordMap[ExternalIntegrationRecordType] }
  | { kind: "update"; type: ExternalIntegrationRecordType; id: string; expectedVersion: number; record: ExternalIntegrationRecordMap[ExternalIntegrationRecordType] }
  | { kind: "delete"; type: ExternalIntegrationRecordType; id: string; expectedVersion?: number };

export interface CaptureQuotaReservation {
  record: RawExternalRecord;
  quotaBytes: number;
}

export interface CaptureRecordRelease {
  recordId: string;
  auditEvent?: AuditEvent;
}

export interface ExternalIntegrationStore {
  getRecord<K extends ExternalIntegrationRecordType>(type: K, id: string): Promise<ExternalIntegrationRecordMap[K] | undefined>;
  getRecordVersion(type: ExternalIntegrationRecordType, id: string): Promise<number | undefined>;
  listRecords<K extends ExternalIntegrationRecordType>(type: K, input?: { workspaceId?: string; connectionId?: string; connectorId?: string; accountId?: string; projectRef?: string; externalSessionId?: string }): Promise<ExternalIntegrationRecordMap[K][]>;
  createRecord<K extends ExternalIntegrationRecordType>(type: K, record: ExternalIntegrationRecordMap[K]): Promise<ExternalIntegrationRecordMap[K]>;
  updateRecord<K extends ExternalIntegrationRecordType>(type: K, id: string, expectedVersion: number, record: ExternalIntegrationRecordMap[K]): Promise<boolean>;
  deleteRecord(type: ExternalIntegrationRecordType, id: string): Promise<boolean>;
  /** Applies all compare-and-swap mutations or none. */
  atomic(mutations: readonly ExternalIntegrationAtomicMutation[]): Promise<boolean>;
  /** Reserves Capture quota and stores the encrypted record in one transaction. */
  reserveCapture(input: CaptureQuotaReservation): Promise<"created" | "quota_exceeded">;
  /** Deletes a Capture record, releases quota, and optionally appends its Audit
   * event in the same transaction. */
  releaseCapture(input: CaptureRecordRelease): Promise<boolean>;
}

export interface ExternalAppConnectionLookup {
  getExternalAppConnection(id: string): Promise<{
    id: string;
    workspace_id: string;
    connector_id: string;
    app_id: string;
    status: "active" | "revoked";
    delegated_principal: { kind: "human" | "agent"; participant_id?: string; agent_id?: string; requested_by_participant_id?: string };
    allowed_room_ids: string[];
    ingress_classes: Array<"query" | "domain_operation" | "activity_ingest">;
  } | undefined>;
  getExternalAppConnectionByConnector(input: { workspaceId: string; connectorId: string }): Promise<Awaited<ReturnType<ExternalAppConnectionLookup["getExternalAppConnection"]>>>;
}

export interface ExternalRoomAuthorization {
  assertRoom(principal: { kind: "human" | "agent"; participantId?: string; agentId?: string; requestedByParticipantId?: string }, roomId: string, action: "read" | "edit" | "execute" | "manage_settings"): Promise<void>;
}

export interface ExternalIntegrationAuthContext {
  workspaceId: string;
  accountId: string;
  connectionId: string;
  connectorId: string;
  appId: string;
  scopes: ExternalOAuthScope[];
  tokenVersion: number;
  expiresAt: string;
}

export interface ExternalWorkspaceTarget {
  workspaceId: string;
  roomId: string;
  projectRef: string;
  accountId: string;
  connectionId: string;
  connectorId: string;
  appId: string;
  bindingVersion: number;
  externalSessionId: string;
  sessionRef?: SessionRef;
}

export const ConnectorEvidenceForMcpSchema = ConnectorEvidenceSchema;
export type McpConnectorEvidence = ConnectorEvidence;

export function hashOpaqueToken(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function stableCanonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ExternalIntegrationError("mcp_invalid_arguments", "non_finite_number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableCanonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableCanonicalJson(record[key])}`).join(",")}}`;
  }
  throw new ExternalIntegrationError("mcp_invalid_arguments", "unsupported_json_value");
}

export function hashCanonicalJson(value: unknown): string {
  return createHash("sha256").update(stableCanonicalJson(value)).digest("hex");
}

export function parseSessionRef(value: unknown): SessionRef | undefined {
  if (value === undefined) return undefined;
  return SessionRefSchema.parse(value);
}

export function jsonObject(value: unknown): Record<string, JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ExternalIntegrationError("mcp_invalid_arguments", "object_required");
  return value as Record<string, JsonValue>;
}
