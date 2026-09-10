import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { DesktopWorkspaceConnectionState } from "../lib/api";
import {
  NativeInteractionRequestCard,
  NativeInteractionRequests,
  captureNativeInteractionDraftSnapshot,
  createNativeInteractionBusyGate,
  interactionInputFields,
  interactionInputSchemaSupported,
  interactionRequestCanCancel,
  interactionRequestCanRespond,
  interactionRequestInputValues,
  nativeInteractionDraftAfterResponse,
  nativeInteractionDraftIsDirty,
  nativeInteractionErrorMessage,
  nativeInteractionRequestOperations,
  type NativeInteractionRequest,
  type NativeInteractionRequestsBridge
} from "./NativeInteractionRequests";
import type { NativeWorkspaceTarget } from "./types";

const target: NativeWorkspaceTarget = { connectionId: "connection-a", workspaceId: "workspace-a" };

const request: NativeInteractionRequest = {
  id: "request-1",
  version: 3,
  workspaceId: target.workspaceId,
  roomId: "room-1",
  kind: "approval",
  status: "pending",
  title: "公開前に確認",
  summary: "この変更を公開します。",
  runId: "run-1",
  surfaceId: "surface-1",
  revisionId: "revision-2",
  actionId: "publish",
  targetLabel: "Artifact: report",
  actionTarget: { artifact_id: "artifact-1", revision_id: "revision-2" },
  expiresAt: "2026-09-08T12:00:00.000Z",
  options: [{ id: "publish-now", label: "公開を許可", decision: "approve", description: "Serverに公開操作を依頼します。" }, { id: "keep-private", label: "拒否", decision: "deny" }]
};

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

function acceptedRequest(): NativeInteractionRequest {
  return { ...request, status: "accepted", version: 4, resultSummary: "Serverが受付しました。" };
}

