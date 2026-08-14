import { pathToFileURL } from "node:url";
import { startWorkspaceServer, type WorkspaceServerHttp } from "./workspace-server/http-server";

export * from "./workspace-server/http-server";

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";

if (import.meta.url === entry) {
  startWorkspaceServer()
    .then((server) => installSignalHandlers(server))
    .catch((error) => {
      console.error(error instanceof Error ? { name: error.name, message: error.message } : "workspace_server_start_failed");
      process.exitCode = 1;
    });
}

function installSignalHandlers(server: WorkspaceServerHttp): void {
  let closing: Promise<void> | undefined;
  const close = () => {
    if (!closing) closing = server.close().catch((error) => {
      console.error(error instanceof Error ? { name: error.name, message: error.message } : "workspace_server_shutdown_failed");
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}
