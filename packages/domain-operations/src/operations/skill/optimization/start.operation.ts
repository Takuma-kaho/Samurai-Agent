// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { domainJsonValueSchema, defineCommand, requireRoomContext, type DomainResult, type TrustedDomainContext } from "../../../definition/index.js";
import { skillOptimizationStartValueSchema } from "../../../value-objects/skill.js";

const Input = z.object({
  "skill_id": z.string().trim().min(1).max(256),
  "objective": z.string().trim().min(1).max(10_000).optional(),
  "golden_examples": z.array(domainJsonValueSchema).max(1_000).optional(),
  "synthetic_examples": z.array(domainJsonValueSchema).max(1_000).optional()
}).strict();
const Output = skillOptimizationStartValueSchema;

export type SkillOptimizationStartInput = z.infer<typeof Input>;
export type SkillOptimizationStartOutput = z.infer<typeof Output>;

export interface SkillOptimizationStartPorts {
  startSkillOptimization(input: {
    skillId: string;
    sessionId?: string;
    roomId: string;
    objective?: string;
    goldenExamples?: readonly z.infer<typeof domainJsonValueSchema>[];
    syntheticExamples?: readonly z.infer<typeof domainJsonValueSchema>[];
  }): Promise<SkillOptimizationStartOutput> | SkillOptimizationStartOutput;
}

const skillOptimizationStart = defineCommand<SkillOptimizationStartPorts>()({
  ...{
  "kind": "command",
  "id": "skill.optimization.start",
  "version": "3.0",
  "availability": "active",
  "title": "Start Skill improvement",
  "description": "Run the locked GEPA Skill improvement worker and save reviewable candidates.",
  "sources": [
    "runtime_api",
    "automation",
    "provider_tool_call"
  ],
  "effect": "workspace_mutation",
  "idempotency": "required",
  "concurrency": "none",
  "render": [
    "status_timeline"
  ],
  "resourceKinds": [
    "skill",
    "skill_optimization_run",
    "optimization_candidate",
    "optimization_dataset",
    "work_item"
  ],
  "proposedEffects": [
    "Create an immutable Skill improvement run and candidate without changing the original Skill."
  ],
  "outputResourceKind": "skill_optimization_run",
  "uiDisplayCategory": "skill",
  "providerToolNames": [
    "samurai.skill.optimization.start",
    "skill.optimization.start",
    "start_skill_optimization",
    "mcp__samurai__skill_optimization_start"
  ],
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
      execute: async function handleSkillOptimizationStart(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        return { ok: true, value: Output.parse(await ports.startSkillOptimization({
          skillId: input.skill_id,
          ...(context.sessionId ? { sessionId: context.sessionId } : {}),
          roomId: requireRoomContext(context, "skill.optimization.start"),
          ...(input.objective ? { objective: input.objective } : {}),
          ...(input.golden_examples ? { goldenExamples: input.golden_examples } : {}),
          ...(input.synthetic_examples ? { syntheticExamples: input.synthetic_examples } : {})
        })) };
      }
    };
  }
});

export default skillOptimizationStart;
