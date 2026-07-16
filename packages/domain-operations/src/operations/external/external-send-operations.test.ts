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
    const existing: ExternalSendRecord = { id: "send_1", channel: "webhook", status: "draft", target: {}, title: "Notice", body: "Body", created_at: now, updated_at: now };
    const saveExternalSend = vi.fn(async (record: ExternalSendRecord) => record);
    const dispatchExternalSend = vi.fn(async () => ({ dispatched: false, adapter: "http", dry_run: true, message: "dry run" }));
    const handler = externalSendDispatch.createHandler({
      getExternalSend: async () => existing, saveExternalSend, dispatchExternalSend,
      ensureExternalSendSession: async () => session, createExternalSendEnvelope: () => envelope,
      externalSendNow: () => now, externalSendDefaultDryRun: () => true,
      externalSendNotFound: () => new Error("external_send_not_found"),
      runExternalSendMutation: async (input) => { const executed = await input.execute(operation); return { resource: executed.resource, operation, activity: [] }; }
    });

    const result = await handler.execute(context, { send_id: existing.id });

    expect(dispatchExternalSend).toHaveBeenCalledWith(existing, true);
    expect(saveExternalSend).toHaveBeenCalledWith(expect.objectContaining({ status: "approved", dispatch_result: expect.objectContaining({ dry_run: true }) }));
    expect(result.value.resource.status).toBe("approved");
  });

  it("does not dispatch a missing send", async () => {
    const dispatchExternalSend = vi.fn();
    const handler = externalSendDispatch.createHandler({
      getExternalSend: async () => undefined, saveExternalSend: async (record) => record, dispatchExternalSend,
      ensureExternalSendSession: async () => session, createExternalSendEnvelope: () => envelope,
      externalSendNow: () => now, externalSendDefaultDryRun: () => true,
      externalSendNotFound: () => new Error("external_send_not_found"),
      runExternalSendMutation: async () => { throw new Error("unexpected"); }
    });

    await expect(handler.execute(context, { send_id: "missing" })).rejects.toThrow("external_send_not_found");
    expect(dispatchExternalSend).not.toHaveBeenCalled();
  });
});
