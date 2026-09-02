import { z } from "zod";
import { defineCommand, publicContractHandler, type OrganizationRequestContext } from "../../definition/index.js";
import { organizationIdSchema, organizationMembershipRecordSchema, organizationWorkspaceMembershipRecordSchema, operationIdSchema } from "../../value-objects/organization.js";

const Input = z.object({
  token: z.string().trim().min(1).max(2_048),
  invitation_id: operationIdSchema.optional(),
  organization_id: organizationIdSchema.optional()
}).strict();
const Output = z.object({ membership: organizationMembershipRecordSchema, workspace_grants: z.array(organizationWorkspaceMembershipRecordSchema).max(100) }).strict();
export interface OrganizationMemberAcceptPorts { acceptOrganizationInvitation(context: OrganizationRequestContext, input: z.infer<typeof Input>): Promise<z.infer<typeof Output>>; }

const organizationMemberAccept = defineCommand<OrganizationMemberAcceptPorts>()({
  id: "organization.member.accept", version: "1.0", availability: "active", title: "Accept Organization invitation", description: "Accept a valid one-time Organization invitation idempotently.",
  sources: ["runtime_api"], effect: "workspace_mutation", idempotency: "required", concurrency: "append_or_unique", render: ["status_timeline"], resourceKinds: ["organization_membership", "organization_workspace_membership"], proposedEffects: ["Accept an Organization invitation."], outputResourceKind: "organization_membership", uiDisplayCategory: "organization",
  provenance: [{ source: "samurai", commit_sha: "phase-2-organization", reference_file: "docs/designs/organization.md", decision: "adopted", reason: "Invitation acceptance creates Organization membership and optional Workspace grants without exposing Room content." }],
  input: Input, output: Output,
  createHandler(_ports) { return publicContractHandler<z.infer<typeof Input>, z.infer<typeof Output>>("organization.member.accept"); }
});
export default organizationMemberAccept;
