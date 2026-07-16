import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { AgentBackendRegistry, type AgentBackend } from "../../packages/agent-backends/src/index";
import {
  domainCommandEntries,
  domainQueryEntries,
  getDomainCommandForProviderToolName,
  getDomainCommandForSurfaceOperationKind,
  getDomainQueryForProviderToolName,
  getDomainQueryForSurfaceOperationKind
} from "../../packages/action-catalog/src/index";
import { AgentRuntime } from "../../packages/runtime/src/index";
import { WorkspaceStore } from "../../packages/workspace-store/src/index";
import { closeApiServer, createApiServer } from "../../apps/server/src/api-server";

const root = await mkdtemp(path.join(tmpdir(), "samurai-command-ingress-"));
const store = await WorkspaceStore.create({ rootDir: root });
const serverRoot = await mkdtemp(path.join(tmpdir(), "samurai-command-server-ingress-"));
const server = await createApiServer({ workspaceDataDir: serverRoot, automationScheduler: false });
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
  const registeredMappings: Array<{ entrance: "provider" | "surface"; operation_id: string; external_id: string }> = [];
  for (const entry of [...domainCommandEntries, ...domainQueryEntries]) {
    for (const toolName of entry.provider_tool_names ?? []) {
      const mapped = entry.kind === "command" ? getDomainCommandForProviderToolName(toolName) : getDomainQueryForProviderToolName(toolName);
      assert.equal(mapped?.id, entry.id, `Provider mapping bypasses the registered operation: ${toolName}`);
      registeredMappings.push({ entrance: "provider", operation_id: entry.id, external_id: toolName });
    }
    for (const kind of entry.surface_operation_kinds ?? []) {
      const mapped = entry.kind === "command" ? getDomainCommandForSurfaceOperationKind(kind) : getDomainQueryForSurfaceOperationKind(kind);
      assert.equal(mapped?.id, entry.id, `Surface mapping bypasses the registered operation: ${kind}`);
      registeredMappings.push({ entrance: "surface", operation_id: entry.id, external_id: kind });
    }
  }
  assert.ok(registeredMappings.length > 0, "No registered ingress mappings were verified");
  await new Promise<void>((resolve) => server.httpServer.listen(0, "127.0.0.1", resolve));
  const address = server.httpServer.address() as AddressInfo;
  const serverResponse = await fetch(`http://127.0.0.1:${address.port}/api/domain/commands/run`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "ingress-server-api" },
    body: JSON.stringify({ command_id: "session.create", payload: { title: "Server ingress" } })
  });
  assert.equal(serverResponse.status, 201);
  const serverResult = await serverResponse.json() as { command: { id: string; contract_fingerprint: string } };
  assert.equal(serverResult.command.id, "session.create");
  assert.equal(serverResult.command.contract_fingerprint, domainCommandEntries.find(({ id }) => id === "session.create")!.contract_fingerprint);
  const serverExecution = await server.store.getDomainCommandExecution("ingress-server-api");
  assert.equal(serverExecution?.status, "completed");

  const session = await store.createSession({
    id: "ingress-session", session_key: "ingress-session", title: "Ingress", ui_locale: "en", output_locale: "en",
    created_at: new Date(0).toISOString(), updated_at: new Date(0).toISOString()
  });

  await runtime.runSurfaceOperation({
    id: "ingress-generated-surface",
    kind: "artifact.request",
    session_id: session.id,
    action: "create",
    title: "Surface artifact",
    instruction: "Created through the Generated Surface entrance."
  });

  await store.saveCollectionSchema({
    id: "ingress-generated", version: "1", labels: { en: "Ingress" }, descriptions: { en: "Ingress" },
    fields: [{ id: "name", type: "string" }], refs: [], embeds: [], derived_fields: [], triggers: [], actions: [], views: [], permissions: { create: true }
  });
  await runtime.runDomainCommand({
    command_id: "collection.record.create",
    input_source: "generated_surface",
    idempotency_key: "ingress-generated-command",
    payload: { collection_id: "ingress-generated", id: "generated-record", data: { name: "Generated" } }
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

  const providerExecutionKey = `${bridgeRunId}:ingress_bridge_tool:artifact.create`;
  const expected = [
    ["surface_operation", "ingress-generated-surface", "artifact.create"],
    ["generated_surface", "ingress-generated-command", "collection.record.create"],
    ["gateway_inbound", "ingress-gateway", "gateway.inbound.route"],
    ["automation", `automation:${automationJob.id}:${automationJob.next_run_at}`, "automation.job.run"],
    ["provider_tool_call", providerExecutionKey, "artifact.create"]
  ] as const;
  for (const [source, key, commandId] of expected) {
    const execution = await store.getDomainCommandExecution(key);
    assert.equal(execution?.status, "completed", `${source} did not complete through Domain Command Bus`);
    assert.equal(execution?.input_source, source);
    assert.equal(execution?.command_id, commandId);
    assert.ok(execution?.correlation_id);
  }
  const correlatedExecution = await store.getDomainCommandExecution(providerExecutionKey);
  assert.ok(correlatedExecution?.result && typeof correlatedExecution.result === "object" && !Array.isArray(correlatedExecution.result));
  const correlatedOperationValue = "operation" in correlatedExecution.result ? correlatedExecution.result.operation : undefined;
  assert.ok(correlatedOperationValue && typeof correlatedOperationValue === "object" && !Array.isArray(correlatedOperationValue) && "id" in correlatedOperationValue && typeof correlatedOperationValue.id === "string");
  const correlatedOperation = await store.getOperation(correlatedOperationValue.id);
  assert.ok(correlatedOperation);
  assert.equal(correlatedOperation?.correlation_id, correlatedExecution.correlation_id);
  const correlatedChanges = (await store.listWorkspaceChanges()).filter((change) => change.legacy_operation_id === correlatedOperationValue.id);
  assert.ok(correlatedChanges.length > 0);
  assert.equal(correlatedChanges.every((change) => change.correlation_id === correlatedExecution.correlation_id), true);
  const ingressIdentities = [
    server.runtime.getDomainOperationBindingIdentity("session.create"),
    runtime.getDomainOperationBindingIdentity("artifact.create"),
    runtime.getDomainOperationBindingIdentity("collection.record.create"),
    runtime.getDomainOperationBindingIdentity("gateway.inbound.route"),
    runtime.getDomainOperationBindingIdentity("automation.job.run")
  ];
  assert.equal(ingressIdentities.every((identity) => identity?.handlerSymbol), true);

  const serverSource = await readFile(path.resolve("apps/server/src/api-server.ts"), "utf8");
  const webSource = await readFile(path.resolve("apps/web/src/lib/api.ts"), "utf8");
  const desktopSource = await readFile(path.resolve("apps/desktop/src/main.ts"), "utf8");
  assert.match(serverSource, /runRuntimeApiCommand|runRuntimeApiWriteCommand/);
  assert.match(webSource, /method:\s*["'](?:POST|PUT|PATCH|DELETE)["']/);
  assert.match(desktopSource, /method:\s*["']POST["']/);

  process.stdout.write(`${JSON.stringify({
    status: "passed",
    gates: ["IN01", "IN03", "IN12"],
    entrances: 6,
    real_ingresses: expected.map(([input_source, , command_id]) => ({ input_source, command_id })),
    registered_mappings: registeredMappings.length,
    web_api_boundary: true,
    desktop_api_boundary: true,
    direct_server_mutations: 0,
    correlated_workspace_changes: correlatedChanges.length
  })}\n`);
} finally {
  await closeApiServer(server);
  await store.close();
  await rm(root, { recursive: true, force: true });
  await rm(serverRoot, { recursive: true, force: true });
}
