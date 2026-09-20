import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import NativeTopChrome from "./NativeTopChrome";
import { AgentDirectoryPanel, appendNativeRoomWorkResourceRef, artifactRevisionRequestDraft, createNativeDraftNavigationControllerRegistry, CreateDialog, nativeAgentDirectoryScopeKey, nativeAgentProfileForScope, nativeRoomResultResourceTarget, nativeRoomToolTarget, nativeWorkspaceContextTarget, nativeWorkspaceNotificationPageForDisplay, nativeWorkspaceSwitcherEntries, NativeRoomToolLinks, nativeRoomWorkResourceDraftKey } from "./NativeApp";
import { createNativeDraftNavigationController } from "./use-native-draft-navigation";
import { recordNativeWorkspaceNavigation, type NativeWorkspaceNavigationHistoryState } from "./use-native-workspace-navigation-history";
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

describe("Native workspace navigation history", () => {
  it("records same-Workspace destinations, truncates a forward branch, and resets on Workspace change", () => {
    const roomA = { workspaceTargetKey: "connection_a\nworkspace_a", kind: "room" as const, roomId: "room_a" };
    const agents = { workspaceTargetKey: "connection_a\nworkspace_a", kind: "agents" as const };
    const roomB = { workspaceTargetKey: "connection_a\nworkspace_a", kind: "room" as const, roomId: "room_b" };
    const roomOtherWorkspace = { workspaceTargetKey: "connection_b\nworkspace_b", kind: "room" as const, roomId: "room_c" };
    let state: NativeWorkspaceNavigationHistoryState = { entries: [], index: -1 };

    state = recordNativeWorkspaceNavigation(state, roomA);
    state = recordNativeWorkspaceNavigation(state, agents);
    state = { ...state, index: 0 };
    state = recordNativeWorkspaceNavigation(state, roomB);
    expect(state.entries).toEqual([roomA, roomB]);
    expect(state.index).toBe(1);

    state = recordNativeWorkspaceNavigation(state, roomOtherWorkspace);
    expect(state).toEqual({ entries: [roomOtherWorkspace], index: 0 });
  });
});

describe("Native top chrome", () => {
  it("renders accessible inline SVG controls and disables unavailable history directions", () => {
    const markup = renderToStaticMarkup(createElement(NativeTopChrome, {
      sidebarOpen: true,
      canGoBack: false,
      canGoForward: true,
      onToggleSidebar: vi.fn(),
      onGoBack: vi.fn(),
      onGoForward: vi.fn()
    }));

    expect(markup).toContain("アプリナビゲーション");
    expect(markup).toContain("前の画面へ戻る");
    expect(markup).toContain("次の画面へ進む");
    expect(markup).toContain("disabled=\"\"");
    expect(markup).toContain("native-top-chrome-history");
    expect(markup).toContain("viewBox=\"0 0 24 24\"");
    expect(markup).toContain("height=\"14\"");
    expect(markup).toContain("<svg");
  });

  it("removes the macOS traffic-light clearance in native fullscreen", () => {
    const markup = renderToStaticMarkup(createElement(NativeTopChrome, {
      sidebarOpen: true,
      macDesktop: true,
      isFullscreen: true,
      canGoBack: true,
      canGoForward: true,
      onToggleSidebar: vi.fn(),
      onGoBack: vi.fn(),
      onGoForward: vi.fn()
    }));

    expect(markup).not.toContain("is-mac-desktop");
  });
});

