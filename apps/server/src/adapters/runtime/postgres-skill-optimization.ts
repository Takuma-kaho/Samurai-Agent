import {
  BackendRunRecordSchema,
  LearningResourceUseRecordSchema,
  ObjectiveRecordSchema,
  OptimizationCandidateSchema,
  OptimizationEvaluationSchema,
  OptimizationPromotionSchema,
  SkillFrontmatterSchema,
  SkillOptimizationDatasetSchema,
  SkillOptimizationRunSchema,
  SkillOptimizationSnapshotSchema,
  SkillStateSchema,
  WorkItemRecordSchema,
  stableHash,
  type BackendRunRecord,
  type LearningResourceUseRecord,
  type ObjectiveRecord,
  type OptimizationCandidate,
  type OptimizationEvaluation,
  type OptimizationPromotion,
  type SkillFrontmatter,
  type SkillOptimizationDataset,
  type SkillOptimizationRun,
  type SkillOptimizationSnapshot,
  type WorkItemRecord
} from "@samurai-agent/core-schemas";
import {
  PostgresWorkspaceDatabase,
  WorkspaceServerError,
  type WorkspaceCompletionResource,
  type WorkspaceCompletionResourceInput,
  type WorkspaceCompletionResourceVersion,
  type WorkspaceCompletionSkillFile,
  type WorkspaceCompletionResourceWriteResult,
  type WorkspaceRequestContext,
  type WorkspaceSql
} from "@samurai-agent/workspace-server";
import type {
  OptimizationSkill,
  SkillOptimizationPort
} from "@samurai-agent/runtime";

/**
 * The Completion dependency is deliberately the only owner of Skill bodies
 * and package files.  WorkspaceCompletionService is the current PostgreSQL
 * implementation; this narrow type keeps the adapter usable by a focused DB
 * mock without creating a second file transaction path.
 */
export interface PostgresCompletionService {
  getResource(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, resourceId: string): Promise<{ resource: WorkspaceCompletionResource; version: WorkspaceCompletionResourceVersion }>;
  getResourceBody(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, resourceId: string, requestedVersion?: number): Promise<{ resource: WorkspaceCompletionResource; version: WorkspaceCompletionResourceVersion; content: string }>;
  getSkillFile(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, resourceId: string, relativePath: string, requestedVersion?: number): Promise<{ file: WorkspaceCompletionSkillFile; content: Buffer }>;
  listSkillFiles(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, resourceId: string, requestedVersion?: number, limit?: number): Promise<WorkspaceCompletionSkillFile[]>;
  updateResource(context: WorkspaceRequestContext, resourceId: string, input: Omit<WorkspaceCompletionResourceInput, "id"> & { expectedVersion: number }): Promise<WorkspaceCompletionResourceWriteResult>;
}

export interface PostgresSkillOptimizationOptions<TSkill extends OptimizationSkill = OptimizationSkill> {
  database: PostgresWorkspaceDatabase;
  completion: PostgresCompletionService;
  workspaceId: string;
  accountId: string;
  repoRoot: string;
  /** Used only when an Objective has no Session reference. */
  roomId?: string;
  hostComplete?: (input: { sessionId?: string; messages: Array<{ role: string; content: string }> }) => Promise<{ content: string }>;
  savePresentations?: (input: { sessionId: string; run: SkillOptimizationRun; candidates: OptimizationCandidate[] }) => Promise<void>;
  /** Keeps the generic parameter visible to callers that use a richer Skill projection. */
  skillType?: (skill: OptimizationSkill) => TSkill;
}

type StoredRow = { record?: unknown; status?: unknown; room_id?: unknown; worker_id?: unknown; lease_until?: unknown; attempt?: unknown };
type LockRow = { run_id: string; acquired_at?: string | Date };

/** PostgreSQL adapter for the Runtime SkillOptimizationPort. */
export class PostgresSkillOptimization<TSkill extends OptimizationSkill = OptimizationSkill> implements SkillOptimizationPort<TSkill> {
  private readonly database: PostgresWorkspaceDatabase;
  private readonly completion: PostgresCompletionService;
  private readonly workspaceId: string;
  private readonly accountId: string;
  private readonly root: string;
  private readonly defaultRoomId?: string;
  private readonly hostCompleteHandler?: PostgresSkillOptimizationOptions<TSkill>["hostComplete"];
  private readonly presentationsHandler?: PostgresSkillOptimizationOptions<TSkill>["savePresentations"];
  private readonly skillType?: (skill: OptimizationSkill) => TSkill;

  constructor(options: PostgresSkillOptimizationOptions<TSkill>) {
    assertId(options.workspaceId, "workspace_id_invalid");
    assertId(options.accountId, "account_id_invalid");
    if (!options.repoRoot.trim()) throw new WorkspaceServerError("skill_optimization_repo_root_required", 500);
    this.database = options.database;
    this.completion = options.completion;
    this.workspaceId = options.workspaceId;
    this.accountId = options.accountId;
    this.root = options.repoRoot;
    this.defaultRoomId = options.roomId;
    this.hostCompleteHandler = options.hostComplete;
    this.presentationsHandler = options.savePresentations;
    this.skillType = options.skillType;
  }

  repoRoot(): string { return this.root; }

  async getSkill(id: string): Promise<TSkill | undefined> {
    const document = await this.readSkillDocument(id);
    if (!document) return undefined;
    const skill: OptimizationSkill = {
      id: document.resource.id,
      title: document.resource.title,
      state: document.frontmatter.state,
      file_path: document.version.filePath,
      frontmatter: document.frontmatter,
      ...(document.resource.scope.kind === "room" && document.resource.scope.roomId ? { room_id: document.resource.scope.roomId } : {})
    };
    return this.skillType ? this.skillType(skill) : skill as TSkill;
  }

  async readMarkdown(id: string): Promise<string | undefined> {
    const document = await this.readSkillDocument(id);
    return document ? renderSkillMarkdown(document.frontmatter, document.content) : undefined;
  }

