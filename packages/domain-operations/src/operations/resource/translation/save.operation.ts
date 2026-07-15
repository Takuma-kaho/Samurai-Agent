// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { domainJsonValueSchema, defineCommand, type DomainResult, type TrustedDomainContext } from "../../../definition/index.js";
import { resourceTranslationValueSchema } from "../../../value-objects/translation.js";

const Input = z.object({
  "id": z.string(),
  "source_ref": z.record(domainJsonValueSchema),
  "source_locale": z.enum(["en", "ja", "zh", "ko", "es", "pt-BR", "fr", "de"]),
  "target_locale": z.enum(["en", "ja", "zh", "ko", "es", "pt-BR", "fr", "de"]),
  "status": z.enum(["verified", "draft", "missing"]),
  "original_hash": z.string(),
  "translated_text": z.string(),
  "provenance": z.record(domainJsonValueSchema) .optional(),
  "created_at": z.string(),
  "updated_at": z.string()
}).strict();
const Output = resourceTranslationValueSchema;

export interface ResourceTranslationSavePorts {
  executeResourceTranslationSave(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> | DomainResult<z.infer<typeof Output>>;
}

const resourceTranslationSave = defineCommand<ResourceTranslationSavePorts>()({
  ...{
  "kind": "command",
  "id": "resource.translation.save",
  "version": "1.0",
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
      execute: async function handleResourceTranslationSave(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        return ports.executeResourceTranslationSave(context, input);
      }
    };
  }
});

export default resourceTranslationSave;