describe("Native Workspace context entry points", () => {
  it("strips Room state from the shared context target", () => {
    expect(nativeWorkspaceContextTarget({ connectionId: "connection_a", workspaceId: "workspace_a", roomId: "room_a", selectionGeneration: 4 }))
      .toEqual({ connectionId: "connection_a", workspaceId: "workspace_a", selectionGeneration: 4 });
    expect(nativeWorkspaceContextTarget(undefined)).toBeUndefined();
  });

  it("lists only authorized target-addressable Workspaces without merging same IDs", () => {
    const entries = nativeWorkspaceSwitcherEntries([
      { id: "workspace_a", name: "調査", state: "active", access: "granted", target: { connectionId: "connection_a", workspaceId: "workspace_a" } },
      { id: "workspace_a", name: "調査の複製", state: "active", access: "granted", target: { connectionId: "connection_b", workspaceId: "workspace_a" } },
      { id: "workspace_denied", name: "閲覧不可", state: "read_only", access: "none", target: { connectionId: "connection_a", workspaceId: "workspace_denied" } },
      { id: "legacy", name: "接続先不明", state: "active", access: "granted" }
    ]);

    expect(entries.map((entry) => entry.key)).toEqual([
      "connection_a\nworkspace_a",
      "connection_b\nworkspace_a"
    ]);
  });

  it("keeps an unknown notification kind visible instead of collapsing it into an empty state", () => {
    const page = nativeWorkspaceNotificationPageForDisplay({
      items: [{
        id: "notification_unknown",
        kind: "new_server_event",
        createdAt: "2026-09-17T00:00:00.000Z",
        readAt: null,
        title: "未認識のイベント",
        summary: "内容を確認してください。",
        target: null,
        actionState: "not_required"
      }],
      nextCursor: null
    });

    expect(page.items[0]?.summary).toContain("new_server_event");
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

  it("renders only the selected Room's artifact entry", () => {
    const markup = renderToStaticMarkup(createElement(NativeRoomToolLinks, {
      target: nativeRoomToolTarget(target, room),
      onOpen: vi.fn()
    }));

    expect(markup).toContain(">成果物</button>");
    expect(markup).not.toContain("確認待ち");
    expect(markup).not.toContain("知識・検索・設定");
    expect(markup).not.toContain("Room管理");
    expect(markup).not.toContain("Collection");
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

  it("limits the ordinary Room navigator flow to an existing Agent", () => {
    const markup = renderToStaticMarkup(createElement(CreateDialog, {
      kind: "room",
      roomCreateMode: "existing-only",
      onClose: vi.fn(),
      onSubmit: vi.fn(),
      agents: [{ id: "agent_research", displayName: "Research Agent", backendId: "samurai-native", enabled: true, status: "active", version: 3 }],
      agentBackends: [{ id: "samurai-native", label: "Samurai Native", configured: true, enabled: true, connectionState: "ready" }]
    }));

    expect(markup).toContain("既存Agentを選ぶ");
    expect(markup).toContain("Research Agent");
    expect(markup).not.toContain("新しいAgentを同時に作る");
    expect(markup).not.toContain("Agent名");
    expect(markup).not.toContain("<span>役割</span>");
    expect(markup).not.toContain("<span>指示</span>");
    expect(markup).not.toContain("Room権限");
    expect(markup).not.toContain("<span>Backend</span>");
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
  it("does not expose a profile fetched for a previous Workspace or Agent list scope", () => {
    const agent = { id: "agent_a", displayName: "Research Agent", enabled: true };
    const workspaceA = nativeAgentDirectoryScopeKey("connection_a\nworkspace_a", "調査Workspace", "room_a", [{ id: agent.id, version: 1 }]);
    const workspaceB = nativeAgentDirectoryScopeKey("connection_b\nworkspace_b", "調査Workspace", "room_a", [{ id: agent.id, version: 1 }]);
    const refreshedList = nativeAgentDirectoryScopeKey("connection_a\nworkspace_a", "調査Workspace", "room_a", [{ id: agent.id, version: 2 }]);

    expect(workspaceB).not.toBe(workspaceA);
    expect(refreshedList).not.toBe(workspaceA);
    expect(nativeAgentProfileForScope(agent, workspaceA, workspaceB)).toBeUndefined();
    expect(nativeAgentProfileForScope(agent, workspaceA, refreshedList)).toBeUndefined();
    expect(nativeAgentProfileForScope(agent, workspaceA, workspaceA)).toBe(agent);
  });

  it("supports the new sidebar's read-only Agent list and DM entry", () => {
    const markup = renderToStaticMarkup(createElement(AgentDirectoryPanel, {
      workspaceName: "調査Workspace",
      readOnly: true,
      agents: [{ id: "agent_a", displayName: "Research Agent", role: "調査担当", backendId: "native", enabled: true, status: "active" }],
      agentBackends: [{ id: "native", label: "Native", configured: true, enabled: true, connectionState: "ready" }],
      roomAgentMembers: [],
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
    expect(markup).toContain(">DM</button>");
    expect(markup).toContain(">プロフィール</button>");
    expect(markup).not.toContain("Agentを作成");
    expect(markup).not.toContain(">編集</button>");
  });

  it("keeps instructions out of the list until an explicit profile is opened", () => {
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
    expect(markup).toContain(">プロフィール</button>");
    expect(markup).not.toContain("Workspace Agents");
    expect(markup).not.toContain("Agentを作成");
    expect(markup).not.toContain(">編集</button>");
    expect(markup).not.toContain("Room設定");
    expect(markup).not.toContain("既定Agent");
    expect(markup).not.toContain("RoomにAgentを追加");
    expect(markup).not.toContain("権限を保存");
    expect(markup).not.toContain("secret instructions must not be listed");
  });

  it("keeps profile viewing available for a writable Agent directory", () => {
    const markup = renderToStaticMarkup(createElement(AgentDirectoryPanel, {
      workspaceName: "調査Workspace",
      readOnly: false,
      agents: [{ id: "agent_a", displayName: "Research Agent", role: "調査担当", backendId: "native", enabled: true, status: "active" }],
      agentBackends: [{ id: "native", label: "Native", configured: true, enabled: true, connectionState: "ready" }],
      roomAgentMembers: [],
      onClose: vi.fn(),
      onViewAgent: vi.fn(),
      onCreateAgent: vi.fn(),
      onPatchAgent: vi.fn(),
      onBindBackend: vi.fn(),
      onSetRoomAgentPermission: vi.fn(),
      onRemoveRoomAgent: vi.fn(),
      onOpenAgentDm: vi.fn()
    }));

    expect(markup).toContain(">プロフィール</button>");
    expect(markup).not.toContain("Agentを作成");
    expect(markup).not.toContain(">編集</button>");
    expect(markup).not.toContain("Room設定");
    expect(markup).not.toContain("既定Agent");
    expect(markup).not.toContain("RoomにAgentを追加");
    expect(markup).not.toContain("権限を保存");
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
    expect(markup).toContain(">プロフィール</button>");
    expect(markup).toContain(">DM</button>");
  });
});
