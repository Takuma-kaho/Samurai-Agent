import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import NativeRoomAdministration from "./NativeRoomAdministration";
import {
  nativeRoomAdministrationCreateInput,
  nativeRoomAdministrationErrorMessage,
  nativeRoomAdministrationMemberInput,
  nativeRoomAdministrationMoveInput
} from "./use-native-room-administration";
import type { NativeRoom, NativeWorkspaceTarget } from "./types";

const target: NativeWorkspaceTarget = {
  connectionId: "connection-a",
  workspaceId: "workspace-a"
};

const rooms: NativeRoom[] = [
  { id: "room-parent", workspaceId: target.workspaceId, name: "親Room", canManage: true, version: 4 },
  { id: "room-current", workspaceId: target.workspaceId, name: "現在のRoom", parentRoomId: "room-parent", canManage: true, version: 9 },
  { id: "room-destination", workspaceId: target.workspaceId, name: "移動先", canManage: true, version: 3 },
  { id: "room-dm", workspaceId: target.workspaceId, name: "Agent DM", kind: "agent_dm", canManage: true, version: 2 }
];

describe("NativeRoomAdministration", () => {
  it("R13の入力にtargetとexpected versionを含める", () => {
    expect(nativeRoomAdministrationCreateInput({
      name: "子Room",
      parentRoomId: "room-current",
      expectedWorkspaceVersion: 12,
      operationId: "op-create",
      target
    })).toEqual({
      name: "子Room",
      parentRoomId: "room-current",
      expectedWorkspaceVersion: 12,
      operationId: "op-create",
      target
    });

    expect(nativeRoomAdministrationMoveInput({
      roomId: "room-current",
      parentRoomId: "room-destination",
      expectedRoomVersion: 9,
      expectedWorkspaceVersion: 12,
      operationId: "op-move",
      target
    })).toMatchObject({
      roomId: "room-current",
      parentRoomId: "room-destination",
      expectedRoomVersion: 9,
      expectedWorkspaceVersion: 12,
      operationId: "op-move",
      target
    });

    expect(nativeRoomAdministrationMemberInput({
      roomId: "room-current",
      accountId: "account-b",
      role: "admin",
      state: "active",
      expectedVersion: 6,
      operationId: "op-member",
      target
    })).toMatchObject({
      roomId: "room-current",
      accountId: "account-b",
      role: "admin",
      state: "active",
      expectedVersion: 6,
      operationId: "op-member",
      target
    });
  });

  it("Serverのmembership失敗コードをそのまま表示できる", () => {
    expect(nativeRoomAdministrationErrorMessage({ body: { error: "last_owner_required" } }, "fallback")).toBe("last_owner_required");
    expect(nativeRoomAdministrationErrorMessage(new Error("conflict"), "fallback")).toBe("conflict");
  });

  it("通常RoomではR13の補助パネルを表示し、R15の偽ボタンを表示しない", () => {
    const markup = renderToStaticMarkup(createElement(NativeRoomAdministration, {
      rooms,
      target,
      workspaceVersion: 12,
      currentRoomId: "room-current",
      workspaceRole: "admin",
      bridge: {}
    }));

    expect(markup).toContain("子Roomを作成");
    expect(markup).toContain("Roomを移動");
    expect(markup).toContain("現在の人間membership");
    expect(markup).toContain("条件を確認");
    expect(markup).not.toContain("承認");
    expect(markup).not.toContain("入力を送信");
  });

  it("Agent DMでは通常Room化や人間追加のUIを表示しない", () => {
    const markup = renderToStaticMarkup(createElement(NativeRoomAdministration, {
      rooms,
      target,
      workspaceVersion: 12,
      currentRoomId: "room-dm",
      workspaceRole: "owner",
      bridge: {}
    }));

    expect(markup).toContain("Agent DM");
    expect(markup).not.toContain("子Roomを作成");
    expect(markup).not.toContain("Roomを移動");
    expect(markup).not.toContain("Account ID");
    expect(markup).not.toContain("変更を保存");
  });
});