  async listUses(input: { resourceId: string }): Promise<LearningResourceUseRecord[]> {
    assertId(input.resourceId, "skill_id_invalid");
    return this.withSql(async (sql) => {
      const result = await sql.query<CompletionUseRow>(
        `SELECT use_event.workspace_id, use_event.id, use_event.resource_id, use_event.resource_version,
                use_event.activity_id, use_event.episode_id, use_event.event, use_event.summary, use_event.created_at,
                version.content_hash, resource.scope_kind, resource.room_id,
                activity.operation_id, activity.session_ref
         FROM workspace_completion_uses use_event
         JOIN workspace_completion_resource_versions version
           ON version.workspace_id = use_event.workspace_id
          AND version.resource_id = use_event.resource_id
          AND version.version = use_event.resource_version
         JOIN workspace_completion_resources resource
           ON resource.workspace_id = use_event.workspace_id AND resource.id = use_event.resource_id
         LEFT JOIN workspace_completion_activities activity
           ON activity.workspace_id = use_event.workspace_id AND activity.id = use_event.activity_id
         WHERE use_event.workspace_id = $1
           AND use_event.resource_id = $2
           AND use_event.event = 'body_loaded'
         ORDER BY use_event.created_at ASC, use_event.id ASC`,
        [this.workspaceId, input.resourceId]
      );
      return result.rows.map((row) => LearningResourceUseRecordSchema.parse({
        id: row.id,
        run_id: row.operation_id || row.activity_id || row.id,
        ...(sessionIdFromRef(row.session_ref) ? { session_id: sessionIdFromRef(row.session_ref) } : {}),
        resource_kind: "skill",
        resource_id: row.resource_id,
        resource_version: String(row.resource_version),
        content_hash: row.content_hash,
        usage_scope: row.scope_kind === "room" && row.room_id ? { kind: "room", room_id: row.room_id } : { kind: "workspace" },
        stage: "body_loaded",
        metadata: { completion_use_id: row.id, event: row.event, summary: row.summary },
        created_at: iso(row.created_at)
      }));
    });
  }

  async getBackendRun(id: string): Promise<BackendRunRecord | undefined> {
    assertId(id, "backend_run_id_invalid");
    return this.withSql(async (sql) => {
      const result = await sql.query<RuntimeRunRow>(
        `SELECT workspace_id, id, session_id, room_id, principal, source, session_ref, agent_id,
                requested_by_participant_id, input_message_id, output_message_id, backend_id, backend_kind,
                backend_session_id, status, phase, current_attempt, request_idempotency_key, request_hash,
                started_at, completed_at, input_summary, output_summary, error_code, metadata
         FROM workspace_runtime_runs
         WHERE workspace_id = $1 AND id = $2`,
        [this.workspaceId, id]
      );
      const row = result.rows[0];
      return row ? BackendRunRecordSchema.parse({
        id: row.id,
        ...(row.session_id ? { session_id: row.session_id } : {}),
        ...(row.room_id ? { room_id: row.room_id } : {}),
        ...(row.principal ? { principal: jsonValue(row.principal) } : {}),
        ...(row.source ? { source: jsonValue(row.source) } : {}),
        ...(row.session_ref ? { session_ref: jsonValue(row.session_ref) } : {}),
        ...(row.agent_id ? { agent_id: row.agent_id } : {}),
        ...(row.requested_by_participant_id ? { requested_by_participant_id: row.requested_by_participant_id } : {}),
        ...(row.input_message_id ? { input_message_id: row.input_message_id } : {}),
        ...(row.output_message_id ? { output_message_id: row.output_message_id } : {}),
        backend_id: row.backend_id,
        backend_kind: row.backend_kind,
        ...(row.backend_session_id ? { backend_session_id: row.backend_session_id } : {}),
        status: row.status,
        ...(row.phase ? { phase: row.phase } : {}),
        ...(row.current_attempt === null || row.current_attempt === undefined ? {} : { current_attempt: Number(row.current_attempt) }),
        ...(row.request_idempotency_key ? { request_idempotency_key: row.request_idempotency_key } : {}),
        ...(row.request_hash ? { request_hash: row.request_hash } : {}),
        started_at: iso(row.started_at),
        ...(row.completed_at ? { completed_at: iso(row.completed_at) } : {}),
        input_summary: row.input_summary,
        ...(row.output_summary ? { output_summary: row.output_summary } : {}),
        ...(row.error_code ? { error_code: row.error_code } : {}),
        metadata: jsonObject(row.metadata)
      }) : undefined;
    });
  }

  async getSession(id: string): Promise<{ id: string; ui_locale: string; output_locale: string; room_id?: string } | undefined> {
    assertId(id, "session_id_invalid");
    return this.withSql(async (sql) => {
      const result = await sql.query<SessionRow>(
        `SELECT workspace_id, id, room_id, ui_locale, output_locale
         FROM workspace_runtime_sessions
         WHERE workspace_id = $1 AND id = $2`,
        [this.workspaceId, id]
      );
      const row = result.rows[0];
      return row ? { id: row.id, ui_locale: row.ui_locale, output_locale: row.output_locale, ...(row.room_id ? { room_id: row.room_id } : {}) } : undefined;
    });
  }

  async acquireLock(input: { skillId: string; runId: string; acquiredAt: string }): Promise<boolean> {
    assertId(input.skillId, "skill_id_invalid");
    assertId(input.runId, "skill_optimization_run_id_invalid");
    assertIso(input.acquiredAt, "skill_optimization_lock_time_invalid");
    const roomId = await this.roomForSkill(input.skillId);
    return this.withSql(async (sql) => {
      const result = await sql.query<{ skill_id: string }>(
        `INSERT INTO workspace_skill_optimization_locks(workspace_id, skill_id, run_id, room_id, acquired_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (workspace_id, skill_id) DO NOTHING
         RETURNING skill_id`,
        [this.workspaceId, input.skillId, input.runId, roomId, input.acquiredAt]
      );
      return Boolean(result.rows[0]);
    });
  }

