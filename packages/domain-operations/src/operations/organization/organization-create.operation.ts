import { z } from "zod";
import { defineCommand, publicContractHandler, type OrganizationRequestContext } from "../../definition/index.js";
import { organizationRecordSchema } from "../../value-objects/organization.js";

const Input = z.object({
  name: z.string().trim().min(1).max(200),
  icon: z.string().trim().max(1_024).optional(),
  description: z.string().max(20_000).optional()
}).strict();
const Output = organizationRecordSchema;
export interface OrganizationCreatePorts { createOrganization(context: OrganizationRequestContext, input: z.infer<typeof Input>): Promise<z.infer<typeof Output>>; }

const organizationCreate = defineCommand<OrganizationCreatePorts>()({
  id: "organization.create", version: "1.0", availability: "active", title: "Create Organization", description: "Create a normal Organization owned by the authenticated Account.",
  sources: ["runtime_api"], effect: "workspace_mutation", idempotency: "required", concurrency: "append_or_unique", render: ["status_timeline"], resourceKinds: ["organization"], proposedEffects: ["Create an Organization."], outputResourceKind: "organization", uiDisplayCategory: "organization",
  provenance: [{ source: "samurai", commit_sha: "phase-2-organization", reference_file: "docs/designs/organization.md", decision: "adopted", reason: "Every Organization is a normal, user-owned tenant without a Personal special case." }],
  input: Input, output: Output,
  createHandler(_ports) { return publicContractHandler<z.infer<typeof Input>, z.infer<typeof Output>>("organization.create"); }
});
export default organizationCreate;
