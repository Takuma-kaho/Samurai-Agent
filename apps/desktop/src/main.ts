import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  app,
  BrowserWindow,
  clipboard,
  desktopCapturer,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  shell,
  Tray
} from "electron";
import { createDesktopConfig, type DesktopConfig } from "./config.js";
import { appShotHtml, quickAskHtml, statusPageHtml } from "./html.js";

interface HealthState {
  ok: boolean;
  message: string;
  detail?: string;
  checkedAt: string;
}

interface QuickAskResult {
  sessionId?: string;
}

interface QuickAskInput {
  content: string;
  sourceFeature: "quick_ask" | "clipboard_text" | "selected_text";
}

interface AppShotResult {
  sessionId?: string;
  temporaryContextItemId?: string;
}

interface AppShotInput {
  sourceId: string;
  content: string;
}

type DeepLinkTarget = { kind: "workspace" | "session" | "artifact" | "run" | "quick-ask"; id?: string };

interface TemporaryContextItem {
  id: string;
  kind: "desktop_screenshot";
  label: string;
  sourceName: string;
  mimeType: "image/png";
  dataUrl: string;
  createdAt: string;
  expiresAt: string;
}

interface TemporaryContextResponse {
  id: string;
  kind: "temporary_context";
  uri: string;
  label: string;
  mime_type: "image/png";
  created_at: string;
  expires_at: string;
}

interface ClientEventRecord {
  id: string;
  target_client_kind: "desktop" | "web" | "any";
  target_client_id?: string;
  event_type:
    | "client.notification.requested"
    | "client.workspace.open_requested"
    | "client.session.open_requested"
    | "client.artifact.open_requested"
    | "client.run.open_requested"
    | "client.status.refresh_requested";
  status: "pending" | "delivered" | "acked" | "expired" | "failed";
  payload: Record<string, unknown>;
  resource_refs: Array<{ kind: string; id: string; uri: string; label?: string }>;
  created_at: string;
  delivered_at?: string;
  acked_at?: string;
  expires_at?: string;
  error_code?: string;
}

const config = createDesktopConfig({ isPackaged: app.isPackaged });
const preloadPath = fileURLToPath(new URL("./preload.cjs", import.meta.url));
const clientEventPollIntervalMs = 4000;
const temporaryContextTtlMs = 15 * 60 * 1000;

let mainWindow: BrowserWindow | undefined;
let appShotWindow: BrowserWindow | undefined;
let quickAskWindow: BrowserWindow | undefined;
let tray: Tray | undefined;
let clientEventPollTimer: NodeJS.Timeout | undefined;
let clientEventPollInFlight = false;
let isQuitting = false;
const temporaryContextItems = new Map<string, TemporaryContextItem>();
let latestHealth: HealthState = {
  ok: false,
  message: "Server health has not been checked yet.",
  checkedAt: new Date().toISOString()
};
let pendingDeepLink: string | undefined;
let mainWindowLoadToken = 0;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    const link = argv.find((value) => value.startsWith("samurai://"));
    if (link) {
      handleDeepLink(link);
    }
    showMainWindow();
  });
}

app.setName("Samurai Agent");

app.on("open-url", (event, url) => {
  event.preventDefault();
  handleDeepLink(url);
});

app.whenReady().then(async () => {
  registerProtocolHandler();
  registerIpcHandlers();
  createTray();
  registerShortcuts();
  await createMainWindow();
  startClientEventPolling();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    void createMainWindow();
    return;
  }
  showMainWindow();
});

app.on("window-all-closed", () => {
  // Keep the Desktop Shell resident; explicit Quit is the only app exit path.
});

app.on("before-quit", () => {
  isQuitting = true;
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  temporaryContextItems.clear();
  if (clientEventPollTimer) {
    clearInterval(clientEventPollTimer);
    clientEventPollTimer = undefined;
  }
});

