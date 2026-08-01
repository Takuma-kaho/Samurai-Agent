import { z } from "zod";
import { defineQuery, type DomainQueryPorts, type DomainResult, type ReadCapability, type TrustedDomainContext } from "../../definition/index.js";
import { roomValueSchema } from "../../value-objects/room-agent.js";

const Input = z.object({ id: z.string().trim().min(1) }).strict();
const Output = roomValueSchema;
export interface RoomViewPorts extends DomainQueryPorts { viewRoom: ReadCapability<(id: string) => Promise<z.infer<typeof Output>>>; }
const roomView = defineQuery<RoomViewPorts>()({
  id: "room.view", version: "1.0", availability: "active", title: "View Room", description: "Read one Room.",
  sources: ["runtime_api"], render: ["status_timeline"], resourceKinds: ["room"], proposedEffects: ["Read a Room."], outputResourceKind: "room", uiDisplayCategory: "workspace",
  provenance: [{ source: "samurai", commit_sha: "workspace-design-v1", reference_file: "ARCHITECTURE.md", decision: "adapted", reason: "Read Room records through the Runtime boundary." }],
  input: Input, output: Output,
  createHandler(ports) { return { execute: async function handleRoomView(_context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> { return { ok: true, value: Output.parse(await ports.viewRoom(input.id)) }; } }; }
});
export default roomView;
