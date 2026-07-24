import { describe, expect, it } from "vitest";
import { resolveTemporaryContext } from "./temporary-context-port.js";

describe("temporary context port", () => {
  it("prefers explicit items and resolves remaining references through the port", async () => {
    const resolved = await resolveTemporaryContext({
      resolve: (ref) => ({ id: ref.id, kind: "desktop_screenshot", mime_type: "image/png", created_at: "2026-01-01T00:00:00.000Z", expires_at: "2026-01-01T00:01:00.000Z" }),
      conflict: (message) => new Error(message)
    }, [{ kind: "temporary_context", id: "ref-1", uri: "temporary/ref-1" }, { kind: "temporary_context", id: "explicit", uri: "temporary/explicit" }], [{ id: "explicit", kind: "desktop_screenshot", mime_type: "image/png", created_at: "2026-01-01T00:00:00.000Z", expires_at: "2026-01-01T00:01:00.000Z" }]);

    expect(resolved.map((item) => item.id)).toEqual(["ref-1", "explicit"]);
  });

  it("fails closed when a reference cannot be resolved", async () => {
    await expect(resolveTemporaryContext({ resolve: () => undefined, conflict: (message) => new Error(message) }, [{ kind: "temporary_context", id: "missing", uri: "temporary/missing" }])).rejects.toThrow("temporary_context_unavailable");
  });
});
