import { randomBytes } from "node:crypto";
import Ajv, { type ValidateFunction } from "ajv";
import {
  ConnectorEventSchema,
  ExternalIntegrationError,
  hashCanonicalJson,
  mcpProtocolVersion,
  normalizeExternalIntegrationError,
  type ConnectorEvent,
  type ExternalIntegrationAuthContext,
  type ExternalWorkspaceTarget
} from "./contracts.js";
import { approvalRequired, ApprovalService } from "./approval.js";
import { CaptureService } from "./capture.js";
import { redactConnectorEvent } from "./activity.js";

export interface McpWorkspacePort {
  getBinding(input: { auth: ExternalIntegrationAuthContext; workspaceId: string; projectRef: string }, control?: McpRequestControl): Promise<Record<string, unknown> | undefined>;
  resolveTarget(auth: ExternalIntegrationAuthContext, input: { workspaceId: string; projectRef: string; externalSessionId: string }, control?: McpRequestControl): Promise<ExternalWorkspaceTarget>;
  getCapabilities(target: ExternalWorkspaceTarget): Promise<Record<string, unknown>>;
  getContextSnapshot(target: ExternalWorkspaceTarget, control?: McpRequestControl): Promise<Record<string, unknown>>;
  query(target: ExternalWorkspaceTarget, operation: McpQueryOperation, args: Record<string, unknown>, control?: McpRequestControl): Promise<Record<string, unknown>>;
  mutate(target: ExternalWorkspaceTarget, operation: string, args: Record<string, unknown>, idempotencyKey: string, expectedVersions: Record<string, number>, control?: McpRequestControl): Promise<Record<string, unknown>>;
  ingestActivity(target: ExternalWorkspaceTarget, event: ConnectorEvent, control?: McpRequestControl): Promise<Record<string, unknown>>;
  getCurrentVersions(target: ExternalWorkspaceTarget, keys: string[], control?: McpRequestControl): Promise<Record<string, number>>;
  assertTargetCurrent?(target: ExternalWorkspaceTarget): Promise<void>;
  changeBinding?(target: ExternalWorkspaceTarget, input: Record<string, unknown>, control?: McpRequestControl): Promise<Record<string, unknown>>;
}

/** Cancellation follows the operation down to the formal ingress. Once a
 * write begins, a disconnected Client receives an explicit unknown outcome
 * rather than a misleading cancelled/success response. */
export interface McpRequestControl {
  signal: AbortSignal;
  markWriteStarted(): void;
}

export interface McpAuthPort {
  authenticateAccessToken(token: string, input?: { resourceUrl?: string }): Promise<ExternalIntegrationAuthContext>;
}

export interface McpMutationToolDefinition {
  name: string;
  operation: string;
  description: string;
  scopes: string[];
  inputSchema: Record<string, unknown>;
  /** JSON Schema for the successful structured result. Approval-required
   * mutations additionally advertise the shared approval result schema. */
  outputSchema: Record<string, unknown>;
}

export interface McpTransportContext {
  origin?: string;
  protocolVersion?: string;
  projectRef?: string;
  externalSessionId?: string;
}

export interface McpProtocolServerOptions {
  auth: McpAuthPort;
  workspace: McpWorkspacePort;
  approval: ApprovalService;
  /** Hook Capture is operational integration state. It uses the already
   * authenticated/Room-bound MCP target, never a Workspace Store shortcut. */
  capture?: CaptureService;
  serverName?: string;
  serverVersion?: string;
  protocolVersion?: string;
  mutationTools?: McpMutationToolDefinition[];
  allowedOrigins?: string[];
  maxSessions?: number;
  sessionTtlMs?: number;
  toolTimeoutMs?: number;
  /** Canonical MCP Resource used to reject a token issued for another
   * endpoint before resolving any Workspace target. */
  protectedResourceUrl?: string;
}

export interface ExternalCaptureHookInput {
  projectRef: string;
  externalSessionId: string;
  eventId: string;
  kind: "conversation" | "terminal" | "intermediate_log";
  text?: string;
  payload?: unknown;
  signal?: AbortSignal;
}

/** A Client Hook sends the normalized Activity event through the same OAuth,
 * Project→Room resolution, and Activity Ingest path as an MCP tool call. */
export interface ExternalActivityHookInput {
  projectRef: string;
  event: ConnectorEvent;
  signal?: AbortSignal;
}

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: Record<string, unknown> };
}

export type McpQueryOperation = "knowledge.search" | "knowledge.read" | "skill.search" | "skill.read" | "skill.file.read" | "artifact.list" | "artifact.read" | "collection.list" | "collection.read" | "activity.list" | "activity.read";

interface McpSession {
  id: string;
  initialized: boolean;
  clientName: string;
  clientVersion: string;
  urlElicitation: boolean;
  createdAt: number;
  lastSeenAt: number;
  accountId?: string;
  connectionId?: string;
  projectRef?: string;
  externalSessionId?: string;
}

const targetProperties = {
  project_ref: { type: "string", minLength: 1 },
  external_session_id: { type: "string", minLength: 1 }
};

const connectorEventSchema = {
  type: "object",
  properties: {
    connector_id: { type: "string", minLength: 1 },
    connector_version: { type: "string", minLength: 1 },
    event_id: { type: "string", minLength: 1 },
    event_kind: { type: "string", minLength: 1 },
    external_session_id: { type: "string", minLength: 1 },
    app_id: { type: "string", minLength: 1 },
    instruction: { type: "string", minLength: 1 },
    result: { type: "string", minLength: 1 },
    changed_resources: { type: "array", items: { type: "string", minLength: 1 }, maxItems: 200 },
    verification: { type: "string", enum: ["confirmed", "failed", "not_run", "unknown"] },
    failure: { type: "string", minLength: 1 },
    outcome: { type: "string", enum: ["completed", "failed", "cancelled", "unknown"] },
    occurred_at: { type: "string", minLength: 1 },
    payload: { type: "object", additionalProperties: true }
  },
  required: ["connector_id", "connector_version", "event_id", "event_kind", "external_session_id", "app_id", "occurred_at"],
  additionalProperties: false
};

/** MCP's outputSchema describes `structuredContent`, not the surrounding MCP
 * content array. Every public read is a fixed envelope. `data` holds the
 * already Room-authorized formal-query payload; it remains an object because
 * Artifact, Collection, Knowledge, Skill, and Activity have different
 * resource schemas. No formal query may add arbitrary MCP top-level fields. */
const opaqueDataSchema: Record<string, unknown> = { type: "object", additionalProperties: true };

