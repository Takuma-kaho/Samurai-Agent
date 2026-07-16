import { describe, expect, it, vi } from "vitest";
import type { ArtifactRecord, ArtifactRevisionRecord } from "@samurai-agent/core-schemas";
import type { TrustedDomainContext } from "../../definition/index.js";
import graphPatch from "./patch.operation.js";

const context: TrustedDomainContext = { inputSource: "surface_operation", workspaceId: "workspace_test", actorId: "actor_test", correlationId: "correlation_test" };
const now = "2026-01-01T00:00:00.000Z";
const artifact: ArtifactRecord = { id: "graph_1", title: "Graph", kind: "graph", locale: "ja", source_locales: ["ja"], file_ref: { kind: "artifact", id: "graph_1", uri: "artifacts/graph.json" }, metadata: { current_revision_id: "revision_1" }, source_operation_id: "operation_1", created_by: "backend", created_at: now, updated_at: now };
const revision: ArtifactRevisionRecord = { id: "revision_2", artifact_id: artifact.id, revision: 2, file_ref: { kind: "artifact_revision", id: "revision_2", uri: "artifacts/revisions/2.json" }, blob_ref: { kind: "blob", id: "blob_2", uri: "blobs/2" }, content_hash: "hash", content_bytes: 10, provenance: {}, created_at: now };
const current = JSON.stringify({ version: "1", nodes: [{ id: "a", label: "A" }, { id: "b", label: "B" }], edges: [{ id: "ab", source: "a", target: "b" }] });
const session = { id: "session_1" } as never;
const envelope = { id: "envelope_1" } as never;
const operation = { id: "operation_2" } as never;

describe("graph.patch handler", () => {
  it("owns partial graph merge, validation, revision creation, and rollback", async () => {
    const createArtifactRevision = vi.fn(async () => ({ artifact, revision }));
    const handler = graphPatch.createHandler({
      artifactContract: () => ({ id: "graph.patch", proposed_effects: ["Patch graph"] }), getArtifact: async () => artifact,
      readArtifactContent: async () => current, graphArtifactNotFoundError: () => new Error("graph_not_found"),
      graphDocumentContentNotFoundError: () => new Error("content_not_found"), graphDocumentInvalidError: () => new Error("graph_invalid"),
      ensureArtifactSession: async () => session, createArtifactEnvelope: () => envelope, createArtifactRevision,
      createArtifactRollback: async () => ({ id: "rollback_1" }) as never,
      runArtifactMutation: async (input) => { const executed = await input.execute(operation); return { resource: executed.resource, operation, rollbackPoint: executed.rollbackPoint, activity: [], ...executed.extra }; }
    });
    const input = graphPatch.input.parse({ artifact_id: artifact.id, nodes: [{ id: "a", label: "Updated A" }] });

    await handler.execute(context, input);

    const revisionInput = createArtifactRevision.mock.calls[0][0];
    expect(JSON.parse(revisionInput.content).nodes).toEqual([{ id: "a", label: "Updated A" }, { id: "b", label: "B" }]);
    expect(revisionInput).toMatchObject({ baseRevisionId: "revision_1", editorSource: "surface", extension: "json" });
  });

  it("rejects a patch that leaves an edge pointing to a deleted node", async () => {
    const runArtifactMutation = vi.fn();
    const handler = graphPatch.createHandler({
      artifactContract: () => ({ id: "graph.patch", proposed_effects: [] }), getArtifact: async () => artifact,
      readArtifactContent: async () => current, graphArtifactNotFoundError: () => new Error("graph_not_found"),
      graphDocumentContentNotFoundError: () => new Error("content_not_found"), graphDocumentInvalidError: () => new Error("graph_invalid"),
      ensureArtifactSession: async () => session, createArtifactEnvelope: () => envelope,
      createArtifactRevision: async () => ({ artifact, revision }), createArtifactRollback: async () => ({ id: "rollback_1" }) as never,
      runArtifactMutation
    });

    await expect(handler.execute(context, graphPatch.input.parse({ artifact_id: artifact.id, delete_node_ids: ["b"] }))).rejects.toThrow("graph_invalid");
    expect(runArtifactMutation).not.toHaveBeenCalled();
  });
});
