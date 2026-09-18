import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import RoomNavigator from "./RoomNavigator";
import type { NativeRoom } from "../native-app/types";

const room = (id: string, name: string, parentRoomId?: string): NativeRoom => ({
  id,
  name,
  parentRoomId,
  workspaceId: "workspace_1"
});

describe("RoomNavigator focused behavior", () => {
  it("does not select a Room when its parent toggle is used", () => {
    const onSelect = vi.fn();
    const onToggleExpanded = vi.fn();
    const markup = renderToStaticMarkup(createElement(RoomNavigator, {
      rooms: [room("parent", "親"), room("child", "子", "parent")],
      onSelect,
      onToggleExpanded
    }));
    expect(markup).toContain('aria-label="親を折りたたむ"');
    expect(markup).toContain('aria-expanded="true"');
    expect(onSelect).not.toHaveBeenCalled();
    expect(onToggleExpanded).not.toHaveBeenCalled();
  });

  it("hides authorized descendants while keeping Agent DM separate", () => {
    const markup = renderToStaticMarkup(createElement(RoomNavigator, {
      rooms: [room("parent", "親"), room("child", "子", "parent"), { ...room("dm", "調査"), kind: "agent_dm" }],
      expandedRoomIds: new Set<string>(),
      onSelect: vi.fn()
    }));
    expect(markup).not.toContain("子");
    expect(markup).toContain("ダイレクトメッセージ");
    expect(markup).toContain("調査");
  });
});
