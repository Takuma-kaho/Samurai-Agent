import path from "node:path";
import { mkdir } from "node:fs/promises";
import {
  workspaceBackupRoots as catalogWorkspaceBackupRoots,
  workspaceResourceBoundaries as catalogWorkspaceResourceBoundaries,
  workspaceResourceOwners
} from "./workspace-resource-catalog";

export interface WorkspaceResourceBoundary {
  resource: string;
  source_of_truth: "filesystem" | "sqlite" | "derived";
  file_roots: string[];
  sqlite_tables: string[];
  sqlite_role: "none" | "index" | "history" | "queue" | "audit" | "metadata";
  note: string;
}

export class WorkspacePaths {
  readonly dbPath: string;

  constructor(readonly rootDir: string) {
    this.dbPath = path.join(rootDir, "workspace.sqlite");
  }

  get requiredDirectories(): readonly string[] {
    return [
      this.rootDir,
      ...workspaceResourceOwners().flatMap((owner) => owner.directories.map((directory) => path.join(this.rootDir, directory)))
    ];
  }

  get backupRoots(): readonly string[] {
    return catalogWorkspaceBackupRoots();
  }

  /**
   * Restore clears the legacy Surface cache so a restored SQLite row cannot
   * point at a stale bundle. This is intentionally broader than a new backup.
   */
  get restoreRoots(): readonly string[] {
    return [...this.backupRoots, "surfaces"];
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
  return catalogWorkspaceBackupRoots();
}

export function workspaceRestoreRoots(): string[] {
  return [...catalogWorkspaceBackupRoots(), "surfaces"];
}

export function workspaceResourceBoundaries(): WorkspaceResourceBoundary[] {
  return catalogWorkspaceResourceBoundaries();
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
