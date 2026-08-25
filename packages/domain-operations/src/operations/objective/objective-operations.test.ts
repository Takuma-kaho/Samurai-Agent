import { describe, expect, it, vi } from "vitest";
import type { TrustedDomainContext } from "../../definition/index.js";
import objectiveCreate from "./create.operation.js";
import objectiveTransition from "./transition.operation.js";

const context: TrustedDomainContext = {
  inputSource: "runtime_api",
  workspaceId: "workspace_test",
  actorId: "actor_test",
  roomId: "room_test",
  correlationId: "correlation_test"
};

describe("Objective operation handlers", () => {
  it("constructs the durable objective before persistence", async () => {
    const saveObjective = vi.fn(async (record) => record);
    const handler = objectiveCreate.createHandler({ saveObjective });

    const input = objectiveCreate.input.parse({
      objective: "  Finish   the implementation  ",
      completion_criteria: ["tests pass"]
    });
    const result = await handler.execute(context, input);

    expect(result.value).toMatchObject({
      title: "Finish the implementation",
      objective: "Finish   the implementation",
      completion_criteria: ["tests pass"],
      status: "active"
    });
    expect(saveObjective).toHaveBeenCalledWith(result.value);
  });

  it("rejects empty completion criteria at the operation boundary", () => {
    expect(objectiveCreate.input.safeParse({
      objective: "Finish",
      completion_criteria: []
    }).success).toBe(false);
  });

  it("passes a schema-validated transition to the coordinator port", async () => {
    const transitionObjective = vi.fn(async () => ({
      objective: {
        id: "objective-1",
        room_id: "room_test",
        title: "Finish",
        objective: "Finish",
        completion_criteria: ["done"],
        status: "paused" as const,
        created_at: "2026-07-16T00:00:00.000Z",
        updated_at: "2026-07-16T00:00:00.000Z"
      },
      workItems: [],
      cancelBackendRunIds: []
    }));
    const handler = objectiveTransition.createHandler({ transitionObjective });

    await handler.execute(context, { objective_id: "objective-1", action: "pause" });

    expect(transitionObjective).toHaveBeenCalledWith("objective-1", "pause", "room_test");
  });
});
