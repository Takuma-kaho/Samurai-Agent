import { z } from "zod";
import { defineQuery, type DomainQueryPorts, type DomainResult, type ReadCapability, type TrustedDomainContext } from "../../definition/index.js";

const Input = z.object({ query: z.string().max(10_000).default(""), limit: z.number().int().min(1).max(8).default(5) }).strict();
const SearchResult = z.object({
  kind: z.enum(["session", "message", "artifact", "audit"]),
  id: z.string(),
  title: z.string(),
  summary: z.string(),
  session_id: z.string().optional()
}).strict();
const Output = z.array(SearchResult).max(8);
export interface SessionSearchPorts extends DomainQueryPorts {
  searchSessions: ReadCapability<(context: TrustedDomainContext, query: string, limit: number) => Promise<z.infer<typeof Output>>>;
}
const sessionSearch = defineQuery<SessionSearchPorts>()({
  id: "session.search", version: "3.0", availability: "active", title: "Search sessions", description: "Search previous sessions.",
  sources: ["provider_tool_call", "runtime_api"], render: ["status_timeline"], resourceKinds: ["session"], proposedEffects: ["Read sessions without changing Workspace state."], outputResourceKind: "session_search", uiDisplayCategory: "workspace", providerToolNames: ["samurai.session.search", "session_search", "mcp__samurai__session_search"], provenance: [{ source: "samurai", commit_sha: "workspace-design-v1", reference_file: "ARCHITECTURE.md", decision: "adapted", reason: "Use a server-owned contract and a shared Runtime boundary for Workspace state." }], input: Input, output: Output,
  createHandler(ports) { return { execute: async function handleSessionSearch(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> { return { ok: true, value: Output.parse(await ports.searchSessions(context, input.query, input.limit)) }; } }; }
});
export default sessionSearch;
