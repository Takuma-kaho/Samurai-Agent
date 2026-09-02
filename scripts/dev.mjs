import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  classifyApiHealth,
  classifyChildExit,
  classifyWebResponse,
  createDevConfig,
  formatStartupChildExit,
  parseDevMode,
  shouldStartChild
} from "./dev-orchestrator.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const apiEntry = fileURLToPath(new URL("../apps/server/src/index.ts", import.meta.url));
const webRoot = fileURLToPath(new URL("../apps/web", import.meta.url));
const viteBin = fileURLToPath(new URL("../node_modules/vite/bin/vite.js", import.meta.url));

if (isMainModule()) {
  try {
    process.exitCode = await runDev(process.argv.slice(2));
  } catch (error) {
    console.error(`[dev] ${error instanceof Error ? error.message : String(error)}`);
    if (process.exitCode === undefined) {
      process.exitCode = 1;
    }
  }
}

export async function runDev(args = []) {
  const mode = parseDevMode(args);
  const config = createDevConfig(process.env, { respectDesktopUrls: mode === "desktop" });
  const children = new Map();
  const childExitPromises = new WeakMap();
  const childClosePromises = new WeakMap();
  const closedChildren = new WeakSet();
  let shuttingDown = false;
  let shutdownPromise;

  const shutdown = (code) => {
    if (shutdownPromise) {
      return shutdownPromise;
    }
    shuttingDown = true;
    const startedChildren = [...children.values()];
    shutdownPromise = Promise.all(startedChildren.map((child) => terminateChild(child)))
      .then(() => {
        process.exitCode = code;
      });
    return shutdownPromise;
  };

  const handleChildExit = (name, code, signal) => {
    if (shuttingDown) {
      return;
    }
    const outcome = classifyChildExit({ name, code, signal });
    if (outcome === "success" || outcome === "interrupt") {
      void shutdown(0);
      return;
    }
    const status = formatExit(code, signal);
    console.error(`[dev] ${name} process exited unexpectedly: ${status}`);
    void shutdown(1);
  };

  const start = (name, command, args, options = {}) => {
    if (!shouldStartChild(shuttingDown)) {
      return undefined;
    }
    const child = spawn(command, args, {
      stdio: "inherit",
      cwd: options.cwd ?? repoRoot,
      env: options.env ?? process.env,
      detached: process.platform !== "win32",
      ...(process.platform === "win32" ? { windowsHide: true } : {})
    });
    children.set(name, child);
    childExitPromises.set(child, new Promise((resolveExit) => {
      child.once("exit", (code, signal) => {
        resolveExit({ code, signal });
      });
    }));
    childClosePromises.set(child, new Promise((resolveClose) => {
      child.once("close", (code, signal) => {
        closedChildren.add(child);
        children.delete(name);
        resolveClose({ code, signal });
      });
    }));
    child.once("exit", (code, signal) => {
      handleChildExit(name, code, signal);
    });
    child.on("error", (error) => {
      if (shuttingDown) {
        return;
      }
      console.error(`[dev] ${name} failed to start: ${error.message}`);
      void shutdown(1);
    });
    return child;
  };

  const terminateChild = async (child) => {
    const closePromise = childClosePromises.get(child) ?? Promise.resolve();
    if (!closedChildren.has(child)) {
      signalProcessTree(child, "SIGTERM");
      if (!(await waitForCloseOrTimeout(closePromise, 5_000))) {
        signalProcessTree(child, "SIGKILL");
      }
    }
    await closePromise;
  };

  process.once("SIGINT", () => shutdown(0));
  process.once("SIGTERM", () => shutdown(0));

  try {
    if (mode === "desktop") {
      return await runDesktopMode({
        config,
        start,
        childExitPromises,
        isShuttingDown: () => shuttingDown
      });
    }

    return await runServerWebMode({ config, start, shutdown, isShuttingDown: () => shuttingDown });
  } catch (error) {
    await shutdown(1);
    throw error;
  }
}

