import { z } from "zod";
import { defineQuery, type DomainQueryPorts, type DomainResult, type ReadCapability, type TrustedDomainContext } from "../../definition/index.js";

const Input = z.object({ query: z.string().max(10_000).default(""), limit: z.number().int().min(1).max(8).default(5) }).strict();
const SearchResult = z.object({
  id: z.string(),
  slug: z.string(),
  title: z.string(),
  file_path: z.string()
}).strict();
const Output = z.array(SearchResult).max(8);

export interface WikiSearchPorts extends DomainQueryPorts {
  searchWiki: ReadCapability<(query: string, limit: number) => Promise<z.infer<typeof Output>>>;
}

const wikiSearch = defineQuery<WikiSearchPorts>()({
  id: "wiki.search",
  version: "3.0",
  availability: "active",
  title: "Search wiki",
  description: "Search active Knowledge Wiki.",
  sources: ["provider_tool_call", "runtime_api"],
  render: ["knowledge_wiki"],
  resourceKinds: ["knowledge_wiki"],
  proposedEffects: ["Read wiki pages without changing Workspace state."],
  outputResourceKind: "wiki_search",
  uiDisplayCategory: "memory",
  providerToolNames: ["samurai.wiki.search", "wiki_search", "mcp__samurai__wiki_search"],
  provenance: [{ source: "samurai", commit_sha: "workspace-design-v1", reference_file: "ARCHITECTURE.md", decision: "adapted", reason: "Use a server-owned contract and a shared Runtime boundary for Workspace state." }],
  input: Input,
  output: Output,
  createHandler(ports) {
    return {
      execute: async function handleWikiSearch(_context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        return { ok: true, value: Output.parse(await ports.searchWiki(input.query, input.limit)) };
      }
    };
  }
});

export default wikiSearch;
