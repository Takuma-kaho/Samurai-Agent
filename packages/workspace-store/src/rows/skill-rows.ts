import type { JsonColumn } from "./json-column";

export interface SkillIndexTable { id: string; state: string; title: string; description: string; tags_json: JsonColumn; required_capabilities_json: JsonColumn; usage_scope_kind: string | null; usage_scope_ref_id: string | null; file_path: string; frontmatter_json: JsonColumn; created_at: string; updated_at: string; }
export interface SkillUsageTable { skill_id: string; use_count: number; last_used_at: string | null; last_run_id: string | null; created_at: string; updated_at: string; }
export interface SkillOptimizationRunsTable { id: string; target_skill_id: string; session_id: string | null; status: string; run_json: JsonColumn; created_at: string; updated_at: string; }
export interface SkillOptimizationDatasetsTable { id: string; skill_id: string; dataset_json: JsonColumn; created_at: string; }
export interface OptimizationCandidatesTable { id: string; run_id: string; skill_id: string; content_hash: string; body: string; candidate_json: JsonColumn; created_at: string; updated_at: string; }
export interface OptimizationEvaluationsTable { id: string; run_id: string; candidate_id: string; evaluation_json: JsonColumn; created_at: string; }
export interface OptimizationPromotionsTable { id: string; run_id: string; candidate_id: string; skill_id: string; promotion_json: JsonColumn; created_at: string; }
export interface SkillOptimizationSnapshotsTable { id: string; skill_id: string; candidate_id: string; content_hash: string; markdown: string; snapshot_json: JsonColumn; created_at: string; restored_at: string | null; }
export interface SkillOptimizationLocksTable { skill_id: string; run_id: string; acquired_at: string; }
