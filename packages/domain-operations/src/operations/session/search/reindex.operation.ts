// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { defineCommand, type DomainResult, type TrustedDomainContext } from "../../../definition/index.js";
import { sessionSearchReindexValueSchema } from "../../../value-objects/system-records.js";

const Input = z.object({}).strict();
const Output = sessionSearchReindexValueSchema;

export interface SessionSearchReindexPorts {
  reindexSessionSearch(): Promise<z.infer<typeof Output>> | z.infer<typeof Output>;
}

const sessionSearchReindex = defineCommand<SessionSearchReindexPorts>()({
  ...{
  "kind": "command",
  "id": "session.search.reindex",
  "version": "2.0",
  "availability": "active",
  "title": "Reindex session search",
  "description": "Rebuild the Session search read model.",
  "sources": [
    "runtime_api",
    "scheduled_context"
  ],
  "effect": "workspace_mutation",
  "idempotency": "required",
  "concurrency": "none",
  "render": [
    "status_timeline"
  ],
  "resourceKinds": [
    "search_index"
  ],
  "proposedEffects": [
    "Rebuild the Session search index."
  ],
  "outputResourceKind": "search_index",
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
      execute: async function handleSessionSearchReindex(_context: TrustedDomainContext, _input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        return { ok: true, value: Output.parse(await ports.reindexSessionSearch()) };
      }
    };
  }
});

export default sessionSearchReindex;
