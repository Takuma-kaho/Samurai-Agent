import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceCompletionFileService } from "./workspace-completion-files";
import { WorkspaceCompletionService } from "./workspace-completion-service";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("WorkspaceCompletionService Share import transaction writer", () => {
  it("commits confirmed Room Knowledge through the supplied SQL and makes both body paths recoverable", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "samurai-completion-import-"));
    roots.push(root);
    const state = createImportState(root);
    const service = new WorkspaceCompletionService(state.store as never, new WorkspaceCompletionFileService(root));
    const result = await service.commitImportedShare({
      sql: state.sql as never,
      context: { workspaceId: "workspace_a", accountId: "account_a", operationId: "import_room_a" },
      operationId: "import_room_a",
      scope: { kind: "room", roomId: "room_a" },
      entries: [{ entryId: "entry_a", kind: "knowledge", knowledgeKind: "fact", title: "A fact", content: "The body is confirmed.", files: [] }],
      reservedResourceIds: [{ entryId: "entry_a", resourceId: "resource_a" }]
    });

    expect(result.createdResourceIds).toEqual(["resource_a"]);
    expect(state.batchStatus).toBe("renamed");
    expect(state.resourceRows[0]).toMatchObject({
      id: "resource_a",
      scope_kind: "room",
      room_id: "room_a",
      evidence_state: "confirmed",
      creation_source: "import",
      ai_managed: false,
      current_confirmed_version: 1
    });
    const current = await readFile(path.join(root, "workspaces/workspace_a/files/knowledge/resource_a.md"), "utf8");
    const version = await readFile(path.join(root, "workspaces/workspace_a/files/.versions/resource_a/1.md"), "utf8");
    expect(current).toContain("The body is confirmed.");
    expect(version).toBe(current);
    expect(state.queries.some((query) => query.includes("BEGIN"))).toBe(false);
  });

  it("creates an Agent with the V1 registration function seam and restores Skill support files", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "samurai-completion-import-"));
    roots.push(root);
    const state = createImportState(root, { agent: true });
    const service = new WorkspaceCompletionService(state.store as never, new WorkspaceCompletionFileService(root));
    const support = Buffer.from("#!/bin/sh\nprintf 'ok'\n", "utf8");
    const supportHash = sha256(support);
    const result = await service.commitImportedShare({
      sql: state.sql as never,
      context: { workspaceId: "workspace_a", accountId: "account_a", operationId: "import_agent_a" },
      operationId: "import_agent_a",
      scope: { kind: "agent", agentId: "agent_reserved" },
      agent: { name: "Imported Agent", role: "reviewer", instructions: "Review imported context." },
      entries: [{
        entryId: "entry_skill",
        kind: "skill",
        title: "Check package",
        content: "Run the check.",
        files: [{ path: "scripts/check.sh", content: support, byteSize: support.byteLength, sha256: supportHash }]
      }],
      reservedResourceIds: [{ entryId: "entry_skill", resourceId: "skill_reserved" }]
    });

    expect(result.createdResourceIds).toEqual(["skill_reserved"]);
    expect(state.registeredAgent).toMatchObject({ id: "agent_reserved", backendId: "samurai-native" });
    expect(state.resourceRows[0]).toMatchObject({ scope_kind: "agent", agent_id: "agent_reserved", resource_kind: "skill", ai_managed: false });
    await expect(readFile(path.join(root, "workspaces/workspace_a/files/agents/agent_reserved/skills/skill_reserved/SKILL.md"), "utf8")).resolves.toContain("Run the check.");
    await expect(readFile(path.join(root, "workspaces/workspace_a/files/agents/agent_reserved/skills/skill_reserved/scripts/check.sh"), "utf8")).resolves.toBe(support.toString("utf8"));
  });

  it("rejects Workspace Knowledge and a bad support hash before staging or DB mutation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "samurai-completion-import-"));
    roots.push(root);
    const state = createImportState(root);
    const service = new WorkspaceCompletionService(state.store as never, new WorkspaceCompletionFileService(root));
    await expect(service.commitImportedShare({
      sql: state.sql as never,
      context: { workspaceId: "workspace_a", accountId: "account_a", operationId: "import_workspace_memory" },
      operationId: "import_workspace_memory",
      scope: { kind: "workspace" },
      entries: [{ entryId: "entry_a", kind: "knowledge", knowledgeKind: "fact", title: "Forbidden", content: "No", files: [] }],
      reservedResourceIds: [{ entryId: "entry_a", resourceId: "resource_a" }]
    })).rejects.toMatchObject({ code: "workspace_memory_removed", status: 409 });

    const body = Buffer.from("body", "utf8");
    await expect(service.commitImportedShare({
      sql: state.sql as never,
      context: { workspaceId: "workspace_a", accountId: "account_a", operationId: "import_bad_hash" },
      operationId: "import_bad_hash",
      scope: { kind: "room", roomId: "room_a" },
      entries: [{ entryId: "entry_skill", kind: "skill", title: "Bad", content: "Skill", files: [{ path: "scripts/check.sh", content: body, byteSize: body.byteLength, sha256: "0".repeat(64) }] }],
      reservedResourceIds: [{ entryId: "entry_skill", resourceId: "skill_a" }]
    })).rejects.toMatchObject({ code: "workspace_completion_import_file_hash_mismatch", status: 409 });
    expect(state.queries).toHaveLength(0);
    await expect(readdir(path.join(root, "workspaces"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rolls back staged files when a resource insert fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "samurai-completion-import-"));
    roots.push(root);
    const state = createImportState(root, { failResourceInsert: true });
    const service = new WorkspaceCompletionService(state.store as never, new WorkspaceCompletionFileService(root));
    await expect(service.commitImportedShare({
      sql: state.sql as never,
      context: { workspaceId: "workspace_a", accountId: "account_a", operationId: "import_partial" },
      operationId: "import_partial",
      scope: { kind: "room", roomId: "room_a" },
      entries: [{ entryId: "entry_a", kind: "knowledge", knowledgeKind: "fact", title: "Will fail", content: "No partial", files: [] }],
      reservedResourceIds: [{ entryId: "entry_a", resourceId: "resource_a" }]
    })).rejects.toThrow("resource insert failed");
    await expect(readdir(path.join(root, "workspaces/workspace_a/files/knowledge"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readdir(path.join(root, "workspaces/workspace_a/.completion-staging"))).resolves.toEqual([]);
  });
});

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function createImportState(root: string, options: { agent?: boolean; failResourceInsert?: boolean } = {}) {
  const queries: string[] = [];
  const resourceRows: Array<Record<string, unknown>> = [];
  let batchStatus = "db_committed";
  let registeredAgent: Record<string, unknown> | undefined;
  let resourceInsertCount = 0;
  const sql = {
    query: async (text: string, values: readonly unknown[] = []) => {
      queries.push(text);
      if (text.includes("SELECT id FROM rooms WHERE workspace_id = $1 AND id = $2")) return { rows: [{ id: "room_a" }] };
      if (text.includes("samurai_workspace_is_writable($1) AND samurai_can_room")) return { rows: [{ allowed: true }] };
      if (text.includes("samurai_workspace_is_writable($1) AND samurai_can_workspace")) return { rows: [{ allowed: true }] };
      if (text.includes("SELECT samurai_can_workspace($1, 'admin') AS allowed")) return { rows: [{ allowed: true }] };
      if (text.includes("FROM workspace_completion_policy_rules")) return { rows: [] };
      if (text.includes("SELECT id FROM workspace_completion_resources")) return { rows: [] };
      if (text.includes("SELECT id FROM workspace_agents WHERE workspace_id = $1 AND id = $2 FOR UPDATE")) return { rows: [] };
      if (text.includes("SELECT id, status FROM workspace_agents WHERE workspace_id = $1 AND id = $2")) return { rows: options.agent ? [{ id: "agent_reserved", status: "active" }] : [] };
      if (text.includes("samurai_is_import_session($1)")) return { rows: [{ allowed: true }] };
      if (text.includes("INSERT INTO workspace_completion_file_batches")) return { rows: [] };
      if (text.includes("INSERT INTO workspace_completion_file_batch_entries")) return { rows: [] };
      if (text.includes("INSERT INTO workspace_completion_resources")) {
        resourceInsertCount += 1;
        if (options.failResourceInsert) throw new Error("resource insert failed");
        const row = resourceRow(values);
        resourceRows.push(row);
        return { rows: [row] };
      }
      if (text.includes("INSERT INTO workspace_completion_resource_versions")) return { rows: [versionRow(values)] };
      if (text.includes("INSERT INTO workspace_completion_search_projection")) return { rows: [] };
      if (text.includes("INSERT INTO workspace_completion_skill_files")) return { rows: [] };
      if (text.includes("UPDATE workspace_completion_file_batches SET status = 'renamed'")) {
        batchStatus = "renamed";
        return { rows: [{ id: String(values[1]) }] };
      }
      if (text.includes("SELECT state FROM workspaces WHERE id = $1")) return { rows: [{ state: "active" }] };
      throw new Error(`unexpected query: ${text}`);
    }
  };
  const store = {
    storageRoot: root,
    database: {},
    insertAudit: async () => undefined,
    registerAgentInTransaction: async (_sql: unknown, _context: unknown, input: Record<string, unknown>) => {
      registeredAgent = {
        workspaceId: "workspace_a",
        id: input.id,
        displayName: input.displayName,
        description: input.instructions,
        role: input.role,
        instructions: input.instructions,
        enabled: true,
        backendId: input.backendId,
        status: "active",
        version: 1,
        createdBy: "account_a",
        createdAt: "2026-09-17T00:00:00.000Z",
        updatedAt: "2026-09-17T00:00:00.000Z"
      };
      return registeredAgent;
    }
  };
  return {
    sql,
    store,
    queries,
    resourceRows,
    get batchStatus() { return batchStatus; },
    get registeredAgent() { return registeredAgent; },
    get resourceInsertCount() { return resourceInsertCount; }
  };
}

