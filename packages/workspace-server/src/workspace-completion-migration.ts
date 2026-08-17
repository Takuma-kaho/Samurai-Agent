import { createHash } from "node:crypto";
import { canonicalJson, isTrustedWorkspaceCaller } from "./auth";
import { assertOpaqueId } from "./config";
import { WorkspaceServerError } from "./errors";
import type { WorkspaceSql } from "./postgres";
import { containsWorkspaceCompletionSecret } from "./workspace-completion-policy";
import { WorkspaceCompletionService } from "./workspace-completion-service";
import type { WorkspaceCompletionKnowledgeKind, WorkspaceCompletionScope } from "./workspace-completion-types";
import type { WorkspaceRecordPayload, WorkspaceRequestContext } from "./types";

export interface WorkspaceCompletionLegacyMigrationPreview {
  integrityHash: string;
  activities: number;
  resources: number;
  versions: number;
  evidence: number;
  links: number;
  uses: number;
  jobs: number;
  attempts: number;
  byKind: Record<LegacyResourceKind, number>;
  profileCandidates: number;
  policyCandidates: number;
  blockedSecretResources: readonly string[];
}

export interface WorkspaceCompletionLegacyMigrationResult extends WorkspaceCompletionLegacyMigrationPreview {
  replayed: boolean;
  migratedActivities: number;
  migratedResources: number;
  migratedVersions: number;
  migratedPolicies: number;
  migratedPolicyRequests: number;
  migratedEvidence: number;
  migratedLinks: number;
  migratedUses: number;
  migratedJobs: number;
  migratedAttempts: number;
  /** Hash of the source-to-file-body verification performed immediately
   * before this migration is marked switched. */
  verificationHash?: string;
  receiptId?: string;
}

type LegacyResourceKind = "knowledge" | "memory" | "skill" | "workspace_rule";

/** Converts only the old PostgreSQL learning projection. SQLite remains a
 * read-only Bundle input. The source rows are never deleted here, which makes
 * a failed or interrupted backfill resumable without a dual-write period. */
export class WorkspaceCompletionMigrationService {
  constructor(readonly completion: WorkspaceCompletionService) {}

  async previewLegacy(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">): Promise<WorkspaceCompletionLegacyMigrationPreview> {
    await this.assertOwner(context);
    const snapshot = await this.readLegacySnapshot(context);
    return previewFromSnapshot(snapshot);
  }

  async migrateLegacy(context: WorkspaceRequestContext, input: { dryRun?: boolean } = {}): Promise<WorkspaceCompletionLegacyMigrationResult> {
    await this.assertOwner(context);
    if (input.dryRun) return emptyMigrationResult(previewFromSnapshot(await this.readLegacySnapshot(context)));
    this.assertAuthenticatedHuman(context);
    // The SECURITY DEFINER start function creates the Run and changes the
    // Workspace to read-only in one transaction.  Nothing is snapshotted
    // until that succeeds, so a normal write cannot slip between the source
    // read and the backfill.
    const runId = legacyId("completion_migration_run", context.workspaceId, context.operationId);
    const started = await this.beginRun(context, runId);
    if (started === "switched" || started === "rolled_back") {
      const snapshot = await this.readLegacySnapshot(context);
      const preview = previewFromSnapshot(snapshot);
      return { ...emptyMigrationResult(preview), replayed: true, receiptId: receiptId(context.workspaceId, preview.integrityHash, started) };
    }
    const runContext: WorkspaceRequestContext = { ...context, migrationRunId: runId, migrationOperation: "completion_backfill" };
    const snapshot = await this.readLegacySnapshot(runContext);
    const preview = previewFromSnapshot(snapshot);
    // A retry may only continue the exact source snapshot recorded by the
    // first Run.  Read-only normally makes this equal, but this also catches
    // an accidental privileged/bypass write before a stale run can switch.
    const run = await this.readRun(runContext);
    if (started === "rolling_back") {
      const rollbackContext: WorkspaceRequestContext = { ...runContext, migrationOperation: "completion_rollback" };
      const rollback = await this.rollbackFailedMigration(rollbackContext, run.sourceIntegrityHash ?? preview.integrityHash);
      const receipt = await this.recordReceipt(rollbackContext, preview, "rolled_back", {
        migration_run_id: runId,
        resumed_from: "rolling_back",
        removed_resources: rollback.removedResources,
        removed_activities: rollback.removedActivities,
        removed_jobs: rollback.removedJobs,
        removed_files: rollback.removedFiles,
        preserved_files: rollback.preservedFiles
      });
      await this.transitionRun(rollbackContext, "rolled_back", preview);
      return { ...emptyMigrationResult(preview), replayed: true, receiptId: receipt };
    }
    try {
      if (run.sourceIntegrityHash && run.sourceIntegrityHash !== preview.integrityHash) {
        throw new WorkspaceServerError("workspace_completion_migration_source_changed", 409, {
          expected_integrity_hash: run.sourceIntegrityHash,
          actual_integrity_hash: preview.integrityHash
        });
      }
      if (started !== "verified") await this.transitionRun(runContext, "backfilling", preview);
      await this.recordReceipt(runContext, preview, "prepared", { migration_run_id: runId, blocked_secret_resources: preview.blockedSecretResources });
      const migratedActivities = await this.migrateActivities(runContext, snapshot.activities);
      const migratedJobs = await this.migrateJobs(runContext, snapshot);
      const migratedLegacyJobIds = legacyMigratableJobIds(snapshot);
      let migratedResources = 0;
      let migratedVersions = 0;
      let migratedPolicies = 0;
      let migratedPolicyRequests = 0;
      for (const resource of snapshot.resources) {
        const history = versionsFor(snapshot, resource.id);
        if (hasSecretResource(snapshot, resource)) continue;
        if (resource.resource_kind === "workspace_rule") {
          const result = await this.migrateWorkspaceRule(runContext, resource, history, migratedLegacyJobIds);
          migratedPolicies += result.policies;
          migratedPolicyRequests += result.policyRequests;
          continue;
        }
        const counts = await this.migrateResource(runContext, resource, history);
        migratedResources += counts.resources;
        migratedVersions += counts.versions;
      }
      const references = await this.migrateReferences(runContext, snapshot);
      // A second source read happens while the Workspace is still read-only.
      // If an implementation bug or bypass changed the legacy source, the
      // switch is refused rather than certifying a mixed snapshot.
      const sourceBeforeSwitch = previewFromSnapshot(await this.readLegacySnapshot(runContext));
      if (sourceBeforeSwitch.integrityHash !== preview.integrityHash) {
        throw new WorkspaceServerError("workspace_completion_migration_source_changed", 409, {
          expected_integrity_hash: preview.integrityHash,
          actual_integrity_hash: sourceBeforeSwitch.integrityHash
        });
      }
      const verification = await this.verifyBackfill(runContext, snapshot);
      if (started !== "verified") await this.transitionRun(runContext, "verified", preview, verification.contentHash);
      await this.recordReceipt(runContext, preview, "verified", {
        migration_run_id: runId,
        verification_hash: verification.contentHash,
        verification_counts: verification.counts
      });
      // The receipt is durable before the terminal state. A process loss in
      // between is safe: retry verifies the same source/destination and then
      // completes this transition instead of creating a second migration.
      const id = await this.recordReceipt(runContext, preview, "switched", {
        migration_run_id: runId,
        migrated_activities: migratedActivities,
        migrated_resources: migratedResources,
        migrated_versions: migratedVersions,
        migrated_policies: migratedPolicies,
        migrated_policy_requests: migratedPolicyRequests,
        migrated_evidence: references.evidence,
        migrated_links: references.links,
        migrated_uses: references.uses,
        migrated_jobs: migratedJobs.jobs,
        migrated_attempts: migratedJobs.attempts,
        blocked_secret_resources: preview.blockedSecretResources,
        verification_hash: verification.contentHash,
        verification_counts: verification.counts
      });
      await this.transitionRun(runContext, "switched", preview, verification.contentHash);
      return {
        ...preview,
        replayed: false,
        migratedActivities,
        migratedResources,
        migratedVersions,
        migratedPolicies,
        migratedPolicyRequests,
        migratedEvidence: references.evidence,
        migratedLinks: references.links,
        migratedUses: references.uses,
        migratedJobs: migratedJobs.jobs,
        migratedAttempts: migratedJobs.attempts,
        verificationHash: verification.contentHash,
        receiptId: id
      };
    } catch (error) {
      let rollback: MigrationRollbackResult | undefined;
      let rollbackErrorCode: string | undefined;
      try {
        await this.transitionRun(runContext, "rolling_back", preview);
        const rollbackContext: WorkspaceRequestContext = { ...runContext, migrationOperation: "completion_rollback" };
        rollback = await this.rollbackFailedMigration(rollbackContext, preview.integrityHash);
        // The Run is now rolling_back, so the narrow DB capability allows
        // only the rollback Context to write its receipt and terminal state.
        await this.recordReceipt(rollbackContext, preview, "rolled_back", {
          migration_run_id: runId,
          removed_resources: rollback.removedResources,
          removed_activities: rollback.removedActivities,
          removed_jobs: rollback.removedJobs,
          removed_files: rollback.removedFiles,
          preserved_files: rollback.preservedFiles
        });
        await this.transitionRun(rollbackContext, "rolled_back", preview);
      } catch (rollbackError) {
        rollbackErrorCode = errorCode(rollbackError);
        // The failure receipt must be written while the dedicated Run still
        // holds the only write exception.  Terminal transition restores the
        // Workspace to active and deliberately closes that exception.
        const failedRollbackContext: WorkspaceRequestContext = { ...runContext, migrationOperation: "completion_rollback" };
        await this.recordReceipt(failedRollbackContext, preview, "failed", {
          migration_run_id: runId,
          error_code: errorCode(error),
          rollback_status: "failed",
          rollback_error_code: rollbackErrorCode
        }).catch(() => undefined);
        await this.transitionRun(failedRollbackContext, "failed", preview, undefined, rollbackErrorCode).catch(() => undefined);
      }
      throw error;
    }
  }

