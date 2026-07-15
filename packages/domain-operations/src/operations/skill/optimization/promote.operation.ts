// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { domainJsonValueSchema, defineCommand, type DomainResult, type TrustedDomainContext } from "../../../definition/index.js";
import { skillOptimizationPromoteValueSchema } from "../../../value-objects/skill.js";

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
const Output = skillOptimizationPromoteValueSchema;

export interface SkillOptimizationPromotePorts {
  executeSkillOptimizationPromote(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> | DomainResult<z.infer<typeof Output>>;
}

const skillOptimizationPromote = defineCommand<SkillOptimizationPromotePorts>()({
  ...{
  "kind": "command",
  "id": "skill.optimization.promote",
  "version": "1.0",
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
        return ports.executeSkillOptimizationPromote(context, input);
      }
    };
  }
});

export default skillOptimizationPromote;
