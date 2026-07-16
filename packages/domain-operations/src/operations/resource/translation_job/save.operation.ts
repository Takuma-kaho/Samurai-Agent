// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { ResourceRefSchema, SupportedLocaleSchema, type JsonValue, type ResourceRef } from "@samurai-agent/core-schemas";
import { domainJsonValueSchema, defineCommand, type DomainResult, type TrustedDomainContext } from "../../../definition/index.js";
import { resourceTranslationJobValueSchema } from "../../../value-objects/translation.js";

const Input = z.object({
  "enabled": z.boolean().optional(),
  "max_attempts": z.number().int().positive().optional(),
  "next_run_at": z.string().datetime().optional(),
  "schedule": z.string().optional(),
  "source_locale": SupportedLocaleSchema.optional(),
  "source_ref": ResourceRefSchema,
  "target_locale": SupportedLocaleSchema,
  "title": z.string().optional()
}).strict();
const Output = resourceTranslationJobValueSchema;

export interface ResourceTranslationJobSavePorts {
  loadArtifactTranslationSource(id: string): Promise<{ ref: ResourceRef; source_locale?: z.infer<typeof SupportedLocaleSchema>; content: string } | undefined>;
  loadMemoryTranslationSource(id: string): Promise<{ ref: ResourceRef; source_locale?: z.infer<typeof SupportedLocaleSchema>; content: string } | undefined>;
  loadWikiTranslationSource(id: string): Promise<{ ref: ResourceRef; source_locale?: z.infer<typeof SupportedLocaleSchema>; content: string } | undefined>;
  loadSkillTranslationSource(id: string): Promise<{ ref: ResourceRef; source_locale?: z.infer<typeof SupportedLocaleSchema>; content: string } | undefined>;
  loadCollectionRecordTranslationSource(ref: ResourceRef): Promise<{ ref: ResourceRef; source_locale?: z.infer<typeof SupportedLocaleSchema>; content: string } | undefined>;
  stripTranslationSkillFrontmatter(content: string): string;
  hashTranslationContent(content: string): string;
  saveTranslationAutomationJob(input: { title: string; kind: "resource_translation"; schedule: string; target_instruction: string; delivery_target: Record<string, JsonValue>; enabled?: boolean; next_run_at?: string; max_attempts?: number }): Promise<z.infer<typeof Output>>;
  translationSourceNotFoundError(ref: ResourceRef): Error;
}

const resourceTranslationJobSave = defineCommand<ResourceTranslationJobSavePorts>()({
  ...{
  "kind": "command",
  "id": "resource.translation_job.save",
  "version": "2.0",
  "availability": "active",
  "title": "Save resource translation job",
  "description": "Save a scheduled resource translation job.",
  "sources": [
    "runtime_api",
    "automation"
  ],
  "effect": "workspace_mutation",
  "idempotency": "required",
  "concurrency": "append_or_unique",
  "render": [
    "status_timeline"
  ],
  "resourceKinds": [
    "automation_job",
    "resource_translation"
  ],
  "proposedEffects": [
    "Save a scheduled resource translation job."
  ],
  "outputResourceKind": "automation_job",
  "uiDisplayCategory": "automation",
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
      execute: async function handleResourceTranslationJobSave(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        const loaded = input.source_ref.kind === "artifact" ? await ports.loadArtifactTranslationSource(input.source_ref.id)
          : input.source_ref.kind === "memory" ? await ports.loadMemoryTranslationSource(input.source_ref.id)
          : input.source_ref.kind === "wiki" ? await ports.loadWikiTranslationSource(input.source_ref.id)
          : input.source_ref.kind === "skill" ? await ports.loadSkillTranslationSource(input.source_ref.id)
          : input.source_ref.kind === "collection_record" ? await ports.loadCollectionRecordTranslationSource(input.source_ref)
          : undefined;
        if (!loaded) throw ports.translationSourceNotFoundError(input.source_ref);
        const content = input.source_ref.kind === "skill" ? ports.stripTranslationSkillFrontmatter(loaded.content) : loaded.content;
        const source = {
          ref: loaded.ref,
          source_locale: input.source_ref.kind === "collection_record"
            ? input.source_locale ?? loaded.source_locale ?? "ja"
            : loaded.source_locale ?? input.source_locale ?? "ja",
          original_hash: ports.hashTranslationContent(content)
        };
        const schedule = input.schedule?.trim() || "once";
        const value = await ports.saveTranslationAutomationJob({
          title: input.title?.trim() || `Translate ${source.ref.kind}/${source.ref.id} to ${input.target_locale}`,
          kind: "resource_translation",
          schedule,
          target_instruction: `Translate ${source.ref.kind}/${source.ref.id} from ${source.source_locale} to ${input.target_locale}.`,
          delivery_target: {
            channel: "resource_translation",
            source_ref: domainJsonValueSchema.parse(source.ref),
            source_locale: source.source_locale,
            target_locale: input.target_locale,
            original_hash: source.original_hash,
            source_label: source.ref.label ?? source.ref.id
          },
          enabled: input.enabled,
          next_run_at: input.next_run_at,
          max_attempts: input.max_attempts
        });
        return { ok: true, value };
      }
    };
  }
});

export default resourceTranslationJobSave;