  private async migrateActivities(context: WorkspaceRequestContext, activities: readonly LegacyActivityRow[]): Promise<number> {
    if (activities.length === 0) return 0;
    const migratableIds = new Set(activities
      .filter((activity) => !hasSecretActivity(activity))
      .map((activity) => activity.id));
    const operationContext = withOperation(context, "activities");
    const saved = await this.completion.store.runIdempotentResult(operationContext, {
      action: "workspace.completion.migration.activities",
      input: { source_count: activities.length }
    }, async (sql) => {
      let count = 0;
      for (const activity of activities) {
        if (hasSecretActivity(activity)) continue;
        await this.completion.assertOperationAllowed(sql, operationContext, activity.room_id, "file.import", "execute", { migration: true });
        const episodeId = legacyId("completion_legacy_episode", operationContext.workspaceId, `${activity.room_id}:${activity.group_key}`);
        await sql.query(
          `INSERT INTO workspace_completion_episodes(workspace_id, room_id, id, goal, source_app, external_episode_key, created_by, updated_by, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8::TIMESTAMPTZ, $9::TIMESTAMPTZ)
           ON CONFLICT (workspace_id, room_id, external_episode_key) DO NOTHING`,
          [operationContext.workspaceId, activity.room_id, episodeId, activity.instruction_summary, `legacy:${activity.source_kind}`, activity.group_key, activity.principal_account_id, iso(activity.created_at), iso(activity.finalized_at)]
        );
        const activityId = legacyId("completion_legacy_activity", operationContext.workspaceId, activity.id);
        const inserted = await sql.query<{ id: string }>(
          `INSERT INTO workspace_completion_activities(
             workspace_id, room_id, id, principal_account_id, source_app, source_id, external_episode_key,
             correction_of_activity_id, instruction_summary, result_summary, changed_resources, verification_outcome, failure_state,
             outcome, explicit_remember, payload, created_at, finalized_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, '[]'::JSONB, $11, $12, $13, $14, $15::JSONB, $16::TIMESTAMPTZ, $17::TIMESTAMPTZ)
           ON CONFLICT (workspace_id, id) DO NOTHING RETURNING id`,
          [
            operationContext.workspaceId, activity.room_id, activityId, activity.principal_account_id, `legacy:${activity.source_kind}`, activity.source_id ?? activity.id, activity.group_key,
            activity.correction_of_activity_id && migratableIds.has(activity.correction_of_activity_id)
              ? targetActivityId(operationContext.workspaceId, activity.correction_of_activity_id)
              : null,
            activity.instruction_summary, activity.result_summary, activity.verification_state, activity.failure_state,
            legacyOutcome(activity.outcome), activity.explicit_remember,
            canonicalJson({ legacy_source: { activity_id: activity.id, group_key: activity.group_key, source_kind: activity.source_kind }, payload: payload(activity.payload) }),
            iso(activity.created_at), iso(activity.finalized_at)
          ]
        );
        await sql.query(
          `INSERT INTO workspace_completion_episode_activities(workspace_id, episode_id, activity_id, relation)
           VALUES ($1, $2, $3, 'legacy_group') ON CONFLICT DO NOTHING`,
          [operationContext.workspaceId, episodeId, activityId]
        );
        count += inserted.rows.length;
      }
      return count;
    });
    return saved.value;
  }

  private async migrateResource(context: WorkspaceRequestContext, resource: LegacyResourceRow, history: readonly LegacyVersionRow[]): Promise<{ resources: number; versions: number }> {
    const targetId = targetResourceId(context.workspaceId, resource.id);
    const sourceVersions = history.length > 0 ? history : [currentAsVersion(resource)];
    const existing = await this.completion.getResource({ workspaceId: context.workspaceId, accountId: context.accountId }, targetId).catch((error) => {
      if (error instanceof WorkspaceServerError && error.code === "workspace_completion_resource_not_found") return undefined;
      throw error;
    });
    if (existing && existing.resource.creationSource !== "import") throw new WorkspaceServerError("workspace_completion_migration_target_collision", 409, { resource_id: targetId });
    let version = existing?.resource.version ?? 0;
    let migratedVersions = 0;
    for (const source of sourceVersions.slice(version)) {
      const resourceKind = resource.resource_kind === "skill" ? "skill" : "knowledge";
      const metadata = migrationMetadata(resource, source, resourceKind);
      const operation = withOperation(context, `${resource.id}:${source.version}`);
      await this.completion.importLegacyResource(operation, {
        id: targetId,
        scope: scopeFromLegacy(resource),
        kind: resourceKind,
        ...(resourceKind === "knowledge" ? { knowledgeKind: knowledgeKind(source.payload) } : {}),
        title: source.title,
        content: source.content,
        metadata,
        reason: `旧${resource.resource_kind}の版${source.version}をファイル正本へ移行`,
        expectedVersion: version
      });
      version += 1;
      migratedVersions += 1;
    }
    if (resource.state === "archived") {
      await this.completion.setResourceArchived(withOperation(context, `${resource.id}:archive`), {
        resourceId: targetId, archived: true, expectedVersion: version, reason: "旧形式でarchiveされていたため移行時に保持"
      });
    }
    if (resource.ai_update_locked) {
      await this.completion.setResourceFixed(withOperation(context, `${resource.id}:fixed`), {
        resourceId: targetId, fixed: true, expectedVersion: version, reason: "旧形式でfixedだったため移行時に保持"
      });
    }
    return { resources: existing ? 0 : 1, versions: migratedVersions };
  }

