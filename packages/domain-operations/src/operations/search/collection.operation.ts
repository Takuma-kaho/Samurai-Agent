import { z } from "zod";
import { domainJsonValueSchema, defineQuery, type DomainQueryPorts, type DomainResult, type ReadCapability, type TrustedDomainContext } from "../../definition/index.js";

const Input = z.object({ collection_id: z.string().trim().max(256).optional(), query: z.string().max(10_000).default(""), limit: z.number().int().min(1).max(8).default(5) }).strict();
const SearchResult = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("collection_schema"), id: z.string(), file_path: z.string() }).strict(),
  z.object({
    kind: z.literal("collection_record"),
    collection_id: z.string(),
    id: z.string(),
    file_path: z.string(),
    summary: z.string(),
    data: z.record(domainJsonValueSchema)
  }).strict()
]);
const Output = z.array(SearchResult).max(8);

export interface CollectionSearchPorts extends DomainQueryPorts {
  searchCollections: ReadCapability<(collectionId: string | undefined, query: string, limit: number) => Promise<z.infer<typeof Output>>>;
}

const collectionSearch = defineQuery<CollectionSearchPorts>()({
  kind: "query",
  id: "collection.search",
  version: "3.0",
  availability: "active",
  title: "Search collections",
  description: "Search local Collection records.",
  sources: ["provider_tool_call", "runtime_api"],
  render: ["collection"],
  resourceKinds: ["collection_schema", "collection_record"],
  proposedEffects: ["Read Collections without changing Workspace state."],
  outputResourceKind: "collection_search",
  uiDisplayCategory: "collection",
  providerToolNames: ["samurai.collection.search", "collection_search", "mcp__samurai__collection_search"],
  provenance: [{ source: "samurai", commit_sha: "workspace-design-v1", reference_file: "ARCHITECTURE.md", decision: "adapted", reason: "Use a server-owned contract and a shared Runtime boundary for Workspace state." }],
  input: Input,
  output: Output,
  createHandler(ports) {
    return {
      execute: async function handleCollectionSearch(_context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        return { ok: true, value: Output.parse(await ports.searchCollections(input.collection_id, input.query, input.limit)) };
      }
    };
  }
});

export default collectionSearch;
