import { z } from "zod";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { ensureAgentWorktree, assertAgentWorktreeSeparated } from "./agent-worktree";
import {
  chatTurnRun,
  sessionCreate,
  type TrustedDomainContext
} from "@samurai-agent/domain-operations";
import {
  AuditRecordSchema,
  ActivityRecordSchema,
  ActivityInboxItemSchema,
  ArtifactRecordSchema,
  BackendEventRecordSchema,
  BackendTerminalEvidenceSchema,
  BackendRunRecordSchema,
  MessageEnvelopeSchema,
  ResourceRefSchema,
  type MessageRecord,
  type MemoryFrontmatter,
  SessionRecord,
  SupportedLocaleSchema,
  createId,
  nowIso,
  stableHash,
  type ActivityRecord,
  type ActivityInboxItem,
  type ArtifactRecord,
  type AuditRecord,
  type BackendEventRecord,
  type BackendRunRecord,
  type JsonValue,
  type MessageEnvelope,
  type MessagePresentationRecord,
  type OperationRecord,
  type ResourceRef,
  OperationRecordSchema,
  PrincipalSchema,
  TrustedWorkspaceSourceSchema,
  type WorkspaceChangeRecord,
  WorkspaceChangeRecordSchema,
  type SupportedLocale
} from "@samurai-agent/core-schemas";
import type { AgentBackendRegistry, BackendOutputEvent, BackendRunInput, BackendTerminalEvidence, MemoryCandidateLike, TemporaryContextAttachment } from "@samurai-agent/agent-backends";
import { BackendEventBridge, type RunChatTurnResult } from "@samurai-agent/runtime";
import {
  PostgresWorkspaceDatabase,
  WorkspaceServerError,
  type WorkspaceRequestContext,
  type WorkspaceSql
} from "@samurai-agent/workspace-server";

export interface PostgresRuntimeChatOptions {
  database: PostgresWorkspaceDatabase;
  workspaceId: string;
  accountId: string;
  backendRegistry: AgentBackendRegistry;
  agentWorktreeRoot: string;
  coreWorkspaceRoot?: string;
  defaultBackendId?: string;
  /** Room-scoped Knowledge query. The Runtime never reads Knowledge files directly. */
  knowledgeMemory?: PostgresRuntimeKnowledgePort;
  /** Emits only after the Runtime event has been persisted. The caller owns
   * Room re-authorization before a client sees the notification. */
  onEvent?: (event: BackendEventRecord, roomId: string) => Promise<void>;
  /** Completion receives the same settled Runtime result as the Chat caller.
   * It is a retry-safe evidence projection; it never replaces Runtime's
   * operational ledger. */
  onCompletionActivity?: (event: PostgresRuntimeChatCompletionEvent) => Promise<void>;
  /** Optional delegated identity used by the automation/external ingress. */
  principal?: import("@samurai-agent/core-schemas").Principal;
  source?: import("@samurai-agent/core-schemas").TrustedWorkspaceSource;
  sessionRefAppId?: string;
  operationId?: string;
  /** Reads a Room-authorized Workspace File through the formal file Port. */
  readWorkspaceFile?: (
    context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">,
    roomId: string,
    ref: ResourceRef
  ) => Promise<{ path: string; version: number; sha256: string; content: Buffer }>;
}

export interface PostgresRuntimeChatCompletionEvent {
  session: SessionRecord;
  run: BackendRunRecord;
  operation?: OperationRecord;
  instructionSummary: string;
  resultSummary?: string;
}

export interface PostgresRuntimeKnowledgePage {
  memory: MemoryFrontmatter & { file_path: string };
  content: string;
}

export interface PostgresRuntimeKnowledgePort {
  list(
    context: { workspaceId: string; accountId: string },
    roomId: string,
    includeArchived?: boolean
  ): Promise<PostgresRuntimeKnowledgePage[]>;
  search(
    context: { workspaceId: string; accountId: string },
    roomId: string,
    query: string,
    limit?: number
  ): Promise<Array<PostgresRuntimeKnowledgePage & { rank: number }>>;
}

export interface PostgresRuntimeSearchResult {
  kind: "session" | "message" | "artifact";
  id: string;
  title: string;
  summary: string;
  session_id?: string;
}

export interface PostgresRuntimeSessionInput {
  roomId: string;
  operationId: string;
  title?: string;
  uiLocale?: SupportedLocale;
  outputLocale?: SupportedLocale;
}

export interface PostgresRuntimeChatTurnInput {
  sessionId: string;
  content: string;
  agentId?: string;
  backendId?: string;
  inputLocale?: SupportedLocale;
  outputLocale?: SupportedLocale;
  metadata?: Record<string, JsonValue>;
  attachments?: Array<z.infer<typeof ResourceRefSchema>>;
  temporaryContext?: TemporaryContextAttachment[];
  idempotencyKey: string;
  retryOfRunId?: string;
  attemptNo?: number;
  /** Optional owner/lease cancellation for long-running worker executions. */
  signal?: AbortSignal;
}

export type PostgresRuntimeDomainCommandInput =
  | {
      operationId: "chat.turn.run";
      context: TrustedDomainContext;
      input: unknown;
    }
  | {
      operationId: "session.create";
      context: TrustedDomainContext;
      input: unknown;
    };

interface RuntimeAgent {
  id: string;
  name: string;
  role: string;
  instructions: string;
  backendId: string;
}

interface MaterializedWorkspaceAttachment {
  context: TemporaryContextAttachment;
  absolutePath: string;
}

const runtimeWorkspaceAttachmentMaxBytes = 8 * 1024 * 1024;
const runtimeWorkspaceAttachmentMaxTotalBytes = 32 * 1024 * 1024;

interface RuntimeAdmission {
  session: SessionRecord;
  agent?: RuntimeAgent;
  userMessage: MessageRecord;
  run: BackendRunRecord;
  operation: OperationRecord;
  activity: ActivityRecord;
  replay: boolean;
}

interface RuntimeRunRow {
  workspace_id: string;
  id: string;
  session_id: string | null;
  room_id: string | null;
  principal: unknown;
  source: unknown;
  session_ref: unknown;
  agent_id: string | null;
  requested_by_participant_id: string | null;
  input_message_id: string | null;
  output_message_id: string | null;
  backend_id: string;
  backend_kind: string;
  backend_session_id: string | null;
  status: string;
  phase: string | null;
  current_attempt: number | string | null;
  request_idempotency_key: string | null;
  request_hash: string | null;
  started_at: string;
  completed_at: string | null;
  input_summary: string;
  output_summary: string | null;
  error_code: string | null;
  metadata: unknown;
}

interface RuntimeMessageRow {
  workspace_id: string;
  id: string;
  session_id: string;
  role: string;
  content: string;
  input_locale: string;
  output_locale: string;
  envelope: unknown;
  created_at: string;
}

interface RuntimeSessionRow {
  workspace_id: string;
  id: string;
  session_key: string;
  room_id: string | null;
  title: string;
  ui_locale: string;
  output_locale: string;
  created_at: string;
  updated_at: string;
}

interface RuntimeActivityRow {
  workspace_id: string;
  id: string;
  room_id: string;
  status: string;
  idempotency_key: string;
  backend_run_id: string | null;
  record: unknown;
  created_at: string;
  updated_at: string;
}

interface RuntimeOperationRow {
  workspace_id: string;
  id: string;
  session_id: string | null;
  room_id: string | null;
  operation: string;
  status: string;
  payload: unknown;
  created_at: string;
  updated_at: string;
}

interface RuntimeAuditRecordRow {
  record: unknown;
}

interface RuntimeAgentRow {
  id: string;
  display_name: string;
  description: string;
  backend_id: string;
  status: string;
}

interface RuntimeChangeRow {
  id: string;
  run_id: string | null;
  session_id: string | null;
  room_id: string | null;
  activity_id: string | null;
  domain_operation_id: string | null;
  session_ref: unknown;
  resource_ref: unknown;
  change_type: string;
  summary: string;
  legacy_operation_id: string | null;
  correlation_id: string | null;
  created_at: string;
}

const RuntimeSessionRecordSchema = z.object({
  id: z.string().min(1),
  session_key: z.string().min(1),
  room_id: z.string().min(1).optional(),
  title: z.string(),
  ui_locale: SupportedLocaleSchema,
  output_locale: SupportedLocaleSchema,
  created_at: z.string().datetime(),
  updated_at: z.string().datetime()
}).strict();

const RuntimeMessageRecordSchema = z.object({
  id: z.string().min(1),
  session_id: z.string().min(1),
  role: z.enum(["user", "agent", "system"]),
  content: z.string(),
  input_locale: SupportedLocaleSchema,
  output_locale: SupportedLocaleSchema,
  envelope: MessageEnvelopeSchema.optional(),
  created_at: z.string().datetime()
}).strict();

/**
 * PostgreSQLの標準Serverが使う、Room限定のRuntime入口。
 *
 * このクラスはSQLite Storeを隠れて再利用しない。Admission、RunのCAS、
 * Eventの重複排除、Activityの確定を、v43のRuntimeテーブルと一つのRLS
 * transaction contextで行う。KnowledgeやArtifact等の別Use Caseは、それぞれ
 * のPostgreSQLサービスへ委譲し、ここで成功したことにはしない。
 */
export class PostgresRuntimeChat {
  private readonly database: PostgresWorkspaceDatabase;
  private readonly workspaceId: string;
  private readonly accountId: string;
  private readonly backendRegistry: AgentBackendRegistry;
  private readonly agentWorktreeRoot: string;
  private readonly coreWorkspaceRoot?: string;
  private readonly defaultBackendId: string;
  private readonly knowledgeMemory?: PostgresRuntimeKnowledgePort;
  private readonly onEvent?: PostgresRuntimeChatOptions["onEvent"];
  private readonly onCompletionActivity?: PostgresRuntimeChatOptions["onCompletionActivity"];
  private readonly principal?: import("@samurai-agent/core-schemas").Principal;
  private readonly source?: import("@samurai-agent/core-schemas").TrustedWorkspaceSource;
  private readonly sessionRefAppId: string;
  private readonly operationId?: string;
  private readonly readWorkspaceFile?: PostgresRuntimeChatOptions["readWorkspaceFile"];

  constructor(options: PostgresRuntimeChatOptions) {
    this.database = options.database;
    this.workspaceId = requireId(options.workspaceId, "workspace_id_required");
    this.accountId = requireId(options.accountId, "account_id_required");
    this.backendRegistry = options.backendRegistry;
    this.agentWorktreeRoot = assertAgentWorktreeSeparated(requireId(options.agentWorktreeRoot, "agent_worktree_root_required"), options.coreWorkspaceRoot);
    this.coreWorkspaceRoot = options.coreWorkspaceRoot;
    this.defaultBackendId = options.defaultBackendId?.trim() || "samurai-native";
    this.knowledgeMemory = options.knowledgeMemory;
    this.onEvent = options.onEvent;
    this.onCompletionActivity = options.onCompletionActivity;
    this.principal = options.principal ? PrincipalSchema.parse(options.principal) : undefined;
    this.source = options.source ? TrustedWorkspaceSourceSchema.parse(options.source) : undefined;
    this.sessionRefAppId = options.sessionRefAppId?.trim() || "samurai-native";
    this.operationId = options.operationId?.trim() || undefined;
    this.readWorkspaceFile = options.readWorkspaceFile;
  }