  private async migrateWorkspaceRule(
    context: WorkspaceRequestContext,
    resource: LegacyResourceRow,
    history: readonly LegacyVersionRow[],
    migratedLegacyJobIds: ReadonlySet<string>
  ): Promise<{ policies: number; policyRequests: number }> {
    const sourceVersions = history.length > 0 ? history : [currentAsVersion(resource)];
    // Legacy arbitrary strings are not a verified Human approval.  Preserve
    // their proposal as a request, but never let a migration fabricate an
    // active Policy or a signature that could authorize one.
    let policyRequests = 0;
    const roomId = await this.defaultMigrationRoom(context);
    for (const source of sourceVersions) {
      const sourceJobId = source.source_job_id ?? resource.source_job_id;
      const request = await this.completion.requestPolicyChange(withOperation(context, `${resource.id}:policy-request:${source.version}`), {
        id: legacyId("completion_legacy_policy_request", context.workspaceId, `${resource.id}:${source.version}`),
        roomId,
        summary: legacyPolicyRequestSummary(resource, source),
        proposedRules: [],
        ...(sourceJobId && migratedLegacyJobIds.has(sourceJobId) ? { sourceJobId: targetJobId(context.workspaceId, sourceJobId) } : {})
      });
      if (!request.replayed) policyRequests += 1;
    }
    return { policies: 0, policyRequests };
  }

  /** Job history is operational evidence, not a request to re-run old work.
   * Interrupted legacy jobs are therefore restored as queued only after their
   * old Attempt is recorded as failed; a live lease is never copied. */
  private async migrateJobs(context: WorkspaceRequestContext, snapshot: LegacySnapshot): Promise<{ jobs: number; attempts: number }> {
    if (snapshot.jobs.length === 0) return { jobs: 0, attempts: 0 };
    const allowedActivities = new Set(snapshot.activities.filter((activity) => !hasSecretActivity(activity)).map((activity) => activity.id));
    const result = await this.completion.store.runIdempotentResult(withOperation(context, "jobs"), {
      action: "workspace.completion.migration.jobs",
      input: { source_jobs: snapshot.jobs.length, source_attempts: snapshot.attempts.length }
    }, async (sql) => {
      let jobs = 0;
      let attempts = 0;
      const migratedJobIds = new Set<string>();
      for (const job of snapshot.jobs) {
        if (!allowedActivities.has(job.high_watermark_activity_id)) continue;
        await this.completion.assertOperationAllowed(sql, context, job.room_id, "file.import", "execute", { migration: true });
        const targetId = targetJobId(context.workspaceId, job.id);
        const inserted = await sql.query<{ id: string }>(
          `INSERT INTO workspace_completion_jobs(
             workspace_id, room_id, id, kind, status, idempotency_key, group_key, high_watermark, input_hash,
             configuration_version, attempt_count, max_attempts, blocked_reason, created_by, updated_by,
             created_at, updated_at, completed_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1, $10, $11, $12, $13, $14, $15::TIMESTAMPTZ, $16::TIMESTAMPTZ, $17::TIMESTAMPTZ)
           ON CONFLICT (workspace_id, id) DO NOTHING RETURNING id`,
          [
            context.workspaceId, job.room_id, targetId, job.kind, restoredLegacyJobStatus(job), `legacy_learning:${job.id}`,
            legacyEpisodeId(context.workspaceId, job.room_id, job.group_key), targetActivityId(context.workspaceId, job.high_watermark_activity_id),
            hashOrFingerprint(job.id), Number(job.attempt_count), Number(job.max_attempts), legacyBlockedReason(job),
            job.created_by, job.updated_by, iso(job.created_at), iso(job.updated_at), job.completed_at ? iso(job.completed_at) : null
          ]
        );
        if (inserted.rows[0]) jobs += 1;
        migratedJobIds.add(job.id);
      }
      for (const attempt of snapshot.attempts) {
        if (!migratedJobIds.has(attempt.job_id)) continue;
        const targetJob = targetJobId(context.workspaceId, attempt.job_id);
        const inserted = await sql.query<{ id: string }>(
          `INSERT INTO workspace_completion_job_attempts(
             workspace_id, id, job_id, attempt_no, worker_id, status, input_hash, output_hash, error_code,
             configuration_version, started_at, completed_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1, $10::TIMESTAMPTZ, $11::TIMESTAMPTZ)
           ON CONFLICT (workspace_id, id) DO NOTHING RETURNING id`,
          [
            context.workspaceId, targetAttemptId(context.workspaceId, attempt.id), targetJob, Number(attempt.attempt_no), attempt.worker_id,
            restoredLegacyAttemptStatus(attempt.status), hashOrFingerprint(attempt.input_hash), attempt.output_hash ? hashOrFingerprint(attempt.output_hash) : null,
            attempt.status === "running" ? "legacy_interrupted" : attempt.error_code,
            iso(attempt.started_at), attempt.completed_at ? iso(attempt.completed_at) : iso(attempt.started_at)
          ]
        );
        if (inserted.rows[0]) attempts += 1;
      }
      return { jobs, attempts };
    });
    return result.value;
  }

