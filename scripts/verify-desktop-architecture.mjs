import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const jsonOutput = process.argv.includes("--json");
const scoreOutput = process.argv.includes("--score") || process.argv.includes("--audit");

const checks = [
  checkRootScripts(),
  checkDesktopFiles(),
  checkDesktopConfigAndHealth(),
  checkDesktopRuntimeBoundary(),
  checkSecureBrowserWindows(),
  checkPreloadAllowlist(),
  checkDesktopEntryPoints(),
  checkDesktopResidentBehavior(),
  checkClientEventQueue(),
  checkOsNotificationHandling(),
  checkGatewayExternalClientBoundary(),
  checkAppShotTemporaryContext(),
  checkDeepLinkHandling(),
  checkWebDesktopBridge()
];
const scoreItems = buildScoreItems(checks);

if (jsonOutput) {
  console.log(JSON.stringify({ ok: checks.every((check) => check.ok), checks, score: scoreSummary(scoreItems) }, null, 2));
} else if (scoreOutput) {
  const summary = scoreSummary(scoreItems);
  console.log(`static score ${summary.points}/${summary.total}`);
  for (const item of scoreItems) {
    console.log(`${item.ok ? "ok" : "fail"} ${item.no}. ${item.requirement} [${item.checks.join(", ")}]`);
  }
} else {
  for (const check of checks) {
    console.log(`${check.ok ? "ok" : "fail"} ${check.name}: ${check.message}`);
  }
}

process.exitCode = checks.every((check) => check.ok) ? 0 : 1;

function checkRootScripts() {
  const pkg = readJson("package.json");
  const scripts = pkg.scripts ?? {};
  const missing = ["desktop:dev", "desktop:build", "desktop:verify", "desktop:audit"].filter((script) => !scripts[script]);
  return result("root-scripts", missing.length === 0, missing.length === 0
    ? "desktop dev/build/verify/audit scripts are present"
    : `missing scripts: ${missing.join(", ")}`);
}

function checkDesktopFiles() {
  const required = [
    "apps/desktop/package.json",
    "apps/desktop/tsconfig.json",
    "apps/desktop/src/config.ts",
    "apps/desktop/src/html.ts",
    "apps/desktop/src/main.ts",
    "apps/desktop/src/preload.cts"
  ];
  const missing = required.filter((file) => !existsSync(path.join(root, file)));
  return result("desktop-files", missing.length === 0, missing.length === 0
    ? "desktop package scaffold is present"
    : `missing files: ${missing.join(", ")}`);
}

function checkDesktopConfigAndHealth() {
  const config = read("apps/desktop/src/config.ts");
  const main = read("apps/desktop/src/main.ts");
  const html = read("apps/desktop/src/html.ts");
  const required = [
    [config, "mode"],
    [config, "apiHealthUrl"],
    [config, "webDevUrl"],
    [config, "packagedWebEntryPath"],
    [config, "SAMURAI_DESKTOP_WEB_DIST"],
    [main, "probeHealth(config)"],
    [main, "serverOfflineMessage"],
    [main, "SAMURAI_DESKTOP_API_URL"],
    [main, "statusPageHtml"],
    [main, "Serverに接続できません"],
    [main, "loadMainWindowUrl"],
    [main, "mainWindowLoadToken"],
    [main, "Web UIに接続できません"],
    [main, "ERR_ABORTED"],
    [html, "Retry"],
    [html, "Quit"],
    [html, "Content-Security-Policy"],
    [html, "default-src 'none'"],
    [html, "reloadMainWindow"],
    [html, "window.samuraiDesktop.reloadMainWindow()"],
    [html, "quitApp"],
    [html, "window.samuraiDesktop.quitApp()"]
  ];
  const missing = required.filter(([content, snippet]) => !content.includes(snippet)).map(([, snippet]) => snippet);
  return result("desktop-config-health", missing.length === 0, missing.length === 0
    ? "development/packaged config and health-gated fallback UI are present"
    : `missing snippets: ${missing.join(", ")}`);
}