async function runServerWebMode({ config, start, shutdown, isShuttingDown }) {
  const preflight = await probeApi(config.healthUrl, config.apiPort);
  if (preflight.kind === "unavailable") {
    start("API", process.execPath, ["--import", "tsx", apiEntry], {
      env: {
        ...process.env,
        PORT: String(config.apiPort),
        ...(process.env.SAMURAI_CORS_ORIGINS || process.env.SAMURAI_SERVER_PUBLIC === "1"
          ? {}
          : { SAMURAI_CORS_ORIGINS: `http://127.0.0.1:${config.webPort},http://localhost:${config.webPort}` })
      }
    });
  }

  if (preflight.kind === "ready") {
    console.log(`[dev] Reusing existing API: ${config.healthUrl}`);
    if (preflight.storage !== "postgresql") {
      console.error(`[dev] Existing API is not the standard PostgreSQL server (storage=${preflight.storage}).`);
      console.error(`[dev] Stop the legacy compatibility API on ${config.apiPort}, then run pnpm run dev again.`);
      return 1;
    }
    console.log("[dev] PostgreSQL Workspace Server is ready.");
  } else if (preflight.kind === "starting") {
    console.log(`[dev] API port is already in use; waiting for existing Samurai Agent API: ${config.healthUrl}`);
    void monitorHealth(config, { shutdown, isShuttingDown });
  } else if (preflight.kind === "occupied") {
    console.error(`[dev] Port ${config.apiPort} is already in use, but ${config.healthUrl} is not a Samurai Agent API.`);
    console.error(`[dev] Stop the process using ${config.apiPort}, or run with PORT=<free-port>.`);
    return 1;
  } else {
    void monitorHealth(config, { shutdown, isShuttingDown });
  }

  start("Web", process.execPath, [viteBin, "--host", "127.0.0.1", "--port", String(config.webPort)], {
    cwd: webRoot,
    env: {
      ...process.env,
      VITE_API_TARGET: config.apiUrl
    }
  });
  return 0;
}

