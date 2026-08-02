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

export const handlerExpectations = {
  "agent.backend.bind": {
    input: { id: "agent_fixture", backend_id: "backend_next" },
    calls: [{ method: "bindAgentBackend", args: [{ id: "agent_fixture", backendId: "backend_next" }] }]
  },
  "agent.create": {
    input: { name: "Fixture Agent", role: "Fixture", instructions: "Handle fixture work.", backend_id: "backend_fixture", enabled: false },
    calls: [{ method: "createAgent", args: [{ name: "Fixture Agent", role: "Fixture", instructions: "Handle fixture work.", backendId: "backend_fixture", enabled: false }] }]
  },
  "agent.list": { input: {}, calls: [{ method: "listAgents", args: [] }] },
  "agent.patch": {
    input: { id: "agent_fixture", role: "Updated fixture" },
    calls: [{ method: "patchAgent", args: [{ id: "agent_fixture", role: "Updated fixture" }] }]
  },
  "agent.view": { input: { id: "agent_fixture" }, calls: [{ method: "viewAgent", args: ["agent_fixture"] }] },
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
        sessionId: "session_fixture",
        payload: { approved: true }
      }]
    }]
  },
  "room.create": {
    input: { name: "Fixture Room" },
    calls: [{ method: "createRoom", args: [{ name: "Fixture Room" }] }]
  },
  "room.list": { input: {}, calls: [{ method: "listRooms", args: [] }] },
  "room.patch": {
    input: { id: "room_fixture", name: "Updated Room" },
    calls: [{ method: "patchRoom", args: [{ id: "room_fixture", name: "Updated Room" }] }]
  },
  "room.view": { input: { id: "room_fixture" }, calls: [{ method: "viewRoom", args: ["room_fixture"] }] },
  "session.create": {
    input: { title: "Fixture session", room_id: "room_fixture", ui_locale: "en", output_locale: "ja" },
    calls: [{ method: "createSession", args: [{ title: "Fixture session", roomId: "room_fixture", uiLocale: "en", outputLocale: "ja" }] }]
  },
  "session.search.reindex": { input: {}, calls: [{ method: "reindexSessionSearch", args: [] }] },
  "session.search": { input: { query: "fixture", limit: 5 }, calls: [{ method: "searchSessions", args: ["fixture", 5] }] },
  "memory.search": { input: { query: "fixture", limit: 5 }, calls: [{ method: "searchMemory", args: ["run_fixture", "fixture", 5] }] },
  "wiki.search": { input: { query: "fixture", limit: 5 }, calls: [{ method: "searchWiki", args: ["run_fixture", "fixture", 5] }] },
  "skill.search": { input: { query: "fixture", limit: 5 }, calls: [{ method: "searchSkills", args: ["run_fixture", "fixture", 5] }] },
  "collection.search": { input: { collection_id: "collection_fixture", query: "fixture", limit: 5 }, calls: [{ method: "searchCollections", args: ["collection_fixture", "fixture", 5] }] },
  "learning.snapshot.prune": {
    input: { retain: 5 },
    calls: [{ method: "pruneLearningSnapshots", args: [{ retain: 5 }] }]
  },
  "objective.transition": {
    input: { objective_id: "objective_fixture", action: "pause" },
    calls: [{ method: "transitionObjective", args: ["objective_fixture", "pause"] }]
  },
  "plugin.status.set": {
    input: { plugin_id: "plugin_fixture", status: "enabled" },
    calls: [
      { method: "setPluginEnabled", args: ["plugin_fixture", true] },
      { method: "findPluginStatus", args: ["plugin_fixture"] },
      { method: "savePluginState", args: [{ manifestId: "plugin_fixture", enabled: true, version: "1.0.0" }] }
    ]
  },
  "settings.patch": {
    input: { default_agent_id: "agent_fixture", default_room_id: "room_fixture", ui_locale: "en", output_locale: "ja", memory_capture_mode: "manual" },
    calls: [{ method: "applySettingsPatch", args: [{ defaultAgentId: "agent_fixture", defaultRoomId: "room_fixture", uiLocale: "en", outputLocale: "ja", memoryCaptureMode: "manual" }] }]
  },
  "skill.usage.record": {
    input: { skill_id: "skill_fixture", resource_id: "resource_fixture", content_hash: "hash_fixture", stage: "body_loaded", metadata: { source: "fixture" } },
    calls: [{ method: "recordSkillUsage", args: [{ skillId: "skill_fixture", runId: "run_fixture", resourceId: "resource_fixture", contentHash: "hash_fixture", stage: "body_loaded", metadata: { source: "fixture" } }] }]
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
    calls: [{ method: "createFollowUpWorkItem", args: [{ workItemId: "work_item_fixture", instruction: "Continue the fixture task" }] }]
  },
  "work_item.steer": {
    input: { work_item_id: "work_item_fixture", instruction: "Steer the fixture task" },
    calls: [{ method: "steerWorkItem", args: [{ workItemId: "work_item_fixture", instruction: "Steer the fixture task" }] }]
  }
} as const satisfies Record<string, HandlerExpectation>;

export const handlerExpectationCount = Object.keys(handlerExpectations).length;
