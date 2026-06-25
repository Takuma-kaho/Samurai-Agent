import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { FakeProviderAdapter, ProviderRequestError, type ProviderAdapter, type ProviderOutput } from "@samurai-agent/runtime";
import { createApiServer, loadServerEnv, type ApiServer } from "./index";

const roots: string[] = [];
const servers: ApiServer[] = [];
const managedEnv = new Map<string, string | undefined>();

afterEach(async () => {
  try {
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.io.close();
            server.httpServer.close(() => resolve());
            void server.store.close();
          })
      )
    );
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  } finally {
    restoreManagedEnv();
  }
});

describe("server env loading", () => {
  it("does nothing when the env file is missing", () => {
    expect(() => loadServerEnv(path.join(tmpdir(), `missing-samurai-${Date.now()}`, ".env"))).not.toThrow();
  });

  it("loads env file values through process.loadEnvFile", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-env-"));
    roots.push(root);
    const envPath = path.join(root, ".env");
    deleteManagedEnv("SAMURAI_ENV_LOAD_TEST");
    deleteManagedEnv("PORT");

    await writeFile(envPath, "SAMURAI_ENV_LOAD_TEST=loaded\nPORT=49321\n", "utf8");
    loadServerEnv(envPath);

    expect(process.env.SAMURAI_ENV_LOAD_TEST).toBe("loaded");
    expect(process.env.PORT).toBe("49321");
  });

  it("fails clearly when an env file exists but process.loadEnvFile is unavailable", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-env-"));
    roots.push(root);
    const envPath = path.join(root, ".env");
    await writeFile(envPath, "SAMURAI_ENV_LOAD_TEST=loaded\n", "utf8");
    const originalLoadEnvFile = process.loadEnvFile;

    Object.defineProperty(process, "loadEnvFile", { configurable: true, value: undefined });
    try {
      expect(() => loadServerEnv(envPath)).toThrow("process.loadEnvFile()");
    } finally {
      Object.defineProperty(process, "loadEnvFile", { configurable: true, value: originalLoadEnvFile });
    }
  });

  it("keeps injected fake providers even when provider env is set", async () => {
    setManagedEnv("SAMURAI_LLM_MODEL", "openai/test-model");
    setManagedEnv("OPENAI_API_KEY", "test-key");
    const { baseUrl } = await startTestServer();

    const health = await getJson<{ llm: { primary: { provider: string; model: string } } }>(`${baseUrl}/api/health`);

    expect(health.llm.primary).toMatchObject({ provider: "fake", model: "fake/test" });
  });
});

