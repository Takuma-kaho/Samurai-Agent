import type { BackendOutputEvent } from "./contract.js";
import type { ProviderDecoderHelpers, ProviderParseResult } from "./provider-decoder-helpers.js";
import { readFile } from "node:fs/promises";

type CodexDecoderState = {
  startedItems: Set<string>;
  completedItems: Set<string>;
  completedMessages: Set<string>;
};

export function createCodexStreamDecoder(helpers: ProviderDecoderHelpers): (value: Record<string, unknown>) => ProviderParseResult {
  const state: CodexDecoderState = {
    startedItems: new Set(),
    completedItems: new Set(),
    completedMessages: new Set()
  };
  const { protocolDiagnosticEvent, stringValue, recordValue, jsonSafe, collectHttpUrls, providerError } = helpers;

  return (value) => {
    const type = stringValue(value.type);
    if (!type) return { known: false, events: [] };
    if (type === "thread.started") {
      const threadId = stringValue(value.thread_id);
      if (!threadId) return { known: true, events: [protocolDiagnosticEvent("codex", "required_field_missing", "Codex thread.started did not include thread_id.", type)] };
      return { known: true, events: [{ event_type: "run_started", backend_session_id: threadId, payload: { provider_event_type: type, provider_thread_id: threadId } }] };
    }
    if (type === "turn.started") return { known: true, events: [] };
    if (type === "turn.completed") {
      return {
        known: true,
        events: [{ event_type: "run_completed", terminal_evidence: { kind: "completed", source: "provider_terminal_response" }, payload: { provider_event_type: type, ...(stringValue(value.output_summary) ? { output_summary: stringValue(value.output_summary).slice(0, 240) } : {}) } }]
      };
    }
    if (type === "turn.failed") {
      return {
        known: true,
        events: [{ event_type: "run_failed", terminal_evidence: { kind: "failed", source: "provider_terminal_response", error: providerError(value, "backend_result_error", "Codex reported an error.") }, payload: { provider_event_type: type, error_code: stringValue(value.error_code) || "backend_result_error", message: helpers.safeFailureMessage(value.message, "Codex reported an error."), reason: stringValue(value.reason) || "provider_error", retryable: false } }]
      };
    }
    if (type !== "item.started" && type !== "item.updated" && type !== "item.completed") return { known: false, events: [] };
    const item = recordValue(value.item);
    if (!item) return { known: true, events: [protocolDiagnosticEvent("codex", "required_field_missing", `${type} did not include item.`, type)] };
    const itemType = stringValue(item.type);
    if (!itemType) return { known: true, events: [protocolDiagnosticEvent("codex", "required_field_missing", `${type} item did not include type.`, type)] };
    const itemId = stringValue(item.id);
    if (type === "item.updated") {
      if (itemId && state.completedItems.has(itemId)) return { known: true, events: [] };
      const display = stringValue(item.text) || stringValue(item.status) || stringValue(item.progress);
      return display ? { known: true, events: [{ event_type: "host_progress", payload: { provider_event_type: type, item_type: itemType, display_kind: "codex_item_updated", text: display } }] } : { known: true, events: [] };
    }
    const isCompleted = type === "item.completed";
    if ((isCompleted ? state.completedItems : state.startedItems).has(itemId)) return { known: true, events: [] };
    if (isCompleted) state.completedItems.add(itemId);
    else state.startedItems.add(itemId);

    if (itemType === "agent_message") {
      const text = stringValue(item.text);
      if (!isCompleted || !text || (itemId && state.completedMessages.has(itemId))) return { known: true, events: [] };
      if (itemId) state.completedMessages.add(itemId);
      return { known: true, events: [{ event_type: "text_delta", payload: { provider_event_type: type, item_type: itemType, text } }] };
    }
    if (itemType === "reasoning") {
      const text = stringValue(item.summary) || stringValue(item.text);
      return text && isCompleted ? { known: true, events: [{ event_type: "agent_reasoning", payload: { provider_event_type: type, item_type: itemType, text } }] } : { known: true, events: [] };
    }
    const toolItemTypes = new Set(["command_execution", "file_change", "mcp_tool_call", "collab_tool_call", "web_search", "web_search_call"]);
    if (toolItemTypes.has(itemType)) {
      if (!itemId) return { known: true, events: [protocolDiagnosticEvent("codex", "tool_id_missing", `${type} ${itemType} did not include item.id.`, type)] };
      const toolName = itemType;
      if (!isCompleted) {
        return { known: true, events: [{ event_type: "tool_call_started", tool_call_id: itemId, payload: { tool_call_id: itemId, provider_event_type: type, provider_tool_name: toolName, ...(item.input !== undefined ? { input: jsonSafe(item.input) } : {}), ...(item.command !== undefined ? { input: jsonSafe(item.command) } : {}), ...(itemType === "web_search" || itemType === "web_search_call" ? { capability_id: "web_search" } : {}) } }] };
      }
      return { known: true, events: [{ event_type: "tool_call_output", tool_call_id: itemId, payload: { tool_call_id: itemId, provider_event_type: type, provider_tool_name: toolName, status: stringValue(item.status) || "completed", ...(item.output !== undefined ? { output: jsonSafe(item.output) } : {}), ...(item.aggregated_output !== undefined ? { output: jsonSafe(item.aggregated_output) } : {}), ...(item.exit_code !== undefined ? { exit_code: numberValue(item.exit_code) } : {}), ...(itemType === "web_search" || itemType === "web_search_call" ? { capability_id: "web_search", ...(stringValue(item.mode) ? { search_mode: stringValue(item.mode) } : {}), source_urls: collectHttpUrls(item) } : {}) } }] };
    }
    if (itemType === "todo_list") {
      const text = stringValue(item.text) || stringValue(item.status);
      return text ? { known: true, events: [{ event_type: "host_progress", payload: { provider_event_type: type, item_type: itemType, text, display_kind: "codex_todo_list" } }] } : { known: true, events: [] };
    }
    return { known: true, events: [protocolDiagnosticEvent("codex", "unknown_event", `Codex item type ${itemType} is not supported.`, type)] };
  };
}

export async function readCodexOutputLastMessage(filePath: string): Promise<string | undefined> {
  try {
    const text = (await readFile(filePath, "utf8")).trim();
    return text || undefined;
  } catch {
    return undefined;
  }
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
