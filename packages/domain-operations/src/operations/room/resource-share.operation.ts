import { z } from "zod";
import { defineCommand, type DomainResult, type TrustedDomainContext } from "../../definition/index.js";
import { roomResourceShareValueSchema, roomShareableResourceReferenceSchema } from "../../value-objects/room-permissions.js";
import type { RoomShareableResourceReference } from "@samurai-agent/room-permissions";

const resourceInput = { source_room_id: z.string().trim().min(1), target_room_id: z.string().trim().min(1), resource: roomShareableResourceReferenceSchema };
const Input = z.object(resourceInput).strict();
const Output = roomResourceShareValueSchema;
export interface RoomResourceSharePorts { shareResource(context: TrustedDomainContext, input: { sourceRoomId: string; targetRoomId: string; resource: RoomShareableResourceReference }): Promise<z.infer<typeof Output>>; }
const roomResourceShare = defineCommand<RoomResourceSharePorts>()({
  id: "room.resource.share", version: "2.0", availability: "active", title: "Share resource with Room", description: "Add explicit read and use eligibility for one target Room without copying the resource.",
  sources: ["runtime_api"], effect: "workspace_mutation", idempotency: "required", concurrency: "append_or_unique", render: ["status_timeline"], resourceKinds: ["resource_access_boundary", "room_resource_share"], proposedEffects: ["Share a Room resource."], outputResourceKind: "room_resource_share", uiDisplayCategory: "workspace",
  provenance: [{ source: "samurai", commit_sha: "core-06", reference_file: "SAMURAI_AGENT_MANUAL.md", decision: "adapted", reason: "Room sharing keeps original resource provenance instead of copying data." }], input: Input, output: Output,
  createHandler(ports) { return { execute: async function handleRoomResourceShare(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> { return { ok: true, value: Output.parse(await ports.shareResource(context, { sourceRoomId: input.source_room_id, targetRoomId: input.target_room_id, resource: shareReference(input.resource) })) }; } }; }
});
export default roomResourceShare;

function shareReference(input: z.infer<typeof roomShareableResourceReferenceSchema>): RoomShareableResourceReference {
  return input.kind === "collection_record"
    ? { kind: input.kind, collectionId: input.collection_id, recordId: input.record_id }
    : input.kind === "file"
      ? { kind: input.kind, path: input.path }
      : { kind: input.kind, id: input.id };
}
