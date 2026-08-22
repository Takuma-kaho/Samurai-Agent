import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { WorkspaceFilePort } from "@samurai-agent/core-schemas";

/** Transitional SQLite composition adapter for Runtime's filesystem capability. */
export function createWorkspaceFilePort(): WorkspaceFilePort {
  return {
    readText: (filePath) => readFile(filePath, "utf8"),
    readTextIfExists: (filePath) => readFile(filePath, "utf8").catch(() => undefined),
    readBytes: (filePath) => readFile(filePath),
    readBytesIfExists: (filePath) => readFile(filePath).catch(() => undefined),
    writeText: (filePath, content) => writeFile(filePath, content),
    writeBytes: (filePath, content) => writeFile(filePath, content),
    remove: (filePath) => rm(filePath, { force: true }),
    ensureParent: (filePath) => mkdir(path.dirname(filePath), { recursive: true }).then(() => undefined),
    isFile: async (filePath) => {
      try {
        return (await stat(filePath)).isFile();
      } catch {
        return false;
      }
    },
    stat: async (filePath) => {
      const info = await stat(filePath);
      return { size: info.size, modifiedAt: info.mtime.toISOString() };
    }
  };
}
