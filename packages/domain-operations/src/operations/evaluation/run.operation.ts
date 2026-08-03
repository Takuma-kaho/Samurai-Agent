// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { defineCommand, type DomainResult, type TrustedDomainContext } from "../../definition/index.js";
import { evaluationRunValueSchema } from "../../value-objects/learning-run.js";

const Input = z.object({ source_run_id: z.string().trim().min(1).optional() }).strict();
const Output = evaluationRunValueSchema;

export interface EvaluationRunPorts {
  runAppliedEvaluation(input: { sourceRunId?: string }): Promise<z.infer<typeof Output>> | z.infer<typeof Output>;
}

const evaluationRun = defineCommand<EvaluationRunPorts>()({
  ...{
    kind: "command",
    id: "evaluation.run",
    version: "3.0",
    availability: "active",
    title: "Run applied-resource evaluation",
    description: "Evaluate only exact Resource versions that were recorded as applied in a Backend Run.",
    sources: ["runtime_api", "automation", "scheduled_context"],
    effect: "workspace_mutation",
    idempotency: "required",
    concurrency: "none",
    render: ["status_timeline"],
    resourceKinds: ["learning_evaluation", "learning_resource_use"],
    proposedEffects: ["Record supported, refuted, or indeterminate outcomes without comparing unrelated Runs."],
    outputResourceKind: "learning_evaluation",
    uiDisplayCategory: "memory",
    provenance: [{
      source: "samurai",
      commit_sha: "workspace-design-v1",
      reference_file: "ARCHITECTURE.md",
      decision: "adapted",
      reason: "Keep outcome evaluation tied to exact applied Resource versions."
    }]
  },
  input: Input,
  output: Output,
  createHandler(ports) {
    return {
      execute: async function handleEvaluationRun(
        _context: TrustedDomainContext,
        input: z.infer<typeof Input>
      ): Promise<DomainResult<z.infer<typeof Output>>> {
        return {
          ok: true,
          value: Output.parse(await ports.runAppliedEvaluation({
            ...(input.source_run_id ? { sourceRunId: input.source_run_id } : {})
          }))
        };
      }
    };
  }
});

export default evaluationRun;
