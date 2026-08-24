import { createPrivateKey, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { io as connectSocket, type Socket } from "socket.io-client";
import {
  accountIdFromPublicKey,
  createAccountSignaturePayload,
  PostgresWorkspaceAdminDatabase,
  PostgresWorkspaceDatabase,
  WorkspaceBundleV3Service,
  WorkspaceFileStore,
  WorkspaceServerStore
} from "../packages/workspace-server/src/index.ts";
import { createWorkspaceServerHttp } from "../apps/server/src/workspace-server/http-server.ts";

interface ProbeTarget {
  label: "hosted" | "self_host";
  databaseUrl: string;
  adminDatabaseUrl: string;
  runtimeRole: string;
}

interface ProbeAccount {
  id: string;
  publicKey: string;
  privateKey: string;
}

const targets: ProbeTarget[] = [
  targetFromEnvironment("HOSTED", "hosted"),
  targetFromEnvironment("SELF_HOST", "self_host")
];

if (process.env.SAMURAI_SERVER_VERIFY_ALLOW_DESTRUCTIVE_PROBE !== "yes") {
  throw new Error("server03_probe_destructive_confirmation_required");
}

for (const target of targets) await runProbe(target);

function targetFromEnvironment(prefix: "HOSTED" | "SELF_HOST", label: ProbeTarget["label"]): ProbeTarget {
  const databaseUrl = process.env["SAMURAI_SERVER_VERIFY_" + prefix + "_DATABASE_URL"];
  const adminDatabaseUrl = process.env["SAMURAI_SERVER_VERIFY_" + prefix + "_DATABASE_ADMIN_URL"];
  const runtimeRole = process.env["SAMURAI_SERVER_VERIFY_" + prefix + "_DATABASE_RUNTIME_ROLE"];
  if (!databaseUrl || !adminDatabaseUrl || !runtimeRole) throw new Error("server03_probe_" + label + "_configuration_missing");
  return { label, databaseUrl, adminDatabaseUrl, runtimeRole };
}

async function runProbe(target: ProbeTarget): Promise<void> {
  const suffix = randomUUID().replaceAll("-", "");
  const workspaceId = "workspace_room03_" + target.label + "_" + suffix;
  const restoredWorkspaceId = "workspace_room03_restore_" + suffix;
  const foreignWorkspaceId = "workspace_room03_foreign_" + suffix;
  const root = await mkdtemp(path.join(os.tmpdir(), "samurai-server03-"));
  const database = new PostgresWorkspaceDatabase({ databaseUrl: target.databaseUrl, runtimeRole: target.runtimeRole });
  const adminDatabase = new PostgresWorkspaceAdminDatabase({ databaseAdminUrl: target.adminDatabaseUrl, runtimeRole: target.runtimeRole });
  const owner = accountIdentity();
  const member = accountIdentity();
  const parentOnlyMember = accountIdentity();
  const missingParentMember = accountIdentity();
  const realtimeMember = accountIdentity();
  const invitationMember = accountIdentity();
  const disabledInvitationMember = accountIdentity();
  const httpInvitationMember = accountIdentity();
  const accounts = [owner, member, parentOnlyMember, missingParentMember, realtimeMember, invitationMember, disabledInvitationMember, httpInvitationMember];
  try {
    await adminDatabase.migrate();
    await database.assertReady();
    const store = new WorkspaceServerStore({
      database,
      mode: target.label,
      ...(target.label === "self_host" ? { selfHostWorkspaceId: workspaceId, selfHostInitialAdminId: owner.id } : {}),
      storageRoot: root,
      invitationTokenSecret: "x".repeat(32)
    });
    for (const account of accounts) {
      await store.registerAccount({ id: account.id, publicKey: account.publicKey, displayName: account.id });
    }
    const created = await store.createWorkspace({
      id: workspaceId,
      name: "Room hierarchy probe",
      ownerAccountId: owner.id,
      operationId: operationId("create"),
      hostingMode: target.label,
      databasePlacement: target.label === "hosted" ? "shared" : "dedicated"
    });
    const rootRoom = created.defaultRoom;
    assert(!rootRoom.parentRoomId, "server03_workspace_saved_as_room");
    const ownerContext = (id: string) => ({ workspaceId, accountId: owner.id, operationId: id });
    const createRoom = async (...input: Parameters<WorkspaceServerStore["createRoom"]>) => (await store.createRoom(...input)).room;

    for (const account of [member, parentOnlyMember, missingParentMember, realtimeMember]) {
      await store.setWorkspaceMember(ownerContext(operationId("workspace-member")), {
        accountId: account.id,
        role: "member",
        state: "active",
        expectedVersion: 0
      });
    }
    await store.setRoomMember(ownerContext(operationId("root-member")), {
      roomId: rootRoom.id,
      accountId: member.id,
      role: "member",
      state: "active",
      expectedVersion: 0
    });
    await store.setRoomMember(ownerContext(operationId("root-parent-only")), {
      roomId: rootRoom.id,
      accountId: parentOnlyMember.id,
      role: "member",
      state: "active",
      expectedVersion: 0
    });

    const child = await createRoom(ownerContext(operationId("child")), {
      name: "Child",
      parentRoomId: rootRoom.id,
      expectedWorkspaceVersion: await workspaceVersion(store, workspaceId, owner.id)
    });
    await assertRuntimeRoomMutationTablesDenied(database, { workspaceId, accountId: owner.id });
    await store.setRoomMember(ownerContext(operationId("child-member")), {
      roomId: child.id,
      accountId: member.id,
      role: "member",
      state: "active",
      expectedVersion: 0
    });
    const invitationChild = await createRoom(ownerContext(operationId("invitation-child")), {
      name: "Invitation child",
      parentRoomId: rootRoom.id,
      expectedWorkspaceVersion: await workspaceVersion(store, workspaceId, owner.id)
    });
    const childOnlyInvitation = await store.createInvitation(ownerContext(operationId("invite-child-without-parent")), {
      roomId: invitationChild.id,
      workspaceRole: "member",
      roomRole: "member",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      expectedWorkspaceVersion: await workspaceVersion(store, workspaceId, owner.id)
    });
    await expectCode("room_parent_membership_required", async () => {
      await store.acceptInvitation({
        workspaceId,
        accountId: missingParentMember.id,
        operationId: operationId("accept-child-without-parent")
      }, childOnlyInvitation.token);
    });
    const rootInvitation = await store.createInvitation(ownerContext(operationId("invite-root")), {
      roomId: rootRoom.id,
      workspaceRole: "member",
      roomRole: "member",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      expectedWorkspaceVersion: await workspaceVersion(store, workspaceId, owner.id)
    });
    const acceptRootOperationId = operationId("accept-root");
    const acceptedRootInvitation = await store.acceptInvitation({
      workspaceId,
      accountId: invitationMember.id,
      operationId: acceptRootOperationId
    }, rootInvitation.token);
    assert(acceptedRootInvitation.accepted.roomId === rootRoom.id && !acceptedRootInvitation.replayed, "server03_root_invitation_accept_failed");
    const replayedRootInvitation = await store.acceptInvitation({
      workspaceId,
      accountId: invitationMember.id,
      operationId: acceptRootOperationId
    }, rootInvitation.token);
    assert(replayedRootInvitation.replayed, "server03_root_invitation_retry_not_replayed");
    const childInvitation = await store.createInvitation(ownerContext(operationId("invite-child")), {
      roomId: invitationChild.id,
      workspaceRole: "member",
      roomRole: "member",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      expectedWorkspaceVersion: await workspaceVersion(store, workspaceId, owner.id)
    });
    const acceptChildOperationId = operationId("accept-child");
    const acceptedChildInvitation = await store.acceptInvitation({
      workspaceId,
      accountId: invitationMember.id,
      operationId: acceptChildOperationId
    }, childInvitation.token);
    assert(acceptedChildInvitation.accepted.roomId === invitationChild.id && !acceptedChildInvitation.replayed, "server03_child_invitation_accept_failed");
    const invitationEvents = await store.listEvents({ workspaceId, accountId: invitationMember.id }, { roomId: invitationChild.id });
    assert(
      invitationEvents.filter((event) => event.operationId === acceptChildOperationId && event.kind === "room.member.changed").length === 1,
      "server03_child_invitation_member_event_missing"
    );
    // Simulate a Server 02 historical row: Workspace access was revoked but
    // one direct child Room membership remained active in the old database.
    // A later workspace-only invitation must not revive that Room access.
    const invitationWorkspaceMember = await store.getWorkspaceMember({ workspaceId, accountId: owner.id }, invitationMember.id);
    assert(Boolean(invitationWorkspaceMember), "server03_invitation_member_workspace_membership_missing");
    await store.setWorkspaceMember(ownerContext(operationId("revoke-invitation-member")), {
      accountId: invitationMember.id,
      role: invitationWorkspaceMember!.role,
      state: "revoked",
      expectedVersion: invitationWorkspaceMember!.version
    });
    await adminDatabase.withAdmin(async (sql) => {
      await sql.query(
        `UPDATE room_members
         SET state = 'active', revoked_at = NULL, version = version + 1, updated_at = NOW()
         WHERE workspace_id = $1 AND room_id = $2 AND account_id = $3`,
        [workspaceId, invitationChild.id, invitationMember.id]
      );
    });
    const workspaceOnlyInvitation = await store.createInvitation(ownerContext(operationId("invite-reactivation-without-room")), {
      workspaceRole: "member",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      expectedWorkspaceVersion: await workspaceVersion(store, workspaceId, owner.id)
    });
    await store.acceptInvitation({
      workspaceId,
      accountId: invitationMember.id,
      operationId: operationId("accept-reactivation-without-room")
    }, workspaceOnlyInvitation.token);
    assert(
      (await store.listRooms({ workspaceId, accountId: invitationMember.id })).length === 0,
      "server03_invitation_reactivation_restored_stale_room_access"
    );
    assert(
      (await store.getRoomMember({ workspaceId, accountId: owner.id }, invitationChild.id, invitationMember.id))?.state === "revoked",
      "server03_invitation_reactivation_did_not_revoke_stale_room_row"
    );
    await adminDatabase.withAdmin(async (sql) => {
      await sql.query("UPDATE accounts SET status = 'disabled' WHERE id = $1", [disabledInvitationMember.id]);
    });
    const disabledInvitation = await store.createInvitation(ownerContext(operationId("invite-disabled-account")), {
      roomId: rootRoom.id,
      workspaceRole: "member",
      roomRole: "member",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      expectedWorkspaceVersion: await workspaceVersion(store, workspaceId, owner.id)
    });
    await expectCode("workspace_invitation_invalid", async () => {
      await store.acceptInvitation({
        workspaceId,
        accountId: disabledInvitationMember.id,
        operationId: operationId("accept-disabled-account")
      }, disabledInvitation.token);
    });
    await adminDatabase.withAdmin(async (sql) => {
      await sql.query("UPDATE accounts SET status = 'active' WHERE id = $1", [disabledInvitationMember.id]);
    });
    await expectCode("workspace_not_found", async () => {
      await store.getWorkspace({ workspaceId, accountId: disabledInvitationMember.id });
    });
    await expectCode("room_parent_membership_required", async () => {
      await store.setRoomMember(ownerContext(operationId("child-missing-parent")), {
        roomId: child.id,
        accountId: missingParentMember.id,
        role: "member",
        state: "active",
        expectedVersion: 0
      });
    });
    await assertRealtimeDeliveryLock(store, workspaceId, owner.id, rootRoom.id, missingParentMember.id);

    const grandchild = await createRoom(ownerContext(operationId("grandchild")), {
      name: "Grandchild",
      parentRoomId: child.id,
      expectedWorkspaceVersion: await workspaceVersion(store, workspaceId, owner.id)
    });
    await store.setRoomMember(ownerContext(operationId("grandchild-member")), {
      roomId: grandchild.id,
      accountId: member.id,
      role: "member",
      state: "active",
      expectedVersion: 0
    });
    const stableChildRecord = await store.putRecord(ownerContext(operationId("record-before-move")), {
      roomId: child.id,
      recordType: "knowledge",
      id: "room_move_stable_record",
      expectedVersion: 0,
      payload: { text: "must remain in the child Room" }
    });

    let deepest = grandchild;
    for (let index = 0; index < 6; index += 1) {
      deepest = await createRoom(ownerContext(operationId("deep-" + index)), {
        name: "Deep " + index,
        parentRoomId: deepest.id,
        expectedWorkspaceVersion: await workspaceVersion(store, workspaceId, owner.id)
      });
    }
    const parentOnlyRooms = await store.listRooms({ workspaceId, accountId: parentOnlyMember.id });
    assert(parentOnlyRooms.map((room) => room.id).join(",") === rootRoom.id, "server03_parent_membership_revealed_child");

    const sibling = await createRoom(ownerContext(operationId("sibling")), {
      name: "Sibling",
      expectedWorkspaceVersion: await workspaceVersion(store, workspaceId, owner.id)
    });
    const blockedMove = await store.previewRoomMove({ workspaceId, accountId: owner.id }, {
      roomId: child.id,
      parentRoomId: sibling.id
    });
    assert(!blockedMove.allowed && blockedMove.blockingAccountIds.includes(member.id), "server03_move_preflight_missing_member");
    await expectCode("room_move_parent_membership_required", async () => {
      await store.moveRoom(ownerContext(operationId("move-blocked")), {
        roomId: child.id,
        parentRoomId: sibling.id,
        expectedRoomVersion: child.version,
        expectedWorkspaceVersion: await workspaceVersion(store, workspaceId, owner.id)
      });
    });
    await store.setRoomMember(ownerContext(operationId("sibling-member")), {
      roomId: sibling.id,
      accountId: member.id,
      role: "member",
      state: "active",
      expectedVersion: 0
    });
    const moved = await store.moveRoom(ownerContext(operationId("move-child")), {
      roomId: child.id,
      parentRoomId: sibling.id,
      expectedRoomVersion: child.version,
      expectedWorkspaceVersion: await workspaceVersion(store, workspaceId, owner.id)
    });
    assert(moved.room.parentRoomId === sibling.id && moved.affectedRoomIds.includes(deepest.id), "server03_recursive_move_failed");
    const recordAfterMove = await store.getRecord({ workspaceId, accountId: owner.id }, {
      roomId: child.id,
      recordType: "knowledge",
      id: stableChildRecord.record.id
    });
    assert(recordAfterMove.roomId === child.id && recordAfterMove.payload.text === "must remain in the child Room", "server03_move_changed_knowledge_boundary");
    await expectCode("room_hierarchy_cycle", async () => {
      await store.moveRoom(ownerContext(operationId("move-self")), {
        roomId: child.id,
        parentRoomId: child.id,
        expectedRoomVersion: moved.room.version,
        expectedWorkspaceVersion: await workspaceVersion(store, workspaceId, owner.id)
      });
    });
    await expectCode("room_version_conflict", async () => {
      await store.moveRoom(ownerContext(operationId("move-stale")), {
        roomId: child.id,
        parentRoomId: rootRoom.id,
        expectedRoomVersion: moved.room.version - 1,
        expectedWorkspaceVersion: await workspaceVersion(store, workspaceId, owner.id)
      });
    });
    if (target.label === "hosted") {
      const foreign = await store.createWorkspace({
        id: foreignWorkspaceId,
        name: "Foreign hierarchy probe",
        ownerAccountId: owner.id,
        operationId: operationId("foreign-workspace"),
        hostingMode: "hosted",
        databasePlacement: "shared"
      });
      await expectCode("room_parent_not_available", async () => {
        await store.moveRoom(ownerContext(operationId("move-cross-workspace")), {
          roomId: child.id,
          parentRoomId: foreign.defaultRoom.id,
          expectedRoomVersion: moved.room.version,
          expectedWorkspaceVersion: await workspaceVersion(store, workspaceId, owner.id)
        });
      });
    }
    await expectCode("room_hierarchy_cycle", async () => {
      await store.moveRoom(ownerContext(operationId("move-cycle")), {
        roomId: sibling.id,
        parentRoomId: deepest.id,
        expectedRoomVersion: sibling.version,
        expectedWorkspaceVersion: await workspaceVersion(store, workspaceId, owner.id)
      });
    });
    const movedToWorkspaceRoot = await store.moveRoom(ownerContext(operationId("move-workspace-root")), {
      roomId: child.id,
      parentRoomId: undefined,
      expectedRoomVersion: moved.room.version,
      expectedWorkspaceVersion: await workspaceVersion(store, workspaceId, owner.id)
    });
    assert(!movedToWorkspaceRoot.room.parentRoomId, "server03_move_to_workspace_root_failed");
    const movedBack = await store.moveRoom(ownerContext(operationId("move-child-back")), {
      roomId: child.id,
      parentRoomId: sibling.id,
      expectedRoomVersion: movedToWorkspaceRoot.room.version,
      expectedWorkspaceVersion: await workspaceVersion(store, workspaceId, owner.id)
    });
    assert(movedBack.room.parentRoomId === sibling.id, "server03_move_back_under_room_failed");
    const siblingOwner = await store.getRoomMember({ workspaceId, accountId: owner.id }, sibling.id, owner.id);
    assert(Boolean(siblingOwner), "server03_sibling_owner_missing");
    await expectCode("room_last_owner_cannot_be_removed", async () => {
      await store.setRoomMember(ownerContext(operationId("last-owner-demote")), {
        roomId: sibling.id,
        accountId: owner.id,
        role: "member",
        state: "active",
        expectedVersion: siblingOwner!.version
      });
    });
    await expectCode("room_last_owner_cannot_be_removed", async () => {
      await store.setRoomMember(ownerContext(operationId("last-owner")), {
        roomId: sibling.id,
        accountId: owner.id,
        role: "owner",
        state: "revoked",
        expectedVersion: siblingOwner!.version
      });
    });
    const siblingMember = await store.getRoomMember({ workspaceId, accountId: owner.id }, sibling.id, member.id);
    assert(Boolean(siblingMember), "server03_sibling_member_missing");
    const removed = await store.setRoomMember(ownerContext(operationId("remove-parent-member")), {
      roomId: sibling.id,
      accountId: member.id,
      role: "member",
      state: "revoked",
      expectedVersion: siblingMember!.version
    });
    assert(removed.affectedRoomIds.includes(child.id) && removed.affectedRoomIds.includes(grandchild.id), "server03_descendant_revocation_missing");
    const memberRoomsAfterRemoval = await store.listRooms({ workspaceId, accountId: member.id });
    assert(memberRoomsAfterRemoval.map((room) => room.id).join(",") === rootRoom.id, "server03_revoked_member_still_sees_descendant");

    const concurrentParent = await createRoom(ownerContext(operationId("concurrent-parent")), {
      name: "Concurrent parent",
      expectedWorkspaceVersion: await workspaceVersion(store, workspaceId, owner.id)
    });
    const concurrentDestination = await createRoom(ownerContext(operationId("concurrent-destination")), {
      name: "Concurrent destination",
      expectedWorkspaceVersion: await workspaceVersion(store, workspaceId, owner.id)
    });
    const concurrentChild = await createRoom(ownerContext(operationId("concurrent-child")), {
      name: "Concurrent child",
      parentRoomId: concurrentParent.id,
      expectedWorkspaceVersion: await workspaceVersion(store, workspaceId, owner.id)
    });
    for (const room of [concurrentParent, concurrentDestination, concurrentChild]) {
      await store.setRoomMember(ownerContext(operationId("concurrent-member-" + room.id)), {
        roomId: room.id,
        accountId: parentOnlyMember.id,
        role: "member",
        state: "active",
        expectedVersion: 0
      });
    }
    const concurrentParentMember = await store.getRoomMember({ workspaceId, accountId: owner.id }, concurrentParent.id, parentOnlyMember.id);
    assert(Boolean(concurrentParentMember), "server03_concurrent_parent_member_missing");
    const [concurrentMove] = await Promise.all([
      store.moveRoom(ownerContext(operationId("concurrent-move")), {
        roomId: concurrentChild.id,
        parentRoomId: concurrentDestination.id,
        expectedRoomVersion: concurrentChild.version,
        expectedWorkspaceVersion: await workspaceVersion(store, workspaceId, owner.id)
      }),
      store.setRoomMember(ownerContext(operationId("concurrent-revoke")), {
        roomId: concurrentParent.id,
        accountId: parentOnlyMember.id,
        role: "member",
        state: "revoked",
        expectedVersion: concurrentParentMember!.version
      })
    ]);
    assert(concurrentMove.room.parentRoomId === concurrentDestination.id, "server03_concurrent_move_failed");
    const concurrentChildMember = await store.getRoomMember({ workspaceId, accountId: owner.id }, concurrentChild.id, parentOnlyMember.id);
    if (concurrentChildMember?.state === "active") {
      const destinationMember = await store.getRoomMember({ workspaceId, accountId: owner.id }, concurrentDestination.id, parentOnlyMember.id);
      assert(destinationMember?.state === "active", "server03_concurrent_membership_invariant_broken");
    }

    const realtimeRootMembership = await store.setRoomMember(ownerContext(operationId("realtime-root-member")), {
      roomId: rootRoom.id,
      accountId: realtimeMember.id,
      role: "member",
      state: "active",
      expectedVersion: 0
    });
    const realtimeChild = await createRoom(ownerContext(operationId("realtime-child")), {
      name: "Realtime child",
      parentRoomId: rootRoom.id,
      expectedWorkspaceVersion: await workspaceVersion(store, workspaceId, owner.id)
    });
    await store.setRoomMember(ownerContext(operationId("realtime-child-member")), {
      roomId: realtimeChild.id,
      accountId: realtimeMember.id,
      role: "member",
      state: "active",
      expectedVersion: 0
    });
    const realtimeRootInvitation = await store.createInvitation(ownerContext(operationId("realtime-invite-root")), {
      roomId: rootRoom.id,
      workspaceRole: "member",
      roomRole: "member",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      expectedWorkspaceVersion: await workspaceVersion(store, workspaceId, owner.id)
    });
    const realtimeChildInvitation = await store.createInvitation(ownerContext(operationId("realtime-invite-child")), {
      roomId: realtimeChild.id,
      workspaceRole: "member",
      roomRole: "member",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      expectedWorkspaceVersion: await workspaceVersion(store, workspaceId, owner.id)
    });
    await runRealtimeSubscriptionProbe({
      target,
      storageRoot: root,
      workspaceId,
      owner,
      member: realtimeMember,
      parentOnlyMember,
      invitationMember: httpInvitationMember,
      rootInvitationToken: realtimeRootInvitation.token,
      childInvitationToken: realtimeChildInvitation.token,
      rootRoomId: rootRoom.id,
      childRoomId: realtimeChild.id,
      hiddenRoomId: child.id,
      rootMembershipVersion: realtimeRootMembership.member.version
    });

    const rootRecord = await store.putRecord(ownerContext(operationId("record-root")), {
      roomId: rootRoom.id,
      recordType: "knowledge",
      id: "root_record",
      expectedVersion: 0,
      payload: { text: "root hierarchy marker" }
    });
    await store.putRecord(ownerContext(operationId("record-child")), {
      roomId: child.id,
      recordType: "knowledge",
      id: "child_record",
      expectedVersion: 0,
      payload: { text: "child hierarchy marker" }
    });
    await expectCode("workspace_record_room_change_forbidden", async () => {
      await store.putRecord(ownerContext(operationId("record-cross-room")), {
        roomId: child.id,
        recordType: "knowledge",
        id: rootRecord.record.id,
        expectedVersion: rootRecord.record.version,
        payload: { text: "a record must not change Rooms" }
      });
    });
    const files = new WorkspaceFileStore(store);
    const rootFile = await files.write(ownerContext(operationId("file-root")), {
      roomId: rootRoom.id,
      path: "knowledge/room-boundary.md",
      content: Buffer.from("root Room file"),
      expectedVersion: 0
    });
    await expectCode("workspace_file_room_change_forbidden", async () => {
      await files.write(ownerContext(operationId("file-cross-room")), {
        roomId: child.id,
        path: rootFile.file.path,
        content: Buffer.from("child Room must not take the file"),
        expectedVersion: rootFile.file.version
      });
    });
    const childSearch = await store.searchRecords({ workspaceId, accountId: owner.id }, {
      roomId: child.id,
      query: "hierarchy marker"
    });
    assert(childSearch.length === 1 && childSearch[0]?.roomId === child.id, "server03_room_search_boundary_failed");

    const retryOperation = operationId("move-retry");
    const moveInput = {
      roomId: child.id,
      parentRoomId: sibling.id,
      expectedRoomVersion: movedBack.room.version,
      expectedWorkspaceVersion: await workspaceVersion(store, workspaceId, owner.id)
    };
    const firstRetry = await store.moveRoom(ownerContext(retryOperation), moveInput);
    const secondRetry = await store.moveRoom(ownerContext(retryOperation), moveInput);
    assert(firstRetry.room.version === secondRetry.room.version, "server03_move_retry_not_idempotent");
    const retryEvents = await store.listEvents({ workspaceId, accountId: owner.id }, { roomId: child.id });
    assert(
      retryEvents.filter((event) => event.operationId === retryOperation && event.kind === "room.moved").length === 1,
      "server03_move_retry_duplicated_durable_event"
    );

    const parentOnlyWorkspaceMembership = await store.getWorkspaceMember({ workspaceId, accountId: owner.id }, parentOnlyMember.id);
    assert(Boolean(parentOnlyWorkspaceMembership), "server03_parent_only_workspace_membership_missing");
    const revokedWorkspaceMember = await store.setWorkspaceMember(ownerContext(operationId("revoke-workspace-member")), {
      accountId: parentOnlyMember.id,
      role: parentOnlyWorkspaceMembership!.role,
      state: "revoked",
      expectedVersion: parentOnlyWorkspaceMembership!.version
    });
    assert((await store.listRooms({ workspaceId, accountId: parentOnlyMember.id })).length === 0, "server03_revoked_workspace_member_keeps_room_access");
    await adminDatabase.withAdmin(async (sql) => {
      await sql.query(
        `UPDATE room_members
         SET state = 'active', revoked_at = NULL, version = version + 1, updated_at = NOW()
         WHERE workspace_id = $1 AND room_id = $2 AND account_id = $3`,
        [workspaceId, rootRoom.id, parentOnlyMember.id]
      );
    });
    const reactivatedWorkspaceMember = await store.setWorkspaceMember(ownerContext(operationId("reactivate-workspace-member")), {
      accountId: parentOnlyMember.id,
      role: parentOnlyWorkspaceMembership!.role,
      state: "active",
      expectedVersion: revokedWorkspaceMember.member.version
    });
    assert(reactivatedWorkspaceMember.revalidationRoomIds.includes(rootRoom.id), "server03_reactivation_stale_room_not_revalidated");
    assert((await store.listRooms({ workspaceId, accountId: parentOnlyMember.id })).length === 0, "server03_workspace_reactivation_restored_room_access");
    await adminDatabase.withAdmin(async (sql) => {
      await sql.query("UPDATE accounts SET status = 'disabled' WHERE id = $1", [parentOnlyMember.id]);
    });
    await expectCode("workspace_not_found", async () => {
      await store.getWorkspace({ workspaceId, accountId: parentOnlyMember.id });
    });
    await adminDatabase.withAdmin(async (sql) => {
      await sql.query("UPDATE accounts SET status = 'active' WHERE id = $1", [parentOnlyMember.id]);
    });
    assert((await store.getWorkspace({ workspaceId, accountId: parentOnlyMember.id })).id === workspaceId, "server03_account_reactivation_workspace_access_missing");
    assert((await store.listRooms({ workspaceId, accountId: parentOnlyMember.id })).length === 0, "server03_account_reactivation_restored_room_access");

    if (target.label === "hosted") {
      const bundles = new WorkspaceBundleV3Service(store);
      const bundleDirectory = path.join(root, "source.bundle");
      await bundles.export(ownerContext(operationId("bundle-export")), { destination: bundleDirectory });
      const imported = await bundles.importNew({ accountId: owner.id, operationId: operationId("bundle-import") }, {
        sourceDirectory: bundleDirectory,
        targetWorkspaceId: restoredWorkspaceId,
        targetWorkspaceName: "Restored hierarchy"
      });
      const restoredRooms = await store.listRooms({ workspaceId: imported.workspaceId, accountId: owner.id });
      const sourceParents = new Map((await store.listRooms({ workspaceId, accountId: owner.id })).map((room) => [room.id, room.parentRoomId]));
      const restoredParents = new Map(restoredRooms.map((room) => [room.id, room.parentRoomId]));
      assert(JSON.stringify([...sourceParents].sort()) === JSON.stringify([...restoredParents].sort()), "server03_bundle_hierarchy_roundtrip_failed");
    }
    console.log("[Server03] " + target.label + ": Room hierarchy, RLS, search, retry, and restore probe passed");
  } finally {
    await cleanup(adminDatabase, [workspaceId, ...(target.label === "hosted" ? [restoredWorkspaceId, foreignWorkspaceId] : [])], accounts.map((account) => account.id));
    await database.close();
    await adminDatabase.close();
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Runs through the real HTTP and Socket.IO boundary against the same probe
 * database. A parent removal must leave each revoked Room channel before that
 * Room's membership event is emitted.
 */
async function runRealtimeSubscriptionProbe(input: {
  target: ProbeTarget;
  storageRoot: string;
  workspaceId: string;
  owner: ProbeAccount;
  member: ProbeAccount;
  parentOnlyMember: ProbeAccount;
  invitationMember: ProbeAccount;
  rootInvitationToken: string;
  childInvitationToken: string;
  rootRoomId: string;
  childRoomId: string;
  hiddenRoomId: string;
  rootMembershipVersion: number;
}): Promise<void> {
  let server: Awaited<ReturnType<typeof createWorkspaceServerHttp>> | undefined;
  let memberSocket: Socket | undefined;
  let unsubscribedMemberSocket: Socket | undefined;
  let ownerSocket: Socket | undefined;
  let parentOnlySocket: Socket | undefined;
  let invitationSocket: Socket | undefined;
  try {
    server = await createWorkspaceServerHttp({
      mode: input.target.label,
      databaseUrl: input.target.databaseUrl,
      databaseRuntimeRole: input.target.runtimeRole,
      invitationTokenSecret: "x".repeat(32),
      storageRoot: path.join(input.storageRoot, "realtime-http"),
      ...(input.target.label === "self_host" ? {
        selfHostWorkspaceId: input.workspaceId,
        selfHostBootstrapMode: "empty" as const,
        initialAdminId: input.owner.id,
        initialAdminPublicKey: input.owner.publicKey
      } : { selfHostBootstrapMode: "create" as const }),
      initialAdminDisplayName: input.owner.id,
      port: 0,
      bindAddress: "127.0.0.1",
      corsOrigins: [],
      publicNetwork: false
    });
    const port = await listenOnEphemeralPort(server.httpServer);
    const serverUrl = `http://127.0.0.1:${port}`;
    memberSocket = connectSocket(serverUrl, {
      transports: ["websocket"],
      reconnection: false,
      auth: signedSocketAuth(input.member, input.workspaceId)
    });
    // Same Account, deliberately without any Room subscription. A redundant
    // revoke must not disclose a hidden Room id to this connection.
    unsubscribedMemberSocket = connectSocket(serverUrl, {
      transports: ["websocket"],
      reconnection: false,
      auth: signedSocketAuth(input.member, input.workspaceId)
    });
    ownerSocket = connectSocket(serverUrl, {
      transports: ["websocket"],
      reconnection: false,
      auth: signedSocketAuth(input.owner, input.workspaceId)
    });
    parentOnlySocket = connectSocket(serverUrl, {
      transports: ["websocket"],
      reconnection: false,
      auth: signedSocketAuth(input.parentOnlyMember, input.workspaceId)
    });
    await Promise.all([waitForSocketConnect(memberSocket), waitForSocketConnect(unsubscribedMemberSocket), waitForSocketConnect(ownerSocket), waitForSocketConnect(parentOnlySocket)]);
    const acceptedRootInvitation = await signedJsonRequest({
      serverUrl,
      account: input.invitationMember,
      workspaceId: input.workspaceId,
      operationId: operationId("realtime-accept-root"),
      method: "POST",
      path: `/api/workspaces/${input.workspaceId}/invitations/accept`,
      body: { invite_token: input.rootInvitationToken }
    });
    assert(
      acceptedRootInvitation.status === 200
      && acceptedRootInvitation.body
      && typeof acceptedRootInvitation.body === "object"
      && (acceptedRootInvitation.body as { accepted?: { roomId?: unknown } }).accepted?.roomId === input.rootRoomId,
      "server03_realtime_root_invitation_http_failed"
    );
    invitationSocket = connectSocket(serverUrl, {
      transports: ["websocket"],
      reconnection: false,
      auth: signedSocketAuth(input.invitationMember, input.workspaceId)
    });
    await waitForSocketConnect(invitationSocket);
    assert((await socketAcknowledge(memberSocket, "workspace:subscribe-room", { room_id: input.rootRoomId })).ok === true, "server03_realtime_root_subscribe_failed");
    assert((await socketAcknowledge(memberSocket, "workspace:subscribe-room", { room_id: input.childRoomId })).ok === true, "server03_realtime_child_subscribe_failed");
    assert((await socketAcknowledge(ownerSocket, "workspace:subscribe-room", { room_id: input.rootRoomId })).ok === true, "server03_realtime_owner_root_subscribe_failed");
    assert((await socketAcknowledge(ownerSocket, "workspace:subscribe-room", { room_id: input.childRoomId })).ok === true, "server03_realtime_owner_child_subscribe_failed");
    assert((await socketAcknowledge(parentOnlySocket, "workspace:subscribe-room", { room_id: input.rootRoomId })).ok === true, "server03_realtime_parent_only_root_subscribe_failed");
    assert((await socketAcknowledge(invitationSocket, "workspace:subscribe-room", { room_id: input.rootRoomId })).ok === true, "server03_realtime_invitation_root_subscribe_failed");
    const hiddenSubscribe = await socketAcknowledge(parentOnlySocket, "workspace:subscribe-room", { room_id: input.hiddenRoomId });
    assert(hiddenSubscribe.ok !== true && socketErrorCode(hiddenSubscribe) === "room_not_available", "server03_realtime_hidden_room_subscription_oracle");
    const missingResync = await socketAcknowledge(parentOnlySocket, "workspace:resync", {});
    assert(missingResync.ok !== true && socketErrorCode(missingResync) === "room_id_required", "server03_realtime_resync_room_required");
    const hiddenResync = await socketAcknowledge(parentOnlySocket, "workspace:resync", { room_id: input.hiddenRoomId });
    assert(hiddenResync.ok !== true && socketErrorCode(hiddenResync) === "room_not_available", "server03_realtime_hidden_resync_oracle");

    const hiddenMembers = await signedJsonRequest({
      serverUrl,
      account: input.parentOnlyMember,
      workspaceId: input.workspaceId,
      operationId: operationId("hidden-members"),
      method: "GET",
      path: `/api/workspaces/${input.workspaceId}/rooms/${input.hiddenRoomId}/members`
    });
    const missingMembers = await signedJsonRequest({
      serverUrl,
      account: input.parentOnlyMember,
      workspaceId: input.workspaceId,
      operationId: operationId("missing-members"),
      method: "GET",
      path: `/api/workspaces/${input.workspaceId}/rooms/room_does_not_exist/members`
    });
    assert(
      hiddenMembers.status === 404
      && missingMembers.status === 404
      && jsonErrorCode(hiddenMembers.body) === "room_not_available"
      && jsonErrorCode(missingMembers.body) === "room_not_available",
      "server03_http_hidden_room_oracle"
    );

    const revokedRoomIds = new Set<string>();
    const postRevocationRoomEvents: unknown[] = [];
    const ownerRoomEvents: Array<{ roomId?: string; kind?: string }> = [];
    const parentOnlyRoomEvents: Array<{ roomId?: string; kind?: string }> = [];
    const invitationRoomEvents: Array<{ roomId?: string; kind?: string }> = [];
    const parentOnlyRevocations = new Set<string>();
    const unsubscribedMemberRevocations = new Set<string>();
    memberSocket.on("workspace:room-access-revoked", (event: unknown) => {
      if (event && typeof event === "object") {
        const roomId = (event as { roomId?: unknown }).roomId;
        if (typeof roomId === "string") revokedRoomIds.add(roomId);
      }
    });
    ownerSocket.on("workspace:event", (event: unknown) => ownerRoomEvents.push(roomEventSummary(event)));
    parentOnlySocket.on("workspace:event", (event: unknown) => parentOnlyRoomEvents.push(roomEventSummary(event)));
    parentOnlySocket.on("workspace:room-access-revoked", (event: unknown) => {
      if (event && typeof event === "object" && typeof (event as { roomId?: unknown }).roomId === "string") {
        parentOnlyRevocations.add((event as { roomId: string }).roomId);
      }
    });
    unsubscribedMemberSocket.on("workspace:room-access-revoked", (event: unknown) => {
      if (event && typeof event === "object" && typeof (event as { roomId?: unknown }).roomId === "string") {
        unsubscribedMemberRevocations.add((event as { roomId: string }).roomId);
      }
    });
    invitationSocket.on("workspace:event", (event: unknown) => invitationRoomEvents.push(roomEventSummary(event)));

    const childInvitationOperationId = operationId("realtime-accept-child");
    const acceptedChildInvitation = await signedJsonRequest({
      serverUrl,
      account: input.invitationMember,
      workspaceId: input.workspaceId,
      operationId: childInvitationOperationId,
      method: "POST",
      path: `/api/workspaces/${input.workspaceId}/invitations/accept`,
      body: { invite_token: input.childInvitationToken }
    });
    assert(
      acceptedChildInvitation.status === 200
      && acceptedChildInvitation.body
      && typeof acceptedChildInvitation.body === "object"
      && (acceptedChildInvitation.body as { replayed?: unknown }).replayed === false,
      "server03_realtime_child_invitation_http_failed"
    );
    await waitUntil(
      () => ownerRoomEvents.some((event) => event.roomId === input.childRoomId && event.kind === "room.member.changed")
        && invitationRoomEvents.some((event) => event.roomId === input.childRoomId && event.kind === "room.member.changed"),
      "server03_realtime_child_invitation_event_missing"
    );
    const invitationEventCount = invitationRoomEvents.length;
    const replayedChildInvitation = await signedJsonRequest({
      serverUrl,
      account: input.invitationMember,
      workspaceId: input.workspaceId,
      operationId: childInvitationOperationId,
      method: "POST",
      path: `/api/workspaces/${input.workspaceId}/invitations/accept`,
      body: { invite_token: input.childInvitationToken }
    });
    assert(
      replayedChildInvitation.status === 200
      && replayedChildInvitation.body
      && typeof replayedChildInvitation.body === "object"
      && (replayedChildInvitation.body as { replayed?: unknown }).replayed === true,
      "server03_realtime_child_invitation_retry_not_replayed"
    );
    await delay(75);
    assert(invitationRoomEvents.length === invitationEventCount, "server03_realtime_child_invitation_retry_duplicated_event");

    // Events before this point are valid: the member still had access when the
    // child invitation was accepted. Observe only the period after revocation
    // begins, otherwise a delayed legitimate event becomes a false leak.
    memberSocket.on("workspace:event", (event: unknown) => postRevocationRoomEvents.push(event));

    const body = { role: "member", state: "revoked", expected_version: input.rootMembershipVersion };
    const revokeOperationId = operationId("realtime-revoke");
    const result = await signedJsonRequest({
      serverUrl,
      account: input.owner,
      workspaceId: input.workspaceId,
      operationId: revokeOperationId,
      method: "PUT",
      path: `/api/workspaces/${input.workspaceId}/rooms/${input.rootRoomId}/members/${input.member.id}`,
      body
    });
    assert(result.status === 200, "server03_realtime_revoke_request_failed");
    const affectedRoomIds = result.body && typeof result.body === "object" && Array.isArray((result.body as { affected_room_ids?: unknown }).affected_room_ids)
      ? (result.body as { affected_room_ids: unknown[] }).affected_room_ids
      : [];
    assert(affectedRoomIds.includes(input.rootRoomId) && affectedRoomIds.includes(input.childRoomId), "server03_realtime_descendant_impact_missing");
    await waitUntil(
      () => revokedRoomIds.has(input.rootRoomId) && revokedRoomIds.has(input.childRoomId),
      "server03_realtime_subscription_not_revoked"
    );
    await waitUntil(
      () => ownerRoomEvents.filter((event) => event.kind === "room.member.changed").some((event) => event.roomId === input.rootRoomId)
        && ownerRoomEvents.filter((event) => event.kind === "room.member.changed").some((event) => event.roomId === input.childRoomId),
      "server03_realtime_owner_event_missing"
    );
    await delay(75);
    assert(postRevocationRoomEvents.length === 0, "server03_realtime_event_leaked_after_revocation");
    assert(!parentOnlyRoomEvents.some((event) => event.roomId === input.childRoomId), "server03_realtime_hidden_child_event_leaked");
    assert(!parentOnlyRevocations.has(input.childRoomId), "server03_realtime_hidden_child_revocation_leaked");
    assert(
      !unsubscribedMemberRevocations.has(input.rootRoomId) && !unsubscribedMemberRevocations.has(input.childRoomId),
      "server03_realtime_unsubscribed_member_revocation_leaked"
    );
    const ownerEventCount = ownerRoomEvents.length;
    const replay = await signedJsonRequest({
      serverUrl,
      account: input.owner,
      workspaceId: input.workspaceId,
      operationId: revokeOperationId,
      method: "PUT",
      path: `/api/workspaces/${input.workspaceId}/rooms/${input.rootRoomId}/members/${input.member.id}`,
      body
    });
    assert(replay.status === 200 && replay.body && typeof replay.body === "object" && (replay.body as { replayed?: unknown }).replayed === true, "server03_realtime_retry_not_replayed");
    await delay(75);
    assert(ownerRoomEvents.length === ownerEventCount, "server03_realtime_retry_duplicated_external_event");
    const retry = await socketAcknowledge(memberSocket, "workspace:subscribe-room", { room_id: input.childRoomId });
    assert(retry.ok !== true, "server03_realtime_revoked_child_resubscribed");
  } finally {
    memberSocket?.disconnect();
    unsubscribedMemberSocket?.disconnect();
    ownerSocket?.disconnect();
    parentOnlySocket?.disconnect();
    invitationSocket?.disconnect();
    if (server) await server.close().catch(() => undefined);
  }
}

function signedSocketAuth(account: ProbeAccount, workspaceId: string): Record<string, string> {
  const request = signedRequest(account, {
    method: "SOCKET",
    path: "/socket.io",
    workspaceId,
    body: {}
  });
  return {
    account_id: account.id,
    request_id: request.requestId,
    timestamp: request.timestamp,
    signature: request.signature,
    workspace_id: workspaceId
  };
}

async function signedJsonRequest(input: {
  serverUrl: string;
  account: ProbeAccount;
  workspaceId: string;
  operationId: string;
  method: "GET" | "POST" | "PUT";
  path: string;
  body?: Record<string, unknown>;
}): Promise<{ status: number; body: unknown }> {
  const request = signedRequest(input.account, { ...input, body: input.body ?? {} });
  const response = await fetch(new URL(input.path, input.serverUrl), {
    method: input.method,
    headers: {
      "x-samurai-account-id": input.account.id,
      "x-samurai-request-id": request.requestId,
      "x-samurai-timestamp": request.timestamp,
      "x-samurai-signature": request.signature,
      "x-samurai-workspace-id": input.workspaceId,
      "x-samurai-operation-id": input.operationId,
      ...(input.body ? { "content-type": "application/json" } : {})
    },
    ...(input.body ? { body: JSON.stringify(input.body) } : {}),
    signal: AbortSignal.timeout(15_000)
  });
  const text = await response.text();
  let body: unknown;
  if (text) {
    try { body = JSON.parse(text); } catch { body = { error: "server03_realtime_response_invalid" }; }
  }
  return { status: response.status, body };
}

function signedRequest(account: ProbeAccount, input: {
  method: string;
  path: string;
  workspaceId: string;
  operationId?: string;
  body: unknown;
}): { requestId: string; timestamp: string; signature: string } {
  const requestId = "request_" + randomUUID();
  const timestamp = String(Date.now());
  const payload = createAccountSignaturePayload({
    method: input.method,
    path: input.path,
    workspaceId: input.workspaceId,
    ...(input.operationId ? { operationId: input.operationId } : {}),
    requestId,
    timestamp,
    body: input.body
  });
  return {
    requestId,
    timestamp,
    signature: sign(null, Buffer.from(payload), createPrivateKey(account.privateKey)).toString("base64url")
  };
}

async function listenOnEphemeralPort(server: { listen(port: number, host: string, callback: () => void): unknown; once(event: string, callback: (error: Error) => void): unknown; off(event: string, callback: (error: Error) => void): unknown; address(): string | { port: number } | null }): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    const fail = (error: Error) => {
      server.off("error", fail);
      reject(error);
    };
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", fail);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server03_realtime_listen_failed");
  return address.port;
}

async function waitForSocketConnect(socket: Socket): Promise<void> {
  if (socket.connected) return;
  await new Promise<void>((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout>;
    function finish(error?: Error): void {
      clearTimeout(timeout);
      socket.off("connect", connected);
      socket.off("connect_error", failed);
      if (error) reject(error);
      else resolve();
    }
    function connected(): void { finish(); }
    function failed(error: Error): void { finish(error); }
    timeout = setTimeout(() => finish(new Error("server03_realtime_socket_connect_timeout")), 5_000);
    socket.once("connect", connected);
    socket.once("connect_error", failed);
  });
}

async function socketAcknowledge(socket: Socket, event: string, input: Record<string, unknown>): Promise<{ ok?: unknown; error?: unknown }> {
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("server03_realtime_ack_timeout:" + event)), 5_000);
    socket.emit(event, input, (result: unknown) => {
      clearTimeout(timeout);
      resolve(result && typeof result === "object" ? result as { ok?: unknown; error?: unknown } : {});
    });
  });
}

