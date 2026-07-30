import Database from "better-sqlite3";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import type { WorkspaceBackupManifest, WorkspaceBackupManifestV1, WorkspaceBackupManifestV2 } from "../workspace-store-contracts";
import { WorkspaceDatabase } from "../kernel/workspace-database";
import { isWorkspaceResourceBoundary, type WorkspaceResourceBoundary } from "../kernel/workspace-paths";
import { normalizeBackupId } from "./backup-id";
import { assertSafeBundleRelativePath, hashFileSha256, resolveBundlePath, scanSafeTree } from "./workspace-bundle-files";

export const workspaceBundleFormatVersion = 2;
export const workspaceBundleManifestFile = "manifest.json";
export const workspaceBundleDatabaseFile = "workspace.sqlite";
export const workspaceBundleFilesDirectory = "files";

export interface WorkspaceBundleValidationOptions {
  allowedRoots: readonly string[];
  resourceBoundaries: readonly WorkspaceResourceBoundary[];
  latestSchemaVersion: number;
}

export interface VerifiedWorkspaceBundle {
  root_dir: string;
  manifest: WorkspaceBackupManifest;
  manifest_text: string;
  format_version: 1 | 2;
  schema_version: number;
  file_roots: string[];
  file_hashes: Record<string, string>;
}

/** Reads the manifest with duplicate-key rejection before normal JSON parsing. */
export async function readWorkspaceBundleManifest(
  bundleRoot: string,
  resourceBoundaries: readonly WorkspaceResourceBoundary[]
): Promise<{ manifest: WorkspaceBackupManifest; text: string }> {
  const manifestPath = path.join(bundleRoot, workspaceBundleManifestFile);
  const text = await readFile(manifestPath, "utf8");
  return { manifest: parseWorkspaceBundleManifest(text, resourceBoundaries), text };
}

/** Validates structure, types, path containment, exact file set, hashes, and SQLite integrity. */
export async function verifyWorkspaceBundle(
  bundleRoot: string,
  options: WorkspaceBundleValidationOptions
): Promise<VerifiedWorkspaceBundle> {
  const { manifest, text } = await readWorkspaceBundleManifest(bundleRoot, options.resourceBoundaries);
  const formatVersion = isV2Manifest(manifest) ? 2 : 1;
  const roots = validateManifestRoots(manifest, options.allowedRoots, formatVersion);
  const hashes = validateManifestHashes(manifest.file_hashes, options.allowedRoots, roots);
  const tree = await scanSafeTree(bundleRoot, "workspace_bundle_file_type_invalid");
  const actualFiles = tree.files.map((entry) => entry.path).sort();
  const expectedFiles = [workspaceBundleManifestFile, ...Object.keys(hashes)].sort();
  if (!sameStrings(actualFiles, expectedFiles)) throw new Error("workspace_bundle_file_set_mismatch");
  validateBundleDirectories(tree.directories.map((entry) => entry.path), roots, options.allowedRoots, formatVersion);

  for (const [relativePath, expectedHash] of Object.entries(hashes).sort(([left], [right]) => left.localeCompare(right))) {
    const actualHash = await hashFileSha256(resolveBundlePath(bundleRoot, relativePath));
    if (actualHash !== expectedHash) throw new Error(`workspace_bundle_hash_mismatch:${relativePath}`);
  }

  const databasePath = resolveBundlePath(bundleRoot, workspaceBundleDatabaseFile);
  try {
    const integrity = WorkspaceDatabase.verifyIntegrity(databasePath);
    if (integrity !== "ok") throw new Error(`workspace_bundle_integrity_failed:${integrity}`);
    if (formatVersion === 2 && !manifest.integrity_ok) throw new Error("workspace_bundle_manifest_integrity_not_ok");

    const schemaVersion = readSchemaVersion(databasePath);
    if (schemaVersion > options.latestSchemaVersion) {
      throw new Error(`workspace_bundle_schema_too_new:${schemaVersion}:${options.latestSchemaVersion}`);
    }
    if (isV2Manifest(manifest) && manifest.schema_version !== schemaVersion) {
      throw new Error(`workspace_bundle_schema_version_mismatch:${manifest.schema_version}:${schemaVersion}`);
    }

    return {
      root_dir: bundleRoot,
      manifest,
      manifest_text: text,
      format_version: formatVersion,
      schema_version: schemaVersion,
      file_roots: roots,
      file_hashes: hashes
    };
  } finally {
    // SQLite may create empty shared-memory sidecars even for a readonly check.
    // They are verification byproducts, never Bundle payload.
    await Promise.all([
      rm(`${databasePath}-wal`, { force: true }).catch(() => undefined),
      rm(`${databasePath}-shm`, { force: true }).catch(() => undefined)
    ]);
  }
}

