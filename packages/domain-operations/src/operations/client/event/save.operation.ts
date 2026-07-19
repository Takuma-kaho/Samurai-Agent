// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { ClientEventRecordSchema, type ClientEventRecord } from "@samurai-agent/core-schemas";
import { defineCommand, type DomainResult, type TrustedDomainContext } from "../../../definition/index.js";
import { clientEventValueSchema } from "../../../value-objects/client-event.js";

const Input = ClientEventRecordSchema.strict();
const Output = clientEventValueSchema;

export interface ClientEventSavePorts {
  saveClientEvent(event: ClientEventRecord): Promise<ClientEventRecord>;
}

const clientEventSave = defineCommand<ClientEventSavePorts>()({
  ...{
  "kind": "command",
  "id": "client.event.save",
  "version": "2.0",
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
        return { ok: true, value: await ports.saveClientEvent(input) };
      }
    };
  }
});

export default clientEventSave;
