import { nowIso, redactPrivateData } from "@samurai-agent/core-schemas";
import type { AgentRuntime } from "@samurai-agent/runtime";

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
  tick: (now?: string) => Promise<Awaited<ReturnType<AgentRuntime["runDueAutomationJobs"]>>>;
}

export function startAutomationScheduler(runtime: AgentRuntime, env: NodeJS.ProcessEnv = process.env): AutomationScheduler | undefined {
  if (env.SAMURAI_AUTOMATION_SCHEDULER === "false") return undefined;
  const intervalMs = Number(env.SAMURAI_AUTOMATION_TICK_MS ?? 60_000);
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return undefined;
  const state: AutomationSchedulerState = { enabled: true, interval_ms: intervalMs, started_at: nowIso(), running: false, tick_count: 0, skipped_tick_count: 0, last_run_count: 0 };
  const tick: AutomationScheduler["tick"] = async (now = nowIso()) => {
    if (state.running) { state.skipped_tick_count += 1; return []; }
    state.running = true; state.last_tick_at = now;
    try {
      const runs = await runtime.runDueAutomationJobs(now);
      state.tick_count += 1; state.last_success_at = nowIso(); state.last_run_count = runs.length; state.last_error = undefined;
      return runs;
    } catch (error) {
      state.last_error = redactPrivateData(error instanceof Error ? error.message : String(error));
      console.warn("automation_scheduler_failed", state.last_error);
      throw error;
    } finally { state.running = false; }
  };
  const timer = setInterval(() => { void tick().catch(() => undefined); }, intervalMs);
  timer.unref?.();
  return { timer, state, tick };
}
