import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { nowIso, type CollectionSchema } from "../../packages/core-schemas/src/index";
import { WorkspaceSimulatedCrashError, WorkspaceStore } from "../../packages/workspace-store/src/index";

const phases = ["planned", "staged", "db_committed", "renamed"] as const;
const outcomes: Array<{ phase: string; version: number; action: "rollback" | "complete" }> = [];

for (const phase of phases) {
  const root = await mkdtemp(path.join(tmpdir(), `samurai-file-transaction-${phase}-`));
  let store = await WorkspaceStore.create({ rootDir: root });
  try {
    const schema: CollectionSchema = {
      id: "items", version: "1", labels: { en: "Items" }, descriptions: { en: "Items" },
      fields: [{ id: "name", type: "string", required: true }], refs: [], embeds: [], derived_fields: [], triggers: [], actions: [], views: [], permissions: {}
    };
    await store.saveCollectionSchema(schema);
    const createdAt = nowIso();
    const original = await store.saveCollectionRecord({ id: "item-1", collection_id: schema.id, version: 1, data: { name: "before" }, resource_refs: [], created_at: createdAt, updated_at: createdAt });
    await store.close();
    store = await WorkspaceStore.create({
      rootDir: root,
      fileTransactionFailureInjector(current) {
        if (current === phase) throw new WorkspaceSimulatedCrashError(`simulated_crash:${phase}`);
      }
    });
    await assert.rejects(store.applyCollectionRecordPatch({
      collectionId: schema.id,
      recordId: original.id,
      patch: { id: `patch-${phase}`, record_id: original.id, expected_version: 1, changes: { name: "after" }, source_operation_id: "fixture", created_at: nowIso() }
    }), WorkspaceSimulatedCrashError);
    await store.close();

    store = await WorkspaceStore.create({ rootDir: root });
    const recovered = await store.getCollectionRecord(schema.id, original.id);
    assert.ok(recovered);
    const file = JSON.parse(await readFile(path.join(root, recovered.file_path), "utf8")) as { version: number; data: { name: string } };
    assert.equal(file.version, recovered.version);
    assert.equal(file.data.name, recovered.data.name);
    assert.equal(await store.countPendingWorkspaceFileTransactions(), 0);
    const shouldComplete = phase === "db_committed" || phase === "renamed";
    assert.equal(recovered.version, shouldComplete ? 2 : 1);
    outcomes.push({ phase, version: recovered.version, action: shouldComplete ? "complete" : "rollback" });
  } finally {
    await store.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
}

process.stdout.write(`${JSON.stringify({ status: "passed", failure_points: outcomes, consistent_outcomes: outcomes.length, pending_transactions: 0 })}\n`);
