import { rename, rm } from "node:fs/promises";
import path from "node:path";
import type { CollectionSchema } from "@samurai-agent/core-schemas";
import type { Transaction, Kysely } from "kysely";
import type { WorkspaceDb, WorkspaceFileTransactionsTable } from "../kernel/workspace-db-schema";
import type { CollectionSchemasTable } from "../rows/collection-rows";
import { stringify } from "../repositories/serialization";
import type { WorkspaceFileTransactionRecoveryHandler } from "./workspace-file-transaction-coordinator";

type StoredSchema = CollectionSchema & { file_path: string; resource_version: number };

/** Owns the DB half of a schema file update.  A semantic Collection schema
 * version is arbitrary text, so this uses `resource_version` as its CAS
 * value and lets the generic file coordinator recover an interrupted rename. */
export class CollectionSchemaRecoveryHandler implements WorkspaceFileTransactionRecoveryHandler {
  readonly kinds = ["collection_schema_update"] as const;

  constructor(private readonly db: Kysely<WorkspaceDb>, private readonly rootDir: string) {}

  async commitUpdate(transaction: Transaction<WorkspaceDb>, input: { before: StoredSchema; after: StoredSchema }): Promise<boolean> {
    const update = await transaction.updateTable("collection_schemas")
      .set(schemaRow(input.after))
      .where("id", "=", input.before.id)
      .where("resource_version", "=", input.before.resource_version)
      .executeTakeFirst();
    return Number(update.numUpdatedRows ?? 0) === 1;
  }

  async rollbackUpdate(transaction: Transaction<WorkspaceDb>, input: { before: StoredSchema; after: StoredSchema }): Promise<void> {
    const current = await transaction.selectFrom("collection_schemas")
      .select("resource_version")
      .where("id", "=", input.before.id)
      .executeTakeFirst();
    if (!current || current.resource_version === input.before.resource_version) return;
    if (current.resource_version !== input.after.resource_version) {
      throw new Error(`collection_schema_transaction_rollback_conflict:${input.before.id}`);
    }
    const update = await transaction.updateTable("collection_schemas")
      .set(schemaRow(input.before))
      .where("id", "=", input.before.id)
      .where("resource_version", "=", input.after.resource_version)
      .executeTakeFirst();
    if (Number(update.numUpdatedRows ?? 0) !== 1) {
      throw new Error(`collection_schema_transaction_rollback_conflict:${input.before.id}`);
    }
  }

  async recover(row: WorkspaceFileTransactionsTable): Promise<"completed" | "rolled_back"> {
    const stagedPath = path.join(this.rootDir, row.staged_path);
    // `db_committed` is written in the same transaction as the CAS.  The
    // staged file is therefore authoritative if it remains after a crash;
    // if it is gone, the atomic rename already happened.
    if (row.status === "db_committed") {
      const stagedExists = await exists(stagedPath);
      if (stagedExists) await rename(stagedPath, path.join(this.rootDir, row.target_path));
      return "completed";
    }
    await rm(stagedPath, { force: true });
    return "rolled_back";
  }
}

function schemaRow(schema: StoredSchema): CollectionSchemasTable {
  return {
    id: schema.id,
    version: schema.version,
    resource_version: schema.resource_version,
    file_path: schema.file_path,
    schema_json: stringify(stripPersistenceFields(schema)),
    updated_at: new Date().toISOString()
  };
}

function stripPersistenceFields(schema: StoredSchema): CollectionSchema {
  const { file_path: _filePath, resource_version: _resourceVersion, ...value } = schema;
  return value;
}

async function exists(filePath: string): Promise<boolean> {
  return import("node:fs/promises").then(({ access }) => access(filePath).then(() => true).catch(() => false));
}
