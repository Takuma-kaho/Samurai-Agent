import { z } from "zod";
import { defineCommand, requireRoomContext, type DomainResult, type TrustedDomainContext } from "../../definition/index.js";
import { roomResourceShareValueSchema, roomShareableResourceReferenceSchema } from "../../value-objects/room-permissions.js";
import type { RoomShareableResourceReference } from "@samurai-agent/room-permissions";

const Input = z.object({ target_room_id: z.string().trim().min(1), resource: roomShareableResourceReferenceSchema }).strict();
const Output = roomResourceShareValueSchema;
export interface RoomResourceShareRevokePorts { revokeResourceShare(context: TrustedDomainContext, input: { sourceRoomId: string; targetRoomId: string; resource: RoomShareableResourceReference }): Promise<z.infer<typeof Output>>; }
const roomResourceShareRevoke = defineCommand<RoomResourceShareRevokePorts>()({
  id: "room.resource.share.revoke", version: "2.1", availability: "active", title: "Revoke Room resource share", description: "Revoke a target Room's future access without deleting history.",
  sources: ["runtime_api"], effect: "workspace_mutation", idempotency: "required", concurrency: "state_transition", render: ["status_timeline"], resourceKinds: ["room_resource_share"], proposedEffects: ["Revoke a Room resource share."], outputResourceKind: "room_resource_share", uiDisplayCategory: "workspace",
  provenance: [{ source: "samurai", commit_sha: "core-06", reference_file: "ARCHITECTURE.md", decision: "adapted", reason: "Share revocation blocks future reads while preserving prior records." }], input: Input, output: Output,
  createHandler(ports) { return { execute: async function handleRoomResourceShareRevoke(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> { return { ok: true, value: Output.parse(await ports.revokeResourceShare(context, { sourceRoomId: requireRoomContext(context, "room.resource.share.revoke"), targetRoomId: input.target_room_id, resource: shareReference(input.resource) })) }; } }; }
});
export default roomResourceShareRevoke;

function shareReference(input: z.infer<typeof roomShareableResourceReferenceSchema>): RoomShareableResourceReference {
  return input.kind === "collection_record"
    ? { kind: input.kind, collectionId: input.collection_id, recordId: input.record_id }
    : input.kind === "file"
      ? { kind: input.kind, path: input.path }
      : { kind: input.kind, id: input.id };
}