  async createSession(input: PostgresRuntimeSessionInput): Promise<SessionRecord> {
    const roomId = requireId(input.roomId, "room_id_required");
    const operationId = requireId(input.operationId, "runtime_session_operation_id_required");
    const inputHash = stableHash({ roomId, title: input.title?.trim() || "New chat", uiLocale: input.uiLocale ?? "ja", outputLocale: input.outputLocale ?? input.uiLocale ?? "ja" });
    const now = nowIso();
    return this.database.withContext(this.context(), async (sql) => {
      await this.assertRoomCanExecute(sql, roomId);
      const operationRecordId = `session_create:${operationId}`;
      await sql.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`${this.workspaceId}|${operationRecordId}`]);
      const existing = await sql.query<{ session_id: string | null; room_id: string | null; payload: unknown }>(
        `SELECT session_id, room_id, payload FROM workspace_runtime_operations WHERE workspace_id = $1 AND id = $2 FOR UPDATE`,
        [this.workspaceId, operationRecordId]
      );
      if (existing.rows[0]) {
        const payload = jsonRecord(existing.rows[0].payload);
        if (payload.input_hash !== inputHash || existing.rows[0].room_id !== roomId) {
          throw new WorkspaceServerError("runtime_session_operation_conflict", 409);
        }
        const existingSessionId = typeof payload.session_id === "string" ? payload.session_id : existing.rows[0].session_id;
        if (!existingSessionId) throw new WorkspaceServerError("runtime_session_operation_invalid", 500);
        const saved = await sql.query<RuntimeSessionRow>(
          `SELECT workspace_id, id, session_key, room_id, title, ui_locale, output_locale, created_at, updated_at
           FROM workspace_runtime_sessions WHERE workspace_id = $1 AND id = $2`,
          [this.workspaceId, existingSessionId]
        );
        if (!saved.rows[0]) throw new WorkspaceServerError("runtime_session_operation_invalid", 500);
        return sessionFromRow(saved.rows[0]);
      }
      const session: SessionRecord = RuntimeSessionRecordSchema.parse({
        id: createId("session"),
        // Session keys are identifiers for one app conversation, not a global
        // account key. A unique value is required because retries must not merge
        // two user-created sessions.
        session_key: `workspace:${this.workspaceId}:${createId("thread")}`,
        room_id: roomId,
        title: input.title?.trim() || "New chat",
        ui_locale: input.uiLocale ?? "ja",
        output_locale: input.outputLocale ?? input.uiLocale ?? "ja",
        created_at: now,
        updated_at: now
      });
      await sql.query(
        `INSERT INTO workspace_runtime_sessions(
           workspace_id, id, session_key, room_id, title, ui_locale, output_locale, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)`,
        [this.workspaceId, session.id, session.session_key, roomId, session.title, session.ui_locale, session.output_locale, now]
      );
      await sql.query(
        `INSERT INTO workspace_runtime_operations(workspace_id, id, session_id, room_id, operation, status, payload, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'runtime.chat.session.create', 'completed', $5::JSONB, $6, $6)`,
        [this.workspaceId, operationRecordId, session.id, roomId, jsonText({ input_hash: inputHash, session_id: session.id }), now]
      );
      return session;
    });
  }

  async listSessions(): Promise<SessionRecord[]> {
    return this.database.withContext(this.context(), async (sql) => {
      const result = await sql.query<RuntimeSessionRow>(
        `SELECT workspace_id, id, session_key, room_id, title, ui_locale, output_locale, created_at, updated_at
         FROM workspace_runtime_sessions
         WHERE workspace_id = $1 AND room_id IS NOT NULL
         ORDER BY updated_at DESC`,
        [this.workspaceId]
      );
      return result.rows.map(sessionFromRow);
    });
  }

  async getSession(sessionId: string): Promise<SessionRecord | undefined> {
    return this.database.withContext(this.context(), async (sql) => {
      const result = await sql.query<RuntimeSessionRow>(
        `SELECT workspace_id, id, session_key, room_id, title, ui_locale, output_locale, created_at, updated_at
         FROM workspace_runtime_sessions WHERE workspace_id = $1 AND id = $2`,
        [this.workspaceId, requireId(sessionId, "session_id_required")]
      );
      const row = result.rows[0];
      return row ? sessionFromRow(row) : undefined;
    });
  }

  async getSessionDetail(sessionId: string): Promise<{
    session: SessionRecord;
    messages: MessageRecord[];
    messagePresentations: MessagePresentationRecord[];
    operations: OperationRecord[];
    artifacts: ArtifactRecord[];
    auditRecords: AuditRecord[];
    backendRuns: BackendRunRecord[];
    backendEvents: BackendEventRecord[];
    workspaceChanges: WorkspaceChangeRecord[];
    memory: Array<MemoryFrontmatter & { file_path: string }>;
    activity: ActivityInboxItem[];
  } | undefined> {
    const session = await this.getSession(sessionId);
    if (!session) return undefined;
    const [messages, backendRuns, backendEvents, artifacts, workspaceChanges, activity, memory, operations, auditRecords] = await Promise.all([
      this.listMessages(session.id),
      this.listRuns(session.id),
      this.listEventsForSession(session.id),
      session.room_id ? this.listArtifacts(session.room_id) : Promise.resolve([] as ArtifactRecord[]),
      this.listSessionWorkspaceChanges(session.id),
      this.listActivityInbox(session.id),
      session.room_id && this.knowledgeMemory
        ? this.knowledgeMemory.list(this.context(), session.room_id, false)
        : Promise.resolve([] as PostgresRuntimeKnowledgePage[]),
      this.listOperations(session.id),
      this.listAuditRecords(session.id)
    ]);
    return {
      session,
      messages,
      messagePresentations: [],
      operations,
      artifacts,
      auditRecords,
      backendRuns,
      backendEvents,
      workspaceChanges,
      memory: memory.map((page) => page.memory),
      activity
    };
  }

  listAgentBackends() {
    return this.backendRegistry.statuses();
  }

  async listBackendRuns(sessionId?: string): Promise<BackendRunRecord[]> {
    if (sessionId !== undefined) requireId(sessionId, "session_id_required");
    return this.database.withContext(this.context(), async (sql) => {
      const result = await sql.query<RuntimeRunRow>(
        `SELECT * FROM workspace_runtime_runs
         WHERE workspace_id = $1 AND ($2::TEXT IS NULL OR session_id = $2)
         ORDER BY started_at DESC, id DESC`,
        [this.workspaceId, sessionId ?? null]
      );
      return result.rows.map(runFromRow);
    });
  }

  async getBackendRun(runId: string): Promise<BackendRunRecord | undefined> {
    return this.database.withContext(this.context(), async (sql) => {
      const result = await sql.query<RuntimeRunRow>(
        `SELECT * FROM workspace_runtime_runs WHERE workspace_id = $1 AND id = $2`,
        [this.workspaceId, requireId(runId, "backend_run_id_required")]
      );
      return result.rows[0] ? runFromRow(result.rows[0]) : undefined;
    });
  }

  async listBackendEvents(runId: string): Promise<BackendEventRecord[]> {
    return this.database.withContext(this.context(), async (sql) => {
      const result = await sql.query<RuntimeEventRow>(
        `SELECT * FROM workspace_runtime_events
         WHERE workspace_id = $1 AND run_id = $2
         ORDER BY sequence, id`,
        [this.workspaceId, requireId(runId, "backend_run_id_required")]
      );
      return result.rows.map(eventFromRow);
    });
  }

  async cancelBackendRun(runId: string): Promise<BackendRunRecord> {
    const initial = await this.requireControlRun(runId);
    if (isSettled(initial)) return initial;
    const admission = await this.admissionForRun(initial);
    if (initial.status === "queued") {
      const evidence = { kind: "not_started" as const, source: "preflight_rejection" as const };
      const terminal = await this.controlTerminalEvent(initial, evidence, {
        code: "cancelled",
        message: "Queued run was cancelled before backend start.",
        retryable: false,
        causeCategory: "cancellation"
      }, "cancel");
      const cancelled = await this.commitTerminal({ admission, terminal, output: "", requestedCancel: true });
      await this.notifyControlCompletion(admission, cancelled, terminal, true);
      return cancelled;
    }

    const preExternal = isPreExternalPhase(initial.phase);
    const cancelling = await this.markCancelling(initial);
    if (isSettled(cancelling)) return cancelling;
    const backend = this.backendRegistry.get(cancelling.backend_id);
    let cancellation: { kind: "settled"; evidence: BackendTerminalEvidence } | { kind: "requested" } | { kind: "unsupported" } = { kind: "unsupported" };
    let cancelError: unknown;
    if (backend?.cancelRun) {
      try {
        cancellation = await withTimeout(backend.cancelRun(runId), 2_500);
      } catch (error) {
        cancelError = error;
      }
    }
    const latest = await this.getBackendRun(runId);
    if (!latest) throw new WorkspaceServerError(`runtime_backend_run_not_found:${runId}`, 404);
    if (isSettled(latest)) return latest;
    const evidence: BackendTerminalEvidence = cancellation.kind === "settled"
      ? cancellation.evidence
      : preExternal
        ? { kind: "not_started", source: "preflight_rejection" }
        : { kind: "indeterminate", reason: cancelError ? "cancel_unconfirmed" : "cancel_unconfirmed", providerStarted: true, mayHaveSideEffects: true };
    const failure = evidence.kind === "indeterminate"
      ? {
          code: cancelError ? "backend_cancel_failed" : "backend_cancel_unconfirmed",
          message: cancelError instanceof Error ? summarize(cancelError.message, 240) : "Backend cancellation could not be confirmed.",
          retryable: false,
          causeCategory: "cancellation" as const
        }
      : evidence.kind === "failed" ? evidence.error : undefined;
    const terminal = await this.controlTerminalEvent(cancelling, evidence, failure, "cancel");
    const settled = await this.commitTerminal({ admission, terminal, output: "", requestedCancel: true });
    await this.notifyControlCompletion(admission, settled, terminal, true);
    return settled;
  }

  async resumeBackendRun(runId: string, input: Record<string, JsonValue>): Promise<BackendRunRecord> {
    const initial = await this.requireControlRun(runId);
    if (isSettled(initial)) return initial;
    if (initial.status !== "waiting_for_backend_input") throw new WorkspaceServerError(`runtime_run_not_waiting:${runId}`, 409);
    const safeInput = validateResumeInput(input);
    const backend = this.backendRegistry.get(initial.backend_id);
    if (!backend?.resumeRun || !initial.backend_session_id) {
      const admission = await this.admissionForRun(initial);
      const failure = {
        code: !initial.backend_session_id ? "backend_native_session_missing" : "backend_resume_unsupported",
        message: !initial.backend_session_id ? "Backend cannot resume because its native Session ID is missing." : "Backend does not support resume.",
        retryable: false,
        causeCategory: "configuration" as const
      };
      const terminal = await this.controlTerminalEvent(initial, { kind: "not_started", source: "preflight_rejection" }, failure, "resume-unsupported");
      const settled = await this.commitTerminal({ admission, terminal, output: "" });
      await this.notifyControlCompletion(admission, settled, terminal);
      return settled;
    }
    const resumed = await this.prepareResumeRun(initial, safeInput);
    if (isSettled(resumed)) return resumed;
    const admission = await this.admissionForRun(resumed);
    const backendSessionId = resumed.backend_session_id;
    if (!backendSessionId) throw new WorkspaceServerError("runtime_resume_backend_session_missing", 409);
    const streamInput: Record<string, JsonValue> = { ...safeInput, backend_session_id: backendSessionId };
    const settled = await this.executeBackendStream({
      admission: { ...admission, run: resumed },
      stream: backend.resumeRun(resumed.id, streamInput),
      unknownOnError: true
    });
    await this.notifyCompletionActivity(await this.project(settled), admission.userMessage.content);
    return settled;
  }

  async syncBackendRun(runId: string): Promise<BackendRunRecord> {
    const run = await this.requireControlRun(runId);
    if (isSettled(run)) return run;
    const admission = await this.admissionForRun(run);
    const backend = this.backendRegistry.get(run.backend_id);
    if (!backend?.streamEvents) {
      const event = BackendEventRecordSchema.parse({
        id: `event:control-sync:${stableHash({ workspaceId: this.workspaceId, runId: run.id, attemptNo: run.current_attempt ?? 1 }).slice(0, 40)}`,
        run_id: run.id,
        session_id: run.session_id,
        event_type: "backend_stream_unavailable",
        sequence: await this.nextEventSequence(run.id),
        attempt_no: run.current_attempt ?? 1,
        source_event_id: `control:sync-unavailable:${run.id}:${run.current_attempt ?? 1}`,
        payload: { reason: "stream_sync_unsupported", message: "Backend stream synchronization is unavailable.", run_status: run.status },
        resource_refs: [],
        created_at: nowIso()
      });
      const saved = await this.appendEvent(event);
      if (saved) await this.notifyEvent(saved, admission.session.room_id!);
      return (await this.getBackendRun(run.id)) ?? run;
    }
    const settled = await this.executeBackendStream({ admission, stream: backend.streamEvents(run.id), unknownOnError: true });
    await this.notifyCompletionActivity(await this.project(settled), admission.userMessage.content);
    return settled;
  }

  async recoverBackendRun(runId: string): Promise<BackendRunRecord> {
    const run = await this.requireControlRun(runId);
    if (isSettled(run)) return run;
    const startedAt = Date.parse(run.started_at);
    if (!Number.isFinite(startedAt) || Date.now() - startedAt < 60_000) {
      throw new WorkspaceServerError("runtime_recovery_run_not_stale", 409);
    }
    const admission = await this.admissionForRun(run);
    const outcomeUnknown = run.status === "running";
    const evidence: BackendTerminalEvidence = outcomeUnknown
      ? { kind: "indeterminate", reason: "runtime_state_unavailable", providerStarted: true, mayHaveSideEffects: true }
      : {
          kind: "failed",
          source: "process_exit",
          error: {
            code: "runtime_recovery_admission_interrupted",
            message: "The process stopped before the backend was started.",
            retryable: true,
            causeCategory: "runtime"
          }
        };
    const terminal = await this.controlTerminalEvent(run, evidence, evidence.kind === "failed" ? evidence.error : {
      code: "runtime_recovery_outcome_unknown",
      message: "The process stopped while an external backend may have been running.",
      retryable: true,
      causeCategory: "runtime"
    }, "recover");
    const settled = await this.commitTerminal({ admission, terminal, output: "" });
    await this.notifyControlCompletion(admission, settled, terminal);
    return settled;
  }

  async retryBackendRun(runId: string, input: { idempotencyKey: string; confirmUnknown?: boolean }): Promise<RunChatTurnResult> {
    const original = await this.requireControlRun(runId);
    if (original.status !== "failed" && original.status !== "outcome_unknown") {
      throw new WorkspaceServerError("runtime_retry_requires_failed_or_unknown_run", 409);
    }
    if (original.status === "outcome_unknown" && input.confirmUnknown !== true) {
      throw new WorkspaceServerError("runtime_retry_unknown_confirmation_required", 409);
    }
    if (!original.session_id) throw new WorkspaceServerError("runtime_retry_session_missing", 409);
    const admission = await this.admissionForRun(original);
    const envelope = admission.userMessage.envelope;
    return this.runChatTurn({
      sessionId: original.session_id,
      content: admission.userMessage.content,
      ...(original.agent_id ? { agentId: original.agent_id } : {}),
      backendId: original.backend_id,
      inputLocale: admission.userMessage.input_locale,
      outputLocale: admission.userMessage.output_locale,
      metadata: envelope?.metadata ?? {},
      attachments: envelope?.attachments ?? [],
      idempotencyKey: requireId(input.idempotencyKey, "runtime_retry_idempotency_key_required"),
      retryOfRunId: original.id,
      attemptNo: (original.current_attempt ?? 1) + 1
    });
  }

  private async requireControlRun(runId: string): Promise<BackendRunRecord> {
    const run = await this.getBackendRun(runId);
    if (!run) throw new WorkspaceServerError(`runtime_backend_run_not_found:${runId}`, 404);
    if (!run.room_id) throw new WorkspaceServerError(`runtime_backend_run_room_missing:${runId}`, 409);
    await this.database.withContext(this.context(), async (sql) => this.assertRoomCanExecute(sql, run.room_id!));
    return run;
  }

  private async admissionForRun(run: BackendRunRecord): Promise<RuntimeAdmission> {
    if (!run.session_id || !run.room_id || !run.input_message_id) {
      throw new WorkspaceServerError(`runtime_run_admission_incomplete:${run.id}`, 409);
    }
    return this.database.withContext(this.context(), async (sql) => {
      await this.assertRoomCanExecute(sql, run.room_id!);
      const [sessionResult, messageResult, operationResult, activityResult] = await Promise.all([
        sql.query<RuntimeSessionRow>(
          `SELECT workspace_id, id, session_key, room_id, title, ui_locale, output_locale, created_at, updated_at
           FROM workspace_runtime_sessions WHERE workspace_id = $1 AND id = $2`,
          [this.workspaceId, run.session_id]
        ),
        sql.query<RuntimeMessageRow>(
          "SELECT * FROM workspace_runtime_messages WHERE workspace_id = $1 AND id = $2",
          [this.workspaceId, run.input_message_id]
        ),
        sql.query<RuntimeOperationRow>(
          `SELECT workspace_id, id, session_id, room_id, operation, status, payload, created_at, updated_at
           FROM workspace_runtime_operations WHERE workspace_id = $1 AND id = $2`,
          [this.workspaceId, runtimeOperationId(run.id)]
        ),
        sql.query<RuntimeActivityRow>(
          `SELECT * FROM workspace_runtime_activities
           WHERE workspace_id = $1 AND backend_run_id = $2 AND room_id = $3
           ORDER BY created_at DESC LIMIT 1`,
          [this.workspaceId, run.id, run.room_id]
        )
      ]);
      const sessionRow = sessionResult.rows[0];
      const messageRow = messageResult.rows[0];
      const operationRow = operationResult.rows[0];
      const activityRow = activityResult.rows[0];
      if (!sessionRow || !messageRow || !operationRow || !activityRow) {
        throw new WorkspaceServerError(`runtime_run_admission_incomplete:${run.id}`, 500);
      }
      return {
        session: sessionFromRow(sessionRow),
        userMessage: messageFromRow(messageRow),
        run,
        operation: operationFromRow(operationRow),
        activity: ActivityRecordSchema.parse(jsonValue(activityRow.record)),
        replay: true
      };
    });
  }

  private async markCancelling(run: BackendRunRecord): Promise<BackendRunRecord> {
    return this.database.withContext(this.context(), async (sql) => {
      await this.assertRoomCanExecute(sql, run.room_id!);
      const currentResult = await sql.query<RuntimeRunRow>(
        "SELECT * FROM workspace_runtime_runs WHERE workspace_id = $1 AND id = $2 FOR UPDATE",
        [this.workspaceId, run.id]
      );
      const current = currentResult.rows[0] ? runFromRow(currentResult.rows[0]) : undefined;
      if (!current) throw new WorkspaceServerError(`runtime_backend_run_not_found:${run.id}`, 404);
      if (isSettled(current)) return current;
      const currentPhase = current.phase ?? "admitted";
      const updated = await sql.query<RuntimeRunRow>(
        `UPDATE workspace_runtime_runs SET phase = 'cancelling'
         WHERE workspace_id = $1 AND id = $2 AND status = $3 AND phase = $4
         RETURNING *`,
        [this.workspaceId, current.id, current.status, currentPhase]
      );
      if (!updated.rows[0]) throw new WorkspaceServerError(`runtime_cancel_cas_conflict:${run.id}`, 409);
      return runFromRow(updated.rows[0]);
    });
  }

  private async prepareResumeRun(run: BackendRunRecord, input: Record<string, JsonValue>): Promise<BackendRunRecord> {
    return this.database.withContext(this.context(), async (sql) => {
      await this.assertRoomCanExecute(sql, run.room_id!);
      const currentResult = await sql.query<RuntimeRunRow>(
        "SELECT * FROM workspace_runtime_runs WHERE workspace_id = $1 AND id = $2 FOR UPDATE",
        [this.workspaceId, run.id]
      );
      const current = currentResult.rows[0] ? runFromRow(currentResult.rows[0]) : undefined;
      if (!current) throw new WorkspaceServerError(`runtime_backend_run_not_found:${run.id}`, 404);
      if (isSettled(current)) return current;
      if (current.status !== "waiting_for_backend_input" || current.phase !== "waiting") {
        throw new WorkspaceServerError(`runtime_run_not_waiting:${run.id}`, 409);
      }
      const now = nowIso();
      const event = BackendEventRecordSchema.parse({
        id: `event:control-resume:${stableHash({ workspaceId: this.workspaceId, runId: run.id, attemptNo: run.current_attempt ?? 1 }).slice(0, 40)}`,
        run_id: run.id,
        session_id: run.session_id,
        ...(run.backend_session_id ? { backend_session_id: run.backend_session_id } : {}),
        event_type: "backend_native_input_submitted",
        sequence: await nextSequence(sql, this.workspaceId, run.id),
        attempt_no: run.current_attempt ?? 1,
        source_event_id: `control:resume-input:${run.id}:${run.current_attempt ?? 1}`,
        payload: { submitted_at: now, has_input: Object.keys(input).length > 0 },
        resource_refs: [],
        created_at: now
      });
      await insertRuntimeEvent(sql, this.workspaceId, event);
      const updated = await sql.query<RuntimeRunRow>(
        `UPDATE workspace_runtime_runs
         SET status = 'running', phase = 'backend_starting', completed_at = NULL, error_code = NULL
         WHERE workspace_id = $1 AND id = $2 AND status = 'waiting_for_backend_input' AND phase = 'waiting'
         RETURNING *`,
        [this.workspaceId, run.id]
      );
      if (!updated.rows[0]) throw new WorkspaceServerError(`runtime_resume_cas_conflict:${run.id}`, 409);
      await sql.query(
        `INSERT INTO workspace_runtime_reservations(workspace_id, session_id, run_id, version, status, created_at, updated_at)
         VALUES ($1, $2, $3, 1, 'held', $4, $4)
         ON CONFLICT (workspace_id, session_id) DO UPDATE
         SET run_id = EXCLUDED.run_id, status = 'held', version = workspace_runtime_reservations.version + 1, updated_at = EXCLUDED.updated_at`,
        [this.workspaceId, run.session_id, run.id, now]
      );
      const operation = await this.operationForRun(sql, run.id);
      if (operation) await this.updateRuntimeOperation(sql, operation, { status: "created" });
      return runFromRow(updated.rows[0]);
    });
  }

  private async controlTerminalEvent(
    run: BackendRunRecord,
    evidence: BackendTerminalEvidence,
    failure: { code: string; message: string; retryable: boolean; causeCategory: string } | undefined,
    source: string
  ): Promise<BackendEventRecord> {
    const error = failure ?? (evidence.kind === "failed" ? evidence.error : undefined);
    const event = BackendEventRecordSchema.parse({
      id: `event:control:${stableHash({ workspaceId: this.workspaceId, runId: run.id, source, operationId: this.operationId ?? null }).slice(0, 48)}`,
      run_id: run.id,
      ...(run.session_id ? { session_id: run.session_id } : {}),
      ...(run.backend_session_id ? { backend_session_id: run.backend_session_id } : {}),
      event_type: evidence.kind === "completed" ? "run_completed" : "run_failed",
      sequence: await this.nextEventSequence(run.id),
      attempt_no: run.current_attempt ?? 1,
      source_event_id: `control:${source}:${run.id}:${run.current_attempt ?? 1}`,
      payload: {
        ...(error ? { error_code: error.code, message: summarize(error.message, 240), retryable: error.retryable, cause_category: error.causeCategory } : {}),
        terminal_evidence: evidence
      },
      resource_refs: [],
      created_at: nowIso()
    });
    return event;
  }

  private async notifyControlCompletion(admission: RuntimeAdmission, run: BackendRunRecord, terminal: BackendEventRecord, requestedCancel = false): Promise<void> {
    if (run.status === statusForTerminalEvent(terminal, requestedCancel)) {
      await this.notifyEvent(terminal, admission.session.room_id!);
    }
    if (isSettled(run)) await this.notifyCompletionActivity(await this.project(run), admission.userMessage.content);
  }

  async listWorkspaceChanges(sessionId?: string): Promise<WorkspaceChangeRecord[]> {
    if (sessionId !== undefined) requireId(sessionId, "session_id_required");
    return this.database.withContext(this.context(), async (sql) => {
      const result = await sql.query<RuntimeChangeRow>(
        `SELECT change.id, change.run_id, change.session_id, change.room_id,
                change.activity_id, change.domain_operation_id, change.session_ref,
                change.resource_ref, change.change_type, change.summary,
                change.legacy_operation_id, change.correlation_id, change.created_at
         FROM workspace_runtime_changes change
         WHERE change.workspace_id = $1 AND ($2::TEXT IS NULL OR change.session_id = $2)
         ORDER BY change.created_at DESC, change.id DESC`,
        [this.workspaceId, sessionId ?? null]
      );
      return result.rows.map((row) => WorkspaceChangeRecordSchema.parse({
        id: row.id,
        ...(row.run_id ? { run_id: row.run_id } : {}),
        ...(row.session_id ? { session_id: row.session_id } : {}),
        ...(row.room_id ? { room_id: row.room_id } : {}),
        ...(row.activity_id ? { activity_id: row.activity_id } : {}),
        ...(row.domain_operation_id ? { domain_operation_id: row.domain_operation_id } : {}),
        ...(row.session_ref ? { session_ref: jsonValue(row.session_ref) } : {}),
        resource_ref: jsonValue(row.resource_ref),
        change_type: row.change_type,
        summary: row.summary,
        ...(row.legacy_operation_id ? { legacy_operation_id: row.legacy_operation_id } : {}),
        ...(row.correlation_id ? { correlation_id: row.correlation_id } : {}),
        created_at: row.created_at
      }));
    });
  }

  async listActivity(roomId: string): Promise<ActivityInboxItem[]> {
    return this.database.withContext(this.context(), async (sql) => {
      const result = await sql.query<RuntimeActivityRow>(
        `SELECT * FROM workspace_runtime_activities
         WHERE workspace_id = $1 AND room_id = $2
         ORDER BY created_at DESC, id DESC`,
        [this.workspaceId, requireId(roomId, "room_id_required")]
      );
      return result.rows.map(activityInboxFromRow);
    });
  }

  async search(roomId: string, query: string): Promise<PostgresRuntimeSearchResult[]> {
    const normalizedRoomId = requireId(roomId, "room_id_required");
    const normalizedQuery = query.trim();
    if (!normalizedQuery) return [];
    return this.database.withContext(this.context(), async (sql) => {
      const pattern = `%${normalizedQuery}%`;
      const [sessions, messages, artifacts] = await Promise.all([
        sql.query<RuntimeSessionRow>(
          `SELECT workspace_id, id, session_key, room_id, title, ui_locale, output_locale, created_at, updated_at
           FROM workspace_runtime_sessions
           WHERE workspace_id = $1 AND room_id = $2 AND (title ILIKE $3 OR session_key ILIKE $3)
           ORDER BY updated_at DESC, id DESC LIMIT 50`,
          [this.workspaceId, normalizedRoomId, pattern]
        ),
        sql.query<RuntimeMessageRow>(
          `SELECT message.*
           FROM workspace_runtime_messages message
           JOIN workspace_runtime_sessions session
             ON session.workspace_id = message.workspace_id AND session.id = message.session_id
           WHERE message.workspace_id = $1 AND session.room_id = $2 AND message.content ILIKE $3
           ORDER BY message.created_at DESC, message.id DESC LIMIT 100`,
          [this.workspaceId, normalizedRoomId, pattern]
        ),
        sql.query<{ id: string; payload: unknown; content_hash: string }>(
          `SELECT id, payload, content_hash
           FROM workspace_records
           WHERE workspace_id = $1 AND room_id = $2 AND record_type = 'artifact' AND search_text ILIKE $3
           ORDER BY updated_at DESC, id DESC LIMIT 50`,
          [this.workspaceId, normalizedRoomId, pattern]
        )
      ]);
      return [
        ...sessions.rows.map((row): PostgresRuntimeSearchResult => ({
          kind: "session",
          id: row.id,
          title: row.title,
          summary: row.title
        })),
        ...messages.rows.map((row): PostgresRuntimeSearchResult => ({
          kind: "message",
          id: row.id,
          title: row.content.slice(0, 120),
          summary: row.content.slice(0, 240),
          session_id: row.session_id
        })),
        ...artifacts.rows.map((row): PostgresRuntimeSearchResult => {
          const payload = jsonRecord(row.payload);
          const title = typeof payload.title === "string" ? payload.title : row.id;
          const summary = typeof payload.content === "string" ? payload.content.slice(0, 240) : title;
          return { kind: "artifact", id: row.id, title, summary };
        })
      ];
    });
  }

  async runChatTurn(input: PostgresRuntimeChatTurnInput): Promise<RunChatTurnResult> {
    const content = input.content.trim();
    if (!content) throw new WorkspaceServerError("runtime_chat_content_required", 400);
    const idempotencyKey = requireId(input.idempotencyKey, "runtime_chat_idempotency_key_required");
    const sessionId = requireId(input.sessionId, "session_id_required");
    const session = await this.getSession(sessionId);
    if (!session?.room_id) throw new WorkspaceServerError("runtime_session_not_found_or_room_missing", 404);
    const knowledge = await this.relevantKnowledge(session.room_id, content);
    const agent = await this.resolveAgent(session.room_id, input.agentId);
    const requestedBackendId = input.backendId?.trim();
    if (agent && requestedBackendId && requestedBackendId !== agent.backendId) {
      throw new WorkspaceServerError("runtime_backend_agent_mismatch", 409);
    }
    const backendId = agent?.backendId || requestedBackendId || this.defaultBackendId;
    const backend = this.backendRegistry.get(backendId);
    if (!backend) throw new WorkspaceServerError(`runtime_backend_not_registered:${backendId}`, 409);
    const inputLocale = input.inputLocale ?? session.ui_locale;
    const outputLocale = input.outputLocale ?? session.output_locale;
    const envelope = MessageEnvelopeSchema.parse({
      id: createId("envelope"),
      source: this.source?.kind === "external_app" ? "webhook" : this.source?.kind === "host" ? "cron" : "web",
      actor_identity: this.source?.kind === "external_app" ? "external_app" : this.source?.kind === "host" ? "owner_scheduled" : "owner",
      session_key: session.session_key,
      user_intent: "chat",
      attachments: input.attachments ?? [],
      input_locale: inputLocale,
      output_locale: outputLocale,
      metadata: input.metadata ?? {},
      received_at: nowIso()
    });
    const requestHash = stableHash({
      session_id: session.id,
      room_id: session.room_id,
      agent_id: agent?.id ?? null,
      backend_id: backend.id,
      content,
      input_locale: inputLocale,
      output_locale: outputLocale,
      metadata: input.metadata ?? {},
      attachments: input.attachments ?? [],
      temporary_context: (input.temporaryContext ?? []).map(temporaryContextHash),
      retry_of_run_id: input.retryOfRunId ?? null,
      attempt_no: input.attemptNo ?? 1
    });
    const admission = await this.admit({
      session,
      agent,
      backend,
      envelope,
      content,
      requestHash,
      idempotencyKey,
      outputLocale,
      retryOfRunId: input.retryOfRunId,
      attemptNo: input.attemptNo
    });
    if (admission.replay) {
      if (isSettled(admission.run)) {
        const replayed = await this.project(admission.run);
        await this.notifyCompletionActivity(replayed, content);
        return replayed;
      }
      throw new WorkspaceServerError(`runtime_run_in_progress:${admission.run.id}`, 409);
    }

    // Admission is durable before the backend readiness check. If readiness
    // changes between the request and execution, settle that admitted run so
    // retries see a terminal record instead of a forever-queued reservation.
    const backendStatus = this.backendRegistry.status(backend.id);
    const notReadyReason = backendStatus && (!backendStatus.configured || backendStatus.enabled === false
      || (backendStatus.connection_state !== "ready" && backendStatus.connection_state !== "unverified"))
      ? backendStatus.reason ?? backend.id
      : undefined;
    if (notReadyReason) {
      const eventBridge = new BackendEventBridge({
        runId: admission.run.id,
        sessionId: session.id,
        attemptNo: admission.run.current_attempt ?? 1,
        startSequence: await this.nextEventSequence(admission.run.id)
      });
      const terminal = this.failureEvent(admission.run, new Error(`runtime_backend_not_ready:${notReadyReason}`), eventBridge);
      const failed = await this.commitAdmissionFailure({ admission, terminal, reason: `runtime_backend_not_ready:${notReadyReason}` });
      await this.notifyEvent(terminal, session.room_id);
      if (!isSettled(failed)) throw new WorkspaceServerError(`runtime_admission_failure_not_settled:${failed.id}`, 500);
      const result = await this.project(failed);
      await this.notifyCompletionActivity(result, content);
      throw new WorkspaceServerError(`runtime_backend_not_ready:${notReadyReason}`, 409);
    }

    let materializedAttachments: MaterializedWorkspaceAttachment[] = [];
    try {
      await ensureAgentWorktree(this.agentWorktreeRoot, this.coreWorkspaceRoot);
      materializedAttachments = await this.materializeWorkspaceAttachments(session.room_id, input.attachments ?? [], admission.run.id);
    } catch (error) {
      await this.rejectAdmittedRun(admission, session, content, error, "runtime_workspace_attachment_unavailable");
    }
    try {
      await this.transitionToExternalRunning(admission.run);
      const inputForBackend: BackendRunInput = {
        run_id: admission.run.id,
        session_id: session.id,
        room_id: session.room_id,
        ...(agent ? { agent_context: { id: agent.id, name: agent.name, role: agent.role, instructions: agent.instructions, authority: "supporting_context" as const } } : {}),
        input_message_id: admission.userMessage.id,
        workspace_root: this.agentWorktreeRoot,
        working_directory: this.agentWorktreeRoot,
        envelope,
        user_input: content,
        input_locale: inputLocale,
        output_locale: outputLocale,
        active_memory: knowledge.map((page) => memoryCandidate(page)),
        recent_messages: await this.listMessages(session.id),
        ...((input.temporaryContext?.length || materializedAttachments.length) ? {
          temporary_context: [...(input.temporaryContext ?? []), ...materializedAttachments.map((item) => item.context)]
        } : {}),
        metadata: input.metadata ?? {},
        context_intent: "light_chat",
        ...(input.signal ? { abort_signal: input.signal } : {})
      };
      const settled = await this.executeBackendStream({
        admission,
        stream: backend.runTurn(inputForBackend)
      });
      const result = await this.project(settled);
      await this.notifyCompletionActivity(result, content);
      return result;
    } finally {
      await Promise.all(materializedAttachments.map((item) => rm(item.absolutePath, { force: true }).catch(() => undefined)));
    }
  }

  private async materializeWorkspaceAttachments(
    roomId: string,
    refs: ResourceRef[],
    runId: string
  ): Promise<MaterializedWorkspaceAttachment[]> {
    const fileRefs = refs.filter((ref) => ref.kind === "file");
    if (fileRefs.length === 0) return [];
    if (!this.readWorkspaceFile) throw new WorkspaceServerError("runtime_workspace_attachment_reader_unavailable", 503);
    await mkdir(path.join(this.agentWorktreeRoot, "attachments"), { recursive: true, mode: 0o700 });
    let totalBytes = 0;
    const materialized: MaterializedWorkspaceAttachment[] = [];
    try {
      for (const ref of fileRefs) {
        const file = await this.readWorkspaceFile(this.context(), roomId, ref);
        if (ref.id !== file.sha256) throw new WorkspaceServerError("runtime_workspace_attachment_reference_mismatch", 409);
        if (ref.version !== undefined && ref.version !== String(file.version)) {
          throw new WorkspaceServerError("runtime_workspace_attachment_version_conflict", 409);
        }
        if (file.content.byteLength > runtimeWorkspaceAttachmentMaxBytes
          || totalBytes + file.content.byteLength > runtimeWorkspaceAttachmentMaxTotalBytes) {
          throw new WorkspaceServerError("runtime_workspace_attachment_too_large", 413);
        }
        totalBytes += file.content.byteLength;
        const extension = path.extname(file.path).replace(/[^A-Za-z0-9.]/g, "").slice(0, 16);
        const attachmentHash = stableHash({ runId, path: file.path, version: file.version });
        const relativePath = path.join("attachments", `workspace-${attachmentHash.slice(0, 48)}${extension}`);
        const absolutePath = path.join(this.agentWorktreeRoot, relativePath);
        await writeFile(absolutePath, file.content, { flag: "wx", mode: 0o600 }).catch(async (error: unknown) => {
          if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error;
          const existing = await readFile(absolutePath);
          if (!existing.equals(file.content)) throw new WorkspaceServerError("runtime_workspace_attachment_materialization_conflict", 409);
        });
        materialized.push({
          absolutePath,
          context: {
            id: `workspace_attachment_${attachmentHash.slice(0, 48)}`,
            kind: "workspace_file",
            label: ref.label ?? file.path,
            source_name: file.path,
            mime_type: "application/octet-stream",
            file_path: relativePath,
            created_at: nowIso(),
            expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
            metadata: { resource_kind: ref.kind, resource_id: ref.id, resource_uri: ref.uri, version: file.version }
          }
        });
      }
      return materialized;
    } catch (error) {
      await Promise.all(materialized.map((item) => rm(item.absolutePath, { force: true }).catch(() => undefined)));
      throw error;
    }
  }

  private async rejectAdmittedRun(
    admission: RuntimeAdmission,
    session: SessionRecord,
    instructionSummary: string,
    error: unknown,
    fallbackCode: string
  ): Promise<never> {
    const reason = error instanceof WorkspaceServerError ? error.code : fallbackCode;
    const eventBridge = new BackendEventBridge({
      runId: admission.run.id,
      sessionId: session.id,
      attemptNo: admission.run.current_attempt ?? 1,
      startSequence: await this.nextEventSequence(admission.run.id)
    });
    const terminal = this.failureEvent(admission.run, error, eventBridge);
    const failed = await this.commitAdmissionFailure({ admission, terminal, reason });
    await this.notifyEvent(terminal, requireId(session.room_id, "runtime_session_room_missing"));
    if (!isSettled(failed)) throw new WorkspaceServerError(`runtime_admission_failure_not_settled:${failed.id}`, 500);
    const result = await this.project(failed);
    await this.notifyCompletionActivity(result, instructionSummary);
    throw error instanceof WorkspaceServerError ? error : new WorkspaceServerError(fallbackCode, 503);
  }

  private async admit(input: {
    session: SessionRecord;
    agent?: RuntimeAgent;
    backend: { id: string; kind: string };
    envelope: MessageEnvelope;
    content: string;
    requestHash: string;
    idempotencyKey: string;
    outputLocale: SupportedLocale;
    retryOfRunId?: string;
    attemptNo?: number;
  }): Promise<RuntimeAdmission> {
    const now = nowIso();
    const runId = createId("run");
    const messageId = createId("message");
    const activityId = createId("activity");
    const source = this.source ?? { kind: "native_app" as const, app_id: "samurai-native" };
    const principal = input.agent
      ? { kind: "agent" as const, agent_id: input.agent.id, requested_by_participant_id: this.accountId }
      : this.principal ?? { kind: "human" as const, participant_id: this.accountId };
    const requestedByParticipantId = principal.kind === "human"
      ? principal.participant_id
      : principal.kind === "agent"
        ? principal.requested_by_participant_id
        : principal.kind === "external_app"
          ? principal.delegated_by.kind === "human" ? principal.delegated_by.participant_id : principal.delegated_by.requested_by_participant_id
          : this.accountId;
    const sessionRef = { app_id: this.sessionRefAppId, session_id: input.session.id };
    const run = BackendRunRecordSchema.parse({
      id: runId,
      session_id: input.session.id,
      room_id: input.session.room_id,
      principal,
      source,
      session_ref: sessionRef,
      ...(input.agent ? { agent_id: input.agent.id } : {}),
      requested_by_participant_id: requestedByParticipantId,
      input_message_id: messageId,
      backend_id: input.backend.id,
      backend_kind: input.backend.kind,
      status: "queued",
      phase: "admitted",
      current_attempt: input.attemptNo && input.attemptNo > 0 ? Math.floor(input.attemptNo) : 1,
      request_idempotency_key: input.idempotencyKey,
      request_hash: input.requestHash,
      started_at: now,
      input_summary: summarize(input.content),
      metadata: input.retryOfRunId ? { retry_of_run_id: input.retryOfRunId } : {}
    });
    const operation = buildRuntimeOperation({
      session: input.session,
      run,
      envelope: input.envelope,
      requestHash: input.requestHash,
      inputMessageId: messageId,
      now
    });
    const activity = ActivityRecordSchema.parse({
      id: activityId,
      workspace_id: this.workspaceId,
      room_id: input.session.room_id,
      principal,
      source,
      status: "recording",
      idempotency_key: `chat:${input.session.id}:${input.idempotencyKey}`,
      instruction_summary: summarize(input.content),
      verification: [],
      session_ref: sessionRef,
      backend_run_id: runId,
      domain_operation_ids: [operation.id],
      provenance: { kind: "host", source_id: runId, recorded_at: now },
      created_at: now,
      updated_at: now
    });
    const userMessage = RuntimeMessageRecordSchema.parse({
      id: messageId,
      session_id: input.session.id,
      role: "user",
      content: input.content,
      input_locale: input.envelope.input_locale,
      output_locale: input.outputLocale,
      envelope: input.envelope,
      created_at: now
    });
    const replayAdmission = async (sql: WorkspaceSql, replayRun: BackendRunRecord) => {
      if (replayRun.request_hash !== input.requestHash) throw new WorkspaceServerError("runtime_idempotency_conflict", 409);
      if (!replayRun.input_message_id) throw new WorkspaceServerError("runtime_replay_input_message_missing", 500);
      const replayMessage = await sql.query<RuntimeMessageRow>(
        `SELECT * FROM workspace_runtime_messages WHERE workspace_id = $1 AND id = $2`,
        [this.workspaceId, replayRun.input_message_id]
      );
      if (!replayMessage.rows[0]) throw new WorkspaceServerError("runtime_replay_input_message_missing", 500);
      const replayMessageRecord = messageFromRow(replayMessage.rows[0]);
      const replayOperation = await this.ensureRuntimeOperation(sql, {
        session: input.session,
        run: replayRun,
        envelope: replayMessageRecord.envelope ?? input.envelope,
        requestHash: input.requestHash,
        inputMessageId: replayMessageRecord.id,
        now: nowIso()
      });
      const replayActivity = await this.activityForRun(sql, replayRun.id, input.session.room_id!);
      return {
        session: input.session,
        ...(input.agent ? { agent: input.agent } : {}),
        userMessage: replayMessageRecord,
        run: replayRun,
        operation: replayOperation,
        activity: replayActivity ?? activity,
        replay: true as const
      };
    };
    return this.database.withContext(this.context(), async (sql) => {
      await this.assertRoomCanExecute(sql, input.session.room_id!);
      const existing = await sql.query<RuntimeRunRow>(
        `SELECT * FROM workspace_runtime_runs
         WHERE workspace_id = $1 AND session_id = $2 AND request_idempotency_key = $3`,
        [this.workspaceId, input.session.id, input.idempotencyKey]
      );
      if (existing.rows[0]) {
        return replayAdmission(sql, runFromRow(existing.rows[0]));
      }
      const held = await sql.query<{ run_id: string }>(
        `SELECT run_id FROM workspace_runtime_reservations
         WHERE workspace_id = $1 AND session_id = $2 AND status = 'held'
         FOR UPDATE`,
        [this.workspaceId, input.session.id]
      );
      if (held.rows[0]) {
        const heldRunResult = await sql.query<RuntimeRunRow>(
          "SELECT * FROM workspace_runtime_runs WHERE workspace_id = $1 AND id = $2",
          [this.workspaceId, held.rows[0].run_id]
        );
        const heldRun = heldRunResult.rows[0];
        if (heldRun?.request_idempotency_key === input.idempotencyKey) {
          return replayAdmission(sql, runFromRow(heldRun));
        }
        throw new WorkspaceServerError(`runtime_session_run_in_progress:${held.rows[0].run_id}`, 409);
      }
      await sql.query(
        `INSERT INTO workspace_runtime_messages(
           workspace_id, id, session_id, role, content, input_locale, output_locale, envelope, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::JSONB, $9)`,
        [this.workspaceId, userMessage.id, userMessage.session_id, userMessage.role, userMessage.content, userMessage.input_locale, userMessage.output_locale, jsonText(userMessage.envelope), now]
      );
      const insertedRun = await sql.query<RuntimeRunRow>(
        `INSERT INTO workspace_runtime_runs(
           workspace_id, id, session_id, room_id, principal, source, session_ref, agent_id,
           requested_by_participant_id, input_message_id, backend_id, backend_kind, status, phase,
           current_attempt, request_idempotency_key, request_hash, started_at, input_summary, metadata
         ) VALUES ($1, $2, $3, $4, $5::JSONB, $6::JSONB, $7::JSONB, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20::JSONB)
         ON CONFLICT (workspace_id, session_id, request_idempotency_key) WHERE request_idempotency_key IS NOT NULL DO NOTHING
         RETURNING *`,
        [this.workspaceId, run.id, run.session_id, run.room_id, jsonText(run.principal), jsonText(run.source), jsonText(run.session_ref), run.agent_id ?? null, this.accountId, userMessage.id, run.backend_id, run.backend_kind, run.status, run.phase, run.current_attempt, run.request_idempotency_key, run.request_hash, run.started_at, run.input_summary, jsonText(run.metadata)]
      );
      if (!insertedRun.rows[0]) {
        await sql.query("DELETE FROM workspace_runtime_messages WHERE workspace_id = $1 AND id = $2", [this.workspaceId, userMessage.id]);
        const raced = await sql.query<RuntimeRunRow>(
          `SELECT * FROM workspace_runtime_runs
           WHERE workspace_id = $1 AND session_id = $2 AND request_idempotency_key = $3`,
          [this.workspaceId, input.session.id, input.idempotencyKey]
        );
        if (!raced.rows[0]) throw new WorkspaceServerError("runtime_idempotency_race_unresolved", 500);
        return replayAdmission(sql, runFromRow(raced.rows[0]));
      }
      await sql.query(
        `INSERT INTO workspace_runtime_reservations(workspace_id, session_id, run_id, version, status, created_at, updated_at)
         VALUES ($1, $2, $3, 1, 'held', $4, $4)`,
        [this.workspaceId, input.session.id, run.id, now]
      );
      await sql.query(
        `INSERT INTO workspace_runtime_operations(
           workspace_id, id, session_id, room_id, operation, status, payload, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7::JSONB, $8, $8)`,
        [this.workspaceId, operation.id, operation.session_id ?? null, operation.room_id ?? null, operation.operation, operation.status, jsonText(operation), operation.created_at]
      );
      await sql.query(
        `INSERT INTO workspace_runtime_activities(workspace_id, id, room_id, status, idempotency_key, backend_run_id, record, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::JSONB, $8, $8)`,
        [this.workspaceId, activity.id, activity.room_id, activity.status, activity.idempotency_key, run.id, jsonText(activity), now]
      );
      return { session: input.session, ...(input.agent ? { agent: input.agent } : {}), userMessage, run, operation, activity, replay: false };
    });
  }

  private async executeBackendStream(input: {
    admission: RuntimeAdmission;
    stream: AsyncIterable<BackendOutputEvent>;
    unknownOnError?: boolean;
  }): Promise<BackendRunRecord> {
    const { admission } = input;
    const eventBridge = new BackendEventBridge({
      runId: admission.run.id,
      sessionId: admission.session.id,
      attemptNo: admission.run.current_attempt ?? 1,
      startSequence: await this.nextEventSequence(admission.run.id)
    });
    let terminal: BackendEventRecord | undefined;
    let output = "";
    try {
      for await (const backendEvent of input.stream) {
        const projection = eventBridge.project(backendEvent);
        if (projection.terminal) {
          terminal = projection.record;
          if (projection.terminal === "completed") output = this.collectText(output, projection.record);
          continue;
        }
        output = this.collectText(output, projection.record);
        const saved = await this.appendEvent(projection.record);
        if (saved) await this.notifyEvent(saved, admission.session.room_id!);
      }
    } catch (error) {
      terminal = this.failureEvent(
        admission.run,
        error,
        eventBridge,
        input.unknownOnError === true
          ? { kind: "indeterminate", reason: "transport_lost", providerStarted: true, mayHaveSideEffects: true }
          : undefined
      );
    }
    if (!terminal) {
      terminal = this.failureEvent(
        admission.run,
        new Error("backend_terminal_event_missing"),
        eventBridge,
        input.unknownOnError === true
          ? { kind: "indeterminate", reason: "runtime_state_unavailable", providerStarted: true, mayHaveSideEffects: true }
          : undefined
      );
    }
    const settled = await this.commitTerminal({ admission, terminal, output });
    if (settled.status === statusForTerminalEvent(terminal)) {
      await this.notifyEvent(terminal, admission.session.room_id!);
    }
    return settled;
  }

  private async ensureRuntimeOperation(
    sql: WorkspaceSql,
    input: {
      session: SessionRecord;
      run: BackendRunRecord;
      envelope: MessageEnvelope;
      requestHash: string;
      inputMessageId: string;
      now: string;
    }
  ): Promise<OperationRecord> {
    const operationId = runtimeOperationId(input.run.id);
    const existing = await sql.query<RuntimeOperationRow>(
      `SELECT workspace_id, id, session_id, room_id, operation, status, payload, created_at, updated_at
       FROM workspace_runtime_operations WHERE workspace_id = $1 AND id = $2`,
      [this.workspaceId, operationId]
    );
    if (existing.rows[0]) return operationFromRow(existing.rows[0]);
    const operation = buildRuntimeOperation({
      session: input.session,
      run: input.run,
      envelope: input.envelope,
      requestHash: input.requestHash,
      inputMessageId: input.inputMessageId,
      now: input.now
    });
    await sql.query(
      `INSERT INTO workspace_runtime_operations(
         workspace_id, id, session_id, room_id, operation, status, payload, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::JSONB, $8, $8)
       ON CONFLICT (workspace_id, id) DO NOTHING`,
      [this.workspaceId, operation.id, operation.session_id ?? null, operation.room_id ?? null, operation.operation, operation.status, jsonText(operation), operation.created_at]
    );
    const saved = await sql.query<RuntimeOperationRow>(
      `SELECT workspace_id, id, session_id, room_id, operation, status, payload, created_at, updated_at
       FROM workspace_runtime_operations WHERE workspace_id = $1 AND id = $2`,
      [this.workspaceId, operationId]
    );
    if (!saved.rows[0]) throw new WorkspaceServerError("runtime_operation_persistence_failed", 500);
    return operationFromRow(saved.rows[0]);
  }

  private async operationForRun(sql: WorkspaceSql, runId: string): Promise<OperationRecord | undefined> {
    const result = await sql.query<RuntimeOperationRow>(
      `SELECT workspace_id, id, session_id, room_id, operation, status, payload, created_at, updated_at
       FROM workspace_runtime_operations WHERE workspace_id = $1 AND id = $2`,
      [this.workspaceId, runtimeOperationId(runId)]
    );
    return result.rows[0] ? operationFromRow(result.rows[0]) : undefined;
  }

  private async updateRuntimeOperation(
    sql: WorkspaceSql,
    operation: OperationRecord,
    input: {
      status: OperationRecord["status"];
      resultRef?: z.infer<typeof ResourceRefSchema>;
      error?: string;
    }
  ): Promise<OperationRecord> {
    const updated = OperationRecordSchema.parse({
      ...operation,
      status: input.status,
      ...(input.resultRef ? { result_ref: input.resultRef } : {}),
      ...(input.error ? { error: summarize(input.error, 2_000) } : {}),
      updated_at: nowIso()
    });
    const result = await sql.query<RuntimeOperationRow>(
      `UPDATE workspace_runtime_operations
       SET operation = $3, status = $4, payload = $5::JSONB, updated_at = $6
       WHERE workspace_id = $1 AND id = $2
       RETURNING workspace_id, id, session_id, room_id, operation, status, payload, created_at, updated_at`,
      [this.workspaceId, operation.id, updated.operation, updated.status, jsonText(updated), updated.updated_at]
    );
    if (!result.rows[0]) throw new WorkspaceServerError(`runtime_operation_not_found:${operation.id}`, 500);
    return operationFromRow(result.rows[0]);
  }

  private async appendRuntimeAudit(
    sql: WorkspaceSql,
    operation: OperationRecord,
    outcome: "completed" | "failed",
    outputSummary: string,
    affectedResources: Array<z.infer<typeof ResourceRefSchema>> = []
  ): Promise<void> {
    const action = `${operation.operation}.${outcome}`;
    const existing = await sql.query<{ id: string }>(
      `SELECT id FROM workspace_audit_entries
       WHERE workspace_id = $1 AND operation_id = $2 AND action = $3
       ORDER BY id LIMIT 1`,
      [this.workspaceId, operation.id, action]
    );
    if (existing.rows[0]) return;
    const audit = AuditRecordSchema.parse({
      id: `audit:${operation.id}:${outcome}`,
      actor_identity: operation.actor_identity,
      ...(operation.participant_id ? { participant_id: operation.participant_id } : {}),
      ...(operation.participant_kind ? { participant_kind: operation.participant_kind } : {}),
      ...(operation.requested_by_participant_id ? { requested_by_participant_id: operation.requested_by_participant_id } : {}),
      ...(operation.room_id ? { room_id: operation.room_id } : {}),
      ...(operation.principal ? { principal: operation.principal } : {}),
      ...(operation.source ? { source: operation.source } : {}),
      ...(operation.session_ref ? { session_ref: operation.session_ref } : {}),
      operation_id: operation.id,
      capability_id: operation.capability_id,
      instruction_source: operation.instruction_source,
      inputs_summary: `${operation.operation} input_hash=${operation.input_hash}`,
      outputs_summary: summarize(outputSummary, 2_000),
      affected_resources: affectedResources,
      room_access_scope: operation.room_id ? "room" : undefined,
      room_access_action: operation.room_id ? "execute" : undefined,
      room_access_allowed: operation.room_id ? true : undefined,
      room_access_reason: operation.room_id ? "runtime_room_execute_granted" : undefined,
      created_at: nowIso()
    });
    await sql.query(
      `SELECT samurai_append_workspace_audit(
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::JSONB
       )`,
      [
        this.workspaceId,
        operation.room_id ?? null,
        action,
        outcome,
        operation.id,
        "runtime_operation",
        operation.id,
        null,
        null,
        jsonText({ runtime_audit_record: audit })
      ]
    );
  }

  private async transitionToExternalRunning(run: BackendRunRecord): Promise<void> {
    await this.database.withContext(this.context(), async (sql) => {
      const starting = await sql.query<RuntimeRunRow>(
        `UPDATE workspace_runtime_runs SET status = 'running', phase = 'backend_starting'
         WHERE workspace_id = $1 AND id = $2 AND status = 'queued' AND phase = 'admitted'
         RETURNING *`,
        [this.workspaceId, run.id]
      );
      if (!starting.rows[0]) throw new WorkspaceServerError(`runtime_run_admission_cas_conflict:${run.id}`, 409);
      const external = await sql.query(
        `UPDATE workspace_runtime_runs SET phase = 'external_running'
         WHERE workspace_id = $1 AND id = $2 AND status = 'running' AND phase = 'backend_starting'`,
        [this.workspaceId, run.id]
      );
      if (Number(external.rowCount ?? 0) !== 1) throw new WorkspaceServerError(`runtime_run_start_cas_conflict:${run.id}`, 409);
    });
  }

  private async commitAdmissionFailure(input: {
    admission: RuntimeAdmission;
    terminal: BackendEventRecord;
    reason: string;
  }): Promise<BackendRunRecord> {
    BackendEventRecordSchema.parse(input.terminal);
    const now = nowIso();
    return this.database.withContext(this.context(), async (sql) => {
      const currentResult = await sql.query<RuntimeRunRow>(
        `SELECT * FROM workspace_runtime_runs WHERE workspace_id = $1 AND id = $2 FOR UPDATE`,
        [this.workspaceId, input.admission.run.id]
      );
      const current = currentResult.rows[0] ? runFromRow(currentResult.rows[0]) : undefined;
      if (!current) throw new WorkspaceServerError(`runtime_run_not_found:${input.admission.run.id}`, 500);
      if (isSettled(current)) return current;
      if (current.status !== "queued" || current.phase !== "admitted") {
        throw new WorkspaceServerError(`runtime_admission_failure_cas_conflict:${current.id}`, 409);
      }
      await sql.query(
        `INSERT INTO workspace_runtime_events(
           workspace_id, id, run_id, session_id, backend_session_id, event_type, sequence,
           attempt_no, source_event_id, source_sequence, payload, resource_refs, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::JSONB, $12::JSONB, $13)
         ON CONFLICT (workspace_id, id) DO NOTHING`,
        [this.workspaceId, input.terminal.id, input.terminal.run_id, input.terminal.session_id ?? null, input.terminal.backend_session_id ?? null, input.terminal.event_type, input.terminal.sequence, input.terminal.attempt_no ?? null, input.terminal.source_event_id ?? null, input.terminal.source_sequence ?? null, jsonText(input.terminal.payload), jsonText(input.terminal.resource_refs), input.terminal.created_at]
      );
      const updated = await sql.query<RuntimeRunRow>(
        `UPDATE workspace_runtime_runs
         SET status = 'failed', phase = 'settled', error_code = $3, completed_at = $4
         WHERE workspace_id = $1 AND id = $2 AND status = 'queued' AND phase = 'admitted'
         RETURNING *`,
        [this.workspaceId, current.id, "runtime_backend_not_ready", now]
      );
      if (!updated.rows[0]) throw new WorkspaceServerError(`runtime_admission_failure_cas_conflict:${current.id}`, 409);
      await sql.query(
        `UPDATE workspace_runtime_reservations
         SET status = 'released', version = version + 1, updated_at = $3
         WHERE workspace_id = $1 AND run_id = $2 AND status = 'held'`,
        [this.workspaceId, current.id, now]
      );
      const activity = await this.activityForRun(sql, current.id, current.room_id!);
      if (activity) {
        const finalActivity = ActivityRecordSchema.parse({
          ...activity,
          status: "failed",
          failure: {
            code: "runtime_backend_not_ready",
            summary: summarize(input.reason, 2_000)
          },
          updated_at: now,
          finalized_at: now,
          backend_run_id: current.id
        });
        await sql.query(
          `UPDATE workspace_runtime_activities SET status = $3, record = $4::JSONB, updated_at = $5
           WHERE workspace_id = $1 AND id = $2`,
          [this.workspaceId, activity.id, finalActivity.status, jsonText(finalActivity), now]
        );
      }
      const operation = await this.operationForRun(sql, current.id);
      if (operation) {
        const failedOperation = await this.updateRuntimeOperation(sql, operation, {
          status: "failed",
          error: input.terminal.payload.error_code && typeof input.terminal.payload.error_code === "string"
            ? input.terminal.payload.error_code
            : input.reason
        });
        await this.appendRuntimeAudit(sql, failedOperation, "failed", summarize(input.reason, 2_000));
      }
      return runFromRow(updated.rows[0]);
    });
  }

  private async appendEvent(event: BackendEventRecord): Promise<BackendEventRecord | undefined> {
    BackendEventRecordSchema.parse(event);
    return this.database.withContext(this.context(), async (sql) => {
      const runState = await sql.query<{ status: string; phase: string | null }>(
        "SELECT status, phase FROM workspace_runtime_runs WHERE workspace_id = $1 AND id = $2",
        [this.workspaceId, event.run_id]
      );
      const state = runState.rows[0];
      if (!state || isTerminalRunState(state.status, state.phase)) return undefined;
      const existing = await sql.query<RuntimeEventRow>(
        `SELECT * FROM workspace_runtime_events WHERE workspace_id = $1 AND id = $2`,
        [this.workspaceId, event.id]
      );
      if (existing.rows[0]) return eventFromRow(existing.rows[0]);
      await sql.query(
        `INSERT INTO workspace_runtime_events(
           workspace_id, id, run_id, session_id, backend_session_id, event_type, sequence,
           attempt_no, source_event_id, source_sequence, payload, resource_refs, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::JSONB, $12::JSONB, $13)
         ON CONFLICT (workspace_id, run_id, source_event_id) DO NOTHING`,
        [this.workspaceId, event.id, event.run_id, event.session_id ?? null, event.backend_session_id ?? null, event.event_type, event.sequence, event.attempt_no ?? null, event.source_event_id ?? null, event.source_sequence ?? null, jsonText(event.payload), jsonText(event.resource_refs), event.created_at]
      );
      const saved = await sql.query<RuntimeEventRow>(
        `SELECT * FROM workspace_runtime_events WHERE workspace_id = $1 AND id = $2`,
        [this.workspaceId, event.id]
      );
      if (!saved.rows[0]) throw new WorkspaceServerError("runtime_event_persistence_failed", 500);
      return eventFromRow(saved.rows[0]);
    });
  }

  private async commitTerminal(input: { admission: RuntimeAdmission; terminal: BackendEventRecord; output: string; requestedCancel?: boolean }): Promise<BackendRunRecord> {
    BackendEventRecordSchema.parse(input.terminal);
    const now = nowIso();
    const terminalEvidence = input.terminal.event_type === "run_failed" || input.terminal.event_type === "run_completed"
      ? BackendTerminalEvidenceSchema.safeParse(input.terminal.payload.terminal_evidence)
      : undefined;
    const finalStatus = input.terminal.event_type === "run_completed"
      ? "completed"
      : input.terminal.event_type === "backend_waiting_for_native_input"
        ? "waiting_for_backend_input"
          : terminalEvidence?.success && (terminalEvidence.data.kind === "cancelled" || (input.requestedCancel === true && terminalEvidence.data.kind === "not_started"))
            ? "cancelled"
          : terminalEvidence?.success && terminalEvidence.data.kind === "indeterminate"
            ? "outcome_unknown"
            : "failed";
    const finalPhase = finalStatus === "waiting_for_backend_input" ? "waiting" : "settled";
    const outputMessage = finalStatus === "completed" && input.output.trim()
      ? RuntimeMessageRecordSchema.parse({
          id: `message:${input.admission.run.id}:output`,
          session_id: input.admission.session.id,
          role: "agent",
          content: input.output,
          input_locale: input.admission.userMessage.input_locale,
          output_locale: input.admission.userMessage.output_locale,
          created_at: now
        })
      : undefined;
    return this.database.withContext(this.context(), async (sql) => {
      const currentResult = await sql.query<RuntimeRunRow>(
        `SELECT * FROM workspace_runtime_runs WHERE workspace_id = $1 AND id = $2 FOR UPDATE`,
        [this.workspaceId, input.admission.run.id]
      );
      const current = currentResult.rows[0] ? runFromRow(currentResult.rows[0]) : undefined;
      if (!current) throw new WorkspaceServerError(`runtime_run_not_found:${input.admission.run.id}`, 500);
      if (isSettled(current)) return current;
      const currentPhase = current.phase ?? "admitted";
      const activeStatuses: BackendRunRecord["status"][] = ["queued", "running", "waiting_for_backend_input"];
      if (!activeStatuses.includes(current.status) || currentPhase === "settled") {
        throw new WorkspaceServerError(`runtime_settlement_cas_conflict:${current.id}`, 409);
      }
      const maxSequence = await sql.query<{ max_sequence: number | string | null }>(
        `SELECT MAX(sequence) AS max_sequence FROM workspace_runtime_events WHERE workspace_id = $1 AND run_id = $2`,
        [this.workspaceId, current.id]
      );
      const terminal = { ...input.terminal, sequence: Math.max(input.terminal.sequence, Number(maxSequence.rows[0]?.max_sequence ?? 0) + 1) };
      if (outputMessage) {
        await sql.query(
          `INSERT INTO workspace_runtime_messages(
             workspace_id, id, session_id, role, content, input_locale, output_locale, envelope, created_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, $8)
           ON CONFLICT (workspace_id, id) DO NOTHING`,
          [this.workspaceId, outputMessage.id, outputMessage.session_id, outputMessage.role, outputMessage.content, outputMessage.input_locale, outputMessage.output_locale, outputMessage.created_at]
        );
      }
      await sql.query(
        `INSERT INTO workspace_runtime_events(
           workspace_id, id, run_id, session_id, backend_session_id, event_type, sequence,
           attempt_no, source_event_id, source_sequence, payload, resource_refs, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::JSONB, $12::JSONB, $13)
         ON CONFLICT (workspace_id, id) DO NOTHING`,
        [this.workspaceId, terminal.id, terminal.run_id, terminal.session_id ?? null, terminal.backend_session_id ?? null, terminal.event_type, terminal.sequence, terminal.attempt_no ?? null, terminal.source_event_id ?? null, terminal.source_sequence ?? null, jsonText(terminal.payload), jsonText(terminal.resource_refs), terminal.created_at]
      );
      const errorCode = terminal.event_type === "run_failed" && typeof terminal.payload.error_code === "string" ? terminal.payload.error_code : undefined;
      const outputSummary = outputMessage ? summarize(outputMessage.content, 2_000) : terminal.event_type === "run_completed" && typeof terminal.payload.output_summary === "string" ? terminal.payload.output_summary : undefined;
      const updated = await sql.query<RuntimeRunRow>(
        `UPDATE workspace_runtime_runs
         SET status = $3, phase = $4, output_message_id = $5, output_summary = $6,
             error_code = $7, completed_at = $8
         WHERE workspace_id = $1 AND id = $2 AND status = $9 AND phase = $10
         RETURNING *`,
        [this.workspaceId, current.id, finalStatus, finalPhase, outputMessage?.id ?? null, outputSummary ?? null, errorCode ?? null, finalStatus === "waiting_for_backend_input" ? null : now, current.status, currentPhase]
      );
      if (!updated.rows[0]) throw new WorkspaceServerError(`runtime_settlement_cas_conflict:${current.id}`, 409);
      await sql.query(
        `UPDATE workspace_runtime_reservations
         SET status = 'released', version = version + 1, updated_at = $3
         WHERE workspace_id = $1 AND run_id = $2 AND status = 'held'`,
        [this.workspaceId, current.id, now]
      );
      const activity = await this.activityForRun(sql, current.id, current.room_id!);
      if (activity) {
        const finalActivity = finalStatus === "waiting_for_backend_input"
          ? ActivityRecordSchema.parse({
              ...activity,
              status: "recording",
              result_summary: undefined,
              failure: undefined,
              finalized_at: undefined,
              updated_at: now,
              backend_run_id: current.id
            })
          : ActivityRecordSchema.parse({
              ...activity,
              status: finalStatus === "completed"
                ? "completed"
                : finalStatus === "cancelled"
                  ? "cancelled"
                  : finalStatus === "outcome_unknown"
                    ? "outcome_unknown"
                    : "failed",
              result_summary: finalStatus === "completed" ? summarize(outputSummary ?? "Backend run completed.", 2_000) : undefined,
              failure: finalStatus === "completed" ? undefined : { code: errorCode ?? `backend_${finalStatus}`, summary: summarize(outputSummary ?? "Backend run did not complete.", 2_000) },
              updated_at: now,
              finalized_at: now,
              backend_run_id: current.id
            });
        await sql.query(
          `UPDATE workspace_runtime_activities SET status = $3, record = $4::JSONB, updated_at = $5
           WHERE workspace_id = $1 AND id = $2`,
          [this.workspaceId, activity.id, finalActivity.status, jsonText(finalActivity), now]
        );
      }
      const operation = await this.operationForRun(sql, current.id);
      if (operation) {
        const operationStatus = finalStatus === "completed" ? "completed" : finalStatus === "waiting_for_backend_input" ? "deferred" : "failed";
        const settledOperation = await this.updateRuntimeOperation(sql, operation, {
          status: operationStatus,
          ...(outputMessage ? { resultRef: messageResourceRef(outputMessage.id) } : {}),
          ...(operationStatus === "failed" ? { error: errorCode ?? `backend_${finalStatus}` } : {})
        });
        if (operationStatus === "completed") {
          await this.appendRuntimeAudit(sql, settledOperation, "completed", outputSummary ?? "Backend run completed.", outputMessage ? [messageResourceRef(outputMessage.id)] : []);
        } else if (operationStatus === "failed") {
          await this.appendRuntimeAudit(sql, settledOperation, "failed", outputSummary ?? "Backend run did not complete.", outputMessage ? [messageResourceRef(outputMessage.id)] : []);
        }
      }
      return runFromRow(updated.rows[0]);
    });
  }

  private async resolveAgent(roomId: string, requestedAgentId?: string): Promise<RuntimeAgent | undefined> {
    return this.database.withContext(this.context(), async (sql) => {
      await this.assertRoomCanExecute(sql, roomId);
      const result = await sql.query<RuntimeAgentRow>(
        `SELECT agent.id, agent.display_name, agent.description, agent.backend_id, agent.status
         FROM workspace_agents agent
         JOIN workspace_agent_room_permissions permission
           ON permission.workspace_id = agent.workspace_id AND permission.agent_id = agent.id
         WHERE agent.workspace_id = $1 AND permission.room_id = $2
           AND permission.can_execute = TRUE
           AND agent.status = 'active'
           AND ($3::TEXT IS NULL OR agent.id = $3)
         ORDER BY agent.created_at, agent.id
         LIMIT 1`,
        [this.workspaceId, roomId, requestedAgentId ?? null]
      );
      const row = result.rows[0];
      if (requestedAgentId && !row) throw new WorkspaceServerError("runtime_agent_not_authorized_for_room", 403);
      if (!row) return undefined;
      return {
        id: row.id,
        name: row.display_name,
        role: "workspace_agent",
        instructions: row.description || "Follow the Room instructions and return a concise result.",
        backendId: row.backend_id
      };
    });
  }

  private async assertRoomCanExecute(sql: WorkspaceSql, roomId: string): Promise<void> {
    const result = await sql.query<{ allowed: boolean }>(
      "SELECT samurai_can_room($1, $2, 'execute') AS allowed",
      [this.workspaceId, roomId]
    );
    if (result.rows[0]?.allowed !== true) throw new WorkspaceServerError("runtime_room_execute_forbidden", 403);
  }

  private async relevantKnowledge(roomId: string, query: string): Promise<Array<PostgresRuntimeKnowledgePage & { rank?: number }>> {
    if (!this.knowledgeMemory) return [];
    const matches = await this.knowledgeMemory.search(this.context(), roomId, query, 8);
    if (matches.length > 0) return matches.slice(0, 8);
    // A Room with Knowledge but no lexical match still has useful, explicitly
    // Room-scoped context. The bounded list keeps ordinary chat from loading an
    // unbounded Workspace history or another Room's files.
    return (await this.knowledgeMemory.list(this.context(), roomId, false)).slice(0, 8);
  }

  private async listMessages(sessionId: string): Promise<MessageRecord[]> {
    return this.database.withContext(this.context(), async (sql) => {
      const result = await sql.query<RuntimeMessageRow>(
        `SELECT * FROM workspace_runtime_messages WHERE workspace_id = $1 AND session_id = $2 ORDER BY created_at, id`,
        [this.workspaceId, sessionId]
      );
      return result.rows.map(messageFromRow);
    });
  }

  private async listRuns(sessionId: string): Promise<BackendRunRecord[]> {
    return this.database.withContext(this.context(), async (sql) => {
      const result = await sql.query<RuntimeRunRow>(
        `SELECT * FROM workspace_runtime_runs
         WHERE workspace_id = $1 AND session_id = $2
         ORDER BY started_at, id`,
        [this.workspaceId, sessionId]
      );
      return result.rows.map(runFromRow);
    });
  }

  private async listEventsForSession(sessionId: string): Promise<BackendEventRecord[]> {
    return this.database.withContext(this.context(), async (sql) => {
      const result = await sql.query<RuntimeEventRow>(
        `SELECT * FROM workspace_runtime_events
         WHERE workspace_id = $1 AND session_id = $2
         ORDER BY created_at, sequence, id`,
        [this.workspaceId, sessionId]
      );
      return result.rows.map(eventFromRow);
    });
  }

  private async listArtifacts(roomId: string): Promise<ArtifactRecord[]> {
    return this.database.withContext(this.context(), async (sql) => {
      const result = await sql.query<{ payload: unknown }>(
        `SELECT payload FROM workspace_records
         WHERE workspace_id = $1 AND room_id = $2 AND record_type = 'artifact'
         ORDER BY updated_at DESC LIMIT 500`,
        [this.workspaceId, roomId]
      );
      return result.rows.map((row) => ArtifactRecordSchema.parse(jsonValue(row.payload)));
    });
  }

  private async listSessionWorkspaceChanges(sessionId: string): Promise<WorkspaceChangeRecord[]> {
    return this.database.withContext(this.context(), async (sql) => {
      const result = await sql.query<RuntimeChangeRow>(
        `SELECT change.id, change.run_id, change.session_id, change.room_id,
                change.activity_id, change.domain_operation_id, change.session_ref,
                change.resource_ref, change.change_type, change.summary,
                change.legacy_operation_id, change.correlation_id, change.created_at
         FROM workspace_runtime_changes change
         WHERE change.workspace_id = $1 AND change.session_id = $2
         ORDER BY change.created_at, change.id`,
        [this.workspaceId, sessionId]
      );
      return result.rows.map((row) => WorkspaceChangeRecordSchema.parse({
        id: row.id,
        ...(row.run_id ? { run_id: row.run_id } : {}),
        ...(row.session_id ? { session_id: row.session_id } : {}),
        ...(row.room_id ? { room_id: row.room_id } : {}),
        ...(row.activity_id ? { activity_id: row.activity_id } : {}),
        ...(row.domain_operation_id ? { domain_operation_id: row.domain_operation_id } : {}),
        ...(row.session_ref ? { session_ref: jsonValue(row.session_ref) } : {}),
        resource_ref: jsonValue(row.resource_ref),
        change_type: row.change_type,
        summary: row.summary,
        ...(row.legacy_operation_id ? { legacy_operation_id: row.legacy_operation_id } : {}),
        ...(row.correlation_id ? { correlation_id: row.correlation_id } : {}),
        created_at: row.created_at
      }));
    });
  }

  private async listActivityInbox(sessionId: string): Promise<ActivityInboxItem[]> {
    return this.database.withContext(this.context(), async (sql) => {
      const result = await sql.query<RuntimeActivityRow>(
        `SELECT activity.*
         FROM workspace_runtime_activities activity
         JOIN workspace_runtime_runs run
           ON run.workspace_id = activity.workspace_id AND run.id = activity.backend_run_id
         WHERE activity.workspace_id = $1 AND run.session_id = $2
         ORDER BY activity.created_at, activity.id`,
        [this.workspaceId, sessionId]
      );
      return result.rows.map(activityInboxFromRow);
    });
  }

  private async listOperations(sessionId: string): Promise<OperationRecord[]> {
    return this.database.withContext(this.context(), async (sql) => {
      const result = await sql.query<RuntimeOperationRow>(
        `SELECT workspace_id, id, session_id, room_id, operation, status, payload, created_at, updated_at
         FROM workspace_runtime_operations
         WHERE workspace_id = $1 AND session_id = $2
         ORDER BY created_at, id`,
        [this.workspaceId, sessionId]
      );
      return result.rows.map(operationFromRow);
    });
  }

  private async listAuditRecords(sessionId: string): Promise<AuditRecord[]> {
    return this.database.withContext(this.context(), async (sql) => {
      const result = await sql.query<RuntimeAuditRecordRow>(
        `SELECT audit.details->'runtime_audit_record' AS record
         FROM workspace_audit_entries audit
         JOIN workspace_runtime_operations operation
           ON operation.workspace_id = audit.workspace_id AND operation.id = audit.operation_id
         WHERE audit.workspace_id = $1 AND operation.session_id = $2
           AND audit.details ? 'runtime_audit_record'
         ORDER BY audit.created_at, audit.id`,
        [this.workspaceId, sessionId]
      );
      return result.rows.map((row) => AuditRecordSchema.parse(jsonValue(row.record)));
    });
  }

  private async nextEventSequence(runId: string): Promise<number> {
    return this.database.withContext(this.context(), async (sql) => {
      const result = await sql.query<{ max_sequence: number | string | null }>(
        `SELECT MAX(sequence) AS max_sequence FROM workspace_runtime_events WHERE workspace_id = $1 AND run_id = $2`,
        [this.workspaceId, runId]
      );
      return Number(result.rows[0]?.max_sequence ?? 0) + 1;
    });
  }

  private async activityForRun(sql: WorkspaceSql, runId: string, roomId: string): Promise<ActivityRecord | undefined> {
    const result = await sql.query<RuntimeActivityRow>(
      `SELECT * FROM workspace_runtime_activities WHERE workspace_id = $1 AND backend_run_id = $2 AND room_id = $3 ORDER BY created_at DESC LIMIT 1`,
      [this.workspaceId, runId, roomId]
    );
    const row = result.rows[0];
    return row ? ActivityRecordSchema.parse(jsonValue(row.record)) : undefined;
  }

  private async project(run: BackendRunRecord): Promise<RunChatTurnResult> {
    const session = run.session_id ? await this.getSession(run.session_id) : undefined;
    if (!session) throw new WorkspaceServerError(`runtime_session_not_found:${run.session_id ?? ""}`, 404);
    const [messages, backendEvents, workspaceChanges, artifacts, operations, auditRecords] = await Promise.all([
      this.listMessages(session.id),
      this.database.withContext(this.context(), async (sql) => {
        const result = await sql.query<RuntimeEventRow>(
          `SELECT * FROM workspace_runtime_events WHERE workspace_id = $1 AND run_id = $2 ORDER BY sequence`,
          [this.workspaceId, run.id]
        );
        return result.rows.map(eventFromRow);
      }),
      this.listSessionWorkspaceChanges(session.id),
      session.room_id ? this.listArtifacts(session.room_id) : Promise.resolve([] as ArtifactRecord[]),
      this.listOperations(session.id),
      this.listAuditRecords(session.id)
    ]);
    const knowledge = session.room_id
      ? await this.relevantKnowledge(session.room_id, messages.find((message) => message.id === run.input_message_id)?.content ?? run.input_summary)
      : [];
    const activity = await this.listActivityInbox(session.id);
    const selected = messages.filter((message) => message.id === run.input_message_id || message.id === run.output_message_id);
    return {
      session,
      messages: selected,
      messagePresentations: [],
      backendRun: run,
      backendEvents,
      workspaceChanges,
      operations,
      policyDecisions: [],
      artifacts,
      memories: knowledge.map((page) => page.memory),
      approvalRequests: [],
      auditRecords,
      rollbackPoints: [],
      activity,
      reflectionRuns: [],
      reflectionSuggestions: [],
      toolRuns: []
    };
  }

  private failureEvent(
    run: BackendRunRecord,
    error: unknown,
    bridge: BackendEventBridge,
    terminalEvidence: BackendTerminalEvidence = {
      kind: "failed",
      source: "owned_loop_return",
      error: {
        code: "runtime_backend_failure",
        message: "Backend execution failed.",
        retryable: false,
        causeCategory: "runtime"
      }
    }
  ): BackendEventRecord {
    const message = error instanceof Error ? error.message : String(error);
    const event = bridge.project({
      event_type: terminalEvidence.kind === "completed" ? "run_completed" : "run_failed",
      payload: {
        error_code: "runtime_backend_failure",
        message: summarize(message, 240),
        reason: "runtime",
        retryable: false,
        cause_category: "runtime"
      },
      terminal_evidence: terminalEvidence.kind === "failed"
        ? { ...terminalEvidence, error: { ...terminalEvidence.error, message: summarize(terminalEvidence.error.message, 240) } }
        : terminalEvidence
    });
    return event.record;
  }

  private collectText(existing: string, event: BackendEventRecord): string {
    return event.event_type === "text_delta" && typeof event.payload.text === "string" ? `${existing}${event.payload.text}` : existing;
  }

  private async notifyEvent(event: BackendEventRecord, roomId: string): Promise<void> {
    try {
      await this.onEvent?.(event, roomId);
    } catch {
      // A client notification is derived observability. Its failure must not
      // turn an already persisted Runtime event into a false failed Chat turn.
    }
  }

  private async notifyCompletionActivity(result: RunChatTurnResult, instructionSummary: string): Promise<void> {
    if (!this.onCompletionActivity) return;
    const operation = result.operations.find((candidate) => candidate.run_id === result.backendRun.id);
    await this.onCompletionActivity({
      session: result.session,
      run: result.backendRun,
      ...(operation ? { operation } : {}),
      instructionSummary,
      ...(result.backendRun.output_summary ? { resultSummary: result.backendRun.output_summary } : {})
    });
  }

  private context() {
    return { accountId: this.accountId, workspaceId: this.workspaceId };
  }
}

