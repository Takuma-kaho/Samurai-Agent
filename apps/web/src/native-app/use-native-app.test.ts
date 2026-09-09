import { describe, expect, it, vi } from "vitest";
import {
  backendRunForChatRequest,
  createNativeWorkspaceContentRefreshCoordinator,
  createNativeRoomWorkClient,
  nativeAgentBackendsFromUnknown,
  nativeRoomAgentIsAvailable,
  nativeRoomCreateErrorIsExplicitServerFailure,
  nativeRoomCreateOperationId,
  nativeRoomCreateResponseIsCurrent,
  nativeRoomsAfterRoomCreate,
  nativeDraftRequestIsCurrent,
  appendNativeWorkDraft,
  nativeRoomWorkListRequestIsCurrent,
  nativeRoomWorkErrorIsExplicitServerFailure,
  nativeRoomWorkFromUnknown,
  nativeWorkspaceContentRefreshRequestIsCurrent,
  nativeWorkspaceRealtimeEventAction,
  shouldDiscardWorkspaceTargetAfterReauthorizationFailure,
  streamingAgentMessageFromBackendEvents,
  textDeltaContentForRun,
  workspaceDirectoryRequestIsCurrent,
  workspaceDirectoryStateFingerprint,
  workspaceTransferStatusFromUnknown,
  workspaceTransferStatusMessage,
  workspacesAfterReauthorizationFailure
} from "./use-native-app";
import type { DesktopWorkspaceConnectionState } from "../lib/api";
import type { BackendEventRecord, BackendRunRecord } from "@samurai-agent/core-schemas";
import type { NativeWorkspaceTransferStatus } from "./types";

const source = { connectionId: "server_a", workspaceId: "workspace_a" };
const destination = { connectionId: "server_b", workspaceId: "workspace_b" };
const fallback = {
  transferId: "transfer_1",
  source,
  destination,
  workspace: {
    id: "workspace_a",
    name: "移転対象",
    state: "active" as const,
    access: "granted" as const,
    target: source
  }
};

const runStartedAt = "2026-09-04T00:00:00.000Z";

function backendRun(id: string, sessionId: string, requestId: string, startedAt = runStartedAt): BackendRunRecord {
  return {
    id,
    session_id: sessionId,
    room_id: "room_a",
    backend_id: "samurai-native",
    backend_kind: "samurai_native",
    status: "running",
    started_at: startedAt,
    request_idempotency_key: requestId,
    input_summary: "入力",
    metadata: {}
  };
}

function textEvent(id: string, runId: string, sequence: number, text: string, sessionId = "session_a"): BackendEventRecord {
  return {
    id,
    run_id: runId,
    session_id: sessionId,
    event_type: "text_delta",
    sequence,
    payload: { text },
    resource_refs: [],
    created_at: runStartedAt
  };
}

describe("Persisted chat stream projection", () => {
  it("selects only the run matching the Session and request idempotency key", () => {
    const expected = backendRun("run-current", "session_a", "request_a", "2026-09-04T00:00:01.000Z");
    expect(backendRunForChatRequest([
      backendRun("run-other-session", "session_b", "request_a"),
      backendRun("run-other-request", "session_a", "request_b"),
      expected
    ], "session_a", "request_a")).toBe(expected);
  });

  it("orders persisted deltas, removes duplicate event IDs, and excludes another run", () => {
    const events = [
      textEvent("event-2", "run-a", 3, "世界"),
      textEvent("event-other-run", "run-b", 1, "別の実行"),
      textEvent("event-1", "run-a", 2, "こんにちは"),
      textEvent("event-2", "run-a", 3, "重複")
    ];

    expect(textDeltaContentForRun(events, "run-a")).toBe("こんにちは世界");
    expect(streamingAgentMessageFromBackendEvents(backendRun("run-a", "session_a", "request_a"), events)).toMatchObject({
      id: "streaming-agent:run-a",
      role: "agent",
      content: "こんにちは世界",
      pending: true
    });
  });

  it("does not render malformed or empty text payloads", () => {
    const malformed = { ...textEvent("event-empty", "run-a", 1, ""), payload: { text: 42 } } as BackendEventRecord;
    expect(textDeltaContentForRun([malformed], "run-a")).toBe("");
  });
});

