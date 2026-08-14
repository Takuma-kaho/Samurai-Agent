import { createHash, createPublicKey, verify } from "node:crypto";
import { assertOpaqueId } from "./config";
import { WorkspaceServerError } from "./errors";

const maxSignatureAgeMs = 5 * 60 * 1000;

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
