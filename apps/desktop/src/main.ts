import { createHash, createPrivateKey, createPublicKey, randomUUID, sign } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { io, type Socket } from "socket.io-client";
import { DomainApiClient, PublicAgentBackendRecordSchema, PublicRoomWorkAttachmentSchema, PublicRoomWorkResourceRefSchema, type DomainApiRequest, type DomainApiTransportRequest, type PublicAgentRecord, type PublicRoomRecord } from "@samurai-agent/domain-api";
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
  clearActiveWorkspaceTarget,
  cutoverWorkspaceTarget,
  getWorkspaceTransfer,
  loadWorkspaceConnectionRegistry,
  patchWorkspaceTarget,
  recordWorkspaceTransfer,
  saveWorkspaceConnectionRegistry,
  selectWorkspaceConnection,
  selectWorkspaceTarget,
  upsertWorkspaceConnection,
  upsertWorkspaceTarget,
  workspaceTargetKey,
  type WorkspaceConnection,
  type WorkspaceConnectionInput,
  type WorkspaceConnectionRegistry,
  type WorkspaceTargetCutover,
  type WorkspaceTarget,
  type WorkspaceTargetRef,
  type WorkspaceTransferReceiptRecord,
  type WorkspaceTransferRecord
} from "./workspace-connections.js";
import { createWorkspaceIdentityStore, type WorkspaceIdentityStore } from "./workspace-identities.js";
import { workspaceNavigationSnapshotIsCurrent, type WorkspaceNavigationSnapshot } from "./workspace-navigation.js";
import { createWorkspaceAccountSignaturePayload, workspaceAccountIdFromPublicKey } from "./workspace-request-signing.js";
import {
  requiredWorkspaceOpaqueField,
  workspaceAgentBackendBindRequest,
  workspaceAgentCreateRequest,
  workspaceAgentDmRequest,
  workspaceAgentListRequest,
  workspaceAgentPatchRequest,
  workspaceAgentViewRequest,
  workspaceRoomCreateRequest,
  workspaceRoomMemberListRequest,
  workspaceRoomAgentMemberListRequest,
  workspaceRoomAgentPermissionRequest,
  workspaceRoomAgentRemoveRequest,
  workspaceRoomDefaultAgentRequest,
  workspaceRoomMemberPreviewRequest,
  workspaceRoomMemberRequest,
  workspaceRoomMovePreviewRequest,
  workspaceRoomMoveRequest,
  workspaceTargetRequest
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
  workspaceCreateRequest,
  workspaceStandaloneBundleExportRequest,
  workspaceStandaloneBundleRestoreRequest,
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
  workspaceOrganizationWorkspaceAttachRequest,
  workspaceOrganizationWorkspaceDetachRequest,
  workspaceOrganizationWorkspaceLifecycleRequest,
  workspaceOrganizationWorkspaceMemberGrantRequest,
  workspaceOrganizationWorkspaceMemberRevokeRequest,
  workspaceOrganizationWorkspaceMovePreviewRequest,
  workspaceOrganizationWorkspaceMoveStatusRequest,
  workspaceOrganizationWorkspaceMoveRequest,
  workspaceOrganizationWorkspacePatchRequest,
  workspaceOrganizationWorkspacesRequest,
  workspaceOrganizationListRequest
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
import { DESKTOP_ARTIFACT_MAX_CONTENT_BYTES, verifyDesktopArtifactContentResponse, type DesktopArtifactRawContent } from "./artifact-content-boundary.js";
import {
  workspaceGeneratedSurfaceActionRequest,
  workspaceGeneratedSurfaceBundleRequest,
  workspaceGeneratedSurfaceExportRequest,
  workspaceGeneratedSurfaceRoomRequest,
  workspaceGeneratedSurfaceStateRequest
} from "./workspace-generated-surface-requests.js";
import { workspaceOperationHistoryRequest } from "./workspace-operation-history-requests.js";
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
let workspaceConnectionRegistry: WorkspaceConnectionRegistry = { version: 3, connections: [] };
let workspaceConnectionRegistryPath = "";
let workspaceIdentityStore: WorkspaceIdentityStore | undefined;
// Workspace and Room are navigation selections, not connection authority.
// They are populated only after a Server-authorized selection (or as a
// restart candidate until that re-authorization succeeds).
let activeWorkspaceId: string | undefined;
let activeOrganizationId: string | undefined;
let activeRoomId: string | undefined;
let activeWorkspaceTargetRef: WorkspaceTargetRef | undefined;
// Workspace and Room are distinct navigation scopes. Keep a target epoch for
// all Workspace requests, and a full selection epoch for Room-bound requests.
let workspaceTargetGeneration = 0;
let workspaceSelectionGeneration = 0;
let workspaceActivationGeneration = 0;
let workspaceSelectionCommit: Promise<void> = Promise.resolve();
let workspaceRealtimeSocket: Socket | undefined;
let workspaceRealtimeGeneration = 0;
let workspaceRealtimeTargetRef: WorkspaceTargetRef | undefined;
let workspaceRealtimeLastCursor: string | undefined;
const workspaceRealtimeSeenEventIds = new Set<string>();

/**
 * Transfer progress is renderer-safe checkpoint state restored from the local
 * registry. The source Server remains the durable owner of the transfer ledger;
 * this map mirrors the last Desktop checkpoint for status and retry routing.
 */
const workspaceTransferStatusById = new Map<string, WorkspaceTransferStatus>();
const workspaceTransferInFlightById = new Map<string, Promise<WorkspaceTransferStatus>>();

const workspaceTransferMaxEntries = 200_000;
const workspaceTransferMaxBytes = 120_000_000;

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
    workspaceTarget: publicActiveWorkspaceTarget(),
    workspaceConnections: publicWorkspaceConnections(),
    workspaceTransfers: listWorkspaceTransfers(),
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
    const previousTarget = activeWorkspaceTargetRef;
    workspaceConnectionRegistry = upsertWorkspaceConnection(workspaceConnectionRegistry, workspaceConnectionSubmission(input));
    await saveWorkspaceConnectionRegistry(workspaceConnectionRegistryPath, workspaceConnectionRegistry);
    const nextTarget = workspaceConnectionRegistry.activeTarget;
    if (!previousTarget && nextTarget) {
      applyWorkspaceTarget(nextTarget);
      await reauthorizeActiveWorkspaceCandidate();
      void reconnectActiveWorkspaceRealtime();
    } else if (sameWorkspaceTarget(previousTarget, nextTarget)) {
      applyWorkspaceTarget(nextTarget);
      await reauthorizeActiveWorkspaceCandidate();
      void reconnectActiveWorkspaceRealtime();
    }
    return publicWorkspaceConnections();
  });
  ipcMain.handle("samurai:workspace-connections:select", async (_event, connectionId: unknown) => {
    if (typeof connectionId !== "string") throw new Error("workspace_connection_not_found");
    const selected = workspaceConnectionRegistry.connections.find((connection) => connection.id === connectionId.trim());
    if (!selected) throw new Error("workspace_connection_not_found");
    const target = selected.targets[0];
    if (target) {
      await activateAuthorizedWorkspaceTarget(targetRef(target));
    } else {
      // Clearing the active target is also an explicit selection. Invalidate
      // any older authorization before it can restore a previous target.
      workspaceTargetGeneration += 1;
      workspaceSelectionGeneration += 1;
      workspaceActivationGeneration += 1;
      workspaceConnectionRegistry = selectWorkspaceConnection(workspaceConnectionRegistry, selected.id);
      await saveWorkspaceConnectionRegistry(workspaceConnectionRegistryPath, workspaceConnectionRegistry);
      applyWorkspaceTarget(undefined);
      void reconnectActiveWorkspaceRealtime();
    }
    return publicWorkspaceConnections();
  });
  const listWorkspaceDirectoryHandler = async () => listWorkspaceDirectory();
  ipcMain.handle("samurai:workspace-directory:list", listWorkspaceDirectoryHandler);
  // Keep the first target-aware IPC name available to clients that adopted the
  // Phase 2 contract before the directory naming was finalized.
  ipcMain.handle("samurai:workspace-connections:workspaces:list", listWorkspaceDirectoryHandler);
  ipcMain.handle("samurai:workspace-connections:cutover", async (_event, input: unknown) => {
    const request = workspaceTargetCutoverInput(input);
    // Cutover is a registry operation only after the target Server has been
    // verified. Re-authorize before committing the in-memory and on-disk
    // switch so an offline/denied destination leaves the source untouched.
    const authorization = await authorizeWorkspaceTargetForTransition(request.destination, request.lastRoomId ?? undefined);
    await commitWorkspaceTargetCutover(request, authorization);
    return publicWorkspaceConnections();
  });
  const workspaceTransferPreflightHandler = async (_event: unknown, input: unknown) => preflightWorkspaceTargetTransfer(workspaceTransferInput(input));
  const workspaceTransferExecuteHandler = async (_event: unknown, input: unknown) => publicWorkspaceTransferStatus(await executeWorkspaceTargetTransfer(workspaceTransferInput(input)));
  const workspaceTransferStatusHandler = async (_event: unknown, input: unknown) => workspaceTransferStatus(workspaceTransferStatusInput(input));
  ipcMain.handle("samurai:workspace-transfer:preflight", workspaceTransferPreflightHandler);
  ipcMain.handle("samurai:workspace-server:transfer:preflight", workspaceTransferPreflightHandler);
  ipcMain.handle("samurai:workspace-transfer:execute", workspaceTransferExecuteHandler);
  ipcMain.handle("samurai:workspace-server:transfer:execute", workspaceTransferExecuteHandler);
  ipcMain.handle("samurai:workspace-transfer:status", workspaceTransferStatusHandler);
  ipcMain.handle("samurai:workspace-server:transfer:status", workspaceTransferStatusHandler);
  ipcMain.handle("samurai:workspace-transfer:list", () => listWorkspaceTransfers());
  ipcMain.handle("samurai:workspace-server:transfer:list", () => listWorkspaceTransfers());
  const workspaceCreateHandler = async (_event: unknown, input: unknown) => {
    const value = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
    // The current Server contract requires an explicit Workspace ID. Generate
    // one in Main when an older renderer omitted it; the operation remains
    // idempotent because the generated ID is signed with the operation ID.
    const requestInput = {
      ...value,
      ...(typeof value.workspaceId === "string" && value.workspaceId.trim() ? {} : { workspaceId: `workspace_${randomUUID()}` })
    };
    return sanitizeOrganizationPayload(await activeOrganizationServerRequest(workspaceCreateRequest(requestInput)));
  };
  ipcMain.handle("samurai:workspace-server:workspace:create", workspaceCreateHandler);
  ipcMain.handle("samurai:workspace:create", workspaceCreateHandler);
  ipcMain.handle("samurai:workspace-server:bundle:export", async (_event, input: unknown) => {
    return sanitizeOrganizationPayload(await activeOrganizationServerRequest(workspaceStandaloneBundleExportRequest(input)));
  });
  ipcMain.handle("samurai:workspace-server:bundle:restore", async (_event, input: unknown) => {
    return sanitizeOrganizationPayload(await activeOrganizationServerRequest(workspaceStandaloneBundleRestoreRequest(input)));
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
  ipcMain.handle("samurai:workspace-server:organization:list", async (_event, input: unknown) => {
    return sanitizeOrganizationPayload(await activeOrganizationServerRequest(workspaceOrganizationListRequest(input)));
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
  ipcMain.handle("samurai:workspace-server:organization:workspace:attach", async (_event, input: unknown) => {
    return sanitizeOrganizationPayload(await activeOrganizationServerRequest(workspaceOrganizationWorkspaceAttachRequest(input)));
  });
  ipcMain.handle("samurai:workspace-server:organization:workspace:detach", async (_event, input: unknown) => {
    const request = workspaceOrganizationWorkspaceDetachRequest(input);
    const result = await activeOrganizationServerRequest(request);
    const value = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
    if (value.workspaceId === activeWorkspaceId && value.organizationId === activeOrganizationId) {
      await persistActiveWorkspaceSelection({ organizationId: undefined, workspaceId: activeWorkspaceId, roomId: undefined });
    }
    return sanitizeOrganizationPayload(result);
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
    await activateAuthorizedWorkspaceTarget(selectionTargetRef(selection), selection);
    return publicWorkspaceConnections();
  });
  ipcMain.handle("samurai:workspace-server:selection:room", async (_event, input: unknown) => {
    const selection = workspaceSelectionInput(input);
    if (!selection.roomId) throw new Error("roomId_invalid");
    await activateAuthorizedWorkspaceTarget(selectionTargetRef(selection), selection);
    return publicWorkspaceConnections();
  });
  // Browser bridge compatibility accepts the compact Workspace-only form. A
  // string is resolved against the current connection only, never globally.
  ipcMain.handle("samurai:workspace-server:selection:set", async (_event, input: unknown) => {
    const selection = workspaceSelectionInput(input);
    await activateAuthorizedWorkspaceTarget(selectionTargetRef(selection), selection);
    return publicWorkspaceConnections();
  });
  ipcMain.handle("samurai:workspace-server:chat:run:cancel", async (_event, input: unknown) => {
    const request = workspaceChatRunControlRequest(input, "cancel");
    const workspaceSnapshot = captureWorkspaceTargetSnapshot(request.target);
    return snapshotWorkspaceServerRequest(workspaceSnapshot, {
      method: "POST",
      path: `${workspaceChatPath(workspaceSnapshot.workspaceId)}/runs/${encodeURIComponent(request.runId)}/cancel`,
      workspaceScoped: true,
      operationId: request.operationId,
      idempotencyKey: request.operationId,
      body: request.body
    });
  });
  ipcMain.handle("samurai:workspace-server:chat:run:stop", async (_event, input: unknown) => {
    const request = workspaceChatRunControlRequest(input, "cancel");
    const workspaceSnapshot = captureWorkspaceTargetSnapshot(request.target);
    return snapshotWorkspaceServerRequest(workspaceSnapshot, {
      method: "POST",
      path: `${workspaceChatPath(workspaceSnapshot.workspaceId)}/runs/${encodeURIComponent(request.runId)}/cancel`,
      workspaceScoped: true,
      operationId: request.operationId,
      idempotencyKey: request.operationId,
      body: request.body
    });
  });
  ipcMain.handle("samurai:workspace-server:chat:run:retry", async (_event, input: unknown) => {
    const request = workspaceChatRunControlRequest(input, "retry");
    const workspaceSnapshot = captureWorkspaceTargetSnapshot(request.target);
    return snapshotWorkspaceServerRequest(workspaceSnapshot, {
      method: "POST",
      path: `${workspaceChatPath(workspaceSnapshot.workspaceId)}/runs/${encodeURIComponent(request.runId)}/retry`,
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
  ipcMain.handle("samurai:workspace-server:rooms:list", async (_event, input: unknown) => {
    const workspaceSnapshot = captureWorkspaceTargetSnapshot(workspaceTargetFromInput(input));
    const response = await snapshotWorkspaceDomainApiClient(workspaceSnapshot).executeQuery<PublicRoomRecord[]>(workspaceSnapshot.workspaceId, "room.list", { context: {}, input: {} });
    assertActiveWorkspaceSnapshot(workspaceSnapshot);
    return { rooms: response.result.map(toDesktopWorkspaceRoom) };
  });
  ipcMain.handle("samurai:workspace-server:agents:list", async (_event, input: unknown) => {
    const workspaceSnapshot = captureWorkspaceTargetSnapshot(workspaceTargetFromInput(input));
    const response = await snapshotWorkspaceDomainApiClient(workspaceSnapshot).executeQuery<PublicAgentRecord[]>(workspaceSnapshot.workspaceId, "agent.list", { context: {}, input: {} });
    assertActiveWorkspaceSnapshot(workspaceSnapshot);
    return { agents: sanitizeWorkspaceAgentListPayload(response.result, workspaceSnapshot.workspaceId) };
  });
  ipcMain.handle("samurai:workspace-server:agents:list-target", async (_event, input: unknown) => {
    const request = workspaceAgentListRequest(input);
    const workspaceSnapshot = captureWorkspaceTargetSnapshot(request.target);
    const response = await snapshotWorkspaceDomainApiClient(workspaceSnapshot).executeQuery<PublicAgentRecord[]>(workspaceSnapshot.workspaceId, "agent.list", { context: {}, input: {} });
    assertActiveWorkspaceSnapshot(workspaceSnapshot);
    return { agents: sanitizeWorkspaceAgentListPayload(response.result, workspaceSnapshot.workspaceId) };
  });
  ipcMain.handle("samurai:workspace-server:agent-backends:list-target", async (_event, input: unknown) => {
    const request = workspaceAgentListRequest(input);
    const workspaceSnapshot = captureWorkspaceTargetSnapshot(request.target);
    const response = await snapshotWorkspaceDomainApiClient(workspaceSnapshot).executeQuery<unknown>(workspaceSnapshot.workspaceId, "agent.backend.list", { context: {}, input: {} });
    assertActiveWorkspaceSnapshot(workspaceSnapshot);
    return sanitizeWorkspaceAgentBackendListPayload(response.result);
  });
  ipcMain.handle("samurai:workspace-server:agent:view", async (_event, input: unknown) => {
    const request = workspaceAgentViewRequest(input);
    const workspaceSnapshot = captureWorkspaceTargetSnapshot(request.target);
    const response = await snapshotWorkspaceDomainApiClient(workspaceSnapshot).executeQuery<PublicAgentRecord>(workspaceSnapshot.workspaceId, "agent.view", { context: {}, input: { id: request.agentId } });
    assertActiveWorkspaceSnapshot(workspaceSnapshot);
    const agent = sanitizeWorkspaceAgentDetailPayload(response.result, workspaceSnapshot.workspaceId);
    if (agent.id !== request.agentId) throw new Error("workspace_agent_response_scope_invalid");
    return agent;
  });
  ipcMain.handle("samurai:workspace-server:agent:create", async (_event, input: unknown) => {
    const request = workspaceAgentCreateRequest(input);
    const workspaceSnapshot = captureWorkspaceTargetSnapshot(request.target);
    const response = await snapshotWorkspaceDomainApiClient(workspaceSnapshot).executeOperation<PublicAgentRecord>(workspaceSnapshot.workspaceId, "agent.create", { context: {}, input: request.body }, { operationId: request.operationId, idempotencyKey: request.operationId });
    assertActiveWorkspaceSnapshot(workspaceSnapshot);
    const agent = sanitizeWorkspaceAgentDetailPayload(response.result, workspaceSnapshot.workspaceId);
    return { ...agent, replayed: response.replayed };
  });
  ipcMain.handle("samurai:workspace-server:agent:patch", async (_event, input: unknown) => {
    const request = workspaceAgentPatchRequest(input);
    const workspaceSnapshot = captureWorkspaceTargetSnapshot(request.target);
    const response = await snapshotWorkspaceDomainApiClient(workspaceSnapshot).executeOperation<PublicAgentRecord>(workspaceSnapshot.workspaceId, "agent.patch", { context: {}, input: request.body }, { operationId: request.operationId, idempotencyKey: request.operationId });
    assertActiveWorkspaceSnapshot(workspaceSnapshot);
    const agent = sanitizeWorkspaceAgentDetailPayload(response.result, workspaceSnapshot.workspaceId);
    if (agent.id !== request.body.id) throw new Error("workspace_agent_response_scope_invalid");
    return { ...agent, replayed: response.replayed };
  });
  ipcMain.handle("samurai:workspace-server:agent:backend-bind", async (_event, input: unknown) => {
    const request = workspaceAgentBackendBindRequest(input);
    const workspaceSnapshot = captureWorkspaceTargetSnapshot(request.target);
    const response = await snapshotWorkspaceDomainApiClient(workspaceSnapshot).executeOperation<PublicAgentRecord>(workspaceSnapshot.workspaceId, "agent.backend.bind", { context: {}, input: request.body }, { operationId: request.operationId, idempotencyKey: request.operationId });
    assertActiveWorkspaceSnapshot(workspaceSnapshot);
    const agent = sanitizeWorkspaceAgentDetailPayload(response.result, workspaceSnapshot.workspaceId);
    if (agent.id !== request.body.id) throw new Error("workspace_agent_response_scope_invalid");
    return { ...agent, replayed: response.replayed };
  });
  ipcMain.handle("samurai:workspace-server:room-agent-members:list", async (_event, input: unknown) => {
    const request = workspaceRoomAgentMemberListRequest(input);
    const workspaceSnapshot = captureWorkspaceTargetSnapshot(request.target);
    const response = await snapshotWorkspaceDomainApiClient(workspaceSnapshot).executeQuery<unknown>(workspaceSnapshot.workspaceId, "room.member.list", { context: { room_id: request.roomId }, input: {} });
    assertActiveWorkspaceSnapshot(workspaceSnapshot);
    return sanitizeWorkspaceRoomAgentMemberListPayload(response.result, request.roomId);
  });
  ipcMain.handle("samurai:workspace-server:room-agent-permission:set", async (_event, input: unknown) => {
    const request = workspaceRoomAgentPermissionRequest(input);
    const workspaceSnapshot = captureWorkspaceTargetSnapshot(request.target);
    const response = await snapshotWorkspaceDomainApiClient(workspaceSnapshot).executeOperation<unknown>(workspaceSnapshot.workspaceId, "room.agent.permission.set", { context: { room_id: request.roomId }, input: request.body }, { operationId: request.operationId, idempotencyKey: request.operationId });
    assertActiveWorkspaceSnapshot(workspaceSnapshot);
    const permission = sanitizeWorkspaceRoomAgentPermissionPayload(response.result, request.roomId);
    if (permission.agentId !== request.agentId) throw new Error("workspace_room_agent_response_scope_invalid");
    return { ...permission, replayed: response.replayed };
  });
  ipcMain.handle("samurai:workspace-server:room-agent:remove", async (_event, input: unknown) => {
    const request = workspaceRoomAgentRemoveRequest(input);
    const workspaceSnapshot = captureWorkspaceTargetSnapshot(request.target);
    const response = await snapshotWorkspaceDomainApiClient(workspaceSnapshot).executeOperation<unknown>(workspaceSnapshot.workspaceId, "room.agent.remove", { context: { room_id: request.roomId }, input: request.body }, { operationId: request.operationId, idempotencyKey: request.operationId });
    assertActiveWorkspaceSnapshot(workspaceSnapshot);
    const permission = sanitizeWorkspaceRoomAgentPermissionPayload(response.result, request.roomId);
    if (permission.agentId !== request.agentId) throw new Error("workspace_room_agent_response_scope_invalid");
    return { ...permission, replayed: response.replayed };
  });
  ipcMain.handle("samurai:workspace-server:room-work:list", async (_event, input: unknown) => {
    const workspaceSnapshot = captureWorkspaceTargetSnapshot(workspaceTargetFromInput(input));
    const roomId = requiredWorkspaceOpaqueField(input, "roomId");
    const value = publicRoomWorkInput(input);
    const response = await snapshotWorkspaceDomainApiClient(workspaceSnapshot).executeQuery<unknown>(workspaceSnapshot.workspaceId, "room.work.list", {
      context: { room_id: roomId },
      input: {
        ...(typeof value.status === "string" ? { status: value.status } : {}),
        ...(typeof value.cursor === "string" ? { cursor: value.cursor } : {}),
        ...(typeof value.limit === "number" ? { limit: value.limit } : {})
      }
    });
    assertActiveWorkspaceSnapshot(workspaceSnapshot);
    assertRoomWorkListResponseScope(response.result, roomId);
    return sanitizeRoomWorkListPayload(response.result, roomId);
  });
  ipcMain.handle("samurai:workspace-server:room-work:view", async (_event, input: unknown) => {
    const workspaceSnapshot = captureWorkspaceTargetSnapshot(workspaceTargetFromInput(input));
    const roomId = requiredWorkspaceOpaqueField(input, "roomId");
    const workId = requiredWorkspaceOpaqueField(input, "workId");
    const response = await snapshotWorkspaceDomainApiClient(workspaceSnapshot).executeQuery<unknown>(workspaceSnapshot.workspaceId, "room.work.view", {
      context: { room_id: roomId },
        input: { work_id: workId }
      });
    assertActiveWorkspaceSnapshot(workspaceSnapshot);
    assertRoomWorkResponseScope(response.result, roomId, workId);
    return sanitizeRoomWorkPayload(response.result);
  });
  ipcMain.handle("samurai:workspace-server:room-work:create", async (_event, input: unknown) => {
    const workspaceSnapshot = captureWorkspaceTargetSnapshot(workspaceTargetFromInput(input));
    const roomId = requiredWorkspaceOpaqueField(input, "roomId");
    const operationId = requiredWorkspaceOpaqueField(input, "operationId");
    const value = publicRoomWorkInput(input);
    const resourceRefs = roomWorkResourceRefsInput(value.resourceRefs);
    const response = await snapshotWorkspaceDomainApiClient(workspaceSnapshot).executeOperation<unknown>(workspaceSnapshot.workspaceId, "room.work.create", {
      context: { room_id: roomId },
      input: {
        ...(typeof value.instruction === "string" ? { instruction: value.instruction } : {}),
        ...(Array.isArray(value.attachments) ? { attachments: value.attachments } : {}),
        ...(resourceRefs.length ? { resource_refs: resourceRefs } : {}),
        ...(typeof value.agentId === "string" ? { agent_id: value.agentId } : {})
      }
    }, { operationId, idempotencyKey: operationId });
    assertActiveWorkspaceSnapshot(workspaceSnapshot);
    assertRoomWorkResponseScope(response.result, roomId);
    return roomWorkReplayPayload(response.result, response.replayed);
  });
  ipcMain.handle("samurai:workspace-server:room-work:reply", async (_event, input: unknown) => {
    const workspaceSnapshot = captureWorkspaceTargetSnapshot(workspaceTargetFromInput(input));
    const roomId = requiredWorkspaceOpaqueField(input, "roomId");
    const workId = requiredWorkspaceOpaqueField(input, "workId");
    const operationId = requiredWorkspaceOpaqueField(input, "operationId");
    const value = publicRoomWorkInput(input);
    const resourceRefs = roomWorkResourceRefsInput(value.resourceRefs);
    const response = await snapshotWorkspaceDomainApiClient(workspaceSnapshot).executeOperation<unknown>(workspaceSnapshot.workspaceId, "room.work.reply", {
      context: { room_id: roomId },
      input: {
        work_id: workId,
        ...(typeof value.assigneeId === "string" ? { assignee_id: value.assigneeId } : {}),
        ...(typeof value.instruction === "string" ? { instruction: value.instruction } : {}),
        ...(Array.isArray(value.attachments) ? { attachments: value.attachments } : {}),
        ...(resourceRefs.length ? { resource_refs: resourceRefs } : {}),
        ...(typeof value.expectedVersion === "number" ? { expected_version: value.expectedVersion } : {}),
        ...(typeof value.expectedGeneration === "number" ? { expected_generation: value.expectedGeneration } : {})
      }
    }, { operationId, idempotencyKey: operationId });
    assertActiveWorkspaceSnapshot(workspaceSnapshot);
    assertRoomWorkResponseScope(response.result, roomId, workId);
    return roomWorkReplayPayload(response.result, response.replayed);
  });
  ipcMain.handle("samurai:workspace-server:room-work:comment:create", async (_event, input: unknown) => {
    const workspaceSnapshot = captureWorkspaceTargetSnapshot(workspaceTargetFromInput(input));
    const roomId = requiredWorkspaceOpaqueField(input, "roomId");
    const workId = requiredWorkspaceOpaqueField(input, "workId");
    const operationId = requiredWorkspaceOpaqueField(input, "operationId");
    const value = publicRoomWorkInput(input);
    const response = await snapshotWorkspaceDomainApiClient(workspaceSnapshot).executeOperation<unknown>(workspaceSnapshot.workspaceId, "room.work.comment.create", {
      context: { room_id: roomId },
      input: {
        work_id: workId,
        ...(typeof value.body === "string" ? { body: value.body } : {}),
        ...(Array.isArray(value.attachments) ? { attachments: value.attachments } : {}),
        ...(typeof value.expectedVersion === "number" ? { expected_version: value.expectedVersion } : {})
      }
    }, { operationId, idempotencyKey: operationId });
    assertActiveWorkspaceSnapshot(workspaceSnapshot);
    assertRoomWorkResponseScope(response.result, roomId, workId);
    return roomWorkReplayPayload(response.result, response.replayed);
  });
  ipcMain.handle("samurai:workspace-server:room-work:comment:apply", async (_event, input: unknown) => {
    const workspaceSnapshot = captureWorkspaceTargetSnapshot(workspaceTargetFromInput(input));
    const roomId = requiredWorkspaceOpaqueField(input, "roomId");
    const workId = requiredWorkspaceOpaqueField(input, "workId");
    const commentId = requiredWorkspaceOpaqueField(input, "commentId");
    const operationId = requiredWorkspaceOpaqueField(input, "operationId");
    const value = publicRoomWorkInput(input);
    if (typeof value.commentVersion !== "number") throw new Error("commentVersion_invalid");
    const response = await snapshotWorkspaceDomainApiClient(workspaceSnapshot).executeOperation<unknown>(workspaceSnapshot.workspaceId, "room.work.comment.apply", {
      context: { room_id: roomId },
      input: {
        work_id: workId,
        comment_id: commentId,
        comment_version: value.commentVersion,
        ...(typeof value.assigneeId === "string" ? { assignee_id: value.assigneeId } : {}),
        ...(typeof value.expectedVersion === "number" ? { expected_version: value.expectedVersion } : {}),
        ...(typeof value.expectedGeneration === "number" ? { expected_generation: value.expectedGeneration } : {})
      }
    }, { operationId, idempotencyKey: operationId });
    assertActiveWorkspaceSnapshot(workspaceSnapshot);
    assertRoomWorkResponseScope(response.result, roomId, workId);
    return roomWorkReplayPayload(response.result, response.replayed);
  });
  ipcMain.handle("samurai:workspace-server:room-work:comment:reaction", async (_event, input: unknown) => {
    const workspaceSnapshot = captureWorkspaceTargetSnapshot(workspaceTargetFromInput(input));
    const roomId = requiredWorkspaceOpaqueField(input, "roomId");
    const workId = requiredWorkspaceOpaqueField(input, "workId");
    const commentId = requiredWorkspaceOpaqueField(input, "commentId");
    const operationId = requiredWorkspaceOpaqueField(input, "operationId");
    const value = publicRoomWorkInput(input);
    if (value.reaction !== undefined && value.reaction !== "like") throw new Error("reaction_invalid");
    const response = await snapshotWorkspaceDomainApiClient(workspaceSnapshot).executeOperation<unknown>(workspaceSnapshot.workspaceId, "room.work.comment.reaction.set", {
      context: { room_id: roomId },
      input: {
        work_id: workId,
        comment_id: commentId,
        reaction: "like",
        enabled: value.enabled !== false,
        ...(typeof value.expectedVersion === "number" ? { expected_version: value.expectedVersion } : {})
      }
    }, { operationId, idempotencyKey: operationId });
    assertActiveWorkspaceSnapshot(workspaceSnapshot);
    assertRoomWorkResponseScope(response.result, roomId, workId);
    return roomWorkReplayPayload(response.result, response.replayed);
  });
  ipcMain.handle("samurai:workspace-server:room-work:stop", async (_event, input: unknown) => {
    return executeRoomWorkControlIpc("room.work.stop", input, { workOnly: true });
  });
  ipcMain.handle("samurai:workspace-server:room-work:assignee:stop", async (_event, input: unknown) => {
    return executeRoomWorkControlIpc("room.work.assignee.stop", input, { workOnly: false });
  });
  const reassignWorkspaceRoomWorkHandler = async (_event: unknown, input: unknown) => {
    const workspaceSnapshot = captureWorkspaceTargetSnapshot(workspaceTargetFromInput(input));
    const roomId = requiredWorkspaceOpaqueField(input, "roomId");
    const workId = requiredWorkspaceOpaqueField(input, "workId");
    const assigneeId = requiredWorkspaceOpaqueField(input, "assigneeId");
    const agentId = requiredWorkspaceOpaqueField(input, "agentId");
    const operationId = requiredWorkspaceOpaqueField(input, "operationId");
    const value = publicRoomWorkInput(input);
    const response = await snapshotWorkspaceDomainApiClient(workspaceSnapshot).executeOperation<unknown>(workspaceSnapshot.workspaceId, "room.work.assignee.reassign", {
      context: { room_id: roomId },
      input: {
        work_id: workId,
        assignee_id: assigneeId,
        agent_id: agentId,
        ...(typeof value.expectedVersion === "number" ? { expected_version: value.expectedVersion } : {}),
        ...(typeof value.expectedGeneration === "number" ? { expected_generation: value.expectedGeneration } : {})
      }
    }, { operationId, idempotencyKey: operationId });
    assertActiveWorkspaceSnapshot(workspaceSnapshot);
    assertRoomWorkResponseScope(response.result, roomId, workId);
    return roomWorkReplayPayload(response.result, response.replayed);
  };
  ipcMain.handle("samurai:workspace-server:room-work:assignee:reassign", reassignWorkspaceRoomWorkHandler);
  ipcMain.handle("samurai:workspace-server:room-work:assignee:delegate", async (_event, input: unknown) => {
    const workspaceSnapshot = captureWorkspaceTargetSnapshot(workspaceTargetFromInput(input));
    const roomId = requiredWorkspaceOpaqueField(input, "roomId");
    const workId = requiredWorkspaceOpaqueField(input, "workId");
    const assigneeId = requiredWorkspaceOpaqueField(input, "assigneeId");
    const agentId = requiredWorkspaceOpaqueField(input, "agentId");
    const operationId = requiredWorkspaceOpaqueField(input, "operationId");
    const value = publicRoomWorkInput(input);
    const dependencyAssigneeIds = Array.isArray(value.dependencyAssigneeIds)
      ? value.dependencyAssigneeIds.filter((item): item is string => typeof item === "string").slice(0, 100)
      : [];
    const response = await snapshotWorkspaceDomainApiClient(workspaceSnapshot).executeOperation<unknown>(workspaceSnapshot.workspaceId, "room.work.assignee.delegate", {
      context: { room_id: roomId },
      input: {
        work_id: workId,
        assignee_id: assigneeId,
        agent_id: agentId,
        ...(typeof value.instruction === "string" ? { instruction: value.instruction } : {}),
        ...(dependencyAssigneeIds.length ? { dependency_assignee_ids: dependencyAssigneeIds } : {}),
        ...(Array.isArray(value.attachments) ? { attachments: value.attachments } : {}),
        ...(typeof value.expectedVersion === "number" ? { expected_version: value.expectedVersion } : {}),
        ...(typeof value.expectedGeneration === "number" ? { expected_generation: value.expectedGeneration } : {})
      }
    }, { operationId, idempotencyKey: operationId });
    assertActiveWorkspaceSnapshot(workspaceSnapshot);
    assertRoomWorkResponseScope(response.result, roomId, workId);
    assertRoomWorkDelegateResponseScope(response.result, workId, assigneeId, agentId);
    return roomWorkReplayPayload(response.result, response.replayed);
  });
  ipcMain.handle("samurai:workspace-server:room:default-agent:set", async (_event, input: unknown) => {
    const request = workspaceRoomDefaultAgentRequest(input);
    const workspaceSnapshot = captureWorkspaceTargetSnapshot(request.target);
    const response = await snapshotWorkspaceDomainApiClient(workspaceSnapshot).executeOperation<unknown>(workspaceSnapshot.workspaceId, "room.default_agent.set", {
      context: { room_id: request.roomId },
      input: request.body
    }, { operationId: request.operationId, idempotencyKey: request.operationId });
    assertActiveWorkspaceSnapshot(workspaceSnapshot);
    assertRoomDefaultAgentResponseScope(response.result, request.roomId, request.agentId, workspaceSnapshot.workspaceId);
    return roomWorkReplayPayload(response.result, response.replayed);
  });
  ipcMain.handle("samurai:workspace-server:agent:dm:open", async (_event, input: unknown) => {
    const request = workspaceAgentDmRequest(input);
    const workspaceSnapshot = captureWorkspaceTargetSnapshot(request.target);
    const response = await snapshotWorkspaceDomainApiClient(workspaceSnapshot).executeOperation<unknown>(workspaceSnapshot.workspaceId, "agent.dm.open", {
      context: {},
      input: request.body
    }, { operationId: request.operationId, idempotencyKey: request.operationId });
    assertActiveWorkspaceSnapshot(workspaceSnapshot);
    assertAgentDmResponseScope(response.result, request.agentId, workspaceSnapshot.workspaceId);
    return roomWorkReplayPayload(response.result, response.replayed, agentDmPublicPayloadKeys);
  });
  ipcMain.handle("samurai:workspace-server:events:list", async (_event, input: unknown) => {
    const workspaceSnapshot = captureWorkspaceTargetSnapshot(workspaceTargetFromInput(input));
    const value = publicRoomWorkInput(input);
    const page = await snapshotWorkspaceDomainApiClient(workspaceSnapshot).listEvents(workspaceSnapshot.workspaceId, {
      ...(typeof value.roomId === "string" ? { roomId: requiredWorkspaceOpaqueField(value, "roomId") } : {}),
      ...(typeof value.afterCursor === "string" ? { afterCursor: value.afterCursor } : {}),
      ...(typeof value.limit === "number" ? { limit: value.limit } : {})
    });
    assertActiveWorkspaceSnapshot(workspaceSnapshot);
    return sanitizeWorkspaceEventPage(page);
  });
  ipcMain.handle("samurai:workspace-server:settings:get", async (_event, input: unknown) => {
    const workspaceSnapshot = captureWorkspaceTargetSnapshot(workspaceTargetFromInput(input));
    return snapshotWorkspaceServerRequest(workspaceSnapshot, {
      method: "GET",
      path: workspaceSettingsPath(workspaceSnapshot.workspaceId),
      workspaceScoped: true
    });
  });
  ipcMain.handle("samurai:workspace-server:settings:patch", async (_event, input: unknown) => {
    const request = workspaceSettingsPatchRequest(input);
    const workspaceSnapshot = captureWorkspaceTargetSnapshot(request.target);
    return snapshotWorkspaceServerRequest(workspaceSnapshot, {
      method: "PATCH",
      path: workspaceSettingsPath(workspaceSnapshot.workspaceId),
      workspaceScoped: true,
      operationId: request.operationId,
      body: workspaceSettingsPatchJson(request.body)
    });
  });
  ipcMain.handle("samurai:workspace-server:surface:contract", async (_event, source: unknown) => {
    const value = source && typeof source === "object" && !Array.isArray(source) ? source as Record<string, unknown> : undefined;
    const sourceValue = typeof source === "string" ? source : typeof value?.source === "string" ? value.source : undefined;
    const query = sourceValue && sourceValue.length > 0 ? `?source=${encodeURIComponent(sourceValue.slice(0, 80))}` : "";
    const workspaceSnapshot = captureWorkspaceTargetSnapshot(workspaceTargetFromInput(value));
    return snapshotWorkspaceServerRequest(workspaceSnapshot, {
      method: "GET",
      path: `${workspaceChatPath(workspaceSnapshot.workspaceId).replace(/\/chat$/, "")}/surface/contract${query}`,
      workspaceScoped: true
    });
  });
  ipcMain.handle("samurai:workspace-server:chat:sessions:list", async (_event, input: unknown) => {
    const workspaceSnapshot = captureWorkspaceTargetSnapshot(workspaceTargetFromInput(input));
    return snapshotWorkspaceServerRequest(workspaceSnapshot, {
      method: "GET",
      path: `${workspaceChatPath(workspaceSnapshot.workspaceId)}/sessions`,
      workspaceScoped: true
    });
  });
  ipcMain.handle("samurai:workspace-server:chat:session:create", async (_event, input: unknown) => {
    const request = workspaceChatSessionRequest(input);
    const workspaceSnapshot = captureWorkspaceTargetSnapshot(request.target);
    const { room_id: _roomId, ...operationInput } = request.body;
    const response = await snapshotWorkspaceDomainApiClient(workspaceSnapshot).executeOperation(workspaceSnapshot.workspaceId, "session.create", {
      context: { room_id: request.roomId },
      input: operationInput
    }, { operationId: request.operationId, idempotencyKey: request.operationId });
    return response.result;
  });
  ipcMain.handle("samurai:workspace-server:chat:session:get", async (_event, input: unknown) => {
    const request = workspaceChatSessionIdRequest(input);
    const workspaceSnapshot = captureWorkspaceTargetSnapshot(request.target);
    return snapshotWorkspaceServerRequest(workspaceSnapshot, {
      method: "GET",
      path: `${workspaceChatPath(workspaceSnapshot.workspaceId)}/sessions/${encodeURIComponent(request.sessionId)}`,
      workspaceScoped: true
    });
  });
  ipcMain.handle("samurai:workspace-server:chat:message:send", async (_event, input: unknown) => {
    const request = workspaceChatTurnRequest(input);
    const workspaceSnapshot = captureWorkspaceTargetSnapshot(request.target);
    const response = await snapshotWorkspaceDomainApiClient(workspaceSnapshot).executeOperation(workspaceSnapshot.workspaceId, "chat.turn.run", {
      context: { session_id: request.sessionId },
      input: request.body
    }, { operationId: request.idempotencyKey, idempotencyKey: request.idempotencyKey });
    return response.result;
  });
  ipcMain.handle("samurai:workspace-server:files:attachment:write", async (_event, input: unknown) => {
    const request = workspaceAttachmentRequest(input);
    const workspaceSnapshot = captureWorkspaceTargetSnapshot(request.target);
    const result = await snapshotWorkspaceServerRequest(workspaceSnapshot, {
      method: "PUT",
      path: `${workspaceFilesPath(workspaceSnapshot.workspaceId)}/${request.filePath.split("/").map((part) => encodeURIComponent(part)).join("/")}`,
      workspaceScoped: true,
      operationId: request.operationId,
      body: request.body
    });
    assertActiveWorkspaceSnapshot(workspaceSnapshot);
    return result;
  });
  ipcMain.handle("samurai:workspace-server:chat:search", async (_event, input: unknown) => {
    const roomId = requiredWorkspaceOpaqueField(input, "roomId");
    const value = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
    if (typeof value.query !== "string" || !value.query.trim() || value.query.length > 200_000) throw new Error("query_invalid");
    const workspaceSnapshot = captureWorkspaceTargetSnapshot(workspaceTargetFromInput(value));
    return snapshotWorkspaceServerRequest(workspaceSnapshot, {
      method: "GET",
      path: `${workspaceChatPath(workspaceSnapshot.workspaceId)}/search?room_id=${encodeURIComponent(roomId)}&q=${encodeURIComponent(value.query.trim())}`,
      workspaceScoped: true
    });
  });
  ipcMain.handle("samurai:workspace-server:chat:runs:list", async (_event, input: unknown) => {
    const value = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
    const sessionId = typeof value.sessionId === "string" ? requiredWorkspaceOpaqueField(value, "sessionId") : undefined;
    const workspaceSnapshot = captureWorkspaceTargetSnapshot(workspaceTargetFromInput(value));
    return snapshotWorkspaceServerRequest(workspaceSnapshot, {
      method: "GET",
      path: `${workspaceChatPath(workspaceSnapshot.workspaceId)}/runs${sessionId ? `?session_id=${encodeURIComponent(sessionId)}` : ""}`,
      workspaceScoped: true
    });
  });
  ipcMain.handle("samurai:workspace-server:chat:run:get", async (_event, input: unknown) => {
    const runId = requiredWorkspaceOpaqueField(input, "runId");
    const workspaceSnapshot = captureWorkspaceTargetSnapshot(workspaceTargetFromInput(input));
    return snapshotWorkspaceServerRequest(workspaceSnapshot, {
      method: "GET",
      path: `${workspaceChatPath(workspaceSnapshot.workspaceId)}/runs/${encodeURIComponent(runId)}`,
      workspaceScoped: true
    });
  });
  ipcMain.handle("samurai:workspace-server:chat:events:list", async (_event, input: unknown) => {
    const runId = requiredWorkspaceOpaqueField(input, "runId");
    const workspaceSnapshot = captureWorkspaceTargetSnapshot(workspaceTargetFromInput(input));
    return snapshotWorkspaceServerRequest(workspaceSnapshot, {
      method: "GET",
      path: `${workspaceChatPath(workspaceSnapshot.workspaceId)}/runs/${encodeURIComponent(runId)}/events`,
      workspaceScoped: true
    });
  });
  ipcMain.handle("samurai:workspace-server:chat:changes:list", async (_event, input: unknown) => {
    const value = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
    const sessionId = typeof value.sessionId === "string" ? requiredWorkspaceOpaqueField(value, "sessionId") : undefined;
    const workspaceSnapshot = captureWorkspaceTargetSnapshot(workspaceTargetFromInput(value));
    return snapshotWorkspaceServerRequest(workspaceSnapshot, {
      method: "GET",
      path: `${workspaceChatPath(workspaceSnapshot.workspaceId)}/changes${sessionId ? `?session_id=${encodeURIComponent(sessionId)}` : ""}`,
      workspaceScoped: true
    });
  });
  ipcMain.handle("samurai:workspace-server:chat:activity:list", async (_event, input: unknown) => {
    const roomId = requiredWorkspaceOpaqueField(input, "roomId");
    const workspaceSnapshot = captureWorkspaceTargetSnapshot(workspaceTargetFromInput(input));
    return snapshotWorkspaceServerRequest(workspaceSnapshot, {
      method: "GET",
      path: `${workspaceChatPath(workspaceSnapshot.workspaceId)}/activity?room_id=${encodeURIComponent(roomId)}`,
      workspaceScoped: true
    });
  });
  ipcMain.handle("samurai:workspace-server:audit:get", async (_event, input: unknown) => {
    const workspaceSnapshot = captureWorkspaceTargetSnapshot(workspaceTargetFromInput(input));
    const body = await snapshotWorkspaceServerRequest(workspaceSnapshot, {
      method: "GET",
      path: `${workspaceChatPath(workspaceSnapshot.workspaceId).replace(/\/chat$/, "")}/audit`,
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
    const workspaceSnapshot = captureWorkspaceTargetSnapshot(request.target);
    const query = new URLSearchParams();
    query.set("scope_kind", request.scopeKind);
    if (request.scopeKind === "room") query.set("room_id", request.roomId);
    if (request.kind) query.set("kind", request.kind);
    if (request.includeArchived) query.set("include_archived", "true");
    if (request.cursor) query.set("cursor", request.cursor);
    return snapshotWorkspaceServerRequest(workspaceSnapshot, {
      method: "GET",
      path: `${workspaceCompletionPath(workspaceSnapshot.workspaceId)}/resources${query.size ? `?${query.toString()}` : ""}`,
      workspaceScoped: true
    });
  });
  ipcMain.handle("samurai:workspace-server:completion:resource:get", async (_event, input: unknown) => {
    const request = workspaceCompletionResourceIdRequest(input);
    const workspaceSnapshot = captureWorkspaceTargetSnapshot(request.target);
    return snapshotWorkspaceServerRequest(workspaceSnapshot, {
      method: "GET",
      path: `${workspaceCompletionPath(workspaceSnapshot.workspaceId)}/resources/${encodeURIComponent(request.resourceId)}`,
      workspaceScoped: true
    });
  });
  ipcMain.handle("samurai:workspace-server:completion:resource:body", async (_event, input: unknown) => {
    const request = workspaceCompletionResourceIdRequest(input);
    const workspaceSnapshot = captureWorkspaceTargetSnapshot(request.target);
    return snapshotWorkspaceServerRequest(workspaceSnapshot, {
      method: "GET",
      path: `${workspaceCompletionPath(workspaceSnapshot.workspaceId)}/resources/${encodeURIComponent(request.resourceId)}/body`,
      workspaceScoped: true
    });
  });
  ipcMain.handle("samurai:workspace-server:completion:resource:create", async (_event, input: unknown) => {
    const request = workspaceCompletionResourceCreateRequest(input);
    const workspaceSnapshot = captureWorkspaceTargetSnapshot(request.target);
    return snapshotWorkspaceServerRequest(workspaceSnapshot, {
      method: "POST",
      path: `${workspaceCompletionPath(workspaceSnapshot.workspaceId)}/resources`,
      workspaceScoped: true,
      operationId: request.operationId,
      body: request.body
    });
  });
  ipcMain.handle("samurai:workspace-server:completion:resource:update", async (_event, input: unknown) => {
    const request = workspaceCompletionResourceUpdateRequest(input);
    const workspaceSnapshot = captureWorkspaceTargetSnapshot(request.target);
    return snapshotWorkspaceServerRequest(workspaceSnapshot, {
      method: "PATCH",
      path: `${workspaceCompletionPath(workspaceSnapshot.workspaceId)}/resources/${encodeURIComponent(request.resourceId)}`,
      workspaceScoped: true,
      operationId: request.operationId,
      body: request.body
    });
  });
  ipcMain.handle("samurai:workspace-server:completion:resource:fixed", async (_event, input: unknown) => {
    const request = workspaceCompletionResourceStateRequest(input, "fixed");
    const workspaceSnapshot = captureWorkspaceTargetSnapshot(request.target);
    return snapshotWorkspaceServerRequest(workspaceSnapshot, {
      method: "POST",
      path: `${workspaceCompletionPath(workspaceSnapshot.workspaceId)}/resources/${encodeURIComponent(request.resourceId)}/fix`,
      workspaceScoped: true,
      operationId: request.operationId,
      body: request.body
    });
  });
  ipcMain.handle("samurai:workspace-server:completion:resource:archive", async (_event, input: unknown) => {
    const request = workspaceCompletionResourceStateRequest(input, "archive");
    const workspaceSnapshot = captureWorkspaceTargetSnapshot(request.target);
    return snapshotWorkspaceServerRequest(workspaceSnapshot, {
      method: "POST",
      path: `${workspaceCompletionPath(workspaceSnapshot.workspaceId)}/resources/${encodeURIComponent(request.resourceId)}/archive`,
      workspaceScoped: true,
      operationId: request.operationId,
      body: request.body
    });
  });
  ipcMain.handle("samurai:workspace-server:completion:knowledge:search", async (_event, input: unknown) => {
    const request = workspaceCompletionSearchRequest(input);
    const workspaceSnapshot = captureWorkspaceTargetSnapshot(request.target);
    const query = new URLSearchParams({ room_id: request.roomId, q: request.query });
    if (request.limit !== undefined) query.set("limit", String(request.limit));
    if (request.cursor) query.set("cursor", request.cursor);
    return snapshotWorkspaceServerRequest(workspaceSnapshot, {
      method: "GET",
      path: `${workspaceCompletionPath(workspaceSnapshot.workspaceId)}/knowledge/search?${query.toString()}`,
      workspaceScoped: true
    });
  });
  ipcMain.handle("samurai:workspace-server:completion:skills:list", async (_event, input: unknown) => {
    const request = workspaceCompletionResourceListRequest({ ...(input as Record<string, unknown>), scopeKind: "room" });
    const roomId = request.roomId!;
    const workspaceSnapshot = captureWorkspaceTargetSnapshot(workspaceTargetFromInput(input));
    return snapshotWorkspaceServerRequest(workspaceSnapshot, {
      method: "GET",
      path: `${workspaceCompletionPath(workspaceSnapshot.workspaceId)}/skills?room_id=${encodeURIComponent(roomId)}${request.includeArchived ? "&include_archived=true" : ""}${request.cursor ? `&cursor=${encodeURIComponent(request.cursor)}` : ""}`,
      workspaceScoped: true
    });
  });
  ipcMain.handle("samurai:workspace-server:completion:skills:get", async (_event, input: unknown) => {
    const request = workspaceCompletionResourceIdRequest(input);
    const workspaceSnapshot = captureWorkspaceTargetSnapshot(request.target);
    return snapshotWorkspaceServerRequest(workspaceSnapshot, {
      method: "GET",
      path: `${workspaceCompletionPath(workspaceSnapshot.workspaceId)}/skills/${encodeURIComponent(request.resourceId)}`,
      workspaceScoped: true
    });
  });
  ipcMain.handle("samurai:workspace-server:skill-optimizations:list", async (_event, input: unknown) => {
    const request = workspaceSkillOptimizationListRequest(input);
    const workspaceSnapshot = captureWorkspaceTargetSnapshot(request.target);
    const query = new URLSearchParams();
    if (request.skillId) query.set("skill_id", request.skillId);
    if (request.roomId) query.set("room_id", request.roomId);
    if (request.limit !== undefined) query.set("limit", String(request.limit));
    return snapshotWorkspaceServerRequest(workspaceSnapshot, {
      method: "GET",
      path: `${workspaceSkillOptimizationPath(workspaceSnapshot.workspaceId)}${query.size ? `?${query.toString()}` : ""}`,
      workspaceScoped: true
    });
  });
  ipcMain.handle("samurai:workspace-server:skill-optimizations:get", async (_event, input: unknown) => {
    const request = workspaceSkillOptimizationIdRequest(input);
    const workspaceSnapshot = captureWorkspaceTargetSnapshot(request.target);
    return snapshotWorkspaceServerRequest(workspaceSnapshot, {
      method: "GET",
      path: `${workspaceSkillOptimizationPath(workspaceSnapshot.workspaceId)}/${encodeURIComponent(request.runId)}`,
      workspaceScoped: true
    });
  });
  ipcMain.handle("samurai:workspace-server:skill-optimizations:start", async (_event, input: unknown) => {
    const request = workspaceSkillOptimizationStartRequest(input);
    const workspaceSnapshot = captureWorkspaceTargetSnapshot(request.target);
    return snapshotWorkspaceServerRequest(workspaceSnapshot, {
      method: "POST",
      path: `${workspaceSkillsPath(workspaceSnapshot.workspaceId)}/${encodeURIComponent(request.skillId)}/optimizations`,
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
    const workspaceSnapshot = captureWorkspaceTargetSnapshot(request.target);
    return snapshotWorkspaceServerRequest(workspaceSnapshot, {
      method: "POST",
      path: `${workspaceSkillOptimizationPath(workspaceSnapshot.workspaceId)}/${encodeURIComponent(request.runId)}/${request.action}`,
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
    const workspaceSnapshot = captureWorkspaceTargetSnapshot(request.target);
    const query = new URLSearchParams({ room_id: request.roomId });
    if (request.includeArchived) query.set("include_archived", "true");
    return snapshotWorkspaceServerRequest(workspaceSnapshot, { method: "GET", path: `${workspaceKnowledgeWikiPath(workspaceSnapshot.workspaceId)}?${query.toString()}`, workspaceScoped: true });
  });
  ipcMain.handle("samurai:workspace-server:knowledge-wiki:get", async (_event, input: unknown) => {
    const request = workspaceWikiIdRequest(input);
    const workspaceSnapshot = captureWorkspaceTargetSnapshot(request.target);
    return snapshotWorkspaceServerRequest(workspaceSnapshot, { method: "GET", path: `${workspaceKnowledgeWikiPath(workspaceSnapshot.workspaceId)}/${encodeURIComponent(request.wikiId)}`, workspaceScoped: true });
  });
  ipcMain.handle("samurai:workspace-server:knowledge-wiki:create", async (_event, input: unknown) => {
    const request = workspaceWikiCreateRequest(input);
    const workspaceSnapshot = captureWorkspaceTargetSnapshot(request.target);
    return snapshotWorkspaceServerRequest(workspaceSnapshot, { method: "POST", path: `${workspaceKnowledgeWikiPath(workspaceSnapshot.workspaceId)}/proposals`, workspaceScoped: true, operationId: request.operationId, body: request.body });
  });
  ipcMain.handle("samurai:workspace-server:knowledge-wiki:update", async (_event, input: unknown) => {
    const request = workspaceWikiPatchRequest(input);
    const workspaceSnapshot = captureWorkspaceTargetSnapshot(request.target);
    return snapshotWorkspaceServerRequest(workspaceSnapshot, { method: "PATCH", path: `${workspaceKnowledgeWikiPath(workspaceSnapshot.workspaceId)}/${encodeURIComponent(request.wikiId)}`, workspaceScoped: true, operationId: request.operationId, body: request.body });
  });
  ipcMain.handle("samurai:workspace-server:knowledge-wiki:state", async (_event, input: unknown) => {
    const request = workspaceWikiStateRequest(input);
    const state = input && typeof input === "object" && "state" in input && (input as Record<string, unknown>).state;
    if (state !== "accept" && state !== "reject" && state !== "archive") throw new Error("wiki_state_invalid");
    const suffix = state === "accept" ? "accept" : state === "reject" ? "reject" : "archive";
    const workspaceSnapshot = captureWorkspaceTargetSnapshot(request.target);
    return snapshotWorkspaceServerRequest(workspaceSnapshot, { method: "POST", path: `${workspaceKnowledgeWikiPath(workspaceSnapshot.workspaceId)}/${encodeURIComponent(request.wikiId)}/${suffix}`, workspaceScoped: true, operationId: request.operationId, body: { reason: request.reason } });
  });
  ipcMain.handle("samurai:workspace-server:knowledge-wiki:reindex", async (_event, input: unknown) => {
    const request = workspaceWikiListRequest(input);
    const workspaceSnapshot = captureWorkspaceTargetSnapshot(request.target);
    return snapshotWorkspaceServerRequest(workspaceSnapshot, { method: "POST", path: `${workspaceKnowledgeWikiPath(workspaceSnapshot.workspaceId)}/reindex`, workspaceScoped: true, body: { room_id: request.roomId } });
  });
  ipcMain.handle("samurai:workspace-server:knowledge-wiki:graph", async (_event, input: unknown) => {
    const request = workspaceWikiQueryRequest(input);
    const query = new URLSearchParams({ room_id: request.roomId });
    if (request.query) query.set("query", request.query);
    const workspaceSnapshot = captureWorkspaceTargetSnapshot(request.target);
    return snapshotWorkspaceServerRequest(workspaceSnapshot, { method: "GET", path: `${workspaceKnowledgeWikiPath(workspaceSnapshot.workspaceId)}/graph?${query.toString()}`, workspaceScoped: true });
  });
  ipcMain.handle("samurai:workspace-server:knowledge-wiki:lint", async (_event, input: unknown) => {
    const request = workspaceWikiListRequest(input);
    const workspaceSnapshot = captureWorkspaceTargetSnapshot(request.target);
    return snapshotWorkspaceServerRequest(workspaceSnapshot, { method: "GET", path: `${workspaceKnowledgeWikiPath(workspaceSnapshot.workspaceId)}/lint?room_id=${encodeURIComponent(request.roomId)}`, workspaceScoped: true });
  });
  ipcMain.handle("samurai:workspace-server:knowledge-wiki:backlinks", async (_event, input: unknown) => {
    const value = input && typeof input === "object" ? input as Record<string, unknown> : {};
    const request = workspaceWikiIdRequest(value);
    const roomId = requiredWorkspaceOpaqueField(value, "roomId");
    const workspaceSnapshot = captureWorkspaceTargetSnapshot(request.target);
    return snapshotWorkspaceServerRequest(workspaceSnapshot, { method: "GET", path: `${workspaceKnowledgeWikiPath(workspaceSnapshot.workspaceId)}/${encodeURIComponent(request.wikiId)}/backlinks?room_id=${encodeURIComponent(roomId)}`, workspaceScoped: true });
  });
  ipcMain.handle("samurai:workspace-server:knowledge-memory:list", async (_event, input: unknown) => {
    const request = workspaceMemoryListRequest(input);
    const query = new URLSearchParams({ room_id: request.roomId });
    if (request.includeArchived) query.set("include_archived", "true");
    const workspaceSnapshot = captureWorkspaceTargetSnapshot(request.target);
    return snapshotWorkspaceServerRequest(workspaceSnapshot, { method: "GET", path: `${workspaceKnowledgeMemoryPath(workspaceSnapshot.workspaceId)}?${query.toString()}`, workspaceScoped: true });
  });
  ipcMain.handle("samurai:workspace-server:knowledge-memory:get", async (_event, input: unknown) => {
    const request = workspaceMemoryIdRequest(input);
    const workspaceSnapshot = captureWorkspaceTargetSnapshot(request.target);
    return snapshotWorkspaceServerRequest(workspaceSnapshot, { method: "GET", path: `${workspaceKnowledgeMemoryPath(workspaceSnapshot.workspaceId)}/${encodeURIComponent(request.memoryId)}`, workspaceScoped: true });
  });
  ipcMain.handle("samurai:workspace-server:knowledge-memory:search", async (_event, input: unknown) => {
    const request = workspaceMemorySearchRequest(input);
    const query = new URLSearchParams({ room_id: request.roomId, q: request.query });
    if (request.limit !== undefined) query.set("limit", String(request.limit));
    const workspaceSnapshot = captureWorkspaceTargetSnapshot(request.target);
    return snapshotWorkspaceServerRequest(workspaceSnapshot, { method: "GET", path: `${workspaceKnowledgeMemoryPath(workspaceSnapshot.workspaceId)}/search?${query.toString()}`, workspaceScoped: true });
  });
  ipcMain.handle("samurai:workspace-server:knowledge-memory:archive", async (_event, input: unknown) => {
    const request = workspaceMemoryArchiveRequest(input);
    const workspaceSnapshot = captureWorkspaceTargetSnapshot(request.target);
    return snapshotWorkspaceServerRequest(workspaceSnapshot, { method: "POST", path: `${workspaceKnowledgeMemoryPath(workspaceSnapshot.workspaceId)}/${encodeURIComponent(request.memoryId)}/archive`, workspaceScoped: true, operationId: request.operationId, body: { reason: request.reason } });
  });
  ipcMain.handle("samurai:workspace-server:collections:schemas:list", async (_event, input: unknown) => {
    const request = workspaceCollectionRoomRequest(input);
    const workspaceSnapshot = captureWorkspaceTargetSnapshot(request.target);
    return snapshotWorkspaceServerRequest(workspaceSnapshot, { method: "GET", path: `${workspaceCollectionsPath(workspaceSnapshot.workspaceId)}/schemas?room_id=${encodeURIComponent(request.roomId)}`, workspaceScoped: true });
  });
  ipcMain.handle("samurai:workspace-server:collections:schema:get", async (_event, input: unknown) => {
    const request = workspaceCollectionIdRequest(input);
    const workspaceSnapshot = captureWorkspaceTargetSnapshot(request.target);
    return snapshotWorkspaceServerRequest(workspaceSnapshot, { method: "GET", path: `${workspaceCollectionsPath(workspaceSnapshot.workspaceId)}/${encodeURIComponent(request.collectionId)}/schema?room_id=${encodeURIComponent(request.roomId)}`, workspaceScoped: true });
  });
  ipcMain.handle("samurai:workspace-server:collections:schema:save", async (_event, input: unknown) => {
    const request = workspaceCollectionSchemaSaveRequest(input);
    const workspaceSnapshot = captureWorkspaceTargetSnapshot(request.target);
    return snapshotWorkspaceServerRequest(workspaceSnapshot, { method: "POST", path: `${workspaceCollectionsPath(workspaceSnapshot.workspaceId)}/schemas`, workspaceScoped: true, operationId: request.operationId, body: { room_id: request.roomId, schema: request.schema, ...(request.expectedVersion === undefined ? {} : { expected_version: request.expectedVersion }) } });
  });
  ipcMain.handle("samurai:workspace-server:collections:records:list", async (_event, input: unknown) => {
    const request = workspaceCollectionIdRequest(input);
    const workspaceSnapshot = captureWorkspaceTargetSnapshot(request.target);
    return snapshotWorkspaceServerRequest(workspaceSnapshot, { method: "GET", path: `${workspaceCollectionsPath(workspaceSnapshot.workspaceId)}/${encodeURIComponent(request.collectionId)}/records?room_id=${encodeURIComponent(request.roomId)}`, workspaceScoped: true });
  });
  ipcMain.handle("samurai:workspace-server:collections:record:create", async (_event, input: unknown) => {
    const request = workspaceCollectionRecordCreateRequest(input);
    const workspaceSnapshot = captureWorkspaceTargetSnapshot(request.target);
    return snapshotWorkspaceServerRequest(workspaceSnapshot, { method: "POST", path: `${workspaceCollectionsPath(workspaceSnapshot.workspaceId)}/${encodeURIComponent(request.collectionId)}/records`, workspaceScoped: true, operationId: request.operationId, body: request.body });
  });
  ipcMain.handle("samurai:workspace-server:collections:record:patch", async (_event, input: unknown) => {
    const request = workspaceCollectionRecordPatchRequest(input);
    const workspaceSnapshot = captureWorkspaceTargetSnapshot(request.target);
    return snapshotWorkspaceServerRequest(workspaceSnapshot, { method: "POST", path: `${workspaceCollectionsPath(workspaceSnapshot.workspaceId)}/${encodeURIComponent(request.collectionId)}/records/${encodeURIComponent(request.recordId)}/patches`, workspaceScoped: true, operationId: request.operationId, body: request.body });
  });
  ipcMain.handle("samurai:workspace-server:collections:record:delete", async (_event, input: unknown) => {
    const request = workspaceCollectionRecordDeleteRequest(input);
    const workspaceSnapshot = captureWorkspaceTargetSnapshot(request.target);
    return snapshotWorkspaceServerRequest(workspaceSnapshot, { method: "DELETE", path: `${workspaceCollectionsPath(workspaceSnapshot.workspaceId)}/${encodeURIComponent(request.collectionId)}/records/${encodeURIComponent(request.recordId)}`, workspaceScoped: true, operationId: request.operationId, body: request.body });
  });
  ipcMain.handle("samurai:workspace-server:collections:notes:list", async (_event, input: unknown) => {
    const request = workspaceCollectionIdRequest(input);
    const workspaceSnapshot = captureWorkspaceTargetSnapshot(request.target);
    return snapshotWorkspaceServerRequest(workspaceSnapshot, { method: "GET", path: `${workspaceCollectionsPath(workspaceSnapshot.workspaceId)}/${encodeURIComponent(request.collectionId)}/notes?room_id=${encodeURIComponent(request.roomId)}`, workspaceScoped: true });
  });
  ipcMain.handle("samurai:workspace-server:collections:reindex", async (_event, input: unknown) => {
    const request = workspaceCollectionRoomRequest(input);
    const workspaceSnapshot = captureWorkspaceTargetSnapshot(request.target);
    return snapshotWorkspaceServerRequest(workspaceSnapshot, { method: "POST", path: `${workspaceCollectionsPath(workspaceSnapshot.workspaceId)}/reindex`, workspaceScoped: true, body: { room_id: request.roomId } });
  });
  ipcMain.handle("samurai:workspace-server:collections:surface", async (_event, input: unknown) => {
    const request = workspaceCollectionSurfaceOperationRequest(input);
    const workspaceSnapshot = captureWorkspaceTargetSnapshot(request.target);
    return snapshotWorkspaceServerRequest(workspaceSnapshot, { method: "POST", path: `${workspaceCollectionsPath(workspaceSnapshot.workspaceId)}/surface/operations`, workspaceScoped: true, operationId: request.operationId, body: request.body });
  });
  ipcMain.handle("samurai:workspace-server:automation:jobs:list", async (_event, input: unknown) => {
    const request = workspaceAutomationListRequest(input);
    const query = request.roomId ? `?room_id=${encodeURIComponent(request.roomId)}` : "";
    const workspaceSnapshot = captureWorkspaceTargetSnapshot(request.target);
    return snapshotWorkspaceServerRequest(workspaceSnapshot, { method: "GET", path: `${workspaceAutomationPath(workspaceSnapshot.workspaceId)}/jobs${query}`, workspaceScoped: true });
  });
  ipcMain.handle("samurai:workspace-server:automation:jobs:create", async (_event, input: unknown) => {
    const request = workspaceAutomationJobCreateRequest(input);
    const workspaceSnapshot = captureWorkspaceTargetSnapshot(request.target);
    return snapshotWorkspaceServerRequest(workspaceSnapshot, { method: "POST", path: `${workspaceAutomationPath(workspaceSnapshot.workspaceId)}/jobs`, workspaceScoped: true, operationId: request.operationId, body: request.body });
  });
  ipcMain.handle("samurai:workspace-server:automation:runs:list", async (_event, input: unknown) => {
    const request = workspaceAutomationListRequest(input);
    const query = request.roomId ? `?room_id=${encodeURIComponent(request.roomId)}` : "";
    const workspaceSnapshot = captureWorkspaceTargetSnapshot(request.target);
    return snapshotWorkspaceServerRequest(workspaceSnapshot, { method: "GET", path: `${workspaceAutomationPath(workspaceSnapshot.workspaceId)}/runs${query}`, workspaceScoped: true });
  });
  ipcMain.handle("samurai:workspace-server:automation:job:runs", async (_event, input: unknown) => {
    const request = workspaceAutomationJobIdRequest(input);
    const workspaceSnapshot = captureWorkspaceTargetSnapshot(request.target);
    return snapshotWorkspaceServerRequest(workspaceSnapshot, { method: "GET", path: `${workspaceAutomationPath(workspaceSnapshot.workspaceId)}/jobs/${encodeURIComponent(request.jobId)}/runs`, workspaceScoped: true });
  });
  ipcMain.handle("samurai:workspace-server:automation:management", async (_event, input: unknown) => {
    const request = workspaceAutomationManagementRequest(input);
    const workspaceSnapshot = captureWorkspaceTargetSnapshot(request.target);
    return snapshotWorkspaceServerRequest(workspaceSnapshot, { method: "POST", path: `${workspaceAutomationPath(workspaceSnapshot.workspaceId)}/jobs/${encodeURIComponent(request.jobId)}/management`, workspaceScoped: true, operationId: request.operationId, body: { state: request.state } });
  });
  ipcMain.handle("samurai:workspace-server:automation:run-now", async (_event, input: unknown) => {
    const request = workspaceAutomationRunNowRequest(input);
    const workspaceSnapshot = captureWorkspaceTargetSnapshot(request.target);
    return snapshotWorkspaceServerRequest(workspaceSnapshot, { method: "POST", path: `${workspaceAutomationPath(workspaceSnapshot.workspaceId)}/run-now`, workspaceScoped: true, operationId: request.operationId, body: { room_id: request.roomId, kind: request.kind } });
  });
  ipcMain.handle("samurai:workspace-server:artifacts:list", async (_event, input: unknown) => {
    const request = workspaceArtifactListRequest(input);
    const workspaceSnapshot = captureWorkspaceTargetSnapshot(request.target);
    const response = await snapshotWorkspaceDomainApiClient(workspaceSnapshot).executeQuery<unknown[]>(workspaceSnapshot.workspaceId, "artifact.list", { context: { room_id: request.roomId }, input: {} });
    assertActiveWorkspaceSnapshot(workspaceSnapshot);
    return { artifacts: response.result };
  });
  ipcMain.handle("samurai:workspace-server:artifact:get", async (_event, input: unknown) => {
    const request = workspaceArtifactIdRequest(input);
    const workspaceSnapshot = captureWorkspaceTargetSnapshot(request.target);
    const response = await snapshotWorkspaceDomainApiClient(workspaceSnapshot).executeQuery<Record<string, unknown>>(workspaceSnapshot.workspaceId, "artifact.view", { context: { room_id: request.roomId }, input: { id: request.artifactId } });
    assertActiveWorkspaceSnapshot(workspaceSnapshot);
    const rawContent = await snapshotWorkspaceServerRequest(workspaceSnapshot, {
      method: "GET",
      path: workspaceV1ArtifactContentPath(workspaceSnapshot.workspaceId, request.artifactId, request.roomId),
      workspaceScoped: true,
      responseType: "bytes"
    }) as DesktopArtifactRawContent;
    return {
      ...verifyDesktopArtifactContentResponse(response.result, rawContent, {
        workspaceId: workspaceSnapshot.workspaceId,
        roomId: request.roomId,
        artifactId: request.artifactId
      }),
      auditRecords: []
    };
  });
  ipcMain.handle("samurai:workspace-server:artifact:revisions:list", async (_event, input: unknown) => {
    const request = workspaceArtifactRevisionIpcInput(input);
    const workspaceSnapshot = captureWorkspaceTargetSnapshot(request.target);
    const response = await snapshotWorkspaceDomainApiClient(workspaceSnapshot).listArtifactRevisions<{ revisions: unknown[] }>(workspaceSnapshot.workspaceId, request.roomId, request.artifactId);
    assertActiveWorkspaceSnapshot(workspaceSnapshot);
    if (!Array.isArray(response.revisions) || response.revisions.some((revision) => !revision || typeof revision !== "object" || (revision as { artifact_id?: unknown }).artifact_id !== request.artifactId)) {
      throw new Error("workspace_artifact_revision_response_scope_invalid");
    }
    return response.revisions;
  });
  ipcMain.handle("samurai:workspace-server:artifact:revision:get", async (_event, input: unknown) => {
    const request = workspaceArtifactRevisionIpcInput(input, { requireRevisionId: true });
    const workspaceSnapshot = captureWorkspaceTargetSnapshot(request.target);
    const response = await snapshotWorkspaceDomainApiClient(workspaceSnapshot).getArtifactRevision<Record<string, unknown>>(workspaceSnapshot.workspaceId, request.roomId, request.artifactId, request.revisionId!);
    assertActiveWorkspaceSnapshot(workspaceSnapshot);
    const artifact = response.artifact;
    const revision = response.revision;
    if (!artifact || typeof artifact !== "object" || (artifact as { id?: unknown }).id !== request.artifactId
      || !revision || typeof revision !== "object"
      || (revision as { id?: unknown }).id !== request.revisionId
      || (revision as { artifact_id?: unknown }).artifact_id !== request.artifactId) {
      throw new Error("workspace_artifact_revision_response_scope_invalid");
    }
    const rawContent = await snapshotWorkspaceServerRequest(workspaceSnapshot, {
      method: "GET",
      path: workspaceV1ArtifactContentPath(workspaceSnapshot.workspaceId, request.artifactId, request.roomId, request.revisionId),
      workspaceScoped: true,
      responseType: "bytes"
    }) as DesktopArtifactRawContent;
    return verifyDesktopArtifactContentResponse(response, rawContent, {
      workspaceId: workspaceSnapshot.workspaceId,
      roomId: request.roomId,
      artifactId: request.artifactId,
      revisionId: request.revisionId
    });
  });
  ipcMain.handle("samurai:workspace-server:artifact:create", async (_event, input: unknown) => {
    const request = workspaceArtifactCreateRequest(input);
    const workspaceSnapshot = captureWorkspaceTargetSnapshot(request.target);
    const { room_id: roomId, locale, source_locales: sourceLocales, ...baseInput } = request.body;
    const contentMetadata = desktopArtifactContentMetadata(input);
    const response = await snapshotWorkspaceDomainApiClient(workspaceSnapshot).executeOperation<Record<string, unknown>>(workspaceSnapshot.workspaceId, "artifact.create", {
      context: { room_id: String(roomId) },
      input: {
        ...baseInput,
        ...(locale ? { output_locale: locale } : {}),
        ...(Array.isArray(sourceLocales) && sourceLocales[0] ? { input_locale: sourceLocales[0] } : {}),
        ...(contentMetadata.mimeType ? { mime_type: contentMetadata.mimeType } : {}),
        ...(contentMetadata.encoding ? { encoding: contentMetadata.encoding } : {})
      }
    }, { operationId: request.operationId, idempotencyKey: request.operationId });
    assertActiveWorkspaceSnapshot(workspaceSnapshot);
    return response.result;
  });
  ipcMain.handle("samurai:workspace-server:artifact:surface", async (_event, input: unknown) => {
    const request = workspaceArtifactSurfaceOperationRequest(input);
    const workspaceSnapshot = captureWorkspaceTargetSnapshot(request.target);
    return snapshotWorkspaceServerRequest(workspaceSnapshot, {
      method: "POST",
      path: `${workspaceV1ArtifactsPath(workspaceSnapshot.workspaceId)}/surface/operations`,
      workspaceScoped: true,
      operationId: request.operationId,
      idempotencyKey: request.operationId,
      body: request.body
    });
  });
  ipcMain.handle("samurai:workspace-server:artifact:revise", async (_event, input: unknown) => {
    const request = workspaceArtifactRevisionIpcInput(input, { requireContent: true, requireOperationId: true });
    const workspaceSnapshot = captureWorkspaceTargetSnapshot(request.target);
    const response = await snapshotWorkspaceDomainApiClient(workspaceSnapshot).executeOperation<Record<string, unknown>>(workspaceSnapshot.workspaceId, "artifact.revise", {
      context: { room_id: request.roomId },
      input: {
        artifact_id: request.artifactId,
        content: request.content!,
        ...(request.baseRevisionId ? { base_revision_id: request.baseRevisionId } : {}),
        ...(request.expectedRevision === undefined ? {} : { expected_revision: request.expectedRevision }),
        ...(request.changeSummary ? { change_summary: request.changeSummary } : {}),
        ...(request.mimeType ? { mime_type: request.mimeType } : {}),
        ...(request.encoding ? { encoding: request.encoding } : {})
      } as unknown as DomainApiRequest["input"]
    }, { operationId: request.operationId!, idempotencyKey: request.operationId });
    assertActiveWorkspaceSnapshot(workspaceSnapshot);
    assertDesktopArtifactMutationScope(response.result, request.artifactId);
    return response.result;
  });
  ipcMain.handle("samurai:workspace-server:artifact:restore", async (_event, input: unknown) => {
    const request = workspaceArtifactRevisionIpcInput(input, { requireRevisionId: true, requireOperationId: true });
    const workspaceSnapshot = captureWorkspaceTargetSnapshot(request.target);
    const response = await snapshotWorkspaceDomainApiClient(workspaceSnapshot).executeOperation<Record<string, unknown>>(workspaceSnapshot.workspaceId, "artifact.restore_revision", {
      context: { room_id: request.roomId },
      input: {
        artifact_id: request.artifactId,
        revision_id: request.revisionId,
        ...(request.baseRevisionId ? { base_revision_id: request.baseRevisionId } : {}),
        ...(request.expectedRevision === undefined ? {} : { expected_revision: request.expectedRevision }),
        ...(request.changeSummary ? { change_summary: request.changeSummary } : {})
      } as unknown as DomainApiRequest["input"]
    }, { operationId: request.operationId!, idempotencyKey: request.operationId });
    assertActiveWorkspaceSnapshot(workspaceSnapshot);
    assertDesktopArtifactMutationScope(response.result, request.artifactId);
    return response.result;
  });
  ipcMain.handle("samurai:workspace-server:generated-surface:list", async (_event, input: unknown) => {
    const roomId = requiredWorkspaceOpaqueField(input, "roomId");
    const workspaceSnapshot = captureWorkspaceTargetSnapshot(workspaceTargetFromInput(input));
    const response = await snapshotWorkspaceDomainApiClient(workspaceSnapshot).listGeneratedSurfaces<{ surfaces: unknown[] }>(workspaceSnapshot.workspaceId, roomId);
    assertActiveWorkspaceSnapshot(workspaceSnapshot);
    if (!Array.isArray(response.surfaces) || response.surfaces.some((surface) => !surface || typeof surface !== "object" || ((surface as { room_id?: unknown }).room_id !== undefined && (surface as { room_id?: unknown }).room_id !== roomId))) {
      throw new Error("workspace_generated_surface_response_scope_invalid");
    }
    return response.surfaces;
  });
  ipcMain.handle("samurai:workspace-server:generated-surface:get", async (_event, input: unknown) => {
    const request = workspaceGeneratedSurfaceRoomRequest(input);
    const workspaceSnapshot = captureWorkspaceTargetSnapshot(request.target);
    return snapshotWorkspaceServerRequest(workspaceSnapshot, {
      method: "GET",
      path: `${workspaceV1GeneratedSurfacesPath(workspaceSnapshot.workspaceId)}/${encodeURIComponent(request.surfaceId)}?room_id=${encodeURIComponent(request.roomId)}`,
      workspaceScoped: true
    });
  });
  ipcMain.handle("samurai:workspace-server:generated-surface:bundle", async (_event, input: unknown) => {
    const request = workspaceGeneratedSurfaceBundleRequest(input);
    const workspaceSnapshot = captureWorkspaceTargetSnapshot(request.target);
    return snapshotWorkspaceServerRequest(workspaceSnapshot, {
      method: "GET",
      path: `${workspaceV1GeneratedSurfacesPath(workspaceSnapshot.workspaceId)}/${encodeURIComponent(request.surfaceId)}/revisions/${encodeURIComponent(request.revisionId)}/bundle?room_id=${encodeURIComponent(request.roomId)}`,
      workspaceScoped: true
    });
  });
  ipcMain.handle("samurai:workspace-server:generated-surface:action", async (_event, input: unknown) => {
    const request = workspaceGeneratedSurfaceActionRequest(input);
    const workspaceSnapshot = captureWorkspaceTargetSnapshot(request.target);
    return snapshotWorkspaceServerRequest(workspaceSnapshot, {
      method: "POST",
      path: `${workspaceV1GeneratedSurfacesPath(workspaceSnapshot.workspaceId)}/${encodeURIComponent(request.surfaceId)}/actions/${encodeURIComponent(request.actionId)}/run`,
      workspaceScoped: true,
      operationId: request.operationId,
      idempotencyKey: request.operationId,
      body: request.body
    });
  });
  ipcMain.handle("samurai:workspace-server:interaction-requests:list", async (event, input: unknown) => {
    assertWorkspaceInteractionIpcSender(event);
    const request = workspaceInteractionRequestListIpcInput(input);
    const workspaceSnapshot = captureWorkspaceTargetSnapshot(request.target);
    const requests: Array<Record<string, unknown>> = [];
    for (let offset = 0; ; ) {
      const query = new URLSearchParams({ room_id: request.roomId, include_resolved: String(request.includeResolved), limit: "500", offset: String(offset) });
      const response = await snapshotWorkspaceServerRequest(workspaceSnapshot, {
        method: "GET",
        path: `${workspaceInteractionRequestsPath(workspaceSnapshot.workspaceId)}?${query.toString()}`,
        workspaceScoped: true
      });
      const page = sanitizeDesktopInteractionListResponse(response, workspaceSnapshot.workspaceId, request.roomId).requests;
      requests.push(...page);
      if (page.length < 500) break;
      offset += page.length;
      if (offset > 100_000) throw new Error("workspace_interaction_request_list_too_large");
    }
    return { requests };
  });
  ipcMain.handle("samurai:workspace-server:interaction-requests:result", async (event, input: unknown) => {
    assertWorkspaceInteractionIpcSender(event);
    const request = workspaceInteractionRequestResultIpcInput(input);
    const workspaceSnapshot = captureWorkspaceTargetSnapshot(request.target);
    const response = await snapshotWorkspaceServerRequest(workspaceSnapshot, {
      method: "GET",
      path: `${workspaceInteractionRequestsPath(workspaceSnapshot.workspaceId)}/${encodeURIComponent(request.requestId)}/result?room_id=${encodeURIComponent(request.roomId)}`,
      workspaceScoped: true,
      operationId: request.operationId
    });
    return sanitizeDesktopInteractionResultResponse(response, workspaceSnapshot.workspaceId, request.roomId, request.requestId);
  });
  ipcMain.handle("samurai:workspace-server:operation-history:list", async (_event, input: unknown) => {
    const request = workspaceOperationHistoryRequest(input);
    const workspaceSnapshot = captureWorkspaceTargetSnapshot(request.target);
    const records: Array<Record<string, unknown>> = [];
    for (let offset = 0; ; ) {
      const query = new URLSearchParams({ room_id: request.roomId, record_type: request.recordType, limit: "500", offset: String(offset) });
      const response = await snapshotWorkspaceServerRequest(workspaceSnapshot, {
        method: "GET",
        path: `/api/workspaces/${encodeURIComponent(workspaceSnapshot.workspaceId)}/records?${query.toString()}`,
        workspaceScoped: true
      });
      const page = sanitizeDesktopOperationHistoryResponse(response, workspaceSnapshot.workspaceId, request.roomId, request.recordType).records;
      records.push(...page);
      if (page.length < 500) break;
      offset += page.length;
      if (offset > 100_000) throw new Error("workspace_operation_history_too_large");
    }
    return { records };
  });
  ipcMain.handle("samurai:workspace-server:interaction-requests:respond", async (event, input: unknown) => {
    assertWorkspaceInteractionIpcSender(event);
    const request = workspaceInteractionRequestRespondIpcInput(input);
    const workspaceSnapshot = captureWorkspaceTargetSnapshot(request.target);
    const response = await snapshotWorkspaceServerRequest(workspaceSnapshot, {
      method: "POST",
      path: `${workspaceInteractionRequestsPath(workspaceSnapshot.workspaceId)}/${encodeURIComponent(request.requestId)}/respond`,
      operationId: request.operationId,
      idempotencyKey: request.operationId,
      workspaceScoped: true,
      body: {
        room_id: request.roomId,
        expected_version: request.expectedVersion,
        option_id: request.optionId,
        ...(request.values === undefined ? {} : { values: request.values })
      }
    });
    return sanitizeDesktopInteractionMutationResponse(response, workspaceSnapshot.workspaceId, request.roomId, request.requestId);
  });
  ipcMain.handle("samurai:workspace-server:interaction-requests:cancel", async (event, input: unknown) => {
    assertWorkspaceInteractionIpcSender(event);
    const request = workspaceInteractionRequestCancelIpcInput(input);
    const workspaceSnapshot = captureWorkspaceTargetSnapshot(request.target);
    const response = await snapshotWorkspaceServerRequest(workspaceSnapshot, {
      method: "POST",
      path: `${workspaceInteractionRequestsPath(workspaceSnapshot.workspaceId)}/${encodeURIComponent(request.requestId)}/cancel`,
      operationId: request.operationId,
      idempotencyKey: request.operationId,
      workspaceScoped: true,
      body: { room_id: request.roomId, expected_version: request.expectedVersion }
    });
    return sanitizeDesktopInteractionMutationResponse(response, workspaceSnapshot.workspaceId, request.roomId, request.requestId);
  });
  ipcMain.handle("samurai:workspace-server:generated-surface:state", async (_event, input: unknown) => {
    const request = workspaceGeneratedSurfaceStateRequest(input);
    const workspaceSnapshot = captureWorkspaceTargetSnapshot(request.target);
    return snapshotWorkspaceServerRequest(workspaceSnapshot, {
      method: "POST",
      path: `${workspaceV1GeneratedSurfacesPath(workspaceSnapshot.workspaceId)}/${encodeURIComponent(request.surfaceId)}/state`,
      workspaceScoped: true,
      operationId: request.operationId,
      idempotencyKey: request.operationId,
      body: request.body
    });
  });
  ipcMain.handle("samurai:workspace-server:generated-surface:export", async (_event, input: unknown) => {
    const request = workspaceGeneratedSurfaceExportRequest(input);
    const query = new URLSearchParams({ room_id: request.roomId, format: request.format });
    if (request.revisionId) query.set("revision_id", request.revisionId);
    const workspaceSnapshot = captureWorkspaceTargetSnapshot(request.target);
    return snapshotWorkspaceServerRequest(workspaceSnapshot, {
      method: "GET",
      path: `${workspaceV1GeneratedSurfacesPath(workspaceSnapshot.workspaceId)}/${encodeURIComponent(request.surfaceId)}/export?${query.toString()}`,
      workspaceScoped: true
    });
  });
  ipcMain.handle("samurai:workspace-server:generated-surface:create", async (_event, input: unknown) => {
    const request = workspaceGeneratedSurfaceMutationIpcInput(input);
    const workspaceSnapshot = captureWorkspaceTargetSnapshot(request.target);
    const response = await snapshotWorkspaceDomainApiClient(workspaceSnapshot).executeOperation<Record<string, unknown>>(workspaceSnapshot.workspaceId, "generated_surface.create", {
      context: { room_id: request.roomId },
      input: { bundle: request.bundle, request: request.request } as unknown as DomainApiRequest["input"]
    }, { operationId: request.operationId, idempotencyKey: request.operationId });
    assertActiveWorkspaceSnapshot(workspaceSnapshot);
    return response.result;
  });
  ipcMain.handle("samurai:workspace-server:generated-surface:revise", async (_event, input: unknown) => {
    const request = workspaceGeneratedSurfaceMutationIpcInput(input, { requireSurfaceId: true });
    const workspaceSnapshot = captureWorkspaceTargetSnapshot(request.target);
    const response = await snapshotWorkspaceDomainApiClient(workspaceSnapshot).executeOperation<Record<string, unknown>>(workspaceSnapshot.workspaceId, "generated_surface.revise", {
      context: { room_id: request.roomId },
      input: { surface_id: request.surfaceId, bundle: request.bundle, request: request.request } as unknown as DomainApiRequest["input"]
    }, { operationId: request.operationId, idempotencyKey: request.operationId });
    assertActiveWorkspaceSnapshot(workspaceSnapshot);
    const definition = response.result.definition;
    if (!definition || typeof definition !== "object" || (definition as { id?: unknown }).id !== request.surfaceId) throw new Error("workspace_generated_surface_response_scope_invalid");
    return response.result;
  });
  ipcMain.handle("samurai:workspace-server:room-members:list", async (_event, input: unknown) => {
    const request = workspaceRoomMemberListRequest(input);
    const workspaceSnapshot = captureWorkspaceTargetSnapshot(request.target);
    return snapshotWorkspaceServerRequest(workspaceSnapshot, {
      method: "GET",
      path: `${workspaceRoomsPath(workspaceSnapshot.workspaceId)}/${encodeURIComponent(request.roomId)}/members`,
      workspaceScoped: true
    });
  });
  ipcMain.handle("samurai:workspace-server:room:create", async (_event, input: unknown) => {
    const request = workspaceRoomCreateRequest(input);
    const workspaceSnapshot = captureWorkspaceTargetSnapshot(request.target);
    const response = await snapshotWorkspaceDomainApiClient(workspaceSnapshot).executeOperation<PublicRoomRecord>(workspaceSnapshot.workspaceId, "room.create", {
      context: {},
      input: {
        name: request.body.name,
        ...(request.body.parent_room_id === undefined ? {} : { parent_room_id: request.body.parent_room_id }),
        ...(request.body.default_agent_id === undefined ? {} : { default_agent_id: request.body.default_agent_id }),
        ...(request.body.default_agent_version === undefined ? {} : { default_agent_version: request.body.default_agent_version }),
        ...(request.body.new_agent === undefined ? {} : { new_agent: request.body.new_agent }),
        ...(request.body.agent_permission === undefined ? {} : { agent_permission: request.body.agent_permission })
      } as unknown as DomainApiRequest["input"]
    }, { operationId: request.operationId, idempotencyKey: request.operationId });
    assertActiveWorkspaceSnapshot(workspaceSnapshot);
    if (response.result.workspace_id !== workspaceSnapshot.workspaceId) throw new Error("workspace_room_response_scope_invalid");
    return {
      room: toDesktopWorkspaceRoom(response.result),
      target: { connectionId: workspaceSnapshot.connectionId, workspaceId: workspaceSnapshot.workspaceId },
      replayed: response.replayed
    };
  });
  ipcMain.handle("samurai:workspace-server:room:move-preview", async (_event, input: unknown) => {
    const request = workspaceRoomMovePreviewRequest(input);
    const workspaceSnapshot = captureWorkspaceTargetSnapshot(request.target);
    return snapshotWorkspaceServerRequest(workspaceSnapshot, {
      method: "POST",
      path: `${workspaceRoomsPath(workspaceSnapshot.workspaceId)}/${encodeURIComponent(request.roomId)}/parent/preview`,
      workspaceScoped: true,
      body: request.body
    });
  });
  ipcMain.handle("samurai:workspace-server:room:move", async (_event, input: unknown) => {
    const request = workspaceRoomMoveRequest(input);
    const workspaceSnapshot = captureWorkspaceTargetSnapshot(request.target);
    return snapshotWorkspaceServerRequest(workspaceSnapshot, {
      method: "PUT",
      path: `${workspaceRoomsPath(workspaceSnapshot.workspaceId)}/${encodeURIComponent(request.roomId)}/parent`,
      workspaceScoped: true,
      operationId: request.operationId,
      body: request.body
    });
  });
  ipcMain.handle("samurai:workspace-server:room-member:preview", async (_event, input: unknown) => {
    const request = workspaceRoomMemberPreviewRequest(input);
    const workspaceSnapshot = captureWorkspaceTargetSnapshot(request.target);
    return snapshotWorkspaceServerRequest(workspaceSnapshot, {
      method: "POST",
      path: `${workspaceRoomsPath(workspaceSnapshot.workspaceId)}/${encodeURIComponent(request.roomId)}/members/${encodeURIComponent(request.accountId)}/preview`,
      workspaceScoped: true,
      body: request.body
    });
  });
  ipcMain.handle("samurai:workspace-server:room-member:set", async (_event, input: unknown) => {
    const request = workspaceRoomMemberRequest(input);
    const workspaceSnapshot = captureWorkspaceTargetSnapshot(request.target);
    return snapshotWorkspaceServerRequest(workspaceSnapshot, {
      method: "PUT",
      path: `${workspaceRoomsPath(workspaceSnapshot.workspaceId)}/${encodeURIComponent(request.roomId)}/members/${encodeURIComponent(request.accountId)}`,
      workspaceScoped: true,
      operationId: request.operationId,
      body: request.body
    });
  });
  ipcMain.handle("samurai:workspace-server:learning:settings:get", async (_event, input: unknown) => {
    const value = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : { roomId: input };
    const roomId = requiredWorkspaceOpaqueField(value, "roomId");
    const workspaceSnapshot = captureWorkspaceTargetSnapshot(workspaceTargetFromInput(value));
    return snapshotWorkspaceServerRequest(workspaceSnapshot, {
      method: "GET",
      path: `${workspaceLearningPath(workspaceSnapshot.workspaceId)}/settings?room_id=${encodeURIComponent(roomId)}`,
      workspaceScoped: true
    });
  });
  ipcMain.handle("samurai:workspace-server:learning:settings:put", async (_event, input: unknown) => {
    const request = workspaceLearningSettingsRequest(input);
    const workspaceSnapshot = captureWorkspaceTargetSnapshot(request.target);
    return snapshotWorkspaceServerRequest(workspaceSnapshot, {
      method: "PATCH",
      path: `${workspaceLearningPath(workspaceSnapshot.workspaceId)}/settings`,
      workspaceScoped: true,
      operationId: request.operationId,
      body: request.body
    });
  });
  ipcMain.handle("samurai:workspace-server:status", async (_event, input: unknown) => workspaceServerStatus(workspaceStatusTargetInput(input)));
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
  for (const transfer of workspaceConnectionRegistry.transfers ?? []) {
    const restored = getWorkspaceTransfer(workspaceConnectionRegistry, transfer.transferId);
    if (restored) workspaceTransferStatusById.set(restored.transferId, { ...restored, source: { ...restored.source }, destination: { ...restored.destination } });
  }
  // Persist the normalized v3 shape immediately so a legacy workspaceId
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
    } else if (config.workspaceId) {
      const environment = workspaceConnectionRegistry.connections.find((connection) =>
        connection.serverUrl === config.workspaceServerUrl && connection.accountId === config.accountId
      );
      if (environment && !environment.targets.some((target) => target.workspaceId === config.workspaceId)) {
        workspaceConnectionRegistry = upsertWorkspaceTarget(workspaceConnectionRegistry, {
          connectionId: environment.id,
          workspaceId: config.workspaceId
        });
        await saveWorkspaceConnectionRegistry(workspaceConnectionRegistryPath, workspaceConnectionRegistry);
      }
    }
  }
  applyWorkspaceTarget(workspaceConnectionRegistry.activeTarget);
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
  const target = workspaceConnectionRegistry.activeTarget;
  if (!target) {
    applyWorkspaceTarget(undefined);
    return;
  }
  const result = await reauthorizeWorkspaceTarget(target);
  if (result.status === "offline" || result.status === "identity_required") return;
  if (result.status === "denied") {
    if (!sameWorkspaceTarget(workspaceConnectionRegistry.activeTarget, target)) return;
    workspaceConnectionRegistry = clearActiveWorkspaceTarget(workspaceConnectionRegistry, target);
    await saveWorkspaceConnectionRegistry(workspaceConnectionRegistryPath, workspaceConnectionRegistry);
    applyWorkspaceTarget(undefined);
    void reconnectActiveWorkspaceRealtime();
    return;
  }
  if (!sameWorkspaceTarget(workspaceConnectionRegistry.activeTarget, target)) return;
  workspaceConnectionRegistry = patchWorkspaceTarget(workspaceConnectionRegistry, target, {
    lastOrganizationId: result.organizationId ?? null,
    lastRoomId: result.roomId ?? null
  });
  await saveWorkspaceConnectionRegistry(workspaceConnectionRegistryPath, workspaceConnectionRegistry);
  applyWorkspaceTarget(target);
}

type WorkspaceTargetAuthorization = {
  status: "authorized" | "denied" | "offline" | "identity_required";
  organizationId?: string;
  roomId?: string;
};

interface WorkspaceTransferRequest {
  source: WorkspaceTargetRef;
  destination: WorkspaceTargetRef;
  /** The transfer id is stable; mutating Server phases use derived operation IDs. */
  operationId: string;
  transferId?: string;
  targetWorkspaceName?: string;
  lastRoomId?: string;
}

type WorkspaceTransferPhase = "begin" | "manifest" | "bundle" | "import" | "receipt" | "complete" | "rollback";

type WorkspaceSourceTransferState = "preparing" | "exported" | "imported" | "committed" | "rolled_back" | "failed";
type WorkspaceSourceWorkspaceState = "active" | "read_only" | "archived" | "deleted";

/** The source Server's durable checkpoint used before trusting local state. */
interface WorkspaceSourceTransferStatus {
  transferId: string;
  state: WorkspaceSourceTransferState;
  sourceIntegrityHash?: string;
  targetIntegrityHash?: string;
  targetWorkspaceId?: string;
  receiptPresent: boolean;
  sourceWorkspaceState: WorkspaceSourceWorkspaceState;
  sourceArchived: boolean;
}

/**
 * Keep one transfer identity in the URL and Desktop checkpoint while giving
 * each Server operation-ledger mutation its own retry-stable key. The source
 * begin contract intentionally uses transferId itself because the Server
 * derives the transfer row ID from context.operationId.
 */
function workspaceTransferPhaseOperationId(transferId: string, phase: WorkspaceTransferPhase): string {
  if (phase === "begin") return transferId;
  const digest = createHash("sha256").update(`${transferId}:${phase}`).digest("hex").slice(0, 48);
  return `desktop_transfer_${phase}_${digest}`;
}

/**
 * Receipt rows are content-addressed as well as transfer-addressed.  This is
 * important when an earlier client persisted a failed receipt with a stale
 * (for example V3) hash: the corrected V4 receipt must get a fresh ledger key,
 * while retransmitting the same corrected receipt remains idempotent.
 */
function workspaceTransferReceiptOperationId(
  transferId: string,
  receipt: WorkspaceTransferReceiptRecord
): string {
  const digest = createHash("sha256")
    .update([
      transferId,
      receipt.target_workspace_id,
      receipt.source_integrity_hash,
      receipt.target_integrity_hash
    ].join(":"))
    .digest("hex")
    .slice(0, 48);
  return `desktop_transfer_receipt_${digest}`;
}

interface WorkspaceTransferPreflight {
  transferId: string;
  source: WorkspaceTargetRef;
  destination: WorkspaceTargetRef;
  workspaceId: string;
  workspaceName?: string;
  sourceVersion?: number;
  sourceState?: "active" | "read_only" | "archived";
  dataByteSize?: number;
  writeBlocked: boolean;
  organizationReleased: boolean;
  sourceWillArchive: boolean;
  failureConditions: string[];
  sourceServerUrl: string;
  destinationServerUrl: string;
  sourceHealth: WorkspaceTransferHealth;
  destinationHealth: WorkspaceTransferHealth;
  schemaCompatibility: "compatible" | "incompatible" | "unverified";
  sourceSchemaRevision?: number;
  destinationSchemaRevision?: number;
  /** Server capacity is not part of the current health contract. */
  capacityUnverified: boolean;
  capacityLimitBytes: number;
  capacityLimitEntries: number;
  sourceTransferState?: WorkspaceSourceTransferState;
}

interface WorkspaceTransferStatus {
  transferId: string;
  source: WorkspaceTargetRef;
  destination: WorkspaceTargetRef;
  state: "preflight" | "exported" | "restoring" | "verified" | "cutover" | "source_archived" | "failed";
  workspaceId: string;
  workspaceName?: string;
  dataByteSize?: number;
  writeBlocked?: boolean;
  organizationReleased?: boolean;
  sourceArchived?: boolean;
  integrityHash?: string;
  entryCount?: number;
  capacityUnverified?: boolean;
  targetRestored?: boolean;
  targetCleanupRequired?: boolean;
  receipt?: WorkspaceTransferReceiptRecord;
  failureCode?: string;
  message?: string;
  updatedAt: string;
}

interface WorkspaceTransferHealth {
  status: number;
  ok: boolean;
  databaseOk?: boolean;
  storageOk?: boolean;
  schemaRevision?: number;
}

async function setWorkspaceTransferStatus(status: WorkspaceTransferStatus): Promise<void> {
  workspaceTransferStatusById.set(status.transferId, { ...status, source: { ...status.source }, destination: { ...status.destination } });
  workspaceConnectionRegistry = recordWorkspaceTransfer(workspaceConnectionRegistry, status satisfies WorkspaceTransferRecord);
  if (workspaceConnectionRegistryPath) await saveWorkspaceConnectionRegistry(workspaceConnectionRegistryPath, workspaceConnectionRegistry);
}

async function stopWorkspaceTransferSafely(
  request: WorkspaceTransferRequest,
  previous: WorkspaceTransferStatus | undefined,
  failureCode: string,
  message: string,
  options?: { sourceArchived?: boolean; targetRestored?: boolean; targetCleanupRequired?: boolean }
): Promise<never> {
  await setWorkspaceTransferStatus({
    transferId: request.transferId ?? request.operationId,
    source: { ...request.source },
    destination: { ...request.destination },
    state: "failed",
    workspaceId: request.source.workspaceId,
    ...(previous?.workspaceName ? { workspaceName: previous.workspaceName } : {}),
    ...(previous?.dataByteSize === undefined ? {} : { dataByteSize: previous.dataByteSize }),
    ...(previous?.entryCount === undefined ? {} : { entryCount: previous.entryCount }),
    ...(previous?.capacityUnverified === undefined ? {} : { capacityUnverified: previous.capacityUnverified }),
    ...(previous?.integrityHash ? { integrityHash: previous.integrityHash } : {}),
    ...(previous?.receipt ? { receipt: previous.receipt } : {}),
    sourceArchived: options?.sourceArchived ?? previous?.sourceArchived ?? false,
    ...(options?.targetRestored === undefined && previous?.targetRestored === undefined
      ? {}
      : { targetRestored: options?.targetRestored ?? previous?.targetRestored }),
    ...(options?.targetCleanupRequired === undefined && previous?.targetCleanupRequired === undefined
      ? {}
      : { targetCleanupRequired: options?.targetCleanupRequired ?? previous?.targetCleanupRequired }),
    failureCode,
    message,
    updatedAt: new Date().toISOString()
  });
  throw new Error(failureCode);
}

async function reauthorizeWorkspaceTarget(target: WorkspaceTargetRef, requestedRoomId?: string): Promise<WorkspaceTargetAuthorization> {
  const connection = workspaceConnectionRegistry.connections.find((candidate) => candidate.id === target.connectionId);
  if (!connection?.credentialRef) return { status: "identity_required" };
  let privateKey: string;
  try {
    privateKey = await requireActiveWorkspacePrivateKey(connection);
  } catch (error) {
    return error instanceof Error && error.message.includes("identity")
      ? { status: "identity_required" }
      : { status: "denied" };
  }
  let workspaceResponse: { status: number; body: unknown };
  try {
    workspaceResponse = await signedWorkspaceServerRequest(connection, privateKey, {
      method: "GET",
      path: `/api/workspaces/${encodeURIComponent(target.workspaceId)}`,
      workspaceScoped: true,
      workspaceId: target.workspaceId
    });
  } catch {
    return { status: "offline" };
  }
  if (isSelectionAuthorizationDenied(workspaceResponse.status)) return { status: "denied" };
  if (workspaceResponse.status < 200 || workspaceResponse.status >= 300) return { status: "offline" };
  let roomId: string | undefined;
  const connectionTarget = connection.targets.find((candidate) => candidate.workspaceId === target.workspaceId);
  const organizationId = responseString(workspaceResponse.body, "organization_id")
    ?? responseString(workspaceResponse.body, "organizationId")
    ?? connectionTarget?.lastOrganizationId;
  const roomCandidate = requestedRoomId ?? connectionTarget?.lastRoomId;
  if (roomCandidate) {
    let roomsResponse: { status: number; body: unknown };
    try {
      roomsResponse = await signedWorkspaceServerRequest(connection, privateKey, {
        method: "GET",
        path: `/api/workspaces/${encodeURIComponent(target.workspaceId)}/rooms`,
        workspaceScoped: true,
        workspaceId: target.workspaceId
      });
    } catch {
      return { status: "offline" };
    }
    if (roomsResponse.status >= 500 || roomsResponse.status === 0) return { status: "offline" };
    if (!isSelectionAuthorizationDenied(roomsResponse.status) && roomsResponse.status >= 200 && roomsResponse.status < 300) {
      const rooms = extractArray(roomsResponse.body, ["rooms"]);
      if (rooms.some((room) => room && typeof room === "object" && !Array.isArray(room) && (room as { id?: unknown }).id === roomCandidate)) {
        roomId = roomCandidate;
      }
    }
  }
  return { status: "authorized", ...(organizationId ? { organizationId } : {}), ...(roomId ? { roomId } : {}) };
}

function isSelectionAuthorizationDenied(status: number): boolean {
  return status === 401 || status === 403 || status === 404;
}

function publicWorkspaceConnections(): {
  activeConnectionId?: string;
  activeTarget?: WorkspaceTargetRef & { roomId?: string; selectionGeneration?: number };
  connections: Array<Omit<WorkspaceConnection, "credentialRef">>;
  transfers: PublicWorkspaceTransferStatus[];
} {
  const publicTarget = workspaceConnectionRegistry.activeTarget
    ? {
      ...workspaceConnectionRegistry.activeTarget,
      ...(activeRoomId ? { roomId: activeRoomId } : {}),
      selectionGeneration: workspaceSelectionGeneration
    }
    : undefined;
  return {
    ...(workspaceConnectionRegistry.activeConnectionId ? { activeConnectionId: workspaceConnectionRegistry.activeConnectionId } : {}),
    ...(publicTarget ? { activeTarget: publicTarget } : {}),
    connections: workspaceConnectionRegistry.connections.map(({ credentialRef: _credentialRef, ...connection }) => connection),
    transfers: listWorkspaceTransfers()
  };
}

function publicActiveWorkspaceTarget(): (WorkspaceTargetRef & { roomId?: string; selectionGeneration?: number }) | undefined {
  return activeWorkspaceTargetRef
    ? {
      ...activeWorkspaceTargetRef,
      ...(activeRoomId ? { roomId: activeRoomId } : {}),
      selectionGeneration: workspaceSelectionGeneration
    }
    : undefined;
}

interface WorkspaceDirectoryEntry {
  target: WorkspaceTargetRef;
  connectionId: string;
  serverUrl: string;
  accountId: string;
  connectionLabel: string;
  workspaceId: string;
  name: string;
  state?: "active" | "archived" | "read_only";
  role?: "owner" | "admin" | "member" | "guest";
  organizationId?: string;
  version?: number;
  createdAt?: string;
  updatedAt?: string;
  serverLabel?: string;
  access: "granted" | "none";
  availability: "unknown" | "connected" | "reconnecting" | "offline";
  error?: string;
}

interface WorkspaceDirectoryError {
  connectionId: string;
  serverOrigin: string;
  serverLabel: string;
  code: string;
  message: string;
}

const workspaceIdentityRequiredMessage = "このServerのWorkspaceを確認するには、本人確認（秘密鍵の読み込み）が必要です。接続設定から読み込んでください。";

async function listWorkspaceDirectory(): Promise<{
  workspaces: WorkspaceDirectoryEntry[];
  errors?: WorkspaceDirectoryError[];
  connections: ReturnType<typeof publicWorkspaceConnections>;
}> {
  const entries: WorkspaceDirectoryEntry[] = [];
  const errors: WorkspaceDirectoryError[] = [];
  let changed = false;
  for (const connection of [...workspaceConnectionRegistry.connections]) {
    const localTargets = connection.targets.filter((target) => !target.supersededBy);
    let status: "ready" | "offline" | "identity_required" | "unauthorized" = "ready";
    if (!connection.credentialRef) {
      status = "identity_required";
      for (const target of localTargets) entries.push(directoryEntry(connection, target, status));
      errors.push(directoryError(connection, "workspace_identity_required", workspaceIdentityRequiredMessage));
      continue;
    }
    let privateKey: string;
    try {
      privateKey = await requireActiveWorkspacePrivateKey(connection);
    } catch {
      status = "identity_required";
      for (const target of localTargets) entries.push(directoryEntry(connection, target, status));
      errors.push(directoryError(connection, "workspace_identity_required", workspaceIdentityRequiredMessage));
      continue;
    }
    let response: { status: number; body: unknown };
    try {
      response = await signedWorkspaceServerRequest(connection, privateKey, {
        method: "GET",
        path: "/api/account/workspaces",
        workspaceScoped: false
      });
    } catch {
      status = "offline";
      for (const target of localTargets) entries.push(directoryEntry(connection, target, status));
      errors.push(directoryError(connection, "workspace_server_unreachable", "Workspace Serverに接続できません。"));
      continue;
    }
    if (isSelectionAuthorizationDenied(response.status)) {
      status = "unauthorized";
      for (const target of localTargets) entries.push(directoryEntry(connection, target, status));
      errors.push(directoryError(connection, "workspace_account_unauthorized", "このServerのAccountを再認証できません。"));
      continue;
    }
    if (response.status < 200 || response.status >= 300) {
      status = "offline";
      for (const target of localTargets) entries.push(directoryEntry(connection, target, status));
      errors.push(directoryError(connection, "workspace_directory_request_failed", `Workspace一覧の取得に失敗しました（${response.status}）。`));
      continue;
    }
    const summaries = extractArray(response.body, ["workspaces"]);
    for (const summary of summaries) {
      const workspaceId = responseString(summary, "id") ?? responseString(summary, "workspace_id");
      if (!workspaceId) continue;
      const existing = connection.targets.find((target) => target.workspaceId === workspaceId);
      const organizationId = responseString(summary, "organization_id") ?? responseString(summary, "organizationId");
      const nextRegistry = upsertWorkspaceTarget(workspaceConnectionRegistry, {
        connectionId: connection.id,
        workspaceId,
        ...(organizationId ? { lastOrganizationId: organizationId } : {}),
        ...(existing?.lastRoomId ? { lastRoomId: existing.lastRoomId } : {})
      });
      if (JSON.stringify(nextRegistry) !== JSON.stringify(workspaceConnectionRegistry)) changed = true;
      workspaceConnectionRegistry = nextRegistry;
      const target = workspaceConnectionRegistry.connections.find((candidate) => candidate.id === connection.id)?.targets.find((candidate) => candidate.workspaceId === workspaceId);
      if (!target || target.supersededBy) continue;
      entries.push(directoryEntry(connection, target, "ready", summary));
    }
  }
  if (changed) await saveWorkspaceConnectionRegistry(workspaceConnectionRegistryPath, workspaceConnectionRegistry);
  const uniqueEntries = new Map<string, WorkspaceDirectoryEntry>();
  for (const entry of entries) uniqueEntries.set(workspaceTargetKey(entry.target), entry);
  return { workspaces: [...uniqueEntries.values()], ...(errors.length ? { errors } : {}), connections: publicWorkspaceConnections() };
}

function directoryEntry(
  connection: WorkspaceConnection,
  target: WorkspaceTarget,
  connectionStatus: "ready" | "offline" | "identity_required" | "unauthorized",
  summary?: unknown
): WorkspaceDirectoryEntry {
  const name = summaryString(summary, "name") ?? connection.label;
  const rawState = summaryString(summary, "state");
  const state = rawState === "archived" || rawState === "read_only" || rawState === "active" ? rawState : undefined;
  const rawRole = summaryString(summary, "role");
  const role = rawRole === "owner" || rawRole === "admin" || rawRole === "member" || rawRole === "guest" ? rawRole : undefined;
  const organizationId = responseString(summary, "organization_id") ?? responseString(summary, "organizationId") ?? target.lastOrganizationId;
  const version = summaryNumber(summary, "version");
  const createdAt = summaryString(summary, "created_at") ?? summaryString(summary, "createdAt");
  const updatedAt = summaryString(summary, "updated_at") ?? summaryString(summary, "updatedAt");
  return {
    target: targetRef(target),
    connectionId: connection.id,
    serverUrl: connection.serverUrl,
    accountId: connection.accountId,
    connectionLabel: connection.label,
    workspaceId: target.workspaceId,
    name,
    ...(state ? { state } : {}),
    ...(role ? { role } : {}),
    ...(organizationId ? { organizationId } : {}),
    ...(version === undefined ? {} : { version }),
    ...(createdAt ? { createdAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    serverLabel: connection.label,
    access: connectionStatus === "ready" ? "granted" : "none",
    availability: connectionStatus === "ready" ? "connected" : connectionStatus === "offline" ? "offline" : "unknown",
    ...(connectionStatus === "identity_required" ? { error: "workspace_identity_required" } : {}),
    ...(connectionStatus === "unauthorized" ? { error: "workspace_account_unauthorized" } : {})
  };
}

function directoryError(connection: WorkspaceConnection, code: string, message: string): WorkspaceDirectoryError {
  return {
    connectionId: connection.id,
    serverOrigin: connection.serverUrl,
    serverLabel: connection.label,
    code,
    message
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
  const targets = Array.isArray(input.targets)
    ? input.targets.slice(0, 500).flatMap((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const target = item as Record<string, unknown>;
      if (typeof target.connectionId !== "string" || typeof target.workspaceId !== "string") return [];
      if (!isWorkspaceOpaqueId(target.connectionId) || !isWorkspaceOpaqueId(target.workspaceId)) return [];
      return [{
        connectionId: target.connectionId,
        workspaceId: target.workspaceId,
        ...(typeof target.lastOrganizationId === "string" && isWorkspaceOpaqueId(target.lastOrganizationId) ? { lastOrganizationId: target.lastOrganizationId } : {}),
        ...(typeof target.lastRoomId === "string" && isWorkspaceOpaqueId(target.lastRoomId) ? { lastRoomId: target.lastRoomId } : {})
      }] as const;
    })
    : undefined;
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
    ...(optional("lastRoomId") ? { lastRoomId: optional("lastRoomId") } : {}),
    ...(targets ? { targets } : {})
  };
}

function workspaceTargetCutoverInput(value: unknown): WorkspaceTargetCutover {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("workspace_target_cutover_invalid");
  const input = value as Record<string, unknown>;
  const parseTarget = (candidate: unknown, prefix: "source" | "destination"): WorkspaceTargetRef => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error(`workspace_target_cutover_${prefix}_invalid`);
    const target = candidate as Record<string, unknown>;
    return {
      connectionId: requiredSelectionId(target, "connectionId"),
      workspaceId: requiredSelectionId(target, "workspaceId")
    };
  };
  const source = parseTarget(input.source, "source");
  const destination = parseTarget(input.destination, "destination");
  const optional = (key: "lastOrganizationId" | "lastRoomId"): string | undefined => {
    const candidate = input[key];
    if (candidate === undefined || candidate === null || candidate === "") return undefined;
    return requiredSelectionId(input, key);
  };
  return {
    source,
    destination,
    ...(optional("lastOrganizationId") ? { lastOrganizationId: optional("lastOrganizationId") } : {}),
    ...(optional("lastRoomId") ? { lastRoomId: optional("lastRoomId") } : {})
  };
}

async function authorizeWorkspaceTargetForTransition(target: WorkspaceTargetRef, requestedRoomId?: string): Promise<WorkspaceTargetAuthorization> {
  const authorization = await reauthorizeWorkspaceTarget(target, requestedRoomId);
  if (authorization.status === "identity_required") throw new Error("workspace_identity_required");
  if (authorization.status === "offline") throw new Error("workspace_selection_unavailable");
  if (authorization.status === "denied") throw new Error("workspace_selection_denied");
  return authorization;
}

/**
 * Commit a transfer only after the destination has been authorized. Saving the
 * normalized registry precedes changing process state, so a local write
 * failure leaves the source target and active target untouched.
 */
async function commitWorkspaceTargetCutover(
  request: WorkspaceTargetCutover,
  authorization?: WorkspaceTargetAuthorization
): Promise<void> {
  const resolved = authorization ?? await authorizeWorkspaceTargetForTransition(request.destination, request.lastRoomId ?? undefined);
  const previousTarget = workspaceConnectionRegistry.activeTarget;
  const next = cutoverWorkspaceTarget(workspaceConnectionRegistry, {
    ...request,
    lastOrganizationId: resolved.organizationId ?? null,
    lastRoomId: resolved.roomId ?? null
  });
  await saveWorkspaceConnectionRegistry(workspaceConnectionRegistryPath, next);
  workspaceConnectionRegistry = next;
  if (!sameWorkspaceTarget(previousTarget, next.activeTarget)) {
    applyWorkspaceTarget(next.activeTarget);
    void reconnectActiveWorkspaceRealtime();
  }
}

function workspaceTransferInput(value: unknown): WorkspaceTransferRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("workspace_transfer_invalid");
  const input = value as Record<string, unknown>;
  const parseTarget = (candidate: unknown, prefix: "source" | "destination"): WorkspaceTargetRef => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error(`workspace_transfer_${prefix}_invalid`);
    const target = candidate as Record<string, unknown>;
    if (typeof target.connectionId !== "string" || !isWorkspaceOpaqueId(target.connectionId)
      || typeof target.workspaceId !== "string" || !isWorkspaceOpaqueId(target.workspaceId)) {
      throw new Error(`workspace_transfer_${prefix}_invalid`);
    }
    return { connectionId: target.connectionId, workspaceId: target.workspaceId };
  };
  const sourceValue = input.source ?? {
    connectionId: input.sourceConnectionId,
    workspaceId: input.sourceWorkspaceId
  };
  const destinationValue = input.destination ?? {
    connectionId: input.destinationConnectionId ?? input.targetConnectionId,
    workspaceId: input.destinationWorkspaceId ?? input.targetWorkspaceId
  };
  const source = parseTarget(sourceValue, "source");
  const destination = parseTarget(destinationValue, "destination");
  if (source.connectionId === destination.connectionId) throw new Error("workspace_transfer_connections_must_differ");
  const optionalId = (key: string): string | undefined => {
    const candidate = input[key];
    if (candidate === undefined || candidate === null || candidate === "") return undefined;
    if (typeof candidate !== "string" || !isWorkspaceOpaqueId(candidate)) throw new Error(`workspace_transfer_${key}_invalid`);
    return candidate;
  };
  const operationId = optionalId("operationId");
  const transferId = optionalId("transferId");
  const targetWorkspaceName = input.targetWorkspaceName === undefined || input.targetWorkspaceName === null || input.targetWorkspaceName === ""
    ? undefined
    : typeof input.targetWorkspaceName === "string" && input.targetWorkspaceName.trim().length <= 500
      ? input.targetWorkspaceName.trim()
      : (() => { throw new Error("workspace_transfer_target_workspace_name_invalid"); })();
  const lastRoomId = optionalId("lastRoomId") ?? optionalId("roomId");
  return {
    source,
    destination,
    operationId: transferId ?? operationId ?? `desktop_transfer_${randomUUID()}`,
    ...(transferId ? { transferId } : {}),
    ...(targetWorkspaceName ? { targetWorkspaceName } : {}),
    ...(lastRoomId ? { lastRoomId } : {})
  };
}

function transferConnection(target: WorkspaceTargetRef, role: "source" | "destination", transferId?: string): WorkspaceConnection {
  const connection = workspaceConnectionRegistry.connections.find((candidate) => candidate.id === target.connectionId);
  if (!connection) throw new Error(`workspace_transfer_${role}_connection_not_found`);
  if (role === "source") {
    const sourceTarget = connection.targets.find((candidate) => candidate.workspaceId === target.workspaceId);
    if (!sourceTarget) throw new Error("workspace_transfer_source_target_not_found");
    if (sourceTarget.supersededBy) {
      const recovery = transferId ? workspaceTransferStatusById.get(transferId) : undefined;
      if (!recovery || recovery.source.connectionId !== target.connectionId || recovery.source.workspaceId !== target.workspaceId
        || !sameWorkspaceTarget(recovery.destination, sourceTarget.supersededBy) || recovery.sourceArchived === true) {
        throw new Error("workspace_transfer_source_superseded");
      }
    }
  }
  return connection;
}

/**
 * Status recovery is allowed to inspect a superseded source target.  The
 * normal transfer mutators continue to use transferConnection(), which keeps
 * a superseded source out of the ordinary selector/transfer path.
 */
function transferStatusConnection(target: WorkspaceTargetRef, role: "source" | "destination"): WorkspaceConnection {
  const connection = workspaceConnectionRegistry.connections.find((candidate) => candidate.id === target.connectionId);
  if (!connection) throw new Error(`workspace_transfer_${role}_connection_not_found`);
  if (!connection.targets.some((candidate) => candidate.workspaceId === target.workspaceId)) {
    throw new Error(`workspace_transfer_${role}_target_not_found`);
  }
  return connection;
}

async function transferPrivateKey(connection: WorkspaceConnection, role: "source" | "destination"): Promise<string> {
  try {
    return await requireActiveWorkspacePrivateKey(connection);
  } catch (error) {
    if (error instanceof Error && error.message.includes("identity")) throw new Error(`workspace_transfer_${role}_identity_required`);
    throw new Error(`workspace_transfer_${role}_unavailable`);
  }
}

async function transferRequest(
  connection: WorkspaceConnection,
  privateKey: string,
  input: WorkspaceServerRequestInput,
  failureCode: string
): Promise<{ status: number; body: unknown }> {
  try {
    const result = await signedWorkspaceServerRequest(connection, privateKey, input);
    if (result.status < 200 || result.status >= 300) throw new Error(`${failureCode}:${result.status}`);
    return result;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(`${failureCode}:`)) throw error;
    throw new Error(`${failureCode}_unavailable`);
  }
}

/** Read the source Server's durable transfer ledger before using a local checkpoint. */
async function readWorkspaceSourceTransferStatus(
  connection: WorkspaceConnection,
  privateKey: string,
  sourceWorkspaceId: string,
  transferId: string
): Promise<WorkspaceSourceTransferStatus | null> {
  let response: { status: number; body: unknown };
  try {
    response = await signedWorkspaceServerRequest(connection, privateKey, {
      method: "GET",
      path: `/api/workspaces/${encodeURIComponent(sourceWorkspaceId)}/transfers/${encodeURIComponent(transferId)}/status`,
      workspaceScoped: true,
      workspaceId: sourceWorkspaceId
    });
  } catch {
    throw new Error("workspace_transfer_source_status_unavailable");
  }
  // A missing transfer is expected for a brand-new operation.  A missing
  // checkpoint on a restart is handled by preflight as a safe stop.
  if (response.status === 404) return null;
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`workspace_transfer_source_status_failed:${response.status}`);
  }
  const body = objectRecord(response.body);
  const returnedTransferId = body?.transfer_id ?? body?.transferId;
  const state = body?.state;
  const sourceWorkspaceState = body?.source_workspace_state ?? body?.sourceWorkspaceState;
  if (returnedTransferId !== transferId
    || typeof state !== "string"
    || !["preparing", "exported", "imported", "committed", "rolled_back", "failed"].includes(state)
    || typeof sourceWorkspaceState !== "string"
    || !["active", "read_only", "archived", "deleted"].includes(sourceWorkspaceState)) {
    throw new Error("workspace_transfer_source_status_invalid");
  }
  const hashValue = (key: "source_integrity_hash" | "target_integrity_hash"): string | undefined => {
    const value = body?.[key] ?? body?.[key === "source_integrity_hash" ? "sourceIntegrityHash" : "targetIntegrityHash"];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
      throw new Error("workspace_transfer_source_status_invalid");
    }
    return value;
  };
  const targetWorkspaceValue = body?.target_workspace_id ?? body?.targetWorkspaceId;
  if (targetWorkspaceValue !== undefined && targetWorkspaceValue !== null
    && (typeof targetWorkspaceValue !== "string" || !isWorkspaceOpaqueId(targetWorkspaceValue))) {
    throw new Error("workspace_transfer_source_status_invalid");
  }
  const receiptValue = body?.receipt_present ?? body?.receiptPresent;
  if (typeof receiptValue !== "boolean") throw new Error("workspace_transfer_source_status_invalid");
  const sourceArchivedValue = body?.source_archived ?? body?.sourceArchived;
  if (sourceArchivedValue !== undefined && typeof sourceArchivedValue !== "boolean") {
    throw new Error("workspace_transfer_source_status_invalid");
  }
  const sourceIntegrityHash = hashValue("source_integrity_hash");
  const targetIntegrityHash = hashValue("target_integrity_hash");
  return {
    transferId,
    state: state as WorkspaceSourceTransferState,
    ...(sourceIntegrityHash ? { sourceIntegrityHash } : {}),
    ...(targetIntegrityHash ? { targetIntegrityHash } : {}),
    ...(typeof targetWorkspaceValue === "string" ? { targetWorkspaceId: targetWorkspaceValue } : {}),
    receiptPresent: receiptValue,
    sourceWorkspaceState: sourceWorkspaceState as WorkspaceSourceWorkspaceState,
    sourceArchived: sourceArchivedValue ?? (sourceWorkspaceState === "archived" || sourceWorkspaceState === "deleted")
  };
}

function workspaceTransferImportOutcomeUnknown(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("workspace_transfer_import_failed_unavailable")
    || /workspace_transfer_import_failed:5\d\d(?:$|:)/.test(message);
}

async function probeWorkspaceTransferHealth(connection: WorkspaceConnection): Promise<WorkspaceTransferHealth> {
  try {
    const response = await fetch(new URL("/api/health", `${connection.serverUrl}/`), {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(8_000)
    });
    const text = await response.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = undefined;
    }
    const record = objectRecord(body);
    const databaseIndicator = record?.db ?? record?.database;
    const database = objectRecord(databaseIndicator);
    const databaseOk = typeof databaseIndicator === "boolean"
      ? databaseIndicator
      : typeof database?.ok === "boolean"
        ? database.ok
        : undefined;
    const storage = objectRecord(record?.storage);
    const storageIndicator = record?.storage;
    const storageOk = typeof storageIndicator === "boolean"
      ? storageIndicator
      : typeof storage?.ok === "boolean"
        ? storage.ok
        : typeof storageIndicator === "string" && storageIndicator.trim().length > 0
          ? true
          : undefined;
    const schemaRevision = workspaceTransferSchemaRevision(body);
    return {
      status: response.status,
      ok: response.status >= 200 && response.status < 300 && record?.ok === true
        && databaseOk !== false && storageOk !== false,
      ...(databaseOk === undefined ? {} : { databaseOk }),
      ...(storageOk === undefined ? {} : { storageOk }),
      ...(schemaRevision === undefined ? {} : { schemaRevision })
    };
  } catch {
    return { status: 0, ok: false };
  }
}

function workspaceTransferSchemaRevision(healthBody: unknown): number | undefined {
  const record = objectRecord(healthBody);
  const candidates = [
    healthBody && typeof healthBody === "object" && "schema_revision" in healthBody ? (healthBody as Record<string, unknown>).schema_revision : undefined,
    record?.schema_revision,
    record?.schema_version,
    record?.schemaRevision,
    record?.schemaVersion,
    objectRecord(record?.db)?.schema_revision,
    objectRecord(record?.db)?.schema_version,
    objectRecord(record?.db)?.schemaRevision,
    objectRecord(record?.db)?.schemaVersion,
    objectRecord(record?.database)?.schema_revision,
    objectRecord(record?.database)?.schema_version,
    objectRecord(record?.database)?.schemaRevision,
    objectRecord(record?.database)?.schemaVersion,
    objectRecord(record?.schema)?.schema_revision,
    objectRecord(record?.schema)?.schema_version,
    objectRecord(record?.schema)?.revision
  ];
  const revision = candidates
    .map((value) => typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value.trim())
        ? Number(value)
        : undefined)
    .find((value): value is number => value !== undefined && Number.isSafeInteger(value) && value > 0);
  return revision;
}

function assertWorkspaceTransferReplayIdentity(request: WorkspaceTransferRequest): void {
  const transferId = request.transferId ?? request.operationId;
  const previous = workspaceTransferStatusById.get(transferId);
  if (!previous) return;
  const sameSource = sameWorkspaceTarget(previous.source, request.source);
  const sameDestination = sameWorkspaceTarget(previous.destination, request.destination);
  if (!sameSource || !sameDestination) throw new Error("workspace_transfer_id_replay_mismatch");
}

async function preflightWorkspaceTargetTransfer(
  request: WorkspaceTransferRequest,
  knownSourceTransferStatus?: WorkspaceSourceTransferStatus | null
): Promise<WorkspaceTransferPreflight> {
  const transferId = request.transferId ?? request.operationId;
  // Query the source ledger before reading the local checkpoint.  The local
  // registry is only a renderer-safe resume hint; the source Server owns the
  // authoritative phase and archived/read-only state.
  const statusConnection = transferStatusConnection(request.source, "source");
  let sourceTransferStatus: WorkspaceSourceTransferStatus | null;
  if (knownSourceTransferStatus !== undefined) {
    sourceTransferStatus = knownSourceTransferStatus;
  } else {
    try {
      const statusKey = await transferPrivateKey(statusConnection, "source");
      sourceTransferStatus = await readWorkspaceSourceTransferStatus(statusConnection, statusKey, request.source.workspaceId, transferId);
    } catch (error) {
      assertWorkspaceTransferReplayIdentity(request);
      const previous = workspaceTransferStatusById.get(transferId);
      const failureCode = error instanceof Error ? error.message.split(":", 1)[0] ?? "workspace_transfer_source_status_unavailable" : "workspace_transfer_source_status_unavailable";
      return stopWorkspaceTransferSafely(
        request,
        previous,
        failureCode,
        "Source transfer status could not be verified; the local checkpoint was not trusted and the source was retained."
      );
    }
  }
  assertWorkspaceTransferReplayIdentity(request);
  const previousTransfer = workspaceTransferStatusById.get(transferId);
  const sourceConnection = sourceTransferStatus
    && ((sourceTransferStatus.state === "committed" && sourceTransferStatus.sourceArchived)
      || sourceTransferStatus.state === "rolled_back"
      || sourceTransferStatus.state === "failed")
    ? statusConnection
    : transferConnection(request.source, "source", transferId);
  const destinationConnection = transferConnection(request.destination, "destination");
  const sourceTarget = sourceConnection.targets.find((target) => target.workspaceId === request.source.workspaceId);
  const registryCutoverMarker = sameWorkspaceTarget(sourceTarget?.supersededBy, request.destination);
  const sourceCommittedArchived = Boolean(sourceTransferStatus?.state === "committed" && sourceTransferStatus.sourceArchived);
  const remoteImported = sourceTransferStatus?.state === "imported";
  const importRecoveryPending = Boolean(previousTransfer
    && previousTransfer.sourceArchived !== true
    && previousTransfer.state === "restoring"
    && sameWorkspaceTarget(previousTransfer.destination, request.destination));
  const resumableCutover = Boolean(previousTransfer
    && previousTransfer.sourceArchived !== true
    && (previousTransfer.state === "cutover"
      || (registryCutoverMarker && previousTransfer.receipt)
      || (remoteImported && previousTransfer.receipt)));
  if (sourceTarget?.supersededBy && !sameWorkspaceTarget(sourceTarget.supersededBy, request.destination)) {
    return stopWorkspaceTransferSafely(
      request,
      previousTransfer,
      "workspace_transfer_source_status_target_mismatch",
      "The source target is already superseded by a different destination; this transfer was stopped without changing either target."
    );
  }
  if (sourceTransferStatus && (sourceTransferStatus.state === "rolled_back" || sourceTransferStatus.state === "failed")) {
    return stopWorkspaceTransferSafely(
      request,
      previousTransfer,
      `workspace_transfer_source_${sourceTransferStatus.state}`,
      `The source Server reports this transfer as ${sourceTransferStatus.state}; no new import or rollback was attempted. Retry requires an explicit recovery decision.`,
      { sourceArchived: sourceTransferStatus.sourceArchived }
    );
  }
  if (sourceTransferStatus === null && previousTransfer && previousTransfer.state !== "preflight") {
    return stopWorkspaceTransferSafely(
      request,
      previousTransfer,
      "workspace_transfer_source_status_missing",
      "The source Server has no durable status for this resumed transfer; the local checkpoint was not trusted and no mutating phase was attempted.",
      { sourceArchived: previousTransfer.sourceArchived }
    );
  }
  if (sourceTransferStatus && (sourceTransferStatus.state === "imported" || sourceTransferStatus.state === "committed")) {
    if (sourceTransferStatus.state === "committed" && !sourceTransferStatus.sourceArchived) {
      return stopWorkspaceTransferSafely(
        request,
        previousTransfer,
        "workspace_transfer_source_status_incomplete",
        "The source reports a committed transfer but is not archived; local cutover was not changed and no rollback was attempted.",
        { sourceArchived: false }
      );
    }
    if (sourceTransferStatus.targetWorkspaceId !== request.destination.workspaceId || !sourceTransferStatus.receiptPresent) {
      return stopWorkspaceTransferSafely(
        request,
        previousTransfer,
        "workspace_transfer_source_status_incomplete",
        "The source transfer is imported/committed but its target or receipt checkpoint is incomplete; the source was retained and no target overwrite was attempted.",
        { sourceArchived: sourceTransferStatus.sourceArchived, targetRestored: sourceTransferStatus.state === "committed" }
      );
    }
    if (sourceTransferStatus.sourceIntegrityHash && sourceTransferStatus.targetIntegrityHash
      && sourceTransferStatus.sourceIntegrityHash !== sourceTransferStatus.targetIntegrityHash) {
      return stopWorkspaceTransferSafely(
        request,
        previousTransfer,
        "workspace_transfer_source_status_integrity_mismatch",
        "The source Server reports different source and target integrity hashes; the transfer was stopped without changing the target.",
        { sourceArchived: sourceTransferStatus.sourceArchived, targetRestored: sourceTransferStatus.state === "committed" }
      );
    }
    if (previousTransfer?.receipt && previousTransfer.receipt.target_workspace_id !== request.destination.workspaceId) {
      return stopWorkspaceTransferSafely(
        request,
        previousTransfer,
        "workspace_transfer_source_status_target_mismatch",
        "The durable source receipt points to a different target Workspace; the transfer was stopped without rollback or target overwrite.",
        { sourceArchived: sourceTransferStatus.sourceArchived, targetRestored: sourceTransferStatus.state === "committed" }
      );
    }
  }
  const [sourceKey, destinationKey] = await Promise.all([
    transferPrivateKey(sourceConnection, "source"),
    transferPrivateKey(destinationConnection, "destination")
  ]);
  const [sourceResponse, destinationResponse, sourceHealth, destinationHealth] = await Promise.all([
    transferRequest(sourceConnection, sourceKey, {
      method: "GET",
      path: `/api/workspaces/${encodeURIComponent(request.source.workspaceId)}`,
      workspaceScoped: true,
      workspaceId: request.source.workspaceId
    }, "workspace_transfer_source_request_failed"),
    transferRequest(destinationConnection, destinationKey, {
      method: "GET",
      path: "/api/account/workspaces",
      workspaceScoped: false
    }, "workspace_transfer_destination_request_failed"),
    probeWorkspaceTransferHealth(sourceConnection),
    probeWorkspaceTransferHealth(destinationConnection)
  ]);
  if (!sourceHealth.ok) {
    return stopWorkspaceTransferSafely(
      request,
      previousTransfer,
      "workspace_transfer_source_health_unavailable",
      "The source Server health check failed; the transfer was stopped before any mutation."
    );
  }
  if (!destinationHealth.ok) {
    return stopWorkspaceTransferSafely(
      request,
      previousTransfer,
      "workspace_transfer_destination_health_unavailable",
      "The destination Server health check failed; the source was retained and no import was attempted."
    );
  }
  const sourceWorkspaceId = responseString(sourceResponse.body, "id") ?? responseString(sourceResponse.body, "workspace_id");
  if (sourceWorkspaceId !== request.source.workspaceId) {
    return stopWorkspaceTransferSafely(
      request,
      previousTransfer,
      "workspace_transfer_source_workspace_mismatch",
      "The source Server returned a different Workspace ID; no transfer phase was attempted."
    );
  }
  const sourceRole = summaryString(sourceResponse.body, "role");
  if (sourceRole !== "owner") {
    return stopWorkspaceTransferSafely(
      request,
      previousTransfer,
      "workspace_transfer_owner_required",
      "Owner authorization is required on the source Workspace; the transfer was stopped safely."
    );
  }
  const sourceState = summaryString(sourceResponse.body, "state");
  if (sourceTransferStatus && sourceState
    && sourceTransferStatus.sourceWorkspaceState !== sourceState
    && !(sourceTransferStatus.state === "committed" && sourceTransferStatus.sourceArchived && sourceState === "deleted")) {
    return stopWorkspaceTransferSafely(
      request,
      previousTransfer,
      "workspace_transfer_source_status_state_mismatch",
      "The source workspace state disagrees with the durable transfer checkpoint; the transfer was stopped safely."
    );
  }
  if (sourceTransferStatus?.state === "preparing" || sourceTransferStatus?.state === "exported") {
    if (sourceState !== "read_only") {
      return stopWorkspaceTransferSafely(
        request,
        previousTransfer,
        "workspace_transfer_source_status_state_mismatch",
        "The source transfer is preparing/exported but the source workspace is not read-only; no transfer phase was resumed."
      );
    }
  }
  if (sourceTransferStatus?.state === "imported") {
    if (sourceState !== "read_only" || !previousTransfer?.receipt) {
      return stopWorkspaceTransferSafely(
        request,
        previousTransfer,
        "workspace_transfer_source_status_incomplete",
        "The source reports an imported transfer but the local receipt checkpoint is missing or the source is not read-only; no target overwrite was attempted.",
        { sourceArchived: sourceTransferStatus.sourceArchived, targetRestored: true }
      );
    }
  }
  if (sourceCommittedArchived && sourceState !== "archived" && sourceState !== "deleted") {
    return stopWorkspaceTransferSafely(
      request,
      previousTransfer,
      "workspace_transfer_source_status_state_mismatch",
      "The source transfer is committed but the source workspace is not archived; local cutover was not changed.",
      { sourceArchived: sourceTransferStatus?.sourceArchived }
    );
  }
  if (sourceState === "archived" && !resumableCutover && !sourceCommittedArchived) {
    return stopWorkspaceTransferSafely(
      request,
      previousTransfer,
      "workspace_transfer_source_not_transferable",
      "The source workspace is archived without a matching committed transfer checkpoint; no local cutover or rollback was attempted.",
      { sourceArchived: true }
    );
  }
  if (sourceState === "read_only" && !resumableCutover
    && sourceTransferStatus?.state !== "preparing"
    && sourceTransferStatus?.state !== "imported"
    && sourceTransferStatus?.state !== "committed") {
    // A read-only source is valid only when the Server already has an exported
    // transfer for this exact ID. This is the restart/retry path after begin.
    try {
      const manifest = await transferRequest(sourceConnection, sourceKey, {
        method: "GET",
        path: `/api/workspaces/${encodeURIComponent(request.source.workspaceId)}/transfers/${encodeURIComponent(transferId)}/manifest`,
        workspaceScoped: true,
        workspaceId: request.source.workspaceId,
        operationId: workspaceTransferPhaseOperationId(transferId, "manifest"),
        idempotencyKey: workspaceTransferPhaseOperationId(transferId, "manifest")
      }, "workspace_transfer_source_manifest_request_failed");
      if (!manifest.body) throw new Error("workspace_transfer_source_not_transferable");
    } catch (error) {
      if (error instanceof Error && error.message === "workspace_transfer_source_not_transferable") {
        return stopWorkspaceTransferSafely(
          request,
          previousTransfer,
          "workspace_transfer_source_not_transferable",
          "The source read-only Workspace has no verified exported bundle for this transfer ID."
        );
      }
      return stopWorkspaceTransferSafely(
        request,
        previousTransfer,
        "workspace_transfer_source_not_transferable",
        "The source transfer manifest could not be verified; no new import or rollback was attempted."
      );
    }
  }
  const destinationSummaries = extractArray(destinationResponse.body, ["workspaces"]);
  const destinationExists = destinationSummaries.some((summary) =>
    (responseString(summary, "id") ?? responseString(summary, "workspace_id")) === request.destination.workspaceId);
  const destinationMustExist = resumableCutover || remoteImported || sourceCommittedArchived;
  const destinationMayExistForImportRecovery = importRecoveryPending
    && (sourceTransferStatus === null || sourceTransferStatus?.state === "preparing" || sourceTransferStatus?.state === "exported");
  if (destinationMustExist && !destinationExists) {
    return stopWorkspaceTransferSafely(
      request,
      previousTransfer,
      "workspace_transfer_destination_missing",
      "The durable source checkpoint expects the destination Workspace, but it was not found; no target was overwritten."
    );
  }
  if (!destinationMustExist && !destinationMayExistForImportRecovery && destinationExists) {
    return stopWorkspaceTransferSafely(
      request,
      previousTransfer,
      "workspace_transfer_destination_conflict",
      "The destination Workspace ID already exists outside this transfer; no target overwrite was attempted."
    );
  }
  const sourceSchemaRevision = workspaceTransferSchemaRevision(sourceHealth);
  const destinationSchemaRevision = workspaceTransferSchemaRevision(destinationHealth);
  if (sourceSchemaRevision !== undefined && destinationSchemaRevision !== undefined && sourceSchemaRevision !== destinationSchemaRevision) {
    return stopWorkspaceTransferSafely(
      request,
      previousTransfer,
      "workspace_transfer_schema_incompatible",
      "Source and destination schema revisions differ; the transfer was stopped before import."
    );
  }
  const schemaCompatibility = sourceSchemaRevision === undefined || destinationSchemaRevision === undefined
    ? "unverified"
    : "compatible";
  const workspaceName = summaryString(sourceResponse.body, "name");
  const sourceVersion = summaryNumber(sourceResponse.body, "version");
  const result: WorkspaceTransferPreflight = {
    transferId,
    source: { ...request.source },
    destination: { ...request.destination },
    workspaceId: request.source.workspaceId,
    ...(workspaceName ? { workspaceName } : {}),
    ...(sourceVersion === undefined ? {} : { sourceVersion }),
    ...(sourceState === "active" || sourceState === "read_only" || sourceState === "archived" ? { sourceState } : {}),
    writeBlocked: false,
    organizationReleased: false,
    sourceWillArchive: true,
    failureConditions: [],
    sourceServerUrl: sourceConnection.serverUrl,
    destinationServerUrl: destinationConnection.serverUrl,
    sourceHealth,
    destinationHealth,
    schemaCompatibility,
    ...(sourceSchemaRevision === undefined ? {} : { sourceSchemaRevision }),
    ...(destinationSchemaRevision === undefined ? {} : { destinationSchemaRevision }),
    capacityUnverified: true,
    capacityLimitBytes: workspaceTransferMaxBytes,
    capacityLimitEntries: workspaceTransferMaxEntries,
    ...(sourceTransferStatus ? { sourceTransferState: sourceTransferStatus.state } : {})
  };
  // A cutover checkpoint is already the local point of no return. Do not
  // downgrade it to `preflight` when a UI refreshes after source completion
  // failed; the receipt remains the restart-safe input for the next execute.
  if (!resumableCutover && !sourceCommittedArchived && previousTransfer?.state !== "source_archived") {
    await setWorkspaceTransferStatus({
      transferId: result.transferId,
      source: result.source,
      destination: result.destination,
      state: "preflight",
      workspaceId: result.workspaceId,
      ...(result.workspaceName ? { workspaceName: result.workspaceName } : {}),
      writeBlocked: false,
      organizationReleased: false,
      sourceArchived: false,
      capacityUnverified: true,
      updatedAt: new Date().toISOString()
    });
  }
  return result;
}

interface WorkspaceTransferTransport {
  format: "samurai-workspace-bundle-v3" | "samurai-workspace-bundle-v4";
  manifest: Record<string, unknown>;
  entries: Array<{ path: string; content_base64: string }>;
  entryCount: number;
  dataByteSize: number;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function validateWorkspaceTransferTransport(
  value: unknown,
  transferId: string,
  sourceWorkspaceId: string,
  expectedManifest?: unknown
): WorkspaceTransferTransport {
  const body = objectRecord(value);
  const format = body?.format;
  if (format !== "samurai-workspace-bundle-v3" && format !== "samurai-workspace-bundle-v4") throw new Error("workspace_transfer_bundle_invalid");
  const manifest = objectRecord(body?.manifest);
  const entries = body?.entries;
  if (!manifest || !Array.isArray(entries)) throw new Error("workspace_transfer_bundle_invalid");
  if (manifest.format_version !== (format.endsWith("v4") ? 4 : 3)
    || manifest.workspace_id !== sourceWorkspaceId || manifest.transfer_id !== transferId
    || typeof manifest.integrity_hash !== "string" || !/^[a-f0-9]{64}$/.test(manifest.integrity_hash)
    || !objectRecord(manifest.files)) throw new Error("workspace_transfer_bundle_invalid");
  const expected = objectRecord(expectedManifest);
  if (expected?.integrity_hash !== undefined && expected.integrity_hash !== manifest.integrity_hash) {
    throw new Error("workspace_transfer_bundle_mismatch");
  }
  if (entries.length > workspaceTransferMaxEntries) throw new Error("workspace_transfer_bundle_too_large");
  const seen = new Set<string>();
  let dataByteSize = 0;
  const normalizedEntries = entries.map((entry) => {
    const item = objectRecord(entry);
    if (!item || typeof item.path !== "string" || typeof item.content_base64 !== "string" || !item.path || item.path.length > 1_024 || seen.has(item.path)) {
      throw new Error("workspace_transfer_bundle_entry_invalid");
    }
    if (item.path.startsWith("/") || item.path.includes("\\") || item.path.split("/").some((part) => part === ".." || part === "" || part === ".")) {
      throw new Error("workspace_transfer_bundle_path_invalid");
    }
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(item.content_base64)) {
      throw new Error("workspace_transfer_bundle_entry_invalid");
    }
    seen.add(item.path);
    const bytes = Buffer.from(item.content_base64, "base64");
    dataByteSize += bytes.byteLength;
    if (dataByteSize > workspaceTransferMaxBytes) throw new Error("workspace_transfer_bundle_too_large");
    return { path: item.path, content_base64: item.content_base64 };
  });
  return { format, manifest, entries: normalizedEntries, entryCount: normalizedEntries.length, dataByteSize };
}

function parseWorkspaceTransferReceipt(
  value: unknown,
  transferId: string,
  sourceWorkspaceId: string,
  destinationWorkspaceId: string,
  integrityHash: string
): WorkspaceTransferReceiptRecord {
  const receipt = objectRecord(value);
  if (!receipt || receipt.format_version !== 1
    || receipt.transfer_id !== transferId
    || receipt.source_workspace_id !== sourceWorkspaceId
    || receipt.target_workspace_id !== destinationWorkspaceId
    || typeof receipt.imported_at !== "string"
    || !Number.isFinite(new Date(receipt.imported_at).getTime())
    || receipt.source_integrity_hash !== integrityHash
    || receipt.target_integrity_hash !== integrityHash
    || typeof receipt.source_integrity_hash !== "string"
    || typeof receipt.target_integrity_hash !== "string"
    || !/^[a-f0-9]{64}$/.test(receipt.source_integrity_hash)
    || !/^[a-f0-9]{64}$/.test(receipt.target_integrity_hash)) {
    throw new Error("workspace_transfer_receipt_invalid");
  }
  return {
    format_version: 1,
    transfer_id: transferId,
    source_workspace_id: sourceWorkspaceId,
    source_integrity_hash: integrityHash,
    target_workspace_id: destinationWorkspaceId,
    imported_at: receipt.imported_at,
    target_integrity_hash: integrityHash
  };
}

/**
 * Reconcile a locally persisted receipt with the authoritative source hashes.
 * Older Desktop builds could persist a V3 receipt before the target accepted
 * the V4 bundle. Keep the timestamp/identity but use the durable hashes so a
 * repaired receipt receives a different, deterministic ledger key.
 */
function reconcileWorkspaceTransferReceipt(
  receipt: WorkspaceTransferReceiptRecord | undefined,
  sourceStatus: WorkspaceSourceTransferStatus | null,
  localIntegrityHash: string | undefined,
  sourceWorkspaceId: string,
  destinationWorkspaceId: string
): WorkspaceTransferReceiptRecord | undefined {
  if (!receipt
    || receipt.source_workspace_id !== sourceWorkspaceId
    || receipt.target_workspace_id !== destinationWorkspaceId) return undefined;
  const sourceIntegrityHash = sourceStatus?.sourceIntegrityHash ?? localIntegrityHash ?? receipt.source_integrity_hash;
  const targetIntegrityHash = sourceStatus?.targetIntegrityHash ?? sourceIntegrityHash;
  if (!/^[a-f0-9]{64}$/.test(sourceIntegrityHash) || !/^[a-f0-9]{64}$/.test(targetIntegrityHash)) return undefined;
  if (sourceIntegrityHash === receipt.source_integrity_hash && targetIntegrityHash === receipt.target_integrity_hash) return receipt;
  return {
    ...receipt,
    source_integrity_hash: sourceIntegrityHash,
    target_integrity_hash: targetIntegrityHash
  };
}

async function executeWorkspaceTargetTransfer(request: WorkspaceTransferRequest): Promise<WorkspaceTransferStatus> {
  const transferId = request.transferId ?? request.operationId;
  const inFlight = workspaceTransferInFlightById.get(transferId);
  if (inFlight) return inFlight;
  const execution = executeWorkspaceTargetTransferOnce(request);
  workspaceTransferInFlightById.set(transferId, execution);
  try {
    return await execution;
  } finally {
    if (workspaceTransferInFlightById.get(transferId) === execution) workspaceTransferInFlightById.delete(transferId);
  }
}

async function executeWorkspaceTargetTransferOnce(request: WorkspaceTransferRequest): Promise<WorkspaceTransferStatus> {
  const transferId = request.transferId ?? request.operationId;
  // The source Server is authoritative after a restart. Fetch this status
  // before consulting the local checkpoint or choosing a resume branch.
  const statusConnection = transferStatusConnection(request.source, "source");
  let sourceTransferStatus: WorkspaceSourceTransferStatus | null;
  try {
    const statusKey = await transferPrivateKey(statusConnection, "source");
    sourceTransferStatus = await readWorkspaceSourceTransferStatus(
      statusConnection,
      statusKey,
      request.source.workspaceId,
      transferId
    );
  } catch (error) {
    assertWorkspaceTransferReplayIdentity(request);
    const previous = workspaceTransferStatusById.get(transferId);
    const failureCode = error instanceof Error ? error.message.split(":", 1)[0] ?? "workspace_transfer_source_status_unavailable" : "workspace_transfer_source_status_unavailable";
    return stopWorkspaceTransferSafely(
      request,
      previous,
      failureCode,
      "Source transfer status could not be verified after restart; the local checkpoint was not trusted and the source was retained.",
      { sourceArchived: previous?.sourceArchived }
    );
  }
  assertWorkspaceTransferReplayIdentity(request);
  const previousTransfer = workspaceTransferStatusById.get(transferId);
  const sourceTarget = statusConnection.targets.find((target) => target.workspaceId === request.source.workspaceId);
  const registryCutoverMarker = sameWorkspaceTarget(sourceTarget?.supersededBy, request.destination);
  const sourceCommittedArchived = Boolean(sourceTransferStatus?.state === "committed" && sourceTransferStatus.sourceArchived);
  const remoteImported = sourceTransferStatus?.state === "imported";
  const resumableCutover = Boolean(previousTransfer
    && previousTransfer.sourceArchived !== true
    && (previousTransfer.state === "cutover"
      || (registryCutoverMarker && previousTransfer.receipt)
      || (remoteImported && previousTransfer.receipt)));
  const resumeReceipt = reconcileWorkspaceTransferReceipt(
    previousTransfer?.receipt,
    sourceTransferStatus,
    previousTransfer?.integrityHash,
    request.source.workspaceId,
    request.destination.workspaceId
  ) ?? previousTransfer?.receipt;
  const preflight = await preflightWorkspaceTargetTransfer(request, sourceTransferStatus);
  const sourceConnection = sourceCommittedArchived
    ? statusConnection
    : transferConnection(request.source, "source", transferId);
  const destinationConnection = transferConnection(request.destination, "destination");
  let sourceKey: string | undefined;
  let destinationKey: string | undefined;
  let sourceCompleted = false;
  let registryCutover = false;
  let targetRestored = false;
  // A committed source is already archived on the Server. It must never be
  // rolled back, even when local target authorization or registry persistence
  // fails during restart recovery.
  const sourceTerminalNoRollback = sourceCommittedArchived;
  let importOutcomeUnknown = false;
  let transport: WorkspaceTransferTransport | undefined;
  let receipt: WorkspaceTransferReceiptRecord | undefined = resumeReceipt;
  try {
    [sourceKey, destinationKey] = await Promise.all([
      transferPrivateKey(sourceConnection, "source"),
      transferPrivateKey(destinationConnection, "destination")
    ]);
    if (!sourceKey || !destinationKey) throw new Error("workspace_transfer_identity_required");
    if (sourceCommittedArchived) {
      // The source has already completed the durable transfer. Do not import
      // again or submit receipt/rollback; only re-authorize the destination
      // and persist the local selector cutover.
      const authorization = await authorizeWorkspaceTargetForTransition(
        request.destination,
        request.lastRoomId ?? destinationConnection.targets.find((target) => target.workspaceId === request.destination.workspaceId)?.lastRoomId
      );
      await commitWorkspaceTargetCutover({
        source: request.source,
        destination: request.destination,
        lastOrganizationId: authorization.organizationId ?? null,
        lastRoomId: authorization.roomId ?? null
      }, authorization);
      registryCutover = true;
      sourceCompleted = true;
      const committedStatus: WorkspaceTransferStatus = {
        transferId,
        source: { ...request.source },
        destination: { ...request.destination },
        state: "source_archived",
        workspaceId: request.source.workspaceId,
        ...(previousTransfer?.workspaceName ? { workspaceName: previousTransfer.workspaceName } : preflight.workspaceName ? { workspaceName: preflight.workspaceName } : {}),
        ...(previousTransfer?.dataByteSize === undefined ? {} : { dataByteSize: previousTransfer.dataByteSize }),
        ...(previousTransfer?.entryCount === undefined ? {} : { entryCount: previousTransfer.entryCount }),
        capacityUnverified: previousTransfer?.capacityUnverified ?? preflight.capacityUnverified,
        ...(sourceTransferStatus?.sourceIntegrityHash ?? sourceTransferStatus?.targetIntegrityHash ?? previousTransfer?.integrityHash
          ? { integrityHash: sourceTransferStatus?.sourceIntegrityHash ?? sourceTransferStatus?.targetIntegrityHash ?? previousTransfer?.integrityHash } : {}),
        organizationReleased: true,
        sourceArchived: true,
        targetRestored: true,
        targetCleanupRequired: false,
        ...(previousTransfer?.receipt ? { receipt: previousTransfer.receipt } : {}),
        updatedAt: new Date().toISOString()
      };
      await setWorkspaceTransferStatus(committedStatus);
      return committedStatus;
    }
    if (resumableCutover) {
      // After receipt submission the Server transfer is no longer exportable.
      // Resume from the durable Desktop checkpoint instead of asking the source
      // for a bundle that can only exist in the `exported` state.
      registryCutover = true;
      targetRestored = true;
      if (!receipt) throw new Error("workspace_transfer_receipt_required");
      const receiptForResume = receipt;
      const authorization = await authorizeWorkspaceTargetForTransition(
        request.destination,
        request.lastRoomId ?? destinationConnection.targets.find((target) => target.workspaceId === request.destination.workspaceId)?.lastRoomId
      );
      await commitWorkspaceTargetCutover({
        source: request.source,
        destination: request.destination,
        lastOrganizationId: authorization.organizationId ?? null,
        lastRoomId: authorization.roomId ?? null
      }, authorization);
      if (preflight.sourceState !== "archived") {
        const submitReceipt = () => transferRequest(sourceConnection, sourceKey!, {
          method: "POST",
          path: `/api/workspaces/${encodeURIComponent(request.source.workspaceId)}/transfers/${encodeURIComponent(transferId)}/receipt`,
          workspaceScoped: true,
          workspaceId: request.source.workspaceId,
          operationId: workspaceTransferReceiptOperationId(transferId, receiptForResume),
          idempotencyKey: workspaceTransferReceiptOperationId(transferId, receiptForResume),
          body: { target_workspace_id: request.destination.workspaceId, receipt: receiptForResume }
        }, "workspace_transfer_receipt_submit_failed");
        const completeSource = () => transferRequest(sourceConnection, sourceKey!, {
          method: "POST",
          path: `/api/workspaces/${encodeURIComponent(request.source.workspaceId)}/transfers/${encodeURIComponent(transferId)}/complete`,
          workspaceScoped: true,
          workspaceId: request.source.workspaceId,
          operationId: workspaceTransferPhaseOperationId(transferId, "complete"),
          idempotencyKey: workspaceTransferPhaseOperationId(transferId, "complete"),
          body: {}
        }, "workspace_transfer_complete_failed");
        // A source that is still exported/read_only has not necessarily
        // accepted the target receipt yet. Re-submit the same receipt first;
        // its phase key makes an accepted receipt an idempotent retry, then
        // complete the source transfer.
        await submitReceipt();
        await completeSource();
      }
      sourceCompleted = true;
      const resumedStatus: WorkspaceTransferStatus = {
        transferId,
        source: { ...request.source },
        destination: { ...request.destination },
        state: "source_archived",
        workspaceId: request.source.workspaceId,
        ...(previousTransfer?.workspaceName ? { workspaceName: previousTransfer.workspaceName } : preflight.workspaceName ? { workspaceName: preflight.workspaceName } : {}),
        ...(previousTransfer?.dataByteSize === undefined ? {} : { dataByteSize: previousTransfer.dataByteSize }),
        ...(previousTransfer?.entryCount === undefined ? {} : { entryCount: previousTransfer.entryCount }),
        capacityUnverified: previousTransfer?.capacityUnverified ?? preflight.capacityUnverified,
        integrityHash: previousTransfer?.integrityHash ?? receipt.source_integrity_hash,
        organizationReleased: true,
        sourceArchived: true,
        receipt,
        updatedAt: new Date().toISOString()
      };
      await setWorkspaceTransferStatus(resumedStatus);
      return resumedStatus;
    }
    const begun = await transferRequest(sourceConnection, sourceKey, {
      method: "POST",
      path: `/api/workspaces/${encodeURIComponent(request.source.workspaceId)}/transfers`,
      workspaceScoped: true,
      workspaceId: request.source.workspaceId,
      operationId: workspaceTransferPhaseOperationId(transferId, "begin"),
      idempotencyKey: workspaceTransferPhaseOperationId(transferId, "begin"),
      body: {}
    }, "workspace_transfer_begin_failed");
    const begunTransferId = responseString(begun.body, "transfer_id");
    if (begunTransferId !== transferId) throw new Error("workspace_transfer_id_mismatch");
    const bundleResponse = await transferRequest(sourceConnection, sourceKey, {
      method: "GET",
      path: `/api/workspaces/${encodeURIComponent(request.source.workspaceId)}/transfers/${encodeURIComponent(transferId)}/bundle`,
      workspaceScoped: true,
      workspaceId: request.source.workspaceId,
      operationId: workspaceTransferPhaseOperationId(transferId, "bundle"),
      idempotencyKey: workspaceTransferPhaseOperationId(transferId, "bundle")
    }, "workspace_transfer_bundle_request_failed");
    transport = validateWorkspaceTransferTransport(bundleResponse.body, transferId, request.source.workspaceId, objectRecord(begun.body)?.manifest);
    await setWorkspaceTransferStatus({
      transferId,
      source: { ...request.source },
      destination: { ...request.destination },
      state: "exported",
      workspaceId: request.source.workspaceId,
      ...(preflight.workspaceName ? { workspaceName: preflight.workspaceName } : {}),
      dataByteSize: transport.dataByteSize,
      entryCount: transport.entryCount,
      capacityUnverified: preflight.capacityUnverified,
      sourceArchived: false,
      updatedAt: new Date().toISOString()
    });
    await setWorkspaceTransferStatus({
      transferId,
      source: { ...request.source },
      destination: { ...request.destination },
      state: "restoring",
      workspaceId: request.source.workspaceId,
      ...(preflight.workspaceName ? { workspaceName: preflight.workspaceName } : {}),
      dataByteSize: transport.dataByteSize,
      entryCount: transport.entryCount,
      capacityUnverified: preflight.capacityUnverified,
      integrityHash: transport.manifest.integrity_hash as string,
      organizationReleased: false,
      sourceArchived: false,
      targetRestored: false,
      updatedAt: new Date().toISOString()
    });
    const importInput: WorkspaceServerRequestInput = {
      method: "POST",
      path: "/api/workspaces/imports",
      workspaceScoped: false,
      operationId: workspaceTransferPhaseOperationId(transferId, "import"),
      idempotencyKey: workspaceTransferPhaseOperationId(transferId, "import"),
      body: {
        target_workspace_id: request.destination.workspaceId,
        bundle: transport,
        ...(request.targetWorkspaceName ?? preflight.workspaceName ? { target_workspace_name: request.targetWorkspaceName ?? preflight.workspaceName } : {})
      }
    };
    let imported: { status: number; body: unknown };
    try {
      imported = await transferRequest(destinationConnection, destinationKey, importInput, "workspace_transfer_import_failed");
    } catch (error) {
      if (!workspaceTransferImportOutcomeUnknown(error)) throw error;
      // The target may have been created before a transport timeout/5xx. Keep
      // the source recoverable and resend the identical import operation so
      // the Server's idempotency ledger can either replay or confirm it.
      importOutcomeUnknown = true;
      imported = await transferRequest(destinationConnection, destinationKey, importInput, "workspace_transfer_import_failed");
    }
    targetRestored = true;
    // A successful HTTP status is not enough to prove that the target import
    // can be reconciled. Keep the outcome unknown until the workspace ID,
    // manifest and receipt all validate; malformed/partial responses must not
    // trigger an automatic source rollback.
    importOutcomeUnknown = true;
    const importedWorkspaceId = responseString(imported.body, "workspace_id") ?? responseString(imported.body, "workspaceId");
    if (importedWorkspaceId !== request.destination.workspaceId) throw new Error("workspace_transfer_import_workspace_mismatch");
    const importedManifest = objectRecord(objectRecord(imported.body)?.manifest);
    if (!importedManifest || importedManifest.integrity_hash !== transport.manifest.integrity_hash) throw new Error("workspace_transfer_receipt_manifest_mismatch");
    receipt = parseWorkspaceTransferReceipt(objectRecord(imported.body)?.receipt, transferId, request.source.workspaceId, request.destination.workspaceId, transport.manifest.integrity_hash as string);
    importOutcomeUnknown = false;
    const sourceTarget = sourceConnection.targets.find((candidate) => candidate.workspaceId === request.source.workspaceId);
    const authorization = await authorizeWorkspaceTargetForTransition(request.destination, request.lastRoomId ?? sourceTarget?.lastRoomId);
    await setWorkspaceTransferStatus({
      transferId,
      source: { ...request.source },
      destination: { ...request.destination },
      state: "verified",
      workspaceId: request.source.workspaceId,
      ...(preflight.workspaceName ? { workspaceName: preflight.workspaceName } : {}),
      dataByteSize: transport.dataByteSize,
      entryCount: transport.entryCount,
      capacityUnverified: preflight.capacityUnverified,
      integrityHash: transport.manifest.integrity_hash as string,
      organizationReleased: false,
      sourceArchived: false,
      receipt,
      updatedAt: new Date().toISOString()
    });
    // The local cutover is the point of no return for the Desktop selector.
    // Commit it only after destination authorization and receipt verification,
    // while the source is still recoverable/read-only.
    await commitWorkspaceTargetCutover({
      source: request.source,
      destination: request.destination,
      lastOrganizationId: authorization.organizationId ?? null,
      lastRoomId: authorization.roomId ?? null
    }, authorization);
    registryCutover = true;
    await setWorkspaceTransferStatus({
      transferId,
      source: { ...request.source },
      destination: { ...request.destination },
      state: "cutover",
      workspaceId: request.source.workspaceId,
      ...(preflight.workspaceName ? { workspaceName: preflight.workspaceName } : {}),
      dataByteSize: transport.dataByteSize,
      entryCount: transport.entryCount,
      capacityUnverified: preflight.capacityUnverified,
      integrityHash: transport.manifest.integrity_hash as string,
      organizationReleased: true,
      sourceArchived: false,
      receipt,
      updatedAt: new Date().toISOString()
    });
    await transferRequest(sourceConnection, sourceKey, {
      method: "POST",
      path: `/api/workspaces/${encodeURIComponent(request.source.workspaceId)}/transfers/${encodeURIComponent(transferId)}/receipt`,
      workspaceScoped: true,
      workspaceId: request.source.workspaceId,
      operationId: workspaceTransferReceiptOperationId(transferId, receipt),
      idempotencyKey: workspaceTransferReceiptOperationId(transferId, receipt),
      body: { target_workspace_id: request.destination.workspaceId, receipt }
    }, "workspace_transfer_receipt_submit_failed");
    await transferRequest(sourceConnection, sourceKey, {
      method: "POST",
      path: `/api/workspaces/${encodeURIComponent(request.source.workspaceId)}/transfers/${encodeURIComponent(transferId)}/complete`,
      workspaceScoped: true,
      workspaceId: request.source.workspaceId,
      operationId: workspaceTransferPhaseOperationId(transferId, "complete"),
      idempotencyKey: workspaceTransferPhaseOperationId(transferId, "complete"),
      body: {}
    }, "workspace_transfer_complete_failed");
    sourceCompleted = true;
    const status: WorkspaceTransferStatus = {
      transferId,
      source: { ...request.source },
      destination: { ...request.destination },
      state: "source_archived",
      workspaceId: request.source.workspaceId,
      ...(preflight.workspaceName ? { workspaceName: preflight.workspaceName } : {}),
      organizationReleased: true,
      sourceArchived: true,
      dataByteSize: transport.dataByteSize,
      entryCount: transport.entryCount,
      capacityUnverified: preflight.capacityUnverified,
      integrityHash: transport.manifest.integrity_hash as string,
      receipt,
      updatedAt: new Date().toISOString()
    };
    await setWorkspaceTransferStatus(status);
    return status;
  } catch (error) {
    if (!registryCutover && !sourceCompleted && !sourceTerminalNoRollback && !importOutcomeUnknown && sourceKey && destinationKey) {
      try {
        await transferRequest(sourceConnection, sourceKey, {
          method: "POST",
          path: `/api/workspaces/${encodeURIComponent(request.source.workspaceId)}/transfers/${encodeURIComponent(transferId)}/rollback`,
          workspaceScoped: true,
          workspaceId: request.source.workspaceId,
          operationId: workspaceTransferPhaseOperationId(transferId, "rollback"),
          idempotencyKey: workspaceTransferPhaseOperationId(transferId, "rollback"),
          body: {}
        }, "workspace_transfer_rollback_failed");
      } catch {
        // Keep the original failure. The source ledger remains recoverable and
        // can be reconciled by a later owner-authorized retry.
      }
    }
    const failureCode = importOutcomeUnknown
      ? "workspace_transfer_import_outcome_unknown"
      : error instanceof Error ? error.message.split(":", 1)[0] : "workspace_transfer_failed";
    await setWorkspaceTransferStatus({
      transferId,
      source: { ...request.source },
      destination: { ...request.destination },
      state: importOutcomeUnknown ? "restoring" : sourceCompleted ? "source_archived" : registryCutover ? "cutover" : "failed",
      workspaceId: request.source.workspaceId,
      ...(preflight.workspaceName ? { workspaceName: preflight.workspaceName } : {}),
      ...(transport ? {
        dataByteSize: transport.dataByteSize,
        entryCount: transport.entryCount,
        capacityUnverified: preflight.capacityUnverified,
        integrityHash: typeof transport.manifest.integrity_hash === "string" ? transport.manifest.integrity_hash : undefined
      } : {}),
      ...(receipt ? { receipt } : {}),
      ...(registryCutover ? { organizationReleased: true } : {}),
      sourceArchived: sourceCompleted || sourceTerminalNoRollback,
      ...(targetRestored ? { targetRestored: true, targetCleanupRequired: !registryCutover } : {}),
      ...(importOutcomeUnknown ? { targetCleanupRequired: true } : {}),
      failureCode,
      message: sourceTerminalNoRollback
        ? "Workspace transfer is already committed and the source is archived; destination authorization or local cutover still needs attention."
        : importOutcomeUnknown
        ? "The destination import outcome is unknown; the source was retained. Retry the same transfer to resend or verify the destination import."
        : sourceCompleted
        ? "Workspace transfer completed on the source; the local checkpoint still needs to be persisted."
        : registryCutover
          ? "Workspace transfer cutover is complete; the destination was retained and the source remains read-only until completion succeeds."
          : targetRestored
            ? "Workspace transfer failed; the source was retained and the restored destination requires retry or cleanup."
            : "Workspace transfer failed; the source Workspace was retained.",
      updatedAt: new Date().toISOString()
    });
    throw error;
  }
}

function workspaceTransferStatusInput(value: unknown): WorkspaceTransferRequest {
  const request = workspaceTransferInput(value);
  if (!request.transferId) throw new Error("workspace_transfer_id_required");
  return request;
}

function workspaceTransferStatus(request: WorkspaceTransferRequest): WorkspaceTransferStatus {
  const current = workspaceTransferStatusById.get(request.transferId!);
  if (!current || current.source.connectionId !== request.source.connectionId || current.source.workspaceId !== request.source.workspaceId
    || current.destination.connectionId !== request.destination.connectionId || current.destination.workspaceId !== request.destination.workspaceId) {
    throw new Error("workspace_transfer_status_not_found");
  }
  return publicWorkspaceTransferStatus(current);
}

type PublicWorkspaceTransferStatus = Omit<WorkspaceTransferStatus, "receipt">;

function publicWorkspaceTransferStatus(status: WorkspaceTransferStatus): PublicWorkspaceTransferStatus {
  const { receipt: _receipt, ...publicStatus } = status;
  return {
    ...publicStatus,
    source: { ...status.source },
    destination: { ...status.destination }
  };
}

function listWorkspaceTransfers(): PublicWorkspaceTransferStatus[] {
  return [...workspaceTransferStatusById.values()]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .map((status) => publicWorkspaceTransferStatus(status));
}

function applyWorkspaceTarget(target: WorkspaceTargetRef | undefined): void {
  const connection = target
    ? workspaceConnectionRegistry.connections.find((candidate) => candidate.id === target.connectionId)
    : activeWorkspaceConnection(workspaceConnectionRegistry);
  const workspaceTarget = connection && target
    ? connection.targets.find((candidate) => candidate.connectionId === connection.id && candidate.workspaceId === target.workspaceId)
    : undefined;
  if (!connection) {
    activeWorkspaceTargetRef = undefined;
    activeOrganizationId = undefined;
    activeWorkspaceId = undefined;
    activeRoomId = undefined;
    config.workspaceServerUrl = undefined;
    config.workspaceId = undefined;
    config.accountId = undefined;
    return;
  }
  activeWorkspaceTargetRef = workspaceTarget ? { connectionId: connection.id, workspaceId: workspaceTarget.workspaceId } : undefined;
  // Workspace Server is a separate boundary from the legacy Chat/Core API.
  // Selecting it must never silently redirect the Chat UI to an incompatible
  // endpoint; Server 02-specific clients consume these explicit values.
  config.workspaceServerUrl = connection.serverUrl;
  activeOrganizationId = workspaceTarget?.lastOrganizationId;
  activeWorkspaceId = workspaceTarget?.workspaceId;
  activeRoomId = workspaceTarget?.lastRoomId;
  config.workspaceId = activeWorkspaceId;
  config.accountId = connection.accountId;
}

function sameWorkspaceTarget(left: WorkspaceTargetRef | undefined, right: WorkspaceTargetRef | undefined): boolean {
  return Boolean(left && right && left.connectionId === right.connectionId && left.workspaceId === right.workspaceId);
}

function targetRef(target: WorkspaceTarget): WorkspaceTargetRef {
  return { connectionId: target.connectionId, workspaceId: target.workspaceId };
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
  /** The v1 Artifact content route is authenticated JSON metadata plus raw bytes. */
  responseType?: "json" | "bytes";
  /** Explicit scope supplied by an adapter when the request body is opaque. */
  requestRoomId?: string;
}

const workspaceRequestOpaqueIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

type WorkspaceServerResponse = {
  status: number;
  body: unknown;
  headers: DesktopArtifactRawContent["headers"];
};

type WorkspaceRealtimeNotice = {
  type: "event" | "access_changed" | "access_revoked" | "room_access_changed" | "room_access_revoked";
  workspaceId: string;
  connectionId?: string;
  roomId?: string;
  kind?: string;
  eventId?: string;
  eventVersion?: string;
  cursor?: string;
  operationId?: string;
  correlationId?: string;
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
  const active = workspaceConnectionRegistry.activeTarget;
  if (active?.connectionId !== connection.id) return undefined;
  return active.workspaceId;
}

function requireActiveWorkspaceId(): string {
  const connection = requireActiveWorkspaceConnection();
  const workspaceId = workspaceIdForConnection(connection);
  if (!workspaceId) throw new Error("workspace_selection_required");
  return workspaceId;
}

type ActiveWorkspaceSnapshot = WorkspaceNavigationSnapshot;
type OrganizationConnectionSnapshot = { connectionId: string };

function captureActiveWorkspaceSnapshot(): ActiveWorkspaceSnapshot {
  const connection = requireActiveWorkspaceConnection();
  const workspaceId = workspaceIdForConnection(connection);
  if (!workspaceId) throw new Error("workspace_selection_required");
  return {
    connectionId: connection.id,
    workspaceId,
    workspaceTargetGeneration,
    selectionGeneration: workspaceSelectionGeneration,
    ...(activeRoomId ? { roomId: activeRoomId } : {})
  };
}

/**
 * Fix the renderer's target at IPC receipt.  The optional form keeps older
 * callers working, while a supplied target is never reinterpreted as the
 * active target: it must match the target that can be signed now.
 */
function captureWorkspaceTargetSnapshot(target?: { connectionId: string; workspaceId: string; roomId?: string; selectionGeneration?: number }): ActiveWorkspaceSnapshot {
  const snapshot = captureActiveWorkspaceSnapshot();
  if (target && (target.connectionId !== snapshot.connectionId || target.workspaceId !== snapshot.workspaceId)) {
    throw new Error("workspace_navigation_changed");
  }
  if (target?.selectionGeneration !== undefined && target.selectionGeneration !== snapshot.selectionGeneration) {
    throw new Error("workspace_navigation_changed");
  }
  if (target?.roomId !== undefined && target.roomId !== snapshot.roomId) {
    throw new Error("room_navigation_changed");
  }
  return target?.roomId === undefined ? { ...snapshot, roomId: undefined } : snapshot;
}

/** Organization requests are account-scoped, so a connection-only snapshot
 * is the correct boundary even when no Workspace is currently selected. */
function captureOrganizationConnectionSnapshot(target?: { connectionId: string; workspaceId: string }): OrganizationConnectionSnapshot {
  const connection = requireActiveWorkspaceConnection();
  if (target && target.connectionId !== connection.id) throw new Error("workspace_navigation_changed");
  return { connectionId: connection.id };
}

function assertOrganizationConnectionSnapshot(snapshot: OrganizationConnectionSnapshot): void {
  const connection = activeWorkspaceConnection(workspaceConnectionRegistry);
  if (!connection || connection.id !== snapshot.connectionId) throw new Error("workspace_navigation_changed");
}

function workspaceTargetFromInput(input: unknown): ReturnType<typeof workspaceTargetRequest> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  return workspaceTargetRequest((input as Record<string, unknown>).target);
}

/**
 * A Room-scoped request must agree with the active Room before it is signed.
 * This protects compatibility callers that carry a Room only in the Domain
 * context or URL instead of sending a complete target snapshot.
 */
function assertWorkspaceServerRequestRoom(
  snapshot: ActiveWorkspaceSnapshot | undefined,
  input: Pick<WorkspaceServerRequestInput, "path" | "body" | "requestRoomId">
): void {
  const requestRoomIds = workspaceServerRequestRoomIds(input);
  if (requestRoomIds.length > 1) throw new Error("workspace_request_room_ambiguous");
  const requestRoomId = requestRoomIds[0];
  if (!requestRoomId) return;
  if (activeRoomId !== undefined && activeRoomId !== requestRoomId) throw new Error("room_navigation_changed");
  if (snapshot?.roomId !== undefined && snapshot.roomId !== requestRoomId) throw new Error("room_navigation_changed");
}

function workspaceServerRequestRoomIds(input: Pick<WorkspaceServerRequestInput, "path" | "body" | "requestRoomId">): string[] {
  const roomIds = new Set<string>();
  const add = (value: unknown): void => {
    if (value === undefined || value === null || value === "") return;
    if (typeof value !== "string" || !workspaceRequestOpaqueIdPattern.test(value)) throw new Error("workspace_request_room_invalid");
    roomIds.add(value);
  };
  add(input.requestRoomId);

  const url = new URL(input.path, "https://workspace.invalid");
  add(url.searchParams.get("room_id"));
  const roomPath = /\/rooms\/([^/]+)/.exec(url.pathname)?.[1];
  if (roomPath) {
    try {
      add(decodeURIComponent(roomPath));
    } catch {
      throw new Error("workspace_request_path_invalid");
    }
  }
  collectWorkspaceServerRequestRoomIds(input.body, roomIds, add, 0, new WeakSet<object>());
  return [...roomIds];
}

function collectWorkspaceServerRequestRoomIds(
  value: unknown,
  roomIds: Set<string>,
  add: (value: unknown) => void,
  depth: number,
  seen: WeakSet<object>
): void {
  if (!value || typeof value !== "object" || depth > 3 || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) collectWorkspaceServerRequestRoomIds(item, roomIds, add, depth + 1, seen);
    return;
  }
  const record = value as Record<string, unknown>;
  add(record.room_id);
  add(record.roomId);
  for (const key of ["context", "input", "request", "body"] as const) {
    collectWorkspaceServerRequestRoomIds(record[key], roomIds, add, depth + 1, seen);
  }
}

function assertActiveWorkspaceSnapshot(snapshot: ActiveWorkspaceSnapshot): void {
  const connection = activeWorkspaceConnection(workspaceConnectionRegistry);
  const workspaceId = connection ? workspaceIdForConnection(connection) : undefined;
  if (!workspaceNavigationSnapshotIsCurrent(snapshot, {
    connectionId: connection?.id,
    workspaceId,
    workspaceTargetGeneration,
    selectionGeneration: workspaceSelectionGeneration,
    ...(activeRoomId ? { roomId: activeRoomId } : {})
  })) {
    throw new Error("workspace_navigation_changed");
  }
}

type DesktopInteractionRequestListIpcInput = {
  roomId: string;
  includeResolved: boolean;
  target?: { connectionId: string; workspaceId: string; roomId?: string; selectionGeneration?: number };
};

type DesktopInteractionRequestMutationIpcInput = {
  roomId: string;
  requestId: string;
  expectedVersion: number;
  operationId: string;
  optionId?: string;
  values?: Record<string, unknown>;
  target?: { connectionId: string; workspaceId: string; roomId?: string; selectionGeneration?: number };
};

type DesktopInteractionRequestResultIpcInput = {
  roomId: string;
  requestId: string;
  operationId: string;
  target?: { connectionId: string; workspaceId: string; roomId?: string; selectionGeneration?: number };
};

function workspaceInteractionRequestListIpcInput(input: unknown): DesktopInteractionRequestListIpcInput {
  const value = desktopInputRecord(input, "workspace_interaction_request_input_invalid");
  const roomId = requiredWorkspaceOpaqueField(value, "roomId");
  const target = workspaceTargetFromInput(value);
  if (value.includeResolved !== undefined && typeof value.includeResolved !== "boolean") {
    throw new Error("workspace_interaction_request_includeResolved_invalid");
  }
  return { roomId, includeResolved: value.includeResolved === true, ...(target ? { target } : {}) };
}

function workspaceInteractionRequestResultIpcInput(input: unknown): DesktopInteractionRequestResultIpcInput {
  const value = desktopInputRecord(input, "workspace_interaction_request_input_invalid");
  const roomId = requiredWorkspaceOpaqueField(value, "roomId");
  const requestId = requiredWorkspaceOpaqueField(value, "requestId");
  const operationId = requiredWorkspaceOpaqueField(value, "operationId");
  const target = workspaceTargetFromInput(value);
  return { roomId, requestId, operationId, ...(target ? { target } : {}) };
}

function workspaceInteractionRequestRespondIpcInput(input: unknown): DesktopInteractionRequestMutationIpcInput {
  const value = desktopInputRecord(input, "workspace_interaction_request_input_invalid");
  const roomId = requiredWorkspaceOpaqueField(value, "roomId");
  const requestId = requiredWorkspaceOpaqueField(value, "requestId");
  const optionId = requiredWorkspaceOpaqueField(value, "optionId");
  const operationId = requiredWorkspaceOpaqueField(value, "operationId");
  const expectedVersion = requiredInteractionRequestVersion(value.expectedVersion);
  const target = workspaceTargetFromInput(value);
  return {
    roomId,
    requestId,
    optionId,
    operationId,
    expectedVersion,
    ...(target ? { target } : {}),
    ...(value.values === undefined ? {} : { values: strictInteractionRequestJsonObject(value.values, "values") })
  };
}

function workspaceInteractionRequestCancelIpcInput(input: unknown): DesktopInteractionRequestMutationIpcInput {
  const value = desktopInputRecord(input, "workspace_interaction_request_input_invalid");
  const roomId = requiredWorkspaceOpaqueField(value, "roomId");
  const requestId = requiredWorkspaceOpaqueField(value, "requestId");
  const operationId = requiredWorkspaceOpaqueField(value, "operationId");
  const target = workspaceTargetFromInput(value);
  return { roomId, requestId, operationId, expectedVersion: requiredInteractionRequestVersion(value.expectedVersion), ...(target ? { target } : {}) };
}

function requiredInteractionRequestVersion(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error("workspace_interaction_request_expected_version_invalid");
  }
  return value;
}

/** Main-process transport for the three fixed interaction-request routes. */
async function snapshotWorkspaceServerRequest(
  snapshot: ActiveWorkspaceSnapshot,
  input: WorkspaceServerRequestInput
): Promise<unknown | DesktopArtifactRawContent> {
  assertActiveWorkspaceSnapshot(snapshot);
  assertWorkspaceServerRequestRoom(snapshot, input);
  const connection = workspaceConnectionRegistry.connections.find((candidate) => candidate.id === snapshot.connectionId);
  if (!connection || workspaceIdForConnection(connection) !== snapshot.workspaceId) throw new Error("workspace_navigation_changed");
  const privateKey = await requireActiveWorkspacePrivateKey(connection);
  assertActiveWorkspaceSnapshot(snapshot);
  assertWorkspaceServerRequestRoom(snapshot, input);
  const result = await signedWorkspaceServerRequest(connection, privateKey, {
    ...input,
    workspaceScoped: true,
    workspaceId: snapshot.workspaceId
  });
  assertActiveWorkspaceSnapshot(snapshot);
  assertWorkspaceServerRequestRoom(snapshot, input);
  assertWorkspaceServerSuccess(result, "workspace_server_request_failed");
  if (input.responseType === "bytes") {
    const bytes = desktopArtifactContentBytes(result.body);
    if (bytes.length > DESKTOP_ARTIFACT_MAX_CONTENT_BYTES) throw new Error("workspace_artifact_content_too_large");
    return { bytes, headers: result.headers };
  }
  return result.body;
}

function sanitizeDesktopInteractionListResponse(
  value: unknown,
  workspaceId: string,
  roomId: string
): { requests: Array<Record<string, unknown>> } {
  const rows = Array.isArray(value)
    ? value
    : (() => {
      const body = desktopInteractionRecord(value, "workspace_interaction_request_list_response_invalid");
      if (!Array.isArray(body.requests)) throw new Error("workspace_interaction_request_list_response_invalid");
      return body.requests;
    })();
  return { requests: rows.map((row) => sanitizeDesktopInteractionRequest(row, workspaceId, roomId)) };
}

function sanitizeDesktopInteractionMutationResponse(
  value: unknown,
  workspaceId: string,
  roomId: string,
  requestId: string
): { request: Record<string, unknown>; replayed?: boolean } {
  const body = desktopInteractionRecord(value, "workspace_interaction_request_mutation_response_invalid");
  const request = sanitizeDesktopInteractionRequest(body.request, workspaceId, roomId);
  if (request.id !== requestId) throw new Error("workspace_interaction_request_response_scope_invalid");
  if (body.replayed !== undefined && typeof body.replayed !== "boolean") throw new Error("workspace_interaction_request_mutation_response_invalid");
  return { request, ...(body.replayed === undefined ? {} : { replayed: body.replayed }) };
}

function sanitizeDesktopInteractionResultResponse(
  value: unknown,
  workspaceId: string,
  roomId: string,
  requestId: string
): { request: Record<string, unknown>; targetResult?: unknown } {
  const body = desktopInteractionRecord(value, "workspace_interaction_request_result_response_invalid");
  const request = sanitizeDesktopInteractionRequest(body.request, workspaceId, roomId);
  if (request.id !== requestId) throw new Error("workspace_interaction_request_result_scope_invalid");
  const targetResult = body.target_result === undefined
    ? undefined
    : strictInteractionRequestJsonValue(body.target_result, "target_result");
  return { request, ...(targetResult === undefined ? {} : { targetResult }) };
}

function sanitizeDesktopOperationHistoryResponse(
  value: unknown,
  workspaceId: string,
  roomId: string,
  recordType: string
): { records: Array<Record<string, unknown>> } {
  const body = desktopInputRecord(value, "workspace_operation_history_response_invalid");
  if (!Array.isArray(body.records) || body.records.length > 500) {
    throw new Error("workspace_operation_history_response_invalid");
  }
  return {
    records: body.records.map((entry, index) => {
      const record = desktopInputRecord(entry, `workspace_operation_history_record_${index}`);
      const actualWorkspaceId = requiredDesktopInteractionId(record.workspaceId, "workspaceId");
      const actualRoomId = requiredDesktopInteractionId(record.roomId, "roomId");
      if (actualWorkspaceId !== workspaceId || actualRoomId !== roomId || record.recordType !== recordType) {
        throw new Error("workspace_operation_history_response_scope_invalid");
      }
      const id = requiredDesktopInteractionId(record.id, "id");
      const version = record.version;
      if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1) {
        throw new Error("workspace_operation_history_response_invalid");
      }
      const payload = strictInteractionRequestJsonObject(record.payload, "payload");
      return {
        workspaceId: actualWorkspaceId,
        roomId: actualRoomId,
        recordType,
        id,
        version,
        payload,
        ...(typeof record.contentHash === "string" ? { contentHash: record.contentHash.slice(0, 128) } : {}),
        ...(typeof record.createdAt === "string" ? { createdAt: record.createdAt.slice(0, 128) } : {}),
        ...(typeof record.updatedAt === "string" ? { updatedAt: record.updatedAt.slice(0, 128) } : {})
      };
    })
  };
}

