import { z } from "zod";
import { defineCommand, type DomainResult, type TrustedDomainContext } from "../../definition/index.js";
import { humanParticipantIdSchema, workspaceMemberValueSchema, workspaceRoleSchema } from "../../value-objects/room-permissions.js";

const Input = z.object({ target_participant_id: humanParticipantIdSchema, role: workspaceRoleSchema.exclude(["owner"]) }).strict();
const Output = workspaceMemberValueSchema;
export interface WorkspaceMemberAddPorts { addWorkspaceMember(context: TrustedDomainContext, input: { participantId: string; role: z.infer<typeof Input>["role"] }): Promise<z.infer<typeof Output>>; }
const workspaceMemberAdd = defineCommand<WorkspaceMemberAddPorts>()({
  id: "workspace.member.add", version: "1.1", availability: "active", title: "Add Workspace member", description: "Add a human Workspace member without granting Room access.",
  sources: ["runtime_api"], effect: "workspace_mutation", idempotency: "required", concurrency: "append_or_unique", render: ["status_timeline"], resourceKinds: ["workspace_member"], proposedEffects: ["Add a Workspace member."], outputResourceKind: "workspace_member", uiDisplayCategory: "workspace",
  provenance: [{ source: "samurai", commit_sha: "core-06", reference_file: "ARCHITECTURE.md", decision: "adapted", reason: "Workspace membership never implies Room visibility." }], input: Input, output: Output,
  createHandler(ports) { return { execute: async function handleWorkspaceMemberAdd(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> { return { ok: true, value: Output.parse(await ports.addWorkspaceMember(context, { participantId: input.target_participant_id, role: input.role })) }; } }; }
});
export default workspaceMemberAdd;
