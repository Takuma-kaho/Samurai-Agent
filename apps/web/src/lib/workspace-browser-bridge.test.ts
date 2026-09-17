import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  browserShareSourceRequest,
  browserWorkspaceRequest,
  createBrowserShareDelegation,
  loadBrowserWorkspaceConnection,
  loadBrowserWorkspaceConnections
} from "./workspace-browser-auth";
import { createBrowserWorkspaceBridge } from "./workspace-browser-bridge";
import { updateActiveWorkspaceRoomId } from "./workspace-navigation-state";

vi.mock("./workspace-browser-auth", () => ({
  browserWorkspaceHealth: vi.fn(),
  browserShareSourceRequest: vi.fn(),
  browserWorkspaceRequest: vi.fn(),
  createBrowserWorkspaceConnectionState: vi.fn(),
  createBrowserShareDelegation: vi.fn(),
  loadBrowserWorkspaceConnection: vi.fn(),
  loadBrowserWorkspaceConnections: vi.fn(),
  registerBrowserWorkspaceAccount: vi.fn(),
  selectBrowserWorkspaceCandidate: vi.fn(),
  selectBrowserWorkspaceConnection: vi.fn(),
  subscribeBrowserWorkspaceRealtime: vi.fn()
}));

const connection = {
  id: "connection_1",
  label: "Local",
  serverUrl: "http://127.0.0.1:4318",
  workspaceId: "workspace_1",
  accountId: "account_1",
  publicKey: "public-key",
  createdAt: "2026-09-08T00:00:00.000Z",
  updatedAt: "2026-09-08T00:00:00.000Z"
};

const agentResource = {
  workspaceId: "workspace_1",
  id: "agent_resource_1",
  scope: { kind: "agent", agentId: "agent_1" },
  kind: "knowledge",
  knowledgeKind: "fact",
  title: "Agent fact",
  evidenceState: "confirmed",
  lifecycleState: "active",
  aiProtection: "editable",
  creationSource: "human",
  aiManaged: false,
  version: 1,
  createdBy: "account_1",
  updatedBy: "account_1",
  createdAt: "2026-09-17T00:00:00.000Z",
  updatedAt: "2026-09-17T00:00:00.000Z"
} as const;

const agentVersion = {
  workspaceId: "workspace_1",
  id: "agent_version_1",
  resourceId: "agent_resource_1",
  version: 1,
  contentHash: "hash",
  contentSize: 5,
  evidenceState: "confirmed",
  lifecycleState: "active",
  aiProtection: "editable",
  creationSource: "human",
  metadata: {},
  reason: "human edit",
  actorAccountId: "account_1",
  createdAt: "2026-09-17T00:00:00.000Z"
} as const;

beforeEach(() => {
  vi.clearAllMocks();
  updateActiveWorkspaceRoomId(undefined);
  vi.mocked(loadBrowserWorkspaceConnection).mockResolvedValue(connection);
  vi.mocked(loadBrowserWorkspaceConnections).mockResolvedValue([connection]);
});

afterEach(() => {
  updateActiveWorkspaceRoomId(undefined);
});

