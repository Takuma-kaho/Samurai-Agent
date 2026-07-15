// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { domainJsonValueSchema, defineCommand, type DomainResult, type TrustedDomainContext } from "../../../definition/index.js";
import { reflectionSuggestionApplyValueSchema } from "../../../value-objects/reflection.js";

const Input = z.object({
  "envelope_id": z.string() .optional(),
  "id": z.string() .optional(),
  "input_locale": z.string() .optional(),
  "input_message_id": z.string() .optional(),
  "metadata": z.record(domainJsonValueSchema) .optional(),
  "output_locale": z.string() .optional(),
  "provider_tool_call": z.boolean() .optional(),
  "session_id": z.string() .optional(),
  "source_operation_id": z.string() .optional(),
  "suggestion_id": z.string() .optional(),
  "surface_operation_id": z.string() .optional()
}).strict();
const Output = reflectionSuggestionApplyValueSchema;

export interface ReflectionSuggestionApplyPorts {
  executeReflectionSuggestionApply(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> | DomainResult<z.infer<typeof Output>>;
}

const reflectionSuggestionApply = defineCommand<ReflectionSuggestionApplyPorts>()({
  ...{
  "kind": "command",
  "id": "reflection.suggestion.apply",
  "version": "2.0",
  "availability": "active",
  "title": "Apply reflection suggestion",
  "description": "Apply a visible reflection suggestion to Memory, Knowledge Wiki, or Skill.",
  "sources": [
    "provider_tool_call",
    "runtime_api"
  ],
  "effect": "workspace_mutation",
  "idempotency": "required",
  "concurrency": "none",
  "render": [
    "memory",
    "knowledge_wiki",
    "skill"
  ],
  "resourceKinds": [
    "reflection_suggestion",
    "memory",
    "wiki",
    "skill"
  ],
  "proposedEffects": [
    "Apply a visible reflection suggestion to a reusable workspace resource."
  ],
  "outputResourceKind": "reflection_suggestion",
  "uiDisplayCategory": "memory",
  "providerToolNames": [
    "reflection.suggestion.apply"
  ],
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
      execute: async function handleReflectionSuggestionApply(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        return ports.executeReflectionSuggestionApply(context, input);
      }
    };
  }
});

export default reflectionSuggestionApply;
