import assert from "node:assert/strict";
import { CollectionTriggerExecutor, migrateCollectionSnapshot, validateExecutableCollectionSchema } from "../../packages/runtime/src/collections/safe-collection";
import { stableHash, type CollectionRecord, type CollectionSchema } from "../../packages/core-schemas/src/index";

const baseSchema = schema("1", [{ id: "title", required: true }, { id: "assignee_id", required: true }, { id: "estimate", required: true }], [{ id: "mark_done", kind: "patch" }], [{ id: "on_create", event: "record.created", action_id: "mark_done" }]);
const nextSchema = schema("2", [{ id: "title", required: true }, { id: "owner_id", required: true }, { id: "estimate", required: true }, { id: "status", required: true }], [{ id: "mark_done", kind: "patch" }], [{ id: "on_create", event: "record.created", action_id: "mark_done" }]);
const records: CollectionRecord[] = Array.from({ length: 10_000 }, (_, index) => ({ id: `r${index}`, collection_id: "tasks", version: 1, data: { title: `確認 ${index}`, assignee_id: index === 9_999 ? "removed-owner" : `r${(index + 1) % 9_999}`, estimate: String(index % 13) }, resource_refs: [], created_at: new Date(0).toISOString(), updated_at: new Date(0).toISOString() }));
const record = records[0];
const originalHash = stableHash(records);
const sourceResults = (["human", "agent", "generated_surface"] as const).map((source) => migrateCollectionSnapshot({
  currentSchema: structuredClone(baseSchema), nextSchema: structuredClone(nextSchema), records: structuredClone(records), source,
  steps: [{ id: "v1-v2", from_version: "1", to_version: "2", operations: [{ kind: "rename", from: "assignee_id", to: "owner_id" }, { kind: "add_default", field: "status", value: "open" }, { kind: "convert", field: "estimate", to: "number" }, { kind: "repair_ref", field: "owner_id", replacements: { "removed-owner": "r0" } }] }]
}));
assert.deepEqual(sourceResults.map((result) => result.records[0]?.data), Array(3).fill({ title: "確認 0", owner_id: "r1", estimate: 0, status: "open" }));
assert.equal(sourceResults.every((result) => result.records.length === 10_000), true);
assert.equal(sourceResults.every((result) => { const ids = new Set(result.records.map((item) => item.id)); return result.records.every((item) => typeof item.data.owner_id === "string" && ids.has(item.data.owner_id)); }), true);
assert.equal(stableHash(records), originalHash);

const beforeFailure = JSON.stringify({ baseSchema, record });
assert.throws(() => migrateCollectionSnapshot({
  currentSchema: baseSchema, nextSchema, records: [record], source: "agent",
  steps: [{ id: "bad", from_version: "1", to_version: "2", operations: [{ kind: "rename", from: "assignee_id", to: "owner_id" }, { kind: "convert", field: "estimate", to: "number" }] }]
}), /collection_field_required:status/);
assert.equal(JSON.stringify({ baseSchema, record }), beforeFailure);

assert.throws(() => validateExecutableCollectionSchema(schema("1", [{ id: "title" }], [
  { id: "a", next_actions: ["b"] }, { id: "b", next_actions: ["a"] }
], [])), /collection_action_cycle/);
assert.throws(() => validateExecutableCollectionSchema(schema("1", [{ id: "title" }], [
  { id: "a" }, { id: "a" }
], [])), /collection_action_duplicate/);

const executor = new CollectionTriggerExecutor(); let sideEffects = 0;
const trigger = { collectionId: "tasks", recordId: "r1", recordVersion: 2, triggerId: "on_create", actionId: "mark_done", run: async () => ++sideEffects };
const first = await executor.execute(trigger); const duplicate = await executor.execute(trigger);
assert.equal(first.status, "completed"); assert.equal(duplicate.status, "duplicate"); assert.equal(sideEffects, 1);
let release!: () => void; const blocked = new Promise<void>((resolve) => { release = resolve; });
const cyclic = executor.execute({ ...trigger, recordVersion: 3, run: async () => { await blocked; return 1; } });
await Promise.resolve(); await assert.rejects(executor.execute({ ...trigger, recordVersion: 3, run: async () => 2 }), /collection_trigger_cycle/); release(); await cyclic;

process.stdout.write(`${JSON.stringify({ status: "passed", migrated_records: sourceResults[0].records.length, missing_records: 0, broken_refs: 0, rollback_hash_equal: stableHash(records) === originalHash, migration_sources: sourceResults.map((item) => item.source), rollback_preserved: true, action_cycle_rejected: true, duplicate_action_rejected: true, duplicate_trigger_side_effects: sideEffects, runtime_cycle_rejected: true })}\n`);

function schema(version: string, fields: Array<Record<string, any>>, actions: Array<Record<string, any>>, triggers: Array<Record<string, any>>): CollectionSchema {
  return { id: "tasks", version, labels: { en: "Tasks" }, descriptions: { en: "Tasks" }, fields, refs: [], embeds: [], derived_fields: [], triggers, actions, permissions: {} };
}