describe("Workspace realtime navigation boundary", () => {
  it("refreshes content for ordinary events without re-activating the Workspace", () => {
    expect(nativeWorkspaceRealtimeEventAction("event")).toBe("refresh_content");
  });

  it("keeps access changes on the re-authorization path and revokes on the safe path", () => {
    expect(nativeWorkspaceRealtimeEventAction("access_changed")).toBe("reauthorize_workspace");
    expect(nativeWorkspaceRealtimeEventAction("room_access_changed")).toBe("reauthorize_workspace");
    expect(nativeWorkspaceRealtimeEventAction("room_access_revoked")).toBe("reauthorize_workspace");
    expect(nativeWorkspaceRealtimeEventAction("access_revoked")).toBe("close_workspace");
  });
});

describe("Room creation backend projection", () => {
  it("keeps only renderer-safe availability fields from the Server projection", () => {
    expect(nativeAgentBackendsFromUnknown({
      backends: [{
        id: "samurai-native",
        label: "Samurai Native",
        kind: "samurai_native",
        configured: true,
        enabled: true,
        connection_state: "ready",
        reason: "ready",
        metadata: { secret: "must-not-reach-renderer" },
        api_key: "must-not-reach-renderer"
      }, {
        id: "codex",
        label: "Codex",
        configured: false,
        enabled: true,
        connection_state: "unconfigured"
      }]
    })).toEqual([
      { id: "samurai-native", label: "Samurai Native", kind: "samurai_native", configured: true, enabled: true, connectionState: "ready", reason: "ready" },
      { id: "codex", label: "Codex", configured: false, enabled: true, connectionState: "unconfigured" }
    ]);
  });

  it("shows an existing Agent only when its configured Backend is ready", () => {
    const agent = { id: "agent_research", displayName: "Research", backendId: "samurai-native", enabled: true, status: "active" };
    expect(nativeRoomAgentIsAvailable(agent, [{ id: "samurai-native", label: "Native", configured: true, enabled: true, connectionState: "ready" }])).toBe(true);
    expect(nativeRoomAgentIsAvailable(agent, [{ id: "samurai-native", label: "Native", configured: false, enabled: true, connectionState: "unconfigured" }])).toBe(false);
    expect(nativeRoomAgentIsAvailable(agent, [{ id: "samurai-native", label: "Native", configured: true, enabled: false, connectionState: "disabled" }])).toBe(false);
    expect(nativeRoomAgentIsAvailable(agent, [{ id: "samurai-native", label: "Native", configured: true, enabled: true, connectionState: "degraded" }])).toBe(false);
  });

  it("rejects a Room response after the selected target changes", () => {
    const result = {
      target: source,
      room: { id: "room_a", workspace_id: source.workspaceId }
    };
    expect(nativeRoomCreateResponseIsCurrent(result, source, source)).toBe(true);
    expect(nativeRoomCreateResponseIsCurrent(result, source, destination)).toBe(false);
    expect(nativeRoomCreateResponseIsCurrent({ ...result, target: destination }, source, source)).toBe(false);
  });

  it("keeps one Room when a replay response is applied twice", () => {
    const room = { id: "room_replayed", workspaceId: source.workspaceId, name: "Replay", version: 1, createdAt: "", updatedAt: "" };
    const once = nativeRoomsAfterRoomCreate([], room);
    const twice = nativeRoomsAfterRoomCreate(once, room);
    expect(twice).toHaveLength(1);
    expect(twice[0]).toEqual(room);
  });

  it("retains the same operation ID for a retry and retires explicit failures", () => {
    expect(nativeRoomCreateOperationId("room_create_retry")).toBe("room_create_retry");
    expect(nativeRoomCreateOperationId("room_create_retry")).toBe("room_create_retry");
    expect(nativeRoomCreateErrorIsExplicitServerFailure(new Error("room_agent_backend_unavailable"))).toBe(true);
    expect(nativeRoomCreateErrorIsExplicitServerFailure(new Error("room_default_agent_permission_required:400"))).toBe(true);
    expect(nativeRoomCreateErrorIsExplicitServerFailure(new Error("workspace_navigation_changed"))).toBe(false);
    expect(nativeRoomCreateErrorIsExplicitServerFailure(new Error("workspace_room_response_scope_invalid"))).toBe(false);
    expect(nativeRoomCreateErrorIsExplicitServerFailure(new Error("network_timeout"))).toBe(false);
  });
});

