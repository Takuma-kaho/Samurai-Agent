import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const apiPort = Number(process.env.PORT ?? 4317);
const apiUrl = `http://127.0.0.1:${apiPort}`;
const healthUrl = `${apiUrl}/api/health`;
const healthWarnMs = Number(process.env.SAMURAI_DEV_HEALTH_WARN_MS ?? 10_000);
const pollMs = 300;
const apiEntry = fileURLToPath(new URL("../apps/server/src/index.ts", import.meta.url));
const webRoot = fileURLToPath(new URL("../apps/web", import.meta.url));
const viteBin = fileURLToPath(new URL("../node_modules/vite/bin/vite.js", import.meta.url));

const children = new Map();
let shuttingDown = false;

const server = start("API", process.execPath, ["--import", "tsx", apiEntry], {
  env: {
    ...process.env,
    PORT: String(apiPort)
  }
});

const web = start("Web", process.execPath, [viteBin, "--host", "127.0.0.1", "--port", "5173"], {
  cwd: webRoot,
  env: {
    ...process.env,
    VITE_API_TARGET: apiUrl
  }
});

void monitorHealth(healthUrl);

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

server.on("exit", (code, signal) => handleChildExit("API", code, signal));
web.on("exit", (code, signal) => handleChildExit("Web", code, signal));

function start(name, command, args, options) {
  const child = spawn(command, args, {
    stdio: "inherit",
    cwd: options.cwd,
    env: options.env
  });
  children.set(name, child);
  child.on("exit", () => children.delete(name));
  child.on("error", (error) => {
    if (shuttingDown) {
      return;
    }
    console.error(`[dev] ${name} failed to start: ${error.message}`);
    shutdown(1);
  });
  return child;
}

function handleChildExit(name, code, signal) {
  if (shuttingDown) {
    return;
  }
  if (signal === "SIGINT" || code === 130) {
    shutdown(0);
    return;
  }
  const status = formatExit(code, signal);
  console.error(`[dev] ${name} process exited unexpectedly: ${status}`);
  shutdown(code && code > 0 ? code : 1);
}

async function monitorHealth(url) {
  const startedAt = Date.now();
  let warned = false;
  let lastError = "not ready";

  while (!shuttingDown) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        const health = await response.json();
        if (health?.ok === true && health?.db?.ok !== false) {
          console.log(`[dev] API is ready: ${url}`);
          return;
        }
        lastError = `health returned unhealthy: ${JSON.stringify(health)}`;
      } else {
        lastError = `${response.status} ${response.statusText}`;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    if (!warned && Date.now() - startedAt >= healthWarnMs) {
      warned = true;
      console.warn(`[dev] API is still not ready after ${Math.round(healthWarnMs / 1000)}s: ${lastError}`);
      console.warn(`[dev] Web is running; API-backed actions will recover when ${url} becomes available.`);
    }
    await sleep(pollMs);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shutdown(code) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  for (const child of children.values()) {
    child.kill("SIGTERM");
  }
  setTimeout(() => process.exit(code), 250).unref();
}

function formatExit(code, signal) {
  return signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
}
