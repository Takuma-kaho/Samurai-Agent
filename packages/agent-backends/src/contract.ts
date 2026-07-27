import {
  BackendEventPayloadSchemas,
  BackendEventTypeSchema,
  BackendTerminalEvidenceSchema,
  ResourceRefSchema,
  type AgentBackendKind,
  type BackendCapabilityId,
  type BackendCapabilityStatus,
  type BackendEventType,
  type BackendExecutionOwner,
  type BackendSessionPolicy,
  type BackendTerminalEvidence as CoreBackendTerminalEvidence,
  type ContextHandoff,
  type ExternalAssistContext,
  type FreezeSnapshot,
  type GatewayBoundaryRuntimeSnapshot,
  type HostContextAssembly,
  type JsonValue,
  type MessageEnvelope,
  type MessageRecord,
  type ResourceRef,
  type SupportedLocale
} from "@samurai-agent/core-schemas";
import { z } from "zod";

export type BackendEventPayloadByType = import("@samurai-agent/core-schemas").BackendEventPayloadByType;

export type BackendOutputEvent = {
  [T in Exclude<BackendEventType, "tool_call_started" | "tool_call_output">]: BackendOutputEventBase<T>
}[Exclude<BackendEventType, "tool_call_started" | "tool_call_output">]
  | (BackendOutputEventBase<"tool_call_started"> & { tool_call_id: string })
  | (BackendOutputEventBase<"tool_call_output"> & { tool_call_id: string });
export type BackendToolCallStartedEvent = Extract<BackendOutputEvent, { event_type: "tool_call_started" }>;
export type BackendToolCallOutputEvent = Extract<BackendOutputEvent, { event_type: "tool_call_output" }>;

type BackendOutputEventBase<T extends BackendEventType> = {
  event_type: T;
  payload: BackendEventPayloadByType[T];
  tool_call_id?: string;
  backend_session_id?: string;
  resource_refs?: ResourceRef[];
  source_event_id?: string;
  source_sequence?: number;
  terminal_evidence?: CoreBackendTerminalEvidence;
};

const backendOutputBase = z.object({
  event_type: BackendEventTypeSchema,
  payload: z.unknown(),
  tool_call_id: z.string().min(1).optional(),
  backend_session_id: z.string().min(1).optional(),
  resource_refs: z.array(ResourceRefSchema).optional(),
  source_event_id: z.string().min(1).optional(),
  source_sequence: z.number().int().positive().optional(),
  terminal_evidence: BackendTerminalEvidenceSchema.optional()
}).strict();

function backendOutputVariant<T extends BackendEventType>(eventType: T, extra: z.ZodRawShape = {}) {
  return backendOutputBase.extend({
    event_type: z.literal(eventType),
    payload: BackendEventPayloadSchemas[eventType],
    ...extra
  });
}

type BackendOutputVariant = z.ZodDiscriminatedUnionOption<"event_type">;
const backendOutputVariants = [
  backendOutputVariant("run_started"),
  backendOutputVariant("agent_reasoning"),
  backendOutputVariant("host_progress"),
  backendOutputVariant("text_delta"),
  backendOutputVariant("tool_call_started", { tool_call_id: z.string().min(1) }),
  backendOutputVariant("tool_call_output", { tool_call_id: z.string().min(1) }),
  backendOutputVariant("artifact_created"),
  backendOutputVariant("workspace_change_suggested"),
  backendOutputVariant("memory_suggested"),
  backendOutputVariant("skill_candidate_created"),
  backendOutputVariant("backend_waiting_for_native_input"),
  backendOutputVariant("backend_native_input_submitted"),
  backendOutputVariant("backend_stream_synced"),
  backendOutputVariant("backend_stream_unavailable"),
  backendOutputVariant("host_post_turn_failed"),
  backendOutputVariant("host_cleanup_failed"),
  backendOutputVariant("host_emit_failed"),
  backendOutputVariant("backend_protocol_diagnostic"),
  backendOutputVariant("run_completed"),
  backendOutputVariant("run_failed")
] as const satisfies readonly [BackendOutputVariant, ...BackendOutputVariant[]];

/** Strict adapter boundary. Legacy history compatibility belongs to Store reads. */
export const BackendOutputEventSchema = z.discriminatedUnion("event_type", backendOutputVariants);

export interface MemoryCandidateLike {
  id?: string;
  topic?: string;
  content: string;
  state?: "active" | "topic" | "sensitive";
  sensitive_level?: "none" | "low" | "high";
  priority?: "primary" | "sensitive" | "conflict";
  selection_reason?: string;
  conflicts_with?: string[];
}

export interface TemporaryContextAttachment {
  id: string;
  kind: "desktop_screenshot";
  label?: string;
  source_name?: string;
  mime_type: string;
  data_url?: string;
  file_path?: string;
  created_at: string;
  expires_at: string;
  metadata?: Record<string, JsonValue>;
}

