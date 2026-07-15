// Domain operation module. Keep its contract and handler together.
import { LearningSnapshotRecordSchema } from "@samurai-agent/core-schemas";
import { z } from "zod";
import { domainJsonValueSchema, defineQuery, type DomainQueryPorts, type DomainResult, type TrustedDomainContext } from "../../../definition/index.js";

const Input = z.object({
  "envelope_id": z.string() .optional(),
  "input_locale": z.string() .optional(),
  "input_message_id": z.string() .optional(),
  "metadata": z.record(domainJsonValueSchema) .optional(),
  "output_locale": z.string() .optional(),
  "provider_tool_call": z.boolean() .optional(),
  "session_id": z.string() .optional(),
  "source_operation_id": z.string() .optional(),
  "surface_operation_id": z.string() .optional()
}).strict();
const Output = z.array(LearningSnapshotRecordSchema);

export interface CuratorSnapshotListPorts extends DomainQueryPorts {
  executeCuratorSnapshotList(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> | DomainResult<z.infer<typeof Output>>;
}

const curatorSnapshotList = defineQuery<CuratorSnapshotListPorts>()({
  ...{
  "kind": "query",
  "id": "curator.snapshot.list",
  "version": "1.0",
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
      execute: async function handleCuratorSnapshotList(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        return ports.executeCuratorSnapshotList(context, input);
      }
    };
  }
});

export default curatorSnapshotList;