async function createMainWindow(): Promise<void> {
  latestHealth = await probeHealth(config);
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 900,
    minWidth: 980,
    minHeight: 640,
    show: false,
    title: "Samurai Agent",
    webPreferences: {
      preload: preloadPath,
      additionalArguments: [`--samurai-api-base-url=${config.apiBaseUrl}`],
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });
  mainWindow.on("close", (event) => {
    if (isQuitting) {
      return;
    }
    event.preventDefault();
    mainWindow?.hide();
  });
  mainWindow.on("closed", () => {
    mainWindow = undefined;
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternalUrl(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!isAllowedMainNavigation(url, config)) {
      event.preventDefault();
      openExternalUrl(url);
    }
  });

  await loadMainWindow();
  updateTrayMenu();
}

async function loadMainWindow(): Promise<void> {
  if (!mainWindow) {
    return;
  }
  const loadToken = ++mainWindowLoadToken;
  latestHealth = await probeHealth(config);
  updateTrayMenu();
  if (!latestHealth.ok) {
    await showMainWindowStatusPage({
      title: "Serverに接続できません",
      message: serverOfflineMessage(config),
      detail: latestHealth.detail ?? latestHealth.message,
      loadToken
    });
    return;
  }

  if (config.mode === "packaged") {
    if (!existsSync(config.packagedWebEntryPath)) {
      await showMainWindowStatusPage({
        title: "Web UI buildが見つかりません",
        message: "packaged modeでは、Desktop Shellが既存Web UIのbuildを読み込みます。先にWeb buildを作成してください。",
        detail: config.packagedWebEntryPath,
        loadToken
      });
      return;
    }
    const loaded = await loadMainWindowUrl(pathToFileURL(config.packagedWebEntryPath).toString(), loadToken);
    if (!loaded) {
      return;
    }
  } else {
    const loaded = await loadMainWindowUrl(config.webDevUrl, loadToken);
    if (!loaded) {
      return;
    }
  }

  if (loadToken === mainWindowLoadToken && pendingDeepLink) {
    void routeDeepLinkToRenderer(pendingDeepLink);
    pendingDeepLink = undefined;
  }
}

async function loadMainWindowUrl(url: string, loadToken: number): Promise<boolean> {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return false;
  }
  try {
    await mainWindow.loadURL(url);
    return true;
  } catch (error) {
    if (loadToken !== mainWindowLoadToken || isNavigationAborted(error)) {
      return false;
    }
    await showMainWindowStatusPage({
      title: config.mode === "development" ? "Web UIに接続できません" : "Web UIを読み込めません",
      message: webUiUnavailableMessage(config),
      detail: loadFailureDetail(error, url),
      loadToken
    });
    return false;
  }
}

async function showMainWindowStatusPage(input: {
  title: string;
  message: string;
  detail?: string;
  loadToken: number;
}): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed() || input.loadToken !== mainWindowLoadToken) {
    return;
  }
  try {
    await mainWindow.loadURL(dataUrl(statusPageHtml({
      title: input.title,
      message: input.message,
      detail: input.detail,
      config
    })));
  } catch (error) {
    if (!isNavigationAborted(error)) {
      console.error("Failed to load Desktop status page:", error);
    }
  }
}

function createTray(): void {
  const icon = nativeImage.createFromDataURL("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAGklEQVR4AWP4//8/AyUYTFhYGJqaooABBgAE2wQCP81r+QAAAABJRU5ErkJggg==");
  tray = new Tray(icon);
  tray.setToolTip("Samurai Agent");
  updateTrayMenu();
}

function updateTrayMenu(): void {
  if (!tray) {
    return;
  }
  const statusLabel = latestHealth.ok ? "Status: Connected" : "Status: Offline";
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: statusLabel, enabled: false },
    { type: "separator" },
    { label: "Open Samurai", click: () => showMainWindow() },
    { label: "Quick Ask", accelerator: config.quickAskShortcut, click: () => openQuickAsk() },
    { label: "Ask Clipboard Text", accelerator: config.clipboardAskShortcut, click: () => openClipboardAsk() },
    { label: "Ask Selected Text", accelerator: config.selectionAskShortcut, click: () => void openSelectionAsk() },
    { label: "AppShot", accelerator: config.appShotShortcut, click: () => void openAppShot() },
    { label: "Reload", click: () => void loadMainWindow() },
    { type: "separator" },
    { label: "Quit", role: "quit" }
  ]));
}

