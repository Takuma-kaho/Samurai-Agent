import Database from "better-sqlite3";
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type ActivityInboxItem,
  type ApprovalRequest,
  type ArtifactRecord,
  type AuditRecord,
  type BackendEventRecord,
  type BackendRunRecord,
  CollectionRecordSchema,
  CollectionSchemaSchema,
  type CollectionPatch,
  type CollectionRecord,
  type CollectionSchema,
  type GrantRecord,
  type JsonValue,
  type MemoryFrontmatter,
  type MessageRecord,
  type OperationRecord,
  type PolicyDecisionRecord,
  type RollbackPoint,
  type SessionRecord,
  type SettingsRecord,
  SkillFrontmatterSchema,
  type SkillFrontmatter,
  WikiFrontmatterSchema,
  type WikiFrontmatter,
  type WorkspaceChangeRecord,
  defaultSettings,
  nowIso
} from "@samurai-agent/core-schemas";
import { Kysely, SqliteDialect, sql } from "kysely";

type JsonColumn = string;

interface SessionsTable {
  id: string;
  session_key: string;
  title: string;
  ui_locale: string;
  output_locale: string;
  created_at: string;
  updated_at: string;
}

interface MessagesTable {
  id: string;
  session_id: string;
  role: "user" | "agent" | "system";
  content: string;
  input_locale: string;
  output_locale: string;
  envelope_json: JsonColumn | null;
  created_at: string;
}

interface OperationsTable {
  id: string;
  session_id: string;
  capability_id: string;
  operation: string;
  actor_identity: string;
  instruction_source: string;
  instruction_authority: string;
  channel: string;
  input_hash: string;
  input_ref_json: JsonColumn | null;
  target_resource_refs_json: JsonColumn;
  proposed_effects_json: JsonColumn;
  status: string;
  policy_decision_id: string | null;
  approval_request_id: string | null;
  result_ref_json: JsonColumn | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

interface PolicyDecisionsTable {
  id: string;
  operation_id: string;
  capability_id: string;
  operation: string;
  decision: string;
  reason: string;
  policy_inputs_json: JsonColumn;
  matched_rules_json: JsonColumn;
  required_approval_level: string;
  grant_id: string | null;
  created_at: string;
}

interface ApprovalRequestsTable {
  id: string;
  operation_id: string;
  requested_level: string;
  status: string;
  reason: string;
  requested_by: string;
  decided_by: string | null;
  created_at: string;
  expires_at: string;
  decided_at: string | null;
}

interface AuditRecordsTable {
  id: string;
  actor_identity: string;
  operation_id: string;
  capability_id: string;
  instruction_source: string;
  inputs_summary: string;
  outputs_summary: string;
  policy_decision_id: string;
  affected_resources_json: JsonColumn;
  rollback_point_id: string | null;
  created_at: string;
}

interface RollbackPointsTable {
  id: string;
  operation_id: string;
  affected_resources_json: JsonColumn;
  before_snapshot_json: JsonColumn;
  after_snapshot_json: JsonColumn;
  reversible: number;
  irreversible_effects_json: JsonColumn;
  created_at: string;
  expires_at: string;
}

interface ArtifactsTable {
  id: string;
  title: string;
  kind: string;
  locale: string;
  source_locales_json: JsonColumn;
  file_ref_json: JsonColumn;
  metadata_json: JsonColumn;
  source_operation_id: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

interface MemoryIndexTable {
  id: string;
  state: string;
  topic: string;
  source: string;
  source_locale: string;
  content_locale: string;
  source_kind: string;
  instruction_authority: string;
  file_path: string;
  frontmatter_json: JsonColumn;
  created_at: string;
  updated_at: string;
}

interface SkillIndexTable {
  id: string;
  state: string;
  title: string;
  description: string;
  tags_json: JsonColumn;
  required_capabilities_json: JsonColumn;
  file_path: string;
  frontmatter_json: JsonColumn;
  created_at: string;
  updated_at: string;
}

interface WikiIndexTable {
  id: string;
  slug: string;
  title: string;
  state: string;
  content_locale: string;
  tags_json: JsonColumn;
  source_refs_json: JsonColumn;
  provenance_json: JsonColumn;
  file_path: string;
  frontmatter_json: JsonColumn;
  created_at: string;
  updated_at: string;
}

interface CollectionSchemasTable {
  id: string;
  version: string;
  file_path: string;
  schema_json: JsonColumn;
  updated_at: string;
}

interface CollectionRecordsTable {
  id: string;
  collection_id: string;
  file_path: string;
  record_json: JsonColumn;
  created_at: string;
  updated_at: string;
}

interface AutomationRunsTable {
  id: string;
  kind: string;
  source: string;
  session_id: string | null;
  status: string;
  operation_id: string | null;
  started_at: string;
  completed_at: string | null;
  error: string | null;
}

interface SettingsTable {
  id: "default";
  ui_locale: string;
  output_locale: string;
  memory_capture_mode: string;
  knowledge_wiki_capture_mode: string;
  llm_wiki_capture_mode?: string;
  skill_capture_mode: string;
  external_provider_role: string;
  updated_at: string;
}

interface GrantsTable {
  id: string;
  capability_id: string;
  operation: string;
  actor_identity: string;
  channel: string;
  resource_scope: string;
  manifest_version: string;
  risk_snapshot: string;
  scope_snapshot: string;
  external_impact_snapshot: number;
  secret_requirement_snapshot: string;
  granted_by: string;
  reason: string;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
}

interface BackendRunsTable {
  id: string;
  session_id: string;
  input_message_id: string;
  output_message_id: string | null;
  backend_id: string;
  backend_kind: string;
  status: string;
  started_at: string;
  completed_at: string | null;
  input_summary: string;
  output_summary: string | null;
  error_code: string | null;
  metadata_json: JsonColumn;
}

interface BackendEventsTable {
  id: string;
  run_id: string;
  session_id: string;
  event_type: string;
  sequence: number;
  payload_json: JsonColumn;
  resource_refs_json: JsonColumn;
  created_at: string;
}

interface WorkspaceChangesTable {
  id: string;
  run_id: string;
  session_id: string;
  resource_ref_json: JsonColumn;
  change_type: string;
  summary: string;
  legacy_operation_id: string | null;
  created_at: string;
}

interface WorkspaceDb {
  sessions: SessionsTable;
  messages: MessagesTable;
  operations: OperationsTable;
  policy_decisions: PolicyDecisionsTable;
  approval_requests: ApprovalRequestsTable;
  audit_records: AuditRecordsTable;
  rollback_points: RollbackPointsTable;
  artifacts: ArtifactsTable;
  memory_index: MemoryIndexTable;
  skill_index: SkillIndexTable;
  wiki_index: WikiIndexTable;
  collection_schemas: CollectionSchemasTable;
  collection_records: CollectionRecordsTable;
  automation_runs: AutomationRunsTable;
  settings: SettingsTable;
  grants: GrantsTable;
  backend_runs: BackendRunsTable;
  backend_events: BackendEventsTable;
  workspace_changes: WorkspaceChangesTable;
}

export interface WorkspaceStoreOptions {
  rootDir: string;
}

export interface SearchResult {
  kind: "session" | "message" | "artifact" | "audit";
  id: string;
  title: string;
  summary: string;
  session_id?: string;
  operation_id?: string;
}

export type MemoryWithFilePath = MemoryFrontmatter & { file_path: string };
export interface SkillIndexEntry {
  id: string;
  title: string;
  description: string;
  tags: string[];
  state: SkillFrontmatter["state"];
  required_capabilities: string[];
  frontmatter: SkillFrontmatter;
  file_path?: string;
}
export type SkillWithFilePath = SkillIndexEntry & { file_path: string };
export type WikiWithFilePath = WikiFrontmatter & { file_path: string };
export type CollectionSchemaWithFilePath = CollectionSchema & { file_path: string };
export type CollectionRecordWithFilePath = CollectionRecord & { file_path: string };

export interface AutomationRunRecord {
  id: string;
  kind: string;
  source: string;
  session_id?: string;
  status: "started" | "completed" | "failed";
  operation_id?: string;
  started_at: string;
  completed_at?: string;
  error?: string;
}

export interface MemoryArchiveSnapshot {
  frontmatter: MemoryFrontmatter;
  file_path: string;
  state: MemoryFrontmatter["state"];
  updated_at: string;
}

export interface ArchiveMemoryResult {
  before: MemoryArchiveSnapshot;
  after: MemoryArchiveSnapshot;
  content: string;
  changed: boolean;
  warning?: string;
}

export class WorkspaceStore {
  readonly rootDir: string;
  readonly dbPath: string;
  readonly db: Kysely<WorkspaceDb>;

