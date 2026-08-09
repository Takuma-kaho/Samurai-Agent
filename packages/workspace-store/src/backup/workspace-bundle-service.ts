import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { nowIso } from "@samurai-agent/core-schemas";
import { workspaceMigrations } from "../migrations";
import { WorkspaceDatabase } from "../kernel/workspace-database";
import type { WorkspaceKernelService } from "../kernel/workspace-kernel-service";
import type { WorkspaceBackupManifestV2, WorkspaceBackupRecord, WorkspaceHealthReport, WorkspaceRestoreResult } from "../workspace-store-contracts";
import { normalizeBackupId } from "./backup-id";
import {
  type VerifiedWorkspaceBundle,
  type WorkspaceBundleValidationOptions,
  readWorkspaceBundleManifest,
  verifyWorkspaceBundle,
  workspaceBundleDatabaseFile,
  workspaceBundleFilesDirectory,
  workspaceBundleFormatVersion,
  workspaceBundleManifestFile
} from "./workspace-bundle-format";
import {
  copyFileStreaming,
  copyWorkspaceRootsToBundle,
  hashFileSha256,
  isPathWithin,
  resolveBundlePath,
  sameWorkspaceRootSnapshot,
  scanSafeTree,
  snapshotWorkspaceRoots
} from "./workspace-bundle-files";

export interface WorkspaceBundleServiceDependencies {
  inspectWorkspace(): Promise<WorkspaceHealthReport>;
  restoreImportedBundle(backupId: string): Promise<WorkspaceRestoreResult>;
}

/** Owns completed Bundle creation, validation, listing, import/export, and deletion. */
export class WorkspaceBundleService {
  constructor(
    private readonly kernel: WorkspaceKernelService,
    private readonly dependencies: WorkspaceBundleServiceDependencies
  ) {}

  get rootDir(): string {
    return this.kernel.rootDir;
  }

  get backupsRoot(): string {
    return path.join(this.rootDir, "backups");
  }

