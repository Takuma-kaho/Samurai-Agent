import { z } from "zod";
import { defineQuery, publicContractHandler, type DomainQueryPorts, type OrganizationRequestContext, type ReadCapability } from "../../definition/index.js";
import { organizationIdSchema, workspaceIdSchema, workspaceMovePreflightSchema } from "../../value-objects/organization.js";

/** One side may be omitted for standalone attach/detach; both omitted is invalid. */
const Input = z.object({
  source_organization_id: organizationIdSchema.optional(),
  target_organization_id: organizationIdSchema.optional(),
  workspace_id: workspaceIdSchema,
  expected_workspace_version: z.number().int().positive().optional()
}).strict().refine(
  (value) => value.source_organization_id !== undefined || value.target_organization_id !== undefined,
  { message: "workspace_organization_move_target_required" }
);
const Output = workspaceMovePreflightSchema;
export interface WorkspaceOrganizationMovePreflightPorts extends DomainQueryPorts { preflightWorkspaceOrganizationMove: ReadCapability<(context: OrganizationRequestContext, input: z.infer<typeof Input>) => Promise<z.infer<typeof Output>>>; }

const workspaceOrganizationMovePreflight = defineQuery<WorkspaceOrganizationMovePreflightPorts>()({
  id: "workspace.organization.move.preflight", version: "1.1", availability: "active", title: "Preview Workspace Organization move", description: "Preview an Organization attach, detach, or move, including missing Guest memberships and failure conditions.",
  sources: ["runtime_api"], render: ["form", "table"], resourceKinds: ["workspace", "organization", "workspace_membership"], proposedEffects: ["Preview a Workspace Organization move."], outputResourceKind: "workspace_move", uiDisplayCategory: "organization",
  provenance: [{ source: "samurai", commit_sha: "phase-2-workspace-first", reference_file: "plans/workspace-first-organization-realignment-master-plan.md", decision: "adopted", reason: "Attach, detach, and move share one preview contract before transactional mutation." }],
  input: Input, output: Output,
  createHandler(_ports) { return publicContractHandler<z.infer<typeof Input>, z.infer<typeof Output>>("workspace.organization.move.preflight"); }
});
export default workspaceOrganizationMovePreflight;
