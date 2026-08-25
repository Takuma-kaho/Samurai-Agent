import { describe, expect, it } from "vitest";
import { PostgresWorkspaceDatabase, type WorkspaceRequestContext } from "@samurai-agent/workspace-server";
import { PostgresRuntimeExecutionWorker } from "./postgres-runtime-execution-worker.js";

describe("PostgresRuntimeExecutionWorker", () => {
  it("does not set completed_at when recovery outcome is unknown", async () => {
    const queries: Array<{ text: string; values: readonly unknown[] }> = [];
    const database = {
      withContext: async (_context: WorkspaceRequestContext, action: (sql: { query: (text: string, values?: readonly unknown[]) => Promise<any> }) => Promise<unknown>) => action({
        query: async (text: string, values: readonly unknown[] = []) => {
          queries.push({ text, values });
          if (text.includes("SELECT id, session_id, room_id, status, phase, current_attempt")) {
            return { rows: [{ id: "run-1", session_id: "session-1", room_id: null, status: "running", phase: "backend_starting", current_attempt: 1 }], rowCount: 1 };
          }
          if (text.includes("MAX(sequence)")) return { rows: [{ max_sequence: 0 }], rowCount: 1 };
          if (text.includes("workspace_runtime_activities")) return { rows: [], rowCount: 0 };
          return { rows: [], rowCount: 1 };
        }
      })
    } as unknown as PostgresWorkspaceDatabase;
    const worker = new PostgresRuntimeExecutionWorker(database, 0);
    const result = await worker.runTick({ workspaceId: "workspace-1", accountId: "account-1", operationId: "worker-1" }, {
      workerId: "worker-1",
      maxRuns: 1,
      signal: new AbortController().signal
    });

    expect(result).toEqual({ recovered: 1 });
    const update = queries.find((query) => query.text.includes("UPDATE workspace_runtime_runs"));
    expect(update?.values[4]).toBeNull();
  });

  it("settles an admitted run as failed and releases its reservation after a process stop", async () => {
    const queries: Array<{ text: string; values: readonly unknown[] }> = [];
    const database = {
      withContext: async (_context: WorkspaceRequestContext, action: (sql: { query: (text: string, values?: readonly unknown[]) => Promise<any> }) => Promise<unknown>) => action({
        query: async (text: string, values: readonly unknown[] = []) => {
          queries.push({ text, values });
          if (text.includes("SELECT id, session_id, room_id, status, phase, current_attempt")) {
            return { rows: [{ id: "run-admitted", session_id: "session-1", room_id: null, status: "queued", phase: "admitted", current_attempt: 1 }], rowCount: 1 };
          }
          if (text.includes("MAX(sequence)")) return { rows: [{ max_sequence: 2 }], rowCount: 1 };
          if (text.includes("UPDATE workspace_runtime_runs")) return { rows: [], rowCount: 1 };
          return { rows: [], rowCount: 1 };
        }
      })
    } as unknown as PostgresWorkspaceDatabase;
    const worker = new PostgresRuntimeExecutionWorker(database, 0);
    const result = await worker.runTick({ workspaceId: "workspace-1", accountId: "account-1", operationId: "worker-1" }, {
      workerId: "worker-1",
      maxRuns: 1,
      signal: new AbortController().signal
    });

    expect(result).toEqual({ recovered: 1 });
    const update = queries.find((query) => query.text.includes("UPDATE workspace_runtime_runs"));
    expect(update?.values.slice(2, 5)).toEqual(["failed", "runtime_recovery_admission_interrupted", expect.any(String)]);
    expect(queries.some((query) => query.text.includes("workspace_runtime_reservations") && query.text.includes("released"))).toBe(true);
  });
});
