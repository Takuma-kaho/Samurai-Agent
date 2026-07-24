import type { BackendOutputEvent } from "@samurai-agent/agent-backends";
import {
  type BackendEventRecord,
  type JsonValue,
  type ResourceRef,
  ResourceRefSchema,
  createId,
  nowIso
} from "@samurai-agent/core-schemas";

export interface BackendEventProjection {
  record: BackendEventRecord;
  visible: boolean;
  uiRecord: BackendEventRecord | undefined;
  terminal: "completed" | "failed" | "waiting_for_backend_input" | undefined;
}

export class BackendEventBridge {
  private nextSequence: number;

  constructor(private readonly input: {
    runId: string;
    sessionId: string;
    attemptNo: number;
    startSequence?: number;
    nextSequence?: () => number;
  }) {
    this.nextSequence = input.startSequence ?? 1;
  }

  project(event: BackendOutputEvent): BackendEventProjection {
    const normalized = normalizeBackendOutputEvent(event);
    const record: BackendEventRecord = {
      id: createId("event"),
      run_id: this.input.runId,
      session_id: this.input.sessionId,
      event_type: normalized.event_type,
      sequence: this.input.nextSequence ? this.input.nextSequence() : this.nextSequence,
      attempt_no: this.input.attemptNo,
      ...(normalized.source_event_id ? { source_event_id: normalized.source_event_id } : {}),
      ...(normalized.source_sequence !== undefined ? { source_sequence: normalized.source_sequence } : {}),
      payload: normalized.payload,
      resource_refs: normalized.resource_refs ?? [],
      created_at: nowIso()
    };
    if (!this.input.nextSequence) {
      this.nextSequence += 1;
    }
    const uiPayload = projectUiPayload(record);
    const uiRecord = uiPayload
      ? {
          ...record,
          payload: uiPayload,
          resource_refs: projectUiResourceRefs(record)
        }
      : undefined;
    return {
      record,
      visible: !!uiRecord,
      uiRecord,
      terminal: terminalStatusForEvent(record)
    };
  }
}

export function normalizeBackendOutputEvent(event: BackendOutputEvent): BackendOutputEvent {
  const payload = jsonRecord(event.payload);
  if (event.tool_call_id && payload.tool_call_id === undefined) {
    payload.tool_call_id = event.tool_call_id;
  }
  return {
    ...event,
    payload,
    resource_refs: normalizeResourceRefs(event.resource_refs)
  };
}

function terminalStatusForEvent(record: BackendEventRecord): BackendEventProjection["terminal"] {
  if (record.event_type === "run_completed") {
    return "completed";
  }
  if (record.event_type === "run_failed") {
    return "failed";
  }
  if (record.event_type === "backend_waiting_for_native_input") {
    return "waiting_for_backend_input";
  }
  return undefined;
}

function projectUiPayload(record: BackendEventRecord): Record<string, JsonValue> | undefined {
  if (record.payload.ui_visible === false) {
    return undefined;
  }
  switch (record.event_type) {
    case "agent_reasoning": {
      const text = typeof record.payload.text === "string" ? record.payload.text : "";
      return text ? { text: truncateText(text) } : undefined;
    }
    case "host_progress": {
      const text = typeof record.payload.text === "string" ? record.payload.text : "";
      const displayKind = typeof record.payload.display_kind === "string" ? record.payload.display_kind : "activity";
      const activityKind = typeof record.payload.activity_kind === "string" ? record.payload.activity_kind : undefined;
      return text ? {
        text: truncateText(text),
        display_kind: displayKind,
        ...(activityKind ? { activity_kind: activityKind } : {})
      } : undefined;
    }
    case "text_delta": {
      const text = typeof record.payload.text === "string" ? record.payload.text : "";
      return text ? { text: truncateText(text) } : undefined;
    }
    case "tool_call_started": {
      return compactToolStarted(record.payload);
    }
    case "tool_call_output": {
      return compactToolOutput(record.payload);
    }
    case "backend_native_input_submitted":
      return {
        submitted_at: stringPayload(record.payload.submitted_at) ?? record.created_at,
        has_input: record.payload.input !== undefined
      };
    default:
      return compactPayload(record.payload);
  }
}

function projectUiResourceRefs(record: BackendEventRecord): ResourceRef[] {
  if (
    record.event_type === "agent_reasoning"
    || record.event_type === "host_progress"
    || record.event_type === "text_delta"
    || record.event_type === "tool_call_started"
    || record.event_type === "tool_call_output"
    || record.event_type === "backend_native_input_submitted"
  ) {
    return [];
  }
  return record.resource_refs;
}

