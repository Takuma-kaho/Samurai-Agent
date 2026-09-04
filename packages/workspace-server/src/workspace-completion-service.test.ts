import { describe, expect, it } from "vitest";
import { createInternalWorkspaceMaintenanceCaller } from "./auth";
import { WorkspaceCompletionService } from "./workspace-completion-service";

describe("Workspace completion episode resolution", () => {
  it("locks only the episode row when resolving an operation activity", async () => {
    const queries: string[] = [];
    const episodeRow = {
      workspace_id: "workspace_a",
      room_id: "room_a",
      id: "completion_episode_a",
      goal: "A completed chat turn",
      source_app: "samurai-workspace-chat",
      external_episode_key: null,
      outcome: "unknown",
      started_at: "2026-09-04T00:00:00.000Z",
      ended_at: null,
      session_ref: null,
      version: 1,
      created_by: "account_a",
      updated_by: "account_a",
      created_at: "2026-09-04T00:00:00.000Z",
      updated_at: "2026-09-04T00:00:00.000Z"
    };
    const sql = {
      query: async (text: string) => {
        queries.push(text);
        if (text.includes("FROM workspace_completion_activities")) return { rows: [] };
        if (text.includes("INSERT INTO workspace_completion_episodes")) return { rows: [episodeRow] };
        throw new Error(`unexpected query: ${text}`);
      }
    };
    const service = new WorkspaceCompletionService({} as never);
    const resolveEpisode = (service as unknown as {
      resolveEpisodeForActivity: (sql: typeof sql, context: { workspaceId: string; accountId: string }, input: {
        roomId: string;
        operationId: string;
        sourceApp: string;
        instructionSummary: string;
      }, activityId: string) => Promise<{ id: string }>;
    }).resolveEpisodeForActivity.bind(service);

    await expect(resolveEpisode(sql, {
      workspaceId: "workspace_a",
      accountId: "account_a"
    }, {
      roomId: "room_a",
      operationId: "operation:run_a",
      sourceApp: "samurai-workspace-chat",
      instructionSummary: "A completed chat turn"
    }, "activity_a")).resolves.toMatchObject({ id: "completion_episode_a" });

    const operationLookup = queries.find((query) => query.includes("FROM workspace_completion_activities"));
    expect(operationLookup).toContain("FOR UPDATE OF episode");
    expect(operationLookup).not.toMatch(/LIMIT 1 FOR UPDATE(?! OF episode)/);
  });
});

describe("Workspace completion Activity projection identity", () => {
  it("returns the existing Activity and Episode without creating a second Episode", async () => {
    const state = createCompletionSqlState();
    const service = new WorkspaceCompletionService(createCompletionStore(state) as never);
    const firstContext = completionContext("operation_a");
    const retryContext = completionContext("operation_b");
    const input = completionInput();

    await service.ingestActivity(firstContext, input);
    const retried = await service.ingestActivity(retryContext, input);

    expect(retried.activity.id).toBe(input.id);
    expect(retried.episode.id).toBe(state.episodeRow.id);
    expect(state.activityInsertCount).toBe(2);
    expect(state.episodeInsertCount).toBe(1);
    expect(state.activityInsertQuery).toContain("ON CONFLICT (workspace_id, id) DO NOTHING");
  });

  it("rejects a different payload using the same stable Activity ID", async () => {
    const state = createCompletionSqlState();
    const service = new WorkspaceCompletionService(createCompletionStore(state) as never);
    const input = completionInput();

    await service.ingestActivity(completionContext("operation_a"), input);
    await expect(service.ingestActivity(completionContext("operation_b"), {
      ...input,
      resultSummary: "A different response"
    })).rejects.toMatchObject({ code: "workspace_completion_activity_id_conflict", status: 409 });

    expect(state.activityInsertCount).toBe(2);
    expect(state.episodeInsertCount).toBe(1);
  });

  it("rejects a different Episode goal using the same stable Activity ID", async () => {
    const state = createCompletionSqlState();
    const service = new WorkspaceCompletionService(createCompletionStore(state) as never);
    const input = completionInput();

    await service.ingestActivity(completionContext("operation_a"), input);
    await expect(service.ingestActivity(completionContext("operation_b"), {
      ...input,
      goal: "A different goal"
    })).rejects.toMatchObject({ code: "workspace_completion_activity_id_conflict", status: 409 });

    expect(state.episodeInsertCount).toBe(1);
  });

  it("rejects a different Activity principal using the same stable Activity ID", async () => {
    const state = createCompletionSqlState();
    const service = new WorkspaceCompletionService(createCompletionStore(state) as never);
    const input = completionInput();

    await service.ingestActivity(completionContext("operation_a"), input);
    await expect(service.ingestActivity({ ...completionContext("operation_b"), accountId: "account-other" }, input)).rejects.toMatchObject({
      code: "workspace_completion_activity_id_conflict",
      status: 409
    });
    expect(state.episodeInsertCount).toBe(1);
  });

  it("keeps the maintenance DB context while storing the Runtime requester as Activity principal", async () => {
    const state = createCompletionSqlState();
    state.activityRow.principal_account_id = "account-requester";
    const service = new WorkspaceCompletionService(createCompletionStore(state) as never);
    const operationId = "runtime-projection-operation";
    const context = {
      workspaceId: "workspace_a",
      accountId: "account-maintenance",
      operationId,
      caller: createInternalWorkspaceMaintenanceCaller({ principalAccountId: "account-maintenance", operationId })
    };

    await service.ingestRuntimeCompletionActivity(context, {
      ...completionInput(),
      externalEpisodeKey: "run_a",
      operationId: "operation:run_a",
      payload: { runtime_run_id: "run_a" }
    }, { runId: "run_a", principalAccountId: "account-requester" });

    expect(context.accountId).toBe("account-maintenance");
    expect(state.activityInsertValues?.[3]).toBe("account-requester");
    expect(state.activityRow.principal_account_id).not.toBe(context.accountId);
  });

  it("rejects a Runtime principal override outside a trusted maintenance caller", async () => {
    const state = createCompletionSqlState();
    const service = new WorkspaceCompletionService(createCompletionStore(state) as never);

    await expect(service.ingestRuntimeCompletionActivity({
      workspaceId: "workspace_a",
      accountId: "account-requester",
      operationId: "runtime-projection-operation"
    }, {
      ...completionInput(),
      sourceId: "run_a",
      payload: { runtime_run_id: "run_a" }
    }, { runId: "run_a", principalAccountId: "account-other" })).rejects.toMatchObject({
      code: "workspace_completion_runtime_projection_forbidden",
      status: 403
    });
  });
});

