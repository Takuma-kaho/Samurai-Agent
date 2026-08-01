import assert from "node:assert/strict";
import type { TrustedDomainContext } from "../../packages/domain-operations/src/definition/index";
import agentBackendBind from "../../packages/domain-operations/src/operations/agent/backend/bind.operation";
import agentCreate from "../../packages/domain-operations/src/operations/agent/create.operation";
import agentList from "../../packages/domain-operations/src/operations/agent/list.operation";
import agentPatch from "../../packages/domain-operations/src/operations/agent/patch.operation";
import agentView from "../../packages/domain-operations/src/operations/agent/view.operation";
import browserExtract from "../../packages/domain-operations/src/operations/browser/extract.operation";
import clientEventAck from "../../packages/domain-operations/src/operations/client/event/ack.operation";
import clientEventDeliver from "../../packages/domain-operations/src/operations/client/event/deliver.operation";
import clientEventExpire from "../../packages/domain-operations/src/operations/client/event/expire.operation";
import clientEventFail from "../../packages/domain-operations/src/operations/client/event/fail.operation";
import clientEventSave from "../../packages/domain-operations/src/operations/client/event/save.operation";
import collectionActionRun from "../../packages/domain-operations/src/operations/collection/action/run.operation";
import curatorPause from "../../packages/domain-operations/src/operations/curator/pause.operation";
import curatorRestore from "../../packages/domain-operations/src/operations/curator/restore.operation";
import curatorResume from "../../packages/domain-operations/src/operations/curator/resume.operation";
import curatorSnapshotCreate from "../../packages/domain-operations/src/operations/curator/snapshot/create.operation";
import curatorSnapshotList from "../../packages/domain-operations/src/operations/curator/snapshot/list.operation";
import fileInspect from "../../packages/domain-operations/src/operations/file/inspect.operation";
import fileList from "../../packages/domain-operations/src/operations/file/list.operation";
import fileRead from "../../packages/domain-operations/src/operations/file/read.operation";
import gatewayConcurrencyLockExpire from "../../packages/domain-operations/src/operations/gateway/concurrency_lock/expire.operation";
import learningSnapshotPrune from "../../packages/domain-operations/src/operations/learning/snapshot/prune.operation";
import objectiveTransition from "../../packages/domain-operations/src/operations/objective/transition.operation";
import pluginStatusSet from "../../packages/domain-operations/src/operations/plugin/status/set.operation";
import roomCreate from "../../packages/domain-operations/src/operations/room/create.operation";
import roomList from "../../packages/domain-operations/src/operations/room/list.operation";
import roomPatch from "../../packages/domain-operations/src/operations/room/patch.operation";
import roomView from "../../packages/domain-operations/src/operations/room/view.operation";
import sessionCreate from "../../packages/domain-operations/src/operations/session/create.operation";
import sessionSearchReindex from "../../packages/domain-operations/src/operations/session/search/reindex.operation";
import sessionSearch from "../../packages/domain-operations/src/operations/search/session.operation";
import memorySearch from "../../packages/domain-operations/src/operations/search/memory.operation";
import wikiSearch from "../../packages/domain-operations/src/operations/search/wiki.operation";
import skillSearch from "../../packages/domain-operations/src/operations/search/skill.operation";
import collectionSearch from "../../packages/domain-operations/src/operations/search/collection.operation";
import settingsPatch from "../../packages/domain-operations/src/operations/settings/patch.operation";
import skillUsageRecord from "../../packages/domain-operations/src/operations/skill/usage/record.operation";
import workItemFollowUp from "../../packages/domain-operations/src/operations/work_item/follow_up.operation";
import workItemSteer from "../../packages/domain-operations/src/operations/work_item/steer.operation";
import { handlerExpectationCount, handlerExpectations, type HandlerCallExpectation } from "./domain-operation-handler-expectations";

const now = "2026-07-17T00:00:00.000Z";
const context: TrustedDomainContext = {
  inputSource: "runtime_api",
  workspaceId: "handler-matrix-workspace",
  actorId: "handler-matrix-actor",
  correlationId: "handler-matrix",
  sessionId: "session_fixture",
  runId: "run_fixture"
};
let assertions = 0;
const calls = new Map<string, HandlerCallExpectation[]>();

