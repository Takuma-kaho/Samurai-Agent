import { z } from "zod";
import { defineCommand, type DomainResult, type TrustedDomainContext } from "../../definition/index.js";
import { humanParticipantIdSchema, workspaceMemberValueSchema, workspaceRoleSchema } from "../../value-objects/room-permissions.js";

const Input = z.object({ target_participant_id: humanParticipantIdSchema, role: workspaceRoleSchema.exclude(["owner"]) }).strict();
const Output = workspaceMemberValueSchema;
export interface WorkspaceMemberRoleChangePorts { changeWorkspaceMemberRole(context: TrustedDomainContext, input: { participantId: string; role: z.infer<typeof Input>["role"] }): Promise<z.infer<typeof Output>>; }
const workspaceMemberRoleChange = defineCommand<WorkspaceMemberRoleChangePorts>()({
  id: "workspace.member.role.change", version: "1.0", availability: "active", title: "Change Workspace member role", description: "Change a non-owner Workspace role.",
  sources: ["runtime_api"], effect: "workspace_mutation", idempotency: "required", concurrency: "state_transition", render: ["status_timeline"], resourceKinds: ["workspace_member"], proposedEffects: ["Change a Workspace member role."], outputResourceKind: "workspace_member", uiDisplayCategory: "workspace",
  provenance: [{ source: "samurai", commit_sha: "core-06", reference_file: "SAMURAI_AGENT_MANUAL.md", decision: "adapted", reason: "Owner transfer has a separate atomic operation." }], input: Input, output: Output,
  createHandler(ports) { return { execute: async function handleWorkspaceMemberRoleChange(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> { return { ok: true, value: Output.parse(await ports.changeWorkspaceMemberRole(context, { participantId: input.target_participant_id, role: input.role })) }; } }; }
});
export default workspaceMemberRoleChange;