describe("backend run API", () => {
  it("does not create approval requests for backend-native external work", async () => {
    const { baseUrl } = await startTestServer();
    const session = await postJson<{ id: string }>(`${baseUrl}/api/chat/sessions`, {}, 201);
    const turn = await postJson<{ approvalRequests: Array<{ id: string }>; backendEvents: Array<{ event_type: string; payload: Record<string, unknown> }> }>(`${baseUrl}/api/chat/sessions/${session.id}/messages`, {
      content: "提案書を作って、あとでメール送信もして",
      output_locale: "ja"
    }, 201);

    expect(turn.approvalRequests).toEqual([]);
    expect(turn.backendEvents.some((event) => event.event_type === "tool_call_output" && event.payload.status === "ignored")).toBe(true);
  });

  it("returns backend run events and workspace changes", async () => {
    const { baseUrl } = await startTestServer();
    const session = await postJson<{ id: string }>(`${baseUrl}/api/chat/sessions`, {}, 201);
    const turn = await postJson<{ backendRun: { id: string }; backendEvents: unknown[]; workspaceChanges: unknown[] }>(`${baseUrl}/api/chat/sessions/${session.id}/messages`, {
      content: "提案書を作って",
      output_locale: "ja"
    }, 201);

    const runs = await getJson<Array<{ id: string }>>(`${baseUrl}/api/backend-runs?session_id=${session.id}`);
    const events = await getJson<unknown[]>(`${baseUrl}/api/backend-runs/${turn.backendRun.id}/events`);
    const changes = await getJson<unknown[]>(`${baseUrl}/api/workspace-changes?session_id=${session.id}`);

    expect(runs.some((run) => run.id === turn.backendRun.id)).toBe(true);
    expect(events.length).toBe(turn.backendEvents.length);
    expect(changes.length).toBe(turn.workspaceChanges.length);
  });

  it("lists selectable agent backends", async () => {
    const { baseUrl } = await startTestServer();

    const backends = await getJson<Array<{ id: string; configured: boolean }>>(`${baseUrl}/api/agent-backends`);

    expect(backends.map((backend) => backend.id)).toEqual(expect.arrayContaining(["samurai-native", "claude-code", "codex"]));
    expect(backends.find((backend) => backend.id === "samurai-native")?.configured).toBe(true);
  });

  it("records an unconfigured external backend as a failed run", async () => {
    setManagedEnv("SAMURAI_CLAUDE_CODE_COMMAND", "");
    setManagedEnv("SAMURAI_CLAUDE_CODE_ARGS", "");
    const { baseUrl } = await startTestServer();
    const session = await postJson<{ id: string }>(`${baseUrl}/api/chat/sessions`, {}, 201);

    const response = await postJson<{
      error: string;
      reason?: string;
      backendRun?: { backend_id: string; status: string; error_code?: string };
      backendEvents?: Array<{ event_type: string; payload: Record<string, unknown> }>;
    }>(
      `${baseUrl}/api/chat/sessions/${session.id}/messages`,
      {
        content: "Claude Codeで確認して",
        output_locale: "ja",
        backend_id: "claude-code"
      },
      502
    );

    expect(response.error).toBe("provider_failed");
    expect(response.reason).toBe("not_configured");
    expect(response.backendRun).toMatchObject({
      backend_id: "claude-code",
      status: "failed",
      error_code: "backend_not_configured"
    });
    expect(response.backendEvents?.some((event) => event.event_type === "run_failed" && event.payload.error_code === "backend_not_configured")).toBe(true);
  });

  it("returns session scoped artifacts and memory details", async () => {
    const { baseUrl } = await startTestServer();
    const sessionA = await postJson<{ id: string }>(`${baseUrl}/api/chat/sessions`, {}, 201);
    const sessionB = await postJson<{ id: string }>(`${baseUrl}/api/chat/sessions`, {}, 201);
    const turnA = await postJson<{ artifacts: Array<{ id: string }>; memories: Array<{ id: string; state: string }> }>(
      `${baseUrl}/api/chat/sessions/${sessionA.id}/messages`,
      {
        content: "提案書を作って、今後この文体を覚えて",
        output_locale: "ja"
      },
      201
    );
    await postJson(`${baseUrl}/api/chat/sessions/${sessionB.id}/messages`, {
      content: "別の提案書を作って",
      output_locale: "ja"
    }, 201);

    const detail = await getJson<{ artifacts: Array<{ id: string }>; memory: Array<{ id: string }> }>(`${baseUrl}/api/chat/sessions/${sessionA.id}`);
    const artifact = await getJson<Record<string, unknown>>(`${baseUrl}/api/artifacts/${turnA.artifacts[0]!.id}`);
    const memory = turnA.memories.find((item) => item.state === "topic")!;
    const memoryDetail = await getJson<Record<string, unknown>>(`${baseUrl}/api/memory/${memory.id}`);

    expect(detail.artifacts.map((item) => item.id)).toContain(turnA.artifacts[0]!.id);
    expect(detail.memory.map((item) => item.id)).toContain(memory.id);
    expect(artifact).toHaveProperty("operation");
    expect(artifact).toHaveProperty("auditRecords");
    expect(memoryDetail).toHaveProperty("memory");
    expect(memoryDetail).toHaveProperty("content");
  });

  it("archives memory through API and removes it from normal views", async () => {
    const { baseUrl } = await startTestServer();
    const session = await postJson<{ id: string }>(`${baseUrl}/api/chat/sessions`, {}, 201);
    const turn = await postJson<{ memories: Array<{ id: string; state: string }> }>(`${baseUrl}/api/chat/sessions/${session.id}/messages`, {
      content: "提案書を作って、今後この文体を覚えて",
      output_locale: "ja"
    }, 201);
    const memory = turn.memories.find((item) => item.state === "topic")!;

    const archived = await postJson<Record<string, unknown>>(`${baseUrl}/api/memory/${memory.id}/archive`, {
      session_id: session.id
    });
    const allMemory = await getJson<Array<{ id: string }>>(`${baseUrl}/api/memory`);
    const detail = await getJson<{ memory: Array<{ id: string }> }>(`${baseUrl}/api/chat/sessions/${session.id}`);
    const badRequest = await postJson<Record<string, unknown>>(`${baseUrl}/api/memory/${memory.id}/archive`, {}, 400);

    expect(archived).toHaveProperty("operation");
    expect(archived).toHaveProperty("auditRecord");
    expect(archived).toHaveProperty("activity");
    expect(archived).toHaveProperty("rollbackPoint");
    expect(allMemory.some((item) => item.id === memory.id)).toBe(false);
    expect(detail.memory.some((item) => item.id === memory.id)).toBe(false);
    expect(badRequest.error).toBe("session_id_required");
  });

  it("returns enriched search results", async () => {
    const { baseUrl } = await startTestServer();
    const session = await postJson<{ id: string }>(`${baseUrl}/api/chat/sessions`, {}, 201);
    const turn = await postJson<{ artifacts: Array<{ id: string }> }>(
      `${baseUrl}/api/chat/sessions/${session.id}/messages`,
      {
        content: "検索用の提案書を作って",
        output_locale: "ja"
      },
      201
    );

    const messageResults = await getJson<Array<{ kind: string; session_id?: string }>>(`${baseUrl}/api/search?q=${encodeURIComponent("検索用")}`);
    const artifactResults = await getJson<Array<{ kind: string; id: string; session_id?: string; operation_id?: string }>>(
      `${baseUrl}/api/search?q=${encodeURIComponent("提案")}`
    );
    const emptyResults = await getJson<unknown[]>(`${baseUrl}/api/search?q=${encodeURIComponent("   ")}`);

    expect(messageResults.some((result) => result.kind === "message" && result.session_id === session.id)).toBe(true);
    expect(
      artifactResults.some((result) => result.kind === "artifact" && result.id === turn.artifacts[0]!.id && result.session_id === session.id && result.operation_id)
    ).toBe(true);
    expect(emptyResults).toEqual([]);
  });

  it("returns sanitized provider diagnostics without raw provider messages", async () => {
    const { baseUrl } = await startTestServer(new FailingProviderAdapter());
    const session = await postJson<{ id: string }>(`${baseUrl}/api/chat/sessions`, {}, 201);

    const response = await postJson<Record<string, unknown>>(`${baseUrl}/api/chat/sessions/${session.id}/messages`, {
      content: "こんにちは",
      output_locale: "ja"
    }, 502);

    expect(response).toMatchObject({
      error: "provider_failed",
      reason: "auth_failed",
      provider: "fake",
      model: "fake/failing",
      status: 401,
      retryable: false
    });
    expect(JSON.stringify(response)).not.toContain("secret-token");
    expect(response).not.toHaveProperty("message");
  });

  it("persists settings through get and patch", async () => {
    const { baseUrl } = await startTestServer();

    const initial = await getJson<{ ui_locale: string; output_locale: string; memory_capture_mode: string; knowledge_wiki_capture_mode: string }>(`${baseUrl}/api/settings`);
    const patched = await patchJson<{
      ui_locale: string;
      output_locale: string;
      memory_capture_mode: string;
      knowledge_wiki_capture_mode: string;
      external_provider_role: string;
    }>(`${baseUrl}/api/settings`, {
      ui_locale: "en",
      output_locale: "fr",
      memory_capture_mode: "manual",
      knowledge_wiki_capture_mode: "manual",
      external_provider_role: "disabled",
      ignored: "value"
    });
    const legacyPatched = await patchJson<{ knowledge_wiki_capture_mode: string }>(`${baseUrl}/api/settings`, {
      llm_wiki_capture_mode: "off"
    });
    const priorityPatched = await patchJson<{ knowledge_wiki_capture_mode: string }>(`${baseUrl}/api/settings`, {
      llm_wiki_capture_mode: "off",
      knowledge_wiki_capture_mode: "suggest"
    });
    const persisted = await getJson<{
      ui_locale: string;
      output_locale: string;
      memory_capture_mode: string;
      knowledge_wiki_capture_mode: string;
      external_provider_role: string;
    }>(`${baseUrl}/api/settings`);
    const invalidPatch = await patchJson<{ ui_locale: string; output_locale: string }>(`${baseUrl}/api/settings`, {
      ui_locale: "xx"
    });
    const invalidCapture = await patchJson<{ error: string; field: string }>(
      `${baseUrl}/api/settings`,
      {
        memory_capture_mode: "always"
      },
      400
    );

    expect(initial).toMatchObject({ ui_locale: "ja", output_locale: "ja", memory_capture_mode: "suggest", knowledge_wiki_capture_mode: "suggest" });
    expect(patched).toMatchObject({
      ui_locale: "en",
      output_locale: "fr",
      memory_capture_mode: "manual",
      knowledge_wiki_capture_mode: "manual",
      external_provider_role: "disabled"
    });
    expect(legacyPatched).toMatchObject({ knowledge_wiki_capture_mode: "off" });
    expect(priorityPatched).toMatchObject({ knowledge_wiki_capture_mode: "suggest" });
    expect(persisted).toMatchObject({
      ui_locale: "en",
      output_locale: "fr",
      memory_capture_mode: "manual",
      knowledge_wiki_capture_mode: "suggest",
      external_provider_role: "disabled"
    });
    expect(invalidPatch).toMatchObject({ ui_locale: "en", output_locale: "fr" });
    expect(invalidCapture).toEqual({ error: "invalid_capture_mode", field: "memory_capture_mode" });
  });

  it("serves minimal skill collection and automation backend routes", async () => {
    const { baseUrl } = await startTestServer();
    const candidate = await postJson<{ resource: { id: string }; operation: { operation: string }; auditRecord: unknown; rollbackPoint?: unknown }>(
      `${baseUrl}/api/skills/candidates`,
      {
        title: "調査メモ",
        description: "調査メモを整える",
        content: "# Skill"
      },
      201
    );
    const project = await postJson<{ resource: { id: string }; operation: { operation: string } }>(
      `${baseUrl}/api/skills/projects`,
      { candidate_id: candidate.resource.id },
      201
    );
    const skills = await getJson<Array<{ id: string }>>(`${baseUrl}/api/skills`);
    const skillDetail = await getJson<{ markdown: string }>(`${baseUrl}/api/skills/${project.resource.id}`);

    const schema = await postJson<{ resource: { id: string }; operation: { operation: string } }>(
      `${baseUrl}/api/collections/schemas`,
      collectionSchema("contacts"),
      201
    );
    const record = await postJson<{ resource: { id: string; data: { name: string } }; operation: { operation: string } }>(
      `${baseUrl}/api/collections/contacts/records`,
      { id: "record_1", data: { name: "Takuma" } },
      201
    );
    const patched = await postJson<{ resource: { data: { name: string } }; operation: { operation: string } }>(
      `${baseUrl}/api/collections/contacts/records/record_1/patches`,
      { changes: { name: "Samurai" } }
    );
    const savedSchema = await getJson<{ id: string }>(`${baseUrl}/api/collections/contacts/schema`);
    const notes = await getJson<unknown[]>(`${baseUrl}/api/collections/contacts/notes`);
    const automation = await postJson<{ automationRun: { status: string }; operation: { actor_identity: string; channel: string; input_ref: { kind: string } }; auditRecord: unknown }>(
      `${baseUrl}/api/automation/memory-review/run`,
      {},
      201
    );

    expect(candidate.operation.operation).toBe("skill.candidate.create");
    expect(project.operation.operation).toBe("skill.project.save");
    expect(skills.map((skill) => skill.id)).toContain(candidate.resource.id);
    expect(skillDetail.markdown).toContain("調査メモ");
    expect(schema.operation.operation).toBe("collection.schema.save");
    expect(record.operation.operation).toBe("collection.record.create");
    expect(patched.operation.operation).toBe("collection.patch.apply");
    expect(patched.resource.data.name).toBe("Samurai");
    expect(savedSchema.id).toBe("contacts");
    expect(notes).toEqual([]);
    expect(automation.automationRun.status).toBe("completed");
    expect(automation.operation).toMatchObject({ actor_identity: "owner_scheduled", channel: "cron" });
    expect(automation.operation.input_ref.kind).toBe("automation_run");
  });

  it("serves wiki proposal lifecycle through runtime operations", async () => {
    const { baseUrl } = await startTestServer();
    const proposal = await postJson<{ resource: { id: string; state: string; file_path: string }; operation: { operation: string }; auditRecord: unknown }>(
      `${baseUrl}/api/wiki/proposals`,
      {
        title: "Provider保存設計",
        slug: "provider-storage-plan",
        content: "# Provider保存設計",
        tags: ["memory"]
      },
      201
    );
    const listed = await getJson<Array<{ id: string; state: string }>>(`${baseUrl}/api/wiki`);
    const detail = await getJson<{ content: string }>(`${baseUrl}/api/wiki/${proposal.resource.id}`);
    const accepted = await postJson<{ resource: { state: string }; operation: { operation: string } }>(
      `${baseUrl}/api/wiki/${proposal.resource.id}/accept`,
      {}
    );
    const patched = await patchJson<{ resource: { title: string }; operation: { operation: string } }>(`${baseUrl}/api/wiki/${proposal.resource.id}`, {
      title: "保存設計"
    });
    const reindex = await postJson<{ resource: { active: number; total: number }; operation: { operation: string } }>(`${baseUrl}/api/wiki/reindex`, {});
    const archived = await postJson<{ resource: { state: string }; operation: { operation: string } }>(
      `${baseUrl}/api/wiki/${proposal.resource.id}/archive`,
      {}
    );

    expect(proposal.operation.operation).toBe("wiki.proposal.create");
    expect(proposal.resource).toMatchObject({ state: "proposed", file_path: "wiki/pages/provider-storage-plan.md" });
    expect(listed.map((item) => item.id)).toContain(proposal.resource.id);
    expect(detail.content).toBe("# Provider保存設計");
    expect(accepted).toMatchObject({ resource: { state: "active" }, operation: { operation: "wiki.accept" } });
    expect(patched).toMatchObject({ resource: { title: "保存設計" }, operation: { operation: "wiki.patch" } });
    expect(reindex.resource).toEqual({ active: 1, total: 1 });
    expect(archived).toMatchObject({ resource: { state: "archived" }, operation: { operation: "wiki.archive" } });
  });

  it("rejects invalid skill and collection writes through API", async () => {
    const { baseUrl } = await startTestServer();

    const badSkill = await postJson<Record<string, unknown>>(`${baseUrl}/api/skills/candidates`, { title: "", description: "" }, 400);
    await postJson(`${baseUrl}/api/collections/schemas`, collectionSchema("contacts"), 201);
    const badRecord = await postJson<Record<string, unknown>>(
      `${baseUrl}/api/collections/contacts/records`,
      { id: "record_bad", data: { unknown: true } },
      409
    );

    expect(badSkill.error).toBe("title_and_description_required");
    expect(badRecord.error).toBe("conflict");
  });
});

