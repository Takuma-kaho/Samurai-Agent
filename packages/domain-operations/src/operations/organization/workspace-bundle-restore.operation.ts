import { z } from "zod";
import { defineCommand, publicContractHandler, type OrganizationRequestContext } from "../../definition/index.js";
import { organizationIdSchema, operationIdSchema, workspaceBundleRestoreResultSchema } from "../../value-objects/organization.js";

const Input = z.object({ bundle_id: operationIdSchema, target_organization_id: organizationIdSchema, confirm: z.literal(true) }).strict();
const Output = workspaceBundleRestoreResultSchema;
export interface WorkspaceBundleRestorePorts { restoreWorkspaceBundle(context: OrganizationRequestContext, input: z.infer<typeof Input>): Promise<z.infer<typeof Output>>; }

const workspaceBundleRestore = defineCommand<WorkspaceBundleRestorePorts>()({
  id: "workspace.bundle.restore", version: "1.0", availability: "active", title: "Restore Workspace bundle", description: "Restore a Workspace bundle into an explicitly selected target Organization.",
  sources: ["runtime_api"], effect: "workspace_mutation", idempotency: "required", concurrency: "append_or_unique", render: ["status_timeline"], resourceKinds: ["workspace_bundle", "workspace"], proposedEffects: ["Restore a Workspace bundle into a target Organization."], outputResourceKind: "workspace_bundle", uiDisplayCategory: "workspace",
  provenance: [{ source: "samurai", commit_sha: "phase-2-organization", reference_file: "docs/designs/organization.md", decision: "adopted", reason: "Restore requires target Organization authorization and remaps imported Event scope without exposing source membership or Room content." }],
  input: Input, output: Output,
  createHandler(_ports) { return publicContractHandler<z.infer<typeof Input>, z.infer<typeof Output>>("workspace.bundle.restore"); }
});
export default workspaceBundleRestore;
