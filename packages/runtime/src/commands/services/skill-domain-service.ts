import {
  createId,
  nowIso,
  stableHash,
  ObjectiveRecordSchema,
  WorkItemRecordSchema,
  ResourceRefSchema,
  type BackendRunRecord,
  type CuratorLifecycleAction,
  type JsonValue,
  type LearningResourceUseRecord,
  type ActivityInboxItem,
  type MessageEnvelope,
  type ObjectiveRecord,
  type OperationRecord,
  type OptimizationCandidate,
  type OptimizationEvaluation,
  type OptimizationPromotion,
  type ResourceRef,
  type RollbackPoint,
  type SessionRecord,
  type SkillFrontmatter,
  type SkillOptimizationDataset,
  type SkillOptimizationRun,
  type SkillOptimizationSnapshot,
  type SkillUsageRecord,
  type WorkItemRecord
} from "@samurai-agent/core-schemas";
import type { TrustedDomainContext } from "@samurai-agent/domain-operations";
import { jsonValue } from "./json-value.js";
import {
  buildSkillOptimizationDataset,
  evaluateOptimizationGates,
  evaluateSkillOptimizationSafety,
  startPythonSkillOptimization,
  type OptimizationExampleInput,
  type PythonSkillOptimizationCandidate,
  type PythonSkillOptimizationResult
} from "@samurai-agent/skill-optimization";
import path from "node:path";
import { z } from "zod";

type SkillApplyAction = Exclude<CuratorLifecycleAction, "review">;

export interface StoredSkill {
  id: string;
  title: string;
  description: string;
  tags: string[];
  state: SkillFrontmatter["state"];
  allowed_scopes: SkillFrontmatter["allowed_scopes"];
  required_capabilities: string[];
  owner_pinned: boolean;
  frontmatter: SkillFrontmatter;
  file_path: string;
  resource_version?: number;
}

interface SkillWriteResult<T> {
  resource: T;
  operation: OperationRecord;
  rollbackPoint?: RollbackPoint;
  activity: ActivityInboxItem[];
}

export interface OptimizationSkill extends ReadableSkill {
  title: string;
  frontmatter: SkillFrontmatter;
  room_id?: string;
}

export interface SkillOptimizationPort<TSkill extends OptimizationSkill> {
  repoRoot(): string;
  getSkill(id: string): Promise<TSkill | undefined>;
  readMarkdown(id: string): Promise<string | undefined>;
  listUses(input: { resourceId: string }): Promise<LearningResourceUseRecord[]>;
  getBackendRun(id: string): Promise<BackendRunRecord | undefined>;
  getSession(id: string): Promise<{ id: string; ui_locale: string; output_locale: string; room_id?: string } | undefined>;
  acquireLock(input: { skillId: string; runId: string; acquiredAt: string }): Promise<boolean>;
  getLock(skillId: string): Promise<{ run_id: string } | undefined>;
  releaseLock(input: { skillId: string; runId: string }): Promise<boolean>;
  saveDataset(record: SkillOptimizationDataset): Promise<SkillOptimizationDataset>;
  saveObjective(record: ObjectiveRecord, roomId: string): Promise<ObjectiveRecord>;
  getObjective(id: string, roomId: string): Promise<ObjectiveRecord | undefined>;
  updateObjective(record: ObjectiveRecord, roomId: string): Promise<ObjectiveRecord>;
  saveWorkItem(record: WorkItemRecord, roomId: string): Promise<WorkItemRecord>;
  getWorkItem(id: string, roomId: string): Promise<WorkItemRecord | undefined>;
  claimWorkItem(input: { workerId: string; leaseMs: number; now: string; roomId: string }): Promise<WorkItemRecord | undefined>;
  completeWorkItem(input: { workItemId: string; workerId: string; roomId: string }): Promise<WorkItemRecord | undefined>;
  failWorkItem(input: { workItemId: string; workerId: string; roomId: string; failureKind: "retryable" | "cancelled" | "non_retryable"; error: string }): Promise<WorkItemRecord | undefined>;
  getRun(id: string): Promise<SkillOptimizationRun | undefined>;
  saveRun(record: SkillOptimizationRun): Promise<SkillOptimizationRun>;
  getCandidate(id: string): Promise<OptimizationCandidate | undefined>;
  saveCandidate(record: OptimizationCandidate): Promise<OptimizationCandidate>;
  saveEvaluation(record: OptimizationEvaluation): Promise<OptimizationEvaluation>;
  getSnapshot(id: string): Promise<SkillOptimizationSnapshot | undefined>;
  saveSnapshot(record: SkillOptimizationSnapshot): Promise<SkillOptimizationSnapshot>;
  listPromotions(): Promise<OptimizationPromotion[]>;
  savePromotion(record: OptimizationPromotion): Promise<OptimizationPromotion>;
  replaceContentIfUnchanged(input: { id: string; expectedContentHash: string; content: string; lockRunId?: string }): Promise<TSkill | undefined>;
  savePresentations(input: { sessionId: string; run: SkillOptimizationRun; candidates: OptimizationCandidate[] }): Promise<void>;
  hostComplete(input: { sessionId?: string; messages: Array<{ role: string; content: string }> }): Promise<{ content: string }>;
  requestError(code: "not_found" | "conflict" | "provider_not_configured", message: string): Error;
  errorMessage(error: unknown, fallback?: string): string;
}

export interface SkillMutationPort {
  getSkill(id: string): Promise<StoredSkill | undefined>;
  readMarkdown(id: string): Promise<string | undefined>;
  patchSkill(input: { id: string; title?: string; description?: string; tags?: string[]; content?: string; pinned?: boolean; usage_scope?: SkillFrontmatter["usage_scope"]; expected_resource_version?: number }): Promise<StoredSkill | undefined>;
  copySkill(input: {
    source_id: string;
    target_id: string;
    target_usage_scope: NonNullable<SkillFrontmatter["usage_scope"]>;
    expected_source_resource_version: number;
    target_boundary?: { sourceRoomId: string; ownerParticipantId: string; creatorParticipantId?: string; resourceCreatedAt?: string };
  }): Promise<StoredSkill | undefined>;
  moveSkill(input: {
    id: string;
    source_room_id: string;
    target_room_id: string;
    expected_resource_version: number;
  }): Promise<StoredSkill | undefined>;
  updateState(id: string, state: SkillFrontmatter["state"]): Promise<StoredSkill | undefined>;
  saveMarkdown(input: { state: "candidate" | "project"; skillId: string; markdown: string }): Promise<StoredSkill>;
  listSupportFiles(id: string): Promise<Array<{ path: string; file_path: string; content: string }>>;
  writeSupportFile(input: { skillId: string; path: string; content: string }): Promise<{ path: string; file_path: string; content: string }>;
  ensureSession(): Promise<SessionRecord>;
  createEnvelope(content: string): MessageEnvelope;
  runMutation<T>(input: { session?: SessionRecord; envelope?: MessageEnvelope; trustedContext?: TrustedDomainContext; operationName: string; proposedEffects: string[]; inputSummary?: string; targetResourceRefs?: ResourceRef[]; boundaryResourceRefs?: ResourceRef[]; resultResourceBoundaryMode?: "managed_by_operation"; skipPostMutationTargetBoundaryCheck?: boolean; execute(operation: OperationRecord): Promise<{ resource: T; ref: ResourceRef; rollbackPoint?: RollbackPoint; summary: string }> }): Promise<SkillWriteResult<T>>;
  createRollback(operation: OperationRecord, refs: ResourceRef[], before: Record<string, JsonValue>, after: Record<string, JsonValue>): Promise<RollbackPoint>;
  requestError(code: "not_found", message: string): Error;
  mapWriteError(error: unknown): Error;
  contract(id: "skill.patch" | "skill.candidate.create" | "skill.project.save" | "skill.support_file.save"): { id: string; proposed_effects: string[] };
}

