import {
  ActivityProcessorInputSchema,
  ActivityProcessorResultSchema,
  stableStringify,
  type ActivityRecord,
  type ActivityProcessorInput,
  type ActivityProcessorResourceVersion,
  type ResourceUsageRecord,
  type WorkspaceJobAttemptRecord,
  type WorkspaceJobRecord
} from "@samurai-agent/core-schemas";
import type { ActivityProcessorPort } from "./activity-processor-port";
import { ActivityProcessorRegistry } from "./activity-processor-port";

interface WorkspaceJobStore {
  claimWorkspaceJob(input: { workerId: string; leaseMs: number; now: string }): Promise<{ job: WorkspaceJobRecord; attempt: WorkspaceJobAttemptRecord } | undefined>;
  prepareWorkspaceJobAttempt(input: {
    workspaceJobId: string;
    attemptId: string;
    workerId: string;
    processorInput: ActivityProcessorInput;
    promptOrPolicyVersion?: string;
    now: string;
  }): Promise<WorkspaceJobAttemptRecord | undefined>;
  heartbeatWorkspaceJob(input: { workspaceJobId: string; attemptId: string; workerId: string; leaseMs: number; now: string }): Promise<WorkspaceJobRecord | undefined>;
  isWorkspaceJobCancellationRequested(input: { workspaceJobId: string; workerId: string }): Promise<boolean>;
  completeWorkspaceJob(input: {
    workspaceJobId: string;
    attemptId: string;
    workerId: string;
    result: {
      outputSchemaVersion: string;
      output: Record<string, import("@samurai-agent/core-schemas").JsonValue>;
      summary: string;
      diagnostics: Array<{ code: string; summary: string }>;
      model?: import("@samurai-agent/core-schemas").ActivityProcessorModelInfo;
    };
    now: string;
  }): Promise<WorkspaceJobRecord | undefined>;
  failWorkspaceJob(input: {
    workspaceJobId: string;
    attemptId: string;
    workerId: string;
    errorCode: string;
    retryable: boolean;
    now: string;
  }): Promise<WorkspaceJobRecord | undefined>;
  requestWorkspaceJobCancel(input: { workspaceJobId: string; now: string }): Promise<WorkspaceJobRecord | undefined>;
  getActivity(id: string): Promise<ActivityRecord | undefined>;
  listResourceUsage(input: { activityId: string; workspaceJobAttemptId?: string }): Promise<ResourceUsageRecord[]>;
}

export interface WorkspaceJobWorkerResult {
  job: WorkspaceJobRecord;
  attemptId: string;
}

type JobWorkerTimer = ReturnType<typeof setInterval>;

export interface WorkspaceJobWorkerScheduler {
  setInterval(callback: () => void | Promise<void>, delayMs: number): JobWorkerTimer;
  clearInterval(timer: JobWorkerTimer): void;
}

const systemScheduler: WorkspaceJobWorkerScheduler = {
  setInterval: (callback, delayMs) => setInterval(callback, delayMs),
  clearInterval: (timer) => clearInterval(timer)
};

/** Runs exactly one durable Activity job; it has no Workspace write capability. */
export class WorkspaceJobWorker {
  private readonly activeControllers = new Map<string, AbortController>();

  constructor(
    private readonly store: WorkspaceJobStore,
    private readonly processors: ActivityProcessorRegistry,
    private readonly workerId: string,
    private readonly clock: () => string,
    private readonly scheduler: WorkspaceJobWorkerScheduler = systemScheduler
  ) {}

