import type { JsonColumn } from "./json-column";

export interface AutomationRunsTable { id: string; kind: string; source: string; session_id: string | null; backend_run_id: string | null; status: string; operation_id: string | null; started_at: string; completed_at: string | null; error: string | null; }
export interface AutomationJobsTable { id: string; title: string; kind: string; status: string; schedule: string; target_instruction: string; delivery_target_json: JsonColumn; next_run_at: string | null; last_run_at: string | null; retry_after_at: string | null; locked_until: string | null; failure_count: number; max_attempts: number; last_error: string | null; created_at: string; updated_at: string; }
