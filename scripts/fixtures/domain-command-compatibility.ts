import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentBackendRegistry, type AgentBackend } from "../../packages/agent-backends/src/index";
import { loadPluginManifests } from "../../packages/action-catalog/src/index";
import { nowIso } from "../../packages/core-schemas/src/index";
import { localOwnerParticipantId } from "../../packages/room-permissions/src/index";
import { AgentRuntime, RuntimeRequestError } from "../../packages/runtime/src/index";
import { WorkspaceStore } from "../../packages/workspace-store/src/index";

const root = await mkdtemp(path.join(tmpdir(), "samurai-command-compatibility-"));
const store = await WorkspaceStore.create({ rootDir: root });
const unavailableRuntime = new AgentRuntime(store, undefined, undefined, new AgentBackendRegistry([]));
let backendReady = true;
let backendRuns = 0;
const readyBackend: AgentBackend = {
  id: "ready",
  kind: "mock",
  label: "Ready",
  sessionPolicy: { acquisition: "none", resume: "unsupported" },
  execution_owner: "host",
  getStatus: () => ({
    id: "ready", kind: "mock", label: "Ready", configured: backendReady, enabled: backendReady, connection_state: backendReady ? "ready" : "disabled",
    session_policy: { acquisition: "none", resume: "unsupported" },
    execution_owner: "host",
    supports: { start_session: false, resume_run: false, cancel_run: false, stream_events: false }
  }),
  async *runTurn() { backendRuns += 1; yield { event_type: "run_completed", payload: { output_summary: "done" } }; }
};
const readyRuntime = new AgentRuntime(store, undefined, undefined, new AgentBackendRegistry([readyBackend]));
const adapterRuntime = new AgentRuntime(store, undefined, undefined, new AgentBackendRegistry([readyBackend]), undefined, undefined, {
  browserAdapter: {
    id: "effective-browser",
    async interact(input) { return { url: input.url }; },
    async screenshot() { return { bytes: new Uint8Array([1]), mime_type: "image/png" }; }
  },
  pdfExportAdapter: { id: "effective-pdf", async export() { return new Uint8Array([37, 80, 68, 70, 45, 49, 46, 55]); } }
});

