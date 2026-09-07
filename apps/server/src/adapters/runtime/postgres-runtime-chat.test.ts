import { describe, expect, it, vi } from "vitest";
import type { AgentBackendRegistry, BackendEventRecord, BackendRunInput, BackendOutputEvent } from "@samurai-agent/agent-backends";
import { BackendEventBridge } from "@samurai-agent/runtime";
import { WorkspaceServerError, type PostgresWorkspaceDatabase } from "@samurai-agent/workspace-server";
import { PostgresRuntimeChat } from "./postgres-runtime-chat.js";

describe("PostgresRuntimeChat session projections", () => {
  it("rejects invalid Room Work attachments before Runtime admission", async () => {
    const session = reservationTestSession();
    const agent = {
      id: "agent-a",
      name: "Writer",
      role: "drafting",
      instructions: "Write concise drafts.",
      backendId: "samurai-native",
      configurationVersion: 1,
      enabled: true
    };
    const backend = { id: "samurai-native", kind: "samurai_native" };
    const readWorkspaceFile = vi.fn(async () => ({
      path: "notes/brief.md",
      version: 2,
      sha256: "b".repeat(64),
      content: Buffer.from("brief")
    }));
    const chat = new PostgresRuntimeChat({
      database: {} as PostgresWorkspaceDatabase,
      workspaceId: "workspace-a",
      accountId: "account-a",
      backendRegistry: {
        statuses: () => [],
        get: () => backend
      } as unknown as AgentBackendRegistry,
      agentWorktreeRoot: "/tmp/samurai-agent-attachment-preflight",
      coreWorkspaceRoot: "/tmp/samurai-core-attachment-preflight",
      readWorkspaceFile
    });
    const admission = vi.fn();
    const internals = chat as unknown as {
      getSession: () => Promise<typeof session>;
      relevantKnowledge: () => Promise<[]>;
      resolveAgent: () => Promise<typeof agent>;
      admit: typeof admission;
    };
    internals.getSession = async () => session;
    internals.relevantKnowledge = async () => [];
    internals.resolveAgent = async () => agent;
    internals.admit = admission;

    await expect(chat.runChatTurn({
      sessionId: session.id,
      content: "Use the brief",
      idempotencyKey: "attachment-preflight-invalid",
      attachments: [{ kind: "file", id: "a".repeat(64), uri: "notes/brief.md", version: "2" }],
      executionBinding: {
        workId: "work-a",
        assigneeId: "assignment-a",
        generation: 0,
        agentConfigurationVersion: agent.configurationVersion
      }
    })).rejects.toMatchObject({ code: "runtime_workspace_attachment_reference_mismatch", status: 409 });
    expect(readWorkspaceFile).toHaveBeenCalledTimes(1);
    expect(admission).not.toHaveBeenCalled();
  });

  it("rejects a Room Work attachment without an immutable version before reading or admitting", async () => {
    const session = reservationTestSession();
    const agent = {
      id: "agent-a",
      name: "Writer",
      role: "drafting",
      instructions: "Write concise drafts.",
      backendId: "samurai-native",
      configurationVersion: 1,
      enabled: true
    };
    const readWorkspaceFile = vi.fn();
    const chat = new PostgresRuntimeChat({
      database: {} as PostgresWorkspaceDatabase,
      workspaceId: "workspace-a",
      accountId: "account-a",
      backendRegistry: {
        statuses: () => [],
        get: () => ({ id: "samurai-native", kind: "samurai_native" })
      } as unknown as AgentBackendRegistry,
      agentWorktreeRoot: "/tmp/samurai-agent-attachment-version",
      coreWorkspaceRoot: "/tmp/samurai-core-attachment-version",
      readWorkspaceFile
    });
    const admission = vi.fn();
    const internals = chat as unknown as {
      getSession: () => Promise<typeof session>;
      relevantKnowledge: () => Promise<[]>;
      resolveAgent: () => Promise<typeof agent>;
      admit: typeof admission;
    };
    internals.getSession = async () => session;
    internals.relevantKnowledge = async () => [];
    internals.resolveAgent = async () => agent;
    internals.admit = admission;

    await expect(chat.runChatTurn({
      sessionId: session.id,
      content: "Use the brief",
      idempotencyKey: "attachment-preflight-version-missing",
      attachments: [{ kind: "file", id: "a".repeat(64), uri: "notes/brief.md" }],
      executionBinding: {
        workId: "work-a",
        assigneeId: "assignment-a",
        generation: 0,
        agentConfigurationVersion: agent.configurationVersion
      }
    })).rejects.toMatchObject({ code: "runtime_workspace_attachment_reference_invalid", status: 400 });
    expect(readWorkspaceFile).not.toHaveBeenCalled();
    expect(admission).not.toHaveBeenCalled();
  });

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

  it("serializes admission reads on the single PoolClient supplied by withContext", async () => {
    const createdAt = new Date("2026-09-03T00:00:00.000Z");
    const now = createdAt.toISOString();
    const run = {
      id: "run-serialized",
      session_id: "session-a",
      room_id: "room-a",
      backend_id: "samurai-native",
      backend_kind: "samurai_native",
      status: "running",
      phase: "external_running",
      current_attempt: 1,
      input_message_id: "message-serialized",
      started_at: now,
      input_summary: "A request",
      metadata: {}
    };
    const operation = {
      id: "operation:run-serialized",
      session_id: "session-a",
      room_id: "room-a",
      capability_id: "runtime.chat",
      operation: "runtime.chat",
      actor_identity: "owner" as const,
      instruction_source: "owner_instruction" as const,
      instruction_authority: "room_execute" as const,
      channel: "web" as const,
      input_hash: "request-hash-serialized",
      input_ref: { kind: "message" as const, id: "message-serialized", uri: "runtime://messages/message-serialized" },
      target_resource_refs: [],
      proposed_effects: ["runtime.chat"],
      status: "created" as const,
      correlation_id: "run-serialized",
      created_at: now,
      updated_at: now
    };
    const activity = {
      id: "activity-serialized",
      workspace_id: "workspace-a",
      room_id: "room-a",
      principal: { kind: "human" as const, participant_id: "account-a" },
      source: { kind: "native_app" as const, app_id: "samurai-native" },
      status: "recording" as const,
      idempotency_key: "chat:session-a:serialized",
      instruction_summary: "A request",
      verification: [],
      session_ref: { app_id: "samurai-native", session_id: "session-a" },
      backend_run_id: "run-serialized",
      domain_operation_ids: ["operation:run-serialized"],
      provenance: { kind: "host" as const, source_id: "run-serialized", recorded_at: now },
      created_at: now,
      updated_at: now
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
      id: "message-serialized",
      session_id: "session-a",
      role: "user",
      content: "A request",
      input_locale: "ja",
      output_locale: "ja",
      envelope: null,
      created_at: createdAt
    };
    let inFlight = 0;
    let maxInFlight = 0;
    const queryTexts: string[] = [];
    const database = {
      withContext: async (_context: unknown, action: (sql: { query: (text: string, values?: readonly unknown[]) => Promise<{ rows: unknown[] }> }) => Promise<unknown>) => action({
        query: async (text: string) => {
          queryTexts.push(text);
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 0));
          try {
            if (text.includes("samurai_can_room")) return { rows: [{ allowed: true }] };
            if (text.includes("workspace_runtime_sessions")) return { rows: [sessionRow] };
            if (text.includes("workspace_runtime_messages")) return { rows: [messageRow] };
            if (text.includes("workspace_runtime_operations")) return { rows: [operationRow(operation)] };
            if (text.includes("workspace_runtime_activities")) return { rows: [activityRowFor(activity)] };
            return { rows: [] };
          } finally {
            inFlight -= 1;
          }
        }
      })
    } as unknown as PostgresWorkspaceDatabase;
    const chat = new PostgresRuntimeChat({
      database,
      workspaceId: "workspace-a",
      accountId: "account-a",
      backendRegistry: { statuses: () => [] } as unknown as AgentBackendRegistry,
      agentWorktreeRoot: "/tmp/samurai-agent-admission-serialization",
      coreWorkspaceRoot: "/tmp/samurai-core-admission-serialization"
    });

    const admissionForRun = (chat as unknown as {
      admissionForRun: (value: unknown) => Promise<{ session: { id: string }; userMessage: { id: string }; operation: { id: string }; activity: { id: string } }>
    }).admissionForRun.bind(chat);
    await expect(admissionForRun(run)).resolves.toMatchObject({
      session: { id: "session-a" },
      userMessage: { id: "message-serialized" },
      operation: { id: "operation:run-serialized" },
      activity: { id: "activity-serialized" }
    });
    expect(maxInFlight).toBe(1);
    expect(queryTexts.map((text) => text.includes("samurai_can_room") ? "permission" : text.includes("workspace_runtime_sessions") ? "session" : text.includes("workspace_runtime_messages") ? "message" : text.includes("workspace_runtime_operations") ? "operation" : "activity")).toEqual([
      "permission",
      "session",
      "message",
      "operation",
      "activity"
    ]);
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

  it("rejects Room execution when no default Agent is configured", async () => {
    const queries: string[] = [];
    const database = {
      withContext: async (_context: unknown, action: (sql: { query: (text: string) => Promise<{ rows: unknown[] }> }) => Promise<unknown>) => action({
        query: async (text) => {
          queries.push(text);
          if (text.includes("samurai_can_room")) return { rows: [{ allowed: true }] };
          if (text.includes("FROM rooms")) return { rows: [{ default_agent_id: null, default_agent_version: null }] };
          return { rows: [] };
        }
      })
    } as unknown as PostgresWorkspaceDatabase;
    const chat = new PostgresRuntimeChat({
      database,
      workspaceId: "workspace-a",
      accountId: "account-a",
      backendRegistry: { statuses: () => [] } as unknown as AgentBackendRegistry,
      agentWorktreeRoot: "/tmp/samurai-agent-room-default",
      coreWorkspaceRoot: "/tmp/samurai-core-room-default"
    });
    const resolveAgent = (chat as unknown as {
      resolveAgent: (roomId: string, requestedAgentId?: string) => Promise<unknown>
    }).resolveAgent.bind(chat);

    await expect(resolveAgent("room-a")).rejects.toMatchObject({
      code: "runtime_room_default_agent_missing",
      status: 409
    });
    expect(queries.some((text) => text.includes("FROM workspace_agents"))).toBe(false);
  });

  it("resolves the Room default Agent from its canonical profile and version", async () => {
    const database = {
      withContext: async (_context: unknown, action: (sql: { query: (text: string) => Promise<{ rows: unknown[] }> }) => Promise<unknown>) => action({
        query: async (text) => {
          if (text.includes("samurai_can_room")) return { rows: [{ allowed: true }] };
          if (text.includes("FROM rooms")) return { rows: [{ default_agent_id: "agent-a", default_agent_version: "7" }] };
          if (text.includes("FROM workspace_agents")) return {
            rows: [{
              id: "agent-a",
              display_name: "Writer",
              description: "legacy description must not win",
              role: "drafting",
              instructions: "Write concise drafts.",
              enabled: true,
              backend_id: "samurai-native",
              status: "active",
              configuration_version: "7"
            }]
          };
          return { rows: [] };
        }
      })
    } as unknown as PostgresWorkspaceDatabase;
    const chat = new PostgresRuntimeChat({
      database,
      workspaceId: "workspace-a",
      accountId: "account-a",
      backendRegistry: { statuses: () => [] } as unknown as AgentBackendRegistry,
      agentWorktreeRoot: "/tmp/samurai-agent-room-agent",
      coreWorkspaceRoot: "/tmp/samurai-core-room-agent"
    });
    const resolveAgent = (chat as unknown as {
      resolveAgent: (roomId: string, requestedAgentId?: string) => Promise<unknown>
    }).resolveAgent.bind(chat);

    await expect(resolveAgent("room-a")).resolves.toEqual({
      id: "agent-a",
      name: "Writer",
      role: "drafting",
      instructions: "Write concise drafts.",
      backendId: "samurai-native",
      configurationVersion: 7,
      enabled: true
    });
  });

  it("accepts zero as the initial Room Work generation before backend admission", async () => {
    const createdAt = new Date("2026-09-03T00:00:00.000Z");
    const database = {
      withContext: async (_context: unknown, action: (sql: { query: (text: string) => Promise<{ rows: unknown[] }> }) => Promise<unknown>) => action({
        query: async (text) => {
          if (text.includes("FROM workspace_runtime_sessions")) return {
            rows: [{
              workspace_id: "workspace-a",
              id: "session-a",
              session_key: "workspace:workspace-a:thread-a",
              room_id: "room-a",
              title: "A session",
              ui_locale: "ja",
              output_locale: "ja",
              created_at: createdAt,
              updated_at: createdAt
            }]
          };
          if (text.includes("samurai_can_room")) return { rows: [{ allowed: true }] };
          if (text.includes("FROM rooms")) return { rows: [{ default_agent_id: "agent-a", default_agent_version: 7 }] };
          if (text.includes("FROM workspace_agents")) return {
            rows: [{
              id: "agent-a",
              display_name: "Writer",
              role: "drafting",
              instructions: "Write concise drafts.",
              enabled: true,
              backend_id: "samurai-native",
              status: "active",
              configuration_version: 7
            }]
          };
          return { rows: [] };
        }
      })
    } as unknown as PostgresWorkspaceDatabase;
    const chat = new PostgresRuntimeChat({
      database,
      workspaceId: "workspace-a",
      accountId: "account-a",
      backendRegistry: {
        statuses: () => [],
        get: () => undefined
      } as unknown as AgentBackendRegistry,
      agentWorktreeRoot: "/tmp/samurai-agent-room-generation",
      coreWorkspaceRoot: "/tmp/samurai-core-room-generation"
    });

    // A generation of zero must pass binding validation. The intentionally
    // unregistered backend then stops the test before any admission writes.
    await expect(chat.runChatTurn({
      sessionId: "session-a",
      content: "Do the work",
      idempotencyKey: "request-a",
      executionBinding: {
        workId: "work-a",
        assigneeId: "assignment-a",
        generation: 0,
        agentConfigurationVersion: 7
      }
    })).rejects.toMatchObject({
      code: "runtime_backend_not_registered:samurai-native",
      status: 409
    });
  });

  it("passes the persisted work association as typed execution context, not generic metadata", async () => {
    const backend = { kind: "samurai_native" };
    const chat = new PostgresRuntimeChat({
      database: {} as PostgresWorkspaceDatabase,
      workspaceId: "workspace-a",
      accountId: "account-a",
      backendRegistry: {
        statuses: () => [],
        get: () => backend
      } as unknown as AgentBackendRegistry,
      agentWorktreeRoot: "/tmp/samurai-agent-execution-context",
      coreWorkspaceRoot: "/tmp/samurai-core-execution-context",
      availableTools: ["create_artifact", "subagent_delegate"],
      toolExecution: {
        execute: async () => ({ resourceRefs: [], summary: "" }),
        delegate: async () => ({ resourceRefs: [], summary: "" })
      }
    });
    const backendRunInputForControl = (chat as unknown as {
      backendRunInputForControl: (admission: unknown) => BackendRunInput
    }).backendRunInputForControl.bind(chat);
    const agent = {
      id: "agent-a",
      name: "Writer",
      role: "drafting",
      instructions: "Write concise drafts.",
      backendId: "samurai-native",
      configurationVersion: 7,
      enabled: true
    };
    const run = {
      id: "run-a",
      session_id: "session-a",
      room_id: "room-a",
      agent_id: "agent-a",
      backend_id: "samurai-native",
      backend_session_id: null,
      metadata: {
        request_metadata: "keep",
        runtime_continuation: {
          mode: "reconstructed",
          source: "samurai_context",
          reason: "candidate_mismatch"
        },
        runtime_binding: {
          workspace_id: "workspace-a",
          room_id: "room-a",
          session_id: "session-a",
          work_id: "work-a",
          assignee_id: "assignment-a",
          agent_id: "agent-a",
          agent_configuration_version: 7,
          backend_id: "samurai-native",
          // Human Work's initial control generation is zero.
          generation: 0,
          agent: {
            name: "Writer",
            role: "drafting",
            instructions: "Write concise drafts.",
            enabled: true,
            backend_id: "samurai-native",
            config_version: "7"
          }
        }
      }
    };
    const input = backendRunInputForControl({
      session: reservationTestSession(),
      agent,
      userMessage: {
        id: "message-a",
        session_id: "session-a",
        content: "Do the work",
        input_locale: "ja",
        output_locale: "ja",
        envelope: reservationTestEnvelope(),
        created_at: "2026-09-03T00:00:00.000Z"
      },
      run,
      operation: {},
      activity: {},
      replay: false
    });

    expect(input.execution_context).toEqual({
      agent: {
        id: "agent-a",
        name: "Writer",
        role: "drafting",
        instructions: "Write concise drafts.",
        enabled: true,
        backend_id: "samurai-native",
        config_version: "7"
      },
      association: {
        workspace_id: "workspace-a",
        room_id: "room-a",
        work_id: "work-a",
        assignee_id: "assignment-a",
        backend_id: "samurai-native",
        generation: 0
      },
      credential_boundary: "provider_api",
      continuity: "samurai_context",
      continuity_state: {
        mode: "reconstructed",
        source: "samurai_context",
        reason: "candidate_mismatch"
      }
    });
    expect(input.metadata).toEqual({ request_metadata: "keep" });
    expect(input.metadata).not.toHaveProperty("runtime_binding");
    expect(input.available_tools).toEqual(["create_artifact", "subagent_delegate"]);

    const normalChatInput = backendRunInputForControl({
      session: reservationTestSession(),
      agent,
      userMessage: {
        id: "message-normal",
        session_id: "session-a",
        content: "Normal chat",
        input_locale: "ja",
        output_locale: "ja",
        envelope: reservationTestEnvelope(),
        created_at: "2026-09-03T00:00:00.000Z"
      },
      run: { ...run, id: "run-normal", metadata: { request_metadata: "keep" } },
      operation: {},
      activity: {},
      replay: false
    });
    expect(normalChatInput.available_tools).toEqual(["create_artifact"]);
  });

  it("uses the external Backend resume path for a Room-work continuation", async () => {
    const session = reservationTestSession();
    const agent = {
      id: "agent-a",
      name: "Operator",
      role: "execution",
      instructions: "Continue the assigned work.",
      backendId: "claude-code",
      configurationVersion: 7,
      enabled: true
    };
    const childRun = {
      id: "run-child",
      session_id: session.id,
      room_id: session.room_id,
      agent_id: agent.id,
      backend_id: "claude-code",
      backend_kind: "claude_code",
      status: "queued",
      phase: "admitted",
      current_attempt: 1,
      input_message_id: "message-child",
      started_at: "2026-09-03T00:00:00.000Z",
      input_summary: "Continue the assigned work.",
      metadata: {}
    };
    const admission = {
      session,
      agent,
      userMessage: {
        id: "message-child",
        session_id: session.id,
        role: "user",
        content: "Continue the assigned work.",
        input_locale: "ja",
        output_locale: "ja",
        envelope: reservationTestEnvelope(),
        created_at: "2026-09-03T00:00:00.000Z"
      },
      run: childRun,
      operation: {},
      activity: {},
      replay: false
    };
    const resumeRun = vi.fn((_runId: string, _input: Record<string, unknown>) => (async function* (): AsyncIterable<BackendOutputEvent> {
      yield { event_type: "run_completed", terminal_evidence: { kind: "completed", source: "owned_loop_return" }, payload: {} };
    })());
    const runTurn = vi.fn(() => { throw new Error("new external session must not be started"); });
    const backend = {
      id: "claude-code",
      kind: "claude_code",
      resumeRun,
      runTurn,
      sessionPolicy: { acquisition: "provider_event", resume: "native" },
      execution_owner: "tool_bridge"
    };
    const chat = new PostgresRuntimeChat({
      database: {} as PostgresWorkspaceDatabase,
      workspaceId: "workspace-a",
      accountId: "account-a",
      backendRegistry: {
        get: () => backend,
        status: () => ({ configured: true, enabled: true, connection_state: "ready" })
      } as unknown as AgentBackendRegistry,
      agentWorktreeRoot: "/tmp/samurai-agent-continuation",
      coreWorkspaceRoot: "/tmp/samurai-core-continuation"
    });
    const internals = chat as unknown as {
      getSession: (sessionId: string) => Promise<typeof session>;
      relevantKnowledge: () => Promise<[]>;
      resolveAgent: () => Promise<typeof agent>;
      listMessages: () => Promise<[]>;
      admit: () => Promise<typeof admission>;
      transitionToExternalRunning: () => Promise<void>;
      executeBackendStream: (input: { runInput: BackendRunInput; stream: AsyncIterable<BackendOutputEvent> }) => Promise<typeof childRun>;
      project: (run: typeof childRun) => Promise<{ backendRun: typeof childRun }>;
    };
    internals.getSession = async () => session;
    internals.relevantKnowledge = async () => [];
    internals.resolveAgent = async () => agent;
    internals.listMessages = async () => [];
    internals.admit = async () => admission;
    internals.transitionToExternalRunning = async () => undefined;
    internals.executeBackendStream = async ({ runInput, stream }) => {
      expect(runInput.backend_session_id).toBe("claude-session-parent");
      expect(runInput.execution_context).toMatchObject({
        continuity_state: {
          mode: "resumed",
          source: "external_session"
        }
      });
      expect(stream).toBeDefined();
      return childRun;
    };
    internals.project = async (run) => ({ backendRun: run });

    await chat.runChatTurn({
      sessionId: session.id,
      content: "Continue the assigned work.",
      idempotencyKey: "room-work-continuation",
      executionBinding: {
        workId: "work-a",
        assigneeId: "assignment-child",
        parentAssigneeId: "assignment-parent",
        generation: 0,
        agentConfigurationVersion: agent.configurationVersion
      },
      resumeBackendContinuation: {
        backendSessionId: "claude-session-parent",
        parent: {
          workspaceId: "workspace-a",
          roomId: "room-a",
          sessionId: session.id,
          workId: "work-a",
          assigneeId: "assignment-parent",
          agentId: agent.id,
          agentConfigurationVersion: agent.configurationVersion,
          backendId: "claude-code",
          generation: 0
        }
      },
      // A Room-work caller cannot override the Store-derived candidate with a
      // raw provider Session ID.
      resumeBackendSessionId: "untrusted-provider-session"
    });

    expect(resumeRun).toHaveBeenCalledWith("run-child", expect.objectContaining({
      backend_session_id: "claude-session-parent",
      user_input: "Continue the assigned work."
    }));
    expect(runTurn).not.toHaveBeenCalled();
  });

  it("records a reconstruction reason when the external continuation candidate mismatches", async () => {
    const session = reservationTestSession();
    const agent = {
      id: "agent-a",
      name: "Operator",
      role: "execution",
      instructions: "Continue the assigned work.",
      backendId: "claude-code",
      configurationVersion: 7,
      enabled: true
    };
    const childRun = {
      id: "run-child-mismatch",
      session_id: session.id,
      room_id: session.room_id,
      agent_id: agent.id,
      backend_id: "claude-code",
      backend_kind: "claude_code",
      status: "queued",
      phase: "admitted",
      current_attempt: 1,
      input_message_id: "message-child-mismatch",
      started_at: "2026-09-03T00:00:00.000Z",
      input_summary: "Continue the assigned work.",
      metadata: {}
    };
    const admission = {
      session,
      agent,
      userMessage: {
        id: "message-child-mismatch",
        session_id: session.id,
        role: "user",
        content: "Continue the assigned work.",
        input_locale: "ja",
        output_locale: "ja",
        envelope: reservationTestEnvelope(),
        created_at: "2026-09-03T00:00:00.000Z"
      },
      run: childRun,
      operation: {},
      activity: {},
      replay: false
    };
    const resumeRun = vi.fn();
    const runTurn = vi.fn(() => (async function* (): AsyncIterable<BackendOutputEvent> {
      yield { event_type: "run_completed", terminal_evidence: { kind: "completed", source: "owned_loop_return" }, payload: {} };
    })());
    const backend = {
      id: "claude-code",
      kind: "claude_code",
      resumeRun,
      runTurn,
      sessionPolicy: { acquisition: "provider_event", resume: "native" },
      execution_owner: "tool_bridge"
    };
    const chat = new PostgresRuntimeChat({
      database: {} as PostgresWorkspaceDatabase,
      workspaceId: "workspace-a",
      accountId: "account-a",
      backendRegistry: {
        get: () => backend,
        status: () => ({ configured: true, enabled: true, connection_state: "ready" })
      } as unknown as AgentBackendRegistry,
      agentWorktreeRoot: "/tmp/samurai-agent-continuation-mismatch",
      coreWorkspaceRoot: "/tmp/samurai-core-continuation-mismatch"
    });
    let admittedInput: { continuationState?: unknown } | undefined;
    let backendInput: BackendRunInput | undefined;
    const internals = chat as unknown as {
      getSession: (sessionId: string) => Promise<typeof session>;
      relevantKnowledge: () => Promise<[]>;
      resolveAgent: () => Promise<typeof agent>;
      listMessages: () => Promise<[]>;
      admit: (input: { continuationState?: unknown }) => Promise<typeof admission>;
      transitionToExternalRunning: () => Promise<void>;
      executeBackendStream: (input: { runInput: BackendRunInput; stream: AsyncIterable<BackendOutputEvent> }) => Promise<typeof childRun>;
      project: (run: typeof childRun) => Promise<{ backendRun: typeof childRun }>;
    };
    internals.getSession = async () => session;
    internals.relevantKnowledge = async () => [];
    internals.resolveAgent = async () => agent;
    internals.listMessages = async () => [];
    internals.admit = async (input) => {
      admittedInput = input;
      return admission;
    };
    internals.transitionToExternalRunning = async () => undefined;
    internals.executeBackendStream = async ({ runInput }) => {
      backendInput = runInput;
      return childRun;
    };
    internals.project = async (run) => ({ backendRun: run });

    await chat.runChatTurn({
      sessionId: session.id,
      content: "Continue the assigned work.",
      idempotencyKey: "room-work-continuation-mismatch",
      executionBinding: {
        workId: "work-a",
        assigneeId: "assignment-child",
        parentAssigneeId: "assignment-parent",
        generation: 0,
        agentConfigurationVersion: agent.configurationVersion
      },
      resumeBackendContinuation: {
        backendSessionId: "claude-session-parent",
        parent: {
          workspaceId: "workspace-a",
          roomId: "room-a",
          sessionId: session.id,
          workId: "work-a",
          // A different parent assignment must never resume this child.
          assigneeId: "assignment-from-another-work",
          agentId: agent.id,
          agentConfigurationVersion: agent.configurationVersion,
          backendId: "claude-code",
          generation: 0
        }
      }
    });

    expect(admittedInput?.continuationState).toEqual({
      mode: "reconstructed",
      source: "samurai_context",
      reason: "candidate_mismatch"
    });
    expect(backendInput?.backend_session_id).toBeUndefined();
    expect(backendInput?.execution_context).toMatchObject({
      continuity_state: {
        mode: "reconstructed",
        source: "samurai_context",
        reason: "candidate_mismatch"
      }
    });
    expect(resumeRun).not.toHaveBeenCalled();
    expect(runTurn).toHaveBeenCalledTimes(1);
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
    let lateTerminalAvailable = false;
    const lateTerminalBackend = {
      id: "samurai-native",
      kind: "samurai_native",
      streamEvents: async function* (): AsyncIterable<BackendOutputEvent> {
        yield {
          event_type: "run_completed",
          source_event_id: "provider-terminal-a",
          terminal_evidence: { kind: "completed", source: "provider_terminal_response" },
          payload: { output_summary: "Completed after delayed evidence." }
        };
      }
    };
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
      backendRegistry: {
        statuses: () => [],
        get: () => lateTerminalAvailable ? lateTerminalBackend : undefined
      } as unknown as AgentBackendRegistry,
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

    // The stop request was persisted as unknown, not as cancellation success.
    // A later terminal event is appended and reconciles that same Run.
    lateTerminalAvailable = true;
    await expect(chat.syncBackendRun("run-a")).resolves.toMatchObject({
      id: "run-a",
      status: "completed",
      phase: "settled"
    });
    expect(eventRows.map((event) => event.event_type)).toEqual(["run_failed", "run_completed"]);
    expect(activityRow.record).toMatchObject({ status: "completed" });
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

  it("revalidates Room Work attachment hash before any Runtime admission insert", async () => {
    const statements: string[] = [];
    let admissionValues: readonly unknown[] | undefined;
    const database = {
      withContext: async (_context: unknown, action: (sql: { query: (text: string, values?: readonly unknown[]) => Promise<{ rows: unknown[] }> }) => Promise<unknown>) => action({
        query: async (text: string, values: readonly unknown[] = []) => {
          statements.push(text);
          if (text.includes("samurai_can_room")) return { rows: [{ allowed: true }] };
          if (text.includes("samurai_assert_human_work_runtime_admission")) {
            admissionValues = values;
            return { rows: [] };
          }
          if (text.startsWith("SELECT * FROM workspace_runtime_runs")) return { rows: [] };
          if (text.startsWith("SELECT run_id FROM workspace_runtime_reservations")) return { rows: [] };
          if (text.includes("pg_advisory_xact_lock")) return { rows: [] };
          if (text.includes("FROM workspace_files")) return {
            rows: [{ path: "notes/brief.md", version: 2, sha256: "b".repeat(64) }]
          };
          if (text.startsWith("INSERT INTO workspace_runtime_messages")
            || text.startsWith("INSERT INTO workspace_runtime_runs")
            || text.startsWith("INSERT INTO workspace_runtime_reservations")) {
            throw new Error("Runtime insert must not be reached after attachment rejection");
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
      agentWorktreeRoot: "/tmp/samurai-agent-admission-attachment",
      coreWorkspaceRoot: "/tmp/samurai-core-admission-attachment"
    });
    const admit = (chat as unknown as { admit: (input: unknown) => Promise<unknown> }).admit.bind(chat);
    const attachment = { kind: "file", id: "a".repeat(64), uri: "notes/brief.md", version: "2" };

    await expect(admit({
      session: reservationTestSession(),
      backend: { id: "samurai-native", kind: "samurai_native" },
      envelope: reservationTestEnvelope(),
      content: "Use the brief",
      requestHash: "request-hash-attachment",
      idempotencyKey: "request-attachment",
      outputLocale: "ja",
      attachments: [attachment],
      executionBinding: {
        workspaceId: "workspace-a",
        roomId: "room-a",
        sessionId: "session-a",
        workId: "work-a",
        assigneeId: "assignment-a",
        agentId: "agent-a",
        backendId: "samurai-native",
        generation: 0,
        agentConfigurationVersion: 1,
        reservationId: "reservation-a",
        leaseOwner: "worker-a",
        agent: { name: "Writer", role: "drafting", instructions: "Write.", enabled: true }
      }
    })).rejects.toMatchObject({ code: "runtime_workspace_attachment_reference_mismatch", status: 409 });
    expect(statements.some((text) => text.includes("samurai_assert_human_work_runtime_admission_v2"))).toBe(true);
    expect(admissionValues).toEqual(["workspace-a", "work-a", "assignment-a", 0, "reservation-a", "worker-a"]);
    expect(statements.some((text) => text.startsWith("INSERT INTO workspace_runtime_messages"))).toBe(false);
    expect(statements.some((text) => text.startsWith("INSERT INTO workspace_runtime_runs"))).toBe(false);
    expect(statements.some((text) => text.startsWith("INSERT INTO workspace_runtime_activities"))).toBe(false);
    expect(statements.some((text) => text.startsWith("INSERT INTO workspace_runtime_reservations"))).toBe(false);
  });

  it("reuses a released session reservation for a new idempotent run", async () => {
    const reservationStatements: string[] = [];
    let persistedRunMetadata: Record<string, unknown> | undefined;
    const database = {
      withContext: async (_context: unknown, action: (sql: { query: (text: string, values?: readonly unknown[]) => Promise<{ rows: unknown[] }> }) => Promise<unknown>) => action({
        query: async (text: string, values: readonly unknown[] = []) => {
          if (text.includes("samurai_can_room")) return { rows: [{ allowed: true }] };
          if (text.startsWith("SELECT * FROM workspace_runtime_runs") && text.includes("request_idempotency_key = $3")) return { rows: [] };
          if (text.startsWith("SELECT run_id FROM workspace_runtime_reservations")) return { rows: [] };
          if (text.startsWith("INSERT INTO workspace_runtime_messages")) return { rows: [] };
          if (text.startsWith("INSERT INTO workspace_runtime_runs")) {
            persistedRunMetadata = JSON.parse(String(values[19])) as Record<string, unknown>;
            return { rows: [{}] };
          }
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
      outputLocale: "ja",
      executionBinding: {
        workspaceId: "workspace-a",
        roomId: "room-a",
        sessionId: "session-a",
        workId: "work-a",
        assigneeId: "assignment-a",
        agentId: "agent-a",
        backendId: "samurai-native",
        generation: 0,
        agentConfigurationVersion: 1,
        reservationId: "reservation-a",
        leaseOwner: "worker-a",
        agent: { name: "Writer", role: "drafting", instructions: "Write.", enabled: true }
      }
    });

    expect(admitted.replay).toBe(false);
    expect(admitted.run.id).toMatch(/^run_/);
    expect(persistedRunMetadata?.runtime_binding).toMatchObject({
      reservation_id: "reservation-a",
      lease_owner: "worker-a"
    });
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
          if (text.includes("samurai_assert_human_work_runtime_admission")) {
            throw new Error("stop admission guard must not run for an idempotent replay");
          }
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
      outputLocale: "ja",
      executionBinding: {
        workspaceId: "workspace-a",
        roomId: "room-a",
        sessionId: "session-a",
        workId: "work-closed",
        assigneeId: "assignment-original",
        agentId: "agent-a",
        backendId: "samurai-native",
        generation: 2,
        agentConfigurationVersion: 7,
        agent: {
          name: "Writer",
          role: "drafting",
          instructions: "Write concise drafts.",
          enabled: true
        }
      }
    });

    expect(replayed).toMatchObject({ replay: true, run: { id: "run-existing" } });
    expect(reservationQueryCount).toBe(0);
  });
});

describe("PostgresRuntimeChat provider tool execution", () => {
  it("derives subagent delegation authority from the persisted Run binding", async () => {
    const chat = bareChat();
    const admission = {
      session: { id: "session-a", room_id: "room-a" },
      run: {
        id: "run-a",
        room_id: "room-a",
        session_id: "session-a",
        agent_id: "agent-a",
        backend_id: "samurai-native",
        requested_by_participant_id: "account-a",
        metadata: {
          runtime_binding: {
            workspace_id: "workspace-a",
            room_id: "room-a",
            session_id: "session-a",
            work_id: "work-a",
            assignee_id: "assignment-a",
            agent_id: "agent-a",
            backend_id: "samurai-native",
            generation: 4,
            agent_configuration_version: 7,
            agent: { name: "Writer", role: "drafting", instructions: "Write.", enabled: true }
          }
        }
      }
    };
    const trustedRoomWorkBinding = (chat as unknown as {
      trustedRoomWorkBinding: (value: unknown) => Record<string, unknown>
    }).trustedRoomWorkBinding.bind(chat);

    expect(trustedRoomWorkBinding(admission)).toEqual({
      runId: "run-a",
      workspaceId: "workspace-a",
      roomId: "room-a",
      workId: "work-a",
      assigneeId: "assignment-a",
      parentAssignmentId: "assignment-a",
      agentId: "agent-a",
      generation: 4,
      requestedByParticipantId: "account-a"
    });
    await expect(Promise.resolve().then(() => trustedRoomWorkBinding({
      ...admission,
      run: { ...admission.run, metadata: { runtime_binding: { ...admission.run.metadata.runtime_binding, room_id: "room-other" } } }
    }))).rejects.toThrow("runtime_run_binding_mismatch");
    await expect(Promise.resolve().then(() => trustedRoomWorkBinding({
      ...admission,
      run: {
        ...admission.run,
        metadata: {
          runtime_binding: {
            ...admission.run.metadata.runtime_binding,
            agent: { ...admission.run.metadata.runtime_binding.agent, backend_id: "claude-code" }
          }
        }
      }
    }))).rejects.toThrow("runtime_run_binding_invalid");
    await expect(Promise.resolve().then(() => trustedRoomWorkBinding({
      ...admission,
      run: {
        ...admission.run,
        metadata: {
          runtime_binding: {
            workspace_id: "workspace-a",
            room_id: "room-a",
            session_id: "session-a",
            parent_assignee_id: "assignment-grandparent",
            agent_id: "agent-a",
            backend_id: "samurai-native",
            generation: 4,
            agent_configuration_version: 7,
            agent: { name: "Writer", role: "drafting", instructions: "Write.", enabled: true }
          }
        }
      }
    }))).rejects.toThrow("runtime_run_binding_invalid");
  });

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

  it("rejects a direct delegation event when the admitted Run has no trusted Room-work binding", async () => {
    const delegate = vi.fn();
    const chat = new PostgresRuntimeChat({
      database: {} as PostgresWorkspaceDatabase,
      workspaceId: "workspace-a",
      accountId: "account-a",
      backendRegistry: { statuses: () => [] } as unknown as AgentBackendRegistry,
      agentWorktreeRoot: "/tmp/samurai-agent-delegation-missing-binding",
      coreWorkspaceRoot: "/tmp/samurai-core-delegation-missing-binding",
      availableTools: ["create_artifact", "subagent_delegate"],
      toolExecution: {
        execute: async () => ({ resourceRefs: [], summary: "" }),
        delegate
      }
    });
    const executeToolCall = (chat as unknown as {
      executeToolCall: (input: { admission: unknown; runInput: BackendRunInput; started: BackendEventRecord; eventBridge: unknown }) => Promise<{ status: string; errorCode?: string }>
    }).executeToolCall.bind(chat);
    const outcome = await executeToolCall({
      admission: {
        session: { id: "session-normal", room_id: "room-a" },
        run: {
          id: "run-normal",
          room_id: "room-a",
          session_id: "session-normal",
          agent_id: "agent-a",
          backend_id: "samurai-native",
          requested_by_participant_id: "account-a",
          metadata: {}
        }
      },
      runInput: {} as BackendRunInput,
      started: startedEvent("delegate-without-binding", "subagent_delegate", "room.work.assignee.delegate"),
      eventBridge: {}
    });

    expect(outcome).toMatchObject({ status: "failed", errorCode: "runtime_subagent_binding_missing" });
    expect(delegate).not.toHaveBeenCalled();
  });

  it("executes Native delegation with Run-bound authority and preserves failure state", async () => {
    const operation = {
      id: "operation:run-a:tool:delegate-tool",
      operation: "room.work.assignee.delegate",
      status: "created",
      input_hash: "input-hash",
      room_id: "room-a"
    };
    const delegate = vi.fn(async () => ({
      resourceRefs: [{ kind: "room_work_assignee", id: "child-assignment", uri: "samurai://room-work-assignees/child-assignment" }],
      summary: "Child assignment created",
      output: { assignment_id: "child-assignment" }
    }));
    const settledToolStatuses: string[] = [];
    const chat = new PostgresRuntimeChat({
      database: {} as PostgresWorkspaceDatabase,
      workspaceId: "workspace-a",
      accountId: "account-a",
      backendRegistry: { statuses: () => [] } as unknown as AgentBackendRegistry,
      agentWorktreeRoot: "/tmp/samurai-agent-delegation-tool",
      coreWorkspaceRoot: "/tmp/samurai-core-delegation-tool",
      toolExecution: {
        execute: async () => { throw new Error("artifact path must not run"); },
        delegate
      }
    });
    const internals = chat as unknown as {
      ensureToolOperation: () => Promise<typeof operation>;
      settleToolExecution: (input: { status: string }) => Promise<{ operation: typeof operation; activityRef: Record<string, string> }>;
      executeToolCall: (input: { admission: unknown; runInput: BackendRunInput; started: BackendEventRecord; eventBridge: unknown }) => Promise<{ status: string; errorCode?: string; output?: unknown }>;
    };
    internals.ensureToolOperation = async () => operation;
    internals.settleToolExecution = async (input) => {
      settledToolStatuses.push(input.status);
      return {
        operation: { ...operation, status: input.status },
        activityRef: { kind: "activity", id: "activity-a", uri: "runtime://activities/activity-a" }
      };
    };

    const admission = {
      session: { id: "session-a", room_id: "room-a" },
      run: {
        id: "run-a",
        room_id: "room-a",
        session_id: "session-a",
        agent_id: "agent-parent",
        backend_id: "samurai-native",
        requested_by_participant_id: "account-a",
        metadata: {
          runtime_binding: {
            workspace_id: "workspace-a",
            room_id: "room-a",
            session_id: "session-a",
            work_id: "work-a",
            assignee_id: "assignment-parent",
            agent_id: "agent-parent",
            backend_id: "samurai-native",
            generation: 3,
            agent_configuration_version: 7,
            agent: { name: "Coordinator", role: "lead", instructions: "Coordinate.", enabled: true }
          }
        }
      }
    };
    const started = startedEvent("delegate-tool", "subagent_delegate", "room.work.assignee.delegate");
    started.payload = {
      ...started.payload,
      capability_id: "subagent_delegate",
      arguments: {
        agent_id: "agent-specialist",
        instruction: "Review the draft",
        dependency_assignee_ids: ["assignment-other"],
        attachments: [{ kind: "file", id: "sha256", uri: "notes/brief.md", version: "2" }],
        room_id: "model-room-must-be-ignored",
        work_id: "model-work-must-be-ignored",
        assignee_id: "model-assignee-must-be-ignored",
        requester_id: "model-requester-must-be-ignored",
        expected_generation: 999
      }
    };
    const runInput = {} as BackendRunInput;

    const first = await internals.executeToolCall({ admission, runInput, started, eventBridge: {} });
    expect(first).toMatchObject({ status: "completed", output: { assignment_id: "child-assignment" } });
    expect(delegate).toHaveBeenCalledOnce();
    expect(delegate.mock.calls[0]?.[0]).toMatchObject({
      trustedRoomWorkBinding: {
        runId: "run-a",
        workspaceId: "workspace-a",
        roomId: "room-a",
        workId: "work-a",
        assigneeId: "assignment-parent",
        parentAssignmentId: "assignment-parent",
        agentId: "agent-parent",
        generation: 3,
        requestedByParticipantId: "account-a"
      },
      event: {
        arguments: {
          agent_id: "agent-specialist",
          instruction: "Review the draft",
          dependency_assignee_ids: ["assignment-other"],
          attachments: [{ kind: "file", id: "sha256", uri: "notes/brief.md", version: "2" }]
        }
      }
    });
    const delegatedArguments = delegate.mock.calls[0]?.[0].event.arguments as Record<string, unknown>;
    expect(delegatedArguments).not.toHaveProperty("room_id");
    expect(delegatedArguments).not.toHaveProperty("work_id");
    expect(delegatedArguments).not.toHaveProperty("assignee_id");
    expect(delegatedArguments).not.toHaveProperty("requester_id");
    expect(delegatedArguments).not.toHaveProperty("expected_generation");
    expect(settledToolStatuses).toEqual(["completed"]);

    delegate.mockRejectedValueOnce(new WorkspaceServerError("room_agent_execute_forbidden", 403));
    const failedStarted = {
      ...started,
      id: "event:delegate-tool-failed",
      sequence: 2,
      payload: { ...started.payload, tool_call_id: "delegate-tool-failed", arguments: { agent_id: "agent-specialist", instruction: "Try again" } }
    };
    const failed = await internals.executeToolCall({ admission, runInput, started: failedStarted, eventBridge: {} });
    expect(failed).toMatchObject({ status: "failed", errorCode: "room_agent_execute_forbidden" });
    expect(settledToolStatuses).toEqual(["completed", "failed"]);
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
          if (text.startsWith("UPDATE workspace_runtime_runs") && text.includes("SET backend_session_id")) {
            runRow.backend_session_id = values[2];
            return { rows: [runRow], rowCount: 1 };
          }
          if (text.startsWith("UPDATE workspace_runtime_runs")) {
            runRow.status = values[2];
            runRow.phase = values[3];
            runRow.output_message_id = values[4];
            runRow.output_summary = values[5];
            runRow.error_code = values[6];
            runRow.completed_at = values[7];
            if (text.includes("backend_session_id = COALESCE")) runRow.backend_session_id = values[10];
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
      yield { event_type: "run_completed", backend_session_id: "provider-session-a", terminal_evidence: { kind: "completed", source: "owned_loop_return" }, payload: { output_summary: "Artifact saved" } };
    })();
    const executeBackendStream = (chat as unknown as { executeBackendStream: (input: { admission: typeof admission; runInput: BackendRunInput; stream: AsyncIterable<BackendOutputEvent> }) => Promise<unknown> }).executeBackendStream.bind(chat);
    const runInput: BackendRunInput = { run_id: "run-a", session_id: "session-a", room_id: "room-a", envelope: admission.userMessage.envelope, user_input: "Create an artifact", input_locale: "ja", output_locale: "ja", active_memory: [], recent_messages: [], metadata: {} };
    const settled = await executeBackendStream({ admission, runInput, stream });

    expect((settled as { status: string }).status).toBe("completed");
    expect(runRow.backend_session_id).toBe("provider-session-a");
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

  it("promotes a provider SessionRef from a non-terminal event to the persisted Run", async () => {
    const now = "2026-09-03T00:00:00.000Z";
    const runRow: Record<string, unknown> = {
      workspace_id: "workspace-a",
      id: "run-parent",
      session_id: "session-a",
      room_id: "room-a",
      principal: null,
      source: null,
      session_ref: null,
      agent_id: "agent-a",
      requested_by_participant_id: "account-a",
      input_message_id: "message-a",
      output_message_id: null,
      backend_id: "claude-code",
      backend_kind: "claude_code",
      backend_session_id: null,
      status: "running",
      phase: "external_running",
      current_attempt: 1,
      request_idempotency_key: "request-parent",
      request_hash: "request-hash-parent",
      started_at: now,
      completed_at: null,
      input_summary: "Parent work",
      output_summary: null,
      error_code: null,
      metadata: {}
    };
    const eventRows = new Map<string, Record<string, unknown>>();
    const sessionUpdates: unknown[][] = [];
    const database = {
      withContext: async (_context: unknown, action: (sql: { query: (text: string, values?: readonly unknown[]) => Promise<{ rows: unknown[]; rowCount?: number }> }) => Promise<unknown>) => action({
        query: async (text: string, values: readonly unknown[] = []) => {
          const query = text.trim();
          if (query.startsWith("SELECT status, phase FROM workspace_runtime_runs")) {
            return { rows: [{ status: runRow.status, phase: runRow.phase }] };
          }
          if (query.startsWith("UPDATE workspace_runtime_runs")) {
            if (runRow.backend_session_id && runRow.backend_session_id !== values[2]) return { rows: [], rowCount: 0 };
            sessionUpdates.push([...values]);
            runRow.backend_session_id = values[2];
            return { rows: [runRow], rowCount: 1 };
          }
          if (query.startsWith("SELECT * FROM workspace_runtime_events")) {
            const event = query.includes("source_event_id")
              ? [...eventRows.values()].find((candidate) => candidate.run_id === values[1] && candidate.source_event_id === values[2])
              : eventRows.get(String(values[1]));
            return { rows: event ? [event] : [] };
          }
          if (query.startsWith("INSERT INTO workspace_runtime_events")) {
            eventRows.set(String(values[1]), {
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
          if (query.startsWith("SELECT * FROM workspace_runtime_runs")) return { rows: [runRow] };
          return { rows: [] };
        }
      })
    } as unknown as PostgresWorkspaceDatabase;
    const chat = new PostgresRuntimeChat({
      database,
      workspaceId: "workspace-a",
      accountId: "account-a",
      backendRegistry: { statuses: () => [] } as unknown as AgentBackendRegistry,
      agentWorktreeRoot: "/tmp/samurai-agent-session-ref",
      coreWorkspaceRoot: "/tmp/samurai-core-session-ref"
    });
    const appendEvent = (chat as unknown as {
      appendEvent: (event: BackendEventRecord) => Promise<BackendEventRecord | undefined>
    }).appendEvent.bind(chat);
    const event: BackendEventRecord = {
      id: "event-parent-session",
      run_id: "run-parent",
      session_id: "session-a",
      backend_session_id: "claude-session-parent",
      event_type: "text_delta",
      sequence: 1,
      attempt_no: 1,
      source_event_id: "provider-event-parent-session",
      payload: { text: "working" },
      resource_refs: [],
      created_at: now
    };

    await expect(appendEvent(event)).resolves.toMatchObject({ backend_session_id: "claude-session-parent" });
    expect(sessionUpdates).toEqual([["workspace-a", "run-parent", "claude-session-parent"]]);
    await expect(chat.getBackendRun("run-parent")).resolves.toMatchObject({
      id: "run-parent",
      backend_session_id: "claude-session-parent"
    });

    await expect(appendEvent({ ...event, id: "event-parent-session-conflict", backend_session_id: "another-provider-session" }))
      .rejects.toMatchObject({ code: "runtime_backend_session_conflict:run-parent", status: 409 });
    expect(eventRows).toHaveLength(1);
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
