import { z } from "zod";
import { defineCommand, type DomainResult, type TrustedDomainContext } from "../../definition/index.js";
import { roomAgentPermissionValueSchema } from "../../value-objects/room-permissions.js";

const Input = z.object({ room_id: z.string().trim().min(1), agent_id: z.string().trim().min(1) }).strict();
const Output = roomAgentPermissionValueSchema;
export interface RoomAgentRemovePorts { removeRoomAgent(context: TrustedDomainContext, input: { roomId: string; agentId: string }): Promise<z.infer<typeof Output>>; }
const roomAgentRemove = defineCommand<RoomAgentRemovePorts>()({
  id: "room.agent.remove", version: "1.0", availability: "active", title: "Remove Room Agent", description: "Remove an Agent from one Room while preserving history.",
  sources: ["runtime_api"], effect: "workspace_mutation", idempotency: "required", concurrency: "state_transition", render: ["status_timeline"], resourceKinds: ["room_agent"], proposedEffects: ["Remove an Agent from a Room."], outputResourceKind: "room_agent", uiDisplayCategory: "workspace",
  provenance: [{ source: "samurai", commit_sha: "core-06", reference_file: "SAMURAI_AGENT_MANUAL.md", decision: "adapted", reason: "Agent removal disables new Room reads and runs immediately." }], input: Input, output: Output,
  createHandler(ports) { return { execute: async function handleRoomAgentRemove(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> { return { ok: true, value: Output.parse(await ports.removeRoomAgent(context, { roomId: input.room_id, agentId: input.agent_id })) }; } }; }
});
export default roomAgentRemove;
