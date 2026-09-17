import { createServer } from "node:http";
import express, { type Express } from "express";
import { describe, expect, it, vi } from "vitest";
import { PublicCompletionResourceCreateInputSchema, publicManagementContractFor } from "@samurai-agent/domain-api";
import { mountDomainApiV1, type V1Dependencies } from "./domain-api-v1";

const agentResource = {
  workspaceId: "workspace_1",
  id: "agent_resource_1",
  scope: { kind: "agent" as const, agentId: "agent_1" },
  kind: "knowledge" as const,
  knowledgeKind: "fact" as const,
  title: "Agent fact",
  evidenceState: "confirmed" as const,
  lifecycleState: "active" as const,
  aiProtection: "editable" as const,
  creationSource: "human" as const,
  aiManaged: false,
  version: 2,
  createdBy: "account_1",
  updatedBy: "account_1",
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z"
};

const agentVersion = {
  workspaceId: "workspace_1",
  id: "agent_version_2",
  resourceId: "agent_resource_1",
  version: 2,
  filePath: "agents/agent_1/knowledge/agent_resource_1/2.md",
  contentHash: "hash_agent_2",
  contentSize: 11,
  evidenceState: "confirmed" as const,
  lifecycleState: "active" as const,
  aiProtection: "editable" as const,
  creationSource: "human" as const,
  metadata: {},
  reason: "human edit",
  actorAccountId: "account_1",
  createdAt: "2026-09-01T00:00:00.000Z"
};

const workspaceSkill = {
  workspaceId: "workspace_1",
  id: "workspace_skill_1",
  scope: { kind: "workspace" as const },
  kind: "skill" as const,
  title: "Workspace skill",
  evidenceState: "confirmed" as const,
  lifecycleState: "active" as const,
  aiProtection: "editable" as const,
  creationSource: "human" as const,
  aiManaged: false,
  version: 1,
  createdBy: "account_1",
  updatedBy: "account_1",
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z"
};

const workspaceSkillVersion = {
  workspaceId: "workspace_1",
  id: "workspace_skill_version_1",
  resourceId: "workspace_skill_1",
  version: 1,
  filePath: "workspace/skills/workspace_skill_1/1.md",
  contentHash: "hash_workspace_skill_1",
  contentSize: 15,
  evidenceState: "confirmed" as const,
  lifecycleState: "active" as const,
  aiProtection: "editable" as const,
  creationSource: "human" as const,
  metadata: {},
  reason: "human edit",
  actorAccountId: "account_1",
  createdAt: "2026-09-01T00:00:00.000Z"
};

function createAgentScopeApp(options: { resource?: typeof agentResource | typeof workspaceSkill; version?: typeof agentVersion | typeof workspaceSkillVersion } = {}) {
  const app = express();
  app.use(express.json());
  const selectedResource = options.resource ?? agentResource;
  const selectedVersion = options.version ?? agentVersion;
  const createCompletionResource = vi.fn(async () => ({ resource: selectedResource, replayed: false }));
  const updateCompletionResource = vi.fn(async () => ({ resource: { ...selectedResource, version: selectedResource.version + 1 }, replayed: false }));
  const completion = {
    getResourceRefForRoom: vi.fn(),
    listResourcesPage: vi.fn(async () => ({ items: [selectedResource], nextCursor: undefined })),
    searchKnowledgePage: vi.fn(async () => ({ items: [], nextCursor: undefined })),
    getResource: vi.fn(async () => ({ resource: selectedResource, version: selectedVersion })),
    getResourceBody: vi.fn(async () => ({ resource: selectedResource, version: selectedVersion, content: "Agent body" })),
    getSkillDocument: vi.fn(async () => ({ resource: selectedResource, version: selectedVersion, content: "Agent skill" })),
    listResourceVersions: vi.fn(async () => [selectedVersion]),
    listEvidence: vi.fn(async () => [])
  };
  const commands = {
    appendPublicEvent: vi.fn(async () => ({ replayed: true })),
    createCompletionResource,
    updateCompletionResource,
    setCompletionResourceArchived: vi.fn(async () => ({ resource: { ...selectedResource, lifecycleState: "archived" as const }, replayed: false })),
    setCompletionResourceFixed: vi.fn(async () => ({ resource: { ...selectedResource, aiProtection: "fixed" as const }, replayed: false }))
  };
  const io = { on: vi.fn(), sockets: { adapter: { rooms: new Map() }, sockets: new Map() } };
  const dependencies = {
    app,
    io,
    store: {},
    commands,
    artifacts: {},
    generatedSurfaces: {},
    interactionRequests: {},
    realtimeGate: { run: async (_workspaceId: string, callback: () => unknown) => callback() },
    authenticateWorkspace: (_req: unknown, _res: unknown, next: () => void) => next(),
    authenticateAccount: (_req: unknown, _res: unknown, next: () => void) => next(),
    asyncRoute: (handler: (req: never, res: never, next: never) => Promise<void>) => (req: never, res: never, next: never) => { void handler(req, res, next).catch(next); },
    workspaceContext: (req: { params: Record<string, string> }) => ({ workspaceId: req.params.workspaceId!, accountId: "account_1" }),
    operationContext: (req: { params: Record<string, string>; get: (name: string) => string | undefined }) => ({ workspaceId: req.params.workspaceId!, accountId: "account_1", operationId: req.get("x-samurai-operation-id") ?? "operation_default" }),
    organizationContext: () => ({ accountId: "account_1", operationId: "organization_operation", requestId: "request_1" }),
    requestId: () => "request_1",
    runtimeFor: () => ({}),
    completion,
    backendRegistry: { statuses: () => [] }
  } as unknown as V1Dependencies;
  mountDomainApiV1(dependencies);
  app.use((error: { status?: number; code?: string; message?: string }, _req: unknown, res: { status: (status: number) => { json: (body: unknown) => void } }, _next: unknown) => {
    res.status(error.status ?? 500).json({ error: { code: error.code ?? error.message ?? "test_error" } });
  });
  return { app, completion, commands };
}

