import { AgentBackendRegistry } from "@samurai-agent/agent-backends";
import type { BackendOutputEvent, BackendRuntimeFailure, BackendTerminalEvidence } from "@samurai-agent/agent-backends";
import { nowIso, stableHash, type BackendEventRecord, type BackendRunRecord, type MessageRecord } from "@samurai-agent/core-schemas";
import { BackendEventJournal } from "../execution/backend-event-journal";
import { RunControl } from "../execution/run-control";
import { RunRecovery } from "../execution/run-recovery";
import { RunLifecycle, type PreparedTerminalSettlement } from "../execution/run-lifecycle";
import { SessionRunQueue } from "../execution/session-run-queue";
import { TurnExecutor } from "../execution/turn-executor";
import { lifecycleEventForTerminalEvidence } from "../execution/run-state-machine";
import { normalizeBackendOutputEvent } from "../backend/event-bridge";
import { TurnAdmission } from "./turn-admission";
import { TurnPreparer } from "./turn-preparer";
import type { AdmittedTurn, HostDiagnosticInput, HostPorts, PreparedTurn, TurnOutcome, TurnRequest, TurnOutput } from "./host-types";

export class AgentHost {
  readonly queue: SessionRunQueue;
  private accepting = true;
  private readonly clock: () => string;
  private readonly journal: BackendEventJournal;
  private readonly lifecycle: RunLifecycle;
  private readonly admission: TurnAdmission;
  private readonly preparer: TurnPreparer;
  private readonly executor: TurnExecutor;
  private readonly control: RunControl;
  private readonly recovery: RunRecovery;
  private recoveryPromise: Promise<void> | undefined;
  private readonly activeAbortControllers = new Map<string, AbortController>();
  private readonly activeRunSessions = new Map<string, string>();

  constructor(private readonly registry: AgentBackendRegistry, private readonly ports: HostPorts) {
    this.clock = ports.clock ?? nowIso;
    this.queue = new SessionRunQueue({ maxConcurrency: ports.maxConcurrency });
    this.journal = new BackendEventJournal(ports.store, this.clock);
    this.lifecycle = new RunLifecycle(this.clock);
    this.admission = new TurnAdmission(registry, ports.store, this.clock, ports.resolveDefaultBackendId);
    this.preparer = new TurnPreparer(ports.context);
    this.executor = new TurnExecutor(ports.store, this.journal, {
      lifecycle: this.lifecycle,
      committedEventPublisher: ports.committedEventPublisher,
      toolExecution: ports.toolExecution,
      cleanup: ports.cleanup,
      diagnostics: ports.diagnostics
    });
    this.control = new RunControl(ports.store, (id) => this.registry.get(id), {
      clock: this.clock,
      cleanup: ports.cleanup,
      diagnostics: ports.diagnostics,
      committedEventPublisher: ports.committedEventPublisher,
      toolExecution: ports.toolExecution,
      prepareResumeInput: ports.prepareResumeInput,
      lifecycle: this.lifecycle
    }, this.journal, this.executor);
    this.recovery = new RunRecovery(
      ports.store,
      (id) => this.registry.get(id),
      this.clock,
      this.journal,
      ports.committedEventPublisher,
      ports.cleanup,
      async (run) => {
        const task = this.queue.enqueue(run.session_id, () => this.executeRecoveredRun(run));
        void task.catch((error) => this.recordDiagnostic(run, "host_cleanup_failed", "recovery_enqueue", error));
      },
      ports.diagnostics,
      this.executor,
      this.lifecycle
    );
  }

  /** Production startup performs reconciliation once before new admissions. */
  async recover(): Promise<void> {
    if (this.recoveryPromise) return this.recoveryPromise;
    this.accepting = false;
    this.recoveryPromise = this.recovery.reconcile().then(() => undefined).finally(() => {
      this.accepting = true;
    });
    return this.recoveryPromise;
  }

  async runTurn(request: TurnRequest, signal?: AbortSignal): Promise<TurnOutcome> {
    if (!this.accepting) throw new Error("agent_host_not_accepting");
    return this.queue.enqueue(request.sessionId, () => this.execute(request, signal), signal);
  }

