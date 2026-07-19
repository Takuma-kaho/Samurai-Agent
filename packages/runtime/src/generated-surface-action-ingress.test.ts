import { describe, expect, it } from "vitest";
import { executeGeneratedSurfaceAction, type ResolvedGeneratedSurfaceAction } from "./generated-surface-action-ingress";

const resolved = {
  surface: { id: "surface", session_id: "session" } as ResolvedGeneratedSurfaceAction["surface"],
  revisionId: "revision",
  action: { id: "action", command_id: "artifact.create", payload_template: {} } as ResolvedGeneratedSurfaceAction["action"],
  payloadTemplate: { title: "fixture" }
};

describe("generated surface action ingress", () => {
  it("dispatches target once and records one interaction", async () => {
    const calls: string[] = [];
    const result = await executeGeneratedSurfaceAction({
      resolved,
      interactionId: "interaction",
      actionPayload: { content: "body" },
      dispatch: async (request) => { calls.push(`dispatch:${request.commandId}`); return { ok: true }; },
      recordInteraction: async (request) => { calls.push(`record:${request.commandId}`); return { saved: true }; }
    });
    expect(result.command).toEqual({ ok: true });
    expect(calls).toEqual(["dispatch:artifact.create", "record:artifact.create"]);
  });

  it("records target failure once and preserves the original typed error", async () => {
    const typedError = Object.assign(new Error("target failed"), { code: "forbidden" });
    const calls: string[] = [];
    await expect(executeGeneratedSurfaceAction({
      resolved,
      interactionId: "interaction",
      actionPayload: {},
      dispatch: async () => { calls.push("dispatch"); throw typedError; },
      recordInteraction: async (request) => { calls.push(`record:${request.error === typedError}`); return { saved: true }; }
    })).rejects.toBe(typedError);
    expect(calls).toEqual(["dispatch", "record:true"]);
  });
});
