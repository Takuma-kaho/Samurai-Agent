import type { WorkspaceResourceBoundary } from "./workspace-paths";

/**
 * Static ownership map for Workspace persistence.
 *
 * This is deliberately data, not a plugin registry: every repository and every
 * SQLite table is listed in source so the persistence boundary stays reviewable.
 */
export type WorkspacePersistenceOwner =
  | "workspace_kernel"
  | "session_execution"
  | "client_event_queue"
  | "durable_work"
  | "artifact"
  | "generated_surface"
  | "memory"
  | "knowledge_wiki"
  | "skill"
  | "learning"
  | "collection"
  | "automation"
  | "gateway"
  | "workspace_metadata"
  | "room_agent"
  | "access_history"
  | "activity_history"
  | "workspace_job";

export interface WorkspaceResourceOwner {
  owner: WorkspacePersistenceOwner;
  directories: readonly string[];
  backup_roots: readonly string[];
  sqlite_tables: readonly string[];
}

const owners: readonly WorkspaceResourceOwner[] = [
  {
    owner: "workspace_kernel",
    directories: ["backups"],
    backup_roots: [],
    sqlite_tables: ["schema_migrations", "migration_journal", "workspace_file_transactions", "session_search_fts", "session_search_trigram"]
  },
  {
    owner: "session_execution",
    directories: [],
    backup_roots: [],
    sqlite_tables: ["sessions", "messages", "message_presentations", "operations", "backend_runs", "session_run_reservations", "run_leases", "backend_events", "tool_runs", "workspace_changes"]
  },
  {
    owner: "room_agent",
    directories: [],
    backup_roots: [],
    sqlite_tables: ["rooms", "agents"]
  },
  {
    owner: "client_event_queue",
    directories: [],
    backup_roots: [],
    sqlite_tables: ["client_events"]
  },
  {
    owner: "durable_work",
    directories: [],
    backup_roots: [],
    sqlite_tables: ["domain_command_executions", "objectives", "work_items", "work_dependencies", "run_checkpoints"]
  },
  {
    owner: "artifact",
    directories: ["artifacts"],
    backup_roots: ["artifacts"],
    sqlite_tables: ["artifacts", "artifact_revisions"]
  },
  {
    owner: "generated_surface",
    directories: ["surfaces"],
    // Surface bundles are a regenerable compatibility cache. Keep their
    // directory and rows for legacy reads, but do not make a new backup
    // depend on them.
    backup_roots: [],
    sqlite_tables: ["generated_surfaces", "generated_surface_revisions", "surface_interactions"]
  },
  {
    owner: "memory",
    directories: ["memory/session", "memory/provisional", "memory/topic", "memory/active", "memory/sensitive", "memory/archived"],
    backup_roots: ["memory"],
    sqlite_tables: ["memory_index"]
  },
  {
    owner: "knowledge_wiki",
    directories: ["wiki/pages"],
    backup_roots: ["wiki"],
    sqlite_tables: ["wiki_index"]
  },
  {
    owner: "skill",
    directories: ["skills/candidate", "skills/project", "skills/active", "skills/stale", "skills/archived", "skills/pinned", "skills/support"],
    backup_roots: ["skills"],
    sqlite_tables: ["skill_index", "skill_usage", "skill_optimization_runs", "skill_optimization_datasets", "optimization_candidates", "optimization_evaluations", "optimization_promotions", "skill_optimization_snapshots", "skill_optimization_locks"]
  },
  {
    owner: "learning",
    directories: ["learning-snapshots", "learning-history"],
    backup_roots: ["learning-history"],
    sqlite_tables: ["learning_resource_uses", "learning_evaluations", "learning_resource_versions", "learning_snapshots", "background_review_changes", "learning_job_reports", "curator_state", "reflection_runs", "reflection_suggestions", "external_assist_records"]
  },
  {
    owner: "collection",
    directories: ["collections"],
    backup_roots: ["collections"],
    sqlite_tables: ["collection_schemas", "collection_records", "collection_patches"]
  },
  {
    owner: "automation",
    directories: [],
    backup_roots: [],
    sqlite_tables: ["automation_jobs", "automation_runs"]
  },
  {
    owner: "gateway",
    directories: [],
    backup_roots: [],
    sqlite_tables: ["external_sends", "gateway_pairings", "gateway_pairing_policies", "gateway_routing_policies", "gateway_inbound_messages", "gateway_deliveries", "gateway_boundary_policies", "gateway_mcp_configs", "gateway_concurrency_locks", "gateway_sandbox_instances", "gateway_sandbox_workspace_syncs"]
  },
  {
    owner: "workspace_metadata",
    directories: ["profile"],
    backup_roots: ["profile"],
    sqlite_tables: ["settings", "plugin_states", "resource_translations"]
  },
  {
    owner: "access_history",
    directories: ["rollback"],
    backup_roots: ["rollback"],
    sqlite_tables: ["policy_decisions", "approval_requests", "audit_records", "rollback_points", "grants"]
  },
  {
    owner: "activity_history",
    directories: [],
    backup_roots: [],
    sqlite_tables: ["activity_records", "resource_usage_records"]
  },
  {
    owner: "workspace_job",
    directories: [],
    backup_roots: [],
    sqlite_tables: ["workspace_jobs", "workspace_job_attempts"]
  }
];

