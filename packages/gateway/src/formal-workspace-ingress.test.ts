import { describe, expect, it, vi } from "vitest";
import { GatewayFormalWorkspaceIngress } from "./index.js";

describe("GatewayFormalWorkspaceIngress", () => {
  it("delegates only secret-free evidence and an untrusted target to the formal ingress", async () => {
    const query = vi.fn(async () => ({ ok: true }));
    const domainOperation = vi.fn(async () => ({ ok: true }));
    const activityIngest = vi.fn(async () => ({ ok: true }));
    const ingress = new GatewayFormalWorkspaceIngress({ query, domainOperation, activityIngest });
    const evidence = { connector_id: "connector-fixture", app_id: "app-fixture" };
    const target = { requested_room_id: "room-fixture", correlation_id: "correlation-fixture" };

    await ingress.query({ evidence, target, query_id: "activity.history.list" });
    await ingress.domainOperation({ evidence, target: { ...target, idempotency_key: "operation-fixture" }, command_id: "artifact.create", payload: { title: "fixture" } });
    await ingress.activityIngest({
      evidence,
      target,
      idempotency_key: "activity-fixture",
      instruction_summary: "Record fixture evidence.",
      result_summary: "Recorded.",
      status: "completed"
    });

    expect(query).toHaveBeenCalledWith(expect.objectContaining({ evidence, target, query_id: "activity.history.list" }));
    expect(domainOperation).toHaveBeenCalledWith(expect.objectContaining({ evidence, command_id: "artifact.create" }));
    expect(activityIngest).toHaveBeenCalledWith(expect.objectContaining({ evidence, idempotency_key: "activity-fixture" }));
    expect(query.mock.calls[0]?.[0]).not.toHaveProperty("session_id");
    expect(domainOperation.mock.calls[0]?.[0]).not.toHaveProperty("pairing");
  });
});
