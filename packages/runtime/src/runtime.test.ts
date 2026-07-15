import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PluginRuntimeRegistry } from "@samurai-agent/action-catalog";
import { AgentBackendRegistry, MockBackend, type AgentBackend } from "@samurai-agent/agent-backends";
import { createId, nowIso, type BackendEventRecord, type ExternalSendRecord, type GatewayBoundaryPolicy, type GatewayMcpConfigRecord, type GatewayPairingPolicyRecord, type GatewayRoutingPolicyRecord, type JsonValue, type MemoryFrontmatter, type OperationRecord, type RollbackPoint, type SkillFrontmatter } from "@samurai-agent/core-schemas";
import { WorkspaceStore } from "@samurai-agent/workspace-store";
import { AgentRuntime, FakeProviderAdapter, RuntimeRequestError, planSurfaceOperationDispatch, setExternalSendSmtpClientConnectionFactoryForTest, type ExternalAssistProvider, type ProviderInput, type ProviderOutput } from "./index";

const roots: string[] = [];

async function createRuntime() {
  const root = await mkdtemp(path.join(tmpdir(), "samurai-runtime-"));
  roots.push(root);
  const store = await WorkspaceStore.create({ rootDir: root });
  return {
    store,
    runtime: new AgentRuntime(store, undefined, new FakeProviderAdapter("fake/test", fakeProviderOutput))
  };
}

async function runCollectionManagePatchSchemaTool(input: {
  runtime: AgentRuntime;
  runId: string;
  token: string;
  toolCallId: string;
  collectionId: string;
  patches: JsonValue[];
  viewId?: string;
}) {
  return input.runtime.runBackendToolBridgeCall({
    runId: input.runId,
    token: input.token,
    toolName: "mcp__samurai__collection_manage",
    toolCallId: input.toolCallId,
    toolInput: {
      action: "patchSchema",
      collection_id: input.collectionId,
      patches: input.patches,
      ...(input.viewId ? { view_id: input.viewId } : {})
    }
  });
}

async function saveGenericTasksCollectionSchema(store: WorkspaceStore, overrides: Record<string, unknown> = {}) {
  return store.updateCollectionSchema({
    id: "tasks",
    version: "1",
    labels: { ja: "タスク", en: "Tasks" },
    descriptions: { ja: "通常のCollectionとして扱うタスク。" },
    fields: [
      { id: "title", type: "string", required: true },
      { id: "completed", type: "boolean" },
      { id: "notes", type: "text" },
      { id: "due_date", type: "date" }
    ],
    refs: [],
    embeds: [],
    derived_fields: [],
    triggers: [],
    actions: [],
    views: [{ id: "tasks_table", renderer: "collection_table", allow_delete: true }],
    permissions: { create: true, update: true, delete: true },
    ...overrides
  });
}

async function requestAndApproveExternalSend(
  runtime: AgentRuntime,
  store: WorkspaceStore,
  sendId: string
): Promise<ExternalSendRecord> {
  await dispatchExternalSend(runtime, { sendId, dryRun: false });
  const send = await store.getExternalSend(sendId);
  expect(send).toBeDefined();
  return send!;
}

let externalSendTestSequence = 0;
async function prepareExternalSend(runtime: AgentRuntime, input: { channel: string; target: Record<string, JsonValue>; title: string; body: string }) {
  externalSendTestSequence += 1;
  return (await runtime.runDomainCommand({ command_id: "external.send.prepare", idempotency_key: `external-prepare-${externalSendTestSequence}`, payload: input })).result as { resource: ExternalSendRecord; operation: OperationRecord };
}
async function dispatchExternalSend(runtime: AgentRuntime, input: { sendId: string; dryRun?: boolean }) {
  externalSendTestSequence += 1;
  return (await runtime.runDomainCommand({ command_id: "external.send.dispatch", idempotency_key: `external-dispatch-${externalSendTestSequence}`, payload: { send_id: input.sendId, dry_run: input.dryRun } })).result as { resource: ExternalSendRecord; operation: OperationRecord };
}

class FakeSmtpConnection {
  readonly commands: string[] = [];
  readonly data: string[] = [];
  closed = false;
  private readonly responses: Array<{ code: number; lines: string[] }>;

  constructor(responses: Array<{ code: number; lines: string[] }>) {
    this.responses = [...responses];
  }

  async readResponse(): Promise<{ code: number; lines: string[] }> {
    const response = this.responses.shift();
    if (!response) {
      throw new Error("smtp_response_missing");
    }
    return response;
  }

  async writeCommand(command: string): Promise<void> {
    this.commands.push(command);
  }

  async writeData(data: string): Promise<void> {
    this.data.push(data);
  }

  close(): void {
    this.closed = true;
  }
}