export function parseWorkspaceBundleManifest(
  text: string,
  resourceBoundaries: readonly WorkspaceResourceBoundary[]
): WorkspaceBackupManifest {
  const value = parseJsonWithoutDuplicateObjectKeys(text);
  if (!isRecord(value)) throw new Error("workspace_backup_manifest_invalid");
  const format = value.format_version;
  if (typeof format === "number" && format > workspaceBundleFormatVersion) {
    throw new Error(`workspace_backup_manifest_format_unsupported:${format}`);
  }
  if (format === workspaceBundleFormatVersion) return parseV2Manifest(value, resourceBoundaries);
  if (format === undefined || format === 1) return parseV1Manifest(value, resourceBoundaries);
  throw new Error("workspace_backup_manifest_invalid");
}

export function isV2Manifest(manifest: WorkspaceBackupManifest): manifest is WorkspaceBackupManifestV2 {
  return "format_version" in manifest && manifest.format_version === workspaceBundleFormatVersion;
}

function parseV1Manifest(value: Record<string, unknown>, fallbackBoundaries: readonly WorkspaceResourceBoundary[]): WorkspaceBackupManifestV1 {
  assertCommonManifestFields(value);
  return {
    id: normalizeBackupId(value.id as string),
    created_at: value.created_at as string,
    source_root: value.source_root as string,
    db_file: workspaceBundleDatabaseFile,
    file_roots: stringArray(value.file_roots, "workspace_backup_manifest_invalid"),
    resource_boundaries: parseBoundaries(value.resource_boundaries, fallbackBoundaries),
    health_ok: value.health_ok as boolean,
    integrity_ok: typeof value.integrity_ok === "boolean" ? value.integrity_ok : Boolean(value.health_ok),
    file_hashes: hashRecord(value.file_hashes)
  };
}

function parseV2Manifest(value: Record<string, unknown>, fallbackBoundaries: readonly WorkspaceResourceBoundary[]): WorkspaceBackupManifestV2 {
  assertCommonManifestFields(value);
  if (value.source_root !== "." || !Number.isInteger(value.schema_version) || (value.schema_version as number) < 0) {
    throw new Error("workspace_backup_manifest_invalid");
  }
  return {
    format_version: workspaceBundleFormatVersion,
    schema_version: value.schema_version as number,
    id: normalizeBackupId(value.id as string),
    created_at: value.created_at as string,
    source_root: ".",
    db_file: workspaceBundleDatabaseFile,
    file_roots: stringArray(value.file_roots, "workspace_backup_manifest_invalid"),
    resource_boundaries: parseBoundaries(value.resource_boundaries, fallbackBoundaries),
    health_ok: value.health_ok as boolean,
    integrity_ok: value.integrity_ok as boolean,
    file_hashes: hashRecord(value.file_hashes)
  };
}

function assertCommonManifestFields(value: Record<string, unknown>): void {
  if (
    typeof value.id !== "string"
    || typeof value.created_at !== "string"
    || !Number.isFinite(Date.parse(value.created_at))
    || typeof value.source_root !== "string"
    || value.db_file !== workspaceBundleDatabaseFile
    || !Array.isArray(value.file_roots)
    || typeof value.health_ok !== "boolean"
    || typeof value.integrity_ok !== "boolean"
    || !isRecord(value.file_hashes)
  ) {
    throw new Error("workspace_backup_manifest_invalid");
  }
}

function parseBoundaries(value: unknown, fallback: readonly WorkspaceResourceBoundary[]): WorkspaceResourceBoundary[] {
  if (value === undefined) return fallback.map(copyBoundary);
  if (!Array.isArray(value) || !value.every(isWorkspaceResourceBoundary)) throw new Error("workspace_backup_manifest_invalid");
  return value.map(copyBoundary);
}

function copyBoundary(value: WorkspaceResourceBoundary): WorkspaceResourceBoundary {
  return { ...value, file_roots: [...value.file_roots], sqlite_tables: [...value.sqlite_tables] };
}

function stringArray(value: unknown, errorCode: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) throw new Error(errorCode);
  return [...value] as string[];
}

function hashRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) throw new Error("workspace_backup_manifest_invalid");
  const entries = Object.entries(value);
  if (!entries.every(([key, hash]) => typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash) && key.length > 0)) {
    throw new Error("workspace_backup_manifest_invalid");
  }
  return Object.fromEntries(entries as Array<[string, string]>);
}

function validateManifestRoots(manifest: WorkspaceBackupManifest, allowedRoots: readonly string[], formatVersion: 1 | 2): string[] {
  const roots = manifest.file_roots.map((root) => assertSafeBundleRelativePath(root, "workspace_bundle_root_invalid"));
  if (new Set(roots).size !== roots.length || roots.some((root) => !allowedRoots.includes(root))) {
    throw new Error("workspace_bundle_root_invalid");
  }
  if (formatVersion === 2 && !sameStrings(roots, [...allowedRoots])) {
    throw new Error("workspace_bundle_root_set_invalid");
  }
  return roots;
}

