import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHmac, generateKeyPairSync, sign } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { stableHash, type JsonValue } from "@samurai-agent/core-schemas";
import { localOwnerParticipantId } from "@samurai-agent/room-permissions";
import { createDefaultAgentBackendRegistry, FakeProviderAdapter, ProviderRequestError, type ExternalAssistProvider, type ProviderAdapter, type ProviderInput, type ProviderOutput } from "@samurai-agent/runtime";
import { closeApiServer, createApiServer, installServerSignalHandlers, loadServerEnv, resolveWorkspaceRoot, setGatewayEmailImapClientFactoryForTest, type ApiServer, type CreateApiServerOptions } from "./index";

const roots: string[] = [];
const servers: ApiServer[] = [];
const managedEnv = new Map<string, string | undefined>();

interface SurfaceRenderSpecApi {
  kind: string;
  props: Record<string, unknown>;
}

interface SurfaceMessagePresentation {
  id: string;
  collection_id: string;
  view_id: string;
  renderer: string;
  view_state?: Record<string, unknown>;
}

interface SurfaceOperationApiResult {
  operation: { kind: string };
  result_kind: string;
  render_spec: SurfaceRenderSpecApi;
  render_specs: SurfaceRenderSpecApi[];
  result: Record<string, unknown> & {
    collection_id?: string;
    view_id?: string;
    messagePresentations: SurfaceMessagePresentation[];
    chat?: {
      messages?: Array<{ role?: string; content?: string }>;
      backendRun?: { id?: string; status?: string };
    };
  };
}

interface ActionBackendInputSnapshot {
  envelope: {
    metadata: Record<string, JsonValue>;
    user_intent: string;
  };
}

afterEach(async () => {
  try {
    await Promise.all(servers.splice(0).map((server) => closeApiServer(server)));
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  } finally {
    setGatewayEmailImapClientFactoryForTest();
    restoreManagedEnv();
  }
});

describe("server env loading", () => {
  it("does nothing when the env file is missing", () => {
    expect(() => loadServerEnv(path.join(tmpdir(), `missing-samurai-${Date.now()}`, ".env"))).not.toThrow();
  });

  it("resolves Workspace root with the new env taking priority over v1 compatibility env", () => {
    const root = path.join(tmpdir(), "samurai-workspace-root");
    const legacy = path.join(tmpdir(), "samurai-legacy-workspace");

    expect(resolveWorkspaceRoot(undefined, {
      ...process.env,
      SAMURAI_WORKSPACE_ROOT: root,
      WORKSPACE_DATA_DIR: legacy
    })).toBe(path.resolve(root));
    expect(resolveWorkspaceRoot(undefined, {
      ...process.env,
      SAMURAI_WORKSPACE_ROOT: "",
      WORKSPACE_DATA_DIR: legacy
    })).toBe(path.resolve(legacy));
    expect(resolveWorkspaceRoot(path.join(tmpdir(), "samurai-option-workspace"), {
      ...process.env,
      SAMURAI_WORKSPACE_ROOT: root,
      WORKSPACE_DATA_DIR: legacy
    })).toBe(path.resolve(path.join(tmpdir(), "samurai-option-workspace")));
  });

  it("loads env file values through process.loadEnvFile", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-env-"));
    roots.push(root);
    const envPath = path.join(root, ".env");
    deleteManagedEnv("SAMURAI_ENV_LOAD_TEST");
    deleteManagedEnv("PORT");

    await writeFile(envPath, "SAMURAI_ENV_LOAD_TEST=loaded\nPORT=49321\n", "utf8");
    loadServerEnv(envPath);

    expect(process.env.SAMURAI_ENV_LOAD_TEST).toBe("loaded");
    expect(process.env.PORT).toBe("49321");
  });

  it("fails clearly when an env file exists but process.loadEnvFile is unavailable", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-env-"));
    roots.push(root);
    const envPath = path.join(root, ".env");
    await writeFile(envPath, "SAMURAI_ENV_LOAD_TEST=loaded\n", "utf8");
    const originalLoadEnvFile = process.loadEnvFile;

    Object.defineProperty(process, "loadEnvFile", { configurable: true, value: undefined });
    try {
      expect(() => loadServerEnv(envPath)).toThrow("process.loadEnvFile()");
    } finally {
      Object.defineProperty(process, "loadEnvFile", { configurable: true, value: originalLoadEnvFile });
    }
  });

  it("keeps injected fake providers even when provider env is set", async () => {
    setManagedEnv("SAMURAI_LLM_MODEL", "openai/test-model");
    setManagedEnv("OPENAI_API_KEY", "test-key");
    const { baseUrl } = await startTestServer();

    const health = await getJson<{ lifecycle: { started_at: string; listening: boolean; scheduler_enabled: boolean }; llm: { primary: { provider: string; model: string } }; workspace: { ok: boolean; memory: { indexed: number }; skills: { indexed: number } }; policy: { capabilities: number; decisions: number }; release: { non_destructive: { status: string; command: string }; external_effects_confirmed: boolean; manual_gate_count: number; manual_gates: Array<{ id: string; status: string; confirmation_flag: string; runbook: string }>; profiles: Array<{ id: string; status: string; manual_gate_ids: string[] }> } }>(`${baseUrl}/api/health`);
    const workspace = await getJson<{ ok: boolean; layout: { ok: boolean }; indexes: { wiki: { files: number; indexed: number } } }>(`${baseUrl}/api/workspace/health`);
    const integrity = await getJson<{ ok: boolean; db: { ok: boolean }; workspace: { ok: boolean } }>(`${baseUrl}/api/workspace/integrity`);
    const actionCatalog = await getJson<{ actions: Array<{ id: string }>; plugins: Array<{ manifest_id: string }>; issues: unknown[] }>(`${baseUrl}/api/action-catalog`);
    const plugins = await getJson<{ plugins: Array<{ manifest_id: string; source: string }>; issues: unknown[] }>(`${baseUrl}/api/plugins`);
    const pluginDiagnostics = await getJson<{
      ok: boolean;
      built_in_plugins: number;
      filesystem_plugins: number;
      load_issue_count: number;
      plugins_with_missing_handlers: number;
      issues: unknown[];
    }>(`${baseUrl}/api/plugins/diagnostics`);
    const capabilities = await getJson<Array<{ id: string; operations: Array<{ operation: string }> }>>(`${baseUrl}/api/capabilities`);
    const capability = await getJson<{ id: string; operations: Array<{ operation: string }> }>(`${baseUrl}/api/capabilities/proposal_workspace`);
    const policyPreview = await postJson<{ decision: { decision: string; matched_rules: string[] }; preview: boolean; operation: { operation: string } }>(`${baseUrl}/api/policy/evaluate`, {
      capability_id: "proposal_workspace",
      operation: "external.send.dispatch",
      actor_identity: "owner",
      instruction_source: "owner_instruction",
      instruction_authority: "owner",
      channel: "web",
      target_resource_refs: [],
      proposed_effects: ["Dispatch a prepared external send."],
      prior_grants: [],
      recent_history: [],
      input_hash: "policy-preview-test"
    });
    const policyDecisions = await getJson<unknown[]>(`${baseUrl}/api/policy/decisions?room_id=room_default`);
    const repair = await postJson<{ dry_run: boolean; health: { ok: boolean } }>(`${baseUrl}/api/workspace/repair?room_id=room_default`, {});
    const backup = await postJson<{ id: string; manifest: { health_ok: boolean } }>(`${baseUrl}/api/workspace/backups?room_id=room_default`, {}, 201);
    const backups = await getJson<Array<{ id: string }>>(`${baseUrl}/api/workspace/backups?room_id=room_default`);

    expect(health.llm.primary).toMatchObject({ provider: "fake", model: "fake/test" });
    expect(health.lifecycle).toMatchObject({ listening: true, scheduler_enabled: false });
    expect(typeof health.lifecycle.started_at).toBe("string");
    expect(health.workspace.ok).toBe(true);
    expect(health.workspace.memory.indexed).toBe(0);
    expect(health.workspace.skills.indexed).toBe(0);
    expect(health.policy.capabilities).toBeGreaterThan(0);
    expect(health.policy.decisions).toBe(0);
    expect(health.release).toMatchObject({
      non_destructive: {
        status: "available",
        command: "CI=true pnpm run backend:release:verify -- --json"
      },
      external_effects_confirmed: false,
      manual_gate_count: 3
    });
    expect(health.release.manual_gates.map((gate) => gate.id)).toEqual([
      "external-backend-run-resume",
      "external-sandbox-run",
      "external-channel-service-e2e"
    ]);
    expect(health.release.manual_gates.every((gate) =>
      gate.status === "manual_opt_in_required"
      && gate.confirmation_flag === "--confirm-external-effects"
      && gate.runbook === "plans/backend-external-e2e-runbook.md"
    )).toBe(true);
    expect(health.release.profiles).toContainEqual(expect.objectContaining({
      id: "local_oss",
      status: "available",
      manual_gate_ids: []
    }));
    expect(health.release.profiles).toContainEqual(expect.objectContaining({
      id: "production_ops",
      status: "manual_opt_in_required",
      manual_gate_ids: ["external-backend-run-resume", "external-sandbox-run", "external-channel-service-e2e"]
    }));
    expect(workspace).toMatchObject({
      ok: true,
      layout: { ok: true },
      indexes: { wiki: { files: 0, indexed: 0 } }
    });
    expect(integrity).toMatchObject({ ok: true, db: { ok: true }, workspace: { ok: true } });
    expect(actionCatalog.actions.map((action) => action.id)).toContain("artifact.create");
    expect(actionCatalog.plugins.map((plugin) => plugin.manifest_id)).toContain("samurai-workspace-core");
    expect(actionCatalog.issues).toEqual([]);
    expect(plugins.plugins).toContainEqual(expect.objectContaining({
      manifest_id: "samurai-workspace-core",
      source: "built_in"
    }));
    expect(plugins.issues).toEqual([]);
    expect(pluginDiagnostics).toMatchObject({
      ok: true,
      built_in_plugins: 1,
      filesystem_plugins: 0,
      load_issue_count: 0,
      plugins_with_missing_handlers: 0,
      issues: []
    });
    expect(capabilities.map((item) => item.id)).toContain("proposal_workspace");
    expect(capability.operations.map((item) => item.operation)).toContain("external.send.dispatch");
    expect(policyPreview).toMatchObject({
      preview: true,
      operation: { operation: "external.send.dispatch" },
      decision: { decision: "requires_approval" }
    });
    expect(policyPreview.decision.matched_rules).toContain("manifest_default:requires_approval");
    expect(policyDecisions).toEqual([]);
    expect(repair).toMatchObject({ dry_run: true, health: { ok: true } });
    expect(backup.id.startsWith("backup_")).toBe(true);
    expect(backups.map((item) => item.id)).toContain(backup.id);
  }, 60_000);

  it("bootstraps the managed Workspace as an execution root", async () => {
    const { root } = await startTestServer();

    expect(existsSync(path.join(root, ".git"))).toBe(true);
  });

  it("exposes plugin diagnostics for filesystem plugin runtime readiness", async () => {
    const pluginRoot = await mkdtemp(path.join(tmpdir(), "samurai-plugin-diagnostics-"));
    roots.push(pluginRoot);
    await mkdir(path.join(pluginRoot, "plugins", "broken"), { recursive: true });
    await writeFile(path.join(pluginRoot, "plugins", "broken", "plugin.json"), JSON.stringify({
      id: "broken-plugin",
      name: "Broken Plugin",
      version: "1.0.0",
      kind: "tool",
      entrypoint: "missing-entrypoint.mjs",
      actions: [{
        id: "broken.echo",
        title: "Broken echo",
        description: "Echo through a missing plugin entrypoint.",
        input_schema: { type: "object" },
        output_schema: { type: "object" },
        resource_kinds: ["message"],
        handler_id: "broken.echo.handler",
        implementation_target: "plugin",
        ui_display_category: "custom_view"
      }],
      resource_kinds: ["message"],
      metadata: {}
    }, null, 2));
    const { baseUrl } = await startTestServer(
      new FakeProviderAdapter("fake/test", fakeProviderOutput),
      { pluginRootDir: pluginRoot }
    );

    const plugins = await getJson<{
      plugins: Array<{ manifest_id: string; entrypoint_status: string; signature_status: string; missing_handler_ids: string[] }>;
      issues: Array<{ code: string; file_path: string }>;
    }>(`${baseUrl}/api/plugins`);
    const diagnostics = await getJson<{
      ok: boolean;
      filesystem_plugins: number;
      filesystem_actions: number;
      entrypoint_not_ready_plugins: number;
      unsigned_entrypoint_plugins: number;
      plugins_with_missing_handlers: number;
      load_issue_count: number;
      issues: Array<{ code: string; severity: string; manifest_id?: string; issue_code?: string; missing_handler_ids?: string[] }>;
      recommendation: string;
    }>(`${baseUrl}/api/plugins/diagnostics`);

    expect(plugins.plugins).toContainEqual(expect.objectContaining({
      manifest_id: "broken-plugin",
      entrypoint_status: "missing",
      signature_status: "not_declared",
      missing_handler_ids: ["broken.echo.handler"]
    }));
    expect(plugins.issues).toContainEqual(expect.objectContaining({ code: "entrypoint_missing" }));
    expect(diagnostics).toMatchObject({
      ok: false,
      filesystem_plugins: 1,
      filesystem_actions: 1,
      entrypoint_not_ready_plugins: 1,
      unsigned_entrypoint_plugins: 1,
      plugins_with_missing_handlers: 1,
      load_issue_count: 1
    });
    expect(diagnostics.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "plugin_manifest_load_issue", issue_code: "entrypoint_missing", severity: "warning" }),
      expect.objectContaining({ code: "plugin_entrypoint_not_ready", manifest_id: "broken-plugin", severity: "warning" }),
      expect.objectContaining({ code: "plugin_unsigned_entrypoint", manifest_id: "broken-plugin", severity: "warning" }),
      expect.objectContaining({ code: "plugin_missing_handlers", manifest_id: "broken-plugin", severity: "critical", missing_handler_ids: ["broken.echo.handler"] })
    ]));
    expect(diagnostics.recommendation).toContain("critical plugin");
  });
});

describe("server shutdown", () => {
  it("shares closeApiServer, completes every cleanup, and closes WorkspaceStore last", async () => {
    const calls: string[] = [];
    let runtimeAttempts = 0;
    const lifecycle = { started_at: new Date().toISOString(), closing: false };
    const server = {
      lifecycle,
      scheduler: undefined,
      io: { close: () => calls.push("io") },
      httpServer: {
        listening: true,
        close: (callback: (error?: Error) => void) => {
          calls.push("http");
          callback();
        }
      },
      temporaryContexts: { close: async () => calls.push("temporary") },
      runtime: { shutdownMcpProcessPool: async () => {
        calls.push("runtime");
        runtimeAttempts += 1;
        if (runtimeAttempts === 1) throw new Error("runtime_shutdown_failed");
      } },
      store: { close: async () => calls.push("store") }
    } as unknown as ApiServer;

    const first = closeApiServer(server);
    const second = closeApiServer(server);
    expect(second).toBe(first);
    await expect(first).rejects.toBeInstanceOf(AggregateError);
    expect(calls).not.toContain("store");
    expect(server.lifecycle.closed_at).toBeUndefined();
    expect(server.lifecycle).toMatchObject({ closing: true, close_error: "api_server_close_failed" });
    const retry = closeApiServer(server);
    expect(retry).not.toBe(first);
    await retry;
    expect(calls.at(-1)).toBe("store");
    expect(server.lifecycle).toMatchObject({ closing: false, closed_at: expect.any(String) });
  });

  it("routes SIGINT and SIGTERM through the same shared shutdown", async () => {
    const calls: string[] = [];
    const server = {
      lifecycle: { started_at: new Date().toISOString(), closing: false },
      io: { close: () => calls.push("io") },
      httpServer: { listening: false },
      temporaryContexts: { close: async () => calls.push("temporary") },
      runtime: { shutdownMcpProcessPool: async () => calls.push("runtime") },
      store: { close: async () => calls.push("store") }
    } as unknown as ApiServer;
    const remove = installServerSignalHandlers(server);
    process.emit("SIGINT");
    process.emit("SIGTERM");
    await new Promise<void>((resolve) => setImmediate(resolve));
    remove();
    expect(calls).toEqual(["io", "temporary", "runtime", "store"]);
  });
});