  async getLock(skillId: string): Promise<{ run_id: string } | undefined> {
    assertId(skillId, "skill_id_invalid");
    return this.withSql(async (sql) => {
      const result = await sql.query<LockRow>(
        `SELECT workspace_id, skill_id, run_id, acquired_at
         FROM workspace_skill_optimization_locks
         WHERE workspace_id = $1 AND skill_id = $2`,
        [this.workspaceId, skillId]
      );
      return result.rows[0] ? { run_id: result.rows[0].run_id } : undefined;
    });
  }

  async releaseLock(input: { skillId: string; runId: string }): Promise<boolean> {
    assertId(input.skillId, "skill_id_invalid");
    assertId(input.runId, "skill_optimization_run_id_invalid");
    return this.withSql(async (sql) => {
      const result = await sql.query<{ skill_id: string }>(
        `DELETE FROM workspace_skill_optimization_locks
         WHERE workspace_id = $1 AND skill_id = $2 AND run_id = $3
         RETURNING skill_id`,
        [this.workspaceId, input.skillId, input.runId]
      );
      return Boolean(result.rows[0]);
    });
  }

  async saveDataset(record: SkillOptimizationDataset): Promise<SkillOptimizationDataset> {
    const normalized = SkillOptimizationDatasetSchema.parse(record);
    const roomId = await this.roomForSkill(normalized.skill_id);
    await this.upsertRecord("workspace_skill_optimization_datasets", normalized.id, {
      columns: ["skill_id", "room_id", "record", "created_at"],
      values: [normalized.skill_id, roomId, jsonText(normalized), normalized.created_at],
      updates: ["skill_id = EXCLUDED.skill_id", "room_id = EXCLUDED.room_id", "record = EXCLUDED.record"]
    });
    return normalized;
  }

  async saveObjective(record: ObjectiveRecord, roomId: string): Promise<ObjectiveRecord> {
    const normalized = ObjectiveRecordSchema.parse(record);
    const storedRoomId = normalized.room_id ?? await this.roomForSession(normalized.session_id);
    if (!storedRoomId || storedRoomId !== roomId) throw new WorkspaceServerError("skill_optimization_room_mismatch", 409);
    await this.upsertRecord("workspace_skill_optimization_objectives", normalized.id, {
      columns: ["room_id", "status", "record", "created_at", "updated_at"],
      values: [storedRoomId, normalized.status, jsonText(normalized), normalized.created_at, normalized.updated_at],
      updates: ["room_id = EXCLUDED.room_id", "status = EXCLUDED.status", "record = EXCLUDED.record", "updated_at = EXCLUDED.updated_at"]
    });
    return normalized;
  }

  async getObjective(id: string, roomId: string): Promise<ObjectiveRecord | undefined> {
    return this.getRecord("workspace_skill_optimization_objectives", id, ObjectiveRecordSchema, "skill_optimization_objective_record_invalid", roomId);
  }

  async updateObjective(record: ObjectiveRecord, roomId: string): Promise<ObjectiveRecord> {
    const normalized = ObjectiveRecordSchema.parse(record);
    if (normalized.room_id !== roomId) throw new WorkspaceServerError("skill_optimization_room_mismatch", 409);
    await this.withSql(async (sql) => {
      const result = await sql.query(
        "UPDATE workspace_skill_optimization_objectives SET status = $4, record = $5::JSONB, updated_at = $6 WHERE workspace_id = $1 AND id = $2 AND room_id = $3",
        [this.workspaceId, normalized.id, roomId, normalized.status, jsonText(normalized), normalized.updated_at]
      );
      if (Number(result.rowCount ?? 0) === 0) throw new WorkspaceServerError("workspace_skill_optimization_objectives_not_found", 404);
    });
    return normalized;
  }

  async saveWorkItem(record: WorkItemRecord, roomId: string): Promise<WorkItemRecord> {
    const normalized = WorkItemRecordSchema.parse(record);
    const objectiveRoomId = await this.roomForObjective(normalized.objective_id);
    if (normalized.room_id !== roomId || (objectiveRoomId && roomId !== objectiveRoomId)) {
      throw new WorkspaceServerError("skill_optimization_room_mismatch", 409);
    }
    await this.upsertRecord("workspace_skill_optimization_work_items", normalized.id, {
      columns: ["objective_id", "room_id", "status", "worker_id", "lease_until", "attempt", "record", "created_at", "updated_at"],
      values: [normalized.objective_id, roomId, normalized.status, normalized.lease_owner ?? null, normalized.lease_expires_at ?? null, normalized.attempt, jsonText(normalized), normalized.created_at, normalized.updated_at],
      updates: ["objective_id = EXCLUDED.objective_id", "room_id = EXCLUDED.room_id", "status = EXCLUDED.status", "worker_id = EXCLUDED.worker_id", "lease_until = EXCLUDED.lease_until", "attempt = EXCLUDED.attempt", "record = EXCLUDED.record", "updated_at = EXCLUDED.updated_at"]
    });
    return normalized;
  }

  async getWorkItem(id: string, roomId: string): Promise<WorkItemRecord | undefined> {
    return this.getRecord("workspace_skill_optimization_work_items", id, WorkItemRecordSchema, "skill_optimization_work_item_record_invalid", roomId);
  }

