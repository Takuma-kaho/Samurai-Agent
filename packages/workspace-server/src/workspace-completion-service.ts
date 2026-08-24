import { createHash } from "node:crypto";
import { canonicalJson, isTrustedWorkspaceCaller, isTrustedWorkspaceCallerForAccount } from "./auth";
import { assertOpaqueId } from "./config";
import { WorkspaceServerError } from "./errors";
import {
  completionResourcePath,
  completionSkillSupportPath,
  assertSkillSupportRelativePath,
  parseWorkspaceCompletionDocument,
  renderWorkspaceCompletionDocument,
  WorkspaceCompletionFileService,
  type StagedWorkspaceCompletionFileBatch
} from "./workspace-completion-files";
import {
  assertCompletionResourceAxes,
  classifyWorkspaceCompletionActivity,
  containsWorkspaceCompletionSecret,
  evaluateWorkspaceCompletionPolicies,
  validateWorkspaceCompletionReviewResult,
  validateWorkspaceCompletionPolicyRules,
  validateWorkspaceCompletionTuning,
  type WorkspaceCompletionPolicyEvaluationInput,
  type WorkspaceCompletionReviewCandidate,
  type WorkspaceCompletionReviewResult,
  type WorkspaceCompletionReviewSnapshot
} from "./workspace-completion-policy";
import { WorkspaceServerStore } from "./workspace-server-store";
import type { WorkspaceSql } from "./postgres";
import type {
  WorkspaceCompletionActivity,
  WorkspaceCompletionActivityOutcome,
  WorkspaceCompletionAiProtection,
  WorkspaceCompletionAttestation,
  WorkspaceCompletionAttestationPort,
  WorkspaceCompletionAttestationRequest,
  WorkspaceCompletionAttestationResult,
  WorkspaceCompletionConfiguration,
  WorkspaceCompletionCreationSource,
  WorkspaceCompletionEpisode,
  WorkspaceCompletionEpisodeOutcome,
  WorkspaceCompletionEvidence,
  WorkspaceCompletionEvidenceState,
  WorkspaceCompletionEvaluation,
  WorkspaceCompletionFailureState,
  WorkspaceCompletionJob,
  WorkspaceCompletionKnowledgeKind,
  WorkspaceCompletionLifecycleState,
  WorkspaceCompletionPolicyOperation,
  WorkspaceCompletionPolicyChangeRequest,
  WorkspaceCompletionPolicyRule,
  WorkspaceCompletionResource,
  WorkspaceCompletionResourceLink,
  WorkspaceCompletionResourceKind,
  WorkspaceCompletionResourceVersion,
  WorkspaceCompletionScope,
  WorkspaceCompletionSkillFile,
  WorkspaceCompletionTuning,
  WorkspaceCompletionUseEvent,
  WorkspaceCompletionVerificationState
} from "./workspace-completion-types";
import type {
  WorkspaceRecordPayload,
  WorkspaceRequestContext
} from "./types";

const completionResourceKinds = new Set<WorkspaceCompletionResourceKind>(["knowledge", "skill", "policy"]);
const completionKnowledgeKinds = new Set<WorkspaceCompletionKnowledgeKind>(["fact", "decision", "explanation", "experience_rule"]);
const activityOutcomes = new Set<WorkspaceCompletionActivityOutcome>(["completed", "failed", "cancelled", "unknown"]);
const verificationStates = new Set<WorkspaceCompletionVerificationState>(["confirmed", "failed", "not_run", "unknown"]);
const failureStates = new Set<WorkspaceCompletionFailureState>(["none", "resolved", "unresolved"]);
const useEvents = new Set<WorkspaceCompletionUseEvent["event"]>(["selected", "body_loaded", "support_loaded", "actually_used", "outcome", "correction"]);
const useOutcomes = new Set<NonNullable<WorkspaceCompletionUseEvent["outcome"]>>(["confirmed_success", "confirmed_failure", "unknown"]);
const maxPage = 100;

/** Stable, opaque pagination for API collections.  The cursor only carries
 * the last visible identifier; authorization is always reevaluated by the
 * query and never encoded into it. */
export interface WorkspaceCompletionPage<T> {
  items: readonly T[];
  nextCursor?: string;
}

export interface WorkspaceCompletionResourceInput {
  id?: string;
  scope: WorkspaceCompletionScope;
  kind: "knowledge" | "skill";
  knowledgeKind?: WorkspaceCompletionKnowledgeKind;
  title: string;
  content: string;
  metadata: WorkspaceRecordPayload;
  reason: string;
  expectedVersion?: number;
  aiManaged?: boolean;
  /** Full optional package contents beyond SKILL.md.  A Skill update stages
   * every listed file with the main document in one batch. */
  supportFiles?: readonly WorkspaceCompletionSkillSupportInput[];
  /** Required for an AI proposal. The review validator only permits IDs from
   * the selected Episode snapshot, so a model cannot invent provenance. */
  evidenceActivityIds?: readonly string[];
  evidenceEpisodeId?: string;
}

export interface WorkspaceCompletionSkillSupportInput {
  path: string;
  content: Uint8Array;
}

export interface WorkspaceCompletionActivityInput {
  id?: string;
  roomId: string;
  episodeId?: string;
  goal?: string;
  sourceApp: string;
  sourceId?: string;
  externalEpisodeKey?: string;
  correctionOfActivityId?: string;
  /** An external operation/run identifier, not a Session foreign key. */
  operationId?: string;
  instructionSummary: string;
  resultSummary?: string;
  changedResources?: readonly string[];
  verificationOutcome: WorkspaceCompletionVerificationState;
  failureState: WorkspaceCompletionFailureState;
  outcome: WorkspaceCompletionActivityOutcome;
  explicitRemember?: boolean;
  payload?: WorkspaceRecordPayload;
  sessionRef?: WorkspaceCompletionActivity["sessionRef"];
}

export interface WorkspaceCompletionPolicyInput {
  id?: string;
  scope: WorkspaceCompletionScope;
  title: string;
  content: string;
  rules: unknown;
  reason: string;
  expectedVersion?: number;
  enabled?: boolean;
}

interface TrustedHumanPolicyApproval {
  principalAccountId: string;
  requestId: string;
  operationId: string;
  timestamp: string;
  requestTimestamp: string;
  canonicalPayloadHash: string;
  signature: string;
}

export interface WorkspaceCompletionPolicyChangeRequestInput {
  id?: string;
  roomId: string;
  summary: string;
  proposedRules: unknown;
  sourceJobId?: string;
}

export interface WorkspaceCompletionResourceWriteResult {
  resource: WorkspaceCompletionResource;
  replayed: boolean;
}

export interface WorkspaceCompletionActivityResult {
  activity: WorkspaceCompletionActivity;
  episode: WorkspaceCompletionEpisode;
  job?: WorkspaceCompletionJob;
  /** A deterministic evaluation is queued separately from Review.  It may
   * legitimately complete without a row when this Episode never recorded an
   * `actually_used` event. */
  evaluationJob?: WorkspaceCompletionJob;
  eligible: boolean;
  reasons: readonly string[];
  replayed: boolean;
}

/** No request body accepts an attestor ID, provider response, or credential
 * as a substitute. The Host supplies the cassette during Server setup. */
export interface ApplyWorkspaceCompletionAttestationInput {
  request: WorkspaceCompletionAttestationRequest;
}

export interface WorkspaceCompletionReadResource {
  resource: WorkspaceCompletionResource;
  version: WorkspaceCompletionResourceVersion;
}

/** The file editor is intentionally an opt-in Self-host workflow.  The
 * importing owner is recorded as the operator, while `physical_file_import`
 * makes clear that the original editor could not be identified from a local
 * filesystem write. */
export interface WorkspaceCompletionPhysicalImportStatus {
  resource: WorkspaceCompletionResource;
  version: WorkspaceCompletionResourceVersion;
  changed: boolean;
  physicalHash: string;
  changedSupportPaths: readonly string[];
}

export interface WorkspaceCompletionStartupContext {
  profile?: string;
  soul?: string;
  policy: { allowed: boolean; required: readonly string[]; deniedBy: readonly string[] };
}

export interface ApplyWorkspaceCompletionReviewInput {
  snapshot: WorkspaceCompletionReviewSnapshot;
  result: WorkspaceCompletionReviewResult;
  /** Present only when a leased Job worker closes its Attempt. */
  jobId?: string;
  attemptId?: string;
  workerId?: string;
}

interface BatchResult<T> {
  result: T;
  batchId: string;
}

/**
 * The productized Server 04 write facade.  It owns the boundary between
 * human-readable files and PostgreSQL metadata; callers never receive a DB
 * copy of Knowledge, Skill, or Policy bodies.
 */
export class WorkspaceCompletionService {
  readonly files: WorkspaceCompletionFileService;

  constructor(
    readonly store: WorkspaceServerStore,
    files = new WorkspaceCompletionFileService(store.storageRoot),
    /** Host-owned cassette; it cannot be chosen by an HTTP request. */
    private readonly attestationPort?: WorkspaceCompletionAttestationPort
  ) {
    this.files = files;
  }

  async ingestActivity(context: WorkspaceRequestContext, input: WorkspaceCompletionActivityInput): Promise<WorkspaceCompletionActivityResult> {
    validateActivityInput(input);
    const activityId = input.id ?? completionId("completion_activity", context.workspaceId, context.operationId);
    assertCompletionId(activityId, "workspace_completion_activity_id_invalid");
    const payload = input.payload ?? {};
    const eligibility = classifyWorkspaceCompletionActivity({
      outcome: input.outcome,
      verificationOutcome: input.verificationOutcome,
      failureState: input.failureState,
      explicitRemember: input.explicitRemember === true,
      correctionOfActivityId: input.correctionOfActivityId,
      payload
    });
    const saved = await this.store.runIdempotentResult(context, {
      action: "workspace.completion.activity.ingest",
      input: { ...input, id: activityId }
    }, async (sql) => {
      await this.assertPolicyAllowed(sql, context, input.roomId, "activity.ingest", "execute", { source_app: input.sourceApp });
      const episode = await this.resolveEpisodeForActivity(sql, context, input, activityId);
      const inserted = await sql.query<ActivityRow>(
        `INSERT INTO workspace_completion_activities(
           workspace_id, room_id, id, principal_account_id, source_app, source_id,
           external_episode_key, correction_of_activity_id, operation_id,
           instruction_summary, result_summary, changed_resources, verification_outcome,
           failure_state, outcome, explicit_remember, payload, session_ref
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::JSONB, $13, $14, $15, $16, $17::JSONB, $18::JSONB)
         RETURNING *`,
        [
          context.workspaceId, input.roomId, activityId, context.accountId, input.sourceApp.trim(), input.sourceId ?? null,
          input.externalEpisodeKey ?? null, input.correctionOfActivityId ?? null, input.operationId ?? null,
          input.instructionSummary.trim(), input.resultSummary?.trim() || null, canonicalJson([...(input.changedResources ?? [])]),
          input.verificationOutcome, input.failureState, input.outcome, input.explicitRemember === true,
          canonicalJson(payload), input.sessionRef ? canonicalJson(input.sessionRef) : null
        ]
      );
      const activity = activityFromRow(inserted.rows[0]!);
      await sql.query(
        `INSERT INTO workspace_completion_episode_activities(workspace_id, episode_id, activity_id, relation)
         VALUES ($1, $2, $3, $4)`,
        [context.workspaceId, episode.id, activity.id, episodeRelationFor(input)]
      );
      let job: WorkspaceCompletionJob | undefined;
      if (eligibility.eligible) {
        job = await this.enqueueReviewJob(sql, context, episode, activity, eligibility.priority === "high");
      }
      const evaluationJob = isEvaluationActivity(activity)
        ? await this.enqueueEvaluationJob(sql, context, episode, activity, activity.id)
        : undefined;
      await this.store.insertAudit(sql, context, {
        action: "workspace.completion.activity.ingest",
        roomId: activity.roomId,
        subjectKind: "completion_activity",
        subjectId: activity.id,
        afterVersion: 1,
        details: {
          episode_id: episode.id,
          eligible: eligibility.eligible,
          reasons: [...eligibility.reasons],
          ...(job ? { job_id: job.id } : {}),
          ...(evaluationJob ? { evaluation_job_id: evaluationJob.id } : {})
        }
      });
      return {
        activity,
        episode,
        ...(job ? { job } : {}),
        ...(evaluationJob ? { evaluationJob } : {}),
        eligible: eligibility.eligible,
        reasons: eligibility.reasons
      };
    });
    return { ...saved.value, replayed: saved.replayed };
  }

  async getActivity(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, activityId: string): Promise<WorkspaceCompletionActivity> {
    assertCompletionId(activityId, "workspace_completion_activity_id_invalid");
    return this.store.database.withContext(context, async (sql) => {
      const found = await sql.query<ActivityRow>(
        "SELECT * FROM workspace_completion_activities WHERE workspace_id = $1 AND id = $2",
        [context.workspaceId, activityId]
      );
      if (!found.rows[0]) throw new WorkspaceServerError("workspace_completion_activity_not_found", 404);
      return activityFromRow(found.rows[0]);
    });
  }

  async listActivityEvidence(
    context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">,
    activityId: string,
    limit?: number
  ): Promise<WorkspaceCompletionEvidence[]> {
    await this.getActivity(context, activityId);
    return this.store.database.withContext(context, async (sql) => {
      const rows = await sql.query<EvidenceRow>(
        `SELECT * FROM workspace_completion_evidence
         WHERE workspace_id = $1 AND activity_id = $2
         ORDER BY created_at DESC, id DESC LIMIT $3`,
        [context.workspaceId, activityId, boundedLimit(limit)]
      );
      return rows.rows.map(evidenceFromRow);
    });
  }

  async listActivities(
    context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">,
    input: { roomId: string; activityId?: string; sourceApp?: string; sourceId?: string; outcome?: string; limit?: number; offset?: number }
  ): Promise<WorkspaceCompletionActivity[]> {
    assertOpaqueId(input.roomId, "room_id_invalid");
    const offset = input.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new WorkspaceServerError("workspace_completion_activity_offset_invalid", 400);
    return this.store.database.withContext(context, async (sql) => {
      const result = await sql.query<ActivityRow>(
        `SELECT * FROM workspace_completion_activities
         WHERE workspace_id = $1 AND room_id = $2
           AND ($3::TEXT IS NULL OR id = $3)
           AND ($4::TEXT IS NULL OR source_app = $4)
           AND ($5::TEXT IS NULL OR source_id = $5)
           AND ($6::TEXT IS NULL OR outcome = $6)
         ORDER BY finalized_at DESC, id DESC LIMIT $7 OFFSET $8`,
        [context.workspaceId, input.roomId, input.activityId ?? null, input.sourceApp ?? null, input.sourceId ?? null, input.outcome ?? null, boundedLimit(input.limit), offset]
      );
      return result.rows.map(activityFromRow);
    });
  }

  async createEpisode(context: WorkspaceRequestContext, input: { id?: string; roomId: string; goal: string; sourceApp?: string; externalEpisodeKey?: string; sessionRef?: WorkspaceCompletionEpisode["sessionRef"] }): Promise<{ episode: WorkspaceCompletionEpisode; replayed: boolean }> {
    assertOpaqueId(input.roomId, "room_id_invalid");
    assertSafeText(input.goal, "workspace_completion_episode_goal_invalid");
    if (input.sourceApp !== undefined) assertSafeText(input.sourceApp, "workspace_completion_episode_source_invalid");
    if (input.externalEpisodeKey !== undefined) assertCompletionId(input.externalEpisodeKey, "workspace_completion_external_episode_key_invalid");
    const id = input.id ?? completionId("completion_episode", context.workspaceId, context.operationId);
    assertCompletionId(id, "workspace_completion_episode_id_invalid");
    const saved = await this.store.runIdempotentResult(context, {
      action: "workspace.completion.episode.create",
      input: { ...input, id }
    }, async (sql) => {
      await this.assertPolicyAllowed(sql, context, input.roomId, "activity.ingest", "execute", { source_app: input.sourceApp ?? "manual" });
      const existing = input.externalEpisodeKey
        ? await sql.query<EpisodeRow>(`SELECT * FROM workspace_completion_episodes WHERE workspace_id = $1 AND room_id = $2 AND external_episode_key = $3 FOR UPDATE`, [context.workspaceId, input.roomId, input.externalEpisodeKey])
        : { rows: [] as EpisodeRow[] };
      if (existing.rows[0]) return episodeFromRow(existing.rows[0]);
      const inserted = await sql.query<EpisodeRow>(
        `INSERT INTO workspace_completion_episodes(workspace_id, room_id, id, goal, source_app, external_episode_key, session_ref, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7::JSONB, $8, $8) RETURNING *`,
        [context.workspaceId, input.roomId, id, input.goal.trim(), input.sourceApp?.trim() || null, input.externalEpisodeKey ?? null, input.sessionRef ? canonicalJson(input.sessionRef) : null, context.accountId]
      );
      const episode = episodeFromRow(inserted.rows[0]!);
      await this.store.insertAudit(sql, context, {
        action: "workspace.completion.episode.create", roomId: episode.roomId, subjectKind: "completion_episode", subjectId: episode.id, afterVersion: 1
      });
      return episode;
    });
    return { episode: saved.value, replayed: saved.replayed };
  }

  async getEpisode(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, episodeId: string): Promise<WorkspaceCompletionEpisode> {
    assertCompletionId(episodeId, "workspace_completion_episode_id_invalid");
    return this.store.database.withContext(context, async (sql) => {
      const found = await sql.query<EpisodeRow>("SELECT * FROM workspace_completion_episodes WHERE workspace_id = $1 AND id = $2", [context.workspaceId, episodeId]);
      if (!found.rows[0]) throw new WorkspaceServerError("workspace_completion_episode_not_found", 404);
      return episodeFromRow(found.rows[0]);
    });
  }

  async listEpisodeActivities(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, episodeId: string, limit?: number): Promise<WorkspaceCompletionActivity[]> {
    assertCompletionId(episodeId, "workspace_completion_episode_id_invalid");
    return this.store.database.withContext(context, async (sql) => {
      const result = await sql.query<ActivityRow>(
        `SELECT activity.* FROM workspace_completion_episode_activities link
         JOIN workspace_completion_activities activity ON activity.workspace_id = link.workspace_id AND activity.id = link.activity_id
         WHERE link.workspace_id = $1 AND link.episode_id = $2
         ORDER BY activity.created_at ASC, activity.id ASC LIMIT $3`,
        [context.workspaceId, episodeId, boundedLimit(limit)]
      );
      return result.rows.map(activityFromRow);
    });
  }

  /** Episode itself has no free-form body. Its evidence is the Resource
   * evidence that explicitly names this Episode, kept behind the same RLS
   * and bounded-result boundary as Resource evidence. */
  async listEpisodeEvidence(
    context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">,
    episodeId: string,
    limit?: number
  ): Promise<WorkspaceCompletionEvidence[]> {
    await this.getEpisode(context, episodeId);
    return this.store.database.withContext(context, async (sql) => {
      const rows = await sql.query<EvidenceRow>(
        `SELECT * FROM workspace_completion_evidence
         WHERE workspace_id = $1 AND episode_id = $2
         ORDER BY created_at DESC, id DESC LIMIT $3`,
        [context.workspaceId, episodeId, boundedLimit(limit)]
      );
      return rows.rows.map(evidenceFromRow);
    });
  }

  async createReviewSnapshot(
    context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">,
    episodeId: string,
    input: { highWatermarkActivityId?: string } = {}
  ): Promise<WorkspaceCompletionReviewSnapshot> {
    assertCompletionId(episodeId, "workspace_completion_episode_id_invalid");
    if (input.highWatermarkActivityId) assertCompletionId(input.highWatermarkActivityId, "workspace_completion_review_high_watermark_invalid");
    return this.store.database.withReadSnapshot(context, async (sql) => this.buildReviewSnapshot(sql, context, episodeId, input));
  }

  /** Validates every candidate before staging any file.  A single malformed
   * model answer therefore produces a repairable 422 with no partial write. */
  async applyReviewResult(context: WorkspaceRequestContext, input: ApplyWorkspaceCompletionReviewInput): Promise<{ resources: WorkspaceCompletionResource[]; policyRequestIds: string[]; replayed: boolean }> {
    assertReviewApplyInput(input);
    if (input.snapshot.workspaceId !== context.workspaceId) {
      throw new WorkspaceServerError("workspace_completion_review_snapshot_workspace_mismatch", 409);
    }
    const result = validateWorkspaceCompletionReviewResult(input.snapshot, input.result);
    const prepared = prepareReviewDocuments(context, input.snapshot, result);
    const entries = prepared.map((document) => ({ path: document.path, content: document.content }));
    const commit = async (sql: WorkspaceSql) => this.applyReviewInTransaction(sql, context, input, result, prepared);
    if (entries.length === 0) {
      const saved = await this.store.runIdempotentResult(context, {
        action: "workspace.completion.review.apply", input: reviewOperationInput(input, result)
      }, commit);
      return { ...saved.value, replayed: saved.replayed };
    }
    const batch = await this.files.stage(context.workspaceId, { kind: "room", roomId: input.snapshot.roomId }, entries);
    try {
      const saved = await this.executeBatch(context, batch, {
        action: "workspace.completion.review.apply", input: reviewOperationInput(input, result)
      }, (sql) => this.applyReviewInTransaction(sql, context, input, result, prepared, batch));
      return { ...saved.value, replayed: saved.replayed };
    } catch (error) {
      await this.files.rollback(batch).catch(() => undefined);
      throw error;
    }
  }

  async createResource(context: WorkspaceRequestContext, input: WorkspaceCompletionResourceInput): Promise<WorkspaceCompletionResourceWriteResult> {
    return this.writeResource(context, input, { creationSource: "human", action: "workspace.completion.resource.create" });
  }

  async updateResource(context: WorkspaceRequestContext, resourceId: string, input: Omit<WorkspaceCompletionResourceInput, "id"> & { expectedVersion: number }): Promise<WorkspaceCompletionResourceWriteResult> {
    return this.writeResource(context, { ...input, id: resourceId }, { creationSource: "human", action: "workspace.completion.resource.update" });
  }

  /**
   * Makes a verified immutable copy of the current file before its Self-host
   * owner edits it outside the Server.  It never changes PostgreSQL state and
   * therefore has no ambiguous "half imported" state to recover.  An edit
   * made before this preparation is rejected rather than silently losing the
   * previous Version body.
   */
  async preparePhysicalResourceEdit(
    context: WorkspaceRequestContext,
    resourceId: string
  ): Promise<{ resourceId: string; version: number; preparedFiles: number }> {
    const prepared = await this.readPhysicalEditableResource(context, resourceId);
    const main = await this.files.read(context.workspaceId, prepared.current.version.filePath, prepared.current.version.contentHash);
    const entries: Array<{ path: string; content: Uint8Array }> = [{
      path: completionResourcePath({
        id: prepared.current.resource.id,
        kind: prepared.current.resource.kind,
        scope: prepared.current.resource.scope,
        version: prepared.current.version.version
      }),
      content: main
    }];
    for (const support of prepared.supportFiles) {
      entries.push({
        path: completionSkillSupportPath({
          id: prepared.current.resource.id,
          relativePath: support.relativePath,
          version: prepared.current.version.version
        }),
        content: await this.files.read(context.workspaceId, support.filePath, support.contentHash)
      });
    }
    const batch = await this.files.stage(context.workspaceId, prepared.batchScope, entries);
    try {
      await this.files.finalize(batch);
      return { resourceId: prepared.current.resource.id, version: prepared.current.version.version, preparedFiles: entries.length };
    } catch (error) {
      await this.files.rollback(batch).catch(() => undefined);
      throw error;
    }
  }

  /** Detects a local Self-host edit without making that changed body visible
   * to Context, search, or another Account. */
  async inspectPhysicalResourceEdit(
    context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">,
    resourceId: string
  ): Promise<WorkspaceCompletionPhysicalImportStatus> {
    const prepared = await this.readPhysicalEditableResource(context, resourceId);
    const main = await this.inspectPhysicalImportFile(context.workspaceId, prepared.current.version.filePath, "workspace_completion_physical_resource_missing");
    const support = await Promise.all(prepared.supportFiles.map(async (file) => ({
      file,
      physical: await this.inspectPhysicalImportFile(context.workspaceId, file.filePath, "workspace_completion_physical_skill_package_layout_changed")
    })));
    return {
      resource: prepared.current.resource,
      version: prepared.current.version,
      changed: main.sha256 !== prepared.current.version.contentHash || support.some(({ file, physical }) => physical.sha256 !== file.contentHash),
      physicalHash: main.sha256,
      changedSupportPaths: support.filter(({ file, physical }) => physical.sha256 !== file.contentHash).map(({ file }) => file.relativePath)
    };
  }

  /** Imports an already-detected local edit as a normal immutable Version.
   * Policy is still evaluated with `file.import`; physical access cannot
   * become a second way around a Workspace/Room Policy. */
  async importPhysicalResourceEdit(
    context: WorkspaceRequestContext,
    input: { resourceId: string; expectedVersion: number; reason: string }
  ): Promise<WorkspaceCompletionResourceWriteResult> {
    assertCompletionId(input.resourceId, "workspace_completion_resource_id_invalid");
    assertExpectedVersion(input.expectedVersion);
    assertSafeText(input.reason, "workspace_completion_reason_invalid");
    const prepared = await this.readPhysicalEditableResource(context, input.resourceId);
    if (prepared.current.resource.version !== input.expectedVersion) throwVersionConflict(prepared.current.resource.version);
    const kind = prepared.current.resource.kind;
    if (kind !== "knowledge" && kind !== "skill") throw new WorkspaceServerError("workspace_completion_physical_import_state_invalid", 409);
    const status = await this.inspectPhysicalResourceEdit(context, input.resourceId);
    if (!status.changed) throw new WorkspaceServerError("workspace_completion_physical_import_no_change", 409);
    const main = await this.files.inspectPhysicalFile(context.workspaceId, prepared.current.version.filePath);
    const document = parseWorkspaceCompletionDocument(main.content);
    if (document.id !== prepared.current.resource.id || document.resourceKind !== prepared.current.resource.kind) {
      throw new WorkspaceServerError("workspace_completion_physical_import_document_identity_invalid", 422);
    }
    const physicalSupportFiles = await Promise.all(prepared.supportFiles.map(async (file) => ({
      file,
      content: (await this.inspectPhysicalImportFile(context.workspaceId, file.filePath, "workspace_completion_physical_skill_package_layout_changed")).content
    })));
    const supportFiles = physicalSupportFiles.map(({ file, content }) => ({ path: file.relativePath, content }));
    await this.requirePhysicalImportHistory(context.workspaceId, prepared);
    return this.writeResource(context, {
      id: prepared.current.resource.id,
      scope: prepared.current.resource.scope,
      kind,
      ...(kind === "knowledge" ? { knowledgeKind: prepared.current.resource.knowledgeKind } : {}),
      title: document.title,
      content: document.body,
      metadata: document.metadata,
      reason: input.reason,
      expectedVersion: input.expectedVersion,
      ...(kind === "skill" ? { supportFiles } : {})
    }, {
      creationSource: "physical_file_import",
      action: "workspace.completion.resource.physical_file_import",
      createOperation: "file.import",
      updateOperation: "file.import",
      physicalChecks: [
        { path: prepared.current.version.filePath, sha256: main.sha256 },
        ...physicalSupportFiles.map(({ file, content }) => ({ path: file.filePath, sha256: hashBytes(content) }))
      ]
    });
  }

  /** Internal review/Curator path.  It creates a provisional candidate and
   * never points an existing confirmed Resource at model output. */
  async proposeResourceVersion(context: WorkspaceRequestContext, input: WorkspaceCompletionResourceInput): Promise<WorkspaceCompletionResourceWriteResult> {
    return this.writeResource(context, input, { creationSource: "ai", action: "workspace.completion.resource.propose" });
  }

  /** Migration is the sole normal-path producer of `import` rows.  It shares
   * the same Server/file/Policy boundary as a human write and never revives
   * the legacy store as a second write target. */
  async importLegacyResource(context: WorkspaceRequestContext, input: WorkspaceCompletionResourceInput): Promise<WorkspaceCompletionResourceWriteResult> {
    return this.writeResource(context, input, {
      creationSource: "import",
      action: "workspace.completion.migration.resource.import",
      createOperation: "file.import",
      updateOperation: "file.import"
    });
  }

  /** Copy and explicit Workspace-common promotion always create a new stable
   * Resource. Nothing crosses a Room boundary automatically. */
  async copyResource(context: WorkspaceRequestContext, input: { resourceId: string; targetScope: WorkspaceCompletionScope; targetResourceId?: string; expectedVersion: number; reason: string }): Promise<WorkspaceCompletionResourceWriteResult> {
    assertCompletionId(input.resourceId, "workspace_completion_resource_id_invalid");
    assertScope(input.targetScope);
    assertExpectedVersion(input.expectedVersion);
    assertSafeText(input.reason, "workspace_completion_reason_invalid");
    const source = await this.readPackageSnapshot(context, input.resourceId, input.expectedVersion);
    if (source.resource.kind === "policy") throw new WorkspaceServerError("workspace_completion_policy_copy_forbidden", 409);
    return this.writeResource(context, {
      id: input.targetResourceId,
      scope: input.targetScope,
      kind: source.resource.kind,
      ...(source.resource.kind === "knowledge" ? { knowledgeKind: source.resource.knowledgeKind } : {}),
      title: source.resource.title,
      content: source.content,
      metadata: source.version.metadata,
      reason: input.reason,
      expectedVersion: 0,
      aiManaged: false,
      ...(source.supportFiles.length ? { supportFiles: source.supportFiles.map((file) => ({ path: file.relativePath, content: file.content })) } : {})
    }, {
      creationSource: "human", action: "workspace.completion.resource.copy", createOperation: "resource.copy", linkFromResourceId: input.resourceId, linkRelation: "copied_from",
      sourcePackage: source
    });
  }

  async promoteToWorkspace(context: WorkspaceRequestContext, input: { resourceId: string; targetResourceId?: string; expectedVersion: number; reason: string }): Promise<WorkspaceCompletionResourceWriteResult> {
    return this.copyResource(context, { ...input, targetScope: { kind: "workspace" } });
  }

