import { z } from "zod";
import { defineCommand, publicContractHandler, type OrganizationRequestContext } from "../../definition/index.js";
import { organizationIdSchema, workspaceBundleExportResultSchema, workspaceIdSchema } from "../../value-objects/organization.js";

const Input = z.object({ organization_id: organizationIdSchema, workspace_id: workspaceIdSchema, expected_workspace_version: z.number().int().positive().optional() }).strict();
const Output = workspaceBundleExportResultSchema;
export interface WorkspaceBundleExportPorts { exportWorkspaceBundle(context: OrganizationRequestContext, input: z.infer<typeof Input>): Promise<z.infer<typeof Output>>; }

const workspaceBundleExport = defineCommand<WorkspaceBundleExportPorts>()({
  id: "workspace.bundle.export", version: "1.0", availability: "active", title: "Export Workspace bundle", description: "Export safe Workspace bundle metadata with a source Organization reference.",
  sources: ["runtime_api"], effect: "workspace_mutation", idempotency: "required", concurrency: "append_or_unique", render: ["status_timeline"], resourceKinds: ["workspace_bundle", "workspace"], proposedEffects: ["Export a Workspace bundle."], outputResourceKind: "workspace_bundle", uiDisplayCategory: "workspace",
  provenance: [{ source: "samurai", commit_sha: "phase-2-organization", reference_file: "docs/designs/organization.md", decision: "adopted", reason: "Bundle export preserves Workspace ownership provenance while excluding unauthorized content and raw tokens from the public result." }],
  input: Input, output: Output,
  createHandler(_ports) { return publicContractHandler<z.infer<typeof Input>, z.infer<typeof Output>>("workspace.bundle.export"); }
});
export default workspaceBundleExport;
