import { describe, expect, it, vi } from "vitest";
import type { TrustedDomainContext } from "../../definition/index.js";
import wikiPatch from "./patch.operation.js";
import wikiProposalCreate from "./proposal/create.operation.js";

const context: TrustedDomainContext = { inputSource: "runtime_api", workspaceId: "workspace_test", actorId: "actor_test", correlationId: "correlation_test" };
const now = "2026-01-01T00:00:00.000Z";
const operation = { id: "operation_1" } as never;
const page = { id: "wiki_1", slug: "hello-world", title: "Hello World", state: "proposed" as const, content_locale: "ja" as const, tags: [], source_refs: [], provenance: { kind: "user_authored" as const, summary: "test", verified: true }, created_at: now, updated_at: now, file_path: "wiki/hello-world.md" };

describe("Wiki write operation handlers", () => {
  it("owns proposal frontmatter creation, persistence, and rollback", async () => {
    const saveWikiPage = vi.fn(async (record, content: string) => ({ ...record, file_path: `wiki/${record.slug}.md`, content }));
    const handler = wikiProposalCreate.createHandler({
      defaultWikiOutputLocale: async () => "ja", saveWikiPage,
      createWikiRollback: async () => ({ id: "rollback_1" }) as never,
      runWikiMutation: async (input) => { const executed = await input.execute(operation); return { resource: executed.resource, operation, rollbackPoint: executed.rollbackPoint, activity: [] }; }
    });
    const input = wikiProposalCreate.input.parse({ title: "Hello World", content: "Body" });

    const result = await handler.execute(context, input);

    expect(saveWikiPage).toHaveBeenCalledWith(expect.objectContaining({ slug: "hello-world", state: "proposed", content_locale: "ja" }), "Body");
    expect(result.value.resource.file_path).toBe("wiki/hello-world.md");
  });

  it("owns patch lookup, old-content capture, update, and rollback", async () => {
    const updateWikiPage = vi.fn(async (input) => ({ ...page, title: input.title ?? page.title }));
    const createWikiRollback = vi.fn(async () => ({ id: "rollback_1" }) as never);
    const handler = wikiPatch.createHandler({
      getWikiPage: async () => page, readWikiContent: async () => "Old body", updateWikiPage,
      wikiPageNotFoundError: () => new Error("wiki_not_found"), createWikiRollback,
      runWikiMutation: async (input) => { const executed = await input.execute(operation); return { resource: executed.resource, operation, rollbackPoint: executed.rollbackPoint, activity: [] }; }
    });

    const result = await handler.execute(context, { wiki_id: page.id, title: "Updated" });

    expect(updateWikiPage).toHaveBeenCalledWith(expect.objectContaining({ id: page.id, title: "Updated" }));
    expect(createWikiRollback).toHaveBeenCalledWith(operation, expect.any(Array), expect.objectContaining({ content: "Old body" }), expect.objectContaining({ content: "Old body" }));
    expect(result.value.resource.title).toBe("Updated");
  });

  it("does not begin a mutation for a missing patch target", async () => {
    const runWikiMutation = vi.fn();
    const handler = wikiPatch.createHandler({
      getWikiPage: async () => undefined, readWikiContent: async () => undefined, updateWikiPage: async () => undefined,
      wikiPageNotFoundError: () => new Error("wiki_not_found"), createWikiRollback: async () => ({ id: "rollback_1" }) as never,
      runWikiMutation
    });

    await expect(handler.execute(context, { wiki_id: "missing" })).rejects.toThrow("wiki_not_found");
    expect(runWikiMutation).not.toHaveBeenCalled();
  });
});