  async claimWorkItem(input: { workerId: string; leaseMs: number; now: string; roomId?: string }): Promise<WorkItemRecord | undefined> {
    assertId(input.workerId, "skill_optimization_worker_id_invalid");
    if (!Number.isSafeInteger(input.leaseMs) || input.leaseMs <= 0) throw new WorkspaceServerError("skill_optimization_lease_invalid", 400);
    assertIso(input.now, "skill_optimization_time_invalid");
    return this.withSql(async (sql) => {
      const candidates = await sql.query<WorkItemRow>(
        `SELECT workspace_id, id, objective_id, status, worker_id, lease_until, attempt, record, created_at, updated_at
         FROM workspace_skill_optimization_work_items
         WHERE workspace_id = $1 AND (status IN ('queued', 'ready')
           OR (status = 'running' AND lease_until IS NOT NULL AND lease_until <= $2))
           AND room_id IS NOT NULL
           AND ($3::TEXT IS NULL OR room_id = $3)
           AND (lease_until IS NULL OR lease_until <= $2)
         ORDER BY COALESCE((record->>'priority')::INTEGER, 0) DESC, created_at ASC, id ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 50`,
        [this.workspaceId, input.now, input.roomId ?? null]
      );
      for (const row of candidates.rows) {
        const current = parseRecord(row.record, WorkItemRecordSchema, "skill_optimization_work_item_record_invalid");
        if (current.status !== "queued" && current.status !== "ready" && current.status !== "running") continue;
        if (current.attempt >= current.max_attempts) continue;
        if (current.retry_after_at && Date.parse(current.retry_after_at) > Date.parse(input.now)) continue;
        const leaseUntil = new Date(Date.parse(input.now) + input.leaseMs).toISOString();
        const next = WorkItemRecordSchema.parse({
          ...current,
          status: "running",
          lease_owner: input.workerId,
          lease_expires_at: leaseUntil,
          heartbeat_at: input.now,
          attempt: current.attempt + 1,
          started_at: current.started_at ?? input.now,
          updated_at: input.now,
          retry_after_at: undefined,
          failure_kind: undefined,
          error: undefined
        });
        await sql.query(
          `UPDATE workspace_skill_optimization_work_items
           SET status = $3, worker_id = $4, lease_until = $5, attempt = $6, record = $7::JSONB, updated_at = $8
           WHERE workspace_id = $1 AND id = $2
             AND (status IN ('queued', 'ready') OR (status = 'running' AND lease_until <= $8))
           RETURNING id`,
          [this.workspaceId, current.id, next.status, input.workerId, leaseUntil, next.attempt, jsonText(next), input.now]
        );
        return next;
      }
      return undefined;
    });
  }

  async heartbeatWorkItem(input: { workItemId: string; workerId: string; roomId: string; leaseMs: number; now: string }): Promise<WorkItemRecord | undefined> {
    assertId(input.workItemId, "skill_optimization_work_item_id_invalid");
    assertId(input.workerId, "skill_optimization_worker_id_invalid");
    if (!Number.isSafeInteger(input.leaseMs) || input.leaseMs <= 0) throw new WorkspaceServerError("skill_optimization_lease_invalid", 400);
    assertIso(input.now, "skill_optimization_time_invalid");
    const leaseUntil = new Date(Date.parse(input.now) + input.leaseMs).toISOString();
    return this.withSql(async (sql) => {
      const result = await sql.query<WorkItemRow>(
        `UPDATE workspace_skill_optimization_work_items
         SET lease_until = $4,
             record = jsonb_set(record, '{heartbeat_at}', to_jsonb($2::TEXT), true),
             updated_at = $2
         WHERE workspace_id = $1 AND id = $3 AND room_id = $6 AND status = 'running' AND worker_id = $5
           AND lease_until IS NOT NULL AND lease_until > $2
         RETURNING workspace_id, id, objective_id, status, worker_id, lease_until, attempt, record, created_at, updated_at`,
        [this.workspaceId, input.now, input.workItemId, leaseUntil, input.workerId, input.roomId]
      );
      const row = result.rows[0];
      return row ? parseRecord(row.record, WorkItemRecordSchema, "skill_optimization_work_item_record_invalid") : undefined;
    });
  }

  async completeWorkItem(input: { workItemId: string; workerId: string; roomId: string }): Promise<WorkItemRecord | undefined> {
    return this.transitionWorkItem(input.workItemId, input.workerId, input.roomId, "completed");
  }

  async failWorkItem(input: { workItemId: string; workerId: string; roomId: string; failureKind: "cancelled" | "non_retryable"; error: string }): Promise<WorkItemRecord | undefined> {
    if (!input.error.trim()) throw new WorkspaceServerError("skill_optimization_work_item_error_required", 400);
    return this.transitionWorkItem(input.workItemId, input.workerId, input.roomId, input.failureKind === "cancelled" ? "cancelled" : "failed", input.failureKind, input.error);
  }

  async getRun(id: string): Promise<SkillOptimizationRun | undefined> {
    return this.getRecord("workspace_skill_optimization_runs", id, SkillOptimizationRunSchema, "skill_optimization_run_record_invalid");
  }

  async getDataset(id: string): Promise<SkillOptimizationDataset | undefined> {
    return this.getRecord("workspace_skill_optimization_datasets", id, SkillOptimizationDatasetSchema, "skill_optimization_dataset_record_invalid");
  }

  async findRunByWorkItem(workItemId: string): Promise<SkillOptimizationRun | undefined> {
    assertId(workItemId, "skill_optimization_work_item_id_invalid");
    return this.withSql(async (sql) => {
      const result = await sql.query<StoredRow>(
        `SELECT workspace_id, id, target_skill_id, room_id, session_id, status, record, created_at, updated_at
           FROM workspace_skill_optimization_runs
          WHERE workspace_id = $1 AND record->>'work_item_id' = $2
          ORDER BY created_at DESC, id DESC
          LIMIT 1`,
        [this.workspaceId, workItemId]
      );
      const row = result.rows[0];
      return row ? parseRecord(row.record, SkillOptimizationRunSchema, "skill_optimization_run_record_invalid") : undefined;
    });
  }

