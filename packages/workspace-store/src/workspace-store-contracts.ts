import type {
  ApprovalRequest,
  ArtifactRecord,
  AuditRecord,
  AutomationJobRecord,
  BackendEventRecord,
  BackendRunRecord,
  ChangeHistoryEntry,
  CollectionPatch,
  CollectionRecord,
  CollectionSchema,
  JsonValue,
  LifecycleTransitionDecision,
  MemoryFrontmatter,
  MessagePresentationRecord,
  MessageRecord,
  OperationRecord,
  PolicyDecisionRecord,
  ResourceRef,
  ResourceTranslationRecord,
  RunHistoryEntry,
  SessionRecord,
  SkillFrontmatter,
  ToolRunRecord,
  WikiFrontmatter,
  WorkspaceChangeRecord
} from "@samurai-agent/core-schemas";
import type { WorkspaceResourceBoundary } from "./kernel/workspace-paths";

/** Public input for the Core 02 terminal settlement transaction. */
export interface Core02SettlementInput {
  expectedRun: BackendRunRecord;
  nextRun: BackendRunRecord;
  terminalEvent: BackendEventRecord;
  outputSourceId: string;
  output?: MessageRecord;
  decision: LifecycleTransitionDecision;
  attemptNo: number;
  sourceIdentity: { sourceEventId?: string; sourceSequence?: number };
  terminalEvidence: unknown;
  diagnostic?: { code: string; message: string; metadata?: Record<string, JsonValue> };
  reservation: { sessionId: string; runId: string; version: number; status: "held" | "released" };
}

export interface WorkspaceStoreOptions {
  rootDir: string;
  fileTransactionFailureInjector?: (phase: "planned" | "staged" | "db_transaction" | "db_committed" | "renamed") => void;
  restoreFailureInjector?: (phase: "extract" | "hash_verify" | "swap") => void;
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
  allowed_scopes: SkillFrontmatter["allowed_scopes"];
  required_capabilities: string[];
  owner_pinned: boolean;
  frontmatter: SkillFrontmatter;
  file_path?: string;
}

export type SkillWithFilePath = SkillIndexEntry & { file_path: string };

export interface SkillSupportFile {
  skill_id: string;
  path: string;
  file_path: string;
  content: string;
}

export type WikiWithFilePath = WikiFrontmatter & { file_path: string };
export type CollectionSchemaWithFilePath = CollectionSchema & { file_path: string };
export type CollectionRecordWithFilePath = Omit<CollectionRecord, "version"> & { version: number; file_path: string };

export interface CollectionResolvedRef {
  ref_id: string;
  field: string;
  target_collection_id: string;
  target_record_id: string;
  record: CollectionRecordWithFilePath;
  resource_ref: ResourceRef;
}

export interface CollectionMissingRef {
  ref_id: string;
  field: string;
  target_collection_id: string;
  target_record_id?: string;
  reason: "empty" | "invalid" | "not_found";
}

export interface CollectionResolvedEmbed {
  embed_id: string;
  field: string;
  value: JsonValue;
}

export interface CollectionRecordResolution {
  collection_id: string;
  record_id: string;
  resolved_refs: CollectionResolvedRef[];
  missing_refs: CollectionMissingRef[];
  embed_fields: CollectionResolvedEmbed[];
}

export interface CollectionTriggerEffect {
  id: string;
  event: "record.created" | "record.patched";
  action_id: string;
  action_kind: string;
  status: "queued" | "ignored";
  reason?: string;
  record_ref: ResourceRef;
}

export interface CollectionTriggerJobSummary {
  id: string;
  status: AutomationJobRecord["status"];
  next_run_at?: string;
  last_run_at?: string;
  retry_after_at?: string;
  failure_count: number;
  last_error?: string;
  updated_at: string;
}

export interface AutomationQueueSummary {
  now: string;
  total: number;
  due: number;
  locked: number;
  retry_due: number;
  retry_pending: number;
  exhausted: number;
  by_status: Record<string, number>;
  by_kind: Record<string, number>;
  next_due_at?: string;
  oldest_locked_until?: string;
}

export interface CollectionTriggerState {
  collection_id: string;
  trigger_id: string;
  event: string;
  action_id: string;
  action_kind: string;
  enabled: boolean;
  action_exists: boolean;
  status: "idle" | "queued" | "completed" | "failed" | "disabled" | "action_missing";
  pending_job_count: number;
  job_count: number;
  last_job?: CollectionTriggerJobSummary;
  definition: Record<string, JsonValue>;
}

export interface CollectionNote {
  collection_id: string;
  file_path: string;
  content: string;
  role: "context_only";
}

export interface SessionTranscriptExport {
  session: SessionRecord;
  messages: MessageRecord[];
  message_presentations: MessagePresentationRecord[];
  operations: OperationRecord[];
  policy_decisions: PolicyDecisionRecord[];
  audit_records: AuditRecord[];
  artifacts: ArtifactRecord[];
  backend_runs: BackendRunRecord[];
  backend_events: BackendEventRecord[];
  tool_runs: ToolRunRecord[];
  workspace_changes: WorkspaceChangeRecord[];
  change_history: ChangeHistoryEntry[];
  run_history: RunHistoryEntry[];
}

export interface ResourceTranslationResolution {
  status: ResourceTranslationRecord["status"];
  text: string;
  source: "translation" | "fallback";
  target_locale: ResourceTranslationRecord["target_locale"];
  translation?: ResourceTranslationRecord;
}

