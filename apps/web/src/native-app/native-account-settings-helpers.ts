import { nativeThemes, type NativeTheme } from "../lib/native-app-theme-preferences";
import type { NativeAccountPreferences } from "../lib/native-account-preferences";

export const nativeAccountSettingsCategories = [
  "profile",
  "responses",
  "appearance",
  "connections"
] as const;

export type NativeAccountSettingsCategory = (typeof nativeAccountSettingsCategories)[number];

export const nativeAccountSettingsCategoryLabels: Record<NativeAccountSettingsCategory, string> = {
  profile: "プロフィール",
  responses: "回答設定",
  appearance: "外観",
  connections: "接続"
};

export const nativeAccountLocaleLabels: Record<string, string> = {
  "": "既定値を使う",
  en: "English",
  ja: "日本語",
  zh: "中文",
  ko: "한국어",
  es: "Español",
  "pt-BR": "Português (Brasil)",
  fr: "Français",
  de: "Deutsch"
};

export const nativeAccountSettingsThemes = nativeThemes.map((theme) => ({
  ...theme,
  note: theme.id === "dark" ? "落ち着いた標準表示" : theme.id === "light" ? "明るく読みやすい表示" : "星を添えた特別表示"
}));

export interface NativeAccountSettingsDraft {
  displayName: string;
  outputLocale: NativeAccountPreferences["output_locale"];
  instructions: string;
}

export interface NativeAccountSettingsValidation {
  displayName?: string;
  outputLocale?: string;
  instructions?: string;
}

export type NativeAccountSettingsNavigationDecision = "proceed" | "confirm" | "blocked";

/**
 * Navigation from Account settings is allowed only after the two editable
 * forms have been considered.  Theme work is asynchronous too, so it keeps
 * the page in place until its persistence attempt has settled.
 */
export function nativeAccountSettingsNavigationDecision(input: {
  profileDirty: boolean;
  responsesDirty: boolean;
  saving: boolean;
  themeBusy: boolean;
}): NativeAccountSettingsNavigationDecision {
  if (input.saving || input.themeBusy) return "blocked";
  return input.profileDirty || input.responsesDirty ? "confirm" : "proceed";
}

export function nativeAccountSettingsDirtyFormLabel(profileDirty: boolean, responsesDirty: boolean): string {
  if (profileDirty && responsesDirty) return "プロフィールと回答設定";
  if (profileDirty) return "プロフィール";
  if (responsesDirty) return "回答設定";
  return "設定";
}

export function nativeAccountSettingsDraft(preferences: NativeAccountPreferences | undefined, fallbackDisplayName = ""): NativeAccountSettingsDraft {
  return {
    displayName: preferences?.display_name ?? fallbackDisplayName,
    outputLocale: preferences?.output_locale ?? null,
    instructions: preferences?.instructions ?? ""
  };
}

export function nativeAccountSettingsProfileInput(draft: NativeAccountSettingsDraft): string {
  return draft.displayName.trim();
}

export function nativeAccountSettingsValidateProfile(draft: NativeAccountSettingsDraft): NativeAccountSettingsValidation {
  const displayName = nativeAccountSettingsProfileInput(draft);
  return displayName.length === 0
    ? { displayName: "表示名を入力してください。" }
    : displayName.length > 200
      ? { displayName: "表示名は200文字以内で入力してください。" }
      : {};
}

export function nativeAccountSettingsValidateResponses(draft: NativeAccountSettingsDraft): NativeAccountSettingsValidation {
  return draft.instructions.length > 20_000
    ? { instructions: "個人指示は20,000文字以内で入力してください。" }
    : {};
}

export function nativeAccountSettingsHasErrors(validation: NativeAccountSettingsValidation): boolean {
  return Object.keys(validation).length > 0;
}

export function nativeAccountSettingsIsProfileDirty(
  draft: NativeAccountSettingsDraft,
  preferences: NativeAccountPreferences | undefined
): boolean {
  return draft.displayName !== (preferences?.display_name ?? "");
}

export function nativeAccountSettingsIsResponsesDirty(
  draft: NativeAccountSettingsDraft,
  preferences: NativeAccountPreferences | undefined
): boolean {
  return draft.outputLocale !== (preferences?.output_locale ?? null)
    || draft.instructions !== (preferences?.instructions ?? "");
}

export function nativeAccountSettingsConnectionStateLabel(state: NativeAccountConnectionReflectionState): string {
  switch (state) {
    case "synced": return "反映済み";
    case "pending": return "反映中";
    case "failed": return "未反映";
    case "offline": return "再接続で再試行";
    case "unknown": return "未確認";
  }
}

export type NativeAccountConnectionReflectionState = "synced" | "pending" | "failed" | "offline" | "unknown";

export function nativeAccountSettingsPreferenceErrorMessage(error: unknown): string {
  const code = typeof error === "object" && error !== null && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
  switch (code) {
    case "personal_settings_conflict":
      return "別のウィンドウで設定が更新されました。最新値を読み直してから保存してください。";
    case "personal_settings_storage_unavailable":
      return "この端末では設定を保存できません。ブラウザーの保存領域を確認してください。";
    case "personal_settings_storage_failed":
      return "設定を保存できませんでした。入力は保持しています。もう一度お試しください。";
    case "personal_settings_input_invalid":
      return "入力内容を確認してください。";
    default:
      return "設定を読み込めませんでした。もう一度お試しください。";
  }
}

export function nativeAccountSettingsThemeLabel(theme: NativeTheme): string {
  return nativeThemes.find((item) => item.id === theme)?.label ?? "ダーク";
}
