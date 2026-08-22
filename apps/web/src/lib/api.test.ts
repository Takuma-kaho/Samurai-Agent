import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("chat idempotency keys", () => {
  it("fails closed without the signed Workspace bridge", async () => {
    const input = {
      idempotencyKey: "turn-1",
      sessionId: "session-1",
      content: "同じ操作",
      outputLocale: "ja" as const
    };

    await expect(api.submitChatSurfaceOperation(input)).rejects.toMatchObject({
      status: 503,
      body: { error: "workspace_connection_required", feature: "chat.message.submit" }
    });
  });

  it("does not fall back to the old unauthenticated Chat URLs", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.sendMessage("session-1", "本文", "ja", "turn-session-1")).rejects.toMatchObject({ status: 503 });
    await expect(api.startChat("本文", "ja", "ja", "turn-new-1")).rejects.toMatchObject({ status: 503 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
