import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AutomationJobRecord } from "@samurai-agent/core-schemas";
import type {
  DesktopWorkspaceConnectionState,
  WorkspaceCompletionResourceView
} from "../lib/api";
import NativeKnowledgeTools, { nativeKnowledgeResourceCanBeUsedInWork } from "./NativeKnowledgeTools";
import {
  activeDesktopTargetFromConnectionState,
  automationJobMatchesNativeKnowledgeToolsTarget,
  collectCompletionResourcePages,
  isNativeKnowledgeResourceKind,
  nativeKnowledgeDraftAfterMutation,
  nativeKnowledgeDraftMatchesSnapshot,
  nativeKnowledgeResourceForOpen,
  nativeKnowledgeResourcesErrorKind,
  nativeKnowledgeShareAvailability,
  nativeKnowledgeShareAvailabilityMessage,
  nativeRoomSearchResultCanOpen,
  nativeRoomSearchResultOpenHint,
  nativeKnowledgeToolsErrorMessage,
  nativeKnowledgeToolsTargetKey,
  isNativeRoomKnowledgeResource,
  isNativeRoomKnowledgeShareableResource,
  nativeRoomKnowledgeShareResources,
  nativeRoomKnowledgeShareSelection,
  resourceMatchesNativeKnowledgeToolsTarget,
  withNativeKnowledgeToolsTarget,
  type NativeKnowledgeToolsBridge,
  type NativeKnowledgeToolsTarget,
  type NativeKnowledgeToolsDraft,
  type NativeRoomSearchResult
} from "./use-native-knowledge-tools";

const target: NativeKnowledgeToolsTarget = {
  connectionId: "connection-a",
  workspaceId: "workspace-a",
  roomId: "room-a"
};

const otherTarget: NativeKnowledgeToolsTarget = {
  connectionId: "connection-b",
  workspaceId: "workspace-b",
  roomId: "room-b"
};

const createdAt = "2026-09-08T00:00:00.000Z";

function resource(overrides: Partial<WorkspaceCompletionResourceView> = {}): WorkspaceCompletionResourceView {
  return {
    workspaceId: target.workspaceId,
    id: "knowledge-a",
    scope: { kind: "room", roomId: target.roomId },
    kind: "knowledge",
    knowledgeKind: "fact",
    title: "Roomの知識",
    evidenceState: "confirmed",
    lifecycleState: "active",
    aiProtection: "editable",
    creationSource: "human",
    aiManaged: false,
    version: 3,
    createdAt,
    updatedAt: createdAt,
    ...overrides
  };
}

function automationJob(overrides: Partial<AutomationJobRecord> = {}): AutomationJobRecord {
  return {
    id: "automation-a",
    title: "朝の確認",
    kind: "daily_digest",
    status: "enabled",
    schedule: "0 9 * * *",
    target_instruction: "Roomの更新を確認する",
    delivery_target: { kind: "room" },
    workspace_id: target.workspaceId,
    room_id: target.roomId,
    authorization_state: "ready",
    management_state: "allowed",
    next_run_at: createdAt,
    last_run_at: createdAt,
    failure_count: 0,
    max_attempts: 3,
    created_at: createdAt,
    updated_at: createdAt,
    ...overrides
  };
}

