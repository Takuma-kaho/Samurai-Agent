// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { domainJsonValueSchema, defineCommand, type DomainResult, type TrustedDomainContext } from "../../../definition/index.js";
import { automationJobWriteValueSchema } from "../../../value-objects/automation.js";

const Input = z.object({
  "delivery_target": z.record(domainJsonValueSchema) .optional(),
  "enabled": z.boolean() .optional(),
  "envelope_id": z.string() .optional(),
  "input_locale": z.string() .optional(),
  "input_message_id": z.string() .optional(),
  "kind": z.string() .optional(),
  "max_attempts": z.number() .optional(),
  "metadata": z.record(domainJsonValueSchema) .optional(),
  "next_run_at": z.string() .optional(),
  "output_locale": z.string() .optional(),
  "provider_tool_call": z.boolean() .optional(),
  "schedule": z.string() .optional(),
  "session_id": z.string() .optional(),
  "source_operation_id": z.string() .optional(),
  "surface_operation_id": z.string() .optional(),
  "target_instruction": z.string() .optional(),
  "title": z.string() .optional()
}).strict();
const Output = automationJobWriteValueSchema;

export interface AutomationJobSavePorts {
  executeAutomationJobSave(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> | DomainResult<z.infer<typeof Output>>;
}

const automationJobSave = defineCommand<AutomationJobSavePorts>()({
  ...{
  "kind": "command",
  "id": "automation.job.save",
  "version": "1.0",
  "availability": "active",
  "title": "Save automation job",
  "description": "Save an automation job definition.",
  "sources": [
    "runtime_api"
  ],
  "effect": "workspace_mutation",
  "idempotency": "required",
  "concurrency": "append_or_unique",
  "render": [
    "status_timeline"
  ],
  "resourceKinds": [
    "automation_job"
  ],
  "proposedEffects": [
    "Save an automation job definition."
  ],
  "outputResourceKind": "automation_job",
  "uiDisplayCategory": "automation",
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
      execute: async function handleAutomationJobSave(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        return ports.executeAutomationJobSave(context, input);
      }
    };
  }
});

export default automationJobSave;
