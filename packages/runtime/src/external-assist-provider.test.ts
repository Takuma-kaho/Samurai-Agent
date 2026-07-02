import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  HttpExternalAssistProvider,
  LocalFileExternalAssistProvider,
  createExternalAssistProviderFromEnv,
  createExternalAssistProvidersFromEnv,
  describeExternalAssistProviderConfig
} from "./external-assist-provider";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("local file external assist provider", () => {
  it("returns unverified local hints that match the query", async () => {
    const filePath = await writeExternalAssistFile([
      {
        id: "hint_release",
        title: "Release readiness",
        summary: "Use doctor, typecheck, full Vitest, build, and i18n before release.",
        source_label: "release-notes",
        keywords: ["release", "readiness", "doctor"],
        confidence: 0.91
      },
      {
        id: "hint_ui",
        title: "UI polish",
        summary: "Keep Chat Shell calm.",
        keywords: ["frontend"]
      }
    ]);
    const provider = new LocalFileExternalAssistProvider({ filePath, maxHints: 1 });

    const hints = await provider.prefetch({
      sessionId: "session_1",
      query: "release readiness doctor",
      recentMessages: [],
      sessionSearch: []
    });

    expect(hints).toEqual([{
      id: "hint_release",
      title: "Release readiness",
      summary: "Use doctor, typecheck, full Vitest, build, and i18n before release.",
      source_label: "release-notes",
      confidence: 0.91
    }]);
  });

  it("builds the provider from env without requiring UI secrets", async () => {
    const filePath = await writeExternalAssistFile([
      {
        summary: "External assist remains an unverified hint.",
        keywords: ["external", "assist"]
      }
    ]);
    const provider = createExternalAssistProviderFromEnv({
      SAMURAI_EXTERNAL_ASSIST_FILE: filePath,
      SAMURAI_EXTERNAL_ASSIST_PROVIDER_ID: "env-local-assist",
      SAMURAI_EXTERNAL_ASSIST_MAX_HINTS: "3"
    });

    expect(provider?.id).toBe("env-local-assist");
    await expect(provider?.prefetch({
      sessionId: "session_1",
      query: "external assist",
      recentMessages: [],
      sessionSearch: []
    })).resolves.toEqual([expect.objectContaining({
      id: "local_external_hint_1",
      summary: "External assist remains an unverified hint."
    })]);
  });

  it("builds multiple local file providers from env", async () => {
    const releaseFile = await writeExternalAssistFile([
      {
        id: "hint_release",
        summary: "Release checks should include doctor.",
        keywords: ["release"]
      }
    ]);
    const gatewayFile = await writeExternalAssistFile([
      {
        id: "hint_gateway",
        summary: "Gateway checks should include pairing diagnostics.",
        keywords: ["gateway"]
      }
    ]);
    const providers = createExternalAssistProvidersFromEnv({
      SAMURAI_EXTERNAL_ASSIST_FILES: [releaseFile, gatewayFile].join(path.delimiter),
      SAMURAI_EXTERNAL_ASSIST_PROVIDER_IDS: "release-assist,gateway-assist",
      SAMURAI_EXTERNAL_ASSIST_MAX_HINTS: "2"
    });

    expect(providers.map((provider) => provider.id)).toEqual(["release-assist", "gateway-assist"]);
    await expect(providers[0]?.prefetch({
      sessionId: "session_1",
      query: "release",
      recentMessages: [],
      sessionSearch: []
    })).resolves.toEqual([expect.objectContaining({
      id: "hint_release",
      summary: "Release checks should include doctor."
    })]);
    await expect(providers[1]?.prefetch({
      sessionId: "session_1",
      query: "gateway",
      recentMessages: [],
      sessionSearch: []
    })).resolves.toEqual([expect.objectContaining({
      id: "hint_gateway",
      summary: "Gateway checks should include pairing diagnostics."
    })]);

    expect(describeExternalAssistProviderConfig({
      SAMURAI_EXTERNAL_ASSIST_FILES: [releaseFile, gatewayFile].join(path.delimiter),
      SAMURAI_EXTERNAL_ASSIST_PROVIDER_IDS: "release-assist,gateway-assist"
    })).toMatchObject({
      configured: true,
      source: "multiple",
      provider_id: "release-assist, gateway-assist",
      provider_ids: ["release-assist", "gateway-assist"],
      provider_count: 2,
      provider_kind: "multiple",
      file_name: "external-assist.json, external-assist.json",
      errors: []
    });
  });
});

