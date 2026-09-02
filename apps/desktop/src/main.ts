import { createHash, createPrivateKey, createPublicKey, randomUUID, sign } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { io, type Socket } from "socket.io-client";
import { DomainApiClient, type DomainApiTransportRequest, type PublicRoomRecord } from "@samurai-agent/domain-api";
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
import {
  requiredWorkspaceOpaqueField,
  workspaceRoomCreateRequest,
  workspaceRoomMemberPreviewRequest,
  workspaceRoomMemberRequest,
  workspaceRoomMovePreviewRequest,
  workspaceRoomMoveRequest
} from "./workspace-room-requests.js";
import {
  workspaceLearningSettingsRequest
} from "./workspace-learning-requests.js";
import { workspaceSettingsPatchJson, workspaceSettingsPatchRequest } from "./workspace-settings-requests.js";
import {
  workspaceCompletionResourceCreateRequest,
  workspaceCompletionResourceIdRequest,
  workspaceCompletionResourceListRequest,
  workspaceCompletionResourceStateRequest,
  workspaceCompletionResourceUpdateRequest,
  workspaceCompletionSearchRequest,
  workspaceWikiCreateRequest,
  workspaceWikiIdRequest,
  workspaceWikiListRequest,
  workspaceWikiPatchRequest,
  workspaceWikiQueryRequest,
  workspaceWikiStateRequest
} from "./workspace-completion-requests.js";
import {
  workspaceCollectionIdRequest,
  workspaceCollectionRecordCreateRequest,
  workspaceCollectionRecordDeleteRequest,
  workspaceCollectionRecordPatchRequest,
  workspaceCollectionRoomRequest,
  workspaceCollectionSchemaSaveRequest,
  workspaceCollectionSurfaceOperationRequest
} from "./workspace-collection-requests.js";
import {
  workspaceChatSessionIdRequest,
  workspaceChatSessionRequest,
  workspaceChatTurnRequest
} from "./workspace-chat-requests.js";
import { workspaceChatReconnectRequest, workspaceChatRunControlRequest } from "./workspace-chat-control-requests.js";
import {
  workspaceEvidenceRequest,
  workspaceOrganizationBundleExportRequest,
  workspaceOrganizationBundleRestoreRequest,
  workspaceOrganizationCreateRequest,
  workspaceOrganizationDeleteRequest,
  workspaceOrganizationInvitationAcceptRequest,
  workspaceOrganizationInvitationCreateRequest,
  workspaceOrganizationInvitationExtendRequest,
  workspaceOrganizationInvitationReissueRequest,
  workspaceOrganizationInvitationRevokeRequest,
  workspaceOrganizationInvitationsRequest,
  workspaceOrganizationMemberLeaveRequest,
  workspaceOrganizationMemberRemoveRequest,
  workspaceOrganizationMemberRoleRequest,
  workspaceOrganizationMembersRequest,
  workspaceOrganizationPatchRequest,
  workspaceOrganizationViewRequest,
  workspaceOrganizationWorkspaceCreateRequest,
  workspaceOrganizationWorkspaceLifecycleRequest,
  workspaceOrganizationWorkspaceMemberGrantRequest,
  workspaceOrganizationWorkspaceMemberRevokeRequest,
  workspaceOrganizationWorkspaceMovePreviewRequest,
  workspaceOrganizationWorkspaceMoveStatusRequest,
  workspaceOrganizationWorkspaceMoveRequest,
  workspaceOrganizationWorkspacePatchRequest,
  workspaceOrganizationWorkspacesRequest,
  workspaceOrganizationListRequest,
  workspaceSelectionRoomsRequest,
  workspaceSelectionWorkspaceViewRequest
} from "./workspace-organization-requests.js";
import { workspaceAttachmentRequest } from "./workspace-attachment-requests.js";
import {
  workspaceMemoryArchiveRequest,
  workspaceMemoryIdRequest,
  workspaceMemoryListRequest,
  workspaceMemorySearchRequest
} from "./workspace-memory-requests.js";
import {
  workspaceAutomationJobCreateRequest,
  workspaceAutomationJobIdRequest,
  workspaceAutomationListRequest,
  workspaceAutomationManagementRequest,
  workspaceAutomationRunNowRequest
} from "./workspace-automation-requests.js";
import {
  workspaceArtifactCreateRequest,
  workspaceArtifactIdRequest,
  workspaceArtifactListRequest,
  workspaceArtifactSurfaceOperationRequest
} from "./workspace-artifact-requests.js";
import {
  workspaceGeneratedSurfaceActionRequest,
  workspaceGeneratedSurfaceBundleRequest,
  workspaceGeneratedSurfaceExportRequest,
  workspaceGeneratedSurfaceRoomRequest,
  workspaceGeneratedSurfaceStateRequest
} from "./workspace-generated-surface-requests.js";
import {
  workspaceSkillOptimizationActionRequest,
  workspaceSkillOptimizationIdRequest,
  workspaceSkillOptimizationListRequest,
  workspaceSkillOptimizationStartRequest
} from "./workspace-skill-optimization-requests.js";

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
let workspaceConnectionRegistry: WorkspaceConnectionRegistry = { version: 2, connections: [] };
let workspaceConnectionRegistryPath = "";
let workspaceIdentityStore: WorkspaceIdentityStore | undefined;
// Workspace and Room are navigation selections, not connection authority.
// They are populated only after a Server-authorized selection (or as a
// restart candidate until that re-authorization succeeds).
let activeWorkspaceId: string | undefined;
let activeOrganizationId: string | undefined;
let activeRoomId: string | undefined;
let workspaceRealtimeSocket: Socket | undefined;
let workspaceRealtimeGeneration = 0;
let workspaceRealtimeLastCursor: string | undefined;
const workspaceRealtimeSeenEventIds = new Set<string>();

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
  workspaceRealtimeSocket?.disconnect();
  workspaceRealtimeSocket = undefined;
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
      workspaceId: activeWorkspaceId,
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
    workspaceConnectionRegistry = upsertWorkspaceConnection(workspaceConnectionRegistry, workspaceConnectionSubmission(input));
    await saveWorkspaceConnectionRegistry(workspaceConnectionRegistryPath, workspaceConnectionRegistry);
    applyWorkspaceConnection(activeWorkspaceConnection(workspaceConnectionRegistry));
    await reauthorizeActiveWorkspaceCandidate();
    void reconnectActiveWorkspaceRealtime();
    return publicWorkspaceConnections();
  });
  ipcMain.handle("samurai:workspace-connections:select", async (_event, connectionId: unknown) => {
    if (typeof connectionId !== "string") throw new Error("workspace_connection_not_found");
    workspaceConnectionRegistry = selectWorkspaceConnection(workspaceConnectionRegistry, connectionId);
    await saveWorkspaceConnectionRegistry(workspaceConnectionRegistryPath, workspaceConnectionRegistry);
    applyWorkspaceConnection(activeWorkspaceConnection(workspaceConnectionRegistry));
    await reauthorizeActiveWorkspaceCandidate();
    void reconnectActiveWorkspaceRealtime();
    return publicWorkspaceConnections();
  });
  // The renderer never receives, types, or transmits a private key.  A user
  // may copy an existing key, then explicitly ask Electron Main to import it
  // into OS-protected storage for the currently selected Account.
  ipcMain.handle("samurai:workspace-identity:import-active-from-clipboard", async () => {
    const connection = requireActiveWorkspaceConnection();
    const privateKey = clipboard.readText().trim();
    const publicKey = publicKeyFromPrivateKey(privateKey);
    if (workspaceAccountIdFromPublicKey(publicKey) !== connection.accountId) throw new Error("workspace_identity_account_mismatch");
    const credentialRef = await requireWorkspaceIdentityStore().save(connection.accountId, privateKey);
    workspaceConnectionRegistry = upsertWorkspaceConnection(workspaceConnectionRegistry, { ...connection, credentialRef });
    await saveWorkspaceConnectionRegistry(workspaceConnectionRegistryPath, workspaceConnectionRegistry);
    await reauthorizeActiveWorkspaceCandidate();
    void reconnectActiveWorkspaceRealtime();
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
  // Organization navigation and management use Account-scoped signed
  // requests.  They deliberately do not inherit the active Workspace header;
  // the Server applies Organization membership before returning a projection.
  ipcMain.handle("samurai:workspace-server:organization:list", async () => {
    return sanitizeOrganizationPayload(await activeOrganizationServerRequest(workspaceOrganizationListRequest()));
  });
  ipcMain.handle("samurai:workspace-server:organization:get", async (_event, input: unknown) => {
    return sanitizeOrganizationPayload(await activeOrganizationServerRequest(workspaceOrganizationViewRequest(input)));
  });
  ipcMain.handle("samurai:workspace-server:organization:create", async (_event, input: unknown) => {
    return sanitizeOrganizationPayload(await activeOrganizationServerRequest(workspaceOrganizationCreateRequest(input)));
  });
  ipcMain.handle("samurai:workspace-server:organization:patch", async (_event, input: unknown) => {
    return sanitizeOrganizationPayload(await activeOrganizationServerRequest(workspaceOrganizationPatchRequest(input)));
  });
  ipcMain.handle("samurai:workspace-server:organization:delete", async (_event, input: unknown) => {
    const request = workspaceOrganizationDeleteRequest(input);
    const result = await activeOrganizationServerRequest(request);
    const value = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
    if (value.organizationId === activeOrganizationId) await persistActiveWorkspaceSelection({});
    return sanitizeOrganizationPayload(result);
  });
  ipcMain.handle("samurai:workspace-server:organization:members:list", async (_event, input: unknown) => {
    return sanitizeOrganizationPayload(await activeOrganizationServerRequest(workspaceOrganizationMembersRequest(input)));
  });
  ipcMain.handle("samurai:workspace-server:organization:member:role", async (_event, input: unknown) => {
    return sanitizeOrganizationPayload(await activeOrganizationServerRequest(workspaceOrganizationMemberRoleRequest(input)));
  });
  ipcMain.handle("samurai:workspace-server:organization:member:remove", async (_event, input: unknown) => {
    return sanitizeOrganizationPayload(await activeOrganizationServerRequest(workspaceOrganizationMemberRemoveRequest(input)));
  });
  ipcMain.handle("samurai:workspace-server:organization:member:leave", async (_event, input: unknown) => {
    const request = workspaceOrganizationMemberLeaveRequest(input);
    const result = await activeOrganizationServerRequest(request);
    const value = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
    if (value.organizationId === activeOrganizationId) await persistActiveWorkspaceSelection({});
    return sanitizeOrganizationPayload(result);
  });
  ipcMain.handle("samurai:workspace-server:organization:invitations:list", async (_event, input: unknown) => {
    return sanitizeOrganizationPayload(await activeOrganizationServerRequest(workspaceOrganizationInvitationsRequest(input)));
  });
  ipcMain.handle("samurai:workspace-server:organization:invitation:create", async (_event, input: unknown) => {
    // A token is only returned from this explicit create operation so the
    // renderer can show the one-time invitation dialog.  Credentials and
    // unrestricted Server records remain excluded by the sanitizer.
    return sanitizeOrganizationPayload(await activeOrganizationServerRequest(workspaceOrganizationInvitationCreateRequest(input)), { includeInvitationToken: true });
  });
  ipcMain.handle("samurai:workspace-server:organization:invitation:accept", async (_event, input: unknown) => {
    return sanitizeOrganizationPayload(await activeOrganizationServerRequest(workspaceOrganizationInvitationAcceptRequest(input)));
  });
  ipcMain.handle("samurai:workspace-server:organization:invitation:revoke", async (_event, input: unknown) => {
    return sanitizeOrganizationPayload(await activeOrganizationServerRequest(workspaceOrganizationInvitationRevokeRequest(input)));
  });
  ipcMain.handle("samurai:workspace-server:organization:invitation:reissue", async (_event, input: unknown) => {
    return sanitizeOrganizationPayload(await activeOrganizationServerRequest(workspaceOrganizationInvitationReissueRequest(input)), { includeInvitationToken: true });
  });
  ipcMain.handle("samurai:workspace-server:organization:invitation:extend", async (_event, input: unknown) => {
    return sanitizeOrganizationPayload(await activeOrganizationServerRequest(workspaceOrganizationInvitationExtendRequest(input)));
  });
  ipcMain.handle("samurai:workspace-server:organization:workspaces:list", async (_event, input: unknown) => {
    return sanitizeOrganizationPayload(await activeOrganizationServerRequest(workspaceOrganizationWorkspacesRequest(input)));
  });
  ipcMain.handle("samurai:workspace-server:organization:workspace:create", async (_event, input: unknown) => {
    return sanitizeOrganizationPayload(await activeOrganizationServerRequest(workspaceOrganizationWorkspaceCreateRequest(input)));
  });
  ipcMain.handle("samurai:workspace-server:organization:workspace:patch", async (_event, input: unknown) => {
    return sanitizeOrganizationPayload(await activeOrganizationServerRequest(workspaceOrganizationWorkspacePatchRequest(input)));
  });
  ipcMain.handle("samurai:workspace-server:organization:workspace:member:grant", async (_event, input: unknown) => {
    return sanitizeOrganizationPayload(await activeOrganizationServerRequest(workspaceOrganizationWorkspaceMemberGrantRequest(input)));
  });
  ipcMain.handle("samurai:workspace-server:organization:workspace:member:revoke", async (_event, input: unknown) => {
    return sanitizeOrganizationPayload(await activeOrganizationServerRequest(workspaceOrganizationWorkspaceMemberRevokeRequest(input)));
  });
  ipcMain.handle("samurai:workspace-server:organization:workspace:lifecycle", async (_event, input: unknown) => {
    const request = workspaceOrganizationWorkspaceLifecycleRequest(input);
    const result = await activeOrganizationServerRequest(request);
    const value = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
    if (request.path.includes("/archive") && value.workspaceId === activeWorkspaceId) {
      await persistActiveWorkspaceSelection({ organizationId: activeOrganizationId, workspaceId: activeWorkspaceId });
    }
    if (value.lifecycle === "delete" && value.workspaceId === activeWorkspaceId) {
      await persistActiveWorkspaceSelection({ organizationId: activeOrganizationId, workspaceId: undefined });
    }
    return sanitizeOrganizationPayload(result);
  });
  ipcMain.handle("samurai:workspace-server:organization:workspace:move-preview", async (_event, input: unknown) => {
    return sanitizeOrganizationPayload(await activeOrganizationServerRequest(workspaceOrganizationWorkspaceMovePreviewRequest(input)));
  });
  ipcMain.handle("samurai:workspace-server:organization:workspace:move", async (_event, input: unknown) => {
    const request = workspaceOrganizationWorkspaceMoveRequest(input);
    const result = await activeOrganizationServerRequest(request);
    const value = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
    if (value.workspaceId === activeWorkspaceId && typeof value.targetOrganizationId === "string") {
      await persistActiveWorkspaceSelection({ organizationId: value.targetOrganizationId, workspaceId: activeWorkspaceId, roomId: undefined });
    }
    return sanitizeOrganizationPayload(result);
  });
  ipcMain.handle("samurai:workspace-server:organization:workspace:move-status", async (_event, input: unknown) => {
    return sanitizeOrganizationPayload(await activeOrganizationServerRequest(workspaceOrganizationWorkspaceMoveStatusRequest(input)));
  });
  ipcMain.handle("samurai:workspace-server:organization:bundle:restore", async (_event, input: unknown) => {
    return sanitizeOrganizationPayload(await activeOrganizationServerRequest(workspaceOrganizationBundleRestoreRequest(input)));
  });
  ipcMain.handle("samurai:workspace-server:organization:bundle:export", async (_event, input: unknown) => {
    return sanitizeOrganizationPayload(await activeOrganizationServerRequest(workspaceOrganizationBundleExportRequest(input)));
  });
  // Selection is always a Server-authorized operation.  The values written to
  // the local registry below are only restart candidates, never grants.
  ipcMain.handle("samurai:workspace-server:selection:organization", async (_event, input: unknown) => {
    const organizationId = requiredSelectionId(input, "organizationId");
    await activeOrganizationServerRequest(workspaceOrganizationViewRequest({ organizationId }));
    await persistActiveWorkspaceSelection({ organizationId, workspaceId: undefined, roomId: undefined });
    return publicWorkspaceConnections();
  });
  ipcMain.handle("samurai:workspace-server:selection:workspace", async (_event, input: unknown) => {
    const selection = workspaceSelectionInput(input);
    const connection = requireActiveWorkspaceConnection();
    const privateKey = await requireActiveWorkspacePrivateKey(connection);
    const workspaceResponse = await signedWorkspaceServerRequest(connection, privateKey, workspaceSelectionWorkspaceViewRequest({ workspaceId: selection.workspaceId }));
    assertWorkspaceServerSuccess(workspaceResponse, "workspace_selection_failed");
    const organizationId = selection.organizationId
      ?? responseString(workspaceResponse.body, "organization_id")
      ?? responseString(workspaceResponse.body, "organizationId")
      ?? activeOrganizationId;
    if (selection.organizationId) {
      const organizationWorkspaces = await activeOrganizationServerRequest(workspaceOrganizationWorkspacesRequest({ organizationId: selection.organizationId }));
      if (!extractArray(organizationWorkspaces, ["workspaces"]).some((workspace) => responseString(workspace, "id") === selection.workspaceId || responseString(workspace, "workspace_id") === selection.workspaceId)) {
        throw new Error("workspace_selection_denied");
      }
    }
    await persistActiveWorkspaceSelection({ organizationId, workspaceId: selection.workspaceId, roomId: undefined });
    if (selection.roomId) {
      await authorizeAndPersistRoomSelection(selection.workspaceId, selection.roomId);
    }
    return publicWorkspaceConnections();
  });
  ipcMain.handle("samurai:workspace-server:selection:room", async (_event, input: unknown) => {
    const selection = workspaceSelectionInput(input);
    if (!selection.roomId) throw new Error("roomId_invalid");
    await authorizeAndPersistRoomSelection(selection.workspaceId, selection.roomId);
    return publicWorkspaceConnections();
  });
  // Browser bridge compatibility uses the compact Workspace-only form.
  ipcMain.handle("samurai:workspace-server:selection:set", async (_event, input: unknown) => {
    const selection = workspaceSelectionInput(input);
    const connection = requireActiveWorkspaceConnection();
    const privateKey = await requireActiveWorkspacePrivateKey(connection);
    const response = await signedWorkspaceServerRequest(connection, privateKey, workspaceSelectionWorkspaceViewRequest({ workspaceId: selection.workspaceId }));
    assertWorkspaceServerSuccess(response, "workspace_selection_failed");
    await persistActiveWorkspaceSelection({
      organizationId: selection.organizationId
        ?? responseString(response.body, "organization_id")
        ?? responseString(response.body, "organizationId")
        ?? activeOrganizationId,
      workspaceId: selection.workspaceId,
      roomId: undefined
    });
    return publicWorkspaceConnections();
  });
  ipcMain.handle("samurai:workspace-server:chat:run:cancel", async (_event, input: unknown) => {
    const request = workspaceChatRunControlRequest(input, "cancel");
    return activeWorkspaceServerRequest({
      method: "POST",
      path: `${activeWorkspaceChatPath()}/runs/${encodeURIComponent(request.runId)}/cancel`,
      workspaceScoped: true,
      operationId: request.operationId,
      idempotencyKey: request.operationId,
      body: request.body
    });
  });
  ipcMain.handle("samurai:workspace-server:chat:run:stop", async (_event, input: unknown) => {
    const request = workspaceChatRunControlRequest(input, "cancel");
    return activeWorkspaceServerRequest({
      method: "POST",
      path: `${activeWorkspaceChatPath()}/runs/${encodeURIComponent(request.runId)}/cancel`,
      workspaceScoped: true,
      operationId: request.operationId,
      idempotencyKey: request.operationId,
      body: request.body
    });
  });
  ipcMain.handle("samurai:workspace-server:chat:run:retry", async (_event, input: unknown) => {
    const request = workspaceChatRunControlRequest(input, "retry");
    return activeWorkspaceServerRequest({
      method: "POST",
      path: `${activeWorkspaceChatPath()}/runs/${encodeURIComponent(request.runId)}/retry`,
      workspaceScoped: true,
      operationId: request.operationId,
      idempotencyKey: request.operationId,
      body: request.body
    });
  });
  ipcMain.handle("samurai:workspace-server:reconnect", async (_event, input: unknown) => {
    workspaceChatReconnectRequest(input);
    reconnectActiveWorkspaceRealtime();
    return await workspaceServerStatus();
  });
  ipcMain.handle("samurai:workspace-server:evidence:read", async (_event, input: unknown) => {
    return await readWorkspaceEvidence(input);
  });
  // These are deliberate, purpose-specific signed operations.  The renderer
  // never receives a generic signed-request capability or this private key.
  ipcMain.handle("samurai:workspace-server:rooms:list", async () => {
    const connection = requireActiveWorkspaceConnection();
    const response = await activeWorkspaceDomainApiClient().executeQuery<PublicRoomRecord[]>(requireActiveWorkspaceId(), "room.list", { context: {}, input: {} });
    return { rooms: response.result.map(toDesktopWorkspaceRoom) };
  });
  ipcMain.handle("samurai:workspace-server:settings:get", async () => {
    return activeWorkspaceServerRequest({
      method: "GET",
      path: `${activeWorkspaceChatPath().replace(/\/chat$/, "")}/settings`,
      workspaceScoped: true
    });
  });
  ipcMain.handle("samurai:workspace-server:settings:patch", async (_event, input: unknown) => {
    const request = workspaceSettingsPatchRequest(input);
    return activeWorkspaceServerRequest({
      method: "PATCH",
      path: `${activeWorkspaceChatPath().replace(/\/chat$/, "")}/settings`,
      workspaceScoped: true,
      operationId: request.operationId,
      body: workspaceSettingsPatchJson(request.body)
    });
  });
  ipcMain.handle("samurai:workspace-server:chat:backends", async () => {
    return activeWorkspaceServerRequest({
      method: "GET",
      path: `${activeWorkspaceChatPath().replace(/\/chat$/, "")}/agent-backends`,
      workspaceScoped: true
    });
  });
  ipcMain.handle("samurai:workspace-server:surface:contract", async (_event, source: unknown) => {
    const query = typeof source === "string" && source.length > 0 ? `?source=${encodeURIComponent(source.slice(0, 80))}` : "";
    return activeWorkspaceServerRequest({
      method: "GET",
      path: `${activeWorkspaceChatPath().replace(/\/chat$/, "")}/surface/contract${query}`,
      workspaceScoped: true
    });
  });
  ipcMain.handle("samurai:workspace-server:chat:sessions:list", async () => {
    return activeWorkspaceServerRequest({
      method: "GET",
      path: `${activeWorkspaceChatPath()}/sessions`,
      workspaceScoped: true
    });
  });
  ipcMain.handle("samurai:workspace-server:chat:session:create", async (_event, input: unknown) => {
    const request = workspaceChatSessionRequest(input);
    const connection = requireActiveWorkspaceConnection();
    const { room_id: _roomId, ...operationInput } = request.body;
    const response = await activeWorkspaceDomainApiClient().executeOperation(requireActiveWorkspaceId(), "session.create", {
      context: { room_id: request.roomId },
      input: operationInput
    }, { operationId: request.operationId, idempotencyKey: request.operationId });
    return response.result;
  });
  ipcMain.handle("samurai:workspace-server:chat:session:get", async (_event, input: unknown) => {
    const sessionId = workspaceChatSessionIdRequest(input);
    return activeWorkspaceServerRequest({
      method: "GET",
      path: `${activeWorkspaceChatPath()}/sessions/${encodeURIComponent(sessionId)}`,
      workspaceScoped: true
    });
  });
  ipcMain.handle("samurai:workspace-server:chat:message:send", async (_event, input: unknown) => {
    const request = workspaceChatTurnRequest(input);
    const connection = requireActiveWorkspaceConnection();
    const response = await activeWorkspaceDomainApiClient().executeOperation(requireActiveWorkspaceId(), "chat.turn.run", {
      context: { session_id: request.sessionId },
      input: request.body
    }, { operationId: request.idempotencyKey, idempotencyKey: request.idempotencyKey });
    return response.result;
  });
  ipcMain.handle("samurai:workspace-server:files:attachment:write", async (_event, input: unknown) => {
    const request = workspaceAttachmentRequest(input);
    return activeWorkspaceServerRequest({
      method: "PUT",
      path: `${activeWorkspaceFilesPath()}/${request.filePath.split("/").map((part) => encodeURIComponent(part)).join("/")}`,
      workspaceScoped: true,
      operationId: request.operationId,
      body: request.body
    });
  });
  ipcMain.handle("samurai:workspace-server:chat:search", async (_event, input: unknown) => {
    const roomId = requiredWorkspaceOpaqueField(input, "roomId");
    const value = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
    if (typeof value.query !== "string" || !value.query.trim() || value.query.length > 200_000) throw new Error("query_invalid");
    return activeWorkspaceServerRequest({
      method: "GET",
      path: `${activeWorkspaceChatPath()}/search?room_id=${encodeURIComponent(roomId)}&q=${encodeURIComponent(value.query.trim())}`,
      workspaceScoped: true
    });
  });
  ipcMain.handle("samurai:workspace-server:chat:runs:list", async (_event, input: unknown) => {
    const value = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
    const sessionId = typeof value.sessionId === "string" ? requiredWorkspaceOpaqueField(value, "sessionId") : undefined;
    return activeWorkspaceServerRequest({
      method: "GET",
      path: `${activeWorkspaceChatPath()}/runs${sessionId ? `?session_id=${encodeURIComponent(sessionId)}` : ""}`,
      workspaceScoped: true
    });
  });
  ipcMain.handle("samurai:workspace-server:chat:run:get", async (_event, input: unknown) => {
    const runId = requiredWorkspaceOpaqueField(input, "runId");
    return activeWorkspaceServerRequest({
      method: "GET",
      path: `${activeWorkspaceChatPath()}/runs/${encodeURIComponent(runId)}`,
      workspaceScoped: true
    });
  });
  ipcMain.handle("samurai:workspace-server:chat:events:list", async (_event, input: unknown) => {
    const runId = requiredWorkspaceOpaqueField(input, "runId");
    return activeWorkspaceServerRequest({
      method: "GET",
      path: `${activeWorkspaceChatPath()}/runs/${encodeURIComponent(runId)}/events`,
      workspaceScoped: true
    });
  });
  ipcMain.handle("samurai:workspace-server:chat:changes:list", async (_event, input: unknown) => {
    const value = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
    const sessionId = typeof value.sessionId === "string" ? requiredWorkspaceOpaqueField(value, "sessionId") : undefined;
    return activeWorkspaceServerRequest({
      method: "GET",
      path: `${activeWorkspaceChatPath()}/changes${sessionId ? `?session_id=${encodeURIComponent(sessionId)}` : ""}`,
      workspaceScoped: true
    });
  });
  ipcMain.handle("samurai:workspace-server:chat:activity:list", async (_event, input: unknown) => {
    const roomId = requiredWorkspaceOpaqueField(input, "roomId");
    return activeWorkspaceServerRequest({
      method: "GET",
      path: `${activeWorkspaceChatPath()}/activity?room_id=${encodeURIComponent(roomId)}`,
      workspaceScoped: true
    });
  });
  ipcMain.handle("samurai:workspace-server:audit:get", async () => {
    const body = await activeWorkspaceServerRequest({
      method: "GET",
      path: `${activeWorkspaceChatPath().replace(/\/chat$/, "")}/audit`,
      workspaceScoped: true
    });
    if (!body || typeof body !== "object" || Array.isArray(body) || !Array.isArray((body as { entries?: unknown }).entries)) {
      throw new Error("workspace_audit_response_invalid");
    }
    return {
      auditRecords: [],
      operations: [],
      policyDecisions: [],
      approvalRequests: [],
      rollbackPoints: [],
      workspaceEntries: (body as { entries: unknown[] }).entries
    };
  });
  ipcMain.handle("samurai:workspace-server:completion:resources:list", async (_event, input: unknown) => {
    const request = workspaceCompletionResourceListRequest(input);
    const query = new URLSearchParams();
    if (request.scopeKind === "room") query.set("room_id", request.roomId);
    if (request.kind) query.set("kind", request.kind);
    if (request.includeArchived) query.set("include_archived", "true");
    return activeWorkspaceServerRequest({
      method: "GET",
      path: `${activeWorkspaceCompletionPath()}/resources${query.size ? `?${query.toString()}` : ""}`,
      workspaceScoped: true
    });
  });
  ipcMain.handle("samurai:workspace-server:completion:resource:get", async (_event, input: unknown) => {
    const resourceId = workspaceCompletionResourceIdRequest(input);
    return activeWorkspaceServerRequest({
      method: "GET",
      path: `${activeWorkspaceCompletionPath()}/resources/${encodeURIComponent(resourceId)}`,
      workspaceScoped: true
    });
  });
  ipcMain.handle("samurai:workspace-server:completion:resource:body", async (_event, input: unknown) => {
    const resourceId = workspaceCompletionResourceIdRequest(input);
    return activeWorkspaceServerRequest({
      method: "GET",
      path: `${activeWorkspaceCompletionPath()}/resources/${encodeURIComponent(resourceId)}/body`,
      workspaceScoped: true
    });
  });
  ipcMain.handle("samurai:workspace-server:completion:resource:create", async (_event, input: unknown) => {
    const request = workspaceCompletionResourceCreateRequest(input);
    return activeWorkspaceServerRequest({
      method: "POST",
      path: `${activeWorkspaceCompletionPath()}/resources`,
      workspaceScoped: true,
      operationId: request.operationId,
      body: request.body
    });
  });
  ipcMain.handle("samurai:workspace-server:completion:resource:update", async (_event, input: unknown) => {
    const request = workspaceCompletionResourceUpdateRequest(input);
    return activeWorkspaceServerRequest({
      method: "PUT",
      path: `${activeWorkspaceCompletionPath()}/resources/${encodeURIComponent(request.resourceId)}`,
      workspaceScoped: true,
      operationId: request.operationId,
      body: request.body
    });
  });
  ipcMain.handle("samurai:workspace-server:completion:resource:fixed", async (_event, input: unknown) => {
    const request = workspaceCompletionResourceStateRequest(input, "fixed");
    return activeWorkspaceServerRequest({
      method: "POST",
      path: `${activeWorkspaceCompletionPath()}/resources/${encodeURIComponent(request.resourceId)}/fixed`,
      workspaceScoped: true,
      operationId: request.operationId,
      body: request.body
    });
  });
  ipcMain.handle("samurai:workspace-server:completion:resource:archive", async (_event, input: unknown) => {
    const request = workspaceCompletionResourceStateRequest(input, "archive");
    return activeWorkspaceServerRequest({
      method: "POST",
      path: `${activeWorkspaceCompletionPath()}/resources/${encodeURIComponent(request.resourceId)}/archive`,
      workspaceScoped: true,
      operationId: request.operationId,
      body: request.body
    });
  });
  ipcMain.handle("samurai:workspace-server:completion:knowledge:search", async (_event, input: unknown) => {
    const request = workspaceCompletionSearchRequest(input);
    const query = new URLSearchParams({ room_id: request.roomId, q: request.query });
    if (request.limit !== undefined) query.set("limit", String(request.limit));
    return activeWorkspaceServerRequest({
      method: "GET",
      path: `${activeWorkspaceCompletionPath()}/knowledge/search?${query.toString()}`,
      workspaceScoped: true
    });
  });
  ipcMain.handle("samurai:workspace-server:completion:skills:list", async (_event, input: unknown) => {
    const roomId = requiredWorkspaceOpaqueField(input, "roomId");
    return activeWorkspaceServerRequest({
      method: "GET",
      path: `${activeWorkspaceCompletionPath()}/skills?room_id=${encodeURIComponent(roomId)}`,
      workspaceScoped: true
    });
  });
  ipcMain.handle("samurai:workspace-server:completion:skills:get", async (_event, input: unknown) => {
    const resourceId = workspaceCompletionResourceIdRequest(input);
    return activeWorkspaceServerRequest({
      method: "GET",
      path: `${activeWorkspaceCompletionPath()}/skills/${encodeURIComponent(resourceId)}`,
      workspaceScoped: true
    });
  });
  ipcMain.handle("samurai:workspace-server:skill-optimizations:list", async (_event, input: unknown) => {
    const request = workspaceSkillOptimizationListRequest(input);
    const query = new URLSearchParams();
    if (request.skillId) query.set("skill_id", request.skillId);
    if (request.roomId) query.set("room_id", request.roomId);
    if (request.limit !== undefined) query.set("limit", String(request.limit));
    return activeWorkspaceServerRequest({
      method: "GET",
      path: `${activeWorkspaceSkillOptimizationPath()}${query.size ? `?${query.toString()}` : ""}`,
      workspaceScoped: true
    });
  });
  ipcMain.handle("samurai:workspace-server:skill-optimizations:get", async (_event, input: unknown) => {
    const request = workspaceSkillOptimizationIdRequest(input);
    return activeWorkspaceServerRequest({
      method: "GET",
      path: `${activeWorkspaceSkillOptimizationPath()}/${encodeURIComponent(request.runId)}`,
      workspaceScoped: true
    });
  });
  ipcMain.handle("samurai:workspace-server:skill-optimizations:start", async (_event, input: unknown) => {
    const request = workspaceSkillOptimizationStartRequest(input);
    return activeWorkspaceServerRequest({
      method: "POST",
      path: `${activeWorkspaceSkillsPath()}/${encodeURIComponent(request.skillId)}/optimizations`,
      workspaceScoped: true,
      operationId: request.operationId,
      body: {
        ...(request.roomId ? { room_id: request.roomId } : {}),
        ...(request.objective ? { objective: request.objective } : {}),
        ...(request.goldenExamples ? { golden_examples: request.goldenExamples } : {}),
        ...(request.syntheticExamples ? { synthetic_examples: request.syntheticExamples } : {})
      }
    });
  });
  ipcMain.handle("samurai:workspace-server:skill-optimizations:action", async (_event, input: unknown) => {
    const request = workspaceSkillOptimizationActionRequest(input);
    return activeWorkspaceServerRequest({
      method: "POST",
      path: `${activeWorkspaceSkillOptimizationPath()}/${encodeURIComponent(request.runId)}/${request.action}`,
      workspaceScoped: true,
      operationId: request.operationId,
      body: {
        ...(request.candidateId ? { candidate_id: request.candidateId } : {}),
        ...(request.promotionId ? { promotion_id: request.promotionId } : {}),
        ...(request.snapshotId ? { snapshot_id: request.snapshotId } : {})
      }
    });
  });
  ipcMain.handle("samurai:workspace-server:knowledge-wiki:list", async (_event, input: unknown) => {
    const request = workspaceWikiListRequest(input);
    const query = new URLSearchParams({ room_id: request.roomId });
    if (request.includeArchived) query.set("include_archived", "true");
    return activeWorkspaceServerRequest({ method: "GET", path: `${activeWorkspaceKnowledgeWikiPath()}?${query.toString()}`, workspaceScoped: true });
  });
  ipcMain.handle("samurai:workspace-server:knowledge-wiki:get", async (_event, input: unknown) => {
    const wikiId = workspaceWikiIdRequest(input);
    return activeWorkspaceServerRequest({ method: "GET", path: `${activeWorkspaceKnowledgeWikiPath()}/${encodeURIComponent(wikiId)}`, workspaceScoped: true });
  });
  ipcMain.handle("samurai:workspace-server:knowledge-wiki:create", async (_event, input: unknown) => {
    const request = workspaceWikiCreateRequest(input);
    return activeWorkspaceServerRequest({ method: "POST", path: `${activeWorkspaceKnowledgeWikiPath()}/proposals`, workspaceScoped: true, operationId: request.operationId, body: request.body });
  });
  ipcMain.handle("samurai:workspace-server:knowledge-wiki:update", async (_event, input: unknown) => {
    const request = workspaceWikiPatchRequest(input);
    return activeWorkspaceServerRequest({ method: "PATCH", path: `${activeWorkspaceKnowledgeWikiPath()}/${encodeURIComponent(request.wikiId)}`, workspaceScoped: true, operationId: request.operationId, body: request.body });
  });
  ipcMain.handle("samurai:workspace-server:knowledge-wiki:state", async (_event, input: unknown) => {
    const request = workspaceWikiStateRequest(input);
    const state = input && typeof input === "object" && "state" in input && (input as Record<string, unknown>).state;
    if (state !== "accept" && state !== "reject" && state !== "archive") throw new Error("wiki_state_invalid");
    const suffix = state === "accept" ? "accept" : state === "reject" ? "reject" : "archive";
    return activeWorkspaceServerRequest({ method: "POST", path: `${activeWorkspaceKnowledgeWikiPath()}/${encodeURIComponent(request.wikiId)}/${suffix}`, workspaceScoped: true, operationId: request.operationId, body: { reason: request.reason } });
  });
  ipcMain.handle("samurai:workspace-server:knowledge-wiki:reindex", async (_event, input: unknown) => {
    const request = workspaceWikiListRequest(input);
    return activeWorkspaceServerRequest({ method: "POST", path: activeWorkspaceKnowledgeWikiPath() + "/reindex", workspaceScoped: true, body: { room_id: request.roomId } });
  });
  ipcMain.handle("samurai:workspace-server:knowledge-wiki:graph", async (_event, input: unknown) => {
    const request = workspaceWikiQueryRequest(input);
    const query = new URLSearchParams({ room_id: request.roomId });
    if (request.query) query.set("query", request.query);
    return activeWorkspaceServerRequest({ method: "GET", path: `${activeWorkspaceKnowledgeWikiPath()}/graph?${query.toString()}`, workspaceScoped: true });
  });
  ipcMain.handle("samurai:workspace-server:knowledge-wiki:lint", async (_event, input: unknown) => {
    const request = workspaceWikiListRequest(input);
    return activeWorkspaceServerRequest({ method: "GET", path: `${activeWorkspaceKnowledgeWikiPath()}/lint?room_id=${encodeURIComponent(request.roomId)}`, workspaceScoped: true });
  });
  ipcMain.handle("samurai:workspace-server:knowledge-wiki:backlinks", async (_event, input: unknown) => {
    const value = input && typeof input === "object" ? input as Record<string, unknown> : {};
    const wikiId = workspaceWikiIdRequest(value);
    const roomId = requiredWorkspaceOpaqueField(value, "roomId");
    return activeWorkspaceServerRequest({ method: "GET", path: `${activeWorkspaceKnowledgeWikiPath()}/${encodeURIComponent(wikiId)}/backlinks?room_id=${encodeURIComponent(roomId)}`, workspaceScoped: true });
  });
  ipcMain.handle("samurai:workspace-server:knowledge-memory:list", async (_event, input: unknown) => {
    const request = workspaceMemoryListRequest(input);
    const query = new URLSearchParams({ room_id: request.roomId });
    if (request.includeArchived) query.set("include_archived", "true");
    return activeWorkspaceServerRequest({ method: "GET", path: `${activeWorkspaceKnowledgeMemoryPath()}?${query.toString()}`, workspaceScoped: true });
  });
  ipcMain.handle("samurai:workspace-server:knowledge-memory:get", async (_event, input: unknown) => {
    const memoryId = workspaceMemoryIdRequest(input);
    return activeWorkspaceServerRequest({ method: "GET", path: `${activeWorkspaceKnowledgeMemoryPath()}/${encodeURIComponent(memoryId)}`, workspaceScoped: true });
  });
  ipcMain.handle("samurai:workspace-server:knowledge-memory:search", async (_event, input: unknown) => {
    const request = workspaceMemorySearchRequest(input);
    const query = new URLSearchParams({ room_id: request.roomId, q: request.query });
    if (request.limit !== undefined) query.set("limit", String(request.limit));
    return activeWorkspaceServerRequest({ method: "GET", path: `${activeWorkspaceKnowledgeMemoryPath()}/search?${query.toString()}`, workspaceScoped: true });
  });
  ipcMain.handle("samurai:workspace-server:knowledge-memory:archive", async (_event, input: unknown) => {
    const request = workspaceMemoryArchiveRequest(input);
    return activeWorkspaceServerRequest({ method: "POST", path: `${activeWorkspaceKnowledgeMemoryPath()}/${encodeURIComponent(request.memoryId)}/archive`, workspaceScoped: true, operationId: request.operationId, body: { reason: request.reason } });
  });
  ipcMain.handle("samurai:workspace-server:collections:schemas:list", async (_event, input: unknown) => {
    const request = workspaceCollectionRoomRequest(input);
    return activeWorkspaceServerRequest({ method: "GET", path: `${activeWorkspaceCollectionsPath()}/schemas?room_id=${encodeURIComponent(request.roomId)}`, workspaceScoped: true });
  });
  ipcMain.handle("samurai:workspace-server:collections:schema:get", async (_event, input: unknown) => {
    const request = workspaceCollectionIdRequest(input);
    return activeWorkspaceServerRequest({ method: "GET", path: `${activeWorkspaceCollectionsPath()}/${encodeURIComponent(request.collectionId)}/schema?room_id=${encodeURIComponent(request.roomId)}`, workspaceScoped: true });
  });
  ipcMain.handle("samurai:workspace-server:collections:schema:save", async (_event, input: unknown) => {
    const request = workspaceCollectionSchemaSaveRequest(input);
    return activeWorkspaceServerRequest({ method: "POST", path: `${activeWorkspaceCollectionsPath()}/schemas`, workspaceScoped: true, operationId: request.operationId, body: { room_id: request.roomId, schema: request.schema, ...(request.expectedVersion === undefined ? {} : { expected_version: request.expectedVersion }) } });
  });
  ipcMain.handle("samurai:workspace-server:collections:records:list", async (_event, input: unknown) => {
    const request = workspaceCollectionIdRequest(input);
    return activeWorkspaceServerRequest({ method: "GET", path: `${activeWorkspaceCollectionsPath()}/${encodeURIComponent(request.collectionId)}/records?room_id=${encodeURIComponent(request.roomId)}`, workspaceScoped: true });
  });
  ipcMain.handle("samurai:workspace-server:collections:record:create", async (_event, input: unknown) => {
    const request = workspaceCollectionRecordCreateRequest(input);
    return activeWorkspaceServerRequest({ method: "POST", path: `${activeWorkspaceCollectionsPath()}/${encodeURIComponent(request.collectionId)}/records`, workspaceScoped: true, operationId: request.operationId, body: request.body });
  });
  ipcMain.handle("samurai:workspace-server:collections:record:patch", async (_event, input: unknown) => {
    const request = workspaceCollectionRecordPatchRequest(input);
    return activeWorkspaceServerRequest({ method: "POST", path: `${activeWorkspaceCollectionsPath()}/${encodeURIComponent(request.collectionId)}/records/${encodeURIComponent(request.recordId)}/patches`, workspaceScoped: true, operationId: request.operationId, body: request.body });
  });
  ipcMain.handle("samurai:workspace-server:collections:record:delete", async (_event, input: unknown) => {
    const request = workspaceCollectionRecordDeleteRequest(input);
    return activeWorkspaceServerRequest({ method: "DELETE", path: `${activeWorkspaceCollectionsPath()}/${encodeURIComponent(request.collectionId)}/records/${encodeURIComponent(request.recordId)}`, workspaceScoped: true, operationId: request.operationId, body: request.body });
  });
  ipcMain.handle("samurai:workspace-server:collections:notes:list", async (_event, input: unknown) => {
    const request = workspaceCollectionIdRequest(input);
    return activeWorkspaceServerRequest({ method: "GET", path: `${activeWorkspaceCollectionsPath()}/${encodeURIComponent(request.collectionId)}/notes?room_id=${encodeURIComponent(request.roomId)}`, workspaceScoped: true });
  });
  ipcMain.handle("samurai:workspace-server:collections:reindex", async (_event, input: unknown) => {
    const request = workspaceCollectionRoomRequest(input);
    return activeWorkspaceServerRequest({ method: "POST", path: `${activeWorkspaceCollectionsPath()}/reindex`, workspaceScoped: true, body: { room_id: request.roomId } });
  });
  ipcMain.handle("samurai:workspace-server:collections:surface", async (_event, input: unknown) => {
    const request = workspaceCollectionSurfaceOperationRequest(input);
    return activeWorkspaceServerRequest({ method: "POST", path: `${activeWorkspaceCollectionsPath()}/surface/operations`, workspaceScoped: true, operationId: request.operationId, body: request.body });
  });
  ipcMain.handle("samurai:workspace-server:automation:jobs:list", async (_event, input: unknown) => {
    const request = workspaceAutomationListRequest(input);
    const query = request.roomId ? `?room_id=${encodeURIComponent(request.roomId)}` : "";
    return activeWorkspaceServerRequest({ method: "GET", path: `${activeWorkspaceAutomationPath()}/jobs${query}`, workspaceScoped: true });
  });
  ipcMain.handle("samurai:workspace-server:automation:jobs:create", async (_event, input: unknown) => {
    const request = workspaceAutomationJobCreateRequest(input);
    return activeWorkspaceServerRequest({ method: "POST", path: `${activeWorkspaceAutomationPath()}/jobs`, workspaceScoped: true, operationId: request.operationId, body: request.body });
  });
  ipcMain.handle("samurai:workspace-server:automation:runs:list", async (_event, input: unknown) => {
    const request = workspaceAutomationListRequest(input);
    const query = request.roomId ? `?room_id=${encodeURIComponent(request.roomId)}` : "";
    return activeWorkspaceServerRequest({ method: "GET", path: `${activeWorkspaceAutomationPath()}/runs${query}`, workspaceScoped: true });
  });
  ipcMain.handle("samurai:workspace-server:automation:job:runs", async (_event, input: unknown) => {
    const jobId = workspaceAutomationJobIdRequest(input);
    return activeWorkspaceServerRequest({ method: "GET", path: `${activeWorkspaceAutomationPath()}/jobs/${encodeURIComponent(jobId)}/runs`, workspaceScoped: true });
  });
  ipcMain.handle("samurai:workspace-server:automation:management", async (_event, input: unknown) => {
    const request = workspaceAutomationManagementRequest(input);
    return activeWorkspaceServerRequest({ method: "POST", path: `${activeWorkspaceAutomationPath()}/jobs/${encodeURIComponent(request.jobId)}/management`, workspaceScoped: true, operationId: request.operationId, body: { state: request.state } });
  });
  ipcMain.handle("samurai:workspace-server:automation:run-now", async (_event, input: unknown) => {
    const request = workspaceAutomationRunNowRequest(input);
    return activeWorkspaceServerRequest({ method: "POST", path: `${activeWorkspaceAutomationPath()}/run-now`, workspaceScoped: true, operationId: request.operationId, body: { room_id: request.roomId, kind: request.kind } });
  });
  ipcMain.handle("samurai:workspace-server:artifacts:list", async (_event, input: unknown) => {
    const request = workspaceArtifactListRequest(input);
    const connection = requireActiveWorkspaceConnection();
    const response = await activeWorkspaceDomainApiClient().executeQuery(requireActiveWorkspaceId(), "artifact.list", { context: { room_id: request.roomId }, input: {} });
    return { artifacts: response.result };
  });
  ipcMain.handle("samurai:workspace-server:artifact:get", async (_event, input: unknown) => {
    const request = workspaceArtifactIdRequest(input);
    const connection = requireActiveWorkspaceConnection();
    const response = await activeWorkspaceDomainApiClient().executeQuery<{ artifact: unknown; content: string }>(requireActiveWorkspaceId(), "artifact.view", { context: { room_id: request.roomId }, input: { id: request.artifactId } });
    return { ...response.result, auditRecords: [] };
  });
  ipcMain.handle("samurai:workspace-server:artifact:create", async (_event, input: unknown) => {
    const request = workspaceArtifactCreateRequest(input);
    const connection = requireActiveWorkspaceConnection();
    if (typeof request.body.content !== "string") {
      // Preserve the existing structured-content compatibility input. The v1
      // artifact.create contract currently publishes string content only.
      return activeWorkspaceServerRequest({
        method: "POST",
        path: activeWorkspaceArtifactsPath(),
        workspaceScoped: true,
        operationId: request.operationId,
        idempotencyKey: request.operationId,
        body: request.body
      });
    }
    const { room_id: roomId, locale, source_locales: sourceLocales, ...baseInput } = request.body;
    const response = await activeWorkspaceDomainApiClient().executeOperation(requireActiveWorkspaceId(), "artifact.create", {
      context: { room_id: String(roomId) },
      input: {
        ...baseInput,
        ...(locale ? { output_locale: locale } : {}),
        ...(Array.isArray(sourceLocales) && sourceLocales[0] ? { input_locale: sourceLocales[0] } : {})
      }
    }, { operationId: request.operationId, idempotencyKey: request.operationId });
    return response.result;
  });
  ipcMain.handle("samurai:workspace-server:artifact:surface", async (_event, input: unknown) => {
    const request = workspaceArtifactSurfaceOperationRequest(input);
    return activeWorkspaceServerRequest({ method: "POST", path: `${activeWorkspaceArtifactsPath()}/surface/operations`, workspaceScoped: true, operationId: request.operationId, body: request.body });
  });
  ipcMain.handle("samurai:workspace-server:generated-surface:get", async (_event, input: unknown) => {
    const request = workspaceGeneratedSurfaceRoomRequest(input);
    return activeWorkspaceServerRequest({ method: "GET", path: `${activeWorkspaceGeneratedSurfacesPath()}/${encodeURIComponent(request.surfaceId)}?room_id=${encodeURIComponent(request.roomId)}`, workspaceScoped: true });
  });
  ipcMain.handle("samurai:workspace-server:generated-surface:bundle", async (_event, input: unknown) => {
    const request = workspaceGeneratedSurfaceBundleRequest(input);
    return activeWorkspaceServerRequest({ method: "GET", path: `${activeWorkspaceGeneratedSurfacesPath()}/${encodeURIComponent(request.surfaceId)}/revisions/${encodeURIComponent(request.revisionId)}/bundle?room_id=${encodeURIComponent(request.roomId)}`, workspaceScoped: true });
  });
  ipcMain.handle("samurai:workspace-server:generated-surface:action", async (_event, input: unknown) => {
    const request = workspaceGeneratedSurfaceActionRequest(input);
    return activeWorkspaceServerRequest({ method: "POST", path: `${activeWorkspaceGeneratedSurfacesPath()}/${encodeURIComponent(request.surfaceId)}/actions/${encodeURIComponent(request.actionId)}/run`, workspaceScoped: true, operationId: request.operationId, body: request.body });
  });
  ipcMain.handle("samurai:workspace-server:generated-surface:state", async (_event, input: unknown) => {
    const request = workspaceGeneratedSurfaceStateRequest(input);
    return activeWorkspaceServerRequest({ method: "POST", path: `${activeWorkspaceGeneratedSurfacesPath()}/${encodeURIComponent(request.surfaceId)}/state`, workspaceScoped: true, operationId: request.operationId, body: request.body });
  });
  ipcMain.handle("samurai:workspace-server:generated-surface:export", async (_event, input: unknown) => {
    const request = workspaceGeneratedSurfaceExportRequest(input);
    const query = new URLSearchParams({ room_id: request.roomId, format: request.format });
    if (request.revisionId) query.set("revision_id", request.revisionId);
    return activeWorkspaceServerRequest({ method: "GET", path: `${activeWorkspaceGeneratedSurfacesPath()}/${encodeURIComponent(request.surfaceId)}/export?${query.toString()}`, workspaceScoped: true });
  });
  ipcMain.handle("samurai:workspace-server:room-members:list", async (_event, input: unknown) => {
    const roomId = requiredWorkspaceOpaqueField(input, "roomId");
    return activeWorkspaceServerRequest({
      method: "GET",
      path: `${activeWorkspaceRoomsPath()}/${encodeURIComponent(roomId)}/members`,
      workspaceScoped: true
    });
  });
  ipcMain.handle("samurai:workspace-server:room:create", async (_event, input: unknown) => {
    const request = workspaceRoomCreateRequest(input);
    if (!request.body.parent_room_id) {
      const connection = requireActiveWorkspaceConnection();
      const response = await activeWorkspaceDomainApiClient().executeOperation<PublicRoomRecord>(requireActiveWorkspaceId(), "room.create", {
        context: {},
        input: { name: request.body.name }
      }, { operationId: request.operationId, idempotencyKey: request.operationId });
      return { room: toDesktopWorkspaceRoom(response.result), replayed: response.replayed };
    }
    return activeWorkspaceServerRequest({
      method: "POST",
      path: activeWorkspaceRoomsPath(),
      workspaceScoped: true,
      operationId: request.operationId,
      body: request.body
    });
  });
  ipcMain.handle("samurai:workspace-server:room:move-preview", async (_event, input: unknown) => {
    const request = workspaceRoomMovePreviewRequest(input);
    return activeWorkspaceServerRequest({
      method: "POST",
      path: `${activeWorkspaceRoomsPath()}/${encodeURIComponent(request.roomId)}/parent/preview`,
      workspaceScoped: true,
      body: request.body
    });
  });
  ipcMain.handle("samurai:workspace-server:room:move", async (_event, input: unknown) => {
    const request = workspaceRoomMoveRequest(input);
    return activeWorkspaceServerRequest({
      method: "PUT",
      path: `${activeWorkspaceRoomsPath()}/${encodeURIComponent(request.roomId)}/parent`,
      workspaceScoped: true,
      operationId: request.operationId,
      body: request.body
    });
  });
  ipcMain.handle("samurai:workspace-server:room-member:preview", async (_event, input: unknown) => {
    const request = workspaceRoomMemberPreviewRequest(input);
    return activeWorkspaceServerRequest({
      method: "POST",
      path: `${activeWorkspaceRoomsPath()}/${encodeURIComponent(request.roomId)}/members/${encodeURIComponent(request.accountId)}/preview`,
      workspaceScoped: true,
      body: request.body
    });
  });
  ipcMain.handle("samurai:workspace-server:room-member:set", async (_event, input: unknown) => {
    const request = workspaceRoomMemberRequest(input);
    return activeWorkspaceServerRequest({
      method: "PUT",
      path: `${activeWorkspaceRoomsPath()}/${encodeURIComponent(request.roomId)}/members/${encodeURIComponent(request.accountId)}`,
      workspaceScoped: true,
      operationId: request.operationId,
      body: request.body
    });
  });
  ipcMain.handle("samurai:workspace-server:learning:settings:get", async (_event, input: unknown) => {
    const roomId = requiredWorkspaceOpaqueField(input, "roomId");
    return activeWorkspaceServerRequest({
      method: "GET",
      path: `${activeWorkspaceLearningPath()}/settings?room_id=${encodeURIComponent(roomId)}`,
      workspaceScoped: true
    });
  });
  ipcMain.handle("samurai:workspace-server:learning:settings:put", async (_event, input: unknown) => {
    const request = workspaceLearningSettingsRequest(input);
    return activeWorkspaceServerRequest({
      method: "PUT",
      path: `${activeWorkspaceLearningPath()}/settings`,
      workspaceScoped: true,
      operationId: request.operationId,
      body: request.body
    });
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
    return await submitQuickAsk(quickAsk);
  });
  ipcMain.handle("samurai:app-shot:submit", async (_event, input: unknown): Promise<AppShotResult> => {
    const appShot = validateAppShotInput(input);
    return await submitAppShot(appShot);
  });
}

async function initializeWorkspaceConnections(): Promise<void> {
  workspaceConnectionRegistryPath = path.join(app.getPath("userData"), "workspace-connections.json");
  workspaceIdentityStore = createWorkspaceIdentityStore(path.join(app.getPath("userData"), "workspace-identities.json"), safeStorage);
  workspaceConnectionRegistry = await loadWorkspaceConnectionRegistry(workspaceConnectionRegistryPath);
  // Persist the normalized v2 shape immediately so a legacy workspaceId
  // entry and duplicate Server+Account rows are migrated even when no new
  // connection is added during this launch.
  await saveWorkspaceConnectionRegistry(workspaceConnectionRegistryPath, workspaceConnectionRegistry);
  if (config.workspaceServerUrl && config.accountId) {
    const environmentConnection: WorkspaceConnectionInput = {
      label: "Environment",
      serverUrl: config.workspaceServerUrl,
      accountId: config.accountId,
      ...(config.workspaceId ? { lastWorkspaceId: config.workspaceId } : {})
    };
    const hasEnvironmentConnection = workspaceConnectionRegistry.connections.some((connection) =>
      connection.serverUrl === config.workspaceServerUrl
      && connection.accountId === config.accountId
    );
    if (!hasEnvironmentConnection) {
      workspaceConnectionRegistry = upsertWorkspaceConnection(workspaceConnectionRegistry, environmentConnection);
      await saveWorkspaceConnectionRegistry(workspaceConnectionRegistryPath, workspaceConnectionRegistry);
    }
  }
  applyWorkspaceConnection(activeWorkspaceConnection(workspaceConnectionRegistry));
  void reauthorizeActiveWorkspaceCandidate();
  void reconnectActiveWorkspaceRealtime();
}

/**
 * A persisted navigation value is only a restart hint.  Re-check each level
 * against the Server before a protected Workspace/Room becomes usable.  A
 * transient network failure leaves the hint intact for a later reconnect;
 * an explicit 403/404 drops the invalid level and everything below it.
 */
async function reauthorizeActiveWorkspaceCandidate(): Promise<void> {
  const connection = activeWorkspaceConnection(workspaceConnectionRegistry);
  if (!connection?.credentialRef) return;
  let privateKey: string;
  try {
    privateKey = await requireActiveWorkspacePrivateKey(connection);
  } catch {
    return;
  }
  const organizationId = connection.lastOrganizationId;
  const workspaceId = connection.lastWorkspaceId;
  const roomId = connection.lastRoomId;
  let validOrganizationId = organizationId;
  let validWorkspaceId = workspaceId;
  let validRoomId = roomId;
  if (organizationId) {
    try {
      const result = await signedWorkspaceServerRequest(connection, privateKey, workspaceOrganizationViewRequest({ organizationId }));
      if (isSelectionAuthorizationDenied(result.status)) validOrganizationId = undefined;
      else if (result.status < 200 || result.status >= 300) return;
    } catch {
      return;
    }
  }
  if (organizationId && validOrganizationId === undefined) {
    validWorkspaceId = undefined;
    validRoomId = undefined;
  }
  if (validWorkspaceId) {
    try {
      if (validOrganizationId) {
        const organizationWorkspaces = await signedWorkspaceServerRequest(connection, privateKey, workspaceOrganizationWorkspacesRequest({ organizationId: validOrganizationId }));
        const workspaces = extractArray(organizationWorkspaces.body, ["workspaces"]);
        if (isSelectionAuthorizationDenied(organizationWorkspaces.status)) {
          validWorkspaceId = undefined;
          validRoomId = undefined;
        } else if (organizationWorkspaces.status < 200 || organizationWorkspaces.status >= 300) return;
        else if (!workspaces.some((workspace) =>
          responseString(workspace, "id") === validWorkspaceId || responseString(workspace, "workspace_id") === validWorkspaceId
        )) {
          validWorkspaceId = undefined;
          validRoomId = undefined;
        }
      }
      if (!validWorkspaceId) {
        // The persisted Workspace no longer belongs to the selected
        // Organization. Keep the Organization candidate for safe recovery.
        if (validOrganizationId) {
          validRoomId = undefined;
          await persistActiveWorkspaceSelection({ organizationId: validOrganizationId });
        }
        return;
      }
      const result = await signedWorkspaceServerRequest(connection, privateKey, workspaceSelectionWorkspaceViewRequest({ workspaceId: validWorkspaceId }));
      if (isSelectionAuthorizationDenied(result.status)) {
        validWorkspaceId = undefined;
        validRoomId = undefined;
      } else if (result.status < 200 || result.status >= 300) {
        return;
      } else if (!validOrganizationId) {
        validOrganizationId = responseString(result.body, "organization_id") ?? responseString(result.body, "organizationId");
      }
    } catch {
      return;
    }
  }
  if (validWorkspaceId && validRoomId) {
    try {
      const result = await signedWorkspaceServerRequest(connection, privateKey, workspaceSelectionRoomsRequest({ workspaceId: validWorkspaceId }));
      const rooms = result.body && typeof result.body === "object" && !Array.isArray(result.body)
        ? (result.body as { rooms?: unknown }).rooms
        : undefined;
      if (isSelectionAuthorizationDenied(result.status)) validRoomId = undefined;
      else if (result.status < 200 || result.status >= 300 || !Array.isArray(rooms)) return;
      else if (!rooms.some((room) =>
        room && typeof room === "object" && !Array.isArray(room) && (room as { id?: unknown }).id === validRoomId
      )) validRoomId = undefined;
    } catch {
      return;
    }
  }
  if (validOrganizationId !== organizationId || validWorkspaceId !== workspaceId || validRoomId !== roomId) {
    if (validWorkspaceId) {
      await persistActiveWorkspaceSelection({
        ...(validOrganizationId ? { organizationId: validOrganizationId } : {}),
        workspaceId: validWorkspaceId,
        ...(validRoomId ? { roomId: validRoomId } : {})
      });
    } else if (validOrganizationId) {
      await persistActiveWorkspaceSelection({ organizationId: validOrganizationId });
    } else {
      await persistActiveWorkspaceSelection({});
    }
  }
}

function isSelectionAuthorizationDenied(status: number): boolean {
  return status === 401 || status === 403 || status === 404;
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

function publicConnectionWithoutCredential(connection: WorkspaceConnection): Omit<WorkspaceConnection, "credentialRef"> {
  const { credentialRef: _credentialRef, ...publicConnection } = connection;
  return publicConnection;
}

function workspaceConnectionSubmission(value: unknown): WorkspaceConnectionInput {
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
  return {
    ...(optional("id") ? { id: optional("id") } : {}),
    label: required("label"),
    serverUrl: required("serverUrl"),
    accountId: required("accountId"),
    // Kept as a compatibility input only. workspace-connections.ts migrates
    // it into lastWorkspaceId and never persists it as connection authority.
    ...(optional("workspaceId") ? { workspaceId: optional("workspaceId") } : {}),
    ...(optional("lastOrganizationId") ? { lastOrganizationId: optional("lastOrganizationId") } : {}),
    ...(optional("lastWorkspaceId") ? { lastWorkspaceId: optional("lastWorkspaceId") } : {}),
    ...(optional("lastRoomId") ? { lastRoomId: optional("lastRoomId") } : {})
  };
}

function applyWorkspaceConnection(connection: WorkspaceConnection | undefined): void {
  if (!connection) {
    activeOrganizationId = undefined;
    activeWorkspaceId = undefined;
    activeRoomId = undefined;
    config.workspaceServerUrl = undefined;
    config.workspaceId = undefined;
    config.accountId = undefined;
    return;
  }
  // Workspace Server is a separate boundary from the legacy Chat/Core API.
  // Selecting it must never silently redirect the Chat UI to an incompatible
  // endpoint; Server 02-specific clients consume these explicit values.
  config.workspaceServerUrl = connection.serverUrl;
  activeOrganizationId = connection.lastOrganizationId;
  activeWorkspaceId = connection.lastWorkspaceId;
  activeRoomId = connection.lastRoomId;
  config.workspaceId = activeWorkspaceId;
  config.accountId = connection.accountId;
}

interface WorkspaceServerRequestInput {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  body?: unknown;
  operationId?: string;
  idempotencyKey?: string;
  workspaceScoped: boolean;
  /** Explicit only for realtime requests bound to a non-active snapshot. */
  workspaceId?: string;
}

type WorkspaceRealtimeNotice = {
  type: "event" | "access_changed" | "access_revoked" | "room_access_changed" | "room_access_revoked";
  workspaceId: string;
  roomId?: string;
  kind?: string;
  eventId?: string;
  cursor?: string;
};

function requireWorkspaceIdentityStore(): WorkspaceIdentityStore {
  if (!workspaceIdentityStore) throw new Error("workspace_identity_store_unavailable");
  return workspaceIdentityStore;
}

function requireActiveWorkspaceConnection(): WorkspaceConnection {
  const connection = activeWorkspaceConnection(workspaceConnectionRegistry);
  if (!connection) throw new Error("workspace_connection_not_selected");
  return connection;
}

function workspaceIdForConnection(connection: WorkspaceConnection): string | undefined {
  const active = activeWorkspaceConnection(workspaceConnectionRegistry);
  if (active?.id === connection.id) return activeWorkspaceId ?? connection.lastWorkspaceId;
  return connection.lastWorkspaceId;
}

function requireActiveWorkspaceId(): string {
  const connection = requireActiveWorkspaceConnection();
  const workspaceId = workspaceIdForConnection(connection);
  if (!workspaceId) throw new Error("workspace_selection_required");
  return workspaceId;
}

async function requireActiveWorkspacePrivateKey(connection: WorkspaceConnection): Promise<string> {
  if (connection.credentialRef !== `electron-safe-storage://workspace-account/${connection.accountId}`) {
    throw new Error("workspace_identity_required");
  }
  const privateKey = await requireWorkspaceIdentityStore().load(connection.accountId);
  if (!privateKey) throw new Error("workspace_identity_required");
  if (workspaceAccountIdFromPublicKey(publicKeyFromPrivateKey(privateKey)) !== connection.accountId) {
    throw new Error("workspace_identity_account_mismatch");
  }
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
  const workspaceId = input.workspaceScoped ? (input.workspaceId ?? workspaceIdForConnection(connection)) : undefined;
  if (input.workspaceScoped && !workspaceId) throw new Error("workspace_selection_required");
  const requestId = `request_${randomUUID()}`;
  const timestamp = String(Date.now());
  const body = input.body ?? {};
  const signaturePayload = createWorkspaceAccountSignaturePayload({
    method: input.method,
    path: url.pathname,
    ...(workspaceId ? { workspaceId } : {}),
    ...(input.operationId ? { operationId: input.operationId } : {}),
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
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
      ...(workspaceId ? { "x-samurai-workspace-id": workspaceId } : {}),
      ...(input.operationId ? { "x-samurai-operation-id": input.operationId } : {}),
      ...(input.idempotencyKey ? { "idempotency-key": input.idempotencyKey } : {})
    },
    ...(input.method === "GET" ? {} : { body: JSON.stringify(body) })
  });
  const text = await response.text();
  let responseBody: unknown = undefined;
  if (text) {
    try { responseBody = JSON.parse(text); } catch { responseBody = { error: "workspace_server_response_invalid" }; }
  }
  return { status: response.status, body: responseBody };
}

async function activeWorkspaceServerRequest(input: WorkspaceServerRequestInput): Promise<unknown> {
  const connection = requireActiveWorkspaceConnection();
  const privateKey = await requireActiveWorkspacePrivateKey(connection);
  const result = await signedWorkspaceServerRequest(connection, privateKey, input);
  if (result.status < 200 || result.status >= 300) {
    const body = result.body;
    const errorValue = body && typeof body === "object" ? (body as { error?: unknown }).error : undefined;
    const code = typeof errorValue === "string"
      ? errorValue
      : errorValue && typeof errorValue === "object" && typeof (errorValue as { code?: unknown }).code === "string"
        ? (errorValue as { code: string }).code
        : "workspace_server_request_failed";
    const latestVersion = body && typeof body === "object"
      && "details" in body
      && (body as { details?: unknown }).details
      && typeof (body as { details: { latest_version?: unknown } }).details.latest_version === "number"
      ? (body as { details: { latest_version: number } }).details.latest_version
      : undefined;
    throw new Error(`${code}:${result.status}${latestVersion === undefined ? "" : `:latest_version=${latestVersion}`}`);
  }
  return result.body;
}

async function activeOrganizationServerRequest(
  input: import("./workspace-organization-requests.js").OrganizationRequestDescriptor
): Promise<unknown> {
  const connection = requireActiveWorkspaceConnection();
  const privateKey = await requireActiveWorkspacePrivateKey(connection);
  const result = await signedWorkspaceServerRequest(connection, privateKey, {
    method: input.method,
    path: input.path,
    workspaceScoped: false,
    ...(input.body === undefined ? {} : { body: input.body }),
    ...(input.operationId ? { operationId: input.operationId } : {}),
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {})
  });
  assertWorkspaceServerSuccess(result, "organization_request_failed");
  return result.body;
}

