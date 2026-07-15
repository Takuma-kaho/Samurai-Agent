// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { domainJsonValueSchema, defineQuery, type DomainQueryPorts, type DomainResult, type TrustedDomainContext } from "../../definition/index.js";

const Input = z.object({
  "envelope_id": z.string() .optional(),
  "input_locale": z.string() .optional(),
  "input_message_id": z.string() .optional(),
  "metadata": z.record(domainJsonValueSchema) .optional(),
  "output_locale": z.string() .optional(),
  "provider_tool_call": z.boolean() .optional(),
  "requested_kind": z.string() .optional(),
  "session_id": z.string() .optional(),
  "source_operation_id": z.string() .optional(),
  "surface_operation_id": z.string() .optional()
}).strict();
const Output = z.object({
  requested_kind: z.string().min(1),
  selected_kind: z.enum(["generated_surface", "built_in_surface"]),
  reason: z.string().min(1),
  fallback_chain: z.tuple([z.literal("built_in_surface"), z.literal("artifact"), z.literal("text")])
}).strict();

export interface PresentationPlanPorts extends DomainQueryPorts {
  executePresentationPlan(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> | DomainResult<z.infer<typeof Output>>;
}

const presentationPlan = defineQuery<PresentationPlanPorts>()({
  ...{
  "kind": "query",
  "id": "presentation.plan",
  "version": "1.0",
  "availability": "active",
  "title": "Plan presentation",
  "description": "Choose the best built-in or Generated Surface presentation for a result.",
  "sources": [
    "runtime_api",
    "surface_operation",
    "generated_surface"
  ],
  "effect": "read_only",
  "idempotency": "none",
  "concurrency": "none",
  "render": [
    "chat",
    "custom_view"
  ],
  "resourceKinds": [
    "presentation_plan"
  ],
  "proposedEffects": [
    "Read presentation_plan without changing Workspace state."
  ],
  "outputResourceKind": "presentation_plan",
  "uiDisplayCategory": "generated_surface",
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
      execute: async function handlePresentationPlan(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        return ports.executePresentationPlan(context, input);
      }
    };
  }
});

export default presentationPlan;
