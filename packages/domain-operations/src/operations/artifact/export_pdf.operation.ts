// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import type { ActivityInboxItem, ArtifactRecord, JsonValue, OperationRecord, ResourceRef, RollbackPoint } from "@samurai-agent/core-schemas";
import { defineCommand, trustedCreatorId, type DomainResult, type TrustedDomainContext } from "../../definition/index.js";
import { artifactWriteValueSchema } from "../../value-objects/artifact.js";

const Input = z.object({ "artifact_id": z.string().trim().min(1) }).strict();
const Output = artifactWriteValueSchema;

export interface ArtifactExportPdfPorts {
  artifactContract(id: "artifact.export_pdf"): { id: string; proposed_effects: string[] };
  getArtifact(id: string): Promise<ArtifactRecord | undefined>; readArtifactContent(id: string): Promise<string | undefined>;
  exportArtifactPdf(input: { title: string; content: string; source: ArtifactRecord }): Promise<{ adapterId: string; bytes: Uint8Array }>;
  artifactNotFoundError(): Error; artifactPdfSourceNotTextError(): Error; artifactPdfInvalidResultError(): Error;
  createArtifactDraft(input: { operation: OperationRecord; title: string; content: { bytes: Uint8Array; mime_type: "application/pdf"; extension: "pdf"; preview: string }; kind: "pdf"; locale: ArtifactRecord["locale"]; sourceLocales: ArtifactRecord["source_locales"]; createdBy: string; metadata: Record<string, JsonValue> }): Promise<ArtifactRecord>;
  createArtifactRollback(operation: OperationRecord, refs: ResourceRef[], before: Record<string, JsonValue>, after: Record<string, JsonValue>): Promise<RollbackPoint>;
  runArtifactMutation(input: { trustedContext: TrustedDomainContext; inputSummary: string; operationName: string; proposedEffects: string[]; targetResourceRefs: ResourceRef[]; execute(operation: OperationRecord): Promise<{ resource: ArtifactRecord; ref: ResourceRef; rollbackPoint?: RollbackPoint; summary: string; extra: Record<string, never> }> }): Promise<{ resource: ArtifactRecord; operation: OperationRecord; rollbackPoint?: RollbackPoint; activity: ActivityInboxItem[] }>;
}

const artifactExportPdf = defineCommand<ArtifactExportPdfPorts>()({
  ...{
  "kind": "command",
  "id": "artifact.export_pdf",
  "version": "4.0",
  "availability": "active",
  "runtimeRequirements": ["pdf_export"],
  "title": "Export PDF",
  "description": "Export a text Artifact through a configured PDF adapter while preserving source revision provenance.",
  "sources": [
    "runtime_api",
    "provider_tool_call",
    "surface_operation"
  ],
  "effect": "workspace_mutation",
  "idempotency": "required",
  "concurrency": "none",
  "render": [
    "artifact"
  ],
  "resourceKinds": [
    "artifact"
  ],
  "proposedEffects": [
    "Create a PDF Artifact from the selected source Artifact."
  ],
  "outputResourceKind": "artifact",
  "uiDisplayCategory": "artifact",
  "providerToolNames": [
    "artifact.export_pdf",
    "samurai.artifact.export_pdf"
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
      execute: async function handleArtifactExportPdf(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        const source = await ports.getArtifact(input.artifact_id);
        if (!source) throw ports.artifactNotFoundError();
        const content = await ports.readArtifactContent(input.artifact_id);
        if (content === undefined) throw ports.artifactPdfSourceNotTextError();
        const exported = await ports.exportArtifactPdf({ title: source.title, content, source });
        if (!isPdf(exported.bytes)) throw ports.artifactPdfInvalidResultError();
        const contract = ports.artifactContract("artifact.export_pdf");
        const value = await ports.runArtifactMutation({ trustedContext: context, inputSummary: `Export PDF: ${source.title}`, operationName: contract.id, proposedEffects: contract.proposed_effects, targetResourceRefs: [source.file_ref], execute: async (operation) => {
          const pdf = await ports.createArtifactDraft({ operation, title: `${source.title}.pdf`, content: { bytes: exported.bytes, mime_type: "application/pdf", extension: "pdf", preview: source.title }, kind: "pdf", locale: source.locale, sourceLocales: source.source_locales, createdBy: trustedCreatorId(context), metadata: { source_artifact_id: source.id, source_revision_id: typeof source.metadata.current_revision_id === "string" ? source.metadata.current_revision_id : null, export_adapter_id: exported.adapterId } });
          const rollbackPoint = await ports.createArtifactRollback(operation, [source.file_ref, pdf.file_ref], {}, { artifact_id: pdf.id, source_artifact_id: source.id });
          return { resource: pdf, ref: pdf.file_ref, rollbackPoint, summary: `Exported ${source.title} as PDF.`, extra: {} };
        }});
        return { ok: true, value };
      }
    };
  }
});

export default artifactExportPdf;

function isPdf(bytes: Uint8Array): boolean { return bytes.byteLength >= 8 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d; }
