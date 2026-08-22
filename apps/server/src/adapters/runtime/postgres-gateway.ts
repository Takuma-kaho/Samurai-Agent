import {
  GatewayBoundaryPolicySchema,
  GatewayConcurrencyLockRecordSchema,
  GatewayDeliveryRecordSchema,
  GatewayInboundMessageRecordSchema,
  GatewayMcpConfigRecordSchema,
  GatewayPairingPolicyRecordSchema,
  GatewayPairingRecordSchema,
  GatewayRepairResultSchema,
  GatewayRoutingPolicyRecordSchema,
  GatewaySandboxInstanceRecordSchema,
  GatewaySandboxWorkspaceSyncResultSchema,
  GatewaySandboxWorkspaceSyncRecordSchema,
  createId,
  nowIso,
  stableHash,
  type GatewayBoundaryPolicy,
  type GatewayConcurrencyLockRecord,
  type GatewayDeliveryRecord,
  type GatewayInboundMessageRecord,
  type GatewayMcpConfigRecord,
  type GatewayPairingPolicyRecord,
  type GatewayPairingRecord,
  type GatewayRepairAction,
  type GatewayRepairResult,
  type GatewayRoutingPolicyRecord,
  type GatewaySandboxInstanceRecord,
  type GatewaySandboxWorkspaceSyncDirection,
  type GatewaySandboxWorkspaceSyncResult,
  type GatewaySandboxWorkspaceSyncRecord,
  type JsonValue,
  type SupportedLocale
} from "@samurai-agent/core-schemas";
import {
  createDefaultGatewayPairingPolicy,
  createDefaultGatewayRoutingPolicy,
  type GatewayContext
} from "@samurai-agent/gateway";
import type { RunChatTurnResult } from "@samurai-agent/runtime";
import { PostgresWorkspaceDatabase, type WorkspaceSql } from "@samurai-agent/workspace-server";

interface GatewaySession {
  id: string;
  session_key: string;
  title: string;
  ui_locale: SupportedLocale;
  output_locale: SupportedLocale;
  created_at: string;
  updated_at: string;
}

type GatewayChatResult = RunChatTurnResult;

interface GatewayRunChatInput {
  sessionId: string;
  body: string;
  backendId?: string;
  inputLocale?: SupportedLocale;
  outputLocale?: SupportedLocale;
  metadata: Record<string, JsonValue>;
  context: GatewayContext;
  boundaryPolicy: GatewayBoundaryPolicy;
  idempotencyKey: string;
}

export interface GatewayInboundPort {
  expirePairings(): Promise<GatewayPairingRecord[]>;
  getRoutingPolicy(channel: GatewayRoutingPolicyRecord["channel"]): Promise<GatewayRoutingPolicyRecord>;
  getPairingPolicy(channel: GatewayPairingPolicyRecord["channel"]): Promise<GatewayPairingPolicyRecord>;
  saveInbound(record: GatewayInboundMessageRecord): Promise<GatewayInboundMessageRecord>;
  emit(name: string, payload: unknown): Promise<void>;
  findDuplicate(input: { channel: GatewayInboundMessageRecord["channel"]; sourceIdentity: string; body: string; windowMs: number; externalMessageId?: string }): Promise<GatewayInboundMessageRecord | undefined>;
  isRateLimited(input: { channel: GatewayInboundMessageRecord["channel"]; sourceIdentity: string; windowMs: number; maxMessages: number }): Promise<boolean>;
  findPairing(input: { channel: GatewayPairingRecord["channel"]; sourceIdentity: string; status: "approved" | "pending"; sessionKey: string }): Promise<GatewayPairingRecord | undefined>;
  getPairing(id: string): Promise<GatewayPairingRecord | undefined>;
  savePairing(record: GatewayPairingRecord): Promise<GatewayPairingRecord>;
  saveBoundaryPolicy(policy: GatewayBoundaryPolicy): Promise<GatewayBoundaryPolicy>;
  acquireLock(policy: GatewayBoundaryPolicy, inbound: GatewayInboundMessageRecord): Promise<{ acquired: boolean; lock: GatewayConcurrencyLockRecord }>;
  releaseLock(lockKey: string): Promise<void>;
  ensureSession(context: GatewayContext, title: string): Promise<GatewaySession>;
  runChat(input: GatewayRunChatInput): Promise<GatewayChatResult>;
  enqueueDeliveries(input: { channel: GatewayInboundMessageRecord["channel"]; inbound: GatewayInboundMessageRecord; sessionKey: string; chat: GatewayChatResult }): Promise<GatewayDeliveryRecord[]>;
  errorMessage(error: unknown): string;
  conflictError(message: string): Error;
}

export interface GatewayPolicyPersistencePort {
  getMcpConfig(id: string): Promise<GatewayMcpConfigRecord | undefined>;
  saveMcpConfig(record: GatewayMcpConfigRecord): Promise<GatewayMcpConfigRecord>;
  listPairingPolicies(): Promise<GatewayPairingPolicyRecord[]>;
  getPairingPolicy(channel: GatewayPairingPolicyRecord["channel"]): Promise<GatewayPairingPolicyRecord | undefined>;
  savePairingPolicy(record: GatewayPairingPolicyRecord): Promise<GatewayPairingPolicyRecord>;
  emitPairingPolicySaved(record: GatewayPairingPolicyRecord): Promise<void>;
  listRoutingPolicies(): Promise<GatewayRoutingPolicyRecord[]>;
  getRoutingPolicy(channel: GatewayRoutingPolicyRecord["channel"]): Promise<GatewayRoutingPolicyRecord | undefined>;
  saveRoutingPolicy(record: GatewayRoutingPolicyRecord): Promise<GatewayRoutingPolicyRecord>;
  emitRoutingPolicySaved(record: GatewayRoutingPolicyRecord): Promise<void>;
}

export interface GatewayPairingPort {
  get(id: string): Promise<GatewayPairingRecord | undefined>;
  save(record: GatewayPairingRecord): Promise<GatewayPairingRecord>;
  expireAll(now: string): Promise<GatewayPairingRecord[]>;
  emitUpdated(record: GatewayPairingRecord): Promise<void>;
}

export interface GatewayCommandPort {
  expireConcurrencyLocks(now?: string): Promise<GatewayConcurrencyLockRecord[]>;
  deleteSandbox(id: string): Promise<GatewaySandboxInstanceRecord>;
  recreateSandbox(id: string): Promise<GatewaySandboxInstanceRecord>;
  syncSandbox(id: string, input: { direction?: GatewaySandboxWorkspaceSyncDirection; dryRun: boolean }): Promise<GatewaySandboxWorkspaceSyncResult>;
  repairState(input: { dryRun: boolean; now?: string }): Promise<GatewayRepairResult>;
}

export interface GatewayDomainServiceDependencies {
  gateway: GatewayCommandPort;
  policy: GatewayPolicyPersistencePort;
  pairing: GatewayPairingPort;
  inbound: GatewayInboundPort;
  notFoundError: (message: string) => Error;
}

/** The adapter owns the tenant context. Callers cannot select a Workspace by
 * passing a record id; every query is still explicitly scoped for defence in depth. */
export interface PostgresGatewayDatabase {
  withContext<T>(
    context: { workspaceId: string; accountId: string },
    action: (sql: WorkspaceSql) => Promise<T>
  ): Promise<T>;
}

export interface PostgresGatewaySandboxExecutor {
  lifecycle(input: {
    action: "delete" | "recreate";
    instanceKey: string;
    sandbox: GatewaySandboxInstanceRecord["sandbox"];
    workspaceRoot?: string;
    metadata: Record<string, JsonValue>;
  }): Promise<{ status: "completed" | "failed" | "skipped"; reason?: string; error?: string; resourceRefs?: JsonValue[] }>;
  sync(input: {
    direction: GatewaySandboxWorkspaceSyncDirection;
    workspaceRoot?: string;
    remoteWorkspaceRoot?: string;
    timeoutMs?: number;
    sandbox: GatewaySandboxInstanceRecord["sandbox"];
    metadata: Record<string, JsonValue>;
  }): Promise<{ status: "completed" | "failed" | "skipped"; fileCount?: number; byteCount?: number; reason?: string; error?: string; resourceRefs?: JsonValue[] }>;
}

export interface PostgresGatewayAdapterOptions {
  database: PostgresGatewayDatabase | Pick<PostgresWorkspaceDatabase, "withContext">;
  workspaceId: string;
  accountId: string;
  /** Core owns Session, Chat, and Formal Ingress. Gateway only delegates to these ports. */
  core: Pick<GatewayInboundPort, "ensureSession" | "runChat">;
  emit: (name: string, payload: unknown) => Promise<void>;
  sandboxExecutor?: PostgresGatewaySandboxExecutor;
  notFoundError?: (message: string) => Error;
  conflictError?: (message: string) => Error;
  errorMessage?: (error: unknown) => string;
}

interface Row {
  workspace_id: string;
  [key: string]: unknown;
}

