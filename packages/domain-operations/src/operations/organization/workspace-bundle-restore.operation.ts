import { z } from "zod";
import { defineCommand, publicContractHandler, type OrganizationRequestContext } from "../../definition/index.js";
import { operationIdSchema, workspaceBundleRestoreResultSchema } from "../../value-objects/organization.js";

/** Restore is always standalone; association is a separate command. */
const Input = z.object({
  bundle_id: operationIdSchema,
  workspace_id: operationIdSchema.optional(),
  target_workspace_id: operationIdSchema.optional(),
  confirm: z.literal(true)
}).strict();
const Output = workspaceBundleRestoreResultSchema;
export interface WorkspaceBundleRestorePorts { restoreWorkspaceBundle(context: OrganizationRequestContext, input: z.infer<typeof Input>): Promise<z.infer<typeof Output>>; }

const workspaceBundleRestore = defineCommand<WorkspaceBundleRestorePorts>()({
  id: "workspace.bundle.restore", version: "1.1", availability: "active", title: "Restore Workspace bundle", description: "Restore a Workspace bundle into a standalone Workspace by default.",
  sources: ["runtime_api"], effect: "workspace_mutation", idempotency: "required", concurrency: "append_or_unique", render: ["status_timeline"], resourceKinds: ["workspace_bundle", "workspace"], proposedEffects: ["Restore a Workspace bundle into a standalone Workspace."], outputResourceKind: "workspace_bundle", uiDisplayCategory: "workspace",
  provenance: [{ source: "samurai", commit_sha: "phase-2-workspace-first", reference_file: "plans/workspace-first-organization-realignment-master-plan.md", decision: "adopted", reason: "Restore selects a Workspace target independently; attaching to an Organization is a separate explicit operation." }],
  input: Input, output: Output,
  createHandler(_ports) { return publicContractHandler<z.infer<typeof Input>, z.infer<typeof Output>>("workspace.bundle.restore"); }
});
export default workspaceBundleRestore;
