import { CuratorLifecycleReportSchema, CuratorReviewReportSchema, createId, nowIso, type CuratorLifecycleReport, type CuratorReviewReport, type CuratorStateRecord, type LearningJobReportRecord, type LearningSnapshotRecord, type MemoryFrontmatter, type ReflectionRunRecord, type ReflectionSuggestionRecord, type ResourceRef, type SkillFrontmatter, type SkillState, type SkillUsageRecord, type WikiFrontmatter } from "@samurai-agent/core-schemas";

export interface LearningOperationPort {
  saveCuratorState(input: { paused: boolean }): Promise<CuratorStateRecord>;
  restoreSnapshot(snapshotId: string, options?: { allowRoomScope?: boolean; roomId?: string }): Promise<LearningSnapshotRecord | undefined>;
  createSnapshot(runId: string): Promise<LearningSnapshotRecord>;
  listSnapshots(): Promise<LearningSnapshotRecord[]>;
  pruneSnapshots(retain: number): Promise<{ retained: number; removed: string[] }>;
}

export interface LearningDomainServiceDependencies {
  learning: LearningOperationPort;
  curator: CuratorWorkflowPort;
  requestError: (code: "not_found", message: string) => Error;
}

export interface LearningSnapshotPruneInput {
  retain: number;
}

type StoredMemory = MemoryFrontmatter & { file_path: string };
type StoredWiki = WikiFrontmatter & { file_path: string };
interface StoredSkill { id: string; title: string; description: string; tags: string[]; allowed_scopes: SkillFrontmatter["allowed_scopes"]; required_capabilities: string[]; owner_pinned: boolean; state: SkillState; file_path: string; resource_version: number; frontmatter: SkillFrontmatter }
type CuratorReason = "replacement" | "refutation" | "environment_changed" | "user_request" | "restore" | "archive";

export interface CuratorWorkflowPort {
  ensureSession(): Promise<{ id: string; room_id?: string }>;
  getState(): Promise<CuratorStateRecord>; listMemory(): Promise<StoredMemory[]>; listSkills(): Promise<StoredSkill[]>;
  listSkillUsage(input: { skillIds: string[] }): Promise<SkillUsageRecord[]>; listWiki(): Promise<StoredWiki[]>;
  createReflectionRun(run: ReflectionRunRecord): Promise<ReflectionRunRecord>; updateReflectionRun(run: ReflectionRunRecord): Promise<ReflectionRunRecord>;
  createSnapshot(runId: string): Promise<LearningSnapshotRecord>; restoreSnapshot(id: string, options?: { allowRoomScope?: boolean; roomId?: string }): Promise<void>;
  saveState(input: Partial<CuratorStateRecord>): Promise<CuratorStateRecord>; saveSuggestion(value: ReflectionSuggestionRecord): Promise<void>;
  saveJobReport(value: LearningJobReportRecord): Promise<void>;
  archiveResourceVersion(input: { resourceKind: "memory" | "wiki" | "skill"; resourceId: string; changeReason: string; roomId: string }): Promise<void>;
  errorMessage(error: unknown): string; nextRunAt(fromMs: number): string;
}


export class LearningDomainService {
  constructor(private readonly dependencies: LearningDomainServiceDependencies) {}

  pause() { return this.dependencies.learning.saveCuratorState({ paused: true }); }
  resume() { return this.dependencies.learning.saveCuratorState({ paused: false }); }
  runCurator(input: { respectIdleGate?: boolean; reason?: CuratorReason; resourceKind?: "memory" | "wiki" | "skill"; resourceId?: string } = {}) { return this.executeReasonDrivenCurator(input); }
  listSnapshots() { return this.dependencies.learning.listSnapshots(); }
  restoreLearningSnapshot(id: string, roomId?: string) {
    return this.dependencies.learning.restoreSnapshot(id, { allowRoomScope: true, ...(roomId ? { roomId } : {}) });
  }
  snapshotNotFoundError() { return this.dependencies.requestError("not_found", "curator_snapshot_not_found"); }

  pruneSnapshots(input: LearningSnapshotPruneInput) {
    return this.dependencies.learning.pruneSnapshots(input.retain);
  }

  createSnapshot() {
    return this.dependencies.learning.createSnapshot(createId("curator_manual"));
  }

