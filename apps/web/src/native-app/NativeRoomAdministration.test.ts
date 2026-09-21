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
  it("renders a compact Room menu without the former tab row", () => {
    const markup = renderToStaticMarkup(createElement(NativeRoomAdministration, {
      rooms: [room],
      target: { connectionId: "connection_1", workspaceId: "workspace_1" },
      currentRoom: room,
      workspaceVersion: 1,
      bridge: {},
      onClose: vi.fn(),
      onOpenShare: vi.fn(),
      onOpenKnowledge: vi.fn(),
      onOpenLearning: vi.fn()
    }));

    expect(markup).toContain('aria-label="Roomメニュー"');
    expect(markup).not.toContain('role="tab"');
    expect(markup).toContain("共有");
    expect(markup).toContain("Knowledge");
    expect(markup).toContain("学習");
    expect(markup).toContain("作業Room");
  });

  it("supports the participants view while keeping Agent operations in the same screen", () => {
    const markup = renderToStaticMarkup(createElement(NativeRoomAdministration, {
      rooms: [room],
      target: { connectionId: "connection_1", workspaceId: "workspace_1" },
      currentRoom: room,
      workspaceVersion: 1,
      view: "participants",
      bridge: {},
      participants: [{ id: "agent_1", kind: "agent", label: "調査Agent", state: "available" }],
      agentPanel: createElement("p", null, "Agent操作")
    }));

    expect(markup).toContain("参加者");
    expect(markup).toContain("調査Agent");
    expect(markup).toContain("Agent操作");
    expect(markup).not.toContain('role="tab"');
  });

  it("does not promote an Account ID to the participant label", () => {
    const markup = renderToStaticMarkup(createElement(NativeRoomAdministration, {
      rooms: [room],
      target: { connectionId: "connection_1", workspaceId: "workspace_1" },
      currentRoom: room,
      workspaceVersion: 1,
      view: "participants",
      bridge: {},
      participants: [{ id: "account_1", kind: "account", label: "account_1", state: "active" }]
    }));

    expect(markup).toContain("参加者1");
    expect(markup).toContain("表示名未取得");
    expect(markup).not.toContain(">account_1<");
  });
});