  constructor(options: WorkspaceStoreOptions) {
    this.rootDir = options.rootDir;
    this.dbPath = path.join(this.rootDir, "workspace.sqlite");
    this.db = new Kysely<WorkspaceDb>({
      dialect: new SqliteDialect({
        database: new Database(this.dbPath)
      })
    });
  }

  static async create(options: WorkspaceStoreOptions): Promise<WorkspaceStore> {
    await ensureWorkspaceLayout(options.rootDir);
    const store = new WorkspaceStore(options);
    await store.migrate();
    await store.ensureDefaultSettings();
    return store;
  }

  async migrate(): Promise<void> {
    const statements = [
      `CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        session_key TEXT NOT NULL,
        title TEXT NOT NULL,
        ui_locale TEXT NOT NULL,
        output_locale TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        input_locale TEXT NOT NULL,
        output_locale TEXT NOT NULL,
        envelope_json TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      )`,
      `CREATE TABLE IF NOT EXISTS operations (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        capability_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        actor_identity TEXT NOT NULL,
        instruction_source TEXT NOT NULL,
        instruction_authority TEXT NOT NULL,
        channel TEXT NOT NULL,
        input_hash TEXT NOT NULL,
        input_ref_json TEXT,
        target_resource_refs_json TEXT NOT NULL,
        proposed_effects_json TEXT NOT NULL,
        status TEXT NOT NULL,
        policy_decision_id TEXT,
        approval_request_id TEXT,
        result_ref_json TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      )`,
      `CREATE TABLE IF NOT EXISTS policy_decisions (
        id TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL,
        capability_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        decision TEXT NOT NULL,
        reason TEXT NOT NULL,
        policy_inputs_json TEXT NOT NULL,
        matched_rules_json TEXT NOT NULL,
        required_approval_level TEXT NOT NULL,
        grant_id TEXT,
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS approval_requests (
        id TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL,
        requested_level TEXT NOT NULL,
        status TEXT NOT NULL,
        reason TEXT NOT NULL,
        requested_by TEXT NOT NULL,
        decided_by TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        decided_at TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS audit_records (
        id TEXT PRIMARY KEY,
        actor_identity TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        capability_id TEXT NOT NULL,
        instruction_source TEXT NOT NULL,
        inputs_summary TEXT NOT NULL,
        outputs_summary TEXT NOT NULL,
        policy_decision_id TEXT NOT NULL,
        affected_resources_json TEXT NOT NULL,
        rollback_point_id TEXT,
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS rollback_points (
        id TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL,
        affected_resources_json TEXT NOT NULL,
        before_snapshot_json TEXT NOT NULL,
        after_snapshot_json TEXT NOT NULL,
        reversible INTEGER NOT NULL,
        irreversible_effects_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        kind TEXT NOT NULL,
        locale TEXT NOT NULL,
        source_locales_json TEXT NOT NULL,
        file_ref_json TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        source_operation_id TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS memory_index (
        id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        topic TEXT NOT NULL,
        source TEXT NOT NULL,
        source_locale TEXT NOT NULL,
        content_locale TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        instruction_authority TEXT NOT NULL,
        file_path TEXT NOT NULL,
        frontmatter_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS skill_index (
        id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        required_capabilities_json TEXT NOT NULL,
        file_path TEXT NOT NULL UNIQUE,
        frontmatter_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS wiki_index (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        state TEXT NOT NULL,
        content_locale TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        source_refs_json TEXT NOT NULL,
        provenance_json TEXT NOT NULL,
        file_path TEXT NOT NULL UNIQUE,
        frontmatter_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS collection_schemas (
        id TEXT PRIMARY KEY,
        version TEXT NOT NULL,
        file_path TEXT NOT NULL UNIQUE,
        schema_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS collection_records (
        id TEXT NOT NULL,
        collection_id TEXT NOT NULL,
        file_path TEXT NOT NULL UNIQUE,
        record_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (collection_id, id)
      )`,
      `CREATE TABLE IF NOT EXISTS automation_runs (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        source TEXT NOT NULL,
        session_id TEXT,
        status TEXT NOT NULL,
        operation_id TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        error TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS settings (
        id TEXT PRIMARY KEY,
        ui_locale TEXT NOT NULL,
        output_locale TEXT NOT NULL,
        memory_capture_mode TEXT NOT NULL DEFAULT 'suggest',
        knowledge_wiki_capture_mode TEXT NOT NULL DEFAULT 'suggest',
        skill_capture_mode TEXT NOT NULL DEFAULT 'suggest',
        external_provider_role TEXT NOT NULL DEFAULT 'assistive',
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS grants (
        id TEXT PRIMARY KEY,
        capability_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        actor_identity TEXT NOT NULL,
        channel TEXT NOT NULL,
        resource_scope TEXT NOT NULL,
        manifest_version TEXT NOT NULL,
        risk_snapshot TEXT NOT NULL,
        scope_snapshot TEXT NOT NULL,
        external_impact_snapshot INTEGER NOT NULL,
        secret_requirement_snapshot TEXT NOT NULL,
        granted_by TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT,
        revoked_at TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS backend_runs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        input_message_id TEXT NOT NULL,
        output_message_id TEXT,
        backend_id TEXT NOT NULL,
        backend_kind TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        input_summary TEXT NOT NULL,
        output_summary TEXT,
        error_code TEXT,
        metadata_json TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      )`,
      `CREATE TABLE IF NOT EXISTS backend_events (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        resource_refs_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (run_id, sequence),
        FOREIGN KEY (run_id) REFERENCES backend_runs(id),
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      )`,
      `CREATE TABLE IF NOT EXISTS workspace_changes (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        resource_ref_json TEXT NOT NULL,
        change_type TEXT NOT NULL,
        summary TEXT NOT NULL,
        legacy_operation_id TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (run_id) REFERENCES backend_runs(id),
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      )`
    ];

    for (const statement of statements) {
      await sql.raw(statement).execute(this.db);
    }

    await this.ensureSettingsColumns();
  }

  private async ensureSettingsColumns(): Promise<void> {
    const hadKnowledgeWikiCaptureMode = await this.hasSettingsColumn("knowledge_wiki_capture_mode");
    const hadLegacyLlmWikiCaptureMode = await this.hasSettingsColumn("llm_wiki_capture_mode");
    const columns = [
      ["memory_capture_mode", "TEXT NOT NULL DEFAULT 'suggest'"],
      ["knowledge_wiki_capture_mode", "TEXT NOT NULL DEFAULT 'suggest'"],
      ["skill_capture_mode", "TEXT NOT NULL DEFAULT 'suggest'"],
      ["external_provider_role", "TEXT NOT NULL DEFAULT 'assistive'"]
    ] as const;

    for (const [name, definition] of columns) {
      try {
        await sql.raw(`ALTER TABLE settings ADD COLUMN ${name} ${definition}`).execute(this.db);
      } catch (error) {
        if (!isDuplicateColumnError(error)) {
          throw error;
        }
      }
    }

    if (!hadKnowledgeWikiCaptureMode && hadLegacyLlmWikiCaptureMode) {
      await sql.raw(
        "UPDATE settings SET knowledge_wiki_capture_mode = llm_wiki_capture_mode WHERE knowledge_wiki_capture_mode = 'suggest' AND llm_wiki_capture_mode IS NOT NULL"
      ).execute(this.db);
    }
  }

  private async hasSettingsColumn(name: string): Promise<boolean> {
    const result = await sql<{ name: string }>`PRAGMA table_info(settings)`.execute(this.db);
    return result.rows.some((row) => row.name === name);
  }

  async ensureDefaultSettings(): Promise<void> {
    const existing = await this.db.selectFrom("settings").selectAll().where("id", "=", "default").executeTakeFirst();
    if (existing) {
      return;
    }

    const settings = defaultSettings();
    await this.db
      .insertInto("settings")
      .values({
        id: "default",
        ui_locale: settings.ui_locale,
        output_locale: settings.output_locale,
        memory_capture_mode: settings.memory_capture_mode,
        knowledge_wiki_capture_mode: settings.knowledge_wiki_capture_mode,
        skill_capture_mode: settings.skill_capture_mode,
        external_provider_role: settings.external_provider_role,
        updated_at: settings.updated_at
      })
      .execute();
  }

