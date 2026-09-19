import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import RoomContextMenu from "./RoomContextMenu";
import type { NativeRoom } from "../native-app/types";

const room: NativeRoom = { id: "room_a", workspaceId: "workspace_a", name: "調査" };

describe("RoomContextMenu", () => {
  it("keeps Room actions target-scoped and exposes the existing operation entry points", () => {
    const markup = renderToStaticMarkup(createElement(RoomContextMenu, {
      room,
      position: { x: 12, y: 24 },
      onAction: vi.fn(),
      onClose: vi.fn()
    }));

    expect(markup).toContain('role="menu"');
    expect(markup).toContain('aria-label="調査のRoom操作"');
    expect(markup).toContain("Roomを作成");
    expect(markup).toContain("子Roomを作成");
    expect(markup).toContain("Roomを移動");
    expect(markup).toContain("名前を変更");
    expect(markup).toContain('disabled=""');
    expect(markup).not.toContain("Roomを選択");
  });
});
