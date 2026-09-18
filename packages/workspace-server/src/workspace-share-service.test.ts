import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { canonicalJson } from "./auth";
import { WorkspaceServerError } from "./errors";
import {
  InMemoryWorkspaceShareImportCapabilityRegistry,
  WorkspaceShareService,
  type WorkspaceShareContext,
  type WorkspaceShareFilePort,
  type WorkspaceShareManifest,
  type WorkspaceShareSourcePort,
  type WorkspaceShareSql,
  type WorkspaceShareImportTransport,
  type WorkspaceShareImportCommitter
} from "./workspace-share-service";

const workspaceId = "workspace-1";
const ownerId = "account-owner";
const recipientId = "account-recipient";
const now = new Date("2026-09-17T00:00:00.000Z");
const origin = "https://source.example/";
const targetOrigin = "https://target.example/";

describe("WorkspaceShareService", () => {
  it("bounds process-local import capabilities and sweeps expired entries", () => {
    let current = new Date("2026-09-17T00:00:00.000Z");
    const registry = new InMemoryWorkspaceShareImportCapabilityRegistry(() => current, 2);
    const makeCapability = (operationId: string) => ({
      workspaceId,
      recipientAccountId: recipientId,
      operationId,
      sourceOrigin: origin,
      locator: "L".repeat(43),
      claimId: `claim-${operationId}`,
      contentHash: "a".repeat(64),
      targetWorkspaceId: workspaceId,
      targetRoomId: null,
      delegation: importInput("a".repeat(64)).delegation,
      expiresAt: "2026-09-17T00:05:00.000Z"
    });
    const lookup = (operationId: string) => registry.get({
      workspaceId,
      recipientAccountId: recipientId,
      operationId,
      sourceOrigin: origin,
      locator: "L".repeat(43),
      claimId: `claim-${operationId}`,
      contentHash: "a".repeat(64),
      targetWorkspaceId: workspaceId,
      targetRoomId: null
    });

    registry.remember(makeCapability("capability-one"));
    registry.remember(makeCapability("capability-two"));
    registry.remember(makeCapability("capability-three"));
    expect(lookup("capability-one")).toBeNull();
    expect(lookup("capability-two")).not.toBeNull();
    expect(lookup("capability-three")).not.toBeNull();
    current = new Date("2026-09-17T00:05:01.000Z");
    expect(lookup("capability-two")).toBeNull();
    expect(lookup("capability-three")).toBeNull();
  });

  it("rejects unknown input keys and denies source management before reading source", async () => {
    const source = new FakeSource();
    const auth = new FakeAuth(false);
    const service = createService({ source, auth });
    const context = contextFor(ownerId);

    await expect(service.createDraft(context, {
      source_kind: "room_knowledge",
      source_id: "room-1",
      resource_refs: [{ id: "knowledge-1", version: 1 }],
      unexpected: true
    })).rejects.toMatchObject({ code: "workspace_share_draft_input_invalid" });
    await expect(service.createDraft(context, {
      source_kind: "room_knowledge",
      source_id: "room-1",
      resource_refs: [{ id: "knowledge-1", version: 1 }]
    })).rejects.toMatchObject({ code: "workspace_share_permission_denied", status: 403 });
    expect(source.calls).toBe(0);
  });

  it("keeps selected versions, enforces optimistic hash/version checks, and projects public access safely", async () => {
    const database = new FakeDatabase();
    const source = new FakeSource();
    const service = createService({ database, source });
    const context = contextFor(ownerId, "share-create-1");
    const created = await service.createDraft(context, {
      source_kind: "room_knowledge",
      source_id: "room-1",
      resource_refs: [{ id: "knowledge-1", version: 3 }]
    });
    expect(created.manifest.entries[0]?.entry_id).not.toBe("knowledge-1");
    expect(database.shares.get(created.draft_id)?.source_versions).toEqual([{ id: "knowledge-1", version: 3 }]);

    const changedManifest = { ...created.manifest, title: "公開用タイトル" };
    await expect(service.updateDraft(contextFor(ownerId, "share-update-conflict"), {
      draft_id: created.draft_id,
      expected_version: 9,
      manifest: changedManifest,
      visibility: "restricted",
      recipient_account_ids: [recipientId]
    })).rejects.toMatchObject({ code: "share_version_conflict", status: 409 });
    const updated = await service.updateDraft(contextFor(ownerId, "share-update-1"), {
      draft_id: created.draft_id,
      expected_version: created.version,
      manifest: changedManifest,
      visibility: "restricted",
      recipient_account_ids: [recipientId]
    });
    await expect(service.publish(contextFor(ownerId, "share-publish-conflict"), {
      draft_id: updated.draft_id,
      expected_version: updated.version,
      expected_content_hash: "0".repeat(64)
    })).rejects.toMatchObject({ code: "workspace_share_content_hash_conflict", status: 409 });
    const published = await service.publish(contextFor(ownerId, "share-publish-1"), {
      draft_id: updated.draft_id,
      expected_version: updated.version,
      expected_content_hash: updated.content_hash
    });
    expect(published.content_hash).toBe(updated.content_hash);

    await expect(service.viewPublished({ locator: database.shares.get(created.draft_id)!.public_locator!, accountId: "other-account" })).rejects.toMatchObject({ code: "share_unavailable", status: 404 });
    const safeView = await service.viewPublished({ locator: database.shares.get(created.draft_id)!.public_locator!, accountId: recipientId });
    expect(safeView).toMatchObject({ title: "公開用タイトル", visibility: "restricted", content_hash: updated.content_hash });
    expect(safeView).not.toHaveProperty("share_id");
    expect(safeView).not.toHaveProperty("recipient_account_ids");
    expect(safeView).not.toHaveProperty("manifest_path");

    const adminView = await service.view(context, { share_id: created.draft_id });
    expect(adminView.recipient_account_ids).toEqual([recipientId]);
    const revoked = await service.revoke(contextFor(ownerId, "share-revoke-1"), { share_id: created.draft_id, expected_version: published.version });
    expect(revoked.status).toBe("revoked");
    await expect(service.viewPublished({ locator: database.shares.get(created.draft_id)!.public_locator!, accountId: recipientId })).rejects.toMatchObject({ code: "share_unavailable", status: 404 });
  });

  it("serializes claim/revoke on the same share row and allows only the pre-revoke replay", async () => {
    const database = new FakeDatabase();
    const service = createService({ database });
    const context = contextFor(ownerId, "claim-share-create");
    const draft = await service.createDraft(context, createInput());
    const updated = await service.updateDraft(contextFor(ownerId, "claim-share-update"), {
      draft_id: draft.draft_id,
      expected_version: draft.version,
      manifest: draft.manifest,
      visibility: "restricted",
      recipient_account_ids: [recipientId]
    });
    const published = await service.publish(contextFor(ownerId, "claim-share-publish"), { draft_id: draft.draft_id, expected_version: updated.version, expected_content_hash: updated.content_hash });
    const recipientContext = contextFor(recipientId, "claim-1");
    const claimInput = { shareId: draft.draft_id, targetOrigin, targetWorkspaceId: "target-workspace", operationId: "claim-1", contentHash: published.content_hash, requestHash: "1".repeat(64), claimId: "claim-id" };
    const claim = await service.claim(recipientContext, claimInput);
    expect(await service.claim(recipientContext, claimInput)).toEqual(claim);
    await service.revoke(contextFor(ownerId, "claim-share-revoke"), { share_id: draft.draft_id, expected_version: published.version });
    expect(await service.claim(recipientContext, claimInput)).toEqual(claim);
    await expect(service.claim({ ...recipientContext, operationId: "claim-new" }, { ...claimInput, operationId: "claim-new", claimId: "claim-new" })).rejects.toMatchObject({ code: "share_revoked", status: 410 });

    const publicDraft = await service.createDraft(contextFor(ownerId, "public-share-create"), createInput("agent-1", "agent"));
    const publicUpdated = await service.updateDraft(contextFor(ownerId, "public-share-update"), { draft_id: publicDraft.draft_id, expected_version: publicDraft.version, manifest: publicDraft.manifest, visibility: "public", recipient_account_ids: [] });
    const publicPublished = await service.publish(contextFor(ownerId, "public-share-publish"), { draft_id: publicDraft.draft_id, expected_version: publicUpdated.version, expected_content_hash: publicUpdated.content_hash });
    await service.revoke(contextFor(ownerId, "public-share-revoke"), { share_id: publicDraft.draft_id, expected_version: publicPublished.version });
    await expect(service.claim({ ...recipientContext, operationId: "new-public-claim" }, { ...claimInput, shareId: publicDraft.draft_id, operationId: "new-public-claim", claimId: "new-public-claim", contentHash: publicPublished.content_hash })).rejects.toMatchObject({ code: "share_revoked", status: 410 });
  });

  it("checks destination authorization before external fetch and never starts execution", async () => {
    const database = new FakeDatabase();
    const auth = new FakeAuth(false);
    const transport = new FakeTransport();
    const committer = new FakeCommitter();
    const service = createService({ database, auth, transport, committer, serviceOrigin: targetOrigin });
    const manifest = agentManifest();
    const contentHash = hashManifest(manifest);
    const input = importInput(contentHash);
    await expect(service.import(contextFor("account-import", "import-1"), input)).rejects.toMatchObject({ code: "workspace_share_import_target_forbidden", status: 403 });
    expect(transport.calls).toBe(0);
    expect(committer.calls).toBe(0);

    auth.allowed = true;
    const staged = await service.import(contextFor("account-import", "import-1"), input);
    expect(staged.status).toBe("staging");
    expect(staged.created_agent_id).toBeNull();
    expect(transport.calls).toBe(0);
    expect(committer.calls).toBe(0);
    const lease = await service.claimImport(contextFor("account-import", "import-1"), { operation_id: "import-1" });
    expect(lease).not.toBeNull();
    await service.executeImportLease(contextFor("account-import", "import-1"), {
      operation_id: "import-1",
      lease_token: lease!.lease_token
    });
    const result = await service.settleImport(contextFor("account-import", "import-1"), {
      operation_id: "import-1",
      lease_token: lease!.lease_token
    });
    expect(result.status).toBe("committed");
    expect(result.created_agent_id).toBeTruthy();
    expect(transport.calls).toBe(1);
    expect(committer.calls).toBe(1);
    expect(committer.startedExecution).toBe(false);
    expect(committer.joinedRoom).toBe(false);
    expect(committer.changedDefaultAgent).toBe(false);
    expect(await service.importStatus(contextFor("account-import", "import-1"), { operation_id: "import-1" })).toEqual(result);
    expect(await service.import(contextFor("account-import", "import-1"), input)).toEqual(result);
    expect(transport.calls).toBe(1);

    const failedInput = importInput("f".repeat(64));
    failedInput.delegation.payload.content_hash = failedInput.content_hash;
    failedInput.delegation.payload.operation_id = "import-failed";
    const failed = await service.import(contextFor("account-import", "import-failed"), failedInput);
    expect(failed.status).toBe("staging");
    expect(failed.retryable).toBe(true);
    expect(failed.created_resource_ids).toEqual([]);
  });

  it("replays a completed mutation and exposes only a short-lived import lease", async () => {
    const database = new FakeDatabase();
    const source = new FakeSource();
    const service = createService({ database, source });
    const context = contextFor(ownerId, "replay-create");
    const input = createInput();
    const first = await service.createDraft(context, input);
    const replay = await service.createDraft(context, input);
    expect(replay).toEqual(first);
    expect(source.calls).toBe(1);

    const transport = new FailingTransport();
    const importService = createService({ database: new FakeDatabase(), transport, serviceOrigin: targetOrigin });
    const importContext = contextFor("account-import", "lease-import");
    const leaseInput = importInput(hashManifest(agentManifest()));
    leaseInput.delegation.payload.operation_id = "lease-import";
    const staged = await importService.import(importContext, leaseInput);
    expect(staged.status).toBe("staging");
    const lease = await importService.claimImport(importContext, { operation_id: "lease-import" });
    expect(lease).toMatchObject({ operation_id: "lease-import", phase: "fetch", content_hash: expect.any(String) });
    expect(lease).not.toHaveProperty("delegation");
    expect(lease).not.toHaveProperty("public_key");
    expect(await importService.claimImport(importContext, { operation_id: "lease-import" })).toBeNull();
    const renewed = await importService.heartbeatImport(importContext, { operation_id: "lease-import", lease_token: lease!.lease_token });
    expect(renewed.lease_token).toBe(lease!.lease_token);
    await expect(importService.settleImport(importContext, { operation_id: "lease-import", lease_token: lease!.lease_token })).rejects.toMatchObject({ code: "workspace_share_import_not_ready", status: 409 });
  });

  it("requires a newly signed capability after a process restart without fetching while it is missing", async () => {
    const database = new FakeDatabase();
    const transport = new FakeTransport();
    const committer = new FakeCommitter();
    const input = importInput(hashManifest(agentManifest()));
    input.delegation.payload.operation_id = "restart-import";
    const context = contextFor("account-import", "restart-import");
    const first = createService({ database, transport, committer, serviceOrigin: targetOrigin });
    await expect(first.import(context, input)).resolves.toMatchObject({ status: "staging" });
    expect(transport.calls).toBe(0);

    const restarted = createService({ database, transport, committer, serviceOrigin: targetOrigin });
    const lease = await restarted.claimImport(context, { operation_id: "restart-import" });
    expect(lease).not.toBeNull();
    await expect(restarted.executeImportLease(context, { operation_id: "restart-import", lease_token: lease!.lease_token }))
      .rejects.toMatchObject({ code: "authorization_refresh_required", status: 409 });
    expect(transport.calls).toBe(0);
    await expect(restarted.settleImportWorker(context, {
      operation_id: "restart-import",
      lease_token: lease!.lease_token,
      result: { status: "retryable", failureCode: "authorization_refresh_required" }
    })).resolves.toMatchObject({ status: "staging", failure_code: "authorization_refresh_required" });
    expect(await restarted.claimImport(context, { operation_id: "restart-import" })).toBeNull();

    await expect(restarted.import(context, input)).resolves.toMatchObject({ status: "staging", failure_code: null });
    const retryLease = await restarted.claimImport(context, { operation_id: "restart-import" });
    expect(retryLease).not.toBeNull();
    await restarted.executeImportLease(context, { operation_id: "restart-import", lease_token: retryLease!.lease_token });
    const committed = await restarted.settleImport(context, { operation_id: "restart-import", lease_token: retryLease!.lease_token });
    expect(committed.status).toBe("committed");
    expect(transport.calls).toBe(1);
    expect(committer.calls).toBe(1);
  });

  it("records a cleanup transaction when staging fails before a share row is visible", async () => {
    const database = new FakeDatabase();
    database.files.failStage = true;
    const service = createService({ database });
    await expect(service.createDraft(contextFor(ownerId, "stage-failure"), createInput())).rejects.toBeTruthy();
    expect(database.shares.size).toBe(0);
    expect([...database.transactions.values()].some((transaction) => transaction.status === "cleanup_pending")).toBe(true);
    expect(database.files.data.size).toBe(0);
  });
});