/**
 * PostgreSQL Gateway persistence and dependency composition.
 *
 * This class deliberately does not receive legacy persistence, a Core
 * filesystem, Connection authority, or Room membership. The paired-contact
 * fail-closed decision remains in GatewayDomainService; Session/Chat and
 * Sandbox execution are explicit ports supplied by the composition root.
 */
export class PostgresGatewayAdapter {
  private readonly database: PostgresGatewayDatabase;
  private readonly workspaceId: string;
  private readonly accountId: string;
  private readonly core: Pick<GatewayInboundPort, "ensureSession" | "runChat">;
  private readonly emitEvent: PostgresGatewayAdapterOptions["emit"];
  private readonly sandboxExecutor?: PostgresGatewaySandboxExecutor;
  private readonly notFoundError: (message: string) => Error;
  private readonly conflictError: (message: string) => Error;
  private readonly errorMessage: (error: unknown) => string;

  constructor(options: PostgresGatewayAdapterOptions) {
    if (!options.workspaceId.trim()) throw new Error("gateway_workspace_required");
    if (!options.accountId.trim()) throw new Error("gateway_account_required");
    this.database = options.database;
    this.workspaceId = options.workspaceId;
    this.accountId = options.accountId;
    this.core = options.core;
    this.emitEvent = options.emit;
    this.sandboxExecutor = options.sandboxExecutor;
    this.notFoundError = options.notFoundError ?? ((message) => new Error(message));
    this.conflictError = options.conflictError ?? ((message) => new Error(message));
    this.errorMessage = options.errorMessage ?? ((error) => error instanceof Error ? error.message : String(error));
  }

  /** Adapter factory for the existing GatewayDomainService contract. */
  dependencies(): GatewayDomainServiceDependencies {
    return {
      gateway: this.gatewayPort(),
      policy: this.policyPort(),
      pairing: this.pairingPort(),
      inbound: this.inboundPort(),
      notFoundError: this.notFoundError
    };
  }

  policyPort(): GatewayPolicyPersistencePort {
    return {
      getMcpConfig: (id) => this.getMcpConfig(id),
      saveMcpConfig: (record) => this.saveMcpConfig(record),
      listPairingPolicies: () => this.listPairingPolicies(),
      getPairingPolicy: (channel) => this.getPairingPolicy(channel),
      savePairingPolicy: (record) => this.savePairingPolicy(record),
      emitPairingPolicySaved: (record) => this.emitEvent("gateway.pairing_policy.saved", record),
      listRoutingPolicies: () => this.listRoutingPolicies(),
      getRoutingPolicy: (channel) => this.getRoutingPolicy(channel),
      saveRoutingPolicy: (record) => this.saveRoutingPolicy(record),
      emitRoutingPolicySaved: (record) => this.emitEvent("gateway.routing_policy.saved", record)
    };
  }

  pairingPort(): GatewayPairingPort {
    return {
      get: (id) => this.getPairing(id),
      save: (record) => this.savePairing(record),
      expireAll: (now) => this.expirePairings(now),
      emitUpdated: (record) => this.emitEvent("gateway.pairing.updated", record)
    };
  }

  inboundPort(): GatewayInboundPort {
    return {
      expirePairings: () => this.expirePairings(nowIso()),
      getRoutingPolicy: async (channel) => (await this.getRoutingPolicy(channel)) ?? createDefaultGatewayRoutingPolicy(channel),
      getPairingPolicy: async (channel) => (await this.getPairingPolicy(channel)) ?? createDefaultGatewayPairingPolicy(channel),
      saveInbound: (record) => this.saveInbound(record),
      emit: (name, payload) => this.emitEvent(name, payload),
      findDuplicate: (input) => this.findDuplicate(input),
      isRateLimited: (input) => this.isRateLimited(input),
      findPairing: (input) => this.findPairing(input),
      getPairing: (id) => this.getPairing(id),
      savePairing: (record) => this.savePairing(record),
      saveBoundaryPolicy: (policy) => this.saveBoundaryPolicy(policy),
      acquireLock: (policy, inbound) => this.acquireLock(policy, inbound),
      releaseLock: (lockKey) => this.releaseLock(lockKey),
      ensureSession: this.core.ensureSession,
      runChat: this.core.runChat,
      enqueueDeliveries: (input) => this.enqueueDeliveriesFromChat(input),
      errorMessage: this.errorMessage,
      conflictError: this.conflictError
    };
  }

  gatewayPort(): GatewayCommandPort {
    return {
      expireConcurrencyLocks: (now) => this.expireConcurrencyLocks(now ?? nowIso()),
      deleteSandbox: (id) => this.deleteSandbox(id),
      recreateSandbox: (id) => this.recreateSandbox(id),
      syncSandbox: (id, input) => this.syncSandbox(id, input),
      repairState: (input) => this.repairState(input)
    };
  }

  async listPairings(input: { status?: string; channel?: string; sourceIdentity?: string; sessionKey?: string; limit?: number } = {}): Promise<GatewayPairingRecord[]> {
    const clauses = ["workspace_id = $1"];
    const values: unknown[] = [this.workspaceId];
    if (input.status) { values.push(input.status); clauses.push(`status = $${values.length}`); }
    if (input.channel) { values.push(input.channel); clauses.push(`channel = $${values.length}`); }
    if (input.sourceIdentity) { values.push(input.sourceIdentity); clauses.push(`source_identity = $${values.length}`); }
    if (input.sessionKey) { values.push(input.sessionKey); clauses.push(`session_key = $${values.length}`); }
    values.push(limitValue(input.limit));
    return this.withContext(async (sql) => {
      const result = await sql.query<Row>(
        `SELECT workspace_id, id, channel, source_identity, source_label, status, pairing_code,
                session_key, metadata, requested_at, expires_at, resolved_at, revoked_at, updated_at
           FROM workspace_gateway_pairings
          WHERE ${clauses.join(" AND ")}
          ORDER BY updated_at DESC, id ASC LIMIT $${values.length}`,
        values
      );
      return result.rows.map(pairingFromRow);
    });
  }

  async listInboundMessages(input: { status?: string; channel?: string; sourceIdentity?: string; limit?: number } = {}): Promise<GatewayInboundMessageRecord[]> {
    const clauses = ["workspace_id = $1"];
    const values: unknown[] = [this.workspaceId];
    if (input.status) { values.push(input.status); clauses.push(`status = $${values.length}`); }
    if (input.channel) { values.push(input.channel); clauses.push(`channel = $${values.length}`); }
    if (input.sourceIdentity) { values.push(input.sourceIdentity); clauses.push(`source_identity = $${values.length}`); }
    values.push(limitValue(input.limit));
    return this.withContext(async (sql) => {
      const result = await sql.query<Row>(
        `SELECT workspace_id, id, channel, source_identity, body, status, trusted, session_key,
                pairing_id, message_id, error, metadata, created_at, updated_at
           FROM workspace_gateway_inbound_messages
          WHERE ${clauses.join(" AND ")}
          ORDER BY created_at DESC, id ASC LIMIT $${values.length}`,
        values
      );
      return result.rows.map(inboundFromRow);
    });
  }

  async listBoundaryPolicies(input: { sourceChannel?: string; sessionKey?: string; limit?: number } = {}): Promise<GatewayBoundaryPolicy[]> {
    const clauses = ["workspace_id = $1"];
    const values: unknown[] = [this.workspaceId];
    if (input.sourceChannel) { values.push(input.sourceChannel); clauses.push(`source_channel = $${values.length}`); }
    if (input.sessionKey) { values.push(input.sessionKey); clauses.push(`session_key = $${values.length}`); }
    values.push(limitValue(input.limit));
    return this.withContext(async (sql) => {
      const result = await sql.query<Row>(
        `SELECT workspace_id, id, source_channel, source_identity, session_key, allowed_tools,
                mcp_config_refs, secret_refs, sandbox, path_normalization, allowlist, timeout_ms,
                concurrency_lock, metadata, created_at, updated_at
           FROM workspace_gateway_boundary_policies
          WHERE ${clauses.join(" AND ")}
          ORDER BY updated_at DESC, id ASC LIMIT $${values.length}`,
        values
      );
      return result.rows.map(boundaryFromRow);
    });
  }

  async listMcpConfigs(input: { enabled?: boolean; serverName?: string; limit?: number } = {}): Promise<GatewayMcpConfigRecord[]> {
    const clauses = ["workspace_id = $1"];
    const values: unknown[] = [this.workspaceId];
    if (input.enabled !== undefined) { values.push(input.enabled); clauses.push(`enabled = $${values.length}`); }
    if (input.serverName) { values.push(input.serverName); clauses.push(`server_name = $${values.length}`); }
    values.push(limitValue(input.limit));
    return this.withContext(async (sql) => {
      const result = await sql.query<Row>(
        `SELECT workspace_id, id, server_name, transport, enabled, allowed_tools, config_ref,
                secret_refs, stdio, http, metadata, created_at, updated_at
           FROM workspace_gateway_mcp_configs
          WHERE ${clauses.join(" AND ")}
          ORDER BY updated_at DESC, id ASC LIMIT $${values.length}`,
        values
      );
      return result.rows.map(mcpConfigFromRow);
    });
  }

