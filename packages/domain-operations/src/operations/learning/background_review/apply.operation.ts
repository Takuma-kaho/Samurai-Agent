// Domain operation module. Keep the validated Background Review write boundary explicit.
import { LearningBackgroundReviewMutationSchema, ReflectionSuggestionRecordSchema } from "@samurai-agent/core-schemas";
import { z } from "zod";
import { defineCommand, type DomainResult, type TrustedDomainContext } from "../../../definition/index.js";

const Input = z.object({
  reflection_run_id: z.string().trim().min(1),
  mutations: z.array(LearningBackgroundReviewMutationSchema).max(50)
}).strict();
const Output = z.object({ suggestions: z.array(ReflectionSuggestionRecordSchema) }).strict();

export type LearningBackgroundReviewApplyInput = z.infer<typeof Input>;
export type LearningBackgroundReviewApplyOutput = z.infer<typeof Output>;

export interface LearningBackgroundReviewApplyPorts {
  applyBackgroundReviewMutations(input: {
    reflectionRunId: string;
    sessionId: string;
    mutations: LearningBackgroundReviewApplyInput["mutations"];
  }): Promise<LearningBackgroundReviewApplyOutput>;
}

const learningBackgroundReviewApply = defineCommand<LearningBackgroundReviewApplyPorts>()({
  ...{
    kind: "command",
    id: "learning.background_review.apply",
    version: "1.0",
    availability: "active",
    title: "Apply Background Review plan",
    description: "Validate and apply the allowlisted, Room-scoped mutations from one Background Review.",
    sources: ["runtime_api"],
    effect: "workspace_mutation",
    idempotency: "required",
    concurrency: "none",
    render: ["status_timeline"],
    resourceKinds: ["reflection_run", "reflection_suggestion", "memory", "wiki", "skill"],
    proposedEffects: ["Apply only the validated, Room-scoped Background Review mutation plan."],
    outputResourceKind: "reflection_suggestion",
    uiDisplayCategory: "memory",
    provenance: [{
      source: "samurai",
      commit_sha: "workspace-design-v1",
      reference_file: "ARCHITECTURE.md",
      decision: "adapted",
      reason: "Keep model output outside direct Workspace file writes."
    }]
  },
  input: Input,
  output: Output,
  createHandler(ports) {
    return {
      execute: async function handleLearningBackgroundReviewApply(
        context: TrustedDomainContext,
        input: LearningBackgroundReviewApplyInput
      ): Promise<DomainResult<LearningBackgroundReviewApplyOutput>> {
        if (!context.sessionId) throw new Error("trusted_context_session_required");
        return {
          ok: true,
          value: Output.parse(await ports.applyBackgroundReviewMutations({
            reflectionRunId: input.reflection_run_id,
            sessionId: context.sessionId,
            mutations: input.mutations
          }))
        };
      }
    };
  }
});

export default learningBackgroundReviewApply;