const fileOutput = { resource: { path: "workspace/notes.txt", content: "fixture" } };
const browserOutput = { resource: { url: "https://example.com/page", html: "<main>fixture</main>", text: "fixture", adapter: "fetch" as const } };
const clientEventOutput = {
  id: "client_event_fixture",
  target_client_kind: "desktop" as const,
  target_client_id: "desktop_fixture",
  event_type: "client.notification.requested" as const,
  status: "pending" as const,
  payload: { title: "Fixture notification" },
  resource_refs: [],
  created_at: now
};
const gatewayExpiredLocksOutput = {
  expired_count: 1,
  locks: [{
    id: "gateway_lock_fixture",
    lock_key: "session:fixture",
    scope: "session" as const,
    status: "expired" as const,
    acquired_at: now,
    expires_at: now,
    released_at: now,
    metadata: {}
  }]
};
const roomOutput = { id: "room_fixture", name: "Fixture Room", created_at: now, updated_at: now };
const agentOutput = { id: "agent_fixture", name: "Fixture Agent", role: "Fixture", instructions: "Handle fixture work.", backend_id: "backend_fixture", enabled: true, created_at: now, updated_at: now };
const sessionOutput = { id: "session_fixture", session_key: "session_fixture", room_id: roomOutput.id, title: "Fixture session", ui_locale: "en" as const, output_locale: "ja" as const, created_at: now, updated_at: now };
const sessionSearchOutput = { mode: "fts5" as const, indexed: 1 };
const searchSessionOutput = [{ kind: "session" as const, id: "session_fixture", title: "Fixture session", summary: "fixture" }];
const searchMemoryOutput = [{ id: "memory_fixture", topic: "Fixture memory", state: "active" as const, file_path: "memory/fixture.md" }];
const searchWikiOutput = [{ id: "wiki_fixture", slug: "fixture", title: "Fixture wiki", file_path: "wiki/pages/fixture.md" }];
const searchSkillOutput = [{ id: "skill_fixture", title: "Fixture skill", description: "Fixture", tags: ["fixture"], file_path: "skills/fixture/SKILL.md" }];
const searchCollectionOutput = [{ kind: "collection_schema" as const, id: "collection_fixture", file_path: "collections/collection_fixture/schema.json" }];
const learningSnapshotPruneOutput = { retained: 5, removed: ["snapshot_old"] };
const settingsOutput = {
  ui_locale: "en" as const, output_locale: "ja" as const, memory_capture_mode: "manual" as const,
  knowledge_wiki_capture_mode: "auto" as const, skill_capture_mode: "auto" as const,
  external_provider_role: "assistive" as const, updated_at: now
};
const skillUsageOutput = {
  use_record: {
    id: "use_fixture", run_id: "run_fixture", session_id: "session_fixture", resource_kind: "skill" as const,
    resource_id: "resource_fixture", content_hash: "hash_fixture", stage: "body_loaded" as const,
    metadata: { source: "fixture" }, created_at: now
  }
};
const curatorStateOutput = { id: "default" as const, paused: true, interval_hours: 24, min_idle_hours: 1, stale_after_days: 30, archive_after_days: 90, run_count: 0, updated_at: now };
const snapshotOutput = { id: "snapshot_fixture", run_id: "run_fixture", path: "learning/snapshots/snapshot_fixture.json", resource_counts: { memory: 0, skills: 0, support_files: 0, wiki: 0 }, created_at: now };
const objectiveOutput = {
  id: "objective_fixture",
  session_id: "session_fixture",
  title: "Fixture objective",
  objective: "Complete the fixture objective",
  completion_criteria: ["fixture complete"],
  status: "paused" as const,
  created_at: now,
  updated_at: now
};
const workItemOutput = {
  id: "work_item_fixture",
  objective_id: "objective_fixture",
  instruction: "Fixture work item",
  status: "ready" as const,
  priority: 0,
  attempt: 0,
  max_attempts: 3,
  idempotency_key: "work_item_fixture_key",
  created_at: now,
  updated_at: now
};
const workDependencyOutput = {
  id: "work_dependency_fixture",
  objective_id: "objective_fixture",
  predecessor_work_item_id: "work_item_fixture",
  successor_work_item_id: "follow_up_fixture",
  kind: "requires" as const,
  created_at: now
};
const pluginOutput = {
  plugin: { manifest_id: "plugin_fixture", version: "1.0.0" },
  state: { manifest_id: "plugin_fixture", enabled: true, version: "1.0.0", updated_at: now }
};
const collectionActionOutput = {
  resource: {
    collection_id: "collection_fixture", action_id: "action_fixture", action_kind: "custom_instruction", status: "completed" as const,
    backend_run_id: "backend_run_fixture", session_id: "session_fixture", output: { backend_status: "completed", message_ids: [] }
  },
  operation: {
    id: "operation_fixture", session_id: "session_fixture", capability_id: "collection", operation: "collection.action.run",
    actor_identity: "owner" as const, instruction_source: "owner_instruction" as const, instruction_authority: "owner",
    channel: "test", input_hash: "fixture_hash", target_resource_refs: [], proposed_effects: [], status: "completed" as const,
    created_at: now, updated_at: now
  },
  activity: []
};