async function withServer<T>(app: Express, callback: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  try {
    return await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

async function request(baseUrl: string, method: string, path: string, body?: unknown, operationId?: string): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(operationId ? { "x-samurai-operation-id": operationId } : {})
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  return { status: response.status, body: await response.json() };
}

describe("Domain API v1 Completion Agent scope", () => {
  it("dispatches agent resources with exclusive target selectors", async () => {
    const mounted = createAgentScopeApp();
    const input = {
      scope_kind: "agent",
      agent_id: "agent_1",
      kind: "knowledge",
      knowledge_kind: "fact",
      title: "Agent fact",
      content: "Agent body",
      reason: "human edit"
    };
    expect(PublicCompletionResourceCreateInputSchema.safeParse(input).success).toBe(true);
    expect(publicManagementContractFor("completion.resource.create")?.input.safeParse(input).success).toBe(true);
    await withServer(mounted.app, async (baseUrl) => {
      const created = await request(baseUrl, "POST", "/api/v1/workspaces/workspace_1/completion/resources", input, "agent_create");
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      expect(created.body.resource.scope).toEqual({ kind: "agent", agentId: "agent_1" });
      expect(mounted.commands.createCompletionResource).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId: "workspace_1", accountId: "account_1", operationId: "agent_create" }),
        expect.objectContaining({ scope: { kind: "agent", agentId: "agent_1" } })
      );

      const listed = await request(baseUrl, "GET", "/api/v1/workspaces/workspace_1/completion/resources?scope_kind=agent&agent_id=agent_1");
      expect(listed.status).toBe(200);
      expect(listed.body.resources[0].scope).toEqual({ kind: "agent", agentId: "agent_1" });
      expect(mounted.completion.listResourcesPage).toHaveBeenCalledWith(
        { workspaceId: "workspace_1", accountId: "account_1" },
        expect.objectContaining({ scopeKind: "agent", agentId: "agent_1" })
      );

      const detail = await request(baseUrl, "GET", "/api/v1/workspaces/workspace_1/completion/resources/agent_resource_1?scope_kind=agent&agent_id=agent_1");
      expect(detail.status).toBe(200);
      expect(detail.body.current_version).not.toHaveProperty("filePath");
      const body = await request(baseUrl, "GET", "/api/v1/workspaces/workspace_1/completion/resources/agent_resource_1/body?scope_kind=agent&agent_id=agent_1");
      expect(body.status).toBe(200);
      expect(body.body.content).toBe("Agent body");

      const updated = await request(baseUrl, "PATCH", "/api/v1/workspaces/workspace_1/completion/resources/agent_resource_1", {
        ...input, content: "Agent body v2", expected_version: 2
      }, "agent_update");
      expect(updated.status).toBe(201);
      expect(mounted.commands.updateCompletionResource).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId: "workspace_1", accountId: "account_1", operationId: "agent_update" }),
        "agent_resource_1",
        expect.objectContaining({ scope: { kind: "agent", agentId: "agent_1" }, expectedVersion: 2 })
      );

      const archived = await request(baseUrl, "POST", "/api/v1/workspaces/workspace_1/completion/resources/agent_resource_1/archive", { scope_kind: "agent", agent_id: "agent_1", archived: true, expected_version: 2, reason: "Archive" }, "agent_archive");
      expect(archived.status).toBe(201);
      expect(mounted.commands.setCompletionResourceArchived).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId: "workspace_1", accountId: "account_1", operationId: "agent_archive" }),
        expect.objectContaining({ resourceId: "agent_resource_1", expectedVersion: 2 })
      );
      const fixed = await request(baseUrl, "POST", "/api/v1/workspaces/workspace_1/completion/resources/agent_resource_1/fix", { scope_kind: "agent", agent_id: "agent_1", fixed: true, expected_version: 2, reason: "Fix" }, "agent_fix");
      expect(fixed.status).toBe(201);
      expect(mounted.commands.setCompletionResourceFixed).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId: "workspace_1", accountId: "account_1", operationId: "agent_fix" }),
        expect.objectContaining({ resourceId: "agent_resource_1", expectedVersion: 2 })
      );
    });
  });

  it("rejects workspace scope, managed Agent input, mixed IDs, and unknown keys before Core writes", async () => {
    const mounted = createAgentScopeApp();
    await withServer(mounted.app, async (baseUrl) => {
      const base = { kind: "knowledge", knowledge_kind: "fact", title: "Agent fact", content: "Agent body", reason: "human edit" };
      const workspace = await request(baseUrl, "POST", "/api/v1/workspaces/workspace_1/completion/resources", { ...base, scope_kind: "workspace" }, "workspace_memory");
      expect(workspace.status).toBe(409);
      expect(workspace.body.error.code).toBe("workspace_memory_removed");
      const aiManaged = await request(baseUrl, "POST", "/api/v1/workspaces/workspace_1/completion/resources", { ...base, scope_kind: "agent", agent_id: "agent_1", ai_managed: true }, "agent_ai");
      expect(aiManaged.status).toBe(422);
      expect(aiManaged.body.error.code).toBe("workspace_completion_agent_ai_managed_forbidden");
      const mixed = await request(baseUrl, "POST", "/api/v1/workspaces/workspace_1/completion/resources", { ...base, scope_kind: "agent", agent_id: "agent_1", room_id: "room_1" }, "agent_mixed");
      expect(mixed.status).toBe(400);
      const unknown = await request(baseUrl, "POST", "/api/v1/workspaces/workspace_1/completion/resources", { ...base, scope_kind: "agent", agent_id: "agent_1", unknown: true }, "agent_unknown");
      expect(unknown.status).toBe(400);
      expect(mounted.commands.createCompletionResource).not.toHaveBeenCalled();
      const contextMixed = await request(baseUrl, "POST", "/api/v1/workspaces/workspace_1/domain/operations/completion.resource.create", {
        context: { room_id: "room_1" }, input: { ...base, scope_kind: "agent", agent_id: "agent_1" }
      }, "agent_context_mixed");
      expect(contextMixed.status).toBe(400);
      expect(contextMixed.body.error.code).toBe("completion_scope_targets_exclusive");
      expect(mounted.commands.createCompletionResource).not.toHaveBeenCalled();

      const mixedList = await request(baseUrl, "GET", "/api/v1/workspaces/workspace_1/completion/resources?scope_kind=agent&agent_id=agent_1&room_id=room_1");
      expect(mixedList.status).toBe(400);
      const workspaceList = await request(baseUrl, "GET", "/api/v1/workspaces/workspace_1/completion/resources?scope_kind=workspace&kind=knowledge");
      expect(workspaceList.status).toBe(409);
      expect(workspaceList.body.error.code).toBe("workspace_memory_removed");
      expect(mounted.completion.listResourcesPage).not.toHaveBeenCalled();
    });
  });

  it("keeps Workspace Skill available while rejecting Workspace Knowledge", async () => {
    const mounted = createAgentScopeApp({ resource: workspaceSkill, version: workspaceSkillVersion });
    const input = { scope_kind: "workspace", kind: "skill", title: "Workspace skill", content: "# Skill", reason: "human edit" };
    expect(PublicCompletionResourceCreateInputSchema.safeParse(input).success).toBe(true);
    await withServer(mounted.app, async (baseUrl) => {
      const created = await request(baseUrl, "POST", "/api/v1/workspaces/workspace_1/completion/resources", input, "workspace_skill_create");
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      expect(created.body.resource.scope).toEqual({ kind: "workspace" });

      const listed = await request(baseUrl, "GET", "/api/v1/workspaces/workspace_1/completion/resources?scope_kind=workspace&kind=skill");
      expect(listed.status).toBe(200);
      expect(listed.body.resources[0].scope).toEqual({ kind: "workspace" });
      expect(mounted.completion.listResourcesPage).toHaveBeenCalledWith(
        { workspaceId: "workspace_1", accountId: "account_1" },
        expect.objectContaining({ scopeKind: "workspace", kind: "skill" })
      );

      const detail = await request(baseUrl, "GET", "/api/v1/workspaces/workspace_1/completion/resources/workspace_skill_1?scope_kind=workspace&kind=skill");
      expect(detail.status).toBe(200);
      const body = await request(baseUrl, "GET", "/api/v1/workspaces/workspace_1/completion/resources/workspace_skill_1/body?scope_kind=workspace&kind=skill");
      expect(body.status).toBe(200);
    });
  });
});