function sanitizeDesktopInteractionRequest(value: unknown, workspaceId: string, roomId: string): Record<string, unknown> {
  const record = desktopInteractionRecord(value, "workspace_interaction_request_response_invalid");
  const actualWorkspaceId = requiredDesktopInteractionId(desktopInteractionField(record, "workspaceId", "workspace_id"), "workspaceId");
  const actualRoomId = requiredDesktopInteractionId(desktopInteractionField(record, "roomId", "room_id"), "roomId");
  if (actualWorkspaceId !== workspaceId || actualRoomId !== roomId) throw new Error("workspace_interaction_request_response_scope_invalid");

  const kind = desktopInteractionEnum(desktopInteractionField(record, "kind"), ["approval", "backend_input"] as const, "kind");
  const status = desktopInteractionEnum(desktopInteractionField(record, "status"), desktopInteractionRequestStatuses, "status");
  const rawOptions = desktopInteractionField(record, "options");
  if (!Array.isArray(rawOptions) || rawOptions.length === 0 || rawOptions.length > 128) throw new Error("workspace_interaction_request_options_invalid");
  const options = rawOptions.map((value, index) => {
    const option = desktopInteractionRecord(value, `workspace_interaction_request_option_${index}`);
    const description = optionalDesktopInteractionText(desktopInteractionField(option, "description"), "option_description", 20_000);
    return {
      id: requiredDesktopInteractionId(desktopInteractionField(option, "id"), `option_${index}_id`),
      label: requiredDesktopInteractionText(desktopInteractionField(option, "label"), `option_${index}_label`, 2_000),
      decision: desktopInteractionEnum(desktopInteractionField(option, "decision"), desktopInteractionDecisions, `option_${index}_decision`),
      ...(description === undefined ? {} : { description })
    };
  });
  if (new Set(options.map((option) => option.id)).size !== options.length) throw new Error("workspace_interaction_request_options_invalid");

  const inputSchemaValue = desktopInteractionField(record, "inputSchema", "input_schema");
  const inputSchema = inputSchemaValue === undefined || inputSchemaValue === null
    ? undefined
    : sanitizeDesktopInteractionInputSchema(inputSchemaValue);
  const outcomeValue = desktopInteractionField(record, "outcome");
  const executionValue = desktopInteractionField(record, "execution");
  const outcome = outcomeValue === undefined || outcomeValue === null ? undefined : sanitizeDesktopInteractionOutcome(outcomeValue);
  const execution = executionValue === undefined || executionValue === null ? undefined : sanitizeDesktopInteractionExecution(executionValue);
  const actionId = optionalDesktopInteractionId(desktopInteractionField(record, "actionId", "action_id"), "actionId");
  const targetLabel = optionalDesktopInteractionText(desktopInteractionField(record, "targetLabel", "target_label"), "targetLabel", 2_000);
  const executionSummary = execution?.summary;
  return {
    id: requiredDesktopInteractionId(desktopInteractionField(record, "id"), "id"),
    workspaceId: actualWorkspaceId,
    roomId: actualRoomId,
    version: requiredInteractionRequestVersion(desktopInteractionField(record, "version")),
    kind,
    status,
    title: requiredDesktopInteractionText(desktopInteractionField(record, "title"), "title", 20_000),
    summary: requiredDesktopInteractionText(desktopInteractionField(record, "summary"), "summary", 20_000),
    ...(optionalDesktopInteractionId(desktopInteractionField(record, "runId", "run_id"), "runId") ? { runId: optionalDesktopInteractionId(desktopInteractionField(record, "runId", "run_id"), "runId") } : {}),
    ...(optionalDesktopInteractionId(desktopInteractionField(record, "surfaceId", "surface_id"), "surfaceId") ? { surfaceId: optionalDesktopInteractionId(desktopInteractionField(record, "surfaceId", "surface_id"), "surfaceId") } : {}),
    ...(optionalDesktopInteractionId(desktopInteractionField(record, "revisionId", "revision_id"), "revisionId") ? { revisionId: optionalDesktopInteractionId(desktopInteractionField(record, "revisionId", "revision_id"), "revisionId") } : {}),
    actionTarget: sanitizeDesktopInteractionActionTarget(desktopInteractionField(record, "actionTarget", "action_target")),
    options,
    ...(inputSchema === undefined ? {} : { inputSchema }),
    expiresAt: requiredDesktopInteractionText(desktopInteractionField(record, "expiresAt", "expires_at"), "expiresAt", 128),
    ...(outcome === undefined ? {} : { outcome }),
    ...(execution === undefined ? {} : { execution }),
    createdAt: requiredDesktopInteractionText(desktopInteractionField(record, "createdAt", "created_at"), "createdAt", 128),
    updatedAt: requiredDesktopInteractionText(desktopInteractionField(record, "updatedAt", "updated_at"), "updatedAt", 128),
    ...(actionId === undefined ? {} : { actionId }),
    ...(targetLabel === undefined ? {} : { targetLabel }),
    ...(execution?.status === "failed" && executionSummary ? { failureSummary: executionSummary } : {}),
    ...(execution?.status !== "failed" && executionSummary ? { resultSummary: executionSummary } : {}),
    ...(execution?.errorCode ? { errorCode: execution.errorCode } : {})
  };
}

