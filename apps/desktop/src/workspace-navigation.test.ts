import { describe, expect, it } from "vitest";
import { workspaceNavigationSnapshotIsCurrent } from "./workspace-navigation.js";

describe("workspaceNavigationSnapshotIsCurrent", () => {
  const workspaceSnapshot = {
    connectionId: "connection_a",
    workspaceId: "workspace_a",
    workspaceTargetGeneration: 4,
    selectionGeneration: 8
  };

  it("keeps a Workspace-scoped query valid while the initial Room changes", () => {
    expect(workspaceNavigationSnapshotIsCurrent(workspaceSnapshot, {
      ...workspaceSnapshot,
      selectionGeneration: 9,
      roomId: "room_general"
    })).toBe(true);
  });

  it("invalidates a Room-scoped request when Room navigation changes", () => {
    expect(workspaceNavigationSnapshotIsCurrent({ ...workspaceSnapshot, roomId: "room_general" }, {
      ...workspaceSnapshot,
      selectionGeneration: 9,
      roomId: "room_other"
    })).toBe(false);
  });

  it("invalidates every request after the Workspace target changes", () => {
    expect(workspaceNavigationSnapshotIsCurrent(workspaceSnapshot, {
      ...workspaceSnapshot,
      workspaceTargetGeneration: 5,
      selectionGeneration: 10,
      roomId: "room_general"
    })).toBe(false);
  });
});
