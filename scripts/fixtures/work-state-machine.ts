import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ObjectiveRecord, WorkItemRecord } from "../../packages/core-schemas/src/index";
import { AgentBackendRegistry, type AgentBackend } from "../../packages/agent-backends/src/index";
import { WorkspaceStore } from "../../packages/workspace-store/src/index";
import { DurableWorkCoordinator } from "../../packages/runtime/src/execution/durable-work-coordinator";
import { createFollowUpWorkItem, steerWorkItem, transitionObjectiveState, WorkStateTransitionError } from "../../packages/runtime/src/execution/work-state-machine";

const now = "2026-07-11T00:00:00.000Z";
const objective: ObjectiveRecord = {
  id: "objective-model", title: "Model", objective: "Exercise all transitions", completion_criteria: ["model passes"],
  status: "active", created_at: now, updated_at: now
};
const workItems: WorkItemRecord[] = [
  { id: "running", objective_id: objective.id, instruction: "running", status: "running", priority: 2, attempt: 1, max_attempts: 3, idempotency_key: "running", lease_owner: "worker", lease_expires_at: now, heartbeat_at: now, backend_run_id: "backend-running", created_at: now, updated_at: now },
  { id: "ready", objective_id: objective.id, instruction: "ready", status: "ready", priority: 1, attempt: 0, max_attempts: 3, idempotency_key: "ready", created_at: now, updated_at: now },
  { id: "completed", objective_id: objective.id, instruction: "completed", status: "completed", priority: 0, attempt: 1, max_attempts: 3, idempotency_key: "completed", created_at: now, updated_at: now, completed_at: now }
];

const paused = transitionObjectiveState({ objective, workItems, action: "pause", now });
assert.equal(paused.objective.status, "paused");
assert.equal(paused.workItems.find((item) => item.id === "running")?.status, "waiting");
assert.equal(paused.workItems.find((item) => item.id === "ready")?.status, "ready");

const resumed = transitionObjectiveState({ objective: paused.objective, workItems: paused.workItems, action: "resume", now });
assert.equal(resumed.objective.status, "active");
assert.equal(resumed.workItems.find((item) => item.id === "running")?.status, "ready");

const steered = steerWorkItem({ workItem: { ...workItems[0], status: "waiting" }, instruction: "Use the verified source", now });
assert.match(steered.instruction, /Steer: Use the verified source/);
const followUp = createFollowUpWorkItem({ objective, current: workItems[0], instruction: "Publish the verified result", now });
assert.equal(followUp.workItem.parent_work_item_id, workItems[0].id);
assert.equal(followUp.dependency.predecessor_work_item_id, workItems[0].id);

const cancelled = transitionObjectiveState({ objective, workItems: [...workItems, followUp.workItem], action: "cancel", now });
assert.deepEqual(cancelled.cancelBackendRunIds, ["backend-running"]);
assert.equal(cancelled.workItems.find((item) => item.id === "completed")?.status, "completed");
assert.ok(cancelled.workItems.filter((item) => item.id !== "completed").every((item) => item.status === "cancelled"));

for (const status of ["paused", "blocked", "completed", "cancelled", "failed"] as const) {
  if (status !== "paused" && status !== "blocked") {
    assert.throws(() => transitionObjectiveState({ objective: { ...objective, status }, workItems, action: "resume", now }), WorkStateTransitionError);
  }
  if (status !== "completed" && status !== "cancelled" && status !== "failed") {
    continue;
  }
  assert.throws(() => transitionObjectiveState({ objective: { ...objective, status }, workItems, action: "cancel", now }), WorkStateTransitionError);
}
assert.throws(() => steerWorkItem({ workItem: workItems[1], instruction: "invalid", now }), WorkStateTransitionError);

const root = await mkdtemp(path.join(tmpdir(), "samurai-work-state-persistence-"));
const store = await WorkspaceStore.create({ rootDir: root });
let cancelledBackendRun = "";
const backend: AgentBackend = {
  id: "state-backend", kind: "mock", label: "State backend",
  async *runTurn() { yield { event_type: "run_completed", payload: {} }; },
  async cancelRun(runId) { cancelledBackendRun = runId; }
};
try {
  await store.createSession({ id: "session-model", session_key: "web:model:main", title: "Model", ui_locale: "en", output_locale: "en", created_at: now, updated_at: now });
  await store.saveObjective(objective);
  await store.saveWorkItem(workItems[0]);
  await store.saveBackendRun({
    id: "backend-running", session_id: "session-model", input_message_id: "message-model", backend_id: backend.id,
    backend_kind: backend.kind, status: "running", started_at: now, input_summary: "model", metadata: {}
  });
  const coordinator = new DurableWorkCoordinator(store, new AgentBackendRegistry([backend]));
  const persistedSteer = await coordinator.steer(workItems[0].id, "Persist this steering instruction", now);
  assert.match((await store.getWorkItem(persistedSteer.id))!.instruction, /Persist this steering instruction/);
  const persistedFollowUp = await coordinator.followUp(workItems[0].id, "Persist this follow-up", now);
  assert.equal((await store.listWorkDependencies(objective.id))[0]?.successor_work_item_id, persistedFollowUp.workItem.id);
  await coordinator.transitionObjective(objective.id, "cancel", now);
  assert.equal(cancelledBackendRun, "backend-running");
  assert.equal((await store.getBackendRun("backend-running"))?.status, "cancelled");
  assert.equal((await store.getWorkItem(workItems[0].id))?.status, "cancelled");
} finally {
  await store.close();
  await rm(root, { recursive: true, force: true });
}

process.stdout.write(`${JSON.stringify({
  status: "passed", pause_resume: true, cancel_propagation: true, backend_cancel_ids: cancelled.cancelBackendRunIds,
  steer_is_current_item: true, follow_up_is_dependent_child: true, terminal_state_guards: true,
  persisted_state_transitions: true, backend_cancel_propagated: cancelledBackendRun === "backend-running"
})}\n`);
