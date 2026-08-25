import { describe, expect, it } from "vitest";
import { evaluatePhase13Completion } from "../../../scripts/lib/phase13-completion.mjs";

describe("Phase 13 completion decision", () => {
  it("marks all successful checks complete with exit code 0", () => {
    expect(evaluatePhase13Completion([{ id: "one", status: "passed" }])).toMatchObject({
      status: "passed",
      complete: true,
      environment_verified: true,
      exit_code: 0
    });
  });

  it("marks a failed check incomplete with exit code 1", () => {
    expect(evaluatePhase13Completion([{ id: "one", status: "failed" }])).toMatchObject({
      status: "failed",
      complete: false,
      environment_verified: true,
      exit_code: 1
    });
  });

  it("marks an unverified check incomplete with exit code 2", () => {
    expect(evaluatePhase13Completion([{ id: "one", status: "unverified" }])).toMatchObject({
      status: "passed_with_unverified",
      complete: false,
      environment_verified: false,
      exit_code: 2
    });
  });
});