describe("backend run API", () => {
  it("does not create approval requests for backend-native external work", async () => {
    const { baseUrl } = await startTestServer();
    const session = await postJson<{ id: string }>(`${baseUrl}/api/chat/sessions`, {}, 201);
    const turn = await postJson<{ approvalRequests: Array<{ id: string }>; backendEvents: Array<{ event_type: string; payload: Record<string, unknown> }> }>(`${baseUrl}/api/chat/sessions/${session.id}/messages`, {
      content: "提案書を作って、あとでメール送信もして",
      output_locale: "ja"
    }, 201);

    expect(turn.approvalRequests).toEqual([]);
    expect(turn.backendEvents.some((event) =>
      event.event_type === "tool_call_output"
      && event.payload.status === "completed"
      && event.payload.action_id === "external.send.prepare"
    )).toBe(true);
  });

  it("exposes external send diagnostics without leaking raw targets", async () => {
    deleteManagedEnv("SAMURAI_EXTERNAL_SEND_DISPATCH");
    setManagedEnv("SAMURAI_EMAIL_SMTP_HOST", "smtp.example.test");
    setManagedEnv("SAMURAI_EMAIL_FROM", "assistant@example.test");
    const { baseUrl, server } = await startTestServer();
    const session = await postJson<{ id: string }>(`${baseUrl}/api/chat/sessions`, {}, 201);
    const old = "2026-06-20T00:00:00.000Z";
    const recent = "2026-06-28T00:00:00.000Z";
    const diagnosticOperationId = "send-diagnostics-operation";
    await server.store.saveOperation({
      id: diagnosticOperationId,
      session_id: session.id,
      capability_id: "external_send",
      operation: "external.send.prepare",
      actor_identity: "owner",
      participant_id: localOwnerParticipantId,
      participant_kind: "human",
      requested_by_participant_id: localOwnerParticipantId,
      room_id: "room_default",
      principal: { kind: "human", participant_id: localOwnerParticipantId },
      source: { kind: "native_app", app_id: "samurai-native" },
      session_ref: { app_id: "samurai-native", session_id: session.id },
      instruction_source: "owner_instruction",
      instruction_authority: "owner",
      channel: "web",
      input_hash: stableHash({ diagnosticOperationId }),
      target_resource_refs: [],
      proposed_effects: [],
      status: "completed",
      created_at: recent,
      updated_at: recent
    });

    await server.store.saveExternalSend({
      id: "send_pending",
      channel: "webhook",
      status: "pending_approval",
      target: { url: "https://example.invalid/hook?token=secret" },
      title: "Pending webhook",
      body: "Pending body",
      operation_id: diagnosticOperationId,
      created_at: old,
      updated_at: old
    });
    await server.store.saveExternalSend({
      id: "send_dry_run",
      channel: "webhook",
      status: "approved",
      target: { url: "https://example.invalid/dry-run" },
      title: "Dry run webhook",
      body: "Dry run body",
      operation_id: diagnosticOperationId,
      dispatch_result: { dispatched: false, dry_run: true, adapter: "webhook", message: "Dry run recorded." },
      created_at: recent,
      updated_at: recent
    });
    await server.store.saveExternalSend({
      id: "send_failed",
      channel: "slack",
      status: "failed",
      target: {},
      title: "Failed Slack send",
      body: "Failed body",
      operation_id: diagnosticOperationId,
      dispatch_result: { dispatched: false, dry_run: false, adapter: "slack", message: "target missing" },
      created_at: recent,
      updated_at: recent
    });
    await server.store.saveExternalSend({
      id: "send_stale_draft",
      channel: "webhook",
      status: "draft",
      target: {},
      title: "Stale draft",
      body: "Draft body",
      operation_id: diagnosticOperationId,
      created_at: old,
      updated_at: old
    });

    const diagnostics = await getJson<{
      dispatch_enabled: boolean;
      dry_run_default: boolean;
      total_sends: number;
      pending_approval_sends: number;
      failed_sends: number;
      dry_run_approved_sends: number;
      stale_draft_sends: number;
      status_counts: Record<string, number>;
      channel_counts: Record<string, number>;
      transport_status_counts: Record<string, number>;
      transport_readiness: Array<{ channel: string; status: string; configured: boolean; dispatch_enabled: boolean; requires_target_url: boolean; message: string }>;
      issues: Array<{ code: string; severity: string; send_id: string; resource_ref?: { kind: string; uri: string } }>;
      recommendation: string;
    }>(`${baseUrl}/api/external-sends/diagnostics?stale_after_hours=1&room_id=room_default`);

    expect(diagnostics).toMatchObject({
      dispatch_enabled: false,
      dry_run_default: true,
      total_sends: 4,
      pending_approval_sends: 1,
      failed_sends: 1,
      dry_run_approved_sends: 1,
      stale_draft_sends: 2
    });
    expect(diagnostics.status_counts).toMatchObject({
      pending_approval: 1,
      approved: 1,
      failed: 1,
      draft: 1
    });
    expect(diagnostics.channel_counts).toMatchObject({
      webhook: 3,
      slack: 1
    });
    expect(diagnostics.transport_status_counts).toMatchObject({
      dry_run_only: 3,
      not_configured: 2
    });
    expect(diagnostics.transport_readiness).toEqual(expect.arrayContaining([
      expect.objectContaining({
        channel: "webhook",
        status: "dry_run_only",
        configured: true,
        dispatch_enabled: false,
        requires_target_url: true
      }),
      expect.objectContaining({
        channel: "slack",
        status: "dry_run_only",
        configured: true,
        dispatch_enabled: false,
        requires_target_url: true
      }),
      expect.objectContaining({
        channel: "telegram",
        status: "not_configured",
        configured: false,
        dispatch_enabled: false,
        requires_target_url: false
      }),
      expect.objectContaining({
        channel: "line",
        status: "not_configured",
        configured: false,
        dispatch_enabled: false,
        requires_target_url: false
      }),
      expect.objectContaining({
        channel: "email",
        status: "dry_run_only",
        configured: true,
        dispatch_enabled: false,
        requires_target_url: false
      })
    ]));
    expect(diagnostics.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "external_send_pending_approval", send_id: "send_pending" }),
      expect.objectContaining({ code: "external_send_dry_run_only", send_id: "send_dry_run" }),
      expect.objectContaining({ code: "external_send_failed", send_id: "send_failed", severity: "critical" }),
      expect.objectContaining({ code: "external_send_missing_target_url", send_id: "send_failed", severity: "critical" }),
      expect.objectContaining({ code: "external_send_stale_draft", send_id: "send_stale_draft" })
    ]));
    expect(diagnostics.issues[0]?.resource_ref?.kind).toBe("external_send");
    expect(diagnostics.recommendation).toContain("failed or misconfigured");
    expect(JSON.stringify(diagnostics)).not.toContain("token=secret");
    expect(JSON.stringify(diagnostics)).not.toContain("example.invalid/hook");
  });

  it("returns backend run events and workspace changes", async () => {
    const { baseUrl } = await startTestServer();
    const session = await postJson<{ id: string }>(`${baseUrl}/api/chat/sessions`, {}, 201);
    const turn = await postJson<{ backendRun: { id: string }; backendEvents: unknown[]; workspaceChanges: unknown[] }>(`${baseUrl}/api/chat/sessions/${session.id}/messages`, {
      content: "提案書を作って",
      output_locale: "ja"
    }, 201);

    const runs = await getJson<Array<{ id: string }>>(`${baseUrl}/api/backend-runs?session_id=${session.id}`);
    const events = await getJson<unknown[]>(`${baseUrl}/api/backend-runs/${turn.backendRun.id}/events`);
    const changes = await getJson<unknown[]>(`${baseUrl}/api/workspace-changes?session_id=${session.id}`);
    const streamSync = await postJson<{
      status: string;
      events: Array<{ event_type: string; payload: Record<string, unknown> }>;
    }>(`${baseUrl}/api/backend-runs/${turn.backendRun.id}/stream-sync`, {});
    const eventsAfterStreamSync = await getJson<Array<{ event_type: string }>>(`${baseUrl}/api/backend-runs/${turn.backendRun.id}/events`);
    const cancel = await postJson<{ status: string }>(`${baseUrl}/api/backend-runs/${turn.backendRun.id}/cancel`, {});

    expect(runs.some((run) => run.id === turn.backendRun.id)).toBe(true);
    expect(events.length).toBe(turn.backendEvents.length);
    expect(changes.length).toBe(turn.workspaceChanges.length);
    expect(streamSync).toMatchObject({
      status: "synced",
      events: [expect.objectContaining({ event_type: "backend_stream_synced" })]
    });
    expect(eventsAfterStreamSync.some((event) => event.event_type === "backend_stream_synced")).toBe(true);
    expect(cancel.status).toBe("completed");
  });

  it("queues client events through API and backend run updates", async () => {
    const { baseUrl } = await startTestServer();
    const manual = await postJson<{
      id: string;
      status: string;
      event_type: string;
    }>(`${baseUrl}/api/client-events`, {
      event_type: "client.workspace.open_requested",
      payload: { deep_link: "samurai://workspace" },
      resource_refs: []
    }, 201);
    const delivered = await postJson<{ status: string }>(`${baseUrl}/api/client-events/${manual.id}/deliver`, {});
    const acked = await postJson<{ status: string }>(`${baseUrl}/api/client-events/${manual.id}/ack`, {});

    const session = await postJson<{ id: string }>(`${baseUrl}/api/chat/sessions`, {}, 201);
    const turn = await postJson<{ backendRun: { id: string; status: string } }>(`${baseUrl}/api/chat/sessions/${session.id}/messages`, {
      content: "短くメモを書いて",
      output_locale: "ja"
    }, 201);
    const queued = await getJson<Array<{
      id: string;
      event_type: string;
      status: string;
      payload: Record<string, unknown>;
    }>>(`${baseUrl}/api/client-events?target_client_kind=desktop&status=pending`);

    const automatic = queued.find((event) => event.payload.run_id === turn.backendRun.id);
    expect(manual).toMatchObject({ event_type: "client.workspace.open_requested", status: "pending" });
    expect(delivered.status).toBe("delivered");
    expect(acked.status).toBe("acked");
    expect(turn.backendRun.status).toBe("completed");
    expect(automatic).toMatchObject({
      event_type: "client.notification.requested",
      status: "pending"
    });
    expect(automatic?.payload.deep_link).toBe(`samurai://run/${turn.backendRun.id}`);
  });

  it("exposes ignored provider tool diagnostics", async () => {
    const provider = new FakeProviderAdapter("fake/test", {
      content: "Done.",
      toolCalls: [
        { id: "legacy_tool_1", name: "legacy_unknown_tool", arguments: {} },
        { id: "legacy_tool_2", name: "legacy_unknown_tool", arguments: {} }
      ]
    });
    const { baseUrl } = await startTestServer(provider);
    const session = await postJson<{ id: string }>(`${baseUrl}/api/chat/sessions`, {}, 201);
    const turn = await postJson<{ backendRun: { id: string } }>(`${baseUrl}/api/chat/sessions/${session.id}/messages`, {
      content: "trigger legacy tools",
      output_locale: "en"
    }, 201);

    const toolRuns = await getJson<Array<{ provider_tool_name: string; status: string }>>(`${baseUrl}/api/backend-runs/${turn.backendRun.id}/tool-runs`);
    const runDiagnostics = await getJson<{
      total_tool_runs: number;
      repeated_ignored_provider_tools: Array<{ provider_tool_name: string; status: string; count: number; reasons: Array<{ reason: string; count: number }> }>;
      adapter_recommendations: Array<{
        provider_tool_name: string;
        mapping_status: string;
        suggested_next_step: string;
        reason: string;
      }>;
    }>(`${baseUrl}/api/backend-runs/${turn.backendRun.id}/tool-runs/diagnostics?status=ignored`);
    const sessionDiagnostics = await getJson<{
      ignored_or_failed_tool_runs: number;
      groups: Array<{ provider_tool_name: string; count: number }>;
    }>(`${baseUrl}/api/tool-runs/diagnostics?session_id=${session.id}`);
    const invalidStatus = await getJson<Record<string, unknown>>(`${baseUrl}/api/tool-runs/diagnostics?session_id=${session.id}&status=unknown`, 400);

    expect(toolRuns).toHaveLength(2);
    expect(toolRuns.every((toolRun) => toolRun.status === "ignored")).toBe(true);
    expect(runDiagnostics.total_tool_runs).toBe(2);
    expect(runDiagnostics.repeated_ignored_provider_tools).toEqual([
      expect.objectContaining({
        provider_tool_name: "legacy_unknown_tool",
        status: "ignored",
        count: 2,
        reasons: [{ reason: "unsupported_tool", count: 2 }]
      })
    ]);
    expect(runDiagnostics.adapter_recommendations).toEqual([
      expect.objectContaining({
        provider_tool_name: "legacy_unknown_tool",
        mapping_status: "unmapped_provider_tool",
        suggested_next_step: "add_provider_tool_mapping"
      })
    ]);
    expect(runDiagnostics.adapter_recommendations[0]?.reason).toContain("not mapped to a Domain Command");
    expect(sessionDiagnostics.ignored_or_failed_tool_runs).toBe(2);
    expect(sessionDiagnostics.groups[0]?.provider_tool_name).toBe("legacy_unknown_tool");
    expect(invalidStatus.error).toBe("invalid_tool_run_status");
  });

  it("exposes File / Browser action diagnostics without leaking browser URLs", async () => {
    const { baseUrl } = await startTestServer();
    const session = await postJson<{ id: string }>(`${baseUrl}/api/chat/sessions`, {}, 201);
    const browserUrl = "data:text/html,<title>Secret</title><main>token=secret-browser-url</main>";

    await postJson(`${baseUrl}/api/tools/file`, {
      operation: "file.write",
      path: "notes/file-browser-diagnostics.md",
      content: "hello diagnostics",
      session_id: session.id
    });
    await postJson(`${baseUrl}/api/tools/browser`, {
      operation: "browser.download_to_workspace",
      url: browserUrl,
      output_path: "browser/file-browser-diagnostics.txt",
      session_id: session.id
    });
    await postJson(`${baseUrl}/api/tools/file`, {
      operation: "file.patch",
      path: "notes/missing-file-browser-diagnostics.md",
      search: "missing",
      replace: "patched",
      session_id: session.id
    }, 404);

    const diagnostics = await getJson<{
      total_operations: number;
      total_tool_runs: number;
      file_operations: number;
      browser_operations: number;
      completed_file_operations: number;
      completed_browser_operations: number;
      failed_or_blocked_operations: number;
      ignored_or_failed_tool_runs: number;
      browser_workspace_fallbacks: number;
      operation_status_counts: Record<string, number>;
      issues: Array<{ code: string; severity: string; operation: string; resource_ref?: { kind: string; uri: string } }>;
      recommendation: string;
    }>(`${baseUrl}/api/tools/file-browser/diagnostics?session_id=${session.id}&limit=10`);

    expect(diagnostics).toMatchObject({
      total_operations: 3,
      total_tool_runs: 0,
      file_operations: 2,
      browser_operations: 1,
      completed_file_operations: 1,
      completed_browser_operations: 1,
      failed_or_blocked_operations: 1,
      ignored_or_failed_tool_runs: 0,
      browser_workspace_fallbacks: 1
    });
    expect(diagnostics.operation_status_counts).toMatchObject({
      completed: 2,
      failed: 1
    });
    expect(diagnostics.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "file_browser_action_failed", severity: "critical", operation: "file.patch" }),
      expect.objectContaining({
        code: "browser_workspace_fallback",
        severity: "info",
        operation: "browser.download_to_workspace",
        resource_ref: expect.objectContaining({ kind: "file", uri: "browser/file-browser-diagnostics.txt" })
      })
    ]));
    expect(diagnostics.recommendation).toContain("failed or denied");
    expect(JSON.stringify(diagnostics)).not.toContain(browserUrl);
    expect(JSON.stringify(diagnostics)).not.toContain("secret-browser-url");
  });

  it("exposes session transcript and backend resume state", async () => {
    const { baseUrl } = await startTestServer();
    const session = await postJson<{ id: string }>(`${baseUrl}/api/chat/sessions`, {}, 201);
    const turn = await postJson<{ backendRun: { id: string }; backendEvents: unknown[] }>(`${baseUrl}/api/chat/sessions/${session.id}/messages`, {
      content: "提案書を作って",
      output_locale: "ja"
    }, 201);

    const transcript = await getJson<{
      session: { id: string };
      messages: unknown[];
      backend_runs: Array<{ id: string }>;
      backend_events: unknown[];
      run_history: Array<{ id: string }>;
      change_history: unknown[];
    }>(`${baseUrl}/api/chat/sessions/${session.id}/transcript`);
    const resumeState = await getJson<{
      session: { id: string };
      can_resume: boolean;
      next_required_action: string;
      resume_api: string;
      latest_run?: { id: string; status: string; event_count: number; waiting_for_backend_input: boolean };
      resumable_runs: unknown[];
      transcript_counts: { backend_runs: number; backend_events: number; messages: number };
    }>(`${baseUrl}/api/chat/sessions/${session.id}/resume-state`);

    expect(transcript.session.id).toBe(session.id);
    expect(transcript.backend_runs.map((run) => run.id)).toContain(turn.backendRun.id);
    expect(transcript.backend_events.length).toBe(turn.backendEvents.length);
    expect(transcript.run_history.map((run) => run.id)).toContain(turn.backendRun.id);
    expect(transcript.change_history.length).toBeGreaterThanOrEqual(1);
    expect(resumeState).toMatchObject({
      session: { id: session.id },
      can_resume: false,
      next_required_action: "none",
      resume_api: "/api/backend-runs/:runId/resume"
    });
    expect(resumeState.latest_run).toMatchObject({
      id: turn.backendRun.id,
      status: "completed",
      waiting_for_backend_input: false
    });
    expect(resumeState.latest_run?.event_count).toBe(turn.backendEvents.length);
    expect(resumeState.resumable_runs).toEqual([]);
    expect(resumeState.transcript_counts.backend_runs).toBe(1);
    expect(resumeState.transcript_counts.backend_events).toBe(turn.backendEvents.length);
    expect(resumeState.transcript_counts.messages).toBeGreaterThanOrEqual(2);
  });

  it("routes typed surface message operations through the Host run path", async () => {
    const { baseUrl } = await startTestServer();
    const session = await postJson<{ id: string }>(`${baseUrl}/api/chat/sessions`, {}, 201);

    const result = await postJson<{
      operation: { kind: string };
      result_kind: string;
      render_spec: { kind: string; priority: string; resource_refs: Array<{ kind: string; id: string }> };
      result: { backendRun: { status: string; metadata: Record<string, unknown> }; messages: Array<{ role: string; content: string }> };
    }>(
      `${baseUrl}/api/surface/operations`,
      {
        id: "surface_test",
        kind: "message.submit",
        session_id: session.id,
        content: "Surface Protocol から提案書を作って",
        output_locale: "ja"
      },
      201
    );

    expect(result.operation.kind).toBe("message.submit");
    expect(result.result_kind).toBe("chat_turn");
    expect(result.render_spec).toMatchObject({ kind: "chat", priority: "primary" });
    expect(result.render_spec.resource_refs.some((ref) => ref.kind === "backend_run")).toBe(true);
    expect(result.result.backendRun.status).toBe("completed");
    expect(result.result.backendRun.metadata).toMatchObject({
      surface_operation_id: "surface_test",
      surface_operation_kind: "message.submit"
    });
    expect(result.result.messages.some((message) => message.role === "agent")).toBe(true);
  });

  it("replays a surface retry by operation id and admits a new id separately", async () => {
    const { baseUrl } = await startTestServer();
    const session = await postJson<{ id: string }>(`${baseUrl}/api/chat/sessions`, {}, 201);
    const operation = {
      id: "surface_retry_fixture_1",
      kind: "message.submit",
      session_id: session.id,
      content: "通信再試行の確認",
      output_locale: "ja"
    };

    const first = await postJson<{ result: { backendRun: { id: string } } }>(`${baseUrl}/api/surface/operations`, operation, 201);
    const replay = await postJson<{ result: { backendRun: { id: string } } }>(`${baseUrl}/api/surface/operations`, operation, 201);
    const next = await postJson<{ result: { backendRun: { id: string } } }>(`${baseUrl}/api/surface/operations`, {
      ...operation,
      id: "surface_retry_fixture_2",
      content: "別操作の確認"
    }, 201);

    expect(replay.result.backendRun.id).toBe(first.result.backendRun.id);
    expect(next.result.backendRun.id).not.toBe(first.result.backendRun.id);
  });

  it("runs the movie-log Collection flow through the HTTP Surface API", async () => {
    let apiServer: ApiServer | undefined;
    let backendRuns = 0;
    const actionBackendInputs: ActionBackendInputSnapshot[] = [];
    const movieProviderInputs: ProviderInput[] = [];
    const movieProvider = new FakeProviderAdapter("fake/movie-flow", (input) => {
      movieProviderInputs.push(input);
      if (input.envelope.metadata.app_edit_patch === true && input.envelope.metadata.collection_id === "movies") {
        return {
          content: JSON.stringify([
            { op: "add_field", field: { id: "director", type: "string", label: "監督" } },
            { op: "update_view", emphasized_fields: ["title", "director", "rating", "status"] }
          ]),
          toolCalls: []
        };
      }
      if (input.envelope.metadata.collection_action_id === "summarize_note") {
        return {
          content: "感想を整理しました。",
          toolCalls: []
        };
      }
      if (input.envelope.metadata.collection_action_id === "generate_board") {
        return {
          content: JSON.stringify({
            custom_view: {
              title: "映画ログボード",
              html: "<main><h1>映画ログボード</h1><button onclick=\"dispatchSamuraiAction('highlight_movie',{record_id:'movie_1'})\">Highlight</button></main>",
              actions: [{ id: "highlight_movie", label: "Highlight movie", action_kind: "highlight", scope: "record" }]
            }
          }),
          toolCalls: []
        };
      }
      return fakeProviderOutput(input);
    });
    const backendRegistry = createDefaultAgentBackendRegistry(movieProvider, process.env, { repoRoot: process.cwd() });
    backendRegistry.register({
      id: "collection-movie-api-bridge",
      kind: "codex",
      label: "Collection Movie API Bridge Fixture",
      sessionPolicy: { acquisition: "none", resume: "unsupported" },
      execution_owner: "host",
      async *runTurn(input) {
        backendRuns += 1;
        if (input.envelope.user_intent.includes("作って")) {
          expect(input.expected_outputs).toContain("collection_schema");
          if (!apiServer) {
            throw new Error("api_server_not_ready");
          }
          await apiServer.runtime.runBackendToolBridgeCall({
            runId: input.run_id,
            token: input.tool_bridge?.token ?? "",
            toolName: "mcp__samurai__collection_schema_save",
            toolCallId: "schema_tool_movie_api",
            toolInput: movieLogCollectionSchema()
          });
        }
        const textPayload: Record<string, JsonValue> = { text: "映画ログを作成しました。" };
        const completedPayload: Record<string, JsonValue> = { output_summary: "done" };
        yield {
          event_type: "text_delta",
          payload: textPayload
        };
        yield {
          event_type: "run_completed",
          payload: completedPayload,
          terminal_evidence: { kind: "completed", source: "owned_loop_return" }
        };
      }
    });
    backendRegistry.register({
      id: "collection-movie-action-codex",
      kind: "codex",
      label: "Collection Movie Action Codex Fixture",
      sessionPolicy: { acquisition: "none", resume: "unsupported" },
      execution_owner: "host",
      async *runTurn(input) {
        actionBackendInputs.push(input);
        const actionId = typeof input.envelope.metadata.collection_action_id === "string"
          ? input.envelope.metadata.collection_action_id
          : "";
        const text = actionId === "generate_board"
          ? JSON.stringify({
            custom_view: {
              title: "映画ログボード",
              html: "<main><h1>映画ログボード</h1><button onclick=\"dispatchSamuraiAction('highlight_movie',{record_id:'movie_1'})\">Highlight</button></main>",
              actions: [{ id: "highlight_movie", label: "Highlight movie", action_kind: "highlight", scope: "record" }]
            }
          })
          : "感想を整理しました。";
        const textPayload: Record<string, JsonValue> = { text };
        const completedPayload: Record<string, JsonValue> = { output_summary: "done" };
        yield {
          event_type: "text_delta",
          payload: textPayload
        };
        yield {
          event_type: "run_completed",
          payload: completedPayload,
          terminal_evidence: { kind: "completed", source: "owned_loop_return" }
        };
      }
    });
    const started = await startTestServer(movieProvider, { backendRegistry });
    apiServer = started.server;
    const { baseUrl } = started;
    const session = await postJson<{ id: string }>(`${baseUrl}/api/chat/sessions`, {}, 201);
    const capabilities = {
      protocol_version: "1",
      supported_kinds: ["chat", "custom_view", "collection", "collection_record"],
      custom_view_renderers: [
        { renderer: "generic", versions: ["1"] },
        { renderer: "collection_table", versions: ["1"] },
        { renderer: "collection_gallery", versions: ["1"] },
        { renderer: "calendar_view", versions: ["1"] },
        { renderer: "collection_kanban", versions: ["1"] }
      ]
    };

    const created = await postJson<SurfaceOperationApiResult>(
      `${baseUrl}/api/surface/operations`,
      {
        id: "surface_movie_api_create",
        kind: "message.submit",
        session_id: session.id,
        backend_id: "collection-movie-api-bridge",
        content: "映画ログアプリ作って",
        output_locale: "ja",
        renderer_capabilities: capabilities
      },
      201
    );
    const createdCard = created.result.messagePresentations[0]!;
    const record = await postJson<SurfaceOperationApiResult>(
      `${baseUrl}/api/surface/operations`,
      {
        id: "surface_movie_api_record_create",
        kind: "collection.record.create",
        collection_id: "movies",
        record_id: "movie_1",
        data: { title: "七人の侍", status: "観た", rating: 5, watched_at: "2026-07-03", notes: "再視聴" },
        renderer_capabilities: capabilities
      },
      201
    );
    const opened = await postJson<SurfaceOperationApiResult>(
      `${baseUrl}/api/surface/operations`,
      {
        id: "surface_movie_api_open",
        kind: "message.submit",
        session_id: session.id,
        backend_id: "collection-movie-api-bridge",
        content: "映画ログを開いて",
        output_locale: "ja",
        renderer_capabilities: capabilities
      },
      201
    );
    const sorted = await postJson<SurfaceOperationApiResult>(
      `${baseUrl}/api/surface/operations`,
      {
        id: "surface_movie_api_sort",
        kind: "message.submit",
        session_id: session.id,
        backend_id: "collection-movie-api-bridge",
        content: "評価順にして",
        output_locale: "ja",
        renderer_capabilities: capabilities
      },
      201
    );
    const gallery = await postJson<SurfaceOperationApiResult>(
      `${baseUrl}/api/surface/operations`,
      {
        id: "surface_movie_api_gallery",
        kind: "message.submit",
        session_id: session.id,
        backend_id: "collection-movie-api-bridge",
        content: "ギャラリーで見たい",
        output_locale: "ja",
        renderer_capabilities: capabilities
      },
      201
    );
    const calendar = await postJson<SurfaceOperationApiResult>(
      `${baseUrl}/api/surface/operations`,
      {
        id: "surface_movie_api_calendar",
        kind: "message.submit",
        session_id: session.id,
        backend_id: "collection-movie-api-bridge",
        content: "カレンダーで見たい",
        output_locale: "ja",
        renderer_capabilities: capabilities
      },
      201
    );
    const kanban = await postJson<SurfaceOperationApiResult>(
      `${baseUrl}/api/surface/operations`,
      {
        id: "surface_movie_api_kanban",
        kind: "message.submit",
        session_id: session.id,
        backend_id: "collection-movie-api-bridge",
        content: "カンバンで見たい",
        output_locale: "ja",
        renderer_capabilities: capabilities
      },
      201
    );
    const patched = await postJson<SurfaceOperationApiResult>(
      `${baseUrl}/api/surface/operations`,
      {
        id: "surface_movie_api_record_patch",
        kind: "collection.record.patch",
        collection_id: "movies",
        record_id: "movie_1",
        patch_id: "movie_api_patch_1",
        expected_version: 1,
        changes: { status: "視聴中" },
        renderer_capabilities: capabilities
      },
      201
    );
    const refreshedGallery = await postJson<SurfaceOperationApiResult>(
      `${baseUrl}/api/surface/operations`,
      {
        id: "surface_movie_api_gallery_refresh",
        kind: "collection.view.present",
        collection_id: "movies",
        view_id: "movies_gallery",
        renderer_capabilities: capabilities
      },
      201
    );
    const refreshedKanban = await postJson<SurfaceOperationApiResult>(
      `${baseUrl}/api/surface/operations`,
      {
        id: "surface_movie_api_kanban_refresh",
        kind: "collection.view.present",
        collection_id: "movies",
        view_id: "movies_kanban",
        renderer_capabilities: capabilities
      },
      201
    );
    const reopenedAfterEdit = await postJson<SurfaceOperationApiResult>(
      `${baseUrl}/api/surface/operations`,
      {
        id: "surface_movie_api_reopen_after_edit",
        kind: "message.submit",
        session_id: session.id,
        backend_id: "collection-movie-api-bridge",
        content: "映画ログを開いて",
        output_locale: "ja",
        renderer_capabilities: capabilities
      },
      201
    );
    const calendarViewState = {
      collection_id: "movies",
      view_id: "movies_calendar",
      renderer: "calendar_view",
      record_count: 1
    };
    const switchedCard = await postJson<SurfaceOperationApiResult>(
      `${baseUrl}/api/surface/operations`,
      {
        id: "surface_movie_api_card_state",
        kind: "message.presentation.update",
        session_id: session.id,
        presentation_id: createdCard.id,
        view_state: calendarViewState,
        renderer_capabilities: capabilities
      },
      201
    );
    const reopenedCard = await postJson<SurfaceOperationApiResult>(
      `${baseUrl}/api/surface/operations`,
      {
        id: "surface_movie_api_reopen_card",
        kind: "collection.view.present",
        collection_id: switchedCard.result.collection_id,
        view_id: switchedCard.result.view_id,
        renderer_capabilities: capabilities
      },
      201
    );
    const workspaceCreated = await postJson<SurfaceOperationApiResult>(
      `${baseUrl}/api/surface/operations`,
      {
        id: "surface_movie_api_workspace_create",
        kind: "collection.record.create",
        collection_id: "movies",
        record_id: "movie_2",
        data: { title: "羅生門", status: "観たい", rating: 4, watched_at: "2026-07-05", notes: "次に観る" },
        renderer_capabilities: capabilities
      },
      201
    );
    const refreshedCardCalendar = await postJson<SurfaceOperationApiResult>(
      `${baseUrl}/api/surface/operations`,
      {
        id: "surface_movie_api_card_calendar_refresh_after_create",
        kind: "collection.view.present",
        collection_id: switchedCard.result.collection_id,
        view_id: switchedCard.result.view_id,
        renderer_capabilities: capabilities
      },
      201
    );
    const refreshedCardData = refreshedCardCalendar.render_spec.props.data;
    const refreshedCardViewState = refreshedCardData && typeof refreshedCardData === "object" && !Array.isArray(refreshedCardData)
      ? (refreshedCardData as Record<string, unknown>).view_state
      : undefined;
    if (!refreshedCardViewState || typeof refreshedCardViewState !== "object" || Array.isArray(refreshedCardViewState)) {
      throw new Error("refreshed_card_view_state_required");
    }
    const syncedCardAfterCreate = await postJson<SurfaceOperationApiResult>(
      `${baseUrl}/api/surface/operations`,
      {
        id: "surface_movie_api_card_state_after_workspace_create",
        kind: "message.presentation.update",
        session_id: session.id,
        presentation_id: createdCard.id,
        view_state: refreshedCardViewState,
        renderer_capabilities: capabilities
      },
      201
    );
    const transcriptAfterCreate = await getJson<{ message_presentations: SurfaceMessagePresentation[] }>(`${baseUrl}/api/chat/sessions/${session.id}/transcript`);
    const savedCreatedCardAfterCreate = transcriptAfterCreate.message_presentations.find((presentation) => presentation.id === createdCard.id);
    const reopenedCardAfterWorkspaceCreate = await postJson<SurfaceOperationApiResult>(
      `${baseUrl}/api/surface/operations`,
      {
        id: "surface_movie_api_reopen_card_after_workspace_create",
        kind: "collection.view.present",
        collection_id: syncedCardAfterCreate.result.collection_id,
        view_id: syncedCardAfterCreate.result.view_id,
        renderer_capabilities: capabilities
      },
      201
    );
    const workspaceDeleted = await postJson<SurfaceOperationApiResult>(
      `${baseUrl}/api/surface/operations`,
      {
        id: "surface_movie_api_workspace_delete",
        kind: "collection.record.delete",
        collection_id: "movies",
        record_id: "movie_2",
        expected_version: 1,
        view_id: "movies_calendar",
        renderer_capabilities: capabilities
      },
      201
    );
    const refreshedCardCalendarAfterDelete = await postJson<SurfaceOperationApiResult>(
      `${baseUrl}/api/surface/operations`,
      {
        id: "surface_movie_api_card_calendar_refresh_after_delete",
        kind: "collection.view.present",
        collection_id: syncedCardAfterCreate.result.collection_id,
        view_id: syncedCardAfterCreate.result.view_id,
        renderer_capabilities: capabilities
      },
      201
    );
    const deletedCardData = refreshedCardCalendarAfterDelete.render_spec.props.data;
    const deletedCardViewState = deletedCardData && typeof deletedCardData === "object" && !Array.isArray(deletedCardData)
      ? (deletedCardData as Record<string, unknown>).view_state
      : undefined;
    if (!deletedCardViewState || typeof deletedCardViewState !== "object" || Array.isArray(deletedCardViewState)) {
      throw new Error("deleted_card_view_state_required");
    }
    const syncedCardAfterDelete = await postJson<SurfaceOperationApiResult>(
      `${baseUrl}/api/surface/operations`,
      {
        id: "surface_movie_api_card_state_after_workspace_delete",
        kind: "message.presentation.update",
        session_id: session.id,
        presentation_id: createdCard.id,
        view_state: deletedCardViewState,
        renderer_capabilities: capabilities
      },
      201
    );
    const reopenedCardAfterWorkspaceDelete = await postJson<SurfaceOperationApiResult>(
      `${baseUrl}/api/surface/operations`,
      {
        id: "surface_movie_api_reopen_card_after_workspace_delete",
        kind: "collection.view.present",
        collection_id: syncedCardAfterDelete.result.collection_id,
        view_id: syncedCardAfterDelete.result.view_id,
        renderer_capabilities: capabilities
      },
      201
    );
    const schemaPatched = await postJson<SurfaceOperationApiResult>(
      `${baseUrl}/api/surface/operations`,
      {
        id: "surface_movie_api_schema_patch_director",
        kind: "message.submit",
        session_id: session.id,
        backend_id: "collection-movie-api-bridge",
        content: "監督フィールドを追加して",
        output_locale: "ja",
        metadata: {
          active_app_context: {
            renderer: "collection_table",
            collection_id: "movies",
            view_id: "movies_table"
          }
        },
        renderer_capabilities: capabilities
      },
      201
    );
    const action = await postJson<SurfaceOperationApiResult>(
      `${baseUrl}/api/surface/operations`,
      {
        id: "surface_movie_api_action_summarize_note",
        kind: "collection.action.run",
        session_id: session.id,
        collection_id: "movies",
        action_id: "summarize_note",
        backend_id: "collection-movie-action-codex",
        record_id: "movie_1",
        view_id: "movies_table",
        payload: {
          action_id: "summarize_note",
          action_label: "感想を整理",
          action_kind: "custom_instruction",
          scope: "record",
          view_state: { selected_record_id: "movie_1" },
          record_snapshot: { id: "movie_1", title: "七人の侍", notes: "再視聴" }
        },
        renderer_capabilities: capabilities
      },
      201
    );
    const customViewAction = await postJson<SurfaceOperationApiResult>(
      `${baseUrl}/api/surface/operations`,
      {
        id: "surface_movie_api_action_generate_board",
        kind: "collection.action.run",
        session_id: session.id,
        collection_id: "movies",
        action_id: "generate_board",
        backend_id: "collection-movie-action-codex",
        view_id: "movies_table",
        payload: {
          action_id: "generate_board",
          action_label: "専用ビューを作る",
          action_kind: "custom_instruction",
          output_surface: "custom_view"
        },
        renderer_capabilities: capabilities
      },
      201
    );
    const transcript = await getJson<{ message_presentations: SurfaceMessagePresentation[] }>(`${baseUrl}/api/chat/sessions/${session.id}/transcript`);
    const savedCreatedCard = transcript.message_presentations.find((presentation) => presentation.id === createdCard.id);

    expect(backendRuns).toBe(8);
    expect(movieProviderInputs.some((input) => input.envelope.metadata.app_edit_patch === true)).toBe(false);
    const actionProviderInput = actionBackendInputs.find((input) => input.envelope.metadata.collection_action_id === "summarize_note");
    expect(actionProviderInput).toBeDefined();
    expect(actionProviderInput?.envelope.metadata).toMatchObject({
      collection_id: "movies",
      collection_action_id: "summarize_note",
      collection_action_kind: "custom_instruction",
      collection_record_id: "movie_1"
    });
    expect(actionProviderInput?.envelope.user_intent).toContain("感想を整理");
    expect(actionProviderInput?.envelope.user_intent).toContain("selected_record_id");
    expect(actionProviderInput?.envelope.user_intent).toContain("record_snapshot");
    expect(actionProviderInput?.envelope.user_intent).toContain("movie_1");
    expect(created.render_specs.map((spec) => spec.kind)).toEqual(["chat", "custom_view"]);
    expect(createdCard).toMatchObject({
      collection_id: "movies",
      view_id: "movies_table",
      renderer: "collection_table",
      view_state: expect.objectContaining({ record_count: 0 })
    });
    expect(record.render_spec).toMatchObject({
      kind: "collection_record",
      props: {
        record_id: "movie_1",
        data: expect.objectContaining({ title: "七人の侍", rating: 5 })
      }
    });
    for (const naturalResult of [opened, sorted, gallery, calendar, kanban]) {
      expect(naturalResult.render_specs.map((spec) => spec.kind)).toEqual(["chat"]);
      expect(naturalResult.result.messagePresentations).toEqual([]);
    }
    expect(patched.render_spec).toMatchObject({
      kind: "collection_record",
      props: {
        record_id: "movie_1",
        data: expect.objectContaining({ status: "視聴中" })
      }
    });
    expect(refreshedKanban.render_spec).toMatchObject({
      kind: "custom_view",
      props: {
        renderer: "collection_kanban",
        view_id: "movies_kanban",
        data: expect.objectContaining({
          records: [expect.objectContaining({ id: "movie_1", status: "視聴中" })],
          view_state: expect.objectContaining({
            renderer: "collection_kanban",
            group: "status"
          })
        })
      }
    });
    expect(refreshedGallery.render_spec).toMatchObject({
      kind: "custom_view",
      props: {
        renderer: "collection_gallery",
        view_id: "movies_gallery",
        data: expect.objectContaining({
          records: [expect.objectContaining({ id: "movie_1", status: "視聴中" })],
          view_state: expect.objectContaining({
            renderer: "collection_gallery"
          })
        })
      }
    });
    expect(reopenedAfterEdit.render_specs.map((spec) => spec.kind)).toEqual(["chat"]);
    expect(reopenedAfterEdit.result.messagePresentations).toEqual([]);
    expect(switchedCard.result).toMatchObject({
      id: createdCard.id,
      view_id: "movies_calendar",
      renderer: "calendar_view",
      view_state: expect.objectContaining({ record_count: 1 })
    });
    expect(reopenedCard.render_spec).toMatchObject({
      kind: "custom_view",
      props: {
        renderer: "calendar_view",
        view_id: "movies_calendar",
        data: expect.objectContaining({
          records: [expect.objectContaining({ id: "movie_1", title: "七人の侍" })]
        })
      }
    });
    expect(workspaceCreated.render_spec).toMatchObject({
      kind: "collection_record",
      props: {
        record_id: "movie_2",
        data: expect.objectContaining({ title: "羅生門", status: "観たい" })
      }
    });
    expect(refreshedCardCalendar.render_spec).toMatchObject({
      kind: "custom_view",
      props: {
        renderer: "calendar_view",
        view_id: "movies_calendar",
        data: expect.objectContaining({
          records: expect.arrayContaining([
            expect.objectContaining({ id: "movie_1", title: "七人の侍" }),
            expect.objectContaining({ id: "movie_2", title: "羅生門" })
          ]),
          view_state: expect.objectContaining({ record_count: 2 })
        })
      }
    });
    expect(syncedCardAfterCreate.result).toMatchObject({
      id: createdCard.id,
      view_id: "movies_calendar",
      renderer: "calendar_view",
      view_state: expect.objectContaining({ record_count: 2 })
    });
    expect(savedCreatedCardAfterCreate).toMatchObject({
      view_id: "movies_calendar",
      renderer: "calendar_view",
      view_state: expect.objectContaining({ record_count: 2 })
    });
    expect(reopenedCardAfterWorkspaceCreate.render_spec).toMatchObject({
      kind: "custom_view",
      props: {
        renderer: "calendar_view",
        view_id: "movies_calendar",
        data: expect.objectContaining({
          records: expect.arrayContaining([
            expect.objectContaining({ id: "movie_1", title: "七人の侍" }),
            expect.objectContaining({ id: "movie_2", title: "羅生門" })
          ]),
          view_state: expect.objectContaining({ record_count: 2 })
        })
      }
    });
    expect(workspaceDeleted.result_kind).toBe("collection_delete");
    expect(workspaceDeleted.render_spec).toMatchObject({
      kind: "custom_view",
      props: {
        renderer: "calendar_view",
        view_id: "movies_calendar",
        data: expect.objectContaining({
          record_ids: ["movie_1"],
          view_state: expect.objectContaining({ record_count: 1 })
        })
      }
    });
    expect(refreshedCardCalendarAfterDelete.render_spec).toMatchObject({
      kind: "custom_view",
      props: {
        renderer: "calendar_view",
        view_id: "movies_calendar",
        data: expect.objectContaining({
          record_ids: ["movie_1"],
          view_state: expect.objectContaining({ record_count: 1 })
        })
      }
    });
    expect(syncedCardAfterDelete.result).toMatchObject({
      id: createdCard.id,
      view_id: "movies_calendar",
      renderer: "calendar_view",
      view_state: expect.objectContaining({ record_count: 1 })
    });
    expect(savedCreatedCard).toMatchObject({
      view_id: "movies_calendar",
      renderer: "calendar_view",
      view_state: expect.objectContaining({ record_count: 1 })
    });
    expect(reopenedCardAfterWorkspaceDelete.render_spec).toMatchObject({
      kind: "custom_view",
      props: {
        renderer: "calendar_view",
        view_id: "movies_calendar",
        data: expect.objectContaining({
          record_ids: ["movie_1"],
          view_state: expect.objectContaining({ record_count: 1 })
        })
      }
    });
    expect(schemaPatched.render_specs.map((spec) => spec.kind)).toEqual(["chat"]);
    expect(schemaPatched.result.messagePresentations).toEqual([]);
    expect(action.render_specs.map((spec) => spec.kind)).toEqual(["custom_view"]);
    expect(action.result).toMatchObject({
      resource: {
        collection_id: "movies",
        action_id: "summarize_note",
        status: "completed",
        output: {
          backend_status: "completed",
          output_text: "感想を整理しました。"
        }
      }
    });
    const generatedCustomView = customViewAction.render_specs.find((spec) =>
      spec.kind === "custom_view" && spec.props.renderer === "generic"
    );
    expect(generatedCustomView).toMatchObject({
      kind: "custom_view",
      title: "映画ログボード",
      props: {
        renderer: "generic",
        data: expect.objectContaining({
          html: expect.stringContaining("映画ログボード"),
          collection_id: "movies",
          source_action_id: "generate_board",
          source_collection: expect.objectContaining({
            records: [expect.objectContaining({ id: "movie_1", title: "七人の侍" })]
          })
        }),
        capability: expect.objectContaining({
          allowed_actions: ["highlight_movie"]
        })
      }
    });
    expect(customViewAction.render_specs.map((spec) => spec.kind)).toEqual(["custom_view", "custom_view"]);
  });

  it("asks for a user choice when a Collection open request is ambiguous through the HTTP Surface API", async () => {
    let backendRuns = 0;
    const backendRegistry = createDefaultAgentBackendRegistry(new FakeProviderAdapter("fake/movie-ambiguous-api", fakeProviderOutput), process.env, { repoRoot: process.cwd() });
    backendRegistry.register({
      id: "collection-open-api-ambiguous-unneeded",
      kind: "codex",
      label: "Unused Ambiguous Collection Open Fixture",
      sessionPolicy: { acquisition: "none", resume: "unsupported" },
      execution_owner: "host",
      async *runTurn() {
        backendRuns += 1;
        yield {
          event_type: "run_completed",
          payload: { output_summary: "unexpected" },
          terminal_evidence: { kind: "completed", source: "owned_loop_return" }
        };
      }
    });
    const { baseUrl, server } = await startTestServer(undefined, { backendRegistry });
    await server.store.updateCollectionSchema({
      id: "movies",
      version: "1",
      labels: { ja: "映画ログ", en: "Movies" },
      descriptions: { ja: "映画を記録する個人用アプリ。", en: "A personal movie log." },
      fields: [{ id: "title", type: "string", label: "タイトル", required: true }],
      refs: [],
      embeds: [],
      derived_fields: [],
      triggers: [],
      actions: [],
      views: [{ id: "movies_table", renderer: "collection_table", editable_fields: ["title"] }],
      permissions: { create: true, update: true, delete: true }
    });
    await server.store.updateCollectionSchema({
      id: "movie_notes",
      version: "1",
      labels: { ja: "映画アプリ", en: "Movie app" },
      descriptions: { ja: "映画ログに紐づくメモ。", en: "Notes for movie logs." },
      fields: [{ id: "memo", type: "text", label: "メモ" }],
      refs: [],
      embeds: [],
      derived_fields: [],
      triggers: [],
      actions: [],
      views: [{ id: "movie_notes_table", renderer: "collection_table", editable_fields: ["memo"] }],
      permissions: { create: true, update: true, delete: true }
    });
    const session = await postJson<{ id: string }>(`${baseUrl}/api/chat/sessions`, {}, 201);

    const opened = await postJson<SurfaceOperationApiResult>(
      `${baseUrl}/api/surface/operations`,
      {
        id: "surface_movie_api_ambiguous_open",
        kind: "message.submit",
        session_id: session.id,
        backend_id: "collection-open-api-ambiguous-unneeded",
        content: "映画アプリを開いて",
        output_locale: "ja",
        renderer_capabilities: {
          protocol_version: "1",
          supported_kinds: ["chat", "custom_view", "collection"],
          custom_view_renderers: [{ renderer: "collection_table", versions: ["1"] }]
        }
      },
      201
    );
    const transcript = await getJson<{ message_presentations: SurfaceMessagePresentation[] }>(`${baseUrl}/api/chat/sessions/${session.id}/transcript`);
    const runs = await server.store.listBackendRuns(session.id);
    const messages = Array.isArray(opened.result.messages) ? opened.result.messages as Array<{ role?: string; content?: string }> : [];
    const agentMessage = messages.find((message) => message.role === "agent");

    expect(backendRuns).toBe(1);
    expect(opened.render_specs.map((spec) => spec.kind)).toEqual(["chat"]);
    expect(opened.result.messagePresentations).toEqual([]);
    expect(transcript.message_presentations).toEqual([]);
    expect(agentMessage?.content).not.toContain("候補が複数あります");
    expect(runs[0]).toMatchObject({
      backend_id: "collection-open-api-ambiguous-unneeded",
      status: "completed"
    });
  });

  it("opens existing Collections through HTTP from multilingual labels, descriptions, and field labels", async () => {
    let backendRuns = 0;
    const backendRegistry = createDefaultAgentBackendRegistry(new FakeProviderAdapter("fake/multilingual-collection-open", fakeProviderOutput), process.env, { repoRoot: process.cwd() });
    backendRegistry.register({
      id: "collection-open-multilingual-unneeded",
      kind: "codex",
      label: "Unused Multilingual Collection Open Fixture",
      sessionPolicy: { acquisition: "none", resume: "unsupported" },
      execution_owner: "host",
      async *runTurn() {
        backendRuns += 1;
        yield {
          event_type: "run_completed",
          payload: { output_summary: "unexpected" },
          terminal_evidence: { kind: "completed", source: "owned_loop_return" }
        };
      }
    });
    const { baseUrl, server } = await startTestServer(undefined, { backendRegistry });
    await server.store.updateCollectionSchema({
      id: "watchlog",
      version: "1",
      labels: { ja: "鑑賞記録", en: "Movie tracker", es: "Películas" },
      descriptions: {
        ja: "映画を記録する個人用Collection。",
        en: "A personal place to track watched movies.",
        es: "Películas vistas y pendientes."
      },
      fields: [
        { id: "title", type: "string", label: "Title", required: true },
        { id: "rating", type: "number", label: "Rating" }
      ],
      refs: [],
      embeds: [],
      derived_fields: [],
      triggers: [],
      actions: [],
      views: [{ id: "watchlog_table", renderer: "collection_table", editable_fields: ["title", "rating"] }],
      permissions: { create: true, update: true, delete: true }
    });
    await server.store.updateCollectionSchema({
      id: "recipes",
      version: "1",
      labels: { ja: "レシピ", en: "Recipes", es: "Recetas" },
      descriptions: { ja: "料理メモ。", en: "Cooking notes.", es: "Notas de cocina." },
      fields: [{ id: "name", type: "string", label: "Name", required: true }],
      refs: [],
      embeds: [],
      derived_fields: [],
      triggers: [],
      actions: [],
      views: [{ id: "recipes_table", renderer: "collection_table", editable_fields: ["name"] }],
      permissions: { create: true, update: true, delete: true }
    });
    const session = await postJson<{ id: string }>(`${baseUrl}/api/chat/sessions`, {}, 201);
    const capabilities = {
      protocol_version: "1",
      supported_kinds: ["chat", "custom_view", "collection"],
      custom_view_renderers: [{ renderer: "collection_table", versions: ["1"] }]
    };

    const openedEnglish = await postJson<SurfaceOperationApiResult>(
      `${baseUrl}/api/surface/operations`,
      {
        id: "surface_watchlog_open_english_http",
        kind: "message.submit",
        session_id: session.id,
        backend_id: "collection-open-multilingual-unneeded",
        content: "show my movie list",
        output_locale: "en",
        renderer_capabilities: capabilities
      },
      201
    );
    const openedSpanish = await postJson<SurfaceOperationApiResult>(
      `${baseUrl}/api/surface/operations`,
      {
        id: "surface_watchlog_open_spanish_http",
        kind: "message.submit",
        session_id: session.id,
        backend_id: "collection-open-multilingual-unneeded",
        content: "abre la lista de películas",
        output_locale: "es",
        renderer_capabilities: capabilities
      },
      201
    );
    const openedByFieldLabel = await postJson<SurfaceOperationApiResult>(
      `${baseUrl}/api/surface/operations`,
      {
        id: "surface_watchlog_open_rating_field_http",
        kind: "message.submit",
        session_id: session.id,
        backend_id: "collection-open-multilingual-unneeded",
        content: "open rating tracker",
        output_locale: "en",
        renderer_capabilities: capabilities
      },
      201
    );
    const transcript = await getJson<{ message_presentations: SurfaceMessagePresentation[] }>(`${baseUrl}/api/chat/sessions/${session.id}/transcript`);

    expect(backendRuns).toBe(3);
    for (const opened of [openedEnglish, openedSpanish, openedByFieldLabel]) {
      expect(opened.render_specs.map((spec) => spec.kind)).toEqual(["chat"]);
      expect(opened.result.messagePresentations).toEqual([]);
    }
    expect(transcript.message_presentations.filter((presentation) => presentation.collection_id === "watchlog")).toHaveLength(0);
  });

  it("keeps external assist as isolated API context hints", async () => {
    let providerInput: ProviderInput | undefined;
    const provider = new FakeProviderAdapter("fake/test", (input) => {
      providerInput = input;
      return { content: "external assist ok", toolCalls: [] };
    });
    const externalAssistProvider: ExternalAssistProvider = {
      id: "test-external-assist",
      async prefetch(input) {
        return [{
          id: "hint_api_external",
          title: "API external hint",
          summary: `Unverified external hint for ${input.query}.`,
          source_uri: "external://api/hint",
          confidence: 0.82
        }];
      },
      async syncTurn(input) {
        return [{
          id: "hint_api_sync",
          title: "API sync hint",
          summary: `Synced external hint after ${input.assistantContent}.`,
          source_uri: "external://api/sync",
          confidence: 0.7
        }];
      }
    };
    const secondaryExternalAssistProvider: ExternalAssistProvider = {
      id: "secondary-external-assist",
      async prefetch(input) {
        return [{
          id: "hint_secondary_external",
          title: "Secondary external hint",
          summary: `Second unverified external hint for ${input.query}.`,
          source_uri: "external://secondary/hint",
          confidence: 0.6
        }];
      },
      async syncTurn() {
        throw new Error("secondary provider unavailable with raw-secret-token");
      }
    };
    const { baseUrl } = await startTestServer(provider, { externalAssistProvider: [externalAssistProvider, secondaryExternalAssistProvider] });
    const session = await postJson<{ id: string }>(`${baseUrl}/api/chat/sessions`, {}, 201);

    const turn = await postJson<{
      backendRun: { metadata: Record<string, unknown> };
    }>(
      `${baseUrl}/api/chat/sessions/${session.id}/messages`,
      {
        content: "external source assist を補助として使って",
        output_locale: "ja"
      },
      201
    );
    const context = await getJson<{
      external_assist: {
        role: string;
        isolated_from_memory: boolean;
        included_in_active_memory: boolean;
        hints: Array<{ id: string; summary: string; source_uri?: string }>;
      };
      context_assembly: {
        sources: Array<{ kind: string; status: string; included_count: number }>;
        quality_checks: Array<{ id: string; status: string }>;
      };
      active_memory: unknown[];
      knowledge_wiki: unknown[];
    }>(`${baseUrl}/api/context/preview?session_id=${session.id}&q=external%20source%20assist`);
    const records = await getJson<Array<{
      phase: string;
      status: string;
      provider_id: string;
      hints: Array<{ id: string; source_uri?: string }>;
      isolated_from_memory: boolean;
      included_in_active_memory: boolean;
    }>>(`${baseUrl}/api/external-assist?session_id=${session.id}`);
    const diagnostics = await getJson<{
      total_records: number;
      failed_records: number;
      hint_count: number;
      unisolated_records: number;
      included_in_active_memory_records: number;
      groups: Array<{ provider_id: string; phase: string; status: string; count: number; hint_count: number }>;
      violations: Array<{ code: string; record_id: string }>;
      recent_failures: Array<{ id: string }>;
    }>(`${baseUrl}/api/external-assist/diagnostics?session_id=${session.id}&provider_id=test-external-assist`);
    const allDiagnostics = await getJson<{
      total_records: number;
      failed_records: number;
      groups: Array<{ provider_id: string; phase: string; status: string; count: number; hint_count: number }>;
      recent_failures: Array<{ provider_id: string; error?: string }>;
    }>(`${baseUrl}/api/external-assist/diagnostics?session_id=${session.id}`);

    expect(providerInput?.externalAssist).toMatchObject({
      role: "assistive",
      isolated_from_memory: true,
      included_in_active_memory: false,
    });
    expect(providerInput?.externalAssist?.hints).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "hint_api_external",
        source_uri: "external://api/hint"
      }),
      expect.objectContaining({
        id: "hint_secondary_external",
        source_uri: "external://secondary/hint"
      })
    ]));
    expect(turn.backendRun.metadata.external_assist_sync_status).toBe("completed");
    expect(turn.backendRun.metadata.external_assist_sync_provider_id).toBeUndefined();
    expect(turn.backendRun.metadata.external_assist_sync_provider_ids).toEqual([
      "test-external-assist",
      "secondary-external-assist"
    ]);
    expect(turn.backendRun.metadata.external_assist_sync_statuses).toEqual(["completed", "failed"]);
    expect(turn.backendRun.metadata.context_assembly_sources).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "external_assist",
        status: "included"
      })
    ]));
    expect(context.external_assist).toMatchObject({
      role: "assistive",
      isolated_from_memory: true,
      included_in_active_memory: false
    });
    expect(context.external_assist.hints).toContainEqual(expect.objectContaining({
      id: "hint_api_external",
      source_uri: "external://api/hint"
    }));
    expect(context.external_assist.hints).toContainEqual(expect.objectContaining({
      id: "hint_secondary_external",
      source_uri: "external://secondary/hint"
    }));
    expect(context.context_assembly.sources).toContainEqual(expect.objectContaining({
      kind: "external_assist",
      status: "included"
    }));
    expect(context.context_assembly.quality_checks).toContainEqual(expect.objectContaining({
      id: "external_assist_isolated",
      status: "pass"
    }));
    expect(records).toContainEqual(expect.objectContaining({
      phase: "prefetch",
      status: "completed",
      provider_id: "test-external-assist",
      included_in_active_memory: false
    }));
    expect(records).toContainEqual(expect.objectContaining({
      phase: "sync",
      status: "completed",
      provider_id: "test-external-assist",
      isolated_from_memory: true,
      included_in_active_memory: false
    }));
    expect(records).toContainEqual(expect.objectContaining({
      phase: "sync",
      status: "failed",
      provider_id: "secondary-external-assist",
      isolated_from_memory: true,
      included_in_active_memory: false
    }));
    expect(diagnostics.total_records).toBeGreaterThanOrEqual(2);
    expect(diagnostics.failed_records).toBe(0);
    expect(diagnostics.hint_count).toBeGreaterThanOrEqual(2);
    expect(diagnostics.unisolated_records).toBe(0);
    expect(diagnostics.included_in_active_memory_records).toBe(0);
    expect(diagnostics.groups).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider_id: "test-external-assist", phase: "prefetch", status: "completed" }),
      expect.objectContaining({ provider_id: "test-external-assist", phase: "sync", status: "completed" })
    ]));
    expect(diagnostics.violations).toEqual([]);
    expect(diagnostics.recent_failures).toEqual([]);
    expect(allDiagnostics.failed_records).toBeGreaterThanOrEqual(1);
    expect(allDiagnostics.groups).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider_id: "secondary-external-assist", phase: "prefetch", status: "completed" }),
      expect.objectContaining({ provider_id: "secondary-external-assist", phase: "sync", status: "failed" })
    ]));
    expect(allDiagnostics.recent_failures).toContainEqual(expect.objectContaining({
      provider_id: "secondary-external-assist"
    }));
    expect(JSON.stringify(allDiagnostics)).not.toContain("raw-secret-token");
    expect(context.active_memory).toEqual([]);
    expect(context.knowledge_wiki).toEqual([]);
  });

  it("freezes context snapshots through the context API", async () => {
    const { baseUrl } = await startTestServer();
    const session = await postJson<{ id: string }>(`${baseUrl}/api/chat/sessions`, {}, 201);

    const freeze = await postJson<{
      session_id: string;
      query: string;
      freeze_snapshot: {
        stable_hash: string;
        content: string;
        soul: { file_ref: { uri: string } };
      };
      context_assembly: {
        sources: Array<{ kind: string; status: string }>;
        quality_checks: Array<{ id: string; status: string }>;
      };
      source_refs: Array<{ kind: string; uri: string }>;
      stable_hash: string;
    }>(`${baseUrl}/api/context/freeze`, {
      session_id: session.id,
      query: "profile context"
    });
    const missingSession = await postJson<{ error: string }>(`${baseUrl}/api/context/freeze`, {}, 400);

    expect(freeze).toMatchObject({
      session_id: session.id,
      query: "profile context"
    });
    expect(freeze.freeze_snapshot.content).toContain("SOUL.md");
    expect(freeze.freeze_snapshot.soul.file_ref.uri).toBe(path.join("profile", "SOUL.md"));
    expect(freeze.stable_hash).toBe(freeze.freeze_snapshot.stable_hash);
    expect(freeze.source_refs).toContainEqual(expect.objectContaining({
      kind: "profile",
      uri: path.join("profile", "SOUL.md")
    }));
    expect(freeze.context_assembly.sources).toContainEqual(expect.objectContaining({
      kind: "freeze_snapshot",
      status: "included"
    }));
    expect(freeze.context_assembly.quality_checks).toContainEqual(expect.objectContaining({
      id: "freeze_snapshot_loaded",
      status: "pass"
    }));
    expect(missingSession.error).toBe("session_id_required");
  });

  it("loads local file external assist provider from env", async () => {
    const assistRoot = await mkdtemp(path.join(tmpdir(), "samurai-api-external-assist-"));
    roots.push(assistRoot);
    const assistFile = path.join(assistRoot, "external-assist.json");
    await writeFile(assistFile, JSON.stringify([{
      id: "hint_env_release",
      title: "Env configured assist",
      summary: "Run doctor, typecheck, full Vitest, build, and i18n for release readiness.",
      source_label: "env-assist",
      keywords: ["release", "readiness", "doctor"]
    }]), "utf8");
    setManagedEnv("SAMURAI_EXTERNAL_ASSIST_FILE", assistFile);
    setManagedEnv("SAMURAI_EXTERNAL_ASSIST_PROVIDER_ID", "env-local-assist");
    let providerInput: ProviderInput | undefined;
    const provider = new FakeProviderAdapter("fake/test", (input) => {
      providerInput = input;
      return { content: "env external assist ok", toolCalls: [] };
    });
    const { baseUrl } = await startTestServer(provider);
    const health = await getJson<{
      external_assist: {
        configured: boolean;
        provider_id: string | null;
        provider_ids?: string[];
        provider_count?: number;
        source: string;
        provider_kind: string | null;
        file_name?: string;
        errors: string[];
      };
    }>(`${baseUrl}/api/health`);
    const session = await postJson<{ id: string }>(`${baseUrl}/api/chat/sessions`, {}, 201);

    await postJson(
      `${baseUrl}/api/chat/sessions/${session.id}/messages`,
      {
        content: "release readiness doctor を確認して",
        output_locale: "ja"
      },
      201
    );
    const diagnostics = await getJson<{
      total_records: number;
      hint_count: number;
      groups: Array<{ provider_id: string; phase: string; status: string }>;
      violations: unknown[];
    }>(`${baseUrl}/api/external-assist/diagnostics?session_id=${session.id}&provider_id=env-local-assist`);

    expect(health.external_assist).toEqual({
      configured: true,
      provider_id: "env-local-assist",
      provider_ids: ["env-local-assist"],
      provider_count: 1,
      source: "local_file",
      provider_kind: "local_file",
      max_hints: 5,
      timeout_ms: null,
      token_configured: false,
      auth_header: null,
      file_name: "external-assist.json",
      errors: [],
      warnings: []
    });
    expect(providerInput?.externalAssist?.hints).toContainEqual(expect.objectContaining({
      id: "hint_env_release",
      source_label: "env-assist"
    }));
    expect(diagnostics.total_records).toBeGreaterThanOrEqual(1);
    expect(diagnostics.hint_count).toBeGreaterThanOrEqual(1);
    expect(diagnostics.groups).toContainEqual(expect.objectContaining({
      provider_id: "env-local-assist",
      phase: "prefetch",
      status: "completed"
    }));
    expect(diagnostics.violations).toEqual([]);
  });

  it("loads multiple local file external assist providers from env", async () => {
    const assistRoot = await mkdtemp(path.join(tmpdir(), "samurai-api-external-assist-"));
    roots.push(assistRoot);
    const releaseFile = path.join(assistRoot, "release-assist.json");
    const gatewayFile = path.join(assistRoot, "gateway-assist.json");
    await writeFile(releaseFile, JSON.stringify([{
      id: "hint_env_release",
      summary: "Release readiness needs doctor checks.",
      keywords: ["release", "readiness"]
    }]), "utf8");
    await writeFile(gatewayFile, JSON.stringify([{
      id: "hint_env_gateway",
      summary: "Gateway readiness needs pairing diagnostics.",
      keywords: ["gateway", "pairing"]
    }]), "utf8");
    setManagedEnv("SAMURAI_EXTERNAL_ASSIST_FILES", [releaseFile, gatewayFile].join(path.delimiter));
    setManagedEnv("SAMURAI_EXTERNAL_ASSIST_PROVIDER_IDS", "env-release-assist,env-gateway-assist");
    let providerInput: ProviderInput | undefined;
    const provider = new FakeProviderAdapter("fake/test", (input) => {
      providerInput = input;
      return { content: "multi env external assist ok", toolCalls: [] };
    });
    const { baseUrl } = await startTestServer(provider);
    const health = await getJson<{
      external_assist: {
        configured: boolean;
        provider_id: string | null;
        provider_ids: string[];
        provider_count: number;
        source: string;
        provider_kind: string | null;
        file_name?: string;
        errors: string[];
      };
    }>(`${baseUrl}/api/health`);
    const session = await postJson<{ id: string }>(`${baseUrl}/api/chat/sessions`, {}, 201);

    const turn = await postJson<{ backendRun: { metadata: Record<string, unknown> } }>(
      `${baseUrl}/api/chat/sessions/${session.id}/messages`,
      {
        content: "release readiness と gateway pairing を確認して",
        output_locale: "ja"
      },
      201
    );
    const diagnostics = await getJson<{
      total_records: number;
      hint_count: number;
      groups: Array<{ provider_id: string; phase: string; status: string }>;
      violations: unknown[];
    }>(`${baseUrl}/api/external-assist/diagnostics?session_id=${session.id}`);

    expect(health.external_assist).toMatchObject({
      configured: true,
      provider_id: "env-release-assist, env-gateway-assist",
      provider_ids: ["env-release-assist", "env-gateway-assist"],
      provider_count: 2,
      source: "multiple",
      provider_kind: "multiple",
      errors: []
    });
    expect(providerInput?.externalAssist?.hints).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "hint_env_release" }),
      expect.objectContaining({ id: "hint_env_gateway" })
    ]));
    expect(turn.backendRun.metadata.external_assist_sync_provider_ids).toEqual([
      "env-release-assist",
      "env-gateway-assist"
    ]);
    expect(turn.backendRun.metadata.external_assist_sync_statuses).toEqual(["skipped", "skipped"]);
    expect(diagnostics.total_records).toBeGreaterThanOrEqual(2);
    expect(diagnostics.hint_count).toBeGreaterThanOrEqual(2);
    expect(diagnostics.groups).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider_id: "env-release-assist", phase: "prefetch", status: "completed" }),
      expect.objectContaining({ provider_id: "env-gateway-assist", phase: "prefetch", status: "completed" }),
      expect.objectContaining({ provider_id: "env-release-assist", phase: "sync", status: "skipped" }),
      expect.objectContaining({ provider_id: "env-gateway-assist", phase: "sync", status: "skipped" })
    ]));
    expect(diagnostics.violations).toEqual([]);
  });

  it("reports invalid external assist env without failing API startup", async () => {
    setManagedEnv("SAMURAI_EXTERNAL_ASSIST_URL", "file:///tmp/not-http.json");
    setManagedEnv("SAMURAI_EXTERNAL_ASSIST_TOKEN", "raw-secret-token");
    setManagedEnv("SAMURAI_EXTERNAL_ASSIST_PROVIDER_ID", "broken-assist");
    const { baseUrl } = await startTestServer();
    const health = await getJson<{
      external_assist: {
        configured: boolean;
        provider_id: string | null;
        source: string;
        provider_kind: string | null;
        token_configured: boolean;
        errors: string[];
      };
    }>(`${baseUrl}/api/health`);
    const settings = await getJson<{
      external_assist_config: {
        configured: boolean;
        provider_id: string | null;
        source: string;
        provider_kind: string | null;
        token_configured: boolean;
        errors: string[];
      };
    }>(`${baseUrl}/api/settings`);

    expect(health.external_assist).toMatchObject({
      configured: false,
      provider_id: "broken-assist",
      source: "invalid",
      provider_kind: "http",
      token_configured: true,
      errors: ["invalid_external_assist_url"]
    });
    expect(JSON.stringify(health.external_assist)).not.toContain("raw-secret-token");
    expect(settings.external_assist_config).toMatchObject({
      configured: false,
      provider_id: "broken-assist",
      source: "invalid",
      provider_kind: "http",
      token_configured: true,
      errors: ["invalid_external_assist_url"]
    });
    expect(JSON.stringify(settings.external_assist_config)).not.toContain("raw-secret-token");
  });

  it("serves and executes Domain Commands through the Common Domain API", async () => {
    const { baseUrl } = await startTestServer();
    const session = await postJson<{ id: string }>(`${baseUrl}/api/chat/sessions`, {}, 201);
    const surfaceContract = await getJson<{
      protocol_version: string;
      renderers: Array<{ kind: string; id: string; fallback_kind?: string }>;
      render_kinds: string[];
      commands: Array<{ id: string; input_sources: string[]; output_render_kinds: string[] }>;
      input_sources: string[];
    }>(`${baseUrl}/api/surface/contract?source=runtime_api`);
    const catalog = await getJson<{
      commands: Array<{ id: string; input_sources: string[]; runtime_method: string; output_render_kinds: string[] }>;
      input_sources: string[];
    }>(`${baseUrl}/api/domain/commands?source=runtime_api`);
    const diagnostics = await getJson<{
      ok: boolean;
      coverage: {
        commands: number;
        action_catalog_entries: number;
        provider_tool_mappings: number;
        surface_operation_mappings: number;
        render_kinds: string[];
        input_sources: string[];
      };
      issues: unknown[];
      recommendation: string;
    }>(`${baseUrl}/api/domain/commands/diagnostics`);
    const command = catalog.commands.find((item) => item.id === "chat.turn.run");
    const rendererKinds = new Set(surfaceContract.renderers.map((renderer) => renderer.kind));

    expect(surfaceContract.protocol_version).toBe("1");
    expect(surfaceContract.render_kinds).toEqual(expect.arrayContaining(["chat", "artifact", "knowledge_wiki", "custom_view"]));
    expect(surfaceContract.renderers.find((renderer) => renderer.kind === "custom_view")).toMatchObject({
      id: "surface.custom_view.generic",
      fallback_kind: "artifact"
    });
    expect(surfaceContract.commands.find((item) => item.id === "artifact.create")?.output_render_kinds)
      .toEqual(expect.arrayContaining(["artifact", "form", "table", "chart", "custom_view"]));
    expect(surfaceContract.commands.every((item) =>
      item.output_render_kinds.every((kind) => rendererKinds.has(kind))
    )).toBe(true);
    expect(catalog.input_sources).toContain("runtime_api");
    expect(diagnostics.ok).toBe(true);
    expect(diagnostics.issues).toEqual([]);
    expect(diagnostics.coverage.commands).toBeGreaterThanOrEqual(catalog.commands.length);
    expect(diagnostics.coverage.action_catalog_entries).toBe(diagnostics.coverage.commands);
    expect(diagnostics.coverage.provider_tool_mappings).toBeGreaterThan(0);
    expect(diagnostics.coverage.surface_operation_mappings).toBeGreaterThan(0);
    expect([...diagnostics.coverage.render_kinds].sort()).toEqual([...surfaceContract.render_kinds].sort());
    expect([...diagnostics.coverage.input_sources].sort()).toEqual([...catalog.input_sources].sort());
    expect(diagnostics.recommendation).toContain("internally consistent");
    expect(command).toMatchObject({
      id: "chat.turn.run",
      output_render_kinds: ["chat"]
    });
    expect(command?.input_sources).toContain("runtime_api");

    const result = await postJson<{
      ok: boolean;
      value: { backendRun: { status: string }; messages: Array<{ role: string; content: string }> };
    }>(
      `${baseUrl}/api/domain/commands/chat.turn.run/run`,
      {
        session_id: session.id,
        payload: {
          content: "Domain Command API から提案書を作って",
          output_locale: "ja"
        }
      },
      201
    );

    expect(result.ok).toBe(true);
    expect(result.value.backendRun.status).toBe("completed");
    expect(result.value.messages.some((message) => message.role === "agent")).toBe(true);

    const wiki = await postJson<{
      ok: boolean;
      value: { resource: { id: string; state: string; provenance: { kind: string; verified: boolean } } };
    }>(
      `${baseUrl}/api/domain/commands/wiki.proposal.create/run`,
      {
        session_id: session.id,
        payload: {
          title: "Domain Command Wiki",
          content: "domain-command-lifecycle-needle should become active retrieval context.",
          content_locale: "en",
          source_refs: [{
            kind: "backend_run",
            id: "run_domain_wiki",
            uri: "backend-runs/run_domain_wiki",
            label: "Domain Command source"
          }],
          provenance: {
            kind: "user_authored",
            summary: "Created through the Common Domain API contract test.",
            verified: true
          }
        }
      },
      201
    );
    const acceptedWiki = await postJson<{
      ok: boolean;
      value: { resource: { id: string; state: string } };
    }>(
      `${baseUrl}/api/domain/commands/wiki.accept/run`,
      {
        session_id: session.id,
        payload: {
          wiki_id: wiki.value.resource.id
        }
      },
      201
    );
    const activeWiki = await getJson<{
      knowledge_wiki: Array<{
        id: string;
        source_refs: Array<{ kind: string; id: string }>;
        provenance: { kind: string; verified: boolean };
      }>;
      report: { included_wiki_ids: string[] };
    }>(`${baseUrl}/api/wiki/active-retrieval?session_id=${session.id}&q=domain-command-lifecycle-needle`);

    expect(wiki).toMatchObject({
      ok: true,
      value: { resource: { state: "proposed", provenance: { kind: "user_authored", verified: true } } }
    });
    expect(acceptedWiki).toMatchObject({
      ok: true,
      value: { resource: { id: wiki.value.resource.id, state: "active" } }
    });
    expect(activeWiki.report.included_wiki_ids).toContain(wiki.value.resource.id);
    expect(activeWiki.knowledge_wiki).toContainEqual(expect.objectContaining({
      id: wiki.value.resource.id,
      source_refs: expect.arrayContaining([expect.objectContaining({ kind: "backend_run", id: "run_domain_wiki" })]),
      provenance: expect.objectContaining({ kind: "user_authored", verified: true })
    }));

    const blockedGateway = await postJson<{
      inbound: { status: string; trusted: boolean };
      pairing: { id: string; status: string };
    }>(
      `${baseUrl}/api/gateway/inbound`,
      {
        channel: "webhook",
        source_identity: "domain-gateway-1",
        body: "接続確認",
        output_locale: "ja"
      },
      202
    );
    await postJson<{ id: string; status: string }>(
      `${baseUrl}/api/gateway/pairings/${blockedGateway.pairing.id}/approve`,
      {}
    );
    const routedGateway = await postJson<{
      inbound: { status: string; trusted: boolean; session_key?: string; error?: string };
    }>(
      `${baseUrl}/api/gateway/inbound`,
      {
        channel: "webhook",
        source_identity: "domain-gateway-1",
        body: "Domain Command Gateway から提案書を作って",
        output_locale: "ja"
      },
      202
    );

    expect(blockedGateway).toMatchObject({
      inbound: { status: "blocked", trusted: false }, pairing: { status: "pending" }
    });
    expect(routedGateway).toMatchObject({
      inbound: {
        status: "blocked",
        trusted: true,
        session_key: "webhook:domain-gateway-1:main",
        error: "gateway_participant_authentication_required"
      }
    });
    expect(routedGateway).not.toHaveProperty("session");
    expect(routedGateway).not.toHaveProperty("chat");
  });

  it("resolves BackendRun identity outside skill Domain payloads", async () => {
    const { baseUrl, server } = await startTestServer();
    const now = "2026-07-18T00:00:00.000Z";
    const session = await server.store.createSession({
      id: "domain-trusted-run-session",
      session_key: "domain-trusted-run-session",
      title: "Domain trusted run",
      room_id: "room_default",
      ui_locale: "en",
      output_locale: "en",
      created_at: now,
      updated_at: now
    });
    await server.store.ensureResourceAccessBoundary({
      resourceKind: "session",
      resourceId: session.id,
      sourceRoomId: "room_default",
      ownerParticipantId: localOwnerParticipantId,
      actorId: localOwnerParticipantId
    });
    const backendRunId = "domain-trusted-backend-run";
    await server.store.saveBackendRun({
      id: backendRunId,
      session_id: session.id,
      room_id: "room_default",
      principal: { kind: "agent", agent_id: "agent_default", requested_by_participant_id: localOwnerParticipantId },
      source: { kind: "native_app", app_id: "samurai-native" },
      session_ref: { app_id: "samurai-native", session_id: session.id },
      agent_id: "agent_default",
      requested_by_participant_id: localOwnerParticipantId,
      input_message_id: "domain-trusted-input",
      backend_id: "samurai-native",
      backend_kind: "samurai_native",
      status: "completed",
      started_at: now,
      completed_at: now,
      input_summary: "trusted Domain run fixture",
      output_summary: "trusted Domain run fixture",
      metadata: {}
    });
    const skill = await server.store.saveSkillMarkdown({
      state: "project",
      skillId: "domain-trusted-skill",
      markdown: [
        "---",
        JSON.stringify({
          id: "domain-trusted-skill",
          state: "project",
          title: "Trusted Domain Skill",
          description: "A fixture for Runtime-owned BackendRun context.",
          tags: [],
          provenance: "fixture",
          trust_level: "user_authored",
          allowed_scopes: ["skill"],
          required_capabilities: [],
          schedule_policy: {},
          secret_policy: {},
          owner_pinned: false
        }),
        "---",
        "# Trusted Domain Skill",
        "",
        "Read through a trusted BackendRun context."
      ].join("\n")
    });

    const view = await postJson<{
      payload: { skill_id: string };
      result: { usage: { run_id: string } };
    }>(`${baseUrl}/api/domain/queries/skill.view/run`, {
      backend_run_id: backendRunId,
      payload: { skill_id: skill.id }
    });
    const forgedPayload = await postJson<{
      ok: boolean;
      error: { code: string; message: string };
    }>(`${baseUrl}/api/domain/queries/skill.view/run`, {
      backend_run_id: backendRunId,
      payload: { skill_id: skill.id, run_id: "forged-backend-run" }
    }, 400);
    const forgedSessionPayload = await postJson<{
      ok: boolean;
      error: { code: string; message: string };
    }>(`${baseUrl}/api/domain/queries/skill.view/run`, {
      backend_run_id: backendRunId,
      payload: { skill_id: skill.id, session_id: "forged-session" }
    }, 400);
    const otherSession = await server.store.createSession({
      id: "domain-trusted-other-session",
      session_key: "domain-trusted-other-session",
      title: "Other session",
      room_id: "room_default",
      ui_locale: "en",
      output_locale: "en",
      created_at: now,
      updated_at: now
    });
    await server.store.ensureResourceAccessBoundary({
      resourceKind: "session",
      resourceId: otherSession.id,
      sourceRoomId: "room_default",
      ownerParticipantId: localOwnerParticipantId,
      actorId: localOwnerParticipantId
    });
    const mismatchedTransport = await postJson<{
      ok: boolean;
      error: { code: string; message: string };
    }>(`${baseUrl}/api/domain/queries/skill.view/run`, {
      session_id: otherSession.id,
      backend_run_id: backendRunId,
      payload: { skill_id: skill.id }
    }, 400);

    expect(view.payload).toEqual({ skill_id: skill.id });
    expect(view.result.usage.run_id).toBe(backendRunId);
    expect(forgedPayload).toMatchObject({
      ok: false,
      error: { code: "bad_request", message: "untrusted_domain_context:run_id" }
    });
    expect(forgedSessionPayload).toMatchObject({
      ok: false,
      error: { code: "bad_request", message: "untrusted_domain_context:session_id" }
    });
    expect(mismatchedTransport).toMatchObject({
      ok: false,
      error: { code: "bad_request", message: "domain_transport_session_mismatch:backend_run_id" }
    });
  });

  it("exposes gateway pairing approval and inbound routing diagnostics", async () => {
    const { baseUrl } = await startTestServer();

    const pairingPolicies = await getJson<Array<{ channel: string; trust_mode: string }>>(`${baseUrl}/api/gateway/pairing-policies`);
    const routingPolicies = await getJson<Array<{ channel: string; session_key_strategy: string }>>(`${baseUrl}/api/gateway/routing-policies`);
    const slackPolicy = await getJson<{ channel: string; trust_mode: string }>(`${baseUrl}/api/gateway/pairing-policies/slack`);
    const slackRoutingPreview = await postJson<{
      input: { channel: string; source_identity: string; thread_id: string };
      policy: { channel: string };
      resolution: { session_key: string; session_key_strategy: string };
    }>(`${baseUrl}/api/gateway/session-routing/preview`, {
      channel: "slack",
      source_identity: "workspace:T123/user:U456",
      thread_id: "thread:999"
    });
    const blocked = await postJson<{
      inbound: { id: string; status: string; trusted: boolean };
      pairing: { id: string; status: string; pairing_code?: string };
    }>(
      `${baseUrl}/api/gateway/inbound`,
      {
        channel: "webhook",
        source_identity: "external-api-1",
        source_label: "External API",
        body: "初回の外部入力です"
      },
      202
    );
    const pendingPairings = await getJson<Array<{ id: string; status: string }>>(`${baseUrl}/api/gateway/pairings?status=pending`);
    const blockedDiagnostics = await getJson<{
      pending_pairings: number;
      blocked_inbound_messages: number;
      failed_inbound_messages: number;
      active_concurrency_locks: number;
      expired_active_concurrency_locks: number;
      issues: Array<{ code: string; severity: string; resource_kind: string; resource_id: string }>;
      recommendation: string;
    }>(`${baseUrl}/api/gateway/diagnostics`);
    const approved = await postJson<{ id: string; status: string; pairing_code?: string }>(
      `${baseUrl}/api/gateway/pairings/${blocked.pairing.id}/approve`,
      {}
    );
    const routed = await postJson<{
      inbound: { id: string; status: string; trusted: boolean; session_key?: string; error?: string };
      pairing: { id: string; status: string };
    }>(
      `${baseUrl}/api/gateway/inbound`,
      {
        channel: "webhook",
        source_identity: "external-api-1",
        body: "提案書を作って",
        output_locale: "ja"
      },
      202
    );
    const blockedInbound = await getJson<Array<{ id: string; status: string }>>(`${baseUrl}/api/gateway/inbound?status=blocked`);
    const boundaryPolicies = await getJson<Array<{ id: string; source_channel: string; session_key: string }>>(`${baseUrl}/api/gateway/boundary-policies?source_channel=webhook`);
    const releasedLocks = await getJson<Array<{ lock_key: string; status: string }>>(`${baseUrl}/api/gateway/concurrency-locks?status=released`);
    const health = await getJson<{
      gateway: {
        pending_pairings: number;
        approved_pairings: number;
        blocked_inbound_recent: number;
        failed_inbound_recent: number;
        boundary_policies: number;
        active_concurrency_locks: number;
      };
    }>(`${baseUrl}/api/health`);

    expect(pairingPolicies.map((policy) => policy.channel)).toEqual([
      "telegram",
      "slack",
      "line",
      "email",
      "mobile",
      "webhook",
      "local_cli",
      "cron"
    ]);
    expect(routingPolicies.map((policy) => policy.channel)).toEqual([
      "telegram",
      "slack",
      "line",
      "email",
      "mobile",
      "webhook",
      "local_cli",
      "cron"
    ]);
    expect(slackPolicy).toMatchObject({ channel: "slack", trust_mode: "pairing_required" });
    expect(slackRoutingPreview).toMatchObject({
      input: {
        channel: "slack",
        source_identity: "workspace:T123/user:U456",
        thread_id: "thread:999"
      },
      policy: { channel: "slack" },
      resolution: {
        session_key: "slack:workspace~3AT123~2Fuser~3AU456:thread~3A999",
        session_key_strategy: "account_thread"
      }
    });
    expect(blocked.inbound).toMatchObject({ status: "blocked", trusted: false });
    expect(blocked.pairing).toMatchObject({ status: "pending" });
    expect(blocked.pairing.pairing_code).toBeTruthy();
    expect(pendingPairings.map((pairing) => pairing.id)).toContain(blocked.pairing.id);
    expect(blockedDiagnostics).toMatchObject({
      pending_pairings: 1,
      blocked_inbound_messages: 1,
      failed_inbound_messages: 0,
      active_concurrency_locks: 0,
      expired_active_concurrency_locks: 0
    });
    expect(blockedDiagnostics.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "gateway_pending_pairing",
        severity: "warning",
        resource_kind: "pairing",
        resource_id: blocked.pairing.id
      }),
      expect.objectContaining({
        code: "gateway_blocked_inbound",
        severity: "warning",
        resource_kind: "inbound_message",
        resource_id: blocked.inbound.id
      })
    ]));
    expect(blockedDiagnostics.recommendation).toContain("Review Gateway pairing");
    expect(approved).toMatchObject({ id: blocked.pairing.id, status: "approved" });
    expect(approved).not.toHaveProperty("pairing_code");
    expect(routed.inbound).toMatchObject({
      status: "blocked",
      trusted: true,
      session_key: "webhook:external-api-1:main",
      error: "gateway_participant_authentication_required"
    });
    expect(routed.pairing).toMatchObject({ id: blocked.pairing.id, status: "approved" });
    expect(routed).not.toHaveProperty("session");
    expect(routed).not.toHaveProperty("chat");
    expect(routed).not.toHaveProperty("boundaryPolicy");
    expect(blockedInbound.map((inbound) => inbound.id)).toContain(routed.inbound.id);
    expect(boundaryPolicies).toEqual([]);
    expect(releasedLocks).toEqual([]);
    expect(health.gateway).toMatchObject({
      pending_pairings: 0,
      approved_pairings: 1,
      blocked_inbound_recent: 2,
      failed_inbound_recent: 0,
      boundary_policies: 0,
      active_concurrency_locks: 0
    });
  });

  it("routes dedicated webhook payloads through Gateway inbound", async () => {
    const webhookSecret = "test-gateway-webhook-secret";
    setManagedEnv("SAMURAI_GATEWAY_WEBHOOK_SECRET", webhookSecret);
    const { baseUrl } = await startTestServer();
    const webhookUrl = `${baseUrl}/api/gateway/webhooks/external-webhook-1`;
    const invalid = await postSignedSamuraiJson<{ error: string }>(webhookUrl, {
      metadata: { request_id: "req_missing_body" }
    }, webhookSecret, 400);
    const blocked = await postSignedSamuraiJson<{
      adapter: { channel: string; source_identity: string; body_field: string };
      inbound: { id: string; status: string; trusted: boolean; metadata: Record<string, unknown> };
      pairing: { id: string; status: string; pairing_code?: string };
    }>(webhookUrl, {
      text: "Webhook初回です",
      source_label: "Webhook App",
      metadata: {
        request_id: "req_1",
        token: "raw-secret-token"
      }
    }, webhookSecret, 202);
    await postJson<{ id: string; status: string }>(
      `${baseUrl}/api/gateway/pairings/${blocked.pairing.id}/approve`,
      {}
    );
    const routed = await postSignedSamuraiJson<{
      adapter: { channel: string; source_identity: string; body_field: string };
      inbound: { id: string; status: string; trusted: boolean; body: string; metadata: Record<string, unknown>; session_key?: string };
      pairing: { id: string; status: string };
      session: { session_key: string };
      chat: {
        backendRun: { status: string; metadata: Record<string, unknown> };
        messages: Array<{ role: string; content: string }>;
      };
    }>(webhookUrl, {
      event: {
        text: "Webhookから提案書を作って"
      },
      source_label: "Webhook App",
      metadata: {
        request_id: "req_2",
        authorization: "Bearer raw-secret-token"
      }
    }, webhookSecret, 202);

    expect(invalid).toEqual({ error: "invalid_gateway_webhook" });
    expect(blocked.adapter).toEqual({
      channel: "webhook",
      source_identity: "external-webhook-1",
      body_field: "text"
    });
    expect(blocked.inbound).toMatchObject({
      status: "blocked",
      trusted: false,
      metadata: {
        request_id: "req_1",
        token: "[redacted]",
        gateway_webhook_adapter: true,
        gateway_webhook_body_field: "text",
        gateway_webhook_payload_keys: ["text", "source_label"]
      }
    });
    expect(blocked.pairing).toMatchObject({ status: "pending" });
    expect(blocked.pairing.pairing_code).toBeTruthy();
    expect(JSON.stringify(blocked)).not.toContain("raw-secret-token");
    expect(routed.adapter).toEqual({
      channel: "webhook",
      source_identity: "external-webhook-1",
      body_field: "event.text"
    });
    expectGatewayRoomAccessBlocked(routed, "webhook:external-webhook-1:main");
    expect(routed.inbound).toMatchObject({
      body: "Webhookから提案書を作って",
      metadata: {
        request_id: "req_2",
        authorization: "[redacted]",
        gateway_webhook_adapter: true,
        gateway_webhook_body_field: "event.text",
        gateway_webhook_payload_keys: ["event", "source_label"]
      }
    });
    expect(JSON.stringify(routed)).not.toContain("raw-secret-token");
  });

  it("routes Slack event payloads through Gateway inbound", async () => {
    const signingSecret = "test-slack-route-secret";
    setManagedEnv("SAMURAI_SLACK_SIGNING_SECRET", signingSecret);
    const { baseUrl } = await startTestServer();
    const slackUrl = `${baseUrl}/api/gateway/slack/events`;
    const challenge = await postSignedSlackJson<{ challenge: string }>(slackUrl, {
      type: "url_verification",
      challenge: "slack-challenge-code"
    }, signingSecret);
    const invalid = await postSignedSlackJson<{ error: string }>(slackUrl, {
      type: "event_callback",
      team_id: "T123",
      event: {
        type: "message",
        channel: "C123",
        user: "U456"
      }
    }, signingSecret, 400);
    const blocked = await postSignedSlackJson<{
      adapter: { channel: string; source_identity: string; body_field: string; team_id?: string; channel_id?: string; user_id?: string };
      inbound: { id: string; status: string; trusted: boolean; metadata: Record<string, unknown> };
      pairing: { id: string; status: string; pairing_code?: string; session_key: string };
    }>(slackUrl, {
      token: "raw-secret-token",
      type: "event_callback",
      team_id: "T123",
      event: {
        type: "message",
        channel: "C123",
        user: "U456",
        text: "Slack初回です",
        ts: "111.222"
      },
      metadata: {
        request_id: "slack_req_1",
        authorization: "Bearer raw-secret-token"
      }
    }, signingSecret, 202);
    await postJson<{ id: string; status: string }>(
      `${baseUrl}/api/gateway/pairings/${blocked.pairing.id}/approve`,
      {}
    );
    const routed = await postSignedSlackJson<{
      adapter: { channel: string; source_identity: string; body_field: string; team_id?: string; channel_id?: string; user_id?: string };
      inbound: { id: string; status: string; trusted: boolean; body: string; metadata: Record<string, unknown>; session_key?: string };
      session: { session_key: string };
      chat: {
        backendRun: { status: string; metadata: Record<string, unknown> };
        messages: Array<{ role: string; content: string }>;
      };
    }>(slackUrl, {
      token: "raw-secret-token",
      type: "event_callback",
      team_id: "T123",
      event: {
        type: "message",
        channel: "C123",
        user: "U456",
        text: "Slackから提案書を作って",
        thread_ts: "111.222",
        ts: "333.444"
      },
      metadata: {
        request_id: "slack_req_2",
        cookie: "raw-secret-token"
      },
      output_locale: "ja"
    }, signingSecret, 202);

    expect(challenge).toEqual({ challenge: "slack-challenge-code" });
    expect(invalid).toEqual({ error: "invalid_gateway_slack_event" });
    expect(blocked.adapter).toEqual({
      channel: "slack",
      source_identity: "team:T123/user:U456",
      body_field: "event.text",
      team_id: "T123",
      channel_id: "C123",
      user_id: "U456"
    });
    expect(blocked.inbound).toMatchObject({
      status: "blocked",
      trusted: false,
      metadata: {
        request_id: "slack_req_1",
        authorization: "[redacted]",
        gateway_slack_adapter: true,
        gateway_slack_body_field: "event.text",
        gateway_slack_envelope_type: "event_callback",
        gateway_slack_event_type: "message",
        gateway_slack_team_id: "T123",
        gateway_slack_channel_id: "C123",
        gateway_slack_user_id: "U456",
        gateway_slack_event_ts: "111.222",
        gateway_slack_thread_ts: "111.222"
      }
    });
    expect(blocked.inbound.metadata.gateway_slack_payload_keys).toEqual(["type", "team_id", "event"]);
    expect(blocked.pairing).toMatchObject({
      status: "pending",
      session_key: "slack:team~3AT123:channel~3AC123~2Fthread~3A111.222"
    });
    expect(blocked.pairing.pairing_code).toBeTruthy();
    expect(JSON.stringify(blocked)).not.toContain("raw-secret-token");
    expect(routed.adapter).toEqual({
      channel: "slack",
      source_identity: "team:T123/user:U456",
      body_field: "event.text",
      team_id: "T123",
      channel_id: "C123",
      user_id: "U456"
    });
    expectGatewayRoomAccessBlocked(routed, "slack:team~3AT123:channel~3AC123~2Fthread~3A111.222");
    expect(routed.inbound).toMatchObject({
      body: "Slackから提案書を作って",
      metadata: {
        request_id: "slack_req_2",
        cookie: "[redacted]",
        gateway_slack_adapter: true,
        gateway_slack_body_field: "event.text",
        gateway_slack_envelope_type: "event_callback",
        gateway_slack_event_type: "message",
        gateway_slack_team_id: "T123",
        gateway_slack_channel_id: "C123",
        gateway_slack_user_id: "U456",
        gateway_slack_event_ts: "333.444",
        gateway_slack_thread_ts: "111.222"
      }
    });
    expect(JSON.stringify(routed)).not.toContain("raw-secret-token");
  });

  it("verifies Slack event signatures when a signing secret is configured", async () => {
    const signingSecret = "test-slack-signing-secret";
    setManagedEnv("SAMURAI_SLACK_SIGNING_SECRET", signingSecret);
    const { baseUrl } = await startTestServer();
    const slackUrl = `${baseUrl}/api/gateway/slack/events`;
    const eventPayload = {
      token: "raw-secret-token",
      type: "event_callback",
      team_id: "T123",
      event: {
        type: "message",
        channel: "C123",
        user: "U456",
        text: "Slack署名つき初回です",
        ts: "222.333"
      },
      metadata: {
        request_id: "slack_signed_req",
        authorization: "Bearer raw-secret-token"
      }
    };
    const missing = await postJson<{ error: string; reason: string; signature_status: string }>(slackUrl, eventPayload, 401);
    const invalid = await postRawJson<{ error: string; reason: string; signature_status: string }>(
      slackUrl,
      JSON.stringify(eventPayload),
      {
        "X-Slack-Signature": "v0=invalid",
        "X-Slack-Request-Timestamp": Math.floor(Date.now() / 1000).toString()
      },
      401
    );
    const signedChallenge = await postSignedSlackJson<{ challenge: string }>(slackUrl, {
      type: "url_verification",
      challenge: "signed-slack-challenge"
    }, signingSecret);
    const health = await getJson<{ gateway: { slack_signature_configured: boolean } }>(`${baseUrl}/api/health`);
    const blocked = await postSignedSlackJson<{
      adapter: { channel: string; source_identity: string; body_field: string };
      inbound: { id: string; status: string; trusted: boolean; metadata: Record<string, unknown> };
      pairing: { id: string; status: string };
    }>(slackUrl, eventPayload, signingSecret, 202);

    expect(missing).toEqual({
      error: "invalid_gateway_slack_signature",
      reason: "slack_signature_headers_missing",
      signature_status: "missing_headers"
    });
    expect(invalid).toEqual({
      error: "invalid_gateway_slack_signature",
      reason: "slack_signature_invalid",
      signature_status: "invalid"
    });
    expect(signedChallenge).toEqual({ challenge: "signed-slack-challenge" });
    expect(health.gateway.slack_signature_configured).toBe(true);
    expect(blocked.adapter).toMatchObject({
      channel: "slack",
      source_identity: "team:T123/user:U456",
      body_field: "event.text"
    });
    expect(blocked.inbound).toMatchObject({
      status: "blocked",
      trusted: false,
      metadata: {
        request_id: "slack_signed_req",
        authorization: "[redacted]",
        gateway_slack_adapter: true,
        gateway_slack_signature_status: "verified",
        gateway_slack_body_field: "event.text"
      }
    });
    expect(blocked.inbound.metadata.gateway_slack_signature_timestamp).toBeTruthy();
    expect(JSON.stringify(blocked)).not.toContain("raw-secret-token");
    expect(JSON.stringify(blocked)).not.toContain(signingSecret);
  });

  it("routes Telegram update payloads through Gateway inbound", async () => {
    const webhookSecret = "test-telegram-webhook-secret";
    setManagedEnv("SAMURAI_TELEGRAM_WEBHOOK_SECRET", webhookSecret);
    const { baseUrl } = await startTestServer();
    const telegramUrl = `${baseUrl}/api/gateway/telegram/updates`;
    const payload = {
      update_id: 111,
      message: {
        message_id: 42,
        message_thread_id: 7,
        chat: {
          id: -100123,
          type: "supergroup",
          title: "Ops Chat"
        },
        from: {
          id: 12345,
          username: "creator"
        },
        text: "Telegram初回です"
      },
      token: "raw-secret-token",
      metadata: {
        request_id: "telegram_req_1",
        authorization: "Bearer raw-secret-token"
      }
    };
    const missing = await postJson<{ error: string; reason: string; verification_status: string }>(telegramUrl, payload, 401);
    const invalid = await postRawJson<{ error: string; reason: string; verification_status: string }>(
      telegramUrl,
      JSON.stringify(payload),
      { "X-Telegram-Bot-Api-Secret-Token": "wrong-secret" },
      401
    );
    const blocked = await postRawJson<{
      adapter: { channel: string; source_identity: string; body_field: string; update_id?: string; chat_id?: string; user_id?: string; message_id?: string };
      inbound: { id: string; status: string; trusted: boolean; metadata: Record<string, unknown> };
      pairing: { id: string; status: string; pairing_code?: string; session_key: string };
    }>(telegramUrl, JSON.stringify(payload), { "X-Telegram-Bot-Api-Secret-Token": webhookSecret }, 202);
    const health = await getJson<{ gateway: { telegram_webhook_verification_configured: boolean } }>(`${baseUrl}/api/health`);
    await postJson<{ id: string; status: string }>(
      `${baseUrl}/api/gateway/pairings/${blocked.pairing.id}/approve`,
      {}
    );
    const routedPayload = {
      ...payload,
      message: {
        ...payload.message,
        text: "Telegramから提案書を作って"
      },
      metadata: {
        request_id: "telegram_req_2",
        cookie: "raw-secret-token"
      },
      output_locale: "ja"
    };
    const routed = await postRawJson<{
      adapter: { channel: string; source_identity: string; body_field: string; update_id?: string; chat_id?: string; user_id?: string; message_id?: string };
      inbound: { id: string; status: string; trusted: boolean; body: string; metadata: Record<string, unknown>; session_key?: string };
      session: { session_key: string };
      chat: { backendRun: { status: string; metadata: Record<string, unknown> } };
    }>(telegramUrl, JSON.stringify(routedPayload), { "X-Telegram-Bot-Api-Secret-Token": webhookSecret }, 202);

    const expectedSessionKey = "telegram:chat~3A-100123:thread~3A7";
    expect(missing).toEqual({
      error: "invalid_gateway_telegram_secret",
      reason: "telegram_secret_header_missing",
      verification_status: "missing_header"
    });
    expect(invalid).toEqual({
      error: "invalid_gateway_telegram_secret",
      reason: "telegram_secret_invalid",
      verification_status: "invalid"
    });
    expect(health.gateway.telegram_webhook_verification_configured).toBe(true);
    expect(blocked.adapter).toEqual({
      channel: "telegram",
      source_identity: "user:12345",
      body_field: "message.text",
      update_id: "111",
      chat_id: "-100123",
      user_id: "12345",
      message_id: "42"
    });
    expect(blocked.inbound).toMatchObject({
      status: "blocked",
      trusted: false,
      metadata: {
        request_id: "telegram_req_1",
        authorization: "[redacted]",
        gateway_telegram_adapter: true,
        gateway_telegram_verification_status: "verified",
        gateway_telegram_body_field: "message.text",
        gateway_telegram_update_id: "111",
        gateway_telegram_message_id: "42",
        gateway_telegram_message_thread_id: "7",
        gateway_telegram_chat_id: "-100123",
        gateway_telegram_chat_type: "supergroup",
        gateway_telegram_user_id: "12345",
        gateway_telegram_username: "creator"
      }
    });
    expect(blocked.inbound.metadata.gateway_telegram_payload_keys).toEqual(["update_id", "message"]);
    expect(blocked.pairing).toMatchObject({
      status: "pending",
      session_key: expectedSessionKey
    });
    expect(blocked.pairing.pairing_code).toBeTruthy();
    expectGatewayRoomAccessBlocked(routed, expectedSessionKey);
    expect(routed.inbound).toMatchObject({
      body: "Telegramから提案書を作って",
      metadata: {
        request_id: "telegram_req_2",
        cookie: "[redacted]",
        gateway_telegram_verification_status: "verified"
      }
    });
    expect(JSON.stringify(routed)).not.toContain("raw-secret-token");
    expect(JSON.stringify(routed)).not.toContain(webhookSecret);
  });

  it("routes LINE event payloads through Gateway inbound", async () => {
    const channelSecret = "test-line-channel-secret";
    setManagedEnv("SAMURAI_LINE_CHANNEL_SECRET", channelSecret);
    const { baseUrl } = await startTestServer();
    const lineUrl = `${baseUrl}/api/gateway/line/events`;
    const payload = {
      destination: "line-bot-1",
      events: [{
        type: "message",
        source: {
          type: "group",
          groupId: "G123",
          userId: "U456"
        },
        message: {
          id: "line-msg-1",
          type: "text",
          text: "LINE初回です"
        },
        replyToken: "raw-secret-token"
      }],
      token: "raw-secret-token",
      metadata: {
        request_id: "line_req_1",
        authorization: "Bearer raw-secret-token"
      }
    };
    const missing = await postJson<{ error: string; reason: string; signature_status: string }>(lineUrl, payload, 401);
    const invalid = await postRawJson<{ error: string; reason: string; signature_status: string }>(
      lineUrl,
      JSON.stringify(payload),
      { "X-Line-Signature": "invalid" },
      401
    );
    const blocked = await postSignedLineJson<{
      adapter: { channel: string; source_identity: string; body_field: string; event_index: number; source_type?: string; user_id?: string; group_id?: string; message_id?: string };
      inbound: { id: string; status: string; trusted: boolean; metadata: Record<string, unknown> };
      pairing: { id: string; status: string; pairing_code?: string; session_key: string };
    }>(lineUrl, payload, channelSecret, 202);
    const health = await getJson<{ gateway: { line_signature_configured: boolean } }>(`${baseUrl}/api/health`);
    await postJson<{ id: string; status: string }>(
      `${baseUrl}/api/gateway/pairings/${blocked.pairing.id}/approve`,
      {}
    );
    const routedPayload = {
      ...payload,
      events: [{
        ...payload.events[0],
        message: {
          ...payload.events[0]!.message,
          text: "LINEから提案書を作って"
        }
      }],
      metadata: {
        request_id: "line_req_2",
        cookie: "raw-secret-token"
      },
      output_locale: "ja"
    };
    const routed = await postSignedLineJson<{
      adapter: { channel: string; source_identity: string; body_field: string; event_index: number; source_type?: string; user_id?: string; group_id?: string; message_id?: string };
      inbound: { id: string; status: string; trusted: boolean; body: string; metadata: Record<string, unknown>; session_key?: string };
      session: { session_key: string };
      chat: { backendRun: { status: string; metadata: Record<string, unknown> } };
    }>(lineUrl, routedPayload, channelSecret, 202);

    const expectedSessionKey = "line:group~3AG123:main";
    expect(missing).toEqual({
      error: "invalid_gateway_line_signature",
      reason: "line_signature_header_missing",
      signature_status: "missing_header"
    });
    expect(invalid).toEqual({
      error: "invalid_gateway_line_signature",
      reason: "line_signature_invalid",
      signature_status: "invalid"
    });
    expect(health.gateway.line_signature_configured).toBe(true);
    expect(blocked.adapter).toEqual({
      channel: "line",
      source_identity: "user:U456",
      body_field: "events[0].message.text",
      event_index: 0,
      source_type: "group",
      user_id: "U456",
      group_id: "G123",
      message_id: "line-msg-1"
    });
    expect(blocked.inbound).toMatchObject({
      status: "blocked",
      trusted: false,
      metadata: {
        request_id: "line_req_1",
        authorization: "[redacted]",
        gateway_line_adapter: true,
        gateway_line_signature_status: "verified",
        gateway_line_body_field: "events[0].message.text",
        gateway_line_event_index: 0,
        gateway_line_event_count: 1,
        gateway_line_event_type: "message",
        gateway_line_source_type: "group",
        gateway_line_user_id: "U456",
        gateway_line_group_id: "G123",
        gateway_line_message_id: "line-msg-1"
      }
    });
    expect(blocked.inbound.metadata.gateway_line_payload_keys).toEqual(["destination", "events"]);
    expect(blocked.pairing).toMatchObject({
      status: "pending",
      session_key: expectedSessionKey
    });
    expect(blocked.pairing.pairing_code).toBeTruthy();
    expectGatewayRoomAccessBlocked(routed, expectedSessionKey);
    expect(routed.inbound).toMatchObject({
      body: "LINEから提案書を作って",
      metadata: {
        request_id: "line_req_2",
        cookie: "[redacted]",
        gateway_line_signature_status: "verified"
      }
    });
    expect(JSON.stringify(routed)).not.toContain("raw-secret-token");
    expect(JSON.stringify(routed)).not.toContain(channelSecret);
  });

  it("routes Email message payloads through Gateway inbound", async () => {
    const { baseUrl } = await startTestServer();
    const emailUrl = `${baseUrl}/api/gateway/email/messages`;
    const invalid = await postJson<{ error: string }>(emailUrl, {
      from: "sender@example.test",
      metadata: { request_id: "email_missing_body" }
    }, 400);
    const blocked = await postJson<{
      adapter: { channel: string; source_identity: string; body_field: string; from?: string; to?: string; subject?: string; message_id?: string };
      inbound: { id: string; status: string; trusted: boolean; metadata: Record<string, unknown> };
      pairing: { id: string; status: string; pairing_code?: string; session_key: string };
    }>(emailUrl, {
      token: "raw-secret-token",
      from: "sender@example.test",
      to: "assistant@example.test",
      subject: "初回メール",
      text: "Email初回です",
      message_id: "msg-1",
      metadata: {
        request_id: "email_req_1",
        authorization: "Bearer raw-secret-token"
      }
    }, 202);
    await postJson<{ id: string; status: string }>(
      `${baseUrl}/api/gateway/pairings/${blocked.pairing.id}/approve`,
      {}
    );
    const routed = await postJson<{
      adapter: { channel: string; source_identity: string; body_field: string; from?: string; to?: string; subject?: string; message_id?: string };
      inbound: { id: string; status: string; trusted: boolean; body: string; metadata: Record<string, unknown>; session_key?: string };
      session: { session_key: string };
      chat: {
        backendRun: { status: string; metadata: Record<string, unknown> };
        messages: Array<{ role: string; content: string }>;
      };
    }>(emailUrl, {
      token: "raw-secret-token",
      from: "sender@example.test",
      to: "assistant@example.test",
      subject: "提案書メール",
      text: "Emailから提案書を作って",
      message_id: "msg-1",
      metadata: {
        request_id: "email_req_2",
        cookie: "raw-secret-token"
      },
      output_locale: "ja"
    }, 202);

    const expectedSessionKey = "email:mailbox~3Aassistant~40example.test:message~3Amsg-1";
    expect(invalid).toEqual({ error: "invalid_gateway_email_message" });
    expect(blocked.adapter).toEqual({
      channel: "email",
      source_identity: "email:sender@example.test",
      body_field: "text",
      from: "sender@example.test",
      to: "assistant@example.test",
      subject: "初回メール",
      message_id: "msg-1"
    });
    expect(blocked.inbound).toMatchObject({
      status: "blocked",
      trusted: false,
      metadata: {
        request_id: "email_req_1",
        authorization: "[redacted]",
        gateway_email_adapter: true,
        gateway_email_body_field: "text",
          gateway_email_from: "[redacted-email]",
          gateway_email_to: "[redacted-email]",
        gateway_email_subject: "初回メール",
        gateway_email_message_id: "msg-1"
      }
    });
    expect(blocked.inbound.metadata.gateway_email_payload_keys).toEqual(["from", "to", "subject", "text", "message_id"]);
    expect(blocked.pairing).toMatchObject({
      status: "pending",
      session_key: expectedSessionKey
    });
    expect(blocked.pairing.pairing_code).toBeTruthy();
    expect(JSON.stringify(blocked)).not.toContain("raw-secret-token");
    expect(routed.adapter).toEqual({
      channel: "email",
      source_identity: "email:sender@example.test",
      body_field: "text",
      from: "sender@example.test",
      to: "assistant@example.test",
      subject: "提案書メール",
      message_id: "msg-1"
    });
    expectGatewayRoomAccessBlocked(routed, expectedSessionKey);
    expect(routed.inbound).toMatchObject({
      body: "Subject: 提案書メール\n\nEmailから提案書を作って",
      metadata: {
        request_id: "email_req_2",
        cookie: "[redacted]",
        gateway_email_adapter: true,
        gateway_email_body_field: "text",
          gateway_email_from: "[redacted-email]",
          gateway_email_to: "[redacted-email]",
        gateway_email_subject: "提案書メール",
        gateway_email_message_id: "msg-1"
      }
    });
    expect(JSON.stringify(routed)).not.toContain("raw-secret-token");
  });

  it("routes Mobile message payloads through Gateway inbound", async () => {
    const { baseUrl } = await startTestServer();
    const mobileUrl = `${baseUrl}/api/gateway/mobile/messages`;
    const invalid = await postJson<{ error: string }>(mobileUrl, {
      user_id: "user-1",
      metadata: { request_id: "mobile_missing_body" }
    }, 400);
    const blocked = await postJson<{
      adapter: { channel: string; source_identity: string; body_field: string; user_id?: string; device_id?: string; conversation_id?: string; platform?: string };
      inbound: { id: string; status: string; trusted: boolean; metadata: Record<string, unknown> };
      pairing: { id: string; status: string; pairing_code?: string; session_key: string };
    }>(mobileUrl, {
      token: "raw-secret-token",
      user_id: "user-1",
      device_id: "device-1",
      conversation_id: "conv-1",
      platform: "ios",
      text: "Mobile初回です",
      metadata: {
        request_id: "mobile_req_1",
        authorization: "Bearer raw-secret-token"
      }
    }, 202);
    await postJson<{ id: string; status: string }>(
      `${baseUrl}/api/gateway/pairings/${blocked.pairing.id}/approve`,
      {}
    );
    const routed = await postJson<{
      adapter: { channel: string; source_identity: string; body_field: string; user_id?: string; device_id?: string; conversation_id?: string; platform?: string };
      inbound: { id: string; status: string; trusted: boolean; body: string; metadata: Record<string, unknown>; session_key?: string };
      session: { session_key: string };
      chat: {
        backendRun: { status: string; metadata: Record<string, unknown> };
        messages: Array<{ role: string; content: string }>;
      };
    }>(mobileUrl, {
      token: "raw-secret-token",
      user_id: "user-1",
      device_id: "device-1",
      conversation_id: "conv-1",
      platform: "ios",
      text: "Mobileから提案書を作って",
      metadata: {
        request_id: "mobile_req_2",
        cookie: "raw-secret-token"
      },
      output_locale: "ja"
    }, 202);

    const expectedSessionKey = "mobile:mobile-user~3Auser-1:conversation~3Aconv-1";
    expect(invalid).toEqual({ error: "invalid_gateway_mobile_message" });
    expect(blocked.adapter).toEqual({
      channel: "mobile",
      source_identity: "mobile:user:user-1",
      body_field: "text",
      user_id: "user-1",
      device_id: "device-1",
      conversation_id: "conv-1",
      platform: "ios"
    });
    expect(blocked.inbound).toMatchObject({
      status: "blocked",
      trusted: false,
      metadata: {
        request_id: "mobile_req_1",
        authorization: "[redacted]",
        gateway_mobile_adapter: true,
        gateway_mobile_body_field: "text",
        gateway_mobile_user_id: "user-1",
        gateway_mobile_device_id: "device-1",
        gateway_mobile_conversation_id: "conv-1",
        gateway_mobile_platform: "ios"
      }
    });
    expect(blocked.inbound.metadata.gateway_mobile_payload_keys).toEqual(["user_id", "device_id", "conversation_id", "platform", "text"]);
    expect(blocked.pairing).toMatchObject({
      status: "pending",
      session_key: expectedSessionKey
    });
    expect(blocked.pairing.pairing_code).toBeTruthy();
    expect(JSON.stringify(blocked)).not.toContain("raw-secret-token");
    expect(routed.adapter).toEqual({
      channel: "mobile",
      source_identity: "mobile:user:user-1",
      body_field: "text",
      user_id: "user-1",
      device_id: "device-1",
      conversation_id: "conv-1",
      platform: "ios"
    });
    expectGatewayRoomAccessBlocked(routed, expectedSessionKey);
    expect(routed.inbound).toMatchObject({
      body: "Mobileから提案書を作って",
      metadata: {
        request_id: "mobile_req_2",
        cookie: "[redacted]",
        gateway_mobile_adapter: true,
        gateway_mobile_body_field: "text",
        gateway_mobile_user_id: "user-1",
        gateway_mobile_device_id: "device-1",
        gateway_mobile_conversation_id: "conv-1",
        gateway_mobile_platform: "ios"
      }
    });
    expect(JSON.stringify(routed)).not.toContain("raw-secret-token");
  });

  it("routes provider Email webhook payloads through Gateway inbound", async () => {
    const { baseUrl } = await startTestServer();
    const unsupported = await postJson<{ error: string }>(
      `${baseUrl}/api/gateway/email/provider-webhooks/unknown`,
      { from: "sender@example.test", text: "hello" },
      400
    );
    const postmark = await postJson<{
      adapter: { channel: string; provider: string; source_identity: string; body_field: string; from?: string; to?: string; subject?: string; message_id?: string };
      inbound: { id: string; status: string; trusted: boolean; metadata: Record<string, unknown> };
      pairing: { id: string; status: string; session_key: string };
    }>(`${baseUrl}/api/gateway/email/provider-webhooks/postmark`, {
      Token: "raw-secret-token",
      From: "Sender <sender@example.test>",
      To: "Assistant <assistant@example.test>",
      Subject: "Provider初回",
      TextBody: "Provider初回です",
      MessageID: "provider-thread",
      metadata: {
        request_id: "provider_req_1",
        authorization: "Bearer raw-secret-token"
      }
    }, 202);
    await postJson<{ id: string; status: string }>(
      `${baseUrl}/api/gateway/pairings/${postmark.pairing.id}/approve`,
      {}
    );
    const sendgrid = await postJson<{
      adapter: { channel: string; provider: string; source_identity: string; body_field: string; from?: string; to?: string; subject?: string; message_id?: string };
      inbound: { id: string; status: string; trusted: boolean; body: string; metadata: Record<string, unknown>; session_key?: string };
      session: { session_key: string };
      chat: {
        backendRun: { status: string; metadata: Record<string, unknown> };
        messages: Array<{ role: string; content: string }>;
      };
    }>(`${baseUrl}/api/gateway/email/provider-webhooks/sendgrid`, {
      api_key: "raw-secret-token",
      from: "Sender <sender@example.test>",
      to: "assistant@example.test",
      subject: "Provider提案",
      text: "Provider webhookから提案書を作って",
      headers: "Message-ID: <provider-thread>\r\nIn-Reply-To: <older-message>\r\n",
      metadata: {
        request_id: "provider_req_2",
        cookie: "raw-secret-token"
      },
      output_locale: "ja"
    }, 202);

    const expectedSessionKey = "email:mailbox~3Aassistant~40example.test:message~3Aprovider-thread";
    expect(unsupported).toEqual({ error: "unsupported_gateway_email_provider_webhook" });
    expect(postmark.adapter).toEqual({
      channel: "email",
      provider: "postmark",
      source_identity: "email:sender@example.test",
      body_field: "text",
      from: "sender@example.test",
      to: "assistant@example.test",
      subject: "Provider初回",
      message_id: "provider-thread"
    });
    expect(postmark.inbound).toMatchObject({
      status: "blocked",
      trusted: false,
      metadata: {
        request_id: "provider_req_1",
        authorization: "[redacted]",
        gateway_email_adapter: true,
        gateway_email_provider_webhook: true,
        gateway_email_provider: "postmark",
        gateway_email_from: "[redacted-email]",
        gateway_email_to: "[redacted-email]",
        gateway_email_subject: "Provider初回",
        gateway_email_message_id: "provider-thread"
      }
    });
    expect(postmark.inbound.metadata.gateway_email_provider_payload_keys).toEqual(["From", "To", "Subject", "TextBody", "MessageID"]);
    expect(postmark.pairing).toMatchObject({
      status: "pending",
      session_key: expectedSessionKey
    });
    expect(sendgrid.adapter).toEqual({
      channel: "email",
      provider: "sendgrid",
      source_identity: "email:sender@example.test",
      body_field: "text",
      from: "sender@example.test",
      to: "assistant@example.test",
      subject: "Provider提案",
      message_id: "provider-thread"
    });
    expectGatewayRoomAccessBlocked(sendgrid, expectedSessionKey);
    expect(sendgrid.inbound).toMatchObject({
      body: "Subject: Provider提案\n\nProvider webhookから提案書を作って",
      metadata: {
        request_id: "provider_req_2",
        cookie: "[redacted]",
        gateway_email_adapter: true,
        gateway_email_provider_webhook: true,
        gateway_email_provider: "sendgrid",
        gateway_email_message_id: "provider-thread",
        gateway_email_in_reply_to: "older-message"
      }
    });
    expect(sendgrid.inbound.metadata.gateway_email_provider_payload_keys).toEqual(["from", "to", "subject", "text", "headers", "output_locale"]);
    expect(JSON.stringify([postmark, sendgrid])).not.toContain("raw-secret-token");
  });

  it("verifies provider Email webhook signatures and authorization when configured", async () => {
    setManagedEnv("SAMURAI_EMAIL_POSTMARK_WEBHOOK_USERNAME", "postmark-user");
    setManagedEnv("SAMURAI_EMAIL_POSTMARK_WEBHOOK_PASSWORD", "postmark-password");
    setManagedEnv("SAMURAI_EMAIL_MAILGUN_SIGNING_KEY", "mailgun-signing-secret");
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    setManagedEnv(
      "SAMURAI_EMAIL_SENDGRID_WEBHOOK_PUBLIC_KEY",
      publicKey.export({ type: "spki", format: "der" }).toString("base64")
    );
    const { baseUrl } = await startTestServer();
    const health = await getJson<{
      gateway: {
        email_provider_webhook_verification_configured: boolean;
        email_provider_webhook_verification_providers: string[];
      };
    }>(`${baseUrl}/api/health`);

    const postmarkMissing = await postJson<{ error: string; provider: string; verification_status: string }>(
      `${baseUrl}/api/gateway/email/provider-webhooks/postmark`,
      {
        From: "Sender <sender@example.test>",
        Subject: "Postmark認証なし",
        TextBody: "認証なしです"
      },
      401
    );
    const postmarkAuthorized = await postRawJson<{
      adapter: { provider: string; message_id?: string };
      inbound: { status: string; metadata: Record<string, unknown> };
      pairing: { status: string; session_key: string };
    }>(
      `${baseUrl}/api/gateway/email/provider-webhooks/postmark`,
      JSON.stringify({
        From: "Postmark Sender <postmark-sender@example.test>",
        To: "Assistant <assistant@example.test>",
        Subject: "Postmark認証",
        TextBody: "Postmark Basic Auth済みです",
        MessageID: "postmark-basic-thread"
      }),
      {
        Authorization: `Basic ${Buffer.from("postmark-user:postmark-password", "utf8").toString("base64")}`
      },
      202
    );
    const mailgunMissing = await postJson<{ error: string; provider: string; verification_status: string }>(
      `${baseUrl}/api/gateway/email/provider-webhooks/mailgun`,
      {
        sender: "sender@example.test",
        recipient: "assistant@example.test",
        subject: "Mailgun署名なし",
        "stripped-text": "署名なしです"
      },
      401
    );
    const timestamp = "1700000000";
    const token = "mailgun-webhook-token";
    const signature = createHmac("sha256", "mailgun-signing-secret")
      .update(`${timestamp}${token}`)
      .digest("hex");
    const mailgun = await postJson<{
      adapter: { provider: string; message_id?: string };
      inbound: { status: string; metadata: Record<string, unknown> };
      pairing: { status: string; session_key: string };
    }>(`${baseUrl}/api/gateway/email/provider-webhooks/mailgun`, {
      signature: { timestamp, token, signature },
      sender: "Sender <sender@example.test>",
      recipient: "Assistant <assistant@example.test>",
      subject: "Mailgun署名",
      "stripped-text": "署名済みです",
      "Message-Id": "mailgun-signed-thread",
      metadata: {
        request_id: "mailgun_signed_req",
        token: "raw-secret-token"
      }
    }, 202);

    const sendgridBody = {
      from: "Sender <sendgrid-sender@example.test>",
      to: "assistant@example.test",
      subject: "SendGrid署名",
      text: "SendGrid署名済みです",
      headers: "Message-ID: <sendgrid-signed-thread>\r\n"
    };
    const sendgridRawBody = JSON.stringify(sendgridBody);
    const sendgridTimestamp = "1700000001";
    const sendgridSignature = sign(
      "sha256",
      Buffer.concat([Buffer.from(sendgridTimestamp, "utf8"), Buffer.from(sendgridRawBody, "utf8")]),
      privateKey
    ).toString("base64");
    const sendgridInvalid = await postRawJson<{ error: string; provider: string; verification_status: string }>(
      `${baseUrl}/api/gateway/email/provider-webhooks/sendgrid`,
      sendgridRawBody,
      {
        "X-Twilio-Email-Event-Webhook-Signature": "invalid-signature",
        "X-Twilio-Email-Event-Webhook-Timestamp": sendgridTimestamp
      },
      401
    );
    const sendgrid = await postRawJson<{
      adapter: { provider: string; message_id?: string };
      inbound: { status: string; metadata: Record<string, unknown> };
      pairing: { status: string; session_key: string };
    }>(
      `${baseUrl}/api/gateway/email/provider-webhooks/sendgrid`,
      sendgridRawBody,
      {
        "X-Twilio-Email-Event-Webhook-Signature": sendgridSignature,
        "X-Twilio-Email-Event-Webhook-Timestamp": sendgridTimestamp
      },
      202
    );

    expect(postmarkMissing).toMatchObject({
      error: "invalid_gateway_email_provider_webhook_verification",
      provider: "postmark",
      verification_status: "missing_authorization"
    });
    expect(health.gateway).toMatchObject({
      email_provider_webhook_verification_configured: true,
      email_provider_webhook_verification_providers: ["postmark", "mailgun", "sendgrid"]
    });
    expect(postmarkAuthorized).toMatchObject({
      adapter: {
        provider: "postmark",
        message_id: "postmark-basic-thread"
      },
      inbound: {
        status: "blocked",
        metadata: {
          gateway_email_provider: "postmark",
          gateway_email_provider_verification_status: "verified",
          gateway_email_message_id: "postmark-basic-thread"
        }
      },
      pairing: {
        status: "pending"
      }
    });
    expect(mailgunMissing).toMatchObject({
      error: "invalid_gateway_email_provider_webhook_verification",
      provider: "mailgun",
      verification_status: "missing_signature"
    });
    expect(mailgun.adapter).toMatchObject({
      provider: "mailgun",
      message_id: "mailgun-signed-thread"
    });
    expect(mailgun.inbound).toMatchObject({
      status: "blocked",
      metadata: {
        request_id: "mailgun_signed_req",
        token: "[redacted]",
        gateway_email_provider: "mailgun",
        gateway_email_provider_verification_status: "verified",
        gateway_email_message_id: "mailgun-signed-thread"
      }
    });
    expect(sendgridInvalid).toMatchObject({
      error: "invalid_gateway_email_provider_webhook_verification",
      provider: "sendgrid",
      verification_status: "invalid_signature"
    });
    expect(sendgrid.adapter).toMatchObject({
      provider: "sendgrid",
      message_id: "sendgrid-signed-thread"
    });
    expect(sendgrid.inbound).toMatchObject({
      status: "blocked",
      metadata: {
        gateway_email_provider: "sendgrid",
        gateway_email_provider_verification_status: "verified",
        gateway_email_message_id: "sendgrid-signed-thread"
      }
    });
    expect(JSON.stringify([mailgun, sendgrid])).not.toContain("mailgun-webhook-token");
    expect(JSON.stringify([mailgun, sendgrid])).not.toContain("raw-secret-token");
  });

  it("polls IMAP messages through the Email Gateway inbound path", async () => {
    setManagedEnv("SAMURAI_EMAIL_IMAP_HOST", "imap.example.test");
    setManagedEnv("SAMURAI_EMAIL_IMAP_PORT", "1993");
    setManagedEnv("SAMURAI_EMAIL_IMAP_SECURE", "true");
    setManagedEnv("SAMURAI_EMAIL_IMAP_USER", "assistant@example.test");
    setManagedEnv("SAMURAI_EMAIL_IMAP_PASSWORD", "imap-raw-password");
    setManagedEnv("SAMURAI_EMAIL_IMAP_MAILBOX", "Support");
    const firstClient = new FakeGatewayEmailImapClient({
      mailbox: "Support",
      scanned: 1,
      messages: [{
        uid: "101",
        from: "sender@example.test",
        to: "assistant@example.test",
        subject: "IMAP初回",
        text: "IMAP初回です",
        message_id: "imap-thread"
      }]
    });
    const secondClient = new FakeGatewayEmailImapClient({
      mailbox: "Support",
      scanned: 1,
      messages: [{
        uid: "102",
        from: "sender@example.test",
        to: "assistant@example.test",
        subject: "IMAP提案",
        text: "IMAPから提案書を作って",
        message_id: "imap-thread",
        flags: ["\\Seen"]
      }]
    });
    const clients = [firstClient, secondClient];
    const configs: Array<Record<string, unknown>> = [];
    setGatewayEmailImapClientFactoryForTest(async (config) => {
      configs.push({ ...config, password: "[captured]" });
      const client = clients.shift();
      if (!client) {
        throw new Error("missing_fake_imap_client");
      }
      return client;
    });
    const { baseUrl } = await startTestServer();
    const imapUrl = `${baseUrl}/api/gateway/email/imap/poll`;

    const first = await postJson<{
      transport: { channel: string; transport: string; mailbox: string; mark_seen: boolean; message_count: number; skipped_count: number };
      messages: Array<{
        uid: string;
        adapter: { channel: string; source_identity: string; body_field: string; from?: string; to?: string; subject?: string; message_id?: string };
        inbound: { id: string; status: string; trusted: boolean; metadata: Record<string, unknown> };
        pairing: { id: string; status: string; session_key: string };
      }>;
    }>(imapUrl, {
      metadata: {
        request_id: "imap_req_1",
        authorization: "Bearer raw-secret-token"
      }
    });
    const firstMessage = first.messages[0];
    expect(firstMessage).toBeDefined();
    if (!firstMessage) {
      throw new Error("missing_first_imap_message");
    }
    await postJson<{ id: string; status: string }>(
      `${baseUrl}/api/gateway/pairings/${firstMessage.pairing.id}/approve`,
      {}
    );
    const second = await postJson<{
      transport: { channel: string; transport: string; mailbox: string; mark_seen: boolean; message_count: number; skipped_count: number };
      messages: Array<{
        uid: string;
        adapter: { channel: string; source_identity: string; body_field: string; from?: string; to?: string; subject?: string; message_id?: string };
        inbound: { id: string; status: string; trusted: boolean; body: string; metadata: Record<string, unknown>; session_key?: string };
        session: { session_key: string };
        chat: {
          backendRun: { status: string; metadata: Record<string, unknown> };
          messages: Array<{ role: string; content: string }>;
        };
      }>;
    }>(imapUrl, {
      mark_seen: true,
      output_locale: "ja",
      metadata: {
        request_id: "imap_req_2",
        cookie: "raw-secret-token"
      }
    });
    const secondMessage = second.messages[0];
    expect(secondMessage).toBeDefined();
    if (!secondMessage) {
      throw new Error("missing_second_imap_message");
    }

    const expectedSessionKey = "email:mailbox~3Aassistant~40example.test:message~3Aimap-thread";
    expect(configs).toEqual([
      expect.objectContaining({ host: "imap.example.test", port: 1993, secure: true, username: "assistant@example.test", mailbox: "Support", markSeen: false }),
      expect.objectContaining({ host: "imap.example.test", port: 1993, secure: true, username: "assistant@example.test", mailbox: "Support", markSeen: true })
    ]);
    expect(first.transport).toMatchObject({
      channel: "email",
      transport: "imap",
      mailbox: "Support",
      mark_seen: false,
      message_count: 1,
      skipped_count: 0
    });
    expect(firstMessage.adapter).toEqual({
      channel: "email",
      source_identity: "email:sender@example.test",
      body_field: "text",
      from: "sender@example.test",
      to: "assistant@example.test",
      subject: "IMAP初回",
      message_id: "imap-thread"
    });
    expect(firstMessage.inbound).toMatchObject({
      status: "blocked",
      trusted: false,
      metadata: {
        request_id: "imap_req_1",
        authorization: "[redacted]",
        gateway_email_adapter: true,
        gateway_email_imap_transport: true,
        gateway_email_imap_uid: "101",
        gateway_email_imap_mailbox: "Support"
      }
    });
    expect(firstMessage.pairing).toMatchObject({
      status: "pending",
      session_key: expectedSessionKey
    });
    expect(second.transport).toMatchObject({
      channel: "email",
      transport: "imap",
      mailbox: "Support",
      mark_seen: true,
      message_count: 1,
      skipped_count: 0
    });
    expectGatewayRoomAccessBlocked(secondMessage, expectedSessionKey);
    expect(secondMessage.inbound).toMatchObject({
      body: "Subject: IMAP提案\n\nIMAPから提案書を作って",
      metadata: {
        request_id: "imap_req_2",
        cookie: "[redacted]",
        gateway_email_adapter: true,
        gateway_email_imap_transport: true,
        gateway_email_imap_uid: "102",
        gateway_email_imap_mailbox: "Support",
        gateway_email_imap_flags: ["\\Seen"]
      }
    });
    expect(firstClient.closed).toBe(true);
    expect(secondClient.closed).toBe(true);
    expect(JSON.stringify([first, second])).not.toContain("raw-secret-token");
    expect(JSON.stringify([first, second])).not.toContain("imap-raw-password");
  });

  it("lists selectable agent backends", async () => {
    const { baseUrl } = await startTestServer();
    const session = await postJson<{ id: string }>(`${baseUrl}/api/chat/sessions`, {}, 201);

    const backends = await getJson<Array<{ id: string; configured: boolean }>>(`${baseUrl}/api/agent-backends?session_id=${session.id}`);

    expect(backends.map((backend) => backend.id)).toEqual(expect.arrayContaining(["samurai-native", "claude-code", "codex"]));
    expect(backends.find((backend) => backend.id === "samurai-native")?.configured).toBe(true);
  });

  it("rejects an unconfigured external backend before execution", async () => {
    setManagedEnv("SAMURAI_CLAUDE_CODE_COMMAND", "");
    setManagedEnv("SAMURAI_CLAUDE_CODE_ARGS", "");
    const { baseUrl } = await startTestServer();
    const session = await postJson<{ id: string }>(`${baseUrl}/api/chat/sessions`, {}, 201);

    const response = await postJson<{
      error: string;
      reason?: string;
      backendRun?: { backend_id: string; status: string; error_code?: string };
      backendEvents?: Array<{ event_type: string; payload: Record<string, unknown> }>;
    }>(
      `${baseUrl}/api/chat/sessions/${session.id}/messages`,
      {
        content: "Claude Codeで確認して",
        output_locale: "ja",
        backend_id: "claude-code"
      },
      409
    );

    expect(response).toMatchObject({
      error: "conflict",
      message: "backend_not_ready:command_not_configured"
    });
    expect(response.backendRun).toBeUndefined();
    expect(response.backendEvents).toBeUndefined();
  });

  it("returns session scoped artifacts and memory details", async () => {
    const { baseUrl } = await startTestServer();
    const sessionA = await postJson<{ id: string }>(`${baseUrl}/api/chat/sessions`, {}, 201);
    const sessionB = await postJson<{ id: string }>(`${baseUrl}/api/chat/sessions`, {}, 201);
    const turnA = await postJson<{ artifacts: Array<{ id: string }>; memories: Array<{ id: string; state: string }> }>(
      `${baseUrl}/api/chat/sessions/${sessionA.id}/messages`,
      {
        content: "提案書を作って、今後この文体を覚えて",
        output_locale: "ja"
      },
      201
    );
    await postJson(`${baseUrl}/api/chat/sessions/${sessionB.id}/messages`, {
      content: "別の提案書を作って",
      output_locale: "ja"
    }, 201);

    const detail = await getJson<{ artifacts: Array<{ id: string }>; memory: Array<{ id: string }> }>(`${baseUrl}/api/chat/sessions/${sessionA.id}`);
    const artifact = await getJson<Record<string, unknown>>(`${baseUrl}/api/artifacts/${turnA.artifacts[0]!.id}`);
    const memory = turnA.memories.find((item) => item.state === "topic")!;
    const memoryDetail = await getJson<Record<string, unknown>>(`${baseUrl}/api/memory/${memory.id}`);

    expect(detail.artifacts.map((item) => item.id)).toContain(turnA.artifacts[0]!.id);
    expect(detail.memory.map((item) => item.id)).toContain(memory.id);
    expect(artifact).toHaveProperty("operation");
    expect(artifact).toHaveProperty("auditRecords");
    expect(memoryDetail).toHaveProperty("memory");
    expect(memoryDetail).toHaveProperty("content");
  });

  it("archives memory through API and removes it from normal views", async () => {
    const { baseUrl } = await startTestServer();
    const session = await postJson<{ id: string }>(`${baseUrl}/api/chat/sessions`, {}, 201);
    const turn = await postJson<{ memories: Array<{ id: string; state: string }> }>(`${baseUrl}/api/chat/sessions/${session.id}/messages`, {
      content: "提案書を作って、今後この文体を覚えて",
      output_locale: "ja"
    }, 201);
    const memory = turn.memories.find((item) => item.state === "topic")!;

    const archived = await postJson<Record<string, unknown>>(`${baseUrl}/api/memory/${memory.id}/archive`, {
      session_id: session.id
    });
    const allMemory = await getJson<Array<{ id: string }>>(`${baseUrl}/api/memory?session_id=${session.id}`);
    const detail = await getJson<{ memory: Array<{ id: string }> }>(`${baseUrl}/api/chat/sessions/${session.id}`);
    const badRequest = await postJson<Record<string, unknown>>(`${baseUrl}/api/memory/${memory.id}/archive`, {}, 400);

    expect(archived).toHaveProperty("operation");
    expect(archived).not.toHaveProperty("auditRecord");
    expect(archived).toHaveProperty("activity");
    expect(archived).toHaveProperty("rollbackPoint");
    expect(allMemory.some((item) => item.id === memory.id)).toBe(false);
    expect(detail.memory.some((item) => item.id === memory.id)).toBe(false);
    expect(badRequest.error).toBe("session_id_required");
  });

  it("restores a file rollback point through API", async () => {
    const { baseUrl } = await startTestServer();
    const session = await postJson<{ id: string }>(`${baseUrl}/api/chat/sessions`, {}, 201);

    await postJson<{ rollbackPoint: { id: string } }>(`${baseUrl}/api/tools/file`, {
      operation: "file.write",
      path: "notes/api-restore.md",
      content: "hello",
      session_id: session.id
    });
    const patched = await postJson<{ rollbackPoint: { id: string }; resource: { content: string } }>(`${baseUrl}/api/tools/file`, {
      operation: "file.patch",
      path: "notes/api-restore.md",
      search: "hello",
      replace: "hello api",
      session_id: session.id
    });
    const restored = await postJson<{
      resource: { rollback_point_id: string; path: string; action: string };
      operation: { operation: string };
      auditRecord: { rollback_point_id?: string };
      rollbackPoint: { id: string };
    }>(`${baseUrl}/api/rollback/${patched.rollbackPoint.id}/restore?session_id=${session.id}`, {}, 201);
    const read = await postJson<{ resource: { content: string } }>(`${baseUrl}/api/tools/file`, {
      operation: "file.read",
      path: "notes/api-restore.md",
      session_id: session.id
    });

    expect(patched.resource.content).toBe("hello api");
    expect(restored.operation.operation).toBe("rollback.restore");
    expect(restored.resource).toMatchObject({
      rollback_point_id: patched.rollbackPoint.id,
      path: "notes/api-restore.md",
      action: "written"
    });
    expect(restored).not.toHaveProperty("auditRecord");
    expect(read.resource.content).toBe("hello");
  });

  it("returns enriched search results", async () => {
    const { baseUrl } = await startTestServer();
    const session = await postJson<{ id: string }>(`${baseUrl}/api/chat/sessions`, {}, 201);
    const turn = await postJson<{ artifacts: Array<{ id: string }> }>(
      `${baseUrl}/api/chat/sessions/${session.id}/messages`,
      {
        content: "検索用の提案書を作って",
        output_locale: "ja"
      },
      201
    );

    const messageResults = await getJson<Array<{ kind: string; session_id?: string }>>(`${baseUrl}/api/search?session_id=${session.id}&q=${encodeURIComponent("検索用")}`);
    const artifactResults = await getJson<Array<{ kind: string; id: string; session_id?: string; operation_id?: string }>>(
      `${baseUrl}/api/search?session_id=${session.id}&q=${encodeURIComponent("提案")}`
    );
    const emptyResults = await getJson<unknown[]>(`${baseUrl}/api/search?session_id=${session.id}&q=${encodeURIComponent("   ")}`);

    expect(messageResults.some((result) => result.kind === "message" && result.session_id === session.id)).toBe(true);
    expect(
      artifactResults.some((result) => result.kind === "artifact" && result.id === turn.artifacts[0]!.id && result.session_id === session.id && result.operation_id)
    ).toBe(true);
    expect(emptyResults).toEqual([]);
  });

  it("returns sanitized provider diagnostics without raw provider messages", async () => {
    const { baseUrl } = await startTestServer(new FailingProviderAdapter());
    const session = await postJson<{ id: string }>(`${baseUrl}/api/chat/sessions`, {}, 201);

    const response = await postJson<Record<string, unknown>>(`${baseUrl}/api/chat/sessions/${session.id}/messages`, {
      content: "こんにちは",
      output_locale: "ja"
    }, 502);

    expect(response).toMatchObject({
      error: "provider_failed",
      reason: "auth_failed",
      provider: "fake",
      model: "fake/failing",
      status: 401,
      retryable: false
    });
    expect(JSON.stringify(response)).not.toContain("secret-token");
    expect(JSON.stringify(response)).not.toContain("sk-test-secret");
    expect(JSON.stringify(response)).not.toContain("raw-password");
    expect(response).not.toHaveProperty("message");
  });

  it("persists settings through get and patch", async () => {
    const { baseUrl } = await startTestServer();

    const initial = await getJson<{
      ui_locale: string;
      output_locale: string;
      memory_capture_mode: string;
      knowledge_wiki_capture_mode: string;
      external_assist_config: { configured: boolean; source: string; provider_kind: string | null; errors: string[] };
    }>(`${baseUrl}/api/settings`);
    const patched = await patchJson<{
      ui_locale: string;
      output_locale: string;
      memory_capture_mode: string;
      knowledge_wiki_capture_mode: string;
      external_provider_role: string;
      external_assist_config: { configured: boolean; source: string };
    }>(`${baseUrl}/api/settings`, {
      ui_locale: "en",
      output_locale: "fr",
      memory_capture_mode: "manual",
      knowledge_wiki_capture_mode: "manual",
      external_provider_role: "disabled",
      ignored: "value"
    });
    const legacyPatched = await patchJson<{ knowledge_wiki_capture_mode: string }>(`${baseUrl}/api/settings`, {
      llm_wiki_capture_mode: "off"
    });
    const priorityPatched = await patchJson<{ knowledge_wiki_capture_mode: string }>(`${baseUrl}/api/settings`, {
      llm_wiki_capture_mode: "off",
      knowledge_wiki_capture_mode: "auto"
    });
    const persisted = await getJson<{
      ui_locale: string;
      output_locale: string;
      memory_capture_mode: string;
      knowledge_wiki_capture_mode: string;
      external_provider_role: string;
    }>(`${baseUrl}/api/settings`);
    const invalidPatch = await patchJson<{ ui_locale: string; output_locale: string }>(`${baseUrl}/api/settings`, {
      ui_locale: "xx"
    });
    const invalidCapture = await patchJson<{ error: string; field: string }>(
      `${baseUrl}/api/settings`,
      {
        memory_capture_mode: "always"
      },
      400
    );

    expect(initial).toMatchObject({ ui_locale: "ja", output_locale: "ja", memory_capture_mode: "auto", knowledge_wiki_capture_mode: "auto" });
    expect(initial.external_assist_config).toMatchObject({
      configured: false,
      source: "none",
      provider_kind: null,
      errors: []
    });
    expect(patched).toMatchObject({
      ui_locale: "en",
      output_locale: "fr",
      memory_capture_mode: "manual",
      knowledge_wiki_capture_mode: "manual",
      external_provider_role: "disabled"
    });
    expect(patched.external_assist_config).toMatchObject({
      configured: false,
      source: "none"
    });
    expect(legacyPatched).toMatchObject({ knowledge_wiki_capture_mode: "off" });
    expect(priorityPatched).toMatchObject({ knowledge_wiki_capture_mode: "auto" });
    expect(persisted).toMatchObject({
      ui_locale: "en",
      output_locale: "fr",
      memory_capture_mode: "manual",
      knowledge_wiki_capture_mode: "auto",
      external_provider_role: "disabled"
    });
    expect(invalidPatch).toMatchObject({ ui_locale: "en", output_locale: "fr" });
    expect(invalidCapture).toEqual({ error: "invalid_capture_mode", field: "memory_capture_mode" });
  });

  it("exposes Skill diagnostics for selectable lifecycle readiness", async () => {
    const { baseUrl } = await startTestServer();
    const session = await postJson<{ id: string }>(`${baseUrl}/api/chat/sessions`, {}, 201);
    const candidate = await postJson<{ resource: { id: string } }>(
      `${baseUrl}/api/skills/candidates?session_id=${session.id}`,
      {
        title: "Diagnostic Skill",
        description: "Selectable Skill diagnostics test",
        content: "# Diagnostic Skill\n\nUse this to check selectable readiness."
      },
      201
    );
    const project = await postJson<{ resource: { id: string; state: string } }>(
      `${baseUrl}/api/skills/projects?session_id=${session.id}`,
      { candidate_id: candidate.resource.id },
      201
    );
    await postJson<{ resource: { path: string; content: string } }>(
      `${baseUrl}/api/skills/${project.resource.id}/support?session_id=${session.id}`,
      {
        path: "references/style.md",
        content: "Keep diagnostics concise."
      },
      201
    );

    const diagnostics = await getJson<{
      total_skills: number;
      selectable_skills: number;
      state_counts: Record<string, number>;
      selectable_with_verified_provenance: number;
      selectable_with_source_refs: number;
      selectable_with_support_files: number;
      selectable_with_usage: number;
      empty_support_files: number;
      issues: Array<{ code: string; severity: string; skill_id: string; state: string }>;
      recommendation: string;
    }>(`${baseUrl}/api/skills/diagnostics?session_id=${session.id}`);

    expect(diagnostics.total_skills).toBe(2);
    expect(diagnostics.selectable_skills).toBe(1);
    expect(diagnostics.state_counts.candidate).toBe(1);
    expect(diagnostics.state_counts.project).toBe(1);
    expect(diagnostics.selectable_with_verified_provenance).toBe(0);
    expect(diagnostics.selectable_with_source_refs).toBe(0);
    expect(diagnostics.selectable_with_support_files).toBe(1);
    expect(diagnostics.selectable_with_usage).toBe(0);
    expect(diagnostics.empty_support_files).toBe(0);
    expect(diagnostics.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "selectable_skill_unverified_provenance",
        severity: "warning",
        skill_id: project.resource.id,
        state: "project"
      }),
      expect.objectContaining({
        code: "selectable_skill_missing_source_refs",
        severity: "warning",
        skill_id: project.resource.id,
        state: "project"
      })
    ]));
    expect(diagnostics.issues).not.toContainEqual(expect.objectContaining({
      code: "selectable_skill_empty_markdown"
    }));
    expect(diagnostics.recommendation).toContain("Review Skill provenance");
  });

  it("serves minimal skill collection and automation backend routes", async () => {
    const { baseUrl } = await startTestServer();
    const session = await postJson<{ id: string }>(`${baseUrl}/api/chat/sessions`, {}, 201);
    const candidate = await postJson<{ resource: { id: string }; operation: { operation: string }; rollbackPoint?: unknown }>(
      `${baseUrl}/api/skills/candidates?session_id=${session.id}`,
      {
        title: "調査メモ",
        description: "調査メモを整える",
        content: "# Skill"
      },
      201
    );
    const project = await postJson<{ resource: { id: string }; operation: { operation: string } }>(
      `${baseUrl}/api/skills/projects?session_id=${session.id}`,
      { candidate_id: candidate.resource.id },
      201
    );
    const support = await postJson<{ resource: { path: string; content: string }; operation: { operation: string }; rollbackPoint: unknown }>(
      `${baseUrl}/api/skills/${project.resource.id}/support?session_id=${session.id}`,
      {
        path: "references/style.md",
        content: "補助資料"
      },
      201
    );
    const skills = await getJson<Array<{ id: string }>>(`${baseUrl}/api/skills?session_id=${session.id}`);
    const skillDetail = await getJson<{ markdown: string; supportFiles: Array<{ path: string; content: string }> }>(`${baseUrl}/api/skills/${project.resource.id}?session_id=${session.id}`);
    const supportFiles = await getJson<Array<{ path: string; content: string }>>(`${baseUrl}/api/skills/${project.resource.id}/support?session_id=${session.id}`);

    const schema = await postJson<{ resource: { id: string }; operation: { operation: string } }>(
      `${baseUrl}/api/collections/schemas?session_id=${session.id}`,
      {
        ...collectionSchema("contacts"),
        actions: [{ id: "rename", kind: "patch_record", changes: { name: "Action API" } }]
      },
      201
    );
    const record = await postJson<{ resource: { id: string; data: { name: string } }; operation: { operation: string } }>(
      `${baseUrl}/api/collections/contacts/records?session_id=${session.id}`,
      { id: "record_1", data: { name: "Takuma" } },
      201
    );
    const patched = await postJson<{ resource: { data: { name: string } }; operation: { operation: string } }>(
      `${baseUrl}/api/collections/contacts/records/record_1/patches?session_id=${session.id}`,
      { expected_version: 1, changes: { name: "Samurai" } }
    );
    const action = await postJson<{ resource: { data: { name: string } }; operation: { operation: string } }>(
      `${baseUrl}/api/collections/contacts/actions/rename/run?session_id=${session.id}`,
      { record_id: "record_1" }
    );
    const savedSchema = await getJson<{ id: string }>(`${baseUrl}/api/collections/contacts/schema?session_id=${session.id}`);
    const notes = await getJson<unknown[]>(`${baseUrl}/api/collections/contacts/notes?session_id=${session.id}`);
    const reindex = await postJson<{ resource: { schemas: { indexed: number }; records: { indexed: number } }; operation: { operation: string } }>(
      `${baseUrl}/api/collections/reindex?session_id=${session.id}`,
      {}
    );
    const sourceRef = { kind: "artifact", id: "artifact_translation", uri: "artifacts/artifact_translation.md" };
    const recordSourceRef = { kind: "collection_record", id: "record_1", uri: "collections/contacts/records/record_1.json", label: "contacts/record_1" };
    const recordSourceText = JSON.stringify({ name: "Action API" }, null, 2);
    const translation = await postJson<{ status: string; translated_text: string }>(
      `${baseUrl}/api/resource-translations?session_id=${session.id}`,
      {
        source_ref: sourceRef,
        source_locale: "ja",
        target_locale: "en",
        status: "verified",
        original_hash: "hash_original",
        translated_text: "Translated artifact"
      },
      201
    );
    const recordTranslation = await postJson<{ status: string; translated_text: string }>(
      `${baseUrl}/api/resource-translations?session_id=${session.id}`,
      {
        source_ref: recordSourceRef,
        source_locale: "ja",
        target_locale: "en",
        status: "verified",
        original_hash: stableHash(recordSourceText),
        translated_text: "Translated collection record"
      },
      201
    );
    const recordDetail = await getJson<{ data: { name: string }; translation_resolution?: { source: string; text: string; status: string }; locale: { original_hash: string } }>(
      `${baseUrl}/api/collections/contacts/records/record_1?target_locale=en&session_id=${session.id}`
    );
    const viewWrite = await putJson<{ written: string[]; rejected: unknown[] }>(
      `${baseUrl}/api/collections/contacts/view-data?session_id=${session.id}`,
      { items: [{ id: "record_1", name: "View API" }], mode: "merge" }
    );
    const viewRead = await getJson<{ action: string; collection_id: string; items: Array<{ id: string; name: string }> }>(
      `${baseUrl}/api/collections/contacts/view-data?fields=name&session_id=${session.id}`
    );
    const translationJob = await postJson<{ resource: { id: string; kind: string; delivery_target: { target_locale: string } }; operation: { operation: string } }>(
      `${baseUrl}/api/resource-translations/jobs?session_id=${session.id}`,
      {
        source_ref: recordSourceRef,
        source_locale: "ja",
        target_locale: "fr",
        title: "Translate contact record",
        schedule: "once"
      },
      201
    );
    const translationRuns = await postJson<Array<{ automationRun: { status: string; backend_run_id?: string } }>>(
      `${baseUrl}/api/automation/jobs/run-due?room_id=room_default`,
      {},
      201
    );
    const generatedTranslations = await getJson<Array<{ translated_text: string; target_locale: string; status: string }>>(
      `${baseUrl}/api/resource-translations?source_kind=collection_record&source_id=record_1&source_uri=collections/contacts/records/record_1.json&target_locale=fr&session_id=${session.id}`
    );
    const resolvedTranslation = await postJson<{ source: string; text: string; status: string }>(
      `${baseUrl}/api/resource-translations/resolve`,
      {
        source_ref: sourceRef,
        target_locale: "en",
        original_hash: "hash_original",
        fallback_text: "原文",
        session_id: session.id
      }
    );
    const resolvedFallback = await postJson<{ source: string; text: string; status: string }>(
      `${baseUrl}/api/resource-translations/resolve`,
      {
        source_ref: sourceRef,
        target_locale: "en",
        original_hash: "hash_changed",
        fallback_text: "原文",
        session_id: session.id
      }
    );
    const translations = await getJson<Array<{ translated_text: string }>>(
      `${baseUrl}/api/resource-translations?source_kind=artifact&source_id=artifact_translation&source_uri=artifacts/artifact_translation.md&target_locale=en&session_id=${session.id}`
    );
    const automation = await postJson<{ automationRun: { status: string }; operation: { actor_identity: string; channel: string; input_ref: { kind: string } }; memoryReviewTrace: unknown }>(
      `${baseUrl}/api/automation/memory-review/run?room_id=room_default`,
      {},
      201
    );

    expect(candidate.operation.operation).toBe("skill.candidate.create");
    expect(project.operation.operation).toBe("skill.project.save");
    expect(support.operation.operation).toBe("skill.support_file.save");
    expect(support.resource).toMatchObject({ path: "references/style.md", content: "補助資料" });
    expect(support).toHaveProperty("rollbackPoint");
    expect(skills.map((skill) => skill.id)).toContain(candidate.resource.id);
    expect(skillDetail.markdown).toContain("調査メモ");
    expect(skillDetail.supportFiles).toContainEqual(expect.objectContaining({ path: "references/style.md", content: "補助資料" }));
    expect(supportFiles).toContainEqual(expect.objectContaining({ path: "references/style.md", content: "補助資料" }));
    expect(schema.operation.operation).toBe("collection.schema.save");
    expect(record.operation.operation).toBe("collection.record.create");
    expect(patched.operation.operation).toBe("collection.patch.apply");
    expect(patched.resource.data.name).toBe("Samurai");
    expect(action.operation.operation).toBe("collection.action.run");
    expect(action.resource.data.name).toBe("Action API");
    expect(savedSchema.id).toBe("contacts");
    expect(notes).toEqual([]);
    expect(reindex).toMatchObject({ operation: { operation: "collection.reindex" }, resource: { schemas: { indexed: 1 }, records: { indexed: 1 } } });
    expect(translation).toMatchObject({ status: "verified", translated_text: "Translated artifact" });
    expect(recordTranslation).toMatchObject({ status: "verified", translated_text: "Translated collection record" });
    expect(recordDetail.data.name).toBe("Action API");
    expect(recordDetail.locale.original_hash).toBe(stableHash(recordSourceText));
    expect(recordDetail.translation_resolution).toMatchObject({ source: "translation", status: "verified", text: "Translated collection record" });
    expect(viewWrite).toMatchObject({ written: ["record_1"], rejected: [] });
    expect(viewRead).toMatchObject({ action: "getItems", collection_id: "contacts", items: [expect.objectContaining({ id: "record_1", name: "View API" })] });
    expect(translationJob.resource).toMatchObject({ kind: "resource_translation", delivery_target: { target_locale: "fr" } });
    expect(translationJob.operation.operation).toBe("automation.job.save");
    expect(translationRuns).toContainEqual(expect.objectContaining({ automationRun: expect.objectContaining({ status: "completed" }) }));
    expect(generatedTranslations).toContainEqual(expect.objectContaining({ target_locale: "fr", status: "draft", translated_text: "対応しました。" }));
    expect(resolvedTranslation).toMatchObject({ source: "translation", status: "verified", text: "Translated artifact" });
    expect(resolvedFallback).toMatchObject({ source: "fallback", status: "missing", text: "原文" });
    expect(translations).toContainEqual(expect.objectContaining({ translated_text: "Translated artifact" }));
    expect(automation.automationRun.status).toBe("completed");
    expect(automation.operation).toMatchObject({ actor_identity: "owner_scheduled", channel: "cron" });
    expect(automation.operation.input_ref.kind).toBe("automation_run");
  });

  it("serves wiki proposal lifecycle through runtime operations", async () => {
    const { baseUrl } = await startTestServer();
    const session = await postJson<{ id: string }>(`${baseUrl}/api/chat/sessions`, {}, 201);
    const proposal = await postJson<{
      resource: { id: string; state: string; file_path: string; source_refs: Array<{ kind: string; id: string }> };
      operation: { operation: string };
      rollbackPoint: { id: string };
      activity: unknown[];
    }>(
      `${baseUrl}/api/wiki/proposals?session_id=${session.id}`,
      {
        title: "Provider保存設計",
        slug: "provider-storage-plan",
        content: "# Provider保存設計\n\npatched-contract-needle",
        tags: ["memory"],
        source_refs: [{
          kind: "memory",
          id: "memory_provider_policy",
          uri: "memory/topic/memory_provider_policy.md",
          label: "Provider policy memory"
        }]
      },
      201
    );
    const rejectedProposal = await postJson<{
      resource: { id: string; state: string };
      operation: { operation: string };
      rollbackPoint: { id: string };
    }>(
      `${baseUrl}/api/wiki/proposals?session_id=${session.id}`,
      {
        title: "却下するWiki",
        slug: "rejected-wiki-contract",
        content: "# 却下するWiki\n\npatched-contract-needle"
      },
      201
    );
    const listed = await getJson<Array<{ id: string; state: string }>>(`${baseUrl}/api/wiki?session_id=${session.id}`);
    const detail = await getJson<{ content: string }>(`${baseUrl}/api/wiki/${proposal.resource.id}?session_id=${session.id}`);
    const accepted = await postJson<{
      resource: { state: string };
      operation: { operation: string };
      rollbackPoint: { id: string };
    }>(
      `${baseUrl}/api/wiki/${proposal.resource.id}/accept?session_id=${session.id}`,
      {}
    );
    const patched = await patchJson<{
      resource: { title: string; source_refs: Array<{ kind: string; id: string }> };
      operation: { operation: string };
      rollbackPoint: { id: string };
    }>(`${baseUrl}/api/wiki/${proposal.resource.id}?session_id=${session.id}`, {
      title: "保存設計",
      source_refs: [{
        kind: "backend_run",
        id: "run_provider_policy",
        uri: "backend-runs/run_provider_policy",
        label: "Backend run source"
      }]
    });
    const rejected = await postJson<{
      resource: { state: string };
      operation: { operation: string };
      rollbackPoint: { id: string };
    }>(
      `${baseUrl}/api/wiki/${rejectedProposal.resource.id}/reject?session_id=${session.id}`,
      {}
    );
    const activeRetrieval = await getJson<{
      knowledge_wiki: Array<{
        id: string;
        source_refs: Array<{ kind: string; id: string }>;
        provenance: { kind: string; verified: boolean };
      }>;
      report: { excluded: Array<{ id: string; reason: string }>; included_wiki_ids: string[] };
      graph: { nodes: Array<{ id: string; source_ref_count: number }>; edges: Array<{ from_wiki_id: string; relation: string }> };
    }>(`${baseUrl}/api/wiki/active-retrieval?session_id=${session.id}&q=patched-contract-needle`);
    const reindex = await postJson<{
      resource: { active: number; total: number; files: number; indexed: number; errors: unknown[] };
      operation: { operation: string };
    }>(`${baseUrl}/api/wiki/reindex?session_id=${session.id}`, {});
    const archived = await postJson<{
      resource: { state: string };
      operation: { operation: string };
      rollbackPoint: { id: string };
    }>(
      `${baseUrl}/api/wiki/${proposal.resource.id}/archive?session_id=${session.id}`,
      {}
    );
    const afterArchiveRetrieval = await getJson<{
      knowledge_wiki: Array<{ id: string }>;
      report: { excluded: Array<{ id: string; reason: string }> };
    }>(`${baseUrl}/api/wiki/active-retrieval?session_id=${session.id}&q=patched-contract-needle`);

    expect(proposal.operation.operation).toBe("wiki.proposal.create");
    expect(proposal).not.toHaveProperty("policyDecision");
    expect(proposal.resource).toMatchObject({ state: "proposed", file_path: "wiki/pages/provider-storage-plan.md" });
    expect(proposal.resource.source_refs).toContainEqual(expect.objectContaining({ kind: "memory", id: "memory_provider_policy" }));
    expect(proposal).not.toHaveProperty("auditRecord");
    expect(proposal.activity).toEqual([]);
    expect(listed.map((item) => item.id)).toEqual(expect.arrayContaining([proposal.resource.id, rejectedProposal.resource.id]));
    expect(detail.content).toBe("# Provider保存設計\n\npatched-contract-needle");
    expect(accepted).toMatchObject({ resource: { state: "active" }, operation: { operation: "wiki.accept" } });
    expect(patched).toMatchObject({ resource: { title: "保存設計" }, operation: { operation: "wiki.patch" } });
    expect(patched.resource.source_refs).toContainEqual(expect.objectContaining({ kind: "backend_run", id: "run_provider_policy" }));
    expect(rejected).toMatchObject({ resource: { state: "rejected" }, operation: { operation: "wiki.reject" } });
    expect(activeRetrieval.knowledge_wiki.map((wiki) => wiki.id)).toContain(proposal.resource.id);
    expect(activeRetrieval.knowledge_wiki.map((wiki) => wiki.id)).not.toContain(rejectedProposal.resource.id);
    expect(activeRetrieval.knowledge_wiki.find((wiki) => wiki.id === proposal.resource.id)?.provenance).toMatchObject({
      kind: "user_authored",
      verified: true
    });
    expect(activeRetrieval.report.excluded).toContainEqual(expect.objectContaining({ id: rejectedProposal.resource.id, reason: "rejected" }));
    expect(activeRetrieval.graph.nodes).toContainEqual(expect.objectContaining({ id: proposal.resource.id, source_ref_count: 1 }));
    expect(activeRetrieval.graph.edges).toContainEqual(expect.objectContaining({ from_wiki_id: proposal.resource.id, relation: "source_ref" }));
    expect(reindex.resource).toMatchObject({ active: 1, total: 2, files: 2, indexed: 2, errors: [] });
    expect(reindex).toMatchObject({ operation: { operation: "wiki.reindex" } });
    expect(reindex).not.toHaveProperty("auditRecord");
    expect(archived).toMatchObject({ resource: { state: "archived" }, operation: { operation: "wiki.archive" } });
    expect(afterArchiveRetrieval.knowledge_wiki).toEqual([]);
    expect(afterArchiveRetrieval.report.excluded).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: proposal.resource.id, reason: "archived" }),
      expect.objectContaining({ id: rejectedProposal.resource.id, reason: "rejected" })
    ]));
  });

  it("exposes Knowledge Wiki diagnostics for active evidence readiness", async () => {
    const { baseUrl } = await startTestServer();
    const session = await postJson<{ id: string }>(`${baseUrl}/api/chat/sessions`, {}, 201);
    const proposal = await postJson<{
      resource: { id: string };
    }>(
      `${baseUrl}/api/wiki/proposals?session_id=${session.id}`,
      {
        title: "Unverified provider note",
        slug: "unverified-provider-note",
        content: "# Unverified provider note\n\nactive-evidence-diagnostic-needle",
        source_refs: [],
        provenance: {
          kind: "external_provider",
          summary: "Imported from an unverified provider fixture.",
          provider: "fixture",
          verified: false
        }
      },
      201
    );
    await postJson<{ resource: { state: string } }>(
      `${baseUrl}/api/wiki/${proposal.resource.id}/accept?session_id=${session.id}`,
      {}
    );

    const diagnostics = await getJson<{
      total_pages: number;
      active_pages: number;
      state_counts: Record<string, number>;
      active_with_provenance: number;
      active_with_verified_provenance: number;
      active_with_source_refs: number;
      active_empty_pages: number;
      issues: Array<{ code: string; severity: string; wiki_id: string; state: string }>;
      recommendation: string;
    }>(`${baseUrl}/api/wiki/diagnostics?session_id=${session.id}`);

    expect(diagnostics.total_pages).toBe(1);
    expect(diagnostics.active_pages).toBe(1);
    expect(diagnostics.state_counts.active).toBe(1);
    expect(diagnostics.active_with_provenance).toBe(1);
    expect(diagnostics.active_with_verified_provenance).toBe(0);
    expect(diagnostics.active_with_source_refs).toBe(0);
    expect(diagnostics.active_empty_pages).toBe(0);
    expect(diagnostics.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "active_wiki_unverified_provenance",
        severity: "warning",
        wiki_id: proposal.resource.id,
        state: "active"
      }),
      expect.objectContaining({
        code: "active_wiki_missing_source_refs",
        severity: "warning",
        wiki_id: proposal.resource.id,
        state: "active"
      })
    ]));
    expect(diagnostics.issues).not.toContainEqual(expect.objectContaining({
      code: "active_wiki_retrieval_includes_non_active"
    }));
    expect(diagnostics.recommendation).toContain("Review Knowledge Wiki provenance");
  });

  it("serves curator lifecycle reports and applies skill actions through API", async () => {
    const { baseUrl } = await startTestServer();
    const session = await postJson<{ id: string }>(`${baseUrl}/api/chat/sessions`, {}, 201);
    const candidate = await postJson<{ resource: { id: string } }>(
      `${baseUrl}/api/skills/candidates?session_id=${session.id}`,
      {
        title: "Curator API Skill",
        description: "Curator API lifecycle test",
        content: "# Curator API Skill"
      },
      201
    );
    const project = await postJson<{ resource: { id: string; state: string } }>(
      `${baseUrl}/api/skills/projects?session_id=${session.id}`,
      { candidate_id: candidate.resource.id },
      201
    );
    const beforeDiagnostics = await getJson<{
      total_curator_runs: number;
      curator_state: { paused: boolean };
      issues: Array<{ code: string; severity: string }>;
      recommendation: string;
    }>(`${baseUrl}/api/reflection/diagnostics?session_id=${session.id}&limit=10`);

    const curator = await postJson<{
      reflectionRun: { id: string; kind: string; status: string };
      curatorReport: {
        dry_run: boolean;
        skill_actions: Array<{ skill_id: string; action: string }>;
        protected_skills: unknown[];
      };
      curatorReviewReport: {
        dry_run: boolean;
        skill_consolidation_groups: unknown[];
        wiki_patch_proposals: unknown[];
      };
  }>(`${baseUrl}/api/curator/run?session_id=${session.id}`, {}, 201);
    const afterDiagnostics = await getJson<{
      total_curator_runs: number;
      completed_curator_runs: number;
      pending_curator_suggestions: number;
      latest_curator_run?: { id: string; kind: string; status: string };
      status_counts: { curator_runs: Record<string, number>; suggestions: Record<string, number>; suggestion_types: Record<string, number> };
      issues: Array<{ code: string; severity: string }>;
    }>(`${baseUrl}/api/reflection/diagnostics?session_id=${session.id}&limit=10`);
    const invalidReview = await postJson<Record<string, unknown>>(
      `${baseUrl}/api/curator/skill-actions/apply`,
      { session_id: session.id, skill_id: project.resource.id, action: "review" },
      400
    );
    const applied = await postJson<{
      resource: { id: string; state: string };
      operation: { operation: string };
      rollbackPoint: { id: string };
    }>(
      `${baseUrl}/api/curator/skill-actions/apply`,
      { session_id: session.id, skill_id: project.resource.id, action: "mark_stale" }
    );
    const detail = await getJson<{ skill: { state: string }; markdown: string }>(`${baseUrl}/api/skills/${project.resource.id}?session_id=${session.id}`);

    expect(project.resource.state).toBe("project");
    expect(beforeDiagnostics.total_curator_runs).toBe(0);
    expect(beforeDiagnostics.curator_state.paused).toBe(false);
    expect(beforeDiagnostics.issues).toContainEqual(expect.objectContaining({
      code: "curator_run_missing",
      severity: "warning"
    }));
    expect(beforeDiagnostics.recommendation).toContain("Run Reflection / Curator jobs");
    expect(curator.curatorReport).toMatchObject({ dry_run: true });
    expect(curator.curatorReviewReport).toMatchObject({ dry_run: true });
    expect(curator.curatorReport.skill_actions).toEqual([]);
    expect(afterDiagnostics.total_curator_runs).toBe(1);
    expect(afterDiagnostics.completed_curator_runs).toBe(1);
    expect(afterDiagnostics.pending_curator_suggestions).toBe(0);
    expect(afterDiagnostics.latest_curator_run).toMatchObject({
      id: curator.reflectionRun.id,
      kind: "curator",
      status: "completed"
    });
    expect(afterDiagnostics.status_counts.curator_runs.completed).toBe(1);
    expect(afterDiagnostics.status_counts.suggestions.proposed ?? 0).toBe(0);
    expect(afterDiagnostics.issues).not.toContainEqual(expect.objectContaining({ code: "curator_suggestion_pending" }));
    expect(afterDiagnostics.issues).not.toContainEqual(expect.objectContaining({ code: "curator_run_missing" }));
    expect(invalidReview.error).toBe("invalid_curator_skill_action");
    expect(applied).toMatchObject({
      resource: { id: project.resource.id, state: "stale" },
      operation: { operation: "skill.lifecycle.apply" }
    });
    expect(applied.rollbackPoint.id).toBeTruthy();
    expect(detail.skill.state).toBe("stale");
    expect(detail.markdown).toContain('"state": "stale"');
  });

  it("serves evaluation trace reports through API", async () => {
    const { baseUrl } = await startTestServer();
    const session = await postJson<{ id: string }>(`${baseUrl}/api/chat/sessions`, {}, 201);
    const turn = await postJson<{ backendRun: { id: string } }>(`${baseUrl}/api/chat/sessions/${session.id}/messages`, {
      content: "提案書を作って",
      output_locale: "ja"
    }, 201);
    const beforeDiagnostics = await getJson<{
      total_evaluation_runs: number;
      backend_runs: number;
      issues: Array<{ code: string; severity: string }>;
      recommendation: string;
    }>(`${baseUrl}/api/evaluation/diagnostics?session_id=${session.id}&stale_after_hours=1&limit=10`);

    const evaluation = await postJson<{
      reflectionRun: { id: string; kind: string; status: string };
      suggestions: Array<{ suggestion_type: string; source_refs: unknown[] }>;
      evaluationReport: {
        judge: { deterministic_status: string; external_status: string };
        counts: { backend_runs: number; findings: number; comparisons: number };
        run_scores: Array<{
          run_id: string;
          score: number;
          verdict: string;
          findings: unknown[];
          suggested_improvements: string[];
        }>;
        comparisons: Array<{ current_run_id: string; result: string }>;
      };
    }>(`${baseUrl}/api/evaluation/run`, { session_id: session.id }, 201);
    const afterDiagnostics = await getJson<{
      total_evaluation_runs: number;
      completed_evaluation_runs: number;
      backend_runs: number;
      latest_evaluation_run?: { id: string; kind: string; status: string };
      status_counts: { evaluation_runs: Record<string, number>; backend_runs: Record<string, number> };
      issues: Array<{ code: string; severity: string }>;
    }>(`${baseUrl}/api/evaluation/diagnostics?session_id=${session.id}&stale_after_hours=1&limit=10`);

    expect(beforeDiagnostics.total_evaluation_runs).toBe(0);
    expect(beforeDiagnostics.backend_runs).toBeGreaterThan(0);
    expect(beforeDiagnostics.issues).toContainEqual(expect.objectContaining({
      code: "evaluation_run_missing",
      severity: "warning"
    }));
    expect(beforeDiagnostics.recommendation).toContain("Run the evaluation job");
    expect(evaluation.reflectionRun).toMatchObject({ kind: "evaluation", status: "completed" });
    expect(evaluation.evaluationReport.judge).toMatchObject({
      deterministic_status: "completed",
      external_status: "not_configured"
    });
    expect(evaluation.evaluationReport.counts.backend_runs).toBe(0);
    expect(evaluation.evaluationReport.run_scores).toEqual([]);
    expect(evaluation.evaluationReport.comparisons.length).toBe(evaluation.evaluationReport.counts.comparisons);
    expect(evaluation.suggestions.length).toBeGreaterThanOrEqual(0);
    expect(afterDiagnostics.total_evaluation_runs).toBe(0);
    expect(afterDiagnostics.completed_evaluation_runs).toBe(0);
    expect(afterDiagnostics.latest_evaluation_run).toBeUndefined();
    expect(afterDiagnostics.status_counts.evaluation_runs.completed ?? 0).toBe(0);
    expect(afterDiagnostics.status_counts.backend_runs.completed).toBeGreaterThan(0);
    expect(afterDiagnostics.issues).toContainEqual(expect.objectContaining({ code: "evaluation_run_missing" }));
  });

  it("rejects invalid skill and collection writes through API", async () => {
    const { baseUrl } = await startTestServer();
    const session = await postJson<{ id: string }>(`${baseUrl}/api/chat/sessions`, {}, 201);

    const badSkill = await postJson<Record<string, unknown>>(`${baseUrl}/api/skills/candidates?session_id=${session.id}`, { title: "", description: "" }, 400);
    await postJson(`${baseUrl}/api/collections/schemas?session_id=${session.id}`, collectionSchema("contacts"), 201);
    const badRecord = await postJson<Record<string, unknown>>(
      `${baseUrl}/api/collections/contacts/records?session_id=${session.id}`,
      { id: "record_bad", data: { unknown: true } },
      409
    );

    expect(badSkill.error).toBe("title_and_description_required");
    expect(badRecord.error).toBe("conflict");
  });

  it("hides internal operation-only sessions from the chat session list", async () => {
    const { baseUrl, server } = await startTestServer();

    await server.runtime.saveCollectionSchema(collectionSchema("internal_only"));
    const session = await postJson<{ id: string }>(`${baseUrl}/api/chat/sessions`, {}, 201);
    await postJson(`${baseUrl}/api/chat/sessions/${session.id}/messages`, {
      content: "こんにちは",
      output_locale: "ja"
    }, 201);
    const sessions = await getJson<Array<{ id: string; title: string }>>(`${baseUrl}/api/chat/sessions?room_id=room_default`);

    expect(sessions.map((item) => item.title)).not.toContain("Workspace operations");
    expect(sessions.map((item) => item.id)).toContain(session.id);
  });

});

