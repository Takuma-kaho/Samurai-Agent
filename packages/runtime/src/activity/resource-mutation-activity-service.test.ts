import { describe, expect, it, vi } from "vitest";
import type { ActivityRecord, OperationRecord, TrustedWorkspaceContext } from "@samurai-agent/core-schemas";
import type { ActivityIngestPort } from "./activity-ingest-port.js";
import { ResourceMutationActivityService } from "./resource-mutation-activity-service.js";

const now = "2026-08-09T00:00:00.000Z";
const context: TrustedWorkspaceContext = {
  workspace_id: "workspace",
  room_id: "room-default",
  principal: { kind: "human", participant_id: "human:owner" },
  source: { kind: "host" },
  correlation_id: "core08-evidence-failure"
};
const activity: ActivityRecord = {
  id: "activity-core08-evidence-failure",
  workspace_id: context.workspace_id,
  room_id: context.room_id!,
  principal: context.principal,
  source: context.source,
  status: "recording",
  idempotency_key: "resource-mutation:operation-core08-evidence-failure",
  instruction_summary: "Write an Artifact",
  verification: [],
  domain_operation_ids: [],
  provenance: { kind: "trusted_context", source_id: context.correlation_id, recorded_at: now },
  created_at: now,
  updated_at: now
};
const operation: OperationRecord = {
  id: "operation-core08-evidence-failure",
  capability_id: "artifact",
  operation: "artifact.create",
  actor_identity: "owner",
  participant_id: "human:owner",
  participant_kind: "human",
  room_id: context.room_id,
  principal: context.principal,
  source: context.source,
  instruction_source: "owner_instruction",
  instruction_authority: "owner",
  channel: "runtime_api",
  input_hash: "input-hash",
  target_resource_refs: [],
  proposed_effects: ["Write an Artifact"],
  status: "completed",
  correlation_id: context.correlation_id,
  created_at: now,
  updated_at: now
};

describe("ResourceMutationActivityService", () => {
  it("ends a direct Activity as failed when post-commit evidence cannot be recorded", async () => {
    const finalizeActivity = vi.fn(async () => activity);
    const ingest: ActivityIngestPort = {
      startActivity: async () => activity,
      linkBackendRun: async () => activity,
      recordResourceUsage: async () => {
        throw new Error("record_resource_usage_should_not_run");
      },
      finalizeActivity,
      ingestFinalizedActivity: async () => activity
    };
    const service = new ResourceMutationActivityService({
      getActivityByBackendRunId: async () => undefined,
      commitResourceMutationEvidence: async () => {
        throw new Error("workspace_change_write_failed");
      }
    }, ingest);
    const scope = await service.begin({ context, operation, instructionSummary: "Write an Artifact" });

    await expect(service.recordCommitted({
      scope,
      operation,
      resourceRef: { kind: "artifact", id: "artifact-core08-evidence-failure", uri: "artifacts/failure.md" },
      changeType: "artifact_created",
      summary: "Artifact write committed before evidence failed."
    })).rejects.toThrow("workspace_change_write_failed");

    expect(finalizeActivity).toHaveBeenCalledWith(expect.objectContaining({
      activityId: activity.id,
      status: "failed",
      failure: expect.objectContaining({ code: "resource_mutation_evidence_failed" }),
      domainOperationIds: [operation.id]
    }));
  });
});
