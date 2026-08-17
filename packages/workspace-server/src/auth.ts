import { createHash, createPublicKey, verify } from "node:crypto";
import { assertOpaqueId } from "./config";
import { WorkspaceServerError } from "./errors";
import type {
  WorkspaceCaller,
  WorkspaceConnectionCaller,
  WorkspaceHumanCaller,
  WorkspaceMaintenanceCaller
} from "./types";

const maxSignatureAgeMs = 5 * 60 * 1000;
/** A Context caller is trusted only when this module minted the exact object.
 * This prevents a JSON body (or a structural TypeScript cast) from becoming a
 * human, Connection, or maintenance identity before PostgreSQL sees it. */
const trustedWorkspaceCallers = new WeakSet<object>();

export interface SignedAccountRequest {
  accountId: string;
  requestId: string;
  timestamp: string;
  signature: string;
}

export interface AccountSignaturePayload {
  method: string;
  path: string;
  workspaceId?: string;
  operationId?: string;
  requestId: string;
  timestamp: string;
  body: unknown;
}

/** The same canonical representation is usable by Native App and HTTP clients. */
export function createAccountSignaturePayload(input: AccountSignaturePayload): string {
  assertOpaqueId(input.requestId, "request_id_invalid");
  if (input.workspaceId) assertOpaqueId(input.workspaceId, "workspace_id_invalid");
  if (input.operationId) assertOpaqueId(input.operationId, "operation_id_invalid");
  const timestamp = Number(input.timestamp);
  if (!Number.isFinite(timestamp)) throw new WorkspaceServerError("account_signature_timestamp_invalid", 401);
  const bodyHash = createHash("sha256").update(canonicalJson(input.body)).digest("hex");
  return [
    "samurai-account-request-v1",
    input.method.toUpperCase(),
    input.path,
    input.workspaceId ?? "",
    input.operationId ?? "",
    input.requestId,
    String(Math.trunc(timestamp)),
    bodyHash
  ].join("\n");
}

export function verifyAccountSignature(input: {
  signed: SignedAccountRequest;
  publicKey: string;
  payload: AccountSignaturePayload;
  now?: number;
}): void {
  assertOpaqueId(input.signed.accountId, "account_id_invalid");
  assertAccountIdMatchesPublicKey(input.signed.accountId, input.publicKey);
  const timestamp = Number(input.signed.timestamp);
  const now = input.now ?? Date.now();
  if (!Number.isFinite(timestamp) || Math.abs(now - timestamp) > maxSignatureAgeMs) {
    throw new WorkspaceServerError("account_signature_expired", 401);
  }
  if (input.signed.requestId !== input.payload.requestId || input.signed.timestamp !== input.payload.timestamp) {
    throw new WorkspaceServerError("account_signature_payload_mismatch", 401);
  }
  let key: ReturnType<typeof createPublicKey>;
  let signature: Buffer;
  try {
    key = createPublicKey(input.publicKey.startsWith("base64:")
      ? { key: Buffer.from(input.publicKey.slice("base64:".length), "base64"), format: "der", type: "spki" }
      : input.publicKey);
    signature = Buffer.from(input.signed.signature, "base64url");
  } catch {
    throw new WorkspaceServerError("account_signature_invalid", 401);
  }
  const valid = verify(null, Buffer.from(createAccountSignaturePayload(input.payload)), key, signature);
  if (!valid) throw new WorkspaceServerError("account_signature_invalid", 401);
}

/**
 * Re-verifies the canonical request immediately before it becomes a trusted
 * internal caller. HTTP ingress uses this after resolving the Workspace and
 * operation ID; services never accept an equivalent object from their input.
 */
export function createVerifiedWorkspaceHumanCaller(input: {
  signed: SignedAccountRequest;
  publicKey: string;
  payload: AccountSignaturePayload;
  operationId: string;
}): WorkspaceHumanCaller {
  assertOpaqueId(input.operationId, "workspace_operation_id_invalid");
  if (input.payload.operationId !== input.operationId) {
    throw new WorkspaceServerError("account_signature_payload_mismatch", 401);
  }
  verifyAccountSignature({ signed: input.signed, publicKey: input.publicKey, payload: input.payload });
  const caller: WorkspaceHumanCaller = {
    kind: "human",
    principalAccountId: input.signed.accountId,
    requestId: input.signed.requestId,
    operationId: input.operationId,
    timestamp: input.signed.timestamp,
    canonicalPayloadHash: createHash("sha256").update(canonicalJson(input.payload)).digest("hex"),
    signature: input.signed.signature
  };
  trustedWorkspaceCallers.add(caller);
  return caller;
}

/** Connection Hosts run inside the Server process and must deliberately mint
 * their Context. No HTTP parser invokes this function. */
export function createInternalWorkspaceConnectionCaller(input: Omit<WorkspaceConnectionCaller, "kind">): WorkspaceConnectionCaller {
  assertOpaqueId(input.principalAccountId, "account_id_invalid");
  assertOpaqueId(input.connectionId, "workspace_connection_id_invalid");
  assertOpaqueId(input.requestId, "request_id_invalid");
  assertOpaqueId(input.operationId, "workspace_operation_id_invalid");
  if (!Number.isFinite(Number(input.timestamp))) throw new WorkspaceServerError("workspace_connection_timestamp_invalid", 400);
  const caller: WorkspaceConnectionCaller = { kind: "connection", ...input };
  trustedWorkspaceCallers.add(caller);
  return caller;
}

/** The scheduler uses a deployment-local maintenance Account. It has no HTTP
 * construction path and never becomes a human approval. */
export function createInternalWorkspaceMaintenanceCaller(input: Omit<WorkspaceMaintenanceCaller, "kind">): WorkspaceMaintenanceCaller {
  assertOpaqueId(input.principalAccountId, "account_id_invalid");
  assertOpaqueId(input.operationId, "workspace_operation_id_invalid");
  const caller: WorkspaceMaintenanceCaller = { kind: "maintenance", ...input };
  trustedWorkspaceCallers.add(caller);
  return caller;
}

export function isTrustedWorkspaceCaller(value: WorkspaceCaller | undefined): value is WorkspaceCaller {
  return Boolean(value && trustedWorkspaceCallers.has(value));
}

/** A trusted caller is meaningful only for the Account in the same database
 * Context. This prevents an internal caller object from being accidentally
 * paired with another Account when a Context is assembled. */
export function isTrustedWorkspaceCallerForAccount(
  value: WorkspaceCaller | undefined,
  accountId: string
): value is WorkspaceCaller {
  return isTrustedWorkspaceCaller(value) && value.principalAccountId === accountId;
}

/** A portable Account is bound to its public key, not to a server-local name. */
export function accountIdFromPublicKey(publicKey: string): string {
  try {
    const key = createPublicKey(publicKey.startsWith("base64:")
      ? { key: Buffer.from(publicKey.slice("base64:".length), "base64"), format: "der", type: "spki" }
      : publicKey);
    const spki = key.export({ format: "der", type: "spki" });
    return `account_${createHash("sha256").update(spki).digest("hex").slice(0, 40)}`;
  } catch {
    throw new WorkspaceServerError("account_public_key_invalid", 400);
  }
}

export function assertAccountIdMatchesPublicKey(accountId: string, publicKey: string): void {
  assertOpaqueId(accountId, "account_id_invalid");
  if (accountId !== accountIdFromPublicKey(publicKey)) {
    throw new WorkspaceServerError("account_id_public_key_mismatch", 401);
  }
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new WorkspaceServerError("account_signature_body_invalid", 400);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  throw new WorkspaceServerError("account_signature_body_invalid", 400);
}
