import { describe, expect, it } from "vitest";
import type { ActivityRecord, ResourceUsageRecord } from "@samurai-agent/core-schemas";
import type { PostgresWorkspaceDatabase, WorkspaceRequestContext } from "./index";
import { WorkspaceRuntimeActivityService } from "./workspace-runtime-activity";

const now = "2026-08-24T00:00:00.000Z";

describe("WorkspaceRuntimeActivityService", () => {
  it("persists an external-style Activity lifecycle with idempotency and immutable finalization", async () => {
    const database = new FakeDatabase();
    const service = new WorkspaceRuntimeActivityService(database as unknown as PostgresWorkspaceDatabase, () => now);
    const context: WorkspaceRequestContext = { workspaceId: "workspace-1", accountId: "account-1", operationId: "operation-1" };
    const activity = recordingActivity();

    const started = await service.createActivity(context, activity);
    const replay = await service.createActivity(context, { ...activity, id: "activity-replay" });
    expect(started.id).toBe(activity.id);
    expect(replay.id).toBe(activity.id);

    const linked = await service.linkActivityBackendRun(context, { activityId: activity.id, backendRunId: "run-1" });
    expect(linked.backend_run_id).toBe("run-1");

    const usage = await service.recordResourceUsage(context, {
      id: "usage-1",
      activity_id: activity.id,
      resource_ref: { kind: "knowledge", id: "knowledge-1", uri: "knowledge/knowledge-1" },
      usage_scope: { kind: "room", room_id: activity.room_id },
      stage: "read",
      created_at: now
    });
    expect(usage.activity_id).toBe(activity.id);

    const completed = await service.finalizeActivity(context, {
      activityId: activity.id,
      status: "completed",
      resultSummary: "完了しました。"
    });
    expect(completed.status).toBe("completed");
    await expect(service.finalizeActivity(context, {
      activityId: activity.id,
      status: "completed",
      resultSummary: "別の結果"
    })).rejects.toThrow("activity_finalized_immutable");
  });

  it("ingests a terminal external result atomically through the same runtime tables", async () => {
    const database = new FakeDatabase();
    const service = new WorkspaceRuntimeActivityService(database as unknown as PostgresWorkspaceDatabase, () => now);
    const context: WorkspaceRequestContext = { workspaceId: "workspace-1", accountId: "account-1", operationId: "operation-1" };
    const activity = recordingActivity();
    const result = await service.ingestFinalizedActivity(context, {
      activity,
      resourceUsage: [{
        id: "usage-terminal-1",
        activity_id: activity.id,
        resource_ref: { kind: "knowledge", id: "knowledge-1", uri: "knowledge/knowledge-1" },
        usage_scope: { kind: "room", room_id: activity.room_id },
        stage: "referenced",
        created_at: now
      }],
      finalization: { status: "completed", resultSummary: "外部結果を記録しました。" }
    });
    expect(result.status).toBe("completed");
    expect(result.id).toBe(activity.id);
  });
});

function recordingActivity(): ActivityRecord {
  return {
    id: "activity-1",
    workspace_id: "workspace-1",
    room_id: "room-1",
    principal: { kind: "human", participant_id: "account-1" },
    source: { kind: "external_app", app_id: "app-1", connector_id: "connector-1" },
    status: "recording",
    idempotency_key: "external-activity-1",
    instruction_summary: "外部アプリの処理",
    verification: [],
    domain_operation_ids: [],
    provenance: { kind: "trusted_context", source_id: "correlation-1", recorded_at: now },
    created_at: now,
    updated_at: now
  };
}

class FakeDatabase {
  private readonly activities = new Map<string, Record<string, unknown>>();
  private readonly usages = new Map<string, Record<string, unknown>>();

  async withContext(_context: WorkspaceRequestContext, action: (sql: { query: (text: string, values?: readonly unknown[]) => Promise<any> }) => Promise<unknown>): Promise<unknown> {
    return action({ query: (text, values = []) => this.query(text, values) });
  }

