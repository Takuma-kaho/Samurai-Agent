import { z } from "zod";
import { defineCommand, requireRoomContext, type DomainResult, type TrustedDomainContext } from "../../definition/index.js";
import { humanParticipantIdSchema, roomMemberValueSchema } from "../../value-objects/room-permissions.js";

const Input = z.object({ target_participant_id: humanParticipantIdSchema }).strict();
const Output = roomMemberValueSchema;
export interface RoomMemberRemovePorts { removeRoomMember(context: TrustedDomainContext, input: { roomId: string; participantId: string }): Promise<z.infer<typeof Output>>; }
const roomMemberRemove = defineCommand<RoomMemberRemovePorts>()({
  id: "room.member.remove", version: "1.1", availability: "active", title: "Remove Room participant", description: "Remove a human participant from one Room while preserving history.",
  sources: ["runtime_api"], effect: "workspace_mutation", idempotency: "required", concurrency: "state_transition", render: ["status_timeline"], resourceKinds: ["room_member"], proposedEffects: ["Remove a Room participant."], outputResourceKind: "room_member", uiDisplayCategory: "workspace",
  provenance: [{ source: "samurai", commit_sha: "core-06", reference_file: "ARCHITECTURE.md", decision: "adapted", reason: "Removed participants lose new access immediately without history deletion." }], input: Input, output: Output,
  createHandler(ports) { return { execute: async function handleRoomMemberRemove(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> { return { ok: true, value: Output.parse(await ports.removeRoomMember(context, { roomId: requireRoomContext(context, "room.member.remove"), participantId: input.target_participant_id })) }; } }; }
});
export default roomMemberRemove;
