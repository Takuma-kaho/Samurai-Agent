import { ExternalIntegrationError, hashOpaqueToken, normalizeExternalIntegrationError } from "./contracts.js";
import { ConnectorRegistry } from "./connectors.js";
import { getExternalClientAdapter } from "./adapters.js";
import { CaptureService } from "./capture.js";
import { McpProtocolServer, type JsonRpcRequest } from "./mcp.js";
import { OAuthService } from "./oauth.js";
import { ApprovalService } from "./approval.js";
import { randomBytes } from "node:crypto";

export interface ExternalIntegrationHttpRequest {
  method: string;
  url: string;
  headers?: Record<string, string | undefined>;
  body?: string | Record<string, unknown>;
  /** HTTP framework request lifetime. A disconnect must cancel an in-flight
   * MCP operation instead of letting the write continue in the background. */
  signal?: AbortSignal;
  /** Socket peer supplied by the HTTP framework. Do not trust forwarded
   * headers unless the deployment explicitly declares its proxy trusted. */
  remoteAddress?: string;
}

export interface ExternalIntegrationHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface OAuthBrowserSessionPort {
  getAccountId(request: ExternalIntegrationHttpRequest): Promise<string>;
  /** Every browser state change must be checked by the Samurai login-session
   * adapter. This remains required when the adapter keeps the token in a
   * SameSite cookie instead of rendering a hidden form field. */
  assertCsrf(request: ExternalIntegrationHttpRequest): Promise<void>;
  getCsrfToken?(request: ExternalIntegrationHttpRequest): Promise<string | undefined>;
}

export interface ExternalIntegrationHttpOptions {
  mcp: McpProtocolServer;
  oauth: OAuthService;
  approval: ApprovalService;
  browserSession: OAuthBrowserSessionPort;
  /** Connector installation is operational integration state, scoped to a
   * browser-authorized Workspace. This is deliberately not a plugin market. */
  connectors?: ConnectorRegistry;
  capture?: CaptureService;
  resourceUrl?: string;
  /** Installed local relay executable/command. It is never a secret and is
   * required before a Client config can claim Hook delivery is available. */
  hookRelayCommand?: string;
  trustedProxy?: boolean;
}

/** Framework-neutral HTTP boundary. An Express/Fastify adapter only needs to
 * translate its request/response objects to these small structures. */
