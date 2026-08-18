import { createHash, randomBytes } from "node:crypto";
import {
  ExternalIntegrationError,
  externalOAuthScopes,
  OAuthAuthorizationCodeSchema,
  OAuthAuthorizationRequestSchema,
  OAuthClientRegistrationSchema,
  OAuthGrantSchema,
  type ExternalAppConnectionLookup,
  type ExternalIntegrationAuthContext,
  type ExternalIntegrationStore,
  type ExternalOAuthScope,
  type OAuthAuthorizationCode,
  type OAuthAuthorizationRequest,
  type OAuthClientRegistration,
  type OAuthGrant
} from "./contracts.js";
import { hashOpaqueToken } from "./contracts.js";
import { appendAuditEvent, createAuditEvent } from "./audit.js";

const authorizationRequestTtlMs = 10 * 60 * 1000;
const authorizationCodeTtlMs = 60 * 1000;
const accessTokenTtlMs = 60 * 60 * 1000;
const refreshTokenTtlMs = 30 * 24 * 60 * 60 * 1000;

export interface OAuthAuthorizationInput {
  workspaceId: string;
  clientId: string;
  redirectUri: string;
  responseType: "code";
  scope: string;
  state: string;
  codeChallenge: string;
  codeChallengeMethod: "S256";
  resource?: string;
}

export interface OAuthAuthorizationStarted {
  requestId: string;
  authorizationUrl: string;
  request: OAuthAuthorizationRequest;
}

export interface OAuthTokenResponse {
  token_type: "Bearer";
  access_token: string;
  expires_in: number;
  refresh_token: string;
  scope: string;
}

export interface OAuthAccountAuthorizationPort {
  /** This is the browser-auth boundary. It must be backed by a logged-in
   * Samurai Account session in production; OAuth itself never trusts an
   * account ID posted by the MCP client. */
  assertBrowserAccount(input: { workspaceId: string; requestId: string; accountId: string }): Promise<void>;
}

export interface OAuthServiceOptions {
  store: ExternalIntegrationStore;
  connections: ExternalAppConnectionLookup;
  browserAuthorization: OAuthAccountAuthorizationPort;
  publicBaseUrl: string;
  /** Canonical protected MCP Resource. Query parameters such as project_ref
   * select a Binding, but never widen the OAuth token audience. */
  protectedResourceUrl?: string;
  now?: () => Date;
  random?: (bytes: number) => Buffer;
  dynamicClientRegistration?: boolean;
}

/** OAuth Authorization Code + PKCE service used by the MCP HTTP boundary.
 * Raw access and refresh tokens are returned once and only their hashes are
 * persisted. Account and Room authorization remain server-owned checks. */
export class OAuthService {
  private readonly now: () => Date;
  private readonly random: (bytes: number) => Buffer;
  private readonly protectedResourceUrl: string;

  constructor(private readonly options: OAuthServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.random = options.random ?? randomBytes;
    const parsed = new URL(options.publicBaseUrl);
    if (parsed.protocol !== "https:" && parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
      throw new ExternalIntegrationError("oauth_redirect_uri_mismatch", "public_base_url_must_be_https");
    }
    this.protectedResourceUrl = canonicalMcpResource(
      options.protectedResourceUrl ?? new URL("/mcp", options.publicBaseUrl).toString(),
      new URL("/mcp", options.publicBaseUrl).toString()
    );
  }

  async registerClient(input: OAuthClientRegistration): Promise<OAuthClientRegistration> {
    const client = OAuthClientRegistrationSchema.parse(input);
    const existing = await this.options.store.getRecord("oauth_client", client.client_id);
    if (existing) {
      if (existing.connector_id !== client.connector_id || existing.workspace_id !== client.workspace_id || existing.redirect_uris.join("\n") !== client.redirect_uris.join("\n")) {
        throw new ExternalIntegrationError("oauth_client_not_found", "oauth_client_identity_immutable");
      }
      return existing;
    }
    const created = await this.options.store.createRecord("oauth_client", client);
    await appendAuditEvent(this.options.store, { eventType: "oauth.client.registered", connectorId: client.connector_id, resourceType: "oauth_client", resourceId: client.client_id, data: { redirect_uri_count: client.redirect_uris.length, scope_count: client.allowed_scopes.length } });
    return created;
  }