  async createSession(session: SessionRecord): Promise<SessionRecord> {
    await this.db.insertInto("sessions").values(session).execute();
    return session;
  }

  async listSessions(): Promise<SessionRecord[]> {
    const rows = await this.db.selectFrom("sessions").selectAll().orderBy("updated_at", "desc").execute();
    return rows.map(sessionFromRow);
  }

  async getSession(sessionId: string): Promise<SessionRecord | undefined> {
    const row = await this.db.selectFrom("sessions").selectAll().where("id", "=", sessionId).executeTakeFirst();
    return row ? sessionFromRow(row) : undefined;
  }

  async touchSession(sessionId: string, title?: string): Promise<void> {
    await this.db
      .updateTable("sessions")
      .set({
        ...(title ? { title } : {}),
        updated_at: nowIso()
      })
      .where("id", "=", sessionId)
      .execute();
  }

  async saveMessage(message: MessageRecord): Promise<MessageRecord> {
    await this.db
      .insertInto("messages")
      .values({
        id: message.id,
        session_id: message.session_id,
        role: message.role,
        content: message.content,
        input_locale: message.input_locale,
        output_locale: message.output_locale,
        envelope_json: message.envelope ? stringify(message.envelope) : null,
        created_at: message.created_at
      })
      .execute();
    const session = await this.getSession(message.session_id);
    const nextTitle = message.role === "user" && session && isInitialSessionTitle(session.title) ? titleFromContent(message.content) : undefined;
    await this.touchSession(message.session_id, nextTitle);
    return message;
  }

  async listMessages(sessionId: string): Promise<MessageRecord[]> {
    const rows = await this.db.selectFrom("messages").selectAll().where("session_id", "=", sessionId).orderBy("created_at").execute();
    return rows.map(messageFromRow);
  }

  async saveOperation(operation: OperationRecord): Promise<OperationRecord> {
    await this.db
      .insertInto("operations")
      .values(operationToRow(operation))
      .execute();
    return operation;
  }

  async updateOperation(operation: OperationRecord): Promise<OperationRecord> {
    await this.db
      .updateTable("operations")
      .set(operationToRow(operation))
      .where("id", "=", operation.id)
      .execute();
    return operation;
  }

  async getOperation(operationId: string): Promise<OperationRecord | undefined> {
    const row = await this.db.selectFrom("operations").selectAll().where("id", "=", operationId).executeTakeFirst();
    return row ? operationFromRow(row) : undefined;
  }

  async listOperations(sessionId?: string): Promise<OperationRecord[]> {
    let query = this.db.selectFrom("operations").selectAll();
    if (sessionId) {
      query = query.where("session_id", "=", sessionId);
    }
    const rows = await query.orderBy("created_at", "desc").execute();
    return rows.map(operationFromRow);
  }

  async saveBackendRun(run: BackendRunRecord): Promise<BackendRunRecord> {
    await this.db.insertInto("backend_runs").values(backendRunToRow(run)).execute();
    return run;
  }

  async updateBackendRun(run: BackendRunRecord): Promise<BackendRunRecord> {
    await this.db.updateTable("backend_runs").set(backendRunToRow(run)).where("id", "=", run.id).execute();
    return run;
  }

  async getBackendRun(runId: string): Promise<BackendRunRecord | undefined> {
    const row = await this.db.selectFrom("backend_runs").selectAll().where("id", "=", runId).executeTakeFirst();
    return row ? backendRunFromRow(row) : undefined;
  }

  async listBackendRuns(sessionId?: string): Promise<BackendRunRecord[]> {
    let query = this.db.selectFrom("backend_runs").selectAll();
    if (sessionId) {
      query = query.where("session_id", "=", sessionId);
    }
    const rows = await query.orderBy("started_at", "desc").execute();
    return rows.map(backendRunFromRow);
  }

  async saveBackendEvent(event: BackendEventRecord): Promise<BackendEventRecord> {
    await this.db.insertInto("backend_events").values(backendEventToRow(event)).execute();
    return event;
  }

  async listBackendEvents(input: { runId?: string; sessionId?: string } = {}): Promise<BackendEventRecord[]> {
    let query = this.db.selectFrom("backend_events").selectAll();
    if (input.runId) {
      query = query.where("run_id", "=", input.runId);
    }
    if (input.sessionId) {
      query = query.where("session_id", "=", input.sessionId);
    }
    const rows = await query.orderBy("run_id").orderBy("sequence").execute();
    return rows.map(backendEventFromRow);
  }

  async saveWorkspaceChange(change: WorkspaceChangeRecord): Promise<WorkspaceChangeRecord> {
    await this.db.insertInto("workspace_changes").values(workspaceChangeToRow(change)).execute();
    return change;
  }

  async listWorkspaceChanges(sessionId?: string): Promise<WorkspaceChangeRecord[]> {
    let query = this.db.selectFrom("workspace_changes").selectAll();
    if (sessionId) {
      query = query.where("session_id", "=", sessionId);
    }
    const rows = await query.orderBy("created_at", "desc").execute();
    return rows.map(workspaceChangeFromRow);
  }

  async savePolicyDecision(decision: PolicyDecisionRecord): Promise<PolicyDecisionRecord> {
    await this.db
      .insertInto("policy_decisions")
      .values({
        id: decision.id,
        operation_id: decision.operation_id,
        capability_id: decision.capability_id,
        operation: decision.operation,
        decision: decision.decision,
        reason: decision.reason,
        policy_inputs_json: stringify(decision.policy_inputs),
        matched_rules_json: stringify(decision.matched_rules),
        required_approval_level: decision.required_approval_level,
        grant_id: decision.grant_id ?? null,
        created_at: decision.created_at
      })
      .execute();
    return decision;
  }

  async listPolicyDecisions(): Promise<PolicyDecisionRecord[]> {
    const rows = await this.db.selectFrom("policy_decisions").selectAll().orderBy("created_at", "desc").execute();
    return rows.map(policyDecisionFromRow);
  }

  async getPolicyDecision(id: string): Promise<PolicyDecisionRecord | undefined> {
    const row = await this.db.selectFrom("policy_decisions").selectAll().where("id", "=", id).executeTakeFirst();
    return row ? policyDecisionFromRow(row) : undefined;
  }

  async saveApprovalRequest(request: ApprovalRequest): Promise<ApprovalRequest> {
    await this.db
      .insertInto("approval_requests")
      .values({
        id: request.id,
        operation_id: request.operation_id,
        requested_level: request.requested_level,
        status: request.status,
        reason: request.reason,
        requested_by: request.requested_by,
        decided_by: request.decided_by ?? null,
        created_at: request.created_at,
        expires_at: request.expires_at,
        decided_at: request.decided_at ?? null
      })
      .execute();
    return request;
  }

  async updateApprovalRequest(request: ApprovalRequest): Promise<ApprovalRequest> {
    await this.db
      .updateTable("approval_requests")
      .set({
        requested_level: request.requested_level,
        status: request.status,
        reason: request.reason,
        requested_by: request.requested_by,
        decided_by: request.decided_by ?? null,
        expires_at: request.expires_at,
        decided_at: request.decided_at ?? null
      })
      .where("id", "=", request.id)
      .execute();
    return request;
  }

  async getApprovalRequest(id: string): Promise<ApprovalRequest | undefined> {
    const row = await this.db.selectFrom("approval_requests").selectAll().where("id", "=", id).executeTakeFirst();
    return row ? approvalRequestFromRow(row) : undefined;
  }

  async listApprovalRequests(): Promise<ApprovalRequest[]> {
    const rows = await this.db.selectFrom("approval_requests").selectAll().orderBy("created_at", "desc").execute();
    return rows.map(approvalRequestFromRow);
  }

  async saveAuditRecord(record: AuditRecord): Promise<AuditRecord> {
    await this.db
      .insertInto("audit_records")
      .values({
        id: record.id,
        actor_identity: record.actor_identity,
        operation_id: record.operation_id,
        capability_id: record.capability_id,
        instruction_source: record.instruction_source,
        inputs_summary: record.inputs_summary,
        outputs_summary: record.outputs_summary,
        policy_decision_id: record.policy_decision_id,
        affected_resources_json: stringify(record.affected_resources),
        rollback_point_id: record.rollback_point_id ?? null,
        created_at: record.created_at
      })
      .execute();
    return record;
  }

