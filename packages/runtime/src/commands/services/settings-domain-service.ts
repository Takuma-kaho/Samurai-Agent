import type { AgentRecord, RoomRecord, SettingsRecord } from "@samurai-agent/core-schemas";

export interface SettingsWritePort {
  patch(patch: Partial<SettingsRecord>): Promise<SettingsRecord>;
}

export interface SettingsPatchInput {
  defaultAgentId?: string;
  defaultRoomId?: string;
  externalProviderRole?: SettingsRecord["external_provider_role"];
  knowledgeWikiCaptureMode?: SettingsRecord["knowledge_wiki_capture_mode"];
  memoryCaptureMode?: SettingsRecord["memory_capture_mode"];
  outputLocale?: SettingsRecord["output_locale"];
  skillCaptureMode?: SettingsRecord["skill_capture_mode"];
  uiLocale?: SettingsRecord["ui_locale"];
}

export interface SettingsRoomAgentPort {
  getRoom(id: string): Promise<RoomRecord | undefined>;
  getAgent(id: string): Promise<AgentRecord | undefined>;
}

export class SettingsDomainService {
  constructor(
    private readonly settings: SettingsWritePort,
    private readonly roomAgent: SettingsRoomAgentPort,
    private readonly requestError: (code: "not_found" | "conflict", message: string) => Error
  ) {}

  async patch(input: SettingsPatchInput) {
    if (input.defaultRoomId !== undefined && !await this.roomAgent.getRoom(input.defaultRoomId)) {
      throw this.requestError("not_found", `room_not_found:${input.defaultRoomId}`);
    }
    if (input.defaultAgentId !== undefined) {
      const agent = await this.roomAgent.getAgent(input.defaultAgentId);
      if (!agent) throw this.requestError("not_found", `agent_not_found:${input.defaultAgentId}`);
      if (!agent.enabled) throw this.requestError("conflict", `default_agent_disabled:${input.defaultAgentId}`);
    }
    return this.settings.patch({
      ...(input.defaultAgentId === undefined ? {} : { default_agent_id: input.defaultAgentId }),
      ...(input.defaultRoomId === undefined ? {} : { default_room_id: input.defaultRoomId }),
      ...(input.externalProviderRole === undefined ? {} : { external_provider_role: input.externalProviderRole }),
      ...(input.knowledgeWikiCaptureMode === undefined ? {} : { knowledge_wiki_capture_mode: input.knowledgeWikiCaptureMode }),
      ...(input.memoryCaptureMode === undefined ? {} : { memory_capture_mode: input.memoryCaptureMode }),
      ...(input.outputLocale === undefined ? {} : { output_locale: input.outputLocale }),
      ...(input.skillCaptureMode === undefined ? {} : { skill_capture_mode: input.skillCaptureMode }),
      ...(input.uiLocale === undefined ? {} : { ui_locale: input.uiLocale })
    });
  }
}