const evidenceOutputSchema = objectSchema({
  connector_id: { type: "string", minLength: 1 },
  app_id: { type: "string", minLength: 1 }
}, ["connector_id", "app_id"]);

const provenanceOutputSchema = objectSchema({
  source: { const: "samurai" },
  access: { const: "ExternalAppIngress" },
  room_id: { type: "string", minLength: 1 },
  resource_id: { type: "string", minLength: 1 }
}, ["source", "access", "room_id", "resource_id"]);

const resourceItemOutputSchema = objectSchema({
  resource_id: { type: "string", minLength: 1 },
  room_id: { type: "string", minLength: 1 },
  version: { anyOf: [{ type: "integer", minimum: 1 }, { type: "string", minLength: 1 }] },
  evidence: evidenceOutputSchema,
  provenance: provenanceOutputSchema,
  updated_at: { type: "string", minLength: 1 },
  data: opaqueDataSchema
}, ["resource_id", "room_id", "version", "evidence", "provenance", "data"]);

const resourcePageOutputSchema = objectSchema({
  items: { type: "array", items: resourceItemOutputSchema },
  next_cursor: { type: ["string", "null"] }
}, ["items", "next_cursor"]);

const resourceReadOutputSchema = objectSchema({
  item: resourceItemOutputSchema
}, ["item"]);

const capabilitiesOutputSchema = objectSchema({
  connector_id: { type: "string", minLength: 1 },
  app_id: { type: "string", minLength: 1 },
  manifest: { anyOf: [opaqueDataSchema, { type: "null" }] },
  installation: { anyOf: [opaqueDataSchema, { type: "null" }] },
  external_app_direction: { const: "external_app_to_samurai" },
  room_rechecked_per_call: { const: true },
  context_snapshot: { const: true },
  structured_activity_ingest: { const: true },
  available_mutations: { type: "array", items: { type: "string", minLength: 1 } }
}, ["connector_id", "app_id", "manifest", "installation", "external_app_direction", "room_rechecked_per_call", "context_snapshot", "structured_activity_ingest", "available_mutations"]);

const roomBindingOutputSchema = objectSchema({
  id: { type: "string", minLength: 1 },
  workspace_id: { type: "string", minLength: 1 },
  connection_id: { type: "string", minLength: 1 },
  account_id: { type: "string", minLength: 1 },
  project_ref: { type: "string", minLength: 1 },
  room_id: { type: "string", minLength: 1 },
  binding_version: { type: "integer", minimum: 1 },
  created_at: { type: "string", minLength: 1 },
  changed_at: { type: "string", minLength: 1 },
  changed_by: { type: "string", minLength: 1 }
}, ["id", "workspace_id", "connection_id", "account_id", "project_ref", "room_id", "binding_version", "created_at", "changed_at", "changed_by"]);

const contextSnapshotOutputSchema = objectSchema({
  id: { type: "string", minLength: 1 },
  workspace_id: { type: "string", minLength: 1 },
  connection_id: { type: "string", minLength: 1 },
  account_id: { type: "string", minLength: 1 },
  connector_id: { type: "string", minLength: 1 },
  app_id: { type: "string", minLength: 1 },
  room_id: { type: "string", minLength: 1 },
  external_session_id: { type: "string", minLength: 1 },
  binding_version: { type: "integer", minimum: 1 },
  resource_versions: { type: "array", items: objectSchema({ resource_id: { type: "string", minLength: 1 }, version: { anyOf: [{ type: "integer", minimum: 1 }, { type: "string", minLength: 1 }] } }, ["resource_id", "version"]) },
  content: { type: "string", minLength: 1 },
  omitted_sections: { type: "array", items: { type: "string", minLength: 1 } },
  token_count: { type: "integer", minimum: 1, maximum: 1500 },
  content_hash: { type: "string", pattern: "^[a-f0-9]{64}$" },
  snapshot_version: { type: "integer", minimum: 1 },
  created_at: { type: "string", minLength: 1 },
  frozen: { const: true }
}, ["id", "workspace_id", "connection_id", "account_id", "connector_id", "app_id", "room_id", "external_session_id", "binding_version", "resource_versions", "content", "omitted_sections", "token_count", "content_hash", "snapshot_version", "created_at", "frozen"]);

const approvalStatusOutputSchema = objectSchema({
  id: { type: "string", minLength: 1 },
  workspace_id: { type: "string", minLength: 1 },
  operation: { type: "string", minLength: 1 },
  target: opaqueDataSchema,
  canonical_input: { type: "string", minLength: 1 },
  input_hash: { type: "string", pattern: "^[a-f0-9]{64}$" },
  account_id: { type: "string", minLength: 1 },
  room_id: { type: "string", minLength: 1 },
  expected_versions: { type: "object", additionalProperties: { type: "integer", minimum: 1 } },
  idempotency_key: { type: "string", minLength: 1 },
  state: { type: "string", enum: ["pending", "approved", "executing", "denied", "expired", "executed", "failed", "outcome_unknown"] },
  approval_token_hash: { type: "string", pattern: "^[a-f0-9]{64}$" },
  created_at: { type: "string", minLength: 1 },
  expires_at: { type: "string", minLength: 1 },
  approved_at: { type: "string", minLength: 1 },
  approved_by: { type: "string", minLength: 1 },
  executing_at: { type: "string", minLength: 1 },
  executed_at: { type: "string", minLength: 1 },
  execution_result: opaqueDataSchema,
  failure_code: { type: "string", minLength: 1 }
}, ["id", "workspace_id", "operation", "target", "canonical_input", "input_hash", "account_id", "room_id", "expected_versions", "idempotency_key", "state", "approval_token_hash", "created_at", "expires_at"]);

const activityIngestOutputSchema: Record<string, unknown> = {
  anyOf: [
    objectSchema({ accepted: { const: true }, duplicate: { const: false }, activity: opaqueDataSchema }, ["accepted", "duplicate", "activity"]),
    objectSchema({ accepted: { const: true }, duplicate: { const: true }, event: connectorEventSchema }, ["accepted", "duplicate", "event"])
  ]
};

const approvalOutputSchema: Record<string, unknown> = objectSchema({
  approval_required: { const: true },
  approval_id: { type: "string", minLength: 1 },
  approval_url: { type: "string", minLength: 1 },
  elicitation: objectSchema({
    mode: { type: "string", enum: ["url", "fallback_link"] },
    url: { type: "string", minLength: 1 }
  }, ["mode", "url"])
}, ["approval_required", "approval_id", "approval_url", "elicitation"]);

