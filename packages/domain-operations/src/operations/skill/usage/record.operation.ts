// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { domainJsonValueSchema, defineCommand, type DomainResult, type TrustedDomainContext } from "../../../definition/index.js";
import { skillUsageRecordValueSchema } from "../../../value-objects/skill.js";

const Input = z.object({
  "content_hash": z.string(),
  "envelope_id": z.string() .optional(),
  "input_locale": z.string() .optional(),
  "input_message_id": z.string() .optional(),
  "metadata": z.record(domainJsonValueSchema) .optional(),
  "output_locale": z.string() .optional(),
  "provider_tool_call": z.boolean() .optional(),
  "resource_id": z.string(),
  "run_id": z.string(),
  "session_id": z.string() .optional(),
  "skill_id": z.string(),
  "source_operation_id": z.string() .optional(),
  "stage": z.enum(["body_loaded", "support_loaded"]),
  "surface_operation_id": z.string() .optional()
}).strict();
const Output = skillUsageRecordValueSchema;

export interface SkillUsageRecordPorts {
  executeSkillUsageRecord(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> | DomainResult<z.infer<typeof Output>>;
}

const skillUsageRecord = defineCommand<SkillUsageRecordPorts>()({
  ...{
  "kind": "command",
  "id": "skill.usage.record",
  "version": "1.0",
  "availability": "active",
  "title": "Record Skill usage",
  "description": "Record that a Backend run used a Skill body or declared support file.",
  "sources": [
    "provider_tool_call",
    "runtime_api"
  ],
  "effect": "workspace_mutation",
  "idempotency": "required",
  "concurrency": "none",
  "render": [
    "status_timeline"
  ],
  "resourceKinds": [
    "skill",
    "skill_support_file",
    "skill_usage"
  ],
  "proposedEffects": [
    "Persist Skill usage separately from the read-only Skill view query."
  ],
  "outputResourceKind": "skill_usage",
  "uiDisplayCategory": "memory",
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
      execute: async function handleSkillUsageRecord(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        return ports.executeSkillUsageRecord(context, input);
      }
    };
  }
});

export default skillUsageRecord;
