import { externalSendChannels, type ActivityInboxItem, type ExternalSendChannel, type ExternalSendRecord, type JsonValue, type MessageEnvelope, type OperationRecord, type ResourceRef, type RollbackPoint, type SessionRecord } from "@samurai-agent/core-schemas";

export interface ExternalDispatchResult { dispatched: boolean; adapter: string; transport?: string; status?: number; dry_run: boolean; message: string }
interface ExternalSendWriteResult { resource: ExternalSendRecord; operation: OperationRecord; rollbackPoint?: RollbackPoint; activity: ActivityInboxItem[] }
export interface ExternalSendPort {
  get(id: string): Promise<ExternalSendRecord | undefined>; save(record: ExternalSendRecord): Promise<ExternalSendRecord>;
  dispatch(record: ExternalSendRecord, dryRun: boolean): Promise<ExternalDispatchResult>;
}
export interface ExternalSendMutationHost {
  ensureSession(): Promise<SessionRecord>; createEnvelope(session: SessionRecord, content: string): MessageEnvelope;
  runMutation(input: { session: SessionRecord; envelope: MessageEnvelope; operationName: "external.send" | "external.send.prepare" | "external.send.dispatch"; proposedEffects: string[]; inputRef?: ResourceRef; targetResourceRefs?: ResourceRef[]; execute(operation: OperationRecord): Promise<{ resource: ExternalSendRecord; ref: ResourceRef; rollbackPoint?: RollbackPoint; summary: string }> }): Promise<ExternalSendWriteResult>;
  createRollback(operation: OperationRecord, refs: ResourceRef[], before: Record<string, JsonValue>, after: Record<string, JsonValue>): Promise<RollbackPoint>;
  createId(): string; now(): string; defaultDryRun(): boolean; notFound(message: string): Error;
}

export class ExternalSendDomainService {
  constructor(private readonly sends: ExternalSendPort, private readonly host: ExternalSendMutationHost) {}

  prepare(payload: Record<string, JsonValue>) { return this.createDraft("external.send.prepare", { channel: channel(payload.channel), target: record(payload.target), title: text(payload.title), body: text(payload.body) }); }
  request(payload: Record<string, JsonValue>) { return this.createDraft("external.send", { channel: channel(payload.channel), target: record(payload.target), title: text(payload.title) || "External send request", body: text(payload.body) || text(payload.content) || text(payload.user_intent) || "External send requested by backend." }); }
  dispatch(payload: Record<string, JsonValue>) { return this.dispatchDraft(text(payload.send_id) || text(payload.sendId), typeof payload.dry_run === "boolean" ? payload.dry_run : undefined); }

  private async createDraft(operationName: "external.send" | "external.send.prepare", input: { channel: ExternalSendChannel; target: Record<string, JsonValue>; title: string; body: string }): Promise<ExternalSendWriteResult> {
    const session = await this.host.ensureSession(); const envelope = this.host.createEnvelope(session, `Prepare external send: ${input.title}`); const now = this.host.now();
    const draft: ExternalSendRecord = { id: this.host.createId(), channel: input.channel, status: "draft", target: input.target, title: input.title, body: input.body, created_at: now, updated_at: now };
    return this.host.runMutation({ session, envelope, operationName, proposedEffects: ["Create an outbound send draft without dispatching."], execute: async (operation) => {
      const saved = await this.sends.save({ ...draft, operation_id: operation.id }); const ref = sendRef(saved);
      const rollbackPoint = await this.host.createRollback(operation, [ref], {}, { external_send: saved as unknown as JsonValue });
      return { resource: saved, ref, rollbackPoint, summary: `Prepared external send draft ${saved.title}.` };
    }});
  }

  private async dispatchDraft(id: string, dryRun?: boolean): Promise<ExternalSendWriteResult> {
    const existing = await this.sends.get(id); if (!existing) throw this.host.notFound(`External send not found: ${id}`);
    const session = await this.host.ensureSession(); const envelope = this.host.createEnvelope(session, `Dispatch external send: ${existing.title}`); const ref = sendRef(existing);
    return this.host.runMutation({ session, envelope, operationName: "external.send.dispatch", proposedEffects: ["Dispatch a prepared outbound send to an external channel."], inputRef: ref, targetResourceRefs: [ref], execute: async (operation) => {
      const result = await this.sends.dispatch(existing, dryRun ?? this.host.defaultDryRun()); const now = this.host.now();
      const saved = await this.sends.save({ ...existing, status: result.dispatched ? "dispatched" : result.dry_run ? "approved" : "failed", operation_id: operation.id, dispatch_result: result as unknown as Record<string, JsonValue>, updated_at: now, dispatched_at: result.dispatched ? now : undefined });
      return { resource: saved, ref: sendRef(saved), summary: result.dispatched ? `Dispatched external send ${saved.title}.` : result.dry_run ? `Prepared external send ${saved.title}; dispatch dry-run recorded.` : `External send ${saved.title} dispatch failed.` };
    }});
  }
}

function text(value: JsonValue | undefined): string { return typeof value === "string" ? value : ""; }
function record(value: JsonValue | undefined): Record<string, JsonValue> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, JsonValue> : {}; }
function channel(value: JsonValue | undefined): ExternalSendChannel { return typeof value === "string" && externalSendChannels.includes(value as ExternalSendChannel) ? value as ExternalSendChannel : "webhook"; }
function sendRef(send: ExternalSendRecord): ResourceRef { return { kind: "external_send", id: send.id, uri: `external-sends/${send.id}`, label: send.title }; }
