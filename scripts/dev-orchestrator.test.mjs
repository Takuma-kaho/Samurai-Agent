import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyApiHealth,
  classifyChildExit,
  classifyWebResponse,
  createDevConfig,
  formatStartupChildExit,
  parseDevMode,
  shouldStartChild
} from "./dev-orchestrator.mjs";

test("classifyChildExit treats a normal Desktop exit as successful shutdown", () => {
  assert.equal(classifyChildExit({ name: "Desktop", code: 0, signal: null }), "success");
});

test("classifyChildExit treats an unexpected API or Web exit as failure", () => {
  assert.equal(classifyChildExit({ name: "API", code: 0, signal: null }), "failure");
  assert.equal(classifyChildExit({ name: "Web", code: 1, signal: null }), "failure");
});

test("classifyChildExit treats explicit SIGINT as a successful interrupt", () => {
  assert.equal(classifyChildExit({ name: "API", code: null, signal: "SIGINT" }), "interrupt");
  assert.equal(classifyChildExit({ name: "Web", code: 130, signal: null }), "interrupt");
});

test("formatStartupChildExit preserves the startup child failure context", () => {
  assert.equal(
    formatStartupChildExit({ name: "API", code: 1, signal: null }),
    "Started API child exited before readiness (code 1); see child stderr above."
  );
});

test("shouldStartChild blocks a spawn after shutdown has begun", () => {
  assert.equal(shouldStartChild(false), true);
  assert.equal(shouldStartChild(true), false);
});

test("parseDevMode keeps the default server/web mode", () => {
  assert.equal(parseDevMode([]), "server-web");
});

test("parseDevMode enables Desktop mode only with the explicit flag", () => {
  assert.equal(parseDevMode(["--desktop"]), "desktop");
  assert.throws(() => parseDevMode(["--unknown"]), /Unknown development argument/);
});

test("createDevConfig preserves PORT and SAMURAI_* port contracts", () => {
  assert.deepEqual(createDevConfig({ PORT: "4321", SAMURAI_WEB_PORT: "5180" }), {
    apiPort: 4321,
    apiHost: "127.0.0.1",
    apiManagedLocally: true,
    webPort: 5180,
    webHost: "127.0.0.1",
    webManagedLocally: true,
    apiUrl: "http://127.0.0.1:4321",
    healthUrl: "http://127.0.0.1:4321/api/health",
    webUrl: "http://127.0.0.1:5180",
    webOrigin: "http://127.0.0.1:5180",
    healthWarnMs: 10_000,
    startupTimeoutMs: 30_000,
    pollMs: 300
  });
  assert.equal(createDevConfig({ SAMURAI_API_PORT: "4322" }).apiPort, 4322);
});

test("createDevConfig honors local and remote Desktop endpoints", () => {
  const local = createDevConfig({
    SAMURAI_DESKTOP_API_URL: "http://localhost:4321",
    SAMURAI_DESKTOP_WEB_URL: "http://127.0.0.1:5180"
  });
  assert.deepEqual(
    { apiUrl: local.apiUrl, apiHost: local.apiHost, apiPort: local.apiPort, apiManagedLocally: local.apiManagedLocally },
    { apiUrl: "http://localhost:4321", apiHost: "localhost", apiPort: 4321, apiManagedLocally: true }
  );
  assert.equal(createDevConfig({ SAMURAI_DESKTOP_API_URL: "http://[::1]:4322" }).apiHost, "::1");

  const remote = createDevConfig({
    SAMURAI_DESKTOP_API_URL: "https://samurai.example.test/api",
    SAMURAI_DESKTOP_WEB_URL: "https://app.example.test/native"
  });
  assert.equal(remote.apiManagedLocally, false);
  assert.equal(remote.webManagedLocally, false);
  assert.equal(remote.apiUrl, "https://samurai.example.test/api");
  assert.equal(remote.healthUrl, "https://samurai.example.test/api/api/health");
  assert.equal(remote.webUrl, "https://app.example.test/native");
});

test("classifyApiHealth distinguishes PostgreSQL, legacy, and unavailable services", () => {
  assert.equal(classifyApiHealth({ responseOk: true, body: { ok: true, storage: "postgresql", db: { ok: true } } }), "postgresql-ready");
  assert.equal(classifyApiHealth({ responseOk: true, body: { ok: true, storage: "sqlite", db: { ok: true } } }), "legacy-ready");
  assert.equal(classifyApiHealth({ responseOk: false, body: { ok: false, storage: "postgresql" } }), "starting");
  assert.equal(classifyApiHealth({ responseOk: false, body: { ok: false } }), "occupied");
  assert.equal(classifyApiHealth({ responseOk: true, body: { healthy: true } }), "occupied");
});

test("classifyWebResponse accepts the Samurai web shell and rejects other services", () => {
  assert.equal(classifyWebResponse({
    responseOk: true,
    body: '<title>Samurai Agent</title><body><div id="app"></div></body>'
  }), "ready");
  assert.equal(classifyWebResponse({
    responseOk: true,
    body: "<title>Other app</title><div id=\"app\"></div>"
  }), "occupied");
  assert.equal(classifyWebResponse({ responseOk: false, body: "service unavailable" }), "occupied");
});
