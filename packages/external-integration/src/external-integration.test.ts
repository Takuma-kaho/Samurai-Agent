import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ActivityIngestService,
  ApprovalService,
  CaptureService,
  CaptureRetentionWorker,
  ConnectorRegistry,
  ContextSnapshotService,
  createExternalIntegrationHttpHandler,
  ExternalIntegrationError,
  getExternalClientAdapter,
  McpProtocolServer,
  MemoryExternalIntegrationStore,
  OAuthService,
  RoomBindingService,
  normalizeExternalIntegrationError,
  normalizeConnectorEvent,
  officialConnectorManifests,
  validateMcpSchema,
  type ConnectorEvent,
  type ContextSnapshotSource,
  type ExternalIntegrationAuthContext,
  type ExternalWorkspaceTarget,
  type McpWorkspacePort
} from "./index.js";

const now = "2026-08-17T00:00:00.000Z";

function connectionLookup() {
  const connection = {
    id: "connection-1",
    workspace_id: "workspace-1",
    connector_id: "codex",
    app_id: "codex-app",
    status: "active" as const,
    delegated_principal: { kind: "human" as const, participant_id: "account-1" },
    allowed_room_ids: ["room-1"],
    ingress_classes: ["query", "domain_operation", "activity_ingest"] as Array<"query" | "domain_operation" | "activity_ingest">
  };
  return {
    connection,
    getExternalAppConnection: async (id: string) => id === connection.id ? connection : undefined,
    getExternalAppConnectionByConnector: async (input: { workspaceId: string; connectorId: string }) => input.workspaceId === connection.workspace_id && input.connectorId === connection.connector_id ? connection : undefined
  };
}

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