await run("file.read", () => fileRead.createHandler({
  readWorkspaceFile(input) { return record("file.read", "readWorkspaceFile", [input], fileOutput); }
}).execute(context, handlerExpectations["file.read"].input));

await run("file.list", () => fileList.createHandler({
  listWorkspaceFiles(input) { return record("file.list", "listWorkspaceFiles", [input], fileOutput); }
}).execute(context, handlerExpectations["file.list"].input));

await run("file.inspect", () => fileInspect.createHandler({
  inspectWorkspaceFile(input) { return record("file.inspect", "inspectWorkspaceFile", [input], fileOutput); }
}).execute(context, handlerExpectations["file.inspect"].input));

await run("browser.extract", () => browserExtract.createHandler({
  extractBrowserPage(input) { return record("browser.extract", "extractBrowserPage", [input], browserOutput); }
}).execute(context, handlerExpectations["browser.extract"].input));

await run("agent.backend.bind", () => agentBackendBind.createHandler({
  bindAgentBackend(input) { return record("agent.backend.bind", "bindAgentBackend", [input], { ...agentOutput, backend_id: input.backendId }); }
}).execute(context, handlerExpectations["agent.backend.bind"].input));
await run("agent.create", () => agentCreate.createHandler({
  createAgent(input) { return record("agent.create", "createAgent", [input], { ...agentOutput, enabled: input.enabled ?? true }); }
}).execute(context, handlerExpectations["agent.create"].input));
await run("agent.list", () => agentList.createHandler({
  listAgents() { return record("agent.list", "listAgents", [], [agentOutput]); }
}).execute(context, handlerExpectations["agent.list"].input));
await run("agent.patch", () => agentPatch.createHandler({
  patchAgent(input) { return record("agent.patch", "patchAgent", [input], { ...agentOutput, ...input }); }
}).execute(context, handlerExpectations["agent.patch"].input));
await run("agent.view", () => agentView.createHandler({
  viewAgent(id) { return record("agent.view", "viewAgent", [id], agentOutput); }
}).execute(context, handlerExpectations["agent.view"].input));

await run("client.event.ack", () => clientEventAck.createHandler({
  acknowledgeClientEvent(id) { return record("client.event.ack", "acknowledgeClientEvent", [id], { ...clientEventOutput, status: "acked" as const, acked_at: now }); },
  clientEventNotFoundError() { throw new Error("client_event_not_found"); }
}).execute(context, handlerExpectations["client.event.ack"].input));

await run("client.event.deliver", () => clientEventDeliver.createHandler({
  deliverClientEvent(id) { return record("client.event.deliver", "deliverClientEvent", [id], { ...clientEventOutput, status: "delivered" as const, delivered_at: now }); },
  clientEventNotFoundError() { throw new Error("client_event_not_found"); }
}).execute(context, handlerExpectations["client.event.deliver"].input));

await run("client.event.expire", () => clientEventExpire.createHandler({
  expireClientEvents(value) { return record("client.event.expire", "expireClientEvents", [value], [{ ...clientEventOutput, status: "expired" as const }]); }
}).execute(context, handlerExpectations["client.event.expire"].input));

await run("client.event.fail", () => clientEventFail.createHandler({
  failClientEvent(id, errorCode) { return record("client.event.fail", "failClientEvent", [id, errorCode], { ...clientEventOutput, status: "failed" as const, error_code: errorCode }); },
  clientEventNotFoundError() { throw new Error("client_event_not_found"); }
}).execute(context, handlerExpectations["client.event.fail"].input));

await run("client.event.save", () => clientEventSave.createHandler({
  saveClientEvent(event) { return record("client.event.save", "saveClientEvent", [event], event); }
}).execute(context, handlerExpectations["client.event.save"].input));

