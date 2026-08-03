import type { DomainOperationPorts } from "@samurai-agent/domain-operations";
import type { RuntimeDomainServices } from "../domain-operation-services.js";
import { readOnlyQueryPort } from "./read-only-query-port.js";

type Ports = Pick<DomainOperationPorts, "curator.pause" | "curator.restore" | "curator.resume" | "curator.run" | "curator.snapshot.create" | "learning.snapshot.prune" | "curator.snapshot.list">;

export function createLearningDomainServicePorts(services: Pick<RuntimeDomainServices, "learningDomainService">): Ports {
  return {
    "curator.pause": {
      pauseCurator: () => services.learningDomainService.pause()
    },
    "curator.restore": {
      restoreCuratorSnapshot: (id) => services.learningDomainService.restoreLearningSnapshot(id),
      curatorSnapshotNotFoundError: () => services.learningDomainService.snapshotNotFoundError()
    },
    "curator.resume": {
      resumeCurator: () => services.learningDomainService.resume()
    },
    "curator.run": {
      runCurator: (input) => services.learningDomainService.runCurator(input)
    },
    "curator.snapshot.create": {
      createCuratorSnapshot: () => services.learningDomainService.createSnapshot()
    },
    "learning.snapshot.prune": {
      pruneLearningSnapshots: (input) => services.learningDomainService.pruneSnapshots(input)
    },
    "curator.snapshot.list": readOnlyQueryPort<Ports["curator.snapshot.list"]>({
      listCuratorSnapshots: () => services.learningDomainService.listSnapshots()
    })
  };
}
