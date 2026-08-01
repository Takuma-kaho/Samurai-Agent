import { nowIso, type ResourceRef, type ResourceTranslationRecord, type SettingsRecord } from "@samurai-agent/core-schemas";
import type { Kysely } from "kysely";
import type { WorkspaceDb } from "../kernel/workspace-db-schema";
import type { ResourceTranslationResolution } from "../workspace-store-contracts";
import { resourceRefKey, resourceTranslationFromRow, resourceTranslationToRow } from "./workspace-metadata-row-codecs";

/** Settings, static built-in integration state, and translation derivatives. */
export class WorkspaceMetadataRepository {
  constructor(private readonly db: Kysely<WorkspaceDb>) {}

  async ensureDefaultSettings(settings: SettingsRecord): Promise<void> {
    const existing = await this.db.selectFrom("settings").select("id").where("id", "=", "default").executeTakeFirst();
    if (existing) return;
    await this.db.insertInto("settings").values({
      id: "default",
      ui_locale: settings.ui_locale,
      output_locale: settings.output_locale,
      memory_capture_mode: settings.memory_capture_mode,
      knowledge_wiki_capture_mode: settings.knowledge_wiki_capture_mode,
      skill_capture_mode: settings.skill_capture_mode,
      external_provider_role: settings.external_provider_role,
      default_backend_id: settings.default_backend_id ?? null,
      default_room_id: settings.default_room_id ?? null,
      default_agent_id: settings.default_agent_id ?? null,
      updated_at: settings.updated_at
    }).execute();
  }

  async getSettings(): Promise<SettingsRecord> {
    const row = await this.db.selectFrom("settings").selectAll().where("id", "=", "default").executeTakeFirstOrThrow();
    return {
      ui_locale: row.ui_locale as SettingsRecord["ui_locale"],
      output_locale: row.output_locale as SettingsRecord["output_locale"],
      memory_capture_mode: row.memory_capture_mode as SettingsRecord["memory_capture_mode"],
      knowledge_wiki_capture_mode: row.knowledge_wiki_capture_mode as SettingsRecord["knowledge_wiki_capture_mode"],
      skill_capture_mode: row.skill_capture_mode as SettingsRecord["skill_capture_mode"],
      external_provider_role: row.external_provider_role as SettingsRecord["external_provider_role"],
      default_backend_id: row.default_backend_id ?? undefined,
      default_room_id: row.default_room_id ?? undefined,
      default_agent_id: row.default_agent_id ?? undefined,
      updated_at: row.updated_at
    };
  }

  async patchSettings(patch: Partial<Omit<SettingsRecord, "updated_at">>): Promise<SettingsRecord> {
    const current = await this.getSettings();
    const next: SettingsRecord = { ...current, ...patch, updated_at: nowIso() };
    await this.db.updateTable("settings").set({
      ui_locale: next.ui_locale,
      output_locale: next.output_locale,
      memory_capture_mode: next.memory_capture_mode,
      knowledge_wiki_capture_mode: next.knowledge_wiki_capture_mode,
      skill_capture_mode: next.skill_capture_mode,
      external_provider_role: next.external_provider_role,
      default_backend_id: next.default_backend_id ?? null,
      default_room_id: next.default_room_id ?? null,
      default_agent_id: next.default_agent_id ?? null,
      updated_at: next.updated_at
    }).where("id", "=", "default").execute();
    return next;
  }

  async savePluginState(input: { manifestId: string; enabled: boolean; version: string }): Promise<{ manifest_id: string; enabled: boolean; version: string; updated_at: string }> {
    const updatedAt = nowIso();
    await this.db.insertInto("plugin_states").values({
      manifest_id: input.manifestId,
      enabled: input.enabled ? 1 : 0,
      version: input.version,
      updated_at: updatedAt
    }).onConflict((conflict) => conflict.column("manifest_id").doUpdateSet({
      enabled: input.enabled ? 1 : 0,
      version: input.version,
      updated_at: updatedAt
    })).execute();
    return { manifest_id: input.manifestId, enabled: input.enabled, version: input.version, updated_at: updatedAt };
  }

  async listPluginStates(): Promise<Array<{ manifest_id: string; enabled: boolean; version: string; updated_at: string }>> {
    return (await this.db.selectFrom("plugin_states").selectAll().orderBy("manifest_id").execute())
      .map((row) => ({ manifest_id: row.manifest_id, enabled: row.enabled === 1, version: row.version, updated_at: row.updated_at }));
  }

  async saveResourceTranslation(record: ResourceTranslationRecord): Promise<ResourceTranslationRecord> {
    const row = resourceTranslationToRow(record);
    await this.db.insertInto("resource_translations").values(row).onConflict((conflict) => conflict.column("id").doUpdateSet(row)).execute();
    return record;
  }

  async listResourceTranslations(input: { sourceRef?: ResourceRef; targetLocale?: ResourceTranslationRecord["target_locale"]; status?: ResourceTranslationRecord["status"] } = {}): Promise<ResourceTranslationRecord[]> {
    let query = this.db.selectFrom("resource_translations").selectAll();
    if (input.targetLocale) query = query.where("target_locale", "=", input.targetLocale);
    if (input.status) query = query.where("status", "=", input.status);
    const records = (await query.orderBy("updated_at", "desc").execute()).map(resourceTranslationFromRow);
    if (!input.sourceRef) return records;
    const key = resourceRefKey(input.sourceRef);
    return records.filter((record) => resourceRefKey(record.source_ref) === key);
  }

  async resolveResourceTranslation(input: {
    sourceRef: ResourceRef;
    targetLocale: ResourceTranslationRecord["target_locale"];
    originalHash?: string;
    fallbackText?: string;
  }): Promise<ResourceTranslationResolution> {
    const translations = await this.listResourceTranslations({ sourceRef: input.sourceRef, targetLocale: input.targetLocale });
    const current = input.originalHash ? translations.filter((record) => record.original_hash === input.originalHash) : translations;
    const preferred = current.find((record) => record.status === "verified") ?? current.find((record) => record.status === "draft");
    return preferred
      ? { status: preferred.status, text: preferred.translated_text, source: "translation", target_locale: input.targetLocale, translation: preferred }
      : { status: "missing", text: input.fallbackText ?? "", source: "fallback", target_locale: input.targetLocale };
  }
}