const legacyBoundaries: readonly WorkspaceResourceBoundary[] = [
  { resource: "generated_surfaces", source_of_truth: "derived", file_roots: ["surfaces"], sqlite_tables: ["generated_surfaces", "generated_surface_revisions", "surface_interactions"], sqlite_role: "metadata", note: "Generated Surface bundles are regenerable display compatibility data; Artifact and Collection remain the Workspace source of truth." },
  { resource: "profile", source_of_truth: "filesystem", file_roots: ["profile"], sqlite_tables: ["settings", "plugin_states"], sqlite_role: "metadata", note: "Profile and SOUL-style identity files live in the workspace; settings rows hold operational preferences." },
  { resource: "memory", source_of_truth: "filesystem", file_roots: ["memory"], sqlite_tables: ["memory_index"], sqlite_role: "index", note: "Memory markdown is the durable source; SQLite is used for search, state, and retrieval metadata." },
  { resource: "knowledge_wiki", source_of_truth: "filesystem", file_roots: ["wiki/pages"], sqlite_tables: ["wiki_index"], sqlite_role: "index", note: "Knowledge Wiki markdown is the durable source; SQLite is a repairable active/search index." },
  { resource: "skill", source_of_truth: "filesystem", file_roots: ["skills"], sqlite_tables: ["skill_index", "skill_usage", "skill_optimization_runs", "skill_optimization_datasets", "optimization_candidates", "optimization_evaluations", "optimization_promotions", "skill_optimization_snapshots", "skill_optimization_locks"], sqlite_role: "metadata", note: "Skill markdown and support files are the durable source; usage and optimization state are operational metadata." },
  { resource: "artifact", source_of_truth: "filesystem", file_roots: ["artifacts"], sqlite_tables: ["artifacts", "artifact_revisions"], sqlite_role: "metadata", note: "Artifact body files are durable output; SQLite stores metadata, revisions, session links, and render hints." },
  { resource: "collection", source_of_truth: "filesystem", file_roots: ["collections"], sqlite_tables: ["collection_schemas", "collection_records", "collection_patches", "workspace_file_transactions"], sqlite_role: "index", note: "Collection schemas, records, and notes live in files; SQLite rows are rebuildable indexes and change history." },
  { resource: "room_agent", source_of_truth: "sqlite", file_roots: [], sqlite_tables: ["rooms", "agents"], sqlite_role: "metadata", note: "Rooms and stable Agent identities are SQLite records; an Agent retains its role when its selected Backend changes." },
  { resource: "session_run_history", source_of_truth: "sqlite", file_roots: [], sqlite_tables: ["sessions", "messages", "message_presentations", "operations", "backend_runs", "session_run_reservations", "run_leases", "backend_events", "tool_runs", "workspace_changes"], sqlite_role: "history", note: "Session and Room-scoped run history are structured records; Session remains only the Native App compatibility view." },
  { resource: "learning_core", source_of_truth: "derived", file_roots: ["learning-snapshots", "learning-history"], sqlite_tables: ["learning_resource_uses", "learning_evaluations", "learning_resource_versions", "background_review_changes", "learning_snapshots", "learning_job_reports", "curator_state", "reflection_runs", "reflection_suggestions", "external_assist_records", "session_search_fts", "session_search_trigram"], sqlite_role: "history", note: "Learning usage, evaluation, provenance, and immutable past versions are tracked here; current Memory, Knowledge Wiki, and Skill markdown remain the durable source." },
  { resource: "policy_audit_rollback", source_of_truth: "sqlite", file_roots: ["rollback"], sqlite_tables: ["policy_decisions", "approval_requests", "audit_records", "rollback_points", "grants"], sqlite_role: "audit", note: "Access and audit records are SQLite history; rollback snapshots may reference filesystem payloads." },
  { resource: "gateway_automation", source_of_truth: "sqlite", file_roots: [], sqlite_tables: ["automation_jobs", "automation_runs", "external_sends", "gateway_pairings", "gateway_pairing_policies", "gateway_routing_policies", "gateway_inbound_messages", "gateway_deliveries", "gateway_boundary_policies", "gateway_mcp_configs", "gateway_concurrency_locks", "gateway_sandbox_instances", "gateway_sandbox_workspace_syncs"], sqlite_role: "queue", note: "Gateway and scheduler state are operational queues and control-plane records, not workspace prose." },
  { resource: "client_event_queue", source_of_truth: "sqlite", file_roots: [], sqlite_tables: ["client_events"], sqlite_role: "queue", note: "Client events are queued OS/UI requests for Web, Desktop, or future clients; Runtime and Desktop stay decoupled through this table." },
  { resource: "localized_derivatives", source_of_truth: "derived", file_roots: [], sqlite_tables: ["resource_translations"], sqlite_role: "metadata", note: "Resource translations are derived records tied to source resource hashes and can fall back to original text." },
  { resource: "workspace_kernel", source_of_truth: "sqlite", file_roots: ["backups"], sqlite_tables: ["schema_migrations", "migration_journal", "workspace_file_transactions"], sqlite_role: "history", note: "The persistence kernel owns database lifecycle, migration history, backup manifests, and file transaction recovery." },
  { resource: "durable_work", source_of_truth: "sqlite", file_roots: [], sqlite_tables: ["domain_command_executions", "objectives", "work_items", "work_dependencies", "run_checkpoints"], sqlite_role: "queue", note: "Objectives and durable work are SQLite execution state with explicit leases and checkpoints." },
  { resource: "activity_history", source_of_truth: "sqlite", file_roots: [], sqlite_tables: ["activity_records", "resource_usage_records"], sqlite_role: "history", note: "Activity History stores Room-scoped work evidence and Resource-use facts without copying Resource bodies." },
  { resource: "workspace_job", source_of_truth: "sqlite", file_roots: [], sqlite_tables: ["workspace_jobs", "workspace_job_attempts"], sqlite_role: "queue", note: "Workspace Jobs store durable, versioned Activity processing attempts; Core07 processors remain read-only." }
];

