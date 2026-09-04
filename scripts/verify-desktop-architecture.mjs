import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const jsonOutput = process.argv.includes("--json");
const scoreOutput = process.argv.includes("--score") || process.argv.includes("--audit");

const checks = [
  checkRootScripts(), checkDesktopFiles(), checkDesktopConfigAndHealth(), checkDesktopRuntimeBoundary(), checkSecureBrowserWindows(),
  checkPreloadAllowlist(), checkDesktopEntryPoints(), checkDesktopResidentBehavior(), checkClientEventQueue(), checkOsNotificationHandling(),
  checkGatewayExternalClientBoundary(), checkAppShotTemporaryContext(), checkDeepLinkHandling(), checkWebDesktopBridge()
];
const scoreItems = buildScoreItems(checks);
const ok = checks.every((check) => check.ok);

if (jsonOutput) console.log(JSON.stringify({ ok, checks, score: scoreSummary(scoreItems) }, null, 2));
else if (scoreOutput) {
  const summary = scoreSummary(scoreItems);
  console.log(`static score ${summary.points}/${summary.total}`);
  for (const item of scoreItems) console.log(`${item.ok ? "ok" : "fail"} ${item.no}. ${item.requirement} [${item.checks.join(", ")}]`);
} else for (const check of checks) console.log(`${check.ok ? "ok" : "fail"} ${check.name}: ${check.message}`);
process.exitCode = ok ? 0 : 1;

function checkRootScripts() {
  const scripts = readJson("package.json").scripts ?? {};
  const required = ["desktop:dev", "desktop:build", "desktop:verify", "desktop:audit"];
  const missing = required.filter((name) => !scripts[name]);
  return result("root-scripts", missing.length === 0, missing.length === 0 ? "desktop commands are present" : `missing scripts: ${missing.join(", ")}`);
}

function checkDesktopFiles() {
  const required = ["apps/desktop/package.json", "apps/desktop/tsconfig.json", "apps/desktop/src/config.ts", "apps/desktop/src/html.ts", "apps/desktop/src/main.ts", "apps/desktop/src/preload.cts"];
  const missing = required.filter((file) => !existsSync(path.join(root, file)));
  return result("desktop-files", missing.length === 0, missing.length === 0 ? "desktop package scaffold is present" : `missing files: ${missing.join(", ")}`);
}

function checkDesktopConfigAndHealth() {
  const config = read("apps/desktop/src/config.ts");
  const main = read("apps/desktop/src/main.ts");
  const html = read("apps/desktop/src/html.ts");
  const required = [
    [config, "apiHealthUrl"], [config, "webDevUrl"], [config, "packagedWebEntryPath"], [config, "SAMURAI_DESKTOP_WEB_DIST"],
    [main, "probeHealth(config)"], [main, "serverOfflineMessage"], [main, "SAMURAI_DESKTOP_API_URL"], [main, "statusPageHtml"],
    [main, "loadMainWindowUrl"], [main, "mainWindowLoadToken"], [main, "Web UIに接続できません"], [html, "Retry"], [html, "Quit"],
    [html, "Content-Security-Policy"], [html, "default-src 'none'"], [html, "reloadMainWindow"], [html, "quitApp"]
  ];
  return missingResult("desktop-config-health", required, "development/packaged config and health fallback UI are present");
}

function checkDesktopRuntimeBoundary() {
  const main = read("apps/desktop/src/main.ts");
  const forbidden = ["@samurai-agent/runtime", "@samurai-agent/memory", "@samurai-agent/core-schemas", "@samurai-agent/workspace-server"].filter((moduleName) => main.includes(moduleName));
  return result("runtime-boundary", forbidden.length === 0, forbidden.length === 0 ? "desktop main stays at the OS/API boundary" : `forbidden imports: ${forbidden.join(", ")}`);
}

