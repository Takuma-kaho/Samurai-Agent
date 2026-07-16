// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import type { ClientEventRecord } from "@samurai-agent/core-schemas";
import { defineCommand, type DomainResult, type TrustedDomainContext } from "../../../definition/index.js";
import { clientEventValueSchema } from "../../../value-objects/client-event.js";

const Input = z.object({
  "event_id": z.string().min(1),
  "error_code": z.string().min(1).default("client_event_failed")
}).strict();
const Output = clientEventValueSchema;

export interface ClientEventFailPorts {
  failClientEvent(id: string, errorCode: string): Promise<ClientEventRecord | undefined>;
  clientEventNotFoundError(): Error;
}

const clientEventFail = defineCommand<ClientEventFailPorts>()({
  ...{
  "kind": "command",
  "id": "client.event.fail",
  "version": "2.0",
  "availability": "active",
  "title": "Fail client event",
  "description": "Mark a client event delivery as failed.",
  "sources": [
    "runtime_api"
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
    "Mark a client event as failed."
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
      execute: async function handleClientEventFail(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        const event = await ports.failClientEvent(input.event_id, input.error_code);
        if (!event) throw ports.clientEventNotFoundError();
        return { ok: true, value: event };
      }
    };
  }
});

export default clientEventFail;
