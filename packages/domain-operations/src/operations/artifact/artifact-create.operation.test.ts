import { describe, expect, it, vi } from "vitest";
import type { ArtifactRecord } from "@samurai-agent/core-schemas";
import type { TrustedDomainContext } from "../../definition/index.js";
import artifactCreate from "./create.operation.js";

const context: TrustedDomainContext = { inputSource: "runtime_api", workspaceId: "workspace_test", actorId: "actor_test", correlationId: "correlation_test" };
const sessionContext: TrustedDomainContext = { ...context, sessionId: "session_1", envelopeId: "envelope_trusted" };
const now = "2026-01-01T00:00:00.000Z";
const session = { id: "session_1", ui_locale: "ja", output_locale: "ja" } as never;
const artifact: ArtifactRecord = { id: "artifact_1", title: "Notes", kind: "markdown", locale: "ja", source_locales: ["ja"], file_ref: { kind: "artifact", id: "artifact_1", uri: "artifacts/notes.md" }, metadata: {}, source_operation_id: "operation_1", created_by: "backend", created_at: now, updated_at: now };
const envelope = { id: "envelope_1" } as never;
const operation = { id: "operation_1" } as never;

function createPorts(overrides: Partial<Parameters<typeof artifactCreate.createHandler>[0]> = {}) {
  const createArtifactSession = vi.fn(async () => session);
  const getArtifactSession = vi.fn(async () => session);
  const createArtifactEnvelope = vi.fn(() => envelope);
  const createArtifactDraft = vi.fn(async () => artifact);
  const runArtifactMutation = vi.fn(async (input: Parameters<Parameters<typeof artifactCreate.createHandler>[0]["runArtifactMutation"]>[0]) => {
    const executed = await input.execute(operation);
    return { resource: executed.resource, operation, rollbackPoint: executed.rollbackPoint, activity: [] };
  });
  return {
    ports: {
      artifactContract: () => ({ id: "artifact.create", proposed_effects: ["Create"] }),
      createArtifactSession,
      getArtifactSession,
      artifactSessionNotFoundError: () => new Error("session_not_found"),
      validateGraphArtifactContent: () => undefined,
      createArtifactEnvelope,
      createArtifactDraft,
      createArtifactRollback: async () => ({ id: "rollback_1" }) as never,
      runArtifactMutation,
      ...overrides
    },
    createArtifactSession,
    getArtifactSession,
    createArtifactEnvelope,
    createArtifactDraft,
    runArtifactMutation
  };
}

describe("artifact.create handler", () => {
  it("creates a session only when trusted context has none, then persists through its mutation port", async () => {
    const fixture = createPorts();
    const handler = artifactCreate.createHandler(fixture.ports);

    const result = await handler.execute(context, artifactCreate.input.parse({ title: "Notes", content: "Body" }));

    expect(fixture.createArtifactSession).toHaveBeenCalledWith({ title: "Notes", output_locale: undefined });
    expect(fixture.createArtifactDraft).toHaveBeenCalledWith(expect.objectContaining({ title: "Notes", content: "Body", locale: "ja", sourceLocales: ["ja"], createdBy: "actor_test" }));
    expect(fixture.runArtifactMutation).toHaveBeenCalledOnce();
    expect(result.value).toMatchObject({ resource: artifact });
  });

  it("uses only the trusted session and envelope context instead of payload context fields", async () => {
    const fixture = createPorts();
    const handler = artifactCreate.createHandler(fixture.ports);

    await handler.execute(sessionContext, artifactCreate.input.parse({ title: "Notes", content: "Body", kind: "markdown" }));

    expect(fixture.createArtifactSession).not.toHaveBeenCalled();
    expect(fixture.getArtifactSession).toHaveBeenCalledWith("session_1");
    expect(fixture.createArtifactEnvelope).toHaveBeenCalledWith(session, "Body", "ja", "ja", {}, "envelope_trusted");
  });

  it("validates graph content before creating a session or mutation", async () => {
    const fixture = createPorts({ validateGraphArtifactContent: () => { throw new Error("graph_invalid"); } });
    const handler = artifactCreate.createHandler(fixture.ports);

    await expect(handler.execute(context, artifactCreate.input.parse({ title: "Graph", content: "invalid", kind: "graph" }))).rejects.toThrow("graph_invalid");

    expect(fixture.createArtifactSession).not.toHaveBeenCalled();
    expect(fixture.runArtifactMutation).not.toHaveBeenCalled();
  });
});
