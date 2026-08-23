import { describe, expect, it, vi } from "vitest";
import type { MemoryFrontmatter, SessionRecord } from "@samurai-agent/core-schemas";
import type { TrustedDomainContext } from "../../definition/index.js";
import memoryArchive, { type MemoryArchivePorts } from "./archive.operation.js";

const now = "2026-01-01T00:00:00.000Z";
const context: TrustedDomainContext = {
  inputSource: "runtime_api",
  workspaceId: "workspace_test",
  actorId: "paired_contact",
  correlationId: "correlation_test",
  sessionId: "session_1"
};
const session: SessionRecord = {
  id: "session_1",
  session_key: "session_1",
  title: "Fixture session",
  ui_locale: "en",
  output_locale: "ja",
  created_at: now,
  updated_at: now
};
const memory: MemoryFrontmatter = {
  id: "memory_1",
  state: "topic",
  topic: "preference",
  source: "message",
  source_locale: "ja",
  content_locale: "ja",
  source_kind: "owner_instruction",
  instruction_authority: "owner",
  confidence: 1,
  created_by: "owner",
  created_at: now,
  updated_at: now,
  related_memories: [],
  conflicts_with: [],
  sensitive_level: "none"
};
const memoryFile = { ...memory, file_path: "memory/memory_1.md" };

function createPorts(overrides: Partial<MemoryArchivePorts> = {}) {
  const saved: Array<Parameters<MemoryArchivePorts["saveMemoryArchiveOperation"]>[0]> = [];
  const updated: Array<Parameters<MemoryArchivePorts["updateMemoryArchiveOperation"]>[0]> = [];
  const archiveMemoryRecord = vi.fn(async () => ({
    before: { frontmatter: memory, file_path: memoryFile.file_path },
    after: { frontmatter: { ...memory, state: "archived" as const }, file_path: memoryFile.file_path },
    content: "Archived memory",
    changed: true
  }));
  const ports: MemoryArchivePorts = {
    getMemorySession: async () => session,
    getMemoryForArchive: async () => memoryFile,
    listMemoryForSession: async () => [memoryFile],
    archiveMemoryRecord,
    memoryArchiveError: (_code, message) => new Error(message),
    memoryResourceRef: (item) => ({ kind: "memory", id: item.id, uri: item.file_path }),
    memoryArchiveCapabilityId: () => "memory",
    saveMemoryArchiveOperation: async (operation) => {
      saved.push({ ...operation });
      return operation;
    },
    updateMemoryArchiveOperation: async (operation) => {
      updated.push({ ...operation });
      return operation;
    },
    emitMemoryArchiveOperation: async () => undefined,
    createMemoryArchiveRollback: async () => ({
      id: "rollback_1",
      operation_id: "operation_1",
      affected_resources: [],
      before_snapshot: {},
      after_snapshot: {},
      reversible: true,
      irreversible_effects: [],
      created_at: now,
      expires_at: "2026-02-01T00:00:00.000Z"
    }),
    rebuildMemoryActivity: async () => [],
    ...overrides
  };
  return { ports, saved, updated, archiveMemoryRecord };
}

describe("memory archive handler", () => {
  it("stores the trusted actor identity and preserves the existing success path", async () => {
    const fixture = createPorts();

    const result = await memoryArchive.createHandler(fixture.ports).execute(
      context,
      memoryArchive.input.parse({ memory_id: memory.id })
    );

    expect(fixture.saved[0]?.actor_identity).toBe("paired_contact");
    expect(fixture.updated.at(-1)).toMatchObject({ status: "completed", result_ref: { id: memory.id } });
    expect(result.value.operation).toMatchObject({ actor_identity: "paired_contact", status: "completed" });
    expect(result.value.memory.state).toBe("archived");
  });

  it("settles the saved operation as failed before rethrowing a later error", async () => {
    const failure = new Error("activity_rebuild_failed");
    const fixture = createPorts({ rebuildMemoryActivity: async () => { throw failure; } });

    await expect(memoryArchive.createHandler(fixture.ports).execute(
      context,
      memoryArchive.input.parse({ memory_id: memory.id })
    )).rejects.toBe(failure);

    expect(fixture.updated.at(-1)).toMatchObject({
      status: "failed",
      error: "activity_rebuild_failed"
    });
    expect(fixture.updated).toHaveLength(1);
  });
});
