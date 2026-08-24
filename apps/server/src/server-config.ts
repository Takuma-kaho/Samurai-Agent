import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const defaultEnvPath = fileURLToPath(new URL("../../../.env", import.meta.url));
const loadedEnvPaths = new Set<string>();

/** Load the optional environment file without importing a storage implementation. */
export function loadServerEnv(envPath = defaultEnvPath): void {
  if (!existsSync(envPath) || loadedEnvPaths.has(envPath)) return;
  if (typeof process.loadEnvFile !== "function") {
    throw new Error(`Node.js process.loadEnvFile() is required to load ${envPath}. Upgrade Node.js or provide env vars through the shell.`);
  }
  process.loadEnvFile(envPath);
  loadedEnvPaths.add(envPath);
}

export function defaultWorkspaceRoot(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME || process.env.HOME || "";
  if (process.platform === "darwin" && home) {
    return path.join(home, "Library", "Application Support", "Samurai Agent", "workspace");
  }
  if (process.platform === "win32") {
    const appData = env.APPDATA || (home ? path.join(home, "AppData", "Roaming") : "");
    if (appData) return path.join(appData, "Samurai Agent", "workspace");
  }
  const dataHome = env.XDG_DATA_HOME || (home ? path.join(home, ".local", "share") : "");
  return dataHome ? path.join(dataHome, "samurai-agent", "workspace") : path.resolve("samurai-agent-workspace");
}

export function resolveWorkspaceRoot(optionWorkspaceDataDir?: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(
    optionWorkspaceDataDir?.trim()
      || env.SAMURAI_WORKSPACE_ROOT?.trim()
      || env.WORKSPACE_DATA_DIR?.trim()
      || defaultWorkspaceRoot(env)
  );
}
