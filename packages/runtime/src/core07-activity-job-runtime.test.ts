import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgentBackendRegistry,
  MockBackend,
  type AgentBackend,
  type BackendOutputEvent,
  type BackendRunInput
} from "@samurai-agent/agent-backends";
import { nowIso, type ActivityProcessorPort, type AgentRecord, type RoomRecord, type SessionRecord, type WorkspaceJobRecord } from "@samurai-agent/core-schemas";
import { localOwnerParticipantId } from "@samurai-agent/room-permissions";
import { WorkspaceStore } from "@samurai-agent/workspace-store";
import { AgentRuntime } from "./agent-runtime.js";
import { ActivityHistoryQueryService } from "./activity/activity-history-query-service.js";
import { ActivityProcessorRegistry, DeterministicFakeActivityProcessor } from "./activity/activity-processor-port.js";
import { WorkspaceJobWorker, type WorkspaceJobWorkerScheduler } from "./activity/workspace-job-worker.js";
import { RoomAuthorizationService } from "./commands/services/room-authorization-service.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createStore(): Promise<WorkspaceStore> {
  const root = await mkdtemp(path.join(tmpdir(), "samurai-core07-runtime-"));
  roots.push(root);
  return WorkspaceStore.create({ rootDir: root });
}

describe("Core07 Activity lifecycle in the existing Runtime", () => {
  it("stores a Sessionless Run as a Room-scoped Activity, records an actual change, and rejects a different Room", async () => {
    const store = await createStore();
    const room = await store.getRoom("room_default");
    expect(room).toBeDefined();
    const otherRoom = await store.createRoom({ id: "room-core07-other", name: "Other Room", created_at: nowIso(), updated_at: nowIso() });
    const before = await resourceCounts(store);
    const beforeLearning = await learningCounts(store);
    const runtime = new AgentRuntime(store, undefined, undefined, new AgentBackendRegistry([new WorkspaceToolBackend()]));

    const outcome = await runtime.runWorkspaceExecution({
      context: ownerContext(room!.id, "core07-sessionless"),
      backend_id: "core07-workspace-tool",
      input_summary: "Sessionを作らないActivity実行"
    });

    expect(outcome.kind).toBe("completed");
    expect(outcome.run.session_id).toBeUndefined();
    const activity = await store.getActivityByBackendRunId(outcome.run.id);
    const changes = (await store.listWorkspaceChanges()).filter((change) => change.run_id === outcome.run.id);
    const usage = activity ? await store.listResourceUsage({ activityId: activity.id }) : [];
    expect(activity).toMatchObject({
      workspace_id: "workspace",
      room_id: room!.id,
      principal: { kind: "human", participant_id: localOwnerParticipantId },
      status: "completed",
      backend_run_id: outcome.run.id,
      verification: []
    });
    expect(activity?.session_ref).toBeUndefined();
    expect(changes).toHaveLength(1);
    expect(usage).toContainEqual(expect.objectContaining({
      stage: "modified",
      workspace_change_id: changes[0]?.id,
      resource_ref: changes[0]?.resource_ref
    }));
    expect(await store.listWorkspaceJobs({ workspaceId: "workspace", rootActivityId: activity!.id })).toEqual([]);
    expect(await resourceCounts(store)).toEqual(before);
    expect(await learningCounts(store)).toEqual(beforeLearning);

    const query = new ActivityHistoryQueryService(store, new RoomAuthorizationService(store));
    await expect(query.getActivity({ context: ownerContext(otherRoom.id, "core07-room-boundary"), activityId: activity!.id }))
      .rejects.toThrow("activity_query_room_boundary_denied");
    await expect(query.listActivities({
      context: ownerContext(room!.id, "core07-room-query"),
      principalId: localOwnerParticipantId,
      sourceKind: "native_app",
      status: "completed"
    }))
      .resolves.toEqual(expect.arrayContaining([expect.objectContaining({ id: activity!.id })]));

    await runtime.shutdownMcpProcessPool();
    await store.close();
  });

  it("uses the same Activity contract for a Native App Session reference", async () => {
    const store = await createStore();
    const now = nowIso();
    const room: RoomRecord = { id: "room-core07-chat", name: "Chat Room", created_at: now, updated_at: now };
    const agent: AgentRecord = {
      id: "agent-core07-chat", name: "Core07 chat", role: "Assistant", instructions: "Respond briefly.",
      backend_id: "mock", enabled: true, created_at: now, updated_at: now
    };
    const session: SessionRecord = {
      id: "session-core07-chat", session_key: "core07:chat", room_id: room.id,
      title: "Core07 chat", ui_locale: "ja", output_locale: "ja", created_at: now, updated_at: now
    };
    await Promise.all([store.createRoomWithOwner(room, localOwnerParticipantId), store.createAgent(agent), store.createSession(session)]);
    await Promise.all([
      store.setRoomAgentPermissions({ roomId: room.id, agentId: agent.id, canView: true, canEdit: false, canExecute: true, actorId: localOwnerParticipantId }),
      store.ensureResourceAccessBoundary({ resourceKind: "session", resourceId: session.id, sourceRoomId: room.id, ownerParticipantId: localOwnerParticipantId, actorId: localOwnerParticipantId })
    ]);
    const runtime = new AgentRuntime(store, undefined, undefined, new AgentBackendRegistry([new MockBackend()]));

    const result = await runtime.runChatTurn({ sessionId: session.id, agent_id: agent.id, backend_id: "mock", content: "Activityを残す" });
    const activity = await store.getActivityByBackendRunId(result.backendRun.id);

    expect(activity).toMatchObject({
      workspace_id: "workspace",
      room_id: room.id,
      principal: { kind: "agent", agent_id: agent.id, requested_by_participant_id: localOwnerParticipantId },
      source: { kind: "native_app", app_id: "samurai-native" },
      status: "completed",
      backend_run_id: result.backendRun.id,
      session_ref: { app_id: "samurai-native", session_id: session.id }
    });
    expect(await store.listWorkspaceJobs({ workspaceId: "workspace", rootActivityId: activity!.id })).toEqual([]);

    await runtime.shutdownMcpProcessPool();
    await store.close();
  });

  it("keeps Activity recording while a Run waits, then records cancellation without inferring verification", async () => {
    const store = await createStore();
    const room = await store.getRoom("room_default");
    expect(room).toBeDefined();
    const backend = new WaitingWorkspaceBackend();
    const runtime = new AgentRuntime(store, undefined, undefined, new AgentBackendRegistry([backend]));
    const waiting = await runtime.runWorkspaceExecution({
      context: ownerContext(room!.id, "core07-cancelled"),
      backend_id: backend.id,
      input_summary: "取消されるActivity"
    });
    const recording = await store.getActivityByBackendRunId(waiting.run.id);
    expect(waiting.kind).toBe("waiting");
    expect(recording).toMatchObject({ status: "recording", backend_run_id: waiting.run.id, verification: [] });

    const cancelled = await runtime.cancelBackendRun(waiting.run.id);
    const activity = await store.getActivityByBackendRunId(waiting.run.id);
    expect(cancelled.status).toBe("cancelled");
    expect(activity).toMatchObject({
      status: "cancelled",
      backend_run_id: waiting.run.id,
      failure: expect.objectContaining({ code: expect.any(String) }),
      verification: []
    });

    await runtime.shutdownMcpProcessPool();
    await store.close();
  });

  it("runs an explicitly queued Fake Processor and stores only its versioned result", async () => {
    const store = await createStore();
    const room = await store.getRoom("room_default");
    expect(room).toBeDefined();
    const before = await resourceCounts(store);
    const runtime = new AgentRuntime(store, undefined, undefined, new AgentBackendRegistry([new MockBackend()]));
    const outcome = await runtime.runWorkspaceExecution({
      context: ownerContext(room!.id, "core07-explicit-job"),
      backend_id: "mock",
      input_summary: "明示的Job用のActivity"
    });
    const activity = await store.getActivityByBackendRunId(outcome.run.id);
    expect(activity).toBeDefined();
    const now = "2026-08-09T00:00:00.000Z";
    const job = await store.enqueueWorkspaceJob(jobRecord(activity!, now));
    const processors = new ActivityProcessorRegistry();
    processors.register(new DeterministicFakeActivityProcessor());
    const worker = new WorkspaceJobWorker(store, processors, "core07-test-worker", () => now);

    const handled = await worker.runNext({ leaseMs: 60_000 });
    const attempts = await store.listWorkspaceJobAttempts(job.id);

    expect(handled?.job).toMatchObject({ id: job.id, status: "completed" });
    expect(attempts).toEqual([
      expect.objectContaining({
        processor_id: "core07.fake",
        processor_version: "v1",
        input_schema_version: "activity_processor.input/v1",
        output_schema_version: "core07.fake-output/v1",
        status: "completed",
        output: expect.objectContaining({ activity_id: activity!.id })
      })
    ]);
    expect(await resourceCounts(store)).toEqual(before);

    await runtime.shutdownMcpProcessPool();
    await store.close();
  });

  it("heartbeats a long-running Fake Processor with an injected scheduler, without waiting in real time", async () => {
    const store = await createStore();
    const room = await store.getRoom("room_default");
    expect(room).toBeDefined();
    const runtime = new AgentRuntime(store, undefined, undefined, new AgentBackendRegistry([new MockBackend()]));
    const outcome = await runtime.runWorkspaceExecution({
      context: ownerContext(room!.id, "core07-heartbeat-worker"),
      backend_id: "mock",
      input_summary: "heartbeat確認用Activity"
    });
    const activity = await store.getActivityByBackendRunId(outcome.run.id);
    expect(activity).toBeDefined();
    let currentTime = "2026-08-09T00:00:00.000Z";
    const job = await store.enqueueWorkspaceJob({
      ...jobRecord(activity!, currentTime),
      id: "job-core07-heartbeat-worker",
      processor_id: "core07.blocking-fake",
      idempotency_key: "core07:heartbeat-worker"
    });
    let releaseProcessor: (() => void) | undefined;
    let markStarted: (() => void) | undefined;
    const processorStarted = new Promise<void>((resolve) => { markStarted = resolve; });
    const processorGate = new Promise<void>((resolve) => { releaseProcessor = resolve; });
    const processor: ActivityProcessorPort = {
      id: "core07.blocking-fake",
      version: "v1",
      async process(input, options) {
        markStarted?.();
        await processorGate;
        if (options.cancelSignal.aborted) throw new Error("workspace_job_cancelled");
        return {
          processor_id: "core07.blocking-fake",
          processor_version: "v1",
          output_schema_version: "core07.fake-output/v1",
          output: { activity_id: input.activity.id },
          summary: "Blocking fake completed.",
          diagnostics: []
        };
      }
    };
    const processors = new ActivityProcessorRegistry();
    processors.register(processor);
    let tick: (() => void | Promise<void>) | undefined;
    const scheduler: WorkspaceJobWorkerScheduler = {
      setInterval(callback) {
        tick = callback;
        return 0 as unknown as ReturnType<typeof setInterval>;
      },
      clearInterval() {
        tick = undefined;
      }
    };
    const worker = new WorkspaceJobWorker(store, processors, "core07-heartbeat-worker", () => currentTime, scheduler);
    const running = worker.runNext({ leaseMs: 1_000, heartbeatMs: 200 });

    await processorStarted;
    currentTime = "2026-08-09T00:00:00.500Z";
    await tick?.();
    expect((await store.getWorkspaceJob(job.id))?.lease_expires_at).toBe("2026-08-09T00:00:01.500Z");
    releaseProcessor?.();
    await expect(running).resolves.toMatchObject({ job: { id: job.id, status: "completed" } });
    expect(tick).toBeUndefined();

    await runtime.shutdownMcpProcessPool();
    await store.close();
  });
});