function contextFor(accountId: string, operationId = "operation-1"): WorkspaceShareContext {
  return { workspaceId, accountId, operationId };
}

function createInput(sourceId = "room-1", kind: "room_knowledge" | "agent" = "room_knowledge") {
  return kind === "room_knowledge"
    ? { source_kind: kind, source_id: sourceId, resource_refs: [{ id: "knowledge-1", version: 1 }] }
    : { source_kind: kind, source_id: sourceId, resource_refs: [{ id: "skill-1", version: 1 }] };
}

function roomManifest(): WorkspaceShareManifest {
  return {
    format_version: 1,
    kind: "room_knowledge",
    title: "Room knowledge",
    entries: [{ entry_id: "source-entry", kind: "knowledge", title: "Knowledge", content: "A fact", knowledge_kind: "fact", files: [] }]
  };
}

function agentManifest(): WorkspaceShareManifest {
  return {
    format_version: 1,
    kind: "agent",
    title: "Imported Agent",
    entries: [{ entry_id: "skill-entry", kind: "skill", title: "Skill", content: "Do the work", files: [] }],
    agent: { name: "Imported Agent", role: "Assistant", instructions: "Follow the manifest." }
  };
}

function hashManifest(manifest: WorkspaceShareManifest): string {
  return createHash("sha256").update(new TextEncoder().encode(canonicalJson(manifest))).digest("hex");
}

