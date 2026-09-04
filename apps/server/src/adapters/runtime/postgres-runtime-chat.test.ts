import { describe, expect, it } from "vitest";
import type { AgentBackendRegistry, BackendEventRecord, BackendRunInput, BackendOutputEvent } from "@samurai-agent/agent-backends";
import { BackendEventBridge } from "@samurai-agent/runtime";
import { WorkspaceServerError, type PostgresWorkspaceDatabase } from "@samurai-agent/workspace-server";
import { PostgresRuntimeChat } from "./postgres-runtime-chat.js";

describe("PostgresRuntimeChat session projections", () => {
  it("normalizes PostgreSQL Date timestamps before schema parsing", async () => {
    const createdAt = new Date("2026-09-03T00:00:00.000Z");
    const updatedAt = new Date("2026-09-03T00:01:00.000Z");
    const database = {
      withContext: async (_context: unknown, action: (sql: { query: () => Promise<{ rows: unknown[] }> }) => Promise<unknown>) => action({
        query: async () => ({
          rows: [{
            workspace_id: "workspace-a",
            id: "session-a",
            session_key: "workspace:workspace-a:thread-a",
            room_id: "room-a",
            title: "A session",
            ui_locale: "ja",
            output_locale: "ja",
            created_at: createdAt,
            updated_at: updatedAt
          }]
        })
      })
    } as unknown as PostgresWorkspaceDatabase;
    const chat = new PostgresRuntimeChat({
      database,
      workspaceId: "workspace-a",
      accountId: "account-a",
      backendRegistry: { statuses: () => [] } as unknown as AgentBackendRegistry,
      agentWorktreeRoot: "/tmp/samurai-agent-sessions",
      coreWorkspaceRoot: "/tmp/samurai-core-sessions"
    });

    await expect(chat.listSessions()).resolves.toEqual([{
      id: "session-a",
      session_key: "workspace:workspace-a:thread-a",
      room_id: "room-a",
      title: "A session",
      ui_locale: "ja",
      output_locale: "ja",
      created_at: createdAt.toISOString(),
      updated_at: updatedAt.toISOString()
    }]);
  });

  it("normalizes PostgreSQL Date timestamps for backend runs before schema parsing", async () => {
    const startedAt = new Date("2026-09-03T00:00:00.000Z");
    const completedAt = new Date("2026-09-03T00:01:00.000Z");
    const database = {
      withContext: async (_context: unknown, action: (sql: { query: () => Promise<{ rows: unknown[] }> }) => Promise<unknown>) => action({
        query: async () => ({
          rows: [{
            workspace_id: "workspace-a",
            id: "run-a",
            session_id: "session-a",
            room_id: "room-a",
            principal: null,
            source: null,
            session_ref: null,
            agent_id: null,
            requested_by_participant_id: "account-a",
            input_message_id: "message-a",
            output_message_id: "message-output-a",
            backend_id: "samurai-native",
            backend_kind: "samurai_native",
            backend_session_id: null,
            status: "completed",
            phase: "settled",
            current_attempt: 1,
            request_idempotency_key: "request-a",
            request_hash: "request-hash-a",
            started_at: startedAt,
            completed_at: completedAt,
            input_summary: "A request",
            output_summary: "A response",
            error_code: null,
            metadata: {}
          }]
        })
      })
    } as unknown as PostgresWorkspaceDatabase;
    const chat = new PostgresRuntimeChat({
      database,
      workspaceId: "workspace-a",
      accountId: "account-a",
      backendRegistry: { statuses: () => [] } as unknown as AgentBackendRegistry,
      agentWorktreeRoot: "/tmp/samurai-agent-sessions",
      coreWorkspaceRoot: "/tmp/samurai-core-sessions"
    });

    await expect(chat.listBackendRuns("session-a")).resolves.toEqual([{
      id: "run-a",
      session_id: "session-a",
      room_id: "room-a",
      requested_by_participant_id: "account-a",
      input_message_id: "message-a",
      output_message_id: "message-output-a",
      backend_id: "samurai-native",
      backend_kind: "samurai_native",
      status: "completed",
      phase: "settled",
      current_attempt: 1,
      request_idempotency_key: "request-a",
      request_hash: "request-hash-a",
      started_at: startedAt.toISOString(),
      completed_at: completedAt.toISOString(),
      input_summary: "A request",
      output_summary: "A response",
      metadata: {}
    }]);
  });

  it("normalizes PostgreSQL Date timestamps for cancellation admission messages", async () => {
    const createdAt = new Date("2026-09-03T00:00:00.000Z");
    const now = createdAt.toISOString();
    const run = {
      id: "run-a",
      session_id: "session-a",
      room_id: "room-a",
      backend_id: "samurai-native",
      backend_kind: "samurai_native",
      status: "running",
      phase: "external_running",
      current_attempt: 1,
      input_message_id: "message-a",
      started_at: now,
      input_summary: "A request",
      metadata: {}
    };
    const operation = {
      id: "operation:run-a",
      session_id: "session-a",
      run_id: "run-a",
      capability_id: "runtime.chat",
      operation: "runtime.chat",
      actor_identity: "owner",
      room_id: "room-a",
      instruction_source: "owner_instruction",
      instruction_authority: "room_execute",
      channel: "web",
      input_hash: "request-hash-a",
      input_ref: { kind: "message", id: "message-a", uri: "runtime://messages/message-a" },
      target_resource_refs: [],
      proposed_effects: ["runtime.chat"],
      status: "created",
      correlation_id: "run-a",
      created_at: now,
      updated_at: now
    };
    const activity = {
      id: "activity-a",
      workspace_id: "workspace-a",
      room_id: "room-a",
      principal: { kind: "human", participant_id: "account-a" },
      source: { kind: "native_app", app_id: "samurai-native" },
      status: "recording",
      idempotency_key: "chat:session-a:request-a",
      instruction_summary: "A request",
      verification: [],
      session_ref: { app_id: "samurai-native", session_id: "session-a" },
      backend_run_id: "run-a",
      domain_operation_ids: ["operation:run-a"],
      provenance: { kind: "host", source_id: "run-a", recorded_at: now },
      created_at: now,
      updated_at: now
    };
    const database = {
      withContext: async (_context: unknown, action: (sql: { query: (text: string, values?: readonly unknown[]) => Promise<{ rows: unknown[] }> }) => Promise<unknown>) => action({
        query: async (text) => {
          if (text.includes("samurai_can_room")) return { rows: [{ allowed: true }] };
          if (text.includes("workspace_runtime_sessions")) return { rows: [{
            workspace_id: "workspace-a",
            id: "session-a",
            session_key: "workspace:workspace-a:thread-a",
            room_id: "room-a",
            title: "A session",
            ui_locale: "ja",
            output_locale: "ja",
            created_at: createdAt,
            updated_at: createdAt
          }] };
          if (text.includes("workspace_runtime_messages")) return { rows: [{
            workspace_id: "workspace-a",
            id: "message-a",
            session_id: "session-a",
            role: "user",
            content: "A request",
            input_locale: "ja",
            output_locale: "ja",
            envelope: null,
            created_at: createdAt
          }] };
          if (text.includes("workspace_runtime_operations")) return { rows: [operationRow(operation)] };
          if (text.includes("workspace_runtime_activities")) return { rows: [activityRowFor(activity)] };
          return { rows: [] };
        }
      })
    } as unknown as PostgresWorkspaceDatabase;
    const chat = new PostgresRuntimeChat({
      database,
      workspaceId: "workspace-a",
      accountId: "account-a",
      backendRegistry: { statuses: () => [] } as unknown as AgentBackendRegistry,
      agentWorktreeRoot: "/tmp/samurai-agent-sessions",
      coreWorkspaceRoot: "/tmp/samurai-core-sessions"
    });

    const admissionForRun = (chat as unknown as {
      admissionForRun: (value: unknown) => Promise<{ userMessage: { created_at: string } }>
    }).admissionForRun.bind(chat);
    await expect(admissionForRun(run)).resolves.toMatchObject({
      userMessage: { created_at: createdAt.toISOString() }
    });
  });

  it("normalizes PostgreSQL Date timestamps for runtime events and workspace changes", async () => {
    const createdAt = new Date("2026-09-03T00:00:00.000Z");
    const database = {
      withContext: async (_context: unknown, action: (sql: { query: (text: string) => Promise<{ rows: unknown[] }> }) => Promise<unknown>) => action({
        query: async (text) => {
          if (text.includes("workspace_runtime_events")) return { rows: [{
            workspace_id: "workspace-a",
            id: "event-a",
            run_id: "run-a",
            session_id: "session-a",
            backend_session_id: null,
            event_type: "text_delta",
            sequence: 1,
            attempt_no: 1,
            source_event_id: null,
            source_sequence: null,
            payload: { text: "chunk" },
            resource_refs: [],
            created_at: createdAt
          }] };
          return { rows: [{
            id: "change-a",
            run_id: "run-a",
            session_id: "session-a",
            room_id: "room-a",
            activity_id: "activity-a",
            domain_operation_id: "operation:run-a",
            session_ref: null,
            resource_ref: { kind: "artifact", id: "artifact-a", uri: "artifacts/artifact-a.md" },
            change_type: "artifact_created",
            summary: "Artifact created",
            legacy_operation_id: null,
            correlation_id: "run-a",
            created_at: createdAt
          }] };
        }
      })
    } as unknown as PostgresWorkspaceDatabase;
    const chat = new PostgresRuntimeChat({
      database,
      workspaceId: "workspace-a",
      accountId: "account-a",
      backendRegistry: { statuses: () => [] } as unknown as AgentBackendRegistry,
      agentWorktreeRoot: "/tmp/samurai-agent-sessions",
      coreWorkspaceRoot: "/tmp/samurai-core-sessions"
    });

    await expect(chat.listBackendEvents("run-a")).resolves.toMatchObject([{
      id: "event-a",
      created_at: createdAt.toISOString()
    }]);
    await expect(chat.listWorkspaceChanges("session-a")).resolves.toMatchObject([{
      id: "change-a",
      created_at: createdAt.toISOString()
    }]);
  });

  it("cancels and projects a run when the session has a legacy create operation", async () => {
    const createdAt = new Date("2026-09-03T00:00:00.000Z");
    const now = createdAt.toISOString();
    const runRow: Record<string, unknown> = {
      workspace_id: "workspace-a",
      id: "run-a",
      session_id: "session-a",
      room_id: "room-a",
      principal: null,
      source: null,
      session_ref: null,
      agent_id: null,
      requested_by_participant_id: "account-a",
      input_message_id: "message-a",
      output_message_id: null,
      backend_id: "samurai-native",
      backend_kind: "samurai_native",
      backend_session_id: null,
      status: "running",
      phase: "external_running",
      current_attempt: 1,
      request_idempotency_key: "request-a",
      request_hash: "request-hash-a",
      started_at: createdAt,
      completed_at: null,
      input_summary: "A request",
      output_summary: null,
      error_code: null,
      metadata: {}
    };
    const sessionRow = {
      workspace_id: "workspace-a",
      id: "session-a",
      session_key: "workspace:workspace-a:thread-a",
      room_id: "room-a",
      title: "A session",
      ui_locale: "ja",
      output_locale: "ja",
      created_at: createdAt,
      updated_at: createdAt
    };
    const messageRow = {
      workspace_id: "workspace-a",
      id: "message-a",
      session_id: "session-a",
      role: "user",
      content: "A request",
      input_locale: "ja",
      output_locale: "ja",
      envelope: null,
      created_at: createdAt
    };
    const runOperation = {
      id: "operation:run-a",
      session_id: "session-a",
      run_id: "run-a",
      capability_id: "runtime.chat",
      operation: "runtime.chat",
      actor_identity: "owner" as const,
      room_id: "room-a",
      instruction_source: "owner_instruction" as const,
      instruction_authority: "room_execute" as const,
      channel: "web" as const,
      input_hash: "request-hash-a",
      input_ref: { kind: "message" as const, id: "message-a", uri: "runtime://messages/message-a" },
      target_resource_refs: [],
      proposed_effects: ["runtime.chat"],
      status: "created" as const,
      correlation_id: "run-a",
      created_at: now,
      updated_at: now
    };
    const legacyOperation = {
      workspace_id: "workspace-a",
      id: "session_create:operation-a",
      session_id: "session-a",
      room_id: "room-a",
      operation: "runtime.chat.session.create",
      status: "completed",
      payload: { input_hash: "session-input-hash", session_id: "session-a" },
      created_at: createdAt,
      updated_at: createdAt
    };
    let runOperationRow: Record<string, unknown> = operationRow(runOperation);
    const activity = {
      id: "activity-a",
      workspace_id: "workspace-a",
      room_id: "room-a",
      principal: { kind: "human" as const, participant_id: "account-a" },
      source: { kind: "native_app" as const, app_id: "samurai-native" },
      status: "recording" as const,
      idempotency_key: "chat:session-a:request-a",
      instruction_summary: "A request",
      verification: [],
      session_ref: { app_id: "samurai-native", session_id: "session-a" },
      backend_run_id: "run-a",
      domain_operation_ids: ["operation:run-a"],
      provenance: { kind: "host" as const, source_id: "run-a", recorded_at: now },
      created_at: now,
      updated_at: now
    };
    let activityRow: Record<string, unknown> = activityRowFor(activity);
    const eventRows: Record<string, unknown>[] = [];
    const notifiedEvents: string[] = [];
    let completion: { run: { status: string }; operation?: { id: string; status: string } } | undefined;
    const database = {
      withContext: async (_context: unknown, action: (sql: { query: (text: string, values?: readonly unknown[]) => Promise<{ rows: unknown[]; rowCount?: number }> }) => Promise<unknown>) => action({
        query: async (text: string, values: readonly unknown[] = []) => {
          const query = text.trim();
          if (text.includes("samurai_can_room")) return { rows: [{ allowed: true }] };
          if (text.includes("SELECT MAX(sequence)")) return { rows: [{ max_sequence: Math.max(0, ...eventRows.map((event) => Number(event.sequence ?? 0))) }] };
          if (query.startsWith("SELECT * FROM workspace_runtime_runs") && text.includes("FOR UPDATE")) return { rows: [runRow] };
          if (query.startsWith("SELECT * FROM workspace_runtime_runs")) return { rows: [runRow] };
          if (query.startsWith("UPDATE workspace_runtime_runs") && query.includes("SET phase")) {
            runRow.phase = values[2] === "running" ? "cancelling" : runRow.phase;
            return { rows: [runRow] };
          }
          if (query.startsWith("UPDATE workspace_runtime_runs") && query.includes("SET status")) {
            runRow.status = values[2];
            runRow.phase = values[3];
            runRow.output_message_id = values[4];
            runRow.output_summary = values[5];
            runRow.error_code = values[6];
            runRow.completed_at = values[7];
            return { rows: [runRow] };
          }
          if (text.includes("FROM workspace_runtime_sessions")) return { rows: [sessionRow] };
          if (text.includes("FROM workspace_runtime_messages")) return { rows: [messageRow] };
          if (query.startsWith("UPDATE workspace_runtime_activities") && query.includes("SET status")) {
            activityRow = { ...activityRow, status: values[2], record: JSON.parse(String(values[3])) };
            return { rows: [] };
          }
          if (text.includes("FROM workspace_runtime_activities")) return { rows: [activityRow] };
          if (query.startsWith("UPDATE workspace_runtime_operations")) {
            runOperationRow = {
              ...runOperationRow,
              operation: values[2],
              status: values[3],
              payload: JSON.parse(String(values[4])),
              updated_at: new Date(String(values[5]))
            };
            return { rows: [runOperationRow] };
          }
          if (text.includes("FROM workspace_runtime_operations") && text.includes("session_id = $2")) {
            return { rows: [runOperationRow, legacyOperation] };
          }
          if (text.includes("FROM workspace_runtime_operations")) return { rows: [runOperationRow] };
          if (query.startsWith("INSERT INTO workspace_runtime_events")) {
            eventRows.push({
              workspace_id: values[0],
              id: values[1],
              run_id: values[2],
              session_id: values[3],
              backend_session_id: values[4],
              event_type: values[5],
              sequence: values[6],
              attempt_no: values[7],
              source_event_id: values[8],
              source_sequence: values[9],
              payload: JSON.parse(String(values[10])),
              resource_refs: JSON.parse(String(values[11])),
              created_at: new Date(String(values[12]))
            });
            return { rows: [] };
          }
          if (text.includes("FROM workspace_runtime_events")) return { rows: eventRows };
          if (text.includes("FROM workspace_runtime_changes")) return { rows: [{
            id: "change-a",
            run_id: "run-a",
            session_id: "session-a",
            room_id: "room-a",
            activity_id: "activity-a",
            domain_operation_id: "operation:run-a",
            session_ref: null,
            resource_ref: { kind: "artifact", id: "artifact-a", uri: "artifacts/artifact-a.md" },
            change_type: "artifact_created",
            summary: "Artifact created",
            legacy_operation_id: null,
            correlation_id: "run-a",
            created_at: createdAt
          }] };
          if (text.includes("FROM workspace_records")) return { rows: [] };
          if (text.includes("FROM workspace_audit_entries")) return { rows: [] };
          return { rows: [] };
        }
      })
    } as unknown as PostgresWorkspaceDatabase;
    const chat = new PostgresRuntimeChat({
      database,
      workspaceId: "workspace-a",
      accountId: "account-a",
      backendRegistry: { statuses: () => [], get: () => undefined } as unknown as AgentBackendRegistry,
      agentWorktreeRoot: "/tmp/samurai-agent-cancel",
      coreWorkspaceRoot: "/tmp/samurai-core-cancel",
      onEvent: async (event) => { notifiedEvents.push(event.event_type); },
      onCompletionActivity: async (event) => {
        completion = {
          run: { status: event.run.status },
          ...(event.operation ? { operation: { id: event.operation.id, status: event.operation.status } } : {})
        };
      }
    });

    await expect(chat.cancelBackendRun("run-a")).resolves.toMatchObject({
      id: "run-a",
      status: "outcome_unknown",
      phase: "settled",
      error_code: "backend_cancel_unconfirmed"
    });
    expect(notifiedEvents).toEqual(["run_failed"]);
    expect(completion).toEqual({ run: { status: "outcome_unknown" }, operation: { id: "operation:run-a", status: "failed" } });
    expect(eventRows).toHaveLength(1);
    expect(activityRow.record).toMatchObject({ status: "outcome_unknown", failure: { code: "backend_cancel_unconfirmed" } });
  });

  it("reads legacy session-create idempotency rows as operation records", async () => {
    const createdAt = new Date("2026-09-03T00:00:00.000Z");
    const updatedAt = new Date("2026-09-03T00:01:00.000Z");
    const session = {
      workspace_id: "workspace-a",
      id: "session-a",
      session_key: "workspace:workspace-a:thread-a",
      room_id: "room-a",
      title: "A session",
      ui_locale: "ja",
      output_locale: "ja",
      created_at: createdAt,
      updated_at: updatedAt
    };
    const legacyOperation = {
      workspace_id: "workspace-a",
      id: "session_create:operation-a",
      session_id: "session-a",
      room_id: "room-a",
      operation: "runtime.chat.session.create",
      status: "completed",
      payload: { input_hash: "input-hash", session_id: "session-a" },
      created_at: createdAt,
      updated_at: updatedAt
    };
    const database = {
      withContext: async (_context: unknown, action: (sql: { query: (text: string) => Promise<{ rows: unknown[] }> }) => Promise<unknown>) => action({
        query: async (text) => {
          if (text.includes("FROM workspace_runtime_sessions WHERE")) return { rows: [session] };
          if (text.includes("SELECT workspace_id, id, session_id, room_id, operation, status, payload")) return { rows: [legacyOperation] };
          return { rows: [] };
        }
      })
    } as unknown as PostgresWorkspaceDatabase;
    const chat = new PostgresRuntimeChat({
      database,
      workspaceId: "workspace-a",
      accountId: "account-a",
      backendRegistry: { statuses: () => [] } as unknown as AgentBackendRegistry,
      agentWorktreeRoot: "/tmp/samurai-agent-sessions",
      coreWorkspaceRoot: "/tmp/samurai-core-sessions"
    });

    await expect(chat.getSessionDetail("session-a")).resolves.toMatchObject({
      session: { id: "session-a" },
      operations: [{
        id: "session_create:operation-a",
        session_id: "session-a",
        operation: "runtime.chat.session.create",
        input_hash: "input-hash",
        status: "completed"
      }]
    });
  });

  it("stores a complete operation record for new sessions", async () => {
    let storedPayload: Record<string, unknown> | undefined;
    const database = {
      withContext: async (_context: unknown, action: (sql: { query: (text: string, values?: readonly unknown[]) => Promise<{ rows: unknown[] }> }) => Promise<unknown>) => action({
        query: async (text, values) => {
          if (text.includes("samurai_can_room")) return { rows: [{ allowed: true }] };
          if (text.includes("FROM workspace_runtime_operations") && text.includes("FOR UPDATE")) return { rows: [] };
          if (text.includes("INSERT INTO workspace_runtime_operations")) {
            storedPayload = JSON.parse(String(values?.[4])) as Record<string, unknown>;
          }
          return { rows: [] };
        }
      })
    } as unknown as PostgresWorkspaceDatabase;
    const chat = new PostgresRuntimeChat({
      database,
      workspaceId: "workspace-a",
      accountId: "account-a",
      backendRegistry: { statuses: () => [] } as unknown as AgentBackendRegistry,
      agentWorktreeRoot: "/tmp/samurai-agent-sessions",
      coreWorkspaceRoot: "/tmp/samurai-core-sessions"
    });

    const session = await chat.createSession({ roomId: "room-a", operationId: "operation-a", title: "A session" });

    expect(storedPayload).toMatchObject({
      id: "session_create:operation-a",
      session_id: session.id,
      capability_id: "runtime.chat",
      operation: "runtime.chat.session.create",
      input_hash: expect.any(String),
      status: "completed"
    });
  });

  it("surfaces a completion projection failure so the idempotent request can be retried", async () => {
    let completionAttempts = 0;
    const chat = new PostgresRuntimeChat({
      database: {} as PostgresWorkspaceDatabase,
      workspaceId: "workspace-a",
      accountId: "account-a",
      backendRegistry: { statuses: () => [] } as unknown as AgentBackendRegistry,
      agentWorktreeRoot: "/tmp/samurai-agent-completion",
      coreWorkspaceRoot: "/tmp/samurai-core-completion",
      onCompletionActivity: async () => {
        completionAttempts += 1;
        throw new WorkspaceServerError("workspace_completion_projection_failed", 503);
      }
    });
    const settledResult = {
      session: {
        id: "session-a",
        session_key: "workspace:workspace-a:thread-a",
        room_id: "room-a",
        title: "A session",
        ui_locale: "ja",
        output_locale: "ja",
        created_at: "2026-09-03T00:00:00.000Z",
        updated_at: "2026-09-03T00:00:00.000Z"
      },
      messages: [],
      messagePresentations: [],
      backendRun: {
        id: "run-a",
        session_id: "session-a",
        room_id: "room-a",
        requested_by_participant_id: "account-a",
        input_message_id: "message-a",
        output_message_id: "message-output-a",
        backend_id: "samurai-native",
        backend_kind: "samurai_native",
        status: "completed",
        phase: "settled",
        current_attempt: 1,
        request_idempotency_key: "request-a",
        request_hash: "request-hash-a",
        started_at: "2026-09-03T00:00:00.000Z",
        completed_at: "2026-09-03T00:01:00.000Z",
        input_summary: "A request",
        output_summary: "A response",
        metadata: {}
      },
      backendEvents: [],
      workspaceChanges: [],
      operations: [],
      policyDecisions: [],
      artifacts: [],
      memories: [],
      approvalRequests: [],
      auditRecords: [],
      rollbackPoints: [],
      activity: [],
      reflectionRuns: [],
      reflectionSuggestions: [],
      toolRuns: []
    } as never;
    const notifyCompletionActivity = (chat as unknown as {
      notifyCompletionActivity: (result: unknown, instructionSummary: string) => Promise<void>
    }).notifyCompletionActivity.bind(chat);

    await expect(notifyCompletionActivity(settledResult, "A request")).rejects.toMatchObject({
      code: "workspace_completion_projection_failed",
      status: 503
    });
    expect(completionAttempts).toBe(1);
  });

  it("reprojects settled control replays without rerunning Runtime and surfaces failures", async () => {
    const settledRun = {
      id: "run-settled",
      session_id: "session-a",
      room_id: "room-a",
      status: "completed",
      phase: "settled"
    } as never;
    const projected = {
      session: reservationTestSession(),
      backendRun: settledRun,
      operations: [],
      workspaceChanges: []
    } as never;
    let shouldFail = false;
    let completionAttempts = 0;
    const instructions: string[] = [];
    const chat = new PostgresRuntimeChat({
      database: {} as PostgresWorkspaceDatabase,
      workspaceId: "workspace-a",
      accountId: "account-a",
      backendRegistry: {
        statuses: () => [],
        get: () => { throw new Error("provider must not run for a settled control replay"); }
      } as unknown as AgentBackendRegistry,
      agentWorktreeRoot: "/tmp/samurai-agent-settled-replay",
      coreWorkspaceRoot: "/tmp/samurai-core-settled-replay",
      onCompletionActivity: async (completion) => {
        completionAttempts += 1;
        instructions.push(completion.instructionSummary);
        if (shouldFail) throw new WorkspaceServerError("workspace_completion_projection_failed", 503);
      }
    });
    const internals = chat as unknown as {
      requireControlRun: (runId: string) => Promise<unknown>;
      admissionForRun: (run: unknown) => Promise<{ userMessage: { content: string } }>;
      project: (run: unknown) => Promise<unknown>;
    };
    internals.requireControlRun = async () => settledRun;
    internals.admissionForRun = async () => ({ userMessage: { content: "Canonical request" } });
    internals.project = async () => projected;

    await expect(chat.cancelBackendRun("run-settled")).resolves.toBe(settledRun);
    await expect(chat.resumeBackendRun("run-settled", {})).resolves.toBe(settledRun);
    await expect(chat.syncBackendRun("run-settled")).resolves.toBe(settledRun);
    await expect(chat.recoverBackendRun("run-settled")).resolves.toBe(settledRun);
    expect(completionAttempts).toBe(4);
    expect(instructions).toEqual(["Canonical request", "Canonical request", "Canonical request", "Canonical request"]);

    shouldFail = true;
    await expect(chat.cancelBackendRun("run-settled")).rejects.toMatchObject({
      code: "workspace_completion_projection_failed",
      status: 503
    });
    expect(completionAttempts).toBe(5);
  });

  it("reuses a released session reservation for a new idempotent run", async () => {
    const reservationStatements: string[] = [];
    const database = {
      withContext: async (_context: unknown, action: (sql: { query: (text: string, values?: readonly unknown[]) => Promise<{ rows: unknown[] }> }) => Promise<unknown>) => action({
        query: async (text: string, values: readonly unknown[] = []) => {
          if (text.includes("samurai_can_room")) return { rows: [{ allowed: true }] };
          if (text.startsWith("SELECT * FROM workspace_runtime_runs") && text.includes("request_idempotency_key = $3")) return { rows: [] };
          if (text.startsWith("SELECT run_id FROM workspace_runtime_reservations")) return { rows: [] };
          if (text.startsWith("INSERT INTO workspace_runtime_messages")) return { rows: [] };
          if (text.startsWith("INSERT INTO workspace_runtime_runs")) return { rows: [{}] };
          if (text.startsWith("INSERT INTO workspace_runtime_reservations")) {
            reservationStatements.push(text);
            return { rows: [{ run_id: String(values[2]), status: "held" }] };
          }
          return { rows: [] };
        }
      })
    } as unknown as PostgresWorkspaceDatabase;
    const chat = new PostgresRuntimeChat({
      database,
      workspaceId: "workspace-a",
      accountId: "account-a",
      backendRegistry: { statuses: () => [] } as unknown as AgentBackendRegistry,
      agentWorktreeRoot: "/tmp/samurai-agent-reservation",
      coreWorkspaceRoot: "/tmp/samurai-core-reservation"
    });
    const admit = (chat as unknown as { admit: (input: unknown) => Promise<{ replay: boolean; run: { id: string } }> }).admit.bind(chat);

    const admitted = await admit({
      session: reservationTestSession(),
      backend: { id: "samurai-native", kind: "samurai_native" },
      envelope: reservationTestEnvelope(),
      content: "Second request",
      requestHash: "request-hash-2",
      idempotencyKey: "request-2",
      outputLocale: "ja"
    });

    expect(admitted.replay).toBe(false);
    expect(admitted.run.id).toMatch(/^run_/);
    expect(reservationStatements).toHaveLength(1);
    expect(reservationStatements[0]).toContain("ON CONFLICT (workspace_id, session_id)");
    expect(reservationStatements[0]).toContain("WHERE workspace_runtime_reservations.status = 'released'");
  });

  it("keeps a held session reservation as a stable 409 when the upsert loses a race", async () => {
    const database = {
      withContext: async (_context: unknown, action: (sql: { query: (text: string, values?: readonly unknown[]) => Promise<{ rows: unknown[] }> }) => Promise<unknown>) => action({
        query: async (text: string) => {
          if (text.includes("samurai_can_room")) return { rows: [{ allowed: true }] };
          if (text.startsWith("SELECT * FROM workspace_runtime_runs") && text.includes("request_idempotency_key = $3")) return { rows: [] };
          if (text.startsWith("SELECT run_id FROM workspace_runtime_reservations")) return { rows: [] };
          if (text.startsWith("INSERT INTO workspace_runtime_messages")) return { rows: [] };
          if (text.startsWith("INSERT INTO workspace_runtime_runs")) return { rows: [{}] };
          if (text.startsWith("INSERT INTO workspace_runtime_reservations")) return { rows: [] };
          if (text.startsWith("SELECT run_id, status FROM workspace_runtime_reservations")) {
            return { rows: [{ run_id: "run-in-flight", status: "held" }] };
          }
          return { rows: [] };
        }
      })
    } as unknown as PostgresWorkspaceDatabase;
    const chat = new PostgresRuntimeChat({
      database,
      workspaceId: "workspace-a",
      accountId: "account-a",
      backendRegistry: { statuses: () => [] } as unknown as AgentBackendRegistry,
      agentWorktreeRoot: "/tmp/samurai-agent-reservation-race",
      coreWorkspaceRoot: "/tmp/samurai-core-reservation-race"
    });
    const admit = (chat as unknown as { admit: (input: unknown) => Promise<unknown> }).admit.bind(chat);

    await expect(admit({
      session: reservationTestSession(),
      backend: { id: "samurai-native", kind: "samurai_native" },
      envelope: reservationTestEnvelope(),
      content: "Competing request",
      requestHash: "request-hash-3",
      idempotencyKey: "request-3",
      outputLocale: "ja"
    })).rejects.toMatchObject({
      code: "runtime_session_run_in_progress:run-in-flight",
      status: 409
    });
  });

  it("replays an existing idempotent run without replacing its released reservation", async () => {
    const now = "2026-09-03T00:00:00.000Z";
    const existingRun = {
      workspace_id: "workspace-a",
      id: "run-existing",
      session_id: "session-a",
      room_id: "room-a",
      principal: { kind: "human", participant_id: "account-a" },
      source: { kind: "native_app", app_id: "samurai-native" },
      session_ref: { app_id: "samurai-native", session_id: "session-a" },
      agent_id: null,
      requested_by_participant_id: "account-a",
      input_message_id: "message-existing",
      output_message_id: null,
      backend_id: "samurai-native",
      backend_kind: "samurai_native",
      backend_session_id: null,
      status: "completed",
      phase: "settled",
      current_attempt: 1,
      request_idempotency_key: "request-replay",
      request_hash: "request-hash-replay",
      started_at: now,
      completed_at: now,
      input_summary: "Existing request",
      output_summary: "Existing response",
      error_code: null,
      metadata: {}
    };
    const message = {
      workspace_id: "workspace-a",
      id: "message-existing",
      session_id: "session-a",
      role: "user",
      content: "Existing request",
      input_locale: "ja",
      output_locale: "ja",
      envelope: reservationTestEnvelope(),
      created_at: now
    };
    let savedOperation: Record<string, unknown> | undefined;
    let reservationQueryCount = 0;
    const database = {
      withContext: async (_context: unknown, action: (sql: { query: (text: string, values?: readonly unknown[]) => Promise<{ rows: unknown[] }> }) => Promise<unknown>) => action({
        query: async (text: string, values: readonly unknown[] = []) => {
          if (text.includes("samurai_can_room")) return { rows: [{ allowed: true }] };
          if (text.startsWith("SELECT * FROM workspace_runtime_runs") && text.includes("request_idempotency_key = $3")) return { rows: [existingRun] };
          if (text.includes("FROM workspace_runtime_messages")) return { rows: [message] };
          if (text.includes("FROM workspace_runtime_activities")) return { rows: [] };
          if (text.startsWith("SELECT workspace_id, id, session_id, room_id, operation, status, payload")) {
            return { rows: savedOperation ? [operationRow(savedOperation)] : [] };
          }
          if (text.startsWith("INSERT INTO workspace_runtime_operations")) {
            savedOperation = JSON.parse(String(values[6])) as Record<string, unknown>;
            return { rows: [] };
          }
          if (text.includes("workspace_runtime_reservations")) {
            reservationQueryCount += 1;
            return { rows: [] };
          }
          return { rows: [] };
        }
      })
    } as unknown as PostgresWorkspaceDatabase;
    const chat = new PostgresRuntimeChat({
      database,
      workspaceId: "workspace-a",
      accountId: "account-a",
      backendRegistry: { statuses: () => [] } as unknown as AgentBackendRegistry,
      agentWorktreeRoot: "/tmp/samurai-agent-reservation-replay",
      coreWorkspaceRoot: "/tmp/samurai-core-reservation-replay"
    });
    const admit = (chat as unknown as { admit: (input: unknown) => Promise<{ replay: boolean; run: { id: string } }> }).admit.bind(chat);

    const replayed = await admit({
      session: reservationTestSession(),
      backend: { id: "samurai-native", kind: "samurai_native" },
      envelope: reservationTestEnvelope(),
      content: "Existing request",
      requestHash: "request-hash-replay",
      idempotencyKey: "request-replay",
      outputLocale: "ja"
    });

    expect(replayed).toMatchObject({ replay: true, run: { id: "run-existing" } });
    expect(reservationQueryCount).toBe(0);
  });
});