  private async query(text: string, values: readonly unknown[]): Promise<{ rows: any[]; rowCount: number }> {
    if (text.includes("SELECT samurai_can_room")) return { rows: [{ allowed: true }], rowCount: 1 };
    if (text.startsWith("INSERT INTO workspace_runtime_activities")) {
      const [workspaceId, id, roomId, statusOrKey, idempotencyOrBackend, backendOrRecord, recordOrCreated, createdOrUndefined] = values;
      const literalStatus = values.length === 7;
      const status = literalStatus ? "recording" : statusOrKey;
      const idempotencyKey = literalStatus ? statusOrKey : idempotencyOrBackend;
      const backendRunId = literalStatus ? idempotencyOrBackend : backendOrRecord;
      const record = literalStatus ? backendOrRecord : recordOrCreated;
      const createdAt = literalStatus ? recordOrCreated : createdOrUndefined;
      const key = `${workspaceId}:${roomId}:${idempotencyKey}`;
      if (![...this.activities.values()].some((row) => row.claimKey === key)) {
        this.activities.set(String(id), { workspace_id: workspaceId, id, room_id: roomId, status, idempotency_key: idempotencyKey, backend_run_id: backendRunId, record: JSON.parse(String(record)), created_at: createdAt, updated_at: createdAt, claimKey: key });
      }
      return { rows: [], rowCount: 1 };
    }
    if (text.includes("FROM workspace_runtime_activities") && text.includes("idempotency_key")) {
      const row = [...this.activities.values()].find((candidate) => candidate.workspace_id === values[0] && candidate.room_id === values[1] && candidate.idempotency_key === values[2]);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (text.includes("FROM workspace_runtime_activities") && text.includes("id = $2")) {
      const row = this.activities.get(String(values[1]));
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (text.includes("FROM workspace_runtime_runs")) {
      return { rows: [{ workspace_id: values[0], id: values[1], room_id: "room-1" }], rowCount: 1 };
    }
    if (text.includes("FROM workspace_runtime_activities") && text.includes("backend_run_id = $3")) {
      return { rows: [], rowCount: 0 };
    }
    if (text.startsWith("UPDATE workspace_runtime_activities") && text.includes("SET backend_run_id")) {
      const row = this.activities.get(String(values[1]));
      if (!row) return { rows: [], rowCount: 0 };
      row.backend_run_id = values[2];
      row.record = JSON.parse(String(values[3]));
      row.updated_at = values[4];
      row.status = (row.record as { status: string }).status;
      return { rows: [row], rowCount: 1 };
    }
    if (text.startsWith("SELECT * FROM workspace_runtime_resource_usage") && text.includes("id = $2")) {
      const row = this.usages.get(String(values[1]));
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (text.startsWith("INSERT INTO workspace_runtime_resource_usage")) {
      const [workspaceId, id, activityId, attemptId, resourceRef, resourceVersion, contentHash, usageScope, stage, operationId, changeId, createdAt] = values;
      this.usages.set(String(id), { workspace_id: workspaceId, id, activity_id: activityId, workspace_job_attempt_id: attemptId, resource_ref: JSON.parse(String(resourceRef)), resource_version: resourceVersion, content_hash: contentHash, usage_scope: JSON.parse(String(usageScope)), stage, domain_operation_id: operationId, workspace_change_id: changeId, created_at: createdAt });
      return { rows: [], rowCount: 1 };
    }
    if (text.startsWith("UPDATE workspace_runtime_activities") && text.includes("SET status")) {
      const row = this.activities.get(String(values[1]));
      if (!row) return { rows: [], rowCount: 0 };
      row.status = values[2];
      row.backend_run_id = values[3];
      row.record = JSON.parse(String(values[4]));
      row.updated_at = values[5];
      return { rows: [row], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }
}