async function runDesktopMode({ config, start, childExitPromises, isShuttingDown }) {
  const preflight = await probeApi(
    config.healthUrl,
    config.apiManagedLocally ? config.apiPort : undefined,
    config.apiHost
  );
  let apiChild;

  if (preflight.kind === "ready" && preflight.storage === "postgresql") {
    console.log(`[dev] Reusing existing PostgreSQL API: ${config.healthUrl}`);
  } else if (preflight.kind === "ready") {
    throw new Error(config.apiManagedLocally
      ? `Port ${config.apiPort} serves a legacy compatibility API (storage=${preflight.storage}); stop it before Desktop mode.`
      : `Configured API endpoint serves a legacy compatibility API (storage=${preflight.storage}): ${config.healthUrl}.`);
  } else if (preflight.kind === "occupied") {
    throw new Error(config.apiManagedLocally
      ? `Port ${config.apiPort} is occupied by another service; stop it or choose a free PORT.`
      : `Configured API endpoint is not the Samurai PostgreSQL API: ${config.healthUrl}.`);
  } else if (preflight.kind === "unavailable") {
    if (!config.apiManagedLocally) {
      throw new Error(`Configured remote API is unavailable: ${config.healthUrl}; Desktop mode will not start a local API for it.`);
    }
    apiChild = start("API", process.execPath, ["--import", "tsx", apiEntry], {
      env: {
        ...process.env,
        PORT: String(config.apiPort),
        ...(config.apiHost !== "127.0.0.1" && !process.env.SAMURAI_BIND_ADDRESS
          ? { SAMURAI_BIND_ADDRESS: config.apiHost }
          : {}),
        ...(process.env.SAMURAI_CORS_ORIGINS || process.env.SAMURAI_SERVER_PUBLIC === "1"
          ? {}
          : { SAMURAI_CORS_ORIGINS: config.webOrigin })
      }
    });
    console.log(`[dev] Started API; waiting for PostgreSQL health: ${config.healthUrl}`);
  } else {
    console.log(`[dev] Waiting for existing API to become healthy: ${config.healthUrl}`);
  }

  const apiReady = await waitForApi(config, {
    startupChild: apiChild,
    startupChildName: "API",
    childExitPromises,
    isShuttingDown
  });
  if (apiReady.kind === "legacy") {
    throw new Error(`API is reachable but is not the standard PostgreSQL server (storage=${apiReady.storage}).`);
  }
  if (apiReady.kind !== "ready") {
    throw new Error(formatWaitFailure("PostgreSQL API", config.healthUrl, apiReady));
  }
  console.log(`[dev] PostgreSQL API is ready: ${config.healthUrl}`);
  if (isShuttingDown()) {
    throw new Error("Desktop startup was interrupted after the API became ready.");
  }

  let webChild;
  const webPreflight = await probeWeb(
    config.webUrl,
    config.webManagedLocally ? config.webPort : undefined,
    config.webHost
  );
  if (webPreflight.kind === "ready") {
    console.log(`[dev] Reusing existing Web: ${config.webUrl}`);
  } else if (webPreflight.kind === "occupied") {
    throw new Error(config.webManagedLocally
      ? `Port ${config.webPort} is occupied by another service, not Samurai Web; stop it before Desktop mode.`
      : `Configured Web endpoint is not the Samurai Web shell: ${config.webUrl}.`);
  } else {
    if (!config.webManagedLocally) {
      throw new Error(`Configured remote Web is unavailable: ${config.webUrl}; Desktop mode will not start a local Web for it.`);
    }
    if (isShuttingDown()) {
      throw new Error("Desktop startup was interrupted before Web startup.");
    }
    webChild = start("Web", process.execPath, [viteBin, "--host", config.webHost, "--port", String(config.webPort), "--strictPort"], {
      cwd: webRoot,
      env: {
        ...process.env,
        VITE_API_TARGET: config.apiUrl
      }
    });
    console.log(`[dev] Started Web; waiting for HTTP readiness: ${config.webUrl}`);
  }

  const webReady = await waitForWeb(config, {
    startupChild: webChild,
    startupChildName: "Web",
    childExitPromises,
    isShuttingDown
  });
  if (webReady.kind !== "ready") {
    throw new Error(formatWaitFailure("Samurai Web", config.webUrl, webReady));
  }
  console.log(`[dev] Web is ready: ${config.webUrl}`);
  if (isShuttingDown()) {
    throw new Error("Desktop startup was interrupted after Web became ready.");
  }

  const desktopEnv = {
    ...process.env,
    PORT: String(config.apiPort),
    SAMURAI_API_PORT: String(config.apiPort),
    SAMURAI_WEB_PORT: String(config.webPort),
    ...(process.env.SAMURAI_DESKTOP_API_URL?.trim() ? {} : { SAMURAI_DESKTOP_API_URL: config.apiUrl }),
    ...(process.env.SAMURAI_DESKTOP_WEB_URL?.trim() ? {} : { SAMURAI_DESKTOP_WEB_URL: config.webUrl })
  };
  const desktop = start("Desktop", pnpmCommand(), ["--filter", "@samurai-agent/desktop", "run", "dev"], { env: desktopEnv });
  if (!desktop) {
    throw new Error("Desktop startup was interrupted before the process could start.");
  }
  console.log("[dev] Desktop started.");
  return 0;
}

