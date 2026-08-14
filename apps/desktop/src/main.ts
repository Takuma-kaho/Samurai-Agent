import { createHash, createPrivateKey, createPublicKey, randomUUID, sign } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  app,
  BrowserWindow,
  clipboard,
  desktopCapturer,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  safeStorage,
  shell,
  Tray,
  type MessageBoxOptions
} from "electron";
import { createDesktopConfig, type DesktopConfig } from "./config.js";
import { appShotHtml, quickAskHtml, statusPageHtml } from "./html.js";
import {
  activeWorkspaceConnection,
  loadWorkspaceConnectionRegistry,
  saveWorkspaceConnectionRegistry,
  selectWorkspaceConnection,
  upsertWorkspaceConnection,
  type WorkspaceConnection,
  type WorkspaceConnectionInput,
  type WorkspaceConnectionRegistry
} from "./workspace-connections.js";
import { createWorkspaceIdentityStore, type WorkspaceIdentityStore } from "./workspace-identities.js";
import { createWorkspaceAccountSignaturePayload, workspaceAccountIdFromPublicKey } from "./workspace-request-signing.js";

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

type DeepLinkTarget =
  | { kind: "workspace" | "session" | "artifact" | "run" | "quick-ask"; id?: string }
  | { kind: "workspace-invite"; serverUrl: string; workspaceId: string; token: string };

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
let workspaceConnectionRegistry: WorkspaceConnectionRegistry = { version: 1, connections: [] };
let workspaceConnectionRegistryPath = "";
let workspaceIdentityStore: WorkspaceIdentityStore | undefined;

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
  await initializeWorkspaceConnections();
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
      additionalArguments: desktopArguments(config),
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
      webDevUrl: config.webDevUrl,
      workspaceServerUrl: config.workspaceServerUrl,
      workspaceId: config.workspaceId,
      accountId: config.accountId
    },
    workspaceConnections: publicWorkspaceConnections(),
    health: latestHealth
  }));
  ipcMain.handle("samurai:window:open", () => {
    showMainWindow();
  });
  ipcMain.handle("samurai:window:reload", async () => {
    await loadMainWindow();
  });
  ipcMain.handle("samurai:workspace-connections:list", () => publicWorkspaceConnections());
  ipcMain.handle("samurai:workspace-connections:upsert", async (_event, input: unknown) => {
    const submission = workspaceConnectionSubmission(input);
    let candidate = submission.connection;
    if (submission.privateKey) {
      const identity = requireWorkspaceIdentityStore();
      const publicKey = publicKeyFromPrivateKey(submission.privateKey);
      if (workspaceAccountIdFromPublicKey(publicKey) !== candidate.accountId) throw new Error("workspace_identity_account_mismatch");
      candidate = {
        ...candidate,
        credentialRef: await identity.save(candidate.accountId, submission.privateKey)
      };
    }
    workspaceConnectionRegistry = upsertWorkspaceConnection(workspaceConnectionRegistry, candidate);
    await saveWorkspaceConnectionRegistry(workspaceConnectionRegistryPath, workspaceConnectionRegistry);
    return publicWorkspaceConnections();
  });
  ipcMain.handle("samurai:workspace-connections:select", async (_event, connectionId: unknown) => {
    if (typeof connectionId !== "string") throw new Error("workspace_connection_not_found");
    workspaceConnectionRegistry = selectWorkspaceConnection(workspaceConnectionRegistry, connectionId);
    await saveWorkspaceConnectionRegistry(workspaceConnectionRegistryPath, workspaceConnectionRegistry);
    applyWorkspaceConnection(activeWorkspaceConnection(workspaceConnectionRegistry));
    return publicWorkspaceConnections();
  });
  ipcMain.handle("samurai:workspace-server:register-active-account", async (_event, displayName: unknown) => {
    const connection = requireActiveWorkspaceConnection();
    const privateKey = await requireActiveWorkspacePrivateKey(connection);
    const publicKey = publicKeyFromPrivateKey(privateKey);
    if (workspaceAccountIdFromPublicKey(publicKey) !== connection.accountId) throw new Error("workspace_identity_account_mismatch");
    const result = await signedWorkspaceServerRequest(connection, privateKey, {
      method: "POST",
      path: "/api/account/register",
      workspaceScoped: false,
      body: {
        account_id: connection.accountId,
        public_key: publicKey,
        display_name: typeof displayName === "string" && displayName.trim() ? displayName.trim().slice(0, 160) : "Samurai Account"
      }
    });
    if (result.status < 200 || result.status >= 300) throw new Error(`workspace_account_registration_failed:${result.status}`);
    return result.body;
  });
  ipcMain.handle("samurai:workspace-server:status", async () => workspaceServerStatus());
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

