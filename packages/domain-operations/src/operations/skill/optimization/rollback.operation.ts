// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { domainJsonValueSchema, defineCommand, type DomainResult, type TrustedDomainContext } from "../../../definition/index.js";
import { skillOptimizationRollbackValueSchema } from "../../../value-objects/skill.js";

const Input = z.object({
  "envelope_id": z.string() .optional(),
  "input_locale": z.string() .optional(),
  "input_message_id": z.string() .optional(),
  "metadata": z.record(domainJsonValueSchema) .optional(),
  "output_locale": z.string() .optional(),
  "promotion_id": z.string() .optional(),
  "provider_tool_call": z.boolean() .optional(),
  "session_id": z.string() .optional(),
  "snapshot_id": z.string() .optional(),
  "source_operation_id": z.string() .optional(),
  "surface_operation_id": z.string() .optional()
}).strict();
const Output = skillOptimizationRollbackValueSchema;

export interface SkillOptimizationRollbackPorts {
  executeSkillOptimizationRollback(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> | DomainResult<z.infer<typeof Output>>;
}

const skillOptimizationRollback = defineCommand<SkillOptimizationRollbackPorts>()({
  ...{
  "kind": "command",
  "id": "skill.optimization.rollback",
  "version": "1.0",
  "availability": "active",
  "title": "Rollback Skill improvement",
  "description": "Restore a promoted Skill from its immutable pre-promotion snapshot.",
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
    "skill_optimization_snapshot",
    "optimization_promotion"
  ],
  "proposedEffects": [
    "Restore the Skill from a saved snapshot while preserving promotion provenance."
  ],
  "outputResourceKind": "skill",
  "uiDisplayCategory": "skill",
  "providerToolNames": [
    "samurai.skill.optimization.rollback",
    "skill.optimization.rollback",
    "rollback_skill_optimization",
    "mcp__samurai__skill_optimization_rollback"
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
      execute: async function handleSkillOptimizationRollback(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        return ports.executeSkillOptimizationRollback(context, input);
      }
    };
  }
});

export default skillOptimizationRollback;
