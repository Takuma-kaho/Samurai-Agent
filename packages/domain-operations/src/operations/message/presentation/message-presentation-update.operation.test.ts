import { describe, expect, it, vi } from "vitest";
import type { TrustedDomainContext } from "../../../definition/index.js";
import messagePresentationUpdate from "./update.operation.js";

const context: TrustedDomainContext = { inputSource: "runtime_api", workspaceId: "workspace_test", actorId: "actor_test", correlationId: "correlation_test" };
const now = "2026-01-01T00:00:00.000Z";
const presentation = {
  id: "presentation_1", session_id: "session_1", message_id: "message_1", kind: "collection_app" as const,
  title: "Tasks", subtitle: "", collection_id: "collection_1", view_id: "default", renderer: "table",
  view_state: {}, created_at: now, updated_at: now
};
const renderSpec = { id: "render_1", kind: "collection" as const, priority: "primary" as const, resource_refs: [], props: { view_id: "compact" } };

describe("message.presentation.update handler", () => {
  it("owns view selection, render-state application, and persistence", async () => {
    const presentCollectionView = vi.fn(async () => ({ render_spec: renderSpec }));
    const updateMessagePresentationViewState = vi.fn(async () => ({ ...presentation, view_id: "compact", view_state: { view_id: "compact" } }));
    const handler = messagePresentationUpdate.createHandler({
      getMessagePresentation: async () => presentation,
      presentCollectionView,
      applyPresentationViewState: (spec) => spec,
      presentationViewStateFromSpec: (spec) => spec.props,
      updateMessagePresentationViewState,
      messagePresentationNotFoundError: () => new Error("presentation_not_found")
    });
    const input = messagePresentationUpdate.input.parse({ presentation_id: presentation.id, view_state: { view_id: "compact" } });

    const result = await handler.execute(context, input);

    expect(presentCollectionView).toHaveBeenCalledWith({ collectionId: "collection_1", viewId: "compact" });
    expect(updateMessagePresentationViewState).toHaveBeenCalledWith({ id: presentation.id, viewState: { view_id: "compact" } });
    expect(result.value.render_specs).toEqual([renderSpec]);
  });

  it("stops before rendering when the presentation is missing", async () => {
    const presentCollectionView = vi.fn();
    const handler = messagePresentationUpdate.createHandler({
      getMessagePresentation: async () => undefined, presentCollectionView,
      applyPresentationViewState: (spec) => spec, presentationViewStateFromSpec: () => ({}),
      updateMessagePresentationViewState: async () => undefined,
      messagePresentationNotFoundError: () => new Error("presentation_not_found")
    });

    await expect(handler.execute(context, messagePresentationUpdate.input.parse({ presentation_id: "missing" }))).rejects.toThrow("presentation_not_found");
    expect(presentCollectionView).not.toHaveBeenCalled();
  });
});