describe("Browser Room Work resource-ref transport", () => {
  it.each([
    ["public summary", { summary: "Geminiの実結果" }, "Geminiの実結果"],
    ["legacy output_summary", { output_summary: "旧形式の実結果" }, "旧形式の実結果"],
    ["nested result.output", { output: { output_summary: "ネストされた実結果" } }, "ネストされた実結果"]
  ])("preserves Agent completion text in the Native work projection (%s)", async (_label, assignmentResult, expectedSummary) => {
    vi.mocked(browserWorkspaceRequest).mockResolvedValue({
      result: [{
        id: "work_result_projection",
        room_id: "room_1",
        requester_id: "account_1",
        default_agent_id: "agent_1",
        title: "実結果",
        objective: "実結果を表示する",
        status: "completed",
        instruction_version: 1,
        generation: 0,
        version: 2,
        resource_refs: [],
        assignees: [{
          id: "assignee_result_projection",
          work_id: "work_result_projection",
          agent_id: "agent_1",
          status: "completed",
          instruction_version: 1,
          generation: 0,
          version: 2,
          result: assignmentResult,
          created_at: "2026-09-15T00:00:00.000Z",
          updated_at: "2026-09-15T00:00:01.000Z"
        }],
        created_at: "2026-09-15T00:00:00.000Z",
        updated_at: "2026-09-15T00:00:01.000Z"
      }]
    } as never);

    const bridge = createBrowserWorkspaceBridge();
    const projected = await bridge.listWorkspaceRoomWorks!({ roomId: "room_1" });

    expect(projected.works[0]?.assignees[0]).toMatchObject({
      result: { summary: expectedSummary }
    });
    expect(JSON.stringify(projected)).not.toContain("output_summary");
  });

  it("sends only Knowledge/Skill selectors and never client display metadata", async () => {
    vi.mocked(browserWorkspaceRequest).mockResolvedValue({
      result: {
        id: "work_1",
        room_id: "room_1",
        requester_id: "account_1",
        default_agent_id: "agent_1",
        title: "参照",
        objective: "Knowledgeを読む",
        status: "queued",
        instruction_version: 1,
        generation: 0,
        version: 1,
        resource_refs: [{ kind: "knowledge", id: "knowledge_policy", uri: "knowledge/policy.md", version: "3", label: "公開方針" }],
        assignees: [],
        created_at: "2026-09-08T00:00:00.000Z",
        updated_at: "2026-09-08T00:00:00.000Z"
      },
      replayed: false
    } as never);

    const bridge = createBrowserWorkspaceBridge();
    const result = await bridge.createWorkspaceRoomWork!({
      roomId: "room_1",
      instruction: "参照",
      resourceRefs: [{
        kind: "knowledge",
        id: " knowledge_policy ",
        version: 3
      }],
      operationId: "operation_1"
    });

    const request = vi.mocked(browserWorkspaceRequest).mock.calls[0]?.[0] as { body?: { input?: Record<string, unknown> } };
    expect(request.body?.input?.resource_refs).toEqual([{ kind: "knowledge", id: "knowledge_policy", version: 3 }]);
    expect(JSON.stringify(request.body)).not.toContain("uri");
    expect(JSON.stringify(request.body)).not.toContain("label");
    expect(result.resourceRefs).toEqual([{ kind: "knowledge", id: "knowledge_policy", uri: "knowledge/policy.md", version: "3", label: "公開方針" }]);
  });

  it("keeps attachments and resource refs separate in a reply projection", async () => {
    vi.mocked(browserWorkspaceRequest).mockResolvedValue({
      result: {
        id: "instruction_1",
        work_id: "work_1",
        kind: "reply",
        instruction: "確認",
        attachments: [{ kind: "file", id: "a".repeat(64), uri: "attachments/brief.pdf", version: "1", label: "brief.pdf" }],
        resource_refs: [{ kind: "skill", id: "skill_review", uri: "skills/review.md", version: "2", label: "レビュー" }],
        version: 2,
        generation: 0,
        status: "pending",
        created_by: "account_1",
        created_at: "2026-09-08T00:00:00.000Z",
        updated_at: "2026-09-08T00:00:00.000Z"
      },
      replayed: false
    } as never);

    const bridge = createBrowserWorkspaceBridge();
    const result = await bridge.replyWorkspaceRoomWork!({
      roomId: "room_1",
      workId: "work_1",
      resourceRefs: [{ kind: "skill", id: "skill_review", version: 2 }],
      operationId: "operation_2"
    });

    expect(result.attachments).toEqual([{ kind: "file", id: "a".repeat(64), uri: "attachments/brief.pdf", version: "1", label: "brief.pdf" }]);
    expect(result.resourceRefs).toEqual([{ kind: "skill", id: "skill_review", uri: "skills/review.md", version: "2", label: "レビュー" }]);
  });

  it.each([
    [{ kind: "knowledge", id: "", version: 1 }],
    [{ kind: "other", id: "resource_1", version: 1 }],
    [{ kind: "skill", id: "resource_1", version: 0 }],
    [{ kind: "skill", id: "resource_1", version: 1.5 }],
    [{ kind: "skill", id: "resource_1", version: "1" }]
  ])("rejects invalid resource selector %#", async (resourceRef) => {
    const bridge = createBrowserWorkspaceBridge();
    await expect(bridge.createWorkspaceRoomWork!({
      roomId: "room_1",
      resourceRefs: [resourceRef as never],
      operationId: "operation_invalid"
    })).rejects.toThrow("room_work_resource_ref_invalid");
    expect(browserWorkspaceRequest).not.toHaveBeenCalled();
  });

  it("binds collection requests to the explicit target and rejects a mismatched target before transport", async () => {
    vi.mocked(browserWorkspaceRequest).mockResolvedValue({ records: [] } as never);
    const bridge = createBrowserWorkspaceBridge();
    const target = { connectionId: "connection_1", workspaceId: "workspace_1" };

    await bridge.listWorkspaceCollectionRecords!({ roomId: "room_1", collectionId: "collection_1", target } as never);
    expect(vi.mocked(browserWorkspaceRequest).mock.calls[0]?.[0]).toMatchObject({
      method: "GET",
      connectionId: "connection_1",
      path: "/api/workspaces/workspace_1/collections/collection_1/records?room_id=room_1"
    });

    vi.clearAllMocks();
    await expect(bridge.createWorkspaceCollectionRecord!({
      roomId: "room_1",
      collectionId: "collection_1",
      recordId: "record_1",
      data: { ok: true },
      operationId: "collection_target_invalid",
      target: { connectionId: "connection_2", workspaceId: "workspace_2" }
    } as never)).rejects.toThrow("workspace_navigation_changed");
    expect(browserWorkspaceRequest).not.toHaveBeenCalled();
  });

  it("rejects a compatibility request whose Room context is stale before transport", async () => {
    updateActiveWorkspaceRoomId("room_1");
    const bridge = createBrowserWorkspaceBridge();

    await expect(bridge.createWorkspaceRoomWork!({
      roomId: "room_2",
      instruction: "stale",
      operationId: "stale_room_operation"
    })).rejects.toThrow("room_navigation_changed");
    expect(browserWorkspaceRequest).not.toHaveBeenCalled();
  });

  it("uses the available public v1 management routes with the same target", async () => {
    vi.mocked(browserWorkspaceRequest).mockResolvedValue({} as never);
    const bridge = createBrowserWorkspaceBridge();
    const target = { connectionId: "connection_1", workspaceId: "workspace_1" };

    const getWorkspaceSettings = bridge.getWorkspaceSettings as unknown as (input: unknown) => Promise<unknown>;
    await getWorkspaceSettings({ target });
    expect(vi.mocked(browserWorkspaceRequest).mock.calls.at(-1)?.[0]).toMatchObject({
      method: "GET",
      path: "/api/v1/workspaces/workspace_1/settings",
      connectionId: "connection_1"
    });

    await bridge.listWorkspaceCompletionResources!({ scopeKind: "room", roomId: "room_1", target } as never);
    expect(vi.mocked(browserWorkspaceRequest).mock.calls.at(-1)?.[0]).toMatchObject({
      method: "GET",
      path: "/api/v1/workspaces/workspace_1/completion/resources?scope_kind=room&room_id=room_1",
      connectionId: "connection_1"
    });

    await bridge.updateWorkspaceCompletionResource!({
      resourceId: "resource_1",
      scopeKind: "room",
      roomId: "room_1",
      kind: "knowledge",
      title: "Title",
      content: "Body",
      expectedVersion: 1,
      reason: "Update",
      operationId: "operation_1",
      target
    } as never);
    expect(vi.mocked(browserWorkspaceRequest).mock.calls.at(-1)?.[0]).toMatchObject({
      method: "PATCH",
      path: "/api/v1/workspaces/workspace_1/completion/resources/resource_1",
      connectionId: "connection_1"
    });

    await bridge.updateWorkspaceLearningSettings!({
      scopeKind: "room",
      roomId: "room_1",
      enabled: true,
      operationId: "learning_1",
      target
    } as never);
    expect(vi.mocked(browserWorkspaceRequest).mock.calls.at(-1)?.[0]).toMatchObject({
      method: "PATCH",
      path: "/api/v1/workspaces/workspace_1/learning/settings",
      connectionId: "connection_1"
    });

    await bridge.listWorkspaceAutomationJobs!({ roomId: "room_1", target } as never);
    expect(vi.mocked(browserWorkspaceRequest).mock.calls.at(-1)?.[0]).toMatchObject({
      method: "GET",
      path: "/api/v1/workspaces/workspace_1/automation/jobs?room_id=room_1",
      connectionId: "connection_1"
    });
  });

  it("uses DomainApiClient Agent completion routes with a fixed scope and operation id", async () => {
    vi.mocked(browserWorkspaceRequest)
      .mockResolvedValueOnce({ resources: [agentResource], next_cursor: "cursor_1" } as never)
      .mockResolvedValueOnce({ resource: agentResource, current_version: agentVersion, versions: [], evidence: [] } as never)
      .mockResolvedValueOnce({ resource: agentResource, version: agentVersion, content: "body" } as never)
      .mockResolvedValueOnce({ resource: agentResource, replayed: false } as never)
      .mockResolvedValueOnce({ resource: agentResource, replayed: false } as never)
      .mockResolvedValueOnce({ resource: agentResource, replayed: false } as never);
    const bridge = createBrowserWorkspaceBridge();
    const target = { connectionId: "connection_1", workspaceId: "workspace_1" };

    await bridge.listWorkspaceCompletionResources!({ scopeKind: "agent", agentId: "agent_1", target } as never);
    await bridge.getWorkspaceCompletionResource!({ scopeKind: "agent", agentId: "agent_1", resourceId: "agent_resource_1", target } as never);
    await bridge.getWorkspaceCompletionResourceBody!({ scopeKind: "agent", agentId: "agent_1", resourceId: "agent_resource_1", version: 1, target } as never);
    await bridge.createWorkspaceCompletionResource!({
      scopeKind: "agent", agentId: "agent_1", kind: "knowledge", knowledgeKind: "fact", title: "Fact", content: "body", reason: "create", operationId: "operation_1", target
    } as never);
    await bridge.updateWorkspaceCompletionResource!({
      scopeKind: "agent", agentId: "agent_1", resourceId: "agent_resource_1", kind: "knowledge", knowledgeKind: "fact", title: "Fact", content: "body", reason: "update", expectedVersion: 1, operationId: "operation_2", target
    } as never);
    await bridge.archiveWorkspaceCompletionResource!({
      scopeKind: "agent", agentId: "agent_1", resourceId: "agent_resource_1", archived: true, expectedVersion: 1, reason: "archive", operationId: "operation_3", target
    } as never);

    const calls = vi.mocked(browserWorkspaceRequest).mock.calls.map(([request]) => request as { method: string; path: string; body?: Record<string, unknown>; operationId?: string; idempotencyKey?: string });
    expect(calls[0]).toMatchObject({ method: "GET", path: "/api/v1/workspaces/workspace_1/completion/resources?scope_kind=agent&agent_id=agent_1", connectionId: "connection_1" });
    expect(calls[1]?.path).toBe("/api/v1/workspaces/workspace_1/completion/resources/agent_resource_1?scope_kind=agent&agent_id=agent_1");
    expect(calls[2]?.path).toBe("/api/v1/workspaces/workspace_1/completion/resources/agent_resource_1/body?scope_kind=agent&agent_id=agent_1&version=1");
    expect(calls[3]).toMatchObject({ method: "POST", path: "/api/v1/workspaces/workspace_1/completion/resources", operationId: "operation_1", idempotencyKey: "operation_1", body: { scope_kind: "agent", agent_id: "agent_1", kind: "knowledge" } });
    expect(calls[4]).toMatchObject({ method: "PATCH", operationId: "operation_2", idempotencyKey: "operation_2", body: { scope_kind: "agent", agent_id: "agent_1", expected_version: 1 } });
    expect(calls[5]).toMatchObject({ method: "POST", path: "/api/v1/workspaces/workspace_1/completion/resources/agent_resource_1/archive", operationId: "operation_3", idempotencyKey: "operation_3", body: { scope_kind: "agent", agent_id: "agent_1", archived: true, expected_version: 1 } });
  });

  it("rejects Agent scope mixing, unknown fields, stale targets, and unsafe responses", async () => {
    const bridge = createBrowserWorkspaceBridge();
    const target = { connectionId: "connection_1", workspaceId: "workspace_1" };
    for (const input of [
      { scopeKind: "agent", resourceId: "agent_resource_1" },
      { scopeKind: "agent", agentId: "agent_1", roomId: "room_1" },
      { scopeKind: "agent", agentId: "agent_1", unknown: true },
      { scopeKind: "room", roomId: "room_1", agentId: "agent_1", resourceId: "resource_1" }
    ]) {
      await expect(bridge.listWorkspaceCompletionResources!(input as never)).rejects.toThrow();
    }
    expect(browserWorkspaceRequest).not.toHaveBeenCalled();

    await expect(bridge.listWorkspaceCompletionResources!({ scopeKind: "agent", agentId: "agent_1", target: { ...target, workspaceId: "workspace_other" } } as never)).rejects.toThrow("workspace_navigation_changed");
    expect(browserWorkspaceRequest).not.toHaveBeenCalled();

    vi.mocked(browserWorkspaceRequest).mockResolvedValueOnce({ resources: [{ ...agentResource, scope: { kind: "agent", agentId: "agent_other" } }] } as never);
    await expect(bridge.listWorkspaceCompletionResources!({ scopeKind: "agent", agentId: "agent_1", target } as never)).rejects.toThrow("completion_agent_response_scope_invalid");

    vi.mocked(browserWorkspaceRequest).mockResolvedValueOnce({ resources: [{ ...agentResource, source: "private" }] } as never);
    await expect(bridge.listWorkspaceCompletionResources!({ scopeKind: "agent", agentId: "agent_1", target } as never)).rejects.toThrow("completion_agent_response_invalid");
  });
});

