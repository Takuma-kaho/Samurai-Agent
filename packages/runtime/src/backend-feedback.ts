import { createArtifactDraft } from "@samurai-agent/artifacts";
import type { BackendOutputEvent, BackendRunInput } from "@samurai-agent/agent-backends";
import {
  type ArtifactRecord,
  type BackendRunRecord,
  type JsonValue,
  type MemoryFrontmatter,
  type OperationRecord,
  type ResourceRef,
  type WorkspaceChangeRecord,
  createId,
  nowIso
} from "@samurai-agent/core-schemas";
import { createTopicMemory } from "@samurai-agent/memory";
import type { WorkspaceStore } from "@samurai-agent/workspace-store";
import { createArtifactCompatOperation } from "./legacy-operation-compat";

export interface FeedbackResult {
  events: BackendOutputEvent[];
  workspaceChanges: WorkspaceChangeRecord[];
  artifacts: ArtifactRecord[];
  memories: MemoryFrontmatter[];
  operations: OperationRecord[];
}

export async function handleBackendToolCall(input: {
  store: WorkspaceStore;
  run: BackendRunRecord;
  runInput: BackendRunInput;
  event: BackendOutputEvent;
}): Promise<FeedbackResult> {
  const providerToolName = stringValue(input.event.payload.provider_tool_name);
  const toolCallId = stringValue(input.event.payload.tool_call_id) || input.event.tool_call_id;
  const args = objectValue(input.event.payload.arguments);

  if (providerToolName === "create_artifact") {
    return createArtifactFromTool({ ...input, toolCallId, args });
  }

  if (providerToolName === "remember_topic") {
    const settings = await input.store.getSettings();
    if (settings.memory_capture_mode !== "suggest") {
      return ignoredToolOutput(input.run, toolCallId, "remember_topic", `memory_capture_${settings.memory_capture_mode}`);
    }
    return createMemoryFromTool({ ...input, toolCallId, args });
  }

  if (providerToolName === "request_external_send" || providerToolName === "request_delete") {
    return ignoredToolOutput(input.run, toolCallId, providerToolName, "backend_native_boundary");
  }

  return ignoredToolOutput(input.run, toolCallId, providerToolName || "unknown_tool", "unsupported_tool");
}

async function createArtifactFromTool(input: {
  store: WorkspaceStore;
  run: BackendRunRecord;
  runInput: BackendRunInput;
  toolCallId?: string;
  args: Record<string, JsonValue>;
}): Promise<FeedbackResult> {
  const title = stringValue(input.args.title).trim();
  const content = stringValue(input.args.content).trim();
  if (!title || !content) {
    return ignoredToolOutput(input.run, input.toolCallId, "create_artifact", "artifact_title_or_content_missing");
  }

  const operation = createArtifactCompatOperation({ run: input.run, toolCallId: input.toolCallId, title });
  await input.store.saveOperation(operation);
  const artifact = await createArtifactDraft({
    store: input.store,
    operation,
    title,
    content,
    locale: input.runInput.output_locale,
    sourceLocales: [input.runInput.input_locale],
    createdBy: "backend"
  });
  operation.result_ref = artifact.file_ref;
  operation.updated_at = nowIso();
  await input.store.updateOperation(operation);

  const change = workspaceChange({
    run: input.run,
    resourceRef: artifact.file_ref,
    changeType: "artifact_created",
    summary: `Created artifact ${artifact.title}.`,
    legacyOperationId: operation.id
  });

  return {
    events: [
      {
        event_type: "artifact_created",
        payload: { artifact_id: artifact.id, title: artifact.title },
        resource_refs: [artifact.file_ref],
        tool_call_id: input.toolCallId
      },
      {
        event_type: "tool_call_output",
        payload: { status: "completed", action_id: "artifact.create", resource_id: artifact.id },
        resource_refs: [artifact.file_ref],
        tool_call_id: input.toolCallId
      }
    ],
    workspaceChanges: [change],
    artifacts: [artifact],
    memories: [],
    operations: [operation]
  };
}

async function createMemoryFromTool(input: {
  store: WorkspaceStore;
  run: BackendRunRecord;
  runInput: BackendRunInput;
  toolCallId?: string;
  args: Record<string, JsonValue>;
}): Promise<FeedbackResult> {
  const topic = stringValue(input.args.topic).trim() || "preference";
  const content = stringValue(input.args.content).trim() || input.runInput.user_input;
  const memory = await createTopicMemory(
    input.store,
    {
      id: input.runInput.input_message_id,
      source: "web",
      actor_identity: "owner",
      session_key: "web:owner:main",
      user_intent: input.runInput.user_input,
      attachments: [],
      input_locale: input.runInput.input_locale,
      output_locale: input.runInput.output_locale,
      metadata: input.runInput.metadata,
      received_at: nowIso()
    },
    topic,
    content
  );
  const ref: ResourceRef = {
    kind: "memory",
    id: memory.id,
    uri: `memory/${memory.state}/${memory.id}.md`,
    label: memory.topic
  };
  const change = workspaceChange({
    run: input.run,
    resourceRef: ref,
    changeType: "memory_suggested",
    summary: `Suggested memory ${memory.topic}.`
  });

  return {
    events: [
      {
        event_type: "memory_suggested",
        payload: { memory_id: memory.id, topic: memory.topic },
        resource_refs: [ref],
        tool_call_id: input.toolCallId
      },
      {
        event_type: "tool_call_output",
        payload: { status: "completed", action_id: "memory.suggest", resource_id: memory.id },
        resource_refs: [ref],
        tool_call_id: input.toolCallId
      }
    ],
    workspaceChanges: [change],
    artifacts: [],
    memories: [memory],
    operations: []
  };
}

function ignoredToolOutput(run: BackendRunRecord, toolCallId: string | undefined, toolName: string, reason: string): FeedbackResult {
  return {
    events: [
      {
        event_type: "tool_call_output",
        payload: { status: "ignored", provider_tool_name: toolName, reason },
        tool_call_id: toolCallId
      }
    ],
    workspaceChanges: [],
    artifacts: [],
    memories: [],
    operations: []
  };
}

function workspaceChange(input: {
  run: BackendRunRecord;
  resourceRef: ResourceRef;
  changeType: WorkspaceChangeRecord["change_type"];
  summary: string;
  legacyOperationId?: string;
}): WorkspaceChangeRecord {
  return {
    id: createId("change"),
    run_id: input.run.id,
    session_id: input.run.session_id,
    resource_ref: input.resourceRef,
    change_type: input.changeType,
    summary: input.summary,
    legacy_operation_id: input.legacyOperationId,
    created_at: nowIso()
  };
}

function stringValue(value: JsonValue | undefined): string {
  return typeof value === "string" ? value : "";
}

function objectValue(value: JsonValue | undefined): Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
}
