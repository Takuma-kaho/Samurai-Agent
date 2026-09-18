import express, { type Express } from "express";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceServerError } from "@samurai-agent/workspace-server";
import { mountWorkspaceShareHttpRoutes, type WorkspaceShareHttpCore, type WorkspaceShareHttpIdentity } from "./share-http";

const sourceOrigin = "https://source.example/";
const locator = "L".repeat(43);
const contentHash = "a".repeat(64);

describe("dedicated Workspace Share HTTP adapter", () => {
  it("renders anonymous public reads as safe HTML while keeping the API strict JSON", async () => {
    const service = fakeService();
    const mounted = createApp(service, { publicIdentity: async () => null });
    const response = await invoke(mounted.app, "/s/:locator", "GET", { params: { locator } });
    expect(response.statusCodeValue).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-robots-tag")).toContain("noindex");
    expect(response.headers.get("content-security-policy")).toContain("script-src 'none'");
    const html = String(response.body);
    expect(html).toContain("Published share");
    expect(html).toContain("Follow the manifest.");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("source_room_id");
    expect(html).not.toContain("manifest_path");
    expect(html).not.toContain("recipient_account_ids");
    expect(html).not.toContain("share-internal");
    expect(html).toContain("samurai://share?source=https%3A%2F%2Fsource.example%2Fs%2F");

    const api = await invoke(mounted.app, "/api/v1/shares/:locator", "GET", { params: { locator } });
    expect(api.statusCodeValue).toBe(200);
    expect(api.headers.get("content-type")).toContain("application/json");
    expect(api.body).toMatchObject({ visibility: "public", content_hash: contentHash });
    expect(api.body).not.toHaveProperty("share_id");
    expect(api.body).not.toHaveProperty("source_room_id");
    expect(api.body).not.toHaveProperty("manifest_path");
    expect(api.body).not.toHaveProperty("recipient_account_ids");
    expect(api.body).not.toHaveProperty("claim_id");
    expect(api.body).not.toHaveProperty("locator");
  });

  it("keeps restricted reads private for anonymous and wrong Accounts", async () => {
    const service = fakeService();
    service.viewPublished = vi.fn(async (input) => {
      if (input.accountId !== "account-recipient") throw new WorkspaceServerError("share_unavailable", 404);
      return safeView("restricted");
    });
    const anonymousApp = createApp(service, { publicIdentity: async () => null });
    const browser = await invoke(anonymousApp.app, "/s/:locator", "GET", { params: { locator } });
    expect(browser.statusCodeValue).toBe(200);
    expect(browser.headers.get("content-type")).toContain("text/html");
    const browserHtml = String(browser.body);
    expect(browserHtml).toContain("本人確認が必要な場合");
    expect(browserHtml).toContain("アプリで開く");
    expect(browserHtml).not.toContain("Published share");
    expect(browserHtml).not.toContain("Follow the manifest.");
    expect(browserHtml).not.toContain("internal-room");
    const anonymous = await invoke(anonymousApp.app, "/api/v1/shares/:locator", "GET", { params: { locator } });
    expect(anonymous.statusCodeValue).toBe(404);
    const wrongApp = createApp(service, { publicIdentity: async () => ({ accountId: "account-other" }) });
    const wrongBrowser = await invoke(wrongApp.app, "/s/:locator", "GET", { params: { locator } });
    expect(wrongBrowser.statusCodeValue).toBe(200);
    expect(String(wrongBrowser.body)).not.toContain("Published share");
    const wrongAccount = await invoke(wrongApp.app, "/api/v1/shares/:locator", "GET", { params: { locator } });
    expect(wrongAccount.statusCodeValue).toBe(404);
    expect(anonymous.body).toEqual({ error: { code: "share_unavailable" } });
  });

  it("escapes manifest HTML and only links absolute HTTPS text with opener/referrer protection", async () => {
    const service = fakeService();
    service.viewPublished = vi.fn(async () => ({
      ...safeView("public"),
      manifest: {
        ...safeView("public").manifest,
        entries: [{
          entry_id: "entry-1",
          kind: "knowledge" as const,
          title: "<unsafe>",
          content: `hello <img src=x> https://docs.example/help?q=1&x=2 javascript:alert(1)`,
          knowledge_kind: "fact" as const,
          files: []
        }]
      }
    }));
    const mounted = createApp(service, { publicIdentity: async () => null });
    const response = await invoke(mounted.app, "/s/:locator", "GET", { params: { locator } });
    const html = String(response.body);
    expect(html).toContain("&lt;unsafe&gt;");
    expect(html).toContain("&lt;img src=x&gt;");
    expect(html).toContain('target="_blank" rel="noopener noreferrer"');
    expect(html).not.toContain("<img src=x>");
    expect(html).not.toContain('href="javascript:');
  });

  it("rejects locator/query/unknown-body input before calling Core", async () => {
    const service = fakeService();
    const account: WorkspaceShareHttpIdentity = { accountId: "account-recipient" };
    const mounted = createApp(service, { accountIdentity: async () => account });
    const badLocator = await invoke(mounted.app, "/api/v1/shares/:locator", "GET", { params: { locator: "not-a-locator" } });
      expect(badLocator.statusCodeValue).toBe(400);
      const query = await invoke(mounted.app, "/api/v1/shares/:locator", "GET", { params: { locator }, query: { debug: "1" } });
      expect(query.statusCodeValue).toBe(400);
      const unknown = await invoke(mounted.app, "/api/v1/shares/:locator/claims", "POST", { params: { locator }, body: { target_origin: "https://target.example/", target_workspace_id: "workspace-target", operation_id: "operation-1", content_hash: contentHash, account_id: "forged-account" } });
      expect(unknown.statusCodeValue).toBe(400);
      expect(service.claim).not.toHaveBeenCalled();
  });

  it("returns 201 for a new claim, 200 for the same replay, and 410 after revoke", async () => {
    const service = fakeService();
    const claims = [
      { ...claimResult(), replayed: false },
      { ...claimResult(), replayed: true }
    ];
    service.claim = vi.fn(async () => {
      const next = claims.shift();
      if (next) return next;
      throw new WorkspaceServerError("share_revoked", 410);
    });
    const mounted = createApp(service, { accountIdentity: async () => ({ accountId: "account-recipient" }) });
    const input = { target_origin: "https://target.example/", target_workspace_id: "workspace-target", operation_id: "operation-1", content_hash: contentHash };
    const first = await invoke(mounted.app, "/api/v1/shares/:locator/claims", "POST", { params: { locator }, body: input });
      expect(first.statusCodeValue).toBe(201);
      expect(first.body).not.toHaveProperty("locator");
      expect(first.body).not.toHaveProperty("signature");
      const replay = await invoke(mounted.app, "/api/v1/shares/:locator/claims", "POST", { params: { locator }, body: input });
      expect(replay.statusCodeValue).toBe(200);
      const revoked = await invoke(mounted.app, "/api/v1/shares/:locator/claims", "POST", { params: { locator }, body: { ...input, operation_id: "operation-new" } });
      expect(revoked.statusCodeValue).toBe(410);
  });

  it("checks delegation binding at the adapter boundary and only returns verified content bytes", async () => {
    const service = fakeService();
    const content = Buffer.from(JSON.stringify({ format_version: 1, kind: "agent" }));
    service.getClaimContent = vi.fn(async () => ({ bytes: content, contentHash: sha256(content) }));
    const mounted = createApp(service, { accountIdentity: async () => ({ accountId: "account-recipient" }) });
    const delegation = validDelegation({ source_origin: "https://wrong-origin.example/" });
    const mismatch = await invoke(mounted.app, "/api/v1/shares/:locator/claims/:claimId/content", "POST", { params: { locator, claimId: "claim-1" }, body: { delegation } });
      expect(mismatch.statusCodeValue).toBe(403);
      expect(service.getClaimContent).not.toHaveBeenCalled();

      const valid = await invoke(mounted.app, "/api/v1/shares/:locator/claims/:claimId/content", "POST", { params: { locator, claimId: "claim-1" }, body: { delegation: validDelegation() } });
      expect(valid.statusCodeValue).toBe(200);
      expect(valid.headers.get("content-type")).toContain("application/json");
      expect(valid.headers.get("x-samurai-content-sha256")).toBe(sha256(content));
      expect(Buffer.from(valid.raw as Uint8Array).equals(content)).toBe(true);
  });

  it("projects import status without exposing source locator, delegation, or paths", async () => {
    const service = fakeService();
    service.importStatus = vi.fn(async () => ({
      import_id: "operation-import",
      kind: "agent",
      status: "staging",
      phase: "fetch",
      retryable: true,
      failure_code: null,
      created_resource_ids: [],
      created_agent_id: null,
      committed_at: null,
      source_locator: locator,
      manifest_path: "/private/internal/share.json",
      delegation: validDelegation()
    }));
    const mounted = createApp(service, { accountIdentity: async () => ({ accountId: "account-recipient" }) });
    const response = await invoke(mounted.app, "/api/v1/workspaces/:workspaceId/shares/imports/:operationId", "GET", { params: { workspaceId: "workspace-target", operationId: "operation-import" } });
      expect(response.statusCodeValue).toBe(200);
      const body = response.body as Record<string, unknown>;
      expect(body).toMatchObject({ import_id: "operation-import", status: "staging" });
      expect(body).not.toHaveProperty("source_locator");
      expect(body).not.toHaveProperty("manifest_path");
      expect(body).not.toHaveProperty("delegation");
      expect(service.importStatus).toHaveBeenCalledWith({ workspaceId: "workspace-target", accountId: "account-recipient", operationId: "operation-import" });
  });
});

