import { describe, expect, it } from "vitest";
import type { WorkspaceSql } from "./postgres";
import { WorkspaceCompletionCuratorService } from "./workspace-completion-curator";
import type { WorkspaceCompletionService } from "./workspace-completion-service";

describe("Workspace Completion Curator", () => {
  it("omits absent fingerprint timestamps before calculating a job input hash", async () => {
    const sql = {
      query: async (text: string) => {
        if (text.includes("workspace_completion_curator_state")) return { rows: [] };
        return {
          rows: [{
            resource_count: 0,
            resource_updated_at: null,
            activity_finalized_at: null,
            evaluation_created_at: null
          }]
        };
      }
    } as unknown as WorkspaceSql;
    const completion = {
      store: {
        database: {
          withContext: async <T>(_context: unknown, action: (transaction: WorkspaceSql) => Promise<T>) => action(sql)
        }
      }
    } as unknown as WorkspaceCompletionService;

    const hash = await new WorkspaceCompletionCuratorService(completion).inputHash(
      { workspaceId: "workspace_curator_hash", accountId: "account_curator_hash" },
      { roomId: "room_curator_hash", mode: "light" }
    );

    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("serializes state and resource fingerprint reads on the transaction client", async () => {
    let activeQueries = 0;
    let maxConcurrentQueries = 0;
    const statements: string[] = [];
    const sql = {
      query: async (text: string) => {
        statements.push(text);
        activeQueries += 1;
        maxConcurrentQueries = Math.max(maxConcurrentQueries, activeQueries);
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        activeQueries -= 1;
        if (text.includes("workspace_completion_curator_state")) return { rows: [] };
        return {
          rows: [{
            resource_count: 0,
            resource_updated_at: null,
            activity_finalized_at: null,
            evaluation_created_at: null
          }]
        };
      }
    } as unknown as WorkspaceSql;
    const completion = {
      store: {
        database: {
          withContext: async <T>(_context: unknown, action: (transaction: WorkspaceSql) => Promise<T>) => action(sql)
        }
      }
    } as unknown as WorkspaceCompletionService;

    await new WorkspaceCompletionCuratorService(completion).inputHash(
      { workspaceId: "workspace_curator_serial", accountId: "account_curator_serial" },
      { roomId: "room_curator_serial", mode: "light" }
    );

    expect(maxConcurrentQueries).toBe(1);
    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain("workspace_completion_curator_state");
    expect(statements[1]).toContain("workspace_completion_resources");
  });
});
