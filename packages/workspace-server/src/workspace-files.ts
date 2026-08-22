import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertOpaqueId, assertSafeRelativePath } from "./config";
import { canonicalJson } from "./auth";
import { WorkspaceServerError } from "./errors";
import { isWorkspaceCompletionOwnedPath } from "./workspace-completion-files";
import type { WorkspaceSql } from "./postgres";
import type { WorkspaceEvent, WorkspaceFile, WorkspaceRequestContext } from "./types";
import { WorkspaceServerStore } from "./workspace-server-store";

export interface WriteWorkspaceFileInput {
  roomId: string;
  path: string;
  content: Uint8Array;
  expectedVersion: number;
}

export interface WriteWorkspaceFileResult {
  file: WorkspaceFile;
  event: WorkspaceEvent;
  transactionId: string;
  /** True only when the durable operation result is returned to a retry. */
  replayed: boolean;
}

export interface RemoveWorkspaceFileInput {
  roomId: string;
  path: string;
  expectedVersion: number;
}

export interface RemoveWorkspaceFileResult {
  event: WorkspaceEvent;
  transactionId: string;
  replayed: boolean;
}

/**
 * Keeps Knowledge and other Workspace bodies as normal files. The database
 * records their version and hash, while a small durable transaction ledger
 * makes an interrupted rename recoverable after restart.
 */
export class WorkspaceFileStore {
  constructor(private readonly workspaceStore: WorkspaceServerStore) {}

