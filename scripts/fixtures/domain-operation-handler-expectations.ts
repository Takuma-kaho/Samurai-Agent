/**
 * Hand-reviewed Handler expectations. This is intentionally not generated
 * from Handler source: changing a Handler must update this file explicitly.
 * Each entry fixes its canonical DTO input plus the complete permitted Port
 * call sequence and argument values.
 */
export interface HandlerCallExpectation {
  method: string;
  args: unknown[];
}

export interface HandlerExpectation {
  input: Record<string, unknown>;
  calls: HandlerCallExpectation[];
}

const trustedContext = {
  inputSource: "runtime_api",
  workspaceId: "handler-matrix-workspace",
  actorId: "handler-matrix-actor",
  participant: { kind: "human", participantId: "human:owner" },
  roomId: "room_fixture",
  correlationId: "handler-matrix",
  sessionId: "session_fixture",
  runId: "run_fixture"
} as const;

export const handlerExpectations = {
  "activity.history.list": {
    input: {
      principal_id: "human:owner",
      source_kind: "external_app",
      source_id: "app_fixture",
      status: "completed",
      created_after: "2026-07-01T00:00:00.000Z",
      created_before: "2026-07-31T00:00:00.000Z",
      limit: 25
    },
    calls: [{
      method: "listActivityHistory",
      args: [{
        context: trustedContext,
        request: {
          principal_id: "human:owner",
          source_kind: "external_app",
          source_id: "app_fixture",
          status: "completed",
          created_after: "2026-07-01T00:00:00.000Z",
          created_before: "2026-07-31T00:00:00.000Z",
          limit: 25,
          offset: 0
        }
      }]
    }]
  },
  "agent.backend.bind": {
    input: { id: "agent_fixture", backend_id: "backend_next" },
    calls: [{ method: "bindAgentBackend", args: [trustedContext, { id: "agent_fixture", backendId: "backend_next" }] }]
  },
  "agent.create": {
    input: { name: "Fixture Agent", role: "Fixture", instructions: "Handle fixture work.", backend_id: "backend_fixture", enabled: false },
    calls: [{ method: "createAgent", args: [trustedContext, { name: "Fixture Agent", role: "Fixture", instructions: "Handle fixture work.", backendId: "backend_fixture", enabled: false }] }]
  },
  "agent.list": { input: {}, calls: [{ method: "listAgents", args: [trustedContext] }] },
  "agent.patch": {
    input: { id: "agent_fixture", role: "Updated fixture" },
    calls: [{ method: "patchAgent", args: [trustedContext, { id: "agent_fixture", role: "Updated fixture" }] }]
  },
  "agent.view": { input: { id: "agent_fixture" }, calls: [{ method: "viewAgent", args: [trustedContext, "agent_fixture"] }] },
  "agent.workspace_permission.set": {
    input: { agent_id: "agent_fixture", allowed: true },
    calls: [{ method: "setAgentRoomCreatePermission", args: [trustedContext, { agentId: "agent_fixture", allowed: true }] }]
  },
  "file.read": {
    input: { path: "workspace/notes.txt" },
    calls: [{ method: "readWorkspaceFile", args: [{ path: "workspace/notes.txt" }] }]
  },
  "file.list": {
    input: { path: "workspace" },
    calls: [{ method: "listWorkspaceFiles", args: [{ path: "workspace" }] }]
  },
  "file.inspect": {
    input: { path: "workspace/notes.txt" },
    calls: [{ method: "inspectWorkspaceFile", args: [{ path: "workspace/notes.txt" }] }]
  },
  "browser.extract": {
    input: { url: "https://example.com/page" },
    calls: [{ method: "extractBrowserPage", args: [{ url: "https://example.com/page" }] }]
  },
  "client.event.ack": {
    input: { event_id: "client_event_fixture" },
    calls: [{ method: "acknowledgeClientEvent", args: ["client_event_fixture"] }]
  },
  "client.event.deliver": {
    input: { event_id: "client_event_fixture" },
    calls: [{ method: "deliverClientEvent", args: ["client_event_fixture"] }]
  },
  "client.event.expire": {
    input: { now: "2026-07-17T00:00:00.000Z" },
    calls: [{ method: "expireClientEvents", args: ["2026-07-17T00:00:00.000Z"] }]
  },
  "client.event.fail": {
    input: { event_id: "client_event_fixture", error_code: "fixture_delivery_failed" },
    calls: [{ method: "failClientEvent", args: ["client_event_fixture", "fixture_delivery_failed"] }]
  },
  "client.event.save": {
    input: {
      id: "client_event_fixture",
      target_client_kind: "desktop",
      target_client_id: "desktop_fixture",
      event_type: "client.notification.requested",
      status: "pending",
      payload: { title: "Fixture notification" },
      resource_refs: [],
      created_at: "2026-07-17T00:00:00.000Z"
    },
    calls: [{
      method: "saveClientEvent",
      args: [{
        id: "client_event_fixture",
        target_client_kind: "desktop",
        target_client_id: "desktop_fixture",
        event_type: "client.notification.requested",
        status: "pending",
        payload: { title: "Fixture notification" },
        resource_refs: [],
        created_at: "2026-07-17T00:00:00.000Z"
      }]
    }]
  },
  "collection.action.run": {
    input: {
      collection_id: "collection_fixture",
      action_id: "action_fixture",
      record_id: "record_fixture",
      backend_id: "backend_fixture",
      payload: { approved: true }
    },
    calls: [{
      method: "runCollectionAction",
      args: [{
        collectionId: "collection_fixture",
        actionId: "action_fixture",
        recordId: "record_fixture",
        backendId: "backend_fixture",
        trustedContext,
        payload: { approved: true }
      }]
    }]
  },
  "room.create": {
    input: { name: "Fixture Room" },
    calls: [{ method: "createRoom", args: [trustedContext, { name: "Fixture Room" }] }]
  },
  "room.list": { input: {}, calls: [{ method: "listRooms", args: [trustedContext] }] },
  "room.patch": {
    input: { id: "room_fixture", name: "Updated Room" },
    calls: [{ method: "patchRoom", args: [trustedContext, { id: "room_fixture", name: "Updated Room" }] }]
  },
  "room.view": { input: { id: "room_fixture" }, calls: [{ method: "viewRoom", args: [trustedContext, "room_fixture"] }] },
  "room.agent.permission.set": {
    input: { room_id: "room_fixture", agent_id: "agent_fixture", can_view: true, can_edit: true, can_execute: true },
    calls: [{ method: "setRoomAgentPermissions", args: [trustedContext, { roomId: "room_fixture", agentId: "agent_fixture", canView: true, canEdit: true, canExecute: true }] }]
  },
  "room.agent.remove": {
    input: { room_id: "room_fixture", agent_id: "agent_fixture" },
    calls: [{ method: "removeRoomAgent", args: [trustedContext, { roomId: "room_fixture", agentId: "agent_fixture" }] }]
  },
  "room.member.add": {
    input: { room_id: "room_fixture", target_participant_id: "human:member", role: "member" },
    calls: [{ method: "addRoomMember", args: [trustedContext, { roomId: "room_fixture", participantId: "human:member", role: "member" }] }]
  },
  "room.member.list": {
    input: { room_id: "room_fixture" },
    calls: [{ method: "listRoomParticipants", args: [trustedContext, "room_fixture"] }]
  },
  "room.member.remove": {
    input: { room_id: "room_fixture", target_participant_id: "human:member" },
    calls: [{ method: "removeRoomMember", args: [trustedContext, { roomId: "room_fixture", participantId: "human:member" }] }]
  },
  "room.member.role.change": {
    input: { room_id: "room_fixture", target_participant_id: "human:member", role: "admin" },
    calls: [{ method: "changeRoomMemberRole", args: [trustedContext, { roomId: "room_fixture", participantId: "human:member", role: "admin" }] }]
  },
  "room.owner.recover": {
    input: { room_id: "room_fixture", owner_participant_id: "human:owner" },
    calls: [{ method: "recoverOwnerlessRoom", args: [trustedContext, { roomId: "room_fixture", ownerParticipantId: "human:owner" }] }]
  },
  "room.owner.transfer": {
    input: { room_id: "room_fixture", to_participant_id: "human:new-owner" },
    calls: [{ method: "transferRoomOwnership", args: [trustedContext, { roomId: "room_fixture", toParticipantId: "human:new-owner" }] }]
  },
  "room.ownerless.list": {
    input: {},
    calls: [{ method: "listOwnerlessRooms", args: [trustedContext] }]
  },
  "room.resource.share": {
    input: { source_room_id: "room_fixture", target_room_id: "room_target_fixture", resource: { kind: "artifact", id: "artifact_fixture" } },
    calls: [{ method: "shareResource", args: [trustedContext, { sourceRoomId: "room_fixture", targetRoomId: "room_target_fixture", resource: { kind: "artifact", id: "artifact_fixture" } }] }]
  },
  "room.resource.share.list": {
    input: { source_room_id: "room_fixture", resource: { kind: "artifact", id: "artifact_fixture" } },
    calls: [{ method: "listResourceShares", args: [trustedContext, { sourceRoomId: "room_fixture", resource: { kind: "artifact", id: "artifact_fixture" } }] }]
  },
  "room.resource.share.revoke": {
    input: { source_room_id: "room_fixture", target_room_id: "room_target_fixture", resource: { kind: "artifact", id: "artifact_fixture" } },
    calls: [{ method: "revokeResourceShare", args: [trustedContext, { sourceRoomId: "room_fixture", targetRoomId: "room_target_fixture", resource: { kind: "artifact", id: "artifact_fixture" } }] }]
  },
  "workspace.member.add": {
    input: { target_participant_id: "human:member", role: "member" },
    calls: [{ method: "addWorkspaceMember", args: [trustedContext, { participantId: "human:member", role: "member" }] }]
  },
  "workspace.member.list": {
    input: {},
    calls: [{ method: "listWorkspaceMembers", args: [trustedContext] }]
  },
  "workspace.member.remove": {
    input: { target_participant_id: "human:member" },
    calls: [{ method: "removeWorkspaceMember", args: [trustedContext, "human:member"] }]
  },
  "workspace.member.role.change": {
    input: { target_participant_id: "human:member", role: "admin" },
    calls: [{ method: "changeWorkspaceMemberRole", args: [trustedContext, { participantId: "human:member", role: "admin" }] }]
  },
  "workspace.owner.transfer": {
    input: { to_participant_id: "human:new-owner" },
    calls: [{ method: "transferWorkspaceOwnership", args: [trustedContext, "human:new-owner"] }]
  },
  "session.create": {
    input: { title: "Fixture session", ui_locale: "en", output_locale: "ja" },
    calls: [{ method: "createSession", args: [trustedContext, { title: "Fixture session", uiLocale: "en", outputLocale: "ja" }] }]
  },
  "session.search.reindex": { input: {}, calls: [{ method: "reindexSessionSearch", args: [] }] },
  "session.search": { input: { query: "fixture", limit: 5 }, calls: [{ method: "searchSessions", args: [trustedContext, "fixture", 5] }] },
  "memory.search": { input: { query: "fixture", limit: 5 }, calls: [{ method: "searchMemory", args: [trustedContext, "fixture", 5] }] },
  "wiki.search": { input: { query: "fixture", limit: 5 }, calls: [{ method: "searchWiki", args: [trustedContext, "fixture", 5] }] },
  "skill.search": { input: { query: "fixture", limit: 5 }, calls: [{ method: "searchSkills", args: [trustedContext, "fixture", 5] }] },
  "collection.search": { input: { collection_id: "collection_fixture", query: "fixture", limit: 5 }, calls: [{ method: "searchCollections", args: [trustedContext, "collection_fixture", "fixture", 5, 0] }] },
  "learning.snapshot.prune": {
    input: { retain: 5 },
    calls: [{ method: "pruneLearningSnapshots", args: [{ retain: 5 }] }]
  },
  "learning.background_review.apply": {
    input: { reflection_run_id: "reflection_fixture", mutations: [] },
    calls: [{ method: "applyBackgroundReviewMutations", args: [{ reflectionRunId: "reflection_fixture", sessionId: "session_fixture", roomId: "room_fixture", ownerParticipantId: "human:owner", creatorParticipantId: "human:owner", mutations: [] }] }]
  },
  "learning.resource.usage.record": {
    input: { resource_kind: "skill", resource_id: "resource_fixture", resource_version: "1", content_hash: "hash_fixture", decision_summary: "Use the resource for this decision.", matched_conditions: ["fixture condition"] },
    calls: [{ method: "recordAppliedLearningResourceUse", args: [{ runId: "run_fixture", resourceKind: "skill", resourceId: "resource_fixture", resourceVersion: "1", contentHash: "hash_fixture", decisionSummary: "Use the resource for this decision.", matchedConditions: ["fixture condition"] }] }]
  },
  "learning.resource.version.restore": {
    input: { resource_kind: "wiki", resource_id: "resource_fixture", target_version: "1", reason: "Restore the reviewed version." },
    calls: [{ method: "restoreLearningResourceVersion", args: [{ resourceKind: "wiki", resourceId: "resource_fixture", targetVersion: "1", reason: "Restore the reviewed version." }] }]
  },
  "learning.resource.version.update": {
    input: { resource_kind: "wiki", resource_id: "resource_fixture", change_reason: "Apply the reviewed update.", content: "Updated fixture content." },
    calls: [{ method: "updateLearningResourceVersion", args: [{ resourceKind: "wiki", resourceId: "resource_fixture", changeReason: "Apply the reviewed update.", content: "Updated fixture content." }] }]
  },
  "resource.version.get": {
    input: { resource_kind: "wiki", resource_id: "wiki_fixture" },
    calls: [{ method: "getResourceVersion", args: [trustedContext, { resource_kind: "wiki", resource_id: "wiki_fixture" }] }]
  },
  "resource.copy": {
    input: {
      resource_kind: "wiki",
      resource_id: "wiki_transfer_source",
      expected_resource_version: 1,
      target_room_id: "room_target_fixture",
      target_resource_id: "wiki_transfer_copy",
      reason: "Create an independent copy for the target Room."
    },
    calls: [{
      method: "copyResource",
      args: [trustedContext, {
        resource_kind: "wiki",
        resource_id: "wiki_transfer_source",
        expected_resource_version: 1,
        target_room_id: "room_target_fixture",
        target_resource_id: "wiki_transfer_copy",
        reason: "Create an independent copy for the target Room."
      }]
    }]
  },
  "resource.move": {
    input: {
      resource_kind: "wiki",
      resource_id: "wiki_transfer_source",
      expected_resource_version: 1,
      target_room_id: "room_target_fixture",
      reason: "Move this Resource to the authorized target Room."
    },
    calls: [{
      method: "moveResource",
      args: [trustedContext, {
        resource_kind: "wiki",
        resource_id: "wiki_transfer_source",
        expected_resource_version: 1,
        target_room_id: "room_target_fixture",
        reason: "Move this Resource to the authorized target Room."
      }]
    }]
  },
  "resource.promote": {
    input: {
      resource_kind: "wiki",
      resource_id: "wiki_transfer_source",
      expected_resource_version: 1,
      reason: "Create an explicit Workspace-scoped projection."
    },
    calls: [{
      method: "promoteResource",
      args: [trustedContext, {
        resource_kind: "wiki",
        resource_id: "wiki_transfer_source",
        expected_resource_version: 1,
        reason: "Create an explicit Workspace-scoped projection."
      }]
    }]
  },
  "resource.redact": {
    input: {
      resource_kind: "wiki",
      resource_id: "wiki_transfer_source",
      expected_resource_version: 1,
      reason: "Remove detected credentials before reuse."
    },
    calls: [{
      method: "redactResource",
      args: [trustedContext, {
        resource_kind: "wiki",
        resource_id: "wiki_transfer_source",
        expected_resource_version: 1,
        reason: "Remove detected credentials before reuse."
      }]
    }]
  },
  "workspace.context.get": {
    input: { room_id: "room_fixture" },
    calls: [{ method: "getWorkspaceContext", args: [trustedContext, { room_id: "room_fixture" }] }]
  },
  "objective.transition": {
    input: { objective_id: "objective_fixture", action: "pause" },
    calls: [{ method: "transitionObjective", args: ["objective_fixture", "pause", "room_fixture"] }]
  },
  "plugin.status.set": {
    input: { plugin_id: "plugin_fixture", status: "enabled" },
    calls: [
      { method: "findPluginStatus", args: ["plugin_fixture"] },
      { method: "getPluginEnabled", args: ["plugin_fixture"] },
      { method: "setPluginEnabled", args: ["plugin_fixture", true] },
      { method: "savePluginState", args: [{ manifestId: "plugin_fixture", enabled: true, version: "1.0.0" }] }
    ]
  },
  "policy.change.request": {
    input: { proposed_change_summary: "Clarify the retention rule.", affected_fields: ["retention_days"] },
    calls: [{ method: "requestHumanChange", args: [trustedContext, { request_kind: "policy", proposed_change_summary: "Clarify the retention rule.", affected_fields: ["retention_days"] }] }]
  },
  "profile.change.request": {
    input: { proposed_change_summary: "Update the public display name.", affected_fields: ["display_name"] },
    calls: [{ method: "requestHumanChange", args: [trustedContext, { request_kind: "profile", proposed_change_summary: "Update the public display name.", affected_fields: ["display_name"] }] }]
  },
  "settings.patch": {
    input: { default_agent_id: "agent_fixture", default_room_id: "room_fixture", ui_locale: "en", output_locale: "ja", memory_capture_mode: "manual" },
    calls: [{ method: "applySettingsPatch", args: [{ defaultAgentId: "agent_fixture", defaultRoomId: "room_fixture", uiLocale: "en", outputLocale: "ja", memoryCaptureMode: "manual" }] }]
  },
  "skill.usage.record": {
    input: { skill_id: "skill_fixture", resource_id: "resource_fixture", content_hash: "hash_fixture", stage: "body_loaded", metadata: { source: "fixture" } },
    calls: [{ method: "recordSkillUsage", args: [{ skillId: "skill_fixture", runId: "run_fixture", resourceId: "resource_fixture", contentHash: "hash_fixture", stage: "body_loaded", metadata: { source: "fixture" } }] }]
  },
  "soul.change.request": {
    input: { proposed_change_summary: "Review the assistant tone guidance.", affected_fields: ["tone"] },
    calls: [{ method: "requestHumanChange", args: [trustedContext, { request_kind: "soul", proposed_change_summary: "Review the assistant tone guidance.", affected_fields: ["tone"] }] }]
  },
  "curator.restore": {
    input: { snapshot_id: "snapshot_fixture" },
    calls: [{ method: "restoreCuratorSnapshot", args: ["snapshot_fixture"] }]
  },
  "curator.pause": { input: {}, calls: [{ method: "pauseCurator", args: [] }] },
  "curator.resume": { input: {}, calls: [{ method: "resumeCurator", args: [] }] },
  "curator.snapshot.create": {
    input: {},
    calls: [{ method: "createCuratorSnapshot", args: [] }]
  },
  "curator.snapshot.list": { input: {}, calls: [{ method: "listCuratorSnapshots", args: [] }] },
  "gateway.concurrency_lock.expire": {
    input: { now: "2026-07-17T00:00:00.000Z" },
    calls: [{ method: "expireGatewayConcurrencyLocks", args: [{ now: "2026-07-17T00:00:00.000Z" }] }]
  },
  "work_item.follow_up": {
    input: { work_item_id: "work_item_fixture", instruction: "Continue the fixture task" },
    calls: [{ method: "createFollowUpWorkItem", args: [{ workItemId: "work_item_fixture", instruction: "Continue the fixture task", roomId: "room_fixture" }] }]
  },
  "work_item.steer": {
    input: { work_item_id: "work_item_fixture", instruction: "Steer the fixture task" },
    calls: [{ method: "steerWorkItem", args: [{ workItemId: "work_item_fixture", instruction: "Steer the fixture task", roomId: "room_fixture" }] }]
  }
} as const satisfies Record<string, HandlerExpectation>;

export const handlerExpectationCount = Object.keys(handlerExpectations).length;
