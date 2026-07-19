// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { defineCommand, type DomainResult, type TrustedDomainContext } from "../../../definition/index.js";
import { skillWriteValueSchema } from "../../../value-objects/skill.js";

const Input = z.object({
  "skill_id": z.string().trim().min(1).max(256),
  "action": z.enum(["mark_stale", "archive", "reactivate"])
}).strict();
const Output = skillWriteValueSchema;

export type SkillLifecycleApplyInput = z.infer<typeof Input>;
export type SkillLifecycleApplyOutput = z.infer<typeof Output>;

export interface SkillLifecycleApplyPorts {
  applySkillLifecycle(input: { skillId: string; action: SkillLifecycleApplyInput["action"] }): Promise<SkillLifecycleApplyOutput> | SkillLifecycleApplyOutput;
}

const skillLifecycleApply = defineCommand<SkillLifecycleApplyPorts>()({
  ...{
  "kind": "command",
  "id": "skill.lifecycle.apply",
  "version": "3.0",
  "availability": "active",
  "title": "Apply skill lifecycle action",
  "description": "Apply a curator lifecycle transition to a local Skill.",
  "sources": [
    "runtime_api"
  ],
  "effect": "workspace_mutation",
  "idempotency": "required",
  "concurrency": "none",
  "render": [
    "skill"
  ],
  "resourceKinds": [
    "skill"
  ],
  "proposedEffects": [
    "Apply a curator lifecycle transition to a local Skill."
  ],
  "outputResourceKind": "skill",
  "uiDisplayCategory": "skill",
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
      execute: async function handleSkillLifecycleApply(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        return { ok: true, value: Output.parse(await ports.applySkillLifecycle({ skillId: input.skill_id, action: input.action })) };
      }
    };
  }
});

export default skillLifecycleApply;
