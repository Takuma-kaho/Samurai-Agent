import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { NativeAccountPreferences, NativeAccountPreferencesInput } from "../lib/native-account-preferences";
import NativeAccountSettings from "./NativeAccountSettings";
import {
  nativeAccountSettingsConnectionStateLabel,
  nativeAccountSettingsDirtyFormLabel,
  nativeAccountSettingsDraft,
  nativeAccountSettingsIsProfileDirty,
  nativeAccountSettingsIsResponsesDirty,
  nativeAccountSettingsNavigationDecision,
  nativeAccountSettingsPreferenceErrorMessage,
  nativeAccountSettingsValidateProfile,
  nativeAccountSettingsValidateResponses
} from "./native-account-settings-helpers";

const preferences: NativeAccountPreferences = {
  schema_version: 1,
  revision: 4,
  display_name: "調査担当",
  output_locale: "ja",
  instructions: "結論から簡潔に回答してください。",
  updated_at: "2026-09-17T00:00:00.000Z"
};

const store = {
  load: vi.fn(async () => preferences),
  save: vi.fn(async (_accountId: string, _revision: number, input: NativeAccountPreferencesInput): Promise<NativeAccountPreferences> => ({
    schema_version: 1,
    revision: preferences.revision + 1,
    display_name: input.display_name,
    output_locale: input.output_locale,
    instructions: input.instructions,
    updated_at: preferences.updated_at
  }))
};

describe("NativeAccountSettings", () => {
  it("renders the full-screen profile form with independent save/cancel and a read-only Account ID", () => {
    const markup = renderToStaticMarkup(createElement(NativeAccountSettings, {
      accountId: "account_a",
      initialPreferences: preferences,
      preferencesStore: store,
      theme: "dark",
      onThemeChange: vi.fn(),
      onCopyAccountId: vi.fn(),
      onBack: vi.fn()
    }));

    expect(markup).toContain("本人設定");
    expect(markup).toContain("プロフィール");
    expect(markup).toContain("回答設定");
    expect(markup).toContain("外観");
    expect(markup).toContain("接続");
    expect(markup).toContain("調査担当");
    expect(markup).toContain("account_a");
    expect(markup).toContain("取消");
    expect(markup).toContain("保存");
    expect(markup).not.toContain("破棄して移動");
    expect(markup).not.toContain("会話本文へ");
  });

  it("shows account-local response settings and preserves the explicit no-sync boundary", () => {
    const markup = renderToStaticMarkup(createElement(NativeAccountSettings, {
      accountId: "account_a",
      initialPreferences: preferences,
      initialCategory: "responses",
      preferencesStore: store,
      theme: "light",
      onThemeChange: vi.fn(),
      onBack: vi.fn()
    }));

    expect(markup).toContain("回答設定");
    expect(markup).toContain("日本語");
    expect(markup).toContain("Client間同期は行いません");
    expect(markup).toContain("個人指示");
    expect(markup).toContain("結論から簡潔に回答してください。");
    expect(markup).toContain("20,000文字");
  });

  it("renders the three allowlisted themes and read-only connection reflection state", () => {
    const markup = renderToStaticMarkup(createElement(NativeAccountSettings, {
      accountId: "account_a",
      initialPreferences: preferences,
      initialCategory: "appearance",
      theme: "special",
      preferencesStore: store,
      onThemeChange: vi.fn(),
      onBack: vi.fn()
    }));
    expect(markup).toContain("C · ダーク");
    expect(markup).toContain("B · ライト");
    expect(markup).toContain("A · 特別版");
    expect(markup).toContain('role="radio"');
    expect(markup).toContain('aria-checked="true"');

    const connections = renderToStaticMarkup(createElement(NativeAccountSettings, {
      accountId: "account_a",
      initialPreferences: preferences,
      initialCategory: "connections",
      preferencesStore: store,
      theme: "dark",
      onThemeChange: vi.fn(),
      connections: [
        { id: "connection_a", label: "本番Server", serverUrl: "https://server.example", accountId: "account_a", createdAt: "2026-09-17T00:00:00.000Z", updatedAt: "2026-09-17T00:00:00.000Z" },
        { id: "connection_b", label: "再接続待ち", serverUrl: "https://offline.example", accountId: "account_a", createdAt: "2026-09-17T00:00:00.000Z", updatedAt: "2026-09-17T00:00:00.000Z" }
      ],
      connectionReflections: [
        { connectionId: "connection_a", state: "synced" },
        { connectionId: "connection_b", state: "failed", error: "接続できません" }
      ],
      onRetryConnection: vi.fn(),
      onBack: vi.fn()
    }));
    expect(connections).toContain("本番Server");
    expect(connections).toContain("反映済み");
    expect(connections).toContain("未反映");
    expect(connections).toContain("再確認");
    expect(connections).toContain("資格情報や秘密鍵は表示しません");
  });
});