export interface SkillReadPort<TSkill extends ReadableSkill> {
  getSkill(id: string): Promise<TSkill | undefined>;
  getRun(id: string): Promise<BackendRunRecord | undefined>;
  getSession(id: string): Promise<{ id: string; room_id?: string } | undefined>;
  getAgent(id: string): Promise<{ id: string } | undefined>;
  readSupportFile(input: { skillId: string; path: string }): Promise<{ path: string; file_path: string; content: string } | undefined>;
  readMarkdown(id: string): Promise<string | undefined>;
  listSupportFiles(id: string): Promise<Array<{ path: string; file_path: string }>>;
}

export interface ReadableSkill {
  id: string;
  state: SkillFrontmatter["state"];
  file_path: string;
}

export interface SkillUsagePort {
  listUses(input: { runId: string; resourceId: string }): Promise<LearningResourceUseRecord[]>;
  recordUse(record: LearningResourceUseRecord): Promise<LearningResourceUseRecord>;
  incrementSkillUsage(input: { skillId: string; runId: string }): Promise<SkillUsageRecord>;
}

export interface SkillLifecycleRequest {
  skillId: string;
  action: SkillApplyAction;
}

export interface SkillOptimizationStartRequest {
  skillId: string;
  sessionId?: string;
  roomId: string;
  objective?: string;
  goldenExamples?: readonly JsonValue[];
  syntheticExamples?: readonly JsonValue[];
}

/** A Skill optimization run is not a BackendRun. Keep its identifier named at every boundary. */
export interface SkillOptimizationRunRequest { optimizationRunId: string; roomId: string; }
export interface SkillOptimizationCandidateRequest extends SkillOptimizationRunRequest { candidateId: string; }
export interface SkillOptimizationRollbackRequest { promotionId?: string; snapshotId?: string; roomId: string; }
export interface SkillUsageRecordRequest {
  skillId: string;
  runId: string;
  resourceId: string;
  contentHash: string;
  stage: "body_loaded" | "support_loaded";
  metadata: Record<string, JsonValue>;
}
export interface SkillViewRequest { skillId: string; runId: string; path?: string; }

export class SkillDomainService<TSkill extends OptimizationSkill = OptimizationSkill> {
  private readonly optimizationWorkers = new Map<string, { cancel: () => void }>();
  private readonly autoStartOptimization: boolean;

  constructor(private readonly dependencies: {
    optimization: SkillOptimizationPort<TSkill>;
    queries: SkillReadPort<TSkill>;
    usage: SkillUsagePort;
    mutation: SkillMutationPort;
    conflictError: (message: string) => Error;
  }, options: { autoStartOptimization?: boolean } = {}) {
    this.autoStartOptimization = options.autoStartOptimization ?? true;
  }

  getSkillForMutation(id: string) { return this.dependencies.mutation.getSkill(id); }
  readSkillMarkdown(id: string) { return this.dependencies.mutation.readMarkdown(id); }
  saveSkillMarkdown(input: { state: "candidate" | "project"; skillId: string; markdown: string }) { return this.dependencies.mutation.saveMarkdown(input); }
  listSkillSupportFiles(id: string) { return this.dependencies.mutation.listSupportFiles(id); }
  writeSkillSupportFile(input: { skillId: string; path: string; content: string }) { return this.dependencies.mutation.writeSupportFile(input); }
  skillMutationContract(id: "skill.patch" | "skill.candidate.create" | "skill.project.save" | "skill.support_file.save") { return this.dependencies.mutation.contract(id); }
  skillResourceRef(skill: StoredSkill) { return skillRef(skill); }
  createSkillRollback(operation: OperationRecord, refs: ResourceRef[], before: Record<string, JsonValue>, after: Record<string, JsonValue>) { return this.dependencies.mutation.createRollback(operation, refs, before, after); }
  runSkillMutation<T>(input: { session?: SessionRecord; envelope?: MessageEnvelope; trustedContext?: TrustedDomainContext; operationName: string; proposedEffects: string[]; inputSummary?: string; targetResourceRefs?: ResourceRef[]; boundaryResourceRefs?: ResourceRef[]; resultResourceBoundaryMode?: "managed_by_operation"; skipPostMutationTargetBoundaryCheck?: boolean; execute(operation: OperationRecord): Promise<{ resource: T; ref: ResourceRef; rollbackPoint?: RollbackPoint; summary: string }> }) { return this.dependencies.mutation.runMutation<T>(input); }
  skillMutationNotFound(message: string) { return this.dependencies.mutation.requestError("not_found", message); }
  skillMutationConflict(message: string) { return this.dependencies.conflictError(message); }
  mapSkillWriteError(error: unknown) { return this.dependencies.mutation.mapWriteError(error); }
  patchSkillRecord(input: { id: string; title?: string; description?: string; tags?: string[]; content?: string; pinned?: boolean; usage_scope?: SkillFrontmatter["usage_scope"]; expected_resource_version?: number }) { return this.dependencies.mutation.patchSkill(input); }
  copySkill(input: Parameters<SkillMutationPort["copySkill"]>[0]) { return this.dependencies.mutation.copySkill(input); }
  moveSkill(input: Parameters<SkillMutationPort["moveSkill"]>[0]) { return this.dependencies.mutation.moveSkill(input); }

  applyLifecycle(input: SkillLifecycleRequest) { return this.applyLifecycleInput(input); }