  /** Evidence, Links, and Use outcomes are copied only after the target
   * Resource/Version rows exist. A missing or secret source is skipped rather
   * than inventing a replacement reference. */
  private async migrateReferences(context: WorkspaceRequestContext, snapshot: LegacySnapshot): Promise<{ evidence: number; links: number; uses: number }> {
    const allowedActivities = new Map(snapshot.activities
      .filter((activity) => !hasSecretActivity(activity))
      .map((activity) => [activity.id, activity]));
    const migratable = new Map(snapshot.resources
      .filter((resource) => isMigratableResource(snapshot, resource))
      .map((resource) => [resource.id, resource]));
    const result = await this.completion.store.runIdempotentResult(withOperation(context, "references"), {
      action: "workspace.completion.migration.references",
      input: { source_evidence: snapshot.evidence.length, source_links: snapshot.links.length, source_uses: snapshot.uses.length }
    }, async (sql) => {
      let evidence = 0;
      let links = 0;
      let uses = 0;
      for (const source of snapshot.evidence) {
        const resource = migratable.get(source.resource_id);
        const targetVersion = resource ? targetVersionForLegacy(snapshot, resource, Number(source.resource_version)) : undefined;
        if (!resource || targetVersion === undefined || containsSecret(source.summary)) continue;
        const activity = source.activity_id ? allowedActivities.get(source.activity_id) : undefined;
        const kind = legacyEvidenceKind(source.kind);
        if (kind !== "human_edit" && !activity) continue;
        const inserted = await sql.query<{ id: string }>(
          `INSERT INTO workspace_completion_evidence(
             workspace_id, id, resource_id, resource_version, activity_id, episode_id, kind, summary, created_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::TIMESTAMPTZ)
           ON CONFLICT (workspace_id, id) DO NOTHING RETURNING id`,
          [
            context.workspaceId, targetEvidenceId(context.workspaceId, source.id), targetResourceId(context.workspaceId, resource.id), targetVersion,
            kind === "human_edit" ? null : targetActivityId(context.workspaceId, source.activity_id!),
            kind === "human_edit" || !activity ? null : legacyEpisodeId(context.workspaceId, activity.room_id, activity.group_key),
            kind, source.summary, iso(source.created_at)
          ]
        );
        if (inserted.rows[0]) evidence += 1;
      }
      for (const source of snapshot.links) {
        const from = migratable.get(source.from_resource_id);
        const to = migratable.get(source.to_resource_id);
        if (!from || !to || from.id === to.id) continue;
        const inserted = await sql.query<{ id: string }>(
          `INSERT INTO workspace_completion_resource_links(workspace_id, id, from_resource_id, to_resource_id, relation, created_at)
           VALUES ($1, $2, $3, $4, $5, $6::TIMESTAMPTZ)
           ON CONFLICT (workspace_id, from_resource_id, to_resource_id, relation) DO NOTHING RETURNING id`,
          [
            context.workspaceId, targetLinkId(context.workspaceId, source.id), targetResourceId(context.workspaceId, from.id),
            targetResourceId(context.workspaceId, to.id), legacyLinkRelation(source.relation), iso(source.created_at)
          ]
        );
        if (inserted.rows[0]) links += 1;
      }
      const migratedUseIds = new Set<string>();
      for (const source of snapshot.uses) {
        const resource = migratable.get(source.resource_id);
        const targetVersion = resource ? targetVersionForLegacy(snapshot, resource, Number(source.resource_version)) : undefined;
        const activity = allowedActivities.get(source.activity_id);
        if (!resource || targetVersion === undefined || !activity || containsSecret(source.summary)) continue;
        const sourceParent = source.supersedes_use_id;
        const parent = sourceParent && migratedUseIds.has(sourceParent) ? targetUseId(context.workspaceId, sourceParent) : null;
        const inserted = await sql.query<{ id: string }>(
          `INSERT INTO workspace_completion_uses(
             workspace_id, id, resource_id, resource_version, activity_id, episode_id, event, outcome, supersedes_use_id, summary, created_at
           ) VALUES ($1, $2, $3, $4, $5, $6, 'outcome', $7, $8, $9, $10::TIMESTAMPTZ)
           ON CONFLICT (workspace_id, id) DO NOTHING RETURNING id`,
          [
            context.workspaceId, targetUseId(context.workspaceId, source.id), targetResourceId(context.workspaceId, resource.id), targetVersion,
            targetActivityId(context.workspaceId, source.activity_id), legacyEpisodeId(context.workspaceId, activity.room_id, activity.group_key),
            source.outcome, parent, source.summary, iso(source.created_at)
          ]
        );
        migratedUseIds.add(source.id);
        if (inserted.rows[0]) uses += 1;
      }
      return { evidence, links, uses };
    });
    return result.value;
  }

  /** Verifies the actual file-backed destination before the receipt changes to
   * switched.  Count checks catch broken references; body reads also verify
   * every DB content hash against its physical file. */
  private async verifyBackfill(context: WorkspaceRequestContext, snapshot: LegacySnapshot): Promise<MigrationVerification> {
    const targets = expectedMigrationTargets(snapshot, context.workspaceId);
    const counts = await this.completion.store.database.withContext(context, async (sql) => {
      const values = await Promise.all([
        countRowsById(sql, context.workspaceId, "workspace_completion_activities", targets.activityIds),
        countRowsById(sql, context.workspaceId, "workspace_completion_resources", targets.resourceIds),
        countRowsByResourceId(sql, context.workspaceId, "workspace_completion_resource_versions", targets.resourceIds),
        countRowsById(sql, context.workspaceId, "workspace_completion_evidence", targets.evidenceIds),
        countRowsById(sql, context.workspaceId, "workspace_completion_resource_links", targets.linkIds),
        countRowsById(sql, context.workspaceId, "workspace_completion_uses", targets.useIds),
        countRowsById(sql, context.workspaceId, "workspace_completion_jobs", targets.jobIds),
        countRowsById(sql, context.workspaceId, "workspace_completion_job_attempts", targets.attemptIds),
        countRowsById(sql, context.workspaceId, "workspace_completion_policy_change_requests", targets.policyRequestIds)
      ]);
      return {
        activities: countPair(targets.activityIds.length, values[0]),
        resources: countPair(targets.resourceIds.length, values[1]),
        versions: countPair(targets.documents.length, values[2]),
        evidence: countPair(targets.evidenceIds.length, values[3]),
        links: countPair(targets.linkIds.length, values[4]),
        uses: countPair(targets.useIds.length, values[5]),
        jobs: countPair(targets.jobIds.length, values[6]),
        attempts: countPair(targets.attemptIds.length, values[7]),
        policy_change_requests: countPair(targets.policyRequestIds.length, values[8])
      };
    });
    const mismatch = Object.entries(counts).filter(([, value]) => value.expected !== value.actual);
    if (mismatch.length > 0) {
      throw new WorkspaceServerError("workspace_completion_migration_verification_failed", 409, { counts });
    }
    const files: Array<{ resource_id: string; version: number; source_hash: string; destination_hash: string }> = [];
    for (const expected of targets.documents) {
      const actual = await this.completion.getResourceBody(context, expected.resourceId, expected.version);
      if (actual.content !== expected.content) {
        throw new WorkspaceServerError("workspace_completion_migration_file_content_mismatch", 409, {
          resource_id: expected.resourceId,
          version: expected.version
        });
      }
      files.push({
        resource_id: expected.resourceId,
        version: expected.version,
        source_hash: hash(expected.content),
        destination_hash: actual.version.contentHash
      });
    }
    return { counts, contentHash: hash(canonicalJson(files)) };
  }

  private async defaultMigrationRoom(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">): Promise<string> {
    return this.completion.store.database.withContext(context, async (sql) => {
      const room = await sql.query<{ id: string }>(
        "SELECT id FROM rooms WHERE workspace_id = $1 AND samurai_can_room(workspace_id, id, 'execute') ORDER BY created_at ASC, id ASC LIMIT 1",
        [context.workspaceId]
      );
      if (!room.rows[0]) throw new WorkspaceServerError("workspace_completion_migration_room_required", 409);
      return room.rows[0].id;
    });
  }

