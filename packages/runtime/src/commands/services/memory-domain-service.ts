import {
  createId,
  nowIso,
  stableHash,
  supportedLocales,
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

interface SessionMemoryInput {
  content: string; sessionId?: string; title?: string; uiLocale?: SupportedLocale; outputLocale?: SupportedLocale;
  inputLocale?: SupportedLocale; metadata: Record<string, JsonValue>; envelopeId?: string;
}

interface TopicMemoryInput {
  content: string; topic: string; topicKind: string; sessionId?: string;
  inputLocale?: SupportedLocale; outputLocale?: SupportedLocale; metadata: Record<string, JsonValue>; envelopeId?: string;
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

  archive(payload: Record<string, JsonValue>) {
    const sessionId = optionalString(payload.session_id);
    if (!sessionId) throw this.dependencies.requestError("conflict", "domain_command_memory_archive_session_id_required");
    return this.archiveMemory({ memoryId: requiredId(payload, "memory_id"), sessionId });
  }

  async archiveMemory(input: { memoryId: string; sessionId: string; actorIdentity?: OperationRecord["actor_identity"]; decidedBy?: string }) {
    const session = await this.dependencies.memories.getSession(input.sessionId);
    if (!session) throw this.notFound(`Session not found: ${input.sessionId}`);
    const memory = await this.dependencies.archive.getMemory(input.memoryId);
    if (!memory) throw this.notFound(`Memory not found: ${input.memoryId}`);
    const sessionMemory = await this.dependencies.archive.listMemoryForSession(session.id);
    if (!sessionMemory.some((item) => item.id === input.memoryId)) {
      throw this.dependencies.requestError("conflict", "memory_not_in_session");
    }

    const now = nowIso();
    const initialRef = this.dependencies.memories.memoryRef(memory);
    const operation: OperationRecord = {
      id: createId("operation"), session_id: session.id, capability_id: this.dependencies.archive.capabilityId,
      operation: "memory.archive", actor_identity: input.actorIdentity ?? "owner",
      instruction_source: "owner_instruction", instruction_authority: input.decidedBy ?? "owner", channel: "web",
      input_hash: stableHash({ memory_id: memory.id, session_id: session.id, operationName: "memory.archive" }),
      input_ref: initialRef, target_resource_refs: [initialRef],
      proposed_effects: ["Archive a session-linked memory so it no longer appears in normal memory views."],
      status: "created", created_at: now, updated_at: now
    };
    await this.dependencies.archive.saveOperation(operation);
    await this.dependencies.archive.emitOperation(operation);

    const archive = await this.dependencies.archive.archive(input.memoryId);
    if (!archive) throw this.notFound(`Memory not found: ${input.memoryId}`);
    const archivedMemory = { ...archive.after.frontmatter, file_path: archive.after.file_path };
    const ref = this.dependencies.memories.memoryRef(archivedMemory);
    const rollbackPoint = archive.changed
      ? await this.dependencies.archive.createRollback(operation, [ref],
        { memory: archive.before as unknown as JsonValue }, { memory: archive.after as unknown as JsonValue })
      : undefined;
    operation.status = "completed";
    operation.result_ref = ref;
    operation.updated_at = nowIso();
    await this.dependencies.archive.updateOperation(operation);
    return {
      memory: archivedMemory, content: archive.content, operation, rollbackPoint,
      activity: await this.dependencies.archive.rebuildActivity(), changed: archive.changed, warning: archive.warning
    };
  }

  async createSession(payload: Record<string, JsonValue>) {
    const content = optionalString(payload.content) || optionalString(payload.user_intent) || optionalString(payload.target_instruction);
    if (!content) throw this.dependencies.requestError("conflict", "domain_command_memory_content_required");
    return this.createSessionMemory({
      content, sessionId: optionalString(payload.session_id) || undefined, title: optionalString(payload.title) || undefined,
      uiLocale: locale(payload.ui_locale), outputLocale: locale(payload.output_locale), inputLocale: locale(payload.input_locale),
      metadata: recordValue(payload.metadata), envelopeId: optionalString(payload.envelope_id) || optionalString(payload.input_message_id) || undefined
    });
  }

  async createTopic(payload: Record<string, JsonValue>) {
    const content = optionalString(payload.content) || optionalString(payload.topic) || optionalString(payload.user_intent) || optionalString(payload.target_instruction);
    if (!content) throw this.dependencies.requestError("conflict", "domain_command_memory_topic_required");
    return this.createTopicMemory({
      content, topic: optionalString(payload.topic), topicKind: optionalString(payload.topic_kind) || "preference",
      sessionId: optionalString(payload.session_id) || undefined, inputLocale: locale(payload.input_locale),
      outputLocale: locale(payload.output_locale), metadata: recordValue(payload.metadata),
      envelopeId: optionalString(payload.envelope_id) || optionalString(payload.input_message_id) || undefined
    });
  }

  private async createSessionMemory(input: SessionMemoryInput): Promise<MemoryWriteResult> {
    const session = input.sessionId
      ? await this.dependencies.memories.getSession(input.sessionId)
      : await this.dependencies.memories.createSession({ title: input.title, ui_locale: input.uiLocale, output_locale: input.outputLocale });
    if (!session) throw this.notFound(`Session not found: ${input.sessionId}`);
    const envelope = this.dependencies.memories.createEnvelope({
      session, content: input.content, inputLocale: input.inputLocale ?? session.ui_locale,
      outputLocale: input.outputLocale ?? session.output_locale, metadata: input.metadata, envelopeId: input.envelopeId
    });
    return this.dependencies.memories.runMutation({
      session, envelope, operationName: "memory.session.create", proposedEffects: ["Keep the current user intent in session memory."],
      execute: async (operation) => this.persistMemory(operation, await this.dependencies.memories.writeSessionMemory(envelope, input.content))
    });
  }

  private async createTopicMemory(input: TopicMemoryInput): Promise<MemoryWriteResult> {
    const session = input.sessionId
      ? await this.dependencies.memories.getSession(input.sessionId)
      : await this.dependencies.memories.ensureSession();
    if (!session) throw this.notFound(`Session not found: ${input.sessionId}`);
    const envelope = this.dependencies.memories.createEnvelope({
      session, content: input.content, inputLocale: input.inputLocale,
      outputLocale: input.outputLocale, metadata: input.metadata, envelopeId: input.envelopeId
    });
    return this.dependencies.memories.runMutation({
      session, envelope, operationName: "memory.topic.create", proposedEffects: ["Create a visible topic memory candidate."],
      execute: async (operation) => this.persistMemory(operation, await this.dependencies.memories.writeTopicMemory(envelope, input.topicKind, input.content))
    });
  }

  private async persistMemory(operation: OperationRecord, memory: MemoryFrontmatter): Promise<MemoryMutationResult> {
    const ref = this.dependencies.memories.memoryRef(memory);
    const rollbackPoint = await this.dependencies.memories.createRollback(operation, [ref], { memory_id: memory.id });
    await this.dependencies.memories.emitCandidate(memory);
    return { resource: memory, ref, rollbackPoint, summary: `Created ${memory.state === "session" ? "session" : "topic"} memory ${memory.topic}.` };
  }

  private notFound(message: string): Error {
    return this.dependencies.requestError("not_found", message);
  }
}

function optionalString(value: JsonValue | undefined): string { return typeof value === "string" ? value.trim() : ""; }
function requiredId(payload: Record<string, JsonValue>, key: string): string {
  const value = optionalString(payload[key]) || optionalString(payload.id);
  if (!value) throw new Error(`domain_operation_required_field:${key}`);
  return value;
}
function locale(value: JsonValue | undefined): SupportedLocale | undefined {
  return typeof value === "string" && supportedLocales.includes(value as SupportedLocale) ? value as SupportedLocale : undefined;
}
function recordValue(value: JsonValue | undefined): Record<string, JsonValue> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, JsonValue> : {}; }
