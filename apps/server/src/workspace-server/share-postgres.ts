import { createHash, createPublicKey, verify } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request as httpsRequest } from "node:https";
import {
  PublicShareDelegationSchema,
  PublicShareLocatorSchema,
  PublicShareOriginSchema,
  type PublicShareDelegation
} from "@samurai-agent/domain-api";
import {
  assertSafeRelativePath,
  canonicalJson,
  accountIdFromPublicKey,
  type PostgresWorkspaceDatabase,
  type WorkspaceCompletionResource,
  type WorkspaceCompletionService,
  type WorkspaceDatabaseContext,
  type WorkspaceRequestContext,
  type WorkspaceServerStore,
  type WorkspaceShareAuthorizationRequest,
  type WorkspaceShareAuthorizationResolver,
  type WorkspaceShareContext,
  type WorkspaceShareImportCommitter,
  type WorkspaceShareImportInput,
  type WorkspaceShareImportTransport,
  type WorkspaceShareImportTransportResult,
  type WorkspaceShareKind,
  type WorkspaceShareManifest,
  type WorkspaceShareResourceRef,
  type WorkspaceShareSourcePort,
  type WorkspaceShareSourceSnapshot,
  type WorkspaceSql
} from "@samurai-agent/workspace-server";
import { WorkspaceServerError } from "@samurai-agent/workspace-server";

/** A narrow database seam is used instead of constructing a Pool in this
 * adapter.  The Server composition root owns the runtime role and the
 * database URL; every callback is therefore executed inside the existing
 * transaction-local RLS context. */
export type WorkspaceSharePostgresDatabase = Pick<PostgresWorkspaceDatabase, "withContext">;

export interface WorkspaceShareRlsContext extends Pick<WorkspaceDatabaseContext, "accountId" | "workspaceId" | "caller" | "importId"> {
  /** Operation IDs are useful to a caller, but are not an import capability.
   * They are deliberately not copied into a PostgreSQL context setting. */
  operationId?: string;
}

export interface WorkspaceShareDatabase extends WorkspaceSharePostgresDatabase {
  withContext<T>(
    context: WorkspaceShareRlsContext,
    action: (sql: WorkspaceSql) => Promise<T>
  ): Promise<T>;
  withImportContext<T>(
    context: Omit<WorkspaceShareRlsContext, "importId">,
    importId: string,
    action: (sql: WorkspaceSql) => Promise<T>
  ): Promise<T>;
}

/** PostgreSQL adapter for the Workspace Share Core database port.  It passes
 * through only the trusted context fields accepted by PostgresWorkspaceDatabase;
 * in particular, an operation ID cannot accidentally become an import session. */
export class PostgresWorkspaceShareDatabase implements WorkspaceShareDatabase {
  constructor(private readonly database: WorkspaceSharePostgresDatabase) {}

  withContext<T>(context: WorkspaceShareRlsContext, action: (sql: WorkspaceSql) => Promise<T>): Promise<T> {
    return this.database.withContext(toDatabaseContext(context), action);
  }

  withImportContext<T>(
    context: Omit<WorkspaceShareRlsContext, "importId">,
    importId: string,
    action: (sql: WorkspaceSql) => Promise<T>
  ): Promise<T> {
    if (!importId.trim()) throw new WorkspaceServerError("workspace_share_import_session_invalid", 400);
    return this.database.withContext(toDatabaseContext({ ...context, importId }), action);
  }
}

export function createPostgresWorkspaceShareDatabase(database: WorkspaceSharePostgresDatabase): WorkspaceShareDatabase {
  return new PostgresWorkspaceShareDatabase(database);
}

function toDatabaseContext(context: WorkspaceShareRlsContext): WorkspaceDatabaseContext {
  return {
    accountId: context.accountId,
    ...(context.workspaceId === undefined ? {} : { workspaceId: context.workspaceId }),
    ...(context.caller === undefined ? {} : { caller: context.caller }),
    ...(context.importId === undefined ? {} : { importId: context.importId })
  };
}

export interface WorkspaceShareSnapshotReader {
  getResourceBody(
    context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">,
    resourceId: string,
    version: number
  ): Promise<{
    resource: WorkspaceCompletionResource;
    version: {
      version: number;
      contentHash: string;
      evidenceState: string;
      lifecycleState: string;
    };
    content: string;
  }>;
  listSkillFiles(
    context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">,
    resourceId: string,
    version: number
  ): Promise<readonly { relativePath: string; resourceVersion: number; contentHash: string; contentSize: number }[]>;
  getSkillFile(
    context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">,
    resourceId: string,
    relativePath: string,
    version: number
  ): Promise<{ file: { relativePath: string; resourceVersion: number; contentHash: string; contentSize: number }; content: Uint8Array }>;
}

export interface WorkspaceShareAgentReader {
  getAgent(
    context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">,
    agentId: string
  ): Promise<{
    workspaceId: string;
    id: string;
    displayName: string;
    role?: string;
    instructions?: string;
    description?: string;
    enabled?: boolean;
    status?: string;
  }>;
}

