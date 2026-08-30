import { z } from "zod";
import { defineCommand, type DomainResult, type TrustedDomainContext } from "../../definition/index.js";
import { roomValueSchema } from "../../value-objects/room-agent.js";

const Input = z.object({ id: z.string().trim().min(1), name: z.string().trim().min(1).max(200), expected_version: z.number().int().positive().optional() }).strict();
const Output = roomValueSchema;
export interface RoomPatchPorts { patchRoom(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<z.infer<typeof Output>>; }
const roomPatch = defineCommand<RoomPatchPorts>()({
  id: "room.patch", version: "1.1", availability: "active", title: "Update Room", description: "Update a Room name.",
  sources: ["runtime_api", "surface_operation"], effect: "workspace_mutation", idempotency: "required", concurrency: "optimistic_version",
  render: ["status_timeline"], resourceKinds: ["room"], proposedEffects: ["Update a Room name."], outputResourceKind: "room", uiDisplayCategory: "workspace",
  provenance: [{ source: "samurai", commit_sha: "workspace-design-v1", reference_file: "ARCHITECTURE.md", decision: "adapted", reason: "Keep Room identity in Workspace PostgreSQL." }],
  input: Input, output: Output,
  createHandler(ports) { return { execute: async function handleRoomPatch(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> { return { ok: true, value: Output.parse(await ports.patchRoom(context, input)) }; } }; }
});
export default roomPatch;
