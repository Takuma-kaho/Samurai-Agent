// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { domainJsonValueSchema, defineCommand, type DomainResult, type TrustedDomainContext } from "../../definition/index.js";
import { reflectionRunValueSchema } from "../../value-objects/reflection.js";

const Input = z.object({
  "envelope_id": z.string() .optional(),
  "input_locale": z.string() .optional(),
  "input_message_id": z.string() .optional(),
  "metadata": z.record(domainJsonValueSchema) .optional(),
  "output_locale": z.string() .optional(),
  "provider_tool_call": z.boolean() .optional(),
  "session_id": z.string(),
  "source_operation_id": z.string() .optional(),
  "source_run_id": z.string() .optional(),
  "surface_operation_id": z.string() .optional(),
  "text": z.string() .optional()
}).strict();
const Output = reflectionRunValueSchema;

export interface ReflectionRunPorts {
  executeReflectionRun(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> | DomainResult<z.infer<typeof Output>>;
}

const reflectionRun = defineCommand<ReflectionRunPorts>()({
  ...{
  "kind": "command",
  "id": "reflection.run",
  "version": "1.0",
  "availability": "active",
  "title": "Run background review",
  "description": "Run scoped Background Review for a completed Session or Backend run.",
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
    "reflection_run",
    "memory",
    "wiki",
    "skill"
  ],
  "proposedEffects": [
    "Review completed work and record scoped Learning changes."
  ],
  "outputResourceKind": "reflection_run",
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
      execute: async function handleReflectionRun(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        return ports.executeReflectionRun(context, input);
      }
    };
  }
});

export default reflectionRun;
