import {
  ApprovalRequestSchema,
  AuditEventSchema,
  CapturePolicySchema,
  CaptureQuotaUsageSchema,
  ConnectorEventSchema,
  ConnectorInstallationSchema,
  ConnectorManifestSchema,
  ContextSnapshotSchema,
  ExternalIntegrationError,
  hashCanonicalJson,
  ExternalIntegrationRecordType,
  ExternalIntegrationStore,
  ExternalSessionRecordSchema,
  OAuthAuthorizationCodeSchema,
  OAuthAuthorizationRequestSchema,
  OAuthClientRegistrationSchema,
  OAuthGrantSchema,
  RawExternalRecordSchema,
  RoomBindingSchema,
  type ExternalIntegrationRecordMap
} from "./contracts.js";

export interface VersionedExternalRecord<K extends ExternalIntegrationRecordType> {
  record: ExternalIntegrationRecordMap[K];
  version: number;
}

/** In-process store used by contract tests and by embedders that provide their
 * own durable repository. It still implements compare-and-swap so tests cannot
 * accidentally bless a racy approval or token rotation implementation. */
export class MemoryExternalIntegrationStore implements ExternalIntegrationStore {
  private readonly records = new Map<string, { record: unknown; version: number }>();

  async getRecord<K extends ExternalIntegrationRecordType>(type: K, id: string): Promise<ExternalIntegrationRecordMap[K] | undefined> {
    const value = this.records.get(key(type, id));
    return value ? parseExternalIntegrationRecord(type, value.record) : undefined;
  }

  async getRecordVersion(type: ExternalIntegrationRecordType, id: string): Promise<number | undefined> {
    return this.records.get(key(type, id))?.version;
  }

  async listRecords<K extends ExternalIntegrationRecordType>(type: K, input: {
    workspaceId?: string;
    connectionId?: string;
    connectorId?: string;
    accountId?: string;
    projectRef?: string;
    externalSessionId?: string;
  } = {}): Promise<ExternalIntegrationRecordMap[K][]> {
    const result: ExternalIntegrationRecordMap[K][] = [];
    for (const [recordKey, value] of this.records.entries()) {
      if (!recordKey.startsWith(`${type}:`)) continue;
      const record = parseExternalIntegrationRecord(type, value.record);
      if (!matches(record, input)) continue;
      result.push(record);
    }
    return result;
  }

  async createRecord<K extends ExternalIntegrationRecordType>(type: K, record: ExternalIntegrationRecordMap[K]): Promise<ExternalIntegrationRecordMap[K]> {
    const parsed = parseExternalIntegrationRecord(type, record);
    const recordKey = key(type, recordId(type, parsed));
    if (this.records.has(recordKey)) throw new ExternalIntegrationError("mcp_invalid_arguments", `external_record_exists:${recordKey}`);
    if (type === "approval_request") {
      const candidate = parsed as ExternalIntegrationRecordMap["approval_request"];
      for (const [recordKey, value] of this.records) {
        if (!recordKey.startsWith("approval_request:")) continue;
        const existing = parseExternalIntegrationRecord("approval_request", value.record);
        if (existing.workspace_id === candidate.workspace_id
          && existing.account_id === candidate.account_id
          && existing.idempotency_key === candidate.idempotency_key) {
          throw new ExternalIntegrationError("mcp_invalid_arguments", `external_record_exists:approval_idempotency:${candidate.workspace_id}:${candidate.account_id}:${candidate.idempotency_key}`);
        }
      }
    }
    if (type === "activity_event") {
      const candidate = parsed as ExternalIntegrationRecordMap["activity_event"];
      for (const [recordKey, value] of this.records) {
        if (!recordKey.startsWith("activity_event:")) continue;
        const existing = parseExternalIntegrationRecord("activity_event", value.record);
        if (existing.identity_key === candidate.identity_key
          && existing.workspace_id === candidate.workspace_id
          && existing.connection_id === candidate.connection_id
          && existing.account_id === candidate.account_id) {
          throw new ExternalIntegrationError("mcp_invalid_arguments", `external_record_exists:activity_identity:${candidate.identity_key}`);
        }
      }
    }
    if (type === "room_binding") {
      const candidate = parsed as ExternalIntegrationRecordMap["room_binding"];
      for (const [recordKey, value] of this.records) {
        if (!recordKey.startsWith("room_binding:")) continue;
        const existing = parseExternalIntegrationRecord("room_binding", value.record);
        if (existing.workspace_id === candidate.workspace_id
          && existing.connection_id === candidate.connection_id
          && existing.account_id === candidate.account_id
          && existing.project_ref === candidate.project_ref) {
          throw new ExternalIntegrationError("mcp_invalid_arguments", `external_record_exists:room_binding:${candidate.workspace_id}:${candidate.connection_id}:${candidate.account_id}:${candidate.project_ref}`);
        }
      }
    }
    if (type === "connector_installation") {
      const candidate = parsed as ExternalIntegrationRecordMap["connector_installation"];
      for (const [recordKey, value] of this.records) {
        if (!recordKey.startsWith("connector_installation:") || !candidate.enabled) continue;
        const existing = parseExternalIntegrationRecord("connector_installation", value.record);
        if (candidate.enabled && !candidate.disabled_at && existing.enabled && !existing.disabled_at
          && existing.workspace_id === candidate.workspace_id
          && existing.connector_id === candidate.connector_id) {
          throw new ExternalIntegrationError("mcp_invalid_arguments", `external_record_exists:connector_installation:${candidate.workspace_id}:${candidate.connector_id}`);
        }
      }
    }
    this.records.set(recordKey, { record: parsed, version: 1 });
    return parsed;
  }

