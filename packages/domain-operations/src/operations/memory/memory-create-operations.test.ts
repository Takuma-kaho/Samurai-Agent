import { describe, expect, it, vi } from "vitest";
import type { MemoryFrontmatter, OperationRecord } from "@samurai-agent/core-schemas";
import type { TrustedDomainContext } from "../../definition/index.js";
import memorySessionCreate from "./session/create.operation.js";
import memoryTopicCreate from "./topic/create.operation.js";
import type { MemoryTopicCreatePorts } from "./create-memory.js";

const now = "2026-01-01T00:00:00.000Z";
const context: TrustedDomainContext = {
  inputSource: "runtime_api", workspaceId: "workspace_test", actorId: "actor_test",
  roomId: "room_test", correlationId: "correlation_test"
};
const operation: OperationRecord = {
  id: "operation_1", capability_id: "memory", operation: "memory.topic.create", actor_identity: "owner",
  instruction_source: "owner_instruction", instruction_authority: "owner", channel: "web", input_hash: "hash",
  target_resource_refs: [], proposed_effects: [], status: "completed", created_at: now, updated_at: now
};
const memory: MemoryFrontmatter = {
  id: "memory_1", state: "topic", topic: "preference", source: "message", source_locale: "ja", content_locale: "ja",
  source_kind: "owner_instruction", instruction_authority: "owner", confidence: 1, created_by: "owner", created_at: now,
  updated_at: now, related_memories: [], conflicts_with: [], sensitive_level: "none"
};

function ports() {
  const writeRoomTopicMemory = vi.fn(async () => memory);
  const value: MemoryTopicCreatePorts = {
    memoryCreateError: (message) => new Error(message),
    writeRoomTopicMemory,
    memoryResourceRef: (item) => ({ kind: "memory", id: item.id, uri: `memory/${item.id}.md` }),
    createMemoryRollback: async () => ({
      id: "rollback_1", operation_id: "operation_1", affected_resources: [], before_snapshot: {}, after_snapshot: {},
      reversible: true, irreversible_effects: [], created_at: now, expires_at: "2026-02-01T00:00:00.000Z"
    }),
    emitMemoryCandidate: async () => undefined,
    runMemoryMutation: async (input) => {
      const result = await input.execute(operation);
      return { resource: result.resource, operation, rollbackPoint: result.rollbackPoint, activity: [] };
    }
  };
  return { value, writeRoomTopicMemory };
}

describe("memory create handlers", () => {
  it("creates Room-scoped topic memory without a Session", async () => {
    const fixture = ports();
    const result = await memoryTopicCreate.createHandler(fixture.value).execute(
      context,
      memoryTopicCreate.input.parse({ content: "Use concise replies", topic_kind: "preference" })
    );

    expect(fixture.writeRoomTopicMemory).toHaveBeenCalledWith(expect.objectContaining({
      context, topicKind: "preference", content: "Use concise replies"
    }));
    expect(result.value.resource.state).toBe("topic");
  });

  it("rejects new Session-scoped memory even when a legacy Session is present", async () => {
    const handler = memorySessionCreate.createHandler({
      memorySessionScopeWriteDisabledError: () => new Error("session_scope_write_disabled")
    });
    await expect(handler.execute({ ...context, sessionId: "session_1" }, memorySessionCreate.input.parse({ content: "Remember this" })))
      .rejects.toThrow("session_scope_write_disabled");
  });
});
