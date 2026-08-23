import { describe, expect, it, vi } from "vitest";
import type { ExternalSendRecord } from "@samurai-agent/core-schemas";
import type { TrustedDomainContext } from "../../definition/index.js";
import externalSend from "./send.operation.js";
import externalSendDispatch from "./send/dispatch.operation.js";
import externalSendPrepare from "./send/prepare.operation.js";

const context: TrustedDomainContext = { inputSource: "runtime_api", workspaceId: "workspace_test", actorId: "actor_test", correlationId: "correlation_test" };
const session = { id: "session_1" } as never;
const envelope = { id: "envelope_1" } as never;
const operation = { id: "operation_1" } as never;
const now = "2026-01-01T00:00:00.000Z";

describe("External send operation handlers", () => {
  it("owns draft creation and rollback for prepare", async () => {
    const saveExternalSend = vi.fn(async (record: ExternalSendRecord) => record);
    const handler = externalSendPrepare.createHandler({
      ensureExternalSendSession: async () => session, createExternalSendEnvelope: () => envelope,
      createExternalSendId: () => "send_1", externalSendNow: () => now, saveExternalSend,
      createExternalSendRollback: async () => ({ id: "rollback_1" }) as never,
      runExternalSendMutation: async (input) => { const executed = await input.execute(operation); return { resource: executed.resource, operation, rollbackPoint: executed.rollbackPoint, activity: [] }; }
    });
    const input = externalSendPrepare.input.parse({ title: "Notice", body: "Body" });

    const result = await handler.execute(context, input);

    expect(saveExternalSend).toHaveBeenCalledWith(expect.objectContaining({ id: "send_1", channel: "webhook", status: "draft", operation_id: "operation_1" }));
    expect(result.value.resource.body).toBe("Body");
  });

  it("owns request defaults without dispatching", async () => {
    const saveExternalSend = vi.fn(async (record: ExternalSendRecord) => record);
    const handler = externalSend.createHandler({
      ensureExternalSendSession: async () => session, createExternalSendEnvelope: () => envelope,
      createExternalSendId: () => "send_2", externalSendNow: () => now, saveExternalSend,
      createExternalSendRollback: async () => ({ id: "rollback_1" }) as never,
      runExternalSendMutation: async (input) => { const executed = await input.execute(operation); return { resource: executed.resource, operation, rollbackPoint: executed.rollbackPoint, activity: [] }; }
    });

    const result = await handler.execute(context, externalSend.input.parse({ user_intent: "Notify owner" }));

    expect(result.value.resource).toMatchObject({ title: "External send request", body: "Notify owner", channel: "webhook", status: "draft" });
  });

  it("owns dry-run dispatch status and persistence", async () => {
    const existing: ExternalSendRecord = { id: "send_1", channel: "webhook", status: "approved", target: {}, title: "Notice", body: "Body", created_at: now, updated_at: now };
    const saveExternalSend = vi.fn(async (record: ExternalSendRecord) => record);
    const settleDispatch = vi.fn(async ({ record }: { record: ExternalSendRecord }) => record);
    const dispatchExternalSend = vi.fn(async () => ({ dispatched: false, adapter: "http", dry_run: true, message: "dry run" }));
    const handler = externalSendDispatch.createHandler({
      getExternalSend: async () => existing, saveExternalSend, dispatchExternalSend,
      claimDispatch: async () => ({ record: existing, claim_token: "claim_1" }),
      settleDispatch,
      markOutcomeUnknown: async () => ({ ...existing, status: "outcome_unknown" }),
      ensureExternalSendSession: async () => session, createExternalSendEnvelope: () => envelope,
      externalSendNow: () => now, externalSendDefaultDryRun: () => true,
      externalSendNotFound: () => new Error("external_send_not_found"),
      runExternalSendMutation: async (input) => { const executed = await input.execute(operation); return { resource: executed.resource, operation, activity: [] }; }
    });

    const result = await handler.execute(context, { send_id: existing.id });

    expect(dispatchExternalSend).toHaveBeenCalledWith(existing, true);
    expect(settleDispatch).toHaveBeenCalledWith(expect.objectContaining({ record: expect.objectContaining({ status: "approved", dispatch_result: expect.objectContaining({ dry_run: true }) }) }));
    expect(result.value.resource.status).toBe("approved");
  });

  it("does not dispatch a missing send", async () => {
    const dispatchExternalSend = vi.fn();
    const handler = externalSendDispatch.createHandler({
      getExternalSend: async () => undefined, saveExternalSend: async (record) => record, dispatchExternalSend,
      claimDispatch: async () => undefined,
      settleDispatch: async ({ record }) => record,
      markOutcomeUnknown: async () => { throw new Error("unexpected"); },
      ensureExternalSendSession: async () => session, createExternalSendEnvelope: () => envelope,
      externalSendNow: () => now, externalSendDefaultDryRun: () => true,
      externalSendNotFound: () => new Error("external_send_not_found"),
      runExternalSendMutation: async () => { throw new Error("unexpected"); }
    });

    await expect(handler.execute(context, { send_id: "missing" })).rejects.toThrow("external_send_not_found");
    expect(dispatchExternalSend).not.toHaveBeenCalled();
  });

  it("does not dispatch an already completed send", async () => {
    const existing: ExternalSendRecord = { id: "send_done", channel: "webhook", status: "dispatched", target: {}, title: "Notice", body: "Body", created_at: now, updated_at: now, dispatched_at: now };
    const dispatchExternalSend = vi.fn();
    const handler = externalSendDispatch.createHandler({
      getExternalSend: async () => existing, saveExternalSend: async (record) => record, dispatchExternalSend,
      claimDispatch: async () => { throw new Error("unexpected"); },
      settleDispatch: async ({ record }) => record,
      markOutcomeUnknown: async () => { throw new Error("unexpected"); },
      ensureExternalSendSession: async () => session, createExternalSendEnvelope: () => envelope,
      externalSendNow: () => now, externalSendDefaultDryRun: () => false,
      externalSendNotFound: () => new Error("external_send_not_found"),
      runExternalSendMutation: async () => { throw new Error("unexpected"); }
    });

    await expect(handler.execute(context, { send_id: existing.id })).rejects.toThrow("external_send_already_dispatched");
    expect(dispatchExternalSend).not.toHaveBeenCalled();
  });

  it.each(["draft", "pending_approval", "denied"] as const)("rejects %s before any dispatch", async (status) => {
    const existing: ExternalSendRecord = { id: "send_" + status, channel: "webhook", status, target: {}, title: "Notice", body: "Body", created_at: now, updated_at: now };
    const dispatchExternalSend = vi.fn();
    const handler = externalSendDispatch.createHandler({
      getExternalSend: async () => existing, saveExternalSend: async (record) => record, dispatchExternalSend,
      claimDispatch: async () => { throw new Error("unexpected"); },
      settleDispatch: async ({ record }) => record,
      markOutcomeUnknown: async () => { throw new Error("unexpected"); },
      ensureExternalSendSession: async () => session, createExternalSendEnvelope: () => envelope,
      externalSendNow: () => now, externalSendDefaultDryRun: () => true,
      externalSendNotFound: () => new Error("external_send_not_found"),
      runExternalSendMutation: async () => { throw new Error("unexpected"); }
    });

    await expect(handler.execute(context, { send_id: existing.id })).rejects.toThrow("external_send_approval_required");
    expect(dispatchExternalSend).not.toHaveBeenCalled();
  });

  it("allows only one concurrent claim for the same send", async () => {
    const existing: ExternalSendRecord = { id: "send_race", channel: "webhook", status: "approved", target: {}, title: "Notice", body: "Body", created_at: now, updated_at: now };
    let claimed = false;
    let calls = 0;
    const dispatchExternalSend = vi.fn(async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { dispatched: false, adapter: "fixture", dry_run: true, message: "dry run" };
    });
    const handler = externalSendDispatch.createHandler({
      getExternalSend: async () => existing, saveExternalSend: async (record) => record, dispatchExternalSend,
      claimDispatch: async () => {
        if (claimed) return undefined;
        claimed = true;
        return { record: existing, claim_token: "claim_race" };
      },
      settleDispatch: async ({ record }) => record,
      markOutcomeUnknown: async () => ({ ...existing, status: "outcome_unknown" }),
      ensureExternalSendSession: async () => session, createExternalSendEnvelope: () => envelope,
      externalSendNow: () => now, externalSendDefaultDryRun: () => true,
      externalSendNotFound: () => new Error("external_send_not_found"),
      runExternalSendMutation: async (input) => { const executed = await input.execute(operation); return { resource: executed.resource, operation, activity: [] }; }
    });

    const results = await Promise.allSettled([
      handler.execute(context, { send_id: existing.id, dry_run: true }),
      handler.execute(context, { send_id: existing.id, dry_run: true })
    ]);

    expect(calls).toBe(1);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  });

  it("settles a post-dispatch save failure as outcome_unknown and blocks retry", async () => {
    const existing: ExternalSendRecord = { id: "send_unknown", channel: "webhook", status: "approved", target: {}, title: "Notice", body: "Body", created_at: now, updated_at: now };
    let outcome: ExternalSendRecord = existing;
    let calls = 0;
    const dispatchExternalSend = vi.fn(async () => {
      calls += 1;
      return { dispatched: true, adapter: "fixture", dry_run: false, idempotency_guaranteed: true, message: "sent" };
    });
    const handler = externalSendDispatch.createHandler({
      getExternalSend: async () => outcome, saveExternalSend: async () => { throw new Error("settle_failed"); }, dispatchExternalSend,
      claimDispatch: async () => outcome.status === "approved" ? { record: outcome, claim_token: "claim_unknown" } : undefined,
      settleDispatch: async () => { throw new Error("settle_failed"); },
      markOutcomeUnknown: async () => { outcome = { ...outcome, status: "outcome_unknown" }; return outcome; },
      ensureExternalSendSession: async () => session, createExternalSendEnvelope: () => envelope,
      externalSendNow: () => now, externalSendDefaultDryRun: () => false,
      externalSendNotFound: () => new Error("external_send_not_found"),
      runExternalSendMutation: async (input) => input.execute(operation).then((executed) => ({ resource: executed.resource, operation, activity: [] }))
    });

    await expect(handler.execute(context, { send_id: existing.id, dry_run: false })).rejects.toMatchObject({ code: "outcome_unknown" });
    await expect(handler.execute(context, { send_id: existing.id, dry_run: false })).rejects.toThrow("external_send_outcome_unknown");
    expect(calls).toBe(1);
    expect(outcome.status).toBe("outcome_unknown");
  });
});
