import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { sql } from "kysely";
import { nowIso, type CollectionSchema } from "../../packages/core-schemas/src/index";
import { WorkspaceDatabase } from "../../packages/workspace-store/src/kernel/workspace-database";
import { WorkspacePaths } from "../../packages/workspace-store/src/kernel/workspace-paths";
import { CollectionRecordRecoveryHandler } from "../../packages/workspace-store/src/transactions/collection-record-recovery-handler";
import { WorkspaceFileTransactionCoordinator } from "../../packages/workspace-store/src/transactions/workspace-file-transaction-coordinator";
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

async function verifyOrdinaryFailureRecovery(phase: "db_committed" | "renamed"): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), `samurai-file-transaction-ordinary-${phase}-`));
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
        if (current === phase) throw new Error(`ordinary_failure:${phase}`);
      }
    });
    await assert.rejects(store.applyCollectionRecordPatch({
      collectionId: schema.id,
      recordId: original.id,
      patch: { id: `ordinary-patch-${phase}`, record_id: original.id, expected_version: 1, changes: { name: "after" }, source_operation_id: "fixture", created_at: nowIso() }
    }), new RegExp(`ordinary_failure:${phase}`));
    await store.close();

    store = await WorkspaceStore.create({ rootDir: root });
    const recovered = await store.getCollectionRecord(schema.id, original.id);
    assert.ok(recovered);
    const file = JSON.parse(await readFile(path.join(root, recovered.file_path), "utf8")) as { version: number; data: { name: string } };
    assert.equal(recovered.version, 2);
    assert.equal(file.version, 2);
    assert.equal(file.data.name, "after");
    assert.equal(await store.countPendingWorkspaceFileTransactions(), 0);
  } finally {
    await store.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
}

