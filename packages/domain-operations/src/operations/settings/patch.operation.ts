// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import type { SettingsRecord } from "@samurai-agent/core-schemas";
import { defineCommand, type DomainResult, type TrustedDomainContext } from "../../definition/index.js";
import { settingsValueSchema } from "../../value-objects/system-records.js";

const Input = z.object({
  "external_provider_role": z.enum(["assistive", "disabled"]) .optional(),
  "knowledge_wiki_capture_mode": z.enum(["auto", "manual", "off"]) .optional(),
  "memory_capture_mode": z.enum(["auto", "manual", "off"]) .optional(),
  "output_locale": z.enum(["en", "ja", "zh", "ko", "es", "pt-BR", "fr", "de"]) .optional(),
  "skill_capture_mode": z.enum(["auto", "manual", "off"]) .optional(),
  "ui_locale": z.enum(["en", "ja", "zh", "ko", "es", "pt-BR", "fr", "de"]) .optional()
}).strict();
const Output = settingsValueSchema;

export interface SettingsPatchPorts {
  patchSettings(patch: Partial<SettingsRecord>): Promise<SettingsRecord>;
}

const settingsPatch = defineCommand<SettingsPatchPorts>()({
  ...{
  "kind": "command",
  "id": "settings.patch",
  "version": "1.0",
  "availability": "active",
  "title": "Update settings",
  "description": "Update validated owner Workspace settings.",
  "sources": [
    "runtime_api",
    "surface_operation"
  ],
  "effect": "workspace_mutation",
  "idempotency": "required",
  "concurrency": "optimistic_version",
  "render": [
    "status_timeline"
  ],
  "resourceKinds": [
    "settings"
  ],
  "proposedEffects": [
    "Update owner Workspace settings."
  ],
  "outputResourceKind": "settings",
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
      execute: async function handleSettingsPatch(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        return { ok: true, value: await ports.patchSettings(input) };
      }
    };
  }
});

export default settingsPatch;
