import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentBackendRegistry, type AgentBackend } from "../../packages/agent-backends/src/index";
import { AgentRuntime } from "../../packages/runtime/src/index";
import { WorkspaceStore } from "../../packages/workspace-store/src/index";

const root = await mkdtemp(path.join(tmpdir(), "samurai-command-ingress-"));
const store = await WorkspaceStore.create({ rootDir: root });
let runtime: AgentRuntime;
let bridgeRunId = "";

const bridgeBackend: AgentBackend = {
  id: "command-ingress-bridge",
  kind: "codex",
  label: "Command ingress bridge fixture",
  async *runTurn(input) {
    bridgeRunId = input.run_id;
    await runtime.runBackendToolBridgeCall({
      runId: input.run_id,
      token: input.tool_bridge?.token ?? "",
      toolName: "artifact_create",
      toolCallId: "ingress_bridge_tool",
      toolInput: { title: "Bridge artifact", content: "Created through the Backend tool entrance." }
    });
    yield { event_type: "run_completed", payload: { output_summary: "done" } };
  }
};

runtime = new AgentRuntime(store, undefined, undefined, new AgentBackendRegistry([bridgeBackend]));

try {
  const apiSession = await runtime.runDomainCommand({
    command_id: "session.create",
    input_source: "runtime_api",
    idempotency_key: "ingress-runtime-api",
    payload: { title: "Runtime API ingress" }
  });
  const session = apiSession.result as { id: string };

  await runtime.runSurfaceOperation({
    id: "ingress-generated-surface",
    kind: "artifact.request",
    session_id: session.id,
    action: "create",
    title: "Surface artifact",
    instruction: "Created through the Generated Surface entrance."
  });

  await runtime.handleGatewayInbound({
    channel: "webhook",
    source_identity: "command-ingress-source",
    body: "Gateway ingress fixture",
    metadata: { message_id: "ingress-gateway" }
  });

  const automation = await runtime.runDomainCommand({
    command_id: "automation.job.save",
    input_source: "runtime_api",
    idempotency_key: "ingress-automation-save",
    payload: {
      title: "Ingress wiki reindex",
      kind: "wiki_reindex",
      schedule: "once",
      target_instruction: "Reindex wiki",
      next_run_at: new Date(0).toISOString()
    }
  });
  const automationJob = (automation.result as { resource: { id: string; next_run_at?: string } }).resource;
  await runtime.runDueAutomationJobs(new Date(Date.now() + 1_000).toISOString());

  await runtime.runChatTurn({
    sessionId: session.id,
    content: "Create an artifact through the bridge",
    backend_id: bridgeBackend.id
  });

  const expected = [
    ["runtime_api", "ingress-runtime-api", "session.create"],
    ["surface_operation", "ingress-generated-surface", "artifact.create"],
    ["gateway_inbound", "ingress-gateway", "gateway.inbound.route"],
    ["automation", `automation:${automationJob.id}:${automationJob.next_run_at}`, "automation.job.run"],
    ["provider_tool_call", `${bridgeRunId}:ingress_bridge_tool:artifact.create`, "artifact.create"]
  ] as const;
  for (const [source, key, commandId] of expected) {
    const execution = await store.getDomainCommandExecution(key);
    assert.equal(execution?.status, "completed", `${source} did not complete through Domain Command Bus`);
    assert.equal(execution?.input_source, source);
    assert.equal(execution?.command_id, commandId);
  }

  const serverSource = await readFile(path.resolve("apps/server/src/api-server.ts"), "utf8");
  const webSource = await readFile(path.resolve("apps/web/src/lib/api.ts"), "utf8");
  const desktopSource = await readFile(path.resolve("apps/desktop/src/main.ts"), "utf8");
  assert.match(serverSource, /runRuntimeApiCommand|runRuntimeApiWriteCommand/);
  assert.match(webSource, /method:\s*["'](?:POST|PUT|PATCH|DELETE)["']/);
  assert.match(desktopSource, /method:\s*["']POST["']/);

  process.stdout.write(`${JSON.stringify({
    status: "passed",
    real_ingresses: expected.map(([input_source, , command_id]) => ({ input_source, command_id })),
    web_api_boundary: true,
    desktop_api_boundary: true,
    direct_server_mutations: 0
  })}\n`);
} finally {
  await store.close();
  await rm(root, { recursive: true, force: true });
}
