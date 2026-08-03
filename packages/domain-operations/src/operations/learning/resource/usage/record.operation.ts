// Domain operation module. Keep its contract and handler together.
import { LearningResourceUseRecordSchema } from "@samurai-agent/core-schemas";
import { z } from "zod";
import { defineCommand, TrustedDomainContextError, type DomainResult, type TrustedDomainContext } from "../../../../definition/index.js";

const Input = z.object({
  resource_kind: z.enum(["memory", "wiki", "skill"]),
  resource_id: z.string().trim().min(1).max(512),
  resource_version: z.string().trim().min(1).max(256),
  content_hash: z.string().trim().min(1).max(256),
  decision_summary: z.string().trim().min(1).max(2_000),
  matched_conditions: z.array(z.string().trim().min(1).max(500)).min(1).max(50)
}).strict();
const Output = z.object({ use_record: LearningResourceUseRecordSchema }).strict();

export type LearningResourceUsageRecordInput = z.infer<typeof Input>;
export type LearningResourceUsageRecordOutput = z.infer<typeof Output>;

export interface LearningResourceUsageRecordPorts {
  recordAppliedLearningResourceUse(input: {
    runId: string;
    resourceKind: LearningResourceUsageRecordInput["resource_kind"];
    resourceId: string;
    resourceVersion: string;
    contentHash: string;
    decisionSummary: string;
    matchedConditions: string[];
  }): Promise<LearningResourceUsageRecordOutput> | LearningResourceUsageRecordOutput;
}

const learningResourceUsageRecord = defineCommand<LearningResourceUsageRecordPorts>()({
  ...{
    kind: "command",
    id: "learning.resource.usage.record",
    version: "1.0",
    availability: "active",
    title: "Record applied learning resource",
    description: "Record that a loaded Learning resource was actually used for a decision or action.",
    sources: ["provider_tool_call", "runtime_api"],
    effect: "workspace_mutation",
    idempotency: "required",
    concurrency: "none",
    render: ["status_timeline"],
    resourceKinds: ["learning_resource_use", "memory", "wiki", "skill"],
    proposedEffects: ["Persist an exact-version applied record only after the Resource body was loaded in the same Backend Run."],
    outputResourceKind: "learning_resource_use",
    uiDisplayCategory: "memory",
    providerToolNames: [
      "samurai.learning.resource.usage.record",
      "record_resource_application",
      "mcp__samurai__record_resource_application"
    ],
    provenance: [{
      source: "samurai",
      commit_sha: "workspace-design-v1",
      reference_file: "ARCHITECTURE.md",
      decision: "adapted",
      reason: "Record actual Resource use through the trusted Runtime boundary."
    }]
  },
  input: Input,
  output: Output,
  createHandler(ports) {
    return {
      execute: async function handleLearningResourceUsageRecord(
        context: TrustedDomainContext,
        input: LearningResourceUsageRecordInput
      ): Promise<DomainResult<LearningResourceUsageRecordOutput>> {
        if (!context.runId) throw new TrustedDomainContextError("learning.resource.usage.record", "runId");
        return {
          ok: true,
          value: Output.parse(await ports.recordAppliedLearningResourceUse({
            runId: context.runId,
            resourceKind: input.resource_kind,
            resourceId: input.resource_id,
            resourceVersion: input.resource_version,
            contentHash: input.content_hash,
            decisionSummary: input.decision_summary,
            matchedConditions: input.matched_conditions
          }))
        };
      }
    };
  }
});

export default learningResourceUsageRecord;