function socketErrorCode(result: { error?: unknown }): string | undefined {
  const error = result.error;
  return error && typeof error === "object" && typeof (error as { error?: unknown }).error === "string"
    ? (error as { error: string }).error
    : undefined;
}

function jsonErrorCode(body: unknown): string | undefined {
  return body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string"
    ? (body as { error: string }).error
    : undefined;
}

function roomEventSummary(event: unknown): { roomId?: string; kind?: string } {
  if (!event || typeof event !== "object") return {};
  const value = event as { roomId?: unknown; kind?: unknown };
  return {
    ...(typeof value.roomId === "string" ? { roomId: value.roomId } : {}),
    ...(typeof value.kind === "string" ? { kind: value.kind } : {})
  };
}

async function waitUntil(check: () => boolean, code: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (check()) return;
    await delay(10);
  }
  throw new Error(code);
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function workspaceVersion(store: WorkspaceServerStore, workspaceId: string, accountId: string): Promise<number> {
  return (await store.getWorkspace({ workspaceId, accountId })).version;
}

async function expectCode(code: string, action: () => Promise<unknown>): Promise<void> {
  try {
    await action();
  } catch (error) {
    if (error instanceof Error && error.message.includes(code)) return;
    throw error;
  }
  throw new Error("server03_expected_rejection_missing:" + code);
}