  async moveResource(context: WorkspaceRequestContext, input: { resourceId: string; targetRoomId: string; targetResourceId?: string; expectedVersion: number; reason: string }): Promise<WorkspaceCompletionResourceWriteResult> {
    assertCompletionId(input.resourceId, "workspace_completion_resource_id_invalid");
    assertOpaqueId(input.targetRoomId, "room_id_invalid");
    assertExpectedVersion(input.expectedVersion);
    assertSafeText(input.reason, "workspace_completion_reason_invalid");
    const source = await this.readPackageSnapshot(context, input.resourceId, input.expectedVersion);
    if (source.resource.scope.kind !== "room" || source.resource.scope.roomId === input.targetRoomId) throw new WorkspaceServerError("workspace_completion_resource_move_scope_invalid", 409);
    if (source.resource.version !== input.expectedVersion) throwVersionConflict(source.resource.version);
    if (source.resource.kind === "policy") throw new WorkspaceServerError("workspace_completion_policy_move_forbidden", 409);
    return this.writeResource(context, {
      id: input.targetResourceId,
      scope: { kind: "room", roomId: input.targetRoomId },
      kind: source.resource.kind,
      ...(source.resource.kind === "knowledge" ? { knowledgeKind: source.resource.knowledgeKind } : {}),
      title: source.resource.title,
      content: source.content,
      metadata: source.version.metadata,
      reason: input.reason,
      expectedVersion: 0,
      aiManaged: false,
      ...(source.supportFiles.length ? { supportFiles: source.supportFiles.map((file) => ({ path: file.relativePath, content: file.content })) } : {})
    }, {
      creationSource: "human", action: "workspace.completion.resource.move", createOperation: "resource.move",
      linkFromResourceId: input.resourceId, linkRelation: "moved_from", sourcePackage: source,
      archiveSource: { resourceId: input.resourceId, expectedVersion: input.expectedVersion, expectedContentHash: source.version.contentHash, expectedPackageHash: source.packageHash, reason: input.reason }
    });
  }

  async getResource(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, resourceId: string): Promise<WorkspaceCompletionReadResource> {
    assertCompletionId(resourceId, "workspace_completion_resource_id_invalid");
    return this.store.database.withContext(context, async (sql) => this.selectReadableResource(sql, context.workspaceId, resourceId, true));
  }

  async getPolicy(
    context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">,
    resourceId: string
  ): Promise<{ resource: WorkspaceCompletionResource; version: WorkspaceCompletionResourceVersion; rules: readonly WorkspaceCompletionPolicyRule[]; enabled: boolean }> {
    const current = await this.getResource(context, resourceId);
    if (current.resource.kind !== "policy") throw new WorkspaceServerError("workspace_completion_policy_required", 409);
    return this.store.database.withContext(context, async (sql) => {
      const rows = await sql.query<PolicyRuleRow>(
        `SELECT rule.*, resource.scope_kind, resource.room_id
         FROM workspace_completion_policy_rules rule
         JOIN workspace_completion_resources resource ON resource.workspace_id = rule.workspace_id AND resource.id = rule.resource_id
         WHERE rule.workspace_id = $1 AND rule.resource_id = $2 AND rule.resource_version = $3
         ORDER BY rule.id ASC LIMIT $4`,
        [context.workspaceId, current.resource.id, current.version.version, maxPage]
      );
      return {
        resource: current.resource,
        version: current.version,
        rules: rows.rows.map(policyRuleFromRow),
        enabled: current.version.metadata.enabled === true
      };
    });
  }

  async getResourceBody(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, resourceId: string, requestedVersion?: number): Promise<{ resource: WorkspaceCompletionResource; version: WorkspaceCompletionResourceVersion; content: string }> {
    assertCompletionId(resourceId, "workspace_completion_resource_id_invalid");
    if (requestedVersion !== undefined && (!Number.isSafeInteger(requestedVersion) || requestedVersion < 1)) {
      throw new WorkspaceServerError("workspace_completion_resource_version_invalid", 400);
    }
    const selected = await this.store.database.withContext(context, async (sql) => {
      const resource = await this.selectReadableResource(sql, context.workspaceId, resourceId, requestedVersion === undefined);
      const version = requestedVersion === undefined ? resource.version : await this.selectVersion(sql, context.workspaceId, resourceId, requestedVersion, true);
      return { resource: resource.resource, version };
    });
    const bytes = await this.files.read(context.workspaceId, selected.version.filePath, selected.version.contentHash);
    const document = parseWorkspaceCompletionDocument(bytes);
    if (document.id !== selected.resource.id || document.resourceKind !== selected.resource.kind || document.title !== selected.resource.title) {
      throw new WorkspaceServerError("workspace_completion_file_metadata_mismatch", 503, { resource_id: selected.resource.id });
    }
    return { ...selected, content: document.body };
  }

  /** Records a structured, hash-bound verification result. A caller claim on
   * Activity is intentionally not promoted here; only the Port result below
   * may create machine_attestation Evidence. */
  async applyAttestation(
    context: WorkspaceRequestContext,
    input: ApplyWorkspaceCompletionAttestationInput
  ): Promise<{ attestation: WorkspaceCompletionAttestation; replayed: boolean }> {
    validateAttestationRequest(context, input.request);
    const prepared = await this.prepareAttestation(context, input.request);
    const raw = this.attestationPort
      ? await this.attestationPort.attest(input.request)
      : {
          outcome: "not_run" as const,
          attestorId: "unconfigured",
          sourceVersion: input.request.sourceVersion,
          attestedAt: new Date().toISOString(),
          failureReasons: [{ code: "attestation_port_not_configured", message: "No Attestation Port is configured." }]
        };
    const result = normalizeAttestationResult(input.request, raw);
    // The operation is keyed by the requested target and source, not the
    // cassette's clock. A retry must not create a second success merely
    // because an external verifier returned a later timestamp.
    const id = completionId("completion_attestation", context.workspaceId, canonicalJson(input.request));
    const saved = await this.store.runIdempotentResult(context, {
      action: "workspace.completion.attestation.apply",
      input: {
        id,
        request: attestationRequestForOperation(input.request)
      }
    }, async (sql) => {
      const current = await this.verifyAttestationTargetInTransaction(sql, context, input.request, prepared);
      const confirmed = result.outcome === "confirmed" && current.hashMatches;
      const finalResult = confirmed ? result : result.outcome === "confirmed"
        ? {
            ...result,
            outcome: "failed" as const,
            failureReasons: [...result.failureReasons, { code: "attestation_target_changed", message: "The target version or content hash changed before the result was applied." }]
          }
        : result;
      await sql.query("SELECT set_config('samurai.completion_attestation_apply', 'on', true)");
      const inserted = await sql.query<AttestationRow>(
        `INSERT INTO workspace_completion_attestations(
           workspace_id, id, activity_id, resource_id, resource_version, source_ref,
           source_version, expected_content_hash, observed_content_hash, outcome,
           attestor_id, failure_reasons, attested_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::JSONB, $13::TIMESTAMPTZ)
         ON CONFLICT (workspace_id, id) DO NOTHING
         RETURNING *`,
        [
          context.workspaceId, id, input.request.target.activityId ?? null,
          input.request.target.resourceId ?? null, input.request.target.resourceVersion ?? null,
          input.request.sourceRef, finalResult.sourceVersion, input.request.expectedContentHash,
          finalResult.observedContentHash ?? null, finalResult.outcome, finalResult.attestorId,
          canonicalJson(finalResult.failureReasons), finalResult.attestedAt
        ]
      );
      const existing = inserted.rows[0] ?? (await sql.query<AttestationRow>(
        "SELECT * FROM workspace_completion_attestations WHERE workspace_id = $1 AND id = $2",
        [context.workspaceId, id]
      )).rows[0];
      if (!existing) throw new WorkspaceServerError("workspace_completion_attestation_not_found", 503);
      const attestation = attestationFromRow(existing);
      if (inserted.rows[0] && attestation.outcome === "confirmed" && current.resource) {
        await this.insertEvidence(sql, context.workspaceId, current.resource.id, current.version!.version, {
          kind: "machine_attestation",
          attestationId: attestation.id,
          summary: `Attested by ${attestation.attestorId} at ${attestation.attestedAt}`
        });
        // Facts may become confirmed immediately, but only through the
        // hash-bound Port path. Other kinds keep their normal review/promotion
        // rules and no caller declaration is counted as success.
        if (current.resource.kind === "knowledge" && current.resource.knowledgeKind === "fact") {
          await sql.query(
            `UPDATE workspace_completion_resources
             SET evidence_state = 'confirmed',
                 creation_source = CASE WHEN creation_source = 'ai' THEN 'machine_verified' ELSE creation_source END,
                 current_confirmed_version = $4, current_provisional_version = NULL, candidate_version = NULL,
                 updated_by = $3, updated_at = NOW()
             WHERE workspace_id = $1 AND id = $2 AND version = $4`,
            [context.workspaceId, current.resource.id, context.accountId, current.resource.version]
          );
        }
      }
      if (inserted.rows[0]) {
        await this.store.insertAudit(sql, context, {
          action: "workspace.completion.attestation.apply",
          ...(current.resource?.scope.roomId ? { roomId: current.resource.scope.roomId } : {}),
          subjectKind: "completion_attestation",
          subjectId: attestation.id,
          details: { outcome: attestation.outcome, resource_id: attestation.resourceId ?? null, activity_id: attestation.activityId ?? null }
        });
      }
      return attestation;
    });
    return { attestation: saved.value, replayed: saved.replayed };
  }

  async listResources(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, input: { roomId?: string; kind?: WorkspaceCompletionResourceKind; includeArchived?: boolean; limit?: number } = {}): Promise<WorkspaceCompletionResource[]> {
    if (input.roomId) assertOpaqueId(input.roomId, "room_id_invalid");
    if (input.kind && !completionResourceKinds.has(input.kind)) throw new WorkspaceServerError("workspace_completion_resource_kind_invalid", 400);
    return this.store.database.withContext(context, async (sql) => {
      const result = await sql.query<ResourceRow>(
        `SELECT resource.*
         FROM workspace_completion_resources resource
         JOIN workspace_completion_resource_versions current_version
           ON current_version.workspace_id = resource.workspace_id
          AND current_version.resource_id = resource.id
          AND current_version.version = COALESCE(resource.current_confirmed_version, resource.current_provisional_version)
         LEFT JOIN workspace_completion_file_batches batch
           ON batch.workspace_id = current_version.workspace_id AND batch.id = current_version.file_batch_id
         WHERE resource.workspace_id = $1
           AND ($2::TEXT IS NULL OR resource.scope_kind = 'workspace' OR resource.room_id = $2)
           AND ($3::TEXT IS NULL OR resource.resource_kind = $3)
           AND ($4::BOOLEAN OR resource.lifecycle_state <> 'archived')
           AND (current_version.file_batch_id IS NULL OR batch.status = 'renamed')
         ORDER BY resource.updated_at DESC, resource.id ASC LIMIT $5`,
        [context.workspaceId, input.roomId ?? null, input.kind ?? null, input.includeArchived === true, boundedLimit(input.limit)]
      );
      return result.rows.map(resourceFromRow);
    });
  }

  /** API-facing collection page.  It deliberately orders by immutable ID so
   * inserts or edits between requests cannot shift a cursor boundary. */
  async listResourcesPage(
    context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">,
    input: { roomId?: string; kind?: WorkspaceCompletionResourceKind; includeArchived?: boolean; limit?: number; cursor?: string } = {}
  ): Promise<WorkspaceCompletionPage<WorkspaceCompletionResource>> {
    if (input.roomId) assertOpaqueId(input.roomId, "room_id_invalid");
    if (input.kind && !completionResourceKinds.has(input.kind)) throw new WorkspaceServerError("workspace_completion_resource_kind_invalid", 400);
    const limit = boundedLimit(input.limit);
    const afterId = decodeCompletionCursor(input.cursor);
    return this.store.database.withContext(context, async (sql) => {
      const result = await sql.query<ResourceRow>(
        `SELECT resource.*
         FROM workspace_completion_resources resource
         JOIN workspace_completion_resource_versions current_version
           ON current_version.workspace_id = resource.workspace_id
          AND current_version.resource_id = resource.id
          AND current_version.version = COALESCE(resource.current_confirmed_version, resource.current_provisional_version)
         LEFT JOIN workspace_completion_file_batches batch
           ON batch.workspace_id = current_version.workspace_id AND batch.id = current_version.file_batch_id
         WHERE resource.workspace_id = $1
           AND ($2::TEXT IS NULL OR resource.scope_kind = 'workspace' OR resource.room_id = $2)
           AND ($3::TEXT IS NULL OR resource.resource_kind = $3)
           AND ($4::BOOLEAN OR resource.lifecycle_state <> 'archived')
           AND (current_version.file_batch_id IS NULL OR batch.status = 'renamed')
           AND ($5::TEXT IS NULL OR resource.id > $5)
         ORDER BY resource.id ASC LIMIT $6`,
        [context.workspaceId, input.roomId ?? null, input.kind ?? null, input.includeArchived === true, afterId ?? null, limit + 1]
      );
      const resources = result.rows.map(resourceFromRow);
      const items = resources.slice(0, limit);
      const last = items[items.length - 1];
      return {
        items,
        ...(resources.length > limit && last ? { nextCursor: encodeCompletionCursor(last.id) } : {})
      };
    });
  }

  /** Curator archives are intentionally a narrower view than the generic
   * Resource list: only AI-created, Room-local Resources can appear here.
   * Human archives stay available through the normal Resource API. */
  async listArchivedAiResourcesPage(
    context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">,
    input: { roomId: string; limit?: number; cursor?: string }
  ): Promise<WorkspaceCompletionPage<WorkspaceCompletionResource>> {
    assertOpaqueId(input.roomId, "room_id_invalid");
    const limit = boundedLimit(input.limit);
    const afterId = decodeCompletionCursor(input.cursor);
    return this.store.database.withContext(context, async (sql) => {
      const result = await sql.query<ResourceRow>(
        `SELECT resource.*
         FROM workspace_completion_resources resource
         JOIN workspace_completion_resource_versions current_version
           ON current_version.workspace_id = resource.workspace_id
          AND current_version.resource_id = resource.id
          AND current_version.version = COALESCE(resource.current_confirmed_version, resource.current_provisional_version)
         LEFT JOIN workspace_completion_file_batches batch
           ON batch.workspace_id = current_version.workspace_id AND batch.id = current_version.file_batch_id
         WHERE resource.workspace_id = $1 AND resource.scope_kind = 'room' AND resource.room_id = $2
           AND resource.lifecycle_state = 'archived' AND resource.ai_managed
           AND resource.creation_source = 'ai'
           AND (current_version.file_batch_id IS NULL OR batch.status = 'renamed')
           AND ($3::TEXT IS NULL OR resource.id > $3)
         ORDER BY resource.id ASC LIMIT $4`,
        [context.workspaceId, input.roomId, afterId ?? null, limit + 1]
      );
      const resources = result.rows.map(resourceFromRow);
      const items = resources.slice(0, limit);
      const last = items[items.length - 1];
      return {
        items,
        ...(resources.length > limit && last ? { nextCursor: encodeCompletionCursor(last.id) } : {})
      };
    });
  }

  async listResourceVersions(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, resourceId: string, limit?: number): Promise<WorkspaceCompletionResourceVersion[]> {
    assertCompletionId(resourceId, "workspace_completion_resource_id_invalid");
    const bounded = boundedLimit(limit);
    return this.store.database.withContext(context, async (sql) => {
      const rows = await sql.query<VersionRow>(
        `SELECT version.* FROM workspace_completion_resource_versions version
         LEFT JOIN workspace_completion_file_batches batch ON batch.workspace_id = version.workspace_id AND batch.id = version.file_batch_id
         WHERE version.workspace_id = $1 AND version.resource_id = $2
           AND (version.file_batch_id IS NULL OR batch.status = 'renamed')
         ORDER BY version.version DESC LIMIT $3`,
        [context.workspaceId, resourceId, bounded]
      );
      return rows.rows.map(versionFromRow);
    });
  }

  async listEvidence(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, resourceId: string, limit?: number): Promise<WorkspaceCompletionEvidence[]> {
    assertCompletionId(resourceId, "workspace_completion_resource_id_invalid");
    const bounded = boundedLimit(limit);
    return this.store.database.withContext(context, async (sql) => {
      const rows = await sql.query<EvidenceRow>(
        "SELECT * FROM workspace_completion_evidence WHERE workspace_id = $1 AND resource_id = $2 ORDER BY created_at DESC, id DESC LIMIT $3",
        [context.workspaceId, resourceId, bounded]
      );
      return rows.rows.map(evidenceFromRow);
    });
  }

  /** The latest row for each Episode is the current assessment; corrections
   * append a row instead of rewriting the original result. */
  async listEvaluations(
    context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">,
    input: { resourceId: string; resourceVersion?: number; episodeId?: string; limit?: number }
  ): Promise<{ evaluations: WorkspaceCompletionEvaluation[]; summary: { confirmedSuccess: number; confirmedFailure: number; unknown: number; independentEpisodes: number } }> {
    assertCompletionId(input.resourceId, "workspace_completion_resource_id_invalid");
    if (input.resourceVersion !== undefined) assertExpectedVersion(input.resourceVersion);
    if (input.episodeId) assertCompletionId(input.episodeId, "workspace_completion_episode_id_invalid");
    return this.store.database.withContext(context, async (sql) => {
      await this.selectReadableResource(sql, context.workspaceId, input.resourceId, false);
      const rows = await sql.query<EvaluationRow>(
        `SELECT * FROM workspace_completion_evaluations
         WHERE workspace_id = $1 AND resource_id = $2
           AND ($3::BIGINT IS NULL OR resource_version = $3)
           AND ($4::TEXT IS NULL OR episode_id = $4)
         ORDER BY created_at DESC, id DESC LIMIT $5`,
        [context.workspaceId, input.resourceId, input.resourceVersion ?? null, input.episodeId ?? null, boundedLimit(input.limit)]
      );
      const summary = await sql.query<{ confirmed_success: number | string; confirmed_failure: number | string; unknown: number | string; episodes: number | string }>(
        `SELECT
           COUNT(*) FILTER (WHERE outcome = 'confirmed_success') AS confirmed_success,
           COUNT(*) FILTER (WHERE outcome = 'confirmed_failure') AS confirmed_failure,
           COUNT(*) FILTER (WHERE outcome = 'unknown') AS unknown,
           COUNT(*) AS episodes
         FROM (
           SELECT DISTINCT ON (episode_id) episode_id, outcome
           FROM workspace_completion_evaluations
           WHERE workspace_id = $1 AND resource_id = $2
             AND ($3::BIGINT IS NULL OR resource_version = $3)
             AND ($4::TEXT IS NULL OR episode_id = $4)
           ORDER BY episode_id, created_at DESC, id DESC
         ) latest`,
        [context.workspaceId, input.resourceId, input.resourceVersion ?? null, input.episodeId ?? null]
      );
      const aggregate = summary.rows[0];
      return {
        evaluations: rows.rows.map(evaluationFromRow),
        summary: {
          confirmedSuccess: Number(aggregate?.confirmed_success ?? 0),
          confirmedFailure: Number(aggregate?.confirmed_failure ?? 0),
          unknown: Number(aggregate?.unknown ?? 0),
          independentEpisodes: Number(aggregate?.episodes ?? 0)
        }
      };
    });
  }

  async setResourceFixed(context: WorkspaceRequestContext, input: { resourceId: string; fixed: boolean; expectedVersion: number; reason: string }): Promise<WorkspaceCompletionResourceWriteResult> {
    assertCompletionId(input.resourceId, "workspace_completion_resource_id_invalid");
    assertExpectedVersion(input.expectedVersion);
    assertSafeText(input.reason, "workspace_completion_reason_invalid");
    const saved = await this.store.runIdempotentResult(context, {
      action: input.fixed ? "workspace.completion.resource.fixed" : "workspace.completion.resource.unfixed", input
    }, async (sql) => {
      const current = await this.selectResourceForUpdate(sql, context.workspaceId, input.resourceId);
      if (!current) throw new WorkspaceServerError("workspace_completion_resource_not_found", 404);
      await this.assertPolicyAllowed(sql, context, scopeRoom(current.scope), "resource.update", authorityForScope(current.scope), { resource_kind: current.kind, fixed: input.fixed });
      if (current.version !== input.expectedVersion) throwVersionConflict(current.version);
      const updated = await sql.query<ResourceRow>(
        `UPDATE workspace_completion_resources SET ai_protection = $3, updated_by = $4, updated_at = NOW()
         WHERE workspace_id = $1 AND id = $2 RETURNING *`,
        [context.workspaceId, current.id, input.fixed ? "fixed" : "editable", context.accountId]
      );
      const resource = resourceFromRow(updated.rows[0]!);
      const version = await this.currentVersionForResource(sql, context.workspaceId, resource, true);
      await this.insertEvidence(sql, context.workspaceId, resource.id, version.version, { kind: "human_edit", summary: input.reason.trim() });
      await this.store.insertAudit(sql, context, {
        action: input.fixed ? "workspace.completion.resource.fixed" : "workspace.completion.resource.unfixed",
        ...(resource.scope.roomId ? { roomId: resource.scope.roomId } : {}), subjectKind: "completion_resource", subjectId: resource.id,
        beforeVersion: current.version, afterVersion: resource.version, details: { fixed: input.fixed }
      });
      return resource;
    });
    return { resource: saved.value, replayed: saved.replayed };
  }

  async setResourceArchived(context: WorkspaceRequestContext, input: { resourceId: string; archived: boolean; expectedVersion: number; reason: string }): Promise<WorkspaceCompletionResourceWriteResult> {
    assertCompletionId(input.resourceId, "workspace_completion_resource_id_invalid");
    assertExpectedVersion(input.expectedVersion);
    assertSafeText(input.reason, "workspace_completion_reason_invalid");
    const saved = await this.store.runIdempotentResult(context, {
      action: input.archived ? "workspace.completion.resource.archive" : "workspace.completion.resource.restore", input
    }, async (sql) => {
      const current = await this.selectResourceForUpdate(sql, context.workspaceId, input.resourceId);
      if (!current) throw new WorkspaceServerError("workspace_completion_resource_not_found", 404);
      await this.assertPolicyAllowed(sql, context, scopeRoom(current.scope), "resource.archive", authorityForScope(current.scope), { resource_kind: current.kind, archived: input.archived });
      if (current.version !== input.expectedVersion) throwVersionConflict(current.version);
      const updated = await sql.query<ResourceRow>(
        `UPDATE workspace_completion_resources
         SET lifecycle_state = $3, archived_at = CASE WHEN $3 = 'archived' THEN NOW() ELSE NULL END,
             updated_by = $4, updated_at = NOW()
         WHERE workspace_id = $1 AND id = $2 RETURNING *`,
        [context.workspaceId, current.id, input.archived ? "archived" : "active", context.accountId]
      );
      const resource = resourceFromRow(updated.rows[0]!);
      const version = await this.currentVersionForResource(sql, context.workspaceId, resource, true);
      await this.insertEvidence(sql, context.workspaceId, resource.id, version.version, { kind: "human_edit", summary: input.reason.trim() });
      await this.store.insertAudit(sql, context, {
        action: input.archived ? "workspace.completion.resource.archive" : "workspace.completion.resource.restore",
        ...(resource.scope.roomId ? { roomId: resource.scope.roomId } : {}), subjectKind: "completion_resource", subjectId: resource.id,
        beforeVersion: current.version, afterVersion: resource.version, details: { lifecycle_state: resource.lifecycleState }
      });
      return resource;
    });
    return { resource: saved.value, replayed: saved.replayed };
  }

  async searchKnowledge(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, input: { roomId: string; query: string; limit?: number }): Promise<Array<WorkspaceCompletionResource & { rank: number }>> {
    assertOpaqueId(input.roomId, "room_id_invalid");
    assertSafeText(input.query, "workspace_completion_search_query_invalid");
    return this.store.database.withContext(context, async (sql) => {
      const result = await sql.query<ResourceRow & { rank: number | string }>(
        `SELECT resource.*, similarity(projection.search_text, $3) AS rank
         FROM workspace_completion_resources resource
         JOIN workspace_completion_resource_versions current_version
           ON current_version.workspace_id = resource.workspace_id
          AND current_version.resource_id = resource.id
          AND current_version.version = COALESCE(resource.current_confirmed_version, resource.current_provisional_version)
         JOIN workspace_completion_search_projection projection
           ON projection.workspace_id = current_version.workspace_id AND projection.resource_id = current_version.resource_id AND projection.resource_version = current_version.version
         LEFT JOIN workspace_completion_file_batches batch ON batch.workspace_id = current_version.workspace_id AND batch.id = current_version.file_batch_id
         WHERE resource.workspace_id = $1 AND resource.resource_kind = 'knowledge'
           AND (resource.scope_kind = 'workspace' OR resource.room_id = $2)
           AND resource.lifecycle_state <> 'archived' AND resource.evidence_state <> 'contradicted'
           AND (current_version.file_batch_id IS NULL OR batch.status = 'renamed')
           AND projection.search_text ILIKE ('%' || $3 || '%')
         ORDER BY CASE resource.evidence_state WHEN 'confirmed' THEN 0 ELSE 1 END, rank DESC, resource.updated_at DESC
         LIMIT $4`,
        [context.workspaceId, input.roomId, input.query.trim(), boundedLimit(input.limit)]
      );
      return result.rows.map((row) => ({ ...resourceFromRow(row), rank: Number(row.rank) }));
    });
  }

  /** Search uses a cursor containing the last relevance tuple. This avoids
   * offset drift while retaining the visible confirmed-then-rank ordering. */
  async searchKnowledgePage(
    context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">,
    input: { roomId: string; query: string; limit?: number; cursor?: string }
  ): Promise<WorkspaceCompletionPage<WorkspaceCompletionResource & { rank: number }>> {
    assertOpaqueId(input.roomId, "room_id_invalid");
    assertSafeText(input.query, "workspace_completion_search_query_invalid");
    const limit = boundedLimit(input.limit);
    const after = decodeSearchCursor(input.cursor);
    return this.store.database.withContext(context, async (sql) => {
      const result = await sql.query<ResourceRow & { rank: number | string; evidence_bucket: number | string }>(
        `WITH scored AS (
           SELECT resource.*, similarity(projection.search_text, $3) AS rank,
             CASE resource.evidence_state WHEN 'confirmed' THEN 0 ELSE 1 END AS evidence_bucket
           FROM workspace_completion_resources resource
           JOIN workspace_completion_resource_versions current_version
             ON current_version.workspace_id = resource.workspace_id
            AND current_version.resource_id = resource.id
            AND current_version.version = COALESCE(resource.current_confirmed_version, resource.current_provisional_version)
           JOIN workspace_completion_search_projection projection
             ON projection.workspace_id = current_version.workspace_id AND projection.resource_id = current_version.resource_id AND projection.resource_version = current_version.version
           LEFT JOIN workspace_completion_file_batches batch ON batch.workspace_id = current_version.workspace_id AND batch.id = current_version.file_batch_id
           WHERE resource.workspace_id = $1 AND resource.resource_kind = 'knowledge'
             AND (resource.scope_kind = 'workspace' OR resource.room_id = $2)
             AND resource.lifecycle_state <> 'archived' AND resource.evidence_state <> 'contradicted'
             AND (current_version.file_batch_id IS NULL OR batch.status = 'renamed')
             AND projection.search_text ILIKE ('%' || $3 || '%')
         )
         SELECT * FROM scored
         WHERE ($4::INTEGER IS NULL OR evidence_bucket > $4
           OR (evidence_bucket = $4 AND (rank < $5::REAL OR (rank = $5::REAL AND id > $6))))
         ORDER BY evidence_bucket ASC, rank DESC, id ASC
         LIMIT $7`,
        [context.workspaceId, input.roomId, input.query.trim(), after?.bucket ?? null, after?.rank ?? null, after?.id ?? null, limit + 1]
      );
      const resources = result.rows.map((row) => ({ ...resourceFromRow(row), rank: Number(row.rank), bucket: Number(row.evidence_bucket) }));
      const visible = resources.slice(0, limit);
      const last = visible[visible.length - 1];
      return {
        items: visible.map(({ bucket: _bucket, ...resource }) => resource),
        ...(resources.length > limit && last ? { nextCursor: encodeSearchCursor({ id: last.id, rank: last.rank, bucket: last.bucket }) } : {})
      };
    });
  }

  /** Skill lookup is separate from Knowledge search because callers must
   * never receive an arbitrary Knowledge document where an executable Skill
   * package was requested. */
  async searchSkillsPage(
    context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">,
    input: { roomId: string; query: string; limit?: number; cursor?: string }
  ): Promise<WorkspaceCompletionPage<WorkspaceCompletionResource & { rank: number }>> {
    assertOpaqueId(input.roomId, "room_id_invalid");
    assertSafeText(input.query, "workspace_completion_search_query_invalid");
    const limit = boundedLimit(input.limit);
    const after = decodeSearchCursor(input.cursor);
    return this.store.database.withContext(context, async (sql) => {
      const result = await sql.query<ResourceRow & { rank: number | string; evidence_bucket: number | string }>(
        `WITH scored AS (
           SELECT resource.*, similarity(projection.search_text, $3) AS rank,
             CASE resource.evidence_state WHEN 'confirmed' THEN 0 ELSE 1 END AS evidence_bucket
           FROM workspace_completion_resources resource
           JOIN workspace_completion_resource_versions current_version
             ON current_version.workspace_id = resource.workspace_id
            AND current_version.resource_id = resource.id
            AND current_version.version = COALESCE(resource.current_confirmed_version, resource.current_provisional_version)
           JOIN workspace_completion_search_projection projection
             ON projection.workspace_id = current_version.workspace_id AND projection.resource_id = current_version.resource_id AND projection.resource_version = current_version.version
           LEFT JOIN workspace_completion_file_batches batch ON batch.workspace_id = current_version.workspace_id AND batch.id = current_version.file_batch_id
           WHERE resource.workspace_id = $1 AND resource.resource_kind = 'skill'
             AND (resource.scope_kind = 'workspace' OR resource.room_id = $2)
             AND resource.lifecycle_state <> 'archived'
             AND (current_version.metadata->>'migration_incomplete_skill') IS DISTINCT FROM 'true'
             AND (current_version.file_batch_id IS NULL OR batch.status = 'renamed')
             AND projection.search_text ILIKE ('%' || $3 || '%')
         )
         SELECT * FROM scored
         WHERE ($4::INTEGER IS NULL OR evidence_bucket > $4
           OR (evidence_bucket = $4 AND (rank < $5::REAL OR (rank = $5::REAL AND id > $6))))
         ORDER BY evidence_bucket ASC, rank DESC, id ASC
         LIMIT $7`,
        [context.workspaceId, input.roomId, input.query.trim(), after?.bucket ?? null, after?.rank ?? null, after?.id ?? null, limit + 1]
      );
      const resources = result.rows.map((row) => ({ ...resourceFromRow(row), rank: Number(row.rank), bucket: Number(row.evidence_bucket) }));
      const visible = resources.slice(0, limit);
      const last = visible[visible.length - 1];
      return {
        items: visible.map(({ bucket: _bucket, ...resource }) => resource),
        ...(resources.length > limit && last ? { nextCursor: encodeSearchCursor({ id: last.id, rank: last.rank, bucket: last.bucket }) } : {})
      };
    });
  }