function checkSecureBrowserWindows() {
  const main = read("apps/desktop/src/main.ts");
  const required = ["setWindowOpenHandler", "openExternalUrl", "isSafeExternalUrl", "protocol === \"https:\"", "isPackagedWebFileUrl", "isPathInside", "applyDataWindowNavigationPolicy"];
  const missing = required.filter((snippet) => !main.includes(snippet));
  const blocks = browserWindowBlocks(main);
  const insecure = blocks.flatMap((block, index) => ["contextIsolation: true", "nodeIntegration: false", "sandbox: true"].filter((snippet) => !block.includes(snippet)).map((snippet) => `${index + 1}:${snippet}`));
  const directOpenExternal = regionBetween(main, "function openExternalUrl", "function isSafeExternalUrl").length === 0 ? main.replace(/function openExternalUrl[\s\S]*?function isSafeExternalUrl/, "").includes("shell.openExternal(") : false;
  const good = missing.length === 0 && blocks.length === 3 && insecure.length === 0 && !directOpenExternal;
  return result("secure-browser-windows", good, good ? "BrowserWindow and external navigation policies are fail-closed" : `missing=${missing.join(", ") || "none"} windows=${blocks.length}/3 insecure=${insecure.join(", ") || "none"} direct_open_external=${directOpenExternal ? "yes" : "no"}`);
}

function checkPreloadAllowlist() {
  const preload = read("apps/desktop/src/preload.cts");
  const exposed = ["getStatus", "openMainWindow", "reloadMainWindow", "quitApp", "closeAppShot", "closeQuickAsk", "submitAppShot", "submitQuickAsk"];
  const missing = exposed.filter((name) => !preload.includes(`${name}:`));
  const unsafe = ["readFile", "writeFile", "exec", "spawn", "shell"].filter((snippet) => containsIdentifier(preload, snippet));
  const good = missing.length === 0 && unsafe.length === 0;
  return result("preload-allowlist", good, good ? "preload exposes only the allowlisted IPC surface" : `missing=${missing.join(", ") || "none"} unsafe=${unsafe.join(", ") || "none"}`);
}

function checkDesktopEntryPoints() {
  const combined = `${read("apps/desktop/src/main.ts")}\n${read("apps/desktop/src/config.ts")}`;
  const required = ["clipboardAskShortcut", "selectionAskShortcut", "quickAskShortcut", "appShotShortcut", "setAsDefaultProtocolClient", "createTray", "openQuickAsk", "openAppShot", "probeHealth"];
  const missing = required.filter((snippet) => !combined.includes(snippet));
  return result("desktop-entry-points", missing.length === 0, missing.length === 0 ? "tray, shortcuts, protocol and capture entry points are wired" : `missing snippets: ${missing.join(", ")}`);
}

function checkDesktopResidentBehavior() {
  const main = read("apps/desktop/src/main.ts");
  const required = ["let isQuitting = false", "app.on(\"before-quit\"", "mainWindow.on(\"close\"", "event.preventDefault()", "mainWindow?.hide()", "samurai:app:quit", "startClientEventPolling()", "role: \"quit\""];
  const missing = required.filter((snippet) => !main.includes(snippet));
  const closedRegion = regionBetween(main, "app.on(\"window-all-closed\"", "app.on(\"before-quit\"");
  const good = missing.length === 0 && !closedRegion.includes("app.quit()");
  return result("desktop-resident-behavior", good, good ? "closing the window keeps resident event polling alive" : `missing=${missing.join(", ") || "none"} forbidden=${closedRegion.includes("app.quit()") ? "app.quit() in window-all-closed" : "none"}`);
}

function checkClientEventQueue() {
  const schema = read("packages/core-schemas/src/index.ts");
  const pgSchema = read("packages/workspace-server/src/schema.ts");
  const adapter = read("apps/server/src/adapters/runtime/postgres-runtime-client-events.ts");
  const server = read("apps/server/src/workspace-server/http-server.ts");
  const desktop = read("apps/desktop/src/main.ts");
  const schemaTest = read("packages/core-schemas/src/core-schemas.test.ts");
  const serverTest = read("apps/server/src/index.standard-entry.test.ts");
  const required = [[schema, "ClientEventRecordSchema"], [pgSchema, "workspace_runtime_client_events"], [adapter, "deliver(context"], [adapter, "acknowledge(context"], [adapter, "expire(context"], [server, "/api/workspaces/:workspaceId/client-events"], [desktop, "pollClientEvents"], [desktop, "markClientEventDelivered"], [desktop, "ackClientEvent"], [schemaTest, "ClientEventRecordSchema.parse"], [serverTest, "PostgreSQL composition"]];
  return missingResult("client-event-queue", required, "PostgreSQL queue schema, adapter, API and Desktop polling are present");
}

