import { createHash } from "node:crypto";
import { canonicalJson } from "./auth";
import { assertOpaqueId } from "./config";
import { WorkspaceServerError } from "./errors";
import type { WorkspaceSql } from "./postgres";
import type { WorkspaceRequestContext } from "./types";
import type { WorkspaceCompletionTuning } from "./workspace-completion-types";
import { parseWorkspaceCompletionDocument, type WorkspaceCompletionFileService } from "./workspace-completion-files";
import { containsWorkspaceCompletionSecret } from "./workspace-completion-policy";
import { WorkspaceCompletionService } from "./workspace-completion-service";

export interface WorkspaceCompletionCuratorAction {
  kind: "archive_exact_duplicate" | "mark_skill_stale" | "archive_candidate" | "mark_review_required" | "semantic_link";
  resourceId: string;
  relatedResourceId?: string;
  reason: string;
  /** Every destructive or linking decision is bound to the exact current
   * Resource state that was reviewed. */
  expectedVersion: number;
  expectedContentHash: string;
  expectedLifecycleState: "active" | "stale" | "archived";
  expectedEvidenceState: "provisional" | "confirmed" | "contradicted" | "review_required";
  relatedExpected?: {
    version: number;
    contentHash: string;
    lifecycleState: "active" | "stale" | "archived";
    evidenceState: "provisional" | "confirmed" | "contradicted" | "review_required";
  };
  planSnapshotHash: string;
}

export interface WorkspaceCompletionCuratorReport {
  roomId: string;
  status: "seeded" | "paused" | "semantic_disabled" | "not_idle" | "not_due" | "unchanged" | "dry_run" | "applied";
  actions: readonly WorkspaceCompletionCuratorAction[];
  snapshotId?: string;
}

export interface WorkspaceCompletionSemanticCuratorCandidate {
  id: string;
  version: number;
  kind: "knowledge" | "skill";
  title: string;
  content: string;
  contentHash: string;
  lifecycleState: "active" | "stale" | "archived";
  evidenceState: "provisional" | "confirmed" | "contradicted" | "review_required";
}

/** A replaceable Backend receives only the eligible Room-local snapshot. It
 * may suggest relationships, never destructive merges or direct body edits. */
export interface WorkspaceCompletionSemanticCuratorPort {
  review(input: { workspaceId: string; roomId: string; resources: readonly WorkspaceCompletionSemanticCuratorCandidate[] }): Promise<{
    links: readonly { fromResourceId: string; toResourceId: string; relation: "derived_from" | "supersedes"; reason: string }[];
  }>;
}

/** Deterministic, Room-local maintenance. Semantic consolidation is exposed
 * as a dry-run capability but remains disabled unless an owner enables it. */
export class WorkspaceCompletionCuratorService {
  constructor(readonly completion: WorkspaceCompletionService) {}

  async getStatus(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, roomId: string): Promise<{ paused: boolean; semanticEnabled: boolean; seededAt?: string; lastLightRunAt?: string; lastSemanticRunAt?: string }> {
    assertOpaqueId(roomId, "room_id_invalid");
    return this.completion.store.database.withContext(context, async (sql) => {
      const result = await sql.query<CuratorStateRow>(
        "SELECT * FROM workspace_completion_curator_state WHERE workspace_id = $1 AND room_id = $2",
        [context.workspaceId, roomId]
      );
      return result.rows[0] ? stateFromRow(result.rows[0]) : { paused: false, semanticEnabled: false };
    });
  }

  async setPaused(context: WorkspaceRequestContext, input: { roomId: string; paused: boolean }): Promise<void> {
    assertOpaqueId(input.roomId, "room_id_invalid");
    await this.completion.store.runIdempotent(context, { action: input.paused ? "workspace.completion.curator.pause" : "workspace.completion.curator.resume", input }, async (sql) => {
      await this.assertAuthority(sql, context, input.roomId, "manage");
      await sql.query(
        `INSERT INTO workspace_completion_curator_state(workspace_id, room_id, paused)
         VALUES ($1, $2, $3)
         ON CONFLICT (workspace_id, room_id) DO UPDATE SET paused = EXCLUDED.paused, updated_at = NOW()`,
        [context.workspaceId, input.roomId, input.paused]
      );
      await this.completion.store.insertAudit(sql, context, { action: input.paused ? "workspace.completion.curator.pause" : "workspace.completion.curator.resume", roomId: input.roomId, subjectKind: "completion_curator", subjectId: input.roomId });
    });
  }

  async setSemanticEnabled(context: WorkspaceRequestContext, input: { roomId: string; enabled: boolean }): Promise<void> {
    assertOpaqueId(input.roomId, "room_id_invalid");
    await this.completion.store.runIdempotent(context, { action: "workspace.completion.curator.semantic.configure", input }, async (sql) => {
      await this.assertAuthority(sql, context, input.roomId, "manage");
      await sql.query(
        `INSERT INTO workspace_completion_curator_state(workspace_id, room_id, semantic_enabled)
         VALUES ($1, $2, $3)
         ON CONFLICT (workspace_id, room_id) DO UPDATE SET semantic_enabled = EXCLUDED.semantic_enabled, updated_at = NOW()`,
        [context.workspaceId, input.roomId, input.enabled]
      );
      await this.completion.store.insertAudit(sql, context, { action: "workspace.completion.curator.semantic.configure", roomId: input.roomId, subjectKind: "completion_curator", subjectId: input.roomId, details: { enabled: input.enabled } });
    });
  }

  async dryRun(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, roomId: string): Promise<WorkspaceCompletionCuratorReport> {
    assertOpaqueId(roomId, "room_id_invalid");
    const tuning = (await this.completion.getEffectiveConfiguration(context, roomId)).values;
    const [state, plan] = await this.completion.store.database.withContext(context, async (sql) => {
      const state = await readState(sql, context.workspaceId, roomId);
      const plan = await buildLightPlan(this.completion.files, sql, context.workspaceId, roomId, tuning);
      return [state, plan] as const;
    });
    return { roomId, status: state.paused ? "paused" : "dry_run", actions: plan };
  }

