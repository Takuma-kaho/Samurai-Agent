import { CuratorLifecycleReportSchema, CuratorReviewReportSchema, createId, nowIso, stableHash, type AuditRecord, type BackendEventRecord, type BackendRunRecord, type CuratorLifecycleAction, type CuratorLifecycleReport, type CuratorReviewReport, type CuratorStateRecord, type EvaluationTraceReport, type JsonValue, type LearningEvaluationRecord, type LearningJobReportRecord, type LearningResourceUseRecord, type LearningSnapshotRecord, type MemoryFrontmatter, type ReflectionRunRecord, type ReflectionSuggestionRecord, type ResourceRef, type SkillFrontmatter, type SkillState, type SkillUsageRecord, type ToolRunRecord, type WikiFrontmatter, type WorkspaceChangeRecord } from "@samurai-agent/core-schemas";
import { actualLearningResourceUses, buildSkillConsolidationGroups, curateMemory, curateSkills, evaluateLearningEffect } from "@samurai-agent/learning";

export interface LearningOperationPort {
  saveCuratorState(input: { paused: boolean }): Promise<CuratorStateRecord>;
  restoreSnapshot(snapshotId: string): Promise<LearningSnapshotRecord | undefined>;
  createSnapshot(runId: string): Promise<LearningSnapshotRecord>;
  listSnapshots(): Promise<LearningSnapshotRecord[]>;
  pruneSnapshots(retain: number): Promise<{ retained: number; removed: string[] }>;
}

export interface LearningDomainServiceDependencies {
  learning: LearningOperationPort;
  evaluation: LearningEvaluationPort;
  curator: CuratorWorkflowPort;
  requestError: (code: "not_found", message: string) => Error;
}

type StoredMemory = MemoryFrontmatter & { file_path: string };
type StoredWiki = WikiFrontmatter & { file_path: string };
interface StoredSkill { id: string; title: string; description: string; tags: string[]; allowed_scopes: SkillFrontmatter["allowed_scopes"]; required_capabilities: string[]; owner_pinned: boolean; state: SkillState; file_path: string; frontmatter: SkillFrontmatter }
interface SkillPackage { id: string; title: string; description: string; markdown: string; support_files: Array<{ path: string; content: string }> }
interface ConsolidationResult { primary_skill_id: string; markdown: string; support_files: Array<{ path: string; content: string }>; archive_skill_ids: string[] }

export interface CuratorWorkflowPort {
  ensureSession(): Promise<{ id: string }>;
  getState(): Promise<CuratorStateRecord>; listMemory(): Promise<StoredMemory[]>; listSkills(): Promise<StoredSkill[]>;
  listSkillUsage(): Promise<SkillUsageRecord[]>; listWiki(): Promise<StoredWiki[]>; listBackendRuns(): Promise<BackendRunRecord[]>;
  listEvaluations(): Promise<LearningEvaluationRecord[]>; listReflectionRuns(): Promise<ReflectionRunRecord[]>;
  createReflectionRun(run: ReflectionRunRecord): Promise<ReflectionRunRecord>; updateReflectionRun(run: ReflectionRunRecord): Promise<ReflectionRunRecord>;
  createSnapshot(runId: string): Promise<LearningSnapshotRecord>; restoreSnapshot(id: string): Promise<unknown>;
  saveState(input: Partial<CuratorStateRecord>): Promise<CuratorStateRecord>; saveSuggestion(value: ReflectionSuggestionRecord): Promise<unknown>;
  saveJobReport(value: LearningJobReportRecord): Promise<unknown>; readMemory(id: string): Promise<string | undefined>;
  replaceMemory(id: string, content: string): Promise<unknown>; archiveMemory(id: string): Promise<unknown>; readWiki(id: string): Promise<string | undefined>;
  readSkill(id: string): Promise<string | undefined>; listSkillSupport(id: string): Promise<Array<{ path: string; content: string }>>;
  replaceSkill(id: string, markdown: string): Promise<unknown>; writeSkillSupport(input: { skillId: string; path: string; content: string }): Promise<unknown>;
  updateSkillState(id: string, state: SkillState): Promise<unknown>; applySkillLifecycle(input: { skillId: string; action: Exclude<CuratorLifecycleAction, "review"> }): Promise<unknown>;
  consolidate(input: { group_key: string; packages: SkillPackage[] }, session: { id: string }): Promise<ConsolidationResult | undefined>;
  errorMessage(error: unknown): string; nextRunAt(fromMs: number): string;
}

