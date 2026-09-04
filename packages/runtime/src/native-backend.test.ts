import { describe, expect, it } from "vitest";
import type { BackendOutputEvent, BackendRunInput } from "@samurai-agent/agent-backends";
import { FakeProviderAdapter, ProviderRegistry, ProviderRequestError, type ProviderAdapter } from "./provider";
import { NativeContextBuilder, NativeToolExecutor, NativeToolLoop, SamuraiNativeBackend } from "./native-backend";

describe("SamuraiNativeBackend components", () => {
  it("builds provider context from backend run input", () => {
    const context = new NativeContextBuilder().build(backendRunInput());

    expect(context.envelope.user_intent).toBe("write a note");
    expect(context.activeMemory[0]?.frontmatter).toMatchObject({
      id: "memory_1",
      state: "active",
      topic: "style",
      source_kind: "workspace_data"
    });
    expect(context.knowledgeWiki[0]?.slug).toBe("project-notes");
    expect(context.selectedSkills[0]?.disclosure_level).toBe("body");
    expect(context.availableTools).toEqual(["create_artifact"]);
  });

  it("keeps prompt, provider, and tool event responsibilities separate", async () => {
    const backend = new SamuraiNativeBackend({
      provider: new FakeProviderAdapter("fake/native", {
        content: "Created a draft.",
        toolCalls: [{ id: "tool_1", name: "create_artifact", arguments: { title: "Draft" } }],
        finishReason: "stop",
        usage: { output_tokens: 4 }
      }),
      contextBuilder: new NativeContextBuilder(),
      toolLoop: new NativeToolLoop()
    });
    const events: BackendOutputEvent[] = [];

    for await (const event of backend.runTurn(backendRunInput())) {
      events.push(event);
    }

    expect(events.map((event) => event.event_type)).toEqual([
      "run_started",
      "text_delta",
      "tool_call_started",
      "run_completed"
    ]);
    expect(events[0]?.payload).toMatchObject({
      input_locale: "en",
      output_locale: "en",
      locale_contract: {
        user_facing_text: "output_locale",
        enforcement: "provider_prompt",
        prompt_builder: "NativePromptBuilder"
      }
    });
    expect(events[2]?.payload).toMatchObject({
      tool_call_id: "tool_1",
      provider_tool_name: "create_artifact",
      action_id: "artifact.create",
      execution_boundary: "host_runtime",
      requires_host_execution: true,
      arguments: { title: "Draft" }
    });
    expect(events[3]?.payload).toMatchObject({
      output_summary: "Created a draft.",
      finish_reason: "stop",
      usage: { output_tokens: 4 }
    });
  });

  it("forwards real provider stream increments as separate text events", async () => {
    const provider: ProviderAdapter = {
      id: "gemini",
      model: "gemini/stream-test",
      async generate() {
        throw new Error("stream path expected");
      },
      async *stream() {
        yield { content: "先頭" };
        yield { content: " と続き", finishReason: "STOP", usage: { total_tokens: 3 } };
      }
    };

    const events = await collectEvents(new SamuraiNativeBackend(provider).runTurn(backendRunInput()));

    expect(events.map((event) => event.event_type)).toEqual(["run_started", "text_delta", "text_delta", "run_completed"]);
    expect(events.filter((event) => event.event_type === "text_delta").map((event) => event.payload.text)).toEqual(["先頭", " と続き"]);
    expect(events.at(-1)?.payload).toMatchObject({ output_summary: "先頭 と続き", finish_reason: "STOP", usage: { total_tokens: 3 } });
  });

  it("stabilizes Gemini tool IDs and keeps duplicate calls distinct", async () => {
    const provider: ProviderAdapter = {
      id: "gemini",
      model: "gemini/tool-test",
      async generate() {
        throw new Error("stream path expected");
      },
      async *stream() {
        yield { toolCalls: [
          { name: "create_artifact", arguments: { title: "same" } },
          { name: "create_artifact", arguments: { title: "same" } }
        ], finishReason: "STOP" };
      }
    };

    const events = await collectEvents(new SamuraiNativeBackend(provider).runTurn(backendRunInput()));
    const toolEvents = events.filter((event) => event.event_type === "tool_call_started");
    const ids = toolEvents.map((event) => event.tool_call_id);

    expect(toolEvents).toHaveLength(2);
    expect(ids.every((id) => Boolean(id))).toBe(true);
    expect(new Set(ids).size).toBe(2);
    expect(toolEvents.map((event) => event.payload.tool_call_id)).toEqual(ids);
  });

  it("does not render a thoughtSignature-only provider chunk as text", async () => {
    const provider: ProviderAdapter = {
      id: "gemini",
      model: "gemini/thought-signature-test",
      async generate() {
        throw new Error("stream path expected");
      },
      async *stream() {
        yield { ignored: true, finishReason: "STOP" };
      }
    };

    const events = await collectEvents(new SamuraiNativeBackend(provider).runTurn(backendRunInput()));

    expect(events.map((event) => event.event_type)).toEqual(["run_started", "run_completed"]);
    expect(events.some((event) => event.event_type === "text_delta")).toBe(false);
    expect(events.at(-1)?.payload).toMatchObject({ output_summary: "Backend run completed.", finish_reason: "STOP" });
  });

  it("does not treat Gemini safety termination as a completed run", async () => {
    const provider: ProviderAdapter = {
      id: "gemini",
      model: "gemini/safety-test",
      async generate() {
        throw new Error("stream path expected");
      },
      async *stream() {
        yield { finishReason: "SAFETY" };
      }
    };

    const events = await collectEvents(new SamuraiNativeBackend(provider).runTurn(backendRunInput()));

    expect(events.map((event) => event.event_type)).toEqual(["run_started", "run_failed"]);
    expect(events.at(-1)).toMatchObject({
      terminal_evidence: { kind: "failed", source: "provider_terminal_response" },
      payload: { cause_category: "provider", reason: "invalid_response" }
    });
    expect(JSON.stringify(events)).toContain("safety policy");
  });

  it("does not treat a non-stream provider safety result as a completed run", async () => {
    const provider: ProviderAdapter = {
      id: "gemini",
      model: "gemini/non-stream-safety-test",
      async generate() {
        return { content: "blocked content", toolCalls: [], finishReason: "SAFETY" };
      }
    };

    const events = await collectEvents(new SamuraiNativeBackend(provider).runTurn(backendRunInput()));

    expect(events.map((event) => event.event_type)).toEqual(["run_started", "run_failed"]);
    expect(events.at(-1)).toMatchObject({
      terminal_evidence: { kind: "failed", source: "provider_terminal_response" },
      payload: { cause_category: "provider", reason: "invalid_response" }
    });
    expect(JSON.stringify(events)).toContain("safety policy");
  });

  it("does not complete an empty non-stream provider response", async () => {
    const provider: ProviderAdapter = {
      id: "gemini",
      model: "gemini/non-stream-empty-test",
      async generate() {
        return { content: "", toolCalls: [] };
      }
    };

    const events = await collectEvents(new SamuraiNativeBackend(provider).runTurn(backendRunInput()));

    expect(events.map((event) => event.event_type)).toEqual(["run_started", "run_failed"]);
    expect(events.at(-1)).toMatchObject({
      terminal_evidence: { kind: "failed", source: "provider_terminal_response" },
      payload: { reason: "invalid_response" }
    });
  });

  it("does not complete an empty terminated stream unless it carries ignored provider metadata", async () => {
    const provider: ProviderAdapter = {
      id: "gemini",
      model: "gemini/empty-test",
      async generate() {
        throw new Error("stream path expected");
      },
      async *stream() {
        yield { finishReason: "STOP" };
      }
    };

    const events = await collectEvents(new SamuraiNativeBackend(provider).runTurn(backendRunInput()));

    expect(events.map((event) => event.event_type)).toEqual(["run_started", "run_failed"]);
    expect(events.at(-1)).toMatchObject({
      terminal_evidence: { kind: "failed", source: "provider_terminal_response" },
      payload: { reason: "invalid_response" }
    });
  });

  it("marks a provider stream that reaches EOF without a terminator indeterminate", async () => {
    const provider: ProviderAdapter = {
      id: "gemini",
      model: "gemini/eof-test",
      async generate() {
        throw new Error("stream path expected");
      },
      async *stream() {
        yield { content: "partial" };
      }
    };

    const events = await collectEvents(new SamuraiNativeBackend(provider).runTurn(backendRunInput()));

    expect(events.map((event) => event.event_type)).toEqual(["run_started", "text_delta", "run_failed"]);
    expect(events.at(-1)).toMatchObject({
      terminal_evidence: { kind: "indeterminate", reason: "transport_lost", providerStarted: true, mayHaveSideEffects: true }
    });
  });

  it("marks an interrupted provider stream indeterminate after partial output", async () => {
    const provider: ProviderAdapter = {
      id: "gemini",
      model: "gemini/disconnect-test",
      async generate() {
        throw new Error("stream path expected");
      },
      async *stream() {
        yield { content: "partial" };
        throw new Error("socket closed");
      }
    };

    const events = await collectEvents(new SamuraiNativeBackend(provider).runTurn(backendRunInput()));

    expect(events.map((event) => event.event_type)).toEqual(["run_started", "text_delta", "run_failed"]);
    expect(events.at(-1)).toMatchObject({
      terminal_evidence: { kind: "indeterminate", reason: "transport_lost", providerStarted: true, mayHaveSideEffects: true }
    });
  });

  it("plans native provider tool calls as host-runtime executions", () => {
    const plan = new NativeToolExecutor().planToolCall({
      id: "tool_2",
      name: "request_external_send",
      arguments: { channel: "email", title: "Draft" }
    });

    expect(plan).toEqual({
      tool_call_id: "tool_2",
      provider_tool_name: "request_external_send",
      action_id: "external.send.prepare",
      execution_boundary: "host_runtime",
      requires_host_execution: true,
      arguments: {
        channel: "email",
        title: "Draft"
      }
    });
  });

  it("classifies provider termination evidence without guessing from run_failed", async () => {
    const abortError = new Error("Aborted");
    abortError.name = "AbortError";
    const explicitFailure = new SamuraiNativeBackend(providerThrowing(new ProviderRequestError(
      "provider_failed",
      "Provider rejected the request.",
      { reason: "auth_failed", retryable: false },
      "provider_terminal_response"
    )));

    const cases = [
      {
        name: "not configured",
        backend: new SamuraiNativeBackend(),
        evidence: { kind: "not_started", source: "preflight_rejection" }
      },
      {
        name: "explicit provider failure",
        backend: explicitFailure,
        evidence: { kind: "failed", source: "provider_terminal_response", error: { code: "provider_failed", message: "Provider rejected the request.", retryable: false, causeCategory: "provider" } }
      },
      {
        name: "abort without provider settlement",
        backend: new SamuraiNativeBackend(providerThrowing(abortError)),
        evidence: { kind: "indeterminate", reason: "cancel_unconfirmed", providerStarted: true, mayHaveSideEffects: true }
      }
    ] as const;

    for (const entry of cases) {
      const events = await collectEvents(entry.backend.runTurn(backendRunInput()));
      expect(events.at(-1), entry.name).toMatchObject({ event_type: "run_failed", terminal_evidence: entry.evidence });
    }
  });

  it("redacts provider secrets and filesystem paths without damaging URLs", async () => {
    const backend = new SamuraiNativeBackend(providerThrowing(new ProviderRequestError(
      "provider_failed",
      "Bearer provider-secret failed at /workspace/run and /Library/App; docs https://example.test/api",
      { reason: "auth_failed", retryable: false },
      "provider_terminal_response"
    )));

    const events = await collectEvents(backend.runTurn(backendRunInput()));
    const serialized = JSON.stringify(events.at(-1));

    expect(serialized).toContain("[redacted]");
    expect(serialized).toContain("[path]");
    expect(serialized).toContain("https://example.test/api");
    expect(serialized).not.toContain("provider-secret");
    expect(serialized).not.toContain("/workspace/run");
    expect(serialized).not.toContain("/Library/App");
  });

  it("does not call the provider when the signal is already aborted", async () => {
    let providerCalls = 0;
    const provider: ProviderAdapter = {
      id: "fake",
      model: "fake/never",
      async generate() {
        providerCalls += 1;
        return { content: "must not run", toolCalls: [] };
      }
    };
    const controller = new AbortController();
    controller.abort();

    const events = await collectEvents(new SamuraiNativeBackend(provider).runTurn({ ...backendRunInput(), abort_signal: controller.signal }));

    expect(providerCalls).toBe(0);
    expect(events).toHaveLength(1);
    expect(events[0]?.terminal_evidence).toEqual({ kind: "cancelled", source: "owned_loop_return" });
  });

  it("normalizes an abort between run_started and provider dispatch as confirmed cancellation", async () => {
    let providerCalls = 0;
    const controller = new AbortController();
    const provider: ProviderAdapter = {
      id: "fake",
      model: "fake/never",
      async generate() {
        providerCalls += 1;
        return { content: "must not run", toolCalls: [] };
      }
    };
    const iterator = new SamuraiNativeBackend(new ProviderRegistry([provider])).runTurn({ ...backendRunInput(), abort_signal: controller.signal })[Symbol.asyncIterator]();

    expect((await iterator.next()).value?.event_type).toBe("run_started");
    controller.abort();
    const terminal = await iterator.next();

    expect(providerCalls).toBe(0);
    expect(terminal.value?.terminal_evidence).toEqual({ kind: "cancelled", source: "owned_loop_return" });
    expect((await iterator.next()).done).toBe(true);
  });

  it("does not start a fallback when cancellation follows a confirmed provider failure", async () => {
    const controller = new AbortController();
    let fallbackCalls = 0;
    const first: ProviderAdapter = {
      id: "fake",
      model: "fake/first",
      async generate() {
        controller.abort();
        throw new ProviderRequestError("provider_failed", "First provider rejected the request.", { reason: "auth_failed", retryable: false }, "provider_terminal_response");
      }
    };
    const fallback: ProviderAdapter = {
      id: "fake",
      model: "fake/fallback",
      async generate() {
        fallbackCalls += 1;
        return { content: "must not run", toolCalls: [] };
      }
    };

    const events = await collectEvents(new SamuraiNativeBackend(new ProviderRegistry([first, fallback])).runTurn({ ...backendRunInput(), abort_signal: controller.signal }));

    expect(fallbackCalls).toBe(0);
    expect(events.at(-1)?.terminal_evidence).toEqual({ kind: "cancelled", source: "owned_loop_return" });
  });

  it.each([
    ["transport_lost", "transport_lost"],
    ["cancel_unconfirmed", "cancel_unconfirmed"]
  ] as const)("does not call a fallback after %s", async (disposition, reason) => {
    let fallbackCalls = 0;
    const first = providerThrowing(new ProviderRequestError(
      "provider_failed",
      disposition === "cancel_unconfirmed" ? "Provider cancellation was not confirmed." : "Provider transport was lost.",
      { reason: "network", retryable: true },
      disposition
    ));
    const fallback: ProviderAdapter = {
      id: "fake",
      model: "fake/fallback",
      async generate() {
        fallbackCalls += 1;
        return { content: "must not run", toolCalls: [] };
      }
    };
    const backend = new SamuraiNativeBackend(new ProviderRegistry([first, fallback]));

    const events = await collectEvents(backend.runTurn(backendRunInput()));

    expect(fallbackCalls).toBe(0);
    expect(events.at(-1)).toMatchObject({
      event_type: "run_failed",
      terminal_evidence: { kind: "indeterminate", reason, providerStarted: true, mayHaveSideEffects: true }
    });
  });
});