/**
 * HTTP/IPCが呼び出す正式なRuntime Domain Operation facade。
 * QueryとCommandの実装は同じRoom限定Chat能力を共有するが、入口側は
 * この名前付き境界だけを受け取り、永続化トランザクションを直接扱わない。
 */
export class PostgresRuntimeCommandService {
  private readonly chat: PostgresRuntimeChat;

  constructor(options: PostgresRuntimeChatOptions) {
    this.chat = new PostgresRuntimeChat(options);
  }

  /**
   * Execute the PostgreSQL-backed operations that this Runtime facade owns.
   * Transport adapters select the shared contract here; they do not call a
   * mutable Runtime method directly. The operation handler remains the
   * authoritative input and trusted-context boundary for every caller.
   */
  async runDomainCommand(input: PostgresRuntimeDomainCommandInput): Promise<unknown> {
    if (input.operationId === "chat.turn.run") {
      const handler = chatTurnRun.createHandler({
        runChatTurn: async (context, commandInput) => this.chat.runChatTurn({
          sessionId: context.sessionId!,
          content: commandInput.content,
          idempotencyKey: context.idempotencyKey!,
          ...(commandInput.agent_id ? { agentId: commandInput.agent_id } : {}),
          ...(commandInput.backend_id ? { backendId: commandInput.backend_id } : {}),
          ...(commandInput.input_locale ? { inputLocale: commandInput.input_locale } : {}),
          ...(commandInput.output_locale ? { outputLocale: commandInput.output_locale } : {}),
          attachments: commandInput.attachments,
          temporaryContext: commandInput.temporary_context,
          metadata: commandInput.metadata
        })
      });
      const result = await handler.execute(input.context, chatTurnRun.input.parse(input.input));
      return result.value;
    }

    const handler = sessionCreate.createHandler({
      createSession: async (context, commandInput) => {
        if (!commandInput.roomId) throw new WorkspaceServerError("room_id_required", 400);
        return this.chat.createSession({
          operationId: context.idempotencyKey!,
          roomId: commandInput.roomId,
          ...commandInput
        });
      }
    });
    const result = await handler.execute(input.context, sessionCreate.input.parse(input.input));
    return result.value;
  }

