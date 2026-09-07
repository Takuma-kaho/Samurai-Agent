import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

const inheritedChildEnvironmentKeys = [
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "WINDIR",
  "ComSpec",
  "TMP",
  "TEMP",
  "SHELL",
  "TERM",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LC_LANG",
  "TMPDIR"
] as const;

const blockedChildEnvironmentKeys = new Set([
  "HOME",
  "USERPROFILE",
  "SSH_AUTH_SOCK",
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "XDG_RUNTIME_DIR",
  "DISPLAY",
  "WAYLAND_DISPLAY"
]);

/**
 * External providers are untrusted child processes. Keep only process
 * plumbing inherited from the host; credentials and application-specific
 * values must be passed explicitly through ProcessRunnerInput.env.
 */
export function safeChildEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(
    inheritedChildEnvironmentKeys.flatMap((key) => source[key] === undefined ? [] : [[key, source[key]]])
  );
}

function explicitChildEnvironment(source: Record<string, string> | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(source ?? {}).filter(([key]) => !blockedChildEnvironmentKeys.has(key)));
}

export type ProcessStopMethod = "process_group" | "process_tree" | "single_process";

/** Evidence that a stop signal was (or was not) dispatched. */
export interface ProcessStopDispatch {
  status: "not_requested" | "sent" | "unsupported" | "failed";
  method?: ProcessStopMethod;
  signal?: NodeJS.Signals;
  reason?: string;
}

/** Evidence that the owned process scope reached a terminal state. */
export interface ProcessStopConfirmation {
  status: "not_requested" | "confirmed" | "unconfirmed";
  method?: ProcessStopMethod;
  signal?: NodeJS.Signals;
  reason?: string;
}

export interface ProcessRunnerInput {
  command: string;
  args: string[];
  input: string;
  env?: Record<string, string>;
  cwd?: string;
  abortSignal?: AbortSignal;
  registerChild?: (child: ChildProcessWithoutNullStreams) => void;
  markChildCancelled?: (child: ChildProcessWithoutNullStreams) => void;
  isCancelled?: () => boolean;
  unregisterChild?: (child: ChildProcessWithoutNullStreams) => void;
  stopGraceMs?: number;
}

function normalizedStopGraceMs(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) ? Math.max(0, value) : 2_000;
}

export type ProcessRunnerEvent =
  | { kind: "aborted_before_start" }
  | { kind: "stdout"; chunk: string }
  | { kind: "stderr"; chunk: string }
  | { kind: "spawn_error"; message: string }
  | { kind: "process_error"; message: string }
  | {
      kind: "close";
      exitCode: number | null;
      signal: NodeJS.Signals | null;
      stdout: string;
      stderr: string;
      /** Compatibility marker: true means a stop was requested, not confirmed. */
      cancelled: boolean;
      stop_requested: boolean;
      stop_dispatch: ProcessStopDispatch;
      stop_confirmation: ProcessStopConfirmation;
    };

/**
 * Provider-neutral child-process boundary. It only owns process lifecycle and
 * raw streams; it never creates a Samurai BackendOutputEvent.
 */