async function startTestServer(provider: ProviderAdapter = new FakeProviderAdapter("fake/test", fakeProviderOutput)): Promise<{ baseUrl: string; server: ApiServer }> {
  const root = await mkdtemp(path.join(tmpdir(), "samurai-api-"));
  roots.push(root);
  const server = await createApiServer({ workspaceDataDir: root, provider });
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.httpServer.listen(0, "127.0.0.1", resolve);
  });
  const address = server.httpServer.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    server
  };
}

function fakeProviderOutput(input: Parameters<FakeProviderAdapter["generate"]>[0]): ProviderOutput {
  const intent = input.envelope.user_intent;
  const isJapanese = input.envelope.output_locale === "ja";
  const wantsArtifact = /作って|下書き|提案書|draft|memo|note/i.test(intent);
  const toolCalls: ProviderOutput["toolCalls"] = [];
  if (wantsArtifact) {
    toolCalls.push({
      name: "create_artifact",
      arguments: {
        title: isJapanese ? "作業メモ" : "Workspace note",
        content: isJapanese ? `# 作業メモ\n\n${intent}` : `# Workspace note\n\n${intent}`
      }
    });
  }
  if (/覚えて|今後|preference|remember/i.test(intent)) {
    toolCalls.push({ name: "remember_topic", arguments: {} });
  }
  if (/送信|メール|外部|公開|send|mail|publish|post/i.test(intent)) {
    toolCalls.push({ name: "request_external_send", arguments: {} });
  }
  if (/削除|消して|delete|remove/i.test(intent)) {
    toolCalls.push({ name: "request_delete", arguments: {} });
  }
  return {
    content: isJapanese ? "対応しました。" : "Done.",
    toolCalls
  };
}