  async updateRecord<K extends ExternalIntegrationRecordType>(type: K, id: string, expectedVersion: number, record: ExternalIntegrationRecordMap[K]): Promise<boolean> {
    const existing = this.records.get(key(type, id));
    if (!existing || existing.version !== expectedVersion) return false;
    const parsed = parseExternalIntegrationRecord(type, record);
    if (recordId(type, parsed) !== id) throw new ExternalIntegrationError("mcp_invalid_arguments", "external_record_id_immutable");
    this.records.set(key(type, id), { record: parsed, version: expectedVersion + 1 });
    return true;
  }

  async deleteRecord(type: ExternalIntegrationRecordType, id: string): Promise<boolean> {
    return this.records.delete(key(type, id));
  }

  async atomic(mutations: readonly import("./contracts.js").ExternalIntegrationAtomicMutation[]): Promise<boolean> {
    const next = new Map(this.records);
    for (const mutation of mutations) {
      const recordKey = key(mutation.type, mutation.kind === "create" ? recordId(mutation.type, mutation.record as never) : mutation.id);
      const current = next.get(recordKey);
      if (mutation.kind === "create") {
        if (current) return false;
        const record = parseExternalIntegrationRecord(mutation.type, mutation.record);
        if (mutation.type === "approval_request") {
          const candidate = record as ExternalIntegrationRecordMap["approval_request"];
          const conflict = [...next.entries()]
            .filter(([recordKey]) => recordKey.startsWith("approval_request:"))
            .map(([, value]) => parseExternalIntegrationRecord("approval_request", value.record))
            .some((existing) => existing.workspace_id === candidate.workspace_id
              && existing.account_id === candidate.account_id
              && existing.idempotency_key === candidate.idempotency_key);
          if (conflict) return false;
        }
        if (mutation.type === "activity_event") {
          const candidate = record as ExternalIntegrationRecordMap["activity_event"];
          const conflict = [...next.entries()]
            .filter(([recordKey]) => recordKey.startsWith("activity_event:"))
            .map(([, value]) => parseExternalIntegrationRecord("activity_event", value.record))
            .some((existing) => existing.identity_key === candidate.identity_key
              && existing.workspace_id === candidate.workspace_id
              && existing.connection_id === candidate.connection_id
              && existing.account_id === candidate.account_id);
          if (conflict) return false;
        }
        if (mutation.type === "room_binding") {
          const candidate = record as ExternalIntegrationRecordMap["room_binding"];
          const conflict = [...next.entries()]
            .filter(([recordKey]) => recordKey.startsWith("room_binding:"))
            .map(([, value]) => parseExternalIntegrationRecord("room_binding", value.record))
            .some((existing) => existing.workspace_id === candidate.workspace_id
              && existing.connection_id === candidate.connection_id
              && existing.account_id === candidate.account_id
              && existing.project_ref === candidate.project_ref);
          if (conflict) return false;
        }
        if (mutation.type === "connector_installation") {
          const candidate = record as ExternalIntegrationRecordMap["connector_installation"];
          const activeConflict = [...next.entries()]
            .filter(([recordKey]) => recordKey.startsWith("connector_installation:"))
            .map(([, value]) => parseExternalIntegrationRecord("connector_installation", value.record))
            .some((existing) => existing.enabled && !existing.disabled_at
              && existing.workspace_id === candidate.workspace_id
              && existing.connector_id === candidate.connector_id);
          if (candidate.enabled && !candidate.disabled_at && activeConflict) return false;
        }
        next.set(recordKey, { record, version: 1 });
        continue;
      }
      if (mutation.kind === "update") {
        if (!current || current.version !== mutation.expectedVersion) return false;
        const record = parseExternalIntegrationRecord(mutation.type, mutation.record);
        if (recordId(mutation.type, record) !== mutation.id) throw new ExternalIntegrationError("mcp_invalid_arguments", "external_record_id_immutable");
        if (mutation.type === "connector_installation") {
          const candidate = record as ExternalIntegrationRecordMap["connector_installation"];
          const activeConflict = [...next.entries()]
            .filter(([candidateKey]) => candidateKey.startsWith("connector_installation:") && candidateKey !== recordKey)
            .map(([, value]) => parseExternalIntegrationRecord("connector_installation", value.record))
            .some((existing) => existing.enabled && !existing.disabled_at
              && existing.workspace_id === candidate.workspace_id
              && existing.connector_id === candidate.connector_id);
          if (candidate.enabled && !candidate.disabled_at && activeConflict) return false;
        }
        next.set(recordKey, { record, version: current.version + 1 });
        continue;
      }
      if (!current || (mutation.expectedVersion !== undefined && current.version !== mutation.expectedVersion)) return false;
      next.delete(recordKey);
    }
    this.records.clear();
    for (const [recordKey, value] of next) this.records.set(recordKey, value);
    return true;
  }

