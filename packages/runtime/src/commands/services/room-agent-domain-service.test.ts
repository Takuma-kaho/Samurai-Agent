import { describe, expect, it } from "vitest";
import {
  assertHumanWorkControlPolicy,
  evaluateHumanWorkControlPolicy,
  type HumanWorkMembershipSnapshot
} from "./room-agent-domain-service";

const membership = (participantId: string, role: HumanWorkMembershipSnapshot["role"], removedAt?: string): HumanWorkMembershipSnapshot => ({
  participantId,
  role,
  ...(removedAt ? { removedAt } : {})
});

describe("human Work control policy", () => {
  it("allows the current requester without re-granting execute", () => {
    const input = {
      actorParticipantId: "human-requester",
      requesterParticipantId: "human-requester",
      actorWorkspaceMembership: membership("human-requester", "member"),
      requesterWorkspaceMembership: membership("human-requester", "member"),
      actorRoomMembership: membership("human-requester", "guest"),
      requesterRoomMembership: membership("human-requester", "guest")
    };

    expect(evaluateHumanWorkControlPolicy(input)).toEqual({ allowed: true, reason: "allowed" });
    expect(() => assertHumanWorkControlPolicy(input)).not.toThrow();
  });

  it("requires an explicit current Room Owner/Admin membership for another requester's work", () => {
    const base = {
      actorParticipantId: "human-admin",
      requesterParticipantId: "human-requester",
      actorWorkspaceMembership: membership("human-admin", "admin"),
      requesterWorkspaceMembership: membership("human-requester", "member"),
      requesterRoomMembership: membership("human-requester", "member")
    };

    expect(evaluateHumanWorkControlPolicy({
      ...base,
      actorRoomMembership: membership("human-admin", "member")
    })).toEqual({ allowed: false, reason: "room_role_denied" });
    expect(evaluateHumanWorkControlPolicy({
      ...base,
      actorRoomMembership: membership("human-admin", "admin")
    })).toEqual({ allowed: true, reason: "allowed" });
    expect(evaluateHumanWorkControlPolicy({
      ...base,
      actorRoomMembership: membership("human-admin", "admin", "2026-01-01T00:00:00.000Z")
    })).toEqual({ allowed: false, reason: "room_membership_required" });
  });

  it("requires current memberships for both actor and requester", () => {
    const actor = membership("human-actor", "admin");
    expect(evaluateHumanWorkControlPolicy({
      actorParticipantId: "human-actor",
      requesterParticipantId: "human-requester",
      actorWorkspaceMembership: actor,
      actorRoomMembership: actor,
      requesterWorkspaceMembership: membership("human-requester", "member"),
      requesterRoomMembership: membership("human-requester", "member", "2026-01-01T00:00:00.000Z")
    })).toEqual({ allowed: false, reason: "requester_membership_required" });
    expect(evaluateHumanWorkControlPolicy({
      actorParticipantId: "human-actor",
      requesterParticipantId: "human-requester",
      actorWorkspaceMembership: membership("human-actor", "admin", "2026-01-01T00:00:00.000Z"),
      actorRoomMembership: actor,
      requesterWorkspaceMembership: membership("human-requester", "member"),
      requesterRoomMembership: membership("human-requester", "member")
    })).toEqual({ allowed: false, reason: "workspace_membership_required" });
  });
});