function checkDesktopRuntimeBoundary() {
  const main = read("apps/desktop/src/main.ts");
  const forbiddenImports = [
    "@samurai-agent/runtime",
    "@samurai-agent/workspace-store",
    "@samurai-agent/memory",
    "@samurai-agent/core-schemas"
  ].filter((moduleName) => main.includes(moduleName));
  return result("runtime-boundary", forbiddenImports.length === 0, forbiddenImports.length === 0
    ? "desktop main does not import Runtime/Store/Memory internals"
    : `forbidden imports: ${forbiddenImports.join(", ")}`);
}

function checkSecureBrowserWindows() {
  const main = read("apps/desktop/src/main.ts");
  const required = [
    "setWindowOpenHandler",
    "openExternalUrl",
    "isSafeExternalUrl",
    "protocol === \"https:\"",
    "inputConfig.mode === \"development\" && isSameOrigin",
    "isPackagedWebFileUrl",
    "isPathInside",
    "fileURLToPath(parsed)",
    "applyDataWindowNavigationPolicy"
  ];
  const missing = required.filter((snippet) => !main.includes(snippet));
  const directOpenExternal = main.replace(/function openExternalUrl[\s\S]*?function isSafeExternalUrl/, "").includes("shell.openExternal(");
  const mainNavigationRegion = regionBetween(
    main,
    "function isAllowedMainNavigation",
    "function isPackagedWebFileUrl"
  );
  const dataWindowNavigationRegion = regionBetween(
    main,
    "function applyDataWindowNavigationPolicy",
    "async function listAppShotSources"
  );
  const unsafeDataNavigation = mainNavigationRegion.includes("data:text/html") || dataWindowNavigationRegion.includes("data:text/html");
  const windowBlocks = browserWindowBlocks(main);
  const windowCountOk = windowBlocks.length === 3;
  const insecureWindows = windowBlocks
    .map((block, index) => ({
      index: index + 1,
      missing: ["contextIsolation: true", "nodeIntegration: false", "sandbox: true"].filter((snippet) => !block.includes(snippet))
    }))
    .filter((entry) => entry.missing.length > 0);
  return result(
    "secure-browser-windows",
    missing.length === 0 && insecureWindows.length === 0 && windowCountOk && !directOpenExternal && !unsafeDataNavigation,
    missing.length === 0 && insecureWindows.length === 0 && windowCountOk && !directOpenExternal && !unsafeDataNavigation
      ? "all BrowserWindows use safe webPreferences and external link escape is present"
      : `missing=${missing.join(", ") || "none"} direct_open_external=${directOpenExternal ? "yes" : "no"} unsafe_data_navigation=${unsafeDataNavigation ? "yes" : "no"} window_count=${windowBlocks.length}/3 insecure_windows=${insecureWindows.map((entry) => `${entry.index}:${entry.missing.join("+")}`).join(", ") || "none"}`
  );
}

function checkPreloadAllowlist() {
  const preload = read("apps/desktop/src/preload.cts");
  const exposed = [
    "getStatus",
    "openMainWindow",
    "reloadMainWindow",
    "quitApp",
    "closeAppShot",
    "closeQuickAsk",
    "submitAppShot",
    "submitQuickAsk"
  ];
  const missing = exposed.filter((name) => !preload.includes(`${name}:`));
  const unsafe = ["readFile", "writeFile", "exec", "spawn", "shell"].filter((snippet) => preload.includes(snippet));
  return result("preload-allowlist", missing.length === 0 && unsafe.length === 0, missing.length === 0 && unsafe.length === 0
    ? "preload exposes a small validated IPC API"
    : `missing=${missing.join(", ") || "none"} unsafe=${unsafe.join(", ") || "none"}`);
}