describe("PostgresRuntimeChat provider tool execution", () => {
  it("fails unsupported provider tools closed and preserves the run_failed error code", async () => {
    const chat = bareChat();
    const executeToolCall = (chat as unknown as {
      executeToolCall: (input: { admission: unknown; started: BackendEventRecord; eventBridge: unknown }) => Promise<{ status: string; errorCode?: string }>
    }).executeToolCall.bind(chat);
    const outcome = await executeToolCall({ admission: {}, started: startedEvent("unknown-tool", "shell", "shell.execute"), eventBridge: {} });

    expect(outcome).toMatchObject({ status: "failed", errorCode: "runtime_tool_unsupported" });
    const failureEvent = (chat as unknown as {
      failureEvent: (run: unknown, error: unknown, bridge: BackendEventBridge) => BackendEventRecord
    }).failureEvent.bind(chat)({}, new WorkspaceServerError(outcome.errorCode!, 409), new BackendEventBridge({ runId: "run-a", sessionId: "session-a", attemptNo: 1 }));
    expect(failureEvent).toMatchObject({ event_type: "run_failed", payload: { error_code: "runtime_tool_unsupported" } });
  });

  it("reports a missing Host tool port as an explicit failed tool result", async () => {
    const chat = bareChat();
    const executeToolCall = (chat as unknown as {
      executeToolCall: (input: { admission: unknown; runInput: BackendRunInput; started: BackendEventRecord; eventBridge: unknown }) => Promise<{ status: string; errorCode?: string }>
    }).executeToolCall.bind(chat);
    const outcome = await executeToolCall({
      admission: {},
      runInput: {} as BackendRunInput,
      started: startedEvent("artifact-tool", "create_artifact", "artifact.create"),
      eventBridge: {}
    });

    expect(outcome).toMatchObject({ status: "failed", errorCode: "runtime_tool_execution_unavailable" });
  });

  it("executes create_artifact through the injected port and persists the complete event chain", async () => {
    const now = "2026-09-03T00:00:00.000Z";
    const artifactRef = { kind: "artifact", id: "artifact-a", uri: "artifacts/artifact-a.md" };
    const runRow: Record<string, unknown> = {
      workspace_id: "workspace-a",
      id: "run-a",
      session_id: "session-a",
      room_id: "room-a",
      principal: { kind: "human", participant_id: "account-a" },
      source: { kind: "native_app", app_id: "samurai-native" },
      session_ref: { app_id: "samurai-native", session_id: "session-a" },
      agent_id: null,
      requested_by_participant_id: "account-a",
      input_message_id: "message-a",
      output_message_id: null,
      backend_id: "samurai-native",
      backend_kind: "samurai_native",
      backend_session_id: null,
      status: "running",
      phase: "external_running",
      current_attempt: 1,
      request_idempotency_key: "request-a",
      request_hash: "request-hash-a",
      started_at: now,
      completed_at: null,
      input_summary: "Create an artifact",
      output_summary: null,
      error_code: null,
      metadata: {}
    };
    const mainOperation = {
      id: "operation:run-a",
      session_id: "session-a",
      run_id: "run-a",
      capability_id: "runtime.chat",
      operation: "runtime.chat",
      actor_identity: "owner" as const,
      participant_id: "account-a",
      participant_kind: "human" as const,
      requested_by_participant_id: "account-a",
      room_id: "room-a",
      principal: { kind: "human" as const, participant_id: "account-a" },
      source: { kind: "native_app" as const, app_id: "samurai-native" },
      session_ref: { app_id: "samurai-native", session_id: "session-a" },
      instruction_source: "owner_instruction" as const,
      instruction_authority: "room_execute",
      channel: "web",
      input_hash: "request-hash-a",
      input_ref: { kind: "message", id: "message-a", uri: "runtime://messages/message-a" },
      target_resource_refs: [],
      proposed_effects: ["runtime.chat"],
      status: "created" as const,
      correlation_id: "run-a",
      created_at: now,
      updated_at: now
    };
    const activity = {
      id: "activity-a",
      workspace_id: "workspace-a",
      room_id: "room-a",
      principal: { kind: "human" as const, participant_id: "account-a" },
      source: { kind: "native_app" as const, app_id: "samurai-native" },
      status: "recording" as const,
      idempotency_key: "chat:session-a:request-a",
      instruction_summary: "Create an artifact",
      verification: [],
      session_ref: { app_id: "samurai-native", session_id: "session-a" },
      backend_run_id: "run-a",
      domain_operation_ids: ["operation:run-a"],
      provenance: { kind: "host" as const, source_id: "run-a", recorded_at: now },
      created_at: now,
      updated_at: now
    };
    const events = new Map<string, Record<string, unknown>>();
    const operations = new Map<string, Record<string, unknown>>([[mainOperation.id, operationRow(mainOperation)]]);
    let activityRow: Record<string, unknown> = { ...activityRowFor(activity) };
    const notified: string[] = [];
    let startedEvent: BackendEventRecord | undefined;
    let failNextExecution = false;
    let executeCount = 0;
    const database = {
      withContext: async (_context: unknown, action: (sql: { query: (text: string, values?: readonly unknown[]) => Promise<{ rows: unknown[]; rowCount?: number }> }) => Promise<unknown>) => action({
        query: async (text: string, values: readonly unknown[] = []) => {
          if (text.includes("samurai_can_room")) return { rows: [{ allowed: true }] };
          if (text.includes("SELECT MAX(sequence)")) return { rows: [{ max_sequence: Math.max(0, ...[...events.values()].map((event) => Number(event.sequence ?? 0))) }] };
          if (text.includes("SELECT status, phase FROM workspace_runtime_runs")) return { rows: [{ status: runRow.status, phase: runRow.phase }] };
          if (text.includes("FROM workspace_runtime_runs WHERE") && text.includes("FOR UPDATE")) return { rows: [runRow] };
          if (text.includes("FROM workspace_runtime_operations") && text.includes("FOR UPDATE")) return { rows: operationsForQuery(operations, values[1]) };
          if (text.includes("FROM workspace_runtime_operations")) return { rows: operationsForQuery(operations, values[1]) };
          if (text.startsWith("INSERT INTO workspace_runtime_operations")) {
            const payload = JSON.parse(String(values[6])) as Record<string, unknown>;
            operations.set(String(values[1]), operationRow(payload));
            return { rows: [] };
          }
          if (text.startsWith("UPDATE workspace_runtime_operations")) {
            const payload = JSON.parse(String(values[4])) as Record<string, unknown>;
            operations.set(String(values[1]), operationRow(payload));
            return { rows: [operations.get(String(values[1]))] };
          }
          if (text.includes("FROM workspace_runtime_activities")) return { rows: [activityRow] };
          if (text.startsWith("UPDATE workspace_runtime_activities SET record")) {
            activityRow = { ...activityRow, record: JSON.parse(String(values[2])) };
            return { rows: [] };
          }
          if (text.startsWith("UPDATE workspace_runtime_activities SET status")) {
            activityRow = { ...activityRow, status: values[2], record: JSON.parse(String(values[3])) };
            return { rows: [] };
          }
          if (text.startsWith("INSERT INTO workspace_runtime_changes")) return { rows: [] };
          if (text.includes("FROM workspace_audit_entries")) return { rows: [] };
          if (text.includes("samurai_append_workspace_audit")) return { rows: [] };
          if (text.startsWith("SELECT * FROM workspace_runtime_events") && text.includes("source_event_id")) {
            const existing = [...events.values()].find((event) => event.run_id === values[1] && event.source_event_id === values[2]);
            return { rows: existing ? [existing] : [] };
          }
          if (text.startsWith("SELECT * FROM workspace_runtime_events")) return { rows: events.has(String(values[1])) ? [events.get(String(values[1]))] : [] };
          if (text.startsWith("INSERT INTO workspace_runtime_events")) {
            events.set(String(values[1]), {
              workspace_id: values[0],
              id: values[1],
              run_id: values[2],
              session_id: values[3],
              backend_session_id: values[4],
              event_type: values[5],
              sequence: values[6],
              attempt_no: values[7],
              source_event_id: values[8],
              source_sequence: values[9],
              payload: JSON.parse(String(values[10])),
              resource_refs: JSON.parse(String(values[11])),
              created_at: values[12]
            });
            return { rows: [] };
          }
          if (text.startsWith("INSERT INTO workspace_runtime_messages")) return { rows: [] };
          if (text.startsWith("UPDATE workspace_runtime_runs")) {
            runRow.status = values[2];
            runRow.phase = values[3];
            runRow.output_message_id = values[4];
            runRow.output_summary = values[5];
            runRow.error_code = values[6];
            runRow.completed_at = values[7];
            return { rows: [runRow] };
          }
          if (text.startsWith("UPDATE workspace_runtime_reservations")) return { rows: [] };
          return { rows: [] };
        }
      })
    } as unknown as PostgresWorkspaceDatabase;
    const chat = new PostgresRuntimeChat({
      database,
      workspaceId: "workspace-a",
      accountId: "account-a",
      backendRegistry: { statuses: () => [] } as unknown as AgentBackendRegistry,
      agentWorktreeRoot: "/tmp/samurai-agent-tool",
      coreWorkspaceRoot: "/tmp/samurai-core-tool",
      availableTools: ["create_artifact"],
      toolExecution: {
        execute: async () => {
          executeCount += 1;
          if (failNextExecution) {
            failNextExecution = false;
            throw new Error("artifact_save_failed");
          }
          return { resourceRefs: [artifactRef], summary: "Artifact saved", output: { artifact_id: artifactRef.id, title: "Draft" } };
        }
      },
      onEvent: async (event) => {
        notified.push(event.event_type);
        if (event.event_type === "tool_call_started") startedEvent = event;
      }
    });
    const admission = {
      session: { id: "session-a", session_key: "workspace:workspace-a:thread-a", room_id: "room-a", title: "A", ui_locale: "ja", output_locale: "ja", created_at: now, updated_at: now },
      userMessage: { id: "message-a", session_id: "session-a", role: "user", content: "Create an artifact", input_locale: "ja", output_locale: "ja", envelope: { id: "envelope-a", source: "web", actor_identity: "owner", session_key: "workspace:workspace-a:thread-a", user_intent: "chat", attachments: [], input_locale: "ja", output_locale: "ja", metadata: {}, received_at: now }, created_at: now },
      run: runRowToRecord(runRow),
      operation: mainOperation,
      activity,
      replay: false
    } as never;
    const stream = (async function* (): AsyncIterable<BackendOutputEvent> {
      yield {
        event_type: "tool_call_started",
        tool_call_id: "tool-a",
        payload: { tool_call_id: "tool-a", provider_tool_name: "create_artifact", action_id: "artifact.create", arguments: { title: "Draft", content: "Hello" } }
      };
      yield { event_type: "run_completed", terminal_evidence: { kind: "completed", source: "owned_loop_return" }, payload: { output_summary: "Artifact saved" } };
    })();
    const executeBackendStream = (chat as unknown as { executeBackendStream: (input: { admission: typeof admission; runInput: BackendRunInput; stream: AsyncIterable<BackendOutputEvent> }) => Promise<unknown> }).executeBackendStream.bind(chat);
    const runInput: BackendRunInput = { run_id: "run-a", session_id: "session-a", room_id: "room-a", envelope: admission.userMessage.envelope, user_input: "Create an artifact", input_locale: "ja", output_locale: "ja", active_memory: [], recent_messages: [], metadata: {} };
    const settled = await executeBackendStream({ admission, runInput, stream });

    expect((settled as { status: string }).status).toBe("completed");
    expect(executeCount).toBe(1);
    expect(notified).toEqual(["tool_call_started", "tool_call_output", "artifact_created", "run_completed"]);
    expect([...events.values()].map((event) => event.event_type)).toEqual(["tool_call_started", "tool_call_output", "artifact_created", "run_completed"]);
    expect([...events.values()].find((event) => event.event_type === "tool_call_output")?.resource_refs).toEqual(expect.arrayContaining([artifactRef]));
    expect(activityRow.record).toMatchObject({
      domain_operation_ids: expect.arrayContaining([expect.stringMatching(/^operation:run-a:tool:/)]),
      verification: expect.arrayContaining([
        expect.objectContaining({ status: "passed", source_operation_id: expect.stringMatching(/^operation:run-a:tool:/) })
      ])
    });

    const executeToolCall = (chat as unknown as {
      executeToolCall: (input: { admission: unknown; runInput: BackendRunInput; started: BackendEventRecord; eventBridge: unknown }) => Promise<{ status: string; output?: unknown }>
    }).executeToolCall.bind(chat);
    const replayed = await executeToolCall({ admission, runInput, started: startedEvent!, eventBridge: {} });
    expect(replayed).toMatchObject({ status: "completed", output: { replayed: true } });
    expect(executeCount).toBe(1);

    failNextExecution = true;
    const failedStarted = {
      ...startedEvent!,
      id: "event-tool-b",
      sequence: 10,
      payload: { ...startedEvent!.payload, tool_call_id: "tool-b", arguments: { title: "Broken", content: "" } }
    };
    const failed = await executeToolCall({ admission, runInput, started: failedStarted, eventBridge: {} });
    expect(failed).toMatchObject({ status: "failed", errorCode: "runtime_tool_execution_failed" });
    expect(executeCount).toBe(2);
    expect([...operations.values()].some((operation) => operation.status === "failed")).toBe(true);
  });
});

