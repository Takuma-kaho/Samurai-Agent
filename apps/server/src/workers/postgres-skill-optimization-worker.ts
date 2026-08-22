import { nowIso, type ObjectiveRecord } from "@samurai-agent/core-schemas";
import {
  PostgresSkillDomainOperations
} from "../adapters/runtime/postgres-skill-domain-operation";
import { PostgresSkillOptimization, type PostgresCompletionService, type PostgresSkillOptimizationOptions } from "../adapters/runtime/postgres-skill-optimization";
import type { WorkspaceRequestContext } from "@samurai-agent/workspace-server";
import type { WorkspaceSkillOptimizationWorkerPort } from "./workspace-worker-supervisor";

export interface PostgresSkillOptimizationWorkerOptions {
  database: PostgresSkillOptimizationOptions["database"];
  completion: PostgresCompletionService;
  repoRoot: string;
  hostComplete?: PostgresSkillOptimizationOptions["hostComplete"];
}

/**
 * Claims durable Skill optimization work from PostgreSQL and executes it
 * through the shared Runtime SkillDomainService. The HTTP request only
 * creates the queued records; this process-owned lane owns execution and
 * settlement after a restart.
 */
export class PostgresSkillOptimizationWorker implements WorkspaceSkillOptimizationWorkerPort {
  constructor(private readonly options: PostgresSkillOptimizationWorkerOptions) {}

  async runTick(
    context: WorkspaceRequestContext,
    input: { workerId: string; maxRuns: number; signal: AbortSignal }
  ): Promise<{ claimed: number; completed: number; failed: number }> {
    if (input.signal.aborted) return { claimed: 0, completed: 0, failed: 0 };
    const operations = new PostgresSkillDomainOperations({
      database: this.options.database,
      completion: this.options.completion,
      workspaceId: context.workspaceId,
      accountId: context.accountId,
      repoRoot: this.options.repoRoot,
      ...(this.options.hostComplete ? { hostComplete: this.options.hostComplete } : {}),
      autoStartOptimization: false
    });
    const workerId = `${input.workerId}:skill-optimization`;
    let claimedCount = 0;
    let completedCount = 0;
    let failedCount = 0;
    for (let index = 0; index < input.maxRuns; index += 1) {
      if (input.signal.aborted) break;
      const claimed = await operations.adapter.claimWorkItem({ workerId, leaseMs: 24 * 60 * 60 * 1000, now: nowIso() });
      if (!claimed) break;
      claimedCount += 1;
      const run = await operations.adapter.findRunByWorkItem(claimed.id);
      const dataset = run ? await operations.adapter.getDataset(run.dataset_id) : undefined;
      const skill = run ? await operations.adapter.getSkill(run.target_skill_id) : undefined;
      const markdown = skill ? await operations.adapter.readMarkdown(skill.id) : undefined;
      if (!run || !dataset || !skill || markdown === undefined) {
        const error = !run ? "skill_optimization_run_for_work_item_not_found"
          : !dataset ? "skill_optimization_dataset_not_found"
            : !skill || markdown === undefined ? "skill_optimization_skill_not_found" : "skill_optimization_input_invalid";
        await this.failClaimed(operations.adapter, claimed.id, workerId, run, error);
        failedCount += 1;
        continue;
      }

      const runningRun = { ...run, status: "running" as const, phase: "optimizing" as const, progress: Math.max(0.1, run.progress), updated_at: nowIso() };
      await operations.adapter.saveRun(runningRun);
      try {
        await operations.runClaimedOptimization({
          run: runningRun,
          dataset,
          skillBody: markdown,
          skillId: skill.id,
          ...(runningRun.session_id ? { sessionId: runningRun.session_id } : {}),
          workerId,
          signal: input.signal
        });
        completedCount += 1;
      } catch (error) {
        await this.failClaimed(operations.adapter, claimed.id, workerId, runningRun, error instanceof Error ? error.message : String(error));
        failedCount += 1;
      }
    }
    return { claimed: claimedCount, completed: completedCount, failed: failedCount };
  }

  private async failClaimed(
    adapter: PostgresSkillOptimization,
    workItemId: string,
    workerId: string,
    run: Awaited<ReturnType<PostgresSkillOptimization["getRun"]>>,
    error: string
  ): Promise<void> {
    const now = nowIso();
    if (run && !["completed", "failed", "cancelled"].includes(run.status)) {
      await adapter.saveRun({ ...run, status: "failed", phase: "failed", progress: 1, error, updated_at: now, completed_at: now });
      const objective = await adapter.getObjective(run.objective_id);
      if (objective?.status === "active") {
        await adapter.updateObjective({ ...objective, status: "failed", updated_at: now, completed_at: now } satisfies ObjectiveRecord);
      }
      await adapter.releaseLock({ skillId: run.target_skill_id, runId: run.id });
    }
    await adapter.failWorkItem({ workItemId, workerId, failureKind: "non_retryable", error });
  }
}