function checkDesktopEntryPoints() {
  const main = read("apps/desktop/src/main.ts");
  const config = read("apps/desktop/src/config.ts");
  const required = [
    "clipboardAskShortcut",
    "selectionAskShortcut",
    "quickAskShortcut",
    "appShotShortcut",
    "setAsDefaultProtocolClient",
    "createTray",
    "openQuickAsk",
    "shouldRefreshQuickAsk",
    "openClipboardAsk",
    "openSelectionAsk",
    "openAppShot",
    "probeHealth"
  ];
  const combined = `${main}\n${config}`;
  const missing = required.filter((snippet) => !combined.includes(snippet));
  return result("desktop-entry-points", missing.length === 0, missing.length === 0
    ? "tray, shortcuts, protocol handler, health gate, Quick Ask, clipboard, selected text, and AppShot are wired"
    : `missing snippets: ${missing.join(", ")}`);
}

function checkDesktopResidentBehavior() {
  const main = read("apps/desktop/src/main.ts");
  const windowAllClosedRegion = regionBetween(
    main,
    "app.on(\"window-all-closed\"",
    "app.on(\"before-quit\""
  );
  const required = [
    "let isQuitting = false",
    "app.on(\"before-quit\"",
    "mainWindow.on(\"close\"",
    "event.preventDefault()",
    "mainWindow?.hide()",
    "samurai:app:quit",
    "app.quit()",
    "startClientEventPolling()",
    "role: \"quit\""
  ];
  const missing = required.filter((snippet) => !main.includes(snippet));
  const forbidden = windowAllClosedRegion.includes("app.quit()") ? ["app.quit() in window-all-closed"] : [];
  return result(
    "desktop-resident-behavior",
    missing.length === 0 && forbidden.length === 0,
    missing.length === 0 && forbidden.length === 0
      ? "main window close hides to tray while Client Event Queue polling remains resident"
      : `missing=${missing.join(", ") || "none"} forbidden=${forbidden.join(", ") || "none"}`
  );
}

function checkClientEventQueue() {
  const schema = read("packages/core-schemas/src/index.ts");
  const migration = read("packages/workspace-store/src/migrations/001-core-baseline.ts");
  const store = read("packages/workspace-store/src/repositories/client-event-queue-repository.ts");
  const server = read("apps/server/src/api-server.ts");
  const desktop = read("apps/desktop/src/main.ts");
  const schemaTest = read("packages/core-schemas/src/core-schemas.test.ts");
  const storeTest = read("packages/workspace-store/src/workspace-store.test.ts");
  const serverTest = read("apps/server/src/index.test.ts");
  const required = [
    [schema, "ClientEventRecordSchema"],
    [migration, "CREATE TABLE IF NOT EXISTS client_events"],
    [store, "markClientEventDelivered"],
    [store, "ackClientEvent"],
    [store, "expireClientEvents"],
    [server, "/api/client-events"],
    [server, "maybeCreateClientEventFromRuntimeEvent"],
    [desktop, "pollClientEvents"],
    [desktop, "markClientEventDelivered"],
    [desktop, "ackClientEvent"],
    [schemaTest, "parses client event queue records"],
    [storeTest, "persists client event queue lifecycle"],
    [storeTest, "expireClientEvents"],
    [serverTest, "queues client events through API and backend run updates"],
    [serverTest, "/api/client-events"],
    [serverTest, "/deliver"],
    [serverTest, "/ack"]
  ];
  const missing = required.filter(([content, snippet]) => !content.includes(snippet)).map(([, snippet]) => snippet);
  return result("client-event-queue", missing.length === 0, missing.length === 0
    ? "queue schema/store/API/polling/ack paths and regression tests are present"
    : `missing snippets: ${missing.join(", ")}`);
}

function checkOsNotificationHandling() {
  const server = read("apps/server/src/api-server.ts");
  const desktop = read("apps/desktop/src/main.ts");
  const required = [
    [server, "client.notification.requested"],
    [server, "backend_run_completed"],
    [server, "backend_run_failed"],
    [server, "backend_run_waiting_for_input"],
    [desktop, "Notification.isSupported()"],
    [desktop, "new Notification"],
    [desktop, "notification.on(\"click\""],
    [desktop, "deepLinkForClientEvent"],
    [desktop, "await failClientEvent(event.id, errorCode(error))"]
  ];
  const missing = required.filter(([content, snippet]) => !content.includes(snippet)).map(([, snippet]) => snippet);
  return result("os-notification-handling", missing.length === 0, missing.length === 0
    ? "run completion/failure/waiting notifications can deep-link and fail without crashing"
    : `missing snippets: ${missing.join(", ")}`);
}

