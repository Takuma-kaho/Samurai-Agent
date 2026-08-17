import type { WorkspaceRecordPayload } from "./types";

/** The productized Server 04 model deliberately does not reuse the legacy
 * `memory` / `workspace_rule` resource kinds. Those rows remain migration
 * input only. */
export const workspaceCompletionResourceKinds = ["knowledge", "skill", "policy"] as const;
export type WorkspaceCompletionResourceKind = (typeof workspaceCompletionResourceKinds)[number];

export const workspaceCompletionKnowledgeKinds = ["fact", "decision", "explanation", "experience_rule"] as const;
export type WorkspaceCompletionKnowledgeKind = (typeof workspaceCompletionKnowledgeKinds)[number];

export const workspaceCompletionScopeKinds = ["workspace", "room"] as const;
export type WorkspaceCompletionScopeKind = (typeof workspaceCompletionScopeKinds)[number];

export interface WorkspaceCompletionScope {
  kind: WorkspaceCompletionScopeKind;
  roomId?: string;
}

/** These axes must stay independent. `conflict` is represented by a Link and
 * contradicted evidence, never by hiding a resource as archived. */
export const workspaceCompletionEvidenceStates = ["provisional", "confirmed", "contradicted", "review_required"] as const;
export type WorkspaceCompletionEvidenceState = (typeof workspaceCompletionEvidenceStates)[number];

export const workspaceCompletionLifecycleStates = ["active", "stale", "archived"] as const;
export type WorkspaceCompletionLifecycleState = (typeof workspaceCompletionLifecycleStates)[number];

export const workspaceCompletionAiProtections = ["editable", "fixed"] as const;
export type WorkspaceCompletionAiProtection = (typeof workspaceCompletionAiProtections)[number];

export const workspaceCompletionCreationSources = ["human", "ai", "import", "machine_verified", "physical_file_import"] as const;
export type WorkspaceCompletionCreationSource = (typeof workspaceCompletionCreationSources)[number];

export const workspaceCompletionEpisodeOutcomes = ["succeeded", "failed", "unknown"] as const;
export type WorkspaceCompletionEpisodeOutcome = (typeof workspaceCompletionEpisodeOutcomes)[number];

export const workspaceCompletionActivityOutcomes = ["completed", "failed", "cancelled", "unknown"] as const;
export type WorkspaceCompletionActivityOutcome = (typeof workspaceCompletionActivityOutcomes)[number];

export const workspaceCompletionVerificationStates = ["confirmed", "failed", "not_run", "unknown"] as const;
export type WorkspaceCompletionVerificationState = (typeof workspaceCompletionVerificationStates)[number];

export const workspaceCompletionFailureStates = ["none", "resolved", "unresolved"] as const;
export type WorkspaceCompletionFailureState = (typeof workspaceCompletionFailureStates)[number];

export const workspaceCompletionJobKinds = ["review", "evaluation", "curator"] as const;
export type WorkspaceCompletionJobKind = (typeof workspaceCompletionJobKinds)[number];

export const workspaceCompletionJobStatuses = ["queued", "running", "completed", "failed", "blocked"] as const;
export type WorkspaceCompletionJobStatus = (typeof workspaceCompletionJobStatuses)[number];

export const workspaceCompletionPolicyEffects = ["allow", "deny", "require"] as const;
export type WorkspaceCompletionPolicyEffect = (typeof workspaceCompletionPolicyEffects)[number];

/** This list is deliberately closed. Policy never evaluates JavaScript, SQL,
 * a user supplied expression, or a model supplied tool call. */
export const workspaceCompletionPolicyOperations = [
  "activity.ingest",
  "resource.create",
  "resource.update",
  "resource.archive",
  "resource.copy",
  "resource.move",
  "resource.promote",
  "file.import",
  "curator.apply",
  "external.send",
  "policy.apply",
  "membership.change"
] as const;
export type WorkspaceCompletionPolicyOperation = (typeof workspaceCompletionPolicyOperations)[number];

export interface WorkspaceCompletionSessionRef {
  appId: string;
  sessionId?: string;
  turnId?: string;
  messageId?: string;
  resumeUrl?: string;
}

export interface WorkspaceCompletionActivity {
  workspaceId: string;
  roomId: string;
  id: string;
  principalAccountId: string;
  sourceApp: string;
  sourceId?: string;
  externalEpisodeKey?: string;
  correctionOfActivityId?: string;
  operationId?: string;
  instructionSummary: string;
  resultSummary?: string;
  changedResources: readonly string[];
  verificationOutcome: WorkspaceCompletionVerificationState;
  failureState: WorkspaceCompletionFailureState;
  outcome: WorkspaceCompletionActivityOutcome;
  explicitRemember: boolean;
  payload: WorkspaceRecordPayload;
  sessionRef?: WorkspaceCompletionSessionRef;
  createdAt: string;
  finalizedAt: string;
}

