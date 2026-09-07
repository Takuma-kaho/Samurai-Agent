import { z } from "zod";
import { defineQuery, requireRoomContext, type DomainQueryPorts, type DomainResult, type ReadCapability, type TrustedDomainContext } from "../../definition/index.js";
import { roomWorkStatusSchema, roomWorkValueSchema } from "./work-contracts.js";

const Input = z.object({
  status: roomWorkStatusSchema.optional(),
  cursor: z.string().trim().min(1).max(512).optional(),
  limit: z.number().int().positive().max(200).default(50)
}).strict();
const Output = z.array(roomWorkValueSchema).max(10_000);

export type RoomWorkListInput = z.infer<typeof Input>;
export interface RoomWorkListPorts extends DomainQueryPorts {
  listRoomWorks: ReadCapability<(context: TrustedDomainContext, input: { roomId: string; status?: z.infer<typeof roomWorkStatusSchema>; cursor?: string; limit: number }) => Promise<z.infer<typeof Output>>>;
}

const roomWorkList = defineQuery<RoomWorkListPorts>()({
  id: "room.work.list", version: "1.0", availability: "active", title: "List Room work",
  description: "List the current Room's work projections without exposing Session records.",
  sources: ["runtime_api", "external_app"], render: ["table", "status_timeline"], resourceKinds: ["room_work", "room_work_assignee"],
  proposedEffects: ["Read Room work projections."], outputResourceKind: "room_work", uiDisplayCategory: "room",
  provenance: [{ source: "samurai", commit_sha: "room-agent-collaboration-v1", reference_file: "docs/designs/room-agent-work.md", decision: "adapted", reason: "Room is the public work surface while Session remains an internal continuation reference." }],
  input: Input, output: Output,
  createHandler(ports) {
    return { execute: async function handleRoomWorkList(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
      const value = await ports.listRoomWorks(context, {
        roomId: requireRoomContext(context, "room.work.list"),
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        limit: input.limit
      });
      return { ok: true, value: Output.parse(value) };
    } };
  }
});

export default roomWorkList;
