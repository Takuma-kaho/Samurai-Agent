import { AgentBackendRegistry } from "@samurai-agent/agent-backends";
import type { AgentBackend, BackendCancelResult, BackendOutputEvent, BackendRunInput, BackendRuntimeFailure, BackendTerminalEvidence } from "@samurai-agent/agent-backends";
import {
  createId,
  nowIso,
  stableHash,
  TrustedWorkspaceContextSchema,
  WorkspaceExecutionRequestSchema,
  type BackendEventRecord,
  type BackendRunRecord,
  type MessageRecord,
  type WorkspaceExecutionRequest
} from "@samurai-agent/core-schemas";
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
import { workspaceBackendInput } from "./workspace-backend-input.js";
import type { AdmittedTurn, HostDiagnosticInput, HostPorts, PreparedTurn, PreparedWorkspaceExecution, TurnOutcome, TurnRequest, TurnOutput, WorkspaceExecutionOutcome } from "./host-types";

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
  private readonly activeWorkspaceAbortControllers = new Map<string, AbortController>();
  private readonly activeWorkspaceExecutions = new Map<string, Promise<WorkspaceExecutionOutcome>>();

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
        requireSessionBoundRun(run);
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
    this.recoveryPromise = this.recovery.reconcile().then(async () => {
      this.accepting = true;
      await this.recoverWorkspaceRuns();
    }).finally(() => {
      this.accepting = true;
    });
    return this.recoveryPromise;
  }

  async runTurn(request: TurnRequest, signal?: AbortSignal): Promise<TurnOutcome> {
    if (!this.accepting) throw new Error("agent_host_not_accepting");
    return this.queue.enqueue(request.sessionId, () => this.executeSessionAdapter(request, signal), signal);
  }

  /**
   * Room-first Host entry. It uses the same registry, Event journal and
   * lifecycle as Chat, but deliberately does not construct a Session or
   * Message for a non-Chat request.
   */
  async runWorkspaceExecution(input: WorkspaceExecutionRequest, signal?: AbortSignal): Promise<WorkspaceExecutionOutcome> {
    return await this.executeWorkspaceRequest(input, signal) as WorkspaceExecutionOutcome;
  }

  /** The Session adapter reaches the same Workspace Execution Request boundary. */
  private async executeSessionAdapter(request: TurnRequest, signal?: AbortSignal): Promise<TurnOutcome> {
    const preparedRequest = await this.ports.preflight.prepare({ request, signal });
    const workspaceRequest = workspaceExecutionRequestForTurn(preparedRequest);
    return await this.executeWorkspaceRequest(workspaceRequest, signal, { request: preparedRequest }) as TurnOutcome;
  }

  private async executeWorkspaceRequest(
    input: WorkspaceExecutionRequest,
    signal?: AbortSignal,
    sessionAdapter?: { request: TurnRequest }
  ): Promise<WorkspaceExecutionOutcome | TurnOutcome> {
    if (!this.accepting) throw new Error("agent_host_not_accepting");
    const request = WorkspaceExecutionRequestSchema.parse(input);
    const context = TrustedWorkspaceContextSchema.parse(request.context);
    if (!context.room_id) throw new Error("workspace_run_room_required");
    if (sessionAdapter) {
      assertSessionAdapterContext(sessionAdapter.request, context);
      const admitted = await this.admission.admit(sessionAdapter.request, context);
      return this.executeAdmitted(admitted, signal, true);
    }
    const backendId = request.backend_id?.trim() || await this.ports.resolveDefaultBackendId?.();
    if (!backendId) throw new Error("backend_not_selected");
    const backend = this.registry.get(backendId);
    if (!backend) throw new Error(`backend_not_registered:${backendId}`);
    const runId = context.run_id ?? createId("run");
    const requestHash = stableHash({ ...request, backend_id: backend.id });
    const run = await this.ports.store.admitWorkspaceRun({
      context: { ...context, run_id: runId },
      backendId: backend.id,
      backendKind: backend.kind,
      runId,
      requestHash,
      idempotencyKey: context.correlation_id,
      ...(request.agent_id ? { agentId: request.agent_id } : {}),
      ...(request.input_summary ? { inputSummary: request.input_summary } : {}),
      metadata: request.metadata,
      now: this.clock()
    });
    const active = this.activeWorkspaceExecutions.get(run.id);
    if (active) return active;
    if (isSettled(run)) return workspaceOutcomeFromRun(run, await this.ports.store.listBackendEvents({ runId: run.id }));
    if (run.status === "waiting_for_backend_input") {
      return workspaceOutcomeFromRun(run, await this.ports.store.listBackendEvents({ runId: run.id }));
    }
    const task = this.executeWorkspaceRun(run, backend, request, signal);
    this.activeWorkspaceExecutions.set(run.id, task);
    try {
      return await task;
    } finally {
      this.activeWorkspaceExecutions.delete(run.id);
      this.activeWorkspaceAbortControllers.delete(run.id);
    }
  }

  private async executeWorkspaceRun(
    admittedRun: BackendRunRecord,
    backend: NonNullable<ReturnType<AgentBackendRegistry["get"]>>,
    request: WorkspaceExecutionRequest,
    signal?: AbortSignal
  ): Promise<WorkspaceExecutionOutcome> {
    const controller = new AbortController();
    const abortListener = () => controller.abort();
    signal?.addEventListener("abort", abortListener, { once: true });
    this.activeWorkspaceAbortControllers.set(admittedRun.id, controller);
    let run = admittedRun;
    const summary = request.input_summary?.trim() || "Workspace execution";
    const baseBackendInput: BackendRunInput = {
      ...workspaceBackendInput(admittedRun, this.clock, summary, request.metadata),
      abort_signal: controller.signal
    };
    try {
      const workspacePreparation = this.ports.prepareWorkspaceExecution
        ? await this.ports.prepareWorkspaceExecution({
            run: admittedRun,
            binding: { id: backend.id, kind: backend.kind, backend },
            request,
            backendInput: baseBackendInput
          })
        : { backendInput: baseBackendInput };
      run = await this.lifecycle.transition(this.ports.store, run, { type: "preparing" });
      const prepared: PreparedWorkspaceExecution = {
        run,
        binding: { id: backend.id, kind: backend.kind, backend },
        backendInput: workspacePreparation.backendInput,
        ...(workspacePreparation.gatewayBoundaryPolicy ? { gatewayBoundaryPolicy: workspacePreparation.gatewayBoundaryPolicy } : {})
      };
      const execution = await this.executor.execute(prepared, controller.signal);
      run = execution.run;
      if (run.status === "waiting_for_backend_input") {
        return { kind: "waiting", run, waiting: { prompt: waitingPrompt(execution.events) } };
      }
      if (execution.terminalSettlement) {
        const output: TurnOutput = { content: execution.text, events: execution.events };
        const settled = await this.settleWorkspaceRun(execution.terminalSettlement, output);
        return workspaceOutcomeFromRun(settled, execution.events, output);
      }
      const failure = workspaceRuntimeFailure("backend_terminal_missing", "Backend finished without a terminal result.");
      const pending = await this.prepareWorkspaceTerminal(run, {
        kind: "indeterminate",
        reason: "runtime_state_unavailable",
        providerStarted: true,
        mayHaveSideEffects: true
      }, failure);
      const settled = await this.settleWorkspaceRun(pending, { content: execution.text, events: [...execution.events, pending.terminalEvent] }, failure);
      return { kind: "outcome_unknown", run: settled, error: new Error(failure.message) };
    } catch (error) {
      const current = await this.ports.store.getBackendRun(admittedRun.id) ?? run;
      if (isSettled(current)) return workspaceOutcomeFromRun(current, await this.ports.store.listBackendEvents({ runId: current.id }));
      const failure = workspaceRuntimeFailure("backend_exception", error instanceof Error ? error.message : "Backend execution failed.");
      const pending = await this.prepareWorkspaceTerminal(current, {
        kind: "indeterminate",
        reason: controller.signal.aborted ? "cancel_unconfirmed" : "transport_lost",
        providerStarted: current.phase === "external_running" || current.status === "running",
        mayHaveSideEffects: current.phase === "external_running" || current.status === "running"
      }, failure);
      const settled = await this.settleWorkspaceRun(pending, { content: "", events: [pending.terminalEvent] }, failure);
      return { kind: "outcome_unknown", run: settled, error: error instanceof Error ? error : new Error(failure.message) };
    } finally {
      signal?.removeEventListener("abort", abortListener);
      await this.executor.cleanup({ runId: admittedRun.id });
    }
  }

  private async prepareWorkspaceTerminal(run: BackendRunRecord, evidence: BackendTerminalEvidence, failure?: BackendRuntimeFailure, requestedCancel = false): Promise<PreparedTerminalSettlement> {
    const lifecycleEvent = lifecycleEventForTerminalEvidence(evidence, { ...(failure ? { failure } : {}), ...(requestedCancel ? { requestedCancel: true } : {}) });
    const decision = this.lifecycle.decide(run, lifecycleEvent);
    return this.journal.prepareTerminalSettlement(run, {
      runId: run.id,
      ...(run.session_id ? { sessionId: run.session_id } : {}),
      attemptNo: run.current_attempt ?? 1,
      eventType: decision.toStatus === "completed" ? "run_completed" : "run_failed",
      payload: {
        ...(failure ? { error_code: failure.code, message: failure.message } : {}),
        ...(evidence.kind === "cancelled" ? { message: "Backend cancellation was confirmed." } : {})
      },
      sourceEventId: `workspace-terminal:${run.id}:${run.current_attempt ?? 1}:${decision.toStatus}`,
      terminalEvidence: evidence
    }, decision);
  }

  private async settleWorkspaceRun(pending: PreparedTerminalSettlement, output: TurnOutput, failure?: BackendRuntimeFailure): Promise<BackendRunRecord> {
    const settled = await this.ports.store.commitWorkspaceRunSettlement({
      expectedRun: pending.expectedRun,
      nextRun: pending.nextRun,
      terminalEvent: pending.terminalEvent,
      outputSummary: output.content || undefined,
      ...(failure ? { diagnostic: { code: failure.code, message: failure.message } } : {})
    });
    try {
      await this.ports.committedEventPublisher.publish({ event: pending.terminalEvent, run: settled });
    } catch (error) {
      await this.recordDiagnostic(settled, "host_emit_failed", "workspace_terminal_event", error);
    }
    return settled;
  }

  private async cancelWorkspaceRun(runId: string): Promise<BackendRunRecord> {
    const initial = await this.ports.store.getBackendRun(runId);
    if (!initial) throw new Error(`run_not_found:${runId}`);
    if (isSettled(initial)) return initial;
    await this.ports.assertRunAccess?.(initial);
    this.activeWorkspaceAbortControllers.get(runId)?.abort();
    const backend = this.registry.get(initial.backend_id);
    let cancellation: BackendCancelResult = { kind: "unsupported" };
    try {
      if (backend?.cancelRun) cancellation = await backend.cancelRun(runId);
    } catch {
      cancellation = { kind: "unsupported" };
    }
    const latest = await this.ports.store.getBackendRun(runId) ?? initial;
    if (isSettled(latest)) return latest;
    if (latest.status === "queued") {
      const pending = await this.prepareWorkspaceTerminal(latest, { kind: "not_started", source: "preflight_rejection" }, {
        code: "cancelled",
        message: "Queued Workspace run was cancelled before backend start.",
        retryable: false,
        causeCategory: "cancellation"
      }, true);
      return this.settleWorkspaceRun(pending, { content: "", events: [pending.terminalEvent] }, {
        code: "cancelled",
        message: "Queued Workspace run was cancelled before backend start.",
        retryable: false,
        causeCategory: "cancellation"
      });
    }
    let cancelling = latest;
    if (latest.status === "running" || latest.status === "waiting_for_backend_input") {
      cancelling = await this.lifecycle.transition(this.ports.store, latest, { type: "cancel_requested" });
    }
    const evidence = cancellation.kind === "settled"
      ? cancellation.evidence
      : { kind: "indeterminate" as const, reason: "cancel_unconfirmed" as const, providerStarted: true, mayHaveSideEffects: true };
    const failure = evidence.kind === "indeterminate"
      ? { code: "backend_cancel_unconfirmed", message: "Backend cancellation could not be confirmed.", retryable: false, causeCategory: "cancellation" as const }
      : undefined;
    const pending = await this.prepareWorkspaceTerminal(cancelling, evidence, failure, true);
    return this.settleWorkspaceRun(pending, { content: "", events: [pending.terminalEvent] }, failure);
  }

  private async resumeWorkspaceRun(runId: string, input: Record<string, unknown>): Promise<BackendRunRecord> {
    const run = await this.ports.store.getBackendRun(runId);
    if (!run) throw new Error(`run_not_found:${runId}`);
    if (isSettled(run)) return run;
    if (run.status !== "waiting_for_backend_input") throw new Error(`run_not_waiting:${runId}`);
    await this.ports.assertRunAccess?.(run);
    const backend = this.registry.get(run.backend_id);
    const resumeInput = Object.fromEntries(Object.entries(input).filter(([, value]) => value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean" || Array.isArray(value) || (typeof value === "object" && value !== null))) as Record<string, import("@samurai-agent/core-schemas").JsonValue>;
    const recorded = await this.journal.appendCanonicalEvent({
      runId: run.id,
      attemptNo: run.current_attempt ?? 1,
      eventType: "backend_native_input_submitted",
      payload: { submitted_at: this.clock(), has_input: Object.keys(resumeInput).length > 0 },
      sourceEventId: `workspace:resume-input:${run.id}:${run.current_attempt ?? 1}`
    });
    if (!recorded.duplicate) await this.ports.committedEventPublisher.publish({ event: recorded.event, run });
    if (!backend?.resumeRun) {
      const failure = { code: "backend_resume_unsupported", message: "Backend does not support resume.", retryable: false, causeCategory: "configuration" as const };
      const pending = await this.prepareWorkspaceTerminal(run, { kind: "not_started", source: "preflight_rejection" }, failure, false);
      return this.settleWorkspaceRun(pending, { content: "", events: [pending.terminalEvent] }, failure);
    }
    const fallbackBackendInput = workspaceBackendInput(run, this.clock, typeof input.content === "string" ? input.content : JSON.stringify(resumeInput), resumeInput);
    const preparedResume = this.ports.prepareResumeInput
      ? await this.ports.prepareResumeInput({ run, resumeInput })
      : { backendInput: fallbackBackendInput };
    try {
      const execution = await this.executor.resumeRun({
        run,
        backend,
        input: resumeInput,
        backendInput: preparedResume.backendInput,
        ...(preparedResume.gatewayBoundaryPolicy ? { gatewayBoundaryPolicy: preparedResume.gatewayBoundaryPolicy } : {})
      });
      if (execution.run.status === "waiting_for_backend_input") return execution.run;
      if (execution.terminalSettlement) {
        return this.settleWorkspaceRun(execution.terminalSettlement, { content: execution.text, events: execution.events });
      }
      const failure = workspaceRuntimeFailure("backend_terminal_missing", "Backend finished without a terminal result.");
      const pending = await this.prepareWorkspaceTerminal(execution.run, {
        kind: "indeterminate",
        reason: "runtime_state_unavailable",
        providerStarted: true,
        mayHaveSideEffects: true
      }, failure);
      return this.settleWorkspaceRun(pending, { content: execution.text, events: execution.events }, failure);
    } catch (error) {
      const current = await this.ports.store.getBackendRun(run.id) ?? run;
      if (isSettled(current)) return current;
      const failure = workspaceRuntimeFailure("backend_exception", error instanceof Error ? error.message : "Backend resume failed.");
      const pending = await this.prepareWorkspaceTerminal(current, {
        kind: "indeterminate",
        reason: "transport_lost",
        providerStarted: true,
        mayHaveSideEffects: true
      }, failure);
      return this.settleWorkspaceRun(pending, { content: "", events: [pending.terminalEvent] }, failure);
    }
  }

  private async syncWorkspaceRun(runId: string): Promise<BackendRunRecord> {
    const run = await this.ports.store.getBackendRun(runId);
    if (!run) throw new Error(`run_not_found:${runId}`);
    if (isSettled(run)) return run;
    await this.ports.assertRunAccess?.(run);
    const backend = this.registry.get(run.backend_id);
    if (!backend?.streamEvents) {
      const event = await this.journal.appendCanonicalEvent({
        runId: run.id,
        attemptNo: run.current_attempt ?? 1,
        eventType: "backend_stream_unavailable",
        payload: { reason: "stream_sync_unsupported", message: "Backend stream synchronization is unavailable.", run_status: run.status },
        sourceEventId: `workspace:sync-unavailable:${run.id}:${run.current_attempt ?? 1}`
      });
      if (!event.duplicate) await this.ports.committedEventPublisher.publish({ event: event.event, run });
      return run;
    }
    const execution = await this.executor.syncRun({ run, backend });
    if (!execution) return run;
    if (execution.run.status === "waiting_for_backend_input") return execution.run;
    if (!execution.terminalSettlement) return execution.run;
    return this.settleWorkspaceRun(execution.terminalSettlement, { content: execution.text, events: execution.events });
  }

  private async recoverWorkspaceRuns(): Promise<void> {
    const candidates = await this.ports.store.listCore02RecoveryCandidates();
    for (const run of candidates) {
      if (run.session_id || isSettled(run) || !run.room_id || !run.principal) continue;
      try {
        if (run.status === "queued") {
          await this.runWorkspaceExecution({
            context: {
              workspace_id: "workspace",
              room_id: run.room_id,
              principal: run.principal,
              source: run.source ?? { kind: "host" },
              correlation_id: run.request_idempotency_key ?? run.id,
              run_id: run.id,
              ...(run.session_ref ? { session_ref: run.session_ref } : {})
            },
            backend_id: run.backend_id,
            ...(run.agent_id ? { agent_id: run.agent_id } : {}),
            ...(run.input_summary ? { input_summary: run.input_summary } : {}),
            metadata: run.metadata
          });
        } else if (run.status === "running" || run.status === "waiting_for_backend_input") {
          await this.syncWorkspaceRun(run.id);
        }
      } catch (error) {
        await this.recordDiagnostic(run, "host_cleanup_failed", "workspace_recovery", error);
      }
    }
  }

  async cancelRun(runId: string): Promise<Awaited<ReturnType<RunControl["cancel"]>>> {
    const knownRun = await this.ports.store.getBackendRun(runId);
    if (knownRun && !knownRun.session_id) return this.cancelWorkspaceRun(runId);
    this.activeAbortControllers.get(runId)?.abort();
    let result: Awaited<ReturnType<RunControl["cancel"]>>;
    try {
      result = await this.control.cancel(runId);
    } finally {
      if (knownRun) await this.executor.cleanup({ runId: knownRun.id, sessionId: knownRun.session_id });
    }
    if (isSettled(result) && result.session_id) {
      this.activeRunSessions.delete(result.id);
      this.queue.releaseSession(result.session_id);
    }
    return result;
  }

  async resumeRun(runId: string, input: Record<string, unknown>): Promise<Awaited<ReturnType<RunControl["resume"]>>> {
    const run = await this.ports.store.getBackendRun(runId);
    if (run && !run.session_id) return this.resumeWorkspaceRun(runId, input);
    const lease = run?.session_id ? await this.queue.acquireControl(run.session_id) : undefined;
    let result: Awaited<ReturnType<RunControl["resume"]>>;
    try {
      result = await this.control.resume(runId, input);
    } catch (error) {
      lease?.restoreSuspended();
      throw error;
    } finally {
      if (run) await this.executor.cleanup({ runId: run.id, sessionId: run.session_id });
    }
    if (isSettled(result) && result.session_id) {
      this.activeRunSessions.delete(result.id);
      this.queue.releaseSession(result.session_id);
    }
    else if (result.status !== "waiting_for_backend_input") lease?.restoreSuspended();
    return result;
  }

  async syncRun(runId: string): Promise<Awaited<ReturnType<RunControl["sync"]>>> {
    const run = await this.ports.store.getBackendRun(runId);
    if (run && !run.session_id) return this.syncWorkspaceRun(runId);
    const lease = run?.session_id ? await this.queue.acquireControl(run.session_id) : undefined;
    let result: Awaited<ReturnType<RunControl["sync"]>>;
    try {
      result = await this.control.sync(runId);
    } catch (error) {
      lease?.restoreSuspended();
      throw error;
    } finally {
      if (run) await this.executor.cleanup({ runId: run.id, sessionId: run.session_id });
    }
    if (isSettled(result) && result.session_id) {
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

  private async executeRecoveredRun(run: BackendRunRecord): Promise<TurnOutcome> {
    requireSessionBoundRun(run);
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
        agentId: run.agent_id,
        roomId: session.room_id,
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
    requireSessionBoundRun(admitted.run);
    const sessionId = admitted.run.session_id;
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
      if (admitted.run.status === "waiting_for_backend_input") this.queue.markWaiting(sessionId, waitingExecutionFromEvents(events));
      return replayOutcome(admitted, events, messages.find((message) => message.id === admitted.run.output_message_id));
    }

    const controller = new AbortController();
    const abortListener = () => controller.abort();
    signal?.addEventListener("abort", abortListener, { once: true });
    this.activeAbortControllers.set(admitted.run.id, controller);
    this.activeRunSessions.set(admitted.run.id, sessionId);
    let run = admitted.run;
    let prepared: PreparedTurn | undefined;
    const events: BackendEventRecord[] = [];
    const textParts: string[] = [];
    let settlementStarted = false;
    try {
      run = await this.lifecycle.transition(this.ports.store, run, { type: "preparing" }) as BackendRunRecord & { session_id: string };
      requireSessionBoundRun(run);
      prepared = await this.preparer.prepare({ ...admitted, run }, controller.signal);
      const execution = await this.executor.execute(prepared, controller.signal);
      run = execution.run as BackendRunRecord & { session_id: string };
      requireSessionBoundRun(run);
      prepared = execution.prepared ?? { ...prepared, run };
      events.push(...execution.events);
      textParts.push(execution.text);
      if (run.status === "waiting_for_backend_input") {
        this.queue.markWaiting(sessionId, execution.waitingExecution ?? "live");
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
      await this.executor.cleanup({ runId: admitted.run.id, sessionId });
    }
  }

  private async prepareUnknown(run: BackendRunRecord): Promise<PreparedTerminalSettlement> {
    return this.prepareTerminal(run, { kind: "indeterminate", reason: "runtime_state_unavailable", providerStarted: true, mayHaveSideEffects: true }, { code: "backend_runtime_state_unavailable", message: "Backend finished without a terminal result.", retryable: false, causeCategory: "runtime" }, false);
  }

  private async prepareTerminal(run: BackendRunRecord, evidence: BackendTerminalEvidence, failure: BackendRuntimeFailure, requestedCancel: boolean): Promise<PreparedTerminalSettlement> {
    requireSessionBoundRun(run);
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
    const workspaceRuns = [...this.activeWorkspaceExecutions.keys()];
    await Promise.allSettled(workspaceRuns.map((runId) => this.cancelRun(runId)));
    await Promise.allSettled([...this.activeWorkspaceExecutions.values()]);
    await this.queue.drainAll();
  }
}

function requireSessionBoundRun(run: BackendRunRecord): asserts run is BackendRunRecord & { session_id: string } {
  if (!run.session_id) throw new Error(`session_bound_run_required:${run.id}`);
}

/** Native Chat compatibility creates metadata only; its Session never grants access. */
function workspaceExecutionRequestForTurn(request: TurnRequest): WorkspaceExecutionRequest {
  if (!request.roomId) throw new Error(`session_adapter_room_required:${request.sessionId}`);
  if (!request.requestedByParticipantId) throw new Error("session_adapter_requester_required");
  const principal = request.agentId
    ? { kind: "agent" as const, agent_id: request.agentId, requested_by_participant_id: request.requestedByParticipantId }
    : { kind: "human" as const, participant_id: request.requestedByParticipantId };
  return {
    context: {
      workspace_id: "workspace",
      room_id: request.roomId,
      principal,
      source: { kind: "native_app", app_id: "samurai-native" },
      correlation_id: request.idempotencyKey,
      session_ref: { app_id: "samurai-native", session_id: request.sessionId }
    },
    ...(request.backendId ? { backend_id: request.backendId } : {}),
    ...(request.agentId ? { agent_id: request.agentId } : {}),
    input_summary: request.content,
    metadata: request.metadata ?? {}
  };
}

function assertSessionAdapterContext(request: TurnRequest, context: import("@samurai-agent/core-schemas").TrustedWorkspaceContext): void {
  if (context.room_id !== request.roomId) throw new Error(`session_adapter_room_mismatch:${request.sessionId}`);
  if (context.session_ref?.app_id !== "samurai-native" || context.session_ref.session_id !== request.sessionId) {
    throw new Error(`session_adapter_reference_mismatch:${request.sessionId}`);
  }
  if (context.source.kind !== "native_app" || context.source.app_id !== "samurai-native") {
    throw new Error(`session_adapter_source_mismatch:${request.sessionId}`);
  }
}

function workspaceRuntimeFailure(code: string, message: string): BackendRuntimeFailure {
  return { code, message, retryable: false, causeCategory: "runtime" };
}

function workspaceOutcomeFromRun(run: BackendRunRecord, events: BackendEventRecord[], output?: TurnOutput): WorkspaceExecutionOutcome {
  if (run.status === "completed") {
    return { kind: "completed", run, output: output ?? { content: run.output_summary ?? "", events } };
  }
  if (run.status === "waiting_for_backend_input") {
    return { kind: "waiting", run, waiting: { prompt: run.output_summary ?? "Backend input required" } };
  }
  if (run.status === "cancelled") return { kind: "cancelled", run, reason: run.error_code ?? "cancelled" };
  if (run.status === "outcome_unknown") return { kind: "outcome_unknown", run, error: new Error(run.error_code ?? "outcome_unknown") };
  return { kind: "failed", run, error: new Error(run.error_code ?? "backend_failed") };
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