  isDynamicClientRegistrationEnabled(): boolean {
    return this.options.dynamicClientRegistration === true;
  }

  async registerDynamicClient(input: {
    workspaceId?: string;
    clientName: string;
    connectorId: string;
    redirectUris: string[];
    allowedScopes: string[];
    resource?: string;
  }): Promise<OAuthClientRegistration> {
    if (!this.isDynamicClientRegistrationEnabled()) throw new ExternalIntegrationError("oauth_client_registration_forbidden");
    const resourceWorkspaceId = input.resource
      ? workspaceIdFromResource(input.resource, this.protectedResourceUrl, false)
      : undefined;
    if (input.workspaceId && resourceWorkspaceId && input.workspaceId !== resourceWorkspaceId) {
      throw new ExternalIntegrationError("oauth_resource_invalid", "oauth_resource_workspace_mismatch");
    }
    const workspaceId = input.workspaceId ?? resourceWorkspaceId;
    if (!workspaceId) throw new ExternalIntegrationError("mcp_invalid_arguments", "workspace_id_required");
    const manifest = await this.options.store.getRecord("connector_manifest", input.connectorId);
    if (!manifest || manifest.disabled_at) throw new ExternalIntegrationError("connector_disabled");
    const installation = (await this.options.store.listRecords("connector_installation", { workspaceId, connectorId: input.connectorId }))
      .find((candidate) => candidate.enabled && !candidate.disabled_at && candidate.version === manifest.version && candidate.package_checksum === manifest.package_checksum);
    if (!installation) throw new ExternalIntegrationError("connector_disabled");
    if (input.redirectUris.length === 0 || input.redirectUris.some((uri) => !redirectUriAllowedByManifest(uri, manifest))) {
      throw new ExternalIntegrationError("oauth_redirect_uri_mismatch");
    }
    const scopes = parseScopes(input.allowedScopes.join(" "));
    if (scopes.some((scope) => !manifest.requested_scopes.includes(scope))) {
      throw new ExternalIntegrationError("oauth_scope_invalid");
    }
    const registration = OAuthClientRegistrationSchema.safeParse({
      client_id: opaqueId("oauth_client", this.random),
      client_name: input.clientName,
      workspace_id: workspaceId,
      connector_id: input.connectorId,
      redirect_uris: input.redirectUris,
      allowed_scopes: scopes,
      public_client: true,
      created_at: this.now().toISOString()
    });
    if (!registration.success) throw new ExternalIntegrationError("mcp_invalid_arguments", "oauth_client_registration_invalid");
    return this.registerClient(registration.data);
  }

