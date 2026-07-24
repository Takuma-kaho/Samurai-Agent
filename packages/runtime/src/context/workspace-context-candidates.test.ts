import { describe, expect, it } from "vitest";
import { buildKnowledgeWikiContext, type WikiContextPage } from "./workspace-context-candidates.js";

describe("workspace context candidates", () => {
  it("excludes inactive and empty wiki pages while preserving provenance", async () => {
    const store = {
      searchWiki: async (): Promise<WikiContextPage[]> => [
        { id: "active", slug: "active", title: "Active", state: "active", source_refs: [], provenance: { kind: "user_authored", summary: "fixture", verified: true }, file_path: "wiki/active.md" },
        { id: "draft", slug: "draft", title: "Draft", state: "proposed", source_refs: [], provenance: { kind: "user_authored", summary: "fixture", verified: true }, file_path: "wiki/draft.md" },
        { id: "empty", slug: "empty", title: "Empty", state: "active", source_refs: [], provenance: { kind: "user_authored", summary: "fixture", verified: true }, file_path: "wiki/empty.md" }
      ],
      readWikiContent: async (id: string) => id === "active" ? "本文" : ""
    };
    const result = await buildKnowledgeWikiContext(store, "query");
    expect(result.entries.map((entry) => entry.id)).toEqual(["active"]);
    expect(result.report.excluded.map((item) => item.reason)).toEqual(["proposed", "empty_content"]);
  });
});
