import { createHash } from "node:crypto";
import type { Express, NextFunction, Request, RequestHandler, Response } from "express";
import { z } from "zod";
import {
  PublicShareDelegationSchema,
  PublicShareImportResultSchema,
  PublicShareLocatorSchema,
  PublicShareManifestSchema,
  PublicShareOriginSchema,
  PublicShareVisibilitySchema
} from "@samurai-agent/domain-api";
import { canonicalJson, WorkspaceServerError } from "@samurai-agent/workspace-server";

/**
 * The share HTTP surface is intentionally independent from the normal Domain
 * API dispatcher.  A host supplies a narrow Core facade so this module cannot
 * reach a Workspace store, Runtime, Room membership, or Agent connection on
 * its own.
 */

export interface WorkspaceShareHttpIdentity {
  accountId: string;
  /** Public key material is used by an authentication resolver only. It is
   * never copied to a response or forwarded to the Share Core. */
  publicKey?: string;
}

export interface WorkspaceShareHttpClaimInput {
  locator: string;
  recipientAccountId: string;
  targetOrigin: string;
  targetWorkspaceId: string;
  operationId: string;
  contentHash: string;
  requestHash: string;
}

export interface WorkspaceShareHttpClaimResult {
  claim_id: string;
  share_id?: string;
  recipient_account_id: string;
  target_origin: string;
  target_workspace_id: string;
  operation_id: string;
  content_hash: string;
  created_at: string;
  replayed?: boolean;
}

export interface WorkspaceShareHttpContentInput {
  locator: string;
  claimId: string;
  recipientAccountId: string;
  delegation: z.infer<typeof PublicShareDelegationSchema>;
}

export interface WorkspaceShareHttpContentResult {
  /** Canonical bytes from the fixed published copy. The adapter does not
   * parse and reserialize these bytes. */
  bytes: Uint8Array;
  contentHash: string;
}

export interface WorkspaceShareHttpImportStatusInput {
  workspaceId: string;
  accountId: string;
  operationId: string;
}

export interface WorkspaceShareHttpCore {
  viewPublished(input: { locator: string; accountId?: string }): Promise<{
    title: string;
    visibility: "restricted" | "public";
    manifest: unknown;
    content_hash: string;
    published_at: string;
  }>;
  claim(input: WorkspaceShareHttpClaimInput): Promise<WorkspaceShareHttpClaimResult>;
  getClaimContent?(input: WorkspaceShareHttpContentInput): Promise<WorkspaceShareHttpContentResult>;
  importStatus(input: WorkspaceShareHttpImportStatusInput): Promise<unknown>;
}

export type WorkspaceShareHttpAsyncRoute = (
  handler: (req: Request, res: Response, next: NextFunction) => Promise<void>
) => RequestHandler;

export type WorkspaceShareHttpIdentityResolver = (
  req: Request
) => Promise<WorkspaceShareHttpIdentity | null | undefined>;

export interface WorkspaceShareHttpDependencies {
  app: Express;
  service: WorkspaceShareHttpCore;
  /** May return null for anonymous requests. It must validate any Account
   * credential before returning an identity. */
  resolvePublicIdentity?: WorkspaceShareHttpIdentityResolver;
  /** Must fail with 401 when no verified Account identity exists. */
  resolveAccountIdentity: WorkspaceShareHttpIdentityResolver;
  asyncRoute: WorkspaceShareHttpAsyncRoute;
  requestId: (req: Request) => string;
  /** Fixed HTTPS origin of this Server, used to bind signed delegation. */
  origin: string;
}

const claimBodySchema = z.object({
  target_origin: PublicShareOriginSchema,
  target_workspace_id: z.string().trim().min(1).max(512),
  operation_id: z.string().trim().min(1).max(512),
  content_hash: z.string().regex(/^[a-f0-9]{64}$/)
}).strict();

const contentBodySchema = z.object({ delegation: PublicShareDelegationSchema }).strict();
const operationIdSchema = z.string().trim().min(1).max(512);

const allowedErrorCodes = new Set([
  "share_unavailable",
  "share_revoked",
  "share_permission_denied",
  "workspace_share_claim_conflict",
  "workspace_share_content_hash_conflict",
  "workspace_share_delegation_mismatch",
  "workspace_share_delegation_expired",
  "workspace_share_delegation_invalid",
  "workspace_share_content_too_large",
  "workspace_share_claim_not_found",
  "workspace_share_import_not_found",
  "workspace_share_import_target_forbidden",
  "workspace_share_operation_id_required",
  "workspace_share_locator_invalid",
  "workspace_share_origin_invalid",
  "workspace_share_input_invalid",
  "account_authentication_required",
  "workspace_server_internal_error"
]);