  async reserveCapture(input: import("./contracts.js").CaptureQuotaReservation): Promise<"created" | "quota_exceeded"> {
    const quotaId = captureQuotaId(input.record.workspace_id, input.record.connection_id);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const duplicate = await this.getRecord("raw_external_record", input.record.id);
      if (duplicate) {
        throw new ExternalIntegrationError("mcp_invalid_arguments", `external_record_exists:raw_external_record:${input.record.id}`);
      }
      const current = await this.getRecord("capture_quota_usage", quotaId);
      const currentVersion = await this.getRecordVersion("capture_quota_usage", quotaId);
      const existingBytes = current?.used_bytes ?? (await this.listRecords("raw_external_record", {
        workspaceId: input.record.workspace_id,
        connectionId: input.record.connection_id
      })).reduce((total, record) => total + record.size_bytes, 0);
      if (existingBytes + input.record.size_bytes > input.quotaBytes) return "quota_exceeded";
      const quota = CaptureQuotaUsageSchema.parse({
        id: quotaId,
        workspace_id: input.record.workspace_id,
        connection_id: input.record.connection_id,
        used_bytes: existingBytes + input.record.size_bytes,
        updated_at: input.record.created_at
      });
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

  async releaseCapture(input: import("./contracts.js").CaptureRecordRelease): Promise<boolean> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const record = await this.getRecord("raw_external_record", input.recordId);
      if (!record) return false;
      const recordVersion = await this.getRecordVersion("raw_external_record", input.recordId);
      const quotaId = captureQuotaId(record.workspace_id, record.connection_id);
      const quota = await this.getRecord("capture_quota_usage", quotaId);
      const quotaVersion = await this.getRecordVersion("capture_quota_usage", quotaId);
      const mutations: import("./contracts.js").ExternalIntegrationAtomicMutation[] = [{ kind: "delete", type: "raw_external_record", id: record.id, ...(recordVersion ? { expectedVersion: recordVersion } : {}) }];
      if (quota && quotaVersion) {
        mutations.push({ kind: "update", type: "capture_quota_usage", id: quota.id, expectedVersion: quotaVersion, record: { ...quota, used_bytes: Math.max(0, quota.used_bytes - record.size_bytes), updated_at: new Date().toISOString() } });
      }
      if (input.auditEvent) mutations.push({ kind: "create", type: "audit_event", record: input.auditEvent });
      if (await this.atomic(mutations)) return true;
    }
    const remaining = await this.getRecord("raw_external_record", input.recordId);
    if (!remaining) return false;
    throw new ExternalIntegrationError("mcp_outcome_unknown", "capture_release_outcome_unknown", false);
  }
}

export function recordId<K extends ExternalIntegrationRecordType>(type: K, record: ExternalIntegrationRecordMap[K]): string {
  switch (type) {
    case "oauth_client": return (record as ExternalIntegrationRecordMap["oauth_client"]).client_id;
    case "oauth_authorization_request": return (record as ExternalIntegrationRecordMap["oauth_authorization_request"]).id;
    case "oauth_authorization_code": return (record as ExternalIntegrationRecordMap["oauth_authorization_code"]).id;
    case "oauth_grant": return (record as ExternalIntegrationRecordMap["oauth_grant"]).id;
    case "room_binding": return (record as ExternalIntegrationRecordMap["room_binding"]).id;
    case "external_session": return (record as ExternalIntegrationRecordMap["external_session"]).id;
    case "context_snapshot": return (record as ExternalIntegrationRecordMap["context_snapshot"]).id;
    case "approval_request": return (record as ExternalIntegrationRecordMap["approval_request"]).id;
    case "capture_policy": return (record as ExternalIntegrationRecordMap["capture_policy"]).id;
    case "raw_external_record": return (record as ExternalIntegrationRecordMap["raw_external_record"]).id;
    case "capture_quota_usage": return (record as ExternalIntegrationRecordMap["capture_quota_usage"]).id;
    case "connector_manifest": return (record as ExternalIntegrationRecordMap["connector_manifest"]).connector_id;
    case "connector_installation": return (record as ExternalIntegrationRecordMap["connector_installation"]).id;
    case "activity_event": return (record as ExternalIntegrationRecordMap["activity_event"]).id;
    case "audit_event": return (record as ExternalIntegrationRecordMap["audit_event"]).id;
  }
}

