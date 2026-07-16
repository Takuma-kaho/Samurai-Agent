import { describe, expect, it, vi } from "vitest";
import type { ArtifactRecord } from "@samurai-agent/core-schemas";
import type { TrustedDomainContext } from "../../definition/index.js";
import graphCreate from "./create.operation.js";

const context: TrustedDomainContext = { inputSource: "runtime_api", workspaceId: "workspace_test", actorId: "actor_test", correlationId: "correlation_test" };
const now = "2026-01-01T00:00:00.000Z";
const session = { id: "session_1", ui_locale: "ja", output_locale: "ja" } as never;
const artifact: ArtifactRecord = { id: "graph_1", title: "Graph", kind: "graph", locale: "ja", source_locales: ["ja"], file_ref: { kind: "artifact", id: "graph_1", uri: "artifacts/graph.json" }, metadata: {}, source_operation_id: "operation_1", created_by: "backend", created_at: now, updated_at: now };
const envelope = { id: "envelope_1" } as never;
const operation = { id: "operation_1" } as never;
const content = JSON.stringify({ version: "1", nodes: [{ id: "a", label: "A" }], edges: [] });

describe("graph.create handler", () => {
  it("owns validation, session creation, and persisted graph creation", async () => {
    const validateGraphArtifactContent = vi.fn();
    const createArtifactSession = vi.fn(async () => session);
    const createArtifactDraft = vi.fn(async () => artifact);
    const handler = graphCreate.createHandler({
      artifactContract: () => ({ id: "graph.create", proposed_effects: ["Create graph"] }), validateGraphArtifactContent,
      createArtifactSession, getArtifactSession: async () => session, artifactSessionNotFoundError: () => new Error("session_not_found"),
      createArtifactEnvelope: () => envelope, createArtifactDraft, createArtifactRollback: async () => ({ id: "rollback_1" }) as never,
      runArtifactMutation: async (input) => { const executed = await input.execute(operation); return { resource: executed.resource, operation, rollbackPoint: executed.rollbackPoint, activity: [] }; }
    });
    const input = graphCreate.input.parse({ content, title: "Graph" });

    const result = await handler.execute(context, input);

    expect(validateGraphArtifactContent).toHaveBeenCalledWith(content);
    expect(createArtifactSession).toHaveBeenCalledWith({ title: "Graph", ui_locale: undefined, output_locale: undefined });
    expect(createArtifactDraft).toHaveBeenCalledWith(expect.objectContaining({ kind: "graph", content, locale: "ja", sourceLocales: ["ja"] }));
    expect(result.value.resource.id).toBe(artifact.id);
  });

  it("stops before session creation when graph validation fails", async () => {
    const createArtifactSession = vi.fn(async () => session);
    const handler = graphCreate.createHandler({
      artifactContract: () => ({ id: "graph.create", proposed_effects: [] }), validateGraphArtifactContent: () => { throw new Error("graph_invalid"); },
      createArtifactSession, getArtifactSession: async () => session, artifactSessionNotFoundError: () => new Error("session_not_found"),
      createArtifactEnvelope: () => envelope, createArtifactDraft: async () => artifact, createArtifactRollback: async () => ({ id: "rollback_1" }) as never,
      runArtifactMutation: async () => { throw new Error("unexpected"); }
    });

    await expect(handler.execute(context, graphCreate.input.parse({ content }))).rejects.toThrow("graph_invalid");
    expect(createArtifactSession).not.toHaveBeenCalled();
  });
});