  async beginAuthorization(input: OAuthAuthorizationInput): Promise<OAuthAuthorizationStarted> {
    const client = await this.requireClient(input.clientId);
    if (client.workspace_id && client.workspace_id !== input.workspaceId) throw new ExternalIntegrationError("oauth_client_not_found", "oauth_client_workspace_mismatch");
    if (input.responseType !== "code") throw new ExternalIntegrationError("oauth_code_invalid", "response_type_code_required");
    if (!client.redirect_uris.includes(input.redirectUri)) throw new ExternalIntegrationError("oauth_redirect_uri_mismatch");
    if (input.codeChallengeMethod !== "S256" || input.codeChallenge.length < 43) throw new ExternalIntegrationError("oauth_pkce_required");
    const scopes = parseScopes(input.scope);
    if (scopes.some((scope) => !client.allowed_scopes.includes(scope))) {
      throw new ExternalIntegrationError("oauth_scope_invalid");
    }
    const resource = canonicalMcpResource(input.resource ?? this.protectedResourceUrl, this.protectedResourceUrl);
    const resourceWorkspaceId = input.resource ? workspaceIdFromResource(input.resource, this.protectedResourceUrl, false) : undefined;
    if (resourceWorkspaceId && resourceWorkspaceId !== input.workspaceId) {
      throw new ExternalIntegrationError("oauth_resource_invalid", "oauth_resource_workspace_mismatch");
    }
    const connection = await this.options.connections.getExternalAppConnectionByConnector({ workspaceId: input.workspaceId, connectorId: client.connector_id });
    if (!connection) throw new ExternalIntegrationError("connection_not_found");
    if (connection.status !== "active") throw new ExternalIntegrationError("connection_revoked");
    await this.assertCurrentConnector(connection, input.workspaceId);
    const now = this.now();
    const request = OAuthAuthorizationRequestSchema.parse({
      id: opaqueId("oauth_request", this.random),
      workspace_id: input.workspaceId,
      state: input.state,
      state_hash: hashOpaqueToken(input.state),
      client_id: client.client_id,
      connector_id: client.connector_id,
      redirect_uri: input.redirectUri,
      scopes,
      code_challenge: input.codeChallenge,
      code_challenge_method: "S256",
      response_type: "code",
      resource,
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + authorizationRequestTtlMs).toISOString()
    });
    const audit = createAuditEvent({ eventType: "oauth.authorization.started", workspaceId: request.workspace_id, connectorId: request.connector_id, resourceType: "oauth_authorization_request", resourceId: request.id, data: { client_id: request.client_id, scope_count: request.scopes.length } });
    if (!await this.options.store.atomic([
      { kind: "create", type: "oauth_authorization_request", record: request },
      { kind: "create", type: "audit_event", record: audit }
    ])) throw new ExternalIntegrationError("mcp_outcome_unknown", "oauth_authorization_request_outcome_unknown", false);
    const url = new URL("/oauth/authorize", this.options.publicBaseUrl);
    url.searchParams.set("request_id", request.id);
    return { requestId: request.id, authorizationUrl: url.toString(), request };
  }

  async approveAuthorization(input: { requestId: string; accountId: string }): Promise<{ redirectUri: string; code: string; state: string }> {
    const request = await this.requireRequest(input.requestId);
    if (request.denied_at) throw new ExternalIntegrationError("oauth_authorization_denied");
    if (request.approved_at || request.consumed_at) throw new ExternalIntegrationError("oauth_code_replayed");
    this.assertNotExpired(request.expires_at, "oauth_code_expired");
    if (hashOpaqueToken(request.state) !== request.state_hash) throw new ExternalIntegrationError("oauth_state_invalid");
    await this.options.browserAuthorization.assertBrowserAccount({ workspaceId: request.workspace_id, requestId: request.id, accountId: input.accountId });
    const connection = await this.options.connections.getExternalAppConnectionByConnector({ workspaceId: request.workspace_id, connectorId: request.connector_id });
    if (!connection) throw new ExternalIntegrationError("connection_not_found");
    if (connection.status !== "active") throw new ExternalIntegrationError("connection_revoked");
    assertConnectionAccount(connection, input.accountId);
    // A request can remain open while an operator disables or upgrades the
    // Connector. Do not issue a Code for an Installation that is no longer
    // the current Workspace version; the browser approval must observe the
    // same live capability check as token exchange and MCP calls.
    await this.assertCurrentConnector(connection, request.workspace_id);
    const requestVersion = await this.options.store.getRecordVersion("oauth_authorization_request", request.id);
    if (!requestVersion) throw new ExternalIntegrationError("oauth_code_invalid");
    const approved = OAuthAuthorizationRequestSchema.parse({ ...request, authorized_account_id: input.accountId, authorized_subject: input.accountId, approved_at: this.now().toISOString() });
    const code = this.random(32).toString("base64url");
    const codeRecord = OAuthAuthorizationCodeSchema.parse({
      id: opaqueId("oauth_code", this.random),
      workspace_id: request.workspace_id,
      code_hash: hashOpaqueToken(code),
      request_id: request.id,
      client_id: request.client_id,
      account_id: input.accountId,
      subject: request.authorized_subject ?? input.accountId,
      scopes: request.scopes,
      redirect_uri: request.redirect_uri,
      resource: request.resource,
      code_challenge: request.code_challenge,
      created_at: this.now().toISOString(),
      expires_at: new Date(this.now().getTime() + authorizationCodeTtlMs).toISOString()
    });
    const audit = createAuditEvent({ eventType: "oauth.authorization.approved", workspaceId: request.workspace_id, accountId: input.accountId, connectorId: request.connector_id, resourceType: "oauth_authorization_request", resourceId: request.id, data: { client_id: request.client_id } });
    if (!await this.options.store.atomic([
      { kind: "update", type: "oauth_authorization_request", id: request.id, expectedVersion: requestVersion, record: approved },
      { kind: "create", type: "oauth_authorization_code", record: codeRecord },
      { kind: "create", type: "audit_event", record: audit }
    ])) throw new ExternalIntegrationError("oauth_code_replayed");
    const redirect = new URL(request.redirect_uri);
    redirect.searchParams.set("code", code);
    redirect.searchParams.set("state", request.state);
    return { redirectUri: redirect.toString(), code, state: request.state };
  }

  async denyAuthorization(input: { requestId: string; accountId: string }): Promise<OAuthAuthorizationRequest> {
    const request = await this.requireRequest(input.requestId);
    if (request.denied_at) throw new ExternalIntegrationError("oauth_authorization_denied");
    if (request.approved_at || request.consumed_at) throw new ExternalIntegrationError("oauth_code_replayed");
    this.assertNotExpired(request.expires_at, "oauth_code_expired");
    await this.options.browserAuthorization.assertBrowserAccount({ workspaceId: request.workspace_id, requestId: request.id, accountId: input.accountId });
    const connection = await this.options.connections.getExternalAppConnectionByConnector({ workspaceId: request.workspace_id, connectorId: request.connector_id });
    if (!connection) throw new ExternalIntegrationError("connection_not_found");
    if (connection.status !== "active") throw new ExternalIntegrationError("connection_revoked");
    assertConnectionAccount(connection, input.accountId);
    const version = await this.options.store.getRecordVersion("oauth_authorization_request", request.id);
    if (!version) throw new ExternalIntegrationError("oauth_code_invalid");
    const denied = OAuthAuthorizationRequestSchema.parse({ ...request, denied_at: this.now().toISOString(), denied_by: input.accountId });
    const audit = createAuditEvent({ eventType: "oauth.authorization.denied", workspaceId: request.workspace_id, accountId: input.accountId, connectorId: request.connector_id, resourceType: "oauth_authorization_request", resourceId: request.id, data: { client_id: request.client_id } });
    if (!await this.options.store.atomic([
      { kind: "update", type: "oauth_authorization_request", id: request.id, expectedVersion: version, record: denied },
      { kind: "create", type: "audit_event", record: audit }
    ])) throw new ExternalIntegrationError("oauth_code_replayed");
    return denied;
  }

  async getAuthorizationRequest(requestId: string): Promise<OAuthAuthorizationRequest> {
    return this.requireRequest(requestId);
  }

  async exchangeCode(input: { workspaceId?: string; clientId: string; clientSecret?: string; code: string; redirectUri: string; codeVerifier: string; resource?: string }): Promise<OAuthTokenResponse> {
    const client = await this.requireClient(input.clientId);
    if (!client.redirect_uris.includes(input.redirectUri)) throw new ExternalIntegrationError("oauth_redirect_uri_mismatch");
    if (!client.public_client && (!input.clientSecret || !client.client_secret_hash || hashOpaqueToken(input.clientSecret) !== client.client_secret_hash)) {
      throw new ExternalIntegrationError("oauth_code_invalid", "oauth_client_secret_invalid");
    }
    const codeHash = hashOpaqueToken(input.code);
    const code = (await this.options.store.listRecords("oauth_authorization_code")).find((candidate) => candidate.code_hash === codeHash);
    if (!code || (input.workspaceId && code.workspace_id !== input.workspaceId) || code.client_id !== input.clientId) throw new ExternalIntegrationError("oauth_code_invalid");
    if (code.consumed_at) throw new ExternalIntegrationError("oauth_code_replayed");
    this.assertNotExpired(code.expires_at, "oauth_code_expired");
    if (base64UrlSha256(input.codeVerifier) !== code.code_challenge) throw new ExternalIntegrationError("oauth_pkce_required", "pkce_verifier_invalid");
    const requestedResource = canonicalMcpResource(input.resource ?? this.protectedResourceUrl, this.protectedResourceUrl);
    const codeResource = canonicalMcpResource(code.resource ?? this.protectedResourceUrl, this.protectedResourceUrl);
    if (requestedResource !== codeResource) throw new ExternalIntegrationError("oauth_resource_invalid", "oauth_token_resource_mismatch");
    const connection = await this.options.connections.getExternalAppConnectionByConnector({ workspaceId: code.workspace_id, connectorId: client.connector_id });
    if (!connection) throw new ExternalIntegrationError("connection_not_found");
    if (connection.status !== "active") throw new ExternalIntegrationError("connection_revoked");
    assertConnectionAccount(connection, code.account_id);
    await this.assertCurrentConnector(connection, code.workspace_id);
    const accessToken = this.random(32).toString("base64url");
    const refreshToken = this.random(48).toString("base64url");
    const now = this.now();
    const grant = OAuthGrantSchema.parse({
      id: opaqueId("oauth_grant", this.random),
      workspace_id: code.workspace_id,
      client_id: code.client_id,
      connection_id: connection.id,
      account_id: code.account_id,
      subject: code.subject,
      scope: code.scopes,
      resource: codeResource,
      access_token_hash: hashOpaqueToken(accessToken),
      refresh_token_hash: hashOpaqueToken(refreshToken),
      issued_at: now.toISOString(),
      access_expires_at: new Date(now.getTime() + accessTokenTtlMs).toISOString(),
      refresh_expires_at: new Date(now.getTime() + refreshTokenTtlMs).toISOString(),
      token_version: 1
    });
    const codeVersion = await this.options.store.getRecordVersion("oauth_authorization_code", code.id);
    const audit = createAuditEvent({ eventType: "oauth.grant.issued", workspaceId: grant.workspace_id, connectionId: grant.connection_id, accountId: grant.account_id, resourceType: "oauth_grant", resourceId: grant.id, data: { client_id: grant.client_id, token_version: grant.token_version } });
    if (!codeVersion || !await this.options.store.atomic([
      { kind: "update", type: "oauth_authorization_code", id: code.id, expectedVersion: codeVersion, record: { ...code, consumed_at: this.now().toISOString() } },
      { kind: "create", type: "oauth_grant", record: grant },
      { kind: "create", type: "audit_event", record: audit }
    ])) throw new ExternalIntegrationError("oauth_code_replayed");
    return tokenResponse(accessToken, refreshToken, grant, this.now());
  }

  async authenticateAccessToken(accessToken: string, input: { resourceUrl?: string } = {}): Promise<ExternalIntegrationAuthContext> {
    const hash = hashOpaqueToken(accessToken);
    const grant = (await this.options.store.listRecords("oauth_grant")).find((candidate) => candidate.access_token_hash === hash);
    if (!grant || grant.revoked_at) throw new ExternalIntegrationError("oauth_grant_revoked");
    this.assertNotExpired(grant.access_expires_at, "oauth_token_expired");
    const expectedResource = canonicalMcpResource(input.resourceUrl ?? this.protectedResourceUrl, this.protectedResourceUrl);
    const grantResource = canonicalMcpResource(grant.resource ?? this.protectedResourceUrl, this.protectedResourceUrl);
    if (grantResource !== expectedResource) throw new ExternalIntegrationError("oauth_resource_invalid", "oauth_token_resource_mismatch");
    const connection = await this.options.connections.getExternalAppConnection(grant.connection_id);
    if (!connection) throw new ExternalIntegrationError("connection_not_found");
    if (connection.status !== "active") throw new ExternalIntegrationError("connection_revoked");
    assertConnectionAccount(connection, grant.account_id);
    await this.assertCurrentConnector(connection, grant.workspace_id);
    return {
      workspaceId: grant.workspace_id,
      accountId: grant.account_id,
      connectionId: grant.connection_id,
      connectorId: connection.connector_id,
      appId: connection.app_id,
      scopes: grant.scope,
      tokenVersion: grant.token_version,
      expiresAt: grant.access_expires_at
    };
  }

  async refreshAccessToken(input: { refreshToken: string; clientId: string; resource?: string }): Promise<OAuthTokenResponse> {
    const refreshHash = hashOpaqueToken(input.refreshToken);
    const grant = (await this.options.store.listRecords("oauth_grant")).find((candidate) => candidate.refresh_token_hash === refreshHash);
    if (!grant || grant.revoked_at) {
      const replayed = (await this.options.store.listRecords("oauth_grant")).find((candidate) => candidate.refresh_token_hash_history.includes(refreshHash));
      if (replayed && !replayed.revoked_at) await this.revokeGrantRecord(replayed.id);
      throw new ExternalIntegrationError("oauth_refresh_replayed");
    }
    const client = await this.requireClient(input.clientId);
    const connection = await this.options.connections.getExternalAppConnection(grant.connection_id);
    if (!connection || grant.client_id !== client.client_id || connection.connector_id !== client.connector_id || connection.status !== "active") throw new ExternalIntegrationError("connection_revoked");
    assertConnectionAccount(connection, grant.account_id);
    await this.assertCurrentConnector(connection, grant.workspace_id);
    const requestedResource = canonicalMcpResource(input.resource ?? this.protectedResourceUrl, this.protectedResourceUrl);
    const grantResource = canonicalMcpResource(grant.resource ?? this.protectedResourceUrl, this.protectedResourceUrl);
    if (requestedResource !== grantResource) throw new ExternalIntegrationError("oauth_resource_invalid", "oauth_token_resource_mismatch");
    this.assertNotExpired(grant.refresh_expires_at, "oauth_token_expired");
    const accessToken = this.random(32).toString("base64url");
    const refreshToken = this.random(48).toString("base64url");
    const now = this.now();
    const next: OAuthGrant = {
      ...grant,
      access_token_hash: hashOpaqueToken(accessToken),
      refresh_token_hash: hashOpaqueToken(refreshToken),
      refresh_token_hash_history: [...grant.refresh_token_hash_history, grant.refresh_token_hash].slice(-10),
      issued_at: now.toISOString(),
      access_expires_at: new Date(now.getTime() + accessTokenTtlMs).toISOString(),
      refresh_expires_at: new Date(now.getTime() + refreshTokenTtlMs).toISOString(),
      token_version: grant.token_version + 1
    };
    const version = await this.options.store.getRecordVersion("oauth_grant", grant.id);
    const audit = createAuditEvent({ eventType: "oauth.grant.refreshed", workspaceId: grant.workspace_id, connectionId: grant.connection_id, accountId: grant.account_id, resourceType: "oauth_grant", resourceId: grant.id, data: { token_version: next.token_version } });
    if (!version || !await this.options.store.atomic([
      { kind: "update", type: "oauth_grant", id: grant.id, expectedVersion: version, record: next },
      { kind: "create", type: "audit_event", record: audit }
    ])) throw new ExternalIntegrationError("oauth_refresh_replayed");
    return tokenResponse(accessToken, refreshToken, next, this.now());
  }

  async revokeGrant(grantId: string, identity?: { accountId: string; clientId: string }): Promise<boolean> {
    if (!identity) throw new ExternalIntegrationError("oauth_browser_session_required");
    const grant = await this.options.store.getRecord("oauth_grant", grantId);
    if (!grant || grant.revoked_at) return false;
    const client = await this.requireClient(identity.clientId);
    if (grant.client_id !== client.client_id) throw new ExternalIntegrationError("oauth_client_not_found");
    if (grant.account_id !== identity.accountId) throw new ExternalIntegrationError("oauth_account_mismatch");
    return this.revokeGrantRecord(grantId);
  }

  private async revokeGrantRecord(grantId: string): Promise<boolean> {
    const grant = await this.options.store.getRecord("oauth_grant", grantId);
    if (!grant || grant.revoked_at) return false;
    const version = await this.options.store.getRecordVersion("oauth_grant", grantId);
    const audit = createAuditEvent({ eventType: "oauth.grant.revoked", workspaceId: grant.workspace_id, connectionId: grant.connection_id, accountId: grant.account_id, resourceType: "oauth_grant", resourceId: grant.id });
    const revoked = Boolean(version && await this.options.store.atomic([
      { kind: "update", type: "oauth_grant", id: grantId, expectedVersion: version, record: { ...grant, revoked_at: this.now().toISOString() } },
      { kind: "create", type: "audit_event", record: audit }
    ]));
    return revoked;
  }

  async revokeToken(token: string, identity?: { accountId: string; clientId: string }): Promise<boolean> {
    const hash = hashOpaqueToken(token);
    const grant = (await this.options.store.listRecords("oauth_grant")).find((candidate) => candidate.access_token_hash === hash || candidate.refresh_token_hash === hash);
    return grant ? this.revokeGrant(grant.id, identity) : false;
  }

  metadata(): Record<string, unknown> {
    const base = this.options.publicBaseUrl.replace(/\/$/, "");
    return {
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      revocation_endpoint: `${base}/oauth/revoke`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
      scopes_supported: [...externalOAuthScopes],
      // This server does not fetch arbitrary Client-hosted metadata documents.
      // Clients can use a pre-registration or the bounded DCR endpoint below.
      client_id_metadata_document_supported: false,
      ...(this.isDynamicClientRegistrationEnabled() ? { registration_endpoint: `${base}/oauth/register` } : {})
    };
  }

  /** Browser-facing Connector management has a separate login Session check
   * at the HTTP boundary. This verifies the currently enabled Connection is
   * still owned by that same Account and Workspace before an Installation is
   * listed or changed. */
  async assertBrowserWorkspace(input: { workspaceId: string; accountId: string; requestId: string }): Promise<void> {
    await this.options.browserAuthorization.assertBrowserAccount({
      workspaceId: input.workspaceId,
      accountId: input.accountId,
      requestId: input.requestId
    });
  }

  async assertBrowserConnection(input: { workspaceId: string; connectorId: string; accountId: string }): Promise<void> {
    const connection = await this.options.connections.getExternalAppConnectionByConnector({
      workspaceId: input.workspaceId,
      connectorId: input.connectorId
    });
    await this.assertLiveBrowserConnection(connection, input);
  }

  async assertBrowserConnectionId(input: { workspaceId: string; connectionId: string; accountId: string }): Promise<void> {
    const connection = await this.options.connections.getExternalAppConnection(input.connectionId);
    await this.assertLiveBrowserConnection(connection, input);
  }

  private async assertLiveBrowserConnection(
    connection: Awaited<ReturnType<ExternalAppConnectionLookup["getExternalAppConnection"]>>,
    input: { workspaceId: string; accountId: string }
  ): Promise<void> {
    if (!connection) throw new ExternalIntegrationError("connection_not_found");
    if (connection.workspace_id !== input.workspaceId) throw new ExternalIntegrationError("connection_not_found");
    if (connection.status !== "active") throw new ExternalIntegrationError("connection_revoked");
    assertConnectionAccount(connection, input.accountId);
    await this.assertCurrentConnector(connection, input.workspaceId);
  }

  private async requireClient(clientId: string): Promise<OAuthClientRegistration> {
    const client = await this.options.store.getRecord("oauth_client", clientId);
    if (!client || client.disabled_at) throw new ExternalIntegrationError("oauth_client_not_found");
    return OAuthClientRegistrationSchema.parse(client);
  }

  private async requireRequest(requestId: string): Promise<OAuthAuthorizationRequest> {
    const request = await this.options.store.getRecord("oauth_authorization_request", requestId);
    if (!request) throw new ExternalIntegrationError("oauth_code_invalid");
    return OAuthAuthorizationRequestSchema.parse(request);
  }

  private async assertCurrentConnector(connection: NonNullable<Awaited<ReturnType<ExternalAppConnectionLookup["getExternalAppConnection"]>>>, workspaceId: string): Promise<void> {
    const manifest = await this.options.store.getRecord("connector_manifest", connection.connector_id);
    const currentInstallation = (await this.options.store.listRecords("connector_installation", { workspaceId, connectorId: connection.connector_id }))
      .filter((item) => item.enabled && !item.disabled_at)
      .sort((left, right) => right.installed_at.localeCompare(left.installed_at))[0];
    if (!manifest || manifest.disabled_at || !currentInstallation) throw new ExternalIntegrationError("connector_disabled");
    if (currentInstallation.version !== manifest.version || currentInstallation.package_checksum !== manifest.package_checksum) {
      throw new ExternalIntegrationError("connector_version_unsupported");
    }
  }

  private assertNotExpired(value: string, code: "oauth_code_expired" | "oauth_token_expired"): void {
    if (new Date(value).getTime() <= this.now().getTime()) throw new ExternalIntegrationError(code);
  }
}

