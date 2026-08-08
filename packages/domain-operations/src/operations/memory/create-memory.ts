import { createId, type ActivityInboxItem, type JsonValue, type MemoryFrontmatter, type OperationRecord, type ResourceRef, type RollbackPoint, type SupportedLocale } from "@samurai-agent/core-schemas";
import type { TrustedDomainContext } from "../../definition/index.js";

export interface MemoryTopicCreatePorts {
  memoryCreateError(message: string): Error;
  writeRoomTopicMemory(input: { context: TrustedDomainContext; memoryId: string; topicKind: string; content: string; inputLocale?: SupportedLocale; outputLocale?: SupportedLocale }): Promise<MemoryFrontmatter>;
  memoryResourceRef(memory: MemoryFrontmatter): ResourceRef;
  createMemoryRollback(operation: OperationRecord, refs: ResourceRef[], after: Record<string, JsonValue>): Promise<RollbackPoint>;
  emitMemoryCandidate(memory: MemoryFrontmatter): Promise<void>;
  runMemoryMutation(input: { trustedContext: TrustedDomainContext; operationName: "memory.topic.create"; inputSummary: string; proposedEffects: string[]; boundaryResourceRefs?: ResourceRef[]; execute(operation: OperationRecord): Promise<{ resource: MemoryFrontmatter; ref: ResourceRef; rollbackPoint?: RollbackPoint; summary: string }> }): Promise<{ resource: MemoryFrontmatter; operation: OperationRecord; rollbackPoint?: RollbackPoint; activity: ActivityInboxItem[] }>;
}

export async function createRoomTopicMemory(ports: MemoryTopicCreatePorts, input: {
  context: TrustedDomainContext; content: string; inputLocale?: SupportedLocale;
  outputLocale?: SupportedLocale; topicKind: string;
}) {
  if (!input.context.roomId) throw ports.memoryCreateError("memory_room_context_required");
  const memoryId = createId("memory");
  return ports.runMemoryMutation({ trustedContext: input.context, operationName: "memory.topic.create",
    inputSummary: `Create topic memory: ${input.topicKind}`,
    proposedEffects: ["Create a visible topic memory candidate."],
    boundaryResourceRefs: [{ kind: "memory", id: memoryId, uri: `memory/${memoryId}.md`, label: input.topicKind }],
    execute: async (operation) => {
      const memory = await ports.writeRoomTopicMemory({ context: input.context, memoryId, topicKind: input.topicKind, content: input.content,
        inputLocale: input.inputLocale, outputLocale: input.outputLocale });
      const ref = ports.memoryResourceRef(memory);
      const rollbackPoint = await ports.createMemoryRollback(operation, [ref], { memory_id: memory.id });
      await ports.emitMemoryCandidate(memory);
      return { resource: memory, ref, rollbackPoint, summary: `Created topic memory ${memory.topic}.` };
    }});
}
