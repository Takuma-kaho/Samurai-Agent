import { fileURLToPath } from "node:url";

export type DesktopMode = "development" | "packaged";

export interface DesktopConfig {
  mode: DesktopMode;
  apiBaseUrl: string;
  apiHealthUrl: string;
  workspaceServerUrl?: string;
  workspaceId?: string;
  accountId?: string;
  webDevUrl: string;
  packagedWebEntryPath: string;
  appShotShortcut: string;
  clipboardAskShortcut: string;
  quickAskShortcut: string;
  selectionAskShortcut: string;
  windowToggleShortcut: string;
}

export function createDesktopConfig(input: {
  isPackaged: boolean;
  env?: NodeJS.ProcessEnv;
}): DesktopConfig {
  // Vite replaces a direct `process.env` reference while bundling. Resolve the
  // Node runtime object through globalThis so packaged Electron builds keep
  // reading the environment provided at launch time.
  const runtimeProcess = (globalThis as typeof globalThis & {
    process?: { env?: NodeJS.ProcessEnv };
  }).process;
  const env = input.env ?? runtimeProcess?.env ?? {};
  const mode = input.isPackaged && env.SAMURAI_DESKTOP_DEV !== "1" ? "packaged" : "development";
  const apiPort = env.PORT ?? env.SAMURAI_API_PORT ?? "4317";
  const webPort = env.SAMURAI_WEB_PORT ?? "5173";
  const apiBaseUrl = normalizeBaseUrl(env.SAMURAI_DESKTOP_API_URL ?? `http://127.0.0.1:${apiPort}`);
  const webDevUrl = normalizeBaseUrl(env.SAMURAI_DESKTOP_WEB_URL ?? `http://127.0.0.1:${webPort}`);
  const packagedWebEntryPath = env.SAMURAI_DESKTOP_WEB_DIST
    ?? fileURLToPath(new URL("../../web/dist/index.html", import.meta.url));

  return {
    mode,
    apiBaseUrl,
    apiHealthUrl: `${apiBaseUrl}/api/health`,
    ...(env.SAMURAI_DESKTOP_WORKSPACE_SERVER_URL?.trim() ? { workspaceServerUrl: normalizeBaseUrl(env.SAMURAI_DESKTOP_WORKSPACE_SERVER_URL) } : {}),
    ...(env.SAMURAI_DESKTOP_WORKSPACE_ID?.trim() ? { workspaceId: env.SAMURAI_DESKTOP_WORKSPACE_ID.trim() } : {}),
    ...(env.SAMURAI_DESKTOP_ACCOUNT_ID?.trim() ? { accountId: env.SAMURAI_DESKTOP_ACCOUNT_ID.trim() } : {}),
    webDevUrl,
    packagedWebEntryPath,
    appShotShortcut: env.SAMURAI_DESKTOP_APP_SHOT_SHORTCUT ?? "CommandOrControl+Shift+A",
    clipboardAskShortcut: env.SAMURAI_DESKTOP_CLIPBOARD_ASK_SHORTCUT ?? "CommandOrControl+Shift+V",
    quickAskShortcut: env.SAMURAI_DESKTOP_QUICK_ASK_SHORTCUT ?? "CommandOrControl+Shift+Space",
    selectionAskShortcut: env.SAMURAI_DESKTOP_SELECTION_ASK_SHORTCUT ?? "CommandOrControl+Shift+T",
    windowToggleShortcut: env.SAMURAI_DESKTOP_TOGGLE_SHORTCUT ?? "CommandOrControl+Shift+S"
  };
}

export function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/$/, "");
}
