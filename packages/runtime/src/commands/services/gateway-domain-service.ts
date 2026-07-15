import {
  GatewayMcpConfigRecordSchema,
  GatewayPairingPolicyRecordSchema,
  GatewayRoutingPolicyRecordSchema,
  GatewaySandboxWorkspaceSyncDirectionSchema,
  nowIso,
  type GatewayBoundaryPolicy,
  type GatewayConcurrencyLockRecord,
  type GatewayDeliveryRecord,
  type GatewayInboundMessageRecord,
  type GatewayPairingRecord,
  type GatewayMcpConfigRecord,
  type GatewayPairingPolicyRecord,
  type GatewayRoutingPolicyRecord,
  type GatewayRepairResult,
  type GatewaySandboxInstanceRecord,
  type GatewaySandboxWorkspaceSyncResult,
  type GatewayChannel,
  type GatewaySandboxWorkspaceSyncDirection,
  type JsonValue
} from "@samurai-agent/core-schemas";
import type { ChatTurnResult } from "./conversation-domain-service.js";
import { approvePairing, createDefaultGatewayBoundaryPolicy, createGatewayInboundMessage, createPendingPairing, evaluateGatewayPairingPolicy, expirePairing, gatewayContextForPairing, rejectPairing, resolveGatewaySessionRouting, revokePairing, rotatePairingCode, type GatewayContext } from "@samurai-agent/gateway";

export interface GatewayInboundInput {
  channel: GatewayChannel; source_identity: string; body: string; source_label?: string; account_id?: string;
  thread_id?: string; route?: string; metadata?: Record<string, JsonValue>; backend_id?: string;
  input_locale?: string; output_locale?: string;
}

type GatewayChatResult = ChatTurnResult;
interface GatewaySession { id: string; session_key: string; title: string; ui_locale: ChatTurnResult["session"]["ui_locale"]; output_locale: ChatTurnResult["session"]["output_locale"]; created_at: string; updated_at: string }
interface GatewayInboundResult {
  inbound: GatewayInboundMessageRecord;
  pairing?: GatewayPairingRecord;
  boundaryPolicy?: GatewayBoundaryPolicy;
  concurrencyLock?: GatewayConcurrencyLockRecord;
  session?: GatewaySession;
  chat?: GatewayChatResult;
  deliveries?: GatewayDeliveryRecord[];
}
export interface GatewayInboundPort {
  expirePairings(): Promise<unknown>;
  getRoutingPolicy(channel: GatewayChannel): Promise<GatewayRoutingPolicyRecord>;
  getPairingPolicy(channel: GatewayChannel): Promise<GatewayPairingPolicyRecord>;
  saveInbound(record: GatewayInboundMessageRecord): Promise<GatewayInboundMessageRecord>;
  emit(name: string, payload: unknown): Promise<void>;
  findDuplicate(input: { channel: GatewayChannel; sourceIdentity: string; body: string; windowMs: number; externalMessageId?: string }): Promise<GatewayInboundMessageRecord | undefined>;
  isRateLimited(input: { channel: GatewayChannel; sourceIdentity: string; windowMs: number; maxMessages: number }): Promise<boolean>;
  findPairing(input: { channel: GatewayChannel; sourceIdentity: string; status: "approved" | "pending"; sessionKey: string }): Promise<GatewayPairingRecord | undefined>;
  getPairing(id: string): Promise<GatewayPairingRecord | undefined>;
  savePairing(record: GatewayPairingRecord): Promise<GatewayPairingRecord>;
  saveBoundaryPolicy(policy: GatewayBoundaryPolicy): Promise<GatewayBoundaryPolicy>;
  acquireLock(policy: GatewayBoundaryPolicy, inbound: GatewayInboundMessageRecord): Promise<{ acquired: boolean; lock: GatewayConcurrencyLockRecord }>;
  releaseLock(lockKey: string): Promise<unknown>;
  ensureSession(context: GatewayContext, title: string): Promise<GatewaySession>;
  runChat(input: { sessionId: string; body: string; backendId?: string; inputLocale?: string; outputLocale?: string; metadata: Record<string, JsonValue>; context: GatewayContext; boundaryPolicy: GatewayBoundaryPolicy }): Promise<GatewayChatResult>;
  enqueueDeliveries(input: { channel: GatewayChannel; inbound: GatewayInboundMessageRecord; sessionKey: string; chat: GatewayChatResult }): Promise<GatewayDeliveryRecord[]>;
  errorMessage(error: unknown): string;
  conflictError(message: string): Error;
}