function assertWorkspaceServerSuccess(result: { status: number; body: unknown }, fallback: string): void {
  if (result.status >= 200 && result.status < 300) return;
  const body = result.body;
  const errorValue = body && typeof body === "object" ? (body as { error?: unknown }).error : undefined;
  const code = typeof errorValue === "string"
    ? errorValue
    : errorValue && typeof errorValue === "object" && typeof (errorValue as { code?: unknown }).code === "string"
      ? (errorValue as { code: string }).code
      : fallback;
  throw new Error(`${code}:${result.status}`);
}

function responseString(body: unknown, key: string): string | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const record = body as Record<string, unknown>;
  const direct = record[key];
  if (typeof direct === "string" && isWorkspaceOpaqueId(direct)) return direct;
  for (const nestedKey of ["workspace", "organization", "result"]) {
    const nested = record[nestedKey];
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      const value = (nested as Record<string, unknown>)[key];
      if (typeof value === "string" && isWorkspaceOpaqueId(value)) return value;
    }
  }
  return undefined;
}

function requiredSelectionId(input: unknown, key: string): string {
  const value = typeof input === "string"
    ? input
    : input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)[key]
      : undefined;
  if (typeof value !== "string" || !isWorkspaceOpaqueId(value)) throw new Error(`${key}_invalid`);
  return value;
}