export interface LearningEvaluationPort {
  ensureSession(): Promise<{ id: string }>;
  listSkills(): Promise<StoredSkill[]>;
  listBackendRuns(): Promise<BackendRunRecord[]>;
  listBackendEvents(): Promise<BackendEventRecord[]>;
  listWorkspaceChanges(): Promise<WorkspaceChangeRecord[]>;
  listToolRuns(): Promise<ToolRunRecord[]>;
  listAuditRecords(): Promise<AuditRecord[]>;
  listLearningUses(): Promise<LearningResourceUseRecord[]>;
  listEvaluations(): Promise<LearningEvaluationRecord[]>;
  createReflectionRun(run: ReflectionRunRecord): Promise<ReflectionRunRecord>;
  updateReflectionRun(run: ReflectionRunRecord): Promise<ReflectionRunRecord>;
  saveSuggestion(suggestion: ReflectionSuggestionRecord): Promise<unknown>;
  saveEvaluation(evaluation: LearningEvaluationRecord): Promise<unknown>;
  saveJobReport(report: LearningJobReportRecord): Promise<unknown>;
  createSuggestions(run: ReflectionRunRecord, input: { skills: StoredSkill[]; backendRuns: BackendRunRecord[]; backendEvents: BackendEventRecord[]; workspaceChanges: WorkspaceChangeRecord[]; toolRuns: ToolRunRecord[]; auditRecords: AuditRecord[]; now: string }): ReflectionSuggestionRecord[];
  createReport(input: { backendRuns: BackendRunRecord[]; backendEvents: BackendEventRecord[]; workspaceChanges: WorkspaceChangeRecord[]; toolRuns: ToolRunRecord[]; auditRecords: AuditRecord[]; now: string }): Promise<EvaluationTraceReport>;
  nextRunAt(fromMs: number): string;
}

export class LearningDomainService {
  constructor(private readonly dependencies: LearningDomainServiceDependencies) {}

  pause() { return this.dependencies.learning.saveCuratorState({ paused: true }); }
  resume() { return this.dependencies.learning.saveCuratorState({ paused: false }); }
  runCurator() { return this.executeCurator(); }
  runEvaluation() { return this.executeEvaluation(); }
  ensureEvaluationSession() { return this.dependencies.evaluation.ensureSession(); }
  listEvaluationSkills() { return this.dependencies.evaluation.listSkills(); }
  listEvaluationBackendRuns() { return this.dependencies.evaluation.listBackendRuns(); }
  listEvaluationBackendEvents() { return this.dependencies.evaluation.listBackendEvents(); }
  listEvaluationWorkspaceChanges() { return this.dependencies.evaluation.listWorkspaceChanges(); }
  listEvaluationToolRuns() { return this.dependencies.evaluation.listToolRuns(); }
  listEvaluationAuditRecords() { return this.dependencies.evaluation.listAuditRecords(); }
  listLearningResourceUses() { return this.dependencies.evaluation.listLearningUses(); }
  listExistingLearningEvaluations() { return this.dependencies.evaluation.listEvaluations(); }
  createEvaluationReflectionRun(run: ReflectionRunRecord) { return this.dependencies.evaluation.createReflectionRun(run); }
  updateEvaluationReflectionRun(run: ReflectionRunRecord) { return this.dependencies.evaluation.updateReflectionRun(run); }
  createEvaluationSuggestions(run: ReflectionRunRecord, input: Parameters<LearningEvaluationPort["createSuggestions"]>[1]) { return this.dependencies.evaluation.createSuggestions(run, input); }
  createEvaluationReport(input: Parameters<LearningEvaluationPort["createReport"]>[0]) { return this.dependencies.evaluation.createReport(input); }
  actualLearningUses(records: LearningResourceUseRecord[]) { return actualLearningResourceUses(records); }
  evaluateLearningEffect(input: Parameters<typeof evaluateLearningEffect>[0]) { return evaluateLearningEffect(input); }
  saveLearningEvaluation(value: LearningEvaluationRecord) { return this.dependencies.evaluation.saveEvaluation(value); }
  saveEvaluationSuggestion(value: ReflectionSuggestionRecord) { return this.dependencies.evaluation.saveSuggestion(value); }
  saveEvaluationJobReport(value: LearningJobReportRecord) { return this.dependencies.evaluation.saveJobReport(value); }
  nextEvaluationRunAt(fromMs: number) { return this.dependencies.evaluation.nextRunAt(fromMs); }
  createEvaluationId(prefix: "reflection" | "learning_evaluation" | "suggestion" | "learning_job_report") { return createId(prefix); }
  evaluationNow() { return nowIso(); }
  listSnapshots() { return this.dependencies.learning.listSnapshots(); }
  restoreLearningSnapshot(id: string) { return this.dependencies.learning.restoreSnapshot(id); }
  snapshotNotFoundError() { return this.dependencies.requestError("not_found", "curator_snapshot_not_found"); }

  pruneSnapshots(payload: Record<string, JsonValue>) {
    return this.dependencies.learning.pruneSnapshots(positiveInteger(payload.retain) ?? 20);
  }