/** Runtime SQL may read these tables through RLS, but only guarded database
 * functions may mutate Room hierarchy or membership rows. */
async function assertRuntimeRoomMutationTablesDenied(
  database: PostgresWorkspaceDatabase,
  context: { workspaceId: string; accountId: string }
): Promise<void> {
  for (const table of ["workspace_members", "rooms", "room_members"]) {
    try {
      await database.withContext(context, async (sql) => {
        await sql.query(`UPDATE ${table} SET updated_at = updated_at WHERE FALSE`);
      });
    } catch (error) {
      if (/permission denied|must be owner/i.test(error instanceof Error ? error.message : "")) continue;
      throw error;
    }
    throw new Error("server03_runtime_direct_room_mutation_allowed:" + table);
  }
}

/** The shared delivery lock must delay a concurrent hierarchy/member write. */
async function assertRealtimeDeliveryLock(
  store: WorkspaceServerStore,
  workspaceId: string,
  ownerAccountId: string,
  roomId: string,
  memberAccountId: string
): Promise<void> {
  let entered!: () => void;
  let release!: () => void;
  const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
  const releasePromise = new Promise<void>((resolve) => { release = resolve; });
  const delivery = store.deliverRoomRealtimeIfReadable(
    { workspaceId, accountId: ownerAccountId },
    roomId,
    async () => {
      entered();
      await releasePromise;
    }
  );
  await enteredPromise;
  let membershipFinished = false;
  const membership = store.setRoomMember({
    workspaceId,
    accountId: ownerAccountId,
    operationId: operationId("realtime-lock-member")
  }, {
    roomId,
    accountId: memberAccountId,
    role: "member",
    state: "active",
    expectedVersion: 0
  }).then(() => { membershipFinished = true; });
  await delay(50);
  assert(!membershipFinished, "server03_realtime_delivery_lock_not_shared_with_member_mutation");
  release();
  assert(await delivery, "server03_realtime_delivery_room_access_missing");
  await membership;
}

