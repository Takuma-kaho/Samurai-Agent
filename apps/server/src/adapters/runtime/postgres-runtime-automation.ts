import path from "node:path";
import {
  ActivityRecordSchema,
  AutomationJobRecordSchema,
  AutomationRunRecordSchema,
  PrincipalSchema,
  SessionRefSchema,
  TrustedWorkspaceSourceSchema,
  createId,
  nowIso,
  stableHash,
  type ActivityRecord,
  type AutomationJobRecord,
  type AutomationRunRecord,
  type JsonValue,
  type SessionRef
} from "@samurai-agent/core-schemas";
import type { AgentBackendRegistry } from "@samurai-agent/agent-backends";
import {
  nextAutomationOccurrence,
  type AutomationSchedulePolicy
} from "@samurai-agent/runtime";
import {
  PostgresWorkspaceDatabase,
  WorkspaceServerError,
  type WorkspaceRequestContext,
  type WorkspaceExternalRoomPrincipal,
  type WorkspaceServerStore,
  type WorkspaceSql
} from "@samurai-agent/workspace-server";
import type {
  WorkspaceAutomationSchedulerPort
} from "../../workers/workspace-worker-supervisor";
import { PostgresRuntimeChat } from "./postgres-runtime-chat";
import { assertAgentWorktreeSeparated } from "./agent-worktree";

export interface PostgresRuntimeAutomationJobInput {
  roomId: string;
  title: string;
  kind: AutomationJobRecord["kind"];
  schedule: string;
  targetInstruction: string;
  deliveryTarget?: Record<string, JsonValue>;
  enabled?: boolean;
  nextRunAt?: string;
  maxAttempts?: number;
  connectionId?: string;
  sessionRef?: unknown;
}

export interface PostgresRuntimeAutomationOptions {
  database: PostgresWorkspaceDatabase;
  store: WorkspaceServerStore;
  backendRegistry: AgentBackendRegistry;
  agentWorktreeRoot: string;
  coreWorkspaceRoot?: string;
  reindexWiki?: (context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, roomId: string) => Promise<{ active: number; total: number }>;
  /** Core-owned maintenance lanes for the non-chat Automation kinds. The
   * adapter owns the durable Automation lease; these ports own their own
   * Room-scoped persistence and policy checks. */
  runMemoryReview?: (context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, input: { roomId: string; signal: AbortSignal }) => Promise<PostgresRuntimeAutomationExecutionResult>;
  runLearningEvaluation?: (context: WorkspaceRequestContext, input: { roomId: string; workerId: string; signal: AbortSignal }) => Promise<PostgresRuntimeAutomationExecutionResult>;
  runSkillCurator?: (context: WorkspaceRequestContext, input: { roomId: string; workerId: string; signal: AbortSignal }) => Promise<PostgresRuntimeAutomationExecutionResult>;
  maxRuns?: number;
}

export interface PostgresRuntimeAutomationExecutionResult {
  status: "completed" | "failed" | "blocked";
  summary: string;
  errorCode?: string;
}

export type PostgresRuntimeAutomationRun = AutomationRunRecord & { scheduled_at: string; attempt_no: number };

interface AutomationJobRow {
  workspace_id: string;
  id: string;
  room_id: string;
  title: string;
  kind: string;
  status: string;
  schedule: string;
  target_instruction: string;
  delivery_target: unknown;
  authority: unknown;
  created_principal_snapshot: unknown;
  source_snapshot: unknown;
  connection_id: string | null;
  session_ref: unknown;
  authorization_state: string;
  authorization_error_code: string | null;
  authorized_at: string | null;
  blocked_at: string | null;
  rebound_at: string | null;
  management_state: string;
  management_operation_id: string | null;
  created_operation_id: string | null;
  rebound_operation_id: string | null;
  next_run_at: string | null;
  last_run_at: string | null;
  retry_after_at: string | null;
  locked_until: string | null;
  lock_owner_token: string | null;
  failure_count: number | string;
  max_attempts: number | string;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

interface AutomationRunRow {
  workspace_id: string;
  id: string;
  job_id: string;
  room_id: string;
  kind: string;
  source: string;
  session_ref: unknown;
  backend_run_id: string | null;
  status: string;
  operation_id: string | null;
  authority: unknown;
  connector_id: string | null;
  app_id: string | null;
  activity_id: string | null;
  error_code: string | null;
  scheduled_at: string;
  started_at: string;
  completed_at: string | null;
  blocked_at: string | null;
  error: string | null;
  attempt_no: number | string;
}

interface ActivityRow {
  id: string;
  record: unknown;
}

interface ClaimedAutomation {
  job: AutomationJobRecord;
  run: PostgresRuntimeAutomationRun;
  lockOwnerToken: string;
  activity: ActivityRecord;
}

const AUTOMATION_LEASE_MS = 15 * 60_000;
const AUTOMATION_LEASE_REFRESH_MS = 60_000;

/**
 * PostgreSQLのAutomation入口とWorker lane。
 *
 * Jobの作成・停止・再開はWorkspaceの操作台帳へ記録する。Workerは due
 * Job を短いtransactionでclaimし、transactionを保持したままBackendを
 * 呼ばない。外部実行後は同じRoomのRuntime ChatとAutomation Activityを
 * 確定し、途中停止時はlease期限切れの次tickで再試行できる。
 */
export class PostgresRuntimeAutomation implements WorkspaceAutomationSchedulerPort {
  private readonly database: PostgresWorkspaceDatabase;
  private readonly store: WorkspaceServerStore;
  private readonly backendRegistry: AgentBackendRegistry;
  private readonly agentWorktreeRoot: string;
  private readonly coreWorkspaceRoot?: string;
  private readonly reindexWiki?: PostgresRuntimeAutomationOptions["reindexWiki"];
  private readonly runMemoryReview?: PostgresRuntimeAutomationOptions["runMemoryReview"];
  private readonly runLearningEvaluation?: PostgresRuntimeAutomationOptions["runLearningEvaluation"];
  private readonly runSkillCurator?: PostgresRuntimeAutomationOptions["runSkillCurator"];
  private readonly maxRuns: number;

