// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { createId, nowIso } from "@samurai-agent/core-schemas";
import { parseSkillMarkdown, renderSkillMarkdown } from "@samurai-agent/skills";
import { defineCommand, type DomainResult, type TrustedDomainContext } from "../../../definition/index.js";
import { skillWriteValueSchema } from "../../../value-objects/skill.js";
import type { SkillProjectMutationPorts } from "../skill-mutation.js";

const Input = z.object({
  "candidate_id": z.string().trim().min(1).max(256)
}).strict();
const Output = skillWriteValueSchema;

export interface SkillProjectSavePorts extends SkillProjectMutationPorts {}

const skillProjectSave = defineCommand<SkillProjectSavePorts>()({
  ...{
  "kind": "command",
  "id": "skill.project.save",
  "version": "3.0",
  "availability": "active",
  "title": "Save project skill",
  "description": "Save a promoted project Skill markdown file.",
  "sources": [
    "runtime_api"
  ],
  "effect": "workspace_mutation",
  "idempotency": "required",
  "concurrency": "append_or_unique",
  "render": [
    "skill"
  ],
  "resourceKinds": [
    "skill"
  ],
  "proposedEffects": [
    "Save a promoted project Skill markdown file."
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
      execute: async function handleSkillProjectSave(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        const candidateMarkdown = await ports.readSkillMarkdown(input.candidate_id);
        if (!candidateMarkdown) throw ports.skillMutationNotFound(`Skill candidate not found: ${input.candidate_id}`);
        const parsed = parseSkillMarkdown(candidateMarkdown);
        if (parsed.frontmatter.state !== "candidate") throw ports.skillMutationConflict("skill_is_not_candidate");
        if (parsed.frontmatter.usage_scope?.kind === "session") throw ports.skillMutationConflict("session_scope_write_disabled");
        const contract = ports.skillMutationContract("skill.project.save");
        const skillId = createId("skill");
        const markdown = renderSkillMarkdown({ ...parsed.frontmatter, id: skillId, state: "project", provenance: `candidate:${input.candidate_id}`, last_reviewed_at: nowIso() }, parsed.content);
        const result = await ports.runSkillMutation({
          trustedContext: context, operationName: contract.id, inputSummary: `Save project skill from candidate: ${input.candidate_id}`,
          proposedEffects: contract.proposed_effects, boundaryResourceRefs: [{ kind: "skill", id: skillId, uri: `skills/${skillId}`, label: parsed.frontmatter.title }],
          execute: async (operation) => {
            const skill = await ports.saveSkillMarkdown({ state: "project", skillId, markdown });
            const ref = ports.skillResourceRef(skill);
            const rollbackPoint = await ports.createSkillRollback(operation, [ref], {}, { skill_id: skill.id, candidate_id: input.candidate_id });
            return { resource: skill, ref, rollbackPoint, summary: `Saved project skill ${skill.title}.` };
          }
        });
        return { ok: true, value: Output.parse(result) };
      }
    };
  }
});

export default skillProjectSave;
