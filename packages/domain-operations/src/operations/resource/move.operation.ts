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
  target_room_id: z.string().trim().min(1).max(512),
  reason: resourceTransferReasonSchema
}).strict();
const Output = resourceTransferValueSchema;

export type ResourceMoveInput = z.infer<typeof Input>;

export interface ResourceMovePorts {
  moveResource(context: TrustedDomainContext, input: ResourceMoveInput): Promise<ResourceTransferValue>;
}

const resourceMove = defineCommand<ResourceMovePorts>()({
  id: "resource.move",
  version: "1.0",
  availability: "active",
  title: "Move a Room resource",
  description: "Move a Knowledge or Skill resource to an explicitly authorized target Room without implicit inheritance.",
  sources: ["runtime_api", "external_app"],
  effect: "workspace_mutation",
  idempotency: "required",
  concurrency: "optimistic_version",
  render: ["status_timeline"],
  resourceKinds: ["wiki", "skill"],
  proposedEffects: ["Change one Resource's explicit usage scope after source and target Room authorization."],
  outputResourceKind: "resource_transfer",
  uiDisplayCategory: "workspace",
  provenance: [{
    source: "samurai",
    commit_sha: "workspace-server-05",
    reference_file: "ARCHITECTURE.md",
    decision: "adapted",
    reason: "A move is an explicit scope change with an optimistic Version check, not automatic parent or child Room inheritance."
  }],
  input: Input,
  output: Output,
  createHandler(ports) {
    return {
      execute: async function handleResourceMove(context: TrustedDomainContext, input: ResourceMoveInput): Promise<DomainResult<ResourceTransferValue>> {
        return { ok: true, value: resourceTransferValueSchema.parse(await ports.moveResource(context, input)) };
      }
    };
  }
});

export default resourceMove;
