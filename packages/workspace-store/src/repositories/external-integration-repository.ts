import {
  ExternalIntegrationError,
  parseExternalIntegrationRecord,
  recordId,
  type CaptureQuotaReservation,
  type CaptureRecordRelease,
  type ExternalIntegrationAtomicMutation,
  type ExternalIntegrationRecordMap,
  type ExternalIntegrationRecordType,
  type ExternalIntegrationStore
} from "@samurai-agent/external-integration";
import type { Kysely, Transaction } from "kysely";
import type { WorkspaceDb } from "../kernel/workspace-db-schema";
import { parse, stringify } from "./serialization";

type DbExecutor = Kysely<WorkspaceDb> | Transaction<WorkspaceDb>;
type IntegrationFilters = { workspaceId?: string; connectionId?: string; connectorId?: string; accountId?: string; projectRef?: string; externalSessionId?: string };

/** Durable implementation of the external-integration contract. It stores one
 * validated JSON record per type/id and uses the row version for CAS. */
export class ExternalIntegrationRepository implements ExternalIntegrationStore {
  constructor(private readonly db: Kysely<WorkspaceDb>) {}

  async getRecord<K extends ExternalIntegrationRecordType>(type: K, id: string): Promise<ExternalIntegrationRecordMap[K] | undefined> {
    const row = await this.db.selectFrom("external_integration_records").selectAll().where("record_type", "=", type).where("record_id", "=", id).executeTakeFirst();
    return row ? parseExternalIntegrationRecord(type, parse(row.payload_json)) : undefined;
  }

  async getRecordVersion(type: ExternalIntegrationRecordType, id: string): Promise<number | undefined> {
    const row = await this.db.selectFrom("external_integration_records").select("version").where("record_type", "=", type).where("record_id", "=", id).executeTakeFirst();
    return row?.version;
  }

  async listRecords<K extends ExternalIntegrationRecordType>(type: K, input: IntegrationFilters = {}): Promise<ExternalIntegrationRecordMap[K][]> {
    let query = this.db.selectFrom("external_integration_records").selectAll().where("record_type", "=", type);
    if (input.workspaceId) query = query.where("workspace_id", "=", input.workspaceId);
    if (input.connectionId) query = query.where("connection_id", "=", input.connectionId);
    if (input.connectorId) query = query.where("connector_id", "=", input.connectorId);
    if (input.accountId) query = query.where("account_id", "=", input.accountId);
    if (input.projectRef) query = query.where("project_ref", "=", input.projectRef);
    if (input.externalSessionId) query = query.where("external_session_id", "=", input.externalSessionId);
    const rows = await query.orderBy("updated_at", "desc").execute();
    return rows.map((row) => parseExternalIntegrationRecord(type, parse(row.payload_json)));
  }

  async createRecord<K extends ExternalIntegrationRecordType>(type: K, record: ExternalIntegrationRecordMap[K]): Promise<ExternalIntegrationRecordMap[K]> {
    const parsed = parseExternalIntegrationRecord(type, record);
    const id = recordId(type, parsed);
    try {
      return await insertRecord(this.db, type, parsed);
    } catch (error) {
      if (String(error).toLowerCase().includes("unique") || String(error).toLowerCase().includes("constraint")) {
        throw new Error(`external_record_exists:${type}:${id}`);
      }
      throw error;
    }
  }

  async updateRecord<K extends ExternalIntegrationRecordType>(type: K, id: string, expectedVersion: number, record: ExternalIntegrationRecordMap[K]): Promise<boolean> {
    return updateRecord(this.db, type, id, expectedVersion, record);
  }

  async deleteRecord(type: ExternalIntegrationRecordType, id: string): Promise<boolean> {
    const result = await this.db.deleteFrom("external_integration_records").where("record_type", "=", type).where("record_id", "=", id).executeTakeFirst();
    return Number(result.numDeletedRows ?? 0) > 0;
  }