class FailingProviderAdapter implements ProviderAdapter {
  readonly id = "fake" as const;
  readonly model = "fake/failing";

  async generate(): Promise<ProviderOutput> {
    throw new ProviderRequestError("provider_failed", "Bearer secret-token raw body", {
      reason: "auth_failed",
      status: 401,
      retryable: false,
      message: "Bearer [redacted]"
    });
  }
}

function setManagedEnv(key: string, value: string): void {
  rememberEnv(key);
  process.env[key] = value;
}

function deleteManagedEnv(key: string): void {
  rememberEnv(key);
  delete process.env[key];
}

function rememberEnv(key: string): void {
  if (!managedEnv.has(key)) {
    managedEnv.set(key, process.env[key]);
  }
}

function restoreManagedEnv(): void {
  for (const [key, value] of managedEnv) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  managedEnv.clear();
}

async function postJson<T>(url: string, body: unknown, expectedStatus = 200): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  const payload = (await response.json()) as T;
  expect(response.status).toBe(expectedStatus);
  return payload;
}

async function getJson<T>(url: string, expectedStatus = 200): Promise<T> {
  const response = await fetch(url);
  const payload = (await response.json()) as T;
  expect(response.status).toBe(expectedStatus);
  return payload;
}

async function patchJson<T>(url: string, body: unknown, expectedStatus = 200): Promise<T> {
  const response = await fetch(url, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  const payload = (await response.json()) as T;
  expect(response.status).toBe(expectedStatus);
  return payload;
}

function collectionSchema(id: string) {
  const labels = { ja: id, en: id, zh: id, ko: id, es: id, "pt-BR": id, fr: id, de: id };
  return {
    id,
    version: "1",
    labels,
    descriptions: labels,
    fields: [{ id: "name", type: "string" }],
    refs: [],
    embeds: [],
    derived_fields: [],
    triggers: [],
    actions: [],
    permissions: {}
  };
}
