import { z } from "zod";
import { defineCommand, requireRoomContext, type DomainResult, type TrustedDomainContext } from "../../definition/index.js";
import { roomDefaultAgentValueSchema, roomWorkVersionSchema } from "./work-contracts.js";

const Input = z.object({
  agent_id: z.string().trim().min(1).max(512),
  expected_version: roomWorkVersionSchema.optional()
}).strict();
const Output = roomDefaultAgentValueSchema;

export type RoomDefaultAgentSetInput = z.infer<typeof Input>;
export interface RoomDefaultAgentSetPorts {
  setRoomDefaultAgent(context: TrustedDomainContext, input: { roomId: string; agentId: string; expectedVersion?: number }): Promise<z.infer<typeof Output>>;
}

const roomDefaultAgentSet = defineCommand<RoomDefaultAgentSetPorts>()({
  id: "room.default_agent.set", version: "1.0", availability: "active", title: "Set Room default Agent",
  description: "Set the one explicit default Agent used for new work in a Room.",
  sources: ["runtime_api", "surface_operation"], effect: "workspace_mutation", idempotency: "required", concurrency: "optimistic_version",
  render: ["status_timeline"], resourceKinds: ["room", "agent", "room_default_agent"],
  proposedEffects: ["Change the Room's default Agent without changing in-flight work assignments."], outputResourceKind: "room_default_agent", uiDisplayCategory: "room",
  provenance: [{ source: "samurai", commit_sha: "room-agent-collaboration-v1", reference_file: "docs/designs/room-agent-work.md", decision: "adapted", reason: "Default-Agent changes apply to new work and never silently replace an in-flight assignee." }],
  input: Input, output: Output,
  createHandler(ports) {
    return { execute: async function handleRoomDefaultAgentSet(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
      const value = await ports.setRoomDefaultAgent(context, {
        roomId: requireRoomContext(context, "room.default_agent.set"),
        agentId: input.agent_id,
        ...(input.expected_version === undefined ? {} : { expectedVersion: input.expected_version })
      });
      return { ok: true, value: Output.parse(value) };
    } };
  }
});

export default roomDefaultAgentSet;
