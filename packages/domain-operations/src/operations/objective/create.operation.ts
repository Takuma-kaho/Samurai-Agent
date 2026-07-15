// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { domainJsonValueSchema, defineCommand, type DomainResult, type TrustedDomainContext } from "../../definition/index.js";
import { objectiveValueSchema } from "../../value-objects/work.js";

const Input = z.object({
  "completion_criteria": z.array(z.record(domainJsonValueSchema)) .optional(),
  "envelope_id": z.string() .optional(),
  "id": z.string() .optional(),
  "input_locale": z.string() .optional(),
  "input_message_id": z.string() .optional(),
  "max_attempts": z.number() .optional(),
  "metadata": z.record(domainJsonValueSchema) .optional(),
  "objective": z.string() .optional(),
  "objective_id": z.string() .optional(),
  "output_locale": z.string() .optional(),
  "provider_tool_call": z.boolean() .optional(),
  "session_id": z.string() .optional(),
  "source_operation_id": z.string() .optional(),
  "surface_operation_id": z.string() .optional(),
  "time_budget_ms": z.number() .optional(),
  "title": z.string() .optional(),
  "token_budget": z.number() .optional()
}).strict();
const Output = objectiveValueSchema;

export interface ObjectiveCreatePorts {
  executeObjectiveCreate(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> | DomainResult<z.infer<typeof Output>>;
}

const objectiveCreate = defineCommand<ObjectiveCreatePorts>()({
  ...{
  "kind": "command",
  "id": "objective.create",
  "version": "1.0",
  "availability": "active",
  "title": "Create objective",
  "description": "Create a durable objective with explicit completion criteria.",
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
    "objective"
  ],
  "proposedEffects": [
    "Create a durable objective and explicit completion criteria."
  ],
  "outputResourceKind": "objective",
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
      execute: async function handleObjectiveCreate(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        return ports.executeObjectiveCreate(context, input);
      }
    };
  }
});

export default objectiveCreate;
