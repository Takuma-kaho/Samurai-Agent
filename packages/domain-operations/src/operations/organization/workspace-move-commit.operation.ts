import { z } from "zod";
import { defineCommand, publicContractHandler, type OrganizationRequestContext } from "../../definition/index.js";
import { organizationIdSchema, operationIdSchema, workspaceIdSchema, workspaceMoveResultSchema } from "../../value-objects/organization.js";

const Input = z.object({
  preflight_id: operationIdSchema,
  source_organization_id: organizationIdSchema.optional(),
  target_organization_id: organizationIdSchema.optional(),
  workspace_id: workspaceIdSchema,
  confirm_guest_membership: z.literal(true),
  expected_workspace_version: z.number().int().positive().optional()
}).strict().refine(
  (value) => value.source_organization_id !== undefined || value.target_organization_id !== undefined,
  { message: "workspace_organization_move_target_required" }
);
const Output = workspaceMoveResultSchema;
export interface WorkspaceOrganizationMoveCommitPorts { commitWorkspaceOrganizationMove(context: OrganizationRequestContext, input: z.infer<typeof Input>): Promise<z.infer<typeof Output>>; }

const workspaceOrganizationMoveCommit = defineCommand<WorkspaceOrganizationMoveCommitPorts>()({
  id: "workspace.organization.move.commit", version: "1.1", availability: "active", title: "Move Workspace between Organizations", description: "Commit a previously previewed Workspace attach, detach, or move in one transaction.",
  sources: ["runtime_api"], effect: "workspace_mutation", idempotency: "required", concurrency: "optimistic_version", render: ["status_timeline"], resourceKinds: ["workspace", "organization", "workspace_membership"], proposedEffects: ["Move a Workspace to another Organization."], outputResourceKind: "workspace_move", uiDisplayCategory: "organization",
  provenance: [{ source: "samurai", commit_sha: "phase-2-workspace-first", reference_file: "plans/workspace-first-organization-realignment-master-plan.md", decision: "adopted", reason: "The operation ledger and source/target/workspace lock order make optional association, Guest completion, and Event insertion atomic." }],
  input: Input, output: Output,
  createHandler(_ports) { return publicContractHandler<z.infer<typeof Input>, z.infer<typeof Output>>("workspace.organization.move.commit"); }
});
export default workspaceOrganizationMoveCommit;
