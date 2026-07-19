import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createId, nowIso, type ObjectiveRecord, type RunCheckpointRecord, type WorkItemRecord } from "../../packages/core-schemas/src/index";
import { WorkspaceStore } from "../../packages/workspace-store/src/index";
import { DurableDomainCommandBus } from "../../packages/runtime/src/commands/domain-command-bus";

const root = await mkdtemp(path.join(tmpdir(), "samurai-durable-work-"));
let primary = await WorkspaceStore.create({ rootDir: root });
let secondary = await WorkspaceStore.create({ rootDir: root });

try {
  const createdAt = nowIso();
  const objective: ObjectiveRecord = {
    id: createId("objective"),
    title: "Durable work fixture",
    objective: "Prove restart-safe, dependency-aware work execution.",
    completion_criteria: ["Both dependent work items complete", "Checkpoint survives restart"],
    status: "active",
    created_at: createdAt,
    updated_at: createdAt
  };
  await primary.saveObjective(objective);

  const first: WorkItemRecord = {
    id: createId("work"), objective_id: objective.id, instruction: "First work item", status: "ready",
    priority: 10, attempt: 0, max_attempts: 3, idempotency_key: "durable-work-first", created_at: createdAt, updated_at: createdAt
  };
  const second: WorkItemRecord = {
    id: createId("work"), objective_id: objective.id, instruction: "Dependent work item", status: "ready",
    priority: 5, attempt: 0, max_attempts: 3, idempotency_key: "durable-work-second", created_at: createdAt, updated_at: createdAt
  };
  await primary.saveWorkItem(first);
  await primary.saveWorkItem(second);
  await primary.saveWorkDependency({
    id: createId("dependency"), objective_id: objective.id, predecessor_work_item_id: first.id,
    successor_work_item_id: second.id, kind: "blocks", created_at: createdAt
  });

  const claims = await Promise.all(Array.from({ length: 100 }, (_, index) => (index % 2 ? primary : secondary).claimWorkItem({
    workerId: `worker-${index}`,
    leaseMs: 5_000,
    now: createdAt
  })));
  const winners = claims.filter((item): item is WorkItemRecord => Boolean(item));
  assert.equal(winners.length, 1);
  assert.equal(winners[0].id, first.id);
  assert.equal(winners[0].attempt, 1);
  let claimedSideEffects = 0;
  if (winners[0]) claimedSideEffects += 1;
  assert.equal(claimedSideEffects, 1);

  const blockedClaim = await secondary.claimWorkItem({ workerId: "blocked-worker", leaseMs: 5_000, now: createdAt });
  assert.equal(blockedClaim, undefined);

  const checkpoint: RunCheckpointRecord = {
    id: createId("checkpoint"), objective_id: objective.id, work_item_id: first.id, sequence: 1,
    phase: "before_side_effect", idempotency_key: "durable-checkpoint-before-1", summary: "Before side effect",
    generated_resource_refs: [], pending_operation_ids: ["operation-1"], state: { cursor: 7 }, created_at: createdAt
  };
  const savedCheckpoint = await primary.saveRunCheckpoint(checkpoint);
  const replayedCheckpoint = await secondary.saveRunCheckpoint({ ...checkpoint, id: createId("checkpoint") });
  assert.equal(replayedCheckpoint.id, savedCheckpoint.id);
  let toolSideEffects = 0;
  const toolCommand = {
    commandId: "fixture.tool.step",
    inputSource: "automation",
    payload: { work_item_id: first.id },
    idempotencyKey: `${first.id}:tool-step-1`
  } as const;
  await new DurableDomainCommandBus(primary).execute(toolCommand, async () => ({ value: ++toolSideEffects }));

  const owner = winners[0].lease_owner!;
  const heartbeated = await primary.heartbeatWorkItem({ workItemId: first.id, workerId: owner, leaseMs: 5_000, now: new Date(Date.parse(createdAt) + 1_000).toISOString() });
  assert.ok(heartbeated?.lease_expires_at);
  assert.equal(await secondary.heartbeatWorkItem({ workItemId: first.id, workerId: "wrong-owner", leaseMs: 5_000 }), undefined);

  await primary.close();
  await secondary.close();
  primary = await WorkspaceStore.create({ rootDir: root });
  secondary = await WorkspaceStore.create({ rootDir: root });
  assert.equal((await primary.listRunCheckpoints(first.id))[0]?.id, savedCheckpoint.id);
  assert.equal((await primary.getWorkItem(first.id))?.current_checkpoint_id, savedCheckpoint.id);
  const replayedTool = await new DurableDomainCommandBus(primary).execute(toolCommand, async () => ({ value: ++toolSideEffects }));
  assert.deepEqual(replayedTool, { value: 1 });
  assert.equal(toolSideEffects, 1);
  await primary.saveRunCheckpoint({
    ...checkpoint,
    id: createId("checkpoint"),
    sequence: 2,
    phase: "after_side_effect",
    idempotency_key: "durable-checkpoint-after-1",
    summary: "Tool completed and replayed without duplication",
    pending_operation_ids: []
  });
  const restoredObjective = await primary.getObjective(objective.id);
  assert.deepEqual(restoredObjective?.completion_criteria, objective.completion_criteria);

  const expiredAt = new Date(Date.parse(heartbeated!.lease_expires_at!) + 1).toISOString();
  const reconciled = await primary.reconcileExpiredWorkItems({ now: expiredAt, baseRetryMs: 10 });
  assert.equal(reconciled.length, 1);
  assert.equal(reconciled[0].status, "ready");
  assert.equal(reconciled[0].failure_kind, "retryable");

  const retryAt = new Date(Date.parse(reconciled[0].retry_after_at!) + 1).toISOString();
  const reclaimed = await secondary.claimWorkItem({ workerId: "recovery-worker", leaseMs: 5_000, now: retryAt });
  assert.equal(reclaimed?.id, first.id);
  assert.equal(reclaimed?.attempt, 2);
  assert.ok(await secondary.completeWorkItem({ workItemId: first.id, workerId: "recovery-worker", now: retryAt }));

  const dependent = await primary.claimWorkItem({ workerId: "dependency-worker", leaseMs: 5_000, now: retryAt });
  assert.equal(dependent?.id, second.id);
  const failed = await primary.failWorkItem({
    workItemId: second.id, workerId: "dependency-worker", failureKind: "non_retryable", error: "fixture_non_retryable", now: retryAt
  });
  assert.equal(failed?.status, "failed");
  assert.equal(failed?.retry_after_at, undefined);

  const budgetItem: WorkItemRecord = {
    id: createId("work"), objective_id: objective.id, instruction: "Attempt budget fixture", status: "ready",
    priority: 1, attempt: 0, max_attempts: 1, idempotency_key: "durable-work-budget", created_at: retryAt, updated_at: retryAt
  };
  await primary.saveWorkItem(budgetItem);
  const budgetClaim = await primary.claimWorkItem({ workerId: "budget-worker", leaseMs: 5_000, now: retryAt });
  assert.equal(budgetClaim?.id, budgetItem.id);
  const budgetFailure = await primary.failWorkItem({
    workItemId: budgetItem.id, workerId: "budget-worker", failureKind: "retryable", error: "retryable_but_budget_exhausted", now: retryAt
  });
  assert.equal(budgetFailure?.status, "failed");

  const stillActive = await primary.getObjective(objective.id);
  assert.equal(stillActive?.status, "active", "Objective must not auto-complete without explicit criteria evaluation");

  const killObjective: ObjectiveRecord = { id: "kill-objective", title: "Process kill", objective: "Recover after SIGKILL", completion_criteria: ["Recovered worker completes"], status: "active", created_at: retryAt, updated_at: retryAt };
  const killWork: WorkItemRecord = { id: "kill-work", objective_id: killObjective.id, instruction: "Persist then crash", status: "ready", priority: 100, attempt: 0, max_attempts: 3, idempotency_key: "kill-work", created_at: retryAt, updated_at: retryAt };
  await primary.saveObjective(killObjective);
  await primary.saveWorkItem(killWork);
  const workerPath = process.env.SAMURAI_KILL_WORKER;
  assert.ok(workerPath, "SAMURAI_KILL_WORKER missing");
  const child = spawn(process.execPath, [workerPath, root, killObjective.id, killWork.id, retryAt], { stdio: ["ignore", "pipe", "inherit"] });
  let ready = "";
  for await (const chunk of child.stdout!) { ready += chunk.toString(); if (ready.includes("READY")) break; }
  assert.match(ready, /READY/);
  assert.equal(child.kill("SIGKILL"), true);
  const [exitCode, exitSignal] = await once(child, "exit") as [number | null, NodeJS.Signals | null];
  assert.equal(exitCode, null);
  assert.equal(exitSignal, "SIGKILL");
  assert.equal((await primary.listRunCheckpoints(killWork.id))[0]?.id, "kill-checkpoint");
  const killRecoveryAt = new Date(Date.parse(retryAt) + 10).toISOString();
  const killReconciled = await primary.reconcileExpiredWorkItems({ now: killRecoveryAt, baseRetryMs: 0 });
  assert.equal(killReconciled.some((item) => item.id === killWork.id && item.status === "ready"), true);
  const killClaim = await secondary.claimWorkItem({ workerId: "post-kill-worker", leaseMs: 5_000, now: killRecoveryAt });
  assert.equal(killClaim?.id, killWork.id);
  assert.ok(await secondary.completeWorkItem({ workItemId: killWork.id, workerId: "post-kill-worker", now: killRecoveryAt }));

  process.stdout.write(`${JSON.stringify({
    status: "passed", parallel_claims: 100, claim_winners: winners.length, claim_side_effects: claimedSideEffects, dependency_blocked: true,
    heartbeat_owner_enforced: true, restart_checkpoint_recovered: true, restart_completion_criteria_recovered: true, checkpoint_idempotent: true,
    side_effect_replay_count: toolSideEffects,
    stale_lease_reconciled: true, retry_attempt: reclaimed?.attempt, non_retryable_terminal: failed?.status === "failed",
    attempt_budget_terminal: budgetFailure?.status === "failed", objective_requires_explicit_completion: stillActive?.status === "active",
    actual_process_killed: exitSignal === "SIGKILL", kill_checkpoint_recovered: true, kill_lease_reconciled: true, post_kill_completed: (await primary.getWorkItem(killWork.id))?.status === "completed"
  })}\n`);
} finally {
  await primary.close().catch(() => undefined);
  await secondary.close().catch(() => undefined);
  await rm(root, { recursive: true, force: true });
}