export function createExternalIntegrationHttpHandler(options: ExternalIntegrationHttpOptions): (request: ExternalIntegrationHttpRequest) => Promise<ExternalIntegrationHttpResponse> {
  const rateWindows = new Map<string, { startedAt: number; count: number }>();
  return async (request) => {
    try {
      const url = new URL(request.url, "http://localhost");
      const path = url.pathname;
      enforceRateLimit(request, path, rateWindows, options.trustedProxy === true);
      if (request.method === "GET" && path === "/.well-known/oauth-authorization-server") return json(200, options.oauth.metadata());
      if (request.method === "GET" && path === "/.well-known/oauth-protected-resource") {
        return json(200, {
          resource: options.resourceUrl ?? new URL("/mcp", String(options.oauth.metadata().issuer)).toString(),
          authorization_servers: [options.oauth.metadata().issuer],
          scopes_supported: options.oauth.metadata().scopes_supported
        });
      }
      if (request.method === "POST" && path === "/oauth/register") {
        const input = parseBody(request);
        const redirectUris = stringArray(input.redirect_uris);
        const allowedScopes = stringArray(input.allowed_scopes);
        if (allowedScopes.length === 0 && typeof input.scope === "string") allowedScopes.push(...input.scope.split(/\s+/).filter(Boolean));
        return json(201, await options.oauth.registerDynamicClient({
          ...(typeof input.workspace_id === "string" ? { workspaceId: input.workspace_id } : {}),
          clientName: required(input, "client_name"),
          connectorId: required(input, "connector_id"),
          redirectUris,
          allowedScopes,
          ...(typeof input.resource === "string" ? { resource: input.resource } : {})
        }));
      }
      if ((request.method === "GET" || request.method === "POST") && path === "/oauth/authorize") return await authorize(options, request, url);
      if (request.method === "POST" && path === "/oauth/deny") return await denyAuthorization(options, request);
      if (request.method === "POST" && path === "/oauth/token") return await token(options, request);
      if (request.method === "POST" && path === "/oauth/revoke") return await revoke(options, request);
      if (request.method === "GET" && path === "/connectors") return await listConnectors(options, request, url);
      if (request.method === "GET" && path === "/connectors/config") return await connectorConfig(options, request, url);
      if (request.method === "POST" && path === "/connectors/install") return await installConnector(options, request);
      if (request.method === "POST" && path === "/connectors/enable") return await setConnectorEnabled(options, request, true);
      if (request.method === "POST" && path === "/connectors/disable") return await setConnectorEnabled(options, request, false);
      if (request.method === "GET" && path === "/capture/policy") return await capturePolicy(options, request, url);
      if (request.method === "POST" && path === "/capture/policy") return await saveCapturePolicy(options, request);
      if (request.method === "GET" && path === "/capture/export") return await exportCapture(options, request, url);
      if (request.method === "POST" && path === "/capture/delete") return await deleteCapture(options, request);
      if (request.method === "GET" && path === "/approval") return await approvalPage(options, request, url);
      if (request.method === "POST" && path === "/approval/approve") return await approve(options, request);
      if (request.method === "POST" && path === "/approval/deny") return await deny(options, request);
      if (request.method === "POST" && path === "/connector/activity") return await activityHook(options, request);
      if (request.method === "POST" && path === "/connector/capture") return await captureHook(options, request);
      if (path === "/mcp" && ["POST", "DELETE", "GET"].includes(request.method)) return await mcp(options, request);
      return json(404, { error: "not_found" });
    } catch (error) {
      const normalized = normalizeExternalIntegrationError(error);
      if (normalized) return json(normalized.status, { error: normalized.code, message: normalized.message, retryable: normalized.retryable }, normalized.status === 401
        ? { "WWW-Authenticate": bearerChallenge(options) }
        : normalized.code === "oauth_scope_invalid" ? { "WWW-Authenticate": insufficientScopeChallenge(options) } : undefined);
      return json(500, { error: "internal_error" });
    }
  };
}

async function listConnectors(options: ExternalIntegrationHttpOptions, request: ExternalIntegrationHttpRequest, url: URL): Promise<ExternalIntegrationHttpResponse> {
  const connectors = requireConnectors(options);
  const workspaceId = required(Object.fromEntries(url.searchParams.entries()), "workspace_id");
  const accountId = await browserWorkspaceAccount(options, request, workspaceId, "connector-list");
  const installations = await connectors.listInstallations({ workspaceId });
  return json(200, {
    workspace_id: workspaceId,
    account_id: accountId,
    installations: installations.map((installation) => ({
      id: installation.id,
      connector_id: installation.connector_id,
      version: installation.version,
      enabled: installation.enabled,
      installed_at: installation.installed_at,
      ...(installation.disabled_at ? { disabled_at: installation.disabled_at } : {})
    }))
  });
}

async function connectorConfig(options: ExternalIntegrationHttpOptions, request: ExternalIntegrationHttpRequest, url: URL): Promise<ExternalIntegrationHttpResponse> {
  const connectors = requireConnectors(options);
  const input = Object.fromEntries(url.searchParams.entries());
  const workspaceId = required(input, "workspace_id");
  const connectorId = required(input, "connector_id");
  const projectRef = required(input, "project_ref");
  const os = required(input, "os");
  if (os !== "darwin" && os !== "win32" && os !== "linux") throw new ExternalIntegrationError("mcp_invalid_arguments", "connector_os_invalid");
  await browserWorkspaceAccount(options, request, workspaceId, `connector-config:${connectorId}`);
  const capabilities = await connectors.getCapabilities({ workspaceId, connectorId });
  if (!capabilities.supportedOs.includes(os)) throw new ExternalIntegrationError("connector_version_unsupported", "connector_os_unsupported");
  if (connectorId !== "codex" && connectorId !== "claude_code" && connectorId !== "hermes") {
    throw new ExternalIntegrationError("connector_manifest_invalid", "connector_adapter_unavailable");
  }
  const adapter = getExternalClientAdapter(connectorId);
  const serverUrl = options.resourceUrl ?? new URL("/mcp", String(options.oauth.metadata().issuer)).toString();
  const hook = adapter.hookConfig;
  return json(200, {
    connector_id: connectorId,
    version: capabilities.version,
    config_path: adapter.configPath(os),
    config: adapter.renderConfig({ serverUrl, projectRef, workspaceId }),
    ...(hook && options.hookRelayCommand
      ? { hook: { config_path: hook.configPath(os), config: hook.renderConfig({ projectRef, os, relayCommand: options.hookRelayCommand, connectorVersion: capabilities.version }) } }
      : { hook: { availability: hook ? "configuration_required" : "unsupported", ...(hook ? { reason: "hook_relay_command_required" } : {}) } }),
    startup_instruction: adapter.startupInstruction(),
    capability: {
      full_capture: capabilities.fullCapture,
      url_elicitation: capabilities.urlElicitation,
      context_injection: capabilities.contextInjection
    }
  });
}

