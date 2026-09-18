import { createHash, randomUUID } from "node:crypto";
import { lstat, link, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertOpaqueId, assertSafeRelativePath } from "./config";
import { WorkspaceServerError } from "./errors";
import type { WorkspaceDatabaseContext, WorkspaceSql } from "./postgres";
import type { WorkspaceCompletionFileEntry, WorkspaceCompletionResourceKind, WorkspaceCompletionScope } from "./workspace-completion-types";
import type { WorkspaceRequestContext } from "./types";

const frontmatterBoundary = "---";
const resourceIdPattern = /^[a-z][a-z0-9_:-]{0,127}$/;
const skillSupportRelativePathPattern = /^(?:references|scripts|templates|examples)\/.+/;
const completionOwnedRoots = new Set([".completion-staging", ".versions", "agents", "knowledge", "policies", "profile", "skills"]);

export interface WorkspaceCompletionDocument {
  id: string;
  title: string;
  resourceKind: WorkspaceCompletionResourceKind;
  metadata: Record<string, unknown>;
  body: string;
}

export interface StagedWorkspaceCompletionFileBatch {
  workspaceId: string;
  id: string;
  scope: WorkspaceCompletionScope;
  entries: readonly WorkspaceCompletionFileEntry[];
}

/** Result of the hash-guarded physical cleanup operation.  Missing files are
 * safe to converge as cleaned, while an existing body with a different hash
 * is preserved for human inspection. */
export type WorkspaceCompletionFileRemovalOutcome = "removed" | "missing" | "preserved";

export interface WorkspaceCompletionFileCleanupCandidate {
  id: string;
  path: string;
  sha256: string;
  byteSize: number;
  reason: string;
  attemptCount: number;
}

export interface WorkspaceCompletionFileCleanupTickResult {
  claimed: number;
  cleaned: number;
  preserved: number;
  retried: number;
  failed: readonly { id: string; errorCode: string }[];
}

/** The queue is deliberately reachable only through this narrow maintenance
 * port.  No request handler should expose claim/complete/release as a generic
 * operation. */
export interface WorkspaceCompletionFileCleanupDatabase {
  withContext<T>(context: WorkspaceDatabaseContext, action: (sql: WorkspaceSql) => Promise<T>): Promise<T>;
}

export interface WorkspaceCompletionFileCleanupFiles {
  removeIfUnchangedOutcome(workspaceId: string, relativePath: string, expectedHash: string): Promise<WorkspaceCompletionFileRemovalOutcome>;
}

/** File-only half of the Completion batch transaction. The caller persists
 * the returned batch ledger in PostgreSQL before `finalize`; it can then be
 * recovered after a restart without guessing whether DB or file is correct. */
export class WorkspaceCompletionFileService {
  constructor(private readonly storageRoot: string) {}

  async stage(workspaceId: string, scope: WorkspaceCompletionScope, entries: readonly { path: string; content: Uint8Array }[]): Promise<StagedWorkspaceCompletionFileBatch> {
    return this.stageWithId(workspaceId, scope, `completion_file_batch_${randomUUID()}`, entries);
  }

  /** Used only by a verified Bundle restore to preserve the durable batch ID
   * referenced by imported version metadata. */
  async stageImported(workspaceId: string, scope: WorkspaceCompletionScope, id: string, entries: readonly { path: string; content: Uint8Array }[]): Promise<StagedWorkspaceCompletionFileBatch> {
    assertOpaqueId(id, "workspace_completion_file_batch_id_invalid");
    return this.stageWithId(workspaceId, scope, id, entries);
  }