function createApp(service: WorkspaceShareHttpCore, options: {
  publicIdentity?: () => Promise<WorkspaceShareHttpIdentity | null>;
  accountIdentity?: () => Promise<WorkspaceShareHttpIdentity | null>;
} = {}): { app: Express; service: WorkspaceShareHttpCore } {
  const app = express();
  mountWorkspaceShareHttpRoutes({
    app,
    service,
    origin: sourceOrigin,
    resolvePublicIdentity: options.publicIdentity ?? (async () => null),
    resolveAccountIdentity: options.accountIdentity ?? (async () => ({ accountId: "account-recipient" })),
    requestId: () => "request-share-http",
    asyncRoute: (handler) => async (req, res, next) => { await handler(req, res, next); }
  });
  return { app, service };
}

function fakeService(): WorkspaceShareHttpCore {
  return {
    viewPublished: vi.fn(async () => safeView("public")),
    claim: vi.fn(async () => claimResult()),
    getClaimContent: vi.fn(async () => ({ bytes: new Uint8Array(), contentHash })),
    importStatus: vi.fn(async () => ({ import_id: "operation-import", kind: "agent", status: "staging", phase: "fetch", retryable: true, failure_code: null, created_resource_ids: [], created_agent_id: null, committed_at: null }))
  };
}