  private async readLegacySnapshot(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">): Promise<LegacySnapshot> {
    return this.completion.store.database.withReadSnapshot(context, async (sql) => {
      const [activities, resources, versions, evidence, links, uses, jobs, attempts] = await Promise.all([
        sql.query<LegacyActivityRow>("SELECT * FROM workspace_learning_activities WHERE workspace_id = $1 ORDER BY finalized_at ASC, id ASC", [context.workspaceId]),
        sql.query<LegacyResourceRow>("SELECT * FROM workspace_learning_resources WHERE workspace_id = $1 ORDER BY id ASC", [context.workspaceId]),
        sql.query<LegacyVersionRow>("SELECT * FROM workspace_learning_resource_versions WHERE workspace_id = $1 ORDER BY resource_id ASC, version ASC", [context.workspaceId]),
        sql.query<LegacyEvidenceRow>("SELECT * FROM workspace_learning_evidence WHERE workspace_id = $1 ORDER BY created_at ASC, id ASC", [context.workspaceId]),
        sql.query<LegacyLinkRow>("SELECT * FROM workspace_learning_resource_links WHERE workspace_id = $1 ORDER BY created_at ASC, id ASC", [context.workspaceId]),
        sql.query<LegacyUseRow>("SELECT * FROM workspace_learning_resource_uses WHERE workspace_id = $1 ORDER BY created_at ASC, id ASC", [context.workspaceId]),
        sql.query<LegacyJobRow>("SELECT * FROM workspace_learning_jobs WHERE workspace_id = $1 ORDER BY created_at ASC, id ASC", [context.workspaceId]),
        sql.query<LegacyAttemptRow>("SELECT * FROM workspace_learning_job_attempts WHERE workspace_id = $1 ORDER BY job_id ASC, attempt_no ASC", [context.workspaceId])
      ]);
      return {
        activities: activities.rows,
        resources: resources.rows,
        versions: versions.rows,
        evidence: evidence.rows,
        links: links.rows,
        uses: uses.rows,
        jobs: jobs.rows,
        attempts: attempts.rows
      };
    });
  }

  private async assertOwner(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">): Promise<void> {
    await this.completion.store.database.withContext(context, async (sql) => {
      const result = await sql.query<{ allowed: boolean }>("SELECT samurai_can_workspace($1, 'owner') AS allowed", [context.workspaceId]);
      if (result.rows[0]?.allowed !== true) throw new WorkspaceServerError("workspace_completion_migration_owner_required", 403);
    });
  }

  private assertAuthenticatedHuman(context: WorkspaceRequestContext): void {
    const caller = context.caller;
    if (!isTrustedWorkspaceCaller(caller) || caller.kind !== "human" || caller.principalAccountId !== context.accountId
      || caller.operationId !== context.operationId || !caller.signature || !/^[a-f0-9]{64}$/.test(caller.canonicalPayloadHash)) {
      throw new WorkspaceServerError("workspace_completion_migration_owner_human_required", 403);
    }
  }

  private async beginRun(context: WorkspaceRequestContext, runId: string): Promise<MigrationRunState> {
    return this.completion.store.database.withContext(context, async (sql) => {
      const result = await sql.query<{ state: MigrationRunState }>(
        "SELECT samurai_begin_completion_migration_run($1, $2, $3) AS state",
        [context.workspaceId, runId, context.operationId]
      );
      const state = result.rows[0]?.state;
      if (!isMigrationRunState(state)) throw new WorkspaceServerError("workspace_completion_migration_run_invalid", 503);
      return state;
    });
  }

  private async transitionRun(
    context: WorkspaceRequestContext,
    state: Exclude<MigrationRunState, "preparing">,
    preview: WorkspaceCompletionLegacyMigrationPreview,
    verificationHash?: string,
    errorCode?: string
  ): Promise<void> {
    await this.completion.store.database.withContext(context, async (sql) => {
      await sql.query(
        "SELECT samurai_transition_completion_migration_run($1, $2, $3, $4::JSONB, $5, $6, $7)",
        [
          context.workspaceId,
          context.migrationRunId,
          state,
          canonicalJson({
            activities: preview.activities,
            resources: preview.resources,
            versions: preview.versions,
            evidence: preview.evidence,
            links: preview.links,
            uses: preview.uses,
            jobs: preview.jobs,
            attempts: preview.attempts,
            policy_candidates: preview.policyCandidates
          }),
          preview.integrityHash,
          verificationHash ?? null,
          errorCode ?? null
        ]
      );
    });
  }

  private async readRun(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId" | "migrationRunId">): Promise<{ state: MigrationRunState; sourceIntegrityHash?: string }> {
    return this.completion.store.database.withContext(context, async (sql) => {
      const result = await sql.query<{ state: MigrationRunState; source_integrity_hash: string | null }>(
        `SELECT state, source_integrity_hash
         FROM workspace_completion_migration_runs
         WHERE workspace_id = $1 AND id = $2`,
        [context.workspaceId, context.migrationRunId]
      );
      const row = result.rows[0];
      if (!row || !isMigrationRunState(row.state)) throw new WorkspaceServerError("workspace_completion_migration_run_not_found", 409);
      return { state: row.state, ...(row.source_integrity_hash ? { sourceIntegrityHash: row.source_integrity_hash } : {}) };
    });
  }

  private async recordReceipt(
    context: WorkspaceRequestContext,
    preview: WorkspaceCompletionLegacyMigrationPreview,
    status: "prepared" | "verified" | "switched" | "rolled_back" | "failed",
    extra: WorkspaceRecordPayload
  ): Promise<string> {
    const id = receiptId(context.workspaceId, preview.integrityHash, status);
    await this.completion.store.runIdempotent(withOperation(context, `receipt:${status}`), {
      action: "workspace.completion.migration.receipt",
      input: { integrity_hash: preview.integrityHash, status }
    }, async (sql) => {
      await sql.query(
        `INSERT INTO workspace_completion_migration_receipts(workspace_id, id, source_format, target_format, counts, integrity_hash, status, created_by)
         VALUES ($1, $2, 'legacy_learning', 'workspace_completion', $3::JSONB, $4, $5, $6)
         ON CONFLICT (workspace_id, id) DO NOTHING`,
        [context.workspaceId, id, canonicalJson({ activities: preview.activities, resources: preview.resources, versions: preview.versions, ...extra }), preview.integrityHash, status, context.accountId]
      );
    });
    return id;
  }

  /** The database function removes only rows marked `legacy_source` and
   * refuses to run after a switch. Files are removed afterward only if their
   * recorded hash is still present, so a later human edit always wins. */
  private async rollbackFailedMigration(context: WorkspaceRequestContext, integrityHash: string): Promise<MigrationRollbackResult> {
    const rollback = await this.completion.store.runIdempotentResult(withOperation(context, "rollback"), {
      action: "workspace.completion.migration.rollback",
      input: { integrity_hash: integrityHash }
    }, async (sql) => {
      const result = await sql.query<{ rollback: WorkspaceRecordPayload }>(
        "SELECT samurai_rollback_completion_legacy_migration($1, $2) AS rollback",
        [context.workspaceId, integrityHash]
      );
      return payload(result.rows[0]?.rollback);
    });
    const records = Array.isArray(rollback.value.orphaned_files) ? rollback.value.orphaned_files : [];
    let removedFiles = 0;
    let preservedFiles = 0;
    for (const entry of records) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const value = entry as Record<string, unknown>;
      if (typeof value.path !== "string" || typeof value.sha256 !== "string") continue;
      if (await this.completion.files.removeIfUnchanged(context.workspaceId, value.path, value.sha256)) removedFiles += 1;
      else preservedFiles += 1;
    }
    return {
      removedResources: countValue(rollback.value.removed_resources),
      removedActivities: countValue(rollback.value.removed_activities),
      removedJobs: countValue(rollback.value.removed_jobs),
      removedFiles,
      preservedFiles
    };
  }
}