function workspaceSelectionInput(input: unknown): {
  organizationId?: string;
  workspaceId: string;
  roomId?: string;
} {
  if (typeof input === "string") return { workspaceId: requiredSelectionId(input, "workspaceId") };
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("workspace_selection_invalid");
  const value = input as Record<string, unknown>;
  const workspaceId = requiredSelectionId(value, "workspaceId");
  const organizationId = value.organizationId === undefined || value.organizationId === null || value.organizationId === ""
    ? undefined
    : requiredSelectionId(value, "organizationId");
  const roomId = value.roomId === undefined || value.roomId === null || value.roomId === ""
    ? undefined
    : requiredSelectionId(value, "roomId");
  return { workspaceId, ...(organizationId ? { organizationId } : {}), ...(roomId ? { roomId } : {}) };
}

async function authorizeAndPersistRoomSelection(workspaceId: string, roomId: string): Promise<void> {
  const connection = requireActiveWorkspaceConnection();
  const privateKey = await requireActiveWorkspacePrivateKey(connection);
  const response = await signedWorkspaceServerRequest(connection, privateKey, workspaceSelectionRoomsRequest({ workspaceId }));
  assertWorkspaceServerSuccess(response, "room_selection_failed");
  const body = response.body;
  if (!body || typeof body !== "object" || Array.isArray(body) || !Array.isArray((body as { rooms?: unknown }).rooms)) {
    throw new Error("workspace_rooms_response_invalid");
  }
  const room = (body as { rooms: unknown[] }).rooms.find((candidate) =>
    candidate && typeof candidate === "object" && !Array.isArray(candidate)
      && (candidate as { id?: unknown }).id === roomId
  );
  if (!room) throw new Error("room_selection_denied");
  await persistActiveWorkspaceSelection({ organizationId: activeOrganizationId, workspaceId, roomId });
}

