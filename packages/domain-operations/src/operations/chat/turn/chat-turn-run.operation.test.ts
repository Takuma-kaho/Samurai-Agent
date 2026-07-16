import { describe, expect, it, vi } from "vitest";
import type { TrustedDomainContext } from "../../../definition/index.js";
import chatTurnRun from "./run.operation.js";

const context: TrustedDomainContext = { inputSource: "runtime_api", workspaceId: "workspace_test", actorId: "actor_test", correlationId: "correlation_test" };
const session = { id: "session_1", session_key: "session_1", title: "Chat", ui_locale: "ja", output_locale: "ja", created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" } as const;
const result = { session, messages: [] } as never;

describe("chat.turn.run handler", () => {
  it("uses the supplied session and validated defaults", async () => {
    const createChatSession = vi.fn(async () => session);
    const runChatTurn = vi.fn(async () => result);
    const handler = chatTurnRun.createHandler({ createChatSession, runChatTurn });
    const input = chatTurnRun.input.parse({ session_id: session.id, content: "Hello" });

    await handler.execute(context, input);

    expect(createChatSession).not.toHaveBeenCalled();
    expect(runChatTurn).toHaveBeenCalledWith({ sessionId: session.id, content: "Hello", backend_id: undefined, input_locale: undefined, output_locale: undefined, attachments: [], temporary_context: [], metadata: {} });
  });

  it("creates a session before running when no session is supplied", async () => {
    const createChatSession = vi.fn(async () => session);
    const runChatTurn = vi.fn(async () => result);
    const handler = chatTurnRun.createHandler({ createChatSession, runChatTurn });
    const input = chatTurnRun.input.parse({ content: "こんにちは", output_locale: "ja" });

    await handler.execute(context, input);

    expect(createChatSession).toHaveBeenCalledWith({ output_locale: "ja" });
    expect(createChatSession.mock.invocationCallOrder[0]).toBeLessThan(runChatTurn.mock.invocationCallOrder[0]);
  });

  it("rejects malformed attachments and temporary context", () => {
    expect(chatTurnRun.input.safeParse({ content: "Hello", attachments: [{ kind: "file", id: "x" }] }).success).toBe(false);
    expect(chatTurnRun.input.safeParse({ content: "Hello", temporary_context: [{ kind: "desktop_screenshot" }] }).success).toBe(false);
  });
});
