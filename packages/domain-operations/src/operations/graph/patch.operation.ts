// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { domainJsonValueSchema, defineCommand, type DomainResult, type TrustedDomainContext } from "../../definition/index.js";
import { artifactRevisionWriteValueSchema } from "../../value-objects/artifact.js";

const Input = z.object({
  "artifact_id": z.string(),
  "base_revision_id": z.string() .optional(),
  "change_summary": z.string() .optional(),
  "delete_edge_ids": z.array(z.string()) .optional(),
  "delete_node_ids": z.array(z.string()) .optional(),
  "document": z.record(domainJsonValueSchema) .optional(),
  "edges": z.array(z.record(domainJsonValueSchema)) .optional(),
  "editor_source": z.string() .optional(),
  "envelope_id": z.string() .optional(),
  "input_locale": z.string() .optional(),
  "input_message_id": z.string() .optional(),
  "metadata": z.record(domainJsonValueSchema) .optional(),
  "nodes": z.array(z.record(domainJsonValueSchema)) .optional(),
  "output_locale": z.string() .optional(),
  "provenance": z.record(domainJsonValueSchema) .optional(),
  "provider_tool_call": z.boolean() .optional(),
  "session_id": z.string() .optional(),
  "source_operation_id": z.string() .optional(),
  "surface_operation_id": z.string() .optional()
}).strict();
const Output = artifactRevisionWriteValueSchema;

export interface GraphPatchPorts {
  executeGraphPatch(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> | DomainResult<z.infer<typeof Output>>;
}

const graphPatch = defineCommand<GraphPatchPorts>()({
  ...{
  "kind": "command",
  "id": "graph.patch",
  "version": "1.0",
  "availability": "active",
  "title": "Edit graph",
  "description": "Apply node and edge edits to a graph through a new immutable Artifact revision.",
  "sources": [
    "runtime_api",
    "provider_tool_call",
    "surface_operation"
  ],
  "effect": "workspace_mutation",
  "idempotency": "required",
  "concurrency": "optimistic_version",
  "render": [
    "graph_view",
    "artifact"
  ],
  "resourceKinds": [
    "artifact",
    "artifact_revision"
  ],
  "proposedEffects": [
    "Create a new graph Artifact revision from validated node and edge edits."
  ],
  "outputResourceKind": "artifact",
  "uiDisplayCategory": "artifact",
  "providerToolNames": [
    "graph.patch",
    "samurai.graph.patch"
  ],
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
      execute: async function handleGraphPatch(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        return ports.executeGraphPatch(context, input);
      }
    };
  }
});

export default graphPatch;
