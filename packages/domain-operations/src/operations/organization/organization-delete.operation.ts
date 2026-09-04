import { z } from "zod";
import { defineCommand, publicContractHandler, type OrganizationRequestContext } from "../../definition/index.js";
import { organizationIdSchema, organizationRecordSchema } from "../../value-objects/organization.js";

const Input = z.object({ organization_id: organizationIdSchema, expected_version: z.number().int().positive().optional(), confirm: z.literal(true) }).strict();
const Output = organizationRecordSchema;
export interface OrganizationDeletePorts { deleteOrganization(context: OrganizationRequestContext, input: z.infer<typeof Input>): Promise<z.infer<typeof Output>>; }

const organizationDelete = defineCommand<OrganizationDeletePorts>()({
  id: "organization.delete", version: "1.0", availability: "active", title: "Delete Organization", description: "Delete an empty Organization after all Workspaces are moved or deleted.",
  sources: ["runtime_api"], effect: "workspace_mutation", idempotency: "required", concurrency: "state_transition", render: ["status_timeline"], resourceKinds: ["organization"], proposedEffects: ["Delete an empty Organization."], outputResourceKind: "organization", uiDisplayCategory: "organization",
  provenance: [{ source: "samurai", commit_sha: "phase-2-organization", reference_file: "docs/designs/organization.md", decision: "adopted", reason: "The operation requires explicit confirmation and leaves no Organization with orphan Workspaces." }],
  input: Input, output: Output,
  createHandler(_ports) { return publicContractHandler<z.infer<typeof Input>, z.infer<typeof Output>>("organization.delete"); }
});
export default organizationDelete;