  async listConcurrencyLocks(input: { status?: string; limit?: number } = {}): Promise<GatewayConcurrencyLockRecord[]> {
    const clauses = ["workspace_id = $1"];
    const values: unknown[] = [this.workspaceId];
    if (input.status) { values.push(input.status); clauses.push(`status = $${values.length}`); }
    values.push(limitValue(input.limit));
    return this.withContext(async (sql) => {
      const result = await sql.query<Row>(
        `SELECT workspace_id, id, lock_key, scope, policy_id, owner_ref, status,
                acquired_at, expires_at, released_at, metadata
           FROM workspace_gateway_concurrency_locks
          WHERE ${clauses.join(" AND ")}
          ORDER BY expires_at ASC, id ASC LIMIT $${values.length}`,
        values
      );
      return result.rows.map(lockFromRow);
    });
  }

  async listDeliveries(input: { status?: string; limit?: number } = {}): Promise<GatewayDeliveryRecord[]> {
    const clauses = ["workspace_id = $1"];
    const values: unknown[] = [this.workspaceId];
    if (input.status) { values.push(input.status); clauses.push(`status = $${values.length}`); }
    values.push(limitValue(input.limit));
    return this.withContext(async (sql) => {
      const result = await sql.query<Row>(
        `SELECT workspace_id, id, inbound_id, session_key, channel, status, idempotency_key,
                payload, attempt, max_attempts, next_attempt_at, lease_until, receipt, last_error,
                created_at, updated_at, delivered_at
           FROM workspace_gateway_deliveries
          WHERE ${clauses.join(" AND ")}
          ORDER BY created_at DESC, id ASC LIMIT $${values.length}`,
        values
      );
      return result.rows.map(deliveryFromRow);
    });
  }

  async listSandboxInstances(input: { status?: string; scope?: string; backend?: string; limit?: number } = {}): Promise<GatewaySandboxInstanceRecord[]> {
    const clauses = ["workspace_id = $1"];
    const values: unknown[] = [this.workspaceId];
    if (input.status) { values.push(input.status); clauses.push(`status = $${values.length}`); }
    if (input.scope) { values.push(input.scope); clauses.push(`scope = $${values.length}`); }
    if (input.backend) { values.push(input.backend); clauses.push(`backend = $${values.length}`); }
    values.push(limitValue(input.limit));
    return this.withContext(async (sql) => {
      const result = await sql.query<Row>(
        `SELECT workspace_id, id, instance_key, scope, backend, status, sandbox, session_key,
                owner_ref, workspace_root, created_at, updated_at, last_used_at, deleted_at, metadata
           FROM workspace_gateway_sandbox_instances
          WHERE ${clauses.join(" AND ")}
          ORDER BY updated_at DESC, id ASC LIMIT $${values.length}`,
        values
      );
      return result.rows.map(sandboxInstanceFromRow);
    });
  }

  async listSandboxWorkspaceSyncs(input: { instanceId?: string; instanceKey?: string; status?: string; direction?: string; limit?: number } = {}): Promise<GatewaySandboxWorkspaceSyncRecord[]> {
    const clauses = ["workspace_id = $1"];
    const values: unknown[] = [this.workspaceId];
    if (input.instanceId) { values.push(input.instanceId); clauses.push(`instance_id = $${values.length}`); }
    if (input.instanceKey) { values.push(input.instanceKey); clauses.push(`instance_key = $${values.length}`); }
    if (input.status) { values.push(input.status); clauses.push(`status = $${values.length}`); }
    if (input.direction) { values.push(input.direction); clauses.push(`direction = $${values.length}`); }
    values.push(limitValue(input.limit));
    return this.withContext(async (sql) => {
      const result = await sql.query<Row>(
        `SELECT workspace_id, id, instance_id, instance_key, direction, status, workspace_root,
                remote_workspace_root, file_count, byte_count, error, started_at, completed_at, metadata
           FROM workspace_gateway_sandbox_syncs
          WHERE ${clauses.join(" AND ")}
          ORDER BY started_at DESC, id ASC LIMIT $${values.length}`,
        values
      );
      return result.rows.map(sandboxSyncFromRow);
    });
  }

  async getPairing(id: string): Promise<GatewayPairingRecord | undefined> {
    return this.withContext(async (sql) => {
      const result = await sql.query<Row>(
        `SELECT workspace_id, id, channel, source_identity, source_label, status, pairing_code,
                session_key, metadata, requested_at, expires_at, resolved_at, revoked_at, updated_at
           FROM workspace_gateway_pairings
          WHERE workspace_id = $1 AND id = $2`,
        [this.workspaceId, id]
      );
      return result.rows[0] ? pairingFromRow(result.rows[0]) : undefined;
    });
  }

  async savePairing(record: GatewayPairingRecord): Promise<GatewayPairingRecord> {
    const parsed = GatewayPairingRecordSchema.parse(record);
    return this.withContext(async (sql) => {
      const result = await sql.query<Row>(
        `INSERT INTO workspace_gateway_pairings(
           workspace_id, id, channel, source_identity, source_label, status, pairing_code,
           session_key, metadata, requested_at, expires_at, resolved_at, revoked_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::JSONB, $10, $11, $12, $13, $14)
         ON CONFLICT (workspace_id, id) DO UPDATE SET
           channel = EXCLUDED.channel, source_identity = EXCLUDED.source_identity,
           source_label = EXCLUDED.source_label, status = EXCLUDED.status,
           pairing_code = EXCLUDED.pairing_code, session_key = EXCLUDED.session_key,
           metadata = EXCLUDED.metadata, requested_at = EXCLUDED.requested_at,
           expires_at = EXCLUDED.expires_at, resolved_at = EXCLUDED.resolved_at,
           revoked_at = EXCLUDED.revoked_at, updated_at = EXCLUDED.updated_at
         RETURNING workspace_id, id, channel, source_identity, source_label, status, pairing_code,
                   session_key, metadata, requested_at, expires_at, resolved_at, revoked_at, updated_at`,
        [this.workspaceId, parsed.id, parsed.channel, parsed.source_identity, parsed.source_label, parsed.status,
          parsed.pairing_code ?? null, parsed.session_key, parsed.metadata, parsed.requested_at,
          parsed.expires_at ?? null, parsed.resolved_at ?? null, parsed.revoked_at ?? null, parsed.updated_at]
      );
      return pairingFromRow(requiredRow(result.rows[0], "gateway_pairing_save_failed"));
    });
  }

  async expirePairings(now: string): Promise<GatewayPairingRecord[]> {
    assertDate(now, "gateway_pairing_expiry_invalid");
    return this.withContext(async (sql) => {
      const result = await sql.query<Row>(
        `UPDATE workspace_gateway_pairings
            SET status = 'expired', pairing_code = NULL, resolved_at = $2, updated_at = $2
          WHERE workspace_id = $1 AND status = 'pending' AND expires_at IS NOT NULL AND expires_at <= $2
         RETURNING workspace_id, id, channel, source_identity, source_label, status, pairing_code,
                   session_key, metadata, requested_at, expires_at, resolved_at, revoked_at, updated_at`,
        [this.workspaceId, new Date(now).toISOString()]
      );
      return result.rows.map(pairingFromRow);
    });
  }

  async getPairingPolicy(channel: GatewayPairingPolicyRecord["channel"]): Promise<GatewayPairingPolicyRecord | undefined> {
    return this.withContext(async (sql) => {
      const result = await sql.query<Row>(
        `SELECT workspace_id, id, channel, status, trust_mode, allowlist, allowed_tools,
                pairing_ttl_ms, duplicate_window_ms, rate_limit_window_ms, rate_limit_max,
                metadata, created_at, updated_at
           FROM workspace_gateway_pairing_policies
          WHERE workspace_id = $1 AND channel = $2`,
        [this.workspaceId, channel]
      );
      return result.rows[0] ? pairingPolicyFromRow(result.rows[0]) : undefined;
    });
  }

  async listPairingPolicies(): Promise<GatewayPairingPolicyRecord[]> {
    return this.withContext(async (sql) => {
      const result = await sql.query<Row>(
        `SELECT workspace_id, id, channel, status, trust_mode, allowlist, allowed_tools,
                pairing_ttl_ms, duplicate_window_ms, rate_limit_window_ms, rate_limit_max,
                metadata, created_at, updated_at
           FROM workspace_gateway_pairing_policies
          WHERE workspace_id = $1 ORDER BY updated_at DESC`,
        [this.workspaceId]
      );
      return result.rows.map(pairingPolicyFromRow);
    });
  }

