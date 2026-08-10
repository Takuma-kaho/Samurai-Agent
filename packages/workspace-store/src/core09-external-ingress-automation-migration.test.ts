import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { afterEach, describe, expect, it } from "vitest";
import { localOwnerParticipantId } from "@samurai-agent/room-permissions";
import { WorkspaceMigrationRunner } from "./kernel/migration-runner.js";
import type { WorkspaceDb } from "./kernel/workspace-db-schema.js";
import { workspaceMigrations } from "./migrations/index.js";
import { WorkspaceStore } from "./workspace-store.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Core09 external ingress and Automation migration", () => {
  it("keeps v14 jobs unbound and excludes them from automatic scheduling", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-core09-v14-"));
    roots.push(root);
    const dbPath = path.join(root, "workspace.sqlite");
    const now = "2026-08-10T00:00:00.000Z";
    await createVersion14Fixture(dbPath, now);
    const legacyBackupId = await createVersion14Backup(root, dbPath, now);

    const store = await WorkspaceStore.create({ rootDir: root });
    const legacyJob = await store.getAutomationJob("job-v14-legacy");
    const due = await store.listAutomationJobs({ dueAt: "2026-08-11T00:00:00.000Z", enabledOnly: true });
    const legacyRun = await store.getAutomationRun("run-v14-legacy");
    const restored = await store.restoreWorkspaceBackup(legacyBackupId);
    const restoredLegacyJob = await store.getAutomationJob("job-v14-legacy");
    const migrations = await store.listSchemaMigrations();
    await store.close();

    const check = new Database(dbPath, { readonly: true });
    try {
      expect(check.pragma("foreign_key_check")).toEqual([]);
      const row = check.prepare(`SELECT workspace_id, room_id, authority_kind, authority_ref_json, connection_id, authorization_state
        FROM automation_jobs WHERE id = ?`).get("job-v14-legacy") as Record<string, unknown>;
      expect(row).toEqual({
        workspace_id: null,
        room_id: null,
        authority_kind: null,
        authority_ref_json: null,
        connection_id: null,
        authorization_state: "rebind_required"
      });
    } finally {
      check.close();
    }

    expect(legacyJob).toMatchObject({ id: "job-v14-legacy", authorization_state: "rebind_required" });
    expect(legacyJob?.room_id).toBeUndefined();
    expect(legacyJob?.authority).toBeUndefined();
    expect(due).toEqual([]);
    expect(legacyRun).toMatchObject({ id: "run-v14-legacy", session_id: "session-v14-legacy" });
    expect(restored.integrity.ok).toBe(true);
    expect(restored.backup_id).toBe(legacyBackupId);
    expect(restoredLegacyJob).toMatchObject({ authorization_state: "rebind_required" });
    expect(restoredLegacyJob?.room_id).toBeUndefined();
    expect(restoredLegacyJob?.authority).toBeUndefined();
    expect(migrations).toContainEqual(expect.objectContaining({ version: 15, name: "core09_external_ingress_automation_boundary" }));
    expect(migrations).toContainEqual(expect.objectContaining({ version: 16, name: "core09_automation_manager_locks" }));
  });

  it("round-trips only secret-free Connection and Automation provenance", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-core09-backup-"));
    roots.push(root);
    const store = await WorkspaceStore.create({ rootDir: root });
    const now = "2026-08-10T00:00:00.000Z";
    const roomId = (await store.getSettings()).default_room_id!;

    await expect(store.saveExternalAppConnection({
      id: "connection-secret", workspace_id: "workspace", connector_id: "connector-secret", app_id: "app-secret", status: "active",
      delegated_principal: { kind: "human", participant_id: localOwnerParticipantId }, allowed_room_ids: [roomId], ingress_classes: ["query"],
      non_secret_metadata: { api_token: "must-not-persist" }, created_by: { kind: "human", participant_id: localOwnerParticipantId }, created_at: now, updated_at: now
    })).rejects.toThrow();
    await expect(store.saveExternalAppConnection({
      id: "connection-wildcard", workspace_id: "workspace", connector_id: "connector-wildcard", app_id: "app-wildcard", status: "active",
      delegated_principal: { kind: "human", participant_id: localOwnerParticipantId }, allowed_room_ids: ["*"], ingress_classes: ["query"],
      non_secret_metadata: {}, created_by: { kind: "human", participant_id: localOwnerParticipantId }, created_at: now, updated_at: now
    })).rejects.toThrow("wildcard_connection_room_scope_forbidden");

    const connection = await store.saveExternalAppConnection({
      id: "connection-core09", workspace_id: "workspace", connector_id: "connector-core09", app_id: "app-core09", status: "active",
      delegated_principal: { kind: "human", participant_id: localOwnerParticipantId }, allowed_room_ids: [roomId], ingress_classes: ["query", "domain_operation", "activity_ingest"],
      non_secret_metadata: { label: "fixture", environment: "development" }, created_by: { kind: "human", participant_id: localOwnerParticipantId }, created_at: now, updated_at: now
    });
    const job = await store.saveAutomationJob({
      id: "job-core09", title: "Core09 reindex", kind: "wiki_reindex", status: "enabled", schedule: "daily", target_instruction: "Reindex", delivery_target: { channel: "activity" },
      workspace_id: "workspace", room_id: roomId, authority: { kind: "direct_principal", principal: { kind: "human", participant_id: localOwnerParticipantId } },
      created_principal_snapshot: { kind: "human", participant_id: localOwnerParticipantId }, source_snapshot: { kind: "host" }, authorization_state: "ready", authorized_at: now,
      next_run_at: now, failure_count: 0, max_attempts: 3, created_at: now, updated_at: now
    });
    await expect(store.saveAutomationJob({
      ...job, id: "job-core09-invalid-connection", connection_id: connection.id
    })).rejects.toThrow("automation_direct_authority_connection_forbidden");
    await expect(store.createAutomationRun({
      id: "run-core09-invalid-session", kind: "wiki_reindex", source: "automation_job", status: "started", job_id: job.id,
      workspace_id: "workspace", room_id: roomId, authority: job.authority, session_id: "legacy-session-must-not-be-reused", started_at: now
    })).rejects.toThrow("automation_core09_run_session_forbidden");
    const run = await store.createAutomationRun({
      id: "run-core09", kind: "wiki_reindex", source: "automation_job", status: "blocked", job_id: job.id, workspace_id: "workspace", room_id: roomId,
      authority: job.authority, error_code: "automation_room_permission_denied", started_at: now, completed_at: now, blocked_at: now
    });
    const exportRoot = await mkdtemp(path.join(tmpdir(), "samurai-core09-export-"));
    const restoredRoot = await mkdtemp(path.join(tmpdir(), "samurai-core09-restored-"));
    roots.push(exportRoot, restoredRoot);
    const exported = await store.exportWorkspaceBundle(exportRoot);
    const restoredStore = await WorkspaceStore.create({ rootDir: restoredRoot });
    const restored = await restoredStore.importWorkspaceBundle(exported.path);
    const afterConnection = await restoredStore.getExternalAppConnection(connection.id);
    const afterJob = await restoredStore.getAutomationJob(job.id);
    const afterRun = await restoredStore.getAutomationRun(run.id);
    await restoredStore.close();
    await store.close();

    expect(restored.integrity.ok).toBe(true);
    expect(afterConnection).toMatchObject({ connector_id: "connector-core09", non_secret_metadata: { label: "fixture", environment: "development" } });
    expect(afterJob).toMatchObject({ room_id: roomId, authorization_state: "ready" });
    expect(afterRun).toMatchObject({ job_id: job.id, room_id: roomId, status: "blocked" });
    expect(afterRun?.session_id).toBeUndefined();
    expect(afterRun?.session_ref).toBeUndefined();
  });
});

