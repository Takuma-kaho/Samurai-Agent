import type { DomainOperationPorts } from "@samurai-agent/domain-operations";
import type { RuntimeDomainServices } from "../domain-operation-services.js";

type Ports = Pick<DomainOperationPorts, "automation.job.release_lock" | "automation.job.requeue" | "automation.job.run" | "automation.job.save" | "automation.job.set_status" | "automation.job.rebind_authority" | "automation.job.manager_stop" | "automation.job.manager_resume" | "automation.job.reauthorize" | "automation.memory_review.run">;

export function createAutomationDomainServicePorts(services: Pick<RuntimeDomainServices, "automationDomainService" | "core09AutomationDomainService">): Ports {
  return {
    "automation.job.release_lock": {
      releaseAutomationJobLock: (jobId, lockOwnerToken, now) => services.automationDomainService.releaseLock(jobId, lockOwnerToken, now),
      automationJobNotFoundError: () => services.automationDomainService.notFoundError()
    },
    "automation.job.requeue": {
      requeueAutomationJob: (jobId, nextRunAt) => services.automationDomainService.requeue(jobId, nextRunAt),
      automationJobNotFoundError: () => services.automationDomainService.notFoundError()
    },
    "automation.job.run": {
      runSessionlessAutomationJob: (input) => services.core09AutomationDomainService.run(input)
    },
    "automation.job.save": {
      saveSessionlessAutomationJob: (input) => services.core09AutomationDomainService.save(input)
    },
    "automation.job.set_status": {
      setSessionlessAutomationJobStatus: (input) => services.core09AutomationDomainService.setStatus(input)
    },
    "automation.job.rebind_authority": {
      rebindSessionlessAutomationJobAuthority: (input) => services.core09AutomationDomainService.rebind(input)
    },
    "automation.job.manager_stop": {
      managerStopSessionlessAutomationJob: (input) => services.core09AutomationDomainService.managerStop(input)
    },
    "automation.job.manager_resume": {
      managerResumeSessionlessAutomationJob: (input) => services.core09AutomationDomainService.managerResume(input)
    },
    "automation.job.reauthorize": {
      reauthorizeSessionlessAutomationJob: (input) => services.core09AutomationDomainService.reauthorize(input)
    },
    "automation.memory_review.run": {
      runSessionlessMemoryReview: () => services.core09AutomationDomainService.runSessionlessMemoryReview()
    }
  };
}
