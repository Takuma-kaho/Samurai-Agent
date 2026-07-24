import { describe, expect, it, vi } from "vitest";
import { api } from "./api";

function response(body: unknown = {}) {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => body
  } as Response;
}

describe("chat idempotency keys", () => {
  it("reuses the caller-owned key for a surface retry and changes it for a new operation", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response());
    vi.stubGlobal("fetch", fetchMock);
    const input = {
      idempotencyKey: "turn-1",
      sessionId: "session-1",
      content: "同じ操作",
      outputLocale: "ja" as const
    };

    await api.submitChatSurfaceOperation(input);
    await api.submitChatSurfaceOperation(input);
    await api.submitChatSurfaceOperation({ ...input, idempotencyKey: "turn-2" });

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/surface/operations", expect.objectContaining({
      headers: expect.objectContaining({ "Idempotency-Key": "turn-1" }),
      body: expect.stringContaining('"id":"turn-1"')
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/surface/operations", expect.objectContaining({
      headers: expect.objectContaining({ "Idempotency-Key": "turn-1" })
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(3, "/api/surface/operations", expect.objectContaining({
      headers: expect.objectContaining({ "Idempotency-Key": "turn-2" }),
      body: expect.stringContaining('"id":"turn-2"')
    }));
  });

  it("sends the caller-owned key on both legacy chat ingress methods", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response());
    vi.stubGlobal("fetch", fetchMock);

    await api.sendMessage("session-1", "本文", "ja", "turn-session-1");
    await api.startChat("本文", "ja", "ja", "turn-new-1");

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/chat/sessions/session-1/messages", expect.objectContaining({
      headers: expect.objectContaining({ "Idempotency-Key": "turn-session-1" })
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/chat/messages", expect.objectContaining({
      headers: expect.objectContaining({ "Idempotency-Key": "turn-new-1" })
    }));
  });
});
