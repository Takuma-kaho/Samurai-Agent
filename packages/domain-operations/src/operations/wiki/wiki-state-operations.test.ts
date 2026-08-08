import { describe, expect, it, vi } from "vitest";
import type { TrustedDomainContext } from "../../definition/index.js";
import wikiAccept from "./accept.operation.js";
import wikiArchive from "./archive.operation.js";
import wikiReject from "./reject.operation.js";
import type { WikiStateTransitionPorts } from "./state-transition.js";

const context: TrustedDomainContext = { inputSource: "runtime_api", workspaceId: "workspace_test", actorId: "actor_test", correlationId: "correlation_test" };
const operation = { id: "operation_1" } as never;
const page = { id: "wiki_1", slug: "page", title: "Page", state: "proposed" as const, content_locale: "ja" as const, tags: [], source_refs: [], provenance: { kind: "user_authored" as const, summary: "test", verified: true }, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z", file_path: "wiki/page.md" };

function ports(setWikiPageState = vi.fn(async (_id: string, state: "active" | "archived" | "rejected") => ({ ...page, state }))) {
  return {
    getWikiPage: async () => page, setWikiPageState,
    wikiPageNotFoundError: () => new Error("wiki_not_found"),
    createWikiRollback: async () => ({ id: "rollback_1" }) as never,
    runWikiMutation: async (input: Parameters<WikiStateTransitionPorts["runWikiMutation"]>[0]) => {
      const executed = await input.execute(operation);
      return { resource: executed.resource, operation, rollbackPoint: executed.rollbackPoint, activity: [] };
    }
  };
}

describe("Wiki state operation handlers", () => {
  it.each([
    [wikiAccept, "active", "wiki.accept"],
    [wikiArchive, "archived", "wiki.archive"],
    [wikiReject, "rejected", "wiki.reject"]
  ] as const)("owns the state transition for %s", async (definition, expectedState, operationName) => {
    const setWikiPageState = vi.fn(async (_id: string, state: typeof expectedState) => ({ ...page, state }));
    const handler = definition.createHandler(ports(setWikiPageState));

    const result = await handler.execute(context, { wiki_id: page.id });

    expect(setWikiPageState).toHaveBeenCalledWith(page.id, expectedState);
    expect(result.value.resource.state).toBe(expectedState);
    expect(result.value.operation).toEqual(operation);
  });

  it("does not mutate a missing page", async () => {
    const setWikiPageState = vi.fn();
    const handler = wikiAccept.createHandler({ ...ports(setWikiPageState), getWikiPage: async () => undefined });
    await expect(handler.execute(context, { wiki_id: "missing" })).rejects.toThrow("wiki_not_found");
    expect(setWikiPageState).not.toHaveBeenCalled();
  });
});
