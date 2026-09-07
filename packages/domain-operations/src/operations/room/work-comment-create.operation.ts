import { z } from "zod";
import { defineCommand, requireRoomContext, type DomainResult, type TrustedDomainContext } from "../../definition/index.js";
import { roomWorkAttachmentSchema, roomWorkCommentValueSchema, roomWorkVersionSchema } from "./work-contracts.js";

const Input = z.object({
  work_id: z.string().trim().min(1).max(512),
  body: z.string().max(100_000).optional(),
  attachments: z.array(roomWorkAttachmentSchema).max(100).default([]),
  expected_version: roomWorkVersionSchema.optional()
}).strict().superRefine((input, issue) => {
  if (!input.body?.trim() && input.attachments.length === 0) {
    issue.addIssue({ code: z.ZodIssueCode.custom, path: ["body"], message: "room_work_comment_requires_body_or_attachment" });
  }
});
const Output = roomWorkCommentValueSchema;

export type RoomWorkCommentCreateInput = z.infer<typeof Input>;
export interface RoomWorkCommentCreatePorts {
  createRoomWorkComment(context: TrustedDomainContext, input: {
    roomId: string;
    workId: string;
    body?: string;
    attachments: z.infer<typeof Input>["attachments"];
    expectedVersion?: number;
  }): Promise<z.infer<typeof Output>>;
}

const roomWorkCommentCreate = defineCommand<RoomWorkCommentCreatePorts>()({
  id: "room.work.comment.create", version: "1.0", availability: "active", title: "Comment on Room work",
  description: "Post a human comment on a Room work without starting or steering an Agent.",
  sources: ["runtime_api", "surface_operation"], effect: "workspace_mutation", idempotency: "required", concurrency: "append_or_unique",
  render: ["status_timeline"], resourceKinds: ["room_work", "room_work_comment"],
  proposedEffects: ["Create a human discussion comment on a Room work."], outputResourceKind: "room_work_comment", uiDisplayCategory: "room",
  provenance: [{ source: "samurai", commit_sha: "room-agent-collaboration-v1", reference_file: "docs/designs/room-agent-work.md", decision: "adapted", reason: "Comments are stored separately and do not implicitly become Agent instructions." }],
  input: Input, output: Output,
  createHandler(ports) {
    return { execute: async function handleRoomWorkCommentCreate(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
      const value = await ports.createRoomWorkComment(context, {
        roomId: requireRoomContext(context, "room.work.comment.create"),
        workId: input.work_id,
        ...(input.body === undefined ? {} : { body: input.body }),
        attachments: input.attachments,
        ...(input.expected_version === undefined ? {} : { expectedVersion: input.expected_version })
      });
      return { ok: true, value: Output.parse(value) };
    } };
  }
});

export default roomWorkCommentCreate;
