import {
  SupportedLocaleSchema,
  stableHash,
  type JsonValue,
  type ResourceTranslationRecord,
  type ResourceRef,
  type SupportedLocale
} from "@samurai-agent/core-schemas";
import type { AutomationJobWriteResult } from "./automation-domain-service.js";
import { jsonValue } from "./json-value.js";

export interface TranslationWritePort {
  saveTranslation(record: ResourceTranslationRecord): Promise<ResourceTranslationRecord>;
  saveAutomationJob(input: {
    title: string; kind: "resource_translation"; schedule: string; target_instruction: string;
    delivery_target: Record<string, JsonValue>; enabled?: boolean; next_run_at?: string; max_attempts?: number;
  }): Promise<AutomationJobWriteResult>;
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

}

function stripFrontmatter(markdown: string): string {
  const match = markdown.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return match ? markdown.slice(match[0].length) : markdown;
}