export interface GatewayCommandPort {
  expireConcurrencyLocks(now?: string): Promise<GatewayConcurrencyLockRecord[]>;
  routeInbound(input: {
    channel: string;
    source_identity: string;
    body: string;
    source_label?: string;
    account_id?: string;
    thread_id?: string;
    route?: string;
    metadata: Record<string, JsonValue>;
    backend_id?: string;
    input_locale?: string;
    output_locale?: string;
  }): Promise<GatewayInboundResult>;
  saveMcpConfig(record: GatewayMcpConfigRecord): Promise<GatewayMcpConfigRecord>;
  savePairingPolicy(record: GatewayPairingPolicyRecord): Promise<GatewayPairingPolicyRecord>;
  saveRoutingPolicy(record: GatewayRoutingPolicyRecord): Promise<GatewayRoutingPolicyRecord>;
  deleteSandbox(id: string): Promise<GatewaySandboxInstanceRecord>;
  recreateSandbox(id: string): Promise<GatewaySandboxInstanceRecord>;
  syncSandbox(id: string, input: { direction?: GatewaySandboxWorkspaceSyncDirection; dryRun: boolean }): Promise<GatewaySandboxWorkspaceSyncResult>;
  repairState(input: { dryRun: boolean; now?: string }): Promise<GatewayRepairResult>;
}

export interface GatewayPairingPort {
  get(id: string): Promise<GatewayPairingRecord | undefined>;
  save(record: GatewayPairingRecord): Promise<GatewayPairingRecord>;
  expireAll(now: string): Promise<GatewayPairingRecord[]>;
  emitUpdated(record: GatewayPairingRecord): Promise<void>;
}

export interface GatewayDomainServiceDependencies {
  gateway: GatewayCommandPort;
  pairing: GatewayPairingPort;
  inbound: GatewayInboundPort;
  conflictError: (message: string) => Error;
  notFoundError: (message: string) => Error;
}

export class GatewayDomainService {
  constructor(private readonly dependencies: GatewayDomainServiceDependencies) {}

  async expireConcurrencyLocks(payload: Record<string, JsonValue>) {
    const locks = await this.dependencies.gateway.expireConcurrencyLocks(optionalString(payload.now) || undefined);
    return { expired_count: locks.length, locks };
  }

  routeInbound(payload: Record<string, JsonValue>) {
    const sourceIdentity = optionalString(payload.source_identity);
    const body = optionalString(payload.body) || optionalString(payload.content) || optionalString(payload.user_intent);
    if (!sourceIdentity || !body) {
      throw this.dependencies.conflictError("domain_command_gateway_inbound_source_body_required");
    }
    return this.dependencies.gateway.routeInbound({
      channel: optionalString(payload.channel),
      source_identity: sourceIdentity,
      body,
      source_label: optionalString(payload.source_label) || undefined,
      account_id: optionalString(payload.account_id) || undefined,
      thread_id: optionalString(payload.thread_id) || undefined,
      route: optionalString(payload.route) || undefined,
      metadata: recordValue(payload.metadata),
      backend_id: optionalString(payload.backend_id) || undefined,
      input_locale: optionalString(payload.input_locale) || undefined,
      output_locale: optionalString(payload.output_locale) || undefined
    });
  }

