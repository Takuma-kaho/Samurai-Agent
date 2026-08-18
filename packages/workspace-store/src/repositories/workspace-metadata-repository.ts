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
      workspace_name: settings.workspace_name?.trim() || null,
      workspace_rules_json: JSON.stringify(normalizeRules(settings.workspace_rules)),
      ui_locale: settings.ui_locale,
      output_locale: settings.output_locale,
      memory_capture_mode: settings.memory_capture_mode,
      knowledge_wiki_capture_mode: settings.knowledge_wiki_capture_mode,
      skill_capture_mode: settings.skill_capture_mode,
      learning_enabled: settings.learning_enabled ? 1 : 0,
      learning_budget_ratio: settings.learning_budget_ratio,
      learning_budget_window_days: settings.learning_budget_window_days,
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
      workspace_name: row.workspace_name ?? undefined,
      workspace_rules: parseRules(row.workspace_rules_json),
      ui_locale: row.ui_locale as SettingsRecord["ui_locale"],
      output_locale: row.output_locale as SettingsRecord["output_locale"],
      memory_capture_mode: row.memory_capture_mode as SettingsRecord["memory_capture_mode"],
      knowledge_wiki_capture_mode: row.knowledge_wiki_capture_mode as SettingsRecord["knowledge_wiki_capture_mode"],
      skill_capture_mode: row.skill_capture_mode as SettingsRecord["skill_capture_mode"],
      learning_enabled: row.learning_enabled === 1,
      learning_budget_ratio: row.learning_budget_ratio,
      learning_budget_window_days: row.learning_budget_window_days,
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
      workspace_name: next.workspace_name?.trim() || null,
      workspace_rules_json: JSON.stringify(normalizeRules(next.workspace_rules)),
      ui_locale: next.ui_locale,
      output_locale: next.output_locale,
      memory_capture_mode: next.memory_capture_mode,
      knowledge_wiki_capture_mode: next.knowledge_wiki_capture_mode,
      skill_capture_mode: next.skill_capture_mode,
      learning_enabled: next.learning_enabled ? 1 : 0,
      learning_budget_ratio: next.learning_budget_ratio,
      learning_budget_window_days: next.learning_budget_window_days,
      external_provider_role: next.external_provider_role,
      default_backend_id: next.default_backend_id ?? null,
      default_room_id: next.default_room_id ?? null,
      default_agent_id: next.default_agent_id ?? null,
      updated_at: next.updated_at
    }).where("id", "=", "default").execute();
    return next;
  }

  /** Workspace context is human-owned metadata. It is deliberately separate
   * from external Connector state and read through the formal Runtime query. */
  async getWorkspaceContext(): Promise<{ workspace_name?: string; rules: string[]; updated_at: string }> {
    const settings = await this.getSettings();
    return {
      workspace_name: settings.workspace_name,
      rules: settings.workspace_rules ?? [],
      updated_at: settings.updated_at
    };
  }

  async getRoomContext(roomId: string): Promise<{ room_id: string; purpose?: string; work_goal?: string; updated_at: string } | undefined> {
    const row = await this.db.selectFrom("room_context_metadata").selectAll().where("room_id", "=", roomId).executeTakeFirst();
    if (!row) return undefined;
    return {
      room_id: row.room_id,
      purpose: row.purpose?.trim() || undefined,
      work_goal: row.work_goal?.trim() || undefined,
      updated_at: row.updated_at
    };
  }

  /** Intended for a human-owned settings surface. External Apps only read
   * these values through workspace.context.get. */
  async patchRoomContext(input: { roomId: string; purpose?: string; workGoal?: string }): Promise<{ room_id: string; purpose?: string; work_goal?: string; updated_at: string }> {
    const existing = await this.getRoomContext(input.roomId);
    const updatedAt = nowIso();
    const purpose = input.purpose === undefined ? existing?.purpose : input.purpose.trim() || undefined;
    const workGoal = input.workGoal === undefined ? existing?.work_goal : input.workGoal.trim() || undefined;
    await this.db.insertInto("room_context_metadata").values({
      room_id: input.roomId,
      purpose: purpose ?? null,
      work_goal: workGoal ?? null,
      updated_at: updatedAt
    }).onConflict((conflict) => conflict.column("room_id").doUpdateSet({
      purpose: purpose ?? null,
      work_goal: workGoal ?? null,
      updated_at: updatedAt
    })).execute();
    return { room_id: input.roomId, purpose, work_goal: workGoal, updated_at: updatedAt };
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

function normalizeRules(value: string[] | undefined): string[] {
  return [...new Set((value ?? []).map((rule) => rule.trim()).filter(Boolean))].slice(0, 200);
}

function parseRules(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? normalizeRules(parsed.filter((rule): rule is string => typeof rule === "string"))
      : [];
  } catch {
    return [];
  }
}