describe("Browser Room capability projection", () => {
  it("preserves the server-provided Room edit capability", async () => {
    vi.mocked(browserWorkspaceRequest).mockResolvedValue({
      result: [{
        id: "room_edit_capability",
        workspace_id: "workspace_1",
        name: "Editable Room",
        version: 1,
        can_manage: false,
        can_edit: false,
        can_execute: true,
        created_at: "2026-09-15T00:00:00.000Z",
        updated_at: "2026-09-15T00:00:00.000Z"
      }]
    } as never);

    const bridge = createBrowserWorkspaceBridge();
    const result = await bridge.listWorkspaceRooms!();

    expect(result.rooms[0]).toMatchObject({ canManage: false, canEdit: false, canExecute: true });
  });

  it("preserves a false Server-provided execute capability on a newly created Room", async () => {
    vi.mocked(browserWorkspaceRequest).mockResolvedValue({
      result: {
        id: "room_created_capability",
        workspace_id: "workspace_1",
        name: "Created Room",
        version: 1,
        can_manage: true,
        can_edit: false,
        can_execute: false,
        created_at: "2026-09-15T00:00:00.000Z",
        updated_at: "2026-09-15T00:00:00.000Z"
      },
      replayed: false
    } as never);

    const bridge = createBrowserWorkspaceBridge();
    const result = await bridge.createWorkspaceRoom!({
      name: "Created Room",
      target: { connectionId: "connection_1", workspaceId: "workspace_1" },
      expectedWorkspaceVersion: 1,
      defaultAgentId: "agent_1",
      agentPermission: { canView: true, canEdit: false, canExecute: true },
      operationId: "room_create_capability"
    } as never);

    expect(result.room).toMatchObject({ canManage: true, canEdit: false, canExecute: false });
  });
});

