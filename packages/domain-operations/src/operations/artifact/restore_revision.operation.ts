// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import type { ActivityInboxItem, ArtifactRecord, ArtifactRevisionRecord, JsonValue, MessageEnvelope, OperationRecord, ResourceRef, RollbackPoint, SessionRecord } from "@samurai-agent/core-schemas";
import { defineCommand, type DomainResult, type TrustedDomainContext } from "../../definition/index.js";
import { artifactRevisionWriteValueSchema } from "../../value-objects/artifact.js";

const Input = z.object({
  "artifact_id": z.string().trim().min(1),
  "base_revision_id": z.string().trim().min(1).optional(),
  "change_summary": z.string().trim().min(1).optional(),
  "revision_id": z.string().trim().min(1)
}).strict();
const Output = artifactRevisionWriteValueSchema;

export interface ArtifactRestoreRevisionPorts {
  artifactContract(id: "artifact.restore_revision"): { id: string; proposed_effects: string[] };
  getArtifact(id: string): Promise<ArtifactRecord | undefined>;
  getArtifactRevision(id: string): Promise<ArtifactRevisionRecord | undefined>;
  readArtifactRevisionContent(id: string): Promise<Uint8Array | undefined>;
  ensureArtifactSession(): Promise<SessionRecord>; createArtifactEnvelope(session: SessionRecord, content: string): MessageEnvelope;
  createArtifactRevision(input: { artifactId: string; content: Uint8Array; baseRevisionId?: string; editorSource: "restore"; changeSummary: string; provenance: Record<string, JsonValue> }): Promise<{ artifact: ArtifactRecord; revision: ArtifactRevisionRecord }>;
  createArtifactRollback(operation: OperationRecord, refs: ResourceRef[], before: Record<string, JsonValue>, after: Record<string, JsonValue>): Promise<RollbackPoint>;
  artifactRevisionNotFoundError(): Error; artifactRevisionContentNotFoundError(): Error;
  runArtifactMutation(input: { session: SessionRecord; envelope: MessageEnvelope; operationName: string; proposedEffects: string[]; targetResourceRefs: ResourceRef[]; execute(operation: OperationRecord): Promise<{ resource: ArtifactRecord; ref: ResourceRef; rollbackPoint?: RollbackPoint; summary: string; extra: { revision: ArtifactRevisionRecord } }> }): Promise<{ resource: ArtifactRecord; operation: OperationRecord; rollbackPoint?: RollbackPoint; activity: ActivityInboxItem[]; revision: ArtifactRevisionRecord }>;
}

const artifactRestoreRevision = defineCommand<ArtifactRestoreRevisionPorts>()({
  ...{
  "kind": "command",
  "id": "artifact.restore_revision",
  "version": "2.0",
  "availability": "active",
  "title": "Restore artifact revision",
  "description": "Restore an earlier immutable revision by creating a new revision from it.",
  "sources": [
    "runtime_api",
    "provider_tool_call",
    "surface_operation"
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
    "Create a new current Artifact revision from an earlier revision."
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
      execute: async function handleArtifactRestoreRevision(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        const contract = ports.artifactContract("artifact.restore_revision");
        const artifact = await ports.getArtifact(input.artifact_id);
        const sourceRevision = await ports.getArtifactRevision(input.revision_id);
        if (!artifact || !sourceRevision || sourceRevision.artifact_id !== input.artifact_id) throw ports.artifactRevisionNotFoundError();
        const content = await ports.readArtifactRevisionContent(input.revision_id);
        if (!content) throw ports.artifactRevisionContentNotFoundError();
        const session = await ports.ensureArtifactSession();
        const envelope = ports.createArtifactEnvelope(session, `Restore artifact revision: ${artifact.title}`);
        const value = await ports.runArtifactMutation({ session, envelope, operationName: contract.id, proposedEffects: contract.proposed_effects, targetResourceRefs: [artifact.file_ref, sourceRevision.file_ref], execute: async (operation) => {
          const created = await ports.createArtifactRevision({ artifactId: input.artifact_id, content, baseRevisionId: input.base_revision_id ?? currentRevisionId(artifact), editorSource: "restore", changeSummary: input.change_summary ?? `Restored revision ${sourceRevision.revision}.`, provenance: { restored_from_revision_id: sourceRevision.id } });
          const rollbackPoint = await ports.createArtifactRollback(operation, [artifact.file_ref, created.revision.file_ref], { artifact: jsonRecord(artifact) }, { artifact: jsonRecord(created.artifact) });
          return { resource: created.artifact, ref: created.artifact.file_ref, rollbackPoint, summary: `Restored revision ${sourceRevision.revision} of ${artifact.title}.`, extra: { revision: created.revision } };
        }});
        return { ok: true, value };
      }
    };
  }
});

export default artifactRestoreRevision;

function currentRevisionId(artifact: ArtifactRecord): string | undefined { return typeof artifact.metadata.current_revision_id === "string" ? artifact.metadata.current_revision_id : undefined; }
function jsonRecord(artifact: ArtifactRecord): Record<string, JsonValue> { return JSON.parse(JSON.stringify(artifact)) as Record<string, JsonValue>; }
