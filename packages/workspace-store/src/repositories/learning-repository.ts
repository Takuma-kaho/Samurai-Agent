import { cp, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  ExternalAssistRecordSchema,
  LearningResourceEdgeRecordSchema,
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
  learningSnapshotFromRow,
  reflectionRunFromRow,
  reflectionRunToRow,
  reflectionSuggestionFromRow,
  reflectionSuggestionToRow
} from "./learning-row-codecs";
import { stringify, parse } from "./serialization";
import { pathExists } from "./workspace-file-codecs";

export interface LearningResourcesPort {
  listMemory(options: { includeArchived?: boolean }): Promise<MemoryWithFilePath[]>;
  listSkills(): Promise<SkillWithFilePath[]>;
  listWiki(options: { activeOnly?: boolean }): Promise<WikiWithFilePath[]>;
  listSkillUsage(): Promise<unknown[]>;
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
      AND COALESCE(source_operation_id, '') = COALESCE(${record.source_operation_id ?? null}, '')
    LIMIT 1
  `.execute(this.db);
  const row = existing.rows[0];
  if (row) {
    return learningResourceUseFromRow(row);
  }
  await sql`
    INSERT INTO learning_resource_uses (
      id, run_id, session_id, room_id, agent_id, resource_kind, resource_id, resource_version,
      content_hash, stage, source_operation_id, metadata_json, created_at
    ) VALUES (
      ${record.id}, ${record.run_id}, ${record.session_id}, ${record.activity_context?.room_id ?? null}, ${record.activity_context?.agent_id ?? null}, ${record.resource_kind}, ${record.resource_id}, ${record.resource_version ?? null},
      ${safeRecord.content_hash ?? null}, ${safeRecord.stage}, ${safeRecord.source_operation_id ?? null}, ${stringify(safeRecord.metadata)}, ${safeRecord.created_at}
    )
  `.execute(this.db);
  return safeRecord;
}

async listLearningResourceUses(input: {
  runId?: string;
  sessionId?: string;
  resourceId?: string;
  activityContext?: ActivityContextRef;
} = {}): Promise<LearningResourceUseRecord[]> {
  let query = this.db.selectFrom("learning_resource_uses").selectAll().orderBy("created_at", "desc");
  if (input.runId) query = query.where("run_id", "=", input.runId);
  if (input.sessionId) query = query.where("session_id", "=", input.sessionId);
  if (input.resourceId) query = query.where("resource_id", "=", input.resourceId);
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
    created_at: record.created_at
  }).execute();
  return record;
}

async listLearningEvaluations(input: { resourceId?: string; taskClass?: string } = {}): Promise<LearningEvaluationRecord[]> {
  let query = this.db.selectFrom("learning_evaluations").selectAll().orderBy("created_at", "desc");
  if (input.taskClass) query = query.where("task_class", "=", input.taskClass);
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
  const snapshotRoot = path.join(this.rootDir, relativePath);
  await mkdir(snapshotRoot, { recursive: true });
  for (const rootName of ["memory", "skills", "wiki", "learning-graph"]) {
    const source = path.join(this.rootDir, rootName);
    if (await pathExists(source)) await cp(source, path.join(snapshotRoot, rootName), { recursive: true, force: true });
  }
  const [memories, skills, wiki, skillUsage, evaluations, resourceUses] = await Promise.all([
    this.resources.listMemory({ includeArchived: true }), this.resources.listSkills(), this.resources.listWiki({ activeOnly: false }), this.resources.listSkillUsage(), this.listLearningEvaluations(), this.listLearningResourceUses()
  ]);
  const supportFiles = (await Promise.all(skills.map((skill) => this.resources.listSkillSupportFiles(skill.id)))).flat();
  const record: LearningSnapshotRecord = {
    id,
    run_id: runId,
    path: relativePath,
    resource_counts: { memory: memories.length, skills: skills.length, support_files: supportFiles.length, wiki: wiki.length },
    created_at: nowIso()
  };
  await writeFile(path.join(snapshotRoot, "manifest.json"), `${JSON.stringify(record, null, 2)}\n`);
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
  return (await this.db.selectFrom("learning_snapshots").selectAll().orderBy("created_at", "desc").execute()).map(learningSnapshotFromRow);
}

async pruneLearningSnapshots(retain = 20): Promise<{ retained: number; removed: string[] }> {
  const keep = Math.max(1, Math.min(Math.floor(retain), 200));
  const snapshots = await this.listLearningSnapshots();
  const removed: string[] = [];
  for (const snapshot of snapshots.slice(keep)) {
    await rm(path.join(this.rootDir, snapshot.path), { recursive: true, force: true });
    await this.db.deleteFrom("learning_snapshots").where("id", "=", snapshot.id).execute();
    removed.push(snapshot.id);
  }
  return { retained: Math.min(snapshots.length, keep), removed };
}

async restoreLearningSnapshot(id: string): Promise<LearningSnapshotRecord | undefined> {
  const row = await this.db.selectFrom("learning_snapshots").selectAll().where("id", "=", id).executeTakeFirst();
  if (!row) return undefined;
  const snapshotRoot = path.join(this.rootDir, row.path);
  for (const rootName of ["memory", "skills", "wiki", "learning-graph"]) {
    const snapshotSource = path.join(snapshotRoot, rootName);
    await rm(path.join(this.rootDir, rootName), { recursive: true, force: true });
    if (await pathExists(snapshotSource)) {
      await cp(snapshotSource, path.join(this.rootDir, rootName), { recursive: true, force: true });
    }
  }
  const synchronization = await this.resources.synchronizeManagedResources();
  if (synchronization.memory.errors.length || synchronization.skills.errors.length || synchronization.wiki.errors.length) {
    throw new Error(`learning_snapshot_reindex_failed:${JSON.stringify({ memory: synchronization.memory.errors, skills: synchronization.skills.errors, wiki: synchronization.wiki.errors })}`);
  }
  const restoredAt = nowIso();
  await this.db.updateTable("learning_snapshots").set({ restored_at: restoredAt }).where("id", "=", id).execute();
  return learningSnapshotFromRow({ ...row, restored_at: restoredAt });
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

async listLearningJobReports(input: { jobKind?: LearningJobReportRecord["job_kind"]; limit?: number } = {}): Promise<LearningJobReportRecord[]> {
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
