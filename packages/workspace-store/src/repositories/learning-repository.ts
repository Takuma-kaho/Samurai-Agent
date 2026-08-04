import { cp, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  ExternalAssistRecordSchema,
  LearningResourceEdgeRecordSchema,
  LearningResourceVersionRecordSchema,
  createId,
  nowIso,
  redactPrivateData,
  type ActivityContextRef,
  type BackgroundReviewChangeRecord,
  type CuratorStateRecord,
  type ExternalAssistDiagnosticsReport,
  type ExternalAssistPhase,
  type ExternalAssistRecord,
  type ExternalAssistStatus,
  type LearningEvaluationRecord,
  type LearningResourceVersionRecord,
  type LearningJobReportRecord,
  type LearningResourceEdgeRecord,
  type LearningResourceUseRecord,
  type LearningSnapshotRecord,
  type ReflectionRunRecord,
  type ReflectionSuggestionRecord
} from "@samurai-agent/core-schemas";
import { sql, type Kysely } from "kysely";
import type { CuratorStateTable, LearningResourceUseTable, WorkspaceDb } from "../kernel/workspace-db-schema";
import type { MemoryWithFilePath, SkillSupportFile, SkillWithFilePath, WikiWithFilePath } from "../workspace-store-contracts";
import {
  externalAssistDiagnosticsRecommendation,
  externalAssistDiagnosticsViolations,
  groupExternalAssistDiagnostics,
  normalizeExternalAssistDiagnosticsLimit
} from "./external-assist-diagnostics";
import {
  backgroundReviewChangeFromRow,
  curatorStateFromRow,
  curatorStateToRow,
  defaultCuratorState,
  externalAssistRecordFromRow,
  externalAssistRecordToRow,
  learningEvaluationFromRow,
  learningResourceUseFromRow,
  learningResourceVersionFromRow,
  learningResourceVersionToRow,
  learningSnapshotFromRow,
  reflectionRunFromRow,
  reflectionRunToRow,
  reflectionSuggestionFromRow,
  reflectionSuggestionToRow
} from "./learning-row-codecs";
import { stringify, parse } from "./serialization";
import { pathExists } from "./workspace-file-codecs";

export interface LearningResourcesPort {
  listMemory(options: { includeArchived?: boolean; resourceIds?: string[]; includeLegacy?: boolean }): Promise<MemoryWithFilePath[]>;
  listSkills(options?: { resourceIds?: string[]; includeLegacy?: boolean }): Promise<SkillWithFilePath[]>;
  listWiki(options: { activeOnly?: boolean; resourceIds?: string[]; includeLegacy?: boolean }): Promise<WikiWithFilePath[]>;
  listSkillUsage(input?: { skillIds?: string[] }): Promise<unknown[]>;
  listSkillSupportFiles(skillId: string): Promise<SkillSupportFile[]>;
  synchronizeManagedResources(): Promise<{
    memory: { errors: Array<{ file_path: string; message: string }> };
    wiki: { errors: Array<{ file_path: string; message: string }> };
    skills: { errors: Array<{ file_path: string; message: string }> };
  }>;
}

export interface LearningSessionChangePort {
  deleteWorkspaceChangesBySummaryLike(summaryPattern: string): Promise<void>;
}

type SnapshotResourceKind = "memory" | "skill" | "wiki";
type LearningSnapshotScope = { kind: "legacy" } | { kind: "room"; roomId: string };

interface ScopedLearningSnapshotManifest {
  format: "core06-scoped-v1";
  scope: LearningSnapshotScope;
  resource_ids: Record<SnapshotResourceKind, string[]>;
  files: string[];
  resource_versions: LearningResourceVersionRecord[];
}

interface SnapshotResources {
  memory: MemoryWithFilePath[];
  skill: SkillWithFilePath[];
  wiki: WikiWithFilePath[];
}

