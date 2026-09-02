import { z } from "zod";
import { defineCommand, publicContractHandler, type OrganizationRequestContext } from "../../definition/index.js";
import { accountIdSchema, organizationIdSchema, organizationInvitationIssueResultSchema, organizationRoleSchema, workspaceIdSchema, workspaceMembershipRoleSchema } from "../../value-objects/organization.js";

const workspaceGrantSchema = z.object({ workspace_id: workspaceIdSchema, role: workspaceMembershipRoleSchema.exclude(["owner"]) }).strict();
const Input = z.object({
  organization_id: organizationIdSchema,
  target_account_id: accountIdSchema.optional(),
  role: organizationRoleSchema,
  workspace_grants: z.array(workspaceGrantSchema).max(100).default([]),
  expires_at: z.string().datetime().optional()
}).strict();
const Output = organizationInvitationIssueResultSchema;
export interface OrganizationMemberInvitePorts { inviteOrganizationMember(context: OrganizationRequestContext, input: z.infer<typeof Input>): Promise<z.infer<typeof Output>>; }

const organizationMemberInvite = defineCommand<OrganizationMemberInvitePorts>()({
  id: "organization.member.invite", version: "1.0", availability: "active", title: "Invite Organization member", description: "Issue a direct or one-time Organization invitation with optional Workspace grants.",
  sources: ["runtime_api"], effect: "workspace_mutation", idempotency: "required", concurrency: "append_or_unique", render: ["status_timeline"], resourceKinds: ["organization_invitation", "organization_membership"], proposedEffects: ["Invite an Organization member."], outputResourceKind: "organization_invitation", uiDisplayCategory: "organization",
  provenance: [{ source: "samurai", commit_sha: "phase-2-organization", reference_file: "docs/designs/organization.md", decision: "adopted", reason: "Raw token is returned only as an ephemeral issue result and never belongs to the persisted or Event projection." }],
  input: Input, output: Output,
  createHandler(_ports) { return publicContractHandler<z.infer<typeof Input>, z.infer<typeof Output>>("organization.member.invite"); }
});
export default organizationMemberInvite;
