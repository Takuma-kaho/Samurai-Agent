import { AsyncLocalStorage } from "node:async_hooks";
import {
  ExternalIntegrationError,
  parseExternalIntegrationRecord,
  recordId,
  type CaptureRecordRelease,
  type CaptureQuotaReservation,
  type ExternalIntegrationAtomicMutation,
  type ExternalIntegrationRecordMap,
  type ExternalIntegrationRecordType,
  type ExternalIntegrationStore
} from "@samurai-agent/external-integration";
import { PostgresWorkspaceDatabase, type WorkspaceSql } from "@samurai-agent/workspace-server";

export interface PostgresExternalIntegrationRequestContext {
  workspaceId?: string;
  accountId?: string;
}

const requestContexts = new AsyncLocalStorage<PostgresExternalIntegrationRequestContext>();

/**
 * Sets the tenant for one external HTTP request. The external integration
 * package intentionally has no database context in its public Store contract;
 * this small adapter supplies it at the PostgreSQL boundary instead of
 * leaking a database handle into OAuth, MCP, or Connector code.
 */
export function runPostgresExternalIntegrationContext<T>(
  context: PostgresExternalIntegrationRequestContext,
  action: () => Promise<T>
): Promise<T> {
  return requestContexts.run(context, action);
}

export function currentPostgresExternalIntegrationContext(): PostgresExternalIntegrationRequestContext {
  return requestContexts.getStore() ?? {};
}

interface ExternalRecordRow {
  workspace_id: string | null;
  record_type: string;
  id: string;
  version: number | string;
  payload: unknown;
}

/** PostgreSQL operational store for OAuth, Connector, binding, approval, and
 * Capture records. These records are not Workspace Knowledge. The table has
 * its own RLS policy and can only be reached with the Server-owned external
 * integration transaction flag. */
export class PostgresExternalIntegrationStore implements ExternalIntegrationStore {
  constructor(private readonly database: PostgresWorkspaceDatabase) {}

  async getRecord<K extends ExternalIntegrationRecordType>(type: K, id: string): Promise<ExternalIntegrationRecordMap[K] | undefined> {
    return this.withSql(async (sql, workspaceId) => {
      const result = await sql.query<ExternalRecordRow>(
        `SELECT workspace_id, record_type, id, version, payload
         FROM workspace_external_integration_records
         WHERE record_type = $1 AND id = $2
           AND ($3::TEXT IS NULL OR workspace_id IS NULL OR workspace_id = $3)
         ORDER BY workspace_id NULLS LAST
         LIMIT 1`,
        [type, id, workspaceId]
      );
      const row = result.rows[0];
      return row ? parseExternalIntegrationRecord(type, jsonValue(row.payload)) : undefined;
    });
  }

  async getRecordVersion(type: ExternalIntegrationRecordType, id: string): Promise<number | undefined> {
    return this.withSql(async (sql, workspaceId) => {
      const result = await sql.query<{ version: number | string }>(
        `SELECT version
         FROM workspace_external_integration_records
         WHERE record_type = $1 AND id = $2
           AND ($3::TEXT IS NULL OR workspace_id IS NULL OR workspace_id = $3)
         ORDER BY workspace_id NULLS LAST
         LIMIT 1`,
        [type, id, workspaceId]
      );
      return result.rows[0] ? Number(result.rows[0].version) : undefined;
    });
  }

  async listRecords<K extends ExternalIntegrationRecordType>(
    type: K,
    input: { workspaceId?: string; connectionId?: string; connectorId?: string; accountId?: string; projectRef?: string; externalSessionId?: string } = {}
  ): Promise<ExternalIntegrationRecordMap[K][]> {
    return this.withSql(async (sql, workspaceId) => {
      const targetWorkspaceId = input.workspaceId ?? workspaceId;
      const result = await sql.query<ExternalRecordRow>(
        `SELECT workspace_id, record_type, id, version, payload
         FROM workspace_external_integration_records
         WHERE record_type = $1
           AND ($2::TEXT IS NULL OR workspace_id IS NULL OR workspace_id = $2)
         ORDER BY updated_at DESC, id`,
        [type, targetWorkspaceId ?? null]
      );
      return result.rows
        .map((row) => parseExternalIntegrationRecord(type, jsonValue(row.payload)))
        .filter((record) => matchesRecord(record, input));
    });
  }