  constructor(options: PostgresRuntimeAutomationOptions) {
    this.database = options.database;
    this.store = options.store;
    this.backendRegistry = options.backendRegistry;
    this.agentWorktreeRoot = assertAgentWorktreeSeparated(options.agentWorktreeRoot, options.coreWorkspaceRoot);
    this.coreWorkspaceRoot = options.coreWorkspaceRoot;
    this.reindexWiki = options.reindexWiki;
    this.runMemoryReview = options.runMemoryReview;
    this.runLearningEvaluation = options.runLearningEvaluation;
    this.runSkillCurator = options.runSkillCurator;
    this.maxRuns = boundedInteger(options.maxRuns ?? 10, 1, 100);
  }

  async createJob(context: WorkspaceRequestContext, input: PostgresRuntimeAutomationJobInput): Promise<{ job: AutomationJobRecord; replayed: boolean }> {
    const roomId = requiredId(input.roomId, "automation_room_id_required");
    const title = requiredText(input.title, "automation_title_required", 200);
    const targetInstruction = requiredText(input.targetInstruction, "automation_target_instruction_required", 20_000);
    const schedule = requiredText(input.schedule, "automation_schedule_required", 4_000);
    const maxAttempts = boundedInteger(input.maxAttempts ?? 3, 1, 10);
    const now = nowIso();
    const nextRunAt = input.nextRunAt ?? now;
    assertDate(nextRunAt, "automation_next_run_at_invalid");
    const parsedSchedule = parseSchedule(schedule, nextRunAt);
    // Calling the policy once at admission catches malformed time zones and
    // intervals before a durable enabled Job can be created.
    nextAutomationOccurrence(parsedSchedule, { after: new Date(Date.parse(nextRunAt) - 1).toISOString() });
    const authority = await this.resolveAuthority(context, roomId, input.connectionId);
    const sessionRef = input.sessionRef ? SessionRefSchema.parse(input.sessionRef) : undefined;
    const jobId = createId("automation");
    const job = AutomationJobRecordSchema.parse({
      id: jobId,
      title,
      kind: input.kind,
      status: input.enabled === false ? "disabled" : "enabled",
      schedule,
      target_instruction: targetInstruction,
      delivery_target: input.deliveryTarget ?? {},
      workspace_id: context.workspaceId,
      room_id: roomId,
      authority: authority.authority,
      created_principal_snapshot: authority.principal,
      source_snapshot: authority.source,
      ...(authority.connectionId ? { connection_id: authority.connectionId } : {}),
      ...(sessionRef ? { session_ref: sessionRef } : {}),
      authorization_state: "ready",
      authorized_at: now,
      management_state: "allowed",
      created_operation_id: context.operationId,
      next_run_at: nextRunAt,
      failure_count: 0,
      max_attempts: maxAttempts,
      created_at: now,
      updated_at: now
    });

    const result = await this.store.runIdempotentResult(context, {
      action: "automation.job.save",
      input: {
        room_id: roomId,
        title,
        kind: input.kind,
        schedule,
        target_instruction: targetInstruction,
        delivery_target: input.deliveryTarget ?? {},
        enabled: input.enabled !== false,
        next_run_at: nextRunAt,
        max_attempts: maxAttempts,
        connection_id: input.connectionId ?? null,
        session_ref: sessionRef ?? null
      }
    }, async (sql) => {
      await this.assertRoom(sql, context.workspaceId, roomId, "edit");
      await sql.query(
        `INSERT INTO workspace_runtime_automation_jobs(
           workspace_id, id, room_id, title, kind, status, schedule,
           target_instruction, delivery_target, authority, created_principal_snapshot,
           source_snapshot, connection_id, session_ref, authorization_state,
           authorized_at, management_state, created_operation_id, next_run_at,
           failure_count, max_attempts, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::JSONB, $10::JSONB,
           $11::JSONB, $12::JSONB, $13, $14::JSONB, $15, $16, $17, $18, $19,
           $20, $21, $22, $22)`,
        [
          context.workspaceId,
          job.id,
          job.room_id,
          job.title,
          job.kind,
          job.status,
          job.schedule,
          job.target_instruction,
          jsonText(job.delivery_target),
          jsonText(job.authority),
          jsonText(job.created_principal_snapshot),
          jsonText(job.source_snapshot),
          job.connection_id ?? null,
          jsonText(job.session_ref ?? null),
          job.authorization_state,
          job.authorized_at,
          job.management_state,
          job.created_operation_id,
          job.next_run_at,
          job.failure_count,
          job.max_attempts,
          now
        ]
      );
      await this.insertWorkspaceEvent(sql, context, roomId, "automation.job.created", {
        job_id: job.id,
        kind: job.kind,
        status: job.status,
        authorization_state: job.authorization_state
      });
      return job;
    });
    return { job: result.value, replayed: result.replayed };
  }

  async listJobs(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, roomId?: string): Promise<AutomationJobRecord[]> {
    if (roomId) requiredId(roomId, "automation_room_id_invalid");
    return this.database.withContext(context, async (sql) => {
      const result = await sql.query<AutomationJobRow>(
        `SELECT * FROM workspace_runtime_automation_jobs
         WHERE workspace_id = $1 AND ($2::TEXT IS NULL OR room_id = $2)
         ORDER BY created_at DESC, id DESC`,
        [context.workspaceId, roomId ?? null]
      );
      return result.rows.map(jobFromRow);
    });
  }

  async listRuns(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, jobId: string): Promise<PostgresRuntimeAutomationRun[]> {
    requiredId(jobId, "automation_job_id_invalid");
    return this.database.withContext(context, async (sql) => {
      const result = await sql.query<AutomationRunRow>(
        `SELECT * FROM workspace_runtime_automation_runs
         WHERE workspace_id = $1 AND job_id = $2
         ORDER BY scheduled_at DESC, attempt_no DESC, id DESC`,
        [context.workspaceId, jobId]
      );
      return result.rows.map(runFromRow);
    });
  }

  async listRunsForRoom(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, roomId: string): Promise<PostgresRuntimeAutomationRun[]> {
    const normalizedRoomId = requiredId(roomId, "automation_room_id_invalid");
    return this.database.withContext(context, async (sql) => {
      await this.assertRoom(sql, context.workspaceId, normalizedRoomId, "read");
      const result = await sql.query<AutomationRunRow>(
        `SELECT runs.* FROM workspace_runtime_automation_runs runs
         WHERE runs.workspace_id = $1 AND runs.room_id = $2
         ORDER BY runs.scheduled_at DESC, runs.attempt_no DESC, runs.id DESC`,
        [context.workspaceId, normalizedRoomId]
      );
      return result.rows.map(runFromRow);
    });
  }

