import { createHash, randomUUID } from "node:crypto";
import { access, copyFile, cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { defaultSettings, nowIso } from "@samurai-agent/core-schemas";
import { normalizeBackupId } from "../backup/backup-id";
import { WorkspaceKernelService } from "../kernel/workspace-kernel-service";
import {
  isWorkspaceResourceBoundary as isKernelWorkspaceResourceBoundary,
  workspaceBackupRoots as kernelWorkspaceBackupRoots,
  workspaceResourceBoundaries as kernelWorkspaceResourceBoundaries,
  WorkspacePaths,
  type WorkspaceResourceBoundary
} from "../kernel/workspace-paths";
import type {
  CollectionReindexResult,
  MemoryReindexResult,
  MigrationJournalRecord,
  SkillReindexResult,
  WikiReindexResult,
  WorkspaceBackupManifest,
  WorkspaceBackupRecord,
  WorkspaceDriftIssue,
  WorkspaceHealthReport,
  WorkspaceIntegrityReport,
  WorkspaceRepairResult,
  WorkspaceRepairStep,
  WorkspaceRestoreResult
} from "../workspace-store-contracts";
import { pathExists } from "../repositories/workspace-file-codecs";

export interface WorkspaceMaintenanceServices {
  artifacts: {
    inspectFilesystemIndex(): Promise<WorkspaceHealthReport["indexes"]["artifacts"]>;
  };
  memory: {
    inspectFilesystemIndex(): Promise<WorkspaceHealthReport["indexes"]["memory"]>;
  };
  wiki: {
    inspectFilesystemIndex(): Promise<WorkspaceHealthReport["indexes"]["wiki"]>;
  };
  skills: {
    inspectFilesystemIndex(): Promise<WorkspaceHealthReport["indexes"]["skills"]>;
  };
  collection: {
    inspectFilesystemIndex(): Promise<WorkspaceHealthReport["indexes"]["collections"]>;
    removeBrokenResourceRefs(input: Array<{ collection_id: string; record_id: string; ref: { kind: string; id: string; uri: string } }>): Promise<number>;
  };
  managedResources: {
    synchronizeAll(): Promise<{ memory: MemoryReindexResult; wiki: WikiReindexResult; skills: SkillReindexResult; collections: CollectionReindexResult }>;
    synchronizeMemory(): Promise<MemoryReindexResult>;
    synchronizeWiki(): Promise<WikiReindexResult>;
    synchronizeSkills(): Promise<SkillReindexResult>;
    synchronizeCollections(): Promise<CollectionReindexResult>;
  };
  gateway: {
    listGatewayDeliveries(): Promise<Array<{ id: string; status: string; updated_at: string }>>;
    removeGatewayDeliveries(ids: string[]): Promise<number>;
    reclaimExpiredGatewayConcurrencyLocks(now: string): Promise<unknown[]>;
    listGatewayConcurrencyLocks(input: { status?: "acquired"; limit?: number }): Promise<unknown[]>;
  };
  session: {
    listBackendRuns(): Promise<Array<{ id: string }>>;
    listBackendEvents(input: { runId: string }): Promise<Array<{ id: string }>>;
    removeBackendEvents(ids: string[]): Promise<number>;
  };
  learning: {
    pruneLearningSnapshots(maxSnapshots: number): Promise<Record<string, unknown>>;
  };
  metadata: {
    ensureDefaultSettings(settings: ReturnType<typeof defaultSettings>): Promise<void>;
  };
  queries: {
    inspectSessionSearchIndex(): Promise<WorkspaceHealthReport["indexes"]["search"]>;
    findBrokenCollectionResourceRefs(): Promise<Array<{
      collection_id: string;
      record_id: string;
      file_path: string;
      ref: { kind: string; id: string; uri: string };
    }>>;
    reindexSessionSearch(): Promise<{ mode: "fts5_trigram" | "fts5" | "like"; indexed: number }>;
    initializeSessionSearch(): Promise<void>;
  };
}

/** Workspace health, repair, backup/restore, import/export, and retention coordinator. */
export class WorkspaceMaintenanceService {
  constructor(
    private readonly kernel: WorkspaceKernelService,
    private readonly serviceProvider: () => WorkspaceMaintenanceServices,
    private readonly restoreFailureInjector: ((phase: "extract" | "hash_verify" | "swap") => void) | undefined,
    private readonly afterDatabaseReopen: () => Promise<void>
  ) {}

  private services(): WorkspaceMaintenanceServices {
    return this.serviceProvider();
  }

  private get rootDir(): string {
    return this.kernel.rootDir;
  }

async inspectWorkspace(): Promise<WorkspaceHealthReport> {
  const checkedAt = nowIso();
  const layoutChecks = await Promise.all(
    workspaceLayoutDirs(this.rootDir).map(async (dir) => ({
      path: path.relative(this.rootDir, dir) || ".",
      exists: await pathExists(dir),
      kind: "directory" as const,
      required: true
    }))
  );
  const missingLayout = layoutChecks.filter((check) => !check.exists).map((check) => check.path);
  const services = this.services();
  const [wikiHealth, artifactHealth, memoryHealth, skillHealth, collectionHealth, searchHealth, brokenCollectionRefs] = await Promise.all([
    services.wiki.inspectFilesystemIndex(),
    services.artifacts.inspectFilesystemIndex(),
    services.memory.inspectFilesystemIndex(),
    services.skills.inspectFilesystemIndex(),
    services.collection.inspectFilesystemIndex(),
    services.queries.inspectSessionSearchIndex(),
    services.queries.findBrokenCollectionResourceRefs()
  ]);
  const { missing_files: missingFiles, unindexed_files: unindexedFiles, invalid_files: invalidFiles, duplicate_ids: duplicateIds } = wikiHealth;
  const issues: WorkspaceDriftIssue[] = [];

  for (const item of missingFiles) {
    issues.push({
      code: "wiki_index_missing_file",
      severity: "warning",
      message: `Knowledge Wiki index points to a missing markdown file: ${item.file_path}`,
      file_path: item.file_path,
      resource_id: item.id
    });
  }
  for (const filePath of unindexedFiles) {
    issues.push({
      code: "wiki_file_unindexed",
      severity: "warning",
      message: `Knowledge Wiki markdown file is not present in SQLite index: ${filePath}`,
      file_path: filePath
    });
  }
  for (const item of invalidFiles) {
    issues.push({
      code: "wiki_file_invalid",
      severity: "error",
      message: `Knowledge Wiki markdown frontmatter is invalid: ${item.message}`,
      file_path: item.file_path
    });
  }
  for (const item of duplicateIds) {
    issues.push({
      code: "wiki_duplicate_id",
      severity: "error",
      message: `Knowledge Wiki id is duplicated across ${item.file_paths.length} files: ${item.id}`,
      resource_id: item.id
    });
  }
  for (const item of missingLayout) {
    issues.push({
      code: "workspace_layout_missing",
      severity: "error",
      message: `Workspace directory is missing: ${item}`,
      file_path: item
    });
  }
  for (const item of artifactHealth.missing_files) {
    issues.push({
      code: "artifact_metadata_missing_file",
      severity: "warning",
      message: `Artifact metadata points to a missing file: ${item.file_path}`,
      file_path: item.file_path,
      resource_id: item.id
    });
  }
  for (const filePath of artifactHealth.unindexed_files) {
    issues.push({
      code: "artifact_file_unindexed",
      severity: "warning",
      message: `Artifact file is not referenced by SQLite metadata: ${filePath}`,
      file_path: filePath
    });
  }
  for (const item of memoryHealth.missing_files) {
    issues.push({
      code: "memory_index_missing_file",
      severity: "warning",
      message: `Memory index points to a missing markdown file: ${item.file_path}`,
      file_path: item.file_path,
      resource_id: item.id
    });
  }
  for (const filePath of memoryHealth.unindexed_files) {
    issues.push({
      code: "memory_file_unindexed",
      severity: "warning",
      message: `Memory markdown file is not present in SQLite index: ${filePath}`,
      file_path: filePath
    });
  }
  for (const item of memoryHealth.invalid_files) {
    issues.push({
      code: "memory_file_invalid",
      severity: "error",
      message: `Memory markdown frontmatter is invalid: ${item.message}`,
      file_path: item.file_path
    });
  }
  for (const item of memoryHealth.duplicate_ids) {
    issues.push({
      code: "memory_duplicate_id",
      severity: "error",
      message: `Memory id is duplicated across ${item.file_paths.length} files: ${item.id}`,
      resource_id: item.id
    });
  }
  for (const item of skillHealth.missing_files) {
    issues.push({
      code: "skill_index_missing_file",
      severity: "warning",
      message: `Skill index points to a missing markdown file: ${item.file_path}`,
      file_path: item.file_path,
      resource_id: item.id
    });
  }
  for (const filePath of skillHealth.unindexed_files) {
    issues.push({
      code: "skill_file_unindexed",
      severity: "warning",
      message: `Skill markdown file is not present in SQLite index: ${filePath}`,
      file_path: filePath
    });
  }
  for (const item of skillHealth.invalid_files) {
    issues.push({
      code: "skill_file_invalid",
      severity: "error",
      message: `Skill markdown frontmatter is invalid: ${item.message}`,
      file_path: item.file_path
    });
  }
  for (const item of skillHealth.duplicate_ids) {
    issues.push({
      code: "skill_duplicate_id",
      severity: "error",
      message: `Skill id is duplicated across ${item.file_paths.length} files: ${item.id}`,
      resource_id: item.id
    });
  }
  for (const item of collectionHealth.schemas.missing_files) {
    issues.push({
      code: "collection_schema_index_missing_file",
      severity: "warning",
      message: `Collection schema index points to a missing file: ${item.file_path}`,
      file_path: item.file_path,
      resource_id: item.id
    });
  }
  for (const filePath of collectionHealth.schemas.unindexed_files) {
    issues.push({
      code: "collection_schema_file_unindexed",
      severity: "warning",
      message: `Collection schema file is not present in SQLite index: ${filePath}`,
      file_path: filePath
    });
  }
  for (const item of collectionHealth.schemas.invalid_files) {
    issues.push({
      code: "collection_schema_file_invalid",
      severity: "error",
      message: `Collection schema file is invalid: ${item.message}`,
      file_path: item.file_path
    });
  }
  for (const item of collectionHealth.records.missing_files) {
    issues.push({
      code: "collection_record_index_missing_file",
      severity: "warning",
      message: `Collection record index points to a missing file: ${item.file_path}`,
      file_path: item.file_path,
      resource_id: item.id
    });
  }
  for (const filePath of collectionHealth.records.unindexed_files) {
    issues.push({
      code: "collection_record_file_unindexed",
      severity: "warning",
      message: `Collection record file is not present in SQLite index: ${filePath}`,
      file_path: filePath
    });
  }
  for (const item of collectionHealth.records.invalid_files) {
    issues.push({
      code: "collection_record_file_invalid",
      severity: "error",
      message: `Collection record file is invalid: ${item.message}`,
      file_path: item.file_path
    });
  }
  for (const item of brokenCollectionRefs) {
    issues.push({
      code: "collection_record_broken_ref",
      severity: "warning",
      message: `Collection record references a missing local resource: ${item.ref.kind}/${item.ref.id}`,
      file_path: item.file_path,
      resource_id: item.record_id
    });
  }

  const repairPlan: WorkspaceRepairStep[] = [];
  if (missingFiles.length > 0 || unindexedFiles.length > 0) {
    repairPlan.push({
      operation: "wiki.reindex",
      reason: "Knowledge Wiki markdown files and SQLite index are out of sync.",
      effect: "Rebuild the derived wiki_index table from workspace/wiki/pages/*.md and remove stale index rows."
    });
  }
  if (invalidFiles.length > 0 || duplicateIds.length > 0) {
    repairPlan.push({
      operation: "manual_wiki_frontmatter_fix",
      reason: "Some Knowledge Wiki files cannot be safely indexed.",
      effect: "Fix invalid or duplicated frontmatter, then run wiki.reindex again."
    });
  }
  if (missingLayout.length > 0) {
    repairPlan.push({
      operation: "ensure_workspace_layout",
      reason: "Required Workspace directories are missing.",
      effect: "Recreate the standard Workspace directory layout."
    });
  }
  if (!collectionHealth.ok) {
    repairPlan.push({
      operation: "collection.reindex",
      reason: "Collection schema or record files and SQLite indexes are out of sync.",
      effect: "Rebuild Collection index rows from collections/*/schema.json and collections/*/records/*.json."
    });
  }
  if (brokenCollectionRefs.length > 0) {
    repairPlan.push({
      operation: "collection.remove_broken_refs",
      reason: "Collection records contain references to local resources that no longer exist.",
      effect: "Remove only confirmed-missing local references and increment affected record versions."
    });
  }
  if (!artifactHealth.ok) {
    repairPlan.push({
      operation: "manual_artifact_inventory_fix",
      reason: "Artifact body files and SQLite metadata are out of sync.",
      effect: "Restore missing artifact files from backup, or import/delete orphan files with an explicit user decision."
    });
  }
  if (memoryHealth.missing_files.length > 0 || memoryHealth.unindexed_files.length > 0) {
    repairPlan.push({
      operation: "memory.reindex",
      reason: "Memory markdown files and SQLite index are out of sync.",
      effect: "Rebuild the derived memory_index table from memory/*/*.md and remove stale index rows."
    });
  }
  if (memoryHealth.invalid_files.length > 0 || memoryHealth.duplicate_ids.length > 0) {
    repairPlan.push({
      operation: "manual_memory_frontmatter_fix",
      reason: "Some Memory files cannot be safely indexed.",
      effect: "Fix invalid or duplicated frontmatter, then run memory.reindex again."
    });
  }
  if (skillHealth.missing_files.length > 0 || skillHealth.unindexed_files.length > 0) {
    repairPlan.push({
      operation: "skill.reindex",
      reason: "Skill markdown files and SQLite index are out of sync.",
      effect: "Rebuild the derived skill_index table from skills/*/*.md and remove stale index rows."
    });
  }
  if (skillHealth.invalid_files.length > 0 || skillHealth.duplicate_ids.length > 0) {
    repairPlan.push({
      operation: "manual_skill_frontmatter_fix",
      reason: "Some Skill files cannot be safely indexed.",
      effect: "Fix invalid or duplicated frontmatter, then run skill.reindex again."
    });
  }
  if (searchHealth.stale) {
    issues.push({ code: "session_search_index_stale", severity: "warning", message: "Session Search index does not match source records." });
    repairPlan.push({ operation: "session_search.reindex", reason: "Session Search index is stale.", effect: "Rebuild FTS read models from Session, Message, and Artifact sources." });
  }

  const wikiOk = wikiHealth.ok;
  const layoutOk = missingLayout.length === 0;
  return {
    ok: layoutOk && wikiOk && artifactHealth.ok && memoryHealth.ok && skillHealth.ok && collectionHealth.ok && searchHealth.ok && brokenCollectionRefs.length === 0,
    checked_at: checkedAt,
    root_dir: this.rootDir,
    db_path: this.kernel.dbPath,
    layout: {
      ok: layoutOk,
      checks: layoutChecks,
      missing: missingLayout
    },
    resource_boundaries: workspaceResourceBoundaries(),
    indexes: {
      search: searchHealth,
      wiki: wikiHealth,
      artifacts: artifactHealth,
      memory: memoryHealth,
      skills: skillHealth,
      collections: collectionHealth
    },
    issues,
    repair_plan: repairPlan
  };
}

async checkIntegrity(): Promise<WorkspaceIntegrityReport> {
  const [workspace, integrity] = await Promise.all([
    this.inspectWorkspace(),
    this.kernel.checkDatabaseIntegrity()
  ]);
  return {
    ok: integrity.ok && workspace.ok,
    checked_at: nowIso(),
    db: {
      ok: integrity.ok,
      result: integrity.result,
      path: this.kernel.dbPath
    },
    workspace
  };
}

async listMigrationJournal(limit = 20): Promise<MigrationJournalRecord[]> {
  const rows = await this.kernel.listMigrationJournal(limit);
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    status: row.status as MigrationJournalRecord["status"],
    details: JSON.parse(row.details_json),
    created_at: row.created_at
  }));
}

