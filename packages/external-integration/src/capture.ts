import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import {
  CapturePolicySchema,
  ExternalIntegrationError,
  RawExternalRecordSchema,
  externalCaptureRecordKinds,
  type CapturePolicy,
  type ExternalCaptureAvailability,
  type ExternalCaptureRecordKind,
  type ExternalIntegrationStore,
  type RawExternalRecord
} from "./contracts.js";
import { appendAuditEvent, createAuditEvent } from "./audit.js";

export interface CaptureServiceOptions {
  store: ExternalIntegrationStore;
  encryptionKey?: Buffer;
  /** Stable key id allows controlled key rotation without silently using the
   * wrong key for an older encrypted Capture record. */
  encryptionKeyId?: string;
  decryptionKeys?: Readonly<Record<string, Buffer>>;
  authorization?: CaptureAuthorizationPort;
  now?: () => Date;
  random?: (bytes: number) => Buffer;
}

export interface CaptureAuthorizationPort {
  assertRead(input: { workspaceId: string; connectionId: string; accountId: string; roomId: string }): Promise<void>;
  assertDelete(input: { workspaceId: string; connectionId: string; accountId: string; roomId: string }): Promise<void>;
}

export interface CaptureRetentionWorkerOptions {
  capture: CaptureService;
  intervalMs?: number;
  onError?: (error: unknown) => void;
}

/** Runs Capture retention independently from Activity/Knowledge processing.
 * A failed cleanup never stops the rest of the Server. */
export class CaptureRetentionWorker {
  private readonly intervalMs: number;
  private readonly onError: (error: unknown) => void;
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(private readonly options: CaptureRetentionWorkerOptions) {
    this.intervalMs = Number.isFinite(options.intervalMs) && (options.intervalMs ?? 0) > 0
      ? Math.max(1_000, Math.floor(options.intervalMs as number))
      : 60 * 60 * 1_000;
    this.onError = options.onError ?? (() => undefined);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.run();
    }, this.intervalMs);
    this.timer.unref?.();
    void this.run();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async run(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      return await this.options.capture.purgeExpired();
    } catch (error) {
      this.onError(error);
      return 0;
    } finally {
      this.running = false;
    }
  }
}

export interface SaveCaptureInput {
  workspaceId: string;
  connectionId: string;
  accountId: string;
  projectRef?: string;
  externalSessionId: string;
  roomId: string;
  kind: ExternalCaptureRecordKind;
  /** Provider event identity supplied by an Adapter.  It gives retry-safe
   * hooks a deterministic Capture record without storing the raw event. */
  recordId?: string;
  text?: string;
  payload?: unknown;
  connectorFullCapture: "supported" | "partial" | "unsupported";
  signal?: AbortSignal;
  /** Internal request control. Capture quota reservation is the first durable
   * write; callers use this callback to distinguish cancellation before and
   * after that boundary. */
  markWriteStarted?: () => void;
}

export interface CaptureResult {
  availability: ExternalCaptureAvailability;
  record?: RawExternalRecord;
  missingReason?: string;
}

export interface CaptureExportItem {
  id: string;
  kind: ExternalCaptureRecordKind;
  text: string;
  createdAt: string;
}

export interface CaptureExportPage {
  items: CaptureExportItem[];
  nextCursor?: string;
}

/** Optional capture is isolated from Activity and Knowledge. Plaintext never
 * enters the record store; it is redacted before AES-256-GCM encryption. */
export class CaptureService {
  private readonly now: () => Date;
  private readonly random: (bytes: number) => Buffer;

  constructor(private readonly options: CaptureServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.random = options.random ?? randomBytes;
    if (options.encryptionKey && options.encryptionKey.length !== 32) {
      throw new ExternalIntegrationError("capture_policy_invalid", "capture_encryption_key_must_be_32_bytes");
    }
    for (const key of Object.values(options.decryptionKeys ?? {})) {
      if (key.length !== 32) throw new ExternalIntegrationError("capture_policy_invalid", "capture_decryption_key_must_be_32_bytes");
    }
  }

