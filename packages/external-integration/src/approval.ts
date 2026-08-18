import { randomBytes } from "node:crypto";
import {
  ApprovalRequestSchema,
  ExternalIntegrationError,
  dangerousExternalOperations,
  hashCanonicalJson,
  hashOpaqueToken,
  stableCanonicalJson,
  type ApprovalRequest,
  type ExternalIntegrationStore,
  type DangerousExternalOperation
} from "./contracts.js";
import { createAuditEvent } from "./audit.js";

const approvalTtlMs = 10 * 60 * 1000;

export interface ApprovalServiceOptions {
  store: ExternalIntegrationStore;
  publicBaseUrl: string;
  now?: () => Date;
  random?: (bytes: number) => Buffer;
}

export interface PrepareApprovalInput {
  workspaceId: string;
  operation: string;
  target: Record<string, unknown>;
  input: unknown;
  accountId: string;
  roomId: string;
  expectedVersions: Record<string, number>;
  idempotencyKey: string;
}

export interface PreparedApproval {
  request: ApprovalRequest;
  approvalUrl: string;
  approvalToken: string;
}

export interface ExecuteApprovalInput {
  approvalId: string;
  accountId: string;
  roomId: string;
  input: unknown;
  currentVersions: Record<string, number>;
  run: () => Promise<Record<string, unknown>>;
}

export function approvalRequired(operation: string): boolean {
  return (dangerousExternalOperations as readonly string[]).includes(operation);
}

/** One-time, version-bound approval. Approval is only admission; execution is
 * a separate compare-and-swap transition and can still fail. */
export class ApprovalService {
  private readonly now: () => Date;
  private readonly random: (bytes: number) => Buffer;

  constructor(private readonly options: ApprovalServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.random = options.random ?? randomBytes;
  }