async function persistActiveWorkspaceSelection(selection: {
  organizationId?: string;
  workspaceId?: string;
  roomId?: string;
}): Promise<void> {
  const connection = requireActiveWorkspaceConnection();
  const updatedAt = new Date().toISOString();
  const updatedConnection: WorkspaceConnection = {
    ...connection,
    ...(selection.organizationId ? { lastOrganizationId: selection.organizationId } : {}),
    ...(selection.workspaceId ? { lastWorkspaceId: selection.workspaceId } : {}),
    ...(selection.roomId ? { lastRoomId: selection.roomId } : {}),
    updatedAt
  };
  if (selection.organizationId === undefined) delete updatedConnection.lastOrganizationId;
  if (selection.workspaceId === undefined) delete updatedConnection.lastWorkspaceId;
  if (selection.roomId === undefined) delete updatedConnection.lastRoomId;
  workspaceConnectionRegistry = {
    version: 2,
    ...(workspaceConnectionRegistry.activeConnectionId ? { activeConnectionId: workspaceConnectionRegistry.activeConnectionId } : {}),
    connections: workspaceConnectionRegistry.connections.map((candidate) => candidate.id === connection.id ? updatedConnection : candidate)
  };
  await saveWorkspaceConnectionRegistry(workspaceConnectionRegistryPath, workspaceConnectionRegistry);
  // A slow authorization response must not switch the user back to a
  // connection selected while this request was in flight. The candidate is
  // still saved for that connection, but only the current one updates Main's
  // active navigation/realtime state.
  if (workspaceConnectionRegistry.activeConnectionId !== connection.id) return;
  applyWorkspaceConnection(updatedConnection);
  void reconnectActiveWorkspaceRealtime();
}

