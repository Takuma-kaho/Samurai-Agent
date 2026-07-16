import { describe, expect, it, vi } from "vitest";
import type { TrustedDomainContext } from "../../../definition/index.js";
import clientEventAck from "./ack.operation.js";
import clientEventExpire from "./expire.operation.js";
import clientEventFail from "./fail.operation.js";

const context: TrustedDomainContext = {
  inputSource: "runtime_api",
  workspaceId: "workspace_test",
  actorId: "actor_test",
  correlationId: "correlation_test"
};

describe("Client event operation handlers", () => {
  it("owns missing-event handling after acknowledge", async () => {
    const notFound = new Error("client_event_not_found");
    const handler = clientEventAck.createHandler({
      acknowledgeClientEvent: async () => undefined,
      clientEventNotFoundError: () => notFound
    });

    await expect(handler.execute(context, { event_id: "missing" })).rejects.toBe(notFound);
  });

  it("owns the failed-event default and missing-event handling", async () => {
    const failClientEvent = vi.fn(async () => undefined);
    const notFound = new Error("client_event_not_found");
    const handler = clientEventFail.createHandler({
      failClientEvent,
      clientEventNotFoundError: () => notFound
    });
    const input = clientEventFail.input.parse({ event_id: "event-1" });

    await expect(handler.execute(context, input)).rejects.toBe(notFound);
    expect(failClientEvent).toHaveBeenCalledWith("event-1", "client_event_failed");
  });

  it("builds the expiry summary from primitive persistence results", async () => {
    const expireClientEvents = vi.fn(async () => []);
    const handler = clientEventExpire.createHandler({ expireClientEvents });

    await expect(handler.execute(context, {})).resolves.toEqual({
      ok: true,
      value: { expired_count: 0, events: [] }
    });
    expect(expireClientEvents).toHaveBeenCalledWith(undefined);
  });
});