function checkGatewayExternalClientBoundary() {
  const schema = read("packages/core-schemas/src/index.ts");
  const gateway = read("packages/gateway/src/index.ts");
  const runtime = read("packages/runtime/src/agent-runtime.ts");
  const gatewayDomainService = read("packages/runtime/src/commands/services/gateway-domain-service.ts");
  const server = read("apps/server/src/api-server.ts");
  const serverTest = read("apps/server/src/index.test.ts");
  const gatewayServerRegion = regionBetween(
    server,
    "app.post(\"/api/gateway/inbound\"",
    "app.get(\"/api/backend-runs\""
  );
  const required = [
    [schema, "gatewayChannels = [\"telegram\", \"slack\", \"line\", \"email\", \"mobile\", \"webhook\", \"local_cli\", \"cron\"]"],
    [schema, "gatewayBoundarySources = [\"web\", \"telegram\", \"slack\", \"line\", \"email\", \"mobile\", \"webhook\", \"local_cli\", \"cron\"]"],
    [gateway, "cronMemoryReviewGatewayContext"],
    [server, "app.post(\"/api/gateway/webhooks/:source_identity\""],
    [server, "app.post(\"/api/gateway/slack/events\""],
    [server, "app.post(\"/api/gateway/telegram/updates\""],
    [server, "app.post(\"/api/gateway/line/events\""],
    [server, "app.post(\"/api/gateway/email/messages\""],
    [server, "app.post(\"/api/gateway/mobile/messages\""],
    [server, "app.post(\"/api/gateway/email/provider-webhooks/:provider\""],
    [server, "app.post(\"/api/gateway/email/imap/poll\""],
    [server, "command_id: \"gateway.inbound.route\""],
    [server, "input_source: \"gateway_inbound\""],
    [server, "channel: \"mobile\""],
    [server, "gateway_mobile_adapter"],
    [serverTest, "routes Mobile message payloads through Gateway inbound"],
    [serverTest, "/api/gateway/mobile/messages"],
    [runtime, "async handleGatewayInbound"],
    [runtime, "routeGatewayInbound"],
    [runtime, "runChat: (input) => this.runChatTurn"],
    [runtime, "saveInbound: (record) => this.store.saveGatewayInboundMessage"],
    [gatewayDomainService, "const chat = await this.dependencies.inbound.runChat"],
    [server, "maybeCreateClientEventFromRuntimeEvent"],
    [server, "target_client_kind: \"desktop\""],
    [server, "client.notification.requested"]
  ];
  const forbidden = [
    "BrowserWindow",
    "desktopCapturer",
    "globalShortcut",
    "Notification",
    "from \"electron\"",
    "from 'electron'"
  ].filter((snippet) => gatewayServerRegion.includes(snippet) || gateway.includes(snippet));
  const missing = required.filter(([content, snippet]) => !content.includes(snippet)).map(([, snippet]) => snippet);
  return result(
    "gateway-external-client-boundary",
    missing.length === 0 && forbidden.length === 0,
    missing.length === 0 && forbidden.length === 0
      ? "messaging/mobile/webhook/cron gateway routes go through Runtime/BackendRun and return to Desktop through Client Event Queue"
      : `missing=${missing.join(", ") || "none"} forbidden=${forbidden.join(", ") || "none"}`
  );
}