  createSession(input: PostgresRuntimeSessionInput): Promise<SessionRecord> {
    return this.chat.createSession(input);
  }

  listSessions(): Promise<SessionRecord[]> {
    return this.chat.listSessions();
  }

  getSession(sessionId: string) {
    return this.chat.getSession(sessionId);
  }

  getSessionDetail(sessionId: string) {
    return this.chat.getSessionDetail(sessionId);
  }

  listAgentBackends() {
    return this.chat.listAgentBackends();
  }

  listBackendRuns(sessionId?: string) {
    return this.chat.listBackendRuns(sessionId);
  }

  getBackendRun(runId: string) {
    return this.chat.getBackendRun(runId);
  }

  listBackendEvents(runId: string) {
    return this.chat.listBackendEvents(runId);
  }

  cancelBackendRun(runId: string) {
    return this.chat.cancelBackendRun(runId);
  }

  resumeBackendRun(runId: string, input: Record<string, JsonValue>) {
    return this.chat.resumeBackendRun(runId, input);
  }

  syncBackendRun(runId: string) {
    return this.chat.syncBackendRun(runId);
  }

  recoverBackendRun(runId: string) {
    return this.chat.recoverBackendRun(runId);
  }

  retryBackendRun(runId: string, input: { idempotencyKey: string; confirmUnknown?: boolean }) {
    return this.chat.retryBackendRun(runId, input);
  }

