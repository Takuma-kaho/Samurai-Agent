import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { getDomainCommandEntry } from "../../packages/action-catalog/src/index";
import { AgentBackendRegistry, type AgentBackend } from "../../packages/agent-backends/src/index";
import type { ArtifactRecord, JsonValue, OperationRecord } from "../../packages/core-schemas/src/index";
import { DomainOperationRegistry } from "../../packages/domain-operations/src/registry/operation-registry";
import { AgentRuntime } from "../../packages/runtime/src/index";
import { closeApiServer, createApiServer } from "../../apps/server/src/api-server";

/**
 * IN01/IN02 characterize the final active operation, not six superficially
 * similar adapters.  Each entrance below must cause exactly one real
 * `artifact.create` registry execution.  The registry prototype is observed
 * only at the boundary immediately before the actual Handler; no production
 * test hook or alternate execution API is introduced.
 */
const now = "2026-07-17T00:00:00.000Z";
const title = "Ingress artifact";
const instruction = "Ingress artifact content";
const content = `# ${title}\nAction: create\n## Instruction\n${instruction}`;
const artifactPayload = {
  title,
  content,
  kind: "document",
  input_locale: "en",
  output_locale: "en",
  metadata: { fixture: "domain-command-ingress" }
} as const satisfies Record<string, JsonValue>;
const invalidArtifactPayload: Record<string, JsonValue> = {
  ...artifactPayload,
  // Whitespace crosses each transport but violates artifact.create after its
  // canonical trim/min title validation, before the Handler can execute.
  title: " "
};

interface CapturedArtifactExecution {
  source: string;
  payload: Record<string, JsonValue>;
  correlationId: string;
  binding: { operationId: string; version: string; handlerSymbol: string };
  contractFingerprint: string;
}

interface IngressObservation {
  entrance: "web_runtime_api" | "surface_operation" | "provider_tool_call" | "gateway_inbound" | "automation" | "generated_surface_action";
  source: string;
  binding: CapturedArtifactExecution["binding"];
  contractFingerprint: string;
  artifact: {
    title: string;
    kind: string;
    locale: string;
    sourceLocales: string[];
    content: string;
  };
  operation: {
    operation: string;
    status: string;
    resultKind: string;
  };
  workspaceChangeTelemetry: {
    count: number;
    allLinkedToRealBackendRuns: boolean;
  };
  execution: {
    commandId: string;
    inputSource: string;
    status: string;
  };
  error: null;
}

interface IngressRejectionObservation {
  entrance: IngressObservation["entrance"];
  error: { code: string };
  handlerReached: false;
  artifactCommandSideEffects: 0;
}

// ES02: invalid command input is a stable, transport-independent Runtime
// classification. Individual transports may intentionally redact diagnostic
// text, so parity is asserted on the canonical code rather than raw text.
const artifactCreateInvalidInputCode = "validation";

const expectedWorkspaceChangeTelemetryCount: Record<IngressObservation["entrance"], number> = {
  // WorkspaceChange is BackendRun telemetry, not a synthetic record required
  // for direct Domain Command routes.  The three backend-owned routes must
  // produce exactly one linked record; direct routes must not invent one.
  web_runtime_api: 0,
  surface_operation: 0,
  provider_tool_call: 1,
  gateway_inbound: 1,
  automation: 1,
  generated_surface_action: 0
};

const debugStage = (stage: string): void => {
  if (process.env.SAMURAI_INGRESS_DEBUG === "1") process.stderr.write(`[domain-command-ingress] ${stage}\n`);
};
const ingressTimeoutMs = Number.parseInt(process.env.SAMURAI_INGRESS_TIMEOUT_MS ?? "30000", 10);