  async runLight(context: WorkspaceRequestContext, input: { roomId: string; dryRun?: boolean }): Promise<WorkspaceCompletionCuratorReport> {
    assertOpaqueId(input.roomId, "room_id_invalid");
    const tuning = (await this.completion.getEffectiveConfiguration(context, input.roomId)).values;
    const preflight = await this.completion.store.database.withContext(context, async (sql) => {
      await this.assertAuthority(sql, context, input.roomId, "execute");
      const state = await readState(sql, context.workspaceId, input.roomId);
      const idle = await isIdle(sql, context.workspaceId, input.roomId, tuning.curatorMinimumIdleHours);
      const changed = await hasChangedSinceLightRun(sql, context.workspaceId, input.roomId, state.lastLightRunAt);
      const plan = await buildLightPlan(this.completion.files, sql, context.workspaceId, input.roomId, tuning);
      return { state, idle, changed, plan };
    });
    if (preflight.state.paused) return { roomId: input.roomId, status: "paused", actions: [] };
    if (!preflight.state.seededAt) {
      if (!input.dryRun) await this.seed(context, input.roomId);
      return { roomId: input.roomId, status: "seeded", actions: [] };
    }
    if (!preflight.idle) return { roomId: input.roomId, status: "not_idle", actions: [] };
    if (!input.dryRun && !isDue(preflight.state.lastLightRunAt, tuning.curatorLightIntervalHours)) return { roomId: input.roomId, status: "not_due", actions: [] };
    if (!preflight.changed) return { roomId: input.roomId, status: "unchanged", actions: [] };
    if (input.dryRun) return { roomId: input.roomId, status: "dry_run", actions: preflight.plan };
    if (preflight.plan.length === 0) {
      await this.completion.store.runIdempotent(context, { action: "workspace.completion.curator.light", input }, async (sql) => {
        await this.assertAuthority(sql, context, input.roomId, "execute");
        await sql.query("UPDATE workspace_completion_curator_state SET last_light_run_at = NOW(), updated_at = NOW() WHERE workspace_id = $1 AND room_id = $2", [context.workspaceId, input.roomId]);
      });
      return { roomId: input.roomId, status: "applied", actions: [] };
    }
    return this.applyLightPlan(context, input.roomId, preflight.plan, tuning);
  }

  /** The Job queue records this exact snapshot fingerprint. A changed Room
   * cannot have an older Curator result applied after a restart or lease
   * handoff. */
  async inputHash(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, input: { roomId: string; mode: "light" | "semantic" }): Promise<string> {
    assertOpaqueId(input.roomId, "room_id_invalid");
    return this.completion.store.database.withContext(context, async (sql) => {
      const [state, resources] = await Promise.all([
        readState(sql, context.workspaceId, input.roomId),
        readCuratorResourceFingerprint(sql, context.workspaceId, input.roomId)
      ]);
      return createHash("sha256").update(canonicalJson({
        room_id: input.roomId,
        mode: input.mode,
        paused: state.paused,
        semantic_enabled: state.semanticEnabled,
        seeded_at: state.seededAt ?? null,
        last_light_run_at: state.lastLightRunAt ?? null,
        last_semantic_run_at: state.lastSemanticRunAt ?? null,
        resources
      })).digest("hex");
    });
  }

  /** Semantic maintenance is intentionally constrained to adding a Link. The
   * port cannot return a deletion or a confirmed body replacement. Dry runs
   * are useful even while the scheduled semantic mode remains disabled. */
  async runSemantic(
    context: WorkspaceRequestContext,
    input: { roomId: string; port: WorkspaceCompletionSemanticCuratorPort; dryRun?: boolean }
  ): Promise<WorkspaceCompletionCuratorReport> {
    assertOpaqueId(input.roomId, "room_id_invalid");
    const tuning = (await this.completion.getEffectiveConfiguration(context, input.roomId)).values;
    const preflight = await this.completion.store.database.withContext(context, async (sql) => {
      await this.assertAuthority(sql, context, input.roomId, "execute");
      const state = await readState(sql, context.workspaceId, input.roomId);
      const idle = await isIdle(sql, context.workspaceId, input.roomId, tuning.curatorMinimumIdleHours);
      const changed = await hasChangedSinceSemanticRun(sql, context.workspaceId, input.roomId, state.lastSemanticRunAt);
      const candidates = await readSemanticCandidates(this.completion.files, sql, context.workspaceId, input.roomId, tuning.curatorSnapshotMaxItems);
      return { state, idle, changed, candidates };
    });
    if (preflight.state.paused) return { roomId: input.roomId, status: "paused", actions: [] };
    if (!input.dryRun && !preflight.state.semanticEnabled) return { roomId: input.roomId, status: "semantic_disabled", actions: [] };
    if (!preflight.state.seededAt) {
      if (!input.dryRun) await this.seed(context, input.roomId);
      return { roomId: input.roomId, status: "seeded", actions: [] };
    }
    if (!preflight.idle) return { roomId: input.roomId, status: "not_idle", actions: [] };
    if (!input.dryRun && !isDue(preflight.state.lastSemanticRunAt, tuning.curatorSemanticIntervalDays * 24)) return { roomId: input.roomId, status: "not_due", actions: [] };
    if (!preflight.changed) return { roomId: input.roomId, status: "unchanged", actions: [] };
    const output = await input.port.review({ workspaceId: context.workspaceId, roomId: input.roomId, resources: preflight.candidates });
    const plan = bindSemanticPlan(preflight.candidates, validateSemanticPlan(preflight.candidates, output));
    if (input.dryRun) return { roomId: input.roomId, status: "dry_run", actions: plan };
    return this.applySemanticPlan(context, input.roomId, plan, tuning);
  }

  async listSnapshots(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, roomId: string): Promise<Array<{ id: string; createdAt: string }>> {
    assertOpaqueId(roomId, "room_id_invalid");
    const tuning = (await this.completion.getEffectiveConfiguration(context, roomId)).values;
    return this.completion.store.database.withContext(context, async (sql) => {
      const rows = await sql.query<{ id: string; created_at: Date | string }>(
        "SELECT id, created_at FROM workspace_completion_curator_snapshots WHERE workspace_id = $1 AND room_id = $2 ORDER BY created_at DESC LIMIT $3",
        [context.workspaceId, roomId, tuning.curatorSnapshotLimit]
      );
      return rows.rows.map((row) => ({ id: row.id, createdAt: iso(row.created_at) }));
    });
  }

