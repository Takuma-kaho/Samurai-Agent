import {
  PostgresWorkspaceAdminDatabase,
  WorkspaceServerError,
  loadWorkspaceServerAdminConfig
} from "@samurai-agent/workspace-server";

/**
 * Administrative entry point.  Keep it separate from the HTTP Server so a
 * long-lived public process never receives an owner/admin database URL.
 */
export async function runWorkspaceServerAdminCli(argv = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): Promise<unknown> {
  const [command] = argv;
  if (command !== "migrate") {
    throw new WorkspaceServerError("workspace_server_admin_cli_command_invalid", 400, { commands: ["migrate"] });
  }
  const config = loadWorkspaceServerAdminConfig(env);
  const database = new PostgresWorkspaceAdminDatabase({
    databaseAdminUrl: config.databaseAdminUrl,
    runtimeRole: config.databaseRuntimeRole
  });
  try {
    await database.migrate();
    return { ok: true, action: "migrate" };
  } finally {
    await database.close();
  }
}

const entry = process.argv[1]?.endsWith("workspace-server-admin-cli.ts") || process.argv[1]?.endsWith("workspace-server-admin-cli.js");
if (entry) {
  runWorkspaceServerAdminCli()
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => {
      console.error(error instanceof Error ? { name: error.name, message: error.message } : "workspace_server_admin_cli_failed");
      process.exitCode = 1;
    });
}
