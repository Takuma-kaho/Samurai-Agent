import type { WorkspaceRequestContext } from "@samurai-agent/workspace-server";
import type { WorkspaceShareImportWorkerPort } from "./workspace-worker-supervisor";

/**
 * A row claimed by the Share Import lane.  This is intentionally only the
 * server-owned import identity and target metadata.  A signed delegation is
 * never persisted in, or passed through, this worker contract.
 */
export interface WorkspaceShareImportClaim {
  importId: string;
  operationId: string;
  workspaceId: string;
  recipientAccountId: string;
  kind: "room_knowledge" | "agent";
  targetRoomId: string | null;
  leaseToken: string;
}

export type WorkspaceShareImportExecutionResult =
  | { status: "committed" }
  | { status: "retryable"; failureCode: string }
  | { status: "failed"; failureCode: string };

export type WorkspaceShareImportTargetCheck =
  | { allowed: true }
  | { allowed: false; failureCode?: string };

/**
 * Core/host adapter required by the process-owned worker.  The adapter owns
 * all SQL/RLS and must perform the following sequence inside `execute`:
 * re-resolve the persisted recipient/Room target, fetch through the configured
 * transport using a server-held short-lived capability, validate the manifest
 * and content hash, stage/rename files, and commit through the existing
 * transaction-aware Share committer.  The worker cannot complete an import
 * without this port, so a missing capability is an explicit failure rather
 * than a successful no-op.
 */
export interface WorkspaceShareImportCorePort {
  claim(input: {
    context: WorkspaceRequestContext;
    workerId: string;
    leaseMs: number;
    now: string;
    /** In-memory retry backoff. Durable rows remain staging; this only keeps
     * one worker tick from immediately reclaiming the same failed operation. */
    excludeOperationIds?: readonly string[];
    signal: AbortSignal;
  }): Promise<WorkspaceShareImportClaim | null>;

  /** Re-checks current target authorization using the persisted recipient. */
  recheckTarget(input: {
    claim: WorkspaceShareImportClaim;
    signal: AbortSignal;
  }): Promise<WorkspaceShareImportTargetCheck>;

  /**
   * Performs fetch, manifest/hash validation, file staging, and transactional
   * Completion/Agent commit.  It may return a retryable or terminal outcome;
   * it must not treat a missing server capability as committed.
   */
  execute(input: {
    claim: WorkspaceShareImportClaim;
    signal: AbortSignal;
    heartbeat(): Promise<void>;
  }): Promise<WorkspaceShareImportExecutionResult>;

  heartbeat(input: {
    claim: WorkspaceShareImportClaim;
    leaseMs: number;
    now: string;
  }): Promise<boolean>;

  /** Persists the terminal/retryable state and clears the lease. */
  settle(input: {
    claim: WorkspaceShareImportClaim;
    result: WorkspaceShareImportExecutionResult;
    now: string;
  }): Promise<void>;

  close?(): Promise<void>;
}

export interface WorkspaceShareImportWorkerOptions {
  core: WorkspaceShareImportCorePort;
  leaseMs?: number;
  heartbeatMs?: number;
  now?: () => Date;
}

export interface WorkspaceShareImportWorkerResult {
  claimed: number;
  completed: number;
  retried: number;
  failed: number;
  leaseLost: number;
}

/**
 * Claims and settles durable Share imports from the common Worker Supervisor.
 * This class owns only process lifecycle, bounded iteration, lease renewal,
 * and error classification.  Authorization, source fetch, file I/O, and
 * Completion/Agent writes remain in the injected Core adapter.
 */
export class PostgresWorkspaceShareImportWorker implements WorkspaceShareImportWorkerPort {
  private readonly leaseMs: number;
  private readonly heartbeatMs: number;
  private readonly now: () => Date;
  private readonly retryNotBefore = new Map<string, { attempt: number; at: number }>();
  private closed = false;

  constructor(private readonly options: WorkspaceShareImportWorkerOptions) {
    // Share import leases are intentionally short. Source capabilities are
    // process-local and must not survive a long lease after a worker crash.
    this.leaseMs = boundedDuration(options.leaseMs ?? 30_000, 5_000, 30_000);
    this.heartbeatMs = boundedDuration(options.heartbeatMs ?? 10_000, 1_000, Math.max(1_000, Math.floor(this.leaseMs / 2)));
    this.now = options.now ?? (() => new Date());
  }

