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
  // pnpm forwards a standalone separator to the script in some invocations.
  // It is transport syntax, not an administrative command.
  const commands = argv.filter((argument) => argument !== "--");
  const [command, ...unexpectedArguments] = commands;
  if ((command !== "migrate" && command !== "health") || unexpectedArguments.length > 0) {
    throw new WorkspaceServerError("workspace_server_admin_cli_command_invalid", 400, { commands: ["migrate", "health"] });
  }
  const config = loadWorkspaceServerAdminConfig(env);
  const database = new PostgresWorkspaceAdminDatabase({
    databaseAdminUrl: config.databaseAdminUrl,
    runtimeRole: config.databaseRuntimeRole
  });
  try {
    if (command === "migrate") {
      await database.migrate();
      return { ok: true, action: "migrate" };
    }
    return { ...(await database.operatorHealth()), action: "health" };
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
