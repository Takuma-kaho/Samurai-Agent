import { describe, expect, it, vi } from "vitest";
import type { ObjectiveRecord, WorkItemRecord } from "@samurai-agent/core-schemas";
import type { TrustedDomainContext } from "../../definition/index.js";
import workItemCreate from "./create.operation.js";

const context: TrustedDomainContext = { inputSource: "runtime_api", workspaceId: "workspace_test", actorId: "actor_test", correlationId: "correlation_test" };
const objective = { id: "objective_1" } as ObjectiveRecord;

describe("work_item.create handler", () => {
  it("owns defaults, record creation, and persistence", async () => {
    const saveWorkItem = vi.fn(async (record: WorkItemRecord) => record);
    const handler = workItemCreate.createHandler({
      getWorkItemObjective: async () => objective,
      saveWorkItem,
      workItemObjectiveNotFoundError: () => new Error("objective_not_found")
    });
    const input = workItemCreate.input.parse({ objective_id: objective.id, instruction: "Do the work" });

    const result = await handler.execute(context, input);

    expect(saveWorkItem).toHaveBeenCalledWith(expect.objectContaining({
      objective_id: objective.id, instruction: "Do the work", status: "ready", priority: 0, max_attempts: 3
    }));
    expect(result.value.idempotency_key).toContain(`${objective.id}:`);
  });

  it("does not save work for a missing objective", async () => {
    const saveWorkItem = vi.fn(async (record: WorkItemRecord) => record);
    const handler = workItemCreate.createHandler({
      getWorkItemObjective: async () => undefined,
      saveWorkItem,
      workItemObjectiveNotFoundError: () => new Error("objective_not_found")
    });

    await expect(handler.execute(context, workItemCreate.input.parse({ objective_id: "missing", instruction: "Do it" }))).rejects.toThrow("objective_not_found");
    expect(saveWorkItem).not.toHaveBeenCalled();
  });
});