export function workspaceResourceOwners(): WorkspaceResourceOwner[] {
  return owners.map((owner) => ({
    ...owner,
    directories: [...owner.directories],
    backup_roots: [...owner.backup_roots],
    sqlite_tables: [...owner.sqlite_tables]
  }));
}

export function workspaceBackupRoots(): string[] {
  // Preserve the Phase 1 manifest order.  New ownership metadata may add
  // tables, but backup root ordering is part of the existing file contract.
  const ownedRoots = new Set(owners.flatMap((owner) => owner.backup_roots));
  return ["artifacts", "profile", "memory", "skills", "wiki", "rollback", "collections"].filter((root) => ownedRoots.has(root));
}

export function workspaceResourceBoundaries(): WorkspaceResourceBoundary[] {
  return legacyBoundaries.map((boundary) => ({
    ...boundary,
    file_roots: [...boundary.file_roots],
    sqlite_tables: [...boundary.sqlite_tables]
  }));
}

export function validateWorkspaceResourceOwnership(tables: readonly string[]): { duplicate: string[]; missing: string[] } {
  const counts = new Map<string, number>();
  for (const owner of owners) {
    for (const table of owner.sqlite_tables) counts.set(table, (counts.get(table) ?? 0) + 1);
  }
  return {
    duplicate: [...counts].filter(([, count]) => count !== 1).map(([table]) => table).sort(),
    missing: tables.filter((table) => !counts.has(table)).sort()
  };
}