function key(type: ExternalIntegrationRecordType, id: string): string {
  return `${type}:${id}`;
}

export function parseExternalIntegrationRecord<K extends ExternalIntegrationRecordType>(type: K, value: unknown): ExternalIntegrationRecordMap[K] {
  switch (type) {
    case "oauth_client": return OAuthClientRegistrationSchema.parse(value) as ExternalIntegrationRecordMap[K];
    case "oauth_authorization_request": return OAuthAuthorizationRequestSchema.parse(value) as ExternalIntegrationRecordMap[K];
    case "oauth_authorization_code": return OAuthAuthorizationCodeSchema.parse(value) as ExternalIntegrationRecordMap[K];
    case "oauth_grant": return OAuthGrantSchema.parse(value) as ExternalIntegrationRecordMap[K];
    case "room_binding": return RoomBindingSchema.parse(value) as ExternalIntegrationRecordMap[K];
    case "external_session": return ExternalSessionRecordSchema.parse(value) as ExternalIntegrationRecordMap[K];
    case "context_snapshot": return ContextSnapshotSchema.parse(value) as ExternalIntegrationRecordMap[K];
    case "approval_request": return ApprovalRequestSchema.parse(value) as ExternalIntegrationRecordMap[K];
    case "capture_policy": return CapturePolicySchema.parse(value) as ExternalIntegrationRecordMap[K];
    case "raw_external_record": return RawExternalRecordSchema.parse(value) as ExternalIntegrationRecordMap[K];
    case "capture_quota_usage": return CaptureQuotaUsageSchema.parse(value) as ExternalIntegrationRecordMap[K];
    case "connector_manifest": return ConnectorManifestSchema.parse(value) as ExternalIntegrationRecordMap[K];
    case "connector_installation": return ConnectorInstallationSchema.parse(value) as ExternalIntegrationRecordMap[K];
    case "activity_event": return parseActivityEvent(value) as ExternalIntegrationRecordMap[K];
    case "audit_event": return AuditEventSchema.parse(value) as ExternalIntegrationRecordMap[K];
  }
}

function captureQuotaId(workspaceId: string, connectionId: string): string {
  return `capture_quota:${workspaceId}:${connectionId}`;
}

function parseActivityEvent(value: unknown): ExternalIntegrationRecordMap["activity_event"] {
  if (!value || typeof value !== "object") throw new ExternalIntegrationError("mcp_invalid_arguments", "activity_event_invalid");
  const candidate = value as Record<string, unknown>;
  const event = ConnectorEventSchema.parse(candidate.event);
  const identityKey = typeof candidate.identity_key === "string"
    ? candidate.identity_key
    : `${event.connector_id}:${event.connector_version}:${event.external_session_id}:${event.event_id}`;
  const payloadHash = typeof candidate.payload_hash === "string" ? candidate.payload_hash : hashCanonicalJson(event);
  return {
    id: String(candidate.id),
    identity_key: identityKey,
    payload_hash: payloadHash,
    dedupe_key: typeof candidate.dedupe_key === "string" ? candidate.dedupe_key : `${identityKey}:${payloadHash}`,
    created_at: String(candidate.created_at),
    ...(typeof candidate.workspace_id === "string" && candidate.workspace_id.trim() ? { workspace_id: candidate.workspace_id } : {}),
    ...(typeof candidate.connection_id === "string" && candidate.connection_id.trim() ? { connection_id: candidate.connection_id } : {}),
    ...(typeof candidate.account_id === "string" && candidate.account_id.trim() ? { account_id: candidate.account_id } : {}),
    ...(typeof candidate.project_ref === "string" && candidate.project_ref.trim() ? { project_ref: candidate.project_ref } : {}),
    event
  };
}

function matches(record: unknown, input: Record<string, string | undefined>): boolean {
  if (!record || typeof record !== "object") return false;
  const value = record as Record<string, unknown>;
  const keyMap: Record<string, string> = {
    workspaceId: "workspace_id",
    connectionId: "connection_id",
    connectorId: "connector_id",
    accountId: "account_id",
    projectRef: "project_ref",
    externalSessionId: "external_session_id"
  };
  return Object.entries(input).every(([keyName, expected]) => expected === undefined || value[keyMap[keyName] ?? keyName] === expected);
}
