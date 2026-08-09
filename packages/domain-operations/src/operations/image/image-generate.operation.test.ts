import { describe, expect, it, vi } from "vitest";
import type { ArtifactRecord, ArtifactRevisionRecord } from "@samurai-agent/core-schemas";
import type { TrustedDomainContext } from "../../definition/index.js";
import imageGenerate from "./generate.operation.js";

const context: TrustedDomainContext = { inputSource: "provider_tool_call", workspaceId: "workspace_test", actorId: "actor_test", correlationId: "correlation_test" };
const now = "2026-01-01T00:00:00.000Z";
const artifact: ArtifactRecord = { id: "image_1", title: "Generated image", kind: "image", locale: "ja", source_locales: ["ja"], file_ref: { kind: "artifact", id: "image_1", uri: "artifacts/image.png" }, metadata: {}, source_operation_id: "operation_1", created_by: "image_provider", created_at: now, updated_at: now };
const revision: ArtifactRevisionRecord = { id: "revision_1", artifact_id: artifact.id, revision: 1, file_ref: { kind: "artifact_revision", id: "revision_1", uri: "artifacts/revisions/1.png" }, blob_ref: { kind: "blob", id: "blob_1", uri: "blobs/1" }, content_hash: "hash", content_bytes: 3, provenance: {}, created_at: now };
const operation = { id: "operation_1" } as never;

describe("image.generate handler", () => {
  it("owns provider-result persistence and initial revision creation", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const createArtifactDraft = vi.fn(async () => artifact);
    const createArtifactRevision = vi.fn(async () => ({ artifact, revision }));
    const handler = imageGenerate.createHandler({
      artifactContract: () => ({ id: "image.generate", proposed_effects: ["Save image"] }),
      artifactDefaultLocales: async () => ({ inputLocale: "ja", outputLocale: "ja" }),
      decodeImageBase64: () => bytes, createArtifactDraft, createArtifactRevision,
      createArtifactRollback: async () => ({ id: "rollback_1" }) as never,
      runArtifactMutation: async (input) => { const executed = await input.execute(operation); return { resource: executed.resource, operation, rollbackPoint: executed.rollbackPoint, activity: [], ...executed.extra }; }
    });
    const input = imageGenerate.input.parse({ data_base64: "AQID", height: 10, mime_type: "image/png", prompt: "A castle", provider: "provider_1", source_run_id: "run_1", width: 20 });

    const result = await handler.execute(context, input);

    expect(createArtifactDraft).toHaveBeenCalledWith(expect.objectContaining({ title: "Generated image", kind: "image", content: expect.objectContaining({ bytes, extension: "png" }) }));
    expect(createArtifactRevision).toHaveBeenCalledWith(expect.objectContaining({ artifactId: artifact.id, producerRunId: "run_1", provenance: expect.objectContaining({ operation: "generate", prompt: "A castle", width: 20, height: 10 }) }));
    expect(result.value.revision.id).toBe(revision.id);
  });

  it("rejects malformed provider data before decoding", () => {
    expect(imageGenerate.input.safeParse({ data_base64: "not base64", height: 10, mime_type: "image/png", prompt: "x", provider: "p", source_run_id: "r", width: 10 }).success).toBe(false);
  });
});
