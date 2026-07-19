// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import type { ActivityInboxItem, ExternalSendRecord, JsonValue, MessageEnvelope, OperationRecord, ResourceRef, RollbackPoint, SessionRecord } from "@samurai-agent/core-schemas";
import { defineCommand, type DomainResult, type TrustedDomainContext } from "../../../definition/index.js";
import { externalSendWriteValueSchema } from "../../../value-objects/external-send.js";

const Input = z.object({
  "dry_run": z.boolean() .optional(),
  "send_id": z.string().trim().min(1)
}).strict();
const Output = externalSendWriteValueSchema;

export interface ExternalSendDispatchPorts {
  getExternalSend(id: string): Promise<ExternalSendRecord | undefined>; saveExternalSend(record: ExternalSendRecord): Promise<ExternalSendRecord>;
  dispatchExternalSend(record: ExternalSendRecord, dryRun: boolean): Promise<{ dispatched: boolean; adapter: string; transport?: string; status?: number; dry_run: boolean; message: string }>;
  ensureExternalSendSession(): Promise<SessionRecord>; createExternalSendEnvelope(session: SessionRecord, content: string): MessageEnvelope;
  externalSendNow(): string; externalSendDefaultDryRun(): boolean; externalSendNotFound(id: string): Error;
  runExternalSendMutation(input: { session: SessionRecord; envelope: MessageEnvelope; operationName: "external.send.dispatch"; proposedEffects: string[]; inputRef: ResourceRef; targetResourceRefs: ResourceRef[]; execute(operation: OperationRecord): Promise<{ resource: ExternalSendRecord; ref: ResourceRef; rollbackPoint?: RollbackPoint; summary: string }> }): Promise<{ resource: ExternalSendRecord; operation: OperationRecord; rollbackPoint?: RollbackPoint; activity: ActivityInboxItem[] }>;
}

const externalSendDispatch = defineCommand<ExternalSendDispatchPorts>()({
  ...{
  "kind": "command",
  "id": "external.send.dispatch",
  "version": "3.0",
  "availability": "active",
  "title": "Dispatch external send",
  "description": "Dispatch a prepared outbound send after approval.",
  "sources": [
    "provider_tool_call",
    "runtime_api"
  ],
  "effect": "external_effect",
  "idempotency": "external",
  "concurrency": "external_idempotency",
  "render": [
    "status_timeline"
  ],
  "resourceKinds": [
    "external_send"
  ],
  "proposedEffects": [
    "Dispatch a prepared outbound send after approval."
  ],
  "outputResourceKind": "external_send",
  "uiDisplayCategory": "external",
  "providerToolNames": [
    "external.send.dispatch"
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
      execute: async function handleExternalSendDispatch(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        const existing = await ports.getExternalSend(input.send_id);
        if (!existing) throw ports.externalSendNotFound(input.send_id);
        const session = await ports.ensureExternalSendSession();
        const envelope = ports.createExternalSendEnvelope(session, `Dispatch external send: ${existing.title}`);
        const ref: ResourceRef = { kind: "external_send", id: existing.id, uri: `external-sends/${existing.id}`, label: existing.title };
        const value = await ports.runExternalSendMutation({ session, envelope, operationName: "external.send.dispatch", proposedEffects: ["Dispatch a prepared outbound send to an external channel."], inputRef: ref, targetResourceRefs: [ref], execute: async (operation) => {
          const result = await ports.dispatchExternalSend(existing, input.dry_run ?? ports.externalSendDefaultDryRun());
          const now = ports.externalSendNow();
          const dispatchResult: Record<string, JsonValue> = { dispatched: result.dispatched, adapter: result.adapter, dry_run: result.dry_run, message: result.message };
          if (result.transport !== undefined) dispatchResult.transport = result.transport;
          if (result.status !== undefined) dispatchResult.status = result.status;
          const saved = await ports.saveExternalSend({ ...existing, status: result.dispatched ? "dispatched" : result.dry_run ? "approved" : "failed", operation_id: operation.id, dispatch_result: dispatchResult, updated_at: now, dispatched_at: result.dispatched ? now : undefined });
          const savedRef: ResourceRef = { kind: "external_send", id: saved.id, uri: `external-sends/${saved.id}`, label: saved.title };
          const summary = result.dispatched ? `Dispatched external send ${saved.title}.` : result.dry_run ? `Prepared external send ${saved.title}; dispatch dry-run recorded.` : `External send ${saved.title} dispatch failed.`;
          return { resource: saved, ref: savedRef, summary };
        }});
        return { ok: true, value };
      }
    };
  }
});

export default externalSendDispatch;
