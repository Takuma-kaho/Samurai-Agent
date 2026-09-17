import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  accountIdFromPublicKey,
  canonicalJson,
  type WorkspaceCompletionResource,
  type WorkspaceShareManifest
} from "@samurai-agent/workspace-server";
import {
  PostgresWorkspaceShareAuthorization,
  PostgresWorkspaceShareDatabase,
  PostgresWorkspaceShareImportCommitter,
  PostgresWorkspaceShareSource,
  WorkspaceShareHttpImportTransport,
  type WorkspaceShareHttpClient,
  type WorkspaceShareImportWriter,
  type WorkspaceShareRlsContext
} from "./share-postgres";

const workspaceId = "workspace-1";
const accountId = "account-1";
const sourceOrigin = "https://source.example/";
const targetOrigin = "https://target.example/";
const locator = "L".repeat(43);

describe("PostgreSQL Workspace Share adapters", () => {
  it("passes only trusted RLS fields and keeps operation IDs out of import context", async () => {
    const contexts: unknown[] = [];
    const database = new PostgresWorkspaceShareDatabase({
      withContext: vi.fn(async (context: WorkspaceShareRlsContext, action: (sql: never) => Promise<unknown>) => {
        contexts.push(context);
        return action({} as never);
      })
    });

    await database.withContext({ accountId, workspaceId, operationId: "operation-1" }, async () => "ok");
    await database.withImportContext({ accountId, workspaceId, operationId: "operation-2" }, "import-1", async () => "ok");

    expect(contexts).toEqual([
      { accountId, workspaceId },
      { accountId, workspaceId, importId: "import-1" }
    ]);
  });

  it("exports only confirmed Room Knowledge and selected Agent resources/files", async () => {
    const skillBytes = new TextEncoder().encode("#!/bin/sh\necho skill\n");
    const completion = {
      getResourceBody: vi.fn(async (_context: unknown, resourceId: string, version: number) => {
        const resource = resourceFor(resourceId, resourceId === "agent-skill" ? "skill" : "knowledge", resourceId.startsWith("room") ? "room" : "agent");
        return {
          resource,
          version: {
            version,
            contentHash: sha256(resourceId),
            evidenceState: "confirmed" as const,
            lifecycleState: "active" as const
          },
          content: `content:${resourceId}`
        };
      }),
      listSkillFiles: vi.fn(async () => [{
        relativePath: "scripts/run.sh",
        resourceVersion: 2,
        contentHash: sha256(skillBytes),
        contentSize: skillBytes.byteLength
      }]),
      getSkillFile: vi.fn(async () => ({
        file: {
          relativePath: "scripts/run.sh",
          resourceVersion: 2,
          contentHash: sha256(skillBytes),
          contentSize: skillBytes.byteLength
        },
        content: skillBytes
      }))
    };
    const source = new PostgresWorkspaceShareSource({
      completion: completion as never,
      agents: { getAgent: vi.fn(async () => ({ workspaceId, id: "agent-1", displayName: "Portable Agent", role: "Reviewer", instructions: "Review only", status: "active" })) } as never
    });

    const room = await source.snapshot({
      context: { workspaceId, accountId },
      sourceKind: "room_knowledge",
      sourceId: "room-1",
      resourceRefs: [{ id: "room-knowledge", version: 2 }]
    });
    expect(room.manifest.entries[0]).toMatchObject({ kind: "knowledge", knowledge_kind: "fact", files: [] });
    expect(room.manifest.entries[0]?.entry_id).not.toContain("room-knowledge");
    expect(room.manifest).not.toHaveProperty("evidence");
    expect(room.manifest).not.toHaveProperty("source_path");

    const agent = await source.snapshot({
      context: { workspaceId, accountId },
      sourceKind: "agent",
      sourceId: "agent-1",
      resourceRefs: [{ id: "agent-knowledge", version: 2 }, { id: "agent-skill", version: 2 }]
    });
    expect(agent.manifest.agent).toEqual({ name: "Portable Agent", role: "Reviewer", instructions: "Review only" });
    expect(agent.manifest.entries).toHaveLength(2);
    expect(agent.manifest.entries[1]?.files[0]).toMatchObject({ path: "scripts/run.sh", encoding: "base64" });
    expect(agent.manifest).not.toHaveProperty("backend");
    expect(agent.manifest).not.toHaveProperty("credentials");
    expect(agent.manifest).not.toHaveProperty("participants");
  });

  it("rejects Workspace-scoped resources and AI-managed Agent resources", async () => {
    const workspaceResource = resourceFor("workspace-knowledge", "knowledge", "workspace");
    const aiManagedResource = { ...resourceFor("agent-ai", "knowledge", "agent"), aiManaged: true };
    const completion = {
      getResourceBody: vi.fn(async (_context: unknown, resourceId: string, version: number) => ({
        resource: resourceId === "workspace-knowledge" ? workspaceResource : aiManagedResource,
        version: { version, contentHash: sha256(resourceId), evidenceState: "confirmed" as const, lifecycleState: "active" as const },
        content: "content"
      })),
      listSkillFiles: vi.fn(async () => []),
      getSkillFile: vi.fn()
    };
    const source = new PostgresWorkspaceShareSource({
      completion: completion as never,
      agents: { getAgent: vi.fn(async () => ({ workspaceId, id: "agent-1", displayName: "Agent", role: "Role", instructions: "Instructions", status: "active" })) } as never
    });

    await expect(source.snapshot({
      context: { workspaceId, accountId },
      sourceKind: "room_knowledge",
      sourceId: "room-1",
      resourceRefs: [{ id: "workspace-knowledge", version: 2 }]
    })).rejects.toMatchObject({ code: "workspace_share_source_version_invalid", status: 409 });
    await expect(source.snapshot({
      context: { workspaceId, accountId },
      sourceKind: "agent",
      sourceId: "agent-1",
      resourceRefs: [{ id: "agent-ai", version: 2 }]
    })).rejects.toMatchObject({ code: "workspace_share_source_scope_invalid", status: 409 });
  });

  it("resolves Room/manage and Agent/admin authorization through SQL", async () => {
    const queries: string[] = [];
    const sql = {
      query: vi.fn(async <T>(text: string) => {
        queries.push(text);
        return rowResult<T>([{ allowed: true } as T]);
      })
    };
    const database = {
      withContext: vi.fn(async (_context: unknown, action: (value: typeof sql) => Promise<unknown>) => action(sql))
    };
    const authorization = new PostgresWorkspaceShareAuthorization(database as never);

    await expect(authorization.authorize({ action: "source_manage", workspaceId, accountId, sourceKind: "room_knowledge", sourceId: "room-1" })).resolves.toBe(true);
    await expect(authorization.authorize({ action: "import_target", workspaceId, accountId, sourceKind: "room_knowledge", targetRoomId: "room-1" })).resolves.toBe(true);
    await expect(authorization.authorize({ action: "import_target", workspaceId, accountId, sourceKind: "agent" })).resolves.toBe(true);
    await expect(authorization.authorize({ action: "recipient_claim", workspaceId, accountId })).resolves.toBe(true);
    expect(queries.some((query) => query.includes("samurai_can_room") && query.includes("'manage'"))).toBe(true);
    expect(queries.some((query) => query.includes("samurai_can_workspace") && query.includes("'admin'"))).toBe(true);
    expect(queries.some((query) => query.includes("workspace_memberships"))).toBe(false);
  });

  it("verifies signed delegation, fixed HTTPS endpoint, response origin and content hash", async () => {
    const manifest: WorkspaceShareManifest = {
      format_version: 1,
      kind: "room_knowledge",
      title: "Room copy",
      entries: [{ entry_id: "entry-1", kind: "knowledge", title: "Fact", content: "copy", knowledge_kind: "fact", files: [] }]
    };
    const bytes = new TextEncoder().encode(canonicalJson(manifest));
    const contentHash = sha256(bytes);
    const delegation = createDelegation({ contentHash });
    let request: { url: string; body: unknown; resolvedAddress?: string } | undefined;
    const client: WorkspaceShareHttpClient = {
      postJson: vi.fn(async (input) => {
        request = { url: input.url, body: input.body, resolvedAddress: input.resolvedAddress };
        return { status: 200, url: input.url, headers: { get: (name: string) => name === "x-samurai-content-sha256" ? contentHash : null }, bytes };
      })
    };
    const transport = new WorkspaceShareHttpImportTransport({
      client,
      targetOrigin,
      allowedSourceOrigins: [sourceOrigin],
      resolveHostname: async () => ["203.0.113.7"],
      now: () => new Date("2026-09-17T00:01:00.000Z")
    });

    const result = await transport.fetch({ sourceOrigin, locator, claimId: "claim-1", contentHash, delegation });
    expect(result).toMatchObject({ kind: "room_knowledge", manifest });
    expect(request?.url).toBe(`${sourceOrigin}api/v1/shares/${locator}/claims/claim-1/content`);
    expect(request?.body).toEqual({ delegation });
    expect(request?.resolvedAddress).toBe("203.0.113.7");

    await expect(transport.fetch({ sourceOrigin, locator, claimId: "claim-1", contentHash: "b".repeat(64), delegation }))
      .rejects.toMatchObject({ code: "workspace_share_delegation_mismatch", status: 403 });
  });

  it("rejects private source addresses unless the origin is explicitly allowlisted", async () => {
    const bytes = new TextEncoder().encode(canonicalJson(manifestFor("room_knowledge", "entry-private")));
    const privateOrigin = "https://private.example/";
    const delegation = createDelegation({ contentHash: sha256(bytes), sourceOrigin: privateOrigin });
    const client: WorkspaceShareHttpClient = {
      postJson: vi.fn(async () => ({ status: 200, url: `${privateOrigin}api/v1/shares/${locator}/claims/claim-1/content`, headers: { get: () => null }, bytes }))
    };
    const transport = new WorkspaceShareHttpImportTransport({
      client,
      resolveHostname: async () => ["127.0.0.1"],
      now: () => new Date("2026-09-17T00:01:00.000Z")
    });

    await expect(transport.fetch({ sourceOrigin: privateOrigin, locator, claimId: "claim-1", contentHash: sha256(bytes), delegation }))
      .rejects.toMatchObject({ code: "workspace_share_origin_not_allowed", status: 403 });
    expect(client.postJson).not.toHaveBeenCalled();
  });

  it("stops an unbounded chunked response before parsing or hashing it", async () => {
    const bytes = new TextEncoder().encode("x".repeat(128));
    const contentHash = sha256(bytes);
    const delegation = createDelegation({ contentHash });
    const client: WorkspaceShareHttpClient = {
      postJson: vi.fn(async () => ({
        status: 200,
        url: `${sourceOrigin}api/v1/shares/${locator}/claims/claim-1/content`,
        headers: { get: () => null },
        bytes
      }))
    };
    const transport = new WorkspaceShareHttpImportTransport({
      client,
      maxBytes: 16,
      allowedSourceOrigins: [sourceOrigin],
      resolveHostname: async () => ["203.0.113.8"],
      now: () => new Date("2026-09-17T00:01:00.000Z")
    });
    await expect(transport.fetch({ sourceOrigin, locator, claimId: "claim-1", contentHash, delegation }))
      .rejects.toMatchObject({ code: "workspace_share_content_too_large", status: 413 });
    expect(client.postJson).toHaveBeenCalledWith(expect.objectContaining({ resolvedAddress: "203.0.113.8", maxBytes: 16 }));
  });

  it("commits through the injected transaction writer and preserves reserved IDs", async () => {
    let targetRow: { target_room_id: string | null; reserved_agent_id: string | null; recipient_account_id: string; kind: "room_knowledge" | "agent"; status: string; phase: string } = {
      target_room_id: "room-target",
      reserved_agent_id: null,
      recipient_account_id: accountId,
      kind: "room_knowledge",
      status: "staging",
      phase: "fetch"
    };
    const query = vi.fn(async <T>() => rowResult<T>([targetRow as T]));
    const writer: WorkspaceShareImportWriter = {
      commitRoomKnowledge: vi.fn(async () => ({ createdAgentId: null, createdResourceIds: ["resource-room"] })),
      commitAgent: vi.fn(async () => ({ createdAgentId: "agent-target", createdResourceIds: ["resource-agent"] }))
    };
    const committer = new PostgresWorkspaceShareImportCommitter({} as never, writer);
    const sql = { query } as never;

    const roomManifest = manifestFor("room_knowledge", "entry-room");
    await expect(committer.commit({
      sql,
      context: { workspaceId, accountId, operationId: "operation-room" },
      kind: "room_knowledge",
      manifest: roomManifest,
      reservedAgentId: null,
      reservedResourceIds: [{ entryId: "entry-room", resourceId: "resource-room" }]
    })).resolves.toEqual({ createdAgentId: null, createdResourceIds: ["resource-room"] });
    expect(writer.commitRoomKnowledge).toHaveBeenCalledWith(expect.objectContaining({ targetRoomId: "room-target", operationId: "operation-room" }));

    targetRow = { ...targetRow, target_room_id: null, reserved_agent_id: "agent-target", kind: "agent" };
    const agentManifest = manifestFor("agent", "entry-agent");
    agentManifest.agent = { name: "Imported Agent", role: "Reviewer", instructions: "Review" };
    await expect(committer.commit({
      sql,
      context: { workspaceId, accountId, operationId: "operation-agent" },
      kind: "agent",
      manifest: agentManifest,
      reservedAgentId: "agent-target",
      reservedResourceIds: [{ entryId: "entry-agent", resourceId: "resource-agent" }]
    })).resolves.toEqual({ createdAgentId: "agent-target", createdResourceIds: ["resource-agent"] });
    expect(writer.commitAgent).toHaveBeenCalledWith(expect.objectContaining({ agentId: "agent-target", agent: agentManifest.agent }));
    expect(writer.commitAgent).not.toHaveBeenCalledWith(expect.objectContaining({ roomId: expect.anything(), member: expect.anything(), defaultAgentId: expect.anything() }));

    await expect(committer.commit({
      sql,
      context: { workspaceId, accountId, operationId: "operation-agent" },
      kind: "agent",
      manifest: agentManifest,
      reservedAgentId: "agent-target",
      reservedResourceIds: [{ entryId: "wrong-entry", resourceId: "resource-agent" }]
    })).rejects.toMatchObject({ code: "workspace_share_import_resource_mapping_invalid", status: 409 });
  });
});

