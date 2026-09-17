import { createHash, createHmac, randomBytes } from "node:crypto";
import { canonicalJson } from "./auth";
import { WorkspaceServerError } from "./errors";
import type { WorkspaceSql } from "./postgres";
import { z } from "zod";

/** Test/composition alias kept public so adapters can implement the same
 * typed query seam without importing the PostgreSQL module directly. */
export type WorkspaceShareSql = WorkspaceSql;

/**
 * Share Core is deliberately kept behind ports.  The HTTP/Bridge layer owns
 * authentication and the composition root supplies the PostgreSQL database,
 * file implementation, and source/import writers.  This keeps a share import
 * from being able to start a run, join a Room, or change an Agent default.
 *
 * The wire-compatible schema declarations below mirror the v1 Domain API
 * contract.  workspace-server does not depend on the Domain API package (the
 * latter depends on the public client contract), so the server validates the
 * same strict shape at this Core boundary as well.
 */

export const workspaceShareKinds = ["room_knowledge", "agent"] as const;
export type WorkspaceShareKind = (typeof workspaceShareKinds)[number];
export const workspaceShareVisibilities = ["restricted", "public"] as const;
export type WorkspaceShareVisibility = (typeof workspaceShareVisibilities)[number];

const contextId = z.string().trim().min(1).max(512);
const contextVersion = z.number().int().positive();
const contextHash = z.string().regex(/^[a-f0-9]{64}$/);
const contextTitle = z.string().trim().min(1).max(200);
const shareKind = z.enum(workspaceShareKinds);
const visibility = z.enum(workspaceShareVisibilities);
const origin = z.string().trim().min(1).max(2_048).refine((value) => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && parsed.username === "" && parsed.password === ""
      && parsed.pathname === "/" && parsed.search === "" && parsed.hash === "";
  } catch {
    return false;
  }
}, "share_origin_invalid");
const locator = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

const fileSchema = z.object({
  path: z.string().trim().min(1).max(1_024).refine((value) => !value.startsWith("/") && !value.includes("\\") && !value.includes("//")
    && value.split("/").every((part) => part !== "" && part !== "." && part !== ".."), "share_file_path_invalid"),
  encoding: z.enum(["utf8", "base64"]),
  content: z.string().min(1).max(8 * 1024 * 1024),
  byte_size: z.number().int().nonnegative(),
  sha256: contextHash
}).strict().superRefine((file, issue) => {
  if (file.encoding === "base64" && !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.content)) {
    issue.addIssue({ code: z.ZodIssueCode.custom, path: ["content"], message: "share_file_content_base64_invalid" });
  }
});

const entrySchema = z.object({
  entry_id: contextId,
  kind: z.enum(["knowledge", "skill"]),
  title: contextTitle,
  content: z.string().min(1).max(8 * 1024 * 1024),
  knowledge_kind: z.enum(["fact", "decision", "explanation", "experience_rule"]).optional(),
  files: z.array(fileSchema).max(99).default([])
}).strict().superRefine((entry, issue) => {
  if (entry.kind === "knowledge" && !entry.knowledge_kind) issue.addIssue({ code: z.ZodIssueCode.custom, path: ["knowledge_kind"], message: "knowledge_kind_required" });
  if (entry.kind === "knowledge" && entry.files.length > 0) issue.addIssue({ code: z.ZodIssueCode.custom, path: ["files"], message: "knowledge_files_forbidden" });
  if (entry.kind === "skill" && entry.knowledge_kind) issue.addIssue({ code: z.ZodIssueCode.custom, path: ["knowledge_kind"], message: "skill_knowledge_kind_forbidden" });
  const paths = entry.files.map((file) => file.path);
  if (new Set(paths).size !== paths.length) issue.addIssue({ code: z.ZodIssueCode.custom, path: ["files"], message: "file_paths_must_be_unique" });
});

const agentSchema = z.object({
  name: contextTitle,
  role: z.string().trim().min(1).max(500),
  instructions: z.string().trim().min(1).max(20_000)
}).strict();

export const workspaceShareManifestSchema = z.object({
  format_version: z.literal(1),
  kind: shareKind,
  title: contextTitle,
  entries: z.array(entrySchema).max(1_000),
  agent: agentSchema.optional()
}).strict().superRefine((manifest, issue) => {
  const hasKnowledge = manifest.entries.some((entry) => entry.kind === "knowledge");
  if (manifest.kind === "room_knowledge") {
    if (manifest.agent) issue.addIssue({ code: z.ZodIssueCode.custom, path: ["agent"], message: "room_knowledge_agent_forbidden" });
    if (!hasKnowledge) issue.addIssue({ code: z.ZodIssueCode.custom, path: ["entries"], message: "room_knowledge_entry_required" });
  }
  if (manifest.kind === "agent" && !manifest.agent) issue.addIssue({ code: z.ZodIssueCode.custom, path: ["agent"], message: "agent_manifest_required" });
  const ids = manifest.entries.map((entry) => entry.entry_id);
  if (new Set(ids).size !== ids.length) issue.addIssue({ code: z.ZodIssueCode.custom, path: ["entries"], message: "entry_ids_must_be_unique" });
  if (new TextEncoder().encode(canonicalJson(manifest)).byteLength > 32 * 1024 * 1024) issue.addIssue({ code: z.ZodIssueCode.custom, path: ["entries"], message: "manifest_too_large" });
});

export type WorkspaceShareManifest = z.infer<typeof workspaceShareManifestSchema>;
export type WorkspaceShareResourceEntry = WorkspaceShareManifest["entries"][number];
export type WorkspaceShareResourceRef = { id: string; version: number };

const resourceRefSchema = z.object({ id: contextId, version: contextVersion }).strict();
const draftCreateSchema = z.union([
  z.object({ source_kind: shareKind, source_id: contextId, resource_refs: z.array(resourceRefSchema).min(1).max(1_000).superRefine((refs, issue) => {
    if (new Set(refs.map((ref) => ref.id)).size !== refs.length) issue.addIssue({ code: z.ZodIssueCode.custom, message: "resource_refs_must_be_unique" });
  }) }).strict(),
  z.object({ base_share_id: contextId }).strict()
]);
const draftUpdateSchema = z.object({
  draft_id: contextId,
  expected_version: contextVersion,
  manifest: workspaceShareManifestSchema,
  visibility,
  recipient_account_ids: z.array(contextId).max(1_000)
}).strict();
const draftViewSchema = z.object({ draft_id: contextId }).strict();
const draftDiscardSchema = z.object({ draft_id: contextId, expected_version: contextVersion }).strict();
const publishSchema = z.object({ draft_id: contextId, expected_version: contextVersion, expected_content_hash: contextHash }).strict();
const listSchema = z.object({ source_kind: shareKind, source_id: contextId, limit: z.number().int().min(1).max(100).default(30), cursor: z.string().trim().min(1).max(4_096).optional() }).strict();
const viewSchema = z.object({ share_id: contextId }).strict();
const revokeSchema = z.object({ share_id: contextId, expected_version: contextVersion }).strict();
const importSchema = z.object({
  source_origin: origin,
  locator,
  claim_id: contextId,
  content_hash: contextHash,
  delegation: z.object({
    payload: z.object({
      version: z.literal(1), source_origin: origin, share_id: contextId, claim_id: contextId,
      recipient_account_id: contextId, target_origin: origin, target_workspace_id: contextId,
      operation_id: contextId, content_hash: contextHash,
      issued_at: z.string().datetime(), expires_at: z.string().datetime()
    }).strict(),
    public_key: z.string().trim().min(1).max(8_192),
    signature: z.string().trim().min(1).max(8_192)
  }).strict(),
  target_room_id: contextId.optional()
}).strict();

export type WorkspaceShareDraftCreateInput = z.input<typeof draftCreateSchema>;
export type WorkspaceShareDraftUpdateInput = z.input<typeof draftUpdateSchema>;
export type WorkspaceShareDraftViewInput = z.infer<typeof draftViewSchema>;
export type WorkspaceShareDraftDiscardInput = z.infer<typeof draftDiscardSchema>;
export type WorkspaceSharePublishInput = z.infer<typeof publishSchema>;
export type WorkspaceShareListInput = z.input<typeof listSchema>;
export type WorkspaceShareViewInput = z.infer<typeof viewSchema>;
export type WorkspaceShareRevokeInput = z.infer<typeof revokeSchema>;
export type WorkspaceShareImportInput = z.infer<typeof importSchema>;

export interface WorkspaceShareContext {
  workspaceId: string;
  accountId: string;
  operationId?: string;
}

export interface WorkspaceShareDatabase {
  withContext<T>(context: Pick<WorkspaceShareContext, "workspaceId" | "accountId">, action: (sql: WorkspaceSql) => Promise<T>): Promise<T>;
  /** Import file/resource writes may use the short-lived RLS import session.
   * The fallback to withContext keeps the in-memory and legacy adapters usable. */
  withImportContext?<T>(context: Pick<WorkspaceShareContext, "workspaceId" | "accountId">, importId: string, action: (sql: WorkspaceSql) => Promise<T>): Promise<T>;
}

export type WorkspaceShareAuthorizationAction =
  | "source_manage"
  | "source_read"
  | "recipient_claim"
  | "import_target"
  | "source_lifecycle_revoke";

export interface WorkspaceShareAuthorizationRequest {
  action: WorkspaceShareAuthorizationAction;
  workspaceId: string;
  accountId: string;
  sourceKind?: WorkspaceShareKind;
  sourceId?: string;
  targetRoomId?: string;
}

export interface WorkspaceShareAuthorizationResolver {
  authorize(request: WorkspaceShareAuthorizationRequest): Promise<boolean | { allowed: boolean } | void>;
}

export interface WorkspaceShareSourceSnapshot {
  kind: WorkspaceShareKind;
  sourceId: string;
  title: string;
  manifest: WorkspaceShareManifest;
  /** Management-only selected source id/version references. */
  sourceVersions: readonly WorkspaceShareResourceRef[];
  removedReferences?: readonly { entry_id: string; location: string; reason: string }[];
}

export interface WorkspaceShareSourcePort {
  snapshot(input: {
    context: WorkspaceShareContext;
    sourceKind: WorkspaceShareKind;
    sourceId: string;
    resourceRefs: readonly WorkspaceShareResourceRef[];
  }): Promise<WorkspaceShareSourceSnapshot>;
}

export interface WorkspaceShareFileStage {
  transactionId: string;
  stagedPath: string;
  finalPath: string;
}

export interface WorkspaceShareFilePort {
  stage(input: {
    workspaceId: string;
    ownerKind: "draft" | "import";
    ownerId: string;
    revision: number;
    bytes: Uint8Array;
    sha256: string;
    /**
     * The Core-generated transaction id is optional for old adapters. New
     * adapters should use it for their staging filename so the durable file
     * ledger can be created before the write begins.
     */
    transactionId?: string;
  }): Promise<WorkspaceShareFileStage>;
  rename(input: WorkspaceShareFileStage): Promise<void>;
  read(path: string): Promise<Uint8Array>;
  remove?(path: string): Promise<void>;
}

export interface WorkspaceShareImportTransportResult {
  kind: WorkspaceShareKind;
  manifest: unknown;
  /** If omitted, the canonical Manifest bytes are used. */
  bytes?: Uint8Array;
}

export interface WorkspaceShareImportTransport {
  fetch(input: {
    sourceOrigin: string;
    locator: string;
    claimId: string;
    contentHash: string;
    delegation: WorkspaceShareImportInput["delegation"];
  }): Promise<WorkspaceShareImportTransportResult>;
}

/** A verified import delegation is a process-local capability. It is never
 * written to PostgreSQL, operation results, request hashes, logs, or a
 * worker claim. A restart therefore deliberately requires a new signature. */
export interface WorkspaceShareImportCapability {
  workspaceId: string;
  recipientAccountId: string;
  operationId: string;
  sourceOrigin: string;
  locator: string;
  claimId: string;
  contentHash: string;
  targetWorkspaceId: string;
  targetRoomId: string | null;
  delegation: WorkspaceShareImportInput["delegation"];
  expiresAt: string;
}

export interface WorkspaceShareImportCapabilityRegistry {
  remember(capability: WorkspaceShareImportCapability): void;
  get(input: Pick<WorkspaceShareImportCapability, "workspaceId" | "recipientAccountId" | "operationId" | "sourceOrigin" | "locator" | "claimId" | "contentHash" | "targetWorkspaceId" | "targetRoomId">): WorkspaceShareImportCapability | null;
  forget(input: Pick<WorkspaceShareImportCapability, "workspaceId" | "recipientAccountId" | "operationId">): void;
}

/** Default in-memory registry. The key includes the recipient so a worker
 * cannot reuse a delegation for another Account/Workspace operation. */
export class InMemoryWorkspaceShareImportCapabilityRegistry implements WorkspaceShareImportCapabilityRegistry {
  private readonly entries = new Map<string, WorkspaceShareImportCapability>();
  private readonly maxEntries: number;

  constructor(private readonly now: () => Date = () => new Date(), maxEntries = 1_024) {
    this.maxEntries = Number.isSafeInteger(maxEntries) && maxEntries > 0
      ? Math.min(maxEntries, 10_000)
      : 1_024;
  }

