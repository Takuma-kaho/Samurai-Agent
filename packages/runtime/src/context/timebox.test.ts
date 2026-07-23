import { describe, expect, it } from "vitest";
import { timeboxContextStep } from "./timebox.js";

describe("context step timebox", () => {
  it("reports a timeout and uses the explicit fallback", async () => {
    const result = await timeboxContextStep(new Promise<string>(() => undefined), "fallback", "session_search");
    expect(result).toMatchObject({ value: "fallback", timedOut: true, step: "session_search" });
  }, 5000);
});
