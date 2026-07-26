import type { AgentBackend, BackendRunInput, TemporaryContextAttachment } from "@samurai-agent/agent-backends";
import type {
  AgentBackendKind,
  BackendEventRecord,
  BackendRunRecord,
  ContextHandoff,
  ContextPreview,
  GatewayBoundaryRuntimeSnapshot,
  GatewayBoundaryPolicy,
  HostContextAssembly,
  JsonValue,
  MessageEnvelope,
  MessageRecord,
  SessionRecord
} from "@samurai-agent/core-schemas";
import type { PreparedTerminalSettlement } from "../execution/run-lifecycle";
import type { BackendCancelResult, CanonicalLifecycleEvent } from "../execution/run-state-machine";

export interface TurnRequest {
  sessionId: string;
  content: string;
  envelope: MessageEnvelope;
  backendId?: string;
  idempotencyKey: string;
  metadata?: Record<string, JsonValue>;
  temporaryContext?: TemporaryContextAttachment[];
  gatewayBoundaryPolicy?: import("@samurai-agent/core-schemas").GatewayBoundaryPolicy;
}

export interface BackendBinding { readonly id: string; readonly kind: AgentBackendKind; readonly backend: AgentBackend; }
export interface BackendBoundTurn { readonly request: TurnRequest; readonly session: SessionRecord; readonly binding: BackendBinding; readonly requestHash: string; }
export interface SessionRunReservation { readonly sessionId: string; readonly runId: string; readonly version: number; readonly status: "held" | "released"; }
export interface AdmittedTurn extends BackendBoundTurn { readonly reservation: SessionRunReservation; readonly userMessage: MessageRecord; readonly run: BackendRunRecord; readonly replay?: boolean; }
export interface PreparedTurn extends AdmittedTurn {
  readonly context: HostContextAssembly;
  readonly handoff: ContextHandoff;
  readonly backendInput: BackendRunInput;
}

/** The only Context dependency accepted by the new Host preparation path. */
export interface TurnContextAssemblyResult {
  readonly context: HostContextAssembly;
  readonly availableTools?: readonly string[];
  readonly gatewayBoundary?: GatewayBoundaryRuntimeSnapshot;
}

export interface TurnBackendHandoffResult {
  readonly handoff: ContextHandoff;
  readonly backendInput: BackendRunInput;
}
export interface TurnOutput { readonly content: string; readonly events: BackendEventRecord[]; }
export interface SettlementDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly metadata?: Record<string, JsonValue>;
}
export interface TurnSettlementInput extends PreparedTerminalSettlement {
  readonly outputSourceId: string;
  readonly output?: MessageRecord;
  readonly diagnostic?: SettlementDiagnostic;
  readonly reservation: SessionRunReservation;
}
export type TurnOutcome =
  | { kind: "queued"; run: BackendRunRecord }
  | { kind: "completed"; run: BackendRunRecord; output: TurnOutput }
  | { kind: "waiting"; run: BackendRunRecord; waiting: { prompt: string } }
  | { kind: "cancelled"; run: BackendRunRecord; reason: string }
  | { kind: "failed"; run: BackendRunRecord; error: Error }
  | { kind: "outcome_unknown"; run: BackendRunRecord; error: Error };

export interface CommitTurnSettlementPort {
  commitTurnSettlement(input: TurnSettlementInput): Promise<BackendRunRecord>;
}

export interface HostStorePort extends CommitTurnSettlementPort {
  getSession(sessionId: string): Promise<SessionRecord | undefined>;
  admitTurn(input: { session: SessionRecord; binding: BackendBinding; request: TurnRequest; requestHash: string; runId: string; now: string }): Promise<{ reservation: SessionRunReservation; userMessage: MessageRecord; run: BackendRunRecord; replay: boolean }>;
  getBackendRun(runId: string): Promise<BackendRunRecord | undefined>;
  listBackendEvents(input: { runId: string }): Promise<BackendEventRecord[]>;
  listMessages(sessionId: string): Promise<MessageRecord[]>;
  commitCore02RunTransition(input: { expectedRun: BackendRunRecord; nextRun: BackendRunRecord }): Promise<BackendRunRecord>;
  commitCore02BackendSession(input: { expectedRun: BackendRunRecord; nextRun: BackendRunRecord }): Promise<BackendRunRecord>;
  commitCore02LifecycleEvent(input: { expectedRun: BackendRunRecord; nextRun: BackendRunRecord; event: BackendEventRecord }): Promise<{ run: BackendRunRecord; event: BackendEventRecord; duplicate: boolean }>;
  appendCore02Event(event: BackendEventRecord): Promise<{ event: BackendEventRecord; duplicate: boolean }>;
  getSessionRunReservation(input: { runId: string }): Promise<SessionRunReservation | undefined>;
  listCore02RecoveryCandidates(): Promise<BackendRunRecord[]>;
  appendHostDiagnostic(input: HostDiagnosticInput): Promise<void>;
}