export interface SessionSummaryLike {
  session_key: string;
  title: string;
  ui_locale: SupportedLocale;
  output_locale: SupportedLocale;
  message_count: number;
  operation_count: number;
  backend_run_count: number;
  tool_run_count: number;
  workspace_change_count: number;
  last_message_at?: string;
  last_backend_run_id?: string;
  last_backend_run_status?: string;
}

export interface BackendToolBridgeToolDescriptor {
  name: string;
  provider_tool_name: string;
  title: string;
  description: string;
  input_schema: Record<string, JsonValue>;
}

export interface BackendToolBridge {
  enabled: boolean;
  server_name: string;
  endpoint_url: string;
  token?: string;
  token_env: string;
  tools: BackendToolBridgeToolDescriptor[];
}

export interface BackendRunInput {
  run_id: string;
  session_id: string;
  backend_session_id?: string;
  input_message_id: string;
  workspace_root?: string;
  working_directory?: string;
  envelope: MessageEnvelope;
  user_input: string;
  input_locale: SupportedLocale;
  output_locale: SupportedLocale;
  active_memory: MemoryCandidateLike[];
  freeze_snapshot?: FreezeSnapshot;
  gateway_boundary?: GatewayBoundaryRuntimeSnapshot;
  knowledge_wiki?: Array<{
    id: string;
    slug: string;
    title: string;
    content: string;
    source_refs: ResourceRef[];
  }>;
  collection_notes?: Array<{
    collection_id: string;
    file_path: string;
    content: string;
    role: "context_only";
  }>;
  selected_skills?: Array<{
    id: string;
    title: string;
    description: string;
    tags: string[];
    required_capabilities: string[];
    disclosure_level?: "catalog" | "body" | "support";
    selection_reason?: string;
    usage?: {
      use_count: number;
      last_used_at?: string;
    };
    content?: string;
    support_file_refs?: Array<{ path: string }>;
    support_files?: Array<{ path: string; content: string }>;
  }>;
  session_search?: Array<{
    kind: string;
    id: string;
    title: string;
    summary: string;
  }>;
  session_summary?: SessionSummaryLike;
  external_assist?: ExternalAssistContext;
  available_tools?: string[];
  context_assembly?: HostContextAssembly;
  context_handoff?: ContextHandoff;
  recent_messages: MessageRecord[];
  temporary_context?: TemporaryContextAttachment[];
  metadata: Record<string, JsonValue>;
  context_intent?: "light_chat" | "contextual_chat" | "workspace_task";
  expected_outputs?: Array<"artifact" | "collection_schema" | "collection_view" | "generated_surface">;
  tool_bridge?: BackendToolBridge;
  abort_signal?: AbortSignal;
}

export interface BackendSessionInput {
  session_id: string;
  session_key: string;
  output_locale: import("@samurai-agent/core-schemas").SupportedLocale;
  metadata: Record<string, JsonValue>;
}

export interface BackendSessionHandle {
  backend_session_id: string;
  metadata: Record<string, JsonValue>;
  started_at: string;
}

export interface AgentBackend {
  readonly id: string;
  readonly kind: AgentBackendKind;
  readonly label: string;
  readonly sessionPolicy: BackendSessionPolicy;
  readonly execution_owner: BackendExecutionOwner;
  getStatus?(): AgentBackendStatus;
  recordLiveVerification?(input: BackendLiveVerification): void;
  startSession?(input: BackendSessionInput): Promise<BackendSessionHandle>;
  runTurn(input: BackendRunInput): AsyncIterable<BackendOutputEvent>;
  resumeRun?(runId: string, input: Record<string, JsonValue>): AsyncIterable<BackendOutputEvent>;
  cancelRun?(runId: string): Promise<BackendCancelResult>;
  streamEvents?(runId: string): AsyncIterable<BackendOutputEvent>;
}

export type BackendRuntimeFailure = import("@samurai-agent/core-schemas").BackendRuntimeFailure;
export type RuntimeFailureCauseCategory = BackendRuntimeFailure["causeCategory"];
export type BackendTerminalEvidence = CoreBackendTerminalEvidence;
export type BackendIndeterminateEvidence = Extract<CoreBackendTerminalEvidence, { kind: "indeterminate" }>;
export type BackendSettledEvidence = Exclude<CoreBackendTerminalEvidence, BackendIndeterminateEvidence>;
export type BackendCancelResult =
  | { kind: "settled"; evidence: BackendSettledEvidence }
  | { kind: "requested" }
  | { kind: "unsupported" };

export interface AgentBackendStatus {
  id: string;
  kind: AgentBackendKind;
  label: string;
  configured: boolean;
  enabled: boolean;
  connection_state: "ready" | "unconfigured" | "disabled" | "degraded" | "unverified";
  session_policy: BackendSessionPolicy;
  execution_owner: BackendExecutionOwner;
  supports: {
    start_session: boolean;
    resume_run: boolean;
    cancel_run: boolean;
    stream_events: boolean;
  };
  capabilities?: BackendCapabilityStatus[];
  reason?: string;
  active_run_count?: number;
  metadata?: Record<string, JsonValue>;
}