async function installConnector(options: ExternalIntegrationHttpOptions, request: ExternalIntegrationHttpRequest): Promise<ExternalIntegrationHttpResponse> {
  const connectors = requireConnectors(options);
  const input = parseBody(request);
  await options.browserSession.assertCsrf(request);
  const workspaceId = required(input, "workspace_id");
  const connectorId = required(input, "connector_id");
  await browserWorkspaceAccount(options, request, workspaceId, `connector-install:${connectorId}`);
  const manifest = await connectors.getManifest(connectorId);
  if (!manifest || manifest.disabled_at) throw new ExternalIntegrationError("connector_manifest_invalid");
  return json(201, await connectors.install({ workspaceId, connectorId, version: manifest.version }));
}

async function setConnectorEnabled(options: ExternalIntegrationHttpOptions, request: ExternalIntegrationHttpRequest, enabled: boolean): Promise<ExternalIntegrationHttpResponse> {
  const connectors = requireConnectors(options);
  const input = parseBody(request);
  await options.browserSession.assertCsrf(request);
  const installation = await connectors.getInstallation(required(input, "installation_id"));
  if (!installation) throw new ExternalIntegrationError("connector_manifest_invalid");
  await browserWorkspaceAccount(options, request, installation.workspace_id, `connector-${enabled ? "enable" : "disable"}:${installation.id}`);
  return json(200, await connectors.setEnabled(installation.id, enabled));
}

function requireConnectors(options: ExternalIntegrationHttpOptions): ConnectorRegistry {
  if (!options.connectors) throw new ExternalIntegrationError("connector_manifest_invalid", "connector_registry_unavailable");
  return options.connectors;
}

async function browserWorkspaceAccount(options: ExternalIntegrationHttpOptions, request: ExternalIntegrationHttpRequest, workspaceId: string, requestId: string): Promise<string> {
  const accountId = await options.browserSession.getAccountId(request);
  await options.oauth.assertBrowserWorkspace({ workspaceId, accountId, requestId });
  return accountId;
}

async function capturePolicy(options: ExternalIntegrationHttpOptions, request: ExternalIntegrationHttpRequest, url: URL): Promise<ExternalIntegrationHttpResponse> {
  const capture = requireCapture(options);
  const input = Object.fromEntries(url.searchParams.entries());
  const workspaceId = required(input, "workspace_id");
  const connectionId = required(input, "connection_id");
  const accountId = await browserWorkspaceAccount(options, request, workspaceId, `capture-policy:${connectionId}`);
  await options.oauth.assertBrowserConnectionId({ workspaceId, connectionId, accountId });
  return json(200, { policy: await capture.getPolicy({ workspaceId, connectionId, accountId }) ?? null });
}