async function startTestServer(
  provider: ProviderAdapter = new FakeProviderAdapter("fake/test", fakeProviderOutput),
  options: Omit<CreateApiServerOptions, "provider" | "workspaceDataDir" | "automationScheduler"> = {}
): Promise<{ baseUrl: string; server: ApiServer; root: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "samurai-api-"));
  roots.push(root);
  setManagedEnv("SAMURAI_BACKEND_DEFAULT", "samurai-native");
  const server = await createApiServer({ workspaceDataDir: root, provider, automationScheduler: false, ...options });
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.httpServer.listen(0, "127.0.0.1", resolve);
  });
  const address = server.httpServer.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    server,
    root
  };
}

function fakeProviderOutput(input: Parameters<FakeProviderAdapter["generate"]>[0]): ProviderOutput {
  const intent = input.envelope.user_intent;
  const isJapanese = input.envelope.output_locale === "ja";
  const wantsArtifact = /作って|下書き|提案書|draft|memo|note/i.test(intent);
  const toolCalls: ProviderOutput["toolCalls"] = [];
  const nextToolCallId = () => `provider_tool_${toolCalls.length + 1}`;
  if (wantsArtifact) {
    toolCalls.push({
      id: nextToolCallId(),
      name: "create_artifact",
      arguments: {
        title: isJapanese ? "作業メモ" : "Workspace note",
        content: isJapanese ? `# 作業メモ\n\n${intent}` : `# Workspace note\n\n${intent}`
      }
    });
  }
  if (/覚えて|今後|preference|remember/i.test(intent)) {
    toolCalls.push({ id: nextToolCallId(), name: "remember_topic", arguments: {} });
  }
  if (/送信|メール|外部|公開|send|mail|publish|post/i.test(intent)) {
    toolCalls.push({ id: nextToolCallId(), name: "request_external_send", arguments: {} });
  }
  if (/削除|消して|delete|remove/i.test(intent)) {
    toolCalls.push({ id: nextToolCallId(), name: "request_delete", arguments: {} });
  }
  return {
    content: isJapanese ? "対応しました。" : "Done.",
    toolCalls
  };
}

