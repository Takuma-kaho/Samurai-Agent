// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { domainJsonValueSchema, defineCommand, type DomainResult, type TrustedDomainContext } from "../../../definition/index.js";
import { pluginStatusValueSchema } from "../../../value-objects/system-records.js";

const Input = z.object({
  "envelope_id": z.string() .optional(),
  "input_locale": z.string() .optional(),
  "input_message_id": z.string() .optional(),
  "metadata": z.record(domainJsonValueSchema) .optional(),
  "output_locale": z.string() .optional(),
  "plugin_id": z.string(),
  "provider_tool_call": z.boolean() .optional(),
  "session_id": z.string() .optional(),
  "source_operation_id": z.string() .optional(),
  "status": z.enum(["enabled", "disabled"]),
  "surface_operation_id": z.string() .optional()
}).strict();
const Output = pluginStatusValueSchema;

export interface PluginStatusSetPorts {
  executePluginStatusSet(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> | DomainResult<z.infer<typeof Output>>;
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
        return ports.executePluginStatusSet(context, input);
      }
    };
  }
});

export default pluginStatusSet;