function safeView(visibility: "public" | "restricted") {
  return {
    title: "Published share",
    visibility,
    manifest: {
      format_version: 1,
      kind: "agent",
      title: "Published share",
      entries: [],
      agent: { name: "Agent", role: "Assistant", instructions: "Follow the manifest." }
    },
    content_hash: contentHash,
    published_at: "2026-09-17T00:00:00.000Z",
    source_room_id: "internal-room",
    manifest_path: "/private/internal/share.json",
    recipient_account_ids: ["account-recipient"]
  };
}

function claimResult() {
  return {
    claim_id: "claim-1",
    share_id: "share-internal",
    recipient_account_id: "account-recipient",
    target_origin: "https://target.example/",
    target_workspace_id: "workspace-target",
    operation_id: "operation-1",
    content_hash: contentHash,
    created_at: "2026-09-17T00:00:00.000Z"
  };
}

function validDelegation(overrides: Record<string, unknown> = {}) {
  return {
    payload: {
      version: 1,
      source_origin: sourceOrigin,
      share_id: "share-internal",
      claim_id: "claim-1",
      recipient_account_id: "account-recipient",
      target_origin: "https://target.example/",
      target_workspace_id: "workspace-target",
      operation_id: "operation-1",
      content_hash: contentHash,
      issued_at: "2099-01-01T00:00:00.000Z",
      expires_at: "2099-01-01T00:04:00.000Z",
      ...overrides
    },
    public_key: "public-key-material",
    signature: "signature-material"
  };
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

type MockResponse = {
  statusCodeValue: number;
  headers: Map<string, string>;
  body: unknown;
  raw?: Uint8Array;
  setHeader(name: string, value: string): void;
  type(value: string): MockResponse;
  statusCode(value: number): MockResponse;
  status(value: number): MockResponse;
  json(value: unknown): MockResponse;
  send(value: Buffer | Uint8Array | string): MockResponse;
  header(name: string): string | undefined;
};

async function invoke(app: Express, path: string, method: string, input: { params?: Record<string, string>; query?: Record<string, string>; body?: unknown; headers?: Record<string, string> }): Promise<MockResponse> {
  const router = (app as Express & { router?: { stack?: Array<{ route?: { path?: string; methods?: Record<string, boolean>; stack?: Array<{ handle: (req: unknown, res: unknown, next: (error?: unknown) => void) => unknown }> } }> } }).router;
  const layer = router?.stack?.find((candidate) => candidate.route?.path === path && candidate.route.methods?.[method.toLowerCase()]);
  const handler = layer?.route?.stack?.[0]?.handle;
  if (!handler) throw new Error(`route not found: ${method} ${path}`);
  const response = mockResponse();
  const request = {
    method,
    path,
    originalUrl: path,
    params: input.params ?? {},
    query: input.query ?? {},
    body: input.body,
    headers: input.headers ?? {},
    get(name: string) { return (this.headers as Record<string, string>)[name.toLowerCase()]; },
    header(name: string) { return (this.headers as Record<string, string>)[name.toLowerCase()]; }
  };
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      if (error) {
        const status = typeof (error as { status?: unknown }).status === "number" ? Number((error as { status: number }).status) : 500;
        response.status(status).json({ error: { code: typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : "workspace_server_internal_error" } });
      }
      resolve();
    };
    try {
      const result = handler(request, response, finish);
      if (result && typeof (result as Promise<unknown>).then === "function") void (result as Promise<unknown>).then(() => finish(), reject);
    } catch (error) {
      finish(error);
    }
  });
  return response;
}

function mockResponse(): MockResponse {
  const headers = new Map<string, string>();
  const response = {
    statusCodeValue: 200,
    headers,
    body: undefined as unknown,
    raw: undefined as Uint8Array | undefined,
    setHeader(name: string, value: string) { headers.set(name.toLowerCase(), String(value)); },
    type(value: string) { this.setHeader("content-type", value === "html" ? "text/html; charset=utf-8" : value.includes("/") ? value : `application/${value}`); return this; },
    statusCode(value: number) { this.statusCodeValue = value; return this; },
    status(value: number) { this.statusCodeValue = value; return this; },
    json(value: unknown) { this.body = value; if (!headers.has("content-type")) this.setHeader("content-type", "application/json"); return this; },
    send(value: Buffer | Uint8Array | string) {
      if (typeof value === "string") this.body = value;
      else this.raw = new Uint8Array(value);
      return this;
    },
    header(name: string) { return headers.get(name.toLowerCase()); }
  } satisfies MockResponse;
  return response;
}
