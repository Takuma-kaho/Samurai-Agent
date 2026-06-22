import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceStore } from "@samurai-agent/workspace-store";
import { AgentRuntime, FakeProviderAdapter, RuntimeRequestError, type ProviderOutput } from "./index";

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
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("agent runtime", () => {
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

  it("runs chat through operation policy audit artifact", async () => {
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
    expect(result.policyDecisions.some((decision) => decision.decision === "allow_auto")).toBe(true);
    expect(result.auditRecords.length).toBeGreaterThan(0);
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

  it("keeps safe drafting while outbound work waits for approval", async () => {
    const { store, runtime } = await createRuntime();
    const session = await runtime.createSession();
    const result = await runtime.runChatTurn({
      sessionId: session.id,
      content: "提案書を作って、あとでメール送信もして",
      output_locale: "ja"
    });
    await store.close();

    expect(result.artifacts.length).toBeGreaterThan(0);
    expect(result.approvalRequests.length).toBeGreaterThan(0);
    expect(result.operations.some((operation) => operation.status === "pending_approval")).toBe(true);
  });

  it("approves approval-gated work as deferred without external execution", async () => {
    const { store, runtime } = await createRuntime();
    const session = await runtime.createSession();
    const result = await runtime.runChatTurn({
      sessionId: session.id,
      content: "提案書を作って、あとでメール送信もして",
      output_locale: "ja"
    });
    const request = result.approvalRequests[0];
    expect(request).toBeDefined();

    const approved = await runtime.approveRequest(request!.id);
    await store.close();

    expect(approved.approvalRequest.status).toBe("approved");
    expect(approved.operation.status).toBe("deferred");
    expect(approved.auditRecord.outputs_summary).toContain("deferred");
  });

  it("denies approval-gated work and records audit", async () => {
    const { store, runtime } = await createRuntime();
    const session = await runtime.createSession();
    const result = await runtime.runChatTurn({
      sessionId: session.id,
      content: "提案書を作って、あとでメール送信もして",
      output_locale: "ja"
    });

    const denied = await runtime.denyRequest(result.approvalRequests[0]!.id, "owner", "不要です");
    await store.close();

    expect(denied.approvalRequest.status).toBe("denied");
    expect(denied.operation.status).toBe("denied");
    expect(denied.auditRecord.outputs_summary).toContain("denied");
  });

  it("returns conflict for double approval decisions", async () => {
    const { store, runtime } = await createRuntime();
    const session = await runtime.createSession();
    const result = await runtime.runChatTurn({
      sessionId: session.id,
      content: "提案書を作って、あとでメール送信もして",
      output_locale: "ja"
    });
    const request = result.approvalRequests[0]!;
    await runtime.approveRequest(request.id);

    await expect(runtime.denyRequest(request.id)).rejects.toMatchObject({ code: "conflict" });
    await store.close();
  });

  it("expires pending requests as deferred and returns conflict payload", async () => {
    const { store, runtime } = await createRuntime();
    const session = await runtime.createSession();
    const result = await runtime.runChatTurn({
      sessionId: session.id,
      content: "提案書を作って、あとでメール送信もして",
      output_locale: "ja"
    });
    const request = result.approvalRequests[0]!;
    await store.updateApprovalRequest({
      ...request,
      expires_at: "2020-01-01T00:00:00.000Z"
    });

    await expect(runtime.approveRequest(request.id)).rejects.toSatisfy((error) => {
      return (
        error instanceof RuntimeRequestError &&
        error.code === "conflict" &&
        error.payload?.approvalRequest.status === "expired" &&
        error.payload.operation.status === "deferred" &&
        error.payload.auditRecord.outputs_summary.includes("expired")
      );
    });
    await store.close();
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
    expect(archived.auditRecord.outputs_summary).toContain("Archived memory");
    expect(archived.rollbackPoint).toBeDefined();
    expect(archived.activity.length).toBeGreaterThan(0);
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
    expect(archivedAgain.auditRecord.outputs_summary).toContain("already archived");
  });

  it("creates skill candidates and projects through policy and audit", async () => {
    const { store, runtime } = await createRuntime();

    const candidate = await runtime.createSkillCandidate({
      title: "調査メモ",
      description: "調査メモを整える",
      content: "# Skill"
    });
    const project = await runtime.saveSkillProject({ candidateId: candidate.resource.id });
    await store.close();

    expect(candidate.operation.operation).toBe("skill.candidate.create");
    expect(candidate.policyDecision.decision).toBe("allow_auto");
    expect(candidate.auditRecord.operation_id).toBe(candidate.operation.id);
    expect(project.operation.operation).toBe("skill.project.save");
    expect(project.policyDecision.decision).toBe("allow_with_audit");
    expect(project.rollbackPoint).toBeDefined();
  });

  it("saves collection schema, record, and patch through policy audit rollback", async () => {
    const { store, runtime } = await createRuntime();
    const schema = collectionSchema("contacts");
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
  });

  it("records cron memory review with scheduled context and automation input ref", async () => {
    const { store, runtime } = await createRuntime();

    const result = await runtime.runMemoryReviewAutomation();
    const savedRun = await store.getAutomationRun(result.automationRun.id);
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
    expect(result.auditRecord.actor_identity).toBe("owner_scheduled");
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
    expect(result.operations.find((operation) => operation.operation === "workspace.delete")?.status).toBe("pending_approval");
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