  async executeInbound(input: GatewayInboundInput): Promise<GatewayInboundResult> {
    const sourceIdentity = normalizeSourceIdentity(input.source_identity, this.dependencies.inbound.conflictError);
    const body = input.body.trim();
    if (!sourceIdentity || !body) throw this.dependencies.inbound.conflictError("gateway_source_and_body_required");
    await this.dependencies.inbound.expirePairings();
    const routingPolicy = await this.dependencies.inbound.getRoutingPolicy(input.channel);
    const routing = resolveGatewaySessionRouting(routingPolicy, { channel: input.channel, source_identity: sourceIdentity,
      source_label: input.source_label, account_id: input.account_id, thread_id: input.thread_id, route: input.route, metadata: input.metadata });
    const pairingPolicy = await this.dependencies.inbound.getPairingPolicy(input.channel);
    const evaluation = evaluateGatewayPairingPolicy(pairingPolicy, { channel: input.channel, source_identity: sourceIdentity });
    const metadata = inboundMetadata(input, sourceIdentity, routing.session_key, pairingPolicy, evaluation, routingPolicy, routing);
    if (!routing.allowed) return this.blockInbound(input.channel, sourceIdentity, body, metadata, "gateway_routing_policy_disabled");
    const duplicate = await this.dependencies.inbound.findDuplicate({ channel: input.channel, sourceIdentity, body,
      windowMs: evaluation.duplicate_window_ms, externalMessageId: optionalString(input.metadata?.message_id) || optionalString(input.metadata?.idempotency_key) || undefined });
    if (duplicate) return { inbound: duplicate, pairing: duplicate.pairing_id ? await this.dependencies.inbound.getPairing(duplicate.pairing_id) : undefined };
    if (!evaluation.allowed) return this.blockInbound(input.channel, sourceIdentity, body, metadata, pairingPolicyError(evaluation.reason));
    if (await this.dependencies.inbound.isRateLimited({ channel: input.channel, sourceIdentity, windowMs: evaluation.rate_limit_window_ms, maxMessages: evaluation.rate_limit_max }))
      return this.blockInbound(input.channel, sourceIdentity, body, metadata, "gateway_rate_limited");
    let pairing = await this.dependencies.inbound.findPairing({ channel: input.channel, sourceIdentity, status: "approved", sessionKey: routing.session_key });
    if (!pairing) {
      const pending = await this.dependencies.inbound.findPairing({ channel: input.channel, sourceIdentity, status: "pending", sessionKey: routing.session_key });
      const candidate = pending ? { ...pending, metadata: { ...pending.metadata, ...metadata }, updated_at: nowIso() }
        : createPendingPairing({ channel: input.channel, source_identity: sourceIdentity, source_label: input.source_label,
          account_id: routing.account_id, thread_id: routing.thread_id, route: routing.route, metadata }, nowIso(), { pairingTtlMs: evaluation.pairing_ttl_ms });
      if (evaluation.trusted_without_pairing) {
        pairing = await this.dependencies.inbound.savePairing(approvePairing({ ...candidate, metadata: { ...candidate.metadata, gateway_pairing_policy_auto_approved: true } }));
        await this.dependencies.inbound.emit("gateway.pairing.updated", pairing);
      } else {
        await this.dependencies.inbound.savePairing(candidate); await this.dependencies.inbound.emit("gateway.pairing.requested", candidate);
      }
    }
    if (!pairing) {
      const pending = await this.dependencies.inbound.findPairing({ channel: input.channel, sourceIdentity, status: "pending", sessionKey: routing.session_key });
      const inbound = await this.dependencies.inbound.saveInbound(createGatewayInboundMessage({ channel: input.channel, source_identity: sourceIdentity, body, pairing: pending, metadata }));
      await this.dependencies.inbound.emit("gateway.inbound.blocked", inbound); return { inbound, pairing: pending };
    }
    const inbound = await this.dependencies.inbound.saveInbound(createGatewayInboundMessage({ channel: input.channel, source_identity: sourceIdentity, body, pairing, metadata }));
    const context = gatewayContextForPairing(pairing);
    const boundaryPolicy = await this.dependencies.inbound.saveBoundaryPolicy(createDefaultGatewayBoundaryPolicy({
      source_channel: input.channel, source_identity: sourceIdentity, session_key: pairing.session_key, allowlist: evaluation.allowlist_snapshot }));
    await this.dependencies.inbound.emit("gateway.boundary_policy.saved", boundaryPolicy);
    const concurrencyLock = await this.dependencies.inbound.acquireLock(boundaryPolicy, inbound);
    if (!concurrencyLock.acquired) {
      const blocked = await this.dependencies.inbound.saveInbound({ ...inbound, status: "blocked", error: "gateway_concurrency_locked", updated_at: nowIso() });
      await this.dependencies.inbound.emit("gateway.inbound.blocked", blocked);
      return { inbound: blocked, pairing, boundaryPolicy, concurrencyLock: concurrencyLock.lock };
    }
    const session = await this.dependencies.inbound.ensureSession(context, `Gateway ${pairing.source_label || pairing.source_identity}`);
    try {
      await this.dependencies.inbound.emit("gateway.inbound.routed", inbound);
      const chat = await this.dependencies.inbound.runChat({ sessionId: session.id, body, backendId: input.backend_id,
        inputLocale: input.input_locale, outputLocale: input.output_locale, context, boundaryPolicy,
        metadata: { ...(input.metadata ?? {}), gateway_inbound_id: inbound.id, gateway_channel: input.channel,
          gateway_source_identity: sourceIdentity, gateway_pairing_policy_id: pairingPolicy.id,
          gateway_pairing_policy_trust_mode: pairingPolicy.trust_mode, gateway_routing_policy_id: routingPolicy.id,
          gateway_routing_session_key_strategy: routingPolicy.session_key_strategy, gateway_boundary_policy_id: boundaryPolicy.id } });
      const processed = await this.dependencies.inbound.saveInbound({ ...inbound, status: "processed",
        message_id: chat.messages.find((message) => message.role === "user")?.id, updated_at: nowIso() });
      const deliveries = await this.dependencies.inbound.enqueueDeliveries({ channel: input.channel, inbound: processed, sessionKey: pairing.session_key, chat });
      await this.dependencies.inbound.emit("gateway.inbound.processed", processed);
      return { inbound: processed, pairing, boundaryPolicy, concurrencyLock: concurrencyLock.lock, session, chat, deliveries };
    } catch (error) {
      const failed = await this.dependencies.inbound.saveInbound({ ...inbound, status: "failed", error: this.dependencies.inbound.errorMessage(error), updated_at: nowIso() });
      await this.dependencies.inbound.emit("gateway.inbound.failed", failed); throw error;
    } finally { await this.dependencies.inbound.releaseLock(concurrencyLock.lock.lock_key); }
  }

