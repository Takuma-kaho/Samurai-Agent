// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { domainJsonValueSchema, defineCommand, type DomainResult, type TrustedDomainContext } from "../../definition/index.js";
import { skillWriteValueSchema } from "../../value-objects/skill.js";

const Input = z.object({
  "content": z.string() .optional(),
  "description": z.string() .optional(),
  "envelope_id": z.string() .optional(),
  "input_locale": z.string() .optional(),
  "input_message_id": z.string() .optional(),
  "metadata": z.record(domainJsonValueSchema) .optional(),
  "output_locale": z.string() .optional(),
  "provider_tool_call": z.boolean() .optional(),
  "session_id": z.string() .optional(),
  "skill_id": z.string(),
  "source_operation_id": z.string() .optional(),
  "surface_operation_id": z.string() .optional(),
  "tags": z.array(z.string()) .optional(),
  "title": z.string() .optional()
}).strict();
const Output = skillWriteValueSchema;

export interface SkillPatchPorts {
  executeSkillPatch(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> | DomainResult<z.infer<typeof Output>>;
}

const skillPatch = defineCommand<SkillPatchPorts>()({
  ...{
  "kind": "command",
  "id": "skill.patch",
  "version": "1.0",
  "availability": "active",
  "title": "Edit Skill",
  "description": "Edit a Skill body and metadata through the Runtime boundary.",
  "sources": [
    "runtime_api",
    "provider_tool_call",
    "surface_operation"
  ],
  "effect": "workspace_mutation",
  "idempotency": "required",
  "concurrency": "optimistic_version",
  "render": [
    "skill"
  ],
  "resourceKinds": [
    "skill"
  ],
  "proposedEffects": [
    "Update a Skill body and metadata with history and rollback evidence."
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
      execute: async function handleSkillPatch(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        return ports.executeSkillPatch(context, input);
      }
    };
  }
});

export default skillPatch;
