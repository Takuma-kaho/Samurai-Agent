import { rename, rm } from "node:fs/promises";
import path from "node:path";
import { createId, nowIso } from "@samurai-agent/core-schemas";
import type { Transaction, Kysely } from "kysely";
import type { WorkspaceDb, WorkspaceFileTransactionsTable } from "../kernel/workspace-db-schema";
import type { WikiWithFilePath } from "../workspace-store-contracts";
import { wikiToRow } from "../repositories/wiki-collection-row-codecs";
import type { WorkspaceFileTransactionRecoveryHandler } from "./workspace-file-transaction-coordinator";

/** DB half of an atomic Wiki file update.  The frontmatter's semantic
 * `version` remains untouched; `resource_version` is the CAS token. */
export class WikiRecoveryHandler implements WorkspaceFileTransactionRecoveryHandler {
  readonly kinds = ["wiki_update", "wiki_copy", "wiki_scope_move"] as const;

  constructor(private readonly db: Kysely<WorkspaceDb>, private readonly rootDir: string) {}

  async commitUpdate(transaction: Transaction<WorkspaceDb>, input: { before: WikiWithFilePath; after: WikiWithFilePath }): Promise<boolean> {
    const update = await transaction.updateTable("wiki_index")
      .set(toRow(input.after))
      .where("id", "=", input.before.id)
      .where("resource_version", "=", input.before.resource_version)
      .executeTakeFirst();
    return Number(update.numUpdatedRows ?? 0) === 1;
  }

  async rollbackUpdate(transaction: Transaction<WorkspaceDb>, input: { before: WikiWithFilePath; after: WikiWithFilePath }): Promise<void> {
    const current = await transaction.selectFrom("wiki_index").select("resource_version").where("id", "=", input.before.id).executeTakeFirst();
    if (!current || current.resource_version === input.before.resource_version) return;
    if (current.resource_version !== input.after.resource_version) throw new Error(`wiki_transaction_rollback_conflict:${input.before.id}`);
    const update = await transaction.updateTable("wiki_index")
      .set(toRow(input.before))
      .where("id", "=", input.before.id)
      .where("resource_version", "=", input.after.resource_version)
      .executeTakeFirst();
    if (Number(update.numUpdatedRows ?? 0) !== 1) throw new Error(`wiki_transaction_rollback_conflict:${input.before.id}`);
  }

  async commitCopy(transaction: Transaction<WorkspaceDb>, input: {
    sourceId: string;
    expectedSourceVersion: number;
    after: WikiWithFilePath;
    targetBoundary?: ManagedResourceBoundary;
  }): Promise<boolean> {
    const source = await transaction.selectFrom("wiki_index")
      .select("resource_version")
      .where("id", "=", input.sourceId)
      .executeTakeFirst();
    if (!source || source.resource_version !== input.expectedSourceVersion) return false;
    await transaction.insertInto("wiki_index").values(toRow(input.after)).execute();
    if (input.targetBoundary) {
      await insertBoundary(transaction, "wiki", input.after.id, input.targetBoundary);
    }
    return true;
  }

  async rollbackCopy(transaction: Transaction<WorkspaceDb>, after: WikiWithFilePath, targetBoundary?: ManagedResourceBoundary): Promise<void> {
    if (targetBoundary) {
      await transaction.deleteFrom("resource_access_boundaries")
        .where("resource_kind", "=", "wiki")
        .where("resource_id", "=", after.id)
        .where("source_room_id", "=", targetBoundary.sourceRoomId)
        .execute();
    }
    await transaction.deleteFrom("wiki_index")
      .where("id", "=", after.id)
      .where("resource_version", "=", after.resource_version)
      .execute();
  }

