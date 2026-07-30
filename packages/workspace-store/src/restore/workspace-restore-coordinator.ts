import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import { nowIso } from "@samurai-agent/core-schemas";
import { WorkspaceBundleService } from "../backup/workspace-bundle-service";
import { normalizeBackupId } from "../backup/backup-id";
import { WorkspaceDatabase } from "../kernel/workspace-database";
import type { WorkspaceKernelService } from "../kernel/workspace-kernel-service";
import { workspaceBackupRoots } from "../kernel/workspace-paths";
import type { WorkspaceHealthReport, WorkspaceIntegrityReport, WorkspaceRestoreResult } from "../workspace-store-contracts";

const journalName = ".restore-journal.json";
const journalVersion = 1;
const journalPhases = ["prepared", "current_moved", "replacement_moved", "verified", "committed"] as const;
type RestoreJournalPhase = (typeof journalPhases)[number];

interface RestoreJournal {
  journal_version: 1;
  operation_id: string;
  backup_id: string;
  stage_path: string;
  rollback_path: string;
  target_roots: string[];
  current: {
    database: RestoreJournalPathState;
    wal: RestoreJournalPathState;
    shm: RestoreJournalPathState;
    roots: Record<string, RestoreJournalPathState>;
  };
  phase: RestoreJournalPhase;
}

interface RestoreJournalPathState {
  path: string;
  exists: boolean;
}

export interface WorkspaceRestoreDependencies {
  initializeStage(stageRoot: string): Promise<void>;
  restartCurrentWorkspace(): Promise<void>;
  inspectWorkspace(): Promise<WorkspaceHealthReport>;
  checkIntegrity(): Promise<WorkspaceIntegrityReport>;
}

/** Owns restore staging, journaled replacement, rollback, and startup recovery. */
export class WorkspaceRestoreCoordinator {
  constructor(
    private readonly kernel: WorkspaceKernelService,
    private readonly bundles: WorkspaceBundleService,
    private readonly dependencies: WorkspaceRestoreDependencies,
    private readonly restoreFailureInjector?: (phase: "extract" | "hash_verify" | "prepared" | "swap" | "replacement_moved" | "restart" | "committed") => void
  ) {}