  async savePairingPolicy(record: GatewayPairingPolicyRecord): Promise<GatewayPairingPolicyRecord> {
    const parsed = GatewayPairingPolicyRecordSchema.parse(record);
    return this.withContext(async (sql) => {
      const result = await sql.query<Row>(
        `INSERT INTO workspace_gateway_pairing_policies(
           workspace_id, id, channel, status, trust_mode, allowlist, allowed_tools,
           pairing_ttl_ms, duplicate_window_ms, rate_limit_window_ms, rate_limit_max,
           metadata, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6::JSONB, $7::JSONB, $8, $9, $10, $11, $12::JSONB, $13, $14)
         ON CONFLICT (workspace_id, channel) DO UPDATE SET
           id = EXCLUDED.id, status = EXCLUDED.status, trust_mode = EXCLUDED.trust_mode,
           allowlist = EXCLUDED.allowlist, allowed_tools = EXCLUDED.allowed_tools,
           pairing_ttl_ms = EXCLUDED.pairing_ttl_ms, duplicate_window_ms = EXCLUDED.duplicate_window_ms,
           rate_limit_window_ms = EXCLUDED.rate_limit_window_ms, rate_limit_max = EXCLUDED.rate_limit_max,
           metadata = EXCLUDED.metadata, created_at = EXCLUDED.created_at, updated_at = EXCLUDED.updated_at
         RETURNING workspace_id, id, channel, status, trust_mode, allowlist, allowed_tools,
                   pairing_ttl_ms, duplicate_window_ms, rate_limit_window_ms, rate_limit_max,
                   metadata, created_at, updated_at`,
        [this.workspaceId, parsed.id, parsed.channel, parsed.status, parsed.trust_mode, parsed.allowlist,
          parsed.allowed_tools, parsed.pairing_ttl_ms ?? null, parsed.duplicate_window_ms ?? null,
          parsed.rate_limit_window_ms ?? null, parsed.rate_limit_max ?? null, parsed.metadata,
          parsed.created_at, parsed.updated_at]
      );
      return pairingPolicyFromRow(requiredRow(result.rows[0], "gateway_pairing_policy_save_failed"));
    });
  }

  async getRoutingPolicy(channel: GatewayRoutingPolicyRecord["channel"]): Promise<GatewayRoutingPolicyRecord | undefined> {
    return this.withContext(async (sql) => {
      const result = await sql.query<Row>(
        `SELECT workspace_id, id, channel, status, session_key_strategy, default_account_id,
                default_thread_id, default_route, metadata, created_at, updated_at
           FROM workspace_gateway_routing_policies
          WHERE workspace_id = $1 AND channel = $2`,
        [this.workspaceId, channel]
      );
      return result.rows[0] ? routingPolicyFromRow(result.rows[0]) : undefined;
    });
  }

  async listRoutingPolicies(): Promise<GatewayRoutingPolicyRecord[]> {
    return this.withContext(async (sql) => {
      const result = await sql.query<Row>(
        `SELECT workspace_id, id, channel, status, session_key_strategy, default_account_id,
                default_thread_id, default_route, metadata, created_at, updated_at
           FROM workspace_gateway_routing_policies
          WHERE workspace_id = $1 ORDER BY updated_at DESC`,
        [this.workspaceId]
      );
      return result.rows.map(routingPolicyFromRow);
    });
  }

  async saveRoutingPolicy(record: GatewayRoutingPolicyRecord): Promise<GatewayRoutingPolicyRecord> {
    const parsed = GatewayRoutingPolicyRecordSchema.parse(record);
    return this.withContext(async (sql) => {
      const result = await sql.query<Row>(
        `INSERT INTO workspace_gateway_routing_policies(
           workspace_id, id, channel, status, session_key_strategy, default_account_id,
           default_thread_id, default_route, metadata, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::JSONB, $10, $11)
         ON CONFLICT (workspace_id, channel) DO UPDATE SET
           id = EXCLUDED.id, status = EXCLUDED.status, session_key_strategy = EXCLUDED.session_key_strategy,
           default_account_id = EXCLUDED.default_account_id, default_thread_id = EXCLUDED.default_thread_id,
           default_route = EXCLUDED.default_route, metadata = EXCLUDED.metadata,
           created_at = EXCLUDED.created_at, updated_at = EXCLUDED.updated_at
         RETURNING workspace_id, id, channel, status, session_key_strategy, default_account_id,
                   default_thread_id, default_route, metadata, created_at, updated_at`,
        [this.workspaceId, parsed.id, parsed.channel, parsed.status, parsed.session_key_strategy,
          parsed.default_account_id ?? null, parsed.default_thread_id ?? null, parsed.default_route,
          parsed.metadata, parsed.created_at, parsed.updated_at]
      );
      return routingPolicyFromRow(requiredRow(result.rows[0], "gateway_routing_policy_save_failed"));
    });
  }

  async getMcpConfig(id: string): Promise<GatewayMcpConfigRecord | undefined> {
    return this.withContext(async (sql) => {
      const result = await sql.query<Row>(
        `SELECT workspace_id, id, server_name, transport, enabled, allowed_tools, config_ref,
                secret_refs, stdio, http, metadata, created_at, updated_at
           FROM workspace_gateway_mcp_configs
          WHERE workspace_id = $1 AND id = $2`,
        [this.workspaceId, id]
      );
      return result.rows[0] ? mcpConfigFromRow(result.rows[0]) : undefined;
    });
  }

  async saveMcpConfig(record: GatewayMcpConfigRecord): Promise<GatewayMcpConfigRecord> {
    const parsed = GatewayMcpConfigRecordSchema.parse(record);
    return this.withContext(async (sql) => {
      const result = await sql.query<Row>(
        `INSERT INTO workspace_gateway_mcp_configs(
           workspace_id, id, server_name, transport, enabled, allowed_tools, config_ref,
           secret_refs, stdio, http, metadata, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6::JSONB, $7::JSONB, $8::JSONB, $9::JSONB, $10::JSONB, $11::JSONB, $12, $13)
         ON CONFLICT (workspace_id, id) DO UPDATE SET
           server_name = EXCLUDED.server_name, transport = EXCLUDED.transport, enabled = EXCLUDED.enabled,
           allowed_tools = EXCLUDED.allowed_tools, config_ref = EXCLUDED.config_ref,
           secret_refs = EXCLUDED.secret_refs, stdio = EXCLUDED.stdio, http = EXCLUDED.http,
           metadata = EXCLUDED.metadata, created_at = EXCLUDED.created_at, updated_at = EXCLUDED.updated_at
         RETURNING workspace_id, id, server_name, transport, enabled, allowed_tools, config_ref,
                   secret_refs, stdio, http, metadata, created_at, updated_at`,
        [this.workspaceId, parsed.id, parsed.server_name, parsed.transport, parsed.enabled,
          parsed.allowed_tools, parsed.config_ref ?? null, parsed.secret_refs,
          parsed.transport === "stdio" ? parsed.stdio : null, parsed.transport === "http" ? parsed.http : null,
          parsed.metadata, parsed.created_at, parsed.updated_at]
      );
      return mcpConfigFromRow(requiredRow(result.rows[0], "gateway_mcp_config_save_failed"));
    });
  }

  async saveInbound(record: GatewayInboundMessageRecord): Promise<GatewayInboundMessageRecord> {
    const parsed = GatewayInboundMessageRecordSchema.parse(record);
    return this.withContext(async (sql) => {
      const result = await sql.query<Row>(
        `INSERT INTO workspace_gateway_inbound_messages(
           workspace_id, id, channel, source_identity, body, status, trusted, session_key,
           pairing_id, message_id, error, metadata, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::JSONB, $13, $14)
         ON CONFLICT (workspace_id, id) DO UPDATE SET
           channel = EXCLUDED.channel, source_identity = EXCLUDED.source_identity, body = EXCLUDED.body,
           status = EXCLUDED.status, trusted = EXCLUDED.trusted, session_key = EXCLUDED.session_key,
           pairing_id = EXCLUDED.pairing_id, message_id = EXCLUDED.message_id, error = EXCLUDED.error,
           metadata = EXCLUDED.metadata, created_at = EXCLUDED.created_at, updated_at = EXCLUDED.updated_at
         RETURNING workspace_id, id, channel, source_identity, body, status, trusted, session_key,
                   pairing_id, message_id, error, metadata, created_at, updated_at`,
        [this.workspaceId, parsed.id, parsed.channel, parsed.source_identity, parsed.body, parsed.status,
          parsed.trusted, parsed.session_key ?? null, parsed.pairing_id ?? null, parsed.message_id ?? null,
          parsed.error ?? null, parsed.metadata, parsed.created_at, parsed.updated_at]
      );
      return inboundFromRow(requiredRow(result.rows[0], "gateway_inbound_save_failed"));
    });
  }

