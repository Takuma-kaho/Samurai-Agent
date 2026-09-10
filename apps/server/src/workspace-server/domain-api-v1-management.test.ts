import { createServer, type Server as HttpServer } from "node:http";
import express, { type Express } from "express";
import { describe, expect, it, vi } from "vitest";
import { DomainApiCatalogSchema } from "@samurai-agent/domain-api";
import { mountDomainApiV1, type V1Dependencies } from "./domain-api-v1";

const resource = {
  workspaceId: "workspace_1",
  id: "resource_1",
  scope: { kind: "room" as const, roomId: "room_1" },
  kind: "knowledge" as const,
  knowledgeKind: "fact" as const,
  title: "A fact",
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

const workspaceResource = {
  ...resource,
  id: "resource_workspace",
  scope: { kind: "workspace" as const },
  title: "Workspace fact"
};

const version = {
  workspaceId: "workspace_1",
  id: "version_1",
  resourceId: "resource_1",
  version: 1,
  filePath: "completion/resource_1/1.md",
  contentHash: "hash_1",
  contentSize: 6,
  evidenceState: "confirmed" as const,
  lifecycleState: "active" as const,
  aiProtection: "editable" as const,
  creationSource: "human" as const,
  metadata: {},
  reason: "human edit",
  actorAccountId: "account_1",
  createdAt: "2026-09-01T00:00:00.000Z"
};

const skillResource = {
  ...resource,
  id: "skill_1",
  kind: "skill" as const,
  knowledgeKind: undefined,
  title: "A skill"
};

const skillVersion = {
  ...version,
  id: "skill_version_1",
  resourceId: "skill_1",
  filePath: "completion/skill_1/1/SKILL.md",
  contentHash: "skill_hash_1",
  contentSize: 7
};

const settings = {
  ui_locale: "ja" as const,
  output_locale: "ja" as const,
  memory_capture_mode: "auto" as const,
  knowledge_wiki_capture_mode: "auto" as const,
  skill_capture_mode: "auto" as const,
  learning_enabled: true,
  learning_budget_ratio: 0.1,
  learning_budget_window_days: 7,
  external_provider_role: "assistive" as const,
  updated_at: "2026-09-01T00:00:00.000Z"
};

const learningSettings = {
  workspaceId: "workspace_1",
  id: "learning_settings_room_1",
  scope: { kind: "room" as const, roomId: "room_1" },
  enabled: true,
  currencyUsed: 0,
  tokensUsed: 0,
  currencyReserved: 0,
  tokensReserved: 0,
  version: 1,
  updatedBy: "account_1",
  updatedAt: "2026-09-01T00:00:00.000Z"
};

const job = {
  id: "job_1",
  title: "Review",
  kind: "custom_instruction",
  status: "enabled",
  schedule: "once",
  target_instruction: "Review the Room.",
  delivery_target: {},
  workspace_id: "workspace_1",
  room_id: "room_1",
  authorization_state: "ready",
  authorized_at: "2026-09-01T00:00:00.000Z",
  management_state: "allowed",
  created_operation_id: "job_create",
  failure_count: 0,
  max_attempts: 3,
  created_at: "2026-09-01T00:00:00.000Z",
  updated_at: "2026-09-01T00:00:00.000Z"
};

function createManagementApp() {
  const app = express();
  app.use(express.json());
  const appendPublicEvent = vi.fn(async () => ({ replayed: true }));
  const createCompletionResource = vi.fn(async () => ({ resource, replayed: false }));
  const updateCompletionResource = vi.fn(async () => ({ resource: { ...resource, version: 2 }, replayed: false }));
  const completion = {
    getResourceRefForRoom: vi.fn(),
    listResourcesPage: vi.fn(async (_context: unknown, input: { kind?: string; cursor?: string; limit?: number }) => {
      if (input.limit === 1 && input.kind !== "skill") {
        if (input.cursor === "cursor_1") return { items: [workspaceResource], nextCursor: "cursor_2" };
        if (input.cursor === "cursor_2") return { items: [resource], nextCursor: "cursor_3" };
        return { items: [], nextCursor: undefined };
      }
      return {
        items: input.kind === "skill" ? [skillResource] : [resource],
        nextCursor: "cursor_2"
      };
    }),
    searchKnowledgePage: vi.fn(async () => ({ items: [{ ...resource, rank: 1 }], nextCursor: "cursor_2" })),
    getResource: vi.fn(async (_context: unknown, resourceId: string) => resourceId === "skill_1"
      ? { resource: skillResource, version: skillVersion }
      : { resource, version }),
    getResourceBody: vi.fn(async (_context: unknown, resourceId: string) => resourceId === "skill_1"
      ? { resource: skillResource, version: skillVersion, content: "# Skill" }
      : { resource, version, content: "The body" }),
    getSkillDocument: vi.fn(async () => ({ resource: skillResource, version: skillVersion, content: "# Skill" })),
    listResourceVersions: vi.fn(async () => [version]),
    listEvidence: vi.fn(async () => [])
  };
  const runtimeSettings = {
    get: vi.fn(async () => settings),
    patch: vi.fn(async () => ({ settings: { ...settings, learning_enabled: false }, replayed: false }))
  };
  const learning = {
    getSettingsLayers: vi.fn(async () => ({ effective: learningSettings, room: learningSettings })),
    updateSettings: vi.fn(async () => ({ settings: learningSettings, replayed: false }))
  };
  const automation = {
    createJob: vi.fn(async () => ({ job, replayed: false })),
    listJobs: vi.fn(async () => [job]),
    listRuns: vi.fn(async () => []),
    listRunsForRoom: vi.fn(async () => []),
    runNow: vi.fn(async () => ({ job, replayed: false })),
    setManagementState: vi.fn(async () => ({ job: { ...job, management_state: "manager_stopped", status: "disabled" }, replayed: false }))
  };
  const commands = {
    appendPublicEvent,
    createCompletionResource,
    updateCompletionResource,
    setCompletionResourceArchived: vi.fn(async () => ({ resource: { ...resource, lifecycleState: "archived" }, replayed: false })),
    setCompletionResourceFixed: vi.fn(async () => ({ resource: { ...resource, aiProtection: "fixed" }, replayed: false }))
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
    runtimeSettings,
    learning,
    automation,
    backendRegistry: { statuses: () => [] }
  } as unknown as V1Dependencies;
  mountDomainApiV1(dependencies);
  app.use((error: { status?: number; code?: string }, _req: unknown, res: { status: (status: number) => { json: (body: unknown) => void } }, _next: unknown) => {
    res.status(error.status ?? 500).json({ error: { code: error.code ?? error.message ?? "test_error" } });
  });
  return {
    app,
    appendPublicEvent,
    createCompletionResource,
    updateCompletionResource,
    completion,
    runtimeSettings,
    learning,
    automation,
    commands
  };
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

describe("Domain API v1 management boundary", () => {
  it("advertises and dispatches the same Completion service through GET/POST/PATCH", async () => {
    const mounted = createManagementApp();
    await withServer(mounted.app, async (baseUrl) => {
      const catalog = await request(baseUrl, "GET", "/api/v1/workspaces/workspace_1/domain/catalog");
      expect(catalog.status).toBe(200);
      const parsedCatalog = DomainApiCatalogSchema.parse(catalog.body);
      expect(parsedCatalog.contracts.find((contract) => contract.id === "completion.resource.list")).toEqual(expect.objectContaining({
        kind: "query",
        input_schema: expect.objectContaining({ type: "object" }),
        output_schema: expect.objectContaining({ type: "object" })
      }));
      expect(parsedCatalog.events.find((event) => event.event_type === "completion.resource.updated")).toEqual(expect.objectContaining({
        payload_schema: expect.objectContaining({ type: "object" })
      }));
      const contracts = catalog.body.contracts as Array<{ id: string }>;
      expect(contracts.map((contract) => contract.id)).toEqual(expect.arrayContaining([
        "completion.resource.list", "completion.resource.view", "completion.resource.body",
        "completion.resource.create", "completion.resource.update", "completion.resource.archive", "completion.resource.fix",
        "settings.view", "settings.patch", "learning.settings.view", "learning.settings.patch",
        "automation.job.list", "automation.run.list", "automation.job.save", "automation.job.manager_stop", "automation.job.manager_resume", "automation.job.run_now"
      ]));
      for (const [operationId, fields] of [
        ["settings.patch", ["learning_enabled"]],
        ["automation.job.save", ["title", "target_instruction"]],
        ["automation.job.manager_stop", ["job_id", "note"]],
        ["automation.job.manager_resume", ["job_id"]],
        ["automation.job.run_now", ["room_id", "kind"]]
      ] as const) {
        const contract = parsedCatalog.contracts.find((candidate) => candidate.id === operationId);
        expect(contract).toEqual(expect.objectContaining({ kind: "command", idempotency: "required" }));
        const properties = (contract?.input_schema as { properties?: Record<string, unknown> }).properties ?? {};
        for (const field of fields) expect(properties).toHaveProperty(field);
      }
      expect(catalog.body.events.map((event: { event_type: string }) => event.event_type)).toEqual(expect.arrayContaining([
        "completion.resource.created", "workspace.settings.changed", "learning.settings.updated", "automation.job.management_changed"
      ]));

      const listed = await request(baseUrl, "GET", "/api/v1/workspaces/workspace_1/completion/resources?scope_kind=room&room_id=room_1&include_archived=true&cursor=cursor_1", undefined, "list_1");
      expect(listed.status).toBe(200);
      expect(listed.body.resources.map((entry: { id: string }) => entry.id)).toEqual(expect.arrayContaining(["resource_workspace", "resource_1"]));
      expect(listed.body.resources.find((entry: { id: string }) => entry.id === "resource_workspace")).toMatchObject({ scope: { kind: "workspace" } });
      expect(listed.body.resources.find((entry: { id: string }) => entry.id === "resource_1")).toMatchObject({ scope: { kind: "room", roomId: "room_1" } });
      expect(listed.body).not.toHaveProperty("next_cursor");
      expect(mounted.completion.listResourcesPage).toHaveBeenCalledWith(
        { workspaceId: "workspace_1", accountId: "account_1" },
        expect.objectContaining({ roomId: "room_1", includeArchived: true, cursor: "cursor_1", limit: 1 })
      );

      const detail = await request(baseUrl, "GET", "/api/v1/workspaces/workspace_1/completion/resources/resource_1?room_id=room_1&versions_limit=10&evidence_limit=10");
      expect(detail.status).toBe(200);
      expect(detail.body).toMatchObject({
        resource: { id: "resource_1", scope: { roomId: "room_1" } },
        current_version: { resourceId: "resource_1", version: 1, contentHash: "hash_1" },
        versions: [{ resourceId: "resource_1", version: 1 }],
        evidence: []
      });
      expect(detail.body.current_version).not.toHaveProperty("filePath");

      const body = await request(baseUrl, "GET", "/api/v1/workspaces/workspace_1/completion/resources/resource_1/body?room_id=room_1&kind=knowledge&version=1");
      expect(body.status).toBe(200);
      expect(body.body).toMatchObject({ resource: { id: "resource_1", kind: "knowledge" }, version: { resourceId: "resource_1", version: 1 }, content: "The body" });

      const skills = await request(baseUrl, "GET", "/api/v1/workspaces/workspace_1/completion/skills?room_id=room_1&include_archived=true&cursor=cursor_1", undefined, "skill_list");
      expect(skills.status).toBe(200);
      expect(skills.body).toMatchObject({ skills: [{ id: "skill_1", kind: "skill" }], next_cursor: "cursor_2" });
      expect(mounted.completion.listResourcesPage).toHaveBeenCalledWith(
        { workspaceId: "workspace_1", accountId: "account_1" },
        expect.objectContaining({ roomId: "room_1", kind: "skill", includeArchived: true, cursor: "cursor_1" })
      );

      const skill = await request(baseUrl, "GET", "/api/v1/workspaces/workspace_1/completion/skills/skill_1");
      expect(skill.status).toBe(200);
      expect(skill.body).toMatchObject({ resource: { id: "skill_1", kind: "skill" }, version: { resourceId: "skill_1" }, content: "# Skill" });
      expect(mounted.completion.getSkillDocument).toHaveBeenCalledWith(
        { workspaceId: "workspace_1", accountId: "account_1" },
        "skill_1",
        undefined
      );

      const input = { scope_kind: "room", room_id: "room_1", kind: "knowledge", knowledge_kind: "fact", title: "A fact", content: "The body", reason: "human edit" };
      const created = await request(baseUrl, "POST", "/api/v1/workspaces/workspace_1/completion/resources", input, "completion_create");
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({ resource: { id: "resource_1" }, replayed: false });

      const updated = await request(baseUrl, "PATCH", "/api/v1/workspaces/workspace_1/completion/resources/resource_1", { ...input, content: "The updated body", expected_version: 1 }, "completion_update");
      expect(updated.status).toBe(201);
      expect(updated.body).toMatchObject({ resource: { id: "resource_1", version: 2 }, replayed: false });

      const archived = await request(baseUrl, "POST", "/api/v1/workspaces/workspace_1/completion/resources/resource_1/archive", { room_id: "room_1", archived: true, expected_version: 1, reason: "Archive" }, "completion_archive");
      expect(archived.status).toBe(201);
      expect(archived.body).toMatchObject({ resource: { id: "resource_1", lifecycleState: "archived" }, replayed: false });

      const fixed = await request(baseUrl, "POST", "/api/v1/workspaces/workspace_1/completion/resources/resource_1/fix", { room_id: "room_1", fixed: true, expected_version: 1, reason: "Fix" }, "completion_fix");
      expect(fixed.status).toBe(201);
      expect(fixed.body).toMatchObject({ resource: { id: "resource_1", aiProtection: "fixed" }, replayed: false });

      const genericCreated = await request(baseUrl, "POST", "/api/v1/workspaces/workspace_1/domain/operations/completion.resource.create", {
        context: { room_id: "room_1" }, input
      }, "completion_generic_create");
      expect(genericCreated.status).toBe(201);
      expect(genericCreated.body).toMatchObject({ api_version: "1", result: { resource: { id: "resource_1" } }, replayed: false });
      expect(mounted.createCompletionResource).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ workspaceId: "workspace_1", accountId: "account_1", operationId: "completion_create" }),
        expect.objectContaining({ scope: { kind: "room", roomId: "room_1" }, kind: "knowledge", title: "A fact" })
      );
      expect(mounted.updateCompletionResource).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId: "workspace_1", accountId: "account_1", operationId: "completion_update" }),
        "resource_1",
        expect.objectContaining({ expectedVersion: 1, content: "The updated body" })
      );
      expect(mounted.commands.setCompletionResourceArchived).toHaveBeenCalledWith(
        expect.objectContaining({ operationId: "completion_archive" }),
        expect.objectContaining({ resourceId: "resource_1", archived: true })
      );
      expect(mounted.commands.setCompletionResourceFixed).toHaveBeenCalledWith(
        expect.objectContaining({ operationId: "completion_fix" }),
        expect.objectContaining({ resourceId: "resource_1", fixed: true })
      );
      expect(mounted.createCompletionResource).toHaveBeenCalledTimes(2);
      expect(mounted.createCompletionResource).toHaveBeenLastCalledWith(
        expect.objectContaining({ workspaceId: "workspace_1", accountId: "account_1", operationId: "completion_generic_create" }),
        expect.anything()
      );
      expect(mounted.appendPublicEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: "completion.resource.created" }));
      expect(mounted.appendPublicEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: "completion.resource.updated" }));
      expect(mounted.appendPublicEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: "completion.resource.archived" }));
      expect(mounted.appendPublicEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: "completion.resource.fixed" }));

      const eventCountBeforeReplay = mounted.appendPublicEvent.mock.calls.length;
      mounted.createCompletionResource.mockResolvedValueOnce({ resource, replayed: true });
      const replayed = await request(baseUrl, "POST", "/api/v1/workspaces/workspace_1/completion/resources", input, "completion_retry");
      expect(replayed.status).toBe(200);
      expect(replayed.body).toMatchObject({ resource: { id: "resource_1" }, replayed: true });
      expect(mounted.appendPublicEvent.mock.calls).toHaveLength(eventCountBeforeReplay);
    });
  });

  it("connects Settings, Learning, and Automation queries/operations to injected services", async () => {
    const mounted = createManagementApp();
    await withServer(mounted.app, async (baseUrl) => {
      const settingsResponse = await request(baseUrl, "GET", "/api/v1/workspaces/workspace_1/settings");
      expect(settingsResponse.status).toBe(200);
      expect(settingsResponse.body).toMatchObject({ ui_locale: "ja", learning_enabled: true });
      expect(mounted.runtimeSettings.get).toHaveBeenCalledWith({ workspaceId: "workspace_1", accountId: "account_1" });

      const settingsPatch = await request(baseUrl, "PATCH", "/api/v1/workspaces/workspace_1/settings", { learning_enabled: false }, "settings_patch");
      expect(settingsPatch.status).toBe(201);
      expect(settingsPatch.body).toMatchObject({ settings: { learning_enabled: false }, replayed: false });
      expect(mounted.runtimeSettings.patch).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId: "workspace_1", accountId: "account_1", operationId: "settings_patch" }),
        { learning_enabled: false }
      );

      const learningResponse = await request(baseUrl, "GET", "/api/v1/workspaces/workspace_1/learning/settings?room_id=room_1");
      expect(learningResponse.status).toBe(200);
      expect(learningResponse.body).toMatchObject({ settings: { scope: { roomId: "room_1" } } });
      expect(mounted.learning.getSettingsLayers).toHaveBeenCalledWith(
        { workspaceId: "workspace_1", accountId: "account_1" },
        "room_1"
      );

      const learningPatch = await request(baseUrl, "PATCH", "/api/v1/workspaces/workspace_1/learning/settings", { scope_kind: "room", room_id: "room_1", enabled: false, expected_version: 1 }, "learning_patch");
      expect(learningPatch.status).toBe(201);
      expect(learningPatch.body).toMatchObject({ settings: { scope: { roomId: "room_1" } }, replayed: false });
      expect(mounted.learning.updateSettings).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId: "workspace_1", accountId: "account_1", operationId: "learning_patch" }),
        expect.objectContaining({ scope: { kind: "room", roomId: "room_1" }, enabled: false, expectedVersion: 1 })
      );

      const automationCreated = await request(baseUrl, "POST", "/api/v1/workspaces/workspace_1/automation/jobs", {
        room_id: "room_1",
        title: "Review",
        kind: "custom_instruction",
        schedule: "once",
        target_instruction: "Review the Room.",
        delivery_target: {},
        enabled: true,
        max_attempts: 3
      }, "automation_create");
      expect(automationCreated.status).toBe(201);
      expect(automationCreated.body).toMatchObject({ job: { id: "job_1" }, replayed: false });
      expect(mounted.automation.createJob).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId: "workspace_1", accountId: "account_1", operationId: "automation_create" }),
        expect.objectContaining({ roomId: "room_1", kind: "custom_instruction", title: "Review" })
      );

      const jobs = await request(baseUrl, "GET", "/api/v1/workspaces/workspace_1/automation/jobs?room_id=room_1");
      expect(jobs.status).toBe(200);
      expect(jobs.body).toMatchObject({ jobs: [{ id: "job_1", room_id: "room_1" }] });
      expect(mounted.automation.listJobs).toHaveBeenCalledWith(
        { workspaceId: "workspace_1", accountId: "account_1" },
        "room_1"
      );

      const management = await request(baseUrl, "POST", "/api/v1/workspaces/workspace_1/automation/jobs/job_1/management", { state: "manager_stopped" }, "automation_stop");
      expect(management.status, JSON.stringify(management.body)).toBe(200);
      expect(management.body).toMatchObject({ job: { id: "job_1", management_state: "manager_stopped" }, replayed: false });
      expect(mounted.automation.setManagementState).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId: "workspace_1", accountId: "account_1", operationId: "automation_stop" }),
        { jobId: "job_1", state: "manager_stopped" }
      );
      const resumed = await request(baseUrl, "POST", "/api/v1/workspaces/workspace_1/automation/jobs/job_1/management", { state: "allowed" }, "automation_resume");
      expect(resumed.status).toBe(200);
      expect(resumed.body).toMatchObject({ job: { id: "job_1" }, replayed: false });
      expect(mounted.automation.setManagementState).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId: "workspace_1", accountId: "account_1", operationId: "automation_resume" }),
        { jobId: "job_1", state: "allowed" }
      );
      const runNow = await request(baseUrl, "POST", "/api/v1/workspaces/workspace_1/automation/run-now", { room_id: "room_1", kind: "custom_instruction" }, "automation_run_now");
      expect(runNow.status).toBe(201);
      expect(runNow.body).toMatchObject({ job: { id: "job_1" }, replayed: false });
      expect(mounted.automation.runNow).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId: "workspace_1", accountId: "account_1", operationId: "automation_run_now" }),
        { roomId: "room_1", kind: "custom_instruction" }
      );
      expect(mounted.appendPublicEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: "workspace.settings.changed" }));
      expect(mounted.appendPublicEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: "automation.job.management_changed" }));
      expect(mounted.appendPublicEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: "learning.settings.updated" }));
      expect(mounted.appendPublicEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: "automation.job.created" }));
    });
  });
});
