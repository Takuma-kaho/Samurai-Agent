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
      executeCuratorRestore: async (context, input) => ({
        ok: true as const,
        value: await services.learningDomainService.restoreSnapshot(input)
      })
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
      executeEvaluationRun: async (context, input) => ({
        ok: true as const,
        value: await services.learningDomainService.runEvaluation()
      })
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

