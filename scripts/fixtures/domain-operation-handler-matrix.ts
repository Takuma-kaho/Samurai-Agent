import assert from "node:assert/strict";
import type { TrustedDomainContext } from "../../packages/domain-operations/src/definition/index";
import activityHistoryList from "../../packages/domain-operations/src/operations/activity/history/list.operation";
import agentBackendBind from "../../packages/domain-operations/src/operations/agent/backend/bind.operation";
import agentCreate from "../../packages/domain-operations/src/operations/agent/create.operation";
import agentList from "../../packages/domain-operations/src/operations/agent/list.operation";
import agentPatch from "../../packages/domain-operations/src/operations/agent/patch.operation";
import agentView from "../../packages/domain-operations/src/operations/agent/view.operation";
import agentWorkspacePermissionSet from "../../packages/domain-operations/src/operations/agent/workspace-permission-set.operation";
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
import learningBackgroundReviewApply from "../../packages/domain-operations/src/operations/learning/background_review/apply.operation";
import learningResourceUsageRecord from "../../packages/domain-operations/src/operations/learning/resource/usage/record.operation";
import learningResourceVersionRestore from "../../packages/domain-operations/src/operations/learning/resource/version/restore.operation";
import learningResourceVersionUpdate from "../../packages/domain-operations/src/operations/learning/resource/version/update.operation";
import learningSnapshotPrune from "../../packages/domain-operations/src/operations/learning/snapshot/prune.operation";
import objectiveTransition from "../../packages/domain-operations/src/operations/objective/transition.operation";
import pluginStatusSet from "../../packages/domain-operations/src/operations/plugin/status/set.operation";
import policyChangeRequest from "../../packages/domain-operations/src/operations/policy/change/request.operation";
import profileChangeRequest from "../../packages/domain-operations/src/operations/profile/change/request.operation";
import resourceCopy from "../../packages/domain-operations/src/operations/resource/copy.operation";
import resourceMove from "../../packages/domain-operations/src/operations/resource/move.operation";
import resourcePromote from "../../packages/domain-operations/src/operations/resource/promote.operation";
import resourceRedact from "../../packages/domain-operations/src/operations/resource/redact.operation";
import resourceVersionGet from "../../packages/domain-operations/src/operations/resource/version/get.operation";
import roomCreate from "../../packages/domain-operations/src/operations/room/create.operation";
import roomAgentPermissionSet from "../../packages/domain-operations/src/operations/room/agent-permission-set.operation";
import roomAgentRemove from "../../packages/domain-operations/src/operations/room/agent-remove.operation";
import roomList from "../../packages/domain-operations/src/operations/room/list.operation";
import roomMemberAdd from "../../packages/domain-operations/src/operations/room/member-add.operation";
import roomMemberList from "../../packages/domain-operations/src/operations/room/member-list.operation";
import roomMemberRemove from "../../packages/domain-operations/src/operations/room/member-remove.operation";
import roomMemberRoleChange from "../../packages/domain-operations/src/operations/room/member-role-change.operation";
import roomOwnerRecover from "../../packages/domain-operations/src/operations/room/owner-recover.operation";
import roomOwnerTransfer from "../../packages/domain-operations/src/operations/room/owner-transfer.operation";
import roomOwnerlessList from "../../packages/domain-operations/src/operations/room/ownerless-list.operation";
import roomPatch from "../../packages/domain-operations/src/operations/room/patch.operation";
import roomResourceShare from "../../packages/domain-operations/src/operations/room/resource-share.operation";
import roomResourceShareList from "../../packages/domain-operations/src/operations/room/resource-share-list.operation";
import roomResourceShareRevoke from "../../packages/domain-operations/src/operations/room/resource-share-revoke.operation";
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
import soulChangeRequest from "../../packages/domain-operations/src/operations/soul/change/request.operation";
import workItemFollowUp from "../../packages/domain-operations/src/operations/work_item/follow_up.operation";
import workItemSteer from "../../packages/domain-operations/src/operations/work_item/steer.operation";
import workspaceMemberAdd from "../../packages/domain-operations/src/operations/workspace/member-add.operation";
import workspaceMemberList from "../../packages/domain-operations/src/operations/workspace/member-list.operation";
import workspaceMemberRemove from "../../packages/domain-operations/src/operations/workspace/member-remove.operation";
import workspaceMemberRoleChange from "../../packages/domain-operations/src/operations/workspace/member-role-change.operation";
import workspaceOwnerTransfer from "../../packages/domain-operations/src/operations/workspace/owner-transfer.operation";
import workspaceContextGet from "../../packages/domain-operations/src/operations/workspace/context/get.operation";
import { handlerExpectationCount, handlerExpectations, type HandlerCallExpectation } from "./domain-operation-handler-expectations";