function completionContext(operationId: string) {
  return {
    workspaceId: "workspace_a",
    accountId: "account_a",
    operationId
  };
}

function completionInput() {
  return {
    id: "completion_activity_runtime_a",
    roomId: "room_a",
    sourceApp: "samurai-workspace-chat",
    sourceId: "run_a",
    instructionSummary: "A completed chat turn",
    resultSummary: "A response",
    changedResources: ["message_a"],
    verificationOutcome: "not_run" as const,
    failureState: "none" as const,
    outcome: "cancelled" as const,
    payload: { runtime_run_id: "run_a" }
  };
}

function createCompletionSqlState() {
  return {
    activityRow: {
      workspace_id: "workspace_a",
      room_id: "room_a",
      id: "completion_activity_runtime_a",
      principal_account_id: "account_a",
      source_app: "samurai-workspace-chat",
      source_id: "run_a",
      external_episode_key: null,
      correction_of_activity_id: null,
      operation_id: null,
      instruction_summary: "A completed chat turn",
      result_summary: "A response",
      changed_resources: ["message_a"],
      verification_outcome: "not_run",
      failure_state: "none",
      outcome: "cancelled",
      explicit_remember: false,
      payload: { runtime_run_id: "run_a" },
      session_ref: null,
      created_at: "2026-09-04T00:00:00.000Z",
      finalized_at: "2026-09-04T00:00:00.000Z"
    },
    episodeRow: {
      workspace_id: "workspace_a",
      room_id: "room_a",
      id: "completion_episode_runtime_a",
      goal: "A completed chat turn",
      source_app: "samurai-workspace-chat",
      external_episode_key: null,
      outcome: "unknown",
      started_at: "2026-09-04T00:00:00.000Z",
      ended_at: null,
      session_ref: null,
      version: 1,
      created_by: "account_a",
      updated_by: "account_a",
      created_at: "2026-09-04T00:00:00.000Z",
      updated_at: "2026-09-04T00:00:00.000Z"
    },
    linked: false,
    activityInsertCount: 0,
    episodeInsertCount: 0,
    activityInsertQuery: "",
    activityInsertValues: undefined as readonly unknown[] | undefined
  };
}

function createCompletionStore(state: ReturnType<typeof createCompletionSqlState>) {
  const sql = {
    query: async (text: string, values: readonly unknown[] = []) => {
      if (text.includes("samurai_completion_migration_write_allowed")) return { rows: [{ allowed: true }] };
      if (text.includes("FROM workspace_completion_policy_rules")) return { rows: [] };
      if (text.includes("FROM workspace_runtime_runs")) {
        return {
          rows: [{
            room_id: "room_a",
            requested_by_participant_id: "account-requester",
            phase: "settled",
            status: "completed"
          }]
        };
      }
      if (text.includes("FROM workspace_completion_episodes") && text.includes("external_episode_key")) return { rows: [] };
      if (text.includes("INSERT INTO workspace_completion_activities")) {
        state.activityInsertCount += 1;
        state.activityInsertQuery = text;
        state.activityInsertValues = values;
        return state.activityInsertCount === 1 ? { rows: [state.activityRow] } : { rows: [] };
      }
      if (text === "SELECT * FROM workspace_completion_activities WHERE workspace_id = $1 AND id = $2") {
        return { rows: [state.activityRow] };
      }
      if (text.includes("INSERT INTO workspace_completion_episodes")) {
        state.episodeInsertCount += 1;
        return { rows: [state.episodeRow] };
      }
      if (text.includes("INSERT INTO workspace_completion_episode_activities")) {
        state.linked = true;
        return { rows: [] };
      }
      if (text.includes("FROM workspace_completion_activities activity")) return { rows: [] };
      if (text.includes("SELECT episode.* FROM workspace_completion_episode_activities link")) {
        return { rows: state.linked ? [state.episodeRow] : [] };
      }
      throw new Error(`unexpected query: ${text}`);
    }
  };
  return {
    storageRoot: "/tmp/samurai-workspace-server-test",
    database: {},
    runIdempotentResult: async (_context: unknown, _request: unknown, action: (sql: typeof sql) => Promise<unknown>) => ({
      value: await action(sql),
      replayed: false
    }),
    insertAudit: async () => undefined
  };
}
