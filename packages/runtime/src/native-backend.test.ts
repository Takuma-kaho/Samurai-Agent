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