class FailingProviderAdapter implements ProviderAdapter {
  readonly id = "fake" as const;
  readonly model = "fake/failing";

  async generate(): Promise<ProviderOutput> {
    throw new ProviderRequestError("provider_failed", "Bearer secret-token OPENAI_API_KEY=sk-test-secret password=raw-password raw body", {
      reason: "auth_failed",
      status: 401,
      retryable: false,
      message: "Authorization: Bearer secret-token"
    });
  }
}

class FakeGatewayEmailImapClient {
  closed = false;

  constructor(private readonly result: {
    mailbox: string;
    scanned: number;
    messages: Array<{
      uid: string;
      from?: string;
      to?: string;
      subject?: string;
      text?: string;
      message_id?: string;
      in_reply_to?: string;
      internal_date?: string;
      flags?: string[];
    }>;
  }) {}

  async poll(): Promise<typeof this.result> {
    return this.result;
  }

  close(): void {
    this.closed = true;
  }
}

function setManagedEnv(key: string, value: string): void {
  rememberEnv(key);
  process.env[key] = value;
}

function deleteManagedEnv(key: string): void {
  rememberEnv(key);
  delete process.env[key];
}

function rememberEnv(key: string): void {
  if (!managedEnv.has(key)) {
    managedEnv.set(key, process.env[key]);
  }
}

