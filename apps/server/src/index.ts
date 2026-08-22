import { pathToFileURL } from "node:url";
import {
  closeApiServer,
  createApiServer,
  defaultWorkspaceRoot,
  loadServerEnv,
  resolveWorkspaceRoot,
  setGatewayEmailImapClientFactoryForTest,
  startServer,
  trustedRuntimeApiInput,
  trustedRuntimeApiPayload,
  type ApiServer,
  type ApiServerLifecycleState,
  type ApiServerShutdownState,
  type CreateApiServerOptions
} from "./api-server";
import type { WorkspaceServerHttp } from "./workspace-server/http-server";

export {
  closeApiServer,
  createApiServer,
  defaultWorkspaceRoot,
  loadServerEnv,
  resolveWorkspaceRoot,
  setGatewayEmailImapClientFactoryForTest,
  startServer,
  trustedRuntimeApiInput,
  trustedRuntimeApiPayload,
  type ApiServer,
  type ApiServerLifecycleState,
  type ApiServerShutdownState,
  type CreateApiServerOptions
};
export { startAutomationScheduler, type AutomationScheduler, type AutomationSchedulerState } from "./workers/automation-scheduler";

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
const isTestRuntime = Boolean(process.env.VITEST || process.env.VITEST_WORKER_ID || process.env.NODE_ENV === "test" || process.argv.some((arg) => arg.includes("vitest")));

export function installServerSignalHandlers(server: ApiServer | WorkspaceServerHttp): () => void {
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = () => {
    if (!shutdownPromise) {
      shutdownPromise = ("store" in server ? closeApiServer(server) : server.close()).catch((error) => {
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

/**
 * The normal process has one PostgreSQL-backed composition root.  The legacy
 * SQLite API remains available through createApiServer for migration and
 * characterization tests, but it is never selected by the standard entry.
 */
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