const tools = [
  tool("samurai.capabilities", "Get connector and server capabilities.", ["workspace.read"], objectSchema(targetProperties), capabilitiesOutputSchema),
  tool("samurai.room.binding.get", "Get the current project-to-Room binding.", ["room.read"], objectSchema({ project_ref: targetProperties.project_ref }), roomBindingOutputSchema),
  tool("samurai.context.snapshot", "Get the frozen startup Context Snapshot.", ["workspace.read", "room.read"], objectSchema(targetProperties), contextSnapshotOutputSchema),
  tool("samurai.room.binding.change", "Request a Room binding change.", ["room.binding.write", "approval.execute"], objectSchema({
    project_ref: targetProperties.project_ref,
    room_id: { type: "string", minLength: 1 },
    external_session_id: targetProperties.external_session_id,
    idempotency_key: { type: "string", minLength: 1 },
    expected_binding_version: { type: "integer", minimum: 1 }
  }, ["room_id", "idempotency_key", "expected_binding_version"]), approvalOutputSchema),
  tool("samurai.approval.status", "Get the status of a Samurai approval.", ["approval.execute"], objectSchema({ approval_id: { type: "string", minLength: 1 } }, ["approval_id"]), approvalStatusOutputSchema),
  tool("samurai.knowledge.search", "Search Room Knowledge.", ["knowledge.read"], objectSchema({ ...targetProperties, query: { type: "string" }, kind: { type: "string", enum: ["wiki", "memory"] }, limit: { type: "integer", minimum: 1, maximum: 200 }, cursor: { type: "string", minLength: 1 } }), resourcePageOutputSchema),
  tool("samurai.knowledge.read", "Read one scoped Knowledge resource.", ["knowledge.read"], objectSchema({ ...targetProperties, knowledge_id: { type: "string", minLength: 1 }, kind: { type: "string", enum: ["wiki", "memory"] }, path: { type: "string", minLength: 1 } }), resourceReadOutputSchema),
  tool("samurai.skill.search", "Search Room Skills.", ["skill.read"], objectSchema({ ...targetProperties, query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 200 }, cursor: { type: "string", minLength: 1 } }), resourcePageOutputSchema),
  tool("samurai.skill.read", "Read one scoped Skill.", ["skill.read"], objectSchema({ ...targetProperties, skill_id: { type: "string", minLength: 1 } }, ["skill_id"]), resourceReadOutputSchema),
  tool("samurai.skill.file.read", "Read one scoped Skill support file.", ["skill.read"], objectSchema({ ...targetProperties, skill_id: { type: "string", minLength: 1 }, path: { type: "string", minLength: 1 } }, ["skill_id", "path"]), resourceReadOutputSchema),
  tool("samurai.artifact.list", "List Room Artifacts.", ["artifact.read"], objectSchema({ ...targetProperties, path: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 200 }, cursor: { type: "string", minLength: 1 } }), resourcePageOutputSchema),
  tool("samurai.artifact.read", "Read one Room Artifact.", ["artifact.read"], objectSchema({ ...targetProperties, path: { type: "string", minLength: 1 } }, ["path"]), resourceReadOutputSchema),
  tool("samurai.collection.list", "List Room Collections.", ["collection.read"], objectSchema({ ...targetProperties, query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 200 }, cursor: { type: "string", minLength: 1 } }), resourcePageOutputSchema),
  tool("samurai.collection.read", "Read a Collection schema or records.", ["collection.read"], objectSchema({ ...targetProperties, collection_id: { type: "string", minLength: 1 }, records: { type: "boolean" }, ids: { type: "array", items: { type: "string" } }, fields: { type: "array", items: { type: "string" } } }, ["collection_id"]), resourceReadOutputSchema),
  tool("samurai.activity.list", "List structured Activity evidence.", ["activity.read"], objectSchema({ ...targetProperties, source_kind: { type: "string" }, source_id: { type: "string" }, status: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 200 }, cursor: { type: "string" } }), resourcePageOutputSchema),
  tool("samurai.activity.read", "Read scoped Activity evidence.", ["activity.read"], objectSchema({ ...targetProperties, activity_id: { type: "string", minLength: 1 } }, ["activity_id"]), resourceReadOutputSchema),
  tool("samurai.activity.ingest", "Ingest one structured external Activity event.", ["activity.ingest"], objectSchema({ ...targetProperties, event: connectorEventSchema }, ["event"]), activityIngestOutputSchema)
];

const queryToolOperations: Record<string, McpQueryOperation> = {
  "samurai.knowledge.search": "knowledge.search",
  "samurai.knowledge.read": "knowledge.read",
  "samurai.skill.search": "skill.search",
  "samurai.skill.read": "skill.read",
  "samurai.skill.file.read": "skill.file.read",
  "samurai.artifact.list": "artifact.list",
  "samurai.artifact.read": "artifact.read",
  "samurai.collection.list": "collection.list",
  "samurai.collection.read": "collection.read",
  "samurai.activity.list": "activity.list",
  "samurai.activity.read": "activity.read"
};

export class McpProtocolServer {
  private readonly sessions = new Map<string, McpSession>();
  private readonly inFlight = new Map<string, AbortController>();
  private readonly protocolVersion: string;
  private readonly mutationTools: McpMutationToolDefinition[];
  private readonly sessionTtlMs: number;
  private readonly maxSessions: number;
  private readonly toolTimeoutMs: number;

  constructor(private readonly options: McpProtocolServerOptions) {
    this.protocolVersion = options.protocolVersion ?? mcpProtocolVersion;
    this.mutationTools = (options.mutationTools ?? []).map((definition) => ({
      ...definition,
      outputSchema: { anyOf: [definition.outputSchema, approvalOutputSchema] },
      inputSchema: objectSchema({
        ...targetProperties,
        idempotency_key: { type: "string", minLength: 1 },
        expected_versions: { type: "object", additionalProperties: { type: "integer", minimum: 1 } },
        input: definition.inputSchema
      }, ["idempotency_key", "expected_versions", "input"])
    }));
    this.sessionTtlMs = Math.max(30_000, options.sessionTtlMs ?? 15 * 60 * 1_000);
    this.maxSessions = Math.max(1, options.maxSessions ?? 100);
    this.toolTimeoutMs = Number.isFinite(options.toolTimeoutMs) ? Math.max(1, Math.floor(options.toolTimeoutMs as number)) : 30_000;
  }

  protocolVersionValue(): string {
    return this.protocolVersion;
  }