export interface HostContextPort {
  getCandidates(input: { turn: AdmittedTurn; signal?: AbortSignal }): Promise<ContextPreview>;
  assemble(input: { turn: AdmittedTurn; candidates: ContextPreview; signal?: AbortSignal }): Promise<TurnContextAssemblyResult>;
  handoff(input: { turn: AdmittedTurn; candidates: ContextPreview; assembly: TurnContextAssemblyResult; signal?: AbortSignal }): Promise<TurnBackendHandoffResult>;
  reportProgress(input: { turn: AdmittedTurn; displayKind: "reasoning_summary" | "activity"; text: string; activityKind?: string }): Promise<void>;
}

export interface TurnPreflightPort {
  prepare(input: { request: TurnRequest; signal?: AbortSignal }): Promise<TurnRequest>;
}

export interface CommittedEventPublisherPort {
  publish(input: { event: BackendEventRecord; run: BackendRunRecord }): Promise<void>;
}

export interface AdmissionObserverPort {
  observe(input: AdmittedTurn): Promise<void>;
}

export interface TurnToolExecutionPort {
  execute(input: {
    run: BackendRunRecord;
    backendInput: BackendRunInput;
    event: { event_type: BackendEventRecord["event_type"]; tool_call_id: string; payload: Record<string, JsonValue> };
    gatewayBoundaryPolicy?: import("@samurai-agent/core-schemas").GatewayBoundaryPolicy;
    recordEvent: (event: { event_type: BackendEventRecord["event_type"]; payload: Record<string, JsonValue>; resource_refs?: BackendEventRecord["resource_refs"]; tool_call_id?: string }) => Promise<BackendEventRecord>;
  }): Promise<void>;
}

export interface RequiredCompletionPort {
  commitTurnSettlement(input: TurnSettlementInput & { admitted: AdmittedTurn; turnOutput: TurnOutput }): Promise<BackendRunRecord>;
}

export interface PostTurnOperation {
  readonly operationId: string;
  run(input: { admitted: AdmittedTurn; run: BackendRunRecord; output: TurnOutput }): Promise<void>;
}

export interface PostTurnOperations {
  readonly presentation?: PostTurnOperation;
  readonly learningReview?: PostTurnOperation;
  readonly externalAssistSync?: PostTurnOperation;
  readonly notification?: PostTurnOperation;
  readonly telemetry?: PostTurnOperation;
}

export interface HostCompletionPort extends RequiredCompletionPort {}

export interface TurnCleanupPort {
  cleanup(input: { runId: string; sessionId: string }): Promise<void>;
}

export type HostDiagnosticEventType = Extract<BackendEventRecord["event_type"], "host_post_turn_failed" | "host_cleanup_failed" | "host_emit_failed">;

export interface HostDiagnosticInput {
  runId: string;
  sessionId: string;
  attemptNo: number;
  operationId: string;
  eventType: HostDiagnosticEventType;
  message: string;
  metadata?: Record<string, JsonValue>;
}

export interface HostDiagnosticsPort {
  record(input: HostDiagnosticInput): Promise<void>;
  logPersistenceFailure(input: HostDiagnosticInput & { error: unknown }): void;
}

export interface ResumePreparation {
  readonly backendInput: BackendRunInput;
  readonly gatewayBoundaryPolicy?: GatewayBoundaryPolicy;
}

export interface HostPorts {
  readonly store: HostStorePort;
  readonly context: HostContextPort;
  readonly completion: HostCompletionPort;
  readonly preflight: TurnPreflightPort;
  readonly committedEventPublisher: CommittedEventPublisherPort;
  readonly admissionObserver: AdmissionObserverPort;
  readonly toolExecution: TurnToolExecutionPort;
  readonly cleanup: TurnCleanupPort;
  readonly diagnostics: HostDiagnosticsPort;
  readonly prepareResumeInput?: (input: {
    run: BackendRunRecord;
    resumeInput: Record<string, JsonValue>;
  }) => Promise<ResumePreparation>;
  readonly clock?: () => string;
  readonly maxConcurrency?: number;
  readonly resolveDefaultBackendId?: () => Promise<string> | string;
  readonly postTurn?: PostTurnOperations;
}

export interface BackendEventNormalizer { normalize(input: { runId: string; sessionId: string; attemptNo: number; event: unknown }): CanonicalLifecycleEvent | undefined; }
