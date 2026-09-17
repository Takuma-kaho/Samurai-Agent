import { describe, expect, it, vi } from "vitest";
import { PostgresKnowledgeMemory } from "./postgres-knowledge-memory";

const context = { workspaceId: "workspace_1", accountId: "account_1" };
const timestamp = "2026-09-17T00:00:00.000Z";

function resource(scope: { kind: "room"; roomId: string } | { kind: "agent"; agentId: string }, kind: "knowledge" | "skill" = "knowledge") {
  return {
    workspaceId: "workspace_1",
    id: "resource_1",
    scope,
    kind,
    ...(kind === "knowledge" ? { knowledgeKind: "fact" as const } : {}),
    title: "A resource",
    evidenceState: "confirmed" as const,
    lifecycleState: "active" as const,
    aiProtection: "editable" as const,
    creationSource: "human" as const,
    aiManaged: false,
    version: 1,
    currentConfirmedVersion: 1,
    createdBy: "account_1",
    updatedBy: "account_1",
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function bodyFor(target: ReturnType<typeof resource>, metadata: Record<string, unknown> = { memory: true }) {
  return {
    resource: target,
    version: {
      workspaceId: "workspace_1",
      id: "version_1",
      resourceId: "resource_1",
      version: 1,
      filePath: "rooms/room_1/knowledge/resource_1/1.md",
      contentHash: "hash_1",
      contentSize: 4,
      evidenceState: "confirmed" as const,
      lifecycleState: "active" as const,
      aiProtection: "editable" as const,
      creationSource: "human" as const,
      metadata,
      reason: "human edit",
      actorAccountId: "account_1",
      createdAt: timestamp
    },
    content: "body"
  };
}

function createMemory(target: ReturnType<typeof resource>) {
  const getResourceBody = vi.fn(async () => bodyFor(target));
  const commands = {
    setCompletionResourceArchived: vi.fn(async () => ({ replayed: false, resource: target }))
  };
  const completion = {
    getResourceBody,
    listResourcesPage: vi.fn(async () => ({ items: [target], nextCursor: undefined })),
    searchKnowledge: vi.fn(async () => [])
  };
  return { memory: new PostgresKnowledgeMemory(completion as never, commands as never), completion, commands };
}

describe("PostgresKnowledgeMemory", () => {
  it("requires a Room binding for direct compatibility reads and writes", async () => {
    const fixture = createMemory(resource({ kind: "room", roomId: "room_1" }));

    await expect(fixture.memory.get(context, "resource_1")).rejects.toMatchObject({ code: "knowledge_memory_room_id_required", status: 400 });
    await expect(fixture.memory.archive({ ...context, operationId: "archive_1" }, "resource_1", "archive")).rejects.toMatchObject({ code: "knowledge_memory_room_id_required", status: 400 });
    expect(fixture.completion.getResourceBody).not.toHaveBeenCalled();
    expect(fixture.commands.setCompletionResourceArchived).not.toHaveBeenCalled();
  });

  it("does not project Agent Knowledge or Skill as old Memory", async () => {
    const agentKnowledge = createMemory(resource({ kind: "agent", agentId: "agent_1" }));
    await expect(agentKnowledge.memory.get(context, "resource_1", "room_1")).rejects.toMatchObject({ code: "memory_not_found", status: 404 });
    await expect(agentKnowledge.memory.archive({ ...context, operationId: "archive_agent" }, "resource_1", "archive", "room_1"))
      .rejects.toMatchObject({ code: "memory_not_found", status: 404 });
    expect(agentKnowledge.commands.setCompletionResourceArchived).not.toHaveBeenCalled();

    const agentSkill = createMemory(resource({ kind: "agent", agentId: "agent_1" }, "skill"));
    await expect(agentSkill.memory.get(context, "resource_1", "room_1")).rejects.toMatchObject({ code: "memory_not_found", status: 404 });
  });

  it("keeps the compatibility projection Room-scoped", async () => {
    const fixture = createMemory(resource({ kind: "room", roomId: "room_1" }));
    const page = await fixture.memory.get(context, "resource_1", "room_1");
    expect(page.scope).toEqual({ kind: "room", roomId: "room_1" });
    expect(page.memory.usage_scope).toEqual({ kind: "room", room_id: "room_1" });
  });
});