  async runNow(context: WorkspaceRequestContext, input: { roomId: string; kind: AutomationJobRecord["kind"] }): Promise<{ job: AutomationJobRecord; replayed: boolean }> {
    const roomId = requiredId(input.roomId, "automation_room_id_required");
    await this.database.withContext(context, async (sql) => this.assertRoom(sql, context.workspaceId, roomId, "execute"));
    const nextRunAt = nowIso();
    return this.createJob(context, {
      roomId,
      title: `Manual ${input.kind} run`,
      kind: input.kind,
      schedule: "once",
      targetInstruction: automationInstructionForKind(input.kind),
      deliveryTarget: { trigger: "manual", requested_kind: input.kind },
      nextRunAt,
      maxAttempts: 1
    });
  }

  async setManagementState(
    context: WorkspaceRequestContext,
    input: { jobId: string; state: "allowed" | "manager_stopped" }
  ): Promise<{ job: AutomationJobRecord; replayed: boolean }> {
    const jobId = requiredId(input.jobId, "automation_job_id_invalid");
    const result = await this.store.runIdempotentResult(context, {
      action: input.state === "manager_stopped" ? "automation.job.manager_stop" : "automation.job.manager_resume",
      input: { job_id: jobId, state: input.state }
    }, async (sql) => {
      const current = await sql.query<AutomationJobRow>(
        "SELECT * FROM workspace_runtime_automation_jobs WHERE workspace_id = $1 AND id = $2 FOR UPDATE",
        [context.workspaceId, jobId]
      );
      const job = current.rows[0] ? jobFromRow(current.rows[0]) : undefined;
      if (!job) throw new WorkspaceServerError("automation_job_not_found", 404);
      await this.assertRoom(sql, context.workspaceId, job.room_id!, "edit");
      const now = nowIso();
      const status = input.state === "manager_stopped" ? "disabled" : "enabled";
      const updated = await sql.query<AutomationJobRow>(
        `UPDATE workspace_runtime_automation_jobs
         SET management_state = $3, status = $4,
             next_run_at = CASE WHEN $3 = 'allowed' AND next_run_at IS NULL THEN $5 ELSE next_run_at END,
             management_operation_id = $6, locked_until = NULL, lock_owner_token = NULL,
             updated_at = $5
         WHERE workspace_id = $1 AND id = $2
         RETURNING *`,
        [context.workspaceId, job.id, input.state, status, now, context.operationId]
      );
      const saved = updated.rows[0];
      if (!saved) throw new WorkspaceServerError("automation_job_update_failed", 500);
      await this.insertWorkspaceEvent(sql, context, job.room_id!, "automation.job.management_changed", {
        job_id: job.id,
        management_state: input.state,
        status
      });
      return jobFromRow(saved);
    });
    return { job: result.value, replayed: result.replayed };
  }

  async runTick(context: WorkspaceRequestContext, input: { workerId: string; signal: AbortSignal }): Promise<{ claimed: number; completed: number; failed: number; blocked: number }> {
    let claimed = 0;
    let completed = 0;
    let failed = 0;
    let blocked = 0;
    for (let index = 0; index < this.maxRuns; index += 1) {
      if (input.signal.aborted) break;
      const claim = await this.claimNext(context, input.workerId);
      if (!claim) break;
      claimed += 1;
      const result = await this.executeClaimWithLease(context, claim, input.signal);
      if (result === "completed") completed += 1;
      if (result === "failed") failed += 1;
      if (result === "blocked") blocked += 1;
    }
    return { claimed, completed, failed, blocked };
  }

  async close(): Promise<void> {
    // The supervisor waits for the active tick. No separate timer or socket is
    // owned here, so closing is intentionally a no-op.
  }

  private async resolveAuthority(
    context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">,
    roomId: string,
    connectionId?: string
  ): Promise<{
    authority: Record<string, JsonValue>;
    principal: Record<string, JsonValue>;
    source: Record<string, JsonValue>;
    connectionId?: string;
  }> {
    if (!connectionId) {
      return {
        authority: { kind: "direct_principal", principal: { kind: "human", participant_id: context.accountId } },
        principal: { kind: "human", participant_id: context.accountId },
        source: { kind: "host" }
      };
    }
    const descriptors = await this.store.listConnectionDescriptors(context);
    const descriptor = descriptors.find((candidate) => candidate.id === connectionId);
    if (!descriptor || descriptor.status !== "active" || Date.parse(descriptor.expiresAt) <= Date.now()) {
      throw new WorkspaceServerError("automation_connection_not_active", 403);
    }
    if (!descriptor.allowedRoomIds.includes(roomId) || !descriptor.ingressClasses.includes("domain_operation")) {
      throw new WorkspaceServerError("automation_connection_scope_denied", 403);
    }
    const delegatedPrincipal = { kind: "human" as const, participant_id: descriptor.principalAccountId };
    return {
      authority: {
        kind: "external_connection",
        connection_id: descriptor.id,
        connector_id: descriptor.connectorId,
        app_id: descriptor.appId,
        delegated_principal: delegatedPrincipal
      },
      principal: {
        kind: "external_app",
        app_id: descriptor.appId,
        connector_id: descriptor.connectorId,
        delegated_by: delegatedPrincipal
      },
      source: { kind: "external_app", app_id: descriptor.appId, connector_id: descriptor.connectorId },
      connectionId: descriptor.id
    };
  }