async function withIngressTimeout<TResult>(stage: string, execute: () => Promise<TResult>): Promise<TResult> {
  const timeout = Number.isFinite(ingressTimeoutMs) && ingressTimeoutMs > 0 ? ingressTimeoutMs : 30000;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      execute(),
      new Promise<TResult>((_resolve, reject) => {
        timer = setTimeout(() => {
          debugStage(`${stage}-timeout:${timeout}ms`);
          reject(new Error(`ingress_stage_timeout:${stage}:${timeout}ms`));
        }, timeout);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const root = await mkdtemp(path.join(tmpdir(), "samurai-command-ingress-"));
let runtime: AgentRuntime;
let bridgeArtifactPayload: Record<string, JsonValue> = structuredClone(artifactPayload);
let latestBridgeRunId: string | undefined;
let lateServerErrorHandler: ((error: Error) => void) | undefined;
const bridgeBackend: AgentBackend = {
  id: "command-ingress-bridge",
  kind: "codex",
  label: "Command ingress bridge fixture",
  async *runTurn(input) {
    latestBridgeRunId = input.run_id;
    // This is the normal Backend event contract.  It deliberately does not
    // call AgentRuntime or a test-only helper: Runtime must normalize the
    // emitted Provider tool event into the registered Domain Command itself.
    yield {
      event_type: "tool_call_started",
      tool_call_id: `${input.run_id}:artifact_create`,
      payload: {
        provider_tool_name: "mcp__samurai__artifact_create",
        action_id: "artifact.create",
        input: bridgeArtifactPayload
      }
    };
    yield { event_type: "run_completed", payload: { output_summary: "fixture completed" } };
  }
};

const server = await createApiServer({
  workspaceDataDir: root,
  backendRegistry: new AgentBackendRegistry([bridgeBackend]),
  automationScheduler: false,
  loadPluginEntrypoints: false
});
debugStage("api-server-created");
runtime = server.runtime;

const captured: CapturedArtifactExecution[] = [];
const originalExecute = DomainOperationRegistry.prototype.execute;
DomainOperationRegistry.prototype.execute = async function captureArtifactCreate(context, id, rawInput) {
  if (id === "artifact.create") {
    const binding = this.bindingIdentity(id);
    assert.ok(binding, "artifact.create must have a concrete Registry binding");
    const contract = getDomainCommandEntry(id);
    assert.ok(contract, "artifact.create must have an Action Catalog projection");
    assert.equal(binding.version, contract.contract_version, "Registry binding version must match the canonical command contract");
    assert.equal(rawInput !== null && typeof rawInput === "object" && !Array.isArray(rawInput), true, "artifact.create raw input must be an object at Registry boundary");
    captured.push({
      source: context.inputSource,
      payload: structuredClone(rawInput as Record<string, JsonValue>),
      correlationId: context.correlationId,
      binding,
      contractFingerprint: contract.contract_fingerprint
    });
  }
  return originalExecute.call(this, context, id, rawInput);
};

try {
  debugStage("listen-start");
  try {
    await withIngressTimeout("listen", () => new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        debugStage(`listen-error:${error.message}`);
        reject(error);
      };
      server.httpServer.once("error", onError);
      server.httpServer.listen(0, "127.0.0.1", () => {
        server.httpServer.off("error", onError);
        resolve();
      });
    }));
  } catch (error) {
    debugStage(`listen-catch:${error instanceof Error ? error.message : String(error)}`);
    lateServerErrorHandler = (lateError) => debugStage(`late-server-error:${lateError.message}`);
    server.httpServer.on("error", lateServerErrorHandler);
    throw error;
  }
  debugStage("listen-complete");
  const address = server.httpServer.address() as AddressInfo;
  debugStage("session-create-start");
  const session = await runtime.createSession({ title: "Ingress fixture", ui_locale: "en", output_locale: "en" });
  debugStage("session-create-complete");
  const observations: IngressObservation[] = [];

  debugStage("entrance-web-runtime-api-start");
  observations.push(await observeArtifactCreate("web_runtime_api", async () => {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/domain/commands/run`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "ingress-web-runtime-api" },
      body: JSON.stringify({
        command_id: "artifact.create",
        // The HTTP ingress must ignore this client supplied field, while the
        // session below is resolved as server-owned context.
        input_source: "gateway_inbound",
        session_id: session.id,
        payload: artifactPayload
      })
    });
    const result = await response.json() as { ok?: boolean; value?: { operation?: { operation?: string } } };
    if (response.status !== 201 && process.env.SAMURAI_INGRESS_DEBUG === "1") {
      process.stderr.write(`[domain-command-ingress] web-runtime-api-response:${JSON.stringify(result)}\n`);
    }
    assert.equal(response.status, 201);
    assert.equal(result.ok, true);
    assert.equal(result.value?.operation?.operation, "artifact.create");
  }));
  debugStage("entrance-web-runtime-api-complete");

  debugStage("entrance-surface-operation-start");
  observations.push(await observeArtifactCreate("surface_operation", async () => {
    await runtime.runSurfaceOperation({
      id: "ingress-surface-artifact-create",
      kind: "artifact.request",
      session_id: session.id,
      action: "create",
      title,
      instruction
    });
  }));
  debugStage("entrance-surface-operation-complete");

  debugStage("entrance-provider-tool-call-start");
  observations.push(await observeArtifactCreate("provider_tool_call", async () => {
    await runtime.runChatTurn({
      sessionId: session.id,
      content: "Run the provider ingress fixture.",
      backend_id: bridgeBackend.id
    });
  }));
  debugStage("entrance-provider-tool-call-complete");

  // The default local_cli pairing policy intentionally starts with no tool
  // allowlist. Configure the exact artifact capability required by this
  // ingress parity fixture through the public Domain Command boundary before
  // exercising the Gateway route.
  await runtime.runDomainCommand({
    command_id: "gateway.pairing_policy.save",
    input_source: "runtime_api",
    idempotency_key: "ingress-gateway-policy-save",
    payload: { channel: "local_cli", trust_mode: "auto_approve", allowed_tools: ["artifact.create"] }
  });
  debugStage("gateway-policy-configured");

  debugStage("entrance-gateway-inbound-start");
  observations.push(await observeArtifactCreate("gateway_inbound", async () => {
    // local_cli has an actual Gateway pairing/routing policy, but is
    // auto-approved by the Gateway boundary.  The backend still emits its
    // ordinary Provider tool event; this proves the complete Gateway path.
    const gatewayResult = await runtime.handleGatewayInbound({
      channel: "local_cli",
      source_identity: "ingress-gateway-owner",
      body: "Run the gateway ingress fixture.",
      backend_id: bridgeBackend.id,
      input_locale: "en",
      output_locale: "en",
      metadata: { message_id: "ingress-gateway-message" }
    });
    const gatewayUserMessage = (gatewayResult as { chat?: { messages?: Array<{ role?: string; envelope?: { input_locale?: string; output_locale?: string } }> } }).chat?.messages
      ?.find((message) => message.role === "user");
    assert.equal(gatewayUserMessage?.envelope?.input_locale, "en", "Gateway input_locale must reach the BackendRun envelope");
    assert.equal(gatewayUserMessage?.envelope?.output_locale, "en", "Gateway output_locale must reach the BackendRun envelope");
    if (process.env.SAMURAI_INGRESS_DEBUG === "1") process.stderr.write(`[domain-command-ingress] gateway-result:${JSON.stringify(gatewayResult)}\n`);
  }));
  debugStage("entrance-gateway-inbound-complete");

  // Automation runs are scheduled from the Workspace settings locale when a
  // job has no per-job locale fields. Set the same en/en contract through the
  // public settings Domain Command before exercising the scheduled entrance.
  await runtime.runDomainCommand({
    command_id: "settings.patch",
    input_source: "runtime_api",
    idempotency_key: "ingress-automation-locale-settings",
    payload: { ui_locale: "en", output_locale: "en" }
  });
  debugStage("automation-locale-configured");

  const savedJob = await runtime.runDomainCommand({
    command_id: "automation.job.save",
    input_source: "runtime_api",
    idempotency_key: "ingress-automation-save",
    payload: {
      title: "Ingress automation fixture",
      kind: "custom_instruction",
      schedule: "once",
      target_instruction: "Run the automation ingress fixture.",
      next_run_at: now
    }
  });
  const job = (savedJob.result as { resource: { id: string } }).resource;
  observations.push(await observeArtifactCreate("automation", async () => {
    const runs = await runtime.runDueAutomationJobs("2026-07-17T00:00:01.000Z");
    assert.equal(runs.length, 1, "one due automation job must run");
    assert.equal(runs[0]?.resource.id.length > 0, true, "automation run must persist its real result");
    assert.ok(latestBridgeRunId, "automation entrance must create a real BackendRun");
    const automationBackendRun = await server.store.getBackendRun(latestBridgeRunId);
    assert.ok(automationBackendRun, "automation entrance BackendRun must persist");
    const automationInputMessage = (await server.store.listMessages(automationBackendRun.session_id))
      .find((message) => message.id === automationBackendRun.input_message_id);
    assert.equal(automationInputMessage?.envelope?.input_locale, "en", "Automation input locale must reach the BackendRun envelope");
    assert.equal(automationInputMessage?.envelope?.output_locale, "en", "Automation output locale must reach the BackendRun envelope");
    const execution = await server.store.getDomainCommandExecution(`automation:${job.id}:${now}`);
    assert.equal(execution?.status, "completed", "automation wrapper Domain Command must complete");
  }));
  debugStage("entrance-automation-complete");

  const generated = await runtime.runRuntimeApiDomainCommand({
    command_id: "generated_surface.create",
    idempotency_key: "ingress-generated-surface-create",
    payload: {
      request: {
        user_intent: "Create the ingress fixture artifact.",
        source_resource_refs: [],
        allowed_domain_commands: ["artifact.create"],
        selected_knowledge_refs: [],
        selected_skill_refs: [],
        client_capabilities: {},
        expected_lifetime: "session",
        fallback_chain: ["built_in_surface", "artifact", "text"]
      },
      bundle: {
        title: "Ingress fixture surface",
        html: "<main>Ingress fixture</main>",
        actions: [{
          id: "create-artifact",
          label: "Create artifact",
          command_id: "artifact.create",
          input_schema: { type: "object" },
          payload_template: artifactPayload
        }]
      }
    }
  }, { sessionId: session.id });
  const surface = (generated.result as { definition: { id: string; current_revision_id: string } }).definition;
  observations.push(await observeArtifactCreate("generated_surface_action", async () => {
    await runtime.runGeneratedSurfaceAction({
      surfaceId: surface.id,
      revisionId: surface.current_revision_id,
      actionId: "create-artifact",
      interactionId: "ingress-generated-surface-interaction",
      actionPayload: {}
    });
  }));
  debugStage("entrance-generated-surface-action-complete");

  // The same invalid artifact.create title must be rejected before the
  // Handler across every real ingress.  Backend entrances surface their
  // rejection through the persisted provider tool result; direct entrances
  // surface the same Runtime/HTTP error.  In either case, no artifact command
  // handler call, Artifact, Artifact Operation, or command execution exists.
  const rejections: IngressRejectionObservation[] = [];
  debugStage("rejection-web-runtime-api-start");
  rejections.push(await observeArtifactCreateRejection("web_runtime_api", async () => {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/domain/commands/run`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "ingress-web-runtime-api-invalid" },
      body: JSON.stringify({ command_id: "artifact.create", session_id: session.id, payload: invalidArtifactPayload })
    });
    assert.equal(response.status, 400);
    return httpDomainError(await response.json());
  }));
  debugStage("rejection-web-runtime-api-complete");

  rejections.push(await observeArtifactCreateRejection("surface_operation", async () =>
    thrownDomainError(() => runtime.runSurfaceOperation({
      id: "ingress-surface-artifact-create-invalid",
      kind: "artifact.request",
      session_id: session.id,
      action: "create",
      title: " ",
      instruction
    }))
  ));
  debugStage("rejection-surface-operation-complete");

  rejections.push(await observeArtifactCreateRejection("provider_tool_call", async () =>
    withBridgeArtifactPayload(invalidArtifactPayload, () => backendToolDomainError(() => runtime.runChatTurn({
      sessionId: session.id,
      content: "Run the invalid provider ingress fixture.",
      backend_id: bridgeBackend.id
    })))
  ));
  debugStage("rejection-provider-tool-call-complete");

  rejections.push(await observeArtifactCreateRejection("gateway_inbound", async () =>
    withBridgeArtifactPayload(invalidArtifactPayload, () => backendToolDomainError(() => runtime.handleGatewayInbound({
      channel: "local_cli",
      source_identity: "ingress-gateway-owner",
      body: "Run the invalid gateway ingress fixture.",
      backend_id: bridgeBackend.id,
      input_locale: "en",
      output_locale: "en",
      metadata: { message_id: "ingress-gateway-message-invalid" }
    })))
  ));
  debugStage("rejection-gateway-inbound-complete");

  const invalidSavedJob = await runtime.runDomainCommand({
    command_id: "automation.job.save",
    input_source: "runtime_api",
    idempotency_key: "ingress-automation-save-invalid",
    payload: {
      title: "Invalid ingress automation fixture",
      kind: "custom_instruction",
      schedule: "once",
      target_instruction: "Run the invalid automation ingress fixture.",
      next_run_at: "2026-07-17T00:01:00.000Z"
    }
  });
  const invalidJob = (invalidSavedJob.result as { resource: { id: string } }).resource;
  rejections.push(await observeArtifactCreateRejection("automation", async () =>
    withBridgeArtifactPayload(invalidArtifactPayload, () => backendToolDomainError(async () => {
      const runs = await runtime.runDueAutomationJobs("2026-07-17T00:01:01.000Z");
      if (process.env.SAMURAI_INGRESS_DEBUG === "1") process.stderr.write(`[domain-command-ingress] invalid-automation-runs:${JSON.stringify(runs)}\n`);
      assert.equal(runs.length, 1, "the invalid automation job must run through its real Backend path");
      assert.equal(runs[0]?.operation.operation, "automation.job.run", "the invalid automation job must persist its wrapper Operation");
      assert.equal(runs[0]?.operation.input_ref?.kind, "automation_job", "the invalid automation wrapper must reference the scheduled job");
      assert.equal(runs[0]?.operation.input_ref?.id, invalidJob.id, "the invalid automation wrapper must reference the exact scheduled job");
    }))
  ));
  debugStage("rejection-automation-complete");

  rejections.push(await observeArtifactCreateRejection("generated_surface_action", async () =>
    thrownDomainError(() => runtime.runGeneratedSurfaceAction({
      surfaceId: surface.id,
      revisionId: surface.current_revision_id,
      actionId: "create-artifact",
      interactionId: "ingress-generated-surface-interaction-invalid",
      actionPayload: { title: " " }
    }))
  ));
  debugStage("rejection-generated-surface-action-complete");

  assert.equal(rejections.length, 6);
  for (const rejection of rejections) {
    assert.equal(
      rejection.error.code,
      artifactCreateInvalidInputCode,
      `${rejection.entrance} must expose the canonical artifact.create invalid-input code`
    );
    assert.equal(rejection.handlerReached, false, `${rejection.entrance} must reject before the Artifact Handler`);
    assert.equal(rejection.artifactCommandSideEffects, 0, `${rejection.entrance} must leave no artifact.create side effect`);
  }

  assert.equal(observations.length, 6);
  const reference = observations[0]!;
  for (const observation of observations) {
    assert.deepEqual(observation.binding, reference.binding, `${observation.entrance} must reach the exact Registry binding`);
    assert.equal(observation.contractFingerprint, reference.contractFingerprint, `${observation.entrance} must use the exact canonical contract fingerprint`);
    assert.deepEqual(observation.artifact, reference.artifact, `${observation.entrance} must produce the same semantic artifact result`);
    assert.deepEqual(observation.operation, reference.operation, `${observation.entrance} must persist the same semantic Artifact Operation`);
    assert.deepEqual(observation.error, reference.error, `${observation.entrance} must have the same successful error result`);
    assert.equal(observation.execution.commandId, "artifact.create");
    assert.equal(observation.execution.status, "completed");
  }
  assert.deepEqual(
    observations.map((observation) => observation.source).sort(),
    ["generated_surface", "provider_tool_call", "provider_tool_call", "provider_tool_call", "runtime_api", "surface_operation"].sort(),
    "each entrance must preserve its server-owned final source"
  );

  process.stdout.write(`${JSON.stringify({
    status: "passed",
    gates: ["IN01", "IN02", "IN03", "IN12"],
    operation: "artifact.create",
    entrances: observations.map(({ entrance, source }) => ({ entrance, source })),
    binding: reference.binding,
    contract_fingerprint: reference.contractFingerprint,
    result_parity: true,
    error_parity: true,
    rejection_parity: {
      error: { code: artifactCreateInvalidInputCode },
      entrances: rejections.map(({ entrance, handlerReached, artifactCommandSideEffects }) => ({ entrance, handlerReached, artifactCommandSideEffects }))
    },
    artifact_operation_parity: true,
    workspace_change_telemetry: observations.map(({ entrance, workspaceChangeTelemetry }) => ({ entrance, ...workspaceChangeTelemetry })),
    direct_store_mutation: false
  })}\n`);
} finally {
  debugStage("cleanup-start");
  DomainOperationRegistry.prototype.execute = originalExecute;
  let cleanupError: unknown;
  try {
    await withIngressTimeout("cleanup:closeApiServer", () => closeApiServer(server));
  } catch (error) {
    cleanupError = error;
    debugStage(`cleanup-server-error:${error instanceof Error ? error.message : String(error)}`);
  }
  // Keep the late error listener attached when listen failed. Node may emit
  // the deferred bind error after closeApiServer has already run; removing it
  // here would turn a classified ingress failure into an uncaught exception.
  debugStage("cleanup-server-closed");
  try {
    await rm(root, { recursive: true, force: true });
  } catch (error) {
    cleanupError ??= error;
    debugStage(`cleanup-root-error:${error instanceof Error ? error.message : String(error)}`);
  }
  const activeResources = typeof process.getActiveResourcesInfo === "function"
    ? process.getActiveResourcesInfo()
    : [];
  if (process.env.SAMURAI_INGRESS_DEBUG === "1") {
    process.stderr.write(`[domain-command-ingress] cleanup-active-resources:${JSON.stringify(activeResources)}\n`);
  }
  debugStage("cleanup-complete");
  if (cleanupError) throw cleanupError;
}

