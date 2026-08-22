import { describe, expect, it, vi } from "vitest";
import type { TrustedDomainContext } from "../../definition/index.js";
import sessionCreate from "./create.operation.js";

const context: TrustedDomainContext = {
  inputSource: "runtime_api",
  workspaceId: "workspace_test",
  actorId: "actor_test",
  correlationId: "session-create-test",
  idempotencyKey: "session-create-test"
};

describe("session.create handler", () => {
  it("keeps the Room identifier in the shared operation input", async () => {
    const createSession = vi.fn(async () => ({
      id: "session_1",
      session_key: "session_1",
      room_id: "room_1",
      title: "Chat",
      ui_locale: "ja" as const,
      output_locale: "ja" as const,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z"
    }));
    const handler = sessionCreate.createHandler({ createSession });

    await handler.execute(context, sessionCreate.input.parse({ room_id: "room_1", title: "Chat" }));

    expect(createSession).toHaveBeenCalledWith(context, { roomId: "room_1", title: "Chat" });
  });
});