function sanitizeDesktopInteractionActionTarget(value: unknown): Record<string, unknown> {
  const target = strictInteractionRequestJsonObject(value, "actionTarget", 64 * 1024);
  for (const key of ["input", "input_values", "execution_input", "result", "values"]) delete target[key];
  return target;
}

function sanitizeDesktopInteractionInputSchema(value: unknown): Record<string, unknown> {
  const source = strictInteractionRequestJsonObject(value, "inputSchema", 64 * 1024);
  if (source.type !== undefined && source.type !== "object") throw new Error("workspace_interaction_request_input_schema_invalid");
  const properties: Record<string, unknown> = {};
  if (source.properties !== undefined) {
    if (!source.properties || typeof source.properties !== "object" || Array.isArray(source.properties)) throw new Error("workspace_interaction_request_input_schema_invalid");
    for (const [id, rawProperty] of Object.entries(source.properties as Record<string, unknown>)) {
      if (!id.trim() || id.length > 256) throw new Error("workspace_interaction_request_input_schema_invalid");
      const property = strictInteractionRequestJsonObject(rawProperty, "inputSchema", 8 * 1024);
      const type = property.type;
      if (type !== undefined && type !== "string" && type !== "number" && type !== "integer" && type !== "boolean") throw new Error("workspace_interaction_request_input_schema_invalid");
      const enumValue = property.enum;
      if (enumValue !== undefined && (!Array.isArray(enumValue) || enumValue.length > 128 || enumValue.some((item) => (typeof item !== "string" && typeof item !== "number" && typeof item !== "boolean") || (typeof item === "number" && !Number.isFinite(item))))) {
        throw new Error("workspace_interaction_request_input_schema_invalid");
      }
      const minLength = optionalInteractionSchemaInteger(property.minLength);
      const maxLength = optionalInteractionSchemaInteger(property.maxLength);
      if (minLength !== undefined && maxLength !== undefined && minLength > maxLength) throw new Error("workspace_interaction_request_input_schema_invalid");
      const title = optionalDesktopInteractionText(property.title, "inputSchema_title", 2_000);
      const description = optionalDesktopInteractionText(property.description, "inputSchema_description", 20_000);
      properties[id] = {
        ...(type === undefined ? {} : { type }),
        ...(title === undefined ? {} : { title }),
        ...(description === undefined ? {} : { description }),
        ...(enumValue === undefined ? {} : { enum: enumValue }),
        ...(minLength === undefined ? {} : { minLength }),
        ...(maxLength === undefined ? {} : { maxLength })
      };
    }
  }
  const required = source.required;
  if (required !== undefined && (!Array.isArray(required) || required.length > 256 || required.some((item) => typeof item !== "string" || !item.trim() || !Object.prototype.hasOwnProperty.call(properties, item)))) {
    throw new Error("workspace_interaction_request_input_schema_invalid");
  }
  if (source.additionalProperties !== undefined && typeof source.additionalProperties !== "boolean") throw new Error("workspace_interaction_request_input_schema_invalid");
  return {
    ...(source.type === undefined ? {} : { type: "object" }),
    ...(Object.keys(properties).length ? { properties } : {}),
    ...(required === undefined ? {} : { required }),
    ...(source.additionalProperties === undefined ? {} : { additionalProperties: source.additionalProperties })
  };
}

