import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { transpileModule, ModuleKind, ScriptTarget } from "typescript";
import { describe, expect, it } from "vitest";
import { DESKTOP_ARTIFACT_MAX_CONTENT_BYTES, verifyDesktopArtifactContentResponse } from "./artifact-content-boundary.js";

const mainSource = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
const preloadSource = readFileSync(new URL("./preload.cts", import.meta.url), "utf8");

function handlerSource(channel: string): string {
  const marker = `ipcMain.handle("samurai:workspace-server:${channel}"`;
  const start = mainSource.indexOf(marker);
  if (start < 0) throw new Error(`IPC handler not found: ${channel}`);
  const end = mainSource.indexOf("\n  ipcMain.handle(", start + marker.length);
  return mainSource.slice(start, end < 0 ? mainSource.length : end);
}

const artifactContentScope = { workspaceId: "workspace_1", roomId: "room_1", artifactId: "artifact_1" };

function contentHash(bytes: readonly number[]): string {
  return createHash("sha256").update(Buffer.from(bytes)).digest("hex");
}

function artifactContentFixture(kind: "image" | "pdf" = "pdf") {
  const bytes = kind === "pdf"
    ? Array.from(Buffer.from("%PDF-1.7\n\0\xff", "binary"))
    : [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff];
  const mimeType = kind === "pdf" ? "application/pdf" : "image/png";
  const revision = {
    id: "revision_1",
    artifact_id: artifactContentScope.artifactId,
    mime_type: mimeType,
    encoding: "binary",
    content_bytes: bytes.length,
    content_hash: contentHash(bytes)
  };
  return {
    response: {
      workspace_id: artifactContentScope.workspaceId,
      room_id: artifactContentScope.roomId,
      artifact: {
        id: artifactContentScope.artifactId,
        kind,
        metadata: {
          current_revision_id: revision.id,
          content_type: mimeType,
          content_encoding: "binary",
          byte_size: bytes.length,
          content_hash: revision.content_hash
        }
      },
      revision,
      content: "",
      mime_type: mimeType,
      encoding: "binary"
    },
    raw: {
      bytes,
      headers: {
        contentType: mimeType,
        contentLength: String(bytes.length),
        contentEncoding: "binary"
      }
    }
  };
}