export interface WorkspaceLayoutCheck {
  path: string;
  exists: boolean;
  kind: "directory";
  required: boolean;
}

export interface WorkspaceDriftIssue {
  code: string;
  severity: "warning" | "error";
  message: string;
  file_path?: string;
  resource_id?: string;
}

export interface WorkspaceRepairStep {
  operation: string;
  reason: string;
  effect: string;
}

export type { WorkspaceResourceBoundary };

export interface WikiReindexResult {
  active: number;
  total: number;
  files: number;
  indexed: number;
  created: number;
  updated: number;
  removed: number;
  skipped: number;
  errors: Array<{ file_path: string; message: string }>;
}

export interface CollectionReindexResult {
  schemas: {
    files: number;
    indexed: number;
    created: number;
    updated: number;
    removed: number;
    skipped: number;
    errors: Array<{ file_path: string; message: string }>;
  };
  records: {
    files: number;
    indexed: number;
    created: number;
    updated: number;
    removed: number;
    skipped: number;
    errors: Array<{ file_path: string; message: string }>;
  };
}

export interface MemoryReindexResult {
  files: number;
  indexed: number;
  created: number;
  updated: number;
  removed: number;
  skipped: number;
  errors: Array<{ file_path: string; message: string }>;
}

export interface SkillReindexResult {
  files: number;
  indexed: number;
  created: number;
  updated: number;
  removed: number;
  skipped: number;
  errors: Array<{ file_path: string; message: string }>;
}

export interface WorkspaceHealthReport {
  ok: boolean;
  checked_at: string;
  root_dir: string;
  db_path: string;
  layout: { ok: boolean; checks: WorkspaceLayoutCheck[]; missing: string[] };
  resource_boundaries: WorkspaceResourceBoundary[];
  indexes: {
    search: { ok: boolean; mode: "fts5_trigram" | "fts5" | "like"; indexed: number; source_records: number; stale: boolean };
    wiki: {
      ok: boolean; files: number; indexed: number; active: number;
      missing_files: Array<{ id: string; file_path: string; title: string }>;
      unindexed_files: string[]; invalid_files: Array<{ file_path: string; message: string }>;
      duplicate_ids: Array<{ id: string; file_paths: string[] }>;
    };
    artifacts: {
      ok: boolean; files: number; indexed: number;
      missing_files: Array<{ id: string; file_path: string; title: string }>;
      unindexed_files: string[];
    };
    memory: {
      ok: boolean; files: number; indexed: number;
      missing_files: Array<{ id: string; file_path: string; topic: string }>;
      unindexed_files: string[]; invalid_files: Array<{ file_path: string; message: string }>;
      duplicate_ids: Array<{ id: string; file_paths: string[] }>;
    };
    skills: {
      ok: boolean; files: number; indexed: number;
      missing_files: Array<{ id: string; file_path: string; title: string }>;
      unindexed_files: string[]; invalid_files: Array<{ file_path: string; message: string }>;
      duplicate_ids: Array<{ id: string; file_paths: string[] }>;
    };
    collections: {
      ok: boolean;
      schemas: {
        files: number; indexed: number; missing_files: Array<{ id: string; file_path: string }>;
        unindexed_files: string[]; invalid_files: Array<{ file_path: string; message: string }>;
      };
      records: {
        files: number; indexed: number;
        missing_files: Array<{ id: string; collection_id: string; file_path: string }>;
        unindexed_files: string[]; invalid_files: Array<{ file_path: string; message: string }>;
      };
    };
  };
  issues: WorkspaceDriftIssue[];
  repair_plan: WorkspaceRepairStep[];
}

export interface MigrationJournalRecord {
  id: string;
  name: string;
  status: "completed" | "failed";
  details: Record<string, JsonValue>;
  created_at: string;
}

export interface WorkspaceIntegrityReport {
  ok: boolean;
  checked_at: string;
  db: { ok: boolean; result: string; path: string };
  workspace: WorkspaceHealthReport;
}

export interface WorkspaceRepairResult {
  dry_run: boolean;
  plan: WorkspaceRepairStep[];
  applied: string[];
  skipped: string[];
  wiki_reindex?: WikiReindexResult;
  memory_reindex?: MemoryReindexResult;
  skill_reindex?: SkillReindexResult;
  collection_reindex?: CollectionReindexResult;
  health: WorkspaceHealthReport;
}

export interface WorkspaceBackupManifest {
  id: string;
  created_at: string;
  source_root: string;
  db_file: string;
  file_roots: string[];
  resource_boundaries: WorkspaceResourceBoundary[];
  health_ok: boolean;
  integrity_ok: boolean;
  file_hashes: Record<string, string>;
}

export interface WorkspaceBackupRecord {
  id: string;
  path: string;
  manifest: WorkspaceBackupManifest;
}

export interface WorkspaceRestoreResult {
  backup_id: string;
  restored_at: string;
  restored_paths: string[];
  db_restored: boolean;
  manifest: WorkspaceBackupManifest;
  pre_restore_health: WorkspaceHealthReport;
  integrity: WorkspaceIntegrityReport;
  health: WorkspaceHealthReport;
}

export interface AutomationRunRecord {
  id: string;
  kind: string;
  source: string;
  session_id?: string;
  backend_run_id?: string;
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
