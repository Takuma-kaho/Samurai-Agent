import { z } from "zod";
import { defineQuery, requireRoomContext, type DomainQueryPorts, type DomainResult, type ReadCapability, type TrustedDomainContext } from "../../definition/index.js";
import { roomAgentPermissionValueSchema, roomMemberValueSchema } from "../../value-objects/room-permissions.js";

const Input = z.object({}).strict();
const Output = z.object({ humans: z.array(roomMemberValueSchema), agents: z.array(roomAgentPermissionValueSchema) }).strict();
export interface RoomMemberListPorts extends DomainQueryPorts { listRoomParticipants: ReadCapability<(context: TrustedDomainContext, roomId: string) => Promise<z.infer<typeof Output>>>; }
const roomMemberList = defineQuery<RoomMemberListPorts>()({
  id: "room.member.list", version: "1.1", availability: "active", title: "List Room participants", description: "List current human and Agent participants in one Room.",
  sources: ["runtime_api"], render: ["table"], resourceKinds: ["room_member", "room_agent"], proposedEffects: ["Read Room participants."], outputResourceKind: "room_member", uiDisplayCategory: "workspace",
  provenance: [{ source: "samurai", commit_sha: "core-06", reference_file: "ARCHITECTURE.md", decision: "adapted", reason: "Agents remain distinct from human role membership." }], input: Input, output: Output,
  createHandler(ports) { return { execute: async function handleRoomMemberList(context: TrustedDomainContext, _input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> { return { ok: true, value: Output.parse(await ports.listRoomParticipants(context, requireRoomContext(context, "room.member.list"))) }; } }; }
});
export default roomMemberList;
