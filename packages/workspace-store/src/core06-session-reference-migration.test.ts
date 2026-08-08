import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceMigrationRunner } from "./kernel/migration-runner.js";
import type { WorkspaceDb } from "./kernel/workspace-db-schema.js";
import { workspaceMigrations } from "./migrations/index.js";
import { WorkspaceStore } from "./workspace-store.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Core06 Session reference migration", () => {
  it("migrates a version-10 run without inferring a Room and survives backup/restore", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-core06-v10-"));
    roots.push(root);
    const dbPath = path.join(root, "workspace.sqlite");
    const now = "2026-08-06T00:00:00.000Z";
    await createVersion10Fixture(dbPath, now);

    const store = await WorkspaceStore.create({ rootDir: root });
    const migrated = await store.getBackendRun("run-v10-legacy");
    const events = await store.listBackendEvents({ runId: "run-v10-legacy" });
    const backup = await store.createWorkspaceBackup();
    const restored = await store.restoreWorkspaceBackup(backup.id);
    const afterRestore = await store.getBackendRun("run-v10-legacy");
    const migrations = await store.listSchemaMigrations();
    await store.close();

    const check = new Database(dbPath, { readonly: true });
    let indexNames: string[] = [];
    try {
      expect(check.pragma("foreign_key_check")).toEqual([]);
      indexNames = (check.prepare(`SELECT name FROM sqlite_master
        WHERE type = 'index' AND tbl_name IN ('backend_events', 'operations', 'learning_resource_uses')`)
        .all() as Array<{ name: string }>)
        .map((row) => row.name);
    } finally {
      check.close();
    }

    expect(migrated).toMatchObject({
      id: "run-v10-legacy",
      session_id: "session-v10-legacy",
      backend_id: "mock",
      status: "completed"
    });
    expect(migrated?.room_id).toBeUndefined();
    expect(migrated?.principal).toBeUndefined();
    expect(events).toEqual([expect.objectContaining({ run_id: "run-v10-legacy", session_id: "session-v10-legacy" })]);
    expect(restored.integrity.ok).toBe(true);
    expect(afterRestore).toMatchObject({ id: "run-v10-legacy", session_id: "session-v10-legacy" });
    expect(migrations).toContainEqual(expect.objectContaining({ version: 11, name: "core06_session_reference_boundary" }));
    expect(indexNames).toEqual(expect.arrayContaining([
      "idx_backend_events_source_identity",
      "idx_backend_events_source_sequence",
      "idx_operations_run_id",
      "idx_learning_resource_uses_activity",
      "idx_learning_resource_uses_applied"
    ]));
  });
});

async function createVersion10Fixture(dbPath: string, now: string): Promise<void> {
  const database = new Database(dbPath);
  database.pragma("foreign_keys = ON");
  const db = new Kysely<WorkspaceDb>({ dialect: new SqliteDialect({ database }) });
  try {
    await new WorkspaceMigrationRunner(db, workspaceMigrations.filter((migration) => migration.version <= 10)).migrate();
  } finally {
    await db.destroy();
  }

  const legacy = new Database(dbPath);
  try {
    legacy.pragma("foreign_keys = ON");
    legacy.prepare(`INSERT INTO sessions(id, session_key, title, ui_locale, output_locale, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run("session-v10-legacy", "native:legacy", "Legacy", "ja", "ja", now, now);
    legacy.prepare(`INSERT INTO backend_runs(
      id, session_id, input_message_id, output_message_id, backend_id, backend_kind,
      backend_session_id, status, phase, current_attempt, request_idempotency_key,
      request_hash, started_at, completed_at, input_summary, output_summary,
      error_code, metadata_json, requested_by_participant_id
    ) VALUES (?, ?, ?, NULL, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL)`)
      .run(
        "run-v10-legacy", "session-v10-legacy", "message-v10-input", "mock", "mock",
        "completed", "settled", 1, "legacy-key", "legacy-hash", now, now,
        "Legacy run", "done", "{}"
      );
    legacy.prepare(`INSERT INTO backend_events(
      id, run_id, session_id, backend_session_id, event_type, sequence, attempt_no,
      source_event_id, source_sequence, payload_json, resource_refs_json, created_at
    ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        "event-v10-legacy", "run-v10-legacy", "session-v10-legacy", "run_completed", 1, 1,
        "legacy-completed", 1, "{\"output_summary\":\"done\"}", "[]", now
      );
  } finally {
    legacy.close();
  }
}