function optionalInteractionSchemaInteger(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 1_000_000) throw new Error("workspace_interaction_request_input_schema_invalid");
  return value;
}

function sanitizeDesktopInteractionOutcome(value: unknown): Record<string, unknown> {
  const record = desktopInteractionRecord(value, "workspace_interaction_request_outcome_invalid");
  const kind = desktopInteractionEnum(desktopInteractionField(record, "kind"), ["response", "cancelled", "expired"] as const, "outcome_kind");
  if (kind === "response") {
    return {
      kind,
      optionId: requiredDesktopInteractionId(desktopInteractionField(record, "optionId", "option_id"), "outcome_option_id"),
      decision: desktopInteractionEnum(desktopInteractionField(record, "decision"), desktopInteractionDecisions, "outcome_decision"),
      decidedAt: requiredDesktopInteractionText(desktopInteractionField(record, "decidedAt", "decided_at"), "outcome_decided_at", 128)
    };
  }
  if (kind === "cancelled") return { kind, decidedAt: requiredDesktopInteractionText(desktopInteractionField(record, "decidedAt", "decided_at"), "outcome_decided_at", 128) };
  return { kind, expiredAt: requiredDesktopInteractionText(desktopInteractionField(record, "expiredAt", "expired_at"), "outcome_expired_at", 128) };
}