export interface PostgresWorkspaceShareSourceOptions {
  /** Existing Completion Core methods are the source of truth for RLS,
   * version, file-batch, and physical-file checks. */
  completion: WorkspaceShareSnapshotReader | Pick<WorkspaceCompletionService, "getResourceBody" | "listSkillFiles" | "getSkillFile">;
  agents: WorkspaceShareAgentReader | Pick<WorkspaceServerStore, "getAgent">;
  maxEntries?: number;
}

/**
 * Produces the fixed, portable copy accepted by WorkspaceShareService.  The
 * adapter intentionally does not call evidence/history APIs and never places
 * a source resource ID or internal file path in the manifest.  Agent shares
 * contain only the profile fields and selected Agent Knowledge/Skills.
 */
export class PostgresWorkspaceShareSource implements WorkspaceShareSourcePort {
  private readonly maxEntries: number;

  constructor(private readonly options: PostgresWorkspaceShareSourceOptions) {
    this.maxEntries = Math.max(1, Math.min(options.maxEntries ?? 1_000, 1_000));
  }

  async snapshot(input: {
    context: WorkspaceShareContext;
    sourceKind: WorkspaceShareKind;
    sourceId: string;
    resourceRefs: readonly WorkspaceShareResourceRef[];
  }): Promise<WorkspaceShareSourceSnapshot> {
    const refs = normalizeResourceRefs(input.resourceRefs, this.maxEntries);
    const context = { workspaceId: input.context.workspaceId, accountId: input.context.accountId };
    const entries: WorkspaceShareManifest["entries"] = [];

    if (input.sourceKind === "room_knowledge") {
      for (const ref of refs) {
        const selected = await this.options.completion.getResourceBody(context, ref.id, ref.version);
        assertConfirmedActive(selected, "room_knowledge", input.sourceId, input.context.workspaceId, ref.version);
        if (selected.resource.kind !== "knowledge"
          || selected.resource.scope.kind !== "room"
          || selected.resource.scope.roomId !== input.sourceId) {
          throw new WorkspaceServerError("workspace_share_source_scope_invalid", 409);
        }
        entries.push({
          entry_id: sourceEntryId(input.sourceId, ref),
          kind: "knowledge",
          title: selected.resource.title,
          content: selected.content,
          knowledge_kind: requiredKnowledgeKind(selected.resource.knowledgeKind),
          files: []
        });
      }
      return {
        kind: "room_knowledge",
        sourceId: input.sourceId,
        title: "Room knowledge",
        manifest: {
          format_version: 1,
          kind: "room_knowledge",
          title: "Room knowledge",
          entries
        },
        sourceVersions: refs
      };
    }

    const agent = await this.options.agents.getAgent(context, input.sourceId);
    if (agent.workspaceId !== input.context.workspaceId || agent.id !== input.sourceId || agent.status === "revoked" || agent.status === "disabled" || agent.enabled === false) {
      throw new WorkspaceServerError("workspace_share_source_not_found", 404);
    }
    const agentName = nonEmpty(agent.displayName, "workspace_share_agent_name_invalid");
    const agentRole = nonEmpty(agent.role ?? agent.description, "workspace_share_agent_role_invalid");
    const agentInstructions = nonEmpty(agent.instructions ?? agent.description, "workspace_share_agent_instructions_invalid");

    for (const ref of refs) {
      const selected = await this.options.completion.getResourceBody(context, ref.id, ref.version);
      assertConfirmedActive(selected, "agent", input.sourceId, input.context.workspaceId, ref.version);
      if (selected.resource.scope.kind !== "agent"
        || selected.resource.scope.agentId !== input.sourceId
        || (selected.resource.kind !== "knowledge" && selected.resource.kind !== "skill")
        || selected.resource.aiManaged) {
        throw new WorkspaceServerError("workspace_share_source_scope_invalid", 409);
      }
      const files = selected.resource.kind === "skill"
        ? await this.skillFiles(context, ref, selected.resource.kind)
        : [];
      entries.push({
        entry_id: sourceEntryId(input.sourceId, ref),
        kind: selected.resource.kind,
        title: selected.resource.title,
        content: selected.content,
        ...(selected.resource.kind === "knowledge" ? { knowledge_kind: requiredKnowledgeKind(selected.resource.knowledgeKind) } : {}),
        files
      });
    }
    return {
      kind: "agent",
      sourceId: input.sourceId,
      title: agentName,
      manifest: {
        format_version: 1,
        kind: "agent",
        title: agentName,
        entries,
        agent: { name: agentName, role: agentRole, instructions: agentInstructions }
      },
      sourceVersions: refs
    };
  }