  async findDuplicate(input: { channel: GatewayInboundMessageRecord["channel"]; sourceIdentity: string; body: string; windowMs: number; externalMessageId?: string }): Promise<GatewayInboundMessageRecord | undefined> {
    const since = new Date(Date.now() - input.windowMs).toISOString();
    return this.withContext(async (sql) => {
      const result = await sql.query<Row>(
        `SELECT workspace_id, id, channel, source_identity, body, status, trusted, session_key,
                pairing_id, message_id, error, metadata, created_at, updated_at
           FROM workspace_gateway_inbound_messages
          WHERE workspace_id = $1 AND channel = $2 AND source_identity = $3 AND body = $4
            AND created_at >= $5
            AND ($6::TEXT IS NULL OR message_id = $6 OR metadata->>'message_id' = $6)
          ORDER BY created_at DESC LIMIT 1`,
        [this.workspaceId, input.channel, input.sourceIdentity, input.body, since, input.externalMessageId ?? null]
      );
      return result.rows[0] ? inboundFromRow(result.rows[0]) : undefined;
    });
  }

  async isRateLimited(input: { channel: GatewayInboundMessageRecord["channel"]; sourceIdentity: string; windowMs: number; maxMessages: number }): Promise<boolean> {
    const since = new Date(Date.now() - input.windowMs).toISOString();
    return this.withContext(async (sql) => {
      const result = await sql.query<{ count: string | number }>(
        `SELECT COUNT(*)::BIGINT AS count
           FROM workspace_gateway_inbound_messages
          WHERE workspace_id = $1 AND channel = $2 AND source_identity = $3 AND created_at >= $4`,
        [this.workspaceId, input.channel, input.sourceIdentity, since]
      );
      return Number(result.rows[0]?.count ?? 0) >= input.maxMessages;
    });
  }

  async findPairing(input: { channel: GatewayPairingRecord["channel"]; sourceIdentity: string; status: GatewayPairingRecord["status"]; sessionKey: string }): Promise<GatewayPairingRecord | undefined> {
    return this.withContext(async (sql) => {
      const result = await sql.query<Row>(
        `SELECT workspace_id, id, channel, source_identity, source_label, status, pairing_code,
                session_key, metadata, requested_at, expires_at, resolved_at, revoked_at, updated_at
           FROM workspace_gateway_pairings
          WHERE workspace_id = $1 AND channel = $2 AND source_identity = $3
            AND status = $4 AND session_key = $5
          ORDER BY updated_at DESC LIMIT 1`,
        [this.workspaceId, input.channel, input.sourceIdentity, input.status, input.sessionKey]
      );
      return result.rows[0] ? pairingFromRow(result.rows[0]) : undefined;
    });
  }

  async saveBoundaryPolicy(policy: GatewayBoundaryPolicy): Promise<GatewayBoundaryPolicy> {
    const parsed = GatewayBoundaryPolicySchema.parse(policy);
    return this.withContext(async (sql) => {
      const result = await sql.query<Row>(
        `INSERT INTO workspace_gateway_boundary_policies(
           workspace_id, id, source_channel, source_identity, session_key, allowed_tools,
           mcp_config_refs, secret_refs, sandbox, path_normalization, allowlist, timeout_ms,
           concurrency_lock, metadata, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6::JSONB, $7::JSONB, $8::JSONB, $9::JSONB, $10::JSONB, $11::JSONB, $12, $13::JSONB, $14::JSONB, $15, $16)
         ON CONFLICT (workspace_id, id) DO UPDATE SET
           source_channel = EXCLUDED.source_channel, source_identity = EXCLUDED.source_identity,
           session_key = EXCLUDED.session_key, allowed_tools = EXCLUDED.allowed_tools,
           mcp_config_refs = EXCLUDED.mcp_config_refs, secret_refs = EXCLUDED.secret_refs,
           sandbox = EXCLUDED.sandbox, path_normalization = EXCLUDED.path_normalization,
           allowlist = EXCLUDED.allowlist, timeout_ms = EXCLUDED.timeout_ms,
           concurrency_lock = EXCLUDED.concurrency_lock, metadata = EXCLUDED.metadata,
           created_at = EXCLUDED.created_at, updated_at = EXCLUDED.updated_at
         RETURNING workspace_id, id, source_channel, source_identity, session_key, allowed_tools,
                   mcp_config_refs, secret_refs, sandbox, path_normalization, allowlist, timeout_ms,
                   concurrency_lock, metadata, created_at, updated_at`,
        [this.workspaceId, parsed.id, parsed.source_channel, parsed.source_identity ?? null, parsed.session_key,
          parsed.allowed_tools, parsed.mcp_config_refs, parsed.secret_refs, parsed.sandbox, parsed.path_normalization,
          parsed.allowlist, parsed.timeout_ms ?? null, parsed.concurrency_lock ?? null, parsed.metadata,
          parsed.created_at, parsed.updated_at]
      );
      return boundaryFromRow(requiredRow(result.rows[0], "gateway_boundary_policy_save_failed"));
    });
  }

  async acquireLock(policy: GatewayBoundaryPolicy, inbound: GatewayInboundMessageRecord): Promise<{ acquired: boolean; lock: GatewayConcurrencyLockRecord }> {
    const lockPolicy = policy.concurrency_lock;
    const now = nowIso();
    if (!lockPolicy) {
      const lock = GatewayConcurrencyLockRecordSchema.parse({
        id: createId("gateway_lock"), lock_key: `${policy.session_key}:none`, scope: "session", policy_id: policy.id,
        status: "released", acquired_at: now, expires_at: now, released_at: now, metadata: {}
      });
      return { acquired: true, lock };
    }
    const ownerRef = { kind: "gateway_inbound", id: inbound.id, uri: `gateway/inbounds/${inbound.id}` };
    return this.withContext(async (sql) => {
      await sql.query(
        `UPDATE workspace_gateway_concurrency_locks
            SET status = 'expired'
          WHERE workspace_id = $1 AND status = 'acquired' AND expires_at <= $2`,
        [this.workspaceId, now]
      );
      const expiresAt = new Date(Date.parse(now) + lockPolicy.ttl_ms).toISOString();
      const inserted = await sql.query<Row>(
        `INSERT INTO workspace_gateway_concurrency_locks(
           workspace_id, id, lock_key, scope, policy_id, owner_ref, status, acquired_at,
           expires_at, released_at, metadata
         ) VALUES ($1, $2, $3, $4, $5, $6::JSONB, 'acquired', $7, $8, NULL, $9::JSONB)
         ON CONFLICT (workspace_id, lock_key) DO NOTHING
         RETURNING workspace_id, id, lock_key, scope, policy_id, owner_ref, status,
                   acquired_at, expires_at, released_at, metadata`,
        [this.workspaceId, createId("gateway_lock"), lockPolicy.key, lockPolicy.scope, policy.id,
          ownerRef, now, expiresAt, { source_channel: policy.source_channel, source_identity: policy.source_identity ?? null }]
      );
      if (inserted.rows[0]) return { acquired: true, lock: lockFromRow(inserted.rows[0]) };
      const current = await sql.query<Row>(
        `SELECT workspace_id, id, lock_key, scope, policy_id, owner_ref, status,
                acquired_at, expires_at, released_at, metadata
           FROM workspace_gateway_concurrency_locks
          WHERE workspace_id = $1 AND lock_key = $2`,
        [this.workspaceId, lockPolicy.key]
      );
      return { acquired: false, lock: lockFromRow(requiredRow(current.rows[0], "gateway_lock_read_failed")) };
    });
  }

  async releaseLock(lockKey: string): Promise<void> {
    await this.withContext(async (sql) => {
      await sql.query(
        `UPDATE workspace_gateway_concurrency_locks
            SET status = 'released', released_at = $3
          WHERE workspace_id = $1 AND lock_key = $2 AND status = 'acquired'`,
        [this.workspaceId, lockKey, nowIso()]
      );
    });
  }

  async expireConcurrencyLocks(now: string): Promise<GatewayConcurrencyLockRecord[]> {
    assertDate(now, "gateway_lock_expiry_invalid");
    return this.withContext(async (sql) => {
      const result = await sql.query<Row>(
        `UPDATE workspace_gateway_concurrency_locks
            SET status = 'expired'
          WHERE workspace_id = $1 AND status = 'acquired' AND expires_at <= $2
         RETURNING workspace_id, id, lock_key, scope, policy_id, owner_ref, status,
                   acquired_at, expires_at, released_at, metadata`,
        [this.workspaceId, new Date(now).toISOString()]
      );
      return result.rows.map(lockFromRow);
    });
  }