async function monitorHealth(config, { shutdown, isShuttingDown }) {
  const startedAt = Date.now();
  let warned = false;
  let lastError = "not ready";

  while (!isShuttingDown()) {
    const probe = await probeApi(
      config.healthUrl,
      config.apiManagedLocally ? config.apiPort : undefined,
      config.apiHost
    );
    if (probe.kind === "ready") {
      if (probe.storage !== "postgresql") {
        console.error(`[dev] API is reachable but is not the standard PostgreSQL server (storage=${probe.storage}).`);
        shutdown(1);
        return;
      }
      console.log(`[dev] PostgreSQL Workspace Server is ready.`);
      console.log(`[dev] API is ready: ${config.healthUrl}`);
      return;
    }
    if (probe.kind === "occupied") {
      lastError = "port is occupied by a non-Samurai service";
    } else {
      lastError = probe.detail ?? probe.kind;
    }

    if (!warned && Date.now() - startedAt >= config.healthWarnMs) {
      warned = true;
      console.warn(`[dev] API is still not ready after ${Math.round(config.healthWarnMs / 1000)}s: ${lastError}`);
      console.warn(`[dev] Web is running; API-backed actions will recover when ${config.healthUrl} becomes available.`);
    }
    await sleep(config.pollMs);
  }
}

async function waitForApi(config, options = {}) {
  const deadline = Date.now() + config.startupTimeoutMs;
  let lastProbe = { kind: "unavailable", detail: "not ready" };
  const childExitPromise = options.startupChild
    ? options.childExitPromises?.get(options.startupChild)?.then((exit) => ({
        kind: "child-exited",
        name: options.startupChildName,
        ...exit
      }))
    : undefined;

  while (Date.now() <= deadline) {
    const exited = childExitStatus(options.startupChild);
    if (exited) {
      return { kind: "child-exited", name: options.startupChildName, ...exited };
    }
    if (options.isShuttingDown?.()) {
      return { kind: "interrupted" };
    }
    const probe = childExitPromise
      ? await Promise.race([
          probeApi(
            config.healthUrl,
            config.apiManagedLocally ? config.apiPort : undefined,
            config.apiHost
          ),
          childExitPromise
        ])
      : await probeApi(
          config.healthUrl,
          config.apiManagedLocally ? config.apiPort : undefined,
          config.apiHost
        );
    if (probe.kind === "child-exited") {
      return probe;
    }
    const exitedAfterProbe = childExitStatus(options.startupChild);
    if (exitedAfterProbe) {
      return { kind: "child-exited", name: options.startupChildName, ...exitedAfterProbe };
    }
    lastProbe = probe;
    if (probe.kind === "ready") {
      if (probe.storage === "postgresql") return { kind: "ready" };
      return { kind: "legacy", storage: probe.storage };
    }
    if (probe.kind === "occupied") {
      return { kind: "occupied", detail: "port occupied by another service" };
    }
    await sleep(Math.min(config.pollMs, Math.max(0, deadline - Date.now())));
  }

  return { kind: "timeout", lastProbe };
}

async function waitForWeb(config, options = {}) {
  const deadline = Date.now() + config.startupTimeoutMs;
  let lastProbe = { kind: "unavailable", detail: "not ready" };
  const childExitPromise = options.startupChild
    ? options.childExitPromises?.get(options.startupChild)?.then((exit) => ({
        kind: "child-exited",
        name: options.startupChildName,
        ...exit
      }))
    : undefined;

  while (Date.now() <= deadline) {
    const exited = childExitStatus(options.startupChild);
    if (exited) {
      return { kind: "child-exited", name: options.startupChildName, ...exited };
    }
    if (options.isShuttingDown?.()) {
      return { kind: "interrupted" };
    }
    const probe = childExitPromise
      ? await Promise.race([
          probeWeb(
            config.webUrl,
            config.webManagedLocally ? config.webPort : undefined,
            config.webHost
          ),
          childExitPromise
        ])
      : await probeWeb(
          config.webUrl,
          config.webManagedLocally ? config.webPort : undefined,
          config.webHost
        );
    if (probe.kind === "child-exited") {
      return probe;
    }
    const exitedAfterProbe = childExitStatus(options.startupChild);
    if (exitedAfterProbe) {
      return { kind: "child-exited", name: options.startupChildName, ...exitedAfterProbe };
    }
    lastProbe = probe;
    if (probe.kind === "ready") return probe;
    if (probe.kind === "occupied") {
      return { kind: "occupied", detail: "port occupied by another service" };
    }
    await sleep(Math.min(config.pollMs, Math.max(0, deadline - Date.now())));
  }

  return { kind: "timeout", lastProbe };
}