assert.equal(
  collectionActionRun.input.safeParse({
    ...handlerExpectations["collection.action.run"].input,
    session_id: "forged-session"
  }).success,
  false,
  "collection.action.run must not accept caller-owned session_id"
);
await run("collection.action.run", () => collectionActionRun.createHandler({
  runCollectionAction(input) { return record("collection.action.run", "runCollectionAction", [input], collectionActionOutput); }
}).execute(context, handlerExpectations["collection.action.run"].input));

await run("session.create", () => sessionCreate.createHandler({
  createSession(input) { return record("session.create", "createSession", [input], sessionOutput); }
}).execute(context, handlerExpectations["session.create"].input));

await run("room.create", () => roomCreate.createHandler({
  createRoom(input) { return record("room.create", "createRoom", [input], { ...roomOutput, ...input }); }
}).execute(context, handlerExpectations["room.create"].input));
await run("room.list", () => roomList.createHandler({
  listRooms() { return record("room.list", "listRooms", [], [roomOutput]); }
}).execute(context, handlerExpectations["room.list"].input));
await run("room.patch", () => roomPatch.createHandler({
  patchRoom(input) { return record("room.patch", "patchRoom", [input], { ...roomOutput, ...input }); }
}).execute(context, handlerExpectations["room.patch"].input));
await run("room.view", () => roomView.createHandler({
  viewRoom(id) { return record("room.view", "viewRoom", [id], roomOutput); }
}).execute(context, handlerExpectations["room.view"].input));

await run("session.search.reindex", () => sessionSearchReindex.createHandler({
  reindexSessionSearch() { return record("session.search.reindex", "reindexSessionSearch", [], sessionSearchOutput); }
}).execute(context, handlerExpectations["session.search.reindex"].input));

await run("learning.snapshot.prune", () => learningSnapshotPrune.createHandler({
  pruneLearningSnapshots(input) { return record("learning.snapshot.prune", "pruneLearningSnapshots", [input], learningSnapshotPruneOutput); }
}).execute(context, handlerExpectations["learning.snapshot.prune"].input));

await run("objective.transition", () => objectiveTransition.createHandler({
  transitionObjective(id, action) { return record("objective.transition", "transitionObjective", [id, action], { objective: objectiveOutput, workItems: [workItemOutput], cancelBackendRunIds: ["run_fixture"] }); }
}).execute(context, handlerExpectations["objective.transition"].input));

await run("plugin.status.set", () => pluginStatusSet.createHandler({
  setPluginEnabled(id, enabled) { return record("plugin.status.set", "setPluginEnabled", [id, enabled], true); },
  findPluginStatus(id) { return record("plugin.status.set", "findPluginStatus", [id], pluginOutput.plugin); },
  savePluginState(input) { return record("plugin.status.set", "savePluginState", [input], pluginOutput.state); },
  pluginNotFoundError() { throw new Error("plugin_not_found"); }
}).execute(context, handlerExpectations["plugin.status.set"].input));

await run("settings.patch", () => settingsPatch.createHandler({
  applySettingsPatch(input) { return record("settings.patch", "applySettingsPatch", [input], settingsOutput); }
}).execute(context, handlerExpectations["settings.patch"].input));

await run("skill.usage.record", () => skillUsageRecord.createHandler({
  recordSkillUsage(input) { return record("skill.usage.record", "recordSkillUsage", [input], skillUsageOutput); }
}).execute(context, handlerExpectations["skill.usage.record"].input));

assert.equal(
  skillUsageRecord.input.safeParse({ ...handlerExpectations["skill.usage.record"].input, run_id: "forged-run" }).success,
  false,
  "skill.usage.record must not accept caller-owned run_id"
);
await run("curator.pause", () => curatorPause.createHandler({
  pauseCurator() { return record("curator.pause", "pauseCurator", [], curatorStateOutput); }
}).execute(context, handlerExpectations["curator.pause"].input));

await run("curator.resume", () => curatorResume.createHandler({
  resumeCurator() { return record("curator.resume", "resumeCurator", [], { ...curatorStateOutput, paused: false }); }
}).execute(context, handlerExpectations["curator.resume"].input));

await run("curator.restore", () => curatorRestore.createHandler({
  restoreCuratorSnapshot(id) { return record("curator.restore", "restoreCuratorSnapshot", [id], snapshotOutput); },
  curatorSnapshotNotFoundError() { throw new Error("curator_snapshot_not_found"); }
}).execute(context, handlerExpectations["curator.restore"].input));

