import { describe, expect, it, vi } from "vitest";
import type { TrustedDomainContext } from "../../definition/index.js";
import wikiReindex from "./reindex.operation.js";

const context: TrustedDomainContext = { inputSource: "runtime_api", workspaceId: "workspace_test", actorId: "actor_test", correlationId: "correlation_test" };
const operation = { id: "operation_1" } as never;
const resource = { active: 2, total: 3, files: 3, indexed: 2, created: 1, updated: 1, removed: 0, skipped: 1, errors: [] };

describe("wiki.reindex handler", () => {
  it("owns the recorded reindex mutation", async () => {
    const reindexWikiPages = vi.fn(async () => resource);
    const runWikiMutation = vi.fn(async (input) => { const executed = await input.execute(operation); return { resource: executed.resource, operation, activity: [] }; });
    const handler = wikiReindex.createHandler({ reindexWikiPages, runWikiMutation });

    const result = await handler.execute(context, {});

    expect(runWikiMutation).toHaveBeenCalledWith(expect.objectContaining({ operationName: "wiki.reindex" }));
    expect(reindexWikiPages).toHaveBeenCalledOnce();
    expect(result.value.resource.active).toBe(2);
  });

  it("accepts no unrelated input fields", () => {
    expect(wikiReindex.input.safeParse({ session_id: "session_1" }).success).toBe(false);
  });
});
