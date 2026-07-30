import { type ToolRunDiagnosticsGroup, type ToolRunRecord, type ToolRunStatus } from "@samurai-agent/core-schemas";

export function normalizeToolRunDiagnosticsLimit(limit: number | undefined): number {
if (limit === undefined || !Number.isFinite(limit)) {
  return 100;
}
return Math.min(500, Math.max(1, Math.trunc(limit)));
}

export function groupToolRunDiagnostics(toolRuns: ToolRunRecord[]): ToolRunDiagnosticsGroup[] {
const groups = new Map<string, {
  provider_tool_name: string;
  action_id?: string;
  status: ToolRunStatus;
  count: number;
  latest_tool_run: ToolRunRecord;
  reasons: Map<string, number>;
}>();

for (const toolRun of toolRuns) {
  const key = `${toolRun.provider_tool_name}\u0000${toolRun.action_id ?? ""}\u0000${toolRun.status}`;
  const existing = groups.get(key);
  const reason = toolRun.output_summary || "unknown";
  if (existing) {
    existing.count += 1;
    existing.reasons.set(reason, (existing.reasons.get(reason) ?? 0) + 1);
    if (toolRun.created_at > existing.latest_tool_run.created_at) {
      existing.latest_tool_run = toolRun;
    }
    continue;
  }
  groups.set(key, {
    provider_tool_name: toolRun.provider_tool_name,
    action_id: toolRun.action_id,
    status: toolRun.status,
    count: 1,
    latest_tool_run: toolRun,
    reasons: new Map([[reason, 1]])
  });
}

return [...groups.values()]
  .map((group) => ({
    provider_tool_name: group.provider_tool_name,
    ...(group.action_id ? { action_id: group.action_id } : {}),
    status: group.status,
    count: group.count,
    latest_tool_run: group.latest_tool_run,
    reasons: [...group.reasons.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason))
  }))
  .sort((a, b) => b.count - a.count || b.latest_tool_run.created_at.localeCompare(a.latest_tool_run.created_at));
}