function reservationTestSession() {
  return {
    id: "session-a",
    session_key: "workspace:workspace-a:thread-a",
    room_id: "room-a",
    title: "Reservation test",
    ui_locale: "ja",
    output_locale: "ja",
    created_at: "2026-09-03T00:00:00.000Z",
    updated_at: "2026-09-03T00:00:00.000Z"
  };
}

function reservationTestEnvelope() {
  return {
    id: "envelope-a",
    source: "web",
    actor_identity: "owner",
    session_key: "workspace:workspace-a:thread-a",
    user_intent: "chat",
    attachments: [],
    input_locale: "ja",
    output_locale: "ja",
    metadata: {},
    received_at: "2026-09-03T00:00:00.000Z"
  };
}

function bareChat(): PostgresRuntimeChat {
  return new PostgresRuntimeChat({
    database: {} as PostgresWorkspaceDatabase,
    workspaceId: "workspace-a",
    accountId: "account-a",
    backendRegistry: { statuses: () => [] } as unknown as AgentBackendRegistry,
    agentWorktreeRoot: "/tmp/samurai-agent-tool",
    coreWorkspaceRoot: "/tmp/samurai-core-tool"
  });
}

function startedEvent(toolCallId: string, providerToolName: string, actionId: string): BackendEventRecord {
  return {
    id: `event:${toolCallId}`,
    run_id: "run-a",
    session_id: "session-a",
    event_type: "tool_call_started",
    sequence: 1,
    attempt_no: 1,
    payload: {
      tool_call_id: toolCallId,
      provider_tool_name: providerToolName,
      action_id: actionId,
      arguments: {}
    },
    resource_refs: [],
    created_at: "2026-09-03T00:00:00.000Z"
  };
}