  async getPolicy(input: { workspaceId: string; connectionId: string; accountId: string }): Promise<CapturePolicy | undefined> {
    return (await this.options.store.listRecords("capture_policy", input))[0];
  }

  async savePolicy(input: Omit<CapturePolicy, "updated_at"> & { updatedAt?: string }): Promise<CapturePolicy> {
    const { updatedAt, ...policyInput } = input;
    const policy = CapturePolicySchema.parse({
      ...policyInput,
      updated_at: updatedAt ?? this.now().toISOString()
    });
    const current = await this.getPolicy({ workspaceId: policy.workspace_id, connectionId: policy.connection_id, accountId: policy.account_id });
    if (!current) {
      const saved = await this.options.store.createRecord("capture_policy", policy);
      await appendAuditEvent(this.options.store, { eventType: "capture.policy.created", workspaceId: policy.workspace_id, connectionId: policy.connection_id, accountId: policy.account_id, resourceType: "capture_policy", resourceId: saved.id, data: { enabled: saved.enabled, retention_days: saved.retention_days, quota_bytes: saved.quota_bytes, redaction_policy_version: saved.redaction_policy_version } });
      return saved;
    }
    const version = await this.options.store.getRecordVersion("capture_policy", current.id);
    if (!version || !await this.options.store.updateRecord("capture_policy", current.id, version, policy)) {
      throw new ExternalIntegrationError("capture_policy_invalid", "capture_policy_version_conflict");
    }
    await appendAuditEvent(this.options.store, { eventType: "capture.policy.updated", workspaceId: policy.workspace_id, connectionId: policy.connection_id, accountId: policy.account_id, resourceType: "capture_policy", resourceId: policy.id, data: { enabled: policy.enabled, retention_days: policy.retention_days, quota_bytes: policy.quota_bytes, redaction_policy_version: policy.redaction_policy_version } });
    return policy;
  }

  async save(input: SaveCaptureInput): Promise<CaptureResult> {
    throwIfAborted(input.signal);
    const policy = await this.getPolicy({ workspaceId: input.workspaceId, connectionId: input.connectionId, accountId: input.accountId });
    if (!policy || !policy.enabled || !policy[policyKey(input.kind)]) {
      return { availability: "disabled", missingReason: "capture_disabled_by_default" };
    }
    if (input.connectorFullCapture === "unsupported") {
      return { availability: "unsupported", missingReason: "connector_does_not_expose_capture" };
    }
    if (!this.options.encryptionKey) {
      return { availability: "disabled", missingReason: "capture_key_not_configured" };
    }
    const redacted = capturePlaintext(input);
    throwIfAborted(input.signal);
    const currentBytes = await this.currentBytes(input);
    const quotaRemaining = Math.max(0, policy.quota_bytes - currentBytes);
    if (quotaRemaining <= 0) return { availability: "quota_exceeded", missingReason: "capture_quota_exceeded" };
    const maxBytes = Math.min(Buffer.byteLength(redacted, "utf8"), quotaRemaining);
    const truncated = maxBytes < Buffer.byteLength(redacted, "utf8");
    const body = Buffer.from(redacted, "utf8").subarray(0, maxBytes).toString("utf8");
    if (body.length === 0) return { availability: "quota_exceeded", missingReason: "capture_quota_exceeded" };
    const encrypted = encrypt(body, this.options.encryptionKey, this.random);
    const now = this.now();
    const record = RawExternalRecordSchema.parse({
      id: input.recordId ?? `raw_${this.random(16).toString("hex")}`,
      workspace_id: input.workspaceId,
      connection_id: input.connectionId,
      account_id: input.accountId,
      ...(input.projectRef ? { project_ref: input.projectRef } : {}),
      external_session_id: input.externalSessionId,
      room_id: input.roomId,
      kind: input.kind,
      encrypted_payload: encrypted.payload,
      iv: encrypted.iv,
      auth_tag: encrypted.authTag,
      key_id: this.keyId(),
      content_hash: createHash("sha256").update(body).digest("hex"),
      size_bytes: Buffer.byteLength(body, "utf8"),
      created_at: now.toISOString(),
      delete_at: new Date(now.getTime() + policy.retention_days * 24 * 60 * 60 * 1000).toISOString(),
      availability: truncated || input.connectorFullCapture === "partial" ? "partial" : "captured",
      truncated,
      ...(truncated ? { missing_reason: "capture_quota_remaining" } : {})
    });
    const duplicate = await this.options.store.getRecord("raw_external_record", record.id);
    if (duplicate) return sameCapture(duplicate, record);
    throwIfAborted(input.signal);
    input.markWriteStarted?.();
    let reservation: "created" | "quota_exceeded";
    try {
      reservation = await this.options.store.reserveCapture({ record, quotaBytes: policy.quota_bytes });
    } catch (error) {
      // A concurrent replay may lose the unique record-id race after the
      // lookup above.  Re-read it and distinguish a true duplicate from a
      // different payload attempting to reuse the same Provider event.
      const raced = await this.options.store.getRecord("raw_external_record", record.id);
      if (raced) return sameCapture(raced, record);
      throw error;
    }
    if (reservation === "quota_exceeded") return { availability: "quota_exceeded", missingReason: "capture_quota_exceeded" };
    try {
      await appendAuditEvent(this.options.store, { eventType: "capture.record.created", actorId: record.account_id, workspaceId: record.workspace_id, connectionId: record.connection_id, accountId: record.account_id, resourceType: "raw_external_record", resourceId: record.id, data: { kind: record.kind, size_bytes: record.size_bytes, availability: record.availability, delete_at: record.delete_at, ...(record.project_ref ? { project_ref: record.project_ref } : {}) } });
    } catch {
      throw new ExternalIntegrationError("mcp_outcome_unknown", "capture_audit_outcome_unknown", false);
    }
    if (input.signal?.aborted) throw new ExternalIntegrationError("mcp_outcome_unknown", "capture_write_outcome_unknown", false);
    return {
      availability: record.availability,
      record
    };
  }

