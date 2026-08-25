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

export type ProcessRunnerEvent =
  | { kind: "aborted_before_start" }
  | { kind: "stdout"; chunk: string }
  | { kind: "stderr"; chunk: string }
  | { kind: "spawn_error"; message: string }
  | { kind: "process_error"; message: string }
  | { kind: "close"; exitCode: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; cancelled: boolean };

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
    env: { ...safeChildEnvironment(), ...explicitChildEnvironment(input.env) }
  });
  input.registerChild?.(child);

  let closed = false;
  let disposed = false;
  let spawnError: string | undefined;
  let stopRequested = false;
  let forceStopTimer: ReturnType<typeof setTimeout> | undefined;
  let abortListenerAttached = false;
  let wake: (() => void) | undefined;
  const queue: ProcessRunnerEvent[] = [];
  let settled = false;
  let stdout = "";
  let stderr = "";

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
    if (closed || child.pid === undefined) return;
    child.kill("SIGTERM");
    forceStopTimer = setTimeout(() => {
      if (!closed && child.pid !== undefined) child.kill("SIGKILL");
    }, input.stopGraceMs ?? 2_000);
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
    const cancelled = stopRequested || input.isCancelled?.() === true;
    releaseChild();
    enqueue({ kind: "close", exitCode, signal, stdout, stderr, cancelled });
    finish();
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
