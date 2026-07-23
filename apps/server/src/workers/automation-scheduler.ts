import { nowIso, redactPrivateData } from "@samurai-agent/core-schemas";

export interface AutomationRunner {
  runDueAutomationJobs(now?: string, context?: { signal?: AbortSignal; deadlineAt?: number }): Promise<unknown[]>;
}

export interface AutomationSchedulerState {
  enabled: boolean;
  interval_ms: number;
  started_at: string;
  running: boolean;
  tick_count: number;
  skipped_tick_count: number;
  last_tick_at?: string;
  last_success_at?: string;
  last_error?: string;
  last_run_count: number;
}

export interface AutomationScheduler {
  timer: NodeJS.Timeout;
  state: AutomationSchedulerState;
  tick: (now?: string, context?: { signal?: AbortSignal; deadlineAt?: number }) => Promise<unknown[]>;
  stop: (options?: { signal?: AbortSignal; deadlineAt?: number }) => Promise<void>;
}

export function startAutomationScheduler(runtime: AutomationRunner, env: NodeJS.ProcessEnv = process.env): AutomationScheduler | undefined {
  if (env.SAMURAI_AUTOMATION_SCHEDULER === "false") return undefined;
  const intervalMs = Number(env.SAMURAI_AUTOMATION_TICK_MS ?? 60_000);
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return undefined;
  const state: AutomationSchedulerState = { enabled: true, interval_ms: intervalMs, started_at: nowIso(), running: false, tick_count: 0, skipped_tick_count: 0, last_run_count: 0 };
  let stopping = false;
  let activeTick: Promise<unknown[]> | undefined;
  let activeTickController: AbortController | undefined;
  let stopPromise: Promise<void> | undefined;
  const tick: AutomationScheduler["tick"] = async (now = nowIso(), context = {}) => {
    if (stopping) return [];
    if (state.running) { state.skipped_tick_count += 1; return []; }
    state.running = true; state.last_tick_at = now;
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (context.signal?.aborted) controller.abort();
    else context.signal?.addEventListener("abort", abort, { once: true });
    activeTickController = controller;
    const run = runtime.runDueAutomationJobs(now, { signal: controller.signal, deadlineAt: context.deadlineAt });
    activeTick = run;
    try {
      const runs = await run;
      state.tick_count += 1; state.last_success_at = nowIso(); state.last_run_count = runs.length; state.last_error = undefined;
      return runs;
    } catch (error) {
      state.last_error = redactPrivateData(error instanceof Error ? error.message : String(error));
      console.warn("automation_scheduler_failed", state.last_error);
      throw error;
    } finally {
      state.running = false;
      context.signal?.removeEventListener("abort", abort);
      if (activeTick === run) activeTick = undefined;
      if (activeTickController === controller) activeTickController = undefined;
    }
  };
  const timer = setInterval(() => { void tick().catch(() => undefined); }, intervalMs);
  timer.unref?.();
  const stop: AutomationScheduler["stop"] = (options = {}): Promise<void> => {
    if (stopPromise) return stopPromise;
    stopping = true;
    state.enabled = false;
    clearInterval(timer);
    activeTickController?.abort();
    const attempt = (async () => {
      const running = activeTick;
      if (!running) return;
      const deadlineAt = options.deadlineAt ?? Date.now() + 10_000;
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const remaining = Math.max(0, deadlineAt - Date.now());
        let onAbort: () => void;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          options.signal?.removeEventListener("abort", onAbort);
          reject(new Error("automation_scheduler_shutdown_timeout"));
        }, remaining);
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          options.signal?.removeEventListener("abort", onAbort);
          resolve();
        };
        onAbort = () => {
          if (Date.now() < deadlineAt) return;
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          options.signal?.removeEventListener("abort", onAbort);
          reject(new Error("automation_scheduler_shutdown_aborted"));
        };
        options.signal?.addEventListener("abort", onAbort, { once: true });
        running.then(finish, finish);
      });
    })();
    stopPromise = attempt;
    void attempt.catch(() => {
      if (stopPromise === attempt) stopPromise = undefined;
    });
    return attempt;
  };
  return { timer, state, tick, stop };
}
