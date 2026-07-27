import type { BackendOutputEvent } from "./contract.js";
import type { ProviderDecoderHelpers, ProviderParseResult } from "./provider-decoder-helpers.js";

type ClaudeDecoderState = {
  streamText: string;
  assistantTexts: Set<string>;
  resultSeen: boolean;
};

export function createClaudeStreamDecoder(helpers: ProviderDecoderHelpers): (value: Record<string, unknown>) => ProviderParseResult {
  const state: ClaudeDecoderState = {
    streamText: "",
    assistantTexts: new Set(),
    resultSeen: false
  };
  const { protocolDiagnosticEvent, stringValue, recordValue, jsonSafe, delegatedCapabilityMetadata, mcpToolMetadata, providerError } = helpers;

  return (value) => {
    const type = stringValue(value.type);
    if (!type) return { known: false, events: [] };
    const sessionId = claudeSessionId(value, stringValue);
    if (type === "system" && stringValue(value.subtype) === "init") {
      if (!sessionId) {
        return { known: true, events: [protocolDiagnosticEvent("claude_code", "required_field_missing", "Claude system/init did not include session_id.", "system/init")] };
      }
      return {
        known: true,
        events: [{ event_type: "run_started", backend_session_id: sessionId, payload: { provider_event_type: "system", subtype: "init" } }]
      };
    }
    if (type === "stream_event") {
      const providerEvent = recordValue(value.event);
      if (!providerEvent || stringValue(providerEvent.type) !== "content_block_delta") return { known: true, events: [] };
      const delta = recordValue(providerEvent.delta);
      if (stringValue(delta?.type) !== "text_delta") return { known: true, events: [] };
      const text = stringValue(delta?.text);
      if (!text) return { known: true, events: [] };
      state.streamText += text;
      return { known: true, events: [{ event_type: "text_delta", ...(sessionId ? { backend_session_id: sessionId } : {}), payload: { provider_event_type: "stream_event", text } }] };
    }
    if (type === "assistant") {
      const message = recordValue(value.message);
      const content = Array.isArray(message?.content) ? message.content.filter(isRecord) : [];
      const events: BackendOutputEvent[] = [];
      const text = content
        .filter((block) => stringValue(block.type) === "text")
        .map((block) => stringValue(block.text))
        .filter(Boolean)
        .join("\n");
      if (text && !state.assistantTexts.has(text) && !state.streamText.endsWith(text)) {
        state.assistantTexts.add(text);
        events.push({ event_type: "text_delta", ...(sessionId ? { backend_session_id: sessionId } : {}), payload: { provider_event_type: "assistant", text } });
      }
      for (const block of content.filter((item) => stringValue(item.type) === "tool_use")) {
        const toolCallId = stringValue(block.id);
        const toolName = stringValue(block.name);
        if (!toolCallId) {
          events.push(protocolDiagnosticEvent("claude_code", "tool_id_missing", "Claude tool_use did not include id.", "assistant"));
          continue;
        }
        if (!toolName) {
          events.push(protocolDiagnosticEvent("claude_code", "required_field_missing", "Claude tool_use did not include name.", "assistant"));
          continue;
        }
        events.push({
          event_type: "tool_call_started",
          tool_call_id: toolCallId,
          ...(sessionId ? { backend_session_id: sessionId } : {}),
          payload: {
            tool_call_id: toolCallId,
            provider_event_type: "assistant",
            provider_tool_name: toolName,
            input: jsonSafe(block.input),
            ...delegatedCapabilityMetadata(toolName, block.input),
            ...mcpToolMetadata(toolName)
          }
        });
      }
      return { known: true, events };
    }
    if (type === "user") {
      const message = recordValue(value.message);
      const content = Array.isArray(message?.content) ? message.content.filter(isRecord) : [];
      const events: BackendOutputEvent[] = [];
      for (const block of content.filter((item) => stringValue(item.type) === "tool_result")) {
        const toolCallId = stringValue(block.tool_use_id);
        if (!toolCallId) {
          events.push(protocolDiagnosticEvent("claude_code", "tool_id_missing", "Claude tool_result did not include tool_use_id.", "user"));
          continue;
        }
        events.push({
          event_type: "tool_call_output",
          tool_call_id: toolCallId,
          ...(sessionId ? { backend_session_id: sessionId } : {}),
          payload: {
            tool_call_id: toolCallId,
            provider_event_type: "user",
            status: block.is_error === true ? "failed" : "completed",
            output: jsonSafe(block.content)
          }
        });
      }
      return { known: true, events };
    }
    if (type === "result") {
      if (state.resultSeen) return { known: true, events: [] };
      state.resultSeen = true;
      const isError = value.is_error === true || stringValue(value.subtype) === "error";
      const resultPayload = recordValue(value.result);
      const outputSummary = typeof value.result === "string" ? value.result : stringValue(value.output_summary) || stringValue(resultPayload?.output_summary);
      return {
        known: true,
        events: [{
          event_type: isError ? "run_failed" : "run_completed",
          ...(sessionId ? { backend_session_id: sessionId } : {}),
          terminal_evidence: isError
            ? { kind: "failed", source: "provider_terminal_response", error: providerError(value, "backend_result_error", "Backend result reported an error.") }
            : { kind: "completed", source: "provider_terminal_response" },
          payload: {
            provider_event_type: "result",
            ...(outputSummary ? { output_summary: outputSummary.slice(0, 240) } : {}),
            ...(isError ? { error_code: stringValue(value.error_code) || "backend_result_error", reason: stringValue(value.subtype) || "result_error", retryable: false } : {})
          }
        }]
      };
    }
    return { known: false, events: [] };
  };
}

function claudeSessionId(value: Record<string, unknown>, stringValue: ProviderDecoderHelpers["stringValue"]): string | undefined {
  const sessionId = stringValue(value.session_id).trim();
  return sessionId || undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