describe("http external assist provider", () => {
  it("posts prefetch input and normalizes remote hints without making them Memory", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init: init ?? {} });
      return new Response(JSON.stringify({
        hints: [
          {
            id: "remote_release",
            title: "Remote release hint",
            summary: "Run the backend release verifier before shipping.",
            source_label: "remote-provider",
            confidence: 1.5
          },
          {
            id: "empty_summary",
            summary: ""
          }
        ]
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    };
    const provider = new HttpExternalAssistProvider({
      url: "https://assist.example.test/hints",
      token: "secret-token",
      maxHints: 3,
      fetchImpl
    });

    const hints = await provider.prefetch({
      sessionId: "session_1",
      query: "release readiness",
      recentMessages: [{
        id: "message_1",
        session_id: "session_1",
        role: "user",
        content: "Check release readiness.",
        input_locale: "ja",
        output_locale: "ja",
        created_at: "2026-06-28T00:00:00.000Z"
      }],
      sessionSearch: [{ kind: "session", id: "session_0", title: "Previous release", summary: "doctor passed" }]
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://assist.example.test/hints");
    expect(calls[0]?.init.headers).toMatchObject({
      "content-type": "application/json",
      authorization: "Bearer secret-token"
    });
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({
      phase: "prefetch",
      session_id: "session_1",
      query: "release readiness",
      recent_messages: [expect.objectContaining({ id: "message_1", role: "user" })],
      session_search: [expect.objectContaining({ id: "session_0" })]
    });
    expect(hints).toEqual([{
      id: "remote_release",
      title: "Remote release hint",
      summary: "Run the backend release verifier before shipping.",
      source_label: "remote-provider",
      confidence: 1
    }]);
  });

  it("syncs a completed turn and accepts direct array responses", async () => {
    const calls: Array<{ init: RequestInit }> = [];
    const provider = new HttpExternalAssistProvider({
      url: "http://127.0.0.1:4317/external-assist",
      maxHints: 1,
      fetchImpl: async (_input, init) => {
        calls.push({ init: init ?? {} });
        return new Response(JSON.stringify([
          {
            content: "The remote provider learned a useful follow-up hint.",
            source_uri: "https://example.test/hints/1",
            confidence: -2
          },
          {
            summary: "extra hint"
          }
        ]), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
    });

    const hints = await provider.syncTurn({
      sessionId: "session_1",
      runId: "run_1",
      inputMessageId: "message_1",
      query: "remote assist",
      userContent: "What should I check next?",
      assistantContent: "Check the release gate."
    });

    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({
      phase: "sync",
      run_id: "run_1",
      input_message_id: "message_1",
      user_content: "What should I check next?",
      assistant_content: "Check the release gate."
    });
    expect(hints).toEqual([{
      id: "http_external_hint_1",
      summary: "The remote provider learned a useful follow-up hint.",
      source_uri: "https://example.test/hints/1",
      confidence: 0
    }]);
  });

  it("builds the HTTP provider from env before falling back to the local file provider", () => {
    const provider = createExternalAssistProviderFromEnv({
      SAMURAI_EXTERNAL_ASSIST_URL: "https://assist.example.test/hints",
      SAMURAI_EXTERNAL_ASSIST_FILE: "/tmp/ignored.json",
      SAMURAI_EXTERNAL_ASSIST_PROVIDER_ID: "env-http-assist",
      SAMURAI_EXTERNAL_ASSIST_TIMEOUT_MS: "1200"
    });

    expect(provider).toBeInstanceOf(HttpExternalAssistProvider);
    expect(provider?.id).toBe("env-http-assist");
  });

  it("describes HTTP env without exposing tokens or query strings", () => {
    const diagnostics = describeExternalAssistProviderConfig({
      SAMURAI_EXTERNAL_ASSIST_URL: "https://secret.example.test/hints?token=raw-secret",
      SAMURAI_EXTERNAL_ASSIST_TOKEN: "raw-token",
      SAMURAI_EXTERNAL_ASSIST_AUTH_HEADER: "X-Assist-Key",
      SAMURAI_EXTERNAL_ASSIST_MAX_HINTS: "99",
      SAMURAI_EXTERNAL_ASSIST_TIMEOUT_MS: "50"
    });

    expect(diagnostics).toMatchObject({
      configured: true,
      source: "http",
      provider_kind: "http",
      provider_id: "http-external-assist",
      max_hints: 10,
      timeout_ms: 250,
      token_configured: true,
      auth_header: "X-Assist-Key",
      endpoint_origin: "https://secret.example.test",
      endpoint_path_configured: true,
      errors: []
    });
    expect(JSON.stringify(diagnostics)).not.toContain("raw-token");
    expect(JSON.stringify(diagnostics)).not.toContain("raw-secret");
  });

  it("turns invalid HTTP env into diagnostics instead of creating a provider", () => {
    const env = {
      SAMURAI_EXTERNAL_ASSIST_URL: "file:///tmp/external-assist.json",
      SAMURAI_EXTERNAL_ASSIST_TOKEN: "raw-token",
      SAMURAI_EXTERNAL_ASSIST_PROVIDER_ID: "broken-assist"
    };

    expect(createExternalAssistProviderFromEnv(env)).toBeUndefined();
    expect(describeExternalAssistProviderConfig(env)).toMatchObject({
      configured: false,
      source: "invalid",
      provider_kind: "http",
      provider_id: "broken-assist",
      token_configured: true,
      errors: ["invalid_external_assist_url"]
    });
  });
});

async function writeExternalAssistFile(items: unknown[]): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "samurai-external-assist-"));
  roots.push(root);
  const filePath = path.join(root, "external-assist.json");
  await writeFile(filePath, JSON.stringify(items), "utf8");
  return filePath;
}
