import {
  type ActivityInboxItem,
  type JsonValue,
  type MemoryFrontmatter,
  type MessageEnvelope,
  type OperationRecord,
  type ResourceRef,
  type RollbackPoint,
  type SessionRecord,
  type SupportedLocale
} from "@samurai-agent/core-schemas";

interface ArchivedMemorySnapshot {
  frontmatter: MemoryFrontmatter;
  file_path: string;
}

interface ArchivedMemoryResult {
  before: ArchivedMemorySnapshot;
  after: ArchivedMemorySnapshot;
  content: string;
  changed: boolean;
  warning?: string;
}

export interface MemoryArchivePort {
  getMemory(id: string): Promise<(MemoryFrontmatter & { file_path: string }) | undefined>;
  listMemoryForSession(sessionId: string): Promise<Array<MemoryFrontmatter & { file_path: string }>>;
  archive(id: string): Promise<ArchivedMemoryResult | undefined>;
  saveOperation(operation: OperationRecord): Promise<OperationRecord>;
  updateOperation(operation: OperationRecord): Promise<OperationRecord>;
  createRollback(operation: OperationRecord, refs: ResourceRef[], before: Record<string, JsonValue>, after: Record<string, JsonValue>): Promise<RollbackPoint>;
  rebuildActivity(): Promise<ActivityInboxItem[]>;
  emitOperation(operation: OperationRecord): Promise<void>;
  capabilityId: string;
}

interface MemoryMutationResult {
  resource: MemoryFrontmatter;
  ref: ResourceRef;
  rollbackPoint?: RollbackPoint;
  summary: string;
}
interface MemoryWriteResult {
  resource: MemoryFrontmatter;
  operation: OperationRecord;
  rollbackPoint?: RollbackPoint;
  activity: ActivityInboxItem[];
}

export interface MemoryCommandPort {
  getSession(id: string): Promise<SessionRecord | undefined>;
  createSession(input: { title?: string; ui_locale?: SupportedLocale; output_locale?: SupportedLocale }): Promise<SessionRecord>;
  ensureSession(): Promise<SessionRecord>;
  createEnvelope(input: { session: SessionRecord; content: string; inputLocale?: SupportedLocale; outputLocale?: SupportedLocale; metadata: Record<string, JsonValue>; envelopeId?: string }): MessageEnvelope;
  writeSessionMemory(envelope: MessageEnvelope, content: string): Promise<MemoryFrontmatter>;
  writeTopicMemory(envelope: MessageEnvelope, topicKind: string, content: string): Promise<MemoryFrontmatter>;
  memoryRef(memory: MemoryFrontmatter): ResourceRef;
  createRollback(operation: OperationRecord, refs: ResourceRef[], after: Record<string, JsonValue>): Promise<RollbackPoint>;
  emitCandidate(memory: MemoryFrontmatter): Promise<void>;
  runMutation(input: {
    session: SessionRecord; envelope: MessageEnvelope; operationName: "memory.session.create" | "memory.topic.create";
    proposedEffects: string[]; execute(operation: OperationRecord): Promise<MemoryMutationResult>;
  }): Promise<MemoryWriteResult>;
}

export class MemoryDomainService {
  constructor(private readonly dependencies: {
    memories: MemoryCommandPort;
    archive: MemoryArchivePort;
    requestError: (code: "conflict" | "not_found", message: string) => Error;
  }) {}

  getSession(id: string) { return this.dependencies.memories.getSession(id); }
  getMemoryForArchive(id: string) { return this.dependencies.archive.getMemory(id); }
  listMemoryForSession(id: string) { return this.dependencies.archive.listMemoryForSession(id); }
  archiveMemoryRecord(id: string) { return this.dependencies.archive.archive(id); }
  memoryArchiveError(code: "conflict" | "not_found", message: string) { return this.dependencies.requestError(code, message); }
  memoryRef(memory: MemoryFrontmatter) { return this.dependencies.memories.memoryRef(memory); }
  memoryArchiveCapabilityId() { return this.dependencies.archive.capabilityId; }
  saveMemoryArchiveOperation(operation: OperationRecord) { return this.dependencies.archive.saveOperation(operation); }
  updateMemoryArchiveOperation(operation: OperationRecord) { return this.dependencies.archive.updateOperation(operation); }
  emitMemoryArchiveOperation(operation: OperationRecord) { return this.dependencies.archive.emitOperation(operation); }
  createMemoryArchiveRollback(operation: OperationRecord, refs: ResourceRef[], before: Record<string, JsonValue>, after: Record<string, JsonValue>) { return this.dependencies.archive.createRollback(operation, refs, before, after); }
  rebuildMemoryActivity() { return this.dependencies.archive.rebuildActivity(); }
  createMemorySession(input: { title?: string; ui_locale?: SupportedLocale; output_locale?: SupportedLocale }) { return this.dependencies.memories.createSession(input); }
  ensureMemorySession() { return this.dependencies.memories.ensureSession(); }
  memoryCreateError(message: string) { return this.dependencies.requestError("not_found", message); }
  createMemoryEnvelope(input: Parameters<MemoryCommandPort["createEnvelope"]>[0]) { return this.dependencies.memories.createEnvelope(input); }
  writeSessionMemory(envelope: MessageEnvelope, content: string) { return this.dependencies.memories.writeSessionMemory(envelope, content); }
  writeTopicMemory(envelope: MessageEnvelope, topicKind: string, content: string) { return this.dependencies.memories.writeTopicMemory(envelope, topicKind, content); }
  createMemoryRollback(operation: OperationRecord, refs: ResourceRef[], after: Record<string, JsonValue>) { return this.dependencies.memories.createRollback(operation, refs, after); }
  emitMemoryCandidate(memory: MemoryFrontmatter) { return this.dependencies.memories.emitCandidate(memory); }
  runMemoryMutation(input: Parameters<MemoryCommandPort["runMutation"]>[0]) { return this.dependencies.memories.runMutation(input); }

}
