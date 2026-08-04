import { z } from "zod";
import { defineQuery, type DomainQueryPorts, type DomainResult, type ReadCapability, type TrustedDomainContext } from "../../definition/index.js";
import { roomResourceShareValueSchema } from "../../value-objects/room-permissions.js";

const Input = z.object({ source_room_id: z.string().trim().min(1), resource_kind: z.string().trim().min(1), resource_id: z.string().trim().min(1) }).strict();
const Output = z.array(roomResourceShareValueSchema);
export interface RoomResourceShareListPorts extends DomainQueryPorts { listResourceShares: ReadCapability<(context: TrustedDomainContext, input: { sourceRoomId: string; resourceKind: string; resourceId: string }) => Promise<z.infer<typeof Output>>>; }
const roomResourceShareList = defineQuery<RoomResourceShareListPorts>()({
  id: "room.resource.share.list", version: "1.0", availability: "active", title: "List Room resource shares", description: "List current target Rooms for one explicitly shared resource.",
  sources: ["runtime_api"], render: ["table"], resourceKinds: ["room_resource_share"], proposedEffects: ["Read Room resource shares."], outputResourceKind: "room_resource_share", uiDisplayCategory: "workspace",
  provenance: [{ source: "samurai", commit_sha: "core-06", reference_file: "SAMURAI_AGENT_MANUAL.md", decision: "adapted", reason: "Share status is visible only through a participating Room." }], input: Input, output: Output,
  createHandler(ports) { return { execute: async function handleRoomResourceShareList(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> { return { ok: true, value: Output.parse(await ports.listResourceShares(context, { sourceRoomId: input.source_room_id, resourceKind: input.resource_kind, resourceId: input.resource_id })) }; } }; }
});
export default roomResourceShareList;