await run("curator.snapshot.create", () => curatorSnapshotCreate.createHandler({
  createCuratorSnapshot() { return record("curator.snapshot.create", "createCuratorSnapshot", [], snapshotOutput); }
}).execute(context, handlerExpectations["curator.snapshot.create"].input));

await run("curator.snapshot.list", () => curatorSnapshotList.createHandler({
  listCuratorSnapshots() { return record("curator.snapshot.list", "listCuratorSnapshots", [], [snapshotOutput]); }
}).execute(context, handlerExpectations["curator.snapshot.list"].input));

await run("gateway.concurrency_lock.expire", () => gatewayConcurrencyLockExpire.createHandler({
  expireGatewayConcurrencyLocks(input) { return record("gateway.concurrency_lock.expire", "expireGatewayConcurrencyLocks", [input], gatewayExpiredLocksOutput); }
}).execute(context, handlerExpectations["gateway.concurrency_lock.expire"].input));

await run("session.search", () => sessionSearch.createHandler({
  searchSessions(query, limit) { return record("session.search", "searchSessions", [query, limit], searchSessionOutput); }
}).execute(context, handlerExpectations["session.search"].input));
await run("memory.search", () => memorySearch.createHandler({
  searchMemory(query, limit) { return record("memory.search", "searchMemory", [query, limit], searchMemoryOutput); }
}).execute(context, handlerExpectations["memory.search"].input));
await run("wiki.search", () => wikiSearch.createHandler({
  searchWiki(query, limit) { return record("wiki.search", "searchWiki", [query, limit], searchWikiOutput); }
}).execute(context, handlerExpectations["wiki.search"].input));
await run("skill.search", () => skillSearch.createHandler({
  searchSkills(query, limit) { return record("skill.search", "searchSkills", [query, limit], searchSkillOutput); }
}).execute(context, handlerExpectations["skill.search"].input));
await run("collection.search", () => collectionSearch.createHandler({
  searchCollections(collectionId, query, limit) { return record("collection.search", "searchCollections", [collectionId, query, limit], searchCollectionOutput); }
}).execute(context, handlerExpectations["collection.search"].input));

await run("work_item.follow_up", () => workItemFollowUp.createHandler({
  createFollowUpWorkItem(input) { return record("work_item.follow_up", "createFollowUpWorkItem", [input], { workItem: { ...workItemOutput, id: "follow_up_fixture" }, dependency: workDependencyOutput }); }
}).execute(context, handlerExpectations["work_item.follow_up"].input));

await run("work_item.steer", () => workItemSteer.createHandler({
  steerWorkItem(input) { return record("work_item.steer", "steerWorkItem", [input], workItemOutput); }
}).execute(context, handlerExpectations["work_item.steer"].input));

assert.equal(assertions, handlerExpectationCount, "every static expectation must run exactly once");
const requiredOperations = handlerExpectationCount;
const summary = {
  status: assertions === requiredOperations ? "passed" : "incomplete",
  gates: ["RH06", "RH07"],
  manifest_source: "scripts/fixtures/domain-operation-handler-expectations.ts",
  covered_operations: assertions,
  covered_operation_ids: Object.keys(handlerExpectations).sort(),
  required_operations: requiredOperations,
  remaining_operations: requiredOperations - assertions,
  expectation_mode: "static_method_args_count_forbidden"
};
process.stdout.write(`${JSON.stringify(summary)}\n`);
if (summary.status !== "passed") process.exitCode = 1;

async function run(id: keyof typeof handlerExpectations, execute: () => Promise<unknown>): Promise<void> {
  const before = calls.get(id) ?? [];
  assert.equal(before.length, 0, `${id} unexpectedly recorded a call before execution`);
  await execute();
  assert.deepEqual(calls.get(id), handlerExpectations[id].calls, `${id} Port call sequence or arguments drifted`);
  assertions += 1;
}

function record<T>(id: string, method: string, args: unknown[], value: T): T {
  const expected = handlerExpectations[id as keyof typeof handlerExpectations];
  assert.ok(expected, `unreviewed Handler test attempted to record ${id}`);
  const entries = calls.get(id) ?? [];
  const next = [...entries, { method, args }];
  // A Port object exposes only reviewed methods. This assertion additionally
  // makes over-calling an allowed method fail at the exact call site.
  assert.ok(next.length <= expected.calls.length, `${id} exceeded reviewed Port call count`);
  calls.set(id, next);
  return value;
}
