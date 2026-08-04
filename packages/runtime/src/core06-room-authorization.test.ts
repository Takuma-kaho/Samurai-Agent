import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { nowIso, type AgentRecord, type RoomRecord, type SessionRecord } from "@samurai-agent/core-schemas";
import { agentParticipantId, humanParticipantId, localOwnerParticipantId } from "@samurai-agent/room-permissions";
import { WorkspaceStore } from "@samurai-agent/workspace-store";
import { AgentRuntime } from "./agent-runtime.js";
import { RoomAuthorizationError, RoomAuthorizationService } from "./commands/services/room-authorization-service.js";
import { SearchDomainService, type SearchReadStore } from "./commands/services/search-domain-service.js";

const roots: string[] = [];

async function createStore(): Promise<WorkspaceStore> {
  const root = await mkdtemp(path.join(tmpdir(), "samurai-core06-runtime-"));
  roots.push(root);
  return WorkspaceStore.create({ rootDir: root });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Core 06 runtime authorization", () => {
  it("does not let a Workspace Owner read an unjoined Room and revokes Agent execution immediately", async () => {
    const store = await createStore();
    const now = nowIso();
    const otherOwner = humanParticipantId("other-owner");
    await store.addWorkspaceMember({ participantId: otherOwner, role: "member", actorId: localOwnerParticipantId });
    const room = await store.createRoomWithOwner(roomRecord("room-core06-private", now), otherOwner);
    const authorization = new RoomAuthorizationService(store);

    await expect(authorization.assertRoom(
      { kind: "human", participantId: localOwnerParticipantId },
      room.id,
      "read"
    )).rejects.toMatchObject<Partial<RoomAuthorizationError>>({ reason: "room_membership_missing" });

    const requester = humanParticipantId("requester");
    const agentId = "agent-core06-executor";
    await store.createAgent(agentRecord(agentId, now));
    await store.addWorkspaceMember({ participantId: requester, role: "member", actorId: localOwnerParticipantId });
    await store.addRoomMember({ roomId: room.id, participantId: requester, role: "member", actorId: otherOwner });
    await store.setRoomAgentPermissions({ roomId: room.id, agentId, canView: true, canEdit: false, canExecute: true, actorId: otherOwner });

    await expect(authorization.assertAgentExecution({ requesterParticipantId: requester, roomId: room.id, agentId })).resolves.toBeUndefined();
    await store.removeRoomAgent({ roomId: room.id, agentId, actorId: otherOwner });
    await expect(authorization.assertAgentExecution({ requesterParticipantId: requester, roomId: room.id, agentId })).rejects.toMatchObject<Partial<RoomAuthorizationError>>({ reason: "agent_not_in_room" });
    expect(agentParticipantId(agentId)).not.toBe(requester);
    await store.close();
  });

  it("does not create a Session boundary when an unjoined Workspace Owner tries to run it", async () => {
    const store = await createStore();
    const now = nowIso();
    const owner = humanParticipantId("legacy-run-owner");
    await store.addWorkspaceMember({ participantId: owner, role: "member", actorId: localOwnerParticipantId });
    const room = await store.createRoomWithOwner(roomRecord("room-core06-legacy-run", now), owner);
    const legacy = sessionRecord("session-core06-legacy-run", room.id, now);
    await store.createSession(legacy);
    const runtime = new AgentRuntime(store);

    await expect(runtime.runChatTurn({ sessionId: legacy.id, content: "private" })).rejects.toMatchObject({ code: "forbidden" });
    expect(await store.getResourceAccessBoundary("session", legacy.id)).toBeUndefined();

    await runtime.shutdownMcpProcessPool();
    await store.close();
  });

  it("does not let an unbound system ingress inherit the local Owner for Chat", async () => {
    const store = await createStore();
    const now = nowIso();
    const session = sessionRecord("session-core06-unbound-system", "room_default", now);
    await store.createSession(session);
    const runtime = new AgentRuntime(store);

    await expect(runtime.runDomainCommand({
      command_id: "chat.turn.run",
      input_source: "gateway_inbound",
      idempotency_key: "core06-unbound-system-chat",
      payload: { content: "must not run" }
    }, { sessionId: session.id })).rejects.toMatchObject({ code: "forbidden" });
    expect(await store.getResourceAccessBoundary("session", session.id)).toBeUndefined();

    await runtime.shutdownMcpProcessPool();
    await store.close();
  });

  it("returns only explicitly shared search candidates and stops returning them after revocation", async () => {
    const store = await createStore();
    const now = nowIso();
    const sourceOwner = humanParticipantId("source-owner");
    const targetOwner = humanParticipantId("target-owner");
    await store.addWorkspaceMember({ participantId: sourceOwner, role: "member", actorId: localOwnerParticipantId });
    await store.addWorkspaceMember({ participantId: targetOwner, role: "member", actorId: localOwnerParticipantId });
    const source = await store.createRoomWithOwner(roomRecord("room-core06-search-source", now), sourceOwner);
    const target = await store.createRoomWithOwner(roomRecord("room-core06-search-target", now), targetOwner);
    await store.addRoomMember({ roomId: target.id, participantId: sourceOwner, role: "member", actorId: targetOwner });
    const member = humanParticipantId("search-member");
    await store.addWorkspaceMember({ participantId: member, role: "member", actorId: localOwnerParticipantId });
    await store.addRoomMember({ roomId: source.id, participantId: member, role: "member", actorId: sourceOwner });
    await store.addRoomMember({ roomId: target.id, participantId: member, role: "member", actorId: targetOwner });
    const session = sessionRecord("session-core06-search", target.id, now);
    await store.createSession(session);
    const boundary = await store.ensureResourceAccessBoundary({
      resourceKind: "memory",
      resourceId: "memory-shared",
      sourceRoomId: source.id,
      ownerParticipantId: sourceOwner,
      actorId: sourceOwner
    });
    await store.ensureResourceAccessBoundary({
      resourceKind: "memory",
      resourceId: "memory-foreign",
      sourceRoomId: source.id,
      ownerParticipantId: sourceOwner,
      actorId: sourceOwner
    });

    const search = new SearchDomainService(searchStore(store, session), new RoomAuthorizationService(store));
    const context = { participant: { kind: "human" as const, participantId: member }, sessionId: session.id };
    await expect(search.searchMemory(context, "memory", 8)).resolves.toEqual([]);

    await store.shareResource({ resourceAccessBoundaryId: boundary.id, sourceRoomId: source.id, targetRoomId: target.id, actorId: member });
    await expect(search.searchMemory(context, "memory", 8)).resolves.toEqual([
      expect.objectContaining({ id: "memory-shared" })
    ]);

    await store.revokeRoomResourceShare({ resourceAccessBoundaryId: boundary.id, sourceRoomId: source.id, targetRoomId: target.id, actorId: member });
    await expect(search.searchMemory(context, "memory", 8)).resolves.toEqual([]);
    await store.close();
  });

  it("queries only authorized Session candidates before returning search results", async () => {
    const store = await createStore();
    const now = nowIso();
    const sourceOwner = humanParticipantId("session-source-owner");
    const targetOwner = humanParticipantId("session-target-owner");
    await store.addWorkspaceMember({ participantId: sourceOwner, role: "member", actorId: localOwnerParticipantId });
    await store.addWorkspaceMember({ participantId: targetOwner, role: "member", actorId: localOwnerParticipantId });
    const source = await store.createRoomWithOwner(roomRecord("room-core06-session-source", now), sourceOwner);
    const target = await store.createRoomWithOwner(roomRecord("room-core06-session-target", now), targetOwner);
    await store.addRoomMember({ roomId: target.id, participantId: sourceOwner, role: "member", actorId: targetOwner });
    const member = humanParticipantId("session-search-member");
    await store.addWorkspaceMember({ participantId: member, role: "member", actorId: localOwnerParticipantId });
    await store.addRoomMember({ roomId: target.id, participantId: member, role: "member", actorId: targetOwner });

    const sourceSession = sessionRecord("session-core06-source-secret", source.id, now);
    const targetSession = sessionRecord("session-core06-target", target.id, now);
    sourceSession.title = "secret source session";
    targetSession.title = "target session";
    await store.createSession(sourceSession);
    await store.createSession(targetSession);
    const boundary = await store.ensureResourceAccessBoundary({
      resourceKind: "session",
      resourceId: sourceSession.id,
      sourceRoomId: source.id,
      ownerParticipantId: sourceOwner,
      actorId: sourceOwner
    });
    await store.ensureResourceAccessBoundary({
      resourceKind: "session",
      resourceId: targetSession.id,
      sourceRoomId: target.id,
      ownerParticipantId: targetOwner,
      actorId: targetOwner
    });

    const search = new SearchDomainService(store, new RoomAuthorizationService(store));
    const context = { participant: { kind: "human" as const, participantId: member }, sessionId: targetSession.id };
    await expect(search.searchSessions(context, "secret", 8)).resolves.toEqual([]);

    await store.shareResource({ resourceAccessBoundaryId: boundary.id, sourceRoomId: source.id, targetRoomId: target.id, actorId: sourceOwner });
    await expect(search.searchSessions(context, "secret", 8)).resolves.toEqual([
      expect.objectContaining({ kind: "session", id: sourceSession.id })
    ]);

    await store.revokeRoomResourceShare({ resourceAccessBoundaryId: boundary.id, sourceRoomId: source.id, targetRoomId: target.id, actorId: sourceOwner });
    await expect(search.searchSessions(context, "secret", 8)).resolves.toEqual([]);
    await store.close();
  });

  it("rechecks a same-Room legacy Session before returning a search result", async () => {
    const store = await createStore();
    const now = nowIso();
    const room = await store.createRoomWithOwner(roomRecord("room-core06-legacy-search", now), localOwnerParticipantId);
    const member = humanParticipantId("legacy-search-member");
    await store.addWorkspaceMember({ participantId: member, role: "member", actorId: localOwnerParticipantId });
    await store.addRoomMember({ roomId: room.id, participantId: member, role: "member", actorId: localOwnerParticipantId });
    const legacy = sessionRecord("session-core06-legacy-secret", room.id, now);
    legacy.title = "legacy secret";
    await store.createSession(legacy);

    const search = new SearchDomainService(searchStore(store, legacy, [{
      kind: "session",
      id: legacy.id,
      title: legacy.title,
      summary: "legacy secret"
    }]), new RoomAuthorizationService(store));
    await expect(search.searchSessions({ participant: { kind: "human", participantId: member }, sessionId: legacy.id }, "secret", 8)).resolves.toEqual([]);
    await store.close();
  });

  it("records a Room boundary when a Session is created through the Domain command", async () => {
    const store = await createStore();
    const runtime = new AgentRuntime(store);
    const result = await runtime.runRuntimeApiDomainCommand({
      command_id: "session.create",
      idempotency_key: "core06-session-boundary",
      payload: { title: "Boundary" }
    });
    const session = result.result as { id: string; room_id: string };
    expect(await store.getResourceAccessBoundary("session", session.id)).toMatchObject({
      source_room_id: session.room_id,
      owner_participant_id: localOwnerParticipantId
    });
    await runtime.shutdownMcpProcessPool();
    await store.close();
  });

  it("keeps the trusted Room participant as the owner of a Session created through the Domain command", async () => {
    const store = await createStore();
    const now = nowIso();
    const participantId = humanParticipantId("private-session-owner");
    await store.addWorkspaceMember({ participantId, role: "member", actorId: localOwnerParticipantId });
    const room = await store.createRoomWithOwner(roomRecord("room-core06-private-session", now), participantId);
    const runtime = new AgentRuntime(store);

    const result = await runtime.runDomainCommand({
      command_id: "session.create",
      input_source: "runtime_api",
      idempotency_key: "core06-private-session-owner",
      payload: { room_id: room.id, title: "Private" }
    }, { participant: { kind: "human", participantId } });
    const session = result.result as { id: string; room_id: string };
    expect(await store.getResourceAccessBoundary("session", session.id)).toMatchObject({
      source_room_id: room.id,
      owner_participant_id: participantId
    });

    await runtime.shutdownMcpProcessPool();
    await store.close();
  });

  it("does not let an external-send draft be read or dispatched from another Room", async () => {
    const store = await createStore();
    const now = nowIso();
    const source = await store.createRoom(roomRecord("room-core06-send-source", now));
    const target = await store.createRoom(roomRecord("room-core06-send-target", now));
    const sourceSession = sessionRecord("session-core06-send-source", source.id, now);
    const targetSession = sessionRecord("session-core06-send-target", target.id, now);
    await store.createSession(sourceSession);
    await store.createSession(targetSession);
    await store.ensureResourceAccessBoundary({ resourceKind: "session", resourceId: sourceSession.id, sourceRoomId: source.id, ownerParticipantId: localOwnerParticipantId, actorId: localOwnerParticipantId });
    await store.ensureResourceAccessBoundary({ resourceKind: "session", resourceId: targetSession.id, sourceRoomId: target.id, ownerParticipantId: localOwnerParticipantId, actorId: localOwnerParticipantId });
    const runtime = new AgentRuntime(store);
    const sourceContext = { participant: { kind: "human" as const, participantId: localOwnerParticipantId }, sessionId: sourceSession.id };
    const targetContext = { participant: { kind: "human" as const, participantId: localOwnerParticipantId }, sessionId: targetSession.id };

    const prepared = await runtime.runDomainCommand({
      command_id: "external.send.prepare",
      input_source: "runtime_api",
      idempotency_key: "core06-external-send-source",
      payload: { channel: "webhook", target: { url: "https://example.invalid" }, title: "Private", body: "source Room only" }
    }, sourceContext);
    const send = prepared.result as { resource: { id: string } };

    await expect(runtime.runDomainCommand({
      command_id: "external.send.dispatch",
      input_source: "runtime_api",
      idempotency_key: "core06-external-send-target",
      payload: { send_id: send.resource.id, dry_run: true }
    }, targetContext)).rejects.toMatchObject({ code: "not_found" });

    await runtime.shutdownMcpProcessPool();
    await store.close();
  });
});

