// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { SurfaceInteractionRecordSchema, nowIso, type GeneratedSurfaceDefinition, type JsonValue, type SurfaceInteractionRecord } from "@samurai-agent/core-schemas";
import { domainJsonValueSchema, defineCommand, type DomainResult, type TrustedDomainContext } from "../../../definition/index.js";
import { generatedSurfaceActionValueSchema } from "../../../value-objects/generated-surface.js";

const Input = z.object({
  "action_id": z.string(),
  "action_payload": z.record(domainJsonValueSchema) .optional(),
  "envelope_id": z.string() .optional(),
  "input_locale": z.string() .optional(),
  "input_message_id": z.string() .optional(),
  "interaction_id": z.string().trim().min(1),
  "message_id": z.string().trim().min(1).optional(),
  "metadata": z.record(domainJsonValueSchema) .optional(),
  "output_locale": z.string() .optional(),
  "provider_tool_call": z.boolean() .optional(),
  "revision_id": z.string() .optional(),
  "session_id": z.string() .optional(),
  "source_operation_id": z.string() .optional(),
  "surface_id": z.string(),
  "surface_operation_id": z.string() .optional()
}).strict();
const Output = generatedSurfaceActionValueSchema;

export interface GeneratedSurfaceActionRunPorts {
  getGeneratedSurface(id: string): Promise<GeneratedSurfaceDefinition | undefined>;
  dispatchGeneratedSurfaceCommand(input: { command_id: string; input_source: "generated_surface"; idempotency_key: string; payload: Record<string, JsonValue> }): Promise<{ result: unknown }>;
  saveGeneratedSurfaceInteraction(record: SurfaceInteractionRecord): Promise<SurfaceInteractionRecord>;
  generatedSurfaceActionError(code: "conflict" | "forbidden" | "not_found", message: string): Error;
}

const generatedSurfaceActionRun = defineCommand<GeneratedSurfaceActionRunPorts>()({
  ...{
  "kind": "command",
  "id": "generated_surface.action.run",
  "version": "2.0",
  "availability": "active",
  "title": "Run generated surface action",
  "description": "Execute a declared Generated Surface action through its Domain Command.",
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
    "operation"
  ],
  "proposedEffects": [
    "Execute a declared Generated Surface action through the Domain Command Bus."
  ],
  "outputResourceKind": "domain_command_result",
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
      execute: async function handleGeneratedSurfaceActionRun(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        const surface = await ports.getGeneratedSurface(input.surface_id);
        if (!surface) throw ports.generatedSurfaceActionError("not_found", "generated_surface_not_found");
        const revisionId = input.revision_id ?? surface.current_revision_id;
        if (revisionId !== surface.current_revision_id) throw ports.generatedSurfaceActionError("conflict", "generated_surface_revision_stale");
        const action = surface.actions.find((item) => item.id === input.action_id);
        if (!action || !surface.capability_manifest.allowed_domain_commands.includes(action.command_id)) {
          throw ports.generatedSurfaceActionError("forbidden", "generated_surface_action_not_declared");
        }
        const command = await ports.dispatchGeneratedSurfaceCommand({
          command_id: action.command_id, input_source: "generated_surface",
          idempotency_key: `${surface.id}:${revisionId}:${input.interaction_id}:${action.id}`,
          payload: { ...action.payload_template, ...(input.action_payload ?? {}) }
        });
        const commandResult = domainJsonValueSchema.parse(command.result);
        await ports.saveGeneratedSurfaceInteraction(SurfaceInteractionRecordSchema.parse({
          id: input.interaction_id, kind: "action", session_id: surface.session_id,
          message_id: input.message_id, surface_id: surface.id, revision_id: revisionId,
          command_id: action.command_id, command_result: commandResult, created_at: nowIso()
        }));
        return { ok: true, value: Output.parse({ surface, action, command: { result: commandResult } }) };
      }
    };
  }
});

export default generatedSurfaceActionRun;