  async runNext(input: { leaseMs: number; heartbeatMs?: number }): Promise<WorkspaceJobWorkerResult | undefined> {
    const heartbeatMs = input.heartbeatMs ?? Math.max(1, Math.floor(input.leaseMs / 3));
    if (heartbeatMs <= 0 || heartbeatMs >= input.leaseMs) throw new Error("workspace_job_heartbeat_duration_invalid");
    const claim = await this.store.claimWorkspaceJob({ workerId: this.workerId, leaseMs: input.leaseMs, now: this.clock() });
    if (!claim) return undefined;
    const controller = new AbortController();
    this.activeControllers.set(claim.job.id, controller);
    let leaseLost = false;
    let cancelRequested = false;
    let heartbeatInFlight: Promise<void> | undefined;
    const heartbeat = async (): Promise<void> => {
      if (heartbeatInFlight || leaseLost) {
        if (heartbeatInFlight) await heartbeatInFlight;
        return;
      }
      heartbeatInFlight = this.store.heartbeatWorkspaceJob({
        workspaceJobId: claim.job.id,
        attemptId: claim.attempt.id,
        workerId: this.workerId,
        leaseMs: input.leaseMs,
        now: this.clock()
      }).then((job) => {
        if (!job) {
          leaseLost = true;
          controller.abort();
        } else if (job.cancel_requested_at) {
          cancelRequested = true;
          controller.abort();
        }
      }).catch(() => {
        leaseLost = true;
        controller.abort();
      }).finally(() => {
        heartbeatInFlight = undefined;
      });
      await heartbeatInFlight;
    };
    let timer: JobWorkerTimer | undefined;
    try {
      timer = this.scheduler.setInterval(heartbeat, heartbeatMs);
      const activity = await this.store.getActivity(claim.job.root_activity_id);
      if (!activity || activity.status === "recording") {
        return this.finishFailure(claim, "activity_not_finalized", false);
      }
      // A prior Job's own observation is not part of the original Activity
      // evidence and must not recursively become input to a reprocessing run.
      const resourceUsage = (await this.store.listResourceUsage({ activityId: activity.id }))
        .filter((usage) => !usage.workspace_job_attempt_id);
      const processorInput = ActivityProcessorInputSchema.parse({
        activity,
        resource_usage: resourceUsage,
        resource_versions: resourceVersionsFor(resourceUsage),
        input_schema_version: "activity_processor.input/v1"
      });
      const processor = this.processors.get(claim.job.processor_id, claim.job.processor_version);
      if (!processor) return this.finishFailure(claim, "activity_processor_not_registered", false);
      const prepared = await this.store.prepareWorkspaceJobAttempt({
        workspaceJobId: claim.job.id,
        attemptId: claim.attempt.id,
        workerId: this.workerId,
        processorInput,
        ...(processor.promptOrPolicyVersion ? { promptOrPolicyVersion: processor.promptOrPolicyVersion } : {}),
        now: this.clock()
      });
      if (!prepared) return undefined;
      if (cancelRequested || await this.store.isWorkspaceJobCancellationRequested({ workspaceJobId: claim.job.id, workerId: this.workerId })) {
        controller.abort();
        return this.finishFailure(claim, "workspace_job_cancelled", false);
      }
      const result = await processor.process(processorInput, { cancelSignal: controller.signal });
      if (heartbeatInFlight) await heartbeatInFlight;
      if (leaseLost) return undefined;
      const parsed = ActivityProcessorResultSchema.parse(result);
      if (parsed.processor_id !== processor.id || parsed.processor_version !== processor.version) {
        return this.finishFailure(claim, "activity_processor_result_invalid", false);
      }
      if (cancelRequested || controller.signal.aborted || await this.store.isWorkspaceJobCancellationRequested({ workspaceJobId: claim.job.id, workerId: this.workerId })) {
        return this.finishFailure(claim, "workspace_job_cancelled", false);
      }
      const job = await this.store.completeWorkspaceJob({
        workspaceJobId: claim.job.id,
        attemptId: claim.attempt.id,
        workerId: this.workerId,
        result: {
          outputSchemaVersion: parsed.output_schema_version,
          output: parsed.output,
          summary: parsed.summary,
          diagnostics: parsed.diagnostics,
          ...(parsed.model ? { model: parsed.model } : {})
        },
        now: this.clock()
      });
      return job ? { job, attemptId: claim.attempt.id } : undefined;
    } catch (error) {
      const code = cancelRequested || controller.signal.aborted || (error instanceof Error && error.message === "workspace_job_cancelled")
        ? "workspace_job_cancelled"
        : "activity_processor_failed";
      return this.finishFailure(claim, code, code !== "workspace_job_cancelled");
    } finally {
      if (timer !== undefined) this.scheduler.clearInterval(timer);
      if (heartbeatInFlight) await heartbeatInFlight;
      this.activeControllers.delete(claim.job.id);
    }
  }

  async requestCancel(workspaceJobId: string): Promise<WorkspaceJobRecord | undefined> {
    const job = await this.store.requestWorkspaceJobCancel({ workspaceJobId, now: this.clock() });
    this.activeControllers.get(workspaceJobId)?.abort();
    return job;
  }

  private async finishFailure(
    claim: { job: WorkspaceJobRecord; attempt: { id: string } },
    errorCode: string,
    retryable: boolean
  ): Promise<WorkspaceJobWorkerResult | undefined> {
    const job = await this.store.failWorkspaceJob({
      workspaceJobId: claim.job.id,
      attemptId: claim.attempt.id,
      workerId: this.workerId,
      errorCode,
      retryable,
      now: this.clock()
    });
    return job ? { job, attemptId: claim.attempt.id } : undefined;
  }
}

function resourceVersionsFor(input: ActivityProcessorInput["resource_usage"]): ActivityProcessorResourceVersion[] {
  const unique = new Map<string, ActivityProcessorResourceVersion>();
  for (const usage of input) {
    const value: ActivityProcessorResourceVersion = {
      resource_ref: usage.resource_ref,
      ...(usage.resource_version ? { resource_version: usage.resource_version } : {}),
      ...(usage.content_hash ? { content_hash: usage.content_hash } : {})
    };
    unique.set(stableStringify(value), value);
  }
  return [...unique.values()];
}
