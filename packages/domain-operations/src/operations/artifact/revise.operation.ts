// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import type { ActivityInboxItem, ArtifactRecord, ArtifactRevisionRecord, JsonValue, OperationRecord, ResourceRef, RollbackPoint } from "@samurai-agent/core-schemas";
import { domainJsonValueSchema, defineCommand, type DomainResult, type TrustedDomainContext } from "../../definition/index.js";
import { artifactRevisionWriteValueSchema } from "../../value-objects/artifact.js";

const Input = z.object({
  "artifact_id": z.string().trim().min(1),
  "base_revision_id": z.string().trim().min(1).optional(),
  "change_summary": z.string().trim().min(1).optional(),
  "content": z.string().min(1),
  "editor_source": z.enum(["chat", "surface", "provider", "image_provider", "restore", "system"]).optional(),
  /** Required by the external MCP adapter for existing Artifacts.  Kept
   * optional here so older internal callers remain compatible. */
  "expected_revision": z.number().int().positive().optional(),
  "extension": z.string().trim().min(1).optional(),
  "provenance": z.record(domainJsonValueSchema).default({})
}).strict();
const Output = artifactRevisionWriteValueSchema;

export interface ArtifactRevisePorts {
  artifactContract(id: "artifact.revise"): { id: string; proposed_effects: string[] };
  getArtifact(id: string): Promise<ArtifactRecord | undefined>; artifactNotFoundError(): Error;
  validateGraphArtifactContent(content: string): void;
  createArtifactRevision(input: { artifactId: string; content: string; producerRunId?: string; extension?: string; baseRevisionId?: string; expectedRevision?: number; editorSource: "chat" | "surface" | "provider" | "image_provider" | "restore" | "system"; changeSummary?: string; provenance: Record<string, JsonValue> }): Promise<{ artifact: ArtifactRecord; revision: ArtifactRevisionRecord }>;
  createArtifactRollback(operation: OperationRecord, refs: ResourceRef[], before: Record<string, JsonValue>, after: Record<string, JsonValue>): Promise<RollbackPoint>;
  runArtifactMutation(input: { trustedContext: TrustedDomainContext; inputSummary: string; operationName: string; proposedEffects: string[]; targetResourceRefs: ResourceRef[]; execute(operation: OperationRecord): Promise<{ resource: ArtifactRecord; ref: ResourceRef; rollbackPoint?: RollbackPoint; summary: string; extra: { revision: ArtifactRevisionRecord } }> }): Promise<{ resource: ArtifactRecord; operation: OperationRecord; rollbackPoint?: RollbackPoint; activity: ActivityInboxItem[]; revision: ArtifactRevisionRecord }>;
}

const artifactRevise = defineCommand<ArtifactRevisePorts>()({
  ...{
  "kind": "command",
  "id": "artifact.revise",
  "version": "4.0",
  "availability": "active",
  "title": "Revise artifact",
  "description": "Create an immutable Artifact revision with content hash and lineage.",
  "sources": [
    "runtime_api",
    "provider_tool_call",
    "surface_operation",
    "external_app"
  ],
  "effect": "workspace_mutation",
  "idempotency": "required",
  "concurrency": "optimistic_version",
  "render": [
    "artifact"
  ],
  "resourceKinds": [
    "artifact",
    "artifact_revision"
  ],
  "proposedEffects": [
    "Create an immutable Artifact revision and update its current pointer."
  ],
  "outputResourceKind": "artifact",
  "uiDisplayCategory": "artifact",
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
      execute: async function handleArtifactRevise(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        const artifact = await ports.getArtifact(input.artifact_id);
        if (!artifact) throw ports.artifactNotFoundError();
        if (artifact.kind === "graph") ports.validateGraphArtifactContent(input.content);
        const contract = ports.artifactContract("artifact.revise");
        const editorSource = input.editor_source ?? "system";
        const value = await ports.runArtifactMutation({ trustedContext: context, inputSummary: `Revise artifact: ${artifact.title}`, operationName: contract.id, proposedEffects: contract.proposed_effects, targetResourceRefs: [artifact.file_ref], execute: async (operation) => {
          const created = await ports.createArtifactRevision({ artifactId: artifact.id, content: input.content, producerRunId: context.runId, extension: input.extension, baseRevisionId: input.base_revision_id, expectedRevision: input.expected_revision, editorSource, changeSummary: input.change_summary, provenance: input.provenance });
          const rollbackPoint = await ports.createArtifactRollback(operation, [artifact.file_ref, created.revision.file_ref], { artifact: jsonRecord(artifact) }, { artifact: jsonRecord(created.artifact) });
          return { resource: created.artifact, ref: created.artifact.file_ref, rollbackPoint, summary: `Created revision of ${artifact.title}.`, extra: { revision: created.revision } };
        }});
        return { ok: true, value };
      }
    };
  }
});

export default artifactRevise;

function jsonRecord(artifact: ArtifactRecord): Record<string, JsonValue> { return JSON.parse(JSON.stringify(artifact)) as Record<string, JsonValue>; }