  async listRuns(input: { skillId?: string; roomId?: string; limit?: number } = {}): Promise<SkillOptimizationRun[]> {
    const clauses = ["workspace_id = $1"];
    const values: unknown[] = [this.workspaceId];
    if (input.skillId) { values.push(input.skillId); clauses.push(`target_skill_id = $${values.length}`); }
    if (input.roomId) { values.push(input.roomId); clauses.push(`room_id = $${values.length}`); }
    values.push(skillOptimizationLimit(input.limit));
    return this.withSql(async (sql) => {
      const result = await sql.query<StoredRow>(
        `SELECT workspace_id, id, target_skill_id, room_id, session_id, status, record, created_at, updated_at
           FROM workspace_skill_optimization_runs
          WHERE ${clauses.join(" AND ")}
          ORDER BY created_at DESC, id DESC LIMIT $${values.length}`,
        values
      );
      return result.rows.map((row) => parseRecord(row.record, SkillOptimizationRunSchema, "skill_optimization_run_record_invalid"));
    });
  }

  async detail(id: string): Promise<{
    run: SkillOptimizationRun;
    dataset?: SkillOptimizationDataset;
    candidates: OptimizationCandidate[];
    evaluations: OptimizationEvaluation[];
    promotions: OptimizationPromotion[];
    snapshots: SkillOptimizationSnapshot[];
  } | undefined> {
    const run = await this.getRun(id);
    if (!run) return undefined;
    const [dataset, candidates, promotions, snapshots] = await Promise.all([
      this.getRecord("workspace_skill_optimization_datasets", run.dataset_id, SkillOptimizationDatasetSchema, "skill_optimization_dataset_record_invalid"),
      this.listRecords("workspace_skill_optimization_candidates", "run_id", run.id, OptimizationCandidateSchema, "skill_optimization_candidate_record_invalid"),
      this.listRecords("workspace_skill_optimization_promotions", "run_id", run.id, OptimizationPromotionSchema, "skill_optimization_promotion_record_invalid"),
      this.listRecords("workspace_skill_optimization_snapshots", "run_id", run.id, SkillOptimizationSnapshotSchema, "skill_optimization_snapshot_record_invalid")
    ]);
    const evaluations = (await Promise.all(candidates.map((candidate) => this.listRecords("workspace_skill_optimization_evaluations", "candidate_id", candidate.id, OptimizationEvaluationSchema, "skill_optimization_evaluation_record_invalid")))).flat();
    return { run, ...(dataset ? { dataset } : {}), candidates, evaluations, promotions, snapshots };
  }

  async saveRun(record: SkillOptimizationRun): Promise<SkillOptimizationRun> {
    const normalized = SkillOptimizationRunSchema.parse(record);
    const roomId = await this.roomForSkill(normalized.target_skill_id);
    await this.upsertRecord("workspace_skill_optimization_runs", normalized.id, {
      columns: ["target_skill_id", "room_id", "session_id", "status", "record", "created_at", "updated_at"],
      values: [normalized.target_skill_id, roomId, normalized.session_id ?? null, normalized.status, jsonText(normalized), normalized.created_at, normalized.updated_at],
      updates: ["target_skill_id = EXCLUDED.target_skill_id", "room_id = EXCLUDED.room_id", "session_id = EXCLUDED.session_id", "status = EXCLUDED.status", "record = EXCLUDED.record", "updated_at = EXCLUDED.updated_at"]
    });
    return normalized;
  }

  async getCandidate(id: string): Promise<OptimizationCandidate | undefined> {
    return this.getRecord("workspace_skill_optimization_candidates", id, OptimizationCandidateSchema, "skill_optimization_candidate_record_invalid");
  }

  async saveCandidate(record: OptimizationCandidate): Promise<OptimizationCandidate> {
    const normalized = OptimizationCandidateSchema.parse(record);
    const roomId = await this.roomForSkill(normalized.skill_id);
    await this.upsertRecord("workspace_skill_optimization_candidates", normalized.id, {
      columns: ["run_id", "skill_id", "room_id", "content_hash", "body", "status", "record", "created_at", "updated_at"],
      values: [normalized.run_id, normalized.skill_id, roomId, normalized.content_hash, normalized.body, normalized.status, jsonText(normalized), normalized.created_at, normalized.updated_at],
      updates: ["run_id = EXCLUDED.run_id", "skill_id = EXCLUDED.skill_id", "room_id = EXCLUDED.room_id", "content_hash = EXCLUDED.content_hash", "body = EXCLUDED.body", "status = EXCLUDED.status", "record = EXCLUDED.record", "updated_at = EXCLUDED.updated_at"]
    });
    return normalized;
  }

  async saveEvaluation(record: OptimizationEvaluation): Promise<OptimizationEvaluation> {
    const normalized = OptimizationEvaluationSchema.parse(record);
    const roomId = await this.roomForRun(normalized.run_id);
    await this.upsertRecord("workspace_skill_optimization_evaluations", normalized.id, {
      columns: ["run_id", "candidate_id", "room_id", "record", "created_at"],
      values: [normalized.run_id, normalized.candidate_id, roomId, jsonText(normalized), normalized.created_at],
      updates: ["run_id = EXCLUDED.run_id", "candidate_id = EXCLUDED.candidate_id", "room_id = EXCLUDED.room_id", "record = EXCLUDED.record"]
    });
    return normalized;
  }

  async getSnapshot(id: string): Promise<SkillOptimizationSnapshot | undefined> {
    return this.getRecord("workspace_skill_optimization_snapshots", id, SkillOptimizationSnapshotSchema, "skill_optimization_snapshot_record_invalid");
  }

  async saveSnapshot(record: SkillOptimizationSnapshot): Promise<SkillOptimizationSnapshot> {
    const normalized = SkillOptimizationSnapshotSchema.parse(record);
    const roomId = await this.roomForSkill(normalized.skill_id);
    await this.upsertRecord("workspace_skill_optimization_snapshots", normalized.id, {
      columns: ["run_id", "candidate_id", "skill_id", "room_id", "content_hash", "markdown", "record", "created_at"],
      values: [normalized.run_id, normalized.candidate_id, normalized.skill_id, roomId, normalized.content_hash, normalized.markdown, jsonText(normalized), normalized.created_at],
      updates: ["run_id = EXCLUDED.run_id", "candidate_id = EXCLUDED.candidate_id", "skill_id = EXCLUDED.skill_id", "room_id = EXCLUDED.room_id", "content_hash = EXCLUDED.content_hash", "markdown = EXCLUDED.markdown", "record = EXCLUDED.record"]
    });
    return normalized;
  }

