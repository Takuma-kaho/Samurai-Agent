import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";

export interface SafeTreeEntry {
  path: string;
  kind: "directory" | "file";
  size: number;
  mode: number;
  mtime_ms: number;
  ctime_ms: number;
}

export interface SafeTree {
  directories: SafeTreeEntry[];
  files: SafeTreeEntry[];
}

/** Bundle paths are portable POSIX paths, never host paths. */
export function assertSafeBundleRelativePath(value: string, code = "workspace_bundle_path_invalid"): string {
  if (!value || value.includes("\\") || value.includes("\0") || path.posix.isAbsolute(value)) {
    throw new Error(code);
  }
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..") || path.posix.normalize(value) !== value) {
    throw new Error(code);
  }
  return value;
}

export function resolveBundlePath(rootDir: string, relativePath: string): string {
  const safePath = assertSafeBundleRelativePath(relativePath);
  const resolved = path.resolve(rootDir, ...safePath.split("/"));
  const relative = path.relative(path.resolve(rootDir), resolved);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("workspace_bundle_path_escape");
  }
  return resolved;
}

export function isPathWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export async function hashFileSha256(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

/** Copies without loading a bundle file into memory. */
export async function copyFileStreaming(source: string, destination: string): Promise<void> {
  await mkdir(path.dirname(destination), { recursive: true });
  await pipeline(createReadStream(source), createWriteStream(destination, { flags: "wx" }));
}

/**
 * Enumerates only normal directories and files. Symlinks, sockets, devices,
 * FIFOs, and other special files are intentionally rejected at this boundary.
 */
export async function scanSafeTree(rootDir: string, errorCode = "workspace_bundle_file_type_invalid"): Promise<SafeTree> {
  const directories: SafeTreeEntry[] = [];
  const files: SafeTreeEntry[] = [];

  const visit = async (absolutePath: string, relativePath: string): Promise<void> => {
    const entry = await lstat(absolutePath);
    if (entry.isDirectory()) {
      if (relativePath) directories.push(treeEntry(relativePath, "directory", entry));
      const children = await readdir(absolutePath);
      for (const name of children.sort((left, right) => left.localeCompare(right))) {
        const childRelative = relativePath ? `${relativePath}/${name}` : name;
        await visit(path.join(absolutePath, name), childRelative);
      }
      return;
    }
    if (entry.isFile()) {
      files.push(treeEntry(relativePath, "file", entry));
      return;
    }
    throw new Error(`${errorCode}:${relativePath || "."}`);
  };

  await visit(rootDir, "");
  return {
    directories: directories.sort((left, right) => left.path.localeCompare(right.path)),
    files: files.sort((left, right) => left.path.localeCompare(right.path))
  };
}

export async function snapshotWorkspaceRoots(rootDir: string, roots: readonly string[]): Promise<SafeTreeEntry[]> {
  const entries: SafeTreeEntry[] = [];
  for (const root of roots) {
    assertSafeBundleRelativePath(root, "workspace_backup_root_invalid");
    const rootPath = path.join(rootDir, root);
    let tree: SafeTree;
    let rootEntry: Awaited<ReturnType<typeof lstat>>;
    try {
      rootEntry = await lstat(rootPath);
      if (!rootEntry.isDirectory()) throw new Error(`workspace_backup_source_file_type_invalid:${root}`);
      tree = await scanSafeTree(rootPath, "workspace_backup_source_file_type_invalid");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`workspace_backup_source_root_missing:${root}`);
      throw error;
    }
    entries.push(
      treeEntry(root, "directory", rootEntry),
      ...tree.directories.map((entry) => ({ ...entry, path: `${root}/${entry.path}` })),
      ...tree.files.map((entry) => ({ ...entry, path: `${root}/${entry.path}` }))
    );
  }
  return entries.sort(compareTreeEntry);
}

export function sameWorkspaceRootSnapshot(left: readonly SafeTreeEntry[], right: readonly SafeTreeEntry[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Copies every expected source root while enforcing normal-file semantics. */
export async function copyWorkspaceRootsToBundle(
  workspaceRoot: string,
  bundleFilesRoot: string,
  roots: readonly string[]
): Promise<void> {
  for (const root of roots) {
    const source = path.join(workspaceRoot, root);
    const destination = path.join(bundleFilesRoot, root);
    await copySafeTree(source, destination, "workspace_backup_source_file_type_invalid");
  }
}

export async function copySafeTree(sourceRoot: string, destinationRoot: string, errorCode = "workspace_bundle_file_type_invalid"): Promise<void> {
  const copy = async (source: string, destination: string): Promise<void> => {
    const entry = await lstat(source);
    if (entry.isDirectory()) {
      await mkdir(destination, { recursive: true });
      const children = await readdir(source);
      for (const name of children.sort((left, right) => left.localeCompare(right))) {
        await copy(path.join(source, name), path.join(destination, name));
      }
      return;
    }
    if (entry.isFile()) {
      await copyFileStreaming(source, destination);
      return;
    }
    throw new Error(`${errorCode}:${source}`);
  };
  await copy(sourceRoot, destinationRoot);
}

function treeEntry(relativePath: string, kind: SafeTreeEntry["kind"], entry: Awaited<ReturnType<typeof lstat>>): SafeTreeEntry {
  return {
    path: relativePath,
    kind,
    size: Number(entry.size),
    mode: Number(entry.mode),
    mtime_ms: Number(entry.mtimeMs),
    ctime_ms: Number(entry.ctimeMs)
  };
}

function compareTreeEntry(left: SafeTreeEntry, right: SafeTreeEntry): number {
  return left.path.localeCompare(right.path) || left.kind.localeCompare(right.kind);
}
