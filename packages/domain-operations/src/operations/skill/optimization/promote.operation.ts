// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { defineCommand, type DomainResult, type TrustedDomainContext } from "../../../definition/index.js";
import { skillOptimizationPromoteValueSchema } from "../../../value-objects/skill.js";

const Input = z.object({
  "optimization_run_id": z.string().trim().min(1).max(256),
  "candidate_id": z.string().trim().min(1).max(256)
}).strict();
const Output = skillOptimizationPromoteValueSchema;

export type SkillOptimizationPromoteInput = z.infer<typeof Input>;
export type SkillOptimizationPromoteOutput = z.infer<typeof Output>;

export interface SkillOptimizationPromotePorts {
  promoteSkillOptimization(input: { optimizationRunId: string; candidateId: string }): Promise<SkillOptimizationPromoteOutput> | SkillOptimizationPromoteOutput;
}

const skillOptimizationPromote = defineCommand<SkillOptimizationPromotePorts>()({
  ...{
  "kind": "command",
  "id": "skill.optimization.promote",
  "version": "3.0",
  "availability": "active",
  "title": "Promote Skill improvement",
  "description": "Apply a user-confirmed GEPA candidate after conflict and safety checks.",
  "sources": [
    "runtime_api",
    "provider_tool_call"
  ],
  "effect": "workspace_mutation",
  "idempotency": "required",
  "concurrency": "none",
  "render": [
    "skill"
  ],
  "resourceKinds": [
    "skill",
    "skill_optimization_run",
    "optimization_candidate",
    "skill_optimization_snapshot",
    "optimization_promotion"
  ],
  "proposedEffects": [
    "Create a snapshot and promote one reviewed Skill candidate."
  ],
  "outputResourceKind": "skill",
  "uiDisplayCategory": "skill",
  "providerToolNames": [
    "samurai.skill.optimization.promote",
    "skill.optimization.promote",
    "promote_skill_optimization",
    "mcp__samurai__skill_optimization_promote"
  ],
  "provenance": [
    {
      "source": "samurai",
      "commit_sha": "workspace-design-v1",
      "reference_file": "ARCHITECTURE.md",
      "decision": "adapted",
      "reason": "Use a server-owned contract and a shared Runtime boundary for Workspace state."
    }
  ]
},
  input: Input,
  output: Output,
  createHandler(ports) {
    return {
      execute: async function handleSkillOptimizationPromote(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        return { ok: true, value: Output.parse(await ports.promoteSkillOptimization({ optimizationRunId: input.optimization_run_id, candidateId: input.candidate_id })) };
      }
    };
  }
});

export default skillOptimizationPromote;
