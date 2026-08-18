import { z } from "zod";
import { defineCommand, type DomainResult, type TrustedDomainContext } from "../../definition/index.js";
import {
  resourceRedactionValueSchema,
  resourceTransferReasonSchema,
  transferableResourceKindSchema,
  type ResourceRedactionValue
} from "./transfer.js";

const Input = z.object({
  resource_kind: transferableResourceKindSchema,
  resource_id: z.string().trim().min(1).max(512),
  expected_resource_version: z.number().int().positive(),
  /** This is durable Operation evidence, so it never accepts secret text. */
  reason: resourceTransferReasonSchema
}).strict();
const Output = resourceRedactionValueSchema;

export type ResourceRedactInput = z.infer<typeof Input>;

export interface ResourceRedactPorts {
  redactResource(context: TrustedDomainContext, input: ResourceRedactInput): Promise<ResourceRedactionValue>;
}

const resourceRedact = defineCommand<ResourceRedactPorts>()({
  id: "resource.redact",
  version: "1.0",
  availability: "active",
  title: "Redact known secret patterns from a Resource",
  description: "Remove only built-in secret patterns from Room-scoped Knowledge or Skill content without accepting secret text in the request.",
  sources: ["runtime_api", "external_app"],
  effect: "workspace_mutation",
  idempotency: "required",
  concurrency: "optimistic_version",
  render: ["status_timeline"],
  resourceKinds: ["wiki", "skill"],
  proposedEffects: ["Remove detected secret-like values without retaining their original text in rollback evidence."],
  outputResourceKind: "resource_redaction",
  uiDisplayCategory: "workspace",
  provenance: [{
    source: "samurai",
    commit_sha: "workspace-server-05",
    reference_file: "ARCHITECTURE.md",
    decision: "adapted",
    reason: "Secret redaction is explicit, version-checked, Room-authorized, and never accepts arbitrary secret literals from an external Client."
  }],
  input: Input,
  output: Output,
  createHandler(ports) {
    return {
      execute: async function handleResourceRedact(context: TrustedDomainContext, input: ResourceRedactInput): Promise<DomainResult<ResourceRedactionValue>> {
        return { ok: true, value: Output.parse(await ports.redactResource(context, input)) };
      }
    };
  }
});

export default resourceRedact;