/** Learning history, snapshots, reflection, and isolated external assist state. */
export class LearningRepository {
  constructor(
    private readonly db: Kysely<WorkspaceDb>,
    private readonly rootDir: string,
    private readonly resources: LearningResourcesPort,
    private readonly sessionChanges: LearningSessionChangePort
  ) {}

async recordLearningResourceUse(record: LearningResourceUseRecord): Promise<LearningResourceUseRecord> {
  const safeRecord = { ...record, metadata: redactPrivateData(record.metadata, { redactPii: true }) };
  const existing = await sql<LearningResourceUseTable>`
    SELECT * FROM learning_resource_uses
    WHERE run_id = ${record.run_id}
      AND resource_kind = ${record.resource_kind}
      AND resource_id = ${record.resource_id}
      AND stage = ${record.stage}
    LIMIT 1
  `.execute(this.db);
  const row = existing.rows[0];
  if (row) {
    if (record.stage === "applied" && (row.resource_version !== (record.resource_version ?? null) || row.content_hash !== (record.content_hash ?? null))) {
      throw new Error(`learning_resource_use_version_mismatch:${record.resource_id}`);
    }
    return learningResourceUseFromRow(row);
  }
  await sql`
    INSERT INTO learning_resource_uses (
      id, run_id, session_id, room_id, agent_id, resource_kind, resource_id, resource_version,
      content_hash, usage_scope_json, stage, source_operation_id, decision_summary, matched_conditions_json, metadata_json, created_at
    ) VALUES (
      ${record.id}, ${record.run_id}, ${record.session_id}, ${record.activity_context?.room_id ?? null}, ${record.activity_context?.agent_id ?? null}, ${record.resource_kind}, ${record.resource_id}, ${record.resource_version ?? null},
      ${safeRecord.content_hash ?? null}, ${safeRecord.usage_scope ? stringify(safeRecord.usage_scope) : null}, ${safeRecord.stage}, ${safeRecord.source_operation_id ?? null}, ${safeRecord.decision_summary ?? null}, ${safeRecord.matched_conditions ? stringify(safeRecord.matched_conditions) : null}, ${stringify(safeRecord.metadata)}, ${safeRecord.created_at}
    )
  `.execute(this.db);
  return safeRecord;
}

async listLearningResourceUses(input: {
  runId?: string;
  sessionId?: string;
  resourceKind?: string;
  resourceId?: string;
  resourceIds?: string[];
  activityContext?: ActivityContextRef;
} = {}): Promise<LearningResourceUseRecord[]> {
  let query = this.db.selectFrom("learning_resource_uses").selectAll().orderBy("created_at", "desc");
  if (input.runId) query = query.where("run_id", "=", input.runId);
  if (input.sessionId) query = query.where("session_id", "=", input.sessionId);
  if (input.resourceKind) query = query.where("resource_kind", "=", input.resourceKind);
  if (input.resourceId) query = query.where("resource_id", "=", input.resourceId);
  if (input.resourceIds !== undefined) {
    const resourceIds = [...new Set(input.resourceIds)];
    if (resourceIds.length === 0) return [];
    query = query.where("resource_id", "in", resourceIds);
  }
  if (input.activityContext) {
    query = query
      .where("session_id", "=", input.activityContext.session_id)
      .where("room_id", "=", input.activityContext.room_id)
      .where("agent_id", "=", input.activityContext.agent_id);
  }
  return (await query.execute()).map(learningResourceUseFromRow);
}

async saveLearningEvaluation(record: LearningEvaluationRecord): Promise<LearningEvaluationRecord> {
  await this.db.insertInto("learning_evaluations").values({
    id: record.id,
    learning_resource_ref_json: stringify(record.learning_resource_ref),
    learning_resource_version: record.learning_resource_version ?? null,
    task_class: record.task_class,
    compared_run_ids_json: stringify(record.compared_run_ids),
    before_metrics_json: stringify(record.before_metrics),
    after_metrics_json: stringify(record.after_metrics),
    effect_estimate: record.effect_estimate,
    confidence: record.confidence,
    assessment: record.assessment,
    evidence_refs_json: stringify(record.evidence_refs),
    evaluator: record.evaluator,
    evaluation_json: record.evaluation_kind === "applied" ? stringify(record) : null,
    created_at: record.created_at
  }).execute();
  return record;
}

/** Creates or advances a resource-local immutable history without duplicating the current body in SQLite. */
async saveLearningResourceVersion(input: {
  record: LearningResourceVersionRecord;
  previousContent?: string;
}): Promise<LearningResourceVersionRecord> {
  const record = input.record;
  if (!/^[A-Za-z0-9_-]+$/.test(record.resource_id) || !/^[A-Za-z0-9._-]+$/.test(record.version)) {
    throw new Error("learning_resource_version_identifier_invalid");
  }
  const current = record.is_current
    ? await this.db.selectFrom("learning_resource_versions").selectAll()
      .where("resource_kind", "=", record.resource_kind)
      .where("resource_id", "=", record.resource_id)
      .where("is_current", "=", 1)
      .executeTakeFirst()
    : undefined;
  if (current) {
    if (input.previousContent === undefined) throw new Error("learning_resource_version_previous_content_required");
    const historyPath = learningHistoryPath(record.resource_kind, record.resource_id, current.version);
    await writeHistoryFile(this.rootDir, historyPath, input.previousContent);
    await this.db.updateTable("learning_resource_versions").set({
      is_current: 0,
      file_path: historyPath
    }).where("id", "=", current.id).execute();
  }
  await this.db.insertInto("learning_resource_versions").values(learningResourceVersionToRow(record)).execute();
  return record;
}

async getLearningResourceVersion(input: { resourceKind: LearningResourceVersionRecord["resource_kind"]; resourceId: string; version: string }): Promise<LearningResourceVersionRecord | undefined> {
  const row = await this.db.selectFrom("learning_resource_versions").selectAll()
    .where("resource_kind", "=", input.resourceKind)
    .where("resource_id", "=", input.resourceId)
    .where("version", "=", input.version)
    .executeTakeFirst();
  return row ? learningResourceVersionFromRow(row) : undefined;
}

async getCurrentLearningResourceVersion(input: { resourceKind: LearningResourceVersionRecord["resource_kind"]; resourceId: string }): Promise<LearningResourceVersionRecord | undefined> {
  const row = await this.db.selectFrom("learning_resource_versions").selectAll()
    .where("resource_kind", "=", input.resourceKind)
    .where("resource_id", "=", input.resourceId)
    .where("is_current", "=", 1)
    .orderBy("created_at", "desc")
    .executeTakeFirst();
  return row ? learningResourceVersionFromRow(row) : undefined;
}

async listLearningResourceVersions(input: {
  resourceKind?: LearningResourceVersionRecord["resource_kind"];
  resourceId?: string;
  resourceIds?: string[];
} = {}): Promise<LearningResourceVersionRecord[]> {
  let query = this.db.selectFrom("learning_resource_versions").selectAll().orderBy("created_at", "desc");
  if (input.resourceKind) query = query.where("resource_kind", "=", input.resourceKind);
  if (input.resourceId) query = query.where("resource_id", "=", input.resourceId);
  if (input.resourceIds !== undefined) {
    const resourceIds = [...new Set(input.resourceIds)];
    if (resourceIds.length === 0) return [];
    query = query.where("resource_id", "in", resourceIds);
  }
  return (await query.execute()).map(learningResourceVersionFromRow);
}

async readLearningResourceVersionContent(input: { resourceKind: LearningResourceVersionRecord["resource_kind"]; resourceId: string; version: string }): Promise<string | undefined> {
  const record = await this.getLearningResourceVersion(input);
  if (!record || record.is_current) return undefined;
  return readFile(path.join(this.rootDir, record.file_path), "utf8").catch(() => undefined);
}

/** Activity context is indexed from the persisted evaluation payload at query time. */
async listLearningEvaluations(input: {
  resourceId?: string;
  resourceIds?: string[];
  taskClass?: string;
  activityContext?: ActivityContextRef;
} = {}): Promise<LearningEvaluationRecord[]> {
  let query = this.db.selectFrom("learning_evaluations").selectAll().orderBy("created_at", "desc");
  if (input.taskClass) query = query.where("task_class", "=", input.taskClass);
  if (input.resourceIds !== undefined) {
    const resourceIds = [...new Set(input.resourceIds)];
    if (resourceIds.length === 0) return [];
    query = query.where(sql<string>`json_extract(learning_resource_ref_json, '$.id')`, "in", resourceIds);
  }
  if (input.activityContext) {
    query = query
      .where(sql<string>`json_extract(evaluation_json, '$.activity_context.session_id')`, "=", input.activityContext.session_id)
      .where(sql<string>`json_extract(evaluation_json, '$.activity_context.room_id')`, "=", input.activityContext.room_id)
      .where(sql<string>`json_extract(evaluation_json, '$.activity_context.agent_id')`, "=", input.activityContext.agent_id);
  }
  const records = (await query.execute()).map(learningEvaluationFromRow);
  return input.resourceId ? records.filter((record) => record.learning_resource_ref.id === input.resourceId) : records;
}

async saveLearningResourceEdge(recordInput: LearningResourceEdgeRecord): Promise<LearningResourceEdgeRecord> {
  const record = LearningResourceEdgeRecordSchema.parse(recordInput);
  const directory = path.join(this.rootDir, "learning-graph", "edges"); await mkdir(directory,{recursive:true});
  const target=path.join(directory,`${record.id}.json`),pending=`${target}.pending`;await writeFile(pending,`${JSON.stringify(record,null,2)}\n`);await rename(pending,target);return record;
}

async listLearningResourceEdges(): Promise<LearningResourceEdgeRecord[]> {
  const directory=path.join(this.rootDir,"learning-graph","edges");const files=(await readdir(directory).catch(()=>[])).filter(x=>x.endsWith(".json")).sort();return Promise.all(files.map(async file=>LearningResourceEdgeRecordSchema.parse(JSON.parse(await readFile(path.join(directory,file),"utf8")))));
}

async createLearningSnapshot(runId: string): Promise<LearningSnapshotRecord> {
  const id = createId("learning_snapshot");
  const relativePath = path.join("learning-snapshots", id);
  const snapshotRoot = snapshotRootPath(this.rootDir, relativePath);
  const scope = await this.snapshotScope(runId);
  const sourceRoomResourceIds = await this.sourceRoomResourceIds(scope);
  const resources = await this.loadSnapshotResources(sourceRoomResourceIds, true);
  const resourceIds = snapshotResourceIds(resources);
  const [supportFiles, memoryVersions, skillVersions, wikiVersions, skillUsage, evaluations, resourceUses] = await Promise.all([
    Promise.all(resources.skill.map((skill) => this.resources.listSkillSupportFiles(skill.id))).then((files) => files.flat()),
    this.listLearningResourceVersions({ resourceKind: "memory", resourceIds: resourceIds.memory }),
    this.listLearningResourceVersions({ resourceKind: "skill", resourceIds: resourceIds.skill }),
    this.listLearningResourceVersions({ resourceKind: "wiki", resourceIds: resourceIds.wiki }),
    this.resources.listSkillUsage({ skillIds: resourceIds.skill }),
    this.listLearningEvaluations({ resourceIds: allSnapshotResourceIds(resourceIds) }),
    this.listLearningResourceUses({ resourceIds: allSnapshotResourceIds(resourceIds) })
  ]);
  const resourceVersions = [...memoryVersions, ...skillVersions, ...wikiVersions];
  const files = uniqueManagedResourcePaths([
    ...resources.memory.map((memory) => memory.file_path),
    ...resources.skill.map((skill) => skill.file_path),
    ...resources.wiki.map((page) => page.file_path),
    ...supportFiles.map((file) => file.file_path),
    ...resourceVersions.map((version) => version.file_path)
  ]);
  const manifest: ScopedLearningSnapshotManifest = {
    format: "core06-scoped-v1",
    scope,
    resource_ids: resourceIds,
    files,
    resource_versions: resourceVersions
  };
  await mkdir(snapshotRoot, { recursive: true });
  const snapshotFilesRoot = path.join(snapshotRoot, "files");
  for (const relativeFilePath of files) {
    const source = managedWorkspacePath(this.rootDir, relativeFilePath);
    if (!await pathExists(source)) throw new Error(`learning_snapshot_resource_file_missing:${relativeFilePath}`);
    const target = containedPath(snapshotFilesRoot, relativeFilePath, "learning_snapshot_file_path_invalid");
    await mkdir(path.dirname(target), { recursive: true });
    await cp(source, target, { force: true });
  }
  await writeFile(
    path.join(snapshotRoot, "learning-resource-versions.json"),
    `${JSON.stringify(resourceVersions, null, 2)}\n`
  );
  const record: LearningSnapshotRecord = {
    id,
    run_id: runId,
    path: relativePath,
    resource_counts: { memory: resources.memory.length, skills: resources.skill.length, support_files: supportFiles.length, wiki: resources.wiki.length },
    created_at: nowIso()
  };
  await writeFile(path.join(snapshotRoot, "manifest.json"), `${JSON.stringify(record, null, 2)}\n`);
  await writeFile(path.join(snapshotRoot, "core06-scope.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(path.join(snapshotRoot, "metadata.json"), `${JSON.stringify({ skill_usage: skillUsage, evaluations, resource_uses: resourceUses }, null, 2)}\n`);
  await this.db.insertInto("learning_snapshots").values({
    id: record.id,
    run_id: record.run_id,
    path: record.path,
    resource_counts_json: stringify(record.resource_counts),
    created_at: record.created_at,
    restored_at: null
  }).execute();
  await this.pruneLearningSnapshots(20);
  return record;
}

async listLearningSnapshots(): Promise<LearningSnapshotRecord[]> {
  // A public Curator snapshot is legacy Owner-only data. Room-scoped
  // compensation snapshots stay linked to their Room run and are never a
  // Workspace-wide listing result.
  return (await this.db
    .selectFrom("learning_snapshots")
    .leftJoin("reflection_runs", "reflection_runs.id", "learning_snapshots.run_id")
    .selectAll("learning_snapshots")
    .where("reflection_runs.room_id", "is", null)
    .orderBy("learning_snapshots.created_at", "desc")
    .execute()).map(learningSnapshotFromRow);
}

async pruneLearningSnapshots(retain = 20): Promise<{ retained: number; removed: string[] }> {
  const keep = Math.max(1, Math.min(Math.floor(retain), 200));
  const snapshots = await this.listAllLearningSnapshots();
  const removed: string[] = [];
  for (const snapshot of snapshots.slice(keep)) {
    await rm(snapshotRootPath(this.rootDir, snapshot.path), { recursive: true, force: true });
    await this.db.deleteFrom("learning_snapshots").where("id", "=", snapshot.id).execute();
    removed.push(snapshot.id);
  }
  return { retained: Math.min(snapshots.length, keep), removed };
}

async restoreLearningSnapshot(id: string, options: { allowRoomScope?: boolean } = {}): Promise<LearningSnapshotRecord | undefined> {
  const row = await this.db.selectFrom("learning_snapshots").selectAll().where("id", "=", id).executeTakeFirst();
  if (!row) return undefined;
  const snapshotRoot = snapshotRootPath(this.rootDir, row.path);
  const manifest = await readScopedLearningSnapshotManifest(snapshotRoot);
  if (manifest.scope.kind === "room") {
    const run = await this.getReflectionRun(row.run_id);
    if (run?.activity_context?.room_id !== manifest.scope.roomId) throw new Error("learning_snapshot_room_scope_mismatch");
    if (!options.allowRoomScope) throw new Error("learning_snapshot_room_scope_restore_requires_compensation");
  }
  const currentResources = await this.loadSnapshotResources(manifest.resource_ids, false);
  const createdResources = options.allowRoomScope
    ? await this.backgroundReviewResourcesCreatedAfterSnapshot(row.run_id, manifest.resource_ids)
    : emptySnapshotResourceIds();
  const currentCreatedResources = await this.loadSnapshotResources(createdResources, false);
  await this.removeSnapshotResources(currentResources);
  await this.removeSnapshotResources(currentCreatedResources);
  const snapshotFilesRoot = path.join(snapshotRoot, "files");
  for (const relativeFilePath of manifest.files) {
    const source = containedPath(snapshotFilesRoot, relativeFilePath, "learning_snapshot_file_path_invalid");
    if (!await pathExists(source)) throw new Error(`learning_snapshot_file_missing:${relativeFilePath}`);
    const target = managedWorkspacePath(this.rootDir, relativeFilePath);
    await mkdir(path.dirname(target), { recursive: true });
    await cp(source, target, { force: true });
  }
  const synchronization = await this.resources.synchronizeManagedResources();
  if (synchronization.memory.errors.length || synchronization.skills.errors.length || synchronization.wiki.errors.length) {
    throw new Error(`learning_snapshot_reindex_failed:${JSON.stringify({ memory: synchronization.memory.errors, skills: synchronization.skills.errors, wiki: synchronization.wiki.errors })}`);
  }
  await this.restoreSnapshotResourceVersions(manifest.resource_ids, createdResources, manifest.resource_versions);
  const restoredAt = nowIso();
  await this.db.updateTable("learning_snapshots").set({ restored_at: restoredAt }).where("id", "=", id).execute();
  return learningSnapshotFromRow({ ...row, restored_at: restoredAt });
}

private async snapshotScope(runId: string): Promise<LearningSnapshotScope> {
  const run = await this.getReflectionRun(runId);
  return run?.activity_context?.room_id
    ? { kind: "room", roomId: run.activity_context.room_id }
    : { kind: "legacy" };
}

private async sourceRoomResourceIds(scope: LearningSnapshotScope): Promise<Record<SnapshotResourceKind, string[]>> {
  if (scope.kind === "legacy") return emptySnapshotResourceIds();
  const rows = await this.db.selectFrom("resource_access_boundaries")
    .select(["resource_kind", "resource_id"])
    .where("source_room_id", "=", scope.roomId)
    .where("resource_kind", "in", ["memory", "skill", "wiki"])
    .execute();
  const ids = emptySnapshotResourceIds();
  for (const row of rows) {
    if (row.resource_kind === "memory" || row.resource_kind === "skill" || row.resource_kind === "wiki") {
      ids[row.resource_kind].push(row.resource_id);
    }
  }
  return normalizeSnapshotResourceIds(ids);
}

private async loadSnapshotResources(resourceIds: Record<SnapshotResourceKind, string[]>, includeLegacy: boolean): Promise<SnapshotResources> {
  return {
    memory: await this.resources.listMemory({ includeArchived: true, resourceIds: resourceIds.memory, includeLegacy }),
    skill: await this.resources.listSkills({ resourceIds: resourceIds.skill, includeLegacy }),
    wiki: await this.resources.listWiki({ activeOnly: false, resourceIds: resourceIds.wiki, includeLegacy })
  };
}

private async listAllLearningSnapshots(): Promise<LearningSnapshotRecord[]> {
  return (await this.db.selectFrom("learning_snapshots").selectAll().orderBy("created_at", "desc").execute()).map(learningSnapshotFromRow);
}

private async removeSnapshotResources(resources: SnapshotResources): Promise<void> {
  const supportFiles = (await Promise.all(resources.skill.map((skill) => this.resources.listSkillSupportFiles(skill.id)))).flat();
  const files = uniqueManagedResourcePaths([
    ...resources.memory.map((memory) => memory.file_path),
    ...resources.skill.map((skill) => skill.file_path),
    ...resources.wiki.map((page) => page.file_path),
    ...supportFiles.map((file) => file.file_path)
  ]);
  await Promise.all(files.map(async (relativeFilePath) => {
    await rm(managedWorkspacePath(this.rootDir, relativeFilePath), { force: true });
  }));
}

private async backgroundReviewResourcesCreatedAfterSnapshot(
  reviewRunId: string,
  snapshotIds: Record<SnapshotResourceKind, string[]>
): Promise<Record<SnapshotResourceKind, string[]>> {
  const changes = await this.listBackgroundReviewChanges({ reviewRunId });
  const created = emptySnapshotResourceIds();
  for (const change of changes) {
    const kind = change.resource_ref.kind === "knowledge_wiki" ? "wiki" : change.resource_ref.kind;
    if (!isSnapshotResourceKind(kind) || !isBackgroundReviewCreate(change.mutation_kind)) continue;
    if (!snapshotIds[kind].includes(change.resource_ref.id)) created[kind].push(change.resource_ref.id);
  }
  return normalizeSnapshotResourceIds(created);
}

private async restoreSnapshotResourceVersions(
  snapshotIds: Record<SnapshotResourceKind, string[]>,
  createdIds: Record<SnapshotResourceKind, string[]>,
  versions: LearningResourceVersionRecord[]
): Promise<void> {
  await this.db.transaction().execute(async (transaction) => {
    for (const kind of snapshotResourceKinds) {
      const ids = [...new Set([...snapshotIds[kind], ...createdIds[kind]])];
      if (ids.length) {
        await transaction.deleteFrom("learning_resource_versions")
          .where("resource_kind", "=", kind)
          .where("resource_id", "in", ids)
          .execute();
      }
    }
    if (versions.length) {
      await transaction.insertInto("learning_resource_versions").values(versions.map(learningResourceVersionToRow)).execute();
    }
  });
}

async saveBackgroundReviewChange(record: BackgroundReviewChangeRecord): Promise<BackgroundReviewChangeRecord> {
  await this.db.insertInto("background_review_changes").values({
    id: record.id,
    origin: record.origin,
    source_run_id: record.source_run_id,
    source_session_id: record.source_session_id,
    room_id: record.activity_context?.room_id ?? null,
    agent_id: record.activity_context?.agent_id ?? null,
    review_run_id: record.review_run_id,
    mutation_kind: record.mutation_kind,
    resource_ref_json: stringify(record.resource_ref),
    before_version: record.before_version ?? null,
    after_version: record.after_version,
    reason_summary: record.reason_summary,
    evidence_refs_json: stringify(record.evidence_refs),
    created_at: record.created_at
  }).execute();
  return record;
}

async rollbackBackgroundReviewMetadata(reviewRunId: string): Promise<void> {
  await this.db.transaction().execute(async (transaction) => {
    await transaction.deleteFrom("background_review_changes").where("review_run_id", "=", reviewRunId).execute();
    await transaction.deleteFrom("reflection_suggestions").where("reflection_run_id", "=", reviewRunId).execute();
  });
  await this.sessionChanges.deleteWorkspaceChangesBySummaryLike(`%Background Review ${reviewRunId}%`);
}

async listBackgroundReviewChanges(input: { sourceRunId?: string; reviewRunId?: string } = {}): Promise<BackgroundReviewChangeRecord[]> {
  let query = this.db.selectFrom("background_review_changes").selectAll().orderBy("created_at", "desc");
  if (input.sourceRunId) query = query.where("source_run_id", "=", input.sourceRunId);
  if (input.reviewRunId) query = query.where("review_run_id", "=", input.reviewRunId);
  return (await query.execute()).map(backgroundReviewChangeFromRow);
}

async saveLearningJobReport(record: LearningJobReportRecord): Promise<LearningJobReportRecord> {
  await this.db.insertInto("learning_job_reports").values({ id: record.id, job_kind: record.job_kind, run_id: record.run_id, report_json: stringify(record), created_at: record.created_at }).execute();
  return record;
}

/** Reports are read through their Reflection Run's Session when a Room scope is supplied. */
async listLearningJobReports(input: { sessionId?: string; jobKind?: LearningJobReportRecord["job_kind"]; limit?: number } = {}): Promise<LearningJobReportRecord[]> {
  if (input.sessionId) {
    let scoped = this.db
      .selectFrom("learning_job_reports as report")
      .innerJoin("reflection_runs as reflection", "reflection.id", "report.run_id")
      .selectAll("report")
      .where("reflection.session_id", "=", input.sessionId)
      .orderBy("report.created_at", "desc");
    if (input.jobKind) scoped = scoped.where("report.job_kind", "=", input.jobKind);
    if (input.limit) scoped = scoped.limit(input.limit);
    return (await scoped.execute()).map((row) => parse(row.report_json));
  }
  let query = this.db.selectFrom("learning_job_reports").selectAll().orderBy("created_at", "desc");
  if (input.jobKind) query = query.where("job_kind", "=", input.jobKind);
  if (input.limit) query = query.limit(input.limit);
  return (await query.execute()).map((row) => parse(row.report_json));
}

async getCuratorState(): Promise<CuratorStateRecord> {
  const result = await sql<CuratorStateTable>`
    SELECT id, paused, interval_hours, min_idle_hours, stale_after_days, archive_after_days, last_run_at, last_run_summary, run_count, updated_at
    FROM curator_state
    WHERE id = 'default'
  `.execute(this.db);
  const row = result.rows[0];
  return row ? curatorStateFromRow(row) : defaultCuratorState();
}

async saveCuratorState(patch: Partial<Omit<CuratorStateRecord, "id" | "updated_at">> = {}): Promise<CuratorStateRecord> {
  const current = await this.getCuratorState();
  const next: CuratorStateRecord = {
    ...current,
    ...patch,
    id: "default",
    updated_at: nowIso()
  };
  const row = curatorStateToRow(next);
  await sql`
    INSERT INTO curator_state (
      id,
      paused,
      interval_hours,
      min_idle_hours,
      stale_after_days,
      archive_after_days,
      last_run_at,
      last_run_summary,
      run_count,
      updated_at
    )
    VALUES (
      ${row.id},
      ${row.paused},
      ${row.interval_hours},
      ${row.min_idle_hours},
      ${row.stale_after_days},
      ${row.archive_after_days},
      ${row.last_run_at},
      ${row.last_run_summary},
      ${row.run_count},
      ${row.updated_at}
    )
    ON CONFLICT(id) DO UPDATE SET
      paused = excluded.paused,
      interval_hours = excluded.interval_hours,
      min_idle_hours = excluded.min_idle_hours,
      stale_after_days = excluded.stale_after_days,
      archive_after_days = excluded.archive_after_days,
      last_run_at = excluded.last_run_at,
      last_run_summary = excluded.last_run_summary,
      run_count = excluded.run_count,
      updated_at = excluded.updated_at
  `.execute(this.db);
  return next;
}



async createReflectionRun(run: ReflectionRunRecord): Promise<ReflectionRunRecord> {
  await this.db.insertInto("reflection_runs").values(reflectionRunToRow(run)).execute();
  return run;
}

/** At most one Background Review candidate is retained for a completed source run. */
async createLearningReviewCandidate(run: ReflectionRunRecord): Promise<ReflectionRunRecord> {
  if (!run.candidate_key || run.kind !== "background_review") throw new Error("learning_review_candidate_invalid");
  const existing = await this.db.selectFrom("reflection_runs").selectAll().where("candidate_key", "=", run.candidate_key).executeTakeFirst();
  if (existing) return reflectionRunFromRow(existing);
  try {
    await this.db.insertInto("reflection_runs").values(reflectionRunToRow(run)).execute();
    return run;
  } catch (error) {
    const concurrent = await this.db.selectFrom("reflection_runs").selectAll().where("candidate_key", "=", run.candidate_key).executeTakeFirst();
    if (concurrent) return reflectionRunFromRow(concurrent);
    throw error;
  }
}

async getReflectionRunByCandidateKey(candidateKey: string): Promise<ReflectionRunRecord | undefined> {
  const row = await this.db.selectFrom("reflection_runs").selectAll().where("candidate_key", "=", candidateKey).executeTakeFirst();
  return row ? reflectionRunFromRow(row) : undefined;
}

async updateReflectionRun(run: ReflectionRunRecord): Promise<ReflectionRunRecord> {
  await this.db.updateTable("reflection_runs").set(reflectionRunToRow(run)).where("id", "=", run.id).execute();
  return run;
}

async getReflectionRun(id: string): Promise<ReflectionRunRecord | undefined> {
  const row = await this.db.selectFrom("reflection_runs").selectAll().where("id", "=", id).executeTakeFirst();
  return row ? reflectionRunFromRow(row) : undefined;
}

async listReflectionRuns(sessionId?: string): Promise<ReflectionRunRecord[]> {
  let query = this.db.selectFrom("reflection_runs").selectAll();
  if (sessionId) {
    query = query.where("session_id", "=", sessionId);
  }
  const rows = await query.orderBy("started_at", "desc").execute();
  return rows.map(reflectionRunFromRow);
}

async saveReflectionSuggestion(suggestion: ReflectionSuggestionRecord): Promise<ReflectionSuggestionRecord> {
  await this.db.insertInto("reflection_suggestions").values(reflectionSuggestionToRow(suggestion)).execute();
  return suggestion;
}

async updateReflectionSuggestion(suggestion: ReflectionSuggestionRecord): Promise<ReflectionSuggestionRecord> {
  await this.db
    .updateTable("reflection_suggestions")
    .set(reflectionSuggestionToRow(suggestion))
    .where("id", "=", suggestion.id)
    .execute();
  return suggestion;
}

async listReflectionSuggestions(reflectionRunId?: string): Promise<ReflectionSuggestionRecord[]> {
  let query = this.db.selectFrom("reflection_suggestions").selectAll();
  if (reflectionRunId) {
    query = query.where("reflection_run_id", "=", reflectionRunId);
  }
  const rows = await query.orderBy("created_at", "desc").execute();
  return rows.map(reflectionSuggestionFromRow);
}



async saveExternalAssistRecord(record: ExternalAssistRecord): Promise<ExternalAssistRecord> {
  const parsed = ExternalAssistRecordSchema.parse(record);
  await this.db
    .insertInto("external_assist_records")
    .values(externalAssistRecordToRow(parsed))
    .onConflict((oc) => oc.column("id").doUpdateSet(externalAssistRecordToRow(parsed)))
    .execute();
  return parsed;
}

async listExternalAssistRecords(input: {
  sessionId?: string;
  phase?: ExternalAssistPhase;
  status?: ExternalAssistStatus;
  providerId?: string;
  limit?: number;
} = {}): Promise<ExternalAssistRecord[]> {
  let query = this.db.selectFrom("external_assist_records").selectAll();
  if (input.sessionId) {
    query = query.where("session_id", "=", input.sessionId);
  }
  if (input.phase) {
    query = query.where("phase", "=", input.phase);
  }
  if (input.status) {
    query = query.where("status", "=", input.status);
  }
  if (input.providerId) {
    query = query.where("provider_id", "=", input.providerId);
  }
  query = query.orderBy("created_at", "desc");
  if (input.limit !== undefined) {
    query = query.limit(input.limit);
  }
  const rows = await query.execute();
  return rows.map(externalAssistRecordFromRow);
}

async getExternalAssistDiagnostics(input: {
  sessionId?: string;
  phase?: ExternalAssistPhase;
  status?: ExternalAssistStatus;
  providerId?: string;
  limit?: number;
} = {}): Promise<ExternalAssistDiagnosticsReport> {
  const limit = normalizeExternalAssistDiagnosticsLimit(input.limit);
  const records = await this.listExternalAssistRecords({
    sessionId: input.sessionId,
    phase: input.phase,
    status: input.status,
    providerId: input.providerId,
    limit
  });
  const violations = externalAssistDiagnosticsViolations(records);

  return {
    generated_at: nowIso(),
    scope: {
      ...(input.sessionId ? { session_id: input.sessionId } : {}),
      ...(input.phase ? { phase: input.phase } : {}),
      ...(input.status ? { status: input.status } : {}),
      ...(input.providerId ? { provider_id: input.providerId } : {}),
      limit
    },
    total_records: records.length,
    failed_records: records.filter((record) => record.status === "failed").length,
    hint_count: records.reduce((count, record) => count + record.hints.length, 0),
    unisolated_records: records.filter((record) => !record.isolated_from_memory).length,
    included_in_active_memory_records: records.filter((record) => record.included_in_active_memory).length,
    groups: groupExternalAssistDiagnostics(records),
    violations,
    recent_failures: records.filter((record) => record.status === "failed").slice(0, 10),
    recommendation: externalAssistDiagnosticsRecommendation(records, violations)
  };
}

}

const snapshotResourceKinds = ["memory", "skill", "wiki"] as const;

function emptySnapshotResourceIds(): Record<SnapshotResourceKind, string[]> {
  return { memory: [], skill: [], wiki: [] };
}

function isSnapshotResourceKind(value: string): value is SnapshotResourceKind {
  return (snapshotResourceKinds as readonly string[]).includes(value);
}

function normalizeSnapshotResourceIds(input: Record<SnapshotResourceKind, string[]>): Record<SnapshotResourceKind, string[]> {
  return {
    memory: normalizeSnapshotIds(input.memory),
    skill: normalizeSnapshotIds(input.skill),
    wiki: normalizeSnapshotIds(input.wiki)
  };
}

function normalizeSnapshotIds(ids: string[]): string[] {
  return [...new Set(ids.map((id) => {
    if (!id.trim() || id.includes("/") || id.includes("\\")) throw new Error("learning_snapshot_resource_id_invalid");
    return id;
  }))].sort();
}

function snapshotResourceIds(resources: SnapshotResources): Record<SnapshotResourceKind, string[]> {
  return normalizeSnapshotResourceIds({
    memory: resources.memory.map((resource) => resource.id),
    skill: resources.skill.map((resource) => resource.id),
    wiki: resources.wiki.map((resource) => resource.id)
  });
}

function allSnapshotResourceIds(resourceIds: Record<SnapshotResourceKind, string[]>): string[] {
  return [...new Set([...resourceIds.memory, ...resourceIds.skill, ...resourceIds.wiki])];
}

function uniqueManagedResourcePaths(paths: string[]): string[] {
  return [...new Set(paths.map((value) => assertManagedRelativePath(value)))].sort();
}

function assertManagedRelativePath(value: string): string {
  const normalized = normalizeRelativePath(value, "learning_snapshot_file_path_invalid");
  const firstSegment = normalized.split(path.sep)[0];
  if (!firstSegment || !["memory", "skills", "wiki", "learning-history"].includes(firstSegment)) {
    throw new Error("learning_snapshot_file_path_invalid");
  }
  return normalized;
}

function normalizeRelativePath(value: string, errorCode: string): string {
  if (!value || path.isAbsolute(value)) throw new Error(errorCode);
  const normalized = path.normalize(value);
  if (normalized === "." || normalized === ".." || normalized.startsWith(`..${path.sep}`)) throw new Error(errorCode);
  return normalized;
}

function containedPath(root: string, relativePath: string, errorCode: string): string {
  const normalized = normalizeRelativePath(relativePath, errorCode);
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, normalized);
  if (!resolved.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error(errorCode);
  return resolved;
}

function managedWorkspacePath(rootDir: string, relativePath: string): string {
  return containedPath(rootDir, assertManagedRelativePath(relativePath), "learning_snapshot_file_path_invalid");
}

function snapshotRootPath(rootDir: string, relativePath: string): string {
  const normalized = normalizeRelativePath(relativePath, "learning_snapshot_path_invalid");
  if (!normalized.startsWith(`learning-snapshots${path.sep}`)) throw new Error("learning_snapshot_path_invalid");
  return containedPath(rootDir, normalized, "learning_snapshot_path_invalid");
}

async function readScopedLearningSnapshotManifest(snapshotRoot: string): Promise<ScopedLearningSnapshotManifest> {
  const raw = await readFile(path.join(snapshotRoot, "core06-scope.json"), "utf8").catch(() => undefined);
  if (!raw) throw new Error("learning_snapshot_scope_unknown");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("learning_snapshot_manifest_invalid");
  }
  if (!isRecord(parsed) || parsed.format !== "core06-scoped-v1" || !isRecord(parsed.resource_ids) || !Array.isArray(parsed.files) || !Array.isArray(parsed.resource_versions)) {
    throw new Error("learning_snapshot_manifest_invalid");
  }
  const scope = parseLearningSnapshotScope(parsed.scope);
  const resourceIds = emptySnapshotResourceIds();
  for (const kind of snapshotResourceKinds) {
    const ids = parsed.resource_ids[kind];
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) throw new Error("learning_snapshot_manifest_invalid");
    resourceIds[kind] = ids;
  }
  const normalizedResourceIds = normalizeSnapshotResourceIds(resourceIds);
  const files = uniqueManagedResourcePaths(parsed.files.map((file) => {
    if (typeof file !== "string") throw new Error("learning_snapshot_manifest_invalid");
    return file;
  }));
  const versions = LearningResourceVersionRecordSchema.array().parse(parsed.resource_versions);
  for (const version of versions) {
    if (!isSnapshotResourceKind(version.resource_kind) || !normalizedResourceIds[version.resource_kind].includes(version.resource_id)) {
      throw new Error("learning_snapshot_manifest_invalid");
    }
    assertManagedRelativePath(version.file_path);
  }
  return {
    format: "core06-scoped-v1",
    scope,
    resource_ids: normalizedResourceIds,
    files,
    resource_versions: versions
  };
}

function parseLearningSnapshotScope(value: unknown): LearningSnapshotScope {
  if (!isRecord(value) || typeof value.kind !== "string") throw new Error("learning_snapshot_manifest_invalid");
  if (value.kind === "legacy") return { kind: "legacy" };
  if (value.kind === "room" && typeof value.roomId === "string" && value.roomId.trim()) return { kind: "room", roomId: value.roomId };
  throw new Error("learning_snapshot_manifest_invalid");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBackgroundReviewCreate(kind: BackgroundReviewChangeRecord["mutation_kind"]): boolean {
  return kind === "memory_add" || kind === "skill_create" || kind === "wiki_create";
}

function learningHistoryPath(kind: LearningResourceVersionRecord["resource_kind"], resourceId: string, version: string): string {
  return path.join("learning-history", kind, resourceId, `${version}.md`);
}

async function writeHistoryFile(rootDir: string, relativePath: string, content: string): Promise<void> {
  const target = path.join(rootDir, relativePath);
  const pending = `${target}.pending`;
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(pending, content);
  await rename(pending, target);
}
