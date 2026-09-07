import { z } from "zod";
import { defineCommand, requireRoomContext, type DomainResult, type TrustedDomainContext } from "../../definition/index.js";
import { roomWorkReactionValueSchema, roomWorkVersionSchema } from "./work-contracts.js";

const Input = z.object({
  work_id: z.string().trim().min(1).max(512),
  comment_id: z.string().trim().min(1).max(512),
  reaction: z.literal("like"),
  enabled: z.boolean(),
  expected_version: roomWorkVersionSchema.optional()
}).strict();
const Output = roomWorkReactionValueSchema;

export type RoomWorkCommentReactionSetInput = z.infer<typeof Input>;
export interface RoomWorkCommentReactionSetPorts {
  setRoomWorkCommentReaction(context: TrustedDomainContext, input: {
    roomId: string;
    workId: string;
    commentId: string;
    reaction: "like";
    enabled: boolean;
    expectedVersion?: number;
  }): Promise<z.infer<typeof Output>>;
}

const roomWorkCommentReactionSet = defineCommand<RoomWorkCommentReactionSetPorts>()({
  id: "room.work.comment.reaction.set", version: "1.0", availability: "active", title: "Set Room work comment reaction",
  description: "Set or clear a human like on a Room work comment without approving or executing it.",
  sources: ["runtime_api", "surface_operation"], effect: "workspace_mutation", idempotency: "required", concurrency: "optimistic_version",
  render: ["status_timeline"], resourceKinds: ["room_work", "room_work_comment", "room_work_reaction"],
  proposedEffects: ["Set one human reaction on a Room work comment."], outputResourceKind: "room_work_reaction", uiDisplayCategory: "room",
  provenance: [{ source: "samurai", commit_sha: "room-agent-collaboration-v1", reference_file: "docs/designs/room-agent-work.md", decision: "adapted", reason: "Reactions remain human discussion state and never become an Agent instruction or approval." }],
  input: Input, output: Output,
  createHandler(ports) {
    return { execute: async function handleRoomWorkCommentReactionSet(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
      const value = await ports.setRoomWorkCommentReaction(context, {
        roomId: requireRoomContext(context, "room.work.comment.reaction.set"),
        workId: input.work_id,
        commentId: input.comment_id,
        reaction: input.reaction,
        enabled: input.enabled,
        ...(input.expected_version === undefined ? {} : { expectedVersion: input.expected_version })
      });
      return { ok: true, value: Output.parse(value) };
    } };
  }
});

export default roomWorkCommentReactionSet;
