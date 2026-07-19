// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { defineCommand, type DomainResult, type TrustedDomainContext } from "../../../definition/index.js";
import { learningSnapshotValueSchema } from "../../../value-objects/learning.js";

const Input = z.object({}).strict();
const Output = learningSnapshotValueSchema;

export interface CuratorSnapshotCreatePorts {
  createCuratorSnapshot(): Promise<z.infer<typeof Output>> | z.infer<typeof Output>;
}

const curatorSnapshotCreate = defineCommand<CuratorSnapshotCreatePorts>()({
  ...{
  "kind": "command",
  "id": "curator.snapshot.create",
  "version": "3.0",
  "availability": "active",
  "title": "Create Curator Snapshot",
  "description": "Create a restorable snapshot of Memory and Skill resources.",
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
    "learning_snapshot",
    "memory",
    "skill"
  ],
  "proposedEffects": [
    "Create a restorable learning-resource snapshot."
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
      execute: async function handleCuratorSnapshotCreate(_context: TrustedDomainContext, _input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        return { ok: true, value: Output.parse(await ports.createCuratorSnapshot()) };
      }
    };
  }
});

export default curatorSnapshotCreate;
