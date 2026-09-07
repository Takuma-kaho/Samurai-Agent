import { z } from "zod";
import { defineCommand, requireRoomContext, type DomainResult, type TrustedDomainContext } from "../../definition/index.js";
import { roomWorkAssigneeValueSchema, roomWorkAttachmentSchema, roomWorkGenerationSchema, roomWorkVersionSchema } from "./work-contracts.js";

const Input = z.object({
  work_id: z.string().trim().min(1).max(512),
  assignee_id: z.string().trim().min(1).max(512),
  agent_id: z.string().trim().min(1).max(512),
  instruction: z.string().trim().min(1).max(1_000_000),
  dependency_assignee_ids: z.array(z.string().trim().min(1).max(512)).max(100).default([]),
  attachments: z.array(roomWorkAttachmentSchema).max(100).default([]),
  expected_version: roomWorkVersionSchema.optional(),
  expected_generation: roomWorkGenerationSchema.optional()
}).strict();
const Output = roomWorkAssigneeValueSchema;

export type RoomWorkAssigneeDelegateInput = z.infer<typeof Input>;
export interface RoomWorkAssigneeDelegatePorts {
  delegateRoomWorkAssignee(context: TrustedDomainContext, input: {
    roomId: string;
    workId: string;
    assigneeId: string;
    agentId: string;
    instruction: string;
    dependencyAssigneeIds: string[];
    attachments: z.infer<typeof Input>["attachments"];
    expectedVersion?: number;
    expectedGeneration?: number;
  }): Promise<z.infer<typeof Output>>;
}

const roomWorkAssigneeDelegate = defineCommand<RoomWorkAssigneeDelegatePorts>()({
  id: "room.work.assignee.delegate", version: "1.0", availability: "active", title: "Delegate Room work",
  description: "Create a bounded child assignment and launch reservation for the selected Agent.",
  sources: ["runtime_api", "surface_operation", "provider_tool_call"], effect: "workspace_mutation", idempotency: "required", concurrency: "append_or_unique",
  providerToolNames: ["subagent_delegate", "samurai.room.work.assignee.delegate", "mcp__samurai__room_work_assignee_delegate"],
  render: ["status_timeline"], resourceKinds: ["room_work", "room_work_assignee", "room_work_instruction", "room_work_execution_reservation"],
  proposedEffects: ["Create one child Agent assignment with a durable delegated instruction and launch reservation."], outputResourceKind: "room_work_assignee", uiDisplayCategory: "room",
  provenance: [{ source: "samurai", commit_sha: "room-agent-collaboration-v1", reference_file: "docs/designs/room-agent-work.md", decision: "adapted", reason: "Delegation is an atomic child-assignment transition within one Room Work and cannot trust model-supplied authority fields." }],
  input: Input, output: Output,
  createHandler(ports) {
    return { execute: async function handleRoomWorkAssigneeDelegate(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
      const value = await ports.delegateRoomWorkAssignee(context, {
        roomId: requireRoomContext(context, "room.work.assignee.delegate"),
        workId: input.work_id,
        assigneeId: input.assignee_id,
        agentId: input.agent_id,
        instruction: input.instruction,
        dependencyAssigneeIds: input.dependency_assignee_ids,
        attachments: input.attachments,
        ...(input.expected_version === undefined ? {} : { expectedVersion: input.expected_version }),
        ...(input.expected_generation === undefined ? {} : { expectedGeneration: input.expected_generation })
      });
      return { ok: true, value: Output.parse(value) };
    } };
  }
});

export default roomWorkAssigneeDelegate;
