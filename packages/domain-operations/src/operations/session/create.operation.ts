// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { domainJsonValueSchema, defineCommand, type DomainResult, type TrustedDomainContext } from "../../definition/index.js";
import { sessionValueSchema } from "../../value-objects/system-records.js";

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
  "title": z.string() .optional(),
  "ui_locale": z.string() .optional()
}).strict();
const Output = sessionValueSchema;

export interface SessionCreatePorts {
  executeSessionCreate(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> | DomainResult<z.infer<typeof Output>>;
}

const sessionCreate = defineCommand<SessionCreatePorts>()({
  ...{
  "kind": "command",
  "id": "session.create",
  "version": "1.0",
  "availability": "active",
  "title": "Create session",
  "description": "Create a persistent Chat session.",
  "sources": [
    "runtime_api",
    "surface_operation",
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
    "session"
  ],
  "proposedEffects": [
    "Create a persistent Chat session."
  ],
  "outputResourceKind": "session",
  "uiDisplayCategory": "chat",
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
      execute: async function handleSessionCreate(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        return ports.executeSessionCreate(context, input);
      }
    };
  }
});

export default sessionCreate;
