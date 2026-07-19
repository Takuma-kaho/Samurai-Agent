// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import {
  ProvenanceSchema,
  ResourceRefSchema,
  SupportedLocaleSchema,
  TranslationStatusSchema,
  type Provenance,
  type ResourceRef,
  type SupportedLocale,
  type TranslationStatus
} from "@samurai-agent/core-schemas";
import { defineCommand, type DomainResult, type TrustedDomainContext } from "../../../definition/index.js";
import { resourceTranslationValueSchema } from "../../../value-objects/translation.js";

const Input = z.object({
  id: z.string().trim().min(1).max(256),
  source_ref: ResourceRefSchema,
  source_locale: SupportedLocaleSchema,
  target_locale: SupportedLocaleSchema,
  status: TranslationStatusSchema,
  original_hash: z.string().trim().min(1).max(128),
  translated_text: z.string().max(1_000_000),
  provenance: ProvenanceSchema.optional(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime()
}).strict();
const Output = resourceTranslationValueSchema;

export type ResourceTranslationSaveInput = z.infer<typeof Input>;

export interface ResourceTranslationSaveRequest {
  id: string;
  sourceRef: ResourceRef;
  sourceLocale: SupportedLocale;
  targetLocale: SupportedLocale;
  status: TranslationStatus;
  originalHash: string;
  translatedText: string;
  provenance?: Provenance;
  createdAt: string;
  updatedAt: string;
}

export interface ResourceTranslationSavePorts {
  saveResourceTranslation(request: ResourceTranslationSaveRequest): Promise<z.infer<typeof Output>>;
}

const resourceTranslationSave = defineCommand<ResourceTranslationSavePorts>()({
  ...{
  "kind": "command",
  "id": "resource.translation.save",
  "version": "2.0",
  "availability": "active",
  "title": "Save resource translation",
  "description": "Save a derived translation with source provenance.",
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
    "resource_translation"
  ],
  "proposedEffects": [
    "Save a derived resource translation."
  ],
  "outputResourceKind": "resource_translation",
  "uiDisplayCategory": "artifact",
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
      execute: async function handleResourceTranslationSave(_context: TrustedDomainContext, input: ResourceTranslationSaveInput): Promise<DomainResult<z.infer<typeof Output>>> {
        const request: ResourceTranslationSaveRequest = {
          id: input.id,
          sourceRef: input.source_ref,
          sourceLocale: input.source_locale,
          targetLocale: input.target_locale,
          status: input.status,
          originalHash: input.original_hash,
          translatedText: input.translated_text,
          provenance: input.provenance,
          createdAt: input.created_at,
          updatedAt: input.updated_at
        };
        const value = await ports.saveResourceTranslation(request);
        return { ok: true, value };
      }
    };
  }
});

export default resourceTranslationSave;
