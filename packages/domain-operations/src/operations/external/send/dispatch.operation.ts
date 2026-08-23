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
  claimDispatch(input: { id: string; now: string; lease_until: string }): Promise<{ record: ExternalSendRecord; claim_token: string } | undefined>;
  settleDispatch(input: { record: ExternalSendRecord; claim_token: string }): Promise<ExternalSendRecord>;
  markOutcomeUnknown(input: { id: string; claim_token: string; now: string; message: string; dispatch_result?: Record<string, JsonValue> }): Promise<ExternalSendRecord>;
  dispatchExternalSend(record: ExternalSendRecord, dryRun: boolean): Promise<{ dispatched: boolean; adapter: string; transport?: string; status?: number; dry_run: boolean; message: string; idempotency_guaranteed?: boolean; outcome_unknown?: boolean }>;
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
        if (existing.status === "dispatched" || existing.dispatched_at) {
          throw Object.assign(new Error(`external_send_already_dispatched:${existing.id}`), { code: "conflict" as const });
        }
        if (existing.status === "outcome_unknown") {
          throw Object.assign(new Error(`external_send_outcome_unknown:${existing.id}`), { code: "outcome_unknown" as const });
        }
        if (existing.status !== "approved") {
          throw Object.assign(new Error(`external_send_approval_required:${existing.id}`), { code: "conflict" as const });
        }
        const session = await ports.ensureExternalSendSession();
        const envelope = ports.createExternalSendEnvelope(session, `Dispatch external send: ${existing.title}`);
        const ref: ResourceRef = { kind: "external_send", id: existing.id, uri: `external-sends/${existing.id}`, label: existing.title };
        const value = await ports.runExternalSendMutation({ session, envelope, operationName: "external.send.dispatch", proposedEffects: ["Dispatch a prepared outbound send to an external channel."], inputRef: ref, targetResourceRefs: [ref], execute: async (operation) => {
          const now = ports.externalSendNow();
          const leaseUntil = new Date(Date.parse(now) + 60_000).toISOString();
          const claim = await ports.claimDispatch({ id: existing.id, now, lease_until: leaseUntil });
          if (!claim) {
            const current = await ports.getExternalSend(existing.id);
            if (current?.status === "outcome_unknown") {
              throw Object.assign(new Error(`external_send_outcome_unknown:${existing.id}`), { code: "outcome_unknown" as const });
            }
            if (current?.status === "dispatched" || current?.dispatched_at) {
              throw Object.assign(new Error(`external_send_already_dispatched:${existing.id}`), { code: "conflict" as const });
            }
            throw Object.assign(new Error(`external_send_dispatch_claim_conflict:${existing.id}`), { code: "conflict" as const });
          }

          const claimRecord = claim.record;
          let outcomeUnknownSettled = false;
          const settleOutcomeUnknown = async (message: string, dispatchResult?: Record<string, JsonValue>) => {
            const unknown = await ports.markOutcomeUnknown({ id: claimRecord.id, claim_token: claim.claim_token, now: ports.externalSendNow(), message, ...(dispatchResult ? { dispatch_result: dispatchResult } : {}) });
            outcomeUnknownSettled = true;
            const unknownRef: ResourceRef = { kind: "external_send", id: unknown.id, uri: `external-sends/${unknown.id}`, label: unknown.title };
            return { resource: unknown, ref: unknownRef, summary: `External send ${unknown.title} requires human confirmation; its outcome is unknown.` };
          };

          try {
            const result = await ports.dispatchExternalSend(claimRecord, input.dry_run ?? ports.externalSendDefaultDryRun());
            const dispatchResult: Record<string, JsonValue> = { dispatched: result.dispatched, adapter: result.adapter, dry_run: result.dry_run, idempotency_key: claimRecord.id, message: result.message };
            if (result.transport !== undefined) dispatchResult.transport = result.transport;
            if (result.status !== undefined) dispatchResult.status = result.status;
            if (result.idempotency_guaranteed !== undefined) dispatchResult.idempotency_guaranteed = result.idempotency_guaranteed;
            if (result.outcome_unknown || (result.dispatched && result.idempotency_guaranteed !== true)) {
              return settleOutcomeUnknown(result.outcome_unknown
                ? result.message
                : "The external adapter did not guarantee the send_id idempotency key; human confirmation is required before any further action.", dispatchResult);
            }
            const updatedAt = ports.externalSendNow();
            const saved = await ports.settleDispatch({
              claim_token: claim.claim_token,
              record: { ...claimRecord, status: result.dispatched ? "dispatched" : result.dry_run ? "approved" : "failed", operation_id: operation.id, dispatch_result: dispatchResult, updated_at: updatedAt, dispatched_at: result.dispatched ? updatedAt : undefined }
            });
            const savedRef: ResourceRef = { kind: "external_send", id: saved.id, uri: `external-sends/${saved.id}`, label: saved.title };
            const summary = result.dispatched ? `Dispatched external send ${saved.title}.` : result.dry_run ? `Prepared external send ${saved.title}; dispatch dry-run recorded.` : `External send ${saved.title} dispatch failed.`;
            return { resource: saved, ref: savedRef, summary };
          } catch (error) {
            if (outcomeUnknownSettled) throw error;
            const message = error instanceof Error ? error.message : String(error);
            try {
              await settleOutcomeUnknown(message);
            } catch {
              // The lease remains durable; startup reconciliation will fail closed.
            }
            throw Object.assign(new Error(`external_send_outcome_unknown:${claimRecord.id}`), { code: "outcome_unknown" as const });
          }
        }});
        return { ok: true, value };
      }
    };
  }
});

export default externalSendDispatch;