  /** Explicit Adapter/Hook entrypoint.  It shares OAuth, Project→Room
   * resolution, connector capability checks, and the Capture service rather
   * than accepting client-supplied Account or Room identifiers. */
  async ingestCaptureHook(authorizationHeader: string | undefined, input: ExternalCaptureHookInput): Promise<Record<string, unknown>> {
    if (!this.options.capture) throw new ExternalIntegrationError("mcp_method_not_found", "capture_not_configured");
    if (input.signal?.aborted) throw new ExternalIntegrationError("mcp_cancelled", "mcp_request_cancelled", true);
    if ((input.text === undefined) === (input.payload === undefined)) {
      throw new ExternalIntegrationError("mcp_invalid_arguments", "capture_requires_exactly_one_of_text_or_payload");
    }
    const token = bearerToken(authorizationHeader);
    const auth = await this.options.auth.authenticateAccessToken(token, resourceAuthenticationInput(this.options));
    if (!auth.scopes.includes("activity.ingest")) throw new ExternalIntegrationError("oauth_scope_invalid", "capture_hook_scope_missing");
    let writeStarted = false;
    const control = input.signal ? {
      signal: input.signal,
      markWriteStarted: () => { writeStarted = true; }
    } : undefined;
    try {
      const target = await this.options.workspace.resolveTarget(auth, {
        workspaceId: authWorkspaceId(auth),
        projectRef: requiredHookString(input.projectRef, "project_ref"),
        externalSessionId: requiredHookString(input.externalSessionId, "external_session_id")
      }, control);
      if (input.signal?.aborted) throw new ExternalIntegrationError("mcp_cancelled", "mcp_request_cancelled", true);
      await this.options.workspace.assertTargetCurrent?.(target);
      if (input.signal?.aborted) throw new ExternalIntegrationError("mcp_cancelled", "mcp_request_cancelled", true);
      const capabilities = await this.options.workspace.getCapabilities(target);
      if (input.signal?.aborted) throw new ExternalIntegrationError("mcp_cancelled", "mcp_request_cancelled", true);
      const manifest = objectValue(capabilities.manifest);
      const fullCapture = manifest.full_capture === "supported" || manifest.full_capture === "partial"
        ? manifest.full_capture
        : "unsupported";
      const recordId = `raw_hook_${hashHookIdentity(target, input).slice(0, 48)}`;
      const saved = await this.options.capture.save({
        workspaceId: target.workspaceId,
        connectionId: target.connectionId,
        accountId: target.accountId,
        projectRef: target.projectRef,
        externalSessionId: target.externalSessionId,
        roomId: target.roomId,
        kind: input.kind,
        recordId,
        ...(input.text === undefined ? { payload: input.payload } : { text: input.text }),
        connectorFullCapture: fullCapture,
        ...(input.signal ? { signal: input.signal } : {}),
        ...(control ? { markWriteStarted: control.markWriteStarted } : {})
      });
      if (input.signal?.aborted && saved.availability !== "disabled" && saved.availability !== "unsupported") {
        throw new ExternalIntegrationError("mcp_outcome_unknown", "capture_write_outcome_unknown", false);
      }
      return {
        availability: saved.availability,
        ...(saved.record ? { record_id: saved.record.id, kind: saved.record.kind, truncated: saved.record.truncated, delete_at: saved.record.delete_at } : {}),
        ...(saved.missingReason ? { missing_reason: saved.missingReason } : {})
      };
    } catch (error) {
      if (input.signal?.aborted && writeStarted) throw new ExternalIntegrationError("mcp_outcome_unknown", "capture_write_outcome_unknown", false);
      throw error;
    }
  }

  /** Explicit Adapter/Hook entrypoint for structured work evidence. The
   * connector and external session are verified against the OAuth grant;
   * callers never choose Account, Workspace, or Room. */
  async ingestActivityHook(authorizationHeader: string | undefined, input: ExternalActivityHookInput): Promise<Record<string, unknown>> {
    if (input.signal?.aborted) throw new ExternalIntegrationError("mcp_cancelled", "mcp_request_cancelled", true);
    const token = bearerToken(authorizationHeader);
    const auth = await this.options.auth.authenticateAccessToken(token, resourceAuthenticationInput(this.options));
    if (!auth.scopes.includes("activity.ingest")) throw new ExternalIntegrationError("oauth_scope_invalid", "activity_hook_scope_missing");
    const event = ConnectorEventInput(input.event);
    let writeStarted = false;
    const control = input.signal ? {
      signal: input.signal,
      markWriteStarted: () => { writeStarted = true; }
    } : undefined;
    try {
      const target = await this.options.workspace.resolveTarget(auth, {
        workspaceId: authWorkspaceId(auth),
        projectRef: requiredHookString(input.projectRef, "project_ref"),
        externalSessionId: requiredHookString(event.external_session_id, "external_session_id")
      }, control);
      if (input.signal?.aborted) throw new ExternalIntegrationError("mcp_cancelled", "mcp_request_cancelled", true);
      await this.options.workspace.assertTargetCurrent?.(target);
      if (input.signal?.aborted) throw new ExternalIntegrationError("mcp_cancelled", "mcp_request_cancelled", true);
      if (event.connector_id !== target.connectorId || event.app_id !== target.appId || event.external_session_id !== target.externalSessionId) {
        throw new ExternalIntegrationError("mcp_invalid_arguments", "activity_target_mismatch");
      }
      const result = await this.options.workspace.ingestActivity(target, event, control);
      if (input.signal?.aborted && writeStarted) throw new ExternalIntegrationError("mcp_outcome_unknown", "mcp_write_outcome_unknown_after_disconnect", false);
      return result;
    } catch (error) {
      if (input.signal?.aborted && writeStarted) throw new ExternalIntegrationError("mcp_outcome_unknown", "mcp_write_outcome_unknown_after_disconnect", false);
      throw error;
    }
  }

  validateTransport(transport: McpTransportContext): void {
    this.assertTransport(transport);
  }

  terminateSession(sessionId: string): void {
    for (const [requestKey, controller] of this.inFlight) {
      if (requestKey.startsWith(`${sessionId}:`)) controller.abort();
    }
    this.sessions.delete(sessionId);
  }

