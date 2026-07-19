// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import type { GeneratedSurfaceDefinition, GeneratedSurfaceActionDeclaration } from "@samurai-agent/core-schemas";
import { defineCommand, type DomainResult, type TrustedDomainContext } from "../../../definition/index.js";
import { generatedSurfaceActionValueSchema } from "../../../value-objects/generated-surface.js";

const Input = z.object({
  "action_id": z.string().trim().min(1).max(256),
  "revision_id": z.string().trim().min(1).max(256).optional(),
  "surface_id": z.string().trim().min(1).max(256)
}).strict();
const Output = generatedSurfaceActionValueSchema;

export type GeneratedSurfaceActionRunInput = z.infer<typeof Input>;

export interface GeneratedSurfaceActionRunPorts {
  resolveGeneratedSurfaceAction(input: { surfaceId: string; revisionId?: string; actionId: string }): Promise<{
    surface: GeneratedSurfaceDefinition;
    revisionId: string;
    action: GeneratedSurfaceActionDeclaration;
  }>;
}

const generatedSurfaceActionRun = defineCommand<GeneratedSurfaceActionRunPorts>()({
  ...{
  "kind": "command",
  "id": "generated_surface.action.run",
  "version": "4.1",
  "availability": "active",
  "title": "Validate generated surface action",
  "description": "Validate a declared Generated Surface action; the ingress adapter dispatches its target command.",
  "sources": [
    "runtime_api",
    "generated_surface"
  ],
  "effect": "read_only",
  "idempotency": "none",
  "concurrency": "none",
  "render": [
    "status_timeline"
  ],
  "resourceKinds": [
    "generated_surface",
    "operation"
  ],
  "proposedEffects": [
    "Resolve and authorize the target Domain Command for a declared Generated Surface action."
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
      execute: async function handleGeneratedSurfaceActionRun(_context: TrustedDomainContext, input: GeneratedSurfaceActionRunInput): Promise<DomainResult<z.infer<typeof Output>>> {
        const resolved = await ports.resolveGeneratedSurfaceAction({
          surfaceId: input.surface_id,
          revisionId: input.revision_id,
          actionId: input.action_id
        });
        const commandResult = {
          command_id: resolved.action.command_id,
          payload_template: resolved.action.payload_template
        };
        return { ok: true, value: Output.parse({ surface: resolved.surface, action: resolved.action, command: { result: commandResult } }) };
      }
    };
  }
});

export default generatedSurfaceActionRun;
