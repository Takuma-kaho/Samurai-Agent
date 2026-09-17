import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  accountInvitationNotificationListRequest,
  accountInvitationNotificationReadRequest,
  accountWorkspaceNotificationSummaryRequest,
  parseSamuraiShareDeepLink,
  sanitizeAccountWorkspaceNotificationSummariesResponse,
  sanitizeWorkspaceContextSearchResponse,
  sanitizeWorkspaceNotificationMarkReadResponse,
  sanitizeWorkspaceNotificationPageResponse,
  sanitizeWorkspaceShareDraftResponse,
  sanitizeWorkspaceShareDraftDiscardResponse,
  sanitizeWorkspaceShareImportResponse,
  sanitizeWorkspaceShareLinkViewResponse,
  sanitizeWorkspaceShareLinkClaimResponse,
  sanitizeWorkspaceSharePageResponse,
  sanitizeWorkspaceSharePublishResponse,
  sanitizeAgentCompletionResourceBodyResponse,
  sanitizeAgentCompletionResourceDetailResponse,
  sanitizeAgentCompletionResourceListResponse,
  sanitizeAgentCompletionResourceMutationResponse,
  workspaceAgentCompletionResourceArchiveRequest,
  workspaceAgentCompletionResourceCreateRequest,
  workspaceAgentCompletionResourceIdRequest,
  workspaceAgentCompletionResourceListRequest,
  workspaceAgentCompletionResourceUpdateRequest,
  workspaceChatPersonalPreferencesRequest,
  workspaceCompletionAgentInputRequest,
  workspaceContextSearchRequest,
  workspaceContextSearchRequestFromPreload,
  workspaceNotificationListRequest,
  workspaceNotificationListRequestFromPreload,
  workspaceNotificationReadRequest,
  workspaceNotificationReadRequestFromPreload,
  workspaceNotificationSummaryRequestFromPreload,
  accountWorkspaceNotificationSummaryRequestFromPreload,
  accountInvitationNotificationListRequestFromPreload,
  accountInvitationNotificationReadRequestFromPreload,
  workspaceShareDraftCreateRequest,
  workspaceShareDraftDiscardRequest,
  workspaceShareDraftUpdateRequest,
  workspaceShareDraftViewRequest,
  workspaceShareImportRequest,
  workspaceShareImportStatusRequest,
  workspaceShareLinkImportRequest,
  workspaceShareLinkViewRequest,
  workspaceShareListRequest,
  workspaceSharePublishRequest,
  workspaceShareRevokeRequest
} from "./workspace-context-requests";

const mainSource = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
const preloadSource = readFileSync(new URL("./preload.cts", import.meta.url), "utf8");
const timestamp = "2026-09-17T00:00:00.000Z";
const target = { connectionId: "connection_1", workspaceId: "workspace_1", selectionGeneration: 4 };

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
  createdAt: timestamp,
  updatedAt: timestamp
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
  createdAt: timestamp
} as const;

