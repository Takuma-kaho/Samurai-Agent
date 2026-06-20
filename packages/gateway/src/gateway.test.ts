import { describe, expect, it } from "vitest";
import { createCronMemoryReviewEnvelope, createWebEnvelope, routeSession } from "./index";

describe("gateway", () => {
  it("creates fixed web and cron contexts", () => {
    const web = createWebEnvelope("hello");
    const cron = createCronMemoryReviewEnvelope();

    expect(web).toMatchObject({
      source: "web",
      actor_identity: "owner",
      session_key: "web:owner:main"
    });
    expect(cron).toMatchObject({
      source: "cron",
      actor_identity: "owner_scheduled",
      session_key: "cron:owner_scheduled:memory-review"
    });
    expect(routeSession({ source: "web", identity: "owner" })).toBe("web:owner:main");
  });
});