function restoreManagedEnv(): void {
  for (const [key, value] of managedEnv) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  managedEnv.clear();
}

let postJsonSequence = 0;

function expectGatewayRoomAccessBlocked(
  result: { inbound: { status: string; trusted: boolean; session_key?: string; error?: string } },
  sessionKey: string
): void {
  expect(result.inbound).toMatchObject({
    status: "blocked",
    trusted: true,
    session_key: sessionKey,
    error: "gateway_participant_authentication_required"
  });
  expect(result).not.toHaveProperty("session");
  expect(result).not.toHaveProperty("chat");
  expect(result).not.toHaveProperty("boundaryPolicy");
}

async function postJson<T>(url: string, body: unknown, expectedStatus = 200): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": `server-test-${++postJsonSequence}`
    },
    body: JSON.stringify(body)
  });
  const payload = (await response.json()) as T;
  expect(response.status, JSON.stringify(payload)).toBe(expectedStatus);
  return payload;
}

async function postRawJson<T>(
  url: string,
  rawBody: string,
  headers: Record<string, string>,
  expectedStatus = 200
): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers
    },
    body: rawBody
  });
  const payload = (await response.json()) as T;
  expect(response.status, JSON.stringify(payload)).toBe(expectedStatus);
  return payload;
}

async function postSignedSlackJson<T>(url: string, body: unknown, signingSecret: string, expectedStatus = 200): Promise<T> {
  const rawBody = JSON.stringify(body);
  return postRawJson<T>(url, rawBody, slackSignatureHeaders(rawBody, signingSecret), expectedStatus);
}

