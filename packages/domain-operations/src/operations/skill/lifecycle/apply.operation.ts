// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { domainJsonValueSchema, defineCommand, type DomainResult, type TrustedDomainContext } from "../../../definition/index.js";
import { skillWriteValueSchema } from "../../../value-objects/skill.js";

const Input = z.object({
  "action": z.string() .optional(),
  "envelope_id": z.string() .optional(),
  "input_locale": z.string() .optional(),
  "input_message_id": z.string() .optional(),
  "metadata": z.record(domainJsonValueSchema) .optional(),
  "output_locale": z.string() .optional(),
  "provider_tool_call": z.boolean() .optional(),
  "session_id": z.string() .optional(),
  "skill_id": z.string(),
  "source_operation_id": z.string() .optional(),
  "surface_operation_id": z.string() .optional()
}).strict();
const Output = skillWriteValueSchema;

export interface SkillLifecycleApplyPorts {
  executeSkillLifecycleApply(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> | DomainResult<z.infer<typeof Output>>;
}

const skillLifecycleApply = defineCommand<SkillLifecycleApplyPorts>()({
  ...{
  "kind": "command",
  "id": "skill.lifecycle.apply",
  "version": "2.0",
  "availability": "active",
  "title": "Apply skill lifecycle action",
  "description": "Apply a curator lifecycle transition to a local Skill.",
  "sources": [
    "runtime_api"
  ],
  "effect": "workspace_mutation",
  "idempotency": "required",
  "concurrency": "none",
  "render": [
    "skill"
  ],
  "resourceKinds": [
    "skill"
  ],
  "proposedEffects": [
    "Apply a curator lifecycle transition to a local Skill."
  ],
  "outputResourceKind": "skill",
  "uiDisplayCategory": "skill",
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
      execute: async function handleSkillLifecycleApply(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        return ports.executeSkillLifecycleApply(context, input);
      }
    };
  }
});

export default skillLifecycleApply;