async function saveCapturePolicy(options: ExternalIntegrationHttpOptions, request: ExternalIntegrationHttpRequest): Promise<ExternalIntegrationHttpResponse> {
  const capture = requireCapture(options);
  const input = parseBody(request);
  await options.browserSession.assertCsrf(request);
  const workspaceId = required(input, "workspace_id");
  const connectionId = required(input, "connection_id");
  const accountId = await browserWorkspaceAccount(options, request, workspaceId, `capture-policy-save:${connectionId}`);
  await options.oauth.assertBrowserConnectionId({ workspaceId, connectionId, accountId });
  const current = await capture.getPolicy({ workspaceId, connectionId, accountId });
  const policy = await capture.savePolicy({
    id: current?.id ?? `capture_policy_${hashOpaqueToken(`${workspaceId}:${connectionId}:${accountId}`).slice(0, 40)}`,
    workspace_id: workspaceId,
    connection_id: connectionId,
    account_id: accountId,
    enabled: requiredBoolean(input, "enabled"),
    conversation: requiredBoolean(input, "conversation"),
    terminal: requiredBoolean(input, "terminal"),
    intermediate_log: requiredBoolean(input, "intermediate_log"),
    retention_days: requiredRetentionDays(input, "retention_days"),
    quota_bytes: requiredPositiveInteger(input, "quota_bytes"),
    // This names the server-owned redact algorithm, not a Client-supplied
    // promise. Updating it is an implementation release decision.
    redaction_policy_version: "server05-v1"
  });
  return json(200, { policy });
}

async function exportCapture(options: ExternalIntegrationHttpOptions, request: ExternalIntegrationHttpRequest, url: URL): Promise<ExternalIntegrationHttpResponse> {
  const capture = requireCapture(options);
  const input = Object.fromEntries(url.searchParams.entries());
  const workspaceId = required(input, "workspace_id");
  const connectionId = required(input, "connection_id");
  const accountId = await browserWorkspaceAccount(options, request, workspaceId, `capture-export:${connectionId}`);
  await options.oauth.assertBrowserConnectionId({ workspaceId, connectionId, accountId });
  return json(200, await capture.exportPage({
    workspaceId,
    connectionId,
    accountId,
    ...(optional(input, "project_ref") ? { projectRef: optional(input, "project_ref") } : {}),
    ...(optional(input, "external_session_id") ? { externalSessionId: optional(input, "external_session_id") } : {}),
    ...(optional(input, "room_id") ? { roomId: optional(input, "room_id") } : {}),
    ...(optional(input, "cursor") ? { cursor: optional(input, "cursor") } : {}),
    ...(optional(input, "limit") ? { limit: requiredPositiveInteger(input, "limit") } : {})
  }));
}

async function deleteCapture(options: ExternalIntegrationHttpOptions, request: ExternalIntegrationHttpRequest): Promise<ExternalIntegrationHttpResponse> {
  const capture = requireCapture(options);
  const input = parseBody(request);
  await options.browserSession.assertCsrf(request);
  const workspaceId = required(input, "workspace_id");
  const connectionId = required(input, "connection_id");
  const roomId = required(input, "room_id");
  const accountId = await browserWorkspaceAccount(options, request, workspaceId, `capture-delete:${connectionId}`);
  await options.oauth.assertBrowserConnectionId({ workspaceId, connectionId, accountId });
  return json(200, {
    deleted: await capture.delete({
      recordId: required(input, "record_id"),
      workspaceId,
      connectionId,
      accountId,
      roomId
    })
  });
}

function requireCapture(options: ExternalIntegrationHttpOptions): CaptureService {
  if (!options.capture) throw new ExternalIntegrationError("capture_policy_invalid", "capture_service_unavailable");
  return options.capture;
}

async function activityHook(options: ExternalIntegrationHttpOptions, request: ExternalIntegrationHttpRequest): Promise<ExternalIntegrationHttpResponse> {
  const input = parseBody(request);
  const event = input.event;
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    throw new ExternalIntegrationError("mcp_invalid_arguments", "activity_event_required");
  }
  return json(202, await options.mcp.ingestActivityHook(header(request, "authorization"), {
    projectRef: required(input, "project_ref"),
    event: event as import("./contracts.js").ConnectorEvent,
    ...(request.signal ? { signal: request.signal } : {})
  }));
}

