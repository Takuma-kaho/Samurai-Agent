import {
  createId,
  gatewayChannels,
  GatewayMcpConfigRecordSchema,
  GatewayPairingPolicyRecordSchema,
  GatewayRoutingPolicyRecordSchema,
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
  type JsonValue,
  type SupportedLocale
} from "@samurai-agent/core-schemas";
import type {
  GatewayMcpConfigSaveRequest,
  GatewayPairingPolicySaveRequest,
  GatewayRoutingPolicySaveRequest
} from "@samurai-agent/domain-operations";
import type { ChatTurnResult } from "./conversation-domain-service.js";
import {
  approvePairing,
  createDefaultGatewayBoundaryPolicy,
  createDefaultGatewayPairingPolicy,
  createDefaultGatewayRoutingPolicy,
  createGatewayInboundMessage,
  createPendingPairing,
  evaluateGatewayPairingPolicy,
  gatewayContextForPairing,
  resolveGatewaySessionRouting,
  type GatewayContext
} from "@samurai-agent/gateway";

export interface GatewayInboundInput {
  channel: GatewayChannel; source_identity: string; body: string; source_label?: string; account_id?: string;
  thread_id?: string; route?: string; metadata?: Record<string, JsonValue>; backend_id?: string;
  input_locale?: SupportedLocale; output_locale?: SupportedLocale;
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
  expirePairings(): Promise<GatewayPairingRecord[]>;
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
  releaseLock(lockKey: string): Promise<void>;
  ensureSession(context: GatewayContext, title: string): Promise<GatewaySession>;
  runChat(input: { sessionId: string; body: string; backendId?: string; inputLocale?: SupportedLocale; outputLocale?: SupportedLocale; metadata: Record<string, JsonValue>; context: GatewayContext; boundaryPolicy: GatewayBoundaryPolicy }): Promise<GatewayChatResult>;
  enqueueDeliveries(input: { channel: GatewayChannel; inbound: GatewayInboundMessageRecord; sessionKey: string; chat: GatewayChatResult }): Promise<GatewayDeliveryRecord[]>;
  errorMessage(error: unknown): string;
  conflictError(message: string): Error;
}

export interface GatewayCommandPort {
  expireConcurrencyLocks(now?: string): Promise<GatewayConcurrencyLockRecord[]>;
  deleteSandbox(id: string): Promise<GatewaySandboxInstanceRecord>;
  recreateSandbox(id: string): Promise<GatewaySandboxInstanceRecord>;
  syncSandbox(id: string, input: { direction?: GatewaySandboxWorkspaceSyncDirection; dryRun: boolean }): Promise<GatewaySandboxWorkspaceSyncResult>;
  repairState(input: { dryRun: boolean; now?: string }): Promise<GatewayRepairResult>;
}

/**
 * Persistence is deliberately narrower than a Domain handler. The Gateway
 * service owns record construction, timestamps, defaults, and merge rules.
 */
export interface GatewayPolicyPersistencePort {
  getMcpConfig(id: string): Promise<GatewayMcpConfigRecord | undefined>;
  saveMcpConfig(record: GatewayMcpConfigRecord): Promise<GatewayMcpConfigRecord>;
  listPairingPolicies(): Promise<GatewayPairingPolicyRecord[]>;
  getPairingPolicy(channel: GatewayChannel): Promise<GatewayPairingPolicyRecord | undefined>;
  savePairingPolicy(record: GatewayPairingPolicyRecord): Promise<GatewayPairingPolicyRecord>;
  emitPairingPolicySaved(record: GatewayPairingPolicyRecord): Promise<void>;
  listRoutingPolicies(): Promise<GatewayRoutingPolicyRecord[]>;
  getRoutingPolicy(channel: GatewayChannel): Promise<GatewayRoutingPolicyRecord | undefined>;
  saveRoutingPolicy(record: GatewayRoutingPolicyRecord): Promise<GatewayRoutingPolicyRecord>;
  emitRoutingPolicySaved(record: GatewayRoutingPolicyRecord): Promise<void>;
}

export interface GatewayPairingPort {
  get(id: string): Promise<GatewayPairingRecord | undefined>;
  save(record: GatewayPairingRecord): Promise<GatewayPairingRecord>;
  expireAll(now: string): Promise<GatewayPairingRecord[]>;
  emitUpdated(record: GatewayPairingRecord): Promise<void>;
}

export interface GatewayDomainServiceDependencies {
  gateway: GatewayCommandPort;
  policy: GatewayPolicyPersistencePort;
  pairing: GatewayPairingPort;
  inbound: GatewayInboundPort;
  notFoundError: (message: string) => Error;
}

export class GatewayDomainService {
  constructor(private readonly dependencies: GatewayDomainServiceDependencies) {}

