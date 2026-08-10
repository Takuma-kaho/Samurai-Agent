import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { AgentRuntime } from "../../packages/runtime/src/index";
import { WorkspaceStore } from "../../packages/workspace-store/src/index";

const arg = (name: string, fallback: number) => { const index = process.argv.indexOf(name); return index >= 0 ? Number(process.argv[index + 1]) : fallback; };
const accelerated = !process.argv.includes("--wall-clock");
const durationHours = arg("--duration-hours", accelerated ? 0 : 24);
const objectiveCount = arg("--objectives", 100);
const jobCount = arg("--jobs", 1000);
const cycleMs = arg("--cycle-ms", accelerated ? 0 : 60_000);
assert.ok(durationHours >= 0 && objectiveCount > 0 && jobCount >= objectiveCount && cycleMs >= 0);
const root = await mkdtemp(path.join(tmpdir(), "samurai-core-soak-"));
let store = await WorkspaceStore.create({ rootDir: root });
let runtime = new AgentRuntime(store);
const started = Date.now();
const t0 = "2026-01-01T00:00:00.000Z";
let restartCount = 0;
let curatorCycles = 0;

const restart = async () => {
  await runtime.shutdownMcpProcessPool().catch(() => undefined);
  await store.close();
  store = await WorkspaceStore.create({ rootDir: root });
  runtime = new AgentRuntime(store);
  restartCount += 1;
};

try {
  await store.createSession({ id: "soak-session", session_key: "soak:main", title: "Core soak", ui_locale: "ja", output_locale: "ja", created_at: t0, updated_at: t0 });
  for (let objective = 0; objective < objectiveCount; objective += 1) await store.saveObjective({ id: `objective-${objective}`, session_id: "soak-session", title: `Objective ${objective}`, objective: "耐久試験を完了する", completion_criteria: ["全job完了"], status: "active", created_at: t0, updated_at: t0 });
  for (let job = 0; job < jobCount; job += 1) {
    const objectiveId = `objective-${job % objectiveCount}`;
    await store.saveWorkItem({ id: `work-${job}`, objective_id: objectiveId, instruction: `job ${job}`, status: "ready", priority: 0, attempt: 0, max_attempts: 3, idempotency_key: `work-${job}`, created_at: t0, updated_at: t0 });
    await store.enqueueGatewayDelivery({ id: `delivery-${job}`, session_key: "soak:main", channel: "webhook", status: "pending", idempotency_key: `delivery-${job}`, payload: { job }, attempt: 0, max_attempts: 3, created_at: t0, updated_at: t0 });
  }
  for (let index = 0; index < Math.min(10, jobCount); index += 1) await store.saveAutomationJob({ id: `automation-${index}`, title: `Automation ${index}`, kind: index % 2 ? "skill_curator" : "memory_review", status: "enabled", schedule: "* * * * *", target_instruction: "soak", delivery_target: {}, next_run_at: t0, failure_count: 0, max_attempts: 3, created_at: t0, updated_at: t0 });

  let cycle = 0;
  while (true) {
    cycle += 1;
    const now = new Date(Date.parse(t0) + cycle * 60_000).toISOString();
    const expired = new Date(Date.parse(now) + 1).toISOString();
    for (let batch = 0; batch < 100; batch += 1) {
      const work = await store.claimWorkItem({ workerId: `worker-${cycle}`, leaseMs: 1, now });
      if (!work) break;
      if ((Number(work.id.slice(5)) + 1) % 100 === 0 && work.attempt === 1) continue;
      await store.completeWorkItem({ workItemId: work.id, workerId: `worker-${cycle}`, now });
    }
    const deliveries = (await store.listGatewayDeliveries()).filter((item) => item.status === "pending" || item.status === "retry_wait").slice(0, 100);
    for (const delivery of deliveries) {
      const claimed = await store.claimGatewayDelivery(delivery.id, { now, leaseUntil: expired });
      if (!claimed) continue;
      if ((Number(delivery.id.slice(9)) + 1) % 100 === 0 && claimed.attempt === 1) continue;
      await store.completeGatewayDelivery(delivery.id, { now, receipt: { status: 200 } });
    }
    for (const automation of await store.listAutomationJobs({ dueAt: now, enabledOnly: true })) {
      const locked = await store.acquireAutomationJobLock(automation.id, { now, lockedUntil: expired, lockOwnerToken: `soak-${cycle}-${automation.id}` });
      if (locked) await store.requeueAutomationJob(automation.id, { now, nextRunAt: new Date(Date.parse(now) + 60_000).toISOString() });
    }
    await runtime.runCuratorJob({ respectIdleGate: false });
    curatorCycles += 1;
    await restart();
    const recoveryAt = new Date(Date.parse(now) + 2).toISOString();
    await store.reconcileExpiredWorkItems({ now: recoveryAt, baseRetryMs: 0 });
    await store.reconcileExpiredGatewayDeliveries(recoveryAt);
    const remainingWork = (await store.listWorkItems()).some((item) => !["completed", "failed", "cancelled"].includes(item.status));
    const remainingDelivery = (await store.listGatewayDeliveries()).some((item) => !["delivered", "failed"].includes(item.status));
    const wallDone = accelerated ? cycle >= Math.ceil(jobCount / 90) + 2 : Date.now() - started >= durationHours * 3_600_000;
    if (wallDone && !remainingWork && !remainingDelivery) break;
    if (!accelerated) await delay(cycleMs);
  }

  const work = await store.listWorkItems();
  const objectives = await store.listObjectives();
  const deliveries = await store.listGatewayDeliveries();
  const objectiveIds = new Set(objectives.map((item) => item.id));
  const stuck = work.filter((item) => !["completed", "failed", "cancelled"].includes(item.status)).length + deliveries.filter((item) => !["delivered", "failed"].includes(item.status)).length;
  const orphan = work.filter((item) => !objectiveIds.has(item.objective_id)).length;
  const duplicate = jobCount - new Set(work.map((item) => item.idempotency_key)).size + jobCount - new Set(deliveries.map((item) => item.idempotency_key)).size;
  const dataLoss = jobCount - work.length + jobCount - deliveries.length;
  assert.deepEqual({ stuck, orphan, duplicate, dataLoss }, { stuck: 0, orphan: 0, duplicate: 0, dataLoss: 0 });
  assert.equal(work.every((item) => item.status === "completed"), true);
  assert.equal(deliveries.every((item) => item.status === "delivered"), true);
  const elapsedHours = (Date.now() - started) / 3_600_000;
  const scalePassed = objectiveCount >= 100 && jobCount >= 1000;
  const durationPassed = accelerated || elapsedHours >= 24;
  process.stdout.write(`${JSON.stringify({ status: scalePassed && durationPassed ? "passed" : "partial", mode: accelerated ? "accelerated" : "wall_clock", duration_hours: elapsedHours, requested_duration_hours: durationHours, objectives: objectives.length, jobs: work.length, gateway_deliveries: deliveries.length, curator_cycles: curatorCycles, restart_count: restartCount, injected_kills: work.filter((item) => item.attempt > 1).length + deliveries.filter((item) => item.attempt > 1).length, stuck, orphan, duplicate, data_loss: dataLoss })}\n`);
} finally {
  await runtime.shutdownMcpProcessPool().catch(() => undefined);
  await store.close().catch(() => undefined);
  await rm(root, { recursive: true, force: true });
}
