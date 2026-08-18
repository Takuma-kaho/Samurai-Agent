import { stableHash, type TrustedWorkspaceContext } from "@samurai-agent/core-schemas";
import { DomainOperationError, type TrustedDomainContext } from "@samurai-agent/domain-operations";
import type { HumanChangeRequestInput, HumanChangeRequestOutput } from "@samurai-agent/domain-operations";
import type { ActivityIngestPort } from "../../activity/activity-ingest-port.js";

const secretLikeValue = /(?:api[_-]?key|(?:access|refresh)?[_-]?token|secret|password|cookie|authorization)\s*[:=]|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk|ghp)_[A-Za-z0-9_-]{12,}/i;

/**
 * Persists a reviewable request as Activity evidence.  It intentionally has
 * no Store write capability for Profile, Soul, or Policy: those are human
 * owned and require a separate human action after this request is recorded.
 */
export class HumanChangeRequestDomainService {
  constructor(
    private readonly activityIngest: ActivityIngestPort,
    private readonly workspaceContext: (context: TrustedDomainContext) => TrustedWorkspaceContext
  ) {}

  async request(
    context: TrustedDomainContext,
    input: HumanChangeRequestInput & { request_kind: HumanChangeRequestOutput["request_kind"] }
  ): Promise<HumanChangeRequestOutput> {
    assertSafeRequest(input);
    const requestHash = stableHash({
      request_kind: input.request_kind,
      proposed_change_summary: input.proposed_change_summary,
      affected_fields: input.affected_fields
    });
    const activity = await this.activityIngest.ingestFinalizedActivity({
      context: this.workspaceContext(context),
      idempotencyKey: `human-change-request:${context.idempotencyKey ?? context.correlationId}:${requestHash}`,
      instructionSummary: `Request human ${input.request_kind} change: ${input.proposed_change_summary}`,
      status: "completed",
      resultSummary: `Human review is required before any ${input.request_kind} change. ${requestSummary(input)}`,
      provenanceKind: "trusted_context"
    });
    return {
      request_kind: input.request_kind,
      status: "requested",
      proposed_change_summary: input.proposed_change_summary,
      affected_fields: input.affected_fields,
      activity
    };
  }
}

function assertSafeRequest(input: HumanChangeRequestInput): void {
  const values = [input.proposed_change_summary, ...input.affected_fields];
  if (values.some((value) => secretLikeValue.test(value))) {
    throw new DomainOperationError("invalid_input", "human_change_request_secret_value_not_allowed");
  }
}

function requestSummary(input: HumanChangeRequestInput): string {
  return input.affected_fields.length > 0
    ? `Affected fields: ${input.affected_fields.join(", ")}.`
    : "No field value was supplied.";
}
