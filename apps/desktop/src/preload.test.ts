import { describe, expect, it } from "vitest";
import {
  sanitizeWorkspaceBundleExportInput,
  sanitizeWorkspaceBundleRestoreInput,
  sanitizeWorkspaceChatSessionInput,
  sanitizeWorkspaceCreateInput,
  sanitizeWorkspaceArtifactRevisionInput,
  sanitizeWorkspaceGeneratedSurfaceMutationInput,
  sanitizeWorkspaceInteractionRequestCancelInput,
  sanitizeWorkspaceInteractionRequestListInput,
  sanitizeWorkspaceInteractionRequestResultInput,
  sanitizeWorkspaceInteractionRequestRespondInput,
  sanitizeWorkspaceOperationHistoryInput,
  sanitizeWorkspaceRoomWorkResourceRefs
} from "./preload-sanitizers";

describe("Desktop preload operation-history sanitation", () => {
  it("keeps only the Room, selector, and target", () => {
    expect(sanitizeWorkspaceOperationHistoryInput({
      roomId: "room_product",
      recordType: "domain_operation",
      secret: "nope",
      target: { connectionId: "connection_local", workspaceId: "workspace_product", roomId: "room_product" }
    })).toEqual({
      roomId: "room_product",
      recordType: "domain_operation",
      target: { connectionId: "connection_local", workspaceId: "workspace_product", roomId: "room_product" }
    });
  });
});

describe("Desktop preload chat-session sanitation", () => {
  it("preserves opaque Room IDs and UUID operation IDs", () => {
    const roomId = "room_01J7Y4JQW8R3M6N2P9K4T7V5X8Y1Z3A6B9C2D4E6F8G";
    const operationId = "550e8400-e29b-41d4-a716-446655440000";

    expect(sanitizeWorkspaceChatSessionInput({ roomId, operationId })).toEqual({ roomId, operationId });
  });

  it("sanitizes standalone Workspace creation fields", () => {
    expect(sanitizeWorkspaceCreateInput({ workspaceId: "workspace_personal", name: " Personal ", operationId: "workspace_create_1", secret: "nope" })).toEqual({
      workspaceId: "workspace_personal",
      name: " Personal ",
      operationId: "workspace_create_1"
    });
  });

  it("keeps standalone Bundle bridge inputs to IDs and version metadata", () => {
    expect(sanitizeWorkspaceBundleExportInput({
      workspaceId: "workspace_personal",
      expectedWorkspaceVersion: 4,
      operationId: "bundle_export_1",
      bundle: { content: "must-not-cross" },
      privateKey: "must-not-cross"
    })).toEqual({
      workspaceId: "workspace_personal",
      expectedWorkspaceVersion: 4,
      operationId: "bundle_export_1"
    });
    expect(sanitizeWorkspaceBundleRestoreInput({
      bundleId: "bundle_1",
      targetWorkspaceId: "workspace_restored",
      operationId: "bundle_restore_1",
      bundle: { content: "must-not-cross" },
      confirm: false
    })).toEqual({
      bundleId: "bundle_1",
      targetWorkspaceId: "workspace_restored",
      operationId: "bundle_restore_1"
    });
  });

  it("sanitizes Artifact revision inputs while retaining empty content and real bytes", () => {
    expect(sanitizeWorkspaceArtifactRevisionInput({
      roomId: "room_1",
      artifactId: "artifact_1",
      revisionId: "revision_1",
      operationId: "artifact_restore_1",
      content: new Uint8Array([0, 255, 1]),
      expectedRevision: 2,
      changeSummary: "restore",
      privateKey: "must-not-cross"
    })).toEqual({
      roomId: "room_1",
      artifactId: "artifact_1",
      revisionId: "revision_1",
      operationId: "artifact_restore_1",
      content: [0, 255, 1],
      expectedRevision: 2,
      changeSummary: "restore"
    });
    expect(sanitizeWorkspaceArtifactRevisionInput({ roomId: "room_1", artifactId: "artifact_1", operationId: "artifact_revise_1", content: "" })).toEqual({
      roomId: "room_1",
      artifactId: "artifact_1",
      operationId: "artifact_revise_1",
      content: ""
    });

    expect(sanitizeWorkspaceArtifactRevisionInput({
      roomId: "room_1",
      artifactId: "artifact_1",
      operationId: "artifact_target_1",
      content: "更新",
      target: { connectionId: "server_a", workspaceId: "workspace_a" }
    })).toMatchObject({
      roomId: "room_1",
      artifactId: "artifact_1",
      operationId: "artifact_target_1",
      target: { connectionId: "server_a", workspaceId: "workspace_a" }
    });

    expect(sanitizeWorkspaceArtifactRevisionInput({
      roomId: "room_1",
      artifactId: "artifact_1",
      operationId: "artifact_target_room",
      content: "更新",
      target: { connectionId: "server_a", workspaceId: "workspace_a", roomId: "room_1", selectionGeneration: 4 }
    })).toMatchObject({
      target: { connectionId: "server_a", workspaceId: "workspace_a", roomId: "room_1", selectionGeneration: 4 }
    });
  });

  it("keeps Generated Surface mutations as bounded JSON DTOs", () => {
    expect(sanitizeWorkspaceGeneratedSurfaceMutationInput({
      roomId: "room_1",
      operationId: "surface_create_1",
      bundle: { title: "Surface", html: "<main />", actions: [{ id: "refresh", label: "Refresh", command_id: "surface.refresh" }], privateKey: "nope" },
      request: { user_intent: "Show the result", expected_lifetime: "session", fallback_chain: ["built_in_surface"], privateKey: "nope" }
    })).toEqual({
      roomId: "room_1",
      operationId: "surface_create_1",
      bundle: { title: "Surface", html: "<main />", actions: [{ id: "refresh", label: "Refresh", command_id: "surface.refresh" }] },
      request: { user_intent: "Show the result", expected_lifetime: "session", fallback_chain: ["built_in_surface"] }
    });
  });
});

