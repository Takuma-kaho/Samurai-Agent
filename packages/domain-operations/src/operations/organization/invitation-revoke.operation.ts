import { z } from "zod";
import { defineCommand, publicContractHandler, type OrganizationRequestContext } from "../../definition/index.js";
import { organizationIdSchema, organizationInvitationRecordSchema, operationIdSchema } from "../../value-objects/organization.js";

const Input = z.object({ organization_id: organizationIdSchema, invitation_id: operationIdSchema, expected_version: z.number().int().positive().optional() }).strict();
const Output = organizationInvitationRecordSchema;
export interface OrganizationInvitationRevokePorts { revokeOrganizationInvitation(context: OrganizationRequestContext, input: z.infer<typeof Input>): Promise<z.infer<typeof Output>>; }

const organizationInvitationRevoke = defineCommand<OrganizationInvitationRevokePorts>()({
  id: "organization.invitation.revoke", version: "1.0", availability: "active", title: "Revoke Organization invitation", description: "Revoke a pending Organization invitation idempotently.",
  sources: ["runtime_api"], effect: "workspace_mutation", idempotency: "required", concurrency: "state_transition", render: ["status_timeline"], resourceKinds: ["organization_invitation"], proposedEffects: ["Revoke an Organization invitation."], outputResourceKind: "organization_invitation", uiDisplayCategory: "organization",
  provenance: [{ source: "samurai", commit_sha: "phase-2-organization", reference_file: "docs/designs/organization.md", decision: "adopted", reason: "Revoke changes acceptance state without returning or retaining the raw token." }],
  input: Input, output: Output,
  createHandler(_ports) { return publicContractHandler<z.infer<typeof Input>, z.infer<typeof Output>>("organization.invitation.revoke"); }
});
export default organizationInvitationRevoke;