const now = "2026-07-17T00:00:00.000Z";
const context: TrustedDomainContext = {
  inputSource: "runtime_api",
  workspaceId: "handler-matrix-workspace",
  actorId: "handler-matrix-actor",
  participant: { kind: "human", participantId: "human:owner" },
  roomId: "room_fixture",
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
const humanChangeActivity = {
  id: "activity_human_change_fixture",
  workspace_id: "workspace",
  room_id: "room_fixture",
  principal: { kind: "human" as const, participant_id: "human:owner" },
  source: { kind: "host" as const },
  status: "completed" as const,
  idempotency_key: "human-change-request:fixture",
  instruction_summary: "Request a human change.",
  result_summary: "Human review is required.",
  verification: [],
  domain_operation_ids: [],
  provenance: { kind: "trusted_context" as const, source_id: "handler-matrix", recorded_at: now },
  created_at: now,
  updated_at: now,
  finalized_at: now
};
const humanChangeRequestOutput = (requestKind: "policy" | "profile" | "soul") => ({
  request_kind: requestKind,
  status: "requested" as const,
  proposed_change_summary: handlerExpectations[`${requestKind}.change.request`].input.proposed_change_summary,
  affected_fields: handlerExpectations[`${requestKind}.change.request`].input.affected_fields,
  activity: humanChangeActivity
});
const roomOutput = { id: "room_fixture", name: "Fixture Room", created_at: now, updated_at: now };
const agentOutput = { id: "agent_fixture", name: "Fixture Agent", role: "Fixture", instructions: "Handle fixture work.", backend_id: "backend_fixture", enabled: true, created_at: now, updated_at: now };
const workspaceMemberOutput = { id: "workspace_member_fixture", participant_id: "human:member", role: "member" as const, joined_at: now, created_by_participant_id: "human:owner", updated_at: now };
const roomMemberOutput = { id: "room_member_fixture", room_id: roomOutput.id, participant_id: "human:member", role: "member" as const, joined_at: now, created_by_participant_id: "human:owner", updated_at: now };
const roomAgentPermissionOutput = { id: "room_agent_fixture", room_id: roomOutput.id, agent_id: agentOutput.id, can_view: true, can_edit: true, can_execute: true, joined_at: now, created_by_participant_id: "human:owner", updated_at: now };
const agentWorkspacePermissionOutput = { id: "agent_workspace_permission_fixture", agent_id: agentOutput.id, permission: "room.create" as const, granted_at: now, granted_by_participant_id: "human:owner", updated_at: now };
const roomResourceShareOutput = { id: "room_resource_share_fixture", resource_access_boundary_id: "resource_boundary_fixture", source_room_id: roomOutput.id, target_room_id: "room_target_fixture", shared_by_participant_id: "human:owner", created_at: now, updated_at: now };
const sessionOutput = { id: "session_fixture", session_key: "session_fixture", room_id: roomOutput.id, title: "Fixture session", ui_locale: "en" as const, output_locale: "ja" as const, created_at: now, updated_at: now };
const sessionSearchOutput = { mode: "fts5" as const, indexed: 1 };
const searchSessionOutput = [{ kind: "session" as const, id: "session_fixture", title: "Fixture session", summary: "fixture" }];
const searchMemoryOutput = [{ id: "memory_fixture", topic: "Fixture memory", state: "active" as const, file_path: "memory/fixture.md" }];
const searchWikiOutput = [{ id: "wiki_fixture", slug: "fixture", title: "Fixture wiki", file_path: "wiki/pages/fixture.md", version: 1 }];
const searchSkillOutput = [{ id: "skill_fixture", title: "Fixture skill", description: "Fixture", tags: ["fixture"], file_path: "skills/fixture/SKILL.md", version: 1 }];
const searchCollectionOutput = [{ kind: "collection_schema" as const, id: "collection_fixture", file_path: "collections/collection_fixture/schema.json", version: 1 }];
const learningSnapshotPruneOutput = { retained: 5, removed: ["snapshot_old"] };
const learningBackgroundReviewApplyOutput = { suggestions: [] };
const learningResourceUsageOutput = {
  use_record: {
    id: "learning_use_fixture", run_id: "run_fixture", session_id: "session_fixture", resource_kind: "skill" as const,
    resource_id: "resource_fixture", resource_version: "1", content_hash: "hash_fixture", usage_scope: { kind: "room" as const, room_id: "room_fixture" },
    stage: "applied" as const, source_operation_id: "learning.resource.usage.record", decision_summary: "Use the resource for this decision.", matched_conditions: ["fixture condition"],
    metadata: { source: "fixture" }, created_at: now
  }
};
const learningResourceVersionOutput = {
  resource_version: {
    id: "learning_resource_version_fixture", resource_kind: "wiki" as const, resource_id: "resource_fixture", version: "2", parent_version: "1",
    file_path: "wiki/pages/resource_fixture.md", content_hash: "hash_fixture", change_reason: "Apply the reviewed update.", source_run_ids: ["run_fixture"],
    actor: "fixture", is_current: true, restored_from_version: "1", created_at: now
  }
};
const resourceVersionOutput = { resource_key: "wiki:wiki_fixture", resource_kind: "wiki" as const, resource_id: "wiki_fixture", version: 1 };
const resourceTransferOutput = {
  resource: {
    resource_kind: "wiki" as const,
    source: { kind: "wiki" as const, id: "wiki_transfer_source", uri: "wiki/pages/transfer-source.md", label: "Transfer source", version: "1" },
    target: { kind: "wiki" as const, id: "wiki_transfer_copy", uri: "wiki/pages/transfer-copy.md", label: "Transfer copy", version: "1" },
    resource_version: 1
  },
  operation: {
    id: "operation_resource_transfer_fixture",
    session_id: "session_fixture",
    capability_id: "resource_transfer",
    operation: "resource.copy",
    actor_identity: "owner" as const,
    instruction_source: "owner_instruction" as const,
    instruction_authority: "owner",
    channel: "test",
    input_hash: "fixture_hash",
    target_resource_refs: [],
    proposed_effects: [],
    status: "completed" as const,
    created_at: now,
    updated_at: now
  },
  activity: []
};
const resourceRedactionOutput = {
  resource: {
    resource_kind: "wiki" as const,
    redacted_resource: { kind: "wiki" as const, id: "wiki_transfer_source", uri: "wiki/pages/transfer-source.md", label: "Transfer source", version: "2" },
    resource_version: 2,
    redaction_mode: "known_secret_patterns" as const
  },
  operation: {
    id: "operation_resource_redact_fixture",
    session_id: "session_fixture",
    capability_id: "resource_redact",
    operation: "resource.redact",
    actor_identity: "owner" as const,
    instruction_source: "owner_instruction" as const,
    instruction_authority: "owner",
    channel: "test",
    input_hash: "fixture_hash",
    target_resource_refs: [],
    proposed_effects: [],
    status: "completed" as const,
    created_at: now,
    updated_at: now
  },
  activity: []
};
const workspaceContextOutput = {
  workspace: { id: "handler-matrix-workspace", name: "Handler Workspace", rules: ["Keep Room data separate."], updated_at: now },
  room: { id: "room_fixture", name: "Fixture Room", purpose: "Fixture purpose", work_goal: "Fixture goal", updated_at: now }
};
const settingsOutput = {
  ui_locale: "en" as const, output_locale: "ja" as const, memory_capture_mode: "manual" as const,
  knowledge_wiki_capture_mode: "auto" as const, skill_capture_mode: "auto" as const,
  external_provider_role: "assistive" as const, learning_enabled: true, learning_budget_ratio: 0.1,
  learning_budget_window_days: 7, updated_at: now
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
    backend_run_id: "backend_run_fixture", output: { backend_status: "completed", output_text: "Fixture output" }
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
  bindAgentBackend(_context, input) { return record("agent.backend.bind", "bindAgentBackend", [_context, input], { ...agentOutput, backend_id: input.backendId }); }
}).execute(context, handlerExpectations["agent.backend.bind"].input));
await run("agent.create", () => agentCreate.createHandler({
  createAgent(_context, input) { return record("agent.create", "createAgent", [_context, input], { ...agentOutput, enabled: input.enabled ?? true }); }
}).execute(context, handlerExpectations["agent.create"].input));
await run("agent.list", () => agentList.createHandler({
  listAgents(_context) { return record("agent.list", "listAgents", [_context], [agentOutput]); }
}).execute(context, handlerExpectations["agent.list"].input));
await run("agent.patch", () => agentPatch.createHandler({
  patchAgent(_context, input) { return record("agent.patch", "patchAgent", [_context, input], { ...agentOutput, ...input }); }
}).execute(context, handlerExpectations["agent.patch"].input));
await run("agent.view", () => agentView.createHandler({
  viewAgent(_context, id) { return record("agent.view", "viewAgent", [_context, id], agentOutput); }
}).execute(context, handlerExpectations["agent.view"].input));
await run("agent.workspace_permission.set", () => agentWorkspacePermissionSet.createHandler({
  setAgentRoomCreatePermission(_context, input) { return record("agent.workspace_permission.set", "setAgentRoomCreatePermission", [_context, input], input.allowed ? agentWorkspacePermissionOutput : null); }
}).execute(context, handlerExpectations["agent.workspace_permission.set"].input));

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
  createSession(_context, input) { return record("session.create", "createSession", [_context, input], sessionOutput); }
}).execute(context, handlerExpectations["session.create"].input));

