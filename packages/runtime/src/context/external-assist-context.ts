import { createId, nowIso, type ContextPreview, type ExternalAssistHint, type ExternalAssistRecord, type MessageRecord } from "@samurai-agent/core-schemas";

export interface ExternalAssistProviderPort {
  readonly id: string;
  prefetch(input: { sessionId: string; query: string; recentMessages: MessageRecord[]; sessionSearch: Array<{ kind: string; id: string; title: string; summary: string }> }): Promise<ExternalAssistHint[]>;
}

export interface ExternalAssistContextStore {
  listExternalAssistRecords(input: { sessionId: string; limit: number }): Promise<ExternalAssistRecord[]>;
  saveExternalAssistRecord(record: ExternalAssistRecord): Promise<ExternalAssistRecord>;
}

export function emptyExternalAssistContext(role: "assistive" | "disabled", note: string): ContextPreview["external_assist"] {
  return { role, isolated_from_memory: true, included_in_active_memory: false, note, hints: [], recent_failures: [] };
}

export async function buildExternalAssistContext(input: {
  store: ExternalAssistContextStore;
  providers: readonly ExternalAssistProviderPort[];
  sessionId: string;
  query: string;
  role: "assistive" | "disabled";
  recentMessages: MessageRecord[];
  sessionSearch: Array<{ kind: string; id: string; title: string; summary: string }>;
}): Promise<ContextPreview["external_assist"]> {
  const prefetchRecords = await runExternalAssistPrefetch(input);
  const records = await input.store.listExternalAssistRecords({ sessionId: input.sessionId, limit: 8 });
  const completed = prefetchRecords.filter((record) => record.status === "completed");
  const lastPrefetch = completed[0] ?? records.find((record) => record.phase === "prefetch" && record.status === "completed");
  const recentFailures = records.filter((record) => record.status === "failed").slice(0, 3);
  const hints = completed.length > 0 ? completed.flatMap((record) => record.hints) : lastPrefetch?.status === "completed" ? lastPrefetch.hints : [];
  return { role: input.role, isolated_from_memory: true, included_in_active_memory: false, note: externalAssistNote(input.role, input.providers.map((provider) => provider.id), prefetchRecords, hints.length, recentFailures.length), hints, ...(lastPrefetch ? { last_prefetch: lastPrefetch } : {}), recent_failures: recentFailures };
}

async function runExternalAssistPrefetch(input: Parameters<typeof buildExternalAssistContext>[0]): Promise<ExternalAssistRecord[]> {
  if (input.role === "disabled" || input.providers.length === 0) return [];
  return Promise.all(input.providers.map(async (provider) => {
    const now = nowIso();
    try {
      const hints = normalizeExternalAssistHints(await provider.prefetch({ sessionId: input.sessionId, query: input.query, recentMessages: input.recentMessages, sessionSearch: input.sessionSearch }));
      return input.store.saveExternalAssistRecord({ id: createId("external_assist"), phase: "prefetch", status: "completed", provider_id: provider.id, session_id: input.sessionId, query: input.query, role: input.role, hints, isolated_from_memory: true, included_in_active_memory: false, created_at: now, updated_at: now });
    } catch (error) {
      return input.store.saveExternalAssistRecord({ id: createId("external_assist"), phase: "prefetch", status: "failed", provider_id: provider.id, session_id: input.sessionId, query: input.query, role: input.role, hints: [], error: safeExternalAssistError(error), isolated_from_memory: true, included_in_active_memory: false, created_at: now, updated_at: now });
    }
  }));
}

export function normalizeExternalAssistHints(hints: ExternalAssistHint[] | void): ExternalAssistHint[] {
  return (hints ?? []).slice(0, 5).map((hint, index) => ({
    id: hint.id?.trim() || createId("external_hint"),
    ...(hint.title?.trim() ? { title: hint.title.trim() } : {}),
    summary: hint.summary.trim() || `External assist hint ${index + 1}.`,
    ...(hint.source_uri?.trim() ? { source_uri: hint.source_uri.trim() } : {}),
    ...(hint.source_label?.trim() ? { source_label: hint.source_label.trim() } : {}),
    ...(typeof hint.confidence === "number" ? { confidence: Math.max(0, Math.min(1, hint.confidence)) } : {})
  }));
}
function safeExternalAssistError(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "Unknown error";
  return message
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\bkey\s*=\s*["']?[^"',\s}]+/gi, "key=[redacted]")
    .replace(/\b(api[_-]?key|authorization|token|secret|password|credential|cookie)\s*[:=]\s*["']?[^"',\s}]+/gi, "$1=[redacted]")
    .replace(/\b(?=[A-Za-z0-9.-]*(?:secret|token|password|credential))(?=[A-Za-z0-9.-]*[-.])[A-Za-z0-9.-]{12,}\b/gi, "[redacted]");
}
function externalAssistNote(role: "assistive" | "disabled", providers: string[], records: ExternalAssistRecord[], hintCount: number, failureCount: number): string {
  if (role === "disabled") return "External provider assist is disabled for this workspace.";
  if (providers.length === 0) return "External provider assist is enabled, but no external assist provider is registered.";
  if (records.some((record) => record.status === "failed")) return "External provider assist failed non-fatally; accepted Memory and Session Search were still assembled.";
  if (hintCount > 0) return "External provider assist returned unverified hints. They are isolated from accepted Memory unless separately reviewed.";
  if (failureCount > 0) return "External provider assist has recent non-fatal failures. Accepted Memory and Session Search remain usable.";
  return "External provider assist is enabled but returned no hint for this query.";
}
