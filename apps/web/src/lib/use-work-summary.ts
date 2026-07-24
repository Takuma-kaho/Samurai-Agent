import { computed, ref, type Ref } from "vue";
import type {
  ApprovalRequest,
  ArtifactRecord,
  BackendEventRecord,
  BackendRunRecord,
  OperationRecord,
  ResourceRef,
  RollbackPoint,
  SessionRecord,
  WorkspaceChangeRecord
} from "@samurai-agent/core-schemas";
import type { LocaleKey } from "@samurai-agent/localization";
import type { PendingAgentStreamItem, WorkActivityItem, WorkActivityKind } from "./use-agent-stream";

export type WorkChangeCard = { change: WorkspaceChangeRecord; rollbackPoint?: RollbackPoint; added?: number; removed?: number };
export type WorkSummaryBlock = {
  run?: BackendRunRecord;
  summary: string;
  artifacts: ArtifactRecord[];
  changes: WorkChangeCard[];
  activityItems: WorkActivityItem[];
  pendingRequests: ApprovalRequest[];
  added?: number;
  removed?: number;
};
export type WorkChangeSummaryKind = "files" | "workspace";
type MessageView = { id: string; role: string; state?: string };

export function useWorkSummary(input: {
  activeSession: Ref<SessionRecord | null>;
  backendRuns: Ref<BackendRunRecord[]>;
  backendEvents: Ref<BackendEventRecord[]>;
  workspaceChanges: Ref<WorkspaceChangeRecord[]>;
  artifacts: Ref<ArtifactRecord[]>;
  rollbackPoints: Ref<RollbackPoint[]>;
  approvalRequests: Ref<ApprovalRequest[]>;
  operationsById: Readonly<Ref<Map<string, OperationRecord>>>;
  currentMessages: Readonly<Ref<MessageView[]>>;
  label: (key: LocaleKey) => string;
  codexStyleStreamItemsForEvents: (events: BackendEventRecord[]) => PendingAgentStreamItem[];
  backendEventSummary: (event: BackendEventRecord) => string;
}) {
  const workChangesExpanded = ref(false);
  const openWorkActivityRunIds = ref<Set<string>>(new Set());
  const latestBackendEvents = computed(() => {
    const sessionId = input.activeSession.value?.id;
    return sessionId
      ? input.backendEvents.value.filter((event) => event.session_id === sessionId).slice(-8).reverse()
      : input.backendEvents.value.slice(0, 8);
  });
  const latestBackendRun = computed(() => {
    const sessionId = input.activeSession.value?.id;
    return input.backendRuns.value.filter((run) => !sessionId || run.session_id === sessionId).sort(newestRunFirst)[0];
  });
  const hasActivity = computed(() => latestBackendEvents.value.length > 0);
  const pendingLegacyApprovals = computed(() => input.approvalRequests.value.filter((request) => {
    if (request.status !== "pending") return false;
    const operation = input.operationsById.value.get(request.operation_id);
    return !input.activeSession.value || operation?.session_id === input.activeSession.value.id;
  }));
  const workSummaryBlock = computed<WorkSummaryBlock | undefined>(() => {
    const sessionId = input.activeSession.value?.id;
    const run = input.backendRuns.value.filter((item) => !sessionId || item.session_id === sessionId).sort(newestRunFirst)[0];
    const allChanges = input.workspaceChanges.value
      .filter((change) => (!sessionId || change.session_id === sessionId) && (!run || change.run_id === run.id))
      .map((change) => ({
        change,
        rollbackPoint: input.rollbackPoints.value.find((point) => point.affected_resources.some((ref) => ref.id === change.resource_ref.id)),
        ...workspaceChangeStats(change)
      }));
    const changes = allChanges.filter((item) => isUserFacingWorkChange(item.change));
    const artifacts = input.artifacts.value.filter((artifact) => !run || changes.some((item) => item.change.resource_ref.id === artifact.id || item.change.resource_ref.uri === artifact.file_ref.uri));
    if (!run && artifacts.length === 0 && changes.length === 0 && pendingLegacyApprovals.value.length === 0) return undefined;
    const events = run ? input.backendEvents.value.filter((event) => event.run_id === run.id).sort((a, b) => a.sequence - b.sequence) : [];
    const totals = changes.reduce((sum, item) => ({
      added: sum.added + (item.added ?? 0),
      removed: sum.removed + (item.removed ?? 0),
      hasStats: sum.hasStats || item.added !== undefined || item.removed !== undefined
    }), { added: 0, removed: 0, hasStats: false });
    return {
      run,
      summary: runDurationLabel(run),
      artifacts: artifacts.slice(0, 3),
      changes,
      activityItems: summarizeWorkActivity(events),
      pendingRequests: pendingLegacyApprovals.value,
      ...(totals.hasStats ? { added: totals.added, removed: totals.removed } : {})
    };
  });
  const workSummaryCodexStreamItems = computed(() => {
    const run = workSummaryBlock.value?.run;
    return run ? input.codexStyleStreamItemsForEvents(input.backendEvents.value.filter((event) => event.run_id === run.id).sort((a, b) => a.sequence - b.sequence)) : [];
  });
  const visibleWorkChanges = computed(() => {
    const changes = workSummaryBlock.value?.changes ?? [];
    return workChangesExpanded.value ? changes : changes.slice(0, 3);
  });
  const hiddenWorkChangeCount = computed(() => Math.max(0, (workSummaryBlock.value?.changes.length ?? 0) - visibleWorkChanges.value.length));
  const firstReversibleWorkRollback = computed(() => workSummaryBlock.value?.changes.find((item) => item.rollbackPoint?.reversible)?.rollbackPoint);
  const workSummaryMessageId = computed(() => {
    const runMessageId = workSummaryBlock.value?.run?.output_message_id;
    if (runMessageId && input.currentMessages.value.some((message) => message.id === runMessageId)) return runMessageId;
    return [...input.currentMessages.value].reverse().find((message) => message.role === "agent" && message.state !== "loading")?.id ?? "";
  });

  function changeResourceLabel(change: WorkspaceChangeRecord): string { return resourceDisplayName(change.resource_ref); }
  function resourceKindLabel(ref: ResourceRef): string { return input.label(`resource.kind.${ref.kind === "collection_record" ? "collection" : ref.kind}` as LocaleKey); }
  function resourceExtensionLabel(ref: ResourceRef): string { return /\.([a-z0-9]+)$/i.exec(resourceDisplayName(ref))?.[1]?.toUpperCase() ?? resourceKindLabel(ref); }
  function changeStatsLabel(item: WorkChangeCard): string { return item.added === undefined && item.removed === undefined ? "" : `+${item.added ?? 0} -${item.removed ?? 0}`; }
  function workSummaryChangeTitle(block: WorkSummaryBlock): string {
    if (block.changes.length === 0) return "";
    return input.label(workChangeSummaryKind(block) === "files" ? "workspace_change.files_changed" : "workspace_change.workspace_items_changed").replace("{count}", String(block.changes.length));
  }
  function workSummaryStatsLabel(block: WorkSummaryBlock): string { return block.added === undefined && block.removed === undefined ? "" : `+${block.added ?? 0} -${block.removed ?? 0}`; }
  function summarizeWorkActivity(events: BackendEventRecord[]): WorkActivityItem[] {
    const order: WorkActivityKind[] = ["files_read", "code_searched", "command_run", "browser_checked", "artifact_created", "workspace_prepared", "memory_prepared", "skill_prepared", "waiting"];
    const counts = new Map<WorkActivityKind, number>();
    for (const event of events) {
      const kind = workActivityKind(event, input.backendEventSummary);
      if (kind) counts.set(kind, (counts.get(kind) ?? 0) + 1);
    }
    return order.filter((kind) => counts.has(kind)).map((kind) => ({ kind, label: input.label(`work_activity.${kind}` as LocaleKey).replace("{count}", String(counts.get(kind) ?? 0)), count: counts.get(kind) })).slice(0, 6);
  }
  function runDurationLabel(run: BackendRunRecord | undefined): string {
    if (!run) return input.label("work_summary.did_work");
    if (run.status === "outcome_unknown") return input.label("backend_run.outcome_unknown.summary");
    const started = Date.parse(run.started_at), completed = run.completed_at ? Date.parse(run.completed_at) : Number.NaN;
    if (!Number.isFinite(started) || !Number.isFinite(completed) || completed < started) return input.label("work_summary.did_work");
    const seconds = Math.max(1, Math.round((completed - started) / 1000));
    return seconds < 60
      ? input.label("work_summary.did_work_seconds").replace("{seconds}", String(seconds))
      : input.label("work_summary.did_work_minutes").replace("{minutes}", String(Math.max(1, Math.round(seconds / 60))));
  }
  function isWorkSummaryMessage(message: MessageView): boolean { return message.role === "agent" && message.state !== "loading" && Boolean(workSummaryBlock.value) && workSummaryMessageId.value === message.id; }
  function hasNewerUserMessage(message: MessageView): boolean {
    const index = input.currentMessages.value.findIndex((item) => item.id === message.id);
    return index >= 0 && input.currentMessages.value.slice(index + 1).some((item) => item.role === "user");
  }
  function isWorkActivityVisible(message: MessageView, block: WorkSummaryBlock): boolean {
    return Boolean(block.run?.id && openWorkActivityRunIds.value.has(block.run.id) && !hasNewerUserMessage(message));
  }
  function toggleWorkActivity(block: WorkSummaryBlock) {
    if (!block.run?.id) return;
    const next = new Set(openWorkActivityRunIds.value);
    if (next.has(block.run.id)) next.delete(block.run.id); else next.add(block.run.id);
    openWorkActivityRunIds.value = next;
  }

  return {
    latestBackendEvents, latestBackendRun, hasActivity, pendingLegacyApprovals, workSummaryBlock,
    workSummaryCodexStreamItems, visibleWorkChanges, hiddenWorkChangeCount, firstReversibleWorkRollback,
    workSummaryMessageId, workChangesExpanded, changeResourceLabel, resourceKindLabel, resourceDisplayName,
    resourceLineLabel, resourceExtensionLabel, changeStatsLabel, workSummaryChangeTitle, workSummaryStatsLabel,
    isWorkSummaryMessage, hasNewerUserMessage, isWorkActivityVisible, toggleWorkActivity, runDurationLabel
  };
}

