import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { NativeRoom } from "../native-app/types";
import RoomNavigator from "./RoomNavigator";

const room = (input: Pick<NativeRoom, "id" | "name"> & Partial<NativeRoom>): NativeRoom => ({
  workspaceId: "workspace_1",
  ...input
});

describe("RoomNavigator", () => {
  it("keeps Room selection separate from an initially expanded parent toggle", () => {
    const onSelect = vi.fn();
    const onToggleExpanded = vi.fn();
    const markup = renderToStaticMarkup(createElement(RoomNavigator, {
      rooms: [
        room({ id: "parent", name: "Parent" }),
        room({ id: "child", name: "Child", parentRoomId: "parent" })
      ],
      onSelect,
      onToggleExpanded
    }));

    expect(markup).toContain("Parent");
    expect(markup).toContain("Child");
    expect(markup).toContain('aria-label="Parentを折りたたむ"');
    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain("native-room-item-row");
    expect(markup).not.toMatch(/native-room-item-parent[^>]*aria-expanded/);
    expect(onSelect).not.toHaveBeenCalled();
    expect(onToggleExpanded).not.toHaveBeenCalled();
  });

  it("hides descendants when the controlled parent is collapsed and keeps DM separate", () => {
    const markup = renderToStaticMarkup(createElement(RoomNavigator, {
      rooms: [
        room({ id: "parent", name: "Parent" }),
        room({ id: "child", name: "Child", parentRoomId: "parent" }),
        room({ id: "agent_dm", name: "Research", kind: "agent_dm" })
      ],
      expandedRoomIds: new Set<string>(),
      onSelect: vi.fn()
    }));

    expect(markup).toContain("Parent");
    expect(markup).not.toContain("Child");
    expect(markup).toContain('aria-label="Parentを展開する"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain("ダイレクトメッセージ");
    expect(markup).toContain("Research");
    expect(markup).not.toContain("native-room-children");
  });

  it("does not invent a hidden parent while ordering authorized Room rows", () => {
    const markup = renderToStaticMarkup(createElement(RoomNavigator, {
      rooms: [room({ id: "child", name: "Visible child", parentRoomId: "not-authorized" })],
      onSelect: vi.fn()
    }));

    expect(markup).toContain("Visible child");
    expect(markup).not.toContain("not-authorized");
    expect(markup).not.toContain("native-room-item-parent");
  });
});
