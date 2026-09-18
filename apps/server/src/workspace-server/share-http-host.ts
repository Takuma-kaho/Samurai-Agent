import { createHash, createPublicKey, randomUUID, verify } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Request } from "express";
import { z } from "zod";
import {
  PublicShareDelegationSchema,
  PublicShareManifestSchema,
  PublicShareOriginSchema
} from "@samurai-agent/domain-api";
import {
  WorkspaceServerError,
  WorkspaceShareService,
  accountIdFromPublicKey,
  assertSafeRelativePath,
  canonicalJson,
  verifyAccountSignature,
  type PostgresWorkspaceDatabase,
  type WorkspaceCompletionService,
  type WorkspaceServerStore,
  type WorkspaceShareFilePort,
  type WorkspaceShareFileStage,
  type WorkspaceShareImportInput
} from "@samurai-agent/workspace-server";
import type {
  WorkspaceShareHttpContentInput,
  WorkspaceShareHttpContentResult,
  WorkspaceShareHttpCore,
  WorkspaceShareHttpIdentity,
  WorkspaceShareHttpIdentityResolver
} from "./share-http";
import {
  createPostgresWorkspaceShareAuthorization,
  createPostgresWorkspaceShareDatabase,
  createPostgresWorkspaceShareImportCommitter,
  createPostgresWorkspaceShareSource,
  createWorkspaceShareHttpImportTransport,
  type WorkspaceShareDatabase,
  type WorkspaceShareHttpClient,
  type WorkspaceShareImportWriter
} from "./share-postgres";
import { createPostgresWorkspaceShareCompletionImportWriter } from "./share-completion-import-writer";

const maxShareFileBytes = 32 * 1024 * 1024;

/**
 * The HTTP process owns this small composition object.  It connects the
 * existing Share Core ports to the same PostgreSQL database, Completion read
 * facade, Agent read facade, and storage root used by the rest of Server.
 * Public locator/claim access is a separate, database-function-backed port.
 * The normal share table RLS policies are never widened for anonymous reads.
 */
export interface WorkspaceShareHostOptions {
  database: Pick<PostgresWorkspaceDatabase, "withContext">;
  store: WorkspaceServerStore;
  completion: Pick<WorkspaceCompletionService, "getResourceBody" | "listSkillFiles" | "getSkillFile" | "commitImportedShare">;
  storageRoot: string;
  /** Server-owned secret used to bind share list cursors to their query. */
  cursorSecret?: string;
  origin?: string;
  allowedSourceOrigins?: readonly string[];
  importHttpClient?: WorkspaceShareHttpClient;
  /** Optional transaction-aware Completion writer. The standard composition
   * creates one from `completion`; a custom writer is useful only for tests or
   * a host with a deliberately different Completion facade. */
  completionImportWriter?: WorkspaceShareImportWriter;
  /** Narrow DB-backed public reader/claim writer. It must enforce the public
   * locator and recipient checks itself, without widening normal table RLS. */
  publicAccess?: WorkspaceSharePublicAccess;
}

export interface WorkspaceSharePublicAccess {
  viewPublished: WorkspaceShareHttpCore["viewPublished"];
  claim: WorkspaceShareHttpCore["claim"];
  getClaimContent?: NonNullable<WorkspaceShareHttpCore["getClaimContent"]>;
}

export interface WorkspaceShareHostComposition {
  service: WorkspaceShareService;
  http: WorkspaceShareHttpCore;
  resolvePublicIdentity: WorkspaceShareHttpIdentityResolver;
  resolveAccountIdentity: WorkspaceShareHttpIdentityResolver;
}

/** Derive a purpose-specific cursor key without reusing the invitation key as
 * a raw signing key for another protocol. */
export function workspaceShareCursorSecret(serverSecret: string): string {
  return createHash("sha256")
    .update("samurai.workspace-share.cursor\0", "utf8")
    .update(serverSecret, "utf8")
    .digest("hex");
}

/** Construct the single Share Core instance used by both V1 Domain API and
 * the dedicated public/claim HTTP adapter. */