  private async stageWithId(workspaceId: string, scope: WorkspaceCompletionScope, id: string, entries: readonly { path: string; content: Uint8Array }[]): Promise<StagedWorkspaceCompletionFileBatch> {
    assertOpaqueId(workspaceId, "workspace_id_invalid");
    assertBatchScope(scope);
    // A privacy redaction may need to replace a long version history in one
    // recoverable transaction. Keep the cap finite for memory safety, but do
    // not split one Resource into independently visible batches.
    if (entries.length === 0 || entries.length > 1_000) throw new WorkspaceServerError("workspace_completion_file_batch_size_invalid", 422);
    const normalized = entries.map((entry) => ({ path: assertSafeRelativePath(entry.path), content: entry.content }));
    if (new Set(normalized.map((entry) => entry.path)).size !== normalized.length) throw new WorkspaceServerError("workspace_completion_file_batch_duplicate_path", 422);
    const root = this.workspaceRoot(workspaceId);
    await ensureNoSymlink(root, ".completion-staging");
    for (const entry of normalized) await ensureNoSymlink(root, `files/${entry.path}`);
    const stagedEntries: WorkspaceCompletionFileEntry[] = [];
    try {
      for (const entry of normalized) {
        const staged = this.resolveWithinWorkspace(root, `.completion-staging/${id}/${entry.path}`);
        await mkdir(path.dirname(staged), { recursive: true, mode: 0o700 });
        await writeFile(staged, entry.content, { flag: "wx", mode: 0o600 });
        stagedEntries.push({ path: entry.path, content: entry.content, sha256: hashBytes(entry.content) });
      }
      return { workspaceId, scope: { ...scope }, id, entries: stagedEntries };
    } catch (error) {
      await this.rollback({ workspaceId, id }).catch(() => undefined);
      throw error;
    }
  }

  async finalize(batch: StagedWorkspaceCompletionFileBatch): Promise<void> {
    const root = this.workspaceRoot(batch.workspaceId);
    for (const entry of batch.entries) {
      const source = this.resolveWithinWorkspace(root, `.completion-staging/${batch.id}/${entry.path}`);
      const destination = this.resolveWithinWorkspace(root, `files/${entry.path}`);
      await ensureNoSymlink(root, `files/${entry.path}`);
      try {
        await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
        await rename(source, destination);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const current = await readFile(destination).catch(() => undefined);
        if (!current || hashBytes(current) !== entry.sha256) {
          throw new WorkspaceServerError("workspace_completion_file_recovery_required", 503, { path: entry.path });
        }
      }
    }
    await rm(this.resolveWithinWorkspace(root, `.completion-staging/${batch.id}`), { recursive: true, force: true });
  }

