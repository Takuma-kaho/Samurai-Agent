import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { localOwnerParticipantId } from "@samurai-agent/room-permissions";
import { WorkspaceStore } from "@samurai-agent/workspace-store";
import { AgentRuntime, FakeProviderAdapter } from "./index.js";

const roots: string[] = [];
const allKinds = ["memory_review", "learning_evaluation", "skill_curator", "wiki_reindex", "daily_digest", "custom_instruction", "resource_translation"] as const;
const workspaceInstructionKinds = ["daily_digest", "custom_instruction", "resource_translation"] as const;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Core09 Session-free Automation", () => {
  it("classifies every kind as Session-free or safely blocked without consuming retry budget", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-core09-automation-kinds-"));
    roots.push(root);
    const store = await WorkspaceStore.create({ rootDir: root });
    const runtime = new AgentRuntime(store, undefined, new FakeProviderAdapter("fake/core09", async () => ({ content: "Done.", toolCalls: [] })));
    const dueAt = "2026-08-10T00:00:00.000Z";
    const jobs = await Promise.all(allKinds.map((kind) => runtime.saveAutomationJob({
      title: `Core09 ${kind}`,
      kind,
      schedule: "daily",
      target_instruction: `Run ${kind}`,
      next_run_at: "2026-08-09T00:00:00.000Z"
    })));
    const sessionsBefore = await store.listSessions();
    const runs = await runtime.runDueAutomationJobs(dueAt);
    const storedJobs = await Promise.all(jobs.map((job) => store.getAutomationJob(job.resource.id)));
    const storedRuns = await store.listAutomationRuns();

    const byKind = new Map(runs.map((run) => [run.automationRun.kind, run]));
    expect(byKind.get("wiki_reindex")).toMatchObject({ automationRun: { status: "completed" } });
    for (const kind of workspaceInstructionKinds) {
      expect(byKind.get(kind)).toMatchObject({
        automationRun: { status: "completed", backend_run_id: expect.any(String) }
      });
    }
    for (const kind of allKinds.filter((kind) => kind !== "wiki_reindex" && !workspaceInstructionKinds.includes(kind as typeof workspaceInstructionKinds[number]))) {
      expect(byKind.get(kind)).toMatchObject({
        automationRun: { status: "blocked", error_code: "automation_sessionless_executor_unsupported" },
        blocked: true
      });
    }
    expect(storedJobs.find((job) => job?.kind === "wiki_reindex")).toMatchObject({ authorization_state: "ready", failure_count: 0, last_run_at: expect.any(String) });
    for (const job of storedJobs.filter((job): job is NonNullable<typeof job> => Boolean(job && workspaceInstructionKinds.includes(job.kind as typeof workspaceInstructionKinds[number])))) {
      expect(job).toMatchObject({ status: "enabled", authorization_state: "ready", failure_count: 0, last_run_at: expect.any(String) });
    }
    for (const job of storedJobs.filter((job): job is NonNullable<typeof job> => Boolean(job && job.kind !== "wiki_reindex" && !workspaceInstructionKinds.includes(job.kind as typeof workspaceInstructionKinds[number])))) {
      expect(job).toMatchObject({ status: "disabled", authorization_state: "blocked", failure_count: 0, retry_after_at: undefined, locked_until: undefined });
    }
    expect(storedRuns).toHaveLength(allKinds.length);
    expect(storedRuns.every((run) => run.session_id === undefined && run.session_ref === undefined)).toBe(true);
    expect(await store.listSessions()).toEqual(sessionsBefore);

    await runtime.shutdownMcpProcessPool();
    await store.close();
  });

  it("re-evaluates an External App Connection immediately before an automation run", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-core09-automation-connection-"));
    roots.push(root);
    const store = await WorkspaceStore.create({ rootDir: root });
    const runtime = new AgentRuntime(store);
    const roomId = (await store.getSettings()).default_room_id!;
    const connection = await runtime.runDomainCommand({
      command_id: "external_app.connection.create",
      idempotency_key: "core09:automation:connection",
      payload: {
        connector_id: "connector-automation", app_id: "app-automation",
        delegated_principal: { kind: "human", participant_id: localOwnerParticipantId },
        allowed_room_ids: [roomId], ingress_classes: ["domain_operation"]
      }
    });
    const adapter = runtime.createReferenceExternalAppAdapter();
    const saved = await adapter.domainOperation({
      evidence: { connector_id: "connector-automation", app_id: "app-automation" },
      target: { requested_room_id: roomId, correlation_id: "core09-automation-external", idempotency_key: "core09:automation:job" },
      command_id: "automation.job.save",
      payload: {
        title: "External reindex", kind: "wiki_reindex", schedule: "daily", target_instruction: "Reindex",
        next_run_at: "2026-08-09T00:00:00.000Z", max_attempts: 3
      }
    });
    const job = (saved.result as { resource: { id: string } }).resource;
    await runtime.runDomainCommand({
      command_id: "external_app.connection.revoke",
      idempotency_key: "core09:automation:revoke",
      payload: { connection_id: (connection.result as { resource: { id: string } }).resource.id }
    });

    const results = await runtime.runDueAutomationJobs("2026-08-10T00:00:00.000Z");
    const blocked = results.find((result) => result.automationRun.job_id === job.id);
    const storedJob = await store.getAutomationJob(job.id);

    expect(blocked).toMatchObject({
      automationRun: { status: "blocked", error_code: "automation_connection_revoked" },
      blocked: true
    });
    expect(storedJob).toMatchObject({ authorization_state: "blocked", status: "disabled", failure_count: 0, retry_after_at: undefined });
    expect(await store.listSessions()).toEqual([]);

    await runtime.shutdownMcpProcessPool();
    await store.close();
  });

  it("blocks a direct authority revoked after the durable lock and never starts an executor", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-core09-automation-lock-race-"));
    roots.push(root);
    const store = await WorkspaceStore.create({ rootDir: root });
    const runtime = new AgentRuntime(store);
    const roomId = (await store.getSettings()).default_room_id!;
    const memberId = "human:core09-lock-race-member";
    const now = "2026-08-10T00:00:00.000Z";
    await store.addWorkspaceMember({ participantId: memberId, role: "member", actorId: localOwnerParticipantId });
    await store.addRoomMember({ roomId, participantId: memberId, role: "member", actorId: localOwnerParticipantId });
    await store.saveAutomationJob({
      id: "core09-lock-race-job", title: "Lock race reindex", kind: "wiki_reindex", status: "enabled", schedule: "daily",
      target_instruction: "Reindex", delivery_target: { channel: "automation" }, workspace_id: "workspace", room_id: roomId,
      authority: { kind: "direct_principal", principal: { kind: "human", participant_id: memberId } },
      created_principal_snapshot: { kind: "human", participant_id: memberId }, source_snapshot: { kind: "host" },
      authorization_state: "ready", authorized_at: now, next_run_at: "2026-08-09T00:00:00.000Z", failure_count: 0, max_attempts: 3,
      created_at: now, updated_at: now
    });
    const acquire = store.acquireAutomationJobLock.bind(store);
    let revoked = false;
    vi.spyOn(store, "acquireAutomationJobLock").mockImplementation(async (jobId, input) => {
      const locked = await acquire(jobId, input);
      if (locked && !revoked) {
        revoked = true;
        await store.removeRoomMember({ roomId, participantId: memberId, actorId: localOwnerParticipantId });
      }
      return locked;
    });
    const reindex = vi.spyOn(store, "reindexWiki");

    const [result] = await runtime.runDueAutomationJobs(now);
    const savedJob = await store.getAutomationJob("core09-lock-race-job");

    expect(result).toMatchObject({
      automationRun: { status: "blocked", error_code: "automation_room_permission_denied" },
      blocked: true
    });
    expect(reindex).not.toHaveBeenCalled();
    expect(savedJob).toMatchObject({ status: "disabled", authorization_state: "blocked", failure_count: 0, retry_after_at: undefined });
    await store.addRoomMember({ roomId, participantId: memberId, role: "member", actorId: localOwnerParticipantId });
    await runtime.runDomainCommand({
      command_id: "automation.job.reauthorize", idempotency_key: "core09:lock-race:reauthorize", payload: { job_id: "core09-lock-race-job" }
    }, {
      participant: { kind: "human", participantId: memberId }, roomId,
      source: { kind: "host" }, correlationId: "core09-lock-race-reauthorize"
    });
    expect(await store.getAutomationJob("core09-lock-race-job")).toMatchObject({
      status: "disabled", authorization_state: "ready",
      authority: { kind: "direct_principal", principal: { participant_id: memberId } }
    });
    expect(await store.listSessions()).toEqual([]);

    await runtime.shutdownMcpProcessPool();
    await store.close();
  });

  it("runs a direct Agent authority without a Connection and blocks it after Agent permission revocation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-core09-automation-agent-"));
    roots.push(root);
    const store = await WorkspaceStore.create({ rootDir: root });
    const runtime = new AgentRuntime(store);
    const roomId = (await store.getSettings()).default_room_id!;
    const agentId = "agent-core09-automation";
    const now = "2026-08-10T00:00:00.000Z";
    await store.createAgent({
      id: agentId, name: "Core09 automation Agent", role: "Operator", instructions: "Core09 fixture.",
      backend_id: "samurai-native", enabled: true, created_at: now, updated_at: now
    });
    await store.setRoomAgentPermissions({ roomId, agentId, canView: true, canEdit: true, canExecute: true, actorId: localOwnerParticipantId });
    const saved = await runtime.runDomainCommand({
      command_id: "automation.job.save",
      idempotency_key: "core09:automation:agent",
      payload: {
        title: "Agent reindex", kind: "wiki_reindex", schedule: "daily", target_instruction: "Reindex",
        next_run_at: "2026-08-09T00:00:00.000Z", max_attempts: 3
      }
    }, {
      participant: { kind: "agent", agentId, requestedByParticipantId: localOwnerParticipantId },
      roomId, source: { kind: "host" }, correlationId: "core09-automation-agent"
    });
    const jobId = (saved.result as { resource: { id: string } }).resource.id;
    const job = await store.getAutomationJob(jobId);
    expect(job).toMatchObject({
      authority: { kind: "direct_principal", principal: { kind: "agent", agent_id: agentId } }
    });
    expect(job?.connection_id).toBeUndefined();

    await store.removeRoomAgent({ roomId, agentId, actorId: localOwnerParticipantId });
    const [blocked] = await runtime.runDueAutomationJobs(now);
    expect(blocked).toMatchObject({
      automationRun: { status: "blocked", error_code: "automation_room_permission_denied" }, blocked: true
    });
    expect(await store.getAutomationJob(jobId)).toMatchObject({ status: "disabled", authorization_state: "blocked", failure_count: 0 });
    expect(await store.listSessions()).toEqual([]);

    await runtime.shutdownMcpProcessPool();
    await store.close();
  });

  it("requires an explicit rebind and leaves legacy jobs disabled afterward", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-core09-automation-rebind-"));
    roots.push(root);
    const store = await WorkspaceStore.create({ rootDir: root });
    const runtime = new AgentRuntime(store);
    const roomId = (await store.getSettings()).default_room_id!;
    const now = "2026-08-10T00:00:00.000Z";
    await store.saveAutomationJob({
      id: "legacy-job-core09", title: "Legacy job", kind: "wiki_reindex", status: "enabled", schedule: "daily", target_instruction: "Legacy reindex",
      delivery_target: { channel: "legacy", room_id: "must-not-be-inferred" }, next_run_at: "2026-08-09T00:00:00.000Z",
      failure_count: 0, max_attempts: 3, created_at: now, updated_at: now
    });

    expect(await runtime.runDueAutomationJobs("2026-08-10T01:00:00.000Z")).toEqual([]);
    const rebound = await runtime.runDomainCommand({
      command_id: "automation.job.rebind_authority",
      idempotency_key: "core09:legacy:rebind",
      payload: { job_id: "legacy-job-core09" }
    }, {
      participant: { kind: "human", participantId: localOwnerParticipantId }, roomId,
      source: { kind: "host" }, correlationId: "core09-legacy-rebind"
    });
    const job = (rebound.result as { resource: { id: string } }).resource;
    const after = await store.getAutomationJob(job.id);

    expect(after).toMatchObject({
      status: "disabled", authorization_state: "ready", room_id: roomId,
      authority: { kind: "direct_principal", principal: { participant_id: localOwnerParticipantId } }
    });
    expect(await runtime.runDueAutomationJobs("2026-08-10T02:00:00.000Z")).toEqual([]);
    expect(await store.listSessions()).toEqual([]);

    await runtime.shutdownMcpProcessPool();
    await store.close();
  });

  it("lets a Room manager stop and resume scheduling without taking the job authority", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-core09-automation-manager-"));
    roots.push(root);
    const store = await WorkspaceStore.create({ rootDir: root });
    const runtime = new AgentRuntime(store);
    const roomId = (await store.getSettings()).default_room_id!;
    const memberId = "human:core09-manager-job-owner";
    await store.addWorkspaceMember({ participantId: memberId, role: "member", actorId: localOwnerParticipantId });
    await store.addRoomMember({ roomId, participantId: memberId, role: "member", actorId: localOwnerParticipantId });
    const saved = await runtime.runDomainCommand({
      command_id: "automation.job.save",
      idempotency_key: "core09:manager:save",
      payload: { title: "Member reindex", kind: "wiki_reindex", schedule: "daily", target_instruction: "Reindex", max_attempts: 3 }
    }, {
      participant: { kind: "human", participantId: memberId }, roomId,
      source: { kind: "host" }, correlationId: "core09-manager-save"
    });
    const jobId = (saved.result as { resource: { id: string } }).resource.id;
    const managerContext = {
      participant: { kind: "human" as const, participantId: localOwnerParticipantId }, roomId,
      source: { kind: "host" as const }, correlationId: "core09-manager-control"
    };
    await runtime.runDomainCommand({
      command_id: "automation.job.manager_stop", idempotency_key: "core09:manager:stop", payload: { job_id: jobId, note: "Room maintenance" }
    }, managerContext);
    expect(await store.getAutomationJob(jobId)).toMatchObject({
      status: "disabled", management_state: "manager_stopped",
      authority: { kind: "direct_principal", principal: { participant_id: memberId } }, management_operation_id: expect.any(String)
    });
    expect(await runtime.runDueAutomationJobs("2026-08-10T00:00:00.000Z")).toEqual([]);

    await runtime.runDomainCommand({
      command_id: "automation.job.manager_resume", idempotency_key: "core09:manager:resume", payload: { job_id: jobId }
    }, managerContext);
    expect(await store.getAutomationJob(jobId)).toMatchObject({ status: "disabled", management_state: "allowed" });
    await runtime.runDomainCommand({
      command_id: "automation.job.set_status", idempotency_key: "core09:manager:enable", payload: { job_id: jobId, status: "enabled" }
    }, managerContext);
    expect(await store.getAutomationJob(jobId)).toMatchObject({ status: "enabled", management_state: "allowed" });

    await runtime.shutdownMcpProcessPool();
    await store.close();
  });

  it("keeps a manager stop made during wiki reindex after the active run settles", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-core09-automation-manager-race-"));
    roots.push(root);
    const store = await WorkspaceStore.create({ rootDir: root });
    const runtime = new AgentRuntime(store);
    const roomId = (await store.getSettings()).default_room_id!;
    const saved = await runtime.runDomainCommand({
      command_id: "automation.job.save", idempotency_key: "core09:manager-race:save",
      payload: { title: "Active reindex", kind: "wiki_reindex", schedule: "daily", target_instruction: "Reindex", next_run_at: "2026-08-09T00:00:00.000Z", max_attempts: 3 }
    }, {
      participant: { kind: "human", participantId: localOwnerParticipantId }, roomId,
      source: { kind: "host" }, correlationId: "core09-manager-race-save"
    });
    const jobId = (saved.result as { resource: { id: string } }).resource.id;
    let executorStarted!: () => void;
    let allowExecutorFinish!: () => void;
    const executorStartedPromise = new Promise<void>((resolve) => { executorStarted = resolve; });
    const allowExecutorFinishPromise = new Promise<void>((resolve) => { allowExecutorFinish = resolve; });
    vi.spyOn(store, "reindexWiki").mockImplementation(async () => {
      executorStarted();
      await allowExecutorFinishPromise;
      return { active: 0, total: 0 };
    });
    const running = runtime.runDueAutomationJobs("2026-08-10T00:00:00.000Z");
    await executorStartedPromise;
    await runtime.runDomainCommand({
      command_id: "automation.job.manager_stop", idempotency_key: "core09:manager-race:stop", payload: { job_id: jobId }
    }, {
      participant: { kind: "human", participantId: localOwnerParticipantId }, roomId,
      source: { kind: "host" }, correlationId: "core09-manager-race-stop"
    });
    expect(await store.getAutomationJob(jobId)).toMatchObject({ management_state: "manager_stopped", status: "disabled", lock_owner_token: expect.any(String) });
    allowExecutorFinish();
    const [result] = await running;
    expect(result).toMatchObject({ automationRun: { status: "completed", job_id: jobId } });
    expect(await store.getAutomationJob(jobId)).toMatchObject({
      management_state: "manager_stopped", status: "disabled", locked_until: undefined, lock_owner_token: undefined
    });

    await runtime.shutdownMcpProcessPool();
    await store.close();
  });

  it("uses one durable lock claim and recovers an expired started run as a normal failure", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-core09-automation-recovery-"));
    roots.push(root);
    const store = await WorkspaceStore.create({ rootDir: root });
    const runtime = new AgentRuntime(store);
    const roomId = (await store.getSettings()).default_room_id!;
    const now = "2000-01-02T00:00:00.000Z";
    await store.saveAutomationJob({
      id: "core09-recovery-job", title: "Recovery reindex", kind: "wiki_reindex", status: "enabled", schedule: "daily", target_instruction: "Reindex",
      delivery_target: { channel: "automation" }, workspace_id: "workspace", room_id: roomId,
      authority: { kind: "direct_principal", principal: { kind: "human", participant_id: localOwnerParticipantId } },
      created_principal_snapshot: { kind: "human", participant_id: localOwnerParticipantId }, source_snapshot: { kind: "host" },
      authorization_state: "ready", authorized_at: now, next_run_at: "2000-01-01T00:00:00.000Z", failure_count: 0, max_attempts: 3,
      created_at: now, updated_at: now
    });
    const [first, second] = await Promise.all([
      store.acquireAutomationJobLock("core09-recovery-job", { now, lockedUntil: "2000-01-02T00:01:00.000Z", lockOwnerToken: "lock-first" }),
      store.acquireAutomationJobLock("core09-recovery-job", { now, lockedUntil: "2000-01-02T00:01:00.000Z", lockOwnerToken: "lock-second" })
    ]);
    const locked = first ?? second;
    expect(Boolean(first) !== Boolean(second)).toBe(true);
    expect(locked?.lock_owner_token).toMatch(/^lock-/);
    await store.createAutomationRun({
      id: "core09-recovery-run", kind: "wiki_reindex", source: "automation_job", status: "started", job_id: "core09-recovery-job",
      workspace_id: "workspace", room_id: roomId, authority: locked!.authority, started_at: now
    });
    expect(await runtime.runDueAutomationJobs("2000-01-03T00:00:00.000Z")).toEqual([]);
    expect(await store.getAutomationRun("core09-recovery-run")).toMatchObject({
      status: "failed", error_code: "automation_execution_interrupted", completed_at: expect.any(String)
    });
    expect(await store.getAutomationJob("core09-recovery-job")).toMatchObject({
      failure_count: 1, locked_until: undefined, lock_owner_token: undefined, last_error: "automation_execution_interrupted"
    });

    await runtime.shutdownMcpProcessPool();
    await store.close();
  });

  it("safely stops legacy learning entrypoints instead of creating scheduler Sessions", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-core09-automation-legacy-learning-"));
    roots.push(root);
    const store = await WorkspaceStore.create({ rootDir: root });
    const runtime = new AgentRuntime(store);

    await expect(runtime.runCuratorJob()).rejects.toMatchObject({
      code: "unavailable",
      message: "learning_session_required"
    });
    await expect(runtime.runEvaluationJob()).rejects.toMatchObject({
      code: "unavailable",
      message: "learning_session_required"
    });
    expect(await store.listSessions()).toEqual([]);

    await runtime.shutdownMcpProcessPool();
    await store.close();
  });
});