function checkAppShotTemporaryContext() {
  const server = read("apps/server/src/api-server.ts");
  const desktop = read("apps/desktop/src/main.ts");
  const runtime = read("packages/runtime/src/context/temporary-context-port.ts");
  const provider = read("packages/runtime/src/provider-profiles.ts");
  const appShotSubmit = regionBetween(desktop, "async function submitAppShot", "function validateAppShotInput");
  const quickAskSubmit = regionBetween(desktop, "async function submitQuickAsk", "function startClientEventPolling");
  const required = [
    [server, "/api/temporary-context"],
    [server, "temporaryContextTtlMs"],
    [server, "parseTemporaryContextPngDataUrl"],
    [server, "cleanupTimer.unref"],
    [server, "temporaryContexts.close"],
    [server, "closePromise"],
    [server, "temporary_context_store_closed"],
    [desktop, "desktopCapturer.getSources"],
    [desktop, "temporaryContextItems"],
    [desktop, "submitAppShot"],
    [desktop, "appShotEmptySourcesMessage"],
    [desktop, "画面収録権限"],
    [desktop, "openSelectionAsk"],
    [desktop, "shouldRefreshQuickAsk"],
    [desktop, "readSelectedTextFromMainWindow"],
    [desktop, "applyDataWindowNavigationPolicy"],
    [runtime, "resolveTemporaryContext"],
    [provider, "temporaryContextImages"]
  ];
  const missing = required.filter(([content, snippet]) => !content.includes(snippet)).map(([, snippet]) => snippet);
  const signedWorkspaceChat = [
    [appShotSubmit, "activeWorkspaceServerRequest"],
    [appShotSubmit, "activeWorkspaceExecutableRoomId"],
    [appShotSubmit, "activeWorkspaceChatPath()"],
    [appShotSubmit, "temporary_context"],
    [quickAskSubmit, "activeWorkspaceServerRequest"],
    [quickAskSubmit, "activeWorkspaceExecutableRoomId"],
    [quickAskSubmit, "activeWorkspaceChatPath()"]
  ].filter(([content, snippet]) => !content.includes(snippet)).map(([, snippet]) => snippet);
  const legacySubmitPaths = ["/api/chat/sessions", "/api/surface/operations", "/api/temporary-context"]
    .filter((snippet) => appShotSubmit.includes(snippet) || quickAskSubmit.includes(snippet));
  const ok = missing.length === 0 && signedWorkspaceChat.length === 0 && legacySubmitPaths.length === 0;
  return result("appshot-temporary-context", ok, ok
    ? "AppShot and Quick Ask use signed Room-scoped PostgreSQL Chat; screenshot bytes remain temporary request context"
    : `missing=${missing.join(", ") || "none"} signed_workspace_chat=${signedWorkspaceChat.join(", ") || "none"} legacy_submit_paths=${legacySubmitPaths.join(", ") || "none"}`);
}

function checkDeepLinkHandling() {
  const desktop = read("apps/desktop/src/main.ts");
  const server = read("apps/server/src/api-server.ts");
  const required = [
    [desktop, "parseDeepLink"],
    [desktop, "pendingDeepLink = undefined"],
    [desktop, "checkDeepLinkTargetAvailability"],
    [desktop, "Deep Linkを開けません"],
    [desktop, "Deep Linkの対象が見つかりません"],
    [server, "/api/backend-runs/:runId"]
  ];
  const missing = required.filter(([content, snippet]) => !content.includes(snippet)).map(([, snippet]) => snippet);
  return result("deep-link-handling", missing.length === 0, missing.length === 0
    ? "invalid and missing deep link targets have understandable handling"
    : `missing snippets: ${missing.join(", ")}`);
}

