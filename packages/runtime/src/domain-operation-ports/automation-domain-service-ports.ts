import type { DomainOperationPorts } from "@samurai-agent/domain-operations";
import type { RuntimeDomainServices } from "../domain-operation-services.js";

type Ports = Pick<DomainOperationPorts, "automation.job.release_lock" | "automation.job.requeue" | "automation.job.run" | "automation.job.save" | "automation.job.set_status" | "automation.memory_review.run">;

export function createAutomationDomainServicePorts(services: Pick<RuntimeDomainServices, "automationDomainService">): Ports {
  return {
    "automation.job.release_lock": {
      releaseAutomationJobLock: (jobId, now) => services.automationDomainService.releaseLock(jobId, now),
      automationJobNotFoundError: () => services.automationDomainService.notFoundError()
    },
    "automation.job.requeue": {
      requeueAutomationJob: (jobId, nextRunAt) => services.automationDomainService.requeue(jobId, nextRunAt),
      automationJobNotFoundError: () => services.automationDomainService.notFoundError()
    },
    "automation.job.run": {
      getAutomationJob: (id) => services.automationDomainService.getJob(id),
      acquireAutomationJobLock: (id, input) => services.automationDomainService.acquireAutomationJobLock(id, input),
      automationExecutionError: (code, message) => services.automationDomainService.jobError(code, message),
      createAutomationRun: (input) => services.automationDomainService.createExecutionRun(input),
      updateAutomationRun: (record) => services.automationDomainService.updateExecutionRun(record),
      ensureScheduledAutomationSession: (context, title) => services.automationDomainService.ensureExecutionSession(context, title),
      createScheduledAutomationEnvelope: (context, content) => services.automationDomainService.createExecutionEnvelope(context, content),
      runScheduledAutomationMutation: (input) => services.automationDomainService.runExecutionMutation(input),
      automationJobRef: (job) => services.automationDomainService.jobRef(job),
      saveAutomationJobRecord: (job) => services.automationDomainService.saveJobRecord(job),
      reindexAutomationWiki: () => services.automationDomainService.reindexAutomationWiki(),
      runAutomationCurator: () => services.automationDomainService.runAutomationCurator(),
      runAutomationMemoryReview: (session) => services.automationDomainService.runAutomationMemoryReview(session),
      runAutomationEvaluation: () => services.automationDomainService.runAutomationEvaluation(),
      runAutomationTranslation: (job, session, context) => services.automationDomainService.runAutomationTranslation(job, session, context),
      runAutomationCollectionTrigger: (job) => services.automationDomainService.runAutomationCollectionTrigger(job),
      runAutomationInstruction: (job, session, context) => services.automationDomainService.runAutomationInstruction(job, session, context),
      automationErrorMessage: (error) => services.automationDomainService.executionErrorMessage(error),
      automationRetryAt: (failureCount) => services.automationDomainService.automationRetryAt(failureCount)
    },
    "automation.job.save": {
      automationJobContract: (id) => services.automationDomainService.jobContract(id), ensureAutomationSession: () => services.automationDomainService.ensureMutationSession(),
      createAutomationEnvelope: (content) => services.automationDomainService.createMutationEnvelope(content), getAutomationJob: (id) => services.automationDomainService.getJob(id),
      saveAutomationJobRecord: (job) => services.automationDomainService.saveJobRecord(job), automationJobRef: (job) => services.automationDomainService.jobRef(job),
      createAutomationRollback: (operation, refs, before, after) => services.automationDomainService.createJobRollback(operation, refs, before, after),
      runAutomationJobMutation: (input) => services.automationDomainService.runJobMutation(input), automationJobError: (code, message) => services.automationDomainService.jobError(code, message)
    },
    "automation.job.set_status": {
      automationJobContract: (id) => services.automationDomainService.jobContract(id), ensureAutomationSession: () => services.automationDomainService.ensureMutationSession(),
      createAutomationEnvelope: (content) => services.automationDomainService.createMutationEnvelope(content), getAutomationJob: (id) => services.automationDomainService.getJob(id),
      saveAutomationJobRecord: (job) => services.automationDomainService.saveJobRecord(job), automationJobRef: (job) => services.automationDomainService.jobRef(job),
      createAutomationRollback: (operation, refs, before, after) => services.automationDomainService.createJobRollback(operation, refs, before, after),
      runAutomationJobMutation: (input) => services.automationDomainService.runJobMutation(input), automationJobError: (code, message) => services.automationDomainService.jobError(code, message)
    },
    "automation.memory_review.run": {
      createAutomationRun: (input) => services.automationDomainService.createExecutionRun(input),
      updateAutomationRun: (record) => services.automationDomainService.updateExecutionRun(record),
      ensureScheduledAutomationSession: (context, title) => services.automationDomainService.ensureExecutionSession(context, title),
      createScheduledAutomationEnvelope: (context, content) => services.automationDomainService.createExecutionEnvelope(context, content),
      runScheduledAutomationMutation: (input) => services.automationDomainService.runExecutionMutation(input),
      runScheduledMemoryReview: (session) => services.automationDomainService.runExecutionMemoryReview(session),
      automationErrorMessage: (error) => services.automationDomainService.executionErrorMessage(error)
    }
  };
}
