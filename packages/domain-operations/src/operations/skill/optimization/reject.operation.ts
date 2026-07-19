// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { defineCommand, type DomainResult, type TrustedDomainContext } from "../../../definition/index.js";
import { skillOptimizationRejectValueSchema } from "../../../value-objects/skill.js";

const Input = z.object({
  "optimization_run_id": z.string().trim().min(1).max(256),
  "candidate_id": z.string().trim().min(1).max(256)
}).strict();
const Output = skillOptimizationRejectValueSchema;

export type SkillOptimizationRejectInput = z.infer<typeof Input>;
export type SkillOptimizationRejectOutput = z.infer<typeof Output>;

export interface SkillOptimizationRejectPorts {
  rejectSkillOptimization(input: { optimizationRunId: string; candidateId: string }): Promise<SkillOptimizationRejectOutput> | SkillOptimizationRejectOutput;
}

const skillOptimizationReject = defineCommand<SkillOptimizationRejectPorts>()({
  ...{
  "kind": "command",
  "id": "skill.optimization.reject",
  "version": "3.0",
  "availability": "active",
  "title": "Reject Skill improvement",
  "description": "Reject a proposed Skill improvement candidate.",
  "sources": [
    "runtime_api",
    "provider_tool_call"
  ],
  "effect": "workspace_mutation",
  "idempotency": "required",
  "concurrency": "none",
  "render": [
    "status_timeline"
  ],
  "resourceKinds": [
    "skill_optimization_run",
    "optimization_candidate"
  ],
  "proposedEffects": [
    "Reject a candidate and release its Skill lock without modifying the original Skill."
  ],
  "outputResourceKind": "skill_optimization_run",
  "uiDisplayCategory": "skill",
  "providerToolNames": [
    "samurai.skill.optimization.reject",
    "skill.optimization.reject",
    "reject_skill_optimization",
    "mcp__samurai__skill_optimization_reject"
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
      execute: async function handleSkillOptimizationReject(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        return { ok: true, value: Output.parse(await ports.rejectSkillOptimization({ optimizationRunId: input.optimization_run_id, candidateId: input.candidate_id })) };
      }
    };
  }
});

export default skillOptimizationReject;