describe("NativeInteractionRequests", () => {
  it("uses the persisted option id and rejects forged or ambiguous options", () => {
    expect(interactionRequestCanRespond(request, { id: "forged", label: "公開を許可", decision: "approve" })).toBe(false);
    expect(interactionRequestCanRespond(request, request.options[0]!)).toBe(true);
    expect(interactionRequestCanRespond({ ...request, status: "accepted" }, request.options[0]!)).toBe(false);
    expect(interactionRequestCanRespond({ ...request, options: [{ id: "same", label: "A", decision: "approve" }, { id: "same", label: "B", decision: "deny" }] }, { id: "same", label: "A", decision: "approve" })).toBe(false);
  });

  it("only allows cancel while the Server request is pending", () => {
    expect(interactionRequestCanCancel(request)).toBe(true);
    expect(interactionRequestCanCancel({ ...request, status: "expired" })).toBe(false);
    expect(interactionRequestCanCancel({ ...request, status: "executing" })).toBe(false);
  });

  it("blocks a second response synchronously until the first request settles", () => {
    const gate = createNativeInteractionBusyGate();
    expect(gate.tryStart(request.id)).toBe(true);
    expect(gate.tryStart(request.id)).toBe(false);
    expect([...gate.snapshot()]).toEqual([request.id]);
    gate.finish(request.id);
    expect(gate.tryStart(request.id)).toBe(true);
    gate.clear();
    expect(gate.snapshot()).toEqual(new Set());
  });

  it("renders unavailable without a target or a bridge, with no local approval path", () => {
    const withoutTarget = renderToStaticMarkup(createElement(NativeInteractionRequests, { roomId: "room-1" }));
    expect(withoutTarget).toContain("Workspace target がないため");
    expect(withoutTarget).not.toContain("公開を許可");

    const withoutBridge = renderToStaticMarkup(createElement(NativeInteractionRequests, { roomId: "room-1", target }));
    expect(withoutBridge).toContain("Serverの確認要求一覧経路が未接続です");
    expect(withoutBridge).not.toContain("confirmed");
  });

  it("guards list, response, and cancel before and after each bridge call", async () => {
    const calls: string[] = [];
    const bridge: NativeInteractionRequestsBridge = {
      listWorkspaceConnections: vi.fn(async () => {
        calls.push("guard");
        return connectionState();
      }),
      listWorkspaceInteractionRequests: vi.fn(async () => {
        calls.push("list");
        return { requests: [request] };
      }),
      respondWorkspaceInteractionRequest: vi.fn(async (input) => {
        calls.push(`respond:${input.optionId}`);
        return { request: acceptedRequest(), replayed: false };
      }),
      cancelWorkspaceInteractionRequest: vi.fn(async () => {
        calls.push("cancel");
        return { request: { ...request, status: "cancelled" as const, version: 4 }, replayed: false };
      })
    };
    const operations = nativeInteractionRequestOperations(bridge, target, request.roomId);
    expect(operations).toBeDefined();

    await operations!.list!();
    await operations!.respond!({ requestId: request.id, expectedVersion: request.version, optionId: "publish-now", operationId: "op-1" });
    await operations!.cancel!({ requestId: request.id, expectedVersion: request.version, operationId: "op-2" });

    expect(calls).toEqual(["guard", "list", "guard", "guard", "respond:publish-now", "guard", "guard", "cancel", "guard"]);
    expect(bridge.respondWorkspaceInteractionRequest).toHaveBeenCalledWith(expect.objectContaining({ optionId: "publish-now" }));
    expect(bridge.respondWorkspaceInteractionRequest).not.toHaveBeenCalledWith(expect.objectContaining({ decision: expect.anything() }));
  });

  it("does not accept a response after navigation changes", async () => {
    let guardCall = 0;
    const bridge: NativeInteractionRequestsBridge = {
      listWorkspaceConnections: vi.fn(async () => {
        guardCall += 1;
        return connectionState(guardCall === 1 ? target.workspaceId : "workspace-b");
      }),
      listWorkspaceInteractionRequests: vi.fn(async () => ({ requests: [request] }))
    };
    const operations = nativeInteractionRequestOperations(bridge, target, request.roomId);
    await expect(operations!.list!()).rejects.toThrow("workspace_navigation_changed");
    expect(bridge.listWorkspaceInteractionRequests).toHaveBeenCalledTimes(1);
  });

  it("renders only a supported server input schema into form controls", () => {
    const inputRequest: NativeInteractionRequest = {
      ...request,
      kind: "backend_input",
      inputSchema: {
        type: "object",
        required: ["reason", "count"],
        properties: {
          reason: { type: "string", title: "理由", description: "Backendへ渡す理由" },
          count: { type: "integer", title: "回数" },
          mode: { enum: ["safe", "fast"], title: "モード" },
          enabled: { type: "boolean", title: "有効" }
        }
      }
    };
    expect(interactionInputSchemaSupported(inputRequest)).toBe(true);
    expect(interactionInputFields(inputRequest).map((field) => field.id)).toEqual(["reason", "count", "mode", "enabled"]);
    const html = renderToStaticMarkup(createElement(NativeInteractionRequestCard, {
      request: inputRequest,
      draft: {},
      busy: false,
      respondAvailable: true,
      cancelAvailable: true,
      onDraftChange: () => undefined,
      onRespond: () => undefined,
      onCancel: () => undefined
    }));
    expect(html).toContain("Serverが宣言した入力");
    expect(html).toContain("理由");
    expect(html).toContain("回数");
    expect(html).toContain("Backendへ渡す理由");
    expect(html).toContain('type="checkbox"');
  });

  it("converts declared JSON form values without sending a decision string", () => {
    const inputRequest: NativeInteractionRequest = {
      ...request,
      kind: "backend_input",
      inputFields: [
        { id: "reason", label: "理由", type: "text", required: true },
        { id: "count", label: "回数", type: "number", valueType: "integer", required: true },
        { id: "enabled", label: "有効", type: "checkbox", valueType: "boolean" }
      ]
    };
    expect(interactionRequestInputValues(inputRequest, { reason: "運用", count: "3", enabled: false })).toEqual({
      supported: true,
      values: { reason: "運用", count: 3, enabled: false }
    });
    expect(interactionRequestInputValues(inputRequest, { reason: "", count: "3" }).error).toContain("理由");
  });

  it("keeps an Interaction draft across a failed save and only clears the submitted snapshot", () => {
    const inputRequest: NativeInteractionRequest = {
      ...request,
      kind: "backend_input",
      inputFields: [{ id: "reason", label: "理由", type: "text", required: true }],
      options: [{ id: "submit", label: "送信", decision: "submit_input" }, { id: "deny", label: "拒否", decision: "deny" }]
    };
    expect(nativeInteractionDraftIsDirty(inputRequest, {})).toBe(false);
    expect(nativeInteractionDraftIsDirty(inputRequest, { reason: "保存前" })).toBe(true);
    expect(nativeInteractionDraftIsDirty(inputRequest, { reason: "" })).toBe(false);

    const snapshot = captureNativeInteractionDraftSnapshot(inputRequest.id, { reason: "保存前" });
    expect(nativeInteractionDraftAfterResponse({ reason: "保存前" }, snapshot)).toBeUndefined();
    expect(nativeInteractionDraftAfterResponse({ reason: "保存中に追加" }, snapshot)).toEqual({ reason: "保存中に追加" });
    expect(nativeInteractionDraftAfterResponse({ reason: "保存前" }, snapshot, false)).toEqual({ reason: "保存前" });
  });

  it("keeps deny independent from the input draft", () => {
    const inputRequest: NativeInteractionRequest = {
      ...request,
      kind: "backend_input",
      inputFields: [{ id: "reason", label: "理由", type: "text", required: true }],
      options: [{ id: "deny", label: "拒否", decision: "deny" }]
    };
    expect(interactionRequestCanRespond(inputRequest, inputRequest.options[0]!)).toBe(true);
    expect(interactionRequestInputValues(inputRequest, { reason: "入力値" })).toEqual({
      supported: true,
      values: { reason: "入力値" }
    });
  });

  it("does not enable a backend action for an unsupported schema", () => {
    const unsupportedRequest = {
      ...request,
      kind: "backend_input" as const,
      inputSchema: { type: "array" } as unknown as NativeInteractionRequest["inputSchema"]
    };
    expect(interactionInputSchemaSupported(unsupportedRequest)).toBe(false);
    const html = renderToStaticMarkup(createElement(NativeInteractionRequestCard, {
      request: unsupportedRequest,
      draft: {},
      busy: false,
      respondAvailable: true,
      cancelAvailable: true,
      onDraftChange: () => undefined,
      onRespond: () => undefined,
      onCancel: () => undefined
    }));
    expect(html).toContain("安全に表示・検証できません");
    expect(html).toContain("disabled");
  });

  it("shows immutable action context and server-owned failure/result state", () => {
    const html = renderToStaticMarkup(createElement(NativeInteractionRequestCard, {
      request: { ...request, status: "failed", failureSummary: "revisionが古いため実行できません。", errorCode: "stale_revision", result: { server: "kept" } },
      draft: {},
      busy: false,
      respondAvailable: true,
      cancelAvailable: true,
      onDraftChange: () => undefined,
      onRespond: () => undefined,
      onCancel: () => undefined
    }));
    expect(html).toContain("room-1");
    expect(html).toContain("run-1");
    expect(html).toContain("surface-1");
    expect(html).toContain("revision-2");
    expect(html).toContain("publish");
    expect(html).toContain("失敗");
    expect(html).toContain("stale_revision");
    expect(html).toContain("Server結果の詳細");
    expect(html).not.toContain("confirmed");
  });

  it("keeps expiry, replay, and navigation errors explicit", () => {
    expect(nativeInteractionErrorMessage(new Error("workspace_interaction_request_expired"))).toContain("期限切れ");
    expect(nativeInteractionErrorMessage(new Error("workspace_interaction_request_already_decided"))).toContain("既に別の応答");
    expect(nativeInteractionErrorMessage(new Error("workspace_navigation_changed"))).toContain("Workspaceが切り替わった");
  });
});