function ownerContext(roomId: string, correlationId: string) {
  return {
    workspace_id: "workspace",
    room_id: roomId,
    principal: { kind: "human" as const, participant_id: localOwnerParticipantId },
    source: { kind: "native_app" as const },
    correlation_id: correlationId
  };
}

function jobRecord(activity: NonNullable<Awaited<ReturnType<WorkspaceStore["getActivityByBackendRunId"]>>>, now: string): WorkspaceJobRecord {
  return {
    id: "job-core07-explicit",
    workspace_id: activity.workspace_id,
    room_id: activity.room_id,
    root_activity_id: activity.id,
    kind: "activity_processing",
    processor_id: "core07.fake",
    processor_version: "v1",
    idempotency_key: "core07:explicit-job",
    status: "queued",
    attempt_count: 0,
    max_attempts: 2,
    retryable: true,
    created_at: now,
    updated_at: now
  };
}

async function resourceCounts(store: WorkspaceStore) {
  const [memory, wiki, skill] = await Promise.all([store.listMemory(), store.listWiki(), store.listSkills()]);
  return { memory: memory.length, wiki: wiki.length, skill: skill.length };
}

async function learningCounts(store: WorkspaceStore) {
  const [reflectionRuns, evaluations, changes, curator] = await Promise.all([
    store.listReflectionRuns(),
    store.listLearningEvaluations(),
    store.listBackgroundReviewChanges(),
    store.getCuratorState()
  ]);
  return {
    reflectionRuns: reflectionRuns.length,
    evaluations: evaluations.length,
    backgroundReviewChanges: changes.length,
    curatorRunCount: curator.run_count
  };
}

