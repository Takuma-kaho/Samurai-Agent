import { z } from "zod";
import { defineCommand, requireRoomContext, type DomainResult, type TrustedDomainContext } from "../../definition/index.js";
import { roomWorkAttachmentSchema, roomWorkGenerationSchema, roomWorkInstructionValueSchema, roomWorkVersionSchema } from "./work-contracts.js";

const Input = z.object({
  work_id: z.string().trim().min(1).max(512),
  assignee_id: z.string().trim().min(1).max(512).optional(),
  instruction: z.string().trim().min(1).max(1_000_000).optional(),
  attachments: z.array(roomWorkAttachmentSchema).max(100).default([]),
  expected_version: roomWorkVersionSchema.optional(),
  expected_generation: roomWorkGenerationSchema.optional()
}).strict().superRefine((input, issue) => {
  if (!input.instruction && input.attachments.length === 0) {
    issue.addIssue({ code: z.ZodIssueCode.custom, path: ["instruction"], message: "room_work_reply_requires_instruction_or_attachment" });
  }
});
const Output = roomWorkInstructionValueSchema;

export type RoomWorkReplyInput = z.infer<typeof Input>;
export interface RoomWorkReplyPorts {
  replyToRoomWork(context: TrustedDomainContext, input: {
    roomId: string;
    workId: string;
    assigneeId?: string;
    instruction?: string;
    attachments: z.infer<typeof Input>["attachments"];
    expectedVersion?: number;
    expectedGeneration?: number;
  }): Promise<z.infer<typeof Output>>;
}

const roomWorkReply = defineCommand<RoomWorkReplyPorts>()({
  id: "room.work.reply", version: "1.0", availability: "active", title: "Reply to Room work",
  description: "Add a new version of the instruction to an existing Room work without exposing a Session.",
  sources: ["runtime_api", "surface_operation"], effect: "workspace_mutation", idempotency: "required", concurrency: "optimistic_version",
  render: ["status_timeline"], resourceKinds: ["room_work", "room_work_instruction", "room_work_assignee"],
  proposedEffects: ["Append an instruction version to an existing Room work."], outputResourceKind: "room_work_instruction", uiDisplayCategory: "room",
  provenance: [{ source: "samurai", commit_sha: "room-agent-collaboration-v1", reference_file: "docs/designs/room-agent-work.md", decision: "adapted", reason: "Keep additional instructions distinct from a new work and from human comments." }],
  input: Input, output: Output,
  createHandler(ports) {
    return { execute: async function handleRoomWorkReply(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
      const value = await ports.replyToRoomWork(context, {
        roomId: requireRoomContext(context, "room.work.reply"),
        workId: input.work_id,
        ...(input.assignee_id === undefined ? {} : { assigneeId: input.assignee_id }),
        ...(input.instruction === undefined ? {} : { instruction: input.instruction }),
        attachments: input.attachments,
        ...(input.expected_version === undefined ? {} : { expectedVersion: input.expected_version }),
        ...(input.expected_generation === undefined ? {} : { expectedGeneration: input.expected_generation })
      });
      return { ok: true, value: Output.parse(value) };
    } };
  }
});

export default roomWorkReply;