await run("room.create", () => roomCreate.createHandler({
  createRoom(_context, input) { return record("room.create", "createRoom", [_context, input], { ...roomOutput, ...input }); }
}).execute(context, handlerExpectations["room.create"].input));
await run("room.list", () => roomList.createHandler({
  listRooms(_context) { return record("room.list", "listRooms", [_context], [roomOutput]); }
}).execute(context, handlerExpectations["room.list"].input));
await run("room.patch", () => roomPatch.createHandler({
  patchRoom(_context, input) { return record("room.patch", "patchRoom", [_context, input], { ...roomOutput, ...input }); }
}).execute(context, handlerExpectations["room.patch"].input));
await run("room.view", () => roomView.createHandler({
  viewRoom(_context, id) { return record("room.view", "viewRoom", [_context, id], roomOutput); }
}).execute(context, handlerExpectations["room.view"].input));
await run("room.agent.permission.set", () => roomAgentPermissionSet.createHandler({
  setRoomAgentPermissions(_context, input) { return record("room.agent.permission.set", "setRoomAgentPermissions", [_context, input], { ...roomAgentPermissionOutput, can_view: input.canView, can_edit: input.canEdit, can_execute: input.canExecute }); }
}).execute(context, handlerExpectations["room.agent.permission.set"].input));
await run("room.agent.remove", () => roomAgentRemove.createHandler({
  removeRoomAgent(_context, input) { return record("room.agent.remove", "removeRoomAgent", [_context, input], { ...roomAgentPermissionOutput, removed_at: now, removed_by_participant_id: "human:owner" }); }
}).execute(context, handlerExpectations["room.agent.remove"].input));
await run("room.member.add", () => roomMemberAdd.createHandler({
  addRoomMember(_context, input) { return record("room.member.add", "addRoomMember", [_context, input], { ...roomMemberOutput, participant_id: input.participantId, role: input.role }); }
}).execute(context, handlerExpectations["room.member.add"].input));
await run("room.member.list", () => roomMemberList.createHandler({
  listRoomParticipants(_context, roomId) { return record("room.member.list", "listRoomParticipants", [_context, roomId], { humans: [roomMemberOutput], agents: [roomAgentPermissionOutput] }); }
}).execute(context, handlerExpectations["room.member.list"].input));
await run("room.member.remove", () => roomMemberRemove.createHandler({
  removeRoomMember(_context, input) { return record("room.member.remove", "removeRoomMember", [_context, input], { ...roomMemberOutput, participant_id: input.participantId, removed_at: now, removed_by_participant_id: "human:owner" }); }
}).execute(context, handlerExpectations["room.member.remove"].input));
await run("room.member.role.change", () => roomMemberRoleChange.createHandler({
  changeRoomMemberRole(_context, input) { return record("room.member.role.change", "changeRoomMemberRole", [_context, input], { ...roomMemberOutput, participant_id: input.participantId, role: input.role }); }
}).execute(context, handlerExpectations["room.member.role.change"].input));
await run("room.owner.recover", () => roomOwnerRecover.createHandler({
  recoverOwnerlessRoom(_context, input) { return record("room.owner.recover", "recoverOwnerlessRoom", [_context, input], { ...roomMemberOutput, participant_id: input.ownerParticipantId, role: "owner" as const }); }
}).execute(context, handlerExpectations["room.owner.recover"].input));
await run("room.owner.transfer", () => roomOwnerTransfer.createHandler({
  transferRoomOwnership(_context, input) { return record("room.owner.transfer", "transferRoomOwnership", [_context, input], { previousOwner: { ...roomMemberOutput, participant_id: "human:owner", role: "admin" as const }, owner: { ...roomMemberOutput, participant_id: input.toParticipantId, role: "owner" as const } }); }
}).execute(context, handlerExpectations["room.owner.transfer"].input));
await run("room.ownerless.list", () => roomOwnerlessList.createHandler({
  listOwnerlessRooms(_context) { return record("room.ownerless.list", "listOwnerlessRooms", [_context], [roomOutput]); }
}).execute(context, handlerExpectations["room.ownerless.list"].input));
await run("room.resource.share", () => roomResourceShare.createHandler({
  shareResource(_context, input) { return record("room.resource.share", "shareResource", [_context, input], { ...roomResourceShareOutput, source_room_id: input.sourceRoomId, target_room_id: input.targetRoomId }); }
}).execute(context, handlerExpectations["room.resource.share"].input));
await run("room.resource.share.list", () => roomResourceShareList.createHandler({
  listResourceShares(_context, input) { return record("room.resource.share.list", "listResourceShares", [_context, input], [roomResourceShareOutput]); }
}).execute(context, handlerExpectations["room.resource.share.list"].input));
await run("room.resource.share.revoke", () => roomResourceShareRevoke.createHandler({
  revokeResourceShare(_context, input) { return record("room.resource.share.revoke", "revokeResourceShare", [_context, input], { ...roomResourceShareOutput, source_room_id: input.sourceRoomId, target_room_id: input.targetRoomId, revoked_at: now, revoked_by_participant_id: "human:owner" }); }
}).execute(context, handlerExpectations["room.resource.share.revoke"].input));
await run("workspace.member.add", () => workspaceMemberAdd.createHandler({
  addWorkspaceMember(_context, input) { return record("workspace.member.add", "addWorkspaceMember", [_context, input], { ...workspaceMemberOutput, participant_id: input.participantId, role: input.role }); }
}).execute(context, handlerExpectations["workspace.member.add"].input));
await run("workspace.member.list", () => workspaceMemberList.createHandler({
  listWorkspaceMembers(_context) { return record("workspace.member.list", "listWorkspaceMembers", [_context], [workspaceMemberOutput]); }
}).execute(context, handlerExpectations["workspace.member.list"].input));
await run("workspace.member.remove", () => workspaceMemberRemove.createHandler({
  removeWorkspaceMember(_context, participantId) { return record("workspace.member.remove", "removeWorkspaceMember", [_context, participantId], { ...workspaceMemberOutput, participant_id: participantId, removed_at: now, removed_by_participant_id: "human:owner" }); }
}).execute(context, handlerExpectations["workspace.member.remove"].input));
await run("workspace.member.role.change", () => workspaceMemberRoleChange.createHandler({
  changeWorkspaceMemberRole(_context, input) { return record("workspace.member.role.change", "changeWorkspaceMemberRole", [_context, input], { ...workspaceMemberOutput, participant_id: input.participantId, role: input.role }); }
}).execute(context, handlerExpectations["workspace.member.role.change"].input));
await run("workspace.owner.transfer", () => workspaceOwnerTransfer.createHandler({
  transferWorkspaceOwnership(_context, participantId) { return record("workspace.owner.transfer", "transferWorkspaceOwnership", [_context, participantId], { previousOwner: { ...workspaceMemberOutput, participant_id: "human:owner", role: "admin" as const }, owner: { ...workspaceMemberOutput, participant_id: participantId, role: "owner" as const } }); }
}).execute(context, handlerExpectations["workspace.owner.transfer"].input));

