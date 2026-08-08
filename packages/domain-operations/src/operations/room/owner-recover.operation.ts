import { z } from "zod";
import { defineCommand, requireRoomContext, type DomainResult, type TrustedDomainContext } from "../../definition/index.js";
import { humanParticipantIdSchema, roomMemberValueSchema } from "../../value-objects/room-permissions.js";

const Input = z.object({ owner_participant_id: humanParticipantIdSchema }).strict();
const Output = roomMemberValueSchema;
export interface RoomOwnerRecoverPorts { recoverOwnerlessRoom(context: TrustedDomainContext, input: { roomId: string; ownerParticipantId: string }): Promise<z.infer<typeof Output>>; }
const roomOwnerRecover = defineCommand<RoomOwnerRecoverPorts>()({
  id: "room.owner.recover", version: "1.0", availability: "active", title: "Recover ownerless Room", description: "Assign one Owner only when a Room has no active Owner.",
  sources: ["runtime_api"], effect: "workspace_mutation", idempotency: "required", concurrency: "state_transition", render: ["status_timeline"], resourceKinds: ["room_member"], proposedEffects: ["Recover an ownerless Room."], outputResourceKind: "room_member", uiDisplayCategory: "workspace",
  provenance: [{ source: "samurai", commit_sha: "core-06", reference_file: "SAMURAI_AGENT_MANUAL.md", decision: "adapted", reason: "Only the Workspace Owner can recover an ownerless Room." }], input: Input, output: Output,
  createHandler(ports) { return { execute: async function handleRoomOwnerRecover(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> { return { ok: true, value: Output.parse(await ports.recoverOwnerlessRoom(context, { roomId: requireRoomContext(context, "room.owner.recover"), ownerParticipantId: input.owner_participant_id })) }; } }; }
});
export default roomOwnerRecover;