  async restoreWorkspaceBackup(backupId: string): Promise<WorkspaceRestoreResult> {
    const id = normalizeBackupId(backupId);
    const verified = await this.bundles.verifyWorkspaceBackup(id);
    const preRestoreHealth = await this.dependencies.inspectWorkspace();
    const operationId = `${id}-${randomUUID().slice(0, 12)}`;
    const stagePath = path.join(this.backupsRoot(), `.restore-stage-${operationId}`);
    const rollbackPath = path.join(this.backupsRoot(), `.restore-rollback-${operationId}`);
    let journal: RestoreJournal | undefined;
    let committed = false;
    let currentWorkspaceClosed = false;
    let swapStarted = false;

    try {
      await this.bundles.materializeWorkspaceStage(verified, stagePath);
      await this.dependencies.initializeStage(stagePath);
      checkpointDatabaseFile(path.join(stagePath, "workspace.sqlite"));
      const stagedIntegrity = WorkspaceDatabase.verifyIntegrity(path.join(stagePath, "workspace.sqlite"));
      if (stagedIntegrity !== "ok") throw new Error(`workspace_restore_stage_integrity_failed:${stagedIntegrity}`);
      this.restoreFailureInjector?.("extract");
      this.restoreFailureInjector?.("hash_verify");

      // A restore never begins unless an independently restorable current snapshot exists.
      const preRestoreBackup = await this.bundles.createWorkspaceBackup();
      this.kernel.checkpointTruncate();
      currentWorkspaceClosed = true;
      await this.kernel.close();

      journal = await createRestoreJournal({
        rootDir: this.kernel.rootDir,
        operationId,
        backupId: id,
        stagePath,
        rollbackPath,
        roots: this.kernel.paths.backupRoots
      });
      await writeRestoreJournal(this.kernel.rootDir, journal);
      this.restoreFailureInjector?.("prepared");
      swapStarted = true;

      try {
        await moveCurrentWorkspaceToRollback(this.kernel.rootDir, journal);
        journal = { ...journal, phase: "current_moved" };
        await writeRestoreJournal(this.kernel.rootDir, journal);
        this.restoreFailureInjector?.("swap");

        await moveStageIntoWorkspace(this.kernel.rootDir, journal);
        journal = { ...journal, phase: "replacement_moved" };
        await writeRestoreJournal(this.kernel.rootDir, journal);
        this.restoreFailureInjector?.("replacement_moved");

        await this.kernel.reopen();
        this.restoreFailureInjector?.("restart");
        await this.dependencies.restartCurrentWorkspace();
        const integrity = await this.dependencies.checkIntegrity();
        if (!integrity.db.ok) throw new Error(`workspace_restore_integrity_failed:${integrity.db.result}`);
        journal = { ...journal, phase: "verified" };
        await writeRestoreJournal(this.kernel.rootDir, journal);
        journal = { ...journal, phase: "committed" };
        await writeRestoreJournal(this.kernel.rootDir, journal);
        committed = true;
        this.restoreFailureInjector?.("committed");
        await cleanupRestoreArtifacts(this.kernel.rootDir, journal).catch(() => undefined);
        return {
          backup_id: id,
          pre_restore_backup_id: preRestoreBackup.id,
          restored_at: nowIso(),
          restored_paths: [...this.kernel.paths.backupRoots],
          db_restored: true,
          manifest: verified.manifest,
          pre_restore_health: preRestoreHealth,
          integrity,
          health: integrity.workspace
        };
      } catch (error) {
        if (committed) throw error;
        await this.kernel.close().catch(() => undefined);
        try {
          await rollbackWorkspaceFromJournal(this.kernel.rootDir, journal);
          await this.kernel.reopen();
          await this.dependencies.restartCurrentWorkspace();
          await cleanupRestoreArtifacts(this.kernel.rootDir, journal);
        } catch (rollbackError) {
          throw new Error(`workspace_restore_rollback_failed:${errorMessage(rollbackError)}`, { cause: error });
        }
        throw error;
      }
    } catch (error) {
      // A journal-write failure occurs after the current DB closes but before
      // any current path moves. Reopen the unchanged Workspace for this Store.
      if (currentWorkspaceClosed && !swapStarted) {
        try {
          await this.kernel.reopen();
          await this.dependencies.restartCurrentWorkspace();
          if (journal) await cleanupRestoreArtifacts(this.kernel.rootDir, journal).catch(() => undefined);
        } catch (restartError) {
          throw new Error(`workspace_restore_pre_swap_restart_failed:${errorMessage(restartError)}`, { cause: error });
        }
      }
      throw error;
    } finally {
      if (!journal || !committed) await rm(stagePath, { recursive: true, force: true });
    }
  }

  /** Called by WorkspaceStore.create before layout creation or opening SQLite. */
  static async recoverInterruptedWorkspaceRestore(rootDir: string): Promise<void> {
    const journal = await readRestoreJournal(rootDir);
    if (!journal) return;
    if (journal.phase !== "committed") await rollbackWorkspaceFromJournal(rootDir, journal);
    await cleanupRestoreArtifacts(rootDir, journal);
  }

  /** Direct constructor callers must use WorkspaceStore.create to perform recovery. */
  static hasPendingRestoreJournal(rootDir: string): boolean {
    return existsSync(journalPath(rootDir));
  }

  private backupsRoot(): string {
    return path.join(this.kernel.rootDir, "backups");
  }
}

async function createRestoreJournal(input: {
  rootDir: string;
  operationId: string;
  backupId: string;
  stagePath: string;
  rollbackPath: string;
  roots: readonly string[];
}): Promise<RestoreJournal> {
  const current = {
    database: pathState(path.join(input.rootDir, "workspace.sqlite"), await existingFile(path.join(input.rootDir, "workspace.sqlite"))),
    wal: pathState(path.join(input.rootDir, "workspace.sqlite-wal"), await existingFile(path.join(input.rootDir, "workspace.sqlite-wal"))),
    shm: pathState(path.join(input.rootDir, "workspace.sqlite-shm"), await existingFile(path.join(input.rootDir, "workspace.sqlite-shm"))),
    roots: Object.fromEntries(await Promise.all(input.roots.map(async (root) => [
      root,
      pathState(path.join(input.rootDir, root), await existingDirectory(path.join(input.rootDir, root)))
    ] as const)))
  };
  return {
    journal_version: journalVersion,
    operation_id: input.operationId,
    backup_id: normalizeBackupId(input.backupId),
    stage_path: input.stagePath,
    rollback_path: input.rollbackPath,
    target_roots: [...input.roots],
    current,
    phase: "prepared"
  };
}

