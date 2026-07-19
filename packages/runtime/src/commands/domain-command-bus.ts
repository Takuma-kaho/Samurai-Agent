import {
  createId,
  nowIso,
  stableHash,
  type DomainCommandExecutionRecord,
  type JsonValue
} from "@samurai-agent/core-schemas";
import type { WorkspaceStore } from "@samurai-agent/workspace-store";

export interface DurableDomainCommandInput {
  commandId: string;
  contractVersion?: string;
  inputSource: string;
  correlationId?: string;
  payload: Record<string, JsonValue>;
  idempotencyKey?: string;
  workspaceId?: string;
  sessionId?: string;
  actorId?: string;
  executionClass?: "internal" | "external";
}

export type DomainCommandCheckpoint = "claimed" | "handler_started" | "handler_succeeded" | "result_saved" | "handler_failed";
export interface DomainCommandLifecycleObserver {
  checkpoint(name: DomainCommandCheckpoint, record: DomainCommandExecutionRecord): void | Promise<void>;
}

export class DomainCommandConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DomainCommandConflictError";
  }
}

export class DomainCommandIdempotencyKeyRequiredError extends Error {
  readonly code = "idempotency_key_required";
  constructor() {
    super("idempotency_key_required");
    this.name = "DomainCommandIdempotencyKeyRequiredError";
  }
}

export class DomainCommandOutcomeUnknownError extends DomainCommandConflictError {
  constructor(message: string) {
    super(message);
    this.name = "DomainCommandOutcomeUnknownError";
  }
}

export class DomainCommandReplayError extends Error {
  constructor(readonly code: string, message: string, readonly retryable: boolean, readonly details?: JsonValue) {
    super(message);
    this.name = "DomainCommandReplayError";
  }
}

export class DurableDomainCommandBus {
  private readonly inFlight = new Map<string, { payloadHash: string; promise: Promise<unknown> }>();

  constructor(
    private readonly store: WorkspaceStore,
    private readonly runningTimeoutMs = 30_000,
    private readonly observer?: DomainCommandLifecycleObserver
  ) {}

  async execute<TResult>(
    input: DurableDomainCommandInput,
    handler: () => Promise<TResult>
  ): Promise<TResult> {
    if (!input.idempotencyKey) throw new DomainCommandIdempotencyKeyRequiredError();

    const payloadHash = stableHash({
      command_id: input.commandId,
      contract_version: input.contractVersion ?? "unknown",
      workspace_id: input.workspaceId ?? null,
      session_id: input.sessionId ?? null,
      actor_id: input.actorId ?? null,
      payload: input.payload
    });
    const local = this.inFlight.get(input.idempotencyKey);
    if (local) {
      if (local.payloadHash !== payloadHash) {
        throw new DomainCommandConflictError(`idempotency_key_reused_with_different_payload:${input.idempotencyKey}`);
      }
      return await local.promise as TResult;
    }

    const execution = this.executeDurably(input, payloadHash, handler);
    this.inFlight.set(input.idempotencyKey, { payloadHash, promise: execution });
    try {
      return await execution as TResult;
    } finally {
      this.inFlight.delete(input.idempotencyKey);
    }
  }

  private async executeDurably<TResult>(
    input: DurableDomainCommandInput,
    payloadHash: string,
    handler: () => Promise<TResult>
  ): Promise<TResult> {
    const now = nowIso();
    const candidate: DomainCommandExecutionRecord = {
      id: createId("domain_command"),
      idempotency_key: input.idempotencyKey!,
      command_id: input.commandId,
      input_source: input.inputSource,
      correlation_id: input.correlationId ?? candidateCorrelationId(input),
      payload_hash: payloadHash,
      phase: "claimed",
      status: "running",
      heartbeat_at: now,
      created_at: now,
      updated_at: now
    };
    const claim = await this.store.claimDomainCommandExecution(candidate);
    if (!claim.claimed) {
      return this.resolveExisting(input, payloadHash, claim.record, handler);
    }

    await this.observer?.checkpoint("claimed", candidate);
    const running = { ...candidate, phase: input.executionClass === "external" ? "external_running" as const : "internal_running" as const, heartbeat_at: nowIso(), updated_at: nowIso() };
    await this.store.updateDomainCommandExecution(running);
    return this.runClaimed(running, handler);
  }

  private async runClaimed<TResult>(candidate: DomainCommandExecutionRecord, handler: () => Promise<TResult>): Promise<TResult> {
    const heartbeat = setInterval(() => {
      void this.store.heartbeatDomainCommandExecution(candidate.id, nowIso());
    }, Math.max(1_000, Math.floor(this.runningTimeoutMs / 3)));
    heartbeat.unref?.();
    try {
      await this.observer?.checkpoint("handler_started", candidate);
      const result = await handler();
      clearInterval(heartbeat);
      await this.observer?.checkpoint("handler_succeeded", candidate);
      const completed = await this.store.updateDomainCommandExecution({
        ...candidate,
        status: "completed",
        result: toJsonValue(result),
        heartbeat_at: nowIso(),
        updated_at: nowIso()
      });
      await this.observer?.checkpoint("result_saved", completed);
      return result;
    } catch (error) {
      clearInterval(heartbeat);
      const failed = await this.store.updateDomainCommandExecution({
        ...candidate,
        status: "failed",
        error: domainExecutionError(error),
        heartbeat_at: nowIso(),
        updated_at: nowIso()
      });
      await this.observer?.checkpoint("handler_failed", failed);
      throw error;
    }
  }

