import { describe, expect, it } from "vitest";
import { workspaceChatSessionRequest, workspaceChatTurnRequest } from "./workspace-chat-requests.js";

describe("workspace chat request contract", () => {
  it("requires an operation ID for Desktop Session creation", () => {
    const request = workspaceChatSessionRequest({
      roomId: "room_1",
      operationId: "desktop_quick_ask_session_1",
      title: "確認",
      uiLocale: "ja",
      outputLocale: "ja"
    });

    expect(request.operationId).toBe("desktop_quick_ask_session_1");
    expect(request.body).toEqual({
      room_id: "room_1",
      title: "確認",
      ui_locale: "ja",
      output_locale: "ja"
    });
    expect(() => workspaceChatSessionRequest({ roomId: "room_1" })).toThrow("operationId_invalid");
  });

  it("keeps AppShot context ephemeral in the signed Chat request body", () => {
    const request = workspaceChatTurnRequest({
      sessionId: "session_1",
      idempotencyKey: "desktop_app_shot_1",
      content: "この画面を確認して",
      temporaryContext: [{
        id: "desktop_source_1",
        kind: "desktop_screenshot",
        label: "AppShot: Window",
        sourceName: "Window",
        mimeType: "image/png",
        dataUrl: "data:image/png;base64,iVBORw==",
        createdAt: "2026-08-22T00:00:00.000Z",
        expiresAt: "2026-08-22T00:15:00.000Z",
        metadata: { source_client_kind: "desktop" }
      }]
    });

    expect(request.idempotencyKey).toBe("desktop_app_shot_1");
    expect(request.body.temporary_context).toEqual([expect.objectContaining({
      id: "desktop_source_1",
      kind: "desktop_screenshot",
      mime_type: "image/png",
      data_url: "data:image/png;base64,iVBORw=="
    })]);
  });

  it("rejects an unbounded or non-image temporary context", () => {
    expect(() => workspaceChatTurnRequest({
      sessionId: "session_1",
      idempotencyKey: "desktop_app_shot_1",
      content: "確認",
      temporaryContext: [{
        id: "desktop_source_1",
        kind: "desktop_screenshot",
        mimeType: "text/plain",
        dataUrl: "data:text/plain;base64,SGk=",
        createdAt: "2026-08-22T00:00:00.000Z",
        expiresAt: "2026-08-22T00:15:00.000Z"
      }]
    })).toThrow(/temporaryContext/);
  });
});
