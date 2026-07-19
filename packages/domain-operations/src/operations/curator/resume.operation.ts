// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { defineCommand, type DomainResult, type TrustedDomainContext } from "../../definition/index.js";
import { curatorStateValueSchema } from "../../value-objects/learning.js";

const Input = z.object({}).strict();
const Output = curatorStateValueSchema;

export interface CuratorResumePorts {
  resumeCurator(): Promise<z.infer<typeof Output>> | z.infer<typeof Output>;
}

const curatorResume = defineCommand<CuratorResumePorts>()({
  ...{
  "kind": "command",
  "id": "curator.resume",
  "version": "2.0",
  "availability": "active",
  "title": "Resume Curator",
  "description": "Resume scheduled Curator runs.",
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
    "Resume scheduled Curator runs."
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
      execute: async function handleCuratorResume(_context: TrustedDomainContext, _input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        return { ok: true, value: Output.parse(await ports.resumeCurator()) };
      }
    };
  }
});

export default curatorResume;
