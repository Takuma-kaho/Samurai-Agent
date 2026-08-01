import type { BackendSessionPolicy } from "@samurai-agent/core-schemas";
import type {
  AgentBackend,
  BackendOutputEvent,
  BackendRunInput,
  BackendSessionHandle,
  BackendSessionInput
} from "./contract.js";

export class MockBackend implements AgentBackend {
  readonly id = "mock";
  readonly kind = "mock" as const;
  readonly label = "Mock Backend";
  readonly sessionPolicy: BackendSessionPolicy = { acquisition: "start_session", resume: "unsupported" };
  readonly execution_owner = "backend" as const;

  async startSession(input: BackendSessionInput): Promise<BackendSessionHandle> {
    return {
      backend_session_id: `${this.id}:${input.backend_session_key ?? input.session_id}`,
      metadata: {
        session_key: input.session_key,
        ...(input.room_id ? { room_id: input.room_id } : {}),
        ...(input.agent_id ? { agent_id: input.agent_id } : {}),
        output_locale: input.output_locale
      },
      started_at: new Date().toISOString()
    };
  }

  async *runTurn(input: BackendRunInput): AsyncIterable<BackendOutputEvent> {
    if (input.abort_signal?.aborted) {
      yield cancelledBeforeStartEvent(this.label);
      return;
    }
    yield {
      event_type: "run_started",
      payload: {
        input_summary: summarize(input.user_input),
        ...localeContractPayload(input)
      }
    };
    yield {
      event_type: "text_delta",
      payload: { text: `Mock response: ${input.user_input}` }
    };
    yield {
      event_type: "run_completed",
      terminal_evidence: { kind: "completed", source: "owned_loop_return" },
      payload: { output_summary: "Mock response completed." }
    };
  }
}

function cancelledBeforeStartEvent(label: string): BackendOutputEvent {
  return {
    event_type: "run_failed",
    terminal_evidence: { kind: "cancelled", source: "owned_loop_return" },
    payload: {
      error_code: "backend_cancelled_before_start",
      message: `${label} was cancelled before starting.`,
      reason: "already_aborted",
      retryable: false,
      cause_category: "cancellation"
    }
  };
}

function localeContractPayload(input: BackendRunInput) {
  return {
    input_locale: input.input_locale,
    output_locale: input.output_locale,
    locale_contract: {
      user_facing_text: "output_locale",
      source_text: "input_locale",
      enforcement: "internal_backend_event"
    }
  };
}

function summarize(value: string): string {
  return value.trim().replace(/\s+/g, " ").slice(0, 160);
}
