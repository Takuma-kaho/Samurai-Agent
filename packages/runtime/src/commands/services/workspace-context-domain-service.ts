import { DomainOperationError, type TrustedDomainContext } from "@samurai-agent/domain-operations";
import { roomActions, type ParticipantPrincipal } from "@samurai-agent/room-permissions";
import { RoomAuthorizationError, RoomAuthorizationService } from "./room-authorization-service.js";

export interface WorkspaceContextReadStore {
  getRoom(id: string): Promise<{ id: string; name: string; updated_at: string } | undefined>;
  getWorkspaceContext(): Promise<{ workspace_name?: string; rules: string[]; updated_at: string }>;
  getRoomContext(roomId: string): Promise<{ room_id: string; purpose?: string; work_goal?: string; updated_at: string } | undefined>;
}

export interface WorkspaceContextRequest {
  room_id: string;
}

/** Reads only human-owned Workspace/Room metadata. It never derives a Room
 * purpose or work goal from an external Client, and it rejects a request for
 * any Room other than the already-authorized external target. */
export class WorkspaceContextDomainService {
  constructor(
    private readonly store: WorkspaceContextReadStore,
    private readonly authorization: RoomAuthorizationService
  ) {}

  async get(context: TrustedDomainContext, input: WorkspaceContextRequest): Promise<{
    workspace: { id: string; name: string; rules: string[]; updated_at: string };
    room: {
      id: string;
      name: string;
      purpose?: string;
      work_goal?: string;
      permissions: string[];
      prohibited: string[];
      updated_at: string;
    };
  }> {
    const access = await this.resolveAccess(context, input.room_id);
    const [room, workspace, roomContext, roomPermissions] = await Promise.all([
      this.store.getRoom(access.roomId),
      this.store.getWorkspaceContext(),
      this.store.getRoomContext(access.roomId),
      this.currentRoomPermissions(access.principal, access.roomId)
    ]);
    if (!room) throw new DomainOperationError("not_found", `workspace_context_room_not_found:${access.roomId}`);
    return {
      workspace: {
        id: access.workspaceId,
        // A Workspace ID is the truthful fallback; never manufacture a name.
        name: workspace.workspace_name?.trim() || access.workspaceId,
        rules: normalizedLines(workspace.rules),
        updated_at: workspace.updated_at
      },
      room: {
        id: room.id,
        name: room.name,
        ...(roomContext?.purpose ? { purpose: roomContext.purpose } : {}),
        ...(roomContext?.work_goal ? { work_goal: roomContext.work_goal } : {}),
        permissions: roomPermissions.permissions,
        prohibited: roomPermissions.prohibited,
        updated_at: roomContext?.updated_at ?? room.updated_at
      }
    };
  }

  private async currentRoomPermissions(principal: ParticipantPrincipal, roomId: string): Promise<{ permissions: string[]; prohibited: string[] }> {
    const decisions = await Promise.all(roomActions.map(async (action) => [action, await this.authorization.roomDecision(principal, roomId, action)] as const));
    return {
      permissions: decisions.filter(([, decision]) => decision.allowed).map(([action]) => `room.${action}`),
      prohibited: decisions.filter(([, decision]) => !decision.allowed).map(([action, decision]) => `room.${action}:${decision.reason}`)
    };
  }

  private async resolveAccess(context: TrustedDomainContext, requestedRoomId: string): Promise<{ workspaceId: string; roomId: string; principal: ParticipantPrincipal }> {
    if (!context.workspaceId || !context.roomId || !context.participant) {
      throw new DomainOperationError("unavailable", "workspace_context_trusted_room_required");
    }
    if (context.roomId !== requestedRoomId) throw new DomainOperationError("conflict", "workspace_context_room_mismatch");
    try {
      await this.authorization.assertRoom(context.participant, context.roomId, "read");
    } catch (error) {
      if (error instanceof RoomAuthorizationError) {
        throw new DomainOperationError("source_not_allowed", `workspace_context_room_authorization_denied:${error.reason}`);
      }
      throw error;
    }
    return { workspaceId: context.workspaceId, roomId: context.roomId, principal: context.participant };
  }
}

function normalizedLines(value: string[]): string[] {
  return [...new Set(value.map((line) => line.trim()).filter(Boolean))].slice(0, 200);
}