  async prepare(input: PrepareApprovalInput): Promise<PreparedApproval> {
    const token = this.random(32).toString("base64url");
    const now = this.now();
    const request = ApprovalRequestSchema.parse({
      id: `approval_${this.random(16).toString("hex")}`,
      workspace_id: input.workspaceId,
      operation: input.operation,
      target: input.target,
      canonical_input: canonicalInput(input.input),
      input_hash: hashCanonicalJson(input.input),
      account_id: input.accountId,
      room_id: input.roomId,
      expected_versions: input.expectedVersions,
      idempotency_key: input.idempotencyKey,
      state: "pending",
      approval_token_hash: hashOpaqueToken(token),
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + approvalTtlMs).toISOString()
    });
    const existing = (await this.options.store.listRecords("approval_request", { workspaceId: input.workspaceId, accountId: input.accountId }))
      .find((candidate) => candidate.idempotency_key === input.idempotencyKey);
    if (existing) return this.renewExisting(existing, request, token, input);
    const audit = createAuditEvent({ eventType: "approval.created", workspaceId: request.workspace_id, accountId: request.account_id, resourceType: "approval_request", resourceId: request.id, data: { operation: request.operation, room_id: request.room_id, input_hash: request.input_hash, expected_versions: request.expected_versions } });
    if (!await this.options.store.atomic([
      { kind: "create", type: "approval_request", record: request },
      { kind: "create", type: "audit_event", record: audit }
    ])) {
      // A concurrent retry can lose the durable idempotency unique-index race.
      // Re-read the committed request and apply the same intent comparison and
      // CAS token renewal as the normal retry path.
      const raced = (await this.options.store.listRecords("approval_request", { workspaceId: input.workspaceId, accountId: input.accountId }))
        .find((candidate) => candidate.idempotency_key === input.idempotencyKey);
      if (!raced) throw new ExternalIntegrationError("approval_replayed");
      return this.renewExisting(raced, request, token, input);
    }
    return { request, approvalUrl: this.approvalUrl(request, token), approvalToken: token };
  }

  private async renewExisting(existing: ApprovalRequest, requested: ApprovalRequest, token: string, input: PrepareApprovalInput): Promise<PreparedApproval> {
    if (!sameApprovalIntent(existing, requested)) throw new ExternalIntegrationError("approval_input_changed", "idempotency_key_reused_with_different_approval");
    const current = await this.status(existing.id);
    if (current.state !== "pending") throw new ExternalIntegrationError("approval_replayed");
    const version = await this.requireVersion(current.id);
    const renewed = ApprovalRequestSchema.parse({ ...current, approval_token_hash: hashOpaqueToken(token) });
    const audit = createAuditEvent({ eventType: "approval.renewed", workspaceId: current.workspace_id, accountId: current.account_id, resourceType: "approval_request", resourceId: current.id, data: { operation: current.operation, input_hash: current.input_hash, reason: input.idempotencyKey === requested.idempotency_key ? "idempotent_retry" : "idempotent_replay" } });
    if (!await this.options.store.atomic([
      { kind: "update", type: "approval_request", id: current.id, expectedVersion: version, record: renewed },
      { kind: "create", type: "audit_event", record: audit }
    ])) throw new ExternalIntegrationError("approval_replayed");
    return { request: renewed, approvalUrl: this.approvalUrl(renewed, token), approvalToken: token };
  }

  async approve(input: { approvalId: string; approvalToken: string; accountId: string; workspaceId?: string }): Promise<ApprovalRequest> {
    const request = await this.status(input.approvalId);
    // Approval is the user's durable intent. If the browser response was
    // disconnected after the CAS but before execution started, repeating the
    // same one-time URL must be able to resume execution instead of leaving an
    // already-approved request permanently stuck.
    if (request.state === "approved") {
      if (request.account_id !== input.accountId) throw new ExternalIntegrationError("approval_account_mismatch");
      this.assertWorkspace(request, input.workspaceId);
      this.assertApprovalToken(request, input.approvalToken);
      return request;
    }
    this.assertPending(request);
    if (request.account_id !== input.accountId) throw new ExternalIntegrationError("approval_account_mismatch");
    this.assertWorkspace(request, input.workspaceId);
    this.assertApprovalToken(request, input.approvalToken);
    const version = await this.requireVersion(request.id);
    const next = ApprovalRequestSchema.parse({ ...request, state: "approved", approved_at: this.now().toISOString(), approved_by: input.accountId });
    const audit = createAuditEvent({ eventType: "approval.approved", actorId: input.accountId, workspaceId: request.workspace_id, accountId: request.account_id, resourceType: "approval_request", resourceId: request.id, data: { operation: request.operation, input_hash: request.input_hash } });
    if (!await this.options.store.atomic([
      { kind: "update", type: "approval_request", id: request.id, expectedVersion: version, record: next },
      { kind: "create", type: "audit_event", record: audit }
    ])) throw new ExternalIntegrationError("approval_replayed");
    return next;
  }

  async deny(input: { approvalId: string; approvalToken: string; accountId: string; workspaceId?: string }): Promise<ApprovalRequest> {
    const request = await this.status(input.approvalId);
    if (request.account_id !== input.accountId) throw new ExternalIntegrationError("approval_account_mismatch");
    this.assertWorkspace(request, input.workspaceId);
    this.assertPending(request);
    this.assertApprovalToken(request, input.approvalToken);
    const version = await this.requireVersion(request.id);
    const next = ApprovalRequestSchema.parse({ ...request, state: "denied" });
    const audit = createAuditEvent({ eventType: "approval.denied", actorId: input.accountId, workspaceId: request.workspace_id, accountId: request.account_id, resourceType: "approval_request", resourceId: request.id, data: { operation: request.operation } });
    if (!await this.options.store.atomic([
      { kind: "update", type: "approval_request", id: request.id, expectedVersion: version, record: next },
      { kind: "create", type: "audit_event", record: audit }
    ])) throw new ExternalIntegrationError("approval_replayed");
    return next;
  }

  async status(approvalId: string): Promise<ApprovalRequest> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const request = await this.require(approvalId);
      if (!((request.state === "pending" || request.state === "approved") && this.isExpired(request))) return request;
      const version = await this.options.store.getRecordVersion("approval_request", request.id);
      if (!version) throw new ExternalIntegrationError("approval_not_found");
      const expired = ApprovalRequestSchema.parse({ ...request, state: "expired" });
      const audit = createAuditEvent({ eventType: "approval.expired", workspaceId: request.workspace_id, accountId: request.account_id, resourceType: "approval_request", resourceId: request.id, data: { operation: request.operation } });
      if (await this.options.store.atomic([
        { kind: "update", type: "approval_request", id: request.id, expectedVersion: version, record: expired },
        { kind: "create", type: "audit_event", record: audit }
      ])) return expired;
    }
    throw new ExternalIntegrationError("approval_outcome_unknown", "approval_expiry_state_unknown", false);
  }

  async view(input: { approvalId: string; approvalToken: string; accountId: string; workspaceId?: string }): Promise<ApprovalRequest> {
    const request = await this.status(input.approvalId);
    if (request.account_id !== input.accountId) throw new ExternalIntegrationError("approval_account_mismatch");
    this.assertWorkspace(request, input.workspaceId);
    this.assertApprovalToken(request, input.approvalToken);
    return request;
  }

  async execute(input: ExecuteApprovalInput): Promise<Record<string, unknown>> {
    const request = await this.status(input.approvalId);
    if (request.account_id !== input.accountId) throw new ExternalIntegrationError("approval_account_mismatch");
    if (request.room_id !== input.roomId) throw new ExternalIntegrationError("approval_room_mismatch");
    if (request.state !== "approved") {
      if (request.state === "pending") throw new ExternalIntegrationError("approval_required");
      throw new ExternalIntegrationError("approval_replayed");
    }
    if (request.input_hash !== hashCanonicalJson(input.input)) throw new ExternalIntegrationError("approval_input_changed");
    if (!sameVersions(request.expected_versions, input.currentVersions)) throw new ExternalIntegrationError("approval_version_changed");
    const version = await this.requireVersion(request.id);
    const executing = ApprovalRequestSchema.parse({ ...request, state: "executing", executing_at: this.now().toISOString(), execution_result: { status: "executing" } });
    if (!await this.options.store.updateRecord("approval_request", request.id, version, executing)) throw new ExternalIntegrationError("approval_replayed");
    let result: Record<string, unknown>;
    try {
      result = await input.run();
    } catch (error) {
      const reason = error instanceof Error ? error.message : "execution_error";
      if (isOutcomeUnknown(error)) {
        await this.markOutcomeUnknown(executing, input.accountId, reason);
        throw error;
      }
      let failed = false;
      try {
        failed = await this.markFailed(executing, input.accountId, reason);
      } catch {
        failed = false;
      }
      if (!failed) {
        try {
          await this.markOutcomeUnknown(executing, input.accountId, `failure_state_persistence:${reason}`);
        } catch {
          // The mutation may have committed and the state marker is also
          // uncertain. The caller still receives the explicit unknown code.
        }
        throw new ExternalIntegrationError("approval_outcome_unknown", "approval_failure_state_unknown", false);
      }
      throw error;
    }
    try {
      // The mutation has already run. From this point onward, any failure to
      // persist the terminal state is an unknown outcome, never a normal
      // approval failure: the caller must not retry the mutation blindly.
      const latestVersion = await this.requireVersion(request.id);
      const executed = ApprovalRequestSchema.parse({ ...executing, state: "executed", executed_at: this.now().toISOString(), execution_result: result });
      const persisted = await this.options.store.atomic([
        { kind: "update", type: "approval_request", id: request.id, expectedVersion: latestVersion, record: executed },
        { kind: "create", type: "audit_event", record: createAuditEvent({ eventType: "approval.executed", actorId: input.accountId, workspaceId: request.workspace_id, accountId: request.account_id, resourceType: "approval_request", resourceId: request.id, data: { operation: request.operation, input_hash: request.input_hash } }) }
      ]);
      if (!persisted) throw new ExternalIntegrationError("approval_outcome_unknown", "approval_execution_result_unknown", false);
      return result;
    } catch (error) {
      try {
        await this.markOutcomeUnknown(executing, input.accountId, error instanceof Error ? error.message : "execution_result_persistence_error");
      } catch {
        // The original execution already happened. If the recovery marker
        // also cannot be saved, the response still has to remain unknown.
      }
      if (error instanceof ExternalIntegrationError && error.code === "approval_outcome_unknown") throw error;
      throw new ExternalIntegrationError("approval_outcome_unknown", "approval_execution_result_unknown", false);
    }
  }

  /** Server startup calls this after a crash. Executing means the mutation may
   * already have committed, so it must never be turned into a false failure. */
  async recoverExecuting(): Promise<number> {
    const records = await this.options.store.listRecords("approval_request");
    let recovered = 0;
    for (const record of records) {
      if (record.state !== "executing") continue;
      await this.markOutcomeUnknown(record, record.account_id, "server_recovery");
      recovered += 1;
    }
    return recovered;
  }

  private approvalUrl(request: ApprovalRequest, token: string): string {
    const url = new URL("/approval", this.options.publicBaseUrl);
    url.searchParams.set("approval_id", request.id);
    url.searchParams.set("approval_token", token);
    url.searchParams.set("workspace_id", request.workspace_id);
    return url.toString();
  }

  private async require(id: string): Promise<ApprovalRequest> {
    const request = await this.options.store.getRecord("approval_request", id);
    if (!request) throw new ExternalIntegrationError("approval_not_found");
    return ApprovalRequestSchema.parse(request);
  }

  private async requireVersion(id: string): Promise<number> {
    const version = await this.options.store.getRecordVersion("approval_request", id);
    if (!version) throw new ExternalIntegrationError("approval_not_found");
    return version;
  }

  private assertPending(request: ApprovalRequest): void {
    if (this.isExpired(request)) throw new ExternalIntegrationError("approval_expired");
    if (request.state !== "pending") throw new ExternalIntegrationError("approval_replayed");
  }

  private assertWorkspace(request: ApprovalRequest, workspaceId: string | undefined): void {
    if (workspaceId !== undefined && request.workspace_id !== workspaceId) throw new ExternalIntegrationError("approval_account_mismatch");
  }

  private assertApprovalToken(request: ApprovalRequest, token: string): void {
    if (!token || hashOpaqueToken(token) !== request.approval_token_hash) throw new ExternalIntegrationError("approval_not_found");
  }

  private async markOutcomeUnknown(executing: ApprovalRequest, accountId: string, reason: string): Promise<void> {
    const latest = await this.options.store.getRecord("approval_request", executing.id);
    const version = await this.options.store.getRecordVersion("approval_request", executing.id);
    if (!latest || !version || latest.state !== "executing") return;
    const unknown = ApprovalRequestSchema.parse({ ...latest, state: "outcome_unknown", executed_at: this.now().toISOString(), failure_code: reason.slice(0, 200), execution_result: { status: "outcome_unknown" } });
    await this.options.store.atomic([
      { kind: "update", type: "approval_request", id: latest.id, expectedVersion: version, record: unknown },
      { kind: "create", type: "audit_event", record: createAuditEvent({ eventType: "approval.outcome_unknown", actorId: accountId, workspaceId: latest.workspace_id, accountId: latest.account_id, resourceType: "approval_request", resourceId: latest.id, data: { operation: latest.operation, reason: unknown.failure_code } }) }
    ]);
  }

  private async markFailed(executing: ApprovalRequest, accountId: string, reason: string): Promise<boolean> {
    const latest = await this.options.store.getRecord("approval_request", executing.id);
    const version = await this.options.store.getRecordVersion("approval_request", executing.id);
    if (!latest || !version || latest.state !== "executing") return false;
    const failed = ApprovalRequestSchema.parse({
      ...latest,
      state: "failed",
      executed_at: this.now().toISOString(),
      failure_code: reason.slice(0, 200),
      execution_result: { status: "failed" }
    });
    return this.options.store.atomic([
      { kind: "update", type: "approval_request", id: latest.id, expectedVersion: version, record: failed },
      { kind: "create", type: "audit_event", record: createAuditEvent({ eventType: "approval.failed", actorId: accountId, workspaceId: latest.workspace_id, accountId: latest.account_id, resourceType: "approval_request", resourceId: latest.id, data: { operation: latest.operation, reason: failed.failure_code } }) }
    ]);
  }

  private isExpired(request: ApprovalRequest): boolean {
    return new Date(request.expires_at).getTime() <= this.now().getTime();
  }
}

function isOutcomeUnknown(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { code?: unknown; message?: unknown };
  return value.code === "mcp_outcome_unknown"
    || value.code === "approval_outcome_unknown"
    || value.code === "outcome_unknown"
    || (typeof value.message === "string" && /outcome[_ -]?unknown/i.test(value.message));
}

function canonicalInput(input: unknown): string {
  return stableCanonicalJson(input);
}

function sameVersions(expected: Record<string, number>, current: Record<string, number>): boolean {
  const expectedKeys = Object.keys(expected).sort();
  const currentKeys = Object.keys(current).sort();
  return expectedKeys.length === currentKeys.length && expectedKeys.every((key, index) => key === currentKeys[index] && expected[key] === current[key]);
}

function sameApprovalIntent(left: ApprovalRequest, right: ApprovalRequest): boolean {
  return left.workspace_id === right.workspace_id
    && left.account_id === right.account_id
    && left.room_id === right.room_id
    && left.operation === right.operation
    && left.input_hash === right.input_hash
    && left.canonical_input === right.canonical_input
    && stableCanonicalJson(left.target) === stableCanonicalJson(right.target)
    && stableCanonicalJson(left.expected_versions) === stableCanonicalJson(right.expected_versions);
}