async function postSignedSamuraiJson<T>(url: string, body: unknown, secret: string, expectedStatus = 200): Promise<T> {
  const rawBody = JSON.stringify(body);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = createHmac("sha256", secret).update(`${timestamp}.`).update(rawBody).digest("hex");
  return postRawJson<T>(url, rawBody, {
    "X-Samurai-Timestamp": timestamp,
    "X-Samurai-Signature": signature
  }, expectedStatus);
}

async function postSignedLineJson<T>(url: string, body: unknown, channelSecret: string, expectedStatus = 200): Promise<T> {
  const rawBody = JSON.stringify(body);
  return postRawJson<T>(url, rawBody, lineSignatureHeaders(rawBody, channelSecret), expectedStatus);
}

function slackSignatureHeaders(rawBody: string, signingSecret: string): Record<string, string> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = `v0=${createHmac("sha256", signingSecret)
    .update(`v0:${timestamp}:${rawBody}`)
    .digest("hex")}`;
  return {
    "X-Slack-Signature": signature,
    "X-Slack-Request-Timestamp": timestamp
  };
}

function lineSignatureHeaders(rawBody: string, channelSecret: string): Record<string, string> {
  return {
    "X-Line-Signature": createHmac("sha256", channelSecret)
      .update(rawBody)
      .digest("base64")
  };
}