  async handle(request: JsonRpcRequest, authorizationHeader?: string, sessionId?: string, transport: McpTransportContext = {}, requestSignal?: AbortSignal): Promise<JsonRpcResponse | undefined> {
    if (request.jsonrpc !== "2.0" || typeof request.method !== "string") return rpcError(request.id ?? null, -32600, "invalid_request");
    if (request.method === "notifications/initialized") return undefined;
    try {
      this.assertTransport(transport);
      this.pruneSessions(Date.now());
      if (request.method === "initialize") return this.initialize(request, sessionId, transport);
      if (request.method === "ping") return rpcResult(request.id ?? null, {});
      if (request.method === "notifications/cancelled") {
        this.cancelRequest(sessionId, request.params);
        return undefined;
      }
      if (request.method.startsWith("notifications/")) return undefined;
      const session = this.requireSession(sessionId);
      if (request.method === "tools/list") return rpcResult(request.id ?? null, { tools: this.toolDefinitions() });
      if (request.method === "tools/call") {
        const token = bearerToken(authorizationHeader);
        let auth: ExternalIntegrationAuthContext;
        try {
          auth = await this.options.auth.authenticateAccessToken(token, resourceAuthenticationInput(this.options));
        } catch (error) {
          this.terminateSession(session.id);
          throw error;
        }
        if (session.accountId && (session.accountId !== auth.accountId || session.connectionId !== auth.connectionId)) {
          this.terminateSession(session.id);
          throw new ExternalIntegrationError("mcp_session_identity_changed");
        }
        session.accountId = auth.accountId;
        session.connectionId = auth.connectionId;
        session.lastSeenAt = Date.now();
        return rpcResult(request.id ?? null, await this.runTool(session, auth, request, requestSignal));
      }
      throw new ExternalIntegrationError("mcp_method_not_found");
    } catch (error) {
      return errorResponse(request.id ?? null, error);
    }
  }

  /** Called by the Samurai approval UI after the browser account approves a
   * fixed request. The request is rechecked against current versions before the
   * single formal mutation is admitted. */
  async executeApproved(approvalId: string, accountId: string, requestSignal?: AbortSignal): Promise<Record<string, unknown>> {
    if (requestSignal?.aborted) throw new ExternalIntegrationError("mcp_cancelled", "mcp_request_cancelled", true);
    let writeStarted = false;
    const control: McpRequestControl | undefined = requestSignal
      ? {
        signal: requestSignal,
        markWriteStarted: () => { writeStarted = true; }
      }
      : undefined;
    const request = await this.options.approval.status(approvalId);
    if (request.account_id !== accountId) throw new ExternalIntegrationError("approval_account_mismatch");
    const target = targetFromApproval(request.target, request.room_id, request.workspace_id, request.account_id);
    const assertTargetCurrent = request.operation === "room.binding.change"
      ? undefined
      : this.options.workspace.assertTargetCurrent;
    await assertTargetCurrent?.(target);
    throwIfAborted(control?.signal);
    const currentVersions = await this.options.workspace.getCurrentVersions(target, Object.keys(request.expected_versions), control);
    throwIfAborted(control?.signal);
    const input = JSON.parse(request.canonical_input) as Record<string, unknown>;
    try {
      const result = await this.options.approval.execute({
        approvalId,
        accountId,
        roomId: request.room_id,
        input,
        currentVersions,
        run: async () => {
          // The approval record may already have moved to `executing` when a
          // browser connection disappears. That is a durable state transition;
          // report the target mutation as unknown instead of reusing a normal
          // cancellation result or silently continuing with stale intent.
          if (requestSignal?.aborted) throw new ExternalIntegrationError("mcp_outcome_unknown", "approval_write_outcome_unknown_after_disconnect", false);
          await assertTargetCurrent?.(target);
          throwIfAborted(control?.signal);
          try {
            if (request.operation === "room.binding.change") {
              if (!this.options.workspace.changeBinding) throw new ExternalIntegrationError("mcp_method_not_found", "room_binding_change_unavailable");
              return await this.options.workspace.changeBinding(target, input, control);
            }
            return await this.options.workspace.mutate(target, request.operation, input, request.idempotency_key, request.expected_versions, control);
          } catch (error) {
            // A lower layer may observe the same disconnect after it has
            // crossed its own write boundary. ApprovalService otherwise sees
            // a normal cancellation and records `failed`, which would invite
            // an unsafe blind retry. Preserve the unknown-outcome contract.
            if (writeStarted && (requestSignal?.aborted || isCancellationError(error))) {
              throw new ExternalIntegrationError("mcp_outcome_unknown", "approval_write_outcome_unknown_after_disconnect", false);
            }
            throw error;
          }
        }
      });
      if (requestSignal?.aborted) throw new ExternalIntegrationError("mcp_outcome_unknown", "approval_write_outcome_unknown_after_disconnect", false);
      return result;
    } catch (error) {
      if (writeStarted && (requestSignal?.aborted || isCancellationError(error))) {
        throw new ExternalIntegrationError("mcp_outcome_unknown", "approval_write_outcome_unknown_after_disconnect", false);
      }
      throw error;
    }
  }

  private initialize(request: JsonRpcRequest, forcedSessionId?: string, transport: McpTransportContext = {}): JsonRpcResponse {
    const requestedProtocol = stringValue(request.params?.protocolVersion);
    if (requestedProtocol && requestedProtocol !== this.protocolVersion) throw new ExternalIntegrationError("mcp_protocol_version_unsupported");
    const params = request.params ?? {};
    const clientInfo = objectValue(params.clientInfo);
    const id = forcedSessionId ?? `mcp_${randomId()}`;
    const capabilities = objectValue(params.capabilities);
    const elicitation = objectValue(capabilities.elicitation);
    const now = Date.now();
    this.pruneSessions(now);
    if (!this.sessions.has(id) && this.sessions.size >= this.maxSessions) throw new ExternalIntegrationError("mcp_session_limit");
    this.sessions.set(id, {
      id,
      initialized: true,
      clientName: stringValue(clientInfo.name) ?? "unknown",
      clientVersion: stringValue(clientInfo.version) ?? "unknown",
      urlElicitation: elicitation.url === true,
      createdAt: now,
      lastSeenAt: now,
      ...(transport.projectRef ? { projectRef: transport.projectRef } : {}),
      externalSessionId: transport.externalSessionId ?? `external_mcp_${randomId()}`
    });
    return rpcResult(request.id ?? null, {
      protocolVersion: this.protocolVersion,
      capabilities: { tools: {}, elicitation: { url: true } },
      serverInfo: { name: this.options.serverName ?? "Samurai", version: this.options.serverVersion ?? "0.1.0" },
      instructions: "Use samurai.context.snapshot at session start. This session keeps the Project-to-Room Binding from its installed configuration; Room and permission are checked on every tool call. Detailed content must be read through scoped tools."
    });
  }