export interface ExternalCommandProbe {
  configured: boolean;
  command_name?: string;
  path_kind?: "path_lookup" | "direct_path";
  resolved: boolean;
  reason?: "command_not_configured" | "command_not_found" | "command_not_executable";
}

export interface BackendLiveVerification {
  version: string;
  verified_at: string;
  effective_args?: string[];
}

export const backendCapabilityIds: BackendCapabilityId[] = [
  "web_search",
  "web_fetch",
  "browser_read",
  "browser_interact",
  "browser_screenshot",
  "subagent_delegate",
  "mcp_tools"
];

export function unavailableCapabilities(backendId: string, reason: string): BackendCapabilityStatus[] {
  const checkedAt = new Date().toISOString();
  return backendCapabilityIds.map((capabilityId) => ({
    backend_id: backendId,
    capability_id: capabilityId,
    state: "unverified",
    source: "backend_native",
    reason,
    checked_at: checkedAt,
    probe_version: "static-v1",
    evidence_summary: "This capability has not been verified by backend diagnostics."
  }));
}

export class AgentBackendRegistry {
  private readonly backends = new Map<string, AgentBackend>();

  constructor(backends: AgentBackend[] = []) {
    for (const backend of backends) this.register(backend);
  }

  register(backend: AgentBackend): void {
    validateBackendContract(backend);
    this.backends.set(backend.id, backend);
  }

  get(id: string): AgentBackend | undefined {
    return this.backends.get(id);
  }

  require(id = "samurai-native"): AgentBackend {
    const backend = this.get(id);
    if (!backend) throw new Error(`Agent backend not registered: ${id}`);
    return backend;
  }

  list(): AgentBackend[] {
    return [...this.backends.values()];
  }

  statuses(): AgentBackendStatus[] {
    return this.list().map((backend) => normalizeBackendStatus(backend, backend.getStatus?.()));
  }

  status(id: string): AgentBackendStatus | undefined {
    const backend = this.get(id);
    return backend ? normalizeBackendStatus(backend, backend.getStatus?.()) : undefined;
  }

  recordRunOutcome(_backendId: string, _status: "completed" | "failed" | "cancelled" | "outcome_unknown"): void {}
}

function validateBackendContract(backend: AgentBackend): void {
  if (!backend.sessionPolicy || !backend.execution_owner) {
    throw new Error(`backend_contract_incomplete:${backend.id}`);
  }
  const status = backend.getStatus?.();
  if (status && (
    status.session_policy.acquisition !== backend.sessionPolicy.acquisition
    || status.session_policy.resume !== backend.sessionPolicy.resume
    || status.execution_owner !== backend.execution_owner
  )) {
    throw new Error(`backend_status_contract_mismatch:${backend.id}`);
  }
  if (backend.sessionPolicy.acquisition === "start_session" && typeof backend.startSession !== "function") {
    throw new Error(`backend_session_policy_mismatch:${backend.id}:start_session`);
  }
  if (backend.sessionPolicy.acquisition !== "start_session" && typeof backend.startSession === "function") {
    throw new Error(`backend_session_policy_mismatch:${backend.id}:unexpected_start_session`);
  }
  if (backend.sessionPolicy.resume === "native" && typeof backend.resumeRun !== "function") {
    throw new Error(`backend_session_policy_mismatch:${backend.id}:native_resume`);
  }
  if (backend.sessionPolicy.resume !== "native" && typeof backend.resumeRun === "function") {
    throw new Error(`backend_session_policy_mismatch:${backend.id}:unexpected_resume`);
  }
}

function normalizeBackendStatus(backend: AgentBackend, status?: AgentBackendStatus): AgentBackendStatus {
  const configured = status?.configured ?? true;
  const enabled = status?.enabled ?? configured;
  return {
    id: backend.id,
    kind: backend.kind,
    label: backend.label,
    configured,
    enabled,
    connection_state: status?.connection_state ?? (configured && enabled ? "ready" : configured ? "disabled" : "unconfigured"),
    session_policy: status?.session_policy ?? backend.sessionPolicy,
    execution_owner: status?.execution_owner ?? backend.execution_owner,
    supports: status?.supports ?? backendSupports(backend),
    capabilities: status?.capabilities ?? unavailableCapabilities(backend.id, "capability_probe_not_configured"),
    ...(status?.reason ? { reason: status.reason } : {}),
    ...(status?.active_run_count !== undefined ? { active_run_count: status.active_run_count } : {}),
    ...(status?.metadata ? { metadata: status.metadata } : {})
  };
}

export function backendSupports(backend: AgentBackend): AgentBackendStatus["supports"] {
  return {
    start_session: typeof backend.startSession === "function",
    resume_run: typeof backend.resumeRun === "function",
    cancel_run: typeof backend.cancelRun === "function",
    stream_events: typeof backend.streamEvents === "function"
  };
}