export function createWorkspaceShareHost(options: WorkspaceShareHostOptions): WorkspaceShareHostComposition {
  const database = createPostgresWorkspaceShareDatabase(options.database);
  const files = new WorkspaceShareFileStore(options.storageRoot);
  const source = createPostgresWorkspaceShareSource({
    completion: options.completion,
    agents: {
      getAgent: async (context, agentId) => {
        const agent = await options.store.getAgent(context, agentId);
        return {
          workspaceId: agent.workspaceId,
          id: agent.id,
          displayName: agent.displayName,
          ...(agent.role ? { role: agent.role } : {}),
          ...(agent.instructions ? { instructions: agent.instructions } : {}),
          ...(agent.description ? { description: agent.description } : {}),
          ...(agent.enabled !== undefined ? { enabled: agent.enabled } : {}),
          status: agent.status
        };
      }
    }
  });
  const authorization = createPostgresWorkspaceShareAuthorization(database);
  const importTransport = createWorkspaceShareHttpImportTransport({
    ...(options.origin ? { targetOrigin: options.origin } : {}),
    ...(options.allowedSourceOrigins ? { allowedSourceOrigins: options.allowedSourceOrigins } : {}),
    ...(options.importHttpClient ? { client: options.importHttpClient } : {})
  });
  const completionImportWriter = options.completionImportWriter
    ?? createPostgresWorkspaceShareCompletionImportWriter(options.completion as WorkspaceCompletionService);
  const service = new WorkspaceShareService({
    database,
    authorization,
    files,
    source,
    importTransport,
    importCommitter: createPostgresWorkspaceShareImportCommitter(database, completionImportWriter),
    delegationVerifier: (delegation) => verifyImportDelegation(delegation),
    ...(options.cursorSecret ? { cursorSecret: workspaceShareCursorSecret(options.cursorSecret) } : {}),
    ...(options.origin ? { origin: options.origin } : {})
  });
  const identities = createShareIdentityResolvers(options.store);
  const publicAccess = {
    ...createDatabasePublicAccess(database, files, options.origin),
    ...(options.publicAccess ?? {})
  };
  const http: WorkspaceShareHttpCore = {
    viewPublished: publicAccess.viewPublished,
    claim: publicAccess.claim,
    getClaimContent: publicAccess.getClaimContent,
    importStatus: ({ workspaceId, accountId, operationId }) =>
      service.importStatus({ workspaceId, accountId }, { operation_id: operationId })
  };
  return {
    service,
    http,
    resolvePublicIdentity: identities.resolvePublicIdentity,
    resolveAccountIdentity: identities.resolveAccountIdentity
  };
}

interface PublicShareLookupRow {
  workspace_id: string;
  share_id: string;
  title: string;
  visibility: "restricted" | "public";
  manifest_path: string;
  content_hash: string;
  published_at: string | Date;
}

interface PublicShareClaimRow {
  claim_id: string;
  share_id: string;
  recipient_account_id: string;
  target_origin: string;
  target_workspace_id: string;
  operation_id: string;
  content_hash: string;
  created_at: string | Date;
  replayed: boolean;
}

interface PublicShareClaimContentRow {
  workspace_id: string;
  share_id: string;
  manifest_path: string;
  content_hash: string;
  recipient_account_id: string;
  target_origin: string;
  target_workspace_id: string;
  operation_id: string;
}

