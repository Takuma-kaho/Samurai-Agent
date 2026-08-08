import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { JsonValue } from "@samurai-agent/core-schemas";
import { PluginRuntimeRegistry } from "../../packages/action-catalog/src/index";
import { AgentBackendRegistry, type AgentBackend } from "../../packages/agent-backends/src/index";
import { DomainOperationRegistry } from "../../packages/domain-operations/src/registry/operation-registry";
import { localOwnerParticipantId } from "../../packages/room-permissions/src/index";
import { AgentRuntime } from "../../packages/runtime/src/index";
import { WorkspaceStore } from "../../packages/workspace-store/src/index";
import { assertTrustedRuntimePayload, resolveTrustedRuntimeApiInput } from "../../apps/server/src/domain-ingress";

const store = {
  async getSession(id: string) {
    return id === "known-session" ? { id } : undefined;
  },
  async getBackendRun() {
    return undefined;
  }
};

for (const key of ["workspace_id", "actor_id", "actor_identity", "correlation_id", "source", "input_source", "envelope_id"] as const) {
  await assert.rejects(
    assertTrustedRuntimePayload(store, { [key]: "forged" } as Record<string, JsonValue>, requestError),
    new RegExp(`untrusted_domain_context:${key}`)
  );
}
await assert.rejects(
  assertTrustedRuntimePayload(store, { session_id: "forged-session" }, requestError),
  /untrusted_domain_context:session_id/
);
assert.deepEqual(
  await resolveTrustedRuntimeApiInput(store, { content: "trusted" }, { sessionId: "known-session" }, requestError),
  { payload: { content: "trusted" }, context: { sessionId: "known-session" } }
);

// Provider tool input is untrusted even after the backend run itself has been
// authenticated.  Capture the real Domain Operation Registry call immediately
// before its handler so this fixture proves the handler never receives forged
// run/session/request/time values.
const workspaceRoot = await mkdtemp(path.join(tmpdir(), "samurai-trusted-generated-surface-"));
const workspace = await WorkspaceStore.create({ rootDir: workspaceRoot });
const foreignWorkspaceRoot = await mkdtemp(path.join(tmpdir(), "samurai-trusted-foreign-workspace-"));
const foreignWorkspace = await WorkspaceStore.create({ rootDir: foreignWorkspaceRoot });
const fixtureCreatedAt = new Date(0).toISOString();
await foreignWorkspace.createRoom({
  id: "foreign-trusted-room",
  name: "Foreign Trusted Room",
  created_at: fixtureCreatedAt,
  updated_at: fixtureCreatedAt
});
const foreignSession = await foreignWorkspace.createSession({
  id: "foreign-trusted-surface-session",
  session_key: "foreign-trusted-surface-session",
  room_id: "foreign-trusted-room",
  title: "Foreign Trusted Generated Surface",
  ui_locale: "en",
  output_locale: "en",
  created_at: fixtureCreatedAt,
  updated_at: fixtureCreatedAt
});
let runtime: AgentRuntime;
let restrictedInventoryRuntime: AgentRuntime | undefined;
type GeneratedSurfacePhase = "create" | "revise";
let phase: GeneratedSurfacePhase = "create";
const runIds: Partial<Record<GeneratedSurfacePhase, string>> = {};
const handlerInputs: Array<{
  command_id: string;
  payload: Record<string, JsonValue>;
  context: { inputSource: string; runId?: string; sessionId?: string };
}> = [];
let foreignSessionArtifactHandlerCalls = 0;
const registryPrototype = DomainOperationRegistry.prototype as unknown as {
  execute: (...args: any[]) => Promise<{ value: unknown }>;
};
const originalRegistryExecute = registryPrototype.execute;

const validProviderRequest = (kind: GeneratedSurfacePhase) => ({
  user_intent: `provider-request-intent-${kind}`,
  source_resource_refs: [],
  allowed_domain_commands: [],
  selected_knowledge_refs: [],
  selected_skill_refs: [],
  client_capabilities: { generated_surface: false },
  expected_lifetime: "session",
  fallback_chain: ["built_in_surface", "artifact", "text"]
});