  async rollbackSnapshot(context: WorkspaceRequestContext, input: { roomId: string; snapshotId: string }): Promise<void> {
    assertOpaqueId(input.roomId, "room_id_invalid");
    assertOpaqueId(input.snapshotId, "workspace_completion_snapshot_id_invalid");
    await this.completion.store.runIdempotent(context, { action: "workspace.completion.curator.rollback", input }, async (sql) => {
      await this.assertAuthority(sql, context, input.roomId, "execute");
      const snapshot = await sql.query<{ snapshot: unknown }>(
        "SELECT snapshot FROM workspace_completion_curator_snapshots WHERE workspace_id = $1 AND room_id = $2 AND id = $3 FOR UPDATE",
        [context.workspaceId, input.roomId, input.snapshotId]
      );
      const rows = snapshot.rows[0] ? snapshotResources(snapshot.rows[0].snapshot) : undefined;
      if (!rows) throw new WorkspaceServerError("workspace_completion_snapshot_not_found", 404);
      const current = await readResourcesById(sql, context.workspaceId, input.roomId, rows.map((row) => row.id));
      const byId = new Map(current.map((resource) => [resource.id, resource]));
      if (current.length !== rows.length || rows.some((row) => {
        const resource = byId.get(row.id);
        return !resource
          || !matchesCuratorExpected(resource, row.version, row.contentHash, row.expectedLifecycleState, row.expectedEvidenceState)
          || resource.ai_managed !== true || resource.creation_source !== "ai" || resource.ai_protection !== "editable";
      })) {
        throw new WorkspaceServerError("workspace_completion_curator_stale_input", 409);
      }
      for (const row of rows) {
        await sql.query(
          `UPDATE workspace_completion_resources SET evidence_state = $4, lifecycle_state = $5,
             archived_at = CASE WHEN $5 = 'archived' THEN COALESCE(archived_at, NOW()) ELSE NULL END, updated_by = $6, updated_at = NOW()
           WHERE workspace_id = $1 AND id = $2 AND scope_kind = 'room' AND room_id = $3
             AND version = $7 AND ai_managed AND creation_source = 'ai' AND ai_protection = 'editable'`,
          [context.workspaceId, row.id, input.roomId, row.evidenceState, row.lifecycleState, context.accountId, row.version]
        );
      }
      await this.completion.store.insertAudit(sql, context, { action: "workspace.completion.curator.rollback", roomId: input.roomId, subjectKind: "completion_curator_snapshot", subjectId: input.snapshotId });
    });
  }

  private async seed(context: WorkspaceRequestContext, roomId: string): Promise<void> {
    await this.completion.store.runIdempotent(context, { action: "workspace.completion.curator.seed", input: { roomId } }, async (sql) => {
      await this.assertAuthority(sql, context, roomId, "execute");
      await sql.query(
        `INSERT INTO workspace_completion_curator_state(workspace_id, room_id, seeded_at, last_light_run_at)
         VALUES ($1, $2, NOW(), NOW())
         ON CONFLICT (workspace_id, room_id) DO UPDATE SET seeded_at = COALESCE(workspace_completion_curator_state.seeded_at, NOW()), last_light_run_at = NOW(), updated_at = NOW()`,
        [context.workspaceId, roomId]
      );
    });
  }

  private async applyLightPlan(context: WorkspaceRequestContext, roomId: string, plan: readonly WorkspaceCompletionCuratorAction[], tuning: WorkspaceCompletionTuning): Promise<WorkspaceCompletionCuratorReport> {
    const snapshotId = completionId("completion_snapshot", context.workspaceId, context.operationId);
    await this.completion.store.runIdempotent(context, { action: "workspace.completion.curator.light", input: { roomId, plan } }, async (sql) => {
      await this.assertAuthority(sql, context, roomId, "execute");
      const state = await readState(sql, context.workspaceId, roomId);
      if (state.paused) throw new WorkspaceServerError("workspace_completion_curator_paused", 409);
      if (!(await isIdle(sql, context.workspaceId, roomId, tuning.curatorMinimumIdleHours))) throw new WorkspaceServerError("workspace_completion_curator_not_idle", 409);
      // Lock only the Resources that this plan will change or relate, in
      // stable ID order.  Locking every AI Resource would turn a large Room
      // into an unbounded transaction and is unnecessary for stale safety.
      const records = await readCuratorPlanResourcesForUpdate(sql, context.workspaceId, roomId, plannedResourceIds(plan), true);
      assertCuratorPlanFresh(plan, records);
      const snapshot = curatorRollbackSnapshot(records, plan);
      await sql.query(
        `INSERT INTO workspace_completion_curator_snapshots(workspace_id, id, room_id, snapshot, created_by)
         VALUES ($1, $2, $3, $4::JSONB, $5)`,
        [context.workspaceId, snapshotId, roomId, canonicalJson({ resources: snapshot }), context.accountId]
      );
      for (const action of plan) {
        const resource = records.find((row) => row.id === action.resourceId);
        if (!resource) throw new WorkspaceServerError("workspace_completion_curator_stale_input", 409);
        if (action.kind === "archive_exact_duplicate") {
          const updated = await sql.query<{ id: string; version: number | string }>(
            `UPDATE workspace_completion_resources SET lifecycle_state = 'archived', archived_at = NOW(), updated_by = $3, updated_at = NOW()
             WHERE workspace_id = $1 AND id = $2 AND lifecycle_state <> 'archived' RETURNING id, version`,
            [context.workspaceId, resource.id, context.accountId]
          );
          if (!updated.rows[0]) continue;
          const version = Number(updated.rows[0].version);
          await sql.query(
            `INSERT INTO workspace_completion_evidence(workspace_id, id, resource_id, resource_version, kind, summary)
             VALUES ($1, $2, $3, $4, 'unverified_claim', $5)`,
            [context.workspaceId, completionId("completion_evidence", context.workspaceId, `${resource.id}:${version}:duplicate`), resource.id, version, action.reason]
          );
          if (action.relatedResourceId) {
            await sql.query(
              `INSERT INTO workspace_completion_resource_links(workspace_id, id, from_resource_id, to_resource_id, relation)
               VALUES ($1, $2, $3, $4, 'supersedes') ON CONFLICT (workspace_id, from_resource_id, to_resource_id, relation) DO NOTHING`,
              [context.workspaceId, completionId("completion_link", context.workspaceId, `${resource.id}:${action.relatedResourceId}:supersedes`), resource.id, action.relatedResourceId]
            );
          }
        } else if (action.kind === "mark_skill_stale") {
          await sql.query(
            `UPDATE workspace_completion_resources SET lifecycle_state = 'stale', updated_by = $3, updated_at = NOW()
             WHERE workspace_id = $1 AND id = $2 AND lifecycle_state = 'active'`,
            [context.workspaceId, resource.id, context.accountId]
          );
        } else if (action.kind === "mark_review_required") {
          await sql.query(
            `UPDATE workspace_completion_resources SET evidence_state = 'review_required', updated_by = $3, updated_at = NOW()
             WHERE workspace_id = $1 AND id = $2`,
            [context.workspaceId, resource.id, context.accountId]
          );
        }
      }
      await sql.query("UPDATE workspace_completion_curator_state SET last_light_run_at = NOW(), updated_at = NOW() WHERE workspace_id = $1 AND room_id = $2", [context.workspaceId, roomId]);
      await sql.query(
        `DELETE FROM workspace_completion_curator_snapshots
         WHERE workspace_id = $1 AND room_id = $2 AND id IN (
           SELECT id FROM workspace_completion_curator_snapshots
           WHERE workspace_id = $1 AND room_id = $2 ORDER BY created_at DESC OFFSET $3
         )`,
        [context.workspaceId, roomId, tuning.curatorSnapshotLimit]
      );
      await this.completion.store.insertAudit(sql, context, { action: "workspace.completion.curator.light", roomId, subjectKind: "completion_curator_snapshot", subjectId: snapshotId, details: { actions: plan.length } });
    });
    return { roomId, status: "applied", actions: plan, snapshotId };
  }

