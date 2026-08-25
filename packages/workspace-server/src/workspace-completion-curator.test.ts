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
});
