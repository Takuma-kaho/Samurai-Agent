import { describe, expect, it } from "vitest";
import { resolveLegacySessionCreateIngress } from "./domain-ingress.js";

const lookup = {
  async getSession() {
    return undefined;
  },
  async getBackendRun() {
    return undefined;
  }
};

describe("Core06 legacy Session ingress", () => {
  it("moves a legacy room_id into trusted transport context before parsing Session create", async () => {
    const input = await resolveLegacySessionCreateIngress(
      lookup,
      { title: "Room-bound chat", room_id: "room-private" },
      (_code, message) => new Error(message)
    );

    expect(input).toEqual({
      payload: { title: "Room-bound chat" },
      context: { roomId: "room-private" }
    });
  });
});
