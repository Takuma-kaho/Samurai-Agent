// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { defineCommand, type DomainResult, type TrustedDomainContext } from "../../definition/index.js";
import { curatorRunValueSchema } from "../../value-objects/learning-run.js";

const Input = z.object({
  "respect_idle_gate": z.boolean().optional()
}).strict();
const Output = curatorRunValueSchema;

export interface CuratorRunPorts {
  runCurator(input: { respectIdleGate?: boolean }): Promise<z.infer<typeof Output>> | z.infer<typeof Output>;
}

const curatorRun = defineCommand<CuratorRunPorts>()({
  ...{
  "kind": "command",
  "id": "curator.run",
  "version": "3.0",
  "availability": "active",
  "title": "Run Curator",
  "description": "Run evaluation-aware Memory and Skill curation after creating a snapshot.",
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
    "reflection_run",
    "memory",
    "skill",
    "learning_snapshot"
  ],
  "proposedEffects": [
    "Curate learning resources after a restorable snapshot."
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
      execute: async function handleCuratorRun(_context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        return { ok: true, value: Output.parse(await ports.runCurator({
          ...(input.respect_idle_gate === undefined ? {} : { respectIdleGate: input.respect_idle_gate })
        })) };
      }
    };
  }
});

export default curatorRun;