  listWorkspaceChanges(sessionId?: string) {
    return this.chat.listWorkspaceChanges(sessionId);
  }

  listActivity(roomId: string) {
    return this.chat.listActivity(roomId);
  }

  search(roomId: string, query: string) {
    return this.chat.search(roomId, query);
  }

  runChatTurn(input: PostgresRuntimeChatTurnInput): Promise<RunChatTurnResult> {
    return this.chat.runChatTurn(input);
  }
}

interface RuntimeEventRow {
  workspace_id: string;
  id: string;
  run_id: string;
  session_id: string | null;
  backend_session_id: string | null;
  event_type: string;
  sequence: number | string;
  attempt_no: number | string | null;
  source_event_id: string | null;
  source_sequence: number | string | null;
  payload: unknown;
  resource_refs: unknown;
  created_at: string;
}

function runtimeOperationId(runId: string): string {
  return `operation:${runId}`;
}

function buildRuntimeOperation(input: {
  session: SessionRecord;
  run: BackendRunRecord;
  envelope: MessageEnvelope;
  requestHash: string;
  inputMessageId: string;
  now: string;
}): OperationRecord {
  const principal = input.run.principal;
  const operationStatus = operationStatusForRun(input.run);
  return OperationRecordSchema.parse({
    id: runtimeOperationId(input.run.id),
    session_id: input.session.id,
    run_id: input.run.id,
    capability_id: "runtime.chat",
    operation: "runtime.chat",
    actor_identity: input.envelope.actor_identity,
    ...(principalParticipantId(principal) ? { participant_id: principalParticipantId(principal) } : {}),
    ...(principal ? { participant_kind: principal.kind } : {}),
    ...(input.run.requested_by_participant_id ? { requested_by_participant_id: input.run.requested_by_participant_id } : {}),
    room_id: input.session.room_id,
    ...(principal ? { principal } : {}),
    ...(input.run.source ? { source: input.run.source } : {}),
    ...(input.run.session_ref ? { session_ref: input.run.session_ref } : {}),
    instruction_source: instructionSourceFor(input.run.source, principal),
    instruction_authority: "room_execute",
    channel: input.envelope.source,
    input_hash: input.run.request_hash ?? input.requestHash,
    input_ref: messageResourceRef(input.inputMessageId),
    target_resource_refs: [],
    proposed_effects: ["runtime.chat"],
    status: operationStatus,
    ...(input.run.output_message_id ? { result_ref: messageResourceRef(input.run.output_message_id) } : {}),
    ...(input.run.error_code ? { error: input.run.error_code } : {}),
    correlation_id: input.run.id,
    created_at: input.now,
    updated_at: input.now
  });
}

