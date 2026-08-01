import { z } from "zod";
import { defineQuery, type DomainQueryPorts, type DomainResult, type ReadCapability, type TrustedDomainContext } from "../../definition/index.js";
import { roomValueSchema } from "../../value-objects/room-agent.js";

const Input = z.object({}).strict();
const Output = z.array(roomValueSchema);
export interface RoomListPorts extends DomainQueryPorts { listRooms: ReadCapability<() => Promise<z.infer<typeof Output>>>; }
const roomList = defineQuery<RoomListPorts>()({
  id: "room.list", version: "1.0", availability: "active", title: "List Rooms", description: "List persistent Rooms in the current Workspace.",
  sources: ["runtime_api"], render: ["table"], resourceKinds: ["room"], proposedEffects: ["Read Rooms."], outputResourceKind: "room", uiDisplayCategory: "workspace",
  provenance: [{ source: "samurai", commit_sha: "workspace-design-v1", reference_file: "ARCHITECTURE.md", decision: "adapted", reason: "Read Room records through the Runtime boundary." }],
  input: Input, output: Output,
  createHandler(ports) { return { execute: async function handleRoomList(_context: TrustedDomainContext, _input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> { return { ok: true, value: Output.parse(await ports.listRooms()) }; } }; }
});
export default roomList;
