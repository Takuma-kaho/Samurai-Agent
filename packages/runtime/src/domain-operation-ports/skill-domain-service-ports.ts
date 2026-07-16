import { skillOptimizationStartValueSchema, type DomainOperationPorts } from "@samurai-agent/domain-operations";
import type { RuntimeDomainServices } from "../domain-operation-services.js";

type Ports = Pick<DomainOperationPorts, "skill.candidate.create" | "skill.lifecycle.apply" | "skill.optimization.cancel" | "skill.optimization.promote" | "skill.optimization.reject" | "skill.optimization.rollback" | "skill.optimization.start" | "skill.patch" | "skill.project.save" | "skill.support_file.save" | "skill.usage.record" | "skill.view">;

export function createSkillDomainServicePorts(services: Pick<RuntimeDomainServices, "skillDomainService">): Ports {
  return {
    "skill.candidate.create": {
      saveSkillMarkdown: (input) => services.skillDomainService.saveSkillMarkdown(input),
      skillMutationContract: (id) => services.skillDomainService.skillMutationContract(id),
      ensureSkillMutationSession: () => services.skillDomainService.ensureSkillMutationSession(),
      createSkillMutationEnvelope: (content) => services.skillDomainService.createSkillMutationEnvelope(content),
      skillResourceRef: (skill) => services.skillDomainService.skillResourceRef(skill),
      createSkillRollback: (operation, refs, before, after) => services.skillDomainService.createSkillRollback(operation, refs, before, after),
      runSkillMutation: (input) => services.skillDomainService.runSkillMutation(input),
      skillMutationNotFound: (message) => services.skillDomainService.skillMutationNotFound(message),
      skillMutationConflict: (message) => services.skillDomainService.skillMutationConflict(message)
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
      getSkillForMutation: (id) => services.skillDomainService.getSkillForMutation(id),
      readSkillMarkdown: (id) => services.skillDomainService.readSkillMarkdown(id),
      patchSkillRecord: (input) => services.skillDomainService.patchSkillRecord(input),
      skillMutationContract: (id) => services.skillDomainService.skillMutationContract(id),
      ensureSkillMutationSession: () => services.skillDomainService.ensureSkillMutationSession(),
      createSkillMutationEnvelope: (content) => services.skillDomainService.createSkillMutationEnvelope(content),
      skillResourceRef: (skill) => services.skillDomainService.skillResourceRef(skill),
      createSkillRollback: (operation, refs, before, after) => services.skillDomainService.createSkillRollback(operation, refs, before, after),
      runSkillMutation: (input) => services.skillDomainService.runSkillMutation(input),
      skillMutationNotFound: (message) => services.skillDomainService.skillMutationNotFound(message),
      skillMutationConflict: (message) => services.skillDomainService.skillMutationConflict(message)
    },
    "skill.project.save": {
      readSkillMarkdown: (id) => services.skillDomainService.readSkillMarkdown(id),
      saveSkillMarkdown: (input) => services.skillDomainService.saveSkillMarkdown(input),
      skillMutationContract: (id) => services.skillDomainService.skillMutationContract(id),
      ensureSkillMutationSession: () => services.skillDomainService.ensureSkillMutationSession(),
      createSkillMutationEnvelope: (content) => services.skillDomainService.createSkillMutationEnvelope(content),
      skillResourceRef: (skill) => services.skillDomainService.skillResourceRef(skill),
      createSkillRollback: (operation, refs, before, after) => services.skillDomainService.createSkillRollback(operation, refs, before, after),
      runSkillMutation: (input) => services.skillDomainService.runSkillMutation(input),
      skillMutationNotFound: (message) => services.skillDomainService.skillMutationNotFound(message),
      skillMutationConflict: (message) => services.skillDomainService.skillMutationConflict(message)
    },
    "skill.support_file.save": {
      getSkillForMutation: (id) => services.skillDomainService.getSkillForMutation(id),
      listSkillSupportFiles: (id) => services.skillDomainService.listSkillSupportFiles(id),
      writeSkillSupportFile: (input) => services.skillDomainService.writeSkillSupportFile(input),
      skillMutationContract: (id) => services.skillDomainService.skillMutationContract(id),
      ensureSkillMutationSession: () => services.skillDomainService.ensureSkillMutationSession(),
      createSkillMutationEnvelope: (content) => services.skillDomainService.createSkillMutationEnvelope(content),
      skillResourceRef: (skill) => services.skillDomainService.skillResourceRef(skill),
      createSkillRollback: (operation, refs, before, after) => services.skillDomainService.createSkillRollback(operation, refs, before, after),
      runSkillMutation: (input) => services.skillDomainService.runSkillMutation(input),
      skillMutationNotFound: (message) => services.skillDomainService.skillMutationNotFound(message),
      skillMutationConflict: (message) => services.skillDomainService.skillMutationConflict(message)
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
