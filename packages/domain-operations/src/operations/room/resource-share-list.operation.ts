import { z } from "zod";
import { defineQuery, requireRoomContext, type DomainQueryPorts, type DomainResult, type ReadCapability, type TrustedDomainContext } from "../../definition/index.js";
import { roomResourceShareValueSchema, roomShareableResourceReferenceSchema } from "../../value-objects/room-permissions.js";
import type { RoomShareableResourceReference } from "@samurai-agent/room-permissions";

const Input = z.object({ resource: roomShareableResourceReferenceSchema }).strict();
const Output = z.array(roomResourceShareValueSchema);
export interface RoomResourceShareListPorts extends DomainQueryPorts { listResourceShares: ReadCapability<(context: TrustedDomainContext, input: { sourceRoomId: string; resource: RoomShareableResourceReference }) => Promise<z.infer<typeof Output>>>; }
const roomResourceShareList = defineQuery<RoomResourceShareListPorts>()({
  id: "room.resource.share.list", version: "2.0", availability: "active", title: "List Room resource shares", description: "List current target Rooms for one explicitly shared resource.",
  sources: ["runtime_api"], render: ["table"], resourceKinds: ["room_resource_share"], proposedEffects: ["Read Room resource shares."], outputResourceKind: "room_resource_share", uiDisplayCategory: "workspace",
  provenance: [{ source: "samurai", commit_sha: "core-06", reference_file: "SAMURAI_AGENT_MANUAL.md", decision: "adapted", reason: "Share status is visible only through a participating Room." }], input: Input, output: Output,
  createHandler(ports) { return { execute: async function handleRoomResourceShareList(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> { return { ok: true, value: Output.parse(await ports.listResourceShares(context, { sourceRoomId: requireRoomContext(context, "room.resource.share.list"), resource: shareReference(input.resource) })) }; } }; }
});
export default roomResourceShareList;

function shareReference(input: z.infer<typeof roomShareableResourceReferenceSchema>): RoomShareableResourceReference {
  return input.kind === "collection_record"
    ? { kind: input.kind, collectionId: input.collection_id, recordId: input.record_id }
    : input.kind === "file"
      ? { kind: input.kind, path: input.path }
      : { kind: input.kind, id: input.id };
}
