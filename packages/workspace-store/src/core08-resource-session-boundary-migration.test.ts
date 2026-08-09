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

describe("Core08 resource Session boundary migration", () => {
  it("keeps version-13 Session-linked rows without inventing a Room and restores without Surface files", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-core08-v13-"));
    roots.push(root);
    const dbPath = path.join(root, "workspace.sqlite");
    const now = "2026-08-09T00:00:00.000Z";
    await createVersion13Fixture(dbPath, now);

    const store = await WorkspaceStore.create({ rootDir: root });
    await expect(store.saveWorkspaceChange({
      id: "change-core08-no-cause", room_id: "room-not-written", resource_ref: { kind: "artifact", id: "artifact-no-cause", uri: "artifacts/no-cause" },
      change_type: "artifact_created", summary: "A direct change requires a cause.", created_at: now
    })).rejects.toThrow("workspace_change_cause_required");
    await expect(store.saveWorkspaceChange({
      id: "change-core08-no-room", domain_operation_id: "operation-not-written", resource_ref: { kind: "artifact", id: "artifact-no-room", uri: "artifacts/no-room" },
      change_type: "artifact_created", summary: "A direct change requires a Room.", created_at: now
    })).rejects.toThrow("workspace_change_room_required");
    const backup = await store.createWorkspaceBackup();
    const restored = await store.restoreWorkspaceBackup(backup.id);
    const migrations = await store.listSchemaMigrations();
    await store.close();

    const check = new Database(dbPath, { readonly: true });
    try {
      const changes = check.prepare(`SELECT session_id, room_id, activity_id, domain_operation_id, session_ref_json
        FROM workspace_changes WHERE id = ?`).get("change-v13-legacy") as Record<string, unknown>;
      const surface = check.prepare(`SELECT session_id, session_ref_json, activity_id, domain_operation_id
        FROM generated_surfaces WHERE id = ?`).get("surface-v13-legacy") as Record<string, unknown>;
      const interaction = check.prepare(`SELECT session_id, session_ref_json, activity_id, domain_operation_id
        FROM surface_interactions WHERE id = ?`).get("interaction-v13-legacy") as Record<string, unknown>;
      const surfaceColumns = check.prepare("PRAGMA table_info(generated_surfaces)").all() as Array<{ name: string; notnull: number }>;
      const changeColumns = check.prepare("PRAGMA table_info(workspace_changes)").all() as Array<{ name: string; notnull: number }>;

      expect(check.pragma("foreign_key_check")).toEqual([]);
      expect(changes).toEqual({
        session_id: "session-v13-legacy",
        room_id: null,
        activity_id: null,
        domain_operation_id: null,
        session_ref_json: null
      });
      expect(surface).toEqual({
        session_id: "session-v13-legacy",
        session_ref_json: null,
        activity_id: null,
        domain_operation_id: null
      });
      expect(interaction).toEqual({
        session_id: "session-v13-legacy",
        session_ref_json: null,
        activity_id: null,
        domain_operation_id: null
      });
      expect(surfaceColumns.find((column) => column.name === "session_id")?.notnull).toBe(0);
      expect(changeColumns.find((column) => column.name === "run_id")?.notnull).toBe(0);
    } finally {
      check.close();
    }

    expect(backup.manifest.file_roots).not.toContain("surfaces");
    expect(restored.integrity.ok).toBe(true);
    expect(migrations).toContainEqual(expect.objectContaining({ version: 14, name: "core08_resource_session_boundary" }));
  });

  it("requires a Room for every new Change and rolls back partial mutation evidence", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-core08-evidence-"));
    roots.push(root);
    const store = await WorkspaceStore.create({ rootDir: root });
    const now = "2026-08-09T00:00:00.000Z";
    const room = await store.createRoom({ id: "room-core08-evidence", name: "Evidence", created_at: now, updated_at: now });
    const activity = await store.createActivity({
      id: "activity-core08-evidence",
      workspace_id: "workspace",
      room_id: room.id,
      principal: { kind: "human", participant_id: "human:owner" },
      source: { kind: "host" },
      status: "recording",
      idempotency_key: "activity:core08:evidence",
      instruction_summary: "Save one Artifact.",
      verification: [],
      domain_operation_ids: [],
      provenance: { kind: "trusted_context", source_id: "core08-test", recorded_at: now },
      created_at: now,
      updated_at: now
    });

    await expect(store.saveWorkspaceChange({
      id: "change-core08-run-without-room", run_id: "run-core08-missing-room",
      resource_ref: { kind: "artifact", id: "artifact-core08", uri: "artifacts/core08.md" },
      change_type: "artifact_created", summary: "A Run does not supply a Room by inference.", created_at: now
    })).rejects.toThrow("workspace_change_room_required");
    await expect(store.saveWorkspaceChange({
      id: "change-core08-legacy-write", room_id: room.id, domain_operation_id: "operation-current", legacy_operation_id: "operation-legacy",
      resource_ref: { kind: "artifact", id: "artifact-core08", uri: "artifacts/core08.md" },
      change_type: "artifact_created", summary: "Legacy operations are read-only compatibility data.", created_at: now
    })).rejects.toThrow("workspace_change_legacy_operation_write_forbidden");

    await expect(store.commitResourceMutationEvidence({
      change: {
        id: "change-core08-atomic", room_id: room.id, activity_id: activity.id,
        resource_ref: { kind: "artifact", id: "artifact-core08", uri: "artifacts/core08.md" },
        change_type: "artifact_created", summary: "Write Artifact evidence.", created_at: now
      },
      resourceUsage: {
        id: "usage-core08-atomic", activity_id: activity.id,
        resource_ref: { kind: "artifact", id: "artifact-core08", uri: "artifacts/core08.md" },
        usage_scope: { kind: "room", room_id: room.id }, stage: "modified",
        // Force the second write to fail after the Change insert attempt.
        workspace_change_id: "missing-change", created_at: now
      }
    })).rejects.toThrow("resource_mutation_evidence_failed:resource_usage");

    expect(await store.listWorkspaceChanges()).toEqual([]);
    expect(await store.listResourceUsage({ activityId: activity.id })).toEqual([]);
    expect((await store.getActivity(activity.id))?.status).toBe("recording");
    await store.close();
  });
});