  async applyLifecycleInput(input: { skillId: string; action: SkillApplyAction }): Promise<SkillWriteResult<StoredSkill>> {
    const targetState = lifecycleTargetState(input.action);
    if (!targetState) throw this.dependencies.conflictError("curator_review_has_no_state_transition");
    const current = await this.dependencies.mutation.getSkill(input.skillId);
    if (!current) throw this.dependencies.mutation.requestError("not_found", `Skill not found: ${input.skillId}`);
    if (current.state === "pinned" || current.frontmatter?.owner_pinned) throw this.dependencies.conflictError("curator_skill_is_pinned");
    const beforeMarkdown = await this.dependencies.mutation.readMarkdown(input.skillId);
    const session = await this.dependencies.mutation.ensureSession();
    const envelope = this.dependencies.mutation.createEnvelope(`Apply curator skill lifecycle: ${input.action} ${current.title}`);
    return this.dependencies.mutation.runMutation({ session, envelope, operationName: "skill.lifecycle.apply",
      proposedEffects: [`Set Skill ${current.title} state to ${targetState}.`], targetResourceRefs: [skillRef(current)],
      execute: async (operation) => {
        const saved = await this.dependencies.mutation.updateState(input.skillId, targetState);
        if (!saved) throw this.dependencies.mutation.requestError("not_found", `Skill not found: ${input.skillId}`);
        const ref = skillRef(saved); const rollbackPoint = await this.dependencies.mutation.createRollback(operation, [ref],
          { skill: jsonValue(current), markdown: beforeMarkdown ?? "" },
          { skill: jsonValue(saved), action: input.action, target_state: targetState });
        return { resource: saved, ref, rollbackPoint, summary: `Applied curator lifecycle ${input.action} to Skill ${saved.title}.` };
      }
    });
  }

  cancelOptimization(input: SkillOptimizationRunRequest) { return this.cancelOptimizationRun(input); }
  promoteOptimization(input: SkillOptimizationCandidateRequest) { return this.promoteOptimizationRun(input); }
  rejectOptimization(input: SkillOptimizationCandidateRequest) { return this.rejectOptimizationRun(input); }
  rollbackOptimization(input: SkillOptimizationRollbackRequest) { return this.rollbackOptimizationRun(input); }
  startOptimization(input: SkillOptimizationStartRequest) { return this.startOptimizationRun(input); }

  /**
   * Runs a previously claimed optimization work item. The standard
   * PostgreSQL composition calls this from its process-owned Worker; the
   * legacy Runtime composition may still use the immediate path below.
   */
  runClaimedOptimization(input: {
    run: SkillOptimizationRun;
    dataset: SkillOptimizationDataset;
    skillBody: string;
    skillId: string;
    sessionId?: string;
    workerId: string;
    roomId: string;
    signal?: AbortSignal;
    /** A supervisor shutdown must leave the durable work item retryable. */
    retryOnAbort?: boolean;
  }): Promise<void> {
    return this.runOptimizationWorker(input);
  }

  private async startOptimizationRun(input: SkillOptimizationStartRequest): Promise<{ run: SkillOptimizationRun; dataset: SkillOptimizationDataset; objective: ObjectiveRecord; work_item: WorkItemRecord }> {
    const skillId = input.skillId;
    const skill = await this.dependencies.optimization.getSkill(skillId);
    const markdown = await this.dependencies.optimization.readMarkdown(skillId);
    if (!skill || markdown === undefined) throw this.dependencies.optimization.requestError("not_found", "skill_not_found");
    if (skill.room_id !== undefined && skill.room_id !== input.roomId) {
      throw this.dependencies.optimization.requestError("conflict", "skill_optimization_room_access_denied");
    }
    if (skill.state === "archived" || skill.state === "candidate") {
      throw this.dependencies.optimization.requestError("conflict", "skill_not_optimizable_in_current_state");
    }
    const sessionId = input.sessionId;
    if (sessionId) {
      const session = await this.dependencies.optimization.getSession(sessionId);
      if (!session) throw this.dependencies.optimization.requestError("not_found", "skill_optimization_session_not_found");
      if (session.room_id !== undefined && session.room_id !== input.roomId) {
        throw this.dependencies.optimization.requestError("conflict", "skill_optimization_session_room_access_denied");
      }
    }
    const skillBody = skillMarkdownContent(markdown);
    const baselineContentHash = stableHash(skillBody);
    const real = await this.optimizationRealExamples(skill, baselineContentHash);
    const golden = optimizationExamplesFromValues(input.goldenExamples, "golden");
    const synthetic = optimizationExamplesFromValues(input.syntheticExamples, "synthetic");
    let dataset: SkillOptimizationDataset;
    try {
      dataset = buildSkillOptimizationDataset({ skill_id: skill.id, real, golden, synthetic });
    } catch (error) {
      throw this.dependencies.optimization.requestError("conflict", this.dependencies.optimization.errorMessage(error, "skill_optimization_dataset_invalid"));
    }

    const now = nowIso();
    const runId = createId("skill_optimization_run");
    const objective: ObjectiveRecord = ObjectiveRecordSchema.parse({
      id: createId("objective"), ...(sessionId ? { session_id: sessionId } : {}), room_id: input.roomId,
      title: `Skill改善: ${skill.title}`,
      objective: input.objective || `Skill「${skill.title}」の本文をGEPAで改善候補化する`,
      completion_criteria: ["GEPA候補を生成する", "holdout評価と安全検証を記録する", "ユーザー確認後にのみ反映する"],
      status: "active", max_attempts: 1, created_at: now, updated_at: now
    });
    const workItem: WorkItemRecord = WorkItemRecordSchema.parse({
      id: createId("work"), objective_id: objective.id, room_id: input.roomId,
      instruction: `GEPAでSkill ${skill.id} の改善候補を生成・評価する`, status: "ready", priority: 5,
      attempt: 0, max_attempts: 3, idempotency_key: `skill-optimization:${runId}`, created_at: now, updated_at: now
    });
    const run: SkillOptimizationRun = {
      id: runId, ...(sessionId ? { session_id: sessionId } : {}), target_skill_id: skill.id,
      baseline_content_hash: baselineContentHash,
      baseline_version: stableHash({ skill_id: skill.id, content_hash: baselineContentHash, reviewed_at: skill.frontmatter.last_reviewed_at ?? "" }),
      dataset_id: dataset.id, objective_id: objective.id, work_item_id: workItem.id,
      optimizer: "gepa", optimizer_version: "dspy==3.2.1", status: "queued", phase: "dataset", progress: 0.05,
      candidate_ids: [], trace_refs: [optimizationSkillRef(skill)],
      provenance: { optimizer: "gepa", worker: "workers/skill-optimization/worker.py", dataset_id: dataset.id,
        baseline_content_hash: baselineContentHash, selected_real_examples: real.length,
        selected_golden_examples: golden.length, selected_synthetic_examples: synthetic.length },
      created_at: now, updated_at: now, started_at: now
    };
    if (!await this.dependencies.optimization.acquireLock({ skillId: skill.id, runId, acquiredAt: now })) {
      throw this.dependencies.optimization.requestError("conflict", "skill_optimization_already_running");
    }
    const workerId = `skill-optimization:${runId}`;
    let runSaved = false;
    try {
      // Persist the Run before its supporting records so a partial setup is
      // still addressable and can be settled visibly after a process error.
      await this.dependencies.optimization.saveRun(run);
      runSaved = true;
      await this.dependencies.optimization.saveDataset(dataset);
      await this.dependencies.optimization.saveObjective(objective, input.roomId);
      await this.dependencies.optimization.saveWorkItem(workItem, input.roomId);
      if (!this.autoStartOptimization) {
        return { run, dataset, objective, work_item: workItem };
      }
      const claimed = await this.dependencies.optimization.claimWorkItem({ workerId, leaseMs: 24 * 60 * 60 * 1000, now, roomId: input.roomId });
      if (!claimed || claimed.id !== workItem.id) throw new Error("skill_optimization_work_item_claim_failed");
      const runningRun: SkillOptimizationRun = { ...run, status: "running", phase: "optimizing", progress: 0.1, updated_at: now };
      await this.dependencies.optimization.saveRun(runningRun);
      void this.runOptimizationWorker({ run: runningRun, dataset, skillBody, skillId: skill.id, sessionId, workerId, roomId: input.roomId });
      return { run: runningRun, dataset, objective, work_item: claimed };
    } catch (error) {
      if (runSaved) await this.settleOptimizationStartFailure({ run, objective, workItem, workerId, roomId: input.roomId, error });
      await this.dependencies.optimization.releaseLock({ skillId: skill.id, runId });
      throw error;
    }
  }

