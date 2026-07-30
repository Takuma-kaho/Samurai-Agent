import { type AutomationJobRecord } from "@samurai-agent/core-schemas";
import type { AutomationJobsTable } from "../kernel/workspace-db-schema";
import { parse, stringify } from "./serialization";

export function automationJobToRow(job: AutomationJobRecord): AutomationJobsTable {
  return {
    id: job.id,
    title: job.title,
    kind: job.kind,
    status: job.status,
    schedule: job.schedule,
    target_instruction: job.target_instruction,
    delivery_target_json: stringify(job.delivery_target),
    next_run_at: job.next_run_at ?? null,
    last_run_at: job.last_run_at ?? null,
    retry_after_at: job.retry_after_at ?? null,
    locked_until: job.locked_until ?? null,
    failure_count: job.failure_count ?? 0,
    max_attempts: job.max_attempts ?? 3,
    last_error: job.last_error ?? null,
    created_at: job.created_at,
    updated_at: job.updated_at
  };
}

export function automationJobFromRow(row: AutomationJobsTable): AutomationJobRecord {
  return {
    id: row.id,
    title: row.title,
    kind: row.kind as AutomationJobRecord["kind"],
    status: row.status as AutomationJobRecord["status"],
    schedule: row.schedule,
    target_instruction: row.target_instruction,
    delivery_target: parse(row.delivery_target_json),
    next_run_at: row.next_run_at ?? undefined,
    last_run_at: row.last_run_at ?? undefined,
    retry_after_at: row.retry_after_at ?? undefined,
    locked_until: row.locked_until ?? undefined,
    failure_count: row.failure_count,
    max_attempts: row.max_attempts,
    last_error: row.last_error ?? undefined,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}
