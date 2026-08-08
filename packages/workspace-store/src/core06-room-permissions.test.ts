import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { nowIso, type AgentRecord, type RoomRecord, type SessionRecord } from "@samurai-agent/core-schemas";
import { agentParticipantId, humanParticipantId, localOwnerParticipantId } from "@samurai-agent/room-permissions";
import { WorkspaceStore } from "./index";

const roots: string[] = [];

async function createStore(): Promise<WorkspaceStore> {
  const root = await mkdtemp(path.join(tmpdir(), "samurai-core06-store-"));
  roots.push(root);
  return WorkspaceStore.create({ rootDir: root });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Core 06 Room participation persistence", () => {
  it("creates a Room and its single Owner together, then transfers without a second Owner", async () => {
    const store = await createStore();
    const now = nowIso();
    const room = await store.createRoom({ id: "room-core06-transfer", name: "Transfer", created_at: now, updated_at: now });
    const owner = await store.getRoomMember(room.id, localOwnerParticipantId);
    expect(owner).toMatchObject({ room_id: room.id, participant_id: localOwnerParticipantId, role: "owner" });

    const nextOwner = humanParticipantId("next-owner");
    await store.addWorkspaceMember({ participantId: nextOwner, role: "member", actorId: localOwnerParticipantId });
    await store.addRoomMember({ roomId: room.id, participantId: nextOwner, role: "admin", actorId: localOwnerParticipantId });
    await store.transferRoomOwnership({ roomId: room.id, fromParticipantId: localOwnerParticipantId, toParticipantId: nextOwner, actorId: localOwnerParticipantId });

    expect((await store.listRoomMembers(room.id)).filter((member) => member.role === "owner")).toEqual([
      expect.objectContaining({ participant_id: nextOwner })
    ]);
    expect(await store.getRoomMember(room.id, localOwnerParticipantId)).toMatchObject({ role: "admin" });
    await store.close();
  });

  it("keeps removal history while revoking current Room and explicit-share access", async () => {
    const store = await createStore();
    const now = nowIso();
    const source = await createRoom(store, "room-core06-source", now);
    const target = await createRoom(store, "room-core06-target", now);
    const member = humanParticipantId("member");
    await store.addWorkspaceMember({ participantId: member, role: "member", actorId: localOwnerParticipantId });
    await store.addRoomMember({ roomId: source.id, participantId: member, role: "member", actorId: localOwnerParticipantId });
    await store.addRoomMember({ roomId: target.id, participantId: member, role: "member", actorId: localOwnerParticipantId });
    const boundary = await store.ensureResourceAccessBoundary({
      resourceKind: "memory",
      resourceId: "memory-core06",
      sourceRoomId: source.id,
      ownerParticipantId: localOwnerParticipantId,
      actorId: localOwnerParticipantId
    });

    expect(await store.isResourceAvailableInRoom({ resourceKind: "memory", resourceId: "memory-core06", roomId: source.id, participantId: member })).toBe(true);
    expect(await store.isResourceAvailableInRoom({ resourceKind: "memory", resourceId: "memory-core06", roomId: target.id, participantId: member })).toBe(false);

    await store.shareResource({ resourceAccessBoundaryId: boundary.id, sourceRoomId: source.id, targetRoomId: target.id, actorId: localOwnerParticipantId });
    expect(await store.isResourceAvailableInRoom({ resourceKind: "memory", resourceId: "memory-core06", roomId: target.id, participantId: member })).toBe(true);

    await store.revokeRoomResourceShare({ resourceAccessBoundaryId: boundary.id, sourceRoomId: source.id, targetRoomId: target.id, actorId: localOwnerParticipantId });
    expect(await store.isResourceAvailableInRoom({ resourceKind: "memory", resourceId: "memory-core06", roomId: target.id, participantId: member })).toBe(false);

    const removed = await store.removeRoomMember({ roomId: source.id, participantId: member, actorId: localOwnerParticipantId });
    expect(removed).toMatchObject({ participant_id: member, role: "member" });
    expect(removed?.removed_at).toEqual(expect.any(String));
    expect(await store.getRoomMember(source.id, member)).toBeUndefined();
    expect(await store.listRoomMembers(source.id, { includeRemoved: true })).toEqual(expect.arrayContaining([
      expect.objectContaining({ participant_id: member, removed_at: expect.any(String) })
    ]));
    await store.close();
  });

  it("persists Agent permissions outside the human role hierarchy", async () => {
    const store = await createStore();
    const now = nowIso();
    const room = await createRoom(store, "room-core06-agent", now);
    const agent = agentRecord("agent-core06", now);
    await store.createAgent(agent);

    await expect(store.setRoomAgentPermissions({
      roomId: room.id,
      agentId: agent.id,
      canView: false,
      canEdit: true,
      canExecute: false,
      actorId: localOwnerParticipantId
    })).rejects.toThrow("room_agent_view_required");

    const saved = await store.setRoomAgentPermissions({
      roomId: room.id,
      agentId: agent.id,
      canView: true,
      canEdit: true,
      canExecute: true,
      actorId: localOwnerParticipantId
    });
    expect(saved).toMatchObject({ agent_id: agent.id, can_view: true, can_edit: true, can_execute: true });
    expect(agentParticipantId(agent.id)).not.toBe(localOwnerParticipantId);
    await store.close();
  });

  it("keeps a legacy Session share for diagnostics but never grants another Room access", async () => {
    const store = await createStore();
    const now = nowIso();
    const source = await createRoom(store, "room-core06-legacy-session-source", now);
    const target = await createRoom(store, "room-core06-legacy-session-target", now);
    const session: SessionRecord = {
      id: "session-core06-legacy-share", session_key: "legacy-share", room_id: source.id,
      title: "Legacy shared session", ui_locale: "ja", output_locale: "ja", created_at: now, updated_at: now
    };
    await store.createSession(session);
    const boundary = await store.ensureResourceAccessBoundary({
      resourceKind: "session", resourceId: session.id, sourceRoomId: source.id,
      ownerParticipantId: localOwnerParticipantId, actorId: localOwnerParticipantId
    });
    const dbPath = store.dbPath;
    await store.close();

    const database = new Database(dbPath);
    try {
      database.exec("DROP TRIGGER IF EXISTS core06_block_new_session_shares");
      database.prepare(`INSERT INTO room_resource_shares(
        id, resource_access_boundary_id, source_room_id, target_room_id, shared_by_participant_id,
        created_at, revoked_at, revoked_by_participant_id, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?)`)
        .run("legacy-session-share", boundary.id, source.id, target.id, localOwnerParticipantId, now, now);
    } finally {
      database.close();
    }

    const reopened = await WorkspaceStore.create({ rootDir: store.rootDir });
    expect(await reopened.listRoomResourceShares(boundary.id)).toEqual([
      expect.objectContaining({ id: "legacy-session-share", target_room_id: target.id })
    ]);
    await expect(reopened.getResourceAccessMode({
      resourceKind: "session", resourceId: session.id, roomId: source.id, participantId: localOwnerParticipantId
    })).resolves.toBe("source");
    await expect(reopened.getResourceAccessMode({
      resourceKind: "session", resourceId: session.id, roomId: target.id, participantId: localOwnerParticipantId
    })).resolves.toBe("denied");
    await expect(reopened.listResourceIdsAvailableInRoom({ resourceKind: "session", roomId: target.id }))
      .resolves.not.toContain(session.id);
    await reopened.close();
  });
});

async function createRoom(store: WorkspaceStore, id: string, now: string): Promise<RoomRecord> {
  return store.createRoom({ id, name: id, created_at: now, updated_at: now });
}

function agentRecord(id: string, now: string): AgentRecord {
  return {
    id,
    name: id,
    role: "Writer",
    instructions: "Write only with the Room permission.",
    backend_id: "samurai-native",
    enabled: true,
    created_at: now,
    updated_at: now
  };
}
