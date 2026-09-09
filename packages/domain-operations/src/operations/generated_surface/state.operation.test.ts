import { describe, expect, it, vi } from "vitest";
import type { GeneratedSurfaceDefinition, SurfaceInteractionRecord } from "@samurai-agent/core-schemas";
import type { TrustedDomainContext } from "../../definition/index.js";
import generatedSurfaceState from "./state.operation.js";

const now = "2026-08-09T00:00:00.000Z";
const surface: GeneratedSurfaceDefinition = {
  id: "surface-core08", state: "ephemeral", title: "Core08 Surface", input_data_schema: {}, actions: [],
  capability_manifest: { allowed_domain_commands: [], network_access: "none", workspace_write: "domain_commands_only" },
  source_refs: [], content_hash: "hash", current_revision_id: "revision-core08", current_revision: 1,
  preview_url: "surface://core08", fallback_chain: ["text"], created_at: now, updated_at: now
};
const sessionlessContext: TrustedDomainContext = {
  inputSource: "runtime_api", workspaceId: "workspace", actorId: "actor", correlationId: "core08-surface",
  sessionRef: { app_id: "native_app", session_id: "forged-session" }
};

function ports() {
  const saveGeneratedSurfaceInteraction = vi.fn(async (record: SurfaceInteractionRecord) => record);
  return {
    saveGeneratedSurfaceInteraction,
    ports: {
      updateGeneratedSurfaceState: vi.fn(async (_id: string, state: GeneratedSurfaceDefinition["state"]) => ({ ...surface, state })),
      saveGeneratedSurfaceInteraction,
      generatedSurfaceStateError: (_code: "conflict" | "not_found", message: string) => new Error(message)
    }
  };
}

describe("generated_surface.state handler", () => {
  it("changes state for a session-less Surface without treating SessionRef as authority", async () => {
    const cases = [
      ["pin", "pinned", "pinned"],
      ["unpin", "ephemeral", "unpinned"],
      ["archive", "archived", "dismissed"]
    ] as const;

    for (const [action, expectedState, expectedInteractionKind] of cases) {
      const fixture = ports();
      const handler = generatedSurfaceState.createHandler(fixture.ports);

      await expect(handler.execute(sessionlessContext, generatedSurfaceState.input.parse({
        surface_id: surface.id, action
      }))).resolves.toMatchObject({
        ok: true,
        value: { id: surface.id, state: expectedState, current_revision_id: surface.current_revision_id }
      });

      expect(fixture.ports.updateGeneratedSurfaceState).toHaveBeenCalledWith(surface.id, expectedState);
      const interaction = fixture.saveGeneratedSurfaceInteraction.mock.calls[0]?.[0];
      expect(interaction).toMatchObject({
        kind: expectedInteractionKind,
        surface_id: surface.id,
        revision_id: surface.current_revision_id,
        session_ref: sessionlessContext.sessionRef
      });
      expect(interaction).not.toHaveProperty("session_id");
    }
  });

  it("stores a message reference only for a real Session compatibility action", async () => {
    const fixture = ports();
    const handler = generatedSurfaceState.createHandler(fixture.ports);

    await handler.execute({ ...sessionlessContext, sessionId: "session-core08" }, generatedSurfaceState.input.parse({
      surface_id: surface.id, action: "pin", message_id: "message-core08"
    }));

    expect(fixture.saveGeneratedSurfaceInteraction).toHaveBeenCalledWith(expect.objectContaining({
      session_id: "session-core08", message_id: "message-core08", kind: "pinned"
    }));
  });
});