const forgedRequestFields = (kind: GeneratedSurfacePhase): ReadonlyArray<readonly [string, Record<string, JsonValue>]> => [
  ["request.id", { id: `forged-request-${kind}` }],
  ["request.session_id", { session_id: "forged-session" }],
  ["request.created_at", { created_at: "2001-01-01T00:00:00.000Z" }],
  ["request.producer_run_id", { producer_run_id: `forged-request-producer-run-${kind}` }],
  // Provider input may describe a surface, but must never provide any part of
  // Runtime context.  These must reject before normalization/Handler entry;
  // silently dropping them would hide a confused-identity attempt.
  ["workspace_id", { workspace_id: "forged-workspace" }],
  ["actor_id", { actor_id: "forged-actor" }],
  ["actor_identity", { actor_identity: "forged-identity" }],
  ["correlation_id", { correlation_id: "forged-correlation" }],
  ["source", { source: "gateway_inbound" }],
  ["input_source", { input_source: "runtime_api" }],
  ["session_id", { session_id: "forged-session" }],
  ["envelope_id", { envelope_id: "forged-envelope" }],
  ["input_message_id", { input_message_id: "forged-input-message" }],
  ["run_id", { run_id: "forged-run" }],
  ["created_at", { created_at: "2001-01-01T00:00:00.000Z" }],
  ["producer_run_id", { producer_run_id: `forged-producer-run-${kind}` }],
  ["prompt_fingerprint", { prompt_fingerprint: `forged-prompt-fingerprint-${kind}` }],
  ...(kind === "revise" ? [["surface_id", { surface_id: "forged-surface-id" }] as const] : [])
];

function validProviderToolInput(kind: GeneratedSurfacePhase): Record<string, JsonValue> {
  return {
    request: validProviderRequest(kind),
    bundle: {
      title: `Trusted ${kind} surface`,
      html: `<main>${kind}</main>`,
      actions: []
    }
  };
}

const bridgeBackend: AgentBackend = {
  id: "trusted-context-generated-surface-backend",
  kind: "codex",
  label: "Trusted context generated surface fixture",
  sessionPolicy: { acquisition: "none", resume: "unsupported" },
  execution_owner: "host",
  async *runTurn(input) {
    const currentPhase = phase;
    runIds[currentPhase] = input.run_id;
    const toolName = currentPhase === "create" ? "samurai.generated_surface.create" : "samurai.generated_surface.revise";
    const handlersBeforeSpoof = handlerInputs.length;
    for (const [field, injected] of forgedRequestFields(currentPhase)) {
      const valid = validProviderToolInput(currentPhase);
      const request = valid.request as Record<string, JsonValue>;
      const toolInput = field.startsWith("request.")
        ? { ...valid, request: { ...request, ...injected } }
        : { ...valid, ...injected };
      await expectProviderSpoofRejection(
        runtime.runBackendToolBridgeCall({
          runId: input.run_id,
          token: input.tool_bridge?.token ?? "",
          toolName,
          toolCallId: `trusted-${currentPhase}-spoof-${field.replaceAll(".", "-")}`,
          toolInput
        }),
        `${field} must be rejected before the Generated Surface handler`
      );
      assert.equal(handlerInputs.length, handlersBeforeSpoof, `${field} reached the Generated Surface handler`);
    }
    await runtime.runBackendToolBridgeCall({
      runId: input.run_id,
      token: input.tool_bridge?.token ?? "",
      toolName,
      toolCallId: `trusted-${currentPhase}-tool-call`,
      toolInput: validProviderToolInput(currentPhase)
    });
    yield {
      event_type: "run_completed",
      terminal_evidence: { kind: "completed", source: "provider_terminal_response" },
      payload: { output_summary: `${currentPhase} completed` }
    };
  }
};

// This backend uses the ordinary Provider event contract, rather than the
// authenticated tool-bridge helper above.  It protects the normal Command and
// Query normalizers from silently dropping forged context or unknown fields.
type NormalProviderProbe = {
  id: string;
  kind: "command" | "query";
  operationId: "artifact.create" | "skill.view";
  providerToolName: string;
  input: Record<string, JsonValue>;
  expectedErrorCode: "conflict" | "validation";
  expectedDiagnostic: string;
};

