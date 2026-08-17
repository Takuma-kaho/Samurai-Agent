import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertOpaqueId, assertSafeRelativePath } from "./config";
import { WorkspaceServerError } from "./errors";
import type { WorkspaceCompletionFileEntry, WorkspaceCompletionResourceKind, WorkspaceCompletionScope } from "./workspace-completion-types";

const frontmatterBoundary = "---";
const resourceIdPattern = /^[a-z][a-z0-9_:-]{0,127}$/;

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
    if (!content || hashBytes(content) !== expectedHash) return false;
    await rm(target, { force: false });
    return true;
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

export function completionResourcePath(input: { id: string; kind: WorkspaceCompletionResourceKind; scope: WorkspaceCompletionScope; version?: number; candidate?: boolean }): string {
  if (!resourceIdPattern.test(input.id)) throw new WorkspaceServerError("workspace_completion_resource_id_invalid", 400);
  const versionSuffix = input.version === undefined ? "" : `/${input.version}${input.kind === "skill" ? "/SKILL.md" : ".md"}`;
  if (input.version !== undefined) return assertSafeRelativePath(`.versions/${input.id}${input.candidate ? "/candidate" : ""}${versionSuffix}`);
  if (input.kind === "knowledge") return `knowledge/${input.id}.md`;
  if (input.kind === "skill") return `skills/${input.id}/SKILL.md`;
  if (input.scope.kind === "workspace") return `policies/workspace/${input.id}.md`;
  if (!input.scope.roomId || !resourceIdPattern.test(input.scope.roomId)) throw new WorkspaceServerError("workspace_completion_policy_room_invalid", 400);
  return `policies/rooms/${input.scope.roomId}/${input.id}.md`;
}

export function completionProfilePath(kind: "profile" | "soul"): string {
  return kind === "profile" ? "profile/PROFILE.md" : "profile/SOUL.md";
}

/** A Skill package may contain any safe auxiliary file, not only the common
 * references/scripts/templates/examples directories.  `SKILL.md` remains the
 * one canonical package entrypoint, while assertSafeRelativePath prevents a
 * caller from escaping the package with an absolute or traversal path. */
export function completionSkillSupportPath(input: { id: string; relativePath: string; version?: number; candidate?: boolean }): string {
  if (!resourceIdPattern.test(input.id)) throw new WorkspaceServerError("workspace_completion_resource_id_invalid", 400);
  const relative = assertSkillSupportRelativePath(input.relativePath);
  if (input.version !== undefined) {
    if (!Number.isSafeInteger(input.version) || input.version < 1) throw new WorkspaceServerError("workspace_completion_resource_version_invalid", 400);
    return assertSafeRelativePath(`.versions/${input.id}${input.candidate ? "/candidate" : ""}/${input.version}/${relative}`);
  }
  return assertSafeRelativePath(`skills/${input.id}/${relative}`);
}

export function assertSkillSupportRelativePath(value: string): string {
  const relative = assertSafeRelativePath(value);
  if (relative === "SKILL.md") {
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
  if (!scope || (scope.kind !== "workspace" && scope.kind !== "room")) {
    throw new WorkspaceServerError("workspace_completion_file_batch_scope_invalid", 422);
  }
  if (scope.kind === "workspace") {
    if (scope.roomId !== undefined) throw new WorkspaceServerError("workspace_completion_file_batch_scope_invalid", 422);
    return;
  }
  if (!scope.roomId) throw new WorkspaceServerError("workspace_completion_file_batch_scope_invalid", 422);
  assertOpaqueId(scope.roomId, "room_id_invalid");
}
