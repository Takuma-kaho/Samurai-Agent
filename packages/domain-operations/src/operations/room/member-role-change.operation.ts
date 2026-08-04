import { z } from "zod";
import { defineCommand, type DomainResult, type TrustedDomainContext } from "../../definition/index.js";
import { humanParticipantIdSchema, roomHumanRoleSchema, roomMemberValueSchema } from "../../value-objects/room-permissions.js";

const Input = z.object({ room_id: z.string().trim().min(1), target_participant_id: humanParticipantIdSchema, role: roomHumanRoleSchema.exclude(["owner"]) }).strict();
const Output = roomMemberValueSchema;
export interface RoomMemberRoleChangePorts { changeRoomMemberRole(context: TrustedDomainContext, input: { roomId: string; participantId: string; role: z.infer<typeof Input>["role"] }): Promise<z.infer<typeof Output>>; }
const roomMemberRoleChange = defineCommand<RoomMemberRoleChangePorts>()({
  id: "room.member.role.change", version: "1.0", availability: "active", title: "Change Room participant role", description: "Change a non-owner human Room role.",
  sources: ["runtime_api"], effect: "workspace_mutation", idempotency: "required", concurrency: "state_transition", render: ["status_timeline"], resourceKinds: ["room_member"], proposedEffects: ["Change a Room participant role."], outputResourceKind: "room_member", uiDisplayCategory: "workspace",
  provenance: [{ source: "samurai", commit_sha: "core-06", reference_file: "SAMURAI_AGENT_MANUAL.md", decision: "adapted", reason: "Owner transfer has a separate atomic operation." }], input: Input, output: Output,
  createHandler(ports) { return { execute: async function handleRoomMemberRoleChange(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> { return { ok: true, value: Output.parse(await ports.changeRoomMemberRole(context, { roomId: input.room_id, participantId: input.target_participant_id, role: input.role })) }; } }; }
});
export default roomMemberRoleChange;