  async cancelRun(runId: string): Promise<Awaited<ReturnType<RunControl["cancel"]>>> {
    const knownRun = await this.ports.store.getBackendRun(runId);
    this.activeAbortControllers.get(runId)?.abort();
    let result: Awaited<ReturnType<RunControl["cancel"]>>;
    try {
      result = await this.control.cancel(runId);
    } finally {
      if (knownRun) await this.executor.cleanup({ runId: knownRun.id, sessionId: knownRun.session_id });
    }
    if (isSettled(result)) {
      this.activeRunSessions.delete(result.id);
      this.queue.releaseSession(result.session_id);
    }
    return result;
  }

  async resumeRun(runId: string, input: Record<string, unknown>): Promise<Awaited<ReturnType<RunControl["resume"]>>> {
    const run = await this.ports.store.getBackendRun(runId);
    const lease = run ? await this.queue.acquireControl(run.session_id) : undefined;
    let result: Awaited<ReturnType<RunControl["resume"]>>;
    try {
      result = await this.control.resume(runId, input);
    } catch (error) {
      lease?.restoreSuspended();
      throw error;
    } finally {
      if (run) await this.executor.cleanup({ runId: run.id, sessionId: run.session_id });
    }
    if (isSettled(result)) {
      this.activeRunSessions.delete(result.id);
      this.queue.releaseSession(result.session_id);
    }
    else if (result.status !== "waiting_for_backend_input") lease?.restoreSuspended();
    return result;
  }

  async syncRun(runId: string): Promise<Awaited<ReturnType<RunControl["sync"]>>> {
    const run = await this.ports.store.getBackendRun(runId);
    const lease = run ? await this.queue.acquireControl(run.session_id) : undefined;
    let result: Awaited<ReturnType<RunControl["sync"]>>;
    try {
      result = await this.control.sync(runId);
    } catch (error) {
      lease?.restoreSuspended();
      throw error;
    } finally {
      if (run) await this.executor.cleanup({ runId: run.id, sessionId: run.session_id });
    }
    if (isSettled(result)) {
      this.queue.releaseSession(result.session_id);
    }
    else if (result.status !== "waiting_for_backend_input") lease?.restoreSuspended();
    return result;
  }

  /** Narrow journal entrance for HTTP Tool Bridge events. */
  async recordToolBridgeEvent(input: { run: BackendRunRecord; event: BackendOutputEvent }): Promise<BackendEventRecord> {
    if (input.event.event_type !== "tool_call_started" && input.event.event_type !== "tool_call_output") {
      throw new Error("tool_bridge_event_type_invalid");
    }
    const normalized = normalizeBackendOutputEvent(input.event);
    const toolCallId = normalized.tool_call_id;
    const recorded = await this.journal.appendCanonicalEvent({
      runId: input.run.id,
      sessionId: input.run.session_id,
      ...((normalized.backend_session_id ?? input.run.backend_session_id) ? { backendSessionId: normalized.backend_session_id ?? input.run.backend_session_id } : {}),
      attemptNo: input.run.current_attempt ?? 1,
      eventType: normalized.event_type,
      payload: normalized.payload,
      resourceRefs: normalized.resource_refs,
      sourceEventId: normalized.source_event_id ?? `tool-bridge:${input.run.id}:${toolCallId}:${normalized.event_type}:${stableHash(normalized.payload)}`
    });
    if (!recorded.duplicate) await this.ports.committedEventPublisher.publish({ event: recorded.event, run: input.run });
    return recorded.event;
  }

  private async execute(request: TurnRequest, signal?: AbortSignal): Promise<TurnOutcome> {
    const preparedRequest = await this.ports.preflight.prepare({ request, signal });
    const admitted = await this.admission.admit(preparedRequest);
    return this.executeAdmitted(admitted, signal, true);
  }