function operationStatusForRun(run: BackendRunRecord): OperationRecord["status"] {
  if (run.status === "completed") return "completed";
  if (run.status === "waiting_for_backend_input") return "deferred";
  if (run.status === "failed" || run.status === "cancelled" || run.status === "outcome_unknown") return "failed";
  return "created";
}

function instructionSourceFor(
  source: BackendRunRecord["source"],
  principal: BackendRunRecord["principal"]
): OperationRecord["instruction_source"] {
  if (source?.kind === "external_app") return "paired_identity_message";
  if (source?.kind === "host") return "scheduled_context";
  if (source?.kind === "system" || principal?.kind === "system") return "system_policy";
  return "owner_instruction";
}

function principalParticipantId(principal: BackendRunRecord["principal"]): string | undefined {
  if (!principal) return undefined;
  if (principal.kind === "human") return principal.participant_id;
  if (principal.kind === "agent") return principal.agent_id;
  if (principal.kind === "external_app") return principal.app_id;
  return undefined;
}

function messageResourceRef(messageId: string): z.infer<typeof ResourceRefSchema> {
  return ResourceRefSchema.parse({ kind: "message", id: messageId, uri: `runtime://messages/${messageId}` });
}

function sessionFromRow(row: RuntimeSessionRow): SessionRecord {
  return RuntimeSessionRecordSchema.parse({
    id: row.id,
    session_key: row.session_key,
    ...(row.room_id ? { room_id: row.room_id } : {}),
    title: row.title,
    ui_locale: row.ui_locale,
    output_locale: row.output_locale,
    created_at: row.created_at,
    updated_at: row.updated_at
  });
}

