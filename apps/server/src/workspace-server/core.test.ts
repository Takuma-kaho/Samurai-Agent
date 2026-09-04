import { describe, expect, it, vi } from "vitest";
import type { WorkspaceServerStore } from "@samurai-agent/workspace-server";
import { activeWorkspaces } from "./core";

describe("Workspace Server recovery discovery", () => {
  it("invokes active workspace discovery with the store receiver", async () => {
    const listActiveWorkspaceIds = vi.fn(function (this: { database: object }) {
      if (!this.database) throw new Error("database context is missing");
      return [{ workspaceId: "workspace_a", accountId: "account_a" }];
    });
    const store = {
      database: {},
      listActiveWorkspaceIds
    } as unknown as WorkspaceServerStore;

    await expect(activeWorkspaces(store)).resolves.toEqual([
      { workspaceId: "workspace_a", accountId: "account_a" }
    ]);
    expect(listActiveWorkspaceIds).toHaveBeenCalledOnce();
  });
});
