import { describe, expect, it } from "vitest";
import { WorkspaceServerError } from "./errors";
import { assertLegacyWorkspaceMemoryRemoved } from "./workspace-completion-migration";

function legacyResource(overrides: Record<string, unknown> = {}) {
  return {
    id: "legacy_resource_1",
    scope_kind: "workspace" as const,
    resource_kind: "memory" as const,
    payload: {},
    ...overrides
  };
}

describe("workspace completion legacy migration retirement boundary", () => {
  it.each([
    { resource: legacyResource(), versions: [] },
    { resource: legacyResource({ resource_kind: "knowledge", payload: { legacy_resource_kind: "memory" } }), versions: [] },
    { resource: legacyResource({ resource_kind: "knowledge", payload: { legacy_source: { resource_kind: "workspace_memory" } } }), versions: [] },
    { resource: legacyResource({ resource_kind: "knowledge" }), versions: [{ resource_id: "legacy_resource_1", payload: { resource_type: "memory" } }] }
  ])("rejects retired Workspace Memory input before target creation", ({ resource, versions }) => {
    expect(() => assertLegacyWorkspaceMemoryRemoved({ resources: [resource], versions })).toThrowError(
      expect.objectContaining({ code: "workspace_memory_removed", status: 409 })
    );
  });

  it("does not reject Room Memory legacy rows or Workspace Skill rows by scope alone", () => {
    expect(() => assertLegacyWorkspaceMemoryRemoved({
      resources: [
        legacyResource({ id: "room_memory", scope_kind: "room", resource_kind: "memory" }),
        legacyResource({ id: "workspace_skill", resource_kind: "skill" })
      ],
      versions: []
    })).not.toThrow();
  });

  it("uses the stable public error code", () => {
    try {
      assertLegacyWorkspaceMemoryRemoved({ resources: [legacyResource()], versions: [] });
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(WorkspaceServerError);
      expect((error as WorkspaceServerError).code).toBe("workspace_memory_removed");
    }
  });
});
