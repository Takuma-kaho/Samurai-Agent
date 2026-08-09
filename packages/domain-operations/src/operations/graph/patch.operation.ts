// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { GraphDocumentSchema, GraphEdgeSchema, GraphNodeSchema, type ActivityInboxItem, ArtifactRecord, ArtifactRevisionRecord, type GraphDocument, type JsonValue, type OperationRecord, type ResourceRef, type RollbackPoint } from "@samurai-agent/core-schemas";
import { domainJsonValueSchema, defineCommand, type DomainResult, type TrustedDomainContext } from "../../definition/index.js";
import { artifactRevisionWriteValueSchema } from "../../value-objects/artifact.js";

const Input = z.object({
  "artifact_id": z.string().trim().min(1),
  "base_revision_id": z.string().trim().min(1).optional(),
  "change_summary": z.string().trim().min(1).optional(),
  "delete_edge_ids": z.array(z.string().trim().min(1)).default([]),
  "delete_node_ids": z.array(z.string().trim().min(1)).default([]),
  "document": GraphDocumentSchema.optional(),
  "edges": z.array(GraphEdgeSchema.partial().required({ id: true }).strict()).default([]),
  "editor_source": z.enum(["chat", "surface", "provider", "image_provider", "restore", "system"]).optional(),
  "nodes": z.array(GraphNodeSchema.partial().required({ id: true }).strict()).default([]),
  "provenance": z.record(domainJsonValueSchema).default({})
}).strict();
const Output = artifactRevisionWriteValueSchema;

export interface GraphPatchPorts {
  artifactContract(id: "graph.patch"): { id: string; proposed_effects: string[] };
  getArtifact(id: string): Promise<ArtifactRecord | undefined>; readArtifactContent(id: string): Promise<string | undefined>;
  graphArtifactNotFoundError(): Error; graphDocumentContentNotFoundError(): Error; graphDocumentInvalidError(): Error;
  createArtifactRevision(input: { artifactId: string; content: string; extension: "json"; baseRevisionId?: string; editorSource: "chat" | "surface" | "provider" | "image_provider" | "restore" | "system"; changeSummary: string; provenance: Record<string, JsonValue> }): Promise<{ artifact: ArtifactRecord; revision: ArtifactRevisionRecord }>;
  createArtifactRollback(operation: OperationRecord, refs: ResourceRef[], before: Record<string, JsonValue>, after: Record<string, JsonValue>): Promise<RollbackPoint>;
  runArtifactMutation(input: { trustedContext: TrustedDomainContext; inputSummary: string; operationName: string; proposedEffects: string[]; targetResourceRefs: ResourceRef[]; execute(operation: OperationRecord): Promise<{ resource: ArtifactRecord; ref: ResourceRef; rollbackPoint?: RollbackPoint; summary: string; extra: { revision: ArtifactRevisionRecord } }> }): Promise<{ resource: ArtifactRecord; operation: OperationRecord; rollbackPoint?: RollbackPoint; activity: ActivityInboxItem[]; revision: ArtifactRevisionRecord }>;
}

const graphPatch = defineCommand<GraphPatchPorts>()({
  ...{
  "kind": "command",
  "id": "graph.patch",
  "version": "3.0",
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
        const artifact = await ports.getArtifact(input.artifact_id);
        if (!artifact || artifact.kind !== "graph") throw ports.graphArtifactNotFoundError();
        const content = await ports.readArtifactContent(input.artifact_id);
        if (!content) throw ports.graphDocumentContentNotFoundError();
        const next = applyPatch(parseGraph(content, ports), input, ports);
        const contract = ports.artifactContract("graph.patch");
        const value = await ports.runArtifactMutation({ trustedContext: context, inputSummary: `Edit graph: ${artifact.title}`, operationName: contract.id, proposedEffects: contract.proposed_effects, targetResourceRefs: [artifact.file_ref], execute: async (operation) => {
          const created = await ports.createArtifactRevision({ artifactId: artifact.id, content: `${JSON.stringify(next, null, 2)}\n`, extension: "json", baseRevisionId: input.base_revision_id ?? currentRevisionId(artifact), editorSource: input.editor_source ?? "system", changeSummary: input.change_summary ?? "Updated graph nodes and edges.", provenance: input.provenance });
          const rollbackPoint = await ports.createArtifactRollback(operation, [artifact.file_ref, created.revision.file_ref], { artifact: jsonRecord(artifact) }, { artifact: jsonRecord(created.artifact) });
          return { resource: created.artifact, ref: created.artifact.file_ref, rollbackPoint, summary: `Updated graph ${artifact.title}.`, extra: { revision: created.revision } };
        }});
        return { ok: true, value };
      }
    };
  }
});

export default graphPatch;

type GraphPatchInput = z.infer<typeof Input>;
function parseGraph(content: string, ports: Pick<GraphPatchPorts, "graphDocumentInvalidError">): GraphDocument { try { return GraphDocumentSchema.parse(JSON.parse(content)); } catch { throw ports.graphDocumentInvalidError(); } }
function applyPatch(current: GraphDocument, patch: GraphPatchInput, ports: Pick<GraphPatchPorts, "graphDocumentInvalidError">): GraphDocument {
  try {
    if (patch.document) return GraphDocumentSchema.parse(patch.document);
    const nodes = new Map(current.nodes.map((node) => [node.id, node]));
    const edges = new Map(current.edges.map((edge) => [edge.id, edge]));
    for (const id of patch.delete_node_ids) nodes.delete(id);
    for (const id of patch.delete_edge_ids) edges.delete(id);
    for (const node of patch.nodes) nodes.set(node.id, GraphNodeSchema.parse({ ...nodes.get(node.id), ...node }));
    for (const edge of patch.edges) edges.set(edge.id, GraphEdgeSchema.parse({ ...edges.get(edge.id), ...edge }));
    return GraphDocumentSchema.parse({ version: "1", nodes: [...nodes.values()], edges: [...edges.values()] });
  } catch { throw ports.graphDocumentInvalidError(); }
}
function currentRevisionId(artifact: ArtifactRecord): string | undefined { return typeof artifact.metadata.current_revision_id === "string" ? artifact.metadata.current_revision_id : undefined; }
function jsonRecord(artifact: ArtifactRecord): Record<string, JsonValue> { return JSON.parse(JSON.stringify(artifact)) as Record<string, JsonValue>; }
