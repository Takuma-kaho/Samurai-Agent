// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { defineCommand, type DomainResult, type TrustedDomainContext } from "../../definition/index.js";
import { learningSnapshotValueSchema } from "../../value-objects/learning.js";

const Input = z.object({
  "snapshot_id": z.string().trim().min(1)
}).strict();
const Output = learningSnapshotValueSchema;

export interface CuratorRestorePorts {
  restoreCuratorSnapshot(id: string): Promise<z.infer<typeof Output> | undefined>;
  curatorSnapshotNotFoundError(): Error;
}

const curatorRestore = defineCommand<CuratorRestorePorts>()({
  ...{
  "kind": "command",
  "id": "curator.restore",
  "version": "1.0",
  "availability": "active",
  "title": "Restore Curator Snapshot",
  "description": "Restore Memory and Skill resources from a Curator snapshot.",
  "sources": [
    "runtime_api"
  ],
  "effect": "workspace_mutation",
  "idempotency": "required",
  "concurrency": "optimistic_version",
  "render": [
    "status_timeline"
  ],
  "resourceKinds": [
    "learning_snapshot",
    "memory",
    "skill"
  ],
  "proposedEffects": [
    "Restore learning resources from a snapshot."
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
      execute: async function handleCuratorRestore(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        const restored = await ports.restoreCuratorSnapshot(input.snapshot_id);
        if (!restored) throw ports.curatorSnapshotNotFoundError();
        return { ok: true, value: restored };
      }
    };
  }
});

export default curatorRestore;
