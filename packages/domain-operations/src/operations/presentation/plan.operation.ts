// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { defineQuery, type DomainQueryPorts, type DomainResult, type TrustedDomainContext } from "../../definition/index.js";

const Input = z.object({
  "requested_kind": z.enum(["generated_surface", "built_in_surface"]).default("built_in_surface")
}).strict();
const Output = z.object({
  requested_kind: z.string().min(1),
  selected_kind: z.enum(["generated_surface", "built_in_surface"]),
  reason: z.string().min(1),
  fallback_chain: z.tuple([z.literal("built_in_surface"), z.literal("artifact"), z.literal("text")])
}).strict();

export interface PresentationPlanPorts extends DomainQueryPorts {}

const presentationPlan = defineQuery<PresentationPlanPorts>()({
  ...{
  "kind": "query",
  "id": "presentation.plan",
  "version": "2.0",
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
  createHandler() {
    return {
      execute: async function handlePresentationPlan(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        const generated = input.requested_kind === "generated_surface";
        return {
          ok: true,
          value: {
            requested_kind: input.requested_kind,
            selected_kind: generated ? "generated_surface" : "built_in_surface",
            reason: generated
              ? "User explicitly requested an independent UI."
              : "A built-in Workspace renderer is preferred when it can represent the result.",
            fallback_chain: ["built_in_surface", "artifact", "text"]
          }
        };
      }
    };
  }
});

export default presentationPlan;
