import { z } from "zod";
import { defineQuery, requireRoomContext, type DomainQueryPorts, type DomainResult, type ReadCapability, type TrustedDomainContext } from "../../definition/index.js";
import { roomWorkViewValueSchema } from "./work-contracts.js";

const Input = z.object({ work_id: z.string().trim().min(1).max(512) }).strict();
const Output = roomWorkViewValueSchema;

export type RoomWorkViewInput = z.infer<typeof Input>;
export interface RoomWorkViewPorts extends DomainQueryPorts {
  viewRoomWork: ReadCapability<(context: TrustedDomainContext, input: { roomId: string; workId: string }) => Promise<z.infer<typeof Output>>>;
}

const roomWorkView = defineQuery<RoomWorkViewPorts>()({
  id: "room.work.view", version: "1.0", availability: "active", title: "View Room work",
  description: "Read one Room work with its assigned work, instruction, comment, and control projections.",
  sources: ["runtime_api", "external_app"], render: ["status_timeline", "run_history"], resourceKinds: ["room_work", "room_work_assignee", "room_work_instruction", "room_work_comment", "room_work_control"],
  proposedEffects: ["Read one Room work projection."], outputResourceKind: "room_work", uiDisplayCategory: "room",
  provenance: [{ source: "samurai", commit_sha: "room-agent-collaboration-v1", reference_file: "docs/designs/room-agent-work.md", decision: "adapted", reason: "Expose the public aggregate without leaking Backend Session or diagnostic internals." }],
  input: Input, output: Output,
  createHandler(ports) {
    return { execute: async function handleRoomWorkView(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
      const value = await ports.viewRoomWork(context, { roomId: requireRoomContext(context, "room.work.view"), workId: input.work_id });
      return { ok: true, value: Output.parse(value) };
    } };
  }
});

export default roomWorkView;
