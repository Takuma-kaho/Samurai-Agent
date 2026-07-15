import type { JsonValue } from "@samurai-agent/core-schemas";

export interface PluginStatusPort {
  setEnabled(pluginId: string, enabled: boolean): boolean;
  findStatus(pluginId: string): { manifest_id: string; version: string } | undefined;
  saveState(input: { manifestId: string; enabled: boolean; version: string }): Promise<{ manifest_id: string; enabled: boolean; version: string; updated_at: string }>;
}

export interface PluginDomainServiceDependencies {
  plugins: PluginStatusPort;
  requestError: (code: "conflict" | "not_found", message: string) => Error;
}

export class PluginDomainService {
  constructor(private readonly dependencies: PluginDomainServiceDependencies) {}

  async setStatus(payload: Record<string, JsonValue>) {
    const pluginId = requiredString(payload, "plugin_id");
    const status = optionalString(payload.status);
    if (status !== "enabled" && status !== "disabled") {
      throw this.dependencies.requestError("conflict", "plugin_status_required");
    }
    const enabled = status === "enabled";
    if (!this.dependencies.plugins.setEnabled(pluginId, enabled)) {
      throw this.dependencies.requestError("not_found", "plugin_not_found");
    }
    const plugin = this.dependencies.plugins.findStatus(pluginId);
    if (!plugin) throw this.dependencies.requestError("not_found", "plugin_not_found");
    const state = await this.dependencies.plugins.saveState({ manifestId: pluginId, enabled, version: plugin.version });
    return { plugin, state };
  }
}

function optionalString(value: JsonValue | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

function requiredString(payload: Record<string, JsonValue>, key: string): string {
  const value = optionalString(payload[key]);
  if (!value) throw new Error(`domain_operation_required_field:${key}`);
  return value;
}
