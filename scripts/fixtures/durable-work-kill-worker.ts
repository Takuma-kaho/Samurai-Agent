import { WorkspaceStore } from "../../packages/workspace-store/src/index";

const [root, objectiveId, workItemId, now] = process.argv.slice(2);
if (!root || !objectiveId || !workItemId || !now) throw new Error("kill worker arguments missing");
const store = await WorkspaceStore.create({ rootDir: root });
const claimed = await store.claimWorkItem({ workerId: "kill-worker", leaseMs: 5, now });
if (!claimed || claimed.id !== workItemId) throw new Error("kill worker claim failed");
await store.saveRunCheckpoint({ id: "kill-checkpoint", objective_id: objectiveId, work_item_id: workItemId, sequence: 1, phase: "before_side_effect", idempotency_key: "kill-checkpoint", summary: "Persisted before forced process termination", generated_resource_refs: [], pending_operation_ids: ["kill-side-effect"], state: { durable: true }, created_at: now });
process.stdout.write("READY\n");
setInterval(() => undefined, 60_000);