function newestRunFirst(a: BackendRunRecord, b: BackendRunRecord): number { return Date.parse(b.started_at) - Date.parse(a.started_at); }
function resourceDisplayName(ref: ResourceRef): string {
  const normalized = (ref.label || ref.uri || ref.id).replace(/^file:\/\//, "");
  return normalized.split(/[\\/]/).filter(Boolean).at(-1) ?? normalized;
}
function resourceLineLabel(ref: ResourceRef): string { return /(?:#L|:line=|[?&]line=)(\d+)/.exec(ref.uri)?.[1] ? `line ${/(?:#L|:line=|[?&]line=)(\d+)/.exec(ref.uri)?.[1]}` : ""; }
function isUserFacingWorkChange(change: WorkspaceChangeRecord): boolean {
  const kind = change.resource_ref.kind === "collection_record" ? "collection" : change.resource_ref.kind;
  if (["file", "artifact", "collection", "wiki", "skill"].includes(kind)) return true;
  if (kind !== "memory") return false;
  return !resourceDisplayName(change.resource_ref).toLowerCase().includes("session") && !change.summary.toLowerCase().includes("captured session memory");
}
function workspaceChangeStats(change: WorkspaceChangeRecord): { added?: number; removed?: number } {
  const match = /\+(\d+)\s+-(\d+)/.exec([change.summary, change.resource_ref.label, change.resource_ref.version].filter(Boolean).join(" "));
  return match ? { added: Number(match[1]), removed: Number(match[2]) } : {};
}
function workChangeSummaryKind(block: WorkSummaryBlock): WorkChangeSummaryKind {
  return block.artifacts.length > 0 || !block.changes.every((item) => item.change.resource_ref.kind === "file") ? "workspace" : "files";
}
function workActivityKind(event: BackendEventRecord, backendEventSummary: (event: BackendEventRecord) => string): WorkActivityKind | undefined {
  if (event.event_type === "artifact_created") return "artifact_created";
  if (event.event_type === "workspace_change_suggested") return "workspace_prepared";
  if (event.event_type === "memory_suggested") return "memory_prepared";
  if (event.event_type === "skill_candidate_created") return "skill_prepared";
  if (event.event_type === "backend_waiting_for_native_input") return "waiting";
  if (event.event_type !== "tool_call_started" && event.event_type !== "tool_call_output") return undefined;
  const toolName = typeof event.payload.provider_tool_name === "string" ? event.payload.provider_tool_name : "";
  if (toolName === "samurai.artifact.create" || toolName === "mcp__samurai__artifact_create" || event.payload.action_id === "artifact.create") return "artifact_created";
  const text = backendEventSummary(event).toLowerCase();
  if (/\b(rg|grep|search|find)\b|検索/.test(text)) return "code_searched";
  if (/\b(cat|sed|read|open|nl|less)\b|読み込み|read file/.test(text)) return "files_read";
  if (/browser|playwright|http|localhost|127\.0\.0\.1|ブラウザ/.test(text)) return "browser_checked";
  return "command_run";
}
