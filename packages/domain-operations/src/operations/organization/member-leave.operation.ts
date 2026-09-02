import { z } from "zod";
import { defineCommand, publicContractHandler, type OrganizationRequestContext } from "../../definition/index.js";
import { organizationIdSchema, organizationMembershipRecordSchema } from "../../value-objects/organization.js";

const Input = z.object({ organization_id: organizationIdSchema, expected_version: z.number().int().positive().optional() }).strict();
const Output = organizationMembershipRecordSchema;
export interface OrganizationMemberLeavePorts { leaveOrganization(context: OrganizationRequestContext, input: z.infer<typeof Input>): Promise<z.infer<typeof Output>>; }

const organizationMemberLeave = defineCommand<OrganizationMemberLeavePorts>()({
  id: "organization.member.leave", version: "1.0", availability: "active", title: "Leave Organization", description: "Leave an Organization unless doing so would remove its last Owner.",
  sources: ["runtime_api"], effect: "workspace_mutation", idempotency: "required", concurrency: "state_transition", render: ["status_timeline"], resourceKinds: ["organization_membership"], proposedEffects: ["Leave an Organization."], outputResourceKind: "organization_membership", uiDisplayCategory: "organization",
  provenance: [{ source: "samurai", commit_sha: "phase-2-organization", reference_file: "docs/designs/organization.md", decision: "adopted", reason: "The last Owner invariant is enforced by the server transaction, not by the client." }],
  input: Input, output: Output,
  createHandler(_ports) { return publicContractHandler<z.infer<typeof Input>, z.infer<typeof Output>>("organization.member.leave"); }
});
export default organizationMemberLeave;