function checkOsNotificationHandling() {
  const server = read("apps/server/src/workspace-server/http-server.ts");
  const clientEvents = read("apps/server/src/adapters/runtime/postgres-runtime-client-events.ts");
  const desktop = read("apps/desktop/src/main.ts");
  const required = [[clientEvents, "client.notification.requested"], [clientEvents, '"completed"'], [clientEvents, '"failed"'], [clientEvents, '"waiting_for_backend_input"'], [desktop, "Notification.isSupported()"], [desktop, "new Notification"], [desktop, "notification.on(\"click\""], [desktop, "deepLinkForClientEvent"]];
  return missingResult("os-notification-handling", required, "run notifications are delivered through the PostgreSQL Client Event Queue");
}

function checkGatewayExternalClientBoundary() {
  const schema = read("packages/core-schemas/src/index.ts");
  const gateway = read("packages/gateway/src/index.ts");
  const runtime = read("packages/runtime/src/agent-runtime.ts");
  const domain = read("packages/runtime/src/commands/services/gateway-domain-service.ts");
  const server = read("apps/server/src/workspace-server/http-server.ts");
  const adapterTest = read("apps/server/src/adapters/runtime/postgres-gateway.test.ts");
  const required = [[schema, "gatewayChannels"], [schema, "gatewayBoundarySources"], [gateway, "cronMemoryReviewGatewayContext"], [server, "gateway.inbound.route"], [server, "gateway_inbound"], [runtime, "async handleGatewayInbound"], [runtime, "routeGatewayInbound"], [runtime, "saveInbound: (record)"], [domain, "executeInbound"], [adapterTest, "RLS Context"]];
  const missing = required.filter(([content, snippet]) => !content.includes(snippet)).map(([, snippet]) => snippet);
  const forbidden = ["BrowserWindow", "desktopCapturer", "globalShortcut", "Notification", "from \"electron\"", "from 'electron'"].filter((snippet) => server.includes(snippet) || gateway.includes(snippet));
  const good = missing.length === 0 && forbidden.length === 0;
  return result("gateway-external-client-boundary", good, good ? "external clients enter through Gateway and PostgreSQL-backed Runtime" : `missing=${missing.join(", ") || "none"} forbidden=${forbidden.join(", ") || "none"}`);
}

function checkAppShotTemporaryContext() {
  const server = read("apps/server/src/workspace-server/http-server.ts");
  const desktop = read("apps/desktop/src/main.ts");
  const runtime = read("packages/runtime/src/context/temporary-context-port.ts");
  const provider = read("packages/runtime/src/provider-profiles.ts");
  const required = [[server, "temporary_context"], [server, "temporaryContextField"], [desktop, "desktopCapturer.getSources"], [desktop, "temporaryContextItems"], [desktop, "temporaryContextTtlMs"], [desktop, "appShotEmptySourcesMessage"], [desktop, "画面収録権限"], [desktop, "applyDataWindowNavigationPolicy"], [runtime, "resolveTemporaryContext"], [provider, "temporaryContextImages"]];
  const missing = required.filter(([content, snippet]) => !content.includes(snippet)).map(([, snippet]) => snippet);
  const appShot = regionBetween(desktop, "async function submitAppShot", "function validateAppShotInput");
  const quickAsk = regionBetween(desktop, "async function submitQuickAsk", "function startClientEventPolling");
  const signed = [appShot, quickAsk].flatMap((content) => ["activeWorkspaceServerRequest", "activeWorkspaceExecutableRoomId", "activeWorkspaceChatPath()"].filter((snippet) => !content.includes(snippet)));
  const good = missing.length === 0 && signed.length === 0;
  return result("appshot-temporary-context", good, good ? "capture data stays temporary and submits through signed Room-scoped chat" : `missing=${missing.join(", ") || "none"} signed_context=${signed.join(", ") || "none"}`);
}

function checkDeepLinkHandling() {
  const desktop = read("apps/desktop/src/main.ts");
  const server = read("apps/server/src/workspace-server/http-server.ts");
  const required = [[desktop, "parseDeepLink"], [desktop, "pendingDeepLink = undefined"], [desktop, "checkDeepLinkTargetAvailability"], [desktop, "Deep Linkを開けません"], [desktop, "Deep Linkの対象が見つかりません"], [server, "/api/workspaces/:workspaceId/backend-runs/:runId"]];
  return missingResult("deep-link-handling", required, "invalid and missing deep links have explicit handling");
}

