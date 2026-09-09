import { describe, expect, it } from "vitest";
import { buildGeneratedSurfaceRevision } from "./presentation/generated-surface";
import {
  canonicalGeneratedSurfaceProviderCommandId,
  normalizeGeneratedSurfaceProviderAction,
  normalizeGeneratedSurfaceProviderAllowedCommands,
  normalizeGeneratedSurfaceProviderToolArguments
} from "./generated-surface-provider-normalization";

describe("Generated Surface provider command normalization", () => {
  it("persists provider aliases as canonical Domain Command IDs", () => {
    const action = normalizeGeneratedSurfaceProviderAction({
      id: "create_note",
      label: "メモを作成",
      command_id: "create_artifact",
      input_schema: {},
      payload_template: { title: "Surface Action Artifact", content: "Created by Surface action" }
    }) as Record<string, never>;
    const allowedDomainCommands = normalizeGeneratedSurfaceProviderAllowedCommands(["create_artifact"]);

    const created = buildGeneratedSurfaceRevision({
      request: {
        id: "surface_request_provider_alias",
        domain_operation_id: "operation_provider_alias",
        user_intent: "Create a note from this Surface.",
        source_resource_refs: [],
        allowed_domain_commands: allowedDomainCommands as string[],
        selected_knowledge_refs: [],
        selected_skill_refs: [],
        client_capabilities: { generated_surface: true },
        expected_lifetime: "session",
        fallback_chain: ["built_in_surface"]
      },
      bundle: {
        title: "Provider alias Surface",
        html: "<main>Provider alias Surface</main>",
        actions: [action as never]
      },
      surfaceId: "surface_provider_alias",
      revisionId: "surface_revision_provider_alias"
    });

    expect(created.validation.valid).toBe(true);
    expect(created.definition.capability_manifest.allowed_domain_commands).toEqual(["artifact.create"]);
    expect(created.definition.actions[0]?.command_id).toBe("artifact.create");
  });

  it("leaves unknown or malformed provider values for strict validation", () => {
    expect(canonicalGeneratedSurfaceProviderCommandId("unrecognized_command")).toBe("unrecognized_command");
    expect(normalizeGeneratedSurfaceProviderAction("not-an-action")).toBe("not-an-action");
    expect(normalizeGeneratedSurfaceProviderAllowedCommands(["unrecognized_command", 1])).toEqual(["unrecognized_command", 1]);
  });

  it("normalizes request and bundle command references without dropping malformed values", () => {
    const normalized = normalizeGeneratedSurfaceProviderToolArguments({
      request: { allowed_domain_commands: ["create_artifact", "unrecognized_command", 1] },
      bundle: {
        title: "Provider alias Surface",
        actions: [
          { id: "create", command_id: "create_artifact" },
          "invalid-action"
        ]
      }
    });

    expect(normalized).toEqual({
      request: { allowed_domain_commands: ["artifact.create", "unrecognized_command", 1] },
      bundle: {
        title: "Provider alias Surface",
        actions: [
          { id: "create", command_id: "artifact.create" },
          "invalid-action"
        ]
      }
    });
  });
});