function sanitizeDesktopInteractionExecution(value: unknown): Record<string, unknown> {
  const record = desktopInteractionRecord(value, "workspace_interaction_request_execution_invalid");
  const status = desktopInteractionEnum(desktopInteractionField(record, "status"), desktopInteractionExecutionStatuses, "execution_status");
  const summary = optionalDesktopInteractionText(desktopInteractionField(record, "summary"), "execution_summary", 20_000);
  const errorCode = optionalDesktopInteractionText(desktopInteractionField(record, "errorCode", "error_code"), "execution_error_code", 256);
  const finishedAt = optionalDesktopInteractionText(desktopInteractionField(record, "finishedAt", "finished_at"), "execution_finished_at", 128);
  return {
    status,
    startedAt: requiredDesktopInteractionText(desktopInteractionField(record, "startedAt", "started_at"), "execution_started_at", 128),
    ...(finishedAt === undefined ? {} : { finishedAt }),
    ...(summary === undefined ? {} : { summary }),
    ...(errorCode === undefined ? {} : { errorCode })
  };
}

const desktopInteractionRequestStatuses = ["pending", "accepted", "denied", "cancelled", "expired", "executing", "completed", "failed"] as const;
const desktopInteractionExecutionStatuses = ["executing", "completed", "failed"] as const;
const desktopInteractionDecisions = ["approve", "deny", "submit_input"] as const;

