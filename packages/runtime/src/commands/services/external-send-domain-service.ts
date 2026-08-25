import { type ActivityInboxItem, type ExternalSendRecord, type JsonValue, type MessageEnvelope, type OperationRecord, type ResourceRef, type RollbackPoint, type SessionRecord } from "@samurai-agent/core-schemas";

export interface ExternalDispatchResult {
  dispatched: boolean;
  adapter: string;
  transport?: string;
  status?: number;
  dry_run: boolean;
  message: string;
  idempotency_guaranteed?: boolean;
  outcome_unknown?: boolean;
}
export interface ExternalSendDispatchClaim { record: ExternalSendRecord; claim_token: string }
interface ExternalSendWriteResult { resource: ExternalSendRecord; operation: OperationRecord; rollbackPoint?: RollbackPoint; activity: ActivityInboxItem[] }
export interface ExternalSendPort {
  get(id: string): Promise<ExternalSendRecord | undefined>; save(record: ExternalSendRecord): Promise<ExternalSendRecord>;
  dispatch(record: ExternalSendRecord, dryRun: boolean): Promise<ExternalDispatchResult>;
  claimDispatch(input: { id: string; now: string; lease_until: string }): Promise<ExternalSendDispatchClaim | undefined>;
  settleDispatch(input: { record: ExternalSendRecord; claim_token: string }): Promise<ExternalSendRecord>;
  markOutcomeUnknown(input: { id: string; claim_token: string; now: string; message: string; dispatch_result?: Record<string, JsonValue> }): Promise<ExternalSendRecord>;
}
export interface ExternalSendMutationHost {
  ensureSession(): Promise<SessionRecord>; createEnvelope(session: SessionRecord, content: string): MessageEnvelope;
  getForCurrentRoom(id: string): Promise<ExternalSendRecord | undefined>;
  assertCurrentRoomExecution(): Promise<void>;
  runMutation(input: { session: SessionRecord; envelope: MessageEnvelope; operationName: "external.send" | "external.send.prepare" | "external.send.dispatch"; proposedEffects: string[]; inputRef?: ResourceRef; targetResourceRefs?: ResourceRef[]; execute(operation: OperationRecord): Promise<{ resource: ExternalSendRecord; ref: ResourceRef; rollbackPoint?: RollbackPoint; summary: string }> }): Promise<ExternalSendWriteResult>;
  createRollback(operation: OperationRecord, refs: ResourceRef[], before: Record<string, JsonValue>, after: Record<string, JsonValue>): Promise<RollbackPoint>;
  createId(): string; now(): string; defaultDryRun(): boolean; notFound(message: string): Error;
}

export class ExternalSendDomainService {
  constructor(private readonly sends: ExternalSendPort, private readonly host: ExternalSendMutationHost) {}

  getExternalSend(id: string) { return this.sends.get(id); }
  getExternalSendForCurrentRoom(id: string) { return this.host.getForCurrentRoom(id); }
  saveExternalSend(record: ExternalSendRecord) { return this.sends.save(record); }
  claimExternalSendDispatch(input: Parameters<ExternalSendPort["claimDispatch"]>[0]) { return this.sends.claimDispatch(input); }
  settleExternalSendDispatch(input: Parameters<ExternalSendPort["settleDispatch"]>[0]) { return this.sends.settleDispatch(input); }
  markExternalSendOutcomeUnknown(input: Parameters<ExternalSendPort["markOutcomeUnknown"]>[0]) { return this.sends.markOutcomeUnknown(input); }
  async dispatchExternalSend(record: ExternalSendRecord, dryRun: boolean) {
    await this.host.assertCurrentRoomExecution();
    // An explicit API payload cannot turn on real delivery while the
    // process-level safety switch keeps external dispatch disabled.
    return this.sends.dispatch(record, dryRun || this.host.defaultDryRun());
  }
  ensureExternalSendSession() { return this.host.ensureSession(); }
  createExternalSendEnvelope(session: SessionRecord, content: string) { return this.host.createEnvelope(session, content); }
  runExternalSendMutation(input: Parameters<ExternalSendMutationHost["runMutation"]>[0]) { return this.host.runMutation(input); }
  createExternalSendRollback(operation: OperationRecord, refs: ResourceRef[], before: Record<string, JsonValue>, after: Record<string, JsonValue>) { return this.host.createRollback(operation, refs, before, after); }
  createExternalSendId() { return this.host.createId(); }
  externalSendNow() { return this.host.now(); }
  externalSendDefaultDryRun() { return this.host.defaultDryRun(); }
  externalSendNotFound(id: string) { return this.host.notFound(`External send not found: ${id}`); }

}