  private async executeRecoveredRun(run: BackendRunRecord): Promise<TurnOutcome> {
    const session = await this.ports.store.getSession(run.session_id);
    const messages = await this.ports.store.listMessages(run.session_id);
    const userMessage = messages.find((message) => message.id === run.input_message_id && message.role === "user");
    const backend = this.registry.get(run.backend_id);
    const reservation = await this.ports.store.getSessionRunReservation({ runId: run.id });
    if (!session || !userMessage || !backend || !reservation) {
      throw new Error(`recovery_run_context_missing:${run.id}`);
    }
    const admitted: AdmittedTurn = {
      request: {
        sessionId: session.id,
        content: userMessage.content,
        envelope: userMessage.envelope ?? {
          id: `recovery-envelope:${run.id}`,
          source: "local_cli",
          actor_identity: "system",
          session_key: session.session_key,
          user_intent: userMessage.content,
          attachments: [],
          input_locale: userMessage.input_locale,
          output_locale: userMessage.output_locale,
          metadata: {},
          received_at: userMessage.created_at
        },
        backendId: run.backend_id,
        idempotencyKey: run.request_idempotency_key ?? `recovery:${run.id}`,
        metadata: run.metadata
      },
      session,
      binding: { id: backend.id, kind: backend.kind, backend },
      requestHash: run.request_hash ?? `recovery:${run.id}`,
      reservation,
      userMessage,
      run
    };
    return this.executeAdmitted(admitted, undefined, false);
  }

  private async executeAdmitted(admitted: AdmittedTurn, signal?: AbortSignal, observeAdmission = false): Promise<TurnOutcome> {
    if (observeAdmission) {
      try {
        await this.ports.admissionObserver.observe(admitted);
      } catch (error) {
        await this.recordDiagnostic(admitted.run, "host_emit_failed", "admission_observer", error);
      }
    }
    if (admitted.replay) {
      const [events, messages] = await Promise.all([
        this.ports.store.listBackendEvents({ runId: admitted.run.id }),
        admitted.run.output_message_id ? this.ports.store.listMessages(admitted.run.session_id) : Promise.resolve([])
      ]);
      if (admitted.run.status === "waiting_for_backend_input") this.queue.markWaiting(admitted.run.session_id, waitingExecutionFromEvents(events));
      return replayOutcome(admitted, events, messages.find((message) => message.id === admitted.run.output_message_id));
    }

    const controller = new AbortController();
    const abortListener = () => controller.abort();
    signal?.addEventListener("abort", abortListener, { once: true });
    this.activeAbortControllers.set(admitted.run.id, controller);
    this.activeRunSessions.set(admitted.run.id, admitted.run.session_id);
    let run = admitted.run;
    let prepared: PreparedTurn | undefined;
    const events: BackendEventRecord[] = [];
    const textParts: string[] = [];
    let settlementStarted = false;
    try {
      run = await this.lifecycle.transition(this.ports.store, run, { type: "preparing" });
      prepared = await this.preparer.prepare({ ...admitted, run }, controller.signal);
      const execution = await this.executor.execute(prepared, controller.signal);
      run = execution.run;
      prepared = execution.prepared ?? { ...prepared, run };
      events.push(...execution.events);
      textParts.push(execution.text);
      if (run.status === "waiting_for_backend_input") {
        this.queue.markWaiting(run.session_id, execution.waitingExecution ?? "live");
        return { kind: "waiting", run, waiting: { prompt: waitingPrompt(execution.events) } };
      }
      if (execution.terminalSettlement) {
        const output: TurnOutput = { content: outputContent(execution.terminalSettlement.nextRun.status, textParts.join(""), execution.events), events };
        settlementStarted = true;
        const settled = await this.commitSettlement(admitted, execution.terminalSettlement, output);
        settlementStarted = false;
        return outcomeForSettledRun(settled, output);
      }

      const pending = await this.prepareUnknown(run);
      const output: TurnOutput = { content: outputContent(pending.nextRun.status, textParts.join(""), [...events, pending.terminalEvent]), events: [...events, pending.terminalEvent] };
      settlementStarted = true;
      const settled = await this.commitSettlement(admitted, pending, output);
      settlementStarted = false;
      return { kind: "outcome_unknown", run: settled, error: new Error("backend_terminal_missing") };
    } catch (error) {
      // A required-finalize failure must remain retryable through the same
      // idempotent settlement. Do not manufacture a second terminal result.
      if (settlementStarted) throw error;
      const current = await this.ports.store.getBackendRun(run.id) ?? run;
      if (isSettled(current)) return outcomeForSettledRun(current, { content: textParts.join(""), events });
      const evidence = current.phase === "admitted" || current.phase === "preparing" || current.phase === "backend_starting"
        ? { kind: "not_started", source: "preflight_rejection" } as const
        : { kind: "indeterminate", reason: controller.signal.aborted ? "cancel_unconfirmed" : "transport_lost", providerStarted: true, mayHaveSideEffects: true } as const;
      const failure = { code: controller.signal.aborted ? "backend_cancel_unconfirmed" : "backend_exception", message: error instanceof Error ? error.message : "Backend execution failed.", retryable: false, causeCategory: controller.signal.aborted ? "cancellation" as const : "runtime" as const };
      const pending = await this.prepareTerminal(current, evidence, failure, controller.signal.aborted);
      const output: TurnOutput = { content: outputContent(pending.nextRun.status, textParts.join(""), [...events, pending.terminalEvent]), events: [...events, pending.terminalEvent] };
      settlementStarted = true;
      const settled = await this.commitSettlement(admitted, pending, output);
      settlementStarted = false;
      if (settled.status === "outcome_unknown") {
        return { kind: "outcome_unknown", run: settled, error: error instanceof Error ? error : new Error("outcome_unknown") };
      }
      if (settled.status === "cancelled") {
        return { kind: "cancelled", run: settled, reason: settled.error_code ?? "cancelled" };
      }
      return { kind: "failed", run: settled, error: error instanceof Error ? error : new Error("backend_failed") };
    } finally {
      if (signal) signal.removeEventListener("abort", abortListener);
      this.activeAbortControllers.delete(admitted.run.id);
      if (run.status !== "waiting_for_backend_input") this.activeRunSessions.delete(admitted.run.id);
      await this.executor.cleanup({ runId: admitted.run.id, sessionId: admitted.run.session_id });
    }
  }