  private async settleOptimizationStartFailure(input: {
    run: SkillOptimizationRun;
    objective: ObjectiveRecord;
    workItem: WorkItemRecord;
    workerId: string;
    roomId: string;
    error: unknown;
  }): Promise<void> {
    const port = this.dependencies.optimization;
    const now = nowIso();
    const errorCode = port.errorMessage(input.error, "skill_optimization_start_failed");
    await port.saveRun({ ...input.run, status: "failed", phase: "failed", progress: 1, error: errorCode, updated_at: now, completed_at: now }).catch(() => undefined);
    const objective = await port.getObjective(input.objective.id, input.roomId).catch(() => undefined);
    if (objective?.status === "active") {
      await port.updateObjective({ ...objective, status: "failed", updated_at: now, completed_at: now }, input.roomId).catch(() => undefined);
    }
    const workItem = await port.getWorkItem(input.workItem.id, input.roomId).catch(() => undefined);
    if (!workItem || ["completed", "failed", "cancelled"].includes(workItem.status)) return;
    if (workItem.status === "running" && workItem.lease_owner === input.workerId) {
      await port.failWorkItem({ workItemId: workItem.id, workerId: input.workerId, roomId: input.roomId, failureKind: "non_retryable", error: errorCode }).catch(() => undefined);
      return;
    }
    await port.saveWorkItem({
      ...workItem,
      status: "failed",
      lease_owner: undefined,
      lease_expires_at: undefined,
      heartbeat_at: undefined,
      failure_kind: "non_retryable",
      error: errorCode,
      updated_at: now,
      completed_at: now
    }, input.roomId).catch(() => undefined);
  }

  private async optimizationRealExamples(skill: TSkill, baselineContentHash: string): Promise<OptimizationExampleInput[]> {
    const uses = (await this.dependencies.optimization.listUses({ resourceId: skill.id }))
      .filter((use) => use.resource_kind === "skill" && use.stage === "body_loaded" && use.content_hash === baselineContentHash);
    const examples: OptimizationExampleInput[] = [];
    const seenPrompts = new Set<string>();
    for (const use of uses) {
      const run = await this.dependencies.optimization.getBackendRun(use.run_id);
      if (!run || run.status !== "completed" || !run.input_summary.trim() || !run.output_summary?.trim()) continue;
      const prompt = run.input_summary.trim();
      if (seenPrompts.has(prompt)) continue;
      seenPrompts.add(prompt);
      const feedback = typeof use.metadata.feedback === "string" && use.metadata.feedback.trim()
        ? use.metadata.feedback : `実行結果: ${run.output_summary.trim()}`;
      examples.push({ prompt, expected_behavior: run.output_summary.trim(), feedback, source: "real",
        skill_body_read_run_id: run.id, trace_refs: [optimizationBackendRunRef(run), optimizationSkillRef(skill)],
        metadata: { run_status: run.status, source_stage: use.stage } });
    }
    return examples;
  }

  private async runOptimizationWorker(input: { run: SkillOptimizationRun; dataset: SkillOptimizationDataset; skillBody: string; skillId: string; sessionId?: string; workerId: string; roomId: string; signal?: AbortSignal; retryOnAbort?: boolean }): Promise<void> {
    const worker = startPythonSkillOptimization({
      run_id: input.run.id, skill_id: input.skillId, skill_body: input.skillBody, dataset: input.dataset,
      worker_script: path.resolve(this.dependencies.optimization.repoRoot(), "workers/skill-optimization/worker.py"),
      cwd: this.dependencies.optimization.repoRoot(),
      host_complete: (messages) => this.dependencies.optimization.hostComplete({ sessionId: input.sessionId, messages }),
      on_progress: (progress) => {
        void this.updateOptimizationRun(input.run.id, { phase: progress.phase === "evaluating" ? "evaluating" : "optimizing",
          progress: Math.max(0.1, Math.min(0.95, progress.value)), provenance: { ...input.run.provenance,
            last_progress_message: progress.message ?? "", worker_phase: progress.phase } }).catch(() => undefined);
      }
    });
    this.optimizationWorkers.set(input.run.id, { cancel: worker.cancel });
    const abort = () => worker.cancel();
    input.signal?.addEventListener("abort", abort, { once: true });
    let result: PythonSkillOptimizationResult;
    try { result = await worker.promise; }
    catch (error) { result = { status: "failed", feedback: [], trace: [], optimizer_version: "dspy==3.2.1", error: this.dependencies.optimization.errorMessage(error) }; }
    finally {
      input.signal?.removeEventListener("abort", abort);
      this.optimizationWorkers.delete(input.run.id);
    }
    await this.finishOptimization({ ...input, result });
  }

  private async updateOptimizationRun(id: string, patch: Partial<SkillOptimizationRun>): Promise<SkillOptimizationRun | undefined> {
    const current = await this.dependencies.optimization.getRun(id);
    if (!current) return undefined;
    return this.dependencies.optimization.saveRun({ ...current, ...patch, updated_at: nowIso() });
  }

