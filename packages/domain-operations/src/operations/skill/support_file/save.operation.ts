// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { domainJsonValueSchema, defineCommand, type DomainResult, type TrustedDomainContext } from "../../../definition/index.js";
import { skillSupportFileWriteValueSchema } from "../../../value-objects/skill.js";
import type { SkillSupportFileMutationPorts } from "../skill-mutation.js";

const Input = z.object({
  "content": z.string() .optional(),
  "envelope_id": z.string() .optional(),
  "input_locale": z.string() .optional(),
  "input_message_id": z.string() .optional(),
  "metadata": z.record(domainJsonValueSchema) .optional(),
  "output_locale": z.string() .optional(),
  "path": z.string(),
  "provider_tool_call": z.boolean() .optional(),
  "session_id": z.string() .optional(),
  "skill_id": z.string(),
  "source_operation_id": z.string() .optional(),
  "surface_operation_id": z.string() .optional()
}).strict();
const Output = skillSupportFileWriteValueSchema;

export interface SkillSupportFileSavePorts extends SkillSupportFileMutationPorts {}

const skillSupportFileSave = defineCommand<SkillSupportFileSavePorts>()({
  ...{
  "kind": "command",
  "id": "skill.support_file.save",
  "version": "2.0",
  "availability": "active",
  "title": "Save skill support file",
  "description": "Save a support file for a local Skill.",
  "sources": [
    "runtime_api",
    "provider_tool_call"
  ],
  "effect": "workspace_mutation",
  "idempotency": "required",
  "concurrency": "append_or_unique",
  "render": [
    "skill"
  ],
  "resourceKinds": [
    "skill",
    "skill_support_file"
  ],
  "proposedEffects": [
    "Save a support file for a local Skill."
  ],
  "outputResourceKind": "skill_support_file",
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
      execute: async function handleSkillSupportFileSave(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        const skill = await ports.getSkillForMutation(input.skill_id);
        if (!skill) throw ports.skillMutationNotFound(`Skill not found: ${input.skill_id}`);
        const before = (await ports.listSkillSupportFiles(input.skill_id)).find((file) => file.path === input.path);
        const contract = ports.skillMutationContract("skill.support_file.save");
        const session = await ports.ensureSkillMutationSession();
        const envelope = ports.createSkillMutationEnvelope(`Save Skill support file: ${skill.title}/${input.path}`);
        const result = await ports.runSkillMutation({
          session, envelope, operationName: contract.id, proposedEffects: contract.proposed_effects,
          targetResourceRefs: [ports.skillResourceRef(skill)],
          execute: async (operation) => {
            const supportFile = await ports.writeSkillSupportFile({ skillId: input.skill_id, path: input.path, content: input.content ?? "" });
            const saved = { skill_id: skill.id, ...supportFile };
            const ref = { kind: "skill_support", id: `${skill.id}:${saved.path}`, uri: saved.file_path, label: saved.path };
            const rollbackPoint = await ports.createSkillRollback(operation, [ref], { path: saved.file_path, content: before?.content ?? null }, { path: saved.file_path, content: saved.content });
            return { resource: saved, ref, rollbackPoint, summary: `Saved support file ${saved.path} for Skill ${skill.title}.` };
          }
        });
        return { ok: true, value: Output.parse(result) };
      }
    };
  }
});

export default skillSupportFileSave;