async function captureHook(options: ExternalIntegrationHttpOptions, request: ExternalIntegrationHttpRequest): Promise<ExternalIntegrationHttpResponse> {
  const input = parseBody(request);
  const kind = input.kind;
  if (kind !== "conversation" && kind !== "terminal" && kind !== "intermediate_log") {
    throw new ExternalIntegrationError("mcp_invalid_arguments", "capture_kind_invalid");
  }
  const text = typeof input.text === "string" ? input.text : undefined;
  const hasPayload = Object.prototype.hasOwnProperty.call(input, "payload");
  return json(202, await options.mcp.ingestCaptureHook(header(request, "authorization"), {
    projectRef: required(input, "project_ref"),
    externalSessionId: required(input, "external_session_id"),
    eventId: required(input, "event_id"),
    kind,
    ...(text === undefined && hasPayload ? { payload: input.payload } : {}),
    ...(text !== undefined ? { text } : {}),
    ...(request.signal ? { signal: request.signal } : {})
  }));
}

function enforceRateLimit(request: ExternalIntegrationHttpRequest, path: string, windows: Map<string, { startedAt: number; count: number }>, trustedProxy: boolean): void {
  if (!path.startsWith("/oauth/") && !path.startsWith("/approval/")) return;
  const now = Date.now();
  const windowMs = 60_000;
  const forwarded = trustedProxy ? header(request, "x-forwarded-for")?.split(",")[0]?.trim() : undefined;
  const key = hashOpaqueToken(forwarded ?? request.remoteAddress ?? header(request, "authorization") ?? "anonymous");
  const current = windows.get(key);
  if (!current || now - current.startedAt >= windowMs) {
    windows.set(key, { startedAt: now, count: 1 });
    return;
  }
  if (current.count >= 120) throw new ExternalIntegrationError("oauth_rate_limited", "oauth_rate_limited", true, 429);
  current.count += 1;
}

async function authorize(options: ExternalIntegrationHttpOptions, request: ExternalIntegrationHttpRequest, url: URL): Promise<ExternalIntegrationHttpResponse> {
  if (request.method === "GET" && url.searchParams.has("request_id")) {
    const requestId = url.searchParams.get("request_id") as string;
    const authorizationRequest = await options.oauth.getAuthorizationRequest(requestId);
    // Do not render Workspace/Scope details to an anonymous browser or to a
    // different Account. The approval POST repeats this check, but the page
    // itself must already be behind the Samurai login session.
    const accountId = await options.browserSession.getAccountId(request);
    await options.oauth.assertBrowserConnection({ workspaceId: authorizationRequest.workspace_id, connectorId: authorizationRequest.connector_id, accountId });
    const csrf = await options.browserSession.getCsrfToken?.(request);
    const csrfField = csrf ? `<input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"/>` : "";
    const fields = `<input type="hidden" name="request_id" value="${escapeHtml(requestId)}"/>${csrfField}`;
    const summary = { workspace_id: authorizationRequest.workspace_id, connector_id: authorizationRequest.connector_id, scopes: authorizationRequest.scopes, redirect_uri: authorizationRequest.redirect_uri, expires_at: authorizationRequest.expires_at };
    return html(200, `<html><body><h1>Samurai authorization</h1><p>Review the Workspace, Connector, permissions, callback, and expiry before deciding.</p><pre>${escapeHtml(JSON.stringify(summary, null, 2))}</pre><form method="post" action="/oauth/authorize">${fields}<button type="submit">Approve</button></form><form method="post" action="/oauth/deny">${fields}<button type="submit">Deny</button></form></body></html>`);
  }
  const input = request.method === "POST" ? parseBody(request) : Object.fromEntries(url.searchParams.entries());
  if (input.request_id) {
    await options.browserSession.assertCsrf(request);
    const accountId = await options.browserSession.getAccountId(request);
    const approved = await options.oauth.approveAuthorization({ requestId: String(input.request_id), accountId });
    return redirect(302, approved.redirectUri);
  }
  const resource = required(input, "resource");
  const resourceWorkspaceId = workspaceIdFromResource(resource, false);
  const suppliedWorkspaceId = typeof input.workspace_id === "string" ? input.workspace_id : undefined;
  if (suppliedWorkspaceId && resourceWorkspaceId && suppliedWorkspaceId !== resourceWorkspaceId) {
    throw new ExternalIntegrationError("oauth_resource_invalid", "oauth_resource_workspace_mismatch");
  }
  const workspaceId = suppliedWorkspaceId ?? resourceWorkspaceId;
  if (!workspaceId) throw new ExternalIntegrationError("mcp_invalid_arguments", "workspace_id_required");
  const started = await options.oauth.beginAuthorization({
    // OAuth Clients normally send `resource`, not Samurai's internal
    // workspace_id. The generated MCP URL carries only the selected
    // Workspace reference; OAuth still validates it against the active
    // Connection and the signed-in browser Account before issuing a Code.
    workspaceId,
    clientId: required(input, "client_id"),
    redirectUri: required(input, "redirect_uri"),
    responseType: (input.response_type ?? "code") as "code",
    scope: required(input, "scope"),
    state: required(input, "state"),
    codeChallenge: required(input, "code_challenge"),
    codeChallengeMethod: (input.code_challenge_method ?? "S256") as "S256",
    resource
  });
  return redirect(302, started.authorizationUrl);
}