  private async skillFiles(
    context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">,
    ref: WorkspaceShareResourceRef,
    kind: "knowledge" | "skill"
  ): Promise<WorkspaceShareManifest["entries"][number]["files"]> {
    if (kind !== "skill") return [];
    const metadata = await this.options.completion.listSkillFiles(context, ref.id, ref.version);
    const files: WorkspaceShareManifest["entries"][number]["files"] = [];
    for (const file of metadata) {
      assertSafeRelativePath(file.relativePath);
      if (file.resourceVersion !== ref.version) throw new WorkspaceServerError("workspace_share_source_version_conflict", 409);
      const selected = await this.options.completion.getSkillFile(context, ref.id, file.relativePath, ref.version);
      if (selected.file.resourceVersion !== ref.version || selected.file.relativePath !== file.relativePath) {
        throw new WorkspaceServerError("workspace_share_source_version_conflict", 409);
      }
      const bytes = selected.content instanceof Uint8Array ? selected.content : new Uint8Array(selected.content);
      const contentHash = sha256(bytes);
      if (contentHash !== file.contentHash || bytes.byteLength !== file.contentSize || contentHash !== selected.file.contentHash || bytes.byteLength !== selected.file.contentSize) {
        throw new WorkspaceServerError("workspace_share_file_hash_mismatch", 409);
      }
      files.push({
        path: file.relativePath,
        encoding: "base64",
        content: Buffer.from(bytes).toString("base64"),
        byte_size: bytes.byteLength,
        sha256: contentHash
      });
    }
    return files;
  }
}

export function createPostgresWorkspaceShareSource(options: PostgresWorkspaceShareSourceOptions): WorkspaceShareSourcePort {
  return new PostgresWorkspaceShareSource(options);
}

function normalizeResourceRefs(refs: readonly WorkspaceShareResourceRef[], maxEntries: number): WorkspaceShareResourceRef[] {
  if (!Array.isArray(refs) || refs.length === 0 || refs.length > maxEntries) {
    throw new WorkspaceServerError("workspace_share_source_versions_invalid", 400);
  }
  const normalized = refs.map((ref) => {
    if (!ref || typeof ref.id !== "string" || !ref.id.trim() || !Number.isSafeInteger(ref.version) || ref.version < 1) {
      throw new WorkspaceServerError("workspace_share_source_versions_invalid", 400);
    }
    return { id: ref.id.trim(), version: ref.version };
  });
  if (new Set(normalized.map((ref) => ref.id)).size !== normalized.length) {
    throw new WorkspaceServerError("workspace_share_source_versions_invalid", 400);
  }
  return normalized;
}

function assertConfirmedActive(
  selected: Awaited<ReturnType<WorkspaceShareSnapshotReader["getResourceBody"]>>,
  expectedKind: WorkspaceShareKind,
  expectedSourceId: string,
  expectedWorkspaceId: string,
  expectedVersion: number
): void {
  if (selected.resource.workspaceId !== expectedWorkspaceId) {
    throw new WorkspaceServerError("workspace_share_source_not_found", 404);
  }
  if (selected.version.version !== expectedVersion
    || selected.version.version < 1
    || selected.version.evidenceState !== "confirmed"
    || selected.version.lifecycleState !== "active"
    || selected.resource.evidenceState !== "confirmed"
    || selected.resource.lifecycleState !== "active"
    || selected.resource.scope.kind === "workspace"
    || (expectedKind === "room_knowledge" && selected.resource.scope.kind !== "room")
    || (expectedKind === "agent" && selected.resource.scope.kind !== "agent")
    || (expectedKind === "room_knowledge" && selected.resource.scope.roomId !== expectedSourceId)
    || (expectedKind === "agent" && selected.resource.scope.agentId !== expectedSourceId)) {
    throw new WorkspaceServerError("workspace_share_source_version_invalid", 409);
  }
}

function requiredKnowledgeKind(value: WorkspaceCompletionResource["knowledgeKind"]): NonNullable<WorkspaceCompletionResource["knowledgeKind"]> {
  if (!value) throw new WorkspaceServerError("workspace_share_source_scope_invalid", 409);
  return value;
}

function sourceEntryId(sourceId: string, ref: WorkspaceShareResourceRef): string {
  return `share_entry_${sha256(canonicalJson({ source_id_hash: sha256(sourceId), id: ref.id, version: ref.version })).slice(0, 32)}`;
}

function nonEmpty(value: string | undefined, code: string): string {
  if (!value || !value.trim()) throw new WorkspaceServerError(code, 409);
  return value.trim();
}

export interface PostgresWorkspaceShareAuthorizationOptions {
  /** A claim is authorized by the immutable recipient row and the claim
   * trigger. It must not be replaced with a Workspace membership check. Hosts
   * may supply a narrower source-side lookup when their Core has one. */
  authorizeRecipientClaim?: (request: WorkspaceShareAuthorizationRequest, sql: WorkspaceSql) => Promise<boolean>;
}

/** Resolves the same Room manage / Workspace admin checks used by schema RLS.
 * There is no Organization-level shortcut and no cached role decision. */
export class PostgresWorkspaceShareAuthorization implements WorkspaceShareAuthorizationResolver {
  constructor(
    private readonly database: WorkspaceShareDatabase,
    private readonly options: PostgresWorkspaceShareAuthorizationOptions = {}
  ) {}

