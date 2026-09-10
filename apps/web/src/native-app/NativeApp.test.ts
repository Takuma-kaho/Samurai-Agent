import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AgentDirectoryPanel, appendNativeRoomWorkResourceRef, artifactRevisionRequestDraft, createNativeDraftNavigationControllerRegistry, CreateDialog, nativeRoomResultResourceTarget, nativeRoomToolTarget, NativeRoomToolLinks, nativeRoomWorkResourceDraftKey, patchAgentEditorState } from "./NativeApp";
import { createNativeDraftNavigationController } from "./use-native-draft-navigation";
import type { ArtifactRevisionTarget } from "./ArtifactSurfacePanel";

describe("Native draft navigation controller registry", () => {
  it("detaches only its own instance and restores the underlying controller", () => {
    const registry = createNativeDraftNavigationControllerRegistry();
    const first = createNativeDraftNavigationController({ scopeKey: "room-a", label: "成果物", dirty: true, saving: false });
    const second = createNativeDraftNavigationController({ scopeKey: "connection-settings", label: "接続設定", dirty: true, saving: false });
    const detachFirst = registry.register(first);
    const detachSecond = registry.register(second);

    detachFirst();
    expect(registry.getCurrent()).toBe(second);

    detachSecond();
    expect(registry.getCurrent()).toBeUndefined();

    const underlyingDetach = registry.register(first);
    const overlayDetach = registry.register(second);
    overlayDetach();
    expect(registry.getCurrent()).toBe(first);
    underlyingDetach();
    expect(registry.getCurrent()).toBeUndefined();
  });
});

describe("Native Agent editor state", () => {
  it("applies captured field values without reading a SyntheticEvent in the updater", () => {
    const current = {
      mode: "create" as const,
      name: "旧名",
      role: "役割",
      instructions: "指示",
      enabled: true,
      backendId: "samurai-native"
    };

    expect(patchAgentEditorState(current, { name: "新しい名前" })).toEqual({ ...current, name: "新しい名前" });
    expect(patchAgentEditorState(current, { enabled: false })).toEqual({ ...current, enabled: false });
    expect(patchAgentEditorState(undefined, { name: "入力" })).toBeUndefined();
  });
});

describe("Artifact revision request draft", () => {
  it("returns the selected revision and location to the existing Room Work draft", () => {
    const draft = artifactRevisionRequestDraft({
      artifact: { id: "artifact_spec", title: "公開仕様" } as ArtifactRevisionTarget["artifact"],
      revisionId: "artifact_revision_4",
      sourceWorkId: "work_origin",
      location: { kind: "table_cell", rowId: "row_auth", columnId: "owner", value: "運用チーム" },
      request: "担当者を更新してください。"
    });

    expect(draft).toContain("[成果物の修正依頼]");
    expect(draft).toContain("artifact_spec");
    expect(draft).toContain("artifact_revision_4");
    expect(draft).toContain("元の仕事: work_origin");
    expect(draft).toContain("行 row_auth / 列 owner");
    expect(draft).toContain("担当者を更新してください。");
  });
});

describe("Room Work Knowledge/Skill draft refs", () => {
  it("keys drafts by the selected Server, Workspace, Room, and reply target", () => {
    expect(nativeRoomWorkResourceDraftKey({ connectionId: "connection_a", workspaceId: "workspace_a" }, "room_a", undefined))
      .toBe("connection_a\nworkspace_a\nroom_a\nnew");
    expect(nativeRoomWorkResourceDraftKey({ connectionId: "connection_a", workspaceId: "workspace_a" }, "room_a", "work_a"))
      .toBe("connection_a\nworkspace_a\nroom_a\nwork_a");
    expect(nativeRoomWorkResourceDraftKey(undefined, "room_a", "work_a")).toBeUndefined();
  });

  it("deduplicates a selected immutable Knowledge/Skill version and rejects malformed values", () => {
    const first = appendNativeRoomWorkResourceRef([], { kind: "knowledge", id: "knowledge_policy", version: 3, label: "公開方針" });
    expect(first).toEqual([{ kind: "knowledge", id: "knowledge_policy", version: 3, label: "公開方針" }]);
    expect(appendNativeRoomWorkResourceRef(first, { kind: "knowledge", id: "knowledge_policy", version: 3, label: "別名" })).toEqual(first);
    expect(appendNativeRoomWorkResourceRef(first, { kind: "skill", id: "skill_review", version: 1 })).toHaveLength(2);
    expect(appendNativeRoomWorkResourceRef(first, { kind: "knowledge", id: "../outside", version: 3 })).toEqual(first);
  });
});

