import {
  SupportedLocaleSchema,
  createId,
  nowIso,
  stableHash,
  type AutomationJobRecord,
  type JsonValue,
  type ResourceTranslationRecord,
  type ResourceRef,
  type SupportedLocale,
  type WorkspaceChangeRecord
} from "@samurai-agent/core-schemas";
import type { AutomationJobWriteResult, ScheduledAutomationContext } from "./automation-domain-service.js";
import { jsonValue } from "./json-value.js";

export interface TranslationWritePort {
  saveTranslation(record: ResourceTranslationRecord): Promise<ResourceTranslationRecord>;
  saveAutomationJob(input: {
    title: string; kind: "resource_translation"; schedule: string; target_instruction: string;
    delivery_target: Record<string, JsonValue>; enabled?: boolean; next_run_at?: string; max_attempts?: number;
  }): Promise<AutomationJobWriteResult>;
}

interface TranslationChatResult {
  backendRun: { id: string; backend_id: string };
  messages: Array<{ role: string; content: string }>;
}

export interface TranslationExecutionPort {
  runChat(input: { sessionId: string; content: string; inputLocale: SupportedLocale; outputLocale: SupportedLocale; metadata: Record<string, JsonValue>; context: ScheduledAutomationContext }): Promise<TranslationChatResult>;
  saveWorkspaceChange(change: WorkspaceChangeRecord): Promise<WorkspaceChangeRecord>;
  emitWorkspaceChange(change: WorkspaceChangeRecord): Promise<void>;
}

interface TranslationSource {
  ref: ResourceRef;
  source_locale?: SupportedLocale;
  content: string;
}

export interface TranslationSourcePort {
  loadArtifact(id: string): Promise<TranslationSource | undefined>;
  loadMemory(id: string): Promise<TranslationSource | undefined>;
  loadWiki(id: string): Promise<TranslationSource | undefined>;
  loadSkill(id: string): Promise<TranslationSource | undefined>;
  loadCollectionRecord(ref: ResourceRef): Promise<TranslationSource | undefined>;
}

export interface TranslationDomainServiceDependencies {
  translations: TranslationWritePort;
  sources: TranslationSourcePort;
  execution: TranslationExecutionPort;
  requestError: (code: "conflict" | "not_found", message: string) => Error;
}

export class TranslationDomainService {
  constructor(private readonly dependencies: TranslationDomainServiceDependencies) {}

  saveTranslation(record: ResourceTranslationRecord) {
    return this.dependencies.translations.saveTranslation(record);
  }

  saveAutomationJob(input: Parameters<TranslationWritePort["saveAutomationJob"]>[0]) {
    return this.dependencies.translations.saveAutomationJob(input);
  }

  translationSourceNotFoundError(ref: ResourceRef) {
    return this.dependencies.requestError("not_found", `Translatable resource not found: ${ref.kind}/${ref.id}`);
  }

  loadArtifactSource(id: string) { return this.dependencies.sources.loadArtifact(id); }
  loadMemorySource(id: string) { return this.dependencies.sources.loadMemory(id); }
  loadWikiSource(id: string) { return this.dependencies.sources.loadWiki(id); }
  loadSkillSource(id: string) { return this.dependencies.sources.loadSkill(id); }
  loadCollectionRecordSource(ref: ResourceRef) { return this.dependencies.sources.loadCollectionRecord(ref); }
  stripSkillFrontmatter(content: string) { return stripFrontmatter(content); }
  hashContent(content: string) { return stableHash(content); }

  async loadSource(ref: ResourceRef, fallbackLocale?: SupportedLocale): Promise<{
    ref: ResourceRef; source_locale: SupportedLocale; content: string; original_hash: string;
  } | undefined> {
    const source = ref.kind === "artifact" ? await this.dependencies.sources.loadArtifact(ref.id)
      : ref.kind === "memory" ? await this.dependencies.sources.loadMemory(ref.id)
      : ref.kind === "wiki" ? await this.dependencies.sources.loadWiki(ref.id)
      : ref.kind === "skill" ? await this.dependencies.sources.loadSkill(ref.id)
      : ref.kind === "collection_record" ? await this.dependencies.sources.loadCollectionRecord(ref)
      : undefined;
    if (!source) return undefined;
    const content = ref.kind === "skill" ? stripFrontmatter(source.content) : source.content;
    return {
      ref: source.ref,
      source_locale: ref.kind === "collection_record"
        ? fallbackLocale ?? source.source_locale ?? "ja"
        : source.source_locale ?? fallbackLocale ?? "ja",
      content,
      original_hash: stableHash(content)
    };
  }

