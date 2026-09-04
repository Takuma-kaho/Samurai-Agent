import { z } from "zod";
import { defineCommand, publicContractHandler, type OrganizationRequestContext } from "../../definition/index.js";
import { accountIdSchema, organizationIdSchema, organizationMembershipRecordSchema, organizationRoleSchema } from "../../value-objects/organization.js";

const Input = z.object({ organization_id: organizationIdSchema, target_account_id: accountIdSchema, role: organizationRoleSchema, expected_version: z.number().int().positive().optional() }).strict();
const Output = organizationMembershipRecordSchema;
export interface OrganizationMemberRoleChangePorts { changeOrganizationMemberRole(context: OrganizationRequestContext, input: z.infer<typeof Input>): Promise<z.infer<typeof Output>>; }

const organizationMemberRoleChange = defineCommand<OrganizationMemberRoleChangePorts>()({
  id: "organization.member.role.change", version: "1.0", availability: "active", title: "Change Organization member role", description: "Change an Organization member role while preserving the last-Owner invariant.",
  sources: ["runtime_api"], effect: "workspace_mutation", idempotency: "required", concurrency: "state_transition", render: ["status_timeline"], resourceKinds: ["organization_membership"], proposedEffects: ["Change an Organization member role."], outputResourceKind: "organization_membership", uiDisplayCategory: "organization",
  provenance: [{ source: "samurai", commit_sha: "phase-2-organization", reference_file: "docs/designs/organization.md", decision: "adopted", reason: "Organization roles do not grant Workspace or Room content access." }],
  input: Input, output: Output,
  createHandler(_ports) { return publicContractHandler<z.infer<typeof Input>, z.infer<typeof Output>>("organization.member.role.change"); }
});
export default organizationMemberRoleChange;