function importInput(contentHash: string) {
  return {
    source_origin: origin,
    locator: "L".repeat(43),
    claim_id: "claim-import",
    content_hash: contentHash,
    delegation: {
      payload: {
        version: 1,
        source_origin: origin,
        share_id: "source-share",
        claim_id: "claim-import",
        recipient_account_id: "account-import",
        target_origin: targetOrigin,
        target_workspace_id: workspaceId,
        operation_id: "import-1",
        content_hash: contentHash,
        issued_at: "2026-09-16T23:58:00.000Z",
        expires_at: "2026-09-17T00:03:00.000Z"
      },
      public_key: "public-key",
      signature: "signature"
    }
  };
}

function createService(input: {
  database?: FakeDatabase;
  source?: FakeSource;
  auth?: FakeAuth;
  transport?: FakeTransport;
  committer?: FakeCommitter;
  serviceOrigin?: string;
} = {}) {
  const database = input.database ?? new FakeDatabase();
  let sequence = 0;
  return new WorkspaceShareService({
    database,
    authorization: input.auth ?? new FakeAuth(true),
    files: database.files,
    source: input.source ?? new FakeSource(),
    importTransport: input.transport,
    importCommitter: input.committer,
    origin: input.serviceOrigin ?? origin,
    now: () => new Date(now),
    id: (purpose) => `${purpose}-${++sequence}`
  });
}