function searchStore(
  store: WorkspaceStore,
  session: SessionRecord,
  sessionSearchResults: Array<{ kind: "session" | "message" | "artifact" | "audit"; id: string; title: string; summary: string; session_id?: string }> = []
): SearchReadStore {
  const memories = ["memory-shared", "memory-foreign"].map((id) => ({
    id,
    topic: id,
    state: "active" as const,
    file_path: `memory/${id}.md`
  }));
  return {
    search: async () => sessionSearchResults,
    getBackendRun: async () => undefined,
    getSession: async (id) => id === session.id ? session : undefined,
    listSessions: async () => [session],
    getRoom: (id) => store.getRoom(id),
    getAgent: async () => undefined,
    searchMemory: async (_query, _limit, options) => memories
      .filter((memory) => options?.resourceIds?.includes(memory.id) ?? true) as never,
    searchWiki: async () => [],
    searchSkills: async () => [],
    getCollectionSchema: async () => undefined,
    listCollectionSchemas: async () => [],
    listCollectionRecords: async () => []
  };
}

function roomRecord(id: string, now: string): RoomRecord {
  return { id, name: id, created_at: now, updated_at: now };
}

function sessionRecord(id: string, roomId: string, now: string): SessionRecord {
  return { id, session_key: id, room_id: roomId, title: id, ui_locale: "ja", output_locale: "ja", created_at: now, updated_at: now };
}

function agentRecord(id: string, now: string): AgentRecord {
  return { id, name: id, role: "Writer", instructions: "Room permission test agent.", backend_id: "samurai-native", enabled: true, created_at: now, updated_at: now };
}
