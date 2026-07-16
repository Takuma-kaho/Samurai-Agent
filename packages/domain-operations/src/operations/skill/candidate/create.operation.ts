// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { ProvenanceSchema, ResourceRefSchema, createId, nowIso } from "@samurai-agent/core-schemas";
import { renderSkillMarkdown } from "@samurai-agent/skills";
import { domainJsonValueSchema, defineCommand, type DomainResult, type TrustedDomainContext } from "../../../definition/index.js";
import { skillWriteValueSchema } from "../../../value-objects/skill.js";
import type { SkillCandidateMutationPorts } from "../skill-mutation.js";

const Input = z.object({
  "content": z.string(),
  "description": z.string() .optional(),
  "envelope_id": z.string() .optional(),
  "input_locale": z.string() .optional(),
  "input_message_id": z.string() .optional(),
  "metadata": z.record(domainJsonValueSchema) .optional(),
  "output_locale": z.string() .optional(),
  "provenance_detail": ProvenanceSchema.optional(),
  "provider_tool_call": z.boolean() .optional(),
  "required_capabilities": z.array(z.string().trim().min(1)) .optional(),
  "session_id": z.string() .optional(),
  "source_operation_id": z.string() .optional(),
  "source_refs": z.array(ResourceRefSchema) .optional(),
  "surface_operation_id": z.string() .optional(),
  "tags": z.array(z.string()) .optional(),
  "title": z.string()
}).strict();
const Output = skillWriteValueSchema;

export interface SkillCandidateCreatePorts extends SkillCandidateMutationPorts {}

const skillCandidateCreate = defineCommand<SkillCandidateCreatePorts>()({
  ...{
  "kind": "command",
  "id": "skill.candidate.create",
  "version": "3.0",
  "availability": "active",
  "title": "Create skill candidate",
  "description": "Create a reusable Skill candidate from a reflection or backend pattern.",
  "sources": [
    "runtime_api",
    "scheduled_context"
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
    "Create a local Skill candidate markdown file."
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
      execute: async function handleSkillCandidateCreate(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        const contract = ports.skillMutationContract("skill.candidate.create");
        const skillId = createId("skill");
        const markdown = renderSkillMarkdown({
          id: skillId, state: "candidate", title: input.title, description: input.description ?? "", tags: input.tags ?? [],
          provenance: "generated_local", trust_level: "generated_local", allowed_scopes: ["skill"],
          required_capabilities: input.required_capabilities ?? [], schedule_policy: {}, secret_policy: {}, owner_pinned: false,
          last_reviewed_at: nowIso(), source_refs: input.source_refs ?? [], provenance_detail: input.provenance_detail ?? {
            kind: "generated_local", summary: "Created from a local runtime operation.", verified: false
          }
        }, input.content);
        const session = await ports.ensureSkillMutationSession();
        const envelope = ports.createSkillMutationEnvelope(`Create skill candidate: ${input.title}`);
        const result = await ports.runSkillMutation({
          session, envelope, operationName: contract.id, proposedEffects: contract.proposed_effects,
          execute: async (operation) => {
            const skill = await ports.saveSkillMarkdown({ state: "candidate", skillId, markdown });
            const ref = ports.skillResourceRef(skill);
            const rollbackPoint = await ports.createSkillRollback(operation, [ref], {}, { skill_id: skill.id });
            return { resource: skill, ref, rollbackPoint, summary: `Created skill candidate ${skill.title}.` };
          }
        });
        return { ok: true, value: Output.parse(result) };
      }
    };
  }
});

export default skillCandidateCreate;
