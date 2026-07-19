/**
 * B shard: executable Handler contract matrix.
 *
 * Each case constructs an explicit Fake Port object.  Port names, argument
 * values, call order and callback execution are compared with the independent
 * static expectations in domain-operation-handler-expectations-shard-b.ts.
 */
import assert from "node:assert/strict";
import type { TrustedDomainContext } from "../../packages/domain-operations/src/definition/index";
import automationJobReleaseLock from "../../packages/domain-operations/src/operations/automation/job/release_lock.operation";
import automationJobRequeue from "../../packages/domain-operations/src/operations/automation/job/requeue.operation";
import automationJobRun from "../../packages/domain-operations/src/operations/automation/job/run.operation";
import automationJobSave from "../../packages/domain-operations/src/operations/automation/job/save.operation";
import automationJobSetStatus from "../../packages/domain-operations/src/operations/automation/job/set_status.operation";
import automationMemoryReviewRun from "../../packages/domain-operations/src/operations/automation/memory_review/run.operation";
import browserInteract from "../../packages/domain-operations/src/operations/browser/interact.operation";
import browserNavigate from "../../packages/domain-operations/src/operations/browser/navigate.operation";
import chatTurnRun from "../../packages/domain-operations/src/operations/chat/turn/run.operation";
import externalSend from "../../packages/domain-operations/src/operations/external/send.operation";
import externalSendPrepare from "../../packages/domain-operations/src/operations/external/send/prepare.operation";
import externalSendDispatch from "../../packages/domain-operations/src/operations/external/send/dispatch.operation";
import gatewayInboundRoute from "../../packages/domain-operations/src/operations/gateway/inbound/route.operation";
import gatewayMcpConfigSave from "../../packages/domain-operations/src/operations/gateway/mcp_config/save.operation";
import gatewayPairingPolicySave from "../../packages/domain-operations/src/operations/gateway/pairing_policy/save.operation";
import gatewayPairingApprove from "../../packages/domain-operations/src/operations/gateway/pairing/approve.operation";
import gatewayPairingExpire from "../../packages/domain-operations/src/operations/gateway/pairing/expire.operation";
import gatewayPairingReject from "../../packages/domain-operations/src/operations/gateway/pairing/reject.operation";
import gatewayPairingRevoke from "../../packages/domain-operations/src/operations/gateway/pairing/revoke.operation";
import gatewayPairingRotate from "../../packages/domain-operations/src/operations/gateway/pairing/rotate.operation";
import gatewayRoutingPolicySave from "../../packages/domain-operations/src/operations/gateway/routing_policy/save.operation";
import gatewaySandboxDelete from "../../packages/domain-operations/src/operations/gateway/sandbox/delete.operation";
import gatewaySandboxRecreate from "../../packages/domain-operations/src/operations/gateway/sandbox/recreate.operation";
import gatewaySandboxSync from "../../packages/domain-operations/src/operations/gateway/sandbox/sync.operation";
import gatewayStateRepair from "../../packages/domain-operations/src/operations/gateway/state/repair.operation";
import imageEdit from "../../packages/domain-operations/src/operations/image/edit.operation";
import imageGenerate from "../../packages/domain-operations/src/operations/image/generate.operation";
import mcpCall from "../../packages/domain-operations/src/operations/mcp/call.operation";
import sandboxExec from "../../packages/domain-operations/src/operations/sandbox/exec.operation";
import {
  bHandlerCaseCount,
  bHandlerExpectations,
  bHandlerOperationCount,
  type BHandlerCallExpectation,
  type BHandlerCaseExpectation
} from "./domain-operation-handler-expectations-shard-b";

