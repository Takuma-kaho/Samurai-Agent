import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const mainSource = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
const preloadSource = readFileSync(new URL("./preload.cts", import.meta.url), "utf8");

describe("Desktop standalone Workspace Bundle bridge", () => {
  it("registers standalone IPC handlers separately from Organization handlers", () => {
    expect(mainSource).toContain('ipcMain.handle("samurai:workspace-server:bundle:export"');
    expect(mainSource).toContain('ipcMain.handle("samurai:workspace-server:bundle:restore"');
    expect(mainSource).toContain("workspaceStandaloneBundleExportRequest(input)");
    expect(mainSource).toContain("workspaceStandaloneBundleRestoreRequest(input)");
    expect(mainSource).toContain('ipcMain.handle("samurai:workspace-server:organization:bundle:export"');
    expect(mainSource).toContain('ipcMain.handle("samurai:workspace-server:organization:bundle:restore"');
  });

  it("exposes only sanitized standalone Bundle references to the renderer", () => {
    expect(preloadSource).toContain('sanitizeWorkspaceBundleExportInput(input)');
    expect(preloadSource).toContain('sanitizeWorkspaceBundleRestoreInput(input)');
    expect(preloadSource).not.toContain('ipcRenderer.invoke("samurai:workspace-server:bundle:export", input)');
    expect(preloadSource).not.toContain('ipcRenderer.invoke("samurai:workspace-server:bundle:restore", input)');
  });
});
