import { describe, expect, it } from "vitest";
import { runWorkspaceServerAdminCli } from "./workspace-server-admin-cli";

describe("workspace server admin CLI", () => {
  it("accepts pnpm's standalone argument separator before a command", async () => {
    await expect(runWorkspaceServerAdminCli(["--", "migrate"], {})).rejects.toMatchObject({
      message: "samurai_database_runtime_role_required"
    });
  });

  it("still rejects an unknown command after the separator", async () => {
    await expect(runWorkspaceServerAdminCli(["--", "unknown"], {})).rejects.toMatchObject({
      message: "workspace_server_admin_cli_command_invalid"
    });
  });
});
