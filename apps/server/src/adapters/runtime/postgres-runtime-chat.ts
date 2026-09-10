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
  WorkspaceFileResourceRefSchema,
  ToolRunRecordSchema,
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
  type ToolRunRecord,
  type ResourceRef,
  OperationRecordSchema,
  PrincipalSchema,
  TrustedWorkspaceSourceSchema,
  type WorkspaceChangeRecord,
  WorkspaceChangeRecordSchema,
  type SupportedLocale
} from "@samurai-agent/core-schemas";
import type { AgentBackend, AgentBackendRegistry, BackendExecutionContext, BackendOutputEvent, BackendRunInput, BackendTerminalEvidence, MemoryCandidateLike, TemporaryContextAttachment } from "@samurai-agent/agent-backends";
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
  /**
   * The Host-owned execution port for provider tool calls.  Runtime keeps the
   * event/operation/evidence ledger here; the port performs only the
   * canonical Workspace mutation (for example, PostgresArtifact.create).
   */
  toolExecution?: PostgresRuntimeToolExecutionPort;
  /** Capability advertisement for the provider.  It is not an authorization
   * decision; tool execution re-checks the Room boundary before mutation. */
  availableTools?: readonly string[];
  /** Reads a Room-authorized Workspace File through the formal file Port. */
  readWorkspaceFile?: (
    context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">,
    roomId: string,
    ref: ResourceRef
  ) => Promise<{ path: string; version: number; sha256: string; content: Buffer }>;
}

export interface PostgresRuntimeToolCallEvent {
  tool_call_id: string;
  provider_tool_name?: string;
  action_id?: string;
  arguments: Record<string, JsonValue>;
  payload: Record<string, JsonValue>;
}

export interface PostgresRuntimeToolExecutionInput {
  run: BackendRunRecord;
  runInput: BackendRunInput;
  event: PostgresRuntimeToolCallEvent;
  operation: OperationRecord;
}

export interface PostgresRuntimeToolExecutionResult {
  resourceRefs: ResourceRef[];
  summary: string;
  output?: JsonValue;
  /** Optional Workspace change classification for non-artifact tools. */
  changeType?: import("@samurai-agent/core-schemas").WorkspaceChangeType;
}

/** Server-owned Room-work association used by the delegation tool.  The
 * provider payload is intentionally not part of this value: Work, parent
 * assignment, requester, and generation come from the admitted Run. */
export interface PostgresRuntimeTrustedRoomWorkBinding {
  /** The admitted Run is the only parent execution authority. */
  runId: string;
  workspaceId: string;
  roomId: string;
  workId: string;
  assigneeId: string;
  /** Explicit alias: this assignee is the parent of the child assignment. */
  parentAssignmentId: string;
  agentId: string;
  generation: number;
  requestedByParticipantId: string;
}

export interface PostgresRuntimeToolExecutionPort {
  execute(input: PostgresRuntimeToolExecutionInput): Promise<PostgresRuntimeToolExecutionResult>;
  /** Optional bounded Room-work delegation path.  Implementations must call
   * the public Domain Operation with `trustedRoomWorkBinding` and ignore any
   * model-supplied work/actor/parent identifiers. */
  delegate?(input: PostgresRuntimeToolExecutionInput & {
    trustedRoomWorkBinding: PostgresRuntimeTrustedRoomWorkBinding;
  }): Promise<PostgresRuntimeToolExecutionResult>;
}

export interface PostgresRuntimeChatCompletionEvent {
  session: SessionRecord;
  run: BackendRunRecord;
  operation?: OperationRecord;
  instructionSummary: string;
  resultSummary?: string;
  resourceRefs?: ResourceRef[];
}

/** The only mutable Runtime entry used by the public Run Control service. */
export type PostgresRuntimeRunControlAction = "cancel" | "resume" | "sync" | "recover" | "retry";
export type PostgresRuntimeRunControlResult = BackendRunRecord | RunChatTurnResult;

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
  /** A public Room Work target resolved from the server-side runtime binding. */
  work_id?: string;
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
  /**
   * Server-owned identity for a normal Room work assignment.  This is an
   * internal execution binding; public Room work operations do not accept a
   * Session or a provider session identifier.
   */
  executionBinding?: PostgresRuntimeExecutionBinding;
  /**
   * Legacy server-owned provider SessionRef.  It is retained for non-Room
   * callers only; Room-work continuations must use the bound structure below.
   */
  resumeBackendSessionId?: string;
  /**
   * Server-owned, fully bound external continuation candidate.  Room-work
   * callers can only resume when every parent association still matches the
   * newly admitted execution.  Public APIs never accept this value.
   */
  resumeBackendContinuation?: PostgresRuntimeExternalContinuation;
  /** Optional owner/lease cancellation for long-running worker executions. */
  signal?: AbortSignal;
}

export interface PostgresRuntimeExecutionBinding {
  workId?: string;
  assigneeId?: string;
  /** Parent Room-work assignment for a server-created continuation only. */
  parentAssigneeId?: string;
  generation?: number;
  agentConfigurationVersion?: number;
  /** Server-issued claim token used to fence a delayed pre-admission worker. */
  reservationId?: string;
  leaseOwner?: string;
}

/**
 * A provider-native session is never a sufficient authority to resume a
 * Room-work execution.  The Store constructs this from the terminal parent
 * Run, and the runtime checks every immutable association again just before
 * it invokes a Backend resume path.
 */
export interface PostgresRuntimeExternalContinuation {
  backendSessionId: string;
  parent: {
    workspaceId: string;
    roomId: string;
    sessionId: string;
    workId: string;
    assigneeId: string;
    agentId: string;
    agentConfigurationVersion?: number;
    backendId: string;
    generation: number;
  };
}

export type PostgresRuntimeDomainCommandInput =
  | {
      operationId: "chat.turn.run";
      context: TrustedDomainContext;
      input: unknown;
      /**
       * Server-owned execution state for the Room-work worker. These fields
       * are deliberately outside the public domain-operation payload: the
       * worker proves the assignment and continuation through the Store
       * before handing them to this facade.
       */
      executionBinding?: PostgresRuntimeExecutionBinding;
      resumeBackendContinuation?: PostgresRuntimeExternalContinuation;
      signal?: AbortSignal;
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
  configurationVersion: number;
  enabled: boolean;
}

interface RuntimeExecutionBinding {
  workspaceId: string;
  roomId: string;
  sessionId: string;
  workId?: string;
  assigneeId?: string;
  parentAssigneeId?: string;
  agentId: string;
  agentConfigurationVersion: number;
  backendId: string;
  generation: number;
  reservationId?: string;
  leaseOwner?: string;
  agent: {
    name: string;
    role: string;
    instructions: string;
    enabled: boolean;
  };
}

/**
 * The provider Session is an optional optimization for an external Backend.
 * The Room Work API can inspect this small, non-secret state on the persisted
 * Backend Run and distinguish a real provider resume from a new conversation
 * rebuilt from Samurai's durable history.
 */
type RuntimeContinuationReason =
  | "candidate_missing"
  | "candidate_invalid"
  | "candidate_mismatch"
  | "native_backend"
  | "resume_unsupported"
  | "resume_failed";

interface RuntimeContinuationState {
  mode: "resumed" | "reconstructed";
  source: "external_session" | "samurai_context";
  reason?: RuntimeContinuationReason;
}

interface RuntimeContinuationDecision {
  backendSessionId?: string;
  state: RuntimeContinuationState;
}

type RuntimeBackendExecutionContext = BackendExecutionContext & {
  continuity_state?: RuntimeContinuationState;
};

class ExternalContinuationResumeFailure extends Error {
  readonly causeValue: unknown;

  constructor(causeValue: unknown) {
    super("runtime_external_continuation_resume_failed");
    this.name = "ExternalContinuationResumeFailure";
    this.causeValue = causeValue;
  }
}

interface MaterializedWorkspaceAttachment {
  context: TemporaryContextAttachment;
  absolutePath: string;
}

type RoomWorkAttachmentRef = z.infer<typeof WorkspaceFileResourceRefSchema>;

interface PreflightWorkspaceFile {
  ref: RoomWorkAttachmentRef;
  file: {
    path: string;
    version: number;
    sha256: string;
    content: Buffer;
  };
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

interface RuntimeToolOutcome {
  status: "completed" | "ignored" | "failed";
  providerToolName?: string;
  actionId?: string;
  operationId?: string;
  resourceRefs?: ResourceRef[];
  summary: string;
  output?: JsonValue;
  changeType?: import("@samurai-agent/core-schemas").WorkspaceChangeType;
  reason?: string;
  errorCode?: string;
}

interface RuntimeToolOperationSpec {
  operation: string;
  capabilityId: string;
  proposedEffect: string;
}

interface RuntimeExecutableToolSpec extends RuntimeToolOperationSpec {
  providerToolNames: readonly string[];
  requiredResourceKinds: readonly string[];
  unavailableSummary: string;
  completedSummary: string;
  defaultChangeType: import("@samurai-agent/core-schemas").WorkspaceChangeType;
}

/**
 * The Provider receives only these explicit capabilities.  This independent
 * Runtime whitelist is intentional: a Domain contract alone is not execution
 * authority.  Each entry is implemented by the Host tool port and verified
 * again after execution before the Runtime settles its operation.
 */
const runtimeExecutableToolSpecs: readonly RuntimeExecutableToolSpec[] = [
  {
    operation: "artifact.create",
    capabilityId: "artifact.create",
    providerToolNames: ["create_artifact", "samurai.artifact.create", "mcp__samurai__artifact_create"],
    proposedEffect: "Create a local workspace artifact draft.",
    requiredResourceKinds: ["artifact"],
    unavailableSummary: "Artifact creation is unavailable because the Host tool port is not configured.",
    completedSummary: "Artifact creation was already completed for this tool call.",
    defaultChangeType: "artifact_created"
  },
  {
    operation: "artifact.revise",
    capabilityId: "artifact.revise",
    providerToolNames: ["revise_artifact", "artifact.revise", "samurai.artifact.revise", "mcp__samurai__artifact_revise"],
    proposedEffect: "Create an immutable Artifact revision and update its current pointer.",
    requiredResourceKinds: ["artifact", "artifact_revision"],
    unavailableSummary: "Artifact revision is unavailable because the Host tool port is not configured.",
    completedSummary: "Artifact revision was already completed for this tool call.",
    defaultChangeType: "artifact_created"
  },
  {
    operation: "generated_surface.create",
    capabilityId: "generated_surface.create",
    providerToolNames: ["create_generated_surface", "generated_surface.create", "samurai.generated_surface.create", "mcp__samurai__generated_surface_create"],
    proposedEffect: "Validate and persist a versioned Generated Surface bundle.",
    requiredResourceKinds: ["generated_surface", "generated_surface_revision"],
    unavailableSummary: "Generated Surface creation is unavailable because the Host tool port is not configured.",
    completedSummary: "Generated Surface creation was already completed for this tool call.",
    defaultChangeType: "other"
  },
  {
    operation: "generated_surface.revise",
    capabilityId: "generated_surface.revise",
    providerToolNames: ["generated_surface.revise", "samurai.generated_surface.revise", "mcp__samurai__generated_surface_revise"],
    proposedEffect: "Create a new immutable Generated Surface revision.",
    requiredResourceKinds: ["generated_surface", "generated_surface_revision"],
    unavailableSummary: "Generated Surface revision is unavailable because the Host tool port is not configured.",
    completedSummary: "Generated Surface revision was already completed for this tool call.",
    defaultChangeType: "other"
  }
];

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
  started_at: Date | string;
  completed_at: Date | string | null;
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
  created_at: Date | string;
  work_id?: string | null;
}

interface RuntimeSessionRow {
  workspace_id: string;
  id: string;
  session_key: string;
  room_id: string | null;
  title: string;
  ui_locale: string;
  output_locale: string;
  created_at: Date | string;
  updated_at: Date | string;
  work_id?: string | null;
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
  created_at: Date | string;
  updated_at: Date | string;
}

interface RuntimeAuditRecordRow {
  record: unknown;
}

interface RuntimeAgentRow {
  id: string;
  display_name: string;
  backend_id: string;
  status: string;
  role?: string;
  instructions?: string;
  enabled?: boolean;
  configuration_version?: number | string;
}

interface RuntimeRoomDefaultAgentRow {
  default_agent_id: string | null;
  default_agent_version: number | string | null;
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
  created_at: Date | string;
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
 * このクラスは旧互換Storeを隠れて再利用しない。Admission、RunのCAS、
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
  private readonly toolExecution?: PostgresRuntimeToolExecutionPort;
  private readonly availableTools: string[];
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
    this.toolExecution = options.toolExecution;
    this.availableTools = options.availableTools ? [...options.availableTools] : [];
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
      const operation = buildSessionCreateOperation({
        id: operationRecordId,
        correlationId: operationId,
        session,
        inputHash,
        now,
        principal: this.principal,
        source: this.source
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
        [this.workspaceId, operationRecordId, session.id, roomId, jsonText(operation), now]
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
    toolRuns: ToolRunRecord[];
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
      toolRuns: deriveToolRuns(session.id, backendEvents),
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

  async listBackendEvents(input: string | { runId: string; afterSequence?: number; limit?: number }): Promise<BackendEventRecord[]> {
    const runId = typeof input === "string" ? input : input.runId;
    const afterSequence = typeof input === "string" ? undefined : input.afterSequence;
    const limit = typeof input === "string" ? undefined : input.limit;
    if (afterSequence !== undefined && (!Number.isSafeInteger(afterSequence) || afterSequence < 0)) {
      throw new WorkspaceServerError("after_sequence_invalid", 400);
    }
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000)) {
      throw new WorkspaceServerError("limit_invalid", 400);
    }
    return this.database.withContext(this.context(), async (sql) => {
      const values: unknown[] = [this.workspaceId, requireId(runId, "backend_run_id_required")];
      const predicates = ["workspace_id = $1", "run_id = $2"];
      if (afterSequence !== undefined) {
        values.push(afterSequence);
        predicates.push(`sequence > $${values.length}`);
      }
      let query = `SELECT * FROM workspace_runtime_events
         WHERE ${predicates.join(" AND ")}
         ORDER BY sequence, id`;
      if (limit !== undefined) {
        values.push(limit);
        query += `\n         LIMIT $${values.length}`;
      }
      const result = await sql.query<RuntimeEventRow>(
        query,
        values
      );
      return result.rows.map(eventFromRow);
    });
  }

