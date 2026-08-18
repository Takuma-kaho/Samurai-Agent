import {
  ApprovalService,
  CaptureService,
  CaptureRetentionWorker,
  ConnectorRegistry,
  ContextSnapshotService,
  ExternalIntegrationError,
  McpProtocolServer,
  OAuthService,
  RoomBindingService,
  createExternalIntegrationHttpHandler,
  registerOfficialConnectorManifests,
  type McpMutationToolDefinition,
  type ExternalWorkspaceTarget,
  type ContextSnapshotSource,
  type ExternalIntegrationHttpRequest,
  type ExternalIntegrationHttpResponse,
  type OAuthAccountAuthorizationPort,
  type OAuthBrowserSessionPort
} from "@samurai-agent/external-integration";
import { createHmac, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { getDomainCommandEntry } from "@samurai-agent/domain-operations";
import { localOwnerParticipantId } from "@samurai-agent/room-permissions";
import type { AgentRuntime } from "@samurai-agent/runtime";
import { createRuntimeContextSnapshotSource, RuntimeMcpWorkspacePort } from "@samurai-agent/runtime";
import type { WorkspaceStore } from "@samurai-agent/workspace-store";
import { OwnerTokenManager } from "./middleware/security";

export interface CreateExternalIntegrationRuntimeOptions {
  publicBaseUrl: string;
  browserSession?: OAuthBrowserSessionPort;
  browserAuthorization?: OAuthAccountAuthorizationPort;
  contextSource?: (target: ExternalWorkspaceTarget) => Promise<ContextSnapshotSource>;
  allowedOrigins?: string[];
  /** Installed Client Hook relay command. Without it, connector config
   * reports Hook setup as incomplete instead of emitting a broken command. */
  hookRelayCommand?: string;
  /** Only set behind a proxy that strips and rewrites forwarded headers. */
  trustedProxy?: boolean;
  /** Same owner-token verifier used by the Native App HTTP boundary. */
  ownerTokenManager?: OwnerTokenManager;
}

export interface ExternalIntegrationRuntime {
  handler: (request: ExternalIntegrationHttpRequest) => Promise<ExternalIntegrationHttpResponse>;
  mcp: McpProtocolServer;
  oauth: OAuthService;
  approval: ApprovalService;
  capture: CaptureService;
  connectors: ConnectorRegistry;
  retentionWorker: CaptureRetentionWorker;
  close(): void;
}

export async function createExternalIntegrationRuntime(
  store: WorkspaceStore,
  runtime: AgentRuntime,
  options: CreateExternalIntegrationRuntimeOptions
): Promise<ExternalIntegrationRuntime> {
  const integrationStore = store.externalIntegration;
  const protectedResourceUrl = new URL("/mcp", options.publicBaseUrl).toString();
  const connectors = new ConnectorRegistry({ store: integrationStore, samuraiVersion: "0.1.0" });
  // Official Connectors are registered in the production composition. They
  // still need a per-Workspace Installation; no Connector is auto-enabled.
  await registerOfficialConnectorManifests(connectors);
  const bindings = new RoomBindingService({
    store: integrationStore,
    connections: store,
    defaultRoomId: async ({ workspaceId }) => {
      // SQLite WorkspaceStore is the local Workspace authority. The external
      // Workspace ID is still checked by the active Connection before use.
      return (await store.getSettings()).default_room_id;
    },
    authorization: runtime.externalIntegrationRoomAuthorization()
  });
  const snapshots = new ContextSnapshotService({
    store: integrationStore,
    source: options.contextSource ?? createRuntimeContextSnapshotSource({ runtime })
  });
  const port = new RuntimeMcpWorkspacePort({ integrationStore, runtime, bindings, snapshots });
  const roomAuthorization = runtime.externalIntegrationRoomAuthorization();
  const capture = new CaptureService({
    encryptionKey: captureKeyFromEnv(),
    encryptionKeyId: process.env.SAMURAI_EXTERNAL_CAPTURE_KEY_ID ?? "default",
    store: integrationStore,
    authorization: {
      assertRead: (input) => assertCaptureAccess(store, roomAuthorization, input, "read"),
      assertDelete: (input) => assertCaptureAccess(store, roomAuthorization, input, "manage_settings")
    }
  });
  const retentionWorker = new CaptureRetentionWorker({
    capture,
    intervalMs: Number(process.env.SAMURAI_EXTERNAL_CAPTURE_RETENTION_INTERVAL_MS ?? 60 * 60 * 1_000),
    onError: (error) => console.warn("external_capture_retention_failed", error instanceof Error ? error.message : String(error))
  });
  retentionWorker.start();
  const oauth = new OAuthService({
    store: integrationStore,
    connections: store,
    browserAuthorization: options.browserAuthorization ?? defaultBrowserAuthorization(options.publicBaseUrl),
    publicBaseUrl: options.publicBaseUrl,
    protectedResourceUrl,
    // DCR remains bounded by an active Workspace Installation, manifest
    // callback policy, supported scopes, and browser approval. Set 0 only
    // when an operator has pre-registered every Client explicitly.
    dynamicClientRegistration: process.env.SAMURAI_EXTERNAL_INTEGRATION_DCR !== "0"
  });
  const approval = new ApprovalService({ store: integrationStore, publicBaseUrl: options.publicBaseUrl });
  void approval.recoverExecuting().catch((error) => console.warn("external_approval_recovery_failed", error instanceof Error ? error.message : String(error)));
  const mcp = new McpProtocolServer({
    auth: oauth,
    workspace: port,
    approval,
    capture,
    mutationTools: publishedMutationTools(),
    allowedOrigins: options.allowedOrigins ?? allowedOriginsFor(options.publicBaseUrl),
    protectedResourceUrl
  });
  return {
    handler: createExternalIntegrationHttpHandler({
      mcp,
      oauth,
      approval,
      connectors,
      capture,
      resourceUrl: protectedResourceUrl,
      trustedProxy: options.trustedProxy === true,
      hookRelayCommand: options.hookRelayCommand ?? defaultHookRelayCommand(),
      browserSession: options.browserSession ?? createSamuraiLoginBrowserSession({
        publicBaseUrl: options.publicBaseUrl,
        ownerTokenManager: options.ownerTokenManager
      })
    }),
    mcp,
    oauth,
    approval,
    capture,
    connectors,
    retentionWorker,
    close: () => retentionWorker.stop()
  };
}

const externalMutationOperations = [
  "artifact.create",
  "artifact.revise",
  "artifact.restore_revision",
  "collection.schema.save",
  "collection.record.create",
  "collection.patch.apply",
  "collection.record.delete",
  // These create a proposal/candidate only. They cannot publish Knowledge or
  // promote a Skill, so an external Client still cannot alter human-owned
  // final state without the separate formal operation.
  "wiki.proposal.create",
  "wiki.patch",
  "wiki.archive",
  "skill.candidate.create",
  "skill.patch",
  // Cross-Room copy, move, and Workspace promotion always go through the
  // same approval, Room allow-list, and save-transaction checks.
  "resource.copy",
  "resource.move",
  "resource.promote",
  "resource.redact",
  // These only create durable human-review requests. No external Client can
  // directly write Policy, Profile, or Soul through this surface.
  "policy.change.request",
  "profile.change.request",
  "soul.change.request"
] as const;

function publishedMutationTools(): McpMutationToolDefinition[] {
  return externalMutationOperations.flatMap((operation) => {
    const entry = getDomainCommandEntry(operation);
    if (!entry || entry.availability !== "active" || !entry.allowed_sources.includes("external_app")) return [];
    return [{ name: `samurai.${operation}`, operation, description: entry.description, scopes: ["resource.write"], inputSchema: entry.input_schema, outputSchema: entry.output_schema }];
  });
}

async function assertCaptureAccess(
  store: WorkspaceStore,
  roomAuthorization: ReturnType<AgentRuntime["externalIntegrationRoomAuthorization"]>,
  input: { workspaceId: string; connectionId: string; accountId: string; roomId: string },
  action: "read" | "manage_settings"
): Promise<void> {
  const connection = await store.getExternalAppConnection(input.connectionId);
  if (!connection || connection.workspace_id !== input.workspaceId) throw new ExternalIntegrationError("connection_not_found");
  if (connection.status !== "active") throw new ExternalIntegrationError("connection_revoked");
  if (!connection.allowed_room_ids.includes(input.roomId)) throw new ExternalIntegrationError("room_binding_room_denied");
  const delegatedAccountId = connection.delegated_principal.kind === "human"
    ? connection.delegated_principal.participant_id
    : connection.delegated_principal.requested_by_participant_id;
  if (delegatedAccountId !== input.accountId) throw new ExternalIntegrationError("oauth_account_mismatch");
  await roomAuthorization.assertRoom(
    connection.delegated_principal.kind === "human"
      ? { kind: "human", participantId: connection.delegated_principal.participant_id }
      : { kind: "agent", agentId: connection.delegated_principal.agent_id, requestedByParticipantId: connection.delegated_principal.requested_by_participant_id },
    input.roomId,
    action
  );
}

function captureKeyFromEnv(): Buffer | undefined {
  const value = process.env.SAMURAI_EXTERNAL_CAPTURE_KEY;
  if (!value) return undefined;
  const key = /^[0-9a-f]{64}$/i.test(value) ? Buffer.from(value, "hex") : Buffer.from(value, "base64url");
  if (key.length !== 32) throw new Error("SAMURAI_EXTERNAL_CAPTURE_KEY_must_be_32_bytes");
  return key;
}

function allowedOriginsFor(publicBaseUrl: string): string[] {
  const base = new URL(publicBaseUrl).origin;
  return [...new Set([base, "http://127.0.0.1", "http://localhost"])];
}

function defaultBrowserSession(publicBaseUrl: string): OAuthBrowserSessionPort {
  if (!isExplicitDevelopmentMode(publicBaseUrl)) return unavailableBrowserSession();
  const configured = process.env.SAMURAI_OAUTH_BROWSER_ACCOUNT_ID;
  const sessionToken = process.env.SAMURAI_OAUTH_BROWSER_SESSION_TOKEN ?? process.env.SAMURAI_OWNER_TOKEN;
  const csrfToken = process.env.SAMURAI_OAUTH_CSRF_TOKEN ?? sessionToken;
  return {
    async getAccountId(request) {
      if (!configured || !sessionToken) throw new ExternalIntegrationError("oauth_browser_session_required");
      const supplied = request.headers?.["x-samurai-browser-session"]
        ?? request.headers?.["X-Samurai-Browser-Session"]
        ?? cookieValue(request.headers?.cookie ?? request.headers?.Cookie, "samurai_browser_session");
      if (supplied !== sessionToken) throw new ExternalIntegrationError("oauth_browser_session_required");
      return configured;
    },
    async assertCsrf(request) {
      if (!csrfToken) throw new ExternalIntegrationError("oauth_browser_session_required", "oauth_csrf_required");
      const supplied = request.headers?.["x-samurai-csrf"]
        ?? request.headers?.["X-Samurai-CSRF"]
        ?? requestField(request.body, "csrf_token");
      if (supplied !== csrfToken) throw new ExternalIntegrationError("oauth_browser_session_required", "oauth_csrf_invalid");
    },
    async getCsrfToken() {
      return csrfToken;
    }
  };
}

/** Production default: reuse the Native App owner-token login. A static
 * development Account remains available only behind an explicit local flag. */
function createSamuraiLoginBrowserSession(input: {
  publicBaseUrl: string;
  ownerTokenManager?: OwnerTokenManager;
}): OAuthBrowserSessionPort {
  if (isExplicitDevelopmentMode(input.publicBaseUrl)) return defaultBrowserSession(input.publicBaseUrl);
  const ownerTokenManager = input.ownerTokenManager ?? ownerTokenManagerFromEnv();
  if (!ownerTokenManager) return unavailableBrowserSession();
  return {
    async getAccountId(request) {
      const token = ownerTokenFromRequest(request);
      if (!ownerTokenManager.verify(token)) throw new ExternalIntegrationError("oauth_browser_session_required", "samurai_login_session_invalid");
      return localOwnerParticipantId;
    },
    async assertCsrf(request) {
      const token = ownerTokenFromRequest(request);
      if (!ownerTokenManager.verify(token)) throw new ExternalIntegrationError("oauth_browser_session_required", "samurai_login_session_invalid");
      const expected = csrfTokenForOwnerSession(token);
      const supplied = request.headers?.["x-samurai-csrf"]
        ?? request.headers?.["X-Samurai-CSRF"]
        ?? requestField(request.body, "csrf_token");
      if (!supplied || !safeEqualText(supplied, expected)) {
        throw new ExternalIntegrationError("oauth_browser_session_required", "oauth_csrf_invalid");
      }
    },
    async getCsrfToken(request) {
      const token = ownerTokenFromRequest(request);
      if (!ownerTokenManager.verify(token)) throw new ExternalIntegrationError("oauth_browser_session_required", "samurai_login_session_invalid");
      return csrfTokenForOwnerSession(token);
    }
  };
}

function defaultBrowserAuthorization(publicBaseUrl: string): OAuthAccountAuthorizationPort {
  if (isExplicitDevelopmentMode(publicBaseUrl)) {
    const configured = process.env.SAMURAI_OAUTH_BROWSER_ACCOUNT_ID;
    return {
      async assertBrowserAccount(input) {
        if (!configured) throw new ExternalIntegrationError("oauth_browser_session_required");
        if (input.accountId !== configured) throw new ExternalIntegrationError("oauth_account_mismatch");
      }
    };
  }
  return {
    async assertBrowserAccount(input) {
      if (input.accountId !== localOwnerParticipantId) throw new ExternalIntegrationError("oauth_account_mismatch");
    }
  };
}

function defaultHookRelayCommand(): string | undefined {
  const configured = process.env.SAMURAI_EXTERNAL_HOOK_COMMAND?.trim();
  if (configured) return configured;
  const hookScript = path.resolve(process.cwd(), "scripts/external-integration-hook.ts");
  return `pnpm --dir ${shellSingleQuote(process.cwd())} exec tsx ${shellSingleQuote(hookScript)}`;
}

function ownerTokenManagerFromEnv(): OwnerTokenManager | undefined {
  const token = process.env.SAMURAI_OWNER_TOKEN;
  return token ? new OwnerTokenManager(token) : undefined;
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

function csrfTokenForOwnerSession(ownerToken: string | undefined): string {
  if (!ownerToken) throw new ExternalIntegrationError("oauth_browser_session_required", "oauth_csrf_required");
  return createHmac("sha256", ownerToken).update("samurai-external-integration-csrf").digest("base64url");
}

function safeEqualText(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\"'\"'")}'`;
}

