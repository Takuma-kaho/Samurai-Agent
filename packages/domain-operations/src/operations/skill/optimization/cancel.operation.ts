// Domain operation module. Keep its contract and handler together.
import { SkillOptimizationRunSchema } from "@samurai-agent/core-schemas";
import { z } from "zod";
import { defineCommand, requireRoomContext, type DomainResult, type TrustedDomainContext } from "../../../definition/index.js";

const Input = z.object({
  "optimization_run_id": z.string().trim().min(1).max(256)
}).strict();
const Output = SkillOptimizationRunSchema.strict();

export type SkillOptimizationCancelInput = z.infer<typeof Input>;
export type SkillOptimizationCancelOutput = z.infer<typeof Output>;

export interface SkillOptimizationCancelPorts {
  cancelSkillOptimization(input: { optimizationRunId: string; roomId: string }): Promise<SkillOptimizationCancelOutput> | SkillOptimizationCancelOutput;
}

const skillOptimizationCancel = defineCommand<SkillOptimizationCancelPorts>()({
  ...{
  "kind": "command",
  "id": "skill.optimization.cancel",
  "version": "3.0",
  "availability": "active",
  "title": "Cancel Skill improvement",
  "description": "Cancel a running Skill improvement work item.",
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
    "work_item"
  ],
  "proposedEffects": [
    "Stop a Skill improvement run and keep the original Skill unchanged."
  ],
  "outputResourceKind": "skill_optimization_run",
  "uiDisplayCategory": "skill",
  "providerToolNames": [
    "samurai.skill.optimization.cancel",
    "skill.optimization.cancel",
    "cancel_skill_optimization",
    "mcp__samurai__skill_optimization_cancel"
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
      execute: async function handleSkillOptimizationCancel(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        return { ok: true, value: Output.parse(await ports.cancelSkillOptimization({ optimizationRunId: input.optimization_run_id, roomId: requireRoomContext(context, "skill.optimization.cancel") })) };
      }
    };
  }
});

export default skillOptimizationCancel;
