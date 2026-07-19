// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { defineCommand, type DomainResult, type TrustedDomainContext } from "../../definition/index.js";
import { curatorStateValueSchema } from "../../value-objects/learning.js";

const Input = z.object({}).strict();
const Output = curatorStateValueSchema;

export interface CuratorPausePorts {
  pauseCurator(): Promise<z.infer<typeof Output>> | z.infer<typeof Output>;
}

const curatorPause = defineCommand<CuratorPausePorts>()({
  ...{
  "kind": "command",
  "id": "curator.pause",
  "version": "2.0",
  "availability": "active",
  "title": "Pause Curator",
  "description": "Pause scheduled Curator runs.",
  "sources": [
    "runtime_api"
  ],
  "effect": "workspace_mutation",
  "idempotency": "required",
  "concurrency": "state_transition",
  "render": [
    "status_timeline"
  ],
  "resourceKinds": [
    "curator_state"
  ],
  "proposedEffects": [
    "Pause scheduled Curator runs."
  ],
  "outputResourceKind": "curator_state",
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
      execute: async function handleCuratorPause(_context: TrustedDomainContext, _input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        return { ok: true, value: Output.parse(await ports.pauseCurator()) };
      }
    };
  }
});

export default curatorPause;
