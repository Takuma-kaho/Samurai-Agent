import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { WorkspaceContextSearchItem } from "../lib/api";
import WorkspaceContextSearch from "./WorkspaceContextSearch";
import {
  searchTypesAreAllSelected,
  toggleWorkspaceContextSearchType,
  workspaceContextSearchViewState,
  workspaceContextTargetKey
} from "./workspace-context-ui-helpers";

const target = { connectionId: "connection_a", workspaceId: "workspace_a" };

const item: WorkspaceContextSearchItem = {
  type: "room",
  id: "room_a",
  roomId: "room_a",
  title: "運用設計",
  snippet: "運用設計のRoom",
  updatedAt: "2026-09-17T00:00:00.000Z",
  target: { kind: "room", roomId: "room_a" }
};

describe("WorkspaceContextSearch", () => {
  it("renders an accessible multi-input search surface without an invitation action", () => {
    const markup = renderToStaticMarkup(createElement(WorkspaceContextSearch, {
      search: vi.fn(async () => ({ items: [item], nextCursor: "cursor_2" })),
      target,
      workspaceName: "調査Workspace",
      initialTypes: ["room", "knowledge"],
      onOpenRoom: vi.fn(),
      onClose: vi.fn()
    }));

    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('role="search"');
    expect(markup).toContain('aria-label="Workspace検索を閉じる"');
    expect(markup).toContain("Room");
    expect(markup).toContain("会話");
    expect(markup).toContain("知識");
    expect(markup).toContain('aria-pressed="false"');
    expect(markup).not.toContain("招待を受諾");
  });

  it("shows the empty-target state and prevents search input until a Workspace is selected", () => {
    const markup = renderToStaticMarkup(createElement(WorkspaceContextSearch, {
      search: vi.fn(async () => ({ items: [], nextCursor: null })),
      initialQuery: "設計",
      onOpenRoom: vi.fn()
    }));

    expect(markup).toContain("Workspaceを選択すると検索できます。");
    expect(markup).toContain('disabled=""');
    expect(markup).toContain("設計");
  });

  it("supports all, multi-type, empty, loading, and error states without broadening target scope", () => {
    expect(searchTypesAreAllSelected(undefined)).toBe(true);
    expect(searchTypesAreAllSelected(["room", "knowledge"])).toBe(false);
    expect(toggleWorkspaceContextSearchType(["room", "knowledge"], "conversation")).toEqual(["room", "knowledge", "conversation"]);
    expect(toggleWorkspaceContextSearchType(["room"], "room")).toEqual(["room", "conversation", "knowledge"]);
    expect(workspaceContextSearchViewState({ loading: true, error: null, query: "設計", hasTarget: true, itemCount: 0 })).toBe("loading");
    expect(workspaceContextSearchViewState({ loading: false, error: "failed", query: "設計", hasTarget: true, itemCount: 0 })).toBe("error");
    expect(workspaceContextSearchViewState({ loading: false, error: null, query: "設計", hasTarget: true, itemCount: 0 })).toBe("empty");
    expect(workspaceContextSearchViewState({ loading: false, error: null, query: "設計", hasTarget: true, itemCount: 1 })).toBe("ready");
    expect(workspaceContextTargetKey(target)).not.toBe(workspaceContextTargetKey({ ...target, workspaceId: "workspace_b" }));
  });
});