interface LegacySnapshot {
  activities: readonly LegacyActivityRow[];
  resources: readonly LegacyResourceRow[];
  versions: readonly LegacyVersionRow[];
  evidence: readonly LegacyEvidenceRow[];
  links: readonly LegacyLinkRow[];
  uses: readonly LegacyUseRow[];
  jobs: readonly LegacyJobRow[];
  attempts: readonly LegacyAttemptRow[];
}

interface LegacyMigrationTargets {
  activityIds: string[];
  resourceIds: string[];
  evidenceIds: string[];
  linkIds: string[];
  useIds: string[];
  jobIds: string[];
  attemptIds: string[];
  policyRequestIds: string[];
  documents: Array<{ resourceId: string; version: number; content: string }>;
}

interface MigrationCount {
  expected: number;
  actual: number;
}

interface MigrationVerification {
  counts: Record<string, MigrationCount>;
  contentHash: string;
}

interface MigrationRollbackResult {
  removedResources: number;
  removedActivities: number;
  removedJobs: number;
  removedFiles: number;
  preservedFiles: number;
}

type MigrationRunState = "preparing" | "backfilling" | "verified" | "switched" | "rolling_back" | "rolled_back" | "failed";

function isMigrationRunState(value: unknown): value is MigrationRunState {
  return value === "preparing" || value === "backfilling" || value === "verified" || value === "switched"
    || value === "rolling_back" || value === "rolled_back" || value === "failed";
}

interface LegacyActivityRow {
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
  outcome: "completed" | "failed" | "cancelled" | "outcome_unknown";
  verification_state: "confirmed" | "failed" | "not_run" | "unknown";
  failure_state: "none" | "resolved" | "unresolved";
  explicit_remember: boolean;
  payload: unknown;
  created_at: Date | string;
  finalized_at: Date | string;
}