  async atomic(mutations: readonly ExternalIntegrationAtomicMutation[]): Promise<boolean> {
    try {
      await this.db.transaction().execute(async (trx) => {
        for (const mutation of mutations) {
          if (mutation.kind === "create") {
            await insertRecord(trx, mutation.type, mutation.record as never);
            continue;
          }
          if (mutation.kind === "update") {
            if (!await updateRecord(trx, mutation.type, mutation.id, mutation.expectedVersion, mutation.record as never)) throw new ExternalIntegrationConflict();
            continue;
          }
          let query = trx.deleteFrom("external_integration_records").where("record_type", "=", mutation.type).where("record_id", "=", mutation.id);
          if (mutation.expectedVersion !== undefined) query = query.where("version", "=", mutation.expectedVersion);
          const result = await query.executeTakeFirst();
          if (Number(result.numDeletedRows ?? 0) !== 1) throw new ExternalIntegrationConflict();
        }
      });
      return true;
    } catch (error) {
      if (error instanceof ExternalIntegrationConflict || isConstraintError(error)) return false;
      throw error;
    }
  }

  async reserveCapture(input: CaptureQuotaReservation): Promise<"created" | "quota_exceeded"> {
    const record = parseExternalIntegrationRecord("raw_external_record", input.record);
    let lastConflict: unknown;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        return await this.db.transaction().execute(async (trx) => {
          const existingRecord = await trx.selectFrom("external_integration_records")
            .select("record_id")
            .where("record_type", "=", "raw_external_record")
            .where("record_id", "=", record.id)
            .executeTakeFirst();
          if (existingRecord) throw new Error(`external_record_exists:raw_external_record:${record.id}`);
          const quota = await trx.selectFrom("external_capture_quota_usage")
            .selectAll()
            .where("workspace_id", "=", record.workspace_id)
            .where("connection_id", "=", record.connection_id)
            .executeTakeFirst();
          if (!quota) {
            const existing = await trx.selectFrom("external_integration_records")
              .select("payload_json")
              .where("record_type", "=", "raw_external_record")
              .where("workspace_id", "=", record.workspace_id)
              .where("connection_id", "=", record.connection_id)
              .execute();
            const usedBytes = existing.reduce((total, row) => total + parseExternalIntegrationRecord("raw_external_record", parse(row.payload_json)).size_bytes, 0);
            if (usedBytes + record.size_bytes > input.quotaBytes) return "quota_exceeded";
            await trx.insertInto("external_capture_quota_usage").values({
              workspace_id: record.workspace_id,
              connection_id: record.connection_id,
              used_bytes: usedBytes + record.size_bytes,
              updated_at: record.created_at
            }).execute();
          } else {
            const result = await trx.updateTable("external_capture_quota_usage")
              .set({ used_bytes: quota.used_bytes + record.size_bytes, updated_at: record.created_at })
              .where("workspace_id", "=", record.workspace_id)
              .where("connection_id", "=", record.connection_id)
              .where("used_bytes", "=", quota.used_bytes)
              .where("used_bytes", "<=", input.quotaBytes - record.size_bytes)
              .executeTakeFirst();
            if (Number(result.numUpdatedRows ?? 0) !== 1) return "quota_exceeded";
          }
          await insertRecord(trx, "raw_external_record", record);
          return "created";
        });
      } catch (error) {
        if (!isConstraintError(error)) throw error;
        lastConflict = error;
      }
    }
    throw lastConflict instanceof Error ? lastConflict : new Error("external_capture_quota_conflict");
  }

  async releaseCapture(input: CaptureRecordRelease): Promise<boolean> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        return await this.db.transaction().execute(async (trx) => {
          const row = await trx.selectFrom("external_integration_records")
            .selectAll()
            .where("record_type", "=", "raw_external_record")
            .where("record_id", "=", input.recordId)
            .executeTakeFirst();
          if (!row) return false;
          const record = parseExternalIntegrationRecord("raw_external_record", parse(row.payload_json));
          const removed = await trx.deleteFrom("external_integration_records")
            .where("record_type", "=", "raw_external_record")
            .where("record_id", "=", input.recordId)
            .where("version", "=", row.version)
            .executeTakeFirst();
          if (Number(removed.numDeletedRows ?? 0) !== 1) throw new ExternalIntegrationConflict();
          const quota = await trx.selectFrom("external_capture_quota_usage")
            .selectAll()
            .where("workspace_id", "=", record.workspace_id)
            .where("connection_id", "=", record.connection_id)
            .executeTakeFirst();
          if (quota) {
            const quotaUpdate = await trx.updateTable("external_capture_quota_usage")
              .set({ used_bytes: Math.max(0, quota.used_bytes - record.size_bytes), updated_at: new Date().toISOString() })
              .where("workspace_id", "=", record.workspace_id)
              .where("connection_id", "=", record.connection_id)
              .where("used_bytes", "=", quota.used_bytes)
              .executeTakeFirst();
            if (Number(quotaUpdate.numUpdatedRows ?? 0) !== 1) throw new ExternalIntegrationConflict();
          }
          if (input.auditEvent) await insertRecord(trx, "audit_event", input.auditEvent);
          return true;
        });
      } catch (error) {
        if (!(error instanceof ExternalIntegrationConflict)) throw error;
      }
    }
    if (!await this.getRecord("raw_external_record", input.recordId)) return false;
    throw new ExternalIntegrationError("mcp_outcome_unknown", "capture_release_outcome_unknown", false);
  }
}