function parseScopes(value: string): ExternalOAuthScope[] {
  const scopes = [...new Set(value.trim().split(/\s+/).filter(Boolean))];
  if (scopes.length === 0) throw new ExternalIntegrationError("oauth_scope_invalid");
  const allowed = new Set<ExternalOAuthScope>(["workspace.read", "room.read", "knowledge.read", "skill.read", "artifact.read", "collection.read", "activity.read", "resource.write", "activity.ingest", "approval.execute", "room.binding.write"]);
  if (scopes.some((scope) => !allowed.has(scope as ExternalOAuthScope))) throw new ExternalIntegrationError("oauth_scope_invalid");
  return scopes as ExternalOAuthScope[];
}

function opaqueId(prefix: string, random: (bytes: number) => Buffer): string {
  return `${prefix}_${random(16).toString("hex")}`;
}

function assertConnectionAccount(connection: Awaited<ReturnType<ExternalAppConnectionLookup["getExternalAppConnection"]>>, accountId: string): void {
  if (!connection) throw new ExternalIntegrationError("connection_not_found");
  const delegatedAccountId = connection.delegated_principal.kind === "human"
    ? connection.delegated_principal.participant_id
    : connection.delegated_principal.requested_by_participant_id;
  if (delegatedAccountId !== accountId) throw new ExternalIntegrationError("oauth_account_mismatch");
}