describe("Desktop Workspace Context request sanitation", () => {
  it("sanitizes the private chat-start preference snapshot and rejects scope fields", () => {
    expect(workspaceChatPersonalPreferencesRequest({
      personalPreferences: {
        schema_version: 1,
        revision: 4,
        display_name: " 登録名 ",
        output_locale: "ja",
        instructions: "簡潔に"
      }
    })).toEqual({
      schema_version: 1,
      revision: 4,
      display_name: "登録名",
      output_locale: "ja",
      instructions: "簡潔に"
    });

    for (const extra of [
      { account_id: "account_other" },
      { authorization: { canExecute: true } },
      { connection_id: "connection_other" },
      { workspace_id: "workspace_other" },
      { share_id: "share_other" },
      { updated_at: "2026-09-17T00:00:00.000Z" },
      { unknown: true }
    ]) {
      expect(() => workspaceChatPersonalPreferencesRequest({
        personalPreferences: {
          schema_version: 1,
          revision: 4,
          display_name: "登録名",
          output_locale: null,
          instructions: "",
          ...extra
        }
      })).toThrow("personal_preferences_invalid");
    }

    expect(() => workspaceChatPersonalPreferencesRequest({
      personalPreferences: {
        schema_version: 2,
        revision: 4,
        display_name: "登録名",
        output_locale: null,
        instructions: ""
      }
    })).toThrow("personal_preferences_invalid");
    expect(() => workspaceChatPersonalPreferencesRequest({
      personalPreferences: {
        schema_version: 1,
        revision: -1,
        display_name: "登録名",
        output_locale: undefined,
        instructions: ""
      }
    })).toThrow("personal_preferences_invalid");
    expect(() => workspaceChatPersonalPreferencesRequest({
      personalPreferences: {
        schema_version: 1,
        revision: 4,
        display_name: "登録名",
        output_locale: null,
        instructions: "x".repeat(20_001)
      }
    })).toThrow("personal_preferences_invalid");
  });

  it("builds strict Workspace search input and does not forward account metadata", () => {
    expect(() => workspaceContextSearchRequest({
      query: " 議事録 ",
      types: ["conversation"],
      roomId: " room_1 ",
      limit: 20,
      cursor: " cursor_1 ",
      target,
      accountId: "must-not-cross"
    } as never)).toThrow("workspace_context_search_input_invalid");

    expect(workspaceContextSearchRequest({
      query: " 議事録 ",
      types: ["conversation"],
      roomId: " room_1 ",
      limit: 20,
      cursor: " cursor_1 ",
      target
    })).toEqual({
      target,
      body: { q: "議事録", types: ["conversation"], room_id: "room_1", limit: 20, cursor: "cursor_1" }
    });
  });

  it("rejects arbitrary targets, cursors, operation IDs, and duplicate IDs", () => {
    expect(() => workspaceNotificationListRequest({ target: { ...target, accountId: "other" } } as never)).toThrow("workspace_context_target_invalid");
    expect(() => workspaceNotificationListRequest({ cursor: "   " })).toThrow("workspace_notification_cursor_invalid");
    expect(() => workspaceNotificationReadRequest({ notificationIds: ["notification_1", "notification_1"], operationId: "read_1" })).toThrow("workspace_notification_ids_invalid");
    expect(() => workspaceNotificationReadRequest({ notificationIds: ["notification_1"], operationId: "" })).toThrow("workspace_notification_operation_id_invalid");
    expect(() => accountWorkspaceNotificationSummaryRequest({ workspaceIds: ["workspace_1"], workspaceId: "other" } as never)).toThrow("account_workspace_notification_summary_input_invalid");
    expect(() => accountInvitationNotificationReadRequest({ notificationIds: ["notification_1"], operationId: "read_1", accountId: "other" } as never)).toThrow("account_invitation_notification_read_input_invalid");
  });

  it("revalidates the normalized preload shape at the Main IPC boundary", () => {
    const search = workspaceContextSearchRequest({ query: "議事録", target });
    expect(workspaceContextSearchRequestFromPreload(search)).toEqual(search);

    const notifications = workspaceNotificationListRequest({ unreadOnly: true, limit: 10, target });
    expect(workspaceNotificationListRequestFromPreload(notifications)).toEqual(notifications);
    const summary = { target };
    expect(workspaceNotificationSummaryRequestFromPreload(summary)).toEqual(summary);

    const read = workspaceNotificationReadRequest({ notificationIds: ["notification_1"], operationId: "read_1", target });
    expect(workspaceNotificationReadRequestFromPreload(read)).toEqual(read);

    const accountSummary = accountWorkspaceNotificationSummaryRequest({ workspaceIds: ["workspace_1"], target });
    expect(accountWorkspaceNotificationSummaryRequestFromPreload(accountSummary)).toEqual(accountSummary);
    const invitationList = accountInvitationNotificationListRequest({ limit: 5, target });
    expect(accountInvitationNotificationListRequestFromPreload(invitationList)).toEqual(invitationList);
    const invitationRead = accountInvitationNotificationReadRequest({ notificationIds: ["notification_1"], operationId: "invite_read_1", target });
    expect(accountInvitationNotificationReadRequestFromPreload(invitationRead)).toEqual(invitationRead);
  });

  it("keeps Account list requests on the fixed account body and target metadata only", () => {
    expect(accountInvitationNotificationListRequest({ limit: 10, cursor: "cursor_1", target })).toEqual({
      target,
      body: { limit: 10, cursor: "cursor_1" }
    });
    expect(accountWorkspaceNotificationSummaryRequest({ workspaceIds: ["workspace_1"], target })).toEqual({
      target,
      workspaceIds: ["workspace_1"],
      body: { workspace_ids: ["workspace_1"] }
    });
  });

  it("accepts only Agent Knowledge/Skill completion resource requests", () => {
    expect(workspaceCompletionAgentInputRequest({
      scopeKind: "agent",
      agentId: "agent_1",
      kind: "knowledge",
      knowledgeKind: "fact",
      title: " Fact ",
      content: " body ",
      reason: " human edit ",
      operationId: "operation_1",
      target
    })).toMatchObject({ scopeKind: "agent", agentId: "agent_1", kind: "knowledge", title: "Fact", content: "body", reason: "human edit", target });

    expect(workspaceAgentCompletionResourceListRequest({ scopeKind: "agent", agentId: "agent_1", kind: "skill", target })).toMatchObject({
      scopeKind: "agent", agentId: "agent_1", kind: "skill", target
    });
    expect(workspaceAgentCompletionResourceCreateRequest({
      scopeKind: "agent", agentId: "agent_1", kind: "knowledge", knowledgeKind: "fact", title: "Fact", content: "body", reason: "create", operationId: "operation_1", target
    })).toMatchObject({
      operationId: "operation_1",
      body: { scope_kind: "agent", agent_id: "agent_1", kind: "knowledge", knowledge_kind: "fact" },
      target
    });
    expect(workspaceAgentCompletionResourceUpdateRequest({
      scopeKind: "agent", agentId: "agent_1", resourceId: "agent_resource_1", kind: "skill", title: "Skill", content: "body", reason: "update", expectedVersion: 1, operationId: "operation_2", target
    }).body).toMatchObject({ scope_kind: "agent", agent_id: "agent_1", kind: "skill", expected_version: 1 });
    expect(workspaceAgentCompletionResourceIdRequest({ scopeKind: "agent", agentId: "agent_1", resourceId: "agent_resource_1", version: 1, target })).toMatchObject({
      scopeKind: "agent", agentId: "agent_1", resourceId: "agent_resource_1", version: 1, target
    });
    expect(workspaceAgentCompletionResourceArchiveRequest({
      scopeKind: "agent", agentId: "agent_1", resourceId: "agent_resource_1", archived: true, expectedVersion: 1, reason: "archive", operationId: "operation_3", target
    }).body).toEqual({ scope_kind: "agent", agent_id: "agent_1", archived: true, expected_version: 1, reason: "archive" });

    for (const invalid of [
      { scopeKind: "agent", kind: "knowledge", knowledgeKind: "fact", title: "Fact", content: "body", reason: "create", operationId: "operation_1" },
      { scopeKind: "agent", agentId: "agent_1", roomId: "room_1", resourceId: "agent_resource_1" },
      { scopeKind: "agent", agentId: "agent_1", resourceId: "agent_resource_1", unknown: true },
      { scopeKind: "room", roomId: "room_1", agentId: "agent_1", resourceId: "resource_1" },
      { scopeKind: "agent", agentId: "agent_1", kind: "policy" }
    ]) {
      expect(() => workspaceCompletionAgentInputRequest(invalid)).toThrow();
    }
    expect(() => workspaceAgentCompletionResourceCreateRequest({
      scopeKind: "agent", agentId: "agent_1", kind: "knowledge", knowledgeKind: "fact", title: "Fact", content: "body", reason: "create", operationId: "operation_1", fixed: true
    } as never)).toThrow("completion_agent_input_invalid");
    expect(() => workspaceAgentCompletionResourceCreateRequest({
      scopeKind: "agent", agentId: "agent_1", kind: "skill", knowledgeKind: "fact", title: "Skill", content: "body", reason: "create", operationId: "operation_1"
    })).toThrow("completion_agent_skill_knowledge_kind_forbidden");
    expect(() => workspaceAgentCompletionResourceCreateRequest({
      scopeKind: "agent", agentId: "agent_1", kind: "knowledge", title: "Fact", content: "body", reason: "create", operationId: "operation_1"
    })).toThrow("completion_agent_knowledge_kind_invalid");
  });
});