  async listAuditRecords(): Promise<AuditRecord[]> {
    const rows = await this.db.selectFrom("audit_records").selectAll().orderBy("created_at", "desc").execute();
    return rows.map(auditRecordFromRow);
  }

  async listAuditRecordsForOperation(operationId: string): Promise<AuditRecord[]> {
    const rows = await this.db.selectFrom("audit_records").selectAll().where("operation_id", "=", operationId).orderBy("created_at", "desc").execute();
    return rows.map(auditRecordFromRow);
  }

  async saveRollbackPoint(point: RollbackPoint): Promise<RollbackPoint> {
    const filePath = path.join(this.rootDir, "rollback", `${point.id}.json`);
    await writeFile(filePath, JSON.stringify(point, null, 2));
    await this.db
      .insertInto("rollback_points")
      .values({
        id: point.id,
        operation_id: point.operation_id,
        affected_resources_json: stringify(point.affected_resources),
        before_snapshot_json: stringify(point.before_snapshot),
        after_snapshot_json: stringify(point.after_snapshot),
        reversible: point.reversible ? 1 : 0,
        irreversible_effects_json: stringify(point.irreversible_effects),
        created_at: point.created_at,
        expires_at: point.expires_at
      })
      .execute();
    return point;
  }

  async listRollbackPoints(): Promise<RollbackPoint[]> {
    const rows = await this.db.selectFrom("rollback_points").selectAll().orderBy("created_at", "desc").execute();
    return rows.map(rollbackPointFromRow);
  }

  async saveArtifactMetadata(record: ArtifactRecord): Promise<ArtifactRecord> {
    await this.db
      .insertInto("artifacts")
      .values({
        id: record.id,
        title: record.title,
        kind: record.kind,
        locale: record.locale,
        source_locales_json: stringify(record.source_locales),
        file_ref_json: stringify(record.file_ref),
        metadata_json: stringify(record.metadata),
        source_operation_id: record.source_operation_id,
        created_by: record.created_by,
        created_at: record.created_at,
        updated_at: record.updated_at
      })
      .execute();
    return record;
  }

  async getArtifact(id: string): Promise<ArtifactRecord | undefined> {
    const row = await this.db.selectFrom("artifacts").selectAll().where("id", "=", id).executeTakeFirst();
    return row ? artifactFromRow(row) : undefined;
  }

  async listArtifacts(): Promise<ArtifactRecord[]> {
    const rows = await this.db.selectFrom("artifacts").selectAll().orderBy("updated_at", "desc").execute();
    return rows.map(artifactFromRow);
  }

  async listArtifactsForSession(sessionId: string): Promise<ArtifactRecord[]> {
    const rows = await this.db
      .selectFrom("artifacts")
      .innerJoin("operations", "operations.id", "artifacts.source_operation_id")
      .selectAll("artifacts")
      .where("operations.session_id", "=", sessionId)
      .orderBy("artifacts.updated_at", "desc")
      .execute();
    return rows.map(artifactFromRow);
  }

  async readArtifactContent(id: string): Promise<string | undefined> {
    const artifact = await this.getArtifact(id);
    if (!artifact) {
      return undefined;
    }
    return readFile(path.join(this.rootDir, artifact.file_ref.uri), "utf8");
  }

  async writeArtifactContent(id: string, content: string): Promise<string> {
    const relativePath = path.join("artifacts", `${id}.md`);
    const absolutePath = path.join(this.rootDir, relativePath);
    await writeFile(absolutePath, content);
    return relativePath;
  }

  async saveMemory(frontmatter: MemoryFrontmatter, content: string): Promise<MemoryFrontmatter> {
    const relativePath = path.join("memory", frontmatter.state, `${frontmatter.id}.md`);
    const absolutePath = path.join(this.rootDir, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, `${renderFrontmatter(frontmatter)}\n${content.trim()}\n`);
    await this.db
      .insertInto("memory_index")
      .values({
        id: frontmatter.id,
        state: frontmatter.state,
        topic: frontmatter.topic,
        source: frontmatter.source,
        source_locale: frontmatter.source_locale,
        content_locale: frontmatter.content_locale,
        source_kind: frontmatter.source_kind,
        instruction_authority: frontmatter.instruction_authority,
        file_path: relativePath,
        frontmatter_json: stringify(frontmatter),
        created_at: frontmatter.created_at,
        updated_at: frontmatter.updated_at
      })
      .execute();
    return frontmatter;
  }

  async listMemory(options: { includeArchived?: boolean } = {}): Promise<MemoryWithFilePath[]> {
    let query = this.db.selectFrom("memory_index").selectAll();
    if (!options.includeArchived) {
      query = query.where("state", "!=", "archived");
    }
    const rows = await query.orderBy("updated_at", "desc").execute();
    return rows.map((row) => ({ ...parse<MemoryFrontmatter>(row.frontmatter_json), file_path: row.file_path }));
  }

  async listMemoryForSession(sessionId: string, options: { includeArchived?: boolean } = {}): Promise<MemoryWithFilePath[]> {
    const messages = await this.listMessages(sessionId);
    const envelopeIds = new Set<string>();
    for (const message of messages) {
      envelopeIds.add(message.id);
      if (message.envelope?.id) {
        envelopeIds.add(message.envelope.id);
      }
    }
    if (envelopeIds.size === 0) {
      return [];
    }

    let query = this.db.selectFrom("memory_index").selectAll();
    if (!options.includeArchived) {
      query = query.where("state", "!=", "archived");
    }
    const rows = await query.orderBy("updated_at", "desc").execute();
    return rows
      .filter((row) => envelopeIds.has(row.source))
      .map((row) => ({ ...parse<MemoryFrontmatter>(row.frontmatter_json), file_path: row.file_path }));
  }

  async searchMemory(query: string, limit = 5, options: { includeArchived?: boolean } = {}): Promise<MemoryWithFilePath[]> {
    const needle = `%${query}%`;
    let dbQuery = this.db.selectFrom("memory_index").selectAll().where((eb) => eb.or([eb("topic", "like", needle), eb("source", "like", needle)]));
    if (!options.includeArchived) {
      dbQuery = dbQuery.where("state", "!=", "archived");
    }
    const rows = await dbQuery.orderBy("updated_at", "desc").limit(limit).execute();
    return rows.map((row) => ({ ...parse<MemoryFrontmatter>(row.frontmatter_json), file_path: row.file_path }));
  }

  async getMemory(id: string): Promise<MemoryWithFilePath | undefined> {
    const row = await this.db.selectFrom("memory_index").selectAll().where("id", "=", id).executeTakeFirst();
    return row ? { ...parse<MemoryFrontmatter>(row.frontmatter_json), file_path: row.file_path } : undefined;
  }

  async readMemoryContent(id: string): Promise<string | undefined> {
    const memory = await this.getMemory(id);
    if (!memory) {
      return undefined;
    }
    const raw = await readFile(path.join(this.rootDir, memory.file_path), "utf8");
    return stripFrontmatter(raw).trim();
  }

  async archiveMemory(id: string): Promise<ArchiveMemoryResult | undefined> {
    const row = await this.db.selectFrom("memory_index").selectAll().where("id", "=", id).executeTakeFirst();
    if (!row) {
      return undefined;
    }

    const frontmatter = parse<MemoryFrontmatter>(row.frontmatter_json);
    const content = await this.readMemoryContent(id);
    if (content === undefined) {
      return undefined;
    }
    const before = memorySnapshot(frontmatter, row.file_path);

    if (frontmatter.state === "archived") {
      return {
        before,
        after: before,
        content,
        changed: false
      };
    }

    const nextFrontmatter: MemoryFrontmatter = {
      ...frontmatter,
      state: "archived",
      updated_at: nowIso()
    };
    const archivedPath = path.join("memory", "archived", `${id}.md`);
    const previousAbsolutePath = path.join(this.rootDir, row.file_path);
    const archivedAbsolutePath = path.join(this.rootDir, archivedPath);
    await mkdir(path.dirname(archivedAbsolutePath), { recursive: true });
    await writeFile(archivedAbsolutePath, `${renderFrontmatter(nextFrontmatter)}\n${content.trim()}\n`);

    try {
      await this.db
        .updateTable("memory_index")
        .set({
          state: nextFrontmatter.state,
          file_path: archivedPath,
          frontmatter_json: stringify(nextFrontmatter),
          updated_at: nextFrontmatter.updated_at
        })
        .where("id", "=", id)
        .execute();
    } catch (error) {
      await unlink(archivedAbsolutePath).catch(() => undefined);
      throw error;
    }

    let warning: string | undefined;
    try {
      await unlink(previousAbsolutePath);
    } catch (error) {
      warning = error instanceof Error ? `old_file_delete_failed:${error.message}` : "old_file_delete_failed";
    }

    return {
      before,
      after: memorySnapshot(nextFrontmatter, archivedPath),
      content,
      changed: true,
      warning
    };
  }

