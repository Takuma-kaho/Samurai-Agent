import { z } from "zod";
import { defineCommand, publicContractHandler, type OrganizationRequestContext } from "../../definition/index.js";
import { organizationIdSchema, organizationInvitationRecordSchema, operationIdSchema } from "../../value-objects/organization.js";

const Input = z.object({ organization_id: organizationIdSchema, invitation_id: operationIdSchema, expires_at: z.string().datetime(), expected_version: z.number().int().positive().optional() }).strict();
const Output = organizationInvitationRecordSchema;
export interface OrganizationInvitationExtendPorts { extendOrganizationInvitation(context: OrganizationRequestContext, input: z.infer<typeof Input>): Promise<z.infer<typeof Output>>; }

const organizationInvitationExtend = defineCommand<OrganizationInvitationExtendPorts>()({
  id: "organization.invitation.extend", version: "1.0", availability: "active", title: "Extend Organization invitation", description: "Extend a pending Organization invitation expiry with optimistic concurrency.",
  sources: ["runtime_api"], effect: "workspace_mutation", idempotency: "required", concurrency: "optimistic_version", render: ["status_timeline"], resourceKinds: ["organization_invitation"], proposedEffects: ["Extend an Organization invitation expiry."], outputResourceKind: "organization_invitation", uiDisplayCategory: "organization",
  provenance: [{ source: "samurai", commit_sha: "phase-2-organization", reference_file: "docs/designs/organization.md", decision: "adopted", reason: "Expiry changes are version-checked and do not reveal token material." }],
  input: Input, output: Output,
  createHandler(_ports) { return publicContractHandler<z.infer<typeof Input>, z.infer<typeof Output>>("organization.invitation.extend"); }
});
export default organizationInvitationExtend;
