import { z } from "zod";
import { defineCommand, requireRoomContext, type DomainResult, type TrustedDomainContext } from "../../definition/index.js";
import { roomWorkControlValueSchema, roomWorkGenerationSchema, roomWorkVersionSchema } from "./work-contracts.js";

const Input = z.object({
  work_id: z.string().trim().min(1).max(512),
  reason: z.string().trim().min(1).max(2_000).optional(),
  expected_version: roomWorkVersionSchema.optional(),
  expected_generation: roomWorkGenerationSchema.optional()
}).strict();
const Output = roomWorkControlValueSchema;

export type RoomWorkStopInput = z.infer<typeof Input>;
export interface RoomWorkStopPorts {
  stopRoomWork(context: TrustedDomainContext, input: { roomId: string; workId: string; reason?: string; expectedVersion?: number; expectedGeneration?: number }): Promise<z.infer<typeof Output>>;
}

const roomWorkStop = defineCommand<RoomWorkStopPorts>()({
  id: "room.work.stop", version: "1.0", availability: "active", title: "Stop Room work",
  description: "Request and track stopping all assignees of one Room work.",
  sources: ["runtime_api", "surface_operation"], effect: "workspace_mutation", idempotency: "required", concurrency: "state_transition",
  render: ["status_timeline"], resourceKinds: ["room_work", "room_work_assignee", "room_work_control"],
  proposedEffects: ["Stop a Room work and its descendant assignments."], outputResourceKind: "room_work_control", uiDisplayCategory: "room",
  provenance: [{ source: "samurai", commit_sha: "room-agent-collaboration-v1", reference_file: "docs/designs/room-agent-work.md", decision: "adapted", reason: "A stop request is distinct from terminal stop evidence and remains visible until all assignees are confirmed." }],
  input: Input, output: Output,
  createHandler(ports) {
    return { execute: async function handleRoomWorkStop(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
      const value = await ports.stopRoomWork(context, {
        roomId: requireRoomContext(context, "room.work.stop"),
        workId: input.work_id,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
        ...(input.expected_version === undefined ? {} : { expectedVersion: input.expected_version }),
        ...(input.expected_generation === undefined ? {} : { expectedGeneration: input.expected_generation })
      });
      return { ok: true, value: Output.parse(value) };
    } };
  }
});

export default roomWorkStop;