const defaultPublicIdentity: WorkspaceShareHttpIdentityResolver = async () => null;

/** Mount only the dedicated share HTTP surface. The normal host decides where
 * this function is called, so importing this module never changes the main
 * Server routes by itself. */
export function mountWorkspaceShareHttpRoutes(deps: WorkspaceShareHttpDependencies): void {
  const origin = parseOrigin(deps.origin);
  const resolvePublicIdentity = deps.resolvePublicIdentity ?? defaultPublicIdentity;
  const route = (handler: (req: Request, res: Response) => Promise<void>): RequestHandler => deps.asyncRoute(async (req, res, next) => {
    setShareResponseHeaders(res, deps.requestId(req));
    try {
      await handler(req, res);
    } catch (error) {
      next(safeShareError(error));
    }
  });

  const publicViewApi = route(async (req, res) => {
    rejectQuery(req);
    const locator = parseLocator(req.params.locator);
    const resolvedIdentity = await resolvePublicIdentity(req);
    const identity = resolvedIdentity?.accountId?.trim() ? { ...resolvedIdentity, accountId: resolvedIdentity.accountId.trim() } : null;
    const view = await deps.service.viewPublished({ locator, ...(identity ? { accountId: identity.accountId } : {}) });
    if (view.visibility === "restricted" && !identity) throw new WorkspaceServerError("share_unavailable", 404);
    res.type("application/json").json(publicViewProjection(view));
  });

  const publicSharePage = route(async (req, res) => {
    rejectQuery(req);
    const locator = parseLocator(req.params.locator);
    const appLink = canonicalAppShareLink(origin, locator);
    let view: Awaited<ReturnType<WorkspaceShareHttpCore["viewPublished"]>> | null = null;
    try {
      const resolvedIdentity = await resolvePublicIdentity(req);
      const identity = resolvedIdentity?.accountId?.trim() ? { ...resolvedIdentity, accountId: resolvedIdentity.accountId.trim() } : null;
      view = await deps.service.viewPublished({ locator, ...(identity ? { accountId: identity.accountId } : {}) });
    } catch {
      // A browser-facing share page intentionally has one generic fallback for
      // missing, revoked, restricted, and unauthorized shares.  This avoids
      // turning the page into a share-existence oracle or leaking Core errors.
    }

    if (!view || view.visibility !== "public") {
      res.type("html").send(renderGenericSharePage(appLink));
      return;
    }

    try {
      const projection = publicViewProjection(view);
      res.type("html").send(renderPublicSharePage(projection, appLink));
    } catch {
      // Treat a malformed or no-longer-available publication like any other
      // unavailable browser share. The JSON API keeps its strict error path.
      res.type("html").send(renderGenericSharePage(appLink));
    }
  });

  // The browser route is an HTML-only safe view. The Domain API route remains
  // strict JSON for Native/Browser clients that explicitly request the API.
  deps.app.get("/s/:locator", publicSharePage);
  deps.app.get("/api/v1/shares/:locator", publicViewApi);

  deps.app.post("/api/v1/shares/:locator/claims", route(async (req, res) => {
    rejectQuery(req);
    const identity = await requireAccount(deps.resolveAccountIdentity, req);
    const locator = parseLocator(req.params.locator);
    const body = parseStrict(claimBodySchema, req.body, "workspace_share_claim_input_invalid");
    const requestHash = sha256(canonicalJson({
      locator,
      recipient_account_id: identity.accountId,
      target_origin: body.target_origin,
      target_workspace_id: body.target_workspace_id,
      operation_id: body.operation_id,
      content_hash: body.content_hash
    }));
    const claim = await deps.service.claim({
      locator,
      recipientAccountId: identity.accountId,
      targetOrigin: body.target_origin,
      targetWorkspaceId: body.target_workspace_id,
      operationId: body.operation_id,
      contentHash: body.content_hash,
      requestHash
    });
    res.status(claim.replayed ? 200 : 201).type("application/json").json(publicClaimProjection(claim));
  }));

  deps.app.post("/api/v1/shares/:locator/claims/:claimId/content", route(async (req, res) => {
    rejectQuery(req);
    const identity = await requireAccount(deps.resolveAccountIdentity, req);
    const locator = parseLocator(req.params.locator);
    const claimId = parseId(req.params.claimId, "claim_id_invalid");
    const body = parseStrict(contentBodySchema, req.body, "workspace_share_delegation_invalid");
    const payload = body.delegation.payload;
    if (payload.claim_id !== claimId || payload.source_origin !== origin || payload.recipient_account_id !== identity.accountId) {
      throw new WorkspaceServerError("workspace_share_delegation_mismatch", 403);
    }
    const issuedAt = Date.parse(payload.issued_at);
    const expiresAt = Date.parse(payload.expires_at);
    if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || expiresAt <= issuedAt || expiresAt - issuedAt > 5 * 60_000 || expiresAt <= Date.now()) {
      throw new WorkspaceServerError("workspace_share_delegation_expired", 403);
    }
    if (!deps.service.getClaimContent) throw new WorkspaceServerError("workspace_server_internal_error", 503);
    const content = await deps.service.getClaimContent({ locator, claimId, recipientAccountId: identity.accountId, delegation: body.delegation });
    const contentHash = parseHash(content.contentHash, "workspace_share_content_hash_invalid");
    const bytes = content.bytes instanceof Uint8Array ? content.bytes : new Uint8Array(content.bytes);
    if (bytes.byteLength > 32 * 1024 * 1024) throw new WorkspaceServerError("workspace_share_content_too_large", 413);
    if (sha256(bytes) !== contentHash) throw new WorkspaceServerError("workspace_share_content_hash_conflict", 409);
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("x-samurai-content-sha256", contentHash);
    res.send(Buffer.from(bytes));
  }));

  const importStatus = route(async (req, res) => {
    rejectQuery(req);
    const identity = await requireAccount(deps.resolveAccountIdentity, req);
    const workspaceId = parseId(req.params.workspaceId, "workspace_id_invalid");
    const operationId = parseId(req.params.operationId, "operation_id_invalid");
    const result = await deps.service.importStatus({ workspaceId, accountId: identity.accountId, operationId });
    res.type("application/json").json(safeImportStatus(result));
  });
  deps.app.get("/api/v1/workspaces/:workspaceId/shares/imports/:operationId", importStatus);
}