async function readWorkspaceEvidence(input: unknown): Promise<unknown> {
  const request = workspaceEvidenceRequest(input);
  if (request.workspaceId !== requireActiveWorkspaceId()) throw new Error("workspace_selection_required");
  const connection = requireActiveWorkspaceConnection();
  const privateKey = await requireActiveWorkspacePrivateKey(connection);
  const [activityResponse, runResponse, artifactResponse, memoryResponse] = await Promise.all([
    request.activityPath
      ? signedWorkspaceServerRequest(connection, privateKey, { method: "GET", path: request.activityPath, workspaceScoped: true, workspaceId: request.workspaceId })
      : Promise.resolve({ status: 200, body: { activities: [] } }),
    signedWorkspaceServerRequest(connection, privateKey, { method: "GET", path: request.runsPath, workspaceScoped: true, workspaceId: request.workspaceId }),
    request.artifactsPath
      ? signedWorkspaceServerRequest(connection, privateKey, { method: "GET", path: request.artifactsPath, workspaceScoped: true, workspaceId: request.workspaceId })
      : Promise.resolve({ status: 200, body: { artifacts: [] } }),
    request.memoriesPath
      ? signedWorkspaceServerRequest(connection, privateKey, { method: "GET", path: request.memoriesPath, workspaceScoped: true, workspaceId: request.workspaceId })
      : Promise.resolve({ status: 200, body: { memories: [] } })
  ]);
  for (const response of [activityResponse, runResponse, artifactResponse, memoryResponse]) {
    assertWorkspaceServerSuccess(response, "workspace_evidence_read_failed");
  }
  return sanitizeEvidencePayload({
    activity: extractArray(activityResponse.body, ["activity", "activities", "entries"]),
    backendRuns: extractArray(runResponse.body, ["runs", "backend_runs"]),
    artifacts: extractArray(artifactResponse.body, ["artifacts"]),
    memories: extractArray(memoryResponse.body, ["memories"])
  });
}