  async cancelBackendRun(runId: string): Promise<BackendRunRecord> {
    const initial = await this.requireControlRun(runId);
    if (isSettled(initial)) return this.reprojectSettledRun(initial);
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
    if (isSettled(cancelling)) return this.reprojectSettledRun(cancelling);
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
    if (isSettled(latest)) return this.reprojectSettledRun(latest);
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
    if (isSettled(initial)) return this.reprojectSettledRun(initial);
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
    if (isSettled(resumed)) return this.reprojectSettledRun(resumed);
    const admission = await this.admissionForRun(resumed);
    const backendSessionId = resumed.backend_session_id;
    if (!backendSessionId) throw new WorkspaceServerError("runtime_resume_backend_session_missing", 409);
    const streamInput: Record<string, JsonValue> = { ...safeInput, backend_session_id: backendSessionId };
    const resumedAdmission = { ...admission, run: resumed };
    const settled = await this.executeBackendStream({
      admission: resumedAdmission,
      runInput: this.backendRunInputForControl(resumedAdmission),
      stream: backend.resumeRun(resumed.id, streamInput),
      unknownOnError: true
    });
    await this.notifyCompletionActivity(await this.project(settled), admission.userMessage.content);
    return settled;
  }

  async syncBackendRun(runId: string): Promise<BackendRunRecord> {
    const run = await this.requireControlRun(runId);
    // An outcome-unknown Run is a durable uncertainty marker, not a final
    // success/failure.  A later backend terminal event may reconcile it.  Do
    // not reconnect stable terminal Runs, and never re-run the provider.
    if (isSettled(run) && run.status !== "outcome_unknown") return this.reprojectSettledRun(run);
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
    const settled = await this.executeBackendStream({
      admission,
      runInput: this.backendRunInputForControl(admission),
      stream: backend.streamEvents(run.id),
      unknownOnError: true
    });
    await this.notifyCompletionActivity(await this.project(settled), admission.userMessage.content);
    return settled;
  }

  async recoverBackendRun(runId: string): Promise<BackendRunRecord> {
    const run = await this.requireControlRun(runId);
    if (isSettled(run)) return this.reprojectSettledRun(run);
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
    const originalBinding = runtimeBindingFromRunMetadata(original.metadata, {
      workspaceId: this.workspaceId,
      roomId: original.room_id ?? admission.session.room_id!,
      sessionId: admission.session.id,
      agent: admission.agent,
      agentId: original.agent_id,
      backendId: original.backend_id
    });
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
      attemptNo: (original.current_attempt ?? 1) + 1,
      ...(originalBinding ? {
        executionBinding: {
          ...(originalBinding.workId ? { workId: originalBinding.workId } : {}),
          ...(originalBinding.assigneeId ? { assigneeId: originalBinding.assigneeId } : {}),
          ...(originalBinding.parentAssigneeId ? { parentAssigneeId: originalBinding.parentAssigneeId } : {}),
          generation: originalBinding.generation,
          agentConfigurationVersion: originalBinding.agentConfigurationVersion
        }
      } : {})
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
    const persistedBinding = runtimeBindingFromRunMetadata(run.metadata, {
      workspaceId: this.workspaceId,
      roomId: run.room_id,
      sessionId: run.session_id,
      agentId: run.agent_id ?? undefined,
      backendId: run.backend_id
    });
    const persistedAgent = persistedBinding ? runtimeAgentFromBinding(persistedBinding) : undefined;
    return this.database.withContext(this.context(), async (sql) => {
      await this.assertRoomCanExecute(sql, run.room_id!);
      // `withContext` supplies one PoolClient.  Keep these reads sequential so
      // the admission path never queues concurrent queries on that client.
      // Apart from avoiding pg's client-queue deprecation, this preserves the
      // same RLS context and fail-closed row checks as the former read set.
      const sessionResult = await sql.query<RuntimeSessionRow>(
        `SELECT workspace_id, id, session_key, room_id, title, ui_locale, output_locale, created_at, updated_at
         FROM workspace_runtime_sessions WHERE workspace_id = $1 AND id = $2`,
        [this.workspaceId, run.session_id]
      );
      const messageResult = await sql.query<RuntimeMessageRow>(
        "SELECT * FROM workspace_runtime_messages WHERE workspace_id = $1 AND id = $2",
        [this.workspaceId, run.input_message_id]
      );
      const operationResult = await sql.query<RuntimeOperationRow>(
        `SELECT workspace_id, id, session_id, room_id, operation, status, payload, created_at, updated_at
         FROM workspace_runtime_operations WHERE workspace_id = $1 AND id = $2`,
        [this.workspaceId, runtimeOperationId(run.id)]
      );
      const activityResult = await sql.query<RuntimeActivityRow>(
        `SELECT * FROM workspace_runtime_activities
         WHERE workspace_id = $1 AND backend_run_id = $2 AND room_id = $3
         ORDER BY created_at DESC LIMIT 1`,
        [this.workspaceId, run.id, run.room_id]
      );
      const sessionRow = sessionResult.rows[0];
      const messageRow = messageResult.rows[0];
      const operationRow = operationResult.rows[0];
      const activityRow = activityResult.rows[0];
      if (!sessionRow || !messageRow || !operationRow || !activityRow) {
        throw new WorkspaceServerError(`runtime_run_admission_incomplete:${run.id}`, 500);
      }
      return {
        session: sessionFromRow(sessionRow),
        ...(persistedAgent ? { agent: persistedAgent } : {}),
        userMessage: messageFromRow(messageRow),
        run,
        operation: operationFromRow(operationRow),
        activity: ActivityRecordSchema.parse(jsonValue(activityRow.record)),
        replay: true
      };
    });
  }

  /** Rebuilds the minimum trusted BackendRunInput needed when a control route
   * replays a provider stream. Tool execution receives the same Room, message,
   * locale, and capability context as a new Chat turn without exposing the
   * control transport's raw input as a new user instruction. */
  private backendRunInputForControl(admission: RuntimeAdmission): BackendRunInput {
    const roomId = admission.run.room_id ?? admission.session.room_id;
    if (!roomId) throw new WorkspaceServerError(`runtime_run_room_missing:${admission.run.id}`, 409);
    const binding = runtimeBindingFromRunMetadata(admission.run.metadata, {
      workspaceId: this.workspaceId,
      roomId,
      sessionId: admission.session.id,
      agent: admission.agent,
      agentId: admission.run.agent_id,
      backendId: admission.run.backend_id
    });
    const backend = this.backendRegistry.get(admission.run.backend_id);
    const continuationState = runtimeContinuationFromRunMetadata(admission.run.metadata);
    const executionContext = binding && backend ? runtimeExecutionContext(binding, backend, continuationState) : undefined;
    const envelope = admission.userMessage.envelope ?? MessageEnvelopeSchema.parse({
      id: createId("envelope"),
      source: channelForSource(admission.run.source),
      actor_identity: actorIdentityForSource(admission.run.source),
      session_key: admission.session.session_key,
      user_intent: "chat",
      attachments: [],
      input_locale: admission.userMessage.input_locale,
      output_locale: admission.userMessage.output_locale,
      metadata: {},
      received_at: admission.userMessage.created_at
    });
    const backendEnvelope = {
      ...envelope,
      metadata: runtimeMetadataForBackend(envelope.metadata)
    };
    return {
      run_id: admission.run.id,
      session_id: admission.session.id,
      room_id: roomId,
      ...(admission.agent ? {
        agent_context: {
          id: admission.agent.id,
          name: admission.agent.name,
          role: admission.agent.role,
          instructions: admission.agent.instructions,
          authority: "supporting_context" as const
        }
      } : {}),
      ...(binding ? { backend_session_key: runtimeBackendSessionKey(binding) } : {}),
      // Native Room-work continuity is rebuilt from Samurai's persisted
      // context. Never feed a provider Session ID into that typed boundary;
      // external backends may still need their existing native identifier.
      ...(admission.run.backend_session_id && !executionContext ? { backend_session_id: admission.run.backend_session_id } : {}),
      input_message_id: admission.userMessage.id,
      workspace_root: this.agentWorktreeRoot,
      working_directory: this.agentWorktreeRoot,
      envelope: backendEnvelope,
      user_input: admission.userMessage.content,
      input_locale: admission.userMessage.input_locale,
      output_locale: admission.userMessage.output_locale,
      active_memory: [],
      available_tools: this.availableProviderTools(binding),
      recent_messages: [],
      // The persisted Run binding is authoritative for control/reconnect
      // paths.  Pass its typed association separately; generic metadata is
      // kept as caller data and never used as a hidden execution contract.
      metadata: runtimeMetadataForBackend(admission.run.metadata),
      context_intent: "light_chat",
      ...(executionContext ? { execution_context: executionContext } : {})
    };
  }

