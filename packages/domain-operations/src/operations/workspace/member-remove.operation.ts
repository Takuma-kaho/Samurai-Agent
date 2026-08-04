import { z } from "zod";
import { defineCommand, type DomainResult, type TrustedDomainContext } from "../../definition/index.js";
import { humanParticipantIdSchema, workspaceMemberValueSchema } from "../../value-objects/room-permissions.js";

const Input = z.object({ target_participant_id: humanParticipantIdSchema }).strict();
const Output = workspaceMemberValueSchema;
export interface WorkspaceMemberRemovePorts { removeWorkspaceMember(context: TrustedDomainContext, participantId: string): Promise<z.infer<typeof Output>>; }
const workspaceMemberRemove = defineCommand<WorkspaceMemberRemovePorts>()({
  id: "workspace.member.remove", version: "1.0", availability: "active", title: "Remove Workspace member", description: "Mark a Workspace membership as removed.",
  sources: ["runtime_api"], effect: "workspace_mutation", idempotency: "required", concurrency: "state_transition", render: ["status_timeline"], resourceKinds: ["workspace_member"], proposedEffects: ["Remove a Workspace member."], outputResourceKind: "workspace_member", uiDisplayCategory: "workspace",
  provenance: [{ source: "samurai", commit_sha: "core-06", reference_file: "SAMURAI_AGENT_MANUAL.md", decision: "adapted", reason: "Removal preserves the membership history." }], input: Input, output: Output,
  createHandler(ports) { return { execute: async function handleWorkspaceMemberRemove(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> { return { ok: true, value: Output.parse(await ports.removeWorkspaceMember(context, input.target_participant_id)) }; } }; }
});
export default workspaceMemberRemove;