  createSnapshot(payload: Record<string, JsonValue>) {
    return this.dependencies.learning.createSnapshot(optionalString(payload.run_id) || createId("curator_manual"));
  }

  async executeCurator(input: { respectIdleGate?: boolean } = {}): Promise<{ reflectionRun: ReflectionRunRecord; suggestions: ReflectionSuggestionRecord[]; curatorReport: CuratorLifecycleReport; curatorReviewReport: CuratorReviewReport }> {
    const session = await this.dependencies.curator.ensureSession();
    const [curatorState, memories, skills, skillUsage, wikiPages, backendRuns, learningEvaluations, reflectionRuns] = await Promise.all([
      this.dependencies.curator.getState(),
      this.dependencies.curator.listMemory(),
      this.dependencies.curator.listSkills(),
      this.dependencies.curator.listSkillUsage(),
      this.dependencies.curator.listWiki(),
      this.dependencies.curator.listBackendRuns(),
      this.dependencies.curator.listEvaluations(),
      this.dependencies.curator.listReflectionRuns()
    ]);
    const now = nowIso();
    const nowMs = Date.parse(now);
    const staleCutoffMs = nowMs - curatorState.stale_after_days * 24 * 60 * 60 * 1000;
    const archiveCutoffMs = nowMs - curatorState.archive_after_days * 24 * 60 * 60 * 1000;
    const usageBySkill = new Map(skillUsage.map((usage) => [usage.skill_id, usage]));
    const latestEvaluationRun = reflectionRuns.find((run) => run.kind === "evaluation");
    const evaluationFailed = latestEvaluationRun?.status === "failed";
    const skillLifecycleDecisions = new Map(curateSkills(skills.map((skill) => {
      const usage = usageBySkill.get(skill.id);
      return {
        id: skill.id,
        state: skill.state,
        owner_pinned: skill.state === "pinned" || skill.frontmatter.owner_pinned,
        usage_count: usage?.use_count ?? 0,
        last_activity_at: usage?.last_used_at ?? skill.frontmatter.last_reviewed_at,
        evaluations: learningEvaluations.filter((evaluation) => evaluation.learning_resource_ref.id === skill.id || evaluation.learning_resource_ref.id.startsWith(`${skill.id}:`))
      };
    }), {
      now,
      stale_after_days: curatorState.stale_after_days,
      archive_after_days: curatorState.archive_after_days
    }).map((decision) => [decision.skill_id, decision]));
    let reflectionRun: ReflectionRunRecord = {
      id: createId("reflection"),
      kind: "curator",
      session_id: session.id,
      status: "started",
      input_summary: `Curate ${memories.length} memory item(s), ${skills.length} skill item(s), ${skillUsage.length} skill usage row(s), and ${wikiPages.length} wiki page(s).`,
      started_at: now
    };
    reflectionRun = await this.dependencies.curator.createReflectionRun(reflectionRun);
    const snapshot = await this.dependencies.curator.createSnapshot(reflectionRun.id);
    const suggestions: ReflectionSuggestionRecord[] = [];
    const skillActions: CuratorLifecycleReport["skill_actions"] = [];
    const protectedSkills: CuratorLifecycleReport["protected_skills"] = [];
    const keepCandidates: CuratorReviewReport["keep_candidates"] = [];
    const memoryMergeGroups: CuratorReviewReport["memory_merge_groups"] = [];
    const skillConsolidationGroups: CuratorReviewReport["skill_consolidation_groups"] = [];
    const wikiPatchProposals: CuratorReviewReport["wiki_patch_proposals"] = [];
    const archiveCandidates: CuratorReviewReport["archive_candidates"] = [];
    const latestActivityMs = latestBackendRunActivityMs(backendRuns);
    const minIdleMs = curatorState.min_idle_hours * 60 * 60 * 1000;
    if (input.respectIdleGate && minIdleMs > 0 && latestActivityMs && nowMs - latestActivityMs < minIdleMs) {
      const idleSummary = `Curator skipped because workspace activity is newer than ${curatorState.min_idle_hours} idle hour(s).`;
      reflectionRun = await this.dependencies.curator.updateReflectionRun({
        ...reflectionRun,
        status: "completed",
        output_summary: idleSummary,
        completed_at: nowIso()
      });
      await this.dependencies.curator.saveState({
        last_run_at: now,
        last_run_summary: idleSummary,
        run_count: curatorState.run_count + 1
      });
      return {
        reflectionRun,
        suggestions,
        curatorReport: buildCuratorLifecycleReport({
          now,
          dryRun: true,
          paused: curatorState.paused,
          skippedReason: idleSummary,
          curatorState,
          memories,
          wikiPages,
          skills,
          skillUsage,
          suggestions,
          skillActions,
          protectedSkills
        }),
        curatorReviewReport: buildCuratorReviewReport({
          now,
          dryRun: true,
          keepCandidates,
          memoryMergeGroups,
          skillConsolidationGroups,
          wikiPatchProposals,
          archiveCandidates
        })
      };
    }
    if (curatorState.paused) {
      reflectionRun = await this.dependencies.curator.updateReflectionRun({
        ...reflectionRun,
        status: "completed",
        output_summary: "Curator is paused.",
        completed_at: nowIso()
      });
      await this.dependencies.curator.saveState({
        last_run_at: now,
        last_run_summary: "Curator is paused.",
        run_count: curatorState.run_count + 1
      });
      return {
        reflectionRun,
        suggestions,
        curatorReport: buildCuratorLifecycleReport({
          now,
          dryRun: true,
          paused: true,
          skippedReason: "Curator is paused.",
          curatorState,
          memories,
          wikiPages,
          skills,
          skillUsage,
          suggestions,
          skillActions,
          protectedSkills
        }),
        curatorReviewReport: buildCuratorReviewReport({
          now,
          dryRun: true,
          keepCandidates,
          memoryMergeGroups,
          skillConsolidationGroups,
          wikiPatchProposals,
          archiveCandidates
        })
      };
    }
    const memoryInputs = await Promise.all(memories.map(async (memory) => ({
      id: memory.id,
      topic: memory.topic,
      state: memory.state,
      confidence: memory.confidence,
      updated_at: memory.updated_at,
      content: (await this.dependencies.curator.readMemory(memory.id)) ?? ""
    })));
    const memoryDecisions = curateMemory(memoryInputs, { now, archive_after_days: curatorState.archive_after_days });
    for (const decision of memoryDecisions) {
      const relatedMemories = decision.resource_ids.map((id) => memories.find((memory) => memory.id === id)).filter((memory): memory is MemoryFrontmatter & { file_path: string } => Boolean(memory));
      if (!relatedMemories.length) continue;
      const primaryMemory = relatedMemories[0];
      if (!primaryMemory) continue;
      const suggestionId = createId("suggestion");
      if (decision.kind === "merge") {
        memoryMergeGroups.push({ topic: primaryMemory.topic, memory_ids: decision.resource_ids, reason: decision.reason, suggestion_id: suggestionId });
      }
      suggestions.push({
        id: suggestionId,
        reflection_run_id: reflectionRun.id,
        suggestion_type: decision.kind === "merge" ? "conflict" : "memory_patch",
        status: "proposed",
        title: decision.kind === "merge" ? `Merge or resolve memory topic: ${primaryMemory.topic}` : `Review memory: ${primaryMemory.topic}`,
        content: `${decision.reason}\n\n${relatedMemories.map((memory) => `- ${memory.id}: ${memory.state} / confidence ${memory.confidence}`).join("\n")}`,
        target_ref: decision.kind === "merge" ? undefined : memoryRef(primaryMemory),
        source_refs: relatedMemories.map(memoryRef),
        confidence: decision.kind === "merge" ? 0.68 : 0.62,
        created_at: now,
        updated_at: now
      });
    }
    for (const wiki of wikiPages.filter((item) => item.state === "proposed" || (item.state === "active" && !item.provenance.verified)).slice(0, 20)) {
      const suggestionId = createId("suggestion");
      wikiPatchProposals.push({
        wiki_id: wiki.id,
        title: wiki.title,
        reason: wiki.state === "proposed" ? "Proposed page needs accept/reject review." : "Active page is not verified.",
        suggestion_id: suggestionId
      });
      suggestions.push({
        id: suggestionId,
        reflection_run_id: reflectionRun.id,
        suggestion_type: "knowledge_wiki",
        status: "proposed",
        title: `Review Knowledge Wiki: ${wiki.title}`,
        content: `Review this Knowledge Wiki page for acceptance, verification, or archival.\n\nState: ${wiki.state}\nVerified: ${wiki.provenance.verified ? "yes" : "no"}\n\n${(await this.dependencies.curator.readWiki(wiki.id)) ?? ""}`,
        target_ref: wikiRef(wiki),
        source_refs: [wikiRef(wiki)],
        confidence: wiki.state === "proposed" ? 0.64 : 0.7,
        created_at: now,
        updated_at: now
      });
    }
    for (const skill of skills.filter((item) => item.state !== "archived").slice(0, 50)) {
      const usage = usageBySkill.get(skill.id);
      const lastActivityAt = usage?.last_used_at ?? skill.frontmatter.last_reviewed_at;
      const lastActivityMs = lastActivityAt ? Date.parse(lastActivityAt) : Number.NaN;
      const inactiveSince = Number.isFinite(lastActivityMs) ? (lastActivityAt ?? "unknown") : "never";
      const pinned = skill.state === "pinned" || skill.frontmatter.owner_pinned;
      let curatorAction: "review" | "mark_stale" | "archive" | "reactivate" | undefined;
      if (pinned) {
        protectedSkills.push({
          skill_id: skill.id,
          title: skill.title,
          state: skill.state,
          reason: "owner_pinned"
        });
        keepCandidates.push({
          kind: "skill",
          id: skill.id,
          title: skill.title,
          reason: "Owner pinned Skill is protected from curator lifecycle changes."
        });
        continue;
      }
      const lifecycleDecision = skillLifecycleDecisions.get(skill.id) ?? { decision: "keep" as const, reason: "no_curator_decision" };
      if (evaluationFailed) {
        keepCandidates.push({ kind: "skill", id: skill.id, title: skill.title, reason: "Latest Evaluation failed; lifecycle decision is on hold." });
        continue;
      }
      if (lifecycleDecision.decision === "reactivate" || lifecycleDecision.decision === "archive" || lifecycleDecision.decision === "mark_stale" || lifecycleDecision.decision === "review") {
        curatorAction = lifecycleDecision.decision;
      } else if (lifecycleDecision.decision === "patch") {
        curatorAction = "review";
      } else {
        keepCandidates.push({ kind: "skill", id: skill.id, title: skill.title, reason: lifecycleDecision.reason });
      }
      if (!curatorAction) {
        if (usage?.last_used_at && Date.parse(usage.last_used_at) > staleCutoffMs) {
          keepCandidates.push({
            kind: "skill",
            id: skill.id,
            title: skill.title,
            reason: "Recent usage keeps this Skill in normal selection."
          });
        }
        continue;
      }
      const suggestionId = createId("suggestion");
      const proposedState = proposedSkillStateForCuratorAction(curatorAction);
      const actionReason = curatorActionReason({
        action: curatorAction,
        usageCount: usage?.use_count ?? 0,
        inactiveSince,
        staleAfterDays: curatorState.stale_after_days,
        archiveAfterDays: curatorState.archive_after_days
      });
      skillActions.push({
        skill_id: skill.id,
        title: skill.title,
        current_state: skill.state,
        ...(proposedState ? { proposed_state: proposedState } : {}),
        action: curatorAction,
        reason: actionReason,
        usage_count: usage?.use_count ?? 0,
        ...(Number.isFinite(lastActivityMs) && lastActivityAt ? { last_activity_at: lastActivityAt } : {}),
        owner_pinned: false,
        suggestion_id: suggestionId
      });
      if (curatorAction === "archive") {
        archiveCandidates.push({
          kind: "skill",
          id: skill.id,
          title: skill.title,
          reason: actionReason,
          suggestion_id: suggestionId
        });
      }
      suggestions.push({
        id: suggestionId,
        reflection_run_id: reflectionRun.id,
        suggestion_type: "skill_patch",
        status: "proposed",
        title: `Review skill: ${skill.title}`,
        content: [
          `Curator action: ${curatorAction}`,
          proposedState ? `Proposed state: ${proposedState}` : "Proposed state: review_only",
          `Reason: ${actionReason}`,
          "",
          `Skill: ${skill.id}`,
          `State: ${skill.state}`,
          `Usage count: ${usage?.use_count ?? 0}`,
          `Last activity: ${inactiveSince}`,
          `Stale threshold days: ${curatorState.stale_after_days}`,
          `Archive threshold days: ${curatorState.archive_after_days}`,
          "",
          "This lifecycle decision is applied automatically after the pre-run snapshot.",
          "",
          (await this.dependencies.curator.readSkill(skill.id)) ?? ""
        ].join("\n"),
        target_ref: skillRef(skill),
        source_refs: [skillRef(skill)],
        confidence: curatorAction === "archive" ? 0.72 : curatorAction === "mark_stale" ? 0.66 : 0.58,
        created_at: now,
        updated_at: now
      });
    }
    for (const group of buildSkillConsolidationGroups(skills)) {
      const suggestionId = createId("suggestion");
      skillConsolidationGroups.push({
        group_key: group.groupKey,
        skill_ids: group.skills.map((skill) => skill.id),
        suggested_umbrella_title: group.suggestedTitle,
        reason: group.reason,
        suggestion_id: suggestionId
      });
      suggestions.push({
        id: suggestionId,
        reflection_run_id: reflectionRun.id,
        suggestion_type: "skill_patch",
        status: "proposed",
        title: `Consolidate skills: ${group.suggestedTitle}`,
        content: [
          "Curator review action: consolidate",
          `Group key: ${group.groupKey}`,
          `Suggested umbrella title: ${group.suggestedTitle}`,
          `Reason: ${group.reason}`,
          "",
          "Candidate Skills:",
          ...group.skills.map((skill) => `- ${skill.id}: ${skill.title} (${skill.state})`),
          "",
          "This narrowed candidate is consolidated automatically only when a configured consolidator returns a complete Skill-package mutation."
        ].join("\n"),
        source_refs: group.skills.flatMap((candidate) => {
          const skill = skills.find((item) => item.id === candidate.id); return skill ? [skillRef(skill)] : [];
        }),
        confidence: 0.68,
        created_at: now,
        updated_at: now
      });
    }
    let appliedMutationCount = 0;
    try {
      for (const group of memoryMergeGroups) {
        const [primaryId, ...duplicateIds] = group.memory_ids;
        if (!primaryId || duplicateIds.length === 0) continue;
        const contents = await Promise.all(group.memory_ids.map((id) => this.dependencies.curator.readMemory(id)));
        const mergedContent = [...new Set(contents.map((content) => content?.trim()).filter((content): content is string => Boolean(content)))].join("\n\n");
        await this.dependencies.curator.replaceMemory(primaryId, mergedContent);
        for (const duplicateId of duplicateIds) await this.dependencies.curator.archiveMemory(duplicateId);
        const suggestion = suggestions.find((item) => item.id === group.suggestion_id);
        if (suggestion) suggestion.status = "applied";
        appliedMutationCount += 1;
      }
      for (const decision of memoryDecisions.filter((item) => item.kind === "stale")) {
        for (const memoryId of decision.resource_ids) await this.dependencies.curator.archiveMemory(memoryId);
        const suggestion = suggestions.find((item) => item.target_ref?.id === decision.resource_ids[0] && item.content.startsWith(decision.reason));
        if (suggestion) suggestion.status = "applied";
        appliedMutationCount += decision.resource_ids.length;
      }
      for (const group of skillConsolidationGroups) {
        const groupSkills = group.skill_ids.map((id) => skills.find((skill) => skill.id === id)).filter((skill): skill is StoredSkill => Boolean(skill));
        const packages = await Promise.all(groupSkills.map(async (skill) => ({
          id: skill.id,
          title: skill.title,
          description: skill.description,
          markdown: (await this.dependencies.curator.readSkill(skill.id)) ?? "",
          support_files: (await this.dependencies.curator.listSkillSupport(skill.id)).map((file) => ({ path: file.path, content: file.content }))
        })));
        const consolidation = await this.dependencies.curator.consolidate({ group_key: group.group_key, packages }, session);
        if (!consolidation || !group.skill_ids.includes(consolidation.primary_skill_id)) continue;
        await this.dependencies.curator.replaceSkill(consolidation.primary_skill_id, consolidation.markdown);
        for (const file of consolidation.support_files) {
          await this.dependencies.curator.writeSkillSupport({ skillId: consolidation.primary_skill_id, path: file.path, content: file.content });
        }
        for (const archiveId of consolidation.archive_skill_ids.filter((id) => id !== consolidation.primary_skill_id && group.skill_ids.includes(id))) {
          await this.dependencies.curator.updateSkillState(archiveId, "archived");
        }
        const suggestion = suggestions.find((item) => item.id === group.suggestion_id);
        if (suggestion) suggestion.status = "applied";
        appliedMutationCount += 1;
      }
      for (const action of skillActions) {
        if (action.action === "review") continue;
        await this.dependencies.curator.applySkillLifecycle({ skillId: action.skill_id, action: action.action });
        const suggestion = suggestions.find((item) => item.id === action.suggestion_id);
        if (suggestion) suggestion.status = "applied";
        appliedMutationCount += 1;
      }
    } catch (error) {
      await this.dependencies.curator.restoreSnapshot(snapshot.id);
      await this.dependencies.curator.updateReflectionRun({
        ...reflectionRun,
        status: "failed",
        error: `Curator restored ${snapshot.id}: ${this.dependencies.curator.errorMessage(error)}`,
        completed_at: nowIso()
      });
      await this.dependencies.curator.saveJobReport({
        id: createId("learning_job_report"), job_kind: "curator", run_id: reflectionRun.id,
        target_resource_count: memories.length + skills.length, mutation_count: appliedMutationCount,
        archive_count: 0, restore_count: 1, patch_count: 0, merge_count: 0,
        skipped_reasons: {}, evaluation_count: learningEvaluations.length, snapshot_id: snapshot.id,
        duration_ms: Math.max(0, Date.now() - nowMs), failure: this.dependencies.curator.errorMessage(error), created_at: nowIso()
      });
      throw error;
    }
    for (const suggestion of suggestions) {
      await this.dependencies.curator.saveSuggestion(suggestion);
    }
    reflectionRun = await this.dependencies.curator.updateReflectionRun({
      ...reflectionRun,
      status: "completed",
      output_summary: `Curator evaluated ${suggestions.length} decision(s), applied ${appliedMutationCount}, snapshot ${snapshot.id}.`,
      completed_at: nowIso()
    });
    await this.dependencies.curator.saveState({
      last_run_at: now,
      last_run_summary: reflectionRun.output_summary,
      run_count: curatorState.run_count + 1
    });
    const appliedSuggestionIds = new Set(suggestions.filter((suggestion) => suggestion.status === "applied").map((suggestion) => suggestion.id));
    await this.dependencies.curator.saveJobReport({
      id: createId("learning_job_report"), job_kind: "curator", run_id: reflectionRun.id,
      target_resource_count: memories.length + skills.length,
      mutation_count: appliedMutationCount,
      archive_count: skillActions.filter((action) => action.action === "archive").length + memoryDecisions.filter((decision) => decision.kind === "stale").reduce((sum, decision) => sum + decision.resource_ids.length, 0),
      restore_count: 0,
      patch_count: skillActions.filter((action) => action.action === "review").length,
      merge_count: [...memoryMergeGroups, ...skillConsolidationGroups].filter((group) => appliedSuggestionIds.has(group.suggestion_id ?? "")).length,
      skipped_reasons: evaluationFailed ? { evaluation_failed_hold: skills.length } : {},
      evaluation_count: learningEvaluations.length,
      snapshot_id: snapshot.id,
      duration_ms: Math.max(0, Date.parse(reflectionRun.completed_at ?? nowIso()) - Date.parse(now)),
      next_run_at: this.dependencies.curator.nextRunAt(Date.parse(now)),
      created_at: nowIso()
    });
    return {
      reflectionRun,
      suggestions,
      curatorReport: buildCuratorLifecycleReport({
        now,
        dryRun: false,
        paused: false,
        curatorState,
        memories,
        wikiPages,
        skills,
        skillUsage,
        suggestions,
        skillActions,
        protectedSkills,
        snapshotId: snapshot.id,
        evaluationCount: learningEvaluations.length,
        appliedMutationCount
      }),
      curatorReviewReport: buildCuratorReviewReport({
        now,
        dryRun: true,
        keepCandidates,
        memoryMergeGroups,
        skillConsolidationGroups,
        wikiPatchProposals,
        archiveCandidates
      })
    };
  }