  private async applySemanticPlan(context: WorkspaceRequestContext, roomId: string, plan: readonly WorkspaceCompletionCuratorAction[], tuning: WorkspaceCompletionTuning): Promise<WorkspaceCompletionCuratorReport> {
    const snapshotId = completionId("completion_snapshot", context.workspaceId, `${context.operationId}:semantic`);
    await this.completion.store.runIdempotent(context, { action: "workspace.completion.curator.semantic", input: { roomId, plan } }, async (sql) => {
      await this.assertAuthority(sql, context, roomId, "execute");
      const state = await readState(sql, context.workspaceId, roomId);
      if (state.paused) throw new WorkspaceServerError("workspace_completion_curator_paused", 409);
      if (!state.semanticEnabled) throw new WorkspaceServerError("workspace_completion_curator_semantic_disabled", 409);
      if (!(await isIdle(sql, context.workspaceId, roomId, tuning.curatorMinimumIdleHours))) throw new WorkspaceServerError("workspace_completion_curator_not_idle", 409);
      const records = await readCuratorPlanResourcesForUpdate(sql, context.workspaceId, roomId, plannedResourceIds(plan), false);
      assertCuratorPlanFresh(plan, records);
      const snapshot = curatorRollbackSnapshot(records, plan);
      await sql.query(
        `INSERT INTO workspace_completion_curator_snapshots(workspace_id, id, room_id, snapshot, created_by)
         VALUES ($1, $2, $3, $4::JSONB, $5)`,
        [context.workspaceId, snapshotId, roomId, canonicalJson({ resources: snapshot }), context.accountId]
      );
      for (const action of plan) {
        if (action.kind !== "semantic_link" || !action.relatedResourceId) continue;
        const from = records.find((resource) => resource.id === action.resourceId);
        const to = records.find((resource) => resource.id === action.relatedResourceId);
        if (!from || !to || !isSemanticEligible(from) || !isSemanticEligible(to)) {
          throw new WorkspaceServerError("workspace_completion_curator_stale_input", 409);
        }
        await sql.query(
          `INSERT INTO workspace_completion_resource_links(workspace_id, id, from_resource_id, to_resource_id, relation)
           VALUES ($1, $2, $3, $4, 'derived_from')
           ON CONFLICT (workspace_id, from_resource_id, to_resource_id, relation) DO NOTHING`,
          [context.workspaceId, completionId("completion_link", context.workspaceId, `${from.id}:${to.id}:semantic`), from.id, to.id]
        );
      }
      await sql.query(
        "UPDATE workspace_completion_curator_state SET last_semantic_run_at = NOW(), updated_at = NOW() WHERE workspace_id = $1 AND room_id = $2",
        [context.workspaceId, roomId]
      );
      await trimSnapshots(sql, context.workspaceId, roomId, tuning.curatorSnapshotLimit);
      await this.completion.store.insertAudit(sql, context, {
        action: "workspace.completion.curator.semantic", roomId, subjectKind: "completion_curator_snapshot", subjectId: snapshotId,
        details: { actions: plan.length }
      });
    });
    return { roomId, status: "applied", actions: plan, snapshotId };
  }

  private async assertAuthority(sql: WorkspaceSql, context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId" | "caller">, roomId: string, role: "execute" | "manage"): Promise<void> {
    await assertCuratorAuthority(sql, context, roomId, role);
    await this.completion.assertOperationAllowed(sql, context, roomId, "curator.apply", role === "manage" ? "edit" : "execute", { curator: true });
  }
}

interface CuratorStateRow {
  paused: boolean;
  semantic_enabled: boolean;
  seeded_at: Date | string | null;
  last_light_run_at: Date | string | null;
  last_semantic_run_at: Date | string | null;
}

interface CuratorResourceRow {
  id: string;
  title: string;
  resource_kind: "knowledge" | "skill" | "policy";
  knowledge_kind: string | null;
  scope_kind: "workspace" | "room";
  room_id: string | null;
  evidence_state: "provisional" | "confirmed" | "contradicted" | "review_required";
  lifecycle_state: "active" | "stale" | "archived";
  ai_protection: "editable" | "fixed";
  creation_source: "human" | "ai" | "import" | "machine_verified" | "physical_file_import";
  ai_managed: boolean;
  version: number | string;
  content_hash: string;
  file_path?: string;
  /** Calculated from the package content without its Resource ID. This is
   * deliberately distinct from content_hash, which protects a specific
   * immutable Version and therefore includes the document identity. */
  dedupe_hash?: string;
  metadata: unknown;
  created_at: Date | string;
  last_used_at: Date | string | null;
}

type UnboundCuratorAction = Pick<WorkspaceCompletionCuratorAction, "kind" | "resourceId" | "relatedResourceId" | "reason">;

async function readState(sql: WorkspaceSql, workspaceId: string, roomId: string): Promise<ReturnType<typeof stateFromRow>> {
  const result = await sql.query<CuratorStateRow>("SELECT * FROM workspace_completion_curator_state WHERE workspace_id = $1 AND room_id = $2", [workspaceId, roomId]);
  return result.rows[0] ? stateFromRow(result.rows[0]) : { paused: false, semanticEnabled: false };
}

function stateFromRow(row: CuratorStateRow): { paused: boolean; semanticEnabled: boolean; seededAt?: string; lastLightRunAt?: string; lastSemanticRunAt?: string } {
  return {
    paused: row.paused, semanticEnabled: row.semantic_enabled,
    ...(row.seeded_at ? { seededAt: iso(row.seeded_at) } : {}),
    ...(row.last_light_run_at ? { lastLightRunAt: iso(row.last_light_run_at) } : {}),
    ...(row.last_semantic_run_at ? { lastSemanticRunAt: iso(row.last_semantic_run_at) } : {})
  };
}

async function isIdle(sql: WorkspaceSql, workspaceId: string, roomId: string, minimumIdleHours: number): Promise<boolean> {
  const result = await sql.query<{ idle: boolean }>(
    `SELECT NOT EXISTS(
       SELECT 1 FROM workspace_completion_activities
       WHERE workspace_id = $1 AND room_id = $2 AND created_at > NOW() - ($3::BIGINT * INTERVAL '1 hour')
     ) AS idle`,
    [workspaceId, roomId, minimumIdleHours]
  );
  return result.rows[0]?.idle === true;
}