  async createRecord<K extends ExternalIntegrationRecordType>(type: K, record: ExternalIntegrationRecordMap[K]): Promise<ExternalIntegrationRecordMap[K]> {
    const parsed = parseExternalIntegrationRecord(type, record);
    const id = recordId(type, parsed);
    return this.withSql(async (sql, workspaceId) => {
      const recordWorkspaceId = recordWorkspace(parsed) ?? workspaceId;
      assertContextWorkspace(workspaceId, recordWorkspaceId);
      await this.lockRecordsOfType(sql, recordWorkspaceId, type);
      await this.assertNoConflict(sql, recordWorkspaceId, type, parsed);
      try {
        await sql.query(
          `INSERT INTO workspace_external_integration_records(workspace_id, record_type, id, payload)
           VALUES ($1, $2, $3, $4::JSONB)`,
          [recordWorkspaceId ?? null, type, id, JSON.stringify(parsed)]
        );
      } catch (error) {
        if (isUniqueViolation(error)) throw externalRecordExists(type, id);
        throw error;
      }
      return parsed;
    }, recordWorkspaceIdFor(parsed));
  }

  async updateRecord<K extends ExternalIntegrationRecordType>(type: K, id: string, expectedVersion: number, record: ExternalIntegrationRecordMap[K]): Promise<boolean> {
    const parsed = parseExternalIntegrationRecord(type, record);
    if (recordId(type, parsed) !== id) throw new ExternalIntegrationError("mcp_invalid_arguments", "external_record_id_immutable");
    return this.withSql(async (sql, workspaceId) => {
      const recordWorkspaceId = recordWorkspace(parsed) ?? workspaceId;
      assertContextWorkspace(workspaceId, recordWorkspaceId);
      await this.lockRecordsOfType(sql, recordWorkspaceId, type);
      await this.assertNoConflict(sql, recordWorkspaceId, type, parsed, id);
      const updated = await sql.query<{ id: string }>(
        `UPDATE workspace_external_integration_records
         SET payload = $4::JSONB, version = version + 1, updated_at = NOW()
         WHERE workspace_id IS NOT DISTINCT FROM $1
           AND record_type = $2 AND id = $3 AND version = $5
         RETURNING id`,
        [recordWorkspaceId ?? null, type, id, JSON.stringify(parsed), expectedVersion]
      );
      return Boolean(updated.rows[0]);
    }, recordWorkspaceIdFor(parsed));
  }

  async deleteRecord(type: ExternalIntegrationRecordType, id: string): Promise<boolean> {
    return this.withSql(async (sql, workspaceId) => {
      const deleted = await sql.query<{ id: string }>(
        `DELETE FROM workspace_external_integration_records
         WHERE record_type = $1 AND id = $2
           AND ($3::TEXT IS NULL OR workspace_id IS NULL OR workspace_id = $3)
         RETURNING id`,
        [type, id, workspaceId]
      );
      return Boolean(deleted.rows[0]);
    });
  }

