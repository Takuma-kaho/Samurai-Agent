import { describe, expect, it } from "vitest";
import type { ProviderInput } from "./provider";
import { createProviderRegistryFromEnv } from "./provider";
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

    expect(JSON.stringify(geminiTools)).not.toContain("additionalProperties");
    expect(JSON.stringify(openAiTools)).toContain("additionalProperties");
  });

  it("builds provider-specific request shapes", () => {
    const gemini = providerProfiles.gemini.buildRequest("gemini-test", { apiKey: "gemini-key" }, providerInput);
    const openai = providerProfiles.openai.buildRequest("gpt-test", { apiKey: "openai-key" }, providerInput);
    const anthropic = providerProfiles.anthropic.buildRequest("claude-test", { apiKey: "anthropic-key" }, providerInput);

    expect(gemini.url).toContain("/models/gemini-test:generateContent");
    expect(gemini.body).toHaveProperty("systemInstruction");
    expect(JSON.stringify(gemini.body)).not.toContain("additionalProperties");
    expect(openai.body).toHaveProperty("input");
    expect(openai.body).toHaveProperty("tools");
    expect(anthropic.body).toHaveProperty("messages");
    expect(anthropic.body).toHaveProperty("tools");
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
