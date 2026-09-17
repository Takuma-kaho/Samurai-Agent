import { createServer } from "node:http";
import express, { type Express } from "express";
import { describe, expect, it, vi } from "vitest";
import { mountDomainApiV1, type V1Dependencies } from "./domain-api-v1";

const timestamp = "2026-09-17T00:00:00.000Z";
const contentHash = "a".repeat(64);
const manifest = {
  format_version: 1 as const,
  kind: "agent" as const,
  title: "Imported Agent",
  entries: [{
    entry_id: "entry_1",
    kind: "skill" as const,
    title: "A Skill",
    content: "Use this skill.",
    files: []
  }],
  agent: { name: "Imported Agent", role: "Reviewer", instructions: "Review the work." }
};
const draft = {
  draft_id: "draft_1",
  version: 1,
  manifest,
  content_hash: contentHash,
  visibility: "restricted" as const,
  recipient_account_ids: ["account_2"],
  removed_references: []
};
const summary = {
  share_id: "share_1",
  version: 2,
  title: "Imported Agent",
  status: "active" as const,
  visibility: "public" as const,
  recipient_account_ids: [],
  url: "https://source.example/s/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  created_at: timestamp,
  published_at: timestamp,
  revoked_at: null
};
const importResult = {
  import_id: "import_1",
  kind: "agent" as const,
  status: "committed" as const,
  phase: "done" as const,
  retryable: false,
  failure_code: null,
  created_resource_ids: ["resource_1"],
  created_agent_id: "agent_1",
  committed_at: timestamp
};
const stagingImportResult = {
  import_id: "import_1",
  kind: "agent" as const,
  status: "staging" as const,
  phase: "fetch" as const,
  retryable: true,
  failure_code: null,
  created_resource_ids: [],
  created_agent_id: null,
  committed_at: null
};

type ShareService = NonNullable<V1Dependencies["share"]>;

function createShareApp(options: { withShare?: boolean; signedWorkspaceId?: string } = {}) {
  const app = express();
  app.use(express.json());

  const share: ShareService = {
    createDraft: vi.fn(async () => draft),
    updateDraft: vi.fn(async () => ({ ...draft, version: 2 })),
    viewDraft: vi.fn(async () => draft),
    discardDraft: vi.fn(async () => ({ draft_id: "draft_1", discarded: true })),
    publish: vi.fn(async () => ({
      share_id: "share_1",
      version: 3,
      url: summary.url,
      content_hash: contentHash,
      published_at: timestamp
    })),
    list: vi.fn(async () => ({ items: [summary], next_cursor: null })),
    view: vi.fn(async () => ({ ...summary, manifest, content_hash: contentHash })),
    revoke: vi.fn(async () => ({ share_id: "share_1", version: 4, status: "revoked", revoked_at: timestamp })),
    import: vi.fn(async () => importResult),
    importStatus: vi.fn(async () => importResult)
  };
  const signedWorkspaceId = options.signedWorkspaceId ?? "workspace_1";
  const operationContext = vi.fn((req: { get: (name: string) => string | undefined }) => ({
    workspaceId: signedWorkspaceId,
    accountId: "account_1",
    operationId: req.get("x-samurai-operation-id") ?? "operation_default"
  }));
  const dependencies = {
    app,
    io: { on: vi.fn(), sockets: { adapter: { rooms: new Map() }, sockets: new Map() } },
    store: {},
    commands: {},
    artifacts: {},
    generatedSurfaces: {},
    interactionRequests: {},
    realtimeGate: { run: async (_workspaceId: string, callback: () => unknown) => callback() },
    authenticateWorkspace: (_req: unknown, _res: unknown, next: () => void) => next(),
    authenticateAccount: (_req: unknown, _res: unknown, next: () => void) => next(),
    asyncRoute: (handler: (req: never, res: never, next: never) => Promise<void>) => (req: never, res: never, next: never) => {
      void handler(req, res, next).catch(next);
    },
    workspaceContext: () => ({ workspaceId: signedWorkspaceId, accountId: "account_1" }),
    operationContext,
    organizationContext: () => ({ accountId: "account_1", operationId: "organization_operation", requestId: "request_1" }),
    requestId: () => "request_1",
    runtimeFor: () => ({}),
    backendRegistry: { statuses: () => [] },
    ...(options.withShare === false ? {} : { share })
  } as unknown as V1Dependencies;

  mountDomainApiV1(dependencies);
  app.use((error: { status?: number; code?: string }, _req: unknown, res: { status: (status: number) => { json: (body: unknown) => void } }, _next: unknown) => {
    res.status(error.status ?? 500).json({ error: { code: error.code ?? "test_error" } });
  });
  return { app, share, operationContext };
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

async function request(baseUrl: string, method: "GET" | "POST", path: string, body?: unknown, operationId?: string) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(operationId ? { "x-samurai-operation-id": operationId } : {})
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  return { status: response.status, body: await response.json() as { result?: unknown; replayed?: boolean; error?: { code?: string } } };
}

