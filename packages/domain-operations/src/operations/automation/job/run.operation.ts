// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { domainJsonValueSchema, defineCommand, type DomainResult, type TrustedDomainContext } from "../../../definition/index.js";
import { automationJobRunValueSchema } from "../../../value-objects/automation-run.js";

const Input = z.object({
  "action_id": z.string() .optional(),
  "changes": z.record(domainJsonValueSchema) .optional(),
  "data": z.record(domainJsonValueSchema) .optional(),
  "envelope_id": z.string() .optional(),
  "error_code": z.string() .optional(),
  "input": z.record(domainJsonValueSchema) .optional(),
  "input_locale": z.string() .optional(),
  "input_message_id": z.string() .optional(),
  "job_id": z.string(),
  "message": z.string() .optional(),
  "metadata": z.record(domainJsonValueSchema) .optional(),
  "model": z.string() .optional(),
  "now": z.string() .optional(),
  "output_locale": z.string() .optional(),
  "output_summary": z.string() .optional(),
  "provider": z.string() .optional(),
  "provider_tool_call": z.boolean() .optional(),
  "provider_tool_name": z.string() .optional(),
  "reason": z.string() .optional(),
  "record_id": z.string() .optional(),
  "retryable": z.boolean() .optional(),
  "session_id": z.string() .optional(),
  "source_operation_id": z.string() .optional(),
  "status": z.string() .optional(),
  "surface_operation_id": z.string() .optional(),
  "text": z.string() .optional(),
  "tool_call_id": z.string() .optional()
}).strict();
const Output = automationJobRunValueSchema;

export interface AutomationJobRunPorts {
  executeAutomationJobRun(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> | DomainResult<z.infer<typeof Output>>;
}

const automationJobRun = defineCommand<AutomationJobRunPorts>()({
  ...{
  "kind": "command",
  "id": "automation.job.run",
  "version": "2.0",
  "availability": "active",
  "title": "Run automation job",
  "description": "Run an enabled automation job through scheduled context.",
  "sources": [
    "runtime_api",
    "automation",
    "scheduled_context"
  ],
  "effect": "workspace_mutation",
  "idempotency": "required",
  "concurrency": "none",
  "render": [
    "status_timeline"
  ],
  "resourceKinds": [
    "automation_job",
    "automation_run"
  ],
  "proposedEffects": [
    "Run an enabled automation job through scheduled context."
  ],
  "outputResourceKind": "automation_run",
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
      execute: async function handleAutomationJobRun(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        return ports.executeAutomationJobRun(context, input);
      }
    };
  }
});

export default automationJobRun;
