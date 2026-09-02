import { z } from "zod";
import { defineQuery, publicContractHandler, type DomainQueryPorts, type OrganizationRequestContext, type ReadCapability } from "../../definition/index.js";
import { organizationIdSchema, organizationWorkspaceRecordSchema, paginationInputSchema } from "../../value-objects/organization.js";

const Input = paginationInputSchema.extend({ organization_id: organizationIdSchema, include_deleted: z.boolean().optional() }).strict();
const Output = z.array(organizationWorkspaceRecordSchema);
export interface OrganizationWorkspaceListPorts extends DomainQueryPorts { listOrganizationWorkspaces: ReadCapability<(context: OrganizationRequestContext, input: z.infer<typeof Input>) => Promise<z.infer<typeof Output>>>; }

const organizationWorkspaceList = defineQuery<OrganizationWorkspaceListPorts>()({
  id: "organization.workspace.list", version: "1.0", availability: "active", title: "List Organization Workspaces", description: "List Workspace metadata in an authorized Organization without Room content.",
  sources: ["runtime_api"], render: ["table"], resourceKinds: ["workspace"], proposedEffects: ["Read Organization Workspace metadata."], outputResourceKind: "workspace", uiDisplayCategory: "workspace",
  provenance: [{ source: "samurai", commit_sha: "phase-2-organization", reference_file: "docs/designs/organization.md", decision: "adopted", reason: "Organization membership reveals only Workspace metadata; content access remains a separate membership check." }],
  input: Input, output: Output,
  createHandler(_ports) { return publicContractHandler<z.infer<typeof Input>, z.infer<typeof Output>>("organization.workspace.list"); }
});
export default organizationWorkspaceList;
