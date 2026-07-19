import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentBackendRegistry, type AgentBackend } from "../../packages/agent-backends/src/index";
import { createDefaultGatewayPairingPolicy } from "../../packages/gateway/src/index";
import { AgentRuntime } from "../../packages/runtime/src/index";
import { WorkspaceStore } from "../../packages/workspace-store/src/index";

const root = await mkdtemp(path.join(tmpdir(), "samurai-backend-selection-"));
const store = await WorkspaceStore.create({ rootDir: root });
const backend = (id: string): AgentBackend => ({ id, kind: "external", label: id, async *runTurn() { yield { event_type: "text_delta", payload: { text: `${id} reply` } }; yield { event_type: "run_completed", payload: { output_summary: `${id} done` } }; } });
const selected = backend("selected-backend");
const fallback = backend("fallback-backend");
const runtime = new AgentRuntime(store, undefined, undefined, new AgentBackendRegistry([fallback, selected]));
try {
  await store.patchSettings({ default_backend_id: selected.id });
  const session = await runtime.createSession({ title: "Web" });
  const web = await runtime.runChatTurn({ sessionId: session.id, content: "web" });
  const pending = await runtime.handleGatewayInbound({ channel: "webhook", source_identity: "pending-owner", body: "pending", metadata: { message_id: "backend-selection-pending" } });
  assert.equal(pending.chat, undefined);
  const basePolicy = createDefaultGatewayPairingPolicy("webhook");
  await runtime.saveGatewayPairingPolicy({ ...basePolicy, trust_mode: "auto_approve", allowlist: ["owner"] });
  const allowlistBlocked = await runtime.handleGatewayInbound({ channel: "webhook", source_identity: "new-owner", body: "blocked", metadata: { message_id: "backend-selection-blocked" } });
  assert.equal(allowlistBlocked.chat, undefined);
  await runtime.saveGatewayPairingPolicy({ ...basePolicy, trust_mode: "auto_approve", allowlist: ["owner", "new-owner"], updated_at: new Date().toISOString() });
  const allowlistAllowed = await runtime.handleGatewayInbound({ channel: "webhook", source_identity: "new-owner", body: "allowed", metadata: { message_id: "backend-selection-allowed" } });
  assert.equal(allowlistAllowed.chat?.backendRun.backend_id, selected.id);
  const gateway = await runtime.handleGatewayInbound({ channel: "webhook", source_identity: "owner", body: "gateway", metadata: { message_id: "backend-selection-gateway" } });
  const now = "2026-01-01T00:00:00.000Z";
  await store.saveAutomationJob({ id: "backend-selection-job", title: "Automation", kind: "custom_instruction", status: "enabled", schedule: "once", target_instruction: "automation", delivery_target: {}, next_run_at: now, failure_count: 0, max_attempts: 3, created_at: now, updated_at: now });
  const automation = await runtime.runDueAutomationJobs(now);
  const automationBackendRun = automation[0]?.automationRun.backend_run_id ? await store.getBackendRun(automation[0].automationRun.backend_run_id!) : undefined;
  assert.equal(web.backendRun.backend_id, selected.id);
  assert.equal(gateway.chat?.backendRun.backend_id, selected.id);
  assert.equal(automationBackendRun?.backend_id, selected.id);
  process.stdout.write(`${JSON.stringify({ status: "passed", web_backend: web.backendRun.backend_id, gateway_backend: gateway.chat?.backendRun.backend_id, automation_backend: automationBackendRun?.backend_id, consistent: true, unapproved_pairing_blocked: true, allowlist_change_applied_next_input: true })}\n`);
} finally {
  await runtime.shutdownMcpProcessPool();
  await store.close();
  await rm(root, { recursive: true, force: true });
}
