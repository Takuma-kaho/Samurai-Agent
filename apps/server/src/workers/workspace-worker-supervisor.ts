import { randomUUID } from "node:crypto";
import {
  assertOpaqueId,
  type WorkspaceCompletionReviewPort,
  type WorkspaceCompletionSemanticCuratorPort,
  type WorkspaceRequestContext
} from "@samurai-agent/workspace-server";

export type WorkspaceWorkerContext = Pick<WorkspaceRequestContext, "workspaceId" | "accountId">;

export type WorkspaceWorkerContextResolution =
  | { state: "enabled"; context: WorkspaceWorkerContext }
  | { state: "disabled"; reason: string };

export interface WorkspaceLearningRunnerPort {
  runCycle(context: WorkspaceWorkerContext, input?: { roomId?: string }, signal?: AbortSignal): Promise<unknown>;
  close(): Promise<void>;
}

export interface WorkspaceCompletionMaintenancePort {
  runTick(
    context: WorkspaceRequestContext,
    input: {
      workerId: string;
      reviewPort?: WorkspaceCompletionReviewPort;
      semanticPort?: WorkspaceCompletionSemanticCuratorPort;
      maxRuns?: number;
    }
  ): Promise<unknown>;
}

/** Process-owned durable lanes. Each lane is still responsible for its own
 * RLS, claim, lease, idempotency, and settlement rules; the supervisor only
 * controls when it is invoked and how shutdown propagates. */
export interface WorkspaceExecutionJobWorkerPort {
  runTick(context: WorkspaceRequestContext, input: { workerId: string; maxRuns: number; signal: AbortSignal }): Promise<unknown>;
  close?(): Promise<void>;
}

export interface WorkspaceAutomationSchedulerPort {
  runTick(context: WorkspaceRequestContext, input: { workerId: string; signal: AbortSignal }): Promise<unknown>;
  close?(): Promise<void>;
}

export interface WorkspaceClientEventQueuePort {
  runTick(context: WorkspaceRequestContext, input: { workerId: string; signal: AbortSignal }): Promise<unknown>;
  close?(): Promise<void>;
}

export interface WorkspaceGatewayMaintenancePort {
  runTick(context: WorkspaceRequestContext, input: { workerId: string; maxRuns: number; signal: AbortSignal }): Promise<unknown>;
  close?(): Promise<void>;
}

export interface WorkspaceSkillOptimizationWorkerPort {
  runTick(context: WorkspaceRequestContext, input: { workerId: string; maxRuns: number; signal: AbortSignal }): Promise<unknown>;
  close?(): Promise<void>;
}

export type WorkspaceWorkerSupervisorState = "starting" | "running" | "retrying" | "disabled" | "stopping" | "stopped";

export interface WorkspaceWorkerSupervisorStatus {
  state: WorkspaceWorkerSupervisorState;
  enabled: boolean;
  workspaceId?: string;
  accountId?: string;
  workspaceCount?: number;
  disabledReason?: string;
  stopReason?: string;
  startedAt?: string;
  stoppedAt?: string;
  lastTickAt?: string;
  lastSuccessfulTickAt?: string;
  nextRetryAt?: string;
  consecutiveFailures: number;
  lastError?: { code?: string; message: string; retryable: true };
  successfulTicks: number;
}

export interface WorkspaceWorkerSupervisorOptions {
  learningRunner: WorkspaceLearningRunnerPort;
  maintenance: WorkspaceCompletionMaintenancePort;
  resolveContext(signal: AbortSignal): Promise<WorkspaceWorkerContextResolution>;
  /** Optional hosted composition hook. Each returned identity is processed
   * through its own RLS-scoped Workspace context. */
  resolveContexts?(signal: AbortSignal): Promise<WorkspaceWorkerContextsResolution>;
  /** Hosted workers keep watching until an owner configures a maintenance
   * identity. Self-host keeps the historical fail-closed disabled state. */
  retryDisabledContext?: boolean;
  reviewPort?: WorkspaceCompletionReviewPort;
  semanticPort?: WorkspaceCompletionSemanticCuratorPort;
  workerId?: string;
  intervalMs?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  maxRuns?: number;
  executionJobWorker?: WorkspaceExecutionJobWorkerPort;
  automationScheduler?: WorkspaceAutomationSchedulerPort;
  clientEventQueue?: WorkspaceClientEventQueuePort;
  gatewayMaintenance?: WorkspaceGatewayMaintenancePort;
  skillOptimizationWorker?: WorkspaceSkillOptimizationWorkerPort;
  onError?(error: unknown): void;
}

