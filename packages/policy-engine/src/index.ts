import {
  type CapabilityManifest,
  type GrantRecord,
  type PolicyDecision,
  type PolicyDecisionRecord,
  type PolicyEvaluationInput,
  createId,
  nowIso,
  policyDecisions
} from "@samurai-agent/core-schemas";

const decisionRank: Record<PolicyDecision, number> = policyDecisions.reduce(
  (acc, decision, index) => ({ ...acc, [decision]: index }),
  {} as Record<PolicyDecision, number>
);

export interface EvaluatePolicyOptions {
  input: PolicyEvaluationInput;
  manifest?: CapabilityManifest;
  grants?: GrantRecord[];
  operationId: string;
}

export function evaluatePolicy(options: EvaluatePolicyOptions): PolicyDecisionRecord {
  const { input, manifest, grants = [], operationId } = options;
  const matchedRules: string[] = [];

  if (!manifest) {
    return record(input, operationId, "deny", "Capability manifest is missing.", ["missing_manifest"]);
  }

  const operation = manifest.operations.find((item) => item.operation === input.operation);

  if (!operation) {
    return record(input, operationId, "deny", "Operation is not listed in the capability manifest.", ["unknown_operation"]);
  }

  let decision = operation.default_decision;
  matchedRules.push(`manifest_default:${decision}`);

  if (!operation.allowed_instruction_sources.includes(input.instruction_source)) {
    decision = stricter(decision, "deny");
    matchedRules.push("instruction_source_not_allowed");
  }

  if (
    input.instruction_source === "external_content" &&
    (operation.external_impact ||
      operation.scope === "public" ||
      operation.scope === "payment" ||
      operation.scope === "secret" ||
      operation.scope === "identity" ||
      operation.risk === "irreversible")
  ) {
    decision = stricter(decision, "deny");
    matchedRules.push("external_content_cannot_trigger_high_impact_effects");
  }

  if (operation.secret_requirement !== "none") {
    decision = stricter(decision, "requires_strong_approval");
    matchedRules.push("secret_use_requires_strong_approval");
  }

  if (operation.risk === "irreversible" || operation.scope === "payment" || operation.scope === "public") {
    decision = stricter(decision, "requires_strong_approval");
    matchedRules.push("irreversible_or_public_effect_requires_strong_approval");
  }

  if (!operation.reversibility && operation.external_impact) {
    decision = stricter(decision, "requires_approval");
    matchedRules.push("irreversible_external_effect_requires_approval");
  }

  const activeGrant = findActiveGrant(grants, manifest, input);
  if (activeGrant && decision === "requires_first_time_confirm") {
    decision = "allow_with_audit";
    matchedRules.push("active_grant_downgraded_first_time_confirm");
  }

  return record(
    input,
    operationId,
    decision,
    reasonFor(decision),
    matchedRules,
    approvalLevelFor(decision),
    activeGrant?.id
  );
}

export function stricter(current: PolicyDecision, candidate: PolicyDecision): PolicyDecision {
  return decisionRank[candidate] > decisionRank[current] ? candidate : current;
}

function findActiveGrant(grants: GrantRecord[], manifest: CapabilityManifest, input: PolicyEvaluationInput): GrantRecord | undefined {
  const now = Date.now();

  return grants.find((grant) => {
    const expired = grant.expires_at ? Date.parse(grant.expires_at) < now : false;
    return (
      !expired &&
      !grant.revoked_at &&
      grant.capability_id === input.capability_id &&
      grant.operation === input.operation &&
      grant.actor_identity === input.actor_identity &&
      grant.channel === input.channel &&
      grant.manifest_version === manifest.version
    );
  });
}

function record(
  input: PolicyEvaluationInput,
  operationId: string,
  decision: PolicyDecision,
  reason: string,
  matchedRules: string[],
  requiredApprovalLevel = approvalLevelFor(decision),
  grantId?: string
): PolicyDecisionRecord {
  return {
    id: createId("policy"),
    operation_id: operationId,
    capability_id: input.capability_id,
    operation: input.operation,
    decision,
    reason,
    policy_inputs: input,
    matched_rules: matchedRules,
    required_approval_level: requiredApprovalLevel,
    grant_id: grantId,
    created_at: nowIso()
  };
}

function approvalLevelFor(decision: PolicyDecision): PolicyDecisionRecord["required_approval_level"] {
  if (decision === "requires_first_time_confirm") {
    return "first_time_confirm";
  }
  if (decision === "requires_approval") {
    return "approval";
  }
  if (decision === "requires_strong_approval") {
    return "strong_approval";
  }
  return "none";
}

function reasonFor(decision: PolicyDecision): string {
  switch (decision) {
    case "allow_auto":
      return "Static capability policy allows this operation automatically.";
    case "allow_with_audit":
      return "Static capability policy allows the operation with visible audit and rollback tracking.";
    case "requires_first_time_confirm":
      return "This capability needs a first-time confirmation before routine use.";
    case "requires_approval":
      return "This operation crosses a user-visible boundary and needs approval.";
    case "requires_strong_approval":
      return "This operation is sensitive, public, irreversible, or requires stronger approval.";
    case "deny":
      return "Policy denied the operation.";
  }
}