async function observeArtifactCreate(
  entrance: IngressObservation["entrance"],
  execute: () => Promise<void>
): Promise<IngressObservation> {
  return withIngressTimeout(`entrance:${entrance}`, () => observeArtifactCreateInner(entrance, execute));
}

async function observeArtifactCreateInner(
  entrance: IngressObservation["entrance"],
  execute: () => Promise<void>
): Promise<IngressObservation> {
  const captureStart = captured.length;
  const artifactsBefore = new Set((await server.store.listArtifacts()).map((artifact) => artifact.id));
  const executionsBefore = new Set((await server.store.listDomainCommandExecutions()).map((execution) => execution.idempotency_key));
  await execute();
  const newCaptures = captured.slice(captureStart);
  assert.equal(newCaptures.length, 1, `${entrance} must execute artifact.create exactly once`);
  const capture = newCaptures[0]!;
  const artifacts = (await server.store.listArtifacts()).filter((artifact) => !artifactsBefore.has(artifact.id));
  assert.equal(artifacts.length, 1, `${entrance} must create exactly one artifact`);
  const artifact = artifacts[0]!;
  const changes = (await server.store.listWorkspaceChanges()).filter((change) =>
    change.resource_ref.kind === "artifact" && change.resource_ref.id === artifact.id
  );
  assert.equal(
    changes.length,
    expectedWorkspaceChangeTelemetryCount[entrance],
    `${entrance} must record exactly the expected BackendRun telemetry and no direct duplicate`
  );
  const operation = await server.store.getOperation(artifact.source_operation_id);
  assert.ok(operation, `${entrance} artifact must have a persisted Artifact Operation`);
  const telemetryRuns = await Promise.all(changes.map((change) => server.store.getBackendRun(change.run_id)));
  assert.equal(telemetryRuns.every(Boolean), true, `${entrance} WorkspaceChange telemetry must point at a real BackendRun`);
  const newExecutions = (await server.store.listDomainCommandExecutions()).filter((execution) => !executionsBefore.has(execution.idempotency_key) && execution.command_id === "artifact.create");
  assert.equal(newExecutions.length, 1, `${entrance} must persist one artifact.create execution`);
  const execution = newExecutions[0]!;
  assert.equal(execution.input_source, capture.source, `${entrance} stored execution source must equal Handler context source`);
  assert.equal(execution.correlation_id, capture.correlationId, `${entrance} execution must retain the Registry correlation`);
  assert.equal(operation.correlation_id, capture.correlationId, `${entrance} Operation must retain the Registry correlation`);
  assert.equal(changes.every((change) => change.correlation_id === capture.correlationId), true, `${entrance} WorkspaceChange must retain the Registry correlation`);

  return {
    entrance,
    source: capture.source,
    binding: capture.binding,
    contractFingerprint: capture.contractFingerprint,
    artifact: await semanticArtifact(artifact),
    operation: semanticOperation(operation),
    workspaceChangeTelemetry: {
      count: changes.length,
      allLinkedToRealBackendRuns: telemetryRuns.every(Boolean)
    },
    execution: {
      commandId: execution.command_id,
      inputSource: execution.input_source,
      correlationId: execution.correlation_id,
      status: execution.status
    },
    error: null
  };
}