  async listSkills(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, input: { roomId: string; limit?: number }): Promise<WorkspaceCompletionResource[]> {
    assertOpaqueId(input.roomId, "room_id_invalid");
    return this.store.database.withContext(context, async (sql) => {
      const result = await sql.query<ResourceRow>(
        `SELECT resource.*
         FROM workspace_completion_resources resource
         JOIN workspace_completion_resource_versions current_version
           ON current_version.workspace_id = resource.workspace_id
          AND current_version.resource_id = resource.id
          AND current_version.version = COALESCE(resource.current_confirmed_version, resource.current_provisional_version)
         LEFT JOIN workspace_completion_file_batches batch
           ON batch.workspace_id = current_version.workspace_id AND batch.id = current_version.file_batch_id
         WHERE resource.workspace_id = $1 AND resource.resource_kind = 'skill'
           AND (resource.scope_kind = 'workspace' OR resource.room_id = $2)
           AND resource.lifecycle_state <> 'archived'
           AND (current_version.metadata->>'migration_incomplete_skill') IS DISTINCT FROM 'true'
           AND (current_version.file_batch_id IS NULL OR batch.status = 'renamed')
         ORDER BY CASE resource.evidence_state WHEN 'confirmed' THEN 0 ELSE 1 END, resource.updated_at DESC, resource.id ASC
         LIMIT $3`,
        [context.workspaceId, input.roomId, boundedLimit(input.limit)]
      );
      return result.rows.map(resourceFromRow);
    });
  }

  async listSkillsPage(
    context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">,
    input: { roomId: string; limit?: number; cursor?: string }
  ): Promise<WorkspaceCompletionPage<WorkspaceCompletionResource>> {
    assertOpaqueId(input.roomId, "room_id_invalid");
    const limit = boundedLimit(input.limit);
    const afterId = decodeCompletionCursor(input.cursor);
    return this.store.database.withContext(context, async (sql) => {
      const result = await sql.query<ResourceRow>(
        `SELECT resource.*
         FROM workspace_completion_resources resource
         JOIN workspace_completion_resource_versions current_version
           ON current_version.workspace_id = resource.workspace_id
          AND current_version.resource_id = resource.id
          AND current_version.version = COALESCE(resource.current_confirmed_version, resource.current_provisional_version)
         LEFT JOIN workspace_completion_file_batches batch
           ON batch.workspace_id = current_version.workspace_id AND batch.id = current_version.file_batch_id
         WHERE resource.workspace_id = $1 AND resource.resource_kind = 'skill'
           AND (resource.scope_kind = 'workspace' OR resource.room_id = $2)
           AND resource.lifecycle_state <> 'archived'
           AND (current_version.metadata->>'migration_incomplete_skill') IS DISTINCT FROM 'true'
           AND (current_version.file_batch_id IS NULL OR batch.status = 'renamed')
           AND ($3::TEXT IS NULL OR resource.id > $3)
         ORDER BY resource.id ASC LIMIT $4`,
        [context.workspaceId, input.roomId, afterId ?? null, limit + 1]
      );
      const skills = result.rows.map(resourceFromRow);
      const items = skills.slice(0, limit);
      const last = items[items.length - 1];
      return {
        items,
        ...(skills.length > limit && last ? { nextCursor: encodeCompletionCursor(last.id) } : {})
      };
    });
  }

  async listSkillFiles(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, resourceId: string, requestedVersion?: number, limit?: number): Promise<WorkspaceCompletionSkillFile[]> {
    const current = await this.getResource(context, resourceId);
    if (current.resource.kind !== "skill") throw new WorkspaceServerError("workspace_completion_skill_required", 409);
    const version = requestedVersion ?? current.version.version;
    assertExpectedVersion(version);
    const bounded = boundedLimit(limit);
    return this.store.database.withContext(context, async (sql) => {
      const rows = await sql.query<SkillFileRow & { batch_status: "db_committed" | "renamed" | "rolled_back" | null }>(
        `SELECT file.*, batch.status AS batch_status
         FROM workspace_completion_skill_files file
         JOIN workspace_completion_file_batches batch ON batch.workspace_id = file.workspace_id AND batch.id = file.file_batch_id
         WHERE file.workspace_id = $1 AND file.resource_id = $2 AND file.resource_version = $3
         ORDER BY file.relative_path ASC LIMIT $4`,
        [context.workspaceId, resourceId, version, bounded]
      );
      if (rows.rows.some((row) => row.batch_status !== "renamed")) throw new WorkspaceServerError("workspace_completion_file_recovery_required", 503, { resource_id: resourceId, version });
      return rows.rows.map(skillFileFromRow);
    });
  }

  async getSkillFile(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, resourceId: string, relativePath: string, requestedVersion?: number): Promise<{ file: WorkspaceCompletionSkillFile; content: Buffer }> {
    const safePath = assertSkillSupportRelativePath(relativePath);
    const files = await this.listSkillFiles(context, resourceId, requestedVersion, maxPage);
    const file = files.find((candidate) => candidate.relativePath === safePath);
    if (!file) throw new WorkspaceServerError("workspace_completion_skill_file_not_found", 404);
    const content = await this.files.read(context.workspaceId, file.filePath, file.contentHash);
    return { file, content };
  }

  async getSkillDocument(
    context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">,
    resourceId: string,
    requestedVersion?: number
  ): Promise<{ resource: WorkspaceCompletionResource; version: WorkspaceCompletionResourceVersion; content: string }> {
    const document = await this.getResourceBody(context, resourceId, requestedVersion);
    if (document.resource.kind !== "skill") throw new WorkspaceServerError("workspace_completion_skill_required", 409);
    return document;
  }

  async recordUse(context: WorkspaceRequestContext, input: { id?: string; resourceId: string; resourceVersion: number; activityId?: string; episodeId?: string; event: WorkspaceCompletionUseEvent["event"]; outcome?: WorkspaceCompletionUseEvent["outcome"]; supersedesUseId?: string; summary: string }): Promise<{ use: WorkspaceCompletionUseEvent; evaluationJob?: WorkspaceCompletionJob; replayed: boolean }> {
    assertCompletionId(input.resourceId, "workspace_completion_resource_id_invalid");
    assertExpectedVersion(input.resourceVersion);
    if (!useEvents.has(input.event)) throw new WorkspaceServerError("workspace_completion_use_event_invalid", 400);
    if ((input.event === "outcome") !== Boolean(input.outcome)) throw new WorkspaceServerError("workspace_completion_use_outcome_shape_invalid", 422);
    if (input.outcome && !useOutcomes.has(input.outcome)) throw new WorkspaceServerError("workspace_completion_use_outcome_invalid", 400);
    if (input.activityId) assertCompletionId(input.activityId, "workspace_completion_activity_id_invalid");
    if (input.episodeId) assertCompletionId(input.episodeId, "workspace_completion_episode_id_invalid");
    if (input.supersedesUseId) assertCompletionId(input.supersedesUseId, "workspace_completion_use_id_invalid");
    assertSafeText(input.summary, "workspace_completion_use_summary_invalid");
    const id = input.id ?? completionId("completion_use", context.workspaceId, `${context.operationId}:${input.resourceId}:${input.resourceVersion}:${input.event}`);
    assertCompletionId(id, "workspace_completion_use_id_invalid");
    const saved = await this.store.runIdempotentResult(context, { action: "workspace.completion.use.record", input: { ...input, id } }, async (sql) => {
      const resource = await this.selectReadableResource(sql, context.workspaceId, input.resourceId, false);
      const version = await this.selectVersion(sql, context.workspaceId, input.resourceId, input.resourceVersion, true);
      const roomId = resource.resource.scope.roomId ?? (await this.defaultWritableRoom(sql, context.workspaceId));
      await this.assertPolicyAllowed(sql, context, roomId, "activity.ingest", "execute", { use_event: input.event, resource_kind: resource.resource.kind });
      const episode = input.episodeId ? await this.selectEpisode(sql, context.workspaceId, input.episodeId) : undefined;
      const activity = input.activityId ? await this.selectActivity(sql, context.workspaceId, input.activityId) : undefined;
      if (activity && resource.resource.scope.kind === "room" && resource.resource.scope.roomId !== activity.roomId) {
        throw new WorkspaceServerError("workspace_completion_use_cross_room_denied", 403);
      }
      if (episode && resource.resource.scope.kind === "room" && resource.resource.scope.roomId !== episode.roomId) {
        throw new WorkspaceServerError("workspace_completion_use_cross_room_denied", 403);
      }
      if (activity && episode) await this.assertEpisodeContainsActivity(sql, context.workspaceId, episode.id, activity.id);
      if (input.event === "correction" && !input.supersedesUseId) throw new WorkspaceServerError("workspace_completion_use_correction_target_required", 422);
      const inserted = await sql.query<UseRow>(
        `INSERT INTO workspace_completion_uses(workspace_id, id, resource_id, resource_version, activity_id, episode_id, event, outcome, supersedes_use_id, summary)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
        [context.workspaceId, id, resource.resource.id, version.version, activity?.id ?? null, episode?.id ?? null, input.event, input.outcome ?? null, input.supersedesUseId ?? null, input.summary.trim()]
      );
      const use = useFromRow(inserted.rows[0]!);
      // A use may arrive after the result Activity.  Give the catch-up path a
      // new idempotency key rather than treating a previous, empty evaluation
      // job as proof of success.
      const evaluationActivity = episode && (input.event === "actually_used" || input.event === "outcome")
        ? await this.latestEvaluationActivityForEpisode(sql, context.workspaceId, episode.id)
        : undefined;
      const evaluationJob = evaluationActivity
        ? await this.enqueueEvaluationJob(sql, context, episode!, evaluationActivity, use.id)
        : undefined;
      await this.store.insertAudit(sql, context, {
        action: "workspace.completion.use.record", roomId, subjectKind: "completion_resource", subjectId: resource.resource.id,
        afterVersion: version.version,
        details: {
          use_id: use.id,
          event: use.event,
          ...(use.outcome ? { outcome: use.outcome } : {}),
          ...(evaluationJob ? { evaluation_job_id: evaluationJob.id } : {})
        }
      });
      return { use, ...(evaluationJob ? { evaluationJob } : {}) };
    });
    return { ...saved.value, replayed: saved.replayed };
  }

  /** Evaluation is evidence, not a hidden Resource edit. A later correction
   * appends a new row and never reinterprets `unknown` as success. */
  async recordEvaluation(context: WorkspaceRequestContext, input: { id?: string; resourceId: string; resourceVersion: number; episodeId: string; outcome: WorkspaceCompletionEvaluation["outcome"]; sourceActivityId?: string; correctionOfEvaluationId?: string }): Promise<{ evaluation: WorkspaceCompletionEvaluation; replayed: boolean }> {
    assertCompletionId(input.resourceId, "workspace_completion_resource_id_invalid");
    assertExpectedVersion(input.resourceVersion);
    assertCompletionId(input.episodeId, "workspace_completion_episode_id_invalid");
    if (input.sourceActivityId) assertCompletionId(input.sourceActivityId, "workspace_completion_activity_id_invalid");
    if (input.correctionOfEvaluationId) assertCompletionId(input.correctionOfEvaluationId, "workspace_completion_evaluation_id_invalid");
    if (!useOutcomes.has(input.outcome)) throw new WorkspaceServerError("workspace_completion_evaluation_outcome_invalid", 400);
    const id = input.id ?? completionId("completion_evaluation", context.workspaceId, `${context.operationId}:${input.resourceId}:${input.resourceVersion}:${input.episodeId}`);
    assertCompletionId(id, "workspace_completion_evaluation_id_invalid");
    const saved = await this.store.runIdempotentResult(context, { action: "workspace.completion.evaluation.record", input: { ...input, id } }, async (sql) => {
      const resource = await this.selectReadableResource(sql, context.workspaceId, input.resourceId, false);
      const version = await this.selectVersion(sql, context.workspaceId, input.resourceId, input.resourceVersion, true);
      const episode = await this.selectEpisode(sql, context.workspaceId, input.episodeId);
      if (resource.resource.scope.kind === "room" && resource.resource.scope.roomId !== episode.roomId) throw new WorkspaceServerError("workspace_completion_evaluation_cross_room_denied", 403);
      await this.assertPolicyAllowed(sql, context, episode.roomId, "activity.ingest", "execute", { evaluation: true, resource_kind: resource.resource.kind });
      if (input.sourceActivityId) await this.assertEpisodeContainsActivity(sql, context.workspaceId, episode.id, input.sourceActivityId);
      if (input.correctionOfEvaluationId) {
        const correction = await sql.query<EvaluationRow>("SELECT * FROM workspace_completion_evaluations WHERE workspace_id = $1 AND id = $2", [context.workspaceId, input.correctionOfEvaluationId]);
        const prior = correction.rows[0];
        if (!prior || prior.resource_id !== input.resourceId || numeric(prior.resource_version) !== input.resourceVersion || prior.episode_id !== input.episodeId) {
          throw new WorkspaceServerError("workspace_completion_evaluation_correction_target_invalid", 409);
        }
      }
      const inserted = await sql.query<EvaluationRow>(
        `INSERT INTO workspace_completion_evaluations(workspace_id, id, resource_id, resource_version, episode_id, outcome, source_activity_id, correction_of_evaluation_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [context.workspaceId, id, input.resourceId, version.version, episode.id, input.outcome, input.sourceActivityId ?? null, input.correctionOfEvaluationId ?? null]
      );
      const evaluation = evaluationFromRow(inserted.rows[0]!);
      if (input.sourceActivityId) {
        await this.insertEvidence(sql, context.workspaceId, resource.resource.id, version.version, {
          kind: "use_outcome",
          activityId: input.sourceActivityId,
          episodeId: episode.id,
          summary: `Evaluation ${evaluation.id}: ${evaluation.outcome}`
        });
      }
      await this.store.insertAudit(sql, context, {
        action: "workspace.completion.evaluation.record", roomId: episode.roomId, subjectKind: "completion_resource", subjectId: resource.resource.id,
        afterVersion: version.version, details: { evaluation_id: evaluation.id, episode_id: episode.id, outcome: evaluation.outcome }
      });
      return evaluation;
    });
    return { evaluation: saved.value, replayed: saved.replayed };
  }

  async evaluationJobInputHash(
    context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">,
    input: { episodeId: string; activityId: string }
  ): Promise<string> {
    assertCompletionId(input.episodeId, "workspace_completion_episode_id_invalid");
    assertCompletionId(input.activityId, "workspace_completion_activity_id_invalid");
    return this.store.database.withContext(context, async (sql) => {
      const episode = await this.selectEpisode(sql, context.workspaceId, input.episodeId);
      const activity = await this.selectActivity(sql, context.workspaceId, input.activityId);
      await this.assertEpisodeContainsActivity(sql, context.workspaceId, episode.id, activity.id);
      const uses = await this.evaluationUsesForEpisode(sql, context.workspaceId, episode);
      const attested = await this.hasConfirmedActivityAttestation(sql, context.workspaceId, activity);
      return evaluationJobHash(episode, activity, uses, attested);
    });
  }

  /** Applies the deterministic half of an Evaluation Job.  Only an
   * `actually_used`/`outcome` record can produce an Evaluation; selection and
   * body loading remain evidence of access, not evidence of success. */
  async applyEvaluationJob(
    context: WorkspaceRequestContext,
    input: { jobId: string; attemptId: string; workerId: string; expectedInputHash: string }
  ): Promise<{ evaluations: WorkspaceCompletionEvaluation[]; inputHash: string }> {
    assertCompletionId(input.jobId, "workspace_completion_job_id_invalid");
    assertCompletionId(input.attemptId, "workspace_completion_attempt_id_invalid");
    assertCompletionId(input.workerId, "workspace_completion_worker_id_invalid");
    if (!/^[0-9a-f]{64}$/.test(input.expectedInputHash)) throw new WorkspaceServerError("workspace_completion_job_input_hash_invalid", 400);
    return this.store.database.withContext(context, async (sql) => {
      const selected = await sql.query<JobRow>(
        `SELECT * FROM workspace_completion_jobs
         WHERE workspace_id = $1 AND id = $2 AND kind = 'evaluation'
           AND status = 'running' AND lease_owner = $3 AND lease_expires_at >= NOW()
         FOR UPDATE`,
        [context.workspaceId, input.jobId, input.workerId]
      );
      const job = selected.rows[0] ? jobFromRow(selected.rows[0]) : undefined;
      if (!job || !job.groupKey || !job.highWatermark) throw new WorkspaceServerError("workspace_completion_job_lease_lost", 409);
      if (job.inputHash !== input.expectedInputHash) throw new WorkspaceServerError("workspace_completion_evaluation_stale_input", 409);
      const attempt = await sql.query<{ id: string }>(
        `SELECT id FROM workspace_completion_job_attempts
         WHERE workspace_id = $1 AND id = $2 AND job_id = $3 AND worker_id = $4 AND status = 'running'`,
        [context.workspaceId, input.attemptId, job.id, input.workerId]
      );
      if (!attempt.rows[0]) throw new WorkspaceServerError("workspace_completion_job_attempt_lease_lost", 409);
      const episode = await this.selectEpisode(sql, context.workspaceId, job.groupKey);
      if (episode.roomId !== job.roomId) throw new WorkspaceServerError("workspace_completion_evaluation_episode_room_invalid", 409);
      const activity = await this.selectActivity(sql, context.workspaceId, job.highWatermark);
      await this.assertEpisodeContainsActivity(sql, context.workspaceId, episode.id, activity.id);
      if (!isEvaluationActivity(activity)) throw new WorkspaceServerError("workspace_completion_evaluation_stale_input", 409);
      await this.assertPolicyAllowed(sql, context, episode.roomId, "activity.ingest", "execute", { maintenance_job: "evaluation" });
      const used = await this.evaluationUsesForEpisode(sql, context.workspaceId, episode);
      const attested = await this.hasConfirmedActivityAttestation(sql, context.workspaceId, activity);
      const inputHash = evaluationJobHash(episode, activity, used, attested);
      if (inputHash !== input.expectedInputHash) throw new WorkspaceServerError("workspace_completion_evaluation_stale_input", 409);
      const outcome = evaluationOutcomeForActivity(activity, attested);
      const evaluations: WorkspaceCompletionEvaluation[] = [];
      for (const use of used.map(useFromRow)) {
        const resource = await this.selectReadableResource(sql, context.workspaceId, use.resourceId, true);
        if (resource.resource.scope.kind === "room" && resource.resource.scope.roomId !== episode.roomId) continue;
        await this.selectVersion(sql, context.workspaceId, use.resourceId, use.resourceVersion, true);
        const correctionOf = activity.correctionOfActivityId
          ? await this.latestEvaluationForSourceActivity(sql, context.workspaceId, use.resourceId, use.resourceVersion, episode.id, activity.correctionOfActivityId)
          : undefined;
        if (correctionOf && correctionOf.outcome === outcome) continue;
        const id = completionId("completion_evaluation", context.workspaceId, `${job.id}:${use.resourceId}:${use.resourceVersion}`);
        const inserted = correctionOf
          ? await sql.query<EvaluationRow>(
            `INSERT INTO workspace_completion_evaluations(
               workspace_id, id, resource_id, resource_version, episode_id, outcome, source_activity_id, correction_of_evaluation_id
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (workspace_id, id) DO NOTHING RETURNING *`,
            [context.workspaceId, id, use.resourceId, use.resourceVersion, episode.id, outcome, activity.id, correctionOf.id]
          )
          : await sql.query<EvaluationRow>(
            `INSERT INTO workspace_completion_evaluations(
               workspace_id, id, resource_id, resource_version, episode_id, outcome, source_activity_id
             ) VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (workspace_id, resource_id, resource_version, episode_id) WHERE correction_of_evaluation_id IS NULL
             DO NOTHING RETURNING *`,
            [context.workspaceId, id, use.resourceId, use.resourceVersion, episode.id, outcome, activity.id]
          );
        const row = inserted.rows[0];
        if (!row) continue;
        const evaluation = evaluationFromRow(row);
        evaluations.push(evaluation);
        await this.insertEvidence(sql, context.workspaceId, use.resourceId, use.resourceVersion, {
          kind: "use_outcome",
          activityId: activity.id,
          episodeId: episode.id,
          summary: `Evaluation ${evaluation.id}: ${evaluation.outcome}`
        });
        await this.store.insertAudit(sql, context, {
          action: "workspace.completion.evaluation.record",
          roomId: episode.roomId,
          subjectKind: "completion_resource",
          subjectId: use.resourceId,
          afterVersion: use.resourceVersion,
          details: { evaluation_id: evaluation.id, episode_id: episode.id, outcome: evaluation.outcome, job_id: job.id }
        });
      }
      const outputHash = hashText(canonicalJson({
        evaluations: evaluations.map((evaluation) => ({ id: evaluation.id, resource_id: evaluation.resourceId, resource_version: evaluation.resourceVersion, outcome: evaluation.outcome }))
      }));
      const closedAttempt = await sql.query<{ id: string }>(
        `UPDATE workspace_completion_job_attempts SET status = 'completed', output_hash = $5, completed_at = NOW()
         WHERE workspace_id = $1 AND id = $2 AND job_id = $3 AND worker_id = $4 AND status = 'running'
         RETURNING id`,
        [context.workspaceId, input.attemptId, job.id, input.workerId, outputHash]
      );
      if (!closedAttempt.rows[0]) throw new WorkspaceServerError("workspace_completion_job_attempt_lease_lost", 409);
      const closedJob = await sql.query<{ id: string }>(
        `UPDATE workspace_completion_jobs
         SET status = 'completed', lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
             completed_at = NOW(), updated_at = NOW(), updated_by = $4
         WHERE workspace_id = $1 AND id = $2 AND lease_owner = $3 AND status = 'running'
         RETURNING id`,
        [context.workspaceId, job.id, input.workerId, context.accountId]
      );
      if (!closedJob.rows[0]) throw new WorkspaceServerError("workspace_completion_job_lease_lost", 409);
      return {
        evaluations,
        inputHash
      };
    });
  }

  /** Daily catch-up is intentionally bounded and only queues an evaluation
   * when a result Activity and an actual use both exist. */
  async enqueueEvaluationCatchup(
    context: WorkspaceRequestContext,
    input: { roomId?: string; limit?: number } = {}
  ): Promise<number> {
    if (input.roomId) assertOpaqueId(input.roomId, "room_id_invalid");
    const limit = boundedLimit(input.limit);
    const saved = await this.store.runIdempotentResult(context, {
      action: "workspace.completion.evaluation.catchup",
      input: { room_id: input.roomId ?? null, limit }
    }, async (sql) => {
      const candidates = await sql.query<ActivityRow & { episode_id: string }>(
        `SELECT activity.*, episode.id AS episode_id
         FROM workspace_completion_activities activity
         JOIN workspace_completion_episode_activities link
           ON link.workspace_id = activity.workspace_id AND link.activity_id = activity.id
         JOIN workspace_completion_episodes episode
           ON episode.workspace_id = link.workspace_id AND episode.id = link.episode_id
         WHERE activity.workspace_id = $1 AND activity.outcome <> 'cancelled'
           AND ($2::TEXT IS NULL OR activity.room_id = $2)
           AND EXISTS (
             SELECT 1 FROM workspace_completion_uses use_event
             WHERE use_event.workspace_id = activity.workspace_id AND use_event.episode_id = episode.id
               AND use_event.event IN ('actually_used', 'outcome')
           )
           AND EXISTS (
             SELECT 1 FROM workspace_completion_uses use_event
             WHERE use_event.workspace_id = activity.workspace_id AND use_event.episode_id = episode.id
               AND use_event.event IN ('actually_used', 'outcome')
               AND NOT EXISTS (
                 SELECT 1 FROM workspace_completion_evaluations evaluation
                 WHERE evaluation.workspace_id = use_event.workspace_id
                   AND evaluation.resource_id = use_event.resource_id
                   AND evaluation.resource_version = use_event.resource_version
                   AND evaluation.episode_id = episode.id
               )
           )
         ORDER BY activity.finalized_at ASC, activity.id ASC LIMIT $3`,
        [context.workspaceId, input.roomId ?? null, limit]
      );
      let queued = 0;
      for (const row of candidates.rows) {
        const activity = activityFromRow(row);
        const episode = await this.selectEpisode(sql, context.workspaceId, row.episode_id);
        const job = await this.enqueueEvaluationJob(sql, context, episode, activity, `catchup:${activity.id}`);
        if (job.status === "queued") queued += 1;
      }
      return queued;
    });
    return saved.value;
  }

  /** Promote only an already stored AI candidate. The normal confirmed file is
   * replaced as a recoverable batch after independent Episode evidence meets
   * the configured rule; model output never overwrites it directly. */
  async promoteCandidate(context: WorkspaceRequestContext, input: { resourceId: string; expectedVersion: number; reason: string }): Promise<WorkspaceCompletionResourceWriteResult> {
    assertCompletionId(input.resourceId, "workspace_completion_resource_id_invalid");
    assertExpectedVersion(input.expectedVersion);
    assertSafeText(input.reason, "workspace_completion_reason_invalid");
    const prepared = await this.store.database.withContext(context, async (sql) => {
      const resource = await this.selectReadableResource(sql, context.workspaceId, input.resourceId, false);
      if (resource.resource.version !== input.expectedVersion) throwVersionConflict(resource.resource.version);
      if (!resource.resource.candidateVersion) throw new WorkspaceServerError("workspace_completion_candidate_not_found", 409);
      const candidate = await this.selectVersion(sql, context.workspaceId, input.resourceId, resource.resource.candidateVersion, true);
      const confirmed = resource.resource.currentConfirmedVersion
        ? await this.selectVersion(sql, context.workspaceId, input.resourceId, resource.resource.currentConfirmedVersion, true)
        : undefined;
      return { resource: resource.resource, candidate, confirmed };
    });
    const candidateContent = await this.files.read(context.workspaceId, prepared.candidate.filePath, prepared.candidate.contentHash);
    const candidateDocument = parseWorkspaceCompletionDocument(candidateContent);
    const entries: Array<{ path: string; content: Uint8Array }> = [];
    if (prepared.confirmed) {
      const oldContent = await this.files.read(context.workspaceId, prepared.confirmed.filePath, prepared.confirmed.contentHash);
      entries.push({ path: completionResourcePath({ id: prepared.resource.id, kind: prepared.resource.kind, scope: prepared.resource.scope, version: prepared.confirmed.version }), content: oldContent });
    }
    entries.push({ path: completionResourcePath({ id: prepared.resource.id, kind: prepared.resource.kind, scope: prepared.resource.scope }), content: candidateContent });
    const batch = await this.files.stage(context.workspaceId, prepared.resource.scope, entries);
    try {
      const saved = await this.executeBatch(context, batch, { action: "workspace.completion.resource.promote", input }, async (sql) => {
        const current = await this.selectResourceForUpdate(sql, context.workspaceId, input.resourceId);
        if (!current) throw new WorkspaceServerError("workspace_completion_resource_not_found", 404);
        if (current.version !== input.expectedVersion) throwVersionConflict(current.version);
        await this.assertPolicyAllowed(sql, context, scopeRoom(current.scope), "resource.promote", authorityForScope(current.scope), { resource_kind: current.kind });
        if (current.aiProtection === "fixed") throw new WorkspaceServerError("workspace_completion_resource_fixed", 409);
        if (!current.candidateVersion) throw new WorkspaceServerError("workspace_completion_candidate_not_found", 409);
        const candidate = await this.selectVersion(sql, context.workspaceId, current.id, current.candidateVersion, true);
        await this.assertPromotionEligible(sql, context.workspaceId, current, candidate);
        const confirmed = current.currentConfirmedVersion ? await this.selectVersion(sql, context.workspaceId, current.id, current.currentConfirmedVersion, true) : undefined;
        if (confirmed) {
          await sql.query("UPDATE workspace_completion_resource_versions SET file_path = $3 WHERE workspace_id = $1 AND id = $2", [context.workspaceId, confirmed.id, completionResourcePath({ id: current.id, kind: current.kind, scope: current.scope, version: confirmed.version })]);
        }
        const nextVersion = current.version + 1;
        const updated = await sql.query<ResourceRow>(
          `UPDATE workspace_completion_resources
           SET title = $3, version = $4, evidence_state = 'confirmed', lifecycle_state = 'active', archived_at = NULL,
               current_confirmed_version = $4, current_provisional_version = NULL, candidate_version = NULL,
               updated_by = $5, updated_at = NOW()
           WHERE workspace_id = $1 AND id = $2 RETURNING *`,
          [context.workspaceId, current.id, candidateDocument.title, nextVersion, context.accountId]
        );
        const resource = resourceFromRow(updated.rows[0]!);
        await this.insertVersion(sql, context, resource, {
          version: nextVersion, parentVersion: candidate.version, path: completionResourcePath({ id: resource.id, kind: resource.kind, scope: resource.scope }), content: candidateContent,
          evidenceState: "confirmed", lifecycleState: "active", aiProtection: resource.aiProtection, creationSource: "ai", metadata: candidate.metadata, reason: input.reason.trim(), batchId: batch.id
        });
        const sourceEvidence = await sql.query<EvidenceRow>(
          "SELECT * FROM workspace_completion_evidence WHERE workspace_id = $1 AND resource_id = $2 AND resource_version = $3 AND activity_id IS NOT NULL ORDER BY created_at, id",
          [context.workspaceId, resource.id, candidate.version]
        );
        if (sourceEvidence.rows.length === 0) throw new WorkspaceServerError("workspace_completion_candidate_evidence_missing", 409);
        for (const evidence of sourceEvidence.rows) {
          await this.insertEvidence(sql, context.workspaceId, resource.id, nextVersion, { kind: "activity", activityId: evidence.activity_id ?? undefined, ...(evidence.episode_id ? { episodeId: evidence.episode_id } : {}), summary: input.reason.trim() });
        }
        await this.store.insertAudit(sql, context, {
          action: "workspace.completion.resource.promote", ...(resource.scope.roomId ? { roomId: resource.scope.roomId } : {}),
          subjectKind: "completion_resource", subjectId: resource.id, beforeVersion: current.version, afterVersion: resource.version,
          details: { candidate_version: candidate.version }
        });
        return resource;
      });
      return { resource: saved.value, replayed: saved.replayed };
    } catch (error) {
      await this.files.rollback(batch).catch(() => undefined);
      throw error;
    }
  }

  async updateConfiguration(context: WorkspaceRequestContext, input: { scope: WorkspaceCompletionScope; expectedVersion?: number; values: unknown }): Promise<{ configuration: WorkspaceCompletionConfiguration; replayed: boolean }> {
    assertScope(input.scope);
    const values = validateWorkspaceCompletionTuning(input.values);
    const scopeKey = input.scope.kind === "workspace" ? "workspace" : input.scope.roomId!;
    const saved = await this.store.runIdempotentResult(context, { action: "workspace.completion.configuration.update", input: { scope: input.scope, expectedVersion: input.expectedVersion, values } }, async (sql) => {
      const authority = authorityForScope(input.scope);
      await this.assertPolicyAllowed(sql, context, scopeRoom(input.scope), "resource.update", authority, { configuration: true });
      const current = await sql.query<ConfigurationRow>(
        `SELECT * FROM workspace_completion_configurations WHERE workspace_id = $1 AND scope_key = $2 ORDER BY version DESC LIMIT 1 FOR UPDATE`,
        [context.workspaceId, scopeKey]
      );
      const currentVersion = current.rows[0] ? numeric(current.rows[0].version) : 0;
      if (input.expectedVersion !== undefined && input.expectedVersion !== currentVersion) throwVersionConflict(currentVersion || null);
      const nextVersion = currentVersion + 1;
      const inserted = await sql.query<ConfigurationRow>(
        `INSERT INTO workspace_completion_configurations(workspace_id, scope_key, scope_kind, room_id, version, values, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6::JSONB, $7) RETURNING *`,
        [context.workspaceId, scopeKey, input.scope.kind, input.scope.roomId ?? null, nextVersion, canonicalJson(values), context.accountId]
      );
      const configuration = configurationFromRow(inserted.rows[0]!);
      await this.store.insertAudit(sql, context, {
        action: "workspace.completion.configuration.update", ...(input.scope.roomId ? { roomId: input.scope.roomId } : {}),
        subjectKind: "completion_configuration", subjectId: scopeKey, beforeVersion: currentVersion || undefined, afterVersion: nextVersion
      });
      return configuration;
    });
    return { configuration: saved.value, replayed: saved.replayed };
  }

  async getEffectiveConfiguration(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, roomId: string): Promise<WorkspaceCompletionConfiguration> {
    assertOpaqueId(roomId, "room_id_invalid");
    return this.store.database.withContext(context, async (sql) => {
      const result = await sql.query<ConfigurationRow>(
        `SELECT * FROM workspace_completion_configurations
         WHERE workspace_id = $1 AND scope_key IN ('workspace', $2)
         ORDER BY CASE scope_key WHEN $2 THEN 1 ELSE 0 END DESC, version DESC`,
        [context.workspaceId, roomId]
      );
      const room = result.rows.find((row) => row.scope_key === roomId);
      const workspace = result.rows.find((row) => row.scope_key === "workspace");
      if (room) return configurationFromRow(room);
      if (workspace) return configurationFromRow(workspace);
      return {
        workspaceId: context.workspaceId,
        scope: { kind: "workspace" },
        version: 1,
        values: defaultTuning(),
        updatedBy: "built_in",
        createdAt: new Date(0).toISOString()
      };
    });
  }

  /** AI and connected apps can call this method, but it only stores a request.
   * It never creates an enabled Policy or a rule that the Server evaluates. */
  async requestPolicyChange(context: WorkspaceRequestContext, input: WorkspaceCompletionPolicyChangeRequestInput): Promise<{ id: string; replayed: boolean }> {
    assertOpaqueId(input.roomId, "room_id_invalid");
    assertSafeText(input.summary, "workspace_completion_policy_request_summary_invalid");
    const proposedRules = validateWorkspaceCompletionPolicyRules(input.proposedRules);
    if (input.sourceJobId) assertCompletionId(input.sourceJobId, "workspace_completion_job_id_invalid");
    const id = input.id ?? completionId("completion_policy_request", context.workspaceId, context.operationId);
    assertCompletionId(id, "workspace_completion_policy_request_id_invalid");
    const saved = await this.store.runIdempotentResult(context, {
      action: "workspace.completion.policy.request", input: { ...input, id, proposedRules }
    }, async (sql) => {
      await this.assertPolicyAllowed(sql, context, input.roomId, "activity.ingest", "execute", { policy_change_request: true });
      await sql.query(
        `INSERT INTO workspace_completion_policy_change_requests(workspace_id, room_id, id, requested_by, source_job_id, summary, proposed_rules)
         VALUES ($1, $2, $3, $4, $5, $6, $7::JSONB)`,
        [context.workspaceId, input.roomId, id, context.accountId, input.sourceJobId ?? null, input.summary.trim(), canonicalJson(proposedRules)]
      );
      await this.store.insertAudit(sql, context, {
        action: "workspace.completion.policy.request", roomId: input.roomId, subjectKind: "completion_policy_change_request", subjectId: id
      });
      return { id };
    });
    return { id: saved.value.id, replayed: saved.replayed };
  }

  async listPolicyChangeRequests(
    context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">,
    input: { roomId?: string; limit?: number } = {}
  ): Promise<WorkspaceCompletionPolicyChangeRequest[]> {
    if (input.roomId) assertOpaqueId(input.roomId, "room_id_invalid");
    const limit = boundedLimit(input.limit);
    return this.store.database.withContext(context, async (sql) => {
      const rows = await sql.query<PolicyChangeRequestRow>(
        `SELECT * FROM workspace_completion_policy_change_requests
         WHERE workspace_id = $1 AND ($2::TEXT IS NULL OR room_id = $2)
         ORDER BY created_at DESC, id DESC LIMIT $3`,
        [context.workspaceId, input.roomId ?? null, limit]
      );
      return rows.rows.map(policyChangeRequestFromRow);
    });
  }

  /** A human-authenticated HTTP/Command caller must explicitly provide a
   * verified request Context. Review workers are deliberately not given this
   * method, and a request body can never supply this proof. */
  async applyPolicy(context: WorkspaceRequestContext, input: WorkspaceCompletionPolicyInput): Promise<WorkspaceCompletionResourceWriteResult> {
    validatePolicyInput(input);
    const approval = trustedHumanPolicyApproval(context);
    const rules = validateWorkspaceCompletionPolicyRules(input.rules);
    const resourceId = input.id ?? completionId("completion_policy", context.workspaceId, context.operationId);
    assertCompletionId(resourceId, "workspace_completion_policy_id_invalid");
    const expectedVersion = input.expectedVersion ?? 0;
    assertExpectedVersion(expectedVersion, true);
    const existing = expectedVersion > 0 ? await this.readResourceForWrite(context, resourceId) : undefined;
    if (existing && existing.resource.kind !== "policy") throw new WorkspaceServerError("workspace_completion_policy_identity_change_forbidden", 409);
    const nextVersion = expectedVersion + 1;
    const targetPath = completionResourcePath({ id: resourceId, kind: "policy", scope: input.scope });
    const approvalId = completionId("completion_policy_approval", context.workspaceId, `${resourceId}:${nextVersion}:${approval.requestId}`);
    const metadata: WorkspaceRecordPayload = { rules, enabled: input.enabled !== false, approval_id: approvalId };
    const rendered = renderWorkspaceCompletionDocument({ id: resourceId, title: input.title.trim(), resourceKind: "policy", metadata, body: input.content.trim() });
    const entries: Array<{ path: string; content: Uint8Array }> = [];
    if (existing) {
      const previous = await this.files.read(context.workspaceId, existing.version.filePath, existing.version.contentHash);
      entries.push({ path: completionResourcePath({ id: resourceId, kind: "policy", scope: input.scope, version: existing.version.version }), content: previous });
    }
    entries.push({ path: targetPath, content: rendered });
    const batch = await this.files.stage(context.workspaceId, input.scope, entries);
    try {
      const saved = await this.executeBatch(context, batch, {
        action: "workspace.completion.policy.apply", input: { ...input, id: resourceId, expectedVersion, rules }
      }, async (sql) => {
        const current = await this.selectResourceForUpdate(sql, context.workspaceId, resourceId);
        await this.assertPolicyAllowed(sql, context, scopeRoom(input.scope), "policy.apply", authorityForScope(input.scope), { policy_scope: input.scope.kind, human_approval: true });
        if (!current) {
          if (expectedVersion !== 0) throwVersionConflict(null);
          const inserted = await sql.query<ResourceRow>(
            `INSERT INTO workspace_completion_resources(
               workspace_id, id, scope_kind, room_id, resource_kind, title, evidence_state, lifecycle_state,
               ai_protection, creation_source, ai_managed, version, current_confirmed_version, created_by, updated_by
             ) VALUES ($1, $2, $3, $4, 'policy', $5, 'confirmed', 'active', 'editable', 'human', FALSE, $6, $6, $7, $7)
             RETURNING *`,
            [context.workspaceId, resourceId, input.scope.kind, input.scope.roomId ?? null, input.title.trim(), nextVersion, context.accountId]
          );
          const resource = resourceFromRow(inserted.rows[0]!);
          await this.insertVersion(sql, context, resource, {
            version: nextVersion, path: targetPath, content: rendered, evidenceState: "confirmed", lifecycleState: "active", aiProtection: "editable", creationSource: "human", metadata, reason: input.reason.trim(), batchId: batch.id
          });
          await this.insertEvidence(sql, context.workspaceId, resource.id, nextVersion, { kind: "human_edit", summary: input.reason.trim() });
          await this.store.insertAudit(sql, context, { action: "workspace.completion.policy.apply", ...(resource.scope.roomId ? { roomId: resource.scope.roomId } : {}), subjectKind: "completion_policy", subjectId: resource.id, afterVersion: nextVersion });
          await this.insertPolicyApproval(sql, context, resource, nextVersion, approvalId, approval, {
            enabled: input.enabled !== false,
            rules,
            content_hash: hashBytes(rendered)
          });
          await this.insertPolicyRules(sql, context, resource, nextVersion, rules, approval.signature, input.enabled !== false);
          return resource;
        }
        if (current.version !== expectedVersion) throwVersionConflict(current.version);
        if (current.kind !== "policy" || current.scope.kind !== input.scope.kind || current.scope.roomId !== input.scope.roomId) {
          throw new WorkspaceServerError("workspace_completion_policy_identity_change_forbidden", 409);
        }
        const previous = await this.currentVersionForResource(sql, context.workspaceId, current, true);
        await sql.query("UPDATE workspace_completion_resource_versions SET file_path = $3 WHERE workspace_id = $1 AND id = $2", [context.workspaceId, previous.id, completionResourcePath({ id: current.id, kind: "policy", scope: current.scope, version: previous.version })]);
        const updated = await sql.query<ResourceRow>(
          `UPDATE workspace_completion_resources
           SET title = $3, version = $4, evidence_state = 'confirmed', lifecycle_state = 'active', archived_at = NULL,
               current_confirmed_version = $4, current_provisional_version = NULL, candidate_version = NULL,
               updated_by = $5, updated_at = NOW()
           WHERE workspace_id = $1 AND id = $2 RETURNING *`,
          [context.workspaceId, current.id, input.title.trim(), nextVersion, context.accountId]
        );
        const resource = resourceFromRow(updated.rows[0]!);
        await this.insertVersion(sql, context, resource, {
          version: nextVersion, parentVersion: previous.version, path: targetPath, content: rendered, evidenceState: "confirmed", lifecycleState: "active", aiProtection: current.aiProtection, creationSource: "human", metadata, reason: input.reason.trim(), batchId: batch.id
        });
        await this.insertEvidence(sql, context.workspaceId, resource.id, nextVersion, { kind: "human_edit", summary: input.reason.trim() });
        await this.store.insertAudit(sql, context, { action: "workspace.completion.policy.apply", ...(resource.scope.roomId ? { roomId: resource.scope.roomId } : {}), subjectKind: "completion_policy", subjectId: resource.id, beforeVersion: current.version, afterVersion: resource.version });
        await this.insertPolicyApproval(sql, context, resource, nextVersion, approvalId, approval, {
          enabled: input.enabled !== false,
          rules,
          content_hash: hashBytes(rendered)
        });
        await this.insertPolicyRules(sql, context, resource, nextVersion, rules, approval.signature, input.enabled !== false);
        return resource;
      });
      return { resource: saved.value, replayed: saved.replayed };
    } catch (error) {
      await this.files.rollback(batch).catch(() => undefined);
      throw error;
    }
  }

  /** PROFILE and SOUL have their own narrow human-only command.  Review,
   * promotion, Curator, physical import, and Policy requests cannot call it. */
  async writeWorkspaceDocument(context: WorkspaceRequestContext, input: { kind: "profile" | "soul"; content: string; expectedVersion: number }): Promise<{ version: number; replayed: boolean }> {
    if (input.kind !== "profile" && input.kind !== "soul") throw new WorkspaceServerError("workspace_completion_document_kind_invalid", 400);
    assertSafeText(input.content, "workspace_completion_workspace_document_invalid");
    assertExpectedVersion(input.expectedVersion, true);
    const path = input.kind === "profile" ? "profile/PROFILE.md" : "profile/SOUL.md";
    const previous = await this.readWorkspaceDocumentMetadata(context, input.kind).catch((error) => {
      if (error instanceof WorkspaceServerError && error.code === "workspace_completion_workspace_document_not_found") return undefined;
      throw error;
    });
    const entries: Array<{ path: string; content: Uint8Array }> = [];
    if (previous) {
      const body = await this.files.read(context.workspaceId, previous.filePath, previous.contentHash);
      entries.push({ path: `.versions/${input.kind}/${previous.version}.md`, content: body });
    }
    const body = Buffer.from(`${input.content.trim()}\n`, "utf8");
    entries.push({ path, content: body });
    const batch = await this.files.stage(context.workspaceId, { kind: "workspace" }, entries);
    try {
      const saved = await this.executeBatch(context, batch, {
        action: `workspace.completion.${input.kind}.write`, input: { kind: input.kind, content_hash: hashBytes(body), expectedVersion: input.expectedVersion }
      }, async (sql) => {
        await this.assertPolicyAllowed(sql, context, undefined, "resource.update", "admin", { workspace_document: input.kind, human: true });
        const current = await sql.query<WorkspaceDocumentRow>(
          "SELECT * FROM workspace_completion_workspace_documents WHERE workspace_id = $1 AND kind = $2 FOR UPDATE",
          [context.workspaceId, input.kind]
        );
        const currentVersion = current.rows[0] ? numeric(current.rows[0].version) : 0;
        if (currentVersion !== input.expectedVersion) throwVersionConflict(currentVersion || null);
        const nextVersion = currentVersion + 1;
        const updated = await sql.query<WorkspaceDocumentRow>(
          `INSERT INTO workspace_completion_workspace_documents(workspace_id, kind, file_path, content_hash, content_size, version, file_batch_id, updated_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (workspace_id, kind) DO UPDATE SET content_hash = EXCLUDED.content_hash, content_size = EXCLUDED.content_size,
             version = EXCLUDED.version, file_batch_id = EXCLUDED.file_batch_id, updated_by = EXCLUDED.updated_by, updated_at = NOW()
           WHERE workspace_completion_workspace_documents.version = $9
           RETURNING *`,
          [context.workspaceId, input.kind, path, hashBytes(body), body.byteLength, nextVersion, batch.id, context.accountId, currentVersion]
        );
        if (!updated.rows[0]) throwVersionConflict(currentVersion);
        await this.store.insertAudit(sql, context, {
          action: `workspace.completion.${input.kind}.write`, subjectKind: "workspace_document", subjectId: input.kind,
          beforeVersion: currentVersion || undefined, afterVersion: nextVersion
        });
        return { version: nextVersion };
      });
      return { version: saved.value.version, replayed: saved.replayed };
    } catch (error) {
      await this.files.rollback(batch).catch(() => undefined);
      throw error;
    }
  }

  async getWorkspaceDocument(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, kind: "profile" | "soul"): Promise<{ version: number; content: string }> {
    if (kind !== "profile" && kind !== "soul") throw new WorkspaceServerError("workspace_completion_document_kind_invalid", 400);
    const metadata = await this.readWorkspaceDocumentMetadata(context, kind);
    const content = await this.files.read(context.workspaceId, metadata.filePath, metadata.contentHash);
    return { version: metadata.version, content: content.toString("utf8") };
  }

  async getStartupContext(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, input: { roomId: string; operation: WorkspaceCompletionPolicyOperation; attributes?: WorkspaceCompletionPolicyEvaluationInput["attributes"] }): Promise<WorkspaceCompletionStartupContext> {
    assertOpaqueId(input.roomId, "room_id_invalid");
    const policy = await this.store.database.withContext(context, async (sql) => {
      const policy = await this.evaluatePolicy(sql, context, input.roomId, input.operation, true, input.attributes ?? {});
      return policy;
    });
    const [profile, soul] = await Promise.all([
      this.getWorkspaceDocument(context, "profile").then((document) => document.content).catch(optionalWorkspaceDocument),
      this.getWorkspaceDocument(context, "soul").then((document) => document.content).catch(optionalWorkspaceDocument)
    ]);
    return { ...(profile ? { profile } : {}), ...(soul ? { soul } : {}), policy };
  }

  /** Reads the entire Skill package before any target file is staged.  File
   * reads verify each declared hash and reject a symlink/path escape through
   * the File Service.  The same DB shape is checked again during the target
   * transaction by `assertPackageSnapshotInTransaction`. */
  private async readPackageSnapshot(
    context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">,
    resourceId: string,
    expectedVersion: number
  ): Promise<WorkspaceCompletionSkillPackageSnapshot> {
    const source = await this.getResourceBody(context, resourceId);
    if (source.resource.version !== expectedVersion || source.version.version !== expectedVersion) throwVersionConflict(source.resource.version);
    const supportMetadata = source.resource.kind === "skill"
      ? await this.listSkillFiles(context, source.resource.id, source.version.version, maxPage)
      : [];
    const supportFiles = await Promise.all(supportMetadata.map(async (file) => ({
      relativePath: assertSkillSupportRelativePath(file.relativePath),
      filePath: file.filePath,
      contentHash: file.contentHash,
      contentSize: file.contentSize,
      content: await this.files.read(context.workspaceId, file.filePath, file.contentHash)
    })));
    const packageHash = skillPackageHash(source.resource.kind, source.version.contentHash, supportFiles);
    return { ...source, supportFiles, packageHash };
  }

  private async assertPackageSnapshotInTransaction(
    sql: WorkspaceSql,
    workspaceId: string,
    snapshot: WorkspaceCompletionSkillPackageSnapshot
  ): Promise<void> {
    const resource = await this.selectResourceForUpdate(sql, workspaceId, snapshot.resource.id);
    if (!resource || resource.version !== snapshot.version.version || resource.kind !== snapshot.resource.kind) {
      throw new WorkspaceServerError("workspace_completion_skill_package_stale", 409);
    }
    const version = await this.selectVersion(sql, workspaceId, resource.id, resource.version, true);
    if (version.contentHash !== snapshot.version.contentHash) throw new WorkspaceServerError("workspace_completion_skill_package_stale", 409);
    const files = resource.kind === "skill"
      ? await sql.query<SkillFileRow>(
        `SELECT * FROM workspace_completion_skill_files
         WHERE workspace_id = $1 AND resource_id = $2 AND resource_version = $3
         ORDER BY relative_path ASC FOR UPDATE`,
        [workspaceId, resource.id, version.version]
      )
      : { rows: [] as SkillFileRow[] };
    const current = files.rows.map((file) => ({
      relativePath: assertSkillSupportRelativePath(file.relative_path),
      contentHash: file.content_hash,
      contentSize: numeric(file.content_size)
    }));
    const expected = snapshot.supportFiles.map((file) => ({
      relativePath: file.relativePath,
      contentHash: file.contentHash,
      contentSize: file.contentSize
    }));
    if (skillPackageHash(resource.kind, version.contentHash, current) !== snapshot.packageHash
      || skillPackageHash(resource.kind, snapshot.version.contentHash, expected) !== snapshot.packageHash) {
      throw new WorkspaceServerError("workspace_completion_skill_package_stale", 409);
    }
  }

  private async readPhysicalEditableResource(
    context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">,
    resourceId: string
  ): Promise<{ current: WorkspaceCompletionReadResource; supportFiles: readonly WorkspaceCompletionSkillFile[]; batchScope: WorkspaceCompletionScope }> {
    await this.assertSelfHostPhysicalOwner(context);
    const current = await this.readResourceForWrite(context, resourceId);
    if (current.resource.kind === "policy") {
      // A local file must not become a way to change an enforced Policy
      // without the mandatory human signature in applyPolicy().
      throw new WorkspaceServerError("workspace_completion_physical_policy_import_forbidden", 403);
    }
    const expectedPath = completionResourcePath({ id: current.resource.id, kind: current.resource.kind, scope: current.resource.scope });
    if (current.version.filePath !== expectedPath) {
      throw new WorkspaceServerError("workspace_completion_physical_import_state_invalid", 409);
    }
    const supportFiles = current.resource.kind === "skill"
      ? await this.listSkillFiles(context, current.resource.id, current.version.version, maxPage)
      : [];
    for (const file of supportFiles) {
      if (file.filePath !== completionSkillSupportPath({ id: current.resource.id, relativePath: file.relativePath })) {
        throw new WorkspaceServerError("workspace_completion_physical_import_state_invalid", 409);
      }
    }
    return {
      current,
      supportFiles,
      batchScope: current.resource.scope
    };
  }

  private async assertSelfHostPhysicalOwner(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">): Promise<void> {
    if (this.store.mode !== "self_host" || this.store.selfHostWorkspaceId !== context.workspaceId) {
      throw new WorkspaceServerError("workspace_completion_physical_import_self_host_required", 403);
    }
    await this.store.database.withContext(context, async (sql) => {
      const owner = await sql.query<{ allowed: boolean }>("SELECT samurai_can_workspace($1, 'owner') AS allowed", [context.workspaceId]);
      if (owner.rows[0]?.allowed !== true) throw new WorkspaceServerError("workspace_completion_physical_import_owner_required", 403);
    });
  }

  private async inspectPhysicalImportFile(
    workspaceId: string,
    relativePath: string,
    missingCode: "workspace_completion_physical_resource_missing" | "workspace_completion_physical_skill_package_layout_changed"
  ): Promise<{ content: Buffer; sha256: string }> {
    try {
      return await this.files.inspectPhysicalFile(workspaceId, relativePath);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        throw new WorkspaceServerError(missingCode, 409, { path: relativePath });
      }
      throw error;
    }
  }

