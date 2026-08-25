import { describe, expect, it } from "vitest";
import type { AgentBackendRegistry } from "@samurai-agent/agent-backends";
import type { PostgresWorkspaceDatabase } from "@samurai-agent/workspace-server";
import { PostgresRuntimeChat } from "./postgres-runtime-chat.js";

function chatWithDatabase(calls: Array<{ text: string; values: readonly unknown[] }>): PostgresRuntimeChat {
  const database = {
    withContext: async (_context: unknown, action: (sql: { query: (text: string, values?: readonly unknown[]) => Promise<{ rows: unknown[] }> }) => Promise<unknown>) => action({
      query: async (text: string, values: readonly unknown[] = []) => {
        calls.push({ text, values });
        return {
          rows: [{
            workspace_id: "workspace-a",
            id: "event-a",
            run_id: "run-a",
            session_id: null,
            backend_session_id: null,
            event_type: "text_delta",
            sequence: 3,
            attempt_no: null,
            source_event_id: null,
            source_sequence: null,
            payload: { text: "ok" },
            resource_refs: [],
            created_at: "2026-08-24T00:00:00.000Z"
          }]
        };
      }
    })
  } as unknown as PostgresWorkspaceDatabase;
  return new PostgresRuntimeChat({
    database,
    workspaceId: "workspace-a",
    accountId: "account-a",
    backendRegistry: { statuses: () => [] } as unknown as AgentBackendRegistry,
    agentWorktreeRoot: "/tmp/samurai-agent-events",
    coreWorkspaceRoot: "/tmp/samurai-core-events"
  });
}

describe("PostgresRuntimeChat backend event pagination", () => {
  it("keeps after_sequence and limit on the PostgreSQL query path", async () => {
    const calls: Array<{ text: string; values: readonly unknown[] }> = [];
    const events = await chatWithDatabase(calls).listBackendEvents({ runId: "run-a", afterSequence: 2, limit: 10 });

    expect(events).toHaveLength(1);
    expect(calls[0]?.text).toContain("sequence > $3");
    expect(calls[0]?.text).toContain("LIMIT $4");
    expect(calls[0]?.values).toEqual(["workspace-a", "run-a", 2, 10]);
  });

  it("rejects invalid PostgreSQL event pagination before opening a query", async () => {
    const calls: Array<{ text: string; values: readonly unknown[] }> = [];
    await expect(chatWithDatabase(calls).listBackendEvents({ runId: "run-a", limit: 0 })).rejects.toMatchObject({ code: "limit_invalid" });
    expect(calls).toHaveLength(0);
  });
});