describe("Desktop Workspace Context response sanitation", () => {
  it("preserves unknown notification kinds while returning only the public projection", () => {
    const response = sanitizeWorkspaceNotificationPageResponse({
      result: {
        items: [{
          id: "notification_1",
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
    });
    expect(response).toEqual({
      items: [{
        id: "notification_1",
        kind: "future_kind",
        createdAt: timestamp,
        readAt: null,
        title: "新しい通知",
        summary: "安全な概要",
        target: { kind: "room", roomId: "room_1" },
        actionState: "not_required"
      }],
      nextCursor: null
    });
    expect(JSON.stringify(response)).not.toContain("source");
    expect(JSON.stringify(response)).not.toContain("recipient");
  });

  it("rejects unknown response keys and invalid cross-scope targets", () => {
    expect(() => sanitizeWorkspaceNotificationPageResponse({
      result: { items: [{
        id: "notification_1",
        kind: "work_completed",
        created_at: timestamp,
        read_at: null,
        title: "仕事",
        summary: "概要",
        target: { kind: "work", room_id: "room_1", work_id: "work_1" },
        action_state: "not_required",
        source_id: "private_source"
      }], next_cursor: null }
    })).toThrow("workspace_notification_response_invalid");

    expect(() => sanitizeWorkspaceContextSearchResponse({
      result: { items: [{
        type: "conversation",
        id: "conversation_1",
        room_id: "room_1",
        title: "議事録",
        snippet: "抜粋",
        updated_at: timestamp,
        target: { kind: "work", room_id: "room_2", work_id: "work_1" }
      }], next_cursor: null }
    })).toThrow("workspace_context_search_target_scope_invalid");
  });

  it("requires read results to cover exactly the requested IDs", () => {
    expect(() => sanitizeWorkspaceNotificationMarkReadResponse({
      result: { updated_ids: ["notification_1"], already_read_ids: [], read_at: timestamp }
    }, ["notification_1", "notification_2"])).toThrow("workspace_notification_mark_read_response_scope_invalid");
    expect(sanitizeWorkspaceNotificationMarkReadResponse({
      result: { updated_ids: ["notification_1"], already_read_ids: ["notification_2"], read_at: timestamp }
    }, ["notification_1", "notification_2"])).toEqual({
      updatedIds: ["notification_1"],
      alreadyReadIds: ["notification_2"],
      readAt: timestamp
    });
  });

  it("does not expose unauthorized Workspace summary rows", () => {
    expect(() => sanitizeAccountWorkspaceNotificationSummariesResponse({
      result: { items: [{ workspace_id: "workspace_other", unread_count: 1, as_of: timestamp }] }
    }, ["workspace_1"])).toThrow("account_workspace_notification_summary_response_scope_invalid");
  });

  it("requires Agent completion responses to stay in the requested scope", () => {
    expect(sanitizeAgentCompletionResourceListResponse({ resources: [agentResource], next_cursor: "cursor_1" }, "agent_1")).toMatchObject({
      resources: [{ id: "agent_resource_1", scope: { kind: "agent", agentId: "agent_1" } }],
      next_cursor: "cursor_1"
    });
    expect(sanitizeAgentCompletionResourceDetailResponse({ resource: agentResource, current_version: agentVersion, versions: [], evidence: [] }, "agent_1")).toMatchObject({
      resource: { id: "agent_resource_1" }
    });
    expect(sanitizeAgentCompletionResourceBodyResponse({ resource: agentResource, version: agentVersion, content: "body" }, "agent_1")).toMatchObject({
      resource: { id: "agent_resource_1" }, content: "body"
    });
    expect(sanitizeAgentCompletionResourceMutationResponse({ resource: agentResource, replayed: false }, "agent_1")).toMatchObject({
      resource: { id: "agent_resource_1" }, replayed: false
    });
    expect(() => sanitizeAgentCompletionResourceListResponse({ resources: [{ ...agentResource, scope: { kind: "agent", agentId: "agent_other" } }] }, "agent_1")).toThrow("completion_agent_response_scope_invalid");
    expect(() => sanitizeAgentCompletionResourceListResponse({ resources: [{ ...agentResource, aiManaged: true }] }, "agent_1")).toThrow("completion_agent_response");
    expect(() => sanitizeAgentCompletionResourceListResponse({ resources: [{ ...agentResource, private_source: "nope" }] }, "agent_1")).toThrow("completion_agent_response_invalid");
  });
});

describe("Desktop Workspace Context IPC wiring", () => {
  it("uses fixed preload channels and never exposes a raw context IPC call", () => {
    expect(preloadSource).toContain('searchWorkspaceContext: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:context:search", workspaceContextSearchRequest(input))');
    expect(preloadSource).toContain('listWorkspaceNotifications: (input?: unknown) => ipcRenderer.invoke("samurai:workspace-server:notifications:list", workspaceNotificationListRequest(input))');
    expect(preloadSource).toContain('getAccountWorkspaceNotificationSummaries: (input: unknown) => ipcRenderer.invoke("samurai:account:notifications:workspace-summaries", accountWorkspaceNotificationSummaryRequest(input))');
    expect(preloadSource).not.toContain('ipcRenderer.invoke("samurai:workspace-server:context:search", input)');
    expect(preloadSource).not.toContain('ipcRenderer.invoke("samurai:account:notifications:invitations:read", input)');
  });

  it("keeps personal preferences on the execution-start chat channel only", () => {
    expect(preloadSource).toContain("workspaceChatPersonalPreferencesRequest(value)");
    expect(mainSource).toContain("workspaceChatPersonalPreferencesRequest(input)");
    expect(mainSource).toContain("personal_preferences: personalPreferences");
    expect(mainSource).not.toContain("metadata: { personal_preferences");
  });

  it("pins Workspace and Account Domain paths to snapshots and repeats mutation IDs", () => {
    expect(mainSource).toContain('"workspace.search"');
    expect(mainSource).toContain('"notification.list"');
    expect(mainSource).toContain('"account.workspace_notification_summaries"');
    expect(mainSource).toContain('"account.invitation_notifications"');
    expect(mainSource).toContain('"account.invitation_notification_read"');
    expect(mainSource).toContain("captureWorkspaceTargetSnapshot(request.target)");
    expect(mainSource).toContain("captureWorkspaceContextAccountSnapshot(request.target)");
    expect(mainSource).toContain("snapshotAccountDomainApiClient");
    expect(mainSource).toContain("operationId: request.operationId, idempotencyKey: request.operationId");
    expect(mainSource).toContain("workspaceScoped: false");
  });

  it("routes Agent completion resources through strict snapshot and idempotent handlers", () => {
    expect(preloadSource).toContain("workspaceCompletionAgentInputForOperation(value, \"list\")");
    expect(mainSource).toContain("isAgentCompletionInput(input)");
    expect(mainSource).toContain('scope_kind: "agent", agent_id: request.agentId');
    expect(mainSource).toContain("sanitizeAgentCompletionResourceMutationResponse");
    expect(mainSource).toContain("idempotencyKey: request.operationId");
    expect(mainSource).toContain("workspaceAgentCompletionResourceArchiveRequest(input)");
  });
});

describe("Desktop Workspace Share request and response sanitation", () => {
  const hash = "a".repeat(64);
  const locator = "L".repeat(43);
  const manifest = {
    format_version: 1 as const,
    kind: "room_knowledge" as const,
    title: "共有知識",
    entries: [{
      entry_id: "entry_1",
      kind: "knowledge" as const,
      title: "判断",
      content: "公開できる本文",
      knowledge_kind: "decision" as const,
      files: []
    }]
  };
  const draftResult = {
    draft_id: "draft_1",
    version: 2,
    manifest,
    content_hash: hash,
    visibility: "restricted" as const,
    recipient_account_ids: ["account_private"],
    removed_references: [{ entry_id: "entry_1", location: "internal/source", reason: "secret" }]
  };
  const delegation = {
    payload: {
      version: 1 as const,
      sourceOrigin: "https://source.example/",
      shareId: "share_1",
      claimId: "claim_1",
      recipientAccountId: "account_1",
      targetOrigin: "https://workspace.example/",
      targetWorkspaceId: "workspace_1",
      operationId: "import_1",
      contentHash: hash,
      issuedAt: timestamp,
      expiresAt: "2026-09-18T00:00:00.000Z"
    },
    publicKey: "public-key",
    signature: "signature"
  };

  it("accepts only one source shape and keeps target/operation outside the Domain body", () => {
    expect(workspaceShareDraftCreateRequest({
      sourceKind: "room_knowledge",
      sourceId: "room_1",
      resourceRefs: [{ id: "resource_1", version: 3 }],
      operationId: "draft_create_1",
      target
    })).toEqual({
      target,
      operationId: "draft_create_1",
      body: {
        source_kind: "room_knowledge",
        source_id: "room_1",
        resource_refs: [{ id: "resource_1", version: 3 }]
      }
    });
    expect(() => workspaceShareDraftCreateRequest({
      baseShareId: "share_1",
      sourceKind: "room_knowledge",
      sourceId: "room_1",
      resourceRefs: [{ id: "resource_1", version: 1 }],
      operationId: "draft_create_1",
      target
    })).toThrow("workspace_share_draft_create_input_invalid");
    expect(() => workspaceShareDraftCreateRequest({
      baseShareId: "share_1",
      operationId: "draft_create_1",
      target,
      accountId: "other"
    } as never)).toThrow("workspace_share_draft_create_input_invalid");
  });

  it("preserves expected versions and rejects unsafe share inputs", () => {
    expect(workspaceShareDraftViewRequest({ draftId: "draft_1", target })).toEqual({ target, body: { draft_id: "draft_1" } });
    expect(workspaceShareListRequest({ sourceKind: "agent", sourceId: "agent_1", limit: 10, target })).toEqual({
      target,
      body: { source_kind: "agent", source_id: "agent_1", limit: 10 }
    });
    expect(workspaceSharePublishRequest({ draftId: "draft_1", expectedVersion: 2, expectedContentHash: hash, operationId: "publish_1", target }).body)
      .toEqual({ draft_id: "draft_1", expected_version: 2, expected_content_hash: hash });
    expect(workspaceShareRevokeRequest({ shareId: "share_1", expectedVersion: 4, operationId: "revoke_1", target }).body)
      .toEqual({ share_id: "share_1", expected_version: 4 });
    expect(workspaceShareImportStatusRequest({ operationId: "import_1", target })).toEqual({
      target,
      operationId: "import_1",
      body: { operation_id: "import_1" }
    });
    expect(() => workspaceSharePublishRequest({ draftId: "draft_1", expectedVersion: 0, expectedContentHash: hash, operationId: "publish_1", target })).toThrow("workspace_share_expected_version_invalid");
    expect(() => workspaceShareImportRequest({ sourceOrigin: "http://source.example/", locator, claimId: "claim_1", contentHash: hash, delegation, operationId: "import_1", target })).toThrow("workspace_share_source_origin_invalid");
    expect(() => workspaceShareImportRequest({ sourceOrigin: "https://source.example/", locator: "short", claimId: "claim_1", contentHash: hash, delegation, operationId: "import_1", target })).toThrow("workspace_share_locator_invalid");
  });

  it("accepts only the strict source link shape and sanitizes the public projection", () => {
    const sourceUrl = `https://source.example/s/${locator}`;
    expect(workspaceShareLinkViewRequest({ sourceUrl, target })).toEqual({
      target,
      sourceUrl,
      sourceOrigin: "https://source.example/",
      locator
    });
    expect(workspaceShareLinkImportRequest({ sourceUrl, operationId: "link_import_1", target })).toEqual({
      target,
      sourceUrl,
      sourceOrigin: "https://source.example/",
      locator,
      operationId: "link_import_1"
    });
    for (const unsafe of [
      "/s/" + locator,
      `http://source.example/s/${locator}`,
      `${sourceUrl}?x=1`,
      `${sourceUrl}#fragment`,
      `https://user:pass@source.example/s/${locator}`,
      `https://source.example/s/${"L".repeat(42)}`
    ]) {
      expect(() => workspaceShareLinkViewRequest({ sourceUrl: unsafe, target })).toThrow();
    }
    expect(sanitizeWorkspaceShareLinkViewResponse({
      title: "公開共有",
      visibility: "public",
      manifest,
      content_hash: hash,
      published_at: timestamp
    }, { sourceUrl, sourceOrigin: "https://source.example/", locator })).toMatchObject({
      sourceUrl,
      sourceOrigin: "https://source.example/",
      locator,
      title: "公開共有",
      contentHash: hash
    });
    expect(() => sanitizeWorkspaceShareLinkViewResponse({
      title: "公開共有",
      visibility: "public",
      manifest,
      content_hash: hash,
      published_at: timestamp,
      share_id: "internal"
    }, { sourceUrl, sourceOrigin: "https://source.example/", locator })).toThrow("workspace_share_link_view_response_invalid");
    expect(sanitizeWorkspaceShareLinkClaimResponse({
      claim_id: "claim_1",
      share_id: "share_1",
      recipient_account_id: "account_1",
      target_origin: "https://workspace.example/",
      target_workspace_id: "workspace_1",
      operation_id: "link_import_1",
      content_hash: hash,
      created_at: timestamp
    })).toMatchObject({ claimId: "claim_1", shareId: "share_1", recipientAccountId: "account_1" });
  });

  it("sanitizes draft update/discard inputs without forwarding private fields", () => {
    const updateManifest = {
      formatVersion: 1 as const,
      kind: "room_knowledge" as const,
      title: "更新後の共有知識",
      entries: [{
        entryId: "entry_1",
        kind: "knowledge" as const,
        title: "判断",
        content: "更新後の本文",
        knowledgeKind: "decision" as const,
        files: []
      }]
    };
    expect(workspaceShareDraftUpdateRequest({
      draftId: "draft_1",
      expectedVersion: 2,
      manifest: updateManifest,
      visibility: "restricted",
      recipientAccountIds: ["account_private"],
      operationId: "draft_update_1",
      target
    })).toEqual({
      target,
      operationId: "draft_update_1",
      body: {
        draft_id: "draft_1",
        expected_version: 2,
        manifest: {
          format_version: 1,
          kind: "room_knowledge",
          title: "更新後の共有知識",
          entries: [{ entry_id: "entry_1", kind: "knowledge", title: "判断", content: "更新後の本文", knowledge_kind: "decision", files: [] }]
        },
        visibility: "restricted",
        recipient_account_ids: ["account_private"]
      }
    });
    expect(workspaceShareDraftDiscardRequest({ draftId: "draft_1", expectedVersion: 2, operationId: "draft_discard_1", target })).toEqual({
      target,
      operationId: "draft_discard_1",
      body: { draft_id: "draft_1", expected_version: 2 }
    });
    for (const invalid of [
      { draftId: "draft_1", expectedVersion: 0, manifest: updateManifest, visibility: "restricted", recipientAccountIds: [], operationId: "draft_update_1" },
      { draftId: "draft_1", expectedVersion: 2, manifest: { ...updateManifest, unknown: true }, visibility: "restricted", recipientAccountIds: [], operationId: "draft_update_1" },
      { draftId: "draft_1", expectedVersion: 2, manifest: updateManifest, visibility: "other", recipientAccountIds: [], operationId: "draft_update_1" },
      { draftId: "draft_1", expectedVersion: 2, manifest: updateManifest, visibility: "restricted", recipientAccountIds: ["account_1", "account_1"], operationId: "draft_update_1" },
      { draftId: "draft_1", expectedVersion: 2, manifest: updateManifest, visibility: "restricted", recipientAccountIds: [], operationId: "draft_update_1", accountId: "other" },
      { draftId: "draft_1", expectedVersion: 2, operationId: "draft_discard_1", accountId: "other" }
    ]) {
      expect(() => workspaceShareDraftUpdateRequest(invalid as never)).toThrow();
    }
    expect(() => workspaceShareDraftDiscardRequest({ draftId: "draft_1", expectedVersion: 0, operationId: "draft_discard_1" })).toThrow("workspace_share_expected_version_invalid");
    expect(() => workspaceShareDraftDiscardRequest({ draftId: "draft_1", expectedVersion: 2, operationId: "draft_discard_1", accountId: "other" } as never)).toThrow("workspace_share_draft_discard_input_invalid");
    expect(sanitizeWorkspaceShareDraftDiscardResponse({ result: { draft_id: "draft_1", discarded: true } })).toEqual({ draftId: "draft_1", discarded: true });
    expect(() => sanitizeWorkspaceShareDraftDiscardResponse({ result: { draft_id: "draft_1", discarded: false } })).toThrow("workspace_share_draft_discard_response_invalid");
  });

  it("does not return recipients, removed source locations, or delegation fields", () => {
    const draft = sanitizeWorkspaceShareDraftResponse({ result: draftResult });
    expect(draft).toMatchObject({ draftId: "draft_1", recipientCount: 1, removedReferenceCount: 1 });
    expect(draft).not.toHaveProperty("recipientAccountIds");
    expect(draft).not.toHaveProperty("removedReferences");
    expect(JSON.stringify(draft)).not.toContain("internal/source");
    expect(sanitizeWorkspaceSharePageResponse({ result: {
      items: [{
        share_id: "share_1",
        version: 1,
        title: "公開",
        status: "active",
        visibility: "public",
        recipient_account_ids: ["account_private"],
        url: `https://source.example/s/${locator}`,
        created_at: timestamp,
        published_at: timestamp,
        revoked_at: null
      }],
      next_cursor: null
    } })).toEqual({
      items: [{ shareId: "share_1", version: 1, title: "公開", status: "active", visibility: "public", recipientCount: 1, createdAt: timestamp, publishedAt: timestamp, revokedAt: null }],
      nextCursor: null
    });
  });

  it("allows only a safe published URL and preserves staging instead of treating it as success", () => {
    expect(sanitizeWorkspaceSharePublishResponse({ result: {
      share_id: "share_1",
      version: 1,
      url: `https://source.example/s/${locator}`,
      content_hash: hash,
      published_at: timestamp
    } })).toMatchObject({ shareId: "share_1", url: `https://source.example/s/${locator}` });
    expect(() => sanitizeWorkspaceSharePublishResponse({ result: {
      share_id: "share_1", version: 1, url: "https://source.example/not-share", content_hash: hash, published_at: timestamp
    } })).toThrow("workspace_share_publish_url_invalid");
    expect(sanitizeWorkspaceShareImportResponse({ result: {
      import_id: "import_1",
      kind: "room_knowledge",
      status: "staging",
      phase: "fetch",
      retryable: true,
      failure_code: null,
      created_resource_ids: [],
      created_agent_id: null,
      committed_at: null
    } })).toEqual({ importId: "import_1", kind: "room_knowledge", status: "staging", phase: "fetch", retryable: true, failureCode: null, createdResourceIds: [], createdAgentId: null, committedAt: null });
  });
});

describe("Desktop Workspace Share IPC wiring", () => {
  it("exposes only fixed sanitized IPC methods", () => {
    expect(preloadSource).toContain('createWorkspaceShareDraft: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:share:draft:create", workspaceShareDraftCreateRequest(input))');
    expect(preloadSource).toContain('viewWorkspaceShareDraft: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:share:draft:view", workspaceShareDraftViewRequest(input))');
    expect(preloadSource).toContain('updateWorkspaceShareDraft: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:share:draft:update", workspaceShareDraftUpdateRequest(input))');
    expect(preloadSource).toContain('discardWorkspaceShareDraft: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:share:draft:discard", workspaceShareDraftDiscardRequest(input))');
    expect(preloadSource).toContain('listWorkspaceShares: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:share:list", workspaceShareListRequest(input))');
    expect(preloadSource).toContain('publishWorkspaceShare: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:share:publish", workspaceSharePublishRequest(input))');
    expect(preloadSource).toContain('revokeWorkspaceShare: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:share:revoke", workspaceShareRevokeRequest(input))');
    expect(preloadSource).toContain('importWorkspaceShare: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:share:import", workspaceShareImportRequest(input))');
    expect(preloadSource).toContain('getWorkspaceShareImportStatus: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:share:import:status", workspaceShareImportStatusRequest(input))');
    expect(preloadSource).toContain('viewWorkspaceShareLink: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:share:link:view", workspaceShareLinkViewRequest(input))');
    expect(preloadSource).toContain('importWorkspaceShareLink: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:share:link:import", workspaceShareLinkImportRequest(input))');
    expect(preloadSource).not.toContain('ipcRenderer.invoke("samurai:workspace-server:share:import", input)');
  });

  it("pins Share routes to the selected snapshot and repeats mutation IDs", () => {
    expect(mainSource).toContain(".createShareDraft(");
    expect(mainSource).toContain(".viewShareDraft(");
    expect(mainSource).toContain(".updateShareDraft(");
    expect(mainSource).toContain(".discardShareDraft(");
    expect(mainSource).toContain(".listShares(");
    expect(mainSource).toContain(".publishShare(");
    expect(mainSource).toContain(".revokeShare(");
    expect(mainSource).toContain(".importShare(");
    expect(mainSource).toContain(".getShareImportStatus(");
    expect(mainSource).toContain("assertWorkspaceShareDelegationTarget");
    expect(mainSource).toContain('samurai:workspace-server:share:link:view');
    expect(mainSource).toContain('samurai:workspace-server:share:link:import');
    expect(mainSource).toContain("samurai-share-import-v1\\n");
    expect(mainSource).toContain('"x-samurai-public-key"');
    expect(mainSource).toContain("operationId: request.operationId,\n      idempotencyKey: request.operationId");
    expect(mainSource).not.toContain("fetch(request.body.source_origin");
  });

  it("keeps the external Share claim behind a fresh full navigation snapshot", () => {
    expect(mainSource).toContain("captureWorkspaceShareTargetSnapshot(request.target)");
    expect(mainSource).toContain("const claimSnapshot = captureWorkspaceShareTargetSnapshot(request.target);");
    expect(mainSource).toContain("sameWorkspaceNavigationSnapshot(workspaceSnapshot, claimSnapshot)");
    expect(mainSource).toContain("assertWorkspaceShareTargetSnapshot(claimSnapshot);");
  });
});

describe("samurai://share syntax", () => {
  const locator = "L".repeat(43);
  const source = `https://shares.example/s/${locator}`;

  it("parses a safe source URL without starting claim or import", () => {
    expect(parseSamuraiShareDeepLink(`samurai://share?source=${encodeURIComponent(source)}`)).toEqual({
      kind: "share",
      sourceUrl: source,
      locator
    });
  });

  it.each([
    `samurai://share?source=${encodeURIComponent(`${source}?debug=1`)}`,
    `samurai://share?source=${encodeURIComponent(`${source}#fragment`)}`,
    `samurai://share?source=${encodeURIComponent(`https://user:pass@shares.example/s/${locator}`)}`,
    `samurai://share?source=${encodeURIComponent(`https://shares.example/s/${"L".repeat(42)}`)}`,
    `samurai://share?source=${encodeURIComponent(source)}&claim=1`,
    `samurai://user@share?source=${encodeURIComponent(source)}`,
    `samurai://share:443?source=${encodeURIComponent(source)}`,
    `samurai://share/path?source=${encodeURIComponent(source)}`,
    `samurai://share/?source=${encodeURIComponent(source)}`
  ])("rejects unsafe share URL syntax %#", (url) => {
    expect(parseSamuraiShareDeepLink(url)).toBeUndefined();
  });
});
