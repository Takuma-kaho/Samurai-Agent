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
  inputSource: string;
  payload: Record<string, JsonValue>;
  idempotencyKey?: string;
}

export class DomainCommandConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DomainCommandConflictError";
  }
}

export class DurableDomainCommandBus {
  private readonly inFlight = new Map<string, { payloadHash: string; promise: Promise<unknown> }>();

  constructor(private readonly store: WorkspaceStore) {}

  async execute<TResult>(
    input: DurableDomainCommandInput,
    handler: () => Promise<TResult>
  ): Promise<TResult> {
    if (!input.idempotencyKey) {
      return handler();
    }

    const payloadHash = stableHash({ command_id: input.commandId, payload: input.payload });
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
      payload_hash: payloadHash,
      status: "running",
      created_at: now,
      updated_at: now
    };
    const claim = await this.store.claimDomainCommandExecution(candidate);
    if (!claim.claimed) {
      return this.resolveExisting(input, payloadHash, claim.record);
    }

    try {
      const result = await handler();
      await this.store.updateDomainCommandExecution({
        ...candidate,
        status: "completed",
        result: toJsonValue(result),
        updated_at: nowIso()
      });
      return result;
    } catch (error) {
      await this.store.updateDomainCommandExecution({
        ...candidate,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
        updated_at: nowIso()
      });
      throw error;
    }
  }

  private async resolveExisting<TResult>(
    input: DurableDomainCommandInput,
    payloadHash: string,
    initial: DomainCommandExecutionRecord
  ): Promise<TResult> {
    if (initial.command_id !== input.commandId || initial.payload_hash !== payloadHash) {
      throw new DomainCommandConflictError(`idempotency_key_reused_with_different_payload:${input.idempotencyKey}`);
    }
    let current = initial;
    const deadline = Date.now() + 30_000;
    while (current.status === "running" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      current = await this.store.getDomainCommandExecution(input.idempotencyKey!) ?? current;
    }
    if (current.status === "completed" && current.result !== undefined) {
      return current.result as TResult;
    }
    if (current.status === "failed") {
      throw new Error(current.error ?? `domain_command_failed:${input.idempotencyKey}`);
    }
    throw new DomainCommandConflictError(`domain_command_still_running:${input.idempotencyKey}`);
  }
}

function toJsonValue(value: unknown): JsonValue {
  if (value === undefined) {
    return null;
  }
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
