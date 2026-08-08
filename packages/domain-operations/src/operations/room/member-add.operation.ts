import { z } from "zod";
import { defineCommand, requireRoomContext, type DomainResult, type TrustedDomainContext } from "../../definition/index.js";
import { humanParticipantIdSchema, roomHumanRoleSchema, roomMemberValueSchema } from "../../value-objects/room-permissions.js";

const Input = z.object({ target_participant_id: humanParticipantIdSchema, role: roomHumanRoleSchema.exclude(["owner"]) }).strict();
const Output = roomMemberValueSchema;
export interface RoomMemberAddPorts { addRoomMember(context: TrustedDomainContext, input: { roomId: string; participantId: string; role: z.infer<typeof Input>["role"] }): Promise<z.infer<typeof Output>>; }
const roomMemberAdd = defineCommand<RoomMemberAddPorts>()({
  id: "room.member.add", version: "1.0", availability: "active", title: "Add Room participant", description: "Add a human participant to one Room.",
  sources: ["runtime_api"], effect: "workspace_mutation", idempotency: "required", concurrency: "append_or_unique", render: ["status_timeline"], resourceKinds: ["room_member"], proposedEffects: ["Add a Room participant."], outputResourceKind: "room_member", uiDisplayCategory: "workspace",
  provenance: [{ source: "samurai", commit_sha: "core-06", reference_file: "SAMURAI_AGENT_MANUAL.md", decision: "adapted", reason: "Room participation is separate from Workspace membership." }], input: Input, output: Output,
  createHandler(ports) { return { execute: async function handleRoomMemberAdd(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> { return { ok: true, value: Output.parse(await ports.addRoomMember(context, { roomId: requireRoomContext(context, "room.member.add"), participantId: input.target_participant_id, role: input.role })) }; } }; }
});
export default roomMemberAdd;