function checkWebDesktopBridge() {
  const api = read("apps/web/src/lib/api.ts");
  const workspace = read("apps/web/src/AppWorkspace.vue");
  const preload = read("apps/desktop/src/preload.cts");
  const desktop = read("apps/desktop/src/main.ts");
  const protocol = read("packages/ui-protocol/src/index.ts");
  const gateway = read("packages/gateway/src/index.ts");
  const required = [[api, "getApiBaseUrl"], [api, "window.samuraiDesktop?.apiBaseUrl"], [api, "getBackendRun"], [workspace, "onWorkspaceServerEvent"], [preload, "onWorkspaceServerEvent"], [desktop, "samurai:workspace-server:event"], [desktop, "workspaceSocketAuth"], [workspace, "openBackendRunDeepLink"], [protocol, "attachments?: ResourceRef[]"], [gateway, "attachments: MessageEnvelope[\"attachments\"]"]];
  const missing = required.filter(([content, snippet]) => !content.includes(snippet)).map(([, snippet]) => snippet);
  const forbidden = [existsSync(path.join(root, "apps/web/src/lib/connect-app-socket.ts")) ? "obsolete web socket module" : "", api.includes("socket.io-client") ? "web socket.io-client import" : "", workspace.includes("connectAppSocket") ? "connectAppSocket" : ""].filter(Boolean);
  const issues = [...missing, ...forbidden.map((item) => `forbidden:${item}`)];
  return result("web-desktop-bridge", issues.length === 0, issues.length === 0 ? "Web and Desktop share signed HTTP/Core contracts" : `bridge contract issues: ${issues.join(", ")}`);
}

function missingResult(name, pairs, successMessage) {
  const missing = pairs.filter(([content, snippet]) => !content.includes(snippet)).map(([, snippet]) => snippet);
  return result(name, missing.length === 0, missing.length === 0 ? successMessage : `missing snippets: ${missing.join(", ")}`);
}
function containsIdentifier(content, identifier) {
  return new RegExp(`(?<![A-Za-z0-9_$])${identifier}(?![A-Za-z0-9_$])`).test(content);
}
function result(name, ok, message) { return { name, ok, message }; }
function buildScoreItems(inputChecks) {
  const byName = new Map(inputChecks.map((check) => [check.name, check]));
  const item = (no, requirement, names) => ({ no, requirement, checks: names, ok: names.every((name) => byName.get(name)?.ok === true), points: names.every((name) => byName.get(name)?.ok === true) ? 2 : 0, total: 2 });
  return [item(1, "Desktop package and commands exist", ["root-scripts", "desktop-files"]), item(2, "BrowserWindow security is configured", ["desktop-files", "secure-browser-windows"]), item(3, "health-gated config and fallback UI", ["desktop-config-health"]), item(4, "Desktop stays outside Core storage", ["runtime-boundary"]), item(5, "preload is allowlisted", ["preload-allowlist"]), item(6, "resident behavior and client events", ["desktop-resident-behavior", "client-event-queue"]), item(7, "gateway boundary", ["gateway-external-client-boundary"]), item(8, "temporary capture context", ["appshot-temporary-context"]), item(9, "deep links", ["deep-link-handling"]), item(10, "Web/Desktop bridge", ["web-desktop-bridge"]), item(11, "OS notifications", ["os-notification-handling"]), item(12, "entry points", ["desktop-entry-points"])]
}
function scoreSummary(items) { const points = items.reduce((sum, item) => sum + item.points, 0); const total = items.reduce((sum, item) => sum + item.total, 0); return { points, total, ok: points === total, items }; }
function read(relativePath) { return readFileSync(path.join(root, relativePath), "utf8"); }
function readJson(relativePath) { return JSON.parse(read(relativePath)); }
function regionBetween(content, startSnippet, endSnippet) { const start = content.indexOf(startSnippet); if (start < 0) return ""; const end = content.indexOf(endSnippet, start); return end < 0 ? content.slice(start) : content.slice(start, end); }
function browserWindowBlocks(content) { return content.split("new BrowserWindow({").slice(1).map((part) => { const end = part.indexOf("\n  });"); return part.slice(0, end >= 0 ? end : 1600); }); }
