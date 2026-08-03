// Domain operation module. Keep its contract and handler together.
import { LearningResourceVersionRecordSchema } from "@samurai-agent/core-schemas";
import { z } from "zod";
import { defineCommand, type DomainResult, type TrustedDomainContext } from "../../../../definition/index.js";

const Input = z.object({
  resource_kind: z.enum(["memory", "wiki", "skill"]),
  resource_id: z.string().trim().min(1).max(512),
  target_version: z.string().trim().min(1).max(256),
  reason: z.string().trim().min(1).max(2_000).optional()
}).strict();
const Output = z.object({ resource_version: LearningResourceVersionRecordSchema }).strict();

export type LearningResourceVersionRestoreInput = z.infer<typeof Input>;
export type LearningResourceVersionRestoreOutput = z.infer<typeof Output>;

export interface LearningResourceVersionRestorePorts {
  restoreLearningResourceVersion(input: {
    resourceKind: LearningResourceVersionRestoreInput["resource_kind"];
    resourceId: string;
    targetVersion: string;
    reason?: string;
  }): Promise<LearningResourceVersionRestoreOutput> | LearningResourceVersionRestoreOutput;
}

const learningResourceVersionRestore = defineCommand<LearningResourceVersionRestorePorts>()({
  ...{
    kind: "command",
    id: "learning.resource.version.restore",
    version: "1.0",
    availability: "active",
    title: "Restore Learning Resource version",
    description: "Restore one historical Learning Resource document as a new current Version.",
    sources: ["runtime_api"],
    effect: "workspace_mutation",
    idempotency: "required",
    concurrency: "none",
    render: ["status_timeline"],
    resourceKinds: ["memory", "wiki", "skill", "learning_resource_version"],
    proposedEffects: ["Create a new current Version from one historical Workspace document without deleting history."],
    outputResourceKind: "learning_resource_version",
    uiDisplayCategory: "memory",
    provenance: [{
      source: "samurai",
      commit_sha: "workspace-design-v1",
      reference_file: "ARCHITECTURE.md",
      decision: "adapted",
      reason: "Restore Resource-local history through the trusted Runtime and Workspace Store boundary."
    }]
  },
  input: Input,
  output: Output,
  createHandler(ports) {
    return {
      execute: async function handleLearningResourceVersionRestore(
        _context: TrustedDomainContext,
        input: LearningResourceVersionRestoreInput
      ): Promise<DomainResult<LearningResourceVersionRestoreOutput>> {
        return {
          ok: true,
          value: Output.parse(await ports.restoreLearningResourceVersion({
            resourceKind: input.resource_kind,
            resourceId: input.resource_id,
            targetVersion: input.target_version,
            ...(input.reason === undefined ? {} : { reason: input.reason })
          }))
        };
      }
    };
  }
});

export default learningResourceVersionRestore;
