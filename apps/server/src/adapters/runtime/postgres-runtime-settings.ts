import {
  captureModes,
  defaultSettings,
  externalProviderRoles,
  supportedLocales,
  type JsonValue,
  type SettingsRecord
} from "@samurai-agent/core-schemas";
import {
  PostgresWorkspaceDatabase,
  WorkspaceServerError,
  type WorkspaceRequestContext,
  type WorkspaceServerStore,
  type WorkspaceSql
} from "@samurai-agent/workspace-server";

export type PostgresRuntimeSettingsPatch = Partial<Omit<SettingsRecord, "updated_at">>;

/** Settings are Workspace metadata, not browser-local preferences. Web and
 * Desktop reach this adapter only through the signed Workspace boundary. */
export class PostgresRuntimeSettings {
  constructor(
    private readonly database: PostgresWorkspaceDatabase,
    private readonly store: WorkspaceServerStore
  ) {}

  async get(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">): Promise<SettingsRecord> {
    return this.database.withContext(context, async (sql) => {
      const result = await sql.query<{ settings: unknown }>(
        "SELECT settings FROM workspace_runtime_settings WHERE workspace_id = $1",
        [context.workspaceId]
      );
      return normalizeSettings(result.rows[0]?.settings);
    });
  }

  async patch(context: WorkspaceRequestContext, patch: PostgresRuntimeSettingsPatch): Promise<{ settings: SettingsRecord; replayed: boolean }> {
    assertPatchKeys(patch);
    const result = await this.store.runIdempotentResult(
      context,
      { action: "runtime.settings.patch", input: patch },
      async (sql) => {
        const current = await readSettings(sql, context.workspaceId);
        const settings = normalizeSettings({ ...current, ...patch, updated_at: new Date().toISOString() });
        await sql.query(
          `INSERT INTO workspace_runtime_settings(workspace_id, settings, updated_at)
           VALUES ($1, $2::JSONB, NOW())
           ON CONFLICT (workspace_id) DO UPDATE SET settings = EXCLUDED.settings, updated_at = NOW()`,
          [context.workspaceId, JSON.stringify(settings)]
        );
        await this.store.insertAudit(sql, context, {
          action: "runtime.settings.patch",
          subjectKind: "runtime_settings",
          subjectId: context.workspaceId,
          details: { changed_keys: Object.keys(patch) } as Record<string, JsonValue>
        });
        return settings;
      }
    );
    return { settings: result.value, replayed: result.replayed };
  }
}

async function readSettings(sql: WorkspaceSql, workspaceId: string): Promise<SettingsRecord> {
  const result = await sql.query<{ settings: unknown }>(
    "SELECT settings FROM workspace_runtime_settings WHERE workspace_id = $1",
    [workspaceId]
  );
  return normalizeSettings(result.rows[0]?.settings);
}

function normalizeSettings(value: unknown): SettingsRecord {
  const base = defaultSettings();
  const candidate = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const merged = { ...base, ...candidate };
  if (!isLocale(merged.ui_locale) || !isLocale(merged.output_locale)
    || !isCaptureMode(merged.memory_capture_mode)
    || !isCaptureMode(merged.knowledge_wiki_capture_mode)
    || !isCaptureMode(merged.skill_capture_mode)
    || typeof merged.learning_enabled !== "boolean"
    || typeof merged.learning_budget_ratio !== "number"
    || !Number.isFinite(merged.learning_budget_ratio) || merged.learning_budget_ratio < 0 || merged.learning_budget_ratio > 1
    || typeof merged.learning_budget_window_days !== "number"
    || !Number.isInteger(merged.learning_budget_window_days) || merged.learning_budget_window_days <= 0
    || !isExternalProviderRole(merged.external_provider_role)
    || typeof merged.updated_at !== "string"
    || !optionalText(merged.default_backend_id)
    || !optionalText(merged.default_room_id)
    || !optionalText(merged.default_agent_id)) {
    throw new WorkspaceServerError("runtime_settings_invalid", 503);
  }
  if (merged.workspace_name !== undefined && typeof merged.workspace_name !== "string") throw new WorkspaceServerError("runtime_settings_invalid", 503);
  if (merged.workspace_rules !== undefined && (!Array.isArray(merged.workspace_rules) || merged.workspace_rules.some((rule) => typeof rule !== "string"))) {
    throw new WorkspaceServerError("runtime_settings_invalid", 503);
  }
  return merged as SettingsRecord;
}

function isLocale(value: unknown): value is SettingsRecord["ui_locale"] {
  return typeof value === "string" && supportedLocales.includes(value as SettingsRecord["ui_locale"]);
}

function isCaptureMode(value: unknown): value is SettingsRecord["memory_capture_mode"] {
  return typeof value === "string" && captureModes.includes(value as SettingsRecord["memory_capture_mode"]);
}

function isExternalProviderRole(value: unknown): value is SettingsRecord["external_provider_role"] {
  return typeof value === "string" && externalProviderRoles.includes(value as SettingsRecord["external_provider_role"]);
}

function optionalText(value: unknown): boolean {
  return value === undefined || (typeof value === "string" && value.trim().length > 0 && value.length <= 512);
}

function assertPatchKeys(patch: PostgresRuntimeSettingsPatch): void {
  const allowed = new Set([
    "workspace_name",
    "workspace_rules",
    "ui_locale",
    "output_locale",
    "memory_capture_mode",
    "knowledge_wiki_capture_mode",
    "skill_capture_mode",
    "learning_enabled",
    "learning_budget_ratio",
    "learning_budget_window_days",
    "external_provider_role",
    "default_backend_id",
    "default_room_id",
    "default_agent_id"
  ]);
  if (Object.keys(patch).some((key) => !allowed.has(key))) throw new WorkspaceServerError("runtime_settings_field_invalid", 400);
}
