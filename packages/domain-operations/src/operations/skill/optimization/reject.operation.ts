// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { domainJsonValueSchema, defineCommand, type DomainResult, type TrustedDomainContext } from "../../../definition/index.js";
import { skillOptimizationRejectValueSchema } from "../../../value-objects/skill.js";

const Input = z.object({
  "candidate_id": z.string(),
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
const Output = skillOptimizationRejectValueSchema;

export interface SkillOptimizationRejectPorts {
  executeSkillOptimizationReject(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> | DomainResult<z.infer<typeof Output>>;
}

const skillOptimizationReject = defineCommand<SkillOptimizationRejectPorts>()({
  ...{
  "kind": "command",
  "id": "skill.optimization.reject",
  "version": "1.0",
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
        return ports.executeSkillOptimizationReject(context, input);
      }
    };
  }
});

export default skillOptimizationReject;