function operationRow(operation: Record<string, unknown>): Record<string, unknown> {
  return {
    workspace_id: "workspace-a",
    id: operation.id,
    session_id: operation.session_id ?? null,
    room_id: operation.room_id ?? null,
    operation: operation.operation,
    status: operation.status,
    payload: operation,
    created_at: operation.created_at,
    updated_at: operation.updated_at
  };
}

function operationsForQuery(operations: Map<string, Record<string, unknown>>, id: unknown): Record<string, unknown>[] {
  const operation = operations.get(String(id));
  return operation ? [operation] : [];
}

function activityRowFor(activity: Record<string, unknown>): Record<string, unknown> {
  return {
    workspace_id: "workspace-a",
    id: activity.id,
    room_id: activity.room_id,
    status: activity.status,
    idempotency_key: activity.idempotency_key,
    backend_run_id: activity.backend_run_id,
    record: activity,
    created_at: activity.created_at,
    updated_at: activity.updated_at
  };
}

function runRowToRecord(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    session_id: row.session_id,
    room_id: row.room_id,
    principal: row.principal,
    source: row.source,
    session_ref: row.session_ref,
    requested_by_participant_id: row.requested_by_participant_id,
    input_message_id: row.input_message_id,
    backend_id: row.backend_id,
    backend_kind: row.backend_kind,
    status: row.status,
    phase: row.phase,
    current_attempt: row.current_attempt,
    request_idempotency_key: row.request_idempotency_key,
    request_hash: row.request_hash,
    started_at: row.started_at,
    input_summary: row.input_summary,
    metadata: row.metadata
  };
}