  async authorize(request: WorkspaceShareAuthorizationRequest): Promise<boolean> {
    return this.database.withContext({ workspaceId: request.workspaceId, accountId: request.accountId }, async (sql) => {
      if (request.action === "recipient_claim") {
        return this.options.authorizeRecipientClaim
          ? this.options.authorizeRecipientClaim(request, sql)
          : true;
      }
      if (request.action === "import_target") {
        if (request.sourceKind === "room_knowledge") {
          if (!request.targetRoomId) return false;
          return allowed(sql, "SELECT samurai_can_room($1, $2, 'manage') AS allowed", [request.workspaceId, request.targetRoomId]);
        }
        if (request.sourceKind === "agent") {
          return allowed(sql, "SELECT samurai_can_workspace($1, 'admin') AS allowed", [request.workspaceId]);
        }
        return false;
      }
      if (!request.sourceKind || !request.sourceId) return false;
      if (request.sourceKind === "room_knowledge") {
        const action = request.action === "source_read" ? "read" : "manage";
        return allowed(sql,
          `SELECT samurai_can_room($1, $2, '${action}') AS allowed
             FROM rooms
            WHERE workspace_id = $1 AND id = $2 AND room_kind <> 'agent_dm'`,
          [request.workspaceId, request.sourceId]);
      }
      return allowed(sql,
        `SELECT samurai_can_workspace($1, '${request.action === "source_read" ? "guest" : "admin"}') AS allowed
           FROM workspace_agents
          WHERE workspace_id = $1 AND id = $2 AND status = 'active'`,
        [request.workspaceId, request.sourceId]);
    });
  }
}

export function createPostgresWorkspaceShareAuthorization(
  database: WorkspaceShareDatabase,
  options: PostgresWorkspaceShareAuthorizationOptions = {}
): WorkspaceShareAuthorizationResolver {
  return new PostgresWorkspaceShareAuthorization(database, options);
}

async function allowed(sql: WorkspaceSql, text: string, values: readonly unknown[]): Promise<boolean> {
  const result = await sql.query<{ allowed: boolean }>(text, values);
  return result.rows[0]?.allowed === true;
}

export interface WorkspaceShareHttpResponse {
  status: number;
  url?: string;
  headers: { get(name: string): string | null };
  bytes: Uint8Array;
}

export interface WorkspaceShareHttpClient {
  postJson(input: { url: string; body: unknown; maxBytes: number; signal?: AbortSignal; resolvedAddress?: string; connectTimeoutMs?: number; responseTimeoutMs?: number }): Promise<WorkspaceShareHttpResponse>;
}

export interface PostgresWorkspaceShareImportTransportOptions {
  /** A host can supply an HTTP client with DNS/private-address policy. The
   * built-in client still uses redirect:error and a bounded response body. */
  client?: WorkspaceShareHttpClient;
  targetOrigin?: string;
  allowedSourceOrigins?: readonly string[];
  resolveHostname?: (hostname: string) => Promise<readonly string[]>;
  now?: () => Date;
  connectTimeoutMs?: number;
  timeoutMs?: number;
  maxBytes?: number;
}

/** Explicit source-Server HTTP transport. It sends only the short-lived
 * delegation, never a login token or connection credential, and verifies the
 * returned bytes before the Share Core sees them. */
export class WorkspaceShareHttpImportTransport implements WorkspaceShareImportTransport {
  private readonly now: () => Date;
  private readonly maxBytes: number;
  private readonly connectTimeoutMs: number;
  private readonly timeoutMs: number;
  private readonly resolveHostname: (hostname: string) => Promise<readonly string[]>;

  constructor(private readonly options: PostgresWorkspaceShareImportTransportOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.maxBytes = Math.max(1, Math.min(options.maxBytes ?? 32 * 1024 * 1024, 32 * 1024 * 1024));
    this.connectTimeoutMs = Math.max(1_000, Math.min(options.connectTimeoutMs ?? 10_000, 10_000));
    this.timeoutMs = Math.max(1_000, Math.min(options.timeoutMs ?? 60_000, 60_000));
    this.resolveHostname = options.resolveHostname ?? (async (hostname) => (await dnsLookup(hostname, { all: true, verbatim: true })).map((address) => address.address));
  }