async function observeArtifactCreateRejection(
  entrance: IngressRejectionObservation["entrance"],
  execute: () => Promise<IngressRejectionObservation["error"]>
): Promise<IngressRejectionObservation> {
  return withIngressTimeout(`rejection:${entrance}`, () => observeArtifactCreateRejectionInner(entrance, execute));
}

async function observeArtifactCreateRejectionInner(
  entrance: IngressRejectionObservation["entrance"],
  execute: () => Promise<IngressRejectionObservation["error"]>
): Promise<IngressRejectionObservation> {
  const captureStart = captured.length;
  const artifactsBefore = new Set((await server.store.listArtifacts()).map((artifact) => artifact.id));
  const artifactOperationsBefore = new Set((await server.store.listOperations())
    .filter((operation) => operation.operation === "artifact.create")
    .map((operation) => operation.id));
  const artifactExecutionsBefore = new Set((await server.store.listDomainCommandExecutions())
    .filter((execution) => execution.command_id === "artifact.create")
    .map((execution) => execution.idempotency_key));
  const error = await execute();
  assert.equal(captured.slice(captureStart).length, 0, `${entrance} invalid input must not reach the artifact.create Registry Handler boundary`);
  assert.equal((await server.store.listArtifacts()).filter((artifact) => !artifactsBefore.has(artifact.id)).length, 0, `${entrance} invalid input must not create an Artifact`);
  assert.equal(
    (await server.store.listOperations()).filter((operation) => operation.operation === "artifact.create" && !artifactOperationsBefore.has(operation.id)).length,
    0,
    `${entrance} invalid input must not create an Artifact Operation`
  );
  assert.equal(
    (await server.store.listDomainCommandExecutions()).filter((execution) => execution.command_id === "artifact.create" && !artifactExecutionsBefore.has(execution.idempotency_key)).length,
    0,
    `${entrance} invalid input must not create an artifact.create execution`
  );
  return { entrance, error, handlerReached: false, artifactCommandSideEffects: 0 };
}

