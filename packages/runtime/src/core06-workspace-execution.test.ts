import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentBackendRegistry, MockBackend, type AgentBackend, type BackendOutputEvent, type BackendRunInput, type BackendSessionHandle, type BackendSessionInput } from "@samurai-agent/agent-backends";
import { humanParticipantId, localOwnerParticipantId } from "@samurai-agent/room-permissions";
import { WorkspaceStore } from "@samurai-agent/workspace-store";
import { AgentRuntime } from "./agent-runtime.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Core 06 workspace execution", () => {
  it("runs through the shared Backend cassette without creating a Session", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-core06-workspace-run-"));
    roots.push(root);
    const store = await WorkspaceStore.create({ rootDir: root });
    const runtime = new AgentRuntime(store, undefined, undefined, new AgentBackendRegistry([new MockBackend()]));
    const before = await store.listSessions();
    const room = await store.getRoom("room_default");
    expect(room).toBeDefined();

    const result = await runtime.runWorkspaceExecution({
      context: {
        workspace_id: "workspace",
        room_id: room!.id,
        principal: { kind: "human", participant_id: localOwnerParticipantId },
        source: { kind: "native_app" },
        correlation_id: "core06-workspace-run"
      },
      backend_id: "mock",
      input_summary: "SessionなしのWorkspace実行"
    });

    const after = await store.listSessions();
    const events = await store.listBackendEvents({ runId: result.run.id });
    expect(after).toEqual(before);
    expect(result.kind).toBe("completed");
    expect(result.run.session_id).toBeUndefined();
    expect(result.run.room_id).toBe(room!.id);
    await expect(runtime.assertLocalOwnerBackendRunAccess(result.run)).resolves.toEqual({ roomId: room!.id });
    expect(events.some((event) => event.event_type === "run_completed")).toBe(true);
    expect(events.every((event) => event.session_id === undefined)).toBe(true);

    await runtime.shutdownMcpProcessPool();
    await store.close();

    const reopened = await WorkspaceStore.create({ rootDir: root });
    const persistedRun = await reopened.getBackendRun(result.run.id);
    const persistedEvents = await reopened.listBackendEvents({ runId: result.run.id });
    expect(persistedRun).toMatchObject({ id: result.run.id, room_id: room!.id, status: "completed" });
    expect(persistedRun?.session_id).toBeUndefined();
    expect(persistedEvents).not.toHaveLength(0);
    expect(persistedEvents.every((event) => event.session_id === undefined)).toBe(true);
    await reopened.close();
  });

  it("keeps resume and cancel on the same Run boundary without a Session", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-core06-workspace-control-"));
    roots.push(root);
    const store = await WorkspaceStore.create({ rootDir: root });
    const backend = new WaitingWorkspaceBackend();
    const runtime = new AgentRuntime(store, undefined, undefined, new AgentBackendRegistry([backend]));
    const room = await store.getRoom("room_default");
    expect(room).toBeDefined();

    const waiting = await runtime.runWorkspaceExecution({
      context: {
        workspace_id: "workspace",
        room_id: room!.id,
        principal: { kind: "human", participant_id: localOwnerParticipantId },
        source: { kind: "native_app" },
        correlation_id: "core06-workspace-resume"
      },
      backend_id: backend.id,
      input_summary: "入力待ち"
    });
    expect(waiting.kind).toBe("waiting");
    const replayedWaiting = await runtime.runWorkspaceExecution({
      context: {
        workspace_id: "workspace",
        room_id: room!.id,
        principal: { kind: "human", participant_id: localOwnerParticipantId },
        source: { kind: "native_app" },
        correlation_id: "core06-workspace-resume"
      },
      backend_id: backend.id,
      input_summary: "入力待ち"
    });
    expect(replayedWaiting.kind).toBe("waiting");

    const resumed = await runtime.resumeBackendRun(waiting.run.id, { content: "続行" });
    expect(resumed.status).toBe("completed");
    expect(resumed.session_id).toBeUndefined();

    const cancelledWaiting = await runtime.runWorkspaceExecution({
      context: {
        workspace_id: "workspace",
        room_id: room!.id,
        principal: { kind: "human", participant_id: localOwnerParticipantId },
        source: { kind: "native_app" },
        correlation_id: "core06-workspace-cancel"
      },
      backend_id: backend.id,
      input_summary: "取消待ち"
    });
    const cancelled = await runtime.cancelBackendRun(cancelledWaiting.run.id);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.session_id).toBeUndefined();

    await runtime.shutdownMcpProcessPool();
    await store.close();
  });

  it("rechecks current Room membership before resuming a Sessionless Run", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-core06-workspace-revoke-"));
    roots.push(root);
    const store = await WorkspaceStore.create({ rootDir: root });
    const backend = new WaitingWorkspaceBackend();
    const runtime = new AgentRuntime(store, undefined, undefined, new AgentBackendRegistry([backend]));
    const member = humanParticipantId("workspace-run-member");
    await store.addWorkspaceMember({ participantId: member, role: "member", actorId: localOwnerParticipantId });
    await store.addRoomMember({ roomId: "room_default", participantId: member, role: "member", actorId: localOwnerParticipantId });

    const waiting = await runtime.runWorkspaceExecution({
      context: {
        workspace_id: "workspace",
        room_id: "room_default",
        principal: { kind: "human", participant_id: member },
        source: { kind: "native_app" },
        correlation_id: "core06-workspace-revoke"
      },
      backend_id: backend.id,
      input_summary: "権限解除後に再開しない"
    });
    expect(waiting.kind).toBe("waiting");

    await store.removeRoomMember({ roomId: "room_default", participantId: member, actorId: localOwnerParticipantId });
    await expect(runtime.resumeBackendRun(waiting.run.id, { content: "拒否される" })).rejects.toMatchObject({ code: "forbidden" });
    const persisted = await store.getBackendRun(waiting.run.id);
    expect(persisted?.status).toBe("waiting_for_backend_input");
    expect(persisted?.session_id).toBeUndefined();

    await runtime.shutdownMcpProcessPool();
    await store.close();
  });

  it("uses the shared Executor to start a backend Run without inventing a Session", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-core06-workspace-executor-"));
    roots.push(root);
    const store = await WorkspaceStore.create({ rootDir: root });
    const backend = new StartSessionWorkspaceBackend();
    const runtime = new AgentRuntime(store, undefined, undefined, new AgentBackendRegistry([backend]));
    const room = await store.getRoom("room_default");
    expect(room).toBeDefined();

    const result = await runtime.runWorkspaceExecution({
      context: {
        workspace_id: "workspace",
        room_id: room!.id,
        principal: { kind: "human", participant_id: localOwnerParticipantId },
        source: { kind: "native_app" },
        correlation_id: "core06-workspace-shared-executor"
      },
      backend_id: backend.id,
      input_summary: "共通Executorを通す"
    });

    expect(result.kind).toBe("completed");
    expect(backend.started).toEqual([
      expect.objectContaining({
        run_id: result.run.id,
        room_id: room!.id,
        backend_session_key: expect.stringContaining(`run:${result.run.id}`)
      })
    ]);
    expect(backend.started[0]?.session_id).toBeUndefined();
    expect(backend.runInputs[0]?.session_id).toBeUndefined();

    await runtime.shutdownMcpProcessPool();
    await store.close();
  });

  it("records a Backend Tool mutation on the Run and Room without a Session", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-core06-workspace-tool-"));
    roots.push(root);
    const store = await WorkspaceStore.create({ rootDir: root });
    const backend = new WorkspaceToolBackend();
    const runtime = new AgentRuntime(store, undefined, undefined, new AgentBackendRegistry([backend]));
    const room = await store.getRoom("room_default");
    expect(room).toBeDefined();

    const result = await runtime.runWorkspaceExecution({
      context: {
        workspace_id: "workspace",
        room_id: room!.id,
        principal: { kind: "human", participant_id: localOwnerParticipantId },
        source: { kind: "native_app" },
        correlation_id: "core06-workspace-tool"
      },
      backend_id: backend.id,
      input_summary: "SessionなしのTool実行"
    });

    const operations = await store.listOperations();
    const toolRuns = await store.listToolRuns({ runId: result.run.id });
    const changes = await store.listWorkspaceChanges(undefined);
    const operation = operations.find((item) => item.operation === "file.write");
    expect(result.kind).toBe("completed");
    expect(await readFile(path.join(root, "core06-tool.txt"), "utf8")).toBe("Room-scoped tool output");
    expect(operation).toMatchObject({
      room_id: room!.id,
      run_id: result.run.id,
      status: "completed",
      input_ref: expect.objectContaining({ kind: "backend_run", id: result.run.id })
    });
    expect(operation?.session_id).toBeUndefined();
    expect(await store.getResourceAccessBoundary("file", "core06-tool.txt")).toMatchObject({ source_room_id: room!.id });
    expect(toolRuns).toEqual([expect.objectContaining({ run_id: result.run.id, status: "completed" })]);
    expect(toolRuns[0]?.session_id).toBeUndefined();
    expect(changes).toEqual(expect.arrayContaining([expect.objectContaining({ run_id: result.run.id })]));
    expect(changes.find((change) => change.run_id === result.run.id)?.session_id).toBeUndefined();

    await runtime.shutdownMcpProcessPool();
    await store.close();
  });

  it("routes a Sessionless HTTP Tool Bridge query through the Run and Room", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-core06-workspace-bridge-"));
    roots.push(root);
    const store = await WorkspaceStore.create({ rootDir: root });
    let runtime: AgentRuntime;
    const backend: AgentBackend = {
      id: "workspace-sessionless-bridge",
      kind: "codex",
      label: "Workspace Sessionless Bridge Fixture",
      sessionPolicy: { acquisition: "none", resume: "unsupported" },
      execution_owner: "host",
      async *runTurn(input) {
        expect(input.tool_bridge?.enabled).toBe(true);
        expect(input.tool_bridge?.tools.map((tool) => tool.name)).toContain("samurai.memory.search");
        expect(input.tool_bridge?.tools.map((tool) => tool.name)).not.toContain("samurai.artifact.create");
        const bridgeResult = await runtime.runBackendToolBridgeCall({
          runId: input.run_id,
          token: input.tool_bridge?.token ?? "",
          toolName: "mcp__samurai__memory_search",
          toolCallId: "workspace-memory-search",
          toolInput: { query: "not-found", limit: 4 }
        });
        expect(bridgeResult.status).toBe("completed");
        await expect(
          runtime.runBackendToolBridgeCall({
            runId: input.run_id,
            token: input.tool_bridge?.token ?? "",
            toolName: "artifact_create",
            toolCallId: "workspace-hidden-artifact",
            toolInput: { title: "hidden", content: "must not run" }
          })
        ).rejects.toMatchObject({
          code: "conflict",
          message: "session_compatibility_required:artifact.create"
        });
        yield { event_type: "run_started", payload: { input_summary: "bridge" } };
        yield {
          event_type: "run_completed",
          terminal_evidence: { kind: "completed", source: "owned_loop_return" },
          payload: { output_summary: "bridge completed" }
        };
      }
    };
    runtime = new AgentRuntime(store, undefined, undefined, new AgentBackendRegistry([backend]));
    const room = await store.getRoom("room_default");
    expect(room).toBeDefined();

    const result = await runtime.runWorkspaceExecution({
      context: {
        workspace_id: "workspace",
        room_id: room!.id,
        principal: { kind: "human", participant_id: localOwnerParticipantId },
        source: { kind: "native_app" },
        correlation_id: "core06-workspace-tool-bridge"
      },
      backend_id: backend.id,
      input_summary: "SessionなしのTool Bridge検索"
    });
    const events = await store.listBackendEvents({ runId: result.run.id });

    if (result.kind === "outcome_unknown") throw result.error;
    expect(result.kind).toBe("completed");
    expect(result.run.session_id).toBeUndefined();
    expect(events.some((event) => event.event_type === "tool_call_started")).toBe(true);
    expect(events.some((event) => event.event_type === "tool_call_output")).toBe(true);
    expect(events.every((event) => event.session_id === undefined)).toBe(true);

    await runtime.shutdownMcpProcessPool();
    await store.close();
  });
});