class ExternalIntegrationConflict extends Error {}

async function insertRecord<K extends ExternalIntegrationRecordType>(executor: DbExecutor, type: K, record: ExternalIntegrationRecordMap[K]): Promise<ExternalIntegrationRecordMap[K]> {
  const parsed = parseExternalIntegrationRecord(type, record);
  const id = recordId(type, parsed);
  const now = recordTimestamp(parsed);
  await executor.insertInto("external_integration_records").values({
    ...metadata(type, parsed),
    record_type: type,
    record_id: id,
    payload_json: stringify(parsed),
    version: 1,
    created_at: now,
    updated_at: now
  }).execute();
  return parsed;
}

async function updateRecord<K extends ExternalIntegrationRecordType>(executor: DbExecutor, type: K, id: string, expectedVersion: number, record: ExternalIntegrationRecordMap[K]): Promise<boolean> {
  const parsed = parseExternalIntegrationRecord(type, record);
  if (recordId(type, parsed) !== id) throw new Error("external_record_id_immutable");
  const result = await executor.updateTable("external_integration_records")
    .set({
      ...metadata(type, parsed),
      payload_json: stringify(parsed),
      version: expectedVersion + 1,
      updated_at: recordTimestamp(parsed)
    })
    .where("record_type", "=", type)
    .where("record_id", "=", id)
    .where("version", "=", expectedVersion)
    .executeTakeFirst();
  return Number(result.numUpdatedRows ?? 0) > 0;
}

function isConstraintError(error: unknown): boolean {
  const value = String(error).toLowerCase();
  return value.includes("unique") || value.includes("constraint");
}

function metadata<K extends ExternalIntegrationRecordType>(type: K, record: ExternalIntegrationRecordMap[K]): {
  workspace_id: string | null;
  connection_id: string | null;
  connector_id: string | null;
  account_id: string | null;
  project_ref: string | null;
  external_session_id: string | null;
} {
  const value = record as Record<string, unknown>;
  const event = value.event && typeof value.event === "object" ? value.event as Record<string, unknown> : undefined;
  return {
    workspace_id: stringOrNull(value.workspace_id),
    connection_id: stringOrNull(value.connection_id),
    connector_id: stringOrNull(value.connector_id) ?? stringOrNull(event?.connector_id),
    account_id: stringOrNull(value.account_id),
    project_ref: stringOrNull(value.project_ref),
    external_session_id: stringOrNull(value.external_session_id) ?? stringOrNull(event?.external_session_id)
  };
}

function recordTimestamp(record: unknown): string {
  const value = record as Record<string, unknown>;
  const event = value.event && typeof value.event === "object" ? value.event as Record<string, unknown> : undefined;
  return stringOrNull(value.updated_at) ?? stringOrNull(value.created_at) ?? stringOrNull(event?.occurred_at) ?? new Date().toISOString();
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
