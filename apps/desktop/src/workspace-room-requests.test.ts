import { describe, expect, it } from "vitest";
import {
  workspaceRoomCreateRequest,
  workspaceRoomMemberRequest,
  workspaceRoomMoveRequest
} from "./workspace-room-requests";

describe("Desktop Room operation boundary", () => {
  it("makes a fixed create request without accepting a renderer supplied key or URL", () => {
    expect(workspaceRoomCreateRequest({
      name: " Child Room ",
      parentRoomId: "room_parent",
      expectedWorkspaceVersion: 3,
      operationId: "room_create_1",
      privateKey: "renderer-must-not-control-this",
      serverUrl: "https://attacker.example"
    })).toEqual({
      operationId: "room_create_1",
      body: { name: "Child Room", parent_room_id: "room_parent", expected_workspace_version: 3 }
    });
  });

  it("requires an explicit root destination and current versions for a move", () => {
    expect(workspaceRoomMoveRequest({
      roomId: "room_child",
      parentRoomId: null,
      expectedRoomVersion: 4,
      expectedWorkspaceVersion: 8,
      operationId: "room_move_1"
    })).toEqual({
      roomId: "room_child",
      operationId: "room_move_1",
      body: { parent_room_id: null, expected_room_version: 4, expected_workspace_version: 8 }
    });
    expect(() => workspaceRoomMoveRequest({ roomId: "room_child", expectedRoomVersion: 4, expectedWorkspaceVersion: 8, operationId: "room_move_1" }))
      .toThrow("parentRoomId_required");
  });

  it("keeps member changes limited to the typed Room operation", () => {
    expect(workspaceRoomMemberRequest({
      roomId: "room_child",
      accountId: "account_member",
      role: "member",
      state: "revoked",
      expectedVersion: 2,
      operationId: "room_member_1",
      arbitraryPath: "/api/workspaces/other"
    })).toEqual({
      roomId: "room_child",
      accountId: "account_member",
      operationId: "room_member_1",
      body: { role: "member", state: "revoked", expected_version: 2 }
    });
  });
});