  private async blockInbound(channel: GatewayChannel, sourceIdentity: string, body: string, metadata: Record<string, JsonValue>, error: string): Promise<GatewayInboundResult> {
    const inbound = await this.dependencies.inbound.saveInbound({ ...createGatewayInboundMessage({ channel, source_identity: sourceIdentity, body, metadata }), error });
    await this.dependencies.inbound.emit("gateway.inbound.blocked", inbound); return { inbound };
  }

  saveMcpConfig(payload: Record<string, JsonValue>) {
    return this.dependencies.gateway.saveMcpConfig(GatewayMcpConfigRecordSchema.parse(payload));
  }

  savePairingPolicy(payload: Record<string, JsonValue>) {
    return this.dependencies.gateway.savePairingPolicy(GatewayPairingPolicyRecordSchema.parse(payload));
  }

  approvePairing(payload: Record<string, JsonValue>) { return this.approvePairingById(requiredString(payload, "pairing_id")); }
  expirePairings(payload: Record<string, JsonValue>) { return this.expirePairingsAt(optionalString(payload.now) || undefined); }
  rejectPairing(payload: Record<string, JsonValue>) { return this.rejectPairingById(requiredString(payload, "pairing_id")); }
  revokePairing(payload: Record<string, JsonValue>) { return this.revokePairingById(requiredString(payload, "pairing_id")); }
  rotatePairing(payload: Record<string, JsonValue>) { return this.rotatePairingById(requiredString(payload, "pairing_id")); }

  async approvePairingById(id: string): Promise<GatewayPairingRecord> {
    const pairing = await this.requirePairing(id);
    const fresh = expirePairing(pairing);
    const next = fresh.status === "expired" ? fresh : approvePairing(fresh);
    await this.dependencies.pairing.save(next);
    await this.dependencies.pairing.emitUpdated(next);
    return next;
  }

  async rejectPairingById(id: string): Promise<GatewayPairingRecord> {
    return this.persistPairing(rejectPairing(await this.requirePairing(id)));
  }

  async rotatePairingById(id: string): Promise<GatewayPairingRecord> {
    const fresh = expirePairing(await this.requirePairing(id));
    return this.persistPairing(fresh.status === "expired" ? fresh : rotatePairingCode(fresh));
  }

  async revokePairingById(id: string): Promise<GatewayPairingRecord> {
    return this.persistPairing(revokePairing(await this.requirePairing(id)));
  }