  /**
   * Provider capability advertisement is derived per execution, never from
   * the HTTP request that constructed this Runtime facade. The delegation
   * tool is available only when the admitted Run has the complete trusted
   * Room-work association and the Host port that enforces it.
   */
  private availableProviderTools(binding?: RuntimeExecutionBinding): string[] {
    const hasTrustedRoomWorkBinding = Boolean(
      binding?.workId
      && binding.assigneeId
      && binding.agentId
      && binding.backendId
      && Number.isSafeInteger(binding.generation)
      && binding.generation >= 0
      && Number.isSafeInteger(binding.agentConfigurationVersion)
      && binding.agentConfigurationVersion >= 1
      && binding.agent.enabled
      && this.toolExecution?.delegate
    );
    return this.availableTools.filter((toolName) => toolName !== "subagent_delegate" || hasTrustedRoomWorkBinding);
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

  /**
   * Control operations may race with a backend settlement. Rebuild the
   * canonical admission/projected result and retry only the Completion
   * projection; never re-run the provider for an already settled Run.
   */
  private async reprojectSettledRun(run: BackendRunRecord): Promise<BackendRunRecord> {
    if (!isSettled(run) || !this.onCompletionActivity) return run;
    const admission = await this.admissionForRun(run);
    await this.notifyCompletionActivity(await this.project(run), admission.userMessage.content);
    return run;
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
        created_at: isoTimestamp(row.created_at)
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
          `SELECT session.workspace_id, session.id, session.session_key, session.room_id, session.title,
                  session.ui_locale, session.output_locale, session.created_at, session.updated_at,
                  COALESCE(legacy.work_id, runtime_work.work_id) AS work_id
           FROM workspace_runtime_sessions AS session
           LEFT JOIN workspace_human_work_legacy_sessions AS legacy
             ON legacy.workspace_id = session.workspace_id AND legacy.legacy_session_id = session.id
           LEFT JOIN LATERAL (
             SELECT runtime_run.metadata -> 'runtime_binding' ->> 'work_id' AS work_id
             FROM workspace_runtime_runs AS runtime_run
             WHERE runtime_run.workspace_id = session.workspace_id
               AND runtime_run.session_id = session.id
               AND runtime_run.room_id = session.room_id
               AND jsonb_typeof(runtime_run.metadata -> 'runtime_binding') = 'object'
             ORDER BY runtime_run.updated_at DESC, runtime_run.id DESC
             LIMIT 1
           ) AS runtime_work ON TRUE
           WHERE session.workspace_id = $1 AND session.room_id = $2 AND (session.title ILIKE $3 OR session.session_key ILIKE $3)
           ORDER BY session.updated_at DESC, session.id DESC LIMIT 50`,
          [this.workspaceId, normalizedRoomId, pattern]
        ),
        sql.query<RuntimeMessageRow>(
          `SELECT message.*, COALESCE(legacy.work_id, runtime_work.work_id) AS work_id
           FROM workspace_runtime_messages AS message
           JOIN workspace_runtime_sessions session
             ON session.workspace_id = message.workspace_id AND session.id = message.session_id
           LEFT JOIN workspace_human_work_legacy_sessions AS legacy
             ON legacy.workspace_id = session.workspace_id AND legacy.legacy_session_id = session.id
           LEFT JOIN LATERAL (
             SELECT runtime_run.metadata -> 'runtime_binding' ->> 'work_id' AS work_id
             FROM workspace_runtime_runs AS runtime_run
             WHERE runtime_run.workspace_id = session.workspace_id
               AND runtime_run.session_id = session.id
               AND runtime_run.room_id = session.room_id
               AND jsonb_typeof(runtime_run.metadata -> 'runtime_binding') = 'object'
             ORDER BY runtime_run.updated_at DESC, runtime_run.id DESC
             LIMIT 1
           ) AS runtime_work ON TRUE
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
          summary: row.title,
          ...(row.work_id ? { work_id: row.work_id } : {})
        })),
        ...messages.rows.map((row): PostgresRuntimeSearchResult => ({
          kind: "message",
          id: row.id,
          title: row.content.slice(0, 120),
          summary: row.content.slice(0, 240),
          session_id: row.session_id,
          ...(row.work_id ? { work_id: row.work_id } : {})
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
    if (requestedBackendId && requestedBackendId !== agent.backendId) {
      throw new WorkspaceServerError("runtime_backend_agent_mismatch", 409);
    }
    const executionBinding = buildRuntimeExecutionBinding({
      workspaceId: this.workspaceId,
      roomId: session.room_id,
      sessionId: session.id,
      agent,
      input: input.executionBinding
    });
    const backendId = agent.backendId;
    const backend = this.backendRegistry.get(backendId);
    if (!backend) throw new WorkspaceServerError(`runtime_backend_not_registered:${backendId}`, 409);
    const roomWorkContinuation = resolveRoomWorkExternalContinuation({
      candidate: input.resumeBackendContinuation,
      binding: executionBinding,
      backend,
      workspaceId: this.workspaceId,
      sessionId: session.id,
      roomId: session.room_id
    });
    // A raw provider SessionRef predates Room Work.  It remains available to
    // legacy internal callers, but a Room-work binding deliberately ignores
    // it: only the Store-derived, association-checked candidate above can
    // select a provider resume path.
    const legacyResumeBackendSessionId = executionBinding.workId
      ? undefined
      : input.resumeBackendSessionId?.trim() || undefined;
    if (!executionBinding.workId && input.resumeBackendSessionId !== undefined && !legacyResumeBackendSessionId) {
      throw new WorkspaceServerError("runtime_backend_session_id_invalid", 400);
    }
    if (legacyResumeBackendSessionId && backend.kind === "samurai_native") {
      throw new WorkspaceServerError("runtime_backend_resume_unsupported", 409);
    }
    if (legacyResumeBackendSessionId && !backend.resumeRun) {
      throw new WorkspaceServerError("runtime_backend_resume_unsupported", 409);
    }
    const resumeBackendSessionId = roomWorkContinuation?.backendSessionId ?? legacyResumeBackendSessionId;
    const continuationState = roomWorkContinuation?.state;
    const executionContext = runtimeExecutionContext(executionBinding, backend, continuationState);
    // Room Work attachments are server-issued immutable file references. Read
    // the DB row and physical bytes before admission so an invalid request
    // cannot create a durable Message/Run/Activity/Reservation. The admit
    // transaction repeats the DB-side association check under a file lock.
    const roomWorkExecution = Boolean(executionBinding.workId);
    const hasFileAttachment = (input.attachments ?? []).some((ref) => ref.kind === "file");
    const roomWorkPreflight = hasFileAttachment
      ? await this.preflightRoomWorkAttachments(session.room_id, input.attachments ?? [], roomWorkExecution)
      : undefined;
    const attachments = roomWorkExecution
      ? roomWorkPreflight?.map((item) => item.ref) ?? (input.attachments ?? [])
      : (input.attachments ?? []);
    const inputLocale = input.inputLocale ?? session.ui_locale;
    const outputLocale = input.outputLocale ?? session.output_locale;
    const userMetadata = runtimeMetadataForBackend(input.metadata ?? {});
    const envelope = MessageEnvelopeSchema.parse({
      id: createId("envelope"),
      source: this.source?.kind === "external_app" ? "webhook" : this.source?.kind === "host" ? "cron" : "web",
      actor_identity: this.source?.kind === "external_app" ? "external_app" : this.source?.kind === "host" ? "owner_scheduled" : "owner",
      session_key: session.session_key,
      user_intent: "chat",
      attachments,
      input_locale: inputLocale,
      output_locale: outputLocale,
      metadata: userMetadata,
      received_at: nowIso()
    });
    const backendEnvelope = {
      ...envelope,
      metadata: runtimeMetadataForBackend(envelope.metadata)
    };
    const requestHash = stableHash({
      session_id: session.id,
      room_id: session.room_id,
      agent_id: agent.id,
      backend_id: backend.id,
      // The lease owner/reservation are a short-lived admission fence, not
      // the logical request identity. A recovered worker must be able to
      // reconcile/replay the same Run after the lease changes hands.
      execution_binding: runtimeBindingHashMetadata(executionBinding),
      content,
      input_locale: inputLocale,
      output_locale: outputLocale,
      metadata: userMetadata,
      attachments,
      temporary_context: (input.temporaryContext ?? []).map(temporaryContextHash),
      retry_of_run_id: input.retryOfRunId ?? null,
      attempt_no: input.attemptNo ?? 1,
      resume_backend_session_id: resumeBackendSessionId ?? null
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
      attemptNo: input.attemptNo,
      metadata: userMetadata,
      attachments,
      executionBinding,
      ...(continuationState ? { continuationState } : {})
    });
    if (admission.replay) {
      if (isSettled(admission.run)) {
        const projected = await this.project(admission.run);
        await this.notifyCompletionActivity(projected, content);
        return markChatReplay(projected);
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
      materializedAttachments = await this.materializeWorkspaceAttachments(
        session.room_id,
        attachments,
        admission.run.id,
        roomWorkPreflight
      );
    } catch (error) {
      // No provider has started yet. Remove the provisional admission rows so
      // a physical-file race cannot leave a failed Run/Message/Activity or a
      // held reservation behind. If a concurrent control already moved the
      // Run out of the admitted phase, fall back to the existing terminal
      // evidence path rather than deleting a live execution.
      await this.discardUnstartedAdmission(admission, error, "runtime_workspace_attachment_unavailable");
    }
    try {
      await this.transitionToExternalRunning(admission.run);
      const recentMessages = await this.listMessages(session.id);
      const buildInputForBackend = (continuation?: RuntimeContinuationState, providerSessionId?: string): BackendRunInput => ({
        run_id: admission.run.id,
        session_id: session.id,
        room_id: session.room_id,
        agent_context: { id: agent.id, name: agent.name, role: agent.role, instructions: agent.instructions, authority: "supporting_context" as const },
        backend_session_key: runtimeBackendSessionKey(executionBinding),
        input_message_id: admission.userMessage.id,
        workspace_root: this.agentWorktreeRoot,
        working_directory: this.agentWorktreeRoot,
        envelope: backendEnvelope,
        user_input: content,
        input_locale: inputLocale,
        output_locale: outputLocale,
        active_memory: knowledge.map((page) => memoryCandidate(page)),
        recent_messages: recentMessages,
        ...((input.temporaryContext?.length || materializedAttachments.length) ? {
          temporary_context: [...(input.temporaryContext ?? []), ...materializedAttachments.map((item) => item.context)]
        } : {}),
        // The persisted Run metadata is the authoritative binding.  A
        // provider must not receive a caller-supplied Room/work/Agent context
        // that differs from the admission record.
        metadata: runtimeMetadataForBackend(admission.run.metadata),
        context_intent: "light_chat",
        available_tools: this.availableProviderTools(executionBinding),
        ...(providerSessionId ? { backend_session_id: providerSessionId } : {}),
        ...(continuation ? { execution_context: runtimeExecutionContext(executionBinding, backend, continuation) } : executionContext ? { execution_context: executionContext } : {}),
        ...(input.signal ? { abort_signal: input.signal } : {})
      });
      let inputForBackend = buildInputForBackend(continuationState, resumeBackendSessionId);
      let settled: BackendRunRecord;
      if (!resumeBackendSessionId) {
        settled = await this.executeBackendStream({
          admission,
          runInput: inputForBackend,
          stream: backend.runTurn(inputForBackend)
        });
      } else {
        let backendStream: AsyncIterable<BackendOutputEvent>;
        try {
          backendStream = backend.resumeRun!(admission.run.id, {
            backend_session_id: resumeBackendSessionId,
            user_input: content,
            input_locale: inputLocale,
            output_locale: outputLocale,
            ...(attachments.length > 0 ? { attachments } : {})
          });
        } catch (error) {
          // A synchronous resume failure proves that the provider did not
          // accept this continuation. Record the reconstruction before
          // starting a fresh provider conversation.
          if (!executionBinding.parentAssigneeId) throw error;
          const fallbackState: RuntimeContinuationState = {
            mode: "reconstructed",
            source: "samurai_context",
            reason: "resume_failed"
          };
          await this.updateContinuationState(admission, fallbackState);
          inputForBackend = buildInputForBackend(fallbackState);
          settled = await this.executeBackendStream({
            admission,
            runInput: inputForBackend,
            stream: backend.runTurn(inputForBackend)
          });
          const result = await this.project(settled);
          await this.notifyCompletionActivity(result, content);
          return result;
        }
        try {
          settled = await this.executeBackendStream({
            admission,
            runInput: inputForBackend,
            stream: backendStream,
            rethrowExternalContinuationFailure: Boolean(executionBinding.parentAssigneeId)
          });
        } catch (error) {
          if (!(error instanceof ExternalContinuationResumeFailure) || !executionBinding.parentAssigneeId) throw error;
          const fallbackState: RuntimeContinuationState = {
            mode: "reconstructed",
            source: "samurai_context",
            reason: "resume_failed"
          };
          await this.updateContinuationState(admission, fallbackState);
          inputForBackend = buildInputForBackend(fallbackState);
          settled = await this.executeBackendStream({
            admission,
            runInput: inputForBackend,
            stream: backend.runTurn(inputForBackend)
          });
        }
      }
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
    runId: string,
    preparedFiles?: readonly PreflightWorkspaceFile[]
  ): Promise<MaterializedWorkspaceAttachment[]> {
    const fileRefs = refs.filter((ref) => ref.kind === "file");
    if (fileRefs.length === 0) return [];
    if (!this.readWorkspaceFile) throw new WorkspaceServerError("runtime_workspace_attachment_reader_unavailable", 503);
    await mkdir(path.join(this.agentWorktreeRoot, "attachments"), { recursive: true, mode: 0o700 });
    let totalBytes = 0;
    const materialized: MaterializedWorkspaceAttachment[] = [];
    try {
      for (const ref of fileRefs) {
        const prepared = preparedFiles?.find((item) => item.ref.uri === ref.uri && item.ref.id === ref.id && item.ref.version === ref.version);
        // Re-read after admission as well. A file can be replaced after the
        // transaction commits but before the provider starts; using only the
        // preflight snapshot would silently execute stale bytes.
        const file = await this.readWorkspaceFile(this.context(), roomId, ref);
        if (file.path !== ref.uri) throw new WorkspaceServerError("runtime_workspace_attachment_scope_mismatch", 409);
        if (ref.id !== file.sha256) throw new WorkspaceServerError("runtime_workspace_attachment_reference_mismatch", 409);
        if (ref.version === undefined || ref.version !== String(file.version)) {
          throw new WorkspaceServerError("runtime_workspace_attachment_version_conflict", 409);
        }
        if (prepared && (prepared.file.sha256 !== file.sha256 || prepared.file.version !== file.version)) {
          throw new WorkspaceServerError("runtime_workspace_attachment_changed_during_admission", 409);
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

  /**
   * Room Work attachment reads are deliberately performed before Runtime
   * admission.  The Store-backed reader verifies both the DB row and the
   * physical bytes; admission repeats the DB association check in its own
   * transaction so a concurrent file update cannot turn an old snapshot into
   * an executable Work request.
   */
  private async preflightRoomWorkAttachments(
    roomId: string,
    refs: readonly ResourceRef[],
    strictRoomWork = true
  ): Promise<PreflightWorkspaceFile[]> {
    const candidates = strictRoomWork ? refs : refs.filter((ref) => ref.kind === "file");
    const parsed = WorkspaceFileResourceRefSchema.array().max(32).safeParse(candidates);
    if (!parsed.success) throw new WorkspaceServerError("runtime_workspace_attachment_reference_invalid", 400);
    if (parsed.data.length === 0) return [];
    if (!this.readWorkspaceFile) throw new WorkspaceServerError("runtime_workspace_attachment_reader_unavailable", 503);
    const files: PreflightWorkspaceFile[] = [];
    for (const ref of parsed.data) {
      const file = await this.readWorkspaceFile(this.context(), roomId, ref);
      if (!Number.isSafeInteger(file.version) || file.version < 1) {
        throw new WorkspaceServerError("runtime_workspace_attachment_version_invalid", 409);
      }
      if (file.path !== ref.uri) {
        throw new WorkspaceServerError("runtime_workspace_attachment_scope_mismatch", 409);
      }
      if (ref.id !== file.sha256) {
        throw new WorkspaceServerError("runtime_workspace_attachment_reference_mismatch", 409);
      }
      if (ref.version !== String(file.version)) {
        throw new WorkspaceServerError("runtime_workspace_attachment_version_conflict", 409);
      }
      files.push({ ref, file });
    }
    return files;
  }

  /**
   * Materialization happens after admission for the normal provider path, so
   * a filesystem failure must remove the provisional durable rows.  The
   * second transaction only deletes a still-queued/admitted Run with no
   * Runtime events; a concurrent stop/control that moved the Run to another
   * phase is left to the normal terminal-evidence path instead.
   */
  private async discardUnstartedAdmission(
    admission: RuntimeAdmission,
    error: unknown,
    fallbackCode: string
  ): Promise<never> {
    const binding = admission.run.metadata
      ? runtimeBindingFromRunMetadata(admission.run.metadata, {
          workspaceId: this.workspaceId,
          roomId: admission.session.room_id!,
          sessionId: admission.session.id,
          agent: admission.agent,
          agentId: admission.run.agent_id ?? admission.agent?.id,
          backendId: admission.run.backend_id
        })
      : undefined;
    const cleanupErrorCode = error instanceof WorkspaceServerError ? error.code : fallbackCode;
    const discarded = await this.database.withContext(this.context(), async (sql) => {
      if (binding?.workId && binding.assigneeId) {
        const reset = await sql.query<{ discarded: boolean }>(
          "SELECT samurai_discard_human_work_runtime_admission($1, $2, $3, $4, $5, $6) AS discarded",
          [this.workspaceId, binding.workId, binding.assigneeId, binding.generation, admission.run.id, cleanupErrorCode]
        );
        if (reset.rows[0]?.discarded !== true) return false;
      }
      const current = await sql.query<{
        status: string;
        phase: string | null;
        session_id: string | null;
        room_id: string | null;
        input_message_id: string | null;
      }>(
        `SELECT status, phase, session_id, room_id, input_message_id
           FROM workspace_runtime_runs
          WHERE workspace_id = $1 AND id = $2
          FOR UPDATE`,
        [this.workspaceId, admission.run.id]
      );
      const row = current.rows[0];
      if (!row || row.status !== "queued" || row.phase !== "admitted"
        || row.session_id !== admission.session.id
        || row.room_id !== admission.session.room_id
        || row.input_message_id !== admission.userMessage.id) {
        return false;
      }
      const events = await sql.query<{ id: string }>(
        `SELECT id FROM workspace_runtime_events
          WHERE workspace_id = $1 AND run_id = $2
          LIMIT 1`,
        [this.workspaceId, admission.run.id]
      );
      if (events.rows[0]) return false;
      await sql.query(
        `DELETE FROM workspace_runtime_resource_usage
          WHERE workspace_id = $1 AND activity_id = $2`,
        [this.workspaceId, admission.activity.id]
      );
      await sql.query(
        `DELETE FROM workspace_runtime_changes
          WHERE workspace_id = $1 AND (run_id = $2 OR activity_id = $3 OR domain_operation_id = $4)`,
        [this.workspaceId, admission.run.id, admission.activity.id, admission.operation.id]
      );
      await sql.query(
        `DELETE FROM workspace_runtime_events
          WHERE workspace_id = $1 AND run_id = $2`,
        [this.workspaceId, admission.run.id]
      );
      await sql.query(
        `DELETE FROM workspace_runtime_activities
          WHERE workspace_id = $1 AND id = $2`,
        [this.workspaceId, admission.activity.id]
      );
      await sql.query(
        `DELETE FROM workspace_runtime_reservations
          WHERE workspace_id = $1 AND run_id = $2`,
        [this.workspaceId, admission.run.id]
      );
      await sql.query(
        `DELETE FROM workspace_runtime_operations
          WHERE workspace_id = $1 AND id = $2`,
        [this.workspaceId, admission.operation.id]
      );
      await sql.query(
        `DELETE FROM workspace_runtime_runs
          WHERE workspace_id = $1 AND id = $2`,
        [this.workspaceId, admission.run.id]
      );
      await sql.query(
        `DELETE FROM workspace_runtime_messages
          WHERE workspace_id = $1 AND id = $2`,
        [this.workspaceId, admission.userMessage.id]
      );
      return true;
    });
    if (!discarded) {
      return this.rejectAdmittedRun(
        admission,
        admission.session,
        admission.userMessage.content,
        error,
        fallbackCode
      );
    }
    throw error instanceof WorkspaceServerError ? error : new WorkspaceServerError(fallbackCode, 503);
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

  /**
   * Re-check the immutable DB half of every Room Work attachment while the
   * admission transaction is still open. Workspace file writes use the same
   * advisory key, so a committed version/path update cannot race this check.
   */
  private async assertRoomWorkAttachmentAdmission(
    sql: WorkspaceSql,
    roomId: string,
    refs: readonly ResourceRef[]
  ): Promise<void> {
    const parsed = WorkspaceFileResourceRefSchema.array().max(32).safeParse(refs);
    if (!parsed.success) throw new WorkspaceServerError("runtime_workspace_attachment_reference_invalid", 400);
    if (parsed.data.length === 0) return;
    const permission = await sql.query<{ allowed: boolean }>(
      "SELECT samurai_can_room($1, $2, 'read') AS allowed",
      [this.workspaceId, roomId]
    );
    if (permission.rows[0]?.allowed !== true) {
      throw new WorkspaceServerError("room_read_permission_denied", 403);
    }
    const paths = [...new Set(parsed.data.map((ref) => ref.uri))].sort();
    for (const filePath of paths) {
      await sql.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`${this.workspaceId}\u001f${filePath}`]);
    }
    const result = await sql.query<{ path: string; version: number | string; sha256: string }>(
      `SELECT path, version, sha256
         FROM workspace_files
        WHERE workspace_id = $1 AND room_id = $2 AND path = ANY($3::TEXT[])
        FOR SHARE`,
      [this.workspaceId, roomId, paths]
    );
    const files = new Map(result.rows.map((row) => [row.path, row]));
    for (const ref of parsed.data) {
      const file = files.get(ref.uri);
      if (!file) throw new WorkspaceServerError("runtime_workspace_attachment_not_found", 404);
      if (file.sha256 !== ref.id) {
        throw new WorkspaceServerError("runtime_workspace_attachment_reference_mismatch", 409);
      }
      if (String(file.version) !== ref.version) {
        throw new WorkspaceServerError("runtime_workspace_attachment_version_conflict", 409);
      }
    }
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
    metadata?: Record<string, JsonValue>;
    attachments?: readonly ResourceRef[];
    executionBinding?: RuntimeExecutionBinding;
    continuationState?: RuntimeContinuationState;
  }): Promise<RuntimeAdmission> {
    const now = nowIso();
    const runId = createId("run");
    const messageId = createId("message");
    const activityId = createId("activity");
    const source = this.source ?? { kind: "native_app" as const, app_id: "samurai-native" };
    const userMetadata = runtimeMetadataForBackend(input.metadata ?? {});
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
      metadata: {
        ...userMetadata,
        ...(input.retryOfRunId ? { retry_of_run_id: input.retryOfRunId } : {}),
        ...(input.executionBinding ? { runtime_binding: runtimeBindingMetadata(input.executionBinding) } : {}),
        ...(input.continuationState ? { runtime_continuation: input.continuationState } : {})
      }
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
      // Idempotent replays must be resolved before the Room Work admission
      // guard. A stop can legitimately close the assignment after the
      // original Run was admitted; replaying that durable Run must not be
      // mistaken for a new external execution and rejected because its
      // current_run_id is already set. The request hash check in
      // replayAdmission still rejects a reused key with different input.
      const existing = await sql.query<RuntimeRunRow>(
        `SELECT * FROM workspace_runtime_runs
         WHERE workspace_id = $1 AND session_id = $2 AND request_idempotency_key = $3`,
        [this.workspaceId, input.session.id, input.idempotencyKey]
      );
      if (existing.rows[0]) {
        return replayAdmission(sql, runFromRow(existing.rows[0]));
      }
      // Room-work stop and Runtime admission share the Work-row lock inside
      // this server-owned function. A stop committed before this point wins
      // before a Runtime Run (and therefore an external process) exists; if
      // admission wins, the insert trigger records the Run ID for the stop
      // dispatcher to cancel and reconcile.
      if (input.executionBinding?.workId && input.executionBinding.assigneeId) {
        try {
          const hasLeaseFence = Boolean(input.executionBinding.reservationId && input.executionBinding.leaseOwner);
          await sql.query(
            hasLeaseFence
              ? "SELECT samurai_assert_human_work_runtime_admission_v2($1, $2, $3, $4, $5, $6)"
              : "SELECT samurai_assert_human_work_runtime_admission($1, $2, $3, $4)",
            hasLeaseFence
              ? [
                this.workspaceId,
                input.executionBinding.workId,
                input.executionBinding.assigneeId,
                input.executionBinding.generation,
                input.executionBinding.reservationId,
                input.executionBinding.leaseOwner
              ]
              : [this.workspaceId, input.executionBinding.workId, input.executionBinding.assigneeId, input.executionBinding.generation]
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : "";
          if (message.includes("human_work_execution_admission_closed")) {
            throw new WorkspaceServerError("room_work_execution_admission_closed", 409);
          }
          throw error;
        }
        await this.assertRoomWorkAttachmentAdmission(
          sql,
          input.session.room_id!,
          input.attachments ?? []
        );
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
      const reservation = await sql.query<{ run_id: string; status: "held" | "released" }>(
        `INSERT INTO workspace_runtime_reservations(workspace_id, session_id, run_id, version, status, created_at, updated_at)
         VALUES ($1, $2, $3, 1, 'held', $4, $4)
         ON CONFLICT (workspace_id, session_id) DO UPDATE
         SET run_id = EXCLUDED.run_id,
             status = 'held',
             version = workspace_runtime_reservations.version + 1,
             updated_at = EXCLUDED.updated_at
         WHERE workspace_runtime_reservations.status = 'released'
         RETURNING run_id, status`,
        [this.workspaceId, input.session.id, run.id, now]
      );
      if (!reservation.rows[0]) {
        // A competing request can win the released-row upsert after the
        // initial held check. Surface the same stable 409 and let the
        // transaction roll back the provisional message/run rows.
        const conflicting = await sql.query<{ run_id: string; status: "held" | "released" }>(
          `SELECT run_id, status FROM workspace_runtime_reservations
           WHERE workspace_id = $1 AND session_id = $2
           FOR UPDATE`,
          [this.workspaceId, input.session.id]
        );
        const heldRunId = conflicting.rows[0]?.status === "held" ? conflicting.rows[0].run_id : undefined;
        throw new WorkspaceServerError(
          heldRunId
            ? `runtime_session_run_in_progress:${heldRunId}`
            : `runtime_reservation_conflict:${input.session.id}`,
          409
        );
      }
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
    runInput?: BackendRunInput;
    stream: AsyncIterable<BackendOutputEvent>;
    unknownOnError?: boolean;
    rethrowExternalContinuationFailure?: boolean;
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
    let receivedBackendEvent = false;
    try {
      for await (const backendEvent of input.stream) {
        receivedBackendEvent = true;
        const projection = eventBridge.project(backendEvent);
        if (projection.terminal) {
          terminal = projection.record;
          if (projection.terminal === "completed") output = this.collectText(output, projection.record);
          continue;
        }
        if (projection.record.event_type === "tool_call_started") {
          const started = projection.record;
          const savedStarted = await this.appendEvent(started);
          if (!savedStarted) continue;
          await this.notifyEvent(savedStarted, admission.session.room_id!);
          const toolOutcome = await this.executeToolCall({
            admission,
            ...(input.runInput ? { runInput: input.runInput } : {}),
            started,
            eventBridge
          });
          const outputEvent = this.toolOutputEvent(eventBridge, started, toolOutcome);
          const savedOutput = await this.appendEvent(outputEvent);
          if (savedOutput) await this.notifyEvent(savedOutput, admission.session.room_id!);
          if (toolOutcome.status === "failed") {
            throw new WorkspaceServerError(toolOutcome.errorCode ?? "runtime_tool_execution_failed", 500);
          }
          if (toolOutcome.status === "completed") {
            const artifactEvent = this.artifactCreatedEvent(eventBridge, started, toolOutcome);
            if (artifactEvent) {
              const savedArtifact = await this.appendEvent(artifactEvent);
              if (savedArtifact) await this.notifyEvent(savedArtifact, admission.session.room_id!);
            }
          }
          continue;
        }
        output = this.collectText(output, projection.record);
        const saved = await this.appendEvent(projection.record);
        if (saved) await this.notifyEvent(saved, admission.session.room_id!);
      }
    } catch (error) {
      if (input.rethrowExternalContinuationFailure && !receivedBackendEvent) {
        // No provider event was observed. This is the only resume failure
        // that can safely fall back to a new provider conversation: once an
        // event exists, the operation may already have side effects and must
        // remain an ordinary failed/unknown Run.
        throw new ExternalContinuationResumeFailure(error);
      }
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

  /**
   * Provider tool calls enter the Runtime as events. Only the explicit
   * Runtime whitelist below is executable. Every other provider tool fails
   * closed so an unknown capability can never cross the Workspace boundary or
   * make its parent Run look successful.
   */
  private async executeToolCall(input: {
    admission: RuntimeAdmission;
    runInput?: BackendRunInput;
    started: BackendEventRecord;
    eventBridge: BackendEventBridge;
  }): Promise<RuntimeToolOutcome> {
    const started = input.started;
    const toolCallId = stringPayload(started.payload.tool_call_id);
    if (!toolCallId) return { status: "failed", summary: "Tool call ID is missing.", errorCode: "tool_call_id_required" };
    const providerToolName = stringPayload(started.payload.provider_tool_name);
    const actionId = stringPayload(started.payload.action_id);
    const capabilityId = stringPayload(started.payload.capability_id);
    const isRoomWorkDelegation = capabilityId === "subagent_delegate"
      || actionId === "room.work.assignee.delegate"
      || providerToolName === "subagent_delegate"
      || providerToolName === "samurai.room.work.assignee.delegate"
      || providerToolName === "mcp__samurai__room_work_assignee_delegate";
    const executableSpec = isRoomWorkDelegation
      ? undefined
      : runtimeExecutableToolSpec(providerToolName, actionId);
    if (!executableSpec && !isRoomWorkDelegation) {
      return {
        status: "failed",
        providerToolName: providerToolName ?? "unknown_tool",
        actionId,
        summary: "This provider tool is not supported by the PostgreSQL Runtime boundary.",
        reason: "unsupported_tool",
        errorCode: "runtime_tool_unsupported"
      };
    }
    if (!this.toolExecution || !input.runInput) {
      const unavailableSummary = isRoomWorkDelegation
        ? "Room-work delegation is unavailable because the Host tool port is not configured."
        : executableSpec!.unavailableSummary;
      return {
        status: "failed",
        providerToolName: providerToolName ?? (isRoomWorkDelegation ? "subagent_delegate" : executableSpec!.providerToolNames[0]),
        actionId: actionId ?? (isRoomWorkDelegation ? "room.work.assignee.delegate" : executableSpec!.operation),
        summary: unavailableSummary,
        reason: "runtime_tool_execution_unavailable",
        errorCode: "runtime_tool_execution_unavailable"
      };
    }

    const event: PostgresRuntimeToolCallEvent = {
      tool_call_id: toolCallId,
      ...(providerToolName ? { provider_tool_name: providerToolName } : {}),
      ...(actionId ? { action_id: actionId } : {}),
      ...(capabilityId ? { capability_id: capabilityId } : {}),
      arguments: jsonRecord(started.payload.arguments ?? started.payload.input ?? {}),
      payload: started.payload
    };
    // Provider arguments are intent only.  In particular, a model must not
    // be able to select another Room Work, parent assignment, Run, actor, or
    // requester by smuggling those fields through the delegation tool.
    const executionEvent = isRoomWorkDelegation
      ? sanitizeDelegationToolEvent(event)
      : event;
    const operationSpec: RuntimeToolOperationSpec = isRoomWorkDelegation
      ? { operation: "room.work.assignee.delegate", capabilityId: "subagent_delegate", proposedEffect: "Create one bounded child Room-work assignment." }
      : executableSpec!;
    let operation: OperationRecord | undefined;
    let trustedRoomWorkBinding: PostgresRuntimeTrustedRoomWorkBinding | undefined;
    try {
      // Validate the persisted Room-work association before creating the
      // idempotency ledger entry. A normal Chat run, or a run whose binding
      // was lost/malformed, must not be able to replay or create a delegated
      // assignment merely by emitting the provider tool name.
      trustedRoomWorkBinding = isRoomWorkDelegation
        ? this.trustedRoomWorkBinding(input.admission)
        : undefined;
      operation = await this.ensureToolOperation(input.admission, executionEvent, operationSpec);
      if (operation.status === "completed" && operation.result_ref) {
        const replayedRefs = ResourceRefSchema.array().parse([operation.result_ref]);
        return {
          status: "completed",
          providerToolName: providerToolName ?? (isRoomWorkDelegation ? "subagent_delegate" : executableSpec!.providerToolNames[0]),
          actionId: actionId ?? operationSpec.operation,
          operationId: operation.id,
          resourceRefs: replayedRefs,
          summary: isRoomWorkDelegation ? "Room-work delegation was already completed for this tool call." : executableSpec!.completedSummary,
          output: { replayed: true, resource_ref: operation.result_ref }
        };
      }
      const result = isRoomWorkDelegation
        ? this.toolExecution.delegate
          ? await this.toolExecution.delegate({
              run: input.admission.run,
              runInput: input.runInput,
              event: executionEvent,
              operation,
              trustedRoomWorkBinding: trustedRoomWorkBinding!
            })
          : (() => { throw new WorkspaceServerError("runtime_subagent_delegate_unavailable", 503); })()
        : await this.toolExecution.execute({
        run: input.admission.run,
        runInput: input.runInput,
        event: executionEvent,
        operation
      });
      const resourceRefs = uniqueResourceRefs(ResourceRefSchema.array().max(32).parse(result.resourceRefs));
      const primaryResource = isRoomWorkDelegation
        ? undefined
        : resourceRefs.find((ref) => ref.kind === executableSpec!.requiredResourceKinds[0]);
      if (!isRoomWorkDelegation && executableSpec!.requiredResourceKinds.some((kind) => !resourceRefs.some((ref) => ref.kind === kind))) {
        throw new WorkspaceServerError("runtime_tool_result_resource_missing", 500, { operation: executableSpec!.operation });
      }
      if (isRoomWorkDelegation && !resourceRefs.some((ref) => ref.kind === "room_work_assignee")) {
        throw new WorkspaceServerError("runtime_tool_result_assignment_missing", 500);
      }
      const canonicalResourceRefs = uniqueResourceRefs([...(primaryResource ? [primaryResource] : []), ...resourceRefs]);
      const evidence = await this.settleToolExecution({
        admission: input.admission,
        operation,
        status: "completed",
        summary: result.summary,
        resourceRefs: canonicalResourceRefs,
        changeType: result.changeType ?? (isRoomWorkDelegation ? "other" : executableSpec!.defaultChangeType)
      });
      const refs = [...canonicalResourceRefs, evidence.activityRef, ...(evidence.changeRef ? [evidence.changeRef] : [])];
      return {
        status: "completed",
        providerToolName: providerToolName ?? (isRoomWorkDelegation ? "subagent_delegate" : executableSpec!.providerToolNames[0]),
        actionId: actionId ?? operationSpec.operation,
        operationId: operation.id,
        resourceRefs: refs,
        summary: result.summary,
        ...(result.output !== undefined ? { output: result.output } : {}),
        ...(result.changeType ? { changeType: result.changeType } : {})
      };
    } catch (error) {
      const errorCode = toolErrorCode(error);
      const summary = toolErrorSummary(error);
      if (operation) {
        try {
          await this.settleToolExecution({
            admission: input.admission,
            operation,
            status: "failed",
            summary,
            errorCode,
            resourceRefs: []
          });
        } catch {
          // The outer Runtime settlement still records a failed Run.  Never
          // turn an evidence failure into a successful tool result.
        }
      }
      return {
        status: "failed",
        providerToolName: providerToolName ?? (isRoomWorkDelegation ? "subagent_delegate" : executableSpec!.providerToolNames[0]),
        actionId: actionId ?? operationSpec.operation,
        ...(operation ? { operationId: operation.id } : {}),
        summary,
        errorCode,
        reason: "tool_execution_failed"
      };
    }
  }

  private toolOutputEvent(
    bridge: BackendEventBridge,
    started: BackendEventRecord,
    outcome: RuntimeToolOutcome
  ): BackendEventRecord {
    const toolCallId = requireId(stringPayload(started.payload.tool_call_id), "tool_call_id_required");
    const resourceRefs = outcome.resourceRefs ?? [];
    const payload: Record<string, JsonValue> = {
      tool_call_id: toolCallId,
      provider_tool_name: outcome.providerToolName ?? stringPayload(started.payload.provider_tool_name) ?? "unknown_tool",
      ...(outcome.actionId || stringPayload(started.payload.action_id) ? { action_id: outcome.actionId ?? stringPayload(started.payload.action_id)! } : {}),
      status: outcome.status,
      ok: outcome.status === "completed",
      summary: summarize(outcome.summary, 2_000),
      ...(outcome.reason ? { reason: outcome.reason } : {}),
      ...(outcome.errorCode ? { error_code: outcome.errorCode } : {}),
      ...(outcome.operationId ? { operation_id: outcome.operationId } : {}),
      ...(outcome.output !== undefined ? { output: outcome.output } : {}),
      ...(resourceRefs.length > 0 ? { resource_refs: resourceRefs } : {})
    };
    return bridge.project({
      event_type: "tool_call_output",
      tool_call_id: toolCallId,
      source_event_id: `runtime:tool-output:${started.run_id}:${toolCallId}`,
      payload: payload as never,
      resource_refs: resourceRefs
    }).record;
  }

  private artifactCreatedEvent(
    bridge: BackendEventBridge,
    started: BackendEventRecord,
    outcome: RuntimeToolOutcome
  ): BackendEventRecord | undefined {
    const artifactRef = outcome.resourceRefs?.find((ref) => ref.kind === "artifact");
    if (!artifactRef) return undefined;
    const output = outcome.output && typeof outcome.output === "object" && !Array.isArray(outcome.output)
      ? outcome.output as Record<string, JsonValue>
      : undefined;
    return bridge.project({
      event_type: "artifact_created",
      source_event_id: `runtime:artifact-created:${started.run_id}:${requireId(stringPayload(started.payload.tool_call_id), "tool_call_id_required")}`,
      payload: {
        artifact_id: artifactRef.id,
        resource_id: artifactRef.id,
        resource_kind: artifactRef.kind,
        resource_ref: artifactRef,
        resource_refs: [artifactRef],
        tool_call_id: stringPayload(started.payload.tool_call_id),
        ...(typeof output?.title === "string" ? { title: output.title } : {})
      }
    } as never).record;
  }

  /**
   * Build the only authority that the `subagent_delegate` port receives.
   * Room/work/assignment/run/requester identity is reconstructed from the
   * admitted Run and its persisted binding; provider arguments never enter
   * this object.
   */
  private trustedRoomWorkBinding(admission: RuntimeAdmission): PostgresRuntimeTrustedRoomWorkBinding {
    const roomId = admission.run.room_id ?? admission.session.room_id;
    if (!roomId) throw new WorkspaceServerError("runtime_room_work_room_missing", 409);
    const binding = runtimeBindingFromRunMetadata(admission.run.metadata, {
      workspaceId: this.workspaceId,
      roomId,
      sessionId: admission.session.id,
      agent: admission.agent,
      agentId: admission.run.agent_id ?? admission.agent?.id,
      backendId: admission.run.backend_id
    });
    if (!binding?.workId || !binding.assigneeId) {
      throw new WorkspaceServerError("runtime_subagent_binding_missing", 409);
    }
    const requestedByParticipantId = admission.run.requested_by_participant_id?.trim();
    if (!requestedByParticipantId) {
      throw new WorkspaceServerError("runtime_subagent_requester_missing", 409);
    }
    if (binding.workspaceId !== this.workspaceId || binding.roomId !== roomId || binding.sessionId !== admission.session.id) {
      throw new WorkspaceServerError("runtime_subagent_binding_mismatch", 409);
    }
    return {
      runId: admission.run.id,
      workspaceId: this.workspaceId,
      roomId,
      workId: binding.workId,
      assigneeId: binding.assigneeId,
      parentAssignmentId: binding.assigneeId,
      agentId: binding.agentId,
      generation: binding.generation,
      requestedByParticipantId
    };
  }

  private async ensureToolOperation(
    admission: RuntimeAdmission,
    event: PostgresRuntimeToolCallEvent,
    spec: RuntimeToolOperationSpec
  ): Promise<OperationRecord> {
    const operationId = runtimeToolOperationId(admission.run.id, event.tool_call_id);
    // Keep the historical artifact hash stable so an older completed tool
    // operation remains replayable after this delegation capability lands.
    const inputHash = stableHash(spec.operation === "artifact.create"
      ? {
          provider_tool_name: event.provider_tool_name ?? "create_artifact",
          action_id: event.action_id ?? "artifact.create",
          arguments: event.arguments
        }
      : {
          capability_id: spec.capabilityId,
          operation: spec.operation,
          provider_tool_name: event.provider_tool_name ?? spec.capabilityId,
          action_id: event.action_id ?? spec.operation,
          arguments: event.arguments
        });
    return this.database.withContext(this.context(), async (sql) => {
      await this.assertRoomCanExecute(sql, admission.run.room_id!);
      const existing = await sql.query<RuntimeOperationRow>(
        `SELECT workspace_id, id, session_id, room_id, operation, status, payload, created_at, updated_at
         FROM workspace_runtime_operations WHERE workspace_id = $1 AND id = $2 FOR UPDATE`,
        [this.workspaceId, operationId]
      );
      if (existing.rows[0]) {
        const operation = operationFromRow(existing.rows[0]);
        if (operation.input_hash !== inputHash) throw new WorkspaceServerError("runtime_tool_operation_conflict", 409);
        return operation;
      }
      const operation = buildToolOperation({
        id: operationId,
        run: admission.run,
        inputHash,
        inputMessageId: admission.userMessage.id,
        operation: spec.operation,
        capabilityId: spec.capabilityId,
        proposedEffect: spec.proposedEffect,
        now: nowIso()
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
      if (!saved.rows[0]) throw new WorkspaceServerError("runtime_tool_operation_persistence_failed", 500);
      const savedOperation = operationFromRow(saved.rows[0]);
      if (savedOperation.input_hash !== inputHash) throw new WorkspaceServerError("runtime_tool_operation_conflict", 409);
      return savedOperation;
    });
  }

  private async settleToolExecution(input: {
    admission: RuntimeAdmission;
    operation: OperationRecord;
    status: "completed" | "failed";
    summary: string;
    resourceRefs: ResourceRef[];
    changeType?: import("@samurai-agent/core-schemas").WorkspaceChangeType;
    errorCode?: string;
  }): Promise<{ operation: OperationRecord; activityRef: ResourceRef; changeRef?: ResourceRef }> {
    return this.database.withContext(this.context(), async (sql) => {
      await this.assertRoomCanExecute(sql, input.admission.run.room_id!);
      const activity = await this.activityForRun(sql, input.admission.run.id, input.admission.run.room_id!);
      if (!activity) throw new WorkspaceServerError("runtime_tool_activity_missing", 500);
      const now = nowIso();
      const settledOperation = await this.updateRuntimeOperation(sql, input.operation, {
        status: input.status,
        ...(input.status === "completed" && input.resourceRefs[0] ? { resultRef: input.resourceRefs[0] } : {}),
        ...(input.status === "failed" ? { error: input.errorCode ?? "runtime_tool_execution_failed" } : {})
      });
      const verificationId = `tool_verification:${input.operation.id}`;
      const verification = activity.verification.some((item) => item.id === verificationId)
        ? activity.verification
        : [
            ...activity.verification,
            {
              id: verificationId,
              kind: "backend" as const,
              status: input.status === "completed" ? "passed" as const : "failed" as const,
              summary: summarize(input.summary, 2_000),
              source_operation_id: input.operation.id,
              recorded_at: now
            }
          ];
      const updatedActivity = ActivityRecordSchema.parse({
        ...activity,
        verification,
        domain_operation_ids: [...new Set([...activity.domain_operation_ids, input.operation.id])],
        updated_at: now
      });
      await sql.query(
        `UPDATE workspace_runtime_activities SET record = $3::JSONB, updated_at = $4
         WHERE workspace_id = $1 AND id = $2`,
        [this.workspaceId, activity.id, jsonText(updatedActivity), now]
      );

      let changeRef: ResourceRef | undefined;
      if (input.status === "completed") {
        const resourceRef = input.resourceRefs[0];
        if (!resourceRef) throw new WorkspaceServerError("runtime_tool_result_resource_missing", 500);
        const changeId = runtimeToolChangeId(input.admission.run.id, input.operation.id, resourceRef.id);
        const change = WorkspaceChangeRecordSchema.parse({
          id: changeId,
          run_id: input.admission.run.id,
          ...(input.admission.run.session_id ? { session_id: input.admission.run.session_id } : {}),
          room_id: input.admission.run.room_id,
          activity_id: activity.id,
          domain_operation_id: input.operation.id,
          ...(input.admission.run.session_ref ? { session_ref: input.admission.run.session_ref } : {}),
          resource_ref: resourceRef,
          change_type: input.changeType ?? "artifact_created",
          summary: summarize(input.summary, 2_000),
          correlation_id: input.operation.correlation_id,
          created_at: now
        });
        await sql.query(
          `INSERT INTO workspace_runtime_changes(
             workspace_id, id, run_id, session_id, room_id, activity_id,
             domain_operation_id, session_ref, resource_ref, change_type,
             summary, correlation_id, created_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::JSONB, $9::JSONB, $10, $11, $12, $13)
           ON CONFLICT (workspace_id, id) DO NOTHING`,
          [this.workspaceId, change.id, change.run_id ?? null, change.session_id ?? null, change.room_id ?? null, change.activity_id ?? null, change.domain_operation_id ?? null, jsonText(change.session_ref), jsonText(change.resource_ref), change.change_type, change.summary, change.correlation_id ?? null, change.created_at]
        );
        changeRef = ResourceRefSchema.parse({ kind: "workspace_change", id: change.id, uri: `runtime://changes/${change.id}` });
        await this.appendRuntimeAudit(sql, settledOperation, "completed", input.summary, input.resourceRefs);
      } else {
        await this.appendRuntimeAudit(sql, settledOperation, "failed", input.summary);
      }
      return {
        operation: settledOperation,
        activityRef: ResourceRefSchema.parse({ kind: "activity", id: activity.id, uri: `runtime://activities/${activity.id}` }),
        ...(changeRef ? { changeRef } : {})
      };
    });
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
      if (!state) return undefined;
      if (isTerminalRunState(state.status, state.phase)
        && !(state.status === "outcome_unknown" && isTerminalEventType(event.event_type))) {
        return undefined;
      }
      if (event.backend_session_id) {
        const updatedRun = await sql.query<{ backend_session_id: string }>(
          `UPDATE workspace_runtime_runs
           SET backend_session_id = COALESCE(backend_session_id, $3)
           WHERE workspace_id = $1 AND id = $2
             AND (backend_session_id IS NULL OR backend_session_id = $3)
           RETURNING backend_session_id`,
          [this.workspaceId, event.run_id, event.backend_session_id]
        );
        if (updatedRun.rows[0]?.backend_session_id !== event.backend_session_id) {
          throw new WorkspaceServerError(`runtime_backend_session_conflict:${event.run_id}`, 409);
        }
      }
      const existing = await sql.query<RuntimeEventRow>(
        `SELECT * FROM workspace_runtime_events WHERE workspace_id = $1 AND id = $2`,
        [this.workspaceId, event.id]
      );
      if (existing.rows[0]) return eventFromRow(existing.rows[0]);
      if (event.source_event_id) {
        const existingSource = await sql.query<RuntimeEventRow>(
          `SELECT * FROM workspace_runtime_events
           WHERE workspace_id = $1 AND run_id = $2 AND source_event_id = $3
           LIMIT 1`,
          [this.workspaceId, event.run_id, event.source_event_id]
        );
        if (existingSource.rows[0]) return eventFromRow(existingSource.rows[0]);
      }
      await sql.query(
        `INSERT INTO workspace_runtime_events(
           workspace_id, id, run_id, session_id, backend_session_id, event_type, sequence,
           attempt_no, source_event_id, source_sequence, payload, resource_refs, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::JSONB, $12::JSONB, $13)
         ON CONFLICT (workspace_id, run_id, source_event_id) DO NOTHING`,
        [this.workspaceId, event.id, event.run_id, event.session_id ?? null, event.backend_session_id ?? null, event.event_type, event.sequence, event.attempt_no ?? null, event.source_event_id ?? null, event.source_sequence ?? null, jsonText(event.payload), jsonText(event.resource_refs), event.created_at]
      );
      const saved = await sql.query<RuntimeEventRow>(
        event.source_event_id
          ? `SELECT * FROM workspace_runtime_events
             WHERE workspace_id = $1 AND run_id = $2 AND source_event_id = $3
             LIMIT 1`
          : `SELECT * FROM workspace_runtime_events WHERE workspace_id = $1 AND id = $2`,
        event.source_event_id
          ? [this.workspaceId, event.run_id, event.source_event_id]
          : [this.workspaceId, event.id]
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
      const currentPhase = current.phase ?? "admitted";
      const lateUnknownReconciliation = current.status === "outcome_unknown"
        && currentPhase === "settled"
        && terminalEvidence?.success === true
        && terminalEvidence.data.kind !== "indeterminate";
      // Stable terminal Runs are immutable.  The only exception is a
      // previously outcome-unknown Run receiving a later evidence record;
      // that record is reconciled below under the same row lock.
      if (isSettled(current) && !lateUnknownReconciliation) return current;
      const activeStatuses: BackendRunRecord["status"][] = ["queued", "running", "waiting_for_backend_input"];
      if ((!activeStatuses.includes(current.status) && !lateUnknownReconciliation) || (currentPhase === "settled" && !lateUnknownReconciliation)) {
        throw new WorkspaceServerError(`runtime_settlement_cas_conflict:${current.id}`, 409);
      }
      const maxSequence = await sql.query<{ max_sequence: number | string | null }>(
        `SELECT MAX(sequence) AS max_sequence FROM workspace_runtime_events WHERE workspace_id = $1 AND run_id = $2`,
        [this.workspaceId, current.id]
      );
      const terminal = { ...input.terminal, sequence: Math.max(input.terminal.sequence, Number(maxSequence.rows[0]?.max_sequence ?? 0) + 1) };
      if (current.backend_session_id && terminal.backend_session_id
        && current.backend_session_id !== terminal.backend_session_id) {
        throw new WorkspaceServerError(`runtime_backend_session_conflict:${current.id}`, 409);
      }
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
             error_code = $7, completed_at = $8,
             backend_session_id = COALESCE(backend_session_id, $11)
         WHERE workspace_id = $1 AND id = $2 AND status = $9 AND phase = $10
         RETURNING *`,
        [this.workspaceId, current.id, finalStatus, finalPhase, outputMessage?.id ?? null, outputSummary ?? null, errorCode ?? null, finalStatus === "waiting_for_backend_input" || finalStatus === "outcome_unknown" ? null : now, current.status, currentPhase, terminal.backend_session_id ?? null]
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

  private async resolveAgent(roomId: string, requestedAgentId?: string): Promise<RuntimeAgent> {
    return this.database.withContext(this.context(), async (sql) => {
      await this.assertRoomCanExecute(sql, roomId);
      const roomResult = await sql.query<RuntimeRoomDefaultAgentRow>(
        `SELECT default_agent_id, default_agent_version
         FROM rooms
         WHERE workspace_id = $1 AND id = $2`,
        [this.workspaceId, roomId]
      );
      const room = roomResult.rows[0];
      if (!room) throw new WorkspaceServerError("runtime_room_not_found", 404);
      const explicitAgentId = requestedAgentId?.trim() || undefined;
      const selectedAgentId = explicitAgentId ?? (room.default_agent_id?.trim() || undefined);
      if (!selectedAgentId) {
        // An existing Room may remain readable while an administrator has not
        // selected its default Agent yet.  Never turn that migration state
        // into "first Agent wins" or an unrelated backend fallback.
        throw new WorkspaceServerError("runtime_room_default_agent_missing", 409);
      }
      if (!explicitAgentId && room.default_agent_version === null) {
        throw new WorkspaceServerError("runtime_room_default_agent_version_missing", 409);
      }
      const result = await sql.query<RuntimeAgentRow>(
        `SELECT agent.id, agent.display_name, agent.role,
                agent.instructions, agent.enabled, agent.backend_id, agent.status,
                agent.version AS configuration_version
         FROM workspace_agents agent
         JOIN workspace_agent_room_permissions permission
           ON permission.workspace_id = agent.workspace_id AND permission.agent_id = agent.id
         WHERE agent.workspace_id = $1 AND permission.room_id = $2
           AND permission.can_execute = TRUE
           AND agent.status = 'active'
           AND agent.enabled = TRUE
           AND agent.id = $3
         LIMIT 1`,
        [this.workspaceId, roomId, selectedAgentId]
      );
      const row = result.rows[0];
      if (!row) {
        throw new WorkspaceServerError(
          explicitAgentId ? "runtime_agent_not_authorized_for_room" : "runtime_room_default_agent_unavailable",
          explicitAgentId ? 403 : 409
        );
      }
      const configurationVersion = Number(row.configuration_version);
      if (!Number.isSafeInteger(configurationVersion) || configurationVersion < 1) {
        throw new WorkspaceServerError("runtime_agent_configuration_version_invalid", 500);
      }
      if (!explicitAgentId && room.default_agent_version !== null
        && configurationVersion !== Number(room.default_agent_version)) {
        throw new WorkspaceServerError("runtime_room_default_agent_version_conflict", 409);
      }
      const instructions = row.instructions?.trim();
      const role = row.role?.trim();
      if (!instructions || !role) throw new WorkspaceServerError("runtime_agent_profile_incomplete", 409);
      return {
        id: row.id,
        name: row.display_name,
        role,
        instructions,
        backendId: row.backend_id,
        configurationVersion,
        enabled: row.enabled === true
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
        created_at: isoTimestamp(row.created_at)
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

  private async updateContinuationState(admission: RuntimeAdmission, state: RuntimeContinuationState): Promise<void> {
    const updated = await this.database.withContext(this.context(), async (sql) => {
      const result = await sql.query<RuntimeRunRow>(
        `UPDATE workspace_runtime_runs
         SET metadata = jsonb_set(COALESCE(metadata, '{}'::JSONB), '{runtime_continuation}', $3::JSONB, TRUE)
         WHERE workspace_id = $1 AND id = $2
         RETURNING *`,
        [this.workspaceId, admission.run.id, jsonText(state)]
      );
      return result.rows[0];
    });
    if (!updated) throw new WorkspaceServerError(`runtime_continuation_state_update_failed:${admission.run.id}`, 500);
    admission.run = runFromRow(updated);
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
      toolRuns: deriveToolRuns(session.id, backendEvents)
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
    const fallbackErrorCode = terminalEvidence.kind === "failed" ? terminalEvidence.error.code : "runtime_backend_failure";
    const errorCode = error instanceof WorkspaceServerError ? error.code : fallbackErrorCode;
    const normalizedTerminalEvidence = terminalEvidence.kind === "failed"
      ? { ...terminalEvidence, error: { ...terminalEvidence.error, code: errorCode, message: summarize(terminalEvidence.error.message, 240) } }
      : terminalEvidence;
    const event = bridge.project({
      event_type: normalizedTerminalEvidence.kind === "completed" ? "run_completed" : "run_failed",
      payload: {
        error_code: errorCode,
        message: summarize(message, 240),
        reason: "runtime",
        retryable: false,
        cause_category: "runtime"
      },
      terminal_evidence: normalizedTerminalEvidence
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
    const resourceRefs = uniqueResourceRefs([
      ...(operation?.result_ref ? [operation.result_ref] : []),
      ...result.workspaceChanges
        .filter((change) => change.run_id === result.backendRun.id)
        .map((change) => change.resource_ref)
    ]);
    const completion = {
      session: result.session,
      run: result.backendRun,
      ...(operation ? { operation } : {}),
      instructionSummary,
      ...(result.backendRun.output_summary ? { resultSummary: result.backendRun.output_summary } : {}),
      ...(resourceRefs.length > 0 ? { resourceRefs } : {})
    } satisfies PostgresRuntimeChatCompletionEvent;
    // A Runtime result may be reported as successful only after its required
    // Completion evidence is durable. When no independently configured
    // maintenance identity is available, swallowing a projection failure
    // would leave a settled Run with no recoverable Activity. The caller gets
    // a retryable failure and can safely repeat the same idempotent request;
    // configured maintenance workers additionally reconcile after a restart.
    await this.onCompletionActivity(completion);
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
          metadata: commandInput.metadata,
          ...(input.executionBinding ? { executionBinding: input.executionBinding } : {}),
          ...(input.resumeBackendContinuation ? { resumeBackendContinuation: input.resumeBackendContinuation } : {}),
          ...(input.signal ? { signal: input.signal } : {})
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

  listBackendEvents(input: string | { runId: string; afterSequence?: number; limit?: number }) {
    return this.chat.listBackendEvents(input);
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

  /**
   * Public transports must use this named Run Control boundary instead of
   * selecting one mutable Runtime method themselves.  The specialized
   * application service owns validation and replay semantics; this façade
   * owns the PostgreSQL-backed action dispatch.
   */
  executeRunControlAction(input: {
    action: PostgresRuntimeRunControlAction;
    runId: string;
    resumeInput: Record<string, JsonValue>;
    idempotencyKey: string;
    confirmUnknown?: boolean;
  }): Promise<PostgresRuntimeRunControlResult> {
    if (input.action === "cancel") return this.cancelBackendRun(input.runId);
    if (input.action === "resume") return this.resumeBackendRun(input.runId, input.resumeInput);
    if (input.action === "sync") return this.syncBackendRun(input.runId);
    if (input.action === "recover") return this.recoverBackendRun(input.runId);
    return this.retryBackendRun(input.runId, {
      idempotencyKey: input.idempotencyKey,
      ...(input.confirmUnknown === true ? { confirmUnknown: true } : {})
    });
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
  created_at: Date | string;
}

function runtimeOperationId(runId: string): string {
  return `operation:${runId}`;
}

function runtimeToolOperationId(runId: string, toolCallId: string): string {
  return `operation:${runId}:tool:${stableHash(toolCallId).slice(0, 40)}`;
}

/** Resolve the provider identity and the Domain operation as one immutable
 * pair. Supplying a valid operation alongside an unrelated provider name is
 * still rejected; downstream ingress must see the same capability identity. */
function runtimeExecutableToolSpec(
  providerToolName: string | undefined,
  actionId: string | undefined
): RuntimeExecutableToolSpec | undefined {
  const providerMatch = providerToolName === undefined
    ? undefined
    : runtimeExecutableToolSpecs.find((spec) => spec.providerToolNames.includes(providerToolName));
  const actionMatch = actionId === undefined
    ? undefined
    : runtimeExecutableToolSpecs.find((spec) => spec.operation === actionId);
  if ((providerToolName !== undefined && !providerMatch) || (actionId !== undefined && !actionMatch)) return undefined;
  if (!providerMatch && !actionMatch) return undefined;
  if (providerMatch && actionMatch && providerMatch.operation !== actionMatch.operation) return undefined;
  return providerMatch ?? actionMatch;
}

function runtimeToolChangeId(runId: string, operationId: string, resourceId: string): string {
  return `change:${stableHash({ runId, operationId, resourceId }).slice(0, 48)}`;
}

function buildToolOperation(input: {
  id: string;
  run: BackendRunRecord;
  inputHash: string;
  inputMessageId: string;
  operation?: string;
  capabilityId?: string;
  proposedEffect?: string;
  now: string;
}): OperationRecord {
  return OperationRecordSchema.parse({
    id: input.id,
    ...(input.run.session_id ? { session_id: input.run.session_id } : {}),
    run_id: input.run.id,
    capability_id: input.capabilityId ?? "artifact.create",
    operation: input.operation ?? "artifact.create",
    actor_identity: actorIdentityForSource(input.run.source),
    ...(principalParticipantId(input.run.principal) ? { participant_id: principalParticipantId(input.run.principal) } : {}),
    ...(input.run.principal ? { participant_kind: input.run.principal.kind, principal: input.run.principal } : {}),
    ...(input.run.requested_by_participant_id ? { requested_by_participant_id: input.run.requested_by_participant_id } : {}),
    ...(input.run.room_id ? { room_id: input.run.room_id } : {}),
    ...(input.run.source ? { source: input.run.source } : {}),
    ...(input.run.session_ref ? { session_ref: input.run.session_ref } : {}),
    instruction_source: "tool_output",
    instruction_authority: "room_execute",
    channel: channelForSource(input.run.source),
    input_hash: input.inputHash,
    input_ref: messageResourceRef(input.inputMessageId),
    target_resource_refs: [],
    proposed_effects: [input.proposedEffect ?? "Create a local workspace artifact draft."],
    status: "created",
    correlation_id: `${input.run.id}:${input.id}`,
    created_at: input.now,
    updated_at: input.now
  });
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

function buildSessionCreateOperation(input: {
  id: string;
  correlationId: string;
  session: SessionRecord;
  inputHash: string;
  now: string;
  principal?: PostgresRuntimeChatOptions["principal"];
  source?: PostgresRuntimeChatOptions["source"];
}): OperationRecord {
  const sessionRef = { kind: "session", id: input.session.id, uri: `runtime://sessions/${input.session.id}` };
  return OperationRecordSchema.parse({
    id: input.id,
    session_id: input.session.id,
    capability_id: "runtime.chat",
    operation: "runtime.chat.session.create",
    actor_identity: actorIdentityForSource(input.source),
    ...(principalParticipantId(input.principal) ? { participant_id: principalParticipantId(input.principal) } : {}),
    ...(input.principal ? { participant_kind: input.principal.kind, principal: input.principal } : {}),
    ...(input.session.room_id ? { room_id: input.session.room_id } : {}),
    ...(input.source ? { source: input.source } : {}),
    instruction_source: instructionSourceFor(input.source, input.principal),
    instruction_authority: "room_execute",
    channel: channelForSource(input.source),
    input_hash: input.inputHash,
    target_resource_refs: [sessionRef],
    proposed_effects: ["runtime.chat.session.create"],
    status: "completed",
    result_ref: sessionRef,
    correlation_id: input.correlationId,
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

function actorIdentityForSource(source: PostgresRuntimeChatOptions["source"]): MessageEnvelope["actor_identity"] {
  if (source?.kind === "external_app") return "external_app";
  if (source?.kind === "host") return "owner_scheduled";
  return "owner";
}

function channelForSource(source: PostgresRuntimeChatOptions["source"]): MessageEnvelope["source"] {
  if (source?.kind === "external_app") return "webhook";
  if (source?.kind === "host") return "cron";
  return "web";
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
    created_at: isoTimestamp(row.created_at),
    updated_at: isoTimestamp(row.updated_at)
  });
}

function isoTimestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function operationFromRow(row: RuntimeOperationRow): OperationRecord {
  const payload = jsonValue(row.payload);
  const operation = isLegacySessionCreatePayload(row, payload)
    ? legacySessionCreateOperationFromRow(row, payload)
    : OperationRecordSchema.parse(payload);
  if (operation.id !== row.id || operation.operation !== row.operation || operation.status !== row.status) {
    throw new WorkspaceServerError(`runtime_operation_projection_mismatch:${row.id}`, 500);
  }
  return operation;
}

function isLegacySessionCreatePayload(row: RuntimeOperationRow, payload: JsonValue): payload is Record<string, JsonValue> {
  if (row.operation !== "runtime.chat.session.create" || !row.session_id || !payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const record = payload as Record<string, JsonValue>;
  return record.session_id === row.session_id
    && typeof record.input_hash === "string"
    && Object.keys(record).every((key) => key === "input_hash" || key === "session_id");
}

function legacySessionCreateOperationFromRow(row: RuntimeOperationRow, payload: Record<string, JsonValue>): OperationRecord {
  const sessionId = row.session_id;
  if (!sessionId || typeof payload.input_hash !== "string") throw new WorkspaceServerError(`runtime_session_operation_invalid:${row.id}`, 500);
  const sessionRef = { kind: "session", id: sessionId, uri: `runtime://sessions/${sessionId}` };
  return OperationRecordSchema.parse({
    id: row.id,
    session_id: sessionId,
    ...(row.room_id ? { room_id: row.room_id } : {}),
    capability_id: "runtime.chat",
    operation: row.operation,
    actor_identity: "owner",
    instruction_source: "owner_instruction",
    instruction_authority: "room_execute",
    channel: "web",
    input_hash: payload.input_hash,
    target_resource_refs: [sessionRef],
    proposed_effects: ["runtime.chat.session.create"],
    status: row.status,
    result_ref: sessionRef,
    correlation_id: row.id,
    created_at: isoTimestamp(row.created_at),
    updated_at: isoTimestamp(row.updated_at)
  });
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
    created_at: isoTimestamp(row.created_at)
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
    started_at: isoTimestamp(row.started_at),
    ...(row.completed_at ? { completed_at: isoTimestamp(row.completed_at) } : {}),
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
    created_at: isoTimestamp(row.created_at)
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

/**
 * Tool calls are part of the durable Runtime event journal in PostgreSQL.
 * The old local Store had a separate tool_runs table; projecting the same
 * read model from the two canonical tool events keeps transcript and resume
 * consumers compatible without introducing a second PostgreSQL source of
 * truth.
 */
function deriveToolRuns(sessionId: string, events: BackendEventRecord[]): ToolRunRecord[] {
  const starts = new Map<string, BackendEventRecord>();
  const runs: ToolRunRecord[] = [];
  for (const event of [...events].sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id))) {
    const toolCallId = stringPayload(event.payload.tool_call_id);
    if (!toolCallId) continue;
    if (event.event_type === "tool_call_started") {
      starts.set(toolCallId, event);
      continue;
    }
    if (event.event_type !== "tool_call_output") continue;
    const start = starts.get(toolCallId);
    const providerToolName = stringPayload(event.payload.provider_tool_name)
      ?? stringPayload(start?.payload.provider_tool_name)
      ?? stringPayload(event.payload.action_id)
      ?? stringPayload(start?.payload.action_id)
      ?? "unknown_tool";
    const actionId = stringPayload(event.payload.action_id) ?? stringPayload(start?.payload.action_id);
    const status = toolRunStatus(event.payload);
    const output = firstPayloadValue(event.payload, ["output_summary", "summary", "text", "output", "result", "error"]);
    const input = firstPayloadValue(start?.payload, ["input", "arguments"]);
    const record = ToolRunRecordSchema.parse({
      id: `tool:${event.run_id}:${toolCallId}`,
      run_id: event.run_id,
      session_id: sessionId,
      tool_call_id: toolCallId,
      provider_tool_name: providerToolName,
      ...(actionId ? { action_id: actionId } : {}),
      status,
      input_summary: summarizePayload(input),
      output_summary: summarizePayload(output),
      ...(status === "failed" && stringPayload(event.payload.error_code) ? { error_code: stringPayload(event.payload.error_code) } : {}),
      resource_refs: event.resource_refs,
      created_at: start?.created_at ?? event.created_at
    });
    runs.push(record);
  }
  return runs;
}

function toolRunStatus(payload: Record<string, JsonValue>): ToolRunRecord["status"] {
  const explicit = stringPayload(payload.status)?.toLowerCase();
  if (explicit === "ignored" || explicit === "skipped") return "ignored";
  if (explicit === "failed" || explicit === "error" || payload.ok === false || payload.error !== undefined) return "failed";
  return "completed";
}

function firstPayloadValue(payload: Record<string, JsonValue> | undefined, keys: string[]): JsonValue | undefined {
  if (!payload) return undefined;
  for (const key of keys) if (payload[key] !== undefined) return payload[key];
  return undefined;
}

function stringPayload(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function toolErrorCode(error: unknown): string {
  return error instanceof WorkspaceServerError ? error.code : "runtime_tool_execution_failed";
}

function toolErrorSummary(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return summarize(message, 2_000);
}

function uniqueResourceRefs(refs: ResourceRef[]): ResourceRef[] {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = `${ref.kind}:${ref.id}:${ref.version ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const delegationAuthorityArgumentKeys = new Set([
  "workspace", "room", "work", "assignee", "assignment", "run", "parent", "parent_run", "parentrun",
  "parent_assignment", "parentassignment", "actor", "requester", "principal", "authority",
  "workspace_id", "workspaceid",
  "room_id", "roomid",
  "work_id", "workid",
  "assignee_id", "assigneeid",
  "parent_assignee_id", "parentassigneeid",
  "parent_assignment_id", "parentassignmentid",
  "parent_work_id", "parentworkid",
  "run_id", "runid",
  "parent_run_id", "parentrunid",
  "actor_id", "actorid",
  "account_id", "accountid",
  "participant_id", "participantid",
  "requester_id", "requesterid",
  "requested_by_participant_id", "requestedbyparticipantid",
  "generation", "expected_generation", "expectedgeneration",
  "control_generation", "controlgeneration",
  "expected_version", "expectedversion",
  "runtime_binding", "runtimebinding", "execution_binding", "executionbinding"
]);

function sanitizeDelegationArguments(value: Record<string, JsonValue>): Record<string, JsonValue> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => {
    const normalized = key.replace(/[-\s]/g, "_").toLowerCase();
    return !delegationAuthorityArgumentKeys.has(normalized) && !delegationAuthorityArgumentKeys.has(normalized.replace(/_/g, ""));
  }));
}

function sanitizeDelegationToolEvent(event: PostgresRuntimeToolCallEvent): PostgresRuntimeToolCallEvent {
  const argumentsValue = sanitizeDelegationArguments(event.arguments);
  const payload = sanitizeDelegationArguments(event.payload);
  return {
    ...event,
    arguments: argumentsValue,
    payload: {
      ...payload,
      arguments: argumentsValue
    }
  };
}

function summarizePayload(value: JsonValue | undefined): string {
  if (value === undefined) return "";
  if (typeof value === "string") return summarize(value, 2_000);
  try { return summarize(JSON.stringify(value), 2_000); } catch { return "[unserializable]"; }
}

function buildRuntimeExecutionBinding(input: {
  workspaceId: string;
  roomId: string;
  sessionId: string;
  agent: RuntimeAgent;
  input?: PostgresRuntimeExecutionBinding;
}): RuntimeExecutionBinding {
  const workId = input.input?.workId?.trim() || undefined;
  const assigneeId = input.input?.assigneeId?.trim() || undefined;
  const parentAssigneeId = input.input?.parentAssigneeId?.trim() || undefined;
  const reservationId = input.input?.reservationId?.trim() || undefined;
  const leaseOwner = input.input?.leaseOwner?.trim() || undefined;
  const hasWorkBinding = workId !== undefined || assigneeId !== undefined;
  if ((input.input?.workId !== undefined && !workId)
    || (input.input?.assigneeId !== undefined && !assigneeId)
    || (input.input?.parentAssigneeId !== undefined && !parentAssigneeId)
    || (input.input?.reservationId !== undefined && !reservationId)
    || (input.input?.leaseOwner !== undefined && !leaseOwner)) {
    throw new WorkspaceServerError("runtime_execution_binding_incomplete", 400);
  }
  const generationValue = input.input?.generation ?? (hasWorkBinding ? undefined : 1);
  // Human Work starts at control_generation=0.  Zero is a real initial
  // generation; only a missing, negative, fractional, or unsafe value is
  // invalid here.
  if (generationValue === undefined || !Number.isSafeInteger(generationValue) || generationValue < 0) {
    throw new WorkspaceServerError("runtime_execution_generation_invalid", 400);
  }
  const agentConfigurationVersionValue = input.input?.agentConfigurationVersion
    ?? (hasWorkBinding ? undefined : input.agent.configurationVersion);
  if (agentConfigurationVersionValue === undefined
    || !Number.isSafeInteger(agentConfigurationVersionValue)
    || agentConfigurationVersionValue < 1) {
    throw new WorkspaceServerError("runtime_agent_configuration_version_invalid", 400);
  }
  const generation = generationValue;
  const agentConfigurationVersion = agentConfigurationVersionValue;
  if (agentConfigurationVersion !== input.agent.configurationVersion) {
    throw new WorkspaceServerError("runtime_agent_configuration_version_conflict", 409);
  }
  if ((workId && !assigneeId) || (!workId && assigneeId)) {
    throw new WorkspaceServerError("runtime_execution_binding_incomplete", 400);
  }
  if (parentAssigneeId && !workId) {
    throw new WorkspaceServerError("runtime_execution_binding_incomplete", 400);
  }
  if ((reservationId && !leaseOwner) || (!reservationId && leaseOwner) || ((reservationId || leaseOwner) && !hasWorkBinding)) {
    throw new WorkspaceServerError("runtime_execution_binding_incomplete", 400);
  }
  return {
    workspaceId: input.workspaceId,
    roomId: input.roomId,
    sessionId: input.sessionId,
    ...(workId ? { workId } : {}),
    ...(assigneeId ? { assigneeId } : {}),
    ...(parentAssigneeId ? { parentAssigneeId } : {}),
    ...(reservationId ? { reservationId } : {}),
    ...(leaseOwner ? { leaseOwner } : {}),
    agentId: input.agent.id,
    agentConfigurationVersion,
    backendId: input.agent.backendId,
    generation,
    agent: {
      name: input.agent.name,
      role: input.agent.role,
      instructions: input.agent.instructions,
      enabled: input.agent.enabled
    }
  };
}

function runtimeBackendSessionKey(binding: RuntimeExecutionBinding): string {
  // A provider-native Session is an execution detail.  The stable key is
  // derived from the full Samurai binding so a different Room, work,
  // assignee, Backend, or generation can never reuse it accidentally.
  return `samurai-runtime:${stableHash({
    workspace_id: binding.workspaceId,
    room_id: binding.roomId,
    session_id: binding.sessionId,
    work_id: binding.workId ?? null,
    assignee_id: binding.assigneeId ?? null,
    parent_assignee_id: binding.parentAssigneeId ?? null,
    agent_id: binding.agentId,
    backend_id: binding.backendId,
    generation: binding.generation
  })}`;
}

function runtimeExecutionContext(
  binding: RuntimeExecutionBinding,
  backend: Pick<AgentBackend, "kind">,
  continuationState?: RuntimeContinuationState
): RuntimeBackendExecutionContext | undefined {
  // BackendRunAssociation deliberately requires a concrete work and
  // assignee.  Legacy Session callers do not have that association, so they
  // keep the old input shape; Room-work launches always provide both IDs.
  if (!binding.workId || !binding.assigneeId) return undefined;
  const isNative = backend.kind === "samurai_native";
  return {
    agent: {
      id: binding.agentId,
      name: binding.agent.name,
      role: binding.agent.role,
      instructions: binding.agent.instructions,
      enabled: binding.agent.enabled,
      backend_id: binding.backendId,
      config_version: String(binding.agentConfigurationVersion)
    },
    association: {
      workspace_id: binding.workspaceId,
      room_id: binding.roomId,
      work_id: binding.workId,
      assignee_id: binding.assigneeId,
      backend_id: binding.backendId,
      generation: binding.generation
    },
    credential_boundary: isNative ? "provider_api" : "external_cli",
    continuity: isNative ? "samurai_context" : "external_session",
    ...(continuationState ? { continuity_state: continuationState } : {})
  };
}

function runtimeBindingMetadata(binding: RuntimeExecutionBinding): Record<string, JsonValue> {
  return {
    workspace_id: binding.workspaceId,
    room_id: binding.roomId,
    session_id: binding.sessionId,
    ...(binding.workId ? { work_id: binding.workId } : {}),
    ...(binding.assigneeId ? { assignee_id: binding.assigneeId } : {}),
    ...(binding.parentAssigneeId ? { parent_assignee_id: binding.parentAssigneeId } : {}),
    ...(binding.reservationId ? { reservation_id: binding.reservationId } : {}),
    ...(binding.leaseOwner ? { lease_owner: binding.leaseOwner } : {}),
    agent_id: binding.agentId,
    agent_configuration_version: binding.agentConfigurationVersion,
    backend_id: binding.backendId,
    generation: binding.generation,
    agent: {
      name: binding.agent.name,
      role: binding.agent.role,
      instructions: binding.agent.instructions,
      enabled: binding.agent.enabled,
      backend_id: binding.backendId,
      config_version: String(binding.agentConfigurationVersion)
    }
  };
}

function runtimeBindingHashMetadata(binding: RuntimeExecutionBinding): Record<string, JsonValue> {
  // The claim token is persisted as reconciliation/audit metadata, but it is
  // intentionally excluded from request identity. A recovered lease owner
  // must be able to replay the same logical request without an idempotency
  // conflict caused only by the worker hand-off.
  const metadata = runtimeBindingMetadata(binding);
  delete metadata.reservation_id;
  delete metadata.lease_owner;
  return metadata;
}

function runtimeMetadataForBackend(metadata: Record<string, JsonValue>): Record<string, JsonValue> {
  // `runtime_binding` is persisted for reconciliation, but it is a typed
  // host association rather than provider/user metadata.  Keep it out of the
  // generic Backend payload; controls receive it through execution_context.
  const { runtime_binding: _runtimeBinding, runtime_continuation: _runtimeContinuation, ...safeMetadata } = metadata;
  return safeMetadata;
}

function runtimeContinuationFromRunMetadata(metadata: Record<string, JsonValue>): RuntimeContinuationState | undefined {
  const value = metadata.runtime_continuation;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, JsonValue>;
  const mode = record.mode;
  const source = record.source;
  if (mode !== "resumed" && mode !== "reconstructed") return undefined;
  if (source !== "external_session" && source !== "samurai_context") return undefined;
  const reason = record.reason;
  if (reason !== undefined
    && reason !== "candidate_missing"
    && reason !== "candidate_invalid"
    && reason !== "candidate_mismatch"
    && reason !== "native_backend"
    && reason !== "resume_unsupported"
    && reason !== "resume_failed") return undefined;
  return {
    mode,
    source,
    ...(reason ? { reason } : {})
  };
}

function runtimeAgentFromBinding(binding: RuntimeExecutionBinding): RuntimeAgent {
  return {
    id: binding.agentId,
    name: binding.agent.name,
    role: binding.agent.role,
    instructions: binding.agent.instructions,
    backendId: binding.backendId,
    configurationVersion: binding.agentConfigurationVersion,
    enabled: binding.agent.enabled
  };
}

function runtimeBindingFromRunMetadata(
  metadata: Record<string, JsonValue>,
  fallback: {
    workspaceId: string;
    roomId: string;
    sessionId: string;
    agent?: RuntimeAgent;
    agentId?: string;
    parentAssigneeId?: string;
    backendId: string;
  }
): RuntimeExecutionBinding | undefined {
  const binding = metadata.runtime_binding;
  if (binding !== undefined) {
    if (typeof binding !== "object" || Array.isArray(binding)) {
      throw new WorkspaceServerError("runtime_run_binding_invalid", 409);
    }
    const record = binding as Record<string, JsonValue>;
    const agent = record.agent;
    const agentRecord = agent && typeof agent === "object" && !Array.isArray(agent) ? agent as Record<string, JsonValue> : undefined;
    const nestedBackendId = stringPayload(agentRecord?.backend_id);
    const nestedConfigurationVersion = numberPayload(agentRecord?.config_version);
    const workspaceId = stringPayload(record.workspaceId ?? record.workspace_id);
    const roomId = stringPayload(record.roomId ?? record.room_id);
    const sessionId = stringPayload(record.sessionId ?? record.session_id);
    const agentId = stringPayload(record.agentId ?? record.agent_id);
    const backendId = stringPayload(record.backendId ?? record.backend_id) ?? stringPayload(agentRecord?.backend_id);
    const workId = stringPayload(record.workId ?? record.work_id);
    const assigneeId = stringPayload(record.assigneeId ?? record.assignee_id);
    const parentAssigneeId = stringPayload(record.parentAssigneeId ?? record.parent_assignee_id);
    const generation = numberPayload(record.generation);
    const agentConfigurationVersion = numberPayload(record.agentConfigurationVersion ?? record.agent_configuration_version)
      ?? numberPayload(agentRecord?.config_version);
    const name = stringPayload(agentRecord?.name) ?? fallback.agent?.name;
    const role = stringPayload(agentRecord?.role) ?? fallback.agent?.role;
    const instructions = stringPayload(agentRecord?.instructions) ?? fallback.agent?.instructions;
    const enabled = agentRecord?.enabled === undefined
      ? fallback.agent?.enabled === true
      : agentRecord.enabled === true;
    if (((record.workId !== undefined || record.work_id !== undefined) && !workId)
      || ((record.assigneeId !== undefined || record.assignee_id !== undefined) && !assigneeId)
      || ((record.parentAssigneeId !== undefined || record.parent_assignee_id !== undefined) && !parentAssigneeId)
      || (agent !== undefined && agent !== null && !agentRecord)
      || (agentRecord?.backend_id !== undefined && agentRecord.backend_id !== null
        && stringPayload(agentRecord.backend_id) === undefined)
      || (agentRecord?.config_version !== undefined && agentRecord.config_version !== null
        && numberPayload(agentRecord.config_version) === undefined)
      || !workspaceId || !roomId || !sessionId || !agentId || !backendId || generation === undefined || !agentConfigurationVersion || !name || !role || !instructions
      || (workId && !assigneeId) || (!workId && assigneeId)
      || (parentAssigneeId && (!workId || !assigneeId))
      || (nestedBackendId !== undefined && nestedBackendId !== backendId)
      || (nestedConfigurationVersion !== undefined && nestedConfigurationVersion !== agentConfigurationVersion)) {
      throw new WorkspaceServerError("runtime_run_binding_invalid", 409);
    }
    if (workspaceId !== fallback.workspaceId || roomId !== fallback.roomId || sessionId !== fallback.sessionId
      || (fallback.agentId && agentId !== fallback.agentId)
      || (fallback.parentAssigneeId && parentAssigneeId !== fallback.parentAssigneeId)
      || backendId !== fallback.backendId) {
      throw new WorkspaceServerError("runtime_run_binding_mismatch", 409);
    }
    return {
      workspaceId,
      roomId,
      sessionId,
      ...(workId ? { workId } : {}),
      ...(assigneeId ? { assigneeId } : {}),
      ...(parentAssigneeId ? { parentAssigneeId } : {}),
      agentId,
      agentConfigurationVersion,
      backendId,
      generation,
      agent: { name, role, instructions, enabled }
    };
  }
  if (!fallback.agent || !fallback.agentId) return undefined;
  return {
    workspaceId: fallback.workspaceId,
    roomId: fallback.roomId,
    sessionId: fallback.sessionId,
    agentId: fallback.agentId,
    ...(fallback.parentAssigneeId ? { parentAssigneeId: fallback.parentAssigneeId } : {}),
    agentConfigurationVersion: fallback.agent.configurationVersion,
    backendId: fallback.backendId,
    generation: 1,
    agent: {
      name: fallback.agent.name,
      role: fallback.agent.role,
      instructions: fallback.agent.instructions,
      enabled: fallback.agent.enabled
    }
  };
}

/**
 * Resolve a provider-native continuation only from a Store-created candidate.
 * A provider Session ID is intentionally useless by itself: every immutable
 * parent/child association must still match the current Room Work binding.
 * Missing, malformed, stale, or unsupported candidates simply select the
 * normal `runTurn` path, which starts a new external session safely.
 */
function resolveRoomWorkExternalContinuation(input: {
  candidate?: PostgresRuntimeExternalContinuation;
  binding: RuntimeExecutionBinding;
  backend: Pick<AgentBackend, "id" | "kind" | "resumeRun">;
  workspaceId: string;
  roomId: string;
  sessionId: string;
}): RuntimeContinuationDecision | undefined {
  if (!input.binding.workId || !input.binding.assigneeId || !input.binding.parentAssigneeId) return undefined;
  if (input.backend.kind === "samurai_native") {
    return {
      state: { mode: "reconstructed", source: "samurai_context", reason: "native_backend" }
    };
  }
  if (typeof input.backend.resumeRun !== "function") {
    return {
      state: { mode: "reconstructed", source: "samurai_context", reason: "resume_unsupported" }
    };
  }
  const candidate = input.candidate;
  if (!candidate || typeof candidate !== "object") {
    return {
      state: { mode: "reconstructed", source: "samurai_context", reason: "candidate_missing" }
    };
  }
  const backendSessionId = typeof candidate.backendSessionId === "string" ? candidate.backendSessionId.trim() : "";
  const parent = candidate.parent;
  if (!backendSessionId || !parent || typeof parent !== "object") {
    return {
      state: { mode: "reconstructed", source: "samurai_context", reason: "candidate_invalid" }
    };
  }
  if (parent.workspaceId !== input.workspaceId
    || parent.roomId !== input.roomId
    || parent.sessionId !== input.sessionId
    || parent.workId !== input.binding.workId
    || parent.assigneeId !== input.binding.parentAssigneeId
    || parent.agentId !== input.binding.agentId
    || parent.agentConfigurationVersion !== input.binding.agentConfigurationVersion
    || parent.backendId !== input.binding.backendId
    || parent.generation !== input.binding.generation
    || input.backend.id !== input.binding.backendId) {
    return {
      state: { mode: "reconstructed", source: "samurai_context", reason: "candidate_mismatch" }
    };
  }
  if (!Number.isSafeInteger(parent.agentConfigurationVersion) || parent.agentConfigurationVersion < 1
    || !Number.isSafeInteger(parent.generation) || parent.generation < 0) {
    return {
      state: { mode: "reconstructed", source: "samurai_context", reason: "candidate_invalid" }
    };
  }
  return {
    backendSessionId,
    state: { mode: "resumed", source: "external_session" }
  };
}

function numberPayload(value: JsonValue | undefined): number | undefined {
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function isSettled(run: BackendRunRecord): boolean {
  return run.phase === "settled" || run.status === "completed" || run.status === "failed" || run.status === "cancelled" || run.status === "outcome_unknown";
}

function markChatReplay(result: RunChatTurnResult): RunChatTurnResult {
  // Replay is transport metadata, not a second field in the persisted Chat
  // result contract. Keep it non-enumerable so legacy JSON consumers retain
  // their exact shape while the v1 adapter can report the envelope flag.
  Object.defineProperty(result, "replayed", { value: true, enumerable: false });
  return result;
}

function isTerminalRunState(status: string, phase: string | null): boolean {
  return phase === "settled" || status === "completed" || status === "failed" || status === "cancelled" || status === "outcome_unknown";
}

function isTerminalEventType(eventType: string): boolean {
  return eventType === "run_completed" || eventType === "run_failed";
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