function parseOrigin(value: string): string {
  const parsed = PublicShareOriginSchema.safeParse(value);
  if (!parsed.success) throw new WorkspaceServerError("workspace_share_origin_invalid", 500);
  return parsed.data;
}

function parseLocator(value: unknown): string {
  const parsed = PublicShareLocatorSchema.safeParse(value);
  if (!parsed.success) throw new WorkspaceServerError("workspace_share_locator_invalid", 400);
  return parsed.data;
}

function parseId(value: unknown, code: string): string {
  const parsed = operationIdSchema.safeParse(value);
  if (!parsed.success) throw new WorkspaceServerError(code, 400);
  return parsed.data;
}

function parseHash(value: unknown, code: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new WorkspaceServerError(code, 500);
  return value;
}

function parseStrict<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, value: unknown, code: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new WorkspaceServerError(code, 400);
  return parsed.data;
}

function rejectQuery(req: Request): void {
  if (Object.keys(req.query as Record<string, unknown>).length > 0) throw new WorkspaceServerError("share_query_parameters_forbidden", 400);
}

async function requireAccount(resolver: WorkspaceShareHttpIdentityResolver, req: Request): Promise<WorkspaceShareHttpIdentity> {
  const identity = await resolver(req);
  if (!identity?.accountId?.trim()) throw new WorkspaceServerError("account_authentication_required", 401);
  return { ...identity, accountId: identity.accountId.trim() };
}

type PublicViewProjection = z.infer<typeof publicViewSchema>;

function publicViewProjection(view: { title: string; visibility: "restricted" | "public"; manifest: unknown; content_hash: string; published_at: string }): PublicViewProjection {
  // Strictly select the public projection. In particular, never spread a Core
  // object here: source IDs, internal paths, recipients, and claim metadata
  // must not cross this boundary.
  const parsed = publicViewSchema.safeParse({
    title: view.title,
    visibility: view.visibility,
    manifest: view.manifest,
    content_hash: view.content_hash,
    published_at: view.published_at
  });
  if (!parsed.success) throw new WorkspaceServerError("workspace_share_manifest_invalid", 500);
  return parsed.data;
}

