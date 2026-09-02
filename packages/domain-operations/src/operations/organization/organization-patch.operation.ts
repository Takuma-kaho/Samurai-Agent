import { z } from "zod";
import { defineCommand, publicContractHandler, type OrganizationRequestContext } from "../../definition/index.js";
import { organizationIdSchema, organizationRecordSchema } from "../../value-objects/organization.js";

const Input = z.object({
  organization_id: organizationIdSchema,
  name: z.string().trim().min(1).max(200).optional(),
  icon: z.string().trim().max(1_024).nullable().optional(),
  description: z.string().max(20_000).nullable().optional(),
  expected_version: z.number().int().positive().optional()
}).strict();
const Output = organizationRecordSchema;
export interface OrganizationPatchPorts { patchOrganization(context: OrganizationRequestContext, input: z.infer<typeof Input>): Promise<z.infer<typeof Output>>; }

const organizationPatch = defineCommand<OrganizationPatchPorts>()({
  id: "organization.patch", version: "1.0", availability: "active", title: "Update Organization", description: "Update Organization metadata with optimistic concurrency.",
  sources: ["runtime_api"], effect: "workspace_mutation", idempotency: "required", concurrency: "optimistic_version", render: ["status_timeline"], resourceKinds: ["organization"], proposedEffects: ["Update Organization metadata."], outputResourceKind: "organization", uiDisplayCategory: "organization",
  provenance: [{ source: "samurai", commit_sha: "phase-2-organization", reference_file: "docs/designs/organization.md", decision: "adopted", reason: "Organization metadata changes must not change Workspace or Room content permissions." }],
  input: Input, output: Output,
  createHandler(_ports) { return publicContractHandler<z.infer<typeof Input>, z.infer<typeof Output>>("organization.patch"); }
});
export default organizationPatch;
