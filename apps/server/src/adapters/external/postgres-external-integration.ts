import { createHmac, timingSafeEqual } from "node:crypto";
import {
  ApprovalService,
  CaptureRetentionWorker,
  CaptureService,
  ConnectorRegistry,
  ContextSnapshotService,
  ExternalIntegrationError,
  McpProtocolServer,
  OAuthService,
  RoomBindingService,
  createExternalIntegrationHttpHandler,
  registerOfficialConnectorManifests,
  type ExternalIntegrationHttpRequest,
  type ExternalIntegrationHttpResponse,
  type OAuthAccountAuthorizationPort,
  type OAuthBrowserSessionPort,
  type McpMutationToolDefinition
} from "@samurai-agent/external-integration";
import { getDomainCommandEntry } from "@samurai-agent/action-catalog";
import type { ParticipantPrincipal } from "@samurai-agent/room-permissions";
import {
  createRuntimeContextSnapshotSource,
  RuntimeMcpWorkspacePort
} from "@samurai-agent/runtime";
import type { PostgresWorkspaceDatabase, WorkspaceServerCommandService, WorkspaceServerConfig } from "@samurai-agent/workspace-server";
import { OwnerTokenManager } from "../../middleware/security";
import { PostgresExternalAppIngressFactory, PostgresExternalRoomAuthorization } from "./postgres-external-app-ingress";
import {
  PostgresExternalIntegrationStore,
  runPostgresExternalIntegrationContext
} from "./postgres-external-integration-store";

export interface PostgresExternalIntegrationRuntime {
  handler: (request: ExternalIntegrationHttpRequest) => Promise<ExternalIntegrationHttpResponse>;
  close(): void;
}

export interface CreatePostgresExternalIntegrationRuntimeOptions {
  database: PostgresWorkspaceDatabase;
  commands: WorkspaceServerCommandService;
  ingress: PostgresExternalAppIngressFactory;
  config: WorkspaceServerConfig;
  browserSession?: OAuthBrowserSessionPort;
  browserAuthorization?: OAuthAccountAuthorizationPort;
  allowedOrigins?: readonly string[];
  trustedProxy?: boolean;
  hookRelayCommand?: string;
}

/**
 * Composes the external protocol package with PostgreSQL Core09 ports. The
 * protocol package owns OAuth/MCP/Connector state transitions; this module
 * supplies only the database-backed authority and the formal Core ingress.
 */
export async function createPostgresExternalIntegrationRuntime(
  options: CreatePostgresExternalIntegrationRuntimeOptions
): Promise<PostgresExternalIntegrationRuntime> {
  const store = new PostgresExternalIntegrationStore(options.database);
  const connections = options.ingress.connectionLookup();
  const authorization = new PostgresExternalRoomAuthorization(options.commands);
  const runtime = {
    createExternalAppIngress: (workspaceId: string) => options.ingress.create(workspaceId)
  };
  const connectors = new ConnectorRegistry({ store, samuraiVersion: "0.1.0" });
  await registerOfficialConnectorManifests(connectors);
  const bindings = new RoomBindingService({ store, connections, authorization });
  const snapshots = new ContextSnapshotService({
    store,
    source: createRuntimeContextSnapshotSource({ runtime })
  });
  const workspace = new RuntimeMcpWorkspacePort({
    integrationStore: store,
    runtime,
    bindings,
    snapshots
  });
  const capture = new CaptureService({
    encryptionKey: captureKeyFromEnv(),
    encryptionKeyId: process.env.SAMURAI_EXTERNAL_CAPTURE_KEY_ID ?? "default",
    store,
    authorization: {
      assertRead: (input) => assertCaptureAccess(connections, authorization, input, "read"),
      assertDelete: (input) => assertCaptureAccess(connections, authorization, input, "manage_settings")
    }
  });
  const retentionWorker = new CaptureRetentionWorker({
    capture,
    intervalMs: Number(process.env.SAMURAI_EXTERNAL_CAPTURE_RETENTION_INTERVAL_MS ?? 60 * 60 * 1_000),
    onError: (error) => console.warn("external_capture_retention_failed", error instanceof Error ? error.message : String(error))
  });
  retentionWorker.start();

  const publicBaseUrl = resolveExternalIntegrationPublicBaseUrl(options.config);
  const protectedResourceUrl = new URL("/mcp", publicBaseUrl).toString();
  const oauth = new OAuthService({
    store,
    connections,
    browserAuthorization: options.browserAuthorization ?? defaultBrowserAuthorization(options.config, publicBaseUrl),
    publicBaseUrl,
    protectedResourceUrl,
    dynamicClientRegistration: process.env.SAMURAI_EXTERNAL_INTEGRATION_DCR !== "0"
  });
  const approval = new ApprovalService({ store, publicBaseUrl });
  void approval.recoverExecuting().catch((error) => console.warn("external_approval_recovery_failed", error instanceof Error ? error.message : String(error)));
  const mcp = new McpProtocolServer({
    auth: oauth,
    workspace,
    approval,
    capture,
    mutationTools: publishedMutationTools(),
    allowedOrigins: [...(options.allowedOrigins ?? allowedOriginsFor(publicBaseUrl))],
    protectedResourceUrl
  });

  const handler = createExternalIntegrationHttpHandler({
    mcp,
    oauth,
    approval,
    connectors,
    capture,
    resourceUrl: protectedResourceUrl,
    trustedProxy: options.trustedProxy === true,
    hookRelayCommand: options.hookRelayCommand ?? process.env.SAMURAI_EXTERNAL_HOOK_COMMAND?.trim(),
    browserSession: options.browserSession ?? defaultBrowserSession(options.config, publicBaseUrl)
  });
  return {
    handler,
    close: () => retentionWorker.stop()
  };
}

