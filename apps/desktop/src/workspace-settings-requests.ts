type SettingsPatch = Record<string, unknown>;

const opaqueIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const patchKeys = new Set([
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

export function workspaceSettingsPatchRequest(input: unknown): {
  operationId: string;
  body: SettingsPatch;
} {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("workspace_settings_request_invalid");
  const value = input as Record<string, unknown>;
  if (typeof value.operationId !== "string" || !opaqueIdPattern.test(value.operationId)) throw new Error("operationId_invalid");
  if (!value.patch || typeof value.patch !== "object" || Array.isArray(value.patch)) throw new Error("settings_patch_invalid");
  const patch = value.patch as Record<string, unknown>;
  if (Object.keys(patch).some((key) => !patchKeys.has(key))) throw new Error("settings_field_invalid");
  for (const [key, candidate] of Object.entries(patch)) {
    if (typeof candidate === "string" && candidate.length > 20_000) throw new Error(`${key}_too_large`);
    if (key === "workspace_rules" && (!Array.isArray(candidate) || candidate.length > 200 || candidate.some((rule) => typeof rule !== "string" || rule.length > 4_000))) {
      throw new Error("workspace_rules_invalid");
    }
    if (key === "learning_budget_ratio" && (typeof candidate !== "number" || !Number.isFinite(candidate))) throw new Error("learning_budget_ratio_invalid");
    if (key === "learning_budget_window_days" && (typeof candidate !== "number" || !Number.isInteger(candidate))) throw new Error("learning_budget_window_days_invalid");
    if (key === "learning_enabled" && typeof candidate !== "boolean") throw new Error("learning_enabled_invalid");
  }
  return { operationId: value.operationId, body: patch };
}

export function workspaceSettingsPatchJson(input: SettingsPatch): Record<string, unknown> {
  return input;
}
