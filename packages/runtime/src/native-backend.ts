import type { AgentBackend, BackendOutputEvent, BackendRunInput } from "@samurai-agent/agent-backends";
import type { JsonValue } from "@samurai-agent/core-schemas";
import { ProviderRequestError, type ProviderAdapter, type ProviderToolCall } from "./provider";

export class SamuraiNativeBackend implements AgentBackend {
  readonly id = "samurai-native";
  readonly kind = "samurai_native" as const;
  readonly label = "Samurai Native";

  constructor(private readonly provider?: ProviderAdapter) {}

  async *runTurn(input: BackendRunInput): AsyncIterable<BackendOutputEvent> {
    yield {
      event_type: "run_started",
      payload: { input_summary: summarize(input.user_input) }
    };

    if (!this.provider) {
      yield {
        event_type: "run_failed",
        payload: {
          error_code: "provider_not_configured",
          message: "No LLM provider is configured."
        }
      };
      return;
    }

    try {
      const output = await this.provider.generate({
        envelope: {
          id: input.input_message_id,
          source: "web",
          actor_identity: "owner",
          session_key: "web:owner:main",
          user_intent: input.user_input,
          attachments: [],
          input_locale: input.input_locale,
          output_locale: input.output_locale,
          metadata: input.metadata,
          received_at: new Date().toISOString()
        },
        activeMemory: input.active_memory.map((memory, index) => ({
          frontmatter: {
            id: memory.id ?? `backend_memory_${index}`,
            state: "active",
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
            conflicts_with: [],
            sensitive_level: "none"
          },
          content: memory.content
        })),
        recentMessages: input.recent_messages
      });

      if (output.content.trim()) {
        yield {
          event_type: "text_delta",
          payload: { text: output.content }
        };
      }

      for (const toolCall of output.toolCalls) {
        yield toolCallStartedEvent(toolCall);
      }

      yield {
        event_type: "run_completed",
        payload: {
          output_summary: summarize(output.content) || "Backend run completed.",
          finish_reason: output.finishReason ?? null,
          usage: jsonSafe(output.usage ?? {})
        }
      };
    } catch (error) {
      const providerError = error instanceof ProviderRequestError ? error : undefined;
      yield {
        event_type: "run_failed",
        payload: {
          error_code: providerError?.code ?? "provider_failed",
          message: providerError ? "Provider failed." : error instanceof Error ? error.message : "Provider failed.",
          reason: providerError?.diagnostics.reason ?? "unknown",
          retryable: providerError?.diagnostics.retryable ?? false,
          provider: providerError?.diagnostics.provider ?? this.provider.id,
          model: providerError?.diagnostics.model ?? this.provider.model,
          status: providerError?.diagnostics.status ?? null
        }
      };
    }
  }
}

function toolCallStartedEvent(toolCall: ProviderToolCall): BackendOutputEvent {
  return {
    event_type: "tool_call_started",
    tool_call_id: toolCall.id,
    payload: {
      tool_call_id: toolCall.id ?? "",
      provider_tool_name: toolCall.name,
      arguments: jsonSafe(toolCall.arguments)
    }
  };
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