export function resolveExternalIntegrationPublicBaseUrl(
  config: Pick<WorkspaceServerConfig, "publicBaseUrl" | "mode" | "publicNetwork" | "bindAddress" | "port">
): string {
  return config.publicBaseUrl
    ?? (config.mode === "self_host" && !config.publicNetwork
      ? `http://127.0.0.1:${config.port}`
      : `http://${config.bindAddress}:${config.port}`);
}

export function isPostgresExternalIntegrationPath(pathname: string): boolean {
  return pathname === "/mcp"
    || pathname === "/.well-known/oauth-authorization-server"
    || pathname === "/.well-known/oauth-protected-resource"
    || pathname.startsWith("/oauth/")
    || pathname.startsWith("/connectors")
    || pathname.startsWith("/capture/")
    || pathname.startsWith("/approval")
    || pathname.startsWith("/connector/");
}

export function externalIntegrationRequestWorkspaceId(
  request: { query?: Record<string, unknown>; body?: unknown; headers?: Record<string, unknown> },
  _config: Pick<WorkspaceServerConfig, "mode" | "selfHostWorkspaceId">
): string | undefined {
  // Self-host is a deployment mode, not a tenant selector.  Resolve the
  // requested Workspace through the same authenticated authorization path as
  // Hosted; a legacy configured Workspace ID is never a request fallback.
  const header = request.headers?.["x-samurai-workspace-id"];
  if (typeof header === "string" && header.trim()) return header.trim();
  const query = request.query?.workspace_id;
  if (typeof query === "string" && query.trim()) return query.trim();
  return findWorkspaceId(request.body);
}

async function assertCaptureAccess(
  connections: ReturnType<PostgresExternalAppIngressFactory["connectionLookup"]>,
  authorization: PostgresExternalRoomAuthorization,
  input: { workspaceId: string; connectionId: string; accountId: string; roomId: string },
  action: "read" | "manage_settings"
): Promise<void> {
  const connection = await connections.getExternalAppConnection(input.connectionId);
  if (!connection || connection.workspace_id !== input.workspaceId) throw new ExternalIntegrationError("connection_not_found");
  if (connection.status !== "active") throw new ExternalIntegrationError("connection_revoked");
  if (!connection.allowed_room_ids.includes(input.roomId)) throw new ExternalIntegrationError("room_binding_room_denied");
  const delegatedAccountId = connection.delegated_principal.kind === "human"
    ? connection.delegated_principal.participant_id
    : connection.delegated_principal.requested_by_participant_id;
  if (delegatedAccountId !== input.accountId) throw new ExternalIntegrationError("oauth_account_mismatch");
  const principal: ParticipantPrincipal = connection.delegated_principal.kind === "human"
    ? { kind: "human", participantId: connection.delegated_principal.participant_id }
    : { kind: "agent", agentId: connection.delegated_principal.agent_id, requestedByParticipantId: connection.delegated_principal.requested_by_participant_id };
  await authorization.withWorkspace(input.workspaceId).assertRoom(principal, input.roomId, action);
}

const supportedMutationOperations = [
  "artifact.create",
  "artifact.revise",
  "artifact.restore_revision",
  "collection.schema.save",
  "collection.record.create",
  "collection.patch.apply",
  "collection.record.delete",
  "wiki.proposal.create",
  "wiki.patch",
  "wiki.archive",
  "skill.candidate.create",
  "skill.patch",
  "resource.copy",
  "resource.move",
  "resource.promote",
  "resource.redact",
  "policy.change.request",
  "profile.change.request",
  "soul.change.request"
] as const;

function publishedMutationTools(): McpMutationToolDefinition[] {
  return supportedMutationOperations.flatMap((operation) => {
    const entry = getDomainCommandEntry(operation);
    if (!entry || entry.availability !== "active" || !entry.allowed_sources.includes("external_app")) return [];
    return [{
      name: `samurai.${operation}`,
      operation,
      description: entry.description,
      scopes: ["resource.write"],
      inputSchema: entry.input_schema,
      outputSchema: entry.output_schema
    }];
  });
}