  remember(capability: WorkspaceShareImportCapability): void {
    const expiresAt = Date.parse(capability.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= this.now().getTime()) return;
    this.sweepExpired();
    const key = capabilityKey(capability);
    if (!this.entries.has(key) && this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (typeof oldest === "string") this.entries.delete(oldest);
    }
    this.entries.set(key, { ...capability, delegation: capability.delegation });
  }

  get(input: Pick<WorkspaceShareImportCapability, "workspaceId" | "recipientAccountId" | "operationId" | "sourceOrigin" | "locator" | "claimId" | "contentHash" | "targetWorkspaceId" | "targetRoomId">): WorkspaceShareImportCapability | null {
    this.sweepExpired();
    const key = capabilityKey(input);
    const entry = this.entries.get(key);
    if (!entry) return null;
    return entry;
  }

  forget(input: Pick<WorkspaceShareImportCapability, "workspaceId" | "recipientAccountId" | "operationId">): void {
    for (const key of this.entries.keys()) {
      if (key.startsWith(`${input.workspaceId}\u0000${input.recipientAccountId}\u0000${input.operationId}\u0000`)) this.entries.delete(key);
    }
  }

  private sweepExpired(): void {
    const now = this.now().getTime();
    for (const [key, entry] of this.entries) {
      if (Date.parse(entry.expiresAt) <= now) this.entries.delete(key);
    }
  }
}

export interface WorkspaceShareImportCommitter {
  commit(input: {
    sql: WorkspaceSql;
    context: WorkspaceShareContext;
    kind: WorkspaceShareKind;
    manifest: WorkspaceShareManifest;
    reservedAgentId: string | null;
    reservedResourceIds: readonly { entryId: string; resourceId: string }[];
  }): Promise<{ createdAgentId: string | null; createdResourceIds: readonly string[] }>;
}

export interface WorkspaceShareServiceOptions {
  database: WorkspaceShareDatabase;
  authorization: WorkspaceShareAuthorizationResolver;
  files: WorkspaceShareFilePort;
  source?: WorkspaceShareSourcePort;
  importTransport?: WorkspaceShareImportTransport;
  importCommitter?: WorkspaceShareImportCommitter;
  /** The ingress may provide the account-signature verifier; structural
   * binding is always checked by this Core even when this hook is omitted. */
  delegationVerifier?: (delegation: WorkspaceShareImportInput["delegation"]) => Promise<boolean | void>;
  /** Process-local verified delegation store. It is intentionally not a DB
   * adapter and must be recreated after a process restart. */
  importCapabilityRegistry?: WorkspaceShareImportCapabilityRegistry;
  /** HMAC secret used to bind list cursors to their exact query context. */
  cursorSecret?: string;
  origin?: string;
  now?: () => Date;
  id?: (purpose: string) => string;
}

export interface WorkspaceShareDraft {
  draft_id: string;
  version: number;
  manifest: WorkspaceShareManifest;
  content_hash: string;
  visibility: WorkspaceShareVisibility;
  recipient_account_ids: string[];
  removed_references: { entry_id: string; location: string; reason: string }[];
}

export interface WorkspaceShareSummary {
  share_id: string;
  version: number;
  title: string;
  status: "draft" | "active" | "revoked";
  visibility: WorkspaceShareVisibility;
  recipient_account_ids: string[];
  url: string | null;
  created_at: string;
  published_at: string | null;
  revoked_at: string | null;
}

export interface WorkspaceShareView extends WorkspaceShareSummary {
  manifest: WorkspaceShareManifest;
  content_hash: string;
}

/** Safe anonymous/restricted projection. It intentionally has no source id,
 * internal path, recipient list, or database identifier. */
export interface WorkspaceSharePublishedView {
  title: string;
  visibility: WorkspaceShareVisibility;
  manifest: WorkspaceShareManifest;
  content_hash: string;
  published_at: string;
}

export interface WorkspaceSharePublishResult {
  share_id: string;
  version: number;
  url: string;
  content_hash: string;
  published_at: string;
}

export interface WorkspaceShareRevokeResult {
  share_id: string;
  version: number;
  status: "revoked";
  revoked_at: string;
}

export interface WorkspaceShareClaimResult {
  claim_id: string;
  share_id: string;
  recipient_account_id: string;
  target_origin: string;
  target_workspace_id: string;
  operation_id: string;
  content_hash: string;
  created_at: string;
}

export interface WorkspaceShareImportResult {
  import_id: string;
  kind: WorkspaceShareKind;
  status: "staging" | "committed" | "failed";
  phase: "fetch" | "files" | "commit" | "done" | "cleanup";
  retryable: boolean;
  failure_code: string | null;
  created_resource_ids: string[];
  created_agent_id: string | null;
  committed_at: string | null;
}

interface ShareRow {
  workspace_id: string;
  id: string;
  source_kind: WorkspaceShareKind;
  source_room_id: string | null;
  source_agent_id: string | null;
  created_by: string;
  title: string;
  status: "draft" | "active" | "revoked";
  visibility: WorkspaceShareVisibility;
  revision: number | string;
  source_versions: unknown;
  manifest_path: string | null;
  content_hash: string | null;
  byte_size: number | string | null;
  public_locator: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  published_at: Date | string | null;
  revoked_at: Date | string | null;
}

interface RecipientRow { recipient_account_id: string }
interface FileTransactionRow { id: string; entries: unknown; status: string }
interface ClaimRow {
  id: string;
  share_id: string;
  recipient_account_id: string;
  target_origin: string;
  target_workspace_id: string;
  operation_id: string;
  request_hash: string;
  content_hash: string;
  created_at: Date | string;
}
interface ImportRow {
  operation_id: string;
  recipient_account_id: string;
  kind: WorkspaceShareKind;
  source_origin: string;
  source_share_id: string;
  source_locator: string;
  claim_id: string;
  request_hash: string;
  content_hash: string;
  target_room_id: string | null;
  reserved_agent_id: string | null;
  reserved_resource_ids: unknown;
  manifest_path: string | null;
  status: "staging" | "committed" | "failed";
  phase: "fetch" | "files" | "commit" | "done" | "cleanup";
  retryable: boolean;
  failure_code: string | null;
  lease_token?: string | null;
  lease_until?: Date | string | null;
  result: unknown;
  created_at: Date | string;
  committed_at: Date | string | null;
}

interface ShareCursorPayload {
  workspace_id: string;
  account_id: string;
  source_kind: WorkspaceShareKind;
  source_id: string;
  last_id: string;
  issued_at: number;
}

interface ShareMutationFileState {
  transactionId: string;
  ownerKind: "draft" | "import";
  ownerId: string;
  stagedPath: string;
  finalPath: string;
  sha256: string;
  byteSize: number;
  manifest: WorkspaceShareManifest;
  removedReferences: readonly { entry_id: string; location: string; reason: string }[];
  status: "prepared" | "renamed";
}

interface ShareMutationActionResult<T> {
  value: T;
  afterCommit?: () => Promise<void>;
}

export interface WorkspaceShareImportLease {
  operation_id: string;
  kind: WorkspaceShareKind;
  phase: "fetch" | "files" | "commit" | "done" | "cleanup";
  lease_token: string;
  lease_until: string;
  request_hash: string;
  content_hash: string;
  source_origin: string;
  source_locator: string;
  claim_id: string;
  target_room_id: string | null;
  reserved_agent_id: string | null;
  reserved_resource_ids: readonly { entryId: string; resourceId: string }[];
}

interface ImportLeaseState {
  row: ImportRow;
  leaseToken: string | null;
  acquired: boolean;
}

interface ImportFileState {
  transactionId: string;
  stagedPath: string;
  finalPath: string;
  sha256: string;
  byteSize: number;
  manifest: WorkspaceShareManifest;
  status: "prepared" | "renamed" | "committed" | "cleanup_pending" | "cleaned";
}

const importLeaseDurationMs = 30_000;

const defaultId = (purpose: string): string => `${purpose}_${cryptoRandomId()}`;

function capabilityKey(input: Pick<WorkspaceShareImportCapability, "workspaceId" | "recipientAccountId" | "operationId" | "sourceOrigin" | "locator" | "claimId" | "contentHash" | "targetWorkspaceId" | "targetRoomId">): string {
  return [
    input.workspaceId,
    input.recipientAccountId,
    input.operationId,
    input.sourceOrigin,
    input.locator,
    input.claimId,
    input.contentHash,
    input.targetWorkspaceId,
    input.targetRoomId ?? ""
  ].join("\u0000");
}

function cryptoRandomId(): string {
  // Completion resource IDs are intentionally lowercase opaque identifiers.
  // Share/import IDs flow into that Core during a real import, so generating
  // base64url (which may contain uppercase letters) would pass Share admission
  // but fail only at the cross-Server commit boundary.
  return randomBytes(24).toString("hex");
}

function parse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, input: unknown, code: string): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new WorkspaceServerError(code, 400, {
      field_errors: result.error.issues.slice(0, 20).map((issue) => ({ path: issue.path.join("."), code: issue.message }))
    });
  }
  return result.data;
}

function iso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new WorkspaceServerError("workspace_share_timestamp_invalid", 500);
  return date.toISOString();
}

function revision(row: ShareRow): number {
  const value = Number(row.revision);
  if (!Number.isSafeInteger(value) || value <= 0) throw new WorkspaceServerError("workspace_share_revision_invalid", 500);
  return value;
}

function bytesHash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function manifestBytes(manifest: WorkspaceShareManifest): Uint8Array {
  return new TextEncoder().encode(canonicalJson(manifest));
}

function validateManifest(input: unknown, code = "workspace_share_manifest_invalid"): WorkspaceShareManifest {
  const manifest = parse(workspaceShareManifestSchema, input, code);
  for (const entry of manifest.entries) {
    for (const file of entry.files ?? []) {
      const bytes = file.encoding === "utf8" ? new TextEncoder().encode(file.content) : decodeBase64(file.content);
      if (bytes.byteLength !== file.byte_size || bytesHash(bytes) !== file.sha256) {
        throw new WorkspaceServerError("workspace_share_file_hash_mismatch", 400);
      }
    }
    for (const text of [entry.title, entry.content, ...(entry.files ?? []).map((file) => file.content), ...(manifest.agent ? [manifest.agent.name, manifest.agent.role, manifest.agent.instructions] : [])]) {
      if (/(?:^|\s)(?:file|samurai):\/\/|(?:^|\s)\/(?:Users|private|var|etc)\//i.test(text)) {
        throw new WorkspaceServerError("workspace_share_internal_reference_forbidden", 400);
      }
    }
  }
  return manifest;
}

function decodeBase64(value: string): Uint8Array {
  try {
    const decoded = Buffer.from(value, "base64");
    if (decoded.toString("base64") !== value) throw new Error("non-canonical");
    return new Uint8Array(decoded);
  } catch {
    throw new WorkspaceServerError("workspace_share_file_content_base64_invalid", 400);
  }
}

function assertInternalPath(path: string): void {
  if (!path || path.startsWith("/") || path.includes("\\") || path.split("/").some((part) => part === ".." || part === "." || part === "")) {
    throw new WorkspaceServerError("workspace_share_file_path_invalid", 500);
  }
}

function remapEntryIds(manifest: WorkspaceShareManifest, id: (purpose: string) => string): WorkspaceShareManifest {
  const entries = manifest.entries.map((entry) => ({ ...entry, files: entry.files ?? [], entry_id: id("share_entry") }));
  return { ...manifest, entries };
}

function safeJson(value: unknown, code: string): unknown {
  try { return JSON.parse(JSON.stringify(value)); } catch { throw new WorkspaceServerError(code, 500); }
}

function assertRecipientShape(kind: WorkspaceShareVisibility, recipients: readonly string[], status: "draft" | "active"): void {
  if (new Set(recipients).size !== recipients.length) throw new WorkspaceServerError("workspace_share_recipient_duplicate", 400);
  if (recipients.length > 1_000) throw new WorkspaceServerError("workspace_share_recipient_limit", 413);
  if (status === "active" && kind === "restricted" && recipients.length === 0) throw new WorkspaceServerError("workspace_share_recipient_required", 400);
  if (kind === "public" && recipients.length > 0) throw new WorkspaceServerError("workspace_share_public_recipient_forbidden", 400);
}

const shareCursorLifetimeMs = 60 * 60 * 1_000;