  private async claimNext(context: WorkspaceRequestContext, workerId: string): Promise<ClaimedAutomation | undefined> {
    const now = nowIso();
    const lockOwnerToken = createId(`automation_lock_${workerId}`);
    return this.database.withContext(context, async (sql) => {
      const selected = await sql.query<AutomationJobRow>(
        `SELECT * FROM workspace_runtime_automation_jobs
         WHERE workspace_id = $1
           AND status = 'enabled'
           AND authorization_state = 'ready'
           AND management_state = 'allowed'
           AND next_run_at IS NOT NULL
           AND next_run_at <= $2
           AND (retry_after_at IS NULL OR retry_after_at <= $2)
           AND (locked_until IS NULL OR locked_until <= $2)
           AND samurai_can_room(workspace_id, room_id, 'execute')
         ORDER BY next_run_at, id
         FOR UPDATE SKIP LOCKED
         LIMIT 1`,
        [context.workspaceId, now]
      );
      const row = selected.rows[0];
      if (!row) return undefined;
      const job = jobFromRow(row);
      const scheduledAt = job.next_run_at ?? now;
      const lockedUntil = new Date(Date.parse(now) + AUTOMATION_LEASE_MS).toISOString();
      const locked = await sql.query<AutomationJobRow>(
        `UPDATE workspace_runtime_automation_jobs
         SET locked_until = $3, lock_owner_token = $4, updated_at = $2
         WHERE workspace_id = $1 AND id = $5
         RETURNING *`,
        [context.workspaceId, now, lockedUntil, lockOwnerToken, job.id]
      );
      if (!locked.rows[0]) throw new WorkspaceServerError("automation_job_claim_lost", 409);
      const lockedJob = jobFromRow(locked.rows[0]);
      const authority = lockedJob.authority;
      if (!authority) throw new WorkspaceServerError("automation_job_authority_missing", 409);
      const operationId = `automation_run_${stableHash({ job_id: job.id, scheduled_at: scheduledAt }).slice(0, 48)}`;
      const existing = await sql.query<AutomationRunRow>(
        `SELECT * FROM workspace_runtime_automation_runs
         WHERE workspace_id = $1 AND job_id = $2 AND scheduled_at = $3
         FOR UPDATE`,
        [context.workspaceId, job.id, scheduledAt]
      );
      let run: AutomationRunRow;
      if (!existing.rows[0]) {
        const inserted = await sql.query<AutomationRunRow>(
          `INSERT INTO workspace_runtime_automation_runs(
             workspace_id, id, job_id, room_id, kind, source, session_ref,
             status, operation_id, authority, connector_id, app_id,
             scheduled_at, started_at, attempt_no
           ) VALUES ($1, $2, $3, $4, $5, 'automation_job', $6::JSONB,
             'started', $7, $8::JSONB, $9, $10, $11, $12, 1)
           RETURNING *`,
          [
            context.workspaceId,
            createId("automationrun"),
            job.id,
            job.room_id,
            job.kind,
            jsonText(job.session_ref ?? null),
            operationId,
            jsonText(authority),
            job.connection_id ?? null,
            authority.kind === "external_connection" ? authority.app_id : null,
            scheduledAt,
            now
          ]
        );
        run = inserted.rows[0]!;
      } else {
        const prior = existing.rows[0];
        const attemptNo = Number(prior.attempt_no) + (prior.status === "failed" || prior.status === "blocked" ? 1 : 0);
        const restarted = await sql.query<AutomationRunRow>(
          `UPDATE workspace_runtime_automation_runs
           SET status = 'started', started_at = $3, completed_at = NULL, blocked_at = NULL,
               error_code = NULL, error = NULL, attempt_no = $4, operation_id = $5
           WHERE workspace_id = $1 AND id = $2
           RETURNING *`,
          [context.workspaceId, prior.id, now, attemptNo, operationId]
        );
        run = restarted.rows[0]!;
      }
      const activity = await this.ensureActivity(sql, context, lockedJob, run, now);
      if (run.activity_id !== activity.id) {
        const updatedRun = await sql.query<AutomationRunRow>(
          `UPDATE workspace_runtime_automation_runs SET activity_id = $3
           WHERE workspace_id = $1 AND id = $2 RETURNING *`,
          [context.workspaceId, run.id, activity.id]
        );
        run = updatedRun.rows[0] ?? run;
      }
      return { job: lockedJob, run: runFromRow(run), lockOwnerToken, activity };
    });
  }

  private async executeClaimWithLease(
    context: WorkspaceRequestContext,
    claim: ClaimedAutomation,
    inputSignal: AbortSignal
  ): Promise<"completed" | "failed" | "blocked"> {
    const leaseController = new AbortController();
    const signal = AbortSignal.any([inputSignal, leaseController.signal]);
    const refresh = async (): Promise<void> => {
      if (signal.aborted) return;
      try {
        await this.refreshClaimLease(context, claim);
      } catch {
        leaseController.abort();
      }
    };
    const timer = setInterval(() => { void refresh(); }, AUTOMATION_LEASE_REFRESH_MS);
    timer.unref?.();
    try {
      // A heartbeat failure aborts the external work. The final settlement
      // remains the source of truth: if the lease was actually lost, its
      // owner-token guarded update fails closed. A transient heartbeat error
      // after a successful settlement must not turn durable success into a
      // scheduler-level failure.
      return await this.executeClaim(context, claim, signal);
    } finally {
      clearInterval(timer);
    }
  }

  private async refreshClaimLease(context: WorkspaceRequestContext, claim: ClaimedAutomation): Promise<void> {
    const now = nowIso();
    const lockedUntil = new Date(Date.parse(now) + AUTOMATION_LEASE_MS).toISOString();
    const updated = await this.database.withContext(context, async (sql) => sql.query<{ id: string }>(
      `UPDATE workspace_runtime_automation_jobs
       SET locked_until = $3, updated_at = $2
       WHERE workspace_id = $1 AND id = $4 AND lock_owner_token = $5
       RETURNING id`,
      [context.workspaceId, now, lockedUntil, claim.job.id, claim.lockOwnerToken]
    ));
    if (!updated.rows[0]) throw new WorkspaceServerError("automation_claim_lease_lost", 409);
  }

