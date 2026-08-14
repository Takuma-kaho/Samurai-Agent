import { describe, expect, it } from "vitest";
import { buildWorkspaceRoomTree, workspaceRoomPath } from "./workspace-room-tree";

describe("Workspace Room tree", () => {
  const rooms = [
    { id: "a", name: "A" },
    { id: "aa", parentRoomId: "a", name: "AA" },
    { id: "aaa", parentRoomId: "aa", name: "AAA" },
    { id: "b", name: "B" }
  ];

  it("builds an unlimited-depth tree from the authorized flat list", () => {
    expect(buildWorkspaceRoomTree(rooms)).toEqual([
      { room: rooms[0], children: [{ room: rooms[1], children: [{ room: rooms[2], children: [] }] }] },
      { room: rooms[3], children: [] }
    ]);
  });

  it("returns only the selected Room ancestry", () => {
    expect(workspaceRoomPath(rooms, "aaa").map((room) => room.id)).toEqual(["a", "aa", "aaa"]);
  });

  it("does not add a UI depth limit", () => {
    const deep = Array.from({ length: 2_000 }, (_, index) => ({
      id: `room_${index}`,
      ...(index > 0 ? { parentRoomId: `room_${index - 1}` } : {}),
      name: `Room ${index}`
    }));

    const root = buildWorkspaceRoomTree(deep);
    expect(workspaceRoomPath(deep, "room_1999")).toHaveLength(2_000);
    expect(root[0]?.room.id).toBe("room_0");
  });
});
