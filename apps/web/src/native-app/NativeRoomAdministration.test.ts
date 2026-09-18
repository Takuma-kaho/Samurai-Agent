import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import NativeRoomAdministration from "./NativeRoomAdministration";
import type { NativeRoom } from "./types";

const room: NativeRoom = {
  id: "room_1",
  workspaceId: "workspace_1",
  name: "作業Room",
  canManage: true,
  capabilities: { canManage: true },
  version: 1
};

describe("NativeRoomAdministration", () => {
  it("exposes six independent Room management tabs without changing the selected Room", () => {
    const markup = renderToStaticMarkup(createElement(NativeRoomAdministration, {
      rooms: [room],
      target: { connectionId: "connection_1", workspaceId: "workspace_1" },
      currentRoom: room,
      workspaceVersion: 1,
      initialTab: "participants",
      bridge: {},
      onClose: vi.fn(),
      agentPanel: createElement("p", null, "Agent設定"),
      knowledgePanel: createElement("p", null, "Knowledge設定"),
      learningPanel: createElement("p", null, "学習設定"),
      sharingPanel: createElement("p", null, "共有設定")
    }));

    expect(markup).toContain('aria-label="Room管理タブ"');
    expect(markup.match(/role="tab"/g)?.length).toBe(6);
    expect(markup).toContain("現在の人間membership");
    expect(markup).toContain("Knowledge設定");
    expect(markup).toContain("学習設定");
    expect(markup).toContain("共有設定");
    expect(markup).toContain("作業Room");
  });
});
