import type { AgentBackendKind, BackendEventType } from "@samurai-agent/core-schemas";
import { ResourceRefSchema } from "@samurai-agent/core-schemas";
import {
  BackendOutputEventSchema,
  type BackendOutputEvent
} from "./contract.js";
import type { ExternalCliProvider, ProviderDecoderHelpers } from "./provider-decoder-helpers.js";
import {
  backendEventTypeSet,
  collectHttpUrls,
  delegatedCapabilityMetadata,
  isRecord,
  jsonSafe,
  mcpToolMetadata,
  protocolDiagnosticEvent,
  providerError,
  recordValue,
  safeFailureMessage,
  stringValue
} from "./provider-decoder-helpers.js";

export function parseCliOutputLine(line: string, backendKind: AgentBackendKind = "external"): BackendOutputEvent | undefined {
  return parseCliOutputEvents(line, backendKind)[0];
}

export function parseCliOutputEvents(line: string, backendKind: AgentBackendKind = "external"): BackendOutputEvent[] {
  return createCliOutputDecoder(backendKind)(line, "stdout");
}

export function createCliOutputDecoder(
  backendKind: AgentBackendKind,
  providerDecoderFactory?: ExternalCliProvider["createDecoder"],
  providerSessionId?: ExternalCliProvider["sessionId"]
): (line: string, stream: "stdout" | "stderr") => BackendOutputEvent[] {
  const helpers: ProviderDecoderHelpers = {
    protocolDiagnosticEvent,
    stringValue,
    recordValue,
    jsonSafe,
    delegatedCapabilityMetadata,
    mcpToolMetadata,
    collectHttpUrls,
    providerError,
    safeFailureMessage
  };
  const providerDecoder = providerDecoderFactory?.(helpers);

  return (line, stream) => {
    const trimmed = line.trim();
    if (!trimmed || stream === "stderr") return [];
    const parsed = tryParseJsonRecord(trimmed);
    if (!parsed) return [protocolDiagnosticEvent(backendKind, "invalid_json", "Backend stdout contained a non-JSON line.")];
    const result = providerDecoder
      ? providerDecoder(parsed)
      : (() => {
          const event = cliJsonToBackendEvent(parsed);
          return event ? { known: true, events: [event] } : { known: false, events: [] };
        })();
    if (result.known && result.events.length === 0) return [];
    if (result.events.length > 0) return attachProviderSourceIdentity(parsed, result.events, backendKind, providerSessionId);
    const rawType = providerEventType(parsed);
    return [protocolDiagnosticEvent(
      backendKind,
      rawType ? "unknown_event" : "required_field_missing",
      rawType ? "Backend emitted an event type that is not part of the supported protocol." : "Backend event type is missing.",
      rawType
    )];
  };
}

function providerEventType(value: Record<string, unknown>): string | undefined {
  const type = stringValue(value.type);
  return type || undefined;
}

function tryParseJsonRecord(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function cliJsonToBackendEvent(value: Record<string, unknown>): BackendOutputEvent | undefined {
  const eventType = stringValue(value.event_type);
  if (!eventType || !isBackendEventType(eventType)) return undefined;
  const rawPayload = recordValue(value.payload) ?? {};
  const payload = rawPayload;
  const toolCallId = stringValue(value.tool_call_id) || stringValue(rawPayload.tool_call_id);
  if ((eventType === "tool_call_started" || eventType === "tool_call_output") && !toolCallId) {
    return protocolDiagnosticEvent("external", "tool_id_missing", "Canonical tool event did not include tool_call_id.", eventType);
  }
  if ((eventType === "text_delta" || eventType === "agent_reasoning" || eventType === "host_progress") && !stringValue(payload.text)) {
    return protocolDiagnosticEvent("external", "required_field_missing", "Canonical text event did not include text.", eventType);
  }
  const terminalEvidence = eventType === "run_completed"
    ? { kind: "completed", source: "provider_terminal_response" } as const
    : eventType === "run_failed"
      ? { kind: "failed", source: "provider_terminal_response", error: providerError(value, "backend_result_error", "Backend result reported an error.") } as const
      : undefined;
  const resourceRefs = Array.isArray(value.resource_refs)
    ? ResourceRefSchema.array().safeParse(value.resource_refs)
    : undefined;
  const candidate = {
    event_type: eventType,
    ...(stringValue(value.backend_session_id) ? { backend_session_id: stringValue(value.backend_session_id) } : {}),
    ...providerSourceIdentity(value),
    payload: {
      ...rawPayload,
      ...(toolCallId ? { tool_call_id: toolCallId } : {})
    },
    ...(terminalEvidence ? { terminal_evidence: terminalEvidence } : {}),
    ...(toolCallId ? { tool_call_id: toolCallId } : {}),
    ...(resourceRefs?.success ? { resource_refs: resourceRefs.data } : {})
  };
  const parsed = BackendOutputEventSchema.safeParse(candidate);
  if (parsed.success) return parsed.data as BackendOutputEvent;
  return protocolDiagnosticEvent("external", "required_field_missing", "Canonical event did not satisfy the strict event contract.", eventType);
}

function isBackendEventType(value: string): value is BackendEventType {
  return backendEventTypeSet(value);
}

function attachProviderSourceIdentity(
  value: Record<string, unknown>,
  events: BackendOutputEvent[],
  backendKind: AgentBackendKind,
  providerSessionId?: ExternalCliProvider["sessionId"]
): BackendOutputEvent[] {
  const identity = providerSourceIdentity(value);
  const sessionId = providerSessionId?.(value) ?? (stringValue(value.backend_session_id) || undefined);
  return events.map((event, index) => ({
    ...identity,
    ...(sessionId && !event.backend_session_id ? { backend_session_id: sessionId } : {}),
    ...(events.length > 1 && identity.source_event_id ? { source_event_id: `${identity.source_event_id}:part:${index + 1}` } : {}),
    ...event
  }));
}

function providerSourceIdentity(value: Record<string, unknown>): Pick<BackendOutputEvent, "source_event_id" | "source_sequence"> {
  const sourceEventId = stringValue(value.source_event_id) || undefined;
  const sourceSequence = positiveSourceSequence(value.source_sequence);
  return {
    ...(sourceEventId ? { source_event_id: sourceEventId } : {}),
    ...(sourceSequence !== undefined ? { source_sequence: sourceSequence } : {})
  };
}

function positiveSourceSequence(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
