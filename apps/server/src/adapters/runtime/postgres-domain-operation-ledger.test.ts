import { describe, expect, it } from "vitest";
import { WorkspaceServerError } from "@samurai-agent/workspace-server";
import { PostgresDomainOperationLedger, type PostgresOperationLedgerDatabase } from "./postgres-domain-operation-ledger.js";

type StoredOperation = { request_hash: string; status: string; result: unknown; error_code?: string };

function database(): PostgresOperationLedgerDatabase {
  const rows = new Map<string, StoredOperation>();
  return {
    withContext: async (_context, action) => {
      return action({
        query: async (text, values = []) => {
          const key = String(values[1]);
          if (text.includes("INSERT INTO workspace_operations")) {
            if (rows.has(key)) return { rows: [] };
            rows.set(key, { request_hash: String(values[3]), status: "running", result: null });
            return { rows: [{ id: key }] };
          }
          if (text.includes("SELECT request_hash")) {
            const row = rows.get(key);
            return { rows: row ? [row] : [] };
          }
          if (text.includes("workspace_operation_outcome_unknown")) {
            const row = rows.get(key);
            if (row) Object.assign(row, { status: "failed", error_code: "workspace_operation_outcome_unknown" });
            return { rows: row ? [{ id: key }] : [] };
          }
          if (text.includes("SET status = 'failed'")) {
            const row = rows.get(key);
            if (row) Object.assign(row, { status: "failed", error_code: String(values[2]) });
            return { rows: [] };
          }
          if (text.includes("SET status = 'completed'")) {
            const row = rows.get(key);
            if (row?.status === "running") Object.assign(row, { status: "completed", result: JSON.parse(String(values[2])) });
            return { rows: [] };
          }
          throw new Error(`unexpected_sql:${text}`);
        }
      });
    }
  };
}

describe("PostgresDomainOperationLedger", () => {
  it("同じAccount・同じ入力の再試行は保存済み結果を返し、処理を二重実行しない", async () => {
    const ledger = new PostgresDomainOperationLedger(database(), "workspace-a", "account-a");
    let executions = 0;
    const execute = () => ledger.run({
      operationId: "gateway.pairing_policy.save",
      actorId: "account-a",
      idempotencyKey: "request-1",
      request: { channel: "webhook" },
      execute: async () => ({ value: "saved" as const, executions: ++executions })
    });

    await expect(execute()).resolves.toEqual({ value: { value: "saved", executions: 1 }, replayed: false });
    await expect(execute()).resolves.toEqual({ value: { value: "saved", executions: 1 }, replayed: true });
    expect(executions).toBe(1);
  });

  it("同じIDの別入力を競合として拒否する", async () => {
    const ledger = new PostgresDomainOperationLedger(database(), "workspace-a", "account-a");
    await ledger.run({
      operationId: "gateway.pairing_policy.save",
      idempotencyKey: "request-1",
      request: { channel: "webhook" },
      execute: async () => "saved"
    });
    await expect(ledger.run({
      operationId: "gateway.pairing_policy.save",
      idempotencyKey: "request-1",
      request: { channel: "slack" },
      execute: async () => "must_not_run"
    })).rejects.toMatchObject({ code: "workspace_operation_id_reused", status: 409 });
  });

  it("実行中の再試行は二重実行せず、失敗結果は再実行しない", async () => {
    const databaseWithPending = database();
    const ledger = new PostgresDomainOperationLedger(databaseWithPending, "workspace-a", "account-a");
    let release: (() => void) | undefined;
    const first = ledger.run({
      operationId: "gateway.pairing_policy.save",
      idempotencyKey: "request-1",
      request: { channel: "webhook" },
      execute: () => new Promise<string>((resolve) => { release = () => resolve("saved"); })
    });
    await new Promise((resolve) => setImmediate(resolve));
    await expect(ledger.run({
      operationId: "gateway.pairing_policy.save",
      idempotencyKey: "request-1",
      request: { channel: "webhook" },
      execute: async () => "must_not_run"
    })).rejects.toMatchObject({ code: "workspace_operation_in_progress", status: 409 });
    release?.();
    await expect(first).resolves.toMatchObject({ replayed: false });

    await expect(ledger.run({
      operationId: "gateway.pairing_policy.save",
      idempotencyKey: "request-2",
      request: { channel: "webhook" },
      execute: async () => { throw new WorkspaceServerError("policy_rejected", 409); }
    })).rejects.toMatchObject({ code: "policy_rejected", status: 409 });
    await expect(ledger.run({
      operationId: "gateway.pairing_policy.save",
      idempotencyKey: "request-2",
      request: { channel: "webhook" },
      execute: async () => "must_not_run"
    })).rejects.toMatchObject({ code: "workspace_operation_previously_failed", status: 409 });
  });

  it("クラッシュ後のrunning操作を結果不明として明示復旧し、再実行しない", async () => {
    const databaseWithPending = database();
    const ledger = new PostgresDomainOperationLedger(databaseWithPending, "workspace-a", "account-a");
    let release: (() => void) | undefined;
    const first = ledger.run({
      operationId: "gateway.pairing_policy.save",
      idempotencyKey: "request-recovery",
      request: { channel: "webhook" },
      execute: () => new Promise<string>((resolve) => { release = () => resolve("saved"); })
    });
    await new Promise((resolve) => setImmediate(resolve));

    await expect(ledger.recoverOutcomeUnknown({ idempotencyKey: "request-recovery", minAgeMs: 0 })).resolves.toEqual({
      status: "outcome_unknown",
      recovered: true
    });
    release?.();
    await expect(first).resolves.toMatchObject({ replayed: false });
    await expect(ledger.run({
      operationId: "gateway.pairing_policy.save",
      idempotencyKey: "request-recovery",
      request: { channel: "webhook" },
      execute: async () => "must_not_run"
    })).rejects.toMatchObject({ code: "workspace_operation_outcome_unknown", status: 409 });
  });
});