async function getJson<T>(url: string, expectedStatus = 200): Promise<T> {
  const response = await fetch(url);
  const payload = (await response.json()) as T;
  expect(response.status, JSON.stringify(payload)).toBe(expectedStatus);
  return payload;
}

async function patchJson<T>(url: string, body: unknown, expectedStatus = 200): Promise<T> {
  const response = await fetch(url, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": `server-test-${++postJsonSequence}`
    },
    body: JSON.stringify(body)
  });
  const payload = (await response.json()) as T;
  expect(response.status, JSON.stringify(payload)).toBe(expectedStatus);
  return payload;
}

async function putJson<T>(url: string, body: unknown, expectedStatus = 200): Promise<T> {
  const response = await fetch(url, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": `server-test-${++postJsonSequence}`
    },
    body: JSON.stringify(body)
  });
  const payload = (await response.json()) as T;
  expect(response.status, JSON.stringify(payload)).toBe(expectedStatus);
  return payload;
}

function collectionSchema(id: string) {
  const labels = { ja: id, en: id, zh: id, ko: id, es: id, "pt-BR": id, fr: id, de: id };
  return {
    id,
    version: "1",
    labels,
    descriptions: labels,
    fields: [{ id: "name", type: "string" }],
    refs: [],
    embeds: [],
    derived_fields: [],
    triggers: [],
    actions: [],
    permissions: {}
  };
}