function cursorSignature(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function encodeCursor(secret: string, payload: ShareCursorPayload): string {
  const encoded = Buffer.from(canonicalJson(payload), "utf8").toString("base64url");
  return `${encoded}.${cursorSignature(secret, encoded)}`;
}

function decodeCursor(secret: string, cursor: string | undefined, expected: Omit<ShareCursorPayload, "last_id" | "issued_at">, now: Date): string | null {
  if (!cursor) return null;
  try {
    const [encoded, suppliedSignature] = cursor.split(".");
    if (!encoded || !suppliedSignature || suppliedSignature !== cursorSignature(secret, encoded)) throw new Error("signature");
    const decoded = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Partial<ShareCursorPayload>;
    if (decoded.workspace_id !== expected.workspace_id
      || decoded.account_id !== expected.account_id
      || decoded.source_kind !== expected.source_kind
      || decoded.source_id !== expected.source_id
      || typeof decoded.last_id !== "string"
      || decoded.last_id.length === 0
      || decoded.last_id.length > 512
      || typeof decoded.issued_at !== "number"
      || !Number.isSafeInteger(decoded.issued_at)) throw new Error("binding");
    const age = now.getTime() - decoded.issued_at;
    if (age < -60_000 || age > shareCursorLifetimeMs) throw new Error("expired");
    return decoded.last_id;
  } catch {
    throw new WorkspaceServerError("workspace_share_page_cursor_invalid", 400);
  }
}

function rowSourceId(row: ShareRow): string {
  const id = row.source_kind === "room_knowledge" ? row.source_room_id : row.source_agent_id;
  if (!id) throw new WorkspaceServerError("workspace_share_source_missing", 500);
  return id;
}

function shareUrl(baseOrigin: string | undefined, publicLocator: string | null): string | null {
  if (!baseOrigin || !publicLocator) return null;
  return `${baseOrigin.replace(/\/$/, "")}/s/${publicLocator}`;
}

function importResult(row: ImportRow): WorkspaceShareImportResult {
  const parsed = row.result && typeof row.result === "object" ? row.result as Record<string, unknown> : {};
  const ids = Array.isArray(parsed.created_resource_ids) ? parsed.created_resource_ids.filter((id): id is string => typeof id === "string") : [];
  const agentId = typeof parsed.created_agent_id === "string" ? parsed.created_agent_id : null;
  const committedAt = parsed.committed_at === null || parsed.committed_at === undefined ? null : iso(String(parsed.committed_at));
  return {
    import_id: row.operation_id,
    kind: row.kind,
    status: row.status,
    phase: row.phase,
    retryable: row.retryable,
    failure_code: row.failure_code,
    created_resource_ids: ids,
    created_agent_id: agentId,
    committed_at: committedAt
  };
}

export class WorkspaceShareService {
  private readonly now: () => Date;
  private readonly id: (purpose: string) => string;
  private readonly baseOrigin?: string;
  private readonly cursorSecret?: string;
  private readonly importCapabilities: WorkspaceShareImportCapabilityRegistry;

  constructor(private readonly options: WorkspaceShareServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.id = options.id ?? defaultId;
    this.cursorSecret = options.cursorSecret?.trim() || undefined;
    this.importCapabilities = options.importCapabilityRegistry ?? new InMemoryWorkspaceShareImportCapabilityRegistry(this.now);
    if (options.origin) {
      this.baseOrigin = parse(origin, options.origin, "workspace_share_origin_invalid");
    }
  }

  async createDraft(context: WorkspaceShareContext, rawInput: unknown): Promise<WorkspaceShareDraft> {
    const input = parse(draftCreateSchema, rawInput, "workspace_share_draft_input_invalid");
    return this.runMutation(context, "share.draft.create", input, async (sql, registerFile) => {
      let snapshot: WorkspaceShareSourceSnapshot;
      if ("base_share_id" in input) {
        const base = await this.lockShare(sql, context.workspaceId, input.base_share_id, false);
        await this.authorize(context, "source_manage", base.source_kind, rowSourceId(base));
        if (base.status !== "active" && base.status !== "revoked") throw new WorkspaceServerError("workspace_share_base_invalid", 409);
        const manifest = await this.readShareManifest(sql, base);
        snapshot = {
          kind: base.source_kind,
          sourceId: rowSourceId(base),
          title: base.title,
          manifest,
          sourceVersions: sourceVersions(base.source_versions)
        };
      } else {
        await this.authorize(context, "source_manage", input.source_kind, input.source_id);
        if (!this.options.source) throw new WorkspaceServerError("workspace_share_source_port_missing", 500);
        snapshot = await this.options.source.snapshot({
          context,
          sourceKind: input.source_kind,
          sourceId: input.source_id,
          resourceRefs: input.resource_refs
        });
        if (snapshot.kind !== input.source_kind || snapshot.sourceId !== input.source_id) throw new WorkspaceServerError("workspace_share_source_mismatch", 409);
        if (snapshot.sourceVersions.length !== input.resource_refs.length || snapshot.sourceVersions.some((ref, index) => ref.id !== input.resource_refs[index]?.id || ref.version !== input.resource_refs[index]?.version)) {
          throw new WorkspaceServerError("workspace_share_source_version_conflict", 409);
        }
      }
      const inputManifest = validateManifest(snapshot.manifest);
      if (inputManifest.kind !== snapshot.kind) throw new WorkspaceServerError("workspace_share_manifest_kind_mismatch", 409);
      const manifest = remapEntryIds(inputManifest, this.id);
      const bytes = manifestBytes(manifest);
      const contentHash = bytesHash(bytes);
      const draftId = this.id("share_draft");
      const createdAt = this.now();
      const staged = await this.stageMutationFile(sql, context, {
        ownerKind: "draft",
        ownerId: draftId,
        revision: 1,
        bytes,
        sha256: contentHash,
        manifest,
        removedReferences: snapshot.removedReferences
      }, registerFile);
      await sql.query(
        `INSERT INTO workspace_shares
          (workspace_id, id, source_kind, source_room_id, source_agent_id, created_by, title, status, visibility, revision, source_versions, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'draft', 'restricted', 1, $8::JSONB, $9, $9)`,
        [context.workspaceId, draftId, snapshot.kind, snapshot.kind === "room_knowledge" ? snapshot.sourceId : null, snapshot.kind === "agent" ? snapshot.sourceId : null, context.accountId, manifest.title, JSON.stringify(snapshot.sourceVersions), createdAt]
      );
      return { value: await this.draftFrom(sql, { ...emptyDraftRow(context, draftId, snapshot, manifest, createdAt), manifest, contentHash, stagedPath: staged.stagedPath }, [], snapshot.removedReferences) };
    });
  }

  async updateDraft(context: WorkspaceShareContext, rawInput: unknown): Promise<WorkspaceShareDraft> {
    const input = parse(draftUpdateSchema, rawInput, "workspace_share_draft_update_invalid");
    assertRecipientShape(input.visibility, input.recipient_account_ids, "draft");
    const manifest = validateManifest(input.manifest);
    return this.runMutation(context, "share.draft.update", input, async (sql, registerFile) => {
      const row = await this.lockShare(sql, context.workspaceId, input.draft_id, true);
      await this.authorize(context, "source_manage", row.source_kind, rowSourceId(row));
      this.assertDraftOwner(row, context);
      if (row.status !== "draft") throw new WorkspaceServerError("workspace_share_draft_state_conflict", 409);
      this.assertExpectedVersion(row, input.expected_version);
      if (manifest.kind !== row.source_kind) throw new WorkspaceServerError("workspace_share_manifest_kind_mismatch", 409);
      const existing = await this.readDraftManifest(sql, row);
      if (existing.manifest.entries.map((entry) => entry.entry_id).join("\u0000") !== manifest.entries.map((entry) => entry.entry_id).join("\u0000")) {
        throw new WorkspaceServerError("workspace_share_entry_set_immutable", 409);
      }
      for (const [index, oldEntry] of existing.manifest.entries.entries()) {
        if (oldEntry.kind !== manifest.entries[index]?.kind) throw new WorkspaceServerError("workspace_share_entry_kind_immutable", 409);
      }
      const bytes = manifestBytes(manifest);
      const contentHash = bytesHash(bytes);
      const nextVersion = revision(row) + 1;
      const staged = await this.stageMutationFile(sql, context, {
        ownerKind: "draft",
        ownerId: row.id,
        revision: nextVersion,
        bytes,
        sha256: contentHash,
        manifest,
        removedReferences: existing.removedReferences
      }, registerFile);
      await sql.query(
        `UPDATE workspace_shares SET title = $3, visibility = $4, revision = $5, updated_at = $6
         WHERE workspace_id = $1 AND id = $2 AND status = 'draft' AND revision = $7`,
        [context.workspaceId, row.id, manifest.title, input.visibility, nextVersion, this.now(), revision(row)]
      );
      await sql.query(
        `DELETE FROM workspace_share_recipients WHERE workspace_id = $1 AND share_id = $2`,
        [context.workspaceId, row.id]
      );
      for (const recipient of input.recipient_account_ids) {
        await sql.query(
          `INSERT INTO workspace_share_recipients (workspace_id, share_id, recipient_account_id) VALUES ($1, $2, $3)`,
          [context.workspaceId, row.id, recipient]
        );
      }
      const updated = { ...row, title: manifest.title, visibility: input.visibility, revision: nextVersion, updated_at: this.now() };
      return { value: await this.draftFrom(sql, { ...updated, manifest, contentHash, stagedPath: staged.stagedPath }, input.recipient_account_ids, existing.removedReferences) };
    });
  }

  async viewDraft(context: WorkspaceShareContext, rawInput: unknown): Promise<WorkspaceShareDraft> {
    const input = parse(draftViewSchema, rawInput, "workspace_share_draft_view_input_invalid");
    return this.options.database.withContext(context, async (sql) => {
      const row = await this.lockShare(sql, context.workspaceId, input.draft_id, false);
      await this.authorize(context, "source_manage", row.source_kind, rowSourceId(row));
      this.assertDraftOwner(row, context);
      if (row.status !== "draft") throw new WorkspaceServerError("workspace_share_draft_not_found", 404);
      return this.draftFrom(sql, row);
    });
  }

  async discardDraft(context: WorkspaceShareContext, rawInput: unknown): Promise<{ draft_id: string; discarded: true }> {
    const input = parse(draftDiscardSchema, rawInput, "workspace_share_draft_discard_input_invalid");
    return this.runMutation(context, "share.draft.discard", input, async (sql) => {
      const row = await this.lockShare(sql, context.workspaceId, input.draft_id, true);
      await this.authorize(context, "source_manage", row.source_kind, rowSourceId(row));
      this.assertDraftOwner(row, context);
      if (row.status !== "draft") throw new WorkspaceServerError("workspace_share_draft_state_conflict", 409);
      this.assertExpectedVersion(row, input.expected_version);
      const staged = await this.readDraftTransaction(sql, row);
      await sql.query(`DELETE FROM workspace_share_recipients WHERE workspace_id = $1 AND share_id = $2`, [context.workspaceId, row.id]);
      if (staged) await this.updateFileTransactionStatus(sql, context.workspaceId, staged.id, "cleanup_pending", this.now());
      await sql.query(`DELETE FROM workspace_shares WHERE workspace_id = $1 AND id = $2 AND status = 'draft'`, [context.workspaceId, row.id]);
      return {
        value: { draft_id: row.id, discarded: true as const },
        afterCommit: staged && this.options.files.remove
          ? async () => {
              try {
                await this.options.files.remove!(staged.path);
                await this.options.database.withContext(context, async (cleanupSql) => {
                  await this.updateFileTransactionStatus(cleanupSql, context.workspaceId, staged.id, "cleaned", this.now());
                });
              } catch {
                // Keep cleanup_pending for the recovery worker.
              }
            }
          : undefined
      };
    });
  }

  async publish(context: WorkspaceShareContext, rawInput: unknown): Promise<WorkspaceSharePublishResult> {
    const input = parse(publishSchema, rawInput, "workspace_share_publish_input_invalid");
    return this.runMutation(context, "share.publish", input, async (sql, registerFile) => {
      const row = await this.lockShare(sql, context.workspaceId, input.draft_id, true);
      await this.authorize(context, "source_manage", row.source_kind, rowSourceId(row));
      this.assertDraftOwner(row, context);
      if (row.status === "active") {
        throw new WorkspaceServerError("workspace_share_publish_state_conflict", 409);
      }
      if (row.status === "revoked") throw new WorkspaceServerError("workspace_share_publish_state_conflict", 409);
      this.assertExpectedVersion(row, input.expected_version);
      const draft = await this.readDraftManifest(sql, row);
      if (draft.contentHash !== input.expected_content_hash) throw new WorkspaceServerError("workspace_share_content_hash_conflict", 409, { latest_version: revision(row) });
      const recipients = await this.recipientIds(sql, context.workspaceId, row.id);
      assertRecipientShape(row.visibility, recipients, "active");
      const bytes = manifestBytes(draft.manifest);
      if (bytesHash(bytes) !== input.expected_content_hash) throw new WorkspaceServerError("workspace_share_content_hash_conflict", 409);
      const staged = await this.stageMutationFile(sql, context, {
        ownerKind: "draft",
        ownerId: row.id,
        revision: revision(row) + 1,
        bytes,
        sha256: input.expected_content_hash,
        manifest: draft.manifest
      }, registerFile);
      await this.options.files.rename(staged);
      registerFile({
        transactionId: staged.transactionId,
        ownerKind: "draft",
        ownerId: row.id,
        stagedPath: staged.stagedPath,
        finalPath: staged.finalPath,
        sha256: input.expected_content_hash,
        byteSize: bytes.byteLength,
        manifest: draft.manifest,
        removedReferences: [],
        status: "renamed"
      });
      // Persist the rename marker in its own short transaction. If the final
      // share-row transaction fails after the physical rename, recovery still
      // has a durable path/hash entry to clean or replay.
      await this.options.database.withContext(context, async (ledgerSql) => {
        await this.recordFileTransaction(ledgerSql, context, "draft", row.id, staged, input.expected_content_hash, bytes.byteLength, "renamed", draft.manifest);
      });
      const publishedAt = this.now();
      const publicLocator = this.makeLocator(row.id, input.expected_content_hash);
      const nextVersion = revision(row) + 1;
      await sql.query(
        `UPDATE workspace_shares
           SET status = 'active', revision = $3, manifest_path = $4, content_hash = $5, byte_size = $6,
               public_locator = $7, published_at = $8, updated_at = $8
         WHERE workspace_id = $1 AND id = $2 AND status = 'draft' AND revision = $9`,
        [context.workspaceId, row.id, nextVersion, staged.finalPath, input.expected_content_hash, bytes.byteLength, publicLocator, publishedAt, revision(row)]
      );
      await this.updateFileTransactionStatus(sql, context.workspaceId, staged.transactionId, "committed", publishedAt);
      return { value: { share_id: row.id, version: nextVersion, url: shareUrl(this.baseOrigin, publicLocator) ?? `/s/${publicLocator}`, content_hash: input.expected_content_hash, published_at: iso(publishedAt) } };
    });
  }

  async list(context: WorkspaceShareContext, rawInput: unknown): Promise<{ items: WorkspaceShareSummary[]; next_cursor: string | null }> {
    const input = parse(listSchema, rawInput, "workspace_share_list_input_invalid");
    if (!this.cursorSecret) throw new WorkspaceServerError("workspace_share_cursor_secret_unavailable", 503);
    const afterId = decodeCursor(this.cursorSecret, input.cursor, {
      workspace_id: context.workspaceId,
      account_id: context.accountId,
      source_kind: input.source_kind,
      source_id: input.source_id
    }, this.now());
    const limit = input.limit ?? 30;
    return this.options.database.withContext(context, async (sql) => {
      await this.authorize(context, "source_manage", input.source_kind, input.source_id);
      const rows = await sql.query<ShareRow>(
        `SELECT * FROM workspace_shares
          WHERE workspace_id = $1 AND source_kind = $2
            AND (source_room_id = CASE WHEN $2 = 'room_knowledge' THEN $3 ELSE NULL END
              OR source_agent_id = CASE WHEN $2 = 'agent' THEN $3 ELSE NULL END)
            AND (status = 'active' OR (status = 'draft' AND created_by = $4))
            AND ($5::TEXT IS NULL OR id > $5)
          ORDER BY id ASC LIMIT $6`,
        [context.workspaceId, input.source_kind, input.source_id, context.accountId, afterId, limit + 1]
      );
      const selected = rows.rows.slice(0, limit);
      const items = await Promise.all(selected.map((row) => this.summaryFrom(sql, row)));
      return {
        items,
        next_cursor: rows.rows.length > limit && selected.length > 0
          ? encodeCursor(this.cursorSecret!, {
              workspace_id: context.workspaceId,
              account_id: context.accountId,
              source_kind: input.source_kind,
              source_id: input.source_id,
              last_id: selected[selected.length - 1]!.id,
              issued_at: this.now().getTime()
            })
          : null
      };
    });
  }

  async view(context: WorkspaceShareContext, rawInput: unknown): Promise<WorkspaceShareView> {
    const input = parse(viewSchema, rawInput, "workspace_share_view_input_invalid");
    return this.options.database.withContext(context, async (sql) => {
      const row = await this.lockShare(sql, context.workspaceId, input.share_id, false);
      await this.authorize(context, "source_manage", row.source_kind, rowSourceId(row));
      if (row.status === "draft") this.assertDraftOwner(row, context);
      const manifest = row.status === "draft" ? (await this.readDraftManifest(sql, row)).manifest : await this.readShareManifest(sql, row);
      const contentHash = row.status === "draft" ? (await this.readDraftManifest(sql, row)).contentHash : row.content_hash;
      if (!contentHash) throw new WorkspaceServerError("workspace_share_content_missing", 500);
      return { ...(await this.summaryFrom(sql, row)), manifest, content_hash: contentHash };
    });
  }

  /** Public/restricted dedicated projection. `workspaceId` may be omitted for
   * anonymous public access; RLS composition roots can route this operation to
   * their narrowly scoped share reader. */
  async viewPublished(input: { locator: string; accountId?: string; workspaceId?: string }): Promise<WorkspaceSharePublishedView> {
    const parsedLocator = parse(locator, input.locator, "workspace_share_locator_invalid");
    const databaseContext = { workspaceId: input.workspaceId ?? "", accountId: input.accountId ?? "anonymous" };
    return this.options.database.withContext(databaseContext, async (sql) => {
      const rows = await sql.query<ShareRow>(
        `SELECT * FROM workspace_shares WHERE public_locator = $1 AND status = 'active' LIMIT 1`,
        [parsedLocator]
      );
      const row = rows.rows[0];
      if (!row) throw new WorkspaceServerError("share_unavailable", 404);
      const recipients = await this.recipientIds(sql, row.workspace_id, row.id);
      if (row.visibility === "restricted" && (!input.accountId || !recipients.includes(input.accountId))) throw new WorkspaceServerError("share_unavailable", 404);
      const manifest = await this.readShareManifest(sql, row);
      if (!row.content_hash || !row.published_at) throw new WorkspaceServerError("workspace_share_content_missing", 500);
      return { title: row.title, visibility: row.visibility, manifest, content_hash: row.content_hash, published_at: iso(row.published_at) };
    });
  }

  async revoke(context: WorkspaceShareContext, rawInput: unknown): Promise<WorkspaceShareRevokeResult> {
    const input = parse(revokeSchema, rawInput, "workspace_share_revoke_input_invalid");
    return this.runMutation(context, "share.revoke", input, async (sql) => {
      const row = await this.lockShare(sql, context.workspaceId, input.share_id, true);
      await this.authorize(context, "source_manage", row.source_kind, rowSourceId(row));
      if (row.status === "revoked") return { value: { share_id: row.id, version: revision(row), status: "revoked", revoked_at: iso(row.revoked_at ?? this.now()) } };
      if (row.status !== "active") throw new WorkspaceServerError("workspace_share_revoke_state_conflict", 409);
      this.assertExpectedVersion(row, input.expected_version);
      const revokedAt = this.now();
      const nextVersion = revision(row) + 1;
      await sql.query(`UPDATE workspace_shares SET status = 'revoked', revision = $3, revoked_at = $4, updated_at = $4 WHERE workspace_id = $1 AND id = $2 AND status = 'active' AND revision = $5`, [context.workspaceId, row.id, nextVersion, revokedAt, revision(row)]);
      return { value: { share_id: row.id, version: nextVersion, status: "revoked", revoked_at: iso(revokedAt) } };
    });
  }

  async claim(context: WorkspaceShareContext, input: { shareId: string; targetOrigin: string; targetWorkspaceId: string; operationId: string; contentHash: string; requestHash: string; claimId?: string }): Promise<WorkspaceShareClaimResult> {
    const shareId = parse(contextId, input.shareId, "workspace_share_claim_input_invalid");
    const targetOrigin = parse(origin, input.targetOrigin, "workspace_share_claim_input_invalid");
    const targetWorkspaceId = parse(contextId, input.targetWorkspaceId, "workspace_share_claim_input_invalid");
    const operationId = parse(contextId, input.operationId, "workspace_share_claim_input_invalid");
    const contentHash = parse(contextHash, input.contentHash, "workspace_share_claim_input_invalid");
    const requestHash = parse(contextHash, input.requestHash, "workspace_share_claim_input_invalid");
    return this.options.database.withContext(context, async (sql) => {
      const share = await this.lockShare(sql, context.workspaceId, shareId, true);
      const existing = await sql.query<ClaimRow>(`SELECT * FROM workspace_share_claims WHERE workspace_id = $1 AND share_id = $2 AND recipient_account_id = $3 AND target_origin = $4 AND target_workspace_id = $5 AND operation_id = $6 FOR UPDATE`, [context.workspaceId, shareId, context.accountId, targetOrigin, targetWorkspaceId, operationId]);
      const prior = existing.rows[0];
      if (prior) {
        if (prior.request_hash !== requestHash || prior.content_hash !== contentHash) throw new WorkspaceServerError("workspace_share_claim_conflict", 409);
        return claimResult(prior);
      }
      await this.authorize(context, "recipient_claim", share.source_kind, rowSourceId(share));
      const recipients = await this.recipientIds(sql, context.workspaceId, shareId);
      if (share.visibility === "restricted" && !recipients.includes(context.accountId)) throw new WorkspaceServerError("share_unavailable", 404);
      if (share.status !== "active") throw new WorkspaceServerError("share_revoked", 410);
      if (share.content_hash !== contentHash) throw new WorkspaceServerError("workspace_share_content_hash_conflict", 409);
      const id = input.claimId ? parse(contextId, input.claimId, "workspace_share_claim_input_invalid") : this.id("share_claim");
      const createdAt = this.now();
      await sql.query(`INSERT INTO workspace_share_claims (workspace_id, id, share_id, recipient_account_id, target_origin, target_workspace_id, operation_id, request_hash, content_hash, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [context.workspaceId, id, shareId, context.accountId, targetOrigin, targetWorkspaceId, operationId, requestHash, contentHash, createdAt]);
      return { claim_id: id, share_id: shareId, recipient_account_id: context.accountId, target_origin: targetOrigin, target_workspace_id: targetWorkspaceId, operation_id: operationId, content_hash: contentHash, created_at: iso(createdAt) };
    });
  }

  async import(context: WorkspaceShareContext, rawInput: unknown): Promise<WorkspaceShareImportResult> {
    const input = parse(importSchema, rawInput, "workspace_share_import_input_invalid");
    const operationId = this.requireOperationId(context);
    const kind: WorkspaceShareKind = input.target_room_id ? "room_knowledge" : "agent";
    await this.authorize(context, "import_target", kind, undefined, input.target_room_id);
    const requestHash = this.importRequestHash(context, input, kind);
    const existing = await this.readImportRow(context, operationId);
    if (existing) {
      this.assertImportIdentity(existing, context, input, kind, requestHash);
      if (existing.status !== "staging" || !existing.retryable) return importResult(existing);
    }
    try {
      this.assertDelegation(context, input, kind);
    } catch (error) {
      // A staging operation is deliberately kept resumable when its short
      // delegation expired. The client must sign the same semantic input
      // again; this request never starts a fetch or changes durable state.
      if (existing?.status === "staging" && error instanceof WorkspaceServerError && error.code === "workspace_share_delegation_expired") {
        throw new WorkspaceServerError("authorization_refresh_required", 409);
      }
      throw error;
    }
    if (this.options.delegationVerifier) {
      const valid = await this.options.delegationVerifier(input.delegation);
      if (valid === false) throw new WorkspaceServerError("workspace_share_delegation_invalid", 403);
    }
    const reservedAgentId = existing?.reserved_agent_id ?? (kind === "agent" ? this.id("import_agent") : null);
    let row = existing ?? await this.ensureImportRecord(context, input, kind, requestHash, reservedAgentId);
    // Persist the operation row first. If admission fails (for example a
    // unique/identity conflict), no process-local capability is left behind
    // for a row that was never accepted.
    this.rememberImportCapability(context, input, kind);
    if (existing && this.isImportAutoPaused(existing)) {
      row = await this.clearImportRetryPause(context, operationId);
    }
    return importResult(row);
  }

  async importStatus(context: WorkspaceShareContext, rawInput: unknown): Promise<WorkspaceShareImportResult> {
    const operationId = parse(z.object({ operation_id: contextId }).strict(), rawInput, "workspace_share_import_status_input_invalid").operation_id;
    return this.readImportStatus(context, operationId);
  }

  /**
   * Claims one durable import lease for the recovery worker.  The lease is
   * bound to the already-authorized recipient row; it does not contain, and
   * never returns, the source delegation or its public-key material.
   */
  async claimImport(context: WorkspaceShareContext, rawInput: unknown): Promise<WorkspaceShareImportLease | null> {
    const operationId = parse(z.object({ operation_id: contextId }).strict(), rawInput, "workspace_share_import_claim_input_invalid").operation_id;
    return this.options.database.withContext(context, async (sql) => {
      const rows = await sql.query<ImportRow>(`SELECT * FROM workspace_share_imports WHERE workspace_id = $1 AND operation_id = $2 FOR UPDATE`, [context.workspaceId, operationId]);
      const row = rows.rows[0];
      if (!row || row.recipient_account_id !== context.accountId) throw new WorkspaceServerError("workspace_share_import_not_found", 404);
      await this.authorize(context, "import_target", row.kind, undefined, row.target_room_id ?? undefined);
      if (row.status !== "staging" || !row.retryable || this.isImportAutoPaused(row) || this.hasActiveLease(row)) return null;
      const token = this.id("share_import_lease");
      const leaseUntil = new Date(this.now().getTime() + importLeaseDurationMs);
      const claimed = await sql.query<ImportRow>(
        `UPDATE workspace_share_imports
            SET lease_token = $3, lease_until = $4, updated_at = $4
          WHERE workspace_id = $1 AND operation_id = $2 AND status = 'staging' AND phase IN ('fetch','files','commit') AND retryable = TRUE
            AND (lease_token IS NULL OR lease_until <= $5)
          RETURNING *`,
        [context.workspaceId, operationId, token, leaseUntil, this.now()]
      );
      const claimedRow = claimed.rows[0];
      return claimedRow ? this.importLease(claimedRow, token, leaseUntil) : null;
    });
  }

  /** Extends a worker lease without touching imported content. */
  async heartbeatImport(context: WorkspaceShareContext, rawInput: unknown): Promise<WorkspaceShareImportLease> {
    const input = parse(z.object({ operation_id: contextId, lease_token: contextId }).strict(), rawInput, "workspace_share_import_heartbeat_input_invalid");
    return this.options.database.withContext(context, async (sql) => {
      const rows = await sql.query<ImportRow>(`SELECT * FROM workspace_share_imports WHERE workspace_id = $1 AND operation_id = $2 FOR UPDATE`, [context.workspaceId, input.operation_id]);
      const row = rows.rows[0];
      if (!row || row.recipient_account_id !== context.accountId) throw new WorkspaceServerError("workspace_share_import_not_found", 404);
      await this.authorize(context, "import_target", row.kind, undefined, row.target_room_id ?? undefined);
      if (row.status !== "staging" || !row.retryable || !["fetch", "files", "commit"].includes(row.phase) || row.lease_token !== input.lease_token || !this.hasActiveLease(row)) {
        throw new WorkspaceServerError("workspace_share_import_lease_conflict", 409);
      }
      const leaseUntil = new Date(this.now().getTime() + importLeaseDurationMs);
      const updated = await sql.query<ImportRow>(`UPDATE workspace_share_imports SET lease_until = $4, updated_at = $4 WHERE workspace_id = $1 AND operation_id = $2 AND lease_token = $3 AND status = 'staging' AND phase IN ('fetch','files','commit') RETURNING *`, [context.workspaceId, input.operation_id, input.lease_token, leaseUntil]);
      const updatedRow = updated.rows[0];
      if (!updatedRow) throw new WorkspaceServerError("workspace_share_import_lease_conflict", 409);
      return this.importLease(updatedRow, input.lease_token, leaseUntil);
    });
  }

  /**
   * Completes the DB side of an import after its file batch is renamed.  A
   * worker may call this after a process restart; all body bytes are read and
   * checked before opening the short commit transaction, so no network or
   * filesystem wait is performed while the import row is locked.
   */
  async settleImport(context: WorkspaceShareContext, rawInput: unknown): Promise<WorkspaceShareImportResult> {
    const input = parse(z.object({ operation_id: contextId, lease_token: contextId }).strict(), rawInput, "workspace_share_import_settle_input_invalid");
    const row = await this.readImportRow(context, input.operation_id);
    if (!row || row.recipient_account_id !== context.accountId) throw new WorkspaceServerError("workspace_share_import_not_found", 404);
    await this.authorize(context, "import_target", row.kind, undefined, row.target_room_id ?? undefined);
    if (row.status === "committed" || (row.status === "failed" && !row.retryable)) return importResult(row);
    if (row.lease_token !== input.lease_token || !this.hasActiveLease(row)) throw new WorkspaceServerError("workspace_share_import_lease_conflict", 409);
    const fileState = await this.readImportFileState(context, input.operation_id);
    if (!fileState || (fileState.status !== "renamed" && fileState.status !== "committed")) throw new WorkspaceServerError("workspace_share_import_not_ready", 409);
    if (fileState.manifest.kind !== row.kind) throw new WorkspaceServerError("workspace_share_manifest_kind_mismatch", 400);
    const bytes = await this.options.files.read(fileState.finalPath);
    if (bytesHash(bytes) !== row.content_hash || bytes.byteLength !== fileState.byteSize) throw new WorkspaceServerError("workspace_share_file_hash_mismatch", 409);
    const reservedAgentId = row.reserved_agent_id;
    const reservedResourceIds = this.reservedResourceIds(row, fileState.manifest);
    return this.settleImportLease(context, input.operation_id, input.lease_token, row.kind, row.target_room_id, fileState.manifest, reservedAgentId, reservedResourceIds, fileState);
  }

  /** Worker-only file phase. It requires a live process-local capability when
   * a source fetch is still needed, but can resume an already verified file
   * ledger without contacting the source again. */
  async executeImportLease(
    context: WorkspaceShareContext,
    input: { operation_id: string; lease_token: string },
    heartbeat?: () => Promise<void>
  ): Promise<{ status: "committed" }> {
    const row = await this.readImportRow(context, input.operation_id);
    if (!row || row.recipient_account_id !== context.accountId) throw new WorkspaceServerError("workspace_share_import_not_found", 404);
    if (row.status !== "staging" || !row.retryable || row.lease_token !== input.lease_token || !this.hasActiveLease(row)) {
      throw new WorkspaceServerError("workspace_share_import_lease_conflict", 409);
    }
    await this.authorize(context, "import_target", row.kind, undefined, row.target_room_id ?? undefined);
    let fileState = await this.readImportFileState(context, input.operation_id);
    let manifest: WorkspaceShareManifest;
    let bytes: Uint8Array;
    if (fileState) {
      manifest = fileState.manifest;
      if (manifest.kind !== row.kind) throw new WorkspaceServerError("workspace_share_manifest_kind_mismatch", 400);
      const bodyPath = fileState.status === "prepared" ? fileState.stagedPath : fileState.finalPath;
      bytes = await this.options.files.read(bodyPath);
      if (bytesHash(bytes) !== row.content_hash || bytes.byteLength !== fileState.byteSize) {
        throw new WorkspaceServerError("workspace_share_file_hash_mismatch", 409);
      }
    } else {
      const capability = this.importCapabilities.get({
        workspaceId: context.workspaceId,
        recipientAccountId: context.accountId,
        operationId: row.operation_id,
        sourceOrigin: row.source_origin,
        locator: row.source_locator,
        claimId: row.claim_id,
        contentHash: row.content_hash,
        targetWorkspaceId: context.workspaceId,
        targetRoomId: row.target_room_id
      });
      if (!capability) throw new WorkspaceServerError("authorization_refresh_required", 409);
      if (!this.options.importTransport) throw new WorkspaceServerError("workspace_share_import_transport_missing", 503);
      await heartbeat?.();
      const fetched = await this.options.importTransport.fetch({
        sourceOrigin: capability.sourceOrigin,
        locator: capability.locator,
        claimId: capability.claimId,
        contentHash: capability.contentHash,
        delegation: capability.delegation
      });
      if (fetched.kind !== row.kind) throw new WorkspaceServerError("workspace_share_manifest_kind_mismatch", 400);
      manifest = validateManifest(fetched.manifest, "workspace_share_import_manifest_invalid");
      if (manifest.kind !== row.kind) throw new WorkspaceServerError("workspace_share_manifest_kind_mismatch", 400);
      bytes = fetched.bytes ?? manifestBytes(manifest);
      if (bytesHash(bytes) !== row.content_hash) throw new WorkspaceServerError("workspace_share_content_hash_conflict", 409);
      const reservedResourceIds = this.reservedResourceIds(row, manifest);
      fileState = await this.prepareImportFile(context, row.operation_id, input.lease_token, manifest, bytes, row.reserved_agent_id, reservedResourceIds);
    }
    await heartbeat?.();
    if (fileState.status === "prepared") {
      await this.options.files.rename({ transactionId: fileState.transactionId, stagedPath: fileState.stagedPath, finalPath: fileState.finalPath });
      await this.markImportFileRenamed(context, row.operation_id, input.lease_token, fileState);
    }
    // The adapter calls settleImportWorker after this point. Returning the
    // committed-shaped result means the worker never treats staging as a
    // successful import until the short DB commit has completed.
    return { status: "committed" };
  }

  /** Worker-only settlement. Retryable capability/transport failures keep the
   * import in staging; terminal validation/authorization failures move it to
   * cleanup without creating Completion rows. */
  async settleImportWorker(
    context: WorkspaceShareContext,
    input: { operation_id: string; lease_token: string; result: { status: "committed" | "retryable" | "failed"; failureCode?: string } }
  ): Promise<WorkspaceShareImportResult> {
    if (input.result.status === "committed") return this.settleImport(context, { operation_id: input.operation_id, lease_token: input.lease_token });
    return this.options.database.withContext(context, async (sql) => {
      const rows = await sql.query<ImportRow>(`SELECT * FROM workspace_share_imports WHERE workspace_id = $1 AND operation_id = $2 FOR UPDATE`, [context.workspaceId, input.operation_id]);
      const row = rows.rows[0];
      if (!row || row.recipient_account_id !== context.accountId) throw new WorkspaceServerError("workspace_share_import_not_found", 404);
      if (row.lease_token !== input.lease_token || !this.hasActiveLease(row)) throw new WorkspaceServerError("workspace_share_import_lease_conflict", 409);
      const retryable = input.result.status === "retryable";
      const failureCode = input.result.failureCode?.trim() || "workspace_share_import_failed";
      const phase = retryable ? row.phase : "cleanup";
      await sql.query(
        `UPDATE workspace_share_imports
            SET status = $3, phase = $4, retryable = $5, failure_code = $6, lease_token = NULL, lease_until = NULL, updated_at = $7
          WHERE workspace_id = $1 AND operation_id = $2 AND lease_token = $8`,
        [context.workspaceId, input.operation_id, retryable ? "staging" : "failed", phase, retryable, failureCode, this.now(), input.lease_token]
      );
      const updated = await sql.query<ImportRow>(`SELECT * FROM workspace_share_imports WHERE workspace_id = $1 AND operation_id = $2`, [context.workspaceId, input.operation_id]);
      if (!updated.rows[0]) throw new WorkspaceServerError("workspace_share_import_not_found", 404);
      return importResult(updated.rows[0]);
    });
  }

  /** Rechecks destination authorization using the persisted recipient. */
  async recheckImportTarget(context: WorkspaceShareContext, operationId: string): Promise<void> {
    const row = await this.readImportRow(context, operationId);
    if (!row || row.recipient_account_id !== context.accountId) throw new WorkspaceServerError("workspace_share_import_not_found", 404);
    await this.authorize(context, "import_target", row.kind, undefined, row.target_room_id ?? undefined);
  }

  /** Claims the next due import under a maintenance-visible row lock, then
   * returns the persisted recipient so all subsequent Core work uses that
   * Account context rather than the maintenance identity. */
  async claimNextImport(context: WorkspaceShareContext, input: {
    workerId: string;
    leaseMs: number;
    now?: Date;
    excludeOperationIds?: readonly string[];
  }): Promise<{ lease: WorkspaceShareImportLease; recipientAccountId: string } | null> {
    const now = input.now ?? this.now();
    return this.options.database.withContext(context, async (sql) => {
      const excluded = [...new Set((input.excludeOperationIds ?? []).filter((value) => typeof value === "string" && value.trim()))].slice(0, 100);
      const exclusionClause = excluded.length > 0 ? " AND NOT (operation_id = ANY($3::TEXT[]))" : "";
      const rows = await sql.query<ImportRow>(
        `SELECT * FROM workspace_share_imports
          WHERE workspace_id = $1 AND status = 'staging' AND retryable = TRUE
            AND phase IN ('fetch','files','commit')
            AND (failure_code IS NULL OR failure_code NOT IN ('authorization_refresh_required', 'workspace_share_import_retry_exhausted'))
            AND (lease_token IS NULL OR lease_until <= $2)
            ${exclusionClause}
          ORDER BY updated_at ASC, operation_id ASC
          FOR UPDATE SKIP LOCKED LIMIT 1`,
        excluded.length > 0 ? [context.workspaceId, now, excluded] : [context.workspaceId, now]
      );
      const row = rows.rows[0];
      if (!row) return null;
      const token = this.id(`share_import_lease_${input.workerId}`);
      const leaseUntil = new Date(now.getTime() + Math.min(Math.max(Math.trunc(input.leaseMs), 5_000), 30_000));
      const claimed = await sql.query<ImportRow>(
        `UPDATE workspace_share_imports SET lease_token = $3, lease_until = $4, updated_at = $4
          WHERE workspace_id = $1 AND operation_id = $2 AND status = 'staging' AND retryable = TRUE
            AND (lease_token IS NULL OR lease_until <= $5) RETURNING *`,
        [context.workspaceId, row.operation_id, token, leaseUntil, now]
      );
      const claimedRow = claimed.rows[0];
      return claimedRow ? { lease: this.importLease(claimedRow, token, leaseUntil), recipientAccountId: claimedRow.recipient_account_id } : null;
    });
  }

  private async readImportRow(context: WorkspaceShareContext, operationId: string): Promise<ImportRow | null> {
    return this.options.database.withContext(context, async (sql) => {
      const rows = await sql.query<ImportRow>(`SELECT * FROM workspace_share_imports WHERE workspace_id = $1 AND operation_id = $2`, [context.workspaceId, operationId]);
      return rows.rows[0] ?? null;
    });
  }

  private rememberImportCapability(context: WorkspaceShareContext, input: WorkspaceShareImportInput, kind: WorkspaceShareKind): void {
    this.importCapabilities.remember({
      workspaceId: context.workspaceId,
      recipientAccountId: context.accountId,
      operationId: context.operationId ?? "",
      sourceOrigin: input.source_origin,
      locator: input.locator,
      claimId: input.claim_id,
      contentHash: input.content_hash,
      targetWorkspaceId: context.workspaceId,
      targetRoomId: kind === "room_knowledge" ? input.target_room_id ?? null : null,
      delegation: input.delegation,
      expiresAt: input.delegation.payload.expires_at
    });
  }

  private async ensureImportRecord(
    context: WorkspaceShareContext,
    input: WorkspaceShareImportInput,
    kind: WorkspaceShareKind,
    requestHash: string,
    reservedAgentId: string | null
  ): Promise<ImportRow> {
    const operationId = this.requireOperationId(context);
    return this.options.database.withContext(context, async (sql) => {
      await sql.query(
        `INSERT INTO workspace_share_imports
          (workspace_id, operation_id, recipient_account_id, kind, source_origin, source_share_id, source_locator, claim_id, request_hash, content_hash, target_room_id, reserved_agent_id, status, phase, retryable, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'staging','fetch',TRUE,$13,$13)
         ON CONFLICT (workspace_id, operation_id) DO NOTHING`,
        [context.workspaceId, operationId, context.accountId, kind, input.source_origin, input.delegation.payload.share_id, input.locator, input.claim_id, requestHash, input.content_hash, input.target_room_id ?? null, reservedAgentId, this.now()]
      );
      const rows = await sql.query<ImportRow>(`SELECT * FROM workspace_share_imports WHERE workspace_id = $1 AND operation_id = $2 FOR UPDATE`, [context.workspaceId, operationId]);
      const row = rows.rows[0];
      if (!row) throw new WorkspaceServerError("workspace_share_import_not_found", 404);
      this.assertImportIdentity(row, context, input, kind, requestHash);
      return row;
    });
  }

  private assertImportIdentity(row: ImportRow, context: WorkspaceShareContext, input: WorkspaceShareImportInput, kind: WorkspaceShareKind, requestHash: string): void {
    if (row.recipient_account_id !== context.accountId || row.request_hash !== requestHash || row.content_hash !== input.content_hash || row.kind !== kind || row.source_origin !== input.source_origin || row.source_locator !== input.locator || row.claim_id !== input.claim_id) {
      throw new WorkspaceServerError("workspace_share_import_conflict", 409);
    }
  }

  private hasActiveLease(row: ImportRow): boolean {
    if (!row.lease_token || !row.lease_until) return false;
    const until = row.lease_until instanceof Date ? row.lease_until.getTime() : Date.parse(String(row.lease_until));
    return Number.isFinite(until) && until > this.now().getTime();
  }

  private isImportAutoPaused(row: Pick<ImportRow, "failure_code">): boolean {
    return row.failure_code === "authorization_refresh_required"
      || row.failure_code === "workspace_share_import_retry_exhausted";
  }

  private async clearImportRetryPause(context: WorkspaceShareContext, operationId: string): Promise<ImportRow> {
    return this.options.database.withContext(context, async (sql) => {
      await sql.query(
        `UPDATE workspace_share_imports
            SET failure_code = NULL, updated_at = $3
          WHERE workspace_id = $1 AND operation_id = $2 AND status = 'staging' AND retryable = TRUE
            AND failure_code IN ('authorization_refresh_required', 'workspace_share_import_retry_exhausted')`,
        [context.workspaceId, operationId, this.now()]
      );
      const rows = await sql.query<ImportRow>(`SELECT * FROM workspace_share_imports WHERE workspace_id = $1 AND operation_id = $2`, [context.workspaceId, operationId]);
      const row = rows.rows[0];
      if (!row || row.recipient_account_id !== context.accountId) throw new WorkspaceServerError("workspace_share_import_not_found", 404);
      return row;
    });
  }

  private async acquireImportLease(context: WorkspaceShareContext, input: WorkspaceShareImportInput, kind: WorkspaceShareKind, requestHash: string, reservedAgentId: string | null): Promise<ImportLeaseState> {
    const operationId = this.requireOperationId(context);
    return this.options.database.withContext(context, async (sql) => {
      const inserted = await sql.query<ImportRow>(
        `INSERT INTO workspace_share_imports
          (workspace_id, operation_id, recipient_account_id, kind, source_origin, source_share_id, source_locator, claim_id, request_hash, content_hash, target_room_id, reserved_agent_id, status, phase, retryable, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'staging','fetch',TRUE,$13,$13)
         ON CONFLICT (workspace_id, operation_id) DO NOTHING
         RETURNING *`,
        [context.workspaceId, operationId, context.accountId, kind, input.source_origin, input.delegation.payload.share_id, input.locator, input.claim_id, requestHash, input.content_hash, input.target_room_id ?? null, reservedAgentId, this.now()]
      );
      const existing = inserted.rows[0] ?? (await sql.query<ImportRow>(`SELECT * FROM workspace_share_imports WHERE workspace_id = $1 AND operation_id = $2 FOR UPDATE`, [context.workspaceId, operationId])).rows[0];
      if (!existing) throw new WorkspaceServerError("workspace_share_import_not_found", 404);
      this.assertImportIdentity(existing, context, input, kind, requestHash);
      await this.authorize(context, "import_target", kind, undefined, input.target_room_id);
      if (existing.status !== "staging" || !existing.retryable || this.hasActiveLease(existing)) return { row: existing, leaseToken: null, acquired: false };
      const token = this.id("share_import_lease");
      const leaseUntil = new Date(this.now().getTime() + importLeaseDurationMs);
      const claimed = await sql.query<ImportRow>(
        `UPDATE workspace_share_imports
            SET lease_token = $3, lease_until = $4, updated_at = $4
          WHERE workspace_id = $1 AND operation_id = $2 AND status = 'staging' AND phase IN ('fetch','files','commit') AND retryable = TRUE
            AND (lease_token IS NULL OR lease_until <= $5)
          RETURNING *`,
        [context.workspaceId, operationId, token, leaseUntil, this.now()]
      );
      const row = claimed.rows[0];
      return row ? { row, leaseToken: token, acquired: true } : { row: existing, leaseToken: null, acquired: false };
    });
  }

  private importLease(row: ImportRow, token: string, leaseUntil: Date): WorkspaceShareImportLease {
    return {
      operation_id: row.operation_id,
      kind: row.kind,
      phase: row.phase,
      lease_token: token,
      lease_until: leaseUntil.toISOString(),
      request_hash: row.request_hash,
      content_hash: row.content_hash,
      source_origin: row.source_origin,
      source_locator: row.source_locator,
      claim_id: row.claim_id,
      target_room_id: row.target_room_id,
      reserved_agent_id: row.reserved_agent_id,
      reserved_resource_ids: this.parseReservedResourceIds(row.reserved_resource_ids)
    };
  }

  private withImportContext<T>(context: WorkspaceShareContext, operationId: string, action: (sql: WorkspaceSql) => Promise<T>): Promise<T> {
    if (this.options.database.withImportContext) return this.options.database.withImportContext(context, operationId, action);
    return this.options.database.withContext(context, action);
  }

  private parseReservedResourceIds(value: unknown): { entryId: string; resourceId: string }[] {
    if (typeof value === "string") {
      try { value = JSON.parse(value); } catch { value = []; }
    }
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is { entryId: string; resourceId: string } => Boolean(item) && typeof item === "object" && typeof (item as { entryId?: unknown }).entryId === "string" && typeof (item as { resourceId?: unknown }).resourceId === "string")
      .map((item) => ({ entryId: item.entryId, resourceId: item.resourceId }));
  }

  private reservedResourceIds(row: ImportRow, manifest: WorkspaceShareManifest): { entryId: string; resourceId: string }[] {
    const prior = this.parseReservedResourceIds(row.reserved_resource_ids);
    if (prior.length === manifest.entries.length && manifest.entries.every((entry) => prior.some((item) => item.entryId === entry.entry_id))) return prior;
    return manifest.entries.map((entry) => ({ entryId: entry.entry_id, resourceId: this.id("import_resource") }));
  }

  private async prepareImportFile(
    context: WorkspaceShareContext,
    operationId: string,
    leaseToken: string,
    manifest: WorkspaceShareManifest,
    bytes: Uint8Array,
    reservedAgentId: string | null,
    reservedResourceIds: readonly { entryId: string; resourceId: string }[]
  ): Promise<ImportFileState> {
    const transactionId = this.id("share_import_file");
    const placeholder: WorkspaceShareFileStage = {
      transactionId,
      stagedPath: `workspace-shares/pending/${transactionId}/staged`,
      finalPath: `workspace-shares/pending/${transactionId}/final`
    };
    const baseState = {
      transactionId,
      stagedPath: placeholder.stagedPath,
      finalPath: placeholder.finalPath,
      sha256: bytesHash(bytes),
      byteSize: bytes.byteLength,
      manifest,
      status: "prepared" as const
    };
    // The committed ledger row is intentionally created before the adapter
    // writes bytes. A crash after this point is therefore recoverable without
    // guessing a path from a directory listing.
    await this.withImportContext(context, operationId, async (sql) => {
      await this.recordFileTransaction(sql, context, "import", operationId, placeholder, baseState.sha256, baseState.byteSize, "prepared", manifest);
      const updated = await sql.query<{ operation_id: string }>(
        `UPDATE workspace_share_imports
            SET reserved_agent_id = $3, reserved_resource_ids = $4::JSONB, phase = 'files', failure_code = NULL, updated_at = $5
          WHERE workspace_id = $1 AND operation_id = $2 AND status = 'staging' AND retryable = TRUE AND lease_token = $6`,
        [context.workspaceId, operationId, reservedAgentId, JSON.stringify(reservedResourceIds), this.now(), leaseToken]
      );
      if (updated.rowCount !== 1) throw new WorkspaceServerError("workspace_share_import_lease_conflict", 409);
    });
    try {
      const stagedRaw = await this.options.files.stage({ workspaceId: context.workspaceId, ownerKind: "import", ownerId: operationId, revision: 1, bytes, sha256: baseState.sha256, transactionId });
      const staged = { ...stagedRaw, transactionId };
      assertInternalPath(staged.stagedPath);
      assertInternalPath(staged.finalPath);
      await this.withImportContext(context, operationId, async (sql) => {
        await this.recordFileTransaction(sql, context, "import", operationId, staged, baseState.sha256, baseState.byteSize, "prepared", manifest);
        const updated = await sql.query<{ operation_id: string }>(
          `UPDATE workspace_share_imports SET phase = 'files', updated_at = $4 WHERE workspace_id = $1 AND operation_id = $2 AND status = 'staging' AND retryable = TRUE AND lease_token = $3`,
          [context.workspaceId, operationId, leaseToken, this.now()]
        );
        if (updated.rowCount !== 1) throw new WorkspaceServerError("workspace_share_import_lease_conflict", 409);
      });
      return { ...baseState, stagedPath: staged.stagedPath, finalPath: staged.finalPath };
    } catch (error) {
      await this.withImportContext(context, operationId, async (sql) => {
        await this.updateFileTransactionStatus(sql, context.workspaceId, transactionId, "cleanup_pending", this.now());
        await sql.query(`UPDATE workspace_share_imports SET lease_token = NULL, lease_until = NULL, phase = 'files', retryable = TRUE, failure_code = $3, updated_at = $4 WHERE workspace_id = $1 AND operation_id = $2 AND status = 'staging' AND lease_token = $5`, [context.workspaceId, operationId, error instanceof WorkspaceServerError ? error.code : "workspace_share_import_stage_failed", this.now(), leaseToken]);
      }).catch(() => undefined);
      throw error;
    }
  }

  private async readImportFileState(context: WorkspaceShareContext, operationId: string): Promise<ImportFileState | null> {
    return this.withImportContext(context, operationId, async (sql) => {
      await this.enableShareFileLedger(sql);
      const rows = await sql.query<FileTransactionRow>(
        `SELECT id, entries, status FROM workspace_share_file_transactions WHERE workspace_id = $1 AND owner_kind = 'import' AND owner_id = $2 AND status IN ('prepared','renamed','committed') ORDER BY updated_at DESC, id DESC LIMIT 1`,
        [context.workspaceId, operationId]
      );
      const row = rows.rows[0];
      const entry = row?.entries;
      if (!row || !Array.isArray(entry) || !entry[0] || typeof entry[0] !== "object") return null;
      const value = entry[0] as Record<string, unknown>;
      if (typeof value.staged_path !== "string" || typeof value.final_path !== "string" || typeof value.sha256 !== "string" || !Number.isSafeInteger(value.byte_size) || !value.manifest) return null;
      assertInternalPath(value.staged_path);
      assertInternalPath(value.final_path);
      return {
        transactionId: row.id,
        stagedPath: value.staged_path,
        finalPath: value.final_path,
        sha256: value.sha256,
        byteSize: Number(value.byte_size),
        manifest: validateManifest(value.manifest, "workspace_share_import_manifest_invalid"),
        status: row.status as ImportFileState["status"]
      };
    });
  }

  private async markImportFileRenamed(context: WorkspaceShareContext, operationId: string, leaseToken: string, fileState: ImportFileState): Promise<void> {
    await this.withImportContext(context, operationId, async (sql) => {
      await this.recordFileTransaction(sql, context, "import", operationId, { transactionId: fileState.transactionId, stagedPath: fileState.stagedPath, finalPath: fileState.finalPath }, fileState.sha256, fileState.byteSize, "renamed", fileState.manifest);
      const updated = await sql.query<{ operation_id: string }>(
        `UPDATE workspace_share_imports SET phase = 'commit', updated_at = $4 WHERE workspace_id = $1 AND operation_id = $2 AND status = 'staging' AND retryable = TRUE AND lease_token = $3`,
        [context.workspaceId, operationId, leaseToken, this.now()]
      );
      if (updated.rowCount !== 1) throw new WorkspaceServerError("workspace_share_import_lease_conflict", 409);
    });
  }

  private async settleImportLease(
    context: WorkspaceShareContext,
    operationId: string,
    leaseToken: string,
    kind: WorkspaceShareKind,
    targetRoomId: string | null,
    manifest: WorkspaceShareManifest,
    reservedAgentId: string | null,
    reservedResourceIds: readonly { entryId: string; resourceId: string }[],
    fileState: ImportFileState
  ): Promise<WorkspaceShareImportResult> {
    // Re-check the destination immediately before the short commit
    // transaction. The earlier check only authorized request admission; it
    // must not survive a long fetch/stage/rename interval.
    await this.authorize(context, "import_target", kind, undefined, targetRoomId ?? undefined);
    return this.withImportContext(context, operationId, async (sql) => {
      const rows = await sql.query<ImportRow>(`SELECT * FROM workspace_share_imports WHERE workspace_id = $1 AND operation_id = $2 FOR UPDATE`, [context.workspaceId, operationId]);
      const row = rows.rows[0];
      if (!row || row.recipient_account_id !== context.accountId) throw new WorkspaceServerError("workspace_share_import_not_found", 404);
      if (row.status === "committed") return importResult(row);
      if (row.status === "failed" && !row.retryable) return importResult(row);
      if (row.kind !== kind || row.lease_token !== leaseToken || !this.hasActiveLease(row) || row.phase !== "commit") throw new WorkspaceServerError("workspace_share_import_lease_conflict", 409);
      let createdAgentId = reservedAgentId;
      let createdResourceIds = reservedResourceIds.map((entry) => entry.resourceId);
      if (this.options.importCommitter) {
        const result = await this.options.importCommitter.commit({ sql, context: { ...context, operationId }, kind, manifest, reservedAgentId, reservedResourceIds });
        createdAgentId = result.createdAgentId;
        createdResourceIds = [...result.createdResourceIds];
      }
      const committedAt = this.now();
      const result = { created_agent_id: createdAgentId, created_resource_ids: createdResourceIds, committed_at: iso(committedAt) };
      await sql.query(`UPDATE workspace_share_imports SET reserved_agent_id = $3, reserved_resource_ids = $4::JSONB, manifest_path = $5, status = 'committed', phase = 'done', retryable = FALSE, failure_code = NULL, lease_token = NULL, lease_until = NULL, result = $6::JSONB, updated_at = $7, committed_at = $7 WHERE workspace_id = $1 AND operation_id = $2 AND lease_token = $8`, [context.workspaceId, operationId, createdAgentId, JSON.stringify(reservedResourceIds), fileState.finalPath, JSON.stringify(result), committedAt, leaseToken]);
      for (const entry of reservedResourceIds) {
        await sql.query(`INSERT INTO workspace_share_import_resources (workspace_id, operation_id, entry_id, resource_id) VALUES ($1,$2,$3,$4) ON CONFLICT (workspace_id, operation_id, entry_id) DO NOTHING`, [context.workspaceId, operationId, entry.entryId, entry.resourceId]);
      }
      await this.updateFileTransactionStatus(sql, context.workspaceId, fileState.transactionId, "committed", committedAt);
      return importResult({ ...row, reserved_agent_id: createdAgentId, reserved_resource_ids: reservedResourceIds, manifest_path: fileState.finalPath, status: "committed", phase: "done", retryable: false, failure_code: null, lease_token: null, lease_until: null, result, committed_at: committedAt });
    });
  }

  private async handleImportFailure(context: WorkspaceShareContext, operationId: string, leaseToken: string, error: unknown, fileState: ImportFileState | null): Promise<WorkspaceShareImportResult> {
    const code = error instanceof WorkspaceServerError ? error.code : "workspace_share_import_failed";
    const transientConflict = error instanceof WorkspaceServerError && ["workspace_share_import_lease_conflict", "workspace_share_import_in_progress"].includes(error.code);
    const permanent = error instanceof WorkspaceServerError && !transientConflict && (error.status === 400 || error.status === 403 || error.status === 404 || error.status === 409);
    return this.withImportContext(context, operationId, async (sql) => {
      const phase = fileState?.status === "renamed" || fileState?.status === "committed" ? "commit" : fileState ? "files" : "fetch";
      if (fileState && permanent) await this.updateFileTransactionStatus(sql, context.workspaceId, fileState.transactionId, "cleanup_pending", this.now());
      await sql.query(
        `UPDATE workspace_share_imports
            SET status = $3, phase = $4, retryable = $5, failure_code = $6, lease_token = NULL, lease_until = NULL, updated_at = $7
          WHERE workspace_id = $1 AND operation_id = $2 AND status = 'staging' AND lease_token = $8`,
        [context.workspaceId, operationId, permanent ? "failed" : "staging", permanent ? "cleanup" : phase, !permanent, code, this.now(), leaseToken]
      );
      const rows = await sql.query<ImportRow>(`SELECT * FROM workspace_share_imports WHERE workspace_id = $1 AND operation_id = $2`, [context.workspaceId, operationId]);
      const row = rows.rows[0];
      if (!row || row.recipient_account_id !== context.accountId) throw new WorkspaceServerError("workspace_share_import_not_found", 404);
      return importResult(row);
    });
  }

  async revokeForSourceDeletion(context: WorkspaceShareContext, input: { sourceKind: WorkspaceShareKind; sourceId: string }): Promise<number> {
    return this.revokeForSourceLifecycle(context, input, "workspace_share_source_deleted");
  }

  async revokeForAuthorizationLoss(context: WorkspaceShareContext, input: { sourceKind: WorkspaceShareKind; sourceId: string }): Promise<number> {
    return this.revokeForSourceLifecycle(context, input, "workspace_share_source_authorization_lost");
  }

  private async revokeForSourceLifecycle(context: WorkspaceShareContext, input: { sourceKind: WorkspaceShareKind; sourceId: string }, _reason: string): Promise<number> {
    const sourceKind = parse(shareKind, input.sourceKind, "workspace_share_source_invalid");
    const sourceId = parse(contextId, input.sourceId, "workspace_share_source_invalid");
    return this.options.database.withContext(context, async (sql) => {
      await this.authorize(context, "source_lifecycle_revoke", sourceKind, sourceId);
      const rows = await sql.query<ShareRow>(`SELECT * FROM workspace_shares WHERE workspace_id = $1 AND source_kind = $2 AND (source_room_id = CASE WHEN $2 = 'room_knowledge' THEN $3 ELSE NULL END OR source_agent_id = CASE WHEN $2 = 'agent' THEN $3 ELSE NULL END) AND status = 'active' FOR UPDATE`, [context.workspaceId, sourceKind, sourceId]);
      const revokedAt = this.now();
      for (const row of rows.rows) await sql.query(`UPDATE workspace_shares SET status = 'revoked', revision = revision + 1, revoked_at = $4, updated_at = $4 WHERE workspace_id = $1 AND id = $2 AND status = 'active'`, [context.workspaceId, row.id, revision(row), revokedAt]);
      return rows.rows.length;
    });
  }

  /**
   * All Share mutations use the existing Workspace operation ledger. The
   * operation row is locked before the action starts, so a concurrent retry
   * waits for the first transaction and receives the exact stored result.
   * Files are deliberately tracked inside the savepoint and retained as a
   * cleanup_pending ledger entry when the action fails.
   */
  private async runMutation<T>(
    context: WorkspaceShareContext,
    action: string,
    input: unknown,
    callback: (sql: WorkspaceSql, registerFile: (state: ShareMutationFileState) => void) => Promise<ShareMutationActionResult<T>>
  ): Promise<T> {
    const operationId = this.requireOperationId(context);
    const requestHash = createHash("sha256").update(canonicalJson({ action, input })).digest("hex");
    let originalFailure: unknown;
    let afterCommit: (() => Promise<void>) | undefined;
    let fileState: ShareMutationFileState | undefined;
    const result = await this.options.database.withContext(context, async (sql) => {
      const inserted = await sql.query<{ id: string }>(
        `INSERT INTO workspace_operations(workspace_id, id, idempotency_key, actor_account_id, request_hash, status)
         VALUES ($1, $2, $2, $3, $4, 'running')
         ON CONFLICT (workspace_id, idempotency_key) DO NOTHING
         RETURNING id`,
        [context.workspaceId, operationId, context.accountId, requestHash]
      );
      if (!inserted.rows[0]) {
        const existing = await sql.query<{ request_hash: string; status: string; result: unknown; error_code?: string | null }>(
          `SELECT request_hash, status, result, error_code
             FROM workspace_operations
            WHERE workspace_id = $1 AND idempotency_key = $2
            FOR UPDATE`,
          [context.workspaceId, operationId]
        );
        const operation = existing.rows[0];
        if (!operation || operation.request_hash !== requestHash) throw new WorkspaceServerError("workspace_operation_id_reused", 409);
        if (operation.status === "failed") {
          throw new WorkspaceServerError(operation.error_code || "workspace_operation_previously_failed", 409);
        }
        if (operation.status !== "completed" || operation.result === null || operation.result === undefined) {
          throw new WorkspaceServerError("workspace_operation_in_progress", 409);
        }
        let storedResult: unknown = operation.result;
        if (typeof storedResult === "string") {
          try { storedResult = JSON.parse(storedResult); } catch { throw new WorkspaceServerError("workspace_operation_result_invalid", 500); }
        }
        return { value: storedResult as T, replayed: true };
      }

      await sql.query("SAVEPOINT workspace_share_mutation");
      try {
        const completed = await callback(sql, (state) => { fileState = state; });
        await sql.query("RELEASE SAVEPOINT workspace_share_mutation");
        await sql.query(
          `UPDATE workspace_operations SET status = 'completed', result = $3::JSONB, error_code = NULL, updated_at = $4
            WHERE workspace_id = $1 AND idempotency_key = $2`,
          [context.workspaceId, operationId, canonicalJson(completed.value === undefined ? {} : completed.value), this.now()]
        );
        afterCommit = completed.afterCommit;
        return { value: completed.value, replayed: false };
      } catch (error) {
        await sql.query("ROLLBACK TO SAVEPOINT workspace_share_mutation").catch(() => undefined);
        await sql.query("RELEASE SAVEPOINT workspace_share_mutation").catch(() => undefined);
        if (fileState) {
          await this.recordFileTransaction(
            sql,
            context,
            fileState.ownerKind,
            fileState.ownerId,
            fileState,
            fileState.sha256,
            fileState.byteSize,
            "cleanup_pending",
            fileState.manifest,
            fileState.removedReferences
          );
        }
        const errorCode = error instanceof WorkspaceServerError ? error.code : "workspace_share_operation_failed";
        await sql.query(
          `UPDATE workspace_operations SET status = 'failed', error_code = $3, updated_at = $4
            WHERE workspace_id = $1 AND idempotency_key = $2`,
          [context.workspaceId, operationId, errorCode, this.now()]
        );
        originalFailure = error;
        return { value: undefined as T, replayed: false };
      }
    });
    if (originalFailure) throw originalFailure;
    if (afterCommit) await afterCommit().catch(() => undefined);
    return result.value;
  }

  private requireOperationId(context: WorkspaceShareContext): string {
    if (!context.operationId || !context.operationId.trim()) throw new WorkspaceServerError("workspace_share_operation_id_required", 400);
    return context.operationId;
  }

  private async stageMutationFile(
    _sql: WorkspaceSql,
    context: WorkspaceShareContext,
    input: { ownerKind: "draft" | "import"; ownerId: string; revision: number; bytes: Uint8Array; sha256: string; manifest: WorkspaceShareManifest; removedReferences?: readonly { entry_id: string; location: string; reason: string }[] },
    registerFile: (state: ShareMutationFileState) => void
  ): Promise<WorkspaceShareFileStage> {
    const transactionId = this.id("share_file");
    const placeholder: WorkspaceShareFileStage = {
      transactionId,
      stagedPath: `workspace-shares/pending/${transactionId}/staged`,
      finalPath: `workspace-shares/pending/${transactionId}/final`
    };
    const removedReferences = input.removedReferences ?? [];
    const state = (stage: WorkspaceShareFileStage, status: "prepared" | "renamed" = "prepared"): ShareMutationFileState => ({
      transactionId,
      ownerKind: input.ownerKind,
      ownerId: input.ownerId,
      stagedPath: stage.stagedPath,
      finalPath: stage.finalPath,
      sha256: input.sha256,
      byteSize: input.bytes.byteLength,
      manifest: input.manifest,
      removedReferences,
      status
    });
    // Persist and commit a transaction row before the adapter is allowed to
    // write. The paths are replaced with the adapter's checked paths
    // immediately after stage; the placeholder itself is safe and never read
    // as a body path.
    await this.options.database.withContext(context, async (ledgerSql) => {
      await this.recordFileTransaction(ledgerSql, context, input.ownerKind, input.ownerId, placeholder, input.sha256, input.bytes.byteLength, "prepared", input.manifest, removedReferences);
    });
    registerFile(state(placeholder));
    const stagedRaw = await this.options.files.stage({ workspaceId: context.workspaceId, ...input, transactionId });
    const staged = { ...stagedRaw, transactionId };
    assertInternalPath(staged.stagedPath);
    assertInternalPath(staged.finalPath);
    await this.options.database.withContext(context, async (ledgerSql) => {
      await this.recordFileTransaction(ledgerSql, context, input.ownerKind, input.ownerId, staged, input.sha256, input.bytes.byteLength, "prepared", input.manifest, removedReferences);
    });
    registerFile(state(staged));
    return staged;
  }

  private async updateFileTransactionStatus(sql: WorkspaceSql, workspaceId: string, transactionId: string, status: ShareMutationFileState["status"] | "committed" | "cleanup_pending" | "cleaned", at: Date): Promise<void> {
    await this.enableShareFileLedger(sql);
    await sql.query(
      `UPDATE workspace_share_file_transactions SET status = $3, updated_at = $4 WHERE workspace_id = $1 AND id = $2`,
      [workspaceId, transactionId, status, at]
    );
  }

  private async authorize(context: WorkspaceShareContext, action: WorkspaceShareAuthorizationAction, sourceKind?: WorkspaceShareKind, sourceId?: string, targetRoomId?: string): Promise<void> {
    const result = await this.options.authorization.authorize({ action, workspaceId: context.workspaceId, accountId: context.accountId, sourceKind, sourceId, targetRoomId });
    if (result === false || (result && typeof result === "object" && result.allowed === false)) throw new WorkspaceServerError(action === "import_target" ? "workspace_share_import_target_forbidden" : "workspace_share_permission_denied", 403);
  }

  private async lockShare(sql: WorkspaceSql, workspaceId: string, shareId: string, forUpdate: boolean): Promise<ShareRow> {
    const rows = await sql.query<ShareRow>(`SELECT * FROM workspace_shares WHERE workspace_id = $1 AND id = $2${forUpdate ? " FOR UPDATE" : ""}`, [workspaceId, shareId]);
    const row = rows.rows[0];
    if (!row) throw new WorkspaceServerError("workspace_share_not_found", 404);
    return row;
  }

  private assertDraftOwner(row: ShareRow, context: WorkspaceShareContext): void {
    if (row.created_by !== context.accountId) throw new WorkspaceServerError("workspace_share_not_found", 404);
  }

  private assertExpectedVersion(row: ShareRow, expected: number): void {
    if (revision(row) !== expected) throw new WorkspaceServerError("share_version_conflict", 409, { latest_version: revision(row) });
  }

  private async recipientIds(sql: WorkspaceSql, workspaceId: string, shareId: string): Promise<string[]> {
    const rows = await sql.query<RecipientRow>(`SELECT recipient_account_id FROM workspace_share_recipients WHERE workspace_id = $1 AND share_id = $2 ORDER BY recipient_account_id ASC`, [workspaceId, shareId]);
    return rows.rows.map((row) => row.recipient_account_id);
  }

  private async summaryFrom(sql: WorkspaceSql, row: ShareRow): Promise<WorkspaceShareSummary> {
    return {
      share_id: row.id,
      version: revision(row),
      title: row.title,
      status: row.status,
      visibility: row.visibility,
      recipient_account_ids: await this.recipientIds(sql, row.workspace_id, row.id),
      url: shareUrl(this.baseOrigin, row.public_locator),
      created_at: iso(row.created_at),
      published_at: row.published_at ? iso(row.published_at) : null,
      revoked_at: row.revoked_at ? iso(row.revoked_at) : null
    };
  }

  private async draftFrom(sql: WorkspaceSql, row: ShareRow & { manifest?: WorkspaceShareManifest; contentHash?: string; stagedPath?: string }, recipients?: readonly string[], removedReferences?: readonly { entry_id: string; location: string; reason: string }[]): Promise<WorkspaceShareDraft> {
    const draft = row.manifest ? { manifest: row.manifest, contentHash: row.contentHash, removedReferences: removedReferences ? [...removedReferences] : [] } : await this.readDraftManifest(sql, row);
    if (!draft.contentHash) throw new WorkspaceServerError("workspace_share_content_missing", 500);
    return {
      draft_id: row.id,
      version: revision(row),
      manifest: draft.manifest,
      content_hash: draft.contentHash,
      visibility: row.visibility,
      recipient_account_ids: recipients ? [...recipients] : await this.recipientIds(sql, row.workspace_id, row.id),
      removed_references: removedReferences ? [...removedReferences] : draft.removedReferences
    };
  }

  private async readDraftManifest(sql: WorkspaceSql, row: ShareRow): Promise<{ manifest: WorkspaceShareManifest; contentHash: string; stagedPath?: string; removedReferences: { entry_id: string; location: string; reason: string }[] }> {
    const transaction = await this.readDraftTransaction(sql, row);
    if (!transaction) throw new WorkspaceServerError("workspace_share_draft_content_missing", 500);
    const bytes = await this.options.files.read(transaction.path);
    if (bytesHash(bytes) !== transaction.sha256) throw new WorkspaceServerError("workspace_share_file_hash_mismatch", 409);
    const manifest = validateManifest(JSON.parse(new TextDecoder().decode(bytes)));
    return { manifest, contentHash: transaction.sha256, stagedPath: transaction.path, removedReferences: transaction.removedReferences };
  }

  private async readShareManifest(_sql: WorkspaceSql, row: ShareRow): Promise<WorkspaceShareManifest> {
    if (!row.manifest_path || !row.content_hash) throw new WorkspaceServerError("workspace_share_content_missing", 500);
    const bytes = await this.options.files.read(row.manifest_path);
    if (bytesHash(bytes) !== row.content_hash) throw new WorkspaceServerError("workspace_share_file_hash_mismatch", 409);
    return validateManifest(JSON.parse(new TextDecoder().decode(bytes)));
  }

  private async readDraftTransaction(sql: WorkspaceSql, row: ShareRow): Promise<{ id: string; path: string; sha256: string; removedReferences: { entry_id: string; location: string; reason: string }[] } | null> {
    await this.enableShareFileLedger(sql);
    const rows = await sql.query<FileTransactionRow>(`SELECT id, entries, status FROM workspace_share_file_transactions WHERE workspace_id = $1 AND owner_kind = 'draft' AND owner_id = $2 AND status IN ('prepared','renamed') ORDER BY updated_at DESC, id DESC LIMIT 1`, [row.workspace_id, row.id]);
    const entry = rows.rows[0]?.entries;
    if (!Array.isArray(entry) || !entry[0] || typeof entry[0] !== "object") return null;
    const value = entry[0] as Record<string, unknown>;
    if (typeof value.staged_path !== "string" || typeof value.sha256 !== "string") return null;
    const removed = Array.isArray(value.removed_references) ? value.removed_references.filter((item): item is { entry_id: string; location: string; reason: string } => Boolean(item) && typeof item === "object" && typeof (item as { entry_id?: unknown }).entry_id === "string" && typeof (item as { location?: unknown }).location === "string" && typeof (item as { reason?: unknown }).reason === "string") : [];
    return { id: rows.rows[0]!.id, path: value.staged_path, sha256: value.sha256, removedReferences: removed };
  }

  private async recordFileTransaction(sql: WorkspaceSql, context: WorkspaceShareContext, ownerKind: "draft" | "import", ownerId: string, staged: WorkspaceShareFileStage, sha256: string, byteSize: number, status: "prepared" | "renamed" | "cleanup_pending" | "cleaned", manifest: WorkspaceShareManifest, removedReferences: readonly { entry_id: string; location: string; reason: string }[] = []): Promise<void> {
    await this.enableShareFileLedger(sql);
    await sql.query(`INSERT INTO workspace_share_file_transactions (workspace_id, id, owner_kind, owner_id, actor_account_id, status, entries, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7::JSONB,$8,$8) ON CONFLICT (workspace_id,id) DO UPDATE SET status = EXCLUDED.status, entries = EXCLUDED.entries, updated_at = EXCLUDED.updated_at`, [context.workspaceId, staged.transactionId, ownerKind, ownerId, context.accountId, status, JSON.stringify([{ staged_path: staged.stagedPath, final_path: staged.finalPath, sha256, byte_size: byteSize, manifest: safeJson(manifest, "workspace_share_manifest_invalid"), removed_references: safeJson(removedReferences, "workspace_share_removed_references_invalid") }]), this.now()]);
  }

  /**
   * Share's file transaction ledger is a Core-owned write path.  The initial
   * draft row is recorded before workspace_shares exists, so an RLS policy
   * cannot authorize it by joining the parent share row.  A transaction-local
   * marker set only by these internal helpers gives the narrow path an
   * explicit capability without broadening the runtime role.
   */
  private async enableShareFileLedger(sql: WorkspaceSql): Promise<void> {
    await sql.query("SELECT set_config('samurai.share_operation', '1', true)");
  }

  private publishResult(row: ShareRow): WorkspaceSharePublishResult {
    if (!row.content_hash || !row.public_locator || !row.published_at) throw new WorkspaceServerError("workspace_share_content_missing", 500);
    return { share_id: row.id, version: revision(row), url: shareUrl(this.baseOrigin, row.public_locator) ?? `/s/${row.public_locator}`, content_hash: row.content_hash, published_at: iso(row.published_at) };
  }

  private makeLocator(shareId: string, contentHash: string): string {
    const bytes = createHash("sha256").update(`${shareId}:${contentHash}:${this.now().toISOString()}:${this.id("locator_seed")}`).digest();
    return bytes.toString("base64url").slice(0, 43);
  }

  private assertDelegation(context: WorkspaceShareContext, input: WorkspaceShareImportInput, kind: WorkspaceShareKind): void {
    const payload = input.delegation.payload;
    if (payload.source_origin !== input.source_origin || payload.claim_id !== input.claim_id || payload.recipient_account_id !== context.accountId || payload.target_origin !== this.baseOrigin || payload.target_workspace_id !== context.workspaceId || payload.content_hash !== input.content_hash || payload.operation_id !== context.operationId || (kind === "room_knowledge") !== Boolean(input.target_room_id)) throw new WorkspaceServerError("workspace_share_delegation_mismatch", 403);
    const expires = Date.parse(payload.expires_at);
    const issued = Date.parse(payload.issued_at);
    if (!Number.isFinite(expires) || !Number.isFinite(issued) || expires <= issued || expires - issued > 5 * 60_000 || expires < this.now().getTime()) throw new WorkspaceServerError("workspace_share_delegation_expired", 403);
  }

  private importRequestHash(context: WorkspaceShareContext, input: WorkspaceShareImportInput, kind: WorkspaceShareKind): string {
    return createHash("sha256").update(canonicalJson({ source_origin: input.source_origin, locator: input.locator, claim_id: input.claim_id, content_hash: input.content_hash, target_workspace_id: context.workspaceId, target_room_id: input.target_room_id ?? null, recipient_account_id: context.accountId, operation_id: context.operationId, kind })).digest("hex");
  }

  private async readImportStatus(context: WorkspaceShareContext, operationId: string): Promise<WorkspaceShareImportResult> {
    return this.options.database.withContext(context, async (sql) => {
      const rows = await sql.query<ImportRow>(`SELECT * FROM workspace_share_imports WHERE workspace_id = $1 AND operation_id = $2`, [context.workspaceId, operationId]);
      const row = rows.rows[0];
      if (!row || row.recipient_account_id !== context.accountId) throw new WorkspaceServerError("workspace_share_import_not_found", 404);
      await this.authorize(context, "import_target", row.kind, undefined, row.target_room_id ?? undefined);
      return importResult(row);
    });
  }

  private async markImportFailed(context: WorkspaceShareContext, failureCode: string): Promise<WorkspaceShareImportResult> {
    return this.options.database.withContext(context, async (sql) => {
      const now = this.now();
      await sql.query(`UPDATE workspace_share_imports SET status = 'failed', phase = 'cleanup', retryable = FALSE, failure_code = $3, updated_at = $4 WHERE workspace_id = $1 AND operation_id = $2 AND status = 'staging'`, [context.workspaceId, context.operationId, failureCode, now]);
      const rows = await sql.query<ImportRow>(`SELECT * FROM workspace_share_imports WHERE workspace_id = $1 AND operation_id = $2`, [context.workspaceId, context.operationId]);
      const row = rows.rows[0];
      if (!row || row.recipient_account_id !== context.accountId) throw new WorkspaceServerError("workspace_share_import_not_found", 404);
      await this.authorize(context, "import_target", row.kind, undefined, row.target_room_id ?? undefined);
      return importResult(row);
    });
  }
}

function sourceVersions(value: unknown): WorkspaceShareResourceRef[] {
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return []; }
  }
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is WorkspaceShareResourceRef => Boolean(item) && typeof item === "object" && typeof (item as { id?: unknown }).id === "string" && Number.isSafeInteger((item as { version?: unknown }).version) && Number((item as { version: unknown }).version) > 0).map((item) => ({ id: item.id, version: Number(item.version) }));
}

function snapshotRemoved(draft: { removedReferences?: readonly { entry_id: string; location: string; reason: string }[] }): { entry_id: string; location: string; reason: string }[] {
  return draft.removedReferences ? [...draft.removedReferences] : [];
}

function emptyDraftRow(context: WorkspaceShareContext, id: string, snapshot: WorkspaceShareSourceSnapshot, manifest: WorkspaceShareManifest, createdAt: Date): ShareRow {
  return {
    workspace_id: context.workspaceId, id, source_kind: snapshot.kind, source_room_id: snapshot.kind === "room_knowledge" ? snapshot.sourceId : null, source_agent_id: snapshot.kind === "agent" ? snapshot.sourceId : null,
    created_by: context.accountId, title: manifest.title, status: "draft", visibility: "restricted", revision: 1, source_versions: snapshot.sourceVersions,
    manifest_path: null, content_hash: null, byte_size: null, public_locator: null, created_at: createdAt, updated_at: createdAt, published_at: null, revoked_at: null
  };
}

function claimResult(row: ClaimRow): WorkspaceShareClaimResult {
  return { claim_id: row.id, share_id: row.share_id, recipient_account_id: row.recipient_account_id, target_origin: row.target_origin, target_workspace_id: row.target_workspace_id, operation_id: row.operation_id, content_hash: row.content_hash, created_at: iso(row.created_at) };
}
