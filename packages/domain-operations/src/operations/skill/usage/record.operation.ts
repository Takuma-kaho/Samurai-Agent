// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { domainJsonValueSchema, defineCommand, TrustedDomainContextError, type DomainResult, type TrustedDomainContext } from "../../../definition/index.js";
import { skillUsageRecordValueSchema } from "../../../value-objects/skill.js";

const Input = z.object({
  "skill_id": z.string().trim().min(1).max(256),
  "resource_id": z.string().trim().min(1).max(512),
  "content_hash": z.string().trim().min(1).max(256),
  "stage": z.enum(["body_loaded", "support_loaded"]),
  "metadata": z.record(domainJsonValueSchema).default({})
}).strict();
const Output = skillUsageRecordValueSchema;

export type SkillUsageRecordInput = z.infer<typeof Input>;
export type SkillUsageRecordOutput = z.infer<typeof Output>;

export interface SkillUsageRecordPorts {
  recordSkillUsage(input: {
    skillId: string;
    runId: string;
    resourceId: string;
    contentHash: string;
    stage: SkillUsageRecordInput["stage"];
    metadata: Record<string, z.infer<typeof domainJsonValueSchema>>;
  }): Promise<SkillUsageRecordOutput> | SkillUsageRecordOutput;
}

const skillUsageRecord = defineCommand<SkillUsageRecordPorts>()({
  ...{
  "kind": "command",
  "id": "skill.usage.record",
  "version": "3.1",
  "availability": "active",
  "title": "Record Skill usage",
  "description": "Record that a Backend run used a Skill body or declared support file.",
  "sources": [
    "provider_tool_call",
    "runtime_api"
  ],
  "effect": "workspace_mutation",
  "idempotency": "required",
  "concurrency": "none",
  "render": [
    "status_timeline"
  ],
  "resourceKinds": [
    "skill",
    "skill_support_file",
    "skill_usage"
  ],
  "proposedEffects": [
    "Persist Skill usage separately from the read-only Skill view query."
  ],
  "outputResourceKind": "skill_usage",
  "uiDisplayCategory": "memory",
  "provenance": [
    {
      "source": "samurai",
      "commit_sha": "workspace-design-v1",
      "reference_file": "ARCHITECTURE.md",
      "decision": "adapted",
      "reason": "Use a server-owned contract and a shared Runtime boundary for Workspace state."
    }
  ]
},
  input: Input,
  output: Output,
  createHandler(ports) {
    return {
      execute: async function handleSkillUsageRecord(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        if (!context.runId) throw new TrustedDomainContextError("skill.usage.record", "runId");
        return { ok: true, value: Output.parse(await ports.recordSkillUsage({
          skillId: input.skill_id,
          runId: context.runId,
          resourceId: input.resource_id,
          contentHash: input.content_hash,
          stage: input.stage,
          metadata: input.metadata
        })) };
      }
    };
  }
});

export default skillUsageRecord;
