import { z } from "zod";
import { defineCommand, requireRoomContext, type DomainResult, type TrustedDomainContext } from "../../definition/index.js";
import { roomWorkGenerationSchema, roomWorkInstructionValueSchema, roomWorkVersionSchema } from "./work-contracts.js";

const Input = z.object({
  work_id: z.string().trim().min(1).max(512),
  comment_id: z.string().trim().min(1).max(512),
  comment_version: roomWorkVersionSchema,
  expected_version: roomWorkVersionSchema.optional(),
  expected_generation: roomWorkGenerationSchema.optional(),
  assignee_id: z.string().trim().min(1).max(512).optional()
}).strict();
const Output = roomWorkInstructionValueSchema;

export type RoomWorkCommentApplyInput = z.infer<typeof Input>;
export interface RoomWorkCommentApplyPorts {
  applyRoomWorkComment(context: TrustedDomainContext, input: {
    roomId: string;
    workId: string;
    commentId: string;
    commentVersion: number;
    expectedVersion?: number;
    expectedGeneration?: number;
    assigneeId?: string;
  }): Promise<z.infer<typeof Output>>;
}

const roomWorkCommentApply = defineCommand<RoomWorkCommentApplyPorts>()({
  id: "room.work.comment.apply", version: "1.0", availability: "active", title: "Apply Room work comment",
  description: "Turn one selected comment snapshot into an explicit, versioned Room work instruction.",
  sources: ["runtime_api", "surface_operation"], effect: "workspace_mutation", idempotency: "required", concurrency: "optimistic_version",
  render: ["status_timeline"], resourceKinds: ["room_work", "room_work_comment", "room_work_instruction", "room_work_assignee"],
  proposedEffects: ["Apply a selected human comment as a Room work instruction."], outputResourceKind: "room_work_instruction", uiDisplayCategory: "room",
  provenance: [{ source: "samurai", commit_sha: "room-agent-collaboration-v1", reference_file: "docs/designs/room-agent-work.md", decision: "adapted", reason: "Apply requires a server-loaded comment version and never trusts an inline comment body." }],
  input: Input, output: Output,
  createHandler(ports) {
    return { execute: async function handleRoomWorkCommentApply(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
      const value = await ports.applyRoomWorkComment(context, {
        roomId: requireRoomContext(context, "room.work.comment.apply"),
        workId: input.work_id,
        commentId: input.comment_id,
        commentVersion: input.comment_version,
        ...(input.expected_version === undefined ? {} : { expectedVersion: input.expected_version }),
        ...(input.expected_generation === undefined ? {} : { expectedGeneration: input.expected_generation }),
        ...(input.assignee_id === undefined ? {} : { assigneeId: input.assignee_id })
      });
      return { ok: true, value: Output.parse(value) };
    } };
  }
});

export default roomWorkCommentApply;
