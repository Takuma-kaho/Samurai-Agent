import type { AgentBackend, BackendOutputEvent, BackendRunInput } from "@samurai-agent/agent-backends";
import type { BackendSessionPolicy, JsonValue } from "@samurai-agent/core-schemas";
import { ProviderRequestError, type ProviderAdapter, type ProviderInput, type ProviderOutput, type ProviderToolCall } from "./provider";

export interface NativeToolExecutionPlan {
  tool_call_id: string;
  provider_tool_name: string;
  action_id: string;
  execution_boundary: "host_runtime";
  requires_host_execution: true;
  arguments: Record<string, JsonValue>;
}

export interface SamuraiNativeBackendComponents {
  provider?: ProviderAdapter;
  contextBuilder?: NativeContextBuilder;
  promptBuilder?: NativePromptBuilder;
  toolLoop?: NativeToolLoop;
  toolExecutor?: NativeToolExecutor;
}

export class SamuraiNativeBackend implements AgentBackend {
  readonly id = "samurai-native";
  readonly kind = "samurai_native" as const;
  readonly label = "Samurai Native";
  readonly sessionPolicy: BackendSessionPolicy = { acquisition: "none", resume: "unsupported" };
  readonly execution_owner = "host" as const;

  private readonly provider?: ProviderAdapter;
  private readonly contextBuilder: NativeContextBuilder;
  private readonly promptBuilder: NativePromptBuilder;
  private readonly toolLoop: NativeToolLoop;

  constructor(providerOrComponents?: ProviderAdapter | SamuraiNativeBackendComponents) {
    const components = nativeBackendComponents(providerOrComponents);
    this.provider = components.provider;
    this.contextBuilder = components.contextBuilder ?? new NativeContextBuilder();
    this.promptBuilder = components.promptBuilder ?? new NativePromptBuilder();
    const toolExecutor = components.toolExecutor ?? new NativeToolExecutor();
    this.toolLoop = components.toolLoop ?? new NativeToolLoop(this.promptBuilder, toolExecutor);
  }

  async *runTurn(input: BackendRunInput): AsyncIterable<BackendOutputEvent> {
    if (input.abort_signal?.aborted) {
      yield this.promptBuilder.cancelledBeforeStartEvent();
      return;
    }
    yield this.promptBuilder.runStartedEvent(input);

    if (!this.provider) {
      yield this.promptBuilder.providerMissingEvent();
      return;
    }
    if (input.abort_signal?.aborted) {
      yield this.promptBuilder.cancelledBeforeStartEvent();
      return;
    }

    try {
      const output = await this.provider.generate(this.contextBuilder.build(input));
      for (const event of this.toolLoop.eventsForOutput(output)) {
        yield event;
      }
    } catch (error) {
      yield this.promptBuilder.providerFailureEvent(error, this.provider, input.abort_signal?.aborted === true);
    }
  }
}

export class NativeContextBuilder {
  build(input: BackendRunInput): ProviderInput {
    return {
      abortSignal: input.abort_signal,
      envelope: input.envelope,
      agentContext: input.agent_context,
      freezeSnapshot: input.freeze_snapshot,
      gatewayBoundary: input.gateway_boundary,
      activeMemory: input.active_memory.map((memory, index) => ({
        frontmatter: {
          id: memory.id ?? `backend_memory_${index}`,
          state: memory.state ?? "active",
          topic: memory.topic ?? "memory",
          source: memory.id ?? "backend_run",
          source_locale: input.input_locale,
          content_locale: input.output_locale,
          source_kind: "workspace_data",
          instruction_authority: "workspace",
          confidence: 1,
          created_by: "runtime",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          related_memories: [],
          conflicts_with: memory.conflicts_with ?? [],
          sensitive_level: memory.sensitive_level ?? "none"
        },
        content: memory.content,
        priority: memory.priority ?? "primary",
        selection_reason: memory.selection_reason ?? `state:${memory.state ?? "active"}`
      })),
      knowledgeWiki: input.knowledge_wiki ?? [],
      collectionNotes: input.collection_notes ?? [],
      selectedSkills: input.selected_skills ?? [],
      sessionSearch: input.session_search ?? [],
      sessionSummary: input.session_summary,
      externalAssist: input.external_assist,
      contextAssembly: input.context_assembly,
      availableTools: input.available_tools ?? [],
      recentMessages: input.recent_messages,
      temporaryContext: input.temporary_context ?? []
    };
  }
}

export class NativePromptBuilder {
  runStartedEvent(input: BackendRunInput): BackendOutputEvent {
    return {
      event_type: "run_started",
      payload: {
        input_summary: summarize(input.user_input),
        input_locale: input.input_locale,
        output_locale: input.output_locale,
        locale_contract: {
          user_facing_text: "output_locale",
          source_text: "input_locale",
          enforcement: "provider_prompt",
          prompt_builder: "NativePromptBuilder"
        }
      }
    };
  }

  providerMissingEvent(): BackendOutputEvent {
    return {
      event_type: "run_failed",
      terminal_evidence: { kind: "not_started", source: "preflight_rejection" },
      payload: {
        error_code: "provider_not_configured",
        message: "No LLM provider is configured."
      }
    };
  }

  cancelledBeforeStartEvent(): BackendOutputEvent {
    return {
      event_type: "run_failed",
      terminal_evidence: { kind: "cancelled", source: "owned_loop_return" },
      payload: {
        error_code: "provider_cancelled_before_start",
        message: "Provider request was cancelled before starting.",
        reason: "already_aborted",
        retryable: false,
        cause_category: "cancellation"
      }
    };
  }