  async createWorkspaceBackup(): Promise<WorkspaceBackupRecord> {
    await this.kernel.recoverWorkspaceFileTransactions();
    if (await this.kernel.countPendingWorkspaceFileTransactions() !== 0) {
      throw new Error("workspace_backup_pending_file_transactions");
    }

    const id = createBackupId();
    const stage = path.join(this.backupsRoot, `.create-stage-${id}`);
    const destination = this.backupPath(id);
    const roots = this.kernel.paths.backupRoots;
    await mkdir(this.backupsRoot, { recursive: true });
    if (await pathExists(destination)) throw new Error("workspace_backup_already_exists");
    if (await pathExists(stage)) throw new Error("workspace_backup_stage_exists");

    try {
      await mkdir(path.join(stage, workspaceBundleFilesDirectory), { recursive: true });
      const before = await snapshotWorkspaceRoots(this.rootDir, roots);
      await this.kernel.backupDatabaseTo(path.join(stage, workspaceBundleDatabaseFile));
      WorkspaceDatabase.checkpointFileTruncate(path.join(stage, workspaceBundleDatabaseFile));
      await Promise.all([
        rm(path.join(stage, `${workspaceBundleDatabaseFile}-wal`), { force: true }),
        rm(path.join(stage, `${workspaceBundleDatabaseFile}-shm`), { force: true })
      ]);
      await copyWorkspaceRootsToBundle(this.rootDir, path.join(stage, workspaceBundleFilesDirectory), roots);
      const after = await snapshotWorkspaceRoots(this.rootDir, roots);
      if (!sameWorkspaceRootSnapshot(before, after)) throw new Error("workspace_backup_source_changed");

      const dbIntegrity = this.kernel.verifyDatabaseFileIntegrity(path.join(stage, workspaceBundleDatabaseFile));
      if (dbIntegrity !== "ok") throw new Error(`workspace_backup_integrity_failed:${dbIntegrity}`);
      await Promise.all([
        rm(path.join(stage, `${workspaceBundleDatabaseFile}-wal`), { force: true }),
        rm(path.join(stage, `${workspaceBundleDatabaseFile}-shm`), { force: true })
      ]);
      const [health, fileHashes] = await Promise.all([
        this.dependencies.inspectWorkspace(),
        hashBundlePayload(stage)
      ]);
      const finalSnapshot = await snapshotWorkspaceRoots(this.rootDir, roots);
      if (!sameWorkspaceRootSnapshot(before, finalSnapshot)) throw new Error("workspace_backup_source_changed");
      const schemaVersion = await this.currentSchemaVersion();
      const manifest: WorkspaceBackupManifestV2 = {
        format_version: workspaceBundleFormatVersion,
        schema_version: schemaVersion,
        id,
        created_at: nowIso(),
        source_root: ".",
        db_file: workspaceBundleDatabaseFile,
        file_roots: [...roots],
        resource_boundaries: this.kernel.paths.resourceBoundaries(),
        health_ok: health.ok,
        integrity_ok: true,
        file_hashes: fileHashes
      };
      // A manifest is the publication marker and is always written last.
      await writeFile(path.join(stage, workspaceBundleManifestFile), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
      await this.verifyBundle(stage);
      await rename(stage, destination);
      return { id, path: path.posix.join("backups", id), manifest };
    } catch (error) {
      await rm(stage, { recursive: true, force: true });
      throw error;
    }
  }

  async listWorkspaceBackups(): Promise<WorkspaceBackupRecord[]> {
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    try {
      entries = await readdir(this.backupsRoot, { withFileTypes: true });
    } catch {
      return [];
    }
    const records = await Promise.all(entries.map(async (entry) => {
      if (!entry.isDirectory()) return undefined;
      try {
        const id = normalizeBackupId(entry.name);
        const { manifest } = await readWorkspaceBundleManifest(this.backupPath(id), this.kernel.paths.resourceBoundaries());
        if (manifest.id !== id) return undefined;
        return { id, path: path.posix.join("backups", id), manifest } satisfies WorkspaceBackupRecord;
      } catch {
        return undefined;
      }
    }));
    return records
      .filter((record): record is WorkspaceBackupRecord => Boolean(record))
      .sort((left, right) => right.manifest.created_at.localeCompare(left.manifest.created_at));
  }

  async deleteWorkspaceBackup(backupId: string): Promise<void> {
    const id = normalizeBackupId(backupId);
    await rm(this.backupPath(id), { recursive: true, force: false });
  }

  async exportWorkspaceBundle(destinationRoot: string): Promise<{ path: string; backup: WorkspaceBackupRecord }> {
    const requestedRoot = path.resolve(destinationRoot);
    if (isPathWithin(this.rootDir, requestedRoot)) throw new Error("workspace_export_destination_inside_workspace");

    const backup = await this.createWorkspaceBackup();
    const destination = path.join(requestedRoot, `samurai-workspace-${backup.id}`);
    if (await pathExists(destination)) throw new Error("workspace_export_destination_exists");

    const parent = path.dirname(destination);
    const stage = path.join(parent, `.${path.basename(destination)}.export-stage-${randomUUID()}`);
    await mkdir(parent, { recursive: true });
    try {
      const verified = await this.verifyBundle(this.backupPath(backup.id));
      await copyVerifiedBundle(verified, stage);
      await this.verifyBundle(stage);
      await rename(stage, destination);
      return { path: destination, backup };
    } catch (error) {
      await rm(stage, { recursive: true, force: true });
      throw error;
    }
  }

  async importWorkspaceBundle(bundlePath: string): Promise<WorkspaceRestoreResult> {
    const source = path.resolve(bundlePath);
    const verified = await this.verifyBundle(source);
    const destination = this.backupPath(verified.manifest.id);
    if (await pathExists(destination)) throw new Error("workspace_import_backup_exists");
    const stage = path.join(this.backupsRoot, `.import-stage-${verified.manifest.id}-${randomUUID()}`);
    await mkdir(this.backupsRoot, { recursive: true });
    try {
      await copyVerifiedBundle(verified, stage);
      await this.verifyBundle(stage);
      await rename(stage, destination);
    } catch (error) {
      await rm(stage, { recursive: true, force: true });
      throw error;
    }
    // The completed imported Bundle intentionally remains available if restore fails.
    return this.dependencies.restoreImportedBundle(verified.manifest.id);
  }

  async verifyBundle(bundleRoot: string): Promise<VerifiedWorkspaceBundle> {
    return verifyWorkspaceBundle(bundleRoot, await this.validationOptions());
  }

  async verifyWorkspaceBackup(backupId: string): Promise<VerifiedWorkspaceBundle> {
    const id = normalizeBackupId(backupId);
    const verified = await this.verifyBundle(this.backupPath(id));
    if (verified.manifest.id !== id) throw new Error("workspace_backup_id_mismatch");
    return verified;
  }

  /** Expands a verified Bundle into a Workspace-shaped restore Stage. */
  async materializeWorkspaceStage(verified: VerifiedWorkspaceBundle, stageRoot: string): Promise<void> {
    const roots = this.kernel.paths.restoreRoots;
    await mkdir(stageRoot, { recursive: true });
    for (const root of roots) await mkdir(path.join(stageRoot, root), { recursive: true });

    for (const relativePath of Object.keys(verified.file_hashes).sort()) {
      const source = resolveBundlePath(verified.root_dir, relativePath);
      const target = relativePath === workspaceBundleDatabaseFile
        ? path.join(stageRoot, workspaceBundleDatabaseFile)
        : resolveRestoreStagePath(stageRoot, relativePath);
      await copyFileStreaming(source, target);
      const copiedHash = await hashFileSha256(target);
      if (copiedHash !== verified.file_hashes[relativePath]) throw new Error(`workspace_bundle_hash_mismatch:${relativePath}`);
    }
  }

  backupPath(backupId: string): string {
    return path.join(this.backupsRoot, normalizeBackupId(backupId));
  }

  static async cleanupIncompleteStages(rootDir: string): Promise<void> {
    const backupsRoot = path.join(rootDir, "backups");
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    try {
      entries = await readdir(backupsRoot, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(entries
      .filter((entry) => (
        entry.isDirectory() && /^\.(?:create|import|restore)-stage-|^\.restore-rollback-/.test(entry.name)
      ) || (
        entry.isFile() && /^\.restore-journal\.json\..+\.tmp$/.test(entry.name)
      ))
      .map((entry) => rm(path.join(backupsRoot, entry.name), { recursive: true, force: true })));
  }

  private async validationOptions(): Promise<WorkspaceBundleValidationOptions> {
    const backupRoots = this.kernel.paths.backupRoots;
    const restoreRoots = this.kernel.paths.restoreRoots;
    return {
      // `surfaces` was part of Core04--07 Bundles. Core08 no longer emits it,
      // but continues to verify and restore that compatibility payload.
      allowedRoots: restoreRoots,
      acceptedRootSets: [backupRoots, restoreRoots],
      resourceBoundaries: this.kernel.paths.resourceBoundaries(),
      latestSchemaVersion: Math.max(workspaceMigrations.at(-1)?.version ?? 0, await this.currentSchemaVersion())
    };
  }

  private async currentSchemaVersion(): Promise<number> {
    return (await this.kernel.listSchemaMigrations()).at(-1)?.version ?? 0;
  }
}

async function hashBundlePayload(bundleRoot: string): Promise<Record<string, string>> {
  const tree = await scanSafeTree(bundleRoot, "workspace_backup_file_type_invalid");
  const files = tree.files
    .map((entry) => entry.path)
    .filter((entry) => entry !== workspaceBundleManifestFile)
    .sort();
  const pairs = await Promise.all(files.map(async (relativePath) => [
    relativePath,
    await hashFileSha256(resolveBundlePath(bundleRoot, relativePath))
  ] as const));
  return Object.fromEntries(pairs);
}

async function copyVerifiedBundle(verified: VerifiedWorkspaceBundle, destination: string): Promise<void> {
  await mkdir(path.join(destination, workspaceBundleFilesDirectory), { recursive: true });
  for (const root of verified.file_roots) {
    await mkdir(path.join(destination, workspaceBundleFilesDirectory, root), { recursive: true });
  }
  for (const relativePath of Object.keys(verified.file_hashes).sort()) {
    await copyFileStreaming(
      resolveBundlePath(verified.root_dir, relativePath),
      resolveBundlePath(destination, relativePath)
    );
  }
  await writeFile(path.join(destination, workspaceBundleManifestFile), verified.manifest_text, { flag: "wx" });
}

function resolveRestoreStagePath(stageRoot: string, bundleRelativePath: string): string {
  if (!bundleRelativePath.startsWith(`${workspaceBundleFilesDirectory}/`)) throw new Error("workspace_bundle_path_invalid");
  const relative = bundleRelativePath.slice(`${workspaceBundleFilesDirectory}/`.length);
  const parts = relative.split("/");
  if (parts.length < 2) throw new Error("workspace_bundle_path_invalid");
  return path.join(stageRoot, ...parts);
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function createBackupId(): string {
  return `backup_${new Date().toISOString().replace(/[:.]/g, "-")}_${randomUUID().slice(0, 8)}`;
}