function extractArray(body: unknown, keys: string[]): unknown[] {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== "object" || Array.isArray(body)) return [];
  for (const key of keys) {
    const value = (body as Record<string, unknown>)[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

const publicOrganizationPayloadKeys = new Set([
  "id", "organization_id", "workspace_id", "room_id", "account_id", "invitation_id", "source_organization_id", "target_organization_id",
  "name", "description", "icon", "state", "status", "role", "membership_role", "access", "permission", "can_access", "has_access",
  "can_execute", "can_manage", "version", "workspace_count", "created_at", "updated_at", "joined_at", "removed_at", "expires_at",
  "accepted_at", "revoked_at", "recipient_account_id", "display_name", "created_by", "updated_by", "issued_by", "deleted_at", "lifecycle", "replayed", "organizations", "organization",
  "workspaces", "workspace", "members", "member", "membership", "organization_membership", "workspace_membership", "invitations", "invitation", "workspace_grants", "room_ids", "rooms", "preview", "result",
  "impact", "impacts", "blocking_conditions", "blocking_owner_room_ids", "affected_room_ids", "manifest", "receipt", "error", "code",
  "message", "details", "reason", "source_reference", "schema_revision", "schema_version", "bundle_revision", "workspace_id", "workspace_version", "workspace_state", "file_count", "byte_size", "entry_count", "bundle_id", "integrity_hash", "record_counts", "restored_at",
  "operation_id", "guest_membership_account_ids", "committed_at", "failure_code", "existing_members", "missing_members", "failure_conditions", "requires_guest_confirmation", "write_blocked", "will_add_as_guest", "workspace_role", "current_workspace_role", "target_organization_role",
  "activity", "activities", "entries", "runs", "backend_runs", "backendRuns", "artifacts", "memories", "resources", "kind", "title", "summary", "severity", "activity_type", "operation_id", "approval_request_id", "audit_record_id", "rollback_point_id", "topic", "content_hash",
  "path", "file_ref", "sha256", "size", "mime_type", "selected", "reused", "evidence", "event_id", "event_type", "cursor",
  "activity_id", "run_id", "session_id", "artifact_id", "memory_id", "resource_id", "backend_id", "backend_kind", "backend_session_id", "agent_id", "input_message_id", "output_message_id", "started_at", "completed_at", "phase", "current_attempt", "error_code", "input_summary", "output_summary", "workspace_membership_id", "organization_membership_id",
  "organizationId", "workspaceId", "roomId", "accountId", "invitationId", "targetAccountId", "sourceOrganizationId", "targetOrganizationId",
  "createdAt", "updatedAt", "expiresAt", "displayName", "workspaceCount", "canExecute", "canManage", "includeArchived", "operationId", "workspaceVersion", "workspaceState", "guestMembershipAccountIds", "committedAt", "failureCode", "existingMembers", "missingMembers", "failureConditions", "requiresGuestConfirmation", "writeBlocked", "willAddAsGuest", "workspaceRole", "currentWorkspaceRole", "targetOrganizationRole", "bundleId", "schemaVersion", "integrityHash", "recordCounts", "restoredAt", "state"
]);

function sanitizeOrganizationPayload(value: unknown, options: { includeInvitationToken?: boolean } = {}): unknown {
  return sanitizePublicValue(value, options, 0);
}

function sanitizeEvidencePayload(value: unknown): unknown {
  return sanitizePublicValue(value, {}, 0);
}

function sanitizePublicValue(value: unknown, options: { includeInvitationToken?: boolean }, depth: number): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return value.slice(0, 20_000);
  if (depth > 8) return undefined;
  if (Array.isArray(value)) return value.slice(0, 1_000).map((item) => sanitizePublicValue(item, options, depth + 1)).filter((item) => item !== undefined);
  if (!value || typeof value !== "object") return undefined;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (/(?:private|secret|credential|password|raw[_-]?token)/i.test(key)) continue;
    if (key === "token" && !options.includeInvitationToken) continue;
    if (key !== "token" && !publicOrganizationPayloadKeys.has(key)) continue;
    const sanitized = sanitizePublicValue(item, options, depth + 1);
    if (sanitized !== undefined) output[key] = sanitized;
  }
  return output;
}