await run("session.search.reindex", () => sessionSearchReindex.createHandler({
  reindexSessionSearch() { return record("session.search.reindex", "reindexSessionSearch", [], sessionSearchOutput); }
}).execute(context, handlerExpectations["session.search.reindex"].input));

await run("learning.snapshot.prune", () => learningSnapshotPrune.createHandler({
  pruneLearningSnapshots(input) { return record("learning.snapshot.prune", "pruneLearningSnapshots", [input], learningSnapshotPruneOutput); }
}).execute(context, handlerExpectations["learning.snapshot.prune"].input));

await run("learning.background_review.apply", () => learningBackgroundReviewApply.createHandler({
  applyBackgroundReviewMutations(input) { return record("learning.background_review.apply", "applyBackgroundReviewMutations", [input], learningBackgroundReviewApplyOutput); }
}).execute(context, handlerExpectations["learning.background_review.apply"].input));

await run("learning.resource.usage.record", () => learningResourceUsageRecord.createHandler({
  recordAppliedLearningResourceUse(input) { return record("learning.resource.usage.record", "recordAppliedLearningResourceUse", [input], learningResourceUsageOutput); }
}).execute(context, handlerExpectations["learning.resource.usage.record"].input));

await run("learning.resource.version.restore", () => learningResourceVersionRestore.createHandler({
  restoreLearningResourceVersion(input) { return record("learning.resource.version.restore", "restoreLearningResourceVersion", [input], learningResourceVersionOutput); }
}).execute(context, handlerExpectations["learning.resource.version.restore"].input));