  async listPromotions(): Promise<OptimizationPromotion[]> {
    return this.withSql(async (sql) => {
      const result = await sql.query<StoredRow>(
        `SELECT workspace_id, id, run_id, candidate_id, skill_id, room_id, status, record, created_at
         FROM workspace_skill_optimization_promotions
         WHERE workspace_id = $1
         ORDER BY created_at DESC, id DESC`,
        [this.workspaceId]
      );
      return result.rows.map((row) => parseRecord(row.record, OptimizationPromotionSchema, "skill_optimization_promotion_record_invalid"));
    });
  }

  async savePromotion(record: OptimizationPromotion): Promise<OptimizationPromotion> {
    const normalized = OptimizationPromotionSchema.parse(record);
    const roomId = await this.roomForSkill(normalized.skill_id);
    await this.upsertRecord("workspace_skill_optimization_promotions", normalized.id, {
      columns: ["run_id", "candidate_id", "skill_id", "room_id", "status", "record", "created_at"],
      values: [normalized.run_id, normalized.candidate_id, normalized.skill_id, roomId, normalized.status, jsonText(normalized), normalized.created_at],
      updates: ["run_id = EXCLUDED.run_id", "candidate_id = EXCLUDED.candidate_id", "skill_id = EXCLUDED.skill_id", "room_id = EXCLUDED.room_id", "status = EXCLUDED.status", "record = EXCLUDED.record"]
    });
    return normalized;
  }

  async replaceContentIfUnchanged(input: { id: string; expectedContentHash: string; content: string; lockRunId?: string }): Promise<TSkill | undefined> {
    assertId(input.id, "skill_id_invalid");
    if (!input.expectedContentHash.trim() || !input.content.trim()) throw new WorkspaceServerError("skill_optimization_content_invalid", 400);
    const lock = await this.getLock(input.id);
    if (lock && lock.run_id !== input.lockRunId) throw this.requestError("conflict", "skill_locked_for_optimization");
    const document = await this.readSkillDocument(input.id);
    if (!document) return undefined;
    if (stableHash(document.content) !== input.expectedContentHash) throw this.requestError("conflict", "skill_content_conflict");
    assertNoSecretKeys(document.version.metadata);
    const supportFiles = await this.completion.listSkillFiles(this.readContext("skill_optimization.read_files"), input.id, document.version.version, 100);
    const support = await Promise.all(supportFiles.map(async (file) => ({
      path: file.relativePath,
      content: await this.completion.getSkillFile(this.readContext(`skill_optimization.read_file:${file.id}`), input.id, file.relativePath, document.version.version).then((value) => value.content)
    })));
    const metadata = {
      ...document.version.metadata,
      content_hash: stableHash(input.content),
      last_reviewed_at: new Date().toISOString(),
      version: String(document.resource.version + 1)
    };
    const saved = await this.completion.updateResource(this.writeContext(`skill_optimization.promote:${input.id}:${input.expectedContentHash}`), input.id, {
      scope: document.resource.scope,
      kind: "skill",
      title: document.resource.title,
      content: input.content,
      metadata,
      expectedVersion: document.resource.version,
      reason: "skill_optimization.promote",
      supportFiles: support
    });
    return this.skillFromResource(saved);
  }

  async savePresentations(input: { sessionId: string; run: SkillOptimizationRun; candidates: OptimizationCandidate[] }): Promise<void> {
    if (!this.presentationsHandler) throw new WorkspaceServerError("skill_optimization_presentations_not_configured", 503);
    await this.presentationsHandler(input);
  }

  async hostComplete(input: { sessionId?: string; messages: Array<{ role: string; content: string }> }): Promise<{ content: string }> {
    if (!this.hostCompleteHandler) throw this.requestError("provider_not_configured", "skill_optimization_host_provider_not_configured");
    const result = await this.hostCompleteHandler(input);
    if (!result.content.trim()) throw new WorkspaceServerError("skill_optimization_host_empty_response", 503);
    return result;
  }

  requestError(code: "not_found" | "conflict" | "provider_not_configured", message: string): Error {
    return new WorkspaceServerError(message, code === "not_found" ? 404 : code === "conflict" ? 409 : 503);
  }

  errorMessage(error: unknown, fallback = "skill_optimization_error"): string {
    if (error instanceof WorkspaceServerError) return error.code;
    if (error instanceof Error && error.message.trim()) return error.message.slice(0, 500);
    return fallback;
  }

  private async readSkillDocument(id: string): Promise<SkillDocument | undefined> {
    assertId(id, "skill_id_invalid");
    try {
      const body = await this.completion.getResourceBody(this.readContext("skill_optimization.read_skill"), id);
      if (body.resource.kind !== "skill") return undefined;
      return { resource: body.resource, version: body.version, content: body.content, frontmatter: skillFrontmatter(body.resource, body.version, body.content) };
    } catch (error) {
      if (error instanceof WorkspaceServerError && error.status === 404) return undefined;
      throw error;
    }
  }

  private async skillFromResource(saved: WorkspaceCompletionResourceWriteResult): Promise<TSkill> {
    const skill = await this.getSkill(saved.resource.id);
    if (!skill) throw new WorkspaceServerError("skill_optimization_skill_missing_after_update", 503);
    return skill;
  }

  private async roomForSkill(skillId: string): Promise<string | null> {
    const resource = await this.completion.getResource(this.readContext("skill_optimization.resolve_room"), skillId);
    if (resource.resource.kind !== "skill") throw new WorkspaceServerError("skill_optimization_skill_required", 409);
    return resource.resource.scope.kind === "room" ? resource.resource.scope.roomId ?? null : null;
  }