  /** Finalizes a new import without replacing a file that belongs to another
   * batch.  `rename` is intentionally retained for the normal update path,
   * where the DB resource lock already establishes replacement ownership. A
   * Share import has reserved resource IDs but may still encounter an orphaned
   * destination on disk, so it uses an exclusive hard-link publish instead. */
  async finalizeExclusive(batch: StagedWorkspaceCompletionFileBatch): Promise<readonly string[]> {
    const root = this.workspaceRoot(batch.workspaceId);
    const created: string[] = [];
    try {
      for (const entry of batch.entries) {
        const source = this.resolveWithinWorkspace(root, `.completion-staging/${batch.id}/${entry.path}`);
        const destination = this.resolveWithinWorkspace(root, `files/${entry.path}`);
        await ensureNoSymlink(root, `files/${entry.path}`);
        await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
        const current = await readFile(destination).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        });
        if (current) {
          if (hashBytes(current) !== entry.sha256) {
            throw new WorkspaceServerError("workspace_completion_file_path_conflict", 409, { path: entry.path });
          }
          await rm(source, { force: true });
          continue;
        }
        try {
          // link(2) fails atomically when another writer wins the path. It
          // does not have rename's silent destination replacement behavior.
          await link(source, destination);
          created.push(entry.path);
          await rm(source, { force: true });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          const raced = await readFile(destination).catch(() => undefined);
          if (!raced || hashBytes(raced) !== entry.sha256) {
            throw new WorkspaceServerError("workspace_completion_file_path_conflict", 409, { path: entry.path });
          }
          await rm(source, { force: true });
        }
      }
      await rm(this.resolveWithinWorkspace(root, `.completion-staging/${batch.id}`), { recursive: true, force: true });
      return created;
    } catch (error) {
      await this.removeFinalized(batch, created).catch(() => undefined);
      await this.rollback(batch).catch(() => undefined);
      throw error;
    }
  }

  /** Removes only paths that this exclusive publish created and that still
   * have the recorded hash. A later human edit is never deleted by rollback. */
  async removeFinalized(batch: StagedWorkspaceCompletionFileBatch, paths: readonly string[]): Promise<void> {
    const expected = new Map(batch.entries.map((entry) => [entry.path, entry.sha256]));
    for (const relativePath of paths) {
      const sha256 = expected.get(relativePath);
      if (sha256) await this.removeIfUnchanged(batch.workspaceId, relativePath, sha256);
    }
  }

  async recover(batch: StagedWorkspaceCompletionFileBatch): Promise<void> {
    await this.finalize(batch);
  }

  async rollback(batch: Pick<StagedWorkspaceCompletionFileBatch, "workspaceId" | "id">): Promise<void> {
    const root = this.workspaceRoot(batch.workspaceId);
    await rm(this.resolveWithinWorkspace(root, `.completion-staging/${batch.id}`), { recursive: true, force: true });
  }

  async read(workspaceId: string, relativePath: string, expectedHash: string): Promise<Buffer> {
    assertOpaqueId(workspaceId, "workspace_id_invalid");
    const safePath = assertSafeRelativePath(relativePath);
    const root = this.workspaceRoot(workspaceId);
    await ensureNoSymlink(root, `files/${safePath}`);
    const content = await readFile(this.resolveWithinWorkspace(root, `files/${safePath}`));
    if (hashBytes(content) !== expectedHash) throw new WorkspaceServerError("workspace_completion_file_hash_mismatch", 503, { path: safePath });
    return content;
  }

  async inspectPhysicalFile(workspaceId: string, relativePath: string): Promise<{ content: Buffer; sha256: string }> {
    assertOpaqueId(workspaceId, "workspace_id_invalid");
    const safePath = assertSafeRelativePath(relativePath);
    const root = this.workspaceRoot(workspaceId);
    await ensureNoSymlink(root, `files/${safePath}`);
    const content = await readFile(this.resolveWithinWorkspace(root, `files/${safePath}`));
    return { content, sha256: hashBytes(content) };
  }

  /** Removes an orphaned migration file only when it still exactly matches
   * the recorded hash. A later human edit is never removed by recovery. */
  async removeIfUnchanged(workspaceId: string, relativePath: string, expectedHash: string): Promise<boolean> {
    return (await this.removeIfUnchangedOutcome(workspaceId, relativePath, expectedHash)) === "removed";
  }

  /** Same guard as `removeIfUnchanged`, but keeps the distinction needed by
   * the cleanup ledger: ENOENT is a successful convergence, whereas a body
   * changed by a human is preserved.  A race where another process removes the
   * path after the hash read is also treated as successful convergence. */
  async removeIfUnchangedOutcome(workspaceId: string, relativePath: string, expectedHash: string): Promise<WorkspaceCompletionFileRemovalOutcome> {
    assertOpaqueId(workspaceId, "workspace_id_invalid");
    const safePath = assertSafeRelativePath(relativePath);
    if (!/^[a-f0-9]{64}$/.test(expectedHash)) throw new WorkspaceServerError("workspace_completion_file_hash_invalid", 400);
    const root = this.workspaceRoot(workspaceId);
    await ensureNoSymlink(root, `files/${safePath}`);
    const target = this.resolveWithinWorkspace(root, `files/${safePath}`);
    const content = await readFile(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!content) return "missing";
    if (hashBytes(content) !== expectedHash) return "preserved";
    try {
      await rm(target, { force: false });
      return "removed";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
      throw error;
    }
  }

  private workspaceRoot(workspaceId: string): string {
    return path.join(this.storageRoot, "workspaces", workspaceId);
  }

  private resolveWithinWorkspace(root: string, relative: string): string {
    const resolved = path.resolve(root, ...relative.split("/"));
    const relativeToRoot = path.relative(root, resolved);
    if (relativeToRoot === ".." || relativeToRoot.startsWith(`..${path.sep}`) || path.isAbsolute(relativeToRoot)) {
      throw new WorkspaceServerError("workspace_completion_file_path_invalid", 400);
    }
    return resolved;
  }
}