describe("Workspace realtime refresh coordination", () => {
  it("coalesces a burst into one in-flight refresh and one dirty follow-up", async () => {
    const release: Array<() => void> = [];
    const refresh = vi.fn(() => new Promise<void>((resolve) => release.push(resolve)));
    const coordinator = createNativeWorkspaceContentRefreshCoordinator(refresh);

    coordinator.request();
    coordinator.request();
    coordinator.request();
    expect(refresh).toHaveBeenCalledTimes(1);

    release.shift()?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledTimes(2);

    release.shift()?.();
    await coordinator.whenIdle();
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("rejects an older same-Room response after a newer list request", () => {
    const older = { sequence: 1, roomOpenId: 4, roomId: "room_a", workspaceTargetKey: "server\nworkspace" };
    const newer = { sequence: 2, roomOpenId: 4, roomId: "room_a", workspaceTargetKey: "server\nworkspace" };
    expect(nativeRoomWorkListRequestIsCurrent(older, newer)).toBe(false);
    expect(nativeRoomWorkListRequestIsCurrent(newer, newer)).toBe(true);
    expect(nativeRoomWorkListRequestIsCurrent(
      { ...newer, roomOpenId: 5 },
      newer
    )).toBe(false);
    expect(nativeRoomWorkListRequestIsCurrent(
      { ...newer, workspaceTargetKey: "other\nworkspace" },
      newer
    )).toBe(false);
  });

  it("does not apply Room A refresh failure after navigation to Room B", () => {
    const roomA = {
      roomOpenId: 7,
      roomId: "room_a",
      workspaceTargetKey: "server\nworkspace",
      workListSequence: 12
    };
    const roomB = {
      roomOpenId: 8,
      roomId: "room_b",
      workspaceTargetKey: "server\nworkspace",
      workListSequence: 13
    };

    expect(nativeWorkspaceContentRefreshRequestIsCurrent(roomA, roomB)).toBe(false);
    expect(nativeWorkspaceContentRefreshRequestIsCurrent(roomA, { ...roomA })).toBe(true);
  });
});

describe("Room work bridge adapter", () => {
  it("uses Room/Work operation inputs without exposing a Session identifier", async () => {
    const calls: Array<{ operation: string; roomId: string; payload: Record<string, unknown>; operationId: string }> = [];
    const bridge = {
      runWorkspaceRoomWorkOperation: vi.fn(async (input: typeof calls[number]) => {
        calls.push(input);
        if (input.operation === "room.work.list") return { works: [] };
        return {
          id: "work_public",
          room_id: input.roomId,
          requester_id: "account_owner",
          default_agent_id: "agent_research",
          title: "調査",
          objective: "公開情報を調べる",
          status: "queued",
          instruction_version: 1,
          generation: 0,
          version: 1,
          assignees: []
        };
      })
    };
    const client = createNativeRoomWorkClient(bridge);

    expect(client).toBeDefined();
    await client?.list("room_public");
    const created = await client?.create({ roomId: "room_public", instruction: "公開情報を調べる", operationId: "op_public" });

    expect(created?.roomId).toBe("room_public");
    expect(calls[0]).toMatchObject({ operation: "room.work.list", roomId: "room_public", payload: { limit: 100 } });
    expect(calls[1]).toMatchObject({
      operation: "room.work.create",
      roomId: "room_public",
      payload: { instruction: "公開情報を調べる" },
      operationId: "op_public"
    });
    expect(calls.every((call) => !Object.prototype.hasOwnProperty.call(call.payload, "session_id"))).toBe(true);
  });

  it("forwards the Workspace target to default-Agent and DM mutations and rejects a mismatched DM", async () => {
    const target = { connectionId: "server_a", workspaceId: "workspace_a" };
    const setDefaultAgent = vi.fn(async (input: { roomId: string; agentId: string; operationId: string; target?: typeof target }) => ({
      room_id: input.roomId,
      agent_id: input.agentId,
      enabled: true,
      can_execute: true,
      version: 2
    }));
    const openWorkspaceAgentDm = vi.fn(async (input: { agentId: string; operationId: string; target?: typeof target }) => ({
      id: "dm_a",
      room_id: "room_dm_a",
      workspace_id: input.target?.workspaceId,
      kind: "agent_dm",
      agent_id: input.agentId,
      agent_version: 1,
      version: 1
    }));
    const client = createNativeRoomWorkClient({
      listWorkspaceRoomWorks: vi.fn(async () => ({ works: [] })),
      setWorkspaceRoomDefaultAgent: setDefaultAgent,
      openWorkspaceAgentDm
    });

    await client?.setDefaultAgent({ roomId: "room_a", agentId: "agent_a", operationId: "default_1", target });
    const dm = await client?.openDm("agent_a", "dm_1", target);

    expect(setDefaultAgent).toHaveBeenCalledWith(expect.objectContaining({ operationId: "default_1", target }));
    expect(openWorkspaceAgentDm).toHaveBeenCalledWith({ agentId: "agent_a", operationId: "dm_1", target });
    expect(dm).toMatchObject({ workspaceId: target.workspaceId, agentId: "agent_a", kind: "agent_dm" });

    const mismatchedClient = createNativeRoomWorkClient({
      listWorkspaceRoomWorks: vi.fn(async () => ({ works: [] })),
      openWorkspaceAgentDm: vi.fn(async () => ({
        id: "dm_wrong",
        room_id: "room_dm_wrong",
        workspace_id: target.workspaceId,
        kind: "normal",
        agent_id: "agent_other",
        agent_version: 1,
        version: 1
      }))
    });
    await expect(mismatchedClient?.openDm("agent_a", "dm_wrong", target)).rejects.toThrow("agent_dm_response_invalid");
  });

  it("forwards only the server-issued attachment reference on Room work creation", async () => {
    const attachment = {
      kind: "file" as const,
      id: "b".repeat(64),
      uri: "attachments/brief.pdf",
      version: "2",
      label: "attachments/brief.pdf"
    };
    const createWorkspaceRoomWork = vi.fn(async (input: { roomId: string; attachments?: typeof attachment[]; operationId: string }) => ({
      id: "work_with_attachment",
      room_id: input.roomId,
      requester_id: "account_owner",
      default_agent_id: "agent_research",
      title: "資料確認",
      objective: "",
      status: "queued",
      instruction_version: 1,
      generation: 0,
      version: 1,
      assignees: [],
      instructions: [{
        id: "instruction_with_attachment",
        work_id: "work_with_attachment",
        kind: "initial",
        instruction: "",
        attachments: input.attachments ?? [],
        status: "accepted",
        version: 1,
        generation: 0,
        created_by: "account_owner"
      }]
    }));
    const client = createNativeRoomWorkClient({ listWorkspaceRoomWorks: vi.fn(async () => ({ works: [] })), createWorkspaceRoomWork });

    await client?.create({ roomId: "room_public", attachments: [attachment], operationId: "op_attachment" });

    expect(createWorkspaceRoomWork).toHaveBeenCalledWith(expect.objectContaining({
      roomId: "room_public",
      attachments: [attachment],
      operationId: "op_attachment"
    }));
  });

  it("sends only a stable Knowledge/Skill id and version through the Room Work operation", async () => {
    const calls: Array<{ operation: string; roomId: string; payload: Record<string, unknown>; operationId: string }> = [];
    const client = createNativeRoomWorkClient({
      runWorkspaceRoomWorkOperation: vi.fn(async (input: typeof calls[number]) => {
        calls.push(input);
        if (input.operation === "room.work.list") return { works: [] };
        return {
          id: "work_resource",
          room_id: input.roomId,
          requester_id: "account_owner",
          default_agent_id: "agent_research",
          title: "方針を確認",
          objective: "",
          status: "queued",
          instruction_version: 1,
          generation: 0,
          version: 1,
          assignees: []
        };
      })
    });

    await client?.create({
      roomId: "room_public",
      resourceRefs: [{ kind: "knowledge", id: "knowledge_policy", version: 4, label: "公開方針" }],
      operationId: "op_resource"
    });

    expect(calls[0]).toMatchObject({
      operation: "room.work.create",
      roomId: "room_public",
      payload: { resource_refs: [{ kind: "knowledge", id: "knowledge_policy", version: 4 }] },
      operationId: "op_resource"
    });
    expect(calls[0]?.payload.resource_refs).not.toEqual(expect.arrayContaining([expect.objectContaining({ label: expect.anything() })]));
  });

  it("carries an explicitly selected assignee through the reply adapter", async () => {
    const reply = vi.fn(async (input: { workId: string; assigneeId?: string; instruction?: string }) => ({
      id: "instruction_reply",
      work_id: input.workId,
      assignee_id: input.assigneeId,
      kind: "reply",
      instruction: input.instruction,
      status: "accepted",
      version: 4,
      generation: 2,
      created_by: "account_owner"
    }));
    const client = createNativeRoomWorkClient({
      listWorkspaceRoomWorks: vi.fn(async () => ({ works: [] })),
      replyWorkspaceRoomWork: reply
    });

    const input = {
      roomId: "room_public",
      workId: "work_public",
      assigneeId: "assignment_specialist",
      instruction: "担当を指定して続行",
      operationId: "op_reply"
    };
    const result = await client?.reply(input);
    await client?.reply(input);

    expect(reply).toHaveBeenCalledWith(expect.objectContaining({
      roomId: "room_public",
      workId: "work_public",
      assigneeId: "assignment_specialist",
      instruction: "担当を指定して続行",
      operationId: "op_reply"
    }));
    expect(reply).toHaveBeenCalledTimes(2);
    expect(reply.mock.calls[1]?.[0]).toMatchObject({ operationId: "op_reply" });
    expect(result).toMatchObject({ workId: "work_public", assigneeId: "assignment_specialist", kind: "reply" });
  });

  it("carries explicit multi-Agent delegation through the public Room operation", async () => {
    const delegate = vi.fn(async (input: { roomId: string; workId: string; assigneeId: string; agentId: string; instruction: string; dependencyAssigneeIds?: string[]; operationId: string }) => ({
      id: "assignment_child",
      work_id: input.workId,
      parent_assignee_id: input.assigneeId,
      agent_id: input.agentId,
      status: "waiting",
      instruction_version: 4,
      generation: 1,
      version: 1
    }));
    const client = createNativeRoomWorkClient({
      listWorkspaceRoomWorks: vi.fn(async () => ({ works: [] })),
      delegateWorkspaceRoomWorkAssignee: delegate
    });

    const result = await client?.delegate({
      roomId: "room_public",
      workId: "work_public",
      assigneeId: "assignment_public",
      agentId: "agent_specialist",
      instruction: "一次資料を比較する",
      dependencyAssigneeIds: ["assignment_review"],
      operationId: "op_delegate"
    });

    expect(delegate).toHaveBeenCalledWith(expect.objectContaining({
      roomId: "room_public",
      workId: "work_public",
      assigneeId: "assignment_public",
      agentId: "agent_specialist",
      instruction: "一次資料を比較する",
      dependencyAssigneeIds: ["assignment_review"],
      operationId: "op_delegate"
    }));
    expect(result).toMatchObject({ workId: "work_public", parentAssigneeId: "assignment_public", agentId: "agent_specialist" });
  });

  it("accepts a delegated public projection without optional parent scope and rejects conflicting scope", async () => {
    const delegated: Record<string, unknown> = {
      id: "assignment_child",
      work_id: "work_public",
      agent_id: "agent_specialist",
      status: "waiting",
      instruction_version: 4,
      generation: 1,
      version: 1
    };
    const delegate = vi.fn(async () => delegated);
    const client = createNativeRoomWorkClient({
      listWorkspaceRoomWorks: vi.fn(async () => ({ works: [] })),
      delegateWorkspaceRoomWorkAssignee: delegate
    });

    await expect(client?.delegate({
      roomId: "room_public",
      workId: "work_public",
      assigneeId: "assignment_public",
      agentId: "agent_specialist",
      instruction: "一次資料を比較する",
      operationId: "op_delegate_without_parent_projection"
    })).resolves.toMatchObject({
      id: "assignment_child",
      workId: "work_public",
      agentId: "agent_specialist"
    });

    delegate.mockResolvedValueOnce({ ...delegated, id: "assignment_public" });
    await expect(client?.delegate({
      roomId: "room_public",
      workId: "work_public",
      assigneeId: "assignment_public",
      agentId: "agent_specialist",
      instruction: "親Assignmentを返す異常応答",
      operationId: "op_delegate_parent_as_child"
    })).rejects.toThrow("room_work_delegate_response_scope_invalid");

    delegate.mockResolvedValueOnce({ ...delegated, parent_assignee_id: "assignment_other" });
    await expect(client?.delegate({
      roomId: "room_public",
      workId: "work_public",
      assigneeId: "assignment_public",
      agentId: "agent_specialist",
      instruction: "別の親を返す異常応答",
      operationId: "op_delegate_wrong_parent"
    })).rejects.toThrow("room_work_delegate_response_scope_invalid");
  });

  it("keeps a pending instruction in the public Room work projection", () => {
    const projected = nativeRoomWorkFromUnknown({
      id: "work_public",
      room_id: "room_public",
      requester_id: "account_owner",
      default_agent_id: "agent_research",
      title: "調査",
      objective: "公開情報を調べる",
      status: "running",
      instruction_version: 2,
      generation: 1,
      version: 3,
      assignees: [{
        id: "assignment_public",
        work_id: "work_public",
        agent_id: "agent_research",
        status: "running",
        instruction_version: 2,
        generation: 1,
        version: 2
      }],
      instructions: [{
        id: "instruction_pending",
        work_id: "work_public",
        assignee_id: "assignment_public",
        kind: "reply",
        instruction: "反映待ちの追加指示",
        status: "pending",
        version: 2,
        generation: 1,
        created_by: "account_owner"
      }]
    });

    expect(projected.instructions?.[0]).toMatchObject({ id: "instruction_pending", status: "pending" });
  });

  it("keeps canonical Knowledge/Skill refs separate from file attachments in a public instruction", () => {
    const projected = nativeRoomWorkFromUnknown({
      id: "work_resource",
      room_id: "room_public",
      requester_id: "account_owner",
      default_agent_id: "agent_research",
      title: "方針を確認",
      objective: "",
      status: "queued",
      instruction_version: 1,
      generation: 0,
      version: 1,
      assignees: [],
      resource_refs: [{ kind: "knowledge", id: "knowledge_policy", uri: "knowledge/policy.md", version: "4", label: "公開方針" }],
      instructions: [{
        id: "instruction_resource",
        work_id: "work_resource",
        kind: "initial",
        instruction: "",
        attachments: [],
        resource_refs: [{ kind: "skill", id: "skill_review", uri: "skills/review.md", version: "2", label: "レビュー" }],
        status: "accepted",
        version: 1,
        generation: 0,
        created_by: "account_owner"
      }]
    });

    expect(projected.resourceRefs).toEqual([{ kind: "knowledge", id: "knowledge_policy", uri: "knowledge/policy.md", version: "4", label: "公開方針" }]);
    expect(projected.instructions?.[0]?.attachments).toEqual([]);
    expect(projected.instructions?.[0]?.resourceRefs).toEqual([{ kind: "skill", id: "skill_review", uri: "skills/review.md", version: "2", label: "レビュー" }]);
  });
});

describe("Room work draft request stamp", () => {
  it("adds an Artifact request without overwriting the draft already prepared for that Work", () => {
    expect(appendNativeWorkDraft("先に書いた追加指示", "[成果物の修正依頼]\n対象版: revision_2"))
      .toBe("先に書いた追加指示\n\n[成果物の修正依頼]\n対象版: revision_2");
    expect(appendNativeWorkDraft("", "  修正依頼  ")).toBe("修正依頼");
  });

  it("rejects a late completion from an older Room or draft key", () => {
    expect(nativeDraftRequestIsCurrent(
      { key: "workspace\nroom_a\nnew", roomOpenId: 1 },
      { key: "workspace\nroom_b\nnew", roomOpenId: 2 }
    )).toBe(false);
    expect(nativeDraftRequestIsCurrent(
      { key: "workspace\nroom_a\nreply_a", roomOpenId: 1 },
      { key: "workspace\nroom_a\nnew", roomOpenId: 1 }
    )).toBe(false);
    expect(nativeDraftRequestIsCurrent(
      { key: "workspace\nroom_a\nnew", roomOpenId: 3 },
      { key: "workspace\nroom_a\nnew", roomOpenId: 3 }
    )).toBe(true);
  });
});

describe("Room work mutation retry classification", () => {
  it("keeps unknown transport and response-shape failures replayable", () => {
    expect(nativeRoomWorkErrorIsExplicitServerFailure(new Error("Failed to fetch"))).toBe(false);
    expect(nativeRoomWorkErrorIsExplicitServerFailure(new Error("room_work_reply_response_invalid"))).toBe(false);
  });

  it("retires an operation after a definitive validation or HTTP failure", () => {
    expect(nativeRoomWorkErrorIsExplicitServerFailure(new Error("room_work_assignee_required"))).toBe(true);
    expect(nativeRoomWorkErrorIsExplicitServerFailure(new Error("room_work_reply_forbidden:403"))).toBe(true);
    expect(nativeRoomWorkErrorIsExplicitServerFailure({ status: 409 })).toBe(true);
  });
});

describe("Workspace transfer status projection", () => {
  it.each([
    ["preparing", "移転の準備中です。移転元は保持されています。"],
    ["exported", "Export済みです。移転元は保持されています。"],
    ["imported", "移転先へ復元済みです。移転元は保持されています。"],
    ["committed", "移転完了を確認中です。移転元は保持されています。"],
    ["rolled_back", "移転を安全に取り消しました。移転元は保持されています。"],
    ["failed", "移転に失敗しました。移転元は保持されています。"]
  ] as const)("projects the Server %s state without claiming success", (serverState, message) => {
    const status = workspaceTransferStatusFromUnknown({
      transfer_id: "transfer_1",
      state: serverState,
      target_workspace_id: "workspace_b",
      source_workspace_state: "read_only",
      source_archived: false
    }, fallback);

    expect(status.serverState).toBe(serverState);
    expect(status.state).toBe(serverState);
    expect(status.message).toBe(message);
  });

  it("keeps the Server imported state and only exposes receipt presence", () => {
    const status = workspaceTransferStatusFromUnknown({
      transfer_id: "transfer_1",
      state: "imported",
      source_integrity_hash: "a".repeat(64),
      target_integrity_hash: "a".repeat(64),
      target_workspace_id: "workspace_b",
      receipt_present: true,
      source_workspace_state: "read_only",
      target_receipt: { imported_at: "private" }
    }, fallback);

    expect(status).toMatchObject({
      state: "imported",
      serverState: "imported",
      targetWorkspaceId: "workspace_b",
      receiptPresent: true,
      sourceWorkspaceState: "read_only",
      sourceIntegrityHash: "a".repeat(64),
      targetIntegrityHash: "a".repeat(64)
    });
    expect(status.message).toBe("移転先へ復元済みです。受領確認を待っています。");
    expect(status).not.toHaveProperty("targetReceipt");
  });

  it("says archive is confirmed only when the Server confirms it", () => {
    const status = workspaceTransferStatusFromUnknown({
      transfer_id: "transfer_1",
      state: "committed",
      target_workspace_id: "workspace_b",
      receipt_present: true,
      source_workspace_state: "archived",
      source_archived: true
    }, fallback);

    expect(status.state).toBe("committed");
    expect(status.sourceArchived).toBe(true);
    expect(status.message).toBe("移転完了。移転元はArchive済みです。");
  });

  it("keeps rollback and partial restore visibly safe", () => {
    const rolledBack = workspaceTransferStatusFromUnknown({
      transfer_id: "transfer_1",
      state: "rolled_back",
      target_workspace_id: "workspace_b",
      receipt_present: false,
      source_workspace_state: "active",
      source_archived: false
    }, fallback);
    const failed = workspaceTransferStatusFromUnknown({
      transfer_id: "transfer_1",
      state: "failed",
      target_workspace_id: "workspace_b",
      target_restored: true,
      target_cleanup_required: true,
      source_workspace_state: "read_only",
      source_archived: false
    }, fallback);

    expect(rolledBack.message).toBe("移転を安全に取り消しました。移転元は保持されています。");
    expect(failed.message).toBe("移転が途中で停止しました。移転元は保持されています。移転先の確認が必要です。");
  });

  it("rejects a mismatched target or an unknown state instead of showing a false preflight", () => {
    expect(() => workspaceTransferStatusFromUnknown({
      transfer_id: "transfer_1",
      state: "imported",
      target_workspace_id: "workspace_other"
    }, fallback)).toThrow("workspace_transfer_status_target_mismatch");
    expect(() => workspaceTransferStatusFromUnknown({
      transfer_id: "transfer_1",
      state: "not-a-transfer-state"
    }, fallback)).toThrow("workspace_transfer_status_invalid");
  });

  it("keeps the local source-archived checkpoint understandable", () => {
    const status: NativeWorkspaceTransferStatus = {
      transferId: "transfer_1",
      source,
      destination,
      state: "source_archived",
      workspaceId: "workspace_a"
    };

    expect(workspaceTransferStatusMessage(status)).toBe("移転完了。移転元はArchive済みです。");
  });
});

describe("Workspace reauthorization failure state", () => {
  it.each([
    ["workspace_selection_denied", true],
    ["workspace_reauthorization_denied", true],
    ["workspace_target_not_found", true],
    ["workspace_identity_required", false],
    ["workspace_selection_unavailable", false]
  ] as const)("classifies %s as %s", (code, shouldDiscard) => {
    expect(shouldDiscardWorkspaceTargetAfterReauthorizationFailure(new Error(code))).toBe(shouldDiscard);
  });

  it("recognizes an HTTP denial even when the error message is generic", () => {
    const error = Object.assign(new Error("Workspace request failed"), { status: 403 });
    expect(shouldDiscardWorkspaceTargetAfterReauthorizationFailure(error)).toBe(true);
  });

  it("locks only the denied connection + Workspace target", () => {
    const denied = {
      id: "workspace_shared",
      name: "Server AのWorkspace",
      state: "active" as const,
      access: "granted" as const,
      target: { connectionId: "server_a", workspaceId: "workspace_shared" }
    };
    const sameIdOnOtherServer = {
      id: "workspace_shared",
      name: "Server BのWorkspace",
      state: "active" as const,
      access: "granted" as const,
      target: { connectionId: "server_b", workspaceId: "workspace_shared" }
    };

    const next = workspacesAfterReauthorizationFailure([denied, sameIdOnOtherServer], denied.target);

    expect(next[0]).toMatchObject({ access: "none", connectionError: "workspace_reauthorization_denied" });
    expect(next[1]).toBe(sameIdOnOtherServer);
    expect(next[1]).toMatchObject({ access: "granted" });
  });
});

describe("Workspace directory request generation", () => {
  const stateA: DesktopWorkspaceConnectionState = {
    activeConnectionId: "server_a",
    activeTarget: { connectionId: "server_a", workspaceId: "workspace_shared" },
    connections: [
      {
        id: "server_a",
        label: "Server A",
        serverUrl: "http://server-a.test",
        accountId: "account_a",
        createdAt: "2026-09-03T00:00:00.000Z",
        updatedAt: "2026-09-03T00:00:00.000Z"
      },
      {
        id: "server_b",
        label: "Server B",
        serverUrl: "http://server-b.test",
        accountId: "account_b",
        createdAt: "2026-09-03T00:00:00.000Z",
        updatedAt: "2026-09-03T00:00:00.000Z"
      }
    ]
  };
  const stateB: DesktopWorkspaceConnectionState = {
    ...stateA,
    activeConnectionId: "server_b",
    activeTarget: { connectionId: "server_b", workspaceId: "workspace_shared" }
  };

  it("accepts only the current generation and state snapshot", () => {
    const request = {
      generation: 4,
      stateFingerprint: workspaceDirectoryStateFingerprint(stateA)
    };

    expect(workspaceDirectoryRequestIsCurrent(request, 4, stateA)).toBe(true);
    expect(workspaceDirectoryRequestIsCurrent(request, 5, stateA)).toBe(false);
  });

  it("rejects a same-ID Workspace result after switching Servers", () => {
    const request = {
      generation: 8,
      stateFingerprint: workspaceDirectoryStateFingerprint(stateA)
    };

    expect(stateA.activeTarget?.workspaceId).toBe(stateB.activeTarget?.workspaceId);
    expect(workspaceDirectoryRequestIsCurrent(request, 8, stateB)).toBe(false);
  });
});
