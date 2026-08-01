import type { JsonColumn } from "./json-column";

export interface SettingsTable { id: "default"; ui_locale: string; output_locale: string; memory_capture_mode: string; knowledge_wiki_capture_mode: string; llm_wiki_capture_mode?: string; skill_capture_mode: string; external_provider_role: string; default_backend_id: string | null; default_room_id: string | null; default_agent_id: string | null; updated_at: string; }
export interface PluginStatesTable { manifest_id: string; enabled: number; version: string; updated_at: string; }
export interface ResourceTranslationsTable { id: string; source_ref_json: JsonColumn; source_locale: string; target_locale: string; status: string; original_hash: string; translated_text: string; provenance_json: JsonColumn | null; created_at: string; updated_at: string; }