  async executeJob(job: AutomationJobRecord, session: { id: string }, context: ScheduledAutomationContext): Promise<{
    translation: ResourceTranslationRecord; backendRunId: string; source_ref: ResourceRef;
    source_locale: SupportedLocale; target_locale: SupportedLocale; original_hash: string;
  }> {
    const target = translationTarget(job.delivery_target);
    if (!target) throw this.dependencies.requestError("conflict", "invalid_resource_translation_job");
    const source = await this.loadSource(target.source_ref, target.source_locale);
    if (!source) throw this.dependencies.requestError("not_found", `Translatable resource not found: ${target.source_ref.kind}/${target.source_ref.id}`);
    if (target.original_hash && target.original_hash !== source.original_hash) throw this.dependencies.requestError("conflict", "resource_translation_source_stale");
    const chat = await this.dependencies.execution.runChat({
      sessionId: session.id, inputLocale: source.source_locale, outputLocale: target.target_locale, context,
      content: [`Translate the following ${source.ref.kind} from ${source.source_locale} to ${target.target_locale}.`,
        "Return only the translated text. Keep names, code identifiers, paths, IDs, and structured keys unchanged.", "", source.content].join("\n"),
      metadata: { automation_job_id: job.id, automation_job_kind: job.kind, automation_job_title: job.title,
        automation_schedule: job.schedule, automation_delivery_target: job.delivery_target,
        resource_translation_source_ref: jsonValue(source.ref),
        resource_translation_original_hash: source.original_hash, resource_translation_target_locale: target.target_locale }
    });
    const translatedText = chat.messages.find((message) => message.role === "agent")?.content.trim() ?? "";
    const now = nowIso();
    const translation = await this.dependencies.translations.saveTranslation({
      id: createId("translation"), source_ref: source.ref, source_locale: source.source_locale, target_locale: target.target_locale,
      status: translatedText ? "draft" : "missing", original_hash: source.original_hash, translated_text: translatedText,
      provenance: { kind: "generated_local", summary: `Generated by resource translation automation job ${job.id}.`, provider: chat.backendRun.backend_id, verified: false },
      created_at: now, updated_at: now
    });
    const change: WorkspaceChangeRecord = { id: createId("change"), run_id: chat.backendRun.id, session_id: session.id,
      resource_ref: translationRef(translation), change_type: "other",
      summary: `Saved ${translation.target_locale} translation for ${source.ref.kind}/${source.ref.id}.`, created_at: nowIso() };
    await this.dependencies.execution.saveWorkspaceChange(change);
    await this.dependencies.execution.emitWorkspaceChange(change);
    return { translation, backendRunId: chat.backendRun.id, source_ref: source.ref, source_locale: source.source_locale,
      target_locale: target.target_locale, original_hash: source.original_hash };
  }
}

function stripFrontmatter(markdown: string): string {
  const match = markdown.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return match ? markdown.slice(match[0].length) : markdown;
}

function translationTarget(value: Record<string, JsonValue>): { source_ref: ResourceRef; source_locale?: SupportedLocale; target_locale: SupportedLocale; original_hash?: string } | undefined {
  const source_ref = resourceRef(value.source_ref); const target_locale = locale(value.target_locale);
  if (!source_ref || !target_locale) return undefined;
  return { source_ref, source_locale: locale(value.source_locale), target_locale, original_hash: optionalString(value.original_hash) || undefined };
}

function translationRef(translation: Pick<ResourceTranslationRecord, "id" | "source_ref" | "target_locale">): ResourceRef {
  return { kind: "resource_translation", id: translation.id, uri: `resource-translations/${translation.id}`,
    label: `${translation.source_ref.kind}/${translation.source_ref.id} -> ${translation.target_locale}` };
}

function optionalString(value: JsonValue | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

function locale(value: JsonValue | undefined): SupportedLocale | undefined {
  const parsed = SupportedLocaleSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function resourceRef(value: JsonValue | undefined): ResourceRef | undefined {
  if (!value || Array.isArray(value) || typeof value !== "object") return undefined;
  if (typeof value.kind !== "string" || typeof value.id !== "string" || typeof value.uri !== "string") return undefined;
  return {
    kind: value.kind,
    id: value.id,
    uri: value.uri,
    ...(typeof value.version === "string" ? { version: value.version } : {}),
    ...(typeof value.label === "string" ? { label: value.label } : {})
  };
}
