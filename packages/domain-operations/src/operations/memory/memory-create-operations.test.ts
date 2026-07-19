import { describe, expect, it, vi } from "vitest";
import type { MemoryFrontmatter, OperationRecord } from "@samurai-agent/core-schemas";
import type { TrustedDomainContext } from "../../definition/index.js";
import memorySessionCreate from "./session/create.operation.js";
import memoryTopicCreate from "./topic/create.operation.js";
import type { MemoryCreatePorts } from "./create-memory.js";

const now = "2026-01-01T00:00:00.000Z";
const context: TrustedDomainContext = { inputSource: "runtime_api", workspaceId: "workspace_test", actorId: "actor_test", correlationId: "correlation_test" };
const contextWithSession: TrustedDomainContext = { ...context, sessionId: "session_1" };
const session = { id: "session_1", ui_locale: "ja", output_locale: "en" } as never;
const operation: OperationRecord = { id: "operation_1", session_id: "session_1", capability_id: "memory", operation: "memory.session.create", actor_identity: "owner", instruction_source: "owner_instruction", instruction_authority: "owner", channel: "web", input_hash: "hash", target_resource_refs: [], proposed_effects: [], status: "completed", created_at: now, updated_at: now };
const memory: MemoryFrontmatter = { id: "memory_1", state: "session", topic: "turn", source: "message", source_locale: "ja", content_locale: "ja", source_kind: "owner_instruction", instruction_authority: "owner", confidence: 1, created_by: "owner", created_at: now, updated_at: now, related_memories: [], conflicts_with: [], sensitive_level: "none" };

function ports() {
  const writeSessionMemory = vi.fn(async () => memory);
  const writeTopicMemory = vi.fn(async () => ({ ...memory, state: "topic" as const, topic: "preference" }));
  const value: MemoryCreatePorts = {
    getMemorySession: async () => session, createMemorySession: async () => session, ensureMemorySession: async () => session,
    memoryCreateError: (message) => new Error(message), createMemoryEnvelope: () => ({ id: "envelope_1" }) as never,
    writeSessionMemory, writeTopicMemory, memoryResourceRef: (item) => ({ kind: "memory", id: item.id, uri: `memory/${item.id}.md` }),
    createMemoryRollback: async () => ({ id: "rollback_1", operation_id: "operation_1", affected_resources: [], before_snapshot: {}, after_snapshot: {}, reversible: true, irreversible_effects: [], created_at: now, expires_at: "2026-02-01T00:00:00.000Z" }), emitMemoryCandidate: async () => undefined,
    runMemoryMutation: async (input) => { const result = await input.execute(operation); return { resource: result.resource, operation, rollbackPoint: result.rollbackPoint, activity: [] }; }
  };
  return { value, writeSessionMemory, writeTopicMemory };
}

describe("memory create handlers", () => {
  it("creates session memory through its recorded mutation", async () => {
    const fixture = ports();
    const result = await memorySessionCreate.createHandler(fixture.value).execute(contextWithSession, memorySessionCreate.input.parse({ content: "Remember this" }));
    expect(fixture.writeSessionMemory).toHaveBeenCalledWith(expect.objectContaining({ id: "envelope_1" }), "Remember this");
    expect(result.value.resource.id).toBe("memory_1");
  });

  it("creates topic memory with the explicit topic kind", async () => {
    const fixture = ports();
    const result = await memoryTopicCreate.createHandler(fixture.value).execute(context, memoryTopicCreate.input.parse({ content: "Use concise replies", topic_kind: "preference" }));
    expect(fixture.writeTopicMemory).toHaveBeenCalledWith(expect.objectContaining({ id: "envelope_1" }), "preference", "Use concise replies");
    expect(result.value.resource.state).toBe("topic");
  });
});
