import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export interface ManagedResourceFile {
  relativePath: string;
  content: string;
}

/**
 * Reads one managed resource completely before its repository starts a SQLite
 * transaction.  A directory or I/O failure is intentionally propagated so the
 * owner can leave its existing derived index untouched.
 */
export async function readManagedResourceFiles(
  rootDir: string,
  root: string,
  matches: (relativePath: string) => boolean
): Promise<ManagedResourceFile[]> {
  const directory = path.join(rootDir, root);
  const relativeFiles = await listFilesStrict(directory);
  const selected = relativeFiles
    .filter(matches)
    .sort()
    .map((relativePath) => path.join(root, relativePath));
  return Promise.all(selected.map(async (relativePath) => ({
    relativePath,
    content: await readFile(path.join(rootDir, relativePath), "utf8")
  })));
}

async function listFilesStrict(rootDir: string, currentDir = rootDir): Promise<string[]> {
  const entries = await readdir(currentDir, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const absolutePath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) return listFilesStrict(rootDir, absolutePath);
    if (!entry.isFile()) return [];
    return [path.relative(rootDir, absolutePath)];
  }));
  return nested.flat();
}
