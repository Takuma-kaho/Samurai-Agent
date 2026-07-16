import type { ActivityInboxItem, JsonValue, MemoryFrontmatter, MessageEnvelope, OperationRecord, ResourceRef, RollbackPoint, SessionRecord, SupportedLocale } from "@samurai-agent/core-schemas";

export interface MemoryCreatePorts {
  getMemorySession(id: string): Promise<SessionRecord | undefined>;
  createMemorySession(input: { title?: string; ui_locale?: SupportedLocale; output_locale?: SupportedLocale }): Promise<SessionRecord>;
  ensureMemorySession(): Promise<SessionRecord>;
  memoryCreateError(message: string): Error;
  createMemoryEnvelope(input: { session: SessionRecord; content: string; inputLocale?: SupportedLocale; outputLocale?: SupportedLocale; metadata: Record<string, JsonValue>; envelopeId?: string }): MessageEnvelope;
  writeSessionMemory(envelope: MessageEnvelope, content: string): Promise<MemoryFrontmatter>;
  writeTopicMemory(envelope: MessageEnvelope, topicKind: string, content: string): Promise<MemoryFrontmatter>;
  memoryResourceRef(memory: MemoryFrontmatter): ResourceRef;
  createMemoryRollback(operation: OperationRecord, refs: ResourceRef[], after: Record<string, JsonValue>): Promise<RollbackPoint>;
  emitMemoryCandidate(memory: MemoryFrontmatter): Promise<void>;
  runMemoryMutation(input: { session: SessionRecord; envelope: MessageEnvelope; operationName: "memory.session.create" | "memory.topic.create"; proposedEffects: string[]; execute(operation: OperationRecord): Promise<{ resource: MemoryFrontmatter; ref: ResourceRef; rollbackPoint?: RollbackPoint; summary: string }> }): Promise<{ resource: MemoryFrontmatter; operation: OperationRecord; rollbackPoint?: RollbackPoint; activity: ActivityInboxItem[] }>;
}

export async function createMemory(ports: MemoryCreatePorts, input: {
  kind: "session" | "topic"; content: string; sessionId?: string; title?: string; uiLocale?: SupportedLocale; inputLocale?: SupportedLocale;
  outputLocale?: SupportedLocale; metadata: Record<string, JsonValue>; envelopeId?: string; topicKind?: string;
}) {
  const session = input.sessionId
    ? await ports.getMemorySession(input.sessionId)
    : input.kind === "session"
      ? await ports.createMemorySession({ title: input.title, ui_locale: input.uiLocale, output_locale: input.outputLocale })
      : await ports.ensureMemorySession();
  if (!session) throw ports.memoryCreateError(`Session not found: ${input.sessionId}`);
  const envelope = ports.createMemoryEnvelope({ session, content: input.content,
    inputLocale: input.inputLocale ?? (input.kind === "session" ? session.ui_locale : undefined),
    outputLocale: input.outputLocale ?? (input.kind === "session" ? session.output_locale : undefined),
    metadata: input.metadata, envelopeId: input.envelopeId });
  const operationName = input.kind === "session" ? "memory.session.create" : "memory.topic.create";
  return ports.runMemoryMutation({ session, envelope, operationName,
    proposedEffects: [input.kind === "session" ? "Keep the current user intent in session memory." : "Create a visible topic memory candidate."],
    execute: async (operation) => {
      const memory = input.kind === "session"
        ? await ports.writeSessionMemory(envelope, input.content)
        : await ports.writeTopicMemory(envelope, input.topicKind ?? "preference", input.content);
      const ref = ports.memoryResourceRef(memory);
      const rollbackPoint = await ports.createMemoryRollback(operation, [ref], { memory_id: memory.id });
      await ports.emitMemoryCandidate(memory);
      return { resource: memory, ref, rollbackPoint, summary: `Created ${memory.state === "session" ? "session" : "topic"} memory ${memory.topic}.` };
    }});
}
