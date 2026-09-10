import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { stableHash } from "@samurai-agent/core-schemas";
import type { ArtifactDetail, DesktopWorkspaceConnectionState, DesktopWorkspaceInteractionRequest, GeneratedSurfaceDetail } from "../lib/api";
import {
  assertNativeGeneratedSurfaceApprovalResponse,
  clearNativeSurfaceOperationLedger,
  GeneratedSurfaceList,
  nativeArtifactDetailFromApi,
  nativeArtifactWorkspaceGateway,
  nativeArtifactWorkspaceRequestIsCurrent,
  nativeArtifactWorkspaceTargetKey,
  nativeCompletedSurfaceApprovalCompletion,
  nativeGeneratedSurfaceActionCompletion,
  nativeLatestSurfaceApprovalRequest,
  nativeSurfaceApprovalRequestMatches,
  nativeSurfaceApprovalRequestScopeMatches,
  nativeSurfaceApprovalPollScopeIsCurrent,
  nativeGeneratedSurfaceActionInputHash,
  nativeGeneratedSurfaceStateInputHash,
  nativeSurfaceOperationSnapshot,
  nativeSurfaceStateOperationSnapshot,
  operationForNativeSurfaceSnapshot,
  recoverNativeSurfaceActionOperation,
  recoverNativeSurfaceApprovalRequest,
  recoverNativeSurfaceStateOperation,
  runNativeGeneratedSurfaceAction
} from "./NativeArtifactWorkspace";
import type { GeneratedSurfaceActionRequest } from "./GeneratedSurfaceFrame";
import type { WorkspaceOperationHistoryRecord } from "../lib/workspace-browser-bridge";
import {
  nativeSurfaceApprovalTerminalProjection,
  recoveredNativeSurfaceApprovalOperation
} from "./native-generated-surface-operation-recovery";

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
      actionTarget: {
        kind: "generated_surface_action",
        room_id: target.roomId,
        surface_id: surfaceAction.surfaceId,
        revision_id: surfaceAction.revisionId,
        action_id: surfaceAction.actionId,
        payload: surfaceAction.payload
      },
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
    expect(() => nativeArtifactDetailFromApi(artifactDetail({ content_bytes: [999] }))).toThrow("artifact_binary_content_invalid");
    expect(() => nativeArtifactDetailFromApi(artifactDetail({ content_bytes: undefined }))).toThrow("artifact_binary_content_invalid");
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
    expect(listWorkspaceArtifacts).toHaveBeenCalledWith({ roomId: "room-a", target });
  });

  it("uses connection, Workspace, and Room together as its state key", () => {
    expect(nativeArtifactWorkspaceTargetKey(target)).not.toBe(nativeArtifactWorkspaceTargetKey({ ...target, roomId: "room-b" }));
  });

  it("rejects an older Artifact response after its request generation changes", () => {
    expect(nativeArtifactWorkspaceRequestIsCurrent({
      requestGeneration: 2,
      currentGeneration: 3,
      requestedTargetKey: nativeArtifactWorkspaceTargetKey(target),
      currentTargetKey: nativeArtifactWorkspaceTargetKey(target),
      resourceId: "artifact-a",
      currentResourceId: "artifact-a"
    })).toBe(false);
    expect(nativeArtifactWorkspaceRequestIsCurrent({
      requestGeneration: 3,
      currentGeneration: 3,
      requestedTargetKey: nativeArtifactWorkspaceTargetKey(target),
      currentTargetKey: nativeArtifactWorkspaceTargetKey({ ...target, roomId: "room-b" }),
      resourceId: "artifact-a",
      currentResourceId: "artifact-a"
    })).toBe(false);
  });

  it("returns the Server Artifact mutation and preserves its operation ID at the gateway boundary", async () => {
    const artifact = artifactDetail().artifact;
    const revision = {
      id: "revision-a", artifact_id: artifact.id, revision: 2, provenance: {},
      file_ref: { kind: "artifact_revision", id: "revision-a", uri: "artifacts/revisions/a" },
      blob_ref: { kind: "blob", id: "blob-a", uri: "blobs/a" }, content_hash: "hash-a", content_bytes: 3,
      created_at: "2026-09-08T00:00:00.000Z"
    };
    const mutation = { artifact: { ...artifact, metadata: { ...artifact.metadata, current_revision_id: revision.id, current_revision: revision.revision } }, revision, replayed: false };
    const reviseWorkspaceArtifact = vi.fn(async () => mutation);
    const restoreWorkspaceArtifactRevision = vi.fn(async () => mutation);
    const gateway = nativeArtifactWorkspaceGateway({
      listWorkspaceConnections: vi.fn(async () => connectionState()),
      getWorkspaceArtifact: vi.fn(),
      listWorkspaceArtifactRevisions: vi.fn(),
      getWorkspaceArtifactRevision: vi.fn(),
      reviseWorkspaceArtifact,
      restoreWorkspaceArtifactRevision
    }, target);

    const input = { roomId: target.roomId, artifactId: artifact.id, content: "server", baseRevisionId: "revision-old", expectedRevision: 1, changeSummary: "test", operationId: "artifact-operation-fixed" };
    await expect(gateway?.revise(input)).resolves.toMatchObject({ revision: { id: revision.id }, artifact: { id: artifact.id } });
    await expect(gateway?.revise(input)).resolves.toMatchObject({ revision: { id: revision.id } });
    expect(reviseWorkspaceArtifact).toHaveBeenNthCalledWith(1, expect.objectContaining({ operationId: input.operationId }));
    expect(reviseWorkspaceArtifact).toHaveBeenNthCalledWith(2, expect.objectContaining({ operationId: input.operationId }));
    await expect(gateway?.restore({ roomId: target.roomId, artifactId: artifact.id, revisionId: "revision-old", baseRevisionId: "revision-current", expectedRevision: 1, operationId: input.operationId })).resolves.toMatchObject({ revision: { id: revision.id } });
    expect(restoreWorkspaceArtifactRevision).toHaveBeenCalledWith(expect.objectContaining({ operationId: input.operationId }));
  });

  it("reuses one Surface action operation ID for an unchanged retry snapshot", () => {
    const snapshot = nativeSurfaceOperationSnapshot(surfaceAction);
    const first = operationForNativeSurfaceSnapshot(undefined, snapshot);
    expect(operationForNativeSurfaceSnapshot(first, snapshot)).toBe(first);
    expect(operationForNativeSurfaceSnapshot(first, nativeSurfaceOperationSnapshot({ ...surfaceAction, payload: { audience: "internal" } })).operationId).not.toBe(first.operationId);
  });

  it("uses the Server-compatible hash for Surface action and lifecycle recovery", () => {
    const operationId = "surface-state-operation";
    expect(nativeGeneratedSurfaceActionInputHash(target, surfaceAction)).toBe(stableHash({
      room_id: target.roomId,
      surface_id: surfaceAction.surfaceId,
      action_id: surfaceAction.actionId,
      revision_id: surfaceAction.revisionId,
      action_payload: surfaceAction.payload,
      interaction_id: null,
      message_id: null
    }));
    expect(nativeGeneratedSurfaceStateInputHash(target, {
      surfaceId: surfaceAction.surfaceId,
      revisionId: surfaceAction.revisionId,
      action: "pin"
    }, operationId)).toBe(stableHash({
      room_id: target.roomId,
      surface_id: surfaceAction.surfaceId,
      action: "pin",
      interaction_id: `surface_interaction_${stableHash(operationId)}`
    }));
  });

  it("delivers a terminal approval only to its live iframe correlation", () => {
    const liveOperation = {
      snapshot: nativeSurfaceOperationSnapshot(surfaceAction),
      operationId: "surface-operation-live",
      requestId: "server-request-live",
      frameRequestId: "frame-request-live",
      approvalResultChannel: "frame" as const
    };
    const projection = nativeSurfaceApprovalTerminalProjection(liveOperation, surfaceAction, {
      status: "completed",
      result: { saved: true },
      latest: { data: { saved: true } }
    });
    expect(projection).toEqual({
      channel: "frame",
      resolution: {
        requestId: "frame-request-live",
        operationId: "surface-operation-live",
        status: "completed",
        result: { saved: true },
        latest: { data: { saved: true } }
      }
    });

    const recoveredOperation = recoveredNativeSurfaceApprovalOperation(target, surfaceAction, "server-request-recovered");
    const recovered = nativeSurfaceApprovalTerminalProjection(recoveredOperation, surfaceAction, {
      status: "completed",
      result: { saved: true }
    });
    expect(recovered?.channel).toBe("recovery");
  });

  it("recovers the same durable Surface action after a component state restart", async () => {
    const operationId = "surface-operation-persisted";
    const inputHash = nativeGeneratedSurfaceActionInputHash(target, surfaceAction);
    const history: WorkspaceOperationHistoryRecord[] = [
      {
        workspaceId: target.workspaceId,
        roomId: target.roomId,
        recordType: "domain_operation",
        id: operationId,
        version: 2,
        payload: {
          id: operationId,
          operation: "generated_surface.action.run",
          room_id: target.roomId,
          input_hash: inputHash,
          target_resource_refs: [
            { kind: "generated_surface", id: surfaceAction.surfaceId },
            { kind: "generated_surface_revision", id: surfaceAction.revisionId }
          ],
          status: "completed"
        }
      },
      {
        workspaceId: target.workspaceId,
        roomId: target.roomId,
        recordType: "generated_surface_action_result",
        id: operationId,
        version: 1,
        payload: {
          operation_id: operationId,
          operation: "generated_surface.action.run",
          room_id: target.roomId,
          input_hash: inputHash,
          result: {}
        }
      }
    ];
    const listWorkspaceOperationHistory = vi.fn(async ({ recordType }: { recordType: string }) => ({
      records: history.filter((record) => record.recordType === recordType)
    }));
    const bridge = { listWorkspaceOperationHistory };

    const firstComponentState = await recoverNativeSurfaceActionOperation(bridge, target, surfaceAction);
    const restartedComponentState = await recoverNativeSurfaceActionOperation(bridge, target, surfaceAction);

    expect(firstComponentState).toEqual({ snapshot: nativeSurfaceOperationSnapshot(surfaceAction), operationId });
    expect(restartedComponentState).toEqual(firstComponentState);
    expect(listWorkspaceOperationHistory).toHaveBeenCalledWith(expect.objectContaining({ recordType: "domain_operation" }));
  });

  it("recovers a durable Surface state operation and approval request after restart", async () => {
    const stateInput = { surfaceId: "surface-a", revisionId: "revision-a", action: "pin" as const };
    const stateOperationId = "surface-state-persisted";
    const stateInputHash = nativeGeneratedSurfaceStateInputHash(target, stateInput, stateOperationId);
    const approvalOperationId = "surface-approval-persisted";
    const history: WorkspaceOperationHistoryRecord[] = [
      {
        workspaceId: target.workspaceId,
        roomId: target.roomId,
        recordType: "domain_operation",
        id: stateOperationId,
        version: 2,
        payload: {
          operation: "generated_surface.state",
          room_id: target.roomId,
          input_hash: stateInputHash,
          target_resource_refs: [{ kind: "generated_surface", id: stateInput.surfaceId }],
          status: "completed"
        }
      },
      {
        workspaceId: target.workspaceId,
        roomId: target.roomId,
        recordType: "surface_interaction",
        id: "surface-interaction-persisted",
        version: 1,
        payload: {
          domain_operation_id: stateOperationId,
          kind: "pinned",
          surface_id: stateInput.surfaceId,
          revision_id: stateInput.revisionId
        }
      },
      {
        workspaceId: target.workspaceId,
        roomId: target.roomId,
        recordType: "generated_surface_operation_result",
        id: stateOperationId,
        version: 1,
        payload: {
          operation_id: stateOperationId,
          operation: "generated_surface.state",
          room_id: target.roomId,
          input_hash: stateInputHash,
          resource: {}
        }
      },
      {
        workspaceId: target.workspaceId,
        roomId: target.roomId,
        recordType: "interaction_request",
        id: "interaction-request-persisted",
        version: 1,
        payload: {
          kind: "approval",
          room_id: target.roomId,
          surface_id: surfaceAction.surfaceId,
          revision_id: surfaceAction.revisionId,
          status: "pending",
          operation_id: approvalOperationId,
          action_target: {
            kind: "generated_surface_action",
            room_id: target.roomId,
            surface_id: surfaceAction.surfaceId,
            revision_id: surfaceAction.revisionId,
            action_id: surfaceAction.actionId,
            payload: surfaceAction.payload
          }
        }
      }
    ];
    const listWorkspaceOperationHistory = vi.fn(async ({ recordType }: { recordType: string }) => ({
      records: history.filter((record) => record.recordType === recordType)
    }));
    const bridge = { listWorkspaceOperationHistory };

    const stateAfterRestart = await recoverNativeSurfaceStateOperation(bridge, target, stateInput);
    const approvalAfterRestart = await recoverNativeSurfaceApprovalRequest(bridge, target, surfaceAction);

    expect(stateAfterRestart?.operationId).toBe(stateOperationId);
    expect(approvalAfterRestart).toEqual({ requestId: "interaction-request-persisted", status: "pending", operationId: approvalOperationId });
  });

  it("reuses an approval request only when the durable payload is exactly the same", () => {
    const request = approvalResponse().request as unknown as DesktopWorkspaceInteractionRequest;
    expect(nativeSurfaceApprovalRequestScopeMatches(request, target, surfaceAction)).toBe(true);
    expect(nativeSurfaceApprovalRequestMatches(request, target, surfaceAction)).toBe(true);
    expect(nativeSurfaceApprovalRequestMatches(request, target, {
      ...surfaceAction,
      payload: { audience: "internal" }
    })).toBe(false);
  });

  it("projects only the newest durable approval into the current Surface frame", () => {
    const olderCompleted = approvalResponse({
      id: "request-old-completed",
      status: "completed",
      updatedAt: "2026-09-10T04:26:19.000Z"
    }).request as unknown as DesktopWorkspaceInteractionRequest;
    const newestPending = approvalResponse({
      id: "request-new-pending",
      status: "pending",
      updatedAt: "2026-09-10T05:18:00.000Z"
    }).request as unknown as DesktopWorkspaceInteractionRequest;

    expect(nativeLatestSurfaceApprovalRequest([olderCompleted, newestPending], target, {
      surfaceId: surfaceAction.surfaceId,
      revisionId: surfaceAction.revisionId,
      actionIds: new Set([surfaceAction.actionId])
    })).toBe(newestPending);
  });

  it("does not apply a delayed approval poll after the Surface closes and reopens", async () => {
    const pollScope = {
      generation: 4,
      targetKey: nativeArtifactWorkspaceTargetKey(target),
      surfaceViewKey: `${surfaceAction.surfaceId}\n${surfaceAction.revisionId}`
    };
    let currentScope = pollScope;
    let resolveDelayedResult: (() => void) | undefined;
    const delayedResult = new Promise<void>((resolve) => { resolveDelayedResult = resolve; });
    let applied = false;
    const poll = async (): Promise<void> => {
      await delayedResult;
      if (nativeSurfaceApprovalPollScopeIsCurrent(pollScope, currentScope)) applied = true;
    };

    const pendingPoll = poll();
    currentScope = { ...pollScope, generation: pollScope.generation + 1 };
    resolveDelayedResult?.();
    await pendingPoll;

    expect(applied).toBe(false);
  });

  it("projects only the exact completed durable approval result", () => {
    const completed = approvalResponse({ status: "completed" }).request as unknown as DesktopWorkspaceInteractionRequest;
    const response = { request: completed, targetResult: { saved: true } };
    expect(nativeCompletedSurfaceApprovalCompletion(response, target, surfaceAction, completed.id, "frame-operation"))
      .toEqual({ operationId: "frame-operation", result: { saved: true } });
    expect(nativeCompletedSurfaceApprovalCompletion(
      { request: { ...completed, status: "pending" }, targetResult: { saved: true } },
      target,
      surfaceAction,
      completed.id,
      "frame-operation"
    )).toBeUndefined();
    expect(() => nativeCompletedSurfaceApprovalCompletion(
      { request: { ...completed, id: "other-request" }, targetResult: { saved: true } },
      target,
      surfaceAction,
      completed.id,
      "frame-operation"
    )).toThrow("generated_surface_approval_result_scope_invalid");
  });

  it("reuses one Surface state operation ID for an unchanged retry", () => {
    const snapshot = nativeSurfaceStateOperationSnapshot({ surfaceId: "surface-a", revisionId: "revision-a", action: "pin" });
    const first = operationForNativeSurfaceSnapshot(undefined, snapshot);
    expect(operationForNativeSurfaceSnapshot(first, snapshot)).toBe(first);
    expect(operationForNativeSurfaceSnapshot(first, nativeSurfaceStateOperationSnapshot({ surfaceId: "surface-a", revisionId: "revision-a", action: "archive" })).operationId).not.toBe(first.operationId);
  });

  it("clears only the completed Surface operation and keeps a newer ledger entry", () => {
    const ledger = new Map<string, { snapshot: string; operationId: string }>();
    const first = { snapshot: "same", operationId: "operation-first" };
    const newer = { snapshot: "same", operationId: "operation-newer" };
    ledger.set("surface-key", newer);
    clearNativeSurfaceOperationLedger(ledger, "surface-key", first);
    expect(ledger.get("surface-key")).toBe(newer);
    clearNativeSurfaceOperationLedger(ledger, "surface-key", newer);
    expect(ledger.has("surface-key")).toBe(false);
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
      operationId: expect.any(String),
      target
    });
    const [call] = runWorkspaceGeneratedSurfaceAction.mock.calls as unknown as [Record<string, unknown>];
    expect(call).not.toHaveProperty("confirmed");
    expect(listWorkspaceConnections).toHaveBeenCalledTimes(2);
  });

  it("passes an explicit retry operation ID unchanged to the Surface action bridge", async () => {
    const listWorkspaceConnections = vi.fn(async () => connectionState());
    const runWorkspaceGeneratedSurfaceAction = vi.fn(async () => ({ result: { saved: true } }));

    await runNativeGeneratedSurfaceAction({ listWorkspaceConnections, runWorkspaceGeneratedSurfaceAction }, target, surfaceAction, "surface-operation-fixed");
    expect(runWorkspaceGeneratedSurfaceAction).toHaveBeenCalledWith(expect.objectContaining({ operationId: "surface-operation-fixed" }));
  });

  it("projects the authoritative action result and refreshed Surface into the frame completion", () => {
    const latest = {
      surface: {
        id: surfaceAction.surfaceId,
        state: "pinned",
        title: "Updated surface",
        input_data_schema: {},
        actions: [],
        capability_manifest: { allowed_domain_commands: [], network_access: "none", workspace_write: "domain_commands_only" },
        source_refs: [],
        content_hash: "hash-updated",
        current_revision_id: surfaceAction.revisionId,
        current_revision: 2,
        preview_url: "/surface",
        fallback_chain: ["artifact", "text"],
        created_at: "2026-09-08T00:00:00.000Z",
        updated_at: "2026-09-08T00:01:00.000Z"
      },
      revisions: [],
      interactions: []
    } satisfies GeneratedSurfaceDetail;

    expect(nativeGeneratedSurfaceActionCompletion({
      surface: {},
      action: {},
      command: { result: {} },
      interaction: {},
      target_result: { saved: true, count: 2 }
    }, "surface-operation-fixed", latest)).toEqual({
      operationId: "surface-operation-fixed",
      result: { saved: true, count: 2 },
      latest: { surface: latest.surface, data: { saved: true, count: 2 } }
    });
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