async function createVersion13Fixture(dbPath: string, now: string): Promise<void> {
  const database = new Database(dbPath);
  database.pragma("foreign_keys = ON");
  const db = new Kysely<WorkspaceDb>({ dialect: new SqliteDialect({ database }) });
  try {
    await new WorkspaceMigrationRunner(db, workspaceMigrations.filter((migration) => migration.version <= 13)).migrate();
  } finally {
    await db.destroy();
  }

  const legacy = new Database(dbPath);
  try {
    legacy.pragma("foreign_keys = ON");
    legacy.prepare(`INSERT INTO sessions(id, session_key, title, ui_locale, output_locale, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run("session-v13-legacy", "native:legacy", "Legacy", "ja", "ja", now, now);
    legacy.prepare(`INSERT INTO backend_runs(
      id, session_id, input_message_id, output_message_id, backend_id, backend_kind,
      backend_session_id, status, phase, current_attempt, request_idempotency_key,
      request_hash, started_at, completed_at, input_summary, output_summary,
      error_code, metadata_json, requested_by_participant_id
    ) VALUES (?, ?, ?, NULL, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL)`)
      .run(
        "run-v13-legacy", "session-v13-legacy", "message-v13-input", "mock", "mock",
        "completed", "settled", 1, "legacy-key", "legacy-hash", now, now,
        "Legacy run", "done", "{}"
      );
    legacy.prepare(`INSERT INTO workspace_changes(
      id, run_id, session_id, resource_ref_json, change_type, summary,
      legacy_operation_id, correlation_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?)`)
      .run("change-v13-legacy", "run-v13-legacy", "session-v13-legacy", "{\"kind\":\"artifact\",\"id\":\"artifact-v13\"}", "artifact_created", "Legacy change", now);
    legacy.prepare(`INSERT INTO generated_surfaces(
      id, state, session_id, title, definition_json, content_hash,
      current_revision_id, current_revision, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run("surface-v13-legacy", "active", "session-v13-legacy", "Legacy surface", "{}", "hash", "surface-revision-v13", 1, now, now);
    legacy.prepare(`INSERT INTO generated_surface_revisions(
      id, surface_id, revision, revision_json, bundle_hash, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)`)
      .run("surface-revision-v13", "surface-v13-legacy", 1, "{}", "bundle-hash", now);
    legacy.prepare(`INSERT INTO surface_interactions(
      id, surface_id, revision_id, session_id, kind, interaction_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run("interaction-v13-legacy", "surface-v13-legacy", "surface-revision-v13", "session-v13-legacy", "opened", "{}", now);
  } finally {
    legacy.close();
  }
}
