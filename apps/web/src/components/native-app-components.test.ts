import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import ChatSurface from "./ChatSurface";
import OrganizationManagement from "./OrganizationManagement";
import OrganizationSwitcher from "./OrganizationSwitcher";
import RoomNavigator from "./RoomNavigator";
import WorkspaceNavigator from "./WorkspaceNavigator";

describe("Native App component states", () => {
  it("keeps zero Organization actionable without exposing internal identifiers", () => {
    const markup = renderToStaticMarkup(createElement(OrganizationSwitcher, {
      organizations: [],
      onSelect: vi.fn(),
      onCreate: vi.fn(),
      onManage: vi.fn()
    }));

    expect(markup).toContain("Organizationを選択");
    expect(markup).toContain("作成または参加");
    expect(markup).not.toMatch(/session|run|queue/i);
  });

  it("labels inaccessible Workspaces and keeps the hierarchy free of session details", () => {
    const markup = renderToStaticMarkup(createElement(WorkspaceNavigator, {
      workspaces: [{
        id: "workspace_private",
        organizationId: "organization_1",
        name: "Private",
        state: "active",
        access: "none"
      }],
      onSelect: vi.fn(),
      onCreate: vi.fn()
    }));

    expect(markup).toContain("Private");
    expect(markup).toContain("アクセス権限がありません");
    expect(markup).not.toMatch(/session|run|queue/i);
  });

  it("disables Room selection for an archived Workspace", () => {
    const markup = renderToStaticMarkup(createElement(RoomNavigator, {
      rooms: [{ id: "room_1", workspaceId: "workspace_1", name: "Archive room" }],
      selectedRoomId: "room_1",
      archived: true,
      onSelect: vi.fn()
    }));

    expect(markup).toContain("Archive room");
    expect(markup).toMatch(/button[^>]*disabled/);
  });

  it("offers reconnect and retry affordances after an Agent failure", () => {
    const markup = renderToStaticMarkup(createElement(ChatSurface, {
      roomName: "Main",
      messages: [{ id: "message_1", role: "agent", content: "失敗しました", failed: true, retryable: true }],
      error: "Agentへの送信に失敗しました。",
      connectionState: "reconnecting",
      onSend: vi.fn(),
      onStop: vi.fn(),
      onRetry: vi.fn(),
      onInspectEvidence: vi.fn(),
      onReconnect: vi.fn()
    }));

    expect(markup).toContain("再試行");
    expect(markup).toContain("再接続");
    expect(markup).toContain("再接続中");
  });

  it("exposes Workspace Bundle export and target Organization restore controls", () => {
    const markup = renderToStaticMarkup(createElement(OrganizationManagement, {
      organization: { id: "org_source", name: "Source", state: "active", role: "owner" },
      workspaces: [],
      members: [],
      invitations: [],
      onClose: vi.fn(),
      onSaveOrganization: vi.fn(),
      onInvite: vi.fn(async () => ({})),
      onChangeMemberRole: vi.fn(),
      onRemoveMember: vi.fn(),
      onRevokeInvitation: vi.fn(),
      onReissueInvitation: vi.fn(async () => ({})),
      onExtendInvitation: vi.fn(),
      onAcceptInvitation: vi.fn(),
      onArchiveWorkspace: vi.fn(),
      onRestoreWorkspace: vi.fn(),
      onDeleteWorkspace: vi.fn(),
      onExportWorkspace: vi.fn(async () => ({ bundleId: "bundle_1", workspaceId: "ws_1", sourceOrganizationId: "org_source" })),
      onRestoreBundle: vi.fn(async () => ({ bundleId: "bundle_1", workspaceId: "ws_1", targetOrganizationId: "org_source", status: "restored" as const }))
    }));

    expect(markup).toContain("Workspace Bundle");
    expect(markup).toContain("Bundle ID");
    expect(markup).toContain("Target Organization");
    expect(markup).toContain("Source: Bundle metadataをServerで検証");
  });
});
