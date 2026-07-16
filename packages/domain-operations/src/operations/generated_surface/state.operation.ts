// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { SurfaceInteractionRecordSchema, createId, nowIso, type GeneratedSurfaceDefinition, type SurfaceInteractionRecord } from "@samurai-agent/core-schemas";
import { domainJsonValueSchema, defineCommand, type DomainResult, type TrustedDomainContext } from "../../definition/index.js";
import { generatedSurfaceStateValueSchema } from "../../value-objects/generated-surface.js";

const Input = z.object({
  "action": z.enum(["pin", "unpin", "archive"]),
  "envelope_id": z.string() .optional(),
  "input_locale": z.string() .optional(),
  "input_message_id": z.string() .optional(),
  "interaction_id": z.string().trim().min(1).optional(),
  "message_id": z.string().trim().min(1).optional(),
  "metadata": z.record(domainJsonValueSchema) .optional(),
  "output_locale": z.string() .optional(),
  "provider_tool_call": z.boolean() .optional(),
  "session_id": z.string() .optional(),
  "source_operation_id": z.string() .optional(),
  "surface_id": z.string(),
  "surface_operation_id": z.string() .optional()
}).strict();
const Output = generatedSurfaceStateValueSchema;

export interface GeneratedSurfaceStatePorts {
  updateGeneratedSurfaceState(id: string, state: "ephemeral" | "pinned" | "archived"): Promise<GeneratedSurfaceDefinition | undefined>;
  saveGeneratedSurfaceInteraction(record: SurfaceInteractionRecord): Promise<SurfaceInteractionRecord>;
  generatedSurfaceStateError(code: "conflict" | "not_found", message: string): Error;
}

const generatedSurfaceState = defineCommand<GeneratedSurfaceStatePorts>()({
  ...{
  "kind": "command",
  "id": "generated_surface.state",
  "version": "1.0",
  "availability": "active",
  "title": "Change generated surface state",
  "description": "Pin, unpin, or archive a Generated Surface.",
  "sources": [
    "runtime_api",
    "surface_operation",
    "generated_surface"
  ],
  "effect": "workspace_mutation",
  "idempotency": "required",
  "concurrency": "state_transition",
  "render": [
    "status_timeline"
  ],
  "resourceKinds": [
    "generated_surface"
  ],
  "proposedEffects": [
    "Change Generated Surface lifecycle state."
  ],
  "outputResourceKind": "generated_surface",
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
      execute: async function handleGeneratedSurfaceState(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        const state = input.action === "pin" ? "pinned" : input.action === "unpin" ? "ephemeral" : "archived";
        const surface = await ports.updateGeneratedSurfaceState(input.surface_id, state);
        if (!surface) throw ports.generatedSurfaceStateError("not_found", "generated_surface_not_found");
        const kind = input.action === "pin" ? "pinned" : input.action === "unpin" ? "unpinned" : "dismissed";
        await ports.saveGeneratedSurfaceInteraction(SurfaceInteractionRecordSchema.parse({
          id: input.interaction_id ?? createId("surface_interaction"), kind,
          session_id: surface.session_id, message_id: input.message_id,
          surface_id: surface.id, revision_id: surface.current_revision_id, created_at: nowIso()
        }));
        return { ok: true, value: Output.parse(surface) };
      }
    };
  }
});

export default generatedSurfaceState;