async function createVersion14Fixture(dbPath: string, now: string): Promise<void> {
  const database = new Database(dbPath);
  database.pragma("foreign_keys = ON");
  const db = new Kysely<WorkspaceDb>({ dialect: new SqliteDialect({ database }) });
  try {
    await new WorkspaceMigrationRunner(db, workspaceMigrations.filter((migration) => migration.version <= 14)).migrate();
  } finally {
    await db.destroy();
  }

  const legacy = new Database(dbPath);
  try {
    legacy.prepare(`INSERT INTO automation_jobs(
      id, title, kind, status, schedule, target_instruction, delivery_target_json,
      next_run_at, failure_count, max_attempts, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      "job-v14-legacy", "Legacy job", "daily_digest", "enabled", "daily", "Legacy instruction",
      JSON.stringify({ channel: "chat", room_id: "must-not-be-inferred", session_id: "session-v14-legacy" }), now, 0, 3, now, now
    );
    legacy.prepare(`INSERT INTO automation_runs(
      id, kind, source, session_id, status, started_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      "run-v14-legacy", "daily_digest", "automation_job", "session-v14-legacy", "completed", now, now
    );
  } finally {
    legacy.close();
  }
}

/** A v1 Bundle with a schema-014 database proves restore-stage migration. */
async function createVersion14Backup(root: string, dbPath: string, createdAt: string): Promise<string> {
  const id = "backup_core09_legacy_014";
  const bundle = path.join(root, "backups", id);
  await mkdir(path.join(bundle, "files"), { recursive: true });
  await copyFile(dbPath, path.join(bundle, "workspace.sqlite"));
  const database = await readFile(path.join(bundle, "workspace.sqlite"));
  const hash = createHash("sha256").update(database).digest("hex");
  await writeFile(path.join(bundle, "manifest.json"), `${JSON.stringify({
    id,
    created_at: createdAt,
    source_root: "legacy",
    db_file: "workspace.sqlite",
    file_roots: [],
    health_ok: true,
    integrity_ok: true,
    file_hashes: { "workspace.sqlite": hash }
  }, null, 2)}\n`);
  return id;
}
