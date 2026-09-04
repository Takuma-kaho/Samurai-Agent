import { describe, expect, it } from "vitest";
import { WorkspaceServerError } from "./errors";
import { WorkspaceServerStore } from "./workspace-server-store";

describe("Self-host restore ownership", () => {
  it("requires the configured initial owner before an empty server can be restored", () => {
    const store = new WorkspaceServerStore({
      database: {} as never,
      mode: "self_host",
      selfHostWorkspaceId: "workspace_self_host",
      selfHostInitialAdminId: "account_owner",
      storageRoot: "/tmp/samurai-self-host-owner-test",
      invitationTokenSecret: "x".repeat(32)
    });

    expect(() => store.assertSelfHostInitialAdmin("account_other")).toThrowError(WorkspaceServerError);
    expect(() => store.assertSelfHostInitialAdmin("account_owner")).not.toThrow();
  });

  it("permits a multi-Workspace Self-host store without bootstrap-only settings", () => {
    expect(() => new WorkspaceServerStore({
      database: {} as never,
      mode: "self_host",
      storageRoot: "/tmp/samurai-self-host-owner-test",
      invitationTokenSecret: "x".repeat(32)
    })).not.toThrow();
  });
});