function providerThrowing(error: Error): ProviderAdapter {
  return {
    id: "fake",
    model: "fake/error",
    async generate() {
      throw error;
    }
  };
}

async function collectEvents(stream: AsyncIterable<BackendOutputEvent>): Promise<BackendOutputEvent[]> {
  const events: BackendOutputEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function backendRunInput(): BackendRunInput {
  return {
    run_id: "run_1",
    session_id: "session_1",
    input_message_id: "message_1",
    envelope: {
      id: "envelope_1",
      source: "web",
      actor_identity: "owner",
      session_key: "web:owner:main",
      user_intent: "write a note",
      attachments: [],
      input_locale: "en",
      output_locale: "en",
      metadata: {},
      received_at: "2026-06-26T00:00:00.000Z"
    },
    user_input: "write a note",
    input_locale: "en",
    output_locale: "en",
    active_memory: [{
      id: "memory_1",
      topic: "style",
      content: "Keep it concise.",
      state: "active",
      selection_reason: "state:active"
    }],
    knowledge_wiki: [{
      id: "wiki_1",
      slug: "project-notes",
      title: "Project Notes",
      content: "Release notes",
      source_refs: []
    }],
    collection_notes: [{
      collection_id: "collection_1",
      file_path: "collections/notes.md",
      content: "Context only",
      role: "context_only"
    }],
    selected_skills: [{
      id: "skill_1",
      title: "Drafting",
      description: "Write concise drafts",
      tags: ["writing"],
      required_capabilities: ["create_artifact"],
      disclosure_level: "body",
      content: "Write the draft."
    }],
    session_search: [{
      kind: "message",
      id: "message_old",
      title: "Earlier note",
      summary: "Previous context"
    }],
    session_summary: {
      session_key: "web:owner:main",
      title: "Note",
      ui_locale: "en",
      output_locale: "en",
      message_count: 1,
      operation_count: 0,
      backend_run_count: 0,
      tool_run_count: 0,
      workspace_change_count: 0
    },
    external_assist: {
      role: "disabled",
      isolated_from_memory: true,
      included_in_active_memory: false,
      note: "External assist disabled.",
      hints: [],
      recent_failures: []
    },
    available_tools: ["create_artifact"],
    recent_messages: [],
    metadata: {}
  };
}
