import { describe, expect, it, vi } from "vitest";
import {
  PostgresWorkspaceDatabase,
  WorkspaceServerError,
  type WorkspaceCompletionActivityInput,
  type WorkspaceRequestContext
} from "@samurai-agent/workspace-server";
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

  it("projects a settled runtime run into Completion with the maintenance caller", async () => {
    const queries: Array<{ text: string; values: readonly unknown[] }> = [];
    const candidate = {
      id: "run-completed",
      room_id: "room-1",
      session_ref: { app_id: "samurai-native", session_id: "session-1" },
      backend_id: "gemini",
      requested_by_participant_id: "account-requester",
      status: "completed",
      input_summary: "short input",
      input_content: "The complete user instruction",
      output_summary: "The complete response",
      output_message_id: "message-output",
      error_code: null,
      changed_resources: [
        { kind: "artifact", id: "artifact-2", uri: "workspace://artifacts/artifact-2" },
        { kind: "artifact", id: "artifact-1", uri: "workspace://artifacts/artifact-1" },
        { kind: "artifact", id: "artifact-2", uri: "workspace://artifacts/artifact-2" }
      ]
    };
    const ingestRuntimeCompletionActivity = vi.fn(async (_context: WorkspaceRequestContext, input: WorkspaceCompletionActivityInput, _projection: { runId: string; principalAccountId: string }) => ({
      activity: input
    }));
    const completion = { ingestRuntimeCompletionActivity } as never;
    const database = {
      withContext: async (_context: WorkspaceRequestContext, action: (sql: { query: (text: string, values?: readonly unknown[]) => Promise<any> }) => Promise<unknown>) => action({
        query: async (text: string, values: readonly unknown[] = []) => {
          queries.push({ text, values });
          if (text.includes("SELECT id, session_id, room_id, status, phase, current_attempt")) return { rows: [], rowCount: 0 };
          if (text.includes("FROM workspace_runtime_runs run")) return { rows: [candidate], rowCount: 1 };
          throw new Error(`unexpected query: ${text}`);
        }
      })
    } as unknown as PostgresWorkspaceDatabase;

    const worker = new PostgresRuntimeExecutionWorker(database, 0, completion);
    const result = await worker.runTick({ workspaceId: "workspace-1", accountId: "account-maintenance", operationId: "worker-tick-1" }, {
      workerId: "worker-1",
      maxRuns: 1,
      signal: new AbortController().signal
    });

    expect(result).toEqual({ recovered: 0 });
    expect(ingestRuntimeCompletionActivity).toHaveBeenCalledTimes(1);
    const [projectionContext, input, projection] = ingestRuntimeCompletionActivity.mock.calls[0]!;
    expect(projectionContext.caller).toEqual(expect.objectContaining({ kind: "maintenance", principalAccountId: "account-maintenance" }));
    expect(input).toEqual({
      id: expect.stringMatching(/^completion_activity_[0-9a-f]{48}$/),
      roomId: "room-1",
      sourceApp: "samurai-workspace-chat",
      sourceId: "run-completed",
      externalEpisodeKey: "run-completed",
      operationId: "operation:run-completed",
      instructionSummary: "The complete user instruction",
      resultSummary: "The complete response",
      changedResources: ["message-output", "artifact-2", "artifact-1"],
      verificationOutcome: "not_run",
      failureState: "none",
      outcome: "completed",
      payload: {
        backend_id: "gemini",
        runtime_run_id: "run-completed",
        runtime_status: "completed",
        resource_refs: [
          { kind: "message", id: "message-output", uri: "runtime://messages/message-output" },
          { kind: "artifact", id: "artifact-2", uri: "workspace://artifacts/artifact-2" },
          { kind: "artifact", id: "artifact-1", uri: "workspace://artifacts/artifact-1" }
        ]
      },
      sessionRef: { appId: "samurai-native", sessionId: "session-1" }
    });
    expect(projection).toEqual({ runId: "run-completed", principalAccountId: "account-requester" });
    const candidateQuery = queries.find(({ text }) => text.includes("FROM workspace_runtime_runs run"));
    expect(candidateQuery?.values.at(-1)).toBe(1);
    expect(candidateQuery?.text).toContain("jsonb_agg(change.resource_ref ORDER BY change.created_at, change.id)");
  });

  it("keeps unprojected runs ahead of replay candidates without filtering existing Activities", async () => {
    const queries: Array<{ text: string; values: readonly unknown[] }> = [];
    const ingest = vi.fn(async () => ({ replayed: true }));
    const database = {
      withContext: async (_context: WorkspaceRequestContext, action: (sql: { query: (text: string, values?: readonly unknown[]) => Promise<any> }) => Promise<unknown>) => action({
        query: async (text: string, values: readonly unknown[] = []) => {
          queries.push({ text, values });
          if (text.includes("SELECT id, session_id, room_id, status, phase, current_attempt")) return { rows: [], rowCount: 0 };
          if (text.includes("FROM workspace_runtime_runs run")) return {
            rows: [{
              id: "run-unprojected",
              room_id: "room-1",
              session_ref: null,
              backend_id: "samurai-native",
              status: "completed",
              input_summary: "request",
              input_content: "request",
              output_summary: "response",
              output_message_id: null,
              error_code: null,
              requested_by_participant_id: "account-requester",
              changed_resources: []
            }],
            rowCount: 1
          };
          throw new Error(`unexpected query: ${text}`);
        }
      })
    } as unknown as PostgresWorkspaceDatabase;
    const worker = new PostgresRuntimeExecutionWorker(database, 0, { ingestRuntimeCompletionActivity: ingest } as never);

    await worker.runTick({ workspaceId: "workspace-1", accountId: "account-maintenance", operationId: "worker-tick-selection" }, {
      workerId: "worker-1",
      maxRuns: 1,
      signal: new AbortController().signal
    });

    const candidateQuery = queries.find(({ text }) => text.includes("FROM workspace_runtime_runs run"));
    expect(candidateQuery?.text).not.toContain("AND NOT EXISTS");
    expect(candidateQuery?.text).toContain("CASE WHEN EXISTS");
    expect(candidateQuery?.text).toContain("THEN 1 ELSE 0 END");
    expect(ingest.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ sourceId: "run-unprojected" }));
  });

  it("lets Completion accept an idempotent replay for an existing identical Activity", async () => {
    const ingest = vi.fn(async () => ({ replayed: true }));
    const database = projectionDatabase([{
      id: "run-existing",
      room_id: "room-1",
      session_ref: null,
      backend_id: "samurai-native",
      status: "failed",
      input_summary: "failed request",
      input_content: null,
      output_summary: null,
      output_message_id: null,
      error_code: "rate_limited",
      requested_by_participant_id: "account-requester",
      changed_resources: []
    }]);
    const worker = new PostgresRuntimeExecutionWorker(database, 0, { ingestRuntimeCompletionActivity: ingest } as never);

    await expect(worker.runTick({ workspaceId: "workspace-1", accountId: "account-1", operationId: "worker-tick-2" }, {
      workerId: "worker-1",
      maxRuns: 1,
      signal: new AbortController().signal
    })).resolves.toEqual({ recovered: 0 });

    expect(ingest).toHaveBeenCalledTimes(1);
    expect(ingest.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      id: expect.stringMatching(/^completion_activity_[0-9a-f]{48}$/),
      sourceId: "run-existing",
      externalEpisodeKey: "run-existing",
      operationId: "operation:run-existing"
    }));
  });

  it("reconstructs a failed callback input without output resources", async () => {
    const ingest = vi.fn(async (_context: WorkspaceRequestContext, input: WorkspaceCompletionActivityInput) => ({ activity: input }));
    const worker = new PostgresRuntimeExecutionWorker(projectionDatabase([{
      id: "run-failed-no-output",
      room_id: "room-1",
      session_ref: null,
      backend_id: "gemini",
      status: "failed",
      input_summary: "failed request",
      input_content: null,
      output_summary: null,
      output_message_id: null,
      error_code: "provider_unavailable",
      requested_by_participant_id: "account-requester",
      changed_resources: []
    }]), 0, { ingestRuntimeCompletionActivity: ingest } as never);

    await worker.runTick({ workspaceId: "workspace-1", accountId: "account-maintenance", operationId: "worker-tick-failed" }, {
      workerId: "worker-1",
      maxRuns: 1,
      signal: new AbortController().signal
    });

    expect(ingest.mock.calls[0]?.[1]).toEqual({
      id: expect.stringMatching(/^completion_activity_[0-9a-f]{48}$/),
      roomId: "room-1",
      sourceApp: "samurai-workspace-chat",
      sourceId: "run-failed-no-output",
      externalEpisodeKey: "run-failed-no-output",
      operationId: "operation:run-failed-no-output",
      instructionSummary: "failed request",
      changedResources: [],
      verificationOutcome: "failed",
      failureState: "unresolved",
      outcome: "failed",
      payload: {
        backend_id: "gemini",
        runtime_run_id: "run-failed-no-output",
        runtime_status: "failed",
        error_code: "provider_unavailable"
      }
    });
  });

  it("surfaces a conflicting existing Activity instead of treating the run as projected", async () => {
    const conflict = new WorkspaceServerError("workspace_completion_activity_id_conflict", 409, { run_id: "run-conflict" });
    const ingest = vi.fn(async () => { throw conflict; });
    const worker = new PostgresRuntimeExecutionWorker(projectionDatabase([{
      id: "run-conflict",
      room_id: "room-1",
      session_ref: null,
      backend_id: "samurai-native",
      status: "completed",
      input_summary: "request",
      input_content: "request",
      output_summary: "response",
      output_message_id: null,
      error_code: null,
      requested_by_participant_id: "account-requester",
      changed_resources: []
    }]), 0, { ingestRuntimeCompletionActivity: ingest } as never);

    await expect(worker.runTick({ workspaceId: "workspace-1", accountId: "account-1", operationId: "worker-tick-conflict" }, {
      workerId: "worker-1",
      maxRuns: 1,
      signal: new AbortController().signal
    })).rejects.toBe(conflict);
    expect(ingest).toHaveBeenCalledTimes(1);
  });

  it("propagates projection failures so the supervisor can retry", async () => {
    const projectionError = new Error("completion_projection_temporarily_unavailable");
    const database = projectionDatabase([{
      id: "run-retry",
      room_id: "room-1",
      session_ref: null,
      backend_id: "samurai-native",
      status: "outcome_unknown",
      input_summary: "unknown request",
      input_content: "unknown request",
      output_summary: null,
      output_message_id: null,
      error_code: "runtime_recovery_outcome_unknown",
      requested_by_participant_id: "account-requester",
      changed_resources: []
    }]);
    const completion = {
      ingestRuntimeCompletionActivity: vi.fn(async () => { throw projectionError; })
    } as never;
    const worker = new PostgresRuntimeExecutionWorker(database, 0, completion);

    await expect(worker.runTick({ workspaceId: "workspace-1", accountId: "account-1", operationId: "worker-tick-3" }, {
      workerId: "worker-1",
      maxRuns: 1,
      signal: new AbortController().signal
    })).rejects.toBe(projectionError);
  });

  it("fails closed when a settled Runtime run has no requester", async () => {
    const completion = {
      ingestRuntimeCompletionActivity: vi.fn()
    } as never;
    const worker = new PostgresRuntimeExecutionWorker(projectionDatabase([{
      id: "run-without-requester",
      room_id: "room-1",
      session_ref: null,
      backend_id: "samurai-native",
      status: "completed",
      input_summary: "request",
      input_content: "request",
      output_summary: "response",
      output_message_id: null,
      error_code: null,
      requested_by_participant_id: null,
      changed_resources: []
    }]), 0, completion);

    await expect(worker.runTick({ workspaceId: "workspace-1", accountId: "account-maintenance", operationId: "worker-tick-null-principal" }, {
      workerId: "worker-1",
      maxRuns: 1,
      signal: new AbortController().signal
    })).rejects.toMatchObject({ code: "workspace_completion_runtime_principal_missing", status: 503 });
    expect(completion.ingestRuntimeCompletionActivity).not.toHaveBeenCalled();
  });

  it("honors maxRuns even if an adapter returns more candidates than requested", async () => {
    const ingest = vi.fn(async () => ({}));
    const rows = ["first", "second"].map((id) => ({
      id: `run-${id}`,
      room_id: "room-1",
      session_ref: null,
      backend_id: "samurai-native",
      status: "completed",
      input_summary: id,
      input_content: id,
      output_summary: id,
      output_message_id: null,
      error_code: null,
      requested_by_participant_id: "account-requester",
      changed_resources: []
    }));
    const worker = new PostgresRuntimeExecutionWorker(projectionDatabase(rows), 0, { ingestRuntimeCompletionActivity: ingest } as never);

    await worker.runTick({ workspaceId: "workspace-1", accountId: "account-1", operationId: "worker-tick-4" }, {
      workerId: "worker-1",
      maxRuns: 1,
      signal: new AbortController().signal
    });

    expect(ingest).toHaveBeenCalledTimes(1);
  });
});

function projectionDatabase(rows: readonly Record<string, unknown>[]): PostgresWorkspaceDatabase {
  return {
    withContext: async (_context: WorkspaceRequestContext, action: (sql: { query: (text: string, values?: readonly unknown[]) => Promise<any> }) => Promise<unknown>) => action({
      query: async (text: string) => {
        if (text.includes("SELECT id, session_id, room_id, status, phase, current_attempt")) return { rows: [], rowCount: 0 };
        if (text.includes("FROM workspace_runtime_runs run")) return { rows, rowCount: rows.length };
        throw new Error(`unexpected query: ${text}`);
      }
    })
  } as unknown as PostgresWorkspaceDatabase;
}