describe("Browser Workspace Context Domain bridge", () => {
  const target = { connectionId: "connection_1", workspaceId: "workspace_1" };
  const timestamp = "2026-09-17T00:00:00.000Z";

  it("sends a strict personal preference snapshot only in chat.turn.run input", async () => {
    vi.mocked(browserWorkspaceRequest).mockResolvedValue({ result: {} } as never);
    const bridge = createBrowserWorkspaceBridge();
    const personalPreferences = {
      schema_version: 1 as const,
      revision: 4,
      display_name: "登録名",
      output_locale: "ja" as const,
      instructions: "簡潔に"
    };

    await bridge.sendWorkspaceChatMessage!({
      sessionId: "session_1",
      content: "本文",
      idempotencyKey: "turn_prefs",
      outputLocale: "ja",
      metadata: { public: "not preferences" },
      personalPreferences,
      target
    });

    const request = vi.mocked(browserWorkspaceRequest).mock.calls[0]?.[0] as {
      path: string;
      body?: { input?: Record<string, unknown> };
    };
    expect(request.path).toBe("/api/v1/workspaces/workspace_1/domain/operations/chat.turn.run");
    expect(request.body?.input?.personal_preferences).toEqual(personalPreferences);
    expect(request.body?.input).not.toHaveProperty("account_id");
    expect(request.body?.input).not.toHaveProperty("personalPreferences");
    expect(request.body?.input).toMatchObject({ metadata: { public: "not preferences" } });
    expect(JSON.stringify(request.body?.input?.metadata)).not.toContain("personal_preferences");
  });

  it.each([
    ["account_id", { account_id: "account_other" }],
    ["authorization", { authorization: { canExecute: true } }],
    ["connection_id", { connection_id: "connection_other" }],
    ["share_id", { share_id: "share_other" }],
    ["updated_at", { updated_at: "2026-09-17T00:00:00.000Z" }],
    ["unknown", { future_key: true }]
  ])("rejects personal preference field %s before transport", async (_name, extra) => {
    const bridge = createBrowserWorkspaceBridge();
    await expect(bridge.sendWorkspaceChatMessage!({
      sessionId: "session_1",
      content: "本文",
      idempotencyKey: "turn_prefs_invalid",
      outputLocale: "ja",
      personalPreferences: {
        schema_version: 1,
        revision: 4,
        display_name: "登録名",
        output_locale: "ja",
        instructions: "簡潔に",
        ...extra
      } as never,
      target
    })).rejects.toThrow("personal_preferences_invalid");
    expect(browserWorkspaceRequest).not.toHaveBeenCalled();
  });

  it("calls workspace.search through the selected Workspace Domain path and sanitizes targets", async () => {
    vi.mocked(browserWorkspaceRequest).mockResolvedValue({
      api_version: "1",
      request_id: "request_search",
      replayed: false,
      result: {
        items: [{
          type: "conversation",
          id: "conversation_1",
          room_id: "room_1",
          title: "議事録",
          snippet: "公開された抜粋",
          updated_at: timestamp,
          target: { kind: "work", room_id: "room_1", work_id: "work_1" }
        }],
        next_cursor: null
      }
    } as never);

    const bridge = createBrowserWorkspaceBridge();
    const result = await bridge.searchWorkspaceContext!({
      query: " 議事録 ",
      types: ["conversation"],
      target
    });

    expect(vi.mocked(browserWorkspaceRequest).mock.calls[0]?.[0]).toMatchObject({
      method: "POST",
      path: "/api/v1/workspaces/workspace_1/domain/queries/workspace.search",
      connectionId: "connection_1",
      workspaceScoped: true,
      body: { context: {}, input: { q: "議事録", types: ["conversation"] } }
    });
    expect(result).toEqual({
      items: [{
        type: "conversation",
        id: "conversation_1",
        roomId: "room_1",
        title: "議事録",
        snippet: "公開された抜粋",
        updatedAt: timestamp,
        target: { kind: "work", roomId: "room_1", workId: "work_1" }
      }],
      nextCursor: null
    });
  });

  it("uses Account Domain paths without Workspace routing for summaries and invitation operations", async () => {
    vi.mocked(browserWorkspaceRequest)
      .mockResolvedValueOnce({
        result: { items: [{ workspace_id: "workspace_1", unread_count: 2, as_of: timestamp }] }
      } as never)
      .mockResolvedValueOnce({
        result: {
          items: [{
            id: "notification_invitation",
            kind: "invitation",
            created_at: timestamp,
            read_at: null,
            title: "招待があります",
            summary: "招待内容を確認してください",
            target: { kind: "invitation", invitation_id: "invitation_1" },
            action_state: "pending"
          }],
          next_cursor: null
        }
      } as never)
      .mockResolvedValueOnce({
        result: { updated_ids: ["notification_invitation"], already_read_ids: [], read_at: timestamp }
      } as never);

    const bridge = createBrowserWorkspaceBridge();
    await expect(bridge.getAccountWorkspaceNotificationSummaries!({ workspaceIds: ["workspace_1"], target })).resolves.toEqual({
      items: [{ workspaceId: "workspace_1", unreadCount: 2, asOf: timestamp }]
    });
    await expect(bridge.listAccountInvitationNotifications!({ target })).resolves.toMatchObject({
      items: [{ id: "notification_invitation", kind: "invitation", target: { kind: "invitation", invitationId: "invitation_1" } }],
      nextCursor: null
    });
    await expect(bridge.markAccountInvitationNotificationsRead!({
      notificationIds: ["notification_invitation"],
      operationId: "notification_read_1",
      target
    })).resolves.toEqual({ updatedIds: ["notification_invitation"], alreadyReadIds: [], readAt: timestamp });

    const calls = vi.mocked(browserWorkspaceRequest).mock.calls.map(([request]) => request as { path: string; workspaceScoped?: boolean; operationId?: string; idempotencyKey?: string });
    expect(calls[0]).toMatchObject({ path: "/api/v1/domain/queries/account.workspace_notification_summaries" });
    expect(calls[0]?.workspaceScoped).toBeUndefined();
    expect(calls[1]).toMatchObject({ path: "/api/v1/domain/queries/account.invitation_notifications" });
    expect(calls[1]?.workspaceScoped).toBeUndefined();
    expect(calls[2]).toMatchObject({
      path: "/api/v1/domain/operations/account.invitation_notification_read",
      operationId: "notification_read_1",
      idempotencyKey: "notification_read_1"
    });
    expect(calls[2]?.workspaceScoped).toBeUndefined();
  });

  it("uses Workspace Domain paths for notification list, summary, and read", async () => {
    vi.mocked(browserWorkspaceRequest)
      .mockResolvedValueOnce({ result: { items: [], next_cursor: null } } as never)
      .mockResolvedValueOnce({ result: { unread_count: 0, as_of: timestamp } } as never)
      .mockResolvedValueOnce({ result: { updated_ids: ["notification_1"], already_read_ids: [], read_at: timestamp } } as never);

    const bridge = createBrowserWorkspaceBridge();
    await expect(bridge.listWorkspaceNotifications!({ unreadOnly: true, limit: 10, target })).resolves.toEqual({ items: [], nextCursor: null });
    await expect(bridge.getWorkspaceNotificationSummary!({ target })).resolves.toEqual({ unreadCount: 0, asOf: timestamp });
    await expect(bridge.markWorkspaceNotificationsRead!({ notificationIds: ["notification_1"], operationId: "notification_read_2", target })).resolves.toEqual({
      updatedIds: ["notification_1"],
      alreadyReadIds: [],
      readAt: timestamp
    });

    const calls = vi.mocked(browserWorkspaceRequest).mock.calls.map(([request]) => request as { path: string; workspaceScoped?: boolean; operationId?: string; idempotencyKey?: string; body?: unknown });
    expect(calls[0]).toMatchObject({
      path: "/api/v1/workspaces/workspace_1/domain/queries/notification.list",
      workspaceScoped: true,
      body: { context: {}, input: { unread_only: true, limit: 10 } }
    });
    expect(calls[1]).toMatchObject({
      path: "/api/v1/workspaces/workspace_1/domain/queries/notification.summary",
      workspaceScoped: true,
      body: { context: {}, input: {} }
    });
    expect(calls[2]).toMatchObject({
      path: "/api/v1/workspaces/workspace_1/domain/operations/notification.mark_read",
      workspaceScoped: true,
      operationId: "notification_read_2",
      idempotencyKey: "notification_read_2",
      body: { context: {}, input: { notification_ids: ["notification_1"] } }
    });
  });

  it("rejects a response completed after the target snapshot becomes stale", async () => {
    vi.mocked(browserWorkspaceRequest).mockResolvedValue({
      result: { items: [], next_cursor: null }
    } as never);
    vi.mocked(loadBrowserWorkspaceConnection).mockReset()
      .mockResolvedValueOnce(connection)
      .mockResolvedValueOnce(connection)
      .mockResolvedValueOnce(connection)
      .mockResolvedValueOnce({ ...connection, workspaceId: "workspace_2" });

    const bridge = createBrowserWorkspaceBridge();
    await expect(bridge.listWorkspaceNotifications!({ target })).rejects.toThrow("workspace_navigation_changed");
    expect(browserWorkspaceRequest).toHaveBeenCalledTimes(1);
  });

  it("strictly rejects internal fields, preserves unknown notification kinds, and propagates failures", async () => {
    vi.mocked(browserWorkspaceRequest).mockResolvedValueOnce({
      result: {
        items: [{
          id: "notification_unknown",
          kind: "future_kind",
          created_at: timestamp,
          read_at: null,
          title: "新しい通知",
          summary: "安全な概要",
          target: { kind: "room", room_id: "room_1" },
          action_state: "not_required"
        }],
        next_cursor: null
      }
    } as never);
    const bridge = createBrowserWorkspaceBridge();
    const unknown = await bridge.listWorkspaceNotifications!({ target });
    expect(unknown.items[0]).toMatchObject({ id: "notification_unknown", kind: "future_kind", target: { kind: "room", roomId: "room_1" } });
    expect(JSON.stringify(unknown)).not.toContain("source_id");
    expect(JSON.stringify(unknown)).not.toContain("recipient_account_id");

    vi.mocked(browserWorkspaceRequest).mockResolvedValueOnce({
      result: {
        items: [{
          id: "notification_internal",
          kind: "work_completed",
          created_at: timestamp,
          read_at: null,
          title: "仕事",
          summary: "概要",
          target: { kind: "work", room_id: "room_1", work_id: "work_1" },
          action_state: "not_required",
          source_id: "internal_source"
        }],
        next_cursor: null
      }
    } as never);
    await expect(bridge.listWorkspaceNotifications!({ target })).rejects.toThrow("workspace_notification_response_invalid");

    vi.mocked(browserWorkspaceRequest).mockRejectedValueOnce(new Error("network_down"));
    await expect(bridge.listWorkspaceNotifications!({ target })).rejects.toThrow("network_down");
  });
});