  private cancelRequest(sessionId: string | undefined, params: Record<string, unknown> | undefined): void {
    if (!sessionId) return;
    const requestId = params && (typeof params.requestId === "string" || typeof params.requestId === "number")
      ? params.requestId
      : undefined;
    if (requestId === undefined) return;
    this.inFlight.get(`${sessionId}:${String(requestId)}`)?.abort();
  }

  private async runTool(session: McpSession, auth: ExternalIntegrationAuthContext, request: JsonRpcRequest, requestSignal?: AbortSignal): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const relayAbort = () => controller.abort();
    if (requestSignal) {
      if (requestSignal.aborted) controller.abort();
      else requestSignal.addEventListener("abort", relayAbort, { once: true });
    }
    const requestKey = request.id === undefined || request.id === null ? undefined : `${session.id}:${String(request.id)}`;
    if (requestKey) this.inFlight.set(requestKey, controller);
    let timedOut = false;
    let writeStarted = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelListener: (() => void) | undefined;
    try {
      const control: McpRequestControl = {
        signal: controller.signal,
        markWriteStarted: () => { writeStarted = true; }
      };
      const tool = this.callTool(session, auth, request.params ?? {}, control);
      const cancelled = new Promise<Record<string, unknown>>((_resolve, reject) => {
        const onAbort = () => {
          if (writeStarted) {
            reject(new ExternalIntegrationError("mcp_outcome_unknown", "mcp_write_outcome_unknown_after_disconnect", false));
          } else if (!timedOut) {
            reject(new ExternalIntegrationError("mcp_cancelled", "mcp_request_cancelled", true));
          }
        };
        cancelListener = onAbort;
        if (controller.signal.aborted) onAbort();
        else controller.signal.addEventListener("abort", onAbort, { once: true });
      });
      const timeout = new Promise<Record<string, unknown>>((_resolve, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
          reject(writeStarted
            ? new ExternalIntegrationError("mcp_outcome_unknown", "mcp_write_outcome_unknown_after_timeout", false)
            : new ExternalIntegrationError("mcp_timeout", "mcp_tool_timeout", true));
        }, this.toolTimeoutMs);
      });
      return await Promise.race([tool, cancelled, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
      requestSignal?.removeEventListener("abort", relayAbort);
      // The cancellation Promise is intentionally raced against the formal
      // operation. Remove its listener once the race has settled so long-
      // lived MCP sessions do not retain completed requests.
      if (cancelListener) controller.signal.removeEventListener("abort", cancelListener);
      if (requestKey) this.inFlight.delete(requestKey);
    }
  }

  private async callTool(session: McpSession, auth: ExternalIntegrationAuthContext, params: Record<string, unknown>, control: McpRequestControl): Promise<Record<string, unknown>> {
    throwIfAborted(control.signal);
    const name = stringValue(params.name);
    const definitions = this.toolDefinitions();
    if (!name || !definitions.some((candidate) => candidate.name === name)) throw new ExternalIntegrationError("mcp_tool_not_found");
    const args = objectValue(params.arguments);
    const definition = definitions.find((candidate) => candidate.name === name);
    validateArguments(args, definition?.inputSchema);
    if (!definition || definition.scopes.some((scope) => !auth.scopes.includes(scope as never))) {
      throw new ExternalIntegrationError("oauth_scope_invalid", "mcp_scope_missing");
    }
    const workspaceId = authWorkspaceId(auth);
    if (name === "samurai.approval.status") {
      const approvalId = requiredString(args, "approval_id");
      const request = await this.options.approval.status(approvalId);
      if (request.account_id !== auth.accountId || request.workspace_id !== workspaceId) throw new ExternalIntegrationError("approval_account_mismatch");
      return structured(request, definition.outputSchema);
    }
    if (name === "samurai.capabilities") {
      const target = await this.resolveTarget(session, auth, args, control);
      return structured(await this.options.workspace.getCapabilities(target), definition.outputSchema);
    }
    if (name === "samurai.room.binding.get") {
      const projectRef = this.projectRef(session, args);
      const binding = await this.options.workspace.getBinding({ auth, workspaceId, projectRef }, control);
      if (!binding) throw new ExternalIntegrationError("room_binding_required");
      return structured(binding, definition.outputSchema);
    }
    if (name === "samurai.context.snapshot") {
      const target = await this.resolveTarget(session, auth, args, control);
      return structured(await this.options.workspace.getContextSnapshot(target, control), definition.outputSchema);
    }
    if (name === "samurai.room.binding.change") {
      const projectRef = this.projectRef(session, args);
      const roomId = requiredString(args, "room_id");
      const externalSessionId = this.externalSessionId(session, args);
      const currentBinding = await this.options.workspace.getBinding({ auth, workspaceId, projectRef });
      const currentBindingVersion = Number(currentBinding?.binding_version ?? 1);
      const expectedBindingVersion = typeof args.expected_binding_version === "number"
        ? args.expected_binding_version
        : currentBindingVersion;
      if (expectedBindingVersion !== currentBindingVersion) throw new ExternalIntegrationError("room_binding_version_conflict");
      const currentVersions = await this.options.workspace.getCurrentVersions(
        currentBinding ? { ...currentBinding, workspaceId, roomId: stringValue(currentBinding.room_id) ?? roomId, projectRef, accountId: auth.accountId, connectionId: auth.connectionId, connectorId: auth.connectorId, appId: auth.appId, bindingVersion: currentBindingVersion, externalSessionId } as ExternalWorkspaceTarget : fallbackTarget(auth, workspaceId, projectRef, roomId, externalSessionId),
        ["room_binding"],
        control
      );
      throwIfAborted(control.signal);
      control.markWriteStarted();
      const prepared = await this.options.approval.prepare({
        workspaceId,
        operation: "room.binding.change",
        target: { workspace_id: workspaceId, connection_id: auth.connectionId, connector_id: auth.connectorId, app_id: auth.appId, account_id: auth.accountId, project_ref: projectRef, room_id: roomId, binding_version: currentBindingVersion, external_session_id: externalSessionId },
        input: { project_ref: projectRef, room_id: roomId, expected_binding_version: expectedBindingVersion, expected_binding_present: Boolean(currentBinding) },
        accountId: auth.accountId,
        roomId,
        expectedVersions: currentVersions,
        idempotencyKey: idempotencyKey(args)
      });
      return approvalResult(prepared, session.urlElicitation, definition.outputSchema);
    }
    const target = await this.resolveTarget(session, auth, args, control);
    const queryOperation = queryToolOperations[name];
    if (queryOperation) return structured(await this.options.workspace.query(target, queryOperation, args, control), definition.outputSchema);
    if (name === "samurai.activity.ingest") {
      const event = ConnectorEventInput(args.event);
      if (event.connector_id !== auth.connectorId) throw new ExternalIntegrationError("mcp_invalid_arguments", "connector_identity_mismatch");
      return structured(await this.options.workspace.ingestActivity(target, event, control), definition.outputSchema);
    }
    const mutation = this.mutationTools.find((candidate) => candidate.name === name);
    if (mutation) {
      const operation = mutation.operation;
      const input = objectValue(args.input);
      const expectedVersions = numberMap(args.expected_versions);
      const key = idempotencyKey(args);
      if (approvalRequired(operation)) {
        if (!auth.scopes.includes("approval.execute")) throw new ExternalIntegrationError("oauth_scope_invalid", "approval_scope_missing");
        if (Object.keys(expectedVersions).length === 0) throw new ExternalIntegrationError("mcp_invalid_arguments", "expected_versions_required_for_approval");
        const currentVersions = await this.options.workspace.getCurrentVersions(target, Object.keys(expectedVersions), control);
        throwIfAborted(control.signal);
        control.markWriteStarted();
        const prepared = await this.options.approval.prepare({
          workspaceId,
          operation,
          target: { workspace_id: workspaceId, connection_id: target.connectionId, connector_id: target.connectorId, app_id: target.appId, account_id: target.accountId, room_id: target.roomId, project_ref: target.projectRef, external_session_id: target.externalSessionId },
          input,
          accountId: auth.accountId,
          roomId: target.roomId,
          expectedVersions: Object.keys(expectedVersions).length > 0 ? expectedVersions : currentVersions,
          idempotencyKey: key
        });
        return approvalResult(prepared, session.urlElicitation, approvalOutputSchema);
      }
      return structured(await this.options.workspace.mutate(target, operation, input, key, expectedVersions, control), mutation.outputSchema);
    }
    throw new ExternalIntegrationError("mcp_method_not_found");
  }

  private async resolveTarget(session: McpSession, auth: ExternalIntegrationAuthContext, args: Record<string, unknown>, control: McpRequestControl): Promise<ExternalWorkspaceTarget> {
    return this.options.workspace.resolveTarget(auth, {
      workspaceId: authWorkspaceId(auth),
      projectRef: this.projectRef(session, args),
      externalSessionId: this.externalSessionId(session, args)
    }, control);
  }

  private projectRef(session: McpSession, args: Record<string, unknown>): string {
    const supplied = stringValue(args.project_ref);
    if (session.projectRef && supplied && session.projectRef !== supplied) {
      throw new ExternalIntegrationError("mcp_invalid_arguments", "project_ref_does_not_match_installed_configuration");
    }
    if (session.projectRef) return session.projectRef;
    if (!supplied) throw new ExternalIntegrationError("room_binding_required", "project_ref_missing_from_client_configuration");
    session.projectRef = supplied;
    return supplied;
  }

  private externalSessionId(session: McpSession, args: Record<string, unknown>): string {
    const supplied = stringValue(args.external_session_id);
    if (session.externalSessionId && supplied && session.externalSessionId !== supplied) {
      throw new ExternalIntegrationError("mcp_invalid_arguments", "external_session_id_does_not_match_mcp_session");
    }
    if (session.externalSessionId) return session.externalSessionId;
    session.externalSessionId = supplied ?? `external_mcp_${randomId()}`;
    return session.externalSessionId;
  }

  private requireSession(id: string | undefined): McpSession {
    if (!id) throw new ExternalIntegrationError("mcp_session_required");
    const session = this.sessions.get(id);
    if (!session) throw new ExternalIntegrationError("mcp_session_required");
    if (session.lastSeenAt + this.sessionTtlMs <= Date.now()) {
      this.terminateSession(id);
      throw new ExternalIntegrationError("mcp_session_expired");
    }
    session.lastSeenAt = Date.now();
    return session;
  }

  private toolDefinitions(): McpToolDefinition[] {
    return [...tools, ...this.mutationTools];
  }

  private assertTransport(transport: McpTransportContext): void {
    if (transport.protocolVersion && transport.protocolVersion !== this.protocolVersion) {
      throw new ExternalIntegrationError("mcp_protocol_version_unsupported");
    }
    if (!transport.origin) return;
    const allowed = this.options.allowedOrigins;
    if (allowed) {
      if (allowed.includes(transport.origin)) return;
      // Local Clients use an ephemeral loopback port. The server composition
      // deliberately lists loopback markers without a port, so accept only
      // another loopback Origin—not an arbitrary remote Origin—here.
      if (isLoopbackOrigin(transport.origin) && allowed.some(isLoopbackOrigin)) return;
      throw new ExternalIntegrationError("mcp_origin_invalid");
    }
    if (!isLoopbackOrigin(transport.origin)) throw new ExternalIntegrationError("mcp_origin_invalid");
  }

  private pruneSessions(now: number): void {
    for (const [id, session] of this.sessions) {
      if (session.lastSeenAt + this.sessionTtlMs <= now) this.terminateSession(id);
    }
    while (this.sessions.size > this.maxSessions) {
      const oldest = [...this.sessions.values()].sort((left, right) => left.lastSeenAt - right.lastSeenAt)[0];
      if (!oldest) break;
      this.terminateSession(oldest.id);
    }
  }
}

