import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { defaultSettings, nowIso } from "@samurai-agent/core-schemas";
import type { WorkspaceBundleService } from "../backup/workspace-bundle-service";
import { WorkspaceKernelService } from "../kernel/workspace-kernel-service";
import {
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
  WorkspaceDriftIssue,
  WorkspaceHealthReport,
  WorkspaceIntegrityReport,
  WorkspaceRepairResult,
  WorkspaceRepairStep
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

/** Owns health, reconciliation, and retention policy only. */
export class WorkspaceMaintenanceService {
  constructor(
    private readonly kernel: WorkspaceKernelService,
    private readonly serviceProvider: () => WorkspaceMaintenanceServices,
    private readonly bundles: WorkspaceBundleService
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

  const backups = await this.bundles.listWorkspaceBackups();
  const removedBackups = backups.slice(policy.max_backups);
  for (const backup of removedBackups) {
    await this.bundles.deleteWorkspaceBackup(backup.id);
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

}

function workspaceLayoutDirs(rootDir: string): string[] {
  return [...new WorkspacePaths(rootDir).requiredDirectories];
}

function workspaceResourceBoundaries(): WorkspaceResourceBoundary[] {
  return kernelWorkspaceResourceBoundaries();
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