describe("Browser Workspace Share Domain bridge", () => {
  const contentHash = "a".repeat(64);
  const manifest = {
    format_version: 1 as const,
    kind: "room_knowledge" as const,
    title: "共有用 Knowledge",
    entries: [{
      entry_id: "entry_public_1",
      kind: "knowledge" as const,
      title: "公開方針",
      content: "共有本文",
      knowledge_kind: "fact" as const,
      files: []
    }]
  };
  const draft = {
    draft_id: "draft_public_1",
    version: 1,
    manifest,
    content_hash: contentHash,
    visibility: "restricted" as const,
    recipient_account_ids: ["recipient_internal_1"],
    removed_references: [{ entry_id: "entry_removed", location: "source/internal", reason: "権限" }]
  };
  const shareSummary = {
    share_id: "share_public_1",
    version: 1,
    title: "共有用 Knowledge",
    status: "active" as const,
    visibility: "restricted" as const,
    recipient_account_ids: ["recipient_internal_1"],
    url: `https://share.example/s/${"b".repeat(43)}`,
    created_at: "2026-09-17T00:00:00.000Z",
    published_at: "2026-09-17T00:00:01.000Z",
    revoked_at: null
  };
  const stagingImport = {
    import_id: "import_public_1",
    kind: "room_knowledge" as const,
    status: "staging" as const,
    phase: "fetch" as const,
    retryable: true,
    failure_code: null,
    created_resource_ids: [],
    created_agent_id: null,
    committed_at: null
  };
  const updateManifest = {
    formatVersion: 1 as const,
    kind: "room_knowledge" as const,
    title: "更新後の共有用 Knowledge",
    entries: [{
      entryId: "entry_public_1",
      kind: "knowledge" as const,
      title: "公開方針",
      content: "更新本文",
      knowledgeKind: "fact" as const,
      files: []
    }]
  };

  it("uses fixed Share Domain methods and exposes only safe projections", async () => {
    vi.mocked(browserWorkspaceRequest)
      .mockResolvedValueOnce({ result: draft } as never)
      .mockResolvedValueOnce({ result: draft } as never)
      .mockResolvedValueOnce({ result: { items: [shareSummary], next_cursor: null } } as never)
      .mockResolvedValueOnce({ result: { share_id: "share_public_1", version: 1, url: `https://share.example/s/${"c".repeat(43)}`, content_hash: contentHash, published_at: "2026-09-17T00:00:02.000Z" } } as never)
      .mockResolvedValueOnce({ result: { share_id: "share_public_1", version: 2, status: "revoked", revoked_at: "2026-09-17T00:00:03.000Z" } } as never);
    const bridge = createBrowserWorkspaceBridge();
    const target = { connectionId: "connection_1", workspaceId: "workspace_1" };

    const created = await bridge.createWorkspaceShareDraft!({
      sourceKind: "room_knowledge",
      sourceId: "room_source_1",
      resourceRefs: [{ id: "knowledge_1", version: 2 }],
      operationId: "share_create_1",
      target
    });
    const viewed = await bridge.viewWorkspaceShareDraft!({ draftId: "draft_public_1", target });
    const listed = await bridge.listWorkspaceShares!({ sourceKind: "room_knowledge", sourceId: "room_source_1", target });
    const published = await bridge.publishWorkspaceShare!({ draftId: "draft_public_1", expectedVersion: 1, expectedContentHash: contentHash, operationId: "share_publish_1", target });
    const revoked = await bridge.revokeWorkspaceShare!({ shareId: "share_public_1", expectedVersion: 1, operationId: "share_revoke_1", target });

    expect(created).toMatchObject({ draftId: "draft_public_1", recipientCount: 1, removedReferenceCount: 1 });
    expect(created).not.toHaveProperty("recipientAccountIds");
    expect(created).not.toHaveProperty("removedReferences");
    expect(listed.items[0]).toMatchObject({ shareId: "share_public_1", recipientCount: 1 });
    expect(listed.items[0]).not.toHaveProperty("url");
    expect(listed.items[0]).not.toHaveProperty("recipientAccountIds");
    expect(viewed.manifest.entries[0]).toMatchObject({ entryId: "entry_public_1", content: "共有本文" });
    expect(published.url).toMatch(/^https:\/\/share\.example\/s\/[A-Za-z0-9_-]{43}$/);
    expect(revoked).toMatchObject({ shareId: "share_public_1", status: "revoked" });

    const calls = vi.mocked(browserWorkspaceRequest).mock.calls.map(([request]) => request as { method: string; path: string; operationId?: string; idempotencyKey?: string; workspaceScoped?: boolean; body?: { input?: Record<string, unknown> } });
    expect(calls.map((call) => call.path)).toEqual([
      "/api/v1/workspaces/workspace_1/domain/operations/share.draft.create",
      "/api/v1/workspaces/workspace_1/domain/queries/share.draft.view",
      "/api/v1/workspaces/workspace_1/domain/queries/share.list",
      "/api/v1/workspaces/workspace_1/domain/operations/share.publish",
      "/api/v1/workspaces/workspace_1/domain/operations/share.revoke"
    ]);
    expect(calls[0]).toMatchObject({ operationId: "share_create_1", idempotencyKey: "share_create_1", workspaceScoped: true });
    expect(calls[3]).toMatchObject({ operationId: "share_publish_1", idempotencyKey: "share_publish_1", workspaceScoped: true });
    expect(calls[4]).toMatchObject({ operationId: "share_revoke_1", idempotencyKey: "share_revoke_1", workspaceScoped: true });
    expect(calls.every((call) => !JSON.stringify(call).includes("recipient_internal_1"))).toBe(true);
  });

  it("views a strict HTTPS share link through the fixed source API", async () => {
    const sourceUrl = `https://source.example/s/${"s".repeat(43)}`;
    vi.mocked(browserShareSourceRequest).mockResolvedValue({
      status: 200,
      body: {
        title: "公開共有",
        visibility: "public",
        manifest,
        content_hash: contentHash,
        published_at: "2026-09-17T00:00:00.000Z"
      }
    });
    const bridge = createBrowserWorkspaceBridge();
    const result = await bridge.viewWorkspaceShareLink!({
      sourceUrl,
      target: { connectionId: "connection_1", workspaceId: "workspace_1" }
    });

    expect(result).toMatchObject({ sourceUrl, sourceOrigin: "https://source.example/", locator: "s".repeat(43), title: "公開共有", contentHash });
    expect(result).not.toHaveProperty("shareId");
    expect(vi.mocked(browserShareSourceRequest)).toHaveBeenCalledWith({
      connectionId: "connection_1",
      operation: "view",
      sourceOrigin: "https://source.example/",
      locator: "s".repeat(43)
    });
  });

  it("claims and imports a link with the same operation id while preserving staging", async () => {
    const targetConnection = { ...connection, serverUrl: "https://target.example/" };
    vi.mocked(loadBrowserWorkspaceConnection).mockResolvedValue(targetConnection);
    vi.mocked(loadBrowserWorkspaceConnections).mockResolvedValue([targetConnection]);
    const sourceUrl = `https://source.example/s/${"t".repeat(43)}`;
    const operationId = "share_link_import_1";
    vi.mocked(browserShareSourceRequest)
      .mockResolvedValueOnce({
        status: 200,
        body: {
          title: "限定共有",
          visibility: "restricted",
          manifest,
          content_hash: contentHash,
          published_at: "2026-09-17T00:00:00.000Z"
        }
      })
      .mockResolvedValueOnce({
        status: 201,
        body: {
          claim_id: "claim_link_1",
          share_id: "share_link_1",
          recipient_account_id: "account_1",
          target_origin: "https://target.example/",
          target_workspace_id: "workspace_1",
          operation_id: operationId,
          content_hash: contentHash,
          created_at: "2026-09-17T00:00:01.000Z"
        }
      });
    vi.mocked(createBrowserShareDelegation).mockResolvedValue({
      payload: {
        version: 1,
        source_origin: "https://source.example/",
        share_id: "share_link_1",
        claim_id: "claim_link_1",
        recipient_account_id: "account_1",
        target_origin: "https://target.example/",
        target_workspace_id: "workspace_1",
        operation_id: operationId,
        content_hash: contentHash,
        issued_at: "2026-09-17T00:00:02.000Z",
        expires_at: "2026-09-17T00:04:02.000Z"
      },
      publicKey: "public-key",
      signature: "delegation-signature"
    });
    vi.mocked(browserWorkspaceRequest).mockResolvedValue({ result: stagingImport } as never);

    const bridge = createBrowserWorkspaceBridge();
    const result = await bridge.importWorkspaceShareLink!({
      sourceUrl,
      operationId,
      target: { connectionId: "connection_1", workspaceId: "workspace_1" }
    });

    expect(result).toMatchObject({ status: "staging", phase: "fetch" });
    expect(vi.mocked(browserShareSourceRequest).mock.calls[1]?.[0]).toMatchObject({
      operation: "claim",
      operationId,
      body: {
        target_origin: "https://target.example/",
        target_workspace_id: "workspace_1",
        operation_id: operationId,
        content_hash: contentHash
      }
    });
    expect(vi.mocked(browserWorkspaceRequest).mock.calls[0]?.[0]).toMatchObject({
      path: "/api/v1/workspaces/workspace_1/domain/operations/share.import",
      operationId,
      idempotencyKey: operationId,
      body: { input: { source_origin: "https://source.example/", locator: "t".repeat(43), claim_id: "claim_link_1", content_hash: contentHash } }
    });
    expect(JSON.stringify(result)).not.toContain("delegation-signature");
  });

  it("rejects unsafe link syntax and mismatched targets before source transport", async () => {
    const bridge = createBrowserWorkspaceBridge();
    const unsafe = [
      "/s/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      `http://source.example/s/${"u".repeat(43)}`,
      `https://source.example/s/${"u".repeat(43)}?x=1`,
      `https://user:pass@source.example/s/${"u".repeat(43)}`,
      `https://source.example/s/${"u".repeat(42)}`
    ];
    for (const sourceUrl of unsafe) {
      await expect(bridge.viewWorkspaceShareLink!({ sourceUrl, target: { connectionId: "connection_1", workspaceId: "workspace_1" } })).rejects.toThrow();
    }
    await expect(bridge.viewWorkspaceShareLink!({
      sourceUrl: `https://source.example/s/${"u".repeat(43)}`,
      target: { connectionId: "connection_other", workspaceId: "workspace_other" }
    })).rejects.toThrow("workspace_navigation_changed");
    expect(browserShareSourceRequest).not.toHaveBeenCalled();
  });

  it("does not accept an arbitrary target Room when no Room is selected", async () => {
    const bridge = createBrowserWorkspaceBridge();
    await expect(bridge.importWorkspaceShareLink!({
      sourceUrl: `https://source.example/s/${"r".repeat(43)}`,
      targetRoomId: "room_not_selected",
      operationId: "share_link_import_no_room",
      target: { connectionId: "connection_1", workspaceId: "workspace_1" }
    })).rejects.toThrow("room_navigation_changed");
    expect(browserShareSourceRequest).not.toHaveBeenCalled();
  });

  it("rejects a stale selection generation before signing the source request", async () => {
    const bridge = createBrowserWorkspaceBridge();
    await expect(bridge.viewWorkspaceShareLink!({
      sourceUrl: `https://source.example/s/${"g".repeat(43)}`,
      target: { connectionId: "connection_1", workspaceId: "workspace_1", selectionGeneration: 999 }
    })).rejects.toThrow("workspace_navigation_changed");
    expect(browserShareSourceRequest).not.toHaveBeenCalled();
  });

  it("rechecks the target after source view and never claims after a Room change", async () => {
    vi.mocked(browserShareSourceRequest).mockImplementation(async (input) => {
      if (input.operation === "view") {
        updateActiveWorkspaceRoomId("room_changed_during_view");
        return {
          status: 200,
          body: {
            title: "公開共有",
            visibility: "public",
            manifest,
            content_hash: contentHash,
            published_at: "2026-09-17T00:00:00.000Z"
          }
        };
      }
      return { status: 201, body: {} };
    });
    const bridge = createBrowserWorkspaceBridge();
    await expect(bridge.importWorkspaceShareLink!({
      sourceUrl: `https://source.example/s/${"c".repeat(43)}`,
      operationId: "share_link_import_room_change",
      target: { connectionId: "connection_1", workspaceId: "workspace_1" }
    })).rejects.toThrow("room_navigation_changed");
    expect(vi.mocked(browserShareSourceRequest).mock.calls.map(([input]) => input.operation)).toEqual(["view"]);
  });

  it("keeps import staging explicit and sends the delegation only to the selected Workspace", async () => {
    vi.mocked(loadBrowserWorkspaceConnection).mockResolvedValue({ ...connection, serverUrl: "https://target.example/" });
    vi.mocked(browserWorkspaceRequest).mockResolvedValue({ result: stagingImport } as never);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const bridge = createBrowserWorkspaceBridge();
    const operationId = "share_import_1";
    const delegation = {
      payload: {
        version: 1 as const,
        sourceOrigin: "https://source.example/",
        shareId: "share_public_1",
        claimId: "claim_public_1",
        recipientAccountId: "account_1",
        targetOrigin: "https://target.example/",
        targetWorkspaceId: "workspace_1",
        operationId,
        contentHash,
        issuedAt: "2026-09-17T00:00:00.000Z",
        expiresAt: "2026-09-17T00:05:00.000Z"
      },
      publicKey: "public-key",
      signature: "signed-delegation"
    };

    const result = await bridge.importWorkspaceShare!({
      sourceOrigin: "https://source.example/",
      locator: "d".repeat(43),
      claimId: "claim_public_1",
      contentHash,
      delegation,
      targetRoomId: "room_target_1",
      operationId,
      target: { connectionId: "connection_1", workspaceId: "workspace_1" }
    });

    expect(result).toMatchObject({ status: "staging", phase: "fetch" });
    const request = vi.mocked(browserWorkspaceRequest).mock.calls[0]?.[0] as { path: string; body?: { input?: Record<string, unknown> } };
    expect(request.path).toBe("/api/v1/workspaces/workspace_1/domain/operations/share.import");
    expect(request.body?.input).toMatchObject({ source_origin: "https://source.example/", locator: "d".repeat(43), target_room_id: "room_target_1" });
    expect(request.path).not.toContain("source.example");
    expect(JSON.stringify(result)).not.toContain("signed-delegation");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses fixed update/discard Domain operations with strict manifest and recipient validation", async () => {
    vi.mocked(browserWorkspaceRequest)
      .mockResolvedValueOnce({ result: { ...draft, version: 2, manifest: { ...manifest, title: "更新後の共有用 Knowledge", entries: [{ ...manifest.entries[0], content: "更新本文" }] } } } as never)
      .mockResolvedValueOnce({ result: { draft_id: "draft_public_1", discarded: true } } as never);
    const bridge = createBrowserWorkspaceBridge();
    const target = { connectionId: "connection_1", workspaceId: "workspace_1" };
    const updated = await bridge.updateWorkspaceShareDraft!({
      draftId: "draft_public_1",
      expectedVersion: 1,
      manifest: updateManifest,
      visibility: "restricted",
      recipientAccountIds: ["recipient_internal_1"],
      operationId: "share_update_1",
      target
    });
    const discarded = await bridge.discardWorkspaceShareDraft!({ draftId: "draft_public_1", expectedVersion: 2, operationId: "share_discard_1", target });
    expect(updated).toMatchObject({ draftId: "draft_public_1", version: 2, recipientCount: 1 });
    expect(discarded).toEqual({ draftId: "draft_public_1", discarded: true });
    expect(JSON.stringify(updated)).not.toContain("recipient_internal_1");
    const calls = vi.mocked(browserWorkspaceRequest).mock.calls.map(([request]) => request as { path: string; operationId?: string; idempotencyKey?: string; body?: { input?: Record<string, unknown> } });
    expect(calls[0]).toMatchObject({
      path: "/api/v1/workspaces/workspace_1/domain/operations/share.draft.update",
      operationId: "share_update_1",
      idempotencyKey: "share_update_1",
      body: { input: { draft_id: "draft_public_1", expected_version: 1, visibility: "restricted", recipient_account_ids: ["recipient_internal_1"] } }
    });
    expect(calls[0]?.body?.input?.manifest).toMatchObject({ format_version: 1, title: "更新後の共有用 Knowledge" });
    expect(calls[1]).toMatchObject({
      path: "/api/v1/workspaces/workspace_1/domain/operations/share.draft.discard",
      operationId: "share_discard_1",
      idempotencyKey: "share_discard_1",
      body: { input: { draft_id: "draft_public_1", expected_version: 2 } }
    });

    for (const invalid of [
      { draftId: "draft_public_1", expectedVersion: 1, manifest: updateManifest, visibility: "restricted", recipientAccountIds: ["recipient_internal_1", "recipient_internal_1"], operationId: "share_update_invalid", target },
      { draftId: "draft_public_1", expectedVersion: 1, manifest: { ...updateManifest, entries: [{ ...updateManifest.entries[0], content: "" }] }, visibility: "restricted", recipientAccountIds: [], operationId: "share_update_invalid", target },
      { draftId: "draft_public_1", expectedVersion: 1, manifest: updateManifest, visibility: "other", recipientAccountIds: [], operationId: "share_update_invalid", target },
      { draftId: "draft_public_1", expectedVersion: 1, manifest: updateManifest, visibility: "restricted", recipientAccountIds: [], operationId: "share_update_invalid", accountId: "other", target }
    ]) {
      await expect(bridge.updateWorkspaceShareDraft!(invalid as never)).rejects.toThrow();
    }
    await expect(bridge.discardWorkspaceShareDraft!({ draftId: "draft_public_1", expectedVersion: 1, operationId: "share_discard_invalid", target, unknown: true } as never)).rejects.toThrow("workspace_share_input_invalid");
  });

  it("rejects arbitrary target fields, unsafe share URLs, and a target that changes in flight", async () => {
    const bridge = createBrowserWorkspaceBridge();
    await expect(bridge.createWorkspaceShareDraft!({
      baseShareId: "share_public_1",
      operationId: "share_create_invalid",
      workspaceId: "workspace_attacker" as never
    } as never)).rejects.toThrow("workspace_share_input_invalid");
    expect(browserWorkspaceRequest).not.toHaveBeenCalled();

    vi.mocked(browserWorkspaceRequest).mockResolvedValue({ result: { items: [{ ...shareSummary, url: "https://evil.example/not-a-share" }], next_cursor: null } } as never);
    await expect(bridge.listWorkspaceShares!({ sourceKind: "room_knowledge", sourceId: "room_source_1" })).rejects.toThrow("share_summary_url_invalid");

    vi.clearAllMocks();
    vi.mocked(loadBrowserWorkspaceConnection)
      .mockResolvedValueOnce(connection)
      .mockResolvedValueOnce({ ...connection, workspaceId: "workspace_changed" });
    await expect(bridge.listWorkspaceShares!({ sourceKind: "room_knowledge", sourceId: "room_source_1" })).rejects.toThrow("workspace_navigation_changed");
    expect(browserWorkspaceRequest).not.toHaveBeenCalled();
  });

  it("rejects strict response extras instead of passing internal fields through", async () => {
    vi.mocked(browserWorkspaceRequest).mockResolvedValue({ result: { ...draft, source_id: "internal_source" } } as never);
    const bridge = createBrowserWorkspaceBridge();
    await expect(bridge.viewWorkspaceShareDraft!({ draftId: "draft_public_1" })).rejects.toThrow("workspace_share_draft_response_invalid");
  });

  it("uses a fixed status query and does not turn staging into success", async () => {
    vi.mocked(browserWorkspaceRequest).mockResolvedValue({ result: stagingImport } as never);
    const bridge = createBrowserWorkspaceBridge();
    const result = await bridge.getWorkspaceShareImportStatus!({ operationId: "share_import_1" });
    expect(result.status).toBe("staging");
    expect(vi.mocked(browserWorkspaceRequest).mock.calls[0]?.[0]).toMatchObject({
      method: "POST",
      path: "/api/v1/workspaces/workspace_1/domain/queries/share.import.status",
      workspaceScoped: true
    });
  });
});

function interactionRequestFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: "interaction_1",
    workspaceId: "workspace_1",
    roomId: "room_1",
    version: 3,
    kind: "backend_input",
    status: "pending",
    title: "入力が必要です",
    summary: "公開情報だけを入力してください",
    runId: "run_1",
    surfaceId: "surface_1",
    revisionId: "revision_1",
    actionTarget: { actionId: "publish", target: "artifact_1", input: { secret: "must-not-cross" } },
    options: [{ id: "submit", label: "送信", decision: "submit_input", description: "入力を送信" }],
    inputSchema: {
      type: "object",
      properties: { answer: { type: "string", title: "回答", minLength: 1 } },
      required: ["answer"],
      additionalProperties: false
    },
    expiresAt: "2026-09-08T01:00:00.000Z",
    outcome: { kind: "response", optionId: "submit", decision: "submit_input", decidedAt: "2026-09-08T00:10:00.000Z", input: { secret: "must-not-cross" } },
    execution: { status: "completed", startedAt: "2026-09-08T00:10:01.000Z", finishedAt: "2026-09-08T00:10:02.000Z", summary: "完了", result: { secret: "must-not-cross" } },
    input: { secret: "must-not-cross" },
    createdAt: "2026-09-08T00:00:00.000Z",
    updatedAt: "2026-09-08T00:10:02.000Z",
    ...overrides
  };
}

