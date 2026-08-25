import { describe, expect, it } from "vitest";
import {
  SkillOptimizationRunSchema,
  WorkItemRecordSchema,
  stableHash,
  type WorkItemRecord
} from "@samurai-agent/core-schemas";
import {
  PostgresSkillOptimization,
  type PostgresCompletionService
} from "./postgres-skill-optimization.js";
import type { PostgresWorkspaceDatabase } from "@samurai-agent/workspace-server";

type QueryCall = { text: string; values: readonly unknown[] };
type QueryResult = { rows: Record<string, unknown>[]; rowCount?: number };

function completionStub(overrides: Partial<PostgresCompletionService> = {}): PostgresCompletionService {
  return {
    getResource: async () => ({ resource: skillResource(), version: skillVersion("old body") }),
    getResourceBody: async () => ({ resource: skillResource(), version: skillVersion("old body"), content: "old body" }),
    getSkillFile: async () => { throw new Error("support file was not expected"); },
    listSkillFiles: async () => [],
    updateResource: async () => ({ resource: skillResource(), replayed: false }),
    ...overrides
  };
}

function database(handler: (text: string, values: readonly unknown[]) => Promise<QueryResult>): { database: PostgresWorkspaceDatabase; calls: QueryCall[] } {
  const calls: QueryCall[] = [];
  const database = {
    withContext: async (_context: unknown, action: (sql: { query: (text: string, values?: readonly unknown[]) => Promise<QueryResult> }) => Promise<unknown>) => action({
      query: async (text: string, values: readonly unknown[] = []) => {
        calls.push({ text, values });
        return handler(text, values);
      }
    })
  } as unknown as PostgresWorkspaceDatabase;
  return { database, calls };
}

function adapterFor(
  handler: (text: string, values: readonly unknown[]) => Promise<QueryResult>,
  overrides: Partial<ConstructorParameters<typeof PostgresSkillOptimization>[0]> = {}
): { adapter: PostgresSkillOptimization; calls: QueryCall[] } {
  const mocked = database(handler);
  const adapter = new PostgresSkillOptimization({
    database: mocked.database,
    completion: completionStub(),
    workspaceId: "workspace-a",
    accountId: "account-a",
    repoRoot: "/workspace",
    ...overrides
  });
  return { adapter, calls: mocked.calls };
}

function skillResource() {
  return {
    workspaceId: "workspace-a",
    id: "skill-1",
    scope: { kind: "room" as const, roomId: "room-a" },
    kind: "skill" as const,
    title: "Skill",
    evidenceState: "confirmed" as const,
    lifecycleState: "active" as const,
    aiProtection: "editable" as const,
    creationSource: "human" as const,
    aiManaged: false,
    version: 1,
    currentConfirmedVersion: 1,
    createdBy: "account-a",
    updatedBy: "account-a",
    createdAt: "2026-08-22T00:00:00.000Z",
    updatedAt: "2026-08-22T00:00:00.000Z"
  };
}

function skillVersion(content: string) {
  return {
    workspaceId: "workspace-a",
    id: "version-1",
    resourceId: "skill-1",
    version: 1,
    filePath: "skills/skill-1/SKILL.md",
    contentHash: stableHash(content),
    contentSize: content.length,
    evidenceState: "confirmed" as const,
    lifecycleState: "active" as const,
    aiProtection: "editable" as const,
    creationSource: "human" as const,
    metadata: {},
    reason: "test",
    actorAccountId: "account-a",
    createdAt: "2026-08-22T00:00:00.000Z"
  };
}

function workItem(): WorkItemRecord {
  return WorkItemRecordSchema.parse({
    id: "work-1",
    objective_id: "objective-1",
    instruction: "optimize the skill",
    status: "ready",
    priority: 10,
    attempt: 0,
    max_attempts: 3,
    idempotency_key: "work-idempotency-1",
    created_at: "2026-08-22T00:00:00.000Z",
    updated_at: "2026-08-22T00:00:00.000Z"
  });
}

