import { z } from "zod";
import { defineCommand, requireRoomContext, type DomainResult, type TrustedDomainContext } from "../../definition/index.js";
import { roomAgentPermissionValueSchema } from "../../value-objects/room-permissions.js";

const Input = z.object({ agent_id: z.string().trim().min(1) }).strict();
const Output = roomAgentPermissionValueSchema;
export interface RoomAgentRemovePorts { removeRoomAgent(context: TrustedDomainContext, input: { roomId: string; agentId: string }): Promise<z.infer<typeof Output>>; }
const roomAgentRemove = defineCommand<RoomAgentRemovePorts>()({
  id: "room.agent.remove", version: "1.1", availability: "active", title: "Remove Room Agent", description: "Remove an Agent from one Room while preserving history.",
  sources: ["runtime_api"], effect: "workspace_mutation", idempotency: "required", concurrency: "state_transition", render: ["status_timeline"], resourceKinds: ["room_agent"], proposedEffects: ["Remove an Agent from a Room."], outputResourceKind: "room_agent", uiDisplayCategory: "workspace",
  provenance: [{ source: "samurai", commit_sha: "core-06", reference_file: "ARCHITECTURE.md", decision: "adapted", reason: "Agent removal disables new Room reads and runs immediately." }], input: Input, output: Output,
  createHandler(ports) { return { execute: async function handleRoomAgentRemove(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> { return { ok: true, value: Output.parse(await ports.removeRoomAgent(context, { roomId: requireRoomContext(context, "room.agent.remove"), agentId: input.agent_id })) }; } }; }
});
export default roomAgentRemove;
