import {
  type ExternalAssistDiagnosticsGroup,
  type ExternalAssistDiagnosticsReport,
  type ExternalAssistPhase,
  type ExternalAssistRecord,
  type ExternalAssistStatus
} from "@samurai-agent/core-schemas";

export function normalizeExternalAssistDiagnosticsLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return 100;
  }
  return Math.min(500, Math.max(1, Math.trunc(limit)));
}

export function groupExternalAssistDiagnostics(records: ExternalAssistRecord[]): ExternalAssistDiagnosticsGroup[] {
  const groups = new Map<string, {
    provider_id: string;
    phase: ExternalAssistPhase;
    status: ExternalAssistStatus;
    count: number;
    hint_count: number;
    latest_record: ExternalAssistRecord;
  }>();

  for (const record of records) {
    const key = `${record.provider_id}\u0000${record.phase}\u0000${record.status}`;
    const existing = groups.get(key);
    if (existing) {
      existing.count += 1;
      existing.hint_count += record.hints.length;
      if (record.created_at > existing.latest_record.created_at) {
        existing.latest_record = record;
      }
      continue;
    }
    groups.set(key, {
      provider_id: record.provider_id,
      phase: record.phase,
      status: record.status,
      count: 1,
      hint_count: record.hints.length,
      latest_record: record
    });
  }

  return [...groups.values()].sort((a, b) =>
    b.count - a.count || b.latest_record.created_at.localeCompare(a.latest_record.created_at)
  );
}

export function externalAssistDiagnosticsViolations(records: ExternalAssistRecord[]): ExternalAssistDiagnosticsReport["violations"] {
  return records.flatMap((record) => {
    const violations: ExternalAssistDiagnosticsReport["violations"] = [];
    if (!record.isolated_from_memory) {
      violations.push({
        code: "external_assist_not_isolated",
        record_id: record.id,
        provider_id: record.provider_id,
        phase: record.phase,
        status: record.status,
        message: "External Assist record must stay isolated from Memory and Knowledge Wiki source-of-truth records."
      });
    }
    if (record.included_in_active_memory) {
      violations.push({
        code: "external_assist_included_in_active_memory",
        record_id: record.id,
        provider_id: record.provider_id,
        phase: record.phase,
        status: record.status,
        message: "External Assist record must not be included in active Memory retrieval."
      });
    }
    return violations;
  });
}

export function externalAssistDiagnosticsRecommendation(records: ExternalAssistRecord[], violations: ExternalAssistDiagnosticsReport["violations"]): string {
  if (violations.length > 0) {
    return "External Assist crossed the Memory isolation boundary. Keep provider hints as unverified context only and review the affected records.";
  }
  if (records.some((record) => record.status === "failed")) {
    return "External Assist stayed isolated, but recent provider failures should be reviewed before relying on those hints.";
  }
  if (records.length === 0) {
    return "No External Assist records were found in the selected scope.";
  }
  return "External Assist records are isolated from Memory and available as unverified assistive context.";
}