  private async executeClaim(context: WorkspaceRequestContext, claim: ClaimedAutomation, signal: AbortSignal): Promise<"completed" | "failed" | "blocked"> {
    const roomId = requiredId(claim.job.room_id, "automation_room_id_required");
    let currentAuthority: Awaited<ReturnType<PostgresRuntimeAutomation["resolveAuthority"]>> | undefined;
    try {
      currentAuthority = await this.revalidateExecutionAuthority(context, claim.job, roomId);
    } catch (error) {
      const code = safeErrorCode(error) === "room_permission_denied" ? "automation_room_permission_denied" : safeErrorCode(error);
      await this.settleBlocked(context, claim, code);
      return "blocked";
    }
    if (claim.job.kind === "wiki_reindex") {
      if (!this.reindexWiki) {
        await this.settleBlocked(context, claim, "automation_executor_not_connected_for_kind");
        return "blocked";
      }
      if (signal.aborted) {
        await this.settleFailed(context, claim, "automation_worker_aborted");
        return "failed";
      }
      try {
        const result = await this.reindexWiki(context, roomId);
        await this.settle(context, claim, {
          status: "completed",
          resultSummary: `Reindexed Knowledge Wiki pages: ${result.active}/${result.total} active.`,
          nextRunAt: nextRunAt(claim.job.schedule, claim.run.scheduled_at)
        });
        return "completed";
      } catch (error) {
        await this.settleFailed(context, claim, safeErrorCode(error));
        return "failed";
      }
    }
    if (claim.job.kind === "memory_review") {
      if (!this.runMemoryReview) {
        await this.settleBlocked(context, claim, "automation_executor_not_connected_for_kind");
        return "blocked";
      }
      if (signal.aborted) {
        await this.settleFailed(context, claim, "automation_worker_aborted");
        return "failed";
      }
      try {
        const result = await this.runMemoryReview(context, { roomId, signal });
        await this.settleExecutionResult(context, claim, result);
        return result.status;
      } catch (error) {
        const code = safeErrorCode(error);
        await this.settleFailed(context, claim, code);
        return "failed";
      }
    }
    if (claim.job.kind === "learning_evaluation" || claim.job.kind === "skill_curator") {
      const execute = claim.job.kind === "learning_evaluation" ? this.runLearningEvaluation : this.runSkillCurator;
      if (!execute) {
        await this.settleBlocked(context, claim, "automation_executor_not_connected_for_kind");
        return "blocked";
      }
      if (signal.aborted) {
        await this.settleFailed(context, claim, "automation_worker_aborted");
        return "failed";
      }
      try {
        const result = await execute(context, { roomId, workerId: `automation:${claim.run.id}`, signal });
        await this.settleExecutionResult(context, claim, result);
        return result.status;
      } catch (error) {
        const code = safeErrorCode(error);
        await this.settleFailed(context, claim, code);
        return "failed";
      }
    }
    if (signal.aborted) {
      await this.settleFailed(context, claim, "automation_worker_aborted");
      return "failed";
    }
    let sessionRef = claim.job.session_ref;
    try {
      let chat = this.chat(context, claim.job, currentAuthority);
      let sessionId = runtimeSessionId(sessionRef);
      if (!sessionId || !(await chat.getSession(sessionId))) {
        const session = await chat.createSession({
          roomId,
          operationId: claim.run.operation_id ?? `automation_session_${stableHash({ job_id: claim.job.id, run_id: claim.run.id })}`,
          title: `Automation: ${claim.job.title}`
        });
        sessionId = session.id;
        sessionRef = { app_id: "samurai-workspace", session_id: session.id };
        await this.attachSessionRef(context, claim, sessionRef);
      }
      // The session lookup/creation may take time. Revalidate once more at the
      // actual external execution boundary so a revoked Connection cannot be
      // used merely because it was valid when the Job was claimed.
      currentAuthority = await this.revalidateExecutionAuthority(context, claim.job, roomId);
      chat = this.chat(context, claim.job, currentAuthority);
      const result = await chat.runChatTurn({
        sessionId,
        content: claim.job.target_instruction,
        metadata: {
          automation_job_id: claim.job.id,
          automation_run_id: claim.run.id,
          scheduled_at: claim.run.scheduled_at,
          attempt_no: claim.run.attempt_no
        },
        idempotencyKey: `automation_${stableHash({ job_id: claim.job.id, scheduled_at: claim.run.scheduled_at })}`,
        signal
      });
      if (result.backendRun.status !== "completed") {
        await this.settleFailed(context, claim, result.backendRun.error_code ?? "automation_backend_not_completed");
        return "failed";
      }
      await this.settleCompleted(context, claim, result.backendRun.id, sessionRef);
      return "completed";
    } catch (error) {
      const code = safeErrorCode(error);
      if (code === "automation_connection_not_active" || code === "automation_connection_scope_denied") {
        await this.settleBlocked(context, claim, code);
        return "blocked";
      }
      await this.settleFailed(context, claim, code);
      return "failed";
    }
  }

  private async revalidateExecutionAuthority(
    context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">,
    job: AutomationJobRecord,
    roomId: string
  ): Promise<Awaited<ReturnType<PostgresRuntimeAutomation["resolveAuthority"]>> | undefined> {
    if (!job.authority) throw new WorkspaceServerError("automation_job_authority_missing", 409);
    const currentAuthority = job.authority.kind === "external_connection"
      ? await this.resolveAuthority(context, roomId, requiredId(job.connection_id, "automation_connection_id_required"))
      : undefined;
    const allowed = await this.store.canExternalRoomAccess({
      workspaceId: context.workspaceId,
      roomId,
      principal: roomAuthorizationPrincipal(job.authority),
      action: "execute"
    });
    if (!allowed) throw new WorkspaceServerError("automation_room_permission_denied", 403);
    return currentAuthority;
  }

  private async settleExecutionResult(
    context: WorkspaceRequestContext,
    claim: ClaimedAutomation,
    result: PostgresRuntimeAutomationExecutionResult
  ): Promise<void> {
    if (result.status === "completed") {
      await this.settle(context, claim, {
        status: "completed",
        resultSummary: result.summary,
        nextRunAt: nextRunAt(claim.job.schedule, claim.run.scheduled_at)
      });
      return;
    }
    if (result.status === "blocked") {
      await this.settleBlocked(context, claim, result.errorCode ?? "automation_execution_blocked");
      return;
    }
    await this.settleFailed(context, claim, result.errorCode ?? "automation_execution_failed");
  }

  private chat(
    context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">,
    job: AutomationJobRecord,
    currentAuthority?: { principal: Record<string, JsonValue>; source: Record<string, JsonValue> }
  ): PostgresRuntimeChat {
    const principal = currentAuthority ? PrincipalSchema.parse(currentAuthority.principal) : automationPrincipal(job);
    const source = currentAuthority ? TrustedWorkspaceSourceSchema.parse(currentAuthority.source) : automationSource(job);
    return new PostgresRuntimeChat({
      database: this.database,
      workspaceId: context.workspaceId,
      accountId: context.accountId,
      backendRegistry: this.backendRegistry,
      agentWorktreeRoot: path.join(this.agentWorktreeRoot, context.workspaceId),
      ...(this.coreWorkspaceRoot ? { coreWorkspaceRoot: this.coreWorkspaceRoot } : {}),
      principal,
      source,
      sessionRefAppId: "samurai-workspace"
    });
  }