  async fetch(input: {
    sourceOrigin: string;
    locator: string;
    claimId: string;
    contentHash: string;
    delegation: WorkspaceShareImportInput["delegation"];
  }): Promise<WorkspaceShareImportTransportResult> {
    const sourceOrigin = parseOrigin(input.sourceOrigin);
    const locator = parseLocator(input.locator);
    const delegation = parseDelegation(input.delegation);
    assertDelegationBinding(delegation, { sourceOrigin, locator, claimId: input.claimId, contentHash: input.contentHash, targetOrigin: this.options.targetOrigin, now: this.now() });
    const sourceAllowlisted = this.options.allowedSourceOrigins?.map(parseOrigin).includes(sourceOrigin) === true;
    if (this.options.allowedSourceOrigins && !sourceAllowlisted) {
      throw new WorkspaceServerError("workspace_share_origin_not_allowed", 403);
    }
    // Even allowlisted origins are resolved once so every client receives the
    // address that was checked. A custom client remains responsible for using
    // this address rather than resolving the hostname again.
    const resolvedAddress = await withTimeout(
      resolvePinnedAddress(sourceOrigin, this.resolveHostname, sourceAllowlisted),
      this.timeoutMs,
      new WorkspaceServerError("workspace_share_transport_timeout", 503)
    );

    const endpoint = new URL(`/api/v1/shares/${encodeURIComponent(locator)}/claims/${encodeURIComponent(input.claimId)}/content`, sourceOrigin);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await (this.options.client ?? defaultShareHttpClient).postJson({
        url: endpoint.toString(),
        body: { delegation },
        maxBytes: this.maxBytes,
        signal: controller.signal,
        resolvedAddress,
        connectTimeoutMs: this.connectTimeoutMs,
        responseTimeoutMs: this.timeoutMs
      });
      if (response.status < 200 || response.status >= 300) throw new WorkspaceServerError("workspace_share_transport_failed", 502);
      if (!response.url || responseOrigin(response.url) !== sourceOrigin) throw new WorkspaceServerError("workspace_share_redirect_blocked", 502);
      const bytes = response.bytes instanceof Uint8Array ? response.bytes : new Uint8Array(response.bytes);
      const responseHash = response.headers.get("x-samurai-content-sha256");
      if (responseHash !== null && responseHash !== input.contentHash) throw new WorkspaceServerError("workspace_share_content_hash_conflict", 409);
      if (bytes.byteLength > this.maxBytes) throw new WorkspaceServerError("workspace_share_content_too_large", 413);
      if (sha256(bytes) !== input.contentHash) throw new WorkspaceServerError("workspace_share_content_hash_conflict", 409);
      const body = parseJson(bytes);
      const kind = body.kind;
      if (kind !== "room_knowledge" && kind !== "agent") throw new WorkspaceServerError("workspace_share_manifest_kind_mismatch", 400);
      return { kind, manifest: body, bytes };
    } catch (error) {
      if (error instanceof WorkspaceServerError) throw error;
      if (error instanceof DOMException && error.name === "AbortError") throw new WorkspaceServerError("workspace_share_transport_timeout", 503);
      throw new WorkspaceServerError("workspace_share_transport_failed", 503);
    } finally {
      clearTimeout(timer);
    }
  }
}

export function createWorkspaceShareHttpImportTransport(options: PostgresWorkspaceShareImportTransportOptions = {}): WorkspaceShareImportTransport {
  return new WorkspaceShareHttpImportTransport(options);
}

function parseOrigin(value: string): string {
  const result = PublicShareOriginSchema.safeParse(value);
  if (!result.success) throw new WorkspaceServerError("workspace_share_origin_invalid", 400);
  return result.data;
}

function responseOrigin(value: string): string {
  try {
    const url = new URL(value);
    return parseOrigin(`${url.origin}/`);
  } catch {
    throw new WorkspaceServerError("workspace_share_redirect_blocked", 502);
  }
}

function parseLocator(value: string): string {
  const result = PublicShareLocatorSchema.safeParse(value);
  if (!result.success) throw new WorkspaceServerError("workspace_share_locator_invalid", 400);
  return result.data;
}

function parseDelegation(value: unknown): PublicShareDelegation {
  const result = PublicShareDelegationSchema.safeParse(value);
  if (!result.success) throw new WorkspaceServerError("workspace_share_delegation_invalid", 403);
  const delegation = result.data;
  let key: ReturnType<typeof createPublicKey>;
  try {
    key = createPublicKey(delegation.public_key.startsWith("base64:")
      ? { key: Buffer.from(delegation.public_key.slice("base64:".length), "base64"), format: "der", type: "spki" }
      : delegation.public_key);
    const signature = Buffer.from(delegation.signature, "base64url");
    if (!verify(null, Buffer.from(`samurai-share-import-v1\n${canonicalJson(delegation.payload)}`), key, signature)) {
      throw new Error("signature_invalid");
    }
  } catch {
    throw new WorkspaceServerError("workspace_share_delegation_invalid", 403);
  }
  try {
    if (accountIdFromPublicKey(delegation.public_key) !== delegation.payload.recipient_account_id) {
      throw new WorkspaceServerError("workspace_share_delegation_mismatch", 403);
    }
  } catch (error) {
    if (error instanceof WorkspaceServerError) throw error;
    throw new WorkspaceServerError("workspace_share_delegation_invalid", 403);
  }
  return delegation;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, error: WorkspaceServerError): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(error), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function assertDelegationBinding(
  delegation: PublicShareDelegation,
  input: { sourceOrigin: string; locator: string; claimId: string; contentHash: string; targetOrigin?: string; now: Date }
): void {
  const payload = delegation.payload;
  if (payload.source_origin !== input.sourceOrigin
    || payload.claim_id !== input.claimId
    || payload.content_hash !== input.contentHash
    || (input.targetOrigin !== undefined && payload.target_origin !== parseOrigin(input.targetOrigin))) {
    throw new WorkspaceServerError("workspace_share_delegation_mismatch", 403);
  }
  const issued = Date.parse(payload.issued_at);
  const expires = Date.parse(payload.expires_at);
  if (!Number.isFinite(issued) || !Number.isFinite(expires) || issued > input.now.getTime() || expires <= issued || expires - issued > 5 * 60_000 || expires <= input.now.getTime()) {
    throw new WorkspaceServerError("workspace_share_delegation_expired", 403);
  }
}

