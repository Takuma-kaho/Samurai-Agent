import { z } from "zod";
import { defineCommand, requireRoomContext, type DomainResult, type TrustedDomainContext } from "../../definition/index.js";
import { roomWorkAttachmentSchema, roomWorkValueSchema } from "./work-contracts.js";

const Input = z.object({
  instruction: z.string().trim().min(1).max(1_000_000).optional(),
  attachments: z.array(roomWorkAttachmentSchema).max(100).default([]),
  agent_id: z.string().trim().min(1).max(512).optional()
}).strict().superRefine((input, issue) => {
  if (!input.instruction && input.attachments.length === 0) {
    issue.addIssue({ code: z.ZodIssueCode.custom, path: ["instruction"], message: "room_work_requires_instruction_or_attachment" });
  }
});
const Output = roomWorkValueSchema;

export type RoomWorkCreateInput = z.infer<typeof Input>;
export interface RoomWorkCreatePorts {
  createRoomWork(context: TrustedDomainContext, input: {
    roomId: string;
    instruction?: string;
    attachments: z.infer<typeof Input>["attachments"];
    agentId?: string;
  }): Promise<z.infer<typeof Output>>;
}

const roomWorkCreate = defineCommand<RoomWorkCreatePorts>()({
  id: "room.work.create", version: "1.0", availability: "active", title: "Create Room work",
  description: "Create one Room work from an instruction or Server-issued attachments and queue its first assignee.",
  sources: ["runtime_api", "surface_operation"], effect: "workspace_mutation", idempotency: "required", concurrency: "append_or_unique",
  render: ["status_timeline"], resourceKinds: ["room", "room_work", "room_work_assignee", "room_work_instruction"],
  proposedEffects: ["Create a Room work and its initial Agent assignment."], outputResourceKind: "room_work", uiDisplayCategory: "room",
  provenance: [{ source: "samurai", commit_sha: "room-agent-collaboration-v1", reference_file: "docs/designs/room-agent-work.md", decision: "adapted", reason: "Make a normal Room request an atomic work aggregate instead of exposing Session creation." }],
  input: Input, output: Output,
  createHandler(ports) {
    return { execute: async function handleRoomWorkCreate(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
      const roomId = requireRoomContext(context, "room.work.create");
      const value = await ports.createRoomWork(context, {
        roomId,
        ...(input.instruction === undefined ? {} : { instruction: input.instruction }),
        attachments: input.attachments,
        ...(input.agent_id === undefined ? {} : { agentId: input.agent_id })
      });
      return { ok: true, value: Output.parse(value) };
    } };
  }
});

export default roomWorkCreate;
