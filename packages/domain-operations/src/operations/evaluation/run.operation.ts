// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import type { AuditRecord, BackendEventRecord, BackendRunRecord, EvaluationTraceReport, LearningEvaluationRecord, LearningJobReportRecord, LearningResourceUseRecord, ReflectionRunRecord, ReflectionSuggestionRecord, ResourceRef, SkillFrontmatter, ToolRunRecord, WorkspaceChangeRecord } from "@samurai-agent/core-schemas";
import { defineCommand, type DomainResult, type TrustedDomainContext } from "../../definition/index.js";
import { evaluationRunValueSchema } from "../../value-objects/learning-run.js";

const Input = z.object({}).strict();
const Output = evaluationRunValueSchema;
interface EvaluationSignals { run_id: string; completed: number; tool_failure_rate: number; waiting_or_retry_rate: number; workspace_change_count: number; artifact_regeneration_count: number; correction_count: number }
interface EvaluationSkill { id: string; title: string; description: string; tags: string[]; allowed_scopes: SkillFrontmatter["allowed_scopes"]; required_capabilities: string[]; owner_pinned: boolean; state: SkillFrontmatter["state"]; file_path: string; frontmatter: SkillFrontmatter }

export interface EvaluationRunPorts {
  ensureEvaluationSession(): Promise<{ id: string }>;
  listEvaluationSkills(): Promise<EvaluationSkill[]>;
  listEvaluationBackendRuns(): Promise<BackendRunRecord[]>; listEvaluationBackendEvents(): Promise<BackendEventRecord[]>;
  listEvaluationWorkspaceChanges(): Promise<WorkspaceChangeRecord[]>; listEvaluationToolRuns(): Promise<ToolRunRecord[]>;
  listEvaluationAuditRecords(): Promise<AuditRecord[]>; listLearningResourceUses(): Promise<LearningResourceUseRecord[]>;
  listExistingLearningEvaluations(): Promise<LearningEvaluationRecord[]>;
  createEvaluationReflectionRun(run: ReflectionRunRecord): Promise<ReflectionRunRecord>;
  updateEvaluationReflectionRun(run: ReflectionRunRecord): Promise<ReflectionRunRecord>;
  createEvaluationSuggestions(run: ReflectionRunRecord, input: { skills: EvaluationSkill[]; backendRuns: BackendRunRecord[]; backendEvents: BackendEventRecord[]; workspaceChanges: WorkspaceChangeRecord[]; toolRuns: ToolRunRecord[]; auditRecords: AuditRecord[]; now: string }): ReflectionSuggestionRecord[];
  createEvaluationReport(input: { backendRuns: BackendRunRecord[]; backendEvents: BackendEventRecord[]; workspaceChanges: WorkspaceChangeRecord[]; toolRuns: ToolRunRecord[]; auditRecords: AuditRecord[]; now: string }): Promise<EvaluationTraceReport>;
  actualLearningUses(records: LearningResourceUseRecord[]): LearningResourceUseRecord[];
  evaluateLearningEffect(input: { id: string; resource_ref: ResourceRef; resource_version?: string; task_class: string; before: EvaluationSignals[]; after: EvaluationSignals[]; evidence_refs: ResourceRef[]; created_at: string }): LearningEvaluationRecord;
  saveLearningEvaluation(value: LearningEvaluationRecord): Promise<unknown>; saveEvaluationSuggestion(value: ReflectionSuggestionRecord): Promise<unknown>;
  saveEvaluationJobReport(value: LearningJobReportRecord): Promise<unknown>; nextEvaluationRunAt(fromMs: number): string;
  createEvaluationId(prefix: "reflection" | "learning_evaluation" | "suggestion" | "learning_job_report"): string;
  evaluationNow(): string;
}