async function probeApi(url, port, host) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
    const text = await response.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return { kind: "occupied", detail: "health response was not JSON" };
    }

    const classification = classifyApiHealth({ responseOk: response.ok, body });
    if (classification === "postgresql-ready") return { kind: "ready", storage: "postgresql" };
    if (classification === "legacy-ready") return { kind: "ready", storage: "legacy-compatibility" };
    if (classification === "starting") return { kind: "starting", detail: `health returned ${response.status}` };
    return { kind: "occupied", detail: "health response was not Samurai Agent health" };
  } catch (error) {
    return (await isPortOpen(port, host))
      ? { kind: "occupied", detail: error instanceof Error ? error.message : String(error) }
      : { kind: "unavailable", detail: error instanceof Error ? error.message : String(error) };
  }
}

async function probeWeb(url, port, host) {
  try {
    const response = await fetch(`${url}/`, { signal: AbortSignal.timeout(1_000) });
    const body = await response.text();
    return classifyWebResponse({ responseOk: response.ok, body }) === "ready"
      ? { kind: "ready" }
      : { kind: "occupied", detail: `HTTP ${response.status} was not Samurai Web` };
  } catch (error) {
    return (await isPortOpen(port, host))
      ? { kind: "occupied", detail: error instanceof Error ? error.message : String(error) }
      : { kind: "unavailable", detail: error instanceof Error ? error.message : String(error) };
  }
}

async function isPortOpen(port, host = "127.0.0.1") {
  if (port === undefined) {
    return false;
  }
  return await new Promise((resolveResult) => {
    const socket = createConnection({ host, port });
    const done = (open) => {
      socket.removeAllListeners();
      socket.destroy();
      resolveResult(open);
    };

    socket.setTimeout(1_000);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(true));
    socket.once("error", () => done(false));
  });
}

function signalProcessTree(child, signal) {
  if (!child.pid) {
    return;
  }

  if (process.platform === "win32") {
    // Windows does not have POSIX process groups. taskkill /T is the safe
    // fallback for the pnpm -> Electron process tree, and uses a numeric PID
    // argument without invoking a shell. Force is reserved for the escalation
    // after the graceful close wait.
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", ...(signal === "SIGKILL" ? ["/f"] : [])], {
      stdio: "ignore",
      windowsHide: true
    });
    killer.on("error", () => {
      try {
        child.kill(signal);
      } catch {
        // The child may already have exited.
      }
    });
    return;
  }

  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The child may already have exited.
    }
  }
}

async function waitForCloseOrTimeout(closePromise, timeoutMs) {
  let timeout;
  const timeoutPromise = new Promise((resolveResult) => {
    timeout = setTimeout(() => resolveResult(false), timeoutMs);
  });
  const closedPromise = closePromise.then(() => true);
  const closed = await Promise.race([closedPromise, timeoutPromise]);
  clearTimeout(timeout);
  return closed;
}

function childExitStatus(child) {
  if (!child || (child.exitCode === null && child.signalCode === null)) {
    return undefined;
  }
  return { code: child.exitCode, signal: child.signalCode };
}

function pnpmCommand() {
  return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
}

function formatWaitFailure(name, url, result) {
  if (result.kind === "child-exited") {
    return formatStartupChildExit(result);
  }
  if (result.kind === "interrupted") {
    return `${name} startup was interrupted before readiness (${url}).`;
  }
  if (result.kind === "occupied") {
    return `${name} port is occupied by another service (${url}).`;
  }
  const detail = result.lastProbe?.detail ?? result.detail ?? "timeout";
  return `${name} did not become ready within the startup timeout (${url}): ${detail}`;
}

function sleep(ms) {
  return new Promise((resolveResult) => setTimeout(resolveResult, ms));
}

function formatExit(code, signal) {
  return signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
}

function isMainModule() {
  return process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
}
