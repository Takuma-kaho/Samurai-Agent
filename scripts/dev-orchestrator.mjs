export const DEFAULT_API_PORT = 4317;
export const DEFAULT_WEB_PORT = 5173;
export const DEFAULT_POLL_MS = 300;
export const DEFAULT_HEALTH_WARN_MS = 10_000;
export const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;

export function parseDevMode(args) {
  let desktop = false;

  for (const arg of args) {
    if (arg === "--desktop") {
      desktop = true;
      continue;
    }
    throw new Error(`Unknown development argument: ${arg}`);
  }

  return desktop ? "desktop" : "server-web";
}

export function classifyChildExit(input) {
  if (input?.signal === "SIGINT" || input?.code === 130) {
    return "interrupt";
  }
  if (input?.name === "Desktop" && input?.code === 0 && !input?.signal) {
    return "success";
  }
  return "failure";
}

export function shouldStartChild(shuttingDown) {
  return shuttingDown !== true;
}

export function formatStartupChildExit(input) {
  const status = input?.signal ? `signal ${input.signal}` : `code ${input?.code ?? "unknown"}`;
  return `Started ${input?.name ?? "child"} child exited before readiness (${status}); see child stderr above.`;
}

export function createDevConfig(env = process.env, options = {}) {
  const respectDesktopUrls = options.respectDesktopUrls !== false;
  const apiPort = parsePort(env.PORT ?? env.SAMURAI_API_PORT, DEFAULT_API_PORT);
  const webPort = parsePort(env.SAMURAI_WEB_PORT, DEFAULT_WEB_PORT);
  const healthWarnMs = parseDuration(env.SAMURAI_DEV_HEALTH_WARN_MS, DEFAULT_HEALTH_WARN_MS);
  const startupTimeoutMs = parseDuration(env.SAMURAI_DEV_STARTUP_TIMEOUT_MS, DEFAULT_STARTUP_TIMEOUT_MS);
  const apiEndpoint = resolveEndpoint(
    respectDesktopUrls ? env.SAMURAI_DESKTOP_API_URL : undefined,
    `http://127.0.0.1:${apiPort}`,
    apiPort
  );
  const webEndpoint = resolveEndpoint(
    respectDesktopUrls ? env.SAMURAI_DESKTOP_WEB_URL : undefined,
    `http://127.0.0.1:${webPort}`,
    webPort
  );

  return {
    apiPort: apiEndpoint.port,
    apiHost: apiEndpoint.host,
    apiManagedLocally: apiEndpoint.managedLocally,
    apiUrl: apiEndpoint.url,
    healthUrl: `${apiEndpoint.url}/api/health`,
    webPort: webEndpoint.port,
    webHost: webEndpoint.host,
    webManagedLocally: webEndpoint.managedLocally,
    webUrl: webEndpoint.url,
    webOrigin: webEndpoint.origin,
    healthWarnMs,
    startupTimeoutMs,
    pollMs: DEFAULT_POLL_MS
  };
}

export function resolveEndpoint(rawValue, fallbackUrl, fallbackPort) {
  const value = rawValue?.trim() || fallbackUrl;
  let url;
  try {
    url = new URL(value);
  } catch (error) {
    throw new Error(`Invalid development endpoint URL: ${value}`, { cause: error });
  }

  if (url.username || url.password || url.hash || url.search) {
    throw new Error(`Development endpoint URL must not include credentials, query, or hash: ${value}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Development endpoint URL must use http or https: ${value}`);
  }

  const port = parsePort(url.port || (url.protocol === "https:" ? 443 : 80), fallbackPort);
  const pathname = url.pathname.replace(/\/$/, "");
  const normalizedUrl = `${url.origin}${pathname}`;
  const managedLocally = url.protocol === "http:" && isLoopbackHost(url.hostname);
  return {
    url: normalizedUrl,
    origin: url.origin,
    host: url.hostname.replace(/^\[|\]$/g, ""),
    port,
    managedLocally
  };
}

export function isLoopbackHost(hostname) {
  return hostname === "localhost"
    || hostname === "127.0.0.1"
    || hostname === "::1"
    || hostname === "[::1]";
}

export function classifyApiHealth(input) {
  const body = input?.body;
  if (!body || typeof body !== "object" || Array.isArray(body) || !("ok" in body)) {
    return "occupied";
  }

  // A non-OK response without the Workspace Server's storage marker is not
  // enough evidence that the port belongs to Samurai Agent.
  if (body.storage === undefined && body.ok !== true) {
    return "occupied";
  }

  if (!input.responseOk || body.ok !== true || body.db?.ok === false) {
    return "starting";
  }

  return body.storage === "postgresql" ? "postgresql-ready" : "legacy-ready";
}

export function classifyWebResponse(input) {
  const body = typeof input?.body === "string" ? input.body : "";
  if (
    input?.responseOk === true
    && /<title>\s*Samurai Agent\s*<\/title>/i.test(body)
    && /id=["']app["']/i.test(body)
  ) {
    return "ready";
  }
  return "occupied";
}

export function parsePort(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535 ? parsed : fallback;
}

export function parseDuration(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}