  /** Core 05 curator: reason-driven review only. Time alone never changes a Resource. */
  async executeReasonDrivenCurator(input: { respectIdleGate?: boolean; reason?: CuratorReason; resourceKind?: "memory" | "wiki" | "skill"; resourceId?: string } = {}): Promise<{ reflectionRun: ReflectionRunRecord; suggestions: ReflectionSuggestionRecord[]; curatorReport: CuratorLifecycleReport; curatorReviewReport: CuratorReviewReport }> {
    const session = await this.dependencies.curator.ensureSession();
    const [curatorState, memories, skills, wikiPages] = await Promise.all([
      this.dependencies.curator.getState(),
      this.dependencies.curator.listMemory(),
      this.dependencies.curator.listSkills(),
      this.dependencies.curator.listWiki()
    ]);
    // Usage rows are metadata too. Fetch only the already permitted Skills;
    // do not load Workspace-wide usage and filter it afterward.
    const visibleSkillIds = skills.map((skill) => skill.id);
    const scopedSkillUsage = await this.dependencies.curator.listSkillUsage({ skillIds: visibleSkillIds });
    const now = nowIso();
    const reason = input.reason;
    let reflectionRun = await this.dependencies.curator.createReflectionRun({
      id: createId("reflection"),
      kind: "curator",
      session_id: session.id,
      status: "started",
      input_summary: reason
        ? `Reason-driven Curator review: ${reason}.`
        : "Curator skipped: no replacement, refutation, environment change, or user request was supplied.",
      started_at: now
    });
    const suggestions: ReflectionSuggestionRecord[] = [];
    const archiveCandidates: CuratorReviewReport["archive_candidates"] = [];
    let snapshotId: string | undefined;
    let archiveApplied = false;
    let summary = "Curator skipped: no reason was supplied, so no Resource review was run.";
    if (reason && input.resourceKind && input.resourceId) {
      const kind = input.resourceKind === "wiki" ? "knowledge_wiki" as const : input.resourceKind;
      const target = input.resourceKind === "memory"
        ? memories.find((item) => item.id === input.resourceId)
        : input.resourceKind === "wiki"
          ? wikiPages.find((item) => item.id === input.resourceId)
          : skills.find((item) => item.id === input.resourceId);
      if (!target) throw this.dependencies.requestError("not_found", `curator_resource_not_found:${input.resourceKind}:${input.resourceId}`);
      const pinned = input.resourceKind === "skill"
        ? (() => {
            const skill = target as StoredSkill;
            return skill.owner_pinned || skill.frontmatter.owner_pinned || skill.frontmatter.pinned === true || skill.state === "pinned";
          })()
        : (target as StoredMemory | StoredWiki).pinned === true;
      const title = `${reason}: ${input.resourceId}`;
      const targetRef = input.resourceKind === "memory"
        ? memoryRef(target as StoredMemory)
        : input.resourceKind === "wiki"
          ? wikiRef(target as StoredWiki)
          : skillRef(target as StoredSkill);
      if (reason === "archive") {
        archiveCandidates.push({ kind, id: input.resourceId, title, reason: pinned ? "Pinned Resources are never automatically archived." : "Explicit archive request." });
        if (pinned) {
          summary = `Curator kept pinned Resource ${input.resourceId}; Archive was not applied.`;
        } else {
          const snapshot = await this.dependencies.curator.createSnapshot(reflectionRun.id);
          snapshotId = snapshot.id;
          try {
            await this.dependencies.curator.archiveResourceVersion({
              resourceKind: input.resourceKind,
              resourceId: input.resourceId,
              changeReason: "user_requested_archive",
              roomId: session.room_id ?? ""
            });
            archiveApplied = true;
            summary = `Curator archived ${input.resourceKind} ${input.resourceId} after Snapshot ${snapshot.id}.`;
          } catch (error) {
            await this.dependencies.curator.restoreSnapshot(snapshot.id).catch(() => undefined);
            reflectionRun = await this.dependencies.curator.updateReflectionRun({
              ...reflectionRun,
              status: "failed",
              error: `curator_archive_restored:${this.dependencies.curator.errorMessage(error)}`,
              completed_at: nowIso()
            });
            throw error;
          }
        }
      } else {
        summary = `Curator recorded a reason-driven ${reason} review without an automatic Resource mutation.`;
      }
      const suggestion: ReflectionSuggestionRecord = {
        id: createId("reflection_suggestion"),
        reflection_run_id: reflectionRun.id,
        suggestion_type: reason === "refutation" ? "conflict" : kind === "skill" ? "skill_patch" : kind === "knowledge_wiki" ? "knowledge_wiki" : "memory_patch",
        status: archiveApplied ? "applied" : "proposed",
        title,
        content: archiveApplied
          ? `Curator applied the explicit Archive request after Snapshot ${snapshotId}.`
          : `Curator reviewed the explicit ${reason} reason without deleting, merging, or expanding Scope automatically.`,
        target_ref: targetRef,
        source_refs: [targetRef],
        confidence: 0.7,
        created_at: now,
        updated_at: now
      };
      await this.dependencies.curator.saveSuggestion(suggestion);
      suggestions.push(suggestion);
    }
    reflectionRun = await this.dependencies.curator.updateReflectionRun({ ...reflectionRun, status: "completed", output_summary: summary, completed_at: nowIso() });
    await this.dependencies.curator.saveState({ last_run_at: now, last_run_summary: summary, run_count: curatorState.run_count + 1 });
    const curatorReport = buildCuratorLifecycleReport({
      now,
      dryRun: !archiveApplied,
      paused: curatorState.paused,
      skippedReason: summary,
      curatorState,
      memories,
      wikiPages,
      skills,
      skillUsage: scopedSkillUsage,
      suggestions,
      skillActions: [],
      protectedSkills: [],
      ...(snapshotId ? { snapshotId } : {})
    });
    const curatorReviewReport = buildCuratorReviewReport({
      now,
      dryRun: !archiveApplied,
      keepCandidates: [],
      memoryMergeGroups: [],
      skillConsolidationGroups: [],
      wikiPatchProposals: [],
      archiveCandidates
    });
    await this.dependencies.curator.saveJobReport({
      id: createId("learning_job_report"),
      job_kind: "curator",
      run_id: reflectionRun.id,
      target_resource_count: reason && input.resourceId ? 1 : 0,
      mutation_count: archiveApplied ? 1 : 0,
      archive_count: archiveApplied ? 1 : 0,
      restore_count: 0,
      patch_count: 0,
      merge_count: 0,
      skipped_reasons: archiveApplied ? {} : reason ? { reason_requires_explicit_resource_operation: 1 } : { no_curator_reason: 1 },
      evaluation_count: 0,
      ...(snapshotId ? { snapshot_id: snapshotId } : {}),
      duration_ms: Math.max(0, Date.parse(reflectionRun.completed_at ?? nowIso()) - Date.parse(now)),
      created_at: nowIso()
    });
    return { reflectionRun, suggestions, curatorReport, curatorReviewReport };
  }
}