  private async requirePhysicalImportHistory(
    workspaceId: string,
    prepared: { current: WorkspaceCompletionReadResource; supportFiles: readonly WorkspaceCompletionSkillFile[] }
  ): Promise<void> {
    const resourcePath = completionResourcePath({
      id: prepared.current.resource.id,
      kind: prepared.current.resource.kind,
      scope: prepared.current.resource.scope,
      version: prepared.current.version.version
    });
    await this.readPhysicalImportHistory(workspaceId, resourcePath, prepared.current.version.contentHash);
    for (const file of prepared.supportFiles) {
      await this.readPhysicalImportHistory(
        workspaceId,
        completionSkillSupportPath({ id: prepared.current.resource.id, relativePath: file.relativePath, version: prepared.current.version.version }),
        file.contentHash
      );
    }
  }

  private async readPhysicalImportHistory(workspaceId: string, relativePath: string, expectedHash: string): Promise<Buffer> {
    try {
      return await this.files.read(workspaceId, relativePath, expectedHash);
    } catch (error) {
      throw new WorkspaceServerError("workspace_completion_physical_import_history_missing", 409, { path: relativePath });
    }
  }

  protected async writeResource(
    context: WorkspaceRequestContext,
    input: WorkspaceCompletionResourceInput,
    options: {
      creationSource: WorkspaceCompletionCreationSource;
      action: string;
      createOperation?: WorkspaceCompletionPolicyOperation;
      updateOperation?: WorkspaceCompletionPolicyOperation;
      linkFromResourceId?: string;
      linkRelation?: WorkspaceCompletionResourceLink["relation"];
      /** Snapshot read before file staging and rechecked under the target DB
       * transaction. Copy/Move therefore cannot publish a half-old package. */
      sourcePackage?: WorkspaceCompletionSkillPackageSnapshot;
      archiveSource?: { resourceId: string; expectedVersion: number; expectedContentHash: string; expectedPackageHash: string; reason: string };
      physicalChecks?: readonly { path: string; sha256: string }[];
    }
  ): Promise<WorkspaceCompletionResourceWriteResult> {
    validateResourceInput(input, options.creationSource);
    const resourceId = input.id ?? completionId("completion_resource", context.workspaceId, context.operationId);
    assertCompletionId(resourceId, "workspace_completion_resource_id_invalid");
    const expectedVersion = input.expectedVersion ?? 0;
    assertExpectedVersion(expectedVersion, true);
    const existing = expectedVersion > 0 ? await this.readResourceForWrite(context, resourceId) : undefined;
    const nextVersion = expectedVersion + 1;
    const candidate = options.creationSource === "ai";
    const physicalImport = options.creationSource === "physical_file_import";
    const supportFiles = normalizeSkillSupportFiles(input.kind, input.supportFiles);
    const targetPath = candidate
      ? completionResourcePath({ id: resourceId, kind: input.kind, scope: input.scope, version: nextVersion, candidate: true })
      : completionResourcePath({ id: resourceId, kind: input.kind, scope: input.scope });
    const rendered = renderWorkspaceCompletionDocument({ id: resourceId, title: input.title.trim(), resourceKind: input.kind, metadata: input.metadata, body: input.content.trim() });
    const entries: Array<{ path: string; content: Uint8Array }> = [];
    if (physicalImport) {
      if (!existing || !options.physicalChecks || options.physicalChecks.length === 0) {
        throw new WorkspaceServerError("workspace_completion_physical_import_state_invalid", 409);
      }
      for (const check of options.physicalChecks) {
        const physical = await this.inspectPhysicalImportFile(context.workspaceId, check.path, "workspace_completion_physical_resource_missing");
        if (physical.sha256 !== check.sha256) {
          throw new WorkspaceServerError("workspace_completion_physical_import_changed_during_import", 409, { path: check.path });
        }
      }
    }
    if (existing && !candidate) {
      const previousPath = completionResourcePath({ id: resourceId, kind: existing.resource.kind, scope: existing.resource.scope, version: existing.version.version });
      const previous = physicalImport
        ? await this.readPhysicalImportHistory(context.workspaceId, previousPath, existing.version.contentHash)
        : await this.files.read(context.workspaceId, existing.version.filePath, existing.version.contentHash);
      if (!physicalImport) entries.push({ path: previousPath, content: previous });
      if (existing.resource.kind === "skill") {
        const previousSupport = await this.listSkillFiles({ workspaceId: context.workspaceId, accountId: context.accountId }, existing.resource.id, existing.version.version, maxPage);
        for (const file of previousSupport) {
          const previousSupportPath = completionSkillSupportPath({ id: existing.resource.id, relativePath: file.relativePath, version: existing.version.version });
          const content = physicalImport
            ? await this.readPhysicalImportHistory(context.workspaceId, previousSupportPath, file.contentHash)
            : await this.files.read(context.workspaceId, file.filePath, file.contentHash);
          if (!physicalImport) entries.push({ path: previousSupportPath, content });
        }
      }
    }
    entries.push({ path: targetPath, content: rendered });
    if (!candidate) {
      entries.push({ path: completionResourcePath({ id: resourceId, kind: input.kind, scope: input.scope, version: nextVersion }), content: rendered });
    }
    for (const file of supportFiles) {
      entries.push({
        path: completionSkillSupportPath({ id: resourceId, relativePath: file.path, ...(candidate ? { version: nextVersion, candidate: true } : {}) }),
        content: file.content
      });
      if (!candidate) {
        entries.push({
          path: completionSkillSupportPath({ id: resourceId, relativePath: file.path, version: nextVersion }),
          content: file.content
        });
      }
    }
    const batch = await this.files.stage(context.workspaceId, input.scope, entries);
    try {
      const saved = await this.executeBatch(context, batch, { action: options.action, input: { ...input, id: resourceId, expectedVersion, creationSource: options.creationSource } }, async (sql) => {
        if (options.creationSource === "ai") await this.assertAiEvidenceScope(sql, context.workspaceId, input);
        const current = await this.selectResourceForUpdate(sql, context.workspaceId, resourceId);
        if (!current) {
          if (expectedVersion !== 0) throwVersionConflict(null);
          if (options.sourcePackage) await this.assertPackageSnapshotInTransaction(sql, context.workspaceId, options.sourcePackage);
          await this.assertPolicyAllowed(sql, context, scopeRoom(input.scope), options.createOperation ?? "resource.create", authorityForScope(input.scope), { resource_kind: input.kind });
          const resource = await this.insertNewResource(sql, context, resourceId, input, options.creationSource, batch, targetPath, nextVersion, supportFiles);
          if (options.linkFromResourceId && options.linkRelation) await this.insertLink(sql, context.workspaceId, resource.id, options.linkFromResourceId, options.linkRelation);
          if (options.archiveSource) await this.archiveMovedSource(sql, context, options.archiveSource);
          await this.store.insertAudit(sql, context, {
            action: options.action, ...(resource.scope.roomId ? { roomId: resource.scope.roomId } : {}), subjectKind: "completion_resource", subjectId: resource.id,
            afterVersion: resource.version, details: { resource_kind: resource.kind, creation_source: options.creationSource }
          });
          return resource;
        }
        if (current.version !== expectedVersion) throwVersionConflict(current.version);
        if (current.kind !== input.kind || current.scope.kind !== input.scope.kind || current.scope.roomId !== input.scope.roomId || current.knowledgeKind !== input.knowledgeKind) {
          throw new WorkspaceServerError("workspace_completion_resource_identity_change_forbidden", 409);
        }
        await this.assertPolicyAllowed(sql, context, scopeRoom(current.scope), options.updateOperation ?? "resource.update", authorityForScope(current.scope), { resource_kind: current.kind, creation_source: options.creationSource });
        if (options.creationSource === "ai" && current.aiProtection === "fixed") throw new WorkspaceServerError("workspace_completion_resource_fixed", 409);
        const resource = await this.insertUpdatedVersion(sql, context, current, input, options.creationSource, batch, targetPath, nextVersion, supportFiles);
        await this.store.insertAudit(sql, context, {
          action: options.action, ...(resource.scope.roomId ? { roomId: resource.scope.roomId } : {}), subjectKind: "completion_resource", subjectId: resource.id,
          beforeVersion: current.version, afterVersion: resource.version, details: { candidate }
        });
        return resource;
      });
      return { resource: saved.value, replayed: saved.replayed };
    } catch (error) {
      await this.files.rollback(batch).catch(() => undefined);
      throw error;
    }
  }

