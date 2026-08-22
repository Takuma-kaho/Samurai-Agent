import { createHash } from "node:crypto";
import { createInternalWorkspaceMaintenanceCaller, isTrustedWorkspaceCallerForAccount } from "./auth";
import { assertOpaqueId } from "./config";
import { WorkspaceServerError } from "./errors";
import type { WorkspaceRequestContext } from "./types";
import { WorkspaceCompletionCuratorService, type WorkspaceCompletionSemanticCuratorPort } from "./workspace-completion-curator";
import { WorkspaceCompletionJobService, type WorkspaceCompletionJobRunResult, type WorkspaceCompletionReviewPort } from "./workspace-completion-jobs";
import { WorkspaceCompletionService } from "./workspace-completion-service";

const defaultMaxRuns = 100;
const maxRoomsPerTick = 1_000;

export interface WorkspaceCompletionMaintenanceTickResult {
  recoveredJobs: number;
  blockedReviewJobs: number;
  recoveredFileBatches: number;
  purgedRawOutputs: number;
  queuedEvaluationCatchup: number;
  queuedCuratorJobs: number;
  skippedSemanticRooms: number;
  runs: readonly WorkspaceCompletionJobRunResult[];
}

export interface WorkspaceCompletionMaintenanceIdentity {
  workspaceId: string;
  accountId: string;
}

/** A short-lived, PostgreSQL/RLS-scoped scheduler. A host invokes one tick
 * per Workspace with its configured maintenance Account; it never obtains a
 * browser Session, an owner Account, or an unrestricted database connection. */
export class WorkspaceCompletionMaintenanceService {
  constructor(
    readonly completion: WorkspaceCompletionService,
    readonly jobs: WorkspaceCompletionJobService,
    readonly curator: WorkspaceCompletionCuratorService
  ) {}

  /**
   * Hosted Worker composition needs a tenant list before it can construct an
   * RLS-scoped maintenance context. PostgreSQL returns only identities that a
   * Workspace owner explicitly configured; the worker never treats an owner
   * account or an HTTP caller as a fallback identity.
   */
  async listConfiguredIdentities(): Promise<WorkspaceCompletionMaintenanceIdentity[]> {
    return this.completion.store.database.withContext({
      accountId: "workspace-worker",
      worker: true
    }, async (sql) => {
      const result = await sql.query<{ workspace_id: string; account_id: string }>(
        "SELECT workspace_id, account_id FROM samurai_list_completion_maintenance_identities()"
      );
      return result.rows.map((row) => ({ workspaceId: row.workspace_id, accountId: row.account_id }));
    });
  }

  async configureIdentity(context: WorkspaceRequestContext, input: { accountId: string }): Promise<{ accountId: string; replayed: boolean }> {
    assertOpaqueId(input.accountId, "workspace_completion_maintenance_account_id_invalid");
    const saved = await this.completion.store.runIdempotentResult(context, {
      action: "workspace.completion.maintenance.configure",
      input
    }, async (sql) => {
      const owner = await sql.query<{ allowed: boolean }>("SELECT samurai_can_workspace($1, 'owner') AS allowed", [context.workspaceId]);
      if (owner.rows[0]?.allowed !== true) throw new WorkspaceServerError("workspace_completion_maintenance_owner_required", 403);
      await sql.query("SELECT samurai_configure_completion_maintenance_identity($1, $2)", [context.workspaceId, input.accountId]);
      await this.completion.store.insertAudit(sql, context, {
        action: "workspace.completion.maintenance.configure",
        subjectKind: "completion_maintenance_identity",
        subjectId: input.accountId
      });
      return { accountId: input.accountId };
    });
    return { accountId: saved.value.accountId, replayed: saved.replayed };
  }

  async getIdentity(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">): Promise<{ accountId?: string }> {
    return this.completion.store.database.withContext(context, async (sql) => {
      const owner = await sql.query<{ allowed: boolean }>("SELECT samurai_can_workspace($1, 'owner') AS allowed", [context.workspaceId]);
      if (owner.rows[0]?.allowed !== true) throw new WorkspaceServerError("workspace_completion_maintenance_owner_required", 403);
      const identity = await sql.query<{ account_id: string }>(
        "SELECT account_id FROM workspace_completion_maintenance_identities WHERE workspace_id = $1",
        [context.workspaceId]
      );
      return identity.rows[0] ? { accountId: identity.rows[0].account_id } : {};
    });
  }

