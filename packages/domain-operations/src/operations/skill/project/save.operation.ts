// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { domainJsonValueSchema, defineCommand, type DomainResult, type TrustedDomainContext } from "../../../definition/index.js";
import { skillWriteValueSchema } from "../../../value-objects/skill.js";

const Input = z.object({
  "candidate_id": z.string(),
  "envelope_id": z.string() .optional(),
  "input_locale": z.string() .optional(),
  "input_message_id": z.string() .optional(),
  "metadata": z.record(domainJsonValueSchema) .optional(),
  "output_locale": z.string() .optional(),
  "provider_tool_call": z.boolean() .optional(),
  "session_id": z.string() .optional(),
  "source_operation_id": z.string() .optional(),
  "surface_operation_id": z.string() .optional()
}).strict();
const Output = skillWriteValueSchema;

export interface SkillProjectSavePorts {
  executeSkillProjectSave(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> | DomainResult<z.infer<typeof Output>>;
}

const skillProjectSave = defineCommand<SkillProjectSavePorts>()({
  ...{
  "kind": "command",
  "id": "skill.project.save",
  "version": "2.0",
  "availability": "active",
  "title": "Save project skill",
  "description": "Save a promoted project Skill markdown file.",
  "sources": [
    "runtime_api"
  ],
  "effect": "workspace_mutation",
  "idempotency": "required",
  "concurrency": "append_or_unique",
  "render": [
    "skill"
  ],
  "resourceKinds": [
    "skill"
  ],
  "proposedEffects": [
    "Save a promoted project Skill markdown file."
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
      execute: async function handleSkillProjectSave(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        return ports.executeSkillProjectSave(context, input);
      }
    };
  }
});

export default skillProjectSave;