  private async applyReviewInTransaction(
    sql: WorkspaceSql,
    context: WorkspaceRequestContext,
    input: ApplyWorkspaceCompletionReviewInput,
    result: WorkspaceCompletionReviewResult,
    prepared: readonly PreparedReviewDocument[],
    batch?: StagedWorkspaceCompletionFileBatch
  ): Promise<{ resources: WorkspaceCompletionResource[]; policyRequestIds: string[] }> {
    // This is intentionally inside the Resource/Job transaction.  A
    // preflight check in the worker is useful feedback, but cannot close the
    // race between a human edit and the actual save.
    await this.assertReviewJobSnapshotInTransaction(sql, context, input);
    await this.assertReviewSnapshotCurrentInTransaction(sql, context, input.snapshot);
    await this.assertPolicyAllowed(sql, context, input.snapshot.roomId, "activity.ingest", "execute", { review: true });
    const resources: WorkspaceCompletionResource[] = [];
    const policyRequestIds: string[] = [];
    for (const document of prepared) {
      await this.assertAiEvidenceScope(sql, context.workspaceId, document.resource);
      const current = await this.selectResourceForUpdate(sql, context.workspaceId, document.resource.id);
      let resource: WorkspaceCompletionResource;
      if (!current) {
        if (document.resource.expectedVersion !== 0) throwVersionConflict(null);
        await this.assertPolicyAllowed(sql, context, input.snapshot.roomId, "resource.create", "edit", { resource_kind: document.resource.kind, review: true });
        if (!batch) throw new WorkspaceServerError("workspace_completion_review_file_batch_required", 500);
        resource = await this.insertNewResource(sql, context, document.resource.id!, document.resource, "ai", batch, document.path, document.version, []);
      } else {
        if (current.version !== document.resource.expectedVersion) throwVersionConflict(current.version);
        if (current.kind !== document.resource.kind || current.scope.kind !== "room" || current.scope.roomId !== input.snapshot.roomId || current.knowledgeKind !== document.resource.knowledgeKind) {
          throw new WorkspaceServerError("workspace_completion_review_resource_identity_invalid", 409);
        }
        if (current.aiProtection === "fixed") throw new WorkspaceServerError("workspace_completion_resource_fixed", 409);
        await this.assertPolicyAllowed(sql, context, input.snapshot.roomId, "resource.update", "edit", { resource_kind: current.kind, review: true });
        if (!batch) throw new WorkspaceServerError("workspace_completion_review_file_batch_required", 500);
        resource = await this.insertUpdatedVersion(sql, context, current, document.resource, "ai", batch, document.path, document.version, []);
      }
      resources.push(resource);
      if (document.conflictTargetId) {
        const target = await this.selectResourceForUpdate(sql, context.workspaceId, document.conflictTargetId);
        if (!target || (target.scope.kind === "room" && target.scope.roomId !== input.snapshot.roomId)) {
          throw new WorkspaceServerError("workspace_completion_review_conflict_target_invalid", 409);
        }
        await sql.query(
          `INSERT INTO workspace_completion_resource_links(workspace_id, id, from_resource_id, to_resource_id, relation)
           VALUES ($1, $2, $3, $4, 'conflicts') ON CONFLICT (workspace_id, from_resource_id, to_resource_id, relation) DO NOTHING`,
          [context.workspaceId, completionId("completion_link", context.workspaceId, `${resource.id}:${target.id}:conflicts`), resource.id, target.id]
        );
      }
    }
    for (const candidate of result.candidates) {
      if (candidate.kind === "policy_change_request") {
        const proposedRules = validateWorkspaceCompletionPolicyRules(candidate.metadata?.proposed_rules ?? candidate.metadata?.rules ?? []);
        const requestId = completionId("completion_policy_request", context.workspaceId, `${input.snapshot.episodeId}:${candidate.reason}:${policyRequestIds.length}`);
        await sql.query(
          `INSERT INTO workspace_completion_policy_change_requests(workspace_id, room_id, id, requested_by, source_job_id, summary, proposed_rules)
           VALUES ($1, $2, $3, $4, $5, $6, $7::JSONB)`,
          [context.workspaceId, input.snapshot.roomId, requestId, context.accountId, input.jobId ?? null, candidate.reason.trim(), canonicalJson(proposedRules)]
        );
        policyRequestIds.push(requestId);
      }
      if (candidate.kind === "evidence_append") {
        const target = await this.selectResourceForUpdate(sql, context.workspaceId, requiredCandidateResourceId(candidate));
        if (!target || target.version !== candidate.expectedVersion) throw new WorkspaceServerError("workspace_completion_review_evidence_target_stale", 409);
        const version = await this.currentVersionForResource(sql, context.workspaceId, target, true);
        for (const activityId of candidate.evidenceActivityIds) {
          await this.assertEpisodeContainsActivity(sql, context.workspaceId, input.snapshot.episodeId, activityId);
          await this.insertEvidence(sql, context.workspaceId, target.id, version.version, { kind: "activity", activityId, episodeId: input.snapshot.episodeId, summary: candidate.reason.trim() });
        }
      }
    }
    if (input.jobId && input.attemptId && input.workerId) {
      const outputHash = hashText(canonicalJson(result));
      const attempt = await sql.query<{ id: string }>(
        `UPDATE workspace_completion_job_attempts SET status = 'completed', output_hash = $5, completed_at = NOW()
         WHERE workspace_id = $1 AND id = $2 AND job_id = $3 AND worker_id = $4 AND status = 'running'
         RETURNING id`,
        [context.workspaceId, input.attemptId, input.jobId, input.workerId, outputHash]
      );
      if (!attempt.rows[0]) throw new WorkspaceServerError("workspace_completion_job_attempt_lease_lost", 409);
      const job = await sql.query<{ id: string }>(
        `UPDATE workspace_completion_jobs SET status = 'completed', lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
          completed_at = NOW(), updated_at = NOW(), updated_by = $4
         WHERE workspace_id = $1 AND id = $2 AND lease_owner = $3 AND status = 'running' RETURNING id`,
        [context.workspaceId, input.jobId, input.workerId, context.accountId]
      );
      if (!job.rows[0]) throw new WorkspaceServerError("workspace_completion_job_lease_lost", 409);
    }
    await this.store.insertAudit(sql, context, {
      action: "workspace.completion.review.apply", roomId: input.snapshot.roomId, subjectKind: "completion_episode", subjectId: input.snapshot.episodeId,
      details: { resource_ids: resources.map((resource) => resource.id), policy_request_ids: policyRequestIds, reviewer: result.reviewer }
    });
    return { resources, policyRequestIds };
  }

  private async assertReviewSnapshotCurrentInTransaction(
    sql: WorkspaceSql,
    context: WorkspaceRequestContext,
    expected: WorkspaceCompletionReviewSnapshot
  ): Promise<void> {
    const actual = await this.buildReviewSnapshot(sql, context, expected.episodeId, {
      highWatermarkActivityId: expected.highWatermarkActivityId,
      lockResources: true
    });
    if (actual.digest !== expected.digest
      || actual.activityCount !== expected.activityCount
      || actual.resourceCount !== expected.resourceCount
      || actual.configurationVersion !== expected.configurationVersion) {
      throw new WorkspaceServerError("workspace_completion_review_stale_input", 409, {
        expected_digest: expected.digest,
        actual_digest: actual.digest,
        high_watermark_activity_id: expected.highWatermarkActivityId
      });
    }
  }

  /** A worker must apply the exact bounded snapshot it claimed.  The Job's
   * high watermark is authoritative; callers cannot substitute a newer or
   * wider Episode snapshot between claim and save. */
  private async assertReviewJobSnapshotInTransaction(
    sql: WorkspaceSql,
    context: WorkspaceRequestContext,
    input: ApplyWorkspaceCompletionReviewInput
  ): Promise<void> {
    if (!input.jobId || !input.attemptId || !input.workerId) return;
    const claimed = await sql.query<{
      job_id: string;
      group_key: string | null;
      high_watermark: string | null;
      job_input_hash: string;
      attempt_input_hash: string;
    }>(
      `SELECT job.id AS job_id, job.group_key, job.high_watermark, job.input_hash AS job_input_hash,
              attempt.input_hash AS attempt_input_hash
       FROM workspace_completion_jobs job
       JOIN workspace_completion_job_attempts attempt
         ON attempt.workspace_id = job.workspace_id AND attempt.job_id = job.id
       WHERE job.workspace_id = $1 AND job.id = $2
         AND job.kind = 'review' AND job.status = 'running' AND job.lease_owner = $3
         AND attempt.id = $4 AND attempt.worker_id = $3 AND attempt.status = 'running'
       FOR UPDATE OF job, attempt`,
      [context.workspaceId, input.jobId, input.workerId, input.attemptId]
    );
    const row = claimed.rows[0];
    if (!row) throw new WorkspaceServerError("workspace_completion_job_lease_lost", 409);
    if (row.group_key !== input.snapshot.episodeId
      || row.high_watermark !== input.snapshot.highWatermarkActivityId
      || row.job_input_hash !== input.snapshot.digest
      || row.attempt_input_hash !== input.snapshot.digest) {
      throw new WorkspaceServerError("workspace_completion_review_stale_input", 409, {
        job_id: input.jobId,
        expected_high_watermark_activity_id: row.high_watermark,
        actual_high_watermark_activity_id: input.snapshot.highWatermarkActivityId
      });
    }
  }

  /** Read every selected row by cursor, never by a silent LIMIT.  The upper
   * bound is explicit configuration: an oversized Review is blocked before a
   * cassette sees an incomplete story. */
  private async buildReviewSnapshot(
    sql: WorkspaceSql,
    context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">,
    episodeId: string,
    options: { highWatermarkActivityId?: string; lockResources?: boolean } = {}
  ): Promise<WorkspaceCompletionReviewSnapshot> {
    const episode = await this.selectEpisode(sql, context.workspaceId, episodeId);
    const configuration = await this.effectiveConfigurationInSql(sql, context.workspaceId, episode.roomId);
    const maxItems = configuration.values.reviewSnapshotMaxItems;
    const pageSize = Math.min(500, maxItems + 1);
    let watermarkFinalizedAt: string | undefined;
    if (options.highWatermarkActivityId) {
      const watermark = await sql.query<{ finalized_at: Date | string }>(
        `SELECT activity.finalized_at
         FROM workspace_completion_episode_activities link
         JOIN workspace_completion_activities activity
           ON activity.workspace_id = link.workspace_id AND activity.id = link.activity_id
         WHERE link.workspace_id = $1 AND link.episode_id = $2 AND activity.id = $3`,
        [context.workspaceId, episode.id, options.highWatermarkActivityId]
      );
      if (!watermark.rows[0]) {
        throw new WorkspaceServerError("workspace_completion_review_stale_input", 409, {
          episode_id: episode.id,
          high_watermark_activity_id: options.highWatermarkActivityId
        });
      }
      watermarkFinalizedAt = iso(watermark.rows[0].finalized_at);
    }
    const activities: WorkspaceCompletionActivity[] = [];
    let activityCursor: { finalizedAt: string; id: string } | undefined;
    for (;;) {
      const rows = await sql.query<ActivityRow>(
        `SELECT activity.*
         FROM workspace_completion_episode_activities link
         JOIN workspace_completion_activities activity
           ON activity.workspace_id = link.workspace_id AND activity.id = link.activity_id
         WHERE link.workspace_id = $1 AND link.episode_id = $2
           AND ($3::TIMESTAMPTZ IS NULL OR activity.finalized_at < $3::TIMESTAMPTZ
             OR (activity.finalized_at = $3::TIMESTAMPTZ AND activity.id <= $4))
           AND ($5::TIMESTAMPTZ IS NULL OR activity.finalized_at > $5::TIMESTAMPTZ
             OR (activity.finalized_at = $5::TIMESTAMPTZ AND activity.id > $6))
         ORDER BY activity.finalized_at ASC, activity.id ASC LIMIT $7`,
        [
          context.workspaceId,
          episode.id,
          watermarkFinalizedAt ?? null,
          options.highWatermarkActivityId ?? null,
          activityCursor?.finalizedAt ?? null,
          activityCursor?.id ?? null,
          pageSize
        ]
      );
      const page = rows.rows.map(activityFromRow);
      activities.push(...page);
      if (activities.length > maxItems) throw new WorkspaceServerError("workspace_completion_review_snapshot_limit_exceeded", 409, { max_items: maxItems, item: "activities" });
      if (page.length < pageSize) break;
      const last = page[page.length - 1]!;
      activityCursor = { finalizedAt: last.finalizedAt, id: last.id };
    }
    const highWatermarkActivityId = options.highWatermarkActivityId ?? activities[activities.length - 1]?.id;
    if (!highWatermarkActivityId) throw new WorkspaceServerError("workspace_completion_review_snapshot_empty", 409);
    const resources: WorkspaceCompletionReviewSnapshot["resources"][number][] = [];
    let resourceCursor: string | undefined;
    for (;;) {
      const rows = await sql.query<ReviewResourceRow>(
        `SELECT resource.*, current_version.content_hash AS snapshot_content_hash
         FROM workspace_completion_resources resource
         JOIN workspace_completion_resource_versions current_version
           ON current_version.workspace_id = resource.workspace_id
          AND current_version.resource_id = resource.id
          AND current_version.version = COALESCE(resource.current_confirmed_version, resource.current_provisional_version)
         LEFT JOIN workspace_completion_file_batches batch
           ON batch.workspace_id = current_version.workspace_id AND batch.id = current_version.file_batch_id
         WHERE resource.workspace_id = $1
           AND (resource.scope_kind = 'workspace' OR resource.room_id = $2)
           AND resource.lifecycle_state <> 'archived'
           AND (current_version.file_batch_id IS NULL OR batch.status = 'renamed')
           AND ($3::TEXT IS NULL OR resource.id > $3)
         ORDER BY resource.id ASC LIMIT $4${options.lockResources ? " FOR UPDATE OF resource, current_version" : ""}`,
        [context.workspaceId, episode.roomId, resourceCursor ?? null, pageSize]
      );
      const page = rows.rows.map((row) => ({
        id: row.id,
        version: numeric(row.version),
        kind: row.resource_kind,
        fixed: row.ai_protection === "fixed",
        contentHash: row.snapshot_content_hash,
        lifecycleState: row.lifecycle_state,
        evidenceState: row.evidence_state
      }));
      resources.push(...page);
      if (activities.length + resources.length > maxItems) {
        throw new WorkspaceServerError("workspace_completion_review_snapshot_limit_exceeded", 409, { max_items: maxItems, item: "resources" });
      }
      if (page.length < pageSize) break;
      resourceCursor = page[page.length - 1]!.id;
    }
    const withoutDigest = {
      workspaceId: context.workspaceId,
      roomId: episode.roomId,
      episodeId: episode.id,
      highWatermarkActivityId,
      activityCount: activities.length,
      resourceCount: resources.length,
      configurationVersion: configuration.version,
      activities,
      resources
    };
    return { ...withoutDigest, digest: reviewSnapshotDigest(withoutDigest) };
  }

  private async insertNewResource(
    sql: WorkspaceSql,
    context: WorkspaceRequestContext,
    id: string,
    input: WorkspaceCompletionResourceInput,
    creationSource: WorkspaceCompletionCreationSource,
    batch: StagedWorkspaceCompletionFileBatch,
    targetPath: string,
    version: number,
    supportFiles: readonly WorkspaceCompletionSkillSupportInput[]
  ): Promise<WorkspaceCompletionResource> {
    const immediate = creationSource !== "ai" && !isProvisionalImport(input, creationSource);
    const evidenceState: WorkspaceCompletionEvidenceState = immediate ? "confirmed" : "provisional";
    const resource = await sql.query<ResourceRow>(
      `INSERT INTO workspace_completion_resources(
         workspace_id, id, scope_kind, room_id, resource_kind, knowledge_kind, title,
         evidence_state, lifecycle_state, ai_protection, creation_source, ai_managed, version,
         current_confirmed_version, current_provisional_version, candidate_version, created_by, updated_by
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active', 'editable', $9, $10, $11, $12, $13, $14, $15, $15)
       RETURNING *`,
      [
        context.workspaceId, id, input.scope.kind, input.scope.roomId ?? null, input.kind, input.knowledgeKind ?? null, input.title.trim(),
        evidenceState, creationSource, input.aiManaged === true, version,
        immediate ? version : null, immediate ? null : version, creationSource === "ai" ? version : null, context.accountId
      ]
    );
    await this.insertVersion(sql, context, resourceFromRow(resource.rows[0]!), {
      version, parentVersion: undefined, path: targetPath, content: renderWorkspaceCompletionDocument({ id, title: input.title.trim(), resourceKind: input.kind, metadata: input.metadata, body: input.content.trim() }),
      evidenceState, lifecycleState: "active", aiProtection: "editable", creationSource, metadata: input.metadata, reason: input.reason.trim(), batchId: batch.id
    });
    await this.insertSkillFiles(sql, context, resourceFromRow(resource.rows[0]!), version, supportFiles, batch, creationSource === "ai");
    const saved = resourceFromRow(resource.rows[0]!);
    await this.insertResourceEvidence(sql, context.workspaceId, saved.id, version, input, creationSource);
    return saved;
  }

  private async insertUpdatedVersion(
    sql: WorkspaceSql,
    context: WorkspaceRequestContext,
    current: WorkspaceCompletionResource,
    input: WorkspaceCompletionResourceInput,
    creationSource: WorkspaceCompletionCreationSource,
    batch: StagedWorkspaceCompletionFileBatch,
    targetPath: string,
    version: number,
    supportFiles: readonly WorkspaceCompletionSkillSupportInput[]
  ): Promise<WorkspaceCompletionResource> {
    const isCandidate = creationSource === "ai";
    const isProvisional = isCandidate || isProvisionalImport(input, creationSource);
    const evidenceState: WorkspaceCompletionEvidenceState = isProvisional ? "provisional" : "confirmed";
    const previous = await this.currentVersionForResource(sql, context.workspaceId, current, true);
    if (!isCandidate) {
      const historicPath = completionResourcePath({ id: current.id, kind: current.kind, scope: current.scope, version: previous.version });
      await sql.query(
        "UPDATE workspace_completion_resource_versions SET file_path = $3 WHERE workspace_id = $1 AND id = $2",
        [context.workspaceId, previous.id, historicPath]
      );
      if (current.kind === "skill") {
        const files = await sql.query<SkillFileRow>(
          "SELECT * FROM workspace_completion_skill_files WHERE workspace_id = $1 AND resource_id = $2 AND resource_version = $3 FOR UPDATE",
          [context.workspaceId, current.id, previous.version]
        );
        for (const file of files.rows) {
          await sql.query(
            "UPDATE workspace_completion_skill_files SET file_path = $3 WHERE workspace_id = $1 AND id = $2",
            [context.workspaceId, file.id, completionSkillSupportPath({ id: current.id, relativePath: file.relative_path, version: previous.version })]
          );
        }
      }
    }
    const updated = await sql.query<ResourceRow>(
      `UPDATE workspace_completion_resources
       SET title = $3, version = $4, evidence_state = $5, lifecycle_state = 'active', archived_at = NULL,
           ai_managed = CASE WHEN $6 THEN TRUE ELSE ai_managed END,
           current_confirmed_version = $7, current_provisional_version = $8, candidate_version = $9,
           updated_by = $10, updated_at = NOW()
       WHERE workspace_id = $1 AND id = $2 RETURNING *`,
      [
        context.workspaceId, current.id, isCandidate ? current.title : input.title.trim(), version, isCandidate ? current.evidenceState : evidenceState, input.aiManaged === true,
        isCandidate ? current.currentConfirmedVersion ?? null : isProvisional ? null : version,
        isCandidate ? (current.currentConfirmedVersion ? current.currentProvisionalVersion ?? null : version) : isProvisional ? version : null,
        isCandidate ? version : null, context.accountId
      ]
    );
    const resource = resourceFromRow(updated.rows[0]!);
    await this.insertVersion(sql, context, resource, {
      version, parentVersion: previous.version, path: targetPath,
      content: renderWorkspaceCompletionDocument({ id: resource.id, title: input.title.trim(), resourceKind: input.kind, metadata: input.metadata, body: input.content.trim() }),
      evidenceState, lifecycleState: "active", aiProtection: resource.aiProtection, creationSource, metadata: input.metadata, reason: input.reason.trim(), batchId: batch.id
    });
    await this.insertSkillFiles(sql, context, resource, version, supportFiles, batch, isCandidate);
    await this.insertResourceEvidence(sql, context.workspaceId, resource.id, version, input, creationSource);
    return resource;
  }

  private async insertVersion(
    sql: WorkspaceSql,
    context: WorkspaceRequestContext,
    resource: WorkspaceCompletionResource,
    input: { version: number; parentVersion?: number; path: string; content: Uint8Array; evidenceState: WorkspaceCompletionEvidenceState; lifecycleState: WorkspaceCompletionLifecycleState; aiProtection: WorkspaceCompletionAiProtection; creationSource: WorkspaceCompletionCreationSource; metadata: WorkspaceRecordPayload; reason: string; batchId: string }
  ): Promise<WorkspaceCompletionResourceVersion> {
    const contentHash = hashBytes(input.content);
    const inserted = await sql.query<VersionRow>(
      `INSERT INTO workspace_completion_resource_versions(
         workspace_id, id, resource_id, version, parent_version, file_path, content_hash, content_size,
         evidence_state, lifecycle_state, ai_protection, creation_source, metadata, reason, actor_account_id, file_batch_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::JSONB, $14, $15, $16) RETURNING *`,
      [
        context.workspaceId, completionId("completion_version", context.workspaceId, `${resource.id}:${input.version}`), resource.id, input.version, input.parentVersion ?? null,
        input.path, contentHash, input.content.byteLength, input.evidenceState, input.lifecycleState, input.aiProtection,
        input.creationSource, canonicalJson(input.metadata), input.reason, context.accountId, input.batchId
      ]
    );
    await sql.query(
      `INSERT INTO workspace_completion_search_projection(workspace_id, resource_id, resource_version, search_text)
       VALUES ($1, $2, $3, $4)`,
      [context.workspaceId, resource.id, input.version, searchableText(resource.title, input.metadata, input.content)]
    );
    return versionFromRow(inserted.rows[0]!);
  }

