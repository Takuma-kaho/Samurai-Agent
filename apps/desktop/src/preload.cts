const { contextBridge, ipcRenderer } = require("electron") as typeof import("electron");

const apiBaseUrl = readArg("--samurai-api-base-url=");
const workspaceServerUrl = readArg("--samurai-workspace-server-url=");
const workspaceId = readArg("--samurai-workspace-id=");
const accountId = readArg("--samurai-account-id=");

contextBridge.exposeInMainWorld("samuraiDesktop", {
  apiBaseUrl,
  workspaceServerUrl,
  workspaceId,
  accountId,
  getStatus: () => ipcRenderer.invoke("samurai:get-status"),
  listWorkspaceConnections: () => ipcRenderer.invoke("samurai:workspace-connections:list"),
  upsertWorkspaceConnection: (input: unknown) => ipcRenderer.invoke("samurai:workspace-connections:upsert", sanitizeWorkspaceConnectionInput(input)),
  selectWorkspaceConnection: (connectionId: unknown) => ipcRenderer.invoke("samurai:workspace-connections:select", typeof connectionId === "string" ? connectionId.slice(0, 160) : ""),
  importActiveWorkspaceIdentityFromClipboard: () => ipcRenderer.invoke("samurai:workspace-identity:import-active-from-clipboard"),
  registerWorkspaceServerAccount: (displayName: unknown) => ipcRenderer.invoke("samurai:workspace-server:register-active-account", typeof displayName === "string" ? displayName.slice(0, 160) : ""),
  getWorkspaceServerStatus: () => ipcRenderer.invoke("samurai:workspace-server:status"),
  listWorkspaceRooms: () => ipcRenderer.invoke("samurai:workspace-server:rooms:list"),
  listWorkspaceRoomMembers: (roomId: unknown) => ipcRenderer.invoke("samurai:workspace-server:room-members:list", typeof roomId === "string" ? roomId.slice(0, 128) : ""),
  createWorkspaceRoom: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:room:create", sanitizeWorkspaceRoomOperation(input)),
  previewWorkspaceRoomMove: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:room:move-preview", sanitizeWorkspaceRoomOperation(input)),
  moveWorkspaceRoom: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:room:move", sanitizeWorkspaceRoomOperation(input)),
  previewWorkspaceRoomMember: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:room-member:preview", sanitizeWorkspaceRoomOperation(input)),
  setWorkspaceRoomMember: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:room-member:set", sanitizeWorkspaceRoomOperation(input)),
  listWorkspaceLearningResources: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:learning:resources:list", sanitizeWorkspaceLearningOperation(input)),
  getWorkspaceLearningResource: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:learning:resource:get", sanitizeWorkspaceLearningOperation(input)),
  createWorkspaceLearningResource: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:learning:resource:create", sanitizeWorkspaceLearningOperation(input)),
  updateWorkspaceLearningResource: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:learning:resource:update", sanitizeWorkspaceLearningOperation(input)),
  setWorkspaceLearningResourceFixed: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:learning:resource:fixed", sanitizeWorkspaceLearningOperation(input)),
  archiveWorkspaceLearningResource: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:learning:resource:archive", sanitizeWorkspaceLearningOperation(input)),
  getWorkspaceLearningSettings: (roomId: unknown) => ipcRenderer.invoke("samurai:workspace-server:learning:settings:get", { roomId: typeof roomId === "string" ? roomId.slice(0, 128) : "" }),
  updateWorkspaceLearningSettings: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:learning:settings:put", sanitizeWorkspaceLearningOperation(input)),
  searchWorkspaceKnowledge: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:learning:search", sanitizeWorkspaceLearningOperation(input)),
  onWorkspaceServerEvent: (listener: unknown) => {
    if (typeof listener !== "function") return () => undefined;
    const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => listener(sanitizeWorkspaceRealtimeNotice(payload));
    ipcRenderer.on("samurai:workspace-server:event", handler);
    return () => ipcRenderer.removeListener("samurai:workspace-server:event", handler);
  },
  openMainWindow: () => ipcRenderer.invoke("samurai:window:open"),
  reloadMainWindow: () => ipcRenderer.invoke("samurai:window:reload"),
  quitApp: () => ipcRenderer.invoke("samurai:app:quit"),
  closeAppShot: () => ipcRenderer.invoke("samurai:app-shot:close"),
  closeQuickAsk: () => ipcRenderer.invoke("samurai:quick-ask:close"),
  submitAppShot: (input: unknown) => ipcRenderer.invoke("samurai:app-shot:submit", sanitizeAppShotInput(input)),
  submitQuickAsk: (input: unknown) => ipcRenderer.invoke("samurai:quick-ask:submit", sanitizeQuickAskInput(input))
});

