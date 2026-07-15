import { skillOptimizationStartValueSchema, type DomainOperationPorts } from "@samurai-agent/domain-operations";
import type { RuntimeDomainServices } from "../domain-operation-services.js";

type Ports = Pick<DomainOperationPorts, "skill.candidate.create" | "skill.lifecycle.apply" | "skill.optimization.cancel" | "skill.optimization.promote" | "skill.optimization.reject" | "skill.optimization.rollback" | "skill.optimization.start" | "skill.patch" | "skill.project.save" | "skill.support_file.save" | "skill.usage.record" | "skill.view">;

export function createSkillDomainServicePorts(services: Pick<RuntimeDomainServices, "skillDomainService">): Ports {
  return {
    "skill.candidate.create": {
      executeSkillCandidateCreate: async (context, input) => ({
        ok: true as const,
        value: await services.skillDomainService.createCandidate(input)
      })
    },
    "skill.lifecycle.apply": {
      executeSkillLifecycleApply: async (context, input) => ({
        ok: true as const,
        value: await services.skillDomainService.applyLifecycle(input)
      })
    },
    "skill.optimization.cancel": {
      executeSkillOptimizationCancel: async (context, input) => ({
        ok: true as const,
        value: await services.skillDomainService.cancelOptimization(input)
      })
    },
    "skill.optimization.promote": {
      executeSkillOptimizationPromote: async (context, input) => ({
        ok: true as const,
        value: await services.skillDomainService.promoteOptimization(input)
      })
    },
    "skill.optimization.reject": {
      executeSkillOptimizationReject: async (context, input) => ({
        ok: true as const,
        value: await services.skillDomainService.rejectOptimization(input)
      })
    },
    "skill.optimization.rollback": {
      executeSkillOptimizationRollback: async (context, input) => ({
        ok: true as const,
        value: await services.skillDomainService.rollbackOptimization(input)
      })
    },
    "skill.optimization.start": {
      executeSkillOptimizationStart: async (context, input) => ({
        ok: true as const,
        value: skillOptimizationStartValueSchema.parse(await services.skillDomainService.startOptimization(input))
      })
    },
    "skill.patch": {
      executeSkillPatch: async (context, input) => ({
        ok: true as const,
        value: await services.skillDomainService.patch(input)
      })
    },
    "skill.project.save": {
      executeSkillProjectSave: async (context, input) => ({
        ok: true as const,
        value: await services.skillDomainService.saveProject(input)
      })
    },
    "skill.support_file.save": {
      executeSkillSupportFileSave: async (context, input) => ({
        ok: true as const,
        value: await services.skillDomainService.saveSupportFile(input)
      })
    },
    "skill.usage.record": {
      executeSkillUsageRecord: async (context, input) => ({
        ok: true as const,
        value: await services.skillDomainService.recordUsage(input)
      })
    },
    "skill.view": {
      executeSkillView: async (context, input) => ({
        ok: true as const,
        value: await services.skillDomainService.view(input)
      })
    }
  };
}