class WaitingWorkspaceBackend implements AgentBackend {
  readonly id = "workspace-control";
  readonly kind = "mock" as const;
  readonly label = "Workspace Control Fixture";
  readonly sessionPolicy = { acquisition: "provider_event" as const, resume: "native" as const };
  readonly execution_owner = "backend" as const;

  async *runTurn(_input: BackendRunInput): AsyncIterable<BackendOutputEvent> {
    yield { event_type: "run_started", payload: { input_summary: "waiting" } };
    yield {
      event_type: "backend_waiting_for_native_input",
      payload: { prompt: "続行しますか？", waiting_execution: "suspended" }
    };
  }

  async *resumeRun(_runId: string, _input: Record<string, import("@samurai-agent/core-schemas").JsonValue>): AsyncIterable<BackendOutputEvent> {
    yield { event_type: "text_delta", payload: { text: "再開しました" } };
    yield {
      event_type: "run_completed",
      terminal_evidence: { kind: "completed", source: "owned_loop_return" },
      payload: { output_summary: "再開しました" }
    };
  }

  async cancelRun(): Promise<{ kind: "settled"; evidence: { kind: "cancelled"; source: "owned_loop_return" } }> {
    return { kind: "settled", evidence: { kind: "cancelled", source: "owned_loop_return" } };
  }
}