  async write(context: WorkspaceRequestContext, input: WriteWorkspaceFileInput): Promise<WriteWorkspaceFileResult> {
    assertOpaqueId(input.roomId, "room_id_invalid");
    const relativePath = assertSafeRelativePath(input.path);
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) {
      throw new WorkspaceServerError("workspace_file_expected_version_invalid", 400);
    }
    // Do this before creating a staging file. The database remains the final
    // authority inside the write transaction, but a rejected caller must not
    // be able to consume shared disk through abandoned staging content.
    await this.workspaceStore.assertRoomWritable(context, input.roomId);
    if (isWorkspaceCompletionOwnedPath(relativePath)) {
      throw new WorkspaceServerError("workspace_file_path_owned_by_completion", 409, { path: relativePath });
    }
    const transactionId = `file_tx_${randomUUID()}`;
    const stagedPath = `.staging/${transactionId}`;
    const root = this.workspaceRoot(context.workspaceId);
    const stagedAbsolutePath = this.resolveWithinWorkspace(root, stagedPath);
    await mkdir(path.dirname(stagedAbsolutePath), { recursive: true, mode: 0o700 });
    let databaseCommitted = false;
    try {
      await writeFile(stagedAbsolutePath, input.content, { flag: "wx", mode: 0o600 });
      const sha256 = hashBytes(input.content);
      const result = await this.workspaceStore.runIdempotentResult(context, {
        action: "workspace.file.write",
        input: { roomId: input.roomId, path: relativePath, expectedVersion: input.expectedVersion, sha256 }
      }, async (sql) => {
        await assertWorkspaceWritable(sql, context.workspaceId);
        await sql.query("SELECT pg_advisory_xact_lock(hashtext($1))", [fileLockKey(context.workspaceId, relativePath)]);
        const previous = await sql.query<FileRow>(
          `SELECT workspace_id, room_id, path, version, sha256, size, created_at, updated_at
           FROM workspace_files WHERE workspace_id = $1 AND path = $2`,
          [context.workspaceId, relativePath]
        );
        const previousFile = previous.rows[0] ? fileFromRow(previous.rows[0]) : undefined;
        if ((previousFile?.version ?? 0) !== input.expectedVersion) {
          throw new WorkspaceServerError("workspace_file_version_conflict", 409, {
            latest_version: previousFile?.version ?? null
          });
        }
        if (previousFile && previousFile.roomId !== input.roomId) {
          throw new WorkspaceServerError("workspace_file_room_change_forbidden", 409);
        }
        const saved = await sql.query<FileRow>(
          `INSERT INTO workspace_files(workspace_id, room_id, path, version, sha256, size, created_by, updated_by)
           VALUES ($1, $2, $3, 1, $4, $5, $6, $6)
           ON CONFLICT (workspace_id, path) DO UPDATE SET
           version = workspace_files.version + 1,
             sha256 = EXCLUDED.sha256,
             size = EXCLUDED.size,
             updated_by = EXCLUDED.updated_by,
             updated_at = NOW()
           WHERE workspace_files.version = $7
           RETURNING workspace_id, room_id, path, version, sha256, size, created_at, updated_at`,
          [context.workspaceId, input.roomId, relativePath, sha256, input.content.byteLength, context.accountId, input.expectedVersion]
        );
        const row = saved.rows[0];
        if (!row) throw new WorkspaceServerError("workspace_file_version_conflict", 409);
        const file = fileFromRow(row);
        await sql.query(
          `INSERT INTO workspace_file_transactions(workspace_id, id, room_id, target_path, staged_path, previous_file, next_file, status)
           VALUES ($1, $2, $3, $4, $5, $6::JSONB, $7::JSONB, 'db_committed')`,
          [context.workspaceId, transactionId, input.roomId, relativePath, stagedPath, previousFile ? canonicalJson(fileToJson(previousFile)) : null, canonicalJson(fileToJson(file))]
        );
        const event = await insertFileEvent(sql, context, input.roomId, relativePath, file.version, sha256);
        await this.workspaceStore.insertAudit(sql, context, {
          action: "workspace.file.write",
          roomId: input.roomId,
          subjectKind: "workspace_file",
          subjectId: relativePath,
          beforeVersion: input.expectedVersion,
          afterVersion: file.version,
          details: { sha256, size: file.size }
        });
        return { file, event, transactionId };
      });
      databaseCommitted = true;
      // A retry may find an earlier DB commit whose rename was interrupted.
      // Finalize that durable transaction before discarding this retry's
      // unused staging file.
      await this.finalize(context, result.value.transactionId);
      if (result.value.transactionId !== transactionId) {
        // The same operation was already committed. This new staging file was
        // never referenced by the durable transaction, so remove it.
        await rm(stagedAbsolutePath, { force: true });
      }
      return { ...result.value, replayed: result.replayed };
    } catch (error) {
      if (!databaseCommitted) await rm(stagedAbsolutePath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async read(
    context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">,
    input: { roomId: string; path: string }
  ): Promise<{ file: WorkspaceFile; content: Buffer }> {
    assertOpaqueId(input.roomId, "room_id_invalid");
    const safePath = assertSafeRelativePath(input.path);
    const file = await this.workspaceStore.database.withContext(context, async (sql) => {
      const result = await sql.query<FileRow>(
        `SELECT workspace_id, room_id, path, version, sha256, size, created_at, updated_at
         FROM workspace_files WHERE workspace_id = $1 AND room_id = $2 AND path = $3`,
        [context.workspaceId, input.roomId, safePath]
      );
      const row = result.rows[0];
      if (!row) throw new WorkspaceServerError("workspace_file_not_found", 404);
      return fileFromRow(row);
    });
    const content = await readFile(this.resolveWithinWorkspace(this.workspaceRoot(context.workspaceId), `files/${safePath}`));
    if (hashBytes(content) !== file.sha256) throw new WorkspaceServerError("workspace_file_hash_mismatch", 500);
    return { file, content };
  }

  /**
   * Removes a file through the same database transaction ledger as writes.
   * The physical file is removed only after PostgreSQL commits; if that final
   * step is interrupted, the recovery ledger retries it after the next boot.
   */
  async remove(context: WorkspaceRequestContext, input: RemoveWorkspaceFileInput): Promise<RemoveWorkspaceFileResult> {
    assertOpaqueId(input.roomId, "room_id_invalid");
    const relativePath = assertSafeRelativePath(input.path);
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
      throw new WorkspaceServerError("workspace_file_expected_version_invalid", 400);
    }
    await this.workspaceStore.assertRoomWritable(context, input.roomId);
    if (isWorkspaceCompletionOwnedPath(relativePath)) {
      throw new WorkspaceServerError("workspace_file_path_owned_by_completion", 409, { path: relativePath });
    }
    const transactionId = `file_tx_${randomUUID()}`;
    const stagedPath = `.staging/${transactionId}.delete`;
    const result = await this.workspaceStore.runIdempotentResult(context, {
        action: "workspace.file.delete",
        input: { roomId: input.roomId, path: relativePath, expectedVersion: input.expectedVersion }
      }, async (sql) => {
        await assertWorkspaceWritable(sql, context.workspaceId);
        await sql.query("SELECT pg_advisory_xact_lock(hashtext($1))", [fileLockKey(context.workspaceId, relativePath)]);
        const previous = await sql.query<FileRow>(
          `SELECT workspace_id, room_id, path, version, sha256, size, created_at, updated_at
           FROM workspace_files WHERE workspace_id = $1 AND path = $2 FOR UPDATE`,
          [context.workspaceId, relativePath]
        );
        const previousFile = previous.rows[0] ? fileFromRow(previous.rows[0]) : undefined;
        if (!previousFile || previousFile.roomId !== input.roomId || previousFile.version !== input.expectedVersion) {
          throw new WorkspaceServerError("workspace_file_version_conflict", 409, {
            latest_version: previousFile?.version ?? null
          });
        }
        const deleted = await sql.query(
          `DELETE FROM workspace_files
           WHERE workspace_id = $1 AND room_id = $2 AND path = $3 AND version = $4`,
          [context.workspaceId, input.roomId, relativePath, input.expectedVersion]
        );
        if (deleted.rowCount !== 1) throw new WorkspaceServerError("workspace_file_version_conflict", 409);
        await sql.query(
          `INSERT INTO workspace_file_transactions(workspace_id, id, room_id, target_path, staged_path, previous_file, next_file, status)
           VALUES ($1, $2, $3, $4, $5, $6::JSONB, $7::JSONB, 'db_committed')`,
          [
            context.workspaceId,
            transactionId,
            input.roomId,
            relativePath,
            stagedPath,
            canonicalJson(fileToJson(previousFile)),
            canonicalJson({ deleted: true, path: relativePath, previous_version: previousFile.version })
          ]
        );
        const event = await insertFileEvent(sql, context, input.roomId, relativePath, input.expectedVersion, undefined, "workspace.file.deleted");
        await this.workspaceStore.insertAudit(sql, context, {
          action: "workspace.file.delete",
          roomId: input.roomId,
          subjectKind: "workspace_file",
          subjectId: relativePath,
          beforeVersion: input.expectedVersion,
          afterVersion: input.expectedVersion + 1,
          details: { deleted: true }
        });
        return { event, transactionId };
      });
    await this.finalize(context, result.value.transactionId);
    return { ...result.value, replayed: result.replayed };
  }

  /** Call at boot with an active owner context to complete or surface interrupted file writes. */
  async recover(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">): Promise<{ recovered: string[]; failed: string[] }> {
    const transactions = await this.workspaceStore.database.withContext(context, async (sql) => {
      const result = await sql.query<FileTransactionRow>(
        `SELECT workspace_id, id, target_path, staged_path, previous_file, next_file, status
         FROM workspace_file_transactions
         WHERE workspace_id = $1 AND status = 'db_committed'
         ORDER BY created_at`,
        [context.workspaceId]
      );
      return result.rows;
    });
    const recovered: string[] = [];
    const failed: string[] = [];
    for (const transaction of transactions) {
      try {
        await this.finalize(context, transaction.id);
        recovered.push(transaction.id);
      } catch {
        failed.push(transaction.id);
      }
    }
    return { recovered, failed };
  }

  private async finalize(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, transactionId: string): Promise<void> {
    assertOpaqueId(transactionId, "workspace_file_transaction_id_invalid");
    await this.workspaceStore.database.withContext(context, async (sql) => {
      const result = await sql.query<FileTransactionRow>(
        `SELECT workspace_id, id, target_path, staged_path, previous_file, next_file, status
         FROM workspace_file_transactions WHERE workspace_id = $1 AND id = $2 FOR UPDATE`,
        [context.workspaceId, transactionId]
      );
      const transaction = result.rows[0];
      if (!transaction) throw new WorkspaceServerError("workspace_file_transaction_not_found", 404);
      if (transaction.status === "renamed") return;
      await sql.query("SELECT pg_advisory_xact_lock(hashtext($1))", [fileLockKey(context.workspaceId, transaction.target_path)]);

      const root = this.workspaceRoot(context.workspaceId);
      const source = this.resolveWithinWorkspace(root, transaction.staged_path);
      const destination = this.resolveWithinWorkspace(root, `files/${transaction.target_path}`);
      if (transaction.staged_path.endsWith(".delete")) {
        const currentFile = await sql.query<FileRow>(
          `SELECT workspace_id, room_id, path, version, sha256, size, created_at, updated_at
           FROM workspace_files WHERE workspace_id = $1 AND path = $2 FOR UPDATE`,
          [context.workspaceId, transaction.target_path]
        );
        if (currentFile.rows[0]) {
          throw new WorkspaceServerError("workspace_file_delete_recovery_required", 500, { path: transaction.target_path });
        }
        const current = await readFile(destination).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        });
        if (current) {
          const previous = transaction.previous_file ? jsonObject(transaction.previous_file).sha256 : undefined;
          if (typeof previous !== "string" || hashBytes(current) !== previous) {
            throw new WorkspaceServerError("workspace_file_delete_recovery_required", 500, { path: transaction.target_path });
          }
          await rm(destination, { force: false });
        }
      } else {
        const expected = jsonObject(transaction.next_file);
        const currentFile = await sql.query<FileRow>(
          `SELECT workspace_id, room_id, path, version, sha256, size, created_at, updated_at
           FROM workspace_files WHERE workspace_id = $1 AND path = $2 FOR UPDATE`,
          [context.workspaceId, transaction.target_path]
        );
        if (!currentFile.rows[0] || Number(currentFile.rows[0].version) !== Number(expected.version) || currentFile.rows[0].sha256 !== expected.sha256) {
          throw new WorkspaceServerError("workspace_file_rename_recovery_required", 500, { path: transaction.target_path });
        }
        const current = await readFile(destination).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        });
        if (current) {
          if (hashBytes(current) !== expected.sha256) {
            throw new WorkspaceServerError("workspace_file_rename_recovery_required", 500, { path: transaction.target_path });
          }
          await rm(source, { force: true });
        } else {
          try {
            await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
            await rename(source, destination);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            const recovered = await readFile(destination).catch(() => undefined);
            if (!recovered || hashBytes(recovered) !== expected.sha256) {
              throw new WorkspaceServerError("workspace_file_rename_recovery_required", 500, { path: transaction.target_path });
            }
          }
        }
      }