function registerShortcuts(): void {
  globalShortcut.register(config.windowToggleShortcut, () => {
    if (!mainWindow) {
      void createMainWindow();
      return;
    }
    if (mainWindow.isVisible()) {
      mainWindow.hide();
    } else {
      showMainWindow();
    }
  });
  globalShortcut.register(config.quickAskShortcut, () => {
    openQuickAsk();
  });
  globalShortcut.register(config.clipboardAskShortcut, () => {
    openClipboardAsk();
  });
  globalShortcut.register(config.selectionAskShortcut, () => {
    void openSelectionAsk();
  });
  globalShortcut.register(config.appShotShortcut, () => {
    void openAppShot();
  });
}

function registerProtocolHandler(): void {
  if (process.defaultApp && process.argv.length >= 2 && process.argv[1]) {
    app.setAsDefaultProtocolClient("samurai", process.execPath, [process.argv[1]]);
    return;
  }
  app.setAsDefaultProtocolClient("samurai");
}

function registerIpcHandlers(): void {
  ipcMain.handle("samurai:get-status", async () => ({
    config: {
      mode: config.mode,
      apiBaseUrl: config.apiBaseUrl,
      webDevUrl: config.webDevUrl
    },
    health: latestHealth
  }));
  ipcMain.handle("samurai:window:open", () => {
    showMainWindow();
  });
  ipcMain.handle("samurai:window:reload", async () => {
    await loadMainWindow();
  });
  ipcMain.handle("samurai:app:quit", () => {
    isQuitting = true;
    app.quit();
  });
  ipcMain.handle("samurai:quick-ask:close", () => {
    quickAskWindow?.close();
  });
  ipcMain.handle("samurai:app-shot:close", () => {
    appShotWindow?.close();
  });
  ipcMain.handle("samurai:quick-ask:submit", async (_event, input: unknown): Promise<QuickAskResult> => {
    const quickAsk = validateQuickAskInput(input);
    return await submitQuickAsk(quickAsk, config);
  });
  ipcMain.handle("samurai:app-shot:submit", async (_event, input: unknown): Promise<AppShotResult> => {
    const appShot = validateAppShotInput(input);
    return await submitAppShot(appShot, config);
  });
}

