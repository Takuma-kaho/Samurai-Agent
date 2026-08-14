import { describe, expect, it } from "vitest";
import {
  canCreateWorkspaceRootRoom,
  canMoveRoomToWorkspaceRoot,
  manageableMoveParents
} from "./workspace-room-capabilities";

describe("Workspace Room action guidance", () => {
  it("keeps Workspace-root creation and moves aligned with Workspace role", () => {
    expect(canCreateWorkspaceRootRoom("member")).toBe(true);
    expect(canCreateWorkspaceRootRoom("guest")).toBe(false);
    expect(canMoveRoomToWorkspaceRoot("admin")).toBe(true);
    expect(canMoveRoomToWorkspaceRoot("member")).toBe(false);
  });

  it("never presents the selected Room or a descendant as a move destination", () => {
    const rooms = [
      { id: "room_a", canManage: true },
      { id: "room_b", parentRoomId: "room_a", canManage: true },
      { id: "room_c", parentRoomId: "room_b", canManage: true },
      { id: "room_d", canManage: true },
      { id: "room_read_only", canManage: false }
    ];
    expect(manageableMoveParents(rooms, "room_a").map((room) => room.id)).toEqual(["room_d"]);
  });

  it("does not offer the current parent as a no-op destination", () => {
    const rooms = [
      { id: "room_parent", canManage: true },
      { id: "room_selected", parentRoomId: "room_parent", canManage: true },
      { id: "room_other", canManage: true }
    ];
    expect(manageableMoveParents(rooms, "room_selected").map((room) => room.id)).toEqual(["room_other"]);
  });
});
