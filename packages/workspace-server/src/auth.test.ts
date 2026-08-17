import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  accountIdFromPublicKey,
  canonicalJson,
  createAccountSignaturePayload,
  createVerifiedWorkspaceHumanCaller,
  isTrustedWorkspaceCaller,
  isTrustedWorkspaceCallerForAccount,
  verifyAccountSignature
} from "./auth";

describe("Workspace Account signatures", () => {
  it("binds an Account ID to its Ed25519 public key and verifies a signed request", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicKeyPem = publicKey.export({ format: "pem", type: "spki" }).toString();
    const accountId = accountIdFromPublicKey(publicKeyPem);
    const timestamp = String(Date.now());
    const payload = {
      method: "PUT",
      path: "/api/workspaces/workspace_a/records/note/record_a",
      workspaceId: "workspace_a",
      requestId: "request_a",
      timestamp,
      body: { z: 1, a: ["x", true] }
    };
    const signature = sign(null, Buffer.from(createAccountSignaturePayload(payload)), privateKey).toString("base64url");

    verifyAccountSignature({
      signed: { accountId, requestId: "request_a", timestamp, signature },
      publicKey: publicKeyPem,
      payload
    });

    expect(accountId).toMatch(/^account_[a-f0-9]{40}$/);
    expect(canonicalJson({ z: 1, a: true })).toBe('{"a":true,"z":1}');
  });

  it("rejects a name that is not derived from the signing key", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicKeyPem = publicKey.export({ format: "pem", type: "spki" }).toString();
    const timestamp = String(Date.now());
    const payload = { method: "GET", path: "/api/account/workspaces", requestId: "request_b", timestamp, body: {} };
    const signature = sign(null, Buffer.from(createAccountSignaturePayload(payload)), privateKey).toString("base64url");

    expect(() => verifyAccountSignature({
      signed: { accountId: "account_someone_else", requestId: "request_b", timestamp, signature },
      publicKey: publicKeyPem,
      payload
    })).toThrow("account_id_public_key_mismatch");
  });

  it("only marks a freshly verified request as a trusted human caller", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicKeyPem = publicKey.export({ format: "pem", type: "spki" }).toString();
    const accountId = accountIdFromPublicKey(publicKeyPem);
    const timestamp = String(Date.now());
    const payload = {
      method: "POST",
      path: "/api/workspaces/workspace_a/completion/policies",
      workspaceId: "workspace_a",
      operationId: "operation_a",
      requestId: "request_c",
      timestamp,
      body: { title: "Policy" }
    };
    const signature = sign(null, Buffer.from(createAccountSignaturePayload(payload)), privateKey).toString("base64url");
    const caller = createVerifiedWorkspaceHumanCaller({
      signed: { accountId, requestId: "request_c", timestamp, signature },
      publicKey: publicKeyPem,
      payload,
      operationId: "operation_a"
    });
    expect(isTrustedWorkspaceCaller(caller)).toBe(true);
    expect(isTrustedWorkspaceCallerForAccount(caller, accountId)).toBe(true);
    expect(isTrustedWorkspaceCallerForAccount(caller, "account_other")).toBe(false);
    expect(isTrustedWorkspaceCaller({ ...caller })).toBe(false);
    expect(() => createVerifiedWorkspaceHumanCaller({
      signed: { accountId, requestId: "request_c", timestamp, signature },
      publicKey: publicKeyPem,
      payload,
      operationId: "another_operation"
    })).toThrow("account_signature_payload_mismatch");
  });
});