const now = "2026-07-17T00:00:00.000Z";
const context: TrustedDomainContext = {
  inputSource: "runtime_api",
  workspaceId: "handler-matrix-workspace",
  actorId: "handler-matrix-actor",
  correlationId: "handler-matrix",
  sessionId: "session_fixture",
  runId: "run_fixture"
};
const session = { id: "session_fixture", session_key: "session_fixture", title: "Fixture session", ui_locale: "en", output_locale: "en", created_at: now, updated_at: now };
const envelope = { id: "envelope_fixture", source: "web", actor_identity: "owner", session_key: "session_fixture", user_intent: "Fixture intent", attachments: [], input_locale: "en", output_locale: "en", metadata: {}, received_at: now };
const operation = { id: "operation_fixture", session_id: "session_fixture", capability_id: "fixture", operation: "fixture", actor_identity: "owner", instruction_source: "owner_instruction", instruction_authority: "owner", channel: "test", input_hash: "fixture_hash", target_resource_refs: [], proposed_effects: [], status: "completed", created_at: now, updated_at: now };
const automationJob = { id: "automation_fixture", title: "Fixture automation", kind: "daily_digest", status: "enabled", schedule: "every 24 hours", target_instruction: "Run the fixture automation.", delivery_target: { channel: "activity" }, next_run_at: now, locked_until: "2099-01-01T00:00:00.000Z", failure_count: 0, max_attempts: 3, created_at: now, updated_at: now };
const pairing = { id: "pairing_fixture", channel: "telegram", source_identity: "fixture-user", source_label: "Fixture user", status: "pending", pairing_code: "ABCDEF", session_key: "gateway:fixture-user", metadata: {}, requested_at: now, expires_at: "2099-01-01T00:00:00.000Z", updated_at: now };
const externalSendRecord = { id: "external_send_fixture", channel: "webhook", status: "approved", target: {}, title: "Fixture external send", body: "Fixture body", created_at: now, updated_at: now };
const artifact = { id: "image_artifact_fixture", title: "Fixture image", kind: "image", locale: "en", source_locales: ["en"], file_ref: { kind: "artifact", id: "image_artifact_fixture", uri: "artifacts/image_artifact_fixture.png", label: "Fixture image" }, metadata: { current_revision_id: "image_revision_fixture" }, source_operation_id: "operation_fixture", created_by: "fixture", created_at: now, updated_at: now };
const generatedArtifact = { id: "generated_image_fixture", title: "Generated image", kind: "image", locale: "en", source_locales: ["en"], file_ref: { kind: "artifact", id: "generated_image_fixture", uri: "artifacts/generated_image_fixture.png", label: "Generated image" }, metadata: {}, source_operation_id: "operation_fixture", created_by: "image_provider", created_at: now, updated_at: now };
const revision = { id: "image_revision_fixture", artifact_id: "image_artifact_fixture", revision: 1, parent_revision_id: undefined, source_ref: artifact.file_ref, file_ref: { kind: "artifact_revision", id: "image_revision_fixture", uri: "artifacts/image_artifact_fixture/revisions/image_revision_fixture", label: "Fixture image revision" }, blob_ref: { kind: "file", id: "blobs/image_revision_fixture", uri: "blobs/image_revision_fixture", label: "Fixture image blob" }, content_hash: "fixture_hash", content_bytes: 3, created_at: now };
const startedAutomationRun = { id: "automation_run_fixture", kind: "daily_digest", source: "automation_job", status: "started", started_at: now };
const scheduledAutomationRun = { ...startedAutomationRun, session_id: "session_fixture" };
const completedAutomationRun = { ...scheduledAutomationRun, backend_run_id: "backend_run_fixture", status: "completed", operation_id: "operation_fixture", completed_at: now };
const startedMemoryReviewRun = { id: "automation_run_fixture", kind: "memory_review", source: "cron", status: "started", started_at: now };
const memoryReviewTrace = { reflectionRun: { id: "reflection_run_fixture", kind: "background_review", session_id: "session_fixture", status: "completed", input_summary: "Fixture memory review", output_summary: "No changes", started_at: now, completed_at: now }, suggestions: [] };

type Definition = { readonly input: { parse(value: unknown): unknown; safeParse(value: unknown): { success: boolean; data?: unknown } }; readonly createHandler: (ports: never) => { execute(context: TrustedDomainContext, input: never): Promise<{ ok: boolean; value?: unknown }> } };
type Recorder = <T>(method: string, args: unknown[], value: T) => T;

let executedCases = 0;
let executedCalls = 0;
const seenBranches = new Map<string, Set<string>>();

