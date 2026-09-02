import { z } from "zod";
import { defineCommand, publicContractHandler, type OrganizationRequestContext } from "../../definition/index.js";
import { accountIdSchema, organizationIdSchema, organizationWorkspaceMembershipRecordSchema, workspaceIdSchema, workspaceMembershipRoleSchema } from "../../value-objects/organization.js";

const Input = z.object({ organization_id: organizationIdSchema, workspace_id: workspaceIdSchema, target_account_id: accountIdSchema, role: workspaceMembershipRoleSchema.exclude(["owner"]) }).strict();
const Output = organizationWorkspaceMembershipRecordSchema;
export interface OrganizationWorkspaceMemberGrantPorts { grantOrganizationWorkspaceMembership(context: OrganizationRequestContext, input: z.infer<typeof Input>): Promise<z.infer<typeof Output>>; }

const organizationWorkspaceMemberGrant = defineCommand<OrganizationWorkspaceMemberGrantPorts>()({
  id: "organization.workspace.member.grant", version: "1.0", availability: "active", title: "Grant Workspace membership", description: "Grant an existing Organization member access to a Workspace without changing Room permissions.",
  sources: ["runtime_api"], effect: "workspace_mutation", idempotency: "required", concurrency: "append_or_unique", render: ["status_timeline"], resourceKinds: ["workspace_membership"], proposedEffects: ["Grant Workspace membership."], outputResourceKind: "workspace_membership", uiDisplayCategory: "workspace",
  provenance: [{ source: "samurai", commit_sha: "phase-2-organization", reference_file: "docs/designs/organization.md", decision: "adopted", reason: "Organization and Workspace membership are separate access boundaries; Room access is unchanged." }],
  input: Input, output: Output,
  createHandler(_ports) { return publicContractHandler<z.infer<typeof Input>, z.infer<typeof Output>>("organization.workspace.member.grant"); }
});
export default organizationWorkspaceMemberGrant;
