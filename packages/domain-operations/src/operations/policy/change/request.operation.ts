// Domain operation module. Keep its contract and handler together.
import { defineCommand, type DomainResult, type TrustedDomainContext } from "../../../definition/index.js";
import { type HumanChangeRequestOutput, type HumanChangeRequestPorts } from "../../human-change-request.js";
import { humanChangeRequestInputSchema, humanChangeRequestOutputSchema } from "../../../value-objects/human-change-request.js";

const Input = humanChangeRequestInputSchema;
const Output = humanChangeRequestOutputSchema;

export interface PolicyChangeRequestPorts extends HumanChangeRequestPorts {}

const policyChangeRequest = defineCommand<PolicyChangeRequestPorts>()({
  id: "policy.change.request",
  version: "1.1",
  availability: "active",
  title: "Request a human Policy change",
  description: "Record a request for a human to review a Policy change; it never changes Policy directly.",
  sources: ["runtime_api", "external_app"],
  effect: "workspace_mutation",
  idempotency: "required",
  concurrency: "append_or_unique",
  render: ["status_timeline"],
  resourceKinds: ["activity", "policy"],
  proposedEffects: ["Record a human review request without changing Policy."],
  outputResourceKind: "human_change_request",
  uiDisplayCategory: "settings",
  provenance: [{
    source: "samurai",
    commit_sha: "workspace-server-05",
    reference_file: "ARCHITECTURE.md",
    decision: "adapted",
    reason: "Human-owned Policy may be requested by an external Client but is never changed by it directly."
  }],
  input: Input,
  output: Output,
  createHandler(ports) {
    return {
      execute: async function handlePolicyChangeRequest(context: TrustedDomainContext, input): Promise<DomainResult<HumanChangeRequestOutput>> {
        const value = await ports.requestHumanChange(context, { ...input, request_kind: "policy" });
        return { ok: true, value };
      }
    };
  }
});

export default policyChangeRequest;