export async function* runProcess(input: ProcessRunnerInput): AsyncIterable<ProcessRunnerEvent> {
  if (input.abortSignal?.aborted) {
    yield { kind: "aborted_before_start" };
    return;
  }

  const child = spawn(input.command, input.args, {
    cwd: input.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...safeChildEnvironment(), ...explicitChildEnvironment(input.env) },
    // A detached POSIX child gets its own process group.  This lets the
    // cancellation path address the CLI and the tools it spawned together.
    detached: process.platform !== "win32",
    ...(process.platform === "win32" ? { windowsHide: true } : {})
  });
  input.registerChild?.(child);

  let closed = false;
  let disposed = false;
  let spawnError: string | undefined;
  let stopRequested = false;
  let forceStopTimer: ReturnType<typeof setTimeout> | undefined;
  let stopOnSpawnAttached = false;
  let stopDispatch: ProcessStopDispatch = { status: "not_requested" };
  const stopDispatches: Array<Promise<ProcessStopDispatch>> = [];
  let abortListenerAttached = false;
  let wake: (() => void) | undefined;
  const queue: ProcessRunnerEvent[] = [];
  let settled = false;
  let stdout = "";
  let stderr = "";
  const stopGraceMs = normalizedStopGraceMs(input.stopGraceMs);

  const enqueue = (event: ProcessRunnerEvent) => {
    if (disposed) return;
    queue.push(event);
    wake?.();
    wake = undefined;
  };
  const removeAbortListener = () => {
    if (!abortListenerAttached || !input.abortSignal) return;
    input.abortSignal.removeEventListener("abort", handleAbort);
    abortListenerAttached = false;
  };
  const requestStop = () => {
    if (stopRequested) return;
    stopRequested = true;
    input.markChildCancelled?.(child);
    if (closed) {
      stopDispatch = {
        status: "unsupported",
        signal: "SIGTERM",
        reason: "process_not_running"
      };
      return;
    }
    if (child.pid === undefined) {
      stopDispatch = {
        status: "unsupported",
        signal: "SIGTERM",
        reason: "process_spawn_pending"
      };
      if (!stopOnSpawnAttached) {
        stopOnSpawnAttached = true;
        child.once("spawn", () => {
          if (closed || !stopRequested || child.pid === undefined) return;
          dispatchStopSignal("SIGTERM");
          forceStopTimer = setTimeout(() => {
            if (!closed && child.pid !== undefined) dispatchStopSignal("SIGKILL");
          }, stopGraceMs);
        });
      }
      return;
    }
    dispatchStopSignal("SIGTERM");
    forceStopTimer = setTimeout(() => {
      if (!closed && child.pid !== undefined) dispatchStopSignal("SIGKILL");
    }, stopGraceMs);
  };
  const dispatchStopSignal = (signal: NodeJS.Signals): void => {
    const dispatched = stopChildTree(child, signal);
    stopDispatches.push(dispatched);
    void dispatched.then((result) => {
      // Preserve the last successful dispatch.  A failed force escalation
      // must not hide a previously successful graceful request.
      if (result.status === "sent" || stopDispatch.status !== "sent") stopDispatch = result;
    });
  };
  const settledStopDispatch = async (): Promise<ProcessStopDispatch> => {
    if (stopDispatches.length === 0) return stopDispatch;
    const results = await Promise.all(stopDispatches);
    const successful = results.filter((result) => result.status === "sent");
    return successful.at(-1) ?? results.at(-1) ?? stopDispatch;
  };
  const handleAbort = () => requestStop();
  const releaseChild = () => {
    if (forceStopTimer) clearTimeout(forceStopTimer);
    removeAbortListener();
    input.unregisterChild?.(child);
  };
  const finish = () => {
    if (settled) return;
    settled = true;
    wake?.();
    wake = undefined;
  };

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    if (disposed) return;
    stdout += chunk;
    enqueue({ kind: "stdout", chunk });
  });
  child.stderr.on("data", (chunk: string) => {
    if (disposed) return;
    stderr += chunk;
    enqueue({ kind: "stderr", chunk });
  });
  child.stdin.once("error", (error) => {
    // A child can close stdin after spawn but before the input write drains.
    // EPIPE is not terminal evidence; the process close event remains canonical.
    if ("code" in error && error.code === "EPIPE") return;
    enqueue({ kind: "process_error", message: error.message });
  });
  child.once("error", (error) => {
    if (child.pid === undefined) {
      spawnError = error.message;
      enqueue({ kind: "spawn_error", message: error.message });
    } else {
      enqueue({ kind: "process_error", message: error.message });
    }
  });
  child.once("close", (exitCode, signal) => {
    closed = true;
    const finishClose = async () => {
      if (stopRequested) {
        let dispatch = await settledStopDispatch();
        let confirmation = await confirmProcessStop(child.pid, dispatch, stopGraceMs);
        // The process-group leader may close while a child tool is still
        // alive.  Escalate the same owned scope before reporting confirmation.
        if (confirmation.status === "unconfirmed" && dispatch.status === "sent" && dispatch.method === "process_group" && child.pid !== undefined) {
          dispatchStopSignal("SIGKILL");
          dispatch = await settledStopDispatch();
          confirmation = await confirmProcessStop(child.pid, dispatch, stopGraceMs);
        }
        releaseChild();
        enqueue({
          kind: "close",
          exitCode,
          signal,
          stdout,
          stderr,
          cancelled: stopRequested || input.isCancelled?.() === true,
          stop_requested: true,
          stop_dispatch: dispatch,
          stop_confirmation: confirmation
        });
      } else {
        releaseChild();
        enqueue({
          kind: "close",
          exitCode,
          signal,
          stdout,
          stderr,
          cancelled: false,
          stop_requested: false,
          stop_dispatch: { status: "not_requested" },
          stop_confirmation: { status: "not_requested" }
        });
      }
      finish();
    };
    void finishClose();
  });
  if (input.abortSignal) {
    input.abortSignal.addEventListener("abort", handleAbort, { once: true });
    abortListenerAttached = true;
    if (input.abortSignal.aborted) handleAbort();
  }

  try {
    try {
      child.stdin.end(input.input);
    } catch {
      // The process close/error event remains the source of final evidence.
    }

    while (!settled || queue.length > 0) {
      if (queue.length === 0) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        continue;
      }
      const event = queue.shift();
      if (event) yield event;
    }
  } finally {
    disposed = true;
    removeAbortListener();
    wake?.();
    wake = undefined;
    if (!closed) requestStop();
    if (!closed) {
      child.stdout.resume();
      child.stderr.resume();
    } else {
      child.removeAllListeners();
    }
    // Keep the variable observable in debugging without leaking raw process
    // errors into the canonical event stream.
    void spawnError;
  }
}