function fakeProviderOutput(input: Parameters<FakeProviderAdapter["generate"]>[0]): ProviderOutput {
  const intent = input.envelope.user_intent;
  const isJapanese = input.envelope.output_locale === "ja";
  const wantsMalformedArtifact = /malformed artifact/i.test(intent);
  const wantsArtifact = /作って|下書き|提案書|draft|memo|note/i.test(intent);
  const toolCalls: ProviderOutput["toolCalls"] = [];
  if (wantsMalformedArtifact) {
    toolCalls.push({
      name: "create_artifact",
      arguments: {}
    });
  } else if (wantsArtifact) {
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

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  setExternalSendSmtpClientConnectionFactoryForTest();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("agent runtime", () => {
  it("plans surface operation dispatch before execution", () => {
    const chatPlan = planSurfaceOperationDispatch({
      id: "surface_chat_plan",
      kind: "message.submit",
      session_id: "session_1",
      content: "hello"
    });
    const collectionPlan = planSurfaceOperationDispatch({
      id: "surface_collection_plan",
      kind: "collection.record.patch",
      collection_id: "contacts",
      record_id: "record_1",
      patch_id: "patch_1",
      changes: { name: "Samurai" }
    });
    const chartPlan = planSurfaceOperationDispatch({
      id: "surface_chart_plan",
      kind: "chart.request",
      session_id: "session_1",
      title: "Progress",
      query: "show progress",
      data_refs: ["collection/progress"]
    });

    expect(chatPlan).toMatchObject({
      dispatch_target: "host_chat",
      runtime_method: "runDomainCommand",
      result_kind: "chat_turn",
      requires_session: true,
      writes_workspace: true
    });
    expect(collectionPlan).toMatchObject({
      dispatch_target: "collection_engine",
      operation_name: "collection.patch.apply",
      result_kind: "collection_patch",
      render_kind: "collection_record",
      writes_workspace: true
    });
    expect(chartPlan).toMatchObject({
      dispatch_target: "artifact_pipeline",
      operation_name: "artifact.create",
      result_kind: "chart_request",
      render_kind: "chart",
      output_resource_kind: "chart"
    });
  });

  it("runs runtime API calls through Domain Commands", async () => {
    const { store, runtime } = await createRuntime();
    const result = await runtime.runDomainCommand({
      command_id: "chat.turn.run",
      idempotency_key: "runtime-api-chat",
      payload: {
        content: "Domain Commandから実行して",
        output_locale: "ja"
      }
    });
    const artifact = await runtime.runDomainCommand({
      command_id: "artifact.create",
      idempotency_key: "runtime-api-artifact",
      payload: {
        title: "Domain Command artifact",
        content: "Domain Command APIから作ったArtifact",
        output_locale: "ja"
      }
    });
    await store.close();

    const chat = result.result as Awaited<ReturnType<AgentRuntime["runChatTurn"]>>;
    expect(result.command.id).toBe("chat.turn.run");
    expect(result.input_source).toBe("runtime_api");
    expect(result.render_spec).toMatchObject({
      kind: "chat",
      props: {
        backend_status: "completed"
      }
    });
    expect(result.render_specs.map((spec) => spec.kind)).toEqual(["chat"]);
    expect(chat.backendRun.status).toBe("completed");
    expect(chat.messages.some((message) => message.role === "agent")).toBe(true);
    expect(artifact.command.id).toBe("artifact.create");
    expect(artifact.render_spec).toMatchObject({
      kind: "artifact",
      props: {
        title: "Domain Command artifact"
      }
    });
  });

  it("rejects unsupported Collection schema renderers through Runtime validation", async () => {
    const { store, runtime } = await createRuntime();

    await expect(runtime.runDomainCommand({
      command_id: "collection.schema.save",
      idempotency_key: "unsupported-collection-renderer",
      input_source: "runtime_api",
      payload: {
        id: "study_notes",
        version: "1",
        labels: { ja: "学習メモ", en: "Study notes" },
        descriptions: { ja: "学習メモ。", en: "Study notes." },
        fields: [{ id: "title", type: "string", label: "タイトル" }],
        refs: [],
        embeds: [],
        derived_fields: [],
        triggers: [],
        actions: [],
        views: [{ id: "study_notes_deck", renderer: "study_deck" }],
        permissions: {}
      }
    })).rejects.toThrow("collection_view_renderer_unsupported:study_deck");
    expect(await store.getCollectionSchema("study_notes")).toBeUndefined();
    await store.close();
  });

  it("does not persist backend event Collection cards for unsupported renderers", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-runtime-unsupported-presentation-renderer-"));
    roots.push(root);
    const store = await WorkspaceStore.create({ rootDir: root });
    const backend: AgentBackend = {
      id: "unsupported-presentation-renderer",
      kind: "codex",
      label: "Unsupported Presentation Renderer Fixture",
      async *runTurn() {
        yield {
          event_type: "tool_call_output",
          payload: {
            status: "completed",
            output: {
              status: "ready",
              kind: "collection_app",
              collection_id: "study_notes",
              view_id: "study_notes_deck",
              renderer: "study_deck",
              title: "Study notes",
              record_count: 0
            }
          }
        };
        yield {
          event_type: "run_completed",
          payload: { output_summary: "done" }
        };
      }
    };
    const runtime = new AgentRuntime(store, undefined, undefined, new AgentBackendRegistry([backend]));
    const session = await runtime.createSession();

    const result = await runtime.runSurfaceOperation({
      id: "surface_unsupported_presentation_renderer",
      kind: "message.submit",
      session_id: session.id,
      backend_id: "unsupported-presentation-renderer",
      content: "学習カードを開いて",
      output_locale: "ja",
      renderer_capabilities: {
        protocol_version: "1",
        supported_kinds: ["chat", "custom_view", "collection"],
        custom_view_renderers: [{ renderer: "collection_table", versions: ["1"] }]
      }
    });
    const agentMessage = result.result.messages.find((message) => message.role === "agent");
    const savedPresentations = await store.listMessagePresentations({ sessionId: session.id, messageId: agentMessage?.id });
    await store.close();

    expect(result.result.messagePresentations).toEqual([]);
    expect(savedPresentations).toEqual([]);
  });

  it("returns render specs for workspace resource Domain Commands", async () => {
    const { store, runtime } = await createRuntime();
    const wiki = await runtime.runDomainCommand({
      command_id: "wiki.proposal.create",
      idempotency_key: "render-wiki",
      payload: {
        title: "Provider storage plan",
        content: "Store provider hints as proposals until accepted.",
        content_locale: "en"
      }
    });
    const skill = await runtime.runDomainCommand({
      command_id: "skill.candidate.create",
      idempotency_key: "render-skill",
      payload: {
        title: "調査メモ整理",
        description: "調査メモを再利用できる形に整える",
        content: "# Skill\n\n- 調査結果を要約する"
      }
    });
    const schema = await runtime.runDomainCommand({
      command_id: "collection.schema.save",
      idempotency_key: "render-schema",
      payload: collectionSchema("contacts")
    });
    const record = await runtime.runDomainCommand({
      command_id: "collection.record.create",
      idempotency_key: "render-record",
      payload: {
        collection_id: "contacts",
        record_id: "record_1",
        data: { name: "Takuma" }
      }
    });
    await store.close();

    expect(wiki.render_spec).toMatchObject({
      kind: "knowledge_wiki",
      props: {
        active_only: false,
        state: "proposed"
      }
    });
    expect(skill.render_spec).toMatchObject({
      kind: "skill",
      props: {
        disclosure_level: "catalog",
        state: "candidate"
      }
    });
    expect(schema.render_spec).toMatchObject({
      kind: "collection",
      props: {
        collection_id: "contacts",
        schema_id: "contacts"
      }
    });
    expect(record.render_spec).toMatchObject({
      kind: "collection_record",
      props: {
        collection_id: "contacts",
        record_id: "record_1",
        data: { name: "Takuma" }
      }
    });
    expect([wiki, skill, schema, record].every((result) => result.render_specs.length === 1)).toBe(true);
  });

  it("does not create a dedicated task_list app before backend dispatch", async () => {
    const { store, runtime } = await createRuntime();
    const session = await runtime.createSession();

    const result = await runtime.runSurfaceOperation({
      id: "surface_task_app",
      kind: "message.submit",
      session_id: session.id,
      content: "タスク管理アプリを作って",
      output_locale: "ja",
      renderer_capabilities: {
        protocol_version: "1",
        supported_kinds: ["chat", "custom_view", "collection"],
        custom_view_renderers: [{ renderer: "collection_table", versions: ["1"] }]
      }
    });
    const normal = await runtime.runSurfaceOperation({
      id: "surface_normal_chat",
      kind: "message.submit",
      session_id: session.id,
      content: "こんにちは",
      output_locale: "ja"
    });
    const schema = await store.getCollectionSchema("tasks");
    await store.close();

    expect(schema).toBeUndefined();
    expect(result.render_specs?.map((spec) => spec.kind)).toEqual(["chat"]);
    expect(normal.render_specs?.map((spec) => spec.kind)).toEqual(["chat"]);
  });

  it("creates generic Collection table App Canvas surfaces only after backend schema save", async () => {
    let runtime: AgentRuntime;
    const bridgeBackend: AgentBackend = {
      id: "collection-schema-bridge",
      kind: "codex",
      label: "Collection Schema Bridge Fixture",
      async *runTurn(input) {
        expect(input.expected_outputs).toContain("collection_schema");
        expect(input.tool_bridge?.enabled).toBe(true);
        const schemaTool = input.tool_bridge?.tools.find((tool) => tool.name === "samurai.collection.schema.save");
        expect(input.tool_bridge?.tools).toContainEqual(expect.objectContaining({ name: "samurai.skill.view", provider_tool_name: "mcp__samurai__skill_view" }));
        expect(schemaTool?.description).toContain("collection_gallery");
        expect(schemaTool?.description).toContain("calendar_view");
        expect(schemaTool?.description).toContain("collection_kanban");
        expect(schemaTool?.description).not.toContain("collection_dashboard");
        expect(JSON.stringify(schemaTool?.input_schema.properties?.views ?? {})).not.toContain("collection_dashboard");
        await runtime.runBackendToolBridgeCall({
          runId: input.run_id,
          token: input.tool_bridge?.token ?? "",
          toolName: "mcp__samurai__collection_schema_save",
          toolCallId: "schema_tool_1",
          toolInput: {
            id: "movies",
            version: "1",
            labels: { ja: "映画ログ", en: "Movies" },
            descriptions: { ja: "映画を記録する個人用アプリ。", en: "A personal movie log." },
            fields: [
              { id: "title", type: "string", label: "タイトル", required: true },
              { id: "status", type: "enum", label: "状態", enum_values: ["観たい", "視聴中", "観た"] },
              { id: "rating", type: "number", label: "評価" },
              { id: "watched_at", type: "date", label: "鑑賞日" },
              { id: "notes", type: "text", label: "メモ" }
            ],
            refs: [],
            embeds: [],
            derived_fields: [],
            triggers: [],
            actions: [],
            views: [{
              id: "movies_table",
              renderer: "collection_table",
              renderer_candidates: ["collection_table", "collection_gallery", "calendar_view", "collection_kanban"],
              density: "comfortable",
              allow_delete: true,
              editable_fields: ["title", "status", "rating", "watched_at", "notes"]
            }],
            permissions: { create: true, update: true, delete: true }
          }
        });
        yield {
          event_type: "text_delta",
          payload: { text: "映画ログアプリを作成しました。" }
        };
        yield {
          event_type: "run_completed",
          payload: { output_summary: "done" }
        };
      }
    };
    const root = await mkdtemp(path.join(tmpdir(), "samurai-runtime-collection-schema-"));
    roots.push(root);
    const store = await WorkspaceStore.create({ rootDir: root });
    runtime = new AgentRuntime(store, undefined, undefined, new AgentBackendRegistry([bridgeBackend]));
    const session = await runtime.createSession();
    const capabilities = {
      protocol_version: "1",
      supported_kinds: ["chat", "custom_view", "collection", "collection_record"],
      custom_view_renderers: [{ renderer: "collection_table", versions: ["1"] }]
    };

    const created = await runtime.runSurfaceOperation({
      id: "surface_movies_app",
      kind: "message.submit",
      session_id: session.id,
      backend_id: "collection-schema-bridge",
      content: "映画ログアプリ作って",
      output_locale: "ja",
      renderer_capabilities: capabilities
    });
    const schema = await store.getCollectionSchema("movies");
    const record = await runtime.runSurfaceOperation({
      id: "surface_movie_create",
      kind: "collection.record.create",
      collection_id: "movies",
      record_id: "movie_1",
      data: { title: "七人の侍", status: "観た", rating: 5, watched_at: "2026-07-03", notes: "再視聴" },
      renderer_capabilities: capabilities
    });
    const patched = await runtime.runSurfaceOperation({
      id: "surface_movie_patch",
      kind: "collection.record.patch",
      collection_id: "movies",
      record_id: "movie_1",
      patch_id: "movie_patch_1",
      expected_version: 1,
      changes: { rating: 4 },
      renderer_capabilities: capabilities
    });
    const view = await runtime.runSurfaceOperation({
      id: "surface_movies_view",
      kind: "collection.view.present",
      collection_id: "movies",
      view_id: "movies_table",
      renderer_capabilities: capabilities
    });
    const deleted = await runtime.runSurfaceOperation({
      id: "surface_movie_delete",
      kind: "collection.record.delete",
      collection_id: "movies",
      record_id: "movie_1",
      view_id: "movies_table",
      renderer_capabilities: capabilities
    });
    const sessions = await store.listSessions();
    const savedPresentations = await store.listMessagePresentations({ sessionId: session.id, messageId: created.result.messages[1]?.id });

    expect(schema).toMatchObject({
      id: "movies",
      views: [expect.objectContaining({ renderer: "collection_table" })]
    });
    expect(created.render_specs?.map((spec) => spec.kind)).toEqual(["chat", "custom_view"]);
    expect(created.result.backendRun).toMatchObject({
      backend_id: "collection-schema-bridge",
      status: "completed"
    });
    expect(created.result.operations).toEqual([
      expect.objectContaining({
        operation: "collection.schema.save",
        session_id: session.id
      })
    ]);
    expect(created.result.messages.map((message) => message.role)).toEqual(["user", "agent"]);
    expect(created.result.messagePresentations).toEqual([
      expect.objectContaining({
        session_id: session.id,
        message_id: created.result.messages[1]?.id,
        kind: "collection_app",
        title: "映画ログ",
        subtitle: "movies ・ 0件",
        collection_id: "movies",
        view_id: "movies_table",
        renderer: "collection_table",
        view_state: expect.objectContaining({
          collection_id: "movies",
          view_id: "movies_table",
          renderer: "collection_table",
          record_count: 0
        })
      })
    ]);
    expect(savedPresentations).toEqual(created.result.messagePresentations);
    expect(sessions.map((item) => item.title)).not.toContain("Workspace operations");
    expect(created.result.toolRuns).toContainEqual(expect.objectContaining({
      provider_tool_name: "samurai.collection.schema.save",
      action_id: "collection.schema.save",
      status: "completed"
    }));
    expect(created.render_specs?.[1]).toMatchObject({
      kind: "custom_view",
      props: {
        renderer: "collection_table",
        data: expect.objectContaining({
          collection_id: "movies",
          record_ids: []
        })
      },
      fallback: expect.objectContaining({
        kind: "collection"
      })
    });
    expect(record.render_spec.kind).toBe("collection_record");
    expect(patched.render_spec.props.data).toMatchObject({ rating: 4 });
    expect(view.render_spec).toMatchObject({
      kind: "custom_view",
      props: {
        renderer: "collection_table",
        data: expect.objectContaining({
          collection_id: "movies",
          record_ids: ["movie_1"],
          records: [expect.objectContaining({ id: "movie_1", rating: 4 })]
        })
      }
    });
    expect(deleted.render_spec.props.data).toMatchObject({
      collection_id: "movies",
      record_ids: []
    });
    await store.close();
  });

  it("creates initial Collection records through the backend bridge instead of direct files", async () => {
    let runtime: AgentRuntime;
    const bridgeBackend: AgentBackend = {
      id: "collection-record-bridge",
      kind: "codex",
      label: "Collection Record Bridge Fixture",
      async *runTurn(input) {
        expect(input.expected_outputs).toContain("collection_schema");
        expect(input.tool_bridge?.tools.map((tool) => tool.name)).toContain("samurai.collection.record.create");
        await runtime.runBackendToolBridgeCall({
          runId: input.run_id,
          token: input.tool_bridge?.token ?? "",
          toolName: "mcp__samurai__collection_schema_save",
          toolCallId: "schema_tool_record_bridge",
          toolInput: {
            id: "movies",
            version: "1",
            labels: { ja: "映画ログ", en: "Movies" },
            descriptions: { ja: "映画を記録する個人用Collection。", en: "A personal movie log." },
            fields: [
              { id: "title", type: "string", label: "タイトル", required: true },
              { id: "status", type: "enum", label: "状態", enum_values: ["観たい", "視聴中", "観た"] },
              { id: "rating", type: "number", label: "評価" },
              { id: "watched_at", type: "date", label: "鑑賞日" }
            ],
            refs: [],
            embeds: [],
            derived_fields: [],
            triggers: [],
            actions: [],
            views: [{ id: "movies_table", renderer: "collection_table", editable_fields: ["title", "status", "rating", "watched_at"] }],
            permissions: { create: true, update: true, delete: true }
          }
        });
        await runtime.runBackendToolBridgeCall({
          runId: input.run_id,
          token: input.tool_bridge?.token ?? "",
          toolName: "mcp__samurai__collection_record_create",
          toolCallId: "record_tool_record_bridge",
          toolInput: {
            collection_id: "movies",
            record_id: "movie_seed",
            data: { title: "羅生門", status: "観た", rating: 5, watched_at: "2026-07-05" }
          }
        });
        yield { event_type: "text_delta", payload: { text: "映画ログを作成しました。" } };
        yield { event_type: "run_completed", payload: { output_summary: "done" } };
      }
    };
    const root = await mkdtemp(path.join(tmpdir(), "samurai-runtime-collection-record-bridge-"));
    roots.push(root);
    const store = await WorkspaceStore.create({ rootDir: root });
    runtime = new AgentRuntime(store, undefined, undefined, new AgentBackendRegistry([bridgeBackend]));
    const session = await runtime.createSession();

    const result = await runtime.runSurfaceOperation({
      id: "surface_movies_record_bridge",
      kind: "message.submit",
      session_id: session.id,
      backend_id: "collection-record-bridge",
      content: "映画ログを作って。最初のレコードに羅生門を入れて。",
      output_locale: "ja",
      renderer_capabilities: {
        protocol_version: "1",
        supported_kinds: ["chat", "custom_view", "collection"],
        custom_view_renderers: [{ renderer: "collection_table", versions: ["1"] }]
      }
    });
    const records = await store.listCollectionRecords("movies");
    await store.close();

    expect(records.map((record) => record.id)).toEqual(["movie_seed"]);
    expect(result.result.operations.map((operation) => operation.operation)).toEqual(expect.arrayContaining([
      "collection.schema.save",
      "collection.record.create"
    ]));
    expect(result.result.toolRuns).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider_tool_name: "samurai.collection.schema.save", status: "completed" }),
      expect.objectContaining({ provider_tool_name: "samurai.collection.record.create", status: "completed" })
    ]));
    expect(result.render_specs?.[1]).toMatchObject({
      kind: "custom_view",
      props: {
        data: expect.objectContaining({
          collection_id: "movies",
          record_ids: ["movie_seed"]
        })
      }
    });
  });

  it("rejects direct Collection schema file writes as a backend success path", async () => {
    const directWriteBackend: AgentBackend = {
      id: "collection-direct-file-backend",
      kind: "codex",
      label: "Collection Direct File Backend Fixture",
      async *runTurn(input) {
        const collectionDir = path.join(input.workspace_root, "collections", "direct_movies");
        await mkdir(collectionDir, { recursive: true });
        await writeFile(path.join(collectionDir, "schema.json"), JSON.stringify({
          id: "direct_movies",
          version: "1",
          labels: { ja: "直書き映画ログ" },
          descriptions: { ja: "Runtime toolを通らない直書きschema。" },
          fields: [{ id: "title", type: "string", label: "タイトル", required: true }],
          refs: [],
          embeds: [],
          derived_fields: [],
          triggers: [],
          actions: [],
          views: [{ id: "direct_movies_table", renderer: "collection_table" }],
          permissions: { create: true, update: true, delete: true }
        }, null, 2));
        yield { event_type: "text_delta", payload: { text: "映画ログを作成しました。" } };
        yield { event_type: "run_completed", payload: { output_summary: "done" } };
      }
    };
    const root = await mkdtemp(path.join(tmpdir(), "samurai-runtime-direct-collection-"));
    roots.push(root);
    const store = await WorkspaceStore.create({ rootDir: root });
    const runtime = new AgentRuntime(store, undefined, undefined, new AgentBackendRegistry([directWriteBackend]));
    const session = await runtime.createSession();

    const result = await runtime.runSurfaceOperation({
      id: "surface_direct_collection_file",
      kind: "message.submit",
      session_id: session.id,
      backend_id: "collection-direct-file-backend",
      content: "映画ログアプリ作って",
      output_locale: "ja"
    });
    const runs = await store.listBackendRuns(session.id);
    await store.close();

    expect(runs[0]).toMatchObject({
      backend_id: "collection-direct-file-backend",
      status: "completed"
    });
    expect(result.render_specs?.some((spec) =>
      spec.kind === "custom_view" && spec.props.renderer === "collection_table"
    )).toBe(true);
  });

  it("keeps the movie-log Collection flow reusable across card, records, natural open, edits, and view switch", async () => {
    let runtime: AgentRuntime;
    let backendRuns = 0;
    const bridgeBackend: AgentBackend = {
      id: "collection-movie-flow-bridge",
      kind: "codex",
      label: "Collection Movie Flow Bridge Fixture",
      async *runTurn(input) {
        backendRuns += 1;
        if (input.envelope.user_intent.includes("作って")) {
          expect(input.expected_outputs).toContain("collection_schema");
          await runtime.runBackendToolBridgeCall({
            runId: input.run_id,
            token: input.tool_bridge?.token ?? "",
            toolName: "mcp__samurai__collection_schema_save",
            toolCallId: "schema_tool_movie_flow",
            toolInput: {
              id: "movies",
              version: "1",
              labels: { ja: "映画ログ", en: "Movies" },
              descriptions: { ja: "映画を記録する個人用アプリ。", en: "A personal movie log." },
              fields: [
                { id: "title", type: "string", label: "タイトル", required: true },
                { id: "status", type: "enum", label: "状態", enum_values: ["観たい", "視聴中", "観た"] },
                { id: "rating", type: "number", label: "評価" },
                { id: "watched_at", type: "date", label: "鑑賞日" },
                { id: "notes", type: "text", label: "メモ" }
              ],
              refs: [],
              embeds: [],
              derived_fields: [],
              triggers: [],
              actions: [],
              views: [{
                id: "movies_table",
                renderer: "collection_table",
                editable_fields: ["title", "status", "rating", "watched_at", "notes"]
              }],
              permissions: { create: true, update: true, delete: true }
            }
          });
        }
        yield {
          event_type: "text_delta",
          payload: { text: "映画ログを作成しました。" }
        };
        yield {
          event_type: "run_completed",
          payload: { output_summary: "done" }
        };
      }
    };
    const root = await mkdtemp(path.join(tmpdir(), "samurai-runtime-movie-flow-"));
    roots.push(root);
    const store = await WorkspaceStore.create({ rootDir: root });
    runtime = new AgentRuntime(store, undefined, undefined, new AgentBackendRegistry([bridgeBackend]));
    const session = await runtime.createSession();
    const capabilities = {
      protocol_version: "1",
      supported_kinds: ["chat", "custom_view", "collection", "collection_record"],
      custom_view_renderers: [
        { renderer: "collection_table", versions: ["1"] },
        { renderer: "collection_gallery", versions: ["1"] },
        { renderer: "calendar_view", versions: ["1"] },
        { renderer: "collection_kanban", versions: ["1"] }
      ]
    };

    const created = await runtime.runSurfaceOperation({
      id: "surface_movie_flow_create",
      kind: "message.submit",
      session_id: session.id,
      backend_id: "collection-movie-flow-bridge",
      content: "映画ログ作って",
      output_locale: "ja",
      renderer_capabilities: capabilities
    });
    const createdPresentation = created.result.messagePresentations[0]!;
    const record = await runtime.runSurfaceOperation({
      id: "surface_movie_flow_record_create",
      kind: "collection.record.create",
      collection_id: "movies",
      record_id: "movie_1",
      data: { title: "七人の侍", status: "観た", rating: 5, watched_at: "2026-07-03", notes: "再視聴" },
      renderer_capabilities: capabilities
    });
    const opened = await runtime.runSurfaceOperation({
      id: "surface_movie_flow_open",
      kind: "collection.view.present",
      collection_id: "movies",
      view_id: "movies_table",
      renderer_capabilities: capabilities
    });
    const calendar = await runtime.runSurfaceOperation({
      id: "surface_movie_flow_calendar",
      kind: "collection.view.present",
      collection_id: "movies",
      view_id: "movies_calendar",
      renderer_capabilities: capabilities
    });
    const kanban = await runtime.runSurfaceOperation({
      id: "surface_movie_flow_kanban",
      kind: "collection.view.present",
      collection_id: "movies",
      view_id: "movies_kanban",
      renderer_capabilities: capabilities
    });
    const kanbanPatch = await runtime.runSurfaceOperation({
      id: "surface_movie_flow_kanban_patch",
      kind: "collection.record.patch",
      collection_id: "movies",
      record_id: "movie_1",
      patch_id: "movie_kanban_patch_1",
      expected_version: 1,
      changes: { status: "視聴中" },
      view_id: "movies_kanban",
      renderer_capabilities: capabilities
    });
    const reopenedAfterEdit = await runtime.runSurfaceOperation({
      id: "surface_movie_flow_reopen_after_edit",
      kind: "collection.view.present",
      collection_id: "movies",
      view_id: "movies_table",
      renderer_capabilities: capabilities
    });
    const refreshedKanban = await runtime.runSurfaceOperation({
      id: "surface_movie_flow_kanban_refresh",
      kind: "collection.view.present",
      collection_id: "movies",
      view_id: "movies_kanban",
      renderer_capabilities: capabilities
    });
    const switchedCard = await runtime.runSurfaceOperation({
      id: "surface_movie_flow_card_state",
      kind: "message.presentation.update",
      presentation_id: createdPresentation.id,
      view_state: {
        collection_id: "movies",
        view_id: "movies_calendar",
        renderer: "calendar_view",
        record_count: 1
      },
      renderer_capabilities: capabilities
    });
    const reopenedCard = await runtime.runSurfaceOperation({
      id: "surface_movie_flow_card_reopen",
      kind: "collection.view.present",
      collection_id: switchedCard.result.collection_id,
      view_id: switchedCard.result.view_id,
      renderer_capabilities: capabilities
    });
    const createdAgentMessageId = created.result.messages[1]?.id;
    const savedCreatedCard = (await store.listMessagePresentations({
      sessionId: session.id,
      messageId: createdAgentMessageId
    })).find((presentation) => presentation.id === createdPresentation.id);
    const sessionId = session.id;
    await store.close();
    const reloadedStore = await WorkspaceStore.create({ rootDir: root });
    const reloadedCreatedCard = (await reloadedStore.listMessagePresentations({
      sessionId,
      messageId: createdAgentMessageId
    })).find((presentation) => presentation.id === createdPresentation.id);
    await reloadedStore.close();

    expect(backendRuns).toBe(1);
    expect(createdPresentation).toMatchObject({
      collection_id: "movies",
      view_id: "movies_table",
      renderer: "collection_table",
      view_state: expect.objectContaining({ record_count: 0 })
    });
    expect(record.render_spec).toMatchObject({
      kind: "collection_record",
      props: { record_id: "movie_1", data: expect.objectContaining({ title: "七人の侍", rating: 5 }) }
    });
    expect(opened.result).toMatchObject({
      collection_id: "movies",
      view_id: "movies_table",
      record_count: 1
    });
    expect(opened.render_spec).toMatchObject({
      kind: "custom_view",
      props: {
        data: expect.objectContaining({
          record_ids: ["movie_1"],
          records: [expect.objectContaining({ id: "movie_1", title: "七人の侍" })]
        })
      }
    });
    expect(calendar.result).toMatchObject({
      collection_id: "movies",
      view_id: "movies_calendar",
      record_count: 1
    });
    expect(calendar.render_spec.props).toMatchObject({
      renderer: "calendar_view",
      view_id: "movies_calendar"
    });
    expect(kanban.result).toMatchObject({
      collection_id: "movies",
      view_id: "movies_kanban",
      record_count: 1
    });
    expect(kanban.render_spec.props).toMatchObject({
      renderer: "collection_kanban",
      view_id: "movies_kanban"
    });
    expect(kanbanPatch.render_spec).toMatchObject({
      kind: "collection_record",
      props: {
        record_id: "movie_1",
        data: expect.objectContaining({ status: "視聴中" })
      }
    });
    expect(reopenedAfterEdit.render_spec).toMatchObject({
      kind: "custom_view",
      props: {
        data: expect.objectContaining({
          records: [expect.objectContaining({ id: "movie_1", status: "視聴中" })]
        })
      }
    });
    expect(refreshedKanban.render_spec).toMatchObject({
      kind: "custom_view",
      props: {
        renderer: "collection_kanban",
        view_id: "movies_kanban",
        data: expect.objectContaining({
          records: [expect.objectContaining({ id: "movie_1", status: "視聴中" })],
          view_state: expect.objectContaining({
            renderer: "collection_kanban",
            group: "status"
          })
        })
      }
    });
    expect(switchedCard.result).toMatchObject({
      id: createdPresentation.id,
      view_id: "movies_calendar",
      renderer: "calendar_view",
      view_state: expect.objectContaining({ record_count: 1 })
    });
    expect(savedCreatedCard).toMatchObject({
      view_id: "movies_calendar",
      renderer: "calendar_view",
      view_state: expect.objectContaining({ record_count: 1 })
    });
    expect(reloadedCreatedCard).toMatchObject({
      collection_id: "movies",
      view_id: "movies_calendar",
      renderer: "calendar_view",
      view_state: expect.objectContaining({
        collection_id: "movies",
        view_id: "movies_calendar",
        renderer: "calendar_view",
        record_count: 1
      })
    });
    expect(reopenedCard.render_spec).toMatchObject({
      kind: "custom_view",
      props: {
        renderer: "calendar_view",
        view_id: "movies_calendar",
        data: expect.objectContaining({
          records: [expect.objectContaining({ id: "movie_1", title: "七人の侍" })]
        })
      }
    });
  });

  it("presents existing Collection apps from natural language without recreating schemas", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-runtime-collection-present-"));
    roots.push(root);
    const store = await WorkspaceStore.create({ rootDir: root });
    await store.updateCollectionSchema({
      id: "movies",
      version: "1",
      labels: { ja: "映画ログ", en: "Movies" },
      descriptions: { ja: "映画を記録する個人用アプリ。", en: "A personal movie log." },
      fields: [
        { id: "title", type: "string", label: "タイトル", required: true },
        { id: "rating", type: "number", label: "評価" }
      ],
      refs: [],
      embeds: [],
      derived_fields: [],
      triggers: [],
      actions: [],
      views: [{
        id: "movies_table",
        renderer: "collection_table",
        density: "comfortable",
        allow_delete: true,
        editable_fields: ["title", "rating"]
      }],
      permissions: { create: true, update: true, delete: true }
    });
    let backendRuns = 0;
    const backend: AgentBackend = {
      id: "collection-open-unneeded",
      kind: "codex",
      label: "Unused backend fixture",
      async *runTurn() {
        backendRuns += 1;
        yield {
          event_type: "run_completed",
          payload: { output_summary: "unexpected" }
        };
      }
    };
    const runtime = new AgentRuntime(store, undefined, undefined, new AgentBackendRegistry([backend]));
    const session = await runtime.createSession();
    const capabilities = {
      protocol_version: "1",
      supported_kinds: ["chat", "custom_view", "collection"],
      custom_view_renderers: [{ renderer: "collection_table", versions: ["1"] }]
    };

    const opened = await runtime.runSurfaceOperation({
      id: "surface_movies_open",
      kind: "message.submit",
      session_id: session.id,
      backend_id: "collection-open-unneeded",
      content: "映画ログを開いて",
      output_locale: "ja",
      renderer_capabilities: capabilities
    });
    const schemas = await store.listCollectionSchemas();
    const savedPresentations = await store.listMessagePresentations({ sessionId: session.id, messageId: opened.result.messages[1]?.id });
    const runs = await store.listBackendRuns(session.id);
    await store.close();

    expect(schemas.map((schema) => schema.id)).toEqual(["movies"]);
    expect(backendRuns).toBe(1);
    expect(runs[0]).toMatchObject({
      backend_id: "collection-open-unneeded",
      status: "completed"
    });
    expect(opened.render_specs?.map((spec) => spec.kind)).toEqual(["chat"]);
    expect(opened.result.operations).toEqual([]);
    expect(opened.result.messagePresentations).toEqual([]);
    expect(savedPresentations).toEqual([]);
  });

  it("presents existing Collections from localized labels and descriptions without exact title matches", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-runtime-collection-present-localized-"));
    roots.push(root);
    const store = await WorkspaceStore.create({ rootDir: root });
    await store.updateCollectionSchema({
      id: "watchlog",
      version: "1",
      labels: { ja: "鑑賞記録", en: "Movie tracker", es: "Películas" },
      descriptions: {
        ja: "映画を記録する個人用Collection。",
        en: "A personal place to track watched movies.",
        es: "Películas vistas y pendientes."
      },
      fields: [
        { id: "title", type: "string", label: "タイトル", required: true },
        { id: "rating", type: "number", label: "評価" }
      ],
      refs: [],
      embeds: [],
      derived_fields: [],
      triggers: [],
      actions: [],
      views: [{
        id: "watchlog_table",
        renderer: "collection_table",
        density: "comfortable",
        editable_fields: ["title", "rating"]
      }],
      permissions: { create: true, update: true, delete: true }
    });
    let backendRuns = 0;
    const backend: AgentBackend = {
      id: "collection-open-localized-unneeded",
      kind: "codex",
      label: "Unused localized collection open fixture",
      async *runTurn() {
        backendRuns += 1;
        yield {
          event_type: "run_completed",
          payload: { output_summary: "unexpected" }
        };
      }
    };
    const runtime = new AgentRuntime(store, undefined, undefined, new AgentBackendRegistry([backend]));
    const session = await runtime.createSession();
    const capabilities = {
      protocol_version: "1",
      supported_kinds: ["chat", "custom_view", "collection"],
      custom_view_renderers: [{ renderer: "collection_table", versions: ["1"] }]
    };

    const openedJapanese = await runtime.runSurfaceOperation({
      id: "surface_watchlog_open_japanese_phrase",
      kind: "message.submit",
      session_id: session.id,
      backend_id: "collection-open-localized-unneeded",
      content: "観た映画一覧を出して",
      output_locale: "ja",
      renderer_capabilities: capabilities
    });
    const openedEnglish = await runtime.runSurfaceOperation({
      id: "surface_watchlog_open_english_phrase",
      kind: "message.submit",
      session_id: session.id,
      backend_id: "collection-open-localized-unneeded",
      content: "show my movie list",
      output_locale: "en",
      renderer_capabilities: capabilities
    });
    const openedEnglishApp = await runtime.runSurfaceOperation({
      id: "surface_watchlog_open_english_app_phrase",
      kind: "message.submit",
      session_id: session.id,
      backend_id: "collection-open-localized-unneeded",
      content: "open movie app",
      output_locale: "en",
      renderer_capabilities: capabilities
    });
    await store.close();

    expect(backendRuns).toBe(3);
    for (const opened of [openedJapanese, openedEnglish, openedEnglishApp]) {
      expect(opened.render_specs?.map((spec) => spec.kind)).toEqual(["chat"]);
      expect(opened.result.messagePresentations).toEqual([]);
    }
  });

  it("presents Japanese-only Collections from seed-locale multilingual aliases", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-runtime-collection-present-aliases-"));
    roots.push(root);
    const store = await WorkspaceStore.create({ rootDir: root });
    await store.updateCollectionSchema({
      id: "watchlog_japanese",
      version: "1",
      labels: { ja: "映画ログ" },
      descriptions: { ja: "観た映画と評価を記録するCollection。" },
      fields: [
        { id: "title", type: "string", label: "タイトル", required: true },
        { id: "rating", type: "number", label: "評価" }
      ],
      refs: [],
      embeds: [],
      derived_fields: [],
      triggers: [],
      actions: [],
      views: [{
        id: "watchlog_japanese_table",
        renderer: "collection_table",
        density: "comfortable",
        editable_fields: ["title", "rating"]
      }],
      permissions: { create: true, update: true, delete: true }
    });
    let backendRuns = 0;
    const backend: AgentBackend = {
      id: "collection-open-aliases-unneeded",
      kind: "codex",
      label: "Unused multilingual alias collection open fixture",
      async *runTurn() {
        backendRuns += 1;
        yield {
          event_type: "run_completed",
          payload: { output_summary: "unexpected" }
        };
      }
    };
    const runtime = new AgentRuntime(store, undefined, undefined, new AgentBackendRegistry([backend]));
    const session = await runtime.createSession();
    const capabilities = {
      protocol_version: "1",
      supported_kinds: ["chat", "custom_view", "collection"],
      custom_view_renderers: [{ renderer: "collection_table", versions: ["1"] }]
    };

    const openedEnglish = await runtime.runSurfaceOperation({
      id: "surface_watchlog_open_alias_english",
      kind: "message.submit",
      session_id: session.id,
      backend_id: "collection-open-aliases-unneeded",
      content: "show my movie list",
      output_locale: "en",
      renderer_capabilities: capabilities
    });
    const openedSpanish = await runtime.runSurfaceOperation({
      id: "surface_watchlog_open_alias_spanish",
      kind: "message.submit",
      session_id: session.id,
      backend_id: "collection-open-aliases-unneeded",
      content: "mostrar películas lista",
      output_locale: "es",
      renderer_capabilities: capabilities
    });
    await store.close();

    expect(backendRuns).toBe(2);
    for (const opened of [openedEnglish, openedSpanish]) {
      expect(opened.render_specs?.map((spec) => spec.kind)).toEqual(["chat"]);
      expect(opened.result.messagePresentations).toEqual([]);
    }
  });

  it("asks the user to choose when a natural-language Collection open request has multiple matches", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-runtime-collection-present-ambiguous-"));
    roots.push(root);
    const store = await WorkspaceStore.create({ rootDir: root });
    await store.updateCollectionSchema({
      id: "movies",
      version: "1",
      labels: { ja: "映画ログ", en: "Movies" },
      descriptions: { ja: "映画を記録する個人用アプリ。", en: "A personal movie log." },
      fields: [{ id: "title", type: "string", label: "タイトル", required: true }],
      refs: [],
      embeds: [],
      derived_fields: [],
      triggers: [],
      actions: [],
      views: [{ id: "movies_table", renderer: "collection_table", editable_fields: ["title"] }],
      permissions: { create: true, update: true, delete: true }
    });
    await store.updateCollectionSchema({
      id: "movie_notes",
      version: "1",
      labels: { ja: "映画アプリ", en: "Movie app" },
      descriptions: { ja: "映画ログに紐づくメモ。", en: "Notes for movie logs." },
      fields: [{ id: "memo", type: "text", label: "メモ" }],
      refs: [],
      embeds: [],
      derived_fields: [],
      triggers: [],
      actions: [],
      views: [{ id: "movie_notes_table", renderer: "collection_table", editable_fields: ["memo"] }],
      permissions: { create: true, update: true, delete: true }
    });
    let backendRuns = 0;
    const backend: AgentBackend = {
      id: "collection-open-ambiguous-unneeded",
      kind: "codex",
      label: "Unused ambiguous collection open fixture",
      async *runTurn() {
        backendRuns += 1;
        yield {
          event_type: "run_completed",
          payload: { output_summary: "unexpected" }
        };
      }
    };
    const runtime = new AgentRuntime(store, undefined, undefined, new AgentBackendRegistry([backend]));
    const session = await runtime.createSession();

    const opened = await runtime.runSurfaceOperation({
      id: "surface_movies_open_ambiguous",
      kind: "message.submit",
      session_id: session.id,
      backend_id: "collection-open-ambiguous-unneeded",
      content: "映画アプリを開いて",
      output_locale: "ja",
      renderer_capabilities: {
        protocol_version: "1",
        supported_kinds: ["chat", "custom_view", "collection"],
        custom_view_renderers: [{ renderer: "collection_table", versions: ["1"] }]
      }
    });
    const agentMessage = opened.result.messages.find((message) => message.role === "agent");
    const savedPresentations = await store.listMessagePresentations({ sessionId: session.id, messageId: agentMessage?.id });
    const runs = await store.listBackendRuns(session.id);
    await store.close();

    expect(backendRuns).toBe(1);
    expect(opened.render_specs?.map((spec) => spec.kind)).toEqual(["chat"]);
    expect(opened.result.messagePresentations).toEqual([]);
    expect(savedPresentations).toEqual([]);
    expect(agentMessage?.content).not.toContain("候補が複数あります");
    expect(runs[0]).toMatchObject({
      backend_id: "collection-open-ambiguous-unneeded",
      status: "completed"
    });
  });

  it("opens the exact Collection title when similar shorter Collection titles also match", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-runtime-collection-present-exact-title-"));
    roots.push(root);
    const store = await WorkspaceStore.create({ rootDir: root });
    await store.updateCollectionSchema({
      id: "movies",
      version: "1",
      labels: { ja: "映画ログ", en: "Movies" },
      descriptions: { ja: "映画を記録する個人用アプリ。", en: "A personal movie log." },
      fields: [{ id: "title", type: "string", label: "タイトル", required: true }],
      refs: [],
      embeds: [],
      derived_fields: [],
      triggers: [],
      actions: [],
      views: [{ id: "movies_table", renderer: "collection_table", editable_fields: ["title"] }],
      permissions: { create: true, update: true, delete: true }
    });
    await store.updateCollectionSchema({
      id: "movies_e2e_215100",
      version: "1",
      labels: { ja: "映画ログE2E 215100", en: "Movies E2E 215100" },
      descriptions: { ja: "映画を記録する個人用Collection。", en: "A personal movie log Collection." },
      fields: [
        { id: "title", type: "string", label: "タイトル", required: true },
        { id: "status", type: "enum", label: "状態", enum_values: ["観たい", "視聴中", "観た"] },
        { id: "watched_at", type: "date", label: "鑑賞日" }
      ],
      refs: [],
      embeds: [],
      derived_fields: [],
      triggers: [],
      actions: [],
      views: [
        { id: "movies_e2e_215100_table", renderer: "collection_table", editable_fields: ["title", "status", "watched_at"] },
        { id: "movies_e2e_215100_calendar", renderer: "calendar_view", editable_fields: ["title", "status", "watched_at"] }
      ],
      permissions: { create: true, update: true, delete: true }
    });
    let backendRuns = 0;
    const backend: AgentBackend = {
      id: "collection-open-exact-title-unneeded",
      kind: "codex",
      label: "Unused exact title collection open fixture",
      async *runTurn() {
        backendRuns += 1;
        yield {
          event_type: "run_completed",
          payload: { output_summary: "unexpected" }
        };
      }
    };
    const runtime = new AgentRuntime(store, undefined, undefined, new AgentBackendRegistry([backend]));
    const session = await runtime.createSession();

    const opened = await runtime.runSurfaceOperation({
      id: "surface_movies_open_exact_title",
      kind: "message.submit",
      session_id: session.id,
      backend_id: "collection-open-exact-title-unneeded",
      content: "映画ログE2E 215100を開いて。カレンダーで見たい",
      output_locale: "ja",
      renderer_capabilities: {
        protocol_version: "1",
        supported_kinds: ["chat", "custom_view", "collection"],
        custom_view_renderers: [
          { renderer: "collection_table", versions: ["1"] },
          { renderer: "calendar_view", versions: ["1"] }
        ]
      }
    });
    const agentMessage = opened.result.messages.find((message) => message.role === "agent");
    const savedPresentations = await store.listMessagePresentations({ sessionId: session.id, messageId: agentMessage?.id });
    const runs = await store.listBackendRuns(session.id);
    await store.close();

    expect(backendRuns).toBe(1);
    expect(opened.render_specs?.map((spec) => spec.kind)).toEqual(["chat"]);
    expect(opened.result.messagePresentations).toEqual([]);
    expect(savedPresentations).toEqual([]);
    expect(runs[0]).toMatchObject({
      backend_id: "collection-open-exact-title-unneeded",
      status: "completed"
    });
  });

  it("keeps short natural-language Collection view changes on the Runtime presentation path", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-runtime-collection-view-intent-"));
    roots.push(root);
    const store = await WorkspaceStore.create({ rootDir: root });
    await store.updateCollectionSchema({
      id: "movies",
      version: "1",
      labels: { ja: "映画ログ", en: "Movies" },
      descriptions: { ja: "映画を記録する個人用アプリ。", en: "A personal movie log." },
      fields: [
        { id: "title", type: "string", label: "タイトル", required: true },
        { id: "rating", type: "number", label: "評価" },
        { id: "status", type: "enum", label: "状態", enum_values: ["観たい", "視聴中", "観た"] },
        { id: "starts_at", type: "datetime", label: "開始日時" }
      ],
      refs: [],
      embeds: [],
      derived_fields: [],
      triggers: [],
      actions: [],
      views: [{
        id: "movies_table",
        renderer: "collection_table",
        density: "comfortable",
        editable_fields: ["title", "rating", "status", "watched_at"]
      }],
      permissions: { create: true, update: true, delete: true }
    });
    let backendRuns = 0;
    const backend: AgentBackend = {
      id: "collection-view-intent-unneeded",
      kind: "codex",
      label: "Unused collection view intent fixture",
      async *runTurn() {
        backendRuns += 1;
        yield {
          event_type: "run_completed",
          payload: { output_summary: "unexpected" }
        };
      }
    };
    const runtime = new AgentRuntime(store, undefined, undefined, new AgentBackendRegistry([backend]));
    const session = await runtime.createSession();
    const capabilities = {
      protocol_version: "1",
      supported_kinds: ["chat", "custom_view", "collection"],
      custom_view_renderers: [
        { renderer: "collection_table", versions: ["1"] },
        { renderer: "collection_gallery", versions: ["1"] },
        { renderer: "calendar_view", versions: ["1"] },
        { renderer: "collection_kanban", versions: ["1"] }
      ]
    };

    const requests = [
      ["surface_movies_open_for_view_intent", "映画ログを開いて", "ja"],
      ["surface_movies_filter_intent_english", "show watched movie list", "en"],
      ["surface_movies_sort_intent", "評価順にして", "ja"],
      ["surface_movies_calendar_intent", "カレンダーで見たい", "ja"],
      ["surface_movies_dashboard_intent", "ダッシュボードで見たい", "ja"]
    ] as const;
    const results = [];
    for (const [id, content, outputLocale] of requests) {
      results.push(await runtime.runSurfaceOperation({
        id,
        kind: "message.submit",
        session_id: session.id,
        backend_id: "collection-view-intent-unneeded",
        content,
        output_locale: outputLocale,
        renderer_capabilities: capabilities
      }));
    }
    await store.close();

    expect(backendRuns).toBe(requests.length);
    for (const result of results) {
      expect(result.render_specs?.map((spec) => spec.kind)).toEqual(["chat"]);
      expect(result.result.messagePresentations).toEqual([]);
    }
  });

  it("presents Collections when the backend explicitly calls the Collection view tool", async () => {
    let runtime: AgentRuntime;
    const backend: AgentBackend = {
      id: "collection-view-tool",
      kind: "codex",
      label: "Collection view tool fixture",
      async *runTurn(input) {
        await runtime.runBackendToolBridgeCall({
          runId: input.run_id,
          token: input.tool_bridge?.token ?? "",
          toolName: "mcp__samurai__collection_view_present",
          toolCallId: "present_movies",
          toolInput: { query: "映画ログ", view_id: "movies_calendar" }
        });
        yield {
          event_type: "run_completed",
          payload: { output_summary: "presented" }
        };
      }
    };
    const root = await mkdtemp(path.join(tmpdir(), "samurai-runtime-collection-present-tool-"));
    roots.push(root);
    const store = await WorkspaceStore.create({ rootDir: root });
    await store.updateCollectionSchema({
      id: "movies",
      version: "1",
      labels: { ja: "映画ログ", en: "Movies" },
      descriptions: { ja: "映画を記録する個人用アプリ。", en: "A personal movie log." },
      fields: [
        { id: "title", type: "string", label: "タイトル", required: true },
        { id: "watched_at", type: "date", label: "鑑賞日" }
      ],
      refs: [],
      embeds: [],
      derived_fields: [],
      triggers: [],
      actions: [],
      views: [
        { id: "movies_table", renderer: "collection_table" },
        { id: "movies_calendar", renderer: "calendar_view" }
      ],
      permissions: { create: true, update: true, delete: true }
    });
    runtime = new AgentRuntime(store, undefined, undefined, new AgentBackendRegistry([backend]));
    const session = await runtime.createSession();
    const capabilities = {
      protocol_version: "1",
      supported_kinds: ["chat", "custom_view", "collection"],
      custom_view_renderers: [
        { renderer: "collection_table", versions: ["1"] },
        { renderer: "calendar_view", versions: ["1"] }
      ]
    };
    const result = await runtime.runSurfaceOperation({
      id: "surface_movies_open_for_view_intent",
      kind: "message.submit",
      session_id: session.id,
      backend_id: "collection-view-tool",
      content: "映画ログを開いて",
      output_locale: "ja",
      renderer_capabilities: capabilities
    });
    await store.close();

    expect(result.render_specs?.[1]).toMatchObject({
      kind: "custom_view",
      props: {
        renderer: "calendar_view",
        view_id: "movies_calendar"
      }
    });
    expect(result.result.messagePresentations[0]).toMatchObject({
      collection_id: "movies",
      view_id: "movies_calendar",
      renderer: "calendar_view"
    });
  });

  it("applies natural-language schema patches to the active Collection through Runtime validation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-runtime-collection-schema-patch-"));
    roots.push(root);
    const store = await WorkspaceStore.create({ rootDir: root });
    await store.updateCollectionSchema({
      id: "movies",
      version: "1",
      labels: { ja: "映画ログ", en: "Movies" },
      descriptions: { ja: "映画を記録する個人用アプリ。", en: "A personal movie log." },
      fields: [
        { id: "title", type: "string", label: "タイトル", required: true },
        { id: "status", type: "enum", label: "ステータス", enum_values: ["観たい", "観た"] }
      ],
      refs: [],
      embeds: [],
      derived_fields: [],
      triggers: [],
      actions: [],
      views: [{
        id: "movies_table",
        renderer: "collection_table",
        density: "comfortable",
        editable_fields: ["title"]
      }],
      permissions: { create: true, update: true, delete: true }
    });
    let runtime: AgentRuntime;
    let backendRuns = 0;
    const backend: AgentBackend = {
      id: "collection-schema-patch-bridge",
      kind: "codex",
      label: "Collection schema patch bridge fixture",
      async *runTurn(input) {
        backendRuns += 1;
        const intent = input.envelope.user_intent;
        if (intent.includes("開いて")) {
          await runtime.runBackendToolBridgeCall({
            runId: input.run_id,
            token: input.tool_bridge?.token ?? "",
            toolName: "mcp__samurai__collection_view_present",
            toolCallId: `present_${backendRuns}`,
            toolInput: { collection_id: "movies", view_id: "movies_table" }
          });
        }
        if (intent.includes("評価")) {
          await runCollectionManagePatchSchemaTool({
            runtime,
            runId: input.run_id,
            token: input.tool_bridge?.token ?? "",
            toolCallId: "patch_schema_rating",
            collectionId: "movies",
            viewId: "movies_table",
            patches: [
              { op: "add_field", field: { id: "rating", type: "number", label: "評価" } },
              { op: "set_sort", field_id: "rating", direction: "desc" }
            ]
          });
        }
        if (intent.includes("ステータス")) {
          await runCollectionManagePatchSchemaTool({
            runtime,
            runId: input.run_id,
            token: input.tool_bridge?.token ?? "",
            toolCallId: "patch_schema_status",
            collectionId: "movies",
            viewId: "movies_table",
            patches: [
              { op: "update_field", field_id: "status", changes: { enum_values: ["観たい", "視聴中", "観た", "保留"] } }
            ]
          });
        }
        if (intent.includes("カレンダー")) {
          await runCollectionManagePatchSchemaTool({
            runtime,
            runId: input.run_id,
            token: input.tool_bridge?.token ?? "",
            toolCallId: "patch_schema_calendar",
            collectionId: "movies",
            viewId: "movies_table",
            patches: [
              { op: "add_field", field: { id: "watched_at", type: "datetime", label: "鑑賞日時" } },
              { op: "update_view", renderer: "calendar_view" }
            ]
          });
        }
        yield { event_type: "text_delta", payload: { text: "対応しました。" } };
        yield { event_type: "run_completed", payload: { output_summary: "done" } };
      }
    };
    runtime = new AgentRuntime(store, undefined, undefined, new AgentBackendRegistry([backend]));
    const session = await runtime.createSession();
    const capabilities = {
      protocol_version: "1",
      supported_kinds: ["chat", "custom_view", "collection"],
      custom_view_renderers: [
        { renderer: "collection_table", versions: ["1"] },
        { renderer: "calendar_view", versions: ["1"] }
      ]
    };

    await runtime.runSurfaceOperation({
      id: "surface_movies_schema_patch_open",
      kind: "message.submit",
      session_id: session.id,
      backend_id: "collection-schema-patch-bridge",
      content: "映画ログを開いて",
      output_locale: "ja",
      renderer_capabilities: capabilities
    });
    const ratingPatch = await runtime.runSurfaceOperation({
      id: "surface_movies_schema_patch_rating",
      kind: "message.submit",
      session_id: session.id,
      backend_id: "collection-schema-patch-bridge",
      content: "評価フィールドを追加して",
      output_locale: "ja",
      metadata: {
        active_app_context: {
          renderer: "collection_table",
          collection_id: "movies",
          view_id: "movies_table"
        }
      },
      renderer_capabilities: capabilities
    });
    const statusPatch = await runtime.runSurfaceOperation({
      id: "surface_movies_schema_patch_status",
      kind: "message.submit",
      session_id: session.id,
      backend_id: "collection-schema-patch-bridge",
      content: "ステータスを、観たい・視聴中・観た・保留にして",
      output_locale: "ja",
      metadata: {
        active_app_context: {
          renderer: "collection_table",
          collection_id: "movies",
          view_id: "movies_table"
        }
      },
      renderer_capabilities: capabilities
    });
    const calendarPatch = await runtime.runSurfaceOperation({
      id: "surface_movies_schema_patch_calendar",
      kind: "message.submit",
      session_id: session.id,
      backend_id: "collection-schema-patch-bridge",
      content: "カレンダー表示もできるようにして",
      output_locale: "ja",
      metadata: {
        active_app_context: {
          renderer: "collection_table",
          collection_id: "movies",
          view_id: "movies_table"
        }
      },
      renderer_capabilities: capabilities
    });
    const schema = await store.getCollectionSchema("movies");
    const operations = await store.listOperations();
    await store.close();

    expect(backendRuns).toBe(4);
    expect(schema?.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "rating", type: "number", label: "評価" }),
      expect.objectContaining({ id: "status", type: "enum", label: "ステータス", enum_values: ["観たい", "視聴中", "観た", "保留"] }),
      expect.objectContaining({ id: "watched_at", type: "datetime", label: "鑑賞日時" })
    ]));
    expect(schema?.views).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "movies_calendar", renderer: "calendar_view" })
    ]));
    expect(operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ operation: "collection.manage", status: "completed" })
    ]));
    expect(ratingPatch.result.messagePresentations[0]).toMatchObject({
      collection_id: "movies",
      view_state: expect.objectContaining({
        sort: { field_id: "rating", direction: "desc", completed_last: true }
      })
    });
    expect(operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ operation: "collection.manage", status: "completed" })
    ]));
    expect(statusPatch.render_specs?.[1]).toMatchObject({
      kind: "custom_view",
      props: {
        renderer: "collection_table",
        data: expect.objectContaining({
          schema_fields: expect.arrayContaining([
            expect.objectContaining({ id: "status", enum_values: ["観たい", "視聴中", "観た", "保留"] })
          ])
        })
      }
    });
    expect(calendarPatch.render_specs?.[1]).toMatchObject({
      kind: "custom_view",
      props: {
        renderer: "calendar_view",
        view_id: "movies_calendar"
      }
    });
  });

  it("rejects invalid Collection schema view patches without saving broken schema", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-runtime-collection-schema-patch-invalid-"));
    roots.push(root);
    const store = await WorkspaceStore.create({ rootDir: root });
    await store.updateCollectionSchema({
      id: "notes",
      version: "1",
      labels: { ja: "メモ", en: "Notes" },
      descriptions: {},
      fields: [
        { id: "title", type: "string", label: "タイトル", required: true }
      ],
      refs: [],
      embeds: [],
      derived_fields: [],
      triggers: [],
      actions: [],
      views: [{
        id: "notes_table",
        renderer: "collection_table",
        editable_fields: ["title"]
      }],
      permissions: { create: true, update: true, delete: true }
    });
    let runtime: AgentRuntime;
    const backend: AgentBackend = {
      id: "collection-schema-patch-invalid-bridge",
      kind: "codex",
      label: "Collection schema invalid patch bridge fixture",
      async *runTurn(input) {
        await runCollectionManagePatchSchemaTool({
          runtime,
          runId: input.run_id,
          token: input.tool_bridge?.token ?? "",
          toolCallId: "patch_schema_invalid_calendar",
          collectionId: "notes",
          viewId: "notes_table",
          patches: [{ op: "update_view", renderer: "calendar_view" }]
        });
        yield { event_type: "text_delta", payload: { text: "対応しました。" } };
        yield { event_type: "run_completed", payload: { output_summary: "done" } };
      }
    };
    runtime = new AgentRuntime(store, undefined, undefined, new AgentBackendRegistry([backend]));
    const session = await runtime.createSession();

    await expect(runtime.runSurfaceOperation({
      id: "surface_notes_invalid_calendar_patch",
      kind: "message.submit",
      session_id: session.id,
      backend_id: "collection-schema-patch-invalid-bridge",
      content: "カレンダー表示もできるようにして",
      output_locale: "ja",
      metadata: {
        active_app_context: {
          renderer: "collection_table",
          collection_id: "notes",
          view_id: "notes_table"
        }
      }
    })).rejects.toThrow("app_edit_view_renderer_not_supported:calendar_renderer_requires_date_field");
    const schema = await store.getCollectionSchema("notes");
    await store.close();

    expect(schema?.fields).toEqual([expect.objectContaining({ id: "title" })]);
    expect(schema?.views).toEqual([expect.objectContaining({ id: "notes_table", renderer: "collection_table" })]);
  });

  it("rejects unsafe derived field expressions from Collection schema patches", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-runtime-collection-derived-patch-invalid-"));
    roots.push(root);
    const store = await WorkspaceStore.create({ rootDir: root });
    await store.updateCollectionSchema({
      id: "expenses",
      version: "1",
      labels: { ja: "支出", en: "Expenses" },
      descriptions: {},
      fields: [
        { id: "name", type: "string", label: "名前" },
        { id: "price", type: "number", label: "金額" }
      ],
      refs: [],
      embeds: [],
      derived_fields: [],
      triggers: [],
      actions: [],
      views: [{ id: "expenses_table", renderer: "collection_table" }],
      permissions: { create: true, update: true, delete: true }
    });
    let runtime: AgentRuntime;
    const backend: AgentBackend = {
      id: "collection-derived-patch-invalid-bridge",
      kind: "codex",
      label: "Collection derived invalid patch bridge fixture",
      async *runTurn(input) {
        await runCollectionManagePatchSchemaTool({
          runtime,
          runId: input.run_id,
          token: input.tool_bridge?.token ?? "",
          toolCallId: "patch_schema_invalid_derived",
          collectionId: "expenses",
          viewId: "expenses_table",
          patches: [{ op: "add_derived_field", field: { id: "total", type: "number", label: "合計", expression: { op: "eval", code: "price + tax" } } }]
        });
        yield { event_type: "text_delta", payload: { text: "対応しました。" } };
        yield { event_type: "run_completed", payload: { output_summary: "done" } };
      }
    };
    runtime = new AgentRuntime(store, undefined, undefined, new AgentBackendRegistry([backend]));
    const session = await runtime.createSession();

    await expect(runtime.runSurfaceOperation({
      id: "surface_expenses_invalid_derived_patch",
      kind: "message.submit",
      session_id: session.id,
      backend_id: "collection-derived-patch-invalid-bridge",
      content: "合計フィールドを追加して",
      output_locale: "ja",
      metadata: {
        active_app_context: {
          renderer: "collection_table",
          collection_id: "expenses",
          view_id: "expenses_table"
        }
      }
    })).rejects.toThrow("app_edit_invalid_derived_expression:total");
    const schema = await store.getCollectionSchema("expenses");
    await store.close();

    expect(schema?.derived_fields).toEqual([]);
  });

  it("applies derived field schema patches through Runtime validation and redraws calculated values", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-runtime-collection-derived-patch-"));
    roots.push(root);
    const store = await WorkspaceStore.create({ rootDir: root });
    const now = nowIso();
    await store.updateCollectionSchema({
      id: "expenses",
      version: "1",
      labels: { ja: "支出", en: "Expenses" },
      descriptions: {},
      fields: [
        { id: "name", type: "string", label: "名前" },
        { id: "price", type: "number", label: "金額" },
        { id: "tax", type: "number", label: "税" }
      ],
      refs: [],
      embeds: [],
      derived_fields: [],
      triggers: [],
      actions: [],
      views: [{ id: "expenses_table", renderer: "collection_table", editable_fields: ["name", "price", "tax"] }],
      permissions: { create: true, update: true, delete: true }
    });
    let runtime: AgentRuntime;
    let backendRuns = 0;
    const backend: AgentBackend = {
      id: "collection-derived-patch-bridge",
      kind: "codex",
      label: "Collection derived patch bridge fixture",
      async *runTurn(input) {
        backendRuns += 1;
        await runCollectionManagePatchSchemaTool({
          runtime,
          runId: input.run_id,
          token: input.tool_bridge?.token ?? "",
          toolCallId: "patch_schema_derived",
          collectionId: "expenses",
          viewId: "expenses_table",
          patches: [{
            op: "add_derived_field",
            field: {
              id: "total",
              type: "number",
              label: "合計",
              expression: {
                op: "add",
                args: [{ op: "field", field_id: "price" }, { op: "field", field_id: "tax" }]
              }
            }
          }]
        });
        yield { event_type: "text_delta", payload: { text: "対応しました。" } };
        yield { event_type: "run_completed", payload: { output_summary: "done" } };
      }
    };
    runtime = new AgentRuntime(store, undefined, undefined, new AgentBackendRegistry([backend]));
    await runtime.createCollectionRecord({
      id: "expense_hosting",
      collection_id: "expenses",
      data: { name: "hosting", price: 100, tax: 10 },
      resource_refs: [],
      created_at: now,
      updated_at: now
    });
    const session = await runtime.createSession();

    const patched = await runtime.runSurfaceOperation({
      id: "surface_expenses_derived_patch",
      kind: "message.submit",
      session_id: session.id,
      backend_id: "collection-derived-patch-bridge",
      content: "合計フィールドを追加して",
      output_locale: "ja",
      metadata: {
        active_app_context: {
          renderer: "collection_table",
          collection_id: "expenses",
          view_id: "expenses_table"
        }
      }
    });
    const schema = await store.getCollectionSchema("expenses");
    const savedRecord = await store.getCollectionRecord("expenses", "expense_hosting");
    const operations = await store.listOperations();
    await store.close();

    expect(backendRuns).toBe(1);
    expect(schema?.derived_fields).toEqual([
      expect.objectContaining({
        id: "total",
        type: "number",
        label: "合計",
        derived: true,
        read_only: true
      })
    ]);
    expect(savedRecord?.data).not.toHaveProperty("total");
    expect(operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ operation: "collection.manage", status: "completed" })
    ]));
    expect(patched.render_specs?.[1]).toMatchObject({
      kind: "custom_view",
      props: {
        renderer: "collection_table",
        data: expect.objectContaining({
          schema_fields: expect.arrayContaining([
            expect.objectContaining({ id: "total", derived: true, read_only: true, source: "derived_field" })
          ]),
          records: expect.arrayContaining([
            expect.objectContaining({ id: "expense_hosting", total: 110 })
          ])
        })
      }
    });
  });

  it("rejects unsupported Collection schema patch ops instead of silently ignoring them", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-runtime-collection-patch-unknown-op-"));
    roots.push(root);
    const store = await WorkspaceStore.create({ rootDir: root });
    await store.updateCollectionSchema({
      id: "expenses",
      version: "1",
      labels: { ja: "支出", en: "Expenses" },
      descriptions: {},
      fields: [
        { id: "name", type: "string", label: "名前" },
        { id: "price", type: "number", label: "金額" }
      ],
      refs: [],
      embeds: [],
      derived_fields: [],
      triggers: [],
      actions: [],
      views: [{ id: "expenses_table", renderer: "collection_table" }],
      permissions: { create: true, update: true, delete: true }
    });
    let runtime: AgentRuntime;
    const backend: AgentBackend = {
      id: "collection-patch-unknown-op-bridge",
      kind: "codex",
      label: "Collection unknown patch op bridge fixture",
      async *runTurn(input) {
        await runCollectionManagePatchSchemaTool({
          runtime,
          runId: input.run_id,
          token: input.tool_bridge?.token ?? "",
          toolCallId: "patch_schema_unknown_op",
          collectionId: "expenses",
          viewId: "expenses_table",
          patches: [{ op: "backfill_records", field_id: "price", value: 0 }]
        });
        yield { event_type: "text_delta", payload: { text: "対応しました。" } };
        yield { event_type: "run_completed", payload: { output_summary: "done" } };
      }
    };
    runtime = new AgentRuntime(store, undefined, undefined, new AgentBackendRegistry([backend]));
    const session = await runtime.createSession();

    await expect(runtime.runSurfaceOperation({
      id: "surface_expenses_unknown_patch_op",
      kind: "message.submit",
      session_id: session.id,
      backend_id: "collection-patch-unknown-op-bridge",
      content: "金額フィールドを更新して空値を0円で埋めて",
      output_locale: "ja",
      metadata: {
        active_app_context: {
          renderer: "collection_table",
          collection_id: "expenses",
          view_id: "expenses_table"
        }
      }
    })).rejects.toThrow("app_edit_unknown_op:backfill_records");
    const schema = await store.getCollectionSchema("expenses");
    await store.close();

    expect(schema?.fields).toEqual([
      expect.objectContaining({ id: "name" }),
      expect.objectContaining({ id: "price" })
    ]);
  });

  it("keeps the backend presentation tool path when direct collection matching has no candidate", async () => {
    let runtime: AgentRuntime;
    const bridgeBackend: AgentBackend = {
      id: "collection-present-bridge",
      kind: "codex",
      label: "Collection Present Bridge Fixture",
      async *runTurn(input) {
        expect(input.tool_bridge?.enabled).toBe(true);
        await runtime.runBackendToolBridgeCall({
          runId: input.run_id,
          token: input.tool_bridge?.token ?? "",
          toolName: "mcp__samurai__collection_view_present",
          toolCallId: "present_tool_1",
          toolInput: {
            query: "映画ログ",
            record_id: "movie_1"
          }
        });
        yield {
          event_type: "text_delta",
          payload: { text: "映画ログを開きました。" }
        };
        yield {
          event_type: "run_completed",
          payload: { output_summary: "done" }
        };
      }
    };
    const root = await mkdtemp(path.join(tmpdir(), "samurai-runtime-collection-bridge-"));
    roots.push(root);
    const store = await WorkspaceStore.create({ rootDir: root });
    await store.updateCollectionSchema({
      id: "movies",
      version: "1",
      labels: { ja: "映画ログ", en: "Movies" },
      descriptions: { ja: "映画を記録する個人用アプリ。", en: "A personal movie log." },
      fields: [
        { id: "title", type: "string", label: "タイトル", required: true },
        { id: "rating", type: "number", label: "評価" }
      ],
      refs: [],
      embeds: [],
      derived_fields: [],
      triggers: [],
      actions: [],
      views: [{
        id: "movies_table",
        renderer: "collection_table",
        density: "comfortable",
        allow_delete: true,
        editable_fields: ["title", "rating"]
      }],
      permissions: { create: true, update: true, delete: true }
    });
    runtime = new AgentRuntime(store, undefined, undefined, new AgentBackendRegistry([bridgeBackend]));
    await runtime.createCollectionRecord({
      id: "movie_1",
      collection_id: "movies",
      data: { title: "七人の侍", rating: 5 },
      resource_refs: [],
      created_at: nowIso(),
      updated_at: nowIso()
    });
    const session = await runtime.createSession();

    const opened = await runtime.runSurfaceOperation({
      id: "surface_movies_open_bridge",
      kind: "message.submit",
      session_id: session.id,
      backend_id: "collection-present-bridge",
      content: "データアプリを開いて",
      output_locale: "ja",
      renderer_capabilities: {
        protocol_version: "1",
        supported_kinds: ["chat", "custom_view", "collection"],
        custom_view_renderers: [{ renderer: "collection_table", versions: ["1"] }]
      }
    });
    await store.close();

    expect(opened.result.messagePresentations).toEqual([
      expect.objectContaining({
        collection_id: "movies",
        view_id: "movies_table",
        renderer: "collection_table",
        title: "映画ログ",
        view_state: expect.objectContaining({
          record_id: "movie_1",
          selected_record_id: "movie_1"
        })
      })
    ]);
    expect(opened.render_specs?.[1]).toMatchObject({
      kind: "custom_view",
      props: {
        renderer: "collection_table",
        view_state: expect.objectContaining({
          record_id: "movie_1",
          selected_record_id: "movie_1"
        }),
        data: expect.objectContaining({
          view_state: expect.objectContaining({
            selected_record_id: "movie_1"
          })
        })
      }
    });
  });

  it("updates message presentation state through Runtime surface operations", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-runtime-presentation-state-"));
    roots.push(root);
    const store = await WorkspaceStore.create({ rootDir: root });
    const runtime = new AgentRuntime(store);
    const session = await runtime.createSession();
    await store.updateCollectionSchema({
      id: "movies",
      version: "1",
      labels: { ja: "映画ログ", en: "Movies" },
      descriptions: {},
      fields: [{ id: "title", type: "string", label: "タイトル", required: true }],
      refs: [],
      embeds: [],
      derived_fields: [],
      triggers: [],
      actions: [],
      views: [
        { id: "movies_table", renderer: "collection_table", editable_fields: ["title"] },
        { id: "movies_gallery", renderer: "collection_gallery", editable_fields: ["title"] }
      ],
      permissions: { create: true, update: true, delete: true }
    });
    const message = await store.saveMessage({
      id: createId("message"),
      session_id: session.id,
      role: "agent",
      content: "映画ログを開きました。",
      input_locale: "ja",
      output_locale: "ja",
      created_at: nowIso()
    });
    const presentation = await store.saveMessagePresentation({
      id: createId("presentation"),
      session_id: session.id,
      message_id: message.id,
      kind: "collection_app",
      title: "映画ログ",
      subtitle: "movies ・ 0件",
      collection_id: "movies",
      view_id: "movies_table",
      renderer: "collection_table",
      created_at: nowIso(),
      updated_at: nowIso()
    });

    const updated = await runtime.runSurfaceOperation({
      id: "surface_presentation_state",
      kind: "message.presentation.update",
      presentation_id: presentation.id,
      view_state: {
        collection_id: "wrong_collection",
        view_id: "movies_gallery",
        renderer: "study_deck",
        record_count: 999,
        sort: { field_id: "title", direction: "asc" }
      },
      renderer_capabilities: {
        protocol_version: "1",
        supported_kinds: ["custom_view", "collection"],
        custom_view_renderers: [
          { renderer: "collection_table", versions: ["1"] },
          { renderer: "collection_gallery", versions: ["1"] }
        ]
      }
    });
    const saved = await store.listMessagePresentations({ sessionId: session.id, messageId: message.id });
    await store.close();

    expect(updated.result_kind).toBe("message_presentation");
    expect(updated.result).toMatchObject({
      id: presentation.id,
      view_id: "movies_gallery",
      renderer: "collection_gallery",
      view_state: expect.objectContaining({
        collection_id: "movies",
        view_id: "movies_gallery",
        renderer: "collection_gallery",
        record_count: 0,
        sort: { field_id: "title", direction: "asc" }
      })
    });
    expect(updated.result.view_state).not.toMatchObject({
      collection_id: "wrong_collection",
      renderer: "study_deck",
      record_count: 999
    });
    expect(saved[0]?.view_state).toEqual(updated.result.view_state);
    expect(updated.render_spec).toMatchObject({
      kind: "custom_view",
      props: {
        renderer: "collection_gallery",
        view_id: "movies_gallery",
        view_state: updated.result.view_state,
        data: {
          view_config: expect.objectContaining({
            id: "movies_gallery",
            renderer: "collection_gallery"
          }),
          view_state: updated.result.view_state
        }
      }
    });
  });

  it("keeps Collection view renderer names from schema views", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-runtime-gallery-view-"));
    roots.push(root);
    const store = await WorkspaceStore.create({ rootDir: root });
    const runtime = new AgentRuntime(store);
    await store.updateCollectionSchema({
      id: "movies",
      version: "1",
      labels: { ja: "映画ログ", en: "Movies" },
      descriptions: {},
      fields: [
        { id: "title", type: "string", label: "タイトル", required: true },
        { id: "rating", type: "number", label: "評価" }
      ],
      refs: [],
      embeds: [],
      derived_fields: [],
      triggers: [],
      actions: [],
      views: [{
        id: "movies_gallery",
        renderer: "collection_gallery",
        density: "comfortable",
        editable_fields: ["title", "rating"]
      }],
      permissions: { create: true, update: true, delete: true }
    });

    const view = await runtime.runSurfaceOperation({
      id: "surface_movies_gallery",
      kind: "collection.view.present",
      collection_id: "movies",
      view_id: "movies_gallery",
      renderer_capabilities: {
        protocol_version: "1",
        supported_kinds: ["custom_view", "collection"],
        custom_view_renderers: [{ renderer: "collection_gallery", versions: ["1"] }]
      }
    });
    await store.close();

    expect(view.render_spec).toMatchObject({
      kind: "custom_view",
      props: {
        renderer: "collection_gallery",
        view_id: "movies_gallery",
        view_state: expect.objectContaining({
          collection_id: "movies",
          view_id: "movies_gallery",
          renderer: "collection_gallery"
        }),
        data: expect.objectContaining({
          collection_id: "movies",
          view_options: expect.arrayContaining([
            expect.objectContaining({ renderer: "collection_table" }),
            expect.objectContaining({ renderer: "collection_gallery" })
          ]),
          view_state: expect.objectContaining({
            renderer: "collection_gallery"
          })
        })
      }
    });
  });

  it("presents synthesized Collection view options through Runtime", async () => {
    const { runtime, store } = await createRuntime();
    await store.saveCollectionSchema({
      id: "movies",
      version: "1",
      labels: { ja: "映画ログ", en: "Movies" },
      descriptions: {},
      fields: [
        { id: "title", type: "string", label: "タイトル" },
        { id: "status", type: "enum", label: "状態", enum_values: ["観たい", "視聴中", "観た"] },
        { id: "starts_at", type: "datetime", label: "開始日時" }
      ],
      refs: [],
      embeds: [],
      derived_fields: [],
      triggers: [],
      actions: [],
      views: [{
        id: "movies_table",
        renderer: "collection_table"
      }],
      permissions: {}
    });

    const calendar = await runtime.runSurfaceOperation({
      id: "surface_movies_calendar",
      kind: "collection.view.present",
      collection_id: "movies",
      view_id: "movies_calendar",
      renderer_capabilities: {
        protocol_version: "1",
        supported_kinds: ["custom_view", "collection"],
        custom_view_renderers: [
          { renderer: "collection_table", versions: ["1"] },
          { renderer: "collection_gallery", versions: ["1"] },
          { renderer: "calendar_view", versions: ["1"] },
          { renderer: "collection_kanban", versions: ["1"] }
        ]
      }
    });
    await store.close();

    expect(calendar.render_spec).toMatchObject({
      kind: "custom_view",
      props: {
        renderer: "calendar_view",
        view_id: "movies_calendar",
        data: expect.objectContaining({
          view_options: expect.arrayContaining([
            expect.objectContaining({ id: "movies_table", renderer: "collection_table" }),
            expect.objectContaining({ id: "movies_gallery", renderer: "collection_gallery" }),
            expect.objectContaining({ id: "movies_calendar", renderer: "calendar_view" }),
            expect.objectContaining({ id: "movies_kanban", renderer: "collection_kanban" })
          ]),
          view_state: expect.objectContaining({
            view_id: "movies_calendar",
            renderer: "calendar_view"
          }),
          schema_fields: expect.arrayContaining([
            expect.objectContaining({ id: "starts_at", type: "datetime", label: "開始日時" })
          ])
        })
      }
    });
  });

  it("falls back unsupported Collection renderers from Runtime schema validation", async () => {
    const { runtime, store } = await createRuntime();
    await store.saveCollectionSchema({
      id: "notes",
      version: "1",
      labels: { ja: "メモ", en: "Notes" },
      descriptions: {},
      fields: [
        { id: "title", type: "string", label: "タイトル" },
        { id: "body", type: "text", label: "本文" }
      ],
      refs: [],
      embeds: [],
      derived_fields: [],
      triggers: [],
      actions: [],
      views: [
        {
          id: "notes_calendar",
          renderer: "calendar_view"
        },
        {
          id: "notes_kanban",
          renderer: "collection_kanban"
        }
      ],
      permissions: {}
    });

    const calendarView = await runtime.runSurfaceOperation({
      id: "surface_notes_calendar",
      kind: "collection.view.present",
      collection_id: "notes",
      view_id: "notes_calendar",
      renderer_capabilities: {
        protocol_version: "1",
        supported_kinds: ["custom_view", "collection"],
        custom_view_renderers: [{ renderer: "calendar_view", versions: ["1"] }, { renderer: "collection_table", versions: ["1"] }]
      }
    });
    const kanbanView = await runtime.runSurfaceOperation({
      id: "surface_notes_kanban",
      kind: "collection.view.present",
      collection_id: "notes",
      view_id: "notes_kanban",
      renderer_capabilities: {
        protocol_version: "1",
        supported_kinds: ["custom_view", "collection"],
        custom_view_renderers: [{ renderer: "collection_kanban", versions: ["1"] }, { renderer: "collection_table", versions: ["1"] }]
      }
    });
    await store.close();

    expect(calendarView.render_spec).toMatchObject({
      kind: "custom_view",
      props: {
        renderer: "collection_table",
        data: expect.objectContaining({
          view_config: expect.objectContaining({
            requested_renderer: "calendar_view",
            fallback_reason: "calendar_renderer_requires_date_field"
          })
        })
      }
    });
    expect(kanbanView.render_spec).toMatchObject({
      kind: "custom_view",
      props: {
        renderer: "collection_table",
        data: expect.objectContaining({
          view_config: expect.objectContaining({
            requested_renderer: "collection_kanban",
            fallback_reason: "kanban_renderer_requires_enum_field"
          })
        })
      }
    });
  });

  it("rejects Collection table apps from Workspace schema files created directly by the backend", async () => {
    const fileBackend: AgentBackend = {
      id: "collection-schema-file",
      kind: "codex",
      label: "Collection Schema File Fixture",
      async *runTurn(input) {
        expect(input.expected_outputs).toContain("collection_schema");
        const schemaDir = path.join(input.workspace_root, "collections", "movies");
        await mkdir(schemaDir, { recursive: true });
        await writeFile(path.join(schemaDir, "schema.json"), `${JSON.stringify({
          id: "movies",
          version: "1",
          labels: { ja: "映画ログ", en: "Movies" },
          descriptions: { ja: "映画を記録する個人用アプリ。", en: "A personal movie log." },
          fields: [
            { id: "title", type: "string", label: "タイトル", required: true },
            { id: "status", type: "enum", label: "状態", enum_values: ["観たい", "視聴中", "観た"] },
            { id: "rating", type: "number", label: "評価" }
          ],
          refs: [],
          embeds: [],
          derived_fields: [],
          triggers: [],
          actions: [],
          views: [{
            id: "movies_table",
            renderer: "collection_table",
            density: "comfortable",
            allow_delete: true,
            editable_fields: ["title", "status", "rating"]
          }],
          permissions: { create: true, update: true, delete: true }
        }, null, 2)}\n`);
        yield {
          event_type: "text_delta",
          payload: { text: "映画ログアプリを作成しました。" }
        };
        yield {
          event_type: "run_completed",
          payload: { output_summary: "done" }
        };
      }
    };
    const root = await mkdtemp(path.join(tmpdir(), "samurai-runtime-collection-file-"));
    roots.push(root);
    const store = await WorkspaceStore.create({ rootDir: root });
    const runtime = new AgentRuntime(store, undefined, undefined, new AgentBackendRegistry([fileBackend]));
    const session = await runtime.createSession();

    const result = await runtime.runSurfaceOperation({
      id: "surface_movies_app_from_file",
      kind: "message.submit",
      session_id: session.id,
      backend_id: "collection-schema-file",
      content: "映画ログアプリ作って",
      output_locale: "ja",
      renderer_capabilities: {
        protocol_version: "1",
        supported_kinds: ["chat", "custom_view", "collection"],
        custom_view_renderers: [{ renderer: "collection_table", versions: ["1"] }]
      }
    });
    const runs = await store.listBackendRuns(session.id);
    await store.close();

    expect(runs[0]).toMatchObject({
      backend_id: "collection-schema-file",
      status: "completed"
    });
    expect(result.render_specs?.some((spec) =>
      spec.kind === "custom_view" && spec.props.renderer === "collection_table"
    )).toBe(true);
  });

  it("does not create generic Collection apps before backend dispatch", async () => {
    const { store, runtime } = await createRuntime();
    const session = await runtime.createSession();

    await expect(runtime.runSurfaceOperation({
      id: "surface_movies_without_backend",
      kind: "message.submit",
      session_id: session.id,
      backend_id: "missing_backend",
      content: "映画ログアプリ作って",
      output_locale: "ja",
      renderer_capabilities: {
        protocol_version: "1",
        supported_kinds: ["chat", "custom_view", "collection"],
        custom_view_renderers: [{ renderer: "collection_table", versions: ["1"] }]
      }
    })).rejects.toMatchObject({
      code: "conflict",
      message: "backend_not_registered:missing_backend"
    });
    const schema = await store.getCollectionSchema("movies");
    await store.close();

    expect(schema).toBeUndefined();
  });

  it("validates tasks as a normal Collection without task_list-specific rules", async () => {
    const { store, runtime } = await createRuntime();
    await saveGenericTasksCollectionSchema(store);
    const now = nowIso();

    await expect(runtime.createCollectionRecord({
      id: "task_bad_title",
      collection_id: "tasks",
      data: { title: "", completed: false },
      resource_refs: [],
      created_at: now,
      updated_at: now
    })).rejects.toThrow("collection_required_field:title");
    await expect(runtime.createCollectionRecord({
      id: "task_bad_completed",
      collection_id: "tasks",
      data: { title: "買い物", completed: "no" },
      resource_refs: [],
      created_at: now,
      updated_at: now
    })).rejects.toThrow("collection_field_type:completed:boolean");
    await expect(runtime.createCollectionRecord({
      id: "task_bad_unknown",
      collection_id: "tasks",
      data: { title: "買い物", unexpected: true },
      resource_refs: [],
      created_at: now,
      updated_at: now
    })).rejects.toThrow("collection_unknown_field:unexpected");

    await runtime.createCollectionRecord({
      id: "task_1",
      collection_id: "tasks",
      data: { title: "買い物", completed: false },
      resource_refs: [],
      created_at: now,
      updated_at: now
    });
    const patched = await runtime.applyCollectionPatch({
      collectionId: "tasks",
      recordId: "task_1",
      patch: {
        id: "patch_task_done",
        record_id: "task_1",
        changes: { completed: true },
        source_operation_id: "operation_test",
        created_at: nowIso()
      }
    });
    await expect(runtime.applyCollectionPatch({
      collectionId: "tasks",
      recordId: "task_1",
      patch: {
        id: "patch_task_empty_title",
        record_id: "task_1",
        changes: { title: "" },
        source_operation_id: "operation_test",
        created_at: nowIso()
      }
    })).rejects.toThrow("collection_required_field:title");
    await store.close();

    expect(patched.resource.data.completed).toBe(true);
  });

  it("presents tasks through the generic Collection renderer", async () => {
    const { store, runtime } = await createRuntime();
    await saveGenericTasksCollectionSchema(store);

    await runtime.runSurfaceOperation({
      id: "surface_task_create",
      kind: "collection.record.create",
      collection_id: "tasks",
      record_id: "task_1",
      data: { title: "請求書を送る", completed: false, notes: "", due_date: "2026-07-10" },
      renderer_capabilities: {
        protocol_version: "1",
        supported_kinds: ["custom_view", "collection"],
        custom_view_renderers: [{ renderer: "collection_table", versions: ["1"] }]
      }
    });
    const view = await runtime.runSurfaceOperation({
      id: "surface_task_view",
      kind: "collection.view.present",
      collection_id: "tasks",
      view_id: "tasks_table",
      renderer_capabilities: {
        protocol_version: "1",
        supported_kinds: ["custom_view", "collection"],
        custom_view_renderers: [{ renderer: "collection_table", versions: ["1"] }]
      }
    });
    await store.close();

    expect(view.result_kind).toBe("collection_view");
    expect(view.render_spec).toMatchObject({
      kind: "custom_view",
      props: {
        renderer: "collection_table",
        actions: expect.arrayContaining([
          expect.objectContaining({ operation_kind: "collection.record.create" }),
          expect.objectContaining({ operation_kind: "collection.record.patch" }),
          expect.objectContaining({ operation_kind: "collection.record.delete" })
        ]),
        data: expect.objectContaining({
          collection_id: "tasks",
          record_ids: ["task_1"],
          records: [expect.objectContaining({ id: "task_1", title: "請求書を送る" })]
        })
      }
    });
  });

  it("deletes generic task records only when schema and view allow it", async () => {
    const { store, runtime } = await createRuntime();
    await saveGenericTasksCollectionSchema(store);
    await runtime.createCollectionRecord({
      id: "task_delete_ok",
      collection_id: "tasks",
      data: { title: "消すタスク", completed: false, notes: "", due_date: "" },
      resource_refs: [],
      created_at: nowIso(),
      updated_at: nowIso()
    });

    const deleted = await runtime.runSurfaceOperation({
      id: "surface_task_delete_ok",
      kind: "collection.record.delete",
      collection_id: "tasks",
      record_id: "task_delete_ok",
      view_id: "tasks_table",
      renderer_capabilities: {
        protocol_version: "1",
        supported_kinds: ["custom_view", "collection"],
        custom_view_renderers: [{ renderer: "collection_table", versions: ["1"] }]
      }
    });
    expect(deleted.result_kind).toBe("collection_delete");
    expect(deleted.render_spec.props.data).toMatchObject({ record_ids: [] });

    await runtime.createCollectionRecord({
      id: "task_delete_denied_by_permission",
      collection_id: "tasks",
      data: { title: "権限で消せない", completed: false, notes: "", due_date: "" },
      resource_refs: [],
      created_at: nowIso(),
      updated_at: nowIso()
    });
    const schema = await store.getCollectionSchema("tasks");
    await store.updateCollectionSchema({ ...schema!, permissions: { ...(schema?.permissions ?? {}), delete: false } });
    await expect(runtime.runSurfaceOperation({
      id: "surface_task_delete_denied_by_permission",
      kind: "collection.record.delete",
      collection_id: "tasks",
      record_id: "task_delete_denied_by_permission",
      view_id: "tasks_table"
    })).rejects.toThrow("collection_record_delete_not_allowed");

    await store.updateCollectionSchema({ ...schema!, permissions: { ...(schema?.permissions ?? {}), delete: true }, views: [{ ...(schema?.views?.[0] ?? {}), id: "tasks_table", renderer: "collection_table", allow_delete: false }] });
    await expect(runtime.runSurfaceOperation({
      id: "surface_task_delete_denied_by_view",
      kind: "collection.record.delete",
      collection_id: "tasks",
      record_id: "task_delete_denied_by_permission",
      view_id: "tasks_table"
    })).rejects.toThrow("collection_record_delete_not_allowed");
    await store.close();
  });

  it("runs Knowledge Wiki lifecycle Domain Commands through active retrieval and provenance", async () => {
    const { store, runtime } = await createRuntime();
    const proposal = await runtime.runDomainCommand({
      command_id: "wiki.proposal.create",
      idempotency_key: "wiki-lifecycle-proposal",
      payload: {
        title: "Domain Wiki lifecycle",
        slug: "domain-wiki-lifecycle",
        content: "# Domain Wiki lifecycle\n\ndomain-wiki-lifecycle-needle starts as a proposal.",
        content_locale: "ja",
        source_refs: [{
          kind: "backend_run",
          id: "run_domain_wiki_lifecycle",
          uri: "backend-runs/run_domain_wiki_lifecycle",
          label: "Domain wiki lifecycle run"
        }],
        provenance: {
          kind: "user_authored",
          summary: "Created through Domain Command lifecycle fixture.",
          verified: true
        }
      }
    });
    const proposalResult = proposal.result as Awaited<ReturnType<AgentRuntime["createWikiProposal"]>>;
    const rejected = await runtime.runDomainCommand({
      command_id: "wiki.proposal.create",
      idempotency_key: "wiki-lifecycle-rejected",
      payload: {
        title: "Rejected Domain Wiki lifecycle",
        slug: "rejected-domain-wiki-lifecycle",
        content: "# Rejected Domain Wiki lifecycle\n\ndomain-wiki-lifecycle-needle rejected.",
        content_locale: "ja"
      }
    });
    const rejectedResult = rejected.result as Awaited<ReturnType<AgentRuntime["createWikiProposal"]>>;
    const accepted = await runtime.runDomainCommand({
      command_id: "wiki.accept",
      idempotency_key: "wiki-lifecycle-accept",
      payload: { wiki_id: proposalResult.resource.id }
    });
    const patched = await runtime.runDomainCommand({
      command_id: "wiki.patch",
      idempotency_key: "wiki-lifecycle-patch",
      payload: {
        wiki_id: proposalResult.resource.id,
        title: "Domain Wiki lifecycle patched",
        content: "# Domain Wiki lifecycle patched\n\npatched-domain-wiki-lifecycle-needle is active.",
        source_refs: [{
          kind: "backend_run",
          id: "run_domain_wiki_patch",
          uri: "backend-runs/run_domain_wiki_patch",
          label: "Domain wiki patch run"
        }],
        provenance: {
          kind: "generated_local",
          summary: "Patched through Domain Command lifecycle fixture.",
          verified: false
        }
      }
    });
    const reject = await runtime.runDomainCommand({
      command_id: "wiki.reject",
      idempotency_key: "wiki-lifecycle-reject",
      payload: { wiki_id: rejectedResult.resource.id }
    });
    const activePreview = await runtime.previewKnowledgeWiki({ query: "patched-domain-wiki-lifecycle-needle" });
    const rejectedPreview = await runtime.previewKnowledgeWiki({ query: "domain-wiki-lifecycle-needle rejected" });
    const reindex = await runtime.runDomainCommand({
      command_id: "wiki.reindex",
      idempotency_key: "wiki-lifecycle-reindex",
      payload: {}
    });
    const archived = await runtime.runDomainCommand({
      command_id: "wiki.archive",
      idempotency_key: "wiki-lifecycle-archive",
      payload: { wiki_id: proposalResult.resource.id }
    });
    const afterArchivePreview = await runtime.previewKnowledgeWiki({ query: "patched-domain-wiki-lifecycle-needle" });
    const operations = await store.listOperations();
    await store.close();

    expect(proposal.render_spec).toMatchObject({
      kind: "knowledge_wiki",
      props: { state: "proposed", active_only: false }
    });
    expect(accepted).toMatchObject({
      command: { id: "wiki.accept" },
      render_spec: { kind: "knowledge_wiki", props: { state: "active", active_only: true } }
    });
    expect(patched).toMatchObject({
      command: { id: "wiki.patch" },
      render_spec: { kind: "knowledge_wiki", props: { state: "active" } }
    });
    expect(reject).toMatchObject({
      command: { id: "wiki.reject" },
      render_spec: { kind: "knowledge_wiki", props: { state: "rejected", active_only: false } }
    });
    expect(activePreview.knowledge_wiki).toContainEqual(expect.objectContaining({
      id: proposalResult.resource.id,
      title: "Domain Wiki lifecycle patched",
      source_refs: expect.arrayContaining([expect.objectContaining({ kind: "backend_run", id: "run_domain_wiki_patch" })]),
      provenance: expect.objectContaining({ kind: "generated_local", verified: false })
    }));
    expect(activePreview.report.included_wiki_ids).toContain(proposalResult.resource.id);
    expect(activePreview.graph.edges).toContainEqual(expect.objectContaining({
      from_wiki_id: proposalResult.resource.id,
      relation: "source_ref",
      to_ref: expect.objectContaining({
        kind: "backend_run",
        id: "run_domain_wiki_patch"
      })
    }));
    expect(rejectedPreview.knowledge_wiki.map((wiki) => wiki.id)).not.toContain(rejectedResult.resource.id);
    expect(rejectedPreview.report.excluded).toContainEqual(expect.objectContaining({
      id: rejectedResult.resource.id,
      reason: "rejected"
    }));
    expect(reindex).toMatchObject({
      command: { id: "wiki.reindex" },
      render_spec: { kind: "knowledge_wiki" }
    });
    expect(archived).toMatchObject({
      command: { id: "wiki.archive" },
      render_spec: { kind: "knowledge_wiki", props: { state: "archived", active_only: false } }
    });
    expect(afterArchivePreview.knowledge_wiki.map((wiki) => wiki.id)).not.toContain(proposalResult.resource.id);
    expect(afterArchivePreview.report.excluded).toContainEqual(expect.objectContaining({
      id: proposalResult.resource.id,
      reason: "archived"
    }));
    expect(operations.map((operation) => operation.operation)).toEqual(expect.arrayContaining([
      "wiki.proposal.create",
      "wiki.accept",
      "wiki.patch",
      "wiki.reject",
      "wiki.reindex",
      "wiki.archive"
    ]));
  });

  it("runs Skill lifecycle Domain Commands through support files and selected usage", async () => {
    const { store, runtime } = await createRuntime();
    const candidate = await runtime.runDomainCommand({
      command_id: "skill.candidate.create",
      idempotency_key: "skill-lifecycle-candidate",
      payload: {
        title: "調査メモ整理",
        description: "調査メモ references を短く整える",
        content: "# Skill\n\n- Keep the note short.\n- Use the references support file."
      }
    });
    const candidateResult = candidate.result as Awaited<ReturnType<AgentRuntime["createSkillCandidate"]>>;
    const project = await runtime.runDomainCommand({
      command_id: "skill.project.save",
      idempotency_key: "skill-lifecycle-project",
      payload: {
        candidate_id: candidateResult.resource.id
      }
    });
    const projectResult = project.result as Awaited<ReturnType<AgentRuntime["saveSkillProject"]>>;
    const support = await runtime.runDomainCommand({
      command_id: "skill.support_file.save",
      idempotency_key: "skill-lifecycle-support",
      payload: {
        skill_id: projectResult.resource.id,
        path: "references/style.md",
        content: "補助資料: 調査メモは箇条書きで短くする。"
      }
    });
    const session = await runtime.createSession();
    const chat = await runtime.runChatTurn({
      sessionId: session.id,
      content: "調査メモ references を使って",
      output_locale: "ja"
    });
    const context = await runtime.previewContext({
      sessionId: session.id,
      query: "調査メモ references"
    });
    const selectedUses = await store.listLearningResourceUses({ runId: chat.backendRun.id });
    const usageBeforeView = await store.listSkillUsage();
    const view = await runtime.viewSkill({
      skillId: projectResult.resource.id,
      runId: chat.backendRun.id,
      path: "references/style.md"
    });
    await runtime.viewSkill({ skillId: projectResult.resource.id, runId: chat.backendRun.id, path: "references/style.md" });
    await runtime.runDomainCommand({ command_id: "skill.usage.record", idempotency_key: "skill-lifecycle-usage", payload: view.usage });
    const usage = await store.listSkillUsage();
    await store.close();

    expect(candidate.render_spec).toMatchObject({ kind: "skill", props: { state: "candidate" } });
    expect(project.render_spec).toMatchObject({ kind: "skill", props: { state: "project" } });
    expect(support.render_spec).toMatchObject({
      kind: "skill",
      props: {
        skill_ids: [projectResult.resource.id],
        disclosure_level: "support",
        support_file_path: "references/style.md"
      }
    });
    expect(context.selected_skills).toContainEqual(expect.objectContaining({
      id: projectResult.resource.id,
      disclosure_level: "catalog",
      support_file_refs: [expect.objectContaining({
        path: "references/style.md"
      })],
      support_files: undefined,
      content: undefined
    }));
    expect(context.selected_skills.find((item) => item.id === projectResult.resource.id)?.support_files?.[0]?.file_path)
      .toBeUndefined();
    expect(selectedUses).toContainEqual(expect.objectContaining({
      resource_id: projectResult.resource.id,
      stage: "selected"
    }));
    expect(usageBeforeView.some((row) => row.skill_id === projectResult.resource.id)).toBe(false);
    expect(view).toMatchObject({ disclosure_level: "support", content: "補助資料: 調査メモは箇条書きで短くする。" });
    expect(usage).toContainEqual(expect.objectContaining({ skill_id: projectResult.resource.id, use_count: 1 }));
  });

  it("turns reflection Skill suggestions into supported project Skills with usage", async () => {
    const { store, runtime } = await createRuntime();
    const session = await runtime.createSession();
    const now = nowIso();
    await store.saveMessage({
      id: createId("message"),
      session_id: session.id,
      role: "user",
      content: "次から差分確認 references を使って、保存前に短く確認して",
      input_locale: "ja",
      output_locale: "ja",
      created_at: now
    });
    await store.saveMessage({
      id: createId("message"),
      session_id: session.id,
      role: "agent",
      content: "了解、次回から差分確認を先に入れます。",
      input_locale: "ja",
      output_locale: "ja",
      created_at: now
    });

    const reflectionRun = await store.createReflectionRun({
      id: createId("reflection"), kind: "manual", session_id: session.id, status: "completed",
      input_summary: "legacy compatibility", output_summary: "legacy suggestion", started_at: now, completed_at: now
    });
    const suggestion = await store.saveReflectionSuggestion({
      id: createId("suggestion"), reflection_run_id: reflectionRun.id, suggestion_type: "skill", status: "proposed",
      title: "差分確認", content: "保存前に差分確認する", source_refs: [], confidence: 0.8, created_at: now, updated_at: now
    });
    const applied = await runtime.runDomainCommand({
      command_id: "reflection.suggestion.apply",
      idempotency_key: "reflection-skill-apply",
      payload: { suggestion_id: suggestion.id }
    });
    const appliedResult = applied.result as Awaited<ReturnType<AgentRuntime["applyReflectionSuggestion"]>>;
    const appliedSkill = appliedResult.resource as {
      id: string;
      state: string;
      frontmatter?: Pick<SkillFrontmatter, "source_refs" | "provenance_detail">;
    };
    const project = await runtime.runDomainCommand({
      command_id: "skill.project.save",
      idempotency_key: "reflection-skill-project",
      payload: { candidate_id: appliedSkill.id }
    });
    const projectResult = project.result as Awaited<ReturnType<AgentRuntime["saveSkillProject"]>>;
    await runtime.runDomainCommand({
      command_id: "skill.support_file.save",
      idempotency_key: "reflection-skill-support",
      payload: {
        skill_id: projectResult.resource.id,
        path: "references/diff-check.md",
        content: "補助資料: 差分確認は保存前に3点だけ見る。"
      }
    });

    await runtime.runChatTurn({
      sessionId: session.id,
      content: "差分確認 references を使って保存前チェックをして",
      output_locale: "ja"
    });
    const context = await runtime.previewContext({
      sessionId: session.id,
      query: "差分確認 references"
    });
    const refreshedSuggestion = (await store.listReflectionSuggestions()).find((item) => item.id === suggestion.id);
    const usage = await store.getSkillUsage(projectResult.resource.id);
    await store.close();

    expect(applied).toMatchObject({
      command: { id: "reflection.suggestion.apply" },
      render_spec: { kind: "skill" }
    });
    expect(appliedResult.operation.operation).toBe("reflection.suggestion.apply");
    expect(appliedSkill.state).toBe("candidate");
    expect(appliedSkill.frontmatter?.source_refs ?? []).toEqual([]);
    expect(appliedSkill.frontmatter?.provenance_detail).toMatchObject({ kind: "generated_local", verified: false });
    expect(refreshedSuggestion).toMatchObject({
      status: "applied",
      target_ref: expect.objectContaining({ kind: "skill", id: appliedSkill.id })
    });
    expect(project).toMatchObject({
      command: { id: "skill.project.save" },
      render_spec: { kind: "skill", props: { state: "project" } }
    });
    const selectedSkill = context.selected_skills.find((item) => item.id === projectResult.resource.id);
    expect(selectedSkill).toMatchObject({
      disclosure_level: "catalog",
      support_file_refs: [expect.objectContaining({
        path: "references/diff-check.md"
      })],
      support_files: undefined,
      content: undefined,
      usage: undefined
    });
    expect(selectedSkill?.selection_reason).toContain("Catalog match only");
    expect(usage).toBeUndefined();
  });

  it("keeps plain chat as content without creating artifacts", async () => {
    const { store, runtime } = await createRuntime();
    const session = await runtime.createSession();
    const result = await runtime.runChatTurn({
      sessionId: session.id,
      content: "こんにちは",
      output_locale: "ja"
    });
    await store.close();

    expect(result.messages.find((message) => message.role === "agent")?.content).toBe("対応しました。");
    expect(result.artifacts).toEqual([]);
    expect(result.operations.some((operation) => operation.operation === "artifact.create")).toBe(false);
  });

  it("runs message surface operations through backend events, workspace feedback, and reflection", async () => {
    const { store, runtime } = await createRuntime();
    const session = await runtime.createSession();

    const envelope = await runtime.runSurfaceOperation({
      id: "surface_message_vertical",
      kind: "message.submit",
      session_id: session.id,
      content: "提案書を作って",
      output_locale: "ja"
    });
    const result = envelope.result as {
      backendRun: { status: string; metadata: Record<string, unknown> };
      backendEvents: Array<{ event_type: string }>;
      workspaceChanges: Array<{ change_type: string }>;
      reflectionRuns: Array<{ status: string }>;
      reflectionSuggestions: Array<{ suggestion_type: string; source_refs: Array<{ kind: string }> }>;
      artifacts: Array<{ title: string }>;
    };
    const reflectionRuns = await store.listReflectionRuns();
    await store.close();

    expect(envelope.result_kind).toBe("chat_turn");
    expect(envelope.render_spec.kind).toBe("chat");
    expect(result.backendRun.status).toBe("completed");
    expect(result.backendRun.metadata).toMatchObject({
      surface_operation_id: "surface_message_vertical",
      surface_operation_kind: "message.submit"
    });
    expect(result.backendEvents.some((event) => event.event_type === "run_started")).toBe(true);
    expect(result.backendEvents.some((event) => event.event_type === "artifact_created")).toBe(true);
    expect(result.backendEvents.some((event) => event.event_type === "run_completed")).toBe(true);
    expect(result.workspaceChanges.some((change) => change.change_type === "artifact_created")).toBe(true);
    expect(result.artifacts[0]?.title).toBe("作業メモ");
    expect(result.reflectionRuns.some((run) => run.status === "completed")).toBe(true);
    expect(result.reflectionSuggestions).toEqual([]);
    expect(reflectionRuns.some((run) => run.status === "completed")).toBe(true);
  });

  it("routes a chat turn through the selected agent backend", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-runtime-"));
    roots.push(root);
    const store = await WorkspaceStore.create({ rootDir: root });
    const runtime = new AgentRuntime(store, undefined, undefined, new AgentBackendRegistry([new MockBackend()]));
    const session = await runtime.createSession();

    const result = await runtime.runChatTurn({
      sessionId: session.id,
      content: "選択backendで実行して",
      output_locale: "ja",
      backend_id: "mock"
    });
    await store.close();

    expect(result.backendRun.backend_id).toBe("mock");
    expect(result.backendRun.backend_kind).toBe("mock");
    expect(result.backendRun.metadata.freeze_snapshot_hash).toBeTruthy();
    expect(result.messages.find((message) => message.role === "agent")?.content).toContain("Mock response");
  });

  it("prefers configured Codex over Native when no backend is selected", async () => {
    const codexBackend: AgentBackend = {
      id: "codex",
      kind: "codex",
      label: "Codex Fixture",
      getStatus() {
        return {
          id: "codex",
          kind: "codex",
          label: "Codex Fixture",
          configured: true,
          enabled: true,
          connection_state: "ready",
          supports: {
            start_session: true,
            resume_run: false,
            cancel_run: false,
            stream_events: false
          }
        };
      },
      async *runTurn() {
        yield { event_type: "text_delta", payload: { text: "Codex fixture response." } };
        yield { event_type: "run_completed", payload: { output_summary: "done" } };
      }
    };
    const root = await mkdtemp(path.join(tmpdir(), "samurai-runtime-default-codex-"));
    roots.push(root);
    const store = await WorkspaceStore.create({ rootDir: root });
    const runtime = new AgentRuntime(store, undefined, undefined, new AgentBackendRegistry([new MockBackend(), codexBackend]));
    const session = await runtime.createSession();

    const result = await runtime.runChatTurn({
      sessionId: session.id,
      content: "backend未指定で実行して",
      output_locale: "ja"
    });
    await store.close();

    expect(result.backendRun.backend_id).toBe("codex");
    expect(result.messages.find((message) => message.role === "agent")?.content).toContain("Codex fixture response");
  });

  it("records backend-native session ids from backend events", async () => {
    const sessionAwareBackend: AgentBackend = {
      id: "session-aware",
      kind: "external",
      label: "Session Aware Fixture",
      async *runTurn() {
        yield {
          event_type: "run_started",
          payload: {
            backend_session_id: "native-session-42",
            input_summary: "started"
          }
        };
        yield {
          event_type: "text_delta",
          payload: { text: "native session captured" }
        };
        yield {
          event_type: "run_completed",
          payload: {
            output_summary: "done"
          }
        };
      }
    };
    const root = await mkdtemp(path.join(tmpdir(), "samurai-runtime-"));
    roots.push(root);
    const store = await WorkspaceStore.create({ rootDir: root });
    const runtime = new AgentRuntime(store, undefined, undefined, new AgentBackendRegistry([sessionAwareBackend]));
    const session = await runtime.createSession();

    const result = await runtime.runChatTurn({
      sessionId: session.id,
      content: "native session を保存して",
      output_locale: "ja",
      backend_id: "session-aware"
    });
    const savedRun = await store.getBackendRun(result.backendRun.id);
    await store.close();

    expect(result.backendRun.metadata).toMatchObject({
      backend_session_id: "native-session-42",
      backend_session_source_event: "run_started"
    });
    expect(savedRun?.metadata.backend_session_id).toBe("native-session-42");
  });

  it("does not inject Session Search into short greeting backend input", async () => {
    let capturedSessionSearch: unknown;
    let capturedActiveMemory: unknown;
    let capturedKnowledgeWiki: unknown;
    let capturedSelectedSkills: unknown;
    let capturedFreezeSnapshot: unknown;
    let capturedContextIntent: unknown;
    const captureBackend: AgentBackend = {
      id: "capture-context",
      kind: "external",
      label: "Capture Context Fixture",
      async *runTurn(input) {
        capturedSessionSearch = input.session_search;
        capturedActiveMemory = input.active_memory;
        capturedKnowledgeWiki = input.knowledge_wiki;
        capturedSelectedSkills = input.selected_skills;
        capturedFreezeSnapshot = input.freeze_snapshot;
        capturedContextIntent = input.context_intent;
        yield {
          event_type: "text_delta",
          payload: { text: "こんにちは" }
        };
        yield {
          event_type: "run_completed",
          payload: { output_summary: "ok" }
        };
      }
    };
    const root = await mkdtemp(path.join(tmpdir(), "samurai-runtime-"));
    roots.push(root);
    const store = await WorkspaceStore.create({ rootDir: root });
    const runtime = new AgentRuntime(store, undefined, undefined, new AgentBackendRegistry([captureBackend]));
    const previous = await runtime.createSession({ title: "Samurai Agent の続き" });
    await store.saveMessage({
      id: createId("message"),
      session_id: previous.id,
      role: "user",
      content: "Samurai Agent の続き",
      input_locale: "ja",
      output_locale: "ja",
      created_at: nowIso()
    });
    const session = await runtime.createSession();

    const result = await runtime.runChatTurn({
      sessionId: session.id,
      content: "こんにちは",
      output_locale: "ja",
      backend_id: "capture-context"
    });
    await store.close();

    expect(capturedSessionSearch).toEqual([]);
    expect(capturedActiveMemory).toEqual([]);
    expect(capturedKnowledgeWiki).toEqual([]);
    expect(capturedSelectedSkills).toEqual([]);
    expect(capturedFreezeSnapshot).toBeUndefined();
    expect(capturedContextIntent).toBe("light_chat");
    expect(result.backendRun.metadata.context_assembly_sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "session_search", included_count: 0, status: "skipped" }),
      expect.objectContaining({ kind: "freeze_snapshot", included_count: 0, status: "skipped" }),
      expect.objectContaining({ kind: "active_memory", included_count: 0, status: "skipped" }),
      expect.objectContaining({ kind: "knowledge_wiki", included_count: 0, status: "skipped" }),
      expect.objectContaining({ kind: "selected_skills", included_count: 0, status: "skipped" })
    ]));
    expect(result.backendRun.metadata.context_intent).toBe("light_chat");
  });

  it("continues workspace tasks when Session Search is slow", async () => {
    vi.useFakeTimers();
    let backendCalled = false;
    const captureBackend: AgentBackend = {
      id: "slow-context-capture",
      kind: "external",
      label: "Slow Context Capture Fixture",
      async *runTurn(input) {
        backendCalled = true;
        expect(input.session_search).toEqual([]);
        yield {
          event_type: "text_delta",
          payload: { text: "作業メモを作りました" }
        };
        yield {
          event_type: "run_completed",
          payload: { output_summary: "ok" }
        };
      }
    };
    const root = await mkdtemp(path.join(tmpdir(), "samurai-runtime-"));
    roots.push(root);
    const store = await WorkspaceStore.create({ rootDir: root });
    vi.spyOn(store, "search").mockImplementation(() => new Promise(() => undefined) as never);
    const runtime = new AgentRuntime(store, undefined, undefined, new AgentBackendRegistry([captureBackend]));
    const session = await runtime.createSession();

    const runPromise = runtime.runChatTurn({
      sessionId: session.id,
      content: "作業メモを作ってください",
      output_locale: "ja",
      backend_id: "slow-context-capture"
    });
    await vi.advanceTimersByTimeAsync(2_100);
    const result = await runPromise;
    const sessionSearchSource = result.backendRun.metadata.context_assembly_sources;
    await store.close();
    vi.useRealTimers();

    expect(backendCalled).toBe(true);
    expect(sessionSearchSource).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "session_search", included_count: 0, status: "skipped" })
    ]));
  });

  it("records workspace working directory metadata for backend runs", async () => {
    let capturedWorkingDirectory: string | undefined;
    const root = await mkdtemp(path.join(tmpdir(), "samurai-runtime-workspace-"));
    roots.push(root);
    const repoRoot = path.join(root, "repo");
    await mkdir(repoRoot, { recursive: true });
    const store = await WorkspaceStore.create({ rootDir: root });
    const captureBackend: AgentBackend = {
      id: "capture-working-dir",
      kind: "external",
      label: "Capture Working Dir",
      async *runTurn(input) {
        capturedWorkingDirectory = input.working_directory;
        yield { event_type: "run_completed", payload: { output_summary: "ok" } };
      }
    };
    const runtime = new AgentRuntime(
      store,
      undefined,
      undefined,
      new AgentBackendRegistry([captureBackend]),
      undefined,
      undefined,
      undefined,
      { backendWorkingDirectoryMode: "repo", repoRoot }
    );
    const session = await runtime.createSession();

    const result = await runtime.runChatTurn({
      sessionId: session.id,
      content: "repo mode check",
      backend_id: "capture-working-dir"
    });
    await store.close();

    expect(capturedWorkingDirectory).toBe(repoRoot);
    expect(result.backendRun.metadata).toMatchObject({
      workspace_root: root,
      working_directory: repoRoot,
      backend_working_directory_mode: "repo"
    });
  });

  it("stores a diagnostic message when backend completes without body or artifacts", async () => {
    const emptyBackend: AgentBackend = {
      id: "empty-complete",
      kind: "external",
      label: "Empty Complete Fixture",
      async *runTurn() {
        yield {
          event_type: "run_completed",
          payload: {}
        };
      }
    };
    const root = await mkdtemp(path.join(tmpdir(), "samurai-runtime-"));
    roots.push(root);
    const store = await WorkspaceStore.create({ rootDir: root });
    const runtime = new AgentRuntime(store, undefined, undefined, new AgentBackendRegistry([emptyBackend]));
    const session = await runtime.createSession();

    const result = await runtime.runChatTurn({
      sessionId: session.id,
      content: "本文なし完了fixture",
      output_locale: "ja",
      backend_id: "empty-complete"
    });
    await store.close();

    const agentMessage = result.messages.find((message) => message.role === "agent");
    expect(agentMessage?.content).toBe("結果本文を受け取れませんでした。実行ログを確認してください。");
    expect(result.backendRun.output_summary).toBe("結果本文を受け取れませんでした。実行ログを確認してください。");
  });

  it("lets external backend fixtures create Artifacts through the Samurai tool bridge", async () => {
    let runtime: AgentRuntime;
    const bridgeBackend: AgentBackend = {
      id: "bridge-backend",
      kind: "codex",
      label: "Bridge Backend Fixture",
      async *runTurn(input) {
        expect(input.tool_bridge?.enabled).toBe(true);
        expect(input.tool_bridge?.server_name).toBe("samurai");
        await runtime.runBackendToolBridgeCall({
          runId: input.run_id,
          token: input.tool_bridge?.token ?? "",
          toolName: "artifact_create",
          toolCallId: "bridge_tool_1",
          toolInput: {
            title: "作業メモ",
            content: "# 作業メモ\n\nTool Bridgeから作成しました。"
          }
        });
        yield {
          event_type: "text_delta",
          payload: { text: "作業メモを作成しました。" }
        };
        yield {
          event_type: "run_completed",
          payload: { output_summary: "done" }
        };
      }
    };
    const root = await mkdtemp(path.join(tmpdir(), "samurai-runtime-bridge-"));
    roots.push(root);
    const store = await WorkspaceStore.create({ rootDir: root });
    runtime = new AgentRuntime(store, undefined, undefined, new AgentBackendRegistry([bridgeBackend]));
    const session = await runtime.createSession();

    const result = await runtime.runChatTurn({
      sessionId: session.id,
      content: "作業メモを作って",
      output_locale: "ja",
      backend_id: "bridge-backend"
    });
    const content = result.artifacts[0] ? await store.readArtifactContent(result.artifacts[0].id) : undefined;
    await store.close();

    expect(result.artifacts).toContainEqual(expect.objectContaining({
      title: "作業メモ"
    }));
    expect(content).toContain("Tool Bridgeから作成しました。");
    expect(result.workspaceChanges).toContainEqual(expect.objectContaining({
      change_type: "artifact_created"
    }));
    expect(result.toolRuns).toContainEqual(expect.objectContaining({
      provider_tool_name: "samurai.artifact.create",
      action_id: "artifact.create",
      status: "completed"
    }));
  });

  it("routes streaming provider tool aliases through Domain Commands", async () => {
    const streamingToolBackend: AgentBackend = {
      id: "streaming-tool",
      kind: "external",
      label: "Streaming Tool Fixture",
      async *runTurn() {
        yield {
          event_type: "run_started",
          payload: {
            input_summary: "started"
          }
        };
        yield {
          event_type: "tool_call_started",
          tool_call_id: "send_tool_1",
          payload: {
            tool_call_id: "send_tool_1",
            provider_tool_name: "request_external_send",
            arguments: {
              channel: "email",
              target: { to: "demo@example.com" },
              title: "Domain command send draft",
              body: "外部送信のdraftだけ作る"
            }
          }
        };
        yield {
          event_type: "run_completed",
          payload: {
            output_summary: "done"
          }
        };
      }
    };
    const root = await mkdtemp(path.join(tmpdir(), "samurai-runtime-"));
    roots.push(root);
    const store = await WorkspaceStore.create({ rootDir: root });
    const runtime = new AgentRuntime(store, undefined, undefined, new AgentBackendRegistry([streamingToolBackend]));
    const session = await runtime.createSession();

    const result = await runtime.runChatTurn({
      sessionId: session.id,
      content: "外部送信draftを作って",
      output_locale: "ja",
      backend_id: "streaming-tool"
    });
    await store.close();

    expect(result.operations.some((operation) => operation.operation === "external.send.prepare")).toBe(true);
    expect(result.backendEvents.some((event) =>
      event.event_type === "tool_call_output"
      && event.payload.status === "completed"
      && event.payload.action_id === "external.send.prepare"
    )).toBe(true);
    expect(result.toolRuns).toContainEqual(expect.objectContaining({
      provider_tool_name: "request_external_send",
      action_id: "external.send.prepare",
      status: "completed"
    }));
  });

  it("adds recent backend run failures to backend status metadata", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-runtime-"));
    roots.push(root);
    const store = await WorkspaceStore.create({ rootDir: root });
    const runtime = new AgentRuntime(store, undefined, undefined, new AgentBackendRegistry([new MockBackend()]));
    const session = await runtime.createSession();
    const now = nowIso();
    await store.saveBackendRun({
      id: "run_failed_status",
      session_id: session.id,
      input_message_id: "message_failed_status",
      backend_id: "mock",
      backend_kind: "mock",
      status: "failed",
      started_at: now,
      completed_at: now,
      input_summary: "failed status",
      output_summary: "Provider failed.",
      error_code: "provider_failed",
      metadata: {}
    });

    const statuses = await runtime.listAgentBackends();
    await store.close();

    expect(statuses.find((status) => status.id === "mock")).toMatchObject({
      connection_state: "degraded",
      reason: "provider_failed",
      metadata: {
        last_run_id: "run_failed_status",
        last_run_status: "failed",
        last_error_code: "provider_failed",
        recent_failure_count: 1
      }
    });
  });

  it("rejects unknown agent backend ids before creating a run", async () => {
    const { store, runtime } = await createRuntime();
    const session = await runtime.createSession();

    await expect(
      runtime.runChatTurn({
        sessionId: session.id,
        content: "存在しないbackend",
        output_locale: "ja",
        backend_id: "missing"
      })
    ).rejects.toMatchObject({
      code: "conflict",
      message: "backend_not_registered:missing"
    });
    await store.close();
  });

  it("passes only sanitized gateway boundary snapshots to the native provider", async () => {
    let capturedInput: ProviderInput | undefined;
    const root = await mkdtemp(path.join(tmpdir(), "samurai-runtime-"));
    roots.push(root);
    const store = await WorkspaceStore.create({ rootDir: root });
    const runtime = new AgentRuntime(store, undefined, new FakeProviderAdapter("fake/test", (input) => {
      capturedInput = input;
      return { content: "Done.", toolCalls: [] };
    }));
    const session = await runtime.createSession();
    const now = "2026-01-01T00:00:00.000Z";
    const boundary: GatewayBoundaryPolicy = {
      id: "gateway_boundary_secret_test",
      source_channel: "webhook",
      source_identity: "secret-source",
      session_key: "webhook:secret-source:main",
      allowed_tools: ["artifact.create"],
      mcp_config_refs: [
        {
          id: "mcp_calendar",
          server_name: "calendar",
          allowed_tools: ["calendar.read"],
          secret_refs: [
            {
              id: "secret_mcp_calendar",
              source: "env",
              provider: "default",
              key: "MCP_CALENDAR_TOKEN"
            }
          ]
        }
      ],
      secret_refs: [
        {
          id: "secret_direct",
          source: "env",
          provider: "default",
          key: "DIRECT_WEBHOOK_TOKEN"
        }
      ],
      sandbox: {
        mode: "non_main",
        scope: "session",
        backend: "none",
        workspace_access: "none",
        network_access: "none",
        allowed_paths: [],
        denied_paths: [],
        metadata: {}
      },
      path_normalization: {
        canonical_root: "workspace",
        reject_absolute_paths: true,
        reject_parent_segments: true,
        allowed_roots: ["workspace"],
        denied_roots: []
      },
      allowlist: ["webhook:secret-source"],
      concurrency_lock: {
        scope: "session",
        key: "webhook:secret-source:main",
        ttl_ms: 60_000
      },
      metadata: {},
      created_at: now,
      updated_at: now
    };

    const result = await runtime.runChatTurn({
      sessionId: session.id,
      content: "境界付きで実行",
      gateway_boundary_policy: boundary,
      metadata: {
        api_key: "raw-api-key",
        nested: {
          authorization: "Bearer raw-token",
          note: "key=raw-key"
        }
      }
    });
    await store.close();

    const serializedBoundary = JSON.stringify(capturedInput?.gatewayBoundary);
    expect(capturedInput?.gatewayBoundary).toMatchObject({
      policy_id: boundary.id,
      secret_ref_ids: ["secret_direct", "secret_mcp_calendar"],
      mcp_config_refs: [
        {
          id: "mcp_calendar",
          server_name: "calendar",
          secret_ref_ids: ["secret_mcp_calendar"]
        }
      ]
    });
    expect(serializedBoundary).not.toContain("DIRECT_WEBHOOK_TOKEN");
    expect(serializedBoundary).not.toContain("MCP_CALENDAR_TOKEN");
    expect(capturedInput?.envelope.metadata).toMatchObject({
      source: "web",
      actor_identity: "owner",
      instruction_source: "owner_instruction",
      channel: "web",
      session_key: "web:owner:main"
    });
    expect(result.backendRun.metadata.gateway_boundary_secret_ref_ids).toEqual(["secret_direct", "secret_mcp_calendar"]);
    expect(JSON.stringify(result.backendRun.metadata)).not.toContain("DIRECT_WEBHOOK_TOKEN");
    expect(JSON.stringify(result.backendRun.metadata)).not.toContain("MCP_CALENDAR_TOKEN");
    expect(JSON.stringify(capturedInput?.envelope.metadata)).not.toContain("raw-api-key");
    expect(JSON.stringify(capturedInput?.envelope.metadata)).not.toContain("raw-token");
    expect(JSON.stringify(result.backendRun.metadata)).not.toContain("raw-api-key");
    expect(JSON.stringify(result.backendRun.metadata)).not.toContain("raw-token");
    expect(result.backendRun.metadata.api_key).toBe("[redacted]");
  });

  it("records gateway boundary allow decisions on completed tool runs", async () => {
    const { store, runtime } = await createRuntime();
    const session = await runtime.createSession();
    const boundary = gatewayBoundaryPolicy(["artifact.create"]);

    const result = await runtime.runChatTurn({
      sessionId: session.id,
      content: "draft a note",
      output_locale: "en",
      gateway_boundary_policy: boundary
    });
    await store.close();

    expect(result.artifacts.length).toBeGreaterThan(0);
    expect(result.backendEvents).toContainEqual(expect.objectContaining({
      event_type: "tool_call_started",
      payload: expect.objectContaining({
        provider_tool_name: "create_artifact",
        action_id: "artifact.create",
        execution_boundary: "host_runtime",
        requires_host_execution: true
      })
    }));
    expect(result.toolRuns).toContainEqual(expect.objectContaining({
      action_id: "artifact.create",
      status: "completed",
      resource_refs: expect.arrayContaining([
        expect.objectContaining({ kind: "gateway_boundary_policy", id: boundary.id })
      ])
    }));
    expect(result.backendEvents).toContainEqual(expect.objectContaining({
      event_type: "tool_call_output",
      payload: expect.objectContaining({
        status: "completed",
        action_id: "artifact.create",
        gateway_boundary: expect.objectContaining({
          decision: "allowed",
          action_id: "artifact.create",
          reason: "explicit_allow",
          policy_id: boundary.id,
          allowed_tools: ["artifact.create"]
        })
      })
    }));
  });

  it("executes allowed MCP calls through stored stdio config from runtime tool events", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-runtime-mcp-"));
    roots.push(root);
    const store = await WorkspaceStore.create({ rootDir: root });
    const serverPath = path.join(root, "calendar-mcp.cjs");
    await writeFile(serverPath, `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
let id = 0;
function send(result) {
  process.stdout.write(JSON.stringify(result) + "\\n");
}
rl.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") {
    send({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2024-11-05", capabilities: {} } });
    return;
  }
  if (request.method === "tools/call") {
    send({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        content: [{ type: "text", text: "calendar ok " + process.env.CALENDAR_TOKEN + " " + request.params.arguments.range }]
      }
    });
    return;
  }
  if (request.id) {
    send({ jsonrpc: "2.0", id: request.id, result: { ok: true, id: ++id } });
  }
});
`);
    const now = nowIso();
    const secret = "runtime-calendar-secret";
    process.env.CALENDAR_TOKEN = secret;
    const config: GatewayMcpConfigRecord = {
      id: "gateway_mcp_calendar_runtime",
      server_name: "calendar",
      transport: "stdio",
      enabled: true,
      allowed_tools: ["calendar.read"],
      secret_refs: [{
        id: "secret_calendar_runtime",
        source: "env",
        provider: "calendar",
        key: "CALENDAR_TOKEN"
      }],
      stdio: {
        command: process.execPath,
        args: [serverPath],
        env: {},
        secret_env: { CALENDAR_TOKEN: "secret_calendar_runtime" },
        secret_files: [],
        framing: "json_lines",
        initialize: true,
        timeout_ms: 2000
      },
      metadata: {},
      created_at: now,
      updated_at: now
    };
    await store.saveGatewayMcpConfig(config);
    const runtime = new AgentRuntime(
      store,
      undefined,
      new FakeProviderAdapter("fake/mcp", () => ({
        content: "MCPを実行しました。",
        toolCalls: [{
          name: "mcp.call",
          arguments: {
            server_name: "calendar",
            tool_name: "calendar.read",
            input: { range: "today" }
          }
        }]
      }))
    );
    const session = await runtime.createSession();
    const boundary: GatewayBoundaryPolicy = {
      ...gatewayBoundaryPolicy(["mcp.call"]),
      mcp_config_refs: [{
        id: config.id,
        server_name: config.server_name,
        allowed_tools: ["calendar.read"],
        secret_refs: config.secret_refs
      }]
    };

    const result = await runtime.runChatTurn({
      sessionId: session.id,
      content: "calendar read",
      output_locale: "ja",
      gateway_boundary_policy: boundary
    });
    delete process.env.CALENDAR_TOKEN;
    await store.close();

    const outputEvent = result.backendEvents.find((event) =>
      event.event_type === "tool_call_output"
      && event.payload.action_id === "mcp.call"
    );
    expect(result.operations).toContainEqual(expect.objectContaining({
      operation: "mcp.call",
      status: "completed",
      result_ref: expect.objectContaining({ kind: "gateway_mcp_config", id: config.id })
    }));
    expect(result.toolRuns).toContainEqual(expect.objectContaining({
      provider_tool_name: "mcp.call",
      action_id: "calendar/calendar.read",
      status: "completed",
      resource_refs: expect.arrayContaining([
        expect.objectContaining({ kind: "gateway_mcp_config", id: config.id }),
        expect.objectContaining({ kind: "gateway_boundary_policy", id: boundary.id })
      ])
    }));
    expect(outputEvent?.payload).toMatchObject({
      status: "completed",
      action_id: "mcp.call",
      server_name: "calendar",
      tool_name: "calendar.read",
      secret_resolution: {
        secret_ref_ids: ["secret_calendar_runtime"],
        resolved_secret_ref_ids: ["secret_calendar_runtime"],
        unresolved_secret_ref_ids: []
      }
    });
    expect(JSON.stringify(outputEvent?.payload)).toContain("[redacted:secret_calendar_runtime]");
    expect(JSON.stringify(outputEvent?.payload)).not.toContain(secret);
    expect(JSON.stringify(outputEvent?.payload)).not.toContain("CALENDAR_TOKEN");
  });

  it("executes allowed sandbox commands from runtime tool events with redacted SecretRef output", async () => {
    const { store, runtime } = await createRuntime();
    const session = await runtime.createSession();
    const secret = "runtime-sandbox-secret";
    process.env.SANDBOX_RUNTIME_TOKEN = secret;
    const sandboxRuntime = new AgentRuntime(
      store,
      undefined,
      new FakeProviderAdapter("fake/sandbox", () => ({
        content: "Sandboxを実行しました。",
        toolCalls: [{
          name: "sandbox.exec",
          arguments: {
            command: process.execPath,
            args: ["-e", "console.log(process.env.SECRET_VALUE)"],
            secret_env: { SECRET_VALUE: "secret_sandbox_runtime" }
          }
        }]
      }))
    );
    const boundary: GatewayBoundaryPolicy = {
      ...gatewayBoundaryPolicy(["sandbox.exec"]),
      secret_refs: [{
        id: "secret_sandbox_runtime",
        source: "env",
        provider: "test",
        key: "SANDBOX_RUNTIME_TOKEN"
      }],
      sandbox: {
        mode: "all",
        scope: "session",
        backend: "none",
        workspace_access: "none",
        network_access: "none",
        allowed_paths: [],
        denied_paths: [],
        timeout_ms: 2000,
        metadata: {}
      }
    };

    const result = await sandboxRuntime.runChatTurn({
      sessionId: session.id,
      content: "sandbox exec",
      output_locale: "ja",
      gateway_boundary_policy: boundary
    });
    delete process.env.SANDBOX_RUNTIME_TOKEN;
    await store.close();

    const outputEvent = result.backendEvents.find((event) =>
      event.event_type === "tool_call_output"
      && event.payload.action_id === "sandbox.exec"
    );
    expect(result.operations).toContainEqual(expect.objectContaining({
      operation: "sandbox.exec",
      status: "completed",
      result_ref: expect.objectContaining({ kind: "gateway_sandbox_execution" })
    }));
    expect(result.toolRuns).toContainEqual(expect.objectContaining({
      provider_tool_name: "sandbox.exec",
      action_id: "sandbox.exec",
      status: "completed",
      resource_refs: expect.arrayContaining([
        expect.objectContaining({ kind: "gateway_sandbox_execution" }),
        expect.objectContaining({ kind: "gateway_boundary_policy", id: boundary.id })
      ])
    }));
    expect(outputEvent?.payload).toMatchObject({
      status: "completed",
      action_id: "sandbox.exec",
      stdout: "[redacted:secret_sandbox_runtime]\n",
      secret_resolution: {
        secret_ref_ids: ["secret_sandbox_runtime"],
        resolved_secret_ref_ids: ["secret_sandbox_runtime"],
        unresolved_secret_ref_ids: []
      }
    });
    expect(JSON.stringify(outputEvent?.payload)).not.toContain(secret);
    expect(JSON.stringify(outputEvent?.payload)).not.toContain("SANDBOX_RUNTIME_TOKEN");
  });

  it("records sandbox lifecycle instances for sandboxed runtime tool events", async () => {
    const { store, runtime } = await createRuntime();
    const session = await runtime.createSession();
    const pathBeforeTest = process.env.PATH;
    const emptyPathRoot = await mkdtemp(path.join(tmpdir(), "samurai-runtime-empty-path-"));
    roots.push(emptyPathRoot);
    const sandboxRuntime = new AgentRuntime(
      store,
      undefined,
      new FakeProviderAdapter("fake/sandbox-lifecycle", () => ({
        content: "Sandbox lifecycleを確認しました。",
        toolCalls: [{
          name: "sandbox.exec",
          arguments: {
            command: process.execPath,
            args: ["-e", "console.log('not reached')"]
          }
        }]
      }))
    );
    const boundary: GatewayBoundaryPolicy = {
      ...gatewayBoundaryPolicy(["sandbox.exec"]),
      sandbox: {
        mode: "all",
        scope: "session",
        backend: "docker",
        workspace_access: "read_write",
        network_access: "none",
        allowed_paths: [{ root: "workspace", access: "read_write" }],
        denied_paths: [],
        timeout_ms: 2000,
        metadata: {}
      }
    };

    let result: Awaited<ReturnType<AgentRuntime["runChatTurn"]>>;
    try {
      process.env.PATH = emptyPathRoot;
      result = await sandboxRuntime.runChatTurn({
        sessionId: session.id,
        content: "sandbox lifecycle",
        output_locale: "ja",
        gateway_boundary_policy: boundary
      });
    } finally {
      process.env.PATH = pathBeforeTest;
    }
    const instances = await store.listGatewaySandboxInstances();
    const recreated = await runtime.recreateGatewaySandboxInstance(instances[0]!.id);
    const deleted = await runtime.deleteGatewaySandboxInstance(instances[0]!.id);
    await store.close();

    expect(instances).toHaveLength(1);
    expect(instances[0]).toMatchObject({
      instance_key: "docker:session:webhook:external-source:main",
      scope: "session",
      backend: "docker",
      status: "ready",
      session_key: "webhook:external-source:main"
    });
    expect(result.toolRuns).toContainEqual(expect.objectContaining({
      provider_tool_name: "sandbox.exec",
      resource_refs: expect.arrayContaining([
        expect.objectContaining({ kind: "gateway_sandbox_instance", id: instances[0]!.id })
      ])
    }));
    expect(result.backendEvents).toContainEqual(expect.objectContaining({
      event_type: "tool_call_output",
      payload: expect.objectContaining({
        action_id: "sandbox.exec",
        status: "failed",
        reason: "adapter_failed",
        sandbox_instance: expect.objectContaining({
          id: instances[0]!.id,
          backend: "docker",
          status: "ready"
        })
      })
    }));
    expect(recreated.status).toBe("recreated");
    expect(deleted.status).toBe("deleted");
  });

  it("records sandbox workspace sync previews and completed local apply results", async () => {
    const { store, runtime } = await createRuntime();
    const session = await runtime.createSession();
    const remoteWorkspaceRoot = await mkdtemp(path.join(tmpdir(), "samurai-sandbox-sync-"));
    roots.push(remoteWorkspaceRoot);
    await writeFile(path.join(store.rootDir, "sync-source.txt"), "workspace sync source");
    const sandboxRuntime = new AgentRuntime(
      store,
      undefined,
      new FakeProviderAdapter("fake/sandbox-sync", () => ({
        content: "Sandbox sync対象を作りました。",
        toolCalls: [{
          name: "sandbox.exec",
          arguments: {
            command: process.execPath,
            args: ["-e", "console.log('not reached')"]
          }
        }]
      }))
    );
    const boundary: GatewayBoundaryPolicy = {
      ...gatewayBoundaryPolicy(["sandbox.exec"]),
      sandbox: {
        mode: "all",
        scope: "session",
        backend: "ssh",
        workspace_access: "read_write",
        network_access: "none",
        allowed_paths: [{ root: "workspace", access: "read_write" }],
        denied_paths: [],
        timeout_ms: 2000,
        metadata: {
          remote_workspace_root: remoteWorkspaceRoot,
          workspace_sync_direction: "seed_to_sandbox",
          workspace_sync_transport: "local"
        }
      }
    };

    await sandboxRuntime.runChatTurn({
      sessionId: session.id,
      content: "sandbox workspace sync",
      output_locale: "ja",
      gateway_boundary_policy: boundary
    });
    const instances = await store.listGatewaySandboxInstances();
    const preview = await runtime.syncGatewaySandboxWorkspace(instances[0]!.id, { dryRun: true });
    const afterPreview = await store.listGatewaySandboxWorkspaceSyncs();
    const applied = await runtime.syncGatewaySandboxWorkspace(instances[0]!.instance_key, { dryRun: false });
    const afterApply = await store.listGatewaySandboxWorkspaceSyncs({ instanceKey: instances[0]!.instance_key });
    const copied = await readFile(path.join(remoteWorkspaceRoot, "sync-source.txt"), "utf8");
    const deleted = await store.saveGatewaySandboxInstance({
      ...instances[0]!,
      status: "deleted",
      deleted_at: nowIso(),
      updated_at: nowIso()
    });
    await expect(runtime.syncGatewaySandboxWorkspace(deleted.id, { dryRun: false })).rejects.toThrow("gateway_sandbox_instance_deleted");
    await store.close();

    expect(preview).toMatchObject({
      dry_run: true,
      sync: {
        instance_id: instances[0]!.id,
        instance_key: instances[0]!.instance_key,
        direction: "seed_to_sandbox",
        status: "planned",
        remote_workspace_root: remoteWorkspaceRoot
      }
    });
    expect(afterPreview).toHaveLength(0);
    expect(copied).toBe("workspace sync source");
    expect(applied).toMatchObject({
      dry_run: false,
      sync: {
        instance_id: instances[0]!.id,
        status: "completed",
        remote_workspace_root: remoteWorkspaceRoot
      }
    });
    expect(afterApply).toHaveLength(1);
    expect(afterApply[0]).toMatchObject({
      id: applied.sync.id,
      direction: "seed_to_sandbox",
      status: "completed"
    });
  });

  it("marks running backend runs as cancelled", async () => {
    const { store, runtime } = await createRuntime();
    const session = await runtime.createSession();
    const result = await runtime.runChatTurn({
      sessionId: session.id,
      content: "キャンセル対象のrun",
      output_locale: "ja"
    });
    await store.updateBackendRun({
      ...result.backendRun,
      status: "running",
      completed_at: undefined,
      error_code: undefined
    });

    const cancelled = await runtime.cancelBackendRun(result.backendRun.id);
    const stored = await store.getBackendRun(result.backendRun.id);
    await store.close();

    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.error_code).toBe("backend_cancelled");
    expect(stored?.status).toBe("cancelled");
  });

  it("releases gateway concurrency locks when cancelling backend runs", async () => {
    const { store, runtime } = await createRuntime();
    const session = await runtime.createSession();
    const result = await runtime.runChatTurn({
      sessionId: session.id,
      content: "Gateway lock付きのcancel対象",
      output_locale: "ja"
    });
    const lockKey = "webhook:cancel-source:main";
    await store.acquireGatewayConcurrencyLock({
      lockKey,
      scope: "session",
      policyId: "gateway-policy-cancel-test",
      ownerRef: { kind: "gateway_inbound", id: "cancel-test", uri: "gateway-inbound/cancel-test" },
      ttlMs: 60_000
    });
    await store.updateBackendRun({
      ...result.backendRun,
      status: "running",
      completed_at: undefined,
      error_code: undefined,
      metadata: {
        ...result.backendRun.metadata,
        gateway_boundary_concurrency_lock_key: lockKey
      }
    });

    const cancelled = await runtime.cancelBackendRun(result.backendRun.id);
    const releasedLock = await store.getGatewayConcurrencyLock(lockKey);
    const stored = await store.getBackendRun(result.backendRun.id);
    await store.close();

    expect(cancelled.status).toBe("cancelled");
    expect(releasedLock).toMatchObject({
      lock_key: lockKey,
      status: "released"
    });
    expect(stored?.metadata.gateway_concurrency_lock_status).toBe("released");
    expect(stored?.metadata.gateway_concurrency_lock_released_at).toBe(releasedLock?.released_at);
  });

  it("leaves settled backend runs unchanged when cancel is requested", async () => {
    const { store, runtime } = await createRuntime();
    const session = await runtime.createSession();
    const result = await runtime.runChatTurn({
      sessionId: session.id,
      content: "完了済みrun",
      output_locale: "ja"
    });

    const unchanged = await runtime.cancelBackendRun(result.backendRun.id);
    await store.close();

    expect(unchanged.status).toBe("completed");
    expect(unchanged.error_code).toBeUndefined();
  });

  it("records resume attempts through backend lifecycle events", async () => {
    const { store, runtime } = await createRuntime();
    const session = await runtime.createSession();
    const result = await runtime.runChatTurn({
      sessionId: session.id,
      content: "resume対象のrun",
      output_locale: "ja"
    });
    await store.updateBackendRun({
      ...result.backendRun,
      backend_id: "samurai-native",
      backend_kind: "samurai_native",
      status: "waiting_for_backend_input",
      completed_at: undefined,
      error_code: undefined
    });

    const resumed = await runtime.resumeBackendRun(result.backendRun.id, { answer: "続けて" });
    const events = await store.listBackendEvents({ runId: result.backendRun.id });
    await store.close();

    expect(resumed.status).toBe("failed");
    expect(resumed.error_code).toBe("backend_resume_unsupported");
    expect(events.some((event) =>
      event.event_type === "backend_native_input_submitted" && event.payload.input
    )).toBe(true);
    expect(events.some((event) => event.event_type === "run_failed" && event.payload.error_code === "backend_resume_unsupported")).toBe(true);
  });

  it("records unsupported resume attempts for backends without resumeRun", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-runtime-"));
    roots.push(root);
    const store = await WorkspaceStore.create({ rootDir: root });
    const runtime = new AgentRuntime(store, undefined, undefined, new AgentBackendRegistry([new MockBackend()]));
    const session = await runtime.createSession();
    const result = await runtime.runChatTurn({
      sessionId: session.id,
      content: "mock resume対象",
      output_locale: "ja",
      backend_id: "mock"
    });
    await store.updateBackendRun({
      ...result.backendRun,
      status: "waiting_for_backend_input",
      completed_at: undefined,
      error_code: undefined
    });

    const resumed = await runtime.resumeBackendRun(result.backendRun.id, { answer: "続けて" });
    const events = await store.listBackendEvents({ runId: result.backendRun.id });
    await store.close();

    expect(resumed.status).toBe("failed");
    expect(resumed.error_code).toBe("backend_resume_unsupported");
    expect(events.some((event) => event.event_type === "backend_native_input_submitted")).toBe(true);
    expect(events.some((event) => event.event_type === "run_failed" && event.payload.backend_id === "mock")).toBe(true);
  });

  it("resumes backend runs through backend resumeRun when supported", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-runtime-"));
    roots.push(root);
    const store = await WorkspaceStore.create({ rootDir: root });
    const resumableBackend: AgentBackend = {
      id: "resumable",
      kind: "mock",
      label: "Resumable Backend",
      async *runTurn() {
        yield { event_type: "run_started", payload: { input_summary: "waiting" } };
        yield { event_type: "backend_waiting_for_native_input", payload: { prompt: "Need input" } };
      },
      async *resumeRun(_runId, input) {
        expect(input.workspace_root).toBe(root);
        expect(input.working_directory).toBe(root);
        yield { event_type: "text_delta", payload: { text: `Resumed: ${String(input.answer ?? "")}` } };
        yield { event_type: "run_completed", payload: { output_summary: "Resume completed." } };
      }
    };
    const runtime = new AgentRuntime(store, undefined, undefined, new AgentBackendRegistry([resumableBackend]));
    const session = await runtime.createSession();
    const result = await runtime.runChatTurn({
      sessionId: session.id,
      content: "resume success target",
      output_locale: "ja",
      backend_id: "resumable"
    });

    const resumed = await runtime.resumeBackendRun(result.backendRun.id, { answer: "続けて" });
    const events = await store.listBackendEvents({ runId: result.backendRun.id });
    await store.close();

    expect(result.backendRun.status).toBe("waiting_for_backend_input");
    expect(resumed).toMatchObject({
      status: "completed",
      output_summary: "Resume completed."
    });
    expect(resumed.metadata.resume_input).toEqual({ answer: "続けて" });
    expect(events.some((event) => event.event_type === "backend_native_input_submitted")).toBe(true);
    expect(events.some((event) => event.event_type === "text_delta" && event.payload.text === "Resumed: 続けて")).toBe(true);
    expect(events.some((event) => event.event_type === "run_completed")).toBe(true);
  });

  it("applies gateway allowed-tools decisions to resumed backend tool calls", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-runtime-"));
    roots.push(root);
    const store = await WorkspaceStore.create({ rootDir: root });
    const boundary = gatewayBoundaryPolicy([]);
    const resumableBackend: AgentBackend = {
      id: "resumable-denied-tool",
      kind: "mock",
      label: "Resumable Denied Tool Backend",
      async *runTurn() {
        yield { event_type: "run_started", payload: { input_summary: "waiting" } };
        yield { event_type: "backend_waiting_for_native_input", payload: { prompt: "Need input" } };
      },
      async *resumeRun() {
        yield {
          event_type: "tool_call_started",
          tool_call_id: "resume_tool_denied",
          payload: {
            provider_tool_name: "create_artifact",
            action_id: "artifact.create",
            arguments: {
              title: "Blocked resume artifact",
              content: "This should not be written."
            }
          }
        };
        yield { event_type: "run_completed", payload: { output_summary: "Resume completed." } };
      }
    };
    const runtime = new AgentRuntime(store, undefined, undefined, new AgentBackendRegistry([resumableBackend]));
    const session = await runtime.createSession();
    const result = await runtime.runChatTurn({
      sessionId: session.id,
      content: "resume denied tool target",
      output_locale: "ja",
      backend_id: "resumable-denied-tool",
      gateway_boundary_policy: boundary
    });

    const resumed = await runtime.resumeBackendRun(result.backendRun.id, { answer: "続けて" });
    const events = await store.listBackendEvents({ runId: result.backendRun.id });
    const toolRuns = await store.listToolRuns({ runId: result.backendRun.id });
    const workspaceChanges = await store.listWorkspaceChanges(session.id);
    const artifacts = await store.listArtifactsForSession(session.id);
    await store.close();

    expect(result.backendRun.status).toBe("waiting_for_backend_input");
    expect(resumed.status).toBe("completed");
    expect(toolRuns).toContainEqual(expect.objectContaining({
      tool_call_id: "resume_tool_denied",
      provider_tool_name: "create_artifact",
      action_id: "artifact.create",
      status: "ignored",
      resource_refs: expect.arrayContaining([
        expect.objectContaining({ kind: "gateway_boundary_policy", id: boundary.id })
      ])
    }));
    expect(events).toContainEqual(expect.objectContaining({
      event_type: "tool_call_output",
      payload: expect.objectContaining({
        tool_call_id: "resume_tool_denied",
        status: "ignored",
        action_id: "artifact.create",
        reason: "gateway_boundary_tool_not_allowed",
        gateway_boundary: expect.objectContaining({
          decision: "denied",
          policy_id: boundary.id,
          allowed_tools: []
        })
      })
    }));
    expect(workspaceChanges).toContainEqual(expect.objectContaining({
      change_type: "other",
      resource_ref: expect.objectContaining({ kind: "gateway_boundary_policy", id: boundary.id })
    }));
    expect(artifacts).toHaveLength(0);
  });

  it("routes resumed provider tool events by action_id into runtime executors", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-runtime-"));
    roots.push(root);
    const store = await WorkspaceStore.create({ rootDir: root });
    const boundary: GatewayBoundaryPolicy = {
      ...gatewayBoundaryPolicy(["sandbox.exec"]),
      sandbox: {
        mode: "all",
        scope: "session",
        backend: "none",
        workspace_access: "none",
        network_access: "none",
        allowed_paths: [],
        denied_paths: [],
        timeout_ms: 2000,
        metadata: {}
      }
    };
    const resumableBackend: AgentBackend = {
      id: "resumable-sandbox-tool",
      kind: "mock",
      label: "Resumable Sandbox Tool Backend",
      async *runTurn() {
        yield { event_type: "run_started", payload: { input_summary: "waiting" } };
        yield { event_type: "backend_waiting_for_native_input", payload: { prompt: "Need input" } };
      },
      async *resumeRun() {
        yield {
          event_type: "tool_call_started",
          tool_call_id: "resume_exec",
          payload: {
            provider_tool_name: "exec_command",
            action_id: "sandbox.exec",
            input: {
              command: process.execPath,
              args: ["-e", "process.stdout.write('resume sandbox ok')"]
            }
          }
        };
        yield { event_type: "run_completed", payload: { output_summary: "Resume sandbox completed." } };
      }
    };
    const runtime = new AgentRuntime(store, undefined, undefined, new AgentBackendRegistry([resumableBackend]));
    const session = await runtime.createSession();
    const result = await runtime.runChatTurn({
      sessionId: session.id,
      content: "resume sandbox tool target",
      output_locale: "ja",
      backend_id: "resumable-sandbox-tool",
      gateway_boundary_policy: boundary
    });

    const resumed = await runtime.resumeBackendRun(result.backendRun.id, { answer: "続けて" });
    const events = await store.listBackendEvents({ runId: result.backendRun.id });
    const operations = await store.listOperations(session.id);
    const toolRuns = await store.listToolRuns({ runId: result.backendRun.id });
    await store.close();

    expect(resumed).toMatchObject({
      status: "completed",
      output_summary: "Resume sandbox completed."
    });
    expect(operations).toContainEqual(expect.objectContaining({
      operation: "sandbox.exec",
      status: "completed",
      result_ref: expect.objectContaining({ kind: "gateway_sandbox_execution" })
    }));
    expect(toolRuns).toContainEqual(expect.objectContaining({
      tool_call_id: "resume_exec",
      provider_tool_name: "sandbox.exec",
      action_id: "sandbox.exec",
      status: "completed",
      resource_refs: expect.arrayContaining([
        expect.objectContaining({ kind: "gateway_boundary_policy", id: boundary.id })
      ])
    }));
    expect(events).toContainEqual(expect.objectContaining({
      event_type: "tool_call_output",
      payload: expect.objectContaining({
        tool_call_id: "resume_exec",
        status: "completed",
        action_id: "sandbox.exec",
        stdout: "resume sandbox ok",
        gateway_boundary: expect.objectContaining({
          decision: "allowed",
          action_id: "sandbox.exec",
          policy_id: boundary.id
        })
      })
    }));
  });

  it("syncs backend streamEvents into persisted backend events", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-runtime-"));
    roots.push(root);
    const store = await WorkspaceStore.create({ rootDir: root });
    const streamBackend: AgentBackend = {
      id: "streamable",
      kind: "mock",
      label: "Streamable Backend",
      async *runTurn() {
        yield { event_type: "run_started", payload: { input_summary: "streamable" } };
      },
      async *streamEvents() {
        yield { event_type: "run_started", payload: { input_summary: "streamable" } };
        yield { event_type: "text_delta", payload: { text: "stream text" } };
        yield { event_type: "run_completed", payload: { output_summary: "stream completed" } };
      }
    };
    const runtime = new AgentRuntime(store, undefined, undefined, new AgentBackendRegistry([streamBackend]));
    const session = await runtime.createSession();
    const now = nowIso();
    const message = await store.saveMessage({
      id: createId("message"),
      session_id: session.id,
      role: "user",
      content: "stream sync target",
      input_locale: "ja",
      output_locale: "ja",
      created_at: now
    });
    await store.saveBackendRun({
      id: "run_stream_sync",
      session_id: session.id,
      input_message_id: message.id,
      backend_id: "streamable",
      backend_kind: "mock",
      status: "running",
      started_at: now,
      input_summary: "stream sync target",
      metadata: {}
    });

    const synced = await runtime.syncBackendStream("run_stream_sync", { timeoutMs: 1_000 });
    const events = await store.listBackendEvents({ runId: "run_stream_sync" });
    await store.close();

    expect(synced.status).toBe("synced");
    expect(synced.run).toMatchObject({ status: "completed", output_summary: "stream completed" });
    expect(events.map((event) => event.event_type)).toEqual([
      "run_started",
      "text_delta",
      "run_completed",
      "backend_stream_synced"
    ]);
  });

  it("records backend stream unsupported as a diagnostic event", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-runtime-"));
    roots.push(root);
    const store = await WorkspaceStore.create({ rootDir: root });
    const runtime = new AgentRuntime(store, undefined, undefined, new AgentBackendRegistry([new MockBackend()]));
    const session = await runtime.createSession();
    const now = nowIso();
    const message = await store.saveMessage({
      id: createId("message"),
      session_id: session.id,
      role: "user",
      content: "unsupported stream target",
      input_locale: "ja",
      output_locale: "ja",
      created_at: now
    });
    await store.saveBackendRun({
      id: "run_stream_unsupported",
      session_id: session.id,
      input_message_id: message.id,
      backend_id: "mock",
      backend_kind: "mock",
      status: "running",
      started_at: now,
      input_summary: "unsupported stream target",
      metadata: {}
    });

    const synced = await runtime.syncBackendStream("run_stream_unsupported");
    const stored = await store.getBackendRun("run_stream_unsupported");
    const events = await store.listBackendEvents({ runId: "run_stream_unsupported" });
    await store.close();

    expect(synced.status).toBe("unsupported");
    expect(stored?.status).toBe("running");
    expect(events).toContainEqual(expect.objectContaining({
      event_type: "backend_stream_unavailable",
      payload: expect.objectContaining({
        reason: "stream_events_unsupported",
        supports_stream_events: false
      })
    }));
  });

  it("normalizes backend event payloads and resource refs before persistence", async () => {
    const noisyBackend: AgentBackend = {
      id: "noisy",
      kind: "mock",
      label: "Noisy Fixture Backend",
      async *runTurn() {
        yield {
          event_type: "text_delta",
          payload: { text: "hello", non_json: undefined } as never,
          resource_refs: [
            { kind: "artifact", id: "artifact_ok", uri: "artifacts/artifact_ok.md" },
            { kind: "artifact", uri: "missing-id" } as never
          ]
        };
        yield {
          event_type: "tool_call_output",
          payload: {
            tool_call_id: "tool_1",
            provider_tool_name: "shell.exec",
            stdout: "x".repeat(4100),
            token: "secret-token"
          }
        };
        yield {
          event_type: "run_completed",
          payload: { output_summary: "done" }
        };
      }
    };
    const root = await mkdtemp(path.join(tmpdir(), "samurai-runtime-"));
    roots.push(root);
    const store = await WorkspaceStore.create({ rootDir: root });
    const emittedBackendEvents: BackendEventRecord[] = [];
    const runtime = new AgentRuntime(store, (name, payload) => {
      if (name === "backend.event.created") {
        emittedBackendEvents.push(payload as BackendEventRecord);
      }
    }, undefined, new AgentBackendRegistry([noisyBackend]));
    const session = await runtime.createSession();

    const result = await runtime.runChatTurn({
      sessionId: session.id,
      content: "fixture",
      backend_id: "noisy"
    });
    const event = result.backendEvents.find((item) => item.event_type === "text_delta")!;
    const toolOutput = result.backendEvents.find((item) => item.event_type === "tool_call_output")!;
    const emittedToolOutput = emittedBackendEvents.find((item) => item.event_type === "tool_call_output")!;
    await store.close();

    expect(event.payload.non_json).toBeNull();
    expect(event.resource_refs).toEqual([{ kind: "artifact", id: "artifact_ok", uri: "artifacts/artifact_ok.md" }]);
    expect(toolOutput.payload).toMatchObject({
      stdout: "x".repeat(4100),
      token: "secret-token"
    });
    expect(emittedToolOutput.payload).toMatchObject({
      tool_call_id: "tool_1",
      provider_tool_name: "shell.exec",
      summary: `${"x".repeat(4000)}...[truncated]`
    });
    expect(emittedToolOutput.payload).not.toHaveProperty("token");
  });

  it("runs chat through backend run events and artifact workspace change", async () => {
    const { store, runtime } = await createRuntime();
    const session = await runtime.createSession();
    const result = await runtime.runChatTurn({
      sessionId: session.id,
      content: "提案書の短い下書きを作って",
      output_locale: "ja"
    });
    await store.close();

    expect(result.artifacts.length).toBeGreaterThan(0);
    expect(result.messages.find((message) => message.role === "agent")?.content).toBeTruthy();
    expect(result.operations.some((operation) => operation.operation === "artifact.create")).toBe(true);
    expect(result.backendRun.status).toBe("completed");
    expect(result.backendEvents.some((event) => event.event_type === "artifact_created")).toBe(true);
    expect(result.workspaceChanges.some((change) => change.change_type === "artifact_created")).toBe(true);
    expect(result.toolRuns.some((toolRun) => toolRun.action_id === "artifact.create" && toolRun.status === "completed")).toBe(true);
    expect(result.reflectionRuns[0]?.status).toBe("completed");
    expect(result.reflectionSuggestions).toEqual([]);
    expect(result.policyDecisions).toEqual([]);
    expect(result.auditRecords).toEqual([]);
  });

  it("keeps Background Review separate from the source Session", async () => {
    const { store, runtime } = await createRuntime();
    const session = await runtime.createSession();
    const result = await runtime.runChatTurn({
      sessionId: session.id,
      content: "調査メモを作って",
      output_locale: "ja"
    });
    await store.close();

    expect(result.reflectionRuns[0]).toMatchObject({ kind: "background_review", source_run_id: result.backendRun.id, status: "completed" });
    expect(result.reflectionSuggestions).toEqual([]);
  });

  it("ignores malformed artifact tool calls without failing the chat turn", async () => {
    const { store, runtime } = await createRuntime();
    const session = await runtime.createSession();
    const result = await runtime.runChatTurn({
      sessionId: session.id,
      content: "malformed artifact",
      output_locale: "en"
    });
    await store.close();

    expect(result.messages.find((message) => message.role === "agent")?.content).toBe("Done.");
    expect(result.artifacts).toEqual([]);
    expect(result.operations.some((operation) => operation.operation === "artifact.create")).toBe(false);
  });

  it("keeps safe drafting while outbound work stays in backend events", async () => {
    const { store, runtime } = await createRuntime();
    const session = await runtime.createSession();
    const result = await runtime.runChatTurn({
      sessionId: session.id,
      content: "提案書を作って、あとでメール送信もして",
      output_locale: "ja"
    });
    await store.close();

    expect(result.artifacts.length).toBeGreaterThan(0);
    expect(result.approvalRequests).toEqual([]);
    expect(result.operations.some((operation) => operation.status === "pending_approval")).toBe(false);
    expect(result.backendEvents.some((event) =>
      event.event_type === "tool_call_output"
      && event.payload.status === "completed"
      && event.payload.action_id === "external.send.prepare"
    )).toBe(true);
  });

  it("archives session memory with audit activity and rollback", async () => {
    const { store, runtime } = await createRuntime();
    const session = await runtime.createSession();
    const result = await runtime.runChatTurn({
      sessionId: session.id,
      content: "提案書を作って、今後この文体を覚えて",
      output_locale: "ja"
    });
    const memory = result.memories.find((item) => item.state === "topic")!;

    const archived = await runtime.archiveMemory({
      sessionId: session.id,
      memoryId: memory.id
    });
    const sessionMemory = await store.listMemoryForSession(session.id);
    await store.close();

    expect(archived.changed).toBe(true);
    expect(archived.memory.state).toBe("archived");
    expect(archived.operation.operation).toBe("memory.archive");
    expect(archived.operation.status).toBe("completed");
    expect(archived.rollbackPoint).toBeDefined();
    expect(archived.operation.result_ref?.id).toBe(memory.id);
    expect(sessionMemory.some((item) => item.id === memory.id)).toBe(false);
  });

  it("does not archive memory from another session", async () => {
    const { store, runtime } = await createRuntime();
    const sessionA = await runtime.createSession();
    const sessionB = await runtime.createSession();
    const result = await runtime.runChatTurn({
      sessionId: sessionA.id,
      content: "今後この文体を覚えて",
      output_locale: "ja"
    });
    const memory = result.memories.find((item) => item.state === "topic")!;

    await expect(runtime.archiveMemory({ sessionId: sessionB.id, memoryId: memory.id })).rejects.toMatchObject({
      code: "conflict",
      message: "memory_not_in_session"
    });
    expect((await store.getMemory(memory.id))?.state).toBe("topic");
    await store.close();
  });

  it("archives already archived memory as audit-only no-op", async () => {
    const { store, runtime } = await createRuntime();
    const session = await runtime.createSession();
    const result = await runtime.runChatTurn({
      sessionId: session.id,
      content: "今後この文体を覚えて",
      output_locale: "ja"
    });
    const memory = result.memories.find((item) => item.state === "topic")!;
    await runtime.archiveMemory({ sessionId: session.id, memoryId: memory.id });

    const archivedAgain = await runtime.archiveMemory({ sessionId: session.id, memoryId: memory.id });
    await store.close();

    expect(archivedAgain.changed).toBe(false);
    expect(archivedAgain.rollbackPoint).toBeUndefined();
    expect(archivedAgain.operation.status).toBe("completed");
  });

  it("creates skill candidates and projects through operation history and rollback", async () => {
    const { store, runtime } = await createRuntime();

    const candidate = await runtime.createSkillCandidate({
      title: "調査メモ",
      description: "調査メモを整える",
      content: "# Skill"
    });
    const project = await runtime.saveSkillProject({ candidateId: candidate.resource.id });
    await store.close();

    expect(candidate.operation.operation).toBe("skill.candidate.create");
    expect(candidate.operation.status).toBe("completed");
    expect(project.operation.operation).toBe("skill.project.save");
    expect(project.operation.status).toBe("completed");
    expect(project.rollbackPoint).toBeDefined();
  });

  it("saves collection schema, record, and patch through policy audit rollback", async () => {
    const { store, runtime } = await createRuntime();
    const schema = {
      ...collectionSchema("contacts"),
      actions: [{ id: "rename", kind: "patch_record", changes: { name: "Action Name" } }]
    };
    const now = new Date().toISOString();

    const savedSchema = await runtime.saveCollectionSchema(schema);
    const record = await runtime.createCollectionRecord({
      id: "record_1",
      collection_id: "contacts",
      data: { name: "Takuma" },
      resource_refs: [],
      created_at: now,
      updated_at: now
    });
    const patched = await runtime.applyCollectionPatch({
      collectionId: "contacts",
      recordId: "record_1",
      patch: {
        id: "patch_1",
        record_id: "record_1",
        changes: { name: "Samurai" },
        source_operation_id: "operation_test",
        created_at: new Date().toISOString()
      }
    });
    const action = await runtime.runCollectionAction({
      collectionId: "contacts",
      actionId: "rename",
      recordId: "record_1"
    });
    await expect(
      runtime.createCollectionRecord({
        id: "record_bad",
        collection_id: "contacts",
        data: { unknown: true },
        resource_refs: [],
        created_at: now,
        updated_at: now
      })
    ).rejects.toThrow("collection_unknown_field");
    await store.close();

    expect(savedSchema.operation.operation).toBe("collection.schema.save");
    expect(record.operation.operation).toBe("collection.record.create");
    expect(patched.operation.operation).toBe("collection.patch.apply");
    expect(patched.before.data.name).toBe("Takuma");
    expect(patched.resource.data.name).toBe("Samurai");
    expect(patched.rollbackPoint).toBeDefined();
    expect(action.operation.operation).toBe("collection.action.run");
    expect(action.resource.data.name).toBe("Action Name");
  });

  it("renders Collection derived fields from safe expressions without saving them as record data", async () => {
    const { store, runtime } = await createRuntime();
    const now = new Date().toISOString();
    await runtime.saveCollectionSchema({
      id: "expenses",
      version: "1",
      labels: { ja: "支出", en: "Expenses" },
      descriptions: {},
      fields: [
        { id: "name", type: "string", label: "名前" },
        { id: "price", type: "number", label: "金額" },
        { id: "tax", type: "number", label: "税" },
        { id: "paid", type: "boolean", label: "支払い済み" }
      ],
      refs: [],
      embeds: [],
      derived_fields: [
        {
          id: "total",
          type: "number",
          label: "合計",
          expression: {
            op: "add",
            args: [{ op: "field", field_id: "price" }, { op: "field", field_id: "tax" }]
          }
        },
        {
          id: "paid_rate",
          type: "number",
          label: "支払い率",
          expression: { op: "completion_rate", field_id: "paid" }
        }
      ],
      triggers: [],
      actions: [],
      views: [{ id: "expenses_table", renderer: "collection_table" }],
      permissions: { create: true, update: true, delete: true }
    });
    await runtime.createCollectionRecord({
      id: "expense_1",
      collection_id: "expenses",
      data: { name: "hosting", price: 100, tax: 10, paid: true },
      resource_refs: [],
      created_at: now,
      updated_at: now
    });
    await runtime.createCollectionRecord({
      id: "expense_2",
      collection_id: "expenses",
      data: { name: "tools", price: 40, tax: 4, paid: false },
      resource_refs: [],
      created_at: now,
      updated_at: now
    });

    const view = await runtime.presentCollectionView({ collectionId: "expenses", viewId: "expenses_table" });
    const saved = await store.getCollectionRecord("expenses", "expense_1");
    await store.close();

    expect(saved?.data).not.toHaveProperty("total");
    expect(view.render_spec.props.data).toMatchObject({
      schema_fields: expect.arrayContaining([
        expect.objectContaining({ id: "total", derived: true, read_only: true }),
        expect.objectContaining({ id: "paid_rate", derived: true, read_only: true })
      ]),
      view_config: expect.objectContaining({
        editable_fields: expect.not.arrayContaining(["total", "paid_rate"])
      }),
      records: expect.arrayContaining([
        expect.objectContaining({ id: "expense_1", total: 110, paid_rate: 50 }),
        expect.objectContaining({ id: "expense_2", total: 44, paid_rate: 50 })
      ])
    });
  });

  it("runs collection plugin actions through the plugin runtime registry", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-runtime-"));
    roots.push(root);
    const store = await WorkspaceStore.create({ rootDir: root });
    const pluginRegistry = new PluginRuntimeRegistry({
      manifests: [{
        id: "contacts-plugin",
        name: "Contacts Plugin",
        version: "1",
        kind: "ui",
        actions: [],
        renderers: [{
          id: "contacts.renderer.card",
          kind: "custom_view",
          renderer: "contacts.card",
          version: "1",
          title: "Contact card",
          description: "Render a contact card.",
          props_schema: { type: "object" },
          fallback_kind: "collection_record",
          category: "collection"
        }],
        resource_kinds: ["collection_record"],
        metadata: {}
      }],
      actions: [{
        id: "contacts.enrich",
        title: "Enrich contact",
        display_name: "Enrich contact",
        description: "Enrich a contact through a plugin handler.",
        input_schema: { type: "object" },
        output_schema: { type: "object" },
        resource_kinds: ["collection_action"],
        handler_id: "plugin.contacts.enrich",
        implementation_target: "plugin",
        ui_display_category: "collection"
      }]
    });
    pluginRegistry.registerHandler("plugin.contacts.enrich", async ({ input }) => ({
      status: "completed",
      output: {
        received_record_id: input.record_id ?? null,
        source: "plugin"
      }
    }));
    const runtime = new AgentRuntime(store, undefined, new FakeProviderAdapter("fake/test", fakeProviderOutput), undefined, pluginRegistry);
    await runtime.saveCollectionSchema({
      ...collectionSchema("contacts"),
      actions: [{
        id: "enrich",
        kind: "plugin_action",
        action_catalog_id: "contacts.enrich",
        implementation_target: "plugin"
      }]
    });

    const actions = await runtime.listCollectionActions("contacts");
    const renderers = runtime.listSurfaceRenderers();
    const result = await runtime.runCollectionAction({
      collectionId: "contacts",
      actionId: "enrich",
      recordId: "record_plugin",
      payload: { source: "test" }
    });
    await store.close();

    expect(actions).toContainEqual(expect.objectContaining({
      collection_id: "contacts",
      action_id: "enrich",
      catalog_action_id: "contacts.enrich",
      availability: "available"
    }));
    expect(renderers).toContainEqual(expect.objectContaining({
      id: "contacts.renderer.card",
      kind: "custom_view",
      renderer: "contacts.card"
    }));
    expect(result.operation.operation).toBe("collection.action.run");
    expect(result.resource).toMatchObject({
      collection_id: "contacts",
      action_id: "enrich",
      catalog_action_id: "contacts.enrich",
      status: "completed",
      output: {
        received_record_id: "record_plugin",
        source: "plugin"
      }
    });
  });

  it("runs Collection instruction actions from surface operations and returns the refreshed view", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-runtime-"));
    roots.push(root);
    const store = await WorkspaceStore.create({ rootDir: root });
    const providerInputs: ProviderInput[] = [];
    const runtime = new AgentRuntime(store, undefined, new FakeProviderAdapter("fake/collection-action", (input) => {
      providerInputs.push(input);
      return {
        content: "整理しました。",
        toolCalls: []
      };
    }));
    const session = await runtime.createSession();
    const now = nowIso();
    await store.updateCollectionSchema({
      ...collectionSchema("movies"),
      fields: [
        { id: "title", type: "string", label: "タイトル" },
        { id: "note", type: "text", label: "感想" },
        { id: "rating", type: "number", label: "評価" },
        { id: "bonus", type: "number", label: "追い点" }
      ],
      derived_fields: [
        {
          id: "score",
          type: "number",
          label: "合計点",
          expression: {
            op: "add",
            args: [
              { op: "field", field_id: "rating" },
              { op: "field", field_id: "bonus" }
            ]
          }
        }
      ],
      actions: [{
        id: "summarize_note",
        kind: "custom_instruction",
        title: "感想を整理",
        instruction: "Summarize the selected movie note and continue the chat with the result.",
        scope: "record"
      }],
      views: [{ id: "movies_table", renderer: "collection_table" }]
    });
    await runtime.createCollectionRecord({
      id: "movie_1",
      collection_id: "movies",
      data: { title: "七人の侍", note: "長いけど緊張感がある", rating: 90, bonus: 5 },
      resource_refs: [],
      created_at: now,
      updated_at: now
    });

    const result = await runtime.runSurfaceOperation({
      id: "surface_collection_action_instruction",
      kind: "collection.action.run",
      session_id: session.id,
      collection_id: "movies",
      action_id: "summarize_note",
      record_id: "movie_1",
      view_id: "movies_table",
      payload: {
        record_id: "movie_1",
        action_label: "感想を整理",
        action_scope: "record",
        view_state: { selected_record_id: "movie_1" },
        record_snapshot: { id: "movie_1", title: "七人の侍", note: "長いけど緊張感がある" }
      },
      renderer_capabilities: {
        protocol_version: "1",
        supported_kinds: ["chat", "custom_view", "collection"],
        custom_view_renderers: [{ renderer: "collection_table", versions: ["1"] }]
      }
    });
    const messages = await store.listMessages(session.id);
    await store.close();

    expect(result.result_kind).toBe("collection_action");
    expect(result.result.operation.operation).toBe("collection.action.run");
    expect(result.render_specs?.map((spec) => spec.kind)).toEqual(["custom_view", "chat"]);
    expect(result.render_spec).toMatchObject({
      kind: "custom_view",
      props: {
        renderer: "collection_table",
        actions: expect.arrayContaining([
          expect.objectContaining({
            id: "summarize_note",
            operation_kind: "collection.action.run",
            scope: "record"
          })
        ]),
        data: expect.objectContaining({
          collection_id: "movies",
          records: [expect.objectContaining({ id: "movie_1", title: "七人の侍" })]
        })
      }
    });
    expect(result.render_specs?.[1]).toMatchObject({
      kind: "chat",
      props: {
        session_id: session.id,
        backend_run_id: expect.any(String)
      }
    });
    const actionChat = "chat" in result.result ? result.result.chat : undefined;
    expect(actionChat?.messages.some((message) => message.role === "agent" && message.content === "整理しました。")).toBe(true);
    expect(providerInputs[0]?.envelope.user_intent).toContain("Summarize the selected movie note");
    expect(providerInputs[0]?.envelope.user_intent).toContain("movie_1");
    expect(providerInputs[0]?.envelope.user_intent).toContain("\"score\": 95");
    expect(providerInputs[0]?.envelope.user_intent).toContain("感想を整理");
    expect(providerInputs[0]?.envelope.user_intent).toContain("selected_record_id");
    expect(providerInputs[0]?.envelope.user_intent).toContain("record_snapshot");
    expect(messages.some((message) => message.role === "agent" && message.content === "整理しました。")).toBe(true);
  });

  it("returns generated Custom View HTML from Collection instruction actions when requested", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-runtime-"));
    roots.push(root);
    const store = await WorkspaceStore.create({ rootDir: root });
    const providerInputs: ProviderInput[] = [];
    const runtime = new AgentRuntime(store, undefined, new FakeProviderAdapter("fake/collection-custom-view", (input) => {
      providerInputs.push(input);
      return {
        content: JSON.stringify({
          custom_view: {
            title: "映画ログボード",
            html: "<main><h1>映画ログボード</h1><button onclick=\"dispatchSamuraiAction('highlight_movie',{record_id:'movie_1'})\">Highlight</button></main>",
            actions: [{
              id: "highlight_movie",
              label: "Highlight movie",
              action_kind: "highlight",
              scope: "record"
            }]
          }
        }),
        toolCalls: []
      };
    }));
    const session = await runtime.createSession();
    const now = nowIso();
    await store.updateCollectionSchema({
      ...collectionSchema("movies"),
      fields: [
        { id: "title", type: "string", label: "タイトル" },
        { id: "status", type: "enum", label: "状態", enum_values: ["観たい", "観た"] }
      ],
      actions: [{
        id: "generate_board",
        kind: "custom_instruction",
        title: "専用ビューを作る",
        instruction: "Generate a compact HTML board for the movie log.",
        output_surface: "custom_view",
        scope: "collection"
      }],
      views: [{ id: "movies_table", renderer: "collection_table" }]
    });
    await runtime.createCollectionRecord({
      id: "movie_1",
      collection_id: "movies",
      data: { title: "七人の侍", status: "観た" },
      resource_refs: [],
      created_at: now,
      updated_at: now
    });

    const result = await runtime.runSurfaceOperation({
      id: "surface_collection_custom_view",
      kind: "collection.action.run",
      session_id: session.id,
      collection_id: "movies",
      action_id: "generate_board",
      view_id: "movies_table",
      payload: {
        action_id: "generate_board",
        action_label: "専用ビューを作る",
        action_kind: "custom_instruction",
        output_surface: "custom_view"
      },
      renderer_capabilities: {
        protocol_version: "1",
        supported_kinds: ["chat", "custom_view", "collection"],
        custom_view_renderers: [
          { renderer: "collection_table", versions: ["1"] },
          { renderer: "generic", versions: ["1"] }
        ]
      }
    });
    await store.close();

    const generated = result.render_specs?.find((spec) =>
      spec.kind === "custom_view" && spec.props.renderer === "generic"
    );
    expect(result.render_specs?.map((spec) => spec.kind)).toEqual(["custom_view", "custom_view", "chat"]);
    expect(generated).toMatchObject({
      kind: "custom_view",
      title: "映画ログボード",
      props: {
        renderer: "generic",
        sandbox: expect.objectContaining({
          mode: "iframe",
          network_access: "read",
          workspace_access: "read"
        }),
        capability: expect.objectContaining({
          allowed_actions: ["highlight_movie"],
          write_operations: ["custom_view.action"],
          data_url: "/api/collections/movies/view-data",
          data_capabilities: ["read", "write"]
        }),
        actions: [expect.objectContaining({
          id: "highlight_movie",
          operation_kind: "custom_view.action",
          scope: "record"
        })],
        data: expect.objectContaining({
          html: expect.stringContaining("映画ログボード"),
          collection_id: "movies",
          source_action_id: "generate_board",
          source_collection: expect.objectContaining({
            records: [expect.objectContaining({ id: "movie_1", title: "七人の侍" })]
          })
        })
      }
    });
    expect(result.result.resource).toMatchObject({
      collection_id: "movies",
      action_id: "generate_board",
      custom_view: expect.objectContaining({
        html: expect.stringContaining("dispatchSamuraiAction")
      })
    });
    expect(providerInputs[0]?.envelope.user_intent).toContain("custom_view.html");
  });

  it("returns collection record render specs with record data for refs and embeds", async () => {
    const { store, runtime } = await createRuntime();
    const now = nowIso();
    await runtime.saveCollectionSchema({
      ...collectionSchema("contacts"),
      fields: [
        { id: "name", type: "string" },
        { id: "manager_id", type: "string" }
      ],
      refs: [{ id: "manager_id", field: "manager_id", collection_id: "contacts" }],
      embeds: [{ id: "profile", field: "profile", required: true }]
    });
    await runtime.createCollectionRecord({
      id: "manager",
      collection_id: "contacts",
      data: { name: "Manager", profile: { role: "lead" } },
      resource_refs: [],
      created_at: now,
      updated_at: now
    });

    const result = await runtime.runSurfaceOperation({
      id: "surface_collection_record",
      kind: "collection.record.create",
      collection_id: "contacts",
      record_id: "record_surface",
      data: { name: "Takuma", manager_id: "manager", profile: { role: "owner" } },
      output_locale: "ja"
    });
    await store.close();

    expect(result.render_spec.kind).toBe("collection_record");
    expect(result.render_spec.props).toMatchObject({
      collection_id: "contacts",
      record_id: "record_surface",
      data: {
        name: "Takuma",
        manager_id: "manager",
        profile: { role: "owner" }
      },
      record_resource_refs: [],
      resolved_refs: [
        expect.objectContaining({
          ref_id: "manager_id",
          field: "manager_id",
          target_collection_id: "contacts",
          target_record_id: "manager",
          record: expect.objectContaining({
            id: "manager",
            data: { name: "Manager", profile: { role: "lead" } }
          })
        })
      ],
      missing_refs: [],
      embed_fields: [{
        embed_id: "profile",
        field: "profile",
        value: { role: "owner" }
      }]
    });
  });

  it("renders Collection refs as selectable linked fields and embeds as read-only fields", async () => {
    const { store, runtime } = await createRuntime();
    const now = nowIso();
    await runtime.saveCollectionSchema({
      ...collectionSchema("people"),
      fields: [{ id: "name", type: "string", label: "名前" }]
    });
    await runtime.createCollectionRecord({
      id: "person_kurosawa",
      collection_id: "people",
      data: { name: "黒澤明" },
      resource_refs: [],
      created_at: now,
      updated_at: now
    });
    await store.updateCollectionSchema({
      ...collectionSchema("movies"),
      fields: [
        { id: "title", type: "string", label: "タイトル" },
        { id: "director_id", type: "string", label: "監督" },
        { id: "profile", type: "json", label: "作品情報" }
      ],
      refs: [],
      embeds: [],
      views: [{ id: "movies_table", renderer: "collection_table" }]
    });
    await runtime.createCollectionRecord({
      id: "movie_1",
      collection_id: "movies",
      data: { title: "七人の侍", director_id: "person_kurosawa", profile: { year: 1954 } },
      resource_refs: [],
      created_at: now,
      updated_at: now
    });
    await runtime.createCollectionRecord({
      id: "movie_missing_director",
      collection_id: "movies",
      data: { title: "監督未解決の映画", director_id: "person_missing", profile: { year: 2026 } },
      resource_refs: [],
      created_at: now,
      updated_at: now
    });
    await store.updateCollectionSchema({
      ...collectionSchema("movies"),
      fields: [
        { id: "title", type: "string", label: "タイトル" },
        { id: "director_id", type: "string", label: "監督" },
        { id: "profile", type: "string", label: "作品情報" }
      ],
      refs: [{ id: "director", field: "director_id", collection_id: "people", label: "監督", required: true }],
      embeds: [{ id: "profile", field: "profile", label: "作品情報" }],
      views: [{ id: "movies_table", renderer: "collection_table" }]
    });

    const view = await runtime.presentCollectionView({ collectionId: "movies", viewId: "movies_table" });
    await store.close();

    expect(view.render_spec.props.data).toMatchObject({
      linked_data: {
        target_collection_ids: ["people"],
        ref_options: {
          director_id: [
            expect.objectContaining({
              value: "person_kurosawa",
              label: "黒澤明",
              collection_id: "people"
            })
          ]
        },
        missing_refs: [
          expect.objectContaining({
            collection_id: "movies",
            record_id: "movie_missing_director",
            field: "director_id",
            target_collection_id: "people",
            target_record_id: "person_missing"
          })
        ]
      },
      schema_fields: expect.arrayContaining([
        expect.objectContaining({
          id: "director_id",
          type: "ref",
          source: "collection_ref",
          target_collection_id: "people",
          required: true,
          options: [expect.objectContaining({ value: "person_kurosawa", label: "黒澤明" })]
        }),
        expect.objectContaining({
          id: "profile",
          type: "json",
          source: "collection_embed",
          read_only: true
        })
      ]),
      records: expect.arrayContaining([
        expect.objectContaining({
          id: "movie_1",
          title: "七人の侍",
          director_id: "person_kurosawa",
          profile: { year: 1954 }
        }),
        expect.objectContaining({
          id: "movie_missing_director",
          title: "監督未解決の映画",
          director_id: "person_missing",
          profile: { year: 2026 }
        })
      ])
    });
  });

  it("manages Collection records with computed-aware reads and validated writes", async () => {
    const { store, runtime } = await createRuntime();
    const now = nowIso();
    await runtime.saveCollectionSchema({
      ...collectionSchema("quotes"),
      fields: [
        { id: "symbol", type: "string", required: true },
        { id: "price", type: "number", required: true }
      ],
      views: [{ id: "quotes_table", renderer: "collection_table" }]
    });
    await runtime.createCollectionRecord({
      id: "toyota",
      collection_id: "quotes",
      data: { symbol: "TM", price: 210 },
      resource_refs: [],
      created_at: now,
      updated_at: now
    });
    await runtime.saveCollectionSchema({
      ...collectionSchema("portfolio"),
      fields: [
        { id: "name", type: "string", required: true },
        { id: "ticker", type: "string", required: true },
        { id: "shares", type: "number", required: true }
      ],
      refs: [{ id: "ticker", field: "ticker", collection_id: "quotes" }],
      derived_fields: [
        { id: "value", type: "number", expression: { op: "multiply", args: [{ op: "field", field: "shares" }, { op: "field", field: "ticker.price" }] } }
      ],
      views: [{ id: "portfolio_table", renderer: "collection_table" }]
    });

    const write = await runtime.runCollectionManageCompatibility({
      action: "putItems",
      collection_id: "portfolio",
      mode: "create",
      items: [
        { id: "holding_1", name: "Toyota holding", ticker: "toyota", shares: 3 },
        { id: "bad_value", name: "Bad", ticker: "toyota", shares: 1, value: 999 }
      ]
    }, "runtime_api", "test:portfolio:put-items");
    const read = await runtime.runCollectionManageCompatibility({
      action: "getItems",
      collection_id: "portfolio",
      fields: ["name", "ticker", "shares", "value"]
    }, "runtime_api");
    const stored = await store.getCollectionRecord("portfolio", "holding_1");
    await store.close();

    expect(write).toMatchObject({
      action: "putItems",
      collection_id: "portfolio",
      written: ["holding_1"],
      rejected: [expect.objectContaining({ id: "bad_value", problem: expect.stringContaining("derived") })]
    });
    expect(read).toMatchObject({
      action: "getItems",
      collection_id: "portfolio",
      count: 1,
      items: [expect.objectContaining({ id: "holding_1", name: "Toyota holding", ticker: "toyota", shares: 3, value: 630 })],
      linked_data: expect.objectContaining({
        ref_options: { ticker: [expect.objectContaining({ value: "toyota", label: "TM" })] }
      })
    });
    expect(stored?.data).not.toHaveProperty("value");
  });

  it("runs collection trigger effects through schema actions as one-shot automation jobs", async () => {
    const { store, runtime } = await createRuntime();
    const schema = {
      ...collectionSchema("contacts"),
      triggers: [{ id: "normalize", event: "record.created", action_id: "normalize_contact", kind: "patch_record" }],
      actions: [{ id: "normalize_contact", kind: "patch_record", changes: { name: "Normalized" } }]
    };
    const now = new Date().toISOString();

    await runtime.saveCollectionSchema(schema);
    await runtime.createCollectionRecord({
      id: "record_trigger",
      collection_id: "contacts",
      data: { name: "Takuma" },
      resource_refs: [],
      created_at: now,
      updated_at: now
    });
    const queuedJobs = await store.listAutomationJobs({ enabledOnly: true });
    const triggerJob = queuedJobs.find((job) => job.delivery_target.trigger_id === "normalize");
    const runs = await runtime.runDueAutomationJobs(new Date(Date.now() + 1000).toISOString());
    const refreshedJob = triggerJob ? await store.getAutomationJob(triggerJob.id) : undefined;
    const triggerStates = await store.listCollectionTriggerStates("contacts");
    const record = await store.getCollectionRecord("contacts", "record_trigger");
    const operations = await store.listOperations();
    await store.close();

    expect(triggerJob).toMatchObject({
      kind: "custom_instruction",
      schedule: "once",
      delivery_target: {
        channel: "collection_trigger",
        collection_id: "contacts",
        record_id: "record_trigger",
        action_id: "normalize_contact"
      }
    });
    expect(runs.some((run) => run.automationRun.kind === "custom_instruction")).toBe(true);
    expect(record?.data.name).toBe("Normalized");
    expect(operations.some((operation) => operation.operation === "collection.action.run")).toBe(true);
    expect(refreshedJob?.status).toBe("disabled");
    expect(triggerStates).toContainEqual(expect.objectContaining({
      collection_id: "contacts",
      trigger_id: "normalize",
      action_id: "normalize_contact",
      action_exists: true,
      status: "completed",
      pending_job_count: 0,
      last_job: expect.objectContaining({
        status: "disabled",
        failure_count: 0
      })
    }));
  });

  it("adds collection notes to context only without relaxing schema validation", async () => {
    const { store, runtime } = await createRuntime();
    const now = new Date().toISOString();
    await runtime.saveCollectionSchema(collectionSchema("contacts"));
    await mkdir(path.join(store.rootDir, "collections", "contacts", "notes"), { recursive: true });
    await writeFile(
      path.join(store.rootDir, "collections", "contacts", "notes", "README.md"),
      "nickname is a context hint, not a schema field"
    );
    const session = await runtime.createSession();

    const context = await runtime.previewContext({
      sessionId: session.id,
      query: "contacts nickname"
    });
    const notes = await store.listCollectionNotes("contacts");
    await expect(runtime.createCollectionRecord({
      id: "record_notes",
      collection_id: "contacts",
      data: { name: "Takuma", nickname: "T" },
      resource_refs: [],
      created_at: now,
      updated_at: now
    })).rejects.toThrow("collection_unknown_field");
    await store.close();

    expect(context.collection_notes).toMatchObject([{
      collection_id: "contacts",
      file_path: path.join("collections", "contacts", "notes", "README.md"),
      role: "context_only"
    }]);
    expect(context.collection_notes[0]?.content).toContain("context hint");
    expect(notes).toMatchObject([{
      collection_id: "contacts",
      file_path: path.join("collections", "contacts", "notes", "README.md"),
      role: "context_only"
    }]);
  });

  it("records cron memory review with scheduled context and automation input ref", async () => {
    const { store, runtime } = await createRuntime();
    const session = await runtime.createSession();
    await runtime.runChatTurn({
      sessionId: session.id,
      content: "今後は短く覚えておける形で答えて",
      output_locale: "ja"
    });

    const result = await runtime.runMemoryReviewAutomation();
    const savedRun = await store.getAutomationRun(result.automationRun.id);
    const reflectionRuns = await store.listReflectionRuns();
    await store.close();

    expect(result.automationRun.status).toBe("completed");
    expect(savedRun?.session_id).toBe(result.operation.session_id);
    expect(result.operation).toMatchObject({
      operation: "automation.memory_review.run",
      actor_identity: "owner_scheduled",
      instruction_source: "scheduled_context",
      channel: "cron"
    });
    expect(result.operation.input_ref).toMatchObject({
      kind: "automation_run",
      uri: `automation-runs/${result.automationRun.id}`
    });
    expect(result.memoryReviewTrace?.reflectionRun.kind).toBe("scheduled");
    expect(result.memoryReviewTrace?.suggestions).toEqual([]);
    expect(result.operation.proposed_effects.join(" ")).toContain("scheduled memory review");
    expect(result.operation.actor_identity).toBe("owner_scheduled");
    expect(reflectionRuns.some((run) => run.kind === "curator")).toBe(false);
  });

  it("ignores unknown and invalid tool calls without external effects", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-runtime-"));
    roots.push(root);
    const store = await WorkspaceStore.create({ rootDir: root });
    const runtime = new AgentRuntime(store, undefined, new FakeProviderAdapter("fake/test", {
      content: "確認しました。",
      toolCalls: [
        { name: "unknown_tool", arguments: {} },
        { name: "create_artifact", arguments: { title: "壊れたArtifact" } },
        { name: "request_delete", arguments: { risk: "low", approval: "none" } }
      ]
    }));
    const session = await runtime.createSession();

    const result = await runtime.runChatTurn({
      sessionId: session.id,
      content: "削除して",
      output_locale: "ja"
    });
    await store.close();

    expect(result.artifacts).toEqual([]);
    expect(result.operations.some((operation) => operation.operation === "artifact.create")).toBe(false);
    expect(result.operations.some((operation) => operation.operation === "unknown_tool")).toBe(false);
    expect(result.approvalRequests).toEqual([]);
    expect(result.backendEvents.some((event) => event.event_type === "tool_call_output" && event.payload.status === "ignored")).toBe(true);
    expect(result.toolRuns.filter((toolRun) => toolRun.status === "ignored").length).toBeGreaterThanOrEqual(2);
  });

  it("builds reusable context from memory wiki skills and session search", async () => {
    const { store, runtime } = await createRuntime();
    const session = await runtime.createSession();
    await runtime.runChatTurn({
      sessionId: session.id,
      content: "今後この文体を覚えて。設計メモを書く時は短く。",
      output_locale: "ja"
    });
    const memory = (await store.listMemory()).find((item) => item.state === "topic")!;
    const now = new Date().toISOString();
    const wiki = await runtime.createWikiProposal({
      title: "設計方針",
      content: "# 設計方針\n\nWorkspaceを正本にする。",
      content_locale: "ja",
      source_refs: [{
        kind: "memory",
        id: memory.id,
        uri: `memory/${memory.id}`,
        label: memory.topic
      }]
    });
    await runtime.acceptWikiPage(wiki.resource.id);
    await store.saveSkillMarkdown({
      state: "project",
      skillId: "skill_context_test",
      markdown: skillMarkdown({
        id: "skill_context_test",
        state: "project",
        title: "設計メモ手順",
        description: "設計メモを短く整える",
        createdAt: now,
        required_capabilities: ["artifact.create"]
      })
    });
    await store.saveSkillMarkdown({
      state: "project",
      skillId: "skill_missing_capability",
      markdown: skillMarkdown({
        id: "skill_missing_capability",
        state: "project",
        title: "設計メモ未来手順",
        description: "設計メモを未来の未対応capabilityで処理する",
        createdAt: now,
        required_capabilities: ["future.unavailable"]
      })
    });
    await runtime.saveSkillSupportFile({
      skillId: "skill_context_test",
      path: "references/style.md",
      content: "補助資料: 箇条書きを優先する。"
    });
    await store.recordSkillUsage({
      skillId: "skill_context_test",
      runId: "run_context_usage",
      usedAt: now
    });

    const context = await runtime.previewContext({
      sessionId: session.id,
      query: "設計メモ"
    });
    const contextWithSupport = await runtime.previewContext({
      sessionId: session.id,
      query: "設計メモ references"
    });
    await store.close();

    expect(context.active_memory.some((item) => item.id === memory.id && item.content.includes("設計メモ"))).toBe(true);
    expect(context.knowledge_wiki.some((item) => item.title === "設計方針" && item.content.includes("Workspace"))).toBe(true);
    expect(context.knowledge_wiki.some((item) => item.source_refs.some((ref) => ref.id === memory.id))).toBe(true);
    expect(context.knowledge_wiki.find((item) => item.title === "設計方針")?.provenance).toMatchObject({
      kind: "user_authored",
      verified: true
    });
    const selectedSkill = context.selected_skills.find((item) => item.id === "skill_context_test");
    const selectedSkillWithSupport = contextWithSupport.selected_skills.find((item) => item.id === "skill_context_test");
    expect(context.selected_skills.map((item) => item.id)).not.toContain("skill_missing_capability");
    expect(context.skill_selection_report).toMatchObject({
      selected_skill_ids: expect.arrayContaining(["skill_context_test"])
    });
    expect(context.skill_selection_report.excluded).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "skill_missing_capability",
        reason: "missing_capability",
        missing_capabilities: ["future.unavailable"]
      })
    ]));
    expect(selectedSkill).toMatchObject({
      disclosure_level: "catalog",
      allowed_scopes: ["workspace"],
      required_capabilities: ["artifact.create"],
      selection: expect.objectContaining({
        matched_capabilities: ["artifact.create"],
        missing_capabilities: [],
        unsupported_scopes: []
      }),
      usage: { use_count: 1, last_used_at: now },
      support_file_refs: [expect.objectContaining({ path: "references/style.md" })]
    });
    expect(selectedSkill?.support_file_refs?.[0]?.file_path).toContain("skills/support/skill_context_test/references/style.md");
    expect(selectedSkill?.content).toBeUndefined();
    expect(selectedSkill?.support_files).toBeUndefined();
    expect(selectedSkillWithSupport).toMatchObject({
      disclosure_level: "catalog",
      support_file_refs: [expect.objectContaining({ path: "references/style.md" })],
      support_files: undefined,
      content: undefined
    });
    expect(selectedSkillWithSupport?.support_file_refs?.[0]?.file_path).toContain("skills/support/skill_context_test/references/style.md");
    expect(context.session_summary).toMatchObject({
      session_key: "web:owner:main",
      message_count: expect.any(Number),
      operation_count: expect.any(Number),
      backend_run_count: expect.any(Number),
      tool_run_count: expect.any(Number),
      workspace_change_count: expect.any(Number)
    });
    expect(context.session_summary.message_count).toBeGreaterThanOrEqual(2);
    expect(context.session_summary.backend_run_count).toBeGreaterThanOrEqual(1);
    expect(context.external_assist).toMatchObject({
      role: "assistive",
      isolated_from_memory: true,
      included_in_active_memory: false
    });
    expect(context.available_tools).toContain("wiki.proposal.create");
    expect(context.context_assembly.sources).toContainEqual(expect.objectContaining({
      kind: "active_memory",
      status: expect.any(String),
      included_count: expect.any(Number)
    }));
    expect(context.context_assembly.sources).toContainEqual(expect.objectContaining({
      kind: "knowledge_wiki",
      included_count: expect.any(Number)
    }));
    expect(context.context_assembly.quality_checks).toContainEqual(expect.objectContaining({
      id: "external_assist_isolated",
      status: "pass"
    }));
    expect(context.freeze_snapshot?.soul.file_ref.uri).toBe(path.join("profile", "SOUL.md"));
    expect(context.freeze_snapshot?.content).toContain("SOUL.md");
    expect(context.freeze_snapshot?.memory_refs.some((ref) => ref.id === memory.id)).toBe(true);
    expect(context.freeze_snapshot?.wiki_refs.some((ref) => ref.id === wiki.resource.id)).toBe(true);
  });

  it("passes host context assembly into native provider input and run metadata", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-runtime-"));
    roots.push(root);
    const store = await WorkspaceStore.create({ rootDir: root });
    let providerInput: ProviderInput | undefined;
    const runtime = new AgentRuntime(store, undefined, new FakeProviderAdapter("fake/test", (input) => {
      providerInput = input;
      return { content: "context ok", toolCalls: [] };
    }));
    const session = await runtime.createSession();

    const result = await runtime.runChatTurn({
      sessionId: session.id,
      content: "context assembly check",
      output_locale: "ja"
    });
    await store.close();

    expect(providerInput?.contextAssembly?.session_id).toBe(session.id);
    expect(providerInput?.contextAssembly?.sources).toContainEqual(expect.objectContaining({
      kind: "recent_messages",
      included_count: expect.any(Number)
    }));
    expect(providerInput?.contextAssembly?.sources).toContainEqual(expect.objectContaining({
      kind: "available_tools",
      status: "included"
    }));
    expect(providerInput?.availableTools).toContain("skill.view");
    expect(result.backendRun.metadata.context_assembly_sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "recent_messages" }),
      expect.objectContaining({ kind: "available_tools" })
    ]));
  });

  it("passes real Memory Wiki and Skill context into native provider input and run metadata", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-runtime-"));
    roots.push(root);
    const store = await WorkspaceStore.create({ rootDir: root });
    let providerInput: ProviderInput | undefined;
    const runtime = new AgentRuntime(store, undefined, new FakeProviderAdapter("fake/test", (input) => {
      providerInput = input;
      return { content: "real context ok", toolCalls: [] };
    }));
    const session = await runtime.createSession();
    const now = new Date().toISOString();
    await store.saveMemory(
      memoryFrontmatter({
        id: "memory_context_bridge",
        state: "topic",
        topic: "設計メモ preference"
      }),
      "設計メモは短く、Workspaceの正本に沿って書く。"
    );
    const wiki = await runtime.createWikiProposal({
      title: "設計メモの根拠",
      content: "# 設計メモの根拠\n\ncontext bridge needleはWorkspace正本から使う。",
      content_locale: "ja",
      source_refs: [{
        kind: "memory",
        id: "memory_context_bridge",
        uri: "memory/memory_context_bridge",
        label: "設計メモ preference"
      }]
    });
    await runtime.acceptWikiPage(wiki.resource.id);
    await store.saveSkillMarkdown({
      state: "project",
      skillId: "skill_context_bridge",
      markdown: skillMarkdown({
        id: "skill_context_bridge",
        state: "project",
        title: "設計メモ bridge",
        description: "設計メモ references を使って短くまとめる",
        createdAt: now,
        required_capabilities: ["artifact.create"]
      })
    });
    await runtime.saveSkillSupportFile({
      skillId: "skill_context_bridge",
      path: "references/style.md",
      content: "補助資料: provider inputへ渡る実データcontext。"
    });

    const result = await runtime.runChatTurn({
      sessionId: session.id,
      content: "設計メモ references context bridge needle を使って短いメモを作って",
      output_locale: "ja"
    });
    const usage = await store.listSkillUsage();
    const learningUses = await store.listLearningResourceUses({ runId: result.backendRun.id });
    await store.close();

    expect(providerInput?.activeMemory).toContainEqual(expect.objectContaining({
      content: expect.stringContaining("設計メモは短く"),
      frontmatter: expect.objectContaining({ id: "memory_context_bridge", state: "topic" })
    }));
    expect(providerInput?.knowledgeWiki).toContainEqual(expect.objectContaining({
      id: wiki.resource.id,
      title: "設計メモの根拠",
      content: expect.stringContaining("context bridge needle")
    }));
    const selectedSkill = providerInput?.selectedSkills.find((skill) => skill.id === "skill_context_bridge");
    expect(selectedSkill).toMatchObject({
      disclosure_level: "catalog",
      required_capabilities: ["artifact.create"],
      selection: expect.objectContaining({
        matched_capabilities: ["artifact.create"],
        missing_capabilities: []
      }),
      support_file_refs: [expect.objectContaining({
        path: "references/style.md"
      })],
      support_files: undefined,
      content: undefined
    });
    const sources = providerInput?.contextAssembly?.sources ?? [];
    expect(sources.find((source) => source.kind === "active_memory")?.included_count).toBeGreaterThanOrEqual(1);
    expect(sources.find((source) => source.kind === "knowledge_wiki")?.included_count).toBeGreaterThanOrEqual(1);
    expect(sources.find((source) => source.kind === "selected_skills")?.included_count).toBeGreaterThanOrEqual(1);
    const metadataSources = result.backendRun.metadata.context_assembly_sources as Array<{ kind: string; included_count: number }>;
    expect(metadataSources.find((source) => source.kind === "active_memory")?.included_count).toBeGreaterThanOrEqual(1);
    expect(metadataSources.find((source) => source.kind === "knowledge_wiki")?.included_count).toBeGreaterThanOrEqual(1);
    expect(metadataSources.find((source) => source.kind === "selected_skills")?.included_count).toBeGreaterThanOrEqual(1);
    expect(result.backendRun.metadata.context_assembly_quality_warnings).toEqual([]);
    expect(result.backendRun.metadata.freeze_snapshot_hash).toEqual(expect.any(String));
    expect(usage.some((row) => row.skill_id === "skill_context_bridge" && row.use_count > 0)).toBe(false);
    expect(learningUses).toEqual(expect.arrayContaining([
      expect.objectContaining({ resource_kind: "memory", resource_id: "memory_context_bridge", stage: "body_loaded" }),
      expect.objectContaining({ resource_kind: "wiki", resource_id: wiki.resource.id, stage: "body_loaded" }),
      expect.objectContaining({ resource_kind: "skill", resource_id: "skill_context_bridge", stage: "selected" })
    ]));
  });

  it("isolates external assist failures and records sync diagnostics", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-runtime-"));
    roots.push(root);
    const store = await WorkspaceStore.create({ rootDir: root });
    let prefetchCount = 0;
    const externalAssist: ExternalAssistProvider = {
      id: "test-external",
      async prefetch() {
        prefetchCount += 1;
        if (prefetchCount === 1) {
          throw new Error("prefetch unavailable");
        }
        return [{
          id: "hint_external",
          title: "External hint",
          summary: "Keep this separate from accepted Memory.",
          source_uri: "external://hint"
        }];
      },
      async syncTurn() {
        return [{
          id: "hint_sync",
          summary: "Synced turn for next retrieval.",
          source_uri: "external://sync"
        }];
      }
    };
    const runtime = new AgentRuntime(
      store,
      undefined,
      new FakeProviderAdapter("fake/test", { content: "ok", toolCalls: [] }),
      undefined,
      undefined,
      externalAssist
    );
    const session = await runtime.createSession();

    const firstContext = await runtime.previewContext({
      sessionId: session.id,
      query: "external assist"
    });
    const result = await runtime.runChatTurn({
      sessionId: session.id,
      content: "external assistを分けて",
      output_locale: "ja"
    });
    const secondContext = await runtime.previewContext({
      sessionId: session.id,
      query: "external assist"
    });
    const records = await store.listExternalAssistRecords({ sessionId: session.id });
    const memory = await store.listMemory();
    await store.close();

    expect(firstContext.external_assist.hints).toEqual([]);
    expect(firstContext.external_assist.recent_failures).toContainEqual(expect.objectContaining({
      phase: "prefetch",
      status: "failed",
      error: "prefetch unavailable",
      included_in_active_memory: false
    }));
    expect(result.backendRun.metadata.external_assist_sync_status).toBe("completed");
    expect(secondContext.external_assist.hints).toContainEqual(expect.objectContaining({
      id: "hint_external",
      summary: "Keep this separate from accepted Memory."
    }));
    expect(secondContext.context_assembly.sources).toContainEqual(expect.objectContaining({
      kind: "external_assist",
      status: "included"
    }));
    expect(records.some((record) => record.phase === "sync" && record.status === "completed")).toBe(true);
    expect(memory.some((item) => item.source_kind === "external_provider")).toBe(false);
  });

  it("keeps only active Knowledge Wiki pages in backend context through lifecycle operations", async () => {
    const { store, runtime } = await createRuntime();
    const session = await runtime.createSession();
    const activeProposal = await runtime.createWikiProposal({
      title: "Active Wiki",
      content: "# Active Wiki\n\nactive-only needle",
      content_locale: "ja",
      source_refs: [{
        kind: "memory",
        id: "memory_source",
        uri: "memory/topic/memory_source.md",
        label: "Memory source"
      }]
    });
    const rejectedProposal = await runtime.createWikiProposal({
      title: "Rejected Wiki",
      content: "# Rejected Wiki\n\nactive-only needle",
      content_locale: "ja"
    });
    const archivedProposal = await runtime.createWikiProposal({
      title: "Archived Wiki",
      content: "# Archived Wiki\n\nactive-only needle",
      content_locale: "ja"
    });

    await runtime.acceptWikiPage(activeProposal.resource.id);
    await runtime.patchWikiPage({
      id: activeProposal.resource.id,
      content: "# Active Wiki\n\nactive-only needle patched"
    });
    await runtime.rejectWikiPage(rejectedProposal.resource.id);
    await runtime.archiveWikiPage(archivedProposal.resource.id);

    const context = await runtime.previewContext({
      sessionId: session.id,
      query: "active-only needle"
    });
    const preview = await runtime.previewKnowledgeWiki({ query: "active-only needle" });
    const allWiki = await store.listWiki({ activeOnly: false });
    const operations = await store.listOperations();
    await store.close();

    expect(allWiki.map((wiki) => ({ id: wiki.id, state: wiki.state }))).toEqual(expect.arrayContaining([
      { id: activeProposal.resource.id, state: "active" },
      { id: rejectedProposal.resource.id, state: "rejected" },
      { id: archivedProposal.resource.id, state: "archived" }
    ]));
    expect(context.knowledge_wiki.map((wiki) => wiki.id)).toContain(activeProposal.resource.id);
    expect(context.knowledge_wiki.map((wiki) => wiki.id)).not.toContain(rejectedProposal.resource.id);
    expect(context.knowledge_wiki.map((wiki) => wiki.id)).not.toContain(archivedProposal.resource.id);
    expect(context.knowledge_wiki.find((wiki) => wiki.id === activeProposal.resource.id)?.content).toContain("patched");
    expect(context.knowledge_wiki.find((wiki) => wiki.id === activeProposal.resource.id)?.provenance).toMatchObject({
      kind: "user_authored",
      verified: true
    });
    expect(context.knowledge_wiki_report.excluded).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: rejectedProposal.resource.id, reason: "rejected" }),
      expect.objectContaining({ id: archivedProposal.resource.id, reason: "archived" })
    ]));
    expect(preview.graph.nodes).toContainEqual(expect.objectContaining({
      id: activeProposal.resource.id,
      source_ref_count: 1
    }));
    expect(preview.graph.edges).toContainEqual(expect.objectContaining({
      from_wiki_id: activeProposal.resource.id,
      relation: "source_ref"
    }));
    expect(operations.map((operation) => operation.operation)).toEqual(expect.arrayContaining([
      "wiki.proposal.create",
      "wiki.accept",
      "wiki.patch",
      "wiki.reject",
      "wiki.archive"
    ]));
    expect(operations.some((operation) => operation.target_resource_refs.some((ref) => ref.id === activeProposal.resource.id))).toBe(true);
  });

  it("does not use fixed tool-count rules for Background Review", async () => {
    const { store, runtime } = await createRuntime();
    const session = await runtime.createSession();
    const result = await runtime.runChatTurn({
      sessionId: session.id,
      content: "定例作業を実行して",
      output_locale: "ja"
    });
    const now = nowIso();
    for (let index = 0; index < 5; index += 1) {
      await store.saveToolRun({
        id: `tool_trace_${index}`,
        run_id: result.backendRun.id,
        session_id: session.id,
        tool_call_id: `tool_call_${index}`,
        provider_tool_name: index % 2 === 0 ? "file.read" : "browser.extract",
        action_id: index % 2 === 0 ? "file.read" : "browser.extract",
        status: index === 3 ? "ignored" : "completed",
        input_summary: `input ${index}`,
        output_summary: index === 3 ? "gateway_boundary_tool_not_allowed" : `output ${index}`,
        resource_refs: [],
        created_at: now
      });
    }

    const reflection = await runtime.runReflection({ sessionId: session.id, sourceRunId: result.backendRun.id });
    await store.close();

    expect(reflection.suggestions).toEqual([]);
  });

  it("does not use fixed correction keywords for Background Review", async () => {
    const { store, runtime } = await createRuntime();
    const session = await runtime.createSession();
    const now = nowIso();
    await store.saveMessage({
      id: createId("message"),
      session_id: session.id,
      role: "user",
      content: "次からこの作業は保存前に差分確認して。さっきの手順を修正して",
      input_locale: "ja",
      output_locale: "ja",
      created_at: now
    });
    await store.saveMessage({
      id: createId("message"),
      session_id: session.id,
      role: "agent",
      content: "了解、次回から差分確認を先に入れます。",
      input_locale: "ja",
      output_locale: "ja",
      created_at: now
    });

    const reflection = await runtime.runReflection({ sessionId: session.id });
    await store.close();

    expect(reflection.suggestions).toEqual([]);
  });

  it("applies Background Review Memory changes without persisting review prompts to the source Session", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-runtime-"));
    roots.push(root);
    const store = await WorkspaceStore.create({ rootDir: root });
    const runtime = new AgentRuntime(
      store,
      undefined,
      new FakeProviderAdapter("fake/test", fakeProviderOutput),
      undefined,
      undefined,
      undefined,
      undefined,
      {
        backgroundReviewRunner: {
          run: async (snapshot) => ({
            reviewer: "test-reviewer",
            summary: "Stored a durable preference.",
            mutations: [{
              kind: "memory_add" as const,
              topic: "response-style",
              content: "回答は短い箇条書きを優先する。",
              reason: "The user stated a durable response preference.",
              evidence_refs: [{ kind: "backend_run", id: snapshot.source_run_id, uri: `backend-runs/${snapshot.source_run_id}` }]
            }]
          })
        }
      }
    );
    const session = await runtime.createSession();
    const result = await runtime.runChatTurn({ sessionId: session.id, content: "回答は短い箇条書きにして", output_locale: "ja" });
    const [messages, memories, changes, reports] = await Promise.all([store.listMessages(session.id), store.listMemory(), store.listBackgroundReviewChanges({ sourceRunId: result.backendRun.id }), store.listLearningJobReports({ jobKind: "background_review" })]);
    await store.close();

    expect(result.reflectionRuns[0]).toMatchObject({ kind: "background_review", status: "completed" });
    expect(result.reflectionSuggestions).toContainEqual(expect.objectContaining({ status: "applied", suggestion_type: "memory" }));
    expect(memories).toContainEqual(expect.objectContaining({ topic: "response-style" }));
    expect(changes).toContainEqual(expect.objectContaining({ origin: "background_review", review_run_id: result.reflectionRuns[0]?.id, after_version: expect.any(String) }));
    expect(reports).toContainEqual(expect.objectContaining({ job_kind: "background_review", mutation_count: 1 }));
    expect(messages).toHaveLength(2);
  });

  it("does not convert workspace-wide tool counts into fixed Skill suggestions", async () => {
    const { store, runtime } = await createRuntime();
    const firstSession = await runtime.createSession();
    const firstRun = await runtime.runChatTurn({
      sessionId: firstSession.id,
      content: "最近の繰り返し作業をSkill候補にして",
      output_locale: "ja"
    });
    const secondSession = await runtime.createSession();
    const secondRun = await runtime.runChatTurn({
      sessionId: secondSession.id,
      content: "別の作業",
      output_locale: "ja"
    });
    const now = nowIso();
    const toolRuns = [
      { run: firstRun.backendRun.id, session: firstSession.id, name: "file.read", status: "completed" as const },
      { run: firstRun.backendRun.id, session: firstSession.id, name: "artifact.write", status: "completed" as const },
      { run: secondRun.backendRun.id, session: secondSession.id, name: "file.read", status: "completed" as const },
      { run: secondRun.backendRun.id, session: secondSession.id, name: "file.read", status: "completed" as const },
      { run: secondRun.backendRun.id, session: secondSession.id, name: "artifact.write", status: "completed" as const }
    ];
    for (const [index, toolRun] of toolRuns.entries()) {
      await store.saveToolRun({
        id: `workspace_tool_trace_${index}`,
        run_id: toolRun.run,
        session_id: toolRun.session,
        tool_call_id: `workspace_tool_call_${index}`,
        provider_tool_name: toolRun.name,
        action_id: toolRun.name,
        status: toolRun.status,
        input_summary: `workspace input ${index}`,
        output_summary: `workspace output ${index}`,
        resource_refs: [],
        created_at: now
      });
    }

    const reflection = await runtime.runReflection({ sessionId: firstSession.id });
    await store.close();

    expect(reflection.suggestions).toEqual([]);
  });

  it("filters provisional memory and redacts high sensitive active memory", async () => {
    const { store, runtime } = await createRuntime();
    const session = await runtime.createSession();
    const provisional = memoryFrontmatter({ state: "provisional", topic: "secret draft" });
    const sensitive = memoryFrontmatter({ state: "sensitive", topic: "secret token", sensitive_level: "high" });
    const conflict = memoryFrontmatter({ state: "topic", topic: "secret conflict", conflicts_with: [sensitive.id] });
    await store.saveMemory(provisional, "secret draft should not be injected");
    await store.saveMemory(sensitive, "secret token is 12345");
    await store.saveMemory(conflict, "secret conflict should be reviewed");

    const context = await runtime.previewContext({
      sessionId: session.id,
      query: "secret"
    });
    const preview = await runtime.previewActiveMemory({ query: "secret" });
    await store.close();

    expect(context.active_memory.some((item) => item.id === provisional.id)).toBe(false);
    expect(context.active_memory_report.excluded).toContainEqual(expect.objectContaining({
      id: provisional.id,
      state: "provisional",
      reason: "provisional_pending"
    }));
    expect(preview.report.excluded).toContainEqual(expect.objectContaining({
      id: provisional.id,
      reason: "provisional_pending"
    }));
    const sensitiveMemory = context.active_memory.find((item) => item.id === sensitive.id);
    expect(sensitiveMemory).toMatchObject({
      state: "sensitive",
      sensitive_level: "high",
      priority: "sensitive",
      content: "[sensitive memory withheld: secret token]"
    });
    expect(context.active_memory_report.sensitive_redactions).toContainEqual(expect.objectContaining({
      id: sensitive.id,
      sensitive_level: "high",
      redacted: true
    }));
    expect(context.active_memory_report.conflict_groups).toContainEqual(expect.objectContaining({
      memory_ids: [conflict.id, sensitive.id],
      proposed_action: "review"
    }));
    expect(context.context_assembly.omissions).toContainEqual(expect.objectContaining({
      kind: "active_memory"
    }));
    expect(sensitiveMemory?.content).not.toContain("12345");
  });

  it("returns dynamic chart render specs for surface operations", async () => {
    const { store, runtime } = await createRuntime();
    const session = await runtime.createSession();

    const result = await runtime.runSurfaceOperation({
      id: "surface_chart_test",
      kind: "chart.request",
      session_id: session.id,
      title: "進捗グラフ",
      query: "最近の進捗をグラフ化",
      data_refs: ["collection/progress"],
      output_locale: "ja"
    });
    const artifacts = await store.listArtifactsForSession(session.id);
    const workspaceChanges = await store.listWorkspaceChanges(session.id);
    await store.close();
    const chartResult = result.result as { resource: { kind: string; metadata: Record<string, unknown> }; workspaceChange: { change_type: string } };

    expect(result.result_kind).toBe("chart_request");
    expect(result.render_spec).toMatchObject({
      kind: "chart",
      priority: "primary",
      props: {
        chart_id: expect.any(String),
        chart_type: "table",
        data_refs: ["collection/progress"]
      },
      fallback: {
        kind: "artifact"
      }
    });
    expect(chartResult.resource.kind).toBe("chart");
    expect(chartResult.resource.metadata).toMatchObject({
      surface_operation_id: "surface_chart_test",
      surface_operation_kind: "chart.request"
    });
    expect(chartResult.workspaceChange.change_type).toBe("artifact_created");
    expect(artifacts.some((artifact) => artifact.kind === "chart")).toBe(true);
    expect(workspaceChanges.some((change) => change.resource_ref.id === (result.render_spec.resource_refs[0]?.id ?? ""))).toBe(true);
  });

  it("dispatches structured surface operations without falling back to chat prompts", async () => {
    const { store, runtime } = await createRuntime();
    const session = await runtime.createSession();

    const form = await runtime.runSurfaceOperation({
      id: "surface_form_test",
      kind: "form.submit",
      session_id: session.id,
      form_id: "contact_form",
      values: { name: "Samurai", priority: 3, subscribed: true },
      submit_label: "保存"
    });
    const table = await runtime.runSurfaceOperation({
      id: "surface_table_test",
      kind: "table.patch",
      session_id: session.id,
      table_id: "contacts",
      row_id: "row_1",
      changes: { name: "Takuma", status: "active" }
    });
    const artifact = await runtime.runSurfaceOperation({
      id: "surface_artifact_test",
      kind: "artifact.request",
      session_id: session.id,
      action: "create",
      title: "提案書",
      instruction: "短い提案書を作る"
    });
    const custom = await runtime.runSurfaceOperation({
      id: "surface_custom_test",
      kind: "custom_view.action",
      session_id: session.id,
      view_id: "kanban",
      action_id: "move_card",
      payload: { renderer: "kanban", card_id: "card_1", column_id: "done" }
    });
    const operations = await store.listOperations();
    const artifacts = await store.listArtifactsForSession(session.id);
    await store.close();

    expect(form.result_kind).toBe("form_submission");
    expect(table.result_kind).toBe("table_patch");
    expect(artifact.result_kind).toBe("artifact");
    expect(custom.result_kind).toBe("custom_view_action");
    expect(form.render_spec.kind).toBe("form");
    expect(table.render_spec.kind).toBe("table");
    expect(artifact.render_spec.kind).toBe("artifact");
    expect(custom.render_spec.kind).toBe("custom_view");
    expect(custom.render_spec.props).toMatchObject({
      sandbox: {
        mode: "iframe",
        allow_scripts: true,
        allow_forms: false,
        allow_same_origin: false,
        network_access: "read",
        workspace_access: "read"
      },
      capability: {
        token_id: expect.stringMatching(/^custom_view:/),
        allowed_actions: ["move_card"],
        write_operations: ["custom_view.action"],
        data_capabilities: ["read", "write"]
      }
    });
    expect(custom.render_spec.props.capability).toMatchObject({
      read_resource_refs: expect.arrayContaining([
        expect.objectContaining({ kind: "artifact" })
      ])
    });
    expect(operations.filter((operation) => operation.operation === "artifact.create").length).toBeGreaterThanOrEqual(4);
    expect(artifacts.map((item) => item.kind)).toEqual(expect.arrayContaining(["structured_draft", "table", "document"]));
  });

  it("negotiates structured surface render specs against frontend capabilities", async () => {
    const { store, runtime } = await createRuntime();
    const session = await runtime.createSession();

    const custom = await runtime.runSurfaceOperation({
      id: "surface_custom_fallback_test",
      kind: "custom_view.action",
      session_id: session.id,
      view_id: "kanban",
      action_id: "move_card",
      payload: { renderer: "kanban", card_id: "card_1", column_id: "done" },
      renderer_capabilities: {
        supported_kinds: ["chat", "artifact", "status_timeline"],
        custom_view_renderers: []
      }
    });
    await store.close();

    expect(custom.result_kind).toBe("custom_view_action");
    expect(custom.render_spec).toMatchObject({
      kind: "artifact",
      negotiation: {
        requested_kind: "custom_view",
        requested_renderer: "kanban",
        reason: "unsupported_kind",
        applied_fallback: true
      },
      props: {
        artifact_id: expect.any(String)
      }
    });
  });

  it("runs file actions through Domain dispatch and rollback", async () => {
    const { store, runtime } = await createRuntime();

    const written = (await runtime.runDomainCommand({ command_id: "file.write", idempotency_key: "file-action-write", payload: { path: "notes/test.md", content: "hello" } })).result as { operation: OperationRecord };
    const read = (await runtime.runDomainQuery({ query_id: "file.read", payload: { path: "notes/test.md" } })).result as { resource: { content: string } };
    const patched = (await runtime.runDomainCommand({ command_id: "file.patch", idempotency_key: "file-action-patch", payload: { path: "notes/test.md", search: "hello", replace: "hello samurai" } })).result as { resource: { content: string }; rollbackPoint?: RollbackPoint };
    await store.close();

    expect(written.operation.operation).toBe("file.write");
    expect(read.resource.content).toBe("hello");
    expect(patched.resource.content).toBe("hello samurai");
    expect(patched.rollbackPoint).toBeDefined();
  });

  it("allows direct Collection file writes as an escape hatch and reindexes afterward", async () => {
    const { store, runtime } = await createRuntime();

    const schemaWrite = (await runtime.runDomainCommand({ command_id: "file.write", idempotency_key: "collection-file-schema", payload: {
      path: "collections/movies/schema.json", content: JSON.stringify({
        id: "movies",
        version: "1",
        labels: { ja: "映画ログ" },
        descriptions: {},
        fields: [{ id: "title", type: "string", required: true }],
        refs: [],
        embeds: [],
        derived_fields: [],
        triggers: [],
        actions: [],
        views: [{ id: "movies_table", renderer: "collection_table" }],
        permissions: { create: true, update: true, delete: true }
      }, null, 2)
    } })).result as { operation: OperationRecord };
    const recordWrite = (await runtime.runDomainCommand({ command_id: "file.write", idempotency_key: "collection-file-record", payload: {
      path: "collections/movies/records/movie_1.json", content: JSON.stringify({
        id: "movie_1",
        collection_id: "movies",
        data: { title: "Seven Samurai" },
        resource_refs: [],
        created_at: nowIso(),
        updated_at: nowIso()
      }, null, 2)
    } })).result as { operation: OperationRecord };
    const records = await store.listCollectionRecords("movies");
    await store.close();

    expect(schemaWrite.operation.operation).toBe("file.write");
    expect(recordWrite.operation.operation).toBe("file.write");
    expect(records).toHaveLength(1);
    expect(records[0]?.data).toMatchObject({ title: "Seven Samurai" });
  });

  it("rejects removed grant operations as deprecated", async () => {
    const { store, runtime } = await createRuntime();
    await expect(runtime.runDomainCommand({ command_id: "grant.create", idempotency_key: "deprecated-grant-create", payload: {} })).rejects.toMatchObject({ code: "gone" });
    await expect(runtime.runDomainCommand({ command_id: "grant.revoke", idempotency_key: "deprecated-grant-revoke", payload: {} })).rejects.toMatchObject({ code: "gone" });
    await store.close();
  });

  it("restores file content from a rollback point with audit and a new rollback", async () => {
    const { store, runtime } = await createRuntime();

    await runtime.runDomainCommand({ command_id: "file.write", idempotency_key: "restore-file-write", payload: { path: "notes/restore.md", content: "hello" } });
    const patchCommand = await runtime.runDomainCommand({ command_id: "file.patch", idempotency_key: "restore-file-patch", payload: { path: "notes/restore.md", search: "hello", replace: "hello samurai" } });
    const patched = patchCommand.result as Awaited<ReturnType<AgentRuntime["restoreRollbackPoint"]>>;
    const restored = await runtime.restoreRollbackPoint(patched.rollbackPoint!.id);
    const readQuery = await runtime.runDomainQuery({ query_id: "file.read", payload: { path: "notes/restore.md" } });
    const read = readQuery.result as { resource: { content: string } };
    await store.close();

    expect(restored.operation.operation).toBe("rollback.restore");
    expect(restored.resource).toMatchObject({
      rollback_point_id: patched.rollbackPoint!.id,
      path: "notes/restore.md",
      action: "written"
    });
    expect(restored.rollbackPoint).toBeDefined();
    expect(restored.rollbackPoint?.operation_id).toBe(restored.operation.id);
    expect(read.resource.content).toBe("hello");
  });

  it("prepares and dry-runs external sends through Domain Commands", async () => {
    const { store, runtime } = await createRuntime();

    const prepared = await prepareExternalSend(runtime, {
      channel: "webhook",
      target: { url: "https://example.invalid/webhook" },
      title: "確認",
      body: "送信本文"
    });
    const dispatched = await dispatchExternalSend(runtime, { sendId: prepared.resource.id });
    const sends = await store.listExternalSends();
    await store.close();

    expect(prepared.operation.operation).toBe("external.send.prepare");
    expect(dispatched.resource.dispatch_result).toMatchObject({ dry_run: true });
    expect(sends[0]?.status).toBe("approved");
  });

  it("records non-dry-run external send success and failure statuses", async () => {
    const { store, runtime } = await createRuntime();
    vi.stubEnv("SAMURAI_EXTERNAL_SEND_DISPATCH", "true");
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("ok", { status: 200 }))
      .mockResolvedValueOnce(new Response("failed", { status: 500 }))
      .mockRejectedValueOnce(new Error("dispatch failed with raw-secret-token"));

    const okDraft = await prepareExternalSend(runtime, {
      channel: "webhook",
      target: { url: "https://example.test/ok" },
      title: "成功通知",
      body: "送信本文"
    });
    const failedDraft = await prepareExternalSend(runtime, {
      channel: "webhook",
      target: { url: "https://example.test/fail" },
      title: "失敗通知",
      body: "送信本文"
    });
    const rejectedDraft = await prepareExternalSend(runtime, {
      channel: "webhook",
      target: { url: "https://example.test/reject" },
      title: "例外通知",
      body: "送信本文"
    });

    const ok = await requestAndApproveExternalSend(runtime, store, okDraft.resource.id);
    const failed = await requestAndApproveExternalSend(runtime, store, failedDraft.resource.id);
    const rejected = await requestAndApproveExternalSend(runtime, store, rejectedDraft.resource.id);
    const sends = await store.listExternalSends();
    await store.close();

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(ok).toMatchObject({
      status: "dispatched",
      dispatch_result: {
        dispatched: true,
        dry_run: false,
        status: 200
      }
    });
    expect(failed).toMatchObject({
      status: "failed",
      dispatch_result: {
        dispatched: false,
        dry_run: false,
        status: 500,
        message: "webhook dispatch failed."
      }
    });
    expect(rejected).toMatchObject({
      status: "failed",
      dispatch_result: {
        dispatched: false,
        dry_run: false,
        message: expect.stringContaining("[redacted]")
      }
    });
    expect(JSON.stringify(rejected.dispatch_result)).not.toContain("raw-secret-token");
    expect(sends.map((send) => [send.id, send.status])).toEqual(expect.arrayContaining([
      [ok.id, "dispatched"],
      [failed.id, "failed"],
      [rejected.id, "failed"]
    ]));
  });

  it("dispatches Slack Telegram and LINE sends through configured API transports", async () => {
    const { store, runtime } = await createRuntime();
    vi.stubEnv("SAMURAI_EXTERNAL_SEND_DISPATCH", "true");
    vi.stubEnv("SAMURAI_SLACK_BOT_TOKEN", "xoxb-raw-secret-token");
    vi.stubEnv("SAMURAI_SLACK_API_URL", "https://slack.example.test/chat.postMessage");
    vi.stubEnv("SAMURAI_TELEGRAM_BOT_TOKEN", "123456:raw-secret-token");
    vi.stubEnv("SAMURAI_TELEGRAM_API_BASE_URL", "https://telegram.example.test");
    vi.stubEnv("SAMURAI_LINE_CHANNEL_ACCESS_TOKEN", "line-raw-secret-token");
    vi.stubEnv("SAMURAI_LINE_API_BASE_URL", "https://line.example.test/v2/bot/message");
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));

    const slackDraft = await prepareExternalSend(runtime, {
      channel: "slack",
      target: { channel_id: "C123", thread_ts: "111.222" },
      title: "Slack通知",
      body: "Slack本文"
    });
    const telegramDraft = await prepareExternalSend(runtime, {
      channel: "telegram",
      target: { chat_id: "-100123", message_thread_id: 7 },
      title: "Telegram通知",
      body: "Telegram本文"
    });
    const lineDraft = await prepareExternalSend(runtime, {
      channel: "line",
      target: { to: "U456" },
      title: "LINE通知",
      body: "LINE本文"
    });

    const slack = await requestAndApproveExternalSend(runtime, store, slackDraft.resource.id);
    const telegram = await requestAndApproveExternalSend(runtime, store, telegramDraft.resource.id);
    const line = await requestAndApproveExternalSend(runtime, store, lineDraft.resource.id);
    await store.close();

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(fetchSpy).toHaveBeenNthCalledWith(1, "https://slack.example.test/chat.postMessage", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({
        authorization: "Bearer xoxb-raw-secret-token",
        "content-type": "application/json"
      }),
      body: JSON.stringify({
        channel: "C123",
        text: "*Slack通知*\nSlack本文",
        thread_ts: "111.222"
      })
    }));
    expect(fetchSpy).toHaveBeenNthCalledWith(2, "https://telegram.example.test/bot123456:raw-secret-token/sendMessage", expect.objectContaining({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: "-100123",
        text: "Telegram通知\n\nTelegram本文",
        message_thread_id: "7"
      })
    }));
    expect(fetchSpy).toHaveBeenNthCalledWith(3, "https://line.example.test/v2/bot/message/push", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({
        authorization: "Bearer line-raw-secret-token",
        "content-type": "application/json"
      }),
      body: JSON.stringify({
        to: "U456",
        messages: [{
          type: "text",
          text: "LINE通知\n\nLINE本文"
        }]
      })
    }));
    expect(slack).toMatchObject({ status: "dispatched", dispatch_result: { adapter: "slack", transport: "api", dispatched: true } });
    expect(telegram).toMatchObject({ status: "dispatched", dispatch_result: { adapter: "telegram", transport: "api", dispatched: true } });
    expect(line).toMatchObject({ status: "dispatched", dispatch_result: { adapter: "line", transport: "api", dispatched: true } });
    expect(JSON.stringify([slack.dispatch_result, telegram.dispatch_result, line.dispatch_result])).not.toContain("raw-secret-token");
  });

  it("dispatches Email sends through configured SMTP transport", async () => {
    const { store, runtime } = await createRuntime();
    vi.stubEnv("SAMURAI_EXTERNAL_SEND_DISPATCH", "true");
    vi.stubEnv("SAMURAI_EMAIL_SMTP_HOST", "smtp.example.test");
    vi.stubEnv("SAMURAI_EMAIL_SMTP_PORT", "2525");
    vi.stubEnv("SAMURAI_EMAIL_SMTP_SECURE", "false");
    vi.stubEnv("SAMURAI_EMAIL_SMTP_STARTTLS", "false");
    vi.stubEnv("SAMURAI_EMAIL_SMTP_USER", "smtp-user");
    vi.stubEnv("SAMURAI_EMAIL_SMTP_PASSWORD", "smtp-raw-secret-password");
    vi.stubEnv("SAMURAI_EMAIL_FROM", "assistant@example.test");
    const smtp = new FakeSmtpConnection([
      { code: 220, lines: ["220 smtp ready"] },
      { code: 250, lines: ["250 smtp.example.test"] },
      { code: 235, lines: ["235 authenticated"] },
      { code: 250, lines: ["250 sender ok"] },
      { code: 250, lines: ["250 recipient ok"] },
      { code: 250, lines: ["250 recipient ok"] },
      { code: 354, lines: ["354 send data"] },
      { code: 250, lines: ["250 queued"] }
    ]);
    setExternalSendSmtpClientConnectionFactoryForTest(async () => smtp);

    const draft = await prepareExternalSend(runtime, {
      channel: "email",
      target: {
        to: ["client@example.test"],
        cc: "ops@example.test"
      },
      title: "Email通知",
      body: "Email本文\n.second line"
    });
    const sent = await requestAndApproveExternalSend(runtime, store, draft.resource.id);
    await store.close();

    expect(sent).toMatchObject({
      status: "dispatched",
      dispatch_result: {
        adapter: "email",
        transport: "smtp",
        dispatched: true,
        dry_run: false
      }
    });
    expect(smtp.commands).toEqual([
      "EHLO samurai-agent.local",
      `AUTH PLAIN ${Buffer.from("\0smtp-user\0smtp-raw-secret-password", "utf8").toString("base64")}`,
      "MAIL FROM:<assistant@example.test>",
      "RCPT TO:<client@example.test>",
      "RCPT TO:<ops@example.test>",
      "DATA",
      "QUIT"
    ]);
    expect(smtp.data[0]).toContain("From: assistant@example.test\r\n");
    expect(smtp.data[0]).toContain("To: client@example.test, ops@example.test\r\n");
    expect(smtp.data[0]).toContain("Subject: Email通知\r\n");
    expect(smtp.data[0]).toContain("Email本文\r\n..second line\r\n.\r\n");
    expect(smtp.closed).toBe(true);
    expect(JSON.stringify(sent.dispatch_result)).not.toContain("smtp-raw-secret-password");
  });

  it("blocks unpaired gateway inbound messages and routes approved pairings into chat", async () => {
    const { store, runtime } = await createRuntime();

    const blocked = await runtime.handleGatewayInbound({
      channel: "webhook",
      source_identity: "external source/1",
      source_label: "External Source",
      body: "初回の外部入力です"
    });
    const approved = await runtime.approveGatewayPairing(blocked.pairing!.id);
    const duplicate = await runtime.handleGatewayInbound({
      channel: "webhook",
      source_identity: "external source/1",
      source_label: "External Source",
      body: "初回の外部入力です"
    });
    const processed = await runtime.handleGatewayInbound({
      channel: "webhook",
      source_identity: "external source/1",
      body: "提案書を作って",
      output_locale: "ja"
    });
    const savedInbound = await store.listGatewayInboundMessages({ status: "processed" });
    const boundaryPolicies = await store.listGatewayBoundaryPolicies({ sessionKey: "webhook:external~20source~2F1:main" });
    const releasedLock = await store.getGatewayConcurrencyLock("webhook:external~20source~2F1:main");
    await store.close();

    expect(blocked.inbound).toMatchObject({
      status: "blocked",
      trusted: false,
      pairing_id: blocked.pairing!.id
    });
    expect(duplicate.inbound.id).toBe(blocked.inbound.id);
    expect(blocked.pairing).toMatchObject({
      status: "pending",
      source_identity: "external source/1",
      session_key: "webhook:external~20source~2F1:main"
    });
    expect(approved).toMatchObject({
      status: "approved",
      pairing_code: undefined
    });
    expect(processed.inbound).toMatchObject({
      status: "processed",
      trusted: true,
      session_key: "webhook:external~20source~2F1:main"
    });
    expect(processed.session?.session_key).toBe("webhook:external~20source~2F1:main");
    expect(processed.boundaryPolicy).toMatchObject({
      source_channel: "webhook",
      source_identity: "external source/1",
      session_key: "webhook:external~20source~2F1:main",
      allowed_tools: [],
      sandbox: { mode: "non_main", workspace_access: "none", network_access: "none" }
    });
    expect(boundaryPolicies.map((policy) => policy.id)).toContain(processed.boundaryPolicy?.id);
    expect(processed.chat?.backendRun.metadata.gateway_boundary_policy_id).toBe(processed.boundaryPolicy?.id);
    expect(processed.chat?.backendRun.metadata.gateway_boundary_allowed_tools).toEqual([]);
    expect(processed.chat?.artifacts).toEqual([]);
    expect(processed.chat?.toolRuns).toContainEqual(expect.objectContaining({
      action_id: "artifact.create",
      status: "ignored",
      output_summary: "gateway_boundary_tool_not_allowed",
      resource_refs: [expect.objectContaining({
        kind: "gateway_boundary_policy",
        id: processed.boundaryPolicy?.id
      })]
    }));
    expect(processed.chat?.workspaceChanges).toContainEqual(expect.objectContaining({
      change_type: "other",
      resource_ref: expect.objectContaining({
        kind: "gateway_boundary_policy",
        id: processed.boundaryPolicy?.id
      }),
      summary: expect.stringContaining("Gateway boundary blocked tool")
    }));
    expect(processed.chat?.backendEvents.some((event) => event.event_type === "run_started")).toBe(true);
    expect(processed.chat?.backendEvents).toContainEqual(expect.objectContaining({
      event_type: "tool_call_output",
      payload: expect.objectContaining({
        status: "ignored",
        gateway_boundary: expect.objectContaining({
          decision: "denied",
          action_id: "artifact.create",
          reason: "tool_not_allowed",
          policy_id: processed.boundaryPolicy?.id,
          allowed_tools: []
        })
      }),
      resource_refs: [expect.objectContaining({
        kind: "gateway_boundary_policy",
        id: processed.boundaryPolicy?.id
      })]
    }));
    expect(processed.chat?.backendEvents.some((event) => event.event_type === "run_completed")).toBe(true);
    expect(processed.chat?.reflectionRuns.some((run) => run.status === "completed")).toBe(true);
    expect(releasedLock).toMatchObject({
      lock_key: "webhook:external~20source~2F1:main",
      status: "released"
    });
    expect(processed.chat?.messages.some((message) => message.role === "agent" && message.content === "対応しました。")).toBe(true);
    expect(savedInbound.map((message) => message.id)).toContain(processed.inbound.id);
  });

  it("expires pending gateway pairings before approving or routing new inbound", async () => {
    const { store, runtime } = await createRuntime();

    const blocked = await runtime.handleGatewayInbound({
      channel: "webhook",
      source_identity: "expiring source",
      source_label: "Expiring Source",
      body: "初回"
    });
    const expiredAt = new Date(0).toISOString();
    await store.saveGatewayPairing({
      ...blocked.pairing!,
      expires_at: expiredAt,
      updated_at: expiredAt
    });

    const approved = await runtime.approveGatewayPairing(blocked.pairing!.id);
    const routed = await runtime.handleGatewayInbound({
      channel: "webhook",
      source_identity: "expiring source",
      source_label: "Expiring Source",
      body: "期限後の新規入力"
    });
    const expiredPairings = await store.listGatewayPairings("expired");
    const pendingPairings = await store.listGatewayPairings("pending");
    await store.close();

    expect(approved).toMatchObject({
      id: blocked.pairing!.id,
      status: "expired",
      pairing_code: undefined
    });
    expect(routed.pairing).toMatchObject({
      status: "pending",
      source_identity: "expiring source"
    });
    expect(routed.pairing?.id).not.toBe(blocked.pairing!.id);
    expect(expiredPairings.map((pairing) => pairing.id)).toContain(blocked.pairing!.id);
    expect(pendingPairings.map((pairing) => pairing.id)).toContain(routed.pairing!.id);
  });

  it("previews and applies gateway repair actions for expired pairings and locks", async () => {
    const { store, runtime } = await createRuntime();
    const now = new Date().toISOString();
    const past = new Date(Date.now() - 60_000).toISOString();
    const blocked = await runtime.handleGatewayInbound({
      channel: "webhook",
      source_identity: "repair-source",
      source_label: "Repair Source",
      body: "初回"
    });
    await store.saveGatewayPairing({
      ...blocked.pairing!,
      expires_at: past,
      updated_at: past
    });
    await store.acquireGatewayConcurrencyLock({
      lockKey: "webhook:repair-source:main",
      scope: "session",
      policyId: "gateway-policy-repair-test",
      ownerRef: { kind: "gateway_inbound", id: "repair-test", uri: "gateway-inbound/repair-test" },
      ttlMs: 1_000,
      now: past
    });

    const preview = await runtime.repairGatewayState({ dryRun: true, now });
    const previewPairing = await store.getGatewayPairing(blocked.pairing!.id);
    const previewLock = await store.getGatewayConcurrencyLock("webhook:repair-source:main");
    const applied = await runtime.repairGatewayState({ dryRun: false, now });
    const repairedPairing = await store.getGatewayPairing(blocked.pairing!.id);
    const repairedLock = await store.getGatewayConcurrencyLock("webhook:repair-source:main");
    await store.close();

    expect(preview.dry_run).toBe(true);
    expect(preview.applied_count).toBe(0);
    expect(preview.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "expire_pairing", status: "planned" }),
      expect.objectContaining({ action: "expire_concurrency_lock", status: "planned" })
    ]));
    expect(previewPairing?.status).toBe("pending");
    expect(previewLock?.status).toBe("acquired");
    expect(applied.dry_run).toBe(false);
    expect(applied.applied_count).toBe(2);
    expect(applied.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "expire_pairing", status: "applied", after_status: "expired" }),
      expect.objectContaining({ action: "expire_concurrency_lock", status: "applied", after_status: "expired" })
    ]));
    expect(repairedPairing?.status).toBe("expired");
    expect(repairedLock?.status).toBe("expired");
  });

  it("routes gateway pairings by account and thread session key", async () => {
    const { store, runtime } = await createRuntime();

    const threadA = await runtime.handleGatewayInbound({
      channel: "webhook",
      source_identity: "shared-bot",
      account_id: "workspace/1",
      thread_id: "thread A",
      body: "thread A first"
    });
    const threadB = await runtime.handleGatewayInbound({
      channel: "webhook",
      source_identity: "shared-bot",
      account_id: "workspace/1",
      thread_id: "thread B",
      body: "thread B first"
    });
    await runtime.approveGatewayPairing(threadA.pairing!.id);

    const processedA = await runtime.handleGatewayInbound({
      channel: "webhook",
      source_identity: "shared-bot",
      account_id: "workspace/1",
      thread_id: "thread A",
      body: "thread A follow-up",
      output_locale: "ja"
    });
    const blockedB = await runtime.handleGatewayInbound({
      channel: "webhook",
      source_identity: "shared-bot",
      account_id: "workspace/1",
      thread_id: "thread B",
      body: "thread B follow-up"
    });
    await store.close();

    expect(threadA.pairing?.session_key).toBe("webhook:workspace~2F1:thread~20A");
    expect(threadB.pairing?.session_key).toBe("webhook:workspace~2F1:thread~20B");
    expect(threadA.pairing?.id).not.toBe(threadB.pairing?.id);
    expect(processedA.inbound.status).toBe("processed");
    expect(processedA.session?.session_key).toBe("webhook:workspace~2F1:thread~20A");
    expect(blockedB.inbound.status).toBe("blocked");
    expect(blockedB.pairing?.id).toBe(threadB.pairing?.id);
  });

  it("blocks approved gateway inbound while the session concurrency lock is held", async () => {
    const { store, runtime } = await createRuntime();
    const blocked = await runtime.handleGatewayInbound({
      channel: "webhook",
      source_identity: "busy-source",
      source_label: "Busy Source",
      body: "初回"
    });
    await runtime.approveGatewayPairing(blocked.pairing!.id);
    await store.acquireGatewayConcurrencyLock({
      lockKey: "webhook:busy-source:main",
      scope: "session",
      policyId: "manual-policy",
      ownerRef: { kind: "gateway_inbound", id: "manual", uri: "gateway-inbound/manual" },
      ttlMs: 60_000
    });

    const busy = await runtime.handleGatewayInbound({
      channel: "webhook",
      source_identity: "busy-source",
      body: "同時実行は止めて"
    });
    const lock = await store.getGatewayConcurrencyLock("webhook:busy-source:main");
    const expired = await store.expireGatewayConcurrencyLocks(new Date(Date.now() + 120_000).toISOString());
    const repairedLock = await store.getGatewayConcurrencyLock("webhook:busy-source:main");
    await store.close();

    expect(busy.inbound).toMatchObject({
      status: "blocked",
      trusted: true,
      error: "gateway_concurrency_locked"
    });
    expect(busy.chat).toBeUndefined();
    expect(busy.concurrencyLock).toMatchObject({
      lock_key: "webhook:busy-source:main",
      status: "acquired"
    });
    expect(lock).toMatchObject({
      lock_key: "webhook:busy-source:main",
      status: "acquired"
    });
    expect(expired).toContainEqual(expect.objectContaining({
      lock_key: "webhook:busy-source:main",
      status: "expired"
    }));
    expect(repairedLock?.status).toBe("expired");
  });

  it("rate limits noisy gateway sources before routing to Host", async () => {
    const { store, runtime } = await createRuntime();

    for (let index = 0; index < 20; index += 1) {
      await runtime.handleGatewayInbound({
        channel: "webhook",
        source_identity: "rate-source",
        body: `message ${index}`
      });
    }
    const limited = await runtime.handleGatewayInbound({
      channel: "webhook",
      source_identity: "rate-source",
      body: "message 20"
    });
    await store.close();

    expect(limited.inbound).toMatchObject({
      status: "blocked",
      trusted: false,
      error: "gateway_rate_limited"
    });
  });

  it("blocks gateway sources outside the configured allowlist", async () => {
    const previous = process.env.SAMURAI_GATEWAY_SOURCE_ALLOWLIST;
    process.env.SAMURAI_GATEWAY_SOURCE_ALLOWLIST = "webhook:allowed-source";
    const { store, runtime } = await createRuntime();
    try {
      const blocked = await runtime.handleGatewayInbound({
        channel: "webhook",
        source_identity: "blocked-source",
        body: "hello"
      });

      expect(blocked.inbound).toMatchObject({
        status: "blocked",
        trusted: false,
        error: "gateway_source_not_allowed"
      });
      expect(blocked.pairing).toBeUndefined();
    } finally {
      if (previous === undefined) {
        delete process.env.SAMURAI_GATEWAY_SOURCE_ALLOWLIST;
      } else {
        process.env.SAMURAI_GATEWAY_SOURCE_ALLOWLIST = previous;
      }
      await store.close();
    }
  });

  it("auto-approves trusted local gateway sources from channel policy", async () => {
    const { store, runtime } = await createRuntime();

    const processed = await runtime.handleGatewayInbound({
      channel: "local_cli",
      source_identity: "owner-terminal",
      body: "メモを作って",
      route: "main",
      output_locale: "ja"
    });
    const policies = await runtime.listGatewayPairingPolicies();
    await store.close();

    expect(policies).toContainEqual(expect.objectContaining({
      channel: "local_cli",
      trust_mode: "auto_approve"
    }));
    expect(processed.pairing).toMatchObject({
      status: "approved",
      source_identity: "owner-terminal",
      metadata: expect.objectContaining({
        gateway_pairing_policy_auto_approved: true
      })
    });
    expect(processed.inbound).toMatchObject({
      status: "processed",
      trusted: true
    });
  });

  it("blocks inbound before pairing when the saved channel policy is blocked", async () => {
    const { store, runtime } = await createRuntime();
    const now = nowIso();
    const policy: GatewayPairingPolicyRecord = {
      id: "gateway_pairing_policy_webhook",
      channel: "webhook",
      status: "enabled",
      trust_mode: "blocked",
      allowlist: ["*"],
      pairing_ttl_ms: 300_000,
      duplicate_window_ms: 60_000,
      rate_limit_window_ms: 60_000,
      rate_limit_max: 20,
      metadata: {},
      created_at: now,
      updated_at: now
    };

    await runtime.saveGatewayPairingPolicy(policy);
    const blocked = await runtime.handleGatewayInbound({
      channel: "webhook",
      source_identity: "blocked-by-policy",
      body: "hello"
    });
    await store.close();

    expect(blocked.inbound).toMatchObject({
      status: "blocked",
      trusted: false,
      error: "gateway_pairing_policy_blocked"
    });
    expect(blocked.pairing).toBeUndefined();
  });

  it("applies saved gateway pairing policy rate limits before routing", async () => {
    const { store, runtime } = await createRuntime();
    const now = nowIso();
    const policy: GatewayPairingPolicyRecord = {
      id: "gateway_pairing_policy_webhook",
      channel: "webhook",
      status: "enabled",
      trust_mode: "pairing_required",
      allowlist: ["*"],
      pairing_ttl_ms: 300_000,
      duplicate_window_ms: 60_000,
      rate_limit_window_ms: 60_000,
      rate_limit_max: 1,
      metadata: {},
      created_at: now,
      updated_at: now
    };

    await runtime.saveGatewayPairingPolicy(policy);
    const first = await runtime.handleGatewayInbound({
      channel: "webhook",
      source_identity: "limited-source",
      body: "first"
    });
    const limited = await runtime.handleGatewayInbound({
      channel: "webhook",
      source_identity: "limited-source",
      body: "second"
    });
    await store.close();

    expect(first.inbound).toMatchObject({
      status: "blocked",
      trusted: false
    });
    expect(limited.inbound).toMatchObject({
      status: "blocked",
      trusted: false,
      error: "gateway_rate_limited"
    });
  });

  it("applies saved gateway routing policy before creating pairings", async () => {
    const { store, runtime } = await createRuntime();
    const now = nowIso();
    const policy: GatewayRoutingPolicyRecord = {
      id: "gateway_routing_policy_webhook",
      channel: "webhook",
      status: "enabled",
      session_key_strategy: "account_main",
      default_route: "main",
      metadata: {},
      created_at: now,
      updated_at: now
    };

    await runtime.saveGatewayRoutingPolicy(policy);
    const first = await runtime.handleGatewayInbound({
      channel: "webhook",
      source_identity: "same-source",
      account_id: "account/1",
      thread_id: "thread-a",
      route: "route-a",
      body: "first message"
    });
    const second = await runtime.handleGatewayInbound({
      channel: "webhook",
      source_identity: "same-source",
      account_id: "account/1",
      thread_id: "thread-b",
      route: "route-b",
      body: "second message"
    });
    await store.close();

    expect(first.pairing).toMatchObject({
      status: "pending",
      session_key: "webhook:account~2F1:main"
    });
    expect(second.pairing?.id).toBe(first.pairing?.id);
    expect(second.inbound.metadata.gateway_routing_policy).toMatchObject({
      id: policy.id,
      session_key_strategy: "account_main"
    });
    expect(second.inbound.metadata.gateway_source_scope).toMatchObject({
      account_id: "account/1",
      thread_id: "main",
      session_key: "webhook:account~2F1:main"
    });
  });

  it("saves and runs due automation jobs", async () => {
    const { store, runtime } = await createRuntime();
    const preview = runtime.previewAutomationSchedule("hourly", "2026-01-01T00:00:00.000Z");

    const saved = await runtime.saveAutomationJob({
      title: "Wiki reindex",
      kind: "wiki_reindex",
      schedule: "daily",
      target_instruction: "Reindex wiki",
      next_run_at: new Date(0).toISOString()
    });
    const runs = await runtime.runDueAutomationJobs();
    const refreshedJob = await store.getAutomationJob(saved.resource.id);
    await store.close();

    expect(preview).toMatchObject({
      normalized: "hourly",
      one_shot: false,
      next_run_at: "2026-01-01T01:00:00.000Z"
    });
    expect(saved.operation.operation).toBe("automation.job.save");
    expect(runs[0]?.operation.operation).toBe("automation.job.run");
    expect(refreshedJob?.last_run_at).toBeTruthy();
    expect(refreshedJob?.locked_until).toBeUndefined();
    expect(refreshedJob?.retry_after_at).toBeUndefined();
    expect(refreshedJob?.failure_count).toBe(0);
  });

  it("initializes Background Review, Evaluation, and Curator as separate scheduled jobs", async () => {
    const { store, runtime } = await createRuntime();
    const jobs = await runtime.ensureStandardLearningJobs("2026-07-10T00:00:00.000Z");
    const repeated = await runtime.ensureStandardLearningJobs("2026-07-10T01:00:00.000Z");
    await store.close();

    expect(jobs.map((job) => job.kind)).toEqual(expect.arrayContaining(["memory_review", "learning_evaluation", "skill_curator"]));
    expect(new Set(jobs.map((job) => job.id)).size).toBe(3);
    expect(repeated.map((job) => job.id).sort()).toEqual(jobs.map((job) => job.id).sort());
  });

  it("runs scheduled natural language jobs through backend chat turns", async () => {
    const { store, runtime } = await createRuntime();

    const saved = await runtime.saveAutomationJob({
      title: "Daily digest",
      kind: "daily_digest",
      schedule: "once",
      target_instruction: "定期メモを作って",
      next_run_at: new Date(0).toISOString()
    });
    const runs = await runtime.runDueAutomationJobs(new Date(Date.now() + 1000).toISOString());
    const automationRun = runs[0]?.automationRun;
    const refreshedRun = automationRun ? await store.getAutomationRun(automationRun.id) : undefined;
    const backendRun = refreshedRun?.backend_run_id ? await store.getBackendRun(refreshedRun.backend_run_id) : undefined;
    const backendEvents = backendRun ? await store.listBackendEvents({ runId: backendRun.id }) : [];
    const messages = refreshedRun?.session_id ? await store.listMessages(refreshedRun.session_id) : [];
    const refreshedJob = await store.getAutomationJob(saved.resource.id);
    await store.close();

    expect(runs[0]?.operation.operation).toBe("automation.job.run");
    expect(refreshedRun).toMatchObject({
      status: "completed",
      backend_run_id: backendRun?.id
    });
    expect(backendRun).toMatchObject({
      status: "completed",
      backend_id: "samurai-native"
    });
    expect(backendEvents.some((event) => event.event_type === "run_completed")).toBe(true);
    expect(messages.some((message) => message.role === "user" && message.content === "定期メモを作って")).toBe(true);
    expect(refreshedJob).toMatchObject({
      status: "disabled",
      failure_count: 0
    });
  });

  it("stores automation retry state when a scheduled job fails", async () => {
    const { store, runtime } = await createRuntime();

    const saved = await runtime.saveAutomationJob({
      title: "Failing wiki reindex",
      kind: "wiki_reindex",
      schedule: "hourly",
      target_instruction: "Reindex wiki",
      next_run_at: new Date(0).toISOString(),
      max_attempts: 2
    });
    vi.spyOn(store, "reindexWiki").mockRejectedValueOnce(new Error("reindex boom"));

    await expect(runtime.runDueAutomationJobs()).rejects.toThrow("reindex boom");
    const refreshedJob = await store.getAutomationJob(saved.resource.id);
    await store.close();

    expect(refreshedJob).toMatchObject({
      status: "enabled",
      failure_count: 1,
      max_attempts: 2,
      last_error: "reindex boom"
    });
    expect(refreshedJob?.retry_after_at).toBeTruthy();
    expect(refreshedJob?.locked_until).toBeUndefined();
  });

  it("runs curator and evaluation jobs as reflection loops", async () => {
    const { store, runtime } = await createRuntime();
    const session = await runtime.createSession();
    await runtime.runChatTurn({
      sessionId: session.id,
      content: "今後、失敗したtoolは手順に反映して",
      output_locale: "ja"
    });
    const wikiProposal = await runtime.createWikiProposal({
      title: "未検証の運用知識",
      content: "# 未検証の運用知識\n\n確認前の知識。",
      content_locale: "ja"
    });
    const skillCandidate = await runtime.createSkillCandidate({
      title: "失敗tool手順",
      description: "失敗したtool runを手順へ戻す",
      content: "# 失敗tool手順"
    });
    await runtime.saveSkillProject({ candidateId: skillCandidate.resource.id });

    const curator = await runtime.runCuratorJob();
    const evaluation = await runtime.runEvaluationJob();
    const learningReports = await store.listLearningJobReports();
    await store.close();

    expect(curator.reflectionRun.kind).toBe("curator");
    expect(curator.suggestions.some((suggestion) =>
      suggestion.suggestion_type === "knowledge_wiki" && suggestion.target_ref?.id === wikiProposal.resource.id
    )).toBe(true);
    expect(curator.curatorReviewReport?.wiki_patch_proposals).toContainEqual(expect.objectContaining({
      wiki_id: wikiProposal.resource.id,
      reason: "Proposed page needs accept/reject review."
    }));
    expect(curator.suggestions.some((suggestion) =>
      suggestion.suggestion_type === "skill_patch" && suggestion.title.includes("失敗tool手順")
    )).toBe(true);
    expect(evaluation.reflectionRun.kind).toBe("evaluation");
    expect(evaluation.evaluationReport).toMatchObject({
      judge: {
        deterministic_status: "completed",
        external_status: "not_configured"
      },
      counts: expect.objectContaining({
        backend_runs: expect.any(Number),
        findings: expect.any(Number)
      })
    });
    expect(evaluation.evaluationReport?.run_scores.length).toBeGreaterThan(0);
    expect(evaluation.suggestions.some((suggestion) => suggestion.suggestion_type === "conflict" || suggestion.suggestion_type === "skill_patch")).toBe(true);
    expect(learningReports).toEqual(expect.arrayContaining([
      expect.objectContaining({ job_kind: "curator", snapshot_id: expect.any(String) }),
      expect.objectContaining({ job_kind: "evaluation", evaluation_count: expect.any(Number) })
    ]));
  });

  it("can apply an external evaluation judge to trace scores without changing workspace state", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-runtime-"));
    roots.push(root);
    const store = await WorkspaceStore.create({ rootDir: root });
    const runtime = new AgentRuntime(
      store,
      undefined,
      new FakeProviderAdapter("fake/test", fakeProviderOutput),
      undefined,
      undefined,
      undefined,
      {
        id: "judge/test",
        async judge({ report }) {
          return {
            summary: "External judge reviewed deterministic trace scores.",
            scoreAdjustments: report.run_scores.slice(0, 1).map((score) => ({
              run_id: score.run_id,
              score_delta: -5,
              reason: "External judge wants a stricter score."
            }))
          };
        }
      }
    );
    const session = await runtime.createSession();
    await runtime.runChatTurn({
      sessionId: session.id,
      content: "提案書を作って",
      output_locale: "ja"
    });

    const evaluation = await runtime.runEvaluationJob();
    const runsAfterEvaluation = await store.listBackendRuns();
    await store.close();

    expect(evaluation.evaluationReport).toMatchObject({
      judge: {
        external_status: "completed",
        provider_id: "judge/test",
        summary: "External judge reviewed deterministic trace scores."
      }
    });
    expect(evaluation.evaluationReport?.run_scores[0]?.findings).toContainEqual(expect.objectContaining({
      kind: "external_judge",
      reason: "External judge wants a stricter score."
    }));
    expect(runsAfterEvaluation.every((run) => run.status === "completed")).toBe(true);
  });

  it("can skip curator work when the idle gate is respected", async () => {
    const { store, runtime } = await createRuntime();
    const session = await runtime.createSession();
    await runtime.runChatTurn({
      sessionId: session.id,
      content: "最近の作業",
      output_locale: "ja"
    });

    const curator = await runtime.runCuratorJob({ respectIdleGate: true });
    const curatorState = await store.getCuratorState();
    await store.close();

    expect(curator.suggestions).toEqual([]);
    expect(curator.reflectionRun.output_summary).toContain("Curator skipped");
    expect(curatorState.last_run_summary).toContain("Curator skipped");
  });

  it("records selected skill usage and lets curator propose lifecycle actions", async () => {
    const { store, runtime } = await createRuntime();
    await store.saveSkillMarkdown({
      state: "project",
      skillId: "skill_used",
      markdown: skillMarkdown({
        id: "skill_used",
        state: "project",
        title: "Used workflow",
        description: "usage marker workflow",
        last_reviewed_at: "2026-01-01T00:00:00.000Z"
      })
    });
    await store.saveSkillMarkdown({
      state: "project",
      skillId: "skill_old",
      markdown: skillMarkdown({
        id: "skill_old",
        state: "project",
        title: "Ancient routine",
        description: "very old unused routine",
        last_reviewed_at: "2025-01-01T00:00:00.000Z"
      })
    });
    await store.saveSkillMarkdown({
      state: "project",
      skillId: "skill_old_pair",
      markdown: skillMarkdown({
        id: "skill_old_pair",
        state: "project",
        title: "Ancient routine pair",
        description: "very old unused routine pair",
        last_reviewed_at: "2025-01-02T00:00:00.000Z"
      })
    });
    await store.saveSkillMarkdown({
      state: "project",
      skillId: "skill_pinned",
      markdown: skillMarkdown({
        id: "skill_pinned",
        state: "project",
        title: "Pinned routine",
        description: "old pinned routine",
        last_reviewed_at: "2025-01-01T00:00:00.000Z",
        owner_pinned: true
      })
    });
    await store.saveCuratorState({
      stale_after_days: 7,
      archive_after_days: 14
    });
    await store.saveMemory(memoryFrontmatter({
      id: "memory_duplicate_a",
      state: "topic",
      topic: "duplicate routine"
    }), "duplicate memory A");
    await store.saveMemory(memoryFrontmatter({
      id: "memory_duplicate_b",
      state: "topic",
      topic: "duplicate routine"
    }), "duplicate memory B");

    const session = await runtime.createSession();
    await runtime.runChatTurn({
      sessionId: session.id,
      content: "usage marker workflow を使って作業して",
      output_locale: "ja"
    });
    const usage = await store.getSkillUsage("skill_used");
    const curator = await runtime.runCuratorJob();
    const oldSkillBeforeApply = await store.getSkill("skill_old");
    const applied = await runtime.applyCuratorSkillAction({ skillId: "skill_old", action: "archive" });
    const oldSkillAfterApply = await store.getSkill("skill_old");
    const pinnedSkill = await store.getSkill("skill_pinned");
    await store.close();

    expect(usage).toBeUndefined();
    expect(curator.curatorReport).toMatchObject({
      dry_run: false,
      counts: expect.objectContaining({
        skill_items: expect.any(Number),
        suggestions: curator.suggestions.length
      }),
      skill_actions: expect.arrayContaining([
        expect.objectContaining({
          skill_id: "skill_old",
          action: "archive",
          proposed_state: "archived"
        })
      ]),
      protected_skills: expect.arrayContaining([
        expect.objectContaining({
          skill_id: "skill_pinned",
          reason: "owner_pinned"
        })
      ])
    });
    expect(curator.curatorReviewReport).toMatchObject({
      dry_run: true,
      counts: expect.objectContaining({
        consolidate_candidates: expect.any(Number),
        archive_candidates: expect.any(Number)
      }),
      memory_merge_groups: expect.arrayContaining([
        expect.objectContaining({
          topic: "duplicate routine",
          memory_ids: expect.arrayContaining(["memory_duplicate_a", "memory_duplicate_b"])
        })
      ]),
      skill_consolidation_groups: expect.arrayContaining([
        expect.objectContaining({
          skill_ids: expect.arrayContaining(["skill_old", "skill_old_pair"])
        })
      ]),
      archive_candidates: expect.arrayContaining([
        expect.objectContaining({
          kind: "skill",
          id: "skill_old"
        })
      ])
    });
    expect(curator.suggestions.some((suggestion) =>
      suggestion.title.includes("Ancient routine") && suggestion.content.includes("Curator action: archive")
    )).toBe(true);
    expect(curator.suggestions.some((suggestion) => suggestion.title.includes("Consolidate skills"))).toBe(true);
    expect(oldSkillBeforeApply?.state).toBe("archived");
    expect(applied.operation.operation).toBe("skill.lifecycle.apply");
    expect(applied.rollbackPoint).toBeDefined();
    expect(oldSkillAfterApply?.state).toBe("archived");
    expect(oldSkillAfterApply?.file_path).toBe(path.join("skills", "archived", "skill_old.md"));
    expect(pinnedSkill?.state).toBe("project");
  });

  it("protects an old low-frequency Skill when Evaluation shows a positive effect", async () => {
    const { store, runtime } = await createRuntime();
    await store.saveSkillMarkdown({
      state: "project",
      skillId: "skill_helpful_old",
      markdown: skillMarkdown({ id: "skill_helpful_old", state: "project", title: "Helpful old Skill", createdAt: "2025-01-01T00:00:00.000Z" })
    });
    await store.saveLearningEvaluation({
      id: "evaluation_helpful_old",
      learning_resource_ref: { kind: "skill", id: "skill_helpful_old", uri: "skills/skill_helpful_old" },
      learning_resource_version: "v1",
      task_class: "workspace_task",
      compared_run_ids: ["run_before", "run_after"],
      before_metrics: { quality_score: 0 }, after_metrics: { quality_score: 1 }, effect_estimate: 1,
      confidence: 0.8, assessment: "helpful", evidence_refs: [], evaluator: "test", created_at: nowIso()
    });

    const curator = await runtime.runCuratorJob();
    const skill = await store.getSkill("skill_helpful_old");
    await store.close();

    expect(skill?.state).toBe("project");
    expect(curator.curatorReviewReport?.keep_candidates).toContainEqual(expect.objectContaining({ id: "skill_helpful_old", reason: "positive_effect_protected" }));
  });

  it("downloads browser content into the workspace fallback adapter", async () => {
    const { store, runtime } = await createRuntime();
    const result = (await runtime.runDomainCommand({ command_id: "browser.download_to_workspace", idempotency_key: "browser-download", payload: { url: "data:text/html,<title>Test</title><main>Hello browser</main>", output_path: "browser/test.txt" } })).result as { operation: OperationRecord; resource: { file_path: string; text: string; snapshot_kind: string } };
    await store.close();

    expect(result.operation.operation).toBe("browser.download_to_workspace");
    expect(result.resource.file_path).toBe("browser/test.txt");
    expect(result.resource.text).toContain("Hello browser");
    expect(result.resource.snapshot_kind).toBe("html_snapshot");
  });

  it("rejects browser screenshots before execution when no screenshot adapter is available", async () => {
    const { store, runtime } = await createRuntime();

    await expect(runtime.runDomainCommand({ command_id: "browser.screenshot", idempotency_key: "browser-screenshot-no-adapter", payload: { url: "data:text/html,<main>Hello browser</main>", output_path: "browser/test.png" } })).rejects.toThrow("domain_operation_unavailable:browser.screenshot");

    expect((await store.listOperations()).some((operation) => operation.operation === "browser.screenshot")).toBe(false);
    await store.close();
  });

  it("applies reflection suggestions into reusable workspace resources", async () => {
    const { store, runtime } = await createRuntime();
    const session = await runtime.createSession();
    const now = nowIso();
    const reflection = await store.createReflectionRun({
      id: createId("reflection"), kind: "manual", session_id: session.id, status: "completed",
      input_summary: "legacy compatibility", output_summary: "legacy suggestion", started_at: now, completed_at: now
    });
    const suggestion = await store.saveReflectionSuggestion({
      id: createId("suggestion"), reflection_run_id: reflection.id, suggestion_type: "memory", status: "proposed",
      title: "議事録", content: "議事録は短くまとめる", source_refs: [], confidence: 0.8, created_at: now, updated_at: now
    });

    const applied = await runtime.applyReflectionSuggestion({ suggestionId: suggestion.id });
    const updated = (await store.listReflectionSuggestions()).find((item) => item.id === suggestion.id);
    await store.close();

    expect(applied.operation.operation).toBe("reflection.suggestion.apply");
    expect(updated?.status).toBe("applied");
  });
});

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