  async atomic(mutations: readonly ExternalIntegrationAtomicMutation[]): Promise<boolean> {
    if (mutations.length === 0) return true;
    const workspaceFromInput = mutations
      .map((mutation) => mutation.kind === "delete" ? undefined : recordWorkspace(mutation.record))
      .find((value): value is string => Boolean(value));
    return this.withSql(async (sql, workspaceId) => {
      assertContextWorkspace(workspaceId, workspaceFromInput);
      const scopedWorkspaceId = workspaceFromInput ?? workspaceId;
      const types = [...new Set(mutations.map((mutation) => mutation.type))];
      for (const type of types) await this.lockRecordsOfType(sql, scopedWorkspaceId, type);
      for (const mutation of mutations) {
        if (mutation.kind === "create") {
          const parsed = parseExternalIntegrationRecord(mutation.type, mutation.record);
          const recordWorkspaceId = recordWorkspace(parsed) ?? scopedWorkspaceId;
          assertContextWorkspace(scopedWorkspaceId, recordWorkspaceId);
          const existing = await this.findExact(sql, recordWorkspaceId, mutation.type, recordId(mutation.type, parsed));
          if (existing || await this.hasConflict(sql, recordWorkspaceId, mutation.type, parsed)) return false;
        } else if (mutation.kind === "update") {
          const parsed = parseExternalIntegrationRecord(mutation.type, mutation.record);
          const recordWorkspaceId = recordWorkspace(parsed) ?? scopedWorkspaceId;
          assertContextWorkspace(scopedWorkspaceId, recordWorkspaceId);
          const existing = await this.findExact(sql, recordWorkspaceId, mutation.type, mutation.id);
          if (!existing || Number(existing.version) !== mutation.expectedVersion || await this.hasConflict(sql, recordWorkspaceId, mutation.type, parsed, mutation.id)) return false;
        } else {
          const existing = await this.findExact(sql, scopedWorkspaceId, mutation.type, mutation.id);
          if (!existing || (mutation.expectedVersion !== undefined && Number(existing.version) !== mutation.expectedVersion)) return false;
        }
      }
      for (const mutation of mutations) {
        if (mutation.kind === "create") {
          const parsed = parseExternalIntegrationRecord(mutation.type, mutation.record);
          const recordWorkspaceId = recordWorkspace(parsed) ?? scopedWorkspaceId;
          await sql.query(
            `INSERT INTO workspace_external_integration_records(workspace_id, record_type, id, payload)
             VALUES ($1, $2, $3, $4::JSONB)`,
            [recordWorkspaceId ?? null, mutation.type, recordId(mutation.type, parsed), JSON.stringify(parsed)]
          );
        } else if (mutation.kind === "update") {
          const parsed = parseExternalIntegrationRecord(mutation.type, mutation.record);
          const recordWorkspaceId = recordWorkspace(parsed) ?? scopedWorkspaceId;
          await sql.query(
            `UPDATE workspace_external_integration_records
             SET payload = $4::JSONB, version = version + 1, updated_at = NOW()
             WHERE workspace_id IS NOT DISTINCT FROM $1 AND record_type = $2 AND id = $3`,
            [recordWorkspaceId ?? null, mutation.type, mutation.id, JSON.stringify(parsed)]
          );
        } else {
          await sql.query(
            `DELETE FROM workspace_external_integration_records
             WHERE workspace_id IS NOT DISTINCT FROM $1 AND record_type = $2 AND id = $3`,
            [scopedWorkspaceId ?? null, mutation.type, mutation.id]
          );
        }
      }
      return true;
    }, workspaceFromInput);
  }

