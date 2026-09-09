import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AutomationJobRecord } from "@samurai-agent/core-schemas";
import type {
  DesktopWorkspaceConnectionState,
  WorkspaceCompletionResourceView
} from "../lib/api";
import NativeKnowledgeTools from "./NativeKnowledgeTools";
import {
  activeDesktopTargetFromConnectionState,
  automationJobMatchesNativeKnowledgeToolsTarget,
  isNativeKnowledgeResourceKind,
  nativeKnowledgeToolsErrorMessage,
  nativeKnowledgeToolsTargetKey,
  resourceMatchesNativeKnowledgeToolsTarget,
  withNativeKnowledgeToolsTarget,
  type NativeKnowledgeToolsBridge,
  type NativeKnowledgeToolsTarget
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
      scope: { kind: "workspace" }
    }), target)).toBe(true);
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
    expect(markup).not.toContain("session_id");
    expect(markup).not.toContain("今すぐ実行");
    expect(markup).not.toContain("automationを作成");
  });

  it("explains conflict and permission failures without discarding the draft", () => {
    expect(nativeKnowledgeToolsErrorMessage(new Error("workspace_completion_resource_version_conflict"))).toContain("下書き");
    expect(nativeKnowledgeToolsErrorMessage(new Error("permission_denied"))).toContain("内容は保持");
  });
});
