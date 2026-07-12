import { pathToFileURL } from "node:url";
import { startServer } from "./api-server";

export * from "./api-server";
export * from "./workers/automation-scheduler";

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
const isTestRuntime = Boolean(process.env.VITEST || process.env.VITEST_WORKER_ID || process.env.NODE_ENV === "test" || process.argv.some((arg) => arg.includes("vitest")));
if (!isTestRuntime && import.meta.url === entry) {
  startServer().catch((error) => {
    console.error(error instanceof Error ? { name: error.name, message: error.message } : "server_start_failed");
    process.exitCode = 1;
  });
}
