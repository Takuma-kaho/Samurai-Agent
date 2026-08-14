import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { accountIdFromPublicKey, createAccountSignaturePayload } from "@samurai-agent/workspace-server";
import { createWorkspaceAccountSignaturePayload, workspaceAccountIdFromPublicKey } from "./workspace-request-signing";

describe("Desktop Workspace Server signing contract", () => {
  it("uses the same Account name and canonical request bytes as the Server", () => {
    const { publicKey } = generateKeyPairSync("ed25519");
    const publicKeyPem = publicKey.export({ format: "pem", type: "spki" }).toString();
    const input = {
      method: "PUT",
      path: "/api/workspaces/workspace_a/records/knowledge/record_a",
      workspaceId: "workspace_a",
      operationId: "operation_a",
      requestId: "request_a",
      timestamp: "1786656000000",
      body: { z: 1, a: ["x", true] }
    };

    expect(workspaceAccountIdFromPublicKey(publicKeyPem)).toBe(accountIdFromPublicKey(publicKeyPem));
    expect(createWorkspaceAccountSignaturePayload(input)).toBe(createAccountSignaturePayload(input));
  });
});
