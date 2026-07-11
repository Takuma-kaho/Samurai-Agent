export interface CuratorRunReport {
  target_resource_count: number;
  mutation_count: number;
  archive_count: number;
  restore_count: number;
  patch_count: number;
  merge_count: number;
  skipped_reasons: Record<string, number>;
  evaluation_count: number;
  snapshot_id?: string;
  duration_ms: number;
  failure?: string;
  next_run_at?: string;
}

export function countReasons(reasons: string[]): Record<string, number> {
  return reasons.reduce<Record<string, number>>((counts, reason) => ({ ...counts, [reason]: (counts[reason] ?? 0) + 1 }), {});
}
