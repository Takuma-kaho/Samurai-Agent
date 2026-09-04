import { z } from "zod";
import { defineQuery, publicContractHandler, type DomainQueryPorts, type OrganizationRequestContext, type ReadCapability } from "../../definition/index.js";
import { organizationIdSchema, organizationRecordSchema } from "../../value-objects/organization.js";

const Input = z.object({ organization_id: organizationIdSchema }).strict();
const Output = organizationRecordSchema;
export interface OrganizationViewPorts extends DomainQueryPorts { viewOrganization: ReadCapability<(context: OrganizationRequestContext, organizationId: string) => Promise<z.infer<typeof Output>>>; }

const organizationView = defineQuery<OrganizationViewPorts>()({
  id: "organization.view", version: "1.0", availability: "active", title: "View Organization", description: "View one authorized Organization metadata projection.",
  sources: ["runtime_api"], render: ["form"], resourceKinds: ["organization"], proposedEffects: ["Read Organization metadata."], outputResourceKind: "organization", uiDisplayCategory: "organization",
  provenance: [{ source: "samurai", commit_sha: "phase-2-organization", reference_file: "docs/designs/organization.md", decision: "adopted", reason: "The public projection contains Organization metadata only." }],
  input: Input, output: Output,
  createHandler(_ports) { return publicContractHandler<z.infer<typeof Input>, z.infer<typeof Output>>("organization.view"); }
});
export default organizationView;
