import { readFileSync } from "node:fs";
import { transpileModule, ModuleKind, ScriptTarget } from "typescript";
import { describe, expect, it } from "vitest";

const mainSource = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
const preloadSource = readFileSync(new URL("./preload.cts", import.meta.url), "utf8");

function handlerSource(channel: string): string {
  const marker = `ipcMain.handle("samurai:workspace-server:${channel}"`;
  const start = mainSource.indexOf(marker);
  if (start < 0) throw new Error(`IPC handler not found: ${channel}`);
  const end = mainSource.indexOf("\n  ipcMain.handle(", start + marker.length);
  return mainSource.slice(start, end < 0 ? mainSource.length : end);
}

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

  it("pins every Artifact, Generated Surface, and Interaction IPC handler to one request target", () => {
    const snapshotDomainApiChannels = [
      "artifacts:list",
      "artifact:get",
      "artifact:revisions:list",
      "artifact:revision:get",
      "artifact:create",
      "artifact:revise",
      "artifact:restore",
      "generated-surface:list",
      "generated-surface:create",
      "generated-surface:revise"
    ];
    const snapshotServerChannels = [
      "artifact:surface",
      "generated-surface:get",
      "generated-surface:bundle",
      "generated-surface:action",
      "generated-surface:state",
      "generated-surface:export",
      "interaction-requests:list",
      "interaction-requests:respond",
      "interaction-requests:cancel"
    ];

    for (const channel of snapshotDomainApiChannels) {
      const source = handlerSource(channel);
      expect(source).toContain("captureActiveWorkspaceSnapshot()");
      expect(source).toContain("snapshotWorkspaceDomainApiClient(workspaceSnapshot)");
      expect(source).not.toContain("activeWorkspaceServerRequest(");
    }
    for (const channel of snapshotServerChannels) {
      const source = handlerSource(channel);
      expect(source).toContain("captureActiveWorkspaceSnapshot()");
      expect(source).toContain("snapshotWorkspaceServerRequest(workspaceSnapshot");
      expect(source).not.toContain("activeWorkspaceServerRequest(");
    }

    expect(mainSource).toContain("workspaceV1ArtifactsPath(workspaceSnapshot.workspaceId)");
    expect(mainSource).toContain("workspaceV1GeneratedSurfacesPath(workspaceSnapshot.workspaceId)");
  });

  it("rejects a Workspace/Server switch before a snapshot request can send", async () => {
    const start = mainSource.indexOf("async function snapshotWorkspaceServerRequest(");
    const end = mainSource.indexOf("\nfunction sanitizeDesktopInteractionListResponse", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);

    const runnableSource = transpileModule(mainSource.slice(start, end), {
      compilerOptions: { module: ModuleKind.None, target: ScriptTarget.ES2022 }
    }).outputText;
    const oldTarget = { connectionId: "connection-a", workspaceId: "workspace-a" };
    const newTarget = { connectionId: "connection-b", workspaceId: "workspace-b" };
    const oldConnection = { id: oldTarget.connectionId };
    const newConnection = { id: newTarget.connectionId };
    const registry = { connections: [oldConnection, newConnection] };
    let currentTarget = oldTarget;
    let currentGeneration = 1;
    let keyRequested = false;
    let releasePrivateKey!: () => void;
    const privateKeyReady = new Promise<void>((resolve) => {
      releasePrivateKey = resolve;
    });
    const sent: Array<{ connectionId: string; workspaceId?: string; roomId?: string }> = [];

    const snapshotWorkspaceServerRequest = new Function(
      "workspaceConnectionRegistry",
      "workspaceIdForConnection",
      "assertActiveWorkspaceSnapshot",
      "requireActiveWorkspacePrivateKey",
      "signedWorkspaceServerRequest",
      "assertWorkspaceServerSuccess",
      `${runnableSource}; return snapshotWorkspaceServerRequest;`
    )(
      registry,
      (connection: { id: string }) => connection.id === currentTarget.connectionId ? currentTarget.workspaceId : undefined,
      (snapshot: { connectionId: string; workspaceId: string; selectionGeneration: number }) => {
        if (snapshot.connectionId !== currentTarget.connectionId
          || snapshot.workspaceId !== currentTarget.workspaceId
          || snapshot.selectionGeneration !== currentGeneration) {
          throw new Error("workspace_navigation_changed");
        }
      },
      async (connection: { id: string }) => {
        keyRequested = true;
        await privateKeyReady;
        return `private-key-for-${connection.id}`;
      },
      async (connection: { id: string }, _privateKey: string, input: { workspaceId?: string; body?: { room_id?: string } }) => {
        sent.push({ connectionId: connection.id, workspaceId: input.workspaceId, roomId: input.body?.room_id });
        return { status: 200, body: { ok: true } };
      },
      () => undefined
    ) as (snapshot: { connectionId: string; workspaceId: string; selectionGeneration: number }, input: {
      method: "POST";
      path: string;
      workspaceScoped: true;
      body: { room_id: string };
    }) => Promise<unknown>;

    const request = snapshotWorkspaceServerRequest(
      { ...oldTarget, selectionGeneration: 1 },
      {
        method: "POST",
        path: "/api/v1/workspaces/workspace-a/generated-surfaces/surface-a/actions/action-a/run?room_id=room-a",
        workspaceScoped: true,
        body: { room_id: "room-a" }
      }
    );
    while (!keyRequested) await Promise.resolve();
    currentTarget = newTarget;
    currentGeneration = 2;
    releasePrivateKey();

    await expect(request).rejects.toThrow("workspace_navigation_changed");
    expect(sent).toEqual([]);
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