function compactToolOutput(payload: Record<string, JsonValue>): Record<string, JsonValue> | undefined {
  const summary =
    stringPayload(payload.summary)
    ?? stringPayload(payload.output_summary)
    ?? stringPayload(payload.text)
    ?? stringPayload(payload.stdout)
    ?? stringPayload(payload.stderr)
    ?? stringPayload(payload.error);
  const projected = pickPayload(payload, [
    "tool_call_id",
    "provider_tool_name",
    "action_id",
    "status",
    "ok",
    "reason",
    "error_code",
    "retryable",
    "server_name",
    "tool_name",
    "exit_code",
    "signal"
  ]);
  if (summary) {
    projected.summary = truncateText(summary);
  }
  const gatewayBoundary = compactGatewayBoundary(recordPayload(payload.gateway_boundary));
  if (gatewayBoundary) {
    projected.gateway_boundary = gatewayBoundary;
  }
  const secretResolution = compactSecretResolution(recordPayload(payload.secret_resolution));
  if (secretResolution) {
    projected.secret_resolution = secretResolution;
  }
  return Object.keys(projected).length ? projected : undefined;
}

function compactToolStarted(payload: Record<string, JsonValue>): Record<string, JsonValue> | undefined {
  const projected = pickPayload(payload, [
    "tool_call_id",
    "provider_tool_name",
    "action_id",
    "execution_boundary",
    "requires_host_execution",
    "server_name",
    "tool_name"
  ]);
  return Object.keys(projected).length ? projected : undefined;
}

function compactGatewayBoundary(payload: Record<string, JsonValue> | undefined): Record<string, JsonValue> | undefined {
  if (!payload) {
    return undefined;
  }
  const projected = pickPayload(payload, [
    "decision",
    "action_id",
    "provider_tool_name",
    "reason",
    "policy_id",
    "source_channel",
    "session_key",
    "sandbox_mode",
    "sandbox_backend",
    "workspace_access",
    "network_access"
  ]);
  const allowedTools = Array.isArray(payload.allowed_tools)
    ? payload.allowed_tools.filter((item): item is string => typeof item === "string").slice(0, 20)
    : [];
  if (allowedTools.length) {
    projected.allowed_tools = allowedTools;
  }
  return Object.keys(projected).length ? projected : undefined;
}

function compactSecretResolution(payload: Record<string, JsonValue> | undefined): Record<string, JsonValue> | undefined {
  if (!payload) {
    return undefined;
  }
  const projected = pickPayload(payload, [
    "secret_ref_ids",
    "resolved_secret_ref_ids",
    "unresolved_secret_ref_ids",
    "unresolved_reasons"
  ]);
  return Object.keys(projected).length ? projected : undefined;
}

function compactPayload(payload: Record<string, JsonValue>): Record<string, JsonValue> {
  return redactAndTruncate(payload) as Record<string, JsonValue>;
}

function pickPayload(payload: Record<string, JsonValue>, keys: string[]): Record<string, JsonValue> {
  const projected: Record<string, JsonValue> = {};
  for (const key of keys) {
    if (payload[key] !== undefined) {
      projected[key] = redactAndTruncate(payload[key]);
    }
  }
  return projected;
}

function redactAndTruncate(value: JsonValue, key = ""): JsonValue {
  if (isSensitivePayloadKey(key)) {
    return "[redacted]";
  }
  if (typeof value === "string") {
    return truncateText(value);
  }
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((entry) => redactAndTruncate(entry));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 40)
        .map(([entryKey, entryValue]) => [entryKey, redactAndTruncate(entryValue, entryKey)])
    );
  }
  return value;
}

function truncateText(value: string): string {
  return value.length > 4000 ? `${value.slice(0, 4000)}...[truncated]` : value;
}

function isSensitivePayloadKey(key: string): boolean {
  return /secret|token|api[_-]?key|password|authorization|credential/i.test(key);
}

function stringPayload(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function recordPayload(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, JsonValue> : undefined;
}

function normalizeResourceRefs(value: ResourceRef[] | undefined): ResourceRef[] {
  if (!value?.length) {
    return [];
  }
  return value.flatMap((ref) => {
    const parsed = ResourceRefSchema.safeParse(ref);
    return parsed.success ? [parsed.data] : [];
  });
}

function jsonRecord(value: Record<string, unknown>): Record<string, JsonValue> {
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, jsonSafe(entry)]));
}

function jsonSafe(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(jsonSafe);
  }
  if (typeof value === "object" && value) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, jsonSafe(entry)]));
  }
  return null;
}
