import { z } from "zod";
import { defineQuery, publicContractHandler, type DomainQueryPorts, type OrganizationRequestContext, type ReadCapability } from "../../definition/index.js";
import { organizationIdSchema, workspaceIdSchema, workspaceMovePreflightSchema } from "../../value-objects/organization.js";

const Input = z.object({ source_organization_id: organizationIdSchema, target_organization_id: organizationIdSchema, workspace_id: workspaceIdSchema, expected_workspace_version: z.number().int().positive().optional() }).strict();
const Output = workspaceMovePreflightSchema;
export interface WorkspaceOrganizationMovePreflightPorts extends DomainQueryPorts { preflightWorkspaceOrganizationMove: ReadCapability<(context: OrganizationRequestContext, input: z.infer<typeof Input>) => Promise<z.infer<typeof Output>>>; }

const workspaceOrganizationMovePreflight = defineQuery<WorkspaceOrganizationMovePreflightPorts>()({
  id: "workspace.organization.move.preflight", version: "1.0", availability: "active", title: "Preview Workspace Organization move", description: "Preview an Organization move, including missing Guest memberships and failure conditions.",
  sources: ["runtime_api"], render: ["form", "table"], resourceKinds: ["workspace", "organization", "workspace_membership"], proposedEffects: ["Preview a Workspace Organization move."], outputResourceKind: "workspace_move", uiDisplayCategory: "organization",
  provenance: [{ source: "samurai", commit_sha: "phase-2-organization", reference_file: "docs/designs/organization.md", decision: "adopted", reason: "Move requires a current preview before any transactional mutation." }],
  input: Input, output: Output,
  createHandler(_ports) { return publicContractHandler<z.infer<typeof Input>, z.infer<typeof Output>>("workspace.organization.move.preflight"); }
});
export default workspaceOrganizationMovePreflight;
