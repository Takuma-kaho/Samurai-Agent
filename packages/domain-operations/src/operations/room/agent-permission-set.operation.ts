import { z } from "zod";
import { defineCommand, type DomainResult, type TrustedDomainContext } from "../../definition/index.js";
import { roomAgentPermissionValueSchema } from "../../value-objects/room-permissions.js";

const Input = z.object({ room_id: z.string().trim().min(1), agent_id: z.string().trim().min(1), can_view: z.boolean(), can_edit: z.boolean(), can_execute: z.boolean() }).strict().refine((value) => !value.can_edit && !value.can_execute || value.can_view, "room_agent_view_required");
const Output = roomAgentPermissionValueSchema;
export interface RoomAgentPermissionSetPorts { setRoomAgentPermissions(context: TrustedDomainContext, input: { roomId: string; agentId: string; canView: boolean; canEdit: boolean; canExecute: boolean }): Promise<z.infer<typeof Output>>; }
const roomAgentPermissionSet = defineCommand<RoomAgentPermissionSetPorts>()({
  id: "room.agent.permission.set", version: "1.0", availability: "active", title: "Set Room Agent permission", description: "Set an Agent's individual Room view, edit, and execute permissions.",
  sources: ["runtime_api"], effect: "workspace_mutation", idempotency: "required", concurrency: "state_transition", render: ["status_timeline"], resourceKinds: ["room_agent"], proposedEffects: ["Change Room Agent permissions."], outputResourceKind: "room_agent", uiDisplayCategory: "workspace",
  provenance: [{ source: "samurai", commit_sha: "core-06", reference_file: "SAMURAI_AGENT_MANUAL.md", decision: "adapted", reason: "Agents do not occupy the human role hierarchy." }], input: Input, output: Output,
  createHandler(ports) { return { execute: async function handleRoomAgentPermissionSet(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> { return { ok: true, value: Output.parse(await ports.setRoomAgentPermissions(context, { roomId: input.room_id, agentId: input.agent_id, canView: input.can_view, canEdit: input.can_edit, canExecute: input.can_execute })) }; } }; }
});
export default roomAgentPermissionSet;
