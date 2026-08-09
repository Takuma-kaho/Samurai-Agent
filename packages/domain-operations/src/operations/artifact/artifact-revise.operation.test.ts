import { describe, expect, it, vi } from "vitest";
import type { ArtifactRecord, ArtifactRevisionRecord } from "@samurai-agent/core-schemas";
import type { TrustedDomainContext } from "../../definition/index.js";
import artifactRevise from "./revise.operation.js";

const context: TrustedDomainContext = { inputSource: "provider_tool_call", workspaceId: "workspace_test", actorId: "actor_test", correlationId: "correlation_test" };
const contextWithRun: TrustedDomainContext = { ...context, runId: "run_1" };
const now = "2026-01-01T00:00:00.000Z";
const artifact: ArtifactRecord = { id: "artifact_1", title: "Notes", kind: "markdown", locale: "ja", source_locales: ["ja"], file_ref: { kind: "artifact", id: "artifact_1", uri: "artifacts/notes.md" }, metadata: {}, source_operation_id: "operation_1", created_by: "backend", created_at: now, updated_at: now };
const revision: ArtifactRevisionRecord = { id: "revision_1", artifact_id: artifact.id, revision: 1, file_ref: { kind: "artifact_revision", id: "revision_1", uri: "artifacts/revisions/1.md" }, blob_ref: { kind: "blob", id: "blob_1", uri: "blobs/1" }, content_hash: "hash", content_bytes: 4, provenance: {}, created_at: now };
const operation = { id: "operation_2" } as never;

describe("artifact.revise handler", () => {
  it("uses trusted context, revision creation, and rollback without a Session", async () => {
    const createArtifactRevision = vi.fn(async () => ({ artifact, revision }));
    const handler = artifactRevise.createHandler({
      artifactContract: () => ({ id: "artifact.revise", proposed_effects: ["Revise"] }), getArtifact: async () => artifact,
      artifactNotFoundError: () => new Error("artifact_not_found"), validateGraphArtifactContent: () => undefined,
      createArtifactRevision, createArtifactRollback: async () => ({ id: "rollback_1" }) as never,
      runArtifactMutation: async (input) => { const executed = await input.execute(operation); return { resource: executed.resource, operation, rollbackPoint: executed.rollbackPoint, activity: [], ...executed.extra }; }
    });

    const result = await handler.execute(contextWithRun, artifactRevise.input.parse({ artifact_id: artifact.id, content: "New body", editor_source: "provider" }));

    expect(createArtifactRevision).toHaveBeenCalledWith(expect.objectContaining({ artifactId: artifact.id, content: "New body", editorSource: "provider", producerRunId: "run_1" }));
    expect(result.value.revision.id).toBe(revision.id);
  });

  it("validates graph content before starting a mutation", async () => {
    const validateGraphArtifactContent = vi.fn(() => { throw new Error("graph_invalid"); });
    const runArtifactMutation = vi.fn();
    const handler = artifactRevise.createHandler({
      artifactContract: () => ({ id: "artifact.revise", proposed_effects: [] }), getArtifact: async () => ({ ...artifact, kind: "graph" }),
      artifactNotFoundError: () => new Error("artifact_not_found"), validateGraphArtifactContent,
      createArtifactRevision: async () => ({ artifact, revision }), createArtifactRollback: async () => ({ id: "rollback_1" }) as never,
      runArtifactMutation
    });

    await expect(handler.execute(context, artifactRevise.input.parse({ artifact_id: artifact.id, content: "invalid" }))).rejects.toThrow("graph_invalid");
    expect(runArtifactMutation).not.toHaveBeenCalled();
  });
});
