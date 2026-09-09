import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const mainSource = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
const preloadSource = readFileSync(new URL("./preload.cts", import.meta.url), "utf8");

describe("Desktop Artifact and Generated Surface bridge wiring", () => {
  it("keeps revision and surface operations on explicit IPC names", () => {
    for (const channel of [
      "artifact:revisions:list",
      "artifact:revision:get",
      "artifact:revise",
      "artifact:restore",
      "generated-surface:list",
      "generated-surface:create",
      "generated-surface:revise"
    ]) {
      expect(mainSource).toContain(`samurai:workspace-server:${channel}`);
    }
    expect(mainSource).toContain("activeWorkspaceV1ArtifactsPath()");
    expect(mainSource).toContain("activeWorkspaceV1GeneratedSurfacesPath()");
  });

  it("routes Artifact creation through the v1 Domain API", () => {
    const start = mainSource.indexOf('ipcMain.handle("samurai:workspace-server:artifact:create"');
    const end = mainSource.indexOf('ipcMain.handle("samurai:workspace-server:artifact:surface"', start);
    const source = mainSource.slice(start, end);
    expect(source).toContain('executeOperation<Record<string, unknown>>');
    expect(source).not.toContain("activeWorkspaceArtifactsPath()");
  });

  it("publishes the same explicit names through preload", () => {
    expect(preloadSource).toContain("listWorkspaceArtifactRevisions");
    expect(preloadSource).toContain("getWorkspaceArtifactRevision");
    expect(preloadSource).toContain("reviseWorkspaceArtifact");
    expect(preloadSource).toContain("restoreWorkspaceArtifactRevision");
    expect(preloadSource).toContain("listWorkspaceGeneratedSurfaces");
    expect(preloadSource).toContain("queryWorkspaceGeneratedSurface");
    expect(preloadSource).toContain("runWorkspaceGeneratedSurfaceAction");
    expect(preloadSource).toContain("runWorkspaceGeneratedSurfaceState");
    expect(preloadSource).toContain("exportWorkspaceGeneratedSurface");
  });

  it("wires durable Interaction Requests through fixed signed IPC routes", () => {
    for (const channel of ["interaction-requests:list", "interaction-requests:respond", "interaction-requests:cancel"]) {
      expect(mainSource).toContain(`samurai:workspace-server:${channel}`);
      expect(preloadSource).toContain(`samurai:workspace-server:${channel}`);
    }
    expect(mainSource).toContain("assertWorkspaceInteractionIpcSender(event)");
    expect(mainSource).toContain("workspaceInteractionRequestsPath(workspaceSnapshot.workspaceId)");
    expect(preloadSource).toContain("sanitizeWorkspaceInteractionRequestListInput");
    expect(preloadSource).toContain("sanitizeWorkspaceInteractionRequestRespondInput");
    expect(preloadSource).toContain("sanitizeWorkspaceInteractionRequestCancelInput");
  });

  it("does not publish the legacy Generated Surface confirmed flag", () => {
    const start = mainSource.indexOf('ipcMain.handle("samurai:workspace-server:generated-surface:action"');
    const end = mainSource.indexOf('ipcMain.handle("samurai:workspace-server:interaction-requests:list"', start);
    expect(mainSource.slice(start, end)).not.toContain("confirmed");
    expect(preloadSource).not.toContain("confirmed");
  });

  it("keeps Room Work resource selectors separate from file attachments", () => {
    const createStart = mainSource.indexOf('ipcMain.handle("samurai:workspace-server:room-work:create"');
    const replyStart = mainSource.indexOf('ipcMain.handle("samurai:workspace-server:room-work:reply"');
    expect(mainSource.slice(createStart, replyStart)).toContain("resource_refs: resourceRefs");
    expect(mainSource.slice(replyStart, mainSource.indexOf('ipcMain.handle("samurai:workspace-server:room-work:comment:create"', replyStart))).toContain("resource_refs: resourceRefs");
    expect(mainSource).toContain("PublicRoomWorkResourceRefSchema");
    expect(preloadSource).toContain("sanitizeWorkspaceRoomWorkResourceRefs");
    expect(preloadSource).toContain("value.resourceRefs");
    expect(mainSource).toContain('"resource_refs"');
    expect(mainSource).toContain("sanitizeRoomWorkResourceRefs");
  });
});