  private async finishOptimization(input: { run: SkillOptimizationRun; dataset: SkillOptimizationDataset; skillBody: string; skillId: string; sessionId?: string; workerId: string; roomId: string; signal?: AbortSignal; retryOnAbort?: boolean; result: PythonSkillOptimizationResult }): Promise<void> {
    const port = this.dependencies.optimization;
    const current = await port.getRun(input.run.id) ?? input.run;
    const settleWork = async (kind: "complete" | "failed" | "cancelled" | "retryable", error?: string) => {
      const settled = kind === "complete"
        ? await port.completeWorkItem({ workItemId: current.work_item_id, workerId: input.workerId, roomId: input.roomId })
        : await port.failWorkItem({ workItemId: current.work_item_id, workerId: input.workerId, roomId: input.roomId,
          failureKind: kind === "cancelled" ? "cancelled" : kind === "failed" ? "non_retryable" : "retryable", error: error ?? kind });
      if (!settled) throw new Error("skill_optimization_work_item_lease_lost");
    };
    const settleObjective = async (status: ObjectiveRecord["status"]) => {
      const objective = await port.getObjective(current.objective_id, input.roomId);
      if (objective?.status === "active") {
        const terminal = status === "completed" || status === "cancelled" || status === "failed";
        await port.updateObjective({ ...objective, status, updated_at: nowIso(), ...(terminal ? { completed_at: nowIso() } : {}) }, input.roomId);
      }
    };
    const candidateInputs: PythonSkillOptimizationCandidate[] = (input.result.candidates ?? []).filter((candidate) => candidate.body.trim().length > 0);
    if (candidateInputs.length === 0 && input.result.candidate_body?.trim()) {
      candidateInputs.push({ index: 0, body: input.result.candidate_body.trim(),
        ...(typeof input.result.baseline_holdout_score === "number" ? { baseline_holdout_score: input.result.baseline_holdout_score } : {}),
        ...(typeof input.result.holdout_score === "number" ? { holdout_score: input.result.holdout_score } : {}),
        ...(typeof input.result.important_regression === "boolean" ? { important_regression: input.result.important_regression } : {}),
        evaluations: input.result.evaluations ?? [], feedback: input.result.feedback });
    }
    if (input.result.status !== "completed" || candidateInputs.length === 0) {
      if (input.retryOnAbort && input.signal?.aborted) {
        const error = input.result.error || "skill_optimization_worker_shutdown";
        await port.saveRun({ ...current, status: "queued", phase: "dataset", progress: Math.min(current.progress, 0.1), error, updated_at: nowIso(), completed_at: undefined });
        await settleWork("retryable", error);
        await port.releaseLock({ skillId: input.skillId, runId: current.id });
        return;
      }
      const status = input.result.status === "cancelled" ? "cancelled" : "failed";
      const error = input.result.error || "gepa_candidate_not_created";
      await port.saveRun({ ...current, status, phase: status, progress: 1, error, updated_at: nowIso(), completed_at: nowIso() });
      await settleWork(status === "cancelled" ? "cancelled" : "failed", error);
      await settleObjective(status === "cancelled" ? "cancelled" : "failed");
      await port.releaseLock({ skillId: input.skillId, runId: current.id });
      return;
    }
    if (current.status === "cancelled" || current.status === "failed") {
      return;
    }

    const relatedTestsPassed = input.result.related_tests_passed === true;
    const now = nowIso();
    const candidateIdsBySourceIndex = new Map<number, string>();
    candidateInputs.forEach((candidate, position) => candidateIdsBySourceIndex.set(Number.isInteger(candidate.index) ? candidate.index : position, createId("optimization_candidate")));
    const candidates: OptimizationCandidate[] = [];
    for (const [position, candidateInput] of candidateInputs.entries()) {
      const sourceIndex = Number.isInteger(candidateInput.index) ? candidateInput.index : position;
      const candidateId = candidateIdsBySourceIndex.get(sourceIndex) ?? createId("optimization_candidate");
      const body = candidateInput.body.trim();
      const safety = evaluateSkillOptimizationSafety(body);
      const safetyChecksPassed = safety.passed && input.result.safety_checks_passed === true;
      const evaluations = candidateInput.evaluations.length > 0 ? candidateInput.evaluations : (position === 0 ? input.result.evaluations ?? [] : []);
      const baselineHoldoutScore = clampOptimizationScore(candidateInput.baseline_holdout_score ?? input.result.baseline_holdout_score);
      const holdoutScore = clampOptimizationScore(candidateInput.holdout_score ?? input.result.holdout_score);
      const importantRegression = candidateInput.important_regression === true || (position === 0 && input.result.important_regression === true)
        || evaluations.some((evaluation) => evaluation.important_regression);
      const gates = evaluateOptimizationGates({ baseline_holdout_score: baselineHoldoutScore, holdout_score: holdoutScore,
        related_tests_passed: relatedTestsPassed, safety_checks_passed: safetyChecksPassed, important_regression: importantRegression });
      const traceRef: ResourceRef = { kind: "skill_optimization_trace", id: candidateId,
        uri: `skill-optimization/${current.id}/trace/${candidateId}`, label: "GEPA execution trace" };
      const parentCandidateId = typeof candidateInput.parent_index === "number" ? candidateIdsBySourceIndex.get(candidateInput.parent_index) : undefined;
      const candidate: OptimizationCandidate = {
        id: candidateId, run_id: current.id, skill_id: input.skillId, ...(parentCandidateId ? { parent_candidate_id: parentCandidateId } : {}),
        body, content_hash: stableHash(body), baseline_holdout_score: baselineHoldoutScore, holdout_score: holdoutScore,
        holdout_delta: gates.holdout_delta,
        feedback: [...new Set([...(candidateInput.feedback ?? []), ...input.result.feedback, ...safety.reasons, gates.reason].filter(Boolean))],
        dataset_id: input.dataset.id,
        trace_refs: [traceRef, ...input.result.trace.flatMap((item) => {
          const id = typeof item.id === "string" ? item.id : "";
          return id ? [{ kind: "skill_optimization_trace", id, uri: `skill-optimization/${current.id}/trace/${id}`, label: "GEPA trace" } satisfies ResourceRef] : [];
        })],
        safety: { related_tests_passed: relatedTestsPassed, safety_checks_passed: safetyChecksPassed, important_regression: importantRegression },
        status: gates.passed ? "passed" : "rejected", created_at: now, updated_at: now
      };
      candidates.push(candidate);
      await port.saveCandidate(candidate);
      for (const evaluation of evaluations) {
        const record: OptimizationEvaluation = { id: createId("optimization_evaluation"), run_id: current.id,
          candidate_id: candidate.id, split: evaluation.split, score: clampOptimizationScore(evaluation.score),
          feedback: evaluation.feedback.length > 0 ? evaluation.feedback : ["GEPA evaluation completed."],
          important_regression: evaluation.important_regression, related_tests_passed: relatedTestsPassed,
          safety_checks_passed: safetyChecksPassed, trace_refs: [traceRef], created_at: now };
        await port.saveEvaluation(record);
      }
    }
    const passedCandidates = candidates.filter((candidate) => candidate.status === "passed");
    const firstCandidate = candidates[0];
    const nextRun: SkillOptimizationRun = { ...current, status: "completed",
      phase: passedCandidates.length > 0 ? "awaiting_confirmation" : "completed", progress: 1,
      candidate_ids: [...current.candidate_ids, ...candidates.map((candidate) => candidate.id)],
      trace_refs: [...current.trace_refs, ...candidates.flatMap((candidate) => candidate.trace_refs)],
      provenance: { ...current.provenance, candidate_count: candidates.length, passed_candidate_count: passedCandidates.length,
        candidate_summaries: candidates.map((candidate) => ({ id: candidate.id, parent_candidate_id: candidate.parent_candidate_id ?? null,
          holdout_score: candidate.holdout_score, holdout_delta: candidate.holdout_delta, status: candidate.status })),
        ...(firstCandidate ? { baseline_holdout_score: firstCandidate.baseline_holdout_score,
          holdout_score: firstCandidate.holdout_score, holdout_delta: firstCandidate.holdout_delta } : {}) },
      updated_at: now, completed_at: now };
    await port.saveRun(nextRun);
    if (input.sessionId) await port.savePresentations({ sessionId: input.sessionId, run: nextRun, candidates }).catch(() => undefined);
    await settleWork("complete");
    if (passedCandidates.length === 0) {
      await settleObjective("completed");
      await port.releaseLock({ skillId: input.skillId, runId: current.id });
    }
  }

