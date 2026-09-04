import { describe, expect, it } from "vitest";
import {
  sanitizeWorkspaceBundleExportInput,
  sanitizeWorkspaceBundleRestoreInput,
  sanitizeWorkspaceChatSessionInput,
  sanitizeWorkspaceCreateInput
} from "./preload-sanitizers";

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
});