describe("Browser durable Interaction Request bridge", () => {
  it("uses the fixed v1 list route and returns only the public projection", async () => {
    vi.mocked(browserWorkspaceRequest).mockResolvedValue({ requests: [interactionRequestFixture()] } as never);

    const bridge = createBrowserWorkspaceBridge();
    const result = await bridge.listWorkspaceInteractionRequests!({ roomId: "room_1", includeResolved: true });
    const request = vi.mocked(browserWorkspaceRequest).mock.calls[0]?.[0] as { method: string; path: string; workspaceScoped?: boolean };

    expect(request).toMatchObject({
      method: "GET",
      path: "/api/v1/workspaces/workspace_1/interaction-requests?room_id=room_1&include_resolved=true&limit=500&offset=0",
      workspaceScoped: true
    });
    expect(result.requests[0]).toMatchObject({ id: "interaction_1", roomId: "room_1", workspaceId: "workspace_1", version: 3 });
    expect(result.requests[0]?.options[0]).toMatchObject({ decision: "submit_input" });
    expect(result.requests[0]).not.toHaveProperty("input");
    expect(result.requests[0]).not.toHaveProperty("inputValues");
    expect(JSON.stringify(result)).not.toContain("must-not-cross");
  });

  it("walks every Interaction page instead of silently truncating durable recovery", async () => {
    vi.mocked(browserWorkspaceRequest)
      .mockResolvedValueOnce({ requests: Array.from({ length: 500 }, (_, index) => interactionRequestFixture({ id: `interaction_${index}` })) } as never)
      .mockResolvedValueOnce({ requests: [interactionRequestFixture({ id: "interaction_last" })] } as never);

    const bridge = createBrowserWorkspaceBridge();
    const result = await bridge.listWorkspaceInteractionRequests!({ roomId: "room_1", includeResolved: true });

    expect(result.requests).toHaveLength(501);
    expect(vi.mocked(browserWorkspaceRequest).mock.calls.map(([request]) => (request as { path: string }).path)).toEqual([
      "/api/v1/workspaces/workspace_1/interaction-requests?room_id=room_1&include_resolved=true&limit=500&offset=0",
      "/api/v1/workspaces/workspace_1/interaction-requests?room_id=room_1&include_resolved=true&limit=500&offset=500"
    ]);
  });

  it("reads the exact durable Generated Surface result by interaction ID", async () => {
    const request = interactionRequestFixture({
      kind: "approval",
      status: "completed",
      options: [{ id: "approve", label: "承認", decision: "approve" }],
      actionTarget: {
        kind: "generated_surface_action",
        room_id: "room_1",
        surface_id: "surface_1",
        revision_id: "revision_1",
        action_id: "publish",
        payload: { audience: "public" }
      },
      outcome: { kind: "response", option_id: "approve", decision: "approve", decided_at: "2026-09-08T00:10:00.000Z" }
    });
    vi.mocked(browserWorkspaceRequest).mockResolvedValue({
      request,
      target_result: { saved: true }
    } as never);

    const bridge = createBrowserWorkspaceBridge();
    const result = await bridge.getWorkspaceInteractionRequestResult!({
      roomId: "room_1",
      requestId: "interaction_1",
      operationId: "surface_operation_1"
    });
    const transport = vi.mocked(browserWorkspaceRequest).mock.calls[0]?.[0] as { method: string; path: string; workspaceScoped?: boolean; operationId?: string };

    expect(transport).toMatchObject({
      method: "GET",
      path: "/api/v1/workspaces/workspace_1/interaction-requests/interaction_1/result?room_id=room_1",
      workspaceScoped: true,
      operationId: "surface_operation_1"
    });
    expect(result.request.status).toBe("completed");
    expect(result.targetResult).toEqual({ saved: true });
  });

  it("sends signed operation and idempotency metadata on respond and cancel", async () => {
    vi.mocked(browserWorkspaceRequest)
      .mockResolvedValueOnce({ request: interactionRequestFixture(), replayed: false } as never)
      .mockResolvedValueOnce({ request: interactionRequestFixture({ status: "cancelled", version: 4 }), replayed: true } as never);
    const bridge = createBrowserWorkspaceBridge();

    await bridge.respondWorkspaceInteractionRequest!({
      roomId: "room_1",
      requestId: "interaction_1",
      expectedVersion: 3,
      optionId: "submit",
      values: { answer: "公開情報" },
      operationId: "interaction_respond_1"
    });
    await bridge.cancelWorkspaceInteractionRequest!({
      roomId: "room_1",
      requestId: "interaction_1",
      expectedVersion: 3,
      operationId: "interaction_cancel_1"
    });

    expect(vi.mocked(browserWorkspaceRequest).mock.calls[0]?.[0]).toMatchObject({
      method: "POST",
      path: "/api/v1/workspaces/workspace_1/interaction-requests/interaction_1/respond",
      operationId: "interaction_respond_1",
      idempotencyKey: "interaction_respond_1",
      body: { room_id: "room_1", expected_version: 3, option_id: "submit", values: { answer: "公開情報" } }
    });
    expect(vi.mocked(browserWorkspaceRequest).mock.calls[1]?.[0]).toMatchObject({
      method: "POST",
      path: "/api/v1/workspaces/workspace_1/interaction-requests/interaction_1/cancel",
      operationId: "interaction_cancel_1",
      idempotencyKey: "interaction_cancel_1",
      body: { room_id: "room_1", expected_version: 3 }
    });
  });

  it("rejects invalid values and a response from another Room", async () => {
    const bridge = createBrowserWorkspaceBridge();
    await expect(bridge.respondWorkspaceInteractionRequest!({
      roomId: "room_1",
      requestId: "interaction_1",
      expectedVersion: 0,
      optionId: "submit",
      values: {},
      operationId: "interaction_invalid"
    })).rejects.toThrow("expectedVersion_response_invalid");

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    await expect(bridge.respondWorkspaceInteractionRequest!({
      roomId: "room_1",
      requestId: "interaction_1",
      expectedVersion: 3,
      optionId: "submit",
      values: cyclic as never,
      operationId: "interaction_invalid_values"
    })).rejects.toThrow("values_invalid");
    expect(browserWorkspaceRequest).not.toHaveBeenCalled();

    vi.mocked(browserWorkspaceRequest).mockResolvedValue({ requests: [interactionRequestFixture({ roomId: "room_other" })] } as never);
    await expect(bridge.listWorkspaceInteractionRequests!({ roomId: "room_1" })).rejects.toThrow("workspace_interaction_request_response_scope_invalid");
  });
});