function openQuickAsk(input: { initialContent?: string; statusText?: string; sourceFeature?: QuickAskInput["sourceFeature"] } = {}): void {
  if (quickAskWindow) {
    if (shouldRefreshQuickAsk(input)) {
      void quickAskWindow.loadURL(dataUrl(quickAskHtml(input)));
    }
    quickAskWindow.show();
    quickAskWindow.focus();
    return;
  }
  quickAskWindow = new BrowserWindow({
    width: 540,
    height: 320,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: "Quick Ask",
    show: false,
    webPreferences: {
      preload: preloadPath,
      additionalArguments: [`--samurai-api-base-url=${config.apiBaseUrl}`],
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  quickAskWindow.setMenuBarVisibility(false);
  quickAskWindow.once("ready-to-show", () => {
    quickAskWindow?.show();
    quickAskWindow?.focus();
  });
  quickAskWindow.on("closed", () => {
    quickAskWindow = undefined;
  });
  applyDataWindowNavigationPolicy(quickAskWindow);
  void quickAskWindow.loadURL(dataUrl(quickAskHtml(input)));
}

function shouldRefreshQuickAsk(input: { initialContent?: string; statusText?: string; sourceFeature?: QuickAskInput["sourceFeature"] }): boolean {
  return typeof input.initialContent === "string"
    || typeof input.statusText === "string"
    || Boolean(input.sourceFeature && input.sourceFeature !== "quick_ask");
}

function openClipboardAsk(): void {
  const value = clipboard.readText().trim();
  openQuickAsk({
    initialContent: value.slice(0, 8000),
    sourceFeature: value ? "clipboard_text" : "quick_ask",
    statusText: value
      ? "Clipboardの内容です。送信前に確認できます。"
      : "Clipboardにテキストがありません。"
  });
}

async function openSelectionAsk(): Promise<void> {
  const value = await readSelectedTextFromMainWindow();
  openQuickAsk({
    initialContent: value.slice(0, 8000),
    sourceFeature: value ? "selected_text" : "quick_ask",
    statusText: value
      ? "選択中のテキストです。送信前に確認できます。"
      : "Desktop内で選択中のテキストがありません。"
  });
}

async function readSelectedTextFromMainWindow(): Promise<string> {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return "";
  }
  try {
    const value = await mainWindow.webContents.executeJavaScript(
      "String(window.getSelection?.().toString() ?? '')",
      true
    );
    return typeof value === "string" ? value.trim() : "";
  } catch {
    return "";
  }
}

async function openAppShot(): Promise<void> {
  if (appShotWindow) {
    appShotWindow.show();
    appShotWindow.focus();
    return;
  }
  temporaryContextItems.clear();
  const window = new BrowserWindow({
    width: 860,
    height: 680,
    minWidth: 720,
    minHeight: 560,
    title: "AppShot",
    show: false,
    webPreferences: {
      preload: preloadPath,
      additionalArguments: [`--samurai-api-base-url=${config.apiBaseUrl}`],
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  appShotWindow = window;
  window.setMenuBarVisibility(false);
  window.once("ready-to-show", () => {
    window.show();
    window.focus();
  });
  window.on("closed", () => {
    appShotWindow = undefined;
    temporaryContextItems.clear();
  });
  applyDataWindowNavigationPolicy(window);

  try {
    const sources = await listAppShotSources();
    if (!window.isDestroyed()) {
      await window.loadURL(dataUrl(appShotHtml({
        sources,
        error: sources.length === 0 ? appShotEmptySourcesMessage() : undefined
      })));
    }
  } catch (error) {
    if (!window.isDestroyed()) {
      await window.loadURL(dataUrl(appShotHtml({
        sources: [],
        error: appShotPermissionMessage(error)
      })));
    }
  }
}

function applyDataWindowNavigationPolicy(window: BrowserWindow): void {
  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternalUrl(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    event.preventDefault();
    openExternalUrl(url);
  });
}

async function listAppShotSources(): Promise<Array<{ id: string; name: string; thumbnailDataUrl: string }>> {
  cleanupTemporaryContextItems();
  const sources = await desktopCapturer.getSources({
    types: ["screen", "window"],
    thumbnailSize: { width: 1440, height: 900 },
    fetchWindowIcons: false
  });
  const now = Date.now();
  return sources.flatMap((source, index) => {
    if (source.thumbnail.isEmpty()) {
      return [];
    }
    const dataUrlValue = source.thumbnail.toDataURL();
    if (!dataUrlValue.startsWith("data:image/png;base64,")) {
      return [];
    }
    const item = createTemporaryContextItem({
      id: `desktop_source_${now}_${index}`,
      sourceName: source.name || "Desktop screen",
      dataUrlValue,
      createdAtMs: now
    });
    temporaryContextItems.set(item.id, item);
    return [{
      id: item.id,
      name: item.sourceName,
      thumbnailDataUrl: item.dataUrl
    }];
  });
}

async function submitAppShot(input: AppShotInput, inputConfig: DesktopConfig): Promise<AppShotResult> {
  cleanupTemporaryContextItems();
  const item = temporaryContextItems.get(input.sourceId);
  if (!item) {
    throw new Error("スクショの一時Contextが見つかりません。もう一度AppShotを開いてください。");
  }
  if (Date.parse(item.expiresAt) <= Date.now()) {
    temporaryContextItems.delete(item.id);
    throw new Error("スクショの一時Contextが期限切れです。もう一度AppShotを開いてください。");
  }
  const health = await probeHealth(inputConfig);
  latestHealth = health;
  updateTrayMenu();
  if (!health.ok) {
    throw new Error(serverOfflineMessage(inputConfig));
  }
  const temporaryContext = await apiRequest<TemporaryContextResponse>(inputConfig, "/api/temporary-context", {
    method: "POST",
    body: JSON.stringify({
      kind: item.kind,
      label: item.label,
      source_name: item.sourceName,
      data_url: item.dataUrl,
      metadata: {
        source_client_kind: "desktop",
        source_client_feature: "app_shot"
      }
    })
  });
  const session = await apiRequest<{ id: string }>(inputConfig, "/api/chat/sessions", {
    method: "POST",
    body: JSON.stringify({
      title: draftSessionTitle(input.content),
      ui_locale: "ja",
      output_locale: "ja"
    })
  });
  const envelope = await apiRequest<{ result?: { session?: { id?: string } } }>(inputConfig, "/api/surface/operations", {
    method: "POST",
    body: JSON.stringify({
      id: `desktop_app_shot_${Date.now()}`,
      kind: "message.submit",
      session_id: session.id,
      content: input.content,
      input_locale: "ja",
      output_locale: "ja",
      attachments: [temporaryContextResourceRef(temporaryContext)],
      metadata: {
        source_client_kind: "desktop",
        source_client_feature: "app_shot",
        app_shot_source_name: item.sourceName,
        temporary_context_expires_at: temporaryContext.expires_at
      }
    })
  });
  temporaryContextItems.delete(item.id);
  return {
    sessionId: envelope.result?.session?.id ?? session.id,
    temporaryContextItemId: temporaryContext.id
  };
}

function validateAppShotInput(input: unknown): AppShotInput {
  if (!input || typeof input !== "object" || !("sourceId" in input) || typeof input.sourceId !== "string" || !("content" in input) || typeof input.content !== "string") {
    throw new Error("入力内容が空です。");
  }
  const sourceId = input.sourceId.trim();
  const content = input.content.trim();
  if (!sourceId) {
    throw new Error("共有する画面を選んでください。");
  }
  if (!content) {
    throw new Error("入力内容が空です。");
  }
  if (content.length > 2000) {
    throw new Error("入力が長すぎます。");
  }
  return { sourceId, content };
}

function createTemporaryContextItem(input: {
  id: string;
  sourceName: string;
  dataUrlValue: string;
  createdAtMs: number;
}): TemporaryContextItem {
  const createdAt = new Date(input.createdAtMs).toISOString();
  return {
    id: input.id,
    kind: "desktop_screenshot",
    label: `AppShot: ${input.sourceName}`,
    sourceName: input.sourceName,
    mimeType: "image/png",
    dataUrl: input.dataUrlValue,
    createdAt,
    expiresAt: new Date(input.createdAtMs + temporaryContextTtlMs).toISOString()
  };
}

function temporaryContextResourceRef(input: TemporaryContextResponse): { kind: string; id: string; uri: string; label: string } {
  return {
    kind: input.kind,
    id: input.id,
    uri: input.uri,
    label: input.label
  };
}

function cleanupTemporaryContextItems(now = Date.now()): void {
  for (const [id, item] of temporaryContextItems) {
    if (Date.parse(item.expiresAt) <= now) {
      temporaryContextItems.delete(id);
    }
  }
}

function appShotPermissionMessage(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `画面を取得できませんでした。macOSの画面収録権限を確認してください。${detail ? ` (${detail})` : ""}`;
}

function appShotEmptySourcesMessage(): string {
  return "共有できる画面が見つかりません。macOSの画面収録権限を確認してから、もう一度AppShotを開いてください。";
}

function showMainWindow(): void {
  if (!mainWindow) {
    void createMainWindow();
    return;
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();
}

function handleDeepLink(url: string): void {
  if (!mainWindow) {
    pendingDeepLink = url;
    void createMainWindow();
    return;
  }
  pendingDeepLink = undefined;
  showMainWindow();
  void routeDeepLinkToRenderer(url);
}

async function routeDeepLinkToRenderer(url: string): Promise<void> {
  if (!mainWindow) {
    pendingDeepLink = url;
    return;
  }
  const target = parseDeepLink(url);
  if (!target) {
    await mainWindow.loadURL(dataUrl(statusPageHtml({
      title: "Deep Linkを開けません",
      message: "このリンク形式には対応していません。workspace、session、artifact、run、quick-ask のリンクだけ開けます。",
      detail: url,
      config
    })));
    return;
  }
  if (target.kind === "quick-ask") {
    openQuickAsk();
    return;
  }
  if (!latestHealth.ok) {
    pendingDeepLink = url;
    await loadMainWindow();
    return;
  }
  const availability = await checkDeepLinkTargetAvailability(target, config);
  if (!availability.ok) {
    await mainWindow.loadURL(dataUrl(statusPageHtml({
      title: "Deep Linkの対象が見つかりません",
      message: "リンク形式は正しいですが、指定されたWorkspace上の対象を確認できませんでした。",
      detail: availability.detail ?? url,
      config
    })));
    return;
  }
  const hash = target.id ? `#/${target.kind}/${encodeURIComponent(target.id)}` : `#/${target.kind}`;
  if (config.mode === "packaged" && latestHealth.ok && existsSync(config.packagedWebEntryPath)) {
    await mainWindow.loadURL(`${pathToFileURL(config.packagedWebEntryPath).toString()}${hash}`);
    return;
  }
  if (latestHealth.ok) {
    await mainWindow.loadURL(`${config.webDevUrl}/${hash}`);
  }
}

function parseDeepLink(url: string): DeepLinkTarget | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "samurai:") {
      return undefined;
    }
    const kind = parsed.hostname || parsed.pathname.replace(/^\//, "");
    const pathParts = parsed.pathname.split("/").filter(Boolean);
    if (kind === "workspace") {
      return { kind: "workspace" };
    }
    if (kind === "quick-ask") {
      return { kind: "quick-ask" };
    }
    if ((kind === "session" || kind === "artifact" || kind === "run") && pathParts[0]) {
      return { kind, id: pathParts[0] };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

async function checkDeepLinkTargetAvailability(
  target: DeepLinkTarget,
  inputConfig: DesktopConfig
): Promise<{ ok: true } | { ok: false; detail?: string }> {
  if (target.kind === "workspace" || target.kind === "quick-ask") {
    return { ok: true };
  }
  if (!target.id) {
    return { ok: false, detail: `${target.kind} id is missing.` };
  }
  const path = target.kind === "session"
    ? `/api/chat/sessions/${encodeURIComponent(target.id)}`
    : target.kind === "artifact"
      ? `/api/artifacts/${encodeURIComponent(target.id)}`
      : `/api/backend-runs/${encodeURIComponent(target.id)}`;
  try {
    await apiRequest<unknown>(inputConfig, path, { method: "GET" });
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : String(error)
    };
  }
}

async function submitQuickAsk(input: QuickAskInput, inputConfig: DesktopConfig): Promise<QuickAskResult> {
  const health = await probeHealth(inputConfig);
  latestHealth = health;
  updateTrayMenu();
  if (!health.ok) {
    throw new Error(serverOfflineMessage(inputConfig));
  }
  const session = await apiRequest<{ id: string }>(inputConfig, "/api/chat/sessions", {
    method: "POST",
    body: JSON.stringify({
      title: draftSessionTitle(input.content),
      ui_locale: "ja",
      output_locale: "ja"
    })
  });
  const envelope = await apiRequest<{ result?: { session?: { id?: string } } }>(inputConfig, "/api/surface/operations", {
    method: "POST",
    body: JSON.stringify({
      id: `desktop_quick_ask_${Date.now()}`,
      kind: "message.submit",
      session_id: session.id,
      content: input.content,
      input_locale: "ja",
      output_locale: "ja",
      metadata: {
        source_client_kind: "desktop",
        source_client_feature: input.sourceFeature
      }
    })
  });
  return { sessionId: envelope.result?.session?.id ?? session.id };
}

function startClientEventPolling(): void {
  if (clientEventPollTimer) {
    return;
  }
  void pollClientEvents();
  clientEventPollTimer = setInterval(() => {
    void pollClientEvents();
  }, clientEventPollIntervalMs);
  clientEventPollTimer.unref?.();
}

async function pollClientEvents(): Promise<void> {
  if (clientEventPollInFlight) {
    return;
  }
  clientEventPollInFlight = true;
  try {
    const events = await apiRequest<ClientEventRecord[]>(
      config,
      "/api/client-events?target_client_kind=desktop&status=pending&limit=20",
      { method: "GET" }
    );
    for (const event of events) {
      await handleClientEvent(event);
    }
  } catch {
    // Server may be offline while Desktop is resident; health UI already covers reconnection.
  } finally {
    clientEventPollInFlight = false;
  }
}

async function handleClientEvent(event: ClientEventRecord): Promise<void> {
  await markClientEventDelivered(event.id);
  try {
    if (event.event_type === "client.notification.requested") {
      showClientNotification(event);
    } else if (event.event_type === "client.status.refresh_requested") {
      await loadMainWindow();
    } else {
      const link = deepLinkForClientEvent(event);
      if (link) {
        handleDeepLink(link);
      } else {
        showMainWindow();
      }
    }
    await ackClientEvent(event.id);
  } catch (error) {
    await failClientEvent(event.id, errorCode(error));
  }
}

async function markClientEventDelivered(eventId: string): Promise<void> {
  await apiRequest<ClientEventRecord>(config, `/api/client-events/${encodeURIComponent(eventId)}/deliver`, { method: "POST" });
}

async function ackClientEvent(eventId: string): Promise<void> {
  await apiRequest<ClientEventRecord>(config, `/api/client-events/${encodeURIComponent(eventId)}/ack`, { method: "POST" });
}

async function failClientEvent(eventId: string, code: string): Promise<void> {
  await apiRequest<ClientEventRecord>(config, `/api/client-events/${encodeURIComponent(eventId)}/fail`, {
    method: "POST",
    body: JSON.stringify({ error_code: code })
  });
}

function showClientNotification(event: ClientEventRecord): void {
  if (!Notification.isSupported()) {
    throw new Error("notification_unsupported");
  }
  const notification = new Notification({
    title: payloadString(event, "title") ?? "Samurai Agent",
    body: payloadString(event, "body") ?? "新しい更新があります。"
  });
  notification.on("click", () => {
    const link = deepLinkForClientEvent(event);
    if (link) {
      handleDeepLink(link);
      return;
    }
    showMainWindow();
  });
  notification.show();
}

function deepLinkForClientEvent(event: ClientEventRecord): string | undefined {
  const explicit = payloadString(event, "deep_link");
  if (explicit?.startsWith("samurai://")) {
    return explicit;
  }
  if (event.event_type === "client.workspace.open_requested") {
    return "samurai://workspace";
  }
  if (event.event_type === "client.session.open_requested") {
    const id = payloadString(event, "session_id") ?? firstResourceId(event, "session");
    return id ? `samurai://session/${encodeURIComponent(id)}` : undefined;
  }
  if (event.event_type === "client.artifact.open_requested") {
    const id = payloadString(event, "artifact_id") ?? firstResourceId(event, "artifact");
    return id ? `samurai://artifact/${encodeURIComponent(id)}` : undefined;
  }
  if (event.event_type === "client.run.open_requested" || event.event_type === "client.notification.requested") {
    const id = payloadString(event, "run_id") ?? firstResourceId(event, "backend_run");
    return id ? `samurai://run/${encodeURIComponent(id)}` : undefined;
  }
  return undefined;
}

function payloadString(event: ClientEventRecord, key: string): string | undefined {
  const value = event.payload[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function firstResourceId(event: ClientEventRecord, kind: string): string | undefined {
  return event.resource_refs.find((ref) => ref.kind === kind)?.id;
}

function errorCode(error: unknown): string {
  if (!(error instanceof Error)) {
    return "client_event_failed";
  }
  return error.message.replace(/[^a-zA-Z0-9_:-]/g, "_").slice(0, 80) || "client_event_failed";
}

async function probeHealth(inputConfig: DesktopConfig): Promise<HealthState> {
  try {
    const response = await fetch(inputConfig.apiHealthUrl, { signal: AbortSignal.timeout(1500) });
    const body = await response.json() as { ok?: boolean; db?: { ok?: boolean; reason?: string } };
    if (response.ok && body.ok === true && body.db?.ok !== false) {
      return {
        ok: true,
        message: "Connected",
        checkedAt: new Date().toISOString()
      };
    }
    return {
      ok: false,
      message: "Health check failed",
      detail: JSON.stringify(body, null, 2),
      checkedAt: new Date().toISOString()
    };
  } catch (error) {
    return {
      ok: false,
      message: "Health check failed",
      detail: error instanceof Error ? error.message : String(error),
      checkedAt: new Date().toISOString()
    };
  }
}

function serverOfflineMessage(inputConfig: DesktopConfig): string {
  if (inputConfig.mode === "packaged") {
    return "Samurai Agent Core / Server APIに接続できません。Coreの起動状態、またはSAMURAI_DESKTOP_API_URLの接続先を確認してください。";
  }
  return "Samurai AgentのAPIが起動していません。先に `pnpm run dev` でServerとWebを起動してください。";
}

function webUiUnavailableMessage(inputConfig: DesktopConfig): string {
  return inputConfig.mode === "development"
    ? "Web UIサーバーに接続できません。Vite dev serverが起動中か、再起動が完了するまで待ってからRetryしてください。"
    : "同梱されたWeb UIを読み込めません。buildファイルとDesktop Shellの設定を確認してください。";
}

function loadFailureDetail(error: unknown, url: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return `${url}\n${message}`;
}

function isNavigationAborted(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const candidate = error as { code?: unknown; errno?: unknown };
  return candidate.code === "ERR_ABORTED" || candidate.errno === -3;
}

async function apiRequest<T>(inputConfig: DesktopConfig, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${inputConfig.apiBaseUrl}${path}`, {
    headers: {
      "Content-Type": "application/json",
      ...(init.headers ?? {})
    },
    ...init
  });
  const body = await response.json().catch(() => undefined);
  if (!response.ok) {
    throw new Error(typeof body === "object" && body && "error" in body ? String(body.error) : `${response.status} ${response.statusText}`);
  }
  return body as T;
}

function validateQuickAskInput(input: unknown): QuickAskInput {
  if (!input || typeof input !== "object" || !("content" in input) || typeof input.content !== "string") {
    throw new Error("入力内容が空です。");
  }
  const content = input.content.trim();
  if (!content) {
    throw new Error("入力内容が空です。");
  }
  if (content.length > 8000) {
    throw new Error("入力が長すぎます。");
  }
  const rawSourceFeature = "sourceFeature" in input && typeof input.sourceFeature === "string" ? input.sourceFeature : "quick_ask";
  const sourceFeature = rawSourceFeature === "clipboard_text" || rawSourceFeature === "selected_text"
    ? rawSourceFeature
    : "quick_ask";
  return { content, sourceFeature };
}

function draftSessionTitle(content: string): string {
  const title = content.replace(/\s+/g, " ").trim();
  return title.length > 60 ? `${title.slice(0, 57)}...` : title || "Quick Ask";
}

function dataUrl(html: string): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function isAllowedMainNavigation(url: string, inputConfig: DesktopConfig): boolean {
  if (inputConfig.mode === "development" && isSameOrigin(url, inputConfig.webDevUrl)) {
    return true;
  }
  if (inputConfig.mode === "packaged" && isPackagedWebFileUrl(url, inputConfig)) {
    return true;
  }
  return false;
}

function isPackagedWebFileUrl(url: string, inputConfig: DesktopConfig): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "file:") {
      return false;
    }
    return isPathInside(
      path.dirname(inputConfig.packagedWebEntryPath),
      fileURLToPath(parsed)
    );
  } catch {
    return false;
  }
}

function isPathInside(parentPath: string, candidatePath: string): boolean {
  const relative = path.relative(path.resolve(parentPath), path.resolve(candidatePath));
  return relative === "" || (Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function isSameOrigin(url: string, allowedOriginUrl: string): boolean {
  try {
    return new URL(url).origin === new URL(allowedOriginUrl).origin;
  } catch {
    return false;
  }
}

function openExternalUrl(url: string): void {
  if (!isSafeExternalUrl(url)) {
    return;
  }
  void shell.openExternal(url);
}

function isSafeExternalUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return protocol === "http:" || protocol === "https:" || protocol === "mailto:";
  } catch {
    return false;
  }
}
