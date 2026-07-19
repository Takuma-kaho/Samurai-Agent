// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { defineCommand, type DomainResult, type TrustedDomainContext } from "../../../definition/index.js";
import { expiredClientEventsValueSchema } from "../../../value-objects/client-event.js";

const Input = z.object({
  "now": z.string().datetime().optional()
}).strict();
const Output = expiredClientEventsValueSchema;

export interface ClientEventExpirePorts {
  expireClientEvents(now?: string): Promise<z.infer<typeof Output>["events"]>;
}

const clientEventExpire = defineCommand<ClientEventExpirePorts>()({
  ...{
  "kind": "command",
  "id": "client.event.expire",
  "version": "2.0",
  "availability": "active",
  "title": "Expire client events",
  "description": "Expire client events after their delivery deadline.",
  "sources": [
    "runtime_api",
    "scheduled_context"
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
    "Expire client events after their deadline."
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
      execute: async function handleClientEventExpire(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        const events = await ports.expireClientEvents(input.now);
        return { ok: true, value: { expired_count: events.length, events } };
      }
    };
  }
});

export default clientEventExpire;