export type WorkspaceWorkerContextsResolution =
  | { state: "enabled"; contexts: readonly WorkspaceWorkerContext[] }
  | { state: "disabled"; reason: string };

/**
 * Owns process lifecycle only. The two injected workers retain all DB, file,
 * authorization, and cassette boundaries; this class only supplies a fresh
 * request context to each tick and controls its timing.
 */
export class WorkspaceWorkerSupervisor {
  private readonly options: Required<Pick<WorkspaceWorkerSupervisorOptions, "workerId" | "intervalMs" | "retryBaseMs" | "retryMaxMs" | "maxRuns">> & WorkspaceWorkerSupervisorOptions;
  private current: WorkspaceWorkerSupervisorStatus = {
    state: "stopped",
    enabled: false,
    consecutiveFailures: 0,
    successfulTicks: 0
  };
  private controller?: AbortController;
  private startPromise?: Promise<WorkspaceWorkerSupervisorStatus>;
  private stopPromise?: Promise<void>;
  private permanentlyStopped = false;
  private timer?: ReturnType<typeof setTimeout>;
  private activeTick?: Promise<void>;
  private context?: WorkspaceWorkerContext;
  private contexts: WorkspaceWorkerContext[] = [];
  private externalAbortCleanup?: () => void;

  constructor(options: WorkspaceWorkerSupervisorOptions) {
    const workerId = options.workerId ?? `workspace_worker_${process.pid}`;
    assertOpaqueId(workerId, "workspace_worker_id_invalid");
    this.options = {
      ...options,
      workerId,
      intervalMs: boundedDuration(options.intervalMs ?? 30_000, 1_000, 86_400_000),
      retryBaseMs: boundedDuration(options.retryBaseMs ?? 1_000, 100, 86_400_000),
      retryMaxMs: boundedDuration(options.retryMaxMs ?? 60_000, 100, 86_400_000),
      maxRuns: boundedInteger(options.maxRuns ?? 100, 1, 100)
    };
  }

  status(): WorkspaceWorkerSupervisorStatus {
    return {
      ...this.current,
      ...(this.current.lastError ? { lastError: { ...this.current.lastError } } : {})
    };
  }

  start(signal?: AbortSignal): Promise<WorkspaceWorkerSupervisorStatus> {
    if (this.permanentlyStopped) return Promise.reject(new Error("workspace_worker_supervisor_closed"));
    if (this.startPromise) return this.startPromise;
    if (this.current.state !== "stopped") return Promise.resolve(this.status());
    if (signal?.aborted) {
      this.current = { ...this.current, state: "stopped", stopReason: "aborted_before_start", stoppedAt: now() };
      return Promise.resolve(this.status());
    }

    const controller = new AbortController();
    this.controller = controller;
    if (signal) {
      const abort = () => {
        controller.abort(signal.reason);
        void this.stop("aborted");
      };
      signal.addEventListener("abort", abort, { once: true });
      this.externalAbortCleanup = () => signal.removeEventListener("abort", abort);
    }
    this.current = { ...this.current, state: "starting", enabled: false, stopReason: undefined, stoppedAt: undefined };
    const promise = this.activate(controller.signal);
    this.startPromise = promise;
    return promise;
  }