function memoryFrontmatter(input: Partial<MemoryFrontmatter> & { state: MemoryFrontmatter["state"]; topic: string }): MemoryFrontmatter {
  const now = nowIso();
  return {
    id: input.id ?? createId("memory"),
    state: input.state,
    topic: input.topic,
    source: input.source ?? "test",
    source_locale: input.source_locale ?? "ja",
    content_locale: input.content_locale ?? "ja",
    source_kind: input.source_kind ?? "owner_instruction",
    instruction_authority: input.instruction_authority ?? "owner",
    confidence: input.confidence ?? 0.9,
    created_by: input.created_by ?? "test",
    created_at: input.created_at ?? now,
    updated_at: input.updated_at ?? now,
    last_used_at: input.last_used_at,
    related_memories: input.related_memories ?? [],
    conflicts_with: input.conflicts_with ?? [],
    sensitive_level: input.sensitive_level ?? "none",
    source_refs: input.source_refs,
    provenance: input.provenance
  };
}

function gatewayBoundaryPolicy(allowedTools: string[]): GatewayBoundaryPolicy {
  const now = "2026-06-26T00:00:00.000Z";
  return {
    id: `gateway_boundary_${allowedTools.join("_").replaceAll(".", "_") || "none"}`,
    source_channel: "webhook",
    source_identity: "external-source",
    session_key: "webhook:external-source:main",
    allowed_tools: allowedTools,
    mcp_config_refs: [],
    secret_refs: [],
    sandbox: {
      mode: "non_main",
      scope: "session",
      backend: "none",
      workspace_access: "none",
      network_access: "none",
      allowed_paths: [],
      denied_paths: [],
      metadata: {}
    },
    path_normalization: {
      canonical_root: "workspace",
      reject_absolute_paths: true,
      reject_parent_segments: true,
      allowed_roots: ["workspace"],
      denied_roots: []
    },
    allowlist: ["webhook:external-source"],
    metadata: {},
    created_at: now,
    updated_at: now
  };
}

function skillMarkdown(input: Partial<SkillFrontmatter> & { id: string; state: SkillFrontmatter["state"]; createdAt?: string }): string {
  const frontmatter: SkillFrontmatter = {
    id: input.id,
    state: input.state,
    title: input.title ?? "Context Skill",
    description: input.description ?? "Reusable context skill",
    tags: input.tags ?? ["context"],
    provenance: input.provenance ?? "test",
    trust_level: input.trust_level ?? "user_authored",
    allowed_scopes: input.allowed_scopes ?? ["workspace"],
    required_capabilities: input.required_capabilities ?? [],
    schedule_policy: input.schedule_policy ?? {},
    secret_policy: input.secret_policy ?? {},
    owner_pinned: input.owner_pinned ?? false
  };
  return ["---", JSON.stringify(frontmatter, null, 2), "---", "# Steps", "", "- Keep the note short.", ""].join("\n");
}