describe("Native Room tool entry", () => {
  const target = { connectionId: "connection_a", workspaceId: "workspace_a" };
  const room = { id: "room_a", workspaceId: "workspace_a" };

  it("renders the confirmation entry together with the existing Room tools", () => {
    const markup = renderToStaticMarkup(createElement(NativeRoomToolLinks, {
      target: nativeRoomToolTarget(target, room),
      onOpen: vi.fn()
    }));

    expect(markup).toContain("確認待ち");
    expect(markup).toContain("知識・検索・設定");
    expect(markup).toContain("Room管理");
    expect(markup).toContain("成果物・操作画面");
    expect(markup).toContain("Collection");
  });

  it("binds the tool target to the selected Workspace and Room", () => {
    expect(nativeRoomToolTarget(target, room)).toEqual({ ...target, roomId: room.id });
    expect(nativeRoomToolTarget(target, { ...room, workspaceId: "workspace_other" })).toBeUndefined();
    expect(nativeRoomToolTarget(undefined, room)).toBeUndefined();
    expect(renderToStaticMarkup(createElement(NativeRoomToolLinks, { onOpen: vi.fn() }))).toBe("");
  });

  it("binds a result card to the current target and rejects a stale Room", () => {
    expect(nativeRoomResultResourceTarget(target, room, {
      kind: "artifact",
      id: "artifact_plan",
      uri: "artifacts/artifact_plan/revisions/1.md"
    })).toEqual({
      kind: "artifact",
      id: "artifact_plan",
      uri: "artifacts/artifact_plan/revisions/1.md",
      connectionId: "connection_a",
      workspaceId: "workspace_a",
      roomId: "room_a"
    });
    expect(nativeRoomResultResourceTarget(target, room, {
      kind: "artifact",
      id: "artifact_plan",
      uri: "artifacts/artifact_plan/revisions/1.md",
      roomId: "room_other"
    })).toBeUndefined();
  });
});

describe("Native Room creation dialog", () => {
  it("offers an existing active Agent and does not expose instructions", () => {
    const markup = renderToStaticMarkup(createElement(CreateDialog, {
      kind: "room",
      onClose: vi.fn(),
      onSubmit: vi.fn(),
      agents: [{ id: "agent_research", displayName: "Research Agent", backendId: "samurai-native", enabled: true, status: "active", version: 3 }],
      agentBackends: [{ id: "samurai-native", label: "Samurai Native", configured: true, enabled: true, connectionState: "ready" }]
    }));

    expect(markup).toContain("既存Agentを選ぶ");
    expect(markup).toContain("Research Agent");
    expect(markup).toContain("Room権限");
    expect(markup).not.toContain("must-not-reach-renderer");
  });

  it("offers the new Agent flow and backend selection when no Agent exists", () => {
    const markup = renderToStaticMarkup(createElement(CreateDialog, {
      kind: "room",
      onClose: vi.fn(),
      onSubmit: vi.fn(),
      agents: [],
      agentBackends: [{ id: "samurai-native", label: "Samurai Native", configured: true, enabled: true, connectionState: "ready" }]
    }));

    expect(markup).toContain("新しいAgentを同時に作る");
    expect(markup).toContain("Agent名");
    expect(markup).toContain("役割");
    expect(markup).toContain("Backend");
    expect(markup).toContain("Samurai Native");
    expect(markup).not.toContain("有効にする");
  });

  it("does not offer an existing Agent whose Backend is not ready", () => {
    const markup = renderToStaticMarkup(createElement(CreateDialog, {
      kind: "room",
      onClose: vi.fn(),
      onSubmit: vi.fn(),
      agents: [{ id: "agent_unready", displayName: "Unready Agent", backendId: "codex", enabled: true, status: "active" }],
      agentBackends: [{ id: "codex", label: "Codex", configured: false, enabled: true, connectionState: "unconfigured" }]
    }));

    expect(markup).not.toContain("Unready Agent");
    expect(markup).toContain("新しいAgentを同時に作る");
  });
});