async function denyAuthorization(options: ExternalIntegrationHttpOptions, request: ExternalIntegrationHttpRequest): Promise<ExternalIntegrationHttpResponse> {
  const input = parseBody(request);
  await options.browserSession.assertCsrf(request);
  const accountId = await options.browserSession.getAccountId(request);
  const denied = await options.oauth.denyAuthorization({ requestId: required(input, "request_id"), accountId });
  const callback = new URL(denied.redirect_uri);
  callback.searchParams.set("error", "access_denied");
  callback.searchParams.set("error_description", "resource_owner_denied");
  callback.searchParams.set("state", denied.state);
  return redirect(302, callback.toString());
}

async function token(options: ExternalIntegrationHttpOptions, request: ExternalIntegrationHttpRequest): Promise<ExternalIntegrationHttpResponse> {
  const input = parseBody(request);
  const resource = required(input, "resource");
  if (input.grant_type === "refresh_token") {
    return json(200, await options.oauth.refreshAccessToken({ refreshToken: required(input, "refresh_token"), clientId: required(input, "client_id"), resource }));
  }
  return json(200, await options.oauth.exchangeCode({
    clientId: required(input, "client_id"),
    ...(input.workspace_id ? { workspaceId: String(input.workspace_id) } : {}),
    ...(input.client_secret ? { clientSecret: String(input.client_secret) } : {}),
    code: required(input, "code"),
    redirectUri: required(input, "redirect_uri"),
    codeVerifier: required(input, "code_verifier"),
    resource
  }));
}

async function revoke(options: ExternalIntegrationHttpOptions, request: ExternalIntegrationHttpRequest): Promise<ExternalIntegrationHttpResponse> {
  const input = parseBody(request);
  await options.browserSession.assertCsrf(request);
  const accountId = await options.browserSession.getAccountId(request);
  const identity = { accountId, clientId: required(input, "client_id") };
  if (input.token) return json(200, { revoked: await options.oauth.revokeToken(required(input, "token"), identity) });
  return json(200, { revoked: await options.oauth.revokeGrant(required(input, "grant_id"), identity) });
}

async function approvalPage(options: ExternalIntegrationHttpOptions, requestInput: ExternalIntegrationHttpRequest, url: URL): Promise<ExternalIntegrationHttpResponse> {
  const input = Object.fromEntries(url.searchParams.entries());
  const id = required(input, "approval_id");
  const approvalToken = required(input, "approval_token");
  const workspaceId = required(input, "workspace_id");
  const accountId = await options.browserSession.getAccountId(requestInput);
  const request = await options.approval.view({ approvalId: id, approvalToken, accountId, workspaceId });
  const csrf = await options.browserSession.getCsrfToken?.(requestInput);
  const csrfField = csrf ? `<input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"/>` : "";
  const fields = `<input type="hidden" name="approval_id" value="${escapeHtml(id)}"/><input type="hidden" name="approval_token" value="${escapeHtml(approvalToken)}"/><input type="hidden" name="workspace_id" value="${escapeHtml(workspaceId)}"/>${csrfField}`;
  const actions = `<form method="post" action="/approval/approve">${fields}<button type="submit">Approve</button></form><form method="post" action="/approval/deny">${fields}<button type="submit">Deny</button></form>`;
  const impact = {
    operation: request.operation,
    before: { resource_versions: request.expected_versions },
    after: { input: JSON.parse(request.canonical_input) },
    impact: { workspace_id: request.workspace_id, room_id: request.room_id, target: request.target },
    expires_at: request.expires_at,
    state: request.state
  };
  return html(200, `<html><body><h1>Samurai approval</h1><p>Review the before/after change, affected Room, and expiry before deciding.</p><pre>${escapeHtml(JSON.stringify(impact, null, 2))}</pre>${actions}</body></html>`);
}