  private async roomForSession(sessionId?: string): Promise<string | null> {
    if (!sessionId) return this.defaultRoomId ?? null;
    const session = await this.withSql(async (sql) => {
      const result = await sql.query<{ room_id: string | null }>(
        "SELECT room_id FROM workspace_runtime_sessions WHERE workspace_id = $1 AND id = $2",
        [this.workspaceId, sessionId]
      );
      return result.rows[0]?.room_id ?? null;
    });
    return session ?? this.defaultRoomId ?? null;
  }

  private async roomForObjective(objectiveId: string): Promise<string | null> {
    const room = await this.withSql(async (sql) => {
      const result = await sql.query<{ room_id: string | null }>(
        "SELECT room_id FROM workspace_skill_optimization_objectives WHERE workspace_id = $1 AND id = $2",
        [this.workspaceId, objectiveId]
      );
      return result.rows[0]?.room_id ?? null;
    });
    return room ?? this.defaultRoomId ?? null;
  }

  private async roomForRun(runId: string): Promise<string | null> {
    const room = await this.withSql(async (sql) => {
      const result = await sql.query<{ room_id: string | null }>(
        "SELECT room_id FROM workspace_skill_optimization_runs WHERE workspace_id = $1 AND id = $2",
        [this.workspaceId, runId]
      );
      return result.rows[0] ? result.rows[0].room_id : undefined;
    });
    if (room === undefined) throw new WorkspaceServerError("skill_optimization_run_not_found", 404);
    return room;
  }

  private async transitionWorkItem(workItemId: string, workerId: string, roomId: string, status: "completed" | "failed" | "cancelled", failureKind?: "cancelled" | "non_retryable", error?: string): Promise<WorkItemRecord | undefined> {
    assertId(workItemId, "skill_optimization_work_item_id_invalid");
    assertId(workerId, "skill_optimization_worker_id_invalid");
    const now = new Date().toISOString();
    return this.withSql(async (sql) => {
      const result = await sql.query<WorkItemRow>(
        `SELECT workspace_id, id, objective_id, status, worker_id, lease_until, attempt, record, created_at, updated_at
         FROM workspace_skill_optimization_work_items
         WHERE workspace_id = $1 AND id = $2 AND room_id = $3 AND status = 'running' AND worker_id = $4
           AND lease_until IS NOT NULL AND lease_until > $5
         FOR UPDATE`,
        [this.workspaceId, workItemId, roomId, workerId, now]
      );
      const row = result.rows[0];
      if (!row) return undefined;
      const current = parseRecord(row.record, WorkItemRecordSchema, "skill_optimization_work_item_record_invalid");
      const next = WorkItemRecordSchema.parse({
        ...current,
        status,
        lease_owner: undefined,
        lease_expires_at: undefined,
        heartbeat_at: undefined,
        retry_after_at: undefined,
        failure_kind: failureKind,
        error,
        completed_at: now,
        updated_at: now
      });
      await sql.query(
        `UPDATE workspace_skill_optimization_work_items
         SET status = $3, worker_id = NULL, lease_until = NULL, record = $4::JSONB, updated_at = $5
         WHERE workspace_id = $1 AND id = $2 AND room_id = $7 AND status = 'running' AND worker_id = $6
           AND lease_until IS NOT NULL AND lease_until > $5`,
        [this.workspaceId, workItemId, status, jsonText(next), now, workerId, roomId]
      );
      return next;
    });
  }

  private async getRecord<T>(table: string, id: string, schema: { parse(value: unknown): T }, errorCode: string, roomId?: string): Promise<T | undefined> {
    assertId(id, "skill_optimization_record_id_invalid");
    return this.withSql(async (sql) => {
      const roomClause = roomId === undefined ? "" : " AND room_id = $3";
      const result = await sql.query<StoredRow>(
        `SELECT workspace_id, id, record FROM ${table} WHERE workspace_id = $1 AND id = $2${roomClause}`,
        roomId === undefined ? [this.workspaceId, id] : [this.workspaceId, id, roomId]
      );
      const row = result.rows[0];
      return row ? parseRecord(row.record, schema, errorCode) : undefined;
    });
  }

  private async upsertRecord(table: string, id: string, input: { columns: string[]; values: unknown[]; updates: string[] }): Promise<void> {
    const placeholders = input.values.map((_, index) => `$${index + 3}`).join(", ");
    await this.withSql(async (sql) => {
      await sql.query(
        `INSERT INTO ${table}(workspace_id, id, ${input.columns.join(", ")})
         VALUES ($1, $2, ${placeholders})
         ON CONFLICT (workspace_id, id) DO UPDATE SET ${input.updates.join(", ")}
         WHERE ${table}.workspace_id = $1 AND ${table}.id = $2`,
        [this.workspaceId, id, ...input.values]
      );
    });
  }

  private async updateStoredRecord(table: string, id: string, input: { columns: string[]; values: unknown[] }): Promise<void> {
    const assignments = input.columns.map((column, index) => `${column} = $${index + 3}`).join(", ");
    await this.withSql(async (sql) => {
      const result = await sql.query(
        `UPDATE ${table} SET ${assignments} WHERE workspace_id = $1 AND id = $2`,
        [this.workspaceId, id, ...input.values]
      );
      if (Number(result.rowCount ?? 0) === 0) throw new WorkspaceServerError(`${table}_not_found`, 404);
    });
  }

  private async listRecords<T>(table: string, column: string, value: string, schema: { parse(value: unknown): T }, errorCode: string): Promise<T[]> {
    const allowedTables = new Set([
      "workspace_skill_optimization_candidates",
      "workspace_skill_optimization_evaluations",
      "workspace_skill_optimization_promotions",
      "workspace_skill_optimization_snapshots"
    ]);
    const allowedColumns = new Set(["run_id", "candidate_id"]);
    if (!allowedTables.has(table) || !allowedColumns.has(column)) throw new WorkspaceServerError("skill_optimization_query_invalid", 500);
    return this.withSql(async (sql) => {
      const result = await sql.query<StoredRow>(
        `SELECT record FROM ${table} WHERE workspace_id = $1 AND ${column} = $2 ORDER BY created_at ASC, id ASC`,
        [this.workspaceId, value]
      );
      return result.rows.map((row) => parseRecord(row.record, schema, errorCode));
    });
  }

