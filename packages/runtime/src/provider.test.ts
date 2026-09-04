import { describe, expect, it, vi } from "vitest";
import type { ProviderInput } from "./provider";
import {
  createProviderRegistryFromEnv,
  ensureProviderToolCallIds,
  PROVIDER_REQUEST_TIMEOUT_MS,
  ProviderRegistry,
  ProviderRequestError,
  parseServerSentEventData,
  ServerSentEventParser,
  type ProviderAdapter
} from "./provider";
import { providerProfiles, providerTools } from "./provider-profiles";

const providerInput: ProviderInput = {
  envelope: {
    id: "msg_test",
    source: "web",
    actor_identity: "owner",
    session_key: "web:owner:test",
    user_intent: "提案書を作って",
    input_locale: "ja",
    output_locale: "ja",
    attachments: [],
    metadata: {},
    received_at: "2026-01-01T00:00:00.000Z"
  },
  activeMemory: [],
  knowledgeWiki: [],
  collectionNotes: [],
  selectedSkills: [],
  sessionSearch: [],
  availableTools: [],
  recentMessages: []
};

describe("provider profiles", () => {
  it("keeps Gemini as the first automatic default when multiple keys exist", () => {
    const registry = createProviderRegistryFromEnv({
      GEMINI_API_KEY: "gemini-key",
      OPENAI_API_KEY: "openai-key"
    });

    expect(registry.getStatus().primary).toMatchObject({
      provider: "gemini",
      model: "gemini-3.5-flash"
    });
  });

  it("keeps explicit primary and fallback order from env", () => {
    const registry = createProviderRegistryFromEnv({
      SAMURAI_LLM_MODEL: "openai/gpt-test",
      SAMURAI_LLM_FALLBACKS: "gemini/gemini-test,anthropic/claude-test",
      OPENAI_API_KEY: "openai-key",
      GEMINI_API_KEY: "gemini-key",
      ANTHROPIC_API_KEY: "anthropic-key"
    });

    expect(registry.getStatus()).toMatchObject({
      primary: { provider: "openai", model: "gpt-test" },
      fallbacks: [
        { provider: "gemini", model: "gemini-test" },
        { provider: "anthropic", model: "claude-test" }
      ]
    });
  });

  it("sanitizes Gemini tool schemas without changing the canonical tools", () => {
    const geminiTools = providerTools("gemini");
    const openAiTools = providerTools("openai");
    const serializedGeminiTools = JSON.stringify(geminiTools);
    const createArtifact = (geminiTools as Array<{ functionDeclarations: Array<{ name: string; parameters: Record<string, unknown> }> }>)[0].functionDeclarations
      .find((tool) => tool.name === "create_artifact");

    expect(serializedGeminiTools).not.toContain("additionalProperties");
    expect(serializedGeminiTools).not.toContain("\"$ref\"");
    expect(serializedGeminiTools).not.toContain("\"$defs\"");
    expect(serializedGeminiTools).not.toContain("\"definitions\"");
    expect(createArtifact?.parameters.type).toBe("object");
    const properties = createArtifact?.parameters.properties as Record<string, Record<string, unknown>> | undefined;
    expect(properties?.content?.type).toBe("string");
    expect(properties?.metadata?.type).toBe("object");
    expect(properties?.title?.type).toBe("string");
    expect(createArtifact?.parameters.required).toEqual(expect.arrayContaining(["content", "title"]));
    expect(JSON.stringify(openAiTools)).toContain("additionalProperties");
  });

  it("builds provider-specific request shapes", () => {
    const gemini = providerProfiles.gemini.buildRequest("gemini-test", { apiKey: "gemini-key" }, providerInput);
    const openai = providerProfiles.openai.buildRequest("gpt-test", { apiKey: "openai-key" }, providerInput);
    const anthropic = providerProfiles.anthropic.buildRequest("claude-test", { apiKey: "anthropic-key" }, providerInput);

    expect(gemini.url).toContain("/models/gemini-test:generateContent");
    expect(gemini.url).not.toContain("key=");
    expect(gemini.headers["x-goog-api-key"]).toBe("gemini-key");
    expect(gemini.body).toHaveProperty("systemInstruction");
    expect(JSON.stringify(gemini.body)).not.toContain("additionalProperties");
    expect(openai.body).toHaveProperty("input");
    expect(openai.body).toHaveProperty("tools");
    expect(anthropic.body).toHaveProperty("messages");
    expect(anthropic.body).toHaveProperty("tools");
    expect(JSON.stringify(gemini.body)).toContain("Output locale: ja");
    expect(JSON.stringify(openai.body)).toContain("Output locale: ja");
    expect(JSON.stringify(anthropic.body)).toContain("Output locale: ja");
  });

  it("advertises only tools available to the current runtime boundary", () => {
    const scopedInput = { ...providerInput, availableTools: ["create_artifact"] };
    const domainScopedInput = { ...providerInput, availableTools: ["artifact.create"] };
    const emptyInput = { ...providerInput, availableTools: [] };
    const requests = [
      providerProfiles.openai.buildRequest("gpt-test", { apiKey: "openai-key" }, scopedInput),
      providerProfiles.anthropic.buildRequest("claude-test", { apiKey: "anthropic-key" }, scopedInput),
      providerProfiles.openrouter.buildRequest("openai/gpt-test", { apiKey: "openrouter-key", baseUrl: "https://openrouter.example" }, scopedInput),
      providerProfiles.gemini.buildRequest("gemini-test", { apiKey: "gemini-key" }, scopedInput)
    ];

    expect((requests[0]?.body as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name)).toEqual(["create_artifact"]);
    expect((requests[1]?.body as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name)).toEqual(["create_artifact"]);
    expect(((requests[2]?.body as { tools: Array<{ function: { name: string } }> }).tools).map((tool) => tool.function.name)).toEqual(["create_artifact"]);
    expect((requests[3]?.body as { tools: Array<{ functionDeclarations: Array<{ name: string }> }> }).tools[0]?.functionDeclarations.map((tool) => tool.name)).toEqual(["create_artifact"]);

    const domainScopedGemini = providerProfiles.gemini.buildRequest("gemini-test", { apiKey: "gemini-key" }, domainScopedInput);
    expect((domainScopedGemini.body as { tools: Array<{ functionDeclarations: Array<{ name: string }> }> }).tools[0]?.functionDeclarations.map((tool) => tool.name)).toEqual(["create_artifact"]);

    for (const provider of [providerProfiles.openai, providerProfiles.anthropic, providerProfiles.openrouter, providerProfiles.gemini]) {
      const request = provider.buildRequest("test-model", { apiKey: "test-key", baseUrl: "https://provider.example" }, emptyInput);
      expect((request.body as { tools: unknown[] }).tools).toEqual([]);
    }
  });

  it("uses Gemini's official streamGenerateContent SSE endpoint", () => {
    const request = providerProfiles.gemini.buildStreamRequest?.("gemini-test", { apiKey: "gemini-key" }, providerInput);

    expect(request?.url).toContain("/models/gemini-test:streamGenerateContent?alt=sse");
    expect(request?.url).not.toContain("key=");
    expect(request?.headers["x-goog-api-key"]).toBe("gemini-key");
  });

  it("normalizes a Gemini stream chunk without inventing text", () => {
    const chunk = providerProfiles.gemini.normalizeStreamChunk?.({
      candidates: [{
        content: { parts: [{ text: "先頭" }] }
      }]
    });

    expect(chunk).toEqual({ content: "先頭" });
  });

  it("rejects Gemini blocked finish reasons before normalizing output", () => {
    const response = {
      candidates: [{ content: { parts: [] }, finishReason: "SAFETY" }]
    };

    expect(() => providerProfiles.gemini.normalizeResponse(response)).toThrow("safety policy");
    expect(() => providerProfiles.gemini.normalizeStreamChunk?.(response)).toThrow("safety policy");
  });

  it("reads Gemini SSE chunks incrementally through the configured adapter", async () => {
    const originalFetch = globalThis.fetch;
    const first = JSON.stringify({ candidates: [{ content: { parts: [{ text: "Hel" }] } }] });
    const second = JSON.stringify({ candidates: [{ content: { parts: [{ text: "lo" }] }, finishReason: "STOP" }], usageMetadata: { totalTokenCount: 2 } });
    const responseText = `data: ${first}\n\ndata: ${second}\n\ndata: [DONE]\n\n`;
    const fragments = [responseText.slice(0, 13), responseText.slice(13, 39), responseText.slice(39)];
    globalThis.fetch = async (input, init) => {
      expect(String(input)).toContain(":streamGenerateContent?alt=sse");
      const headers = new Headers(init?.headers);
      expect(headers.get("x-goog-api-key")).toBe("gemini-key");
      expect(headers.get("accept")).toBe("text/event-stream");
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const fragment of fragments) controller.enqueue(new TextEncoder().encode(fragment));
          controller.close();
        }
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    };

    try {
      const registry = createProviderRegistryFromEnv({
        SAMURAI_LLM_MODEL: "gemini/gemini-test",
        GEMINI_API_KEY: "gemini-key"
      });
      const chunks = await collectProviderStream(registry.stream(providerInput));
      expect(chunks).toEqual([
        { content: "Hel" },
        { content: "lo", finishReason: "STOP", usage: { totalTokenCount: 2 } },
        { terminal: true }
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("accepts a Gemini thoughtSignature-only stream part without displaying it", () => {
    const chunk = providerProfiles.gemini.normalizeStreamChunk?.({
      candidates: [{
        content: { parts: [{ thoughtSignature: "opaque-provider-metadata" }] },
        finishReason: "STOP"
      }]
    });

    expect(chunk).toEqual({ finishReason: "STOP", ignored: true });
    expect(JSON.stringify(chunk)).not.toContain("opaque-provider-metadata");
  });

  it("parses SSE events across chunk boundaries and joins data fields", () => {
    const parser = new ServerSentEventParser();
    const events = [
      ...parser.push("event: message\ndata: {\"text\":\"hel"),
      ...parser.push("lo\"}\n\ndata: first\n"),
      ...parser.push("data: second\n\n")
    ];

    expect(events).toEqual([
      { event: "message", data: '{"text":"hello"}' },
      { data: "first\nsecond" }
    ]);
    expect(parseServerSentEventData({ data: "[DONE]" })).toBeUndefined();
    expect(() => parseServerSentEventData({ data: "not-json" })).toThrow("Provider stream response was invalid.");
  });

  it("derives stable, unique IDs for missing and duplicate provider tool IDs", () => {
    const calls = [
      { name: "create_artifact", arguments: { title: "same" } },
      { name: "create_artifact", arguments: { title: "same" } },
      { id: "provider-call", name: "remember_topic", arguments: {} },
      { id: "provider-call", name: "remember_topic", arguments: {} }
    ];
    const first = ensureProviderToolCallIds(calls);
    const second = ensureProviderToolCallIds(calls);

    expect(first.map((call) => call.id)).toEqual(second.map((call) => call.id));
    expect(new Set(first.map((call) => call.id)).size).toBe(calls.length);
    expect(first.every((call) => Boolean(call.id))).toBe(true);
  });

  it("keeps streaming fallback for a terminal primary failure", async () => {
    const primary: ProviderAdapter = {
      id: "gemini",
      model: "gemini/primary",
      async generate() {
        throw new Error("unused");
      },
      async *stream() {
        throw new ProviderRequestError("provider_failed", "Primary rejected the request.", {
          reason: "auth_failed",
          retryable: false
        }, "provider_terminal_response");
      }
    };
    const fallback: ProviderAdapter = {
      id: "fake",
      model: "fake/fallback",
      async generate() {
        return { content: "fallback", toolCalls: [] };
      }
    };

    const chunks = await collectProviderStream(new ProviderRegistry([primary, fallback]).stream(providerInput));
    expect(chunks).toEqual([{ content: "fallback", toolCalls: [], terminal: true }]);
  });

  it("treats SSE [DONE] as an explicit stream terminator", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"done\"}]}}]}\n\ndata: [DONE]\n\n"));
          controller.close();
        }
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    };

    try {
      const registry = createProviderRegistryFromEnv({
        SAMURAI_LLM_MODEL: "gemini/gemini-test",
        GEMINI_API_KEY: "gemini-key"
      });
      await expect(collectProviderStream(registry.stream(providerInput))).resolves.toEqual([
        { content: "done" },
        { terminal: true }
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("settles a hanging HTTP provider request at the bounded timeout", async () => {
    vi.useFakeTimers();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        const error = new Error("request aborted");
        error.name = "AbortError";
        reject(error);
      }, { once: true });
    });

    try {
      const pending = createProviderRegistryFromEnv({
        SAMURAI_LLM_MODEL: "openai/gpt-test",
        OPENAI_API_KEY: "http-timeout-secret"
      }).generate(providerInput);
      const assertion = expect(pending).rejects.toMatchObject({
        disposition: "transport_lost",
        diagnostics: { reason: "network" }
      });
      await vi.advanceTimersByTimeAsync(PROVIDER_REQUEST_TIMEOUT_MS);
      await assertion;
      const error = await pending.catch((value: unknown) => value) as Error;
      expect(JSON.stringify(error)).not.toContain("http-timeout-secret");
    } finally {
      globalThis.fetch = originalFetch;
      vi.useRealTimers();
    }
  });

  it("settles a hanging SSE provider request at the bounded timeout", async () => {
    vi.useFakeTimers();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        const error = new Error("stream aborted");
        error.name = "AbortError";
        reject(error);
      }, { once: true });
    });

    try {
      const pending = collectProviderStream(createProviderRegistryFromEnv({
        SAMURAI_LLM_MODEL: "gemini/gemini-test",
        GEMINI_API_KEY: "sse-timeout-secret"
      }).stream(providerInput));
      const assertion = expect(pending).rejects.toMatchObject({
        disposition: "transport_lost",
        diagnostics: { reason: "network" }
      });
      await vi.advanceTimersByTimeAsync(PROVIDER_REQUEST_TIMEOUT_MS);
      await assertion;
      const error = await pending.catch((value: unknown) => value) as Error;
      expect(JSON.stringify(error)).not.toContain("sse-timeout-secret");
    } finally {
      globalThis.fetch = originalFetch;
      vi.useRealTimers();
    }
  });

  it("does not fallback after a partial stream transport loss", async () => {
    let fallbackCalls = 0;
    const primary: ProviderAdapter = {
      id: "gemini",
      model: "gemini/primary",
      async generate() {
        throw new Error("unused");
      },
      async *stream() {
        yield { content: "partial" };
        throw new ProviderRequestError("provider_failed", "Provider stream was interrupted.", {
          reason: "network",
          retryable: true
        }, "transport_lost");
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

    await expect(collectProviderStream(new ProviderRegistry([primary, fallback]).stream(providerInput))).rejects.toMatchObject({
      disposition: "transport_lost"
    });
    expect(fallbackCalls).toBe(0);
  });

  it("injects the frozen SOUL/Profile snapshot into provider context", () => {
    const openai = providerProfiles.openai.buildRequest("gpt-test", { apiKey: "openai-key" }, {
      ...providerInput,
      freezeSnapshot: {
        id: "freeze_test",
        soul: {
          id: "soul",
          kind: "soul",
          file_ref: {
            kind: "profile",
            id: "soul",
            uri: "profile/SOUL.md",
            label: "SOUL.md"
          },
          content: "# SOUL.md\n\n- Keep responsibilities separate.",
          loaded_at: "2026-01-01T00:00:00.000Z"
        },
        memory_refs: [],
        skill_refs: [],
        wiki_refs: [],
        content: "# Frozen identity\n\n## SOUL.md\n- Keep responsibilities separate.",
        stable_hash: "hash_test",
        created_at: "2026-01-01T00:00:00.000Z"
      },
      sessionSummary: {
        session_key: "web:owner:test",
        title: "Test session",
        ui_locale: "ja",
        output_locale: "ja",
        message_count: 2,
        operation_count: 1,
        backend_run_count: 1,
        tool_run_count: 0,
        workspace_change_count: 1,
        last_backend_run_status: "completed"
      },
      externalAssist: {
        role: "assistive",
        isolated_from_memory: true,
        included_in_active_memory: false,
        note: "External provider output is assistive only.",
        hints: [{
          id: "hint_test",
          title: "External context",
          summary: "Use this only as an unverified hint.",
          source_uri: "external://hint/test"
        }],
        recent_failures: []
      },
      collectionNotes: [{
        collection_id: "contacts",
        file_path: "collections/contacts/notes/README.md",
        content: "Use the note only as context.",
        role: "context_only"
      }]
    });

    expect(JSON.stringify(openai.body)).toContain("Freeze snapshot");
    expect(JSON.stringify(openai.body)).toContain("Keep responsibilities separate");
    expect(JSON.stringify(openai.body)).toContain("Session summary");
    expect(JSON.stringify(openai.body)).toContain("operations: 1");
    expect(JSON.stringify(openai.body)).toContain("External assist");
    expect(JSON.stringify(openai.body)).toContain("isolated_from_memory: yes");
    expect(JSON.stringify(openai.body)).toContain("Collection notes (context only)");
    expect(JSON.stringify(openai.body)).toContain("Use the note only as context");
  });

  it("accepts tool-call-only responses from supported providers", () => {
    const artifactArgs = {
      title: "作業メモ",
      content: "# 作業メモ\n\n本文"
    };
    const outputs = [
      providerProfiles.openai.normalizeResponse({
        status: "completed",
        output: [
          {
            type: "function_call",
            call_id: "call_openai",
            name: "create_artifact",
            arguments: JSON.stringify(artifactArgs)
          }
        ]
      }),
      providerProfiles.gemini.normalizeResponse({
        candidates: [
          {
            content: {
              parts: [
                {
                  functionCall: {
                    name: "create_artifact",
                    args: artifactArgs
                  }
                }
              ]
            }
          }
        ]
      }),
      providerProfiles.anthropic.normalizeResponse({
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "toolu_anthropic",
            name: "create_artifact",
            input: artifactArgs
          }
        ]
      }),
      providerProfiles.openrouter.normalizeResponse({
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_chat",
                  type: "function",
                  function: {
                    name: "create_artifact",
                    arguments: JSON.stringify(artifactArgs)
                  }
                }
              ]
            }
          }
        ]
      })
    ];

    for (const output of outputs) {
      expect(output.content).toBe("対応しました。");
      expect(output.toolCalls).toHaveLength(1);
      expect(output.toolCalls[0]).toMatchObject({
        name: "create_artifact",
        arguments: artifactArgs
      });
    }
  });

  it("does not classify every Gemini 400 invalid request as invalid_model", () => {
    expect(providerProfiles.gemini.classifyError(400, "Invalid value at tools[0].functionDeclarations[0].parameters")).toBe("unknown");
    expect(providerProfiles.gemini.classifyError(400, "The requested model was not found.")).toBe("invalid_model");
  });
});

async function collectProviderStream(stream: AsyncIterable<unknown>): Promise<unknown[]> {
  const chunks: unknown[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}