  async saveSkillMarkdown(input: { state: "candidate" | "project"; skillId: string; markdown: string }): Promise<SkillWithFilePath> {
    const relativePath = path.join("skills", input.state, `${input.skillId}.md`);
    const absolutePath = path.join(this.rootDir, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, input.markdown, { flag: "wx" });

    try {
      const { frontmatter } = parseSkillMarkdownLocal(await readFile(absolutePath, "utf8"));
      if (frontmatter.id !== input.skillId || frontmatter.state !== input.state) {
        throw new Error("skill_frontmatter_path_mismatch");
      }
      const now = nowIso();
      await this.db
        .insertInto("skill_index")
        .values({
          id: frontmatter.id,
          state: frontmatter.state,
          title: frontmatter.title,
          description: frontmatter.description,
          tags_json: stringify(frontmatter.tags),
          required_capabilities_json: stringify(frontmatter.required_capabilities),
          file_path: relativePath,
          frontmatter_json: stringify(frontmatter),
          created_at: now,
          updated_at: now
        })
        .execute();
      return { ...buildSkillIndexEntry(frontmatter), file_path: relativePath };
    } catch (error) {
      await unlink(absolutePath).catch(() => undefined);
      throw error;
    }
  }

  async listSkills(): Promise<SkillWithFilePath[]> {
    const rows = await this.db.selectFrom("skill_index").selectAll().orderBy("updated_at", "desc").execute();
    return rows.map(skillFromRow);
  }

  async getSkill(id: string): Promise<SkillWithFilePath | undefined> {
    const row = await this.db.selectFrom("skill_index").selectAll().where("id", "=", id).executeTakeFirst();
    return row ? skillFromRow(row) : undefined;
  }

  async readSkillMarkdown(id: string): Promise<string | undefined> {
    const skill = await this.getSkill(id);
    if (!skill) {
      return undefined;
    }
    return readFile(path.join(this.rootDir, skill.file_path), "utf8");
  }

  async saveWikiPage(frontmatter: WikiFrontmatter, content: string): Promise<WikiWithFilePath> {
    const relativePath = path.join("wiki", "pages", `${frontmatter.slug}.md`);
    const absolutePath = path.join(this.rootDir, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, `${renderFrontmatter(frontmatter)}\n${content.trim()}\n`, { flag: "wx" });

    try {
      const parsed = parseWikiMarkdownLocal(await readFile(absolutePath, "utf8"));
      if (parsed.frontmatter.id !== frontmatter.id || parsed.frontmatter.slug !== frontmatter.slug) {
        throw new Error("wiki_frontmatter_path_mismatch");
      }
      await this.db
        .insertInto("wiki_index")
        .values(wikiToRow(parsed.frontmatter, relativePath))
        .execute();
      return { ...parsed.frontmatter, file_path: relativePath };
    } catch (error) {
      await unlink(absolutePath).catch(() => undefined);
      throw error;
    }
  }

  async listWiki(options: { activeOnly?: boolean } = {}): Promise<WikiWithFilePath[]> {
    let query = this.db.selectFrom("wiki_index").selectAll();
    if (options.activeOnly) {
      query = query.where("state", "=", "active");
    }
    const rows = await query.orderBy("updated_at", "desc").execute();
    return rows.map(wikiFromRow);
  }

  async getWiki(id: string): Promise<WikiWithFilePath | undefined> {
    const row = await this.db.selectFrom("wiki_index").selectAll().where("id", "=", id).executeTakeFirst();
    return row ? wikiFromRow(row) : undefined;
  }

  async readWikiContent(id: string): Promise<string | undefined> {
    const wiki = await this.getWiki(id);
    if (!wiki) {
      return undefined;
    }
    const raw = await readFile(path.join(this.rootDir, wiki.file_path), "utf8");
    return stripFrontmatter(raw).trim();
  }

  async updateWikiPage(input: {
    id: string;
    title?: string;
    content?: string;
    tags?: string[];
    content_locale?: WikiFrontmatter["content_locale"];
    source_refs?: WikiFrontmatter["source_refs"];
    provenance?: WikiFrontmatter["provenance"];
  }): Promise<WikiWithFilePath | undefined> {
    const current = await this.getWiki(input.id);
    if (!current) {
      return undefined;
    }
    const content = input.content ?? (await this.readWikiContent(input.id));
    if (content === undefined) {
      return undefined;
    }
    const { file_path: filePath, ...currentFrontmatter } = current;
    const next: WikiFrontmatter = {
      ...currentFrontmatter,
      title: input.title ?? current.title,
      tags: input.tags ?? current.tags,
      content_locale: input.content_locale ?? current.content_locale,
      source_refs: input.source_refs ?? current.source_refs,
      provenance: input.provenance ?? current.provenance,
      updated_at: nowIso()
    };
    await this.writeWikiPage(next, filePath, content);
    return { ...next, file_path: filePath };
  }

  async setWikiState(id: string, state: WikiFrontmatter["state"]): Promise<WikiWithFilePath | undefined> {
    const current = await this.getWiki(id);
    if (!current) {
      return undefined;
    }
    const content = await this.readWikiContent(id);
    if (content === undefined) {
      return undefined;
    }
    const { file_path: filePath, ...currentFrontmatter } = current;
    const next: WikiFrontmatter = {
      ...currentFrontmatter,
      state,
      updated_at: nowIso()
    };
    await this.writeWikiPage(next, filePath, content);
    return { ...next, file_path: filePath };
  }

  async reindexWiki(): Promise<{ active: number; total: number }> {
    const pages = await this.listWiki();
    for (const page of pages) {
      const raw = await readFile(path.join(this.rootDir, page.file_path), "utf8");
      const parsed = parseWikiMarkdownLocal(raw);
      await this.db
        .updateTable("wiki_index")
        .set(wikiToRow(parsed.frontmatter, page.file_path))
        .where("id", "=", page.id)
        .execute();
    }
    return {
      active: pages.filter((page) => page.state === "active").length,
      total: pages.length
    };
  }

  private async writeWikiPage(frontmatter: WikiFrontmatter, filePath: string, content: string): Promise<void> {
    const absolutePath = path.join(this.rootDir, filePath);
    await writeFile(absolutePath, `${renderFrontmatter(frontmatter)}\n${content.trim()}\n`);
    await this.db
      .updateTable("wiki_index")
      .set(wikiToRow(frontmatter, filePath))
      .where("id", "=", frontmatter.id)
      .execute();
  }

  async saveCollectionSchema(schemaInput: CollectionSchema): Promise<CollectionSchemaWithFilePath> {
    const relativePath = path.join("collections", schemaInput.id, "schema.json");
    const absolutePath = path.join(this.rootDir, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, `${JSON.stringify(schemaInput, null, 2)}\n`, { flag: "wx" });

    try {
      const schema = parseCollectionSchemaLocal(JSON.parse(await readFile(absolutePath, "utf8")));
      const now = nowIso();
      await this.db
        .insertInto("collection_schemas")
        .values({
          id: schema.id,
          version: schema.version,
          file_path: relativePath,
          schema_json: stringify(schema),
          updated_at: now
        })
        .execute();
      return { ...schema, file_path: relativePath };
    } catch (error) {
      await unlink(absolutePath).catch(() => undefined);
      throw error;
    }
  }

  async getCollectionSchema(collectionId: string): Promise<CollectionSchemaWithFilePath | undefined> {
    const row = await this.db.selectFrom("collection_schemas").selectAll().where("id", "=", collectionId).executeTakeFirst();
    return row ? collectionSchemaFromRow(row) : undefined;
  }

