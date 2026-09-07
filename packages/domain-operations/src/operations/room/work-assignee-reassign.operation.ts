import { z } from "zod";
import { defineCommand, requireRoomContext, type DomainResult, type TrustedDomainContext } from "../../definition/index.js";
import { roomWorkAssigneeValueSchema, roomWorkGenerationSchema, roomWorkVersionSchema } from "./work-contracts.js";

const Input = z.object({
  work_id: z.string().trim().min(1).max(512),
  assignee_id: z.string().trim().min(1).max(512),
  agent_id: z.string().trim().min(1).max(512),
  expected_version: roomWorkVersionSchema.optional(),
  expected_generation: roomWorkGenerationSchema.optional()
}).strict();
const Output = roomWorkAssigneeValueSchema;

export type RoomWorkAssigneeReassignInput = z.infer<typeof Input>;
export interface RoomWorkAssigneeReassignPorts {
  reassignRoomWorkAssignee(context: TrustedDomainContext, input: { roomId: string; workId: string; assigneeId: string; agentId: string; expectedVersion?: number; expectedGeneration?: number }): Promise<z.infer<typeof Output>>;
}

const roomWorkAssigneeReassign = defineCommand<RoomWorkAssigneeReassignPorts>()({
  id: "room.work.assignee.reassign", version: "1.0", availability: "active", title: "Reassign Room work",
  description: "Replace one assigned Agent only after the old execution has a confirmed terminal state.",
  sources: ["runtime_api", "surface_operation"], effect: "workspace_mutation", idempotency: "required", concurrency: "optimistic_version",
  render: ["status_timeline"], resourceKinds: ["room_work", "room_work_assignee"],
  proposedEffects: ["Reassign a Room work to an explicitly selected Agent."], outputResourceKind: "room_work_assignee", uiDisplayCategory: "room",
  provenance: [{ source: "samurai", commit_sha: "room-agent-collaboration-v1", reference_file: "docs/designs/room-agent-work.md", decision: "adapted", reason: "A new assignment is a new generation and must not accept delayed results from the old assignment." }],
  input: Input, output: Output,
  createHandler(ports) {
    return { execute: async function handleRoomWorkAssigneeReassign(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
      const value = await ports.reassignRoomWorkAssignee(context, {
        roomId: requireRoomContext(context, "room.work.assignee.reassign"),
        workId: input.work_id,
        assigneeId: input.assignee_id,
        agentId: input.agent_id,
        ...(input.expected_version === undefined ? {} : { expectedVersion: input.expected_version }),
        ...(input.expected_generation === undefined ? {} : { expectedGeneration: input.expected_generation })
      });
      return { ok: true, value: Output.parse(value) };
    } };
  }
});

export default roomWorkAssigneeReassign;