async function moveCurrentWorkspaceToRollback(rootDir: string, journal: RestoreJournal): Promise<void> {
  await mkdir(journal.rollback_path, { recursive: true });
  await moveIfPresent(path.join(rootDir, "workspace.sqlite"), path.join(journal.rollback_path, "workspace.sqlite"));
  await moveIfPresent(path.join(rootDir, "workspace.sqlite-wal"), path.join(journal.rollback_path, "workspace.sqlite-wal"));
  await moveIfPresent(path.join(rootDir, "workspace.sqlite-shm"), path.join(journal.rollback_path, "workspace.sqlite-shm"));
  for (const root of journal.target_roots) {
    await moveIfPresent(path.join(rootDir, root), path.join(journal.rollback_path, root));
  }
}

async function moveStageIntoWorkspace(rootDir: string, journal: RestoreJournal): Promise<void> {
  await removeIfPresent(path.join(rootDir, "workspace.sqlite-wal"));
  await removeIfPresent(path.join(rootDir, "workspace.sqlite-shm"));
  await rename(path.join(journal.stage_path, "workspace.sqlite"), path.join(rootDir, "workspace.sqlite"));
  for (const root of journal.target_roots) {
    await rename(path.join(journal.stage_path, root), path.join(rootDir, root));
  }
}

/** Restores originals whenever they were moved, and removes every replacement otherwise. */
async function rollbackWorkspaceFromJournal(rootDir: string, journal: RestoreJournal): Promise<void> {
  await restorePath(rootDir, journal, "workspace.sqlite", journal.current.database.exists, journal.phase);
  await restorePath(rootDir, journal, "workspace.sqlite-wal", journal.current.wal.exists, journal.phase);
  await restorePath(rootDir, journal, "workspace.sqlite-shm", journal.current.shm.exists, journal.phase);
  for (const root of journal.target_roots) {
    await restorePath(rootDir, journal, root, Boolean(journal.current.roots[root]?.exists), journal.phase);
  }
}

async function restorePath(
  rootDir: string,
  journal: RestoreJournal,
  relativePath: string,
  existedBefore: boolean,
  phase: RestoreJournalPhase
): Promise<void> {
  const currentPath = path.join(rootDir, relativePath);
  const originalPath = path.join(journal.rollback_path, relativePath);
  if (await pathExists(originalPath)) {
    await removeIfPresent(currentPath);
    await mkdir(path.dirname(currentPath), { recursive: true });
    await rename(originalPath, currentPath);
    return;
  }
  if (!existedBefore) {
    await removeIfPresent(currentPath);
    return;
  }
  if (phase !== "prepared") throw new Error(`workspace_restore_rollback_original_missing:${relativePath}`);
  // Before current_moved was journaled, the original may still be exactly where it started.
  if (!await pathExists(currentPath)) throw new Error(`workspace_restore_rollback_original_missing:${relativePath}`);
}

async function writeRestoreJournal(rootDir: string, journal: RestoreJournal): Promise<void> {
  const target = journalPath(rootDir);
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = path.join(path.dirname(target), `.${journalName}.${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(journal, null, 2)}\n`, { flag: "wx" });
  await rename(temporary, target);
}

