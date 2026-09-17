import { describe, expect, it } from "vitest";
import { PostgresWorkspaceShareCompletionImportWriter } from "./share-completion-import-writer";

describe("PostgresWorkspaceShareCompletionImportWriter", () => {
  it("passes Room imports to Completion with the existing SQL transaction", async () => {
    const calls: unknown[] = [];
    const sql = { query: async () => ({ rows: [] }) };
    const completion = {
      commitImportedShare: async (input: unknown) => {
        calls.push(input);
        return { batchId: "completion_batch_a", createdResourceIds: ["resource_a"] };
      }
    };
    const writer = new PostgresWorkspaceShareCompletionImportWriter(completion as never);
    const body = new TextEncoder().encode("Room body");
    const result = await writer.commitRoomKnowledge({
      sql,
      context: { workspaceId: "workspace_a", accountId: "account_a", operationId: "import_a" },
      operationId: "import_a",
      reservedResourceIds: [{ entryId: "entry_a", resourceId: "resource_a" }],
      targetRoomId: "room_a",
      entries: [{ entryId: "entry_a", kind: "knowledge", title: "Room fact", content: "Room body", knowledgeKind: "fact", files: [] }]
    });

    expect(result).toEqual({ createdAgentId: null, createdResourceIds: ["resource_a"] });
    expect(calls[0]).toMatchObject({ sql, operationId: "import_a", scope: { kind: "room", roomId: "room_a" } });
  });

  it("maps Agent Skill support bytes and profile without adding backend or participant data", async () => {
    const calls: unknown[] = [];
    const completion = {
      commitImportedShare: async (input: unknown) => {
        calls.push(input);
        return { batchId: "completion_batch_agent", createdResourceIds: ["skill_a"] };
      }
    };
    const writer = new PostgresWorkspaceShareCompletionImportWriter(completion as never);
    const support = new TextEncoder().encode("echo ok\n");
    const result = await writer.commitAgent({
      sql: { query: async () => ({ rows: [] }) },
      context: { workspaceId: "workspace_a", accountId: "account_a", operationId: "import_agent" },
      operationId: "import_agent",
      reservedResourceIds: [{ entryId: "entry_skill", resourceId: "skill_a" }],
      agentId: "agent_reserved",
      agent: { name: "Imported Agent", role: "reviewer", instructions: "Review context." },
      entries: [{
        entryId: "entry_skill",
        kind: "skill",
        title: "Check",
        content: "Check the workspace.",
        files: [{ path: "scripts/check.sh", content: support, byteSize: support.byteLength, sha256: "hash-from-source" }]
      }]
    });

    expect(result).toEqual({ createdAgentId: "agent_reserved", createdResourceIds: ["skill_a"] });
    expect(calls[0]).toMatchObject({
      operationId: "import_agent",
      scope: { kind: "agent", agentId: "agent_reserved" },
      agent: { name: "Imported Agent", role: "reviewer", instructions: "Review context." }
    });
    const mapped = calls[0] as { entries: Array<{ files: Array<{ path: string; byteSize: number; content: Uint8Array; sha256: string }> }> };
    expect(mapped.entries[0]!.files[0]).toMatchObject({ path: "scripts/check.sh", byteSize: support.byteLength, content: support, sha256: "hash-from-source" });
  });
});
