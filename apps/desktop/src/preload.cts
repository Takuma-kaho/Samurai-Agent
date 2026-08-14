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
  registerWorkspaceServerAccount: (displayName: unknown) => ipcRenderer.invoke("samurai:workspace-server:register-active-account", typeof displayName === "string" ? displayName.slice(0, 160) : ""),
  getWorkspaceServerStatus: () => ipcRenderer.invoke("samurai:workspace-server:status"),
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
  for (const key of ["id", "label", "serverUrl", "workspaceId", "accountId", "credentialRef", "privateKey"]) {
    if (typeof value[key] === "string") output[key] = value[key].slice(0, key === "label" ? 100 : 500);
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