  async expirePairingsAt(now = nowIso()): Promise<GatewayPairingRecord[]> {
    const expired = await this.dependencies.pairing.expireAll(now);
    for (const pairing of expired) await this.dependencies.pairing.emitUpdated(pairing);
    return expired;
  }

  private async requirePairing(id: string): Promise<GatewayPairingRecord> {
    const pairing = await this.dependencies.pairing.get(id);
    if (!pairing) throw this.dependencies.notFoundError(`Gateway pairing not found: ${id}`);
    return pairing;
  }

  private async persistPairing(pairing: GatewayPairingRecord): Promise<GatewayPairingRecord> {
    const saved = await this.dependencies.pairing.save(pairing);
    await this.dependencies.pairing.emitUpdated(saved);
    return saved;
  }

  saveRoutingPolicy(payload: Record<string, JsonValue>) {
    return this.dependencies.gateway.saveRoutingPolicy(GatewayRoutingPolicyRecordSchema.parse(payload));
  }

  deleteSandbox(payload: Record<string, JsonValue>) { return this.dependencies.gateway.deleteSandbox(requiredString(payload, "sandbox_id")); }
  recreateSandbox(payload: Record<string, JsonValue>) { return this.dependencies.gateway.recreateSandbox(requiredString(payload, "sandbox_id")); }

  syncSandbox(payload: Record<string, JsonValue>) {
    const direction = GatewaySandboxWorkspaceSyncDirectionSchema.safeParse(payload.direction);
    return this.dependencies.gateway.syncSandbox(requiredString(payload, "sandbox_id"), {
      direction: direction.success ? direction.data : undefined,
      dryRun: payload.dry_run !== false
    });
  }

  repairState(payload: Record<string, JsonValue>) {
    return this.dependencies.gateway.repairState({
      dryRun: payload.dry_run !== false,
      now: optionalString(payload.now) || undefined
    });
  }
}

function optionalString(value: JsonValue | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

function requiredString(payload: Record<string, JsonValue>, key: string): string {
  const value = optionalString(payload[key]);
  if (!value) throw new Error(`domain_operation_required_field:${key}`);
  return value;
}

function recordValue(value: JsonValue | undefined): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, JsonValue> : {};
}

function normalizeSourceIdentity(value: string, conflict: (message: string) => Error): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 200 || /[\u0000-\u001F\u007F]/.test(normalized)) throw conflict("gateway_source_identity_invalid");
  return normalized;
}

function pairingPolicyError(reason: ReturnType<typeof evaluateGatewayPairingPolicy>["reason"]): string {
  if (reason === "policy_disabled") return "gateway_pairing_policy_disabled";
  if (reason === "policy_blocked") return "gateway_pairing_policy_blocked";
  return "gateway_source_not_allowed";
}

function inboundMetadata(
  input: GatewayInboundInput, sourceIdentity: string, sessionKey: string,
  policy: GatewayPairingPolicyRecord, evaluation: ReturnType<typeof evaluateGatewayPairingPolicy>,
  routingPolicy: GatewayRoutingPolicyRecord, routing: ReturnType<typeof resolveGatewaySessionRouting>
): Record<string, JsonValue> {
  return {
    ...(input.metadata ?? {}),
    gateway_pairing_policy: { id: policy.id, channel: policy.channel, status: policy.status, trust_mode: policy.trust_mode,
      allowlist_snapshot: evaluation.allowlist_snapshot, reason: evaluation.reason ?? null, pairing_ttl_ms: evaluation.pairing_ttl_ms,
      duplicate_window_ms: evaluation.duplicate_window_ms, rate_limit_window_ms: evaluation.rate_limit_window_ms, rate_limit_max: evaluation.rate_limit_max },
    gateway_routing_policy: { id: routingPolicy.id, channel: routingPolicy.channel, status: routingPolicy.status,
      session_key_strategy: routingPolicy.session_key_strategy, default_account_id: routingPolicy.default_account_id ?? null,
      default_thread_id: routingPolicy.default_thread_id ?? null, default_route: routingPolicy.default_route, reason: routing.reason ?? null },
    gateway_source_scope: { channel: input.channel, source_identity: sourceIdentity, source_label: input.source_label ?? sourceIdentity,
      account_id: routing.account_id, thread_id: routing.thread_id, requested_route: input.route?.trim() || "main",
      route: routing.route, session_key: sessionKey }
  };
}
