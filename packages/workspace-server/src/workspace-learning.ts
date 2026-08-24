import { createHash } from "node:crypto";
import { canonicalJson } from "./auth";
import { assertOpaqueId } from "./config";
import { WorkspaceServerError } from "./errors";
import type { WorkspaceSql } from "./postgres";
import {
  assertSafeLearningPayload,
  assertSafeLearningText,
  classifyLearningActivity,
  isRetryableLearningError,
  learningContentHash,
  learningRetryDelayMs,
  rankKnowledgeForCurrentRoom,
  validateWorkspaceKnowledgeReviewResult,
  type WorkspaceKnowledgeReviewPort,
  type WorkspaceKnowledgeReviewResult,
  type WorkspaceKnowledgeReviewSnapshot
} from "./workspace-learning-policy";
import { WorkspaceServerStore } from "./workspace-server-store";
import type {
  WorkspaceLearningActivity,
  WorkspaceLearningActivityOutcome,
  WorkspaceLearningChangeKind,
  WorkspaceLearningEvidence,
  WorkspaceLearningFailureState,
  WorkspaceLearningJob,
  WorkspaceLearningJobAttempt,
  WorkspaceLearningResource,
  WorkspaceLearningResourceKind,
  WorkspaceLearningResourceLink,
  WorkspaceLearningResourceUse,
  WorkspaceLearningResourceState,
  WorkspaceLearningResourceVersion,
  WorkspaceLearningScope,
  WorkspaceLearningSettings,
  WorkspaceLearningVerificationState,
  WorkspaceRecordPayload,
  WorkspaceRequestContext
} from "./types";

const resourceKinds = new Set<WorkspaceLearningResourceKind>(["knowledge", "memory", "skill", "workspace_rule"]);
const activityOutcomes = new Set<WorkspaceLearningActivityOutcome>(["completed", "failed", "cancelled", "outcome_unknown"]);
const verificationStates = new Set<WorkspaceLearningVerificationState>(["confirmed", "failed", "not_run", "unknown"]);
const failureStates = new Set<WorkspaceLearningFailureState>(["none", "resolved", "unresolved"]);
const maxSnapshotActivities = 100;
const maxSnapshotRules = 80;
const maxSnapshotWorkspaceKnowledge = 80;
const maxSnapshotRoomKnowledge = 160;
const maxSnapshotBytes = 1_000_000;

export interface IngestWorkspaceLearningActivityInput {
  id?: string;
  /** Formal Room boundary. Session or source metadata must never infer this. */
  roomId: string;
  groupKey: string;
  sourceKind: string;
  sourceId?: string;
  correctionOfActivityId?: string;
  instructionSummary: string;
  resultSummary?: string;
  outcome: WorkspaceLearningActivityOutcome;
  verificationState: WorkspaceLearningVerificationState;
  failureState: WorkspaceLearningFailureState;
  explicitRemember?: boolean;
  finalizedResource?: boolean;
  reusableCompletion?: boolean;
  payload?: WorkspaceRecordPayload;
}

export interface WorkspaceLearningIngestResult {
  activity: WorkspaceLearningActivity;
  job?: WorkspaceLearningJob;
  eligible: boolean;
  reasons: readonly string[];
  replayed: boolean;
}

export interface PutWorkspaceLearningResourceInput {
  id?: string;
  scope: WorkspaceLearningScope;
  kind: WorkspaceLearningResourceKind;
  isAbsoluteRule?: boolean;
  title: string;
  content: string;
  payload?: WorkspaceRecordPayload;
  reason: string;
  expectedVersion?: number;
}

export interface UpdateWorkspaceLearningSettingsInput {
  scope: WorkspaceLearningScope;
  enabled?: boolean;
  engineId?: string;
  model?: string;
  /** Opaque operator secret reference only. Never accepts secret content. */
  secretRef?: string;
  currencyLimit?: number;
  tokenLimit?: number;
  clearEngineId?: boolean;
  clearModel?: boolean;
  clearSecretRef?: boolean;
  clearCurrencyLimit?: boolean;
  clearTokenLimit?: boolean;
  /** Deletes a Room-only override so the Room inherits Workspace settings. */
  removeOverride?: boolean;
  expectedVersion?: number;
}

export interface ClaimWorkspaceLearningJobInput {
  workerId: string;
  roomId?: string;
  leaseMs?: number;
  /** The caller's cassette must exactly match the selected effective config. */
  engineId?: string;
  model?: string;
  reservation?: { currency?: number; tokens?: number };
}

export interface ClaimedWorkspaceLearningJob {
  job: WorkspaceLearningJob;
  /** A configuration/budget block is recorded on the Job before an Engine
   * invocation, so it deliberately has no consumable attempt. */
  attempt?: WorkspaceLearningJobAttempt;
  snapshot: WorkspaceKnowledgeReviewSnapshot;
  settings: WorkspaceLearningSettings;
}

export interface WorkspaceLearningSettingsLayers {
  workspace?: WorkspaceLearningSettings;
  room?: WorkspaceLearningSettings;
  effective: WorkspaceLearningSettings;
}

export interface ApplyWorkspaceLearningReviewInput {
  jobId: string;
  attemptId: string;
  workerId: string;
  result: WorkspaceKnowledgeReviewResult;
}

export interface RecordWorkspaceLearningResourceUseInput {
  id?: string;
  resourceId: string;
  resourceVersion: number;
  activityId: string;
  outcome: WorkspaceLearningResourceUse["outcome"];
  summary: string;
}

/**
 * The only PostgreSQL write path for the productized learning loop.  The
 * generic Workspace record APIs deliberately do not know these tables.
 */
export class WorkspaceLearningService {
  constructor(readonly store: WorkspaceServerStore) {}

  async ingestActivity(context: WorkspaceRequestContext, input: IngestWorkspaceLearningActivityInput): Promise<WorkspaceLearningIngestResult> {
    validateActivityInput(input);
    const activityId = input.id ?? scopedId("learning_activity", context.workspaceId, context.operationId);
    assertOpaqueId(activityId, "workspace_learning_activity_id_invalid");
    const outcome = input.outcome;
    const verificationState = input.verificationState;
    const failureState = input.failureState;
    const eligibility = classifyLearningActivity({
      outcome,
      verificationState,
      failureState,
      correctionOfActivityId: input.correctionOfActivityId,
      explicitRemember: input.explicitRemember === true,
      finalizedResource: input.finalizedResource,
      reusableCompletion: input.reusableCompletion
    });
    const idempotent = await this.store.runIdempotentResult(context, {
      action: "workspace.learning.activity.ingest",
      input: { ...input, id: activityId }
    }, async (sql) => {
      await assertWorkspaceWritable(sql, context.workspaceId);
      if (input.correctionOfActivityId) {
        const correction = await sql.query<Pick<ActivityRow, "room_id">>(
          "SELECT room_id FROM workspace_learning_activities WHERE workspace_id = $1 AND id = $2",
          [context.workspaceId, input.correctionOfActivityId]
        );
        if (!correction.rows[0]) throw new WorkspaceServerError("workspace_learning_correction_activity_not_found", 404);
        if (correction.rows[0].room_id !== input.roomId) throw new WorkspaceServerError("workspace_learning_correction_cross_room_denied", 403);
      }
      const saved = await sql.query<ActivityRow>(
        `INSERT INTO workspace_learning_activities(
           workspace_id, room_id, id, group_key, principal_account_id, source_kind, source_id,
           correction_of_activity_id, instruction_summary, result_summary, outcome, verification_state,
           failure_state, explicit_remember, payload
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::JSONB)
         RETURNING *`,
        [
          context.workspaceId,
          input.roomId,
          activityId,
          input.groupKey,
          context.accountId,
          input.sourceKind,
          input.sourceId ?? null,
          input.correctionOfActivityId ?? null,
          input.instructionSummary.trim(),
          input.resultSummary?.trim() || null,
          outcome,
          verificationState,
          failureState,
          input.explicitRemember === true,
          canonicalJson(activityPayload(input))
        ]
      );
      const activity = activityFromRow(saved.rows[0]!);
      let job: WorkspaceLearningJob | undefined;
      if (eligibility.eligible) {
        job = await this.enqueueLearningReview(sql, context, {
          roomId: activity.roomId,
          activity,
          priority: eligibility.priority
        });
      }
      await this.store.insertAudit(sql, context, {
        action: "workspace.learning.activity.ingest",
        roomId: activity.roomId,
        subjectKind: "learning_activity",
        subjectId: activity.id,
        afterVersion: 1,
        details: { eligible: eligibility.eligible, reasons: [...eligibility.reasons], ...(job ? { job_id: job.id } : {}) }
      });
      return { activity, ...(job ? { job } : {}), eligible: eligibility.eligible, reasons: eligibility.reasons };
    });
    return { ...idempotent.value, replayed: idempotent.replayed };
  }

  async listActivities(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, input: { roomId: string; groupKey?: string; limit?: number }): Promise<WorkspaceLearningActivity[]> {
    assertOpaqueId(input.roomId, "room_id_invalid");
    if (input.groupKey !== undefined) assertOpaqueId(input.groupKey, "workspace_learning_group_key_invalid");
    const limit = boundedLimit(input.limit);
    return this.store.database.withContext(context, async (sql) => {
      const result = await sql.query<ActivityRow>(
        `SELECT * FROM workspace_learning_activities
         WHERE workspace_id = $1 AND room_id = $2 AND ($3::TEXT IS NULL OR group_key = $3)
         ORDER BY finalized_at DESC, id DESC LIMIT $4`,
        [context.workspaceId, input.roomId, input.groupKey ?? null, limit]
      );
      return result.rows.map(activityFromRow);
    });
  }

  async getResource(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, resourceId: string): Promise<WorkspaceLearningResource> {
    assertOpaqueId(resourceId, "workspace_learning_resource_id_invalid");
    return this.store.database.withContext(context, async (sql) => {
      const result = await sql.query<ResourceRow>("SELECT * FROM workspace_learning_resources WHERE workspace_id = $1 AND id = $2", [context.workspaceId, resourceId]);
      const row = result.rows[0];
      if (!row) throw new WorkspaceServerError("workspace_learning_resource_not_found", 404);
      return resourceFromRow(row);
    });
  }

  async listResources(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, input: {
    scope: WorkspaceLearningScope;
    kind?: WorkspaceLearningResourceKind;
    includeArchived?: boolean;
    limit?: number;
  }): Promise<WorkspaceLearningResource[]> {
    assertScope(input.scope);
    if (input.kind && !resourceKinds.has(input.kind)) throw new WorkspaceServerError("workspace_learning_resource_kind_invalid", 400);
    const limit = boundedLimit(input.limit);
    return this.store.database.withContext(context, async (sql) => {
      const result = await sql.query<ResourceRow>(
        `SELECT * FROM workspace_learning_resources
         WHERE workspace_id = $1 AND scope_kind = $2 AND room_id IS NOT DISTINCT FROM $3
           AND ($4::TEXT IS NULL OR resource_kind = $4)
           AND ($5::BOOLEAN OR state <> 'archived')
         ORDER BY is_absolute_rule DESC, updated_at DESC, id ASC LIMIT $6`,
        [context.workspaceId, input.scope.kind, input.scope.roomId ?? null, input.kind ?? null, input.includeArchived === true, limit]
      );
      return result.rows.map(resourceFromRow);
    });
  }

  async listResourceVersions(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, resourceId: string): Promise<WorkspaceLearningResourceVersion[]> {
    assertOpaqueId(resourceId, "workspace_learning_resource_id_invalid");
    return this.store.database.withContext(context, async (sql) => {
      const result = await sql.query<ResourceVersionRow>(
        "SELECT * FROM workspace_learning_resource_versions WHERE workspace_id = $1 AND resource_id = $2 ORDER BY version DESC",
        [context.workspaceId, resourceId]
      );
      return result.rows.map(versionFromRow);
    });
  }

  async listEvidence(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, resourceId: string): Promise<WorkspaceLearningEvidence[]> {
    assertOpaqueId(resourceId, "workspace_learning_resource_id_invalid");
    return this.store.database.withContext(context, async (sql) => {
      const result = await sql.query<EvidenceRow>(
        "SELECT * FROM workspace_learning_evidence WHERE workspace_id = $1 AND resource_id = $2 ORDER BY created_at DESC, id DESC",
        [context.workspaceId, resourceId]
      );
      return result.rows.map(evidenceFromRow);
    });
  }