const ordinaryProviderServerOwnedFields = [
  "workspace_id",
  "actor_id",
  "actor_identity",
  "correlation_id",
  "source",
  "input_source",
  "session_id",
  "envelope_id",
  "input_message_id",
  "run_id",
  "producer_run_id",
  "prompt_fingerprint",
  "created_at"
] as const;

let activeNormalProviderProbe: NormalProviderProbe | undefined;
const normalProviderHandlerCalls: Array<{ probeId: string; operationId: string }> = [];
const normalProviderBackend: AgentBackend = {
  id: "trusted-context-normal-provider-backend",
  kind: "codex",
  label: "Trusted context ordinary Provider fixture",
  sessionPolicy: { acquisition: "none", resume: "unsupported" },
  execution_owner: "host",
  async *runTurn(input) {
    const probe = activeNormalProviderProbe;
    assert.ok(probe, "ordinary Provider backend was invoked without a probe");
    const toolCallId = normalProviderToolCallId(probe.id);
    // The event is what a normal provider emits.  In particular, it is not
    // marked as an already-executed Samurai tool bridge call.
    yield {
      event_type: "tool_call_started",
      tool_call_id: toolCallId,
      payload: {
        provider_tool_name: probe.providerToolName,
        action_id: probe.operationId,
        input: probe.input
      }
    };
    yield {
      event_type: "run_completed",
      terminal_evidence: { kind: "completed", source: "provider_terminal_response" },
      payload: { output_summary: `${probe.id} completed` }
    };
  }
};