function checkWebDesktopBridge() {
  const api = read("apps/web/src/lib/api.ts");
  const appWorkspace = read("apps/web/src/AppWorkspace.vue");
  const preload = read("apps/desktop/src/preload.cts");
  const desktop = read("apps/desktop/src/main.ts");
  const protocol = read("packages/ui-protocol/src/index.ts");
  const gateway = read("packages/gateway/src/index.ts");
  const required = [
    [api, "getApiBaseUrl"],
    [api, "window.samuraiDesktop?.apiBaseUrl"],
    [api, "attachments"],
    [api, "getBackendRun"],
    [appWorkspace, "onWorkspaceServerEvent"],
    [preload, "onWorkspaceServerEvent"],
    [desktop, "samurai:workspace-server:event"],
    [desktop, "workspaceSocketAuth"],
    [appWorkspace, "openBackendRunDeepLink"],
    [protocol, "attachments?: ResourceRef[]"],
    [gateway, "attachments: MessageEnvelope[\"attachments\"]"]
  ];
  const missing = required.filter(([content, snippet]) => !content.includes(snippet)).map(([, snippet]) => snippet);
  const legacySocketPath = path.join(root, "apps/web/src/lib/connect-app-socket.ts");
  const legacySocket = existsSync(legacySocketPath) ? read("apps/web/src/lib/connect-app-socket.ts") : "";
  const forbidden = legacySocket || api.includes("socket.io-client") || appWorkspace.includes("connectAppSocket") || desktop.includes("io(getApiBaseUrl())")
    ? [
        ...(legacySocket ? ["apps/web/src/lib/connect-app-socket.ts"] : []),
        ...(api.includes("socket.io-client") ? ["web socket.io-client import"] : []),
        ...(appWorkspace.includes("connectAppSocket") ? ["connectAppSocket"] : []),
        ...(desktop.includes("io(getApiBaseUrl())") ? ["io(getApiBaseUrl())"] : [])
      ]
    : [];
  const issues = [...missing, ...forbidden.map((item) => `forbidden:${item}`)];
  return result("web-desktop-bridge", issues.length === 0, issues.length === 0
    ? "browser uses signed HTTP and Desktop uses Main signed Socket plus preload IPC"
    : `bridge contract issues: ${issues.join(", ")}`);
}

function result(name, ok, message) {
  return { name, ok, message };
}

