import { AgentBackendRegistry } from "@samurai-agent/agent-backends";
import type { BackendRuntimeFailure, BackendTerminalEvidence } from "@samurai-agent/agent-backends";
import { nowIso, type BackendEventRecord, type BackendRunRecord, type MessageRecord } from "@samurai-agent/core-schemas";
import { BackendEventJournal } from "../execution/backend-event-journal";
import { RunControl } from "../execution/run-control";
import { RunLifecycle, type PreparedTerminalSettlement } from "../execution/run-lifecycle";
import { SessionRunQueue } from "../execution/session-run-queue";
import { TurnExecutor } from "../execution/turn-executor";
import { lifecycleEventForTerminalEvidence } from "../execution/run-state-machine";
import { TurnAdmission } from "./turn-admission";
import { TurnPreparer } from "./turn-preparer";
import type { AdmittedTurn, HostPorts, PreparedTurn, TurnOutcome, TurnRequest, TurnOutput } from "./host-types";

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
  private readonly activeAbortControllers = new Map<string, AbortController>();

  constructor(private readonly registry: AgentBackendRegistry, private readonly ports: HostPorts) {
    this.clock = ports.clock ?? nowIso;
    this.queue = new SessionRunQueue({ maxConcurrency: ports.maxConcurrency });
    this.journal = new BackendEventJournal(ports.store, this.clock);
    this.lifecycle = new RunLifecycle(this.clock);
    this.admission = new TurnAdmission(registry, ports.store, this.clock, ports.resolveDefaultBackendId);
    this.preparer = new TurnPreparer(ports.context);
    this.executor = new TurnExecutor(ports.store, this.journal, {
      lifecycle: this.lifecycle,
      emitCommitted: async (event, run) => {
        await ports.emitCommitted?.({ event, run });
      },
      toolDispatch: ports.toolDispatch,
      cleanup: ports.cleanup
    });
    this.control = new RunControl(ports.store, (id) => this.registry.get(id), { clock: this.clock, cleanup: ports.cleanup }, this.journal);
  }

  async runTurn(request: TurnRequest, signal?: AbortSignal): Promise<TurnOutcome> {
    if (!this.accepting) throw new Error("agent_host_not_accepting");
    return this.queue.enqueue(request.sessionId, () => this.execute(request, signal), signal);
  }

  /** Compatibility name for callers that still use the Host request verb. */
  run(request: TurnRequest, signal?: AbortSignal): Promise<TurnOutcome> {
    return this.runTurn(request, signal);
  }

  async cancelRun(runId: string): Promise<Awaited<ReturnType<RunControl["cancel"]>>> {
    this.activeAbortControllers.get(runId)?.abort();
    const result = await this.control.cancel(runId);
    if (isSettled(result)) this.queue.releaseSession(result.session_id);
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
    if (isSettled(result)) this.queue.releaseSession(result.session_id);
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
    }
    if (isSettled(result)) this.queue.releaseSession(result.session_id);
    else if (result.status !== "waiting_for_backend_input") lease?.restoreSuspended();
    return result;
  }

  private async execute(request: TurnRequest, signal?: AbortSignal): Promise<TurnOutcome> {
    const admitted = await this.admission.admit(request);
    if (!admitted.replay && this.ports.onAdmitted) await this.ports.onAdmitted(admitted).catch(() => undefined);
    if (admitted.replay) {
      const [events, messages] = await Promise.all([
        this.ports.store.listBackendEvents({ runId: admitted.run.id }),
        admitted.run.output_message_id && this.ports.store.listMessages ? this.ports.store.listMessages(admitted.run.session_id) : Promise.resolve([])
      ]);
      if (admitted.run.status === "waiting_for_backend_input") this.queue.markWaiting(admitted.run.session_id, waitingExecutionFromEvents(events));
      return replayOutcome(admitted, events, messages.find((message) => message.id === admitted.run.output_message_id));
    }

    const controller = new AbortController();
    const abortListener = () => controller.abort();
    signal?.addEventListener("abort", abortListener, { once: true });
    this.activeAbortControllers.set(admitted.run.id, controller);
    let run = admitted.run;
    let prepared: PreparedTurn | undefined;
    const events: BackendEventRecord[] = [];
    const textParts: string[] = [];
    let settlementStarted = false;
    try {
      run = await this.lifecycle.transition(this.ports.store, run, { type: "preparing" });
      await this.ports.preflight?.(admitted);
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
        const output: TurnOutput = { content: textParts.join("") || outputSummaryFromEvents(execution.events) || "", events };
        settlementStarted = true;
        const settled = await this.commitSettlement(admitted, execution.terminalSettlement, output);
        settlementStarted = false;
        return outcomeForSettledRun(settled, output);
      }

      const pending = await this.prepareUnknown(run);
      const output: TurnOutput = { content: textParts.join("") || outputSummaryFromEvents(execution.events) || "", events: [...events, pending.terminalEvent] };
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
      const output: TurnOutput = { content: textParts.join("") || outputSummaryFromEvents(events) || "", events: [...events, pending.terminalEvent] };
      settlementStarted = true;
      const settled = await this.commitSettlement(admitted, pending, output);
      settlementStarted = false;
      return settled.status === "outcome_unknown"
        ? { kind: "outcome_unknown", run: settled, error: error instanceof Error ? error : new Error("outcome_unknown") }
        : { kind: settled.status === "cancelled" ? "cancelled" : "failed", run: settled, ...(settled.status === "cancelled" ? { reason: settled.error_code ?? "cancelled" } : { error: error instanceof Error ? error : new Error("backend_failed") }) };
    } finally {
      if (signal) signal.removeEventListener("abort", abortListener);
      this.activeAbortControllers.delete(admitted.run.id);
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
      await this.ports.emitCommitted?.({ event: pending.terminalEvent, run: settled });
    } catch (error) {
      await this.ports.cleanup?.recordFailure?.({ runId: settled.id, operation: "terminal_event_emit", error });
    }
    return settled;
  }

  async shutdown(): Promise<void> {
    this.accepting = false;
    for (const controller of this.activeAbortControllers.values()) controller.abort();
    this.queue.releaseAllWaiting();
    await this.queue.drainAll();
    this.queue.close();
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

function isSettled(run: BackendRunRecord): boolean {
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
