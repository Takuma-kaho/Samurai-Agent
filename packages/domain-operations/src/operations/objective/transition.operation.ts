// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { domainJsonValueSchema, defineCommand, type DomainResult, type TrustedDomainContext } from "../../definition/index.js";
import { objectiveTransitionValueSchema } from "../../value-objects/work.js";

const Input = z.object({
  "action": z.enum(["pause", "resume", "cancel"]),
  "envelope_id": z.string() .optional(),
  "input_locale": z.string() .optional(),
  "input_message_id": z.string() .optional(),
  "metadata": z.record(domainJsonValueSchema) .optional(),
  "objective_id": z.string(),
  "output_locale": z.string() .optional(),
  "provider_tool_call": z.boolean() .optional(),
  "session_id": z.string() .optional(),
  "source_operation_id": z.string() .optional(),
  "surface_operation_id": z.string() .optional()
}).strict();
const Output = objectiveTransitionValueSchema;

export interface ObjectiveTransitionPorts {
  executeObjectiveTransition(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> | DomainResult<z.infer<typeof Output>>;
}

const objectiveTransition = defineCommand<ObjectiveTransitionPorts>()({
  ...{
  "kind": "command",
  "id": "objective.transition",
  "version": "1.0",
  "availability": "active",
  "title": "Transition objective",
  "description": "Pause, resume, or cancel an objective and propagate the transition.",
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
    "work_item",
    "backend_run"
  ],
  "proposedEffects": [
    "Transition an objective and propagate it to active work and Backend runs."
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
      execute: async function handleObjectiveTransition(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        return ports.executeObjectiveTransition(context, input);
      }
    };
  }
});

export default objectiveTransition;