function activeWorkspaceDomainApiClient(): DomainApiClient {
  return new DomainApiClient(async <T>(request: DomainApiTransportRequest): Promise<T> => {
    return await activeWorkspaceServerRequest({
      method: request.method,
      path: request.path,
      workspaceScoped: true,
      ...(request.operationId ? { operationId: request.operationId } : {}),
      ...(request.idempotencyKey ? { idempotencyKey: request.idempotencyKey } : {}),
      ...(request.body === undefined ? {} : { body: request.body })
    }) as T;
  });
}

function toDesktopWorkspaceRoom(room: PublicRoomRecord): {
  id: string;
  workspaceId: string;
  parentRoomId?: string;
  name: string;
  version: number;
  canManage?: boolean;
  canExecute?: boolean;
  createdAt: string;
  updatedAt: string;
} {
  return {
    id: room.id,
    workspaceId: room.workspace_id,
    ...(room.parent_room_id ? { parentRoomId: room.parent_room_id } : {}),
    name: room.name,
    version: room.version,
    ...(room.can_manage === undefined ? {} : { canManage: room.can_manage }),
    ...(room.can_execute === undefined ? {} : { canExecute: room.can_execute }),
    createdAt: room.created_at,
    updatedAt: room.updated_at
  };
}

/** Main owns Socket.IO authentication and the private key used to sign it. */
function reconnectActiveWorkspaceRealtime(): void {
  const generation = ++workspaceRealtimeGeneration;
  workspaceRealtimeLastCursor = undefined;
  workspaceRealtimeSeenEventIds.clear();
  workspaceRealtimeSocket?.disconnect();
  workspaceRealtimeSocket = undefined;
  const connection = activeWorkspaceConnection(workspaceConnectionRegistry);
  if (!connection?.credentialRef) return;
  void (async () => {
    let privateKey: string;
    try {
      privateKey = await requireActiveWorkspacePrivateKey(connection);
    } catch {
      return;
    }
    if (generation !== workspaceRealtimeGeneration) return;
    const socket = io(connection.serverUrl, {
      autoConnect: false,
      transports: ["websocket", "polling"],
      timeout: 10_000,
      auth: (callback) => {
        try {
          callback(workspaceSocketAuth(connection, privateKey));
        } catch {
          callback({});
        }
      }
    });
    workspaceRealtimeSocket = socket;
    const isCurrent = () => generation === workspaceRealtimeGeneration && workspaceRealtimeSocket === socket;
    socket.on("connect", () => {
      if (!isCurrent()) return;
      void syncWorkspaceRealtime(socket, connection, privateKey, isCurrent);
    });
    socket.on("workspace:v1:event", (event: unknown) => {
      if (!isCurrent() || !acceptWorkspacePublicEvent(event)) return;
      forwardWorkspaceRealtimeNotice("event", connection, event);
    });
    socket.on("workspace:event", (event: unknown) => {
      if (!isCurrent()) return;
      forwardWorkspaceRealtimeNotice("event", connection, event);
      // A tree event can make a new directly-authorized Room subscribable.
      void refreshWorkspaceRealtimeRooms(socket, connection, privateKey, isCurrent);
    });
    socket.on("workspace:access-changed", (event: unknown) => {
      if (!isCurrent()) return;
      forwardWorkspaceRealtimeNotice("access_changed", connection, event);
      void refreshWorkspaceRealtimeRooms(socket, connection, privateKey, isCurrent);
      void reauthorizeActiveWorkspaceCandidate();
    });
    socket.on("workspace:room-access-changed", (event: unknown) => {
      if (!isCurrent()) return;
      forwardWorkspaceRealtimeNotice("room_access_changed", connection, event);
      void refreshWorkspaceRealtimeRooms(socket, connection, privateKey, isCurrent);
      void reauthorizeActiveWorkspaceCandidate();
    });
    socket.on("workspace:room-access-revoked", (event: unknown) => {
      if (!isCurrent()) return;
      forwardWorkspaceRealtimeNotice("room_access_revoked", connection, event);
      const roomId = realtimeEventRoomId(event);
      if (roomId && roomId === (activeRoomId ?? connection.lastRoomId)) {
        void persistActiveWorkspaceSelection({ organizationId: activeOrganizationId, workspaceId: activeWorkspaceId });
      }
    });
    socket.on("workspace:access-revoked", (event: unknown) => {
      if (!isCurrent()) return;
      forwardWorkspaceRealtimeNotice("access_revoked", connection, event);
      socket.disconnect();
      if (connection.id === activeWorkspaceConnection(workspaceConnectionRegistry)?.id) {
        void persistActiveWorkspaceSelection({ organizationId: activeOrganizationId });
      }
    });
    socket.connect();
  })();
}

function realtimeEventRoomId(event: unknown): string | undefined {
  if (!event || typeof event !== "object" || Array.isArray(event)) return undefined;
  const value = event as { roomId?: unknown; room_id?: unknown; scope?: { room_id?: unknown } };
  const roomId = value.roomId ?? value.room_id ?? value.scope?.room_id;
  return typeof roomId === "string" && isWorkspaceOpaqueId(roomId) ? roomId : undefined;
}

function workspaceSocketAuth(connection: WorkspaceConnection, privateKey: string): Record<string, string> {
  const workspaceId = workspaceIdForConnection(connection);
  if (!workspaceId) throw new Error("workspace_selection_required");
  const requestId = `socket_${randomUUID()}`;
  const timestamp = String(Date.now());
  const payload = createWorkspaceAccountSignaturePayload({
    method: "SOCKET",
    path: "/socket.io",
    workspaceId,
    requestId,
    timestamp,
    body: {}
  });
  return {
    account_id: connection.accountId,
    workspace_id: workspaceId,
    request_id: requestId,
    timestamp,
    signature: sign(null, Buffer.from(payload), createPrivateKey(privateKey)).toString("base64url")
  };
}

async function refreshWorkspaceRealtimeRooms(
  socket: Socket,
  connection: WorkspaceConnection,
  privateKey: string,
  isCurrent: () => boolean
): Promise<void> {
  try {
    const response = await signedWorkspaceServerRequest(connection, privateKey, {
      method: "GET",
      path: `/api/workspaces/${encodeURIComponent(workspaceIdForConnection(connection) ?? "")}/rooms`,
      workspaceScoped: true,
      workspaceId: workspaceIdForConnection(connection)
    });
    if (!isCurrent() || response.status < 200 || response.status >= 300 || !response.body || typeof response.body !== "object") return;
    const rooms = (response.body as { rooms?: unknown }).rooms;
    if (!Array.isArray(rooms)) return;
    for (const room of rooms) {
      const roomId = room && typeof room === "object" ? (room as { id?: unknown }).id : undefined;
      if (typeof roomId !== "string" || !isWorkspaceOpaqueId(roomId)) continue;
      socket.emit("workspace:subscribe-room", { room_id: roomId });
    }
  } catch {
    // Reconnects and the next authorized hierarchy event retry this sync.
  }
}

async function syncWorkspaceRealtime(
  socket: Socket,
  connection: WorkspaceConnection,
  privateKey: string,
  isCurrent: () => boolean
): Promise<void> {
  try {
    socket.emit("workspace:v1:subscribe", {});
    let afterCursor = workspaceRealtimeLastCursor;
    for (let page = 0; page < 20 && isCurrent(); page += 1) {
      const query = afterCursor ? `?after_cursor=${encodeURIComponent(afterCursor)}&limit=500` : "?limit=500";
      const response = await signedWorkspaceServerRequest(connection, privateKey, {
        method: "GET",
        path: `/api/v1/workspaces/${encodeURIComponent(workspaceIdForConnection(connection) ?? "")}/events${query}`,
        workspaceScoped: true,
        workspaceId: workspaceIdForConnection(connection)
      });
      if (!isCurrent() || response.status < 200 || response.status >= 300 || !response.body || typeof response.body !== "object") break;
      const body = response.body as { events?: unknown; next_cursor?: unknown; has_more?: unknown };
      if (!Array.isArray(body.events)) break;
      for (const event of body.events) {
        if (!acceptWorkspacePublicEvent(event)) continue;
        forwardWorkspaceRealtimeNotice("event", connection, event);
      }
      const nextCursor = typeof body.next_cursor === "string" ? body.next_cursor : undefined;
      if (body.has_more === true && nextCursor) {
        afterCursor = nextCursor;
        continue;
      }
      break;
    }
    await refreshWorkspaceRealtimeRooms(socket, connection, privateKey, isCurrent);
  } catch {
    // The next Socket.IO reconnect retries HTTP replay.
  }
}

function acceptWorkspacePublicEvent(event: unknown): boolean {
  if (!event || typeof event !== "object") return false;
  const value = event as { event_id?: unknown; cursor?: unknown };
  if (typeof value.event_id === "string") {
    if (workspaceRealtimeSeenEventIds.has(value.event_id)) return false;
    workspaceRealtimeSeenEventIds.add(value.event_id);
    if (workspaceRealtimeSeenEventIds.size > 2_000) {
      const first = workspaceRealtimeSeenEventIds.values().next().value;
      if (typeof first === "string") workspaceRealtimeSeenEventIds.delete(first);
    }
  }
  if (typeof value.cursor === "string") workspaceRealtimeLastCursor = value.cursor;
  return true;
}

/** Only the small, non-secret event shape crosses the Main-to-renderer IPC boundary. */
function forwardWorkspaceRealtimeNotice(type: WorkspaceRealtimeNotice["type"], connection: WorkspaceConnection, event: unknown): void {
  if (!mainWindow || mainWindow.isDestroyed() || !event || typeof event !== "object") return;
  const value = event as {
    workspaceId?: unknown;
    roomId?: unknown;
    kind?: unknown;
    event_id?: unknown;
    cursor?: unknown;
    event_type?: unknown;
    scope?: { workspace_id?: unknown; room_id?: unknown };
  };
  const workspaceId = value.workspaceId ?? value.scope?.workspace_id;
  const connectionWorkspaceId = workspaceIdForConnection(connection);
  if (!connectionWorkspaceId || workspaceId !== connectionWorkspaceId) return;
  const notice: WorkspaceRealtimeNotice = { type, workspaceId: connectionWorkspaceId };
  const roomId = value.roomId ?? value.scope?.room_id;
  if (typeof roomId === "string" && isWorkspaceOpaqueId(roomId)) notice.roomId = roomId;
  const kind = value.kind ?? value.event_type;
  if (typeof kind === "string" && /^[a-z][a-z0-9._-]{0,127}$/.test(kind)) notice.kind = kind;
  if (typeof value.event_id === "string" && isWorkspaceOpaqueId(value.event_id)) notice.eventId = value.event_id;
  if (typeof value.cursor === "string" && value.cursor.length <= 512) notice.cursor = value.cursor;
  mainWindow.webContents.send("samurai:workspace-server:event", notice);
}

function isWorkspaceOpaqueId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

function activeWorkspaceRoomsPath(): string {
  return `/api/workspaces/${encodeURIComponent(requireActiveWorkspaceId())}/rooms`;
}

function activeWorkspaceLearningPath(): string {
  return `/api/workspaces/${encodeURIComponent(requireActiveWorkspaceId())}/learning`;
}

function activeWorkspaceCompletionPath(): string {
  return `/api/workspaces/${encodeURIComponent(requireActiveWorkspaceId())}/completion`;
}

function activeWorkspaceSkillsPath(): string {
  return `/api/workspaces/${encodeURIComponent(requireActiveWorkspaceId())}/skills`;
}

function activeWorkspaceSkillOptimizationPath(): string {
  return `/api/workspaces/${encodeURIComponent(requireActiveWorkspaceId())}/skill-optimizations`;
}

