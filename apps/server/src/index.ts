import { pathToFileURL } from "node:url";
import type { WorkspaceServerHttp } from "./workspace-server/http-server";
import { defaultWorkspaceRoot, loadServerEnv, resolveWorkspaceRoot } from "./server-config";

export {
  defaultWorkspaceRoot,
  loadServerEnv,
  resolveWorkspaceRoot
};
export { startAutomationScheduler, type AutomationScheduler, type AutomationSchedulerState } from "./workers/automation-scheduler";

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
const isTestRuntime = Boolean(process.env.VITEST || process.env.VITEST_WORKER_ID || process.env.NODE_ENV === "test" || process.argv.some((arg) => arg.includes("vitest")));

/**
 * Public server start entry. The normal programmatic start path uses the same
 * PostgreSQL composition as the process entry below.
 */
export async function startServer(port?: number): Promise<WorkspaceServerHttp> {
  return startStandardServer(port);
}

export function installServerSignalHandlers(server: WorkspaceServerHttp): () => void {
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = () => {
    if (!shutdownPromise) {
      const closing = server.close();
      shutdownPromise = closing.catch((error) => {
        console.error(error instanceof Error ? { name: error.name, message: error.message } : "server_shutdown_failed");
        process.exitCode = 1;
      });
    }
    void shutdownPromise;
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  return () => {
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
  };
}

/** The standard process has one PostgreSQL-backed composition root. */
export async function startStandardServer(port?: number): Promise<WorkspaceServerHttp> {
  const [{ loadWorkspaceServerConfig }, { startWorkspaceServer }] = await Promise.all([
    import("@samurai-agent/workspace-server"),
    import("./workspace-server/http-server")
  ]);
  const config = loadWorkspaceServerConfig();
  return startWorkspaceServer({ ...config, ...(port !== undefined ? { port } : {}) });
}

if (!isTestRuntime && import.meta.url === entry) {
  startStandardServer()
    .then((server) => {
      installServerSignalHandlers(server);
    })
    .catch((error) => {
      console.error(error instanceof Error ? { name: error.name, message: error.message } : "server_start_failed");
      process.exitCode = 1;
    });
}