  private async cancelOptimizationRun(input: SkillOptimizationRunRequest): Promise<SkillOptimizationRun> {
    const port = this.dependencies.optimization;
    const runId = input.optimizationRunId;
    const run = await port.getRun(runId);
    if (!run) throw port.requestError("not_found", "skill_optimization_run_not_found");
    const roomObjective = await port.getObjective(run.objective_id, input.roomId);
    if (!roomObjective || roomObjective.room_id !== input.roomId) throw port.requestError("conflict", "skill_optimization_room_access_denied");
    if (["completed", "failed", "cancelled"].includes(run.status) && run.phase !== "awaiting_confirmation") return run;
    this.optimizationWorkers.get(runId)?.cancel();
    const now = nowIso();
    const cancelled = await port.saveRun({ ...run, status: "cancelled", phase: "cancelled", progress: 1,
      error: "cancelled_by_user", updated_at: now, completed_at: now });
    const work = await port.getWorkItem(run.work_item_id, input.roomId);
    if (work?.status === "running") {
      await port.failWorkItem({ workItemId: work.id, workerId: `skill-optimization:${run.id}`, roomId: input.roomId,
        failureKind: "cancelled", error: "cancelled_by_user" });
    }
    const objective = await port.getObjective(run.objective_id, input.roomId);
    if (objective?.status === "active") await port.updateObjective({ ...objective, status: "cancelled", updated_at: now, completed_at: now }, input.roomId);
    await port.releaseLock({ skillId: run.target_skill_id, runId });
    return cancelled;
  }

  private async promoteOptimizationRun(input: SkillOptimizationCandidateRequest): Promise<{ run: SkillOptimizationRun; skill: TSkill; candidate: OptimizationCandidate; snapshot: SkillOptimizationSnapshot; promotion: OptimizationPromotion }> {
    const port = this.dependencies.optimization;
    const { optimizationRunId, candidateId } = input;
    const runId = optimizationRunId;
    const [run, candidate] = await Promise.all([port.getRun(runId), port.getCandidate(candidateId)]);
    if (!run || !candidate) throw port.requestError("not_found", "skill_optimization_candidate_not_found");
    const roomObjective = await port.getObjective(run.objective_id, input.roomId);
    if (!roomObjective || roomObjective.room_id !== input.roomId) throw port.requestError("conflict", "skill_optimization_room_access_denied");
    if (candidate.run_id !== run.id || candidate.status !== "passed") throw port.requestError("conflict", "skill_optimization_candidate_not_promotable");
    const targetSkill = await port.getSkill(run.target_skill_id);
    const raw = targetSkill ? await port.readMarkdown(targetSkill.id) : undefined;
    if (!targetSkill || !raw) throw port.requestError("not_found", "skill_not_found");
    if (targetSkill.room_id !== undefined && targetSkill.room_id !== input.roomId) throw port.requestError("conflict", "skill_optimization_room_access_denied");
    const lock = await port.getLock(targetSkill.id);
    if (!lock || lock.run_id !== run.id) throw port.requestError("conflict", "skill_optimization_lock_missing");
    const now = nowIso();
    const snapshot: SkillOptimizationSnapshot = { id: createId("skill_optimization_snapshot"), skill_id: targetSkill.id,
      run_id: run.id, candidate_id: candidate.id, content_hash: stableHash(skillMarkdownContent(raw)), markdown: raw, created_at: now };
    await port.saveSnapshot(snapshot);
    await this.updateOptimizationRun(run.id, { phase: "promoting", progress: 1 });
    let promoted: TSkill | undefined;
    try {
      promoted = await port.replaceContentIfUnchanged({ id: targetSkill.id, expectedContentHash: run.baseline_content_hash,
        content: candidate.body, lockRunId: run.id });
    } catch (error) {
      const conflict: OptimizationPromotion = { id: createId("optimization_promotion"), run_id: run.id,
        candidate_id: candidate.id, skill_id: targetSkill.id, snapshot_id: snapshot.id,
        expected_content_hash: run.baseline_content_hash, promoted_content_hash: candidate.content_hash,
        status: "conflict", provenance: { error: port.errorMessage(error) }, created_at: now };
      await port.savePromotion(conflict);
      await port.releaseLock({ skillId: targetSkill.id, runId: run.id });
      await port.saveRun({ ...(await port.getRun(run.id) ?? run), status: "failed", phase: "failed",
        error: "skill_content_conflict", updated_at: now, completed_at: now });
      throw port.requestError("conflict", "skill_content_conflict");
    }
    if (!promoted) throw port.requestError("not_found", "skill_not_found");
    const promotion: OptimizationPromotion = { id: createId("optimization_promotion"), run_id: run.id,
      candidate_id: candidate.id, skill_id: targetSkill.id, snapshot_id: snapshot.id,
      expected_content_hash: run.baseline_content_hash, promoted_content_hash: candidate.content_hash,
      status: "promoted", provenance: { confirmed_by: "owner", confirmation_command: "skill.optimization.promote" }, created_at: now };
    await port.savePromotion(promotion);
    await port.saveCandidate({ ...candidate, status: "promoted", updated_at: now });
    const completedRun = await port.saveRun({ ...(await port.getRun(run.id) ?? run), status: "completed",
      phase: "completed", progress: 1, updated_at: now, completed_at: now });
    await port.releaseLock({ skillId: targetSkill.id, runId: run.id });
    const objective = await port.getObjective(run.objective_id, input.roomId);
    if (objective?.status === "active") await port.updateObjective({ ...objective, status: "completed", updated_at: now, completed_at: now }, input.roomId);
    return { run: completedRun, skill: promoted, candidate: { ...candidate, status: "promoted" }, snapshot, promotion };
  }

