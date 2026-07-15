import {
  CaptureModeSchema,
  ExternalProviderRoleSchema,
  SupportedLocaleSchema,
  type JsonValue,
  type SettingsRecord
} from "@samurai-agent/core-schemas";

export interface SettingsWritePort {
  patch(patch: Partial<SettingsRecord>): Promise<SettingsRecord>;
}

export class SettingsDomainService {
  constructor(private readonly settings: SettingsWritePort) {}

  patch(payload: Record<string, JsonValue>) {
    const patch: Partial<SettingsRecord> = {};
    const uiLocale = SupportedLocaleSchema.safeParse(payload.ui_locale);
    const outputLocale = SupportedLocaleSchema.safeParse(payload.output_locale);
    if (uiLocale.success) patch.ui_locale = uiLocale.data;
    if (outputLocale.success) patch.output_locale = outputLocale.data;
    for (const key of ["memory_capture_mode", "knowledge_wiki_capture_mode", "skill_capture_mode"] as const) {
      const parsed = CaptureModeSchema.safeParse(payload[key]);
      if (parsed.success) patch[key] = parsed.data;
    }
    const externalRole = ExternalProviderRoleSchema.safeParse(payload.external_provider_role);
    if (externalRole.success) patch.external_provider_role = externalRole.data;
    return this.settings.patch(patch);
  }
}