function createDatabasePublicAccess(
  database: WorkspaceShareDatabase,
  files: WorkspaceShareFileStore,
  configuredOrigin: string | undefined
): Required<Pick<WorkspaceSharePublicAccess, "viewPublished" | "claim" | "getClaimContent">> {
  return {
    viewPublished: async (input) => {
      const recipientAccountId = input.accountId?.trim() || null;
      const result = await withMappedShareErrors(() => database.withContext({
        workspaceId: "",
        accountId: recipientAccountId ?? "anonymous"
      }, (sql) => sql.query<PublicShareLookupRow>(
        "SELECT workspace_id, share_id, title, visibility, manifest_path, content_hash, published_at FROM samurai_workspace_share_public_lookup($1, $2)",
        [input.locator, recipientAccountId]
      )));
      const row = result.rows[0];
      if (!row) throw new WorkspaceServerError("share_unavailable", 404);
      const bytes = await files.read(row.manifest_path);
      assertContentHash(bytes, row.content_hash);
      return {
        title: row.title,
        visibility: row.visibility,
        manifest: parseManifest(bytes),
        content_hash: row.content_hash,
        published_at: timestampString(row.published_at)
      };
    },
    claim: async (input) => {
      const claimId = `share_claim_${randomUUID()}`;
      const result = await withMappedShareErrors(() => database.withContext({
        workspaceId: "",
        accountId: input.recipientAccountId
      }, (sql) => sql.query<PublicShareClaimRow>(
        "SELECT claim_id, share_id, recipient_account_id, target_origin, target_workspace_id, operation_id, content_hash, created_at, replayed FROM samurai_workspace_share_claim($1, $2, $3, $4, $5, $6, $7, $8)",
        [input.locator, input.recipientAccountId, input.targetOrigin, input.targetWorkspaceId, input.operationId, input.requestHash, input.contentHash, claimId]
      )));
      const row = result.rows[0];
      if (!row) throw new WorkspaceServerError("share_unavailable", 404);
      if (row.recipient_account_id !== input.recipientAccountId
        || row.target_origin !== input.targetOrigin
        || row.target_workspace_id !== input.targetWorkspaceId
        || row.operation_id !== input.operationId
        || row.content_hash !== input.contentHash) {
        throw new WorkspaceServerError("workspace_share_claim_conflict", 409);
      }
      return {
        claim_id: row.claim_id,
        share_id: row.share_id,
        recipient_account_id: row.recipient_account_id,
        target_origin: row.target_origin,
        target_workspace_id: row.target_workspace_id,
        operation_id: row.operation_id,
        content_hash: row.content_hash,
        created_at: timestampString(row.created_at),
        replayed: row.replayed === true
      };
    },
    getClaimContent: async (input) => {
      const delegation = verifyShareDelegation(input, configuredOrigin);
      const payload = delegation.payload;
      const result = await withMappedShareErrors(() => database.withContext({
        workspaceId: "",
        accountId: input.recipientAccountId
      }, (sql) => sql.query<PublicShareClaimContentRow>(
        "SELECT workspace_id, share_id, manifest_path, content_hash, recipient_account_id, target_origin, target_workspace_id, operation_id FROM samurai_workspace_share_claim_content($1, $2, $3, $4, $5, $6, $7)",
        [input.locator, input.claimId, input.recipientAccountId, payload.target_origin, payload.target_workspace_id, payload.operation_id, payload.content_hash]
      )));
      const row = result.rows[0];
      if (!row
        || row.share_id !== payload.share_id
        || row.recipient_account_id !== input.recipientAccountId
        || row.target_origin !== payload.target_origin
        || row.target_workspace_id !== payload.target_workspace_id
        || row.operation_id !== payload.operation_id
        || row.content_hash !== payload.content_hash) {
        throw new WorkspaceServerError("workspace_share_delegation_mismatch", 403);
      }
      const bytes = await files.read(row.manifest_path);
      assertContentHash(bytes, row.content_hash);
      return { bytes, contentHash: row.content_hash } satisfies WorkspaceShareHttpContentResult;
    }
  };
}

function parseManifest(bytes: Uint8Array): unknown {
  let candidate: unknown;
  try {
    candidate = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new WorkspaceServerError("workspace_share_manifest_invalid", 500);
  }
  const parsed = PublicShareManifestSchema.safeParse(candidate);
  if (!parsed.success) throw new WorkspaceServerError("workspace_share_manifest_invalid", 500);
  return parsed.data;
}

function assertContentHash(bytes: Uint8Array, expectedHash: string): void {
  if (!/^[a-f0-9]{64}$/.test(expectedHash) || sha256(bytes) !== expectedHash) {
    throw new WorkspaceServerError("workspace_share_content_hash_conflict", 409);
  }
}

function timestampString(value: string | Date): string {
  const timestamp = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(timestamp.getTime())) throw new WorkspaceServerError("workspace_share_published_at_invalid", 500);
  return timestamp.toISOString();
}