await run("learning.resource.version.update", () => learningResourceVersionUpdate.createHandler({
  updateLearningResourceVersion(input) { return record("learning.resource.version.update", "updateLearningResourceVersion", [input], learningResourceVersionOutput); }
}).execute(context, handlerExpectations["learning.resource.version.update"].input));

await run("resource.version.get", () => resourceVersionGet.createHandler({
  getResourceVersion(_context, input) { return record("resource.version.get", "getResourceVersion", [_context, input], resourceVersionOutput); }
}).execute(context, handlerExpectations["resource.version.get"].input));

await run("resource.copy", () => resourceCopy.createHandler({
  copyResource(_context, input) { return record("resource.copy", "copyResource", [_context, input], resourceTransferOutput); }
}).execute(context, handlerExpectations["resource.copy"].input));

await run("resource.move", () => resourceMove.createHandler({
  moveResource(_context, input) { return record("resource.move", "moveResource", [_context, input], resourceTransferOutput); }
}).execute(context, handlerExpectations["resource.move"].input));

await run("resource.promote", () => resourcePromote.createHandler({
  promoteResource(_context, input) { return record("resource.promote", "promoteResource", [_context, input], resourceTransferOutput); }
}).execute(context, handlerExpectations["resource.promote"].input));

await run("resource.redact", () => resourceRedact.createHandler({
  redactResource(_context, input) { return record("resource.redact", "redactResource", [_context, input], resourceRedactionOutput); }
}).execute(context, handlerExpectations["resource.redact"].input));

