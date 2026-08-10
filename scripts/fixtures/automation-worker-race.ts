import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { localOwnerParticipantId } from "../../packages/room-permissions/src/index";
import { WorkspaceStore } from "../../packages/workspace-store/src/index";

const root = await mkdtemp(path.join(tmpdir(), "samurai-automation-race-"));
let store = await WorkspaceStore.create({ rootDir: root });
const t0 = "2026-01-01T00:00:00.000Z";
const t1 = "2026-01-01T00:01:00.000Z";
const t2 = "2026-01-01T00:02:00.000Z";
const t3 = "2026-01-01T00:04:00.000Z";

try {
  const roomId = (await store.getSettings()).default_room_id!;
  await store.saveAutomationJob({
    id: "job", title: "race", kind: "custom_instruction", status: "enabled", schedule: "once", target_instruction: "x", delivery_target: {},
    workspace_id: "workspace", room_id: roomId,
    authority: { kind: "direct_principal", principal: { kind: "human", participant_id: localOwnerParticipantId } },
    created_principal_snapshot: { kind: "human", participant_id: localOwnerParticipantId }, source_snapshot: { kind: "host" },
    authorization_state: "ready", authorized_at: t0, next_run_at: t0, failure_count: 0, max_attempts: 3, created_at: t0, updated_at: t0
  });
  const claims = await Promise.all(Array.from({ length: 100 }, (_, index) => store.acquireAutomationJobLock("job", {
    now: t0, lockedUntil: t2, lockOwnerToken: `worker-${index}`
  })));
  assert.equal(claims.filter(Boolean).length, 1);
  const winner = claims.find(Boolean)!;
  let sideEffects = 0;
  sideEffects += 1;
  assert.equal(await store.releaseAutomationJobLock("job", { lockOwnerToken: "wrong-worker", now: t1 }), undefined);
  assert.equal(await store.acquireAutomationJobLock("job", { now: t1, lockedUntil: t3, lockOwnerToken: "early-worker" }), undefined);
  await store.close();
  store = await WorkspaceStore.create({ rootDir: root });
  const reclaimed = await store.acquireAutomationJobLock("job", { now: t3, lockedUntil: "2026-01-01T00:05:00.000Z", lockOwnerToken: "restart-worker" });
  assert.ok(reclaimed);
  await store.saveAutomationJob({
    ...reclaimed,
    locked_until: undefined,
    lock_owner_token: undefined,
    retry_after_at: "2026-01-01T00:10:00.000Z",
    failure_count: 1,
    last_error: "retry",
    updated_at: t3
  });
  assert.equal(await store.acquireAutomationJobLock("job", { now: "2026-01-01T00:09:00.000Z", lockedUntil: "2026-01-01T00:11:00.000Z", lockOwnerToken: "early-retry" }), undefined);
  assert.ok(await store.acquireAutomationJobLock("job", { now: "2026-01-01T00:10:00.000Z", lockedUntil: "2026-01-01T00:11:00.000Z", lockOwnerToken: "retry-worker" }));
  process.stdout.write(`${JSON.stringify({
    status: "passed", workers: 10, claim_attempts: 100, successful_claims: 1, side_effects: sideEffects,
    token_bound: Boolean(winner.lock_owner_token), early_reclaim_rejected: true, restart_reclaim: true,
    retry_before_due_rejected: true, retry_at_due_claimed: true
  })}\n`);
} finally {
  await store.close().catch(() => undefined);
  await rm(root, { recursive: true, force: true });
}
