import { z } from "zod";
import { defineCommand, type DomainResult, type TrustedDomainContext } from "../../definition/index.js";
import { humanParticipantIdSchema, workspaceMemberValueSchema } from "../../value-objects/room-permissions.js";

const Input = z.object({ to_participant_id: humanParticipantIdSchema }).strict();
const Output = z.object({ previous_owner: workspaceMemberValueSchema, owner: workspaceMemberValueSchema }).strict();
export interface WorkspaceOwnerTransferPorts { transferWorkspaceOwnership(context: TrustedDomainContext, toParticipantId: string): Promise<{ previousOwner: z.infer<typeof workspaceMemberValueSchema>; owner: z.infer<typeof workspaceMemberValueSchema> }>; }
const workspaceOwnerTransfer = defineCommand<WorkspaceOwnerTransferPorts>()({
  id: "workspace.owner.transfer", version: "1.1", availability: "active", title: "Transfer Workspace ownership", description: "Atomically transfer the single Workspace Owner.",
  sources: ["runtime_api"], effect: "workspace_mutation", idempotency: "required", concurrency: "state_transition", render: ["status_timeline"], resourceKinds: ["workspace_member"], proposedEffects: ["Transfer Workspace ownership."], outputResourceKind: "workspace_member", uiDisplayCategory: "workspace",
  provenance: [{ source: "samurai", commit_sha: "core-06", reference_file: "ARCHITECTURE.md", decision: "adapted", reason: "Ownership is transferred in one PostgreSQL transaction." }], input: Input, output: Output,
  createHandler(ports) { return { execute: async function handleWorkspaceOwnerTransfer(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> { const value = await ports.transferWorkspaceOwnership(context, input.to_participant_id); return { ok: true, value: Output.parse({ previous_owner: value.previousOwner, owner: value.owner }) }; } }; }
});
export default workspaceOwnerTransfer;
