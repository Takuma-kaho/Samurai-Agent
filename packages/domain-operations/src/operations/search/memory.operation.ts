import { z } from "zod";
import { defineQuery, TrustedDomainContextError, type DomainQueryPorts, type DomainResult, type ReadCapability, type TrustedDomainContext } from "../../definition/index.js";

const Input = z.object({ query: z.string().max(10_000).default(""), limit: z.number().int().min(1).max(8).default(5) }).strict();
const SearchResult = z.object({
  id: z.string(),
  topic: z.string(),
  state: z.enum(["session", "provisional", "active", "sensitive", "topic"]),
  file_path: z.string()
}).strict();
const Output = z.array(SearchResult).max(8);

export interface MemorySearchPorts extends DomainQueryPorts {
  searchMemory: ReadCapability<(context: TrustedDomainContext, query: string, limit: number) => Promise<z.infer<typeof Output>>>;
}

const memorySearch = defineQuery<MemorySearchPorts>()({
  id: "memory.search",
  version: "4.1",
  availability: "active",
  title: "Search memory",
  description: "Search active memory.",
  sources: ["provider_tool_call", "runtime_api"],
  render: ["memory"],
  resourceKinds: ["memory"],
  proposedEffects: ["Read memory without changing Workspace state."],
  outputResourceKind: "memory_search",
  uiDisplayCategory: "memory",
  providerToolNames: ["samurai.memory.search", "memory_search", "mcp__samurai__memory_search"],
  provenance: [{ source: "samurai", commit_sha: "workspace-design-v1", reference_file: "ARCHITECTURE.md", decision: "adapted", reason: "Use a server-owned contract and a shared Runtime boundary for Workspace state." }],
  input: Input,
  output: Output,
  createHandler(ports) {
    return {
      execute: async function handleMemorySearch(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        if (!context.runId) throw new TrustedDomainContextError("memory.search", "runId");
        return { ok: true, value: Output.parse(await ports.searchMemory(context, input.query, input.limit)) };
      }
    };
  }
});

export default memorySearch;