describe("NativeKnowledgeTools target boundary", () => {
  it("drains every completion resource page and rejects a cyclic cursor", async () => {
    const fetchPage = vi.fn()
      .mockResolvedValueOnce({ resources: [resource({ id: "knowledge-1" })], next_cursor: "page-2" })
      .mockResolvedValueOnce({ resources: [resource({ id: "knowledge-2" })] });
    await expect(collectCompletionResourcePages(fetchPage)).resolves.toEqual([
      resource({ id: "knowledge-1" }),
      resource({ id: "knowledge-2" })
    ]);
    expect(fetchPage).toHaveBeenNthCalledWith(1, undefined);
    expect(fetchPage).toHaveBeenNthCalledWith(2, "page-2");

    await expect(collectCompletionResourcePages(vi.fn()
      .mockResolvedValue({ resources: [], next_cursor: "same-page" }))).rejects.toThrow("cursor_repeated");
  });

  it("keeps the connection, Workspace, and Room in the panel identity", () => {
    expect(nativeKnowledgeToolsTargetKey(target)).toBe("connection-a\nworkspace-a\nroom-a");
    expect(resourceMatchesNativeKnowledgeToolsTarget(resource(), target)).toBe(true);
    expect(resourceMatchesNativeKnowledgeToolsTarget(resource({
      workspaceId: otherTarget.workspaceId
    }), target)).toBe(false);
    expect(resourceMatchesNativeKnowledgeToolsTarget(resource({
      scope: { kind: "room", roomId: otherTarget.roomId }
    }), target)).toBe(false);
    expect(resourceMatchesNativeKnowledgeToolsTarget(resource({
      scope: { kind: "workspace" },
      kind: "knowledge"
    }), target)).toBe(false);
    expect(resourceMatchesNativeKnowledgeToolsTarget(resource({
      scope: { kind: "workspace" },
      kind: "skill"
    }), target)).toBe(true);
    expect(isNativeRoomKnowledgeResource(resource(), target)).toBe(true);
    expect(isNativeRoomKnowledgeResource(resource({ evidenceState: "provisional" }), target)).toBe(false);
    expect(isNativeRoomKnowledgeResource(resource({ scope: { kind: "workspace" } }), target)).toBe(false);
    expect(isNativeKnowledgeResourceKind("knowledge")).toBe(true);
    expect(isNativeKnowledgeResourceKind("policy")).toBe(false);
  });

  it("filters automation management to the exact Workspace and Room", () => {
    expect(automationJobMatchesNativeKnowledgeToolsTarget(automationJob(), target)).toBe(true);
    expect(automationJobMatchesNativeKnowledgeToolsTarget(automationJob({ workspace_id: otherTarget.workspaceId }), target)).toBe(false);
    expect(automationJobMatchesNativeKnowledgeToolsTarget(automationJob({ room_id: otherTarget.roomId }), target)).toBe(false);
  });

  it("rejects a response when the active Workspace changes during an awaited bridge call", async () => {
    let targetChecks = 0;
    const bridge = {
      listWorkspaceConnections: vi.fn(async (): Promise<DesktopWorkspaceConnectionState> => {
        targetChecks += 1;
        return {
          activeTarget: targetChecks === 1 ? target : otherTarget,
          connections: []
        };
      })
    } as NativeKnowledgeToolsBridge;
    const task = vi.fn(async () => "response-for-old-target");

    await expect(withNativeKnowledgeToolsTarget(bridge, target, task)).rejects.toThrow("workspace_navigation_changed");
    expect(task).toHaveBeenCalledTimes(1);
    expect(targetChecks).toBe(2);
  });

  it("falls back to the active connection Workspace when activeTarget is absent", () => {
    expect(activeDesktopTargetFromConnectionState({
      activeConnectionId: "connection-a",
      connections: [{ id: "connection-a", workspaceId: "workspace-a" } as DesktopWorkspaceConnectionState["connections"][number]]
    })).toEqual({ connectionId: "connection-a", workspaceId: "workspace-a" });
  });

  it("fails closed for archived, disabled, stale, and unknown Skill states", () => {
    expect(nativeKnowledgeResourceCanBeUsedInWork({ kind: "skill", lifecycleState: "active" })).toBe(true);
    expect(nativeKnowledgeResourceCanBeUsedInWork({ kind: "skill", lifecycleState: "archived" })).toBe(false);
    expect(nativeKnowledgeResourceCanBeUsedInWork({ kind: "skill", lifecycleState: "disabled" })).toBe(false);
    expect(nativeKnowledgeResourceCanBeUsedInWork({ kind: "skill", lifecycleState: "stale" })).toBe(false);
    expect(nativeKnowledgeResourceCanBeUsedInWork({ kind: "policy", lifecycleState: "active" })).toBe(false);
  });

  it("keeps a Knowledge edit made while saving and advances only its optimistic base version", () => {
    const submitted: NativeKnowledgeToolsDraft = {
      resourceId: "knowledge-a",
      kind: "knowledge",
      scopeKind: "room",
      roomId: target.roomId,
      title: "保存前",
      content: "最初の本文",
      reason: "最初の理由",
      expectedVersion: 3,
      dirty: true
    };
    expect(nativeKnowledgeDraftMatchesSnapshot({ ...submitted, dirty: false }, submitted)).toBe(true);
    const newer = { ...submitted, content: "保存中に追加した本文", dirty: true };
    expect(nativeKnowledgeDraftMatchesSnapshot(newer, submitted)).toBe(false);
    expect(nativeKnowledgeDraftAfterMutation(newer, submitted, resource({ version: 4 }))).toEqual({
      ...newer,
      expectedVersion: 4,
      dirty: true
    });
    expect(nativeKnowledgeDraftAfterMutation(submitted, submitted, resource({ version: 4 }))).toBeUndefined();
  });

  it("offers only active, confirmed, manual Knowledge from the fixed Room to sharing", () => {
    const shareable = nativeRoomKnowledgeShareResources([
      resource({ id: "knowledge-valid", title: "共有できる知識", version: 8 }),
      resource({ id: "knowledge-archived", lifecycleState: "archived" }),
      resource({ id: "knowledge-ai", aiManaged: true }),
      resource({ id: "knowledge-provisional", evidenceState: "provisional" }),
      resource({ id: "skill-room", kind: "skill" }),
      resource({ id: "knowledge-workspace", scope: { kind: "workspace" } }),
      resource({ id: "knowledge-other-room", scope: { kind: "room", roomId: otherTarget.roomId } }),
      resource({ id: "knowledge-valid", title: "重複した表示", version: 2 })
    ], target);

    expect(isNativeRoomKnowledgeShareableResource(resource(), target)).toBe(true);
    expect(shareable).toEqual([{
      id: "knowledge-valid",
      version: 8,
      kind: "knowledge",
      title: "共有できる知識"
    }]);
    expect(shareable[0]).not.toHaveProperty("content");
    expect(shareable[0]).not.toHaveProperty("aiManaged");
    expect(nativeRoomKnowledgeShareSelection(target, "  検証Room  ", shareable)).toEqual({
      source: { kind: "room_knowledge", id: target.roomId, label: "検証Room" },
      resources: shareable
    });
    expect(nativeRoomKnowledgeShareSelection(target, " ", shareable).source.label).toBe("選択中のRoom");
  });

  it("keeps share availability truthful for empty, permission, and retrieval failures", () => {
    const base = {
      target,
      resourcesLoading: false,
      resourcesLoaded: true,
      resourcesError: null,
      resourcesErrorKind: null,
      resources: []
    } as const;
    expect(nativeKnowledgeShareAvailability(base)).toBe("no_resources");
    expect(nativeKnowledgeShareAvailability({ ...base, resources: [{ id: "k", version: 1, kind: "knowledge", title: "K" }] })).toBe("ready");
    expect(nativeKnowledgeShareAvailability({ ...base, resourcesLoaded: false, resourcesError: "権限がありません", resourcesErrorKind: "permission" })).toBe("permission_denied");
    expect(nativeKnowledgeShareAvailability({ ...base, resourcesLoaded: false, resourcesError: "network", resourcesErrorKind: "retrieval" })).toBe("retrieval_failed");
    expect(nativeKnowledgeShareAvailabilityMessage("no_resources")).toContain("ありません");
    expect(nativeKnowledgeShareAvailabilityMessage("permission_denied")).toContain("権限");
    expect(nativeKnowledgeShareAvailabilityMessage("retrieval_failed")).toContain("取得できません");
    expect(nativeKnowledgeResourcesErrorKind(new Error("403 forbidden"))).toBe("permission");
    expect(nativeKnowledgeResourcesErrorKind(new Error("network_timeout"))).toBe("retrieval");
  });

  it("prefers the just-created Knowledge response when an older list has the same ID", () => {
    const listed = resource({ id: "knowledge-new", title: "一覧の古い表示", version: 3 });
    const created = resource({ id: "knowledge-new", title: "作成直後の表示", version: 4 });
    expect(nativeKnowledgeResourceForOpen([listed], created.id, created)).toBe(created);
    expect(nativeKnowledgeResourceForOpen([listed], listed.id)).toBe(listed);
    expect(nativeKnowledgeResourceForOpen([resource({ evidenceState: "provisional" })], "knowledge-a")).toBeUndefined();
    expect(nativeKnowledgeResourceForOpen([resource({ scope: { kind: "workspace" } })], "knowledge-a")).toBeUndefined();
    const workspaceSkill = resource({ kind: "skill", scope: { kind: "workspace" } });
    expect(nativeKnowledgeResourceForOpen([workspaceSkill], workspaceSkill.id)).toBe(workspaceSkill);
  });

  it("does not offer a Session or Message without work_id as openable", () => {
    const session: NativeRoomSearchResult = { key: "session:session-a", kind: "session", id: "session-a", title: "履歴", summary: "抜粋" };
    const message: NativeRoomSearchResult = { key: "message:message-a", kind: "message", id: "message-a", title: "メッセージ", summary: "抜粋" };
    expect(nativeRoomSearchResultCanOpen(session, true)).toBe(false);
    expect(nativeRoomSearchResultCanOpen(message, true)).toBe(false);
    expect(nativeRoomSearchResultOpenHint(session, true)).toContain("work_id");
    expect(nativeRoomSearchResultCanOpen({ ...session, work_id: "work-a" }, true)).toBe(true);
    expect(nativeRoomSearchResultCanOpen({ ...message, work_id: "work-a" }, true)).toBe(true);
  });
});

