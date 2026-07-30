import { getDomainCommandForProviderToolName, requireDomainCommandEntry } from "@samurai-agent/action-catalog";
import type { BackendOutputEvent, BackendRunInput, BackendToolCallStartedEvent } from "@samurai-agent/agent-backends";
import {
  type ArtifactRecord,
  type BackendRunRecord,
  type JsonValue,
  type MemoryFrontmatter,
  type OperationRecord,
  type ResourceRef,
  type ToolRunRecord,
  type WorkspaceChangeRecord,
  createId,
  nowIso,
  type SettingsRecord
} from "@samurai-agent/core-schemas";

const artifactCreateCommand = getDomainCommandForProviderToolName("create_artifact") ?? requireDomainCommandEntry("artifact.create");
const memoryTopicCreateCommand = getDomainCommandForProviderToolName("remember_topic") ?? requireDomainCommandEntry("memory.topic.create");

export interface FeedbackResult {
  events: BackendOutputEvent[];
  workspaceChanges: WorkspaceChangeRecord[];
  artifacts: ArtifactRecord[];
  memories: MemoryFrontmatter[];
  operations: OperationRecord[];
  toolRuns: ToolRunRecord[];
}

export interface BackendToolBoundaryFeedback {
  payload: Record<string, JsonValue>;
  resourceRefs: ResourceRef[];
}

export interface BackendFeedbackStorePort {
  getSettings(): Promise<SettingsRecord>;
  saveToolRun(run: ToolRunRecord): Promise<ToolRunRecord>;
}

export async function handleBackendToolCall(input: {
  store: BackendFeedbackStorePort;
  run: BackendRunRecord;
  runInput: BackendRunInput;
  event: BackendToolCallStartedEvent;
  boundary?: BackendToolBoundaryFeedback;
}): Promise<FeedbackResult> {
  const providerToolName = stringValue(input.event.payload.provider_tool_name);
  const toolCallId = stringValue(input.event.payload.tool_call_id) || input.event.tool_call_id;
  if (!toolCallId) throw new Error("tool_call_id_required");

  if (providerToolName === "create_artifact") {
    return ignoredToolOutput(input.run, toolCallId, providerToolName, "provider_tool_requires_domain_command", input.store, input.boundary, artifactCreateCommand.id);
  }

  if (providerToolName === "remember_topic") {
    const settings = await input.store.getSettings();
    if (settings.memory_capture_mode === "off") {
      return ignoredToolOutput(input.run, toolCallId, providerToolName, `memory_capture_${settings.memory_capture_mode}`, input.store, input.boundary, memoryTopicCreateCommand.id);
    }
    return ignoredToolOutput(input.run, toolCallId, providerToolName, "provider_tool_requires_domain_command", input.store, input.boundary, memoryTopicCreateCommand.id);
  }

  if (providerToolName === "request_external_send") {
    return ignoredToolOutput(input.run, toolCallId, providerToolName, "backend_native_boundary", input.store, input.boundary);
  }

  return ignoredToolOutput(input.run, toolCallId, providerToolName || "unknown_tool", "unsupported_tool", input.store, input.boundary);
}

async function ignoredToolOutput(
  run: BackendRunRecord,
  toolCallId: string,
  toolName: string,
  reason: string,
  store?: BackendFeedbackStorePort,
  boundary?: BackendToolBoundaryFeedback,
  actionId?: string
): Promise<FeedbackResult> {
  const toolRuns = store
    ? [
        await saveToolRun(store, {
          run,
          toolCallId,
          providerToolName: toolName,
          actionId,
          status: "ignored",
          inputSummary: toolName,
          outputSummary: reason,
          resourceRefs: withBoundaryRefs([], boundary)
        })
      ]
    : [];
  return {
    events: [
      {
        event_type: "tool_call_output",
        payload: withBoundaryPayload({ status: "ignored", provider_tool_name: toolName, ...(actionId ? { action_id: actionId } : {}), reason }, boundary),
        tool_call_id: toolCallId,
        resource_refs: withBoundaryRefs([], boundary)
      }
    ],
    workspaceChanges: [],
    artifacts: [],
    memories: [],
    operations: [],
    toolRuns
  };
}

function withBoundaryPayload(payload: Record<string, JsonValue>, boundary: BackendToolBoundaryFeedback | undefined): Record<string, JsonValue> {
  return boundary ? { ...payload, gateway_boundary: boundary.payload } : payload;
}

function withBoundaryRefs(refs: ResourceRef[], boundary: BackendToolBoundaryFeedback | undefined): ResourceRef[] {
  return boundary ? [...refs, ...boundary.resourceRefs] : refs;
}

async function saveToolRun(
  store: BackendFeedbackStorePort,
  input: {
    run: BackendRunRecord;
    toolCallId?: string;
    providerToolName: string;
    actionId?: string;
    status: ToolRunRecord["status"];
    inputSummary: string;
    outputSummary: string;
    resourceRefs: ResourceRef[];
  }
): Promise<ToolRunRecord> {
  return store.saveToolRun({
    id: createId("toolrun"),
    run_id: input.run.id,
    session_id: input.run.session_id,
    tool_call_id: input.toolCallId,
    provider_tool_name: input.providerToolName || "unknown_tool",
    action_id: input.actionId,
    status: input.status,
    input_summary: summarize(input.inputSummary),
    output_summary: summarize(input.outputSummary),
    resource_refs: input.resourceRefs,
    created_at: nowIso()
  });
}

function stringValue(value: JsonValue | undefined): string {
  return typeof value === "string" ? value : "";
}

function summarize(value: string): string {
  return value.trim().replace(/\s+/g, " ").slice(0, 220);
}