await run("workspace.context.get", () => workspaceContextGet.createHandler({
  getWorkspaceContext(_context, input) { return record("workspace.context.get", "getWorkspaceContext", [_context, input], workspaceContextOutput); }
}).execute(context, handlerExpectations["workspace.context.get"].input));

await run("objective.transition", () => objectiveTransition.createHandler({
  transitionObjective(id, action) { return record("objective.transition", "transitionObjective", [id, action], { objective: objectiveOutput, workItems: [workItemOutput], cancelBackendRunIds: ["run_fixture"] }); }
}).execute(context, handlerExpectations["objective.transition"].input));

await run("plugin.status.set", () => pluginStatusSet.createHandler({
  setPluginEnabled(id, enabled) { return record("plugin.status.set", "setPluginEnabled", [id, enabled], true); },
  findPluginStatus(id) { return record("plugin.status.set", "findPluginStatus", [id], pluginOutput.plugin); },
  savePluginState(input) { return record("plugin.status.set", "savePluginState", [input], pluginOutput.state); },
  pluginNotFoundError() { throw new Error("plugin_not_found"); }
}).execute(context, handlerExpectations["plugin.status.set"].input));

await run("policy.change.request", () => policyChangeRequest.createHandler({
  requestHumanChange(_context, input) { return record("policy.change.request", "requestHumanChange", [_context, input], humanChangeRequestOutput("policy")); }
}).execute(context, handlerExpectations["policy.change.request"].input));