async function withBridgeArtifactPayload<TResult>(
  payload: Record<string, JsonValue>,
  execute: () => Promise<TResult>
): Promise<TResult> {
  const previous = bridgeArtifactPayload;
  bridgeArtifactPayload = structuredClone(payload);
  try {
    return await execute();
  } finally {
    bridgeArtifactPayload = previous;
  }
}

async function backendToolDomainError(execute: () => Promise<unknown>): Promise<IngressRejectionObservation["error"]> {
  latestBridgeRunId = undefined;
  await execute();
  assert.ok(latestBridgeRunId, "backend ingress must create a real BackendRun");
  const events = await server.store.listBackendEvents({ runId: latestBridgeRunId });
  const failedToolOutput = [...events].reverse().find((event) => {
    if (event.event_type !== "tool_call_output") return false;
    const payload = record(event.payload);
    return payload.status === "failed" && payload.action_id === "artifact.create";
  });
  assert.ok(failedToolOutput, "backend ingress must persist a failed artifact.create tool output");
  const payload = record(failedToolOutput.payload);
  const error = domainError({ code: payload.error_code, message: payload.reason }, "backend tool output");
  // The output event alone is not evidence of a durable failure contract.
  // Re-read the persisted ToolRun so diagnostics/recovery see the same stable
  // code after the Backend event stream is gone.
  const persistedToolRuns = await server.store.listToolRuns({ runId: latestBridgeRunId });
  const failedToolRun = persistedToolRuns.find((toolRun) =>
    toolRun.status === "failed" && toolRun.action_id === "artifact.create"
  );
  assert.ok(failedToolRun, "backend ingress must persist a failed artifact.create ToolRun");
  assert.equal(
    failedToolRun.error_code,
    error.code,
    "persisted ToolRun must retain the stable artifact.create failure code"
  );
  return error;
}