/** A static account is permitted only for an explicit local development run.
 * Hosted and self-hosted production composition injects the real Samurai
 * login-session adapters through CreateExternalIntegrationRuntimeOptions. */
function isExplicitDevelopmentMode(publicBaseUrl: string): boolean {
  return process.env.SAMURAI_EXTERNAL_INTEGRATION_DEV_MODE === "1" && isLoopbackUrl(publicBaseUrl);
}

function unavailableBrowserSession(): OAuthBrowserSessionPort {
  return {
    async getAccountId() { throw new ExternalIntegrationError("oauth_browser_session_required", "samurai_login_session_adapter_required"); },
    async assertCsrf() { throw new ExternalIntegrationError("oauth_browser_session_required", "samurai_login_session_adapter_required"); }
  };
}

function isLoopbackUrl(value: string): boolean {
  const url = new URL(value);
  return url.hostname === "localhost" || url.hostname === "127.0.0.1";
}

function cookieValue(header: string | undefined, name: string): string | undefined {
  return header?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
}

function requestField(body: string | Record<string, unknown> | undefined, key: string): string | undefined {
  if (body && typeof body === "object") return typeof body[key] === "string" ? body[key] : undefined;
  if (typeof body !== "string") return undefined;
  return new URLSearchParams(body).get(key) ?? undefined;
}
