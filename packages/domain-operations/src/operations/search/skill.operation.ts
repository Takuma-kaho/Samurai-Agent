import { z } from "zod";
import { defineQuery, TrustedDomainContextError, type DomainQueryPorts, type DomainResult, type ReadCapability, type TrustedDomainContext } from "../../definition/index.js";

const Input = z.object({ query: z.string().max(10_000).default(""), limit: z.number().int().min(1).max(8).default(5) }).strict();
const SearchResult = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  tags: z.array(z.string()),
  file_path: z.string()
}).strict();
const Output = z.array(SearchResult).max(8);

export interface SkillSearchPorts extends DomainQueryPorts {
  searchSkills: ReadCapability<(runId: string, query: string, limit: number) => Promise<z.infer<typeof Output>>>;
}

const skillSearch = defineQuery<SkillSearchPorts>()({
  id: "skill.search",
  version: "3.1",
  availability: "active",
  title: "Search skills",
  description: "Search reusable Skills.",
  sources: ["provider_tool_call", "runtime_api"],
  render: ["skill"],
  resourceKinds: ["skill"],
  proposedEffects: ["Read skills without changing Workspace state."],
  outputResourceKind: "skill_search",
  uiDisplayCategory: "memory",
  providerToolNames: ["samurai.skill.search", "skill_search", "mcp__samurai__skill_search"],
  provenance: [{ source: "samurai", commit_sha: "workspace-design-v1", reference_file: "ARCHITECTURE.md", decision: "adapted", reason: "Use a server-owned contract and a shared Runtime boundary for Workspace state." }],
  input: Input,
  output: Output,
  createHandler(ports) {
    return {
      execute: async function handleSkillSearch(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        if (!context.runId) throw new TrustedDomainContextError("skill.search", "runId");
        return { ok: true, value: Output.parse(await ports.searchSkills(context.runId, input.query, input.limit)) };
      }
    };
  }
});

export default skillSearch;