  private withSql<T>(action: (sql: WorkspaceSql) => Promise<T>): Promise<T> {
    return this.database.withContext(this.readContext("skill_optimization.db"), action);
  }

  private readContext(operationId: string): Pick<WorkspaceRequestContext, "workspaceId" | "accountId"> & { operationId: string } {
    return { workspaceId: this.workspaceId, accountId: this.accountId, operationId };
  }

  private writeContext(operationId: string): WorkspaceRequestContext {
    return { workspaceId: this.workspaceId, accountId: this.accountId, operationId };
  }
}

interface SkillDocument {
  resource: WorkspaceCompletionResource;
  version: WorkspaceCompletionResourceVersion;
  content: string;
  frontmatter: SkillFrontmatter;
}

interface CompletionUseRow {
  id: string;
  resource_id: string;
  resource_version: number | string;
  event: string;
  summary: string;
  content_hash: string;
  scope_kind: "workspace" | "room";
  room_id: string | null;
  operation_id: string | null;
  activity_id: string | null;
  episode_id: string | null;
  session_ref: unknown;
  created_at: string | Date;
}

interface RuntimeRunRow {
  id: string;
  workspace_id: string;
  session_id: string | null;
  room_id: string | null;
  principal: unknown;
  source: unknown;
  session_ref: unknown;
  agent_id: string | null;
  requested_by_participant_id: string | null;
  input_message_id: string | null;
  output_message_id: string | null;
  backend_id: string;
  backend_kind: string;
  backend_session_id: string | null;
  status: string;
  phase: string | null;
  current_attempt: number | string | null;
  request_idempotency_key: string | null;
  request_hash: string | null;
  started_at: string | Date;
  completed_at: string | Date | null;
  input_summary: string;
  output_summary: string | null;
  error_code: string | null;
  metadata: unknown;
}

interface SessionRow { id: string; workspace_id: string; room_id: string | null; ui_locale: string; output_locale: string; }
interface WorkItemRow extends StoredRow { id: string; objective_id: string; created_at: string | Date; updated_at: string | Date; }

function skillFrontmatter(resource: WorkspaceCompletionResource, version: WorkspaceCompletionResourceVersion, content: string): SkillFrontmatter {
  const metadata = jsonObject(version.metadata);
  const state = SkillStateSchema.safeParse(metadata.state).success
    ? metadata.state as SkillFrontmatter["state"]
    : resource.lifecycleState === "archived" ? "archived" : resource.aiProtection === "fixed" ? "pinned" : "project";
  return SkillFrontmatterSchema.parse({
    ...metadata,
    id: resource.id,
    state,
    title: resource.title,
    description: typeof metadata.description === "string" ? metadata.description : resource.title,
    tags: stringArray(metadata.tags),
    provenance: typeof metadata.provenance === "string" ? metadata.provenance : "workspace_completion",
    trust_level: trustLevel(metadata.trust_level),
    allowed_scopes: stringArray(metadata.allowed_scopes).length ? stringArray(metadata.allowed_scopes) : ["skill"],
    required_capabilities: stringArray(metadata.required_capabilities),
    schedule_policy: jsonObject(metadata.schedule_policy),
    secret_policy: jsonObject(metadata.secret_policy),
    owner_pinned: metadata.owner_pinned === true || resource.aiProtection === "fixed",
    version: String(resource.version),
    content_hash: stableHash(content),
    file_path: undefined,
    created_at: typeof metadata.created_at === "string" ? metadata.created_at : resource.createdAt,
    updated_at: typeof metadata.updated_at === "string" ? metadata.updated_at : resource.updatedAt
  });
}

function renderSkillMarkdown(frontmatter: SkillFrontmatter, content: string): string {
  return `---\n${JSON.stringify(frontmatter, null, 2)}\n---\n\n${content.trim()}\n`;
}

function parseRecord<T>(record: unknown, schema: { parse(value: unknown): T }, errorCode: string): T {
  try {
    const value = typeof record === "string" ? JSON.parse(record) : record;
    return schema.parse(value);
  } catch (error) {
    if (error instanceof WorkspaceServerError) throw error;
    throw new WorkspaceServerError(errorCode, 503);
  }
}

function jsonText(value: unknown): string {
  assertNoSecretKeys(value);
  return JSON.stringify(value);
}

function assertNoSecretKeys(value: unknown, path = "record"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecretKeys(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (/^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|password|credential|authorization|bearer[_-]?token)$/i.test(key)) {
      throw new WorkspaceServerError("skill_optimization_secret_persistence_forbidden", 422, { path: `${path}.${key}` });
    }
    assertNoSecretKeys(child, `${path}.${key}`);
  }
}

function jsonValue(value: unknown): unknown {
  if (typeof value === "string") {
    try { return JSON.parse(value); } catch { return value; }
  }
  return value;
}

function jsonObject(value: unknown): Record<string, unknown> {
  const parsed = jsonValue(value);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}

function stringArray(value: unknown): string[] {
  const parsed = jsonValue(value);
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
}

function trustLevel(value: unknown): SkillFrontmatter["trust_level"] {
  return value === "generated_local" || value === "user_authored" || value === "bundled" || value === "imported" || value === "shared" ? value : "user_authored";
}

function sessionIdFromRef(value: unknown): string | undefined {
  const ref = jsonObject(value);
  return typeof ref.sessionId === "string" ? ref.sessionId : typeof ref.session_id === "string" ? ref.session_id : undefined;
}

function iso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function assertId(value: string, code: string): void {
  if (typeof value !== "string" || !value.trim()) throw new WorkspaceServerError(code, 400);
}

function assertIso(value: string, code: string): void {
  if (!Number.isFinite(Date.parse(value))) throw new WorkspaceServerError(code, 400);
}

function skillOptimizationLimit(value: number | undefined): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? Math.min(value, 500) : 100;
}
