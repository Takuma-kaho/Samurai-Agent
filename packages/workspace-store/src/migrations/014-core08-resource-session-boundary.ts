import type { WorkspaceMigration } from "../kernel/migration-runner";

/**
 * Core08 keeps every existing row byte-for-byte and does not infer a Room for
 * legacy Session-bound data. New direct mutations carry Room/Activity/Operation
 * evidence while Session remains optional provenance.
 */
export const core08ResourceSessionBoundaryMigration: WorkspaceMigration = {
  version: 14,
  name: "core08_resource_session_boundary",
  steps: [
    {
      kind: "sql",
      statement: `CREATE TABLE workspace_changes_v14 (
        id TEXT PRIMARY KEY,
        run_id TEXT REFERENCES backend_runs(id) ON DELETE RESTRICT,
        session_id TEXT REFERENCES sessions(id) ON DELETE RESTRICT,
        room_id TEXT REFERENCES rooms(id) ON DELETE RESTRICT,
        activity_id TEXT REFERENCES activity_records(id) ON DELETE RESTRICT,
        domain_operation_id TEXT REFERENCES operations(id) ON DELETE RESTRICT,
        session_ref_json TEXT,
        resource_ref_json TEXT NOT NULL,
        change_type TEXT NOT NULL,
        summary TEXT NOT NULL,
        legacy_operation_id TEXT,
        correlation_id TEXT,
        created_at TEXT NOT NULL,
        CHECK(run_id IS NOT NULL OR activity_id IS NOT NULL OR domain_operation_id IS NOT NULL OR legacy_operation_id IS NOT NULL)
      )`
    },
    {
      kind: "sql",
      statement: `INSERT INTO workspace_changes_v14(
        id, run_id, session_id, room_id, activity_id, domain_operation_id,
        session_ref_json, resource_ref_json, change_type, summary,
        legacy_operation_id, correlation_id, created_at
      ) SELECT id, run_id, session_id, NULL, NULL, NULL, NULL,
        resource_ref_json, change_type, summary, legacy_operation_id,
        correlation_id, created_at FROM workspace_changes`
    },
    { kind: "sql", statement: "DROP TABLE workspace_changes" },
    { kind: "sql", statement: "ALTER TABLE workspace_changes_v14 RENAME TO workspace_changes" },
    { kind: "sql", statement: "CREATE INDEX idx_workspace_changes_room_created ON workspace_changes(room_id, created_at DESC) WHERE room_id IS NOT NULL" },
    { kind: "sql", statement: "CREATE INDEX idx_workspace_changes_activity ON workspace_changes(activity_id, created_at DESC) WHERE activity_id IS NOT NULL" },
    { kind: "sql", statement: "CREATE INDEX idx_workspace_changes_operation ON workspace_changes(domain_operation_id, created_at DESC) WHERE domain_operation_id IS NOT NULL" },
    {
      kind: "sql",
      statement: `CREATE TABLE generated_surfaces_v14 (
        id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        session_id TEXT REFERENCES sessions(id) ON DELETE RESTRICT,
        session_ref_json TEXT,
        activity_id TEXT REFERENCES activity_records(id) ON DELETE RESTRICT,
        domain_operation_id TEXT REFERENCES operations(id) ON DELETE RESTRICT,
        title TEXT NOT NULL,
        definition_json TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        current_revision_id TEXT NOT NULL,
        current_revision INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`
    },
    {
      kind: "sql",
      statement: `INSERT INTO generated_surfaces_v14(
        id, state, session_id, session_ref_json, activity_id, domain_operation_id,
        title, definition_json, content_hash, current_revision_id, current_revision,
        created_at, updated_at
      ) SELECT id, state, session_id, NULL, NULL, NULL, title, definition_json,
        content_hash, current_revision_id, current_revision, created_at, updated_at
        FROM generated_surfaces`
    },
    {
      kind: "sql",
      statement: `CREATE TABLE generated_surface_revisions_v14 (
        id TEXT PRIMARY KEY,
        surface_id TEXT NOT NULL REFERENCES generated_surfaces_v14(id) ON DELETE RESTRICT,
        revision INTEGER NOT NULL,
        activity_id TEXT REFERENCES activity_records(id) ON DELETE RESTRICT,
        domain_operation_id TEXT REFERENCES operations(id) ON DELETE RESTRICT,
        revision_json TEXT NOT NULL,
        bundle_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(surface_id, revision)
      )`
    },
    {
      kind: "sql",
      statement: `INSERT INTO generated_surface_revisions_v14(
        id, surface_id, revision, activity_id, domain_operation_id, revision_json,
        bundle_hash, created_at
      ) SELECT id, surface_id, revision, NULL, NULL, revision_json, bundle_hash,
        created_at FROM generated_surface_revisions`
    },
    {
      kind: "sql",
      statement: `CREATE TABLE surface_interactions_v14 (
        id TEXT PRIMARY KEY,
        surface_id TEXT NOT NULL REFERENCES generated_surfaces_v14(id) ON DELETE RESTRICT,
        revision_id TEXT NOT NULL REFERENCES generated_surface_revisions_v14(id) ON DELETE RESTRICT,
        session_id TEXT REFERENCES sessions(id) ON DELETE RESTRICT,
        session_ref_json TEXT,
        activity_id TEXT REFERENCES activity_records(id) ON DELETE RESTRICT,
        domain_operation_id TEXT REFERENCES operations(id) ON DELETE RESTRICT,
        kind TEXT NOT NULL,
        interaction_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`
    },
    {
      kind: "sql",
      statement: `INSERT INTO surface_interactions_v14(
        id, surface_id, revision_id, session_id, session_ref_json, activity_id,
        domain_operation_id, kind, interaction_json, created_at
      ) SELECT id, surface_id, revision_id, session_id, NULL, NULL, NULL, kind,
        interaction_json, created_at FROM surface_interactions`
    },
    { kind: "sql", statement: "DROP TABLE surface_interactions" },
    { kind: "sql", statement: "DROP TABLE generated_surface_revisions" },
    { kind: "sql", statement: "DROP TABLE generated_surfaces" },
    { kind: "sql", statement: "ALTER TABLE generated_surfaces_v14 RENAME TO generated_surfaces" },
    { kind: "sql", statement: "ALTER TABLE generated_surface_revisions_v14 RENAME TO generated_surface_revisions" },
    { kind: "sql", statement: "ALTER TABLE surface_interactions_v14 RENAME TO surface_interactions" },
    { kind: "sql", statement: "CREATE INDEX idx_generated_surfaces_session ON generated_surfaces(session_id) WHERE session_id IS NOT NULL" },
    { kind: "sql", statement: "CREATE INDEX idx_generated_surfaces_activity ON generated_surfaces(activity_id) WHERE activity_id IS NOT NULL" },
    { kind: "sql", statement: "CREATE INDEX idx_generated_surface_revisions_activity ON generated_surface_revisions(activity_id) WHERE activity_id IS NOT NULL" },
    { kind: "sql", statement: "CREATE INDEX idx_surface_interactions_surface ON surface_interactions(surface_id, created_at)" }
  ]
};