  async stop(reason = "shutdown"): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.stopInternal(reason);
    return this.stopPromise;
  }

  private async activate(signal: AbortSignal): Promise<WorkspaceWorkerSupervisorStatus> {
    try {
      const resolved = await this.resolveWorkerContexts(signal);
      if (signal.aborted) {
        this.current = { ...this.current, state: "stopped", stopReason: "aborted_during_start", stoppedAt: now() };
        return this.status();
      }
      if (resolved.state === "disabled") {
        this.contexts = [];
        this.context = undefined;
        this.current = { ...this.current, state: "disabled", enabled: false, disabledReason: resolved.reason };
        if (this.options.retryDisabledContext) this.scheduleActivationRetry(signal);
        return this.status();
      }
      if (resolved.contexts.length === 0) {
        this.contexts = [];
        this.context = undefined;
        this.current = { ...this.current, state: "disabled", enabled: false, disabledReason: "worker_contexts_unconfigured" };
        if (this.options.retryDisabledContext) this.scheduleActivationRetry(signal);
        return this.status();
      }
      this.contexts = [...resolved.contexts];
      const firstContext = this.contexts[0]!;
      this.context = firstContext;
      this.current = {
        ...this.current,
        state: "running",
        enabled: true,
        workspaceId: firstContext.workspaceId,
        accountId: firstContext.accountId,
        workspaceCount: this.contexts.length,
        startedAt: now(),
        consecutiveFailures: 0
      };
      this.schedule(0);
      return this.status();
    } catch (error) {
      if (signal.aborted || this.current.state === "stopping") return this.status();
      this.recordFailure(error);
      this.notifyError(error);
      this.scheduleActivationRetry(signal);
      return this.status();
    }
  }

  private async stopInternal(reason: string): Promise<void> {
    if (this.current.state === "stopped") return;
    this.current = { ...this.current, state: "stopping", stopReason: reason, nextRetryAt: undefined };
    this.controller?.abort(new Error(`workspace_worker_${reason}`));
    this.clearTimer();
    this.externalAbortCleanup?.();
    this.externalAbortCleanup = undefined;

    const starting = this.startPromise;
    const activeTick = this.activeTick;
    const runnerClose = this.options.learningRunner.close();
    const executionClose = this.options.executionJobWorker?.close?.() ?? Promise.resolve();
    const automationClose = this.options.automationScheduler?.close?.() ?? Promise.resolve();
    const clientEventClose = this.options.clientEventQueue?.close?.() ?? Promise.resolve();
    const gatewayClose = this.options.gatewayMaintenance?.close?.() ?? Promise.resolve();
    const skillOptimizationClose = this.options.skillOptimizationWorker?.close?.() ?? Promise.resolve();
    const results = await Promise.allSettled([starting, activeTick, runnerClose, executionClose, automationClose, clientEventClose, gatewayClose, skillOptimizationClose]);
    const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    this.permanentlyStopped = true;
    this.current = {
      ...this.current,
      state: "stopped",
      enabled: false,
      stoppedAt: now(),
      ...(failure ? {
        stopReason: "shutdown_close_failed",
        lastError: {
          code: "workspace_worker_shutdown_failed",
          message: failure.reason instanceof Error ? failure.reason.message : String(failure.reason),
          retryable: true as const
        }
      } : {})
    };
    if (failure) this.notifyError(failure.reason);
  }

  private schedule(delayMs: number): void {
    if (this.timer || this.current.state === "stopping" || this.current.state === "stopped" || !this.context) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const tick = this.runScheduledTick();
      this.activeTick = tick;
      const clearActiveTick = () => {
        if (this.activeTick === tick) this.activeTick = undefined;
      };
      void tick.then(clearActiveTick, (error) => {
        this.notifyError(error);
        clearActiveTick();
      });
    }, delayMs);
  }

  private scheduleActivationRetry(signal: AbortSignal): void {
    if (this.timer || signal.aborted || this.current.state === "stopping" || this.current.state === "stopped") return;
    const exponent = Math.max(0, Math.min(this.current.consecutiveFailures - 1, 30));
    const delay = Math.min(this.options.retryMaxMs, this.options.retryBaseMs * 2 ** exponent);
    this.current = { ...this.current, nextRetryAt: new Date(Date.now() + delay).toISOString() };
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.activate(signal);
    }, delay);
  }

  private async runScheduledTick(): Promise<void> {
    if (!this.controller || this.contexts.length === 0 || this.controller.signal.aborted || this.current.state === "stopping") return;
    this.current = { ...this.current, lastTickAt: now(), nextRetryAt: undefined };
    try {
      for (const [index, workerContext] of this.contexts.entries()) {
        if (this.controller.signal.aborted) return;
        const operationId = `workspace_worker_tick_${randomUUID().replaceAll("-", "")}_${index}`;
        const context: WorkspaceRequestContext = { ...workerContext, operationId };
        if (this.options.executionJobWorker) {
          await this.options.executionJobWorker.runTick(context, {
            workerId: this.options.workerId,
            maxRuns: this.options.maxRuns,
            signal: this.controller.signal
          });
        }
        if (this.options.clientEventQueue) {
          await this.options.clientEventQueue.runTick(context, {
            workerId: this.options.workerId,
            signal: this.controller.signal
          });
        }
        if (this.options.gatewayMaintenance) {
          await this.options.gatewayMaintenance.runTick(context, {
            workerId: this.options.workerId,
            maxRuns: this.options.maxRuns,
            signal: this.controller.signal
          });
        }
        if (this.options.skillOptimizationWorker) {
          await this.options.skillOptimizationWorker.runTick(context, {
            workerId: this.options.workerId,
            maxRuns: this.options.maxRuns,
            signal: this.controller.signal
          });
        }
        await this.options.learningRunner.runCycle(workerContext, {}, this.controller.signal);
        if (this.controller.signal.aborted) return;
        await this.options.maintenance.runTick(context, {
          workerId: this.options.workerId,
          ...(this.options.reviewPort ? { reviewPort: this.options.reviewPort } : {}),
          ...(this.options.semanticPort ? { semanticPort: this.options.semanticPort } : {}),
          maxRuns: this.options.maxRuns
        });
        if (this.controller.signal.aborted) return;
        if (this.options.automationScheduler) {
          await this.options.automationScheduler.runTick(context, {
            workerId: this.options.workerId,
            signal: this.controller.signal
          });
        }
      }
      this.current = {
        ...this.current,
        state: "running",
        consecutiveFailures: 0,
        lastSuccessfulTickAt: now(),
        successfulTicks: this.current.successfulTicks + 1,
        lastError: undefined
      };
      this.schedule(this.options.intervalMs);
    } catch (error) {
      if (this.controller.signal.aborted || this.current.state === "stopping") return;
      this.recordFailure(error);
      this.notifyError(error);
      const exponent = Math.min(this.current.consecutiveFailures - 1, 30);
      const delay = Math.min(this.options.retryMaxMs, this.options.retryBaseMs * 2 ** exponent);
      this.current = { ...this.current, nextRetryAt: new Date(Date.now() + delay).toISOString() };
      this.schedule(delay);
    }
  }

  private async resolveWorkerContexts(signal: AbortSignal): Promise<WorkspaceWorkerContextsResolution> {
    if (this.options.resolveContexts) return this.options.resolveContexts(signal);
    const resolved = await this.options.resolveContext(signal);
    return resolved.state === "enabled"
      ? { state: "enabled", contexts: [resolved.context] }
      : resolved;
  }

  private recordFailure(error: unknown): void {
    const candidate = error as { code?: unknown; message?: unknown };
    this.current = {
      ...this.current,
      state: "retrying",
      consecutiveFailures: this.current.consecutiveFailures + 1,
      lastError: {
        ...(typeof candidate.code === "string" ? { code: candidate.code } : {}),
        message: typeof candidate.message === "string" ? candidate.message : String(error),
        retryable: true
      }
    };
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private notifyError(error: unknown): void {
    try {
      this.options.onError?.(error);
    } catch {
      // Error reporting must not create an unhandled rejection or affect the
      // retry and shutdown guarantees owned by this supervisor.
    }
  }
}

function boundedDuration(value: number, minimum: number, maximum: number): number {
  return Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, Math.trunc(value))) : minimum;
}

function boundedInteger(value: number, minimum: number, maximum: number): number {
  return Number.isSafeInteger(value) ? Math.min(maximum, Math.max(minimum, value)) : minimum;
}

function now(): string {
  return new Date().toISOString();
}
