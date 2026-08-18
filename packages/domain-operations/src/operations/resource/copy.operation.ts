import { z } from "zod";
import { defineCommand, type DomainResult, type TrustedDomainContext } from "../../definition/index.js";
import {
  resourceTransferReasonSchema,
  resourceTransferValueSchema,
  transferableResourceKindSchema,
  type ResourceTransferValue,
  type TransferableResourceKind
} from "./transfer.js";

const Input = z.object({
  resource_kind: transferableResourceKindSchema,
  resource_id: z.string().trim().min(1).max(512),
  expected_resource_version: z.number().int().positive(),
  target_room_id: z.string().trim().min(1).max(512),
  target_resource_id: z.string().trim().min(1).max(512).optional(),
  reason: resourceTransferReasonSchema
}).strict();
const Output = resourceTransferValueSchema;

export type ResourceCopyInput = z.infer<typeof Input>;

export interface ResourceCopyPorts {
  copyResource(context: TrustedDomainContext, input: ResourceCopyInput): Promise<ResourceTransferValue>;
}

const resourceCopy = defineCommand<ResourceCopyPorts>()({
  id: "resource.copy",
  version: "1.0",
  availability: "active",
  title: "Copy a Room resource",
  description: "Create an independent Knowledge or Skill copy in an explicitly authorized target Room.",
  sources: ["runtime_api", "external_app"],
  effect: "workspace_mutation",
  idempotency: "required",
  concurrency: "optimistic_version",
  render: ["status_timeline"],
  resourceKinds: ["wiki", "skill"],
  proposedEffects: ["Create an independent Room-scoped copy with source provenance."],
  outputResourceKind: "resource_transfer",
  uiDisplayCategory: "workspace",
  provenance: [{
    source: "samurai",
    commit_sha: "workspace-server-05",
    reference_file: "ARCHITECTURE.md",
    decision: "adapted",
    reason: "Copy is explicit, version-checked, and never creates implicit Room sharing."
  }],
  input: Input,
  output: Output,
  createHandler(ports) {
    return {
      execute: async function handleResourceCopy(context: TrustedDomainContext, input: ResourceCopyInput): Promise<DomainResult<ResourceTransferValue>> {
        return { ok: true, value: resourceTransferValueSchema.parse(await ports.copyResource(context, input)) };
      }
    };
  }
});

export default resourceCopy;
