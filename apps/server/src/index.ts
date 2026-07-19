import { pathToFileURL } from "node:url";
import { closeApiServer, startServer, type ApiServer } from "./api-server";

export * from "./api-server";
export * from "./workers/automation-scheduler";

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
const isTestRuntime = Boolean(process.env.VITEST || process.env.VITEST_WORKER_ID || process.env.NODE_ENV === "test" || process.argv.some((arg) => arg.includes("vitest")));

export function installServerSignalHandlers(server: ApiServer): () => void {
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = () => {
    if (!shutdownPromise) {
      shutdownPromise = closeApiServer(server).catch((error) => {
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

if (!isTestRuntime && import.meta.url === entry) {
  startServer()
    .then((server) => {
      installServerSignalHandlers(server);
    })
    .catch((error) => {
      console.error(error instanceof Error ? { name: error.name, message: error.message } : "server_start_failed");
      process.exitCode = 1;
    });
}