function emptyTextFixture() {
  const bytes: number[] = [];
  const hash = contentHash(bytes);
  const revision = {
    id: "revision_empty",
    artifact_id: "artifact_empty",
    mime_type: "text/markdown",
    encoding: "utf8",
    content_bytes: 0,
    content_hash: hash
  };
  return {
    response: {
      workspace_id: "workspace_empty",
      room_id: "room_empty",
      artifact: {
        id: "artifact_empty",
        kind: "markdown",
        metadata: {
          current_revision_id: revision.id,
          content_type: "text/markdown",
          content_encoding: "utf8",
          byte_size: 0,
          content_hash: hash
        }
      },
      revision,
      content: "",
      mime_type: "text/markdown",
      encoding: "utf8"
    },
    raw: {
      bytes,
      headers: { contentType: "text/markdown", contentLength: "0", contentEncoding: "utf8" }
    }
  };
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

  it("uses public v1 management paths and explicitly reads Artifact bytes", () => {
    expect(mainSource).toContain("return `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/completion`");
    expect(mainSource).toContain("return `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/learning`");
    expect(mainSource).toContain("return `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/automation`");
    expect(mainSource).toContain("return `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/settings`");
    expect(mainSource).toContain("function workspaceLegacyCompletionPath");
    expect(handlerSource("completion:knowledge:search")).toContain("workspaceCompletionPath");

    for (const channel of ["artifact:get", "artifact:revision:get"]) {
      const source = handlerSource(channel);
      expect(source).toContain("workspaceV1ArtifactContentPath");
      expect(source).toContain('responseType: "bytes"');
      expect(source).toContain("verifyDesktopArtifactContentResponse");
    }
    expect(mainSource).toContain("function workspaceV1ArtifactContentPath");
    expect(mainSource).toContain("readBoundedWorkspaceArtifactBytes");
    expect(mainSource).toContain("DESKTOP_ARTIFACT_MAX_CONTENT_BYTES");
    expect(mainSource).toContain('response.headers.get("x-content-encoding")');
  });

  it("verifies binary metadata and exposes only the matching raw bytes", () => {
    const fixture = artifactContentFixture("pdf");

    expect(verifyDesktopArtifactContentResponse(fixture.response, fixture.raw, artifactContentScope)).toMatchObject({
      content: "",
      content_bytes: fixture.raw.bytes,
      mime_type: "application/pdf",
      encoding: "binary"
    });
  });

  it("preserves a valid empty text Artifact while rejecting unsafe binary forms", () => {
    const empty = emptyTextFixture();
    expect(verifyDesktopArtifactContentResponse(empty.response, empty.raw, {
      workspaceId: "workspace_empty",
      roomId: "room_empty",
      artifactId: "artifact_empty"
    })).toMatchObject({ content: "", content_bytes: [] });

    const binary = artifactContentFixture("image");
    expect(() => verifyDesktopArtifactContentResponse(
      { ...binary.response, content: Buffer.from(binary.raw.bytes).toString("base64") },
      binary.raw,
      artifactContentScope
    )).toThrow("workspace_artifact_binary_content_text");

    const emptyBinary = artifactContentFixture("pdf");
    emptyBinary.response = {
      ...emptyBinary.response,
      artifact: {
        ...emptyBinary.response.artifact,
        metadata: {
          ...emptyBinary.response.artifact.metadata,
          byte_size: 0,
          content_hash: contentHash([])
        }
      },
      revision: {
        ...emptyBinary.response.revision,
        content_bytes: 0,
        content_hash: contentHash([])
      }
    };
    emptyBinary.raw = {
      bytes: [],
      headers: { contentType: "application/pdf", contentLength: "0", contentEncoding: "binary" }
    };
    expect(() => verifyDesktopArtifactContentResponse(emptyBinary.response, emptyBinary.raw, artifactContentScope))
      .toThrow("workspace_artifact_binary_content_empty");

    const invalidBytes = artifactContentFixture("image");
    invalidBytes.raw = { ...invalidBytes.raw, bytes: [256] };
    expect(() => verifyDesktopArtifactContentResponse(invalidBytes.response, invalidBytes.raw, artifactContentScope))
      .toThrow("workspace_artifact_content_transport_invalid");

    const oversizedBytes: number[] = [];
    oversizedBytes.length = DESKTOP_ARTIFACT_MAX_CONTENT_BYTES + 1;
    const oversized = artifactContentFixture("pdf");
    oversized.raw = {
      bytes: oversizedBytes,
      headers: { contentType: "application/pdf", contentLength: String(oversizedBytes.length), contentEncoding: "binary" }
    };
    expect(() => verifyDesktopArtifactContentResponse(oversized.response, oversized.raw, artifactContentScope))
      .toThrow("workspace_artifact_content_too_large");
  });

  it("rejects byte/hash/Room/revision mismatches before the bridge returns content", () => {
    const fixture = artifactContentFixture("pdf");
    const changedBytes = [...fixture.raw.bytes];
    changedBytes[changedBytes.length - 1] = 0;
    expect(() => verifyDesktopArtifactContentResponse(fixture.response, {
      ...fixture.raw,
      bytes: changedBytes,
      headers: { ...fixture.raw.headers, contentLength: String(changedBytes.length) }
    }, artifactContentScope)).toThrow("workspace_artifact_content_hash_mismatch");

    expect(() => verifyDesktopArtifactContentResponse(fixture.response, fixture.raw, {
      ...artifactContentScope,
      roomId: "room_other"
    })).toThrow("workspace_artifact_content_scope_invalid");

    expect(() => verifyDesktopArtifactContentResponse(fixture.response, fixture.raw, {
      ...artifactContentScope,
      revisionId: "revision_other"
    })).toThrow("workspace_artifact_content_scope_invalid");
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
      expect(source).toContain("captureWorkspaceTargetSnapshot(");
      expect(source).toContain("snapshotWorkspaceDomainApiClient(workspaceSnapshot)");
      expect(source).not.toContain("activeWorkspaceServerRequest(");
    }
    for (const channel of snapshotServerChannels) {
      const source = handlerSource(channel);
      expect(source).toContain("captureWorkspaceTargetSnapshot(");
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
      "assertWorkspaceServerRequestRoom",
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
      () => undefined,
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
    expect(preloadSource).toContain("selectRoomCandidate");
    expect(mainSource).toContain('"room_navigation_changed"');
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