  async enqueueDelivery(record: GatewayDeliveryRecord): Promise<GatewayDeliveryRecord> {
    const parsed = GatewayDeliveryRecordSchema.parse(record);
    return this.withContext(async (sql) => {
      await sql.query(
        `INSERT INTO workspace_gateway_deliveries(
           workspace_id, id, inbound_id, session_key, channel, status, idempotency_key,
           payload, attempt, max_attempts, next_attempt_at, lease_until, receipt, last_error,
           created_at, updated_at, delivered_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::JSONB, $9, $10, $11, $12, $13::JSONB, $14, $15, $16, $17)
         ON CONFLICT (workspace_id, idempotency_key) DO NOTHING`,
        [this.workspaceId, parsed.id, parsed.inbound_id ?? null, parsed.session_key, parsed.channel, parsed.status,
          parsed.idempotency_key, parsed.payload, parsed.attempt, parsed.max_attempts, parsed.next_attempt_at ?? null,
          parsed.lease_until ?? null, parsed.receipt ?? null, parsed.last_error ?? null, parsed.created_at,
          parsed.updated_at, parsed.delivered_at ?? null]
      );
      const result = await sql.query<Row>(
        `SELECT workspace_id, id, inbound_id, session_key, channel, status, idempotency_key,
                payload, attempt, max_attempts, next_attempt_at, lease_until, receipt, last_error,
                created_at, updated_at, delivered_at
           FROM workspace_gateway_deliveries
          WHERE workspace_id = $1 AND idempotency_key = $2`,
        [this.workspaceId, parsed.idempotency_key]
      );
      const saved = deliveryFromRow(requiredRow(result.rows[0], "gateway_delivery_save_failed"));
      if (stableHash(deliveryIdentity(saved)) !== stableHash(deliveryIdentity(parsed))) {
        throw this.conflictError("gateway_delivery_idempotency_mismatch");
      }
      return saved;
    });
  }

  async getDelivery(id: string): Promise<GatewayDeliveryRecord | undefined> {
    return this.withContext(async (sql) => {
      const result = await sql.query<Row>(
        `SELECT workspace_id, id, inbound_id, session_key, channel, status, idempotency_key,
                payload, attempt, max_attempts, next_attempt_at, lease_until, receipt, last_error,
                created_at, updated_at, delivered_at
           FROM workspace_gateway_deliveries
          WHERE workspace_id = $1 AND id = $2`,
        [this.workspaceId, id]
      );
      return result.rows[0] ? deliveryFromRow(result.rows[0]) : undefined;
    });
  }

  async claimDelivery(id: string, input: { now: string; leaseUntil: string }): Promise<GatewayDeliveryRecord | undefined> {
    assertDate(input.now, "gateway_delivery_claim_time_invalid");
    assertDate(input.leaseUntil, "gateway_delivery_lease_invalid");
    return this.withContext(async (sql) => {
      const result = await sql.query<Row>(
        `UPDATE workspace_gateway_deliveries
            SET status = 'delivering', lease_until = $3, attempt = attempt + 1, updated_at = $2
          WHERE workspace_id = $1 AND id = $4 AND attempt < max_attempts
            AND status IN ('pending', 'retry_wait')
            AND (next_attempt_at IS NULL OR next_attempt_at <= $2)
            AND (lease_until IS NULL OR lease_until <= $2)
         RETURNING workspace_id, id, inbound_id, session_key, channel, status, idempotency_key,
                   payload, attempt, max_attempts, next_attempt_at, lease_until, receipt, last_error,
                   created_at, updated_at, delivered_at`,
        [this.workspaceId, new Date(input.now).toISOString(), new Date(input.leaseUntil).toISOString(), id]
      );
      return result.rows[0] ? deliveryFromRow(result.rows[0]) : undefined;
    });
  }

  async completeDelivery(id: string, input: { now: string; receipt: Record<string, JsonValue> }): Promise<GatewayDeliveryRecord> {
    assertDate(input.now, "gateway_delivery_complete_time_invalid");
    return this.withContext(async (sql) => {
      const result = await sql.query<Row>(
        `UPDATE workspace_gateway_deliveries
            SET status = 'delivered', receipt = $3::JSONB, lease_until = NULL,
                next_attempt_at = NULL, last_error = NULL, delivered_at = $2, updated_at = $2
          WHERE workspace_id = $1 AND id = $4 AND status = 'delivering'
         RETURNING workspace_id, id, inbound_id, session_key, channel, status, idempotency_key,
                   payload, attempt, max_attempts, next_attempt_at, lease_until, receipt, last_error,
                   created_at, updated_at, delivered_at`,
        [this.workspaceId, new Date(input.now).toISOString(), input.receipt, id]
      );
      if (!result.rows[0]) throw this.conflictError("gateway_delivery_not_claimed");
      return deliveryFromRow(result.rows[0]);
    });
  }

  async failDelivery(id: string, input: { now: string; error: string; retryAt?: string }): Promise<GatewayDeliveryRecord> {
    assertDate(input.now, "gateway_delivery_failure_time_invalid");
    if (input.retryAt) assertDate(input.retryAt, "gateway_delivery_retry_time_invalid");
    return this.withContext(async (sql) => {
      const result = await sql.query<Row>(
        `UPDATE workspace_gateway_deliveries
            SET status = CASE WHEN $3::TIMESTAMPTZ IS NOT NULL AND attempt < max_attempts THEN 'retry_wait' ELSE 'failed' END,
                next_attempt_at = CASE WHEN $3::TIMESTAMPTZ IS NOT NULL AND attempt < max_attempts THEN $3 ELSE NULL END,
                lease_until = NULL, last_error = $4, updated_at = $2
          WHERE workspace_id = $1 AND id = $5 AND status = 'delivering'
         RETURNING workspace_id, id, inbound_id, session_key, channel, status, idempotency_key,
                   payload, attempt, max_attempts, next_attempt_at, lease_until, receipt, last_error,
                   created_at, updated_at, delivered_at`,
        [this.workspaceId, new Date(input.now).toISOString(), input.retryAt ?? null, input.error, id]
      );
      if (!result.rows[0]) throw this.conflictError("gateway_delivery_not_claimed");
      return deliveryFromRow(result.rows[0]);
    });
  }

  async reconcileExpiredDeliveries(now = nowIso()): Promise<GatewayDeliveryRecord[]> {
    assertDate(now, "gateway_delivery_reconcile_time_invalid");
    return this.withContext(async (sql) => {
      const result = await sql.query<Row>(
        `UPDATE workspace_gateway_deliveries
            SET status = CASE WHEN attempt < max_attempts THEN 'retry_wait' ELSE 'failed' END,
                next_attempt_at = CASE WHEN attempt < max_attempts THEN $2 ELSE NULL END,
                lease_until = NULL,
                last_error = CASE WHEN attempt < max_attempts THEN 'gateway_delivery_lease_expired' ELSE 'gateway_delivery_max_attempts_exceeded' END,
                updated_at = $2
          WHERE workspace_id = $1 AND status = 'delivering' AND lease_until IS NOT NULL AND lease_until <= $2
         RETURNING workspace_id, id, inbound_id, session_key, channel, status, idempotency_key,
                   payload, attempt, max_attempts, next_attempt_at, lease_until, receipt, last_error,
                   created_at, updated_at, delivered_at`,
        [this.workspaceId, new Date(now).toISOString()]
      );
      return result.rows.map(deliveryFromRow);
    });
  }

  async saveSandboxInstance(instance: GatewaySandboxInstanceRecord): Promise<GatewaySandboxInstanceRecord> {
    const parsed = GatewaySandboxInstanceRecordSchema.parse(instance);
    return this.withContext(async (sql) => {
      const result = await sql.query<Row>(
        `INSERT INTO workspace_gateway_sandbox_instances(
           workspace_id, id, instance_key, scope, backend, status, sandbox, session_key,
           owner_ref, workspace_root, created_at, updated_at, last_used_at, deleted_at, metadata
         ) VALUES ($1, $2, $3, $4, $5, $6, $7::JSONB, $8, $9::JSONB, $10, $11, $12, $13, $14, $15::JSONB)
         ON CONFLICT (workspace_id, id) DO UPDATE SET
           instance_key = EXCLUDED.instance_key, scope = EXCLUDED.scope, backend = EXCLUDED.backend,
           status = EXCLUDED.status, sandbox = EXCLUDED.sandbox, session_key = EXCLUDED.session_key,
           owner_ref = EXCLUDED.owner_ref, workspace_root = EXCLUDED.workspace_root,
           created_at = EXCLUDED.created_at, updated_at = EXCLUDED.updated_at, last_used_at = EXCLUDED.last_used_at,
           deleted_at = EXCLUDED.deleted_at, metadata = EXCLUDED.metadata
         RETURNING workspace_id, id, instance_key, scope, backend, status, sandbox, session_key,
                   owner_ref, workspace_root, created_at, updated_at, last_used_at, deleted_at, metadata`,
        [this.workspaceId, parsed.id, parsed.instance_key, parsed.scope, parsed.backend, parsed.status, parsed.sandbox,
          parsed.session_key ?? null, parsed.owner_ref ?? null, parsed.workspace_root ?? null, parsed.created_at,
          parsed.updated_at, parsed.last_used_at ?? null, parsed.deleted_at ?? null, parsed.metadata]
      );
      return sandboxInstanceFromRow(requiredRow(result.rows[0], "gateway_sandbox_instance_save_failed"));
    });
  }

