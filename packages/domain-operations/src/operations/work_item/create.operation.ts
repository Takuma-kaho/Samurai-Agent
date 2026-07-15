// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { domainJsonValueSchema, defineCommand, type DomainResult, type TrustedDomainContext } from "../../definition/index.js";
import { workItemValueSchema } from "../../value-objects/work.js";

const Input = z.object({
  "envelope_id": z.string() .optional(),
  "id": z.string() .optional(),
  "input_locale": z.string() .optional(),
  "input_message_id": z.string() .optional(),
  "instruction": z.string() .optional(),
  "max_attempts": z.number() .optional(),
  "metadata": z.record(domainJsonValueSchema) .optional(),
  "objective_id": z.string(),
  "output_locale": z.string() .optional(),
  "parent_work_item_id": z.string() .optional(),
  "priority": z.number() .optional(),
  "provider_tool_call": z.boolean() .optional(),
  "session_id": z.string() .optional(),
  "source_operation_id": z.string() .optional(),
  "surface_operation_id": z.string() .optional(),
  "work_idempotency_key": z.string() .optional(),
  "work_item_id": z.string() .optional()
}).strict();
const Output = workItemValueSchema;

export interface WorkItemCreatePorts {
  executeWorkItemCreate(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> | DomainResult<z.infer<typeof Output>>;
}

const workItemCreate = defineCommand<WorkItemCreatePorts>()({
  ...{
  "kind": "command",
  "id": "work_item.create",
  "version": "1.0",
  "availability": "active",
  "title": "Create work item",
  "description": "Create a durable work item under an objective.",
  "sources": [
    "runtime_api",
    "gateway_inbound",
    "automation"
  ],
  "effect": "workspace_mutation",
  "idempotency": "required",
  "concurrency": "append_or_unique",
  "render": [
    "status_timeline"
  ],
  "resourceKinds": [
    "objective",
    "work_item"
  ],
  "proposedEffects": [
    "Create a durable work item under an objective."
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
      execute: async function handleWorkItemCreate(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        return ports.executeWorkItemCreate(context, input);
      }
    };
  }
});

export default workItemCreate;