try {
  registryPrototype.execute = async function trustedContextCapture(...args: any[]) {
    const [context, commandId, payload] = args as [{ inputSource: string; runId?: string; sessionId?: string }, string, Record<string, JsonValue>];
    if (activeNormalProviderProbe && commandId === activeNormalProviderProbe.operationId) {
      normalProviderHandlerCalls.push({ probeId: activeNormalProviderProbe.id, operationId: commandId });
    }
    if (commandId === "artifact.create") {
      foreignSessionArtifactHandlerCalls += 1;
    }
    if (commandId === "generated_surface.create" || commandId === "generated_surface.revise") {
      handlerInputs.push({
        command_id: commandId,
        payload: structuredClone(payload),
        context: {
          inputSource: context.inputSource,
          ...(context.runId ? { runId: context.runId } : {}),
          ...(context.sessionId ? { sessionId: context.sessionId } : {})
        }
      });
    }
    return originalRegistryExecute.apply(this, args);
  };
  runtime = new AgentRuntime(workspace, undefined, undefined, new AgentBackendRegistry([bridgeBackend, normalProviderBackend]));
  await workspace.createRoom({
    id: "trusted-room",
    name: "Trusted Room",
    created_at: fixtureCreatedAt,
    updated_at: fixtureCreatedAt
  });
  await workspace.createAgent({
    id: "trusted-agent",
    name: "Trusted Agent",
    role: "Integration",
    instructions: "Handle the trusted context fixture.",
    backend_id: bridgeBackend.id,
    enabled: true,
    created_at: fixtureCreatedAt,
    updated_at: fixtureCreatedAt
  });
  await workspace.setRoomAgentPermissions({
    roomId: "trusted-room",
    agentId: "trusted-agent",
    canView: true,
    canEdit: true,
    canExecute: true,
    actorId: localOwnerParticipantId
  });
  await workspace.patchSettings({ default_room_id: "trusted-room", default_agent_id: "trusted-agent" });

  // A Session ID may exist in another Workspace, but it is not trusted by the
  // current Runtime. This is the real isolation boundary in the current
  // single-profile model; there is deliberately no invented per-actor owner.
  await assert.rejects(
    runtime.runRuntimeApiDomainCommand({
      command_id: "artifact.create",
      idempotency_key: "foreign-workspace-artifact-create",
      payload: {
        title: "Foreign workspace artifact",
        content: "must not be written",
        kind: "document",
        input_locale: "en",
        output_locale: "en",
        metadata: {}
      }
    }, { sessionId: foreignSession.id }),
    /Session not found: foreign-trusted-surface-session/
  );
  assert.equal(foreignSessionArtifactHandlerCalls, 0, "a foreign Workspace Session must be rejected before the Artifact Handler");

  const session = await workspace.createSession({
    id: "trusted-surface-session",
    session_key: "trusted-surface-session",
    room_id: "trusted-room",
    title: "Trusted Generated Surface",
    ui_locale: "en",
    output_locale: "en",
    created_at: fixtureCreatedAt,
    updated_at: fixtureCreatedAt
  });

  // IN07 is an actual effective-inventory check, not a label. The normal
  // Runtime has an available Backend and the built-in Plugin registry; this
  // isolated Runtime has neither. Source selection is checked separately.
  const runtimeApiInventory = await runtime.listEffectiveDomainOperations(session.id, "runtime_api", { kind: "human", participantId: localOwnerParticipantId });
  const providerInventory = await runtime.listEffectiveDomainOperations(session.id, "provider_tool_call", { kind: "human", participantId: localOwnerParticipantId });
  restrictedInventoryRuntime = new AgentRuntime(
    workspace,
    undefined,
    undefined,
    new AgentBackendRegistry([]),
    new PluginRuntimeRegistry({ manifests: [], actions: [] })
  );
  const restrictedInventory = await restrictedInventoryRuntime.listEffectiveDomainOperations(session.id, "runtime_api", { kind: "human", participantId: localOwnerParticipantId });
  const runtimeApiIds = effectiveInventoryIds(runtimeApiInventory);
  const providerIds = effectiveInventoryIds(providerInventory);
  const restrictedIds = effectiveInventoryIds(restrictedInventory);
  assert.equal(runtimeApiIds.has("chat.turn.run"), true, "a ready Backend must expose chat.turn.run");
  assert.equal(runtimeApiIds.has("plugin.status.set"), true, "an available Plugin registry must expose plugin.status.set");
  assert.equal(restrictedIds.has("chat.turn.run"), false, "a Runtime without a ready Backend must hide chat.turn.run");
  assert.equal(restrictedIds.has("plugin.status.set"), false, "a Runtime without Plugin state must hide plugin.status.set");
  assert.equal(runtimeApiIds.has("session.create"), true, "runtime_api inventory must include its session command");
  assert.equal(providerIds.has("session.create"), false, "provider_tool_call inventory must not expose runtime-only session.create");
  assert.equal(providerIds.has("artifact.create"), true, "provider_tool_call inventory must expose its registered artifact command");

  // IN04/IN05 apply to ordinary Provider operations too, not just Generated
  // Surface.  Test every server-owned top-level field for both a normal
  // Command and a normal Query, plus an unknown input field for each.  Every
  // rejection must occur before the Registry Handler and must leave no
  // completed ToolRun or operation behind.
  const normalProviderProbes = normalProviderRejectionProbes();
  const normalProviderFailures: Array<{ probe_id: string; message: string }> = [];
  for (const probe of normalProviderProbes) {
    try {
      await assertNormalProviderProbeRejected({ runtime, workspace, sessionId: session.id, probe });
    } catch (error) {
      normalProviderFailures.push({
        probe_id: probe.id,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }
  if (normalProviderFailures.length > 0) {
    process.stderr.write(`${JSON.stringify({
      status: "failed",
      gate: "ordinary_provider_rejections",
      checked: normalProviderProbes.length,
      failures: normalProviderFailures
    }, null, 2)}\n`);
    throw new Error(`ordinary_provider_rejection_checks_failed:${normalProviderFailures.length}`);
  }

  const createIntent = "Create a trusted generated surface";
  const createStartedAt = Date.now();
  await runtime.runChatTurn({ sessionId: session.id, content: createIntent, backend_id: bridgeBackend.id });
  const createFinishedAt = Date.now();
  const createInput = handlerInputs.find((input) => input.command_id === "generated_surface.create");
  assert.ok(createInput, "generated_surface.create did not reach its registered handler");
  assertTrustedGeneratedSurfaceHandlerInput(createInput, {
    commandId: "generated_surface.create",
    sessionId: session.id,
    runId: runIds.create,
    expectedRequestIntent: createIntent
  });

  const createdSurfaces = await workspace.listGeneratedSurfaces(session.id);
  assert.equal(createdSurfaces.length, 1, "provider payload must not move the surface into a forged session");
  const created = createdSurfaces[0]!;
  const createRevision = await workspace.getGeneratedSurfaceRevision(created.current_revision_id);
  assert.equal(created.session_id, session.id);
  assert.equal(created.generation_run_id, runIds.create);
  assert.equal(createRevision?.producer_run_id, runIds.create);
  assertServerOwnedTime(created.created_at, createStartedAt, createFinishedAt, "created definition time");
  assertServerOwnedTime(createRevision?.created_at, createStartedAt, createFinishedAt, "created revision time");

  const trustedContextProbePayload = {
    title: "Trusted context probe",
    content: "must not accept caller identity",
    kind: "document",
    input_locale: "en",
    output_locale: "en",
    metadata: {}
  } as const;
  for (const field of ["actor_id", "actor_identity", "session_id", "run_id"] as const) {
    await assert.rejects(
      runtime.runRuntimeApiDomainCommand({
        command_id: "artifact.create",
        idempotency_key: `trusted-context-payload-${field}`,
        payload: { ...trustedContextProbePayload, [field]: "forged" } as Record<string, JsonValue>
      }, { sessionId: session.id }),
      new RegExp(`untrusted_domain_context:${field}`)
    );
  }
  await assert.rejects(
    runtime.runRuntimeApiDomainCommand({
      command_id: "artifact.create",
      idempotency_key: "trusted-context-actor-source-mismatch",
      payload: trustedContextProbePayload
    }, { sessionId: session.id, actorIdentity: "paired_contact" }),
    /domain_actor_source_mismatch:runtime_api/
  );
  await assert.rejects(
    runtime.runRuntimeApiDomainCommand({
      command_id: "artifact.create",
      idempotency_key: "trusted-context-run-session-mismatch",
      payload: trustedContextProbePayload
    }, { runId: runIds.create, sessionId: foreignSession.id }),
    /domain_run_session_mismatch:/
  );

  phase = "revise";
  const reviseIntent = "Revise the trusted generated surface";
  const reviseStartedAt = Date.now();
  await runtime.runChatTurn({
    sessionId: session.id,
    content: reviseIntent,
    backend_id: bridgeBackend.id,
    metadata: { active_app_context: { generated_surface_id: created.id } }
  });
  const reviseFinishedAt = Date.now();
  const reviseInput = handlerInputs.find((input) => input.command_id === "generated_surface.revise");
  assert.ok(reviseInput, "generated_surface.revise did not reach its registered handler");
  assertTrustedGeneratedSurfaceHandlerInput(reviseInput, {
    commandId: "generated_surface.revise",
    sessionId: session.id,
    runId: runIds.revise,
    expectedRequestIntent: reviseIntent,
    surfaceId: created.id
  });

  const revised = await workspace.getGeneratedSurface(created.id);
  assert.equal(revised?.session_id, session.id);
  assert.equal(revised?.generation_run_id, runIds.revise);
  assert.equal(revised?.current_revision, 2);
  const reviseRevision = revised ? await workspace.getGeneratedSurfaceRevision(revised.current_revision_id) : undefined;
  assert.equal(reviseRevision?.producer_run_id, runIds.revise);
  assertServerOwnedTime(reviseRevision?.created_at, reviseStartedAt, reviseFinishedAt, "revised revision time");
} finally {
  registryPrototype.execute = originalRegistryExecute;
  await runtime?.shutdownMcpProcessPool().catch(() => undefined);
  await restrictedInventoryRuntime?.shutdownMcpProcessPool().catch(() => undefined);
  await workspace.close().catch(() => undefined);
  await foreignWorkspace.close().catch(() => undefined);
  await rm(workspaceRoot, { recursive: true, force: true });
  await rm(foreignWorkspaceRoot, { recursive: true, force: true });
}

process.stdout.write(`${JSON.stringify({
  status: "passed",
  gates: ["IN04", "IN05", "IN06", "IN07"],
  workspace_spoof_rejected: true,
  actor_spoof_rejected: true,
  source_spoof_rejected: true,
  correlation_spoof_rejected: true,
  session_spoof_rejected: true,
  cross_workspace_session_rejected_before_handler: true,
  effective_inventory_changes_with_backend_plugin_and_source_state: true,
  ordinary_provider_command_server_context_rejected_before_handler: true,
  ordinary_provider_command_unknown_field_rejected_before_handler: true,
  ordinary_provider_query_server_context_rejected_before_handler: true,
  ordinary_provider_query_unknown_field_rejected_before_handler: true,
  ordinary_provider_rejection_cases: normalProviderRejectionProbes().length,
  provider_generated_surface_create_sanitized_before_handler: true,
  provider_generated_surface_revise_sanitized_before_handler: true,
  generated_surface_context_invariant: true,
  runtime_payload_actor_session_rejected: true,
  runtime_actor_source_mismatch_rejected: true,
  runtime_run_session_mismatch_rejected: true
})}\n`);

function requestError(code: "bad_request" | "not_found", message: string): Error {
  return Object.assign(new Error(message), { code });
}

function assertTrustedGeneratedSurfaceHandlerInput(
  input: {
    command_id: string;
    payload: Record<string, JsonValue>;
    context: { inputSource: string; runId?: string; sessionId?: string };
  },
  expected: {
    commandId: string;
    sessionId: string;
    runId: string | undefined;
    expectedRequestIntent: string;
    surfaceId?: string;
  }
): void {
  assert.equal(input.command_id, expected.commandId);
  assert.equal(input.context.inputSource, "provider_tool_call");
  assert.equal(input.context.runId, expected.runId);
  assert.equal(input.context.sessionId, expected.sessionId);
  const request = input.payload.request;
  assert.ok(request && typeof request === "object" && !Array.isArray(request), "Generated Surface handler must receive a normalized request");
  const normalized = request as Record<string, JsonValue>;
  assert.equal(normalized.user_intent, expected.expectedRequestIntent);
  for (const key of ["id", "session_id", "created_at", "producer_run_id"] as const) {
    assert.equal(Object.hasOwn(normalized, key), false, `untrusted request.${key} reached the handler`);
  }
  for (const key of ["producer_run_id", "prompt_fingerprint"] as const) {
    assert.equal(Object.hasOwn(input.payload, key), false, `untrusted payload.${key} reached the handler`);
  }
  if (expected.surfaceId) {
    assert.equal(input.payload.surface_id, expected.surfaceId);
  }
}

function isProviderSpoofRejection(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { code?: unknown; message?: unknown };
  return value.code === "conflict"
    && typeof value.message === "string"
    && (value.message.includes("domain_command_input_invalid:generated_surface.")
      || value.message.startsWith("untrusted_generated_surface_"));
}

async function expectProviderSpoofRejection(operation: Promise<unknown>, message: string): Promise<void> {
  let rejected = false;
  let error: unknown;
  try {
    await operation;
  } catch (caught) {
    rejected = true;
    error = caught;
  }
  assert.equal(rejected, true, `${message}: expected a rejection`);
  assert.equal(isProviderSpoofRejection(error), true, `${message}: ${describeRejection(error)}`);
}

function describeRejection(error: unknown): string {
  if (!error || typeof error !== "object") return String(error);
  const value = error as { name?: unknown; code?: unknown; message?: unknown };
  return JSON.stringify({
    name: value.name,
    code: value.code,
    message: value.message
  });
}

function normalProviderRejectionProbes(): NormalProviderProbe[] {
  const commandInput: Record<string, JsonValue> = {
    title: "Ordinary Provider rejection fixture",
    content: "This must never reach the Artifact Handler.",
    kind: "document",
    input_locale: "en",
    output_locale: "en",
    metadata: {}
  };
  // skill.view receives BackendRun identity only through Runtime context.
  // Provider payload must never provide a run_id field.
  const queryInput: Record<string, JsonValue> = { skill_id: "ordinary-provider-missing-skill" };
  const serverOwned = ordinaryProviderServerOwnedFields.flatMap((field): NormalProviderProbe[] => [
    {
      id: `ordinary-command-server-owned-${field}`,
      kind: "command",
      operationId: "artifact.create",
      providerToolName: "mcp__samurai__artifact_create",
      input: { ...commandInput, [field]: `forged-${field}` },
      expectedErrorCode: "conflict",
      expectedDiagnostic: "runtime_tool_failed:conflict"
    },
    {
      id: `ordinary-query-server-owned-${field}`,
      kind: "query",
      operationId: "skill.view",
      providerToolName: "mcp__samurai__skill_view",
      input: { ...queryInput, [field]: `forged-${field}` },
      expectedErrorCode: "conflict",
      expectedDiagnostic: "runtime_tool_failed:conflict"
    }
  ]);
  return [
    ...serverOwned,
    {
      id: "ordinary-command-unknown-field",
      kind: "command",
      operationId: "artifact.create",
      providerToolName: "mcp__samurai__artifact_create",
      input: { ...commandInput, unknown_provider_field: "forged" },
      expectedErrorCode: "validation",
      expectedDiagnostic: "runtime_tool_failed:validation"
    },
    {
      id: "ordinary-query-unknown-field",
      kind: "query",
      operationId: "skill.view",
      providerToolName: "mcp__samurai__skill_view",
      input: { ...queryInput, unknown_provider_field: "forged" },
      expectedErrorCode: "validation",
      expectedDiagnostic: "runtime_tool_failed:validation"
    }
  ];
}

async function assertNormalProviderProbeRejected(input: {
  runtime: AgentRuntime;
  workspace: WorkspaceStore;
  sessionId: string;
  probe: NormalProviderProbe;
}): Promise<void> {
  assert.equal(activeNormalProviderProbe, undefined, `${input.probe.id} must not overlap another Provider probe`);
  const handlersBefore = normalProviderHandlerCalls.length;
  const artifactsBefore = new Set((await input.workspace.listArtifacts()).map((artifact) => artifact.id));
  const operationsBefore = new Set((await input.workspace.listOperations())
    .filter((operation) => operation.operation === input.probe.operationId)
    .map((operation) => operation.id));
  const commandExecutionsBefore = input.probe.kind === "command"
    ? new Set((await input.workspace.listDomainCommandExecutions())
      .filter((execution) => execution.command_id === input.probe.operationId)
      .map((execution) => execution.idempotency_key))
    : undefined;

  activeNormalProviderProbe = input.probe;
  let result: Awaited<ReturnType<AgentRuntime["runChatTurn"]>>;
  try {
    result = await input.runtime.runChatTurn({
      sessionId: input.sessionId,
      content: `Reject ${input.probe.id} before the Domain Operation Handler.`,
      backend_id: normalProviderBackend.id,
      idempotency_key: `trusted-context:${input.probe.id}`
    });
  } finally {
    activeNormalProviderProbe = undefined;
  }

  const toolCallId = normalProviderToolCallId(input.probe.id);
  const outputEvents = result.backendEvents.filter((event) =>
    event.event_type === "tool_call_output" && event.payload.tool_call_id === toolCallId
  );
  const storedEvents = await input.workspace.listBackendEvents({ runId: result.backendRun.id });
  const persistedToolRuns = (await input.workspace.listToolRuns({ runId: result.backendRun.id }))
    .filter((toolRun) => toolRun.tool_call_id === toolCallId);
  const rejectionDiagnostic = JSON.stringify({
    run_id: result.backendRun.id,
    expected_tool_call_id: toolCallId,
    result_events: result.backendEvents.map(compactBackendEvent),
    stored_events: storedEvents.map(compactBackendEvent),
    result_tool_runs: result.toolRuns.filter((toolRun) => toolRun.tool_call_id === toolCallId).map(compactToolRun),
    stored_tool_runs: persistedToolRuns.map(compactToolRun)
  });
  assert.equal(
    outputEvents.length,
    1,
    `${input.probe.id} must emit one stable Provider tool rejection: ${rejectionDiagnostic}`
  );
  const output = outputEvents[0]!.payload;
  assert.equal(output.status, "failed", `${input.probe.id} must never be reported as a successful Provider tool`);
  assert.equal(output.error_code, input.probe.expectedErrorCode, `${input.probe.id} must retain its typed Provider failure code`);
  assert.equal(output.reason, "runtime_tool_failed", `${input.probe.id} must expose only the stable Provider diagnostic`);

  const toolRuns = result.toolRuns.filter((toolRun) => toolRun.tool_call_id === toolCallId);
  if (input.probe.kind === "command") {
    assert.equal(toolRuns.length, 1, `${input.probe.id} must create one failed ToolRun`);
    assert.equal(toolRuns[0]!.status, "failed", `${input.probe.id} ToolRun must not be completed`);
    assert.equal(toolRuns[0]!.error_code, input.probe.expectedErrorCode, `${input.probe.id} ToolRun must retain the typed failure code`);
    assert.equal(toolRuns[0]!.output_summary, input.probe.expectedDiagnostic, `${input.probe.id} ToolRun diagnostic must be stable`);
    assert.equal(persistedToolRuns.length, 1, `${input.probe.id} must persist exactly one ToolRun`);
    assert.equal(persistedToolRuns[0]!.status, "failed", `${input.probe.id} persisted ToolRun must not be completed`);
    assert.equal(persistedToolRuns[0]!.error_code, input.probe.expectedErrorCode, `${input.probe.id} persisted ToolRun must retain the typed failure code`);
    assert.equal(persistedToolRuns[0]!.output_summary, input.probe.expectedDiagnostic, `${input.probe.id} persisted ToolRun diagnostic must be stable`);
  } else {
    // Query failures are observable through the terminal Provider event but
    // remain fully read-only: no Operation or ToolRun is persisted.
    assert.equal(toolRuns.length, 0, `${input.probe.id} query must not create a ToolRun`);
    assert.equal(persistedToolRuns.length, 0, `${input.probe.id} query must not persist a ToolRun`);
  }

  assert.equal(normalProviderHandlerCalls.slice(handlersBefore).length, 0, `${input.probe.id} must be rejected before its Handler`);
  assert.equal((await input.workspace.listArtifacts()).filter((artifact) => !artifactsBefore.has(artifact.id)).length, 0, `${input.probe.id} must not create an Artifact`);
  assert.equal((await input.workspace.listOperations())
    .filter((operation) => operation.operation === input.probe.operationId && !operationsBefore.has(operation.id)).length, 0,
  `${input.probe.id} must not create an Operation`);
  assert.equal(result.operations.filter((operation) => operation.operation === input.probe.operationId).length, 0, `${input.probe.id} must not report a successful operation`);
  assert.equal(toolRuns.some((toolRun) => toolRun.status === "completed"), false, `${input.probe.id} must have zero successful ToolRuns`);

  if (commandExecutionsBefore) {
    assert.equal((await input.workspace.listDomainCommandExecutions())
      .filter((execution) => execution.command_id === input.probe.operationId && !commandExecutionsBefore.has(execution.idempotency_key)).length, 0,
    `${input.probe.id} must not persist a Domain Command execution`);
  }
}

function assertServerOwnedTime(value: unknown, startedAt: number, finishedAt: number, label: string): void {
  assert.equal(typeof value, "string", `${label} is missing`);
  assert.notEqual(value, "2001-01-01T00:00:00.000Z", `${label} adopted provider time`);
  const timestamp = Date.parse(value);
  assert.ok(Number.isFinite(timestamp), `${label} is not a timestamp`);
  assert.ok(timestamp >= startedAt - 1_000 && timestamp <= finishedAt + 1_000, `${label} must use the server clock`);
}

function effectiveInventoryIds(inventory: { commands: Array<{ id: string }>; queries: Array<{ id: string }> }): Set<string> {
  return new Set([...inventory.commands, ...inventory.queries].map((entry) => entry.id));
}

function normalProviderToolCallId(probeId: string): string {
  return `trusted-context:${probeId}`;
}

function compactBackendEvent(event: { event_type: string; source_event_id?: string; source_sequence?: number; payload: Record<string, JsonValue> }): Record<string, JsonValue> {
  return {
    event_type: event.event_type,
    ...(event.source_event_id ? { source_event_id: event.source_event_id } : {}),
    ...(event.source_sequence !== undefined ? { source_sequence: event.source_sequence } : {}),
    ...(typeof event.payload.tool_call_id === "string" ? { tool_call_id: event.payload.tool_call_id } : {}),
    ...(typeof event.payload.status === "string" ? { status: event.payload.status } : {}),
    ...(typeof event.payload.error_code === "string" ? { error_code: event.payload.error_code } : {})
  };
}

function compactToolRun(toolRun: { id: string; tool_call_id?: string; status: string; error_code?: string }): Record<string, JsonValue> {
  return {
    id: toolRun.id,
    ...(toolRun.tool_call_id ? { tool_call_id: toolRun.tool_call_id } : {}),
    status: toolRun.status,
    ...(toolRun.error_code ? { error_code: toolRun.error_code } : {})
  };
}