  async expireConcurrencyLocks(input: { now?: string }) {
    const locks = await this.dependencies.gateway.expireConcurrencyLocks(input.now);
    return { expired_count: locks.length, locks };
  }

  routeInboundPrimitive(input: GatewayInboundInput) {
    return this.executeInbound(input);
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
      source_channel: input.channel,
      source_identity: sourceIdentity,
      session_key: pairing.session_key,
      allowed_tools: evaluation.allowed_tools_snapshot,
      allowlist: evaluation.allowlist_snapshot
    }));
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

  async saveMcpConfig(request: GatewayMcpConfigSaveRequest): Promise<GatewayMcpConfigRecord> {
    const existing = request.id ? await this.dependencies.policy.getMcpConfig(request.id) : undefined;
    const now = nowIso();
    const configRef = request.configRef === undefined ? existing?.config_ref : request.configRef ?? undefined;
    const common = {
      id: request.id ?? createId("gateway_mcp"),
      server_name: request.serverName,
      enabled: request.enabled ?? existing?.enabled ?? true,
      allowed_tools: request.allowedTools ?? existing?.allowed_tools ?? [],
      ...(configRef === undefined ? {} : { config_ref: configRef }),
      secret_refs: request.secretRefs ?? existing?.secret_refs ?? [],
      metadata: request.metadata ?? existing?.metadata ?? {},
      created_at: existing?.created_at ?? now,
      updated_at: now
    };
    const record = request.transport === "stdio"
      ? GatewayMcpConfigRecordSchema.parse({
          ...common,
          transport: "stdio",
          stdio: {
            command: request.stdio.command,
            args: request.stdio.args,
            ...(request.stdio.cwd === undefined ? {} : { cwd: request.stdio.cwd }),
            env: request.stdio.environment,
            secret_env: request.stdio.secretEnvironment,
            secret_files: request.stdio.secretFiles.map((file) => ({
              secret_ref_id: file.secretRefId,
              filename: file.filename,
              env: file.environmentName,
              ...(file.mode === undefined ? {} : { mode: file.mode })
            })),
            framing: request.stdio.framing,
            initialize: request.stdio.initialize,
            ...(request.stdio.timeoutMs === undefined ? {} : { timeout_ms: request.stdio.timeoutMs })
          }
        })
      : GatewayMcpConfigRecordSchema.parse({
          ...common,
          transport: "http",
          http: {
            endpoint_url: request.http.endpointUrl,
            headers: request.http.headers,
            secret_headers: request.http.secretHeaders,
            ...(request.http.timeoutMs === undefined ? {} : { timeout_ms: request.http.timeoutMs })
          }
        });
    return this.dependencies.policy.saveMcpConfig(record);
  }

  async listPairingPolicies(): Promise<GatewayPairingPolicyRecord[]> {
    const saved = await this.dependencies.policy.listPairingPolicies();
    const byChannel = new Map(saved.map((policy) => [policy.channel, policy]));
    const now = nowIso();
    return gatewayChannels.map((channel) => byChannel.get(channel) ?? defaultPairingPolicy(channel, now));
  }

  async getPairingPolicy(channel: GatewayChannel): Promise<GatewayPairingPolicyRecord> {
    return (await this.dependencies.policy.getPairingPolicy(channel)) ?? defaultPairingPolicy(channel, nowIso());
  }

  async savePairingPolicy(request: GatewayPairingPolicySaveRequest): Promise<GatewayPairingPolicyRecord> {
    const existing = await this.dependencies.policy.getPairingPolicy(request.channel);
    const baseline = existing ?? defaultPairingPolicy(request.channel, nowIso());
    const record = GatewayPairingPolicyRecordSchema.parse({
      ...baseline,
      status: request.status ?? baseline.status,
      trust_mode: request.trustMode ?? baseline.trust_mode,
      allowlist: request.allowlist ?? baseline.allowlist,
      allowed_tools: request.allowedTools ?? baseline.allowed_tools,
      pairing_ttl_ms: request.pairingTtlMs ?? baseline.pairing_ttl_ms,
      duplicate_window_ms: request.duplicateWindowMs ?? baseline.duplicate_window_ms,
      rate_limit_window_ms: request.rateLimitWindowMs ?? baseline.rate_limit_window_ms,
      rate_limit_max: request.rateLimitMax ?? baseline.rate_limit_max,
      metadata: request.metadata ?? baseline.metadata,
      created_at: existing?.created_at ?? baseline.created_at,
      updated_at: nowIso()
    });
    const saved = await this.dependencies.policy.savePairingPolicy(record);
    await this.dependencies.policy.emitPairingPolicySaved(saved);
    return saved;
  }

  async requirePairing(id: string): Promise<GatewayPairingRecord> {
    const pairing = await this.dependencies.pairing.get(id);
    if (!pairing) throw this.dependencies.notFoundError(`Gateway pairing not found: ${id}`);
    return pairing;
  }

  savePairing(record: GatewayPairingRecord): Promise<GatewayPairingRecord> {
    return this.dependencies.pairing.save(record);
  }

  emitPairingUpdated(record: GatewayPairingRecord): Promise<void> {
    return this.dependencies.pairing.emitUpdated(record);
  }

  expirePairingsPrimitive(now: string): Promise<GatewayPairingRecord[]> {
    return this.dependencies.pairing.expireAll(now);
  }

  async listRoutingPolicies(): Promise<GatewayRoutingPolicyRecord[]> {
    const saved = await this.dependencies.policy.listRoutingPolicies();
    const byChannel = new Map(saved.map((policy) => [policy.channel, policy]));
    const now = nowIso();
    return gatewayChannels.map((channel) => byChannel.get(channel) ?? createDefaultGatewayRoutingPolicy(channel, now));
  }

  async getRoutingPolicy(channel: GatewayChannel): Promise<GatewayRoutingPolicyRecord> {
    return (await this.dependencies.policy.getRoutingPolicy(channel)) ?? createDefaultGatewayRoutingPolicy(channel, nowIso());
  }

  async saveRoutingPolicy(request: GatewayRoutingPolicySaveRequest): Promise<GatewayRoutingPolicyRecord> {
    const existing = await this.dependencies.policy.getRoutingPolicy(request.channel);
    const baseline = existing ?? createDefaultGatewayRoutingPolicy(request.channel, nowIso());
    const record = GatewayRoutingPolicyRecordSchema.parse({
      ...baseline,
      status: request.status ?? baseline.status,
      session_key_strategy: request.sessionKeyStrategy ?? baseline.session_key_strategy,
      default_account_id: request.defaultAccountId === undefined
        ? baseline.default_account_id
        : request.defaultAccountId ?? undefined,
      default_thread_id: request.defaultThreadId === undefined
        ? baseline.default_thread_id
        : request.defaultThreadId ?? undefined,
      default_route: request.defaultRoute ?? baseline.default_route,
      metadata: request.metadata ?? baseline.metadata,
      created_at: existing?.created_at ?? baseline.created_at,
      updated_at: nowIso()
    });
    const saved = await this.dependencies.policy.saveRoutingPolicy(record);
    await this.dependencies.policy.emitRoutingPolicySaved(saved);
    return saved;
  }

  deleteSandbox(id: string) { return this.dependencies.gateway.deleteSandbox(id); }
  recreateSandbox(id: string) { return this.dependencies.gateway.recreateSandbox(id); }

  syncSandboxPrimitive(id: string, input: { direction?: GatewaySandboxWorkspaceSyncDirection; dryRun: boolean }) {
    return this.dependencies.gateway.syncSandbox(id, input);
  }

  repairStatePrimitive(input: { dryRun: boolean; now?: string }) {
    return this.dependencies.gateway.repairState(input);
  }
}