describe("PostgresSkillOptimization", () => {
  it("全SQLにworkspace境界を含め、ロックの重複取得を成功扱いしない", async () => {
    let lockInsertCount = 0;
    const { adapter, calls } = adapterFor(async (text) => {
      if (text.includes("INSERT INTO workspace_skill_optimization_locks")) {
        lockInsertCount += 1;
        return lockInsertCount === 1 ? { rows: [{ skill_id: "skill-1" }], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    });

    expect(await adapter.acquireLock({ skillId: "skill-1", runId: "run-1", acquiredAt: "2026-08-22T00:00:00.000Z" })).toBe(true);
    expect(await adapter.acquireLock({ skillId: "skill-1", runId: "run-2", acquiredAt: "2026-08-22T00:00:01.000Z" })).toBe(false);
    expect(calls.every((call) => call.text.includes("workspace_id") && call.values[0] === "workspace-a")).toBe(true);
    expect(calls[0]?.text).toContain("ON CONFLICT (workspace_id, skill_id) DO NOTHING");
  });

  it("claimはworkspace境界、期限、FOR UPDATE SKIP LOCKEDを使う", async () => {
    const current = workItem();
    const { adapter, calls } = adapterFor(async (text) => {
      if (text.includes("FOR UPDATE SKIP LOCKED")) return { rows: [{ workspace_id: "workspace-a", record: current }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });

    const claimed = await adapter.claimWorkItem({ workerId: "worker-1", leaseMs: 30_000, now: "2026-08-22T00:01:00.000Z" });
    expect(claimed?.status).toBe("running");
    expect(claimed?.lease_owner).toBe("worker-1");
    expect(calls.some((call) => call.text.includes("status = 'running'") && call.text.includes("lease_until <= $2") && call.text.includes("FOR UPDATE SKIP LOCKED"))).toBe(true);
    expect(calls.every((call) => call.text.includes("workspace_id") && call.values[0] === "workspace-a")).toBe(true);
  });

  it("期限前のHeartbeatだけが同じWorkerのWorkItem leaseを延長する", async () => {
    const running = WorkItemRecordSchema.parse({
      ...workItem(), status: "running", lease_owner: "worker-1",
      lease_expires_at: "2026-08-22T01:00:00.000Z", heartbeat_at: "2026-08-22T00:30:00.000Z", attempt: 1
    });
    const { adapter, calls } = adapterFor(async (text) => text.includes("jsonb_set")
      ? { rows: [{ workspace_id: "workspace-a", id: running.id, objective_id: running.objective_id, status: running.status,
          worker_id: running.lease_owner, lease_until: running.lease_expires_at, attempt: running.attempt, record: running,
          created_at: running.created_at, updated_at: running.updated_at }], rowCount: 1 }
      : { rows: [], rowCount: 0 });

    const renewed = await adapter.heartbeatWorkItem({ workItemId: running.id, workerId: "worker-1", leaseMs: 60_000, now: "2026-08-22T00:30:00.000Z" });
    expect(renewed).toMatchObject({ status: "running", lease_owner: "worker-1" });
    expect(calls[0]?.text).toContain("lease_until > $2");
    expect(calls[0]?.text).toContain("worker_id = $5");
  });

  it("保存前にSkillOptimizationの状態スキーマを検証する", async () => {
    const { adapter, calls } = adapterFor(async () => ({ rows: [], rowCount: 0 }));
    await expect(adapter.saveRun({ id: "run-1", status: "not-a-run-status" } as never)).rejects.toThrow();
    expect(calls).toHaveLength(0);
    expect(() => SkillOptimizationRunSchema.parse({ id: "run-1", status: "not-a-run-status" })).toThrow();
  });

  it("本文更新はCompletionの更新処理へ委譲し、期待ハッシュを確認する", async () => {
    let updateInput: Record<string, unknown> | undefined;
    const completion = completionStub({
      updateResource: async (_context, _resourceId, input) => {
        updateInput = input as unknown as Record<string, unknown>;
        return { resource: skillResource(), replayed: false };
      }
    });
    const { adapter } = adapterFor(async () => ({ rows: [], rowCount: 0 }), { completion });

    const updated = await adapter.replaceContentIfUnchanged({
      id: "skill-1",
      expectedContentHash: stableHash("old body"),
      content: "new body"
    });
    expect(updated?.id).toBe("skill-1");
    expect(updateInput).toMatchObject({ expectedVersion: 1, content: "new body", reason: "skill_optimization.promote" });
  });
});