function desktopInteractionRecord(value: unknown, errorCode: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(errorCode);
  return value as Record<string, unknown>;
}

function desktopInteractionField(record: Record<string, unknown>, camelKey: string, snakeKey = camelKey.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)): unknown {
  return record[camelKey] === undefined ? record[snakeKey] : record[camelKey];
}

function requiredDesktopInteractionId(value: unknown, field: string): string {
  if (typeof value !== "string" || !isWorkspaceOpaqueId(value)) throw new Error(`workspace_interaction_request_${field}_invalid`);
  return value;
}

function optionalDesktopInteractionId(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requiredDesktopInteractionId(value, field);
}

function requiredDesktopInteractionText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || value.length > maxLength) throw new Error(`workspace_interaction_request_${field}_invalid`);
  return value;
}

function optionalDesktopInteractionText(value: unknown, field: string, maxLength: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requiredDesktopInteractionText(value, field, maxLength);
}

function desktopInteractionEnum<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) throw new Error(`workspace_interaction_request_${field}_invalid`);
  return value as T;
}

function strictInteractionRequestJsonObject(value: unknown, field: string, maxLength = 256 * 1024): Record<string, unknown> {
  if (!isStrictInteractionRequestJsonObject(value, 0)) throw new Error(`workspace_interaction_request_${field}_invalid`);
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new Error(`workspace_interaction_request_${field}_invalid`);
  }
  if (encoded.length > maxLength) throw new Error(`workspace_interaction_request_${field}_invalid`);
  try {
    const parsed: unknown = JSON.parse(encoded);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error(`workspace_interaction_request_${field}_invalid`);
  }
}

