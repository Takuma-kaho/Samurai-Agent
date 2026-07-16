import type { DomainOperationPorts } from "@samurai-agent/domain-operations";
import type { RuntimeDomainServices } from "../domain-operation-services.js";

type Ports = Pick<DomainOperationPorts, "curator.pause" | "curator.restore" | "curator.resume" | "curator.run" | "curator.snapshot.create" | "evaluation.run" | "learning.snapshot.prune" | "curator.snapshot.list">;

export function createLearningDomainServicePorts(services: Pick<RuntimeDomainServices, "learningDomainService">): Ports {
  return {
    "curator.pause": {
      executeCuratorPause: async (context, input) => ({
        ok: true as const,
        value: await services.learningDomainService.pause()
      })
    },
    "curator.restore": {
      restoreCuratorSnapshot: (id) => services.learningDomainService.restoreLearningSnapshot(id),
      curatorSnapshotNotFoundError: () => services.learningDomainService.snapshotNotFoundError()
    },
    "curator.resume": {
      executeCuratorResume: async (context, input) => ({
        ok: true as const,
        value: await services.learningDomainService.resume()
      })
    },
    "curator.run": {
      executeCuratorRun: async (context, input) => ({
        ok: true as const,
        value: await services.learningDomainService.runCurator()
      })
    },
    "curator.snapshot.create": {
      executeCuratorSnapshotCreate: async (context, input) => ({
        ok: true as const,
        value: await services.learningDomainService.createSnapshot(input)
      })
    },
    "evaluation.run": {
      ensureEvaluationSession: () => services.learningDomainService.ensureEvaluationSession(),
      listEvaluationSkills: () => services.learningDomainService.listEvaluationSkills(),
      listEvaluationBackendRuns: () => services.learningDomainService.listEvaluationBackendRuns(),
      listEvaluationBackendEvents: () => services.learningDomainService.listEvaluationBackendEvents(),
      listEvaluationWorkspaceChanges: () => services.learningDomainService.listEvaluationWorkspaceChanges(),
      listEvaluationToolRuns: () => services.learningDomainService.listEvaluationToolRuns(),
      listEvaluationAuditRecords: () => services.learningDomainService.listEvaluationAuditRecords(),
      listLearningResourceUses: () => services.learningDomainService.listLearningResourceUses(),
      listExistingLearningEvaluations: () => services.learningDomainService.listExistingLearningEvaluations(),
      createEvaluationReflectionRun: (run) => services.learningDomainService.createEvaluationReflectionRun(run),
      updateEvaluationReflectionRun: (run) => services.learningDomainService.updateEvaluationReflectionRun(run),
      createEvaluationSuggestions: (run, input) => services.learningDomainService.createEvaluationSuggestions(run, input),
      createEvaluationReport: (input) => services.learningDomainService.createEvaluationReport(input),
      actualLearningUses: (records) => services.learningDomainService.actualLearningUses(records),
      evaluateLearningEffect: (input) => services.learningDomainService.evaluateLearningEffect(input),
      saveLearningEvaluation: (value) => services.learningDomainService.saveLearningEvaluation(value),
      saveEvaluationSuggestion: (value) => services.learningDomainService.saveEvaluationSuggestion(value),
      saveEvaluationJobReport: (value) => services.learningDomainService.saveEvaluationJobReport(value),
      nextEvaluationRunAt: (fromMs) => services.learningDomainService.nextEvaluationRunAt(fromMs),
      createEvaluationId: (prefix) => services.learningDomainService.createEvaluationId(prefix),
      evaluationNow: () => services.learningDomainService.evaluationNow()
    },
    "learning.snapshot.prune": {
      executeLearningSnapshotPrune: async (context, input) => ({
        ok: true as const,
        value: await services.learningDomainService.pruneSnapshots(input)
      })
    },
    "curator.snapshot.list": {
      executeCuratorSnapshotList: async (context, input) => ({
        ok: true as const,
        value: await services.learningDomainService.listSnapshots()
      })
    }
  };
}