interface LegacyResourceRow {
  workspace_id: string;
  id: string;
  scope_kind: "workspace" | "room";
  room_id: string | null;
  resource_kind: LegacyResourceKind;
  state: "active" | "archived" | "conflict";
  ai_update_locked: boolean;
  source_job_id: string | null;
  source_attempt_id: string | null;
  title: string;
  content: string;
  payload: unknown;
  version: number | string;
  created_by: string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface LegacyVersionRow {
  resource_id: string;
  version: number | string;
  title: string;
  content: string;
  payload: unknown;
  source_job_id: string | null;
  source_attempt_id: string | null;
  reason: string;
  created_at: Date | string;
}

interface LegacyEvidenceRow {
  id: string;
  resource_id: string;
  resource_version: number | string;
  activity_id: string | null;
  kind: "activity" | "human_correction" | "explicit_remember" | "use_outcome" | "human_edit";
  summary: string;
  created_at: Date | string;
}

interface LegacyLinkRow {
  id: string;
  from_resource_id: string;
  to_resource_id: string;
  relation: "conflicts" | "copied_from" | "moved_from" | "promoted_from" | "derived_from";
  created_at: Date | string;
}

interface LegacyUseRow {
  id: string;
  resource_id: string;
  resource_version: number | string;
  activity_id: string;
  outcome: "confirmed_success" | "confirmed_failure" | "unknown";
  supersedes_use_id: string | null;
  summary: string;
  created_at: Date | string;
}

interface LegacyJobRow {
  id: string;
  room_id: string;
  kind: "review" | "curator";
  status: "queued" | "running" | "completed" | "failed" | "blocked";
  group_key: string;
  high_watermark_activity_id: string;
  attempt_count: number | string;
  max_attempts: number | string;
  blocked_reason: string | null;
  created_by: string;
  updated_by: string;
  created_at: Date | string;
  updated_at: Date | string;
  completed_at: Date | string | null;
}

interface LegacyAttemptRow {
  id: string;
  job_id: string;
  attempt_no: number | string;
  worker_id: string;
  status: "running" | "completed" | "failed" | "blocked";
  input_hash: string;
  output_hash: string | null;
  error_code: string | null;
  started_at: Date | string;
  completed_at: Date | string | null;
}

function previewFromSnapshot(snapshot: LegacySnapshot): WorkspaceCompletionLegacyMigrationPreview {
  const byKind: Record<LegacyResourceKind, number> = { knowledge: 0, memory: 0, skill: 0, workspace_rule: 0 };
  const blockedSecretResources: string[] = [];
  for (const resource of snapshot.resources) {
    byKind[resource.resource_kind] += 1;
    if (hasSecretResource(snapshot, resource)) blockedSecretResources.push(resource.id);
  }
  const integrityHash = hash(canonicalJson({
    activities: snapshot.activities.map((row) => ({ id: row.id, finalized_at: iso(row.finalized_at), payload: row.payload })),
    resources: snapshot.resources.map((row) => ({ id: row.id, kind: row.resource_kind, version: row.version, content: row.content, payload: row.payload })),
    versions: snapshot.versions.map((row) => ({ resource_id: row.resource_id, version: row.version, content: row.content, payload: row.payload })),
    evidence: snapshot.evidence.map((row) => ({ id: row.id, resource_id: row.resource_id, resource_version: row.resource_version, activity_id: row.activity_id, summary: row.summary })),
    links: snapshot.links.map((row) => ({ id: row.id, from_resource_id: row.from_resource_id, to_resource_id: row.to_resource_id, relation: row.relation })),
    uses: snapshot.uses.map((row) => ({ id: row.id, resource_id: row.resource_id, resource_version: row.resource_version, activity_id: row.activity_id, outcome: row.outcome, summary: row.summary })),
    jobs: snapshot.jobs.map((row) => ({ id: row.id, room_id: row.room_id, kind: row.kind, status: row.status, group_key: row.group_key, high_watermark_activity_id: row.high_watermark_activity_id })),
    attempts: snapshot.attempts.map((row) => ({ id: row.id, job_id: row.job_id, attempt_no: row.attempt_no, status: row.status, input_hash: row.input_hash, output_hash: row.output_hash }))
  }));
  return {
    integrityHash,
    activities: snapshot.activities.length,
    resources: snapshot.resources.length,
    versions: snapshot.versions.length,
    evidence: snapshot.evidence.length,
    links: snapshot.links.length,
    uses: snapshot.uses.length,
    jobs: snapshot.jobs.length,
    attempts: snapshot.attempts.length,
    byKind,
    profileCandidates: snapshot.resources.filter((resource) => resource.resource_kind === "memory" && resource.ai_update_locked && !resource.source_job_id).length,
    policyCandidates: byKind.workspace_rule,
    blockedSecretResources
  };
}

function versionsFor(snapshot: LegacySnapshot, resourceId: string): LegacyVersionRow[] {
  return snapshot.versions.filter((version) => version.resource_id === resourceId);
}

function expectedMigrationTargets(snapshot: LegacySnapshot, workspaceId: string): LegacyMigrationTargets {
  const activityIds = snapshot.activities
    .filter((activity) => !hasSecretActivity(activity))
    .map((activity) => targetActivityId(workspaceId, activity.id));
  const allowedActivities = new Map(snapshot.activities
    .filter((activity) => !hasSecretActivity(activity))
    .map((activity) => [activity.id, activity]));
  const migratable = new Map(snapshot.resources
    .filter((resource) => isMigratableResource(snapshot, resource))
    .map((resource) => [resource.id, resource]));
  const targets: LegacyMigrationTargets = {
    activityIds,
    resourceIds: [],
    evidenceIds: [],
    linkIds: [],
    useIds: [],
    jobIds: [],
    attemptIds: [],
    policyRequestIds: [],
    documents: []
  };
  for (const resource of snapshot.resources) {
    const history = versionsFor(snapshot, resource.id);
    const sourceVersions = history.length > 0 ? history : [currentAsVersion(resource)];
    if (hasSecretResource(snapshot, resource)) continue;
    const targetId = targetResourceId(workspaceId, resource.id);
    if (resource.resource_kind !== "workspace_rule") {
      targets.resourceIds.push(targetId);
      for (const [index, source] of sourceVersions.entries()) {
        targets.documents.push({ resourceId: targetId, version: index + 1, content: source.content });
      }
      continue;
    }
    for (const source of sourceVersions) {
      // A legacy workspace_rule has no cryptographically verified Human
      // approval. It is always a request for re-approval, regardless of who
      // originally authored it; no active Policy resource is reconstructed.
      targets.policyRequestIds.push(legacyId("completion_legacy_policy_request", workspaceId, `${resource.id}:${source.version}`));
    }
  }
  for (const source of snapshot.evidence) {
    const resource = migratable.get(source.resource_id);
    const targetVersion = resource ? targetVersionForLegacy(snapshot, resource, Number(source.resource_version)) : undefined;
    const activity = source.activity_id ? allowedActivities.get(source.activity_id) : undefined;
    const kind = legacyEvidenceKind(source.kind);
    if (resource && targetVersion !== undefined && !containsSecret(source.summary) && (kind === "human_edit" || activity)) {
      targets.evidenceIds.push(targetEvidenceId(workspaceId, source.id));
    }
  }
  for (const source of snapshot.links) {
    const from = migratable.get(source.from_resource_id);
    const to = migratable.get(source.to_resource_id);
    if (from && to && from.id !== to.id) targets.linkIds.push(targetLinkId(workspaceId, source.id));
  }
  for (const source of snapshot.uses) {
    const resource = migratable.get(source.resource_id);
    const targetVersion = resource ? targetVersionForLegacy(snapshot, resource, Number(source.resource_version)) : undefined;
    if (resource && targetVersion !== undefined && allowedActivities.has(source.activity_id) && !containsSecret(source.summary)) {
      targets.useIds.push(targetUseId(workspaceId, source.id));
    }
  }
  const migratedJobs = new Set<string>();
  for (const job of snapshot.jobs) {
    if (!allowedActivities.has(job.high_watermark_activity_id)) continue;
    migratedJobs.add(job.id);
    targets.jobIds.push(targetJobId(workspaceId, job.id));
  }
  for (const attempt of snapshot.attempts) {
    if (migratedJobs.has(attempt.job_id)) targets.attemptIds.push(targetAttemptId(workspaceId, attempt.id));
  }
  return targets;
}

type CompletionIdCountTable =
  | "workspace_completion_activities"
  | "workspace_completion_resources"
  | "workspace_completion_evidence"
  | "workspace_completion_resource_links"
  | "workspace_completion_uses"
  | "workspace_completion_jobs"
  | "workspace_completion_job_attempts"
  | "workspace_completion_policy_change_requests";

async function countRowsById(sql: WorkspaceSql, workspaceId: string, table: CompletionIdCountTable, ids: readonly string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const result = await sql.query<{ count: number | string }>(
    `SELECT COUNT(*)::TEXT AS count FROM ${table} WHERE workspace_id = $1 AND id = ANY($2::TEXT[])`,
    [workspaceId, [...ids]]
  );
  return countValue(result.rows[0]?.count);
}

async function countRowsByResourceId(
  sql: WorkspaceSql,
  workspaceId: string,
  table: "workspace_completion_resource_versions",
  resourceIds: readonly string[]
): Promise<number> {
  if (resourceIds.length === 0) return 0;
  const result = await sql.query<{ count: number | string }>(
    `SELECT COUNT(*)::TEXT AS count FROM ${table} WHERE workspace_id = $1 AND resource_id = ANY($2::TEXT[])`,
    [workspaceId, [...resourceIds]]
  );
  return countValue(result.rows[0]?.count);
}

function countPair(expected: number, actual: number): MigrationCount {
  return { expected, actual };
}

function countValue(value: unknown): number {
  const parsed = Number(value ?? 0);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new WorkspaceServerError("workspace_completion_migration_count_invalid", 500);
  return parsed;
}

function legacyMigratableJobIds(snapshot: LegacySnapshot): Set<string> {
  const allowedActivityIds = new Set(snapshot.activities
    .filter((activity) => !hasSecretActivity(activity))
    .map((activity) => activity.id));
  return new Set(snapshot.jobs
    .filter((job) => allowedActivityIds.has(job.high_watermark_activity_id))
    .map((job) => job.id));
}

function errorCode(error: unknown): string {
  return error instanceof WorkspaceServerError ? error.code : "workspace_completion_migration_failed";
}

function emptyMigrationResult(preview: WorkspaceCompletionLegacyMigrationPreview): WorkspaceCompletionLegacyMigrationResult {
  return {
    ...preview,
    replayed: false,
    migratedActivities: 0,
    migratedResources: 0,
    migratedVersions: 0,
    migratedPolicies: 0,
    migratedPolicyRequests: 0,
    migratedEvidence: 0,
    migratedLinks: 0,
    migratedUses: 0,
    migratedJobs: 0,
    migratedAttempts: 0
  };
}

function hasSecretResource(snapshot: LegacySnapshot, resource: LegacyResourceRow): boolean {
  const history = versionsFor(snapshot, resource.id);
  return containsSecret(resource.id) || containsSecret(resource.title) || containsSecret(resource.content) || containsSecret(resource.payload)
    || history.some((version) => containsSecret(version.title) || containsSecret(version.content) || containsSecret(version.payload));
}

function hasSecretActivity(activity: LegacyActivityRow): boolean {
  return containsSecret(activity.group_key) || containsSecret(activity.source_kind) || containsSecret(activity.source_id)
    || containsSecret(activity.instruction_summary) || containsSecret(activity.result_summary) || containsSecret(activity.payload);
}

function isMigratableResource(snapshot: LegacySnapshot, resource: LegacyResourceRow): boolean {
  if (hasSecretResource(snapshot, resource)) return false;
  // workspace_rule is represented only by a re-approval request.  It has no
  // target Resource/Version to which old Evidence, Links, or Uses could be
  // safely attached.
  return resource.resource_kind !== "workspace_rule";
}

function targetVersionForLegacy(snapshot: LegacySnapshot, resource: LegacyResourceRow, sourceVersion: number): number | undefined {
  const source = versionsFor(snapshot, resource.id);
  const history = source.length > 0 ? source : [currentAsVersion(resource)];
  const index = history.findIndex((version) => Number(version.version) === sourceVersion);
  if (index < 0) return undefined;
  if (resource.resource_kind === "workspace_rule") return undefined;
  return index + 1;
}

function legacyPolicyRequestSummary(resource: LegacyResourceRow, version: LegacyVersionRow): string {
  const body = version.content.trim();
  const excerpt = body.length > 16_000 ? `${body.slice(0, 16_000)}\n\n[legacy workspace_rule truncated]` : body;
  return `AI作成の旧workspace_rule（${resource.id} / 版${version.version}）です。人間が構造化Policyとして確認・署名するまで強制しません。\n\n${excerpt}`;
}

function legacyEvidenceKind(value: LegacyEvidenceRow["kind"]): "activity" | "human_edit" | "explicit_remember" | "use_outcome" {
  if (value === "human_edit") return "human_edit";
  if (value === "explicit_remember") return "explicit_remember";
  if (value === "use_outcome") return "use_outcome";
  return "activity";
}

function legacyLinkRelation(value: LegacyLinkRow["relation"]): "conflicts" | "copied_from" | "moved_from" | "promoted_from" | "derived_from" {
  return value;
}

function restoredLegacyJobStatus(job: LegacyJobRow): "queued" | "completed" | "failed" | "blocked" {
  if (job.status === "running") return "queued";
  if (job.status === "blocked" && !job.blocked_reason) return "failed";
  return job.status;
}

function legacyBlockedReason(job: LegacyJobRow): string | null {
  if (job.status === "blocked") return job.blocked_reason || "legacy_blocked";
  return null;
}

function restoredLegacyAttemptStatus(status: LegacyAttemptRow["status"]): "completed" | "failed" | "blocked" {
  return status === "running" ? "failed" : status;
}

function hashOrFingerprint(value: string): string {
  return /^[a-f0-9]{64}$/.test(value) ? value : hash(value);
}

function legacyEpisodeId(workspaceId: string, roomId: string, groupKey: string): string {
  return legacyId("completion_legacy_episode", workspaceId, `${roomId}:${groupKey}`);
}

function targetActivityId(workspaceId: string, sourceId: string): string {
  return legacyId("completion_legacy_activity", workspaceId, sourceId);
}

function targetJobId(workspaceId: string, sourceId: string): string {
  return legacyId("completion_legacy_job", workspaceId, sourceId);
}

function targetAttemptId(workspaceId: string, sourceId: string): string {
  return legacyId("completion_legacy_attempt", workspaceId, sourceId);
}

function targetEvidenceId(workspaceId: string, sourceId: string): string {
  return legacyId("completion_legacy_evidence", workspaceId, sourceId);
}

function targetLinkId(workspaceId: string, sourceId: string): string {
  return legacyId("completion_legacy_link", workspaceId, sourceId);
}

function targetUseId(workspaceId: string, sourceId: string): string {
  return legacyId("completion_legacy_use", workspaceId, sourceId);
}

function currentAsVersion(resource: LegacyResourceRow): LegacyVersionRow {
  return {
    resource_id: resource.id,
    version: resource.version,
    title: resource.title,
    content: resource.content,
    payload: resource.payload,
    source_job_id: resource.source_job_id,
    source_attempt_id: resource.source_attempt_id,
    reason: "旧形式の現行版",
    created_at: resource.updated_at
  };
}

function migrationMetadata(resource: LegacyResourceRow, version: LegacyVersionRow, kind: "knowledge" | "skill"): WorkspaceRecordPayload {
  const original = payload(version.payload);
  const provisional = resource.resource_kind === "memory" || (kind === "knowledge" && !validKnowledgeKind(original.knowledge_kind));
  return {
    ...original,
    ...(provisional ? { migration_provisional: true } : {}),
    ...(resource.resource_kind === "memory" && resource.ai_update_locked && !resource.source_job_id ? { migration_profile_candidate: true } : {}),
    ...(kind === "skill" && !isCompleteLegacySkill(original) ? { migration_incomplete_skill: true } : {}),
    legacy_source: {
      resource_id: resource.id,
      resource_kind: resource.resource_kind,
      source_version: Number(version.version),
      source_created_by: resource.created_by,
      source_created_at: iso(version.created_at),
      source_state: resource.state,
      source_ai_locked: resource.ai_update_locked,
      ...(version.source_job_id ?? resource.source_job_id ? { source_job_id: version.source_job_id ?? resource.source_job_id } : {}),
      ...(version.source_attempt_id ?? resource.source_attempt_id ? { source_attempt_id: version.source_attempt_id ?? resource.source_attempt_id } : {})
    }
  };
}

function scopeFromLegacy(resource: LegacyResourceRow): WorkspaceCompletionScope {
  if (resource.scope_kind === "workspace") return { kind: "workspace" };
  if (!resource.room_id) throw new WorkspaceServerError("workspace_completion_legacy_scope_invalid", 422);
  return { kind: "room", roomId: resource.room_id };
}

function knowledgeKind(value: unknown): WorkspaceCompletionKnowledgeKind {
  return validKnowledgeKind(value) ? value : "explanation";
}

function validKnowledgeKind(value: unknown): value is WorkspaceCompletionKnowledgeKind {
  return value === "fact" || value === "decision" || value === "explanation" || value === "experience_rule";
}

function isCompleteLegacySkill(metadata: WorkspaceRecordPayload): boolean {
  return ["when", "inputs", "preconditions", "completion", "failure"].every((key) => typeof metadata[key] === "string" && metadata[key].trim())
    && Array.isArray(metadata.steps) && metadata.steps.length > 0
    && Array.isArray(metadata.knowledge_ids);
}

function targetResourceId(workspaceId: string, sourceId: string): string {
  return /^[a-z][a-z0-9_:-]{0,127}$/.test(sourceId) ? sourceId : legacyId("completion_legacy_resource", workspaceId, sourceId);
}

function withOperation(context: WorkspaceRequestContext, suffix: string): WorkspaceRequestContext {
  return { ...context, operationId: legacyId("completion_migration", context.workspaceId, `${context.operationId}:${suffix}`) };
}

function receiptId(workspaceId: string, integrityHash: string, status: string): string {
  return legacyId("completion_migration_receipt", workspaceId, `${integrityHash}:${status}`);
}

function legacyId(prefix: string, workspaceId: string, value: string): string {
  const id = `${prefix}_${hash(`${workspaceId}:${value}`).slice(0, 40)}`;
  assertOpaqueId(id, "workspace_completion_migration_id_invalid");
  return id;
}

function payload(value: unknown): WorkspaceRecordPayload {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as WorkspaceRecordPayload : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? value as WorkspaceRecordPayload : {};
}

function containsSecret(value: unknown): boolean {
  if (typeof value === "string") return containsWorkspaceCompletionSecret(value);
  if (Array.isArray(value)) return value.some(containsSecret);
  return Boolean(value && typeof value === "object" && Object.entries(value as Record<string, unknown>).some(([key, child]) => containsWorkspaceCompletionSecret(key) || containsSecret(child)));
}

function legacyOutcome(value: LegacyActivityRow["outcome"]): "completed" | "failed" | "cancelled" | "unknown" {
  return value === "outcome_unknown" ? "unknown" : value;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