function strictInteractionRequestJsonValue(value: unknown, field: string, maxLength = 256 * 1024): unknown {
  if (!isStrictInteractionRequestJsonValue(value, 0, new WeakSet<object>())) throw new Error(`workspace_interaction_request_${field}_invalid`);
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new Error(`workspace_interaction_request_${field}_invalid`);
  }
  if (encoded.length > maxLength) throw new Error(`workspace_interaction_request_${field}_invalid`);
  try {
    return JSON.parse(encoded);
  } catch {
    throw new Error(`workspace_interaction_request_${field}_invalid`);
  }
}

function isStrictInteractionRequestJsonObject(value: unknown, depth: number, seen = new WeakSet<object>()): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value) || depth > 8 || seen.has(value)) return false;
  seen.add(value);
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 2_000) return false;
  return entries.every(([key, item]) => key.length <= 512 && isStrictInteractionRequestJsonValue(item, depth + 1, seen));
}

function isStrictInteractionRequestJsonValue(value: unknown, depth: number, seen: WeakSet<object>): boolean {
  if (depth > 8) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) {
    if (seen.has(value) || value.length > 2_000) return false;
    seen.add(value);
    return value.every((item) => isStrictInteractionRequestJsonValue(item, depth + 1, seen));
  }
  return isStrictInteractionRequestJsonObject(value, depth, seen);
}

type DesktopArtifactRevisionIpcInput = {
  roomId: string;
  artifactId: string;
  target?: { connectionId: string; workspaceId: string };
  revisionId?: string;
  baseRevisionId?: string;
  operationId?: string;
  expectedRevision?: number;
  changeSummary?: string;
  content?: string | number[];
  mimeType?: string;
  encoding?: "utf8" | "binary";
};

function workspaceArtifactRevisionIpcInput(
  input: unknown,
  options: { requireRevisionId?: boolean; requireContent?: boolean; requireOperationId?: boolean } = {}
): DesktopArtifactRevisionIpcInput {
  const value = desktopInputRecord(input, "workspace_artifact_request_invalid");
  const roomId = requiredWorkspaceOpaqueField(value, "roomId");
  const artifactId = requiredWorkspaceOpaqueField(value, "artifactId");
  const target = workspaceTargetFromInput(value);
  const revisionId = options.requireRevisionId
    ? requiredWorkspaceOpaqueField(value, "revisionId")
    : typeof value.revisionId === "string" ? requiredWorkspaceOpaqueField(value, "revisionId") : undefined;
  const baseRevisionId = typeof value.baseRevisionId === "string"
    ? requiredWorkspaceOpaqueField(value, "baseRevisionId")
    : undefined;
  const operationId = typeof value.operationId === "string"
    ? requiredWorkspaceOpaqueField(value, "operationId")
    : undefined;
  const expectedRevision = value.expectedRevision;
  if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || (expectedRevision as number) < 1)) {
    throw new Error("expectedRevision_invalid");
  }
  const changeSummary = value.changeSummary === undefined
    ? undefined
    : typeof value.changeSummary === "string" && value.changeSummary.trim()
      ? value.changeSummary.trim().slice(0, 20_000)
      : (() => { throw new Error("changeSummary_invalid"); })();
  const content = value.content === undefined ? undefined : desktopArtifactContent(value.content);
  if (options.requireContent && content === undefined) throw new Error("content_required");
  if ((options.requireContent || options.requireOperationId) && !operationId) throw new Error("operationId_invalid");
  const mimeType = value.mimeType === undefined
    ? undefined
    : typeof value.mimeType === "string" && value.mimeType.trim().length > 0 && value.mimeType.length <= 255
      ? value.mimeType.trim()
      : (() => { throw new Error("mimeType_invalid"); })();
  const encoding = value.encoding === undefined
    ? undefined
    : value.encoding === "utf8" || value.encoding === "binary"
      ? value.encoding
      : (() => { throw new Error("encoding_invalid"); })();
  return {
    roomId,
    artifactId,
    ...(target ? { target } : {}),
    ...(revisionId ? { revisionId } : {}),
    ...(baseRevisionId ? { baseRevisionId } : {}),
    ...(operationId ? { operationId } : {}),
    ...(expectedRevision === undefined ? {} : { expectedRevision: expectedRevision as number }),
    ...(changeSummary ? { changeSummary } : {}),
    ...(content === undefined ? {} : { content }),
    ...(mimeType ? { mimeType } : {}),
    ...(encoding ? { encoding } : {})
  };
}

function desktopArtifactContent(value: unknown): string | number[] {
  if (typeof value === "string") return value;
  if (isDesktopByteArray(value)) {
    return value as number[];
  }
  throw new Error("content_invalid");
}

function isDesktopByteArray(value: unknown): value is number[] {
  if (!Array.isArray(value) || value.length > 50_000_000) return false;
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (typeof item !== "number" || !Number.isInteger(item) || item < 0 || item > 255) return false;
  }
  return true;
}

function desktopArtifactContentBytes(value: unknown): number[] {
  if (!isDesktopByteArray(value)) throw new Error("workspace_artifact_content_response_invalid");
  return value;
}

function desktopArtifactContentMetadata(input: unknown): { mimeType?: string; encoding?: "utf8" | "binary" } {
  const value = desktopInputRecord(input, "workspace_artifact_request_invalid");
  const mimeType = value.mimeType === undefined
    ? undefined
    : typeof value.mimeType === "string" && value.mimeType.trim().length > 0 && value.mimeType.length <= 255
      ? value.mimeType.trim()
      : (() => { throw new Error("mimeType_invalid"); })();
  const encoding = value.encoding === undefined
    ? undefined
    : value.encoding === "utf8" || value.encoding === "binary"
      ? value.encoding
      : (() => { throw new Error("encoding_invalid"); })();
  return { ...(mimeType ? { mimeType } : {}), ...(encoding ? { encoding } : {}) };
}

function assertDesktopArtifactMutationScope(value: unknown, artifactId: string): void {
  const record = desktopInputRecord(value, "workspace_artifact_response_invalid");
  const artifact = record.artifact;
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact) || (artifact as { id?: unknown }).id !== artifactId) {
    throw new Error("workspace_artifact_response_scope_invalid");
  }
  if (record.revision !== undefined) {
    const revision = record.revision;
    if (!revision || typeof revision !== "object" || Array.isArray(revision) || (revision as { artifact_id?: unknown }).artifact_id !== artifactId) {
      throw new Error("workspace_artifact_revision_response_scope_invalid");
    }
  }
}

type DesktopGeneratedSurfaceMutationIpcInput = {
  roomId: string;
  surfaceId?: string;
  operationId: string;
  target?: { connectionId: string; workspaceId: string };
  bundle: Record<string, unknown>;
  request: Record<string, unknown>;
};

function workspaceGeneratedSurfaceMutationIpcInput(
  input: unknown,
  options: { requireSurfaceId?: boolean } = {}
): DesktopGeneratedSurfaceMutationIpcInput {
  const value = desktopInputRecord(input, "workspace_generated_surface_request_invalid");
  const roomId = requiredWorkspaceOpaqueField(value, "roomId");
  const operationId = requiredWorkspaceOpaqueField(value, "operationId");
  const target = workspaceTargetFromInput(value);
  const surfaceId = options.requireSurfaceId
    ? requiredWorkspaceOpaqueField(value, "surfaceId")
    : typeof value.surfaceId === "string" ? requiredWorkspaceOpaqueField(value, "surfaceId") : undefined;
  return {
    roomId,
    ...(surfaceId ? { surfaceId } : {}),
    operationId,
    ...(target ? { target } : {}),
    bundle: desktopJsonRecord(value.bundle, "bundle_invalid"),
    request: desktopJsonRecord(value.request, "request_invalid")
  };
}

function desktopInputRecord(input: unknown, errorCode: string): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error(errorCode);
  return input as Record<string, unknown>;
}

/** Re-encode renderer input at the Main-process JSON boundary. */
function desktopJsonRecord(value: unknown, errorCode: string): Record<string, unknown> {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error(errorCode);
  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded);
  } catch {
    throw new Error(errorCode);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(errorCode);
  return parsed as Record<string, unknown>;
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
): Promise<WorkspaceServerResponse> {
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
  const headers: DesktopArtifactRawContent["headers"] = {
    contentType: response.headers.get("content-type") ?? undefined,
    contentLength: response.headers.get("content-length") ?? undefined,
    contentEncoding: response.headers.get("x-content-encoding") ?? undefined
  };
  if (input.responseType === "bytes" && response.ok) {
    return { status: response.status, body: await readBoundedWorkspaceArtifactBytes(response), headers };
  }
  const text = await response.text();
  let responseBody: unknown = undefined;
  if (text) {
    try { responseBody = JSON.parse(text); } catch { responseBody = { error: "workspace_server_response_invalid" }; }
  }
  return { status: response.status, body: responseBody, headers };
}

async function readBoundedWorkspaceArtifactBytes(response: Response): Promise<number[]> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && (!/^(?:0|[1-9][0-9]*)$/.test(contentLength) || Number(contentLength) > DESKTOP_ARTIFACT_MAX_CONTENT_BYTES)) {
    throw new Error("workspace_artifact_content_too_large");
  }

  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > DESKTOP_ARTIFACT_MAX_CONTENT_BYTES) throw new Error("workspace_artifact_content_too_large");
    return Array.from(bytes);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      if (!(next.value instanceof Uint8Array)) throw new Error("workspace_artifact_content_transport_invalid");
      total += next.value.byteLength;
      if (total > DESKTOP_ARTIFACT_MAX_CONTENT_BYTES) {
        await reader.cancel();
        throw new Error("workspace_artifact_content_too_large");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }

  if (contentLength !== null && Number(contentLength) !== total) throw new Error("workspace_artifact_content_size_mismatch");
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return Array.from(bytes);
}

async function activeWorkspaceServerRequest(input: WorkspaceServerRequestInput): Promise<unknown> {
  const connection = requireActiveWorkspaceConnection();
  assertWorkspaceServerRequestRoom(undefined, input);
  const privateKey = await requireActiveWorkspacePrivateKey(connection);
  assertWorkspaceServerRequestRoom(undefined, input);
  const result = await signedWorkspaceServerRequest(connection, privateKey, input);
  assertWorkspaceServerRequestRoom(undefined, input);
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
  // Keep the legacy helper name for API compatibility, but bind the account
  // request to the connection observed at IPC receipt. Organization routes
  // are account-scoped, so the Workspace half of the target is not used for
  // the HTTP header.
  const snapshot = captureOrganizationConnectionSnapshot(input.target);
  const connection = workspaceConnectionRegistry.connections.find((candidate) => candidate.id === snapshot.connectionId);
  if (!connection) throw new Error("workspace_connection_not_selected");
  assertOrganizationConnectionSnapshot(snapshot);
  const privateKey = await requireActiveWorkspacePrivateKey(connection);
  assertOrganizationConnectionSnapshot(snapshot);
  const result = await signedWorkspaceServerRequest(connection, privateKey, {
    method: input.method,
    path: input.path,
    workspaceScoped: false,
    ...(input.body === undefined ? {} : { body: input.body }),
    ...(input.operationId ? { operationId: input.operationId } : {}),
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {})
  });
  assertOrganizationConnectionSnapshot(snapshot);
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

function summaryString(body: unknown, key: string): string | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const record = body as Record<string, unknown>;
  const direct = record[key];
  if (typeof direct === "string" && direct.trim() && direct.length <= 20_000) return direct.slice(0, 20_000);
  for (const nestedKey of ["workspace", "result"]) {
    const nested = record[nestedKey];
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      const value = (nested as Record<string, unknown>)[key];
      if (typeof value === "string" && value.trim() && value.length <= 20_000) return value.slice(0, 20_000);
    }
  }
  return undefined;
}

function summaryNumber(body: unknown, key: string): number | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
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
  connectionId?: string;
  organizationId?: string;
  workspaceId: string;
  roomId?: string;
} {
  if (typeof input === "string") return { workspaceId: requiredSelectionId(input, "workspaceId") };
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("workspace_selection_invalid");
  const value = input as Record<string, unknown>;
  const connectionId = value.connectionId === undefined || value.connectionId === null || value.connectionId === ""
    ? undefined
    : requiredSelectionId(value, "connectionId");
  const workspaceId = requiredSelectionId(value, "workspaceId");
  const organizationId = value.organizationId === undefined || value.organizationId === null || value.organizationId === ""
    ? undefined
    : requiredSelectionId(value, "organizationId");
  const roomId = value.roomId === undefined || value.roomId === null || value.roomId === ""
    ? undefined
    : requiredSelectionId(value, "roomId");
  return { workspaceId, ...(connectionId ? { connectionId } : {}), ...(organizationId ? { organizationId } : {}), ...(roomId ? { roomId } : {}) };
}

function selectionTargetRef(selection: { connectionId?: string; workspaceId: string }): WorkspaceTargetRef {
  const connectionId = selection.connectionId ?? workspaceConnectionRegistry.activeConnectionId;
  if (!connectionId) throw new Error("workspace_target_connection_required");
  return { connectionId, workspaceId: selection.workspaceId };
}

/**
 * Re-authorize a target before changing active connection, navigation, or
 * realtime state. A failed target leaves the current target untouched.
 */
async function activateAuthorizedWorkspaceTarget(
  target: WorkspaceTargetRef,
  selection: { organizationId?: string; workspaceId?: string; roomId?: string } = {}
): Promise<void> {
  const activationGeneration = ++workspaceActivationGeneration;
  const targetChanged = !sameWorkspaceTarget(workspaceConnectionRegistry.activeTarget, target);
  if (targetChanged) workspaceTargetGeneration += 1;
  workspaceSelectionGeneration += 1;
  const connection = workspaceConnectionRegistry.connections.find((candidate) => candidate.id === target.connectionId);
  if (!connection) throw new Error("workspace_connection_not_found");
  const authorization = await reauthorizeWorkspaceTarget(target, selection.roomId);
  if (authorization.status === "identity_required") throw new Error("workspace_identity_required");
  if (authorization.status === "offline") throw new Error("workspace_selection_unavailable");
  if (authorization.status === "denied") throw new Error("workspace_selection_denied");
  if (selection.organizationId && authorization.organizationId && selection.organizationId !== authorization.organizationId) {
    throw new Error("workspace_selection_denied");
  }
  // A newer explicit selection owns the registry and active navigation. The
  // older authorization may finish at any time, so it must not apply stale
  // credentials or switch the realtime target back to the previous choice.
  if (activationGeneration !== workspaceActivationGeneration) return;
  let nextRegistry = workspaceConnectionRegistry;
  if (!connection.targets.some((candidate) => candidate.workspaceId === target.workspaceId)) {
    nextRegistry = upsertWorkspaceTarget(nextRegistry, target);
  }
  nextRegistry = patchWorkspaceTarget(nextRegistry, target, {
    lastOrganizationId: authorization.organizationId ?? selection.organizationId ?? null,
    lastRoomId: authorization.roomId ?? null
  });
  nextRegistry = selectWorkspaceTarget(nextRegistry, target);
  if (activationGeneration !== workspaceActivationGeneration) return;
  const commit = workspaceSelectionCommit.then(async () => {
    if (activationGeneration !== workspaceActivationGeneration) return;
    await saveWorkspaceConnectionRegistry(workspaceConnectionRegistryPath, nextRegistry);
    if (activationGeneration !== workspaceActivationGeneration) return;
    workspaceConnectionRegistry = nextRegistry;
    applyWorkspaceTarget(target);
    void reconnectActiveWorkspaceRealtime();
  });
  workspaceSelectionCommit = commit.catch(() => undefined);
  await commit;
}

async function persistActiveWorkspaceSelection(selection: {
  connectionId?: string;
  organizationId?: string;
  workspaceId?: string;
  roomId?: string;
}): Promise<void> {
  const current = workspaceConnectionRegistry.activeTarget;
  const connectionId = selection.connectionId ?? current?.connectionId ?? workspaceConnectionRegistry.activeConnectionId;
  if (!connectionId) return;
  // An omitted Workspace ID means "leave Workspace context" (for example
  // when selecting or removing an Organization). Never keep the current
  // target by accident when a caller explicitly clears that field.
  let target = selection.workspaceId === undefined || !current || current.connectionId !== connectionId ? undefined : current;
  if (selection.workspaceId) {
    target = { connectionId, workspaceId: selection.workspaceId };
    if (!workspaceConnectionRegistry.connections.some((connection) => connection.id === connectionId)) {
      throw new Error("workspace_connection_not_found");
    }
    if (!workspaceConnectionRegistry.connections.find((connection) => connection.id === connectionId)?.targets.some((candidate) => candidate.workspaceId === selection.workspaceId)) {
      workspaceConnectionRegistry = upsertWorkspaceTarget(workspaceConnectionRegistry, target);
    }
  }
  if (!target) {
    if (current) {
      workspaceTargetGeneration += 1;
      workspaceSelectionGeneration += 1;
      workspaceActivationGeneration += 1;
    }
    workspaceConnectionRegistry = clearActiveWorkspaceTarget(workspaceConnectionRegistry);
    await saveWorkspaceConnectionRegistry(workspaceConnectionRegistryPath, workspaceConnectionRegistry);
    applyWorkspaceTarget(undefined);
    // Organization is optional control-plane context and may be selected
    // while no Workspace target is active. It is never used as a Workspace
    // identity or request scope.
    activeOrganizationId = selection.organizationId;
    void reconnectActiveWorkspaceRealtime();
    return;
  }
  workspaceConnectionRegistry = patchWorkspaceTarget(workspaceConnectionRegistry, target, {
    lastOrganizationId: selection.organizationId ?? null,
    lastRoomId: selection.roomId ?? null
  });
  workspaceConnectionRegistry = selectWorkspaceTarget(workspaceConnectionRegistry, target);
  await saveWorkspaceConnectionRegistry(workspaceConnectionRegistryPath, workspaceConnectionRegistry);
  // A slow request must not switch the user back to a target selected while it
  // was in flight. The candidate is persisted, but only the current target
  // updates Main's active navigation/realtime state.
  if (!sameWorkspaceTarget(workspaceConnectionRegistry.activeTarget, target)) return;
  if (!sameWorkspaceTarget(current, target)) {
    workspaceTargetGeneration += 1;
    workspaceSelectionGeneration += 1;
    workspaceActivationGeneration += 1;
  }
  applyWorkspaceTarget(target);
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

const roomWorkPublicPayloadKeys = new Set([
  "id", "room_id", "workspace_id", "work_id", "requester_id", "default_agent_id", "agent_id", "target_agent_id",
  "parent_assignee_id", "assignee_id", "title", "objective", "status", "kind", "instruction", "body", "attachments", "resource_refs",
  "assignees", "instructions", "comments", "controls", "operation_id", "source_comment_id", "created_by", "action",
  "enabled", "can_execute", "agent_version", "instruction_version", "generation", "version", "reaction_count",
  "applied_instruction_ids", "unconfirmed_assignee_ids", "reaction", "created_at", "updated_at", "completed_at",
  "objective_id", "front_agent_id", "default_agent_version", "completion_criteria", "stop_state", "execution_reservations",
  "accepted_at", "delivered_at", "applied_at", "stop_request_status", "terminal_status", "assignment_id", "scheduled_at",
  "claimed_at", "released_at"
]);

const agentDmPublicPayloadKeys = new Set([
  "id", "room_id", "workspace_id", "kind", "agent_id", "agent_version", "version", "visibility", "membership_mode", "created_at", "updated_at"
]);

/** Renderer-safe Agent directory fields. Instructions, descriptions,
 * credentials, and runtime Session references are deliberately absent. */
const workspaceAgentPublicPayloadKeys = new Set([
  "id", "workspace_id", "workspaceId", "name", "display_name", "displayName", "role", "backend_id", "backendId", "enabled", "status", "can_execute", "canExecute", "version"
]);

const publicPayloadSensitiveKey = /(?:private|secret|credential|password|token|authorization|api[_-]?key|session)/i;
const publicPayloadBodyKey = /^(?:content|body|prompt|message|text)$/i;

function publicRoomWorkInput(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
}

function roomWorkResourceRefsInput(value: unknown): Array<{ kind: "knowledge" | "skill"; id: string; version: number }> {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("workspace_room_resource_ref_invalid");
  if (value.length > 32) throw new Error("workspace_room_resource_ref_count_invalid");
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("workspace_room_resource_ref_invalid");
    const source = item as Record<string, unknown>;
    const id = typeof source.id === "string" ? source.id.trim() : "";
    if ((source.kind !== "knowledge" && source.kind !== "skill")
      || !id
      || id.length > 512
      || typeof source.version !== "number"
      || !Number.isSafeInteger(source.version)
      || source.version <= 0) {
      throw new Error("workspace_room_resource_ref_invalid");
    }
    return { kind: source.kind, id, version: source.version };
  });
}

function sanitizeRoomWorkPayload(value: unknown, depth = 0, keys = roomWorkPublicPayloadKeys, fieldKey?: string): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") {
    const max = fieldKey === "instruction" ? 1_000_000 : fieldKey === "body" ? 100_000 : 20_000;
    return value.slice(0, max);
  }
  if (depth > 8) return undefined;
  if (Array.isArray(value)) return value.slice(0, 1_000).map((item) => sanitizeRoomWorkPayload(item, depth + 1, keys, fieldKey)).filter((item) => item !== undefined);
  if (!value || typeof value !== "object") return undefined;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (publicPayloadSensitiveKey.test(key) || !keys.has(key)) continue;
    const sanitized = key === "attachments" || key === "resources"
      ? sanitizeRoomWorkResources(item)
      : key === "resource_refs"
        ? sanitizeRoomWorkResourceRefs(item)
        : sanitizeRoomWorkPayload(item, depth + 1, keys, key);
    if (sanitized !== undefined) output[key] = sanitized;
  }
  return output;
}

function sanitizeRoomWorkResources(value: unknown): unknown {
  if (!Array.isArray(value)) return undefined;
  return value.slice(0, 100).flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const resource = item as Record<string, unknown>;
    if (typeof resource.kind !== "string" || typeof resource.id !== "string" || typeof resource.uri !== "string") return [];
    if (!resource.kind || !resource.id || !resource.uri) return [];
    if (resource.kind === "file") {
      const parsed = PublicRoomWorkAttachmentSchema.safeParse(resource);
      if (!parsed.success) return [];
      return [{
        kind: parsed.data.kind,
        id: parsed.data.id,
        uri: parsed.data.uri,
        version: parsed.data.version,
        ...(parsed.data.label === undefined ? {} : { label: parsed.data.label })
      }];
    }
    if ((resource.version !== undefined && typeof resource.version !== "string")
      || (resource.label !== undefined && typeof resource.label !== "string")) return [];
    return [{
      kind: resource.kind.slice(0, 256),
      id: resource.id.slice(0, 512),
      uri: resource.uri.slice(0, 4_096),
      ...(typeof resource.version === "string" ? { version: resource.version.slice(0, 128) } : {}),
      ...(typeof resource.label === "string" ? { label: resource.label.slice(0, 4_096) } : {})
    }];
  });
}

function sanitizeRoomWorkResourceRefs(value: unknown): unknown {
  if (!Array.isArray(value)) return undefined;
  if (value.length > 32) throw new Error("workspace_room_resource_ref_count_response_invalid");
  return value.map((item) => {
    const parsed = PublicRoomWorkResourceRefSchema.safeParse(item);
    if (!parsed.success) throw new Error("workspace_room_resource_ref_response_invalid");
    return parsed.data;
  });
}

function sanitizeAgentDmPayload(value: unknown): unknown {
  return sanitizeRoomWorkPayload(value, 0, agentDmPublicPayloadKeys);
}

function roomWorkReplayPayload(value: unknown, replayed: boolean, keys = roomWorkPublicPayloadKeys): unknown {
  const sanitized = sanitizeRoomWorkPayload(value, 0, keys);
  if (!sanitized || typeof sanitized !== "object" || Array.isArray(sanitized)) return sanitized;
  return { ...(sanitized as Record<string, unknown>), replayed };
}