  private async prepareUnknown(run: BackendRunRecord): Promise<PreparedTerminalSettlement> {
    return this.prepareTerminal(run, { kind: "indeterminate", reason: "runtime_state_unavailable", providerStarted: true, mayHaveSideEffects: true }, { code: "backend_runtime_state_unavailable", message: "Backend finished without a terminal result.", retryable: false, causeCategory: "runtime" }, false);
  }

  private async prepareTerminal(run: BackendRunRecord, evidence: BackendTerminalEvidence, failure: BackendRuntimeFailure, requestedCancel: boolean): Promise<PreparedTerminalSettlement> {
    const lifecycleEvent = lifecycleEventForTerminalEvidence(evidence, { requestedCancel, failure });
    const decision = this.lifecycle.decide(run, lifecycleEvent);
    return this.journal.prepareTerminalSettlement(run, {
      runId: run.id,
      sessionId: run.session_id,
      attemptNo: run.current_attempt ?? 1,
      eventType: decision.toStatus === "completed" ? "run_completed" : "run_failed",
      payload: { error_code: failure.code, message: failure.message },
      sourceEventId: `terminal:${run.id}:${run.current_attempt ?? 1}:${decision.toStatus}`,
      terminalEvidence: evidence
    }, decision);
  }

  private async commitSettlement(admitted: AdmittedTurn, pending: PreparedTerminalSettlement, output: TurnOutput): Promise<BackendRunRecord> {
    const settled = await this.ports.completion.commitTurnSettlement({
      ...pending,
      admitted,
      turnOutput: output,
      outputSourceId: `message:${admitted.run.id}:output`,
      reservation: admitted.reservation,
      ...(!output.content ? { diagnostic: { code: pending.nextRun.error_code ?? "turn_settled", message: pending.decision.failure?.message ?? pending.decision.reason } } : {})
    });
    try {
      await this.ports.committedEventPublisher.publish({ event: pending.terminalEvent, run: settled });
    } catch (error) {
      await this.recordDiagnostic(settled, "host_emit_failed", "terminal_event", error);
    }
    return settled;
  }

