import { z } from "zod";
import { defineCommand, publicContractHandler, type OrganizationRequestContext } from "../../definition/index.js";
import { accountIdSchema, organizationIdSchema, organizationWorkspaceMembershipRecordSchema, workspaceIdSchema } from "../../value-objects/organization.js";

const Input = z.object({ organization_id: organizationIdSchema, workspace_id: workspaceIdSchema, target_account_id: accountIdSchema, expected_version: z.number().int().positive().optional() }).strict();
const Output = organizationWorkspaceMembershipRecordSchema;
export interface OrganizationWorkspaceMemberRevokePorts { revokeOrganizationWorkspaceMembership(context: OrganizationRequestContext, input: z.infer<typeof Input>): Promise<z.infer<typeof Output>>; }

const organizationWorkspaceMemberRevoke = defineCommand<OrganizationWorkspaceMemberRevokePorts>()({
  id: "organization.workspace.member.revoke", version: "1.0", availability: "active", title: "Revoke Workspace membership", description: "Revoke Workspace content access while retaining Organization membership and history.",
  sources: ["runtime_api"], effect: "workspace_mutation", idempotency: "required", concurrency: "state_transition", render: ["status_timeline"], resourceKinds: ["workspace_membership"], proposedEffects: ["Revoke Workspace membership."], outputResourceKind: "workspace_membership", uiDisplayCategory: "workspace",
  provenance: [{ source: "samurai", commit_sha: "phase-2-organization", reference_file: "docs/designs/organization.md", decision: "adopted", reason: "Revoking Workspace access must not delete or expose Room content and must be version checked." }],
  input: Input, output: Output,
  createHandler(_ports) { return publicContractHandler<z.infer<typeof Input>, z.infer<typeof Output>>("organization.workspace.member.revoke"); }
});
export default organizationWorkspaceMemberRevoke;
