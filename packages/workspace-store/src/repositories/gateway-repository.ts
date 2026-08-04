import {
  GatewayDeliveryRecordSchema,
  GatewayMcpConfigRecordSchema,
  GatewayPairingPolicyRecordSchema,
  GatewayRoutingPolicyRecordSchema,
  GatewaySandboxInstanceRecordSchema,
  GatewaySandboxWorkspaceSyncRecordSchema,
  createId,
  nowIso,
  redactPrivateData,
  type ExternalSendRecord,
  type GatewayBoundaryPolicy,
  type GatewayConcurrencyLockRecord,
  type GatewayDeliveryRecord,
  type GatewayInboundMessageRecord,
  type GatewayMcpConfigRecord,
  type GatewayPairingPolicyRecord,
  type GatewayPairingRecord,
  type GatewayRoutingPolicyRecord,
  type GatewaySandboxInstanceRecord,
  type GatewaySandboxWorkspaceSyncRecord,
  type JsonValue
} from "@samurai-agent/core-schemas";
import { sql, type Kysely } from "kysely";
import type { WorkspaceDb } from "../kernel/workspace-db-schema";
import {
  externalSendFromRow,
  externalSendToRow,
  gatewayBoundaryPolicyFromRow,
  gatewayBoundaryPolicyToRow,
  gatewayConcurrencyLockFromRow,
  gatewayConcurrencyLockToRow,
  gatewayDeliveryFromRow,
  gatewayDeliveryToRow,
  gatewayInboundMessageFromRow,
  gatewayInboundMessageToRow,
  gatewayMcpConfigFromRow,
  gatewayMcpConfigToRow,
  gatewayPairingFromRow,
  gatewayPairingPolicyFromRow,
  gatewayPairingPolicyToRow,
  gatewayPairingToRow,
  gatewayRoutingPolicyFromRow,
  gatewayRoutingPolicyToRow,
  gatewaySandboxInstanceFromRow,
  gatewaySandboxInstanceToRow,
  gatewaySandboxWorkspaceSyncFromRow,
  gatewaySandboxWorkspaceSyncToRow
} from "./gateway-row-codecs";
import { stringify } from "./serialization";

