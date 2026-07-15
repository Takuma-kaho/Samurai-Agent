// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { domainJsonValueSchema, defineCommand, type DomainResult, type TrustedDomainContext } from "../../../definition/index.js";
import { automationMemoryReviewRunValueSchema } from "../../../value-objects/automation-run.js";

const Input = z.object({
  "envelope_id": z.string() .optional(),
  "input_locale": z.string() .optional(),
  "input_message_id": z.string() .optional(),
  "metadata": z.record(domainJsonValueSchema) .optional(),
  "output_locale": z.string() .optional(),
  "provider_tool_call": z.boolean() .optional(),
  "session_id": z.string() .optional(),
  "source_operation_id": z.string() .optional(),
  "surface_operation_id": z.string() .optional(),
  "text": z.string() .optional()
}).strict();
const Output = automationMemoryReviewRunValueSchema;

export interface AutomationMemoryReviewRunPorts {
  executeAutomationMemoryReviewRun(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> | DomainResult<z.infer<typeof Output>>;
}

const automationMemoryReviewRun = defineCommand<AutomationMemoryReviewRunPorts>()({
  ...{
  "kind": "command",
  "id": "automation.memory_review.run",
  "version": "1.0",
  "availability": "active",
  "title": "Run memory review",
  "description": "Run the scheduled memory review automation.",
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
    "automation_run",
    "reflection_run",
    "memory"
  ],
  "proposedEffects": [
    "Run the scheduled memory review automation."
  ],
  "outputResourceKind": "reflection_run",
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
      execute: async function handleAutomationMemoryReviewRun(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        return ports.executeAutomationMemoryReviewRun(context, input);
      }
    };
  }
});

export default automationMemoryReviewRun;
