import {
  ExternalAppConnectionRecordSchema,
  type ExternalAppConnectionRecord
} from "@samurai-agent/core-schemas";
import type { Kysely, Transaction } from "kysely";
import type { WorkspaceDb } from "../kernel/workspace-db-schema";
import { parse, stringify } from "./serialization";

type DbExecutor = Kysely<WorkspaceDb> | Transaction<WorkspaceDb>;

/**
 * Owns only secret-free Connection metadata and its narrowing scopes.
 * Pairing, credentials, and Room membership intentionally live elsewhere.
 */
export class ExternalAppConnectionRepository {
  constructor(private readonly db: Kysely<WorkspaceDb>) {}

  async saveExternalAppConnection(input: ExternalAppConnectionRecord): Promise<ExternalAppConnectionRecord> {
    const connection = ExternalAppConnectionRecordSchema.parse(input);
    return this.db.transaction().execute(async (trx) => {
      const existing = await readConnection(trx, connection.id);
      if (existing) {
        if (existing.status === "revoked" && connection.status === "active") {
          throw new Error("external_app_connection_reactivation_forbidden");
        }
        if (
          existing.workspace_id !== connection.workspace_id ||
          existing.connector_id !== connection.connector_id ||
          existing.app_id !== connection.app_id ||
          !sameJson(existing.delegated_principal, connection.delegated_principal) ||
          !sameJson(existing.created_by, connection.created_by) ||
          existing.created_at !== connection.created_at
        ) {
          throw new Error("external_app_connection_identity_immutable");
        }
      }
      const byConnector = await readConnectionByConnector(trx, connection.workspace_id, connection.connector_id);
      if (byConnector && byConnector.id !== connection.id) throw new Error("external_app_connector_already_bound");

      await trx.insertInto("external_app_connections").values({
        id: connection.id,
        workspace_id: connection.workspace_id,
        connector_id: connection.connector_id,
        app_id: connection.app_id,
        status: connection.status,
        delegated_principal_json: stringify(connection.delegated_principal),
        non_secret_metadata_json: stringify(connection.non_secret_metadata),
        created_by_json: stringify(connection.created_by),
        created_at: connection.created_at,
        updated_at: connection.updated_at,
        revoked_at: connection.revoked_at ?? null
      }).onConflict((oc) => oc.column("id").doUpdateSet({
        status: connection.status,
        delegated_principal_json: stringify(connection.delegated_principal),
        non_secret_metadata_json: stringify(connection.non_secret_metadata),
        created_by_json: stringify(connection.created_by),
        updated_at: connection.updated_at,
        revoked_at: connection.revoked_at ?? null
      })).execute();

      await trx.deleteFrom("external_app_connection_rooms").where("connection_id", "=", connection.id).execute();
      await trx.insertInto("external_app_connection_rooms").values(
        connection.allowed_room_ids.map((room_id) => ({ connection_id: connection.id, room_id }))
      ).execute();
      await trx.deleteFrom("external_app_connection_ingress_classes").where("connection_id", "=", connection.id).execute();
      await trx.insertInto("external_app_connection_ingress_classes").values(
        connection.ingress_classes.map((ingress_class) => ({ connection_id: connection.id, ingress_class }))
      ).execute();
      const saved = await readConnection(trx, connection.id);
      if (!saved) throw new Error("external_app_connection_save_lost");
      return saved;
    });
  }

  async getExternalAppConnection(id: string): Promise<ExternalAppConnectionRecord | undefined> {
    return readConnection(this.db, id);
  }

  async getExternalAppConnectionByConnector(input: { workspaceId: string; connectorId: string }): Promise<ExternalAppConnectionRecord | undefined> {
    return readConnectionByConnector(this.db, input.workspaceId, input.connectorId);
  }

  async listExternalAppConnections(input: { workspaceId: string; status?: ExternalAppConnectionRecord["status"] }): Promise<ExternalAppConnectionRecord[]> {
    let query = this.db.selectFrom("external_app_connections").select("id").where("workspace_id", "=", input.workspaceId);
    if (input.status) query = query.where("status", "=", input.status);
    const rows = await query.orderBy("updated_at", "desc").execute();
    return (await Promise.all(rows.map((row) => readConnection(this.db, row.id)))).filter((value): value is ExternalAppConnectionRecord => Boolean(value));
  }

  async revokeExternalAppConnection(input: { id: string; revokedAt: string; updatedAt?: string }): Promise<ExternalAppConnectionRecord | undefined> {
    return this.db.transaction().execute(async (trx) => {
      const existing = await readConnection(trx, input.id);
      if (!existing) return undefined;
      if (existing.status === "revoked") return existing;
      await trx.updateTable("external_app_connections")
        .set({ status: "revoked", revoked_at: input.revokedAt, updated_at: input.updatedAt ?? input.revokedAt })
        .where("id", "=", input.id)
        .where("status", "=", "active")
        .execute();
      return readConnection(trx, input.id);
    });
  }
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function readConnection(db: DbExecutor, id: string): Promise<ExternalAppConnectionRecord | undefined> {
  const row = await db.selectFrom("external_app_connections").selectAll().where("id", "=", id).executeTakeFirst();
  if (!row) return undefined;
  const [rooms, ingress] = await Promise.all([
    db.selectFrom("external_app_connection_rooms").select("room_id").where("connection_id", "=", row.id).orderBy("room_id", "asc").execute(),
    db.selectFrom("external_app_connection_ingress_classes").select("ingress_class").where("connection_id", "=", row.id).orderBy("ingress_class", "asc").execute()
  ]);
  return ExternalAppConnectionRecordSchema.parse({
    id: row.id,
    workspace_id: row.workspace_id,
    connector_id: row.connector_id,
    app_id: row.app_id,
    status: row.status,
    delegated_principal: parse(row.delegated_principal_json),
    allowed_room_ids: rooms.map((scope) => scope.room_id),
    ingress_classes: ingress.map((scope) => scope.ingress_class),
    non_secret_metadata: parse(row.non_secret_metadata_json),
    created_by: parse(row.created_by_json),
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...(row.revoked_at ? { revoked_at: row.revoked_at } : {})
  });
}

async function readConnectionByConnector(db: DbExecutor, workspaceId: string, connectorId: string): Promise<ExternalAppConnectionRecord | undefined> {
  const row = await db.selectFrom("external_app_connections")
    .select("id")
    .where("workspace_id", "=", workspaceId)
    .where("connector_id", "=", connectorId)
    .executeTakeFirst();
  return row ? readConnection(db, row.id) : undefined;
}
