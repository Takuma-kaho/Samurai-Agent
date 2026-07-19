import { CaptureModeSchema, ExternalProviderRoleSchema, SupportedLocaleSchema } from "@samurai-agent/core-schemas";
import { z } from "zod";

export const sessionValueSchema = z.object({
  id: z.string().min(1), session_key: z.string().min(1), title: z.string(),
  ui_locale: SupportedLocaleSchema, output_locale: SupportedLocaleSchema,
  created_at: z.string().datetime(), updated_at: z.string().datetime()
}).strict();

export const settingsValueSchema = z.object({
  ui_locale: SupportedLocaleSchema, output_locale: SupportedLocaleSchema,
  memory_capture_mode: CaptureModeSchema, knowledge_wiki_capture_mode: CaptureModeSchema,
  skill_capture_mode: CaptureModeSchema, external_provider_role: ExternalProviderRoleSchema,
  default_backend_id: z.string().min(1).optional(), updated_at: z.string().datetime()
}).strict();

export const pluginStatusValueSchema = z.object({
  plugin: z.object({ manifest_id: z.string().min(1), version: z.string().min(1) }).strict(),
  state: z.object({ manifest_id: z.string().min(1), enabled: z.boolean(), version: z.string().min(1), updated_at: z.string().datetime() }).strict()
}).strict();

export const sessionSearchReindexValueSchema = z.object({
  mode: z.enum(["fts5_trigram", "fts5", "like"]),
  indexed: z.number().int().nonnegative()
}).strict();