async function thrownDomainError(execute: () => Promise<unknown>): Promise<IngressRejectionObservation["error"]> {
  try {
    await execute();
  } catch (error) {
    const candidate = error as { code?: unknown; message?: unknown };
    if (process.env.SAMURAI_INGRESS_DEBUG === "1") process.stderr.write(`[domain-command-ingress] thrown-domain-error:${JSON.stringify({ code: candidate.code, message: candidate.message })}\n`);
    return domainError(candidate, "Runtime error");
  }
  assert.fail("invalid artifact.create input unexpectedly succeeded");
}

function httpDomainError(value: unknown): IngressRejectionObservation["error"] {
  return domainError(record(record(value).error), "HTTP error response");
}

function domainError(value: { code?: unknown; error?: unknown; message?: unknown }, label: string): IngressRejectionObservation["error"] {
  const code = typeof value.code === "string" ? value.code : value.error;
  assert.equal(typeof code, "string", `${label} must preserve an error code`);
  assert.equal(typeof value.message, "string", `${label} must preserve an error message`);
  return { code: code as string };
}

function record(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), "expected object record");
  return value as Record<string, unknown>;
}

async function semanticArtifact(artifact: ArtifactRecord): Promise<IngressObservation["artifact"]> {
  return {
    title: artifact.title,
    kind: artifact.kind,
    locale: artifact.locale,
    sourceLocales: artifact.source_locales,
    content: await server.store.readArtifactContent(artifact.id)
  };
}

function semanticOperation(operation: OperationRecord): IngressObservation["operation"] {
  return {
    operation: operation.operation,
    status: operation.status,
    resultKind: operation.result_ref?.kind ?? "none"
  };
}
