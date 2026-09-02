import { z } from "zod";
import { defineCommand, publicContractHandler, type OrganizationRequestContext } from "../../definition/index.js";
import { organizationIdSchema, organizationWorkspaceRecordSchema, workspaceIdSchema } from "../../value-objects/organization.js";

const Input = z.object({ organization_id: organizationIdSchema, workspace_id: workspaceIdSchema, expected_version: z.number().int().positive().optional(), confirm: z.literal(true) }).strict();
const Output = organizationWorkspaceRecordSchema;
export interface OrganizationWorkspaceDeletePorts { deleteOrganizationWorkspace(context: OrganizationRequestContext, input: z.infer<typeof Input>): Promise<z.infer<typeof Output>>; }

const organizationWorkspaceDelete = defineCommand<OrganizationWorkspaceDeletePorts>()({
  id: "organization.workspace.delete", version: "1.0", availability: "active", title: "Delete Organization Workspace", description: "Permanently delete a Workspace after explicit confirmation and cleanup checks.",
  sources: ["runtime_api"], effect: "workspace_mutation", idempotency: "required", concurrency: "state_transition", render: ["status_timeline"], resourceKinds: ["workspace"], proposedEffects: ["Delete a Workspace."], outputResourceKind: "workspace", uiDisplayCategory: "workspace",
  provenance: [{ source: "samurai", commit_sha: "phase-2-organization", reference_file: "docs/designs/organization.md", decision: "adopted", reason: "Permanent deletion is a state transition and cannot leave an Organization orphan reference." }],
  input: Input, output: Output,
  createHandler(_ports) { return publicContractHandler<z.infer<typeof Input>, z.infer<typeof Output>>("organization.workspace.delete"); }
});
export default organizationWorkspaceDelete;