class WorkspaceToolBackend implements AgentBackend {
  readonly id = "core07-workspace-tool";
  readonly kind = "mock" as const;
  readonly label = "Core07 Workspace Tool Fixture";
  readonly sessionPolicy = { acquisition: "provider_event" as const, resume: "unsupported" as const };
  readonly execution_owner = "host" as const;

  async *runTurn(_input: BackendRunInput): AsyncIterable<BackendOutputEvent> {
    yield { event_type: "run_started", payload: { input_summary: "Core07 tool fixture" } };
    yield {
      event_type: "tool_call_started",
      tool_call_id: "core07-file-write",
      payload: {
        tool_call_id: "core07-file-write",
        provider_tool_name: "file.write",
        action_id: "file.write",
        input: { path: "core07-tool.txt", content: "Activity must keep the actual Workspace Change reference." }
      }
    };
    yield {
      event_type: "run_completed",
      terminal_evidence: { kind: "completed", source: "owned_loop_return" },
      payload: { output_summary: "Core07 tool completed." }
    };
  }
}

class WaitingWorkspaceBackend implements AgentBackend {
  readonly id = "core07-waiting";
  readonly kind = "mock" as const;
  readonly label = "Core07 Waiting Fixture";
  readonly sessionPolicy = { acquisition: "provider_event" as const, resume: "native" as const };
  readonly execution_owner = "backend" as const;

  async *runTurn(_input: BackendRunInput): AsyncIterable<BackendOutputEvent> {
    yield { event_type: "run_started", payload: { input_summary: "waiting" } };
    yield {
      event_type: "backend_waiting_for_native_input",
      payload: { prompt: "Continue?", waiting_execution: "suspended" }
    };
  }

  async *resumeRun(_runId: string, _input: Record<string, import("@samurai-agent/core-schemas").JsonValue>): AsyncIterable<BackendOutputEvent> {
    yield {
      event_type: "run_completed",
      terminal_evidence: { kind: "completed", source: "owned_loop_return" },
      payload: { output_summary: "resumed" }
    };
  }

  async cancelRun() {
    return { kind: "settled" as const, evidence: { kind: "cancelled" as const, source: "owned_loop_return" as const } };
  }
}