async function initializeWorkspaceConnections(): Promise<void> {
  workspaceConnectionRegistryPath = path.join(app.getPath("userData"), "workspace-connections.json");
  workspaceIdentityStore = createWorkspaceIdentityStore(path.join(app.getPath("userData"), "workspace-identities.json"), safeStorage);
  workspaceConnectionRegistry = await loadWorkspaceConnectionRegistry(workspaceConnectionRegistryPath);
  if (config.workspaceServerUrl && config.workspaceId && config.accountId) {
    const environmentConnection: WorkspaceConnectionInput = {
      label: "Environment",
      serverUrl: config.workspaceServerUrl,
      workspaceId: config.workspaceId,
      accountId: config.accountId
    };
    const hasEnvironmentConnection = workspaceConnectionRegistry.connections.some((connection) =>
      connection.serverUrl === config.workspaceServerUrl
      && connection.workspaceId === config.workspaceId
      && connection.accountId === config.accountId
    );
    if (!hasEnvironmentConnection) {
      workspaceConnectionRegistry = upsertWorkspaceConnection(workspaceConnectionRegistry, environmentConnection);
      await saveWorkspaceConnectionRegistry(workspaceConnectionRegistryPath, workspaceConnectionRegistry);
    }
  }
  applyWorkspaceConnection(activeWorkspaceConnection(workspaceConnectionRegistry));
}

function publicWorkspaceConnections(): {
  activeConnectionId?: string;
  connections: Array<Omit<WorkspaceConnection, "credentialRef">>;
} {
  return {
    ...(workspaceConnectionRegistry.activeConnectionId ? { activeConnectionId: workspaceConnectionRegistry.activeConnectionId } : {}),
    connections: workspaceConnectionRegistry.connections.map(({ credentialRef: _credentialRef, ...connection }) => connection)
  };
}

function workspaceConnectionSubmission(value: unknown): { connection: WorkspaceConnectionInput; privateKey?: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("workspace_connection_invalid");
  const input = value as Record<string, unknown>;
  const required = (key: string): string => {
    const field = input[key];
    if (typeof field !== "string" || !field.trim()) throw new Error("workspace_connection_invalid");
    return field.trim();
  };
  const optional = (key: string): string | undefined => {
    const field = input[key];
    if (field === undefined) return undefined;
    if (typeof field !== "string") throw new Error("workspace_connection_invalid");
    return field.trim() || undefined;
  };
  const privateKey = optional("privateKey");
  return {
    connection: {
    ...(optional("id") ? { id: optional("id") } : {}),
    label: required("label"),
    serverUrl: required("serverUrl"),
    workspaceId: required("workspaceId"),
    accountId: required("accountId"),
    ...(optional("credentialRef") ? { credentialRef: optional("credentialRef") } : {})
    },
    ...(privateKey ? { privateKey } : {})
  };
}

function applyWorkspaceConnection(connection: WorkspaceConnection | undefined): void {
  if (!connection) return;
  // Workspace Server is a separate boundary from the legacy Chat/Core API.
  // Selecting it must never silently redirect the Chat UI to an incompatible
  // endpoint; Server 02-specific clients consume these explicit values.
  config.workspaceServerUrl = connection.serverUrl;
  config.workspaceId = connection.workspaceId;
  config.accountId = connection.accountId;
}

interface WorkspaceServerRequestInput {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  body?: Record<string, unknown>;
  operationId?: string;
  workspaceScoped: boolean;
}

function requireWorkspaceIdentityStore(): WorkspaceIdentityStore {
  if (!workspaceIdentityStore) throw new Error("workspace_identity_store_unavailable");
  return workspaceIdentityStore;
}

function requireActiveWorkspaceConnection(): WorkspaceConnection {
  const connection = activeWorkspaceConnection(workspaceConnectionRegistry);
  if (!connection) throw new Error("workspace_connection_not_selected");
  return connection;
}

async function requireActiveWorkspacePrivateKey(connection: WorkspaceConnection): Promise<string> {
  if (!connection.credentialRef?.startsWith("electron-safe-storage://workspace-account/")) {
    throw new Error("workspace_identity_required");
  }
  const privateKey = await requireWorkspaceIdentityStore().load(connection.accountId);
  if (!privateKey) throw new Error("workspace_identity_required");
  return privateKey;
}

function publicKeyFromPrivateKey(privateKey: string): string {
  try {
    return createPublicKey(createPrivateKey(privateKey)).export({ format: "pem", type: "spki" }).toString();
  } catch {
    throw new Error("workspace_identity_private_key_invalid");
  }
}

