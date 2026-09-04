import { z } from "zod";
import { defineQuery, publicContractHandler, type DomainQueryPorts, type OrganizationRequestContext, type ReadCapability } from "../../definition/index.js";
import { organizationIdSchema, organizationMembershipRecordSchema, paginationInputSchema } from "../../value-objects/organization.js";

const Input = paginationInputSchema.extend({ organization_id: organizationIdSchema, include_removed: z.boolean().optional() }).strict();
const Output = z.array(organizationMembershipRecordSchema);
export interface OrganizationMemberListPorts extends DomainQueryPorts { listOrganizationMembers: ReadCapability<(context: OrganizationRequestContext, input: z.infer<typeof Input>) => Promise<z.infer<typeof Output>>>; }

const organizationMemberList = defineQuery<OrganizationMemberListPorts>()({
  id: "organization.member.list", version: "1.0", availability: "active", title: "List Organization members", description: "List authorized Organization membership projections.",
  sources: ["runtime_api"], render: ["table"], resourceKinds: ["organization_membership"], proposedEffects: ["Read Organization members."], outputResourceKind: "organization_membership", uiDisplayCategory: "organization",
  provenance: [{ source: "samurai", commit_sha: "phase-2-organization", reference_file: "docs/designs/organization.md", decision: "adopted", reason: "Membership listing is separate from Workspace and Room content access." }],
  input: Input, output: Output,
  createHandler(_ports) { return publicContractHandler<z.infer<typeof Input>, z.infer<typeof Output>>("organization.member.list"); }
});
export default organizationMemberList;