  decrypt(record: RawExternalRecord): string {
    const key = this.decryptionKey(record.key_id);
    if (!key) throw new ExternalIntegrationError("capture_policy_invalid", "capture_key_not_available");
    return decrypt(record, key);
  }

  async delete(input: { recordId: string; workspaceId: string; connectionId: string; accountId: string; roomId: string }): Promise<boolean> {
    const record = await this.options.store.getRecord("raw_external_record", input.recordId);
    if (!record) return false;
    if (record.workspace_id !== input.workspaceId || record.connection_id !== input.connectionId || record.account_id !== input.accountId || record.room_id !== input.roomId) {
      throw new ExternalIntegrationError("mcp_auth_required", "capture_record_scope_mismatch");
    }
    await this.requireAuthorization("delete", input);
    const deleted = await this.options.store.releaseCapture({
      recordId: input.recordId,
      auditEvent: createAuditEvent({ eventType: "capture.record.deleted", actorId: input.accountId, workspaceId: record.workspace_id, connectionId: record.connection_id, accountId: input.accountId, resourceType: "raw_external_record", resourceId: input.recordId, data: { reason: "user_requested" } })
    });
    return deleted;
  }

  async purgeExpired(at: Date = this.now()): Promise<number> {
    const records = await this.options.store.listRecords("raw_external_record");
    let deleted = 0;
    for (const record of records) {
      if (new Date(record.delete_at).getTime() <= at.getTime() && await this.options.store.releaseCapture({
        recordId: record.id,
        auditEvent: createAuditEvent({ eventType: "capture.record.retention_deleted", actorId: "retention_worker", workspaceId: record.workspace_id, connectionId: record.connection_id, accountId: record.account_id, resourceType: "raw_external_record", resourceId: record.id, data: { reason: "retention_expired", delete_at: record.delete_at } })
      })) deleted += 1;
    }
    return deleted;
  }