  async executeEvaluation(): Promise<{ reflectionRun: ReflectionRunRecord; suggestions: ReflectionSuggestionRecord[]; evaluationReport: EvaluationTraceReport; learningEvaluations: LearningEvaluationRecord[] }> {
    const session = await this.dependencies.evaluation.ensureSession();
    const [skills, backendRuns, backendEvents, workspaceChanges, toolRuns, auditRecords, learningUses, existing] = await Promise.all([
      this.dependencies.evaluation.listSkills(), this.dependencies.evaluation.listBackendRuns(), this.dependencies.evaluation.listBackendEvents(),
      this.dependencies.evaluation.listWorkspaceChanges(), this.dependencies.evaluation.listToolRuns(), this.dependencies.evaluation.listAuditRecords(),
      this.dependencies.evaluation.listLearningUses(), this.dependencies.evaluation.listEvaluations()
    ]);
    const now = nowIso();
    let run = await this.dependencies.evaluation.createReflectionRun({ id: createId("reflection"), kind: "evaluation", session_id: session.id,
      status: "started", input_summary: `Evaluate ${backendRuns.length} backend run(s), ${backendEvents.length} backend event(s), ${workspaceChanges.length} workspace change(s), ${toolRuns.length} tool run(s), ${auditRecords.length} audit record(s), and ${skills.length} skill item(s).`, started_at: now });
    const suggestions = this.dependencies.evaluation.createSuggestions(run, { skills, backendRuns, backendEvents, workspaceChanges, toolRuns, auditRecords, now });
    const evaluationReport = await this.dependencies.evaluation.createReport({ backendRuns, backendEvents, workspaceChanges, toolRuns, auditRecords, now });
    const learningEvaluations: LearningEvaluationRecord[] = [];
    for (const use of actualLearningResourceUses(learningUses)) {
      const version = use.resource_version ?? use.content_hash;
      if (existing.some((item) => item.learning_resource_ref.id === use.resource_id && item.learning_resource_version === version && item.compared_run_ids.includes(use.run_id))) continue;
      const usedRun = backendRuns.find((item) => item.id === use.run_id); if (!usedRun) continue;
      const earlierRuns = backendRuns.filter((item) => item.id !== usedRun.id && item.backend_kind === usedRun.backend_kind && Date.parse(item.started_at) < Date.parse(usedRun.started_at)).slice(0, 5);
      const signals = (candidate: BackendRunRecord) => {
        const runTools = toolRuns.filter((tool) => tool.run_id === candidate.id); const runEvents = backendEvents.filter((event) => event.run_id === candidate.id);
        return { run_id: candidate.id, completed: candidate.status === "completed" ? 1 : 0,
          tool_failure_rate: runTools.length ? runTools.filter((tool) => tool.status === "failed").length / runTools.length : 0,
          waiting_or_retry_rate: runEvents.length ? runEvents.filter((event) => event.event_type === "backend_waiting_for_native_input" || event.event_type === "run_failed").length / runEvents.length : 0,
          workspace_change_count: workspaceChanges.filter((change) => change.run_id === candidate.id).length,
          artifact_regeneration_count: Math.max(0, workspaceChanges.filter((change) => change.run_id === candidate.id && change.change_type === "artifact_created").length - 1), correction_count: 0 };
      };
      const ref: ResourceRef = { kind: use.resource_kind, id: use.resource_id, uri: `learning/${use.resource_kind}/${encodeURIComponent(use.resource_id)}`, version };
      const evaluation = evaluateLearningEffect({ id: createId("learning_evaluation"), resource_ref: ref, resource_version: version,
        task_class: usedRun.backend_kind, before: earlierRuns.map(signals), after: [signals(usedRun)],
        evidence_refs: [ref, ...[usedRun, ...earlierRuns].map(backendRunRef)], created_at: now });
      await this.dependencies.evaluation.saveEvaluation(evaluation); learningEvaluations.push(evaluation);
    }
    if (!suggestions.length && skills.length) suggestions.push({ id: createId("suggestion"), reflection_run_id: run.id, suggestion_type: "skill_patch",
      status: "proposed", title: "Skill evaluation checkpoint",
      content: `No trace anomalies were found. Review ${skills.length} skill item(s) for freshness, coverage, and repeated manual work patterns.`,
      source_refs: [], confidence: 0.52, created_at: now, updated_at: now });
    for (const suggestion of suggestions) await this.dependencies.evaluation.saveSuggestion(suggestion);
    run = await this.dependencies.evaluation.updateReflectionRun({ ...run, status: "completed",
      output_summary: `Evaluation created ${suggestions.length} suggestion(s) and ${evaluationReport.run_scores.length} run score(s).`, completed_at: nowIso() });
    const completedAt = run.completed_at ?? nowIso();
    await this.dependencies.evaluation.saveJobReport({ id: createId("learning_job_report"), job_kind: "evaluation", run_id: run.id,
      target_resource_count: actualLearningResourceUses(learningUses).length, mutation_count: learningEvaluations.length,
      archive_count: 0, restore_count: 0, patch_count: 0, merge_count: 0,
      skipped_reasons: learningEvaluations.length ? {} : { no_new_evaluable_usage: 1 }, evaluation_count: learningEvaluations.length,
      duration_ms: Math.max(0, Date.parse(completedAt) - Date.parse(now)), next_run_at: this.dependencies.evaluation.nextRunAt(Date.parse(completedAt)), created_at: nowIso() });
    return { reflectionRun: run, suggestions, evaluationReport, learningEvaluations };
  }
}