  private async recordDiagnostic(run: Pick<BackendRunRecord, "id" | "session_id" | "current_attempt">, eventType: HostDiagnosticInput["eventType"], operationId: string, error: unknown): Promise<void> {
    const input = {
      runId: run.id,
      sessionId: run.session_id,
      attemptNo: run.current_attempt ?? 1,
      operationId,
      eventType,
      message: error instanceof Error ? error.message : String(error)
    } as const;
    try {
      await this.ports.diagnostics.record(input);
    } catch (diagnosticError) {
      this.ports.diagnostics.logPersistenceFailure({ ...input, error: diagnosticError });
    }
  }

  async shutdown(): Promise<void> {
    this.accepting = false;
    this.queue.close();
    await this.queue.drainPending();
    for (const controller of this.activeAbortControllers.values()) controller.abort();
    const waitingRuns = [...this.activeRunSessions.keys()].filter((runId) => !this.activeAbortControllers.has(runId));
    await Promise.allSettled(waitingRuns.map(async (runId) => {
      try {
        await this.cancelRun(runId);
      } catch (error) {
        await this.recordDiagnostic({ id: runId, session_id: this.activeRunSessions.get(runId) ?? "unknown", current_attempt: 1 }, "host_cleanup_failed", "shutdown_cancel", error);
      }
    }));
    await this.queue.drainAll();
  }
}

function replayOutcome(admitted: AdmittedTurn, events: BackendEventRecord[], outputMessage?: MessageRecord): TurnOutcome {
  if (admitted.run.status === "waiting_for_backend_input") return { kind: "waiting", run: admitted.run, waiting: { prompt: admitted.run.output_summary ?? "Backend input required" } };
  if (admitted.run.status === "failed") return { kind: "failed", run: admitted.run, error: new Error(admitted.run.error_code ?? "backend_failed") };
  if (admitted.run.status === "cancelled") return { kind: "cancelled", run: admitted.run, reason: admitted.run.error_code ?? "cancelled" };
  if (admitted.run.status === "outcome_unknown") return { kind: "outcome_unknown", run: admitted.run, error: new Error(admitted.run.error_code ?? "outcome_unknown") };
  if (admitted.run.status === "queued" || admitted.run.status === "running") return { kind: "queued", run: admitted.run };
  return { kind: "completed", run: admitted.run, output: { content: outputMessage?.content ?? admitted.run.output_summary ?? "", events } };
}

function outcomeForSettledRun(run: BackendRunRecord, output: TurnOutput): TurnOutcome {
  if (run.status === "completed") return { kind: "completed", run, output };
  if (run.status === "cancelled") return { kind: "cancelled", run, reason: run.error_code ?? "cancelled" };
  if (run.status === "outcome_unknown") return { kind: "outcome_unknown", run, error: new Error(run.error_code ?? "outcome_unknown") };
  return { kind: "failed", run, error: new Error(run.error_code ?? "backend_failed") };
}

function isSettled(run: BackendRunRecord): run is BackendRunRecord & { status: "completed" | "failed" | "cancelled" | "outcome_unknown" } {
  return run.status === "completed" || run.status === "failed" || run.status === "cancelled" || run.status === "outcome_unknown";
}

function waitingPrompt(events: BackendEventRecord[]): string {
  const event = [...events].reverse().find((candidate) => candidate.event_type === "backend_waiting_for_native_input");
  return typeof event?.payload.prompt === "string" ? event.payload.prompt : "Backend input required";
}

function waitingExecutionFromEvents(events: BackendEventRecord[]): "live" | "suspended" {
  const waiting = [...events].reverse().find((event) => event.event_type === "backend_waiting_for_native_input");
  return waiting?.payload.waiting_execution === "suspended" ? "suspended" : "live";
}

function outputSummaryFromEvents(events: BackendEventRecord[]): string | undefined {
  const terminal = [...events].reverse().find((event) => event.event_type === "run_completed");
  return typeof terminal?.payload.output_summary === "string" ? terminal.payload.output_summary : undefined;
}

function outputContent(status: BackendRunRecord["status"], text: string, events: BackendEventRecord[]): string {
  return text || outputSummaryFromEvents(events) || "";
}
