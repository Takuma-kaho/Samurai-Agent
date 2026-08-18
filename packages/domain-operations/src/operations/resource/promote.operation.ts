import { z } from "zod";
import { defineCommand, type DomainResult, type TrustedDomainContext } from "../../definition/index.js";
import {
  resourceTransferReasonSchema,
  resourceTransferValueSchema,
  transferableResourceKindSchema,
  type ResourceTransferValue
} from "./transfer.js";

const Input = z.object({
  resource_kind: transferableResourceKindSchema,
  resource_id: z.string().trim().min(1).max(512),
  expected_resource_version: z.number().int().positive(),
  reason: resourceTransferReasonSchema
}).strict();
const Output = resourceTransferValueSchema;

export type ResourcePromoteInput = z.infer<typeof Input>;

export interface ResourcePromotePorts {
  promoteResource(context: TrustedDomainContext, input: ResourcePromoteInput): Promise<ResourceTransferValue>;
}

const resourcePromote = defineCommand<ResourcePromotePorts>()({
  id: "resource.promote",
  version: "1.0",
  availability: "active",
  title: "Promote a resource to Workspace scope",
  description: "Promote a Knowledge or Skill resource to Workspace scope only after the Workspace-authorized approval path.",
  sources: ["runtime_api", "external_app"],
  effect: "workspace_mutation",
  idempotency: "required",
  concurrency: "optimistic_version",
  render: ["status_timeline"],
  resourceKinds: ["wiki", "skill"],
  proposedEffects: ["Change one Resource from its current Room scope to explicit Workspace scope."],
  outputResourceKind: "resource_transfer",
  uiDisplayCategory: "workspace",
  provenance: [{
    source: "samurai",
    commit_sha: "workspace-server-05",
    reference_file: "ARCHITECTURE.md",
    decision: "adapted",
    reason: "Workspace promotion is explicit and version-checked; it is never a side effect of Room hierarchy."
  }],
  input: Input,
  output: Output,
  createHandler(ports) {
    return {
      execute: async function handleResourcePromote(context: TrustedDomainContext, input: ResourcePromoteInput): Promise<DomainResult<ResourceTransferValue>> {
        return { ok: true, value: resourceTransferValueSchema.parse(await ports.promoteResource(context, input)) };
      }
    };
  }
});

export default resourcePromote;
