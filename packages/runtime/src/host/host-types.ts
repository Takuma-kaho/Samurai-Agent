import type { AgentBackend, BackendRunInput } from "@samurai-agent/agent-backends";
import type {
  AgentBackendKind,
  BackendEventRecord,
  BackendRunRecord,
  ContextHandoff,
  ContextPreview,
  GatewayBoundaryRuntimeSnapshot,
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
}

export interface BackendBinding { readonly id: string; readonly kind: AgentBackendKind; readonly backend: AgentBackend; }
export interface BackendBoundTurn { readonly request: TurnRequest; readonly session: SessionRecord; readonly binding: BackendBinding; readonly requestHash: string; }
export interface SessionRunReservation { readonly sessionId: string; readonly runId: string; readonly version: number; readonly status: "held" | "released"; }
export interface AdmittedTurn extends BackendBoundTurn { readonly reservation: SessionRunReservation; readonly userMessage: MessageRecord; readonly run: BackendRunRecord; }
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

export interface HostAdmissionStore {
  getSession(sessionId: string): Promise<SessionRecord | undefined>;
  findBackendRunByIdempotency?(sessionId: string, key: string): Promise<BackendRunRecord | undefined>;
  admitTurn(input: { session: SessionRecord; binding: BackendBinding; request: TurnRequest; requestHash: string; runId: string; now: string }): Promise<{ reservation: SessionRunReservation; userMessage: MessageRecord; run: BackendRunRecord; replay: boolean }>;
  updateBackendRun(run: BackendRunRecord): Promise<BackendRunRecord>;
  getBackendRun(runId: string): Promise<BackendRunRecord | undefined>;
  listBackendEvents(input: { runId: string }): Promise<BackendEventRecord[]>;
  listMessages?(sessionId: string): Promise<MessageRecord[]>;
  saveBackendEvent(event: BackendEventRecord): Promise<BackendEventRecord>;
  saveMessage(message: MessageRecord): Promise<MessageRecord>;
  commitCore02RunTransition?(input: { expectedRun: BackendRunRecord; nextRun: BackendRunRecord }): Promise<BackendRunRecord>;
  commitCore02BackendSession?(input: { expectedRun: BackendRunRecord; nextRun: BackendRunRecord }): Promise<BackendRunRecord>;
  commitTurnSettlement?(input: TurnSettlementInput): Promise<BackendRunRecord>;
  getSessionRunReservation?(input: { runId: string }): Promise<SessionRunReservation | undefined>;
  releaseReservation?(runId: string): Promise<void>;
}

export interface HostContextPort {
  getCandidates(input: { turn: AdmittedTurn; signal?: AbortSignal }): Promise<ContextPreview>;
  assemble(input: { turn: AdmittedTurn; candidates: ContextPreview; signal?: AbortSignal }): Promise<TurnContextAssemblyResult>;
  handoff(input: { turn: AdmittedTurn; candidates: ContextPreview; assembly: TurnContextAssemblyResult; signal?: AbortSignal }): Promise<TurnBackendHandoffResult>;
}

export interface ToolDispatchPort {
  dispatch(input: { turn: PreparedTurn; event: { tool_call_id?: string; payload: Record<string, JsonValue> } }): Promise<void>;
}

export interface RequiredCompletionPort {
  commitTurnSettlement(input: TurnSettlementInput & { admitted: AdmittedTurn; turnOutput: TurnOutput }): Promise<BackendRunRecord>;
}

export interface PostTurnPort {
  readonly id?: string;
  run(input: { admitted: AdmittedTurn; run: BackendRunRecord; output: TurnOutput }): Promise<void>;
}

export interface HostCompletionPort extends RequiredCompletionPort {}

export interface TurnCleanupPort {
  flushEvents?(runId: string): Promise<void>;
  clearEventSequence?(runId: string): void | Promise<void>;
  revokeToolBridge?(runId: string): void | Promise<void>;
  releaseExecutionLock?(input: { runId: string; sessionId: string }): Promise<void>;
  recordFailure?(input: { runId: string; operation: string; error: unknown }): void | Promise<void>;
}

export interface HostPorts {
  readonly store: HostAdmissionStore;
  readonly context: HostContextPort;
  readonly completion: HostCompletionPort;
  readonly toolDispatch?: ToolDispatchPort;
  readonly emitCommitted?: (input: { event: BackendEventRecord; run: BackendRunRecord }) => Promise<void>;
  readonly clock?: () => string;
  readonly maxConcurrency?: number;
  readonly resolveDefaultBackendId?: () => Promise<string> | string;
  readonly preflight?: (input: BackendBoundTurn) => Promise<void>;
  readonly onAdmitted?: (input: AdmittedTurn) => Promise<void>;
  readonly cleanup?: TurnCleanupPort;
}

export interface BackendEventNormalizer { normalize(input: { runId: string; sessionId: string; attemptNo: number; event: unknown }): CanonicalLifecycleEvent | undefined; }
