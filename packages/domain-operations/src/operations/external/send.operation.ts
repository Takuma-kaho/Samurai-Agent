// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { ExternalSendChannelSchema, type ActivityInboxItem, type ExternalSendRecord, type JsonValue, type MessageEnvelope, type OperationRecord, type ResourceRef, type RollbackPoint, type SessionRecord } from "@samurai-agent/core-schemas";
import { domainJsonValueSchema, defineCommand, type DomainResult, type TrustedDomainContext } from "../../definition/index.js";
import { externalSendWriteValueSchema } from "../../value-objects/external-send.js";

const Input = z.object({
  "body": z.string() .optional(),
  "channel": ExternalSendChannelSchema.default("webhook"),
  "content": z.string() .optional(),
  "target": z.record(domainJsonValueSchema).default({}),
  "title": z.string().trim().min(1).default("External send request"),
  "user_intent": z.string() .optional()
}).strict();
const Output = externalSendWriteValueSchema;

export interface ExternalSendPorts {
  ensureExternalSendSession(): Promise<SessionRecord>; createExternalSendEnvelope(session: SessionRecord, content: string): MessageEnvelope;
  createExternalSendId(): string; externalSendNow(): string; saveExternalSend(record: ExternalSendRecord): Promise<ExternalSendRecord>;
  createExternalSendRollback(operation: OperationRecord, refs: ResourceRef[], before: Record<string, JsonValue>, after: Record<string, JsonValue>): Promise<RollbackPoint>;
  runExternalSendMutation(input: { session: SessionRecord; envelope: MessageEnvelope; operationName: "external.send"; proposedEffects: string[]; execute(operation: OperationRecord): Promise<{ resource: ExternalSendRecord; ref: ResourceRef; rollbackPoint?: RollbackPoint; summary: string }> }): Promise<{ resource: ExternalSendRecord; operation: OperationRecord; rollbackPoint?: RollbackPoint; activity: ActivityInboxItem[] }>;
}

const externalSend = defineCommand<ExternalSendPorts>()({
  ...{
  "kind": "command",
  "id": "external.send",
  "version": "2.0",
  "availability": "active",
  "title": "Prepare outbound send",
  "description": "Plan an outbound send request without dispatching it.",
  "sources": [
    "provider_tool_call",
    "runtime_api"
  ],
  "effect": "workspace_mutation",
  "idempotency": "required",
  "concurrency": "external_idempotency",
  "render": [
    "status_timeline"
  ],
  "resourceKinds": [
    "external_send"
  ],
  "proposedEffects": [
    "Prepare an outbound action. No external effect is executed in v1."
  ],
  "outputResourceKind": "external_send",
  "uiDisplayCategory": "external",
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
      execute: async function handleExternalSend(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        const body = input.body || input.content || input.user_intent || "External send requested by backend.";
        const session = await ports.ensureExternalSendSession();
        const envelope = ports.createExternalSendEnvelope(session, `Prepare external send: ${input.title}`);
        const now = ports.externalSendNow();
        const draft: ExternalSendRecord = { id: ports.createExternalSendId(), channel: input.channel, status: "draft", target: input.target, title: input.title, body, created_at: now, updated_at: now };
        const value = await ports.runExternalSendMutation({ session, envelope, operationName: "external.send", proposedEffects: ["Create an outbound send draft without dispatching."], execute: async (operation) => {
          const saved = await ports.saveExternalSend({ ...draft, operation_id: operation.id });
          const ref: ResourceRef = { kind: "external_send", id: saved.id, uri: `external-sends/${saved.id}`, label: saved.title };
          const rollbackPoint = await ports.createExternalSendRollback(operation, [ref], {}, { external_send: saved });
          return { resource: saved, ref, rollbackPoint, summary: `Prepared external send draft ${saved.title}.` };
        }});
        return { ok: true, value };
      }
    };
  }
});

export default externalSend;
