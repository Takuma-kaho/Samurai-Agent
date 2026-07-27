import type { AgentBackendKind, BackendEventType, JsonValue } from "@samurai-agent/core-schemas";
import type { BackendOutputEvent } from "./contract.js";
import type { BackendToolBridge } from "./contract.js";

export type ProviderDiagnosticReason =
  | "unknown_event"
  | "invalid_json"
  | "required_field_missing"
  | "tool_id_missing"
  | "session_conflict"
  | "terminal_missing";

export interface ProviderRuntimeFailure {
  code: string;
  message: string;
  retryable: boolean;
  causeCategory: "configuration" | "provider" | "transport" | "cancellation" | "process" | "runtime" | "unknown";
}

export interface ProviderDecoderHelpers {
  protocolDiagnosticEvent: (
    backendKind: AgentBackendKind,
    reason: ProviderDiagnosticReason,
    summary: string,
    rawType?: string
  ) => BackendOutputEvent;
  stringValue: (value: unknown) => string;
  recordValue: (value: unknown) => Record<string, unknown> | undefined;
  jsonSafe: (value: unknown) => JsonValue;
  delegatedCapabilityMetadata: (toolName: string, input: unknown) => Record<string, JsonValue>;
  mcpToolMetadata: (toolName: string) => Record<string, JsonValue>;
  collectHttpUrls: (value: Record<string, unknown>) => string[];
  providerError: (value: Record<string, unknown>, fallbackCode: string, fallbackMessage: string) => ProviderRuntimeFailure;
  safeFailureMessage: (value: unknown, fallback?: string) => string;
}

export type ProviderParseResult = { known: boolean; events: BackendOutputEvent[] };

export function protocolDiagnosticEvent(
  backendKind: AgentBackendKind,
  reason: ProviderDiagnosticReason,
  summary: string,
  rawType?: string
): BackendOutputEvent {
  return {
    event_type: "backend_protocol_diagnostic",
    payload: {
      provider: backendKind,
      reason,
      summary: safeFailureMessage(summary, "Backend protocol diagnostic."),
      ...(rawType ? { raw_type: safeFailureMessage(rawType, "unknown") } : {})
    }
  };
}

export function providerError(value: Record<string, unknown>, fallbackCode: string, fallbackMessage: string): ProviderRuntimeFailure {
  const payload = recordValue(value.payload) ?? {};
  const nestedError = recordValue(value.error) ?? recordValue(payload.error) ?? {};
  return {
    code: safeFailureCode(stringValue(value.error_code) || stringValue(payload.error_code) || stringValue(nestedError.code) || stringValue(value.code), fallbackCode),
    message: safeFailureMessage(stringValue(value.message) || stringValue(payload.message) || stringValue(nestedError.message) || stringValue(value.result), fallbackMessage),
    retryable: value.retryable === true || payload.retryable === true || nestedError.retryable === true,
    causeCategory: "provider"
  };
}

function safeFailureCode(value: string, fallback: string): string {
  return /^[a-z][a-z0-9_.-]{0,79}$/i.test(value) ? value : fallback;
}

export function safeFailureMessage(value: unknown, fallback = "Backend operation failed."): string {
  const raw = typeof value === "string" && value.trim() ? value : fallback;
  const safe = raw
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/(?:api[_-]?key|access[_-]?token|secret|password)["']?\s*[:=]\s*["']?[^"',\s}]+/gi, "credential=[redacted]")
    .replace(/\b(?:sk|key)-[A-Za-z0-9_-]{8,}\b/g, "[redacted]")
    .replace(/(?<![A-Za-z0-9:/.])\/[^\s"'<>]+/g, "[path]")
    .replace(/[A-Za-z]:\\[^\s"'<>]+/g, "[path]")
    .replace(/\s+/g, " ")
    .trim();
  return (safe || fallback).slice(0, 240);
}

export function mcpToolMetadata(toolName: string): Record<string, JsonValue> {
  const match = /^mcp__(.+?)__(.+)$/.exec(toolName);
  const serverName = match?.[1];
  const mcpToolName = match?.[2];
  if (!serverName || !mcpToolName) return {};
  return { action_id: "mcp.call", server_name: serverName, tool_name: mcpToolName };
}

export function delegatedCapabilityMetadata(toolName: string, value: unknown): Record<string, JsonValue> {
  const normalized = toolName.toLowerCase();
  if (normalized === "websearch" || normalized === "web_search" || normalized.includes("web_search")) {
    return { capability_id: "web_search", source_urls: collectHttpUrls(value) };
  }
  if (normalized === "webfetch" || normalized === "web_fetch" || normalized.includes("web_fetch")) {
    return { capability_id: "web_fetch", source_urls: collectHttpUrls(value) };
  }
  if (normalized === "agent" || normalized === "task" || normalized.includes("subagent")) {
    const record = isRecord(value) ? value : {};
    return {
      capability_id: "subagent_delegate",
      child_task_summary: stringValue(record.description) || stringValue(record.prompt) || stringValue(record.task) || "Delegated backend task",
      parent_relation: "backend_internal"
    };
  }
  return {};
}

export function collectHttpUrls(value: unknown, depth = 0): string[] {
  if (depth > 5) return [];
  if (typeof value === "string") return /^https?:\/\//i.test(value) ? [value] : [];
  if (Array.isArray(value)) return [...new Set(value.flatMap((item) => collectHttpUrls(item, depth + 1)))];
  if (!isRecord(value)) return [];
  return [...new Set(Object.values(value).flatMap((item) => collectHttpUrls(item, depth + 1)))];
}

export function jsonSafe(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (typeof value === "object" && value) return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, jsonSafe(entry)]));
  return null;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function recordValue(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

export function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function backendEventTypeSet(value: string): value is BackendEventType {
  return new Set<BackendEventType>([
    "run_started", "agent_reasoning", "host_progress", "text_delta", "tool_call_started", "tool_call_output",
    "artifact_created", "workspace_change_suggested", "memory_suggested", "skill_candidate_created",
    "backend_waiting_for_native_input", "backend_native_input_submitted", "backend_stream_synced", "backend_stream_unavailable",
    "host_post_turn_failed", "host_cleanup_failed", "host_emit_failed", "backend_protocol_diagnostic", "run_completed", "run_failed"
  ]).has(value as BackendEventType);
}

export interface ExternalCliProvider {
  createDecoder?: (helpers: ProviderDecoderHelpers) => (value: Record<string, unknown>) => ProviderParseResult;
  prepareArgs?: (input: {
    args: string[];
    workingDirectory?: string;
    toolBridge?: BackendToolBridge;
    artifactMcpScript?: string;
  }) => string[];
  sessionId?: (value: Record<string, unknown>) => string | undefined;
  outputLastMessage?: (filePath: string) => Promise<string | undefined>;
  processFailure?: (stderr: string) => { code: string; message: string } | undefined;
}
