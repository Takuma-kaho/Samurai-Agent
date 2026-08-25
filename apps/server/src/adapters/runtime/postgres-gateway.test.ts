import { describe, expect, it } from "vitest";
import { GatewayDomainService } from "../../../../../packages/runtime/src/commands/services/gateway-domain-service.js";
import { sessionKeyForExternalSource } from "@samurai-agent/gateway";
import type { RunChatTurnResult } from "@samurai-agent/runtime";
import {
  type GatewayDeliveryRecord,
  type GatewayPairingRecord,
  type GatewaySandboxInstanceRecord
} from "@samurai-agent/core-schemas";
import { PostgresGatewayAdapter, type PostgresGatewayDatabase } from "./postgres-gateway.js";

type QueryCall = { text: string; values: readonly unknown[] };
type QueryHandler = (text: string, values: readonly unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

function database(handler: QueryHandler): { db: PostgresGatewayDatabase; calls: QueryCall[]; contexts: Array<{ workspaceId: string; accountId: string }> } {
  const calls: QueryCall[] = [];
  const contexts: Array<{ workspaceId: string; accountId: string }> = [];
  return {
    db: {
      withContext: async (context, action) => {
        contexts.push(context);
        return action({
          query: async (text, values = []) => {
            calls.push({ text, values });
            return handler(text, values);
          }
        });
      }
    },
    calls,
    contexts
  };
}

function pairing(): GatewayPairingRecord {
  return {
    id: "pairing-1",
    channel: "webhook",
    source_identity: "contact-1",
    source_label: "Contact 1",
    status: "approved",
    session_key: sessionKeyForExternalSource({ channel: "webhook", source_identity: "contact-1" }),
    metadata: {},
    requested_at: "2026-08-22T00:00:00.000Z",
    updated_at: "2026-08-22T00:00:00.000Z",
  };
}

function deliveryRow(record: GatewayDeliveryRecord, workspaceId: string): Record<string, unknown> {
  return { workspace_id: workspaceId, ...record };
}

function sandboxInstance(workspaceId: string): GatewaySandboxInstanceRecord {
  return {
    id: "sandbox-1",
    instance_key: "session:webhook:contact-1:main",
    scope: "session",
    backend: "docker",
    status: "ready",
    sandbox: {
      mode: "non_main",
      scope: "session",
      backend: "docker",
      workspace_access: "read",
      network_access: "none",
      allowed_paths: [{ root: "workspace", access: "read" }],
      denied_paths: [],
      metadata: {}
    },
    workspace_root: "/agent/worktree",
    created_at: "2026-08-22T00:00:00.000Z",
    updated_at: "2026-08-22T00:00:00.000Z",
    metadata: {}
  };
}

function adapterFor(handler: QueryHandler, overrides: Partial<ConstructorParameters<typeof PostgresGatewayAdapter>[0]> = {}): { adapter: PostgresGatewayAdapter; calls: QueryCall[]; contexts: Array<{ workspaceId: string; accountId: string }> } {
  const mocked = database(handler);
  const adapter = new PostgresGatewayAdapter({
    database: mocked.db,
    workspaceId: "workspace-a",
    accountId: "account-a",
    core: {
      ensureSession: async () => ({ id: "session-1", session_key: "webhook:contact-1:main", title: "Gateway", ui_locale: "ja", output_locale: "ja", created_at: "2026-08-22T00:00:00.000Z", updated_at: "2026-08-22T00:00:00.000Z" }),
      runChat: async () => ({ messages: [{ role: "agent", content: "ok" }] } as unknown as RunChatTurnResult)
    },
    emit: async () => undefined,
    ...overrides
  });
  return { adapter, calls: mocked.calls, contexts: mocked.contexts };
}

describe("PostgresGatewayAdapter", () => {
  it("固定WorkspaceをRLS Contextと全SQL条件へ渡し、別Workspaceの行を読まない", async () => {
    const stored = pairing();
    const first = adapterFor(async (text, values) => {
      if (text.includes("workspace_gateway_pairings") && values[0] === "workspace-a") return { rows: [{ workspace_id: "workspace-a", ...stored }] };
      return { rows: [] };
    });
    expect(await first.adapter.getPairing(stored.id)).toEqual(stored);
    expect(first.contexts).toEqual([{ workspaceId: "workspace-a", accountId: "account-a" }]);
    expect(first.calls[0]?.text).toContain("WHERE workspace_id = $1 AND id = $2");
    expect(first.calls[0]?.values[0]).toBe("workspace-a");

    const second = adapterFor(async (_text, values) => values[0] === "workspace-b" ? { rows: [{ workspace_id: "workspace-b", ...stored }] } : { rows: [] }, {
      workspaceId: "workspace-b",
      accountId: "account-b"
    });
    expect(await second.adapter.getPairing(stored.id)).toEqual({ ...stored });
    expect(second.contexts[0]).toEqual({ workspaceId: "workspace-b", accountId: "account-b" });
  });

  it("paired_contactはGatewayDomainServiceのfail-closedでCore Chatへ流れない", async () => {
    const stored = pairing();
    let chatCalls = 0;
    const { adapter } = adapterFor(async () => ({ rows: [] }), {
      core: {
        ensureSession: async () => { throw new Error("must_not_create_session"); },
        runChat: async () => { chatCalls += 1; throw new Error("must_not_chat"); }
      }
    });
    adapter.getRoutingPolicy = async () => undefined;
    adapter.getPairingPolicy = async () => undefined;
    adapter.findDuplicate = async () => undefined;
    adapter.isRateLimited = async () => false;
    adapter.findPairing = async () => stored;
    adapter.savePairing = async (record) => record;
    adapter.saveInbound = async (record) => record;
    adapter.expirePairings = async () => [];
    const service = new GatewayDomainService(adapter.dependencies() as never);
    const result = await service.executeInbound({ channel: "webhook", source_identity: "contact-1", body: "hello" });
    expect(result.inbound.status).toBe("blocked");
    expect(result.inbound.error).toBe("gateway_participant_authentication_required");
    expect(chatCalls).toBe(0);
  });

  it("Deliveryの同一idempotency、競合claim、retry、lease期限reconcileを維持する", async () => {
    let record: GatewayDeliveryRecord = {
      id: "delivery-1", inbound_id: "inbound-1", session_key: "webhook:contact-1:main", channel: "webhook",
      status: "pending", idempotency_key: "idem-1", payload: { text: "ok" }, attempt: 0, max_attempts: 2,
      created_at: "2026-08-22T00:00:00.000Z", updated_at: "2026-08-22T00:00:00.000Z"
    };
    const { adapter, calls } = adapterFor(async (text, values) => {
      if (text.includes("UPDATE workspace_gateway_deliveries") && text.includes("status = CASE")) {
        const retry = values[2] !== null && record.attempt < record.max_attempts;
        record = { ...record, status: retry ? "retry_wait" : "failed", next_attempt_at: retry ? String(values[2]) : undefined, lease_until: undefined, last_error: String(values[3]), updated_at: String(values[1]) };
        return { rows: [deliveryRow(record, "workspace-a")] };
      }
      if (text.includes("UPDATE workspace_gateway_deliveries") && text.includes("status = 'delivering'")) {
        if (record.status !== "pending" && record.status !== "retry_wait") return { rows: [] };
        record = { ...record, status: "delivering", attempt: record.attempt + 1, lease_until: String(values[2]), updated_at: String(values[1]) };
        return { rows: [deliveryRow(record, "workspace-a")] };
      }
      if (text.includes("UPDATE workspace_gateway_deliveries") && text.includes("last_error = CASE")) {
        record = { ...record, status: record.attempt < record.max_attempts ? "retry_wait" : "failed", next_attempt_at: record.attempt < record.max_attempts ? String(values[1]) : undefined, lease_until: undefined, last_error: record.attempt < record.max_attempts ? "gateway_delivery_lease_expired" : "gateway_delivery_max_attempts_exceeded" };
        return { rows: [deliveryRow(record, "workspace-a")] };
      }
      if (text.includes("workspace_gateway_deliveries") && text.includes("SELECT")) return { rows: [deliveryRow(record, "workspace-a")] };
      return { rows: [] };
    });

    expect(await adapter.enqueueDelivery(record)).toEqual(record);
    expect(await adapter.enqueueDelivery(record)).toEqual(record);
    await expect(adapter.enqueueDelivery({ ...record, payload: { text: "different" } })).rejects.toThrow("gateway_delivery_idempotency_mismatch");
    const claimed = await adapter.claimDelivery(record.id, { now: "2026-08-22T00:01:00.000Z", leaseUntil: "2026-08-22T00:02:00.000Z" });
    expect(claimed?.status).toBe("delivering");
    const retried = await adapter.failDelivery(record.id, { now: "2026-08-22T00:01:30.000Z", retryAt: "2026-08-22T00:03:00.000Z", error: "transport_down" });
    expect(retried.status).toBe("retry_wait");
    expect((await adapter.claimDelivery(record.id, { now: "2026-08-22T00:04:00.000Z", leaseUntil: "2026-08-22T00:05:00.000Z" }))?.attempt).toBe(2);
    expect((await adapter.reconcileExpiredDeliveries("2026-08-22T00:06:00.000Z"))[0]?.status).toBe("failed");
    expect(calls.filter((call) => call.text.includes("workspace_gateway_deliveries")).every((call) => call.values[0] === "workspace-a")).toBe(true);
  });

  it("Sandboxは保存済みGateway path policyを実行口へ渡し、executorなしを成功扱いしない", async () => {
    const instance = sandboxInstance("workspace-a");
    let executedSandbox: unknown;
    const { adapter } = adapterFor(async (text) => {
      if (text.includes("SELECT") && text.includes("workspace_gateway_sandbox_instances")) return { rows: [{ workspace_id: "workspace-a", ...instance }] };
      if (text.includes("INSERT INTO workspace_gateway_sandbox_instances")) return { rows: [{ workspace_id: "workspace-a", ...instance, status: "deleted", deleted_at: "2026-08-22T00:00:00.000Z" }] };
      return { rows: [] };
    }, {
      sandboxExecutor: {
        lifecycle: async (input) => { executedSandbox = input.sandbox; return { status: "completed" }; },
        sync: async () => ({ status: "completed" })
      }
    });
    const deleted = await adapter.deleteSandbox(instance.id);
    expect(deleted.status).toBe("deleted");
    expect(executedSandbox).toEqual(instance.sandbox);

    const noExecutor = adapterFor(async (text) => text.includes("workspace_gateway_sandbox_instances") ? { rows: [{ workspace_id: "workspace-a", ...instance }] } : { rows: [] });
    await expect(noExecutor.adapter.deleteSandbox(instance.id)).rejects.toThrow("gateway_sandbox_executor_unavailable");
  });
});
