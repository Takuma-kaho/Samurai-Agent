import type { DomainOperationPorts } from "@samurai-agent/domain-operations";
import type { RuntimeDomainServices } from "../domain-operation-services.js";

type Ports = Pick<DomainOperationPorts, "evaluation.run">;

export function createAppliedLearningEvaluationDomainServicePorts(
  services: Pick<RuntimeDomainServices, "appliedLearningEvaluationDomainService">
): Ports {
  return {
    "evaluation.run": {
      runAppliedEvaluation: (input) => services.appliedLearningEvaluationDomainService.run(input)
    }
  };
}