const evaluationRun = defineCommand<EvaluationRunPorts>()({
  ...{
  "kind": "command",
  "id": "evaluation.run",
  "version": "1.0",
  "availability": "active",
  "title": "Run learning evaluation",
  "description": "Evaluate comparable Learning runs and guardrails.",
  "sources": [
    "runtime_api",
    "automation",
    "scheduled_context"
  ],
  "effect": "workspace_mutation",
  "idempotency": "required",
  "concurrency": "none",
  "render": [
    "status_timeline"
  ],
  "resourceKinds": [
    "learning_evaluation"
  ],
  "proposedEffects": [
    "Evaluate Learning outcomes and guardrails."
  ],
  "outputResourceKind": "learning_evaluation",
  "uiDisplayCategory": "memory",
  "provenance": [
    {
      "source": "samurai",
      "commit_sha": "workspace-design-v1",
      "reference_file": "ARCHITECTURE.md",
      "decision": "adapted",
      "reason": "Use a server-owned contract and a shared Runtime boundary for Workspace state."
    }
  ]
},
  input: Input,
  output: Output,
  createHandler(ports) {
    return {
      execute: async function handleEvaluationRun(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        const session = await ports.ensureEvaluationSession();
        const [skills, backendRuns, backendEvents, workspaceChanges, toolRuns, auditRecords, learningUses, existing] = await Promise.all([
          ports.listEvaluationSkills(), ports.listEvaluationBackendRuns(), ports.listEvaluationBackendEvents(), ports.listEvaluationWorkspaceChanges(),
          ports.listEvaluationToolRuns(), ports.listEvaluationAuditRecords(), ports.listLearningResourceUses(), ports.listExistingLearningEvaluations()
        ]);
        const now = ports.evaluationNow();
        let run = await ports.createEvaluationReflectionRun({ id: ports.createEvaluationId("reflection"), kind: "evaluation", session_id: session.id,
          status: "started", input_summary: `Evaluate ${backendRuns.length} backend run(s), ${backendEvents.length} backend event(s), ${workspaceChanges.length} workspace change(s), ${toolRuns.length} tool run(s), ${auditRecords.length} audit record(s), and ${skills.length} skill item(s).`, started_at: now });
        const suggestions = ports.createEvaluationSuggestions(run, { skills, backendRuns, backendEvents, workspaceChanges, toolRuns, auditRecords, now });
        const evaluationReport = await ports.createEvaluationReport({ backendRuns, backendEvents, workspaceChanges, toolRuns, auditRecords, now });
        const learningEvaluations: LearningEvaluationRecord[] = [];
        const actualUses = ports.actualLearningUses(learningUses);
        for (const use of actualUses) {
          const version = use.resource_version ?? use.content_hash;
          if (existing.some((item) => item.learning_resource_ref.id === use.resource_id && item.learning_resource_version === version && item.compared_run_ids.includes(use.run_id))) continue;
          const usedRun = backendRuns.find((item) => item.id === use.run_id);
          if (!usedRun) continue;
          const earlierRuns = backendRuns.filter((item) => item.id !== usedRun.id && item.backend_kind === usedRun.backend_kind && Date.parse(item.started_at) < Date.parse(usedRun.started_at)).slice(0, 5);
          const signals = (candidate: BackendRunRecord): EvaluationSignals => {
            const runTools = toolRuns.filter((tool) => tool.run_id === candidate.id);
            const runEvents = backendEvents.filter((event) => event.run_id === candidate.id);
            return { run_id: candidate.id, completed: candidate.status === "completed" ? 1 : 0,
              tool_failure_rate: runTools.length ? runTools.filter((tool) => tool.status === "failed").length / runTools.length : 0,
              waiting_or_retry_rate: runEvents.length ? runEvents.filter((event) => event.event_type === "backend_waiting_for_native_input" || event.event_type === "run_failed").length / runEvents.length : 0,
              workspace_change_count: workspaceChanges.filter((change) => change.run_id === candidate.id).length,
              artifact_regeneration_count: Math.max(0, workspaceChanges.filter((change) => change.run_id === candidate.id && change.change_type === "artifact_created").length - 1), correction_count: 0 };
          };
          const ref: ResourceRef = { kind: use.resource_kind, id: use.resource_id, uri: `learning/${use.resource_kind}/${encodeURIComponent(use.resource_id)}`, version };
          const backendRef = (candidate: BackendRunRecord): ResourceRef => ({ kind: "backend_run", id: candidate.id, uri: `backend-runs/${candidate.id}`, label: candidate.input_summary });
          const evaluation = ports.evaluateLearningEffect({ id: ports.createEvaluationId("learning_evaluation"), resource_ref: ref, resource_version: version,
            task_class: usedRun.backend_kind, before: earlierRuns.map(signals), after: [signals(usedRun)], evidence_refs: [ref, ...[usedRun, ...earlierRuns].map(backendRef)], created_at: now });
          await ports.saveLearningEvaluation(evaluation); learningEvaluations.push(evaluation);
        }
        if (!suggestions.length && skills.length) suggestions.push({ id: ports.createEvaluationId("suggestion"), reflection_run_id: run.id, suggestion_type: "skill_patch",
          status: "proposed", title: "Skill evaluation checkpoint", content: `No trace anomalies were found. Review ${skills.length} skill item(s) for freshness, coverage, and repeated manual work patterns.`,
          source_refs: [], confidence: 0.52, created_at: now, updated_at: now });
        for (const suggestion of suggestions) await ports.saveEvaluationSuggestion(suggestion);
        run = await ports.updateEvaluationReflectionRun({ ...run, status: "completed", output_summary: `Evaluation created ${suggestions.length} suggestion(s) and ${evaluationReport.run_scores.length} run score(s).`, completed_at: ports.evaluationNow() });
        const completedAt = run.completed_at ?? ports.evaluationNow();
        await ports.saveEvaluationJobReport({ id: ports.createEvaluationId("learning_job_report"), job_kind: "evaluation", run_id: run.id,
          target_resource_count: actualUses.length, mutation_count: learningEvaluations.length, archive_count: 0, restore_count: 0, patch_count: 0, merge_count: 0,
          skipped_reasons: learningEvaluations.length ? {} : { no_new_evaluable_usage: 1 }, evaluation_count: learningEvaluations.length,
          duration_ms: Math.max(0, Date.parse(completedAt) - Date.parse(now)), next_run_at: ports.nextEvaluationRunAt(Date.parse(completedAt)), created_at: ports.evaluationNow() });
        return { ok: true, value: { reflectionRun: run, suggestions, evaluationReport, learningEvaluations } };
      }
    };
  }
});

export default evaluationRun;
