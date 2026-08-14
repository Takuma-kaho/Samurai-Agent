import { randomUUID } from "node:crypto";
import {
  WorkspaceServerError,
  createWorkspaceBundleV3FromLegacySqlite,
  loadWorkspaceServerConfig,
  verifyWorkspaceBundleV3
} from "@samurai-agent/workspace-server";
import { createWorkspaceServerCore } from "./workspace-server/core";

export async function runWorkspaceServerCli(argv = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): Promise<unknown> {
  const [command, ...arguments_] = argv;
  if (command === "bundle-verify") {
    return verifyWorkspaceBundleV3(requiredArgument(arguments_, 0, "bundle_directory_required"));
  }
  if (command === "sqlite-bundle") {
    const accountId = migrationAccountId(env);
    return createWorkspaceBundleV3FromLegacySqlite({
      sourceWorkspaceRoot: requiredArgument(arguments_, 0, "legacy_workspace_root_required"),
      destination: requiredArgument(arguments_, 1, "bundle_destination_required"),
      workspaceId: requiredArgument(arguments_, 2, "workspace_id_required"),
      ownerAccountId: accountId
    });
  }
  if (command !== "bundle-export" && command !== "bundle-import" && command !== "sqlite-import" && command !== "files-recover") {
    throw new WorkspaceServerError("workspace_server_cli_command_invalid", 400, {
      commands: ["bundle-export", "bundle-verify", "bundle-import", "sqlite-bundle", "sqlite-import", "files-recover"]
    });
  }
  const config = loadWorkspaceServerConfig(env);
  const accountId = env.SAMURAI_SERVER_ADMIN_ACCOUNT_ID?.trim() || config.initialAdminId;
  if (!accountId) throw new WorkspaceServerError("samurai_server_admin_account_id_required", 500);
  const core = await createWorkspaceServerCore(config);
  try {
    if (command === "bundle-export") {
      const workspaceId = configuredWorkspaceId(config.mode, config.selfHostWorkspaceId, env);
      return core.bundles.export({ workspaceId, accountId, operationId: `server_cli_${randomUUID()}` }, {
        destination: requiredArgument(arguments_, 0, "bundle_destination_required")
      });
    }
    if (command === "bundle-import") {
      const sourceDirectory = requiredArgument(arguments_, 0, "bundle_directory_required");
      const targetWorkspaceId = requiredArgument(arguments_, 1, "workspace_id_required");
      return core.bundles.importNew({ accountId, operationId: `server_cli_import_${randomUUID()}` }, { sourceDirectory, targetWorkspaceId });
    }
    if (command === "files-recover") {
      const workspaceId = config.mode === "self_host"
        ? configuredWorkspaceId(config.mode, config.selfHostWorkspaceId, env)
        : requiredArgument(arguments_, 0, "workspace_id_required");
      const recovery = await core.files.recover({ workspaceId, accountId });
      if (recovery.failed.length > 0) {
        throw new WorkspaceServerError("workspace_file_recovery_required", 409, { failed_transaction_ids: recovery.failed });
      }
      return recovery;
    }
    const sourceWorkspaceRoot = requiredArgument(arguments_, 0, "legacy_workspace_root_required");
    const destination = requiredArgument(arguments_, 1, "bundle_destination_required");
    const targetWorkspaceId = requiredArgument(arguments_, 2, "workspace_id_required");
    await createWorkspaceBundleV3FromLegacySqlite({ sourceWorkspaceRoot, destination, workspaceId: targetWorkspaceId, ownerAccountId: accountId });
    return core.bundles.importNew({ accountId, operationId: `server_cli_sqlite_import_${randomUUID()}` }, { sourceDirectory: destination, targetWorkspaceId });
  } finally {
    await core.close();
  }
}

function requiredArgument(values: readonly string[], index: number, code: string): string {
  const value = values[index]?.trim();
  if (!value) throw new WorkspaceServerError(code, 400);
  return value;
}

function migrationAccountId(env: NodeJS.ProcessEnv): string {
  const accountId = env.SAMURAI_SERVER_ADMIN_ACCOUNT_ID?.trim() || env.SAMURAI_MIGRATION_OWNER_ACCOUNT_ID?.trim();
  if (!accountId) throw new WorkspaceServerError("samurai_server_admin_account_id_required", 500);
  return accountId;
}

function configuredWorkspaceId(mode: "hosted" | "self_host", selfHostWorkspaceId: string | undefined, env: NodeJS.ProcessEnv): string {
  const workspaceId = mode === "self_host" ? selfHostWorkspaceId : env.SAMURAI_WORKSPACE_ID?.trim();
  if (!workspaceId) throw new WorkspaceServerError("workspace_id_required", 400);
  return workspaceId;
}

const entry = process.argv[1]?.endsWith("workspace-server-cli.ts") || process.argv[1]?.endsWith("workspace-server-cli.js");
if (entry) {
  runWorkspaceServerCli()
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
    })
    .catch((error) => {
      console.error(error instanceof Error ? { name: error.name, message: error.message } : "workspace_server_cli_failed");
      process.exitCode = 1;
    });
}