function stopChildTree(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): Promise<ProcessStopDispatch> {
  if (child.pid === undefined || child.pid <= 0) {
    return Promise.resolve({ status: "unsupported", signal, reason: "process_not_running" });
  }

  if (process.platform === "win32") {
    return new Promise((resolve) => {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", ...(signal === "SIGKILL" ? ["/f"] : [])], {
        env: safeChildEnvironment(),
        stdio: "ignore",
        windowsHide: true
      });
      killer.once("error", () => resolve({ status: "failed", method: "process_tree", signal, reason: "taskkill_unavailable" }));
      killer.once("close", (exitCode) => resolve(exitCode === 0
        ? { status: "sent", method: "process_tree", signal }
        : { status: "failed", method: "process_tree", signal, reason: "taskkill_failed" }));
    });
  }

  try {
    process.kill(-child.pid, signal);
    return Promise.resolve({ status: "sent", method: "process_group", signal });
  } catch {
    // Keep a best-effort single-process fallback, but the confirmation path
    // deliberately refuses to call it a process-tree stop.
    try {
      if (child.kill(signal)) {
        return Promise.resolve({ status: "sent", method: "single_process", signal, reason: "process_group_unavailable" });
      }
    } catch {
      // The process may have exited between the group and child attempts.
    }
    return Promise.resolve({ status: "failed", method: "process_group", signal, reason: "process_group_signal_failed" });
  }
}

async function confirmProcessStop(
  pid: number | undefined,
  dispatch: ProcessStopDispatch,
  timeoutMs: number
): Promise<ProcessStopConfirmation> {
  if (dispatch.status !== "sent" || !dispatch.method || !dispatch.signal) {
    return {
      status: "unconfirmed",
      ...(dispatch.method ? { method: dispatch.method } : {}),
      ...(dispatch.signal ? { signal: dispatch.signal } : {}),
      reason: dispatch.status === "unsupported" ? "stop_scope_unsupported" : "stop_dispatch_failed"
    };
  }
  if (dispatch.method === "single_process") {
    return { status: "unconfirmed", method: dispatch.method, signal: dispatch.signal, reason: "process_group_unavailable" };
  }
  if (dispatch.method === "process_tree") {
    return { status: "confirmed", method: dispatch.method, signal: dispatch.signal };
  }
  if (pid === undefined || pid <= 0) {
    return { status: "unconfirmed", method: dispatch.method, signal: dispatch.signal, reason: "process_not_running" };
  }
  const stopped = await waitForProcessGroupExit(pid, timeoutMs);
  return stopped
    ? { status: "confirmed", method: dispatch.method, signal: dispatch.signal }
    : { status: "unconfirmed", method: dispatch.method, signal: dispatch.signal, reason: "process_group_still_running" };
}

async function waitForProcessGroupExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (true) {
    if (!isProcessGroupAlive(pid)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(25, Math.max(1, deadline - Date.now()))));
  }
}

function isProcessGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code !== "ESRCH";
  }
}