function base64UrlSha256(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function redirectUriAllowedByManifest(value: string, manifest: { oauth_redirect_uris: string[]; oauth_redirect_uri_policy: "exact" | "loopback" }): boolean {
  if (manifest.oauth_redirect_uri_policy === "exact") return manifest.oauth_redirect_uris.includes(value);
  try {
    const url = new URL(value);
    const loopbackHost = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    return (url.protocol === "http:" || url.protocol === "https:")
      && loopbackHost
      && Boolean(url.port)
      && !url.username
      && !url.password
      && !url.search
      && !url.hash
      && url.pathname.startsWith("/");
  } catch {
    return false;
  }
}

/** `project_ref` may be part of the MCP endpoint URL, but it must not create
 * a different OAuth audience. The only accepted audience is the server's
 * canonical `/mcp` endpoint. */
function canonicalMcpResource(value: string, expected: string): string {
  let requested: URL;
  let protectedResource: URL;
  try {
    requested = new URL(value);
    protectedResource = new URL(expected);
  } catch {
    throw new ExternalIntegrationError("oauth_resource_invalid", "oauth_resource_url_invalid");
  }
  if (requested.username || requested.password || requested.hash
    || requested.protocol !== protectedResource.protocol
    || requested.host !== protectedResource.host
    || requested.pathname !== protectedResource.pathname) {
    throw new ExternalIntegrationError("oauth_resource_invalid", "oauth_resource_mismatch");
  }
  protectedResource.search = "";
  protectedResource.hash = "";
  return protectedResource.toString();
}

function workspaceIdFromResource(value: string | undefined, expected: string, required: boolean): string | undefined {
  if (!value) throw new ExternalIntegrationError("mcp_invalid_arguments", "workspace_id_required");
  let resource: URL;
  try {
    resource = new URL(value);
  } catch {
    throw new ExternalIntegrationError("oauth_resource_invalid", "oauth_resource_url_invalid");
  }
  canonicalMcpResource(value, expected);
  const workspaceId = resource.searchParams.get("workspace_id")?.trim();
  if (!workspaceId && required) throw new ExternalIntegrationError("mcp_invalid_arguments", "workspace_id_required");
  return workspaceId;
}

function tokenResponse(accessToken: string, refreshToken: string, grant: OAuthGrant, now: Date): OAuthTokenResponse {
  return {
    token_type: "Bearer",
    access_token: accessToken,
    expires_in: Math.max(1, Math.floor((new Date(grant.access_expires_at).getTime() - now.getTime()) / 1_000)),
    refresh_token: refreshToken,
    scope: grant.scope.join(" ")
  };
}
