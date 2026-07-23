import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { nowIso } from "@samurai-agent/core-schemas";
import { WorkspaceStore } from "@samurai-agent/workspace-store";
import { buildContextPreview } from "./context-preview.js";
import { WorkspaceContextPreviewAdapter } from "./workspace-context-preview-adapter.js";

describe("workspace context preview adapter", () => {
  it("connects a temporary Workspace Store to the context ports", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-context-preview-"));
    const store = await WorkspaceStore.create({ rootDir: root });
    try {
      const settings = await store.getSettings();
      const timestamp = nowIso();
      await store.createSession({ id: "session-adapter", session_key: "test:adapter", title: "Adapter", ui_locale: settings.ui_locale, output_locale: settings.output_locale, created_at: timestamp, updated_at: timestamp });
      const adapter = new WorkspaceContextPreviewAdapter(store, { sessionNotFound: (id) => new Error(`missing:${id}`) });
      const preview = await buildContextPreview({ sessionId: "session-adapter", query: "こんにちは", ports: adapter.ports });
      expect(preview.session_id).toBe("session-adapter");
      expect(preview.context_assembly.sources.find((source) => source.kind === "available_tools")?.included_count).toBeGreaterThan(0);
    } finally {
      await store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves skill parser errors instead of treating malformed frontmatter as body", async () => {
    for (const markdown of ["body without frontmatter", "---\n{}\nbody", "---\nnot-json\n---\nbody"]) {
      const store = { readSkillMarkdown: async () => markdown } as unknown as WorkspaceStore;
      const adapter = new WorkspaceContextPreviewAdapter(store, { sessionNotFound: (id) => new Error(`missing:${id}`) });
      await expect(adapter.ports.skills.readBody("skill-1")).rejects.toThrow();
    }
  });

  it("trims collection note content before selection", async () => {
    const store = {
      listCollectionNotes: async () => [{ collection_id: "collection-1", file_path: "notes/a.md", content: "  deploy note  ", role: "context_only" as const }]
    } as unknown as WorkspaceStore;
    const adapter = new WorkspaceContextPreviewAdapter(store, { sessionNotFound: (id) => new Error(`missing:${id}`) });
    await expect(adapter.ports.collections.listNotes("collection-1")).resolves.toEqual([{ collection_id: "collection-1", file_path: "notes/a.md", content: "deploy note", role: "context_only" }]);
  });
});