export interface WorkspaceCompletionEpisode {
  workspaceId: string;
  roomId: string;
  id: string;
  goal: string;
  sourceApp?: string;
  externalEpisodeKey?: string;
  outcome: WorkspaceCompletionEpisodeOutcome;
  startedAt: string;
  endedAt?: string;
  sessionRef?: WorkspaceCompletionSessionRef;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceCompletionResource {
  workspaceId: string;
  id: string;
  scope: WorkspaceCompletionScope;
  kind: WorkspaceCompletionResourceKind;
  knowledgeKind?: WorkspaceCompletionKnowledgeKind;
  title: string;
  evidenceState: WorkspaceCompletionEvidenceState;
  lifecycleState: WorkspaceCompletionLifecycleState;
  aiProtection: WorkspaceCompletionAiProtection;
  creationSource: WorkspaceCompletionCreationSource;
  aiManaged: boolean;
  /** Identity revision used for optimistic updates. */
  version: number;
  /** The version normal Context reads. It is never overwritten by an AI
   * proposal; candidate/provisional pointers coexist with it. */
  currentConfirmedVersion?: number;
  currentProvisionalVersion?: number;
  candidateVersion?: number;
  archivedAt?: string;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceCompletionResourceVersion {
  workspaceId: string;
  id: string;
  resourceId: string;
  version: number;
  parentVersion?: number;
  filePath: string;
  contentHash: string;
  contentSize: number;
  evidenceState: WorkspaceCompletionEvidenceState;
  lifecycleState: WorkspaceCompletionLifecycleState;
  aiProtection: WorkspaceCompletionAiProtection;
  creationSource: WorkspaceCompletionCreationSource;
  metadata: WorkspaceRecordPayload;
  reason: string;
  actorAccountId: string;
  createdAt: string;
}

/** A Skill package is versioned as one unit. `SKILL.md` is represented by the
 * ResourceVersion; these rows describe the optional package files it loads
 * progressively after that entry point. */
export interface WorkspaceCompletionSkillFile {
  workspaceId: string;
  id: string;
  resourceId: string;
  resourceVersion: number;
  relativePath: string;
  filePath: string;
  contentHash: string;
  contentSize: number;
  fileBatchId: string;
  createdAt: string;
}

export interface WorkspaceCompletionEvidence {
  workspaceId: string;
  id: string;
  resourceId: string;
  resourceVersion: number;
  activityId?: string;
  episodeId?: string;
  /** `unverified_claim` preserves a caller/AI assertion without letting it
   * count as machine proof. Only an Attestation Port can write
   * `machine_attestation`. */
  kind: "activity" | "human_edit" | "explicit_remember" | "use_outcome" | "machine_attestation" | "physical_file_import" | "unverified_claim";
  attestationId?: string;
  summary: string;
  createdAt: string;
}

export interface WorkspaceCompletionResourceLink {
  workspaceId: string;
  id: string;
  fromResourceId: string;
  toResourceId: string;
  relation: "conflicts" | "copied_from" | "moved_from" | "promoted_from" | "derived_from" | "supersedes";
  createdAt: string;
}

export interface WorkspaceCompletionPolicyRule {
  id: string;
  operation: WorkspaceCompletionPolicyOperation;
  effect: WorkspaceCompletionPolicyEffect;
  principalAccountId?: string;
  connectionId?: string;
  /** Only finite condition values are allowed. Their interpretation is fixed
   * by the Server, not supplied as an expression language. */
  conditions: Readonly<Record<string, string | number | boolean>>;
}

export interface WorkspaceCompletionPolicy extends WorkspaceCompletionResource {
  kind: "policy";
  rules: readonly WorkspaceCompletionPolicyRule[];
  enabled: boolean;
  /** The immutable approval record, not an arbitrary value from a request body. */
  approvalId?: string;
  signedBy?: string;
}

/** An AI or connected app may request a Policy change, but this record is
 * not itself an active Policy and has no authority until a human applies a
 * separately signed Policy version. */
export interface WorkspaceCompletionPolicyChangeRequest {
  workspaceId: string;
  roomId: string;
  id: string;
  requestedBy: string;
  sourceJobId?: string;
  summary: string;
  proposedRules: readonly WorkspaceCompletionPolicyRule[];
  status: "requested" | "applied" | "rejected";
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceCompletionUseEvent {
  workspaceId: string;
  id: string;
  resourceId: string;
  resourceVersion: number;
  activityId?: string;
  episodeId?: string;
  event: "selected" | "body_loaded" | "support_loaded" | "actually_used" | "outcome" | "correction";
  outcome?: "confirmed_success" | "confirmed_failure" | "unknown";
  supersedesUseId?: string;
  summary: string;
  createdAt: string;
}

export interface WorkspaceCompletionEvaluation {
  workspaceId: string;
  id: string;
  resourceId: string;
  resourceVersion: number;
  episodeId: string;
  outcome: "confirmed_success" | "confirmed_failure" | "unknown";
  sourceActivityId?: string;
  correctionOfEvaluationId?: string;
  createdAt: string;
}

export interface WorkspaceCompletionJob {
  workspaceId: string;
  roomId: string;
  id: string;
  kind: WorkspaceCompletionJobKind;
  status: WorkspaceCompletionJobStatus;
  idempotencyKey: string;
  groupKey?: string;
  highWatermark?: string;
  inputHash: string;
  configurationVersion: number;
  attemptCount: number;
  maxAttempts: number;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  heartbeatAt?: string;
  blockedReason?: string;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface WorkspaceCompletionJobAttempt {
  workspaceId: string;
  id: string;
  jobId: string;
  attemptNo: number;
  workerId: string;
  status: "running" | "completed" | "failed" | "blocked" | "repairable_validation";
  inputHash: string;
  outputHash?: string;
  errorCode?: string;
  configurationVersion: number;
  startedAt: string;
  completedAt?: string;
}

export interface WorkspaceCompletionConfiguration {
  workspaceId: string;
  scope: WorkspaceCompletionScope;
  version: number;
  values: WorkspaceCompletionTuning;
  updatedBy: string;
  createdAt: string;
}

/** All tunable operational values live in this one versioned object. Public
 * API names and persistent internal paths do not become user settings. */
export interface WorkspaceCompletionTuning {
  reviewMaxAttempts: number;
  /** Hard cap for a complete Review input. Exceeding it blocks the Job; it
   * never silently truncates the Episode at an arbitrary page size. */
  reviewSnapshotMaxItems: number;
  experienceRuleEpisodeSuccesses: number;
  skillEpisodeSuccesses: number;
  curatorLightIntervalHours: number;
  curatorSemanticIntervalDays: number;
  curatorMinimumIdleHours: number;
  /** Curator plans are all-or-nothing snapshots.  Above this bound a Job is
   * blocked instead of silently sending a partial Room to a Port. */
  curatorSnapshotMaxItems: number;
  curatorSnapshotLimit: number;
  skillStaleAfterDays: number;
  skillArchiveAfterDays: number;
  provisionalKnowledgeArchiveAfterDays: number;
  rawJobOutputRetentionDays: number;
  verificationLoadRooms: number;
  verificationLoadActivities: number;
  verificationLoadKnowledge: number;
  verificationLoadSkills: number;
}

export const workspaceCompletionDefaultTuning: Readonly<WorkspaceCompletionTuning> = Object.freeze({
  reviewMaxAttempts: 3,
  reviewSnapshotMaxItems: 10_000,
  experienceRuleEpisodeSuccesses: 3,
  skillEpisodeSuccesses: 3,
  curatorLightIntervalHours: 24,
  curatorSemanticIntervalDays: 7,
  curatorMinimumIdleHours: 2,
  curatorSnapshotMaxItems: 1_000,
  curatorSnapshotLimit: 20,
  skillStaleAfterDays: 30,
  skillArchiveAfterDays: 90,
  provisionalKnowledgeArchiveAfterDays: 90,
  rawJobOutputRetentionDays: 90,
  verificationLoadRooms: 100,
  verificationLoadActivities: 100_000,
  verificationLoadKnowledge: 10_000,
  verificationLoadSkills: 1_000
});

export interface WorkspaceCompletionFileEntry {
  path: string;
  content: Uint8Array;
  sha256: string;
}

export interface WorkspaceCompletionFileBatch {
  workspaceId: string;
  id: string;
  scope: WorkspaceCompletionScope;
  status: "db_committed" | "renamed" | "rolled_back";
  entries: readonly WorkspaceCompletionFileEntry[];
  createdAt: string;
}

/**
 * The Core only knows this narrow cassette.  HTTP/OAuth/provider SDKs stay on
 * the Host side, and only the structured outcome is durable evidence.
 */
export interface WorkspaceCompletionAttestationRequest {
  workspaceId: string;
  scope: WorkspaceCompletionScope;
  target: {
    activityId?: string;
    resourceId?: string;
    resourceVersion?: number;
  };
  sourceRef: string;
  sourceVersion: string;
  expectedContentHash: string;
  items: Readonly<Record<string, string | number | boolean>>;
}

export interface WorkspaceCompletionAttestationResult {
  outcome: "confirmed" | "failed" | "not_run";
  attestorId: string;
  sourceVersion: string;
  observedContentHash?: string;
  attestedAt: string;
  failureReasons: readonly { code: string; message: string }[];
}

export interface WorkspaceCompletionAttestationPort {
  attest(input: WorkspaceCompletionAttestationRequest): Promise<WorkspaceCompletionAttestationResult>;
}

export interface WorkspaceCompletionAttestation {
  workspaceId: string;
  id: string;
  activityId?: string;
  resourceId?: string;
  resourceVersion?: number;
  sourceRef: string;
  sourceVersion: string;
  expectedContentHash: string;
  observedContentHash?: string;
  outcome: "confirmed" | "failed" | "not_run";
  attestorId: string;
  failureReasons: readonly { code: string; message: string }[];
  attestedAt: string;
  createdAt: string;
}