function canonicalAppShareLink(origin: string, locator: string): string {
  // `origin` has already passed PublicShareOriginSchema, and `locator` has
  // passed the exact 43-character allowlist. Construct the source URL instead
  // of concatenating user-controlled path/query/fragment data.
  const sourceUrl = new URL(`/s/${locator}`, origin);
  if (sourceUrl.protocol !== "https:" || sourceUrl.username || sourceUrl.password || sourceUrl.search || sourceUrl.hash || sourceUrl.pathname !== `/s/${locator}`) {
    throw new WorkspaceServerError("workspace_share_origin_invalid", 500);
  }
  return `samurai://share?source=${encodeURIComponent(sourceUrl.toString())}`;
}

function renderGenericSharePage(appLink: string): string {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="robots" content="noindex,nofollow,noarchive"><title>共有内容を確認する</title></head><body><main><h1>共有内容を確認する</h1><p>本人確認が必要な場合は、Samuraiアプリでこのリンクを開いてください。</p><p><a href="${escapeHtml(appLink)}">アプリで開く</a></p></main></body></html>`;
}

function renderPublicSharePage(view: PublicViewProjection, appLink: string): string {
  const manifest = view.manifest;
  const entries = manifest.entries.map((entry) => {
    const files = entry.files.length > 0 ? `<p>添付ファイル ${entry.files.length}件</p>` : "";
    return `<li><h3>${escapeHtml(entry.title)}</h3><p class="share-kind">${entry.kind === "knowledge" ? "Knowledge" : "Skill"}</p><p>${renderSafeText(entry.content)}</p>${files}</li>`;
  }).join("");
  const agent = manifest.agent ? `<section><h2>Agent構成</h2><h3>${escapeHtml(manifest.agent.name)}</h3><p>${escapeHtml(manifest.agent.role)}</p><p>${renderSafeText(manifest.agent.instructions)}</p></section>` : "";
  const publishedAt = escapeHtml(view.published_at);
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="robots" content="noindex,nofollow,noarchive"><title>${escapeHtml(view.title)}</title></head><body><main><p>Samurai共有</p><h1>${escapeHtml(view.title)}</h1><p>共有時点の固定コピーです。発行日 <time datetime="${publishedAt}">${publishedAt}</time></p>${agent}<section><h2>共有された内容</h2><ul>${entries}</ul></section><p>このページを開いただけでは、Agent実行・Room参加・既定Agent変更は行いません。</p><p><a href="${escapeHtml(appLink)}">アプリで開く</a></p></main></body></html>`;
}

function renderSafeText(value: string): string {
  // Render all user text as text first. Only absolute HTTPS URLs are upgraded
  // to links, and those links are explicitly isolated from the opener/referrer.
  const urlPattern = /https:\/\/[^\s<>"']+/gi;
  let html = "";
  let cursor = 0;
  for (const match of value.matchAll(urlPattern)) {
    const raw = match[0];
    const start = match.index ?? 0;
    const trailing = raw.match(/[),.;!?]+$/)?.[0] ?? "";
    const candidate = trailing ? raw.slice(0, -trailing.length) : raw;
    let safeUrl: URL | null = null;
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol === "https:" && parsed.username === "" && parsed.password === "") safeUrl = parsed;
    } catch {
      // Keep malformed URL-like text escaped below.
    }
    html += escapeHtml(value.slice(cursor, start));
    if (safeUrl) {
      html += `<a href="${escapeHtml(safeUrl.toString())}" target="_blank" rel="noopener noreferrer">${escapeHtml(candidate)}</a>${escapeHtml(trailing)}`;
    } else {
      html += escapeHtml(raw);
    }
    cursor = start + raw.length;
  }
  html += escapeHtml(value.slice(cursor));
  return html.replace(/\r?\n/g, "<br>");
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      case "'": return "&#39;";
      default: return character;
    }
  });
}

const publicViewSchema = z.object({
  title: z.string().trim().min(1).max(200),
  visibility: PublicShareVisibilitySchema,
  manifest: PublicShareManifestSchema,
  content_hash: z.string().regex(/^[a-f0-9]{64}$/),
  published_at: z.string().datetime()
}).strict();

function publicClaimProjection(claim: WorkspaceShareHttpClaimResult): Record<string, unknown> {
  const parsed = claimResponseSchema.safeParse({
    claim_id: claim.claim_id,
    ...(claim.share_id ? { share_id: claim.share_id } : {}),
    recipient_account_id: claim.recipient_account_id,
    target_origin: claim.target_origin,
    target_workspace_id: claim.target_workspace_id,
    operation_id: claim.operation_id,
    content_hash: claim.content_hash,
    created_at: claim.created_at
  });
  if (!parsed.success) throw new WorkspaceServerError("workspace_server_internal_error", 500);
  return parsed.data;
}