async function assertPublicOrigin(origin: string, resolveHostname: (hostname: string) => Promise<readonly string[]>): Promise<void> {
  const hostname = new URL(origin).hostname;
  const addresses = isIP(hostname) ? [hostname] : await resolveHostname(hostname).catch(() => {
    throw new WorkspaceServerError("workspace_share_origin_unreachable", 503);
  });
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) throw new WorkspaceServerError("workspace_share_origin_not_allowed", 403);
}

/** Resolves once and returns the exact address the default client will use.
 * This closes the check/use DNS gap that otherwise permits a rebinding between
 * validation and the TLS connection. Explicit allowlisting bypasses the
 * private-address policy, but still pins the resolved address. */
async function resolvePinnedAddress(
  origin: string,
  resolveHostname: (hostname: string) => Promise<readonly string[]>,
  allowlisted: boolean
): Promise<string> {
  const rawHostname = new URL(origin).hostname;
  const hostname = rawHostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(hostname) ? [hostname] : await resolveHostname(hostname).catch(() => {
    throw new WorkspaceServerError("workspace_share_origin_unreachable", 503);
  });
  if (addresses.length === 0 || addresses.some((address) => !isIP(address))) throw new WorkspaceServerError("workspace_share_origin_invalid", 400);
  if (!allowlisted && addresses.some(isPrivateAddress)) throw new WorkspaceServerError("workspace_share_origin_not_allowed", 403);
  return addresses[0]!;
}

function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized.includes(":")) {
    const groups = parseIpv6Groups(normalized);
    if (!groups) return true;
    const first = groups[0] ?? 0;
    if (groups.every((group) => group === 0) || (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1)) return true;
    if ((first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00) return true;
    if (groups.slice(0, 6).every((group) => group === 0) && groups[6] === 0 && groups[7] === 0xffff) return true;
    if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
      const octets = [groups[6]! >>> 8, groups[6]! & 0xff, groups[7]! >>> 8, groups[7]! & 0xff];
      return isPrivateAddress(octets.join("."));
    }
    return false;
  }
  const octets = normalized.split(".").map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const a = octets[0] ?? 0;
  const b = octets[1] ?? 0;
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
}

function parseIpv6Groups(value: string): number[] | null {
  const halves = value.split("::");
  if (halves.length > 2) return null;
  const parseHalf = (half: string): number[] | null => {
    if (!half) return [];
    const parts = half.split(":");
    if (parts.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null;
    return parts.map((part) => Number.parseInt(part, 16));
  };
  const left = parseHalf(halves[0] ?? "");
  const right = parseHalf(halves[1] ?? "");
  if (!left || !right) return null;
  if (halves.length === 1) return left.length === 8 ? left : null;
  const missing = 8 - left.length - right.length;
  if (missing < 1) return null;
  return [...left, ...new Array<number>(missing).fill(0), ...right];
}

const defaultShareHttpClient: WorkspaceShareHttpClient = {
  async postJson(input) {
    const target = new URL(input.url);
    if (target.protocol !== "https:") throw new WorkspaceServerError("workspace_share_origin_invalid", 400);
    const body = JSON.stringify(input.body);
    const connectTimeoutMs = input.connectTimeoutMs ?? 10_000;
    const responseTimeoutMs = input.responseTimeoutMs ?? 60_000;
    return new Promise<WorkspaceShareHttpResponse>((resolve, reject) => {
      let settled = false;
      let connectTimer: ReturnType<typeof setTimeout> | undefined;
      let responseTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = (error?: unknown, value?: WorkspaceShareHttpResponse): void => {
        if (settled) return;
        settled = true;
        if (connectTimer) clearTimeout(connectTimer);
        if (responseTimer) clearTimeout(responseTimer);
        if (error) reject(error);
        else resolve(value!);
      };
      const tooLarge = (): void => finish(new WorkspaceServerError("workspace_share_content_too_large", 413));
      const request = httpsRequest({
        protocol: "https:",
        hostname: input.resolvedAddress ?? target.hostname,
        port: target.port || 443,
        path: `${target.pathname}${target.search}`,
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body)
        },
        // Preserve certificate/SNI validation for the original hostname while
        // connecting to the already-validated IP address.
        servername: target.hostname.replace(/^\[|\]$/g, ""),
        rejectUnauthorized: true,
        lookup: input.resolvedAddress
          ? (_hostname, _options, callback) => callback(null, input.resolvedAddress!, isIP(input.resolvedAddress!) === 6 ? 6 : 4)
          : undefined
      }, (response) => {
        if (responseTimer) clearTimeout(responseTimer);
        responseTimer = setTimeout(() => {
          response.destroy();
          finish(new WorkspaceServerError("workspace_share_transport_timeout", 503));
        }, responseTimeoutMs);
        if (response.statusCode !== undefined && response.statusCode >= 300 && response.statusCode < 400) {
          response.resume();
          finish(new WorkspaceServerError("workspace_share_redirect_blocked", 502));
          return;
        }
        const contentLength = response.headers["content-length"];
        if (typeof contentLength === "string" && Number.isFinite(Number(contentLength)) && Number(contentLength) > input.maxBytes) {
          response.resume();
          tooLarge();
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        response.on("data", (chunk: Buffer | string) => {
          const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
          total += buffer.byteLength;
          if (total > input.maxBytes) {
            response.destroy();
            tooLarge();
            return;
          }
          chunks.push(buffer);
        });
        response.on("end", () => finish(undefined, {
          status: response.statusCode ?? 0,
          url: input.url,
          headers: { get: (name: string) => {
            const value = response.headers[name.toLowerCase()];
            return Array.isArray(value) ? value.join(", ") : value ?? null;
          } },
          bytes: new Uint8Array(Buffer.concat(chunks))
        }));
        response.on("error", (error) => finish(error));
      });
      connectTimer = setTimeout(() => {
        request.destroy();
        finish(new WorkspaceServerError("workspace_share_transport_timeout", 503));
      }, connectTimeoutMs);
      responseTimer = setTimeout(() => {
        request.destroy();
        finish(new WorkspaceServerError("workspace_share_transport_timeout", 503));
      }, responseTimeoutMs);
      request.once("socket", (socket) => {
        const connected = () => {
          if (connectTimer) clearTimeout(connectTimer);
          connectTimer = undefined;
        };
        socket.once("connect", connected);
        socket.once("secureConnect", connected);
      });
      request.on("error", (error) => finish(error));
      if (input.signal) {
        if (input.signal.aborted) {
          request.destroy();
          finish(new WorkspaceServerError("workspace_share_transport_timeout", 503));
        } else input.signal.addEventListener("abort", () => {
          request.destroy();
          finish(new WorkspaceServerError("workspace_share_transport_timeout", 503));
        }, { once: true });
      }
      request.write(body);
      request.end();
    });
  }
};

