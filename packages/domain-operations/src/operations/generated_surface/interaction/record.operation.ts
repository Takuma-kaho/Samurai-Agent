// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { SurfaceInteractionRecordSchema, createId, nowIso, type GeneratedSurfaceDefinition, type SurfaceInteractionRecord } from "@samurai-agent/core-schemas";
import { defineCommand, domainJsonValueSchema, type DomainResult, type TrustedDomainContext } from "../../../definition/index.js";
import { generatedSurfaceInteractionValueSchema } from "../../../value-objects/generated-surface.js";

const Input = z.object({
  "command_id": z.string().trim().min(1).max(256).optional(),
  "command_result": domainJsonValueSchema.optional(),
  "interaction_id": z.string().trim().min(1).max(256).optional(),
  "kind": SurfaceInteractionRecordSchema.shape.kind,
  "message_id": z.string().trim().min(1).max(256).optional(),
  "revision_id": z.string().trim().min(1).max(256).optional(),
  "surface_id": z.string().trim().min(1).max(256),
  "user_feedback": z.string().max(100_000).optional()
}).strict();
const Output = generatedSurfaceInteractionValueSchema;

export type GeneratedSurfaceInteractionRecordInput = z.infer<typeof Input>;

export interface GeneratedSurfaceInteractionRecordPorts {
  getGeneratedSurface(id: string): Promise<GeneratedSurfaceDefinition | undefined>;
  saveGeneratedSurfaceInteraction(record: SurfaceInteractionRecord): Promise<SurfaceInteractionRecord>;
  generatedSurfaceInteractionError(message: string): Error;
}

const generatedSurfaceInteractionRecord = defineCommand<GeneratedSurfaceInteractionRecordPorts>()({
  ...{
  "kind": "command",
  "id": "generated_surface.interaction.record",
  "version": "4.0",
  "availability": "active",
  "title": "Record surface interaction",
  "description": "Record a Generated Surface open, dismiss, correction, or regeneration signal.",
  "sources": [
    "runtime_api",
    "surface_operation",
    "generated_surface"
  ],
  "effect": "workspace_mutation",
  "idempotency": "required",
  "concurrency": "none",
  "render": [
    "status_timeline"
  ],
  "resourceKinds": [
    "generated_surface",
    "surface_interaction"
  ],
  "proposedEffects": [
    "Record a Generated Surface interaction for audit and learning."
  ],
  "outputResourceKind": "surface_interaction",
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
      execute: async function handleGeneratedSurfaceInteractionRecord(_context: TrustedDomainContext, input: GeneratedSurfaceInteractionRecordInput): Promise<DomainResult<z.infer<typeof Output>>> {
        const surface = await ports.getGeneratedSurface(input.surface_id);
        if (!surface) throw ports.generatedSurfaceInteractionError("generated_surface_not_found");
        const record = SurfaceInteractionRecordSchema.parse({
          id: input.interaction_id ?? createId("surface_interaction"), kind: input.kind,
          session_id: surface.session_id, message_id: input.message_id,
          surface_id: surface.id, revision_id: input.revision_id ?? surface.current_revision_id,
          command_id: input.command_id, command_result: input.command_result,
          user_feedback: input.user_feedback, created_at: nowIso()
        });
        return { ok: true, value: Output.parse(await ports.saveGeneratedSurfaceInteraction(record)) };
      }
    };
  }
});

export default generatedSurfaceInteractionRecord;
