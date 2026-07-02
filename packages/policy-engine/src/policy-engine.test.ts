import { describe, expect, it } from "vitest";
import { createId, stableHash, type PolicyEvaluationInput } from "@samurai-agent/core-schemas";
import { proposalCapabilityManifest } from "../../capability-registry/src/index";
import { evaluatePolicy } from "./index";

const baseInput = (operation: string): PolicyEvaluationInput => ({
  capability_id: proposalCapabilityManifest.id,
  operation,
  actor_identity: "owner",
  instruction_source: "owner_instruction",
  instruction_authority: "owner",
  channel: "web",
  target_resource_refs: [],
  proposed_effects: ["fixture"],
  prior_grants: [],
  recent_history: [],
  input_hash: stableHash({ operation })
});

describe("policy engine", () => {
  it("allows local artifact drafts automatically", () => {
    const decision = evaluatePolicy({
      input: baseInput("artifact.create"),
      manifest: proposalCapabilityManifest,
      operationId: createId("operation")
    });

    expect(decision.decision).toBe("allow_auto");
  });

  it("requires approval for outbound send", () => {
    const decision = evaluatePolicy({
      input: baseInput("external.send"),
      manifest: proposalCapabilityManifest,
      operationId: createId("operation")
    });

    expect(decision.decision).toBe("requires_approval");
  });

  it("denies high-impact work from external content", () => {
    const input = {
      ...baseInput("external.send"),
      instruction_source: "external_content" as const
    };
    const decision = evaluatePolicy({
      input,
      manifest: proposalCapabilityManifest,
      operationId: createId("operation")
    });

    expect(decision.decision).toBe("deny");
  });
});