  async reserveCapture(input: CaptureQuotaReservation): Promise<"created" | "quota_exceeded"> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const existing = await this.getRecord("raw_external_record", input.record.id);
      if (existing) throw externalRecordExists("raw_external_record", input.record.id);
      const quotaId = `capture_quota:${input.record.workspace_id}:${input.record.connection_id}`;
      const current = await this.getRecord("capture_quota_usage", quotaId);
      const currentVersion = await this.getRecordVersion("capture_quota_usage", quotaId);
      const usedBytes = current?.used_bytes ?? (await this.listRecords("raw_external_record", {
        workspaceId: input.record.workspace_id,
        connectionId: input.record.connection_id
      })).reduce((total, record) => total + record.size_bytes, 0);
      if (usedBytes + input.record.size_bytes > input.quotaBytes) return "quota_exceeded";
      const quota = {
        id: quotaId,
        workspace_id: input.record.workspace_id,
        connection_id: input.record.connection_id,
        used_bytes: usedBytes + input.record.size_bytes,
        updated_at: input.record.created_at
      } as ExternalIntegrationRecordMap["capture_quota_usage"];
      const applied = await this.atomic([
        current && currentVersion
          ? { kind: "update", type: "capture_quota_usage", id: quotaId, expectedVersion: currentVersion, record: quota }
          : { kind: "create", type: "capture_quota_usage", record: quota },
        { kind: "create", type: "raw_external_record", record: input.record }
      ]);
      if (applied) return "created";
    }
    throw new ExternalIntegrationError("mcp_outcome_unknown", "capture_quota_reservation_outcome_unknown", false);
  }

  async releaseCapture(input: CaptureRecordRelease): Promise<boolean> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const record = await this.getRecord("raw_external_record", input.recordId);
      if (!record) return false;
      const recordVersion = await this.getRecordVersion("raw_external_record", input.recordId);
      const quotaId = `capture_quota:${record.workspace_id}:${record.connection_id}`;
      const quota = await this.getRecord("capture_quota_usage", quotaId);
      const quotaVersion = await this.getRecordVersion("capture_quota_usage", quotaId);
      const mutations: ExternalIntegrationAtomicMutation[] = [{ kind: "delete", type: "raw_external_record", id: record.id, ...(recordVersion ? { expectedVersion: recordVersion } : {}) }];
      if (quota && quotaVersion) {
        mutations.push({
          kind: "update",
          type: "capture_quota_usage",
          id: quota.id,
          expectedVersion: quotaVersion,
          record: { ...quota, used_bytes: Math.max(0, quota.used_bytes - record.size_bytes), updated_at: new Date().toISOString() }
        });
      }
      if (input.auditEvent) mutations.push({ kind: "create", type: "audit_event", record: input.auditEvent });
      if (await this.atomic(mutations)) return true;
    }
    throw new ExternalIntegrationError("mcp_outcome_unknown", "capture_release_outcome_unknown", false);
  }

  private async withSql<T>(
    action: (sql: WorkspaceSql, workspaceId?: string) => Promise<T>,
    workspaceOverride?: string
  ): Promise<T> {
    const context = currentPostgresExternalIntegrationContext();
    const workspaceId = workspaceOverride ?? context.workspaceId;
    if (context.workspaceId && workspaceId && context.workspaceId !== workspaceId) throw new ExternalIntegrationError("connection_not_found");
    return this.database.withContext({
      accountId: context.accountId ?? "external-integration",
      ...(workspaceId ? { workspaceId } : {}),
      externalIntegration: true
    }, (sql) => action(sql, workspaceId));
  }

  private async findExact(sql: WorkspaceSql, workspaceId: string | undefined, type: ExternalIntegrationRecordType, id: string): Promise<ExternalRecordRow | undefined> {
    const result = await sql.query<ExternalRecordRow>(
      `SELECT workspace_id, record_type, id, version, payload
       FROM workspace_external_integration_records
       WHERE workspace_id IS NOT DISTINCT FROM $1 AND record_type = $2 AND id = $3
       FOR UPDATE`,
      [workspaceId ?? null, type, id]
    );
    return result.rows[0];
  }

  private async lockRecordsOfType(sql: WorkspaceSql, workspaceId: string | undefined, type: ExternalIntegrationRecordType): Promise<void> {
    await sql.query(
      `SELECT id FROM workspace_external_integration_records
       WHERE workspace_id IS NOT DISTINCT FROM $1 AND record_type = $2
       FOR UPDATE`,
      [workspaceId ?? null, type]
    );
  }

  private async assertNoConflict(sql: WorkspaceSql, workspaceId: string | undefined, type: ExternalIntegrationRecordType, record: ExternalIntegrationRecordMap[ExternalIntegrationRecordType], excludeId?: string): Promise<void> {
    if (await this.hasConflict(sql, workspaceId, type, record, excludeId)) {
      throw externalRecordExists(type, recordId(type, record));
    }
  }

  private async hasConflict(sql: WorkspaceSql, workspaceId: string | undefined, type: ExternalIntegrationRecordType, record: ExternalIntegrationRecordMap[ExternalIntegrationRecordType], excludeId?: string): Promise<boolean> {
    if (![
      "approval_request", "activity_event", "room_binding", "connector_installation"
    ].includes(type)) return false;
    const result = await sql.query<ExternalRecordRow>(
      `SELECT id, version, payload, workspace_id, record_type
       FROM workspace_external_integration_records
       WHERE workspace_id IS NOT DISTINCT FROM $1 AND record_type = $2
       FOR UPDATE`,
      [workspaceId ?? null, type]
    );
    return result.rows.some((row) => {
      if (row.id === excludeId) return false;
      const candidate = parseExternalIntegrationRecord(type, jsonValue(row.payload)) as Record<string, unknown>;
      const next = record as Record<string, unknown>;
      if (type === "approval_request") return candidate.workspace_id === next.workspace_id && candidate.account_id === next.account_id && candidate.idempotency_key === next.idempotency_key;
      if (type === "activity_event") return candidate.identity_key === next.identity_key && candidate.workspace_id === next.workspace_id && candidate.connection_id === next.connection_id && candidate.account_id === next.account_id;
      if (type === "room_binding") return candidate.workspace_id === next.workspace_id && candidate.connection_id === next.connection_id && candidate.account_id === next.account_id && candidate.project_ref === next.project_ref;
      return next.enabled === true && !next.disabled_at && candidate.enabled === true && !candidate.disabled_at && candidate.workspace_id === next.workspace_id && candidate.connector_id === next.connector_id;
    });
  }
}

