// Domain operation module. Keep its contract and handler together.
import { ExecutionScopeSchema, SkillFrontmatterSchema, SkillStateSchema } from "@samurai-agent/core-schemas";
import { z } from "zod";
import { domainJsonValueSchema, defineQuery, type DomainQueryPorts, type DomainResult, type TrustedDomainContext } from "../../definition/index.js";

const Input = z.object({
  "envelope_id": z.string() .optional(),
  "input_locale": z.string() .optional(),
  "input_message_id": z.string() .optional(),
  "metadata": z.record(domainJsonValueSchema) .optional(),
  "output_locale": z.string() .optional(),
  "path": z.string() .optional(),
  "provider_tool_call": z.boolean() .optional(),
  "run_id": z.string(),
  "session_id": z.string() .optional(),
  "skill_id": z.string(),
  "source_operation_id": z.string() .optional(),
  "surface_operation_id": z.string() .optional()
}).strict();
const Output = z.object({
  skill: z.object({
    id: z.string().min(1),
    title: z.string(),
    description: z.string(),
    tags: z.array(z.string()),
    state: SkillStateSchema,
    allowed_scopes: z.array(ExecutionScopeSchema),
    required_capabilities: z.array(z.string()),
    owner_pinned: z.boolean(),
    frontmatter: SkillFrontmatterSchema,
    file_path: z.string().min(1)
  }).strict(),
  content: z.string(),
  file_refs: z.array(z.object({ path: z.string().min(1), file_path: z.string().min(1) }).strict()),
  disclosure_level: z.enum(["body", "support"]),
  usage: z.object({
    skill_id: z.string().min(1),
    run_id: z.string().min(1),
    resource_id: z.string().min(1),
    content_hash: z.string().min(1),
    stage: z.enum(["body_loaded", "support_loaded"]),
    metadata: z.object({ skill_id: z.string().min(1), path: z.string().min(1).optional() }).strict()
  }).strict()
}).strict();

export interface SkillViewPorts extends DomainQueryPorts {
  executeSkillView(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> | DomainResult<z.infer<typeof Output>>;
}

const skillView = defineQuery<SkillViewPorts>()({
  ...{
  "kind": "query",
  "id": "skill.view",
  "version": "1.0",
  "availability": "active",
  "title": "View Skill",
  "description": "Read a selected Skill body or one declared support file on demand.",
  "sources": [
    "provider_tool_call",
    "runtime_api"
  ],
  "effect": "read_only",
  "idempotency": "none",
  "concurrency": "none",
  "render": [
    "skill"
  ],
  "resourceKinds": [
    "skill",
    "skill_support_file"
  ],
  "proposedEffects": [
    "Read skill without changing Workspace state."
  ],
  "outputResourceKind": "skill",
  "uiDisplayCategory": "memory",
  "providerToolNames": [
    "skill.view",
    "samurai.skill.view",
    "mcp__samurai__skill_view"
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
      execute: async function handleSkillView(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        return ports.executeSkillView(context, input);
      }
    };
  }
});

export default skillView;