function parseJson(bytes: Uint8Array): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("object_required");
    return value as Record<string, unknown>;
  } catch {
    throw new WorkspaceServerError("workspace_share_manifest_invalid", 502);
  }
}

export interface WorkspaceShareImportedFile {
  path: string;
  content: Uint8Array;
  byteSize: number;
  sha256: string;
}

export interface WorkspaceShareImportedEntry {
  entryId: string;
  kind: "knowledge" | "skill";
  title: string;
  content: string;
  knowledgeKind?: "fact" | "decision" | "explanation" | "experience_rule";
  files: readonly WorkspaceShareImportedFile[];
}

export interface WorkspaceShareImportWriterContext {
  sql: WorkspaceSql;
  context: WorkspaceShareContext;
  operationId: string;
  reservedResourceIds: readonly { entryId: string; resourceId: string }[];
}

/** Host-provided writer facade. Its two operations are intentionally explicit:
 * neither accepts Room membership, default-Agent, backend, credentials,
 * evidence, or execution inputs. Implementations must use the supplied `sql`
 * in the already-open transaction and the existing Completion writer. */
export interface WorkspaceShareImportWriter {
  commitRoomKnowledge(input: WorkspaceShareImportWriterContext & {
    targetRoomId: string;
    entries: readonly WorkspaceShareImportedEntry[];
  }): Promise<{ createdAgentId: null; createdResourceIds: readonly string[] }>;
  commitAgent(input: WorkspaceShareImportWriterContext & {
    agentId: string;
    agent: { name: string; role: string; instructions: string };
    entries: readonly WorkspaceShareImportedEntry[];
  }): Promise<{ createdAgentId: string; createdResourceIds: readonly string[] }>;
}

/** Validates the fixed manifest again and delegates one and only one
 * transaction-aware write to the host's Completion/Agent writer. It never
 * writes a Completion table directly, which prevents a share adapter from
 * bypassing file-batch, policy, and idempotency checks. */
export class PostgresWorkspaceShareImportCommitter implements WorkspaceShareImportCommitter {
  constructor(
    /** Kept in the constructor so the composition root cannot accidentally
     * pair a writer with an unrelated database wrapper. The transaction
     * itself is the `sql` supplied by WorkspaceShareService. */
    private readonly _database: WorkspaceShareDatabase,
    private readonly writer: WorkspaceShareImportWriter
  ) {}