describe("Desktop Room Work resource-ref sanitation", () => {
  it("drops display metadata before IPC while preserving the exact selector", () => {
    expect(sanitizeWorkspaceRoomWorkResourceRefs([{
      kind: "knowledge",
      id: " knowledge_policy ",
      version: 3,
      uri: "https://client.example/should-not-cross",
      label: "表示名",
      clientMetadata: { source: "renderer" }
    }])).toEqual([{ kind: "knowledge", id: "knowledge_policy", version: 3 }]);
  });

  it.each([
    [{ kind: "knowledge", id: "", version: 1 }],
    [{ kind: "other", id: "resource_1", version: 1 }],
    [{ kind: "skill", id: "resource_1", version: 0 }],
    [{ kind: "skill", id: "resource_1", version: 1.5 }],
    [{ kind: "skill", id: "resource_1", version: "1" }]
  ])("rejects invalid selector %#", (value) => {
    expect(() => sanitizeWorkspaceRoomWorkResourceRefs(value)).toThrow("workspace_room_resource_ref_invalid");
  });

  it("uses the public API upper bound", () => {
    const refs = Array.from({ length: 33 }, (_, index) => ({ kind: "skill" as const, id: `skill_${index}`, version: 1 }));
    expect(() => sanitizeWorkspaceRoomWorkResourceRefs(refs)).toThrow("workspace_room_resource_ref_count_invalid");
  });
});

describe("Desktop preload durable Interaction Request sanitation", () => {
  it("keeps only fixed Room/request/version/option fields and JSON object values", () => {
    expect(sanitizeWorkspaceInteractionRequestListInput({
      roomId: " room_1 ",
      includeResolved: true,
      workspaceId: "must-not-cross",
      privateKey: "must-not-cross"
    })).toEqual({ roomId: "room_1", includeResolved: true });
    expect(sanitizeWorkspaceInteractionRequestRespondInput({
      roomId: "room_1",
      requestId: "interaction_1",
      expectedVersion: 3,
      optionId: "submit",
      operationId: "interaction_respond_1",
      values: { answer: "公開情報", privateKey: "must-not-cross" },
      input: { raw: "must-not-cross" }
    })).toEqual({
      roomId: "room_1",
      requestId: "interaction_1",
      expectedVersion: 3,
      optionId: "submit",
      operationId: "interaction_respond_1",
      values: { answer: "公開情報", privateKey: "must-not-cross" }
    });
    expect(sanitizeWorkspaceInteractionRequestCancelInput({
      roomId: "room_1",
      requestId: "interaction_1",
      expectedVersion: 3,
      operationId: "interaction_cancel_1",
      values: { shouldNotCross: true }
    })).toEqual({ roomId: "room_1", requestId: "interaction_1", expectedVersion: 3, operationId: "interaction_cancel_1" });
  });

  it.each([
    [{ roomId: "room_1", requestId: "interaction_1", expectedVersion: 0, optionId: "submit", operationId: "op_1" }],
    [{ roomId: "room_1", requestId: "interaction_1", expectedVersion: 1, optionId: "", operationId: "op_1" }],
    [{ roomId: "room_1", requestId: "interaction_1", expectedVersion: 1, optionId: "submit", operationId: "op_1", values: [] }]
  ])("rejects invalid durable interaction input %#", (input) => {
    expect(() => sanitizeWorkspaceInteractionRequestRespondInput(input)).toThrow("workspace_interaction_request_");
  });

  it("rejects cyclic JSON values instead of forwarding them to Main", () => {
    const values: Record<string, unknown> = {};
    values.self = values;
    expect(() => sanitizeWorkspaceInteractionRequestRespondInput({
      roomId: "room_1",
      requestId: "interaction_1",
      expectedVersion: 1,
      optionId: "submit",
      operationId: "op_1",
      values
    })).toThrow("workspace_interaction_request_values_invalid");
  });

  it("keeps the exact Room/request selector for a durable result read", () => {
    expect(sanitizeWorkspaceInteractionRequestResultInput({
      roomId: " room_1 ",
      requestId: "interaction_1",
      operationId: "surface_operation_1",
      workspaceId: "must-not-cross",
      privateKey: "must-not-cross",
      target: { connectionId: "connection_1", workspaceId: "workspace_1", roomId: "room_1" }
    })).toEqual({
      roomId: "room_1",
      requestId: "interaction_1",
      operationId: "surface_operation_1",
      target: { connectionId: "connection_1", workspaceId: "workspace_1", roomId: "room_1" }
    });
  });
});
