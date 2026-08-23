import { GatewayDeliveryRecordSchema, GatewayMcpConfigRecordSchema, GatewayPairingPolicyRecordSchema, GatewayRoutingPolicyRecordSchema, GatewaySandboxInstanceRecordSchema, GatewaySandboxWorkspaceSyncRecordSchema, type ExternalSendRecord, type GatewayBoundaryPolicy, type GatewayConcurrencyLockRecord, type GatewayDeliveryRecord, type GatewayInboundMessageRecord, type GatewayMcpConfigRecord, type GatewayPairingPolicyRecord, type GatewayPairingRecord, type GatewayRoutingPolicyRecord, type GatewaySandboxInstanceRecord, type GatewaySandboxWorkspaceSyncRecord } from "@samurai-agent/core-schemas";
import type { ExternalSendsTable, GatewayBoundaryPoliciesTable, GatewayConcurrencyLocksTable, GatewayDeliveriesTable, GatewayInboundMessagesTable, GatewayMcpConfigsTable, GatewayPairingPoliciesTable, GatewayPairingsTable, GatewayRoutingPoliciesTable, GatewaySandboxInstancesTable, GatewaySandboxWorkspaceSyncsTable } from "../kernel/workspace-db-schema";
import { parse, stringify } from "./serialization";

export function externalSendToRow(send: ExternalSendRecord): ExternalSendsTable {
  return {
    id: send.id,
    channel: send.channel,
    status: send.status,
    target_json: stringify(send.target),
    title: send.title,
    body: send.body,
    operation_id: send.operation_id ?? null,
    approval_request_id: send.approval_request_id ?? null,
    dispatch_result_json: send.dispatch_result ? stringify(send.dispatch_result) : null,
    created_at: send.created_at,
    updated_at: send.updated_at,
    dispatched_at: send.dispatched_at ?? null,
    dispatch_claim_token: null,
    dispatch_claimed_at: null,
    dispatch_lease_until: null
  };
}

export function externalSendFromRow(row: ExternalSendsTable): ExternalSendRecord {
  return {
    id: row.id,
    channel: row.channel as ExternalSendRecord["channel"],
    status: row.status as ExternalSendRecord["status"],
    target: parse(row.target_json),
    title: row.title,
    body: row.body,
    operation_id: row.operation_id ?? undefined,
    approval_request_id: row.approval_request_id ?? undefined,
    dispatch_result: row.dispatch_result_json ? parse(row.dispatch_result_json) : undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
    dispatched_at: row.dispatched_at ?? undefined
  };
}

export function gatewayPairingToRow(pairing: GatewayPairingRecord): GatewayPairingsTable {
  return {
    id: pairing.id,
    channel: pairing.channel,
    source_identity: pairing.source_identity,
    source_label: pairing.source_label,
    status: pairing.status,
    pairing_code: pairing.pairing_code ?? null,
    session_key: pairing.session_key,
    metadata_json: stringify(pairing.metadata),
    requested_at: pairing.requested_at,
    expires_at: pairing.expires_at ?? null,
    resolved_at: pairing.resolved_at ?? null,
    updated_at: pairing.updated_at
  };
}

export function gatewayPairingFromRow(row: GatewayPairingsTable): GatewayPairingRecord {
  return {
    id: row.id,
    channel: row.channel as GatewayPairingRecord["channel"],
    source_identity: row.source_identity,
    source_label: row.source_label,
    status: row.status as GatewayPairingRecord["status"],
    pairing_code: row.pairing_code ?? undefined,
    session_key: row.session_key,
    metadata: parse(row.metadata_json),
    requested_at: row.requested_at,
    expires_at: row.expires_at ?? undefined,
    resolved_at: row.resolved_at ?? undefined,
    updated_at: row.updated_at
  };
}