function optionalString(value: JsonValue | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

function defaultPairingPolicy(channel: GatewayChannel, now: string): GatewayPairingPolicyRecord {
  const base = createDefaultGatewayPairingPolicy(channel, now);
  const allowlist = gatewaySourceAllowlist();
  if (allowlist.length === 0) {
    return base;
  }
  return {
    ...base,
    allowlist,
    metadata: {
      ...base.metadata,
      source: "env_gateway_allowlist",
      env_allowlist: true
    }
  };
}

function gatewaySourceAllowlist(): string[] {
  return (process.env.SAMURAI_GATEWAY_SOURCE_ALLOWLIST ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
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
      allowlist_snapshot: evaluation.allowlist_snapshot, allowed_tools_snapshot: evaluation.allowed_tools_snapshot,
      reason: evaluation.reason ?? null, pairing_ttl_ms: evaluation.pairing_ttl_ms,
      duplicate_window_ms: evaluation.duplicate_window_ms, rate_limit_window_ms: evaluation.rate_limit_window_ms, rate_limit_max: evaluation.rate_limit_max },
    gateway_routing_policy: { id: routingPolicy.id, channel: routingPolicy.channel, status: routingPolicy.status,
      session_key_strategy: routingPolicy.session_key_strategy, default_account_id: routingPolicy.default_account_id ?? null,
      default_thread_id: routingPolicy.default_thread_id ?? null, default_route: routingPolicy.default_route, reason: routing.reason ?? null },
    gateway_source_scope: { channel: input.channel, source_identity: sourceIdentity, source_label: input.source_label ?? sourceIdentity,
      account_id: routing.account_id, thread_id: routing.thread_id, requested_route: input.route?.trim() || "main",
      route: routing.route, session_key: sessionKey }
  };
}