await run("profile.change.request", () => profileChangeRequest.createHandler({
  requestHumanChange(_context, input) { return record("profile.change.request", "requestHumanChange", [_context, input], humanChangeRequestOutput("profile")); }
}).execute(context, handlerExpectations["profile.change.request"].input));

await run("settings.patch", () => settingsPatch.createHandler({
  applySettingsPatch(input) { return record("settings.patch", "applySettingsPatch", [input], settingsOutput); }
}).execute(context, handlerExpectations["settings.patch"].input));

await run("skill.usage.record", () => skillUsageRecord.createHandler({
  recordSkillUsage(input) { return record("skill.usage.record", "recordSkillUsage", [input], skillUsageOutput); }
}).execute(context, handlerExpectations["skill.usage.record"].input));

await run("soul.change.request", () => soulChangeRequest.createHandler({
  requestHumanChange(_context, input) { return record("soul.change.request", "requestHumanChange", [_context, input], humanChangeRequestOutput("soul")); }
}).execute(context, handlerExpectations["soul.change.request"].input));

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

await run("activity.history.list", () => activityHistoryList.createHandler({
  listActivityHistory(input) { return record("activity.history.list", "listActivityHistory", [input], []); }
}).execute(context, handlerExpectations["activity.history.list"].input));

await run("session.search", () => sessionSearch.createHandler({
  searchSessions(_context, query, limit) { return record("session.search", "searchSessions", [_context, query, limit], searchSessionOutput); }
}).execute(context, handlerExpectations["session.search"].input));
await run("memory.search", () => memorySearch.createHandler({
  searchMemory(_context, query, limit) { return record("memory.search", "searchMemory", [_context, query, limit], searchMemoryOutput); }
}).execute(context, handlerExpectations["memory.search"].input));
await run("wiki.search", () => wikiSearch.createHandler({
  searchWiki(_context, query, limit) { return record("wiki.search", "searchWiki", [_context, query, limit], searchWikiOutput); }
}).execute(context, handlerExpectations["wiki.search"].input));
await run("skill.search", () => skillSearch.createHandler({
  searchSkills(_context, query, limit) { return record("skill.search", "searchSkills", [_context, query, limit], searchSkillOutput); }
}).execute(context, handlerExpectations["skill.search"].input));
await run("collection.search", () => collectionSearch.createHandler({
  searchCollections(_context, collectionId, query, limit, offset) { return record("collection.search", "searchCollections", [_context, collectionId, query, limit, offset], searchCollectionOutput); }
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