function sanitizeAppShotInput(input: unknown): { sourceId: string; content: string } {
  if (!input || typeof input !== "object" || !("sourceId" in input) || !("content" in input)) {
    return { sourceId: "", content: "" };
  }
  const sourceId = typeof input.sourceId === "string" ? input.sourceId : "";
  const content = typeof input.content === "string" ? input.content : "";
  return {
    sourceId: sourceId.slice(0, 300),
    content: content.slice(0, 2000)
  };
}

function sanitizeWorkspaceConnectionInput(input: unknown): Record<string, string> {
  if (!input || typeof input !== "object") return {};
  const value = input as Record<string, unknown>;
  const output: Record<string, string> = {};
  for (const key of ["id", "label", "serverUrl", "workspaceId", "accountId"]) {
    if (typeof value[key] === "string") output[key] = value[key].slice(0, key === "label" ? 100 : 500);
  }
  return output;
}

function sanitizeWorkspaceRealtimeNotice(input: unknown): { type: string; workspaceId: string; roomId?: string; kind?: string } | undefined {
  if (!input || typeof input !== "object") return undefined;
  const value = input as Record<string, unknown>;
  const type = typeof value.type === "string" && /^(?:event|access_changed|access_revoked|room_access_changed|room_access_revoked)$/.test(value.type)
    ? value.type
    : undefined;
  const workspaceId = typeof value.workspaceId === "string" && opaque(value.workspaceId) ? value.workspaceId : undefined;
  if (!type || !workspaceId) return undefined;
  const output: { type: string; workspaceId: string; roomId?: string; kind?: string } = { type, workspaceId };
  if (typeof value.roomId === "string" && opaque(value.roomId)) output.roomId = value.roomId;
  if (typeof value.kind === "string" && /^[a-z][a-z0-9._-]{0,80}$/.test(value.kind)) output.kind = value.kind;
  return output;
}

function opaque(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

function sanitizeWorkspaceRoomOperation(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const value = input as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const key of ["roomId", "accountId", "name", "operationId", "role", "state"]) {
    if (typeof value[key] === "string") output[key] = value[key].slice(0, key === "name" ? 240 : 128);
  }
  if (value.parentRoomId === null) output.parentRoomId = null;
  if (typeof value.parentRoomId === "string") output.parentRoomId = value.parentRoomId.slice(0, 128);
  for (const key of ["expectedWorkspaceVersion", "expectedRoomVersion", "expectedVersion"]) {
    if (typeof value[key] === "number" && Number.isSafeInteger(value[key])) output[key] = value[key];
  }
  return output;
}

function sanitizeWorkspaceLearningOperation(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const value = input as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const key of ["scopeKind", "roomId", "kind", "resourceId", "operationId", "engineId", "model", "secretRef"]) {
    if (typeof value[key] === "string") output[key] = value[key].slice(0, key === "model" ? 512 : 128);
  }
  for (const key of ["title", "content", "reason", "query"]) {
    if (typeof value[key] === "string") output[key] = value[key].slice(0, key === "content" ? 200_000 : key === "query" ? 2_000 : 20_000);
  }
  for (const key of ["isAbsoluteRule", "fixed", "archived", "includeArchived", "enabled", "clearEngineId", "clearModel", "clearSecretRef", "clearCurrencyLimit", "clearTokenLimit", "removeOverride"]) {
    if (typeof value[key] === "boolean") output[key] = value[key];
  }
  for (const key of ["expectedVersion", "currencyLimit", "tokenLimit", "limit"]) {
    if (typeof value[key] === "number" && Number.isFinite(value[key])) output[key] = value[key];
  }
  return output;
}

function sanitizeQuickAskInput(input: unknown): { content: string; sourceFeature: "quick_ask" | "clipboard_text" | "selected_text" } {
  if (!input || typeof input !== "object" || !("content" in input)) {
    return { content: "", sourceFeature: "quick_ask" };
  }
  const content = typeof input.content === "string" ? input.content : "";
  const sourceFeature = "sourceFeature" in input && (input.sourceFeature === "clipboard_text" || input.sourceFeature === "selected_text")
    ? input.sourceFeature
    : "quick_ask";
  return { content: content.slice(0, 8000), sourceFeature };
}

function readArg(prefix: string): string | undefined {
  const value = process.argv.find((arg) => arg.startsWith(prefix));
  return value ? value.slice(prefix.length) : undefined;
}
