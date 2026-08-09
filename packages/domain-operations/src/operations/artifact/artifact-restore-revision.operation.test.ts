import { describe, expect, it, vi } from "vitest";
import type { ArtifactRecord, ArtifactRevisionRecord } from "@samurai-agent/core-schemas";
import type { TrustedDomainContext } from "../../definition/index.js";
import artifactRestoreRevision from "./restore_revision.operation.js";

const context: TrustedDomainContext = { inputSource: "runtime_api", workspaceId: "workspace_test", actorId: "actor_test", correlationId: "correlation_test" };
const now = "2026-01-01T00:00:00.000Z";
const artifact: ArtifactRecord = { id: "artifact_1", title: "Notes", kind: "markdown", locale: "ja", source_locales: ["ja"], file_ref: { kind: "artifact", id: "artifact_1", uri: "artifacts/notes.md" }, metadata: { current_revision_id: "revision_2" }, source_operation_id: "operation_create", created_by: "backend", created_at: now, updated_at: now };
const sourceRevision: ArtifactRevisionRecord = { id: "revision_1", artifact_id: artifact.id, revision: 1, file_ref: { kind: "artifact_revision", id: "revision_1", uri: "artifacts/revisions/1.md" }, blob_ref: { kind: "blob", id: "blob_1", uri: "blobs/1" }, content_hash: "hash_1", content_bytes: 4, provenance: {}, created_at: now };
const createdRevision: ArtifactRevisionRecord = { ...sourceRevision, id: "revision_3", revision: 3, parent_revision_id: "revision_2", editor_source: "restore" };
const operation = { id: "operation_1" } as never;

describe("artifact.restore_revision handler", () => {
  it("owns source validation and immutable revision creation", async () => {
    const createArtifactRevision = vi.fn(async () => ({ artifact: { ...artifact, metadata: { current_revision_id: createdRevision.id } }, revision: createdRevision }));
    const handler = artifactRestoreRevision.createHandler({
      artifactContract: () => ({ id: "artifact.restore_revision", proposed_effects: ["Restore"] }),
      getArtifact: async () => artifact, getArtifactRevision: async () => sourceRevision,
      readArtifactRevisionContent: async () => new Uint8Array([1, 2, 3, 4]), createArtifactRevision,
      createArtifactRollback: async () => ({ id: "rollback_1" }) as never,
      artifactRevisionNotFoundError: () => new Error("revision_not_found"), artifactRevisionContentNotFoundError: () => new Error("content_not_found"),
      runArtifactMutation: async (input) => { const executed = await input.execute(operation); return { resource: executed.resource, operation, rollbackPoint: executed.rollbackPoint, activity: [], ...executed.extra }; }
    });

    const result = await handler.execute(context, { artifact_id: artifact.id, revision_id: sourceRevision.id });

    expect(createArtifactRevision).toHaveBeenCalledWith(expect.objectContaining({ artifactId: artifact.id, baseRevisionId: "revision_2", editorSource: "restore", provenance: { restored_from_revision_id: sourceRevision.id } }));
    expect(result.value.revision.id).toBe("revision_3");
  });

  it("rejects a revision owned by another artifact before reading content", async () => {
    const readArtifactRevisionContent = vi.fn();
    const handler = artifactRestoreRevision.createHandler({
      artifactContract: () => ({ id: "artifact.restore_revision", proposed_effects: [] }), getArtifact: async () => artifact,
      getArtifactRevision: async () => ({ ...sourceRevision, artifact_id: "other" }), readArtifactRevisionContent,
      createArtifactRevision: async () => ({ artifact, revision: createdRevision }), createArtifactRollback: async () => ({ id: "rollback_1" }) as never,
      artifactRevisionNotFoundError: () => new Error("revision_not_found"), artifactRevisionContentNotFoundError: () => new Error("content_not_found"),
      runArtifactMutation: async () => { throw new Error("unexpected"); }
    });

    await expect(handler.execute(context, { artifact_id: artifact.id, revision_id: sourceRevision.id })).rejects.toThrow("revision_not_found");
    expect(readArtifactRevisionContent).not.toHaveBeenCalled();
  });
});
