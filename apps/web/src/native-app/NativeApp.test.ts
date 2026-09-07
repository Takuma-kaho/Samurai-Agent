import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AgentDirectoryPanel, CreateDialog, patchAgentEditorState } from "./NativeApp";

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