async function runCase(id: keyof typeof bHandlerExpectations, testCase: BHandlerCaseExpectation, definition: Definition, createPorts: (record: Recorder, runMutation: (request: unknown, value?: unknown) => Promise<unknown>) => object): Promise<void> {
  const parsed = definition.input.safeParse(testCase.input);
  assert.equal(parsed.success, true, `handler_matrix_b_input_invalid:${id}:${testCase.id}`);
  const expected = testCase.calls;
  let cursor = 0;
  const calls: BHandlerCallExpectation[] = [];
  const record: Recorder = (method, args, value) => {
    const next = expected[cursor];
    assert.ok(next, `handler_matrix_b_forbidden_port_call:${id}:${testCase.id}:${method}`);
    assert.equal(method, next.method, `handler_matrix_b_port_order_drift:${id}:${testCase.id}:${cursor}`);
    assertArgs(next.args, args, `${id}:${testCase.id}:${method}`);
    calls.push({ method, args: normalize(args) });
    cursor += 1;
    return value;
  };
  const runMutation = async (request: unknown, value: unknown = {}) => {
    const execute = request && typeof request === "object" ? (request as { execute?: (operation: typeof operation) => Promise<unknown> }).execute : undefined;
    assert.equal(typeof execute, "function", `handler_matrix_b_callback_missing:${id}:${testCase.id}`);
    await execute!(operation);
    return value;
  };
  const ports = createPorts(record, runMutation);
  const result = await definition.createHandler(ports as never).execute({ ...context, ...(testCase.context ?? {}) }, parsed.data as never);
  assert.equal(result.ok, true, `handler_matrix_b_handler_result_invalid:${id}:${testCase.id}`);
  assert.equal(cursor, expected.length, `handler_matrix_b_port_call_count_drift:${id}:${testCase.id}`);
  assert.equal(calls.length, expected.length, `handler_matrix_b_port_contract_drift:${id}:${testCase.id}`);
  const branches = seenBranches.get(id) ?? new Set<string>();
  for (const branch of testCase.branches) branches.add(branch);
  seenBranches.set(id, branches);
  executedCases += 1;
  executedCalls += calls.length;
}

function assertArgs(expected: readonly unknown[], actual: readonly unknown[], label: string): void {
  assert.equal(actual.length, expected.length, `handler_matrix_b_arg_count_drift:${label}`);
  expected.forEach((value, index) => assertMatcher(value, actual[index], `${label}:arg${index}`));
}
function assertMatcher(expected: unknown, actual: unknown, label: string): void {
  if (expected && typeof expected === "object" && !Array.isArray(expected) && "$handler_matrix" in expected) {
    assert.equal(typeof actual, "function", `handler_matrix_b_expected_callback:${label}`);
    return;
  }
  if (Array.isArray(expected)) { assert.ok(Array.isArray(actual), label); assert.equal(actual.length, expected.length, label); expected.forEach((v, i) => assertMatcher(v, actual[i], `${label}[${i}]`)); return; }
  if (typeof expected === "string" && expected.includes("$generated:")) {
    assert.equal(typeof actual, "string", `handler_matrix_b_generated_value_missing:${label}`);
    const [prefix, suffix] = expected.split("$generated:", 2);
    assert.ok(String(actual).startsWith(prefix ?? "") && String(actual).endsWith(suffix?.includes(":") ? suffix.slice(suffix.indexOf(":")) : ""), `handler_matrix_b_generated_value_shape:${label}`);
    return;
  }
  if (typeof expected === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(expected)) {
    assert.equal(typeof actual, "string", `handler_matrix_b_timestamp_missing:${label}`);
    assert.match(String(actual), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, `handler_matrix_b_timestamp_invalid:${label}`);
    return;
  }
  if (expected && typeof expected === "object") {
    assert.ok(actual && typeof actual === "object" && !Array.isArray(actual), `handler_matrix_b_expected_object:${label}`);
    const expectedObject = expected as Record<string, unknown>;
    const actualObject = actual as Record<string, unknown>;
    const actualKeys = Object.keys(actualObject).sort();
    const expectedKeys = Object.keys(expectedObject).filter((key) => !(key === "locked_until" && !(key in actualObject))).sort();
    assert.deepEqual(actualKeys, expectedKeys, `handler_matrix_b_object_keys_drift:${label}`);
    for (const [key, value] of Object.entries(expectedObject)) if (key in actualObject) assertMatcher(value, actualObject[key], `${label}.${key}`);
    return;
  }
  assert.deepEqual(normalize(actual), normalize(expected), `handler_matrix_b_arg_drift:${label}`);
}
function normalize(value: unknown): unknown {
  if (typeof value === "function") return "$function";
  if (typeof value === "string" && value !== now && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value)) return "$generated:time";
  if (Array.isArray(value)) return value.map(normalize);
  if (!value || typeof value !== "object") return value;
  if (value instanceof Uint8Array) return [...value];
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, normalize(entry)]));
}
function rec<T>(record: Recorder, method: string, value: T): (...args: unknown[]) => T { return (...args) => record(method, args, value); }
function asyncRec<T>(record: Recorder, method: string, value: T): (...args: unknown[]) => Promise<T> { return async (...args) => record(method, args, value); }
function mutation<T>(record: Recorder, method: string, value: T): (...args: unknown[]) => Promise<T> { return async (...args) => record(method, args, value); }
function mutationRec(record: Recorder, method: string, runMutation: (request: unknown, value?: unknown) => Promise<unknown>, value: unknown): (...args: unknown[]) => Promise<unknown> {
  return async (...args) => { record(method, args, undefined); return runMutation(args[0], value); };
}
function mutationValue(id: string): unknown { return { resource: id === "image.edit" || id === "image.generate" ? artifact : automationJob, operation, activity: [] }; }
function findDefinition(id: string): Definition { const definition = definitions[id]; assert.ok(definition, `handler_matrix_b_definition_missing:${id}`); return definition as unknown as Definition; }
function expectedCallArg(testCase: BHandlerCaseExpectation, method: string, index = 0): unknown {
  const call = testCase.calls.find((candidate) => candidate.method === method);
  assert.ok(call, `handler_matrix_b_expected_call_missing:${method}`);
  return call.args[index];
}