  private async attachSessionRef(context: WorkspaceRequestContext, claim: ClaimedAutomation, sessionRef: SessionRef): Promise<void> {
    await this.database.withContext(context, async (sql) => {
      const updated = await sql.query(
        `UPDATE workspace_runtime_automation_jobs
         SET session_ref = $4::JSONB, updated_at = $3
         WHERE workspace_id = $1 AND id = $2 AND lock_owner_token = $5`,
        [context.workspaceId, claim.job.id, nowIso(), jsonText(sessionRef), claim.lockOwnerToken]
      );
      if (!updated.rowCount) throw new WorkspaceServerError("automation_claim_lease_lost", 409);
    });
  }

  private async settleCompleted(context: WorkspaceRequestContext, claim: ClaimedAutomation, backendRunId: string, sessionRef?: SessionRef): Promise<void> {
    await this.settle(context, claim, {
      status: "completed",
      backendRunId,
      sessionRef,
      resultSummary: "Automation instruction completed.",
      nextRunAt: nextRunAt(claim.job.schedule, claim.run.scheduled_at),
      errorCode: undefined,
      error: undefined
    });
  }

  private async settleFailed(context: WorkspaceRequestContext, claim: ClaimedAutomation, code: string): Promise<void> {
    const failureCount = claim.job.failure_count + 1;
    const retry = failureCount < claim.job.max_attempts;
    await this.settle(context, claim, {
      status: "failed",
      errorCode: code,
      error: code,
      ...(retry ? {
        retryAfterAt: new Date(Date.now() + retryDelayMs(failureCount)).toISOString(),
        nextRunAt: claim.run.scheduled_at
      } : {}),
      ...(retry ? {} : { nextRunAt: undefined })
    });
  }

  private async settleBlocked(context: WorkspaceRequestContext, claim: ClaimedAutomation, code: string): Promise<void> {
    await this.settle(context, claim, {
      status: "blocked",
      errorCode: code,
      error: code,
      nextRunAt: undefined,
      blockJob: true
    });
  }

  private async settle(
    context: WorkspaceRequestContext,
    claim: ClaimedAutomation,
    input: {
      status: "completed" | "failed" | "blocked";
      backendRunId?: string;
      sessionRef?: SessionRef;
      resultSummary?: string;
      errorCode?: string;
      error?: string;
      retryAfterAt?: string;
      nextRunAt?: string;
      blockJob?: boolean;
    }
  ): Promise<void> {
    const now = nowIso();
    await this.database.withContext(context, async (sql) => {
      const jobStatus = input.blockJob || !input.nextRunAt ? "disabled" : "enabled";
      const updatedJob = await sql.query<AutomationJobRow>(
        `UPDATE workspace_runtime_automation_jobs
         SET status = CASE WHEN $3 THEN 'disabled' ELSE $4 END,
             authorization_state = CASE WHEN $3 THEN 'blocked' ELSE authorization_state END,
             authorization_error_code = CASE WHEN $3 THEN $5 ELSE authorization_error_code END,
             blocked_at = CASE WHEN $3 THEN $6 ELSE blocked_at END,
             session_ref = COALESCE($7::JSONB, session_ref),
             last_run_at = CASE WHEN $4 = 'completed' THEN $6 ELSE last_run_at END,
             next_run_at = $8::TIMESTAMPTZ,
             retry_after_at = $9::TIMESTAMPTZ,
             locked_until = NULL, lock_owner_token = NULL,
             failure_count = CASE WHEN $4 = 'completed' THEN 0 ELSE failure_count + 1 END,
             last_error = $10,
             updated_at = $6
         WHERE workspace_id = $1 AND id = $2 AND lock_owner_token = $11
         RETURNING *`,
        [
          context.workspaceId,
          claim.job.id,
          input.blockJob === true,
          jobStatus,
          input.errorCode ?? null,
          now,
          input.sessionRef ? jsonText(input.sessionRef) : null,
          input.nextRunAt ?? null,
          input.retryAfterAt ?? null,
          input.error ?? null,
          claim.lockOwnerToken
        ]
      );
      if (!updatedJob.rows[0]) throw new WorkspaceServerError("automation_claim_lease_lost", 409);
      await sql.query(
        `UPDATE workspace_runtime_automation_runs
         SET status = $3, backend_run_id = COALESCE($4, backend_run_id),
             session_ref = COALESCE($5::JSONB, session_ref), error_code = $6,
             error = $7, completed_at = $8,
             blocked_at = CASE WHEN $3 = 'blocked' THEN $8 ELSE blocked_at END
         WHERE workspace_id = $1 AND id = $2 AND status = 'started'`,
        [
          context.workspaceId,
          claim.run.id,
          input.status,
          input.backendRunId ?? null,
          input.sessionRef ? jsonText(input.sessionRef) : null,
          input.errorCode ?? null,
          input.error ?? null,
          now
        ]
      );
      await this.settleActivity(sql, context.workspaceId, claim.activity.id, input, now);
      await this.insertWorkspaceEvent(sql, context, requiredId(claim.job.room_id, "automation_room_id_required"), "automation.job.settled", {
        job_id: claim.job.id,
        run_id: claim.run.id,
        status: input.status,
        ...(input.errorCode ? { error_code: input.errorCode } : {})
      });
    });
  }