describe("NativeKnowledgeTools panel", () => {
  it("renders the independent Room panel with accessible tabs and no scheduler creation surface", () => {
    const markup = renderToStaticMarkup(createElement(NativeKnowledgeTools, {
      target,
      workspaceName: "調査Workspace",
      roomName: "検証Room",
      initialTab: "search",
      bridge: {} as NativeKnowledgeToolsBridge
    }));

    expect(markup).toContain("Knowledge tools");
    expect(markup).toContain("調査Workspace");
    expect(markup).toContain("検証Room");
    expect(markup).toContain("対象固定");
    expect(markup).toContain('role="tablist"');
    expect(markup).toContain('role="tab"');
    expect(markup).toContain("Knowledge / Skill");
    expect(markup).toContain("Room内検索");
    expect(markup).toContain("基本設定");
    expect(markup).toContain("既存automation");
    expect(markup).not.toContain("Workspace共通Knowledge");
    expect(markup).not.toContain("Workspace専用Knowledge");
    expect(markup).not.toContain("session_id");
    expect(markup).not.toContain("今すぐ実行");
    expect(markup).not.toContain("automationを作成");
    expect(markup).not.toContain("Room Knowledgeを共有");
  });

  it("exposes Knowledge creation from the management surface", () => {
    const markup = renderToStaticMarkup(createElement(NativeKnowledgeTools, {
      target,
      bridge: {} as NativeKnowledgeToolsBridge
    }));
    expect(markup).toContain("Knowledgeを作成");
    expect(markup).toContain("確認できる資源");
    expect(markup).not.toContain("Workspace共通");
  });

  it("explains conflict and permission failures without discarding the draft", () => {
    expect(nativeKnowledgeToolsErrorMessage(new Error("workspace_completion_resource_version_conflict"))).toContain("下書き");
    expect(nativeKnowledgeToolsErrorMessage(new Error("permission_denied"))).toContain("内容は保持");
  });
});