async repairWorkspace(options: { dryRun?: boolean } = {}): Promise<WorkspaceRepairResult> {
  const dryRun = options.dryRun ?? true;
  const before = await this.inspectWorkspace();
  const result: WorkspaceRepairResult = {
    dry_run: dryRun,
    plan: before.repair_plan,
    applied: [],
    skipped: [],
    health: before
  };
  if (dryRun) {
    return result;
  }

  for (const step of before.repair_plan) {
    if (step.operation === "ensure_workspace_layout") {
      await this.kernel.paths.ensureWorkspaceLayout();
      result.applied.push(step.operation);
      continue;
    }
    if (step.operation === "wiki.reindex") {
      result.wiki_reindex = await this.services().managedResources.synchronizeWiki();
      result.applied.push(step.operation);
      continue;
    }
    if (step.operation === "memory.reindex") {
      result.memory_reindex = await this.services().managedResources.synchronizeMemory();
      result.applied.push(step.operation);
      continue;
    }
    if (step.operation === "skill.reindex") {
      result.skill_reindex = await this.services().managedResources.synchronizeSkills();
      result.applied.push(step.operation);
      continue;
    }
    if (step.operation === "collection.reindex") {
      result.collection_reindex = await this.services().managedResources.synchronizeCollections();
      result.applied.push(step.operation);
      continue;
    }
    if (step.operation === "collection.remove_broken_refs") {
      await this.removeBrokenCollectionResourceRefs();
      result.applied.push(step.operation);
      continue;
    }
    if (step.operation === "session_search.reindex") {
      await this.services().queries.reindexSessionSearch();
      result.applied.push(step.operation);
      continue;
    }
    result.skipped.push(step.operation);
  }

  result.health = await this.inspectWorkspace();
  return result;
}

