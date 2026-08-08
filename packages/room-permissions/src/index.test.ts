import { describe, expect, it } from "vitest";
import {
  agentParticipantId,
  canManageRoomTarget,
  evaluateRoomPermission,
  evaluateWorkspacePermission,
  localOwnerParticipantId
} from "./index.js";

describe("room permissions", () => {
  it("keeps the human role pyramid separate from Agent flags", () => {
    const principal = { kind: "human" as const, participantId: localOwnerParticipantId };
    expect(evaluateRoomPermission({ principal, action: "share", humanMembership: { participantId: principal.participantId, role: "member" } }).allowed).toBe(true);
    expect(evaluateRoomPermission({ principal, action: "manage_members", humanMembership: { participantId: principal.participantId, role: "member" } }).allowed).toBe(false);

    const agent = { kind: "agent" as const, participantId: agentParticipantId("writer"), agentId: "writer", requestedByParticipantId: principal.participantId };
    expect(evaluateRoomPermission({ principal: agent, action: "edit", agentMembership: { agentId: "writer", canView: true, canEdit: true, canExecute: false } }).allowed).toBe(true);
    expect(evaluateRoomPermission({ principal: agent, action: "share", agentMembership: { agentId: "writer", canView: true, canEdit: true, canExecute: true } }).allowed).toBe(false);
  });

  it("does not let an Admin alter an Owner or another Admin", () => {
    expect(canManageRoomTarget({ actorRole: "admin", targetKind: "human", targetRole: "owner" }).allowed).toBe(false);
    expect(canManageRoomTarget({ actorRole: "admin", targetKind: "human", targetRole: "admin" }).allowed).toBe(false);
    expect(canManageRoomTarget({ actorRole: "admin", targetKind: "agent" }).allowed).toBe(true);
  });

  it("requires an explicit Agent room.create permission", () => {
    const agent = { kind: "agent" as const, participantId: agentParticipantId("builder"), agentId: "builder", requestedByParticipantId: localOwnerParticipantId };
    expect(evaluateWorkspacePermission({ principal: agent, action: "create_room" }).allowed).toBe(false);
    expect(evaluateWorkspacePermission({ principal: agent, action: "create_room", agentPermission: { agentId: "builder", permission: "room.create" } }).allowed).toBe(true);
  });

  it("evaluates an External App through its delegated Human without making it a member", () => {
    const delegated = { kind: "human" as const, participantId: localOwnerParticipantId };
    const app = { kind: "external_app" as const, appId: "codex", delegatedBy: delegated };
    expect(evaluateRoomPermission({
      principal: app,
      action: "execute",
      humanMembership: { participantId: delegated.participantId, role: "member" }
    })).toMatchObject({ allowed: true, reason: "allowed" });
    expect(evaluateRoomPermission({
      principal: { ...app, delegatedBy: { kind: "human", participantId: "not-canonical" } },
      action: "execute",
      humanMembership: { participantId: localOwnerParticipantId, role: "owner" }
    })).toMatchObject({ allowed: false, reason: "participant_id_invalid" });
  });
});
