// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { domainJsonValueSchema, defineCommand, type DomainResult, type TrustedDomainContext } from "../../../definition/index.js";
import { skillWriteValueSchema } from "../../../value-objects/skill.js";

const Input = z.object({
  "content": z.string(),
  "description": z.string() .optional(),
  "envelope_id": z.string() .optional(),
  "input_locale": z.string() .optional(),
  "input_message_id": z.string() .optional(),
  "metadata": z.record(domainJsonValueSchema) .optional(),
  "output_locale": z.string() .optional(),
  "provenance_detail": z.record(domainJsonValueSchema) .optional(),
  "provider_tool_call": z.boolean() .optional(),
  "required_capabilities": z.array(z.record(domainJsonValueSchema)) .optional(),
  "session_id": z.string() .optional(),
  "source_operation_id": z.string() .optional(),
  "source_refs": z.array(z.record(domainJsonValueSchema)) .optional(),
  "surface_operation_id": z.string() .optional(),
  "tags": z.array(z.string()) .optional(),
  "title": z.string()
}).strict();
const Output = skillWriteValueSchema;

export interface SkillCandidateCreatePorts {
  executeSkillCandidateCreate(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> | DomainResult<z.infer<typeof Output>>;
}

const skillCandidateCreate = defineCommand<SkillCandidateCreatePorts>()({
  ...{
  "kind": "command",
  "id": "skill.candidate.create",
  "version": "1.0",
  "availability": "active",
  "title": "Create skill candidate",
  "description": "Create a reusable Skill candidate from a reflection or backend pattern.",
  "sources": [
    "runtime_api",
    "scheduled_context"
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
    "Create a local Skill candidate markdown file."
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
      execute: async function handleSkillCandidateCreate(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        return ports.executeSkillCandidateCreate(context, input);
      }
    };
  }
});

export default skillCandidateCreate;
