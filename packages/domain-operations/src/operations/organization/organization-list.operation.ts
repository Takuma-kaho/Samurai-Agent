import { z } from "zod";
import { defineQuery, publicContractHandler, type DomainQueryPorts, type OrganizationRequestContext, type ReadCapability } from "../../definition/index.js";
import { organizationRecordSchema, paginationInputSchema } from "../../value-objects/organization.js";

const Input = paginationInputSchema;
const Output = z.array(organizationRecordSchema);
export interface OrganizationListPorts extends DomainQueryPorts { listOrganizations: ReadCapability<(context: OrganizationRequestContext, input: z.infer<typeof Input>) => Promise<z.infer<typeof Output>>>; }

const organizationList = defineQuery<OrganizationListPorts>()({
  id: "organization.list", version: "1.0", availability: "active", title: "List Organizations", description: "List Organizations visible to the authenticated Account.",
  sources: ["runtime_api"], render: ["table"], resourceKinds: ["organization"], proposedEffects: ["Read Organization metadata."], outputResourceKind: "organization", uiDisplayCategory: "organization",
  provenance: [{ source: "samurai", commit_sha: "phase-2-organization", reference_file: "docs/designs/organization.md", decision: "adopted", reason: "Organization membership controls metadata visibility without granting Workspace content access." }],
  input: Input, output: Output,
  createHandler(_ports) { return publicContractHandler<z.infer<typeof Input>, z.infer<typeof Output>>("organization.list"); }
});
export default organizationList;