interface McpToolDefinition {
  name: string;
  description: string;
  scopes: string[];
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
}

function tool(name: string, description: string, scopes: string[], inputSchema: Record<string, unknown>, outputSchema: Record<string, unknown>): McpToolDefinition {
  return {
    name,
    description,
    scopes,
    inputSchema,
    outputSchema
  };
}

function objectSchema(properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return { type: "object", properties, required, additionalProperties: false };
}

function validateArguments(value: Record<string, unknown>, schema: Record<string, unknown> | undefined): void {
  if (!schema) throw new ExternalIntegrationError("mcp_tool_not_found");
  validateSchemaValue(value, schema, "arguments", "mcp_invalid_arguments");
}

const jsonSchemaValidator = new Ajv({
  allErrors: true,
  allowUnionTypes: true,
  strict: false,
  validateFormats: false
});
const compiledJsonSchemas = new WeakMap<object, ValidateFunction>();

/** The domain Catalog may use the complete JSON Schema subset it publishes.
 * Ajv replaces the former handwritten partial validator so object/array,
 * enum, nullable, pattern, numeric bounds, strict properties, and nested
 * anyOf/oneOf contracts are all checked identically. */
export function validateMcpSchema(value: unknown, schema: Record<string, unknown>, path = "value"): void {
  validateSchemaValue(value, schema, path, "mcp_invalid_arguments");
}

