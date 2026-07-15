// Domain operation module. Keep its contract and handler together.
import { SkillOptimizationRunSchema } from "@samurai-agent/core-schemas";
import { z } from "zod";
import { domainJsonValueSchema, defineCommand, type DomainResult, type TrustedDomainContext } from "../../../definition/index.js";

const Input = z.object({
  "envelope_id": z.string() .optional(),
  "input_locale": z.string() .optional(),
  "input_message_id": z.string() .optional(),
  "metadata": z.record(domainJsonValueSchema) .optional(),
  "output_locale": z.string() .optional(),
  "provider_tool_call": z.boolean() .optional(),
  "run_id": z.string(),
  "session_id": z.string() .optional(),
  "source_operation_id": z.string() .optional(),
  "surface_operation_id": z.string() .optional()
}).strict();
const Output = SkillOptimizationRunSchema.strict();

export interface SkillOptimizationCancelPorts {
  executeSkillOptimizationCancel(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> | DomainResult<z.infer<typeof Output>>;
}

const skillOptimizationCancel = defineCommand<SkillOptimizationCancelPorts>()({
  ...{
  "kind": "command",
  "id": "skill.optimization.cancel",
  "version": "1.0",
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
        return ports.executeSkillOptimizationCancel(context, input);
      }
    };
  }
});

export default skillOptimizationCancel;