function verifyShareDelegation(input: WorkspaceShareHttpContentInput, configuredOrigin: string | undefined):
  z.infer<typeof PublicShareDelegationSchema> {
  const parsed = PublicShareDelegationSchema.safeParse(input.delegation);
  if (!parsed.success) throw new WorkspaceServerError("workspace_share_delegation_invalid", 403);
  const delegation = parsed.data;
  const payload = delegation.payload;
  const origin = configuredOrigin ? PublicShareOriginSchema.safeParse(configuredOrigin) : null;
  if (!origin?.success
    || payload.source_origin !== origin.data
    || payload.claim_id !== input.claimId
    || payload.recipient_account_id !== input.recipientAccountId) {
    throw new WorkspaceServerError("workspace_share_delegation_mismatch", 403);
  }
  const issuedAt = Date.parse(payload.issued_at);
  const expiresAt = Date.parse(payload.expires_at);
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || issuedAt > Date.now() || expiresAt <= issuedAt || expiresAt - issuedAt > 5 * 60_000 || expiresAt <= Date.now()) {
    throw new WorkspaceServerError("workspace_share_delegation_expired", 403);
  }
  try {
    if (accountIdFromPublicKey(delegation.public_key) !== input.recipientAccountId) {
      throw new WorkspaceServerError("workspace_share_delegation_mismatch", 403);
    }
    const key = createPublicKey(delegation.public_key.startsWith("base64:")
      ? { key: Buffer.from(delegation.public_key.slice("base64:".length), "base64"), format: "der", type: "spki" }
      : delegation.public_key);
    const signature = Buffer.from(delegation.signature, "base64url");
    if (!verify(null, Buffer.from(`samurai-share-import-v1\n${canonicalJson(payload)}`), key, signature)) {
      throw new WorkspaceServerError("workspace_share_delegation_invalid", 403);
    }
  } catch (error) {
    if (error instanceof WorkspaceServerError) throw error;
    throw new WorkspaceServerError("workspace_share_delegation_invalid", 403);
  }
  return delegation;
}

/** Verifies the account signature at the Server boundary before Share Core
 * stores the delegation as an ephemeral capability. The signed material is
 * never copied to the import row, operation result, or worker claim. Core
 * still checks the target/source/operation bindings independently. */
async function verifyImportDelegation(
  input: WorkspaceShareImportInput["delegation"]
): Promise<boolean> {
  const parsed = PublicShareDelegationSchema.safeParse(input);
  if (!parsed.success) return false;
  const delegation = parsed.data;
  const payload = delegation.payload;
  const issuedAt = Date.parse(payload.issued_at);
  const expiresAt = Date.parse(payload.expires_at);
  if (!Number.isFinite(issuedAt)
    || !Number.isFinite(expiresAt)
    || issuedAt > Date.now()
    || expiresAt <= issuedAt
    || expiresAt - issuedAt > 5 * 60_000
    || expiresAt <= Date.now()) return false;
  try {
    if (accountIdFromPublicKey(delegation.public_key) !== payload.recipient_account_id) return false;
    const key = createPublicKey(delegation.public_key.startsWith("base64:")
      ? { key: Buffer.from(delegation.public_key.slice("base64:".length), "base64"), format: "der", type: "spki" }
      : delegation.public_key);
    const signature = Buffer.from(delegation.signature, "base64url");
    return verify(null, Buffer.from(`samurai-share-import-v1\n${canonicalJson(payload)}`), key, signature);
  } catch {
    return false;
  }
}

async function withMappedShareErrors<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof WorkspaceServerError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    const known: Record<string, { status: number }> = {
      share_unavailable: { status: 404 },
      share_revoked: { status: 410 },
      workspace_share_claim_conflict: { status: 409 },
      workspace_share_content_hash_conflict: { status: 409 },
      workspace_share_claim_input_invalid: { status: 400 }
    };
    const code = Object.keys(known).find((candidate) => message.includes(candidate));
    if (code) throw new WorkspaceServerError(code, known[code]!.status);
    throw new WorkspaceServerError("workspace_server_internal_error", 503);
  }
}

/**
 * Files for Share manifests/import copies are not Workspace files.  They are
 * stored below a dedicated, server-owned directory and are only addressed by
 * the transaction paths returned by this adapter.  IDs are hashed before
 * entering a path so a long operation ID can never become a filesystem path.
 */
