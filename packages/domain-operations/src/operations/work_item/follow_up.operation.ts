// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { domainJsonValueSchema, defineCommand, type DomainResult, type TrustedDomainContext } from "../../definition/index.js";
import { workItemFollowUpValueSchema } from "../../value-objects/work.js";

const Input = z.object({
  "envelope_id": z.string() .optional(),
  "input_locale": z.string() .optional(),
  "input_message_id": z.string() .optional(),
  "instruction": z.string() .optional(),
  "metadata": z.record(domainJsonValueSchema) .optional(),
  "output_locale": z.string() .optional(),
  "provider_tool_call": z.boolean() .optional(),
  "session_id": z.string() .optional(),
  "source_operation_id": z.string() .optional(),
  "surface_operation_id": z.string() .optional(),
  "work_item_id": z.string()
}).strict();
const Output = workItemFollowUpValueSchema;

export interface WorkItemFollowUpPorts {
  executeWorkItemFollowUp(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> | DomainResult<z.infer<typeof Output>>;
}

const workItemFollowUp = defineCommand<WorkItemFollowUpPorts>()({
  ...{
  "kind": "command",
  "id": "work_item.follow_up",
  "version": "1.0",
  "availability": "active",
  "title": "Create follow-up work",
  "description": "Create a dependent follow-up work item.",
  "sources": [
    "runtime_api",
    "surface_operation"
  ],
  "effect": "workspace_mutation",
  "idempotency": "required",
  "concurrency": "none",
  "render": [
    "status_timeline"
  ],
  "resourceKinds": [
    "objective",
    "work_item"
  ],
  "proposedEffects": [
    "Create a dependent follow-up work item."
  ],
  "outputResourceKind": "work_item",
  "uiDisplayCategory": "activity",
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
      execute: async function handleWorkItemFollowUp(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        return ports.executeWorkItemFollowUp(context, input);
      }
    };
  }
});

export default workItemFollowUp;