  private async insertSkillFiles(
    sql: WorkspaceSql,
    context: WorkspaceRequestContext,
    resource: WorkspaceCompletionResource,
    resourceVersion: number,
    files: readonly WorkspaceCompletionSkillSupportInput[],
    batch: StagedWorkspaceCompletionFileBatch,
    candidate: boolean
  ): Promise<void> {
    if (resource.kind !== "skill") {
      if (files.length > 0) throw new WorkspaceServerError("workspace_completion_skill_support_non_skill", 422);
      return;
    }
    for (const file of files) {
      const filePath = completionSkillSupportPath({ id: resource.id, relativePath: file.path, ...(candidate ? { version: resourceVersion, candidate: true } : {}) });
      await sql.query(
        `INSERT INTO workspace_completion_skill_files(
           workspace_id, id, resource_id, resource_version, relative_path, file_path,
           content_hash, content_size, file_batch_id
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          context.workspaceId,
          completionId("completion_skill_file", context.workspaceId, `${resource.id}:${resourceVersion}:${file.path}`),
          resource.id, resourceVersion, file.path, filePath, hashBytes(file.content), file.content.byteLength, batch.id
        ]
      );
    }
  }

  private async insertLink(sql: WorkspaceSql, workspaceId: string, fromResourceId: string, toResourceId: string, relation: WorkspaceCompletionResourceLink["relation"]): Promise<void> {
    await sql.query(
      `INSERT INTO workspace_completion_resource_links(workspace_id, id, from_resource_id, to_resource_id, relation)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT (workspace_id, from_resource_id, to_resource_id, relation) DO NOTHING`,
      [workspaceId, completionId("completion_link", workspaceId, `${fromResourceId}:${toResourceId}:${relation}`), fromResourceId, toResourceId, relation]
    );
  }

  private async archiveMovedSource(
    sql: WorkspaceSql,
    context: WorkspaceRequestContext,
    input: { resourceId: string; expectedVersion: number; expectedContentHash: string; expectedPackageHash: string; reason: string }
  ): Promise<void> {
    const source = await this.selectResourceForUpdate(sql, context.workspaceId, input.resourceId);
    if (!source) throw new WorkspaceServerError("workspace_completion_resource_not_found", 404);
    if (source.version !== input.expectedVersion) throwVersionConflict(source.version);
    if (source.scope.kind !== "room") throw new WorkspaceServerError("workspace_completion_resource_move_scope_invalid", 409);
    const current = await this.currentVersionForResource(sql, context.workspaceId, source, true);
    const supports = source.kind === "skill"
      ? await sql.query<SkillFileRow>(
        `SELECT * FROM workspace_completion_skill_files
         WHERE workspace_id = $1 AND resource_id = $2 AND resource_version = $3
         ORDER BY relative_path ASC FOR UPDATE`,
        [context.workspaceId, source.id, current.version]
      )
      : { rows: [] as SkillFileRow[] };
    if (current.contentHash !== input.expectedContentHash
      || skillPackageHash(source.kind, current.contentHash, supports.rows.map((file) => ({
        relativePath: assertSkillSupportRelativePath(file.relative_path), contentHash: file.content_hash, contentSize: numeric(file.content_size)
      }))) !== input.expectedPackageHash) {
      throw new WorkspaceServerError("workspace_completion_skill_package_stale", 409);
    }
    await this.assertPolicyAllowed(sql, context, source.scope.roomId, "resource.move", "edit", { resource_kind: source.kind });
    const updated = await sql.query<ResourceRow>(
      `UPDATE workspace_completion_resources SET lifecycle_state = 'archived', archived_at = NOW(), updated_by = $3, updated_at = NOW()
       WHERE workspace_id = $1 AND id = $2 RETURNING *`,
      [context.workspaceId, source.id, context.accountId]
    );
    const archived = resourceFromRow(updated.rows[0]!);
    const version = await this.currentVersionForResource(sql, context.workspaceId, archived, true);
    await this.insertEvidence(sql, context.workspaceId, archived.id, version.version, { kind: "human_edit", summary: input.reason.trim() });
  }

  private async executeBatch<T>(
    context: WorkspaceRequestContext,
    batch: StagedWorkspaceCompletionFileBatch,
    request: { action: string; input: unknown },
    mutate: (sql: WorkspaceSql) => Promise<T>
  ): Promise<{ value: T; replayed: boolean }> {
    const result = await this.store.runIdempotentResult<BatchResult<T>>(context, request, async (sql) => {
      await this.recordBatch(sql, batch);
      const value = await mutate(sql);
      return { result: value, batchId: batch.id };
    });
    if (result.replayed) await this.files.rollback(batch).catch(() => undefined);
    await this.finalizeBatch(context, result.value.batchId);
    return { value: result.value.result, replayed: result.replayed };
  }

  private async recordBatch(sql: WorkspaceSql, batch: StagedWorkspaceCompletionFileBatch): Promise<void> {
    await sql.query(
      `INSERT INTO workspace_completion_file_batches(workspace_id, id, scope_kind, room_id, status)
       VALUES ($1, $2, $3, $4, 'db_committed')`,
      [batch.workspaceId, batch.id, batch.scope.kind, batch.scope.roomId ?? null]
    );
    for (const entry of batch.entries) {
      await sql.query(
        `INSERT INTO workspace_completion_file_batch_entries(workspace_id, batch_id, path, sha256, size)
         VALUES ($1, $2, $3, $4, $5)`,
        [batch.workspaceId, batch.id, entry.path, entry.sha256, entry.content.byteLength]
      );
    }
  }

  async recoverFileBatches(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">): Promise<{ recovered: string[]; failed: string[] }> {
    const batches = await this.store.database.withContext(context, async (sql) => {
      const result = await sql.query<{ id: string }>(
        "SELECT id FROM workspace_completion_file_batches WHERE workspace_id = $1 AND status = 'db_committed' ORDER BY created_at ASC",
        [context.workspaceId]
      );
      return result.rows.map((row) => row.id);
    });
    const recovered: string[] = [];
    const failed: string[] = [];
    for (const id of batches) {
      try {
        await this.finalizeBatch(context, id);
        recovered.push(id);
      } catch {
        failed.push(id);
      }
    }
    return { recovered, failed };
  }

  /** Stores raw backend exchange data separately from Workspace Knowledge.
   * It is never part of normal Context or Bundle export, and retention keeps
   * the hash/Attempt while clearing only this text. */
  async recordJobRawOutput(
    context: WorkspaceRequestContext,
    input: { jobId: string; attemptId: string; direction: "request" | "response"; content: string }
  ): Promise<{ id: string; replayed: boolean }> {
    assertCompletionId(input.jobId, "workspace_completion_job_id_invalid");
    assertCompletionId(input.attemptId, "workspace_completion_attempt_id_invalid");
    if (input.direction !== "request" && input.direction !== "response") throw new WorkspaceServerError("workspace_completion_raw_output_direction_invalid", 400);
    if (typeof input.content !== "string" || input.content.length > 2_000_000) throw new WorkspaceServerError("workspace_completion_raw_output_invalid", 422);
    if (containsWorkspaceCompletionSecret(input.content)) throw new WorkspaceServerError("workspace_completion_secret_content_forbidden", 422);
    const id = completionId("completion_raw_output", context.workspaceId, `${input.attemptId}:${input.direction}`);
    const saved = await this.store.runIdempotentResult(context, {
      action: "workspace.completion.job.raw_output.record",
      input: { job_id: input.jobId, attempt_id: input.attemptId, direction: input.direction, content_hash: hashText(input.content) }
    }, async (sql) => {
      const job = await sql.query<JobRow>(
        "SELECT * FROM workspace_completion_jobs WHERE workspace_id = $1 AND id = $2 FOR UPDATE",
        [context.workspaceId, input.jobId]
      );
      const selected = job.rows[0] ? jobFromRow(job.rows[0]) : undefined;
      if (!selected) throw new WorkspaceServerError("workspace_completion_job_not_found", 404);
      await this.assertPolicyAllowed(sql, context, selected.roomId, "activity.ingest", "execute", { maintenance_job: "raw_output" });
      const attempt = await sql.query<{ id: string }>(
        "SELECT id FROM workspace_completion_job_attempts WHERE workspace_id = $1 AND id = $2 AND job_id = $3",
        [context.workspaceId, input.attemptId, input.jobId]
      );
      if (!attempt.rows[0]) throw new WorkspaceServerError("workspace_completion_job_attempt_not_found", 404);
      await sql.query(
        `INSERT INTO workspace_completion_job_raw_outputs(workspace_id, id, job_id, attempt_id, direction, content, content_hash, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (workspace_id, attempt_id, direction) DO NOTHING`,
        [context.workspaceId, id, input.jobId, input.attemptId, input.direction, input.content, hashText(input.content), context.accountId]
      );
      return { id };
    });
    return { id: saved.value.id, replayed: saved.replayed };
  }

  async purgeExpiredRawJobOutputs(
    context: WorkspaceRequestContext,
    input: { roomId?: string; now?: Date; limit?: number } = {}
  ): Promise<number> {
    if (input.roomId) assertOpaqueId(input.roomId, "room_id_invalid");
    const limit = boundedLimit(input.limit);
    const now = input.now ?? new Date();
    if (Number.isNaN(now.getTime())) throw new WorkspaceServerError("workspace_completion_retention_time_invalid", 400);
    const pending = await this.store.database.withContext(context, async (sql) => {
      const rows = await sql.query<RawOutputRow & { room_id: string }>(
        `SELECT raw.*, job.room_id
         FROM workspace_completion_job_raw_outputs raw
         JOIN workspace_completion_jobs job ON job.workspace_id = raw.workspace_id AND job.id = raw.job_id
         WHERE raw.workspace_id = $1 AND raw.redacted_at IS NULL
           AND ($2::TEXT IS NULL OR job.room_id = $2)
         ORDER BY raw.created_at ASC, raw.id ASC LIMIT $3`,
        [context.workspaceId, input.roomId ?? null, limit]
      );
      return rows.rows;
    });
    const tuning = new Map<string, WorkspaceCompletionTuning>();
    const due = [] as Array<RawOutputRow & { room_id: string }>;
    for (const row of pending) {
      let values = tuning.get(row.room_id);
      if (!values) {
        values = (await this.getEffectiveConfiguration(context, row.room_id)).values;
        tuning.set(row.room_id, values);
      }
      if (new Date(row.created_at).getTime() + values.rawJobOutputRetentionDays * 86_400_000 <= now.getTime()) due.push(row);
    }
    if (due.length === 0) return 0;
    const saved = await this.store.runIdempotentResult(context, {
      action: "workspace.completion.job.raw_output.purge",
      input: { ids: due.map((row) => row.id), now: now.toISOString() }
    }, async (sql) => {
      let purged = 0;
      for (const row of due) {
        await this.assertPolicyAllowed(sql, context, row.room_id, "activity.ingest", "execute", { maintenance_job: "raw_output_retention" });
        const updated = await sql.query<{ id: string }>(
          `UPDATE workspace_completion_job_raw_outputs
           SET content = NULL, redacted_at = $3::TIMESTAMPTZ
           WHERE workspace_id = $1 AND id = $2 AND redacted_at IS NULL RETURNING id`,
          [context.workspaceId, row.id, now.toISOString()]
        );
        purged += updated.rows.length;
      }
      return purged;
    });
    return saved.value;
  }

  /** Owner-only targeted deletion for a raw exchange that is known to contain
   * a secret. It preserves the Job/Attempt/hash row but removes the text. */
  async redactRawJobOutput(context: WorkspaceRequestContext, input: { rawOutputId: string; reason: string }): Promise<{ replayed: boolean }> {
    assertCompletionId(input.rawOutputId, "workspace_completion_raw_output_id_invalid");
    assertSafeText(input.reason, "workspace_completion_redaction_reason_invalid");
    const saved = await this.store.runIdempotentResult(context, {
      action: "workspace.completion.job.raw_output.redact",
      input: { raw_output_id: input.rawOutputId, reason_hash: hashText(input.reason) }
    }, async (sql) => {
      const owner = await sql.query<{ allowed: boolean }>("SELECT samurai_can_workspace($1, 'owner') AS allowed", [context.workspaceId]);
      if (owner.rows[0]?.allowed !== true) throw new WorkspaceServerError("workspace_completion_redaction_owner_required", 403);
      const raw = await sql.query<{ job_id: string }>(
        "SELECT job_id FROM workspace_completion_job_raw_outputs WHERE workspace_id = $1 AND id = $2 FOR UPDATE",
        [context.workspaceId, input.rawOutputId]
      );
      if (!raw.rows[0]) throw new WorkspaceServerError("workspace_completion_raw_output_not_found", 404);
      const updated = await sql.query<{ id: string }>(
        `UPDATE workspace_completion_job_raw_outputs SET content = NULL, redacted_at = NOW()
         WHERE workspace_id = $1 AND id = $2 AND redacted_at IS NULL RETURNING id`,
        [context.workspaceId, input.rawOutputId]
      );
      const job = await sql.query<{ room_id: string }>(
        "SELECT room_id FROM workspace_completion_jobs WHERE workspace_id = $1 AND id = $2",
        [context.workspaceId, raw.rows[0].job_id]
      );
      await this.store.insertAudit(sql, context, {
        action: "workspace.completion.job.raw_output.redact",
        ...(job.rows[0]?.room_id ? { roomId: job.rows[0].room_id } : {}),
        subjectKind: "completion_job_raw_output",
        subjectId: input.rawOutputId,
        details: { reason_hash: hashText(input.reason), redacted: Boolean(updated.rows[0]) }
      });
      return undefined;
    });
    return { replayed: saved.replayed };
  }

  /** Owner-only privacy removal. It overwrites every current, historical,
   * candidate, and Skill support file with a valid tombstone before making
   * that tombstone visible in PostgreSQL. Normal cleanup must use archive;
   * this destructive path is reserved for secrets and personal data. */
  async redactResource(context: WorkspaceRequestContext, input: { resourceId: string; reason: string }): Promise<{ redactionId: string; replayed: boolean }> {
    assertCompletionId(input.resourceId, "workspace_completion_resource_id_invalid");
    assertSafeText(input.reason, "workspace_completion_redaction_reason_invalid");
    const prepared = await this.store.database.withContext(context, async (sql) => {
      const owner = await sql.query<{ allowed: boolean }>("SELECT samurai_can_workspace($1, 'owner') AS allowed", [context.workspaceId]);
      if (owner.rows[0]?.allowed !== true) throw new WorkspaceServerError("workspace_completion_redaction_owner_required", 403);
      const resource = await this.selectReadableResource(sql, context.workspaceId, input.resourceId, false);
      const versions = await sql.query<VersionRow>(
        "SELECT * FROM workspace_completion_resource_versions WHERE workspace_id = $1 AND resource_id = $2 ORDER BY version ASC",
        [context.workspaceId, input.resourceId]
      );
      const skillFiles = resource.resource.kind === "skill"
        ? await sql.query<SkillFileRow>("SELECT * FROM workspace_completion_skill_files WHERE workspace_id = $1 AND resource_id = $2 ORDER BY resource_version ASC, relative_path ASC", [context.workspaceId, input.resourceId])
        : { rows: [] as SkillFileRow[] };
      const episodes = await sql.query<{ episode_id: string }>(
        `SELECT DISTINCT episode_id FROM workspace_completion_evidence
         WHERE workspace_id = $1 AND resource_id = $2 AND episode_id IS NOT NULL`,
        [context.workspaceId, input.resourceId]
      );
      return {
        resource: resource.resource,
        versions: versions.rows.map(versionFromRow),
        skillFiles: skillFiles.rows.map(skillFileFromRow),
        episodeIds: episodes.rows.map((episode) => episode.episode_id)
      };
    });
    const redactionId = completionId("completion_redaction", context.workspaceId, `${input.resourceId}:${context.operationId}`);
    const mainTombstone = (version: WorkspaceCompletionResourceVersion) => renderWorkspaceCompletionDocument({
      id: prepared.resource.id,
      title: "[REDACTED]",
      resourceKind: prepared.resource.kind,
      metadata: { redacted: true, redaction_id: redactionId, version: version.version },
      body: "[REDACTED]"
    });
    const supportTombstone = Buffer.from("[REDACTED]\n", "utf8");
    const entries = [
      ...prepared.versions.map((version) => ({ path: version.filePath, content: mainTombstone(version) })),
      ...prepared.skillFiles.map((file) => ({ path: file.filePath, content: supportTombstone }))
    ];
    if (entries.length > 1_000) throw new WorkspaceServerError("workspace_completion_redaction_file_count_invalid", 422);
    const batch = await this.files.stage(context.workspaceId, prepared.resource.scope, entries);
    try {
      const saved = await this.executeBatch(context, batch, {
        action: "workspace.completion.resource.redact",
        input: { resource_id: input.resourceId, reason_hash: hashText(input.reason), redaction_id: redactionId }
      }, async (sql) => {
        const owner = await sql.query<{ allowed: boolean }>("SELECT samurai_can_workspace($1, 'owner') AS allowed", [context.workspaceId]);
        if (owner.rows[0]?.allowed !== true) throw new WorkspaceServerError("workspace_completion_redaction_owner_required", 403);
        await sql.query("SELECT set_config('samurai_completion_redaction', 'on', true)");
        const rawOutputs = prepared.episodeIds.length === 0
          ? { rows: [] as Array<{ id: string }> }
          : await sql.query<{ id: string }>(
            `UPDATE workspace_completion_job_raw_outputs raw
             SET content = NULL, redacted_at = NOW()
             FROM workspace_completion_jobs job
             WHERE raw.workspace_id = $1 AND raw.job_id = job.id AND raw.redacted_at IS NULL
               AND job.group_key = ANY($2::TEXT[])
             RETURNING raw.id`,
            [context.workspaceId, prepared.episodeIds]
          );
        await sql.query("SELECT samurai_redact_completion_resource($1, $2, $3, $4)", [context.workspaceId, input.resourceId, redactionId, hashText(input.reason)]);
        for (const version of prepared.versions) {
          const content = mainTombstone(version);
          const updated = await sql.query<{ id: string }>(
            `UPDATE workspace_completion_resource_versions
             SET content_hash = $3, content_size = $4, metadata = $5::JSONB
             WHERE workspace_id = $1 AND id = $2 RETURNING id`,
            [context.workspaceId, version.id, hashBytes(content), content.byteLength, canonicalJson({ redacted: true, redaction_id: redactionId, version: version.version })]
          );
          if (!updated.rows[0]) throw new WorkspaceServerError("workspace_completion_resource_version_not_found", 404);
        }
        for (const file of prepared.skillFiles) {
          const updated = await sql.query<{ id: string }>(
            `UPDATE workspace_completion_skill_files
             SET content_hash = $3, content_size = $4
             WHERE workspace_id = $1 AND id = $2 RETURNING id`,
            [context.workspaceId, file.id, hashBytes(supportTombstone), supportTombstone.byteLength]
          );
          if (!updated.rows[0]) throw new WorkspaceServerError("workspace_completion_skill_file_not_found", 404);
        }
        await this.store.insertAudit(sql, context, {
          action: "workspace.completion.resource.redact",
          ...(prepared.resource.scope.roomId ? { roomId: prepared.resource.scope.roomId } : {}),
          subjectKind: "completion_resource",
          subjectId: input.resourceId,
          details: {
            redaction_id: redactionId,
            reason_hash: hashText(input.reason),
            versions: prepared.versions.length,
            support_files: prepared.skillFiles.length,
            raw_job_outputs: rawOutputs.rows.length
          }
        });
        return { redactionId };
      });
      return { redactionId: saved.value.redactionId, replayed: saved.replayed };
    } catch (error) {
      await this.files.rollback(batch).catch(() => undefined);
      throw error;
    }
  }

  private async finalizeBatch(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, batchId: string): Promise<void> {
    await this.store.database.withContext(context, async (sql) => {
      const header = await sql.query<{ id: string; scope_kind: "workspace" | "room"; room_id: string | null; status: "db_committed" | "renamed" | "rolled_back" }>(
        "SELECT id, scope_kind, room_id, status FROM workspace_completion_file_batches WHERE workspace_id = $1 AND id = $2",
        [context.workspaceId, batchId]
      );
      const row = header.rows[0];
      if (!row) throw new WorkspaceServerError("workspace_completion_file_batch_not_found", 404);
      if (row.status === "rolled_back") throw new WorkspaceServerError("workspace_completion_file_batch_rolled_back", 409);
      const entries = await sql.query<{ path: string; sha256: string; size: number | string }>(
        "SELECT path, sha256, size FROM workspace_completion_file_batch_entries WHERE workspace_id = $1 AND batch_id = $2 ORDER BY path",
        [context.workspaceId, batchId]
      );
      const scope = row.scope_kind === "workspace"
        ? { kind: "workspace" as const }
        : { kind: "room" as const, roomId: requiredRoomId(row.room_id) };
      const paths = entries.rows.map((entry) => entry.path);
      // Hold the resource rows while the physical rename runs. A newer batch
      // either waits for this recovery or is already visible here and is
      // rejected, so an older transaction can never overwrite the current
      // resource file after its metadata has advanced.
      await sql.query(
        `SELECT resource_id FROM workspace_completion_resource_versions
         WHERE workspace_id = $1 AND file_batch_id = $2
         UNION
         SELECT resource_id FROM workspace_completion_skill_files
         WHERE workspace_id = $1 AND file_batch_id = $2`,
        [context.workspaceId, batchId]
      );
      await sql.query(
        `SELECT * FROM workspace_completion_resources
         WHERE workspace_id = $1 AND id IN (
           SELECT resource_id FROM workspace_completion_resource_versions WHERE workspace_id = $1 AND file_batch_id = $2
           UNION
           SELECT resource_id FROM workspace_completion_skill_files WHERE workspace_id = $1 AND file_batch_id = $2
         ) FOR UPDATE`,
        [context.workspaceId, batchId]
      );
      if (paths.length > 0) {
        const conflictingResource = await sql.query<{ file_path: string }>(
          `SELECT version.file_path
           FROM workspace_completion_resource_versions version
           JOIN workspace_completion_resources resource
             ON resource.workspace_id = version.workspace_id AND resource.id = version.resource_id
           WHERE version.workspace_id = $1
             AND version.file_path = ANY($2::TEXT[])
             AND version.file_batch_id IS DISTINCT FROM $3
             AND (resource.current_confirmed_version = version.version
               OR resource.current_provisional_version = version.version
               OR resource.candidate_version = version.version)
           LIMIT 1`,
          [context.workspaceId, paths, batchId]
        );
        if (conflictingResource.rows[0]) throw new WorkspaceServerError("workspace_completion_file_recovery_required", 503, { path: conflictingResource.rows[0].file_path });
        const conflictingDocument = await sql.query<{ file_path: string }>(
          `SELECT file_path FROM workspace_completion_workspace_documents
           WHERE workspace_id = $1 AND file_path = ANY($2::TEXT[]) AND file_batch_id IS DISTINCT FROM $3
           LIMIT 1`,
          [context.workspaceId, paths, batchId]
        );
        if (conflictingDocument.rows[0]) throw new WorkspaceServerError("workspace_completion_file_recovery_required", 503, { path: conflictingDocument.rows[0].file_path });
        // Completion owns these paths. A legacy generic-file ledger entry is
        // an ownership conflict, not permission to overwrite or silently
        // migrate the user's file; surface it for an explicit recovery.
        const conflictingWorkspaceFile = await sql.query<{ path: string }>(
          `SELECT path FROM workspace_files
           WHERE workspace_id = $1 AND path = ANY($2::TEXT[])
           LIMIT 1`,
          [context.workspaceId, paths]
        );
        if (conflictingWorkspaceFile.rows[0]) throw new WorkspaceServerError("workspace_completion_file_ledger_conflict", 409, { path: conflictingWorkspaceFile.rows[0].path });
      }
      const batch = { workspaceId: context.workspaceId, id: batchId, scope, status: row.status, entries: entries.rows.map((entry) => ({ path: entry.path, sha256: entry.sha256, content: Buffer.alloc(Number(entry.size)) })) };
      if (batch.status !== "renamed") await this.files.recover(batch);
      await sql.query(
        `UPDATE workspace_completion_file_batches SET status = 'renamed', updated_at = NOW()
         WHERE workspace_id = $1 AND id = $2 AND status = 'db_committed'`,
        [context.workspaceId, batchId]
      );
    });
  }

  private async readResourceForWrite(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, resourceId: string): Promise<WorkspaceCompletionReadResource> {
    return this.store.database.withContext(context, async (sql) => this.selectReadableResource(sql, context.workspaceId, resourceId, true));
  }

  private async selectReadableResource(sql: WorkspaceSql, workspaceId: string, resourceId: string, requireCurrent: boolean): Promise<WorkspaceCompletionReadResource> {
    const result = await sql.query<ResourceRow>("SELECT * FROM workspace_completion_resources WHERE workspace_id = $1 AND id = $2", [workspaceId, resourceId]);
    const row = result.rows[0];
    if (!row) throw new WorkspaceServerError("workspace_completion_resource_not_found", 404);
    const resource = resourceFromRow(row);
    const pointer = resource.currentConfirmedVersion ?? resource.currentProvisionalVersion;
    if (!pointer) throw new WorkspaceServerError("workspace_completion_resource_version_not_ready", 503);
    const version = await this.selectVersion(sql, workspaceId, resourceId, pointer, requireCurrent);
    return { resource, version };
  }

  private async selectVersion(sql: WorkspaceSql, workspaceId: string, resourceId: string, version: number, requireReady: boolean): Promise<WorkspaceCompletionResourceVersion> {
    const result = await sql.query<VersionRow & { batch_status?: "db_committed" | "renamed" | "rolled_back" }>(
      `SELECT resource_version.*, batch.status AS batch_status
       FROM workspace_completion_resource_versions resource_version
       LEFT JOIN workspace_completion_file_batches batch ON batch.workspace_id = resource_version.workspace_id AND batch.id = resource_version.file_batch_id
       WHERE resource_version.workspace_id = $1 AND resource_version.resource_id = $2 AND resource_version.version = $3`,
      [workspaceId, resourceId, version]
    );
    const row = result.rows[0];
    if (!row) throw new WorkspaceServerError("workspace_completion_resource_version_not_found", 404);
    if (requireReady && row.file_batch_id && row.batch_status !== "renamed") throw new WorkspaceServerError("workspace_completion_file_recovery_required", 503, { resource_id: resourceId });
    return versionFromRow(row);
  }

  private async currentVersionForResource(sql: WorkspaceSql, workspaceId: string, resource: WorkspaceCompletionResource, requireReady: boolean): Promise<WorkspaceCompletionResourceVersion> {
    const version = resource.currentConfirmedVersion ?? resource.currentProvisionalVersion;
    if (!version) throw new WorkspaceServerError("workspace_completion_resource_version_not_ready", 503);
    return this.selectVersion(sql, workspaceId, resource.id, version, requireReady);
  }

  private async selectResourceForUpdate(sql: WorkspaceSql, workspaceId: string, resourceId: string): Promise<WorkspaceCompletionResource | undefined> {
    const selected = await sql.query<ResourceRow>("SELECT * FROM workspace_completion_resources WHERE workspace_id = $1 AND id = $2 FOR UPDATE", [workspaceId, resourceId]);
    return selected.rows[0] ? resourceFromRow(selected.rows[0]) : undefined;
  }

  private async selectEpisode(sql: WorkspaceSql, workspaceId: string, episodeId: string): Promise<WorkspaceCompletionEpisode> {
    const selected = await sql.query<EpisodeRow>("SELECT * FROM workspace_completion_episodes WHERE workspace_id = $1 AND id = $2", [workspaceId, episodeId]);
    if (!selected.rows[0]) throw new WorkspaceServerError("workspace_completion_episode_not_found", 404);
    return episodeFromRow(selected.rows[0]);
  }

  private async selectActivity(sql: WorkspaceSql, workspaceId: string, activityId: string): Promise<WorkspaceCompletionActivity> {
    const selected = await sql.query<ActivityRow>("SELECT * FROM workspace_completion_activities WHERE workspace_id = $1 AND id = $2", [workspaceId, activityId]);
    if (!selected.rows[0]) throw new WorkspaceServerError("workspace_completion_activity_not_found", 404);
    return activityFromRow(selected.rows[0]);
  }

  private async assertEpisodeContainsActivity(sql: WorkspaceSql, workspaceId: string, episodeId: string, activityId: string): Promise<void> {
    const found = await sql.query<{ exists: boolean }>(
      "SELECT EXISTS(SELECT 1 FROM workspace_completion_episode_activities WHERE workspace_id = $1 AND episode_id = $2 AND activity_id = $3) AS exists",
      [workspaceId, episodeId, activityId]
    );
    if (found.rows[0]?.exists !== true) throw new WorkspaceServerError("workspace_completion_episode_activity_mismatch", 409);
  }

  /** Model-derived Resource versions are room-local.  Checking this inside
   * the same transaction prevents a forged Activity ID from becoming
   * provenance for another Room through a non-HTTP caller. */
  private async assertAiEvidenceScope(sql: WorkspaceSql, workspaceId: string, input: WorkspaceCompletionResourceInput): Promise<void> {
    if (input.scope.kind !== "room" || !input.scope.roomId || !input.evidenceEpisodeId || !input.evidenceActivityIds?.length) {
      throw new WorkspaceServerError("workspace_completion_ai_evidence_scope_required", 422);
    }
    const episode = await this.selectEpisode(sql, workspaceId, input.evidenceEpisodeId);
    if (episode.roomId !== input.scope.roomId) throw new WorkspaceServerError("workspace_completion_ai_evidence_cross_room_denied", 403);
    for (const activityId of input.evidenceActivityIds) {
      await this.assertEpisodeContainsActivity(sql, workspaceId, episode.id, activityId);
    }
  }

  private async resolveEpisodeForActivity(sql: WorkspaceSql, context: WorkspaceRequestContext, input: WorkspaceCompletionActivityInput, activityId: string): Promise<WorkspaceCompletionEpisode> {
    if (input.episodeId) {
      const episode = await this.selectEpisode(sql, context.workspaceId, input.episodeId);
      if (episode.roomId !== input.roomId) throw new WorkspaceServerError("workspace_completion_episode_cross_room_denied", 403);
      return episode;
    }
    if (input.correctionOfActivityId) {
      const correction = await sql.query<EpisodeRow>(
        `SELECT episode.* FROM workspace_completion_episode_activities link
         JOIN workspace_completion_episodes episode ON episode.workspace_id = link.workspace_id AND episode.id = link.episode_id
         WHERE link.workspace_id = $1 AND link.activity_id = $2`,
        [context.workspaceId, input.correctionOfActivityId]
      );
      const episode = correction.rows[0];
      if (!episode) throw new WorkspaceServerError("workspace_completion_correction_activity_not_found", 404);
      if (episode.room_id !== input.roomId) throw new WorkspaceServerError("workspace_completion_correction_cross_room_denied", 403);
      return episodeFromRow(episode);
    }
    if (input.externalEpisodeKey) {
      const found = await sql.query<EpisodeRow>(
        "SELECT * FROM workspace_completion_episodes WHERE workspace_id = $1 AND room_id = $2 AND external_episode_key = $3 FOR UPDATE",
        [context.workspaceId, input.roomId, input.externalEpisodeKey]
      );
      if (found.rows[0]) return episodeFromRow(found.rows[0]);
    }
    if (input.operationId) {
      const found = await sql.query<EpisodeRow>(
        `SELECT episode.* FROM workspace_completion_activities activity
         JOIN workspace_completion_episode_activities link ON link.workspace_id = activity.workspace_id AND link.activity_id = activity.id
         JOIN workspace_completion_episodes episode ON episode.workspace_id = link.workspace_id AND episode.id = link.episode_id
         WHERE activity.workspace_id = $1 AND activity.room_id = $2 AND activity.operation_id = $3
         ORDER BY activity.created_at DESC LIMIT 1 FOR UPDATE`,
        [context.workspaceId, input.roomId, input.operationId]
      );
      if (found.rows[0]) return episodeFromRow(found.rows[0]);
    }
    const id = completionId("completion_episode", context.workspaceId, input.externalEpisodeKey ?? input.operationId ?? activityId);
    const inserted = await sql.query<EpisodeRow>(
      `INSERT INTO workspace_completion_episodes(workspace_id, room_id, id, goal, source_app, external_episode_key, session_ref, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7::JSONB, $8, $8) RETURNING *`,
      [context.workspaceId, input.roomId, id, input.goal?.trim() || input.instructionSummary.trim(), input.sourceApp.trim(), input.externalEpisodeKey ?? null, input.sessionRef ? canonicalJson(input.sessionRef) : null, context.accountId]
    );
    return episodeFromRow(inserted.rows[0]!);
  }

  private async enqueueReviewJob(sql: WorkspaceSql, context: WorkspaceRequestContext, episode: WorkspaceCompletionEpisode, activity: WorkspaceCompletionActivity, highPriority: boolean): Promise<WorkspaceCompletionJob> {
    const idempotencyKey = `review:${episode.id}:${activity.id}`;
    const id = completionId("completion_job", context.workspaceId, idempotencyKey);
    const inputHash = hashText(canonicalJson({ episode_id: episode.id, activity_id: activity.id, finalized_at: activity.finalizedAt }));
    const configuration = await this.effectiveConfigurationInSql(sql, context.workspaceId, episode.roomId);
    const inserted = await sql.query<JobRow>(
      `INSERT INTO workspace_completion_jobs(workspace_id, room_id, id, kind, status, idempotency_key, group_key, high_watermark, input_hash, configuration_version, max_attempts, created_by, updated_by)
       VALUES ($1, $2, $3, 'review', 'queued', $4, $5, $6, $7, $8, $9, $10, $10)
       ON CONFLICT (workspace_id, idempotency_key) DO UPDATE SET updated_at = NOW()
       RETURNING *`,
      [context.workspaceId, episode.roomId, id, idempotencyKey, episode.id, activity.id, inputHash, configuration.version, configuration.values.reviewMaxAttempts, context.accountId]
    );
    const job = jobFromRow(inserted.rows[0]!);
    if (highPriority) {
      await sql.query("UPDATE workspace_completion_jobs SET updated_at = NOW() WHERE workspace_id = $1 AND id = $2", [context.workspaceId, job.id]);
    }
    return job;
  }

  private async enqueueEvaluationJob(
    sql: WorkspaceSql,
    context: WorkspaceRequestContext,
    episode: WorkspaceCompletionEpisode,
    activity: WorkspaceCompletionActivity,
    triggerId: string
  ): Promise<WorkspaceCompletionJob> {
    const idempotencyKey = `evaluation:${episode.id}:${activity.id}:${triggerId}`;
    const id = completionId("completion_job", context.workspaceId, idempotencyKey);
    const configuration = await this.effectiveConfigurationInSql(sql, context.workspaceId, episode.roomId);
    const uses = await this.evaluationUsesForEpisode(sql, context.workspaceId, episode);
    const attested = await this.hasConfirmedActivityAttestation(sql, context.workspaceId, activity);
    // The same full input is recalculated under the apply transaction.  A
    // claim on the Activity is not proof; only this persisted attestation bit
    // may turn a completed Activity into a confirmed success.
    const inputHash = evaluationJobHash(episode, activity, uses, attested);
    const inserted = await sql.query<JobRow>(
      `INSERT INTO workspace_completion_jobs(
         workspace_id, room_id, id, kind, status, idempotency_key, group_key,
         high_watermark, input_hash, configuration_version, max_attempts, created_by, updated_by
       ) VALUES ($1, $2, $3, 'evaluation', 'queued', $4, $5, $6, $7, $8, $9, $10, $10)
       ON CONFLICT (workspace_id, idempotency_key) DO UPDATE SET updated_at = NOW()
       RETURNING *`,
      [
        context.workspaceId,
        episode.roomId,
        id,
        idempotencyKey,
        episode.id,
        activity.id,
        inputHash,
        configuration.version,
        configuration.values.reviewMaxAttempts,
        context.accountId
      ]
    );
    return jobFromRow(inserted.rows[0]!);
  }

  private async latestEvaluationActivityForEpisode(
    sql: WorkspaceSql,
    workspaceId: string,
    episodeId: string
  ): Promise<WorkspaceCompletionActivity | undefined> {
    const result = await sql.query<ActivityRow>(
      `SELECT activity.*
       FROM workspace_completion_episode_activities link
       JOIN workspace_completion_activities activity
         ON activity.workspace_id = link.workspace_id AND activity.id = link.activity_id
       WHERE link.workspace_id = $1 AND link.episode_id = $2 AND activity.outcome <> 'cancelled'
       ORDER BY activity.finalized_at DESC, activity.id DESC LIMIT 1`,
      [workspaceId, episodeId]
    );
    return result.rows[0] ? activityFromRow(result.rows[0]) : undefined;
  }

  private async evaluationUsesForEpisode(
    sql: WorkspaceSql,
    workspaceId: string,
    episode: WorkspaceCompletionEpisode
  ): Promise<UseRow[]> {
    const result = await sql.query<UseRow>(
      `SELECT DISTINCT ON (use_event.resource_id, use_event.resource_version) use_event.*
       FROM workspace_completion_uses use_event
       JOIN workspace_completion_resources resource
         ON resource.workspace_id = use_event.workspace_id AND resource.id = use_event.resource_id
       WHERE use_event.workspace_id = $1 AND use_event.episode_id = $2
         AND use_event.event IN ('actually_used', 'outcome')
         AND resource.lifecycle_state <> 'archived'
         AND (resource.scope_kind = 'workspace' OR resource.room_id = $3)
       ORDER BY use_event.resource_id, use_event.resource_version, use_event.created_at DESC, use_event.id DESC`,
      [workspaceId, episode.id, episode.roomId]
    );
    return result.rows;
  }

  private async latestEvaluationForSourceActivity(
    sql: WorkspaceSql,
    workspaceId: string,
    resourceId: string,
    resourceVersion: number,
    episodeId: string,
    sourceActivityId: string
  ): Promise<WorkspaceCompletionEvaluation | undefined> {
    const result = await sql.query<EvaluationRow>(
      `SELECT * FROM workspace_completion_evaluations
       WHERE workspace_id = $1 AND resource_id = $2 AND resource_version = $3
         AND episode_id = $4 AND source_activity_id = $5
       ORDER BY created_at DESC, id DESC LIMIT 1`,
      [workspaceId, resourceId, resourceVersion, episodeId, sourceActivityId]
    );
    return result.rows[0] ? evaluationFromRow(result.rows[0]) : undefined;
  }

  private async hasConfirmedActivityAttestation(
    sql: WorkspaceSql,
    workspaceId: string,
    activity: WorkspaceCompletionActivity
  ): Promise<boolean> {
    const result = await sql.query<{ confirmed: boolean }>(
      `SELECT EXISTS(
         SELECT 1 FROM workspace_completion_attestations
         WHERE workspace_id = $1 AND activity_id = $2 AND outcome = 'confirmed'
           AND expected_content_hash = $3 AND observed_content_hash = $3
       ) AS confirmed`,
      [workspaceId, activity.id, activityAttestationHash(activity)]
    );
    return result.rows[0]?.confirmed === true;
  }

  private async assertPromotionEligible(
    sql: WorkspaceSql,
    workspaceId: string,
    resource: WorkspaceCompletionResource,
    candidate: WorkspaceCompletionResourceVersion
  ): Promise<void> {
    if (candidate.creationSource !== "ai") throw new WorkspaceServerError("workspace_completion_candidate_not_ai", 409);
    const threshold = resource.kind === "skill"
      ? (await this.effectiveTuningInSql(sql, workspaceId, resource.scope.roomId)).skillEpisodeSuccesses
      : resource.kind === "knowledge" && resource.knowledgeKind === "experience_rule"
        ? (await this.effectiveTuningInSql(sql, workspaceId, resource.scope.roomId)).experienceRuleEpisodeSuccesses
        : undefined;
    if (!threshold) throw new WorkspaceServerError("workspace_completion_automatic_promotion_not_eligible", 409);
    const evaluation = await sql.query<{ successes: number | string; failures: number | string }>(
      `SELECT
         COUNT(*) FILTER (WHERE outcome = 'confirmed_success') AS successes,
         COUNT(*) FILTER (WHERE outcome = 'confirmed_failure') AS failures
       FROM (
         SELECT DISTINCT ON (episode_id) episode_id, outcome
         FROM workspace_completion_evaluations
         WHERE workspace_id = $1 AND resource_id = $2 AND resource_version = $3
         ORDER BY episode_id, created_at DESC, id DESC
       ) latest`,
      [workspaceId, resource.id, candidate.version]
    );
    const unresolved = await sql.query<{ exists: boolean }>(
      `SELECT EXISTS(
         SELECT 1 FROM workspace_completion_evidence evidence
         JOIN workspace_completion_activities activity ON activity.workspace_id = evidence.workspace_id AND activity.id = evidence.activity_id
         WHERE evidence.workspace_id = $1 AND evidence.resource_id = $2 AND evidence.resource_version = $3
           AND activity.failure_state = 'unresolved'
       ) AS exists`,
      [workspaceId, resource.id, candidate.version]
    );
    const successes = Number(evaluation.rows[0]?.successes ?? 0);
    const failures = Number(evaluation.rows[0]?.failures ?? 0);
    if (successes < threshold || failures > 0 || unresolved.rows[0]?.exists === true) {
      throw new WorkspaceServerError("workspace_completion_promotion_evidence_insufficient", 409, { successes, required_successes: threshold, failures, unresolved_failure: unresolved.rows[0]?.exists === true });
    }
  }

  private async effectiveTuningInSql(sql: WorkspaceSql, workspaceId: string, roomId: string | undefined): Promise<WorkspaceCompletionTuning> {
    return (await this.effectiveConfigurationInSql(sql, workspaceId, roomId)).values;
  }

  private async effectiveConfigurationInSql(sql: WorkspaceSql, workspaceId: string, roomId: string | undefined): Promise<{ version: number; values: WorkspaceCompletionTuning }> {
    const result = await sql.query<ConfigurationRow>(
      `SELECT * FROM workspace_completion_configurations
       WHERE workspace_id = $1 AND (scope_key = 'workspace' OR ($2::TEXT IS NOT NULL AND scope_key = $2))
       ORDER BY CASE WHEN $2::TEXT IS NOT NULL AND scope_key = $2 THEN 1 ELSE 0 END DESC, version DESC`,
      [workspaceId, roomId ?? null]
    );
    const room = roomId ? result.rows.find((row) => row.scope_key === roomId) : undefined;
    const workspace = result.rows.find((row) => row.scope_key === "workspace");
    if (room) return { version: numeric(room.version), values: validateWorkspaceCompletionTuning(room.values) };
    if (workspace) return { version: numeric(workspace.version), values: validateWorkspaceCompletionTuning(workspace.values) };
    return { version: 1, values: defaultTuning() };
  }

  private async prepareAttestation(
    context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">,
    request: WorkspaceCompletionAttestationRequest
  ): Promise<PreparedAttestationTarget> {
    return this.store.database.withContext(context, async (sql) => {
      if (request.target.resourceId) {
        const selected = await this.selectReadableResource(sql, context.workspaceId, request.target.resourceId, false);
        const version = await this.selectVersion(sql, context.workspaceId, request.target.resourceId, request.target.resourceVersion!, true);
        if (!sameScope(selected.resource.scope, request.scope) || version.contentHash !== request.expectedContentHash) {
          throw new WorkspaceServerError("workspace_completion_attestation_target_mismatch", 409);
        }
        return { resource: selected.resource, version, expectedHash: version.contentHash };
      }
      const activity = await this.selectActivity(sql, context.workspaceId, request.target.activityId!);
      if (request.scope.kind !== "room" || request.scope.roomId !== activity.roomId) {
        throw new WorkspaceServerError("workspace_completion_attestation_target_mismatch", 409);
      }
      const expectedHash = activityAttestationHash(activity);
      if (expectedHash !== request.expectedContentHash) throw new WorkspaceServerError("workspace_completion_attestation_target_mismatch", 409);
      return { activityId: activity.id, activityHash: expectedHash, expectedHash };
    });
  }

  private async verifyAttestationTargetInTransaction(
    sql: WorkspaceSql,
    context: WorkspaceRequestContext,
    request: WorkspaceCompletionAttestationRequest,
    prepared: PreparedAttestationTarget
  ): Promise<PreparedAttestationTarget & { hashMatches: boolean }> {
    if (request.target.resourceId) {
      const resource = await this.selectResourceForUpdate(sql, context.workspaceId, request.target.resourceId);
      if (!resource) throw new WorkspaceServerError("workspace_completion_resource_not_found", 404);
      const version = await this.selectVersion(sql, context.workspaceId, resource.id, request.target.resourceVersion!, true);
      await this.assertPolicyAllowed(sql, context, scopeRoom(resource.scope), "resource.update", authorityForScope(resource.scope), { attestation: true });
      return {
        resource,
        version,
        expectedHash: prepared.expectedHash,
        hashMatches: resource.version === request.target.resourceVersion
          && sameScope(resource.scope, request.scope)
          && version.contentHash === request.expectedContentHash
      };
    }
    const activity = await this.selectActivity(sql, context.workspaceId, request.target.activityId!);
    await this.assertPolicyAllowed(sql, context, activity.roomId, "activity.ingest", "execute", { attestation: true });
    const activityHash = activityAttestationHash(activity);
    return {
      activityId: activity.id,
      activityHash,
      expectedHash: prepared.expectedHash,
      hashMatches: request.scope.kind === "room" && request.scope.roomId === activity.roomId && activityHash === request.expectedContentHash
    };
  }

  private async insertEvidence(
    sql: WorkspaceSql,
    workspaceId: string,
    resourceId: string,
    resourceVersion: number,
    input: { kind: WorkspaceCompletionEvidence["kind"]; summary: string; activityId?: string; episodeId?: string; attestationId?: string }
  ): Promise<WorkspaceCompletionEvidence> {
    const inserted = await sql.query<EvidenceRow>(
      `INSERT INTO workspace_completion_evidence(workspace_id, id, resource_id, resource_version, activity_id, episode_id, kind, attestation_id, summary)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [workspaceId, completionId("completion_evidence", workspaceId, `${resourceId}:${resourceVersion}:${input.kind}:${input.attestationId ?? ""}:${input.summary}`), resourceId, resourceVersion, input.activityId ?? null, input.episodeId ?? null, input.kind, input.attestationId ?? null, input.summary]
    );
    return evidenceFromRow(inserted.rows[0]!);
  }

  /** Shared internal command guard for Scheduler/Curator paths. It receives
   * the already-RLS-scoped transaction; it cannot grant an RLS-denied write. */
  async assertOperationAllowed(
    sql: WorkspaceSql,
    context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId" | "caller">,
    roomId: string | undefined,
    operation: WorkspaceCompletionPolicyOperation,
    authority: "execute" | "edit" | "admin",
    attributes: WorkspaceCompletionPolicyEvaluationInput["attributes"]
  ): Promise<void> {
    await this.assertPolicyAllowed(sql, context, roomId, operation, authority, attributes);
  }

  private async insertResourceEvidence(
    sql: WorkspaceSql,
    workspaceId: string,
    resourceId: string,
    resourceVersion: number,
    input: WorkspaceCompletionResourceInput,
    source: WorkspaceCompletionCreationSource
  ): Promise<void> {
    if (source === "import") return;
    if (source === "physical_file_import") {
      await this.insertEvidence(sql, workspaceId, resourceId, resourceVersion, {
        kind: "physical_file_import",
        summary: input.reason.trim()
      });
      return;
    }
    if (source !== "ai") {
      await this.insertEvidence(sql, workspaceId, resourceId, resourceVersion, { kind: "human_edit", summary: input.reason.trim() });
      return;
    }
    for (const activityId of input.evidenceActivityIds ?? []) {
      await this.insertEvidence(sql, workspaceId, resourceId, resourceVersion, {
        kind: "activity", activityId, ...(input.evidenceEpisodeId ? { episodeId: input.evidenceEpisodeId } : {}), summary: input.reason.trim()
      });
    }
  }

  private async insertPolicyRules(
    sql: WorkspaceSql,
    context: WorkspaceRequestContext,
    resource: WorkspaceCompletionResource,
    version: number,
    rules: readonly WorkspaceCompletionPolicyRule[],
    signature: string,
    enabled: boolean
  ): Promise<void> {
    for (const rule of rules) {
      await sql.query(
        `INSERT INTO workspace_completion_policy_rules(
           workspace_id, id, resource_id, resource_version, operation, effect, principal_account_id,
           connection_id, conditions, enabled, human_signature, signed_by
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::JSONB, $10, $11, $12)`,
        [
          context.workspaceId, completionId("completion_policy_rule", context.workspaceId, `${resource.id}:${version}:${rule.id}`), resource.id, version,
          rule.operation, rule.effect, rule.principalAccountId ?? null, rule.connectionId ?? null, canonicalJson(rule.conditions), enabled, signature, context.accountId
        ]
      );
    }
  }

  private async insertPolicyApproval(
    sql: WorkspaceSql,
    context: WorkspaceRequestContext,
    resource: WorkspaceCompletionResource,
    version: number,
    approvalId: string,
    approval: TrustedHumanPolicyApproval,
    change: WorkspaceRecordPayload
  ): Promise<void> {
    await sql.query(
      `INSERT INTO workspace_completion_policy_approvals(
         workspace_id, id, resource_id, resource_version, principal_account_id,
         operation_id, request_id, request_timestamp, canonical_payload_hash,
         signature, change, audit_operation_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::TIMESTAMPTZ, $9, $10, $11::JSONB, $12)`,
      [
        context.workspaceId, approvalId, resource.id, version, approval.principalAccountId,
        approval.operationId, approval.requestId, approval.requestTimestamp, approval.canonicalPayloadHash,
        approval.signature, canonicalJson(change), context.operationId
      ]
    );
  }

  private async assertPolicyAllowed(
    sql: WorkspaceSql,
    context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId" | "caller">,
    roomId: string | undefined,
    operation: WorkspaceCompletionPolicyOperation,
    authority: "execute" | "edit" | "admin",
    attributes: WorkspaceCompletionPolicyEvaluationInput["attributes"]
  ): Promise<void> {
    const baseAllowed = await this.baseAuthority(sql, context.workspaceId, roomId, authority);
    const evaluation = await this.evaluatePolicy(sql, context, roomId, operation, baseAllowed, attributes);
    if (!evaluation.allowed) throw new WorkspaceServerError("workspace_completion_policy_denied", 403, { required: evaluation.required, denied_by: evaluation.deniedBy });
  }

  private async evaluatePolicy(
    sql: WorkspaceSql,
    context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId" | "caller">,
    roomId: string | undefined,
    operation: WorkspaceCompletionPolicyOperation,
    baseAllowed: boolean,
    attributes: WorkspaceCompletionPolicyEvaluationInput["attributes"]
  ): Promise<{ allowed: boolean; required: readonly string[]; deniedBy: readonly string[] }> {
    const rules = await sql.query<PolicyRuleRow>(
      `SELECT rule.*, resource.scope_kind, resource.room_id
       FROM workspace_completion_policy_rules rule
       JOIN workspace_completion_resources resource ON resource.workspace_id = rule.workspace_id AND resource.id = rule.resource_id
       JOIN workspace_completion_policy_approvals approval
         ON approval.workspace_id = rule.workspace_id
        AND approval.resource_id = rule.resource_id
        AND approval.resource_version = rule.resource_version
       WHERE rule.workspace_id = $1 AND rule.operation = $2 AND rule.enabled
         AND resource.resource_kind = 'policy' AND resource.lifecycle_state = 'active'
         AND resource.current_confirmed_version = rule.resource_version
         AND (resource.scope_kind = 'workspace' OR resource.room_id = $3)`,
      [context.workspaceId, operation, roomId ?? null]
    );
    const workspaceRules: WorkspaceCompletionPolicyRule[] = [];
    const roomRules: WorkspaceCompletionPolicyRule[] = [];
    for (const row of rules.rows) {
      const rule = policyRuleFromRow(row);
      if (row.scope_kind === "workspace") workspaceRules.push(rule);
      else roomRules.push(rule);
    }
    const caller = isTrustedWorkspaceCallerForAccount(context.caller, context.accountId) ? context.caller : undefined;
    return evaluateWorkspaceCompletionPolicies(workspaceRules, roomRules, {
      operation,
      accountId: caller?.principalAccountId ?? context.accountId,
      callerKind: caller?.kind ?? "unknown",
      ...(caller?.kind === "connection" ? { connectionId: caller.connectionId } : {}),
      attributes,
      baseAllowed
    });
  }

  private async baseAuthority(sql: WorkspaceSql, workspaceId: string, roomId: string | undefined, authority: "execute" | "edit" | "admin"): Promise<boolean> {
    if (authority === "admin") {
      const result = await sql.query<{ allowed: boolean }>("SELECT samurai_workspace_is_writable($1) AND samurai_can_workspace($1, 'admin') AS allowed", [workspaceId]);
      return result.rows[0]?.allowed === true;
    }
    if (!roomId) return false;
    const result = await sql.query<{ allowed: boolean }>(
      "SELECT samurai_workspace_is_writable($1) AND samurai_can_room($1, $2, $3) AS allowed",
      [workspaceId, roomId, authority]
    );
    return result.rows[0]?.allowed === true;
  }

  private async readWorkspaceDocumentMetadata(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, kind: "profile" | "soul"): Promise<WorkspaceDocument> {
    return this.store.database.withContext(context, async (sql) => {
      const result = await sql.query<WorkspaceDocumentRow & { batch_status: "db_committed" | "renamed" | "rolled_back" | null }>(
        `SELECT document.*, batch.status AS batch_status
         FROM workspace_completion_workspace_documents document
         JOIN workspace_completion_file_batches batch ON batch.workspace_id = document.workspace_id AND batch.id = document.file_batch_id
         WHERE document.workspace_id = $1 AND document.kind = $2`,
        [context.workspaceId, kind]
      );
      const row = result.rows[0];
      if (!row) throw new WorkspaceServerError("workspace_completion_workspace_document_not_found", 404);
      if (row.batch_status !== "renamed") throw new WorkspaceServerError("workspace_completion_file_recovery_required", 503, { kind });
      return workspaceDocumentFromRow(row);
    });
  }

  private async defaultWritableRoom(sql: WorkspaceSql, workspaceId: string): Promise<string> {
    const room = await sql.query<{ id: string }>(
      "SELECT id FROM rooms WHERE workspace_id = $1 AND samurai_can_room(workspace_id, id, 'edit') ORDER BY created_at ASC LIMIT 1",
      [workspaceId]
    );
    if (!room.rows[0]) throw new WorkspaceServerError("workspace_completion_writable_room_required", 403);
    return room.rows[0].id;
  }
}

interface ResourceRow {
  workspace_id: string;
  id: string;
  scope_kind: "workspace" | "room";
  room_id: string | null;
  resource_kind: WorkspaceCompletionResourceKind;
  knowledge_kind: WorkspaceCompletionKnowledgeKind | null;
  title: string;
  evidence_state: WorkspaceCompletionEvidenceState;
  lifecycle_state: WorkspaceCompletionLifecycleState;
  ai_protection: WorkspaceCompletionAiProtection;
  creation_source: WorkspaceCompletionCreationSource;
  ai_managed: boolean;
  version: number | string;
  current_confirmed_version: number | string | null;
  current_provisional_version: number | string | null;
  candidate_version: number | string | null;
  archived_at: Date | string | null;
  created_by: string;
  updated_by: string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface ReviewResourceRow extends ResourceRow {
  snapshot_content_hash: string;
}

interface PreparedReviewDocument {
  resource: WorkspaceCompletionResourceInput & { id: string; expectedVersion: number };
  version: number;
  path: string;
  content: Uint8Array;
  conflictTargetId?: string;
}

interface WorkspaceCompletionSkillPackageSnapshot extends WorkspaceCompletionReadResource {
  content: string;
  supportFiles: readonly {
    relativePath: string;
    filePath: string;
    contentHash: string;
    contentSize: number;
    content: Buffer;
  }[];
  packageHash: string;
}

interface VersionRow {
  workspace_id: string;
  id: string;
  resource_id: string;
  version: number | string;
  parent_version: number | string | null;
  file_path: string;
  content_hash: string;
  content_size: number | string;
  evidence_state: WorkspaceCompletionEvidenceState;
  lifecycle_state: WorkspaceCompletionLifecycleState;
  ai_protection: WorkspaceCompletionAiProtection;
  creation_source: WorkspaceCompletionCreationSource;
  metadata: unknown;
  reason: string;
  actor_account_id: string;
  created_at: Date | string;
  file_batch_id?: string | null;
}

interface SkillFileRow {
  workspace_id: string;
  id: string;
  resource_id: string;
  resource_version: number | string;
  relative_path: string;
  file_path: string;
  content_hash: string;
  content_size: number | string;
  file_batch_id: string;
  created_at: Date | string;
}

interface ActivityRow {
  workspace_id: string;
  room_id: string;
  id: string;
  principal_account_id: string;
  source_app: string;
  source_id: string | null;
  external_episode_key: string | null;
  correction_of_activity_id: string | null;
  operation_id: string | null;
  instruction_summary: string;
  result_summary: string | null;
  changed_resources: unknown;
  verification_outcome: WorkspaceCompletionVerificationState;
  failure_state: WorkspaceCompletionFailureState;
  outcome: WorkspaceCompletionActivityOutcome;
  explicit_remember: boolean;
  payload: unknown;
  session_ref: unknown;
  created_at: Date | string;
  finalized_at: Date | string;
}

interface EpisodeRow {
  workspace_id: string;
  room_id: string;
  id: string;
  goal: string;
  source_app: string | null;
  external_episode_key: string | null;
  outcome: WorkspaceCompletionEpisodeOutcome;
  started_at: Date | string;
  ended_at: Date | string | null;
  session_ref: unknown;
  version: number | string;
  created_by: string;
  updated_by: string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface EvidenceRow {
  workspace_id: string;
  id: string;
  resource_id: string;
  resource_version: number | string;
  activity_id: string | null;
  episode_id: string | null;
  kind: WorkspaceCompletionEvidence["kind"];
  attestation_id: string | null;
  summary: string;
  created_at: Date | string;
}

interface AttestationRow {
  workspace_id: string;
  id: string;
  activity_id: string | null;
  resource_id: string | null;
  resource_version: number | string | null;
  source_ref: string;
  source_version: string;
  expected_content_hash: string;
  observed_content_hash: string | null;
  outcome: WorkspaceCompletionAttestation["outcome"];
  attestor_id: string;
  failure_reasons: unknown;
  attested_at: Date | string;
  created_at: Date | string;
}

interface PreparedAttestationTarget {
  resource?: WorkspaceCompletionResource;
  version?: WorkspaceCompletionResourceVersion;
  activityId?: string;
  activityHash?: string;
  expectedHash: string;
}

interface UseRow {
  workspace_id: string;
  id: string;
  resource_id: string;
  resource_version: number | string;
  activity_id: string | null;
  episode_id: string | null;
  event: WorkspaceCompletionUseEvent["event"];
  outcome: WorkspaceCompletionUseEvent["outcome"] | null;
  supersedes_use_id: string | null;
  summary: string;
  created_at: Date | string;
}

interface EvaluationRow {
  workspace_id: string;
  id: string;
  resource_id: string;
  resource_version: number | string;
  episode_id: string;
  outcome: WorkspaceCompletionEvaluation["outcome"];
  source_activity_id: string | null;
  correction_of_evaluation_id: string | null;
  created_at: Date | string;
}

interface JobRow {
  workspace_id: string;
  room_id: string;
  id: string;
  kind: WorkspaceCompletionJob["kind"];
  status: WorkspaceCompletionJob["status"];
  idempotency_key: string;
  group_key: string | null;
  high_watermark: string | null;
  input_hash: string;
  configuration_version: number | string;
  attempt_count: number | string;
  max_attempts: number | string;
  lease_owner: string | null;
  lease_expires_at: Date | string | null;
  heartbeat_at: Date | string | null;
  blocked_reason: string | null;
  created_by: string;
  updated_by: string;
  created_at: Date | string;
  updated_at: Date | string;
  completed_at: Date | string | null;
}

interface RawOutputRow {
  workspace_id: string;
  id: string;
  job_id: string;
  attempt_id: string;
  direction: "request" | "response";
  content: string | null;
  content_hash: string;
  created_by: string;
  created_at: Date | string;
  redacted_at: Date | string | null;
}

interface PolicyRuleRow {
  workspace_id: string;
  id: string;
  resource_id: string;
  resource_version: number | string;
  operation: WorkspaceCompletionPolicyRule["operation"];
  effect: WorkspaceCompletionPolicyRule["effect"];
  principal_account_id: string | null;
  connection_id: string | null;
  conditions: unknown;
  enabled: boolean;
  human_signature: string;
  signed_by: string;
  created_at: Date | string;
  scope_kind: "workspace" | "room";
  room_id: string | null;
}

interface PolicyChangeRequestRow {
  workspace_id: string;
  room_id: string;
  id: string;
  requested_by: string;
  source_job_id: string | null;
  summary: string;
  proposed_rules: unknown;
  status: WorkspaceCompletionPolicyChangeRequest["status"];
  created_at: Date | string;
  updated_at: Date | string;
}

interface ConfigurationRow {
  workspace_id: string;
  scope_key: string;
  scope_kind: "workspace" | "room";
  room_id: string | null;
  version: number | string;
  values: unknown;
  updated_by: string;
  created_at: Date | string;
}

interface WorkspaceDocumentRow {
  workspace_id: string;
  kind: "profile" | "soul";
  file_path: string;
  content_hash: string;
  content_size: number | string;
  version: number | string;
  file_batch_id: string;
  updated_by: string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface WorkspaceDocument {
  workspaceId: string;
  kind: "profile" | "soul";
  filePath: string;
  contentHash: string;
  contentSize: number;
  version: number;
  fileBatchId: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
}

function resourceFromRow(row: ResourceRow): WorkspaceCompletionResource {
  return {
    workspaceId: row.workspace_id,
    id: row.id,
    scope: row.scope_kind === "room" ? { kind: "room", roomId: requiredRoomId(row.room_id) } : { kind: "workspace" },
    kind: row.resource_kind,
    ...(row.knowledge_kind ? { knowledgeKind: row.knowledge_kind } : {}),
    title: row.title,
    evidenceState: row.evidence_state,
    lifecycleState: row.lifecycle_state,
    aiProtection: row.ai_protection,
    creationSource: row.creation_source,
    aiManaged: row.ai_managed,
    version: numeric(row.version),
    ...(row.current_confirmed_version === null ? {} : { currentConfirmedVersion: numeric(row.current_confirmed_version) }),
    ...(row.current_provisional_version === null ? {} : { currentProvisionalVersion: numeric(row.current_provisional_version) }),
    ...(row.candidate_version === null ? {} : { candidateVersion: numeric(row.candidate_version) }),
    ...(row.archived_at ? { archivedAt: iso(row.archived_at) } : {}),
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

function versionFromRow(row: VersionRow): WorkspaceCompletionResourceVersion {
  return {
    workspaceId: row.workspace_id,
    id: row.id,
    resourceId: row.resource_id,
    version: numeric(row.version),
    ...(row.parent_version === null ? {} : { parentVersion: numeric(row.parent_version) }),
    filePath: row.file_path,
    contentHash: row.content_hash,
    contentSize: numeric(row.content_size),
    evidenceState: row.evidence_state,
    lifecycleState: row.lifecycle_state,
    aiProtection: row.ai_protection,
    creationSource: row.creation_source,
    metadata: payloadFrom(row.metadata),
    reason: row.reason,
    actorAccountId: row.actor_account_id,
    createdAt: iso(row.created_at)
  };
}

function skillFileFromRow(row: SkillFileRow): WorkspaceCompletionSkillFile {
  return {
    workspaceId: row.workspace_id,
    id: row.id,
    resourceId: row.resource_id,
    resourceVersion: numeric(row.resource_version),
    relativePath: row.relative_path,
    filePath: row.file_path,
    contentHash: row.content_hash,
    contentSize: numeric(row.content_size),
    fileBatchId: row.file_batch_id,
    createdAt: iso(row.created_at)
  };
}

function activityFromRow(row: ActivityRow): WorkspaceCompletionActivity {
  return {
    workspaceId: row.workspace_id,
    roomId: row.room_id,
    id: row.id,
    principalAccountId: row.principal_account_id,
    sourceApp: row.source_app,
    ...(row.source_id ? { sourceId: row.source_id } : {}),
    ...(row.external_episode_key ? { externalEpisodeKey: row.external_episode_key } : {}),
    ...(row.correction_of_activity_id ? { correctionOfActivityId: row.correction_of_activity_id } : {}),
    ...(row.operation_id ? { operationId: row.operation_id } : {}),
    instructionSummary: row.instruction_summary,
    ...(row.result_summary ? { resultSummary: row.result_summary } : {}),
    changedResources: arrayOfStrings(row.changed_resources),
    verificationOutcome: row.verification_outcome,
    failureState: row.failure_state,
    outcome: row.outcome,
    explicitRemember: row.explicit_remember,
    payload: payloadFrom(row.payload),
    ...(sessionRefFrom(row.session_ref) ? { sessionRef: sessionRefFrom(row.session_ref) } : {}),
    createdAt: iso(row.created_at),
    finalizedAt: iso(row.finalized_at)
  };
}

function episodeFromRow(row: EpisodeRow): WorkspaceCompletionEpisode {
  return {
    workspaceId: row.workspace_id,
    roomId: row.room_id,
    id: row.id,
    goal: row.goal,
    ...(row.source_app ? { sourceApp: row.source_app } : {}),
    ...(row.external_episode_key ? { externalEpisodeKey: row.external_episode_key } : {}),
    outcome: row.outcome,
    startedAt: iso(row.started_at),
    ...(row.ended_at ? { endedAt: iso(row.ended_at) } : {}),
    ...(sessionRefFrom(row.session_ref) ? { sessionRef: sessionRefFrom(row.session_ref) } : {}),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

function evidenceFromRow(row: EvidenceRow): WorkspaceCompletionEvidence {
  return {
    workspaceId: row.workspace_id,
    id: row.id,
    resourceId: row.resource_id,
    resourceVersion: numeric(row.resource_version),
    ...(row.activity_id ? { activityId: row.activity_id } : {}),
    ...(row.episode_id ? { episodeId: row.episode_id } : {}),
    kind: row.kind,
    ...(row.attestation_id ? { attestationId: row.attestation_id } : {}),
    summary: row.summary,
    createdAt: iso(row.created_at)
  };
}

function attestationFromRow(row: AttestationRow): WorkspaceCompletionAttestation {
  return {
    workspaceId: row.workspace_id,
    id: row.id,
    ...(row.activity_id ? { activityId: row.activity_id } : {}),
    ...(row.resource_id ? { resourceId: row.resource_id } : {}),
    ...(row.resource_version !== null ? { resourceVersion: numeric(row.resource_version) } : {}),
    sourceRef: row.source_ref,
    sourceVersion: row.source_version,
    expectedContentHash: row.expected_content_hash,
    ...(row.observed_content_hash ? { observedContentHash: row.observed_content_hash } : {}),
    outcome: row.outcome,
    attestorId: row.attestor_id,
    failureReasons: attestationFailureReasons(row.failure_reasons),
    attestedAt: iso(row.attested_at),
    createdAt: iso(row.created_at)
  };
}

function useFromRow(row: UseRow): WorkspaceCompletionUseEvent {
  return {
    workspaceId: row.workspace_id,
    id: row.id,
    resourceId: row.resource_id,
    resourceVersion: numeric(row.resource_version),
    ...(row.activity_id ? { activityId: row.activity_id } : {}),
    ...(row.episode_id ? { episodeId: row.episode_id } : {}),
    event: row.event,
    ...(row.outcome ? { outcome: row.outcome } : {}),
    ...(row.supersedes_use_id ? { supersedesUseId: row.supersedes_use_id } : {}),
    summary: row.summary,
    createdAt: iso(row.created_at)
  };
}

function evaluationFromRow(row: EvaluationRow): WorkspaceCompletionEvaluation {
  return {
    workspaceId: row.workspace_id,
    id: row.id,
    resourceId: row.resource_id,
    resourceVersion: numeric(row.resource_version),
    episodeId: row.episode_id,
    outcome: row.outcome,
    ...(row.source_activity_id ? { sourceActivityId: row.source_activity_id } : {}),
    ...(row.correction_of_evaluation_id ? { correctionOfEvaluationId: row.correction_of_evaluation_id } : {}),
    createdAt: iso(row.created_at)
  };
}

function jobFromRow(row: JobRow): WorkspaceCompletionJob {
  return {
    workspaceId: row.workspace_id,
    roomId: row.room_id,
    id: row.id,
    kind: row.kind,
    status: row.status,
    idempotencyKey: row.idempotency_key,
    ...(row.group_key ? { groupKey: row.group_key } : {}),
    ...(row.high_watermark ? { highWatermark: row.high_watermark } : {}),
    inputHash: row.input_hash,
    configurationVersion: numeric(row.configuration_version),
    attemptCount: numeric(row.attempt_count),
    maxAttempts: numeric(row.max_attempts),
    ...(row.lease_owner ? { leaseOwner: row.lease_owner } : {}),
    ...(row.lease_expires_at ? { leaseExpiresAt: iso(row.lease_expires_at) } : {}),
    ...(row.heartbeat_at ? { heartbeatAt: iso(row.heartbeat_at) } : {}),
    ...(row.blocked_reason ? { blockedReason: row.blocked_reason } : {}),
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    ...(row.completed_at ? { completedAt: iso(row.completed_at) } : {})
  };
}

function policyRuleFromRow(row: PolicyRuleRow): WorkspaceCompletionPolicyRule {
  return {
    id: row.id,
    operation: row.operation,
    effect: row.effect,
    ...(row.principal_account_id ? { principalAccountId: row.principal_account_id } : {}),
    ...(row.connection_id ? { connectionId: row.connection_id } : {}),
    conditions: payloadFrom(row.conditions) as Record<string, string | number | boolean>
  };
}

function policyChangeRequestFromRow(row: PolicyChangeRequestRow): WorkspaceCompletionPolicyChangeRequest {
  return {
    workspaceId: row.workspace_id,
    roomId: row.room_id,
    id: row.id,
    requestedBy: row.requested_by,
    ...(row.source_job_id ? { sourceJobId: row.source_job_id } : {}),
    summary: row.summary,
    proposedRules: validateWorkspaceCompletionPolicyRules(row.proposed_rules),
    status: row.status,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

function configurationFromRow(row: ConfigurationRow): WorkspaceCompletionConfiguration {
  return {
    workspaceId: row.workspace_id,
    scope: row.scope_kind === "room" ? { kind: "room", roomId: requiredRoomId(row.room_id) } : { kind: "workspace" },
    version: numeric(row.version),
    values: validateWorkspaceCompletionTuning(row.values),
    updatedBy: row.updated_by,
    createdAt: iso(row.created_at)
  };
}

function workspaceDocumentFromRow(row: WorkspaceDocumentRow): WorkspaceDocument {
  return {
    workspaceId: row.workspace_id,
    kind: row.kind,
    filePath: row.file_path,
    contentHash: row.content_hash,
    contentSize: numeric(row.content_size),
    version: numeric(row.version),
    fileBatchId: row.file_batch_id,
    updatedBy: row.updated_by,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

function validateActivityInput(input: WorkspaceCompletionActivityInput): void {
  assertOpaqueId(input.roomId, "room_id_invalid");
  if (input.episodeId) assertCompletionId(input.episodeId, "workspace_completion_episode_id_invalid");
  if (input.externalEpisodeKey) assertCompletionId(input.externalEpisodeKey, "workspace_completion_external_episode_key_invalid");
  if (input.correctionOfActivityId) assertCompletionId(input.correctionOfActivityId, "workspace_completion_activity_id_invalid");
  if (input.operationId) assertCompletionId(input.operationId, "workspace_completion_operation_id_invalid");
  assertSafeText(input.sourceApp, "workspace_completion_activity_source_invalid");
  assertSafeText(input.instructionSummary, "workspace_completion_activity_instruction_invalid");
  if (input.goal) assertSafeText(input.goal, "workspace_completion_episode_goal_invalid");
  if (input.resultSummary) assertSafeText(input.resultSummary, "workspace_completion_activity_result_invalid");
  if (!activityOutcomes.has(input.outcome) || !verificationStates.has(input.verificationOutcome) || !failureStates.has(input.failureState)) {
    throw new WorkspaceServerError("workspace_completion_activity_state_invalid", 422);
  }
  if (input.changedResources && (input.changedResources.length > 100 || input.changedResources.some((id) => typeof id !== "string" || !id))) {
    throw new WorkspaceServerError("workspace_completion_activity_changed_resources_invalid", 422);
  }
  assertPayloadSafe(input.payload ?? {}, "workspace_completion_activity_payload_invalid");
}

function assertReviewApplyInput(input: ApplyWorkspaceCompletionReviewInput): void {
  if (!input || !input.snapshot || !input.result) throw new WorkspaceServerError("workspace_completion_review_input_invalid", 422);
  assertOpaqueId(input.snapshot.workspaceId, "workspace_id_invalid");
  assertOpaqueId(input.snapshot.roomId, "room_id_invalid");
  assertCompletionId(input.snapshot.episodeId, "workspace_completion_episode_id_invalid");
  assertCompletionId(input.snapshot.highWatermarkActivityId, "workspace_completion_activity_id_invalid");
  if (!Number.isSafeInteger(input.snapshot.activityCount) || input.snapshot.activityCount < 1
    || !Number.isSafeInteger(input.snapshot.resourceCount) || input.snapshot.resourceCount < 0
    || !Number.isSafeInteger(input.snapshot.configurationVersion) || input.snapshot.configurationVersion < 1
    || !/^[a-f0-9]{64}$/.test(input.snapshot.digest)
    || input.snapshot.activities.length !== input.snapshot.activityCount
    || input.snapshot.resources.length !== input.snapshot.resourceCount) {
    throw new WorkspaceServerError("workspace_completion_review_snapshot_invalid", 422);
  }
  if (input.jobId || input.attemptId || input.workerId) {
    if (!input.jobId || !input.attemptId || !input.workerId) throw new WorkspaceServerError("workspace_completion_review_attempt_identity_invalid", 422);
    assertCompletionId(input.jobId, "workspace_completion_job_id_invalid");
    assertCompletionId(input.attemptId, "workspace_completion_attempt_id_invalid");
    assertCompletionId(input.workerId, "workspace_completion_worker_id_invalid");
  }
}

function prepareReviewDocuments(
  context: WorkspaceRequestContext,
  snapshot: WorkspaceCompletionReviewSnapshot,
  result: WorkspaceCompletionReviewResult
): PreparedReviewDocument[] {
  const documents: PreparedReviewDocument[] = [];
  for (const [index, candidate] of result.candidates.entries()) {
    if (candidate.kind !== "knowledge" && candidate.kind !== "skill" && candidate.kind !== "conflict") continue;
    const kind = candidate.resourceKind;
    if (kind !== "knowledge" && kind !== "skill") throw new WorkspaceServerError("workspace_completion_review_resource_kind_invalid", 422);
    const existingId = candidate.kind === "conflict" ? undefined : candidate.resourceId;
    const expectedVersion = existingId ? candidate.expectedVersion : 0;
    if (existingId && (!Number.isSafeInteger(expectedVersion) || expectedVersion! < 1)) {
      throw new WorkspaceServerError("workspace_completion_review_expected_version_required", 422);
    }
    const id = existingId ?? completionId("completion_resource", context.workspaceId, `${snapshot.episodeId}:${index}:${candidate.reason}`);
    const resource: WorkspaceCompletionResourceInput & { id: string; expectedVersion: number } = {
      id,
      expectedVersion: expectedVersion ?? 0,
      scope: { kind: "room", roomId: snapshot.roomId },
      kind,
      ...(kind === "knowledge" ? { knowledgeKind: candidate.knowledgeKind } : {}),
      title: candidate.title ?? "",
      content: candidate.content ?? "",
      metadata: candidate.metadata ?? {},
      reason: candidate.reason,
      aiManaged: true,
      evidenceActivityIds: candidate.evidenceActivityIds,
      evidenceEpisodeId: snapshot.episodeId
    };
    validateResourceInput(resource, "ai");
    const version = resource.expectedVersion + 1;
    const path = completionResourcePath({ id: resource.id, kind, scope: resource.scope, version, candidate: true });
    documents.push({
      resource,
      version,
      path,
      content: renderWorkspaceCompletionDocument({ id: resource.id, title: resource.title, resourceKind: kind, metadata: resource.metadata, body: resource.content }),
      ...(candidate.kind === "conflict" ? { conflictTargetId: requiredCandidateResourceId(candidate) } : {})
    });
  }
  if (new Set(documents.map((document) => document.path)).size !== documents.length) throw new WorkspaceServerError("workspace_completion_review_duplicate_path", 422);
  return documents;
}

function requiredCandidateResourceId(candidate: WorkspaceCompletionReviewCandidate): string {
  if (!candidate.resourceId) throw new WorkspaceServerError("workspace_completion_review_resource_id_required", 422);
  assertCompletionId(candidate.resourceId, "workspace_completion_resource_id_invalid");
  return candidate.resourceId;
}

function reviewOperationInput(input: ApplyWorkspaceCompletionReviewInput, result: WorkspaceCompletionReviewResult): WorkspaceRecordPayload {
  return {
    episode_id: input.snapshot.episodeId,
    snapshot_activity_ids: input.snapshot.activities.map((activity) => activity.id),
    reviewer: result.reviewer,
    candidate_count: result.candidates.length,
    ...(input.jobId ? { job_id: input.jobId } : {}),
    ...(input.attemptId ? { attempt_id: input.attemptId } : {})
  };
}

function validateResourceInput(input: WorkspaceCompletionResourceInput, source: WorkspaceCompletionCreationSource): void {
  assertScope(input.scope);
  if (input.id) assertCompletionId(input.id, "workspace_completion_resource_id_invalid");
  if (!completionResourceKinds.has(input.kind)) throw new WorkspaceServerError("workspace_completion_resource_kind_invalid", 400);
  if (input.kind === "knowledge" && (!input.knowledgeKind || !completionKnowledgeKinds.has(input.knowledgeKind))) {
    throw new WorkspaceServerError("workspace_completion_knowledge_kind_required", 422);
  }
  if (input.kind === "skill" && input.knowledgeKind !== undefined) throw new WorkspaceServerError("workspace_completion_skill_knowledge_kind_forbidden", 422);
  const supportFiles = normalizeSkillSupportFiles(input.kind, input.supportFiles);
  if (input.kind === "skill" && source !== "import") validateSkillPackageMetadata(input.metadata);
  if (input.kind !== "skill" && supportFiles.length > 0) throw new WorkspaceServerError("workspace_completion_skill_support_non_skill", 422);
  assertSafeText(input.title, "workspace_completion_resource_title_invalid");
  assertSafeText(input.content, "workspace_completion_resource_content_invalid");
  assertSafeText(input.reason, "workspace_completion_reason_invalid");
  assertPayloadSafe(input.metadata, "workspace_completion_resource_metadata_invalid");
  if (source === "ai") {
    if (!input.evidenceActivityIds || input.evidenceActivityIds.length === 0 || input.evidenceActivityIds.length > 100) {
      throw new WorkspaceServerError("workspace_completion_ai_evidence_required", 422);
    }
    for (const activityId of input.evidenceActivityIds) assertCompletionId(activityId, "workspace_completion_activity_id_invalid");
    if (!input.evidenceEpisodeId) throw new WorkspaceServerError("workspace_completion_ai_evidence_scope_required", 422);
    assertCompletionId(input.evidenceEpisodeId, "workspace_completion_episode_id_invalid");
  }
  assertCompletionResourceAxes({ evidenceState: source === "ai" ? "provisional" : "confirmed", lifecycleState: "active", aiProtection: "editable", creationSource: source });
}

function normalizeSkillSupportFiles(kind: WorkspaceCompletionResourceInput["kind"], value: readonly WorkspaceCompletionSkillSupportInput[] | undefined): WorkspaceCompletionSkillSupportInput[] {
  if (value === undefined) return [];
  if (kind !== "skill") throw new WorkspaceServerError("workspace_completion_skill_support_non_skill", 422);
  if (!Array.isArray(value) || value.length > 99) throw new WorkspaceServerError("workspace_completion_skill_support_files_invalid", 422);
  const normalized = value.map((file) => {
    if (!file || typeof file !== "object" || !(file.content instanceof Uint8Array) || file.content.byteLength > 8 * 1024 * 1024) {
      throw new WorkspaceServerError("workspace_completion_skill_support_files_invalid", 422);
    }
    return { path: assertSkillSupportRelativePath(file.path), content: file.content };
  });
  if (new Set(normalized.map((file) => file.path)).size !== normalized.length) throw new WorkspaceServerError("workspace_completion_skill_support_files_duplicate", 422);
  return normalized;
}

function skillPackageHash(
  kind: WorkspaceCompletionResourceKind,
  mainContentHash: string,
  supportFiles: readonly { relativePath: string; contentHash: string; contentSize: number }[]
): string {
  return hashText(canonicalJson({
    kind,
    main: mainContentHash,
    files: [...supportFiles]
      .map((file) => ({ path: assertSkillSupportRelativePath(file.relativePath), hash: file.contentHash, size: file.contentSize }))
      .sort((left, right) => left.path.localeCompare(right.path))
  }));
}

function validateSkillPackageMetadata(metadata: WorkspaceRecordPayload): void {
  const strings = ["when", "inputs", "preconditions", "completion", "failure"] as const;
  for (const key of strings) {
    if (typeof metadata[key] !== "string" || !metadata[key].trim()) throw new WorkspaceServerError("workspace_completion_skill_metadata_required", 422, { path: `metadata.${key}` });
  }
  if (!Array.isArray(metadata.steps) || metadata.steps.length === 0 || metadata.steps.some((step) => typeof step !== "string" || !step.trim())) {
    throw new WorkspaceServerError("workspace_completion_skill_metadata_required", 422, { path: "metadata.steps" });
  }
  if (!Array.isArray(metadata.knowledge_ids) || metadata.knowledge_ids.some((id) => typeof id !== "string" || !id.trim())) {
    throw new WorkspaceServerError("workspace_completion_skill_metadata_required", 422, { path: "metadata.knowledge_ids" });
  }
}

function validatePolicyInput(input: WorkspaceCompletionPolicyInput): void {
  assertScope(input.scope);
  if (input.id) assertCompletionId(input.id, "workspace_completion_policy_id_invalid");
  assertSafeText(input.title, "workspace_completion_policy_title_invalid");
  assertSafeText(input.content, "workspace_completion_policy_content_invalid");
  assertSafeText(input.reason, "workspace_completion_reason_invalid");
}

function validateAttestationRequest(context: Pick<WorkspaceRequestContext, "workspaceId">, request: WorkspaceCompletionAttestationRequest): void {
  if (!request || request.workspaceId !== context.workspaceId) throw new WorkspaceServerError("workspace_completion_attestation_workspace_invalid", 400);
  assertScope(request.scope);
  const hasActivity = typeof request.target?.activityId === "string";
  const hasResource = typeof request.target?.resourceId === "string" || request.target?.resourceVersion !== undefined;
  if (hasActivity === hasResource) throw new WorkspaceServerError("workspace_completion_attestation_target_invalid", 422);
  if (hasActivity) assertCompletionId(request.target.activityId!, "workspace_completion_activity_id_invalid");
  if (hasResource) {
    assertCompletionId(request.target.resourceId ?? "", "workspace_completion_resource_id_invalid");
    assertExpectedVersion(request.target.resourceVersion ?? 0);
  }
  assertSafeText(request.sourceRef, "workspace_completion_attestation_source_invalid");
  assertSafeText(request.sourceVersion, "workspace_completion_attestation_source_version_invalid");
  if (!/^[a-f0-9]{64}$/.test(request.expectedContentHash)) throw new WorkspaceServerError("workspace_completion_attestation_hash_invalid", 422);
  if (!request.items || typeof request.items !== "object" || Array.isArray(request.items) || Object.keys(request.items).length > 64) {
    throw new WorkspaceServerError("workspace_completion_attestation_items_invalid", 422);
  }
  for (const [key, value] of Object.entries(request.items)) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(key)
      || !(typeof value === "string" || typeof value === "number" || typeof value === "boolean")
      || (typeof value === "number" && !Number.isFinite(value))
      || (typeof value === "string" && (value.length > 4_000 || containsWorkspaceCompletionSecret(value)))) {
      throw new WorkspaceServerError("workspace_completion_attestation_items_invalid", 422);
    }
  }
}

function normalizeAttestationResult(
  request: WorkspaceCompletionAttestationRequest,
  raw: WorkspaceCompletionAttestationResult
): WorkspaceCompletionAttestationResult {
  if (!raw || !["confirmed", "failed", "not_run"].includes(raw.outcome)
    || typeof raw.attestorId !== "string" || !raw.attestorId.trim() || raw.attestorId.length > 256
    || typeof raw.sourceVersion !== "string" || !raw.sourceVersion.trim() || raw.sourceVersion.length > 4_000
    || !Number.isFinite(new Date(raw.attestedAt).getTime())
    || !Array.isArray(raw.failureReasons)) {
    throw new WorkspaceServerError("workspace_completion_attestation_result_invalid", 502);
  }
  const failureReasons = raw.failureReasons.map((reason) => {
    if (!reason || typeof reason.code !== "string" || !reason.code.trim() || reason.code.length > 128
      || typeof reason.message !== "string" || !reason.message.trim() || reason.message.length > 4_000
      || containsWorkspaceCompletionSecret(reason.message)) {
      throw new WorkspaceServerError("workspace_completion_attestation_result_invalid", 502);
    }
    return { code: reason.code.trim(), message: reason.message.trim() };
  });
  const observed = raw.observedContentHash;
  if (observed !== undefined && !/^[a-f0-9]{64}$/.test(observed)) throw new WorkspaceServerError("workspace_completion_attestation_result_invalid", 502);
  const sourceVersionMatches = raw.sourceVersion.trim() === request.sourceVersion;
  if (raw.outcome === "confirmed" && observed === request.expectedContentHash && sourceVersionMatches) {
    return { outcome: "confirmed", attestorId: raw.attestorId.trim(), sourceVersion: raw.sourceVersion.trim(), observedContentHash: observed, attestedAt: new Date(raw.attestedAt).toISOString(), failureReasons };
  }
  if (raw.outcome === "confirmed") {
    return {
      outcome: "failed",
      attestorId: raw.attestorId.trim(),
      sourceVersion: raw.sourceVersion.trim(),
      ...(observed ? { observedContentHash: observed } : {}),
      attestedAt: new Date(raw.attestedAt).toISOString(),
      failureReasons: [
        ...failureReasons,
        ...(observed === request.expectedContentHash ? [] : [{ code: "content_hash_mismatch", message: "The attested content hash does not match the expected hash." }]),
        ...(sourceVersionMatches ? [] : [{ code: "source_version_mismatch", message: "The attested source version does not match the requested source version." }])
      ]
    };
  }
  return {
    outcome: raw.outcome,
    attestorId: raw.attestorId.trim(),
    sourceVersion: raw.sourceVersion.trim(),
    ...(observed ? { observedContentHash: observed } : {}),
    attestedAt: new Date(raw.attestedAt).toISOString(),
    failureReasons
  };
}

function attestationRequestForOperation(request: WorkspaceCompletionAttestationRequest): WorkspaceRecordPayload {
  return {
    scope: request.scope,
    target: request.target,
    source_ref: request.sourceRef,
    source_version: request.sourceVersion,
    expected_content_hash: request.expectedContentHash,
    items: request.items
  };
}

function attestationFailureReasons(value: unknown): Array<{ code: string; message: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    return typeof record.code === "string" && typeof record.message === "string"
      ? [{ code: record.code, message: record.message }]
      : [];
  });
}

function sameScope(left: WorkspaceCompletionScope, right: WorkspaceCompletionScope): boolean {
  return left.kind === right.kind && left.roomId === right.roomId;
}

function activityAttestationHash(activity: WorkspaceCompletionActivity): string {
  return hashText(canonicalJson({
    id: activity.id,
    room_id: activity.roomId,
    operation_id: activity.operationId ?? null,
    instruction_summary: activity.instructionSummary,
    result_summary: activity.resultSummary ?? null,
    outcome: activity.outcome,
    failure_state: activity.failureState,
    finalized_at: activity.finalizedAt
  }));
}

function trustedHumanPolicyApproval(context: WorkspaceRequestContext): TrustedHumanPolicyApproval {
  const caller = context.caller;
  if (!isTrustedWorkspaceCaller(caller) || caller.kind !== "human"
    || caller.principalAccountId !== context.accountId
    || caller.operationId !== context.operationId
    || !/^[a-f0-9]{64}$/.test(caller.canonicalPayloadHash)
    || !caller.signature.trim() || caller.signature.length > 20_000) {
    throw new WorkspaceServerError("workspace_completion_policy_verified_human_required", 403);
  }
  assertOpaqueId(caller.requestId, "request_id_invalid");
  const timestamp = Number(caller.timestamp);
  const requestTimestamp = new Date(timestamp);
  if (!Number.isFinite(timestamp) || !Number.isFinite(requestTimestamp.getTime())) {
    throw new WorkspaceServerError("workspace_completion_policy_verified_human_required", 403);
  }
  return {
    principalAccountId: caller.principalAccountId,
    requestId: caller.requestId,
    operationId: caller.operationId,
    timestamp: caller.timestamp,
    requestTimestamp: requestTimestamp.toISOString(),
    canonicalPayloadHash: caller.canonicalPayloadHash,
    signature: caller.signature
  };
}

function isProvisionalImport(input: WorkspaceCompletionResourceInput, source: WorkspaceCompletionCreationSource): boolean {
  return source === "import" && input.metadata.migration_provisional === true;
}

function assertScope(scope: WorkspaceCompletionScope): void {
  if (scope.kind !== "workspace" && scope.kind !== "room") throw new WorkspaceServerError("workspace_completion_scope_invalid", 422);
  if ((scope.kind === "room") !== Boolean(scope.roomId)) throw new WorkspaceServerError("workspace_completion_scope_invalid", 422);
  if (scope.roomId) assertOpaqueId(scope.roomId, "room_id_invalid");
}

function scopeRoom(scope: WorkspaceCompletionScope): string | undefined {
  return scope.kind === "room" ? scope.roomId : undefined;
}

function authorityForScope(scope: WorkspaceCompletionScope): "edit" | "admin" {
  return scope.kind === "room" ? "edit" : "admin";
}

function episodeRelationFor(input: WorkspaceCompletionActivityInput): "external_episode" | "goal_operation" | "correction" | "single_activity" {
  if (input.externalEpisodeKey) return "external_episode";
  if (input.correctionOfActivityId) return "correction";
  if (input.episodeId || input.operationId) return "goal_operation";
  return "single_activity";
}

function isEvaluationActivity(activity: Pick<WorkspaceCompletionActivity, "outcome">): boolean {
  // Cancellation has no completed result to evaluate. `unknown` remains an
  // explicit outcome so it can never be silently upgraded to success later.
  return activity.outcome !== "cancelled";
}

function reviewSnapshotDigest(snapshot: Omit<WorkspaceCompletionReviewSnapshot, "digest">): string {
  return hashText(canonicalJson({
    workspace_id: snapshot.workspaceId,
    room_id: snapshot.roomId,
    episode_id: snapshot.episodeId,
    high_watermark_activity_id: snapshot.highWatermarkActivityId,
    activity_count: snapshot.activityCount,
    resource_count: snapshot.resourceCount,
    configuration_version: snapshot.configurationVersion,
    activities: snapshot.activities.map((activity) => ({
      id: activity.id,
      finalized_at: activity.finalizedAt,
      outcome: activity.outcome,
      verification: activity.verificationOutcome,
      failure: activity.failureState,
      payload: activity.payload
    })),
    resources: snapshot.resources.map((resource) => ({
      id: resource.id,
      version: resource.version,
      content_hash: resource.contentHash,
      kind: resource.kind,
      fixed: resource.fixed,
      lifecycle: resource.lifecycleState,
      evidence: resource.evidenceState
    }))
  }));
}

function evaluationOutcomeForActivity(
  activity: Pick<WorkspaceCompletionActivity, "outcome" | "verificationOutcome" | "failureState">,
  hasConfirmedAttestation: boolean
): WorkspaceCompletionEvaluation["outcome"] {
  if (activity.outcome === "failed" || activity.verificationOutcome === "failed" || activity.failureState === "unresolved") {
    return "confirmed_failure";
  }
  if (activity.outcome === "completed" && hasConfirmedAttestation) {
    return "confirmed_success";
  }
  return "unknown";
}

function evaluationJobHash(
  episode: Pick<WorkspaceCompletionEpisode, "id" | "roomId">,
  activity: Pick<WorkspaceCompletionActivity, "id" | "finalizedAt" | "outcome" | "verificationOutcome" | "failureState" | "correctionOfActivityId">,
  uses: readonly UseRow[],
  hasConfirmedAttestation: boolean
): string {
  return hashText(canonicalJson({
    episode_id: episode.id,
    room_id: episode.roomId,
    activity: {
      id: activity.id,
      finalized_at: activity.finalizedAt,
      outcome: activity.outcome,
      verification: activity.verificationOutcome,
      failure: activity.failureState,
      confirmed_attestation: hasConfirmedAttestation,
      correction_of: activity.correctionOfActivityId ?? null
    },
    uses: uses.map((use) => ({
      id: use.id,
      resource_id: use.resource_id,
      resource_version: numeric(use.resource_version),
      event: use.event,
      outcome: use.outcome,
      created_at: iso(use.created_at)
    }))
  }));
}

function assertSafeText(value: string, code: string): void {
  if (typeof value !== "string" || !value.trim() || value.length > 200_000 || containsWorkspaceCompletionSecret(value)) {
    throw new WorkspaceServerError(code, containsWorkspaceCompletionSecret(String(value)) ? 400 : 422);
  }
}

function assertPayloadSafe(value: unknown, code: string): asserts value is WorkspaceRecordPayload {
  if (!value || typeof value !== "object" || Array.isArray(value) || JSON.stringify(value).length > 200_000 || containsSecretDeep(value)) {
    throw new WorkspaceServerError(code, containsSecretDeep(value) ? 400 : 422);
  }
}

function containsSecretDeep(value: unknown): boolean {
  if (typeof value === "string") return containsWorkspaceCompletionSecret(value);
  if (Array.isArray(value)) return value.some(containsSecretDeep);
  if (value && typeof value === "object") return Object.entries(value as Record<string, unknown>).some(([key, child]) => containsWorkspaceCompletionSecret(key) || containsSecretDeep(child));
  return false;
}

function assertExpectedVersion(value: number, allowZero = false): void {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) throw new WorkspaceServerError("workspace_completion_resource_version_invalid", 400);
}

function assertCompletionId(value: string, code: string): void {
  if (typeof value !== "string" || !/^[a-z][a-z0-9_:-]{0,127}$/.test(value)) throw new WorkspaceServerError(code, 400);
}

function throwVersionConflict(latestVersion: number | null): never {
  throw new WorkspaceServerError("workspace_completion_resource_version_conflict", 409, { latest_version: latestVersion });
}

function completionId(prefix: string, workspaceId: string, input: string): string {
  return `${prefix}_${hashText(`${workspaceId}:${input}`).slice(0, 40)}`;
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hashBytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function searchableText(title: string, metadata: WorkspaceRecordPayload, content: Uint8Array): string {
  return `${title}\n${JSON.stringify(metadata)}\n${Buffer.from(content).toString("utf8")}`.slice(0, 500_000);
}

function boundedLimit(value: number | undefined): number {
  if (value === undefined) return 50;
  if (!Number.isSafeInteger(value) || value < 1 || value > maxPage) throw new WorkspaceServerError("workspace_completion_page_limit_invalid", 400);
  return value;
}

function encodeCompletionCursor(id: string): string {
  return Buffer.from(JSON.stringify({ id }), "utf8").toString("base64url");
}

function decodeCompletionCursor(cursor: string | undefined): string | undefined {
  if (cursor === undefined) return undefined;
  try {
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { id?: unknown };
    if (typeof decoded.id !== "string" || decoded.id.length === 0 || decoded.id.length > 256) throw new Error("invalid cursor");
    return decoded.id;
  } catch {
    throw new WorkspaceServerError("workspace_completion_page_cursor_invalid", 400);
  }
}

interface WorkspaceCompletionSearchCursor {
  id: string;
  rank: number;
  bucket: number;
}

function encodeSearchCursor(cursor: WorkspaceCompletionSearchCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeSearchCursor(cursor: string | undefined): WorkspaceCompletionSearchCursor | undefined {
  if (cursor === undefined) return undefined;
  try {
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Partial<WorkspaceCompletionSearchCursor>;
    if (typeof decoded.id !== "string" || decoded.id.length === 0 || decoded.id.length > 256
      || typeof decoded.rank !== "number" || !Number.isFinite(decoded.rank)
      || (decoded.bucket !== 0 && decoded.bucket !== 1)) {
      throw new Error("invalid cursor");
    }
    return { id: decoded.id, rank: decoded.rank, bucket: decoded.bucket };
  } catch {
    throw new WorkspaceServerError("workspace_completion_page_cursor_invalid", 400);
  }
}

function numeric(value: number | string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new WorkspaceServerError("workspace_completion_database_value_invalid", 500);
  return number;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function payloadFrom(value: unknown): WorkspaceRecordPayload {
  return value && typeof value === "object" && !Array.isArray(value) ? value as WorkspaceRecordPayload : {};
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function sessionRefFrom(value: unknown): WorkspaceCompletionActivity["sessionRef"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.appId !== "string" || !candidate.appId) return undefined;
  return {
    appId: candidate.appId,
    ...(typeof candidate.sessionId === "string" ? { sessionId: candidate.sessionId } : {}),
    ...(typeof candidate.turnId === "string" ? { turnId: candidate.turnId } : {}),
    ...(typeof candidate.messageId === "string" ? { messageId: candidate.messageId } : {}),
    ...(typeof candidate.resumeUrl === "string" ? { resumeUrl: candidate.resumeUrl } : {})
  };
}

function requiredRoomId(value: string | null): string {
  if (!value) throw new WorkspaceServerError("workspace_completion_database_value_invalid", 500);
  return value;
}

function defaultTuning(): WorkspaceCompletionTuning {
  return {
    reviewMaxAttempts: 3,
    reviewSnapshotMaxItems: 10_000,
    experienceRuleEpisodeSuccesses: 3,
    skillEpisodeSuccesses: 3,
    curatorLightIntervalHours: 24,
    curatorSemanticIntervalDays: 7,
    curatorMinimumIdleHours: 2,
    curatorSnapshotMaxItems: 1_000,
    curatorSnapshotLimit: 20,
    skillStaleAfterDays: 30,
    skillArchiveAfterDays: 90,
    provisionalKnowledgeArchiveAfterDays: 90,
    rawJobOutputRetentionDays: 90,
    verificationLoadRooms: 100,
    verificationLoadActivities: 100_000,
    verificationLoadKnowledge: 10_000,
    verificationLoadSkills: 1_000
  };
}

function optionalWorkspaceDocument(error: unknown): string | undefined {
  if (error instanceof WorkspaceServerError && error.code === "workspace_completion_workspace_document_not_found") return undefined;
  throw error;
}