function backendRunRef(run: BackendRunRecord): ResourceRef {
  return { kind: "backend_run", id: run.id, uri: `backend-runs/${run.id}`, label: run.input_summary };
}

function memoryRef(value: StoredMemory): ResourceRef { return { kind: "memory", id: value.id, uri: value.file_path, label: value.topic }; }
function wikiRef(value: StoredWiki): ResourceRef { return { kind: "wiki", id: value.id, uri: value.file_path, label: value.title }; }
function skillRef(value: StoredSkill): ResourceRef { return { kind: "skill", id: value.id, uri: value.file_path, label: value.title }; }
function latestBackendRunActivityMs(runs: BackendRunRecord[]): number | undefined {
  const values = runs.flatMap((run) => [run.completed_at, run.started_at]).filter((value): value is string => Boolean(value))
    .map(Date.parse).filter(Number.isFinite); return values.length ? Math.max(...values) : undefined;
}
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
function proposedSkillStateForCuratorAction(action: CuratorLifecycleAction): SkillState | undefined {
  return action === "mark_stale" ? "stale" : action === "archive" ? "archived" : action === "reactivate" ? "project" : undefined;
}
function curatorActionReason(input: { action: CuratorLifecycleAction; usageCount: number; inactiveSince: string; staleAfterDays: number; archiveAfterDays: number }): string {
  if (input.action === "archive") return `No recent activity since ${input.inactiveSince}; exceeds archive threshold of ${input.archiveAfterDays} day(s).`;
  if (input.action === "mark_stale") return `No recent activity since ${input.inactiveSince}; exceeds stale threshold of ${input.staleAfterDays} day(s).`;
  if (input.action === "reactivate") return `Recent usage detected (${input.usageCount} run(s)); restore from stale to project state.`;
  return "Needs human review before lifecycle transition.";
}

function positiveInteger(value: JsonValue | undefined): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function optionalString(value: JsonValue | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}