try {
  const collisionRoot = await mkdtemp(path.join(tmpdir(), "samurai-built-in-collision-"));
  await mkdir(path.join(collisionRoot, ".codex-plugin"), { recursive: true });
  await writeFile(path.join(collisionRoot, ".codex-plugin", "plugin.json"), JSON.stringify({
    id: "collision-plugin", name: "Collision", version: "1.0.0", kind: "tool",
    actions: [{ id: "artifact.create", title: "Override", description: "Must be rejected", input_schema: { type: "object" }, output_schema: { type: "object" }, resource_kinds: ["artifact"] }],
    resource_kinds: ["artifact"], metadata: {}
  }), "utf8");
  const collisionCatalog = await loadPluginManifests(collisionRoot);
  assert.equal(collisionCatalog.issues.some((issue) => issue.code === "duplicate_action"), true);
  assert.equal(collisionCatalog.actions.filter(({ id }) => id === "artifact.create").length, 1);
  await rm(collisionRoot, { recursive: true, force: true });
  const now = nowIso();
  await store.createSession({ id: "effective-session", session_key: "web:effective", room_id: "room_default", title: "Effective", ui_locale: "ja", output_locale: "ja", created_at: now, updated_at: now });
  const principal = { kind: "human" as const, participantId: localOwnerParticipantId };
  const unavailable = await unavailableRuntime.listEffectiveDomainOperations("effective-session", "runtime_api", principal);
  const available = await readyRuntime.listEffectiveDomainOperations("effective-session", "runtime_api", principal);
  const adapterAvailable = await adapterRuntime.listEffectiveDomainOperations("effective-session", "runtime_api", principal);
  assert.equal(unavailable.commands.some((entry) => entry.id === "chat.turn.run"), false);
  assert.equal(available.commands.some((entry) => entry.id === "chat.turn.run"), true);
  for (const operationId of ["artifact.export_pdf", "browser.interact", "browser.navigate", "browser.screenshot"]) {
    assert.equal(unavailable.commands.some((entry) => entry.id === operationId), false, `${operationId} ignored its adapter condition`);
    assert.equal(adapterAvailable.commands.some((entry) => entry.id === operationId), true, `${operationId} was hidden despite its adapter`);
  }
  await assert.rejects(unavailableRuntime.listEffectiveDomainOperations("forged-session", "runtime_api", principal));

  const schema = {
    id: "compatibility", version: "1", labels: { en: "Compatibility" }, descriptions: { en: "Compatibility" },
    fields: [{ id: "name", type: "string" }], refs: [], embeds: [], derived_fields: [], triggers: [], actions: [], views: [],
    permissions: { create: true, update: true, delete: true }
  };
  const compatibilityContext = { sessionId: "effective-session", participant: principal };
  const results = [];
  results.push(await readyRuntime.runCollectionManageCompatibility({ action: "schemaDocs" }, "runtime_api", undefined, compatibilityContext));
  results.push(await readyRuntime.runCollectionManageCompatibility({ action: "putSchema", schema }, "runtime_api", "compat-put-schema", compatibilityContext));
  results.push(await readyRuntime.runCollectionManageCompatibility({ action: "getSchema", collection_id: schema.id }, "runtime_api", undefined, compatibilityContext));
  results.push(await readyRuntime.runCollectionManageCompatibility({ action: "putItems", collection_id: schema.id, mode: "create", items: [{ id: "one", name: "One" }] }, "runtime_api", "compat-put-items", compatibilityContext));
  results.push(await readyRuntime.runCollectionManageCompatibility({ action: "getItems", collection_id: schema.id }, "runtime_api", undefined, compatibilityContext));
  results.push(await readyRuntime.runCollectionManageCompatibility({ action: "patchSchema", collection_id: schema.id, patches: [] }, "runtime_api", "compat-patch-schema", compatibilityContext));
  assert.deepEqual(results.map((result) => (result as Record<string, unknown>).action), ["schemaDocs", "putSchema", "getSchema", "putItems", "getItems", "patchSchema"]);
  backendReady = false;
  const disabledAfterInventory = await readyRuntime.listEffectiveDomainOperations("effective-session", "runtime_api", principal);
  assert.equal(disabledAfterInventory.commands.some((entry) => entry.id === "chat.turn.run"), false);
  await assert.rejects(readyRuntime.runDomainCommand({
    command_id: "chat.turn.run",
    input_source: "runtime_api",
    idempotency_key: "toctou-disabled-backend",
    payload: { session_id: "effective-session", content: "must not run" }
  }), (error: unknown) => error instanceof RuntimeRequestError && error.message === "domain_operation_unavailable:chat.turn.run");
  assert.equal(backendRuns, 0);
  assert.equal(await store.getDomainCommandExecution("toctou-disabled-backend"), undefined);
  for (const command_id of ["approval.approve", "approval.deny", "grant.create", "grant.revoke", "workspace.delete"]) {
    await assert.rejects(
      readyRuntime.runDomainCommand({ command_id, input_source: "runtime_api", idempotency_key: `deprecated-${command_id}`, payload: {} }),
      (error: unknown) => error instanceof RuntimeRequestError
        && error.code === "gone"
        && error.message === `deprecated_operation:${command_id}`
        && error.payload !== undefined
        && "replacement" in error.payload
        && error.payload.replacement.target === "/api/domain/commands/effective"
    );
  }

  process.stdout.write(`${JSON.stringify({ status: "passed", gates: ["IN07", "IN08", "IN09", "IN10", "ES06"], compatibility_actions: 6, deprecated_operations_gone: 5, deprecated_replacements: 5, effective_changes_with_backend: true, effective_changes_with_adapters: true, toctou_handler_calls: backendRuns, built_in_override_rejected: true, forged_session_rejected: true })}\n`);
} finally {
  await unavailableRuntime.shutdownMcpProcessPool().catch(() => undefined);
  await readyRuntime.shutdownMcpProcessPool().catch(() => undefined);
  await adapterRuntime.shutdownMcpProcessPool().catch(() => undefined);
  await store.close().catch(() => undefined);
  await rm(root, { recursive: true, force: true });
}