const definitions: Record<string, unknown> = {
  "automation.job.release_lock": automationJobReleaseLock,
  "automation.job.requeue": automationJobRequeue,
  "automation.job.run": automationJobRun,
  "automation.job.save": automationJobSave,
  "automation.job.set_status": automationJobSetStatus,
  "automation.memory_review.run": automationMemoryReviewRun,
  "browser.interact": browserInteract,
  "browser.navigate": browserNavigate,
  "chat.turn.run": chatTurnRun,
  "external.send": externalSend,
  "external.send.prepare": externalSendPrepare,
  "external.send.dispatch": externalSendDispatch,
  "gateway.inbound.route": gatewayInboundRoute,
  "gateway.mcp_config.save": gatewayMcpConfigSave,
  "gateway.pairing_policy.save": gatewayPairingPolicySave,
  "gateway.pairing.approve": gatewayPairingApprove,
  "gateway.pairing.expire": gatewayPairingExpire,
  "gateway.pairing.reject": gatewayPairingReject,
  "gateway.pairing.revoke": gatewayPairingRevoke,
  "gateway.pairing.rotate": gatewayPairingRotate,
  "gateway.routing_policy.save": gatewayRoutingPolicySave,
  "gateway.sandbox.delete": gatewaySandboxDelete,
  "gateway.sandbox.recreate": gatewaySandboxRecreate,
  "gateway.sandbox.sync": gatewaySandboxSync,
  "gateway.state.repair": gatewayStateRepair,
  "image.edit": imageEdit,
  "image.generate": imageGenerate,
  "mcp.call": mcpCall,
  "sandbox.exec": sandboxExec
};

