import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import NativeProfileMenu from "./NativeProfileMenu";

describe("NativeProfileMenu", () => {
  it("keeps the profile popup as a settings entry point", () => {
    const markup = renderToStaticMarkup(createElement(NativeProfileMenu, {
      accountLabel: "本人",
      open: true,
      onToggle: vi.fn(),
      onClose: vi.fn(),
      onOpenSettings: vi.fn()
    }));

    expect(markup).toContain("本人メニュー");
    expect(markup).toContain("本人設定");
    expect(markup).toContain("プロフィール・回答設定・外観");
    expect(markup.match(/role="menuitem"/g)).toHaveLength(1);
    expect(markup).not.toContain("C · ダーク");
    expect(markup).not.toContain("Workspaceを選択");
  });

  it("does not render the popup until the trigger opens it", () => {
    const markup = renderToStaticMarkup(createElement(NativeProfileMenu, {
      accountLabel: "本人",
      open: false,
      onToggle: vi.fn(),
      onClose: vi.fn(),
      onOpenSettings: vi.fn()
    }));
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).not.toContain("C · ダーク");
  });
});