function requestBody(input: unknown) {
  return { context: {}, input };
}

function importInput(targetWorkspaceId = "workspace_1") {
  return {
    source_origin: "https://source.example/",
    locator: "a".repeat(43),
    claim_id: "claim_1",
    content_hash: contentHash,
    delegation: {
      payload: {
        version: 1,
        source_origin: "https://source.example/",
        share_id: "share_1",
        claim_id: "claim_1",
        recipient_account_id: "account_1",
        target_origin: "https://target.example/",
        target_workspace_id: targetWorkspaceId,
        operation_id: "import_1",
        content_hash: contentHash,
        issued_at: timestamp,
        expires_at: "2026-09-17T00:04:00.000Z"
      },
      public_key: "public-key",
      signature: "signature"
    }
  };
}

describe("Domain API v1 Share boundary", () => {
  it("dispatches every signed Workspace share contract and preserves Core projections", async () => {
    const mounted = createShareApp();
    await withServer(mounted.app, async (baseUrl) => {
      const commands: Array<[string, unknown, keyof ShareService]> = [
        ["share.draft.create", { source_kind: "agent", source_id: "agent_1", resource_refs: [{ id: "resource_1", version: 1 }] }, "createDraft"],
        ["share.draft.update", { draft_id: "draft_1", expected_version: 1, manifest, visibility: "restricted", recipient_account_ids: ["account_2"] }, "updateDraft"],
        ["share.draft.discard", { draft_id: "draft_1", expected_version: 1 }, "discardDraft"],
        ["share.publish", { draft_id: "draft_1", expected_version: 2, expected_content_hash: contentHash }, "publish"],
        ["share.revoke", { share_id: "share_1", expected_version: 3 }, "revoke"],
        ["share.import", importInput(), "import"]
      ];
      for (const [operationId, input, method] of commands) {
        const response = await request(baseUrl, "POST", `/api/v1/workspaces/workspace_1/domain/operations/${operationId}`, requestBody(input), operationId === "share.import" ? "import_1" : operationId);
        expect(response.status).toBe(201);
        expect(response.body.result).toBeDefined();
        expect(mounted.share[method]).toHaveBeenCalledWith(
          expect.objectContaining({ workspaceId: "workspace_1", accountId: "account_1", operationId: operationId === "share.import" ? "import_1" : operationId }),
          input
        );
      }

      const queries: Array<[string, unknown, keyof ShareService]> = [
        ["share.draft.view", { draft_id: "draft_1" }, "viewDraft"],
        ["share.list", { source_kind: "agent", source_id: "agent_1", limit: 30 }, "list"],
        ["share.view", { share_id: "share_1" }, "view"],
        ["share.import.status", { operation_id: "import_1" }, "importStatus"]
      ];
      for (const [queryId, input, method] of queries) {
        const response = await request(baseUrl, "POST", `/api/v1/workspaces/workspace_1/domain/queries/${queryId}`, requestBody(input));
        expect(response.status).toBe(200);
        expect(response.body.result).toBeDefined();
        expect(mounted.share[method]).toHaveBeenCalledWith({ workspaceId: "workspace_1", accountId: "account_1" }, input);
      }
    });
  });

  it("unwraps replay metadata for every Share mutation without exposing it in the DTO", async () => {
    const mounted = createShareApp();
    const publishResult = {
      share_id: "share_1",
      version: 3,
      url: summary.url,
      content_hash: contentHash,
      published_at: timestamp
    };
    const revokeResult = { share_id: "share_1", version: 4, status: "revoked", revoked_at: timestamp };
    const commands: Array<[string, unknown, keyof ShareService, unknown]> = [
      ["share.draft.create", { source_kind: "agent", source_id: "agent_1", resource_refs: [{ id: "resource_1", version: 1 }] }, "createDraft", draft],
      ["share.draft.update", { draft_id: "draft_1", expected_version: 1, manifest, visibility: "restricted", recipient_account_ids: ["account_2"] }, "updateDraft", { ...draft, version: 2 }],
      ["share.draft.discard", { draft_id: "draft_1", expected_version: 1 }, "discardDraft", { draft_id: "draft_1", discarded: true }],
      ["share.publish", { draft_id: "draft_1", expected_version: 2, expected_content_hash: contentHash }, "publish", publishResult],
      ["share.revoke", { share_id: "share_1", expected_version: 3 }, "revoke", revokeResult],
      ["share.import", importInput(), "import", importResult]
    ];
    await withServer(mounted.app, async (baseUrl) => {
      for (const [operationId, input, method, value] of commands) {
        const mock = mounted.share[method] as unknown as { mockResolvedValueOnce: (result: unknown) => void };
        mock.mockResolvedValueOnce({ value, replayed: true });
        const requestOperationId = operationId === "share.import" ? "import_1" : `${operationId}_replay`;
        const response = await request(baseUrl, "POST", `/api/v1/workspaces/workspace_1/domain/operations/${operationId}`, requestBody(input), requestOperationId);
        expect(response.status).toBe(200);
        expect(response.body.replayed).toBe(true);
        expect(response.body.result).toEqual(value);
        expect(response.body.result).not.toHaveProperty("replayed");
      }
    });
  });

  it("returns 202 only for a first staging import and 200 for its replay", async () => {
    const mounted = createShareApp();
    const importMock = mounted.share.import as unknown as { mockResolvedValueOnce: (result: unknown) => void };
    importMock.mockResolvedValueOnce({ value: stagingImportResult, replayed: false });
    importMock.mockResolvedValueOnce({ value: stagingImportResult, replayed: true });
    await withServer(mounted.app, async (baseUrl) => {
      const first = await request(baseUrl, "POST", "/api/v1/workspaces/workspace_1/domain/operations/share.import", requestBody(importInput()), "import_1");
      expect(first.status).toBe(202);
      expect(first.body.replayed).toBe(false);
      expect(first.body.result).toEqual(stagingImportResult);

      const replay = await request(baseUrl, "POST", "/api/v1/workspaces/workspace_1/domain/operations/share.import", requestBody(importInput()), "import_1");
      expect(replay.status).toBe(200);
      expect(replay.body.replayed).toBe(true);
      expect(replay.body.result).toEqual(stagingImportResult);
    });
  });

  it("rejects a partial or extended Core mutation envelope", async () => {
    const mounted = createShareApp();
    const publishMock = mounted.share.publish as unknown as { mockResolvedValueOnce: (result: unknown) => void };
    publishMock.mockResolvedValueOnce({
      value: {
        share_id: "share_1",
        version: 3,
        url: summary.url,
        content_hash: contentHash,
        published_at: timestamp
      },
      replayed: true,
      unexpected: true
    });
    await withServer(mounted.app, async (baseUrl) => {
      const response = await request(baseUrl, "POST", "/api/v1/workspaces/workspace_1/domain/operations/share.publish", requestBody({ draft_id: "draft_1", expected_version: 2, expected_content_hash: contentHash }), "publish_invalid_result");
      expect(response.status).toBe(500);
      expect(response.body.error?.code).toBe("workspace_share_result_invalid");
    });
  });

  it("rejects mismatched signed Workspace/delegation, malformed input, replay without an operation, and missing Core", async () => {
    const mismatched = createShareApp({ signedWorkspaceId: "workspace_2" });
    await withServer(mismatched.app, async (baseUrl) => {
      const response = await request(baseUrl, "POST", "/api/v1/workspaces/workspace_1/domain/operations/share.publish", requestBody({ draft_id: "draft_1", expected_version: 2, expected_content_hash: contentHash }), "publish_1");
      expect(response.status).toBe(400);
      expect(response.body.error?.code).toBe("workspace_id_mismatch");
      expect(mismatched.share.publish).not.toHaveBeenCalled();
    });

    const app = createShareApp();
    await withServer(app.app, async (baseUrl) => {
      const targetMismatch = await request(baseUrl, "POST", "/api/v1/workspaces/workspace_1/domain/operations/share.import", requestBody(importInput("workspace_2")), "import_1");
      expect(targetMismatch.status).toBe(400);
      expect(targetMismatch.body.error?.code).toBe("workspace_id_mismatch");
      expect(app.share.import).not.toHaveBeenCalled();

      const malformed = await request(baseUrl, "POST", "/api/v1/workspaces/workspace_1/domain/operations/share.publish", requestBody({ draft_id: "draft_1", expected_version: 2, expected_content_hash: contentHash, unexpected: true }), "publish_1");
      expect(malformed.status).toBe(400);
      expect(malformed.body.error?.code).toBe("domain_api_input_invalid");
      expect(app.share.publish).not.toHaveBeenCalled();
    });

    const missing = createShareApp({ withShare: false });
    await withServer(missing.app, async (baseUrl) => {
      const response = await request(baseUrl, "POST", "/api/v1/workspaces/workspace_1/domain/operations/share.publish", requestBody({ draft_id: "draft_1", expected_version: 2, expected_content_hash: contentHash }), "publish_1");
      expect(response.status).toBe(503);
      expect(response.body.error?.code).toBe("domain_operation_not_available");
    });

    const noOperationId = createShareApp();
    noOperationId.operationContext.mockReturnValue({ workspaceId: "workspace_1", accountId: "account_1", operationId: "" });
    await withServer(noOperationId.app, async (baseUrl) => {
      const response = await request(baseUrl, "POST", "/api/v1/workspaces/workspace_1/domain/operations/share.publish", requestBody({ draft_id: "draft_1", expected_version: 2, expected_content_hash: contentHash }), "publish_1");
      expect(response.status).toBe(400);
      expect(response.body.error?.code).toBe("workspace_operation_id_required");
      expect(noOperationId.share.publish).not.toHaveBeenCalled();
    });
  });
});