class FakeAuth {
  constructor(public allowed: boolean) {}
  async authorize(): Promise<boolean> { return this.allowed; }
}

class FakeSource implements WorkspaceShareSourcePort {
  calls = 0;
  async snapshot(input: { context: WorkspaceShareContext; sourceKind: "room_knowledge" | "agent"; sourceId: string; resourceRefs: readonly { id: string; version: number }[] }) {
    this.calls += 1;
    const manifest = input.sourceKind === "agent" ? agentManifest() : roomManifest();
    return { kind: input.sourceKind, sourceId: input.sourceId, title: manifest.title, manifest, sourceVersions: [...input.resourceRefs] };
  }
}

class FakeTransport implements WorkspaceShareImportTransport {
  calls = 0;
  async fetch() {
    this.calls += 1;
    const manifest = agentManifest();
    return { kind: "agent" as const, manifest, bytes: new TextEncoder().encode(canonicalJson(manifest)) };
  }
}

class FailingTransport implements WorkspaceShareImportTransport {
  async fetch(): Promise<never> { throw new Error("temporary source outage"); }
}

class FakeCommitter implements WorkspaceShareImportCommitter {
  calls = 0;
  startedExecution = false;
  joinedRoom = false;
  changedDefaultAgent = false;
  async commit(input: Parameters<WorkspaceShareImportCommitter["commit"]>[0]) {
    this.calls += 1;
    void input;
    return { createdAgentId: "created-agent", createdResourceIds: ["created-resource"] };
  }
}

