import type { SettingsRecord } from "@samurai-agent/core-schemas";

export interface SettingsWritePort {
  patch(patch: Partial<SettingsRecord>): Promise<SettingsRecord>;
}

export interface SettingsPatchInput {
  externalProviderRole?: SettingsRecord["external_provider_role"];
  knowledgeWikiCaptureMode?: SettingsRecord["knowledge_wiki_capture_mode"];
  memoryCaptureMode?: SettingsRecord["memory_capture_mode"];
  outputLocale?: SettingsRecord["output_locale"];
  skillCaptureMode?: SettingsRecord["skill_capture_mode"];
  uiLocale?: SettingsRecord["ui_locale"];
}

export class SettingsDomainService {
  constructor(private readonly settings: SettingsWritePort) {}

  patch(input: SettingsPatchInput) {
    return this.settings.patch({
      ...(input.externalProviderRole === undefined ? {} : { external_provider_role: input.externalProviderRole }),
      ...(input.knowledgeWikiCaptureMode === undefined ? {} : { knowledge_wiki_capture_mode: input.knowledgeWikiCaptureMode }),
      ...(input.memoryCaptureMode === undefined ? {} : { memory_capture_mode: input.memoryCaptureMode }),
      ...(input.outputLocale === undefined ? {} : { output_locale: input.outputLocale }),
      ...(input.skillCaptureMode === undefined ? {} : { skill_capture_mode: input.skillCaptureMode }),
      ...(input.uiLocale === undefined ? {} : { ui_locale: input.uiLocale })
    });
  }
}
