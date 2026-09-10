import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";

const browserBridgeSource = readFileSync(new URL("./workspace-browser-bridge.ts", import.meta.url), "utf8");
const apiSource = readFileSync(new URL("./api.ts", import.meta.url), "utf8");

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("chat idempotency keys", () => {
  it("fails closed without the signed Workspace bridge", async () => {
    const input = {
      idempotencyKey: "turn-1",
      sessionId: "session-1",
      content: "同じ操作",
      outputLocale: "ja" as const
    };

    await expect(api.submitChatSurfaceOperation(input)).rejects.toMatchObject({
      status: 503,
      body: { error: "workspace_connection_required", feature: "chat.message.submit" }
    });
  });

  it("does not fall back to the old unauthenticated Chat URLs", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.sendMessage("session-1", "本文", "ja", "turn-session-1")).rejects.toMatchObject({ status: 503 });
    await expect(api.startChat("本文", "ja", "ja", "turn-new-1")).rejects.toMatchObject({ status: 503 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("Room work bridge", () => {
  it("keeps Artifact and Generated Surface writes on the explicit JSON bridge", () => {
    expect(browserBridgeSource).toContain("listWorkspaceArtifactRevisions");
    expect(browserBridgeSource).toContain("getWorkspaceArtifactRevision");
    expect(browserBridgeSource).toContain("reviseWorkspaceArtifact");
    expect(browserBridgeSource).toContain("restoreWorkspaceArtifactRevision");
    expect(browserBridgeSource).toContain("listWorkspaceGeneratedSurfaces");
    expect(browserBridgeSource).toContain("queryWorkspaceGeneratedSurface");
    expect(browserBridgeSource).toContain("runWorkspaceGeneratedSurfaceAction");
    expect(browserBridgeSource).toContain("runWorkspaceGeneratedSurfaceState");
    expect(browserBridgeSource).toContain("exportWorkspaceGeneratedSurface");
    expect(browserBridgeSource).toContain("toBridgeJson(input.operation)");
    expect(browserBridgeSource).toContain("toBridgeJson(input.bundle)");
    expect(browserBridgeSource).toContain("toBridgeJson(input.request)");
  });

  it("does not route Artifact creation through the legacy REST shortcut", () => {
    const start = browserBridgeSource.indexOf("createWorkspaceArtifact: async");
    const end = browserBridgeSource.indexOf("runWorkspaceArtifactSurfaceOperation", start);
    const source = browserBridgeSource.slice(start, end);
    expect(source).toContain('executeOperation<ArtifactMutationResult>');
    expect(source).not.toContain('workspaceRequest("POST", "/artifacts"');
  });

  it("keeps Knowledge/Skill selectors separate from attachment transport", () => {
    const createStart = browserBridgeSource.indexOf("createWorkspaceRoomWork: async");
    const replyStart = browserBridgeSource.indexOf("replyWorkspaceRoomWork: async", createStart);
    const commentStart = browserBridgeSource.indexOf("createWorkspaceRoomWorkComment: async", replyStart);
    expect(createStart).toBeGreaterThanOrEqual(0);
    expect(replyStart).toBeGreaterThan(createStart);
    expect(commentStart).toBeGreaterThan(replyStart);
    expect(browserBridgeSource.slice(createStart, replyStart)).toContain("strictRoomWorkResourceRefs(input.resourceRefs)");
    expect(browserBridgeSource.slice(createStart, replyStart)).toContain("resource_refs: resourceRefs");
    expect(browserBridgeSource.slice(replyStart, commentStart)).toContain("strictRoomWorkResourceRefs(input.resourceRefs)");
    expect(browserBridgeSource.slice(replyStart, commentStart)).toContain("resource_refs: resourceRefs");
    expect(browserBridgeSource).toContain("publicRoomWorkResourceRefs(record)");
    expect(browserBridgeSource).toContain("room_work_resource_ref_count_invalid");
    expect(browserBridgeSource).toContain("room_work_resource_refs_${index}_response_invalid");
  });

  it("accepts a delegated projection without an optional parent scope while retaining scope checks", () => {
    const start = browserBridgeSource.indexOf("async function delegateBrowserRoomWork");
    const end = browserBridgeSource.indexOf("/** Uploads still use", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const source = browserBridgeSource.slice(start, end);

    expect(source).toContain("assignee.id === assigneeId");
    expect(source).toContain("assignee.workId !== workId");
    expect(source).toContain("assignee.agentId !== agentId");
    expect(source).toContain("assignee.parentAssigneeId !== undefined");
    expect(source).toContain("assignee.parentAssigneeId !== assigneeId");
  });

  it("returns the server-issued attachment reference without accepting a local path", async () => {
    const writeWorkspaceAttachment = vi.fn(async (input: { roomId: string; path: string; target?: { connectionId: string; workspaceId: string } }) => ({
      file: { path: input.path, version: 1, sha256: "c".repeat(64), size: 2 },
      resource_ref: { kind: "file", id: "c".repeat(64), uri: input.path, version: "1", label: input.path }
    }));
    vi.stubGlobal("window", { samuraiDesktop: { writeWorkspaceAttachment } });

    const result = await api.uploadWorkspaceAttachment({
      roomId: "room_1",
      path: "attachments/brief.pdf",
      contentBase64: "aGk=",
      expectedVersion: 0,
      operationId: "op_attachment",
      target: { connectionId: "connection_1", workspaceId: "workspace_1" }
    });

    expect(result.resource_ref).toEqual({ kind: "file", id: "c".repeat(64), uri: "attachments/brief.pdf", version: "1", label: "attachments/brief.pdf" });
    expect(writeWorkspaceAttachment).toHaveBeenCalledWith(expect.objectContaining({
      roomId: "room_1",
      target: { connectionId: "connection_1", workspaceId: "workspace_1" }
    }));
    expect(writeWorkspaceAttachment.mock.calls[0]?.[0]).not.toHaveProperty("filePath");
  });

  it("uses only Room/Work references for normal work creation", async () => {
    const createWorkspaceRoomWork = vi.fn(async (input: { roomId: string; instruction?: string; operationId: string }) => ({
        id: "work_1",
        roomId: input.roomId,
        requesterId: "account_1",
        defaultAgentId: "agent_1",
        title: "確認",
        objective: input.instruction ?? "",
        status: "queued" as const,
        instructionVersion: 1,
        generation: 0,
        version: 1,
        assignees: [],
        createdAt: "2026-09-05T00:00:00.000Z",
        updatedAt: "2026-09-05T00:00:00.000Z",
        replayed: false
    }));
    vi.stubGlobal("window", { samuraiDesktop: { createWorkspaceRoomWork } });

    await api.createRoomWork({ roomId: "room_1", instruction: "確認" });

    expect(createWorkspaceRoomWork).toHaveBeenCalledWith(expect.objectContaining({ roomId: "room_1", instruction: "確認" }));
    expect(createWorkspaceRoomWork.mock.calls[0]?.[0]).not.toHaveProperty("sessionId");
  });

  it("passes only the typed Knowledge/Skill selector through the Room Work bridge", async () => {
    const createWorkspaceRoomWork = vi.fn(async (input: {
      roomId: string;
      resourceRefs?: Array<{ kind: "knowledge" | "skill"; id: string; version: number }>;
      operationId: string;
    }) => ({
      id: "work_1",
      roomId: input.roomId,
      requesterId: "account_1",
      defaultAgentId: "agent_1",
      title: "参照",
      objective: "Knowledgeを読む",
      status: "queued" as const,
      instructionVersion: 1,
      generation: 0,
      version: 1,
      resourceRefs: [],
      assignees: [],
      createdAt: "2026-09-05T00:00:00.000Z",
      updatedAt: "2026-09-05T00:00:00.000Z",
      replayed: false
    }));
    vi.stubGlobal("window", { samuraiDesktop: { createWorkspaceRoomWork } });

    await api.createRoomWork({
      roomId: "room_1",
      resourceRefs: [{ kind: "knowledge", id: "knowledge_policy", version: 3 }]
    });

    expect(createWorkspaceRoomWork).toHaveBeenCalledWith(expect.objectContaining({
      roomId: "room_1",
      resourceRefs: [{ kind: "knowledge", id: "knowledge_policy", version: 3 }]
    }));
    expect(createWorkspaceRoomWork.mock.calls[0]?.[0]).not.toHaveProperty("uri");
    expect(createWorkspaceRoomWork.mock.calls[0]?.[0]).not.toHaveProperty("label");
  });

  it("keeps Room work listing on the typed bridge", async () => {
    const listWorkspaceRoomWorks = vi.fn(async () => ({ works: [], nextCursor: "cursor_2" }));
    vi.stubGlobal("window", { samuraiDesktop: { listWorkspaceRoomWorks } });

    await expect(api.listRoomWorks({ roomId: "room_1", cursor: "cursor_1", limit: 20 })).resolves.toEqual({ works: [], nextCursor: "cursor_2" });
    expect(listWorkspaceRoomWorks).toHaveBeenCalledWith({ roomId: "room_1", cursor: "cursor_1", limit: 20 });
  });

  it("loads the authorized minimal Agent directory without Agent instructions", async () => {
    const listWorkspaceAgents = vi.fn(async () => ({
      agents: [{
        id: "agent_1",
        workspaceId: "workspace_1",
        displayName: "Research Agent",
        enabled: true,
        status: "active",
        version: 2
      }]
    }));
    vi.stubGlobal("window", { samuraiDesktop: { listWorkspaceAgents } });

    const result = await api.listWorkspaceAgents();
    expect(result).toMatchObject({ agents: [{ id: "agent_1", displayName: "Research Agent" }] });
    expect(result.agents[0]).not.toHaveProperty("instructions");
    expect(result.agents[0]).not.toHaveProperty("credential");
    expect(listWorkspaceAgents).toHaveBeenCalledOnce();
  });

  it("carries the connection and Workspace target through default-Agent and DM operations", async () => {
    const target = { connectionId: "connection_1", workspaceId: "workspace_1" };
    const setWorkspaceRoomDefaultAgent = vi.fn(async () => ({
      roomId: "room_1",
      agentId: "agent_1",
      agentVersion: 1,
      enabled: true,
      canExecute: true,
      version: 2,
      updatedAt: "2026-09-05T00:00:00.000Z"
    }));
    const openWorkspaceAgentDm = vi.fn(async () => ({
      id: "dm_1",
      roomId: "room_dm_1",
      workspaceId: "workspace_1",
      kind: "agent_dm" as const,
      agentId: "agent_1",
      agentVersion: 1,
      version: 1,
      createdAt: "2026-09-05T00:00:00.000Z",
      updatedAt: "2026-09-05T00:00:00.000Z"
    }));
    vi.stubGlobal("window", { samuraiDesktop: { setWorkspaceRoomDefaultAgent, openWorkspaceAgentDm } });

    await api.setRoomDefaultAgent({ roomId: "room_1", agentId: "agent_1", target, operationId: "default_1" });
    await api.openAgentDm({ agentId: "agent_1", target, operationId: "dm_1" });

    expect(setWorkspaceRoomDefaultAgent).toHaveBeenCalledWith(expect.objectContaining({ roomId: "room_1", operationId: "default_1", target }));
    expect(openWorkspaceAgentDm).toHaveBeenCalledWith({ agentId: "agent_1", operationId: "dm_1", target });
  });
});

describe("durable Interaction Request API", () => {
  it("exposes fixed list/respond/cancel methods without a generic signed request", async () => {
    const request = {
      id: "interaction_1",
      workspaceId: "workspace_1",
      roomId: "room_1",
      version: 1,
      kind: "approval" as const,
      status: "pending" as const,
      title: "確認",
      summary: "実行前の確認",
      actionTarget: { actionId: "publish" },
      options: [{ id: "approve", label: "実行" }],
      expiresAt: "2026-09-08T01:00:00.000Z",
      createdAt: "2026-09-08T00:00:00.000Z",
      updatedAt: "2026-09-08T00:00:00.000Z"
    };
    const listWorkspaceInteractionRequests = vi.fn(async () => ({ requests: [request] }));
    const respondWorkspaceInteractionRequest = vi.fn(async (input: { operationId: string }) => ({ request, replayed: input.operationId === "respond_1" }));
    const cancelWorkspaceInteractionRequest = vi.fn(async () => ({ request, replayed: false }));
    vi.stubGlobal("window", { samuraiDesktop: { listWorkspaceInteractionRequests, respondWorkspaceInteractionRequest, cancelWorkspaceInteractionRequest } });

    await expect(api.listWorkspaceInteractionRequests({ roomId: "room_1", includeResolved: true })).resolves.toEqual({ requests: [request] });
    await api.respondWorkspaceInteractionRequest({ roomId: "room_1", requestId: "interaction_1", expectedVersion: 1, optionId: "approve", operationId: "respond_1" });
    await api.cancelWorkspaceInteractionRequest({ roomId: "room_1", requestId: "interaction_1", expectedVersion: 1, operationId: "cancel_1" });

    expect(listWorkspaceInteractionRequests).toHaveBeenCalledWith({ roomId: "room_1", includeResolved: true });
    expect(respondWorkspaceInteractionRequest).toHaveBeenCalledWith(expect.objectContaining({ roomId: "room_1", requestId: "interaction_1", optionId: "approve", operationId: "respond_1" }));
    expect(cancelWorkspaceInteractionRequest).toHaveBeenCalledWith(expect.objectContaining({ roomId: "room_1", requestId: "interaction_1", operationId: "cancel_1" }));
  });

  it("removes confirmed from the Generated Surface action API", () => {
    const start = apiSource.indexOf("runGeneratedSurfaceAction(surfaceId");
    const end = apiSource.indexOf("getGeneratedSurfaceBundle(surfaceId", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(apiSource.slice(start, end)).not.toContain("confirmed");
  });
});
