// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { domainJsonValueSchema, defineCommand, type DomainResult, type TrustedDomainContext } from "../../../definition/index.js";
import { resourceTranslationJobValueSchema } from "../../../value-objects/translation.js";

const Input = z.object({
  "enabled": z.boolean() .optional(),
  "envelope_id": z.string() .optional(),
  "input_locale": z.string() .optional(),
  "input_message_id": z.string() .optional(),
  "max_attempts": z.number() .optional(),
  "metadata": z.record(domainJsonValueSchema) .optional(),
  "next_run_at": z.string() .optional(),
  "output_locale": z.string() .optional(),
  "provider_tool_call": z.boolean() .optional(),
  "schedule": z.string() .optional(),
  "session_id": z.string() .optional(),
  "source_locale": z.string() .optional(),
  "source_operation_id": z.string() .optional(),
  "source_ref": z.record(domainJsonValueSchema) .optional(),
  "surface_operation_id": z.string() .optional(),
  "target_locale": z.string() .optional(),
  "title": z.string() .optional()
}).strict();
const Output = resourceTranslationJobValueSchema;

export interface ResourceTranslationJobSavePorts {
  executeResourceTranslationJobSave(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> | DomainResult<z.infer<typeof Output>>;
}

const resourceTranslationJobSave = defineCommand<ResourceTranslationJobSavePorts>()({
  ...{
  "kind": "command",
  "id": "resource.translation_job.save",
  "version": "1.0",
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
        return ports.executeResourceTranslationJobSave(context, input);
      }
    };
  }
});

export default resourceTranslationJobSave;
