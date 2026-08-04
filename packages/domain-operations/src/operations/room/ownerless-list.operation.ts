import { z } from "zod";
import { defineQuery, type DomainQueryPorts, type DomainResult, type ReadCapability, type TrustedDomainContext } from "../../definition/index.js";
import { roomValueSchema } from "../../value-objects/room-agent.js";

const Input = z.object({}).strict();
const Output = z.array(roomValueSchema);

export interface RoomOwnerlessListPorts extends DomainQueryPorts {
  listOwnerlessRooms: ReadCapability<(context: TrustedDomainContext) => Promise<z.infer<typeof Output>>>;
}

const roomOwnerlessList = defineQuery<RoomOwnerlessListPorts>()({
  id: "room.ownerless.list", version: "1.0", availability: "active", title: "List ownerless Rooms", description: "List Rooms that require explicit Workspace Owner recovery.",
  sources: ["runtime_api"], render: ["table"], resourceKinds: ["room", "room_member"], proposedEffects: ["Read ownerless Rooms for explicit recovery."], outputResourceKind: "room", uiDisplayCategory: "workspace",
  provenance: [{ source: "samurai", commit_sha: "core-06", reference_file: "SAMURAI_AGENT_MANUAL.md", decision: "adapted", reason: "Ownerless Room recovery is explicit and visible only to the Workspace Owner." }], input: Input, output: Output,
  createHandler(ports) { return { execute: async function handleRoomOwnerlessList(context: TrustedDomainContext, _input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> { return { ok: true, value: Output.parse(await ports.listOwnerlessRooms(context)) }; } }; }
});

export default roomOwnerlessList;
