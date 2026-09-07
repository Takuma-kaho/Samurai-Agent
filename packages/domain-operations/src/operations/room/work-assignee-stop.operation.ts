import { z } from "zod";
import { defineCommand, requireRoomContext, type DomainResult, type TrustedDomainContext } from "../../definition/index.js";
import { roomWorkControlValueSchema, roomWorkGenerationSchema, roomWorkVersionSchema } from "./work-contracts.js";

const Input = z.object({
  work_id: z.string().trim().min(1).max(512),
  assignee_id: z.string().trim().min(1).max(512),
  reason: z.string().trim().min(1).max(2_000).optional(),
  expected_version: roomWorkVersionSchema.optional(),
  expected_generation: roomWorkGenerationSchema.optional()
}).strict();
const Output = roomWorkControlValueSchema;

export type RoomWorkAssigneeStopInput = z.infer<typeof Input>;
export interface RoomWorkAssigneeStopPorts {
  stopRoomWorkAssignee(context: TrustedDomainContext, input: { roomId: string; workId: string; assigneeId: string; reason?: string; expectedVersion?: number; expectedGeneration?: number }): Promise<z.infer<typeof Output>>;
}

const roomWorkAssigneeStop = defineCommand<RoomWorkAssigneeStopPorts>()({
  id: "room.work.assignee.stop", version: "1.0", availability: "active", title: "Stop Room work assignee",
  description: "Request and track stopping one assigned Agent work and its descendants.",
  sources: ["runtime_api", "surface_operation"], effect: "workspace_mutation", idempotency: "required", concurrency: "state_transition",
  render: ["status_timeline"], resourceKinds: ["room_work", "room_work_assignee", "room_work_control"],
  proposedEffects: ["Stop one Room work assignee and its descendants."], outputResourceKind: "room_work_control", uiDisplayCategory: "room",
  provenance: [{ source: "samurai", commit_sha: "room-agent-collaboration-v1", reference_file: "docs/designs/room-agent-work.md", decision: "adapted", reason: "Individual control is isolated to the selected assignee and does not stop unrelated work." }],
  input: Input, output: Output,
  createHandler(ports) {
    return { execute: async function handleRoomWorkAssigneeStop(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
      const value = await ports.stopRoomWorkAssignee(context, {
        roomId: requireRoomContext(context, "room.work.assignee.stop"),
        workId: input.work_id,
        assigneeId: input.assignee_id,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
        ...(input.expected_version === undefined ? {} : { expectedVersion: input.expected_version }),
        ...(input.expected_generation === undefined ? {} : { expectedGeneration: input.expected_generation })
      });
      return { ok: true, value: Output.parse(value) };
    } };
  }
});

export default roomWorkAssigneeStop;