  async runTick(
    context: WorkspaceRequestContext,
    input: { workerId: string; maxRuns: number; signal: AbortSignal }
  ): Promise<WorkspaceShareImportWorkerResult> {
    if (this.closed) throw new Error("workspace_share_import_worker_closed");
    const result: WorkspaceShareImportWorkerResult = { claimed: 0, completed: 0, retried: 0, failed: 0, leaseLost: 0 };
    if (input.signal.aborted) return result;

    const maxRuns = boundedInteger(input.maxRuns, 1, 100);
    const workerId = `${input.workerId}:share-import`;
    for (let index = 0; index < maxRuns; index += 1) {
      if (input.signal.aborted) break;
      const currentNow = this.now();
      const excludedOperationIds = this.blockedOperationIds(context, currentNow);
      const claim = await this.options.core.claim({
        context,
        workerId,
        leaseMs: this.leaseMs,
        now: currentNow.toISOString(),
        ...(excludedOperationIds.length > 0 ? { excludeOperationIds: excludedOperationIds } : {}),
        signal: input.signal
      });
      if (!claim) break;
      assertClaimMatchesContext(claim, context);
      result.claimed += 1;

      const leaseController = new AbortController();
      const signal = AbortSignal.any([input.signal, leaseController.signal]);
      let leaseLost = false;
      let heartbeatInFlight: Promise<void> | undefined;
      const heartbeat = async (): Promise<void> => {
        if (leaseLost) return;
        if (heartbeatInFlight) return heartbeatInFlight;
        heartbeatInFlight = this.options.core.heartbeat({
          claim,
          leaseMs: this.leaseMs,
          now: this.now().toISOString()
        }).then((renewed) => {
          if (!renewed) {
            leaseLost = true;
            leaseController.abort(new Error("workspace_share_import_lease_lost"));
          }
        }).catch(() => {
          leaseLost = true;
          leaseController.abort(new Error("workspace_share_import_lease_heartbeat_failed"));
        }).finally(() => {
          heartbeatInFlight = undefined;
        });
        await heartbeatInFlight;
      };
      const heartbeatTimer = setInterval(() => { void heartbeat(); }, this.heartbeatMs);
      heartbeatTimer.unref?.();

      let outcome: WorkspaceShareImportExecutionResult | undefined;
      try {
        await heartbeat();
        if (!leaseLost && !signal.aborted) {
          const target = await this.options.core.recheckTarget({ claim, signal });
          if (!target.allowed) {
            outcome = { status: "failed", failureCode: safeFailureCode(target.failureCode ?? "workspace_share_import_target_authorization_lost") };
          } else {
            outcome = await this.options.core.execute({ claim, signal, heartbeat });
            outcome = normalizeExecutionResult(outcome);
          }
        }
      } catch (error) {
        if (!input.signal.aborted && !leaseLost) {
          const failure = classifyFailure(error);
          outcome = { status: failure.retryable ? "retryable" : "failed", failureCode: failure.code };
        }
      } finally {
        clearInterval(heartbeatTimer);
        if (heartbeatInFlight) await heartbeatInFlight;
      }

      // A shutdown or a lost lease must not settle a result after another
      // worker may have taken ownership.  The durable lease expiry/recovery
      // path will make the row eligible again.
      if (!outcome || input.signal.aborted || leaseLost) {
        if (leaseLost) result.leaseLost += 1;
        continue;
      }
      let settledOutcome = outcome;
      if (outcome.status === "retryable") {
        if (outcome.failureCode === "authorization_refresh_required") {
          // A missing/expired process capability needs a newly signed
          // delegation; automatic retries must not hide that requirement.
          this.retryNotBefore.delete(retryKey(claim));
        } else if (this.scheduleRetry(claim, this.now()) >= 3) {
          // Keep the operation staging/retryable for an explicit resubmission,
          // but stop the worker from retrying forever after 2/5/15 seconds.
          settledOutcome = { status: "retryable", failureCode: "workspace_share_import_retry_exhausted" };
          this.retryNotBefore.delete(retryKey(claim));
        }
      }
      await this.options.core.settle({ claim, result: settledOutcome, now: this.now().toISOString() });
      if (settledOutcome.status === "committed") result.completed += 1;
      else if (settledOutcome.status === "retryable") {
        result.retried += 1;
        if (settledOutcome.failureCode === "workspace_share_import_retry_exhausted") {
          this.retryNotBefore.delete(retryKey(claim));
        }
      } else {
        result.failed += 1;
        this.retryNotBefore.delete(retryKey(claim));
      }
      if (settledOutcome.status === "committed") this.retryNotBefore.delete(retryKey(claim));
    }
    return result;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.options.core.close?.();
  }