  runCompletedEvent(output: ProviderOutput): BackendOutputEvent {
    return {
      event_type: "run_completed",
      terminal_evidence: { kind: "completed", source: "owned_loop_return" },
      payload: {
        output_summary: summarize(output.content) || "Backend run completed.",
        finish_reason: output.finishReason ?? null,
        usage: jsonSafe(output.usage ?? {})
      }
    };
  }

  providerFailureEvent(error: unknown, provider: ProviderAdapter, signalAborted = false): BackendOutputEvent {
    const providerError = error instanceof ProviderRequestError ? error : undefined;
    const disposition = providerError?.disposition
      ?? (error instanceof Error && error.name === "AbortError" ? "cancel_unconfirmed" : "transport_lost");
    const cancelledBeforeStart = signalAborted && disposition === "not_started";
    const code = cancelledBeforeStart ? "provider_cancelled_before_start" : providerError?.code ?? "provider_failed";
    const message = cancelledBeforeStart
      ? "Provider request was cancelled before starting."
      : safeProviderFailureMessage(providerError?.message ?? (error instanceof Error ? error.message : "Provider failed."));
    const retryable = providerError?.diagnostics.retryable ?? false;
    const terminalEvidence: BackendOutputEvent["terminal_evidence"] = disposition === "not_started"
      ? cancelledBeforeStart
        ? { kind: "cancelled", source: "owned_loop_return" }
        : { kind: "not_started", source: "preflight_rejection" }
      : disposition === "provider_terminal_response"
        ? { kind: "failed", source: "provider_terminal_response", error: { code, message, retryable, causeCategory: "provider" } }
        : {
            kind: "indeterminate",
            reason: disposition,
            providerStarted: true,
            mayHaveSideEffects: true
          };
    return {
      event_type: "run_failed",
      terminal_evidence: terminalEvidence,
      payload: {
        error_code: code,
        message,
        reason: providerError?.diagnostics.reason ?? "unknown",
        retryable,
        cause_category: cancelledBeforeStart || disposition === "cancel_unconfirmed" ? "cancellation" : disposition === "transport_lost" ? "transport" : disposition === "not_started" ? "configuration" : "provider",
        provider: providerError?.diagnostics.provider ?? provider.id,
        model: providerError?.diagnostics.model ?? provider.model,
        ...(providerError?.diagnostics.status ? { status: providerError.diagnostics.status } : {})
      }
    };
  }
}

function safeProviderFailureMessage(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/(?:api[_-]?key|access[_-]?token|secret|password)["']?\s*[:=]\s*["']?[^"',\s}]+/gi, "credential=[redacted]")
    .replace(/\b(?:sk|key)-[A-Za-z0-9_-]{8,}\b/g, "[redacted]")
    .replace(/(?<![A-Za-z0-9:/.])\/[^\s"'<>]+/g, "[path]")
    .replace(/[A-Za-z]:\\[^\s"'<>]+/g, "[path]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240) || "Provider failed.";
}

export class NativeToolLoop {
  constructor(
    private readonly promptBuilder = new NativePromptBuilder(),
    private readonly toolExecutor = new NativeToolExecutor()
  ) {}

  eventsForOutput(output: ProviderOutput): BackendOutputEvent[] {
    const events: BackendOutputEvent[] = [];
    if (output.content.trim()) {
      events.push({
        event_type: "text_delta",
        payload: { text: output.content }
      });
    }
    for (const toolCall of output.toolCalls) {
      events.push(this.toolExecutor.toolCallStartedEvent(toolCall));
    }
    events.push(this.promptBuilder.runCompletedEvent(output));
    return events;
  }
}

export class NativeToolExecutor {
  planToolCall(toolCall: ProviderToolCall): NativeToolExecutionPlan {
    if (!toolCall.id?.trim()) throw new Error("tool_call_id_required");
    return {
      tool_call_id: toolCall.id,
      provider_tool_name: toolCall.name,
      action_id: nativeToolActionId(toolCall.name),
      execution_boundary: "host_runtime",
      requires_host_execution: true,
      arguments: jsonRecord(toolCall.arguments)
    };
  }

  toolCallStartedEvent(toolCall: ProviderToolCall): BackendOutputEvent {
    const plan = this.planToolCall(toolCall);
    return {
      event_type: "tool_call_started",
      tool_call_id: plan.tool_call_id,
      payload: {
        tool_call_id: plan.tool_call_id,
        provider_tool_name: plan.provider_tool_name,
        action_id: plan.action_id,
        execution_boundary: plan.execution_boundary,
        requires_host_execution: plan.requires_host_execution,
        arguments: plan.arguments
      }
    };
  }
}

function nativeToolActionId(toolName: string): string {
  if (toolName === "create_artifact") {
    return "artifact.create";
  }
  if (toolName === "create_generated_surface") {
    return "generated_surface.create";
  }
  if (toolName === "remember_topic") {
    return "memory.topic.create";
  }
  if (toolName === "request_external_send") {
    return "external.send.prepare";
  }
  return toolName || "unknown_tool";
}

function nativeBackendComponents(input: ProviderAdapter | SamuraiNativeBackendComponents | undefined): SamuraiNativeBackendComponents {
  if (!input) {
    return {};
  }
  return isProviderAdapter(input) ? { provider: input } : input;
}

function isProviderAdapter(input: ProviderAdapter | SamuraiNativeBackendComponents): input is ProviderAdapter {
  return typeof (input as ProviderAdapter).generate === "function";
}

function summarize(value: string): string {
  return value.trim().replace(/\s+/g, " ").slice(0, 160);
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

function jsonRecord(value: Record<string, unknown>): Record<string, JsonValue> {
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, jsonSafe(entry)]));
}
