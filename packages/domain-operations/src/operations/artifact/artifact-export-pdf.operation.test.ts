import { describe, expect, it, vi } from "vitest";
import type { ArtifactRecord } from "@samurai-agent/core-schemas";
import type { TrustedDomainContext } from "../../definition/index.js";
import artifactExportPdf from "./export_pdf.operation.js";

const context: TrustedDomainContext = { inputSource: "runtime_api", workspaceId: "workspace_test", actorId: "actor_test", correlationId: "correlation_test" };
const now = "2026-01-01T00:00:00.000Z";
const source: ArtifactRecord = { id: "artifact_1", title: "Report", kind: "markdown", locale: "ja", source_locales: ["ja"], file_ref: { kind: "artifact", id: "artifact_1", uri: "artifacts/report.md" }, metadata: { current_revision_id: "revision_1" }, source_operation_id: "operation_1", created_by: "backend", created_at: now, updated_at: now };
const pdf: ArtifactRecord = { ...source, id: "artifact_pdf", title: "Report.pdf", kind: "pdf", file_ref: { kind: "artifact", id: "artifact_pdf", uri: "artifacts/report.pdf" }, created_by: "pdf_export_adapter" };
const operation = { id: "operation_2" } as never;

describe("artifact.export_pdf handler", () => {
  it("validates PDF output before recording the created artifact", async () => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
    const createArtifactDraft = vi.fn(async () => pdf);
    const handler = artifactExportPdf.createHandler({
      artifactContract: () => ({ id: "artifact.export_pdf", proposed_effects: ["Export PDF"] }), getArtifact: async () => source,
      readArtifactContent: async () => "# Report", exportArtifactPdf: async () => ({ adapterId: "pdf_adapter", bytes }),
      artifactNotFoundError: () => new Error("artifact_not_found"), artifactPdfSourceNotTextError: () => new Error("source_not_text"),
      artifactPdfInvalidResultError: () => new Error("invalid_pdf"), createArtifactDraft, createArtifactRollback: async () => ({ id: "rollback_1" }) as never,
      runArtifactMutation: async (input) => { const executed = await input.execute(operation); return { resource: executed.resource, operation, rollbackPoint: executed.rollbackPoint, activity: [] }; }
    });

    const result = await handler.execute(context, { artifact_id: source.id });

    expect(createArtifactDraft).toHaveBeenCalledWith(expect.objectContaining({ title: "Report.pdf", kind: "pdf", metadata: { source_artifact_id: source.id, source_revision_id: "revision_1", export_adapter_id: "pdf_adapter" } }));
    expect(result.value.resource.id).toBe(pdf.id);
  });

  it("rejects invalid adapter bytes before beginning a mutation", async () => {
    const runArtifactMutation = vi.fn();
    const handler = artifactExportPdf.createHandler({
      artifactContract: () => ({ id: "artifact.export_pdf", proposed_effects: [] }), getArtifact: async () => source,
      readArtifactContent: async () => "body", exportArtifactPdf: async () => ({ adapterId: "bad", bytes: new Uint8Array([1, 2, 3]) }),
      artifactNotFoundError: () => new Error("artifact_not_found"), artifactPdfSourceNotTextError: () => new Error("source_not_text"),
      artifactPdfInvalidResultError: () => new Error("invalid_pdf"), createArtifactDraft: async () => pdf, createArtifactRollback: async () => ({ id: "rollback_1" }) as never,
      runArtifactMutation
    });

    await expect(handler.execute(context, { artifact_id: source.id })).rejects.toThrow("invalid_pdf");
    expect(runArtifactMutation).not.toHaveBeenCalled();
  });
});
