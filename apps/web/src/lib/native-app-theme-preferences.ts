/**
 * Native App の表示テーマは、この端末だけに保存する Client 設定です。
 * Workspace の認可情報、会話、成果物、資格情報はここへ保存しません。
 */
export const nativeThemePreferenceKey = "samurai.native-app.theme.v1";

export const nativeThemes = [
  { id: "dark", code: "C", label: "ダーク", description: "標準の濃いチャット面" },
  { id: "light", code: "B", label: "ライト", description: "読みやすい明るいチャット面" },
  { id: "special", code: "A", label: "特別版", description: "控えめな星を添えた特別表示" }
] as const;

export type NativeTheme = (typeof nativeThemes)[number]["id"];

export const nativeThemeDefault: NativeTheme = "dark";

const nativeThemeIds = new Set<NativeTheme>(nativeThemes.map((theme) => theme.id));

/** Unknown, missing, or malformed values always resolve to C (dark). */
export function normalizeNativeTheme(value: unknown): NativeTheme {
  return typeof value === "string" && nativeThemeIds.has(value as NativeTheme)
    ? value as NativeTheme
    : nativeThemeDefault;
}

function canUseStorage(): boolean {
  try {
    return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
  } catch {
    return false;
  }
}

/** Read-only preference lookup; unavailable or broken storage never blocks startup. */
export function readNativeThemePreference(): NativeTheme {
  if (!canUseStorage()) return nativeThemeDefault;
  try {
    return normalizeNativeTheme(window.localStorage.getItem(nativeThemePreferenceKey));
  } catch {
    return nativeThemeDefault;
  }
}

/** Persist only the allowlisted theme. A storage failure must not block switching. */
export function writeNativeThemePreference(value: unknown): NativeTheme {
  const normalized = normalizeNativeTheme(value);
  if (!canUseStorage()) return normalized;
  try {
    window.localStorage.setItem(nativeThemePreferenceKey, normalized);
  } catch {
    // Safari private mode, disabled storage, and quota errors are non-fatal.
  }
  return normalized;
}