async function verifyRollbackFailurePreservesRecovery(): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "samurai-file-transaction-rollback-failure-"));
  const seed = await WorkspaceStore.create({ rootDir: root });
  await seed.close();
  const paths = new WorkspacePaths(root);
  const database = new WorkspaceDatabase(paths);
  const db = database.open();
  try {
    await sql.raw("CREATE TABLE coordinator_probe (id TEXT PRIMARY KEY, value TEXT NOT NULL)").execute(db);
    await sql`INSERT INTO coordinator_probe(id, value) VALUES (${"probe"}, ${"before"})`.execute(db);
    const handler = new CollectionRecordRecoveryHandler(db, root);
    const coordinator = new WorkspaceFileTransactionCoordinator(db, root, undefined, [handler]);
    const before = JSON.stringify({ id: "probe-record", collection_id: "probe", version: 1 });
    const after = JSON.stringify({ id: "probe-record", collection_id: "probe", version: 2 });
    await assert.rejects(coordinator.execute({
      kind: "collection_record_patch",
      targetPath: "collections/coordinator-target/record.json",
      stagedPath: "collections/coordinator-pending.json",
      collectionId: "probe",
      recordId: "probe-record",
      patchId: "probe-patch",
      beforeJson: before,
      afterJson: after,
      stagedContent: `${JSON.stringify({ version: 2, data: { name: "after" } })}\n`,
      commit: async (transaction) => {
        await sql`UPDATE coordinator_probe SET value = ${"after"} WHERE id = ${"probe"}`.execute(transaction);
      },
      rollback: async (transaction) => {
        await sql`UPDATE coordinator_probe SET value = ${"before"} WHERE id = ${"probe"}`.execute(transaction);
        throw new Error("rollback_failed");
      }
    }), /rollback_failed/);
    const committed = await sql<{ value: string }>`SELECT value FROM coordinator_probe WHERE id = ${"probe"}`.execute(db);
    assert.equal(committed.rows[0]?.value, "after");
    assert.equal(await coordinator.countPending(), 1);

    await mkdir(path.join(root, "collections", "coordinator-target"), { recursive: true });
    assert.deepEqual(await coordinator.recoverPending(), { completed: 1, rolled_back: 0 });
    assert.equal(await coordinator.countPending(), 0);
    const recovered = JSON.parse(await readFile(path.join(root, "collections", "coordinator-target", "record.json"), "utf8")) as { version: number };
    assert.equal(recovered.version, 2);
  } finally {
    await database.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function verifyRollbackConflictStopsRecovery(): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "samurai-file-transaction-rollback-conflict-"));
  let store = await WorkspaceStore.create({ rootDir: root });
  try {
    const schema: CollectionSchema = {
      id: "items", version: "1", labels: { en: "Items" }, descriptions: { en: "Items" },
      fields: [{ id: "name", type: "string", required: true }], refs: [], embeds: [], derived_fields: [], triggers: [], actions: [], views: [], permissions: {}
    };
    await store.saveCollectionSchema(schema);
    const createdAt = nowIso();
    const before = await store.saveCollectionRecord({ id: "item-1", collection_id: schema.id, version: 1, data: { name: "before" }, resource_refs: [], created_at: createdAt, updated_at: createdAt });
    const after = { ...before, version: 2, data: { name: "after" }, updated_at: nowIso() };
    const newer = { ...before, version: 3, data: { name: "newer" }, updated_at: nowIso() };
    await store.close();

    const raw = new Database(path.join(root, "workspace.sqlite"));
    try {
      raw.prepare("UPDATE collection_records SET record_json = ?, version = ?, updated_at = ? WHERE collection_id = ? AND id = ?")
        .run(JSON.stringify(newer), newer.version, newer.updated_at, before.collection_id, before.id);
      raw.prepare("INSERT INTO workspace_file_transactions(id, kind, status, target_path, staged_path, collection_id, record_id, patch_id, before_json, after_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run("rollback-conflict", "collection_record_patch", "db_committed", before.file_path, `${before.file_path}.pending-conflict`, before.collection_id, before.id, "conflict-patch", JSON.stringify(before), JSON.stringify(after), nowIso(), nowIso());
    } finally {
      raw.close();
    }

    await assert.rejects(WorkspaceStore.create({ rootDir: root }), /workspace_file_transaction_rollback_conflict:items:item-1/);
    const verification = new Database(path.join(root, "workspace.sqlite"), { readonly: true });
    try {
      const row = verification.prepare("SELECT version FROM collection_records WHERE collection_id = ? AND id = ?").get(before.collection_id, before.id) as { version: number } | undefined;
      const journal = verification.prepare("SELECT COUNT(*) AS count FROM workspace_file_transactions WHERE id = ?").get("rollback-conflict") as { count: number };
      assert.equal(row?.version, 3);
      assert.equal(Number(journal.count), 1);
    } finally {
      verification.close();
    }
  } finally {
    await store.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
}

await verifyOrdinaryFailureRecovery("db_committed");
await verifyOrdinaryFailureRecovery("renamed");
await verifyRollbackFailurePreservesRecovery();
await verifyRollbackConflictStopsRecovery();

const unknownKindRoot = await mkdtemp(path.join(tmpdir(), "samurai-file-transaction-unknown-"));
try {
  const seed = await WorkspaceStore.create({ rootDir: unknownKindRoot });
  await seed.close();
  const database = new Database(path.join(unknownKindRoot, "workspace.sqlite"));
  try {
    const now = nowIso();
    database.prepare("INSERT INTO workspace_file_transactions(id, kind, status, target_path, staged_path, collection_id, record_id, patch_id, before_json, after_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("unknown-kind", "future_transaction_kind", "planned", "collections/unknown.json", "collections/unknown.json.pending", null, null, null, "{}", "{}", now, now);
  } finally {
    database.close();
  }
  await assert.rejects(WorkspaceStore.create({ rootDir: unknownKindRoot }), /workspace_file_transaction_handler_missing:future_transaction_kind/);
  const verification = new Database(path.join(unknownKindRoot, "workspace.sqlite"), { readonly: true });
  try {
    const row = verification.prepare("SELECT COUNT(*) AS count FROM workspace_file_transactions WHERE id = ?").get("unknown-kind") as { count: number };
    assert.equal(Number(row.count), 1);
  } finally {
    verification.close();
  }
} finally {
  await rm(unknownKindRoot, { recursive: true, force: true });
}

process.stdout.write(`${JSON.stringify({ status: "passed", failure_points: outcomes, consistent_outcomes: outcomes.length, pending_transactions: 0, ordinary_error_recovery: true, rollback_failure_preserves_recovery: true, rollback_conflict_rejected: true, unknown_kind_rejected: true })}\n`);