  private async rejectOptimizationRun(input: SkillOptimizationCandidateRequest): Promise<{ run: SkillOptimizationRun; candidate: OptimizationCandidate }> {
    const port = this.dependencies.optimization;
    const { optimizationRunId, candidateId } = input;
    const runId = optimizationRunId;
    const [run, candidate] = await Promise.all([port.getRun(runId), port.getCandidate(candidateId)]);
    if (!run || !candidate || candidate.run_id !== run.id) throw port.requestError("not_found", "skill_optimization_candidate_not_found");
    const roomObjective = await port.getObjective(run.objective_id, input.roomId);
    if (!roomObjective || roomObjective.room_id !== input.roomId) throw port.requestError("conflict", "skill_optimization_room_access_denied");
    const now = nowIso();
    const rejected = await port.saveCandidate({ ...candidate, status: "rejected", updated_at: now });
    const nextRun = await port.saveRun({ ...run, status: "completed", phase: "completed", updated_at: now, completed_at: now });
    await port.releaseLock({ skillId: run.target_skill_id, runId: run.id });
    const objective = await port.getObjective(run.objective_id, input.roomId);
    if (objective?.status === "active") await port.updateObjective({ ...objective, status: "completed", updated_at: now, completed_at: now }, input.roomId);
    return { run: nextRun, candidate: rejected };
  }

  private async rollbackOptimizationRun(input: SkillOptimizationRollbackRequest): Promise<{ skill: TSkill; snapshot: SkillOptimizationSnapshot; promotion?: OptimizationPromotion }> {
    const port = this.dependencies.optimization;
    const { promotionId, snapshotId } = input;
    const promotion = promotionId ? (await port.listPromotions()).find((item) => item.id === promotionId) : undefined;
    const snapshot = await port.getSnapshot(snapshotId || promotion?.snapshot_id || "");
    if (!snapshot) throw port.requestError("not_found", "skill_optimization_snapshot_not_found");
    const current = await port.getSkill(snapshot.skill_id);
    const raw = current ? await port.readMarkdown(current.id) : undefined;
    if (!current || !raw) throw port.requestError("not_found", "skill_not_found");
    if (current.room_id !== undefined && current.room_id !== input.roomId) throw port.requestError("conflict", "skill_optimization_room_access_denied");
    if (promotion && stableHash(skillMarkdownContent(raw)) !== promotion.promoted_content_hash) {
      throw port.requestError("conflict", "skill_rollback_content_conflict");
    }
    const now = nowIso();
    let restored: TSkill | undefined;
    try {
      restored = await port.replaceContentIfUnchanged({ id: current.id, expectedContentHash: stableHash(skillMarkdownContent(raw)),
        content: skillMarkdownContent(snapshot.markdown) });
    } catch {
      throw port.requestError("conflict", "skill_rollback_content_conflict");
    }
    if (!restored) throw port.requestError("not_found", "skill_not_found");
    const restoredSnapshot = await port.saveSnapshot({ ...snapshot, restored_at: now });
    const restoredPromotion = promotion ? await port.savePromotion({ ...promotion, status: "rolled_back",
      provenance: { ...promotion.provenance, rolled_back_at: now } }) : undefined;
    const candidate = await port.getCandidate(snapshot.candidate_id);
    if (candidate) await port.saveCandidate({ ...candidate, status: "rolled_back", updated_at: now });
    return { skill: restored, snapshot: restoredSnapshot, promotion: restoredPromotion };
  }

  recordUsage(input: SkillUsageRecordRequest) { return this.recordUsageInput(input); }

  view(input: SkillViewRequest) { return this.viewSkill(input); }

  async viewSkill(input: { skillId: string; runId: string; path?: string }) {
    const [skill, run] = await Promise.all([
      this.dependencies.queries.getSkill(input.skillId), this.dependencies.queries.getRun(input.runId)
    ]);
    if (!skill) throw this.dependencies.mutation.requestError("not_found", `Skill not found: ${input.skillId}`);
    if (!run) throw this.dependencies.mutation.requestError("not_found", `Backend run not found: ${input.runId}`);
    const usageContext = await this.resolveUsageScopeContext(run);
    if (!usageScopeAllowsActivity((skill as { frontmatter?: Pick<SkillFrontmatter, "usage_scope"> }).frontmatter?.usage_scope, usageContext)) {
      throw this.dependencies.conflictError("skill_usage_scope_mismatch");
    }
    if (skill.state === "archived" || skill.state === "candidate") {
      throw this.dependencies.conflictError("skill_not_readable_in_current_state");
    }
    const support = input.path ? await this.dependencies.queries.readSupportFile({ skillId: skill.id, path: input.path }) : undefined;
    if (input.path && !support) throw this.dependencies.mutation.requestError("not_found", `Skill support file not found: ${input.path}`);
    const markdown = support ? undefined : await this.dependencies.queries.readMarkdown(skill.id);
    if (!support && markdown === undefined) throw this.dependencies.mutation.requestError("not_found", `Skill body not found: ${skill.id}`);
    const content = support ? support.content : skillMarkdownContent(markdown ?? "");
    const stage = support ? "support_loaded" as const : "body_loaded" as const;
    const resourceId = support ? `${skill.id}:${support.path}` : skill.id;
    const supportFiles = await this.dependencies.queries.listSupportFiles(skill.id);
    return {
      skill, content,
      file_refs: support ? [{ path: support.path, file_path: support.file_path }] : supportFiles.map((file) => ({ path: file.path, file_path: file.file_path })),
      disclosure_level: support ? "support" as const : "body" as const,
      usage: { skill_id: skill.id, run_id: run.id, resource_id: resourceId, content_hash: stableHash(content), stage,
        metadata: support ? { skill_id: skill.id, path: support.path } : { skill_id: skill.id } }
    };
  }

