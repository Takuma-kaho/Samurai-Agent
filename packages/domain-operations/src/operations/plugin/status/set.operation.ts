// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { defineCommand, type DomainResult, type TrustedDomainContext } from "../../../definition/index.js";
import { pluginStatusValueSchema } from "../../../value-objects/system-records.js";

const Input = z.object({
  "plugin_id": z.string().trim().min(1),
  "status": z.enum(["enabled", "disabled"]),
}).strict();
const Output = pluginStatusValueSchema;

export interface PluginStatusSetPorts {
  setPluginEnabled(id: string, enabled: boolean): boolean;
  findPluginStatus(id: string): { manifest_id: string; version: string } | undefined;
  savePluginState(input: { manifestId: string; enabled: boolean; version: string }): Promise<z.infer<typeof Output>["state"]>;
  pluginNotFoundError(): Error;
}

const pluginStatusSet = defineCommand<PluginStatusSetPorts>()({
  ...{
  "kind": "command",
  "id": "plugin.status.set",
  "version": "2.0",
  "availability": "active",
  "runtimeRequirements": ["plugin_runtime"],
  "title": "Set plugin status",
  "description": "Enable or disable a registered Plugin without changing its manifest.",
  "sources": [
    "runtime_api",
    "surface_operation"
  ],
  "effect": "workspace_mutation",
  "idempotency": "required",
  "concurrency": "none",
  "render": [
    "status_timeline"
  ],
  "resourceKinds": [
    "plugin",
    "plugin_status"
  ],
  "proposedEffects": [
    "Persist the enabled or disabled state for a registered Plugin."
  ],
  "outputResourceKind": "plugin_status",
  "uiDisplayCategory": "settings",
  "provenance": [
    {
      "source": "samurai",
      "commit_sha": "workspace-design-v1",
      "reference_file": "ARCHITECTURE.md",
      "decision": "adapted",
      "reason": "Use a server-owned contract and a shared Runtime boundary for Workspace state."
    }
  ]
},
  input: Input,
  output: Output,
  createHandler(ports) {
    return {
      execute: async function handlePluginStatusSet(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        const enabled = input.status === "enabled";
        if (!ports.setPluginEnabled(input.plugin_id, enabled)) throw ports.pluginNotFoundError();
        const plugin = ports.findPluginStatus(input.plugin_id);
        if (!plugin) throw ports.pluginNotFoundError();
        const state = await ports.savePluginState({ manifestId: input.plugin_id, enabled, version: plugin.version });
        return { ok: true, value: { plugin, state } };
      }
    };
  }
});

export default pluginStatusSet;
