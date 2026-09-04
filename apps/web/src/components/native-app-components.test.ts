import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import ChatSurface from "./ChatSurface";
import OrganizationManagement from "./OrganizationManagement";
import OrganizationSwitcher from "./OrganizationSwitcher";
import RoomNavigator from "./RoomNavigator";
import WorkspaceNavigator from "./WorkspaceNavigator";
import ConnectionRequired from "./ConnectionRequired";
import WorkspaceConnectionSettings, { workspaceConnectionActionError, workspaceConnectionActionLabel, workspaceConnectionActionSuccess, WorkspaceConnectionFeedback } from "./WorkspaceConnectionSettings";
import { EmptyMainState } from "../native-app/NativeApp";
import { preferredWorkspaceTargetForState, workspaceConnectionStateFromUnknown } from "../native-app/use-native-app";

describe("Native App component states", () => {
  it("clears the old Workspace target when a different Server is selected", () => {
    const state = workspaceConnectionStateFromUnknown({
      activeConnectionId: "connection_b",
      connections: [
        { id: "connection_a", label: "Server A", serverUrl: "http://127.0.0.1:4317", accountId: "account_owner" },
        { id: "connection_b", label: "Server B", serverUrl: "http://127.0.0.1:4318", accountId: "account_owner" }
      ]
    }, {
      activeConnectionId: "connection_a",
      activeTarget: { connectionId: "connection_a", workspaceId: "workspace_a" },
      connections: []
    });

    expect(state.activeConnectionId).toBe("connection_b");
    expect(state.activeTarget).toBeUndefined();
  });

  it("keeps the remembered Workspace candidate on the active Server", () => {
    const connections = [
      { id: "connection_a", label: "Server A", serverUrl: "http://127.0.0.1:4317", accountId: "account_owner", createdAt: "", updatedAt: "" },
      { id: "connection_b", label: "Server B", serverUrl: "http://127.0.0.1:4318", accountId: "account_owner", createdAt: "", updatedAt: "" }
    ];
    const candidates = new Map([
      ["connection_a", { serverOrigin: "http://127.0.0.1:4317", accountId: "account_owner", connectionId: "connection_a", workspaceId: "workspace_a" }],
      ["connection_b", { serverOrigin: "http://127.0.0.1:4318", accountId: "account_owner", connectionId: "connection_b", workspaceId: "workspace_b" }]
    ]);

    expect(preferredWorkspaceTargetForState(
      { activeConnectionId: "connection_b" },
      connections,
      (connection) => candidates.get(connection.id)
    )).toEqual({ connectionId: "connection_b", workspaceId: "workspace_b" });
  });

  it("does not select Server A when active Server B has zero Workspace targets", () => {
    const connections = [
      { id: "connection_a", label: "Server A", serverUrl: "http://127.0.0.1:4317", accountId: "account_owner", createdAt: "", updatedAt: "" },
      { id: "connection_b", label: "Server B", serverUrl: "http://127.0.0.1:4318", accountId: "account_owner", createdAt: "", updatedAt: "" }
    ];

    expect(preferredWorkspaceTargetForState(
      { activeConnectionId: "connection_b" },
      connections,
      (connection) => connection.id === "connection_a"
        ? { serverOrigin: "http://127.0.0.1:4317", accountId: "account_owner", connectionId: "connection_a", workspaceId: "workspace_a" }
        : undefined
    )).toBeUndefined();
  });

  it("offers a Desktop-only Server setup without rendering a private-key field", () => {
    const markup = renderToStaticMarkup(createElement(WorkspaceConnectionSettings, {
      connections: [{
        id: "connection_a",
        label: "検証用 Server A",
        serverUrl: "http://127.0.0.1:4317",
        accountId: "account_owner",
        createdAt: "2026-09-03T00:00:00.000Z",
        updatedAt: "2026-09-03T00:00:00.000Z"
      }],
      activeConnectionId: "connection_a",
      onClose: vi.fn(),
      onSave: vi.fn(),
      onSelect: vi.fn(),
      onImportIdentity: vi.fn(),
      onRegisterAccount: vi.fn()
    }));

    expect(markup).toContain("Server接続設定");
    expect(markup).toContain("検証用 Server A");
    expect(markup).toContain("Serverを追加");
    expect(markup).toContain("コピー済みの秘密鍵を読み込む");
    expect(markup).not.toContain("Private key");
    expect(markup).not.toContain("textarea");
  });

  it("makes secure identity import success explicit without exposing key material", () => {
    const message = workspaceConnectionActionSuccess("import");

    expect(message).toContain("保護領域");
    expect(message).toContain("クリップボードの鍵は手動で消してください");
    expect(message).not.toMatch(/-----BEGIN|private key|秘密鍵の内容/i);
  });

  it("keeps a visible success result in the connection dialog", () => {
    const markup = renderToStaticMarkup(createElement(WorkspaceConnectionFeedback, {
      success: workspaceConnectionActionSuccess("import")
    }));

    expect(markup).toContain("native-action-feedback is-success");
    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain("完了");
    expect(markup).toContain("保護領域");
    expect(markup).not.toMatch(/-----BEGIN|private key|秘密鍵の内容/i);
  });

  it("keeps a visible failure result in the connection dialog", () => {
    const markup = renderToStaticMarkup(createElement(WorkspaceConnectionFeedback, {
      error: workspaceConnectionActionError("import")
    }));

    expect(markup).toContain("native-action-feedback is-error");
    expect(markup).toContain('role="alert"');
    expect(markup).toContain('aria-live="assertive"');
    expect(markup).toContain("失敗");
    expect(markup).toContain("Account IDと鍵を確認してください");
    expect(markup).not.toMatch(/-----BEGIN|private key|秘密鍵の内容/i);
  });

  it("uses explicit progress labels while connection actions are running", () => {
    expect(workspaceConnectionActionLabel("import", "import")).toBe("読み込み中…");
    expect(workspaceConnectionActionLabel("register", "register")).toBe("登録中…");
    expect(workspaceConnectionActionLabel("save", "save")).toBe("保存中…");
    expect(workspaceConnectionActionLabel("select", "select")).toBe("切替中…");
    expect(workspaceConnectionActionLabel("import", null)).toBe("コピー済みの秘密鍵を読み込む");
  });

  it("shows the newest failure instead of a previous success", () => {
    const markup = renderToStaticMarkup(createElement(WorkspaceConnectionFeedback, {
      success: "前回の成功表示",
      error: workspaceConnectionActionError("import")
    }));

    expect(markup).toContain("native-action-feedback is-error");
    expect(markup).toContain("失敗");
    expect(markup).not.toContain("前回の成功表示");
  });

  it("opens the Desktop connection settings from the no-connection state", () => {
    const markup = renderToStaticMarkup(createElement(ConnectionRequired, {
      browserMode: false,
      onConnected: vi.fn(),
      onOpenSettings: vi.fn()
    }));

    expect(markup).toContain("接続設定を開く");
    expect(markup).not.toContain("Private key");
  });

  it("asks the user to choose a listed Workspace instead of claiming none exist", () => {
    const markup = renderToStaticMarkup(createElement(EmptyMainState, {
      kind: "workspace",
      hasWorkspaces: true,
      onCreate: vi.fn()
    }));

    expect(markup).toContain("左の一覧からWorkspaceを選択してください");
    expect(markup).toContain("Workspaceを選ぶと、Roomと会話を表示できます。");
    expect(markup).not.toContain("利用できるWorkspaceがありません");
    expect(markup).not.toContain("Workspaceを作成");
  });

  it("keeps the create and connection guidance when no Workspace exists", () => {
    const markup = renderToStaticMarkup(createElement(EmptyMainState, {
      kind: "workspace",
      onCreate: vi.fn()
    }));

    expect(markup).toContain("利用できるWorkspaceがありません");
    expect(markup).toContain("別のServerの接続を確認してください。");
    expect(markup).toContain("Workspaceを作成");
  });

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

  it("explains that a missing identity needs a protected-key import instead of calling it a permission denial", () => {
    const markup = renderToStaticMarkup(createElement(WorkspaceNavigator, {
      workspaces: [{
        id: "workspace_identity_required",
        name: "検証Workspace",
        state: "active",
        access: "none",
        connectionError: "workspace_identity_required"
      }],
      onSelect: vi.fn(),
      onCreate: vi.fn()
    }));

    expect(markup).toContain("本人確認（秘密鍵の読み込み）が必要です");
    expect(markup).toContain("接続設定から読み込んでください");
    expect(markup).not.toContain("アクセス権限がありません");
    expect(markup).not.toMatch(/-----BEGIN|private key|秘密鍵の内容/i);
  });

  it("separates identical Workspace IDs by connection target", () => {
    const markup = renderToStaticMarkup(createElement(WorkspaceNavigator, {
      workspaces: [
        { id: "workspace_shared", name: "Shared A", state: "active", access: "granted", target: { connectionId: "server_a", workspaceId: "workspace_shared" }, serverLabel: "Server A" },
        { id: "workspace_shared", name: "Shared B", state: "active", access: "granted", target: { connectionId: "server_b", workspaceId: "workspace_shared" }, serverLabel: "Server B" }
      ],
      selectedWorkspaceTargetKey: "server_b\nworkspace_shared",
      onSelect: vi.fn(),
      onCreate: vi.fn()
    }));

    expect(markup).toContain("Shared A");
    expect(markup).toContain("Shared B");
    expect(markup).toContain("Server A");
    expect(markup).toContain("Server B");
    expect((markup.match(/aria-current="page"/g) ?? []).length).toBe(1);
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

  it("exposes Workspace Bundle export and standalone restore controls", () => {
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
      onRestoreBundle: vi.fn(async () => ({ bundleId: "bundle_1", workspaceId: "ws_1", status: "restored" as const }))
    }));

    expect(markup).toContain("Workspace Bundle");
    expect(markup).toContain("Bundle ID");
    expect(markup).toContain("Target: Standalone（Organizationなし）");
    expect(markup).not.toContain("Target Organization");
    expect(markup).toContain("Source: Bundle metadataをServerで検証");
  });

  it("keeps standalone Workspace management independent from Organization transfer support", () => {
    const markup = renderToStaticMarkup(createElement(OrganizationManagement, {
      workspaceName: "Standalone",
      workspaces: [{ id: "ws_1", name: "Standalone", state: "active", access: "granted", target: { connectionId: "server_a", workspaceId: "ws_1" } }],
      transferTargets: [{ id: "ws_1", name: "Standalone", state: "active", access: "granted", target: { connectionId: "server_b", workspaceId: "ws_1" }, serverLabel: "Server B" }],
      transferUnavailableReason: "BrowserではServer間移転に対応していません。",
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
      onExportWorkspace: vi.fn(async () => ({ bundleId: "bundle_1", workspaceId: "ws_1", sourceOrganizationId: "" })),
      onRestoreBundle: vi.fn(async () => ({ bundleId: "bundle_1", workspaceId: "ws_1", status: "restored" as const }))
    }));

    expect(markup).toContain("Workspace settings");
    expect(markup).toContain("Server間移転");
    expect(markup).toContain("BrowserではServer間移転に対応していません。");
    expect(markup).not.toContain("Organization情報");
  });

  it("offers explicit attach/detach without making Organization a content prerequisite", () => {
    const standalone = renderToStaticMarkup(createElement(OrganizationManagement, {
      workspaceName: "Standalone",
      workspaces: [{ id: "ws_1", name: "Standalone", state: "active", access: "granted", role: "owner", target: { connectionId: "server_a", workspaceId: "ws_1" } }],
      targetOrganizations: [{ id: "org_1", name: "Team", state: "active", role: "admin" }],
      onAttachWorkspace: vi.fn(),
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
      onExportWorkspace: vi.fn(async () => ({ bundleId: "bundle_1", workspaceId: "ws_1" })),
      onRestoreBundle: vi.fn(async () => ({ bundleId: "bundle_1", workspaceId: "ws_restored", status: "restored" as const }))
    }));
    expect(standalone).toContain("Standalone（Organizationなし）");
    expect(standalone).toContain("Organizationへ追加");

    const attached = renderToStaticMarkup(createElement(OrganizationManagement, {
      organization: { id: "org_1", name: "Team", state: "active", role: "owner" },
      workspaces: [{ id: "ws_1", name: "Attached", state: "active", access: "granted", organizationId: "org_1", target: { connectionId: "server_a", workspaceId: "ws_1" } }],
      onDetachWorkspace: vi.fn(),
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
      onExportWorkspace: vi.fn(async () => ({ bundleId: "bundle_1", workspaceId: "ws_1", sourceOrganizationId: "org_1" })),
      onRestoreBundle: vi.fn(async () => ({ bundleId: "bundle_1", workspaceId: "ws_restored", status: "restored" as const }))
    }));
    expect(attached).toContain("Standaloneへ解除");
    expect(attached).not.toContain("Workspace削除前に");
  });

  it("shows a restart-safe transfer checkpoint and its refresh action", () => {
    const markup = renderToStaticMarkup(createElement(OrganizationManagement, {
      workspaceName: "移転中Workspace",
      workspaces: [{ id: "ws_1", name: "移転中Workspace", state: "active", access: "granted", role: "owner", target: { connectionId: "server_a", workspaceId: "ws_1" }, serverLabel: "Server A" }],
      transferTargets: [{ id: "ws_1", name: "移転中Workspace", state: "active", access: "granted", target: { connectionId: "server_b", workspaceId: "ws_1" }, serverLabel: "Server B" }],
      transferStatus: {
        transferId: "transfer_1",
        source: { connectionId: "server_a", workspaceId: "ws_1" },
        destination: { connectionId: "server_b", workspaceId: "ws_1" },
        state: "restoring",
        workspaceId: "ws_1",
        workspaceName: "移転中Workspace",
        message: "移転先へ復元中"
      },
      onPreviewWorkspaceTransfer: vi.fn(async () => ({
        transferId: "transfer_1",
        source: { connectionId: "server_a", workspaceId: "ws_1" },
        destination: { connectionId: "server_b", workspaceId: "ws_1" },
        workspaceId: "ws_1",
        writeBlocked: false,
        organizationReleased: true,
        sourceWillArchive: true,
        failureConditions: []
      })),
      onExecuteWorkspaceTransfer: vi.fn(async () => ({
        transferId: "transfer_1",
        source: { connectionId: "server_a", workspaceId: "ws_1" },
        destination: { connectionId: "server_b", workspaceId: "ws_1" },
        state: "restoring" as const,
        workspaceId: "ws_1"
      })),
      onRefreshWorkspaceTransfer: vi.fn(async (_workspace, _destination, status) => status),
      onCutoverWorkspaceTransfer: vi.fn(),
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
      onExportWorkspace: vi.fn(async () => ({ bundleId: "bundle_1", workspaceId: "ws_1" })),
      onRestoreBundle: vi.fn(async () => ({ bundleId: "bundle_1", workspaceId: "ws_1", status: "restored" as const }))
    }));

    expect(markup).toContain("移転先へ復元中");
    expect(markup).toContain("状態を更新");
  });
});
