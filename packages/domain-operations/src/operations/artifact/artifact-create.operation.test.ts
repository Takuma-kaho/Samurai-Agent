import { describe, expect, it, vi } from "vitest";
import type { ArtifactRecord } from "@samurai-agent/core-schemas";
import type { TrustedDomainContext } from "../../definition/index.js";
import artifactCreate from "./create.operation.js";

const context: TrustedDomainContext = { inputSource: "runtime_api", workspaceId: "workspace_test", actorId: "actor_test", correlationId: "correlation_test" };
const now = "2026-01-01T00:00:00.000Z";
const artifact: ArtifactRecord = { id: "artifact_1", title: "Notes", kind: "markdown", locale: "ja", source_locales: ["ja"], file_ref: { kind: "artifact", id: "artifact_1", uri: "artifacts/notes.md" }, metadata: {}, source_operation_id: "operation_1", created_by: "backend", created_at: now, updated_at: now };
const operation = { id: "operation_1" } as never;

function createPorts(overrides: Partial<Parameters<typeof artifactCreate.createHandler>[0]> = {}) {
  const createArtifactDraft = vi.fn(async () => artifact);
  const runArtifactMutation = vi.fn(async (input: Parameters<Parameters<typeof artifactCreate.createHandler>[0]["runArtifactMutation"]>[0]) => {
    const executed = await input.execute(operation);
    return { resource: executed.resource, operation, rollbackPoint: executed.rollbackPoint, activity: [] };
  });
  return {
    ports: {
      artifactContract: () => ({ id: "artifact.create", proposed_effects: ["Create"] }),
      artifactDefaultLocales: async () => ({ inputLocale: "ja", outputLocale: "ja" }),
      validateGraphArtifactContent: () => undefined,
      createArtifactDraft,
      createArtifactRollback: async () => ({ id: "rollback_1" }) as never,
      runArtifactMutation,
      ...overrides
    },
    createArtifactDraft,
    runArtifactMutation
  };
}

describe("artifact.create handler", () => {
  it("persists through the mutation port without a Session", async () => {
    const fixture = createPorts();
    const handler = artifactCreate.createHandler(fixture.ports);

    const result = await handler.execute(context, artifactCreate.input.parse({ title: "Notes", content: "Body" }));

    expect(fixture.createArtifactDraft).toHaveBeenCalledWith(expect.objectContaining({ title: "Notes", content: "Body", locale: "ja", sourceLocales: ["ja"], createdBy: "actor_test" }));
    expect(fixture.runArtifactMutation).toHaveBeenCalledWith(expect.objectContaining({ trustedContext: context, inputSummary: "Create artifact: Notes" }));
    expect(result.value).toMatchObject({ resource: artifact });
  });

  it("keeps an optional SessionRef only in trusted context", async () => {
    const fixture = createPorts();
    const handler = artifactCreate.createHandler(fixture.ports);
    const contextWithSessionRef: TrustedDomainContext = {
      ...context,
      participant: { kind: "human", participantId: "human:trusted-creator" },
      sessionRef: { app_id: "native_app", session_id: "session_1" }
    };

    await handler.execute(contextWithSessionRef, artifactCreate.input.parse({ title: "Notes", content: "Body", kind: "markdown" }));

    expect(fixture.runArtifactMutation).toHaveBeenCalledWith(expect.objectContaining({ trustedContext: contextWithSessionRef }));
    expect(fixture.createArtifactDraft).toHaveBeenCalledWith(expect.objectContaining({ createdBy: "human:trusted-creator" }));
  });

  it("validates graph content before creating a session or mutation", async () => {
    const fixture = createPorts({ validateGraphArtifactContent: () => { throw new Error("graph_invalid"); } });
    const handler = artifactCreate.createHandler(fixture.ports);

    await expect(handler.execute(context, artifactCreate.input.parse({ title: "Graph", content: "invalid", kind: "graph" }))).rejects.toThrow("graph_invalid");

    expect(fixture.runArtifactMutation).not.toHaveBeenCalled();
  });
});
