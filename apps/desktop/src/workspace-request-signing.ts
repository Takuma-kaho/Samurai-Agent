import { createHash, createPublicKey } from "node:crypto";

/**
 * Desktop-owned copy of the stable Workspace Server request contract.
 * It intentionally contains no network behavior or private-key storage; it
 * only creates the exact canonical bytes that the Server verifies.
 */
export function createWorkspaceAccountSignaturePayload(input: {
  method: string;
  path: string;
  workspaceId?: string;
  operationId?: string;
  requestId: string;
  timestamp: string;
  body: unknown;
}): string {
  assertOpaqueId(input.requestId, "request_id_invalid");
  if (input.workspaceId) assertOpaqueId(input.workspaceId, "workspace_id_invalid");
  if (input.operationId) assertOpaqueId(input.operationId, "operation_id_invalid");
  const timestamp = Number(input.timestamp);
  if (!Number.isFinite(timestamp)) throw new Error("account_signature_timestamp_invalid");
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

export function workspaceAccountIdFromPublicKey(publicKey: string): string {
  try {
    const key = createPublicKey(publicKey.startsWith("base64:")
      ? { key: Buffer.from(publicKey.slice("base64:".length), "base64"), format: "der", type: "spki" }
      : publicKey);
    const spki = key.export({ format: "der", type: "spki" });
    return `account_${createHash("sha256").update(spki).digest("hex").slice(0, 40)}`;
  } catch {
    throw new Error("account_public_key_invalid");
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("account_signature_body_invalid");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  throw new Error("account_signature_body_invalid");
}

function assertOpaqueId(value: string, code: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw new Error(code);
}
