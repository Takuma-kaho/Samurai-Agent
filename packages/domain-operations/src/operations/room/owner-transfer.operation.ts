import { z } from "zod";
import { defineCommand, requireRoomContext, type DomainResult, type TrustedDomainContext } from "../../definition/index.js";
import { humanParticipantIdSchema, roomMemberValueSchema } from "../../value-objects/room-permissions.js";

const Input = z.object({ to_participant_id: humanParticipantIdSchema }).strict();
const Output = z.object({ previous_owner: roomMemberValueSchema, owner: roomMemberValueSchema }).strict();
export interface RoomOwnerTransferPorts { transferRoomOwnership(context: TrustedDomainContext, input: { roomId: string; toParticipantId: string }): Promise<{ previousOwner: z.infer<typeof roomMemberValueSchema>; owner: z.infer<typeof roomMemberValueSchema> }>; }
const roomOwnerTransfer = defineCommand<RoomOwnerTransferPorts>()({
  id: "room.owner.transfer", version: "1.1", availability: "active", title: "Transfer Room ownership", description: "Atomically transfer the single Room Owner.",
  sources: ["runtime_api"], effect: "workspace_mutation", idempotency: "required", concurrency: "state_transition", render: ["status_timeline"], resourceKinds: ["room_member"], proposedEffects: ["Transfer Room ownership."], outputResourceKind: "room_member", uiDisplayCategory: "workspace",
  provenance: [{ source: "samurai", commit_sha: "core-06", reference_file: "ARCHITECTURE.md", decision: "adapted", reason: "Owner transfer is not a normal role change." }], input: Input, output: Output,
  createHandler(ports) { return { execute: async function handleRoomOwnerTransfer(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> { const value = await ports.transferRoomOwnership(context, { roomId: requireRoomContext(context, "room.owner.transfer"), toParticipantId: input.to_participant_id }); return { ok: true, value: Output.parse({ previous_owner: value.previousOwner, owner: value.owner }) }; } }; }
});
export default roomOwnerTransfer;
