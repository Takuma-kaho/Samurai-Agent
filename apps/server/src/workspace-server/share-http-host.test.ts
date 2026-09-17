import { mkdtemp, rm } from "node:fs/promises";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PublicShareManifestSchema } from "@samurai-agent/domain-api";
import { accountIdFromPublicKey, canonicalJson, createAccountSignaturePayload } from "@samurai-agent/workspace-server";
import { createWorkspaceShareHost, WorkspaceShareFileStore } from "./share-http-host";
import { PostgresWorkspaceShareCompletionImportWriter } from "./share-completion-import-writer";

describe("Workspace Share HTTP host composition", () => {
  it("uses a dedicated hashed file root and atomically promotes a staged copy", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "samurai-share-host-"));
    try {
      const files = new WorkspaceShareFileStore(root);
      const bytes = new TextEncoder().encode('{"format_version":1}');
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const staged = await files.stage({ workspaceId: "workspace-1", ownerKind: "draft", ownerId: "draft-1", revision: 1, bytes, sha256 });
      expect(staged.stagedPath).toMatch(/^workspace-shares\/staging\/share_file_/);
      expect(staged.finalPath).toMatch(/^workspace-shares\/published\/[a-f0-9]{64}\/draft\/[a-f0-9]{64}\/r1-/);
      await expect(files.read(staged.stagedPath)).resolves.toEqual(bytes);
      await files.rename(staged);
      await expect(files.read(staged.finalPath)).resolves.toEqual(bytes);
      await files.remove(staged.finalPath);
      await expect(files.read(staged.finalPath)).rejects.toMatchObject({ code: "workspace_share_file_not_found" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps unavailable and claim failures generic when the function returns no rows", async () => {
    const database = {
      withContext: vi.fn(async (_context: unknown, action: (sql: { query: () => Promise<{ rows: never[] }> }) => Promise<unknown>) => action({ query: async () => ({ rows: [] }) }))
    };
    const store = {
      getAccountPublicKey: vi.fn(async () => null),
      getAgent: vi.fn()
    } as never;
    const host = createWorkspaceShareHost({
      database,
      store,
      completion: {} as never,
      storageRoot: "/tmp/samurai-share-host-test",
      origin: "https://server.example/"
    });

    await expect(host.http.viewPublished({ locator: "L".repeat(43) })).rejects.toMatchObject({ code: "share_unavailable", status: 404 });
    await expect(host.http.claim({
      locator: "L".repeat(43),
      recipientAccountId: "account-1",
      targetOrigin: "https://target.example/",
      targetWorkspaceId: "workspace-target",
      operationId: "operation-1",
      contentHash: "a".repeat(64),
      requestHash: "b".repeat(64)
    })).rejects.toMatchObject({ code: "share_unavailable", status: 404 });
    await expect(host.resolvePublicIdentity(requestWithoutCredentials())).resolves.toBeNull();
    await expect(host.resolveAccountIdentity(requestWithoutCredentials())).rejects.toMatchObject({
      code: "account_authentication_required",
      status: 401
    });
    const status = {
      import_id: "operation-1",
      kind: "agent",
      status: "staging",
      phase: "fetch",
      retryable: true,
      failure_code: null,
      created_resource_ids: [],
      created_agent_id: null,
      committed_at: null
    } as const;
    const importStatus = vi.spyOn(host.service, "importStatus").mockResolvedValue(status);
    await expect(host.http.importStatus({ workspaceId: "workspace-target", accountId: "account-1", operationId: "operation-1" })).resolves.toEqual(status);
    expect(importStatus).toHaveBeenCalledWith({ workspaceId: "workspace-target", accountId: "account-1" }, { operation_id: "operation-1" });
    expect(host.service).toBeDefined();
  });

  it("installs the transaction-aware Completion writer in the standard host", async () => {
    const database = {
      withContext: vi.fn(async (_context: unknown, action: (sql: { query: () => Promise<{ rows: never[] }> }) => Promise<unknown>) => action({ query: async () => ({ rows: [] }) }))
    };
    const host = createWorkspaceShareHost({
      database,
      store: fakeStore() as never,
      completion: {} as never,
      storageRoot: "/tmp/samurai-share-host-writer-test",
      origin: "https://server.example/"
    });
    const serviceOptions = (host.service as unknown as { options: { importCommitter?: { writer?: unknown } } }).options;
    expect(serviceOptions.importCommitter).toBeDefined();
    expect(serviceOptions.importCommitter?.writer).toBeInstanceOf(PostgresWorkspaceShareCompletionImportWriter);
  });

  it("reads only a public/restricted projection and rejects a revoked or wrong recipient", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "samurai-share-public-"));
    try {
      const files = new WorkspaceShareFileStore(root);
      const manifest = PublicShareManifestSchema.parse({
        format_version: 1,
        kind: "room_knowledge",
        title: "Shared room",
        entries: [{ entry_id: "entry-1", kind: "knowledge", title: "Knowledge", content: "fixed", knowledge_kind: "fact", files: [] }]
      });
      const bytes = new TextEncoder().encode(JSON.stringify(manifest));
      const contentHash = createHash("sha256").update(bytes).digest("hex");
      const staged = await files.stage({ workspaceId: "workspace-source", ownerKind: "draft", ownerId: "share-1", revision: 1, bytes, sha256: contentHash });
      await files.rename(staged);
      let available = true;
      const database = fakeDatabase(async (text, values) => {
        if (!text.includes("samurai_workspace_share_public_lookup") || !available) return { rows: [] };
        const accountId = values?.[1];
        if (accountId !== "account-recipient") return { rows: [] };
        return { rows: [{
          workspace_id: "workspace-source",
          share_id: "share-1",
          title: "Shared room",
          visibility: "restricted",
          manifest_path: staged.finalPath,
          content_hash: contentHash,
          published_at: new Date().toISOString()
        }] };
      });
      const host = createWorkspaceShareHost({
        database,
        store: fakeStore(),
        completion: {} as never,
        storageRoot: root,
        origin: "https://server.example/"
      });

      await expect(host.http.viewPublished({ locator: "L".repeat(43) })).rejects.toMatchObject({ code: "share_unavailable", status: 404 });
      await expect(host.http.viewPublished({ locator: "L".repeat(43), accountId: "account-recipient" })).resolves.toMatchObject({
        title: "Shared room",
        visibility: "restricted",
        content_hash: contentHash,
        manifest
      });
      available = false;
      await expect(host.http.viewPublished({ locator: "L".repeat(43), accountId: "account-recipient" })).rejects.toMatchObject({ code: "share_unavailable", status: 404 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("locks claim inputs in the DB function and permits only an exact replay before revoke", async () => {
    let state: "active" | "revoked" | "wrong" = "active";
    const database = fakeDatabase(async (text) => {
      if (!text.includes("samurai_workspace_share_claim")) return { rows: [] };
      if (state === "wrong") return { rows: [] };
      if (state === "revoked") throw new Error("share_revoked");
      return { rows: [{
        claim_id: "share_claim_existing",
        share_id: "share-1",
        recipient_account_id: "account-recipient",
        target_origin: "https://target.example/",
        target_workspace_id: "workspace-target",
        operation_id: "operation-1",
        content_hash: "a".repeat(64),
        created_at: new Date().toISOString(),
        replayed: true
      }] };
    });
    const host = createWorkspaceShareHost({
      database,
      store: fakeStore(),
      completion: {} as never,
      storageRoot: "/tmp/samurai-share-claim-test",
      origin: "https://server.example/"
    });
    const input = {
      locator: "L".repeat(43),
      recipientAccountId: "account-recipient",
      targetOrigin: "https://target.example/",
      targetWorkspaceId: "workspace-target",
      operationId: "operation-1",
      contentHash: "a".repeat(64),
      requestHash: "b".repeat(64)
    };
    await expect(host.http.claim(input)).resolves.toMatchObject({ claim_id: "share_claim_existing", replayed: true });
    state = "wrong";
    await expect(host.http.claim({ ...input, recipientAccountId: "account-other" })).rejects.toMatchObject({ code: "share_unavailable", status: 404 });
    state = "revoked";
    await expect(host.http.claim(input)).rejects.toMatchObject({ code: "share_revoked", status: 410 });
  });

  it("rejects a tampered delegation/content and accepts an unregistered public-key identity", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicKeyText = publicKey.export({ format: "pem", type: "spki" }).toString();
    const accountId = accountIdFromPublicKey(publicKeyText);
    const root = await mkdtemp(path.join(os.tmpdir(), "samurai-share-content-"));
    try {
      const files = new WorkspaceShareFileStore(root);
      const manifest = PublicShareManifestSchema.parse({
        format_version: 1,
        kind: "room_knowledge",
        title: "Shared room",
        entries: [{ entry_id: "entry-1", kind: "knowledge", title: "Knowledge", content: "fixed", knowledge_kind: "fact", files: [] }]
      });
      const originalBytes = new TextEncoder().encode(JSON.stringify(manifest));
      const originalHash = createHash("sha256").update(originalBytes).digest("hex");
      const staged = await files.stage({ workspaceId: "workspace-source", ownerKind: "draft", ownerId: "share-1", revision: 1, bytes: originalBytes, sha256: originalHash });
      await files.rename(staged);
      let manifestPath = staged.finalPath;
      const database = fakeDatabase(async (text) => text.includes("samurai_workspace_share_claim_content") ? {
        rows: [{ workspace_id: "workspace-source", share_id: "share-1", manifest_path: manifestPath, content_hash: originalHash, recipient_account_id: accountId, target_origin: "https://target.example/", target_workspace_id: "workspace-target", operation_id: "operation-1" }]
      } : { rows: [] });
      const host = createWorkspaceShareHost({
        database,
        store: { ...fakeStore(), getAccountPublicKey: vi.fn(async () => undefined) } as never,
        completion: {} as never,
        storageRoot: root,
        origin: "https://server.example/"
      });
      const payload = {
        version: 1 as const,
        source_origin: "https://server.example/",
        share_id: "share-1",
        claim_id: "claim-1",
        recipient_account_id: accountId,
        target_origin: "https://target.example/",
        target_workspace_id: "workspace-target",
        operation_id: "operation-1",
        content_hash: originalHash,
        issued_at: new Date(Date.now() - 1_000).toISOString(),
        expires_at: new Date(Date.now() + 60_000).toISOString()
      };
      const signature = sign(null, Buffer.from(`samurai-share-import-v1\n${canonicalJson(payload)}`), privateKey).toString("base64url");
      await expect(host.http.getClaimContent?.({ locator: "L".repeat(43), claimId: "claim-1", recipientAccountId: accountId, delegation: { payload, public_key: publicKeyText, signature: "bad" } })).rejects.toMatchObject({ code: "workspace_share_delegation_invalid", status: 403 });

      await files.remove(staged.finalPath);
      const tampered = new TextEncoder().encode('{"tampered":true}');
      const tamperedStage = await files.stage({ workspaceId: "workspace-source", ownerKind: "draft", ownerId: "share-1", revision: 2, bytes: tampered, sha256: createHash("sha256").update(tampered).digest("hex") });
      await files.rename(tamperedStage);
      manifestPath = tamperedStage.finalPath;
      await expect(host.http.getClaimContent?.({ locator: "L".repeat(43), claimId: "claim-1", recipientAccountId: accountId, delegation: { payload, public_key: publicKeyText, signature } })).rejects.toMatchObject({ code: "workspace_share_content_hash_conflict", status: 409 });

      const requestId = "request-unknown-account";
      const timestamp = String(Date.now());
      const requestPayload = { method: "GET", path: "/api/v1/shares/locator", requestId, timestamp, body: {} };
      const requestSignature = sign(null, Buffer.from(createAccountSignaturePayload(requestPayload)), privateKey).toString("base64url");
      const request = requestWithHeaders({
        "x-samurai-public-key": publicKeyText,
        "x-samurai-request-id": requestId,
        "x-samurai-timestamp": timestamp,
        "x-samurai-signature": requestSignature
      });
      await expect(host.resolvePublicIdentity(request)).resolves.toMatchObject({ accountId, publicKey: publicKeyText.trim() });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function requestWithoutCredentials() {
  return {
    method: "GET",
    path: "/api/v1/shares/locator",
    body: {},
    header: () => undefined
  } as never;
}

function fakeStore() {
  return {
    getAccountPublicKey: vi.fn(async () => null),
    getAgent: vi.fn()
  };
}

function fakeDatabase(query: (text: string, values?: readonly unknown[]) => Promise<{ rows: readonly Record<string, unknown>[] }>) {
  return {
    withContext: vi.fn(async (_context: unknown, action: (sql: { query: typeof query }) => Promise<unknown>) => action({ query }))
  } as never;
}

function requestWithHeaders(headers: Record<string, string>) {
  return {
    method: "GET",
    path: "/api/v1/shares/locator",
    body: {},
    header: (name: string) => headers[name.toLowerCase()]
  } as never;
}
