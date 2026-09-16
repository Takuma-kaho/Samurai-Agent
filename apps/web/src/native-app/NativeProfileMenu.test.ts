import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import NativeProfileMenu from "./NativeProfileMenu";

describe("NativeProfileMenu", () => {
  it("exposes the real Workspace choices and only the three theme choices", () => {
    const markup = renderToStaticMarkup(createElement(NativeProfileMenu, {
      accountLabel: "本人",
      open: true,
      theme: "dark",
      selectedWorkspaceTargetKey: "connection-a\nworkspace-a",
      workspaces: [
        { id: "workspace-a", name: "調査", state: "active", access: "granted", target: { connectionId: "connection-a", workspaceId: "workspace-a" } },
        { id: "workspace-b", name: "閲覧不可", state: "read_only", access: "none", target: { connectionId: "connection-a", workspaceId: "workspace-b" } }
      ],
      onToggle: vi.fn(),
      onClose: vi.fn(),
      onThemeChange: vi.fn(),
      onSelectWorkspace: vi.fn()
    }));

    expect(markup).toContain("本人メニュー");
    expect(markup).toContain("調査");
    expect(markup).toContain("native-profile-workspace-name");
    expect(markup).toContain("◎</span>調査");
    expect(markup).toContain("C · ダーク");
    expect(markup).toContain("B · ライト");
    expect(markup).toContain("A · 特別版");
    expect(markup).toContain('aria-checked="true"');
    expect(markup.match(/role="menuitemradio"/g)).toHaveLength(5);
    expect(markup).toContain("disabled=\"\"");
  });

  it("does not render the popup until the trigger opens it", () => {
    const markup = renderToStaticMarkup(createElement(NativeProfileMenu, {
      accountLabel: "本人",
      open: false,
      theme: "dark",
      workspaces: [],
      onToggle: vi.fn(),
      onClose: vi.fn(),
      onThemeChange: vi.fn(),
      onSelectWorkspace: vi.fn()
    }));
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).not.toContain("C · ダーク");
  });
});
