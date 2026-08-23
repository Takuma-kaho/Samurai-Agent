// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { defineCommand, requireRoomContext, type DomainResult, type TrustedDomainContext } from "../../../definition/index.js";
import { skillOptimizationRollbackValueSchema } from "../../../value-objects/skill.js";

const Input = z.object({
  "promotion_id": z.string().trim().min(1).max(256).optional(),
  "snapshot_id": z.string().trim().min(1).max(256).optional()
}).strict().refine((value) => Boolean(value.promotion_id || value.snapshot_id), {
  message: "promotion_id_or_snapshot_id_required"
});
const Output = skillOptimizationRollbackValueSchema;

export type SkillOptimizationRollbackInput = z.infer<typeof Input>;
export type SkillOptimizationRollbackOutput = z.infer<typeof Output>;

export interface SkillOptimizationRollbackPorts {
  rollbackSkillOptimization(input: { promotionId?: string; snapshotId?: string; roomId: string }): Promise<SkillOptimizationRollbackOutput> | SkillOptimizationRollbackOutput;
}

const skillOptimizationRollback = defineCommand<SkillOptimizationRollbackPorts>()({
  ...{
  "kind": "command",
  "id": "skill.optimization.rollback",
  "version": "2.0",
  "availability": "active",
  "title": "Rollback Skill improvement",
  "description": "Restore a promoted Skill from its immutable pre-promotion snapshot.",
  "sources": [
    "runtime_api",
    "provider_tool_call"
  ],
  "effect": "workspace_mutation",
  "idempotency": "required",
  "concurrency": "none",
  "render": [
    "skill"
  ],
  "resourceKinds": [
    "skill",
    "skill_optimization_snapshot",
    "optimization_promotion"
  ],
  "proposedEffects": [
    "Restore the Skill from a saved snapshot while preserving promotion provenance."
  ],
  "outputResourceKind": "skill",
  "uiDisplayCategory": "skill",
  "providerToolNames": [
    "samurai.skill.optimization.rollback",
    "skill.optimization.rollback",
    "rollback_skill_optimization",
    "mcp__samurai__skill_optimization_rollback"
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
      execute: async function handleSkillOptimizationRollback(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        return { ok: true, value: Output.parse(await ports.rollbackSkillOptimization({
          ...(input.promotion_id ? { promotionId: input.promotion_id } : {}),
          ...(input.snapshot_id ? { snapshotId: input.snapshot_id } : {}),
          roomId: requireRoomContext(context, "skill.optimization.rollback")
        })) };
      }
    };
  }
});

export default skillOptimizationRollback;