  async getSandboxInstance(idOrKey: string): Promise<GatewaySandboxInstanceRecord | undefined> {
    return this.withContext(async (sql) => {
      const result = await sql.query<Row>(
        `SELECT workspace_id, id, instance_key, scope, backend, status, sandbox, session_key,
                owner_ref, workspace_root, created_at, updated_at, last_used_at, deleted_at, metadata
           FROM workspace_gateway_sandbox_instances
          WHERE workspace_id = $1 AND (id = $2 OR instance_key = $2)
          ORDER BY updated_at DESC LIMIT 1`,
        [this.workspaceId, idOrKey]
      );
      return result.rows[0] ? sandboxInstanceFromRow(result.rows[0]) : undefined;
    });
  }

  async deleteSandbox(idOrKey: string): Promise<GatewaySandboxInstanceRecord> {
    return this.runSandboxLifecycle(idOrKey, "delete");
  }

  async recreateSandbox(idOrKey: string): Promise<GatewaySandboxInstanceRecord> {
    return this.runSandboxLifecycle(idOrKey, "recreate");
  }

  private async runSandboxLifecycle(idOrKey: string, action: "delete" | "recreate"): Promise<GatewaySandboxInstanceRecord> {
    const instance = await this.getSandboxInstance(idOrKey);
    if (!instance) throw this.notFoundError(`Gateway sandbox instance not found: ${idOrKey}`);
    if (!this.sandboxExecutor) throw this.conflictError("gateway_sandbox_executor_unavailable");
    const lifecycle = await this.sandboxExecutor.lifecycle({
      action, instanceKey: instance.instance_key, sandbox: instance.sandbox,
      workspaceRoot: instance.workspace_root, metadata: instance.metadata
    });
    const now = nowIso();
    const succeeded = lifecycle.status === "completed";
    const saved = await this.saveSandboxInstance({
      ...instance,
      status: succeeded ? action === "delete" ? "deleted" : "recreated" : "failed",
      updated_at: now,
      last_used_at: now,
      deleted_at: succeeded && action === "delete" ? now : action === "recreate" ? undefined : instance.deleted_at,
      metadata: {
        ...instance.metadata, lifecycle_action: action, lifecycle_status: lifecycle.status,
        lifecycle_reason: lifecycle.reason ?? null, lifecycle_error: lifecycle.error ?? null,
        lifecycle_resource_refs: lifecycle.resourceRefs ?? []
      }
    });
    return saved;
  }

  async syncSandbox(idOrKey: string, input: { direction?: GatewaySandboxWorkspaceSyncDirection; dryRun: boolean }): Promise<GatewaySandboxWorkspaceSyncResult> {
    const instance = await this.getSandboxInstance(idOrKey);
    if (!instance) throw this.notFoundError(`Gateway sandbox instance not found: ${idOrKey}`);
    if (instance.status === "deleted") throw this.conflictError("gateway_sandbox_instance_deleted");
    const direction = input.direction ?? "seed_to_sandbox";
    const now = nowIso();
    if (!input.dryRun && !this.sandboxExecutor) throw this.conflictError("gateway_sandbox_executor_unavailable");
    const execution = input.dryRun ? undefined : await this.sandboxExecutor!.sync({
      direction, workspaceRoot: instance.workspace_root, sandbox: instance.sandbox,
      timeoutMs: instance.sandbox.timeout_ms, metadata: instance.metadata
    });
    const sync = GatewaySandboxWorkspaceSyncRecordSchema.parse({
      id: createId("gateway_sandbox_sync"), instance_id: instance.id, instance_key: instance.instance_key,
      direction, status: input.dryRun ? "planned" : execution?.status === "completed" ? "completed" : execution?.status === "skipped" ? "skipped" : "failed",
      workspace_root: instance.workspace_root, file_count: execution?.fileCount, byte_count: execution?.byteCount,
      error: execution?.error, started_at: now, completed_at: input.dryRun ? undefined : now,
      metadata: {
        sandbox_backend: instance.backend, sandbox_scope: instance.scope, sandbox_mode: instance.sandbox.mode,
        workspace_access: instance.sandbox.workspace_access, sync_adapter: "gateway",
        sync_reason: execution?.reason ?? null, resource_refs: execution?.resourceRefs ?? [], dry_run: input.dryRun
      }
    });
    const saved = input.dryRun ? sync : await this.saveSandboxSync(sync);
    return GatewaySandboxWorkspaceSyncResultSchema.parse({ dry_run: input.dryRun, sync: saved });
  }

  async saveSandboxSync(sync: GatewaySandboxWorkspaceSyncRecord): Promise<GatewaySandboxWorkspaceSyncRecord> {
    const parsed = GatewaySandboxWorkspaceSyncRecordSchema.parse(sync);
    return this.withContext(async (sql) => {
      const result = await sql.query<Row>(
        `INSERT INTO workspace_gateway_sandbox_syncs(
           workspace_id, id, instance_id, instance_key, direction, status, workspace_root,
           remote_workspace_root, file_count, byte_count, error, started_at, completed_at, metadata
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::JSONB)
         ON CONFLICT (workspace_id, id) DO UPDATE SET
           instance_id = EXCLUDED.instance_id, instance_key = EXCLUDED.instance_key,
           direction = EXCLUDED.direction, status = EXCLUDED.status, workspace_root = EXCLUDED.workspace_root,
           remote_workspace_root = EXCLUDED.remote_workspace_root, file_count = EXCLUDED.file_count,
           byte_count = EXCLUDED.byte_count, error = EXCLUDED.error, started_at = EXCLUDED.started_at,
           completed_at = EXCLUDED.completed_at, metadata = EXCLUDED.metadata
         RETURNING workspace_id, id, instance_id, instance_key, direction, status, workspace_root,
                   remote_workspace_root, file_count, byte_count, error, started_at, completed_at, metadata`,
        [this.workspaceId, parsed.id, parsed.instance_id, parsed.instance_key, parsed.direction, parsed.status,
          parsed.workspace_root ?? null, parsed.remote_workspace_root ?? null, parsed.file_count ?? null,
          parsed.byte_count ?? null, parsed.error ?? null, parsed.started_at, parsed.completed_at ?? null, parsed.metadata]
      );
      return sandboxSyncFromRow(requiredRow(result.rows[0], "gateway_sandbox_sync_save_failed"));
    });
  }

  async repairState(input: { dryRun: boolean; now?: string }): Promise<GatewayRepairResult> {
    const checkedAt = input.now ?? nowIso();
    assertDate(checkedAt, "gateway_repair_time_invalid");
    return this.withContext(async (sql) => {
      const pairings = await sql.query<Row>(
        `SELECT workspace_id, id, channel, source_identity, source_label, status, pairing_code,
                session_key, metadata, requested_at, expires_at, resolved_at, revoked_at, updated_at
           FROM workspace_gateway_pairings
          WHERE workspace_id = $1 AND status = 'pending' AND expires_at IS NOT NULL AND expires_at <= $2`,
        [this.workspaceId, new Date(checkedAt).toISOString()]
      );
      const locks = await sql.query<Row>(
        `SELECT workspace_id, id, lock_key, scope, policy_id, owner_ref, status,
                acquired_at, expires_at, released_at, metadata
           FROM workspace_gateway_concurrency_locks
          WHERE workspace_id = $1 AND status = 'acquired' AND expires_at <= $2`,
        [this.workspaceId, new Date(checkedAt).toISOString()]
      );
      const planned = [
        ...pairings.rows.map((row) => repairPairingAction(pairingFromRow(row), input.dryRun ? "planned" : "applied")),
        ...locks.rows.map((row) => repairLockAction(lockFromRow(row), input.dryRun ? "planned" : "applied"))
      ];
      if (!input.dryRun) {
        await sql.query(
          `UPDATE workspace_gateway_pairings SET status = 'expired', pairing_code = NULL, resolved_at = $2, updated_at = $2
            WHERE workspace_id = $1 AND status = 'pending' AND expires_at IS NOT NULL AND expires_at <= $2`,
          [this.workspaceId, new Date(checkedAt).toISOString()]
        );
        await sql.query(
          `UPDATE workspace_gateway_concurrency_locks SET status = 'expired'
            WHERE workspace_id = $1 AND status = 'acquired' AND expires_at <= $2`,
          [this.workspaceId, new Date(checkedAt).toISOString()]
        );
      }
      return GatewayRepairResultSchema.parse({
        dry_run: input.dryRun, checked_at: new Date(checkedAt).toISOString(),
        applied_count: input.dryRun ? 0 : planned.length,
        actions: input.dryRun ? planned : planned.map((action) => ({ ...action, status: "applied" as const, after_status: "expired" }))
      });
    });
  }