class StartSessionWorkspaceBackend implements AgentBackend {
  readonly id = "workspace-start-session";
  readonly kind = "mock" as const;
  readonly label = "Workspace Start Session Fixture";
  readonly sessionPolicy = { acquisition: "start_session" as const, resume: "unsupported" as const };
  readonly execution_owner = "backend" as const;
  readonly started: BackendSessionInput[] = [];
  readonly runInputs: BackendRunInput[] = [];

  async startSession(input: BackendSessionInput): Promise<BackendSessionHandle> {
    this.started.push(input);
    return {
      backend_session_id: `workspace-backend:${input.run_id}`,
      metadata: {},
      started_at: new Date().toISOString()
    };
  }

  async *runTurn(input: BackendRunInput): AsyncIterable<BackendOutputEvent> {
    this.runInputs.push(input);
    yield { event_type: "run_started", payload: { input_summary: input.user_input } };
    yield {
      event_type: "run_completed",
      terminal_evidence: { kind: "completed", source: "owned_loop_return" },
      payload: { output_summary: "completed" }
    };
  }
}

class WorkspaceToolBackend implements AgentBackend {
  readonly id = "workspace-tool";
  readonly kind = "mock" as const;
  readonly label = "Workspace Tool Fixture";
  readonly sessionPolicy = { acquisition: "provider_event" as const, resume: "unsupported" as const };
  readonly execution_owner = "host" as const;

  async *runTurn(_input: BackendRunInput): AsyncIterable<BackendOutputEvent> {
    yield { event_type: "run_started", payload: { input_summary: "tool" } };
    yield {
      event_type: "tool_call_started",
      tool_call_id: "workspace-file-write",
      payload: {
        tool_call_id: "workspace-file-write",
        provider_tool_name: "file.write",
        action_id: "file.write",
        input: { path: "core06-tool.txt", content: "Room-scoped tool output" }
      }
    };
    yield {
      event_type: "run_completed",
      terminal_evidence: { kind: "completed", source: "owned_loop_return" },
      payload: { output_summary: "tool completed" }
    };
  }
}