async function signedWorkspaceServerRequest(
  connection: WorkspaceConnection,
  privateKey: string,
  input: WorkspaceServerRequestInput
): Promise<{ status: number; body: unknown }> {
  const url = new URL(input.path, `${connection.serverUrl}/`);
  const base = new URL(connection.serverUrl);
  if (url.origin !== base.origin || !url.pathname.startsWith("/api/")) throw new Error("workspace_server_request_origin_invalid");
  const requestId = `request_${randomUUID()}`;
  const timestamp = String(Date.now());
  const body = input.body ?? {};
  const signaturePayload = createWorkspaceAccountSignaturePayload({
    method: input.method,
    path: url.pathname,
    ...(input.workspaceScoped ? { workspaceId: connection.workspaceId } : {}),
    ...(input.operationId ? { operationId: input.operationId } : {}),
    requestId,
    timestamp,
    body
  });
  const signature = sign(null, Buffer.from(signaturePayload), createPrivateKey(privateKey)).toString("base64url");
  const response = await fetch(url, {
    method: input.method,
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
    headers: {
      "content-type": "application/json",
      "x-samurai-account-id": connection.accountId,
      "x-samurai-request-id": requestId,
      "x-samurai-timestamp": timestamp,
      "x-samurai-signature": signature,
      ...(input.workspaceScoped ? { "x-samurai-workspace-id": connection.workspaceId } : {}),
      ...(input.operationId ? { "x-samurai-operation-id": input.operationId } : {})
    },
    ...(input.method === "GET" || input.method === "DELETE" ? {} : { body: JSON.stringify(body) })
  });
  const text = await response.text();
  let responseBody: unknown = undefined;
  if (text) {
    try { responseBody = JSON.parse(text); } catch { responseBody = { error: "workspace_server_response_invalid" }; }
  }
  return { status: response.status, body: responseBody };
}

async function workspaceServerStatus(): Promise<{
  connection?: Omit<WorkspaceConnection, "credentialRef">;
  identityAvailable: boolean;
  health?: { status: number; body: unknown };
  workspace?: { status: number; body: unknown };
  rooms?: { status: number; body: unknown };
}> {
  const connection = activeWorkspaceConnection(workspaceConnectionRegistry);
  if (!connection) return { identityAvailable: false };
  let health: { status: number; body: unknown } | undefined;
  try {
    const response = await fetch(new URL("/api/health", `${connection.serverUrl}/`), { redirect: "error", signal: AbortSignal.timeout(8_000) });
    const text = await response.text();
    health = { status: response.status, body: text ? JSON.parse(text) : undefined };
  } catch {
    health = { status: 0, body: { error: "workspace_server_unreachable" } };
  }
  const identityAvailable = Boolean(connection.credentialRef && await requireWorkspaceIdentityStore().has(connection.accountId));
  if (!identityAvailable) {
    const { credentialRef: _credentialRef, ...publicConnection } = connection;
    return { connection: publicConnection, identityAvailable, health };
  }
  try {
    const privateKey = await requireActiveWorkspacePrivateKey(connection);
    const workspace = await signedWorkspaceServerRequest(connection, privateKey, {
      method: "GET",
      path: `/api/workspaces/${encodeURIComponent(connection.workspaceId)}`,
      workspaceScoped: true
    });
    const rooms = workspace.status >= 200 && workspace.status < 300
      ? await signedWorkspaceServerRequest(connection, privateKey, {
        method: "GET",
        path: `/api/workspaces/${encodeURIComponent(connection.workspaceId)}/rooms`,
        workspaceScoped: true
      })
      : undefined;
    const { credentialRef: _credentialRef, ...publicConnection } = connection;
    return { connection: publicConnection, identityAvailable, health, workspace, ...(rooms ? { rooms } : {}) };
  } catch (error) {
    const { credentialRef: _credentialRef, ...publicConnection } = connection;
    return { connection: publicConnection, identityAvailable, health, workspace: { status: 0, body: { error: error instanceof Error ? error.message : "workspace_server_request_failed" } } };
  }
}