async function approve(options: ExternalIntegrationHttpOptions, request: ExternalIntegrationHttpRequest): Promise<ExternalIntegrationHttpResponse> {
  const input = parseBody(request);
  await options.browserSession.assertCsrf(request);
  const accountId = await options.browserSession.getAccountId(request);
  const approved = await options.approval.approve({ approvalId: required(input, "approval_id"), approvalToken: required(input, "approval_token"), accountId, workspaceId: required(input, "workspace_id") });
  const execution = await options.mcp.executeApproved(approved.id, accountId, request.signal);
  return json(200, { approval: approved, execution });
}

async function deny(options: ExternalIntegrationHttpOptions, request: ExternalIntegrationHttpRequest): Promise<ExternalIntegrationHttpResponse> {
  const input = parseBody(request);
  await options.browserSession.assertCsrf(request);
  const accountId = await options.browserSession.getAccountId(request);
  return json(200, await options.approval.deny({ approvalId: required(input, "approval_id"), approvalToken: required(input, "approval_token"), accountId, workspaceId: required(input, "workspace_id") }));
}

async function mcp(options: ExternalIntegrationHttpOptions, request: ExternalIntegrationHttpRequest): Promise<ExternalIntegrationHttpResponse> {
  const incomingSession = header(request, "mcp-session-id");
  if (incomingSession) {
    const protocolVersion = header(request, "mcp-protocol-version");
    if (!protocolVersion) throw new ExternalIntegrationError("mcp_protocol_version_unsupported", "mcp_protocol_version_header_required");
    options.mcp.validateTransport({ origin: header(request, "origin"), protocolVersion });
  }
  if (request.method === "DELETE") {
    if (!incomingSession) throw new ExternalIntegrationError("mcp_session_required");
    options.mcp.terminateSession(incomingSession);
    return { status: 204, headers: {}, body: "" };
  }
  if (request.method !== "POST") return { status: 405, headers: { allow: "POST, DELETE" }, body: "" };
  const body = parseBody(request) as unknown as JsonRpcRequest;
  if (body.method === "initialize" && incomingSession) {
    throw new ExternalIntegrationError("mcp_invalid_arguments", "initialize_must_not_include_session");
  }
  const sessionId = incomingSession ?? (body.method === "initialize" ? `mcp_http_${randomBytes(24).toString("base64url")}` : undefined);
  const response = await options.mcp.handle(body, header(request, "authorization"), sessionId, {
    origin: header(request, "origin"),
    protocolVersion: header(request, "mcp-protocol-version"),
    ...(urlParam(request.url, "project_ref") ? { projectRef: urlParam(request.url, "project_ref") } : {}),
    ...(urlParam(request.url, "external_session_id") ? { externalSessionId: urlParam(request.url, "external_session_id") } : {})
  }, request.signal);
  if (!response) return { status: 202, headers: {}, body: "" };
  const errorStatus = response.error?.data?.status;
  const status = errorStatus === 401 || errorStatus === 403 ? errorStatus : 200;
  return json(status, response, {
    ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
    "MCP-Protocol-Version": options.mcp.protocolVersionValue(),
    ...(status === 401 ? { "WWW-Authenticate": bearerChallenge(options) } : {}),
    ...(status === 403 && response.error?.message === "oauth_scope_invalid" ? { "WWW-Authenticate": insufficientScopeChallenge(options) } : {})
  });
}