function validateManifestHashes(
  hashes: Record<string, string>,
  allowedRoots: readonly string[],
  manifestRoots: readonly string[]
): Record<string, string> {
  if (!Object.prototype.hasOwnProperty.call(hashes, workspaceBundleDatabaseFile)) {
    throw new Error("workspace_bundle_database_hash_missing");
  }
  for (const key of Object.keys(hashes)) {
    if (key === workspaceBundleDatabaseFile) continue;
    assertSafeBundleRelativePath(key, "workspace_bundle_hash_path_invalid");
    if (!key.startsWith(`${workspaceBundleFilesDirectory}/`)) throw new Error(`workspace_bundle_hash_path_invalid:${key}`);
    const rest = key.slice(`${workspaceBundleFilesDirectory}/`.length);
    const [root, ...nested] = rest.split("/");
    if (!root || nested.length === 0 || !allowedRoots.includes(root) || !manifestRoots.includes(root)) {
      throw new Error("workspace_bundle_hash_path_invalid");
    }
  }
  return Object.fromEntries(Object.entries(hashes).sort(([left], [right]) => left.localeCompare(right)));
}

function validateBundleDirectories(
  directories: readonly string[],
  roots: readonly string[],
  allowedRoots: readonly string[],
  formatVersion: 1 | 2
): void {
  if (!directories.includes(workspaceBundleFilesDirectory)) throw new Error("workspace_bundle_files_directory_missing");
  for (const directory of directories) {
    assertSafeBundleRelativePath(directory, "workspace_bundle_path_invalid");
    if (directory === workspaceBundleFilesDirectory) continue;
    if (!directory.startsWith(`${workspaceBundleFilesDirectory}/`)) throw new Error("workspace_bundle_extra_path");
    const [root] = directory.slice(`${workspaceBundleFilesDirectory}/`.length).split("/");
    if (!root || !allowedRoots.includes(root) || !roots.includes(root)) throw new Error("workspace_bundle_extra_path");
  }
  if (formatVersion === 2) {
    for (const root of allowedRoots) {
      if (!directories.includes(`${workspaceBundleFilesDirectory}/${root}`)) throw new Error(`workspace_bundle_root_missing:${root}`);
    }
  }
}

function readSchemaVersion(databasePath: string): number {
  const database = new Database(databasePath, { readonly: true });
  try {
    const row = database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version?: number | null } | undefined;
    return Number(row?.version ?? 0);
  } catch (error) {
    if (isMissingSchemaMigrations(error)) return 0;
    throw new Error(`workspace_bundle_schema_read_failed:${errorMessage(error)}`);
  } finally {
    database.close();
  }
}

function isMissingSchemaMigrations(error: unknown): boolean {
  return error instanceof Error && /no such table: schema_migrations/i.test(error.message);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** JSON.parse permits duplicate keys; manifests deliberately do not. */
function parseJsonWithoutDuplicateObjectKeys(text: string): unknown {
  let offset = 0;

  const whitespace = () => {
    while (/\s/.test(text[offset] ?? "")) offset += 1;
  };
  const string = (): string => {
    if (text[offset] !== '"') throw new Error("workspace_backup_manifest_invalid");
    const start = offset;
    offset += 1;
    while (offset < text.length) {
      const character = text[offset];
      if (character === "\\") {
        offset += 2;
        continue;
      }
      if (character === '"') {
        offset += 1;
        try {
          return JSON.parse(text.slice(start, offset)) as string;
        } catch {
          throw new Error("workspace_backup_manifest_invalid");
        }
      }
      if (!character || character.charCodeAt(0) < 0x20) throw new Error("workspace_backup_manifest_invalid");
      offset += 1;
    }
    throw new Error("workspace_backup_manifest_invalid");
  };
  const value = (): void => {
    whitespace();
    const character = text[offset];
    if (character === "{") {
      offset += 1;
      whitespace();
      const keys = new Set<string>();
      if (text[offset] === "}") {
        offset += 1;
        return;
      }
      while (true) {
        whitespace();
        const key = string();
        if (keys.has(key)) throw new Error("workspace_backup_manifest_duplicate_key");
        keys.add(key);
        whitespace();
        if (text[offset] !== ":") throw new Error("workspace_backup_manifest_invalid");
        offset += 1;
        value();
        whitespace();
        if (text[offset] === "}") {
          offset += 1;
          return;
        }
        if (text[offset] !== ",") throw new Error("workspace_backup_manifest_invalid");
        offset += 1;
      }
    }
    if (character === "[") {
      offset += 1;
      whitespace();
      if (text[offset] === "]") {
        offset += 1;
        return;
      }
      while (true) {
        value();
        whitespace();
        if (text[offset] === "]") {
          offset += 1;
          return;
        }
        if (text[offset] !== ",") throw new Error("workspace_backup_manifest_invalid");
        offset += 1;
      }
    }
    if (character === '"') {
      string();
      return;
    }
    const start = offset;
    while (offset < text.length && !/[\s,}\]]/.test(text[offset] ?? "")) offset += 1;
    if (start === offset) throw new Error("workspace_backup_manifest_invalid");
    try {
      JSON.parse(text.slice(start, offset));
    } catch {
      throw new Error("workspace_backup_manifest_invalid");
    }
  };

  try {
    value();
    whitespace();
    if (offset !== text.length) throw new Error("workspace_backup_manifest_invalid");
    return JSON.parse(text) as unknown;
  } catch (error) {
    if (error instanceof Error && error.message === "workspace_backup_manifest_duplicate_key") throw error;
    throw new Error("workspace_backup_manifest_invalid");
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
