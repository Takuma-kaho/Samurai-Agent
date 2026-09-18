import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { WorkspaceNotification } from "../lib/api";
import WorkspaceNotificationCenter from "./WorkspaceNotificationCenter";
import {
  contextTargetRoomId,
  isWorkspaceNotificationUnread,
  workspaceNotificationViewState
} from "./workspace-context-ui-helpers";

const target = { connectionId: "connection_a", workspaceId: "workspace_a" };

const notification: WorkspaceNotification = {
  id: "notification_a",
  kind: "work_completed",
  createdAt: "2026-09-17T00:00:00.000Z",
  readAt: null,
  title: "調査が完了しました",
  summary: "結果をRoomで確認できます。",
  target: { kind: "room", roomId: "room_a" },
  actionState: "not_required"
};

const invitation: WorkspaceNotification = {
  id: "invitation_a",
  kind: "workspace_invitation",
  createdAt: "2026-09-17T00:00:00.000Z",
  readAt: null,
  title: "Workspaceへの招待",
  summary: "招待内容を確認してください。",
  target: { kind: "invitation", invitationId: "invitation_a" },
  actionState: "pending"
};

describe("WorkspaceNotificationCenter", () => {
  it("renders unread controls, an empty state, and safe account invitation sections", () => {
    const markup = renderToStaticMarkup(createElement(WorkspaceNotificationCenter, {
      target,
      workspaceName: "調査Workspace",
      workspaceIds: ["workspace_a", "workspace_b"],
      workspaceLabels: { workspace_a: "調査Workspace", workspace_b: "別Workspace" },
      listWorkspaceNotifications: vi.fn(async () => ({ items: [], nextCursor: null })),
      getWorkspaceNotificationSummary: vi.fn(async () => ({ unreadCount: 0, asOf: "2026-09-17T00:00:00.000Z" })),
      getAccountWorkspaceNotificationSummaries: vi.fn(async () => ({ items: [] })),
      listAccountInvitationNotifications: vi.fn(async () => ({ items: [], nextCursor: null })),
      markWorkspaceNotificationsRead: vi.fn(async () => ({ updatedIds: [], alreadyReadIds: [], readAt: "2026-09-17T00:00:00.000Z" })),
      markAccountInvitationNotificationsRead: vi.fn(async () => ({ updatedIds: [], alreadyReadIds: [], readAt: "2026-09-17T00:00:00.000Z" })),
      onOpenRoom: vi.fn(),
      onClose: vi.fn()
    }));

    expect(markup).toContain('role="dialog"');
    expect(markup).toContain("未読のみ");
    expect(markup).toContain("すべて既読");
    expect(markup).toContain("通知はありません。");
    expect(markup).toContain("Account横断");
    expect(markup).toContain("招待");
    expect(markup).toContain("別セクションで安全に表示");
    expect(markup).not.toContain("受諾");
  });

  it("keeps invitations visible without an active Workspace and does not expose an acceptance action", () => {
    const markup = renderToStaticMarkup(createElement(WorkspaceNotificationCenter, {
      listAccountInvitationNotifications: vi.fn(async () => ({ items: [invitation], nextCursor: null })),
      markAccountInvitationNotificationsRead: vi.fn(async () => ({ updatedIds: [invitation.id], alreadyReadIds: [], readAt: "2026-09-17T00:00:00.000Z" })),
      open: true
    }));

    expect(markup).toContain("Workspaceを選択するとWorkspace通知を表示できます。");
    expect(markup).toContain("招待通知はありません。");
    expect(markup).not.toContain("招待を受諾");
    expect(markup).not.toContain("承認する");
  });

  it("keeps read state and Room targets separate from invitation targets", () => {
    expect(isWorkspaceNotificationUnread(notification)).toBe(true);
    expect(isWorkspaceNotificationUnread({ ...notification, readAt: "2026-09-17T00:00:00.000Z" })).toBe(false);
    expect(isWorkspaceNotificationUnread({ ...notification, actionState: "resolved" })).toBe(false);
    expect(contextTargetRoomId(notification.target)).toBe("room_a");
    expect(contextTargetRoomId(invitation.target)).toBeUndefined();
    expect(workspaceNotificationViewState({ loading: true, error: null, itemCount: 0 })).toBe("loading");
    expect(workspaceNotificationViewState({ loading: false, error: "failed", itemCount: 0 })).toBe("error");
    expect(workspaceNotificationViewState({ loading: false, error: null, itemCount: 0 })).toBe("empty");
    expect(workspaceNotificationViewState({ loading: false, error: null, itemCount: 1 })).toBe("ready");
  });
});