/** Gateway pairing, routing, delivery, sandbox, and concurrency state. */
export class GatewayRepository {
  constructor(private readonly db: Kysely<WorkspaceDb>) {}

async saveExternalSend(send: ExternalSendRecord): Promise<ExternalSendRecord> {
  await this.db
    .insertInto("external_sends")
    .values(externalSendToRow(send))
    .onConflict((oc) => oc.column("id").doUpdateSet(externalSendToRow(send)))
    .execute();
  return send;
}

async getExternalSend(id: string, input: { operationIds?: string[] } = {}): Promise<ExternalSendRecord | undefined> {
  const operationIds = input.operationIds === undefined ? undefined : [...new Set(input.operationIds)];
  if (operationIds?.length === 0) return undefined;
  let query = this.db.selectFrom("external_sends").selectAll().where("id", "=", id);
  if (operationIds) query = query.where("operation_id", "in", operationIds);
  const row = await query.executeTakeFirst();
  return row ? externalSendFromRow(row) : undefined;
}

async listExternalSends(input: { operationIds?: string[] } = {}): Promise<ExternalSendRecord[]> {
  const operationIds = input.operationIds === undefined ? undefined : [...new Set(input.operationIds)];
  if (operationIds?.length === 0) return [];
  let query = this.db.selectFrom("external_sends").selectAll().orderBy("created_at", "desc");
  if (operationIds) query = query.where("operation_id", "in", operationIds);
  const rows = await query.execute();
  return rows.map(externalSendFromRow);
}

async saveGatewayPairingPolicy(policy: GatewayPairingPolicyRecord): Promise<GatewayPairingPolicyRecord> {
  const parsed = GatewayPairingPolicyRecordSchema.parse(policy);
  await this.db
    .insertInto("gateway_pairing_policies")
    .values(gatewayPairingPolicyToRow(parsed))
    .onConflict((oc) => oc.column("channel").doUpdateSet(gatewayPairingPolicyToRow(parsed)))
    .execute();
  return parsed;
}

async getGatewayPairingPolicy(channel: GatewayPairingPolicyRecord["channel"]): Promise<GatewayPairingPolicyRecord | undefined> {
  const row = await this.db.selectFrom("gateway_pairing_policies").selectAll().where("channel", "=", channel).executeTakeFirst();
  return row ? gatewayPairingPolicyFromRow(row) : undefined;
}

async listGatewayPairingPolicies(input: { status?: GatewayPairingPolicyRecord["status"] } = {}): Promise<GatewayPairingPolicyRecord[]> {
  let query = this.db.selectFrom("gateway_pairing_policies").selectAll();
  if (input.status) {
    query = query.where("status", "=", input.status);
  }
  const rows = await query.orderBy("updated_at", "desc").execute();
  return rows.map(gatewayPairingPolicyFromRow);
}

async saveGatewayRoutingPolicy(policy: GatewayRoutingPolicyRecord): Promise<GatewayRoutingPolicyRecord> {
  const parsed = GatewayRoutingPolicyRecordSchema.parse(policy);
  await this.db
    .insertInto("gateway_routing_policies")
    .values(gatewayRoutingPolicyToRow(parsed))
    .onConflict((oc) => oc.column("channel").doUpdateSet(gatewayRoutingPolicyToRow(parsed)))
    .execute();
  return parsed;
}

async getGatewayRoutingPolicy(channel: GatewayRoutingPolicyRecord["channel"]): Promise<GatewayRoutingPolicyRecord | undefined> {
  const row = await this.db.selectFrom("gateway_routing_policies").selectAll().where("channel", "=", channel).executeTakeFirst();
  return row ? gatewayRoutingPolicyFromRow(row) : undefined;
}

async listGatewayRoutingPolicies(input: { status?: GatewayRoutingPolicyRecord["status"] } = {}): Promise<GatewayRoutingPolicyRecord[]> {
  let query = this.db.selectFrom("gateway_routing_policies").selectAll();
  if (input.status) {
    query = query.where("status", "=", input.status);
  }
  const rows = await query.orderBy("updated_at", "desc").execute();
  return rows.map(gatewayRoutingPolicyFromRow);
}

async saveGatewayPairing(pairing: GatewayPairingRecord): Promise<GatewayPairingRecord> {
  await this.db
    .insertInto("gateway_pairings")
    .values(gatewayPairingToRow(pairing))
    .onConflict((oc) => oc.column("id").doUpdateSet(gatewayPairingToRow(pairing)))
    .execute();
  return pairing;
}

async getGatewayPairing(id: string): Promise<GatewayPairingRecord | undefined> {
  const row = await this.db.selectFrom("gateway_pairings").selectAll().where("id", "=", id).executeTakeFirst();
  return row ? gatewayPairingFromRow(row) : undefined;
}

async findGatewayPairing(input: {
  channel: GatewayPairingRecord["channel"];
  sourceIdentity: string;
  status?: GatewayPairingRecord["status"];
  sessionKey?: string;
}): Promise<GatewayPairingRecord | undefined> {
  let query = this.db
    .selectFrom("gateway_pairings")
    .selectAll()
    .where("channel", "=", input.channel)
    .where("source_identity", "=", input.sourceIdentity);
  if (input.status) {
    query = query.where("status", "=", input.status);
  }
  if (input.sessionKey) {
    query = query.where("session_key", "=", input.sessionKey);
  }
  const row = await query.orderBy("updated_at", "desc").executeTakeFirst();
  return row ? gatewayPairingFromRow(row) : undefined;
}

async listGatewayPairings(input: GatewayPairingRecord["status"] | {
  status?: GatewayPairingRecord["status"];
  channel?: GatewayPairingRecord["channel"];
  sourceIdentity?: string;
  sessionKey?: string;
  limit?: number;
} = {}): Promise<GatewayPairingRecord[]> {
  const filters = typeof input === "string" ? { status: input } : input;
  let query = this.db.selectFrom("gateway_pairings").selectAll();
  if (filters.status) {
    query = query.where("status", "=", filters.status);
  }
  if (filters.channel) {
    query = query.where("channel", "=", filters.channel);
  }
  if (filters.sourceIdentity) {
    query = query.where("source_identity", "=", filters.sourceIdentity);
  }
  if (filters.sessionKey) {
    query = query.where("session_key", "=", filters.sessionKey);
  }
  if (filters.limit !== undefined) {
    query = query.limit(filters.limit);
  }
  const rows = await query.orderBy("updated_at", "desc").execute();
  return rows.map(gatewayPairingFromRow);
}

async expireGatewayPairings(now = nowIso()): Promise<GatewayPairingRecord[]> {
  const pending = await this.listGatewayPairings("pending");
  const expired = pending.filter((pairing) =>
    pairing.expires_at && Date.parse(pairing.expires_at) <= Date.parse(now)
  ).map((pairing) => ({
    ...pairing,
    status: "expired" as const,
    pairing_code: undefined,
    resolved_at: now,
    updated_at: now
  }));
  for (const pairing of expired) {
    await this.saveGatewayPairing(pairing);
  }
  return expired;
}

async saveGatewayInboundMessage(message: GatewayInboundMessageRecord): Promise<GatewayInboundMessageRecord> {
  const safeMessage = {
    ...message,
    error: message.error ? redactPrivateData(message.error, { redactPii: true }) : undefined,
    metadata: redactPrivateData(message.metadata, { redactPii: true })
  };
  await this.db
    .insertInto("gateway_inbound_messages")
    .values(gatewayInboundMessageToRow(safeMessage))
    .onConflict((oc) => oc.column("id").doUpdateSet(gatewayInboundMessageToRow(safeMessage)))
    .execute();
  return safeMessage;
}

async listGatewayInboundMessages(input: { status?: GatewayInboundMessageRecord["status"]; limit?: number } = {}): Promise<GatewayInboundMessageRecord[]> {
  let query = this.db.selectFrom("gateway_inbound_messages").selectAll();
  if (input.status) {
    query = query.where("status", "=", input.status);
  }
  const rows = await query.orderBy("created_at", "desc").limit(input.limit ?? 50).execute();
  return rows.map(gatewayInboundMessageFromRow);
}

async enqueueGatewayDelivery(input:GatewayDeliveryRecord):Promise<GatewayDeliveryRecord>{const record=GatewayDeliveryRecordSchema.parse(input);await this.db.insertInto("gateway_deliveries").values(gatewayDeliveryToRow(record)).onConflict(oc=>oc.column("idempotency_key").doNothing()).execute();const saved=await this.db.selectFrom("gateway_deliveries").selectAll().where("idempotency_key","=",record.idempotency_key).executeTakeFirstOrThrow();const existing=gatewayDeliveryFromRow(saved);if(stringify(existing.payload)!==stringify(record.payload)||existing.session_key!==record.session_key||existing.channel!==record.channel)throw new Error("gateway_delivery_idempotency_mismatch");return existing}
async getGatewayDelivery(id:string):Promise<GatewayDeliveryRecord|undefined>{const row=await this.db.selectFrom("gateway_deliveries").selectAll().where("id","=",id).executeTakeFirst();return row?gatewayDeliveryFromRow(row):undefined}
async listGatewayDeliveries():Promise<GatewayDeliveryRecord[]>{return(await this.db.selectFrom("gateway_deliveries").selectAll().orderBy("created_at","desc").execute()).map(gatewayDeliveryFromRow)}
  /** Retention is initiated by maintenance but deletion stays with Gateway. */
  async removeGatewayDeliveries(deliveryIds: readonly string[]): Promise<number> {
    if (deliveryIds.length === 0) return 0;
    const result = await this.db.deleteFrom("gateway_deliveries").where("id", "in", [...deliveryIds]).executeTakeFirst();
    return Number(result.numDeletedRows ?? 0);
  }
async claimGatewayDelivery(id:string,input:{now:string;leaseUntil:string}):Promise<GatewayDeliveryRecord|undefined>{const updated=await this.db.updateTable("gateway_deliveries").set({status:"delivering",lease_until:input.leaseUntil,attempt:sql`attempt + 1`,updated_at:input.now}).where("id","=",id).whereRef("attempt","<","max_attempts").where(eb=>eb.or([eb("status","=","pending"),eb("status","=","retry_wait")])).where(eb=>eb.or([eb("next_attempt_at","is",null),eb("next_attempt_at","<=",input.now)])).where(eb=>eb.or([eb("lease_until","is",null),eb("lease_until","<=",input.now)])).executeTakeFirst();return Number(updated.numUpdatedRows)===1?this.getGatewayDelivery(id):undefined}
async completeGatewayDelivery(id:string,input:{now:string;receipt:Record<string,JsonValue>}):Promise<GatewayDeliveryRecord>{await this.db.updateTable("gateway_deliveries").set({status:"delivered",receipt_json:stringify(input.receipt),lease_until:null,next_attempt_at:null,last_error:null,delivered_at:input.now,updated_at:input.now}).where("id","=",id).where("status","=","delivering").execute();const delivery=await this.getGatewayDelivery(id);if(!delivery||delivery.status!=="delivered")throw new Error("gateway_delivery_not_claimed");return delivery}
async failGatewayDelivery(id:string,input:{now:string;error:string;retryAt?:string}):Promise<GatewayDeliveryRecord>{const current=await this.getGatewayDelivery(id);if(!current||current.status!=="delivering")throw new Error("gateway_delivery_not_claimed");const retry=Boolean(input.retryAt)&&current.attempt<current.max_attempts;await this.db.updateTable("gateway_deliveries").set({status:retry?"retry_wait":"failed",next_attempt_at:retry?input.retryAt!:null,lease_until:null,last_error:input.error,updated_at:input.now}).where("id","=",id).where("status","=","delivering").execute();return(await this.getGatewayDelivery(id))!}
async reconcileExpiredGatewayDeliveries(now=nowIso()):Promise<GatewayDeliveryRecord[]>{const expired=await this.db.selectFrom("gateway_deliveries").selectAll().where("status","=","delivering").where("lease_until","<=",now).execute();const reconciled:GatewayDeliveryRecord[]=[];for(const row of expired){const terminal=row.attempt>=row.max_attempts;await this.db.updateTable("gateway_deliveries").set({status:terminal?"failed":"retry_wait",next_attempt_at:terminal?null:now,lease_until:null,last_error:terminal?"gateway_delivery_max_attempts_exceeded":"gateway_delivery_lease_expired",updated_at:now}).where("id","=",row.id).where("status","=","delivering").where("lease_until","<=",now).execute();const saved=await this.getGatewayDelivery(row.id);if(saved)reconciled.push(saved)}return reconciled}

async saveGatewayBoundaryPolicy(policy: GatewayBoundaryPolicy): Promise<GatewayBoundaryPolicy> {
  await this.db
    .insertInto("gateway_boundary_policies")
    .values(gatewayBoundaryPolicyToRow(policy))
    .onConflict((oc) => oc.column("id").doUpdateSet(gatewayBoundaryPolicyToRow(policy)))
    .execute();
  return policy;
}

async getGatewayBoundaryPolicy(id: string): Promise<GatewayBoundaryPolicy | undefined> {
  const row = await this.db.selectFrom("gateway_boundary_policies").selectAll().where("id", "=", id).executeTakeFirst();
  return row ? gatewayBoundaryPolicyFromRow(row) : undefined;
}

async listGatewayBoundaryPolicies(input: { sourceChannel?: GatewayBoundaryPolicy["source_channel"]; sessionKey?: string } = {}): Promise<GatewayBoundaryPolicy[]> {
  let query = this.db.selectFrom("gateway_boundary_policies").selectAll();
  if (input.sourceChannel) {
    query = query.where("source_channel", "=", input.sourceChannel);
  }
  if (input.sessionKey) {
    query = query.where("session_key", "=", input.sessionKey);
  }
  const rows = await query.orderBy("updated_at", "desc").execute();
  return rows.map(gatewayBoundaryPolicyFromRow);
}

async saveGatewayMcpConfig(config: GatewayMcpConfigRecord): Promise<GatewayMcpConfigRecord> {
  const parsed = GatewayMcpConfigRecordSchema.parse(config);
  await this.db
    .insertInto("gateway_mcp_configs")
    .values(gatewayMcpConfigToRow(parsed))
    .onConflict((oc) => oc.column("id").doUpdateSet(gatewayMcpConfigToRow(parsed)))
    .execute();
  return parsed;
}

async getGatewayMcpConfig(id: string): Promise<GatewayMcpConfigRecord | undefined> {
  const row = await this.db.selectFrom("gateway_mcp_configs").selectAll().where("id", "=", id).executeTakeFirst();
  return row ? gatewayMcpConfigFromRow(row) : undefined;
}

async getGatewayMcpConfigByServerName(serverName: string): Promise<GatewayMcpConfigRecord | undefined> {
  const row = await this.db.selectFrom("gateway_mcp_configs").selectAll().where("server_name", "=", serverName).executeTakeFirst();
  return row ? gatewayMcpConfigFromRow(row) : undefined;
}

async listGatewayMcpConfigs(input: { enabled?: boolean; serverName?: string } = {}): Promise<GatewayMcpConfigRecord[]> {
  let query = this.db.selectFrom("gateway_mcp_configs").selectAll();
  if (input.enabled !== undefined) {
    query = query.where("enabled", "=", input.enabled ? 1 : 0);
  }
  if (input.serverName) {
    query = query.where("server_name", "=", input.serverName);
  }
  const rows = await query.orderBy("updated_at", "desc").execute();
  return rows.map(gatewayMcpConfigFromRow);
}

async acquireGatewayConcurrencyLock(input: {
  lockKey: string;
  scope: GatewayConcurrencyLockRecord["scope"];
  policyId?: string;
  ownerRef?: GatewayConcurrencyLockRecord["owner_ref"];
  ttlMs: number;
  metadata?: Record<string, JsonValue>;
  now?: string;
}): Promise<{ acquired: true; lock: GatewayConcurrencyLockRecord } | { acquired: false; lock: GatewayConcurrencyLockRecord }> {
  const now = input.now ?? nowIso();
  const existing = await this.getGatewayConcurrencyLock(input.lockKey);
  if (existing && existing.status === "acquired" && Date.parse(existing.expires_at) > Date.parse(now)) {
    return { acquired: false, lock: existing };
  }

  const lock: GatewayConcurrencyLockRecord = {
    id: existing?.id ?? createId("gateway_lock"),
    lock_key: input.lockKey,
    scope: input.scope,
    policy_id: input.policyId,
    owner_ref: input.ownerRef,
    status: "acquired",
    acquired_at: now,
    expires_at: new Date(Date.parse(now) + input.ttlMs).toISOString(),
    metadata: input.metadata ?? {}
  };
  await this.db
    .insertInto("gateway_concurrency_locks")
    .values(gatewayConcurrencyLockToRow(lock))
    .onConflict((oc) => oc.column("lock_key").doUpdateSet(gatewayConcurrencyLockToRow(lock)))
    .execute();
  return { acquired: true, lock };
}

async getGatewayConcurrencyLock(lockKey: string): Promise<GatewayConcurrencyLockRecord | undefined> {
  const row = await this.db.selectFrom("gateway_concurrency_locks").selectAll().where("lock_key", "=", lockKey).executeTakeFirst();
  return row ? gatewayConcurrencyLockFromRow(row) : undefined;
}

async releaseGatewayConcurrencyLock(lockKey: string, now = nowIso()): Promise<GatewayConcurrencyLockRecord | undefined> {
  const existing = await this.getGatewayConcurrencyLock(lockKey);
  if (!existing) {
    return undefined;
  }
  const released: GatewayConcurrencyLockRecord = {
    ...existing,
    status: Date.parse(existing.expires_at) <= Date.parse(now) ? "expired" : "released",
    released_at: now
  };
  await this.db
    .updateTable("gateway_concurrency_locks")
    .set(gatewayConcurrencyLockToRow(released))
    .where("lock_key", "=", lockKey)
    .execute();
  return released;
}

async expireGatewayConcurrencyLocks(now = nowIso()): Promise<GatewayConcurrencyLockRecord[]> {
  const locks = await this.listGatewayConcurrencyLocks({ status: "acquired", limit: 500 });
  const expired: GatewayConcurrencyLockRecord[] = [];
  for (const lock of locks) {
    if (Date.parse(lock.expires_at) > Date.parse(now)) {
      continue;
    }
    const released = await this.releaseGatewayConcurrencyLock(lock.lock_key, now);
    if (released) {
      expired.push(released);
    }
  }
  return expired;
}

async reclaimExpiredGatewayConcurrencyLocks(now=nowIso()):Promise<GatewayConcurrencyLockRecord[]>{return this.expireGatewayConcurrencyLocks(now)}

async listGatewayConcurrencyLocks(input: { status?: GatewayConcurrencyLockRecord["status"]; limit?: number } = {}): Promise<GatewayConcurrencyLockRecord[]> {
  let query = this.db.selectFrom("gateway_concurrency_locks").selectAll();
  if (input.status) {
    query = query.where("status", "=", input.status);
  }
  const rows = await query.orderBy("acquired_at", "desc").limit(input.limit ?? 50).execute();
  return rows.map(gatewayConcurrencyLockFromRow);
}

async saveGatewaySandboxInstance(instance: GatewaySandboxInstanceRecord): Promise<GatewaySandboxInstanceRecord> {
  const parsed = GatewaySandboxInstanceRecordSchema.parse(instance);
  await this.db
    .insertInto("gateway_sandbox_instances")
    .values(gatewaySandboxInstanceToRow(parsed))
    .onConflict((oc) => oc.column("instance_key").doUpdateSet(gatewaySandboxInstanceToRow(parsed)))
    .execute();
  return parsed;
}

async getGatewaySandboxInstance(idOrKey: string): Promise<GatewaySandboxInstanceRecord | undefined> {
  const row = await this.db
    .selectFrom("gateway_sandbox_instances")
    .selectAll()
    .where((eb) => eb.or([
      eb("id", "=", idOrKey),
      eb("instance_key", "=", idOrKey)
    ]))
    .executeTakeFirst();
  return row ? gatewaySandboxInstanceFromRow(row) : undefined;
}

async listGatewaySandboxInstances(input: {
  status?: GatewaySandboxInstanceRecord["status"];
  scope?: GatewaySandboxInstanceRecord["scope"];
  backend?: GatewaySandboxInstanceRecord["backend"];
  limit?: number;
} = {}): Promise<GatewaySandboxInstanceRecord[]> {
  let query = this.db.selectFrom("gateway_sandbox_instances").selectAll();
  if (input.status) {
    query = query.where("status", "=", input.status);
  }
  if (input.scope) {
    query = query.where("scope", "=", input.scope);
  }
  if (input.backend) {
    query = query.where("backend", "=", input.backend);
  }
  const rows = await query.orderBy("updated_at", "desc").limit(input.limit ?? 50).execute();
  return rows.map(gatewaySandboxInstanceFromRow);
}

async saveGatewaySandboxWorkspaceSync(sync: GatewaySandboxWorkspaceSyncRecord): Promise<GatewaySandboxWorkspaceSyncRecord> {
  const parsed = GatewaySandboxWorkspaceSyncRecordSchema.parse(sync);
  await this.db
    .insertInto("gateway_sandbox_workspace_syncs")
    .values(gatewaySandboxWorkspaceSyncToRow(parsed))
    .onConflict((oc) => oc.column("id").doUpdateSet(gatewaySandboxWorkspaceSyncToRow(parsed)))
    .execute();
  return parsed;
}

async listGatewaySandboxWorkspaceSyncs(input: {
  instanceId?: string;
  instanceKey?: string;
  status?: GatewaySandboxWorkspaceSyncRecord["status"];
  direction?: GatewaySandboxWorkspaceSyncRecord["direction"];
  limit?: number;
} = {}): Promise<GatewaySandboxWorkspaceSyncRecord[]> {
  let query = this.db.selectFrom("gateway_sandbox_workspace_syncs").selectAll();
  if (input.instanceId) {
    query = query.where("instance_id", "=", input.instanceId);
  }
  if (input.instanceKey) {
    query = query.where("instance_key", "=", input.instanceKey);
  }
  if (input.status) {
    query = query.where("status", "=", input.status);
  }
  if (input.direction) {
    query = query.where("direction", "=", input.direction);
  }
  const rows = await query.orderBy("started_at", "desc").limit(input.limit ?? 50).execute();
  return rows.map(gatewaySandboxWorkspaceSyncFromRow);
}


}
