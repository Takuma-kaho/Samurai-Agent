// Domain operation module. Keep its contract and handler together.
import { LearningSnapshotRecordSchema } from "@samurai-agent/core-schemas";
import { z } from "zod";
import { defineQuery, type DomainQueryPorts, type DomainResult, type ReadCapability, type TrustedDomainContext } from "../../../definition/index.js";

const Input = z.object({}).strict();
const Output = z.array(LearningSnapshotRecordSchema);

export interface CuratorSnapshotListPorts extends DomainQueryPorts {
  listCuratorSnapshots: ReadCapability<() => Promise<z.infer<typeof Output>> | z.infer<typeof Output>>;
}

const curatorSnapshotList = defineQuery<CuratorSnapshotListPorts>()({
  ...{
  "kind": "query",
  "id": "curator.snapshot.list",
  "version": "2.0",
  "availability": "active",
  "title": "List Curator Snapshots",
  "description": "List restorable learning-resource snapshots.",
  "sources": [
    "runtime_api"
  ],
  "effect": "read_only",
  "idempotency": "none",
  "concurrency": "none",
  "render": [
    "status_timeline"
  ],
  "resourceKinds": [
    "learning_snapshot"
  ],
  "proposedEffects": [
    "Read learning_snapshot without changing Workspace state."
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
      execute: async function handleCuratorSnapshotList(_context: TrustedDomainContext, _input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        return { ok: true, value: Output.parse(await ports.listCuratorSnapshots()) };
      }
    };
  }
});

export default curatorSnapshotList;