const defaultCleanupLimit = 100;
const maxCleanupLimit = 1_000;
const cleanupPermanentErrorCodes = new Set([
  "EACCES", "EPERM", "ELOOP", "ENOTDIR", "EISDIR", "EINVAL", "ENAMETOOLONG"
]);

/**
 * Internal maintenance worker for `workspace_completion_file_cleanup_queue`.
 *
 * Claiming is performed by the database function (`FOR UPDATE SKIP LOCKED`),
 * and each candidate is completed in a fresh tenant transaction that contains
 * both the hash-guarded filesystem operation and the queue state update.  A
 * process crash after the filesystem operation but before COMMIT is safe: a
 * retry observes either the unchanged body or ENOENT and converges.  The
 * worker never touches a resource body that still has a Completion reference;
 * the migration queue is the only source of paths it receives.
 */
export class WorkspaceCompletionFileCleanupService {
  constructor(
    private readonly database: WorkspaceCompletionFileCleanupDatabase,
    private readonly files: WorkspaceCompletionFileCleanupFiles
  ) {}

  async runTick(
    context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">,
    input: { workerId: string; limit?: number }
  ): Promise<WorkspaceCompletionFileCleanupTickResult> {
    assertOpaqueId(context.workspaceId, "workspace_id_invalid");
    assertOpaqueId(context.accountId, "account_id_invalid");
    assertOpaqueId(input.workerId, "workspace_completion_cleanup_worker_id_invalid");
    const limit = input.limit ?? defaultCleanupLimit;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > maxCleanupLimit) {
      throw new WorkspaceServerError("workspace_completion_file_cleanup_limit_invalid", 400);
    }

    const claimToken = `completion_cleanup_${input.workerId}_${randomUUID()}`;
    const candidates = await this.database.withContext(this.workerContext(context), async (sql) => {
      const result = await sql.query<CleanupQueueRow>(
        `SELECT id, path, sha256, byte_size, reason, attempt_count
         FROM samurai_claim_workspace_completion_file_cleanup($1, $2, $3)`,
        [context.workspaceId, claimToken, limit]
      );
      return result.rows.map(cleanupCandidateFromRow);
    });

    let cleaned = 0;
    let preserved = 0;
    let retried = 0;
    const failed: Array<{ id: string; errorCode: string }> = [];
    for (const candidate of candidates) {
      try {
        const result = await this.processCandidate(this.workerContext(context), candidate, claimToken);
        if (result === "cleaned") cleaned += 1;
        else if (result === "preserved") preserved += 1;
        else retried += 1;
      } catch (error) {
        failed.push({ id: candidate.id, errorCode: cleanupErrorCode(error) });
      }
    }
    return { claimed: candidates.length, cleaned, preserved, retried, failed };
  }

  private async processCandidate(
    context: WorkspaceDatabaseContext,
    candidate: WorkspaceCompletionFileCleanupCandidate,
    claimToken: string
  ): Promise<"cleaned" | "preserved" | "retried"> {
    return this.database.withContext(context, async (sql) => {
      let outcome: WorkspaceCompletionFileRemovalOutcome;
      try {
        outcome = await this.files.removeIfUnchangedOutcome(context.workspaceId!, candidate.path, candidate.sha256);
      } catch (error) {
        if (isPermanentCleanupError(error)) {
          await completeCleanup(sql, context.workspaceId!, candidate.id, claimToken, "preserved", cleanupErrorCode(error));
          return "preserved";
        }
        await releaseCleanup(sql, context.workspaceId!, candidate.id, claimToken, cleanupErrorCode(error));
        return "retried";
      }
      if (outcome === "preserved") {
        await completeCleanup(sql, context.workspaceId!, candidate.id, claimToken, "preserved", "workspace_completion_file_content_changed");
        return "preserved";
      }
      await completeCleanup(sql, context.workspaceId!, candidate.id, claimToken, "cleaned", null);
      return "cleaned";
    });
  }

  private workerContext(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">): WorkspaceDatabaseContext {
    return { workspaceId: context.workspaceId, accountId: context.accountId, worker: true };
  }
}