private async removeBrokenCollectionResourceRefs(): Promise<number> {
  return this.services().collection.removeBrokenResourceRefs(await this.services().queries.findBrokenCollectionResourceRefs());
}

async createWorkspaceBackup(): Promise<WorkspaceBackupRecord> {
  await this.kernel.checkpoint();
  const [health, dbIntegrity] = await Promise.all([
    this.inspectWorkspace(),
    this.kernel.checkDatabaseIntegrity()
  ]);
  const id = createBackupId();
  const relativeBackupPath = path.join("backups", id);
  const backupPath = path.join(this.rootDir, relativeBackupPath);
  const filesPath = path.join(backupPath, "files");
  await mkdir(filesPath, { recursive: true });
  await copyFile(this.kernel.dbPath, path.join(backupPath, "workspace.sqlite"));
  const copiedRoots: string[] = [];

  for (const rootName of workspaceBackupRoots()) {
    const source = path.join(this.rootDir, rootName);
    if (!await pathExists(source)) {
      continue;
    }
    await cp(source, path.join(filesPath, rootName), { recursive: true, force: true });
    copiedRoots.push(rootName);
  }

  const fileHashes = await hashFilesUnderRoot(backupPath, ["manifest.json"]);

  const manifest: WorkspaceBackupManifest = {
    id,
    created_at: nowIso(),
    source_root: this.rootDir,
    db_file: "workspace.sqlite",
    file_roots: copiedRoots,
    resource_boundaries: health.resource_boundaries,
    health_ok: health.ok,
    integrity_ok: health.ok && dbIntegrity.ok,
    file_hashes: fileHashes
  };
  await writeFile(path.join(backupPath, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return {
    id,
    path: relativeBackupPath,
    manifest
  };
}

async listWorkspaceBackups(): Promise<WorkspaceBackupRecord[]> {
  const backupsRoot = path.join(this.rootDir, "backups");
  let entries: string[];
  try {
    entries = await readdir(backupsRoot);
  } catch {
    return [];
  }
  const records = await Promise.all(entries.map(async (entry) => {
    try {
      const id = normalizeBackupId(entry);
      const manifest = parseWorkspaceBackupManifest(JSON.parse(await readFile(path.join(backupsRoot, id, "manifest.json"), "utf8")));
      return {
        id,
        path: path.join("backups", id),
        manifest
      };
    } catch {
      return undefined;
    }
  }));
  return records
    .filter((record): record is WorkspaceBackupRecord => Boolean(record))
    .sort((a, b) => b.manifest.created_at.localeCompare(a.manifest.created_at));
}

async applyResourceRetention(policy: {
  max_queue: number;
  max_concurrency: number;
  max_context_tokens: number;
  max_file_bytes: number;
  max_events_per_run: number;
  max_backups: number;
  max_snapshots: number;
  now?: string;
}) {
  const now = policy.now ?? nowIso();
  for (const [key, value] of Object.entries(policy)) {
    if (key !== "now" && (!Number.isFinite(value as number) || (value as number) <= 0)) {
      throw new Error(`resource_limit_invalid:${key}`);
    }
  }

  const gateway = this.services().gateway;
  const session = this.services().session;
  const deliveries = await gateway.listGatewayDeliveries();
  const activeQueue = deliveries.filter((delivery) => !["delivered", "failed"].includes(delivery.status));
  if (activeQueue.length > policy.max_queue) {
    throw new Error(`resource_queue_limit_exceeded:${activeQueue.length}:${policy.max_queue}`);
  }
  const completed = deliveries.filter((delivery) => delivery.status === "delivered")
    .sort((left, right) => right.updated_at.localeCompare(left.updated_at));
  const removedDeliveries = completed.slice(policy.max_queue);
  await gateway.removeGatewayDeliveries(removedDeliveries.map((delivery) => delivery.id));

  const expiredLocks = await gateway.reclaimExpiredGatewayConcurrencyLocks(now);
  const activeLocks = await gateway.listGatewayConcurrencyLocks({ status: "acquired", limit: 10_000 });
  if (activeLocks.length > policy.max_concurrency) {
    throw new Error(`resource_concurrency_limit_exceeded:${activeLocks.length}:${policy.max_concurrency}`);
  }

  let removedEvents = 0;
  for (const run of await session.listBackendRuns()) {
    const events = await session.listBackendEvents({ runId: run.id });
    const toRemove = events.slice(0, Math.max(0, events.length - policy.max_events_per_run));
    removedEvents += await session.removeBackendEvents(toRemove.map((event) => event.id));
  }

  const backups = await this.listWorkspaceBackups();
  const removedBackups = backups.slice(policy.max_backups);
  for (const backup of removedBackups) {
    await rm(path.join(this.rootDir, backup.path), { recursive: true, force: true });
  }
  const snapshotResult = await this.services().learning.pruneLearningSnapshots(policy.max_snapshots);
  const indexResult = await this.services().queries.reindexSessionSearch();
  const fileBytes = await directoryByteSize(this.rootDir, ["backups"]);
  if (fileBytes > policy.max_file_bytes) {
    throw new Error(`resource_file_limit_exceeded:${fileBytes}:${policy.max_file_bytes}`);
  }
  return {
    checked_at: now,
    limits: policy,
    queue: { active: activeQueue.length, removed_completed: removedDeliveries.length },
    concurrency: { active: activeLocks.length, reclaimed: expiredLocks.length },
    context: { max_tokens: policy.max_context_tokens },
    files: { bytes: fileBytes, max_bytes: policy.max_file_bytes },
    events: { removed: removedEvents, max_per_run: policy.max_events_per_run },
    backups: { retained: Math.min(backups.length, policy.max_backups), removed: removedBackups.map((backup) => backup.id) },
    snapshots: snapshotResult,
    index: { rebuilt: true, ...indexResult }
  };
}

async exportWorkspaceBundle(destinationRoot: string): Promise<{ path: string; backup: WorkspaceBackupRecord }> {
  const backup = await this.createWorkspaceBackup();
  const destination = path.join(path.resolve(destinationRoot), `samurai-workspace-${backup.id}`);
  if (await pathExists(destination)) throw new Error("workspace_export_destination_exists");
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(path.join(this.rootDir, backup.path), destination, { recursive: true, force: false, errorOnExist: true });
  return { path: destination, backup };
}

async importWorkspaceBundle(bundlePath: string): Promise<WorkspaceRestoreResult> {
  const source = path.resolve(bundlePath);
  const manifest = parseWorkspaceBackupManifest(JSON.parse(await readFile(path.join(source, "manifest.json"), "utf8")));
  const destination = path.join(this.rootDir, "backups", manifest.id);
  if (await pathExists(destination)) throw new Error("workspace_import_backup_exists");
  await cp(source, destination, { recursive: true, force: false, errorOnExist: true });
  try {
    return await this.restoreWorkspaceBackup(manifest.id);
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
}

async restoreWorkspaceBackup(backupId: string): Promise<WorkspaceRestoreResult> {
  const safeId = normalizeBackupId(backupId);
  const backupPath = path.join(this.rootDir, "backups", safeId);
  const manifest = parseWorkspaceBackupManifest(JSON.parse(await readFile(path.join(backupPath, "manifest.json"), "utf8")));
  const backupDbPath = path.join(backupPath, manifest.db_file);
  const preRestoreHealth = await this.inspectWorkspace();
  const restoredPaths: string[] = [];
  const restoreId = `${safeId}-${randomUUID().slice(0, 8)}`;
  const stagedRoot = path.join(this.rootDir, `.restore-stage-${restoreId}`);
  const rollbackRoot = path.join(this.rootDir, `.restore-rollback-${restoreId}`);
  await mkdir(path.join(stagedRoot, "files"), { recursive: true });
  try {
    await copyFile(backupDbPath, path.join(stagedRoot, "workspace.sqlite"));
    for (const rootName of manifest.file_roots) {
      const source = path.join(backupPath, "files", rootName);
      if (!await pathExists(source)) {
        continue;
      }
      await cp(source, path.join(stagedRoot, "files", rootName), { recursive: true, force: true });
    }
    this.restoreFailureInjector?.("extract");

    const stagedHashes = await hashFilesUnderRoot(stagedRoot);
    if (Object.keys(manifest.file_hashes).length === 0 || JSON.stringify(stagedHashes) !== JSON.stringify(manifest.file_hashes)) {
      throw new Error("workspace_backup_hash_mismatch");
    }
    const integrity = this.kernel.verifyDatabaseFileIntegrity(path.join(stagedRoot, "workspace.sqlite"));
    if (integrity !== "ok") throw new Error(`workspace_backup_integrity_failed:${String(integrity)}`);
    this.restoreFailureInjector?.("hash_verify");

    await this.kernel.checkpoint();
    await this.kernel.close();
    await mkdir(rollbackRoot, { recursive: true });
    let swapped = false;
    try {
      if (await pathExists(this.kernel.dbPath)) await rename(this.kernel.dbPath, path.join(rollbackRoot, "workspace.sqlite"));
      for (const rootName of workspaceBackupRoots()) {
        const current = path.join(this.rootDir, rootName);
        if (await pathExists(current)) await rename(current, path.join(rollbackRoot, rootName));
      }
      this.restoreFailureInjector?.("swap");
      await rename(path.join(stagedRoot, "workspace.sqlite"), this.kernel.dbPath);
      for (const rootName of manifest.file_roots) {
        const source = path.join(stagedRoot, "files", rootName);
        if (!await pathExists(source)) continue;
        await rename(source, path.join(this.rootDir, rootName));
        restoredPaths.push(rootName);
      }
      swapped = true;
    } catch (error) {
      await rm(this.kernel.dbPath, { force: true });
      for (const rootName of workspaceBackupRoots()) await rm(path.join(this.rootDir, rootName), { recursive: true, force: true });
      if (await pathExists(path.join(rollbackRoot, "workspace.sqlite"))) await rename(path.join(rollbackRoot, "workspace.sqlite"), this.kernel.dbPath);
      for (const rootName of workspaceBackupRoots()) {
        const original = path.join(rollbackRoot, rootName);
        if (await pathExists(original)) await rename(original, path.join(this.rootDir, rootName));
      }
      throw error;
    } finally {
      await this.kernel.reopen(); await this.afterDatabaseReopen();
    }
    if (!swapped) throw new Error("workspace_restore_swap_incomplete");
    await this.kernel.paths.ensureWorkspaceLayout();
    await this.kernel.migrate();
    await this.kernel.recoverWorkspaceFileTransactions();
    await this.services().metadata.ensureDefaultSettings(defaultSettings());
    await this.services().managedResources.synchronizeAll();
    await this.services().queries.initializeSessionSearch();
    await rm(rollbackRoot, { recursive: true, force: true });
  } finally {
    await rm(stagedRoot, { recursive: true, force: true });
  }

  const health = await this.inspectWorkspace();
  const integrity = await this.checkIntegrity();
  return {
    backup_id: safeId,
    restored_at: nowIso(),
    restored_paths: restoredPaths,
    db_restored: true,
    manifest,
    pre_restore_health: preRestoreHealth,
    integrity,
    health
  };
}


}

function workspaceLayoutDirs(rootDir: string): string[] {
  return [...new WorkspacePaths(rootDir).requiredDirectories];
}

function workspaceBackupRoots(): string[] {
  return kernelWorkspaceBackupRoots();
}

function workspaceResourceBoundaries(): WorkspaceResourceBoundary[] {
  return kernelWorkspaceResourceBoundaries();
}

function createBackupId(): string {
  return `backup_${new Date().toISOString().replace(/[:.]/g, "-")}_${randomUUID().slice(0, 8)}`;
}

function parseWorkspaceBackupManifest(value: unknown): WorkspaceBackupManifest {
  if (!value || typeof value !== "object") throw new Error("workspace_backup_manifest_invalid");
  const manifest = value as Record<string, unknown>;
  if (
    typeof manifest.id !== "string"
    || typeof manifest.created_at !== "string"
    || typeof manifest.source_root !== "string"
    || manifest.db_file !== "workspace.sqlite"
    || !Array.isArray(manifest.file_roots)
    || typeof manifest.health_ok !== "boolean"
  ) {
    throw new Error("workspace_backup_manifest_invalid");
  }
  return {
    id: normalizeBackupId(manifest.id),
    created_at: manifest.created_at,
    source_root: manifest.source_root,
    db_file: manifest.db_file,
    file_roots: manifest.file_roots.filter((item): item is string => typeof item === "string"),
    resource_boundaries: Array.isArray(manifest.resource_boundaries)
      ? manifest.resource_boundaries.filter(isWorkspaceResourceBoundary)
      : workspaceResourceBoundaries(),
    health_ok: manifest.health_ok,
    integrity_ok: typeof manifest.integrity_ok === "boolean" ? manifest.integrity_ok : manifest.health_ok,
    file_hashes: manifest.file_hashes && typeof manifest.file_hashes === "object"
      ? Object.fromEntries(Object.entries(manifest.file_hashes as Record<string, unknown>)
        .filter((entry): entry is [string, string] => typeof entry[1] === "string"))
      : {}
  };
}

async function hashFilesUnderRoot(root: string, excluded: string[] = []): Promise<Record<string, string>> {
  const excludedSet = new Set(excluded);
  const files = (await listRelativeFiles(root)).filter((file) => !excludedSet.has(file)).sort();
  const entries = await Promise.all(files.map(async (file) => {
    const content = await readFile(path.join(root, file));
    return [file, createHash("sha256").update(content).digest("hex")] as const;
  }));
  return Object.fromEntries(entries);
}

function isWorkspaceResourceBoundary(value: unknown): value is WorkspaceResourceBoundary {
  return isKernelWorkspaceResourceBoundary(value);
}

async function listRelativeFiles(rootDir: string, currentDir = rootDir): Promise<string[]> {
  const entries = await readdir(currentDir, { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(entries.map(async (entry) => {
    const absolutePath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) return listRelativeFiles(rootDir, absolutePath);
    if (!entry.isFile()) return [];
    return [path.relative(rootDir, absolutePath)];
  }));
  return nested.flat();
}

async function directoryByteSize(rootDir: string, excludedRoots: string[] = []): Promise<number> {
  let total = 0;
  const excluded = new Set(excludedRoots);
  const walk = async (directory: string, relative = ""): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const childRelative = relative ? path.join(relative, entry.name) : entry.name;
      if (!relative && excluded.has(entry.name)) continue;
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolutePath, childRelative);
      else if (entry.isFile()) total += (await stat(absolutePath)).size;
    }
  };
  await walk(rootDir);
  return total;
}
