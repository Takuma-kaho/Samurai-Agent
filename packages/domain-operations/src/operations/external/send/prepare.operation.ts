// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { ExternalSendChannelSchema, type ActivityInboxItem, type ExternalSendRecord, type JsonValue, type MessageEnvelope, type OperationRecord, type ResourceRef, type RollbackPoint, type SessionRecord } from "@samurai-agent/core-schemas";
import { domainJsonValueSchema, defineCommand, type DomainResult, type TrustedDomainContext } from "../../../definition/index.js";
import { externalSendWriteValueSchema } from "../../../value-objects/external-send.js";

const Input = z.object({
  "body": z.string().default(""),
  "channel": ExternalSendChannelSchema.default("webhook"),
  "target": z.record(domainJsonValueSchema).default({}),
  "title": z.string().default("")
}).strict();
const Output = externalSendWriteValueSchema;

export interface ExternalSendPreparePorts {
  ensureExternalSendSession(): Promise<SessionRecord>; createExternalSendEnvelope(session: SessionRecord, content: string): MessageEnvelope;
  createExternalSendId(): string; externalSendNow(): string; saveExternalSend(record: ExternalSendRecord): Promise<ExternalSendRecord>;
  createExternalSendRollback(operation: OperationRecord, refs: ResourceRef[], before: Record<string, JsonValue>, after: Record<string, JsonValue>): Promise<RollbackPoint>;
  runExternalSendMutation(input: { session: SessionRecord; envelope: MessageEnvelope; operationName: "external.send.prepare"; proposedEffects: string[]; execute(operation: OperationRecord): Promise<{ resource: ExternalSendRecord; ref: ResourceRef; rollbackPoint?: RollbackPoint; summary: string }> }): Promise<{ resource: ExternalSendRecord; operation: OperationRecord; rollbackPoint?: RollbackPoint; activity: ActivityInboxItem[] }>;
}

const externalSendPrepare = defineCommand<ExternalSendPreparePorts>()({
  ...{
  "kind": "command",
  "id": "external.send.prepare",
  "version": "2.0",
  "availability": "active",
  "title": "Prepare external send draft",
  "description": "Prepare an outbound send draft without dispatching it.",
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
    "Create an outbound send draft without dispatching."
  ],
  "outputResourceKind": "external_send",
  "uiDisplayCategory": "external",
  "providerToolNames": [
    "request_external_send",
    "external.send.prepare"
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
      execute: async function handleExternalSendPrepare(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        const session = await ports.ensureExternalSendSession();
        const envelope = ports.createExternalSendEnvelope(session, `Prepare external send: ${input.title}`);
        const now = ports.externalSendNow();
        const draft: ExternalSendRecord = { id: ports.createExternalSendId(), channel: input.channel, status: "draft", target: input.target, title: input.title, body: input.body, created_at: now, updated_at: now };
        const value = await ports.runExternalSendMutation({ session, envelope, operationName: "external.send.prepare", proposedEffects: ["Create an outbound send draft without dispatching."], execute: async (operation) => {
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

export default externalSendPrepare;