describe("NativeAccountSettings helpers", () => {
  it("requires explicit navigation confirmation only for dirty forms and blocks while saving", () => {
    expect(nativeAccountSettingsNavigationDecision({ profileDirty: false, responsesDirty: false, saving: false, themeBusy: false })).toBe("proceed");
    expect(nativeAccountSettingsNavigationDecision({ profileDirty: true, responsesDirty: false, saving: false, themeBusy: false })).toBe("confirm");
    expect(nativeAccountSettingsNavigationDecision({ profileDirty: false, responsesDirty: true, saving: false, themeBusy: false })).toBe("confirm");
    expect(nativeAccountSettingsNavigationDecision({ profileDirty: true, responsesDirty: true, saving: true, themeBusy: false })).toBe("blocked");
    expect(nativeAccountSettingsNavigationDecision({ profileDirty: false, responsesDirty: false, saving: false, themeBusy: true })).toBe("blocked");
    expect(nativeAccountSettingsDirtyFormLabel(true, false)).toBe("プロフィール");
    expect(nativeAccountSettingsDirtyFormLabel(false, true)).toBe("回答設定");
    expect(nativeAccountSettingsDirtyFormLabel(true, true)).toBe("プロフィールと回答設定");
  });

  it("keeps profile and response drafts independent and validates their limits", () => {
    const draft = nativeAccountSettingsDraft(preferences);
    expect(draft).toEqual({ displayName: "調査担当", outputLocale: "ja", instructions: preferences.instructions });
    expect(nativeAccountSettingsIsProfileDirty({ ...draft, displayName: " 別名 " }, preferences)).toBe(true);
    expect(nativeAccountSettingsIsResponsesDirty({ ...draft, instructions: "変更" }, preferences)).toBe(true);
    expect(nativeAccountSettingsValidateProfile({ ...draft, displayName: " " })).toMatchObject({ displayName: expect.any(String) });
    expect(nativeAccountSettingsValidateProfile({ ...draft, displayName: "a".repeat(201) })).toMatchObject({ displayName: expect.any(String) });
    expect(nativeAccountSettingsValidateResponses({ ...draft, instructions: "x".repeat(20_001) })).toMatchObject({ instructions: expect.any(String) });
  });

  it("does not turn storage conflict or connection failure into a false success", () => {
    expect(nativeAccountSettingsPreferenceErrorMessage({ code: "personal_settings_conflict" })).toContain("最新値を読み直して");
    expect(nativeAccountSettingsPreferenceErrorMessage({ code: "personal_settings_storage_failed" })).toContain("入力は保持");
    expect(nativeAccountSettingsConnectionStateLabel("unknown")).toBe("未確認");
    expect(nativeAccountSettingsConnectionStateLabel("offline")).toBe("再接続で再試行");
  });

  it("exposes an accessible explicit unsaved-navigation prompt without parent reset hooks", () => {
    const source = readFileSync(new URL("./NativeAccountSettings.tsx", import.meta.url), "utf8");
    const markup = renderToStaticMarkup(createElement(NativeAccountSettings, {
      accountId: "account_a",
      initialPreferences: preferences,
      preferencesStore: store,
      theme: "dark",
      onThemeChange: vi.fn(),
      onBack: vi.fn()
    }));
    expect(markup).toContain('aria-label="本人設定を閉じて元の画面へ戻る"');
    expect(source).toContain('role="alertdialog"');
    expect(source).toContain('aria-modal="true"');
    expect(source).toContain("保存せず");
    expect(source).toContain("編集を続ける");
    expect(source).not.toContain("returnContext");
  });
});
