import { describe, expect, it } from "vitest";
import { AgentBackendRegistry } from "@samurai-agent/agent-backends";
import type { PostgresWorkspaceDatabase, WorkspaceServerStore } from "@samurai-agent/workspace-server";
import { PostgresRuntimeAutomation } from "./postgres-runtime-automation";

const timestamp = new Date("2026-08-25T00:00:00.000Z");

describe("PostgresRuntimeAutomation PostgreSQL rows", () => {
  it("normalizes PostgreSQL Date timestamps before parsing jobs and runs", async () => {
    const database = {
      withContext: async (_context: unknown, action: (sql: { query: (text: string) => Promise<{ rows: unknown[] }> }) => Promise<unknown>) => action({
        query: async (text: string) => ({ rows: [text.includes("automation_jobs") ? jobRow() : runRow()] })
      })
    } as unknown as PostgresWorkspaceDatabase;
    const automation = new PostgresRuntimeAutomation({
      database,
      store: {} as WorkspaceServerStore,
      backendRegistry: new AgentBackendRegistry(),
      agentWorktreeRoot: "/tmp/samurai-automation-agent-worktrees",
      coreWorkspaceRoot: "/tmp/samurai-automation-core"
    });

    const jobs = await automation.listJobs({ workspaceId: "workspace-a", accountId: "account-a" });
    const runs = await automation.listRuns({ workspaceId: "workspace-a", accountId: "account-a" }, "job-a");

    expect(jobs[0]?.authorized_at).toBe(timestamp.toISOString());
    expect(jobs[0]?.created_at).toBe(timestamp.toISOString());
    expect(runs[0]?.scheduled_at).toBe(timestamp.toISOString());
    expect(runs[0]?.started_at).toBe(timestamp.toISOString());
    expect(runs[0]?.completed_at).toBe(timestamp.toISOString());
  });
});

function jobRow(): Record<string, unknown> {
  return {
    workspace_id: "workspace-a",
    id: "job-a",
    room_id: "room-a",
    title: "Date normalization",
    kind: "wiki_reindex",
    status: "enabled",
    schedule: "once",
    target_instruction: "Normalize PostgreSQL timestamps.",
    delivery_target: {},
    authority: { kind: "direct_principal", principal: { kind: "human", participant_id: "account-a" } },
    created_principal_snapshot: { kind: "human", participant_id: "account-a" },
    source_snapshot: { kind: "host" },
    connection_id: null,
    session_ref: null,
    authorization_state: "ready",
    authorization_error_code: null,
    authorized_at: timestamp,
    blocked_at: null,
    rebound_at: null,
    management_state: "allowed",
    management_operation_id: null,
    created_operation_id: "operation-a",
    rebound_operation_id: null,
    next_run_at: timestamp,
    last_run_at: null,
    retry_after_at: null,
    locked_until: null,
    lock_owner_token: null,
    failure_count: 0,
    max_attempts: 1,
    last_error: null,
    created_at: timestamp,
    updated_at: timestamp
  };
}

function runRow(): Record<string, unknown> {
  return {
    workspace_id: "workspace-a",
    id: "run-a",
    job_id: "job-a",
    room_id: "room-a",
    kind: "wiki_reindex",
    source: "host",
    session_ref: null,
    backend_run_id: null,
    status: "completed",
    operation_id: "operation-a",
    authority: { kind: "direct_principal", principal: { kind: "human", participant_id: "account-a" } },
    connector_id: null,
    app_id: null,
    activity_id: "activity-a",
    error_code: null,
    scheduled_at: timestamp,
    started_at: timestamp,
    completed_at: timestamp,
    blocked_at: null,
    error: null,
    attempt_no: 1
  };
}