function memoryRef(value: StoredMemory): ResourceRef { return { kind: "memory", id: value.id, uri: value.file_path, label: value.topic }; }
function wikiRef(value: StoredWiki): ResourceRef { return { kind: "wiki", id: value.id, uri: value.file_path, label: value.title }; }
function skillRef(value: StoredSkill): ResourceRef { return { kind: "skill", id: value.id, uri: value.file_path, label: value.title }; }
function buildCuratorLifecycleReport(input: { now: string; dryRun: boolean; paused: boolean; skippedReason?: string; curatorState: CuratorStateRecord;
  memories: StoredMemory[]; wikiPages: StoredWiki[]; skills: StoredSkill[]; skillUsage: Array<{ skill_id: string }>;
  suggestions: ReflectionSuggestionRecord[]; skillActions: CuratorLifecycleReport["skill_actions"];
  protectedSkills: CuratorLifecycleReport["protected_skills"]; snapshotId?: string; evaluationCount?: number; appliedMutationCount?: number }): CuratorLifecycleReport {
  return CuratorLifecycleReportSchema.parse({ id: `curator_report_${input.now.replace(/[^0-9A-Za-z]/g, "")}`, checked_at: input.now,
    dry_run: input.dryRun, paused: input.paused, ...(input.snapshotId ? { snapshot_id: input.snapshotId } : {}),
    evaluation_count: input.evaluationCount ?? 0, applied_mutation_count: input.appliedMutationCount ?? 0,
    ...(input.skippedReason ? { skipped_reason: input.skippedReason } : {}),
    thresholds: { stale_after_days: input.curatorState.stale_after_days, archive_after_days: input.curatorState.archive_after_days, min_idle_hours: input.curatorState.min_idle_hours },
    counts: { memory_items: input.memories.length, wiki_pages: input.wikiPages.length, skill_items: input.skills.length,
      skill_usage_rows: input.skillUsage.length, suggestions: input.suggestions.length }, skill_actions: input.skillActions, protected_skills: input.protectedSkills });
}
function buildCuratorReviewReport(input: { now: string; dryRun: boolean; keepCandidates: CuratorReviewReport["keep_candidates"];
  memoryMergeGroups: CuratorReviewReport["memory_merge_groups"]; skillConsolidationGroups: CuratorReviewReport["skill_consolidation_groups"];
  wikiPatchProposals: CuratorReviewReport["wiki_patch_proposals"]; archiveCandidates: CuratorReviewReport["archive_candidates"] }): CuratorReviewReport {
  return CuratorReviewReportSchema.parse({ id: `curator_review_${input.now.replace(/[^0-9A-Za-z]/g, "")}`, checked_at: input.now, dry_run: input.dryRun,
    counts: { keep_candidates: input.keepCandidates.length, patch_candidates: input.wikiPatchProposals.length,
      consolidate_candidates: input.memoryMergeGroups.length + input.skillConsolidationGroups.length, archive_candidates: input.archiveCandidates.length },
    keep_candidates: input.keepCandidates, memory_merge_groups: input.memoryMergeGroups, skill_consolidation_groups: input.skillConsolidationGroups,
    wiki_patch_proposals: input.wikiPatchProposals, archive_candidates: input.archiveCandidates });
}
