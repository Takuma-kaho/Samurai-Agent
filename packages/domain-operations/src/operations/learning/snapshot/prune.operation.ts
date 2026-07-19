// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { defineCommand, type DomainResult, type TrustedDomainContext } from "../../../definition/index.js";
import { learningSnapshotPruneValueSchema } from "../../../value-objects/learning.js";

const Input = z.object({
  "retain": z.number().int().min(1).default(20)
}).strict();
const Output = learningSnapshotPruneValueSchema;

export interface LearningSnapshotPrunePorts {
  pruneLearningSnapshots(input: { retain: number }): Promise<z.infer<typeof Output>> | z.infer<typeof Output>;
}

const learningSnapshotPrune = defineCommand<LearningSnapshotPrunePorts>()({
  ...{
  "kind": "command",
  "id": "learning.snapshot.prune",
  "version": "2.0",
  "availability": "active",
  "title": "Prune learning snapshots",
  "description": "Apply the configured retention limit to Learning snapshots.",
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
    "learning_snapshot"
  ],
  "proposedEffects": [
    "Prune old Learning snapshots according to retention."
  ],
  "outputResourceKind": "learning_snapshot",
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
      execute: async function handleLearningSnapshotPrune(_context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        return { ok: true, value: Output.parse(await ports.pruneLearningSnapshots({ retain: input.retain })) };
      }
    };
  }
});

export default learningSnapshotPrune;