  async commit(input: Parameters<WorkspaceShareImportCommitter["commit"]>[0]): Promise<{ createdAgentId: string | null; createdResourceIds: readonly string[] }> {
    if (!input.context.operationId) throw new WorkspaceServerError("workspace_share_operation_id_required", 400);
    const target = await input.sql.query<{ target_room_id: string | null; reserved_agent_id: string | null; recipient_account_id: string; kind: WorkspaceShareKind; status: string; phase: string }>(
      `SELECT target_room_id, reserved_agent_id, recipient_account_id, kind, status, phase
         FROM workspace_share_imports
        WHERE workspace_id = $1 AND operation_id = $2
        FOR UPDATE`,
      [input.context.workspaceId, input.context.operationId]
    );
    const row = target.rows[0];
    if (!row || row.recipient_account_id !== input.context.accountId || row.kind !== input.kind || row.status !== "staging" || !["fetch", "files", "commit"].includes(row.phase)
      || row.reserved_agent_id !== (input.kind === "agent" ? input.reservedAgentId : null)) {
      throw new WorkspaceServerError("workspace_share_import_conflict", 409);
    }
    const entries = normalizeImportedEntries(input.manifest, input.kind);
    const reserved = normalizeReservedResources(input.reservedResourceIds, entries);
    const writerContext = {
      sql: input.sql,
      context: input.context,
      operationId: input.context.operationId,
      reservedResourceIds: reserved
    };
    if (input.kind === "room_knowledge") {
      if (!row.target_room_id) throw new WorkspaceServerError("workspace_share_import_target_invalid", 409);
      const result = await this.writer.commitRoomKnowledge({ ...writerContext, targetRoomId: row.target_room_id, entries });
      assertWriterResult(result, reserved, null);
      return { createdAgentId: null, createdResourceIds: [...result.createdResourceIds] };
    }
    if (!input.reservedAgentId || !input.manifest.agent) throw new WorkspaceServerError("workspace_share_import_agent_invalid", 409);
    const agent = {
      name: nonEmpty(input.manifest.agent.name, "workspace_share_agent_name_invalid"),
      role: nonEmpty(input.manifest.agent.role, "workspace_share_agent_role_invalid"),
      instructions: nonEmpty(input.manifest.agent.instructions, "workspace_share_agent_instructions_invalid")
    };
    const result = await this.writer.commitAgent({ ...writerContext, agentId: input.reservedAgentId, agent, entries });
    assertWriterResult(result, reserved, input.reservedAgentId);
    return { createdAgentId: result.createdAgentId, createdResourceIds: [...result.createdResourceIds] };
  }
}

export function createPostgresWorkspaceShareImportCommitter(
  database: WorkspaceShareDatabase,
  writer: WorkspaceShareImportWriter
): WorkspaceShareImportCommitter {
  return new PostgresWorkspaceShareImportCommitter(database, writer);
}

function normalizeImportedEntries(manifest: WorkspaceShareManifest, kind: WorkspaceShareKind): WorkspaceShareImportedEntry[] {
  if (manifest.kind !== kind || manifest.entries.length === 0) throw new WorkspaceServerError("workspace_share_manifest_kind_mismatch", 400);
  if (kind === "room_knowledge" && manifest.agent) throw new WorkspaceServerError("workspace_share_manifest_kind_mismatch", 400);
  if (kind === "room_knowledge" && manifest.entries.some((entry) => entry.kind !== "knowledge" || entry.files.length > 0)) {
    throw new WorkspaceServerError("workspace_share_manifest_scope_invalid", 400);
  }
  if (kind === "agent" && (!manifest.agent || manifest.entries.some((entry) => entry.kind !== "knowledge" && entry.kind !== "skill"))) {
    throw new WorkspaceServerError("workspace_share_manifest_scope_invalid", 400);
  }
  return manifest.entries.map((entry) => ({
    entryId: entry.entry_id,
    kind: entry.kind,
    title: entry.title,
    content: entry.content,
    ...(entry.knowledge_kind ? { knowledgeKind: entry.knowledge_kind } : {}),
    files: entry.files.map((file) => {
      const content = file.encoding === "utf8" ? new TextEncoder().encode(file.content) : decodeBase64(file.content);
      if (content.byteLength !== file.byte_size || sha256(content) !== file.sha256) throw new WorkspaceServerError("workspace_share_file_hash_mismatch", 400);
      return { path: file.path, content, byteSize: content.byteLength, sha256: file.sha256 };
    })
  }));
}

function normalizeReservedResources(
  values: readonly { entryId: string; resourceId: string }[],
  entries: readonly WorkspaceShareImportedEntry[]
): { entryId: string; resourceId: string }[] {
  if (values.length !== entries.length) throw new WorkspaceServerError("workspace_share_import_resource_mapping_invalid", 409);
  const expected = new Set(entries.map((entry) => entry.entryId));
  const seen = new Set<string>();
  for (const value of values) {
    if (!expected.has(value.entryId) || !value.resourceId.trim() || seen.has(value.entryId) || seen.has(`resource:${value.resourceId}`)) {
      throw new WorkspaceServerError("workspace_share_import_resource_mapping_invalid", 409);
    }
    seen.add(value.entryId);
    seen.add(`resource:${value.resourceId}`);
  }
  return values.map((value) => ({ entryId: value.entryId, resourceId: value.resourceId }));
}

function assertWriterResult(
  result: { createdAgentId: string | null; createdResourceIds: readonly string[] },
  reserved: readonly { entryId: string; resourceId: string }[],
  expectedAgentId: string | null
): void {
  const expectedResourceIds = reserved.map((value) => value.resourceId);
  if (result.createdAgentId !== expectedAgentId
    || result.createdResourceIds.length !== expectedResourceIds.length
    || new Set(result.createdResourceIds).size !== expectedResourceIds.length
    || result.createdResourceIds.some((resourceId) => !expectedResourceIds.includes(resourceId))) {
    throw new WorkspaceServerError("workspace_share_import_writer_result_invalid", 500);
  }
}

function decodeBase64(value: string): Uint8Array {
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) throw new WorkspaceServerError("workspace_share_file_content_base64_invalid", 400);
  return new Uint8Array(bytes);
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
