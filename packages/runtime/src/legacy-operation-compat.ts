import {
  type BackendRunRecord,
  type OperationRecord,
  type ResourceRef,
  createId,
  nowIso,
  stableHash
} from "@samurai-agent/core-schemas";

export function createArtifactCompatOperation(input: {
  run: BackendRunRecord;
  toolCallId?: string;
  title: string;
}): OperationRecord {
  const now = nowIso();
  return {
    id: createId("operation"),
    session_id: input.run.session_id,
    capability_id: "action-catalog",
    operation: "artifact.create",
    actor_identity: "owner",
    instruction_source: "agent_reasoning",
    instruction_authority: "backend-run",
    channel: "web",
    input_hash: stableHash({
      run_id: input.run.id,
      tool_call_id: input.toolCallId ?? "",
      action_id: "artifact.create",
      title: input.title
    }),
    input_ref: backendRunRef(input.run),
    target_resource_refs: [],
    proposed_effects: ["Create a local markdown draft artifact from backend output."],
    status: "completed",
    created_at: now,
    updated_at: now
  };
}

export function backendRunRef(run: BackendRunRecord): ResourceRef {
  return {
    kind: "backend_run",
    id: run.id,
    uri: `backend-runs/${run.id}`,
    label: run.input_summary
  };
}
