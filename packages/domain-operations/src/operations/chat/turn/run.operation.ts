// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { ResourceRefSchema, SupportedLocaleSchema } from "@samurai-agent/core-schemas";
import { domainJsonValueSchema, defineCommand, type DomainResult, type TrustedDomainContext } from "../../../definition/index.js";
import { chatTurnValueSchema } from "../../../value-objects/chat.js";

const Input = z.object({
  "attachments": z.array(ResourceRefSchema.strict()).default([]),
  "backend_id": z.string().trim().min(1).optional(),
  "content": z.string().trim().min(1),
  "input_locale": SupportedLocaleSchema.optional(),
  "metadata": z.record(domainJsonValueSchema).default({}),
  "output_locale": SupportedLocaleSchema.optional(),
  "temporary_context": z.array(z.object({
    id: z.string().trim().min(1), kind: z.literal("desktop_screenshot"), label: z.string().optional(),
    source_name: z.string().optional(), mime_type: z.string().trim().min(1), data_url: z.string().optional(),
    file_path: z.string().optional(), created_at: z.string().datetime(), expires_at: z.string().datetime(),
    metadata: z.record(domainJsonValueSchema).optional()
  }).strict()).default([])
}).strict();
const Output = chatTurnValueSchema;
type InputValue = z.infer<typeof Input>;
type OutputValue = z.infer<typeof Output>;

export interface ChatTurnRunPorts {
  createChatSession(input: { output_locale?: InputValue["output_locale"] }): Promise<OutputValue["session"]>;
  runChatTurn(input: {
    sessionId: string; content: string; idempotencyKey: string; backend_id?: string; input_locale?: InputValue["input_locale"];
    output_locale?: InputValue["output_locale"]; attachments: InputValue["attachments"];
    temporary_context: InputValue["temporary_context"]; metadata: InputValue["metadata"];
  }): Promise<OutputValue>;
}

const chatTurnRun = defineCommand<ChatTurnRunPorts>()({
  ...{
  "kind": "command",
  "id": "chat.turn.run",
  "version": "5.1",
  "availability": "active",
  "runtimeRequirements": ["agent_backend"],
  "title": "Run chat turn",
  "description": "Route a user message through Host context assembly and the selected Backend cassette.",
  "sources": [
    "surface_operation",
    "runtime_api",
    "gateway_inbound",
    "automation"
  ],
  "effect": "workspace_mutation",
  "idempotency": "external",
  "concurrency": "none",
  "render": [
    "chat"
  ],
  "resourceKinds": [
    "backend_run",
    "message"
  ],
  "proposedEffects": [
    "Route the message through Host context assembly and a BackendRun."
  ],
  "outputResourceKind": "backend_run",
  "uiDisplayCategory": "chat",
  "surfaceOperationKinds": [
    "message.submit"
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
      execute: async function handleChatTurnRun(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        if (!context.idempotencyKey) throw new Error("idempotency_key_required");
        const sessionId = context.sessionId ?? (await ports.createChatSession({ output_locale: input.output_locale })).id;
        const metadata = {
          ...input.metadata,
          ...(context.surfaceOperation
            ? {
                surface_operation_id: context.surfaceOperation.id,
                surface_operation_kind: context.surfaceOperation.kind
              }
            : {})
        };
        return { ok: true, value: await ports.runChatTurn({
          sessionId, content: input.content, idempotencyKey: context.idempotencyKey, backend_id: input.backend_id, input_locale: input.input_locale,
          output_locale: input.output_locale, attachments: input.attachments,
          temporary_context: input.temporary_context, metadata
        }) };
      }
    };
  }
});

export default chatTurnRun;