  async recordUsageInput(input: { skillId: string; runId: string; resourceId: string; contentHash: string; stage: "body_loaded" | "support_loaded"; metadata: Record<string, JsonValue> }) {
    const [skill, run] = await Promise.all([
      this.dependencies.queries.getSkill(input.skillId), this.dependencies.queries.getRun(input.runId)
    ]);
    if (!skill) throw this.dependencies.mutation.requestError("not_found", `Skill not found: ${input.skillId}`);
    if (!run) throw this.dependencies.mutation.requestError("not_found", `Backend run not found: ${input.runId}`);
    const usageContext = await this.resolveUsageScopeContext(run);
    if (!usageScopeAllowsActivity((skill as { frontmatter?: Pick<SkillFrontmatter, "usage_scope"> }).frontmatter?.usage_scope, usageContext)) {
      throw this.dependencies.conflictError("skill_usage_scope_mismatch");
    }
    if (input.stage === "body_loaded" && input.resourceId !== skill.id) throw this.dependencies.conflictError("skill_usage_resource_mismatch");
    const supportPath = typeof input.metadata.path === "string" ? input.metadata.path : undefined;
    if (input.stage === "support_loaded" && (!supportPath || input.resourceId !== `${skill.id}:${supportPath}`)) {
      throw this.dependencies.conflictError("skill_usage_resource_mismatch");
    }
    if (input.stage === "body_loaded" && skill.frontmatter.content_hash && skill.frontmatter.content_hash !== input.contentHash) {
      throw this.dependencies.conflictError("skill_usage_content_hash_mismatch");
    }
    const existing = (await this.dependencies.usage.listUses({ runId: run.id, resourceId: input.resourceId }))
      .find((record) => record.stage === input.stage);
    const useRecord = existing ?? await this.dependencies.usage.recordUse({
      id: learningResourceUseId({ runId: run.id, resourceId: input.resourceId, stage: input.stage, contentHash: input.contentHash }), run_id: run.id,
      ...(usageContext.session_id ? { session_id: usageContext.session_id } : {}),
      resource_kind: input.stage === "support_loaded" ? "skill_support" : "skill",
      resource_id: input.resourceId, ...(skill.frontmatter.version ? { resource_version: skill.frontmatter.version } : {}), content_hash: input.contentHash,
      ...(skill.frontmatter.usage_scope ? { usage_scope: skill.frontmatter.usage_scope } : {}), stage: input.stage,
      ...(usageContext.session_id && usageContext.agent_id
        ? { activity_context: { room_id: usageContext.room_id, session_id: usageContext.session_id, agent_id: usageContext.agent_id } }
        : {}), metadata: input.metadata, created_at: nowIso()
    });
    if (!existing && input.stage === "body_loaded") await this.dependencies.usage.incrementSkillUsage({ skillId: skill.id, runId: run.id });
    return { use_record: useRecord };
  }

  private async resolveUsageScopeContext(run: BackendRunRecord): Promise<{ room_id: string; session_id?: string; agent_id?: string }> {
    const [session, agent] = await Promise.all([
      run.session_id ? this.dependencies.queries.getSession(run.session_id) : Promise.resolve(undefined),
      run.agent_id ? this.dependencies.queries.getAgent(run.agent_id) : Promise.resolve(undefined)
    ]);
    if (run.session_id && (!session || session.id !== run.session_id)) {
      throw this.dependencies.conflictError("skill_activity_context_required");
    }
    if (run.agent_id && !agent) throw this.dependencies.conflictError("skill_activity_context_required");
    const roomId = run.room_id ?? session?.room_id;
    if (!roomId || (run.room_id && session?.room_id && run.room_id !== session.room_id)) {
      throw this.dependencies.conflictError("skill_activity_context_required");
    }
    return {
      room_id: roomId,
      ...(session ? { session_id: session.id } : {}),
      ...(agent ? { agent_id: agent.id } : {})
    };
  }
}

function optionalString(value: JsonValue | undefined): string { return typeof value === "string" ? value.trim() : ""; }
function recordValue(value: JsonValue | undefined): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, JsonValue> : {};
}
function sourceRefs(value: JsonValue | undefined): SkillFrontmatter["source_refs"] | undefined {
  const parsed = z.array(ResourceRefSchema).safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
function isApplyAction(value: string): value is SkillApplyAction { return value === "mark_stale" || value === "archive" || value === "reactivate"; }
function lifecycleTargetState(action: SkillApplyAction): SkillFrontmatter["state"] | undefined {
  switch (action) { case "mark_stale": return "stale"; case "archive": return "archived"; case "reactivate": return "project"; default: return undefined; }
}
function summarize(value: string, maxLength = 160): string { return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`; }
function skillRef(skill: StoredSkill) { return { kind: "skill", id: skill.id, uri: skill.file_path, label: skill.title }; }
function skillMarkdownContent(markdown: string): string {
  if (!markdown.startsWith("---\n")) throw new Error("skill_frontmatter_missing");
  const end = markdown.indexOf("\n---", 4);
  if (end === -1) throw new Error("skill_frontmatter_unclosed");
  const contentStart = markdown.indexOf("\n", end + 4);
  return (contentStart === -1 ? "" : markdown.slice(contentStart + 1)).trim();
}

function usageScopeAllowsActivity(
  scope: SkillFrontmatter["usage_scope"],
  activityContext: { room_id: string; session_id?: string; agent_id?: string }
): boolean {
  const resolved = scope ?? { kind: "workspace" as const };
  if (resolved.kind === "workspace") return true;
  if (resolved.kind === "room") return resolved.room_id === activityContext.room_id;
  if (resolved.kind === "agent") return activityContext.agent_id !== undefined && resolved.agent_id === activityContext.agent_id;
  return activityContext.session_id !== undefined && resolved.session_id === activityContext.session_id;
}

function learningResourceUseId(input: { runId: string; resourceId: string; stage: "body_loaded" | "support_loaded"; contentHash: string }): string {
  return `learning_use_${stableHash({ run_id: input.runId, resource_id: input.resourceId, stage: input.stage, content_hash: input.contentHash })}`;
}

function optimizationExamplesFromValues(value: readonly JsonValue[] | undefined, source: "golden" | "synthetic"): OptimizationExampleInput[] {
  if (!value) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const record = item as Record<string, JsonValue>;
    const prompt = optionalString(record.prompt) || optionalString(record.input);
    const expectedBehavior = optionalString(record.expected_behavior) || optionalString(record.expected) || optionalString(record.output);
    if (!prompt || !expectedBehavior) return [];
    return [{ id: optionalString(record.id) || undefined, prompt, expected_behavior: expectedBehavior,
      feedback: optionalString(record.feedback) || "User-provided evaluation example.", source,
      ...(optionalString(record.skill_body_read_run_id) ? { skill_body_read_run_id: optionalString(record.skill_body_read_run_id) } : {}),
      trace_refs: Array.isArray(record.trace_refs) ? sourceRefs(record.trace_refs) ?? [] : [], metadata: recordValue(record.metadata) } satisfies OptimizationExampleInput];
  });
}

function clampOptimizationScore(value: number | undefined): number {
  return Math.max(0, Math.min(100, typeof value === "number" && Number.isFinite(value) ? value : 0));
}

function optimizationSkillRef(skill: { id: string; title: string; file_path: string }): ResourceRef {
  return { kind: "skill", id: skill.id, uri: skill.file_path, label: skill.title };
}

function optimizationBackendRunRef(run: BackendRunRecord): ResourceRef {
  return { kind: "backend_run", id: run.id, uri: `backend-runs/${run.id}`, label: run.input_summary };
}