function resourceRow(values: readonly unknown[]): Record<string, unknown> {
  const scopeKind = String(values[2]);
  const kind = String(values[5]) as "knowledge" | "skill";
  return {
    workspace_id: String(values[0]),
    id: String(values[1]),
    scope_kind: scopeKind,
    room_id: scopeKind === "room" ? "room_a" : null,
    agent_id: scopeKind === "agent" ? "agent_reserved" : null,
    resource_kind: kind,
    knowledge_kind: values[6] ?? null,
    title: String(values[7]),
    evidence_state: values[8],
    lifecycle_state: "active",
    ai_protection: values[9],
    creation_source: values[9],
    ai_managed: values[10],
    version: values[11],
    current_confirmed_version: values[12],
    current_provisional_version: values[13],
    candidate_version: values[14],
    archived_at: null,
    created_by: String(values[15]),
    updated_by: String(values[15]),
    created_at: "2026-09-17T00:00:00.000Z",
    updated_at: "2026-09-17T00:00:00.000Z"
  };
}

function versionRow(values: readonly unknown[]): Record<string, unknown> {
  return {
    workspace_id: String(values[0]),
    id: String(values[1]),
    resource_id: String(values[2]),
    version: values[3],
    parent_version: values[4],
    file_path: String(values[5]),
    content_hash: String(values[6]),
    content_size: values[7],
    evidence_state: values[8],
    lifecycle_state: values[9],
    ai_protection: values[10],
    creation_source: values[11],
    metadata: values[12],
    reason: values[13],
    actor_account_id: String(values[14]),
    created_at: "2026-09-17T00:00:00.000Z",
    file_batch_id: values[15]
  };
}
