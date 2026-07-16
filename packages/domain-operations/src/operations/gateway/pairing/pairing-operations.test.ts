import { describe, expect, it, vi } from "vitest";
import { createPendingPairing } from "@samurai-agent/gateway";
import type { TrustedDomainContext } from "../../../definition/index.js";
import gatewayPairingApprove from "./approve.operation.js";

const context: TrustedDomainContext = {
  inputSource: "runtime_api",
  workspaceId: "workspace_test",
  actorId: "actor_test",
  correlationId: "correlation_test"
};

describe("Gateway pairing operation handlers", () => {
  it("owns the approve transition, persistence, and notification sequence", async () => {
    const pending = createPendingPairing(
      { channel: "webhook", source_identity: "source-1" },
      "2099-01-01T00:00:00.000Z"
    );
    const requireGatewayPairing = vi.fn(async () => pending);
    const saveGatewayPairing = vi.fn(async (record) => record);
    const emitGatewayPairingUpdated = vi.fn(async () => undefined);
    const handler = gatewayPairingApprove.createHandler({
      requireGatewayPairing,
      saveGatewayPairing,
      emitGatewayPairingUpdated
    });

    const result = await handler.execute(context, { pairing_id: pending.id });

    expect(result.value.status).toBe("approved");
    expect(requireGatewayPairing).toHaveBeenCalledWith(pending.id);
    expect(saveGatewayPairing).toHaveBeenCalledWith(expect.objectContaining({ status: "approved" }));
    expect(emitGatewayPairingUpdated).toHaveBeenCalledWith(result.value);
    expect(saveGatewayPairing.mock.invocationCallOrder[0]).toBeLessThan(
      emitGatewayPairingUpdated.mock.invocationCallOrder[0]
    );
  });

  it("does not approve a pairing that has already expired", async () => {
    const pending = createPendingPairing(
      { channel: "webhook", source_identity: "source-1" },
      "2020-01-01T00:00:00.000Z"
    );
    const handler = gatewayPairingApprove.createHandler({
      requireGatewayPairing: async () => pending,
      saveGatewayPairing: async (record) => record,
      emitGatewayPairingUpdated: async () => undefined
    });

    const result = await handler.execute(context, { pairing_id: pending.id });

    expect(result.value.status).toBe("expired");
  });
});