function operationFromRow(row: RuntimeOperationRow): OperationRecord {
  const operation = OperationRecordSchema.parse(jsonValue(row.payload));
  if (operation.id !== row.id || operation.operation !== row.operation || operation.status !== row.status) {
    throw new WorkspaceServerError(`runtime_operation_projection_mismatch:${row.id}`, 500);
  }
  return operation;
}

function messageFromRow(row: RuntimeMessageRow): MessageRecord {
  return RuntimeMessageRecordSchema.parse({
    id: row.id,
    session_id: row.session_id,
    role: row.role,
    content: row.content,
    input_locale: row.input_locale,
    output_locale: row.output_locale,
    ...(row.envelope ? { envelope: jsonValue(row.envelope) } : {}),
    created_at: row.created_at
  });
}

function runFromRow(row: RuntimeRunRow): BackendRunRecord {
  return BackendRunRecordSchema.parse({
    id: row.id,
    ...(row.session_id ? { session_id: row.session_id } : {}),
    ...(row.room_id ? { room_id: row.room_id } : {}),
    ...(row.principal ? { principal: jsonValue(row.principal) } : {}),
    ...(row.source ? { source: jsonValue(row.source) } : {}),
    ...(row.session_ref ? { session_ref: jsonValue(row.session_ref) } : {}),
    ...(row.agent_id ? { agent_id: row.agent_id } : {}),
    ...(row.requested_by_participant_id ? { requested_by_participant_id: row.requested_by_participant_id } : {}),
    ...(row.input_message_id ? { input_message_id: row.input_message_id } : {}),
    ...(row.output_message_id ? { output_message_id: row.output_message_id } : {}),
    backend_id: row.backend_id,
    backend_kind: row.backend_kind,
    ...(row.backend_session_id ? { backend_session_id: row.backend_session_id } : {}),
    status: row.status,
    ...(row.phase ? { phase: row.phase } : {}),
    ...(row.current_attempt !== null ? { current_attempt: Number(row.current_attempt) } : {}),
    ...(row.request_idempotency_key ? { request_idempotency_key: row.request_idempotency_key } : {}),
    ...(row.request_hash ? { request_hash: row.request_hash } : {}),
    started_at: row.started_at,
    ...(row.completed_at ? { completed_at: row.completed_at } : {}),
    input_summary: row.input_summary,
    ...(row.output_summary ? { output_summary: row.output_summary } : {}),
    ...(row.error_code ? { error_code: row.error_code } : {}),
    metadata: jsonRecord(row.metadata)
  });
}