const claimResponseSchema = z.object({
  claim_id: z.string().trim().min(1).max(512),
  share_id: z.string().trim().min(1).max(512).optional(),
  recipient_account_id: z.string().trim().min(1).max(512),
  target_origin: PublicShareOriginSchema,
  target_workspace_id: z.string().trim().min(1).max(512),
  operation_id: z.string().trim().min(1).max(512),
  content_hash: z.string().regex(/^[a-f0-9]{64}$/),
  created_at: z.string().datetime()
}).strict();

function safeImportStatus(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WorkspaceServerError("workspace_server_internal_error", 500);
  const body = value as Record<string, unknown>;
  // ImportResult is projected explicitly. Locator, source ID, delegation, and
  // internal staging paths are intentionally omitted even if a Core adds them.
  const parsed = PublicShareImportResultSchema.safeParse({
    import_id: stringValue(body.import_id),
    kind: stringValue(body.kind),
    status: stringValue(body.status),
    phase: stringValue(body.phase),
    retryable: booleanValue(body.retryable),
    failure_code: nullableStringValue(body.failure_code),
    created_resource_ids: stringArrayValue(body.created_resource_ids),
    created_agent_id: nullableStringValue(body.created_agent_id),
    committed_at: nullableStringValue(body.committed_at)
  });
  if (!parsed.success) throw new WorkspaceServerError("workspace_server_internal_error", 500);
  return parsed.data;
}

function stringValue(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 8_192) throw new WorkspaceServerError("workspace_server_internal_error", 500);
  return value;
}

function nullableStringValue(value: unknown): string | null {
  if (value === null) return null;
  return stringValue(value);
}

function booleanValue(value: unknown): boolean {
  if (typeof value !== "boolean") throw new WorkspaceServerError("workspace_server_internal_error", 500);
  return value;
}

function stringArrayValue(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 1_000 || value.some((entry) => typeof entry !== "string" || entry.length === 0 || entry.length > 512)) {
    throw new WorkspaceServerError("workspace_server_internal_error", 500);
  }
  return [...value] as string[];
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function setShareResponseHeaders(res: Response, requestId: string): void {
  res.setHeader("cache-control", "no-store");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("x-robots-tag", "noindex, nofollow, noarchive");
  res.setHeader("content-security-policy", "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; img-src 'none'; media-src 'none'; object-src 'none'; script-src 'none'; style-src 'none'");
  if (requestId) res.setHeader("x-samurai-request-id", requestId);
}

function safeShareError(error: unknown): WorkspaceServerError {
  if (!(error instanceof WorkspaceServerError)) return new WorkspaceServerError("workspace_server_internal_error", 500);
  let code: string;
  if (allowedErrorCodes.has(error.code)) code = error.code;
  else if (error.status === 400) code = "workspace_share_input_invalid";
  else if (error.status === 401) code = "account_authentication_required";
  else code = mapShareErrorCode(error.code);
  const status = publicStatusFor(code, error.status);
  return new WorkspaceServerError(code, status);
}

function mapShareErrorCode(code: string): string {
  if (code.includes("delegation")) return "workspace_share_delegation_invalid";
  if (code.includes("locator")) return "workspace_share_locator_invalid";
  if (code.includes("origin")) return "workspace_share_origin_invalid";
  if (code.includes("conflict")) return code.includes("content_hash") ? "workspace_share_content_hash_conflict" : "workspace_share_claim_conflict";
  if (code.includes("revoked")) return "share_revoked";
  if (code.includes("permission") || code.includes("forbidden") || code.includes("auth")) return "share_permission_denied";
  if (code.includes("not_found") || code.includes("unavailable")) return "share_unavailable";
  return "workspace_server_internal_error";
}

function publicStatusFor(code: string, fallback: number): number {
  if (code === "share_unavailable" || code.endsWith("_not_found")) return 404;
  if (code === "share_revoked") return 410;
  if (code.includes("permission") || code.includes("delegation") || code.includes("auth")) return code === "account_authentication_required" ? 401 : 403;
  if (code.includes("conflict")) return 409;
  if (code === "workspace_server_internal_error") return fallback >= 500 ? fallback : 500;
  return fallback;
}
