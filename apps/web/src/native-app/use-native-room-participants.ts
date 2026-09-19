import { useEffect, useMemo, useRef, useState } from "react";
import type { DesktopWorkspaceRoomMembership, DesktopWorkspaceTarget } from "../lib/api";
import type { NativeAgent, NativeRoomAgentMember, NativeRoom } from "./types";

export interface NativeRoomParticipant {
  id: string;
  kind: "account" | "agent";
  label: string;
  role?: string;
  state: "active" | "revoked" | "available" | "unavailable";
  reason?: string;
}

export interface NativeRoomParticipantsBridge {
  listWorkspaceRoomMembers?: (roomId: string, target?: DesktopWorkspaceTarget) => Promise<{ members: DesktopWorkspaceRoomMembership[] }>;
}

export interface UseNativeRoomParticipantsOptions {
  room?: NativeRoom;
  target?: DesktopWorkspaceTarget;
  agents?: readonly NativeAgent[];
  roomAgentMembers?: readonly NativeRoomAgentMember[];
  bridge?: NativeRoomParticipantsBridge;
  /** Names returned by an authorized account/member query. */
  accountDisplayNames?: Readonly<Record<string, string | undefined>>;
}

function participantState(member: NativeRoomAgentMember, agent: NativeAgent | undefined): NativeRoomParticipant["state"] {
  if (member.removed) return "revoked";
  return agent && agent.enabled && agent.status !== "disabled" ? "available" : "unavailable";
}

export function nativeRoomParticipantDisplayName(
  accountId: string,
  index: number,
  accountDisplayNames?: Readonly<Record<string, string | undefined>>
): { label: string; reason?: string } {
  const displayName = accountDisplayNames?.[accountId]?.trim();
  if (displayName) return { label: displayName };
  return { label: `参加者${index + 1}`, reason: "表示名未取得" };
}

export function useNativeRoomParticipants({ room, target, agents = [], roomAgentMembers = [], bridge, accountDisplayNames }: UseNativeRoomParticipantsOptions) {
  const [members, setMembers] = useState<DesktopWorkspaceRoomMembership[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sequence = useRef(0);
  const roomId = room?.id;
  const targetKey = target ? `${target.connectionId}\n${target.workspaceId}` : "";

  useEffect(() => {
    const request = ++sequence.current;
    if (!roomId || !target || room.kind === "agent_dm" || !bridge?.listWorkspaceRoomMembers) {
      setMembers([]);
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    void bridge.listWorkspaceRoomMembers(roomId, target)
      .then((result) => {
        if (sequence.current !== request) return;
        const scoped = result.members.filter((member) => member.workspaceId === target.workspaceId && member.roomId === roomId && member.state === "active");
        setMembers(scoped);
      })
      .catch(() => {
        if (sequence.current !== request) return;
        setMembers([]);
        setError("参加者を確認できません。");
      })
      .finally(() => {
        if (sequence.current === request) setLoading(false);
      });
    return () => {
      sequence.current += 1;
    };
  }, [bridge, room?.kind, roomId, target, targetKey]);

  const participants = useMemo<NativeRoomParticipant[]>(() => {
    const humans: NativeRoomParticipant[] = members.map((member, index) => {
      const display = nativeRoomParticipantDisplayName(member.accountId, index, accountDisplayNames);
      return {
        id: member.accountId,
        kind: "account",
        label: display.label,
        ...(display.reason ? { reason: display.reason } : {}),
        role: member.role,
        state: member.state
      };
    });
    const roomAgentIds = new Set(roomAgentMembers.filter((member) => member.roomId === roomId).map((member) => member.agentId));
    const agentsInRoom = agents.filter((agent) => roomAgentIds.has(agent.id));
    const agentRows: NativeRoomParticipant[] = roomAgentMembers
      .filter((member) => member.roomId === roomId && !member.removed)
      .map((member) => {
        const agent = agentsInRoom.find((candidate) => candidate.id === member.agentId);
        return {
          id: member.agentId,
          kind: "agent",
          label: agent?.displayName ?? "Agent",
          state: participantState(member, agent),
          ...(agent && agent.enabled && agent.status !== "disabled" ? {} : { reason: "Agentの利用可否を確認してください。" })
        };
      });
    return [...humans, ...agentRows];
  }, [accountDisplayNames, agents, members, roomAgentMembers, roomId]);

  return { participants, loading, error };
}
