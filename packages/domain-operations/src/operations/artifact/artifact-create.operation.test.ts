import { describe, expect, it, vi } from "vitest";
import type { ArtifactRecord } from "@samurai-agent/core-schemas";
import type { TrustedDomainContext } from "../../definition/index.js";
import artifactCreate from "./create.operation.js";

const context: TrustedDomainContext = { inputSource: "runtime_api", workspaceId: "workspace_test", actorId: "actor_test", correlationId: "correlation_test" };
const now = "2026-01-01T00:00:00.000Z";
const session = { id: "session_1", ui_locale: "ja", output_locale: "ja" } as never;
const artifact: ArtifactRecord = { id: "artifact_1", title: "Notes", kind: "markdown", locale: "ja", source_locales: ["ja"], file_ref: { kind: "artifact", id: "artifact_1", uri: "artifacts/notes.md" }, metadata: {}, source_operation_id: "operation_1", created_by: "backend", created_at: now, updated_at: now };
const envelope = { id: "envelope_1" } as never;
const operation = { id: "operation_1" } as never;

describe("artifact.create handler", () => {
  it("routes ordinary requests through the surface operation path", async () => {
    const runArtifactSurface = vi.fn(async () => ({ result_kind: "artifact" }) as never);
    const runArtifactMutation = vi.fn();
    const handler = artifactCreate.createHandler({
      artifactContract: () => ({ id: "artifact.create", proposed_effects: [] }), createArtifactSession: async () => session,
      getArtifactSession: async () => session, artifactSessionNotFoundError: () => new Error("session_not_found"),
      validateGraphArtifactContent: () => undefined, runArtifactSurface, createArtifactEnvelope: () => envelope,
      createArtifactDraft: async () => artifact, createArtifactRollback: async () => ({ id: "rollback_1" }) as never, runArtifactMutation
    });
    const input = artifactCreate.input.parse({ title: "Notes", content: "Body" });

    await handler.execute(context, input);

    expect(runArtifactSurface).toHaveBeenCalledWith(expect.objectContaining({ kind: "artifact.request", session_id: "session_1", title: "Notes", instruction: "Body" }));
    expect(runArtifactMutation).not.toHaveBeenCalled();
  });

  it("persists provider results through the recorded mutation path", async () => {
    const runArtifactSurface = vi.fn();
    const createArtifactDraft = vi.fn(async () => artifact);
    const handler = artifactCreate.createHandler({
      artifactContract: () => ({ id: "artifact.create", proposed_effects: ["Create"] }), createArtifactSession: async () => session,
      getArtifactSession: async () => session, artifactSessionNotFoundError: () => new Error("session_not_found"),
      validateGraphArtifactContent: () => undefined, runArtifactSurface, createArtifactEnvelope: () => envelope,
      createArtifactDraft, createArtifactRollback: async () => ({ id: "rollback_1" }) as never,
      runArtifactMutation: async (input) => { const executed = await input.execute(operation); return { resource: executed.resource, operation, rollbackPoint: executed.rollbackPoint, activity: [] }; }
    });
    const input = artifactCreate.input.parse({ title: "Notes", content: "Body", kind: "markdown" });

    const result = await handler.execute({ ...context, inputSource: "provider_tool_call" }, input);

    expect(runArtifactSurface).not.toHaveBeenCalled();
    expect(createArtifactDraft).toHaveBeenCalledWith(expect.objectContaining({ title: "Notes", content: "Body", kind: "markdown", locale: "ja", sourceLocales: ["ja"] }));
    expect(result.value).toMatchObject({ resource: artifact });
  });

  it("uses a supplied original surface payload without rebuilding it", async () => {
    const original = { id: "surface_1", kind: "custom_view.action", action: "save" };
    const runArtifactSurface = vi.fn(async () => ({ result_kind: "artifact" }) as never);
    const handler = artifactCreate.createHandler({
      artifactContract: () => ({ id: "artifact.create", proposed_effects: [] }), createArtifactSession: async () => session,
      getArtifactSession: async () => session, artifactSessionNotFoundError: () => new Error("session_not_found"),
      validateGraphArtifactContent: () => undefined, runArtifactSurface, createArtifactEnvelope: () => envelope,
      createArtifactDraft: async () => artifact, createArtifactRollback: async () => ({ id: "rollback_1" }) as never,
      runArtifactMutation: async () => { throw new Error("unexpected"); }
    });

    await handler.execute(context, artifactCreate.input.parse({ title: "Notes", content: "Body", metadata: { surface_operation_payload: original } }));

    expect(runArtifactSurface).toHaveBeenCalledWith(original);
  });
});