      // The rename can finish after a transfer has made the Workspace
      // read-only. This narrowly-scoped function changes only the durable
      // recovery marker; it does not reopen the Workspace for writes.
      const finalized = await sql.query<{ finalized: boolean }>(
        "SELECT samurai_finalize_workspace_file_transaction($1, $2) AS finalized",
        [context.workspaceId, transactionId]
      );
      if (finalized.rows[0]?.finalized !== true) throw new WorkspaceServerError("workspace_file_transaction_finalize_failed", 500);
    });
  }

  private workspaceRoot(workspaceId: string): string {
    assertOpaqueId(workspaceId, "workspace_id_invalid");
    return path.join(this.workspaceStore.storageRoot, "workspaces", workspaceId);
  }

  private resolveWithinWorkspace(root: string, relative: string): string {
    const resolved = path.resolve(root, ...relative.split("/"));
    const relativeToRoot = path.relative(root, resolved);
    if (relativeToRoot.startsWith(`..${path.sep}`) || relativeToRoot === ".." || path.isAbsolute(relativeToRoot)) {
      throw new WorkspaceServerError("workspace_file_path_invalid", 400);
    }
    return resolved;
  }
}

interface FileRow {
  workspace_id: string;
  room_id: string;
  path: string;
  version: number | string;
  sha256: string;
  size: number | string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface FileTransactionRow {
  workspace_id: string;
  id: string;
  target_path: string;
  staged_path: string;
  previous_file: Record<string, unknown> | string | null;
  next_file: Record<string, unknown> | string;
  status: "db_committed" | "renamed" | "rolled_back";
}

function fileFromRow(row: FileRow): WorkspaceFile {
  return {
    workspaceId: row.workspace_id,
    roomId: row.room_id,
    path: row.path,
    version: Number(row.version),
    sha256: row.sha256,
    size: Number(row.size),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

function fileToJson(file: WorkspaceFile): Record<string, unknown> {
  return {
    workspace_id: file.workspaceId,
    room_id: file.roomId,
    path: file.path,
    version: file.version,
    sha256: file.sha256,
    size: file.size,
    created_at: file.createdAt,
    updated_at: file.updatedAt
  };
}

function fileLockKey(workspaceId: string, relativePath: string): string {
  return `${workspaceId}\u001f${relativePath}`;
}

async function assertWorkspaceWritable(sql: WorkspaceSql, workspaceId: string): Promise<void> {
  const result = await sql.query<{ state: string }>("SELECT state FROM workspaces WHERE id = $1", [workspaceId]);
  if (result.rows[0]?.state !== "active") throw new WorkspaceServerError("workspace_read_only", 409);
}

async function insertFileEvent(
  sql: WorkspaceSql,
  context: WorkspaceRequestContext,
  roomId: string,
  filePath: string,
  version: number,
  sha256?: string,
  kind: "workspace.file.updated" | "workspace.file.deleted" = "workspace.file.updated"
): Promise<WorkspaceEvent> {
  const payload = sha256 ? { path: filePath, version, sha256 } : { path: filePath, version, deleted: true };
  const result = await sql.query<EventRow>(
    `INSERT INTO workspace_events(workspace_id, room_id, kind, operation_id, payload)
     VALUES ($1, $2, $3, $4, $5::JSONB)
     RETURNING id, workspace_id, room_id, kind, record_type, record_id, operation_id, payload, created_at`,
    [context.workspaceId, roomId, kind, context.operationId, canonicalJson(payload)]
  );
  const row = result.rows[0];
  if (!row) throw new WorkspaceServerError("workspace_event_creation_failed", 500);
  return {
    id: Number(row.id),
    workspaceId: row.workspace_id,
    roomId: row.room_id,
    kind: row.kind,
    operationId: row.operation_id,
    payload: jsonObject(row.payload),
    createdAt: iso(row.created_at)
  };
}

interface EventRow {
  id: number | string;
  workspace_id: string;
  room_id: string;
  kind: string;
  record_type: string | null;
  record_id: string | null;
  operation_id: string;
  payload: Record<string, unknown> | string;
  created_at: Date | string;
}

function jsonObject(value: Record<string, unknown> | string): Record<string, unknown> {
  if (typeof value === "string") {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new WorkspaceServerError("workspace_file_transaction_invalid", 500);
    return parsed as Record<string, unknown>;
  }
  return value;
}

function hashBytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