function buildScoreItems(inputChecks) {
  const byName = new Map(inputChecks.map((check) => [check.name, check]));
  const item = (no, requirement, checkNames) => ({
    no,
    requirement,
    checks: checkNames,
    ok: checkNames.every((name) => byName.get(name)?.ok === true),
    points: checkNames.every((name) => byName.get(name)?.ok === true) ? 2 : 0,
    total: 2
  });
  return [
    item(1, "apps/desktop and root scripts exist", ["root-scripts", "desktop-files"]),
    item(2, "Electron BrowserWindow can host the existing Web UI", ["desktop-files", "secure-browser-windows"]),
    item(3, "development and packaged URL/path config are separated", ["desktop-config-health"]),
    item(4, "normal UI is gated by Server API health", ["desktop-config-health"]),
    item(5, "offline Server API shows understandable next action", ["desktop-config-health"]),
    item(6, "Electron main does not import Runtime/Store/Memory internals", ["runtime-boundary"]),
    item(7, "Desktop actions use Server API, SurfaceOperation, or allowlisted IPC", ["preload-allowlist", "web-desktop-bridge"]),
    item(8, "long runs and gateway runs do not depend on window open state", ["desktop-resident-behavior", "client-event-queue"]),
    item(9, "closing the desktop window does not break Core or Workspace state", ["desktop-resident-behavior"]),
    item(10, "Desktop Shell stays scoped to OS integration and display duties", ["runtime-boundary", "desktop-entry-points"]),
    item(11, "Desktop messages use the same chat session save path as Web", ["web-desktop-bridge"]),
    item(12, "Desktop-generated BackendRuns remain in normal Run History/events", ["web-desktop-bridge"]),
    item(13, "Desktop opens Workspace resources by shared ids and APIs", ["deep-link-handling", "web-desktop-bridge"]),
    item(14, "Web UI bridge remains compatible after Electron integration", ["web-desktop-bridge"]),
    item(15, "Tray/menu contains Open and Quit", ["desktop-entry-points", "desktop-resident-behavior"]),
    item(16, "Tray/menu exposes current connection status", ["desktop-entry-points", "desktop-config-health"]),
    item(17, "global shortcut can show/hide the main window", ["desktop-entry-points", "desktop-resident-behavior"]),
    item(18, "global shortcut can open Quick Ask", ["desktop-entry-points"]),
    item(19, "Quick Ask submits through normal message submit path", ["web-desktop-bridge", "desktop-entry-points"]),
    item(20, "samurai:// protocol handler is registered", ["desktop-entry-points"]),
    item(21, "samurai://session/<id> opens a session", ["deep-link-handling"]),
    item(22, "samurai://artifact/<id> and samurai://run/<id> open resources", ["deep-link-handling"]),
    item(23, "invalid or missing deep links show understandable errors", ["deep-link-handling"]),
    item(24, "ClientEventRecord storage supports pending/delivered/acked/expired/failed", ["client-event-queue"]),
    item(25, "Runtime or Server API can create client events", ["client-event-queue", "os-notification-handling"]),
    item(26, "Desktop receives pending events by polling", ["client-event-queue"]),
    item(27, "Desktop returns delivered or acked after event handling", ["client-event-queue"]),
    item(28, "events survive Desktop being offline and can expire", ["client-event-queue"]),
    item(29, "queue create/deliver/ack/expire tests or verification exist", ["client-event-queue"]),
    item(30, "run completion can request OS notification", ["os-notification-handling"]),
    item(31, "run failure or waiting states can request OS notification", ["os-notification-handling"]),
    item(32, "notification clicks navigate to session/run/artifact", ["os-notification-handling", "deep-link-handling"]),
    item(33, "notification failure is recorded without crashing", ["os-notification-handling"]),
    item(34, "Messaging/Mobile/Webhook/Cron are Gateway upstream clients", ["gateway-external-client-boundary"]),
    item(35, "Gateway has no direct Desktop control path", ["gateway-external-client-boundary"]),
    item(36, "Gateway requests pass through Runtime/Host and leave run/workspace records", ["gateway-external-client-boundary"]),
    item(37, "Gateway completion can notify Desktop through Client Event Queue", ["gateway-external-client-boundary", "client-event-queue"]),
    item(38, "Electron BrowserWindows use contextIsolation and no nodeIntegration", ["secure-browser-windows"]),
    item(39, "preload IPC API is allowlisted and validates input", ["preload-allowlist"]),
    item(40, "renderer cannot do arbitrary file/shell/workspace writes", ["preload-allowlist", "runtime-boundary"]),
    item(41, "external links escape Electron to OS browser", ["secure-browser-windows"]),
    item(42, "clipboard/selected text/screenshot are confirmed before submit", ["desktop-entry-points", "appshot-temporary-context"]),
    item(43, "temporary screenshots/context items have TTL and cleanup", ["appshot-temporary-context"]),
    item(44, "AppShot starts only from explicit user action", ["desktop-entry-points", "appshot-temporary-context"]),
    item(45, "captured screenshot defaults to temporary context item", ["appshot-temporary-context"]),
    item(46, "long-term AppShot persistence requires explicit later action", ["appshot-temporary-context", "runtime-boundary"]),
    item(47, "screen capture permission errors guide the user in natural language", ["appshot-temporary-context"]),
    item(48, "target workspace typecheck can be run", ["root-scripts", "desktop-files"]),
    item(49, "desktop package build or launch verification can be run", ["root-scripts", "desktop-files"]),
    item(50, "implementation respects architecture and naming boundaries", ["runtime-boundary", "gateway-external-client-boundary", "preload-allowlist"])
  ];
}

function scoreSummary(items) {
  const points = items.reduce((sum, item) => sum + item.points, 0);
  const total = items.reduce((sum, item) => sum + item.total, 0);
  return {
    points,
    total,
    ok: points === total,
    items
  };
}

function read(relativePath) {
  return readFileSync(path.join(root, relativePath), "utf8");
}

function readJson(relativePath) {
  return JSON.parse(read(relativePath));
}

function regionBetween(content, startSnippet, endSnippet) {
  const start = content.indexOf(startSnippet);
  if (start < 0) {
    return "";
  }
  const end = content.indexOf(endSnippet, start);
  return end < 0 ? content.slice(start) : content.slice(start, end);
}

function browserWindowBlocks(content) {
  return content.split("new BrowserWindow({").slice(1).map((part) => {
    const end = part.indexOf("\n  });");
    return part.slice(0, end >= 0 ? end : 1200);
  });
}