function activeWorkspaceKnowledgeWikiPath(): string {
  return `/api/workspaces/${encodeURIComponent(requireActiveWorkspaceId())}/knowledge-wiki`;
}

function activeWorkspaceKnowledgeMemoryPath(): string {
  return `/api/workspaces/${encodeURIComponent(requireActiveWorkspaceId())}/knowledge-memory`;
}

function activeWorkspaceCollectionsPath(): string {
  return `/api/workspaces/${encodeURIComponent(requireActiveWorkspaceId())}/collections`;
}

function activeWorkspaceAutomationPath(): string {
  return `/api/workspaces/${encodeURIComponent(requireActiveWorkspaceId())}/automation`;
}

function activeWorkspaceArtifactsPath(): string {
  return `/api/workspaces/${encodeURIComponent(requireActiveWorkspaceId())}/artifacts`;
}

function activeWorkspaceGeneratedSurfacesPath(): string {
  return `/api/workspaces/${encodeURIComponent(requireActiveWorkspaceId())}/generated-surfaces`;
}

function activeWorkspaceClientEventsPath(): string {
  return `/api/workspaces/${encodeURIComponent(requireActiveWorkspaceId())}/client-events`;
}

function activeWorkspaceChatPath(): string {
  return `/api/workspaces/${encodeURIComponent(requireActiveWorkspaceId())}/chat`;
}

function activeWorkspaceFilesPath(): string {
  return `/api/workspaces/${encodeURIComponent(requireActiveWorkspaceId())}/files`;
}

async function activeWorkspaceExecutableRoomId(): Promise<string> {
  const body = await activeWorkspaceServerRequest({
    method: "GET",
    path: activeWorkspaceRoomsPath(),
    workspaceScoped: true
  });
  if (!body || typeof body !== "object" || Array.isArray(body) || !Array.isArray((body as { rooms?: unknown }).rooms)) {
    throw new Error("workspace_rooms_response_invalid");
  }
  const room = (body as { rooms: unknown[] }).rooms.find((item): item is { id: string; canExecute?: boolean } =>
    Boolean(item && typeof item === "object" && !Array.isArray(item)
      && typeof (item as { id?: unknown }).id === "string"
      && (item as { canExecute?: unknown }).canExecute === true)
  );
  if (!room) throw new Error("workspace_room_execute_required");
  return room.id;
}

function workspaceChatSessionResponseId(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof (value as { id?: unknown }).id !== "string") {
    throw new Error("workspace_chat_session_response_invalid");
  }
  return (value as { id: string }).id;
}

function workspaceChatTurnResponseSessionId(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const result = (value as { result?: unknown }).result;
  if (!result || typeof result !== "object" || Array.isArray(result)) return undefined;
  const session = (result as { session?: unknown }).session;
  if (!session || typeof session !== "object" || Array.isArray(session)) return undefined;
  const id = (session as { id?: unknown }).id;
  return typeof id === "string" && id.trim() ? id : undefined;
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
    return { connection: publicConnectionWithoutCredential(connection), identityAvailable, health };
  }
  try {
    const privateKey = await requireActiveWorkspacePrivateKey(connection);
    const workspaceId = workspaceIdForConnection(connection);
    if (!workspaceId) return { connection: publicConnectionWithoutCredential(connection), identityAvailable, health };
    const workspace = await signedWorkspaceServerRequest(connection, privateKey, {
      method: "GET",
      path: `/api/workspaces/${encodeURIComponent(workspaceId)}`,
      workspaceScoped: true,
      workspaceId
    });
    const rooms = workspace.status >= 200 && workspace.status < 300
      ? await signedWorkspaceServerRequest(connection, privateKey, {
        method: "GET",
        path: `/api/workspaces/${encodeURIComponent(workspaceId)}/rooms`,
        workspaceScoped: true,
        workspaceId
      })
      : undefined;
    return { connection: publicConnectionWithoutCredential(connection), identityAvailable, health, workspace, ...(rooms ? { rooms } : {}) };
  } catch (error) {
    return { connection: publicConnectionWithoutCredential(connection), identityAvailable, health, workspace: { status: 0, body: { error: error instanceof Error ? error.message : "workspace_server_request_failed" } } };
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

async function submitAppShot(input: AppShotInput): Promise<AppShotResult> {
  cleanupTemporaryContextItems();
  const item = temporaryContextItems.get(input.sourceId);
  if (!item) {
    throw new Error("スクショの一時Contextが見つかりません。もう一度AppShotを開いてください。");
  }
  if (Date.parse(item.expiresAt) <= Date.now()) {
    temporaryContextItems.delete(item.id);
    throw new Error("スクショの一時Contextが期限切れです。もう一度AppShotを開いてください。");
  }
  const roomId = await activeWorkspaceExecutableRoomId();
  const sessionRequest = workspaceChatSessionRequest({
    roomId,
    operationId: `desktop_app_shot_session_${randomUUID()}`,
    title: draftSessionTitle(input.content),
    uiLocale: "ja",
    outputLocale: "ja"
  });
  const session = await activeWorkspaceServerRequest({
    method: "POST",
    path: `${activeWorkspaceChatPath()}/sessions`,
    workspaceScoped: true,
    operationId: sessionRequest.operationId,
    body: sessionRequest.body
  });
  const sessionId = workspaceChatSessionResponseId(session);
  const result = await activeWorkspaceServerRequest({
    method: "POST",
    path: `${activeWorkspaceChatPath()}/sessions/${encodeURIComponent(sessionId)}/messages`,
    workspaceScoped: true,
    idempotencyKey: `desktop_app_shot_${randomUUID()}`,
    body: {
      content: input.content,
      input_locale: "ja",
      output_locale: "ja",
      temporary_context: [{
        id: item.id,
        kind: item.kind,
        label: item.label,
        source_name: item.sourceName,
        mime_type: item.mimeType,
        data_url: item.dataUrl,
        created_at: item.createdAt,
        expires_at: item.expiresAt,
        metadata: {
          source_client_kind: "desktop",
          source_client_feature: "app_shot"
        }
      }],
      metadata: {
        source_client_kind: "desktop",
        source_client_feature: "app_shot",
        app_shot_source_name: item.sourceName,
        temporary_context_expires_at: item.expiresAt
      }
    }
  });
  temporaryContextItems.delete(item.id);
  return {
    sessionId: workspaceChatTurnResponseSessionId(result) ?? sessionId,
    temporaryContextItemId: item.id
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
  const availability = await checkDeepLinkTargetAvailability(target);
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
      accountId: active.accountId,
      lastWorkspaceId: target.workspaceId,
      ...(active.credentialRef ? { credentialRef: active.credentialRef } : {})
    });
    const connection = proposed.connections.find((item) =>
      item.serverUrl === target.serverUrl && item.accountId === active.accountId
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
      path: `/api/workspaces/${encodeURIComponent(target.workspaceId)}/invitations/accept`,
      workspaceScoped: true,
      workspaceId: target.workspaceId,
      // The same link retried by the same Account must replay its original
      // acceptance result if the network failed after the server committed.
      operationId: invitationAcceptanceOperationId({ ...connection, workspaceId: target.workspaceId }, target.token),
      body: { invite_token: target.token }
    });
    if (accepted.status < 200 || accepted.status >= 300) throw new Error(`workspace_invitation_acceptance_failed:${accepted.status}`);
    workspaceConnectionRegistry = selectWorkspaceConnection(proposed, connection.id);
    await saveWorkspaceConnectionRegistry(workspaceConnectionRegistryPath, workspaceConnectionRegistry);
    applyWorkspaceConnection(connection);
    // The accepted Workspace becomes active immediately.  Its Room-scoped
    // realtime connection must follow it rather than remain on the former
    // Workspace until the Desktop app is restarted.
    void reconnectActiveWorkspaceRealtime();
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

function invitationAcceptanceOperationId(connection: Pick<WorkspaceConnection, "serverUrl" | "accountId"> & { workspaceId: string }, token: string): string {
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
  target: DeepLinkTarget
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
  try {
    if (target.kind === "session") {
      await activeWorkspaceServerRequest({
        method: "GET",
        path: `${activeWorkspaceChatPath()}/sessions/${encodeURIComponent(target.id)}`,
        workspaceScoped: true
      });
    } else if (target.kind === "run") {
      await activeWorkspaceServerRequest({
        method: "GET",
        path: `${activeWorkspaceChatPath()}/runs/${encodeURIComponent(target.id)}`,
        workspaceScoped: true
      });
    } else {
      // Artifact links do not carry a Room ID. Resolve the target only through
      // Rooms the current Account can read; the Artifact API keeps the final
      // Room check and never exposes a Workspace-wide unauthorised lookup.
      const roomsBody = await activeWorkspaceServerRequest({
        method: "GET",
        path: activeWorkspaceRoomsPath(),
        workspaceScoped: true
      });
      const rooms = roomsBody && typeof roomsBody === "object" && !Array.isArray(roomsBody)
        && Array.isArray((roomsBody as { rooms?: unknown }).rooms)
        ? (roomsBody as { rooms: unknown[] }).rooms
        : [];
      let lastError: unknown;
      for (const room of rooms) {
        const roomId = room && typeof room === "object" && typeof (room as { id?: unknown }).id === "string"
          ? (room as { id: string }).id
          : undefined;
        if (!roomId) continue;
        try {
          await activeWorkspaceServerRequest({
            method: "GET",
            path: `${activeWorkspaceArtifactsPath()}/${encodeURIComponent(target.id)}?room_id=${encodeURIComponent(roomId)}`,
            workspaceScoped: true
          });
          return { ok: true };
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError instanceof Error ? lastError : new Error("workspace_artifact_not_found");
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : String(error)
    };
  }
}

async function submitQuickAsk(input: QuickAskInput): Promise<QuickAskResult> {
  const roomId = await activeWorkspaceExecutableRoomId();
  const sessionRequest = workspaceChatSessionRequest({
    roomId,
    operationId: `desktop_quick_ask_session_${randomUUID()}`,
    title: draftSessionTitle(input.content),
    uiLocale: "ja",
    outputLocale: "ja"
  });
  const session = await activeWorkspaceServerRequest({
    method: "POST",
    path: `${activeWorkspaceChatPath()}/sessions`,
    workspaceScoped: true,
    operationId: sessionRequest.operationId,
    body: sessionRequest.body
  });
  const sessionId = workspaceChatSessionResponseId(session);
  const result = await activeWorkspaceServerRequest({
    method: "POST",
    path: `${activeWorkspaceChatPath()}/sessions/${encodeURIComponent(sessionId)}/messages`,
    workspaceScoped: true,
    idempotencyKey: `desktop_quick_ask_${randomUUID()}`,
    body: {
      content: input.content,
      input_locale: "ja",
      output_locale: "ja",
      metadata: {
        source_client_kind: "desktop",
        source_client_feature: input.sourceFeature
      }
    }
  });
  return { sessionId: workspaceChatTurnResponseSessionId(result) ?? sessionId };
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
    const body = await activeWorkspaceServerRequest({
      method: "GET",
      path: `${activeWorkspaceClientEventsPath()}?target_client_kind=desktop&status=pending&limit=20`,
      workspaceScoped: true
    });
    if (!body || typeof body !== "object" || Array.isArray(body) || !Array.isArray((body as { events?: unknown }).events)) {
      throw new Error("workspace_client_events_response_invalid");
    }
    const events = (body as { events: unknown[] }).events.filter((event): event is ClientEventRecord => isClientEventRecord(event));
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
  await activeWorkspaceServerRequest({
    method: "POST",
    path: `${activeWorkspaceClientEventsPath()}/${encodeURIComponent(eventId)}/deliver`,
    workspaceScoped: true,
    operationId: clientEventOperationId("deliver", eventId)
  });
}

async function ackClientEvent(eventId: string): Promise<void> {
  await activeWorkspaceServerRequest({
    method: "POST",
    path: `${activeWorkspaceClientEventsPath()}/${encodeURIComponent(eventId)}/ack`,
    workspaceScoped: true,
    operationId: clientEventOperationId("ack", eventId)
  });
}

async function failClientEvent(eventId: string, code: string): Promise<void> {
  await activeWorkspaceServerRequest({
    method: "POST",
    path: `${activeWorkspaceClientEventsPath()}/${encodeURIComponent(eventId)}/fail`,
    workspaceScoped: true,
    operationId: clientEventOperationId("fail", eventId),
    body: { error_code: code }
  });
}

function isClientEventRecord(value: unknown): value is ClientEventRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const event = value as Partial<ClientEventRecord>;
  return typeof event.id === "string"
    && (event.target_client_kind === "desktop" || event.target_client_kind === "web" || event.target_client_kind === "any")
    && typeof event.event_type === "string"
    && typeof event.status === "string"
    && Boolean(event.payload && typeof event.payload === "object" && !Array.isArray(event.payload))
    && Array.isArray(event.resource_refs)
    && typeof event.created_at === "string";
}

function clientEventOperationId(action: "deliver" | "ack" | "fail", eventId: string): string {
  return `client_event_${action}_${createHash("sha256").update(eventId).digest("hex").slice(0, 40)}`;
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
