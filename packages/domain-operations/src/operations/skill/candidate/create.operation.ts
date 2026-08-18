// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { ProvenanceSchema, ResourceRefSchema, UsageScopeRefSchema, createId, nowIso } from "@samurai-agent/core-schemas";
import { renderSkillMarkdown } from "@samurai-agent/skills";
import { defineCommand, type DomainResult, type TrustedDomainContext } from "../../../definition/index.js";
import { skillWriteValueSchema } from "../../../value-objects/skill.js";
import type { SkillCandidateMutationPorts } from "../skill-mutation.js";

const Input = z.object({
  "content": z.string().max(1_000_000),
  "description": z.string().max(10_000).optional(),
  "provenance_detail": ProvenanceSchema.optional(),
  "required_capabilities": z.array(z.string().trim().min(1).max(256)).max(100).default([]),
  "source_refs": z.array(ResourceRefSchema).max(1_000).default([]),
  "tags": z.array(z.string().max(128)).max(100).default([]),
  "title": z.string().max(512),
  "usage_scope": UsageScopeRefSchema.optional()
}).strict();
const Output = skillWriteValueSchema;

export interface SkillCandidateCreatePorts extends SkillCandidateMutationPorts {}

const skillCandidateCreate = defineCommand<SkillCandidateCreatePorts>()({
  ...{
  "kind": "command",
  "id": "skill.candidate.create",
  "version": "4.0",
  "availability": "active",
  "title": "Create skill candidate",
  "description": "Create a reusable Skill candidate from a reflection or backend pattern.",
  "sources": [
    "runtime_api",
    "scheduled_context",
    "external_app"
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
        if (input.usage_scope?.kind === "session") {
          throw ports.skillMutationConflict("session_scope_write_disabled");
        }
        const contract = ports.skillMutationContract("skill.candidate.create");
        const skillId = createId("skill");
        const markdown = renderSkillMarkdown({
          id: skillId, state: "candidate", title: input.title, description: input.description ?? "", tags: input.tags,
          provenance: "generated_local", trust_level: "generated_local", allowed_scopes: ["skill"],
          required_capabilities: input.required_capabilities, schedule_policy: {}, secret_policy: {}, owner_pinned: false,
          usage_scope: input.usage_scope,
          last_reviewed_at: nowIso(), source_refs: input.source_refs, provenance_detail: input.provenance_detail ?? {
            kind: "generated_local", summary: "Created from a local runtime operation.", verified: false
          }
        }, input.content);
        const result = await ports.runSkillMutation({
          trustedContext: context, operationName: contract.id, inputSummary: `Create skill candidate: ${input.title}`,
          proposedEffects: contract.proposed_effects, boundaryResourceRefs: [{ kind: "skill", id: skillId, uri: `skills/${skillId}`, label: input.title }],
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