  async export(input: { workspaceId: string; connectionId: string; accountId: string; projectRef?: string; externalSessionId?: string; roomId?: string }): Promise<CaptureExportItem[]> {
    const items: CaptureExportItem[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.exportPage({ ...input, cursor, limit: 100 });
      items.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    return items;
  }

  /** Bounded export for the human-only HTTP boundary. The cursor carries the
   * immutable scope and last record position, so it cannot be replayed for a
   * different Workspace, Connection, Room, or external Session. */
  async exportPage(input: { workspaceId: string; connectionId: string; accountId: string; projectRef?: string; externalSessionId?: string; roomId?: string; cursor?: string; limit?: number }): Promise<CaptureExportPage> {
    const limit = input.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ExternalIntegrationError("mcp_invalid_arguments", "capture_export_limit_invalid");
    const scope = captureExportScope(input);
    const position = input.cursor ? parseCaptureExportCursor(input.cursor, scope) : undefined;
    const records = await this.options.store.listRecords("raw_external_record", {
      workspaceId: input.workspaceId,
      connectionId: input.connectionId,
      ...(input.projectRef ? { projectRef: input.projectRef } : {}),
      ...(input.externalSessionId ? { externalSessionId: input.externalSessionId } : {})
    });
    const scoped = (input.roomId ? records.filter((record) => record.room_id === input.roomId) : records)
      .filter((record) => record.account_id === input.accountId)
      .sort((left, right) => right.created_at.localeCompare(left.created_at) || right.id.localeCompare(left.id));
    const afterCursor = position
      ? scoped.filter((record) => record.created_at < position.createdAt || (record.created_at === position.createdAt && record.id < position.id))
      : scoped;
    const selected = afterCursor.slice(0, limit);
    for (const record of selected) {
      await this.requireAuthorization("read", {
        workspaceId: input.workspaceId,
        connectionId: input.connectionId,
        accountId: input.accountId,
        roomId: record.room_id
      });
    }
    const last = selected.at(-1);
    return {
      items: selected.map((record) => ({ id: record.id, kind: record.kind, text: this.decrypt(record), createdAt: record.created_at })),
      ...(last && afterCursor.length > selected.length ? { nextCursor: createCaptureExportCursor(scope, last) } : {})
    };
  }

  private async requireAuthorization(action: "read" | "delete", input: { workspaceId: string; connectionId: string; accountId: string; roomId: string }): Promise<void> {
    if (!this.options.authorization) throw new ExternalIntegrationError("mcp_auth_required", "capture_authorization_unconfigured");
    if (action === "read") return this.options.authorization.assertRead(input);
    return this.options.authorization.assertDelete(input);
  }

  private async currentBytes(input: SaveCaptureInput): Promise<number> {
    const records = await this.options.store.listRecords("raw_external_record", { workspaceId: input.workspaceId, connectionId: input.connectionId });
    return records.reduce((sum, record) => sum + record.size_bytes, 0);
  }

  private keyId(): string {
    return this.options.encryptionKeyId ?? "default";
  }

  private decryptionKey(keyId: string): Buffer | undefined {
    if (keyId === this.keyId()) return this.options.encryptionKey;
    return this.options.decryptionKeys?.[keyId];
  }
}

function sameCapture(existing: RawExternalRecord, requested: RawExternalRecord): CaptureResult {
  if (
    existing.workspace_id !== requested.workspace_id
    || existing.connection_id !== requested.connection_id
    || existing.account_id !== requested.account_id
    || existing.project_ref !== requested.project_ref
    || existing.external_session_id !== requested.external_session_id
    || existing.room_id !== requested.room_id
    || existing.kind !== requested.kind
    || existing.content_hash !== requested.content_hash
  ) {
    throw new ExternalIntegrationError("activity_event_conflict", "capture_event_payload_changed");
  }
  return { availability: existing.availability, record: existing, ...(existing.missing_reason ? { missingReason: existing.missing_reason } : {}) };
}

function policyKey(kind: ExternalCaptureRecordKind): "conversation" | "terminal" | "intermediate_log" {
  if (!externalCaptureRecordKinds.includes(kind)) throw new ExternalIntegrationError("capture_policy_invalid");
  return kind;
}

export function redactExternalText(text: string): string {
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    // Free-text Hooks can contain a JSON string rather than a parsed object.
    // Match quoted and unquoted JSON-like secret fields before the generic
    // key=value rule so `{"access_token":"..."}` cannot survive Capture.
    .replace(/(["']?\b(?:api[_-]?key|apiKey|access[_-]?token|accessToken|refresh[_-]?token|refreshToken|client[_-]?secret|clientSecret|authorization|cookie|password|secret|token|private[_-]?key|privateKey)\b["']?\s*:\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^,}\s]+)/gi, "$1[REDACTED]")
    .replace(/(api[_-]?key|apiKey|access[_-]?token|accessToken|refresh[_-]?token|refreshToken|client[_-]?secret|clientSecret|authorization|cookie|password|secret|token|private[_-]?key|privateKey)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .replace(/-----BEGIN [^-]+ PRIVATE KEY-----[\s\S]*?-----END [^-]+ PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]")
    .replace(/Cookie:\s*[^\r\n]+/gi, "Cookie: [REDACTED]")
    .replace(/(?:^|\n)([A-Z][A-Z0-9_]{2,})=(?!\[REDACTED\])[^\n]*/g, "$1=[REDACTED]");
}

/** Redacts structured hook payloads before they are serialized. Matching on
 * field name complements free-text redaction so JSON secrets do not survive
 * merely because their value has no conventional `key=value` spelling. */
export function redactExternalValue(value: unknown, key = ""): unknown {
  if (/(token|secret|password|authorization|cookie|private.?key|api.?key)/i.test(key)) return "[REDACTED]";
  if (typeof value === "string") return redactExternalText(value);
  if (Array.isArray(value)) return value.map((item) => redactExternalValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([entryKey, entry]) => [entryKey, redactExternalValue(entry, entryKey)]));
  }
  return value;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new ExternalIntegrationError("mcp_cancelled", "mcp_request_cancelled", true);
}

function capturePlaintext(input: SaveCaptureInput): string {
  if (typeof input.text === "string" && input.payload === undefined) return redactExternalText(input.text);
  if (input.text === undefined && input.payload !== undefined) return JSON.stringify(redactExternalValue(input.payload));
  throw new ExternalIntegrationError("mcp_invalid_arguments", "capture_requires_exactly_one_of_text_or_payload");
}

function encrypt(value: string, key: Buffer, random: (bytes: number) => Buffer): { payload: string; iv: string; authTag: string } {
  const iv = random(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const payload = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return { payload: payload.toString("base64url"), iv: iv.toString("base64url"), authTag: cipher.getAuthTag().toString("base64url") };
}

function decrypt(record: RawExternalRecord, key: Buffer): string {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(record.iv, "base64url"));
  decipher.setAuthTag(Buffer.from(record.auth_tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(record.encrypted_payload, "base64url")), decipher.final()]).toString("utf8");
}

type CaptureExportScope = {
  workspace_id: string;
  connection_id: string;
  account_id: string;
  project_ref: string | null;
  external_session_id: string | null;
  room_id: string | null;
};

function captureExportScope(input: { workspaceId: string; connectionId: string; accountId: string; projectRef?: string; externalSessionId?: string; roomId?: string }): CaptureExportScope {
  return {
    workspace_id: input.workspaceId,
    connection_id: input.connectionId,
    account_id: input.accountId,
    project_ref: input.projectRef ?? null,
    external_session_id: input.externalSessionId ?? null,
    room_id: input.roomId ?? null
  };
}

function createCaptureExportCursor(scope: CaptureExportScope, record: RawExternalRecord): string {
  return Buffer.from(JSON.stringify({ version: 1, scope, created_at: record.created_at, id: record.id }), "utf8").toString("base64url");
}

function parseCaptureExportCursor(value: string, expectedScope: CaptureExportScope): { createdAt: string; id: string } {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as {
      version?: unknown;
      scope?: unknown;
      created_at?: unknown;
      id?: unknown;
    };
    if (parsed.version !== 1 || typeof parsed.created_at !== "string" || typeof parsed.id !== "string" || JSON.stringify(parsed.scope) !== JSON.stringify(expectedScope)) {
      throw new Error("capture_export_cursor_invalid");
    }
    return { createdAt: parsed.created_at, id: parsed.id };
  } catch {
    throw new ExternalIntegrationError("mcp_invalid_arguments", "capture_export_cursor_invalid");
  }
}
