import type { ActivityContextRef, UsageScopeRef } from "@samurai-agent/core-schemas";

export type UsageScopeQueryContext = ActivityContextRef;

export function normalizedUsageScope(scope: UsageScopeRef | undefined): UsageScopeRef {
  return scope ?? { kind: "workspace" };
}

export function usageScopeIndexColumns(scope: UsageScopeRef | undefined): { usage_scope_kind: string; usage_scope_ref_id: string | null } {
  const normalized = normalizedUsageScope(scope);
  switch (normalized.kind) {
    case "workspace": return { usage_scope_kind: normalized.kind, usage_scope_ref_id: null };
    case "room": return { usage_scope_kind: normalized.kind, usage_scope_ref_id: normalized.room_id };
    case "agent": return { usage_scope_kind: normalized.kind, usage_scope_ref_id: normalized.agent_id };
    case "session": return { usage_scope_kind: normalized.kind, usage_scope_ref_id: normalized.session_id };
  }
}

export function withUsageScope<T extends { usage_scope?: UsageScopeRef }>(frontmatter: T): T & { usage_scope: UsageScopeRef } {
  return { ...frontmatter, usage_scope: normalizedUsageScope(frontmatter.usage_scope) };
}