export function gatewayPairingPolicyToRow(policy: GatewayPairingPolicyRecord): GatewayPairingPoliciesTable {
  return {
    id: policy.id,
    channel: policy.channel,
    status: policy.status,
    trust_mode: policy.trust_mode,
    allowlist_json: stringify(policy.allowlist),
    allowed_tools_json: stringify(policy.allowed_tools),
    pairing_ttl_ms: policy.pairing_ttl_ms ?? null,
    duplicate_window_ms: policy.duplicate_window_ms ?? null,
    rate_limit_window_ms: policy.rate_limit_window_ms ?? null,
    rate_limit_max: policy.rate_limit_max ?? null,
    metadata_json: stringify(policy.metadata),
    created_at: policy.created_at,
    updated_at: policy.updated_at
  };
}

export function gatewayPairingPolicyFromRow(row: GatewayPairingPoliciesTable): GatewayPairingPolicyRecord {
  return {
    id: row.id,
    channel: row.channel as GatewayPairingPolicyRecord["channel"],
    status: row.status as GatewayPairingPolicyRecord["status"],
    trust_mode: row.trust_mode as GatewayPairingPolicyRecord["trust_mode"],
    allowlist: parse(row.allowlist_json),
    allowed_tools: parse(row.allowed_tools_json),
    pairing_ttl_ms: row.pairing_ttl_ms ?? undefined,
    duplicate_window_ms: row.duplicate_window_ms ?? undefined,
    rate_limit_window_ms: row.rate_limit_window_ms ?? undefined,
    rate_limit_max: row.rate_limit_max ?? undefined,
    metadata: parse(row.metadata_json),
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

export function gatewayRoutingPolicyToRow(policy: GatewayRoutingPolicyRecord): GatewayRoutingPoliciesTable {
  return {
    id: policy.id,
    channel: policy.channel,
    status: policy.status,
    session_key_strategy: policy.session_key_strategy,
    default_account_id: policy.default_account_id ?? null,
    default_thread_id: policy.default_thread_id ?? null,
    default_route: policy.default_route,
    metadata_json: stringify(policy.metadata),
    created_at: policy.created_at,
    updated_at: policy.updated_at
  };
}

export function gatewayRoutingPolicyFromRow(row: GatewayRoutingPoliciesTable): GatewayRoutingPolicyRecord {
  return {
    id: row.id,
    channel: row.channel as GatewayRoutingPolicyRecord["channel"],
    status: row.status as GatewayRoutingPolicyRecord["status"],
    session_key_strategy: row.session_key_strategy as GatewayRoutingPolicyRecord["session_key_strategy"],
    default_account_id: row.default_account_id ?? undefined,
    default_thread_id: row.default_thread_id ?? undefined,
    default_route: row.default_route,
    metadata: parse(row.metadata_json),
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

export function gatewayInboundMessageToRow(message: GatewayInboundMessageRecord): GatewayInboundMessagesTable {
  return {
    id: message.id,
    channel: message.channel,
    source_identity: message.source_identity,
    body: message.body,
    status: message.status,
    trusted: message.trusted ? 1 : 0,
    session_key: message.session_key ?? null,
    pairing_id: message.pairing_id ?? null,
    message_id: message.message_id ?? null,
    error: message.error ?? null,
    metadata_json: stringify(message.metadata),
    created_at: message.created_at,
    updated_at: message.updated_at
  };
}

export function gatewayInboundMessageFromRow(row: GatewayInboundMessagesTable): GatewayInboundMessageRecord {
  return {
    id: row.id,
    channel: row.channel as GatewayInboundMessageRecord["channel"],
    source_identity: row.source_identity,
    body: row.body,
    status: row.status as GatewayInboundMessageRecord["status"],
    trusted: row.trusted === 1,
    session_key: row.session_key ?? undefined,
    pairing_id: row.pairing_id ?? undefined,
    message_id: row.message_id ?? undefined,
    error: row.error ?? undefined,
    metadata: parse(row.metadata_json),
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

export function gatewayDeliveryToRow(record:GatewayDeliveryRecord):GatewayDeliveriesTable{return{id:record.id,inbound_id:record.inbound_id??null,session_key:record.session_key,channel:record.channel,status:record.status,idempotency_key:record.idempotency_key,payload_json:stringify(record.payload),attempt:record.attempt,max_attempts:record.max_attempts,next_attempt_at:record.next_attempt_at??null,lease_until:record.lease_until??null,receipt_json:record.receipt?stringify(record.receipt):null,last_error:record.last_error??null,created_at:record.created_at,updated_at:record.updated_at,delivered_at:record.delivered_at??null}}
export function gatewayDeliveryFromRow(row:GatewayDeliveriesTable):GatewayDeliveryRecord{return GatewayDeliveryRecordSchema.parse({id:row.id,inbound_id:row.inbound_id??undefined,session_key:row.session_key,channel:row.channel,status:row.status,idempotency_key:row.idempotency_key,payload:parse(row.payload_json),attempt:row.attempt,max_attempts:row.max_attempts,next_attempt_at:row.next_attempt_at??undefined,lease_until:row.lease_until??undefined,receipt:row.receipt_json?parse(row.receipt_json):undefined,last_error:row.last_error??undefined,created_at:row.created_at,updated_at:row.updated_at,delivered_at:row.delivered_at??undefined})}

export function gatewayBoundaryPolicyToRow(policy: GatewayBoundaryPolicy): GatewayBoundaryPoliciesTable {
  return {
    id: policy.id,
    source_channel: policy.source_channel,
    source_identity: policy.source_identity ?? null,
    session_key: policy.session_key,
    allowed_tools_json: stringify(policy.allowed_tools),
    mcp_config_refs_json: stringify(policy.mcp_config_refs),
    secret_refs_json: stringify(policy.secret_refs),
    sandbox_json: stringify(policy.sandbox),
    path_normalization_json: stringify(policy.path_normalization),
    allowlist_json: stringify(policy.allowlist),
    timeout_ms: policy.timeout_ms ?? null,
    concurrency_lock_json: policy.concurrency_lock ? stringify(policy.concurrency_lock) : null,
    metadata_json: stringify(policy.metadata),
    created_at: policy.created_at,
    updated_at: policy.updated_at
  };
}

export function gatewayBoundaryPolicyFromRow(row: GatewayBoundaryPoliciesTable): GatewayBoundaryPolicy {
  return {
    id: row.id,
    source_channel: row.source_channel as GatewayBoundaryPolicy["source_channel"],
    source_identity: row.source_identity ?? undefined,
    session_key: row.session_key,
    allowed_tools: parse(row.allowed_tools_json),
    mcp_config_refs: parse(row.mcp_config_refs_json),
    secret_refs: parse(row.secret_refs_json),
    sandbox: parse(row.sandbox_json),
    path_normalization: parse(row.path_normalization_json),
    allowlist: parse(row.allowlist_json),
    timeout_ms: row.timeout_ms ?? undefined,
    concurrency_lock: row.concurrency_lock_json ? parse(row.concurrency_lock_json) : undefined,
    metadata: parse(row.metadata_json),
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

export function gatewayMcpConfigToRow(config: GatewayMcpConfigRecord): GatewayMcpConfigsTable {
  return {
    id: config.id,
    server_name: config.server_name,
    transport: config.transport,
    enabled: config.enabled ? 1 : 0,
    allowed_tools_json: stringify(config.allowed_tools),
    config_ref_json: config.config_ref ? stringify(config.config_ref) : null,
    secret_refs_json: stringify(config.secret_refs),
    stdio_json: config.stdio ? stringify(config.stdio) : null,
    http_json: config.http ? stringify(config.http) : null,
    metadata_json: stringify(config.metadata),
    created_at: config.created_at,
    updated_at: config.updated_at
  };
}

export function gatewayMcpConfigFromRow(row: GatewayMcpConfigsTable): GatewayMcpConfigRecord {
  return GatewayMcpConfigRecordSchema.parse({
    id: row.id,
    server_name: row.server_name,
    transport: row.transport,
    enabled: row.enabled === 1,
    allowed_tools: parse(row.allowed_tools_json),
    config_ref: row.config_ref_json ? parse(row.config_ref_json) : undefined,
    secret_refs: parse(row.secret_refs_json),
    stdio: row.stdio_json ? parse(row.stdio_json) : undefined,
    http: row.http_json ? parse(row.http_json) : undefined,
    metadata: parse(row.metadata_json),
    created_at: row.created_at,
    updated_at: row.updated_at
  });
}

export function gatewayConcurrencyLockToRow(lock: GatewayConcurrencyLockRecord): GatewayConcurrencyLocksTable {
  return {
    id: lock.id,
    lock_key: lock.lock_key,
    scope: lock.scope,
    policy_id: lock.policy_id ?? null,
    owner_ref_json: lock.owner_ref ? stringify(lock.owner_ref) : null,
    status: lock.status,
    acquired_at: lock.acquired_at,
    expires_at: lock.expires_at,
    released_at: lock.released_at ?? null,
    metadata_json: stringify(lock.metadata)
  };
}

export function gatewayConcurrencyLockFromRow(row: GatewayConcurrencyLocksTable): GatewayConcurrencyLockRecord {
  return {
    id: row.id,
    lock_key: row.lock_key,
    scope: row.scope as GatewayConcurrencyLockRecord["scope"],
    policy_id: row.policy_id ?? undefined,
    owner_ref: row.owner_ref_json ? parse(row.owner_ref_json) : undefined,
    status: row.status as GatewayConcurrencyLockRecord["status"],
    acquired_at: row.acquired_at,
    expires_at: row.expires_at,
    released_at: row.released_at ?? undefined,
    metadata: parse(row.metadata_json)
  };
}

export function gatewaySandboxInstanceToRow(instance: GatewaySandboxInstanceRecord): GatewaySandboxInstancesTable {
  return {
    id: instance.id,
    instance_key: instance.instance_key,
    scope: instance.scope,
    backend: instance.backend,
    status: instance.status,
    sandbox_json: stringify(instance.sandbox),
    session_key: instance.session_key ?? null,
    owner_ref_json: instance.owner_ref ? stringify(instance.owner_ref) : null,
    workspace_root: instance.workspace_root ?? null,
    created_at: instance.created_at,
    updated_at: instance.updated_at,
    last_used_at: instance.last_used_at ?? null,
    deleted_at: instance.deleted_at ?? null,
    metadata_json: stringify(instance.metadata)
  };
}

export function gatewaySandboxInstanceFromRow(row: GatewaySandboxInstancesTable): GatewaySandboxInstanceRecord {
  return GatewaySandboxInstanceRecordSchema.parse({
    id: row.id,
    instance_key: row.instance_key,
    scope: row.scope,
    backend: row.backend,
    status: row.status,
    sandbox: parse(row.sandbox_json),
    session_key: row.session_key ?? undefined,
    owner_ref: row.owner_ref_json ? parse(row.owner_ref_json) : undefined,
    workspace_root: row.workspace_root ?? undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_used_at: row.last_used_at ?? undefined,
    deleted_at: row.deleted_at ?? undefined,
    metadata: parse(row.metadata_json)
  });
}

export function gatewaySandboxWorkspaceSyncToRow(sync: GatewaySandboxWorkspaceSyncRecord): GatewaySandboxWorkspaceSyncsTable {
  return {
    id: sync.id,
    instance_id: sync.instance_id,
    instance_key: sync.instance_key,
    direction: sync.direction,
    status: sync.status,
    workspace_root: sync.workspace_root ?? null,
    remote_workspace_root: sync.remote_workspace_root ?? null,
    file_count: sync.file_count ?? null,
    byte_count: sync.byte_count ?? null,
    error: sync.error ?? null,
    started_at: sync.started_at,
    completed_at: sync.completed_at ?? null,
    metadata_json: stringify(sync.metadata)
  };
}

export function gatewaySandboxWorkspaceSyncFromRow(row: GatewaySandboxWorkspaceSyncsTable): GatewaySandboxWorkspaceSyncRecord {
  return GatewaySandboxWorkspaceSyncRecordSchema.parse({
    id: row.id,
    instance_id: row.instance_id,
    instance_key: row.instance_key,
    direction: row.direction,
    status: row.status,
    workspace_root: row.workspace_root ?? undefined,
    remote_workspace_root: row.remote_workspace_root ?? undefined,
    file_count: row.file_count ?? undefined,
    byte_count: row.byte_count ?? undefined,
    error: row.error ?? undefined,
    started_at: row.started_at,
    completed_at: row.completed_at ?? undefined,
    metadata: parse(row.metadata_json)
  });
}