interface CleanupQueueRow {
  id: string;
  path: string;
  sha256: string;
  byte_size: number | string;
  reason: string;
  attempt_count: number | string;
}

function cleanupCandidateFromRow(row: CleanupQueueRow): WorkspaceCompletionFileCleanupCandidate {
  const byteSize = Number(row.byte_size);
  const attemptCount = Number(row.attempt_count);
  if (!row || typeof row.id !== "string" || typeof row.path !== "string" || typeof row.sha256 !== "string"
    || !Number.isSafeInteger(byteSize) || byteSize < 0 || !Number.isSafeInteger(attemptCount) || attemptCount < 1) {
    throw new WorkspaceServerError("workspace_completion_file_cleanup_row_invalid", 503);
  }
  return { id: row.id, path: row.path, sha256: row.sha256, byteSize, reason: row.reason, attemptCount };
}

async function completeCleanup(
  sql: WorkspaceSql,
  workspaceId: string,
  id: string,
  claimToken: string,
  status: "cleaned" | "preserved",
  errorCode: string | null
): Promise<void> {
  await sql.query(
    "SELECT samurai_complete_workspace_completion_file_cleanup($1, $2, $3, $4, $5)",
    [workspaceId, id, claimToken, status, errorCode]
  );
}

async function releaseCleanup(sql: WorkspaceSql, workspaceId: string, id: string, claimToken: string, errorCode: string): Promise<void> {
  await sql.query(
    "SELECT samurai_release_workspace_completion_file_cleanup($1, $2, $3, $4)",
    [workspaceId, id, claimToken, errorCode]
  );
}

function isPermanentCleanupError(error: unknown): boolean {
  if (error instanceof WorkspaceServerError) return true;
  const code = cleanupNodeErrorCode(error);
  return code !== undefined && cleanupPermanentErrorCodes.has(code);
}

function cleanupErrorCode(error: unknown): string {
  if (error instanceof WorkspaceServerError) return error.code;
  const code = cleanupNodeErrorCode(error);
  return code && /^[A-Z][A-Z0-9_]{0,63}$/.test(code)
    ? `workspace_completion_file_cleanup_${code.toLowerCase()}`
    : "workspace_completion_file_cleanup_io_failed";
}

function cleanupNodeErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/** Paths under these roots are owned by Completion's file transaction. The
 * generic Workspace file command must not create a second ledger for them. */
export function isWorkspaceCompletionOwnedPath(value: string): boolean {
  const relative = assertSafeRelativePath(value);
  const first = relative.split("/", 1)[0];
  return completionOwnedRoots.has(first ?? "");
}

