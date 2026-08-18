import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ApprovalService, CaptureService, ConnectorRegistry, MemoryExternalIntegrationStore, registerOfficialConnectorManifests, sampleConnectorManifest } from "@samurai-agent/external-integration";
import { WorkspaceStore } from "./workspace-store.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("external integration repository", () => {
  it("persists validated records, filters them, and uses CAS versions", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-external-integration-"));
    roots.push(root);
    const store = await WorkspaceStore.create({ rootDir: root });
    const client = await store.externalIntegration.createRecord("oauth_client", {
      client_id: "client-1",
      client_name: "Codex",
      connector_id: "codex",
      redirect_uris: ["https://client.example/callback"],
      allowed_scopes: ["workspace.read"],
      public_client: true,
      created_at: "2026-08-17T00:00:00.000Z"
    });
    expect(await store.externalIntegration.getRecord("oauth_client", client.client_id)).toEqual(client);
    expect(await store.externalIntegration.getRecordVersion("oauth_client", client.client_id)).toBe(1);
    expect((await store.externalIntegration.listRecords("oauth_client", { connectorId: "codex" })).map((item) => item.client_id)).toEqual(["client-1"]);
    const updated = { ...client, client_name: "Codex Updated" };
    expect(await store.externalIntegration.updateRecord("oauth_client", client.client_id, 1, updated)).toBe(true);
    expect(await store.externalIntegration.updateRecord("oauth_client", client.client_id, 1, client)).toBe(false);
    expect((await store.listSchemaMigrations()).map((migration) => migration.version)).toContain(18);
    await store.close();
  });

  it("keeps the in-memory contract implementation independent from SQLite", async () => {
    const store = new MemoryExternalIntegrationStore();
    await store.createRecord("connector_manifest", {
      connector_id: "hermes",
      display_name: "Hermes",
      provider: "Nous",
      version: "1.0.0",
      supported_os: ["darwin", "win32", "linux"],
      required_samurai_version: "0.1.0",
      transport: "streamable_http",
      oauth_redirect_uris: ["https://client.example/callback"],
      requested_scopes: ["workspace.read"],
      supported_events: [],
      context_injection: "startup_tool",
      full_capture: "unsupported",
      url_elicitation: "fallback",
      package_checksum: "sha256:test"
    });
    expect((await store.listRecords("connector_manifest")).length).toBe(1);
    expect((await store.listRecords("oauth_client")).length).toBe(0);
  });

  it("registers official Connector manifests sequentially in the durable store", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-external-integration-connectors-"));
    roots.push(root);
    const store = await WorkspaceStore.create({ rootDir: root });
    const registry = new ConnectorRegistry({ store: store.externalIntegration, samuraiVersion: "0.1.0" });
    await expect(registerOfficialConnectorManifests(registry)).resolves.toHaveLength(3);
    expect((await store.externalIntegration.listRecords("connector_manifest")).map((manifest) => manifest.connector_id).sort()).toEqual(["claude_code", "codex", "hermes"]);
    await store.close();
  });

  it("keeps concurrent Connector installation writes unique in SQLite", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-external-integration-install-race-"));
    roots.push(root);
    const store = await WorkspaceStore.create({ rootDir: root });
    let nextId = 0;
    const registry = new ConnectorRegistry({
      store: store.externalIntegration,
      samuraiVersion: "0.1.0",
      id: () => `sqlite-installation-${++nextId}`
    });
    await registry.registerManifest(sampleConnectorManifest);
    const installations = await Promise.all([
      registry.install({ workspaceId: "workspace-sqlite-race", connectorId: "sample_connector", version: "1.0.0" }),
      registry.install({ workspaceId: "workspace-sqlite-race", connectorId: "sample_connector", version: "1.0.0" })
    ]);
    expect(new Set(installations.map((installation) => installation.id))).toEqual(new Set([installations[0]!.id]));
    expect((await registry.listInstallations({ workspaceId: "workspace-sqlite-race", connectorId: "sample_connector" })).filter((installation) => installation.enabled)).toHaveLength(1);
    await store.close();
  });

  it("scopes identical Activity identities to their Workspace", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-external-integration-activity-scope-"));
    roots.push(root);
    const store = await WorkspaceStore.create({ rootDir: root });
    const event = {
      connector_id: "codex",
      connector_version: "1.0.0",
      event_id: "same-event",
      event_kind: "codex.SessionEnd",
      external_session_id: "same-session",
      app_id: "codex",
      changed_resources: [],
      verification: "not_run" as const,
      outcome: "unknown" as const,
      occurred_at: "2026-08-17T00:00:00.000Z",
      payload: {}
    };
    await store.externalIntegration.createRecord("activity_event", {
      id: "activity-workspace-a",
      identity_key: "codex:1.0.0:same-session:same-event",
      payload_hash: "a".repeat(64),
      dedupe_key: "a",
      created_at: event.occurred_at,
      workspace_id: "workspace-a",
      connection_id: "connection-a",
      account_id: "account-a",
      event
    });
    await expect(store.externalIntegration.createRecord("activity_event", {
      id: "activity-workspace-b",
      identity_key: "codex:1.0.0:same-session:same-event",
      payload_hash: "b".repeat(64),
      dedupe_key: "b",
      created_at: event.occurred_at,
      workspace_id: "workspace-b",
      connection_id: "connection-b",
      account_id: "account-b",
      event
    })).resolves.toMatchObject({ workspace_id: "workspace-b" });
    await expect(store.externalIntegration.createRecord("activity_event", {
      id: "activity-workspace-a-duplicate",
      identity_key: "codex:1.0.0:same-session:same-event",
      payload_hash: "c".repeat(64),
      dedupe_key: "c",
      created_at: event.occurred_at,
      workspace_id: "workspace-a",
      connection_id: "connection-a",
      account_id: "account-a",
      event
    })).rejects.toThrow(/external_record_exists/);
    await store.close();
  });

  it("reuses one SQLite approval for concurrent duplicate requests", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-external-integration-approval-race-"));
    roots.push(root);
    const store = await WorkspaceStore.create({ rootDir: root });
    let randomValue = 1;
    const approvals = new ApprovalService({
      store: store.externalIntegration,
      publicBaseUrl: "https://samurai.example",
      now: () => new Date("2026-08-17T00:00:00.000Z"),
      random: (bytes) => Buffer.alloc(bytes, randomValue++)
    });
    const input = {
      workspaceId: "workspace-approval-sqlite-race",
      operation: "artifact.revise",
      target: { artifact_id: "sqlite-race-artifact" },
      input: { artifact_id: "sqlite-race-artifact", base_revision_id: "revision-1" },
      accountId: "account-1",
      roomId: "room-1",
      expectedVersions: { "artifact:sqlite-race-artifact": 1 },
      idempotencyKey: "approval-sqlite-race"
    };
    const [first, second] = await Promise.all([approvals.prepare(input), approvals.prepare(input)]);
    expect(first.request.id).toBe(second.request.id);
    expect(await store.externalIntegration.listRecords("approval_request", { workspaceId: input.workspaceId, accountId: input.accountId })).toHaveLength(1);
    await expect(approvals.approve({ approvalId: second.request.id, approvalToken: second.approvalToken, accountId: input.accountId })).resolves.toMatchObject({ state: "approved" });
    await store.close();
  });

  it("keeps concurrent Capture reservations within the SQLite quota", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-external-integration-capture-race-"));
    roots.push(root);
    const store = await WorkspaceStore.create({ rootDir: root });
    const capture = new CaptureService({
      store: store.externalIntegration,
      encryptionKey: Buffer.alloc(32, 7),
      now: () => new Date("2026-08-17T00:00:00.000Z"),
      random: (bytes) => Buffer.alloc(bytes, 3)
    });
    await capture.savePolicy({
      id: "capture-policy-race",
      workspace_id: "workspace-capture-race",
      connection_id: "connection-capture-race",
      account_id: "account-capture-race",
      enabled: true,
      conversation: true,
      terminal: true,
      intermediate_log: true,
      retention_days: 30,
      quota_bytes: 20,
      redaction_policy_version: "1"
    });
    const results = await Promise.all([1, 2, 3].map((index) => capture.save({
      workspaceId: "workspace-capture-race",
      connectionId: "connection-capture-race",
      accountId: "account-capture-race",
      externalSessionId: "session-capture-race",
      roomId: "room-capture-race",
      kind: "conversation",
      recordId: `capture-race-${index}`,
      text: "1234567890",
      connectorFullCapture: "supported"
    })));
    expect(results.filter((result) => result.record).length).toBe(2);
    expect(results.filter((result) => result.availability === "quota_exceeded")).toHaveLength(1);
    const records = await store.externalIntegration.listRecords("raw_external_record", { workspaceId: "workspace-capture-race", connectionId: "connection-capture-race" });
    expect(records.reduce((total, record) => total + record.size_bytes, 0)).toBeLessThanOrEqual(20);
    await store.close();
  });

  it("returns the same SQLite Capture record for concurrent duplicate Hooks", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-external-integration-capture-duplicate-"));
    roots.push(root);
    const store = await WorkspaceStore.create({ rootDir: root });
    const capture = new CaptureService({
      store: store.externalIntegration,
      encryptionKey: Buffer.alloc(32, 9),
      now: () => new Date("2026-08-17T00:00:00.000Z"),
      random: (bytes) => Buffer.alloc(bytes, 5)
    });
    await capture.savePolicy({
      id: "capture-policy-duplicate",
      workspace_id: "workspace-capture-duplicate",
      connection_id: "connection-capture-duplicate",
      account_id: "account-capture-duplicate",
      enabled: true,
      conversation: true,
      terminal: true,
      intermediate_log: true,
      retention_days: 30,
      quota_bytes: 10,
      redaction_policy_version: "1"
    });
    const input = {
      workspaceId: "workspace-capture-duplicate",
      connectionId: "connection-capture-duplicate",
      accountId: "account-capture-duplicate",
      externalSessionId: "session-capture-duplicate",
      roomId: "room-capture-duplicate",
      kind: "conversation" as const,
      recordId: "capture-duplicate-1",
      text: "1234567890",
      connectorFullCapture: "supported" as const
    };
    const [first, second] = await Promise.all([capture.save(input), capture.save(input)]);
    expect(first.record?.id).toBe(input.recordId);
    expect(second.record?.id).toBe(input.recordId);
    expect(await store.externalIntegration.listRecords("raw_external_record", { workspaceId: input.workspaceId, connectionId: input.connectionId })).toHaveLength(1);
    await store.close();
  });

  it("releases SQLite Capture quota atomically when a record is deleted", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-external-integration-capture-release-"));
    roots.push(root);
    const store = await WorkspaceStore.create({ rootDir: root });
    const capture = new CaptureService({
      store: store.externalIntegration,
      encryptionKey: Buffer.alloc(32, 8),
      now: () => new Date("2026-08-17T00:00:00.000Z"),
      random: (bytes) => Buffer.alloc(bytes, 4),
      authorization: { assertRead: async () => undefined, assertDelete: async () => undefined }
    });
    const policy = {
      id: "capture-policy-release",
      workspace_id: "workspace-capture-release",
      connection_id: "connection-capture-release",
      account_id: "account-capture-release",
      enabled: true,
      conversation: true,
      terminal: true,
      intermediate_log: true,
      retention_days: 30 as const,
      quota_bytes: 20,
      redaction_policy_version: "1"
    };
    await capture.savePolicy(policy);
    const base = {
      workspaceId: policy.workspace_id,
      connectionId: policy.connection_id,
      accountId: policy.account_id,
      externalSessionId: "session-capture-release",
      roomId: "room-capture-release",
      kind: "conversation" as const,
      connectorFullCapture: "supported" as const,
      text: "1234567890"
    };
    expect((await capture.save({ ...base, recordId: "capture-release-1" })).record).toBeDefined();
    expect((await capture.save({ ...base, recordId: "capture-release-2" })).record).toBeDefined();
    expect((await capture.save({ ...base, recordId: "capture-release-3" })).availability).toBe("quota_exceeded");
    expect(await capture.delete({ recordId: "capture-release-1", workspaceId: policy.workspace_id, connectionId: policy.connection_id, accountId: policy.account_id, roomId: "room-capture-release" })).toBe(true);
    expect((await capture.save({ ...base, recordId: "capture-release-3" })).record).toBeDefined();
    const records = await store.externalIntegration.listRecords("raw_external_record", { workspaceId: policy.workspace_id, connectionId: policy.connection_id });
    expect(records.reduce((total, record) => total + record.size_bytes, 0)).toBe(20);
    await store.close();
  });
});