function recordWorkspace(record: unknown): string | undefined {
  const value = record && typeof record === "object" && !Array.isArray(record) ? (record as Record<string, unknown>).workspace_id : undefined;
  return typeof value === "string" && value.trim() ? value : undefined;
}

function recordWorkspaceIdFor(record: unknown): string | undefined {
  return recordWorkspace(record);
}

function assertContextWorkspace(current: string | undefined, target: string | undefined): void {
  if (current && target && current !== target) throw new ExternalIntegrationError("connection_not_found");
}

function jsonValue(value: unknown): unknown {
  if (typeof value === "string") {
    try { return JSON.parse(value); } catch { return value; }
  }
  return value;
}

function matchesRecord(record: unknown, input: { workspaceId?: string; connectionId?: string; connectorId?: string; accountId?: string; projectRef?: string; externalSessionId?: string }): boolean {
  if (!record || typeof record !== "object" || Array.isArray(record)) return false;
  const value = record as Record<string, unknown>;
  const event = value.event && typeof value.event === "object" && !Array.isArray(value.event)
    ? value.event as Record<string, unknown>
    : undefined;
  return (input.workspaceId === undefined || value.workspace_id === input.workspaceId)
    && (input.connectionId === undefined || value.connection_id === input.connectionId)
    && (input.connectorId === undefined || value.connector_id === input.connectorId || event?.connector_id === input.connectorId)
    && (input.accountId === undefined || value.account_id === input.accountId)
    && (input.projectRef === undefined || value.project_ref === input.projectRef)
    && (input.externalSessionId === undefined || value.external_session_id === input.externalSessionId || event?.external_session_id === input.externalSessionId);
}

function externalRecordExists(type: ExternalIntegrationRecordType, id: string): ExternalIntegrationError {
  return new ExternalIntegrationError("mcp_invalid_arguments", `external_record_exists:${type}:${id}`);
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === "23505");
}
