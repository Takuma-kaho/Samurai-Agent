import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ArtifactDetail, DesktopWorkspaceConnectionState } from "../lib/api";
import {
  assertNativeGeneratedSurfaceApprovalResponse,
  GeneratedSurfaceList,
  nativeArtifactDetailFromApi,
  nativeArtifactWorkspaceGateway,
  nativeArtifactWorkspaceTargetKey,
  runNativeGeneratedSurfaceAction
} from "./NativeArtifactWorkspace";
import type { GeneratedSurfaceActionRequest } from "./GeneratedSurfaceFrame";

const target = { connectionId: "connection-a", workspaceId: "workspace-a", roomId: "room-a" };
const surfaceAction: GeneratedSurfaceActionRequest = {
  surfaceId: "surface-a",
  revisionId: "revision-a",
  actionId: "publish",
  payload: { audience: "public" }
};

function approvalResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: "approval_required",
    request: {
      id: "request-a",
      workspaceId: target.workspaceId,
      roomId: target.roomId,
      kind: "approval",
      status: "pending",
      surfaceId: surfaceAction.surfaceId,
      revisionId: surfaceAction.revisionId,
      ...overrides
    }
  };
}

function connectionState(workspaceId = target.workspaceId): DesktopWorkspaceConnectionState {
  return {
    activeConnectionId: target.connectionId,
    connections: [{
      id: target.connectionId,
      label: "Test Server",
      serverUrl: "http://127.0.0.1:4318",
      workspaceId,
      accountId: "account-a",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    }]
  };
}

function artifactDetail(overrides: Partial<ArtifactDetail> = {}): ArtifactDetail {
  return {
    artifact: {
      id: "artifact-a", title: "Binary", kind: "image", locale: "ja", source_locales: ["ja"],
      file_ref: { kind: "artifact", id: "artifact-a", uri: "artifacts/a.png" }, metadata: {}, source_operation_id: "operation-a", created_by: "account-a",
      created_at: "2026-09-08T00:00:00.000Z", updated_at: "2026-09-08T00:00:00.000Z"
    },
    content: "",
    content_bytes: [1, 2, 3],
    mime_type: "image/png",
    encoding: "binary",
    auditRecords: [],
    ...overrides
  };
}

describe("NativeArtifactWorkspace", () => {
  it("keeps binary bytes out of text rendering and converts only valid bytes at the boundary", () => {
    expect(nativeArtifactDetailFromApi(artifactDetail())).toMatchObject({ content: "AQID", contentEncoding: "base64", contentType: "image/png" });
    expect(nativeArtifactDetailFromApi(artifactDetail({ content_bytes: [999] }))).toMatchObject({ content: "", contentEncoding: "base64" });
  });

  it("rejects an Artifact request after the active Workspace changes", async () => {
    const listWorkspaceConnections = vi.fn()
      .mockResolvedValueOnce({ activeConnectionId: "connection-a", connections: [{ id: "connection-a", workspaceId: "workspace-a" }] })
      .mockResolvedValueOnce({ activeConnectionId: "connection-b", connections: [{ id: "connection-b", workspaceId: "workspace-b" }] });
    const listWorkspaceArtifacts = vi.fn(async () => ({ artifacts: [] }));
    const gateway = nativeArtifactWorkspaceGateway({
      listWorkspaceConnections,
      listWorkspaceArtifacts,
      getWorkspaceArtifact: vi.fn(),
      listWorkspaceArtifactRevisions: vi.fn(),
      getWorkspaceArtifactRevision: vi.fn(),
      reviseWorkspaceArtifact: vi.fn(),
      restoreWorkspaceArtifactRevision: vi.fn()
    }, target);

    await expect(gateway?.list("room-a")).rejects.toThrow("workspace_navigation_changed");
    expect(listWorkspaceArtifacts).toHaveBeenCalledWith({ roomId: "room-a" });
  });

  it("uses connection, Workspace, and Room together as its state key", () => {
    expect(nativeArtifactWorkspaceTargetKey(target)).not.toBe(nativeArtifactWorkspaceTargetKey({ ...target, roomId: "room-b" }));
  });

  it("keeps an unpinned saved Surface reopenable from its Room", () => {
    const html = renderToStaticMarkup(createElement(GeneratedSurfaceList, {
      supported: true,
      loading: false,
      surfaces: [{
        id: "surface-a",
        state: "ephemeral",
        title: "未ピン留めの分析画面",
        input_data_schema: {},
        actions: [],
        capability_manifest: { allowed_domain_commands: [], network_access: "none", workspace_write: "domain_commands_only" },
        source_refs: [],
        content_hash: "hash-a",
        current_revision_id: "revision-a",
        current_revision: 2,
        preview_url: "/not-a-session-route",
        fallback_chain: ["artifact", "text"],
        created_at: "2026-09-08T00:00:00.000Z",
        updated_at: "2026-09-08T00:00:00.000Z"
      }],
      onRefresh: vi.fn(),
      onOpen: vi.fn()
    }));

    expect(html).toContain("未ピン留めの分析画面");
    expect(html).toContain("保存済み · revision 2");
    expect(html).toContain(">開く<");
    expect(html).not.toContain("session");
  });

  it("creates a durable approval request through the guarded Surface action bridge", async () => {
    const listWorkspaceConnections = vi.fn(async () => connectionState());
    const runWorkspaceGeneratedSurfaceAction = vi.fn(async () => approvalResponse());

    await expect(runNativeGeneratedSurfaceAction({ listWorkspaceConnections, runWorkspaceGeneratedSurfaceAction }, target, surfaceAction)).resolves.toMatchObject({ status: "approval_required" });
    expect(runWorkspaceGeneratedSurfaceAction).toHaveBeenCalledWith({
      roomId: target.roomId,
      surfaceId: surfaceAction.surfaceId,
      actionId: surfaceAction.actionId,
      revisionId: surfaceAction.revisionId,
      actionPayload: surfaceAction.payload,
      operationId: expect.any(String)
    });
    const [call] = runWorkspaceGeneratedSurfaceAction.mock.calls as unknown as [Record<string, unknown>];
    expect(call).not.toHaveProperty("confirmed");
    expect(listWorkspaceConnections).toHaveBeenCalledTimes(2);
  });

  it("accepts only the Server approval envelope and rejects ordinary action success", () => {
    expect(() => assertNativeGeneratedSurfaceApprovalResponse(approvalResponse(), target, surfaceAction)).not.toThrow();
    expect(() => assertNativeGeneratedSurfaceApprovalResponse({ result: { saved: true } }, target, surfaceAction)).toThrow("generated_surface_approval_response_invalid");
    expect(() => assertNativeGeneratedSurfaceApprovalResponse(approvalResponse({ roomId: "room-other" }), target, surfaceAction)).toThrow("generated_surface_approval_request_invalid");
  });

  it("applies the navigation target guard to approval requests after the bridge call", async () => {
    let guardCall = 0;
    const listWorkspaceConnections = vi.fn(async () => {
      guardCall += 1;
      return connectionState(guardCall === 1 ? target.workspaceId : "workspace-b");
    });
    const runWorkspaceGeneratedSurfaceAction = vi.fn(async () => approvalResponse());

    await expect(runNativeGeneratedSurfaceAction({ listWorkspaceConnections, runWorkspaceGeneratedSurfaceAction }, target, surfaceAction)).rejects.toThrow("workspace_navigation_changed");
    expect(runWorkspaceGeneratedSurfaceAction).toHaveBeenCalledTimes(1);
  });
});