function eventFromRow(row: RuntimeEventRow): BackendEventRecord {
  return BackendEventRecordSchema.parse({
    id: row.id,
    run_id: row.run_id,
    ...(row.session_id ? { session_id: row.session_id } : {}),
    ...(row.backend_session_id ? { backend_session_id: row.backend_session_id } : {}),
    event_type: row.event_type,
    sequence: Number(row.sequence),
    ...(row.attempt_no !== null ? { attempt_no: Number(row.attempt_no) } : {}),
    ...(row.source_event_id ? { source_event_id: row.source_event_id } : {}),
    ...(row.source_sequence !== null ? { source_sequence: Number(row.source_sequence) } : {}),
    payload: jsonRecord(row.payload),
    resource_refs: jsonArray(row.resource_refs),
    created_at: row.created_at
  });
}

function activityInboxFromRow(row: RuntimeActivityRow): ActivityInboxItem {
  const record = ActivityRecordSchema.parse(jsonValue(row.record));
  return ActivityInboxItemSchema.parse({
    id: record.id,
    activity_type: record.status === "failed" ? "failure" : "auto_run",
    severity: record.status === "failed" ? "critical" : record.status === "recording" ? "notice" : "info",
    title: record.instruction_summary,
    summary: record.failure?.summary ?? record.result_summary ?? record.instruction_summary,
    operation_id: record.idempotency_key,
    created_at: record.created_at
  });
}

function isSettled(run: BackendRunRecord): boolean {
  return run.phase === "settled" || run.status === "completed" || run.status === "failed" || run.status === "cancelled" || run.status === "outcome_unknown";
}

function isTerminalRunState(status: string, phase: string | null): boolean {
  return phase === "settled" || status === "completed" || status === "failed" || status === "cancelled" || status === "outcome_unknown";
}

function isPreExternalPhase(phase: string | undefined): boolean {
  return phase === undefined || phase === "admitted" || phase === "preparing" || phase === "backend_starting";
}

function statusForTerminalEvent(event: BackendEventRecord, requestedCancel = false): BackendRunRecord["status"] {
  if (event.event_type === "run_completed") return "completed";
  if (event.event_type === "backend_waiting_for_native_input") return "waiting_for_backend_input";
  const evidence = BackendTerminalEvidenceSchema.safeParse(event.payload.terminal_evidence);
  if (!evidence.success) return "failed";
  if (evidence.data.kind === "cancelled") return "cancelled";
  if (evidence.data.kind === "indeterminate") return "outcome_unknown";
  if (evidence.data.kind === "not_started" && requestedCancel) return "cancelled";
  return "failed";
}

function validateResumeInput(input: Record<string, JsonValue>): Record<string, JsonValue> {
  for (const [key, value] of Object.entries(input)) {
    if (!key.trim() || !isJsonValue(value)) throw new WorkspaceServerError("runtime_resume_input_invalid", 400);
  }
  return { ...input };
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value !== "object") return false;
  return Object.entries(value).every(([key, child]) => key.length > 0 && isJsonValue(child));
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("runtime_control_timeout")), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

async function nextSequence(sql: WorkspaceSql, workspaceId: string, runId: string): Promise<number> {
  const result = await sql.query<{ max_sequence: number | string | null }>(
    "SELECT MAX(sequence) AS max_sequence FROM workspace_runtime_events WHERE workspace_id = $1 AND run_id = $2",
    [workspaceId, runId]
  );
  return Number(result.rows[0]?.max_sequence ?? 0) + 1;
}

async function insertRuntimeEvent(sql: WorkspaceSql, workspaceId: string, event: BackendEventRecord): Promise<void> {
  await sql.query(
    `INSERT INTO workspace_runtime_events(
       workspace_id, id, run_id, session_id, backend_session_id, event_type, sequence,
       attempt_no, source_event_id, source_sequence, payload, resource_refs, created_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::JSONB, $12::JSONB, $13)
     ON CONFLICT (workspace_id, id) DO NOTHING`,
    [workspaceId, event.id, event.run_id, event.session_id ?? null, event.backend_session_id ?? null, event.event_type, event.sequence, event.attempt_no ?? null, event.source_event_id ?? null, event.source_sequence ?? null, jsonText(event.payload), jsonText(event.resource_refs), event.created_at]
  );
}

function jsonText(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function jsonValue(value: unknown): JsonValue {
  if (typeof value !== "string") return value as JsonValue;
  try { return JSON.parse(value) as JsonValue; } catch { throw new WorkspaceServerError("runtime_json_value_invalid", 500); }
}

function jsonRecord(value: unknown): Record<string, JsonValue> {
  const parsed = jsonValue(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new WorkspaceServerError("runtime_json_record_invalid", 500);
  return parsed as Record<string, JsonValue>;
}

function jsonArray(value: unknown): JsonValue[] {
  const parsed = jsonValue(value);
  if (!Array.isArray(parsed)) throw new WorkspaceServerError("runtime_json_array_invalid", 500);
  return parsed;
}

function requireId(value: string | undefined, code: string): string {
  if (!value?.trim()) throw new WorkspaceServerError(code, 400);
  return value.trim();
}

function summarize(value: string, maxLength = 160): string {
  return value.trim().replace(/\s+/g, " ").slice(0, maxLength) || "Chat turn";
}

function memoryCandidate(page: PostgresRuntimeKnowledgePage & { rank?: number }): MemoryCandidateLike {
  const memory = page.memory;
  const state = memory.state === "sensitive" ? "sensitive" : memory.state === "topic" ? "topic" : "active";
  const priority = memory.sensitive_level !== "none"
    ? "sensitive"
    : memory.conflicts_with.length > 0
      ? "conflict"
      : "primary";
  return {
    id: memory.id,
    topic: memory.topic,
    content: page.content,
    state,
    sensitive_level: memory.sensitive_level,
    priority,
    ...(memory.conflicts_with.length > 0 ? { conflicts_with: memory.conflicts_with } : {}),
    selection_reason: page.rank === undefined ? "room_knowledge_room_list" : `room_knowledge_search_rank:${page.rank}`
  };
}

function temporaryContextHash(input: TemporaryContextAttachment): Record<string, JsonValue> {
  return {
    id: input.id,
    kind: input.kind,
    mime_type: input.mime_type,
    created_at: input.created_at,
    expires_at: input.expires_at,
    data_url_hash: stableHash(input.data_url ?? ""),
    ...(input.file_path ? { file_path: input.file_path } : {})
  };
}
