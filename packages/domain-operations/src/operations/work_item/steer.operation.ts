// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { domainJsonValueSchema, defineCommand, type DomainResult, type TrustedDomainContext } from "../../definition/index.js";
import { workItemValueSchema } from "../../value-objects/work.js";

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
const Output = workItemValueSchema;

export interface WorkItemSteerPorts {
  executeWorkItemSteer(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> | DomainResult<z.infer<typeof Output>>;
}

const workItemSteer = defineCommand<WorkItemSteerPorts>()({
  ...{
  "kind": "command",
  "id": "work_item.steer",
  "version": "1.0",
  "availability": "active",
  "title": "Steer work item",
  "description": "Persist a steering instruction on the current work item.",
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
    "work_item"
  ],
  "proposedEffects": [
    "Add a steering instruction to the current work item."
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
      execute: async function handleWorkItemSteer(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        return ports.executeWorkItemSteer(context, input);
      }
    };
  }
});

export default workItemSteer;