export function completionResourcePath(input: { id: string; kind: WorkspaceCompletionResourceKind; scope: WorkspaceCompletionScope; version?: number; candidate?: boolean }): string {
  if (!resourceIdPattern.test(input.id)) throw new WorkspaceServerError("workspace_completion_resource_id_invalid", 400);
  if (input.scope.kind === "agent") {
    if (!input.scope.agentId || !resourceIdPattern.test(input.scope.agentId) || input.scope.roomId !== undefined) {
      throw new WorkspaceServerError("workspace_completion_agent_id_invalid", 422);
    }
    if (input.kind !== "knowledge" && input.kind !== "skill") {
      throw new WorkspaceServerError("workspace_completion_agent_resource_kind_invalid", 422);
    }
  }
  if (input.scope.kind === "workspace" && input.kind === "knowledge") {
    throw new WorkspaceServerError("workspace_memory_removed", 409);
  }
  const versionSuffix = input.version === undefined ? "" : `/${input.version}${input.kind === "skill" ? "/SKILL.md" : ".md"}`;
  if (input.version !== undefined) return assertSafeRelativePath(`.versions/${input.id}${input.candidate ? "/candidate" : ""}${versionSuffix}`);
  if (input.scope.kind === "agent") {
    if (input.kind === "knowledge") return assertSafeRelativePath(`agents/${input.scope.agentId}/knowledge/${input.id}.md`);
    if (input.kind === "skill") return assertSafeRelativePath(`agents/${input.scope.agentId}/skills/${input.id}/SKILL.md`);
    throw new WorkspaceServerError("workspace_completion_agent_resource_kind_invalid", 422);
  }
  if (input.kind === "knowledge") return `knowledge/${input.id}.md`;
  if (input.kind === "skill") return `skills/${input.id}/SKILL.md`;
  if (input.scope.kind === "workspace") return `policies/workspace/${input.id}.md`;
  if (!input.scope.roomId || !resourceIdPattern.test(input.scope.roomId)) throw new WorkspaceServerError("workspace_completion_policy_room_invalid", 400);
  return `policies/rooms/${input.scope.roomId}/${input.id}.md`;
}

export function completionProfilePath(kind: "profile" | "soul"): string {
  return kind === "profile" ? "profile/PROFILE.md" : "profile/SOUL.md";
}

/** A Skill package's auxiliary files are kept under the same four roots as the
 * PostgreSQL relative_path constraint. `SKILL.md` remains the one canonical
 * package entrypoint, while assertSafeRelativePath prevents a caller from
 * escaping the package with an absolute or traversal path. */
export function completionSkillSupportPath(input: { id: string; relativePath: string; scope?: WorkspaceCompletionScope; version?: number; candidate?: boolean }): string {
  if (!resourceIdPattern.test(input.id)) throw new WorkspaceServerError("workspace_completion_resource_id_invalid", 400);
  const relative = assertSkillSupportRelativePath(input.relativePath);
  if (input.scope?.kind === "agent" && (!input.scope.agentId || !resourceIdPattern.test(input.scope.agentId) || input.scope.roomId !== undefined)) {
    throw new WorkspaceServerError("workspace_completion_agent_id_invalid", 422);
  }
  if (input.version !== undefined) {
    if (!Number.isSafeInteger(input.version) || input.version < 1) throw new WorkspaceServerError("workspace_completion_resource_version_invalid", 400);
    return assertSafeRelativePath(`.versions/${input.id}${input.candidate ? "/candidate" : ""}/${input.version}/${relative}`);
  }
  if (input.scope?.kind === "agent") {
    return assertSafeRelativePath(`agents/${input.scope.agentId}/skills/${input.id}/${relative}`);
  }
  return assertSafeRelativePath(`skills/${input.id}/${relative}`);
}

export function assertSkillSupportRelativePath(value: string): string {
  let relative: string;
  try {
    relative = assertSafeRelativePath(value);
  } catch {
    throw new WorkspaceServerError("workspace_completion_skill_support_path_invalid", 422);
  }
  if (relative === "SKILL.md" || !skillSupportRelativePathPattern.test(relative)) {
    throw new WorkspaceServerError("workspace_completion_skill_support_path_invalid", 422);
  }
  return relative;
}

/** Markdown body stays human-readable. The small YAML-compatible frontmatter
 * uses JSON-quoted scalars so parser and writer do not need a permissive YAML
 * interpreter. */
export function renderWorkspaceCompletionDocument(document: WorkspaceCompletionDocument): Buffer {
  if (!resourceIdPattern.test(document.id) || !document.title.trim() || !document.body.trim()) {
    throw new WorkspaceServerError("workspace_completion_document_invalid", 422);
  }
  const fields: Record<string, unknown> = {
    id: document.id,
    title: document.title.trim(),
    resource_kind: document.resourceKind,
    metadata: document.metadata
  };
  const lines = Object.entries(fields).map(([key, value]) => `${key}: ${JSON.stringify(value)}`);
  return Buffer.from(`${frontmatterBoundary}\n${lines.join("\n")}\n${frontmatterBoundary}\n\n${document.body.trim()}\n`, "utf8");
}