function defaultBrowserSession(config: WorkspaceServerConfig, publicBaseUrl: string): OAuthBrowserSessionPort {
  const token = process.env.SAMURAI_OWNER_TOKEN?.trim();
  const configuredToken = token;
  const accountId = config.initialAdminId;
  const manager = token ? new OwnerTokenManager(token) : undefined;
  // Self-host has one explicitly configured owner Account and can safely use
  // the same deployment-local owner token on a public HTTPS origin. Hosted
  // deployments must inject their real login-session adapter; never infer a
  // tenant Account from a shared process token there.
  if (config.mode !== "self_host" || !manager || !configuredToken || !accountId) {
    return unavailableBrowserSession();
  }
  return {
    async getAccountId(request) {
      const ownerToken = ownerTokenFromRequest(request);
      if (!ownerToken || !manager.verify(ownerToken)) throw new ExternalIntegrationError("oauth_browser_session_required", "samurai_login_session_invalid");
      return accountId;
    },
    async assertCsrf(request) {
      const ownerToken = ownerTokenFromRequest(request);
      if (!ownerToken || !manager.verify(ownerToken)) throw new ExternalIntegrationError("oauth_browser_session_required", "samurai_login_session_invalid");
      const supplied = request.headers?.["x-samurai-csrf"] ?? request.headers?.["X-Samurai-CSRF"] ?? requestField(request.body, "csrf_token");
      const expected = createHmac("sha256", ownerToken).update("samurai-external-integration-csrf").digest("base64url");
      if (!supplied || !safeEqualText(supplied, expected)) throw new ExternalIntegrationError("oauth_browser_session_required", "oauth_csrf_invalid");
    },
    async getCsrfToken() {
      return createHmac("sha256", configuredToken).update("samurai-external-integration-csrf").digest("base64url");
    }
  };
}

function defaultBrowserAuthorization(config: WorkspaceServerConfig, publicBaseUrl: string): OAuthAccountAuthorizationPort {
  const accountId = config.initialAdminId;
  if (config.mode !== "self_host" || !accountId) {
    return { async assertBrowserAccount() { throw new ExternalIntegrationError("oauth_browser_session_required"); } };
  }
  return {
    async assertBrowserAccount(input) {
      if (input.accountId !== accountId) throw new ExternalIntegrationError("oauth_account_mismatch");
    }
  };
}

function unavailableBrowserSession(): OAuthBrowserSessionPort {
  return {
    async getAccountId() { throw new ExternalIntegrationError("oauth_browser_session_required", "samurai_login_session_adapter_required"); },
    async assertCsrf() { throw new ExternalIntegrationError("oauth_browser_session_required", "samurai_login_session_adapter_required"); }
  };
}

function ownerTokenFromRequest(request: ExternalIntegrationHttpRequest): string | undefined {
  const authorization = request.headers?.authorization ?? request.headers?.Authorization;
  const bearer = authorization?.match(/^Bearer\s+(\S+)$/i)?.[1];
  return bearer
    ?? request.headers?.["x-samurai-owner-token"]
    ?? request.headers?.["X-Samurai-Owner-Token"]
    ?? request.headers?.["x-samurai-browser-session"]
    ?? request.headers?.["X-Samurai-Browser-Session"]
    ?? cookieValue(request.headers?.cookie ?? request.headers?.Cookie, "samurai_owner_token")
    ?? cookieValue(request.headers?.cookie ?? request.headers?.Cookie, "samurai_browser_session");
}

function requestField(body: string | Record<string, unknown> | undefined, key: string): string | undefined {
  if (body && typeof body === "object") return typeof body[key] === "string" ? body[key] : undefined;
  if (typeof body !== "string") return undefined;
  return new URLSearchParams(body).get(key) ?? undefined;
}

function cookieValue(header: string | undefined, name: string): string | undefined {
  return header?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
}

function safeEqualText(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function captureKeyFromEnv(): Buffer | undefined {
  const value = process.env.SAMURAI_EXTERNAL_CAPTURE_KEY;
  if (!value) return undefined;
  const key = /^[0-9a-f]{64}$/i.test(value) ? Buffer.from(value, "hex") : Buffer.from(value, "base64url");
  if (key.length !== 32) throw new Error("SAMURAI_EXTERNAL_CAPTURE_KEY_must_be_32_bytes");
  return key;
}

function allowedOriginsFor(publicBaseUrl: string): string[] {
  const origin = new URL(publicBaseUrl).origin;
  return [...new Set([origin, "http://127.0.0.1", "http://localhost"])]
    .filter((value) => value !== "http://127.0.0.1" || isLoopbackUrl(publicBaseUrl));
}

function isLoopbackUrl(value: string): boolean {
  const hostname = new URL(value).hostname;
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function findWorkspaceId(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["workspace_id", "workspaceId"]) {
    if (typeof record[key] === "string" && record[key].trim()) return record[key].trim();
  }
  for (const child of Object.values(record)) {
    const nested = findWorkspaceId(child);
    if (nested) return nested;
  }
  return undefined;
}