  private async ensureActivity(sql: WorkspaceSql, context: WorkspaceRequestContext, job: AutomationJobRecord, run: AutomationRunRow, now: string): Promise<ActivityRecord> {
    if (run.activity_id) {
      const existing = await sql.query<ActivityRow>(
        "SELECT id, record FROM workspace_runtime_activities WHERE workspace_id = $1 AND id = $2",
        [context.workspaceId, run.activity_id]
      );
      if (existing.rows[0]) {
        const activity = ActivityRecordSchema.parse(jsonValue(existing.rows[0].record));
        if (activity.status === "recording") return activity;
      }
    }
    const id = createId("activity");
    const activity = ActivityRecordSchema.parse({
      id,
      workspace_id: context.workspaceId,
      room_id: job.room_id,
      principal: automationPrincipal(job),
      source: automationSource(job),
      status: "recording",
      idempotency_key: `automation:${job.id}:${run.scheduled_at}:attempt:${run.attempt_no}`,
      instruction_summary: job.target_instruction,
      verification: [],
      ...(job.session_ref ? { session_ref: job.session_ref } : {}),
      domain_operation_ids: [run.operation_id ?? context.operationId],
      provenance: { kind: "host", source_id: run.id, recorded_at: now },
      created_at: now,
      updated_at: now
    });
    await sql.query(
      `INSERT INTO workspace_runtime_activities(workspace_id, id, room_id, status, idempotency_key, backend_run_id, record, created_at, updated_at)
       VALUES ($1, $2, $3, 'recording', $4, NULL, $5::JSONB, $6, $6)
       ON CONFLICT (workspace_id, room_id, idempotency_key) DO NOTHING`,
      [context.workspaceId, activity.id, activity.room_id, activity.idempotency_key, jsonText(activity), now]
    );
    const saved = await sql.query<ActivityRow>(
      "SELECT id, record FROM workspace_runtime_activities WHERE workspace_id = $1 AND id = $2",
      [context.workspaceId, activity.id]
    );
    return saved.rows[0] ? ActivityRecordSchema.parse(jsonValue(saved.rows[0].record)) : activity;
  }

  private async settleActivity(
    sql: WorkspaceSql,
    workspaceId: string,
    activityId: string,
    input: { status: "completed" | "failed" | "blocked"; resultSummary?: string; errorCode?: string; error?: string },
    now: string
  ): Promise<void> {
    const current = await sql.query<ActivityRow>(
      "SELECT id, record FROM workspace_runtime_activities WHERE workspace_id = $1 AND id = $2 FOR UPDATE",
      [workspaceId, activityId]
    );
    const row = current.rows[0];
    if (!row) return;
    const activity = ActivityRecordSchema.parse(jsonValue(row.record));
    if (activity.status !== "recording") return;
    const settled = ActivityRecordSchema.parse({
      ...activity,
      status: input.status === "completed" ? "completed" : "failed",
      ...(input.status === "completed" ? { result_summary: input.resultSummary ?? "Automation completed." } : { failure: { code: input.errorCode ?? "automation_failed", summary: input.error ?? input.errorCode ?? "Automation failed." } }),
      updated_at: now,
      finalized_at: now
    });
    await sql.query(
      "UPDATE workspace_runtime_activities SET status = $3, record = $4::JSONB, updated_at = $5 WHERE workspace_id = $1 AND id = $2",
      [workspaceId, activityId, settled.status, jsonText(settled), now]
    );
  }

  private async assertRoom(sql: WorkspaceSql, workspaceId: string, roomId: string, action: "read" | "edit" | "execute"): Promise<void> {
    const result = await sql.query<{ allowed: boolean }>("SELECT samurai_can_room($1, $2, $3) AS allowed", [workspaceId, roomId, action]);
    if (result.rows[0]?.allowed !== true) throw new WorkspaceServerError("room_permission_denied", 403);
  }