function desktopArguments(input: DesktopConfig): string[] {
  return [
    `--samurai-api-base-url=${input.apiBaseUrl}`,
    ...(input.workspaceServerUrl ? [`--samurai-workspace-server-url=${input.workspaceServerUrl}`] : []),
    ...(input.workspaceId ? [`--samurai-workspace-id=${input.workspaceId}`] : []),
    ...(input.accountId ? [`--samurai-account-id=${input.accountId}`] : [])
  ];
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
      additionalArguments: desktopArguments(config),
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
      additionalArguments: desktopArguments(config),
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
  if (target.kind === "workspace-invite") {
    await acceptWorkspaceInvitation(target);
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
    if (kind === "workspace-invite") {
      const serverUrl = normalizeInvitationServerUrl(parsed.searchParams.get("server"));
      const workspaceId = parsed.searchParams.get("workspace_id")?.trim();
      const token = parsed.searchParams.get("token")?.trim();
      if (!serverUrl || !workspaceId || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(workspaceId) || !token || token.length > 512) {
        return undefined;
      }
      return { kind: "workspace-invite", serverUrl, workspaceId, token };
    }
    if ((kind === "session" || kind === "artifact" || kind === "run") && pathParts[0]) {
      return { kind, id: pathParts[0] };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

async function acceptWorkspaceInvitation(target: Extract<DeepLinkTarget, { kind: "workspace-invite" }>): Promise<void> {
  try {
    const active = requireActiveWorkspaceConnection();
    const privateKey = await requireActiveWorkspacePrivateKey(active);
    const publicKey = publicKeyFromPrivateKey(privateKey);
    if (workspaceAccountIdFromPublicKey(publicKey) !== active.accountId) throw new Error("workspace_identity_account_mismatch");
    const confirmation = await showWorkspaceInvitationDialog({
      type: "question",
      buttons: ["参加する", "キャンセル"],
      defaultId: 0,
      cancelId: 1,
      title: "Workspaceへの招待",
      message: "このWorkspaceに参加しますか？",
      detail: `${target.serverUrl}\n${target.workspaceId}`
    });
    if (confirmation.response !== 0) return;
    const proposed = upsertWorkspaceConnection(workspaceConnectionRegistry, {
      label: `招待: ${target.workspaceId}`,
      serverUrl: target.serverUrl,
      workspaceId: target.workspaceId,
      accountId: active.accountId,
      ...(active.credentialRef ? { credentialRef: active.credentialRef } : {})
    });
    const connection = proposed.connections.find((item) =>
      item.serverUrl === target.serverUrl && item.workspaceId === target.workspaceId && item.accountId === active.accountId
    );
    if (!connection) throw new Error("workspace_invitation_connection_invalid");
    const registered = await signedWorkspaceServerRequest(connection, privateKey, {
      method: "POST",
      path: "/api/account/register",
      workspaceScoped: false,
      body: { account_id: connection.accountId, public_key: publicKey, display_name: "Samurai Account" }
    });
    if (registered.status < 200 || registered.status >= 300) throw new Error(`workspace_account_registration_failed:${registered.status}`);
    const accepted = await signedWorkspaceServerRequest(connection, privateKey, {
      method: "POST",
      path: `/api/workspaces/${encodeURIComponent(connection.workspaceId)}/invitations/accept`,
      workspaceScoped: true,
      // The same link retried by the same Account must replay its original
      // acceptance result if the network failed after the server committed.
      operationId: invitationAcceptanceOperationId(connection, target.token),
      body: { invite_token: target.token }
    });
    if (accepted.status < 200 || accepted.status >= 300) throw new Error(`workspace_invitation_acceptance_failed:${accepted.status}`);
    workspaceConnectionRegistry = selectWorkspaceConnection(proposed, connection.id);
    await saveWorkspaceConnectionRegistry(workspaceConnectionRegistryPath, workspaceConnectionRegistry);
    applyWorkspaceConnection(connection);
    await showWorkspaceInvitationDialog({
      type: "info",
      message: "Workspaceに参加しました。",
      detail: target.workspaceId
    });
  } catch (error) {
    await showWorkspaceInvitationDialog({
      type: "error",
      title: "招待に参加できません",
      message: "接続先と本人情報を確認して、もう一度リンクを開いてください。",
      detail: error instanceof Error ? error.message : "workspace_invitation_failed"
    });
  }
}

function invitationAcceptanceOperationId(connection: Pick<WorkspaceConnection, "serverUrl" | "workspaceId" | "accountId">, token: string): string {
  const fingerprint = createHash("sha256")
    .update(`${connection.serverUrl}\n${connection.workspaceId}\n${connection.accountId}\n${token}`)
    .digest("hex");
  return `invite_accept_${fingerprint.slice(0, 40)}`;
}

async function showWorkspaceInvitationDialog(options: MessageBoxOptions) {
  return mainWindow
    ? dialog.showMessageBox(mainWindow, options)
    : dialog.showMessageBox(options);
}

function normalizeInvitationServerUrl(value: string | null): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1" || url.hostname === "[::1]";
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash
      || (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))) {
      return undefined;
    }
    return url.toString().replace(/\/$/, "");
  } catch {
    return undefined;
  }
}

async function checkDeepLinkTargetAvailability(
  target: DeepLinkTarget,
  inputConfig: DesktopConfig
): Promise<{ ok: true } | { ok: false; detail?: string }> {
  if (target.kind === "workspace" || target.kind === "quick-ask") {
    return { ok: true };
  }
  if (target.kind === "workspace-invite") {
    return { ok: false, detail: "Invitation links are handled before legacy Core navigation." };
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
