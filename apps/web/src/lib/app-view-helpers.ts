import type { BackendEventRecord, BackendRunRecord, SessionRecord } from "@samurai-agent/core-schemas";
import type { LocaleKey } from "@samurai-agent/localization";
import type { AgentBackendStatus, SearchResult } from "./api";

export type ProviderErrorReason = "not_configured" | "auth_failed" | "rate_limited" | "temporary_unavailable" | "model_not_found" | "invalid_model" | "invalid_response" | "network" | "unknown";
export type ProviderNotice = { error: "provider_not_configured" | "provider_failed"; reason: ProviderErrorReason; provider?: string; model?: string; status?: number; retryable: boolean };

export function backendEventSummary(event: BackendEventRecord): string {
  const candidates = [event.payload.text, event.payload.message, event.payload.output_summary, event.payload.error_code, event.payload.status, event.payload.reason];
  const summary = candidates.find((value) => typeof value === "string" && value.trim().length > 0);
  return typeof summary === "string" ? summary.slice(0, 120) : event.event_type;
}

export function backendEventPayload(event: BackendEventRecord): string { return JSON.stringify(event.payload, null, 2); }
export function backendRunStatusLabel(run: BackendRunRecord, label: (key: LocaleKey) => string): string {
  if (run.status === "outcome_unknown") return label("backend_run.status.outcome_unknown");
  if (run.status === "completed") return label("backend_run.status.completed");
  if (run.status === "failed") return label("backend_run.status.failed");
  if (run.status === "cancelled") return label("backend_run.status.cancelled");
  if (run.status === "waiting_for_backend_input") return label("backend_run.status.waiting_for_backend_input");
  if (run.status === "running") return label("backend_run.status.running");
  return label("backend_run.status.queued");
}

export function backendRunNote(run: BackendRunRecord, label?: (key: LocaleKey) => string): string {
  if (run.status === "outcome_unknown" && label) return label("backend_run.outcome_unknown.body");
  return run.output_summary || run.error_code || "";
}

export function backendRunContextSummary(run: BackendRunRecord | undefined): string {
  const handoff = contextSources(run?.metadata?.context_handoff_sources, true);
  const sources = handoff.length > 0 ? handoff : contextSources(run?.metadata?.context_assembly_sources, false);
  if (sources.length === 0) return "文脈情報: 未使用";
  const labels: Record<string, string> = { freeze_snapshot: "プロフィール", session_search: "過去会話検索", active_memory: "Memory", knowledge_wiki: "Knowledge Wiki", selected_skills: "Skill", collection_notes: "Collection", external_assist: "External assist", recent_messages: "直近会話", available_tools: "ツール", gateway_boundary: "Gateway" };
  const tracked = new Set(Object.keys(labels));
  const parts = sources.filter((item) => tracked.has(item.kind)).map((source) => {
    const mode = source.mode === "pointer" ? "参照先" : source.mode === "inline" ? "本文" : "";
    const status = source.status === "skipped" || source.mode === "skipped" ? "スキップ" : source.included_count > 0 ? `${mode || "使用"} ${source.included_count}件` : "未使用";
    return `${labels[source.kind] ?? source.kind}: ${status}`;
  });
  return parts.length > 0 ? parts.join(" / ") : "文脈情報: 未使用";
}

export function backendDisplayLabel(backend: AgentBackendStatus): string {
  const source = `${backend.kind} ${backend.id} ${backend.label}`.toLowerCase();
  if (source.includes("claude")) return "Claude Code";
  if (source.includes("codex")) return "Codex";
  return backend.label;
}

export function displayTitle(title: string, fallback: string): string { return isInitialTitle(title) ? fallback : title; }
export function sessionDisplayTitle(session: SessionRecord, fallback: string): string { return displayTitle(session.title, fallback); }
export function resultDisplayTitle(result: SearchResult, fallback: string): string { return displayTitle(result.title, fallback); }
export function isInitialTitle(title: string): boolean { return ["", "new chat", "untitled chat"].includes(title.trim().toLowerCase()); }
export function isInternalSessionTitle(title: string): boolean { return title === "Workspace operations"; }
export function draftSessionTitle(content: string): string { const title = content.replace(/\s+/g, " ").trim(); return title.length > 60 ? `${title.slice(0, 57)}...` : title || "New chat"; }

export function normalizeProviderNotice(value: Record<string, unknown>): ProviderNotice {
  const error = value.error === "provider_not_configured" ? "provider_not_configured" : "provider_failed";
  const reason = isProviderErrorReason(value.reason) ? value.reason : error === "provider_not_configured" ? "not_configured" : "unknown";
  return { error, reason, provider: typeof value.provider === "string" ? value.provider : undefined, model: typeof value.model === "string" ? value.model : undefined, status: typeof value.status === "number" ? value.status : undefined, retryable: value.retryable === true };
}

export function formatProviderNoticeDetails(notice: ProviderNotice | null): string {
  if (!notice) return "";
  return [notice.provider ? `provider=${notice.provider}` : "", notice.model ? `model=${notice.model}` : "", notice.status ? `status=${notice.status}` : "", `retryable=${notice.retryable ? "true" : "false"}`].filter(Boolean).join(" / ");
}

function isProviderErrorReason(value: unknown): value is ProviderErrorReason {
  return ["not_configured", "auth_failed", "rate_limited", "temporary_unavailable", "model_not_found", "invalid_model", "invalid_response", "network", "unknown"].includes(String(value));
}

type ContextSource = { kind: string; included_count: number; candidate_count?: number; mode?: string; status?: string };
function contextSources(value: unknown, requireMode: boolean): ContextSource[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item) || typeof item.kind !== "string" || typeof item.included_count !== "number" || (requireMode && typeof item.mode !== "string")) return [];
    return [{ kind: item.kind, included_count: item.included_count, ...(typeof item.candidate_count === "number" ? { candidate_count: item.candidate_count } : {}), ...(typeof item.mode === "string" ? { mode: item.mode } : {}), ...(typeof item.status === "string" ? { status: item.status } : item.mode === "skipped" ? { status: "skipped" } : {}) }];
  });
}
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