  private async insertWorkspaceEvent(sql: WorkspaceSql, context: Pick<WorkspaceRequestContext, "workspaceId" | "operationId">, roomId: string, kind: string, payload: Record<string, JsonValue>): Promise<void> {
    await sql.query(
      `INSERT INTO workspace_events(workspace_id, room_id, kind, operation_id, payload)
       VALUES ($1, $2, $3, $4, $5::JSONB)`,
      [context.workspaceId, roomId, kind, context.operationId, jsonText(payload)]
    );
  }
}

function jobFromRow(row: AutomationJobRow): AutomationJobRecord {
  return AutomationJobRecordSchema.parse({
    id: row.id,
    title: row.title,
    kind: row.kind,
    status: row.status,
    schedule: row.schedule,
    target_instruction: row.target_instruction,
    delivery_target: jsonRecord(row.delivery_target),
    workspace_id: row.workspace_id,
    room_id: row.room_id,
    ...(row.authority ? { authority: jsonValue(row.authority) } : {}),
    ...(row.created_principal_snapshot ? { created_principal_snapshot: jsonValue(row.created_principal_snapshot) } : {}),
    ...(row.source_snapshot ? { source_snapshot: jsonValue(row.source_snapshot) } : {}),
    ...(row.connection_id ? { connection_id: row.connection_id } : {}),
    ...(row.session_ref ? { session_ref: SessionRefSchema.parse(jsonValue(row.session_ref)) } : {}),
    authorization_state: row.authorization_state,
    ...(row.authorization_error_code ? { authorization_error_code: row.authorization_error_code } : {}),
    ...(row.authorized_at ? { authorized_at: row.authorized_at } : {}),
    ...(row.blocked_at ? { blocked_at: row.blocked_at } : {}),
    ...(row.rebound_at ? { rebound_at: row.rebound_at } : {}),
    management_state: row.management_state,
    ...(row.management_operation_id ? { management_operation_id: row.management_operation_id } : {}),
    ...(row.created_operation_id ? { created_operation_id: row.created_operation_id } : {}),
    ...(row.rebound_operation_id ? { rebound_operation_id: row.rebound_operation_id } : {}),
    ...(row.next_run_at ? { next_run_at: row.next_run_at } : {}),
    ...(row.last_run_at ? { last_run_at: row.last_run_at } : {}),
    ...(row.retry_after_at ? { retry_after_at: row.retry_after_at } : {}),
    ...(row.locked_until ? { locked_until: row.locked_until } : {}),
    ...(row.lock_owner_token ? { lock_owner_token: row.lock_owner_token } : {}),
    failure_count: Number(row.failure_count),
    max_attempts: Number(row.max_attempts),
    ...(row.last_error ? { last_error: row.last_error } : {}),
    created_at: row.created_at,
    updated_at: row.updated_at
  });
}

function runFromRow(row: AutomationRunRow): PostgresRuntimeAutomationRun {
  return {
    ...AutomationRunRecordSchema.parse({
      id: row.id,
      kind: row.kind,
      source: row.source,
      ...(row.session_ref ? { session_ref: SessionRefSchema.parse(jsonValue(row.session_ref)) } : {}),
      ...(row.backend_run_id ? { backend_run_id: row.backend_run_id } : {}),
      status: row.status,
      ...(row.operation_id ? { operation_id: row.operation_id } : {}),
      job_id: row.job_id,
      workspace_id: row.workspace_id,
      room_id: row.room_id,
      ...(row.authority ? { authority: jsonValue(row.authority) } : {}),
      ...(row.connector_id ? { connector_id: row.connector_id } : {}),
      ...(row.app_id ? { app_id: row.app_id } : {}),
      ...(row.activity_id ? { activity_id: row.activity_id } : {}),
      ...(row.error_code ? { error_code: row.error_code } : {}),
      started_at: row.started_at,
      ...(row.completed_at ? { completed_at: row.completed_at } : {}),
      ...(row.blocked_at ? { blocked_at: row.blocked_at } : {}),
      ...(row.error ? { error: row.error } : {})
    }),
    scheduled_at: row.scheduled_at,
    attempt_no: Number(row.attempt_no)
  };
}

function automationPrincipal(job: AutomationJobRecord) {
  if (!job.authority) throw new WorkspaceServerError("automation_job_authority_missing", 409);
  if (job.authority.kind === "direct_principal") return PrincipalSchema.parse(job.authority.principal);
  return PrincipalSchema.parse({
    kind: "external_app",
    app_id: job.authority.app_id,
    connector_id: job.authority.connector_id,
    delegated_by: job.authority.delegated_principal
  });
}

function automationSource(job: AutomationJobRecord) {
  if (!job.authority) throw new WorkspaceServerError("automation_job_authority_missing", 409);
  return TrustedWorkspaceSourceSchema.parse(job.authority.kind === "external_connection"
    ? { kind: "external_app", app_id: job.authority.app_id, connector_id: job.authority.connector_id }
    : { kind: "host" });
}

function roomAuthorizationPrincipal(authority: NonNullable<AutomationJobRecord["authority"]>): WorkspaceExternalRoomPrincipal {
  const delegated = authority.kind === "direct_principal" ? authority.principal : authority.delegated_principal;
  return delegated.kind === "human"
    ? { kind: "human", participantId: delegated.participant_id }
    : { kind: "agent", agentId: delegated.agent_id, requestedByParticipantId: delegated.requested_by_participant_id };
}

function runtimeSessionId(sessionRef: SessionRef | undefined): string | undefined {
  return sessionRef?.app_id === "samurai-workspace" ? sessionRef.session_id : undefined;
}

function parseSchedule(value: string, fallbackAt: string): AutomationSchedulePolicy {
  const trimmed = value.trim();
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (isSchedulePolicy(parsed)) return parsed;
  } catch {
    // Human-readable legacy schedule labels are supported below.
  }
  const lower = trimmed.toLowerCase();
  if (["once", "one-shot", "oneshot"].includes(lower)) return { kind: "one_shot", at: fallbackAt };
  if (lower === "hourly") return { kind: "interval", every_minutes: 60, anchor: fallbackAt };
  if (lower === "daily") return { kind: "interval", every_minutes: 24 * 60, anchor: fallbackAt };
  if (lower === "weekly") return { kind: "interval", every_minutes: 7 * 24 * 60, anchor: fallbackAt };
  const match = lower.match(/^every\s+(\d+(?:\.\d+)?)\s+hours?$/);
  if (match) return { kind: "interval", every_minutes: Math.max(1, Math.round(Number(match[1]) * 60)), anchor: fallbackAt };
  throw new WorkspaceServerError("automation_schedule_invalid", 400);
}

function isSchedulePolicy(value: unknown): value is AutomationSchedulePolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.kind === "one_shot") return typeof candidate.at === "string";
  if (candidate.kind === "interval") return typeof candidate.every_minutes === "number" && candidate.every_minutes > 0 && typeof candidate.anchor === "string";
  return candidate.kind === "daily" && typeof candidate.timezone === "string" && typeof candidate.local_time === "string" && (candidate.missed_policy === "catch_up" || candidate.missed_policy === "skip");
}

function nextRunAt(schedule: string, scheduledAt: string): string | undefined {
  const policy = parseSchedule(schedule, scheduledAt);
  return nextAutomationOccurrence(policy, { after: scheduledAt, last_scheduled_at: scheduledAt });
}

function automationInstructionForKind(kind: AutomationJobRecord["kind"]): string {
  switch (kind) {
    case "memory_review": return "Run the Room-scoped Knowledge review through the configured Knowledge Host and record any blocked or proposed result.";
    case "learning_evaluation": return "Run the Room-scoped Knowledge evaluation and record its evidence-backed result.";
    case "skill_curator": return "Run the Room-scoped Skill curation and record its evidence-backed result.";
    case "wiki_reindex": return "Reindex the Room-scoped Knowledge Wiki pages and links.";
    case "daily_digest": return "Prepare a Room-scoped digest from authorized Activity and Knowledge.";
    case "resource_translation": return "Translate the requested Room-scoped resource through an authorized Domain Operation.";
    case "custom_instruction": return "Run the configured Room-scoped automation instruction.";
  }
}

function jsonText(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function jsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value) as unknown; } catch { throw new WorkspaceServerError("automation_json_invalid", 500); }
}

function jsonRecord(value: unknown): Record<string, JsonValue> {
  const parsed = jsonValue(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new WorkspaceServerError("automation_json_record_invalid", 500);
  return parsed as Record<string, JsonValue>;
}

function requiredId(value: string | undefined, code: string): string {
  if (!value?.trim()) throw new WorkspaceServerError(code, 400);
  return value.trim();
}

function requiredText(value: string | undefined, code: string, max: number): string {
  const normalized = value?.trim() ?? "";
  if (!normalized || normalized.length > max) throw new WorkspaceServerError(code, 400);
  return normalized;
}

function assertDate(value: string, code: string): void {
  if (!Number.isFinite(Date.parse(value))) throw new WorkspaceServerError(code, 400);
}

function boundedInteger(value: number, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new WorkspaceServerError("automation_attempt_limit_invalid", 400);
  return value;
}

function retryDelayMs(failureCount: number): number {
  return Math.min(15 * 60_000, 1_000 * 2 ** Math.max(0, failureCount - 1));
}

function safeErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim().slice(0, 256) || "automation_execution_failed";
}
