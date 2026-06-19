import type { SettingsRecord, SupportedLocale } from "@samurai-agent/core-schemas";
import { defaultSettings, supportedLocales } from "@samurai-agent/core-schemas";
import de from "../locales/de.json";
import en from "../locales/en.json";
import es from "../locales/es.json";
import fr from "../locales/fr.json";
import ja from "../locales/ja.json";
import ko from "../locales/ko.json";
import ptBR from "../locales/pt-BR.json";
import zh from "../locales/zh.json";

export type LocaleKey = keyof typeof ja;
export type LocaleMessages = Record<LocaleKey, string>;

export const localeMessages: Record<SupportedLocale, LocaleMessages> = {
  de: de as LocaleMessages,
  en: en as LocaleMessages,
  es: es as LocaleMessages,
  fr: fr as LocaleMessages,
  ja: ja as LocaleMessages,
  ko: ko as LocaleMessages,
  "pt-BR": ptBR as LocaleMessages,
  zh: zh as LocaleMessages
};

export const canonicalLocale: SupportedLocale = "ja";
export const firstClassLocale: SupportedLocale = "en";

export function isSupportedLocale(value: string | undefined): value is SupportedLocale {
  return Boolean(value && supportedLocales.includes(value as SupportedLocale));
}

export function resolveLocales(input: Partial<Pick<SettingsRecord, "ui_locale" | "output_locale">>): SettingsRecord {
  const defaults = defaultSettings();
  return {
    ...defaults,
    ui_locale: isSupportedLocale(input.ui_locale) ? input.ui_locale : defaults.ui_locale,
    output_locale: isSupportedLocale(input.output_locale) ? input.output_locale : defaults.output_locale
  };
}

export function t(locale: SupportedLocale, key: LocaleKey): string {
  return localeMessages[locale][key] ?? localeMessages[canonicalLocale][key] ?? key;
}

export function assertLocaleKeyParity(messages = localeMessages): void {
  const canonicalKeys = Object.keys(messages[canonicalLocale]).sort();

  for (const locale of supportedLocales) {
    const keys = Object.keys(messages[locale]).sort();
    const missing = canonicalKeys.filter((key) => !keys.includes(key));
    const extra = keys.filter((key) => !canonicalKeys.includes(key));
    const empty = keys.filter((key) => messages[locale][key as LocaleKey].trim().length === 0);

    if (missing.length > 0 || extra.length > 0 || empty.length > 0) {
      throw new Error(
        `Locale ${locale} is out of sync. missing=${missing.join(",")} extra=${extra.join(",")} empty=${empty.join(",")}`
      );
    }
  }
}
