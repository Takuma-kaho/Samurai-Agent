import { z } from "zod";
import { defineQuery, TrustedDomainContextError, type DomainQueryPorts, type DomainResult, type ReadCapability, type TrustedDomainContext } from "../../definition/index.js";

const Input = z.object({ query: z.string().max(10_000).default(""), limit: z.number().int().min(1).max(200).default(5), offset: z.number().int().min(0).max(10_000).default(0) }).strict();
const SearchResult = z.object({
  id: z.string(),
  slug: z.string(),
  title: z.string(),
  file_path: z.string(),
  pinned: z.boolean().optional(),
  version: z.number().int().positive(),
  updated_at: z.string().datetime().optional()
}).strict();
const Output = z.array(SearchResult).max(200);

export interface WikiSearchPorts extends DomainQueryPorts {
  searchWiki: ReadCapability<(context: TrustedDomainContext, query: string, limit: number, offset: number) => Promise<z.infer<typeof Output>>>;
}

const wikiSearch = defineQuery<WikiSearchPorts>()({
  id: "wiki.search",
  version: "3.1",
  availability: "active",
  title: "Search wiki",
  description: "Search active Knowledge Wiki.",
  sources: ["provider_tool_call", "runtime_api", "external_app"],
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
      execute: async function handleWikiSearch(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        return { ok: true, value: Output.parse(await ports.searchWiki(context, input.query, input.limit, input.offset)) };
      }
    };
  }
});

export default wikiSearch;