  private blockedOperationIds(context: WorkspaceRequestContext, now: Date): string[] {
    const prefix = `${context.workspaceId}:`;
    const blocked: string[] = [];
    for (const [key, state] of this.retryNotBefore) {
      if (!key.startsWith(prefix)) continue;
      if (state.at > now.getTime()) {
        blocked.push(key.slice(prefix.length));
      }
    }
    return blocked;
  }

  private scheduleRetry(claim: WorkspaceShareImportClaim, now: Date): number {
    const key = retryKey(claim);
    const previousAttempt = this.retryNotBefore.get(key)?.attempt ?? 0;
    const attempt = previousAttempt + 1;
    const delay = attempt === 1 ? 2_000 : attempt === 2 ? 5_000 : 15_000;
    this.retryNotBefore.set(key, { attempt, at: now.getTime() + delay });
    return attempt;
  }
}

function retryKey(claim: WorkspaceShareImportClaim): string {
  return `${claim.workspaceId}:${claim.operationId}`;
}

function normalizeExecutionResult(value: WorkspaceShareImportExecutionResult): WorkspaceShareImportExecutionResult {
  if (!value || (value.status !== "committed" && value.status !== "retryable" && value.status !== "failed")) {
    throw new WorkspaceShareImportWorkerFailure("workspace_share_import_worker_result_invalid", false);
  }
  if (value.status === "committed") return value;
  return { ...value, failureCode: safeFailureCode(value.failureCode) };
}

function assertClaimMatchesContext(claim: WorkspaceShareImportClaim, context: WorkspaceRequestContext): void {
  if (claim.workspaceId !== context.workspaceId
    || !claim.importId.trim()
    || !claim.operationId.trim()
    || !claim.recipientAccountId.trim()
    || !claim.leaseToken.trim()
    || !["room_knowledge", "agent"].includes(claim.kind)
    || (claim.kind === "room_knowledge" && !claim.targetRoomId?.trim())
    || (claim.kind === "agent" && claim.targetRoomId !== null)) {
    throw new WorkspaceShareImportWorkerFailure("workspace_share_import_claim_invalid", false);
  }
}

function classifyFailure(error: unknown): { code: string; retryable: boolean } {
  const candidate = error as { code?: unknown; retryable?: unknown; status?: unknown };
  const code = safeFailureCode(typeof candidate.code === "string" ? candidate.code : "workspace_share_import_worker_failed");
  if (candidate.retryable === true) return { code, retryable: true };
  if (code === "authorization_refresh_required") return { code, retryable: true };
  if (typeof candidate.status === "number" && [408, 425, 429, 500, 502, 503, 504].includes(candidate.status)) {
    return { code, retryable: true };
  }
  if (/\b(?:timeout|temporar|unavailable|unreachable|transport|network|capability)\b/i.test(code)) {
    return { code, retryable: true };
  }
  return { code, retryable: false };
}

export class WorkspaceShareImportWorkerFailure extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, retryable: boolean) {
    super(safeFailureCode(code));
    this.name = "WorkspaceShareImportWorkerFailure";
    this.code = safeFailureCode(code);
    this.retryable = retryable;
  }
}

function safeFailureCode(value: string): string {
  return /^[a-z0-9][a-z0-9_.:-]{0,159}$/.test(value) ? value : "workspace_share_import_worker_failed";
}

function boundedDuration(value: number, minimum: number, maximum: number): number {
  return Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, Math.trunc(value))) : minimum;
}

function boundedInteger(value: number, minimum: number, maximum: number): number {
  return Number.isSafeInteger(value) ? Math.min(maximum, Math.max(minimum, value)) : minimum;
}
