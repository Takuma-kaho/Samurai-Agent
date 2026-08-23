export interface SessionRunQueueOptions {
  maxConcurrency?: number;
  controlWaitTimeoutMs?: number;
}

type Task<T> = { run: () => Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void; signal?: AbortSignal; sessionId: string; started: boolean; abortListener?: () => void };
type WaitingExecution = "live" | "suspended";

export interface SessionControlLease {
  readonly acquiredGlobalSlot: boolean;
  restoreSuspended(): void;
}

/** Process-local ordering only. Durable admission remains owned by the Store. */
export class SessionRunQueue {
  private readonly lanes = new Map<string, Task<unknown>[]>();
  private readonly activeSessions = new Set<string>();
  private readonly waitingSessions = new Map<string, WaitingExecution>();
  private active = 0;
  private closed = false;
  private readonly maxConcurrency: number;
  private readonly controlWaitTimeoutMs: number;

  constructor(options: SessionRunQueueOptions = {}) {
    this.maxConcurrency = Math.max(1, options.maxConcurrency ?? 4);
    this.controlWaitTimeoutMs = Number.isFinite(options.controlWaitTimeoutMs)
      ? Math.max(1, options.controlWaitTimeoutMs ?? 30_000)
      : 30_000;
  }

  enqueue<T>(sessionId: string, run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.closed) return Promise.reject(new Error("session_run_queue_closed"));
    if (signal?.aborted) return Promise.reject(abortError());
    return new Promise<T>((resolve, reject) => {
      const task: Task<T> = { run, resolve, reject, signal, sessionId, started: false };
      const abortListener = () => {
        if (task.started) return;
        const lane = this.lanes.get(sessionId);
        if (!lane) return;
        const index = lane.indexOf(task as Task<unknown>);
        if (index < 0) return;
        lane.splice(index, 1);
        if (lane.length === 0) this.lanes.delete(sessionId);
        task.abortListener = undefined;
        reject(abortError());
      };
      task.abortListener = abortListener;
      signal?.addEventListener("abort", abortListener, { once: true });
      const lane = this.lanes.get(sessionId) ?? [];
      lane.push(task as Task<unknown>);
      this.lanes.set(sessionId, lane);
      this.drain(sessionId);
    });
  }

  private drain(sessionId: string): void {
    if (this.closed || this.active >= this.maxConcurrency || this.activeSessions.has(sessionId)) return;
    const lane = this.lanes.get(sessionId);
    if (!lane?.length) {
      this.lanes.delete(sessionId);
      return;
    }
    const task = lane.shift()!;
    this.activeSessions.add(sessionId);
    this.active++;
    task.started = true;
    if (task.signal && task.abortListener) task.signal.removeEventListener("abort", task.abortListener);
    task.abortListener = undefined;
    if (task.signal?.aborted) {
      task.reject(abortError());
      this.finish(sessionId);
      return;
    }
    task.run().then(task.resolve, task.reject).finally(() => this.finish(sessionId));
  }

  private finish(sessionId: string): void {
    const waitingExecution = this.waitingSessions.get(sessionId);
    if (waitingExecution) {
      if (waitingExecution === "suspended") this.active = Math.max(0, this.active - 1);
      this.drainOtherSessions(sessionId);
      return;
    }
    this.activeSessions.delete(sessionId);
    this.active = Math.max(0, this.active - 1);
    this.drain(sessionId);
    this.drainOtherSessions(sessionId);
  }

  /** Keeps the durable Session lane occupied after a backend enters waiting. */
  markWaiting(sessionId: string, execution: WaitingExecution = "live"): void {
    if (!this.activeSessions.has(sessionId)) return;
    this.waitingSessions.set(sessionId, execution);
  }

  /** Releases a waiting lane after resume or cancel has settled the Run. */
  releaseSession(sessionId: string): void {
    const waitingExecution = this.waitingSessions.get(sessionId);
    if (!waitingExecution) return;
    this.waitingSessions.delete(sessionId);
    if (waitingExecution === "live") this.active = Math.max(0, this.active - 1);
    this.activeSessions.delete(sessionId);
    this.drain(sessionId);
    this.drainOtherSessions(sessionId);
  }

  releaseAllWaiting(): void {
    for (const sessionId of [...this.waitingSessions.keys()]) this.releaseSession(sessionId);
  }

  /**
   * A suspended waiting Run has released its global slot, but its direct
   * resume path still needs one before it calls the Backend. This waits only
   * for a global slot; it never joins the normal Session turn queue.
   */
  async acquireControl(sessionId: string, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<SessionControlLease> {
    if (this.waitingSessions.get(sessionId) !== "suspended") return { acquiredGlobalSlot: false, restoreSuspended: () => undefined };
    const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(1, options.timeoutMs ?? this.controlWaitTimeoutMs) : this.controlWaitTimeoutMs;
    const deadline = Date.now() + timeoutMs;
    while (!this.closed && this.waitingSessions.get(sessionId) === "suspended" && this.active >= this.maxConcurrency) {
      if (options.signal?.aborted) throw abortError();
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("session_run_queue_control_timeout");
      await waitForControlSlot(Math.min(25, remaining), options.signal);
    }
    if (this.closed) throw new Error("session_run_queue_closed");
    if (this.waitingSessions.get(sessionId) !== "suspended") return { acquiredGlobalSlot: false, restoreSuspended: () => undefined };
    this.active += 1;
    this.waitingSessions.set(sessionId, "live");
    let restored = false;
    return {
      acquiredGlobalSlot: true,
      restoreSuspended: () => {
        if (restored || this.waitingSessions.get(sessionId) !== "live") return;
        restored = true;
        this.waitingSessions.set(sessionId, "suspended");
        this.active = Math.max(0, this.active - 1);
        this.drainOtherSessions(sessionId);
      }
    };
  }

  private drainOtherSessions(excludedSessionId: string): void {
    for (const key of this.lanes.keys()) {
      if (key !== excludedSessionId) this.drain(key);
    }
  }

  async drainAll(): Promise<void> {
    while (this.active > 0 || [...this.lanes.values()].some((lane) => lane.length > 0)) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  /** Waits for queued work to leave the lanes without waiting for active Backend work. */
  async drainPending(): Promise<void> {
    while ([...this.lanes.values()].some((lane) => lane.length > 0)) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  close(): void {
    this.closed = true;
    for (const [sessionId, lane] of this.lanes) {
      for (const task of lane) {
        if (task.signal && task.abortListener) task.signal.removeEventListener("abort", task.abortListener);
        task.abortListener = undefined;
        task.reject(new Error("session_run_queue_closed"));
      }
      this.lanes.delete(sessionId);
    }
    this.releaseAllWaiting();
  }

  get activeCount(): number { return this.active; }
  get pendingCount(): number { return [...this.lanes.values()].reduce((sum, lane) => sum + lane.length, 0); }
}

function waitForControlSlot(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    };
    const onAbort = () => finish(abortError());
    const timer = setTimeout(() => finish(), delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortError(): Error {
  return typeof DOMException === "function" ? new DOMException("The operation was aborted", "AbortError") : Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
}
