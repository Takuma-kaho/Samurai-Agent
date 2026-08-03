// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import type { SettingsRecord } from "@samurai-agent/core-schemas";
import { defineCommand, type DomainResult, type TrustedDomainContext } from "../../definition/index.js";
import { settingsValueSchema } from "../../value-objects/system-records.js";

const Input = z.object({
  "default_agent_id": z.string().trim().min(1).optional(),
  "default_room_id": z.string().trim().min(1).optional(),
  "external_provider_role": z.enum(["assistive", "disabled"]) .optional(),
  "knowledge_wiki_capture_mode": z.enum(["auto", "manual", "off"]) .optional(),
  "learning_enabled": z.boolean().optional(),
  "learning_budget_ratio": z.number().min(0).max(1).optional(),
  "learning_budget_window_days": z.number().int().positive().max(90).optional(),
  "memory_capture_mode": z.enum(["auto", "manual", "off"]) .optional(),
  "output_locale": z.enum(["en", "ja", "zh", "ko", "es", "pt-BR", "fr", "de"]) .optional(),
  "skill_capture_mode": z.enum(["auto", "manual", "off"]) .optional(),
  "ui_locale": z.enum(["en", "ja", "zh", "ko", "es", "pt-BR", "fr", "de"]) .optional()
}).strict();
const Output = settingsValueSchema;

export interface SettingsPatchRequest {
  defaultAgentId?: z.infer<typeof Input>["default_agent_id"];
  defaultRoomId?: z.infer<typeof Input>["default_room_id"];
  externalProviderRole?: z.infer<typeof Input>["external_provider_role"];
  knowledgeWikiCaptureMode?: z.infer<typeof Input>["knowledge_wiki_capture_mode"];
  learningEnabled?: z.infer<typeof Input>["learning_enabled"];
  learningBudgetRatio?: z.infer<typeof Input>["learning_budget_ratio"];
  learningBudgetWindowDays?: z.infer<typeof Input>["learning_budget_window_days"];
  memoryCaptureMode?: z.infer<typeof Input>["memory_capture_mode"];
  outputLocale?: z.infer<typeof Input>["output_locale"];
  skillCaptureMode?: z.infer<typeof Input>["skill_capture_mode"];
  uiLocale?: z.infer<typeof Input>["ui_locale"];
}

export interface SettingsPatchPorts {
  applySettingsPatch(input: SettingsPatchRequest): Promise<SettingsRecord>;
}

const settingsPatch = defineCommand<SettingsPatchPorts>()({
  ...{
  "kind": "command",
  "id": "settings.patch",
  "version": "2.1",
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
      execute: async function handleSettingsPatch(_context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        const value = await ports.applySettingsPatch({
          ...(input.default_agent_id === undefined ? {} : { defaultAgentId: input.default_agent_id }),
          ...(input.default_room_id === undefined ? {} : { defaultRoomId: input.default_room_id }),
          ...(input.external_provider_role === undefined ? {} : { externalProviderRole: input.external_provider_role }),
          ...(input.knowledge_wiki_capture_mode === undefined ? {} : { knowledgeWikiCaptureMode: input.knowledge_wiki_capture_mode }),
          ...(input.learning_enabled === undefined ? {} : { learningEnabled: input.learning_enabled }),
          ...(input.learning_budget_ratio === undefined ? {} : { learningBudgetRatio: input.learning_budget_ratio }),
          ...(input.learning_budget_window_days === undefined ? {} : { learningBudgetWindowDays: input.learning_budget_window_days }),
          ...(input.memory_capture_mode === undefined ? {} : { memoryCaptureMode: input.memory_capture_mode }),
          ...(input.output_locale === undefined ? {} : { outputLocale: input.output_locale }),
          ...(input.skill_capture_mode === undefined ? {} : { skillCaptureMode: input.skill_capture_mode }),
          ...(input.ui_locale === undefined ? {} : { uiLocale: input.ui_locale })
        });
        return { ok: true, value: Output.parse(value) };
      }
    };
  }
});

export default settingsPatch;
