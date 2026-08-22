import { nowIso, type ClientEventRecord } from "@samurai-agent/core-schemas";
import type { Kysely } from "kysely";
import type { ClientEventsTable, WorkspaceDb } from "../kernel/workspace-db-schema";
import { decodeJson, encodeJson } from "./serialization";

function clientEventToRow(event: ClientEventRecord): ClientEventsTable {
  return {
    id: event.id,
    room_id: event.room_id ?? null,
    target_client_kind: event.target_client_kind,
    target_client_id: event.target_client_id ?? null,
    event_type: event.event_type,
    status: event.status,
    payload_json: encodeJson(event.payload),
    resource_refs_json: encodeJson(event.resource_refs),
    created_at: event.created_at,
    delivered_at: event.delivered_at ?? null,
    acked_at: event.acked_at ?? null,
    expires_at: event.expires_at ?? null,
    error_code: event.error_code ?? null
  };
}

function clientEventFromRow(row: ClientEventsTable): ClientEventRecord {
  return {
    id: row.id,
    ...(row.room_id ? { room_id: row.room_id } : {}),
    target_client_kind: row.target_client_kind as ClientEventRecord["target_client_kind"],
    target_client_id: row.target_client_id ?? undefined,
    event_type: row.event_type as ClientEventRecord["event_type"],
    status: row.status as ClientEventRecord["status"],
    payload: decodeJson(row.payload_json),
    resource_refs: decodeJson(row.resource_refs_json),
    created_at: row.created_at,
    delivered_at: row.delivered_at ?? undefined,
    acked_at: row.acked_at ?? undefined,
    expires_at: row.expires_at ?? undefined,
    error_code: row.error_code ?? undefined
  };
}

/** SQLite-backed client event queue. */
export class ClientEventQueueRepository {
  constructor(private readonly db: Kysely<WorkspaceDb>) {}

  async saveClientEvent(event: ClientEventRecord): Promise<ClientEventRecord> {
    await this.db
      .insertInto("client_events")
      .values(clientEventToRow(event))
      .onConflict((oc) => oc.column("id").doNothing())
      .execute();
    return event;
  }

  async getClientEvent(eventId: string): Promise<ClientEventRecord | undefined> {
    const row = await this.db.selectFrom("client_events").selectAll().where("id", "=", eventId).executeTakeFirst();
    return row ? clientEventFromRow(row) : undefined;
  }

  async listClientEvents(input: {
    targetClientKind?: ClientEventRecord["target_client_kind"];
    targetClientId?: string;
    status?: ClientEventRecord["status"];
    limit?: number;
  } = {}): Promise<ClientEventRecord[]> {
    let query = this.db.selectFrom("client_events").selectAll();
    if (input.targetClientKind) {
      const targetClientKind = input.targetClientKind;
      query = query.where((expression) => expression.or([
        expression("target_client_kind", "=", targetClientKind),
        expression("target_client_kind", "=", "any")
      ]));
    }
    if (input.targetClientId) {
      const targetClientId = input.targetClientId;
      query = query.where((expression) => expression.or([
        expression("target_client_id", "is", null),
        expression("target_client_id", "=", targetClientId)
      ]));
    } else if (input.targetClientKind) {
      query = query.where("target_client_id", "is", null);
    }
    if (input.status) query = query.where("status", "=", input.status);
    const rows = await query.orderBy("created_at", "asc").limit(input.limit ?? 50).execute();
    return rows.map(clientEventFromRow);
  }

  async markClientEventDelivered(eventId: string, deliveredAt = nowIso()): Promise<ClientEventRecord | undefined> {
    await this.db.updateTable("client_events").set({ status: "delivered", delivered_at: deliveredAt, error_code: null }).where("id", "=", eventId).where("status", "=", "pending").execute();
    return this.getClientEvent(eventId);
  }

  async ackClientEvent(eventId: string, ackedAt = nowIso()): Promise<ClientEventRecord | undefined> {
    await this.db.updateTable("client_events").set({ status: "acked", delivered_at: ackedAt, acked_at: ackedAt, error_code: null }).where("id", "=", eventId).where("status", "in", ["pending", "delivered"]).execute();
    return this.getClientEvent(eventId);
  }

  async failClientEvent(eventId: string, errorCode: string, failedAt = nowIso()): Promise<ClientEventRecord | undefined> {
    await this.db.updateTable("client_events").set({ status: "failed", error_code: errorCode, delivered_at: failedAt }).where("id", "=", eventId).where("status", "in", ["pending", "delivered"]).execute();
    return this.getClientEvent(eventId);
  }

  async expireClientEvents(input: { now?: string } = {}): Promise<ClientEventRecord[]> {
    const now = input.now ?? nowIso();
    const rows = await this.db.selectFrom("client_events").selectAll().where("status", "in", ["pending", "delivered"]).where("expires_at", "<=", now).execute();
    if (rows.length === 0) return [];
    await this.db.updateTable("client_events").set({ status: "expired" }).where("id", "in", rows.map((row) => row.id)).execute();
    return rows.map((row) => clientEventFromRow({ ...row, status: "expired" }));
  }
}