  private async resolveExisting<TResult>(
    input: DurableDomainCommandInput,
    payloadHash: string,
    initial: DomainCommandExecutionRecord,
    handler: () => Promise<TResult>
  ): Promise<TResult> {
    if (initial.command_id !== input.commandId || initial.payload_hash !== payloadHash) {
      throw new DomainCommandConflictError(`idempotency_key_reused_with_different_payload:${input.idempotencyKey}`);
    }
    if (initial.status === "outcome_unknown") {
      throw new DomainCommandOutcomeUnknownError(`domain_command_outcome_unknown:${input.idempotencyKey}`);
    }
    let current = initial;
    while (current.status === "running") {
      const heartbeatAt = Date.parse(current.heartbeat_at ?? current.updated_at ?? current.created_at);
      // An invalid persisted timestamp cannot establish a safe running window.
      // Treat it as stale immediately instead of extending the deadline on
      // every polling iteration and potentially waiting forever.
      const staleAt = Number.isFinite(heartbeatAt)
        ? heartbeatAt + this.runningTimeoutMs
        : Date.now();
      const remaining = staleAt - Date.now();
      if (remaining <= 0) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(25, remaining)));
      current = await this.store.getDomainCommandExecution(input.idempotencyKey!) ?? current;
    }
    if (current.status === "completed" && current.result !== undefined) {
      return current.result as TResult;
    }
    if (current.status === "failed") {
      throw replayFailure(current, input.idempotencyKey!);
    }
    if (current.phase === "external_running") {
      const unknown: DomainCommandExecutionRecord = {
        ...current,
        status: "outcome_unknown",
        heartbeat_at: current.heartbeat_at,
        updated_at: nowIso()
      };
      const changed = await this.store.compareAndSetDomainCommandExecution({
        id: current.id,
        expectedStatus: "running",
        expectedHeartbeatAt: current.heartbeat_at,
        next: unknown
      });
      if (!changed) {
        const latest = await this.store.getDomainCommandExecution(input.idempotencyKey!);
        if (!latest) throw new DomainCommandConflictError(`domain_command_execution_missing:${input.idempotencyKey}`);
        return this.resolveExisting(input, payloadHash, latest, handler);
      }
      throw new DomainCommandOutcomeUnknownError(`domain_command_outcome_unknown:${input.idempotencyKey}`);
    }
    const reclaimed = {
      ...current,
      phase: input.executionClass === "external" ? "external_running" as const : "internal_running" as const,
      heartbeat_at: nowIso(),
      updated_at: nowIso()
    };
    const reclaimedClaim = await this.store.compareAndSetDomainCommandExecution({
      id: current.id,
      expectedStatus: "running",
      expectedHeartbeatAt: current.heartbeat_at,
      next: reclaimed
    });
    if (reclaimedClaim) return this.runClaimed(reclaimed, handler);
    const latest = await this.store.getDomainCommandExecution(input.idempotencyKey!);
    if (!latest) throw new DomainCommandConflictError(`domain_command_execution_missing:${input.idempotencyKey}`);
    return this.resolveExisting(input, payloadHash, latest, handler);
  }
}

function candidateCorrelationId(input: DurableDomainCommandInput): string {
  return stableHash({ command_id: input.commandId, idempotency_key: input.idempotencyKey!, input_source: input.inputSource });
}

function domainExecutionError(error: unknown): { code: string; message: string; retryable: boolean; details?: JsonValue } {
  if (error && typeof error === "object") {
    const value = error as { code?: unknown; message?: unknown; retryable?: unknown; details?: unknown };
    return {
      code: typeof value.code === "string" ? value.code : "domain_command_failed",
      message: typeof value.message === "string" ? value.message : String(error),
      retryable: value.retryable === true,
      ...(value.details !== undefined ? { details: toJsonValue(value.details) } : {})
    };
  }
  return { code: "domain_command_failed", message: String(error), retryable: false };
}

function replayFailure(record: DomainCommandExecutionRecord, key: string): DomainCommandReplayError {
  const error = record.error ?? { code: "domain_command_failed", message: `domain_command_failed:${key}`, retryable: false };
  return new DomainCommandReplayError(error.code, error.message, error.retryable, error.details);
}

function toJsonValue(value: unknown): JsonValue {
  if (value === undefined) {
    return null;
  }
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
