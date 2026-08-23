import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nowIso, type AgentRecord, type CollectionSchema, type MemoryFrontmatter, type RoomRecord, type SessionRecord } from "@samurai-agent/core-schemas";
import { agentParticipantId, collectionRecordResourceId, humanParticipantId, localOwnerParticipantId } from "@samurai-agent/room-permissions";
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
  it("does not expose Session or Generated Surface as a new Room-share target", async () => {
    const store = await createStore();
    const runtime = new AgentRuntime(store);
    await expect(runtime.runRuntimeApiDomainCommand({
      command_id: "room.resource.share",
      idempotency_key: "core06-session-share-schema",
      payload: {
        target_room_id: "room_default",
        resource: { kind: "session", id: "legacy-session" }
      }
    }, {
      roomId: "room_default",
      participant: { kind: "human", participantId: localOwnerParticipantId }
    })).rejects.toMatchObject({ code: "validation" });
    await expect(runtime.runRuntimeApiDomainCommand({
      command_id: "room.resource.share",
      idempotency_key: "core08-generated-surface-share-schema",
      payload: {
        target_room_id: "room_default",
        resource: { kind: "generated_surface", id: "legacy-derived-surface" }
      }
    }, {
      roomId: "room_default",
      participant: { kind: "human", participantId: localOwnerParticipantId }
    })).rejects.toMatchObject({ code: "validation" });
    await runtime.shutdownMcpProcessPool();
    await store.close();
  });

  it("keeps an old Generated Surface share inspectable and revocable", async () => {
    const store = await createStore();
    const now = nowIso();
    const target = await store.createRoomWithOwner(roomRecord("room-core08-surface-share-target", now), localOwnerParticipantId);
    const boundary = await store.ensureResourceAccessBoundary({
      resourceKind: "generated_surface", resourceId: "legacy-derived-surface", sourceRoomId: "room_default",
      ownerParticipantId: localOwnerParticipantId, actorId: localOwnerParticipantId
    });
    await store.shareResource({
      resourceAccessBoundaryId: boundary.id, sourceRoomId: "room_default", targetRoomId: target.id, actorId: localOwnerParticipantId
    });
    const runtime = new AgentRuntime(store);
    const trusted = { roomId: "room_default", participant: { kind: "human" as const, participantId: localOwnerParticipantId } };

    const listed = await runtime.runRuntimeApiDomainQuery({
      query_id: "room.resource.share.list",
      payload: { resource: { kind: "generated_surface", id: "legacy-derived-surface" } }
    }, trusted);
    expect(listed.result).toEqual([expect.objectContaining({ target_room_id: target.id })]);

    await runtime.runRuntimeApiDomainCommand({
      command_id: "room.resource.share.revoke",
      idempotency_key: "core08-legacy-surface-share-revoke",
      payload: { target_room_id: target.id, resource: { kind: "generated_surface", id: "legacy-derived-surface" } }
    }, trusted);
    expect(await store.listRoomResourceShares(boundary.id)).toEqual([]);

    await runtime.shutdownMcpProcessPool();
    await store.close();
  });

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

  it("admits explicitly Workspace-scoped Knowledge for read, but never as a Room write", async () => {
    const store = await createStore();
    const now = nowIso();
    const room = await store.createRoomWithOwner(roomRecord("room-core06-workspace-knowledge", now), localOwnerParticipantId);
    const member = humanParticipantId("workspace-knowledge-member");
    await store.addWorkspaceMember({ participantId: member, role: "member", actorId: localOwnerParticipantId });
    await store.addRoomMember({ roomId: room.id, participantId: member, role: "member", actorId: localOwnerParticipantId });
    const memory: MemoryFrontmatter = {
      id: "memory-core06-workspace-common", state: "topic", topic: "Workspace common", source: "test",
      source_locale: "ja", content_locale: "ja", source_kind: "owner_instruction", instruction_authority: "owner",
      confidence: 1, created_by: "test", created_at: now, updated_at: now, related_memories: [], conflicts_with: [],
      sensitive_level: "none", usage_scope: { kind: "workspace" }
    };
    await store.saveMemory(memory, "Workspace common knowledge");
    const sourceRoom = await store.createRoomWithOwner(roomRecord("room-core06-workspace-knowledge-source", now), localOwnerParticipantId);
    const roomBoundMemory: MemoryFrontmatter = { ...memory, id: "memory-core06-room-bound-workspace-scope", topic: "Room-bound default scope" };
    await store.saveMemory(roomBoundMemory, "This must never become a cross-Room candidate");
    await store.ensureResourceAccessBoundary({
      resourceKind: "memory", resourceId: roomBoundMemory.id, sourceRoomId: sourceRoom.id,
      ownerParticipantId: localOwnerParticipantId, actorId: localOwnerParticipantId
    });
    const authorization = new RoomAuthorizationService(store);
    const principal = { kind: "human" as const, participantId: member };

    expect(await store.getResourceAccessMode({ resourceKind: "memory", resourceId: memory.id, roomId: room.id, participantId: member })).toBe("workspace");
    expect(await store.listResourceIdsAvailableInRoom({ resourceKind: "memory", roomId: room.id })).toContain(memory.id);
    expect(await store.listResourceIdsAvailableInRoom({ resourceKind: "memory", roomId: room.id })).not.toContain(roomBoundMemory.id);
    await expect(authorization.assertResource(principal, { roomId: room.id, action: "read", resourceKind: "memory", resourceId: memory.id })).resolves.toBeUndefined();
    await expect(authorization.assertResource(principal, { roomId: room.id, action: "edit", resourceKind: "memory", resourceId: memory.id }))
      .rejects.toMatchObject<Partial<RoomAuthorizationError>>({ reason: "resource_access_boundary_denied" });
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

    await expect(store.shareResource({
      resourceAccessBoundaryId: boundary.id,
      sourceRoomId: source.id,
      targetRoomId: target.id,
      actorId: sourceOwner
    })).rejects.toThrow("core06_session_share_forbidden");
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

  it("creates an Artifact from trusted Room context without creating a Session", async () => {
    const store = await createStore();
    const runtime = new AgentRuntime(store);
    const before = await store.listSessions();

    const result = await runtime.runRuntimeApiDomainCommand({
      command_id: "artifact.create",
      idempotency_key: "core06-artifact-without-session",
      payload: { title: "No fake Session", content: "Room-scoped execution" }
    }, { roomId: "room_default", participant: { kind: "human", participantId: localOwnerParticipantId } });

    expect(await store.listSessions()).toEqual(before);
    const artifact = (result.result as { resource: { id: string } }).resource;
    expect(await store.getResourceAccessBoundary("artifact", artifact.id)).toMatchObject({ source_room_id: "room_default" });
    await runtime.shutdownMcpProcessPool();
    await store.close();
  });

  it("keeps a Sessionless Artifact in its Room and records one idempotent Activity trail", async () => {
    const store = await createStore();
    const runtime = new AgentRuntime(store);
    const beforeSessions = await store.listSessions();
    const otherOwner = humanParticipantId("core08-other-room-owner");
    await store.addWorkspaceMember({ participantId: otherOwner, role: "member", actorId: localOwnerParticipantId });
    const otherRoom = await store.createRoomWithOwner(roomRecord("room-core08-other", nowIso()), otherOwner);
    const directContext = { roomId: "room_default", participant: { kind: "human" as const, participantId: localOwnerParticipantId } };
    const command = {
      command_id: "artifact.create",
      idempotency_key: "core08-artifact-idempotent",
      payload: { title: "Room-bound Artifact", content: "Session is optional provenance." }
    } as const;

    const first = await runtime.runRuntimeApiDomainCommand(command, directContext);
    const replayed = await runtime.runRuntimeApiDomainCommand(command, directContext);
    const artifact = (first.result as { resource: { id: string; created_by: string } }).resource;
    expect((replayed.result as { resource: { id: string } }).resource.id).toBe(artifact.id);
    expect(artifact.created_by).toBe(localOwnerParticipantId);
    expect((await store.listArtifacts()).filter((item) => item.id === artifact.id)).toHaveLength(1);
    expect(await store.listSessions()).toEqual(beforeSessions);

    const change = (await store.listWorkspaceChanges()).filter((item) => item.resource_ref.kind === "artifact" && item.resource_ref.id === artifact.id);
    expect(change).toHaveLength(1);
    expect(change[0]).toMatchObject({ room_id: "room_default", activity_id: expect.any(String), domain_operation_id: expect.any(String) });
    const activity = (await store.listActivities({ workspaceId: "workspace", roomId: "room_default" }))
      .find((item) => item.id === change[0]?.activity_id);
    expect(activity?.status).toBe("completed");
    expect(await store.listResourceUsage({ activityId: activity!.id })).toEqual(expect.arrayContaining([
      expect.objectContaining({ resource_ref: expect.objectContaining({ kind: "artifact", id: artifact.id }), stage: "modified" })
    ]));

    await expect(runtime.runRuntimeApiDomainCommand({
      command_id: "artifact.revise",
      idempotency_key: "core08-forged-session-ref",
      payload: { artifact_id: artifact.id, content: "must not cross Rooms" }
    }, {
      roomId: otherRoom.id,
      participant: { kind: "human", participantId: otherOwner },
      sessionRef: { app_id: "forged-app", session_id: "forged-session" }
    })).rejects.toMatchObject({ code: "forbidden" });
    await expect(runtime.runRuntimeApiDomainCommand({
      command_id: "artifact.create",
      idempotency_key: "core08-payload-context-rejected",
      payload: { title: "Rejected", content: "payload cannot pick a Room", room_id: otherRoom.id }
    }, directContext)).rejects.toMatchObject({ code: "bad_request" });
    expect(await store.readArtifactContent(artifact.id)).toBe("Session is optional provenance.");
    expect(await store.listSessions()).toEqual(beforeSessions);

    await runtime.shutdownMcpProcessPool();
    await store.close();
  });

  it("keeps a committed Artifact and Operation when only Core08 evidence fails", async () => {
    const store = await createStore();
    const runtime = new AgentRuntime(store);
    const trusted = { roomId: "room_default", participant: { kind: "human" as const, participantId: localOwnerParticipantId } };
    const command = {
      command_id: "artifact.create",
      idempotency_key: "core08-evidence-failure-freeze",
      payload: { title: "Committed before evidence", content: "The Artifact must not be duplicated." }
    } as const;
    const evidenceFailure = vi.spyOn(store, "commitResourceMutationEvidence")
      .mockRejectedValueOnce(new Error("workspace_change_write_failed"));

    await expect(runtime.runRuntimeApiDomainCommand(command, trusted)).rejects.toMatchObject({
      code: "resource_mutation_evidence_failed",
      payload: expect.objectContaining({ failure_stage: "workspace_change" })
    });
    evidenceFailure.mockRestore();

    const artifacts = (await store.listArtifacts()).filter((artifact) => artifact.title === "Committed before evidence");
    expect(artifacts).toHaveLength(1);
    const operation = (await store.listOperations()).find((candidate) => candidate.result_ref?.id === artifacts[0]?.id);
    expect(operation).toMatchObject({ status: "completed", operation: "artifact.create" });
    const activity = (await store.listActivities({ workspaceId: "workspace", roomId: "room_default" }))
      .find((candidate) => candidate.domain_operation_ids.includes(operation!.id));
    expect(activity).toMatchObject({ status: "failed", failure: expect.objectContaining({ code: "resource_mutation_evidence_failed" }) });
    expect((await store.listWorkspaceChanges()).filter((change) => change.resource_ref.id === artifacts[0]?.id)).toEqual([]);
    expect(await store.listResourceUsage({ activityId: activity!.id })).toEqual([]);

    await expect(runtime.runRuntimeApiDomainCommand(command, trusted)).rejects.toMatchObject({
      code: "resource_mutation_evidence_failed",
      payload: expect.objectContaining({ conflict: "domain_command_replay" })
    });
    expect((await store.listArtifacts()).filter((artifact) => artifact.title === "Committed before evidence")).toHaveLength(1);

    await runtime.shutdownMcpProcessPool();
    await store.close();
  });

  it("keeps a Sessionless Collection mutation in its Room and rejects stale or foreign patches", async () => {
    const store = await createStore();
    const runtime = new AgentRuntime(store);
    const beforeSessions = await store.listSessions();
    const otherOwner = humanParticipantId("core08-collection-other-room-owner");
    await store.addWorkspaceMember({ participantId: otherOwner, role: "member", actorId: localOwnerParticipantId });
    const otherRoom = await store.createRoomWithOwner(roomRecord("room-core08-collection-other", nowIso()), otherOwner);
    const directContext = { roomId: "room_default", participant: { kind: "human" as const, participantId: localOwnerParticipantId } };
    const schema: CollectionSchema = {
      id: "core08-sessionless-collection", version: "1",
      labels: { en: "Sessionless Collection" }, descriptions: { en: "Room-owned data" },
      fields: [{ id: "name", type: "string" }], refs: [], embeds: [], derived_fields: [], triggers: [], actions: [{ id: "repair-index", kind: "reindex" }], views: [], permissions: { update: true }
    };

    await runtime.runRuntimeApiDomainCommand({ command_id: "collection.schema.save", idempotency_key: "core08-collection-schema", payload: schema }, directContext);
    const created = await runtime.runRuntimeApiDomainCommand({
      command_id: "collection.record.create", idempotency_key: "core08-collection-record",
      payload: { collection_id: schema.id, record_id: "record", data: { name: "before" }, resource_refs: [] }
    }, directContext);
    const record = (created.result as { resource: { id: string } }).resource;
    const patched = await runtime.runRuntimeApiDomainCommand({
      command_id: "collection.patch.apply", idempotency_key: "core08-collection-patch",
      payload: { collection_id: schema.id, record_id: record.id, expected_version: 1, changes: { name: "after" } }
    }, directContext);
    expect((patched.result as { resource: { version: number; data: { name: string } } }).resource).toMatchObject({ version: 2, data: { name: "after" } });
    await expect(runtime.runRuntimeApiDomainCommand({
      command_id: "collection.patch.apply", idempotency_key: "core08-collection-stale",
      payload: { collection_id: schema.id, record_id: record.id, expected_version: 1, changes: { name: "stale" } }
    }, directContext)).rejects.toMatchObject({ code: "conflict" });
    await expect(runtime.runRuntimeApiDomainCommand({
      command_id: "collection.patch.apply", idempotency_key: "core08-collection-foreign",
      payload: { collection_id: schema.id, record_id: record.id, expected_version: 2, changes: { name: "foreign" } }
    }, {
      roomId: otherRoom.id,
      participant: { kind: "human", participantId: otherOwner },
      sessionRef: { app_id: "forged-app", session_id: "forged-collection-session" }
    })).rejects.toMatchObject({ code: "forbidden" });

    expect(await store.getResourceAccessBoundary("collection_schema", schema.id)).toMatchObject({ source_room_id: "room_default" });
    expect(await store.getResourceAccessBoundary("collection_record", collectionRecordResourceId(schema.id, record.id))).toMatchObject({ source_room_id: "room_default" });
    expect(await store.getCollectionRecord(schema.id, record.id)).toMatchObject({ version: 2, data: { name: "after" } });

    const changesBeforeReindex = await store.listWorkspaceChanges();
    const activitiesBeforeReindex = await store.listActivities({ workspaceId: "workspace", roomId: "room_default" });
    await runtime.runRuntimeApiDomainCommand({
      command_id: "collection.action.run", idempotency_key: "core08-collection-derived-reindex",
      payload: { collection_id: schema.id, action_id: "repair-index" }
    }, directContext);
    expect(await store.listWorkspaceChanges()).toHaveLength(changesBeforeReindex.length);
    expect(await store.listActivities({ workspaceId: "workspace", roomId: "room_default" })).toHaveLength(activitiesBeforeReindex.length);
    expect(await store.listSessions()).toEqual(beforeSessions);

    await runtime.shutdownMcpProcessPool();
    await store.close();
  });

  it("uses the Generated Surface Room boundary instead of a forged SessionRef", async () => {
    const store = await createStore();
    const runtime = new AgentRuntime(store);
    const beforeSessions = await store.listSessions();
    const directContext = { roomId: "room_default", participant: { kind: "human" as const, participantId: localOwnerParticipantId } };
    const created = await runtime.runRuntimeApiDomainCommand({
      command_id: "generated_surface.create",
      idempotency_key: "core08-surface-room-boundary",
      payload: {
        request: {
          user_intent: "Show a temporary control", source_resource_refs: [], allowed_domain_commands: ["artifact.create"],
          selected_knowledge_refs: [], selected_skill_refs: [], client_capabilities: { generated_surface: true },
          expected_lifetime: "session", fallback_chain: ["artifact", "text"]
        },
        bundle: {
          title: "Temporary control", html: '<main><button data-action-id="create">Create</button></main>', actions: [{
            id: "create", label: "Create", command_id: "artifact.create", input_schema: { type: "object" },
            payload_template: { title: "Not allowed", content: "foreign Room cannot run this" }, requires_confirmation: true
          }]
        }
      }
    }, directContext);
    const surface = (created.result as { definition: { id: string; current_revision_id: string; session_id?: string } }).definition;
    expect(surface.session_id).toBeUndefined();
    expect(await store.getResourceAccessBoundary("generated_surface", surface.id)).toMatchObject({ source_room_id: "room_default" });

    await expect(runtime.runGeneratedSurfaceAction({
      surfaceId: surface.id,
      revisionId: surface.current_revision_id,
      actionId: "create",
      interactionId: "core08-surface-action-without-confirmation"
    }, directContext)).rejects.toMatchObject({ code: "conflict", message: "generated_surface_action_confirmation_required" });

    const otherOwner = humanParticipantId("core08-surface-other-room-owner");
    await store.addWorkspaceMember({ participantId: otherOwner, role: "member", actorId: localOwnerParticipantId });
    const otherRoom = await store.createRoomWithOwner(roomRecord("room-core08-surface-other", nowIso()), otherOwner);
    await expect(runtime.runGeneratedSurfaceAction({
      surfaceId: surface.id,
      revisionId: surface.current_revision_id,
      actionId: "create",
      interactionId: "core08-forged-surface-action"
    }, {
      roomId: otherRoom.id,
      participant: { kind: "human", participantId: otherOwner },
      sessionRef: { app_id: "forged-app", session_id: "forged-surface-session" }
    })).rejects.toMatchObject({ code: "forbidden" });
    expect(await store.listSessions()).toEqual(beforeSessions);
    expect(await store.listArtifacts()).toHaveLength(0);

    await runtime.shutdownMcpProcessPool();
    await store.close();
  });

  it("does not route a Room mutation to the default Room without a trusted Room selector", async () => {
    const store = await createStore();
    const runtime = new AgentRuntime(store);
    const before = await store.listMemory({ includeArchived: true });

    await expect(runtime.runRuntimeApiDomainCommand({
      command_id: "memory.topic.create",
      idempotency_key: "core06-missing-room-selector",
      payload: { topic_kind: "preference", content: "既定Roomへ流れてはいけない" }
    })).rejects.toMatchObject({ code: "forbidden", message: "room_context_required" });

    expect(await store.listMemory({ includeArchived: true })).toEqual(before);
    await runtime.shutdownMcpProcessPool();
    await store.close();
  });

  it("does not create a fake Session for Session-scoped Memory", async () => {
    const store = await createStore();
    const runtime = new AgentRuntime(store);
    const before = await store.listSessions();

    await expect(runtime.runRuntimeApiDomainCommand({
      command_id: "memory.session.create",
      idempotency_key: "core06-memory-without-session",
      payload: { content: "Sessionなしでは保存しない" }
    }, { roomId: "room_default", participant: { kind: "human", participantId: localOwnerParticipantId } })).rejects.toMatchObject({ code: "unavailable" });

    expect(await store.listSessions()).toEqual(before);
    await runtime.shutdownMcpProcessPool();
    await store.close();
  });

  it("does not create a fake Session for a Chat turn", async () => {
    const store = await createStore();
    const runtime = new AgentRuntime(store);
    const before = await store.listSessions();

    await expect(runtime.runRuntimeApiDomainCommand({
      command_id: "chat.turn.run",
      idempotency_key: "core06-chat-without-session",
      payload: { content: "SessionなしChatは開始しない" }
    }, { roomId: "room_default", participant: { kind: "human", participantId: localOwnerParticipantId } })).rejects.toMatchObject({ code: "unavailable", message: "session_compatibility_required:chat.turn.run" });

    expect(await store.listSessions()).toEqual(before);
    await runtime.shutdownMcpProcessPool();
    await store.close();
  });

  it("does not create a fake Session for a Core07 Curator operation", async () => {
    const store = await createStore();
    const runtime = new AgentRuntime(store);
    const before = await store.listSessions();

    await expect(runtime.runRuntimeApiDomainCommand({
      command_id: "curator.run",
      idempotency_key: "core06-curator-without-session",
      payload: { reason: "user_request", resource_kind: "memory", resource_id: "memory_1" }
    }, { participant: { kind: "human", participantId: localOwnerParticipantId } })).rejects.toMatchObject({
      code: "unavailable",
      message: "session_compatibility_required:curator.run"
    });

    expect(await store.listSessions()).toEqual(before);
    await runtime.shutdownMcpProcessPool();
    await store.close();
  });

  it("lists Core08 Room Resources while keeping remaining Session compatibility commands hidden", async () => {
    const store = await createStore();
    const runtime = new AgentRuntime(store);

    const inventory = await runtime.listEffectiveDomainOperationsForRoom({
      roomId: "room_default",
      source: "runtime_api",
      principal: { kind: "human", participantId: localOwnerParticipantId }
    });
    const commandIds = new Set(inventory.commands.map((command) => command.id));

    expect(commandIds.has("file.write")).toBe(true);
    expect(commandIds.has("memory.topic.create")).toBe(true);
    expect(commandIds.has("skill.candidate.create")).toBe(true);
    expect(commandIds.has("wiki.proposal.create")).toBe(true);
    expect(commandIds.has("artifact.create")).toBe(true);
    expect(commandIds.has("collection.schema.save")).toBe(true);
    expect(commandIds.has("collection.record.create")).toBe(true);
    expect(commandIds.has("generated_surface.create")).toBe(true);
    expect(commandIds.has("chat.turn.run")).toBe(false);
    expect(commandIds.has("memory.session.create")).toBe(false);
    expect(commandIds.has("session.create")).toBe(false);
    expect(commandIds.has("curator.run")).toBe(false);

    await runtime.shutdownMcpProcessPool();
    await store.close();
  });

  it("allows a Room Member to create a new file but not overwrite an unbounded legacy file", async () => {
    const store = await createStore();
    const now = nowIso();
    const member = humanParticipantId("sessionless-file-member");
    const room = await store.createRoomWithOwner(roomRecord("room-core06-file-create", now), localOwnerParticipantId);
    await store.addWorkspaceMember({ participantId: member, role: "member", actorId: localOwnerParticipantId });
    await store.addRoomMember({ roomId: room.id, participantId: member, role: "member", actorId: localOwnerParticipantId });
    const runtime = new AgentRuntime(store);
    const trusted = { roomId: room.id, participant: { kind: "human" as const, participantId: member } };

    await runtime.runRuntimeApiDomainCommand({
      command_id: "file.write",
      idempotency_key: "core06-member-new-file",
      payload: { path: "member-created.txt", content: "Room-owned" }
    }, trusted);
    await writeFile(path.join(store.rootDir, "legacy-file.txt"), "legacy");

    await expect(runtime.runRuntimeApiDomainCommand({
      command_id: "file.write",
      idempotency_key: "core06-member-legacy-file",
      payload: { path: "legacy-file.txt", content: "must not overwrite" }
    }, trusted)).rejects.toMatchObject({ code: "forbidden" });

    const source = await store.createRoomWithOwner(roomRecord("room-core06-file-source", now), localOwnerParticipantId);
    await store.ensureResourceAccessBoundary({
      resourceKind: "file",
      resourceId: "deleted-source-file.txt",
      sourceRoomId: source.id,
      ownerParticipantId: localOwnerParticipantId,
      actorId: localOwnerParticipantId
    });
    await expect(runtime.runRuntimeApiDomainCommand({
      command_id: "file.write",
      idempotency_key: "core06-member-deleted-source-file",
      payload: { path: "deleted-source-file.txt", content: "別Roomの削除済みFileを再作成しない" }
    }, trusted)).rejects.toMatchObject({ code: "forbidden" });

    expect(await readFile(path.join(store.rootDir, "member-created.txt"), "utf8")).toBe("Room-owned");
    expect(await readFile(path.join(store.rootDir, "legacy-file.txt"), "utf8")).toBe("legacy");
    await expect(store.getResourceAccessBoundary("file", "member-created.txt")).resolves.toMatchObject({ source_room_id: room.id });

    await runtime.shutdownMcpProcessPool();
    await store.close();
  });

  it("rejects new Session-scoped knowledge even through a legacy Session adapter", async () => {
    const store = await createStore();
    const now = nowIso();
    const session = sessionRecord("session-core06-no-new-session-knowledge", "room_default", now);
    await store.createSession(session);
    const runtime = new AgentRuntime(store);
    const beforeMemory = await store.listMemory({ includeArchived: true });
    const beforeSkills = await store.listSkills();
    const trusted = {
      roomId: "room_default",
      sessionId: session.id,
      participant: { kind: "human" as const, participantId: localOwnerParticipantId }
    };

    await expect(runtime.runRuntimeApiDomainCommand({
      command_id: "memory.session.create",
      idempotency_key: "core06-legacy-session-memory",
      payload: { content: "新規Session Memoryは禁止" }
    }, trusted)).rejects.toMatchObject({ code: "conflict", message: "session_scope_write_disabled" });
    await expect(runtime.runRuntimeApiDomainCommand({
      command_id: "skill.candidate.create",
      idempotency_key: "core06-legacy-session-skill",
      payload: {
        title: "Session Skill",
        content: "新規Session Skillは禁止",
        usage_scope: { kind: "session", session_id: session.id }
      }
    }, trusted)).rejects.toMatchObject({ code: "conflict", message: "session_scope_write_disabled" });

    expect(await store.listMemory({ includeArchived: true })).toEqual(beforeMemory);
    expect(await store.listSkills()).toEqual(beforeSkills);

    await runtime.shutdownMcpProcessPool();
    await store.close();
  });

  it("writes Wiki, Skill, and Topic Memory into the trusted Room without a Session", async () => {
    const store = await createStore();
    const runtime = new AgentRuntime(store);
    const now = nowIso();
    const room = await store.createRoom(roomRecord("room-core06-sessionless-write", now));
    const beforeSessions = await store.listSessions();
    const trusted = {
      roomId: room.id,
      participant: { kind: "human" as const, participantId: localOwnerParticipantId }
    };

    const wikiResult = await runtime.runRuntimeApiDomainCommand({
      command_id: "wiki.proposal.create",
      idempotency_key: "core06-sessionless-wiki",
      payload: { title: "Room Wiki", content: "Room-only knowledge" }
    }, { ...trusted, correlationId: "core06-sessionless-wiki" });
    const skillResult = await runtime.runRuntimeApiDomainCommand({
      command_id: "skill.candidate.create",
      idempotency_key: "core06-sessionless-skill",
      payload: { title: "Room Skill", content: "Room-only instructions" }
    }, { ...trusted, correlationId: "core06-sessionless-skill" });
    const memoryResult = await runtime.runRuntimeApiDomainCommand({
      command_id: "memory.topic.create",
      idempotency_key: "core06-sessionless-memory",
      payload: { topic_kind: "preference", content: "Room-only preference" }
    }, { ...trusted, correlationId: "core06-sessionless-memory" });

    const wiki = (wikiResult.result as { resource: { id: string } }).resource;
    const skill = (skillResult.result as { resource: { id: string } }).resource;
    const memory = (memoryResult.result as { resource: { id: string } }).resource;
    const operations = [wikiResult, skillResult, memoryResult].map((result) =>
      (result.result as { operation: { id: string } }).operation.id
    );

    expect(await store.listSessions()).toEqual(beforeSessions);
    for (const operationId of operations) {
      const operation = await store.getOperation(operationId);
      expect(operation).toMatchObject({
        room_id: room.id,
        status: "completed",
        input_ref: expect.objectContaining({ kind: "workspace_context" })
      });
      expect(operation?.session_id).toBeUndefined();
    }
    await expect(store.getResourceAccessBoundary("wiki", wiki.id)).resolves.toMatchObject({ source_room_id: room.id });
    await expect(store.getResourceAccessBoundary("skill", skill.id)).resolves.toMatchObject({ source_room_id: room.id });
    await expect(store.getResourceAccessBoundary("memory", memory.id)).resolves.toMatchObject({ source_room_id: room.id });
    await expect(store.getMemory(memory.id)).resolves.toMatchObject({ usage_scope: { kind: "room", room_id: room.id } });

    await runtime.shutdownMcpProcessPool();
    await store.close();
  });

  it("does not let a Room member promote a Skill candidate from another Room", async () => {
    const store = await createStore();
    const runtime = new AgentRuntime(store);
    const now = nowIso();
    const source = await store.createRoomWithOwner(roomRecord("room-core06-skill-source", now), localOwnerParticipantId);
    const target = await store.createRoomWithOwner(roomRecord("room-core06-skill-target", now), localOwnerParticipantId);
    const member = humanParticipantId("skill-project-member");
    await store.addWorkspaceMember({ participantId: member, role: "member", actorId: localOwnerParticipantId });
    await store.addRoomMember({ roomId: target.id, participantId: member, role: "member", actorId: localOwnerParticipantId });

    const candidate = await runtime.runRuntimeApiDomainCommand({
      command_id: "skill.candidate.create",
      idempotency_key: "core06-source-skill-candidate",
      payload: { title: "Source candidate", content: "Room Aだけの候補" }
    }, {
      roomId: source.id,
      participant: { kind: "human", participantId: localOwnerParticipantId }
    });
    const candidateId = (candidate.result as { resource: { id: string } }).resource.id;

    await expect(runtime.runRuntimeApiDomainCommand({
      command_id: "skill.project.save",
      idempotency_key: "core06-foreign-skill-project",
      payload: { candidate_id: candidateId }
    }, {
      roomId: target.id,
      participant: { kind: "human", participantId: member }
    })).rejects.toMatchObject({ code: "forbidden" });
    expect((await store.listSkills()).filter((skill) => skill.state === "project")).toEqual([]);

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
      payload: { title: "Private" }
    }, { participant: { kind: "human", participantId }, roomId: room.id });
    const session = result.result as { id: string; room_id: string };
    expect(await store.getResourceAccessBoundary("session", session.id)).toMatchObject({
      source_room_id: room.id,
      owner_participant_id: participantId
    });

    await runtime.shutdownMcpProcessPool();
    await store.close();
  });

  it("takes the Room operation target from Trusted Context, not the payload", async () => {
    const store = await createStore();
    const runtime = new AgentRuntime(store);
    const room = await store.getRoom("room_default");
    expect(room).toBeDefined();

    await expect(runtime.runRuntimeApiDomainQuery({
      query_id: "room.member.list",
      payload: {}
    }, { participant: { kind: "human", participantId: localOwnerParticipantId }, roomId: room!.id })).resolves.toMatchObject({ ok: true });
    await expect(runtime.runRuntimeApiDomainQuery({
      query_id: "room.member.list",
      payload: { room_id: "room-forged" }
    }, { participant: { kind: "human", participantId: localOwnerParticipantId }, roomId: room!.id })).rejects.toMatchObject({ code: "bad_request" });

    await runtime.shutdownMcpProcessPool();
    await store.close();
  });

  it("keeps the External App id and delegation in the Domain audit record", async () => {
    const store = await createStore();
    const runtime = new AgentRuntime(store);
    const room = await store.getRoom("room_default");
    expect(room).toBeDefined();

    await runtime.runRuntimeApiDomainQuery({
      query_id: "room.member.list",
      payload: {}
    }, {
      roomId: room!.id,
      participant: {
        kind: "external_app",
        appId: "app:core06-test",
        delegatedBy: { kind: "human", participantId: localOwnerParticipantId }
      },
      source: { kind: "external_app", app_id: "app:core06-test" },
      sessionRef: { app_id: "app:core06-test", session_id: "external-session" },
      correlationId: "core06-external-audit"
    });

    await expect(store.listAuditRecords()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({
        participant_kind: "external_app",
        principal: expect.objectContaining({ kind: "external_app", app_id: "app:core06-test" }),
        source: expect.objectContaining({ kind: "external_app", app_id: "app:core06-test" }),
        session_ref: expect.objectContaining({ app_id: "app:core06-test" })
      })
    ]));

    await runtime.shutdownMcpProcessPool();
    await store.close();
  });

  it("rejects a mismatched External App principal, source, and SessionRef", async () => {
    const store = await createStore();
    const runtime = new AgentRuntime(store);
    const room = await store.getRoom("room_default");
    expect(room).toBeDefined();

    await expect(runtime.runRuntimeApiDomainQuery({
      query_id: "room.member.list",
      payload: {}
    }, {
      roomId: room!.id,
      participant: {
        kind: "external_app",
        appId: "app:principal-a",
        delegatedBy: { kind: "human", participantId: localOwnerParticipantId }
      },
      source: { kind: "external_app", app_id: "app:source-b" },
      sessionRef: { app_id: "app:session-c", session_id: "external-session" },
      correlationId: "core06-external-app-mismatch"
    })).rejects.toMatchObject({ code: "forbidden", message: "external_app_context_mismatch" });

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
