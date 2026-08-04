import type { DomainOperationPorts } from "@samurai-agent/domain-operations";
import type { RuntimeDomainServices } from "../domain-operation-services.js";
import { readOnlyQueryPort } from "./read-only-query-port.js";

type Ports = Pick<DomainOperationPorts,
  | "room.create" | "room.patch" | "room.list" | "room.view"
  | "agent.create" | "agent.patch" | "agent.backend.bind" | "agent.list" | "agent.view"
  | "workspace.member.add" | "workspace.member.list" | "workspace.member.role.change" | "workspace.member.remove" | "workspace.owner.transfer"
  | "agent.workspace_permission.set"
  | "room.member.add" | "room.member.list" | "room.member.role.change" | "room.member.remove"
  | "room.agent.permission.set" | "room.agent.remove" | "room.owner.transfer" | "room.owner.recover" | "room.ownerless.list"
  | "room.resource.share" | "room.resource.share.revoke" | "room.resource.share.list"
>;

export function createRoomAgentDomainServicePorts(services: Pick<RuntimeDomainServices, "roomAgentDomainService">): Ports {
  return {
    "room.create": { createRoom: (context, input) => services.roomAgentDomainService.createRoom(context, input) },
    "room.patch": { patchRoom: (context, input) => services.roomAgentDomainService.patchRoom(context, input) },
    "room.list": readOnlyQueryPort<DomainOperationPorts["room.list"]>({ listRooms: (context) => services.roomAgentDomainService.listRooms(context) }),
    "room.view": readOnlyQueryPort<DomainOperationPorts["room.view"]>({ viewRoom: (context, id) => services.roomAgentDomainService.viewRoom(context, id) }),
    "agent.create": { createAgent: (context, input) => services.roomAgentDomainService.createAgent(context, input) },
    "agent.patch": { patchAgent: (context, input) => services.roomAgentDomainService.patchAgent(context, input) },
    "agent.backend.bind": { bindAgentBackend: (context, input) => services.roomAgentDomainService.bindAgentBackend(context, input) },
    "agent.list": readOnlyQueryPort<DomainOperationPorts["agent.list"]>({ listAgents: (context) => services.roomAgentDomainService.listAgents(context) }),
    "agent.view": readOnlyQueryPort<DomainOperationPorts["agent.view"]>({ viewAgent: (context, id) => services.roomAgentDomainService.viewAgent(context, id) }),
    "workspace.member.add": { addWorkspaceMember: (context, input) => services.roomAgentDomainService.addWorkspaceMember(context, input) },
    "workspace.member.list": readOnlyQueryPort<DomainOperationPorts["workspace.member.list"]>({ listWorkspaceMembers: (context) => services.roomAgentDomainService.listWorkspaceMembers(context) }),
    "workspace.member.role.change": { changeWorkspaceMemberRole: (context, input) => services.roomAgentDomainService.changeWorkspaceMemberRole(context, input) },
    "workspace.member.remove": { removeWorkspaceMember: (context, participantId) => services.roomAgentDomainService.removeWorkspaceMember(context, participantId) },
    "workspace.owner.transfer": { transferWorkspaceOwnership: (context, participantId) => services.roomAgentDomainService.transferWorkspaceOwnership(context, participantId) },
    "agent.workspace_permission.set": { setAgentRoomCreatePermission: async (context, input) => (await services.roomAgentDomainService.setAgentRoomCreatePermission(context, input)) ?? null },
    "room.member.add": { addRoomMember: (context, input) => services.roomAgentDomainService.addRoomMember(context, input) },
    "room.member.list": readOnlyQueryPort<DomainOperationPorts["room.member.list"]>({ listRoomParticipants: (context, roomId) => services.roomAgentDomainService.listRoomParticipants(context, roomId) }),
    "room.member.role.change": { changeRoomMemberRole: (context, input) => services.roomAgentDomainService.changeRoomMemberRole(context, input) },
    "room.member.remove": { removeRoomMember: (context, input) => services.roomAgentDomainService.removeRoomMember(context, input) },
    "room.agent.permission.set": { setRoomAgentPermissions: (context, input) => services.roomAgentDomainService.setRoomAgentPermissions(context, input) },
    "room.agent.remove": { removeRoomAgent: (context, input) => services.roomAgentDomainService.removeRoomAgent(context, input) },
    "room.owner.transfer": { transferRoomOwnership: (context, input) => services.roomAgentDomainService.transferRoomOwnership(context, input) },
    "room.owner.recover": { recoverOwnerlessRoom: (context, input) => services.roomAgentDomainService.recoverOwnerlessRoom(context, input) },
    "room.ownerless.list": readOnlyQueryPort<DomainOperationPorts["room.ownerless.list"]>({ listOwnerlessRooms: (context) => services.roomAgentDomainService.listOwnerlessRooms(context) }),
    "room.resource.share": { shareResource: (context, input) => services.roomAgentDomainService.shareResource(context, input) },
    "room.resource.share.revoke": { revokeResourceShare: (context, input) => services.roomAgentDomainService.revokeResourceShare(context, input) },
    "room.resource.share.list": readOnlyQueryPort<DomainOperationPorts["room.resource.share.list"]>({ listResourceShares: (context, input) => services.roomAgentDomainService.listResourceShares(context, input) })
  };
}