  async saveCollectionRecord(recordInput: CollectionRecord): Promise<CollectionRecordWithFilePath> {
    const schema = await this.getCollectionSchema(recordInput.collection_id);
    if (!schema) {
      throw new Error("collection_schema_not_found");
    }
    const relativePath = path.join("collections", recordInput.collection_id, "records", `${recordInput.id}.json`);
    const absolutePath = path.join(this.rootDir, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, `${JSON.stringify(recordInput, null, 2)}\n`, { flag: "wx" });

    try {
      const record = parseCollectionRecordLocal(JSON.parse(await readFile(absolutePath, "utf8")), schema);
      await this.db
        .insertInto("collection_records")
        .values({
          id: record.id,
          collection_id: record.collection_id,
          file_path: relativePath,
          record_json: stringify(record),
          created_at: record.created_at,
          updated_at: record.updated_at
        })
        .execute();
      return { ...record, file_path: relativePath };
    } catch (error) {
      await unlink(absolutePath).catch(() => undefined);
      throw error;
    }
  }

  async getCollectionRecord(collectionId: string, recordId: string): Promise<CollectionRecordWithFilePath | undefined> {
    const row = await this.db
      .selectFrom("collection_records")
      .selectAll()
      .where("collection_id", "=", collectionId)
      .where("id", "=", recordId)
      .executeTakeFirst();
    return row ? collectionRecordFromRow(row) : undefined;
  }

  async applyCollectionRecordPatch(input: { collectionId: string; recordId: string; patch: CollectionPatch }): Promise<{
    before: CollectionRecordWithFilePath;
    after: CollectionRecordWithFilePath;
  }> {
    const [schema, before] = await Promise.all([
      this.getCollectionSchema(input.collectionId),
      this.getCollectionRecord(input.collectionId, input.recordId)
    ]);
    if (!schema) {
      throw new Error("collection_schema_not_found");
    }
    if (!before) {
      throw new Error("collection_record_not_found");
    }
    const after = applyCollectionPatchLocal(before, input.patch, schema);
    const absolutePath = path.join(this.rootDir, before.file_path);
    await writeFile(absolutePath, `${JSON.stringify(after, null, 2)}\n`);
    await this.db
      .updateTable("collection_records")
      .set({
        record_json: stringify(after),
        updated_at: after.updated_at
      })
      .where("collection_id", "=", input.collectionId)
      .where("id", "=", input.recordId)
      .execute();
    return { before, after: { ...after, file_path: before.file_path } };
  }

  async listCollectionNotes(collectionId: string): Promise<Array<{ file_path: string; content: string }>> {
    const notesDir = path.join(this.rootDir, "collections", collectionId, "notes");
    let entries: string[];
    try {
      entries = await readdir(notesDir);
    } catch {
      return [];
    }
    const notes: Array<{ file_path: string; content: string }> = [];
    for (const entry of entries.filter((item) => item.endsWith(".md")).sort()) {
      const relativePath = path.join("collections", collectionId, "notes", entry);
      notes.push({
        file_path: relativePath,
        content: await readFile(path.join(this.rootDir, relativePath), "utf8")
      });
    }
    return notes;
  }

  async createAutomationRun(run: AutomationRunRecord): Promise<AutomationRunRecord> {
    await this.db
      .insertInto("automation_runs")
      .values(automationRunToRow(run))
      .execute();
    return run;
  }

  async updateAutomationRun(run: AutomationRunRecord): Promise<AutomationRunRecord> {
    await this.db
      .updateTable("automation_runs")
      .set(automationRunToRow(run))
      .where("id", "=", run.id)
      .execute();
    return run;
  }

  async getAutomationRun(id: string): Promise<AutomationRunRecord | undefined> {
    const row = await this.db.selectFrom("automation_runs").selectAll().where("id", "=", id).executeTakeFirst();
    return row ? automationRunFromRow(row) : undefined;
  }

  async getSettings(): Promise<SettingsRecord> {
    const row = await this.db.selectFrom("settings").selectAll().where("id", "=", "default").executeTakeFirstOrThrow();
    return {
      ui_locale: row.ui_locale as SettingsRecord["ui_locale"],
      output_locale: row.output_locale as SettingsRecord["output_locale"],
      memory_capture_mode: row.memory_capture_mode as SettingsRecord["memory_capture_mode"],
      knowledge_wiki_capture_mode: row.knowledge_wiki_capture_mode as SettingsRecord["knowledge_wiki_capture_mode"],
      skill_capture_mode: row.skill_capture_mode as SettingsRecord["skill_capture_mode"],
      external_provider_role: row.external_provider_role as SettingsRecord["external_provider_role"],
      updated_at: row.updated_at
    };
  }

  async patchSettings(patch: Partial<Omit<SettingsRecord, "updated_at">>): Promise<SettingsRecord> {
    const current = await this.getSettings();
    const next: SettingsRecord = {
      ...current,
      ...patch,
      updated_at: nowIso()
    };
    await this.db
      .updateTable("settings")
      .set({
        ui_locale: next.ui_locale,
        output_locale: next.output_locale,
        memory_capture_mode: next.memory_capture_mode,
        knowledge_wiki_capture_mode: next.knowledge_wiki_capture_mode,
        skill_capture_mode: next.skill_capture_mode,
        external_provider_role: next.external_provider_role,
        updated_at: next.updated_at
      })
      .where("id", "=", "default")
      .execute();
    return next;
  }

  async listGrants(): Promise<GrantRecord[]> {
    const rows = await this.db.selectFrom("grants").selectAll().execute();
    return rows.map(grantFromRow);
  }

  async search(query: string): Promise<SearchResult[]> {
    const trimmed = query.trim();
    if (!trimmed) {
      return [];
    }

    const needle = `%${trimmed}%`;
    const [sessions, messages, artifacts, audits] = await Promise.all([
      this.db.selectFrom("sessions").selectAll().where("title", "like", needle).limit(10).execute(),
      this.db.selectFrom("messages").selectAll().where("content", "like", needle).limit(10).execute(),
      this.db
        .selectFrom("artifacts")
        .leftJoin("operations", "operations.id", "artifacts.source_operation_id")
        .selectAll("artifacts")
        .select(["operations.session_id as session_id"])
        .execute(),
      this.db
        .selectFrom("audit_records")
        .leftJoin("operations", "operations.id", "audit_records.operation_id")
        .selectAll("audit_records")
        .select(["operations.session_id as session_id"])
        .where((eb) => eb.or([eb("inputs_summary", "like", needle), eb("outputs_summary", "like", needle)]))
        .limit(10)
        .execute()
    ]);

    const artifactResults: SearchResult[] = [];
    for (const artifact of artifacts) {
      const content = (await this.readArtifactContent(artifact.id).catch(() => "")) ?? "";
      if (artifact.title.includes(trimmed) || content.includes(trimmed)) {
        artifactResults.push({
          kind: "artifact",
          id: artifact.id,
          title: artifact.title,
          summary: content.slice(0, 120),
          session_id: artifact.session_id ?? undefined,
          operation_id: artifact.source_operation_id
        });
      }
      if (artifactResults.length >= 10) {
        break;
      }
    }

    return [
      ...sessions.map((row) => ({ kind: "session" as const, id: row.id, title: row.title, summary: row.session_key })),
      ...messages.map((row) => ({
        kind: "message" as const,
        id: row.id,
        title: row.role,
        summary: row.content.slice(0, 120),
        session_id: row.session_id
      })),
      ...artifactResults,
      ...audits.map((row) => ({
        kind: "audit" as const,
        id: row.id,
        title: row.operation_id,
        summary: `${row.inputs_summary} -> ${row.outputs_summary}`.slice(0, 140),
        session_id: row.session_id ?? undefined,
        operation_id: row.operation_id
      }))
    ];
  }

  async readActivityInputs(): Promise<{
    approvals: ApprovalRequest[];
    operations: OperationRecord[];
    decisions: PolicyDecisionRecord[];
    audits: AuditRecord[];
    rollbacks: RollbackPoint[];
  }> {
    const [approvals, operations, decisions, audits, rollbacks] = await Promise.all([
      this.listApprovalRequests(),
      this.listOperations(),
      this.listPolicyDecisions(),
      this.listAuditRecords(),
      this.listRollbackPoints()
    ]);
    return { approvals, operations, decisions, audits, rollbacks };
  }