function validateSchemaValue(
  value: unknown,
  schema: Record<string, unknown>,
  path: string,
  code: "mcp_invalid_arguments" | "mcp_invalid_result"
): void {
  let validator = compiledJsonSchemas.get(schema);
  try {
    if (!validator) {
      validator = jsonSchemaValidator.compile(schema);
      compiledJsonSchemas.set(schema, validator);
    }
  } catch {
    throw new ExternalIntegrationError(code, `${path}_schema_invalid`);
  }
  if (validator(value)) return;
  const issue = validator.errors?.[0];
  const location = issue?.instancePath ? `${path}${issue.instancePath}` : path;
  throw new ExternalIntegrationError(code, `${location}_${issue?.keyword ?? "schema"}_invalid`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isLoopbackOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return (url.protocol === "http:" || url.protocol === "https:") && (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]");
  } catch {
    return false;
  }
}

function structured(value: unknown, outputSchema: Record<string, unknown>): Record<string, unknown> {
  validateSchemaValue(value, outputSchema, "result", "mcp_invalid_result");
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value as Record<string, unknown>,
    isError: false
  };
}

function approvalResult(prepared: { request: unknown; approvalUrl: string }, urlElicitation: boolean, outputSchema: Record<string, unknown>): Record<string, unknown> {
  const structuredContent = {
    approval_required: true,
    approval_id: (prepared.request as { id: string }).id,
    approval_url: prepared.approvalUrl,
    elicitation: urlElicitation ? { mode: "url", url: prepared.approvalUrl } : { mode: "fallback_link", url: prepared.approvalUrl }
  };
  validateSchemaValue(structuredContent, outputSchema, "result", "mcp_invalid_result");
  return {
    content: [{ type: "text", text: `Samurai approval required: ${prepared.approvalUrl}` }],
    structuredContent,
    isError: false
  };
}

function rpcResult(id: string | number | null, result: Record<string, unknown>): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id: string | number | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function errorResponse(id: string | number | null, error: unknown): JsonRpcResponse {
  const normalized = normalizeExternalIntegrationError(error);
  if (normalized) {
    return { jsonrpc: "2.0", id, error: { code: -32000, message: normalized.code, data: { retryable: normalized.retryable, status: normalized.status } } };
  }
  return { jsonrpc: "2.0", id, error: { code: -32603, message: "internal_error" } };
}

function bearerToken(header: string | undefined): string {
  const match = /^Bearer\s+(.+)$/i.exec(header ?? "");
  if (!match) throw new ExternalIntegrationError("mcp_auth_required");
  return match[1] as string;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function requiredString(value: unknown, key: string): string {
  const candidate = value && typeof value === "object" && !Array.isArray(value) && key in (value as Record<string, unknown>)
    ? (value as Record<string, unknown>)[key]
    : value;
  const result = stringValue(candidate);
  if (!result) throw new ExternalIntegrationError("mcp_invalid_arguments", `${key}_required`);
  return result;
}

function numberMap(value: unknown): Record<string, number> {
  const record = objectValue(value);
  const result: Record<string, number> = {};
  for (const [key, item] of Object.entries(record)) {
    if (typeof item !== "number" || !Number.isInteger(item) || item <= 0) throw new ExternalIntegrationError("mcp_invalid_arguments", "expected_versions_invalid");
    result[key] = item;
  }
  return result;
}

function idempotencyKey(args: Record<string, unknown>): string {
  return requiredString(args, "idempotency_key");
}

function ConnectorEventInput(value: unknown): ConnectorEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ExternalIntegrationError("mcp_invalid_arguments", "activity_event_invalid");
  }
  const parsed = ConnectorEventSchema.safeParse(value);
  if (!parsed.success) throw new ExternalIntegrationError("mcp_invalid_arguments", "activity_event_invalid");
  return redactConnectorEvent(parsed.data);
}

function authWorkspaceId(auth: ExternalIntegrationAuthContext & { workspaceId?: string }): string {
  if (!auth.workspaceId) throw new ExternalIntegrationError("mcp_auth_required", "workspace_not_bound_to_grant");
  return auth.workspaceId;
}

function resourceAuthenticationInput(options: McpProtocolServerOptions): { resourceUrl?: string } {
  return options.protectedResourceUrl ? { resourceUrl: options.protectedResourceUrl } : {};
}

function requiredHookString(value: string, key: string): string {
  if (!value || !value.trim()) throw new ExternalIntegrationError("mcp_invalid_arguments", `${key}_required`);
  return value;
}

function hashHookIdentity(target: ExternalWorkspaceTarget, input: ExternalCaptureHookInput): string {
  return hashCanonicalJson({
    workspace_id: target.workspaceId,
    connection_id: target.connectionId,
    account_id: target.accountId,
    project_ref: target.projectRef,
    connector_id: target.connectorId,
    external_session_id: target.externalSessionId,
    room_id: target.roomId,
    event_id: input.eventId,
    kind: input.kind
  });
}

function fallbackTarget(auth: ExternalIntegrationAuthContext, workspaceId: string, projectRef: string, roomId: string, externalSessionId: string): ExternalWorkspaceTarget {
  return { workspaceId, roomId, projectRef, accountId: auth.accountId, connectionId: auth.connectionId, connectorId: auth.connectorId, appId: auth.appId, bindingVersion: 1, externalSessionId };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ExternalIntegrationError("mcp_cancelled", "mcp_request_cancelled", true);
}

function isCancellationError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { code?: unknown; message?: unknown };
  return value.code === "mcp_cancelled"
    || value.code === "backend_cancelled"
    || (typeof value.message === "string" && /cancel|abort|deadline/i.test(value.message));
}

function targetFromApproval(target: Record<string, unknown>, roomId: string, workspaceId: string, accountId: string): ExternalWorkspaceTarget {
  const projectRef = stringValue(target.project_ref) ?? "approval-project";
  return {
    workspaceId,
    roomId,
    projectRef,
    accountId,
    connectionId: requiredString(target.connection_id, "connection_id"),
    connectorId: requiredString(target.connector_id, "connector_id"),
    appId: requiredString(target.app_id, "app_id"),
    bindingVersion: typeof target.binding_version === "number" && target.binding_version > 0 ? target.binding_version : 1,
    externalSessionId: stringValue(target.external_session_id) ?? `approval:${projectRef}`
  };
}

function randomId(): string {
  return randomBytes(24).toString("base64url");
}
