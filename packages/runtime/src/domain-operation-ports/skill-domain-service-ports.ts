import { skillOptimizationStartValueSchema, type DomainOperationPorts } from "@samurai-agent/domain-operations";
import type { RuntimeDomainServices } from "../domain-operation-services.js";
import { readOnlyQueryPort } from "./read-only-query-port.js";

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
      applySkillLifecycle: (input) => services.skillDomainService.applyLifecycle(input)
    },
    "skill.optimization.cancel": {
      cancelSkillOptimization: (input) => services.skillDomainService.cancelOptimization(input)
    },
    "skill.optimization.promote": {
      promoteSkillOptimization: (input) => services.skillDomainService.promoteOptimization(input)
    },
    "skill.optimization.reject": {
      rejectSkillOptimization: (input) => services.skillDomainService.rejectOptimization(input)
    },
    "skill.optimization.rollback": {
      rollbackSkillOptimization: (input) => services.skillDomainService.rollbackOptimization(input)
    },
    "skill.optimization.start": {
      startSkillOptimization: async (input) => skillOptimizationStartValueSchema.parse(await services.skillDomainService.startOptimization(input))
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
      recordSkillUsage: (input) => services.skillDomainService.recordUsage(input)
    },
    "skill.view": readOnlyQueryPort<Ports["skill.view"]>({
      viewSkill: (input) => services.skillDomainService.view(input)
    })
  };
}