describe("Native Agent directory", () => {
  it("keeps instructions out of the list until an explicit edit is opened", () => {
    const markup = renderToStaticMarkup(createElement(AgentDirectoryPanel, {
      workspaceName: "調査Workspace",
      room: { id: "room_a", workspaceId: "workspace_a", name: "Research", canManage: false, canExecute: true, defaultAgentId: "agent_a", version: 1 },
      agents: [{ id: "agent_a", displayName: "Research Agent", role: "調査担当", instructions: "secret instructions must not be listed", backendId: "native", enabled: true, status: "active" }],
      agentBackends: [{ id: "native", label: "Native", configured: true, enabled: true, connectionState: "ready" }],
      roomAgentMembers: [{ id: "membership_a", roomId: "room_a", agentId: "agent_a", canView: true, canEdit: false, canExecute: true, version: 1, removed: false }],
      onClose: vi.fn(),
      onViewAgent: vi.fn(),
      onCreateAgent: vi.fn(),
      onPatchAgent: vi.fn(),
      onBindBackend: vi.fn(),
      onSetRoomAgentPermission: vi.fn(),
      onRemoveRoomAgent: vi.fn(),
      onOpenAgentDm: vi.fn()
    }));

    expect(markup).toContain("Research Agent");
    expect(markup).toContain("調査担当");
    expect(markup).toContain("Native");
    expect(markup).toContain(">DM</button>");
    expect(markup).toContain("Room管理権限がないため、Agentの状態だけ表示します。");
    expect(markup).not.toContain("secret instructions must not be listed");
  });

  it("disables removing the current default Agent before the Server rejects it", () => {
    const markup = renderToStaticMarkup(createElement(AgentDirectoryPanel, {
      workspaceName: "調査Workspace",
      room: { id: "room_a", workspaceId: "workspace_a", name: "Research", canManage: true, canExecute: true, defaultAgentId: "agent_a", version: 1 },
      agents: [{ id: "agent_a", displayName: "Research Agent", role: "調査担当", backendId: "native", enabled: true, status: "active" }],
      agentBackends: [{ id: "native", label: "Native", configured: true, enabled: true, connectionState: "ready" }],
      roomAgentMembers: [{ id: "membership_a", roomId: "room_a", agentId: "agent_a", canView: true, canEdit: false, canExecute: true, version: 1, removed: false }],
      onClose: vi.fn(),
      onViewAgent: vi.fn(),
      onCreateAgent: vi.fn(),
      onPatchAgent: vi.fn(),
      onBindBackend: vi.fn(),
      onSetRoomAgentPermission: vi.fn(),
      onRemoveRoomAgent: vi.fn(),
      onSetDefaultAgent: vi.fn(),
      onOpenAgentDm: vi.fn()
    }));

    expect(markup).toContain("既定Agentは先に別のAgentへ変更してから解除できます。");
    expect(markup).toContain("既定Agentを変更後に解除");
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>既定Agentを変更後に解除<\/button>/);
  });

  it("hides Room Agent management controls inside an Agent DM", () => {
    const markup = renderToStaticMarkup(createElement(AgentDirectoryPanel, {
      workspaceName: "調査Workspace",
      room: { id: "room_dm", workspaceId: "workspace_a", name: "Research DM", kind: "agent_dm", canManage: true, canExecute: true, defaultAgentId: "agent_a", version: 1 },
      agents: [{ id: "agent_a", displayName: "Research Agent", role: "調査担当", backendId: "native", enabled: true, status: "active" }],
      agentBackends: [{ id: "native", label: "Native", configured: true, enabled: true, connectionState: "ready" }],
      roomAgentMembers: [{ id: "membership_a", roomId: "room_dm", agentId: "agent_a", canView: true, canEdit: true, canExecute: true, version: 1, removed: false }],
      onClose: vi.fn(),
      onViewAgent: vi.fn(),
      onCreateAgent: vi.fn(),
      onPatchAgent: vi.fn(),
      onBindBackend: vi.fn(),
      onSetRoomAgentPermission: vi.fn(),
      onRemoveRoomAgent: vi.fn(),
      onSetDefaultAgent: vi.fn(),
      onOpenAgentDm: vi.fn()
    }));

    expect(markup).not.toContain("Room設定 · Research DM");
    expect(markup).not.toContain("RoomにAgentを追加");
    expect(markup).not.toContain("既定Agentを変更");
    expect(markup).not.toContain("権限を保存");
    expect(markup).not.toContain("Roomから解除");
    expect(markup).toContain(">DM</button>");
  });
});
