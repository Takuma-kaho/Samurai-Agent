import { beforeEach, describe, expect, it, vi } from "vitest";
import { browserWorkspaceRequest, loadBrowserWorkspaceConnection } from "./workspace-browser-auth";
import { createBrowserWorkspaceBridge } from "./workspace-browser-bridge";

vi.mock("./workspace-browser-auth", () => ({
  browserWorkspaceHealth: vi.fn(),
  browserWorkspaceRequest: vi.fn(),
  createBrowserWorkspaceConnectionState: vi.fn(),
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

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(loadBrowserWorkspaceConnection).mockResolvedValue(connection);
});

describe("Browser Room Work resource-ref transport", () => {
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
      path: "/api/v1/workspaces/workspace_1/interaction-requests?room_id=room_1&include_resolved=true",
      workspaceScoped: true
    });
    expect(result.requests[0]).toMatchObject({ id: "interaction_1", roomId: "room_1", workspaceId: "workspace_1", version: 3 });
    expect(result.requests[0]?.options[0]).not.toHaveProperty("decision");
    expect(result.requests[0]).not.toHaveProperty("input");
    expect(result.requests[0]).not.toHaveProperty("inputValues");
    expect(JSON.stringify(result)).not.toContain("must-not-cross");
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