async function hasChangedSinceLightRun(sql: WorkspaceSql, workspaceId: string, roomId: string, lastLightRunAt: string | undefined): Promise<boolean> {
  if (!lastLightRunAt) return true;
  const result = await sql.query<{ changed: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM workspace_completion_resources
       WHERE workspace_id = $1 AND scope_kind = 'room' AND room_id = $2 AND updated_at > $3::TIMESTAMPTZ
       UNION ALL
       SELECT 1 FROM workspace_completion_activities
       WHERE workspace_id = $1 AND room_id = $2 AND finalized_at > $3::TIMESTAMPTZ
       UNION ALL
       SELECT 1 FROM workspace_completion_evaluations evaluation
       JOIN workspace_completion_resources resource ON resource.workspace_id = evaluation.workspace_id AND resource.id = evaluation.resource_id
       WHERE evaluation.workspace_id = $1 AND resource.scope_kind = 'room' AND resource.room_id = $2 AND evaluation.created_at > $3::TIMESTAMPTZ
     ) AS changed`,
    [workspaceId, roomId, lastLightRunAt]
  );
  return result.rows[0]?.changed === true;
}

async function hasChangedSinceSemanticRun(sql: WorkspaceSql, workspaceId: string, roomId: string, lastSemanticRunAt: string | undefined): Promise<boolean> {
  return hasChangedSinceLightRun(sql, workspaceId, roomId, lastSemanticRunAt);
}

async function readCuratorResourceFingerprint(sql: WorkspaceSql, workspaceId: string, roomId: string): Promise<WorkspaceRecordFingerprint> {
  const result = await sql.query<{
    resource_count: number | string;
    resource_updated_at: Date | string | null;
    activity_finalized_at: Date | string | null;
    evaluation_created_at: Date | string | null;
  }>(
    `SELECT
       (SELECT COUNT(*) FROM workspace_completion_resources
        WHERE workspace_id = $1 AND scope_kind = 'room' AND room_id = $2) AS resource_count,
       (SELECT MAX(updated_at) FROM workspace_completion_resources
        WHERE workspace_id = $1 AND scope_kind = 'room' AND room_id = $2) AS resource_updated_at,
       (SELECT MAX(finalized_at) FROM workspace_completion_activities
        WHERE workspace_id = $1 AND room_id = $2) AS activity_finalized_at,
       (SELECT MAX(evaluation.created_at) FROM workspace_completion_evaluations evaluation
        JOIN workspace_completion_resources resource ON resource.workspace_id = evaluation.workspace_id AND resource.id = evaluation.resource_id
        WHERE evaluation.workspace_id = $1 AND resource.scope_kind = 'room' AND resource.room_id = $2) AS evaluation_created_at`,
    [workspaceId, roomId]
  );
  const row = result.rows[0];
  return {
    resourceCount: Number(row?.resource_count ?? 0),
    ...(row?.resource_updated_at ? { resourceUpdatedAt: iso(row.resource_updated_at) } : {}),
    ...(row?.activity_finalized_at ? { activityFinalizedAt: iso(row.activity_finalized_at) } : {}),
    ...(row?.evaluation_created_at ? { evaluationCreatedAt: iso(row.evaluation_created_at) } : {})
  };
}

interface WorkspaceRecordFingerprint {
  resourceCount: number;
  resourceUpdatedAt?: string;
  activityFinalizedAt?: string;
  evaluationCreatedAt?: string;
}

interface SemanticCandidateRow {
  id: string;
  version: number | string;
  resource_kind: "knowledge" | "skill";
  title: string;
  file_path: string;
  content_hash: string;
  lifecycle_state: "active" | "stale" | "archived";
  evidence_state: "provisional" | "confirmed" | "contradicted" | "review_required";
}

async function readSemanticCandidates(
  files: WorkspaceCompletionService["files"],
  sql: WorkspaceSql,
  workspaceId: string,
  roomId: string,
  maxItems: number
): Promise<WorkspaceCompletionSemanticCuratorCandidate[]> {
  const result = await sql.query<SemanticCandidateRow>(
    `SELECT resource.id, resource.version, resource.resource_kind, resource.title, version.file_path, version.content_hash,
            resource.lifecycle_state, resource.evidence_state
     FROM workspace_completion_resources resource
     JOIN workspace_completion_resource_versions version
       ON version.workspace_id = resource.workspace_id AND version.resource_id = resource.id
      AND version.version = COALESCE(resource.current_confirmed_version, resource.current_provisional_version)
     JOIN workspace_completion_file_batches batch ON batch.workspace_id = version.workspace_id AND batch.id = version.file_batch_id
     WHERE resource.workspace_id = $1 AND resource.scope_kind = 'room' AND resource.room_id = $2
       AND resource.ai_managed AND resource.creation_source = 'ai' AND resource.ai_protection = 'editable'
       AND resource.lifecycle_state <> 'archived' AND resource.resource_kind IN ('knowledge', 'skill')
       AND batch.status = 'renamed'
     ORDER BY resource.updated_at DESC, resource.id ASC
     LIMIT $3`,
    [workspaceId, roomId, maxItems + 1]
  );
  if (result.rows.length > maxItems) {
    throw new WorkspaceServerError("workspace_completion_curator_snapshot_limit_exceeded", 409, { max_items: maxItems });
  }
  const candidates: WorkspaceCompletionSemanticCuratorCandidate[] = [];
  for (const row of result.rows) {
    const document = parseWorkspaceCompletionDocument(await files.read(workspaceId, row.file_path, row.content_hash));
    if (document.id !== row.id || document.title !== row.title || document.resourceKind !== row.resource_kind) {
      throw new WorkspaceServerError("workspace_completion_file_metadata_mismatch", 503, { resource_id: row.id });
    }
    candidates.push({
      id: row.id,
      version: Number(row.version),
      kind: row.resource_kind,
      title: row.title,
      content: document.body.slice(0, 20_000),
      contentHash: row.content_hash,
      lifecycleState: row.lifecycle_state,
      evidenceState: row.evidence_state
    });
  }
  return candidates;
}

function validateSemanticPlan(
  candidates: readonly WorkspaceCompletionSemanticCuratorCandidate[],
  value: unknown
): UnboundCuratorAction[] {
  if (!value || typeof value !== "object" || Array.isArray(value) || !Array.isArray((value as { links?: unknown }).links)) {
    throw new WorkspaceServerError("workspace_completion_semantic_curator_output_invalid", 422, { path: "$.links", expected: "array" });
  }
  const links = (value as { links: unknown[] }).links;
  if (links.length > 50) throw new WorkspaceServerError("workspace_completion_semantic_curator_output_invalid", 422, { path: "$.links", expected: "50 or fewer links" });
  const eligible = new Set(candidates.map((candidate) => candidate.id));
  const dedupe = new Set<string>();
  const plan: UnboundCuratorAction[] = [];
  for (const [index, raw] of links.entries()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new WorkspaceServerError("workspace_completion_semantic_curator_output_invalid", 422, { path: `$.links[${index}]`, expected: "link object" });
    const item = raw as Record<string, unknown>;
    const from = typeof item.fromResourceId === "string" ? item.fromResourceId : "";
    const to = typeof item.toResourceId === "string" ? item.toResourceId : "";
    const relation = item.relation;
    const reason = typeof item.reason === "string" ? item.reason.trim() : "";
    if (!eligible.has(from) || !eligible.has(to) || from === to || (relation !== "derived_from" && relation !== "supersedes") || !reason || reason.length > 20_000 || containsWorkspaceCompletionSecret(reason)) {
      throw new WorkspaceServerError("workspace_completion_semantic_curator_output_invalid", 422, { path: `$.links[${index}]`, expected: "eligible distinct IDs, allowed relation, and bounded reason" });
    }
    const key = `${from}:${to}`;
    if (dedupe.has(key)) continue;
    dedupe.add(key);
    plan.push({ kind: "semantic_link", resourceId: from, relatedResourceId: to, reason });
  }
  return plan;
}

function bindSemanticPlan(
  candidates: readonly WorkspaceCompletionSemanticCuratorCandidate[],
  plan: readonly UnboundCuratorAction[]
): WorkspaceCompletionCuratorAction[] {
  const rows = candidates.map((candidate) => ({
    id: candidate.id,
    title: candidate.title,
    resource_kind: candidate.kind,
    knowledge_kind: null,
    scope_kind: "room" as const,
    room_id: null,
    evidence_state: candidate.evidenceState,
    lifecycle_state: candidate.lifecycleState,
    ai_protection: "editable" as const,
    creation_source: "ai" as const,
    ai_managed: true,
    version: candidate.version,
    content_hash: candidate.contentHash,
    metadata: {},
    created_at: "1970-01-01T00:00:00.000Z",
    last_used_at: null
  }));
  return bindCuratorPlan(rows, plan);
}

function bindCuratorPlan(
  rows: readonly CuratorResourceRow[],
  plan: readonly UnboundCuratorAction[]
): WorkspaceCompletionCuratorAction[] {
  const resources = new Map(rows.map((row) => [row.id, row]));
  for (const action of plan) {
    const resource = resources.get(action.resourceId);
    const related = action.relatedResourceId ? resources.get(action.relatedResourceId) : undefined;
    if (!resource || (action.relatedResourceId && !related)) {
      throw new WorkspaceServerError("workspace_completion_curator_plan_target_missing", 409);
    }
  }
  // The plan hash covers every Resource actually used by the plan (targets
  // and relations), rather than unrelated Room content.  This makes the
  // stale check exact while retaining bounded memory and lock scope.
  const planSnapshotHash = curatorPlanSnapshotHash(recordsForPlan(rows, plan));
  return plan.map((action) => {
    const resource = resources.get(action.resourceId)!;
    const related = action.relatedResourceId ? resources.get(action.relatedResourceId) : undefined;
    return {
      ...action,
      expectedVersion: Number(resource.version),
      expectedContentHash: resource.content_hash,
      expectedLifecycleState: resource.lifecycle_state,
      expectedEvidenceState: resource.evidence_state,
      ...(related ? {
        relatedExpected: {
          version: Number(related.version),
          contentHash: related.content_hash,
          lifecycleState: related.lifecycle_state,
          evidenceState: related.evidence_state
        }
      } : {}),
      // One plan-wide hash is repeated on each action so the DB application
      // can reject a copied or mixed action array without a separate mutable
      // plan table.
      planSnapshotHash
    };
  });
}

function curatorResourceFingerprint(resource: Pick<CuratorResourceRow, "id" | "version" | "content_hash" | "lifecycle_state" | "evidence_state">): Record<string, unknown> {
  return {
    id: resource.id,
    version: Number(resource.version),
    content_hash: resource.content_hash,
    lifecycle_state: resource.lifecycle_state,
    evidence_state: resource.evidence_state
  };
}


function isDue(lastRunAt: string | undefined, intervalHours: number): boolean {
  return !lastRunAt || Date.now() - Date.parse(lastRunAt) >= intervalHours * 3_600_000;
}

async function buildLightPlan(
  files: WorkspaceCompletionFileService,
  sql: WorkspaceSql,
  workspaceId: string,
  roomId: string,
  tuning: WorkspaceCompletionTuning
): Promise<WorkspaceCompletionCuratorAction[]> {
  const rows = await sql.query<CuratorResourceRow>(
    `SELECT resource.*, version.content_hash, version.file_path, version.metadata,
       (SELECT MAX(use_event.created_at) FROM workspace_completion_uses use_event
        WHERE use_event.workspace_id = resource.workspace_id AND use_event.resource_id = resource.id) AS last_used_at
     FROM workspace_completion_resources resource
     JOIN workspace_completion_resource_versions version
       ON version.workspace_id = resource.workspace_id AND version.resource_id = resource.id
      AND version.version = COALESCE(resource.current_confirmed_version, resource.current_provisional_version)
     JOIN workspace_completion_file_batches batch ON batch.workspace_id = version.workspace_id AND batch.id = version.file_batch_id
     WHERE resource.workspace_id = $1 AND resource.scope_kind = 'room' AND resource.room_id = $2
       AND resource.ai_managed AND resource.creation_source = 'ai' AND resource.ai_protection = 'editable'
       AND resource.resource_kind IN ('knowledge', 'skill') AND batch.status = 'renamed'
     ORDER BY resource.created_at ASC, resource.id ASC
     LIMIT $3`,
    [workspaceId, roomId, tuning.curatorSnapshotMaxItems + 1]
  );
  if (rows.rows.length > tuning.curatorSnapshotMaxItems) {
    throw new WorkspaceServerError("workspace_completion_curator_snapshot_limit_exceeded", 409, { max_items: tuning.curatorSnapshotMaxItems });
  }
  // A rendered document contains its Resource ID, so its immutable Version
  // hash cannot identify two separately-created but otherwise identical
  // Knowledge/Skill packages. Compute a bounded, identity-free package hash
  // from the verified file body and support-file manifest instead.
  for (const row of rows.rows) {
    row.dedupe_hash = await curatorDuplicateHash(files, sql, workspaceId, row);
  }
  const plan: UnboundCuratorAction[] = [];
  const duplicateIndex = new Map<string, CuratorResourceRow>();
  for (const row of rows.rows) {
    if (row.lifecycle_state === "archived") continue;
    const duplicateKey = `${row.resource_kind}:${row.dedupe_hash}`;
    const existing = duplicateIndex.get(duplicateKey);
    if (existing) {
      plan.push({ kind: "archive_exact_duplicate", resourceId: row.id, relatedResourceId: existing.id, reason: "AI管理対象の同一scope・同一種類・同一hashの完全重複" });
      continue;
    }
    duplicateIndex.set(duplicateKey, row);
    const ageDays = row.last_used_at ? daysSince(row.last_used_at) : daysSince(row.created_at);
    if (row.resource_kind === "skill" && row.lifecycle_state === "active" && ageDays >= tuning.skillStaleAfterDays) {
      plan.push({ kind: "mark_skill_stale", resourceId: row.id, reason: `${tuning.skillStaleAfterDays}日間、利用記録がないAI管理Skill` });
    }
    if (row.resource_kind === "skill" && ageDays >= tuning.skillArchiveAfterDays) {
      plan.push({ kind: "archive_candidate", resourceId: row.id, reason: `${tuning.skillArchiveAfterDays}日間、利用記録がないAI管理Skillのarchive候補` });
    }
    if (row.resource_kind === "knowledge" && row.evidence_state === "provisional" && ageDays >= tuning.provisionalKnowledgeArchiveAfterDays) {
      plan.push({ kind: "archive_candidate", resourceId: row.id, reason: `${tuning.provisionalKnowledgeArchiveAfterDays}日間、利用・Evidence・確認がない暫定Knowledgeのarchive候補` });
    }
    const metadata = row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata) ? row.metadata as Record<string, unknown> : undefined;
    const expiresAt = typeof metadata?.expires_at === "string" ? metadata.expires_at : undefined;
    if (expiresAt && !Number.isNaN(Date.parse(expiresAt)) && Date.parse(expiresAt) <= Date.now()) {
      plan.push({ kind: "mark_review_required", resourceId: row.id, reason: "有効期限を過ぎたKnowledge" });
    }
  }
  return bindCuratorPlan(rows.rows, plan);
}

async function curatorDuplicateHash(
  files: WorkspaceCompletionFileService,
  sql: WorkspaceSql,
  workspaceId: string,
  resource: CuratorResourceRow
): Promise<string> {
  if (!resource.file_path) throw new WorkspaceServerError("workspace_completion_curator_file_path_missing", 503, { resource_id: resource.id });
  const document = parseWorkspaceCompletionDocument(await files.read(workspaceId, resource.file_path, resource.content_hash));
  if (document.id !== resource.id || document.resourceKind !== resource.resource_kind || document.title !== resource.title) {
    throw new WorkspaceServerError("workspace_completion_file_metadata_mismatch", 503, { resource_id: resource.id });
  }
  const support = resource.resource_kind === "skill"
    ? await sql.query<{ relative_path: string; content_hash: string; content_size: number | string }>(
      `SELECT relative_path, content_hash, content_size
       FROM workspace_completion_skill_files
       WHERE workspace_id = $1 AND resource_id = $2 AND resource_version = $3
       ORDER BY relative_path ASC`,
      [workspaceId, resource.id, Number(resource.version)]
    )
    : { rows: [] as Array<{ relative_path: string; content_hash: string; content_size: number | string }> };
  return hashText(canonicalJson({
    resource_kind: resource.resource_kind,
    title: document.title,
    metadata: document.metadata,
    body: document.body,
    support: support.rows.map((file) => ({
      path: file.relative_path,
      content_hash: file.content_hash,
      content_size: Number(file.content_size)
    }))
  }));
}

async function readCuratorPlanResourcesForUpdate(
  sql: WorkspaceSql,
  workspaceId: string,
  roomId: string,
  resourceIds: readonly string[],
  includeArchived: boolean
): Promise<CuratorResourceRow[]> {
  if (resourceIds.length === 0) return [];
  const result = await sql.query<CuratorResourceRow>(
    `SELECT resource.*, version.content_hash, version.metadata, NULL::TIMESTAMPTZ AS last_used_at
     FROM workspace_completion_resources resource
     JOIN workspace_completion_resource_versions version
       ON version.workspace_id = resource.workspace_id AND version.resource_id = resource.id
      AND version.version = COALESCE(resource.current_confirmed_version, resource.current_provisional_version)
     JOIN workspace_completion_file_batches batch ON batch.workspace_id = version.workspace_id AND batch.id = version.file_batch_id
     WHERE resource.workspace_id = $1 AND resource.scope_kind = 'room' AND resource.room_id = $2
       AND resource.id = ANY($3::TEXT[])
       AND resource.ai_managed AND resource.creation_source = 'ai' AND resource.ai_protection = 'editable'
       AND resource.resource_kind IN ('knowledge', 'skill') AND batch.status = 'renamed'
       AND ($4::BOOLEAN OR resource.lifecycle_state <> 'archived')
     ORDER BY resource.id ASC FOR UPDATE OF resource, version`,
    [workspaceId, roomId, [...resourceIds].sort(), includeArchived]
  );
  return result.rows;
}

async function readResourcesById(sql: WorkspaceSql, workspaceId: string, roomId: string, ids: readonly string[]): Promise<CuratorResourceRow[]> {
  if (ids.length === 0) return [];
  const result = await sql.query<CuratorResourceRow>(
    `SELECT resource.*, version.content_hash, version.metadata, NULL::TIMESTAMPTZ AS last_used_at
     FROM workspace_completion_resources resource
     JOIN workspace_completion_resource_versions version ON version.workspace_id = resource.workspace_id AND version.resource_id = resource.id
      AND version.version = COALESCE(resource.current_confirmed_version, resource.current_provisional_version)
     WHERE resource.workspace_id = $1 AND resource.scope_kind = 'room' AND resource.room_id = $2 AND resource.id = ANY($3::TEXT[])
     ORDER BY resource.id ASC FOR UPDATE OF resource, version`,
    [workspaceId, roomId, [...new Set(ids)]]
  );
  return result.rows;
}

function curatorPlanSnapshotHash(rows: readonly CuratorResourceRow[]): string {
  return hashText(canonicalJson([...rows]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map(curatorResourceFingerprint)));
}

function assertCuratorPlanFresh(
  plan: readonly WorkspaceCompletionCuratorAction[],
  records: readonly CuratorResourceRow[]
): void {
  if (plan.length === 0) return;
  const expectedPlanHash = plan[0]!.planSnapshotHash;
  if (!/^[a-f0-9]{64}$/.test(expectedPlanHash)
    || plan.some((action) => action.planSnapshotHash !== expectedPlanHash)
    || curatorPlanSnapshotHash(records) !== expectedPlanHash) {
    throw new WorkspaceServerError("workspace_completion_curator_stale_input", 409);
  }
  const byId = new Map(records.map((record) => [record.id, record]));
  for (const action of plan) {
    const resource = byId.get(action.resourceId);
    if (!resource || !matchesCuratorExpected(resource, action.expectedVersion, action.expectedContentHash, action.expectedLifecycleState, action.expectedEvidenceState)
      || !isSemanticEligible(resource)) {
      throw new WorkspaceServerError("workspace_completion_curator_stale_input", 409, { resource_id: action.resourceId });
    }
    if (action.relatedResourceId) {
      const related = byId.get(action.relatedResourceId);
      const expected = action.relatedExpected;
      if (!related || !expected || !matchesCuratorExpected(related, expected.version, expected.contentHash, expected.lifecycleState, expected.evidenceState)
        || !isSemanticEligible(related)) {
        throw new WorkspaceServerError("workspace_completion_curator_stale_input", 409, { resource_id: action.relatedResourceId });
      }
    }
  }
}

function matchesCuratorExpected(
  resource: CuratorResourceRow,
  version: number,
  contentHash: string,
  lifecycleState: string,
  evidenceState: string
): boolean {
  return Number(resource.version) === version
    && resource.content_hash === contentHash
    && resource.lifecycle_state === lifecycleState
    && resource.evidence_state === evidenceState;
}

function recordsForPlan(
  allResources: readonly CuratorResourceRow[],
  plan: readonly Pick<WorkspaceCompletionCuratorAction, "resourceId" | "relatedResourceId">[]
): CuratorResourceRow[] {
  const ids = new Set(plannedResourceIds(plan));
  return allResources.filter((resource) => ids.has(resource.id));
}

function plannedResourceIds(plan: readonly Pick<WorkspaceCompletionCuratorAction, "resourceId" | "relatedResourceId">[]): string[] {
  return [...new Set(plan.flatMap((action) => action.relatedResourceId
    ? [action.resourceId, action.relatedResourceId]
    : [action.resourceId]))].sort();
}

interface CuratorRollbackSnapshotResource {
  id: string;
  version: number;
  contentHash: string;
  evidenceState: "provisional" | "confirmed" | "contradicted" | "review_required";
  lifecycleState: "active" | "stale" | "archived";
  expectedEvidenceState: "provisional" | "confirmed" | "contradicted" | "review_required";
  expectedLifecycleState: "active" | "stale" | "archived";
}

function curatorRollbackSnapshot(
  records: readonly CuratorResourceRow[],
  plan: readonly WorkspaceCompletionCuratorAction[]
): CuratorRollbackSnapshotResource[] {
  const byId = new Map(records.map((record) => [record.id, record]));
  const after = new Map(records.map((record) => [record.id, {
    evidenceState: record.evidence_state,
    lifecycleState: record.lifecycle_state
  }]));
  for (const action of plan) {
    const state = after.get(action.resourceId);
    if (!state) continue;
    if (action.kind === "archive_exact_duplicate") state.lifecycleState = "archived";
    if (action.kind === "mark_skill_stale") state.lifecycleState = "stale";
    if (action.kind === "mark_review_required") state.evidenceState = "review_required";
  }
  return [...byId.values()].map((record) => ({
    id: record.id,
    version: Number(record.version),
    contentHash: record.content_hash,
    evidenceState: record.evidence_state,
    lifecycleState: record.lifecycle_state,
    expectedEvidenceState: after.get(record.id)!.evidenceState,
    expectedLifecycleState: after.get(record.id)!.lifecycleState
  }));
}

function isSemanticEligible(resource: CuratorResourceRow): boolean {
  return resource.ai_managed === true
    && resource.creation_source === "ai"
    && resource.ai_protection === "editable"
    && resource.lifecycle_state !== "archived"
    && (resource.resource_kind === "knowledge" || resource.resource_kind === "skill");
}

async function trimSnapshots(sql: WorkspaceSql, workspaceId: string, roomId: string, limit: number): Promise<void> {
  await sql.query(
    `DELETE FROM workspace_completion_curator_snapshots
     WHERE workspace_id = $1 AND room_id = $2 AND id IN (
       SELECT id FROM workspace_completion_curator_snapshots
       WHERE workspace_id = $1 AND room_id = $2 ORDER BY created_at DESC OFFSET $3
     )`,
    [workspaceId, roomId, limit]
  );
}

async function assertCuratorAuthority(sql: WorkspaceSql, context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId" | "caller">, roomId: string, role: "execute" | "manage"): Promise<void> {
  const allowed = await sql.query<{ allowed: boolean }>(
    "SELECT samurai_workspace_is_writable($1) AND samurai_can_room($1, $2, $3) AS allowed",
    [context.workspaceId, roomId, role]
  );
  if (allowed.rows[0]?.allowed !== true) throw new WorkspaceServerError("workspace_completion_curator_access_denied", 403);
}

function snapshotResources(value: unknown): CuratorRollbackSnapshotResource[] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const resources = (value as Record<string, unknown>).resources;
  if (!Array.isArray(resources)) return undefined;
  const parsed = resources.filter((resource): resource is Record<string, unknown> => Boolean(resource) && typeof resource === "object" && !Array.isArray(resource)).map((resource) => ({
    id: typeof resource.id === "string" ? resource.id : "",
    version: typeof resource.version === "number" ? resource.version : NaN,
    contentHash: typeof resource.contentHash === "string" ? resource.contentHash : "",
    evidenceState: resource.evidenceState,
    lifecycleState: resource.lifecycleState,
    expectedEvidenceState: resource.expectedEvidenceState,
    expectedLifecycleState: resource.expectedLifecycleState
  }));
  if (parsed.length !== resources.length || parsed.some((resource) => !resource.id || !Number.isSafeInteger(resource.version)
    || !/^[a-f0-9]{64}$/.test(resource.contentHash)
    || !isEvidenceState(resource.evidenceState) || !isLifecycleState(resource.lifecycleState)
    || !isEvidenceState(resource.expectedEvidenceState) || !isLifecycleState(resource.expectedLifecycleState))) return undefined;
  return parsed as CuratorRollbackSnapshotResource[];
}

function isEvidenceState(value: unknown): value is CuratorRollbackSnapshotResource["evidenceState"] {
  return value === "provisional" || value === "confirmed" || value === "contradicted" || value === "review_required";
}

function isLifecycleState(value: unknown): value is CuratorRollbackSnapshotResource["lifecycleState"] {
  return value === "active" || value === "stale" || value === "archived";
}

function completionId(prefix: string, workspaceId: string, input: string): string {
  return `${prefix}_${createHash("sha256").update(`${workspaceId}:${input}`).digest("hex").slice(0, 40)}`;
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function daysSince(value: Date | string): number {
  return (Date.now() - new Date(value).getTime()) / 86_400_000;
}
