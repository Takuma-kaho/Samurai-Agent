import { describe, expect, it } from "vitest";
import { createId, stableHash, type CapabilityManifest, type GrantRecord, type PolicyEvaluationInput } from "@samurai-agent/core-schemas";
import { proposalCapabilityManifest } from "../../capability-registry/src/index";
import { evaluatePolicy } from "./index";

const baseInput = (operation: string, capabilityId = proposalCapabilityManifest.id): PolicyEvaluationInput => ({
  capability_id: capabilityId,
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

const grantFixture = (manifest: CapabilityManifest, overrides: Partial<GrantRecord> = {}): GrantRecord => ({
  id: createId("grant"),
  capability_id: manifest.id,
  operation: "policy.first_time",
  actor_identity: "owner",
  channel: "web",
  resource_scope: "workspace",
  manifest_version: manifest.version,
  risk_snapshot: "low",
  scope_snapshot: "workspace",
  external_impact_snapshot: false,
  secret_requirement_snapshot: "none",
  granted_by: "owner",
  reason: "policy fixture",
  created_at: "2026-01-01T00:00:00.000Z",
  ...overrides
});

const firstTimeManifest: CapabilityManifest = {
  ...proposalCapabilityManifest,
  id: "policy_fixture",
  version: "2.0.0",
  operations: [
    ...proposalCapabilityManifest.operations,
    {
      operation: "policy.first_time",
      description: "Fixture operation requiring a first-time confirmation.",
      input_schema_ref: "policy.first_time.input",
      output_schema_ref: "policy.first_time.output",
      risk: "low",
      scope: "workspace",
      reversibility: true,
      external_impact: false,
      secret_requirement: "none",
      allowed_instruction_sources: ["owner_instruction"],
      default_decision: "requires_first_time_confirm"
    }
  ]
};

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

  it("uses an active grant only when it matches the current manifest", () => {
    const decision = evaluatePolicy({
      input: baseInput("policy.first_time", firstTimeManifest.id),
      manifest: firstTimeManifest,
      grants: [grantFixture(firstTimeManifest)],
      operationId: createId("operation")
    });

    expect(decision.decision).toBe("allow_with_audit");
    expect(decision.grant_id).toBeDefined();
  });

  it.each([
    ["expired", { expires_at: "2025-12-31T23:59:59.000Z" }],
    ["revoked", { revoked_at: "2026-01-02T00:00:00.000Z" }],
    ["old manifest", { manifest_version: "1.0.0" }]
  ] as const)("does not use a %s grant", (_label, overrides) => {
    const decision = evaluatePolicy({
      input: baseInput("policy.first_time", firstTimeManifest.id),
      manifest: firstTimeManifest,
      grants: [grantFixture(firstTimeManifest, overrides)],
      operationId: createId("operation")
    });

    expect(decision.decision).toBe("requires_first_time_confirm");
    expect(decision.grant_id).toBeUndefined();
  });
});