type StoredShare = Record<string, any>;

class FakeDatabase {
  readonly shares = new Map<string, StoredShare>();
  readonly recipients = new Map<string, string[]>();
  readonly transactions = new Map<string, StoredShare>();
  readonly claims = new Map<string, StoredShare>();
  readonly imports = new Map<string, StoredShare>();
  readonly operations = new Map<string, StoredShare>();
  readonly files = new FakeFiles();

  async withContext(_context: WorkspaceShareContext, action: (sql: WorkspaceShareSql) => Promise<unknown>): Promise<any> {
    return action({ query: (text, values = []) => this.query(text, values) } as WorkspaceShareSql);
  }

  private async query(text: string, values: readonly unknown[]): Promise<{ rows: any[]; rowCount: number }> {
    const normalized = text.replace(/\s+/g, " ").trim();
    if (normalized.startsWith("INSERT INTO workspace_operations")) {
      const key = `${values[0]}:${values[1]}`;
      if (this.operations.has(key)) return { rows: [], rowCount: 0 };
      const row = { workspace_id: values[0], id: values[1], idempotency_key: values[1], actor_account_id: values[2], request_hash: values[3], status: "running", result: null, error_code: null };
      this.operations.set(key, row);
      return { rows: [{ id: values[1] }], rowCount: 1 };
    }
    if (normalized.startsWith("SELECT request_hash, status, result, error_code FROM workspace_operations")) {
      const row = this.operations.get(`${values[0]}:${values[1]}`);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (normalized.startsWith("SAVEPOINT") || normalized.startsWith("RELEASE SAVEPOINT") || normalized.startsWith("ROLLBACK TO SAVEPOINT")) return { rows: [], rowCount: 0 };
    if (normalized.startsWith("SELECT set_config('samurai.share_operation'")) return { rows: [{ set_config: "1" }], rowCount: 1 };
    if (normalized.startsWith("UPDATE workspace_operations SET status = 'completed'")) {
      const row = this.operations.get(`${values[0]}:${values[1]}`);
      if (row) { row.status = "completed"; row.result = JSON.parse(String(values[2])); row.error_code = null; }
      return { rows: [], rowCount: row ? 1 : 0 };
    }
    if (normalized.startsWith("UPDATE workspace_operations SET status = 'failed'")) {
      const row = this.operations.get(`${values[0]}:${values[1]}`);
      if (row) { row.status = "failed"; row.error_code = values[2]; }
      return { rows: [], rowCount: row ? 1 : 0 };
    }
    if (normalized.startsWith("SELECT * FROM workspace_shares")) {
      const workspace = String(values[0]);
      if (normalized.includes("public_locator")) {
        const row = [...this.shares.values()].find((candidate) => candidate.public_locator === values[0] && candidate.status === "active");
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }
      if (normalized.includes("source_kind") && normalized.includes("ORDER BY id")) {
        const kind = String(values[1]);
        const sourceId = String(values[2]);
        const account = String(values[3]);
        const after = values[4] ? String(values[4]) : null;
        const rows = [...this.shares.values()].filter((row) => row.workspace_id === workspace && row.source_kind === kind && (kind === "room_knowledge" ? row.source_room_id === sourceId : row.source_agent_id === sourceId) && (row.status === "active" || (row.status === "draft" && row.created_by === account)) && (!after || row.id > after)).sort((a, b) => a.id.localeCompare(b.id));
        return { rows, rowCount: rows.length };
      }
      const row = this.shares.get(String(values[1]));
      return { rows: row && row.workspace_id === workspace ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (normalized.startsWith("INSERT INTO workspace_shares")) {
      const [workspace_id, id, source_kind, source_room_id, source_agent_id, created_by, title, source_versions, created_at] = values;
      this.shares.set(String(id), { workspace_id, id, source_kind, source_room_id, source_agent_id, created_by, title, status: "draft", visibility: "restricted", revision: 1, source_versions: JSON.parse(String(source_versions)), manifest_path: null, content_hash: null, byte_size: null, public_locator: null, created_at, updated_at: created_at, published_at: null, revoked_at: null });
      return { rows: [], rowCount: 1 };
    }
    if (normalized.startsWith("SELECT recipient_account_id")) {
      const list = this.recipients.get(`${values[0]}:${values[1]}`) ?? [];
      return { rows: list.map((recipient_account_id) => ({ recipient_account_id })), rowCount: list.length };
    }
    if (normalized.startsWith("DELETE FROM workspace_share_recipients")) {
      this.recipients.delete(`${values[0]}:${values[1]}`);
      return { rows: [], rowCount: 1 };
    }
    if (normalized.startsWith("INSERT INTO workspace_share_recipients")) {
      const key = `${values[0]}:${values[1]}`;
      const list = this.recipients.get(key) ?? [];
      list.push(String(values[2]));
      this.recipients.set(key, list);
      return { rows: [], rowCount: 1 };
    }
    if (normalized.startsWith("SELECT id, entries, status FROM workspace_share_file_transactions")) {
      const ownerKind = normalized.includes("owner_kind = 'import'") ? "import" : "draft";
      const row = [...this.transactions.values()].filter((candidate) => candidate.workspace_id === values[0] && candidate.owner_kind === ownerKind && candidate.owner_id === values[1]).sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)) || String(b.id).localeCompare(String(a.id)))[0];
      return { rows: row ? [{ id: row.id, entries: row.entries, status: row.status }] : [], rowCount: row ? 1 : 0 };
    }
    if (normalized.startsWith("INSERT INTO workspace_share_file_transactions")) {
      const [, id, owner_kind, owner_id, actor_account_id, status, entries, created_at] = values;
      this.transactions.set(String(id), { workspace_id: values[0], id, owner_kind, owner_id, actor_account_id, status, entries: JSON.parse(String(entries)), created_at, updated_at: created_at });
      return { rows: [], rowCount: 1 };
    }
    if (normalized.startsWith("UPDATE workspace_share_file_transactions")) {
      const row = this.transactions.get(String(values[1]));
      if (row) { row.status = String(values[2]); row.updated_at = values[3]; }
      return { rows: [], rowCount: row ? 1 : 0 };
    }
    if (normalized.startsWith("DELETE FROM workspace_share_file_transactions")) {
      for (const [id, row] of this.transactions) if (row.workspace_id === values[0] && row.owner_kind === "draft" && row.owner_id === values[1]) this.transactions.delete(id);
      return { rows: [], rowCount: 1 };
    }
    if (normalized.startsWith("UPDATE workspace_shares SET title")) {
      const row = this.shares.get(String(values[1]));
      if (row) { row.title = values[2]; row.visibility = values[3]; row.revision = values[4]; row.updated_at = values[5]; }
      return { rows: [], rowCount: row ? 1 : 0 };
    }
    if (normalized.startsWith("UPDATE workspace_shares SET status = 'active'")) {
      const row = this.shares.get(String(values[1]));
      if (row) { row.status = "active"; row.revision = values[2]; row.manifest_path = values[3]; row.content_hash = values[4]; row.byte_size = values[5]; row.public_locator = values[6]; row.published_at = values[7]; row.updated_at = values[7]; }
      return { rows: [], rowCount: row ? 1 : 0 };
    }
    if (normalized.startsWith("UPDATE workspace_shares SET status = 'revoked'")) {
      const row = this.shares.get(String(values[1]));
      if (row) { row.status = "revoked"; row.revision = values[2]; row.revoked_at = values[3]; row.updated_at = values[3]; }
      return { rows: [], rowCount: row ? 1 : 0 };
    }
    if (normalized.startsWith("DELETE FROM workspace_shares")) {
      this.shares.delete(String(values[1]));
      return { rows: [], rowCount: 1 };
    }
    if (normalized.startsWith("SELECT * FROM workspace_share_claims")) {
      const row = [...this.claims.values()].find((candidate) => candidate.workspace_id === values[0] && candidate.share_id === values[1] && candidate.recipient_account_id === values[2] && candidate.target_origin === values[3] && candidate.target_workspace_id === values[4] && candidate.operation_id === values[5]);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (normalized.startsWith("INSERT INTO workspace_share_claims")) {
      const [workspace_id, id, share_id, recipient_account_id, target_origin, target_workspace_id, operation_id, request_hash, content_hash, created_at] = values;
      this.claims.set(String(id), { workspace_id, id, share_id, recipient_account_id, target_origin, target_workspace_id, operation_id, request_hash, content_hash, created_at });
      return { rows: [], rowCount: 1 };
    }
    if (normalized.startsWith("SELECT * FROM workspace_share_imports")) {
      const row = this.imports.get(`${values[0]}:${values[1]}`);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (normalized.startsWith("INSERT INTO workspace_share_imports")) {
      const [workspace_id, operation_id, recipient_account_id, kind, source_origin, source_share_id, source_locator, claim_id, request_hash, content_hash, target_room_id, reserved_agent_id, created_at] = values;
      this.imports.set(`${workspace_id}:${operation_id}`, { workspace_id, operation_id, recipient_account_id, kind, source_origin, source_share_id, source_locator, claim_id, request_hash, content_hash, target_room_id, reserved_agent_id, reserved_resource_ids: [], manifest_path: null, status: "staging", phase: "fetch", retryable: true, failure_code: null, result: null, created_at, updated_at: created_at, committed_at: null });
      return { rows: [], rowCount: 1 };
    }
    if (normalized.startsWith("UPDATE workspace_share_imports SET lease_token")) {
      const row = this.imports.get(`${values[0]}:${values[1]}`);
      if (row && row.status === "staging" && row.retryable && (!row.lease_token || new Date(String(row.lease_until)).getTime() <= new Date(String(values[4])).getTime())) {
        row.lease_token = values[2]; row.lease_until = values[3]; row.updated_at = values[3];
        return { rows: [row], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
    if (normalized.startsWith("UPDATE workspace_share_imports SET lease_until")) {
      const row = this.imports.get(`${values[0]}:${values[1]}`);
      if (row && row.status === "staging" && row.lease_token === values[2]) { row.lease_until = values[3]; row.updated_at = values[3]; return { rows: [row], rowCount: 1 }; }
      return { rows: [], rowCount: 0 };
    }
    if (normalized.startsWith("UPDATE workspace_share_imports SET failure_code = NULL")) {
      const row = this.imports.get(`${values[0]}:${values[1]}`);
      if (row && (row.failure_code === "authorization_refresh_required" || row.failure_code === "workspace_share_import_retry_exhausted")) {
        row.failure_code = null;
        row.updated_at = values[2];
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
    if (normalized.startsWith("UPDATE workspace_share_imports SET reserved_agent_id") && normalized.includes("phase = 'files'")) {
      const row = this.imports.get(`${values[0]}:${values[1]}`);
      if (row && row.lease_token === values[5]) { row.reserved_agent_id = values[2]; row.reserved_resource_ids = JSON.parse(String(values[3])); row.phase = "files"; row.updated_at = values[4]; return { rows: [], rowCount: 1 }; }
      return { rows: [], rowCount: 0 };
    }
    if (normalized.startsWith("UPDATE workspace_share_imports SET phase = 'files'")) {
      const row = this.imports.get(`${values[0]}:${values[1]}`);
      if (row && row.lease_token === values[2]) { row.phase = "files"; row.updated_at = values[3]; return { rows: [], rowCount: 1 }; }
      return { rows: [], rowCount: 0 };
    }
    if (normalized.startsWith("UPDATE workspace_share_imports SET phase = 'commit'")) {
      const row = this.imports.get(`${values[0]}:${values[1]}`);
      if (row && row.lease_token === values[2]) { row.phase = "commit"; row.updated_at = values[3]; return { rows: [], rowCount: 1 }; }
      return { rows: [], rowCount: 0 };
    }
    if (normalized.startsWith("UPDATE workspace_share_imports SET status = $3")) {
      const row = this.imports.get(`${values[0]}:${values[1]}`);
      if (row && row.lease_token === values[7]) { row.status = values[2]; row.phase = values[3]; row.retryable = values[4]; row.failure_code = values[5]; row.lease_token = null; row.lease_until = null; row.updated_at = values[6]; return { rows: [], rowCount: 1 }; }
      return { rows: [], rowCount: 0 };
    }
    if (normalized.startsWith("UPDATE workspace_share_imports SET reserved_agent_id")) {
      const row = this.imports.get(`${values[0]}:${values[1]}`);
      if (row) { row.reserved_agent_id = values[2]; row.reserved_resource_ids = JSON.parse(String(values[3])); row.manifest_path = values[4]; row.status = "committed"; row.phase = "done"; row.retryable = false; row.failure_code = null; row.result = JSON.parse(String(values[5])); row.updated_at = values[6]; row.committed_at = values[6]; row.lease_token = null; row.lease_until = null; }
      return { rows: [], rowCount: row ? 1 : 0 };
    }
    if (normalized.startsWith("UPDATE workspace_share_imports SET status = 'failed'")) {
      const row = this.imports.get(`${values[0]}:${values[1]}`);
      if (row) { row.status = "failed"; row.phase = "cleanup"; row.retryable = false; row.failure_code = values[2]; row.updated_at = values[3]; }
      return { rows: [], rowCount: row ? 1 : 0 };
    }
    if (normalized.startsWith("INSERT INTO workspace_share_import_resources") || normalized.startsWith("INSERT INTO workspace_share_file_transactions")) return { rows: [], rowCount: 1 };
    throw new Error(`unhandled query: ${normalized}`);
  }
}

class FakeFiles implements WorkspaceShareFilePort {
  readonly data = new Map<string, Uint8Array>();
  failStage = false;
  async stage(input: { workspaceId: string; ownerKind: "draft" | "import"; ownerId: string; revision: number; bytes: Uint8Array; sha256: string }) {
    if (this.failStage) throw new Error("stage failed");
    const transactionId = `file-tx-${this.data.size + 1}`;
    const stagedPath = `staging/${input.ownerKind}/${input.ownerId}/${input.revision}.json`;
    const finalPath = `shares/${input.ownerId}/${input.revision}.json`;
    this.data.set(stagedPath, input.bytes);
    return { transactionId, stagedPath, finalPath };
  }
  async rename(input: { transactionId: string; stagedPath: string; finalPath: string }) {
    const bytes = this.data.get(input.stagedPath);
    if (!bytes) throw new Error("missing staged file");
    this.data.set(input.finalPath, bytes);
  }
  async read(path: string): Promise<Uint8Array> {
    const bytes = this.data.get(path);
    if (!bytes) throw new Error(`missing file ${path}`);
    return bytes;
  }
  async remove(path: string): Promise<void> { this.data.delete(path); }
}
