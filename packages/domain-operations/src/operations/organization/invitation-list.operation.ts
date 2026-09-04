import { z } from "zod";
import { defineQuery, publicContractHandler, type DomainQueryPorts, type OrganizationRequestContext, type ReadCapability } from "../../definition/index.js";
import { organizationIdSchema, organizationInvitationRecordSchema, paginationInputSchema } from "../../value-objects/organization.js";

const Input = paginationInputSchema.extend({ organization_id: organizationIdSchema, include_resolved: z.boolean().optional() }).strict();
const Output = z.array(organizationInvitationRecordSchema);
export interface OrganizationInvitationListPorts extends DomainQueryPorts { listOrganizationInvitations: ReadCapability<(context: OrganizationRequestContext, input: z.infer<typeof Input>) => Promise<z.infer<typeof Output>>>; }

const organizationInvitationList = defineQuery<OrganizationInvitationListPorts>()({
  id: "organization.invitation.list", version: "1.0", availability: "active", title: "List Organization invitations", description: "List safe Organization invitation projections without raw tokens.",
  sources: ["runtime_api"], render: ["table"], resourceKinds: ["organization_invitation"], proposedEffects: ["Read Organization invitations."], outputResourceKind: "organization_invitation", uiDisplayCategory: "organization",
  provenance: [{ source: "samurai", commit_sha: "phase-2-organization", reference_file: "docs/designs/organization.md", decision: "adopted", reason: "Invitation query results never include raw token material." }],
  input: Input, output: Output,
  createHandler(_ports) { return publicContractHandler<z.infer<typeof Input>, z.infer<typeof Output>>("organization.invitation.list"); }
});
export default organizationInvitationList;
