import { z } from "zod";
import { defineCommand, type DomainResult, type TrustedDomainContext } from "../../definition/index.js";
import { roomValueSchema } from "../../value-objects/room-agent.js";

const Input = z.object({ name: z.string().trim().min(1).max(200) }).strict();
const Output = roomValueSchema;
export interface RoomCreatePorts { createRoom(input: z.infer<typeof Input>): Promise<z.infer<typeof Output>>; }

const roomCreate = defineCommand<RoomCreatePorts>()({
  id: "room.create", version: "1.0", availability: "active", title: "Create Room", description: "Create a persistent Room in the current Workspace.",
  sources: ["runtime_api", "surface_operation"], effect: "workspace_mutation", idempotency: "required", concurrency: "append_or_unique",
  render: ["status_timeline"], resourceKinds: ["room"], proposedEffects: ["Create a Room."], outputResourceKind: "room", uiDisplayCategory: "workspace",
  provenance: [{ source: "samurai", commit_sha: "workspace-design-v1", reference_file: "ARCHITECTURE.md", decision: "adapted", reason: "Keep Room identity in Workspace SQLite, separate from Backend execution." }],
  input: Input, output: Output,
  createHandler(ports) { return { execute: async function handleRoomCreate(_context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> { return { ok: true, value: Output.parse(await ports.createRoom(input)) }; } }; }
});
export default roomCreate;