async function readRestoreJournal(rootDir: string): Promise<RestoreJournal | undefined> {
  let text: string;
  try {
    text = await readFile(journalPath(rootDir), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new Error("workspace_restore_journal_invalid");
  }
  return parseRestoreJournal(rootDir, value);
}

function parseRestoreJournal(rootDir: string, value: unknown): RestoreJournal {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("workspace_restore_journal_invalid");
  const journal = value as Record<string, unknown>;
  if (
    journal.journal_version !== journalVersion
    || typeof journal.operation_id !== "string"
    || typeof journal.backup_id !== "string"
    || typeof journal.stage_path !== "string"
    || typeof journal.rollback_path !== "string"
    || !Array.isArray(journal.target_roots)
    || !journal.target_roots.every((root) => typeof root === "string")
    || !journalPhases.includes(journal.phase as RestoreJournalPhase)
    || !journal.current || typeof journal.current !== "object" || Array.isArray(journal.current)
  ) throw new Error("workspace_restore_journal_invalid");
  const current = journal.current as Record<string, unknown>;
  if (
    !isJournalPathState(rootDir, current.database, "workspace.sqlite")
    || !isJournalPathState(rootDir, current.wal, "workspace.sqlite-wal")
    || !isJournalPathState(rootDir, current.shm, "workspace.sqlite-shm")
    || !current.roots || typeof current.roots !== "object" || Array.isArray(current.roots)
  ) throw new Error("workspace_restore_journal_invalid");
  const roots = journal.target_roots as string[];
  const rootStates = current.roots as Record<string, unknown>;
  if (
    new Set(roots).size !== roots.length
    || !sameStrings(roots, workspaceBackupRoots())
    || !roots.every((root) => validRootName(root) && isJournalPathState(rootDir, rootStates[root], root))
  ) {
    throw new Error("workspace_restore_journal_invalid");
  }
  normalizeBackupId(journal.backup_id);
  assertJournalPath(rootDir, journal.stage_path, ".restore-stage-");
  assertJournalPath(rootDir, journal.rollback_path, ".restore-rollback-");
  return {
    journal_version: journalVersion,
    operation_id: journal.operation_id,
    backup_id: journal.backup_id,
    stage_path: journal.stage_path,
    rollback_path: journal.rollback_path,
    target_roots: roots,
    current: {
      database: current.database as RestoreJournalPathState,
      wal: current.wal as RestoreJournalPathState,
      shm: current.shm as RestoreJournalPathState,
      roots: Object.fromEntries(roots.map((root) => [root, rootStates[root] as RestoreJournalPathState]))
    },
    phase: journal.phase as RestoreJournalPhase
  };
}

async function cleanupRestoreArtifacts(rootDir: string, journal: RestoreJournal): Promise<void> {
  await rm(journal.stage_path, { recursive: true, force: true });
  await rm(journal.rollback_path, { recursive: true, force: true });
  await rm(journalPath(rootDir), { force: true });
}

function journalPath(rootDir: string): string {
  return path.join(rootDir, "backups", journalName);
}

function assertJournalPath(rootDir: string, candidate: string, prefix: string): void {
  const backupsRoot = path.resolve(rootDir, "backups");
  const relative = path.relative(backupsRoot, path.resolve(candidate));
  if (
    !relative
    || relative.includes(path.sep)
    || relative === ".."
    || relative.startsWith(`..${path.sep}`)
    || !relative.startsWith(prefix)
  ) throw new Error("workspace_restore_journal_invalid");
}

function validRootName(value: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(value) && value !== "." && value !== "..";
}

function pathState(target: string, exists: boolean): RestoreJournalPathState {
  return { path: target, exists };
}

function isJournalPathState(rootDir: string, value: unknown, relativePath: string): value is RestoreJournalPathState {
  return Boolean(value)
    && typeof value === "object"
    && !Array.isArray(value)
    && (value as Record<string, unknown>).path === path.join(rootDir, relativePath)
    && typeof (value as Record<string, unknown>).exists === "boolean";
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function checkpointDatabaseFile(databasePath: string): void {
  const database = new Database(databasePath);
  try {
    const result = database.pragma("wal_checkpoint(TRUNCATE)") as Array<{ busy?: number }>;
    if (Number(result[0]?.busy ?? 0) !== 0) throw new Error("workspace_restore_stage_checkpoint_busy");
  } finally {
    database.close();
  }
}

async function existingFile(target: string): Promise<boolean> {
  try {
    const entry = await lstat(target);
    if (!entry.isFile()) throw new Error(`workspace_restore_current_file_type_invalid:${path.basename(target)}`);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function existingDirectory(target: string): Promise<boolean> {
  try {
    const entry = await lstat(target);
    if (!entry.isDirectory()) throw new Error(`workspace_restore_current_root_type_invalid:${path.basename(target)}`);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
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

async function moveIfPresent(source: string, destination: string): Promise<void> {
  if (!await pathExists(source)) return;
  await mkdir(path.dirname(destination), { recursive: true });
  await rename(source, destination);
}

async function removeIfPresent(target: string): Promise<void> {
  await rm(target, { recursive: true, force: true });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