async function cleanup(
  adminDatabase: PostgresWorkspaceAdminDatabase,
  workspaceIds: string[],
  accountIds: string[]
): Promise<void> {
  await adminDatabase.withAdmin(async (sql) => {
    const tables = [
      "workspace_bundles",
      "workspace_transfers",
      "workspace_invitations",
      "workspace_jobs",
      "workspace_events",
      "workspace_operations",
      "workspace_file_transactions",
      "workspace_files",
      "workspace_records",
      "room_members",
      "rooms",
      "workspace_members",
      "workspace_import_sessions"
    ];
    await sql.query("BEGIN");
    try {
      for (const workspaceId of workspaceIds) {
        for (const table of tables) {
          await sql.query("DELETE FROM " + table + " WHERE workspace_id = $1", [workspaceId]);
        }
        // Audit is also a child of Workspace. Remove it after every other
        // probe-owned child and immediately before Workspace, making the
        // foreign-key cleanup order explicit.
        await sql.query("DELETE FROM workspace_audit_entries WHERE workspace_id = $1", [workspaceId]);
        await sql.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);
      }
      await sql.query("DELETE FROM account_operations WHERE account_id = ANY($1::TEXT[])", [accountIds]);
      await sql.query("DELETE FROM accounts WHERE id = ANY($1::TEXT[])", [accountIds]);
      await sql.query("COMMIT");
    } catch (error) {
      await sql.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  });
}

function accountIdentity(): ProbeAccount {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ format: "pem", type: "spki" }).toString();
  return {
    id: accountIdFromPublicKey(publicKeyPem),
    publicKey: publicKeyPem,
    privateKey: privateKey.export({ format: "pem", type: "pkcs8" }).toString()
  };
}

function operationId(label: string): string {
  return "room03_" + label + "_" + randomUUID();
}

function assert(value: unknown, code: string): asserts value {
  if (!value) throw new Error(code);
}
