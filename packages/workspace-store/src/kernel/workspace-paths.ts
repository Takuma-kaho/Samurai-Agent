import path from "node:path";
import { mkdir } from "node:fs/promises";

export interface WorkspaceResourceBoundary {
  resource: string;
  source_of_truth: "filesystem" | "sqlite" | "derived";
  file_roots: string[];
  sqlite_tables: string[];
  sqlite_role: "none" | "index" | "history" | "queue" | "audit" | "metadata";
  note: string;
}

const backupRoots = ["artifacts", "profile", "memory", "skills", "wiki", "rollback", "collections", "surfaces"] as const;

const resourceBoundaries: readonly WorkspaceResourceBoundary[] = [
  { resource: "generated_surfaces", source_of_truth: "filesystem", file_roots: ["surfaces"], sqlite_tables: ["generated_surfaces", "generated_surface_revisions", "surface_interactions"], sqlite_role: "metadata", note: "Versioned Generated Surface bundles live in Workspace files; SQLite tracks revisions, state, and interactions." },
  { resource: "profile", source_of_truth: "filesystem", file_roots: ["profile"], sqlite_tables: ["settings"], sqlite_role: "metadata", note: "Profile and SOUL-style identity files live in the workspace; settings rows hold operational preferences." },
  { resource: "memory", source_of_truth: "filesystem", file_roots: ["memory"], sqlite_tables: ["memory_index"], sqlite_role: "index", note: "Memory markdown is the durable source; SQLite is used for search, state, and retrieval metadata." },
  { resource: "knowledge_wiki", source_of_truth: "filesystem", file_roots: ["wiki/pages"], sqlite_tables: ["wiki_index"], sqlite_role: "index", note: "Knowledge Wiki markdown is the durable source; SQLite is a repairable active/search index." },
  { resource: "skill", source_of_truth: "filesystem", file_roots: ["skills"], sqlite_tables: ["skill_usage"], sqlite_role: "metadata", note: "Skill markdown and support files are the durable source; usage stats are derived operational metadata." },
  { resource: "artifact", source_of_truth: "filesystem", file_roots: ["artifacts"], sqlite_tables: ["artifacts"], sqlite_role: "metadata", note: "Artifact body files are durable output; SQLite stores metadata, session links, and render hints." },
  { resource: "collection", source_of_truth: "filesystem", file_roots: ["collections"], sqlite_tables: ["collection_schemas", "collection_records", "collection_patches"], sqlite_role: "index", note: "Collection schemas, records, and notes live in files; SQLite rows are rebuildable indexes." },
  { resource: "session_run_history", source_of_truth: "sqlite", file_roots: [], sqlite_tables: ["sessions", "messages", "operations", "backend_runs", "backend_events", "tool_runs", "workspace_changes"], sqlite_role: "history", note: "Session and run history are structured append-oriented records used for resume, search, and audit views." },
  { resource: "learning_core", source_of_truth: "derived", file_roots: ["learning-snapshots"], sqlite_tables: ["learning_resource_uses", "learning_evaluations", "background_review_changes", "learning_snapshots", "learning_job_reports", "session_search_fts", "session_search_trigram"], sqlite_role: "history", note: "Learning usage, evaluation, provenance, snapshots, and Session Search are derived or restorable records; Memory and Skill markdown remain the durable source." },
  { resource: "policy_audit_rollback", source_of_truth: "sqlite", file_roots: ["rollback"], sqlite_tables: ["policy_decisions", "audit_records", "rollback_points"], sqlite_role: "audit", note: "Policy/audit records are SQLite history; rollback snapshots may reference filesystem payloads." },
  { resource: "gateway_automation", source_of_truth: "sqlite", file_roots: [], sqlite_tables: ["gateway_pairings", "gateway_pairing_policies", "gateway_routing_policies", "gateway_inbound_messages", "gateway_concurrency_locks", "gateway_sandbox_instances", "gateway_sandbox_workspace_syncs", "automation_jobs", "automation_runs"], sqlite_role: "queue", note: "Gateway and scheduler state are operational queues/control-plane records, not workspace prose." },
  { resource: "client_event_queue", source_of_truth: "sqlite", file_roots: [], sqlite_tables: ["client_events"], sqlite_role: "queue", note: "Client events are queued OS/UI requests for Web, Desktop, or future clients; Runtime and Desktop stay decoupled through this table." },
  { resource: "localized_derivatives", source_of_truth: "derived", file_roots: [], sqlite_tables: ["resource_translations"], sqlite_role: "metadata", note: "Resource translations are derived records tied to source resource hashes and can fall back to original text." }
];

export class WorkspacePaths {
  readonly dbPath: string;

  constructor(readonly rootDir: string) {
    this.dbPath = path.join(rootDir, "workspace.sqlite");
  }

  get requiredDirectories(): readonly string[] {
    return [
      this.rootDir,
      path.join(this.rootDir, "artifacts"),
      path.join(this.rootDir, "profile"),
      path.join(this.rootDir, "memory", "session"),
      path.join(this.rootDir, "memory", "provisional"),
      path.join(this.rootDir, "memory", "topic"),
      path.join(this.rootDir, "memory", "active"),
      path.join(this.rootDir, "memory", "sensitive"),
      path.join(this.rootDir, "memory", "archived"),
      path.join(this.rootDir, "skills", "candidate"),
      path.join(this.rootDir, "skills", "project"),
      path.join(this.rootDir, "skills", "active"),
      path.join(this.rootDir, "skills", "stale"),
      path.join(this.rootDir, "skills", "archived"),
      path.join(this.rootDir, "skills", "pinned"),
      path.join(this.rootDir, "skills", "support"),
      path.join(this.rootDir, "wiki", "pages"),
      path.join(this.rootDir, "rollback"),
      path.join(this.rootDir, "collections"),
      path.join(this.rootDir, "surfaces"),
      path.join(this.rootDir, "backups")
    ];
  }

  get backupRoots(): readonly string[] {
    return backupRoots;
  }

  resourceBoundaries(): WorkspaceResourceBoundary[] {
    return workspaceResourceBoundaries();
  }

  async ensureWorkspaceLayout(): Promise<void> {
    await Promise.all(this.requiredDirectories.map((directory) => mkdir(directory, { recursive: true })));
  }
}

export async function ensureWorkspaceLayout(rootDir: string): Promise<void> {
  await new WorkspacePaths(rootDir).ensureWorkspaceLayout();
}

export function workspaceBackupRoots(): string[] {
  return [...backupRoots];
}

export function workspaceResourceBoundaries(): WorkspaceResourceBoundary[] {
  return resourceBoundaries.map((boundary) => ({ ...boundary, file_roots: [...boundary.file_roots], sqlite_tables: [...boundary.sqlite_tables] }));
}

export function isWorkspaceResourceBoundary(value: unknown): value is WorkspaceResourceBoundary {
  if (!value || typeof value !== "object") return false;
  const boundary = value as Record<string, unknown>;
  return typeof boundary.resource === "string"
    && (boundary.source_of_truth === "filesystem" || boundary.source_of_truth === "sqlite" || boundary.source_of_truth === "derived")
    && Array.isArray(boundary.file_roots) && boundary.file_roots.every((item) => typeof item === "string")
    && Array.isArray(boundary.sqlite_tables) && boundary.sqlite_tables.every((item) => typeof item === "string")
    && (boundary.sqlite_role === "none" || boundary.sqlite_role === "index" || boundary.sqlite_role === "history" || boundary.sqlite_role === "queue" || boundary.sqlite_role === "audit" || boundary.sqlite_role === "metadata")
    && typeof boundary.note === "string";
}