async function main(): Promise<void> {
  assert.equal(bHandlerOperationCount, 29, "handler_matrix_b_operation_count_drift");
  assert.equal(Object.keys(bHandlerExpectations).length, 29, "handler_matrix_b_static_expectation_count_drift");

  for (const testCase of bHandlerExpectations["automation.job.release_lock"].cases) await runCase("automation.job.release_lock", testCase, findDefinition("automation.job.release_lock"), (r) => ({ releaseAutomationJobLock: asyncRec(r, "releaseAutomationJobLock", automationJob) }));
  for (const testCase of bHandlerExpectations["automation.job.requeue"].cases) await runCase("automation.job.requeue", testCase, findDefinition("automation.job.requeue"), (r) => ({ requeueAutomationJob: asyncRec(r, "requeueAutomationJob", automationJob) }));
  await runCase("automation.job.run", bHandlerExpectations["automation.job.run"].cases[0]!, findDefinition("automation.job.run"), (r, m) => ({
    getAutomationJob: asyncRec(r, "getAutomationJob", automationJob),
    acquireAutomationJobLock: asyncRec(r, "acquireAutomationJobLock", automationJob),
    createAutomationRun: asyncRec(r, "createAutomationRun", startedAutomationRun),
    ensureScheduledAutomationSession: asyncRec(r, "ensureScheduledAutomationSession", session),
    updateAutomationRun: (() => { let count = 0; return async (...args: unknown[]) => { const value = count++ === 0 ? scheduledAutomationRun : completedAutomationRun; r("updateAutomationRun", args, value); return value; }; })(),
    createScheduledAutomationEnvelope: rec(r, "createScheduledAutomationEnvelope", envelope),
    automationJobRef: rec(r, "automationJobRef", { kind: "automation_job", id: "automation_fixture", uri: "automation-jobs/automation_fixture", label: "Fixture automation" }),
    runScheduledAutomationMutation: mutationRec(r, "runScheduledAutomationMutation", m, { resource: startedAutomationRun, operation, activity: [] }),
    runAutomationInstruction: asyncRec(r, "runAutomationInstruction", { backendRunId: "backend_run_fixture", summary: "Fixture automation completed." }),
    saveAutomationJobRecord: asyncRec(r, "saveAutomationJobRecord", automationJob),
    automationExecutionError: rec(r, "automationExecutionError", new Error("automation execution error")),
    automationErrorMessage: rec(r, "automationErrorMessage", "automation execution error"),
    automationRetryAt: rec(r, "automationRetryAt", now)
  }));
  for (const testCase of bHandlerExpectations["automation.job.save"].cases) await runCase("automation.job.save", testCase, findDefinition("automation.job.save"), (r, m) => {
    const saved = expectedCallArg(testCase, "saveAutomationJobRecord");
    return { automationJobContract: rec(r, "automationJobContract", { id: "automation.job.save", proposed_effects: ["Save an automation job definition."] }), ensureAutomationSession: asyncRec(r, "ensureAutomationSession", session), createAutomationEnvelope: rec(r, "createAutomationEnvelope", envelope), runAutomationJobMutation: mutationRec(r, "runAutomationJobMutation", m, mutationValue("automation.job.save")), saveAutomationJobRecord: asyncRec(r, "saveAutomationJobRecord", saved), automationJobRef: (...args: unknown[]) => r("automationJobRef", args, { kind: "automation_job", id: String((args[0] as { id?: unknown }).id), uri: `automation-jobs/${String((args[0] as { id?: unknown }).id)}`, label: String((args[0] as { title?: unknown }).title) }), createAutomationRollback: asyncRec(r, "createAutomationRollback", { id: "rollback_fixture" }) };
  });
  for (const testCase of bHandlerExpectations["automation.job.set_status"].cases) await runCase("automation.job.set_status", testCase, findDefinition("automation.job.set_status"), (r, m) => {
    const saved = { ...automationJob, status: testCase.input.status, locked_until: testCase.input.status === "disabled" ? undefined : automationJob.locked_until };
    const current = { ...automationJob, locked_until: "2099-01-01T00:00:00.000Z" };
    return { getAutomationJob: async (...args: unknown[]) => r("getAutomationJob", args, current), automationJobContract: rec(r, "automationJobContract", { id: "automation.job.set_status", proposed_effects: ["Change an Automation job between enabled and disabled."] }), ensureAutomationSession: asyncRec(r, "ensureAutomationSession", session), createAutomationEnvelope: rec(r, "createAutomationEnvelope", envelope), automationJobRef: (...args: unknown[]) => r("automationJobRef", args, { kind: "automation_job", id: "automation_fixture", uri: "automation-jobs/automation_fixture", label: "Fixture automation" }), runAutomationJobMutation: mutationRec(r, "runAutomationJobMutation", m, mutationValue("automation.job.set_status")), saveAutomationJobRecord: asyncRec(r, "saveAutomationJobRecord", saved), createAutomationRollback: asyncRec(r, "createAutomationRollback", { id: "rollback_fixture" }) };
  });
  await runCase("automation.memory_review.run", bHandlerExpectations["automation.memory_review.run"].cases[0]!, findDefinition("automation.memory_review.run"), (r, m) => ({
    createAutomationRun: asyncRec(r, "createAutomationRun", startedMemoryReviewRun), ensureScheduledAutomationSession: asyncRec(r, "ensureScheduledAutomationSession", session), updateAutomationRun: (() => { let count = 0; return async (...args: unknown[]) => { const value = count++ === 0 ? { ...startedMemoryReviewRun, session_id: "session_fixture" } : { ...startedMemoryReviewRun, session_id: "session_fixture", status: "completed", operation_id: "operation_fixture", completed_at: now }; r("updateAutomationRun", args, value); return value; }; })(), createScheduledAutomationEnvelope: rec(r, "createScheduledAutomationEnvelope", envelope), runScheduledAutomationMutation: mutationRec(r, "runScheduledAutomationMutation", m, { resource: { ...startedMemoryReviewRun, session_id: "session_fixture" }, operation, activity: [] }), runScheduledMemoryReview: asyncRec(r, "runScheduledMemoryReview", memoryReviewTrace), automationErrorMessage: rec(r, "automationErrorMessage", "fixture error") ,
  }));

  for (const testCase of bHandlerExpectations["browser.interact"].cases) await runCase("browser.interact", testCase, findDefinition("browser.interact"), (r, m) => ({ ensureBrowserSession: asyncRec(r, "ensureBrowserSession", session), createBrowserEnvelope: rec(r, "createBrowserEnvelope", envelope), runBrowserMutation: mutationRec(r, "runBrowserMutation", m, { resource: { ...session, url: "https://example.com/fixture", adapterId: "fixture_browser", action: testCase.input.action ?? "navigate", text: "Fixture browser text" }, ref: { kind: "browser", id: "browser_hash", uri: "browser/browser_hash", label: "Browser" }, summary: "fixture" }), interactWithBrowser: asyncRec(r, "interactWithBrowser", { ...session, url: "https://example.com/fixture", adapterId: "fixture_browser", action: testCase.input.action ?? "navigate", text: "Fixture browser text" }), stableBrowserHash: rec(r, "stableBrowserHash", "browser_hash") }));
  await runCase("browser.navigate", bHandlerExpectations["browser.navigate"].cases[0]!, findDefinition("browser.navigate"), (r, m) => ({ ensureBrowserSession: asyncRec(r, "ensureBrowserSession", session), createBrowserEnvelope: rec(r, "createBrowserEnvelope", envelope), runBrowserMutation: mutationRec(r, "runBrowserMutation", m, { resource: { url: "https://example.com/fixture", title: "Fixture browser", html: "<main>fixture</main>", text: "Fixture browser text", adapter: "fetch" }, ref: { kind: "browser", id: "browser_hash", uri: "browser/browser_hash", label: "Browser" }, summary: "fixture" }), readBrowserPage: asyncRec(r, "readBrowserPage", { url: "https://example.com/fixture", title: "Fixture browser", html: "<main>fixture</main>", text: "Fixture browser text", adapter: "fetch" }), stableBrowserHash: rec(r, "stableBrowserHash", "browser_hash") }));

  for (const testCase of bHandlerExpectations["chat.turn.run"].cases) await runCase("chat.turn.run", testCase, findDefinition("chat.turn.run"), (r) => ({ createChatSession: asyncRec(r, "createChatSession", session), runChatTurn: asyncRec(r, "runChatTurn", { session, assistant_message: { content: "Fixture reply" }, tool_runs: [], backend_run: null, backend_events: [], memory_candidates: [], skill_candidates: [], artifact_refs: [], collection_refs: [], workspace_changes: [], output_locale: "en", input_locale: "en", surface: null }) }));

  const externalPorts = (r: Recorder, m: (request: unknown, value?: unknown) => Promise<unknown>, testCase: BHandlerCaseExpectation) => {
    const saved = expectedCallArg(testCase, "saveExternalSend") ?? externalSendRecord;
    return {
    ensureExternalSendSession: asyncRec(r, "ensureExternalSendSession", session), createExternalSendEnvelope: rec(r, "createExternalSendEnvelope", envelope), externalSendNow: rec(r, "externalSendNow", now), createExternalSendId: rec(r, "createExternalSendId", "external_send_fixture"), runExternalSendMutation: mutationRec(r, "runExternalSendMutation", m, { resource: saved }), saveExternalSend: asyncRec(r, "saveExternalSend", saved), createExternalSendRollback: asyncRec(r, "createExternalSendRollback", { id: "rollback_fixture" }), getExternalSend: asyncRec(r, "getExternalSend", externalSendRecord), dispatchExternalSend: asyncRec(r, "dispatchExternalSend", testCase.id === "sent" ? { dispatched: true, adapter: "fixture_adapter", dry_run: false, message: "Fixture sent", transport: "webhook", status: 202 } : { dispatched: false, adapter: "fixture_adapter", dry_run: true, message: "Fixture dry run", transport: "webhook", status: 202 }), externalSendDefaultDryRun: rec(r, "externalSendDefaultDryRun", true), externalSendNotFound: rec(r, "externalSendNotFound", new Error("not found"))
    };
  };
  for (const testCase of bHandlerExpectations["external.send"].cases) await runCase("external.send", testCase, findDefinition("external.send"), (r, m) => externalPorts(r, m, testCase));
  for (const testCase of bHandlerExpectations["external.send.prepare"].cases) await runCase("external.send.prepare", testCase, findDefinition("external.send.prepare"), (r, m) => externalPorts(r, m, testCase));
  for (const testCase of bHandlerExpectations["external.send.dispatch"].cases) await runCase("external.send.dispatch", testCase, findDefinition("external.send.dispatch"), (r, m) => externalPorts(r, m, testCase));

  for (const testCase of bHandlerExpectations["gateway.inbound.route"].cases) await runCase("gateway.inbound.route", testCase, findDefinition("gateway.inbound.route"), (r) => ({ routeGatewayInbound: asyncRec(r, "routeGatewayInbound", { session, route: "fixture-route", accepted: true }) }));
  for (const testCase of bHandlerExpectations["gateway.mcp_config.save"].cases) await runCase("gateway.mcp_config.save", testCase, findDefinition("gateway.mcp_config.save"), (r) => ({ saveGatewayMcpConfig: asyncRec(r, "saveGatewayMcpConfig", testCase.input) }));
  for (const testCase of bHandlerExpectations["gateway.pairing_policy.save"].cases) await runCase("gateway.pairing_policy.save", testCase, findDefinition("gateway.pairing_policy.save"), (r) => ({ saveGatewayPairingPolicy: asyncRec(r, "saveGatewayPairingPolicy", testCase.input) }));
  await runCase("gateway.pairing.approve", bHandlerExpectations["gateway.pairing.approve"].cases[0]!, findDefinition("gateway.pairing.approve"), (r) => ({ requireGatewayPairing: asyncRec(r, "requireGatewayPairing", pairing), saveGatewayPairing: async (...args: unknown[]) => r("saveGatewayPairing", args, args[0]), emitGatewayPairingUpdated: async (...args: unknown[]) => { r("emitGatewayPairingUpdated", args, undefined); } }));
  for (const testCase of bHandlerExpectations["gateway.pairing.expire"].cases) await runCase("gateway.pairing.expire", testCase, findDefinition("gateway.pairing.expire"), (r) => ({ expireGatewayPairings: asyncRec(r, "expireGatewayPairings", [{ ...pairing, status: "expired", pairing_code: undefined, resolved_at: now }]), emitGatewayPairingUpdated: async (...args: unknown[]) => { r("emitGatewayPairingUpdated", args, undefined); } }));
  for (const id of ["gateway.pairing.reject", "gateway.pairing.revoke", "gateway.pairing.rotate"] as const) await runCase(id, bHandlerExpectations[id].cases[0]!, findDefinition(id), (r) => ({ requireGatewayPairing: asyncRec(r, "requireGatewayPairing", pairing), saveGatewayPairing: async (...args: unknown[]) => r("saveGatewayPairing", args, args[0]), emitGatewayPairingUpdated: async (...args: unknown[]) => { r("emitGatewayPairingUpdated", args, undefined); } }));
  for (const testCase of bHandlerExpectations["gateway.routing_policy.save"].cases) await runCase("gateway.routing_policy.save", testCase, findDefinition("gateway.routing_policy.save"), (r) => ({ saveGatewayRoutingPolicy: asyncRec(r, "saveGatewayRoutingPolicy", testCase.input) }));
  await runCase("gateway.sandbox.delete", bHandlerExpectations["gateway.sandbox.delete"].cases[0]!, findDefinition("gateway.sandbox.delete"), (r) => ({ deleteGatewaySandbox: asyncRec(r, "deleteGatewaySandbox", { sandboxId: "sandbox_fixture" }) }));
  await runCase("gateway.sandbox.recreate", bHandlerExpectations["gateway.sandbox.recreate"].cases[0]!, findDefinition("gateway.sandbox.recreate"), (r) => ({ recreateGatewaySandbox: asyncRec(r, "recreateGatewaySandbox", { sandboxId: "sandbox_fixture" }) }));
  for (const testCase of bHandlerExpectations["gateway.sandbox.sync"].cases) await runCase("gateway.sandbox.sync", testCase, findDefinition("gateway.sandbox.sync"), (r) => ({ syncGatewaySandbox: asyncRec(r, "syncGatewaySandbox", { sandboxId: "sandbox_fixture" }) }));
  for (const testCase of bHandlerExpectations["gateway.state.repair"].cases) await runCase("gateway.state.repair", testCase, findDefinition("gateway.state.repair"), (r) => ({ repairGatewayState: asyncRec(r, "repairGatewayState", { repaired: true }) }));

  for (const testCase of bHandlerExpectations["image.edit"].cases) await runCase("image.edit", testCase, findDefinition("image.edit"), (r, m) => ({ getArtifact: asyncRec(r, "getArtifact", artifact), artifactContract: rec(r, "artifactContract", { id: "image.edit", proposed_effects: ["Save an edited image result as a new Artifact revision while preserving the original asset."] }), decodeImageBase64: rec(r, "decodeImageBase64", new Uint8Array([1, 2, 3])), ensureArtifactSession: asyncRec(r, "ensureArtifactSession", session), createArtifactEnvelope: rec(r, "createArtifactEnvelope", envelope), runArtifactMutation: mutationRec(r, "runArtifactMutation", m, mutationValue("image.edit")), createArtifactRevision: asyncRec(r, "createArtifactRevision", { artifact, revision }), createArtifactRollback: asyncRec(r, "createArtifactRollback", { id: "rollback_fixture" }) }));
  for (const testCase of bHandlerExpectations["image.generate"].cases) await runCase("image.generate", testCase, findDefinition("image.generate"), (r, m) => ({ artifactContract: rec(r, "artifactContract", { id: "image.generate", proposed_effects: ["Save a generated image provider result as an Artifact."] }), decodeImageBase64: rec(r, "decodeImageBase64", new Uint8Array([1, 2, 3])), ensureArtifactSession: asyncRec(r, "ensureArtifactSession", session), createArtifactEnvelope: rec(r, "createArtifactEnvelope", envelope), runArtifactMutation: mutationRec(r, "runArtifactMutation", m, mutationValue("image.generate")), createArtifactDraft: asyncRec(r, "createArtifactDraft", generatedArtifact), createArtifactRevision: asyncRec(r, "createArtifactRevision", { artifact: generatedArtifact, revision }), createArtifactRollback: asyncRec(r, "createArtifactRollback", { id: "rollback_fixture" }) }));
  for (const testCase of bHandlerExpectations["mcp.call"].cases) await runCase("mcp.call", testCase, findDefinition("mcp.call"), (r) => ({ executeMcpCall: asyncRec(r, "executeMcpCall", { result: {} }) }));
  for (const testCase of bHandlerExpectations["sandbox.exec"].cases) await runCase("sandbox.exec", testCase, findDefinition("sandbox.exec"), (r) => ({ executeSandboxExec: asyncRec(r, "executeSandboxExec", { exit_code: 0, stdout: "fixture", stderr: "", timed_out: false }) }));

  for (const [id, expectation] of Object.entries(bHandlerExpectations)) assert.deepEqual([...seenBranches.get(id) ?? []].sort(), [...expectation.requiredBranches].sort(), `handler_matrix_b_branch_coverage_missing:${id}`);
  assert.equal(executedCases, bHandlerCaseCount, "handler_matrix_b_cases_not_all_executed");
  process.stdout.write(`${JSON.stringify({ status: "passed", gates: ["RH06", "RH07", "RH08"], shard: "B", covered_operations: bHandlerOperationCount, covered_operation_ids: Object.keys(bHandlerExpectations).sort(), required_operations: 29, remaining_operations: 0, cases: executedCases, port_calls: executedCalls, expectation_mode: "static_method_args_order_count_forbidden" })}\n`);
}

void main();
