import type { DomainOperationPorts } from "@samurai-agent/domain-operations";
import type { RuntimeDomainServices } from "../domain-operation-services.js";

type Ports = Pick<DomainOperationPorts, "automation.job.release_lock" | "automation.job.requeue" | "automation.job.run" | "automation.job.save" | "automation.job.set_status" | "automation.memory_review.run">;

export function createAutomationDomainServicePorts(services: Pick<RuntimeDomainServices, "automationDomainService">): Ports {
  return {
    "automation.job.release_lock": {
      executeAutomationJobReleaseLock: async (context, input) => ({
        ok: true as const,
        value: await services.automationDomainService.releaseLock(input)
      })
    },
    "automation.job.requeue": {
      executeAutomationJobRequeue: async (context, input) => ({
        ok: true as const,
        value: await services.automationDomainService.requeue(input)
      })
    },
    "automation.job.run": {
      executeAutomationJobRun: async (context, input) => ({
        ok: true as const,
        value: await services.automationDomainService.run(input)
      })
    },
    "automation.job.save": {
      executeAutomationJobSave: async (context, input) => ({
        ok: true as const,
        value: await services.automationDomainService.save(input)
      })
    },
    "automation.job.set_status": {
      executeAutomationJobSetStatus: async (context, input) => ({
        ok: true as const,
        value: await services.automationDomainService.setStatus(input)
      })
    },
    "automation.memory_review.run": {
      executeAutomationMemoryReviewRun: async (context, input) => ({
        ok: true as const,
        value: await services.automationDomainService.runMemoryReview()
      })
    }
  };
}