function movieLogCollectionSchema(): Record<string, JsonValue> {
  const fields: Array<Record<string, JsonValue>> = [
    { id: "title", type: "string", label: "タイトル", required: true },
    { id: "status", type: "enum", label: "状態", enum_values: ["観たい", "視聴中", "観た"] },
    { id: "rating", type: "number", label: "評価" },
    { id: "watched_at", type: "date", label: "鑑賞日" },
    { id: "notes", type: "text", label: "メモ" }
  ];
  const views: Array<Record<string, JsonValue>> = [{
    id: "movies_table",
    renderer: "collection_table",
    editable_fields: ["title", "status", "rating", "watched_at", "notes"]
  }];
  return {
    id: "movies",
    version: "1",
    labels: { ja: "映画ログ", en: "Movies" },
    descriptions: { ja: "映画を記録する個人用アプリ。", en: "A personal movie log." },
    fields,
    refs: [],
    embeds: [],
    derived_fields: [],
    triggers: [],
    actions: [{
      id: "summarize_note",
      kind: "custom_instruction",
      title: "感想を整理",
      instruction: "Summarize the selected movie note and continue the chat with the result.",
      scope: "record"
    }, {
      id: "generate_board",
      kind: "custom_instruction",
      title: "専用ビューを作る",
      instruction: "Generate a compact HTML board for the movie log.",
      output_surface: "custom_view",
      scope: "collection"
    }],
    views,
    permissions: { create: true, update: true, delete: true }
  };
}
