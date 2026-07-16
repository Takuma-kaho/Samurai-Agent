import { describe, expect, it, vi } from "vitest";
import type { ArtifactRecord, ArtifactRevisionRecord } from "@samurai-agent/core-schemas";
import type { TrustedDomainContext } from "../../definition/index.js";
import imageEdit from "./edit.operation.js";

const context: TrustedDomainContext = { inputSource: "provider_tool_call", workspaceId: "workspace_test", actorId: "actor_test", correlationId: "correlation_test" };
const now = "2026-01-01T00:00:00.000Z";
const artifact: ArtifactRecord = { id: "image_1", title: "Source", kind: "image", locale: "ja", source_locales: ["ja"], file_ref: { kind: "artifact", id: "image_1", uri: "artifacts/source.png" }, metadata: { current_revision_id: "revision_1" }, source_operation_id: "operation_1", created_by: "image_provider", created_at: now, updated_at: now };
const revision: ArtifactRevisionRecord = { id: "revision_2", artifact_id: artifact.id, revision: 2, parent_revision_id: "revision_1", file_ref: { kind: "artifact_revision", id: "revision_2", uri: "artifacts/revisions/2.png" }, blob_ref: { kind: "blob", id: "blob_2", uri: "blobs/2" }, content_hash: "hash", content_bytes: 3, provenance: {}, created_at: now };
const session = { id: "session_1" } as never;
const envelope = { id: "envelope_1" } as never;
const operation = { id: "operation_2" } as never;

describe("image.edit handler", () => {
  it("owns image-kind validation, revision creation, and rollback", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const createArtifactRevision = vi.fn(async () => ({ artifact: { ...artifact, metadata: { current_revision_id: revision.id } }, revision }));
    const handler = imageEdit.createHandler({
      artifactContract: () => ({ id: "image.edit", proposed_effects: ["Edit image"] }), getArtifact: async () => artifact,
      imageArtifactNotFoundError: () => new Error("image_not_found"), ensureArtifactSession: async () => session,
      createArtifactEnvelope: () => envelope, decodeImageBase64: () => bytes, createArtifactRevision,
      createArtifactRollback: async () => ({ id: "rollback_1" }) as never,
      runArtifactMutation: async (input) => { const executed = await input.execute(operation); return { resource: executed.resource, operation, rollbackPoint: executed.rollbackPoint, activity: [], ...executed.extra }; }
    });
    const input = imageEdit.input.parse({ artifact_id: artifact.id, data_base64: "AQID", height: 10, mime_type: "image/png", prompt: "Add clouds", provider: "provider_1", source_run_id: "run_1", width: 20 });

    const result = await handler.execute(context, input);

    expect(createArtifactRevision).toHaveBeenCalledWith(expect.objectContaining({ artifactId: artifact.id, baseRevisionId: "revision_1", producerRunId: "run_1", provenance: expect.objectContaining({ operation: "edit", source_asset_id: artifact.id }) }));
    expect(result.value.revision.id).toBe(revision.id);
  });

  it("rejects a non-image artifact before decoding provider data", async () => {
    const decodeImageBase64 = vi.fn();
    const handler = imageEdit.createHandler({
      artifactContract: () => ({ id: "image.edit", proposed_effects: [] }), getArtifact: async () => ({ ...artifact, kind: "markdown" }),
      imageArtifactNotFoundError: () => new Error("image_not_found"), ensureArtifactSession: async () => session,
      createArtifactEnvelope: () => envelope, decodeImageBase64,
      createArtifactRevision: async () => ({ artifact, revision }), createArtifactRollback: async () => ({ id: "rollback_1" }) as never,
      runArtifactMutation: async () => { throw new Error("unexpected"); }
    });
    const input = imageEdit.input.parse({ artifact_id: artifact.id, data_base64: "AQID", height: 10, mime_type: "image/png", prompt: "x", provider: "p", source_run_id: "r", width: 10 });

    await expect(handler.execute(context, input)).rejects.toThrow("image_not_found");
    expect(decodeImageBase64).not.toHaveBeenCalled();
  });
});
