// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { domainJsonValueSchema, defineCommand, type DomainResult, type TrustedDomainContext } from "../../../definition/index.js";
import { generatedSurfaceActionValueSchema } from "../../../value-objects/generated-surface.js";

const Input = z.object({
  "action_id": z.string(),
  "action_payload": z.record(domainJsonValueSchema) .optional(),
  "envelope_id": z.string() .optional(),
  "input_locale": z.string() .optional(),
  "input_message_id": z.string() .optional(),
  "interaction_id": z.string() .optional(),
  "metadata": z.record(domainJsonValueSchema) .optional(),
  "output_locale": z.string() .optional(),
  "provider_tool_call": z.boolean() .optional(),
  "revision_id": z.string() .optional(),
  "session_id": z.string() .optional(),
  "source_operation_id": z.string() .optional(),
  "surface_id": z.string(),
  "surface_operation_id": z.string() .optional()
}).strict();
const Output = generatedSurfaceActionValueSchema;

export interface GeneratedSurfaceActionRunPorts {
  executeGeneratedSurfaceActionRun(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> | DomainResult<z.infer<typeof Output>>;
}

const generatedSurfaceActionRun = defineCommand<GeneratedSurfaceActionRunPorts>()({
  ...{
  "kind": "command",
  "id": "generated_surface.action.run",
  "version": "1.0",
  "availability": "active",
  "title": "Run generated surface action",
  "description": "Execute a declared Generated Surface action through its Domain Command.",
  "sources": [
    "runtime_api",
    "surface_operation",
    "generated_surface"
  ],
  "effect": "workspace_mutation",
  "idempotency": "required",
  "concurrency": "none",
  "render": [
    "status_timeline"
  ],
  "resourceKinds": [
    "generated_surface",
    "operation"
  ],
  "proposedEffects": [
    "Execute a declared Generated Surface action through the Domain Command Bus."
  ],
  "outputResourceKind": "domain_command_result",
  "uiDisplayCategory": "generated_surface",
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
      execute: async function handleGeneratedSurfaceActionRun(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        return ports.executeGeneratedSurfaceActionRun(context, input);
      }
    };
  }
});

export default generatedSurfaceActionRun;