export class WorkspaceShareFileStore implements WorkspaceShareFilePort {
  private readonly root: string;

  constructor(storageRoot: string) {
    this.root = path.resolve(storageRoot, "workspace-shares");
    if (this.root === path.parse(this.root).root) {
      throw new WorkspaceServerError("workspace_share_storage_root_invalid", 500);
    }
  }

  async stage(input: {
    workspaceId: string;
    ownerKind: "draft" | "import";
    ownerId: string;
    revision: number;
    bytes: Uint8Array;
    sha256: string;
  }): Promise<WorkspaceShareFileStage> {
    if (!Number.isSafeInteger(input.revision) || input.revision < 1 || input.bytes.byteLength > maxShareFileBytes) {
      throw new WorkspaceServerError("workspace_share_content_too_large", 413);
    }
    const contentHash = sha256(input.bytes);
    if (contentHash !== input.sha256) throw new WorkspaceServerError("workspace_share_content_hash_conflict", 409);
    const transactionId = `share_file_${randomUUID()}`;
    const stagedPath = `staging/${transactionId}.json`;
    const finalPath = `published/${hashSegment(input.workspaceId)}/${input.ownerKind}/${hashSegment(input.ownerId)}/r${input.revision}-${contentHash}.json`;
    await this.preparePath(stagedPath);
    await this.preparePath(finalPath);
    try {
      await writeFile(this.absolute(stagedPath), Buffer.from(input.bytes), { flag: "wx", mode: 0o600 });
    } catch (error) {
      throw new WorkspaceServerError(errorCodeForFileError(error), 500);
    }
    return { transactionId, stagedPath: `workspace-shares/${stagedPath}`, finalPath: `workspace-shares/${finalPath}` };
  }

  async rename(input: WorkspaceShareFileStage): Promise<void> {
    const stagedPath = stripShareRoot(input.stagedPath);
    const finalPath = stripShareRoot(input.finalPath);
    await this.assertPath(stagedPath);
    await this.assertPath(finalPath);
    await this.preparePath(finalPath);
    const stagedBytes = await this.read(stagedPath);
    const destination = this.absolute(finalPath);
    try {
      const existing = new Uint8Array(await readFile(destination));
      if (sha256(existing) !== sha256(stagedBytes)) {
        throw new WorkspaceServerError("workspace_share_file_transaction_conflict", 409);
      }
      await rm(this.absolute(stagedPath), { force: true });
      return;
    } catch (error) {
      if (!(isNodeFileNotFound(error))) throw error;
    }
    try {
      await rename(this.absolute(stagedPath), destination);
    } catch (error) {
      throw new WorkspaceServerError(errorCodeForFileError(error), 500);
    }
  }

  async read(relativePath: string): Promise<Uint8Array> {
    const safePath = stripShareRoot(relativePath);
    await this.assertPath(safePath);
    try {
      const bytes = new Uint8Array(await readFile(this.absolute(safePath)));
      if (bytes.byteLength > maxShareFileBytes) throw new WorkspaceServerError("workspace_share_content_too_large", 413);
      return bytes;
    } catch (error) {
      if (error instanceof WorkspaceServerError) throw error;
      throw new WorkspaceServerError(isNodeFileNotFound(error) ? "workspace_share_file_not_found" : errorCodeForFileError(error), isNodeFileNotFound(error) ? 404 : 500);
    }
  }

  async remove(relativePath: string): Promise<void> {
    const safePath = stripShareRoot(relativePath);
    await this.assertPath(safePath);
    try {
      await rm(this.absolute(safePath), { force: true });
    } catch (error) {
      throw new WorkspaceServerError(errorCodeForFileError(error), 500);
    }
  }

  private absolute(relativePath: string): string {
    const safePath = assertSafeRelativePath(relativePath);
    const result = path.resolve(this.root, safePath);
    if (result !== this.root && !result.startsWith(`${this.root}${path.sep}`)) {
      throw new WorkspaceServerError("workspace_share_file_path_invalid", 400);
    }
    return result;
  }

  private async preparePath(relativePath: string): Promise<void> {
    const absolute = this.absolute(relativePath);
    await mkdir(path.dirname(absolute), { recursive: true, mode: 0o700 });
    await this.assertPath(path.dirname(relativePath));
  }

