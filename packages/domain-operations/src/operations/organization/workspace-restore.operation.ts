import { z } from "zod";
import { defineCommand, publicContractHandler, type OrganizationRequestContext } from "../../definition/index.js";
import { organizationIdSchema, organizationWorkspaceRecordSchema, workspaceIdSchema } from "../../value-objects/organization.js";

const Input = z.object({ organization_id: organizationIdSchema, workspace_id: workspaceIdSchema, expected_version: z.number().int().positive().optional(), confirm: z.literal(true) }).strict();
const Output = organizationWorkspaceRecordSchema;
export interface OrganizationWorkspaceRestorePorts { restoreOrganizationWorkspace(context: OrganizationRequestContext, input: z.infer<typeof Input>): Promise<z.infer<typeof Output>>; }

const organizationWorkspaceRestore = defineCommand<OrganizationWorkspaceRestorePorts>()({
  id: "organization.workspace.restore", version: "1.0", availability: "active", title: "Restore Organization Workspace", description: "Restore an archived Workspace to active state.",
  sources: ["runtime_api"], effect: "workspace_mutation", idempotency: "required", concurrency: "state_transition", render: ["status_timeline"], resourceKinds: ["workspace"], proposedEffects: ["Restore a Workspace."], outputResourceKind: "workspace", uiDisplayCategory: "workspace",
  provenance: [{ source: "samurai", commit_sha: "phase-2-organization", reference_file: "docs/designs/organization.md", decision: "adopted", reason: "Restore re-enables writes only after the server validates the current Workspace state." }],
  input: Input, output: Output,
  createHandler(_ports) { return publicContractHandler<z.infer<typeof Input>, z.infer<typeof Output>>("organization.workspace.restore"); }
});
export default organizationWorkspaceRestore;
