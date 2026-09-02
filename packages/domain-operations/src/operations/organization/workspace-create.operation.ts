import { z } from "zod";
import { defineCommand, publicContractHandler, type OrganizationRequestContext } from "../../definition/index.js";
import { organizationIdSchema, organizationWorkspaceRecordSchema } from "../../value-objects/organization.js";

const Input = z.object({ organization_id: organizationIdSchema, name: z.string().trim().min(1).max(200) }).strict();
const Output = organizationWorkspaceRecordSchema;
export interface OrganizationWorkspaceCreatePorts { createOrganizationWorkspace(context: OrganizationRequestContext, input: z.infer<typeof Input>): Promise<z.infer<typeof Output>>; }

const organizationWorkspaceCreate = defineCommand<OrganizationWorkspaceCreatePorts>()({
  id: "organization.workspace.create", version: "1.0", availability: "active", title: "Create Organization Workspace", description: "Create an active Workspace in an authorized Organization.",
  sources: ["runtime_api"], effect: "workspace_mutation", idempotency: "required", concurrency: "append_or_unique", render: ["status_timeline"], resourceKinds: ["workspace"], proposedEffects: ["Create a Workspace in an Organization."], outputResourceKind: "workspace", uiDisplayCategory: "workspace",
  provenance: [{ source: "samurai", commit_sha: "phase-2-organization", reference_file: "docs/designs/organization.md", decision: "adopted", reason: "A Workspace always has one Organization owner and is created through the formal Domain Operation boundary." }],
  input: Input, output: Output,
  createHandler(_ports) { return publicContractHandler<z.infer<typeof Input>, z.infer<typeof Output>>("organization.workspace.create"); }
});
export default organizationWorkspaceCreate;