  async close(): Promise<void> {
    await this.db.destroy();
  }
}

export async function ensureWorkspaceLayout(rootDir: string): Promise<void> {
  const dirs = [
    rootDir,
    path.join(rootDir, "artifacts"),
    path.join(rootDir, "memory", "session"),
    path.join(rootDir, "memory", "provisional"),
    path.join(rootDir, "memory", "topic"),
    path.join(rootDir, "memory", "active"),
    path.join(rootDir, "memory", "sensitive"),
    path.join(rootDir, "memory", "archived"),
    path.join(rootDir, "skills", "candidate"),
    path.join(rootDir, "skills", "project"),
    path.join(rootDir, "wiki", "pages"),
    path.join(rootDir, "rollback"),
    path.join(rootDir, "collections")
  ];

  await Promise.all(dirs.map((dir) => mkdir(dir, { recursive: true })));
}

export function renderFrontmatter(frontmatter: object): string {
  return [
    "---",
    ...Object.entries(frontmatter).map(([key, value]) => `${key}: ${JSON.stringify(value)}`),
    "---"
  ].join("\n");
}

function titleFromContent(content: string): string {
  return content.trim().replace(/\s+/g, " ").slice(0, 48) || "Untitled chat";
}

function isInitialSessionTitle(title: string): boolean {
  const normalized = title.trim().toLowerCase();
  return normalized === "" || normalized === "new chat" || normalized === "untitled chat";
}

function stringify(value: unknown): string {
  return JSON.stringify(value);
}

function parse<T>(value: string): T {
  return JSON.parse(value) as T;
}

function stripFrontmatter(raw: string): string {
  if (!raw.startsWith("---\n")) {
    return raw;
  }
  const end = raw.indexOf("\n---", 4);
  if (end === -1) {
    return raw;
  }
  const contentStart = raw.indexOf("\n", end + 4);
  return contentStart === -1 ? "" : raw.slice(contentStart + 1);
}

function parseSkillMarkdownLocal(markdown: string): { frontmatter: SkillFrontmatter; content: string } {
  if (!markdown.startsWith("---\n")) {
    throw new Error("skill_frontmatter_missing");
  }
  const end = markdown.indexOf("\n---", 4);
  if (end === -1) {
    throw new Error("skill_frontmatter_unclosed");
  }
  const rawFrontmatter = markdown.slice(4, end).trim();
  const contentStart = markdown.indexOf("\n", end + 4);
  const content = contentStart === -1 ? "" : markdown.slice(contentStart + 1).trim();
  return {
    frontmatter: SkillFrontmatterSchema.parse(JSON.parse(rawFrontmatter)),
    content
  };
}

function parseWikiMarkdownLocal(markdown: string): { frontmatter: WikiFrontmatter; content: string } {
  if (!markdown.startsWith("---\n")) {
    throw new Error("wiki_frontmatter_missing");
  }
  const end = markdown.indexOf("\n---", 4);
  if (end === -1) {
    throw new Error("wiki_frontmatter_unclosed");
  }
  const rawFrontmatter = markdown.slice(4, end).trim();
  const contentStart = markdown.indexOf("\n", end + 4);
  const content = contentStart === -1 ? "" : markdown.slice(contentStart + 1).trim();
  return {
    frontmatter: WikiFrontmatterSchema.parse(JSON.parse(rawFrontmatter)),
    content
  };
}

function buildSkillIndexEntry(frontmatter: SkillFrontmatter): SkillIndexEntry {
  return {
    id: frontmatter.id,
    title: frontmatter.title,
    description: frontmatter.description,
    tags: frontmatter.tags,
    state: frontmatter.state,
    required_capabilities: frontmatter.required_capabilities,
    frontmatter
  };
}

function parseCollectionSchemaLocal(value: unknown): CollectionSchema {
  const schema = CollectionSchemaSchema.parse(value);
  const seen = new Set<string>();
  for (const field of schema.fields) {
    const id = collectionFieldId(field);
    if (!id) {
      throw new Error("collection_field_id_required");
    }
    if (seen.has(id)) {
      throw new Error(`collection_field_duplicate:${id}`);
    }
    seen.add(id);
  }
  return schema;
}

function parseCollectionRecordLocal(value: unknown, schema: CollectionSchema): CollectionRecord {
  const record = CollectionRecordSchema.parse(value);
  if (record.collection_id !== schema.id) {
    throw new Error("collection_record_collection_id_mismatch");
  }
  rejectUnknownCollectionFields(record.data, schema);
  return record;
}

function applyCollectionPatchLocal(record: CollectionRecord, patch: CollectionPatch, schema: CollectionSchema): CollectionRecord {
  if (patch.record_id !== record.id) {
    throw new Error("collection_patch_record_id_mismatch");
  }
  rejectUnknownCollectionFields(patch.changes, schema);
  return {
    ...record,
    data: {
      ...record.data,
      ...patch.changes
    },
    updated_at: patch.created_at
  };
}

function rejectUnknownCollectionFields(data: Record<string, JsonValue>, schema: CollectionSchema): void {
  const allowed = new Set(schema.fields.map(collectionFieldId).filter((id): id is string => Boolean(id)));
  for (const key of Object.keys(data)) {
    if (!allowed.has(key)) {
      throw new Error(`collection_unknown_field:${key}`);
    }
  }
}

function collectionFieldId(field: Record<string, JsonValue>): string | undefined {
  const value = field.id ?? field.name;
  return typeof value === "string" && value.trim() ? value : undefined;
}

function memorySnapshot(frontmatter: MemoryFrontmatter, filePath: string): MemoryArchiveSnapshot {
  return {
    frontmatter,
    file_path: filePath,
    state: frontmatter.state,
    updated_at: frontmatter.updated_at
  };
}

function sessionFromRow(row: SessionsTable): SessionRecord {
  return {
    id: row.id,
    session_key: row.session_key,
    title: row.title,
    ui_locale: row.ui_locale as SessionRecord["ui_locale"],
    output_locale: row.output_locale as SessionRecord["output_locale"],
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function messageFromRow(row: MessagesTable): MessageRecord {
  const envelope = row.envelope_json ? safeParse(row.envelope_json) : undefined;
  return {
    id: row.id,
    session_id: row.session_id,
    role: row.role,
    content: row.content,
    input_locale: row.input_locale as MessageRecord["input_locale"],
    output_locale: row.output_locale as MessageRecord["output_locale"],
    envelope: envelope as MessageRecord["envelope"],
    created_at: row.created_at
  };
}

function safeParse(value: string): unknown | undefined {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function operationToRow(operation: OperationRecord): OperationsTable {
  return {
    id: operation.id,
    session_id: operation.session_id,
    capability_id: operation.capability_id,
    operation: operation.operation,
    actor_identity: operation.actor_identity,
    instruction_source: operation.instruction_source,
    instruction_authority: operation.instruction_authority,
    channel: operation.channel,
    input_hash: operation.input_hash,
    input_ref_json: operation.input_ref ? stringify(operation.input_ref) : null,
    target_resource_refs_json: stringify(operation.target_resource_refs),
    proposed_effects_json: stringify(operation.proposed_effects),
    status: operation.status,
    policy_decision_id: operation.policy_decision_id ?? null,
    approval_request_id: operation.approval_request_id ?? null,
    result_ref_json: operation.result_ref ? stringify(operation.result_ref) : null,
    error: operation.error ?? null,
    created_at: operation.created_at,
    updated_at: operation.updated_at
  };
}

function operationFromRow(row: OperationsTable): OperationRecord {
  return {
    id: row.id,
    session_id: row.session_id,
    capability_id: row.capability_id,
    operation: row.operation,
    actor_identity: row.actor_identity as OperationRecord["actor_identity"],
    instruction_source: row.instruction_source as OperationRecord["instruction_source"],
    instruction_authority: row.instruction_authority,
    channel: row.channel,
    input_hash: row.input_hash,
    input_ref: row.input_ref_json ? parse(row.input_ref_json) : undefined,
    target_resource_refs: parse(row.target_resource_refs_json),
    proposed_effects: parse(row.proposed_effects_json),
    status: row.status as OperationRecord["status"],
    policy_decision_id: row.policy_decision_id ?? undefined,
    approval_request_id: row.approval_request_id ?? undefined,
    result_ref: row.result_ref_json ? parse(row.result_ref_json) : undefined,
    error: row.error ?? undefined,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function backendRunToRow(run: BackendRunRecord): BackendRunsTable {
  return {
    id: run.id,
    session_id: run.session_id,
    input_message_id: run.input_message_id,
    output_message_id: run.output_message_id ?? null,
    backend_id: run.backend_id,
    backend_kind: run.backend_kind,
    status: run.status,
    started_at: run.started_at,
    completed_at: run.completed_at ?? null,
    input_summary: run.input_summary,
    output_summary: run.output_summary ?? null,
    error_code: run.error_code ?? null,
    metadata_json: stringify(run.metadata)
  };
}

function backendRunFromRow(row: BackendRunsTable): BackendRunRecord {
  return {
    id: row.id,
    session_id: row.session_id,
    input_message_id: row.input_message_id,
    output_message_id: row.output_message_id ?? undefined,
    backend_id: row.backend_id,
    backend_kind: row.backend_kind as BackendRunRecord["backend_kind"],
    status: row.status as BackendRunRecord["status"],
    started_at: row.started_at,
    completed_at: row.completed_at ?? undefined,
    input_summary: row.input_summary,
    output_summary: row.output_summary ?? undefined,
    error_code: row.error_code ?? undefined,
    metadata: parse(row.metadata_json)
  };
}

function backendEventToRow(event: BackendEventRecord): BackendEventsTable {
  return {
    id: event.id,
    run_id: event.run_id,
    session_id: event.session_id,
    event_type: event.event_type,
    sequence: event.sequence,
    payload_json: stringify(event.payload),
    resource_refs_json: stringify(event.resource_refs),
    created_at: event.created_at
  };
}

function backendEventFromRow(row: BackendEventsTable): BackendEventRecord {
  return {
    id: row.id,
    run_id: row.run_id,
    session_id: row.session_id,
    event_type: row.event_type as BackendEventRecord["event_type"],
    sequence: row.sequence,
    payload: parse(row.payload_json),
    resource_refs: parse(row.resource_refs_json),
    created_at: row.created_at
  };
}

function workspaceChangeToRow(change: WorkspaceChangeRecord): WorkspaceChangesTable {
  return {
    id: change.id,
    run_id: change.run_id,
    session_id: change.session_id,
    resource_ref_json: stringify(change.resource_ref),
    change_type: change.change_type,
    summary: change.summary,
    legacy_operation_id: change.legacy_operation_id ?? null,
    created_at: change.created_at
  };
}

function workspaceChangeFromRow(row: WorkspaceChangesTable): WorkspaceChangeRecord {
  return {
    id: row.id,
    run_id: row.run_id,
    session_id: row.session_id,
    resource_ref: parse(row.resource_ref_json),
    change_type: row.change_type as WorkspaceChangeRecord["change_type"],
    summary: row.summary,
    legacy_operation_id: row.legacy_operation_id ?? undefined,
    created_at: row.created_at
  };
}

function policyDecisionFromRow(row: PolicyDecisionsTable): PolicyDecisionRecord {
  return {
    id: row.id,
    operation_id: row.operation_id,
    capability_id: row.capability_id,
    operation: row.operation,
    decision: row.decision as PolicyDecisionRecord["decision"],
    reason: row.reason,
    policy_inputs: parse(row.policy_inputs_json),
    matched_rules: parse(row.matched_rules_json),
    required_approval_level: row.required_approval_level as PolicyDecisionRecord["required_approval_level"],
    grant_id: row.grant_id ?? undefined,
    created_at: row.created_at
  };
}

function approvalRequestFromRow(row: ApprovalRequestsTable): ApprovalRequest {
  return {
    id: row.id,
    operation_id: row.operation_id,
    requested_level: row.requested_level as ApprovalRequest["requested_level"],
    status: row.status as ApprovalRequest["status"],
    reason: row.reason,
    requested_by: row.requested_by,
    decided_by: row.decided_by ?? undefined,
    created_at: row.created_at,
    expires_at: row.expires_at,
    decided_at: row.decided_at ?? undefined
  };
}

function auditRecordFromRow(row: AuditRecordsTable): AuditRecord {
  return {
    id: row.id,
    actor_identity: row.actor_identity as AuditRecord["actor_identity"],
    operation_id: row.operation_id,
    capability_id: row.capability_id,
    instruction_source: row.instruction_source as AuditRecord["instruction_source"],
    inputs_summary: row.inputs_summary,
    outputs_summary: row.outputs_summary,
    policy_decision_id: row.policy_decision_id,
    affected_resources: parse(row.affected_resources_json),
    rollback_point_id: row.rollback_point_id ?? undefined,
    created_at: row.created_at
  };
}

function rollbackPointFromRow(row: RollbackPointsTable): RollbackPoint {
  return {
    id: row.id,
    operation_id: row.operation_id,
    affected_resources: parse(row.affected_resources_json),
    before_snapshot: parse(row.before_snapshot_json),
    after_snapshot: parse(row.after_snapshot_json),
    reversible: row.reversible === 1,
    irreversible_effects: parse(row.irreversible_effects_json),
    created_at: row.created_at,
    expires_at: row.expires_at
  };
}

function skillFromRow(row: SkillIndexTable): SkillWithFilePath {
  return {
    ...buildSkillIndexEntry(parse(row.frontmatter_json)),
    file_path: row.file_path
  };
}

function wikiToRow(frontmatter: WikiFrontmatter, filePath: string): WikiIndexTable {
  return {
    id: frontmatter.id,
    slug: frontmatter.slug,
    title: frontmatter.title,
    state: frontmatter.state,
    content_locale: frontmatter.content_locale,
    tags_json: stringify(frontmatter.tags),
    source_refs_json: stringify(frontmatter.source_refs),
    provenance_json: stringify(frontmatter.provenance),
    file_path: filePath,
    frontmatter_json: stringify(frontmatter),
    created_at: frontmatter.created_at,
    updated_at: frontmatter.updated_at
  };
}

function wikiFromRow(row: WikiIndexTable): WikiWithFilePath {
  return {
    ...parse<WikiFrontmatter>(row.frontmatter_json),
    file_path: row.file_path
  };
}

function collectionSchemaFromRow(row: CollectionSchemasTable): CollectionSchemaWithFilePath {
  return {
    ...parse(row.schema_json),
    file_path: row.file_path
  };
}

function collectionRecordFromRow(row: CollectionRecordsTable): CollectionRecordWithFilePath {
  return {
    ...parse(row.record_json),
    file_path: row.file_path
  };
}

function automationRunToRow(run: AutomationRunRecord): AutomationRunsTable {
  return {
    id: run.id,
    kind: run.kind,
    source: run.source,
    session_id: run.session_id ?? null,
    status: run.status,
    operation_id: run.operation_id ?? null,
    started_at: run.started_at,
    completed_at: run.completed_at ?? null,
    error: run.error ?? null
  };
}

function automationRunFromRow(row: AutomationRunsTable): AutomationRunRecord {
  return {
    id: row.id,
    kind: row.kind,
    source: row.source,
    session_id: row.session_id ?? undefined,
    status: row.status as AutomationRunRecord["status"],
    operation_id: row.operation_id ?? undefined,
    started_at: row.started_at,
    completed_at: row.completed_at ?? undefined,
    error: row.error ?? undefined
  };
}

function isDuplicateColumnError(error: unknown): boolean {
  return error instanceof Error && /duplicate column name/i.test(error.message);
}

function artifactFromRow(row: ArtifactsTable): ArtifactRecord {
  return {
    id: row.id,
    title: row.title,
    kind: row.kind as ArtifactRecord["kind"],
    locale: row.locale as ArtifactRecord["locale"],
    source_locales: parse(row.source_locales_json),
    file_ref: parse(row.file_ref_json),
    metadata: parse(row.metadata_json),
    source_operation_id: row.source_operation_id,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function grantFromRow(row: GrantsTable): GrantRecord {
  return {
    id: row.id,
    capability_id: row.capability_id,
    operation: row.operation,
    actor_identity: row.actor_identity as GrantRecord["actor_identity"],
    channel: row.channel,
    resource_scope: row.resource_scope,
    manifest_version: row.manifest_version,
    risk_snapshot: row.risk_snapshot as GrantRecord["risk_snapshot"],
    scope_snapshot: row.scope_snapshot as GrantRecord["scope_snapshot"],
    external_impact_snapshot: row.external_impact_snapshot === 1,
    secret_requirement_snapshot: row.secret_requirement_snapshot,
    granted_by: row.granted_by,
    reason: row.reason,
    created_at: row.created_at,
    expires_at: row.expires_at ?? undefined,
    revoked_at: row.revoked_at ?? undefined
  };
}

export type { ActivityInboxItem };
