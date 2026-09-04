import { z } from "zod";
import { defineQuery, publicContractHandler, type DomainQueryPorts, type OrganizationRequestContext, type ReadCapability } from "../../definition/index.js";
import { operationIdSchema, workspaceMoveStatusRecordSchema } from "../../value-objects/organization.js";

const Input = z.object({ operation_id: operationIdSchema }).strict();
const Output = workspaceMoveStatusRecordSchema;
export interface WorkspaceOrganizationMoveStatusPorts extends DomainQueryPorts { getWorkspaceOrganizationMoveStatus: ReadCapability<(context: OrganizationRequestContext, operationId: string) => Promise<z.infer<typeof Output>>>; }

const workspaceOrganizationMoveStatus = defineQuery<WorkspaceOrganizationMoveStatusPorts>()({
  id: "workspace.organization.move.status", version: "1.1", availability: "active", title: "Get Workspace Organization move status", description: "Read the durable status of a Workspace Organization attach, detach, or move operation.",
  sources: ["runtime_api"], render: ["status_timeline"], resourceKinds: ["workspace_move"], proposedEffects: ["Read Workspace move status."], outputResourceKind: "workspace_move", uiDisplayCategory: "organization",
  provenance: [{ source: "samurai", commit_sha: "phase-2-workspace-first", reference_file: "plans/workspace-first-organization-realignment-master-plan.md", decision: "adopted", reason: "Association status is a query over the operation ledger and contains no Room content." }],
  input: Input, output: Output,
  createHandler(_ports) { return publicContractHandler<z.infer<typeof Input>, z.infer<typeof Output>>("workspace.organization.move.status"); }
});
export default workspaceOrganizationMoveStatus;
