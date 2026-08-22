import { supportedLocales, type SettingsRecord, type SupportedLocale } from "@samurai-agent/core-schemas";

const settingsStorageKey = "samurai-agent.settings";

export function readStoredSettings(): SettingsRecord | undefined {
  try {
    const raw = window.localStorage.getItem(settingsStorageKey);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as unknown;
    return isSettingsRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function persistSettings(settings: SettingsRecord) {
  try { window.localStorage.setItem(settingsStorageKey, JSON.stringify(settings)); } catch { /* restricted storage */ }
}

function isSettingsRecord(value: unknown): value is SettingsRecord {
  if (!isRecord(value)) return false;
  return typeof value.ui_locale === "string" && supportedLocales.includes(value.ui_locale as SupportedLocale)
    && typeof value.output_locale === "string" && supportedLocales.includes(value.output_locale as SupportedLocale)
    && isCaptureMode(value.memory_capture_mode) && isCaptureMode(value.knowledge_wiki_capture_mode) && isCaptureMode(value.skill_capture_mode)
    && typeof value.learning_enabled === "boolean" && typeof value.learning_budget_ratio === "number"
    && Number.isFinite(value.learning_budget_ratio) && value.learning_budget_ratio >= 0 && value.learning_budget_ratio <= 1
    && typeof value.learning_budget_window_days === "number" && Number.isInteger(value.learning_budget_window_days)
    && value.learning_budget_window_days > 0
    && (value.external_provider_role === "assistive" || value.external_provider_role === "disabled") && typeof value.updated_at === "string";
}
function isCaptureMode(value: unknown): boolean { return value === "auto" || value === "manual" || value === "off"; }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