  async runTick(
    context: WorkspaceRequestContext,
    input: {
      workerId: string;
      /** A Host injects this narrow cassette when review execution is enabled.
       * The scheduler never constructs an external AI client by itself. */
      reviewPort?: WorkspaceCompletionReviewPort;
      semanticPort?: WorkspaceCompletionSemanticCuratorPort;
      maxRuns?: number;
    }
  ): Promise<WorkspaceCompletionMaintenanceTickResult> {
    assertOpaqueId(input.workerId, "workspace_completion_worker_id_invalid");
    const maxRuns = input.maxRuns ?? defaultMaxRuns;
    if (!Number.isSafeInteger(maxRuns) || maxRuns < 1 || maxRuns > defaultMaxRuns) throw new WorkspaceServerError("workspace_completion_maintenance_run_limit_invalid", 400);
    await this.assertMaintenanceIdentity(context);
    // The DB identity check comes first. From here, every policy evaluation
    // receives a trusted maintenance caller rather than an anonymous worker.
    const maintenanceContext: WorkspaceRequestContext = {
      ...context,
      caller: createInternalWorkspaceMaintenanceCaller({
        principalAccountId: context.accountId,
        operationId: context.operationId
      })
    };
    const recovery = await this.completion.recoverFileBatches(maintenanceContext);
    if (recovery.failed.length > 0) throw new WorkspaceServerError("workspace_completion_file_recovery_required", 503, { failed_batch_ids: recovery.failed });
    const recoveredJobs = await this.jobs.recover(maintenanceContext);
    const blockedReviewJobs = input.reviewPort
      ? 0
      : await this.jobs.blockQueuedReviewsWithoutPort(maintenanceContext, { limit: maxRuns });
    const purgedRawOutputs = await this.completion.purgeExpiredRawJobOutputs(withOperation(maintenanceContext, "retention"), { limit: 100 });
    const queuedEvaluationCatchup = await this.completion.enqueueEvaluationCatchup(withOperation(maintenanceContext, "evaluation-catchup"), { limit: 100 });
    const rooms = await this.readExecutableRooms(maintenanceContext);
    let queuedCuratorJobs = 0;
    let skippedSemanticRooms = 0;
    for (const roomId of rooms) {
      const lightHash = await this.curator.inputHash(maintenanceContext, { roomId, mode: "light" });
      const light = await this.jobs.enqueueCurator(withOperation(maintenanceContext, `curator-light:${roomId}:${lightHash.slice(0, 12)}`), {
        roomId, mode: "light", inputHash: lightHash
      });
      if (light.status === "queued") queuedCuratorJobs += 1;
      const status = await this.curator.getStatus(maintenanceContext, roomId);
      if (!status.semanticEnabled) continue;
      if (!input.semanticPort) {
        skippedSemanticRooms += 1;
        continue;
      }
      const semanticHash = await this.curator.inputHash(maintenanceContext, { roomId, mode: "semantic" });
      const semantic = await this.jobs.enqueueCurator(withOperation(maintenanceContext, `curator-semantic:${roomId}:${semanticHash.slice(0, 12)}`), {
        roomId, mode: "semantic", inputHash: semanticHash
      });
      if (semantic.status === "queued") queuedCuratorJobs += 1;
    }
    const runs: WorkspaceCompletionJobRunResult[] = [];
    for (let index = 0; index < maxRuns; index += 1) {
      if (input.reviewPort) {
        const review = await this.jobs.runOneReview(maintenanceContext, { workerId: input.workerId, port: input.reviewPort });
        if (review.status !== "idle") {
          runs.push(review);
          continue;
        }
      }
      const evaluation = await this.jobs.runOneEvaluation(maintenanceContext, { workerId: input.workerId });
      if (evaluation.status !== "idle") {
        runs.push(evaluation);
        continue;
      }
      const curator = await this.jobs.runOneCurator(maintenanceContext, { workerId: input.workerId, curator: this.curator, ...(input.semanticPort ? { semanticPort: input.semanticPort } : {}) });
      if (curator.status === "idle") break;
      runs.push(curator);
    }
    return {
      recoveredJobs,
      blockedReviewJobs,
      recoveredFileBatches: recovery.recovered.length,
      purgedRawOutputs,
      queuedEvaluationCatchup,
      queuedCuratorJobs,
      skippedSemanticRooms,
      runs
    };
  }

  private async assertMaintenanceIdentity(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">): Promise<void> {
    await this.completion.store.database.withContext(context, async (sql) => {
      const result = await sql.query<{ allowed: boolean }>("SELECT samurai_is_completion_maintenance_identity($1) AS allowed", [context.workspaceId]);
      if (result.rows[0]?.allowed !== true) throw new WorkspaceServerError("workspace_completion_maintenance_identity_required", 403);
    });
  }

  private async readExecutableRooms(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">): Promise<string[]> {
    return this.completion.store.database.withContext(context, async (sql) => {
      const rooms = await sql.query<{ id: string }>(
        `SELECT id FROM rooms
         WHERE workspace_id = $1 AND samurai_can_room(workspace_id, id, 'execute')
         ORDER BY created_at ASC, id ASC LIMIT $2`,
        [context.workspaceId, maxRoomsPerTick]
      );
      return rooms.rows.map((room) => room.id);
    });
  }
}

function withOperation(context: WorkspaceRequestContext, suffix: string): WorkspaceRequestContext {
  const digest = createHash("sha256").update(`${context.workspaceId}:${context.operationId}:${suffix}`).digest("hex").slice(0, 40);
  const operationId = `completion_maintenance_${digest}`;
  return {
    ...context,
    operationId,
    ...(isTrustedWorkspaceCallerForAccount(context.caller, context.accountId) && context.caller.kind === "maintenance" ? {
      caller: createInternalWorkspaceMaintenanceCaller({ principalAccountId: context.accountId, operationId })
    } : {})
  };
}
