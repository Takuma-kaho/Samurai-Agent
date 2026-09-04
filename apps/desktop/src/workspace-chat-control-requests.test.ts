import { describe, expect, it } from "vitest";
import { workspaceChatReconnectRequest, workspaceChatRunControlRequest } from "./workspace-chat-control-requests";

describe("Desktop Chat run control boundary", () => {
  it("uses the same operation id for cancel/retry idempotency", () => {
    expect(workspaceChatRunControlRequest({ runId: "run_1", operationId: "stop_1" }, "cancel")).toEqual({
      action: "cancel",
      runId: "run_1",
      operationId: "stop_1",
      body: {}
    });
    expect(workspaceChatRunControlRequest({ runId: "run_1", operationId: "retry_1", confirmUnknown: true }, "retry")).toEqual({
      action: "retry",
      runId: "run_1",
      operationId: "retry_1",
      body: { confirm_unknown: true }
    });
  });

  it("does not accept an arbitrary reconnect capability", () => {
    expect(workspaceChatReconnectRequest()).toEqual({});
    expect(workspaceChatReconnectRequest({ connectionId: "connection_1", privateKey: "must-not-cross" })).toEqual({ connectionId: "connection_1" });
    expect(() => workspaceChatRunControlRequest({ runId: "run_1", operationId: "bad id" }, "cancel")).toThrow("operationId_invalid");
  });
});