export function parseWorkspaceCompletionDocument(content: Uint8Array): WorkspaceCompletionDocument {
  const text = Buffer.from(content).toString("utf8");
  if (!text.startsWith(`${frontmatterBoundary}\n`)) throw new WorkspaceServerError("workspace_completion_document_frontmatter_required", 422);
  const close = text.indexOf(`\n${frontmatterBoundary}\n`, frontmatterBoundary.length + 1);
  if (close < 0) throw new WorkspaceServerError("workspace_completion_document_frontmatter_invalid", 422);
  const frontmatter = text.slice(frontmatterBoundary.length + 1, close);
  const body = text.slice(close + frontmatterBoundary.length + 2).trim();
  const values: Record<string, unknown> = {};
  for (const line of frontmatter.split("\n")) {
    const separator = line.indexOf(": ");
    if (separator <= 0) throw new WorkspaceServerError("workspace_completion_document_frontmatter_invalid", 422);
    const key = line.slice(0, separator);
    if (!/^[a-z_]{1,64}$/.test(key) || Object.hasOwn(values, key)) throw new WorkspaceServerError("workspace_completion_document_frontmatter_invalid", 422);
    try {
      values[key] = JSON.parse(line.slice(separator + 2));
    } catch {
      throw new WorkspaceServerError("workspace_completion_document_frontmatter_invalid", 422);
    }
  }
  const id = typeof values.id === "string" ? values.id : "";
  const title = typeof values.title === "string" ? values.title : "";
  const resourceKind = values.resource_kind;
  const metadata = values.metadata;
  if (!resourceIdPattern.test(id) || !title.trim() || !["knowledge", "skill", "policy"].includes(String(resourceKind)) || !metadata || typeof metadata !== "object" || Array.isArray(metadata) || !body) {
    throw new WorkspaceServerError("workspace_completion_document_invalid", 422);
  }
  return { id, title, resourceKind: resourceKind as WorkspaceCompletionResourceKind, metadata: metadata as Record<string, unknown>, body };
}

async function ensureNoSymlink(root: string, relative: string): Promise<void> {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, ...relative.split("/"));
  const relativeTarget = path.relative(resolvedRoot, target);
  if (relativeTarget === ".." || relativeTarget.startsWith(`..${path.sep}`) || path.isAbsolute(relativeTarget)) {
    throw new WorkspaceServerError("workspace_completion_file_path_invalid", 400);
  }
  for (const candidate of [resolvedRoot, ...relativeTarget.split(path.sep).filter(Boolean).map((_, index, all) => path.join(resolvedRoot, ...all.slice(0, index + 1)))]) {
    const stats = await lstat(candidate).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
    if (!stats) break;
    if (stats.isSymbolicLink()) throw new WorkspaceServerError("workspace_completion_file_symlink_forbidden", 400);
  }
}

function hashBytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertBatchScope(scope: WorkspaceCompletionScope): void {
  if (!scope || (scope.kind !== "workspace" && scope.kind !== "room" && scope.kind !== "agent")) {
    throw new WorkspaceServerError("workspace_completion_file_batch_scope_invalid", 422);
  }
  if (scope.kind === "workspace") {
    if (scope.roomId !== undefined || scope.agentId !== undefined) throw new WorkspaceServerError("workspace_completion_file_batch_scope_invalid", 422);
    return;
  }
  if (scope.kind === "room") {
    if (!scope.roomId || scope.agentId !== undefined) throw new WorkspaceServerError("workspace_completion_file_batch_scope_invalid", 422);
    assertOpaqueId(scope.roomId, "room_id_invalid");
    return;
  }
  if (!scope.agentId || scope.roomId !== undefined) throw new WorkspaceServerError("workspace_completion_file_batch_scope_invalid", 422);
  assertOpaqueId(scope.agentId, "workspace_agent_id_invalid");
}