function parseBody(request: ExternalIntegrationHttpRequest): Record<string, unknown> {
  if (request.body && typeof request.body === "object") return request.body;
  const body = typeof request.body === "string" ? request.body : "";
  const contentType = header(request, "content-type") ?? "";
  if (contentType.includes("application/x-www-form-urlencoded")) return Object.fromEntries(new URLSearchParams(body).entries());
  if (!body) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new ExternalIntegrationError("mcp_invalid_arguments", "body_json_invalid");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new ExternalIntegrationError("mcp_invalid_arguments", "body_object_required");
  return parsed as Record<string, unknown>;
}

function required(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || value.length === 0) throw new ExternalIntegrationError("mcp_invalid_arguments", `${key}_required`);
  return value;
}

function optional(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function requiredBoolean(input: Record<string, unknown>, key: string): boolean {
  if (typeof input[key] !== "boolean") throw new ExternalIntegrationError("mcp_invalid_arguments", `${key}_boolean_required`);
  return input[key] as boolean;
}

function requiredPositiveInteger(input: Record<string, unknown>, key: string): number {
  const raw = input[key];
  const value = typeof raw === "number" ? raw : typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(value) || value <= 0) throw new ExternalIntegrationError("mcp_invalid_arguments", `${key}_positive_integer_required`);
  return value;
}

function requiredRetentionDays(input: Record<string, unknown>, key: string): 7 | 30 | 90 {
  const value = requiredPositiveInteger(input, key);
  if (value !== 7 && value !== 30 && value !== 90) throw new ExternalIntegrationError("mcp_invalid_arguments", "capture_retention_days_invalid");
  return value;
}

function stringArray(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim().length === 0)) {
    throw new ExternalIntegrationError("mcp_invalid_arguments", "string_array_invalid");
  }
  return value.map((item) => (item as string).trim());
}

function header(request: ExternalIntegrationHttpRequest, name: string): string | undefined {
  const key = Object.keys(request.headers ?? {}).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? request.headers?.[key] : undefined;
}

function urlParam(requestUrl: string, key: string): string | undefined {
  const value = new URL(requestUrl, "http://localhost").searchParams.get(key);
  return value && value.trim() ? value : undefined;
}

function workspaceIdFromResource(resource: string | undefined, required = true): string | undefined {
  if (!resource) throw new ExternalIntegrationError("mcp_invalid_arguments", "workspace_id_required");
  try {
    const workspaceId = new URL(resource).searchParams.get("workspace_id");
    if ((!workspaceId || !workspaceId.trim()) && required) throw new ExternalIntegrationError("mcp_invalid_arguments", "workspace_id_required");
    return workspaceId?.trim() || undefined;
  } catch (error) {
    if (error instanceof ExternalIntegrationError) throw error;
    throw new ExternalIntegrationError("oauth_resource_invalid", "oauth_resource_url_invalid");
  }
}

function bearerChallenge(options: ExternalIntegrationHttpOptions): string {
  const resource = options.resourceUrl ?? new URL("/mcp", String(options.oauth.metadata().issuer)).toString();
  const metadata = new URL("/.well-known/oauth-protected-resource", resource).toString();
  return `Bearer realm="Samurai", resource_metadata="${metadata}", scope="workspace.read room.read"`;
}

function insufficientScopeChallenge(options: ExternalIntegrationHttpOptions): string {
  const resource = options.resourceUrl ?? new URL("/mcp", String(options.oauth.metadata().issuer)).toString();
  const metadata = new URL("/.well-known/oauth-protected-resource", resource).toString();
  const metadataDocument = options.oauth.metadata();
  const scopes = Array.isArray(metadataDocument.scopes_supported)
    ? metadataDocument.scopes_supported.filter((scope): scope is string => typeof scope === "string").join(" ")
    : "workspace.read room.read";
  return `Bearer error="insufficient_scope", resource_metadata="${metadata}", scope="${scopes}"`;
}

function json(status: number, value: unknown, extra?: Record<string, string>): ExternalIntegrationHttpResponse {
  return { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...(extra ?? {}) }, body: JSON.stringify(value) };
}

function html(status: number, body: string): ExternalIntegrationHttpResponse {
  return { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'none'; form-action 'self'; base-uri 'none'" }, body };
}

function redirect(status: number, location: string): ExternalIntegrationHttpResponse {
  return { status, headers: { location, "cache-control": "no-store" }, body: "" };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char] ?? char);
}