  private async assertPath(relativePath: string): Promise<void> {
    const safePath = relativePath ? assertSafeRelativePath(relativePath) : relativePath;
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    let current = this.root;
    const parts = safePath ? safePath.split("/") : [];
    for (const part of parts) {
      current = path.join(current, part);
      try {
        const stat = await lstat(current);
        if (stat.isSymbolicLink()) throw new WorkspaceServerError("workspace_share_file_path_invalid", 400);
      } catch (error) {
        if (isNodeFileNotFound(error)) break;
        throw error;
      }
    }
  }
}

function createShareIdentityResolvers(store: WorkspaceServerStore): {
  resolvePublicIdentity: WorkspaceShareHttpIdentityResolver;
  resolveAccountIdentity: WorkspaceShareHttpIdentityResolver;
} {
  const resolve = async (req: Request, required: boolean): Promise<WorkspaceShareHttpIdentity | null> => {
    const names = ["x-samurai-account-id", "x-samurai-public-key", "x-samurai-request-id", "x-samurai-timestamp", "x-samurai-signature"];
    const suppliedAccountId = req.header("x-samurai-account-id")?.trim();
    const suppliedPublicKey = req.header("x-samurai-public-key")?.trim();
    const hasAnyCredential = names.some((name) => Boolean(req.header(name)?.trim()));
    if (!suppliedAccountId && !suppliedPublicKey) {
      if (required || hasAnyCredential) throw new WorkspaceServerError("account_authentication_required", 401);
      return null;
    }
    if (!suppliedPublicKey) throw new WorkspaceServerError("account_authentication_required", 401);
    let accountId: string;
    try {
      accountId = accountIdFromPublicKey(suppliedPublicKey);
    } catch {
      throw new WorkspaceServerError("account_authentication_required", 401);
    }
    if (suppliedAccountId && suppliedAccountId !== accountId) {
      throw new WorkspaceServerError("account_id_public_key_mismatch", 401);
    }
    const requestId = requiredHeader(req, "x-samurai-request-id");
    const timestamp = requiredHeader(req, "x-samurai-timestamp");
    const signature = requiredHeader(req, "x-samurai-signature");
    const storedPublicKey = await store.getAccountPublicKey(accountId);
    if (storedPublicKey && !samePublicKey(storedPublicKey, suppliedPublicKey)) {
      throw new WorkspaceServerError("account_public_key_conflict", 401);
    }
    const payload = {
      method: req.method,
      path: req.path,
      ...(req.header("x-samurai-operation-id") ? { operationId: requiredHeader(req, "x-samurai-operation-id") } : {}),
      ...(req.header("idempotency-key") ? { idempotencyKey: requiredHeader(req, "idempotency-key") } : {}),
      requestId,
      timestamp,
      body: req.body ?? {}
    };
    verifyAccountSignature({ signed: { accountId, requestId, timestamp, signature }, publicKey: suppliedPublicKey, payload });
    return { accountId, publicKey: suppliedPublicKey };
  };
  return {
    resolvePublicIdentity: (req) => resolve(req, false),
    resolveAccountIdentity: (req) => resolve(req, true)
  };
}

function samePublicKey(left: string, right: string): boolean {
  try {
    const toDer = (value: string) => createPublicKey(value.startsWith("base64:")
      ? { key: Buffer.from(value.slice("base64:".length), "base64"), format: "der", type: "spki" } as const
      : value).export({ format: "der", type: "spki" });
    return toDer(left).equals(toDer(right));
  } catch {
    return false;
  }
}

function requiredHeader(req: Request, name: string): string {
  const value = req.header(name)?.trim();
  if (!value) throw new WorkspaceServerError("account_authentication_required", 401);
  return value;
}

function stripShareRoot(value: string): string {
  if (value.startsWith("workspace-shares/")) return value.slice("workspace-shares/".length);
  return value;
}

function hashSegment(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function isNodeFileNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT");
}

function errorCodeForFileError(error: unknown): string {
  return error instanceof WorkspaceServerError ? error.code : "workspace_share_file_io_failed";
}