  async recordResourceUse(context: WorkspaceRequestContext, input: RecordWorkspaceLearningResourceUseInput): Promise<{ use: WorkspaceLearningResourceUse; roomId: string; job?: WorkspaceLearningJob; replayed: boolean }> {
    assertOpaqueId(input.resourceId, "workspace_learning_resource_id_invalid");
    assertOpaqueId(input.activityId, "workspace_learning_activity_id_invalid");
    if (!Number.isSafeInteger(input.resourceVersion) || input.resourceVersion < 1) throw new WorkspaceServerError("workspace_learning_resource_version_invalid", 400);
    if (!["confirmed_success", "confirmed_failure", "unknown"].includes(input.outcome)) throw new WorkspaceServerError("workspace_learning_resource_use_outcome_invalid", 400);
    assertSafeLearningText(input.summary);
    const useId = input.id ?? scopedId("learning_resource_use", context.workspaceId, `${input.resourceId}:${input.resourceVersion}:${input.activityId}:${input.outcome}`);
    assertOpaqueId(useId, "workspace_learning_resource_use_id_invalid");
    const saved = await this.store.runIdempotentResult(context, {
      action: "workspace.learning.resource.use.record",
      input: { ...input, id: useId }
    }, async (sql) => {
      await assertWorkspaceWritable(sql, context.workspaceId);
      // Queries on one transaction client must stay ordered. PostgreSQL's
      // client does not permit concurrent query dispatch on that connection.
      const resourceResult = await sql.query<ResourceRow>("SELECT * FROM workspace_learning_resources WHERE workspace_id = $1 AND id = $2", [context.workspaceId, input.resourceId]);
      const activityResult = await sql.query<ActivityRow>("SELECT * FROM workspace_learning_activities WHERE workspace_id = $1 AND id = $2", [context.workspaceId, input.activityId]);
      const versionResult = await sql.query<{ id: string }>("SELECT id FROM workspace_learning_resource_versions WHERE workspace_id = $1 AND resource_id = $2 AND version = $3", [context.workspaceId, input.resourceId, input.resourceVersion]);
      const resourceRow = resourceResult.rows[0];
      const activityRow = activityResult.rows[0];
      if (!resourceRow || !activityRow || !versionResult.rows[0]) throw new WorkspaceServerError("workspace_learning_resource_use_target_not_found", 404);
      const resource = resourceFromRow(resourceRow);
      const activity = activityFromRow(activityRow);
      if (resource.scope.kind === "room" && resource.scope.roomId !== activity.roomId) {
        throw new WorkspaceServerError("workspace_learning_resource_use_cross_room_denied", 403);
      }
      // Resource uses are append-only, so SELECT ... FOR UPDATE is neither
      // permitted by the RLS policy nor appropriate. Serialize this one use
      // key without granting UPDATE access to immutable history.
      await sql.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `workspace_learning_resource_use:${context.workspaceId}:${resource.id}:${input.resourceVersion}:${activity.id}`
      ]);
      const prior = await sql.query<ResourceUseRow>(
        `SELECT * FROM workspace_learning_resource_uses
         WHERE workspace_id = $1 AND resource_id = $2 AND resource_version = $3 AND activity_id = $4
         ORDER BY created_at, id`,
        [context.workspaceId, resource.id, input.resourceVersion, activity.id]
      );
      const priorUses = prior.rows.map(resourceUseFromRow);
      const confirmed = priorUses.find((use) => use.outcome !== "unknown");
      if (confirmed) throw new WorkspaceServerError("workspace_learning_resource_use_already_recorded", 409);
      const unknown = priorUses.find((use) => use.outcome === "unknown");
      if (unknown && input.outcome === "unknown") throw new WorkspaceServerError("workspace_learning_resource_use_already_recorded", 409);
      const inserted = await sql.query<ResourceUseRow>(
        `INSERT INTO workspace_learning_resource_uses(
           workspace_id, id, resource_id, resource_version, activity_id, outcome, supersedes_use_id, summary
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [context.workspaceId, useId, resource.id, input.resourceVersion, activity.id, input.outcome, unknown?.id ?? null, input.summary.trim()]
      );
      const resourceUse = resourceUseFromRow(inserted.rows[0]!);
      const feedbackEligibility = classifyLearningActivity({
        outcome: activity.outcome,
        verificationState: activity.verificationState,
        failureState: activity.failureState,
        correctionOfActivityId: activity.correctionOfActivityId,
        explicitRemember: activity.explicitRemember,
        finalizedResource: payloadBoolean(activity.payload, "finalized_resource"),
        reusableCompletion: payloadBoolean(activity.payload, "reusable_completion"),
        learningUseOutcomeKnown: resourceUse.outcome !== "unknown"
      });
      let job: WorkspaceLearningJob | undefined;
      if (feedbackEligibility.eligible) {
        job = await this.enqueueLearningReview(sql, context, {
          roomId: activity.roomId,
          activity,
          priority: feedbackEligibility.priority
        });
      }
      await this.store.insertAudit(sql, context, {
        action: "workspace.learning.resource.use.record",
        roomId: activity.roomId,
        subjectKind: "learning_resource",
        subjectId: resource.id,
        afterVersion: resourceUse.resourceVersion,
        details: { activity_id: activity.id, outcome: resourceUse.outcome, ...(job ? { job_id: job.id } : {}) }
      });
      return { use: resourceUse, roomId: activity.roomId, ...(job ? { job } : {}) };
    });
    return { ...saved.value, replayed: saved.replayed };
  }

  async putResource(context: WorkspaceRequestContext, input: PutWorkspaceLearningResourceInput): Promise<{ resource: WorkspaceLearningResource; replayed: boolean }> {
    assertScope(input.scope);
    if (!resourceKinds.has(input.kind)) throw new WorkspaceServerError("workspace_learning_resource_kind_invalid", 400);
    assertSafeLearningText(input.title);
    assertSafeLearningText(input.content);
    assertSafeLearningText(input.reason);
    assertSafeLearningPayload(input.payload);
    const resourceId = input.id ?? scopedId("learning_resource", context.workspaceId, context.operationId);
    assertOpaqueId(resourceId, "workspace_learning_resource_id_invalid");
    const isAbsoluteRule = input.isAbsoluteRule === true;
    if ((input.kind === "workspace_rule") !== isAbsoluteRule || (isAbsoluteRule && input.scope.kind !== "workspace")) {
      throw new WorkspaceServerError("workspace_learning_resource_scope_invalid", 400);
    }
    const expectedVersion = input.expectedVersion ?? 0;
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) throw new WorkspaceServerError("workspace_learning_resource_expected_version_invalid", 400);
    const result = await this.store.runIdempotentResult(context, {
      action: "workspace.learning.resource.put",
      input: { ...input, id: resourceId }
    }, async (sql) => {
      await assertWorkspaceWritable(sql, context.workspaceId);
      const existing = await selectResourceForUpdate(sql, context.workspaceId, resourceId);
      if (!existing) {
        if (expectedVersion !== 0) throw new WorkspaceServerError("workspace_learning_resource_version_conflict", 409, { latest_version: null });
        const created = await insertResource(sql, context, {
          id: resourceId,
          scope: input.scope,
          kind: input.kind,
          isAbsoluteRule,
          title: input.title.trim(),
          content: input.content.trim(),
          payload: input.payload ?? {},
          state: "active",
          aiUpdateLocked: false,
          reason: input.reason.trim(),
          changeKind: "created"
        });
        await insertHumanEditEvidence(sql, context.workspaceId, created, input.reason.trim());
        await this.store.insertAudit(sql, context, {
          action: "workspace.learning.resource.create",
          ...(created.scope.roomId ? { roomId: created.scope.roomId } : {}),
          subjectKind: "learning_resource",
          subjectId: created.id,
          afterVersion: created.version,
          details: { scope_kind: created.scope.kind, resource_kind: created.kind }
        });
        return created;
      }
      const current = resourceFromRow(existing);
      if (current.version !== expectedVersion) throw new WorkspaceServerError("workspace_learning_resource_version_conflict", 409, { latest_version: current.version });
      if (current.scope.kind !== input.scope.kind || current.scope.roomId !== input.scope.roomId || current.kind !== input.kind || current.isAbsoluteRule !== isAbsoluteRule) {
        throw new WorkspaceServerError("workspace_learning_resource_identity_change_forbidden", 409);
      }
      const updated = await updateResource(sql, context, current, {
        title: input.title.trim(),
        content: input.content.trim(),
        payload: input.payload ?? {},
        ...(isAutomaticCandidateState(current.state) ? { state: "active" as const, confidence: 1 } : {}),
        reason: input.reason.trim(),
        changeKind: "updated"
      });
      await insertHumanEditEvidence(sql, context.workspaceId, updated, input.reason.trim());
      await this.store.insertAudit(sql, context, {
        action: "workspace.learning.resource.update",
        ...(updated.scope.roomId ? { roomId: updated.scope.roomId } : {}),
        subjectKind: "learning_resource",
        subjectId: updated.id,
        beforeVersion: current.version,
        afterVersion: updated.version,
        details: { scope_kind: updated.scope.kind, resource_kind: updated.kind }
      });
      return updated;
    });
    return { resource: result.value, replayed: result.replayed };
  }

  async setResourceFixed(context: WorkspaceRequestContext, input: { resourceId: string; fixed: boolean; expectedVersion: number; reason: string }): Promise<{ resource: WorkspaceLearningResource; replayed: boolean }> {
    assertOpaqueId(input.resourceId, "workspace_learning_resource_id_invalid");
    assertSafeLearningText(input.reason);
    assertExpectedVersion(input.expectedVersion);
    const result = await this.store.runIdempotentResult(context, {
      action: "workspace.learning.resource.fixed",
      input
    }, async (sql) => {
      await assertWorkspaceWritable(sql, context.workspaceId);
      const row = await selectResourceForUpdate(sql, context.workspaceId, input.resourceId);
      if (!row) throw new WorkspaceServerError("workspace_learning_resource_not_found", 404);
      const current = resourceFromRow(row);
      if (current.version !== input.expectedVersion) throw new WorkspaceServerError("workspace_learning_resource_version_conflict", 409, { latest_version: current.version });
      const updated = await updateResource(sql, context, current, {
        aiUpdateLocked: input.fixed,
        ...(isAutomaticCandidateState(current.state) ? { state: "active" as const, confidence: 1 } : {}),
        reason: input.reason.trim(),
        changeKind: input.fixed ? "fixed" : "unfixed"
      });
      await insertHumanEditEvidence(sql, context.workspaceId, updated, input.reason.trim());
      await this.store.insertAudit(sql, context, {
        action: input.fixed ? "workspace.learning.resource.fixed" : "workspace.learning.resource.unfixed",
        ...(updated.scope.roomId ? { roomId: updated.scope.roomId } : {}),
        subjectKind: "learning_resource",
        subjectId: updated.id,
        beforeVersion: current.version,
        afterVersion: updated.version,
        details: { ai_update_locked: input.fixed }
      });
      return updated;
    });
    return { resource: result.value, replayed: result.replayed };
  }

  async archiveResource(context: WorkspaceRequestContext, input: { resourceId: string; archived: boolean; expectedVersion: number; reason: string }): Promise<{ resource: WorkspaceLearningResource; replayed: boolean }> {
    assertOpaqueId(input.resourceId, "workspace_learning_resource_id_invalid");
    assertSafeLearningText(input.reason);
    assertExpectedVersion(input.expectedVersion);
    const result = await this.store.runIdempotentResult(context, {
      action: "workspace.learning.resource.archive",
      input
    }, async (sql) => {
      await assertWorkspaceWritable(sql, context.workspaceId);
      const row = await selectResourceForUpdate(sql, context.workspaceId, input.resourceId);
      if (!row) throw new WorkspaceServerError("workspace_learning_resource_not_found", 404);
      const current = resourceFromRow(row);
      if (current.version !== input.expectedVersion) throw new WorkspaceServerError("workspace_learning_resource_version_conflict", 409, { latest_version: current.version });
      const updated = await updateResource(sql, context, current, {
        state: input.archived ? "archived" : "active",
        ...(!input.archived && hasAutomaticProvenance(current) ? { confidence: 1 } : {}),
        archivedAt: input.archived ? new Date().toISOString() : null,
        reason: input.reason.trim(),
        changeKind: input.archived ? "archived" : "restored"
      });
      await insertHumanEditEvidence(sql, context.workspaceId, updated, input.reason.trim());
      await this.store.insertAudit(sql, context, {
        action: input.archived ? "workspace.learning.resource.archive" : "workspace.learning.resource.restore",
        ...(updated.scope.roomId ? { roomId: updated.scope.roomId } : {}),
        subjectKind: "learning_resource",
        subjectId: updated.id,
        beforeVersion: current.version,
        afterVersion: updated.version,
        details: { state: updated.state }
      });
      return updated;
    });
    return { resource: result.value, replayed: result.replayed };
  }

  async copyResource(context: WorkspaceRequestContext, input: { resourceId: string; targetScope: WorkspaceLearningScope; id?: string; expectedVersion: number; reason: string }): Promise<{ resource: WorkspaceLearningResource; replayed: boolean }> {
    assertOpaqueId(input.resourceId, "workspace_learning_resource_id_invalid");
    assertScope(input.targetScope);
    assertExpectedVersion(input.expectedVersion);
    assertSafeLearningText(input.reason);
    const targetId = input.id ?? scopedId("learning_resource_copy", context.workspaceId, context.operationId);
    assertOpaqueId(targetId, "workspace_learning_resource_id_invalid");
    const result = await this.store.runIdempotentResult(context, { action: "workspace.learning.resource.copy", input: { ...input, id: targetId } }, async (sql) => {
      await assertWorkspaceWritable(sql, context.workspaceId);
      const sourceRow = await selectResourceForUpdate(sql, context.workspaceId, input.resourceId);
      if (!sourceRow) throw new WorkspaceServerError("workspace_learning_resource_not_found", 404);
      const source = resourceFromRow(sourceRow);
      if (source.version !== input.expectedVersion) throw new WorkspaceServerError("workspace_learning_resource_version_conflict", 409, { latest_version: source.version });
      if (source.kind === "workspace_rule" && input.targetScope.kind !== "workspace") throw new WorkspaceServerError("workspace_learning_resource_scope_invalid", 400);
      const copied = await insertResource(sql, context, {
        id: targetId,
        scope: input.targetScope,
        kind: source.kind,
        isAbsoluteRule: source.isAbsoluteRule,
        title: source.title,
        content: source.content,
        payload: source.payload,
        state: isAutomaticCandidateState(source.state) ? "active" : source.state,
        aiUpdateLocked: false,
        ...(isAutomaticCandidateState(source.state) ? { confidence: 1 } : { confidence: source.confidence }),
        ...(source.sourceJobId ? { sourceJobId: source.sourceJobId } : {}),
        ...(source.sourceAttemptId ? { sourceAttemptId: source.sourceAttemptId } : {}),
        reason: input.reason.trim(),
        changeKind: "copied"
      });
      await insertHumanEditEvidence(sql, context.workspaceId, copied, input.reason.trim());
      await insertLink(sql, context.workspaceId, copied.id, source.id, "copied_from");
      await this.store.insertAudit(sql, context, {
        action: "workspace.learning.resource.copy",
        ...(copied.scope.roomId ? { roomId: copied.scope.roomId } : {}),
        subjectKind: "learning_resource",
        subjectId: copied.id,
        afterVersion: copied.version,
        details: { source_resource_id: source.id }
      });
      return copied;
    });
    return { resource: result.value, replayed: result.replayed };
  }

  async moveResource(context: WorkspaceRequestContext, input: { resourceId: string; targetRoomId: string; targetResourceId?: string; expectedVersion: number; reason: string }): Promise<{ resource: WorkspaceLearningResource; replayed: boolean }> {
    assertOpaqueId(input.resourceId, "workspace_learning_resource_id_invalid");
    assertOpaqueId(input.targetRoomId, "room_id_invalid");
    if (input.targetResourceId) assertOpaqueId(input.targetResourceId, "workspace_learning_resource_id_invalid");
    assertSafeLearningText(input.reason);
    assertExpectedVersion(input.expectedVersion);
    const targetResourceId = input.targetResourceId ?? scopedId("learning_resource_move", context.workspaceId, `${context.operationId}:${input.resourceId}:${input.targetRoomId}`);
    const result = await this.store.runIdempotentResult(context, { action: "workspace.learning.resource.move", input: { ...input, targetResourceId } }, async (sql) => {
      await assertWorkspaceWritable(sql, context.workspaceId);
      const sourceRow = await selectResourceForUpdate(sql, context.workspaceId, input.resourceId);
      if (!sourceRow) throw new WorkspaceServerError("workspace_learning_resource_not_found", 404);
      const source = resourceFromRow(sourceRow);
      if (source.scope.kind !== "room") throw new WorkspaceServerError("workspace_learning_resource_move_scope_invalid", 409);
      if (source.version !== input.expectedVersion) throw new WorkspaceServerError("workspace_learning_resource_version_conflict", 409, { latest_version: source.version });
      if (source.scope.roomId === input.targetRoomId) throw new WorkspaceServerError("workspace_learning_resource_move_noop", 409);
      if (source.state === "archived") throw new WorkspaceServerError("workspace_learning_resource_move_archived", 409);
      // A move is a human-only relocation, but it must not make the source
      // Room's historical evidence disappear. Archive the source projection
      // and create an independent destination projection linked to it.
      const movedSource = await updateResource(sql, context, source, {
        state: "archived",
        archivedAt: new Date().toISOString(),
        payload: source.payload,
        reason: input.reason.trim(),
        changeKind: "moved"
      });
      const updated = await insertResource(sql, context, {
        id: targetResourceId,
        scope: { kind: "room", roomId: input.targetRoomId },
        kind: source.kind,
        isAbsoluteRule: source.isAbsoluteRule,
        title: source.title,
        content: source.content,
        payload: source.payload,
        state: isAutomaticCandidateState(source.state) ? "active" : source.state,
        aiUpdateLocked: false,
        ...(isAutomaticCandidateState(source.state) ? { confidence: 1 } : { confidence: source.confidence }),
        ...(source.sourceJobId ? { sourceJobId: source.sourceJobId } : {}),
        ...(source.sourceAttemptId ? { sourceAttemptId: source.sourceAttemptId } : {}),
        reason: input.reason.trim(),
        changeKind: "moved"
      });
      await insertHumanEditEvidence(sql, context.workspaceId, movedSource, input.reason.trim());
      await insertHumanEditEvidence(sql, context.workspaceId, updated, input.reason.trim());
      await insertLink(sql, context.workspaceId, updated.id, source.id, "moved_from");
      await this.store.insertAudit(sql, context, {
        action: "workspace.learning.resource.move",
        roomId: input.targetRoomId,
        subjectKind: "learning_resource",
        subjectId: updated.id,
        beforeVersion: source.version,
        afterVersion: updated.version,
        details: { source_resource_id: source.id, source_room_id: source.scope.roomId, target_room_id: input.targetRoomId }
      });
      return updated;
    });
    return { resource: result.value, replayed: result.replayed };
  }

  async promoteResource(context: WorkspaceRequestContext, input: { resourceId: string; id?: string; expectedVersion: number; reason: string }): Promise<{ resource: WorkspaceLearningResource; replayed: boolean }> {
    assertOpaqueId(input.resourceId, "workspace_learning_resource_id_invalid");
    assertExpectedVersion(input.expectedVersion);
    assertSafeLearningText(input.reason);
    const targetId = input.id ?? scopedId("learning_resource_promote", context.workspaceId, context.operationId);
    assertOpaqueId(targetId, "workspace_learning_resource_id_invalid");
    const result = await this.store.runIdempotentResult(context, { action: "workspace.learning.resource.promote", input: { ...input, id: targetId } }, async (sql) => {
      await assertWorkspaceWritable(sql, context.workspaceId);
      const sourceRow = await selectResourceForUpdate(sql, context.workspaceId, input.resourceId);
      if (!sourceRow) throw new WorkspaceServerError("workspace_learning_resource_not_found", 404);
      const source = resourceFromRow(sourceRow);
      if (source.version !== input.expectedVersion) throw new WorkspaceServerError("workspace_learning_resource_version_conflict", 409, { latest_version: source.version });
      const promoted = await insertResource(sql, context, {
        id: targetId,
        scope: { kind: "workspace" },
        kind: source.kind === "workspace_rule" ? "knowledge" : source.kind,
        isAbsoluteRule: false,
        title: source.title,
        content: source.content,
        payload: source.payload,
        state: isAutomaticCandidateState(source.state) ? "active" : source.state,
        aiUpdateLocked: false,
        ...(isAutomaticCandidateState(source.state) ? { confidence: 1 } : { confidence: source.confidence }),
        ...(source.sourceJobId ? { sourceJobId: source.sourceJobId } : {}),
        ...(source.sourceAttemptId ? { sourceAttemptId: source.sourceAttemptId } : {}),
        reason: input.reason.trim(),
        changeKind: "promoted"
      });
      await insertHumanEditEvidence(sql, context.workspaceId, promoted, input.reason.trim());
      await insertLink(sql, context.workspaceId, promoted.id, source.id, "promoted_from");
      await this.store.insertAudit(sql, context, {
        action: "workspace.learning.resource.promote",
        subjectKind: "learning_resource",
        subjectId: promoted.id,
        afterVersion: promoted.version,
        details: { source_resource_id: source.id, source_room_id: source.scope.roomId ?? null }
      });
      return promoted;
    });
    return { resource: result.value, replayed: result.replayed };
  }

  async searchKnowledge(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, input: { roomId: string; query: string; limit?: number }): Promise<WorkspaceLearningResource[]> {
    assertOpaqueId(input.roomId, "room_id_invalid");
    if (!input.query.trim()) return [];
    const limit = boundedLimit(input.limit);
    return this.store.database.withContext(context, async (sql) => {
      const [rules, room, workspace] = await Promise.all([
        listResourcesForSearch(sql, context.workspaceId, { kind: "workspace", absolute: true }, input.query, limit),
        listResourcesForSearch(sql, context.workspaceId, { kind: "room", roomId: input.roomId }, input.query, limit),
        listResourcesForSearch(sql, context.workspaceId, { kind: "workspace", absolute: false }, input.query, limit)
      ]);
      return rankKnowledgeForCurrentRoom({
        query: input.query,
        workspaceRules: rules,
        roomKnowledge: room,
        workspaceKnowledge: workspace,
        limit
      });
    });
  }

  async getEffectiveSettings(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, roomId: string): Promise<WorkspaceLearningSettings> {
    assertOpaqueId(roomId, "room_id_invalid");
    return this.store.database.withContext(context, async (sql) => (await this.getSettingsLayersInTransaction(sql, context.workspaceId, roomId)).effective);
  }

  /** Returns the effective values plus only the two settings records that
   * actually exist. Callers can therefore create a Room override at version
   * zero without confusing inherited values for a Room-owned configuration. */
  async getSettingsLayers(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, roomId: string): Promise<WorkspaceLearningSettingsLayers> {
    assertOpaqueId(roomId, "room_id_invalid");
    return this.store.database.withContext(context, async (sql) => this.getSettingsLayersInTransaction(sql, context.workspaceId, roomId));
  }

  async updateSettings(context: WorkspaceRequestContext, input: UpdateWorkspaceLearningSettingsInput): Promise<{ settings: WorkspaceLearningSettings; replayed: boolean }> {
    assertScope(input.scope);
    if (input.removeOverride === true) {
      assertRemoveSettingsOverrideInput(input);
      return this.removeSettingsOverride(context, input);
    }
    assertClearSettingsInput(input);
    if (input.engineId !== undefined) {
      assertOpaqueId(input.engineId, "workspace_learning_engine_id_invalid");
      assertSafeLearningText(input.engineId);
    }
    if (input.model !== undefined && (!input.model.trim() || input.model.length > 512)) throw new WorkspaceServerError("workspace_learning_model_invalid", 400);
    if (input.model !== undefined) assertSafeLearningText(input.model);
    if (input.secretRef !== undefined) {
      assertOpaqueId(input.secretRef, "workspace_learning_secret_ref_invalid");
      // A reference may be durable; an actual credential must never be.
      assertSafeLearningText(input.secretRef);
    }
    assertNonnegative(input.currencyLimit, "workspace_learning_currency_limit_invalid");
    assertNonnegativeInteger(input.tokenLimit, "workspace_learning_token_limit_invalid");
    const expectedVersion = input.expectedVersion ?? 0;
    assertExpectedVersion(expectedVersion, 0);
    const result = await this.store.runIdempotentResult(context, { action: "workspace.learning.settings.put", input }, async (sql) => {
      await assertWorkspaceWritable(sql, context.workspaceId);
      const id = settingsId(input.scope);
      const current = await sql.query<SettingsRow>(
        "SELECT * FROM workspace_learning_settings WHERE workspace_id = $1 AND id = $2 FOR UPDATE",
        [context.workspaceId, id]
      );
      const existing = current.rows[0];
      if (!existing && expectedVersion !== 0) throw new WorkspaceServerError("workspace_learning_settings_version_conflict", 409, { latest_version: null });
      if (existing && Number(existing.version) !== expectedVersion) throw new WorkspaceServerError("workspace_learning_settings_version_conflict", 409, { latest_version: Number(existing.version) });
      if (!existing) await assertNewSettingsScopeIsNotRunning(sql, context.workspaceId, input.scope);
      const previous = existing ? settingsFromRow(existing) : undefined;
      const engineId = input.clearEngineId ? null : (input.engineId ?? previous?.engineId ?? null);
      const model = input.clearModel ? null : (input.model?.trim() ?? previous?.model ?? null);
      const secretRef = input.clearSecretRef ? null : (input.secretRef ?? previous?.secretRef ?? null);
      const currencyLimit = input.clearCurrencyLimit ? null : (input.currencyLimit ?? previous?.currencyLimit ?? null);
      const tokenLimit = input.clearTokenLimit ? null : (input.tokenLimit ?? previous?.tokenLimit ?? null);
      assertSettingsBudgetFloor(previous, currencyLimit, tokenLimit);
      const enabled = input.enabled ?? previous?.enabled ?? true;
      const saved = await sql.query<SettingsRow>(
        `INSERT INTO workspace_learning_settings(
           workspace_id, id, scope_kind, room_id, enabled, engine_id, model, secret_ref,
           currency_limit, token_limit, updated_by
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (workspace_id, id) DO UPDATE SET
           enabled = EXCLUDED.enabled, engine_id = EXCLUDED.engine_id, model = EXCLUDED.model,
           secret_ref = EXCLUDED.secret_ref, currency_limit = EXCLUDED.currency_limit,
           token_limit = EXCLUDED.token_limit, version = workspace_learning_settings.version + 1,
           updated_by = EXCLUDED.updated_by, updated_at = NOW()
         WHERE workspace_learning_settings.version = $12
         RETURNING *`,
        [
          context.workspaceId, id, input.scope.kind, input.scope.roomId ?? null, enabled,
          engineId, model, secretRef, currencyLimit, tokenLimit, context.accountId, expectedVersion
        ]
      );
      const row = saved.rows[0];
      if (!row) throw new WorkspaceServerError("workspace_learning_settings_version_conflict", 409);
      const settings = settingsFromRow(row);
      const requeuedJobCount = settings.enabled ? await requeueBlockedLearningJobs(sql, context, input.scope) : 0;
      await this.store.insertAudit(sql, context, {
        action: "workspace.learning.settings.put",
        ...(settings.scope.roomId ? { roomId: settings.scope.roomId } : {}),
        subjectKind: "learning_settings",
        subjectId: settings.id,
        beforeVersion: expectedVersion,
        afterVersion: settings.version,
        details: {
          scope_kind: settings.scope.kind,
          enabled: settings.enabled,
          engine_id: settings.engineId ?? null,
          model: settings.model ?? null,
          requeued_job_count: requeuedJobCount
        }
      });
      return settings;
    });
    return { settings: result.value, replayed: result.replayed };
  }

  private async removeSettingsOverride(context: WorkspaceRequestContext, input: UpdateWorkspaceLearningSettingsInput): Promise<{ settings: WorkspaceLearningSettings; replayed: boolean }> {
    if (input.scope.kind !== "room") throw new WorkspaceServerError("workspace_learning_settings_override_scope_invalid", 400);
    const expectedVersion = input.expectedVersion ?? 0;
    assertExpectedVersion(expectedVersion);
    const result = await this.store.runIdempotentResult(context, { action: "workspace.learning.settings.remove_override", input }, async (sql) => {
      await assertWorkspaceWritable(sql, context.workspaceId);
      const id = settingsId(input.scope);
      const current = await sql.query<SettingsRow>(
        "SELECT * FROM workspace_learning_settings WHERE workspace_id = $1 AND id = $2 FOR UPDATE",
        [context.workspaceId, id]
      );
      const existing = current.rows[0];
      if (!existing || Number(existing.version) !== expectedVersion) {
        throw new WorkspaceServerError("workspace_learning_settings_version_conflict", 409, { latest_version: existing ? Number(existing.version) : null });
      }
      const previous = settingsFromRow(existing);
      if (previous.currencyReserved > 0 || previous.tokensReserved > 0) {
        throw new WorkspaceServerError("workspace_learning_settings_reservation_active", 409);
      }
      const deleted = await sql.query<SettingsRow>(
        `DELETE FROM workspace_learning_settings
         WHERE workspace_id = $1 AND id = $2 AND version = $3
         RETURNING *`,
        [context.workspaceId, id, expectedVersion]
      );
      const deletedSettings = deleted.rows[0];
      if (!deletedSettings) throw new WorkspaceServerError("workspace_learning_settings_version_conflict", 409);
      const layers = await this.getSettingsLayersInTransaction(sql, context.workspaceId, input.scope.roomId!);
      const requeuedJobCount = layers.effective.enabled ? await requeueBlockedLearningJobs(sql, context, input.scope) : 0;
      await this.store.insertAudit(sql, context, {
        action: "workspace.learning.settings.remove_override",
        roomId: input.scope.roomId,
        subjectKind: "learning_settings",
        subjectId: id,
        beforeVersion: expectedVersion,
        details: { scope_kind: "room", requeued_job_count: requeuedJobCount }
      });
      return layers.effective;
    });
    return { settings: result.value, replayed: result.replayed };
  }

  async listJobs(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, input: { roomId: string; status?: WorkspaceLearningJob["status"]; limit?: number }): Promise<WorkspaceLearningJob[]> {
    assertOpaqueId(input.roomId, "room_id_invalid");
    const limit = boundedLimit(input.limit);
    return this.store.database.withContext(context, async (sql) => {
      const result = await sql.query<JobRow>(
        `SELECT * FROM workspace_learning_jobs WHERE workspace_id = $1 AND room_id = $2
           AND ($3::TEXT IS NULL OR status = $3) ORDER BY created_at DESC, id DESC LIMIT $4`,
        [context.workspaceId, input.roomId, input.status ?? null, limit]
      );
      return result.rows.map(jobFromRow);
    });
  }

  async listJobAttempts(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, jobId: string): Promise<WorkspaceLearningJobAttempt[]> {
    assertOpaqueId(jobId, "workspace_learning_job_id_invalid");
    return this.store.database.withContext(context, async (sql) => {
      const result = await sql.query<AttemptRow>(
        "SELECT * FROM workspace_learning_job_attempts WHERE workspace_id = $1 AND job_id = $2 ORDER BY attempt_no DESC",
        [context.workspaceId, jobId]
      );
      return result.rows.map(attemptFromRow);
    });
  }

  /** Runner-only routing hint. It exposes configuration identifiers, never a
   * secret, and does not claim or mutate the Job. */
  async nextDueJobConfiguration(
    context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">,
    input: { roomId?: string } = {}
  ): Promise<{ roomId: string; engineId?: string; model?: string } | undefined> {
    if (input.roomId) assertOpaqueId(input.roomId, "room_id_invalid");
    return this.store.database.withContext(context, async (sql) => {
      const candidate = await sql.query<JobRow>(
        `SELECT * FROM workspace_learning_jobs
         WHERE workspace_id = $1 AND ($2::TEXT IS NULL OR room_id = $2)
           AND status = 'queued' AND next_run_at <= NOW() AND attempt_count < max_attempts
         ORDER BY CASE priority WHEN 'high' THEN 0 ELSE 1 END, next_run_at, created_at
         LIMIT 1`,
        [context.workspaceId, input.roomId ?? null]
      );
      const row = candidate.rows[0];
      if (!row) return undefined;
      const job = jobFromRow(row);
      const settings = (await this.getSettingsLayersInTransaction(sql, context.workspaceId, job.roomId)).effective;
      return { roomId: job.roomId, ...(settings.engineId ? { engineId: settings.engineId } : {}), ...(settings.model ? { model: settings.model } : {}) };
    });
  }

  async claimNextJob(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, input: ClaimWorkspaceLearningJobInput): Promise<ClaimedWorkspaceLearningJob | undefined> {
    assertOpaqueId(input.workerId, "workspace_learning_worker_id_invalid");
    if (input.roomId) assertOpaqueId(input.roomId, "room_id_invalid");
    if (input.engineId !== undefined) assertOpaqueId(input.engineId, "workspace_learning_engine_id_invalid");
    if (input.model !== undefined && (!input.model.trim() || input.model.length > 512)) throw new WorkspaceServerError("workspace_learning_model_invalid", 400);
    const reservation = normalizeReservation(input.reservation);
    const leaseMs = Math.min(10 * 60_000, Math.max(10_000, Math.trunc(input.leaseMs ?? 60_000)));
    return this.store.database.withContext(context, async (sql) => {
      await failExhaustedExpiredJobs(sql, context.workspaceId, input.roomId);
      const candidate = await sql.query<JobRow>(
        `SELECT * FROM workspace_learning_jobs
         WHERE workspace_id = $1
           AND ($2::TEXT IS NULL OR room_id = $2)
           AND ((status = 'queued' AND next_run_at <= NOW()) OR (status = 'running' AND lease_expires_at < NOW()))
           AND attempt_count < max_attempts
         ORDER BY CASE priority WHEN 'high' THEN 0 ELSE 1 END, next_run_at, created_at
         FOR UPDATE SKIP LOCKED LIMIT 1`,
        [context.workspaceId, input.roomId ?? null]
      );
      const row = candidate.rows[0];
      if (!row) return undefined;
      const before = jobFromRow(row);
      if (before.status === "running") {
        const expired = await sql.query<AttemptRow>(
          `UPDATE workspace_learning_job_attempts
           SET status = 'failed', error_code = 'workspace_learning_lease_expired', completed_at = NOW()
           WHERE workspace_id = $1 AND job_id = $2 AND status = 'running'
           RETURNING *`,
          [context.workspaceId, before.id]
        );
        const priorSettings = await this.getLockedSettingsLayersInTransaction(sql, context.workspaceId, before.roomId);
        for (const attempt of expired.rows.map(attemptFromRow)) {
          await releaseReservation(sql, context.workspaceId, before.roomId, priorSettings, attempt.reservation);
        }
      }
      const settingsLayers = await this.getLockedSettingsLayersInTransaction(sql, context.workspaceId, before.roomId);
      const settings = settingsLayers.effective;
      const budgetBlock = budgetBlockReason(settingsLayers);
      let snapshot: WorkspaceKnowledgeReviewSnapshot;
      try {
        snapshot = await this.snapshotForJob(sql, context.workspaceId, before);
      } catch (error) {
        if (error instanceof WorkspaceServerError && error.code.startsWith("workspace_learning_snapshot_")) {
          const blocked = await blockUnclaimedJob(sql, context, before, error.code, settings);
          return { job: blocked, snapshot: emptySnapshot(context.workspaceId, before.roomId), settings };
        }
        throw error;
      }
      if (budgetBlock || !settings.enabled || !settings.engineId) {
        const reason = budgetBlock ?? (!settings.enabled ? "workspace_learning_disabled" : "workspace_learning_engine_unconfigured");
        const blocked = await blockUnclaimedJob(sql, context, before, reason, settings);
        return { job: blocked, snapshot, settings };
      }
      if (!input.engineId) {
        const blocked = await blockUnclaimedJob(sql, context, before, "workspace_learning_engine_port_unavailable", settings);
        return { job: blocked, snapshot, settings };
      }
      // A worker for a different cassette simply has no claim here. It must
      // not block a Job that another registered cassette can execute.
      if (input.engineId !== settings.engineId || (input.model ?? undefined) !== (settings.model ?? undefined)) return undefined;
      const reservationBlock = reservationBlockReason(settingsLayers, reservation, input.reservation);
      if (reservationBlock) {
        const blocked = await blockUnclaimedJob(sql, context, before, reservationBlock, settings);
        return { job: blocked, snapshot, settings };
      }
      const reserveBlock = await reserveSettingsLayers(sql, context.workspaceId, before.roomId, settingsLayers, reservation);
      if (reserveBlock) {
        const blocked = await blockUnclaimedJob(sql, context, before, reserveBlock, settings);
        return { job: blocked, snapshot, settings };
      }
      const attemptNo = before.attemptCount + 1;
      const leaseExpiresAt = new Date(Date.now() + leaseMs).toISOString();
      const running = await sql.query<JobRow>(
        `UPDATE workspace_learning_jobs
         SET status = 'running', attempt_count = $3, lease_owner = $4, lease_expires_at = $5::TIMESTAMPTZ,
             heartbeat_at = NOW(), blocked_reason = NULL, engine_id = $6, model = $7,
             updated_by = $8, updated_at = NOW()
         WHERE workspace_id = $1 AND id = $2
         RETURNING *`,
        [context.workspaceId, before.id, attemptNo, input.workerId, leaseExpiresAt, settings.engineId, settings.model ?? null, context.accountId]
      );
      const job = jobFromRow(running.rows[0]!);
      const attemptId = scopedId("learning_attempt", context.workspaceId, `${job.id}:${attemptNo}`);
      const attempt = await sql.query<AttemptRow>(
        `INSERT INTO workspace_learning_job_attempts(
           workspace_id, id, job_id, attempt_no, worker_id, engine_id, model, status, input_hash, reserved_currency, reserved_tokens
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'running', $8, $9, $10) RETURNING *`,
        [context.workspaceId, attemptId, job.id, attemptNo, input.workerId, settings.engineId ?? null, settings.model ?? null, snapshotHash(snapshot), reservation.currency, reservation.tokens]
      );
      const parsedAttempt = attemptFromRow(attempt.rows[0]!);
      return { job, attempt: parsedAttempt, snapshot, settings };
    });
  }

  async heartbeat(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, input: { jobId: string; workerId: string; leaseMs?: number }): Promise<WorkspaceLearningJob> {
    assertOpaqueId(input.jobId, "workspace_learning_job_id_invalid");
    assertOpaqueId(input.workerId, "workspace_learning_worker_id_invalid");
    const leaseMs = Math.min(10 * 60_000, Math.max(10_000, Math.trunc(input.leaseMs ?? 60_000)));
    return this.store.database.withContext(context, async (sql) => {
      const result = await sql.query<JobRow>(
        `UPDATE workspace_learning_jobs SET heartbeat_at = NOW(), lease_expires_at = $4::TIMESTAMPTZ, updated_at = NOW()
         WHERE workspace_id = $1 AND id = $2 AND status = 'running' AND lease_owner = $3
         RETURNING *`,
        [context.workspaceId, input.jobId, input.workerId, new Date(Date.now() + leaseMs).toISOString()]
      );
      const row = result.rows[0];
      if (!row) throw new WorkspaceServerError("workspace_learning_job_lease_lost", 409);
      return jobFromRow(row);
    });
  }

  async applyReview(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, input: ApplyWorkspaceLearningReviewInput): Promise<WorkspaceLearningJob> {
    assertOpaqueId(input.jobId, "workspace_learning_job_id_invalid");
    assertOpaqueId(input.attemptId, "workspace_learning_attempt_id_invalid");
    assertOpaqueId(input.workerId, "workspace_learning_worker_id_invalid");
    return this.store.database.withContext(context, async (sql) => {
      const jobRow = await sql.query<JobRow>(
        "SELECT * FROM workspace_learning_jobs WHERE workspace_id = $1 AND id = $2 FOR UPDATE",
        [context.workspaceId, input.jobId]
      );
      const job = jobRow.rows[0] ? jobFromRow(jobRow.rows[0]) : undefined;
      if (!job) throw new WorkspaceServerError("workspace_learning_job_not_found", 404);
      if (job.status !== "running" || job.leaseOwner !== input.workerId || !job.leaseExpiresAt || new Date(job.leaseExpiresAt).getTime() <= Date.now()) {
        throw new WorkspaceServerError("workspace_learning_job_lease_lost", 409);
      }
      const attemptRow = await sql.query<AttemptRow>(
        "SELECT * FROM workspace_learning_job_attempts WHERE workspace_id = $1 AND id = $2 FOR UPDATE",
        [context.workspaceId, input.attemptId]
      );
      const attempt = attemptRow.rows[0] ? attemptFromRow(attemptRow.rows[0]) : undefined;
      if (!attempt || attempt.jobId !== job.id || attempt.status !== "running") throw new WorkspaceServerError("workspace_learning_attempt_not_running", 409);
      const snapshot = await this.snapshotForJob(sql, context.workspaceId, job);
      const settingsLayers = await this.getLockedSettingsLayersInTransaction(sql, context.workspaceId, job.roomId);
      const use = normalizeUsage(input.result?.usage);
      if (snapshotHash(snapshot) !== attempt.inputHash) {
        return this.requeueStaleReview(sql, context, job, attempt, use, "workspace_learning_input_stale");
      }
      const effective = settingsLayers.effective;
      if (!effective.enabled || !effective.engineId || effective.engineId !== attempt.engineId || (effective.model ?? undefined) !== (attempt.model ?? undefined)) {
        const reason = !effective.enabled
          ? "workspace_learning_configuration_changed_disabled"
          : "workspace_learning_configuration_changed";
        return (await this.finishBlockedJob(sql, context, job, attempt, reason, undefined, use, settingsLayers)).job;
      }
      const result = validateWorkspaceKnowledgeReviewResult(snapshot, input.result);
      const reservationBlock = reservationExceeded(settingsLayers, attempt.reservation, use);
      const postChargeBlock = reservationBlock ?? budgetExceeds(settingsLayers, use, attempt.reservation);
      if (postChargeBlock) {
        return (await this.finishBlockedJob(sql, context, job, attempt, postChargeBlock, result, use, settingsLayers)).job;
      }
      for (const mutation of result.mutations) {
        await this.applyReviewMutation(sql, { workspaceId: context.workspaceId, accountId: context.accountId, job, attempt, snapshot }, mutation);
      }
      await settleReservationAndCharge(sql, context.workspaceId, job.roomId, settingsLayers, attempt.reservation, use);
      const completed = await sql.query<JobRow>(
        `UPDATE workspace_learning_jobs SET status = 'completed', lease_owner = NULL, lease_expires_at = NULL,
           heartbeat_at = NULL, completed_at = NOW(), updated_by = $3, updated_at = NOW()
         WHERE workspace_id = $1 AND id = $2 RETURNING *`,
        [context.workspaceId, job.id, context.accountId]
      );
      const completedJob = jobFromRow(completed.rows[0]!);
      await sql.query(
        `UPDATE workspace_learning_job_attempts
         SET status = 'completed', output = $3::JSONB, output_hash = $4, currency_used = $5, tokens_used = $6, completed_at = NOW()
         WHERE workspace_id = $1 AND id = $2`,
        [context.workspaceId, attempt.id, canonicalJson(reviewResultPayload(result)), hashJson(reviewResultPayload(result)), use.currency, use.tokens]
      );
      await this.store.insertAudit(sql, { ...context, operationId: `learning:${job.id}:${attempt.id}` }, {
        action: "workspace.learning.review.apply",
        roomId: job.roomId,
        subjectKind: "learning_job",
        subjectId: job.id,
        afterVersion: completedJob.attemptCount,
        details: { mutation_count: result.mutations.length, attempt_id: attempt.id }
      });
      return completedJob;
    });
  }

  private async requeueStaleReview(
    sql: WorkspaceSql,
    context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">,
    job: WorkspaceLearningJob,
    attempt: WorkspaceLearningJobAttempt,
    usage: { currency: number; tokens: number },
    reason: string
  ): Promise<WorkspaceLearningJob> {
    const settingsLayers = await this.getLockedSettingsLayersInTransaction(sql, context.workspaceId, job.roomId);
    await settleReservationAndCharge(sql, context.workspaceId, job.roomId, settingsLayers, attempt.reservation, usage);
    const updated = await sql.query<JobRow>(
      `UPDATE workspace_learning_jobs
       SET status = 'queued', next_run_at = NOW(), lease_owner = NULL, lease_expires_at = NULL,
           heartbeat_at = NULL, blocked_reason = NULL, completed_at = NULL, updated_by = $3, updated_at = NOW()
       WHERE workspace_id = $1 AND id = $2 RETURNING *`,
      [context.workspaceId, job.id, context.accountId]
    );
    const output = { stale: true, reason };
    await sql.query(
      `UPDATE workspace_learning_job_attempts
       SET status = 'failed', error_code = $3, output = $4::JSONB, output_hash = $5,
           currency_used = $6, tokens_used = $7, completed_at = NOW()
       WHERE workspace_id = $1 AND id = $2`,
      [context.workspaceId, attempt.id, reason, canonicalJson(output), hashJson(output), usage.currency, usage.tokens]
    );
    return jobFromRow(updated.rows[0]!);
  }

  async failJob(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, input: { jobId: string; attemptId: string; workerId: string; errorCode: string; retryable: boolean }): Promise<WorkspaceLearningJob> {
    assertOpaqueId(input.jobId, "workspace_learning_job_id_invalid");
    assertOpaqueId(input.attemptId, "workspace_learning_attempt_id_invalid");
    assertOpaqueId(input.workerId, "workspace_learning_worker_id_invalid");
    if (!/^[a-z][a-z0-9_:-]{0,255}$/.test(input.errorCode)) throw new WorkspaceServerError("workspace_learning_error_code_invalid", 400);
    return this.store.database.withContext(context, async (sql) => {
      const jobRow = await sql.query<JobRow>("SELECT * FROM workspace_learning_jobs WHERE workspace_id = $1 AND id = $2 FOR UPDATE", [context.workspaceId, input.jobId]);
      const job = jobRow.rows[0] ? jobFromRow(jobRow.rows[0]) : undefined;
      if (!job) throw new WorkspaceServerError("workspace_learning_job_not_found", 404);
      if (job.status !== "running" || job.leaseOwner !== input.workerId) throw new WorkspaceServerError("workspace_learning_job_lease_lost", 409);
      const attemptRow = await sql.query<AttemptRow>(
        `SELECT * FROM workspace_learning_job_attempts
         WHERE workspace_id = $1 AND id = $2 AND job_id = $3 AND status = 'running' FOR UPDATE`,
        [context.workspaceId, input.attemptId, job.id]
      );
      const attempt = attemptRow.rows[0] ? attemptFromRow(attemptRow.rows[0]) : undefined;
      if (!attempt) throw new WorkspaceServerError("workspace_learning_attempt_not_running", 409);
      const settingsLayers = await this.getLockedSettingsLayersInTransaction(sql, context.workspaceId, job.roomId);
      await releaseReservation(sql, context.workspaceId, job.roomId, settingsLayers, attempt.reservation);
      const terminal = !input.retryable || job.attemptCount >= job.maxAttempts;
      const nextStatus = terminal ? "failed" : "queued";
      const nextRunAt = terminal ? null : new Date(Date.now() + learningRetryDelayMs(job.attemptCount)).toISOString();
      const updated = await sql.query<JobRow>(
        `UPDATE workspace_learning_jobs SET status = $3, next_run_at = COALESCE($4::TIMESTAMPTZ, next_run_at),
           lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
           blocked_reason = CASE WHEN $3 = 'failed' THEN $5 ELSE NULL END,
           completed_at = CASE WHEN $3 = 'failed' THEN NOW() ELSE NULL END, updated_by = $6, updated_at = NOW()
         WHERE workspace_id = $1 AND id = $2 RETURNING *`,
        [context.workspaceId, job.id, nextStatus, nextRunAt, input.errorCode.trim(), context.accountId]
      );
      await sql.query(
        `UPDATE workspace_learning_job_attempts SET status = 'failed', error_code = $3, completed_at = NOW()
         WHERE workspace_id = $1 AND id = $2 AND status = 'running'`,
        [context.workspaceId, input.attemptId, input.errorCode.trim()]
      );
      return jobFromRow(updated.rows[0]!);
    });
  }

  private async enqueueLearningReview(sql: WorkspaceSql, context: WorkspaceRequestContext, input: {
    roomId: string;
    activity: WorkspaceLearningActivity;
    priority: "normal" | "high";
  }): Promise<WorkspaceLearningJob> {
    const queued = await sql.query<JobRow>(
      `SELECT * FROM workspace_learning_jobs
       WHERE workspace_id = $1 AND room_id = $2 AND kind = 'review' AND group_key = $3 AND status = 'queued'
       FOR UPDATE`,
      [context.workspaceId, input.roomId, input.activity.groupKey]
    );
    if (queued.rows[0]) {
      const current = jobFromRow(queued.rows[0]);
      const updated = await sql.query<JobRow>(
        `UPDATE workspace_learning_jobs
         SET high_watermark_activity_id = $3,
             priority = CASE WHEN $4 = 'high' THEN 'high' ELSE priority END,
             next_run_at = NOW(), updated_by = $5, updated_at = NOW()
         WHERE workspace_id = $1 AND id = $2 RETURNING *`,
        [context.workspaceId, current.id, input.activity.id, input.priority, context.accountId]
      );
      return jobFromRow(updated.rows[0]!);
    }
    // A blocked grouped review becomes runnable only from a human settings
    // change or from fresh, explicit evidence. Reuse one blocked record here
    // so a work group does not grow an unbounded Job trail.
    const blocked = await sql.query<JobRow>(
      `WITH target AS (
         SELECT id FROM workspace_learning_jobs
         WHERE workspace_id = $1 AND room_id = $2 AND kind = 'review' AND group_key = $3 AND status = 'blocked'
         ORDER BY created_at, id FOR UPDATE SKIP LOCKED LIMIT 1
       )
       UPDATE workspace_learning_jobs
       SET status = 'queued', blocked_reason = NULL, completed_at = NULL,
           high_watermark_activity_id = $4,
           priority = CASE WHEN $5 = 'high' THEN 'high' ELSE priority END,
           next_run_at = NOW(), updated_by = $6, updated_at = NOW()
       WHERE workspace_id = $1 AND id = (SELECT id FROM target)
       RETURNING *`,
      [context.workspaceId, input.roomId, input.activity.groupKey, input.activity.id, input.priority, context.accountId]
    );
    if (blocked.rows[0]) return jobFromRow(blocked.rows[0]);
    const id = scopedId("learning_job", context.workspaceId, `${context.operationId}:${input.activity.id}`);
    const saved = await sql.query<JobRow>(
      `INSERT INTO workspace_learning_jobs(
         workspace_id, room_id, id, kind, status, priority, group_key, high_watermark_activity_id,
         created_by, updated_by
       ) VALUES ($1, $2, $3, 'review', 'queued', $4, $5, $6, $7, $7)
       ON CONFLICT (workspace_id, room_id, kind, group_key) WHERE status = 'queued' DO UPDATE SET
         high_watermark_activity_id = EXCLUDED.high_watermark_activity_id,
         priority = CASE WHEN EXCLUDED.priority = 'high' THEN 'high' ELSE workspace_learning_jobs.priority END,
         next_run_at = NOW(), updated_by = EXCLUDED.updated_by, updated_at = NOW()
       RETURNING *`,
      [context.workspaceId, input.roomId, id, input.priority, input.activity.groupKey, input.activity.id, context.accountId]
    );
    return jobFromRow(saved.rows[0]!);
  }

  private async snapshotForJob(sql: WorkspaceSql, workspaceId: string, job: WorkspaceLearningJob): Promise<WorkspaceKnowledgeReviewSnapshot> {
    const activities = await sql.query<ActivityRow>(
      `WITH boundary AS (
         SELECT finalized_at FROM workspace_learning_activities WHERE workspace_id = $1 AND id = $2
       )
       SELECT activity.* FROM workspace_learning_activities activity, boundary
       WHERE activity.workspace_id = $1 AND activity.room_id = $3 AND activity.group_key = $4
         AND activity.finalized_at <= boundary.finalized_at
       ORDER BY activity.finalized_at, activity.id
       LIMIT $5`,
      [workspaceId, job.highWatermarkActivityId, job.roomId, job.groupKey, maxSnapshotActivities + 1]
    );
    if (activities.rows.length > maxSnapshotActivities) throw new WorkspaceServerError("workspace_learning_snapshot_too_large", 409);
    const activityRecords = activities.rows.map(activityFromRow);
    const uses = activityRecords.length === 0
      ? []
      : (await sql.query<ResourceUseRow>(
        `SELECT * FROM workspace_learning_resource_uses
         WHERE workspace_id = $1 AND activity_id = ANY($2::TEXT[])
         ORDER BY activity_id, created_at, id`,
        [workspaceId, activityRecords.map((activity) => activity.id)]
      )).rows.map(resourceUseFromRow);
    const usesByActivityId = new Map<string, WorkspaceLearningResourceUse[]>();
    for (const use of uses) {
      const current = usesByActivityId.get(use.activityId) ?? [];
      current.push(use);
      usesByActivityId.set(use.activityId, current);
    }
    const [rules, common, room] = await Promise.all([
      listResourcesForSearch(sql, workspaceId, { kind: "workspace", absolute: true }, "", maxSnapshotRules + 1),
      listResourcesForSearch(sql, workspaceId, { kind: "workspace", absolute: false }, "", maxSnapshotWorkspaceKnowledge + 1),
      listResourcesForSearch(sql, workspaceId, { kind: "room", roomId: job.roomId }, "", maxSnapshotRoomKnowledge + 1)
    ]);
    if (rules.length > maxSnapshotRules || common.length > maxSnapshotWorkspaceKnowledge || room.length > maxSnapshotRoomKnowledge) {
      throw new WorkspaceServerError("workspace_learning_snapshot_too_large", 409);
    }
    const eligibleRecords = activityRecords.filter((record) => {
      const resourceUses = usesByActivityId.get(record.id) ?? [];
      return classifyLearningActivity({
        outcome: record.outcome,
        verificationState: record.verificationState,
        failureState: record.failureState,
        correctionOfActivityId: record.correctionOfActivityId,
        explicitRemember: record.explicitRemember,
        finalizedResource: payloadBoolean(record.payload, "finalized_resource"),
        reusableCompletion: payloadBoolean(record.payload, "reusable_completion"),
        learningUseOutcomeKnown: resourceUses.some((use) => use.outcome === "confirmed_success" || use.outcome === "confirmed_failure")
      }).eligible;
    });
    if (eligibleRecords.length === 0) throw new WorkspaceServerError("workspace_learning_snapshot_no_eligible_activity", 409);
    const snapshot: WorkspaceKnowledgeReviewSnapshot = {
      workspaceId,
      roomId: job.roomId,
      activities: eligibleRecords.map((record) => {
        const resourceUses = usesByActivityId.get(record.id) ?? [];
        return {
          id: record.id,
          instructionSummary: record.instructionSummary,
          ...(record.resultSummary ? { resultSummary: record.resultSummary } : {}),
          outcome: record.outcome,
          verificationState: record.verificationState,
          failureState: record.failureState,
          ...(record.correctionOfActivityId ? { correctionOfActivityId: record.correctionOfActivityId } : {}),
          explicitRemember: record.explicitRemember,
          payload: {
            ...record.payload,
            ...(resourceUses.length > 0 ? {
              learning_resource_uses: resourceUses.map((use) => ({
                resource_id: use.resourceId,
                resource_version: use.resourceVersion,
                outcome: use.outcome,
                summary: use.summary
              }))
            } : {})
          }
        };
      }),
      workspaceRules: rules,
      workspaceKnowledge: common,
      roomKnowledge: room
    };
    if (Buffer.byteLength(canonicalJson(snapshot), "utf8") > maxSnapshotBytes) {
      throw new WorkspaceServerError("workspace_learning_snapshot_too_large", 409);
    }
    return snapshot;
  }

  private async getLockedSettingsLayersInTransaction(sql: WorkspaceSql, workspaceId: string, roomId: string): Promise<WorkspaceLearningSettingsLayers> {
    await lockWorkspaceLearningSettings(sql, workspaceId, roomId);
    return this.getSettingsLayersInTransaction(sql, workspaceId, roomId);
  }

  private async getSettingsLayersInTransaction(sql: WorkspaceSql, workspaceId: string, roomId: string): Promise<WorkspaceLearningSettingsLayers> {
    const result = await sql.query<SettingsRow>(
      `SELECT * FROM workspace_learning_settings
       WHERE workspace_id = $1 AND ((scope_kind = 'room' AND room_id = $2) OR scope_kind = 'workspace')
       ORDER BY CASE scope_kind WHEN 'room' THEN 0 ELSE 1 END`,
      [workspaceId, roomId]
    );
    const room = result.rows.find((row) => row.scope_kind === "room");
    const workspace = result.rows.find((row) => row.scope_kind === "workspace");
    const roomSettings = room ? settingsFromRow(room) : undefined;
    const workspaceSettings = workspace ? settingsFromRow(workspace) : undefined;
    if (roomSettings || workspaceSettings) {
      const preferred = roomSettings ?? workspaceSettings!;
      const engineId = roomSettings?.engineId ?? workspaceSettings?.engineId;
      const model = roomSettings?.model ?? workspaceSettings?.model;
      const secretRef = roomSettings?.secretRef ?? workspaceSettings?.secretRef;
      const currencyLimit = roomSettings?.currencyLimit ?? workspaceSettings?.currencyLimit;
      const tokenLimit = roomSettings?.tokenLimit ?? workspaceSettings?.tokenLimit;
      return {
        ...(workspaceSettings ? { workspace: workspaceSettings } : {}),
        ...(roomSettings ? { room: roomSettings } : {}),
        effective: {
          ...preferred,
          enabled: roomSettings?.enabled ?? workspaceSettings?.enabled ?? true,
          ...(engineId !== undefined ? { engineId } : {}),
          ...(model !== undefined ? { model } : {}),
          ...(secretRef !== undefined ? { secretRef } : {}),
          ...(currencyLimit !== undefined ? { currencyLimit } : {}),
          ...(tokenLimit !== undefined ? { tokenLimit } : {})
        }
      };
    }
    // No settings means learning is configured but not executable. A caller
    // must make an explicit engine choice; we never quietly reuse a chat key.
    return {
      effective: {
        workspaceId,
        id: settingsId({ kind: "workspace" }),
        scope: { kind: "workspace" },
        enabled: true,
        currencyUsed: 0,
        tokensUsed: 0,
        currencyReserved: 0,
        tokensReserved: 0,
        version: 0,
        updatedBy: "",
        updatedAt: new Date(0).toISOString()
      }
    };
  }

  private async finishBlockedJob(
    sql: WorkspaceSql,
    context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">,
    job: WorkspaceLearningJob,
    attempt: WorkspaceLearningJobAttempt,
    reason: string,
    result?: WorkspaceKnowledgeReviewResult,
    usage = { currency: 0, tokens: 0 },
    settingsLayers?: WorkspaceLearningSettingsLayers
  ): Promise<{ job: WorkspaceLearningJob; attempt: WorkspaceLearningJobAttempt }> {
    const currentSettings = settingsLayers ?? await this.getLockedSettingsLayersInTransaction(sql, context.workspaceId, job.roomId);
    await settleReservationAndCharge(sql, context.workspaceId, job.roomId, currentSettings, attempt.reservation, usage);
    const saved = await sql.query<JobRow>(
      `UPDATE workspace_learning_jobs SET status = 'blocked', blocked_reason = $3,
         lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL, updated_by = $4, updated_at = NOW()
       WHERE workspace_id = $1 AND id = $2 RETURNING *`,
      [context.workspaceId, job.id, reason, context.accountId]
    );
    const output = result ? reviewResultPayload(result) : {};
    const attemptSaved = await sql.query<AttemptRow>(
      `UPDATE workspace_learning_job_attempts SET status = 'blocked', error_code = $3,
         output = $4::JSONB, output_hash = $5, currency_used = $6, tokens_used = $7, completed_at = NOW()
       WHERE workspace_id = $1 AND id = $2 RETURNING *`,
      [context.workspaceId, attempt.id, reason, canonicalJson(output), hashJson(output), usage.currency, usage.tokens]
    );
    return { job: jobFromRow(saved.rows[0]!), attempt: attemptFromRow(attemptSaved.rows[0]!) };
  }

  private async applyReviewMutation(
    sql: WorkspaceSql,
    input: { workspaceId: string; accountId: string; job: WorkspaceLearningJob; attempt: WorkspaceLearningJobAttempt; snapshot: WorkspaceKnowledgeReviewSnapshot },
    mutation: WorkspaceKnowledgeReviewResult["mutations"][number]
  ): Promise<void> {
    if (mutation.kind === "no_change") return;
    const context: WorkspaceRequestContext = { workspaceId: input.workspaceId, accountId: input.accountId, operationId: `learning:${input.job.id}` };
    if (mutation.kind === "create") {
      const id = scopedId("learning_resource", input.workspaceId, `${input.job.id}:${mutation.title}:${mutation.content}:${hashJson(mutation.payload ?? {})}`);
      const resource = await insertResource(sql, context, {
        id,
        scope: { kind: "room", roomId: input.job.roomId },
        kind: mutation.resourceKind!,
        isAbsoluteRule: false,
        title: mutation.title!,
        content: mutation.content!,
        payload: mutation.payload ?? {},
        state: "provisional",
        aiUpdateLocked: false,
        confidence: mutation.confidence,
        sourceJobId: input.job.id,
        sourceAttemptId: input.attempt.id,
        reason: mutation.reason,
        changeKind: "created"
      });
      await insertEvidence(sql, input.workspaceId, resource, mutation.evidenceActivityIds, input.snapshot);
      return;
    }
    const row = await selectResourceForUpdate(sql, input.workspaceId, mutation.resourceId!);
    if (!row) throw new WorkspaceServerError("workspace_learning_resource_not_found", 404);
    const current = resourceFromRow(row);
    if (current.scope.kind !== "room" || current.scope.roomId !== input.job.roomId) {
      throw new WorkspaceServerError("workspace_learning_review_cross_room_resource_denied", 422);
    }
    if (mutation.kind === "update") {
      if (current.aiUpdateLocked) throw new WorkspaceServerError("workspace_learning_resource_ai_update_locked", 409);
      if (current.version !== mutation.expectedVersion) throw new WorkspaceServerError("workspace_learning_resource_version_conflict", 409, { latest_version: current.version });
      const updated = await updateResource(sql, context, current, {
        title: mutation.title!, content: mutation.content!, payload: mutation.payload ?? current.payload,
        reason: mutation.reason, changeKind: "updated"
      });
      await insertEvidence(sql, input.workspaceId, updated, mutation.evidenceActivityIds, input.snapshot);
      return;
    }
    if (mutation.kind === "evidence_append") {
      if (current.aiUpdateLocked) throw new WorkspaceServerError("workspace_learning_resource_ai_update_locked", 409);
      if (current.version !== mutation.expectedVersion) throw new WorkspaceServerError("workspace_learning_resource_version_conflict", 409, { latest_version: current.version });
      const updated = await updateResource(sql, context, current, { reason: mutation.reason, changeKind: "evidence_appended" });
      await insertEvidence(sql, input.workspaceId, updated, mutation.evidenceActivityIds, input.snapshot);
      return;
    }
    if (current.version !== mutation.expectedVersion) throw new WorkspaceServerError("workspace_learning_resource_version_conflict", 409, { latest_version: current.version });
    // Keep both propositions. A human-fixed existing item is never modified;
    // the new contradictory candidate is linked as a conflict instead.
    const candidate = await insertResource(sql, context, {
      id: scopedId("learning_resource_conflict", input.workspaceId, `${input.job.id}:${current.id}:${mutation.title}:${mutation.content}:${hashJson(mutation.payload ?? {})}`),
      scope: current.scope,
      kind: current.kind,
      isAbsoluteRule: false,
      title: mutation.title!,
      content: mutation.content!,
      payload: mutation.payload ?? {},
      state: "conflict",
      aiUpdateLocked: false,
      confidence: mutation.confidence,
      sourceJobId: input.job.id,
      sourceAttemptId: input.attempt.id,
      reason: mutation.reason,
      changeKind: "conflict_recorded"
    });
    await insertEvidence(sql, input.workspaceId, candidate, mutation.evidenceActivityIds, input.snapshot);
    await insertLink(sql, input.workspaceId, candidate.id, current.id, "conflicts");
  }
}

/** A worker owns no database capability beyond the caller context provided for
 * one Room. The review port is injectable so Backend cassette selection stays
 * outside this storage package. */
export class WorkspaceLearningWorker {
  private readonly reviewTimeoutMs: number;

  constructor(
    private readonly learning: WorkspaceLearningService,
    private readonly reviewPort: WorkspaceKnowledgeReviewPort,
    options: { reviewTimeoutMs?: number } = {}
  ) {
    this.reviewTimeoutMs = Math.min(10 * 60_000, Math.max(100, Math.trunc(options.reviewTimeoutMs ?? 5 * 60_000)));
  }

  async runOne(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, input: { workerId: string; roomId?: string; signal?: AbortSignal }): Promise<WorkspaceLearningJob | undefined> {
    const claimed = await this.learning.claimNextJob(context, {
      workerId: input.workerId,
      engineId: this.reviewPort.id,
      ...(this.reviewPort.model ? { model: this.reviewPort.model } : {}),
      ...(this.reviewPort.maxUsage ? { reservation: this.reviewPort.maxUsage } : {}),
      ...(input.roomId ? { roomId: input.roomId } : {})
    });
    if (!claimed) return undefined;
    if (claimed.job.status === "blocked") return claimed.job;
    const attempt = claimed.attempt;
    if (!attempt) throw new WorkspaceServerError("workspace_learning_attempt_missing", 500);
    const reviewAbort = new AbortController();
    let rejectExecutionAbort!: (reason: unknown) => void;
    const executionAbort = new Promise<never>((_, reject) => {
      rejectExecutionAbort = reject;
    });
    const abortExecution = (reason: unknown) => {
      const error = reason instanceof Error ? reason : new WorkspaceServerError("workspace_learning_review_aborted", 499);
      reviewAbort.abort(error);
      rejectExecutionAbort(error);
    };
    const abortFromCaller = () => abortExecution(input.signal?.reason);
    if (input.signal?.aborted) abortFromCaller();
    else input.signal?.addEventListener("abort", abortFromCaller, { once: true });
    let heartbeatFailure: unknown;
    // A review can outlive a normal HTTP request. Keep its lease fresh while
    // the Backend works, but fail closed if another worker has taken it.
    const heartbeatTimer = setInterval(() => {
      if (heartbeatFailure) return;
      void this.learning.heartbeat(context, { jobId: claimed.job.id, workerId: attempt.workerId }).catch((error) => {
        heartbeatFailure = error;
        abortExecution(error);
      });
    }, 20_000);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const review = Promise.resolve().then(() => this.reviewPort.review(claimed.snapshot, { signal: reviewAbort.signal }));
      // A cassette that ignores AbortSignal must not keep a lease forever.
      // Handle its later rejection explicitly after the bounded race settles.
      void review.catch(() => undefined);
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          const error = new WorkspaceServerError("workspace_learning_review_timeout", 504);
          reviewAbort.abort(error);
          reject(error);
        }, this.reviewTimeoutMs);
      });
      const result = await Promise.race([review, timeoutPromise, executionAbort]);
      if (heartbeatFailure) throw heartbeatFailure;
      if (input.signal?.aborted) throw input.signal.reason instanceof Error ? input.signal.reason : new WorkspaceServerError("workspace_learning_review_aborted", 499);
      return this.learning.applyReview(context, {
        jobId: claimed.job.id,
        attemptId: attempt.id,
        workerId: attempt.workerId,
        result
      });
    } catch (error) {
      return this.learning.failJob(context, {
        jobId: claimed.job.id,
        attemptId: attempt.id,
        workerId: attempt.workerId,
        errorCode: error instanceof WorkspaceServerError ? error.code : "workspace_learning_backend_temporary_unavailable",
        retryable: isRetryableLearningError(error)
      });
    } finally {
      if (timeout) clearTimeout(timeout);
      clearInterval(heartbeatTimer);
      input.signal?.removeEventListener("abort", abortFromCaller);
    }
  }
}

/** Lifecycle-managed execution loop. It is intentionally given only review
 * cassettes and request-scoped context; it has no direct database, filesystem,
 * HTTP, or external-agent capability. */
export class WorkspaceLearningRunner {
  private readonly running = new Map<string, { controller: AbortController; settled: Promise<void> }>();
  private readonly delayed = new Map<string, { due: number; timer: ReturnType<typeof setTimeout> }>();
  private readonly pending = new Set<string>();
  private closed = false;
  private closing?: Promise<void>;

  constructor(
    private readonly learning: WorkspaceLearningService,
    private readonly reviewPorts: readonly WorkspaceKnowledgeReviewPort[],
    private readonly options: {
      workerIdPrefix?: string;
      maxJobsPerCycle?: number;
      reviewTimeoutMs?: number;
      onSettled?: (input: { context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">; job: WorkspaceLearningJob }) => void | Promise<void>;
      onError?: (error: unknown) => void;
    } = {}
  ) {}

  schedule(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, input: { roomId?: string } = {}): void {
    if (this.closed) return;
    const key = this.runKey(context, input);
    this.pending.add(key);
    if (this.running.has(key)) return;
    const controller = new AbortController();
    let resolveSettled!: () => void;
    const settled = new Promise<void>((resolve) => { resolveSettled = resolve; });
    this.running.set(key, { controller, settled });
    this.pending.delete(key);
    let continueImmediately = false;
    queueMicrotask(() => {
      void this.runCycle(context, input, controller.signal)
        .then((settled) => {
          continueImmediately = settled.length >= Math.min(100, Math.max(1, this.options.maxJobsPerCycle ?? 20));
        })
        .catch((error) => this.options.onError?.(error))
        .finally(() => {
          this.running.delete(key);
          resolveSettled();
          if ((continueImmediately || this.pending.has(key)) && !this.closed) this.schedule(context, input);
        });
    });
  }

  async runCycle(
    context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">,
    input: { roomId?: string } = {},
    signal?: AbortSignal
  ): Promise<WorkspaceLearningJob[]> {
    const settled: WorkspaceLearningJob[] = [];
    const maxJobs = Math.min(100, Math.max(1, this.options.maxJobsPerCycle ?? 20));
    for (let index = 0; index < maxJobs && !this.closed && !signal?.aborted; index += 1) {
      const route = await this.learning.nextDueJobConfiguration(context, input);
      if (!route) break;
      const port = route.engineId
        ? this.reviewPorts.find((candidate) => candidate.id === route.engineId && (candidate.model ?? undefined) === (route.model ?? undefined))
        : undefined;
      const workerId = scopedId("learning_runner", context.workspaceId, `${this.options.workerIdPrefix ?? "server"}:${port?.id ?? "unavailable"}:${route.roomId}`);
      const job = port
        ? await new WorkspaceLearningWorker(this.learning, port, { reviewTimeoutMs: this.options.reviewTimeoutMs }).runOne(context, {
          workerId, roomId: route.roomId, signal
        })
        : await this.claimUnavailablePort(context, { workerId, roomId: route.roomId });
      if (!job) break;
      settled.push(job);
      if (job.status === "queued") this.scheduleDelayed(context, { roomId: job.roomId }, job.nextRunAt);
      try {
        await this.options.onSettled?.({ context, job });
      } catch (error) {
        // Realtime notification is observability, not permission to abandon
        // another due Job or its retry timer.
        this.options.onError?.(error);
      }
    }
    return settled;
  }

  async close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    const active = [...this.running.values()];
    for (const { controller } of active) controller.abort(new WorkspaceServerError("workspace_learning_runner_closed", 499));
    this.running.clear();
    for (const { timer } of this.delayed.values()) clearTimeout(timer);
    this.delayed.clear();
    this.pending.clear();
    // Worker cancellation races the review call and then records a retryable
    // failure. Wait for that short persistence path before its database is
    // closed, rather than leaving a lease/reservation until it expires.
    this.closing = Promise.allSettled(active.map((entry) => entry.settled)).then(() => undefined);
    return this.closing;
  }

  private async claimUnavailablePort(
    context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">,
    input: { workerId: string; roomId: string }
  ): Promise<WorkspaceLearningJob | undefined> {
    const claimed = await this.learning.claimNextJob(context, input);
    return claimed?.job;
  }

  private runKey(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, input: { roomId?: string }): string {
    return `${context.workspaceId}\u0000${context.accountId}\u0000${input.roomId ?? "*"}`;
  }

  /** Retry wakeups remain tied to the request principal that claimed the Job.
   * They never invent a scheduler identity or bypass the next claim's RLS
   * checks after a Room membership changes. */
  private scheduleDelayed(
    context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">,
    input: { roomId?: string },
    nextRunAt: string
  ): void {
    if (this.closed) return;
    const due = new Date(nextRunAt).getTime();
    if (!Number.isFinite(due) || due <= Date.now()) {
      this.schedule(context, input);
      return;
    }
    const key = this.runKey(context, input);
    const existing = this.delayed.get(key);
    if (existing && existing.due <= due) return;
    if (existing) clearTimeout(existing.timer);
    const delay = Math.min(due - Date.now(), 2_147_483_647);
    const timer = setTimeout(() => {
      this.delayed.delete(key);
      this.schedule(context, input);
    }, delay);
    this.delayed.set(key, { due, timer });
  }
}

interface InsertResourceInput {
  id: string;
  scope: WorkspaceLearningScope;
  kind: WorkspaceLearningResourceKind;
  isAbsoluteRule: boolean;
  title: string;
  content: string;
  payload: WorkspaceRecordPayload;
  state: WorkspaceLearningResourceState;
  aiUpdateLocked: boolean;
  confidence?: number;
  sourceJobId?: string;
  sourceAttemptId?: string;
  reason: string;
  changeKind: WorkspaceLearningChangeKind;
}

async function insertResource(sql: WorkspaceSql, context: WorkspaceRequestContext, input: InsertResourceInput): Promise<WorkspaceLearningResource> {
  assertScope(input.scope);
  const saved = await sql.query<ResourceRow>(
    `INSERT INTO workspace_learning_resources(
       workspace_id, id, scope_kind, room_id, resource_kind, state, is_absolute_rule, ai_update_locked,
       confidence, source_job_id, source_attempt_id, title, content, payload, created_by, updated_by
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::JSONB, $15, $15) RETURNING *`,
    [context.workspaceId, input.id, input.scope.kind, input.scope.roomId ?? null, input.kind, input.state,
      input.isAbsoluteRule, input.aiUpdateLocked, input.confidence ?? null, input.sourceJobId ?? null, input.sourceAttemptId ?? null,
      input.title, input.content, canonicalJson(input.payload), context.accountId]
  );
  const resource = resourceFromRow(saved.rows[0]!);
  await insertVersion(sql, resource, { changeKind: input.changeKind, reason: input.reason, actorAccountId: context.accountId });
  return resource;
}

function isAutomaticCandidateState(state: WorkspaceLearningResource["state"]): boolean {
  return state === "provisional" || state === "conflict";
}

function hasAutomaticProvenance(resource: WorkspaceLearningResource): boolean {
  return Boolean(resource.sourceJobId && resource.sourceAttemptId);
}

async function updateResource(
  sql: WorkspaceSql,
  context: WorkspaceRequestContext,
  current: WorkspaceLearningResource,
  patch: Partial<Pick<WorkspaceLearningResource, "scope" | "state" | "aiUpdateLocked" | "confidence" | "sourceJobId" | "sourceAttemptId" | "title" | "content" | "payload">> & { archivedAt?: string | null; reason: string; changeKind: WorkspaceLearningChangeKind }
): Promise<WorkspaceLearningResource> {
  const scope = patch.scope ?? current.scope;
  assertScope(scope);
  const state = patch.state ?? current.state;
  const title = patch.title ?? current.title;
  const content = patch.content ?? current.content;
  const payload = patch.payload ?? current.payload;
  assertSafeLearningText(title);
  assertSafeLearningText(content);
  assertSafeLearningText(patch.reason);
  const saved = await sql.query<ResourceRow>(
    `UPDATE workspace_learning_resources
     SET scope_kind = $3, room_id = $4, state = $5, ai_update_locked = $6, confidence = $7,
         source_job_id = $8, source_attempt_id = $9, title = $10, content = $11,
         payload = $12::JSONB, version = version + 1, updated_by = $13,
         archived_at = $14::TIMESTAMPTZ, updated_at = NOW()
     WHERE workspace_id = $1 AND id = $2 AND version = $15
     RETURNING *`,
    [
      current.workspaceId, current.id, scope.kind, scope.roomId ?? null, state,
      patch.aiUpdateLocked ?? current.aiUpdateLocked, patch.confidence ?? current.confidence ?? null,
      patch.sourceJobId ?? current.sourceJobId ?? null, patch.sourceAttemptId ?? current.sourceAttemptId ?? null,
      title, content, canonicalJson(payload), context.accountId,
      patch.archivedAt === undefined ? current.archivedAt ?? null : patch.archivedAt, current.version
    ]
  );
  const row = saved.rows[0];
  if (!row) throw new WorkspaceServerError("workspace_learning_resource_version_conflict", 409, { latest_version: current.version });
  const resource = resourceFromRow(row);
  await insertVersion(sql, resource, { changeKind: patch.changeKind, reason: patch.reason, actorAccountId: context.accountId });
  return resource;
}

async function insertVersion(sql: WorkspaceSql, resource: WorkspaceLearningResource, input: { changeKind: WorkspaceLearningChangeKind; reason: string; actorAccountId: string }): Promise<void> {
  const id = scopedId("learning_version", resource.workspaceId, `${resource.id}:${resource.version}`);
  await sql.query(
    `INSERT INTO workspace_learning_resource_versions(
       workspace_id, id, resource_id, version, change_kind, scope_kind, room_id, state, ai_update_locked,
       confidence, source_job_id, source_attempt_id, title, content, payload, content_hash, reason, actor_account_id
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::JSONB, $16, $17, $18)`,
    [
      resource.workspaceId, id, resource.id, resource.version, input.changeKind, resource.scope.kind,
      resource.scope.roomId ?? null, resource.state, resource.aiUpdateLocked, resource.confidence ?? null,
      resource.sourceJobId ?? null, resource.sourceAttemptId ?? null, resource.title, resource.content,
      canonicalJson(resource.payload), learningContentHash(resource), input.reason, input.actorAccountId
    ]
  );
}

async function insertEvidence(
  sql: WorkspaceSql,
  workspaceId: string,
  resource: WorkspaceLearningResource,
  activityIds: readonly string[],
  snapshot: WorkspaceKnowledgeReviewSnapshot
): Promise<void> {
  const byId = new Map(snapshot.activities.map((activity) => [activity.id, activity]));
  for (const activityId of [...new Set(activityIds)]) {
    const activity = byId.get(activityId);
    if (!activity) throw new WorkspaceServerError("workspace_learning_review_evidence_out_of_scope", 422);
    const kind = evidenceKindFor(resource, activity);
    const id = scopedId("learning_evidence", workspaceId, `${resource.id}:${resource.version}:${activityId}:${kind}`);
    await sql.query(
      `INSERT INTO workspace_learning_evidence(workspace_id, id, resource_id, resource_version, activity_id, kind, summary)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (workspace_id, resource_id, resource_version, activity_id, kind) DO NOTHING`,
      [workspaceId, id, resource.id, resource.version, activityId, kind, (activity.resultSummary ?? activity.instructionSummary).slice(0, 20_000)]
    );
  }
}

/** A direct human change is durable provenance on its own.  It must not be
 * turned into a synthetic Room Activity (Workspace-scoped Knowledge has no
 * Room), and it must never enqueue an AI review by itself. */
async function insertHumanEditEvidence(
  sql: WorkspaceSql,
  workspaceId: string,
  resource: WorkspaceLearningResource,
  summary: string
): Promise<void> {
  const id = scopedId("learning_evidence_human_edit", workspaceId, `${resource.id}:${resource.version}`);
  await sql.query(
    `INSERT INTO workspace_learning_evidence(workspace_id, id, resource_id, resource_version, activity_id, kind, summary)
     VALUES ($1, $2, $3, $4, NULL, 'human_edit', $5)
     ON CONFLICT (workspace_id, id) DO NOTHING`,
    [workspaceId, id, resource.id, resource.version, summary.slice(0, 20_000)]
  );
}

function evidenceKindFor(
  resource: WorkspaceLearningResource,
  activity: WorkspaceKnowledgeReviewSnapshot["activities"][number]
): WorkspaceLearningEvidence["kind"] {
  const uses = activity.payload.learning_resource_uses;
  if (Array.isArray(uses) && uses.some((use) => {
    if (!use || typeof use !== "object" || Array.isArray(use)) return false;
    const row = use as Record<string, unknown>;
    return row.resource_id === resource.id
      && (row.outcome === "confirmed_success" || row.outcome === "confirmed_failure");
  })) return "use_outcome";
  if (activity.correctionOfActivityId) return "human_correction";
  if (activity.explicitRemember) return "explicit_remember";
  return "activity";
}

async function insertLink(sql: WorkspaceSql, workspaceId: string, fromResourceId: string, toResourceId: string, relation: WorkspaceLearningResourceLink["relation"]): Promise<void> {
  const id = scopedId("learning_link", workspaceId, `${fromResourceId}:${toResourceId}:${relation}`);
  await sql.query(
    `INSERT INTO workspace_learning_resource_links(workspace_id, id, from_resource_id, to_resource_id, relation)
     VALUES ($1, $2, $3, $4, $5) ON CONFLICT (workspace_id, from_resource_id, to_resource_id, relation) DO NOTHING`,
    [workspaceId, id, fromResourceId, toResourceId, relation]
  );
}

async function selectResourceForUpdate(sql: WorkspaceSql, workspaceId: string, resourceId: string): Promise<ResourceRow | undefined> {
  const result = await sql.query<ResourceRow>(
    "SELECT * FROM workspace_learning_resources WHERE workspace_id = $1 AND id = $2 FOR UPDATE",
    [workspaceId, resourceId]
  );
  return result.rows[0];
}

async function listResourcesForSearch(
  sql: WorkspaceSql,
  workspaceId: string,
  input: { kind: "workspace"; absolute: boolean } | { kind: "room"; roomId: string },
  query: string,
  limit: number
): Promise<WorkspaceLearningResource[]> {
  const result = input.kind === "workspace"
    ? await sql.query<ResourceRow>(
      `SELECT * FROM workspace_learning_resources
       WHERE workspace_id = $1 AND scope_kind = 'workspace' AND is_absolute_rule = $2 AND state NOT IN ('archived', 'conflict')
         AND ($3 = '' OR (title || ' ' || content) ILIKE '%' || $3 || '%')
       ORDER BY updated_at DESC LIMIT $4`,
      [workspaceId, input.absolute, query.trim(), limit]
    )
    : await sql.query<ResourceRow>(
      `SELECT * FROM workspace_learning_resources
       WHERE workspace_id = $1 AND scope_kind = 'room' AND room_id = $2 AND state NOT IN ('archived', 'conflict')
         AND ($3 = '' OR (title || ' ' || content) ILIKE '%' || $3 || '%')
       ORDER BY updated_at DESC LIMIT $4`,
      [workspaceId, input.roomId, query.trim(), limit]
    );
  return result.rows.map(resourceFromRow);
}

async function failExhaustedExpiredJobs(sql: WorkspaceSql, workspaceId: string, roomId?: string): Promise<void> {
  const expired = await sql.query<AttemptRow & { room_id: string }>(
    `SELECT attempt.*, job.room_id
     FROM workspace_learning_jobs job
     JOIN workspace_learning_job_attempts attempt
       ON attempt.workspace_id = job.workspace_id AND attempt.job_id = job.id
     WHERE job.workspace_id = $1 AND ($2::TEXT IS NULL OR job.room_id = $2)
       AND job.status = 'running' AND job.lease_expires_at < NOW()
       AND job.attempt_count >= job.max_attempts AND attempt.status = 'running'
     ORDER BY job.room_id, job.id FOR UPDATE OF job, attempt`,
    [workspaceId, roomId ?? null]
  );
  if (expired.rows.length === 0) return;
  const jobIds = [...new Set(expired.rows.map((row) => row.job_id))];
  for (const row of expired.rows) {
    const layers = await getSettingsLayersForRoom(sql, workspaceId, row.room_id);
    await releaseReservation(sql, workspaceId, row.room_id, layers, attemptFromRow(row).reservation);
  }
  await sql.query(
    `UPDATE workspace_learning_jobs SET status = 'failed', blocked_reason = 'workspace_learning_retry_exhausted',
       lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL, completed_at = NOW(), updated_at = NOW()
     WHERE workspace_id = $1 AND id = ANY($2::TEXT[])`,
    [workspaceId, jobIds]
  );
  await sql.query(
    `UPDATE workspace_learning_job_attempts SET status = 'failed', error_code = 'workspace_learning_retry_exhausted', completed_at = NOW()
     WHERE workspace_id = $1 AND status = 'running' AND job_id = ANY($2::TEXT[])`,
    [workspaceId, jobIds]
  );
}

/** Configuration and budget blocks are not failed model attempts.  Keeping
 * them out of attempt_count means a later operator correction can resume the
 * same grouped review instead of exhausting retry capacity without a call. */
async function blockUnclaimedJob(
  sql: WorkspaceSql,
  context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">,
  job: WorkspaceLearningJob,
  reason: string,
  settings: WorkspaceLearningSettings
): Promise<WorkspaceLearningJob> {
  const saved = await sql.query<JobRow>(
    `UPDATE workspace_learning_jobs
     SET status = 'blocked', blocked_reason = $3, lease_owner = NULL,
         lease_expires_at = NULL, heartbeat_at = NULL, engine_id = $4,
         model = $5, updated_by = $6, updated_at = NOW()
     WHERE workspace_id = $1 AND id = $2
     RETURNING *`,
    [context.workspaceId, job.id, reason, settings.engineId ?? null, settings.model ?? null, context.accountId]
  );
  return jobFromRow(saved.rows[0]!);
}

/** A human configuration change is the only automatic release path for a
 * configuration/budget block. The existing Job and its history remain; no
 * synthetic Activity and no duplicate review are created. */
async function requeueBlockedLearningJobs(
  sql: WorkspaceSql,
  context: WorkspaceRequestContext,
  scope: WorkspaceLearningScope
): Promise<number> {
  const result = await sql.query<{ id: string }>(
    `UPDATE workspace_learning_jobs
     SET status = 'queued', blocked_reason = NULL, completed_at = NULL,
         next_run_at = NOW(), updated_by = $3, updated_at = NOW()
     WHERE workspace_id = $1
       AND ($2::TEXT IS NULL OR room_id = $2)
       AND status = 'blocked'
       AND blocked_reason IN (
         'workspace_learning_disabled',
         'workspace_learning_engine_unconfigured',
         'workspace_learning_engine_port_unavailable',
         'workspace_learning_configuration_changed',
         'workspace_learning_configuration_changed_disabled',
         'workspace_learning_currency_reservation_required',
         'workspace_learning_token_reservation_required',
         'workspace_learning_currency_budget_exhausted',
         'workspace_learning_token_budget_exhausted'
       )
     RETURNING id`,
    [context.workspaceId, scope.kind === "room" ? scope.roomId! : null, context.accountId]
  );
  return result.rows.length;
}

function budgetBlockReason(layers: WorkspaceLearningSettingsLayers): string | undefined {
  for (const settings of [layers.workspace, layers.room]) {
    if (!settings) continue;
    if (settings.currencyLimit !== undefined && settings.currencyUsed + settings.currencyReserved >= settings.currencyLimit) return "workspace_learning_currency_budget_exhausted";
    if (settings.tokenLimit !== undefined && settings.tokensUsed + settings.tokensReserved >= settings.tokenLimit) return "workspace_learning_token_budget_exhausted";
  }
  return undefined;
}

function budgetExceeds(
  layers: WorkspaceLearningSettingsLayers,
  use: { currency: number; tokens: number },
  reservation: { currency: number; tokens: number }
): string | undefined {
  for (const settings of [layers.workspace, layers.room]) {
    if (!settings) continue;
    if (settings.currencyLimit !== undefined && settings.currencyUsed + Math.max(0, settings.currencyReserved - reservation.currency) + use.currency > settings.currencyLimit) return "workspace_learning_currency_budget_exhausted";
    if (settings.tokenLimit !== undefined && settings.tokensUsed + Math.max(0, settings.tokensReserved - reservation.tokens) + use.tokens > settings.tokenLimit) return "workspace_learning_token_budget_exhausted";
  }
  return undefined;
}

function normalizeReservation(input: ClaimWorkspaceLearningJobInput["reservation"]): { currency: number; tokens: number } {
  const currency = input?.currency ?? 0;
  const tokens = input?.tokens ?? 0;
  assertNonnegative(currency, "workspace_learning_reservation_invalid");
  assertNonnegativeInteger(tokens, "workspace_learning_reservation_invalid");
  return { currency, tokens };
}

function reservationBlockReason(
  layers: WorkspaceLearningSettingsLayers,
  reservation: { currency: number; tokens: number },
  supplied: ClaimWorkspaceLearningJobInput["reservation"]
): string | undefined {
  for (const settings of [layers.workspace, layers.room]) {
    if (!settings) continue;
    if (settings.currencyLimit !== undefined && supplied?.currency === undefined) return "workspace_learning_currency_reservation_required";
    if (settings.tokenLimit !== undefined && supplied?.tokens === undefined) return "workspace_learning_token_reservation_required";
    if (settings.currencyLimit !== undefined && settings.currencyUsed + settings.currencyReserved + reservation.currency > settings.currencyLimit) return "workspace_learning_currency_budget_exhausted";
    if (settings.tokenLimit !== undefined && settings.tokensUsed + settings.tokensReserved + reservation.tokens > settings.tokenLimit) return "workspace_learning_token_budget_exhausted";
  }
  return undefined;
}

function reservationExceeded(
  layers: WorkspaceLearningSettingsLayers,
  reservation: { currency: number; tokens: number },
  use: { currency: number; tokens: number }
): string | undefined {
  for (const settings of [layers.workspace, layers.room]) {
    if (!settings) continue;
    if (settings.currencyLimit !== undefined && use.currency > reservation.currency) return "workspace_learning_currency_usage_exceeds_reservation";
    if (settings.tokenLimit !== undefined && use.tokens > reservation.tokens) return "workspace_learning_token_usage_exceeds_reservation";
  }
  return undefined;
}

async function reserveSettingsLayers(
  sql: WorkspaceSql,
  workspaceId: string,
  roomId: string,
  layers: WorkspaceLearningSettingsLayers,
  reservation: { currency: number; tokens: number }
): Promise<string | undefined> {
  const block = reservationBlockReason(layers, reservation, { currency: reservation.currency, tokens: reservation.tokens });
  if (block) return block;
  await adjustLearningUsage(sql, workspaceId, roomId, reservation.currency, reservation.tokens, 0, 0);
  return undefined;
}

async function releaseReservation(
  sql: WorkspaceSql,
  workspaceId: string,
  roomId: string,
  layers: WorkspaceLearningSettingsLayers,
  reservation: { currency: number; tokens: number }
): Promise<void> {
  if (reservation.currency === 0 && reservation.tokens === 0) return;
  if (!layers.workspace && !layers.room) return;
  await adjustLearningUsage(sql, workspaceId, roomId, -reservation.currency, -reservation.tokens, 0, 0);
}

async function settleReservationAndCharge(
  sql: WorkspaceSql,
  workspaceId: string,
  roomId: string,
  layers: WorkspaceLearningSettingsLayers,
  reservation: { currency: number; tokens: number },
  use: { currency: number; tokens: number }
): Promise<void> {
  if (!layers.workspace && !layers.room) return;
  await adjustLearningUsage(sql, workspaceId, roomId, -reservation.currency, -reservation.tokens, use.currency, use.tokens);
}

/** The runtime's normal Settings policy intentionally reserves configuration
 * changes for Room managers. Usage accounting is different: an executor may
 * advance an already-configured Job, but receives only this narrow guarded SQL
 * capability rather than general Settings write access. */
async function adjustLearningUsage(
  sql: WorkspaceSql,
  workspaceId: string,
  roomId: string,
  reservedCurrencyDelta: number,
  reservedTokensDelta: number,
  usedCurrencyDelta: number,
  usedTokensDelta: number
): Promise<void> {
  await sql.query(
    "SELECT samurai_adjust_workspace_learning_usage($1, $2, $3, $4, $5, $6)",
    [workspaceId, roomId, reservedCurrencyDelta, reservedTokensDelta, usedCurrencyDelta, usedTokensDelta]
  );
}

/** Settings configuration stays manager-only. This guarded lock lets an
 * executor serialize an already-authorized Job against that configuration
 * without receiving general UPDATE access to the settings table. */
async function lockWorkspaceLearningSettings(
  sql: WorkspaceSql,
  workspaceId: string,
  roomId: string
): Promise<void> {
  await sql.query(
    "SELECT samurai_lock_workspace_learning_settings($1, $2)",
    [workspaceId, roomId]
  );
}

function assertSettingsBudgetFloor(
  previous: WorkspaceLearningSettings | undefined,
  currencyLimit: number | null,
  tokenLimit: number | null
): void {
  if (!previous) return;
  if (currencyLimit !== null && currencyLimit < previous.currencyUsed + previous.currencyReserved) {
    throw new WorkspaceServerError("workspace_learning_currency_limit_below_reserved_usage", 409);
  }
  if (tokenLimit !== null && tokenLimit < previous.tokensUsed + previous.tokensReserved) {
    throw new WorkspaceServerError("workspace_learning_token_limit_below_reserved_usage", 409);
  }
}

function assertRemoveSettingsOverrideInput(input: UpdateWorkspaceLearningSettingsInput): void {
  if (input.scope.kind !== "room"
    || input.enabled !== undefined
    || input.engineId !== undefined
    || input.model !== undefined
    || input.secretRef !== undefined
    || input.currencyLimit !== undefined
    || input.tokenLimit !== undefined
    || input.clearEngineId === true
    || input.clearModel === true
    || input.clearSecretRef === true
    || input.clearCurrencyLimit === true
    || input.clearTokenLimit === true) {
    throw new WorkspaceServerError("workspace_learning_settings_override_remove_invalid", 400);
  }
}

/** A new Room/Workspace settings layer would otherwise appear halfway through
 * an attempt that reserved only the layers visible at claim time. Lock queued
 * candidates as well as reject running ones, so a concurrent claim either
 * sees the new layer or the configuration change waits for the attempt. */
async function assertNewSettingsScopeIsNotRunning(
  sql: WorkspaceSql,
  workspaceId: string,
  scope: WorkspaceLearningScope
): Promise<void> {
  const jobs = await sql.query<Pick<JobRow, "status">>(
    `SELECT status FROM workspace_learning_jobs
     WHERE workspace_id = $1
       AND ($2::TEXT IS NULL OR room_id = $2)
       AND status IN ('queued', 'running')
     FOR UPDATE`,
    [workspaceId, scope.kind === "room" ? scope.roomId! : null]
  );
  if (jobs.rows.some((job) => job.status === "running")) {
    throw new WorkspaceServerError("workspace_learning_settings_scope_busy", 409);
  }
}

/** Shared by normal claims and expired-lease recovery.  This deliberately
 * reads only the Workspace and current Room layers; it never broadens Room
 * visibility while returning an effective configuration. */
async function getSettingsLayersForRoom(
  sql: WorkspaceSql,
  workspaceId: string,
  roomId: string
): Promise<WorkspaceLearningSettingsLayers> {
  await lockWorkspaceLearningSettings(sql, workspaceId, roomId);
  const result = await sql.query<SettingsRow>(
    `SELECT * FROM workspace_learning_settings
     WHERE workspace_id = $1 AND ((scope_kind = 'room' AND room_id = $2) OR scope_kind = 'workspace')
     ORDER BY CASE scope_kind WHEN 'room' THEN 0 ELSE 1 END`,
    [workspaceId, roomId]
  );
  const room = result.rows.find((row) => row.scope_kind === "room");
  const workspace = result.rows.find((row) => row.scope_kind === "workspace");
  const roomSettings = room ? settingsFromRow(room) : undefined;
  const workspaceSettings = workspace ? settingsFromRow(workspace) : undefined;
  if (roomSettings || workspaceSettings) {
    const preferred = roomSettings ?? workspaceSettings!;
    const engineId = roomSettings?.engineId ?? workspaceSettings?.engineId;
    const model = roomSettings?.model ?? workspaceSettings?.model;
    const secretRef = roomSettings?.secretRef ?? workspaceSettings?.secretRef;
    const currencyLimit = roomSettings?.currencyLimit ?? workspaceSettings?.currencyLimit;
    const tokenLimit = roomSettings?.tokenLimit ?? workspaceSettings?.tokenLimit;
    return {
      ...(workspaceSettings ? { workspace: workspaceSettings } : {}),
      ...(roomSettings ? { room: roomSettings } : {}),
      effective: {
        ...preferred,
        enabled: roomSettings?.enabled ?? workspaceSettings?.enabled ?? true,
        ...(engineId !== undefined ? { engineId } : {}),
        ...(model !== undefined ? { model } : {}),
        ...(secretRef !== undefined ? { secretRef } : {}),
        ...(currencyLimit !== undefined ? { currencyLimit } : {}),
        ...(tokenLimit !== undefined ? { tokenLimit } : {})
      }
    };
  }
  return {
    effective: {
      workspaceId,
      id: settingsId({ kind: "workspace" }),
      scope: { kind: "workspace" },
      enabled: true,
      currencyUsed: 0,
      tokensUsed: 0,
      currencyReserved: 0,
      tokensReserved: 0,
      version: 0,
      updatedBy: "",
      updatedAt: new Date(0).toISOString()
    }
  };
}

function normalizeUsage(input: WorkspaceKnowledgeReviewResult["usage"] | undefined): { currency: number; tokens: number } {
  const currency = input?.currency ?? 0;
  const tokens = input?.tokens ?? 0;
  assertNonnegative(currency, "workspace_learning_usage_invalid");
  assertNonnegativeInteger(tokens, "workspace_learning_usage_invalid");
  return { currency, tokens };
}

function validateActivityInput(input: IngestWorkspaceLearningActivityInput): void {
  assertOpaqueId(input.roomId, "room_id_invalid");
  assertOpaqueId(input.groupKey, "workspace_learning_group_key_invalid");
  if (!input.sourceKind.trim() || input.sourceKind.length > 256) throw new WorkspaceServerError("workspace_learning_activity_source_invalid", 400);
  assertSafeLearningText(input.sourceKind);
  if (input.sourceId) {
    assertOpaqueId(input.sourceId, "workspace_learning_activity_source_id_invalid");
    assertSafeLearningText(input.sourceId);
  }
  if (input.correctionOfActivityId) assertOpaqueId(input.correctionOfActivityId, "workspace_learning_activity_correction_id_invalid");
  assertSafeLearningText(input.instructionSummary);
  if (input.resultSummary) assertSafeLearningText(input.resultSummary);
  assertSafeLearningPayload(input.payload);
  if (!activityOutcomes.has(input.outcome) || !verificationStates.has(input.verificationState) || !failureStates.has(input.failureState)) {
    throw new WorkspaceServerError("workspace_learning_activity_state_invalid", 400);
  }
  if (input.failureState === "resolved" && input.outcome !== "completed") {
    throw new WorkspaceServerError("workspace_learning_recovery_requires_completion", 400);
  }
}

function activityPayload(input: IngestWorkspaceLearningActivityInput): WorkspaceRecordPayload {
  return {
    ...(input.payload ?? {}),
    finalized_resource: input.finalizedResource === true,
    reusable_completion: input.reusableCompletion === true
  };
}

function payloadBoolean(payload: WorkspaceRecordPayload, key: string): boolean {
  return payload[key] === true;
}

function emptySnapshot(workspaceId: string, roomId: string): WorkspaceKnowledgeReviewSnapshot {
  return { workspaceId, roomId, activities: [], workspaceRules: [], workspaceKnowledge: [], roomKnowledge: [] };
}

function assertClearSettingsInput(input: UpdateWorkspaceLearningSettingsInput): void {
  const pairs: Array<[boolean | undefined, unknown]> = [
    [input.clearEngineId, input.engineId],
    [input.clearModel, input.model],
    [input.clearSecretRef, input.secretRef],
    [input.clearCurrencyLimit, input.currencyLimit],
    [input.clearTokenLimit, input.tokenLimit]
  ];
  if (pairs.some(([clear, value]) => clear === true && value !== undefined)) {
    throw new WorkspaceServerError("workspace_learning_settings_clear_conflict", 400);
  }
  if (input.removeOverride && (input.scope.kind !== "room" || input.enabled !== undefined || pairs.some(([clear, value]) => clear || value !== undefined))) {
    throw new WorkspaceServerError("workspace_learning_settings_override_remove_invalid", 400);
  }
}

function assertScope(scope: WorkspaceLearningScope): void {
  if (!scope || (scope.kind !== "workspace" && scope.kind !== "room")) throw new WorkspaceServerError("workspace_learning_scope_invalid", 400);
  if (scope.kind === "room") {
    if (!scope.roomId) throw new WorkspaceServerError("workspace_learning_room_scope_requires_room", 400);
    assertOpaqueId(scope.roomId, "room_id_invalid");
  } else if (scope.roomId !== undefined) {
    throw new WorkspaceServerError("workspace_learning_workspace_scope_forbids_room", 400);
  }
}

function assertExpectedVersion(value: number, minimum = 1): void {
  if (!Number.isSafeInteger(value) || value < minimum) throw new WorkspaceServerError("workspace_learning_resource_expected_version_invalid", 400);
}

function assertNonnegative(value: number | undefined, code: string): void {
  if (value !== undefined && (!Number.isFinite(value) || value < 0)) throw new WorkspaceServerError(code, 400);
}

function assertNonnegativeInteger(value: number | undefined, code: string): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) throw new WorkspaceServerError(code, 400);
}

function boundedLimit(value: number | undefined): number {
  if (value === undefined) return 100;
  if (!Number.isSafeInteger(value) || value < 1 || value > 500) throw new WorkspaceServerError("workspace_learning_limit_invalid", 400);
  return value;
}

async function assertWorkspaceWritable(sql: WorkspaceSql, workspaceId: string): Promise<void> {
  const result = await sql.query<{ state: string }>("SELECT state FROM workspaces WHERE id = $1", [workspaceId]);
  if (!result.rows[0]) throw new WorkspaceServerError("workspace_not_found", 404);
  if (result.rows[0].state !== "active") throw new WorkspaceServerError("workspace_read_only", 409);
}

function scopedId(prefix: string, workspaceId: string, value: string): string {
  return `${prefix}_${createHash("sha256").update(`${workspaceId}\u0000${value}`).digest("hex").slice(0, 40)}`;
}

function settingsId(scope: WorkspaceLearningScope): string {
  return scope.kind === "workspace" ? "workspace" : `room:${scope.roomId}`;
}

function snapshotHash(value: WorkspaceKnowledgeReviewSnapshot): string {
  return hashJson(value);
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function reviewResultPayload(result: WorkspaceKnowledgeReviewResult): WorkspaceRecordPayload {
  return { reviewer: result.reviewer, summary: result.summary, mutations: result.mutations as unknown as WorkspaceRecordPayload["mutations"] };
}

interface ActivityRow {
  workspace_id: string;
  room_id: string;
  id: string;
  group_key: string;
  principal_account_id: string;
  source_kind: string;
  source_id: string | null;
  correction_of_activity_id: string | null;
  instruction_summary: string;
  result_summary: string | null;
  outcome: WorkspaceLearningActivityOutcome;
  verification_state: WorkspaceLearningVerificationState;
  failure_state: WorkspaceLearningFailureState;
  explicit_remember: boolean;
  payload: WorkspaceRecordPayload | string;
  created_at: Date | string;
  finalized_at: Date | string;
}

interface ResourceRow {
  workspace_id: string;
  id: string;
  scope_kind: WorkspaceLearningScope["kind"];
  room_id: string | null;
  resource_kind: WorkspaceLearningResourceKind;
  state: WorkspaceLearningResourceState;
  is_absolute_rule: boolean;
  ai_update_locked: boolean;
  confidence: number | string | null;
  source_job_id: string | null;
  source_attempt_id: string | null;
  title: string;
  content: string;
  payload: WorkspaceRecordPayload | string;
  version: number | string;
  created_by: string;
  updated_by: string;
  archived_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface ResourceVersionRow {
  workspace_id: string;
  id: string;
  resource_id: string;
  version: number | string;
  change_kind: WorkspaceLearningChangeKind;
  scope_kind: WorkspaceLearningScope["kind"];
  room_id: string | null;
  state: WorkspaceLearningResourceState;
  ai_update_locked: boolean;
  confidence: number | string | null;
  source_job_id: string | null;
  source_attempt_id: string | null;
  title: string;
  content: string;
  payload: WorkspaceRecordPayload | string;
  content_hash: string;
  reason: string;
  actor_account_id: string;
  created_at: Date | string;
}

interface EvidenceRow {
  workspace_id: string;
  id: string;
  resource_id: string;
  resource_version: number | string;
  activity_id: string | null;
  kind: WorkspaceLearningEvidence["kind"];
  summary: string;
  created_at: Date | string;
}

interface ResourceUseRow {
  workspace_id: string;
  id: string;
  resource_id: string;
  resource_version: number | string;
  activity_id: string;
  outcome: WorkspaceLearningResourceUse["outcome"];
  supersedes_use_id: string | null;
  summary: string;
  created_at: Date | string;
}

interface JobRow {
  workspace_id: string;
  room_id: string;
  id: string;
  kind: WorkspaceLearningJob["kind"];
  status: WorkspaceLearningJob["status"];
  priority: WorkspaceLearningJob["priority"];
  group_key: string;
  high_watermark_activity_id: string;
  next_run_at: Date | string;
  attempt_count: number | string;
  max_attempts: number | string;
  lease_owner: string | null;
  lease_expires_at: Date | string | null;
  heartbeat_at: Date | string | null;
  blocked_reason: string | null;
  engine_id: string | null;
  model: string | null;
  created_by: string;
  updated_by: string;
  created_at: Date | string;
  updated_at: Date | string;
  completed_at: Date | string | null;
}

interface AttemptRow {
  workspace_id: string;
  id: string;
  job_id: string;
  attempt_no: number | string;
  worker_id: string;
  engine_id: string | null;
  model: string | null;
  status: WorkspaceLearningJobAttempt["status"];
  input_hash: string;
  output_hash: string | null;
  output: WorkspaceRecordPayload | string | null;
  error_code: string | null;
  currency_used: number | string;
  tokens_used: number | string;
  reserved_currency: number | string;
  reserved_tokens: number | string;
  started_at: Date | string;
  completed_at: Date | string | null;
}

interface SettingsRow {
  workspace_id: string;
  id: string;
  scope_kind: WorkspaceLearningScope["kind"];
  room_id: string | null;
  enabled: boolean;
  engine_id: string | null;
  model: string | null;
  secret_ref: string | null;
  currency_limit: number | string | null;
  token_limit: number | string | null;
  currency_used: number | string;
  tokens_used: number | string;
  currency_reserved: number | string;
  tokens_reserved: number | string;
  version: number | string;
  updated_by: string;
  updated_at: Date | string;
}

function activityFromRow(row: ActivityRow): WorkspaceLearningActivity {
  return {
    workspaceId: row.workspace_id, roomId: row.room_id, id: row.id, groupKey: row.group_key,
    principalAccountId: row.principal_account_id, sourceKind: row.source_kind,
    ...(row.source_id ? { sourceId: row.source_id } : {}),
    ...(row.correction_of_activity_id ? { correctionOfActivityId: row.correction_of_activity_id } : {}),
    instructionSummary: row.instruction_summary,
    ...(row.result_summary ? { resultSummary: row.result_summary } : {}),
    outcome: row.outcome, verificationState: row.verification_state, failureState: row.failure_state,
    explicitRemember: row.explicit_remember, payload: jsonObject(row.payload),
    createdAt: iso(row.created_at), finalizedAt: iso(row.finalized_at)
  };
}

function resourceFromRow(row: ResourceRow): WorkspaceLearningResource {
  return {
    workspaceId: row.workspace_id, id: row.id,
    scope: row.scope_kind === "room" ? { kind: "room", roomId: row.room_id! } : { kind: "workspace" },
    kind: row.resource_kind, state: row.state, isAbsoluteRule: row.is_absolute_rule,
    aiUpdateLocked: row.ai_update_locked,
    ...(row.confidence === null ? {} : { confidence: Number(row.confidence) }),
    ...(row.source_job_id ? { sourceJobId: row.source_job_id } : {}),
    ...(row.source_attempt_id ? { sourceAttemptId: row.source_attempt_id } : {}),
    title: row.title, content: row.content, payload: jsonObject(row.payload),
    version: Number(row.version), createdBy: row.created_by, updatedBy: row.updated_by,
    ...(row.archived_at ? { archivedAt: iso(row.archived_at) } : {}),
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at)
  };
}

function versionFromRow(row: ResourceVersionRow): WorkspaceLearningResourceVersion {
  return {
    workspaceId: row.workspace_id, id: row.id, resourceId: row.resource_id, version: Number(row.version),
    changeKind: row.change_kind,
    scope: row.scope_kind === "room" ? { kind: "room", roomId: row.room_id! } : { kind: "workspace" },
    state: row.state, aiUpdateLocked: row.ai_update_locked,
    ...(row.confidence === null ? {} : { confidence: Number(row.confidence) }),
    ...(row.source_job_id ? { sourceJobId: row.source_job_id } : {}),
    ...(row.source_attempt_id ? { sourceAttemptId: row.source_attempt_id } : {}),
    title: row.title, content: row.content,
    payload: jsonObject(row.payload), contentHash: row.content_hash, reason: row.reason,
    actorAccountId: row.actor_account_id, createdAt: iso(row.created_at)
  };
}

function evidenceFromRow(row: EvidenceRow): WorkspaceLearningEvidence {
  return {
    workspaceId: row.workspace_id, id: row.id, resourceId: row.resource_id,
    resourceVersion: Number(row.resource_version), ...(row.activity_id ? { activityId: row.activity_id } : {}), kind: row.kind,
    summary: row.summary, createdAt: iso(row.created_at)
  };
}

function resourceUseFromRow(row: ResourceUseRow): WorkspaceLearningResourceUse {
  return {
    workspaceId: row.workspace_id,
    id: row.id,
    resourceId: row.resource_id,
    resourceVersion: Number(row.resource_version),
    activityId: row.activity_id,
    outcome: row.outcome,
    ...(row.supersedes_use_id ? { supersedesUseId: row.supersedes_use_id } : {}),
    summary: row.summary,
    createdAt: iso(row.created_at)
  };
}

function jobFromRow(row: JobRow): WorkspaceLearningJob {
  return {
    workspaceId: row.workspace_id, roomId: row.room_id, id: row.id, kind: row.kind, status: row.status,
    priority: row.priority, groupKey: row.group_key, highWatermarkActivityId: row.high_watermark_activity_id,
    nextRunAt: iso(row.next_run_at), attemptCount: Number(row.attempt_count), maxAttempts: Number(row.max_attempts),
    ...(row.lease_owner ? { leaseOwner: row.lease_owner } : {}),
    ...(row.lease_expires_at ? { leaseExpiresAt: iso(row.lease_expires_at) } : {}),
    ...(row.heartbeat_at ? { heartbeatAt: iso(row.heartbeat_at) } : {}),
    ...(row.blocked_reason ? { blockedReason: row.blocked_reason } : {}),
    ...(row.engine_id ? { engineId: row.engine_id } : {}), ...(row.model ? { model: row.model } : {}),
    createdBy: row.created_by, updatedBy: row.updated_by, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
    ...(row.completed_at ? { completedAt: iso(row.completed_at) } : {})
  };
}

function attemptFromRow(row: AttemptRow): WorkspaceLearningJobAttempt {
  return {
    workspaceId: row.workspace_id, id: row.id, jobId: row.job_id, attemptNo: Number(row.attempt_no),
    workerId: row.worker_id, ...(row.engine_id ? { engineId: row.engine_id } : {}), ...(row.model ? { model: row.model } : {}),
    status: row.status, inputHash: row.input_hash, ...(row.output_hash ? { outputHash: row.output_hash } : {}),
    ...(row.output ? { output: jsonObject(row.output) } : {}), ...(row.error_code ? { errorCode: row.error_code } : {}),
    usage: { currency: Number(row.currency_used), tokens: Number(row.tokens_used) },
    reservation: { currency: Number(row.reserved_currency), tokens: Number(row.reserved_tokens) }, startedAt: iso(row.started_at),
    ...(row.completed_at ? { completedAt: iso(row.completed_at) } : {})
  };
}

function settingsFromRow(row: SettingsRow): WorkspaceLearningSettings {
  return {
    workspaceId: row.workspace_id, id: row.id,
    scope: row.scope_kind === "room" ? { kind: "room", roomId: row.room_id! } : { kind: "workspace" },
    enabled: row.enabled, ...(row.engine_id ? { engineId: row.engine_id } : {}), ...(row.model ? { model: row.model } : {}),
    ...(row.secret_ref ? { secretRef: row.secret_ref } : {}),
    ...(row.currency_limit === null ? {} : { currencyLimit: Number(row.currency_limit) }),
    ...(row.token_limit === null ? {} : { tokenLimit: Number(row.token_limit) }),
    currencyUsed: Number(row.currency_used), tokensUsed: Number(row.tokens_used),
    currencyReserved: Number(row.currency_reserved), tokensReserved: Number(row.tokens_reserved), version: Number(row.version),
    updatedBy: row.updated_by, updatedAt: iso(row.updated_at)
  };
}

function jsonObject(value: WorkspaceRecordPayload | string): WorkspaceRecordPayload {
  if (typeof value === "string") {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new WorkspaceServerError("workspace_learning_json_invalid", 500);
    return parsed as WorkspaceRecordPayload;
  }
  return value;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
