// Domain operation module. Keep its contract and handler together.
import {
  LearningEvidenceStateSchema,
  LearningResourceVersionRecordSchema,
  LearningUsageStateSchema,
  UsageScopeRefSchema
} from "@samurai-agent/core-schemas";
import { z } from "zod";
import { defineCommand, type DomainResult, type TrustedDomainContext } from "../../../../definition/index.js";

const Input = z.object({
  resource_kind: z.enum(["memory", "wiki", "skill"]),
  resource_id: z.string().trim().min(1).max(512),
  change_reason: z.string().trim().min(1).max(2_000),
  content: z.string().min(1).max(1_000_000).optional(),
  usage_scope: UsageScopeRefSchema.optional(),
  evidence_state: LearningEvidenceStateSchema.optional(),
  usage_state: LearningUsageStateSchema.optional(),
  pinned: z.boolean().optional()
}).strict().superRefine((value, context) => {
  if (
    value.content === undefined
    && value.usage_scope === undefined
    && value.evidence_state === undefined
    && value.usage_state === undefined
    && value.pinned === undefined
  ) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "learning_resource_version_update_requires_change" });
  }
});
const Output = z.object({ resource_version: LearningResourceVersionRecordSchema }).strict();

export type LearningResourceVersionUpdateInput = z.infer<typeof Input>;
export type LearningResourceVersionUpdateOutput = z.infer<typeof Output>;

export interface LearningResourceVersionUpdatePorts {
  updateLearningResourceVersion(input: {
    resourceKind: LearningResourceVersionUpdateInput["resource_kind"];
    resourceId: string;
    changeReason: string;
    content?: string;
    usageScope?: LearningResourceVersionUpdateInput["usage_scope"];
    evidenceState?: LearningResourceVersionUpdateInput["evidence_state"];
    usageState?: LearningResourceVersionUpdateInput["usage_state"];
    pinned?: boolean;
  }): Promise<LearningResourceVersionUpdateOutput> | LearningResourceVersionUpdateOutput;
}

const learningResourceVersionUpdate = defineCommand<LearningResourceVersionUpdatePorts>()({
  ...{
    kind: "command",
    id: "learning.resource.version.update",
    version: "1.0",
    availability: "active",
    title: "Update Learning Resource version",
    description: "Edit one Learning Resource through a new immutable Version.",
    sources: ["runtime_api"],
    effect: "workspace_mutation",
    idempotency: "required",
    concurrency: "optimistic_version",
    render: ["status_timeline"],
    resourceKinds: ["memory", "wiki", "skill", "learning_resource_version"],
    proposedEffects: ["Create one new Resource Version for an explicit edit, correction, or Scope change without deleting history."],
    outputResourceKind: "learning_resource_version",
    uiDisplayCategory: "memory",
    provenance: [{
      source: "samurai",
      commit_sha: "workspace-design-v1",
      reference_file: "ARCHITECTURE.md",
      decision: "adapted",
      reason: "Keep explicit Resource edits in the trusted Runtime and Workspace Store version boundary."
    }]
  },
  input: Input,
  output: Output,
  createHandler(ports) {
    return {
      execute: async function handleLearningResourceVersionUpdate(
        _context: TrustedDomainContext,
        input: LearningResourceVersionUpdateInput
      ): Promise<DomainResult<LearningResourceVersionUpdateOutput>> {
        return {
          ok: true,
          value: Output.parse(await ports.updateLearningResourceVersion({
            resourceKind: input.resource_kind,
            resourceId: input.resource_id,
            changeReason: input.change_reason,
            ...(input.content === undefined ? {} : { content: input.content }),
            ...(input.usage_scope === undefined ? {} : { usageScope: input.usage_scope }),
            ...(input.evidence_state === undefined ? {} : { evidenceState: input.evidence_state }),
            ...(input.usage_state === undefined ? {} : { usageState: input.usage_state }),
            ...(input.pinned === undefined ? {} : { pinned: input.pinned })
          }))
        };
      }
    };
  }
});

export default learningResourceVersionUpdate;
