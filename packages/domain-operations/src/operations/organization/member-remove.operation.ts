import { z } from "zod";
import { defineCommand, publicContractHandler, type OrganizationRequestContext } from "../../definition/index.js";
import { accountIdSchema, organizationIdSchema, organizationMembershipRecordSchema } from "../../value-objects/organization.js";

const Input = z.object({ organization_id: organizationIdSchema, target_account_id: accountIdSchema, expected_version: z.number().int().positive().optional() }).strict();
const Output = organizationMembershipRecordSchema;
export interface OrganizationMemberRemovePorts { removeOrganizationMember(context: OrganizationRequestContext, input: z.infer<typeof Input>): Promise<z.infer<typeof Output>>; }

const organizationMemberRemove = defineCommand<OrganizationMemberRemovePorts>()({
  id: "organization.member.remove", version: "1.0", availability: "active", title: "Remove Organization member", description: "Remove an Organization member without deleting historical actor references.",
  sources: ["runtime_api"], effect: "workspace_mutation", idempotency: "required", concurrency: "state_transition", render: ["status_timeline"], resourceKinds: ["organization_membership"], proposedEffects: ["Remove an Organization member."], outputResourceKind: "organization_membership", uiDisplayCategory: "organization",
  provenance: [{ source: "samurai", commit_sha: "phase-2-organization", reference_file: "docs/designs/organization.md", decision: "adopted", reason: "Removal revokes current access while retaining an auditable membership projection." }],
  input: Input, output: Output,
  createHandler(_ports) { return publicContractHandler<z.infer<typeof Input>, z.infer<typeof Output>>("organization.member.remove"); }
});
export default organizationMemberRemove;
