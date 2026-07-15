// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { domainJsonValueSchema, defineCommand, type DomainResult, type TrustedDomainContext } from "../../../definition/index.js";
import { clientEventValueSchema } from "../../../value-objects/client-event.js";

const Input = z.object({
  "id": z.string(),
  "target_client_kind": z.enum(["desktop", "web", "any"]),
  "target_client_id": z.string() .optional(),
  "event_type": z.enum(["client.notification.requested", "client.workspace.open_requested", "client.session.open_requested", "client.artifact.open_requested", "client.run.open_requested", "client.status.refresh_requested"]),
  "status": z.enum(["pending", "delivered", "acked", "expired", "failed"]),
  "payload": z.record(domainJsonValueSchema),
  "resource_refs": z.array(z.record(domainJsonValueSchema)),
  "created_at": z.string(),
  "delivered_at": z.string() .optional(),
  "acked_at": z.string() .optional(),
  "expires_at": z.string() .optional(),
  "error_code": z.string() .optional()
}).strict();
const Output = clientEventValueSchema;

export interface ClientEventSavePorts {
  executeClientEventSave(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> | DomainResult<z.infer<typeof Output>>;
}

const clientEventSave = defineCommand<ClientEventSavePorts>()({
  ...{
  "kind": "command",
  "id": "client.event.save",
  "version": "1.0",
  "availability": "active",
  "title": "Save client event",
  "description": "Save a durable client delivery event.",
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
    "client_event"
  ],
  "proposedEffects": [
    "Save a durable client delivery event."
  ],
  "outputResourceKind": "client_event",
  "uiDisplayCategory": "gateway",
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
      execute: async function handleClientEventSave(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        return ports.executeClientEventSave(context, input);
      }
    };
  }
});

export default clientEventSave;
