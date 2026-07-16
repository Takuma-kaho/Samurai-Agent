import type { SettingsRecord } from "@samurai-agent/core-schemas";

export interface SettingsWritePort {
  patch(patch: Partial<SettingsRecord>): Promise<SettingsRecord>;
}

export class SettingsDomainService {
  constructor(private readonly settings: SettingsWritePort) {}

  patch(patch: Partial<SettingsRecord>) {
    return this.settings.patch(patch);
  }
}
