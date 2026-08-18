// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { domainJsonValueSchema, defineCommand, type DomainResult, type TrustedDomainContext } from "../../definition/index.js";
import { skillWriteValueSchema } from "../../value-objects/skill.js";
import type { SkillPatchMutationPorts } from "./skill-mutation.js";

const Input = z.object({
  "content": z.string().max(1_000_000).optional(),
  "description": z.string().max(10_000).optional(),
  "expected_resource_version": z.number().int().positive().optional(),
  "pinned": z.boolean().optional(),
  "skill_id": z.string().trim().min(1).max(256),
  "tags": z.array(z.string().max(128)).max(100).optional(),
  "title": z.string().max(512).optional()
}).strict();
const Output = skillWriteValueSchema;

export interface SkillPatchPorts extends SkillPatchMutationPorts {}

const skillPatch = defineCommand<SkillPatchPorts>()({
  ...{
  "kind": "command",
  "id": "skill.patch",
  "version": "3.0",
  "availability": "active",
  "title": "Edit Skill",
  "description": "Edit a Skill body and metadata through the Runtime boundary.",
  "sources": [
    "runtime_api",
    "external_app",
    "provider_tool_call",
    "surface_operation"
  ],
  "effect": "workspace_mutation",
  "idempotency": "required",
  "concurrency": "optimistic_version",
  "render": [
    "skill"
  ],
  "resourceKinds": [
    "skill"
  ],
  "proposedEffects": [
    "Update a Skill body and metadata with history and rollback evidence."
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
      execute: async function handleSkillPatch(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        const current = await ports.getSkillForMutation(input.skill_id);
        if (!current) throw ports.skillMutationNotFound("skill_not_found");
        const beforeMarkdown = await ports.readSkillMarkdown(input.skill_id);
        const contract = ports.skillMutationContract("skill.patch");
        const result = await ports.runSkillMutation({
          trustedContext: context, operationName: contract.id, inputSummary: `Edit Skill: ${current.title}`, proposedEffects: contract.proposed_effects,
          targetResourceRefs: [ports.skillResourceRef(current)],
          execute: async (operation) => {
            let saved;
            try {
              saved = await ports.patchSkillRecord({ id: input.skill_id, title: input.title, description: input.description, tags: input.tags, content: input.content, pinned: input.pinned, expected_resource_version: input.expected_resource_version });
            } catch (error) {
              throw ports.mapSkillWriteError(error);
            }
            if (!saved) throw ports.skillMutationNotFound("skill_not_found");
            const ref = ports.skillResourceRef(saved);
            const rollbackPoint = await ports.createSkillRollback(operation, [ref], { skill: domainJsonValueSchema.parse(current), markdown: beforeMarkdown ?? "" }, { skill: domainJsonValueSchema.parse(saved) });
            return { resource: saved, ref, rollbackPoint, summary: `Updated Skill ${saved.title}.` };
          }
        });
        return { ok: true, value: Output.parse(result) };
      }
    };
  }
});

export default skillPatch;
