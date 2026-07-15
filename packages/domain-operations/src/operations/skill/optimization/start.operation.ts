// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { domainJsonValueSchema, defineCommand, type DomainResult, type TrustedDomainContext } from "../../../definition/index.js";
import { skillOptimizationStartValueSchema } from "../../../value-objects/skill.js";

const Input = z.object({
  "envelope_id": z.string() .optional(),
  "golden_examples": z.array(domainJsonValueSchema) .optional(),
  "input_locale": z.string() .optional(),
  "input_message_id": z.string() .optional(),
  "metadata": z.record(domainJsonValueSchema) .optional(),
  "objective": z.string() .optional(),
  "output_locale": z.string() .optional(),
  "provider_tool_call": z.boolean() .optional(),
  "session_id": z.string() .optional(),
  "skill_id": z.string(),
  "source_operation_id": z.string() .optional(),
  "surface_operation_id": z.string() .optional(),
  "synthetic_examples": z.array(domainJsonValueSchema) .optional()
}).strict();
const Output = skillOptimizationStartValueSchema;

export interface SkillOptimizationStartPorts {
  executeSkillOptimizationStart(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> | DomainResult<z.infer<typeof Output>>;
}

const skillOptimizationStart = defineCommand<SkillOptimizationStartPorts>()({
  ...{
  "kind": "command",
  "id": "skill.optimization.start",
  "version": "1.0",
  "availability": "active",
  "title": "Start Skill improvement",
  "description": "Run the locked GEPA Skill improvement worker and save reviewable candidates.",
  "sources": [
    "runtime_api",
    "automation",
    "provider_tool_call"
  ],
  "effect": "workspace_mutation",
  "idempotency": "required",
  "concurrency": "none",
  "render": [
    "status_timeline"
  ],
  "resourceKinds": [
    "skill",
    "skill_optimization_run",
    "optimization_candidate",
    "optimization_dataset",
    "work_item"
  ],
  "proposedEffects": [
    "Create an immutable Skill improvement run and candidate without changing the original Skill."
  ],
  "outputResourceKind": "skill_optimization_run",
  "uiDisplayCategory": "skill",
  "providerToolNames": [
    "samurai.skill.optimization.start",
    "skill.optimization.start",
    "start_skill_optimization",
    "mcp__samurai__skill_optimization_start"
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
      execute: async function handleSkillOptimizationStart(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        return ports.executeSkillOptimizationStart(context, input);
      }
    };
  }
});

export default skillOptimizationStart;