function sanitizeRoomWorkListPayload(value: unknown, roomId?: string): unknown {
  if (Array.isArray(value)) return { ...(roomId ? { roomId } : {}), works: value.map((item) => sanitizeRoomWorkPayload(item)).filter((item) => item !== undefined) };
  const record = publicRoomWorkInput(value);
  const rawWorks = Array.isArray(record.works) ? record.works : Array.isArray(record.room_works) ? record.room_works : [];
  return {
    ...(roomId ? { roomId } : {}),
    works: rawWorks.map((item) => sanitizeRoomWorkPayload(item)).filter((item) => item !== undefined),
    ...(typeof record.next_cursor === "string" ? { next_cursor: record.next_cursor.slice(0, 512) } : {})
  };
}

function sanitizeWorkspaceAgentListPayload(value: unknown, workspaceId: string): Array<Record<string, unknown>> {
  const record = publicRoomWorkInput(value);
  const rows = Array.isArray(value)
    ? value
    : Array.isArray(record.agents) ? record.agents : [];
  return rows.map((item) => sanitizeWorkspaceAgentPayload(item, workspaceId));
}

function sanitizeWorkspaceAgentBackendListPayload(value: unknown): Array<Record<string, unknown>> {
  const parsed = PublicAgentBackendRecordSchema.array().max(100).safeParse(value);
  if (!parsed.success) throw new Error("workspace_agent_backend_response_invalid");
  return parsed.data;
}

/** Explicit agent.view/editor projection. Never include credentials or
 * backend runtime/session details in a renderer response. */
function sanitizeWorkspaceAgentDetailPayload(value: unknown, workspaceId: string): Record<string, unknown> {
  const record = publicRoomWorkInput(value);
  const responseWorkspaceId = typeof record.workspace_id === "string" ? record.workspace_id : typeof record.workspaceId === "string" ? record.workspaceId : workspaceId;
  if (responseWorkspaceId !== workspaceId) throw new Error("workspace_agent_workspace_scope_invalid");
  const id = typeof record.id === "string" ? record.id.trim().slice(0, 512) : "";
  const displayName = typeof record.name === "string" ? record.name : typeof record.display_name === "string" ? record.display_name : typeof record.displayName === "string" ? record.displayName : "";
  if (!id || !displayName.trim() || typeof record.enabled !== "boolean") throw new Error("workspace_agent_response_invalid");
  const output: Record<string, unknown> = { id, workspaceId, displayName: displayName.trim().slice(0, 200), enabled: record.enabled };
  if (typeof record.description === "string") output.description = record.description.slice(0, 2_000);
  if (typeof record.role === "string") output.role = record.role.slice(0, 500);
  if (typeof record.instructions === "string") output.instructions = record.instructions.slice(0, 20_000);
  if (typeof record.backend_id === "string") output.backendId = record.backend_id.slice(0, 512);
  else if (typeof record.backendId === "string") output.backendId = record.backendId.slice(0, 512);
  if (typeof record.status === "string") output.status = record.status.slice(0, 128);
  if (typeof record.can_execute === "boolean") output.canExecute = record.can_execute;
  else if (typeof record.canExecute === "boolean") output.canExecute = record.canExecute;
  if (typeof record.version === "number" && Number.isSafeInteger(record.version)) output.version = record.version;
  if (typeof record.created_by === "string") output.createdBy = record.created_by.slice(0, 512);
  if (typeof record.created_at === "string") output.createdAt = record.created_at.slice(0, 64);
  if (typeof record.updated_at === "string") output.updatedAt = record.updated_at.slice(0, 64);
  return output;
}

function sanitizeWorkspaceRoomAgentPermissionPayload(value: unknown, roomId: string): Record<string, unknown> {
  const body = publicRoomWorkInput(value);
  const permission = body.permission && typeof body.permission === "object" && !Array.isArray(body.permission) ? body.permission as Record<string, unknown> : body;
  const actualRoomId = typeof permission.room_id === "string" ? permission.room_id : typeof permission.roomId === "string" ? permission.roomId : "";
  const agentId = typeof permission.agent_id === "string" ? permission.agent_id : typeof permission.agentId === "string" ? permission.agentId : "";
  if (actualRoomId !== roomId || !agentId || typeof permission.can_view !== "boolean" || typeof permission.can_edit !== "boolean" || typeof permission.can_execute !== "boolean") throw new Error("workspace_room_agent_response_invalid");
  return {
    id: typeof permission.id === "string" ? permission.id.slice(0, 512) : `room_agent:${roomId}:${agentId}`,
    roomId,
    agentId: agentId.slice(0, 512),
    canView: permission.can_view,
    canEdit: permission.can_edit,
    canExecute: permission.can_execute,
    version: typeof permission.version === "number" && Number.isSafeInteger(permission.version) ? permission.version : 1,
    ...(typeof permission.created_by === "string" ? { createdBy: permission.created_by.slice(0, 512) } : {}),
    ...(typeof permission.created_at === "string" ? { createdAt: permission.created_at.slice(0, 64) } : {}),
    ...(typeof permission.updated_at === "string" ? { updatedAt: permission.updated_at.slice(0, 64) } : {}),
    removed: permission.removed === true || (!permission.can_view && !permission.can_edit && !permission.can_execute)
  };
}

function sanitizeWorkspaceRoomAgentMemberListPayload(value: unknown, roomId: string): Record<string, unknown> {
  const body = publicRoomWorkInput(value);
  const rows = Array.isArray(body.agents) ? body.agents : [];
  return { roomId, agents: rows.map((entry) => sanitizeWorkspaceRoomAgentPermissionPayload(entry, roomId)) };
}

function sanitizeWorkspaceAgentPayload(value: unknown, workspaceId: string): Record<string, unknown> {
  const record = publicRoomWorkInput(value);
  const publicRecord = Object.fromEntries(Object.entries(record).filter(([key]) => workspaceAgentPublicPayloadKeys.has(key)));
  const responseWorkspaceId = typeof publicRecord.workspace_id === "string"
    ? publicRecord.workspace_id
    : typeof publicRecord.workspaceId === "string" ? publicRecord.workspaceId : workspaceId;
  if (responseWorkspaceId !== workspaceId) throw new Error("workspace_agent_workspace_scope_invalid");
  const id = typeof publicRecord.id === "string" ? publicRecord.id.trim().slice(0, 512) : "";
  const displayName = typeof publicRecord.name === "string"
    ? publicRecord.name
    : typeof publicRecord.display_name === "string"
      ? publicRecord.display_name
      : typeof publicRecord.displayName === "string" ? publicRecord.displayName : "";
  if (!id || !displayName.trim() || typeof publicRecord.enabled !== "boolean") throw new Error("workspace_agent_response_invalid");
  const output: Record<string, unknown> = {
    id,
    workspaceId,
    displayName: displayName.trim().slice(0, 200),
    enabled: publicRecord.enabled
  };
  if (typeof publicRecord.role === "string") output.role = publicRecord.role.slice(0, 500);
  if (typeof publicRecord.backend_id === "string") output.backendId = publicRecord.backend_id.slice(0, 512);
  else if (typeof publicRecord.backendId === "string") output.backendId = publicRecord.backendId.slice(0, 512);
  if (typeof publicRecord.status === "string") output.status = publicRecord.status.slice(0, 128);
  if (typeof publicRecord.can_execute === "boolean") output.canExecute = publicRecord.can_execute;
  else if (typeof publicRecord.canExecute === "boolean") output.canExecute = publicRecord.canExecute;
  if (typeof publicRecord.version === "number" && Number.isSafeInteger(publicRecord.version)) output.version = publicRecord.version;
  return output;
}

function assertRoomWorkListResponseScope(value: unknown, roomId: string): void {
  const record = publicRoomWorkInput(value);
  const works = Array.isArray(value) ? value : Array.isArray(record.works) ? record.works : Array.isArray(record.room_works) ? record.room_works : [];
  for (const work of works) assertRoomWorkResponseScope(work, roomId);
}

function assertRoomWorkResponseScope(value: unknown, roomId: string, workId?: string): void {
  const record = publicRoomWorkInput(value);
  if (typeof record.room_id === "string" && record.room_id !== roomId) throw new Error("room_work_room_scope_invalid");
  const actualWorkId = typeof record.work_id === "string" ? record.work_id : typeof record.id === "string" ? record.id : undefined;
  if (workId !== undefined && actualWorkId !== undefined && actualWorkId !== workId) throw new Error("room_work_scope_invalid");
}

function assertRoomWorkDelegateResponseScope(value: unknown, workId: string, parentAssigneeId: string, agentId: string): void {
  const record = publicRoomWorkInput(value);
  if (record.id === parentAssigneeId
    || record.work_id !== workId
    || record.agent_id !== agentId
    || (record.parent_assignee_id !== undefined && record.parent_assignee_id !== null && record.parent_assignee_id !== parentAssigneeId)) {
    throw new Error("room_work_delegate_response_scope_invalid");
  }
}

function assertRoomDefaultAgentResponseScope(value: unknown, roomId: string, agentId?: string, workspaceId?: string): void {
  const record = publicRoomWorkInput(value);
  if (record.room_id !== roomId) throw new Error("room_default_agent_scope_invalid");
  if (agentId !== undefined && record.agent_id !== agentId) throw new Error("room_default_agent_agent_scope_invalid");
  if (workspaceId !== undefined && record.workspace_id !== undefined && record.workspace_id !== workspaceId) {
    throw new Error("room_default_agent_workspace_scope_invalid");
  }
}

function assertAgentDmResponseScope(value: unknown, agentId: string, workspaceId: string): void {
  const record = publicRoomWorkInput(value);
  if (record.kind !== "agent_dm") throw new Error("agent_dm_kind_scope_invalid");
  if (record.agent_id !== agentId) throw new Error("agent_dm_agent_scope_invalid");
  if (record.workspace_id !== workspaceId) throw new Error("agent_dm_workspace_scope_invalid");
}

function sanitizeWorkspaceEventPage(value: unknown): unknown {
  const record = publicRoomWorkInput(value);
  const events = Array.isArray(record.events) ? record.events.map(sanitizeWorkspaceEvent).filter((item) => item !== undefined) : [];
  return {
    events,
    ...(typeof record.next_cursor === "string" ? { next_cursor: record.next_cursor.slice(0, 512) } : {}),
    has_more: record.has_more === true
  };
}

function sanitizeWorkspaceEvent(value: unknown): unknown {
  const record = publicRoomWorkInput(value);
  const eventId = typeof record.event_id === "string" ? record.event_id.trim().slice(0, 512) : "";
  const eventType = typeof record.event_type === "string" ? record.event_type.trim().slice(0, 128) : "";
  const eventVersion = typeof record.event_version === "string" ? record.event_version.trim().slice(0, 32) : "";
  const cursor = typeof record.cursor === "string" ? record.cursor.trim().slice(0, 512) : "";
  const occurredAt = typeof record.occurred_at === "string" ? record.occurred_at.trim().slice(0, 64) : "";
  if (!eventId || !/^[a-z][a-z0-9._-]{0,127}$/.test(eventType) || !/^\d+\.\d+$/.test(eventVersion) || !cursor || !occurredAt) return undefined;
  const actor = publicRoomWorkInput(record.actor);
  const scope = publicRoomWorkInput(record.scope);
  const actorKind = actor.kind === "human" || actor.kind === "agent" || actor.kind === "system" ? actor.kind : undefined;
  const workspaceId = typeof scope.workspace_id === "string" ? scope.workspace_id.trim().slice(0, 512) : "";
  const resources = sanitizeRoomWorkResources(record.resources);
  if (!actorKind || !workspaceId || !resources) return undefined;
  return {
    event_id: eventId,
    event_type: eventType,
    event_version: eventVersion,
    cursor,
    occurred_at: occurredAt,
    actor: {
      kind: actorKind,
      ...(typeof actor.id === "string" ? { id: actor.id.slice(0, 512) } : {})
    },
    scope: {
      workspace_id: workspaceId,
      ...(typeof scope.room_id === "string" ? { room_id: scope.room_id.slice(0, 512) } : {})
    },
    resources,
    ...(typeof record.operation_id === "string" ? { operation_id: record.operation_id.slice(0, 512) } : {}),
    ...(typeof record.correlation_id === "string" ? { correlation_id: record.correlation_id.slice(0, 512) } : {}),
    payload: sanitizeWorkspaceEventPayload(record.payload)
  };
}

function sanitizeWorkspaceEventPayload(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return value.slice(0, 4_096);
  if (depth > 6) return undefined;
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitizeWorkspaceEventPayload(item, depth + 1)).filter((item) => item !== undefined);
  if (!value || typeof value !== "object") return undefined;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (publicPayloadSensitiveKey.test(key) || publicPayloadBodyKey.test(key)) continue;
    const sanitized = sanitizeWorkspaceEventPayload(item, depth + 1);
    if (sanitized !== undefined) output[key.slice(0, 128)] = sanitized;
  }
  return output;
}

async function executeRoomWorkControlIpc(
  operationId: "room.work.stop" | "room.work.assignee.stop",
  input: unknown,
  options: { workOnly: boolean }
): Promise<unknown> {
  const workspaceSnapshot = captureWorkspaceTargetSnapshot(workspaceTargetFromInput(input));
  const roomId = requiredWorkspaceOpaqueField(input, "roomId");
  const workId = requiredWorkspaceOpaqueField(input, "workId");
  const operationRequestId = requiredWorkspaceOpaqueField(input, "operationId");
  const value = publicRoomWorkInput(input);
  const assigneeId = options.workOnly ? undefined : requiredWorkspaceOpaqueField(input, "assigneeId");
  const response = await snapshotWorkspaceDomainApiClient(workspaceSnapshot).executeOperation<unknown>(workspaceSnapshot.workspaceId, operationId, {
    context: { room_id: roomId },
    input: {
      work_id: workId,
      ...(assigneeId ? { assignee_id: assigneeId } : {}),
      ...(typeof value.reason === "string" ? { reason: value.reason } : {}),
      ...(typeof value.expectedVersion === "number" ? { expected_version: value.expectedVersion } : {}),
      ...(typeof value.expectedGeneration === "number" ? { expected_generation: value.expectedGeneration } : {})
    }
  }, { operationId: operationRequestId, idempotencyKey: operationRequestId });
  assertActiveWorkspaceSnapshot(workspaceSnapshot);
  assertRoomWorkResponseScope(response.result, roomId, workId);
  return roomWorkReplayPayload(response.result, response.replayed);
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

/**
 * Room creation is bound to the renderer's target snapshot.  Do not resolve
 * the active connection again after the operation has started: a navigation
 * during the transport must either use this exact connection or fail before
 * the request is signed.
 */
function snapshotWorkspaceDomainApiClient(snapshot: ActiveWorkspaceSnapshot): DomainApiClient {
  return new DomainApiClient(async <T>(request: DomainApiTransportRequest): Promise<T> => {
    const result = await snapshotWorkspaceServerRequest(snapshot, {
      method: request.method,
      path: request.path,
      workspaceScoped: true,
      workspaceId: snapshot.workspaceId,
      ...(request.operationId ? { operationId: request.operationId } : {}),
      ...(request.idempotencyKey ? { idempotencyKey: request.idempotencyKey } : {}),
      ...(request.body === undefined ? {} : { body: request.body })
    });
    return result as T;
  });
}

function toDesktopWorkspaceRoom(room: PublicRoomRecord): {
  id: string;
  workspaceId: string;
  parentRoomId?: string;
  name: string;
  version: number;
  kind?: "normal" | "agent_dm";
  defaultAgentId?: string;
  defaultAgentVersion?: number;
  defaultAgentEnabled?: boolean;
  defaultAgentCanExecute?: boolean;
  canManage?: boolean;
  canExecute?: boolean;
  createdAt: string;
  updatedAt: string;
} {
  const extendedRoom = room as PublicRoomRecord & {
    default_agent_enabled?: unknown;
    default_agent_can_execute?: unknown;
    default_agent?: unknown;
  };
  const defaultAgent = extendedRoom.default_agent && typeof extendedRoom.default_agent === "object" && !Array.isArray(extendedRoom.default_agent)
    ? extendedRoom.default_agent as Record<string, unknown>
    : {};
  const defaultAgentEnabled = typeof extendedRoom.default_agent_enabled === "boolean"
    ? extendedRoom.default_agent_enabled
    : typeof defaultAgent.enabled === "boolean" ? defaultAgent.enabled : undefined;
  const defaultAgentCanExecute = typeof extendedRoom.default_agent_can_execute === "boolean"
    ? extendedRoom.default_agent_can_execute
    : typeof defaultAgent.can_execute === "boolean" ? defaultAgent.can_execute : undefined;
  return {
    id: room.id,
    workspaceId: room.workspace_id,
    ...(room.parent_room_id ? { parentRoomId: room.parent_room_id } : {}),
    name: room.name,
    version: room.version,
    kind: room.kind ?? "normal",
    ...(room.default_agent_id ? { defaultAgentId: room.default_agent_id } : {}),
    ...(room.default_agent_version === undefined ? {} : { defaultAgentVersion: room.default_agent_version }),
    ...(defaultAgentEnabled === undefined ? {} : { defaultAgentEnabled }),
    ...(defaultAgentCanExecute === undefined ? {} : { defaultAgentCanExecute }),
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
  workspaceRealtimeTargetRef = undefined;
  workspaceRealtimeSocket?.disconnect();
  workspaceRealtimeSocket = undefined;
  const connection = activeWorkspaceConnection(workspaceConnectionRegistry);
  const target = workspaceConnectionRegistry.activeTarget;
  if (!connection?.credentialRef || !target || target.connectionId !== connection.id) return;
  void (async () => {
    let privateKey: string;
    try {
      privateKey = await requireActiveWorkspacePrivateKey(connection);
    } catch {
      return;
    }
    if (generation !== workspaceRealtimeGeneration) return;
    if (!sameWorkspaceTarget(workspaceConnectionRegistry.activeTarget, target)) return;
    const socket = io(connection.serverUrl, {
      autoConnect: false,
      transports: ["websocket", "polling"],
      timeout: 10_000,
      auth: (callback) => {
        try {
          callback(workspaceSocketAuth(connection, privateKey, target.workspaceId));
        } catch {
          callback({});
        }
      }
    });
    workspaceRealtimeSocket = socket;
    workspaceRealtimeTargetRef = target;
    const isCurrent = () => generation === workspaceRealtimeGeneration
      && workspaceRealtimeSocket === socket
      && sameWorkspaceTarget(workspaceRealtimeTargetRef, target);
    socket.on("connect", () => {
      if (!isCurrent()) return;
      void syncWorkspaceRealtime(socket, connection, target, privateKey, isCurrent);
    });
    socket.on("workspace:v1:event", (event: unknown) => {
      if (!isCurrent() || !acceptWorkspacePublicEvent(event)) return;
      forwardWorkspaceRealtimeNotice("event", connection, target, event);
    });
    socket.on("workspace:event", (event: unknown) => {
      if (!isCurrent()) return;
      forwardWorkspaceRealtimeNotice("event", connection, target, event);
      // A tree event can make a new directly-authorized Room subscribable.
      void refreshWorkspaceRealtimeRooms(socket, connection, target, privateKey, isCurrent);
    });
    socket.on("workspace:access-changed", (event: unknown) => {
      if (!isCurrent()) return;
      forwardWorkspaceRealtimeNotice("access_changed", connection, target, event);
      void refreshWorkspaceRealtimeRooms(socket, connection, target, privateKey, isCurrent);
      void reauthorizeActiveWorkspaceCandidate();
    });
    socket.on("workspace:room-access-changed", (event: unknown) => {
      if (!isCurrent()) return;
      forwardWorkspaceRealtimeNotice("room_access_changed", connection, target, event);
      void refreshWorkspaceRealtimeRooms(socket, connection, target, privateKey, isCurrent);
      void reauthorizeActiveWorkspaceCandidate();
    });
    socket.on("workspace:room-access-revoked", (event: unknown) => {
      if (!isCurrent()) return;
      forwardWorkspaceRealtimeNotice("room_access_revoked", connection, target, event);
      const roomId = realtimeEventRoomId(event);
      if (roomId && roomId === activeRoomId && sameWorkspaceTarget(workspaceConnectionRegistry.activeTarget, target)) {
        void persistActiveWorkspaceSelection({ connectionId: target.connectionId, organizationId: activeOrganizationId, workspaceId: target.workspaceId });
      }
    });
    socket.on("workspace:access-revoked", (event: unknown) => {
      if (!isCurrent()) return;
      forwardWorkspaceRealtimeNotice("access_revoked", connection, target, event);
      socket.disconnect();
      if (sameWorkspaceTarget(workspaceConnectionRegistry.activeTarget, target)) {
        workspaceConnectionRegistry = clearActiveWorkspaceTarget(workspaceConnectionRegistry, target);
        void saveWorkspaceConnectionRegistry(workspaceConnectionRegistryPath, workspaceConnectionRegistry).then(() => {
          applyWorkspaceTarget(undefined);
          reconnectActiveWorkspaceRealtime();
        });
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

function workspaceSocketAuth(connection: WorkspaceConnection, privateKey: string, workspaceId: string): Record<string, string> {
  if (!isWorkspaceOpaqueId(workspaceId)) throw new Error("workspace_selection_required");
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
  target: WorkspaceTargetRef,
  privateKey: string,
  isCurrent: () => boolean
): Promise<void> {
  try {
    const response = await signedWorkspaceServerRequest(connection, privateKey, {
      method: "GET",
      path: `/api/workspaces/${encodeURIComponent(target.workspaceId)}/rooms`,
      workspaceScoped: true,
      workspaceId: target.workspaceId
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
  target: WorkspaceTargetRef,
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
        path: `/api/v1/workspaces/${encodeURIComponent(target.workspaceId)}/events${query}`,
        workspaceScoped: true,
        workspaceId: target.workspaceId
      });
      if (!isCurrent() || response.status < 200 || response.status >= 300 || !response.body || typeof response.body !== "object") break;
      const body = response.body as { events?: unknown; next_cursor?: unknown; has_more?: unknown };
      if (!Array.isArray(body.events)) break;
      for (const event of body.events) {
        if (!acceptWorkspacePublicEvent(event)) continue;
        forwardWorkspaceRealtimeNotice("event", connection, target, event);
      }
      const nextCursor = typeof body.next_cursor === "string" ? body.next_cursor : undefined;
      if (body.has_more === true && nextCursor) {
        afterCursor = nextCursor;
        continue;
      }
      break;
    }
    await refreshWorkspaceRealtimeRooms(socket, connection, target, privateKey, isCurrent);
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
function forwardWorkspaceRealtimeNotice(type: WorkspaceRealtimeNotice["type"], connection: WorkspaceConnection, target: WorkspaceTargetRef, event: unknown): void {
  if (!mainWindow || mainWindow.isDestroyed() || !event || typeof event !== "object") return;
  const value = event as {
    workspaceId?: unknown;
    roomId?: unknown;
    kind?: unknown;
    event_id?: unknown;
    cursor?: unknown;
    event_type?: unknown;
    event_version?: unknown;
    operation_id?: unknown;
    correlation_id?: unknown;
    scope?: { workspace_id?: unknown; room_id?: unknown };
  };
  const workspaceId = value.workspaceId ?? value.scope?.workspace_id;
  if (target.connectionId !== connection.id || workspaceId !== target.workspaceId) return;
  const notice: WorkspaceRealtimeNotice = { type, connectionId: connection.id, workspaceId: target.workspaceId };
  const roomId = value.roomId ?? value.scope?.room_id;
  if (typeof roomId === "string" && isWorkspaceOpaqueId(roomId)) notice.roomId = roomId;
  const kind = value.kind ?? value.event_type;
  if (typeof kind === "string" && /^[a-z][a-z0-9._-]{0,127}$/.test(kind)) notice.kind = kind;
  if (typeof value.event_id === "string" && isWorkspaceOpaqueId(value.event_id)) notice.eventId = value.event_id;
  if (typeof value.event_version === "string" && /^\d+\.\d+$/.test(value.event_version)) notice.eventVersion = value.event_version;
  if (typeof value.cursor === "string" && value.cursor.length <= 512) notice.cursor = value.cursor;
  if (typeof value.operation_id === "string" && isWorkspaceOpaqueId(value.operation_id)) notice.operationId = value.operation_id;
  if (typeof value.correlation_id === "string" && isWorkspaceOpaqueId(value.correlation_id)) notice.correlationId = value.correlation_id;
  mainWindow.webContents.send("samurai:workspace-server:event", notice);
}

function isWorkspaceOpaqueId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

function workspaceRoomsPath(workspaceId: string): string {
  return `/api/workspaces/${encodeURIComponent(workspaceId)}/rooms`;
}

function activeWorkspaceRoomsPath(): string {
  return workspaceRoomsPath(requireActiveWorkspaceId());
}

function workspaceLearningPath(workspaceId: string): string {
  return `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/learning`;
}

function activeWorkspaceLearningPath(): string {
  return workspaceLearningPath(requireActiveWorkspaceId());
}

function workspaceCompletionPath(workspaceId: string): string {
  return `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/completion`;
}

function workspaceLegacyCompletionPath(workspaceId: string): string {
  return `/api/workspaces/${encodeURIComponent(workspaceId)}/completion`;
}

function activeWorkspaceCompletionPath(): string {
  return workspaceCompletionPath(requireActiveWorkspaceId());
}

function workspaceSkillsPath(workspaceId: string): string {
  return `/api/workspaces/${encodeURIComponent(workspaceId)}/skills`;
}

function activeWorkspaceSkillsPath(): string {
  return workspaceSkillsPath(requireActiveWorkspaceId());
}

function workspaceSkillOptimizationPath(workspaceId: string): string {
  return `/api/workspaces/${encodeURIComponent(workspaceId)}/skill-optimizations`;
}

function activeWorkspaceSkillOptimizationPath(): string {
  return workspaceSkillOptimizationPath(requireActiveWorkspaceId());
}

function workspaceKnowledgeWikiPath(workspaceId: string): string {
  return `/api/workspaces/${encodeURIComponent(workspaceId)}/knowledge-wiki`;
}

function activeWorkspaceKnowledgeWikiPath(): string {
  return workspaceKnowledgeWikiPath(requireActiveWorkspaceId());
}

function workspaceKnowledgeMemoryPath(workspaceId: string): string {
  return `/api/workspaces/${encodeURIComponent(workspaceId)}/knowledge-memory`;
}

function activeWorkspaceKnowledgeMemoryPath(): string {
  return workspaceKnowledgeMemoryPath(requireActiveWorkspaceId());
}

function workspaceCollectionsPath(workspaceId: string): string {
  return `/api/workspaces/${encodeURIComponent(workspaceId)}/collections`;
}

function activeWorkspaceCollectionsPath(): string {
  return workspaceCollectionsPath(requireActiveWorkspaceId());
}

function workspaceAutomationPath(workspaceId: string): string {
  return `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/automation`;
}

function activeWorkspaceAutomationPath(): string {
  return workspaceAutomationPath(requireActiveWorkspaceId());
}

function workspaceArtifactsPath(workspaceId: string): string {
  return `/api/workspaces/${encodeURIComponent(workspaceId)}/artifacts`;
}

function workspaceSettingsPath(workspaceId: string): string {
  return `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/settings`;
}

function activeWorkspaceArtifactsPath(): string {
  return workspaceArtifactsPath(requireActiveWorkspaceId());
}

function activeWorkspaceV1ArtifactsPath(): string {
  return workspaceV1ArtifactsPath(requireActiveWorkspaceId());
}

function workspaceV1ArtifactsPath(workspaceId: string): string {
  return `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/artifacts`;
}

function workspaceV1ArtifactContentPath(workspaceId: string, artifactId: string, roomId: string, revisionId?: string): string {
  const query = new URLSearchParams({ room_id: roomId });
  if (revisionId) query.set("revision_id", revisionId);
  return `${workspaceV1ArtifactsPath(workspaceId)}/${encodeURIComponent(artifactId)}/content?${query.toString()}`;
}

function workspaceGeneratedSurfacesPath(workspaceId: string): string {
  return `/api/workspaces/${encodeURIComponent(workspaceId)}/generated-surfaces`;
}

function activeWorkspaceGeneratedSurfacesPath(): string {
  return workspaceGeneratedSurfacesPath(requireActiveWorkspaceId());
}

function activeWorkspaceV1GeneratedSurfacesPath(): string {
  return workspaceV1GeneratedSurfacesPath(requireActiveWorkspaceId());
}

function workspaceV1GeneratedSurfacesPath(workspaceId: string): string {
  return `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/generated-surfaces`;
}

function workspaceInteractionRequestsPath(workspaceId: string): string {
  return `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/interaction-requests`;
}

function workspaceClientEventsPath(workspaceId: string): string {
  return `/api/workspaces/${encodeURIComponent(workspaceId)}/client-events`;
}

function activeWorkspaceClientEventsPath(): string {
  return workspaceClientEventsPath(requireActiveWorkspaceId());
}

function workspaceChatPath(workspaceId: string): string {
  return `/api/workspaces/${encodeURIComponent(workspaceId)}/chat`;
}

function activeWorkspaceChatPath(): string {
  return workspaceChatPath(requireActiveWorkspaceId());
}

function workspaceFilesPath(workspaceId: string): string {
  return `/api/workspaces/${encodeURIComponent(workspaceId)}/files`;
}

function activeWorkspaceFilesPath(): string {
  return workspaceFilesPath(requireActiveWorkspaceId());
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

function workspaceStatusTargetInput(input: unknown): WorkspaceTargetRef | undefined {
  if (input === undefined || input === null) return undefined;
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("workspace_target_invalid");
  const value = input as Record<string, unknown>;
  return {
    connectionId: requiredSelectionId(value, "connectionId"),
    workspaceId: requiredSelectionId(value, "workspaceId")
  };
}

async function workspaceServerStatus(requestedTarget?: WorkspaceTargetRef): Promise<{
  connection?: Omit<WorkspaceConnection, "credentialRef">;
  target?: WorkspaceTargetRef;
  identityAvailable: boolean;
  health?: { status: number; body: unknown };
  workspace?: { status: number; body: unknown };
  rooms?: { status: number; body: unknown };
}> {
  const target = requestedTarget ?? workspaceConnectionRegistry.activeTarget;
  const connection = target
    ? workspaceConnectionRegistry.connections.find((candidate) => candidate.id === target.connectionId)
    : activeWorkspaceConnection(workspaceConnectionRegistry);
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
    return { connection: publicConnectionWithoutCredential(connection), ...(target ? { target } : {}), identityAvailable, health };
  }
  try {
    const privateKey = await requireActiveWorkspacePrivateKey(connection);
    const workspaceId = target?.workspaceId ?? workspaceIdForConnection(connection);
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
    return {
      connection: publicConnectionWithoutCredential(connection),
      ...(target ? { target } : {}),
      identityAvailable,
      health,
      workspace,
      ...(rooms ? { rooms } : {})
    };
  } catch (error) {
    return {
      connection: publicConnectionWithoutCredential(connection),
      ...(target ? { target } : {}),
      identityAvailable,
      health,
      workspace: { status: 0, body: { error: error instanceof Error ? error.message : "workspace_server_request_failed" } }
    };
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
    workspaceConnectionRegistry = upsertWorkspaceTarget(proposed, {
      connectionId: connection.id,
      workspaceId: target.workspaceId
    });
    workspaceConnectionRegistry = selectWorkspaceTarget(workspaceConnectionRegistry, {
      connectionId: connection.id,
      workspaceId: target.workspaceId
    });
    await saveWorkspaceConnectionRegistry(workspaceConnectionRegistryPath, workspaceConnectionRegistry);
    applyWorkspaceTarget({ connectionId: connection.id, workspaceId: target.workspaceId });
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

function assertWorkspaceInteractionIpcSender(event: { sender?: { id?: number; getURL?: () => string } }): void {
  const sender = event?.sender;
  if (!mainWindow || mainWindow.isDestroyed() || !sender || sender.id !== mainWindow.webContents.id) {
    throw new Error("workspace_ipc_sender_invalid");
  }
  let url = "";
  try {
    url = sender.getURL?.() ?? "";
  } catch {
    throw new Error("workspace_ipc_origin_invalid");
  }
  if (!isAllowedMainNavigation(url, config)) throw new Error("workspace_ipc_origin_invalid");
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
