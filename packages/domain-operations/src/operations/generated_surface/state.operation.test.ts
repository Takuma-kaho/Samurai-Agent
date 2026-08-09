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
  it("does not archive a session-less Surface as hidden Workspace state", async () => {
    const fixture = ports();
    const handler = generatedSurfaceState.createHandler(fixture.ports);

    await expect(handler.execute(sessionlessContext, generatedSurfaceState.input.parse({
      surface_id: surface.id, action: "archive"
    }))).rejects.toThrow("generated_surface_display_state_compatibility_required");

    expect(fixture.saveGeneratedSurfaceInteraction).not.toHaveBeenCalled();
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