  private async enqueueDeliveriesFromChat(input: Parameters<GatewayInboundPort["enqueueDeliveries"]>[0]): Promise<GatewayDeliveryRecord[]> {
    const agentMessage = [...input.chat.messages].reverse().find((message) => message.role === "agent");
    const text = typeof agentMessage?.content === "string" ? agentMessage.content : "";
    const payload = { text };
    return [await this.enqueueDelivery({
      id: createId("gateway_delivery"), inbound_id: input.inbound.id, session_key: input.sessionKey,
      channel: input.channel, status: "pending", idempotency_key: `gateway-reply:${input.inbound.id}:1`,
      payload, attempt: 0, max_attempts: 3, created_at: nowIso(), updated_at: nowIso()
    })];
  }

  private async withContext<T>(action: (sql: WorkspaceSql) => Promise<T>): Promise<T> {
    return this.database.withContext({ workspaceId: this.workspaceId, accountId: this.accountId }, action);
  }
}

export function createPostgresGatewayDomainServiceDependencies(options: PostgresGatewayAdapterOptions): GatewayDomainServiceDependencies {
  return new PostgresGatewayAdapter(options).dependencies();
}

function requiredRow(row: Row | undefined, code: string): Row {
  if (!row) throw new Error(code);
  return row;
}

function jsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value) as unknown; } catch { return value; }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function booleanValue(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  if (typeof value === "string") return value === "true" || value === "1";
  return false;
}

function pairingFromRow(row: Row): GatewayPairingRecord {
  return GatewayPairingRecordSchema.parse({
    id: row.id, channel: row.channel, source_identity: row.source_identity, source_label: row.source_label,
    status: row.status, pairing_code: optionalString(row.pairing_code), session_key: row.session_key,
    metadata: jsonValue(row.metadata), requested_at: row.requested_at, expires_at: optionalString(row.expires_at),
    resolved_at: optionalString(row.resolved_at), revoked_at: optionalString(row.revoked_at), updated_at: row.updated_at
  });
}

function pairingPolicyFromRow(row: Row): GatewayPairingPolicyRecord {
  return GatewayPairingPolicyRecordSchema.parse({
    id: row.id, channel: row.channel, status: row.status, trust_mode: row.trust_mode,
    allowlist: jsonValue(row.allowlist), allowed_tools: jsonValue(row.allowed_tools), pairing_ttl_ms: row.pairing_ttl_ms ?? undefined,
    duplicate_window_ms: row.duplicate_window_ms ?? undefined, rate_limit_window_ms: row.rate_limit_window_ms ?? undefined,
    rate_limit_max: row.rate_limit_max ?? undefined, metadata: jsonValue(row.metadata), created_at: row.created_at, updated_at: row.updated_at
  });
}

function routingPolicyFromRow(row: Row): GatewayRoutingPolicyRecord {
  return GatewayRoutingPolicyRecordSchema.parse({
    id: row.id, channel: row.channel, status: row.status, session_key_strategy: row.session_key_strategy,
    default_account_id: optionalString(row.default_account_id), default_thread_id: optionalString(row.default_thread_id),
    default_route: row.default_route, metadata: jsonValue(row.metadata), created_at: row.created_at, updated_at: row.updated_at
  });
}

function mcpConfigFromRow(row: Row): GatewayMcpConfigRecord {
  const common = {
    id: row.id, server_name: row.server_name, enabled: booleanValue(row.enabled), allowed_tools: jsonValue(row.allowed_tools),
    config_ref: row.config_ref == null ? undefined : jsonValue(row.config_ref), secret_refs: jsonValue(row.secret_refs),
    metadata: jsonValue(row.metadata), created_at: row.created_at, updated_at: row.updated_at
  };
  return GatewayMcpConfigRecordSchema.parse(row.transport === "stdio"
    ? { ...common, transport: "stdio", stdio: jsonValue(row.stdio) }
    : { ...common, transport: "http", http: jsonValue(row.http) });
}

function inboundFromRow(row: Row): GatewayInboundMessageRecord {
  return GatewayInboundMessageRecordSchema.parse({
    id: row.id, channel: row.channel, source_identity: row.source_identity, body: row.body, status: row.status,
    trusted: booleanValue(row.trusted), session_key: optionalString(row.session_key), pairing_id: optionalString(row.pairing_id),
    message_id: optionalString(row.message_id), error: optionalString(row.error), metadata: jsonValue(row.metadata),
    created_at: row.created_at, updated_at: row.updated_at
  });
}

function boundaryFromRow(row: Row): GatewayBoundaryPolicy {
  return GatewayBoundaryPolicySchema.parse({
    id: row.id, source_channel: row.source_channel, source_identity: optionalString(row.source_identity), session_key: row.session_key,
    allowed_tools: jsonValue(row.allowed_tools), mcp_config_refs: jsonValue(row.mcp_config_refs), secret_refs: jsonValue(row.secret_refs),
    sandbox: jsonValue(row.sandbox), path_normalization: jsonValue(row.path_normalization), allowlist: jsonValue(row.allowlist),
    timeout_ms: row.timeout_ms ?? undefined, concurrency_lock: row.concurrency_lock == null ? undefined : jsonValue(row.concurrency_lock),
    metadata: jsonValue(row.metadata), created_at: row.created_at, updated_at: row.updated_at
  });
}

function lockFromRow(row: Row): GatewayConcurrencyLockRecord {
  return GatewayConcurrencyLockRecordSchema.parse({
    id: row.id, lock_key: row.lock_key, scope: row.scope, policy_id: optionalString(row.policy_id),
    owner_ref: row.owner_ref == null ? undefined : jsonValue(row.owner_ref), status: row.status,
    acquired_at: row.acquired_at, expires_at: row.expires_at, released_at: optionalString(row.released_at), metadata: jsonValue(row.metadata)
  });
}

function deliveryFromRow(row: Row): GatewayDeliveryRecord {
  return GatewayDeliveryRecordSchema.parse({
    id: row.id, inbound_id: optionalString(row.inbound_id), session_key: row.session_key, channel: row.channel, status: row.status,
    idempotency_key: row.idempotency_key, payload: jsonValue(row.payload), attempt: Number(row.attempt), max_attempts: Number(row.max_attempts),
    next_attempt_at: optionalString(row.next_attempt_at), lease_until: optionalString(row.lease_until),
    receipt: row.receipt == null ? undefined : jsonValue(row.receipt), last_error: optionalString(row.last_error),
    created_at: row.created_at, updated_at: row.updated_at, delivered_at: optionalString(row.delivered_at)
  });
}

function sandboxInstanceFromRow(row: Row): GatewaySandboxInstanceRecord {
  return GatewaySandboxInstanceRecordSchema.parse({
    id: row.id, instance_key: row.instance_key, scope: row.scope, backend: row.backend, status: row.status,
    sandbox: jsonValue(row.sandbox), session_key: optionalString(row.session_key), owner_ref: row.owner_ref == null ? undefined : jsonValue(row.owner_ref),
    workspace_root: optionalString(row.workspace_root), created_at: row.created_at, updated_at: row.updated_at,
    last_used_at: optionalString(row.last_used_at), deleted_at: optionalString(row.deleted_at), metadata: jsonValue(row.metadata)
  });
}

function sandboxSyncFromRow(row: Row): GatewaySandboxWorkspaceSyncRecord {
  return GatewaySandboxWorkspaceSyncRecordSchema.parse({
    id: row.id, instance_id: row.instance_id, instance_key: row.instance_key, direction: row.direction, status: row.status,
    workspace_root: optionalString(row.workspace_root), remote_workspace_root: optionalString(row.remote_workspace_root),
    file_count: row.file_count == null ? undefined : Number(row.file_count), byte_count: row.byte_count == null ? undefined : Number(row.byte_count),
    error: optionalString(row.error), started_at: row.started_at, completed_at: optionalString(row.completed_at), metadata: jsonValue(row.metadata)
  });
}

function deliveryIdentity(record: GatewayDeliveryRecord): Record<string, unknown> {
  return { inbound_id: record.inbound_id ?? null, session_key: record.session_key, channel: record.channel, payload: record.payload, max_attempts: record.max_attempts };
}

function repairPairingAction(pairing: GatewayPairingRecord, status: GatewayRepairAction["status"]): GatewayRepairAction {
  return { action: "expire_pairing", status, reason: "pairing_expired", target_ref: { kind: "gateway_pairing", id: pairing.id, uri: `gateway/pairings/${pairing.id}` }, before_status: pairing.status, after_status: "expired", metadata: {} };
}

function repairLockAction(lock: GatewayConcurrencyLockRecord, status: GatewayRepairAction["status"]): GatewayRepairAction {
  return { action: "expire_concurrency_lock", status, reason: "lock_expired", target_ref: { kind: "gateway_concurrency_lock", id: lock.id, uri: `gateway/concurrency-locks/${lock.id}` }, before_status: lock.status, after_status: "expired", metadata: { lock_key: lock.lock_key } };
}

function assertDate(value: string, code: string): void {
  if (!Number.isFinite(Date.parse(value))) throw new Error(code);
}

function limitValue(value: number | undefined): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? Math.min(value, 500) : 100;
}
