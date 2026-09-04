import { z } from "zod";
import { defineCommand, publicContractHandler, type OrganizationRequestContext } from "../../definition/index.js";
import { organizationIdSchema, organizationWorkspaceRecordSchema, workspaceIdSchema } from "../../value-objects/organization.js";

const Input = z.object({ organization_id: organizationIdSchema, workspace_id: workspaceIdSchema, expected_version: z.number().int().positive().optional(), confirm: z.literal(true) }).strict();
const Output = organizationWorkspaceRecordSchema;
export interface OrganizationWorkspaceArchivePorts { archiveOrganizationWorkspace(context: OrganizationRequestContext, input: z.infer<typeof Input>): Promise<z.infer<typeof Output>>; }

const organizationWorkspaceArchive = defineCommand<OrganizationWorkspaceArchivePorts>()({
  id: "organization.workspace.archive", version: "1.0", availability: "active", title: "Archive Organization Workspace", description: "Archive a Workspace and reject Chat, Agent, and file writes until restored.",
  sources: ["runtime_api"], effect: "workspace_mutation", idempotency: "required", concurrency: "state_transition", render: ["status_timeline"], resourceKinds: ["workspace"], proposedEffects: ["Archive a Workspace."], outputResourceKind: "workspace", uiDisplayCategory: "workspace",
  provenance: [{ source: "samurai", commit_sha: "phase-2-organization", reference_file: "docs/designs/organization.md", decision: "adopted", reason: "Archive is a server-enforced read-only state, not a UI-only flag." }],
  input: Input, output: Output,
  createHandler(_ports) { return publicContractHandler<z.infer<typeof Input>, z.infer<typeof Output>>("organization.workspace.archive"); }
});
export default organizationWorkspaceArchive;
