import { z } from "zod";
import { defineCommand, publicContractHandler, type OrganizationRequestContext } from "../../definition/index.js";
import { organizationIdSchema, organizationInvitationIssueResultSchema, operationIdSchema } from "../../value-objects/organization.js";

const Input = z.object({ organization_id: organizationIdSchema, invitation_id: operationIdSchema, expected_version: z.number().int().positive().optional() }).strict();
const Output = organizationInvitationIssueResultSchema;
export interface OrganizationInvitationReissuePorts { reissueOrganizationInvitation(context: OrganizationRequestContext, input: z.infer<typeof Input>): Promise<z.infer<typeof Output>>; }

const organizationInvitationReissue = defineCommand<OrganizationInvitationReissuePorts>()({
  id: "organization.invitation.reissue", version: "1.0", availability: "active", title: "Reissue Organization invitation", description: "Reissue an Organization invitation and return any new token only once.",
  sources: ["runtime_api"], effect: "workspace_mutation", idempotency: "required", concurrency: "append_or_unique", render: ["status_timeline"], resourceKinds: ["organization_invitation"], proposedEffects: ["Reissue an Organization invitation."], outputResourceKind: "organization_invitation", uiDisplayCategory: "organization",
  provenance: [{ source: "samurai", commit_sha: "phase-2-organization", reference_file: "docs/designs/organization.md", decision: "adopted", reason: "Reissue creates a new one-time delivery value while the public invitation projection remains token-free." }],
  input: Input, output: Output,
  createHandler(_ports) { return publicContractHandler<z.infer<typeof Input>, z.infer<typeof Output>>("organization.invitation.reissue"); }
});
export default organizationInvitationReissue;