describe("external integration contracts", () => {
  it("maps formal ingress failures to public MCP error codes", () => {
    expect(normalizeExternalIntegrationError({ code: "external_app_connection_room_scope_denied", message: "room denied" })).toMatchObject({ code: "room_binding_room_denied" });
    expect(normalizeExternalIntegrationError({ code: "source_not_allowed", message: "workspace_context_room_authorization_denied:read" })).toMatchObject({ code: "room_binding_room_denied" });
    expect(normalizeExternalIntegrationError({ code: "source_not_allowed", message: "domain_operation_source_not_allowed:automation.save:external_app" })).toMatchObject({ code: "mcp_method_not_found" });
    expect(normalizeExternalIntegrationError({ code: "validation", message: "domain input invalid" })).toMatchObject({ code: "mcp_invalid_arguments" });
    expect(normalizeExternalIntegrationError({ code: "outcome_unknown", message: "write outcome unknown" })).toMatchObject({ code: "mcp_outcome_unknown" });
    expect(normalizeExternalIntegrationError(new Error("unrelated"))).toBeUndefined();
  });

  it("does OAuth PKCE, binds the grant to the client, and rejects replay", async () => {
    const store = new MemoryExternalIntegrationStore();
    const lookup = connectionLookup();
    const oauth = new OAuthService({
      store,
      connections: lookup,
      browserAuthorization: { assertBrowserAccount: async () => undefined },
      publicBaseUrl: "https://samurai.example",
      now: () => new Date(now)
    });
    await oauth.registerClient({
      client_id: "codex-client",
      client_name: "Codex",
      connector_id: "codex",
      redirect_uris: ["https://client.example/callback"],
      allowed_scopes: ["workspace.read", "room.read", "knowledge.read", "approval.execute"],
      public_client: true,
      created_at: now
    });
    const connectors = new ConnectorRegistry({ store, samuraiVersion: "0.1.0", now: () => new Date(now), id: () => "installation-1" });
    await connectors.registerManifest({
      connector_id: "codex",
      display_name: "Codex",
      provider: "OpenAI",
      version: "1.0.0",
      supported_os: ["darwin"],
      required_samurai_version: "0.1.0",
      transport: "streamable_http",
      oauth_redirect_uris: ["https://client.example/callback"],
      requested_scopes: ["workspace.read", "room.read", "knowledge.read", "approval.execute"],
      supported_events: ["turn.completed"],
      context_injection: "startup_tool",
      full_capture: "partial",
      url_elicitation: "fallback",
      package_checksum: "sha256:test"
    });
    await connectors.install({ workspaceId: "workspace-1", connectorId: "codex", version: "1.0.0" });
    const { verifier, challenge } = pkce();
    const started = await oauth.beginAuthorization({
      workspaceId: "workspace-1",
      clientId: "codex-client",
      redirectUri: "https://client.example/callback",
      responseType: "code",
      scope: "workspace.read room.read knowledge.read",
      state: "csrf-state",
      codeChallenge: challenge,
      codeChallengeMethod: "S256"
    });
    const approved = await oauth.approveAuthorization({ requestId: started.requestId, accountId: "account-1" });
    const token = await oauth.exchangeCode({ workspaceId: "workspace-1", clientId: "codex-client", code: approved.code, redirectUri: approved.redirectUri.split("?")[0], codeVerifier: verifier });
    const auth = await oauth.authenticateAccessToken(token.access_token);
    expect(auth).toMatchObject({ workspaceId: "workspace-1", accountId: "account-1", connectionId: "connection-1" });
    await expect(oauth.exchangeCode({ workspaceId: "workspace-1", clientId: "codex-client", code: approved.code, redirectUri: "https://client.example/callback", codeVerifier: verifier })).rejects.toMatchObject({ code: "oauth_code_replayed" });
    expect(oauth.metadata().code_challenge_methods_supported).toEqual(["S256"]);

    const pendingAfterDisable = await oauth.beginAuthorization({
      workspaceId: "workspace-1",
      clientId: "codex-client",
      redirectUri: "https://client.example/callback",
      responseType: "code",
      scope: "workspace.read",
      state: "disabled-before-approval",
      codeChallenge: challenge,
      codeChallengeMethod: "S256"
    });
    await connectors.setEnabled("installation-1", false);
    await expect(oauth.approveAuthorization({ requestId: pendingAfterDisable.requestId, accountId: "account-1" })).rejects.toMatchObject({ code: "connector_disabled" });
  });

  it("changes a Room only through a versioned binding and rejects a disallowed Room", async () => {
    const store = new MemoryExternalIntegrationStore();
    const lookup = connectionLookup();
    let bindingId = 0;
    const service = new RoomBindingService({
      store,
      connections: lookup,
      authorization: { assertRoom: async () => undefined },
      now: () => new Date(now),
      id: () => `binding-${++bindingId}`
    });
    const auth: ExternalIntegrationAuthContext = { workspaceId: "workspace-1", accountId: "account-1", connectionId: "connection-1", connectorId: "codex", appId: "codex-app", scopes: ["room.binding.write"], tokenVersion: 1, expiresAt: now };
    const binding = await service.bind({ auth, workspaceId: "workspace-1", accountId: "account-1", projectRef: "project-a", roomId: "room-1", changedBy: "account-1" });
    expect(binding.binding_version).toBe(1);
    const initial = await service.bind({ auth, workspaceId: "workspace-1", accountId: "account-1", projectRef: "project-initial", roomId: "room-1", changedBy: "account-1", expectedBindingVersion: 1, expectedBindingPresent: false });
    expect(initial.binding_version).toBe(1);
    await expect(service.bind({ auth, workspaceId: "workspace-1", accountId: "account-1", projectRef: "project-initial", roomId: "room-1", changedBy: "account-1", expectedBindingVersion: 1, expectedBindingPresent: false })).rejects.toMatchObject({ code: "room_binding_version_conflict" });
    await expect(service.getAuthorizedBinding({ auth, workspaceId: "workspace-1", projectRef: "project-a" })).resolves.toMatchObject({ room_id: "room-1", binding_version: 1 });
    await expect(service.getAuthorizedBinding({ auth: { ...auth, accountId: "other-account" }, workspaceId: "workspace-1", projectRef: "project-a" })).rejects.toMatchObject({ code: "oauth_account_mismatch" });
    await expect(service.bind({ auth, workspaceId: "workspace-1", accountId: "account-1", projectRef: "project-a", roomId: "room-2", changedBy: "account-1", expectedBindingVersion: 1 })).rejects.toMatchObject({ code: "room_binding_room_denied" });
    const target = await service.resolveTarget({ auth, workspaceId: "workspace-1", projectRef: "project-a", externalSessionId: "session-a" });
    expect(target).toMatchObject({ roomId: "room-1", bindingVersion: 1, projectRef: "project-a" });
    await expect(service.assertTargetCurrent(target)).resolves.toMatchObject({ room_id: "room-1", binding_version: 1 });
  });

  it("applies the Workspace default Room only for a first Project binding", async () => {
    const store = new MemoryExternalIntegrationStore();
    const lookup = connectionLookup();
    const auth: ExternalIntegrationAuthContext = { workspaceId: "workspace-1", accountId: "account-1", connectionId: "connection-1", connectorId: "codex", appId: "codex-app", scopes: ["room.read"], tokenVersion: 1, expiresAt: now };
    const service = new RoomBindingService({
      store,
      connections: lookup,
      defaultRoomId: async () => "room-1",
      authorization: { assertRoom: async () => undefined },
      now: () => new Date(now),
      id: () => "binding-default"
    });
    const target = await service.resolveTarget({ auth, workspaceId: "workspace-1", projectRef: "project-default", externalSessionId: "session-default" });
    expect(target).toMatchObject({ roomId: "room-1", bindingVersion: 1 });
    const binding = await service.getBinding({ workspaceId: "workspace-1", connectionId: "connection-1", accountId: "account-1", projectRef: "project-default" });
    expect(binding).toMatchObject({ room_id: "room-1", changed_by: "account-1" });
    await expect(service.getAuthorizedBindingOrDefault({ auth, workspaceId: "workspace-1", projectRef: "project-default" })).resolves.toMatchObject({ room_id: "room-1", binding_version: 1 });
  });

  it("keeps approval separate from execution and rejects changed versions", async () => {
    const store = new MemoryExternalIntegrationStore();
    const service = new ApprovalService({ store, publicBaseUrl: "https://samurai.example", now: () => new Date(now), random: () => Buffer.alloc(64, 1) });
    const prepared = await service.prepare({ workspaceId: "workspace-1", operation: "artifact.revise", target: { artifact_id: "r1" }, input: { artifact_id: "r1", base_revision_id: "revision-1" }, accountId: "account-1", roomId: "room-1", expectedVersions: { "artifact:r1": 2 }, idempotencyKey: "idem-1" });
    await expect(service.execute({ approvalId: prepared.request.id, accountId: "account-1", roomId: "room-1", input: { artifact_id: "r1", base_revision_id: "revision-1" }, currentVersions: { "artifact:r1": 2 }, run: async () => ({ ok: true }) })).rejects.toMatchObject({ code: "approval_required" });
    const approved = await service.approve({ approvalId: prepared.request.id, approvalToken: prepared.approvalToken, accountId: "account-1" });
    await expect(service.approve({ approvalId: prepared.request.id, approvalToken: prepared.approvalToken, accountId: "account-1" })).resolves.toMatchObject({ id: approved.id, state: "approved" });
    await expect(service.execute({ approvalId: prepared.request.id, accountId: "account-1", roomId: "room-1", input: { artifact_id: "r1", base_revision_id: "revision-1" }, currentVersions: { "artifact:r1": 3 }, run: async () => ({ ok: true }) })).rejects.toMatchObject({ code: "approval_version_changed" });
    const result = await service.execute({ approvalId: prepared.request.id, accountId: "account-1", roomId: "room-1", input: { artifact_id: "r1", base_revision_id: "revision-1" }, currentVersions: { "artifact:r1": 2 }, run: async () => ({ ok: true }) });
    expect(result).toEqual({ ok: true });
    await expect(service.execute({ approvalId: prepared.request.id, accountId: "account-1", roomId: "room-1", input: { artifact_id: "r1", base_revision_id: "revision-1" }, currentVersions: { "artifact:r1": 2 }, run: async () => ({ ok: true }) })).rejects.toMatchObject({ code: "approval_replayed" });
  });

  it("keeps a known approval failure distinct from an unknown outcome", async () => {
    const store = new MemoryExternalIntegrationStore();
    const service = new ApprovalService({ store, publicBaseUrl: "https://samurai.example", now: () => new Date(now), random: () => Buffer.alloc(64, 2) });
    const prepared = await service.prepare({ workspaceId: "workspace-approval-failed", operation: "artifact.revise", target: { artifact_id: "failed-artifact" }, input: { artifact_id: "failed-artifact", base_revision_id: "revision-1" }, accountId: "account-1", roomId: "room-1", expectedVersions: { "artifact:failed-artifact": 1 }, idempotencyKey: "approval-failed" });
    await service.approve({ approvalId: prepared.request.id, approvalToken: prepared.approvalToken, accountId: "account-1" });
    await expect(service.execute({
      approvalId: prepared.request.id,
      accountId: "account-1",
      roomId: "room-1",
      input: { artifact_id: "failed-artifact", base_revision_id: "revision-1" },
      currentVersions: { "artifact:failed-artifact": 1 },
      run: async () => { throw new ExternalIntegrationError("mcp_invalid_arguments", "known_mutation_failure"); }
    })).rejects.toMatchObject({ code: "mcp_invalid_arguments" });
    await expect(service.status(prepared.request.id)).resolves.toMatchObject({ state: "failed", execution_result: { status: "failed" } });
  });

  it("records an approved write as unknown when cancellation arrives after the write boundary", async () => {
    const store = new MemoryExternalIntegrationStore();
    const approval = new ApprovalService({ store, publicBaseUrl: "https://samurai.example", now: () => new Date(now), random: () => Buffer.alloc(64, 9) });
    const prepared = await approval.prepare({
      workspaceId: "workspace-approval-cancel",
      operation: "artifact.revise",
      target: { workspace_id: "workspace-approval-cancel", connection_id: "connection-1", connector_id: "codex", app_id: "codex-app", project_ref: "project-a", external_session_id: "session-a" },
      input: { artifact_id: "cancel-artifact", base_revision_id: "revision-1" },
      accountId: "account-1",
      roomId: "room-1",
      expectedVersions: { "artifact:cancel-artifact": 1 },
      idempotencyKey: "approval-cancel"
    });
    const approved = await approval.approve({ approvalId: prepared.request.id, approvalToken: prepared.approvalToken, accountId: "account-1" });
    const controller = new AbortController();
    const auth: ExternalIntegrationAuthContext = { workspaceId: "workspace-approval-cancel", accountId: "account-1", connectionId: "connection-1", connectorId: "codex", appId: "codex-app", scopes: ["resource.write", "approval.execute"], tokenVersion: 1, expiresAt: now };
    const target: ExternalWorkspaceTarget = { workspaceId: auth.workspaceId, roomId: "room-1", projectRef: "project-a", accountId: "account-1", connectionId: "connection-1", connectorId: "codex", appId: "codex-app", bindingVersion: 1, externalSessionId: "session-a" };
    const workspace: McpWorkspacePort = {
      getBinding: async () => undefined,
      resolveTarget: async () => target,
      getCapabilities: async () => ({}),
      getContextSnapshot: async () => ({}),
      query: async () => ({}),
      getCurrentVersions: async () => ({ "artifact:cancel-artifact": 1 }),
      ingestActivity: async () => ({}),
      mutate: async (_target, _operation, _input, _idempotencyKey, _expectedVersions, control) => {
        control?.markWriteStarted();
        controller.abort();
        throw new ExternalIntegrationError("mcp_cancelled", "mcp_request_cancelled", true);
      }
    };
    const mcp = new McpProtocolServer({ auth: { authenticateAccessToken: async () => auth }, workspace, approval });
    await expect(mcp.executeApproved(approved.id, "account-1", controller.signal)).rejects.toMatchObject({ code: "mcp_outcome_unknown" });
    await expect(approval.status(approved.id)).resolves.toMatchObject({ state: "outcome_unknown" });
  });

  it("reuses one approval when the same idempotency key races", async () => {
    const store = new MemoryExternalIntegrationStore();
    let randomValue = 1;
    const service = new ApprovalService({ store, publicBaseUrl: "https://samurai.example", now: () => new Date(now), random: (bytes) => Buffer.alloc(bytes, randomValue++) });
    const input = {
      workspaceId: "workspace-approval-race",
      operation: "artifact.revise",
      target: { artifact_id: "race-artifact" },
      input: { artifact_id: "race-artifact", base_revision_id: "revision-1" },
      accountId: "account-1",
      roomId: "room-1",
      expectedVersions: { "artifact:race-artifact": 1 },
      idempotencyKey: "approval-race"
    };
    const [first, second] = await Promise.all([service.prepare(input), service.prepare(input)]);
    expect(first.request.id).toBe(second.request.id);
    expect((await store.listRecords("approval_request", { workspaceId: input.workspaceId, accountId: input.accountId }))).toHaveLength(1);
    await expect(service.approve({ approvalId: first.request.id, approvalToken: first.approvalToken, accountId: input.accountId })).rejects.toMatchObject({ code: "approval_not_found" });
    await expect(service.approve({ approvalId: second.request.id, approvalToken: second.approvalToken, accountId: input.accountId })).resolves.toMatchObject({ state: "approved" });
  });

  it("marks a successful mutation unknown when terminal approval persistence fails", async () => {
    const store = new MemoryExternalIntegrationStore();
    const originalAtomic = store.atomic.bind(store);
    store.atomic = async (mutations) => {
      if (mutations.some((mutation) => mutation.kind === "update" && mutation.type === "approval_request" && (mutation.record as { state?: string }).state === "executed")) return false;
      return originalAtomic(mutations);
    };
    const service = new ApprovalService({ store, publicBaseUrl: "https://samurai.example", now: () => new Date(now), random: () => Buffer.alloc(64, 3) });
    const prepared = await service.prepare({
      workspaceId: "workspace-approval-unknown",
      operation: "artifact.revise",
      target: { artifact_id: "unknown-artifact" },
      input: { artifact_id: "unknown-artifact", base_revision_id: "revision-1" },
      accountId: "account-1",
      roomId: "room-1",
      expectedVersions: { "artifact:unknown-artifact": 1 },
      idempotencyKey: "approval-unknown"
    });
    await service.approve({ approvalId: prepared.request.id, approvalToken: prepared.approvalToken, accountId: "account-1" });
    let ran = false;
    await expect(service.execute({
      approvalId: prepared.request.id,
      accountId: "account-1",
      roomId: "room-1",
      input: { artifact_id: "unknown-artifact", base_revision_id: "revision-1" },
      currentVersions: { "artifact:unknown-artifact": 1 },
      run: async () => { ran = true; return { ok: true }; }
    })).rejects.toMatchObject({ code: "approval_outcome_unknown" });
    expect(ran).toBe(true);
    await expect(service.status(prepared.request.id)).resolves.toMatchObject({ state: "outcome_unknown" });
  });

  it("redacts and encrypts optional capture, while unsupported capture is explicit", async () => {
    const store = new MemoryExternalIntegrationStore();
    let current = new Date(now);
    const service = new CaptureService({ store, encryptionKey: Buffer.alloc(32, 7), now: () => current, random: () => Buffer.alloc(32, 8) });
    const input = { id: "policy-1", workspace_id: "workspace-1", connection_id: "connection-1", account_id: "account-1", enabled: true, conversation: true, terminal: true, intermediate_log: true, retention_days: 30 as const, quota_bytes: 100_000, redaction_policy_version: "1", updatedAt: now };
    await service.savePolicy(input);
    const saved = await service.save({ workspaceId: "workspace-1", connectionId: "connection-1", accountId: "account-1", externalSessionId: "session-a", roomId: "room-1", kind: "conversation", text: "Bearer secret api_key=abc123\nhello", connectorFullCapture: "supported" });
    expect(saved.availability).toBe("captured");
    expect(saved.record?.encrypted_payload).not.toContain("secret");
    expect(saved.record && service.decrypt(saved.record)).toContain("[REDACTED]");
    const jsonCapture = await service.save({ ...inputForCapture(), recordId: "capture-json-secret", text: '{"access_token":"json-secret","nested":{"password":"json-password"}}', connectorFullCapture: "supported" });
    expect(jsonCapture.record && service.decrypt(jsonCapture.record)).not.toContain("json-secret");
    expect(jsonCapture.record && service.decrypt(jsonCapture.record)).not.toContain("json-password");
    const managedCapture = new CaptureService({
      store,
      encryptionKey: Buffer.alloc(32, 7),
      now: () => current,
      authorization: {
        assertRead: async () => undefined,
        assertDelete: async (input) => { if (input.roomId !== "room-1") throw new Error("wrong_room"); }
      }
    });
    await expect(managedCapture.export({ workspaceId: "workspace-1", connectionId: "connection-1", accountId: "account-1", roomId: "room-1" })).resolves.toHaveLength(2);
    await expect(managedCapture.delete({ recordId: saved.record!.id, workspaceId: "workspace-1", connectionId: "connection-1", accountId: "account-1", roomId: "room-2" })).rejects.toMatchObject({ code: "mcp_auth_required" });
    const unsupported = await service.save({ ...inputForCapture(), text: "terminal", connectorFullCapture: "unsupported" });
    expect(unsupported.availability).toBe("unsupported");
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(service.save({ ...inputForCapture(), recordId: "capture-cancelled", signal: cancelled.signal, connectorFullCapture: "supported" })).rejects.toMatchObject({ code: "mcp_cancelled" });
    current = new Date("2026-09-18T00:00:00.000Z");
    const worker = new CaptureRetentionWorker({ capture: service, intervalMs: 60_000 });
    await expect(worker.run()).resolves.toBe(2);
    expect(await store.listRecords("raw_external_record")).toHaveLength(0);
  });

  it("exports Capture in a Room-bound stable page and rejects a reused cursor", async () => {
    const store = new MemoryExternalIntegrationStore();
    const capture = new CaptureService({
      store,
      encryptionKey: Buffer.alloc(32, 6),
      now: () => new Date(now),
      authorization: { assertRead: async () => undefined, assertDelete: async () => undefined }
    });
    await capture.savePolicy({
      id: "capture-policy-page", workspace_id: "workspace-1", connection_id: "connection-1", account_id: "account-1",
      enabled: true, conversation: true, terminal: false, intermediate_log: false, retention_days: 30, quota_bytes: 100_000, redaction_policy_version: "1", updatedAt: now
    });
    await capture.save({ ...inputForCapture(), projectRef: "project-a", recordId: "capture-a", kind: "conversation", text: "first", connectorFullCapture: "supported" });
    await capture.save({ ...inputForCapture(), projectRef: "project-b", recordId: "capture-b", kind: "conversation", text: "second", connectorFullCapture: "supported" });
    const first = await capture.exportPage({ workspaceId: "workspace-1", connectionId: "connection-1", accountId: "account-1", roomId: "room-1", limit: 1 });
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toBeTruthy();
    const second = await capture.exportPage({ workspaceId: "workspace-1", connectionId: "connection-1", accountId: "account-1", roomId: "room-1", cursor: first.nextCursor, limit: 1 });
    expect(second.items).toHaveLength(1);
    expect([...first.items, ...second.items].map((item) => item.id).sort()).toEqual(["capture-a", "capture-b"]);
    await expect(capture.exportPage({ workspaceId: "workspace-1", connectionId: "connection-1", accountId: "account-1", projectRef: "project-a", roomId: "room-1", limit: 1 })).resolves.toMatchObject({ items: [{ id: "capture-a" }] });
    await expect(capture.exportPage({ workspaceId: "workspace-1", connectionId: "connection-1", accountId: "account-1", projectRef: "project-a", roomId: "room-1", cursor: first.nextCursor, limit: 1 })).rejects.toMatchObject({ code: "mcp_invalid_arguments" });
    await expect(capture.exportPage({ workspaceId: "workspace-1", connectionId: "connection-1", accountId: "account-1", roomId: "other-room", cursor: first.nextCursor, limit: 1 })).rejects.toMatchObject({ code: "mcp_invalid_arguments" });
    await expect(capture.exportPage({ workspaceId: "workspace-1", connectionId: "connection-1", accountId: "account-2", roomId: "room-1", limit: 1 })).resolves.toMatchObject({ items: [] });
    await expect(capture.delete({ recordId: "capture-a", workspaceId: "workspace-1", connectionId: "connection-1", accountId: "account-2", roomId: "room-1" })).rejects.toMatchObject({ code: "mcp_auth_required" });
  });

  it("bounds concurrent Memory Capture reservations and deduplicates the same event", async () => {
    const store = new MemoryExternalIntegrationStore();
    const capture = new CaptureService({
      store,
      encryptionKey: Buffer.alloc(32, 2),
      now: () => new Date(now),
      random: (bytes) => Buffer.alloc(bytes, 1)
    });
    await capture.savePolicy({
      id: "capture-policy-memory-race",
      workspace_id: "workspace-memory-race",
      connection_id: "connection-memory-race",
      account_id: "account-memory-race",
      enabled: true,
      conversation: true,
      terminal: true,
      intermediate_log: true,
      retention_days: 30,
      quota_bytes: 20,
      redaction_policy_version: "1"
    });
    const base = {
      workspaceId: "workspace-memory-race",
      connectionId: "connection-memory-race",
      accountId: "account-memory-race",
      externalSessionId: "session-memory-race",
      roomId: "room-memory-race",
      kind: "conversation" as const,
      text: "1234567890",
      connectorFullCapture: "supported" as const
    };
    const duplicate = await Promise.all([1, 2].map(() => capture.save({ ...base, recordId: "memory-duplicate" })));
    expect(duplicate.map((result) => result.record?.id)).toEqual(["memory-duplicate", "memory-duplicate"]);
    const results = await Promise.all([1, 2, 3].map((index) => capture.save({ ...base, recordId: `memory-race-${index}` })));
    expect(results.filter((result) => result.record)).toHaveLength(1);
    expect(results.filter((result) => result.availability === "quota_exceeded")).toHaveLength(2);
    expect(await store.listRecords("raw_external_record", { workspaceId: base.workspaceId, connectionId: base.connectionId })).toHaveLength(2);
  });

  it("accepts Capture only from an authenticated Room-bound Hook and deduplicates retries", async () => {
    const store = new MemoryExternalIntegrationStore();
    const capture = new CaptureService({ store, encryptionKey: Buffer.alloc(32, 4), now: () => new Date(now), random: () => Buffer.alloc(32, 5) });
    await capture.savePolicy({
      id: "capture-policy-hook", workspace_id: "workspace-1", connection_id: "connection-1", account_id: "account-1",
      enabled: true, conversation: true, terminal: false, intermediate_log: false, retention_days: 30, quota_bytes: 100_000, redaction_policy_version: "1", updatedAt: now
    });
    const approval = new ApprovalService({ store, publicBaseUrl: "https://samurai.example", now: () => new Date(now) });
    const auth: ExternalIntegrationAuthContext = { workspaceId: "workspace-1", accountId: "account-1", connectionId: "connection-1", connectorId: "codex", appId: "codex-app", scopes: ["activity.ingest"], tokenVersion: 1, expiresAt: now };
    const target: ExternalWorkspaceTarget = { workspaceId: "workspace-1", roomId: "room-1", projectRef: "project-a", accountId: "account-1", connectionId: "connection-1", connectorId: "codex", appId: "codex-app", bindingVersion: 1, externalSessionId: "session-a" };
    const ingested: ConnectorEvent[] = [];
    const port: McpWorkspacePort = {
      getBinding: async () => ({ room_id: "room-1" }), resolveTarget: async () => target,
      assertTargetCurrent: async () => undefined,
      getCapabilities: async () => ({ manifest: { full_capture: "supported" } }), getContextSnapshot: async () => ({}),
      query: async () => ({}), mutate: async () => ({}), ingestActivity: async (_target, event) => {
        ingested.push(event);
        return { accepted: true };
      }, getCurrentVersions: async () => ({})
    };
    const mcp = new McpProtocolServer({ auth: { authenticateAccessToken: async () => auth }, workspace: port, approval, capture });
    const input = { projectRef: "project-a", externalSessionId: "session-a", eventId: "turn-1", kind: "conversation" as const, text: "api_key=secret\nwork complete" };
    const first = await mcp.ingestCaptureHook("Bearer token", input);
    const repeated = await mcp.ingestCaptureHook("Bearer token", input);
    expect(first).toMatchObject({ availability: "captured", record_id: expect.any(String) });
    expect(repeated).toMatchObject({ record_id: first.record_id });
    expect(await store.listRecords("raw_external_record")).toHaveLength(1);
    await expect(mcp.ingestCaptureHook("Bearer token", { ...input, text: "different" })).rejects.toMatchObject({ code: "activity_event_conflict" });
    await expect(mcp.ingestActivityHook("Bearer token", {
      projectRef: "project-a",
      event: {
        connector_id: "codex", connector_version: "1", event_id: "turn-1", event_kind: "session.end",
        external_session_id: "session-a", app_id: "codex-app", changed_resources: [], verification: "not_run", outcome: "completed", occurred_at: now, payload: { hook: true }
      }
    })).resolves.toEqual({ accepted: true });
    expect(ingested).toHaveLength(1);
    await expect(mcp.ingestActivityHook("Bearer token", {
      projectRef: "project-a",
      event: {
        connector_id: "codex", connector_version: "1", event_id: "turn-invalid", event_kind: "session.end",
        external_session_id: "session-a", app_id: "codex-app", changed_resources: [1], verification: "not_run", outcome: "completed", occurred_at: now, payload: {}, extra: true
      } as unknown as ConnectorEvent
    })).rejects.toMatchObject({ code: "mcp_invalid_arguments", message: "activity_event_invalid" });
    await expect(mcp.ingestActivityHook("Bearer token", {
      projectRef: "project-a",
      event: {
        connector_id: "other", connector_version: "1", event_id: "turn-2", event_kind: "session.end",
        external_session_id: "session-a", app_id: "codex-app", changed_resources: [], verification: "not_run", outcome: "completed", occurred_at: now, payload: {}
      }
    })).rejects.toMatchObject({ code: "mcp_invalid_arguments", message: "activity_target_mismatch" });
  });

  it("deduplicates structured Activity and marks unknown outcomes", async () => {
    const store = new MemoryExternalIntegrationStore();
    const service = new ActivityIngestService({ store, now: () => new Date(now), id: () => "activity-record-1" });
    const event: ConnectorEvent = { connector_id: "codex", connector_version: "1", event_id: "event-1", event_kind: "turn.completed", external_session_id: "session-a", app_id: "codex-app", instruction: "do work", changed_resources: [], verification: "unknown", outcome: "unknown", occurred_at: now, payload: {} };
    expect(normalizeConnectorEvent(event).unknownOutcome).toBe(true);
    expect((await service.ingest(event)).duplicate).toBe(false);
    expect((await service.ingest(event)).duplicate).toBe(true);
    await expect(service.ingest({ ...event, result: "different" })).rejects.toMatchObject({ code: "activity_event_conflict" });
  });

  it("redacts connector secrets before Activity persistence", async () => {
    const store = new MemoryExternalIntegrationStore();
    const service = new ActivityIngestService({ store, now: () => new Date(now), id: () => "activity-secret-record" });
    const event: ConnectorEvent = {
      connector_id: "codex", connector_version: "1", event_id: "event-secret", event_kind: "turn.completed",
      external_session_id: "session-secret", app_id: "codex-app", instruction: "token=s3cr3t-value",
      result: "authorization: Bearer s3cr3t-value", changed_resources: [], verification: "not_run", outcome: "completed",
      occurred_at: now, payload: { access_token: "s3cr3t-value", nested: { cookie: "s3cr3t-value" } }
    };
    const ingested = await service.ingest(event);
    const stored = await store.listRecords("activity_event");
    expect(JSON.stringify(stored)).not.toContain("s3cr3t-value");
    expect(ingested.activity.instruction).toBe("token=[REDACTED]");
    expect(ingested.activity.payload).toMatchObject({ access_token: "[REDACTED]", nested: { cookie: "[REDACTED]" } });
  });

  it("creates one frozen startup snapshot within the token budget", async () => {
    const store = new MemoryExternalIntegrationStore();
    const service = new ContextSnapshotService({
      store,
      now: () => new Date(now),
      id: () => "snapshot-1",
      source: async () => ({
        workspaceName: "Workspace",
        roomName: "Room",
        roomPurpose: "Room purpose",
        workGoal: "Ship the external integration",
        fixedKnowledge: [{ id: "fixed-1", version: 2, title: "Fixed decision", summary: "Keep the Room boundary", fixed: true }],
        pinnedKnowledge: [{ id: "pinned-1", version: "memory-v1", title: "Pinned note", summary: "Use formal ingress", pinned: true }],
        rules: Array.from({ length: 200 }, (_, index) => `rule-${index}`),
        permissions: ["room.read"],
        tools: ["samurai.context.snapshot"]
      })
    });
    const target: ExternalWorkspaceTarget = { workspaceId: "workspace-1", roomId: "room-1", projectRef: "project-a", accountId: "account-1", connectionId: "connection-1", connectorId: "codex", appId: "codex-app", bindingVersion: 1, externalSessionId: "session-snapshot" };
    const snapshot = await service.create(target);
    expect(snapshot).toMatchObject({ id: "snapshot-1", frozen: true, token_count: expect.any(Number) });
    expect(snapshot.token_count).toBeLessThanOrEqual(1_500);
    expect(snapshot.content).toContain("Workspace");
    expect(snapshot.content).toContain("Ship the external integration");
    expect(snapshot.resource_versions).toEqual(expect.arrayContaining([{ resource_id: "pinned-1", version: "memory-v1" }]));
    expect(snapshot.omitted_sections).toEqual(expect.any(Array));
    expect(snapshot.content).not.toContain("Artifact本文");
  });

  it("reuses one deterministic snapshot when startup requests race", async () => {
    const store = new MemoryExternalIntegrationStore();
    const source = async (): Promise<ContextSnapshotSource> => ({
      workspaceName: "Workspace",
      roomName: "Room",
      fixedKnowledge: [],
      pinnedKnowledge: [],
      rules: [],
      permissions: ["room.read"],
      tools: ["samurai.context.snapshot"]
    });
    const service = new ContextSnapshotService({ store, now: () => new Date(now), source });
    const target: ExternalWorkspaceTarget = {
      workspaceId: "workspace-race",
      roomId: "room-race",
      projectRef: "project-race",
      accountId: "account-race",
      connectionId: "connection-race",
      connectorId: "codex",
      appId: "codex-app",
      bindingVersion: 3,
      externalSessionId: "session-race"
    };

    const [first, second] = await Promise.all([service.create(target), service.create(target)]);
    expect(first.id).toBe(second.id);
    expect((await store.listRecords("context_snapshot")).filter((item) => item.id === first.id)).toHaveLength(1);
    expect((await store.listRecords("audit_event")).filter((item) => item.event_type === "context.snapshot.created" && item.resource_id === first.id)).toHaveLength(1);
  });

  it("validates the complete published JSON Schema subset", () => {
    const schema = {
      type: "object",
      properties: {
        mode: { type: ["string", "null"], pattern: "^[a-z]+$" },
        count: { type: "integer", minimum: 1, maximum: 3 },
        items: {
          type: "array",
          minItems: 1,
          items: {
            oneOf: [
              { type: "string", enum: ["fixed"] },
              { type: "object", properties: { id: { type: "string", minLength: 1 } }, required: ["id"], additionalProperties: false }
            ]
          }
        }
      },
      required: ["mode", "count", "items"],
      additionalProperties: false
    } as Record<string, unknown>;
    expect(() => validateMcpSchema({ mode: "room", count: 2, items: ["fixed", { id: "r1" }] }, schema)).not.toThrow();
    let invalid: unknown;
    try {
      validateMcpSchema({ mode: "ROOM", count: 4, items: [{ id: "r1", extra: true }] }, schema);
    } catch (error) {
      invalid = error;
    }
    expect(invalid).toMatchObject({ code: "mcp_invalid_arguments" });
  });

  it("generates token-free Codex, Claude Code, and Hermes client configs", () => {
    for (const client of ["codex", "claude_code", "hermes"] as const) {
      const adapter = getExternalClientAdapter(client);
      const config = adapter.renderConfig({ serverUrl: "https://samurai.example/mcp", projectRef: "project-a" });
      expect(config).toContain("samurai");
      expect(config).not.toMatch(/access_token|refresh_token|Bearer|client_secret/i);
      expect(adapter.configPath("darwin")).toBeTruthy();
      expect(adapter.configPath("win32")).toBeTruthy();
      expect(adapter.configPath("linux")).toBeTruthy();
    }
    for (const client of ["codex", "claude_code", "hermes"] as const) {
      const hook = getExternalClientAdapter(client).hookConfig;
      expect(hook).toBeDefined();
      const config = hook!.renderConfig({ projectRef: "project-a", os: "darwin", relayCommand: "samurai-hook-relay", connectorVersion: "0.1.0" });
      expect(config).toContain("samurai-hook-relay");
      expect(config).toContain("--connector-version");
      expect(config).toContain("0.1.0");
      expect(config).not.toMatch(/SAMURAI_EXTERNAL_HOOK_TOKEN|access_token|refresh_token|Bearer|client_secret/i);
    }
  });

  it("normalizes provider Hook fields without preserving secret-bearing payloads", () => {
    const event = getExternalClientAdapter("codex").normalizeHook({
      session_id: "codex-session", hook_event_name: "SessionEnd", turn_id: "turn-1", cwd: "/tmp/project",
      prompt: "api_key=secret", tool_input: { authorization: "Bearer secret" }, error: "token=secret", success: true
    });
    expect(event).toMatchObject({
      connector_id: "codex", event_kind: "codex.SessionEnd", external_session_id: "codex-session",
      verification: "not_run", outcome: "completed"
    });
    expect(JSON.stringify(event)).not.toContain("secret");
    expect(event.payload).not.toHaveProperty("tool_input");

    const hermesEvent = getExternalClientAdapter("hermes").normalizeHook({
      hook_event_name: "on_session_end", session_id: "hermes-session", cwd: "/tmp/project",
      user_message: "Ship the change", assistant_response: "Done", tool_name: "terminal", tool_input: { command: "echo ok" }
    });
    expect(hermesEvent).toMatchObject({
      connector_id: "hermes", event_kind: "hermes.on_session_end", external_session_id: "hermes-session",
      instruction: "Ship the change", result: "Done", verification: "not_run", outcome: "unknown"
    });
    expect(JSON.stringify(hermesEvent)).not.toContain("echo ok");
  });

  it("serves MCP initialize, scoped reads, and approval responses", async () => {
    const store = new MemoryExternalIntegrationStore();
    const approval = new ApprovalService({ store, publicBaseUrl: "https://samurai.example", now: () => new Date(now) });
    const target: ExternalWorkspaceTarget = { workspaceId: "workspace-1", roomId: "room-1", projectRef: "project-a", accountId: "account-1", connectionId: "connection-1", connectorId: "codex", appId: "codex-app", bindingVersion: 1, externalSessionId: "session-a" };
    const auth: ExternalIntegrationAuthContext = { workspaceId: "workspace-1", accountId: "account-1", connectionId: "connection-1", connectorId: "codex", appId: "codex-app", scopes: ["workspace.read", "room.read", "knowledge.read", "resource.write", "approval.execute"], tokenVersion: 1, expiresAt: now };
    const port: McpWorkspacePort = {
      getBinding: async () => ({ room_id: "room-1", binding_version: 1 }),
      resolveTarget: async () => target,
      getCapabilities: async () => ({ connector_id: "codex" }),
      getContextSnapshot: async () => ({ content: "snapshot", frozen: true }),
      query: async (_target, _operation, args) => args.query === "invalid-result"
        ? { items: [] }
        : {
            items: [{
              resource_id: "knowledge-1",
              room_id: "room-1",
              version: 1,
              evidence: { connector_id: "codex", app_id: "codex-app" },
              provenance: { source: "samurai", access: "ExternalAppIngress", room_id: "room-1", resource_id: "knowledge-1" },
              data: { id: "knowledge-1" }
            }],
            next_cursor: null
          },
      mutate: async (_target, operation) => ({ operation }),
      ingestActivity: async () => ({ accepted: true }),
      getCurrentVersions: async () => ({ "artifact:r1": 2 })
    };
    const mcp = new McpProtocolServer({
      auth: { authenticateAccessToken: async () => auth },
      workspace: port,
      approval,
      mutationTools: [{
        name: "samurai.artifact.revise",
        operation: "artifact.revise",
        description: "Revise an Artifact.",
        scopes: ["resource.write"],
        inputSchema: { type: "object", properties: { artifact_id: { type: "string" }, base_revision_id: { type: "string" } }, required: ["artifact_id", "base_revision_id"], additionalProperties: false },
        outputSchema: { type: "object", properties: { operation: { const: "artifact.revise" } }, required: ["operation"], additionalProperties: false }
      }]
    });
    const initialized = await mcp.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "Codex", version: "1" }, capabilities: { elicitation: { url: true } } } }, undefined, "mcp-test", { projectRef: "project-a", externalSessionId: "session-a" });
    expect(initialized?.result).toHaveProperty("protocolVersion");
    const listed = await mcp.handle({ jsonrpc: "2.0", id: 11, method: "tools/list" }, undefined, "mcp-test");
    expect(listed?.result?.tools).toEqual(expect.arrayContaining([expect.objectContaining({ name: "samurai.artifact.revise", outputSchema: expect.any(Object) })]));
    const standardTools = ((listed?.result?.tools ?? []) as Array<{ name?: string; outputSchema?: Record<string, unknown> }>).filter((tool) => tool.name?.startsWith("samurai.") && tool.name !== "samurai.artifact.revise");
    expect(standardTools).toHaveLength(17);
    for (const tool of standardTools) {
      const schema = tool.outputSchema!;
      const variants = Array.isArray(schema.anyOf) ? schema.anyOf : [schema];
      expect(variants.every((variant) => Boolean(variant) && typeof variant === "object" && (variant as Record<string, unknown>).additionalProperties === false)).toBe(true);
    }
    const read = await mcp.handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "samurai.knowledge.search", arguments: { project_ref: "project-a", external_session_id: "session-a", query: "hello" } } }, "Bearer token", "mcp-test");
    expect(read?.result).toMatchObject({ isError: false });
    const malformedResult = await mcp.handle({ jsonrpc: "2.0", id: 21, method: "tools/call", params: { name: "samurai.knowledge.search", arguments: { project_ref: "project-a", external_session_id: "session-a", query: "invalid-result" } } }, "Bearer token", "mcp-test");
    expect(malformedResult?.error?.message).toBe("mcp_invalid_result");
    const invalidRead = await mcp.handle({ jsonrpc: "2.0", id: 22, method: "tools/call", params: { name: "samurai.knowledge.search", arguments: { project_ref: "project-a", external_session_id: "session-a", unexpected: true } } }, "Bearer token", "mcp-test");
    expect(invalidRead?.error?.message).toBe("mcp_invalid_arguments");
    const missingBindingVersion = await mcp.handle({ jsonrpc: "2.0", id: 23, method: "tools/call", params: { name: "samurai.room.binding.change", arguments: { project_ref: "project-a", external_session_id: "session-a", room_id: "room-2", idempotency_key: "binding-1" } } }, "Bearer token", "mcp-test");
    expect(missingBindingVersion?.error?.message).toBe("mcp_invalid_arguments");
    const dangerous = await mcp.handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "samurai.artifact.revise", arguments: { project_ref: "project-a", external_session_id: "session-a", input: { artifact_id: "r1", base_revision_id: "revision-1" }, expected_versions: { "artifact:r1": 2 }, idempotency_key: "write-1" } } }, "Bearer token", "mcp-test");
    expect(dangerous?.result?.structuredContent).toMatchObject({ approval_required: true });
    const approvalContent = dangerous?.result?.structuredContent as { approval_id: string; approval_url: string };
    const approvalUrl = new URL(approvalContent.approval_url);
    expect(approvalUrl.searchParams.get("workspace_id")).toBe("workspace-1");
    const approvalToken = approvalUrl.searchParams.get("approval_token");
    expect(approvalToken).toBeTruthy();
    const approved = await approval.approve({ approvalId: approvalContent.approval_id, approvalToken: approvalToken!, accountId: "account-1" });
    expect(await mcp.executeApproved(approved.id, "account-1")).toEqual({ operation: "artifact.revise" });

    const localOriginMcp = new McpProtocolServer({
      auth: { authenticateAccessToken: async () => auth },
      workspace: port,
      approval,
      allowedOrigins: ["https://samurai.example", "http://127.0.0.1"]
    });
    expect(() => localOriginMcp.validateTransport({ origin: "http://127.0.0.1:4317" })).not.toThrow();
    expect(() => localOriginMcp.validateTransport({ origin: "https://attacker.example" })).toThrowError("mcp_origin_invalid");
  });

  it("supports bounded tool timeout and cancellation", async () => {
    const store = new MemoryExternalIntegrationStore();
    const approval = new ApprovalService({ store, publicBaseUrl: "https://samurai.example", now: () => new Date(now) });
    const auth: ExternalIntegrationAuthContext = { workspaceId: "workspace-1", accountId: "account-1", connectionId: "connection-1", connectorId: "codex", appId: "codex-app", scopes: ["knowledge.read"], tokenVersion: 1, expiresAt: now };
    let resolveQuery: (() => void) | undefined;
    const queryStarted = new Promise<void>((resolve) => { resolveQuery = resolve; });
    const port: McpWorkspacePort = {
      getBinding: async () => ({ room_id: "room-1", binding_version: 1 }),
      resolveTarget: async () => ({ workspaceId: "workspace-1", roomId: "room-1", projectRef: "project-a", accountId: "account-1", connectionId: "connection-1", connectorId: "codex", appId: "codex-app", bindingVersion: 1, externalSessionId: "session-a" }),
      getCapabilities: async () => ({}), getContextSnapshot: async () => ({}),
      query: async () => { await queryStarted; return { items: [] }; },
      mutate: async () => ({}), ingestActivity: async () => ({}), getCurrentVersions: async () => ({})
    };
    const mcp = new McpProtocolServer({ auth: { authenticateAccessToken: async () => auth }, workspace: port, approval, toolTimeoutMs: 10 });
    await mcp.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, undefined, "mcp-timeout", { projectRef: "project-a", externalSessionId: "session-a" });
    const timeout = await mcp.handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "samurai.knowledge.search", arguments: { project_ref: "project-a", external_session_id: "session-a" } } }, "Bearer token", "mcp-timeout");
    expect(timeout?.error?.message).toBe("mcp_timeout");

    const cancellable = new McpProtocolServer({ auth: { authenticateAccessToken: async () => auth }, workspace: port, approval, toolTimeoutMs: 100 });
    await cancellable.handle({ jsonrpc: "2.0", id: 4, method: "initialize", params: {} }, undefined, "mcp-cancel", { projectRef: "project-a", externalSessionId: "session-a" });
    const cancelPromise = cancellable.handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "samurai.knowledge.search", arguments: { project_ref: "project-a", external_session_id: "session-a" } } }, "Bearer token", "mcp-cancel");
    await new Promise((resolve) => setTimeout(resolve, 10));
    await cancellable.handle({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 3 } }, undefined, "mcp-cancel");
    const cancelled = await cancelPromise;
    expect(cancelled?.error?.message).toBe("mcp_cancelled");
    resolveQuery?.();

    let resolveDisconnectedQuery: (() => void) | undefined;
    const disconnectedQuery = new Promise<void>((resolve) => { resolveDisconnectedQuery = resolve; });
    const disconnectedPort: McpWorkspacePort = {
      ...port,
      query: async () => { await disconnectedQuery; return { items: [] }; }
    };
    const disconnected = new McpProtocolServer({ auth: { authenticateAccessToken: async () => auth }, workspace: disconnectedPort, approval, toolTimeoutMs: 100 });
    await disconnected.handle({ jsonrpc: "2.0", id: 5, method: "initialize", params: {} }, undefined, "mcp-disconnected", { projectRef: "project-a", externalSessionId: "session-a" });
    const requestController = new AbortController();
    const disconnectedPromise = disconnected.handle({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "samurai.knowledge.search", arguments: { project_ref: "project-a", external_session_id: "session-a" } } }, "Bearer token", "mcp-disconnected", {}, requestController.signal);
    await new Promise((resolve) => setTimeout(resolve, 10));
    requestController.abort();
    const disconnectedResult = await disconnectedPromise;
    expect(disconnectedResult?.error?.message).toBe("mcp_cancelled");
    resolveDisconnectedQuery?.();
  });

  it("keeps DCR bounded and redirects browser approval to the exact client callback", async () => {
    const store = new MemoryExternalIntegrationStore();
    const lookup = connectionLookup();
    const connectors = new ConnectorRegistry({ store, samuraiVersion: "0.1.0", now: () => new Date(now), id: () => "installation-http" });
    await connectors.registerManifest({
      connector_id: "codex", display_name: "Codex", provider: "OpenAI", version: "1.0.0", supported_os: ["darwin"], required_samurai_version: "0.1.0",
      transport: "streamable_http", oauth_redirect_uris: ["https://client.example/callback"], requested_scopes: ["workspace.read"], supported_events: [],
      context_injection: "startup_tool", full_capture: "unsupported", url_elicitation: "fallback", package_checksum: "sha256:http"
    });
    await connectors.install({ workspaceId: "workspace-1", connectorId: "codex", version: "1.0.0" });
    const oauth = new OAuthService({ store, connections: lookup, browserAuthorization: { assertBrowserAccount: async () => undefined }, publicBaseUrl: "https://samurai.example", dynamicClientRegistration: true, now: () => new Date(now) });
    const approval = new ApprovalService({ store, publicBaseUrl: "https://samurai.example", now: () => new Date(now) });
    const workspace: McpWorkspacePort = {
      getBinding: async () => undefined, resolveTarget: async () => { throw new Error("not_used"); }, getCapabilities: async () => ({}), getContextSnapshot: async () => ({}),
      query: async () => ({}), mutate: async () => ({}), ingestActivity: async () => ({}), getCurrentVersions: async () => ({})
    };
    const capture = new CaptureService({
      store,
      encryptionKey: Buffer.alloc(32, 3),
      authorization: { assertRead: async () => undefined, assertDelete: async () => undefined },
      now: () => new Date(now)
    });
    const mcp = new McpProtocolServer({ auth: { authenticateAccessToken: async () => { throw new ExternalIntegrationError("mcp_auth_required"); } }, workspace, approval, protectedResourceUrl: "https://samurai.example/mcp" });
    const handler = createExternalIntegrationHttpHandler({
      mcp, oauth, approval,
      connectors,
      capture,
      resourceUrl: "https://samurai.example/mcp",
      browserSession: { getAccountId: async () => "account-1", assertCsrf: async () => undefined }
    });
    const registered = await handler({ method: "POST", url: "https://samurai.example/oauth/register", body: { client_name: "Codex", workspace_id: "workspace-1", connector_id: "codex", redirect_uris: ["https://client.example/callback"], allowed_scopes: ["workspace.read"] } });
    expect(registered.status).toBe(201);
    const registeredFromResource = await handler({ method: "POST", url: "https://samurai.example/oauth/register", body: { client_name: "Codex from resource", resource: "https://samurai.example/mcp?workspace_id=workspace-1", connector_id: "codex", redirect_uris: ["https://client.example/callback"], allowed_scopes: ["workspace.read"] } });
    expect(registeredFromResource.status).toBe(201);
    const registeredFromCanonicalResource = await handler({ method: "POST", url: "https://samurai.example/oauth/register", body: { client_name: "Codex canonical resource", workspace_id: "workspace-1", resource: "https://samurai.example/mcp", connector_id: "codex", redirect_uris: ["https://client.example/callback"], allowed_scopes: ["workspace.read"] } });
    expect(registeredFromCanonicalResource.status).toBe(201);
    const mismatchedRegistration = await handler({ method: "POST", url: "https://samurai.example/oauth/register", body: { client_name: "Wrong workspace", workspace_id: "workspace-2", resource: "https://samurai.example/mcp?workspace_id=workspace-1", connector_id: "codex", redirect_uris: ["https://client.example/callback"], allowed_scopes: ["workspace.read"] } });
    expect(mismatchedRegistration.status).toBe(403);
    const invalid = await handler({ method: "POST", url: "https://samurai.example/oauth/register", body: { client_name: "Codex", workspace_id: "workspace-1", connector_id: "codex", redirect_uris: [], allowed_scopes: ["workspace.read"] } });
    expect(invalid.status).toBe(400);
    const client = JSON.parse(registered.body) as { client_id: string };
    const { verifier, challenge } = pkce();
    const standardAuthorization = new URL("https://samurai.example/oauth/authorize");
    standardAuthorization.searchParams.set("client_id", client.client_id);
    standardAuthorization.searchParams.set("redirect_uri", "https://client.example/callback");
    standardAuthorization.searchParams.set("response_type", "code");
    standardAuthorization.searchParams.set("scope", "workspace.read");
    standardAuthorization.searchParams.set("state", "state-from-resource");
    standardAuthorization.searchParams.set("code_challenge", challenge);
    standardAuthorization.searchParams.set("code_challenge_method", "S256");
    standardAuthorization.searchParams.set("resource", "https://samurai.example/mcp?workspace_id=workspace-1&project_ref=project-a");
    const startedFromResource = await handler({ method: "GET", url: standardAuthorization.toString() });
    expect(startedFromResource.status).toBe(302);
    expect(startedFromResource.headers.location).toContain("request_id=");
    const canonicalClient = JSON.parse(registeredFromCanonicalResource.body) as { client_id: string };
    const canonicalAuthorization = new URL("https://samurai.example/oauth/authorize");
    canonicalAuthorization.searchParams.set("client_id", canonicalClient.client_id);
    canonicalAuthorization.searchParams.set("workspace_id", "workspace-1");
    canonicalAuthorization.searchParams.set("redirect_uri", "https://client.example/callback");
    canonicalAuthorization.searchParams.set("response_type", "code");
    canonicalAuthorization.searchParams.set("scope", "workspace.read");
    canonicalAuthorization.searchParams.set("state", "state-canonical-resource");
    canonicalAuthorization.searchParams.set("code_challenge", challenge);
    canonicalAuthorization.searchParams.set("code_challenge_method", "S256");
    canonicalAuthorization.searchParams.set("resource", "https://samurai.example/mcp");
    await expect(handler({ method: "GET", url: canonicalAuthorization.toString() })).resolves.toMatchObject({ status: 302 });
    const mismatchedAuthorization = await handler({ method: "GET", url: `${standardAuthorization.toString()}&workspace_id=workspace-2` });
    expect(mismatchedAuthorization.status).toBe(403);
    const started = await oauth.beginAuthorization({ workspaceId: "workspace-1", clientId: client.client_id, redirectUri: "https://client.example/callback", responseType: "code", scope: "workspace.read", state: "state-1", codeChallenge: challenge, codeChallengeMethod: "S256" });
    const page = await handler({ method: "GET", url: started.authorizationUrl });
    expect(page.status).toBe(200);
    const callback = await handler({ method: "POST", url: "https://samurai.example/oauth/authorize", body: { request_id: started.requestId } });
    expect(callback.status).toBe(302);
    expect(new URL(callback.headers.location).origin).toBe("https://client.example");
    expect(new URL(callback.headers.location).searchParams.get("state")).toBe("state-1");
    expect(verifier).toBeTruthy();

    const deniedRequest = await oauth.beginAuthorization({ workspaceId: "workspace-1", clientId: client.client_id, redirectUri: "https://client.example/callback", responseType: "code", scope: "workspace.read", state: "state-denied", codeChallenge: challenge, codeChallengeMethod: "S256" });
    const deniedPage = await handler({ method: "GET", url: deniedRequest.authorizationUrl });
    expect(deniedPage.status).toBe(200);
    expect(deniedPage.body).toContain("Deny");
    expect(deniedPage.body).toContain("workspace-1");
    const deniedCallback = await handler({ method: "POST", url: "https://samurai.example/oauth/deny", body: { request_id: deniedRequest.requestId } });
    expect(deniedCallback.status).toBe(302);
    expect(new URL(deniedCallback.headers.location).searchParams.get("error")).toBe("access_denied");
    await expect(oauth.approveAuthorization({ requestId: deniedRequest.requestId, accountId: "account-1" })).rejects.toMatchObject({ code: "oauth_authorization_denied" });

    const connectorConfig = await handler({ method: "GET", url: "https://samurai.example/connectors/config?workspace_id=workspace-1&connector_id=codex&project_ref=project-a&os=darwin" });
    expect(connectorConfig.status).toBe(200);
    expect(JSON.parse(connectorConfig.body)).toMatchObject({
      config: expect.stringContaining("workspace_id=workspace-1"),
      hook: { availability: "configuration_required", reason: "hook_relay_command_required" }
    });

    const savedCapturePolicy = await handler({
      method: "POST",
      url: "https://samurai.example/capture/policy",
      body: {
        workspace_id: "workspace-1", connection_id: "connection-1", enabled: true,
        conversation: true, terminal: false, intermediate_log: false,
        retention_days: 30, quota_bytes: 100_000
      }
    });
    expect(savedCapturePolicy.status).toBe(200);
    const readCapturePolicy = await handler({ method: "GET", url: "https://samurai.example/capture/policy?workspace_id=workspace-1&connection_id=connection-1" });
    expect(JSON.parse(readCapturePolicy.body).policy).toMatchObject({ enabled: true, conversation: true });

    const initialized = await handler({ method: "POST", url: "https://samurai.example/mcp?project_ref=project-a&external_session_id=session-a", body: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} } });
    const unauthenticated = await handler({
      method: "POST",
      url: "https://samurai.example/mcp?project_ref=project-a&external_session_id=session-a",
      headers: { "mcp-session-id": initialized.headers["Mcp-Session-Id"], "mcp-protocol-version": "2025-11-25" },
      body: { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "samurai.knowledge.search", arguments: {} } }
    });
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers["WWW-Authenticate"]).toContain("resource_metadata");
  });

  it("limits an official loopback DCR client and binds issued tokens to this MCP Resource", async () => {
    const store = new MemoryExternalIntegrationStore();
    const lookup = connectionLookup();
    const connectors = new ConnectorRegistry({ store, samuraiVersion: "0.1.0", now: () => new Date(now), id: () => "official-installation" });
    const manifest = officialConnectorManifests().find((candidate) => candidate.connector_id === "codex");
    if (!manifest) throw new Error("codex_manifest_missing");
    await connectors.registerManifest(manifest);
    await connectors.install({ workspaceId: "workspace-1", connectorId: "codex", version: manifest.version });
    const oauth = new OAuthService({
      store,
      connections: lookup,
      browserAuthorization: { assertBrowserAccount: async () => undefined },
      publicBaseUrl: "https://samurai.example",
      protectedResourceUrl: "https://samurai.example/mcp",
      dynamicClientRegistration: true,
      now: () => new Date(now)
    });
    const client = await oauth.registerDynamicClient({
      workspaceId: "workspace-1",
      clientName: "Codex local",
      connectorId: "codex",
      redirectUris: ["http://127.0.0.1:23119/oauth/callback"],
      allowedScopes: ["workspace.read"]
    });
    await expect(oauth.registerDynamicClient({
      workspaceId: "workspace-1",
      clientName: "not-local",
      connectorId: "codex",
      redirectUris: ["https://client.example/callback"],
      allowedScopes: ["workspace.read"]
    })).rejects.toMatchObject({ code: "oauth_redirect_uri_mismatch" });
    const { verifier, challenge } = pkce();
    const authorization = await oauth.beginAuthorization({
      workspaceId: "workspace-1",
      clientId: client.client_id,
      redirectUri: "http://127.0.0.1:23119/oauth/callback",
      responseType: "code",
      scope: "workspace.read",
      state: "state-resource",
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
      resource: "https://samurai.example/mcp?project_ref=project-a"
    });
    const approved = await oauth.approveAuthorization({ requestId: authorization.requestId, accountId: "account-1" });
    const token = await oauth.exchangeCode({
      workspaceId: "workspace-1",
      clientId: client.client_id,
      code: approved.code,
      redirectUri: "http://127.0.0.1:23119/oauth/callback",
      codeVerifier: verifier,
      resource: "https://samurai.example/mcp?project_ref=project-a"
    });
    await expect(oauth.authenticateAccessToken(token.access_token, { resourceUrl: "https://other.example/mcp" })).rejects.toMatchObject({ code: "oauth_resource_invalid" });
    await expect(oauth.authenticateAccessToken(token.access_token, { resourceUrl: "https://samurai.example/mcp" })).resolves.toMatchObject({ workspaceId: "workspace-1" });
  });
});

function inputForCapture() {
  return { workspaceId: "workspace-1", connectionId: "connection-1", accountId: "account-1", externalSessionId: "session-a", roomId: "room-1", kind: "terminal" as const };
}
