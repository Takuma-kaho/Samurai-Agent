import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  WorkspaceServerError,
  loadWorkspaceServerConfig,
  verifyWorkspaceBundleV3,
  verifyWorkspaceBundleV4
} from "@samurai-agent/workspace-server";
import { createWorkspaceServerCore } from "./workspace-server/core";

export async function runWorkspaceServerCli(argv = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): Promise<unknown> {
  const [command, ...arguments_] = argv;
  if (command === "bundle-verify") {
    const directory = requiredArgument(arguments_, 0, "bundle_directory_required");
    return await bundleFormat(directory) === 4 ? verifyWorkspaceBundleV4(directory) : verifyWorkspaceBundleV3(directory);
  }
  if (command !== "bundle-export" && command !== "bundle-import" && command !== "files-recover"
    && command !== "completion-files-recover" && command !== "completion-migrate" && command !== "completion-maintenance-tick"
    && command !== "completion-physical-edit-prepare" && command !== "completion-physical-edit-import") {
    throw new WorkspaceServerError("workspace_server_cli_command_invalid", 400, {
      commands: ["bundle-export", "bundle-verify", "bundle-import", "files-recover", "completion-files-recover", "completion-migrate", "completion-maintenance-tick", "completion-physical-edit-prepare", "completion-physical-edit-import"]
    });
  }
  const config = loadWorkspaceServerConfig(env);
  const adminAccountId = env.SAMURAI_SERVER_ADMIN_ACCOUNT_ID?.trim() || config.initialAdminId;
  if (command !== "completion-maintenance-tick" && !adminAccountId) throw new WorkspaceServerError("samurai_server_admin_account_id_required", 500);
  const core = await createWorkspaceServerCore(config);
  try {
    if (command === "completion-maintenance-tick") {
      const accountId = env.SAMURAI_COMPLETION_MAINTENANCE_ACCOUNT_ID?.trim();
      if (!accountId) throw new WorkspaceServerError("samurai_completion_maintenance_account_id_required", 500);
      const workspaceId = configuredWorkspaceId(config.mode, config.selfHostWorkspaceId, env);
      const workerId = env.SAMURAI_COMPLETION_MAINTENANCE_WORKER_ID?.trim() || "completion_maintenance_worker";
      return core.maintenance.runTick({ workspaceId, accountId, operationId: `completion_maintenance_${randomUUID().replaceAll("-", "")}` }, { workerId });
    }
    const accountId = adminAccountId!;
    if (command === "bundle-export") {
      const workspaceId = configuredWorkspaceId(config.mode, config.selfHostWorkspaceId, env);
      return core.completionBundles.export({ workspaceId, accountId, operationId: `server_cli_${randomUUID()}` }, {
        destination: requiredArgument(arguments_, 0, "bundle_destination_required")
      });
    }
    if (command === "bundle-import") {
      const sourceDirectory = requiredArgument(arguments_, 0, "bundle_directory_required");
      const targetWorkspaceId = requiredArgument(arguments_, 1, "workspace_id_required");
      if (config.mode === "self_host" && targetWorkspaceId !== config.selfHostWorkspaceId) {
        throw new WorkspaceServerError("self_host_workspace_mismatch", 409, {
          configured_workspace_id: config.selfHostWorkspaceId,
          target_workspace_id: targetWorkspaceId
        });
      }
      const context = { accountId, operationId: `server_cli_import_${randomUUID()}` };
      return await bundleFormat(sourceDirectory) === 4
        ? core.completionBundles.importNew(context, { sourceDirectory, targetWorkspaceId })
        : core.bundles.importNew(context, { sourceDirectory, targetWorkspaceId });
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
    if (command === "completion-files-recover") {
      const workspaceId = config.mode === "self_host"
        ? configuredWorkspaceId(config.mode, config.selfHostWorkspaceId, env)
        : requiredArgument(arguments_, 0, "workspace_id_required");
      const recovery = await core.completion.recoverFileBatches({ workspaceId, accountId });
      if (recovery.failed.length > 0) throw new WorkspaceServerError("workspace_completion_file_recovery_required", 409, { failed_batch_ids: recovery.failed });
      return recovery;
    }
    if (command === "completion-physical-edit-prepare") {
      const workspaceId = configuredWorkspaceId(config.mode, config.selfHostWorkspaceId, env);
      return core.completion.preparePhysicalResourceEdit({
        workspaceId,
        accountId,
        operationId: `completion_physical_prepare_${randomUUID().replaceAll("-", "")}`
      }, requiredArgument(arguments_, 0, "workspace_completion_resource_id_required"));
    }
    if (command === "completion-physical-edit-import") {
      const workspaceId = configuredWorkspaceId(config.mode, config.selfHostWorkspaceId, env);
      return core.completion.importPhysicalResourceEdit({
        workspaceId,
        accountId,
        operationId: `completion_physical_import_${randomUUID().replaceAll("-", "")}`
      }, {
        resourceId: requiredArgument(arguments_, 0, "workspace_completion_resource_id_required"),
        expectedVersion: requiredPositiveInteger(arguments_, 1, "workspace_completion_resource_version_required"),
        reason: requiredArgument(arguments_, 2, "workspace_completion_physical_import_reason_required")
      });
    }
    if (command === "completion-migrate") {
      const workspaceId = configuredWorkspaceId(config.mode, config.selfHostWorkspaceId, env);
      return core.completionMigrations.migrateLegacy({ workspaceId, accountId, operationId: `completion_migration_${randomUUID().replaceAll("-", "")}` }, {
        dryRun: arguments_.includes("--dry-run")
      });
    }
    // All currently accepted commands return above. Keep this fail-closed so
    // a newly added command cannot accidentally fall through to a legacy
    // database migration path.
    throw new WorkspaceServerError("workspace_server_cli_command_invalid", 400);
  } finally {
    await core.close();
  }
}

async function bundleFormat(directory: string): Promise<3 | 4> {
  // The CLI accepts a v3 source only as a read/import compatibility input.
  // New exports always choose v4 above.
  try {
    const manifest = JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8")) as { format_version?: unknown };
    if (manifest.format_version === 4) return 4;
    if (manifest.format_version === 3) return 3;
  } catch {
    // Both validators return the stable public error for malformed manifests.
  }
  return 3;
}

function requiredArgument(values: readonly string[], index: number, code: string): string {
  const value = values[index]?.trim();
  if (!value) throw new WorkspaceServerError(code, 400);
  return value;
}

function requiredPositiveInteger(values: readonly string[], index: number, code: string): number {
  const raw = requiredArgument(values, index, code);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw new WorkspaceServerError(code, 400);
  return value;
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