function resourceFor(id: string, kind: "knowledge" | "skill", scopeKind: "workspace" | "room" | "agent"): WorkspaceCompletionResource {
  return {
    workspaceId,
    id,
    scope: scopeKind === "room" ? { kind: "room", roomId: "room-1" } : scopeKind === "agent" ? { kind: "agent", agentId: "agent-1" } : { kind: "workspace" },
    kind,
    ...(kind === "knowledge" ? { knowledgeKind: "fact" as const } : {}),
    title: id,
    evidenceState: "confirmed",
    lifecycleState: "active",
    aiProtection: "editable",
    creationSource: "human",
    aiManaged: false,
    version: 2,
    currentConfirmedVersion: 2,
    createdBy: accountId,
    updatedBy: accountId,
    createdAt: "2026-09-17T00:00:00.000Z",
    updatedAt: "2026-09-17T00:00:00.000Z"
  };
}

function manifestFor(kind: "room_knowledge" | "agent", entryId: string): WorkspaceShareManifest {
  return {
    format_version: 1,
    kind,
    title: kind === "agent" ? "Agent" : "Room",
    entries: [{ entry_id: entryId, kind: "knowledge", title: "Fact", content: "content", knowledge_kind: "fact", files: [] }]
  };
}

function createDelegation(input: { contentHash: string; sourceOrigin?: string; targetOrigin?: string }) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyValue = `base64:${publicKey.export({ format: "der", type: "spki" }).toString("base64")}`;
  const payload = {
    version: 1 as const,
    source_origin: input.sourceOrigin ?? sourceOrigin,
    share_id: "share-1",
    claim_id: "claim-1",
    recipient_account_id: accountIdFromPublicKey(publicKeyValue),
    target_origin: input.targetOrigin ?? targetOrigin,
    target_workspace_id: workspaceId,
    operation_id: "operation-1",
    content_hash: input.contentHash,
    issued_at: "2026-09-17T00:00:00.000Z",
    expires_at: "2026-09-17T00:05:00.000Z"
  };
  return {
    payload,
    public_key: publicKeyValue,
    signature: sign(null, Buffer.from(`samurai-share-import-v1\n${canonicalJson(payload)}`), privateKey).toString("base64url")
  };
}

function rowResult<T>(rows: T[] = []) {
  return { rows, rowCount: rows.length, command: "SELECT", oid: 0, fields: [] } as never;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