  /** Moves a Room-scoped Wiki and its Room boundary in the same SQLite
   * transaction as the version CAS.  Any share history blocks relocation,
   * because silently retargeting or deleting historic shares would change
   * access semantics. */
  async commitScopeMove(transaction: Transaction<WorkspaceDb>, input: {
    before: WikiWithFilePath;
    after: WikiWithFilePath;
    sourceRoomId: string;
    targetRoomId: string;
  }): Promise<ScopeMoveResult> {
    const boundary = await transaction.selectFrom("resource_access_boundaries").selectAll()
      .where("resource_kind", "=", "wiki")
      .where("resource_id", "=", input.before.id)
      .executeTakeFirst();
    if (!boundary) return "boundary_missing";
    if (boundary.source_room_id !== input.sourceRoomId) return "boundary_source_mismatch";
    const share = await transaction.selectFrom("room_resource_shares").select("id")
      .where("resource_access_boundary_id", "=", boundary.id)
      .executeTakeFirst();
    if (share) return "boundary_has_shares";
    const updated = await this.commitUpdate(transaction, { before: input.before, after: input.after });
    if (!updated) return "version_conflict";
    const boundaryUpdate = await transaction.updateTable("resource_access_boundaries")
      .set({ source_room_id: input.targetRoomId, updated_at: nowIso() })
      .where("id", "=", boundary.id)
      .where("source_room_id", "=", input.sourceRoomId)
      .executeTakeFirst();
    if (Number(boundaryUpdate.numUpdatedRows ?? 0) !== 1) {
      throw new Error(`wiki_scope_move_boundary_update_failed:${input.before.id}`);
    }
    return "ok";
  }

  async rollbackScopeMove(transaction: Transaction<WorkspaceDb>, input: {
    before: WikiWithFilePath;
    after: WikiWithFilePath;
    sourceRoomId: string;
    targetRoomId: string;
  }): Promise<void> {
    await this.rollbackUpdate(transaction, { before: input.before, after: input.after });
    const updated = await transaction.updateTable("resource_access_boundaries")
      .set({ source_room_id: input.sourceRoomId, updated_at: nowIso() })
      .where("resource_kind", "=", "wiki")
      .where("resource_id", "=", input.before.id)
      .where("source_room_id", "=", input.targetRoomId)
      .executeTakeFirst();
    if (Number(updated.numUpdatedRows ?? 0) !== 1) {
      throw new Error(`wiki_scope_move_rollback_boundary_conflict:${input.before.id}`);
    }
  }

  async recover(row: WorkspaceFileTransactionsTable): Promise<"completed" | "rolled_back"> {
    const stagedPath = path.join(this.rootDir, row.staged_path);
    if (row.status === "db_committed") {
      if (await exists(stagedPath)) await rename(stagedPath, path.join(this.rootDir, row.target_path));
      return "completed";
    }
    await rm(stagedPath, { force: true });
    return "rolled_back";
  }
}

export interface ManagedResourceBoundary {
  sourceRoomId: string;
  ownerParticipantId: string;
  creatorParticipantId?: string;
  resourceCreatedAt?: string;
}

export type ScopeMoveResult = "ok" | "version_conflict" | "boundary_missing" | "boundary_source_mismatch" | "boundary_has_shares";

async function insertBoundary(
  transaction: Transaction<WorkspaceDb>,
  resourceKind: "wiki" | "skill",
  resourceId: string,
  input: ManagedResourceBoundary
): Promise<void> {
  const now = nowIso();
  await transaction.insertInto("resource_access_boundaries").values({
    id: createId("resource-boundary"),
    resource_kind: resourceKind,
    resource_id: resourceId,
    source_room_id: input.sourceRoomId,
    owner_participant_id: input.ownerParticipantId,
    creator_participant_id: input.creatorParticipantId ?? null,
    resource_created_at: input.resourceCreatedAt ?? null,
    boundary_registered_at: now,
    updated_at: now
  }).execute();
}

function toRow(value: WikiWithFilePath) {
  const { file_path, resource_version, ...frontmatter } = value;
  return wikiToRow(frontmatter, file_path, resource_version);
}

async function exists(filePath: string): Promise<boolean> {
  return import("node:fs/promises").then(({ access }) => access(filePath).then(() => true).catch(() => false));
}
