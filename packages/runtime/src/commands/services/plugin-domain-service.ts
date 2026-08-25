export interface PluginStatusPort {
  setEnabled(pluginId: string, enabled: boolean): boolean;
  findStatus(pluginId: string): { manifest_id: string; version: string; enabled: boolean } | undefined;
  saveState(input: { manifestId: string; enabled: boolean; version: string }): Promise<{ manifest_id: string; enabled: boolean; version: string; updated_at: string }>;
}

export interface PluginDomainServiceDependencies {
  plugins: PluginStatusPort;
  requestError: (code: "conflict" | "not_found", message: string) => Error;
}

export class PluginDomainService {
  constructor(private readonly dependencies: PluginDomainServiceDependencies) {}

  setEnabled(id: string, enabled: boolean) {
    return this.dependencies.plugins.setEnabled(id, enabled);
  }

  findStatus(id: string) {
    return this.dependencies.plugins.findStatus(id);
  }

  getEnabled(id: string): boolean | undefined {
    return this.dependencies.plugins.findStatus(id)?.enabled;
  }

  saveState(input: { manifestId: string; enabled: boolean; version: string }) {
    return this.dependencies.plugins.saveState(input);
  }

  notFoundError(): Error {
    return this.dependencies.requestError("not_found", "plugin_not_found");
  }
}
