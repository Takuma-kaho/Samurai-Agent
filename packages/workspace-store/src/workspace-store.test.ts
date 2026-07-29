import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  createId,
  nowIso,
  type AutomationJobRecord,
  type ArtifactRecord,
  type AuditRecord,
  type BackendEventRecord,
  type BackendRunRecord,
  type CollectionSchema,
  type ClientEventRecord,
  type ExternalAssistRecord,
  type GatewayBoundaryPolicy,
  type GatewayInboundMessageRecord,
  type GatewayMcpConfigRecord,
  type GatewayPairingPolicyRecord,
  type GatewayPairingRecord,
  type GatewayRoutingPolicyRecord,
  type MemoryFrontmatter,
  type MessageEnvelope,
  type OperationRecord,
  type PolicyDecisionRecord,
  type SessionRecord,
  type SkillFrontmatter,
  type WorkspaceChangeRecord,
  type ToolRunRecord,
  type WikiFrontmatter
} from "@samurai-agent/core-schemas";
import { WorkspaceStore, renderFrontmatter } from "./index";

const roots: string[] = [];

async function createTempStore() {
  const root = await mkdtemp(path.join(tmpdir(), "samurai-store-"));
  roots.push(root);
  return WorkspaceStore.create({ rootDir: root });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("workspace store", () => {
  it("creates settings and persists sessions", async () => {
    const store = await createTempStore();
    const settings = await store.getSettings();
    const now = nowIso();
    const session: SessionRecord = {
      id: createId("session"),
      session_key: "web:owner:main",
      title: "Store test",
      ui_locale: settings.ui_locale,
      output_locale: settings.output_locale,
      created_at: now,
      updated_at: now
    };

    await store.createSession(session);
    const sessions = await store.listSessions();
    const schemaMigrations = await store.listSchemaMigrations();
    await store.close();

    expect(settings).toMatchObject({
      memory_capture_mode: "auto",
      knowledge_wiki_capture_mode: "auto",
      skill_capture_mode: "auto",
      external_provider_role: "assistive"
    });
    expect(sessions[0]?.title).toBe("Store test");
    expect(schemaMigrations.map((entry) => entry.version)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("persists message presentations for chat cards", async () => {
    const store = await createTempStore();
    const settings = await store.getSettings();
    const now = nowIso();
    const session: SessionRecord = {
      id: createId("session"),
      session_key: "web:owner:cards",
      title: "Card test",
      ui_locale: settings.ui_locale,
      output_locale: settings.output_locale,
      created_at: now,
      updated_at: now
    };
    await store.createSession(session);
    const message = await store.saveMessage({
      id: createId("message"),
      session_id: session.id,
      role: "agent",
      content: "映画ログを作りました。",
      input_locale: settings.ui_locale,
      output_locale: settings.output_locale,
      created_at: now
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
      created_at: now,
      updated_at: now
    });
    const presentations = await store.listMessagePresentations({ sessionId: session.id, messageId: message.id });
    await store.close();

    expect(presentations).toEqual([presentation]);
  });

  it("updates message presentation view state", async () => {
    const store = await createTempStore();
    const settings = await store.getSettings();
    const now = nowIso();
    const session: SessionRecord = {
      id: createId("session"),
      session_key: "web:owner:card-state",
      title: "Card state test",
      ui_locale: settings.ui_locale,
      output_locale: settings.output_locale,
      created_at: now,
      updated_at: now
    };
    await store.createSession(session);
    const message = await store.saveMessage({
      id: createId("message"),
      session_id: session.id,
      role: "agent",
      content: "映画ログを開きました。",
      input_locale: settings.ui_locale,
      output_locale: settings.output_locale,
      created_at: now
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
      created_at: now,
      updated_at: now
    });
    const updated = await store.updateMessagePresentationViewState({
      id: presentation.id,
      viewState: { view_id: "movies_gallery", renderer: "collection_gallery", filter: { status: "観た" } },
      updatedAt: "2026-07-05T00:00:00.000Z"
    });
    const presentations = await store.listMessagePresentations({ sessionId: session.id, messageId: message.id });
    await store.close();

    expect(updated).toMatchObject({
      id: presentation.id,
      view_id: "movies_gallery",
      renderer: "collection_gallery",
      view_state: { view_id: "movies_gallery", renderer: "collection_gallery", filter: { status: "観た" } },
      updated_at: "2026-07-05T00:00:00.000Z"
    });
    expect(presentations[0]?.view_state).toEqual(updated?.view_state);
  });

  it("persists client event queue lifecycle", async () => {
    const store = await createTempStore();
    const now = "2026-07-08T00:00:00.000Z";
    const event: ClientEventRecord = {
      id: createId("client_event"),
      target_client_kind: "desktop",
      event_type: "client.notification.requested",
      status: "pending",
      payload: {
        title: "Runが完了しました",
        deep_link: "samurai://run/run_queue_test"
      },
      resource_refs: [{
        kind: "backend_run",
        id: "run_queue_test",
        uri: "backend-runs/run_queue_test"
      }],
      created_at: now,
      expires_at: "2026-07-09T00:00:00.000Z"
    };

    await store.saveClientEvent(event);
    const pending = await store.listClientEvents({ targetClientKind: "desktop", status: "pending" });
    const delivered = await store.markClientEventDelivered(event.id, "2026-07-08T00:01:00.000Z");
    const acked = await store.ackClientEvent(event.id, "2026-07-08T00:02:00.000Z");
    const expiredEvent: ClientEventRecord = {
      ...event,
      id: createId("client_event"),
      status: "pending",
      created_at: "2026-07-07T00:00:00.000Z",
      expires_at: "2026-07-07T01:00:00.000Z"
    };
    await store.saveClientEvent(expiredEvent);
    const root = store.rootDir;
    const expired = await store.expireClientEvents({ now });
    await store.close();

    const reopened = await WorkspaceStore.create({ rootDir: root });
    const persisted = await reopened.getClientEvent(event.id);
    const expiredPersisted = await reopened.getClientEvent(expiredEvent.id);
    await reopened.close();

    expect(pending.map((item) => item.id)).toEqual([event.id]);
    expect(delivered).toMatchObject({ id: event.id, status: "delivered", delivered_at: "2026-07-08T00:01:00.000Z" });
    expect(acked).toMatchObject({ id: event.id, status: "acked", acked_at: "2026-07-08T00:02:00.000Z" });
    expect(expired.map((item) => item.id)).toEqual([expiredEvent.id]);
    expect(persisted?.status).toBe("acked");
    expect(expiredPersisted?.status).toBe("expired");
  });

  it("writes artifact content to filesystem", async () => {
    const store = await createTempStore();
    const artifactId = createId("artifact");
    await store.writeArtifactContent(artifactId, "# Hello");
    await store.close();

    expect(artifactId.startsWith("artifact_")).toBe(true);
  });

  it("stores external assist diagnostics without becoming Memory", async () => {
    const store = await createTempStore();
    const settings = await store.getSettings();
    const now = nowIso();
    const session: SessionRecord = {
      id: createId("session"),
      session_key: "web:owner:main",
      title: "External assist",
      ui_locale: settings.ui_locale,
      output_locale: settings.output_locale,
      created_at: now,
      updated_at: now
    };
    const record: ExternalAssistRecord = {
      id: createId("external_assist"),
      phase: "prefetch",
      status: "completed",
      provider_id: "test-provider",
      session_id: session.id,
      query: "memory boundary",
      role: "assistive",
      hints: [{
        id: "hint_1",
        summary: "Unverified external context.",
        source_uri: "external://hint/1",
        confidence: 0.8
      }],
      isolated_from_memory: true,
      included_in_active_memory: false,
      created_at: now,
      updated_at: now
    };
    const violationRecord: ExternalAssistRecord = {
      id: createId("external_assist"),
      phase: "sync",
      status: "failed",
      provider_id: "test-provider",
      session_id: session.id,
      query: "memory boundary",
      role: "assistive",
      hints: [],
      error: "external provider failed",
      isolated_from_memory: false,
      included_in_active_memory: true,
      created_at: "2026-01-01T00:00:01.000Z",
      updated_at: "2026-01-01T00:00:01.000Z"
    };

    await store.createSession(session);
    await store.saveExternalAssistRecord(record);
    await store.saveExternalAssistRecord(violationRecord);
    const records = await store.listExternalAssistRecords({ sessionId: session.id, phase: "prefetch" });
    const diagnostics = await store.getExternalAssistDiagnostics({ sessionId: session.id });
    const memory = await store.listMemory();
    await store.close();

    expect(records).toMatchObject([{
      id: record.id,
      provider_id: "test-provider",
      hints: [{ summary: "Unverified external context." }],
      isolated_from_memory: true,
      included_in_active_memory: false
    }]);
    expect(diagnostics).toMatchObject({
      total_records: 2,
      failed_records: 1,
      hint_count: 1,
      unisolated_records: 1,
      included_in_active_memory_records: 1
    });
    expect(diagnostics.groups).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider_id: "test-provider", phase: "prefetch", status: "completed", count: 1, hint_count: 1 }),
      expect.objectContaining({ provider_id: "test-provider", phase: "sync", status: "failed", count: 1, hint_count: 0 })
    ]));
    expect(diagnostics.violations.map((violation) => violation.code)).toEqual([
      "external_assist_not_isolated",
      "external_assist_included_in_active_memory"
    ]);
    expect(diagnostics.recent_failures[0]?.id).toBe(violationRecord.id);
    expect(memory).toEqual([]);
  });

  it("returns saved policy decisions by id", async () => {
    const store = await createTempStore();
    const now = nowIso();
    const decision: PolicyDecisionRecord = {
      id: createId("policy"),
      operation_id: createId("operation"),
      capability_id: "proposal_workspace",
      operation: "external.send",
      decision: "requires_approval",
      reason: "Needs approval.",
      policy_inputs: {
        capability_id: "proposal_workspace",
        operation: "external.send",
        actor_identity: "owner",
        instruction_source: "owner_instruction",
        instruction_authority: "owner",
        channel: "web",
        target_resource_refs: [],
        proposed_effects: ["Prepare an outbound action."],
        prior_grants: [],
        recent_history: [],
        input_hash: "abc123"
      },
      matched_rules: ["manifest_default:requires_approval"],
      required_approval_level: "approval",
      created_at: now
    };

    await store.savePolicyDecision(decision);
    const saved = await store.getPolicyDecision(decision.id);
    const missing = await store.getPolicyDecision("policy_missing");
    await store.close();

    expect(saved?.id).toBe(decision.id);
    expect(missing).toBeUndefined();
  });

  it("scopes artifacts and memory to the session that created them", async () => {
    const store = await createTempStore();
    const sessionA = await createSessionRecord(store, "A");
    const sessionB = await createSessionRecord(store, "B");
    const envelopeA = await saveUserMessage(store, sessionA, "Aの文体を覚えて");
    const envelopeB = await saveUserMessage(store, sessionB, "Bの文体を覚えて");
    const operationA = await saveOperationRecord(store, sessionA, envelopeA.id, "artifact.create");
    const operationB = await saveOperationRecord(store, sessionB, envelopeB.id, "artifact.create");
    const artifactA = await saveArtifactRecord(store, operationA, "A artifact");
    await saveArtifactRecord(store, operationB, "B artifact");
    const memoryA = await saveMemoryRecord(store, envelopeA, "session", "A memory body");
    await saveMemoryRecord(store, envelopeB, "session", "B memory body");

    const artifacts = await store.listArtifactsForSession(sessionA.id);
    const memories = await store.listMemoryForSession(sessionA.id);
    await store.close();

    expect(artifacts.map((artifact) => artifact.id)).toEqual([artifactA.id]);
    expect(memories.map((memory) => memory.id)).toEqual([memoryA.id]);
  });

  it("ignores missing or broken message envelopes when scoping memory", async () => {
    const store = await createTempStore();
    const session = await createSessionRecord(store, "Broken envelope");
    const database = new Database(store.dbPath);
    try {
      database.prepare("INSERT INTO messages(id, session_id, role, content, input_locale, output_locale, envelope_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(createId("message"), session.id, "user", "broken", "ja", "ja", "{not-json", nowIso());
    } finally {
      database.close();
    }

    const memories = await store.listMemoryForSession(session.id);
    await store.close();

    expect(memories).toEqual([]);
  });

  it("reads memory content without frontmatter and archives without deleting the record", async () => {
    const store = await createTempStore();
    const session = await createSessionRecord(store, "Archive");
    const envelope = await saveUserMessage(store, session, "この文体を覚えて");
    const memory = await saveMemoryRecord(store, envelope, "topic", "本文だけ読める");

    expect(await store.readMemoryContent(memory.id)).toBe("本文だけ読める");

    const archive = await store.archiveMemory(memory.id);
    const listed = await store.listMemory();
    const direct = await store.getMemory(memory.id);
    const archivedAgain = await store.archiveMemory(memory.id);
    await store.close();

    expect(archive?.changed).toBe(true);
    expect(archive?.after.state).toBe("archived");
    expect(direct?.state).toBe("archived");
    expect(listed.some((item) => item.id === memory.id)).toBe(false);
    expect(archivedAgain?.changed).toBe(false);
    await expect(access(path.join(store.rootDir, memory.file_path))).rejects.toThrow();
  });

  it("searches sessions, messages, artifacts, and audit records with session context", async () => {
    const store = await createTempStore();
    const session = await createSessionRecord(store, "Searchable session title");
    const envelope = await saveUserMessage(store, session, "message needle body");
    const operation = await saveOperationRecord(store, session, envelope.id, "artifact.create");
    const artifact = await saveArtifactRecord(store, operation, "Artifact heading", "artifact content needle");
    const audit = await saveAuditRecord(store, operation, "audit needle input", "audit output");

    const empty = await store.search("   ");
    const sessionResults = await store.search("Searchable");
    const messageResults = await store.search("message needle");
    const artifactResults = await store.search("artifact content needle");
    const auditResults = await store.search("audit needle");
    await store.close();

    expect(empty).toEqual([]);
    expect(sessionResults.some((result) => result.kind === "session" && result.id === session.id)).toBe(true);
    expect(messageResults.some((result) => result.kind === "message" && result.session_id === session.id)).toBe(true);
    expect(artifactResults).toContainEqual(expect.objectContaining({ kind: "artifact", id: artifact.id, session_id: session.id, operation_id: operation.id }));
    expect(auditResults).toContainEqual(expect.objectContaining({ kind: "audit", id: audit.id, session_id: session.id, operation_id: operation.id }));
  });

  it("indexes Japanese session text with FTS when SQLite supports it", async () => {
    const store = await createTempStore();
    const session = await createSessionRecord(store, "設計レビュー");
    await saveUserMessage(store, session, "Workspaceの責務を整理してから実装する");

    const reindex = await store.reindexSessionSearch();
    const results = await store.search("責務を整理");
    await store.close();

    expect(["fts5_trigram", "fts5", "like"]).toContain(reindex.mode);
    expect(results).toContainEqual(expect.objectContaining({ kind: "message", session_id: session.id }));
  });

  it("does not overwrite a settled session title with later user messages", async () => {
    const store = await createTempStore();
    const session = await createSessionRecord(store, "New chat");

    await saveUserMessage(store, session, "最初の依頼です");
    const firstTitle = (await store.getSession(session.id))?.title;
    await saveUserMessage(store, session, "二回目の依頼でタイトルを変えない");
    const secondTitle = (await store.getSession(session.id))?.title;
    await store.close();

    expect(firstTitle).toBe("最初の依頼です");
    expect(secondTitle).toBe(firstTitle);
  });

  it("stores skill markdown in filesystem and SQLite index", async () => {
    const store = await createTempStore();
    const markdown = skillMarkdown({ id: "skill_store", state: "candidate", title: "Store skill" });

    const saved = await store.saveSkillMarkdown({ state: "candidate", skillId: "skill_store", markdown });
    const support = await store.writeSkillSupportFile({
      skillId: "skill_store",
      path: "references/style.md",
      content: "補助資料"
    });
    const listed = await store.listSkills();
    const supportFiles = await store.listSkillSupportFiles("skill_store");
    const raw = await store.readSkillMarkdown("skill_store");
    await expect(store.writeSkillSupportFile({ skillId: "skill_store", path: "../outside.md", content: "bad" })).rejects.toThrow("skill_support_path_invalid");
    await store.close();

    expect(saved.file_path).toBe(path.join("skills", "candidate", "skill_store.md"));
    expect(support.file_path).toBe(path.join("skills", "support", "skill_store", "references", "style.md"));
    expect(listed.map((skill) => skill.id)).toContain("skill_store");
    expect(supportFiles).toContainEqual(expect.objectContaining({ path: path.join("references", "style.md"), content: "補助資料" }));
    expect(raw).toContain("Store skill");
  });

  it("records skill usage and curator state for self-improvement loops", async () => {
    const store = await createTempStore();
    await store.saveSkillMarkdown({
      state: "project",
      skillId: "skill_usage",
      markdown: skillMarkdown({ id: "skill_usage", state: "project", title: "Usage skill" })
    });

    const first = await store.recordSkillUsage({ skillId: "skill_usage", runId: "run_1", usedAt: "2026-01-01T00:00:00.000Z" });
    const second = await store.recordSkillUsage({ skillId: "skill_usage", runId: "run_2", usedAt: "2026-01-02T00:00:00.000Z" });
    const stale = await store.updateSkillState("skill_usage", "stale");
    const staleMarkdown = await store.readSkillMarkdown("skill_usage");
    const listed = await store.listSkillUsage();
    const curatorState = await store.saveCuratorState({
      last_run_at: "2026-01-03T00:00:00.000Z",
      last_run_summary: "checked usage",
      run_count: 1,
      stale_after_days: 14
    });
    await store.close();

    expect(first.use_count).toBe(1);
    expect(second).toMatchObject({ skill_id: "skill_usage", use_count: 2, last_run_id: "run_2" });
    expect(stale).toMatchObject({ id: "skill_usage", state: "stale", file_path: path.join("skills", "stale", "skill_usage.md") });
    expect(staleMarkdown).toContain('"state": "stale"');
    expect(listed[0]?.last_used_at).toBe("2026-01-02T00:00:00.000Z");
    expect(curatorState).toMatchObject({ id: "default", run_count: 1, stale_after_days: 14 });
  });

  it("restores Skill body, support files, and lifecycle state from a learning snapshot", async () => {
    const store = await createTempStore();
    await store.saveSkillMarkdown({
      state: "project",
      skillId: "skill_snapshot",
      markdown: skillMarkdown({ id: "skill_snapshot", state: "project", title: "Snapshot skill" })
    });
    await store.writeSkillSupportFile({ skillId: "skill_snapshot", path: "references/check.md", content: "before" });
    const snapshot = await store.createLearningSnapshot("curator_run_1");
    await store.updateSkillState("skill_snapshot", "archived");
    await store.writeSkillSupportFile({ skillId: "skill_snapshot", path: "references/check.md", content: "after" });

    const restored = await store.restoreLearningSnapshot(snapshot.id);
    const [skill, support] = await Promise.all([store.getSkill("skill_snapshot"), store.readSkillSupportFile({ skillId: "skill_snapshot", path: "references/check.md" })]);
    await store.close();

    expect(restored?.restored_at).toBeDefined();
    expect(skill?.state).toBe("project");
    expect(support?.content).toBe("before");
  });

  it("builds workspace read models from indexes and history tables", async () => {
    const store = await createTempStore();
    const now = nowIso();
    const session = await createSessionRecord(store, "Read model session");
    await store.saveSkillMarkdown({
      state: "active",
      skillId: "skill_read_model",
      markdown: skillMarkdown({ id: "skill_read_model", state: "active", title: "Read model skill" })
    });
    const run: BackendRunRecord = {
      id: "run_read_model",
      session_id: session.id,
      input_message_id: "message_in",
      output_message_id: "message_out",
      backend_id: "samurai-native",
      backend_kind: "samurai_native",
      status: "completed",
      started_at: now,
      completed_at: now,
      input_summary: "build read model",
      output_summary: "done",
      metadata: {}
    };
    const event: BackendEventRecord = {
      id: "event_read_model",
      run_id: run.id,
      session_id: session.id,
      event_type: "run_completed",
      sequence: 1,
      payload: { terminal_evidence: { kind: "completed", source: "canonical_event" } },
      resource_refs: [],
      created_at: now
    };
    const artifactRef = { kind: "artifact", id: "artifact_1", uri: "artifacts/artifact_1.md", label: "Read model artifact" };
    const operation: OperationRecord = {
      id: "operation_read_model",
      session_id: session.id,
      capability_id: "proposal",
      operation: "artifact.create",
      actor_identity: "owner",
      instruction_source: "owner_instruction",
      instruction_authority: "owner",
      channel: "web",
      input_hash: "hash_read_model",
      input_ref: { kind: "message", id: "message_in", uri: "messages/message_in" },
      target_resource_refs: [artifactRef],
      proposed_effects: ["Create artifact."],
      status: "completed",
      policy_decision_id: "decision_read_model",
      result_ref: artifactRef,
      created_at: now,
      updated_at: now
    };
    const policyDecision: PolicyDecisionRecord = {
      id: "decision_read_model",
      operation_id: operation.id,
      capability_id: operation.capability_id,
      operation: operation.operation,
      decision: "allow_auto",
      reason: "test",
      policy_inputs: {
        capability_id: operation.capability_id,
        operation: operation.operation,
        actor_identity: operation.actor_identity,
        instruction_source: operation.instruction_source,
        instruction_authority: operation.instruction_authority,
        channel: operation.channel,
        target_resource_refs: operation.target_resource_refs,
        proposed_effects: operation.proposed_effects,
        prior_grants: [],
        recent_history: [],
        input_hash: operation.input_hash
      },
      matched_rules: [],
      required_approval_level: "none",
      created_at: now
    };
    const audit: AuditRecord = {
      id: "audit_read_model",
      actor_identity: "owner",
      operation_id: operation.id,
      capability_id: operation.capability_id,
      instruction_source: operation.instruction_source,
      inputs_summary: "Created artifact.",
      outputs_summary: "Created artifact.",
      policy_decision_id: policyDecision.id,
      affected_resources: [artifactRef],
      created_at: now
    };
    const artifact: ArtifactRecord = {
      id: artifactRef.id,
      title: "Read model artifact",
      kind: "markdown",
      locale: "ja",
      source_locales: ["ja"],
      file_ref: artifactRef,
      metadata: {},
      source_operation_id: operation.id,
      created_by: "test",
      created_at: now,
      updated_at: now
    };
    const change: WorkspaceChangeRecord = {
      id: "change_read_model",
      run_id: run.id,
      session_id: session.id,
      resource_ref: artifactRef,
      change_type: "artifact_created",
      summary: "Created artifact.",
      created_at: now
    };
    await store.writeArtifactContent(artifact.id, "# Read model artifact");
    await store.saveOperation(operation);
    await store.savePolicyDecision(policyDecision);
    await store.saveAuditRecord(audit);
    await store.saveArtifactMetadata(artifact);
    await store.saveBackendRun(run);
    await store.saveBackendEvent(event);
    await store.saveWorkspaceChange(change);

    const skills = await store.listSkillIndexReadModel();
    const runs = await store.listRunHistoryEntries(session.id);
    const changes = await store.listChangeHistoryEntries(session.id);
    const transcript = await store.exportSessionTranscript(session.id);
    await store.close();

    expect(skills[0]).toMatchObject({ id: "skill_read_model", file_path: path.join("skills", "active", "skill_read_model.md") });
    expect(runs[0]).toMatchObject({ id: run.id, event_count: 1, workspace_change_count: 1 });
    expect(changes[0]).toMatchObject({ id: change.id, change_type: "artifact_created" });
    expect(transcript?.session.id).toBe(session.id);
    expect(transcript?.operations[0]?.id).toBe(operation.id);
    expect(transcript?.policy_decisions[0]?.id).toBe(policyDecision.id);
    expect(transcript?.audit_records[0]?.id).toBe(audit.id);
    expect(transcript?.artifacts[0]?.id).toBe(artifact.id);
    expect(transcript?.run_history[0]?.id).toBe(run.id);
    expect(transcript?.change_history[0]?.id).toBe(change.id);
  });

  it("summarizes ignored provider tool calls for diagnostics", async () => {
    const store = await createTempStore();
    const session = await createSessionRecord(store, "Tool diagnostics");
    const now = nowIso();
    const run: BackendRunRecord = {
      id: createId("run"),
      session_id: session.id,
      input_message_id: createId("message"),
      backend_id: "samurai-native",
      backend_kind: "samurai_native",
      status: "completed",
      started_at: now,
      completed_at: now,
      input_summary: "tool diagnostics",
      output_summary: "done",
      metadata: {}
    };
    const toolRuns: ToolRunRecord[] = [
      toolRunRecord(run, "tool_1", "create_artifact", "artifact.create", "ignored", "provider_tool_requires_domain_command", now),
      toolRunRecord(run, "tool_2", "create_artifact", "artifact.create", "ignored", "provider_tool_requires_domain_command", "2026-01-01T00:00:01.000Z"),
      toolRunRecord(run, "tool_3", "unknown_tool", undefined, "failed", "runtime_tool_failed", "2026-01-01T00:00:02.000Z")
    ];

    await store.saveBackendRun(run);
    for (const toolRun of toolRuns) {
      await store.saveToolRun(toolRun);
    }
    const diagnostics = await store.getToolRunDiagnostics({ sessionId: session.id, status: "ignored" });
    await store.close();

    expect(diagnostics.total_tool_runs).toBe(2);
    expect(diagnostics.ignored_or_failed_tool_runs).toBe(2);
    expect(diagnostics.groups[0]).toMatchObject({
      provider_tool_name: "create_artifact",
      action_id: "artifact.create",
      status: "ignored",
      count: 2,
      reasons: [{ reason: "provider_tool_requires_domain_command", count: 2 }]
    });
    expect(diagnostics.repeated_ignored_provider_tools).toHaveLength(1);
    expect(diagnostics.repeated_ignored_provider_tools[0]?.provider_tool_name).toBe("create_artifact");
  });

  it("migrates legacy tool runs and preserves their typed failure code", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-store-legacy-tool-run-"));
    roots.push(root);
    const legacyDatabase = new Database(path.join(root, "workspace.sqlite"));
    legacyDatabase.exec(`
      CREATE TABLE tool_runs (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        tool_call_id TEXT,
        provider_tool_name TEXT NOT NULL,
        action_id TEXT,
        status TEXT NOT NULL,
        input_summary TEXT NOT NULL,
        output_summary TEXT NOT NULL,
        resource_refs_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `);
    legacyDatabase.exec(`
      CREATE TABLE gateway_pairing_policies (
        id TEXT PRIMARY KEY,
        channel TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        trust_mode TEXT NOT NULL,
        allowlist_json TEXT NOT NULL,
        pairing_ttl_ms INTEGER,
        duplicate_window_ms INTEGER,
        rate_limit_window_ms INTEGER,
        rate_limit_max INTEGER,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    legacyDatabase.close();

    const store = await WorkspaceStore.create({ rootDir: root });
    const session = await createSessionRecord(store, "Legacy tool run migration");
    const now = nowIso();
    const run: BackendRunRecord = {
      id: createId("run"),
      session_id: session.id,
      input_message_id: createId("message"),
      backend_id: "samurai-native",
      backend_kind: "samurai_native",
      status: "completed",
      started_at: now,
      completed_at: now,
      input_summary: "legacy migration",
      output_summary: "done",
      metadata: {}
    };
    await store.saveBackendRun(run);
    const failed = toolRunRecord(run, "tool_legacy", "samurai.artifact.create", "artifact.create", "failed", "runtime_tool_failed:validation", now);
    failed.error_code = "validation";
    await store.saveToolRun(failed);
    const persisted = await store.listToolRuns({ runId: run.id });
    const pairingPolicy: GatewayPairingPolicyRecord = {
      id: "gateway_pairing_policy_webhook",
      channel: "webhook",
      status: "enabled",
      trust_mode: "pairing_required",
      allowlist: ["*"],
      allowed_tools: ["artifact.create"],
      metadata: {},
      created_at: now,
      updated_at: now
    };
    await store.saveGatewayPairingPolicy(pairingPolicy);
    const persistedPairingPolicy = await store.getGatewayPairingPolicy("webhook");
    const migrations = await store.listSchemaMigrations();
    await store.close();

    expect(migrations).toContainEqual(expect.objectContaining({ version: 4, name: "tool_run_error_code" }));
    expect(migrations).toContainEqual(expect.objectContaining({ version: 5, name: "gateway_pairing_policy_allowed_tools" }));
    expect(persisted).toContainEqual(expect.objectContaining({ id: failed.id, status: "failed", error_code: "validation" }));
    expect(persistedPairingPolicy).toMatchObject({ id: pairingPolicy.id, allowed_tools: ["artifact.create"] });
  });

  it("stores wiki markdown and indexes only active pages for active lookups", async () => {
    const store = await createTempStore();
    const now = nowIso();
    const frontmatter: WikiFrontmatter = {
      id: "wiki_test",
      slug: "wiki-test",
      title: "Wiki Test",
      state: "proposed",
      content_locale: "ja",
      tags: ["design"],
      source_refs: [],
      provenance: {
        kind: "user_authored",
        summary: "test",
        verified: true
      },
      created_at: now,
      updated_at: now
    };

    const saved = await store.saveWikiPage(frontmatter, "# Wiki");
    expect(saved.file_path).toBe(path.join("wiki", "pages", "wiki-test.md"));
    expect(await store.readWikiContent("wiki_test")).toBe("# Wiki");
    expect(await store.listWiki({ activeOnly: true })).toEqual([]);

    const active = await store.setWikiState("wiki_test", "active");
    const activePages = await store.listWiki({ activeOnly: true });
    const reindex = await store.reindexWiki();
    await store.close();

    expect(active?.state).toBe("active");
    expect(activePages.map((page) => page.id)).toEqual(["wiki_test"]);
    expect(reindex).toMatchObject({ active: 1, total: 1, files: 1, indexed: 1, updated: 0 });
  });

  it("detects and repairs Knowledge Wiki index drift from markdown source", async () => {
    const store = await createTempStore();
    const now = nowIso();
    const frontmatter: WikiFrontmatter = {
      id: "wiki_manual",
      slug: "manual-page",
      title: "Manual Page",
      state: "active",
      content_locale: "ja",
      tags: ["manual"],
      source_refs: [],
      provenance: {
        kind: "user_authored",
        summary: "created directly as a markdown file",
        verified: true
      },
      created_at: now,
      updated_at: now
    };
    const filePath = path.join(store.rootDir, "wiki", "pages", "manual-page.md");
    await writeFile(filePath, `${renderFrontmatter(frontmatter)}\n# Manual\n`);

    const drift = await store.inspectWorkspace();
    const dryRun = await store.repairWorkspace();
    const repair = await store.repairWorkspace({ dryRun: false });
    const indexed = await store.getWiki("wiki_manual");
    const healthy = await store.inspectWorkspace();
    await rm(filePath);
    const missing = await store.inspectWorkspace();
    const repaired = await store.repairWorkspace({ dryRun: false });
    const afterRepair = await store.inspectWorkspace();
    await store.close();

    expect(drift.ok).toBe(false);
    expect(drift.resource_boundaries).toContainEqual(expect.objectContaining({
      resource: "knowledge_wiki",
      source_of_truth: "filesystem",
      sqlite_role: "index"
    }));
    expect(drift.resource_boundaries).toContainEqual(expect.objectContaining({
      resource: "session_run_history",
      source_of_truth: "sqlite",
      sqlite_role: "history"
    }));
    expect(drift.indexes.wiki.unindexed_files).toEqual([path.join("wiki", "pages", "manual-page.md")]);
    expect(drift.repair_plan).toContainEqual(expect.objectContaining({ operation: "wiki.reindex" }));
    expect(dryRun).toMatchObject({ dry_run: true, applied: [] });
    expect(repair.applied).toContain("wiki.reindex");
    expect(repair.wiki_reindex).toMatchObject({ active: 1, total: 1, files: 1, indexed: 1, created: 1, removed: 0 });
    expect(indexed).toMatchObject({ id: "wiki_manual", state: "active" });
    expect(healthy.ok).toBe(true);
    expect(missing.ok).toBe(false);
    expect(missing.indexes.wiki.missing_files).toContainEqual(expect.objectContaining({ id: "wiki_manual" }));
    expect(repaired.wiki_reindex).toMatchObject({ active: 0, total: 0, files: 0, indexed: 0, removed: 1 });
    expect(afterRepair.ok).toBe(true);
  });

  it("detects and repairs Memory and Skill index drift from filesystem source", async () => {
    const store = await createTempStore();
    const now = nowIso();
    const memory: MemoryFrontmatter = {
      id: "memory_manual",
      state: "active",
      topic: "Manual memory",
      source: "manual",
      source_locale: "ja",
      content_locale: "ja",
      source_kind: "owner_instruction",
      instruction_authority: "owner",
      confidence: 0.9,
      created_by: "test",
      created_at: now,
      updated_at: now,
      related_memories: [],
      conflicts_with: [],
      sensitive_level: "none"
    };
    const memoryPath = path.join(store.rootDir, "memory", "active", "memory_manual.md");
    const skillPath = path.join(store.rootDir, "skills", "active", "skill_manual.md");
    await writeFile(memoryPath, `${renderFrontmatter(memory)}\nRemember this.\n`);
    await writeFile(skillPath, skillMarkdown({ id: "skill_manual", state: "active", title: "Manual Skill" }));

    const drift = await store.inspectWorkspace();
    const repair = await store.repairWorkspace({ dryRun: false });
    const indexedMemory = await store.getMemory("memory_manual");
    const indexedSkill = await store.getSkill("skill_manual");
    const healthy = await store.inspectWorkspace();
    await store.close();

    expect(drift.ok).toBe(false);
    expect(drift.indexes.memory.unindexed_files).toEqual([path.join("memory", "active", "memory_manual.md")]);
    expect(drift.indexes.skills.unindexed_files).toEqual([path.join("skills", "active", "skill_manual.md")]);
    expect(drift.repair_plan).toContainEqual(expect.objectContaining({ operation: "memory.reindex" }));
    expect(drift.repair_plan).toContainEqual(expect.objectContaining({ operation: "skill.reindex" }));
    expect(repair.applied).toEqual(expect.arrayContaining(["memory.reindex", "skill.reindex"]));
    expect(repair.memory_reindex).toMatchObject({ files: 1, indexed: 1, created: 1, removed: 0 });
    expect(repair.skill_reindex).toMatchObject({ files: 1, indexed: 1, created: 1, removed: 0 });
    expect(indexedMemory).toMatchObject({ id: "memory_manual", topic: "Manual memory" });
    expect(indexedSkill).toMatchObject({ id: "skill_manual", title: "Manual Skill" });
    expect(healthy.ok).toBe(true);
  });

  it("reports Artifact inventory drift as manual repair", async () => {
    const store = await createTempStore();
    const settings = await store.getSettings();
    const session = await store.createSession({
      id: "session_artifact_drift",
      session_key: "web:owner:artifact-drift",
      title: "Artifact drift",
      ui_locale: settings.ui_locale,
      output_locale: settings.output_locale,
      created_at: nowIso(),
      updated_at: nowIso()
    });
    const operation = await saveOperationRecord(store, session, "envelope_artifact_drift", "artifact.create");
    const artifact = await saveArtifactRecord(store, operation, "Artifact Drift");
    await rm(path.join(store.rootDir, artifact.file_ref.uri));

    const drift = await store.inspectWorkspace();
    const repair = await store.repairWorkspace({ dryRun: false });
    await store.close();

    expect(drift.ok).toBe(false);
    expect(drift.indexes.artifacts.missing_files).toContainEqual(expect.objectContaining({ id: artifact.id }));
    expect(drift.repair_plan).toContainEqual(expect.objectContaining({ operation: "manual_artifact_inventory_fix" }));
    expect(repair.skipped).toContain("manual_artifact_inventory_fix");
  });

  it("backs up and restores filesystem truth with SQLite indexes", async () => {
    const store = await createTempStore();
    const now = nowIso();
    const frontmatter: WikiFrontmatter = {
      id: "wiki_backup",
      slug: "backup-page",
      title: "Backup Page",
      state: "active",
      content_locale: "ja",
      tags: ["backup"],
      source_refs: [],
      provenance: {
        kind: "user_authored",
        summary: "backup test",
        verified: true
      },
      created_at: now,
      updated_at: now
    };

    await store.saveWikiPage(frontmatter, "# Original");
    const backup = await store.createWorkspaceBackup();
    await store.updateWikiPage({ id: "wiki_backup", content: "# Changed" });
    const restore = await store.restoreWorkspaceBackup(backup.id);
    const content = await store.readWikiContent("wiki_backup");
    const integrity = await store.checkIntegrity();
    await store.close();

    expect(backup.manifest.file_roots).toContain("wiki");
    expect(backup.manifest.file_roots).toContain("profile");
    expect(backup.manifest.integrity_ok).toBe(true);
    expect(backup.manifest.resource_boundaries).toContainEqual(expect.objectContaining({
      resource: "knowledge_wiki",
      source_of_truth: "filesystem"
    }));
    expect(restore.db_restored).toBe(true);
    expect(restore.manifest.id).toBe(backup.id);
    expect(restore.pre_restore_health.ok).toBe(true);
    expect(restore.health.ok).toBe(true);
    expect(restore.integrity.ok).toBe(true);
    expect(content).toBe("# Original");
    expect(integrity.ok).toBe(true);
  });

  it("rejects skill id/file conflicts and removes invalid new files", async () => {
    const store = await createTempStore();
    await store.saveSkillMarkdown({ state: "candidate", skillId: "skill_conflict", markdown: skillMarkdown({ id: "skill_conflict", state: "candidate" }) });

    await expect(
      store.saveSkillMarkdown({ state: "candidate", skillId: "skill_conflict", markdown: skillMarkdown({ id: "skill_conflict", state: "candidate" }) })
    ).rejects.toThrow();
    await expect(store.saveSkillMarkdown({ state: "candidate", skillId: "skill_invalid", markdown: "---\n{broken\n---\nbody" })).rejects.toThrow();
    await expect(access(path.join(store.rootDir, "skills", "candidate", "skill_invalid.md"))).rejects.toThrow();
    await store.close();
  });

  it("stores collection schemas, records, notes, and automation runs", async () => {
    const store = await createTempStore();
    const schema = collectionSchema("contacts");
    const now = nowIso();

    const savedSchema = await store.saveCollectionSchema(schema);
    const savedRecord = await store.saveCollectionRecord({
      id: "record_1",
      collection_id: "contacts",
      data: { name: "Takuma" },
      resource_refs: [],
      created_at: now,
      updated_at: now
    });
    await mkdir(path.join(store.rootDir, "collections", "contacts", "notes"), { recursive: true });
    await writeFile(path.join(store.rootDir, "collections", "contacts", "notes", "README.md"), "補助メモ");
    const notes = await store.listCollectionNotes("contacts");
    const records = await store.listCollectionRecords("contacts");
    const reindex = await store.reindexCollections();
    const run = await store.createAutomationRun({
      id: "automation_run_1",
      kind: "memory_review",
      source: "cron",
      status: "started",
      started_at: now
    });
    const updatedRun = await store.updateAutomationRun({ ...run, session_id: "session_1", status: "completed", completed_at: now });
    await store.close();

    expect(savedSchema.file_path).toBe(path.join("collections", "contacts", "schema.json"));
    expect(savedRecord.file_path).toBe(path.join("collections", "contacts", "records", "record_1.json"));
    expect(records.map((record) => record.id)).toEqual(["record_1"]);
    expect(notes[0]?.content).toBe("補助メモ");
    expect(reindex).toMatchObject({
      schemas: { files: 1, indexed: 1, updated: 0, skipped: 0 },
      records: { files: 1, indexed: 1, updated: 0, skipped: 0 }
    });
    expect(run.session_id).toBeUndefined();
    expect(updatedRun.session_id).toBe("session_1");
  });

  it("rejects unsupported collection view renderers before indexing schema files", async () => {
    const store = await createTempStore();
    await expect(store.saveCollectionSchema({
      ...collectionSchema("unsupported_view"),
      views: [{ id: "unsupported_view_cards", renderer: "study_deck" }]
    })).rejects.toThrow("collection_view_renderer_unsupported:study_deck");
    await expect(access(path.join(store.rootDir, "collections", "unsupported_view", "schema.json"))).rejects.toThrow();

    const legacy = await store.saveCollectionSchema({
      ...collectionSchema("tasks"),
      fields: [{ id: "title", type: "string" }],
      views: [{ id: "task_list", renderer: "task_list" }]
    });
    await store.close();

    expect(legacy.views).toEqual([expect.objectContaining({ id: "task_list", renderer: "task_list" })]);
  });

  it("summarizes and repairs automation queue state", async () => {
    const store = await createTempStore();
    const now = "2026-01-01T00:00:00.000Z";
    const future = "2026-01-01T01:00:00.000Z";
    const dueJob = automationJobRecord({
      id: "automation_due",
      title: "Due job",
      next_run_at: now,
      retry_after_at: now,
      failure_count: 1
    });
    const lockedJob = automationJobRecord({
      id: "automation_locked",
      title: "Locked job",
      next_run_at: now,
      locked_until: future
    });
    const exhaustedJob = automationJobRecord({
      id: "automation_exhausted",
      title: "Exhausted job",
      status: "disabled",
      failure_count: 3,
      max_attempts: 3,
      last_error: "boom"
    });

    await store.saveAutomationJob(dueJob);
    await store.saveAutomationJob(lockedJob);
    await store.saveAutomationJob(exhaustedJob);
    const summary = await store.getAutomationQueueSummary(now);
    const released = await store.releaseAutomationJobLock("automation_locked", now);
    const requeued = await store.requeueAutomationJob("automation_exhausted", { now });
    await store.close();

    expect(summary).toMatchObject({
      total: 3,
      due: 1,
      locked: 1,
      retry_due: 1,
      exhausted: 1,
      by_status: { enabled: 2, disabled: 1 },
      by_kind: { custom_instruction: 3 }
    });
    expect(released?.locked_until).toBeUndefined();
    expect(requeued).toMatchObject({
      status: "enabled",
      failure_count: 0,
      last_error: undefined,
      retry_after_at: undefined,
      locked_until: undefined
    });
  });

  it("stores and resolves resource translations as derived data for a source resource", async () => {
    const store = await createTempStore();
    const now = nowIso();
    const sourceRef = { kind: "artifact" as const, id: "artifact_1", uri: "artifacts/artifact_1.md" };

    await store.saveResourceTranslation({
      id: "translation_1",
      source_ref: sourceRef,
      source_locale: "ja",
      target_locale: "en",
      status: "draft",
      original_hash: "hash_original",
      translated_text: "Translated text",
      created_at: now,
      updated_at: now
    });
    await store.saveResourceTranslation({
      id: "translation_verified",
      source_ref: sourceRef,
      source_locale: "ja",
      target_locale: "en",
      status: "verified",
      original_hash: "hash_original",
      translated_text: "Verified text",
      created_at: now,
      updated_at: now
    });
    await store.saveResourceTranslation({
      id: "translation_2",
      source_ref: { kind: "artifact", id: "artifact_2", uri: "artifacts/artifact_2.md" },
      source_locale: "ja",
      target_locale: "en",
      status: "verified",
      original_hash: "hash_other",
      translated_text: "Other text",
      created_at: now,
      updated_at: now
    });
    const translations = await store.listResourceTranslations({ sourceRef, targetLocale: "en" });
    const resolved = await store.resolveResourceTranslation({
      sourceRef,
      targetLocale: "en",
      originalHash: "hash_original",
      fallbackText: "原文"
    });
    const fallback = await store.resolveResourceTranslation({
      sourceRef,
      targetLocale: "en",
      originalHash: "hash_changed",
      fallbackText: "原文"
    });
    await store.close();

    expect(translations.map((translation) => translation.id).sort()).toEqual(["translation_1", "translation_verified"]);
    expect(resolved).toMatchObject({
      status: "verified",
      source: "translation",
      text: "Verified text",
      translation: { id: "translation_verified" }
    });
    expect(fallback).toMatchObject({
      status: "missing",
      source: "fallback",
      text: "原文",
      target_locale: "en"
    });
  });

  it("rejects collection unknown fields and record conflicts", async () => {
    const store = await createTempStore();
    const now = nowIso();
    await store.saveCollectionSchema(collectionSchema("contacts"));
    await expect(
      store.saveCollectionRecord({
        id: "record_unknown",
        collection_id: "contacts",
        data: { unknown: true },
        resource_refs: [],
        created_at: now,
        updated_at: now
      })
    ).rejects.toThrow("collection_unknown_field");
    await store.saveCollectionRecord({
      id: "record_conflict",
      collection_id: "contacts",
      data: { name: "A" },
      resource_refs: [],
      created_at: now,
      updated_at: now
    });
    await expect(
      store.saveCollectionRecord({
        id: "record_conflict",
        collection_id: "contacts",
        data: { name: "B" },
        resource_refs: [],
        created_at: now,
        updated_at: now
      })
    ).rejects.toThrow();
    await store.close();
  });

  it("rejects collection records and patches that violate schema field types", async () => {
    const store = await createTempStore();
    const now = nowIso();
    await store.saveCollectionSchema({
      ...collectionSchema("movies"),
      fields: [
        { id: "title", type: "string", required: true },
        { id: "rating", type: "number" },
        { id: "status", type: "enum", enum_values: ["観たい", "視聴中", "観た"] },
        { id: "watched_at", type: "date" },
        { id: "starts_at", type: "datetime" },
        { id: "published", type: "boolean" },
        { id: "metadata", type: "json" }
      ]
    });

    await expect(store.saveCollectionRecord({
      id: "movie_bad_number",
      collection_id: "movies",
      data: { title: "七人の侍", rating: "5" },
      resource_refs: [],
      created_at: now,
      updated_at: now
    })).rejects.toThrow("collection_field_type:rating:number");
    await expect(store.saveCollectionRecord({
      id: "movie_bad_enum",
      collection_id: "movies",
      data: { title: "七人の侍", status: "完了" },
      resource_refs: [],
      created_at: now,
      updated_at: now
    })).rejects.toThrow("collection_enum_value:status");
    await expect(store.saveCollectionRecord({
      id: "movie_bad_date",
      collection_id: "movies",
      data: { title: "七人の侍", watched_at: "2026-99-99" },
      resource_refs: [],
      created_at: now,
      updated_at: now
    })).rejects.toThrow("collection_field_type:watched_at:date");
    await store.saveCollectionRecord({
      id: "movie_ok",
      collection_id: "movies",
      data: {
        title: "七人の侍",
        rating: 5,
        status: "観た",
        watched_at: "2026-07-05",
        starts_at: "2026-07-05T20:00",
        published: false,
        metadata: { source: "manual" }
      },
      resource_refs: [],
      created_at: now,
      updated_at: now
    });
    await store.saveCollectionRecord({
      id: "movie_null_optional",
      collection_id: "movies",
      data: { title: "空欄あり", rating: null, status: null, watched_at: null, starts_at: null },
      resource_refs: [],
      created_at: now,
      updated_at: now
    });
    await expect(store.applyCollectionRecordPatch({
      collectionId: "movies",
      recordId: "movie_ok",
      patch: {
        id: "patch_bad_rating",
        record_id: "movie_ok",
        changes: { rating: "高評価" },
        source_operation_id: "operation_bad_rating",
        created_at: nowIso()
      }
    })).rejects.toThrow("collection_field_type:rating:number");
    await expect(store.applyCollectionRecordPatch({
      collectionId: "movies",
      recordId: "movie_ok",
      patch: {
        id: "patch_bad_status",
        record_id: "movie_ok",
        changes: { status: "保留" },
        source_operation_id: "operation_bad_status",
        created_at: nowIso()
      }
    })).rejects.toThrow("collection_enum_value:status");
    const records = await store.listCollectionRecords("movies");
    await store.close();

    expect(records.map((record) => record.id).sort()).toEqual(["movie_null_optional", "movie_ok"]);
  });

  it("keeps collection derived fields display-only and validates refs embeds triggers", async () => {
    const store = await createTempStore();
    const schema = {
      ...collectionSchema("contacts"),
      fields: [
        { id: "name", type: "string" },
        { id: "email", type: "string" }
      ],
      refs: [{ id: "manager_id", field: "manager_id", collection_id: "contacts" }],
      embeds: [{ id: "profile", field: "profile", required: true }],
      derived_fields: [
        { id: "display", expression: "concat:name,email", join: " <" },
        { id: "name_length", expression: "length:name" }
      ],
      triggers: [{ id: "normalize", event: "record.created", action_id: "normalize_contact", kind: "patch_record" }]
    } satisfies CollectionSchema;
    const now = nowIso();
    await store.saveCollectionSchema(schema);
    await store.saveCollectionRecord({
      id: "manager",
      collection_id: "contacts",
      data: {
        name: "Manager",
        email: "manager@example.com",
        profile: { role: "lead" }
      },
      resource_refs: [],
      created_at: now,
      updated_at: now
    });

    const saved = await store.saveCollectionRecord({
      id: "record_derived",
      collection_id: "contacts",
      data: {
        name: "Takuma",
        email: "takuma@example.com",
        manager_id: "manager",
        profile: { role: "owner" }
      },
      resource_refs: [],
      created_at: now,
      updated_at: now
    });
    const effects = await store.evaluateCollectionTriggers({
      collectionId: "contacts",
      recordId: "record_derived",
      event: "record.created"
    });
    const patched = await store.applyCollectionRecordPatch({
      collectionId: "contacts",
      recordId: "record_derived",
      patch: {
        id: "patch_derived",
        record_id: "record_derived",
        changes: { name: "Taku" },
        source_operation_id: "operation_patch_derived",
        created_at: "2026-01-02T00:00:00.000Z"
      }
    });
    const patches = await store.listCollectionPatches({
      collectionId: "contacts",
      recordId: "record_derived"
    });
    const storedPatch = await store.getCollectionPatch("contacts", "record_derived", "patch_derived");
    const resolution = await store.resolveCollectionRecordRefs("contacts", "record_derived");
    await expect(store.saveCollectionRecord({
      id: "bad_ref",
      collection_id: "contacts",
      data: {
        name: "Bad",
        email: "bad@example.com",
        manager_id: "missing",
        profile: { role: "guest" }
      },
      resource_refs: [],
      created_at: now,
      updated_at: now
    })).rejects.toThrow("collection_ref_not_found");
    await store.close();

    expect(saved.data).toMatchObject({
      name: "Takuma",
      email: "takuma@example.com",
      manager_id: "manager",
      profile: { role: "owner" }
    });
    expect(saved.data).not.toHaveProperty("display");
    expect(saved.data).not.toHaveProperty("name_length");
    expect(effects[0]).toMatchObject({
      id: "normalize",
      action_id: "normalize_contact",
      action_kind: "patch_record",
      status: "queued"
    });
    expect(patched.after.data).toMatchObject({
      name: "Taku",
      email: "takuma@example.com",
      manager_id: "manager",
      profile: { role: "owner" }
    });
    expect(patched.after.data).not.toHaveProperty("display");
    expect(patched.after.data).not.toHaveProperty("name_length");
    expect(patches).toContainEqual(expect.objectContaining({
      id: "patch_derived",
      record_id: "record_derived",
      source_operation_id: "operation_patch_derived"
    }));
    expect(storedPatch).toMatchObject({
      id: "patch_derived",
      record_id: "record_derived",
      changes: { name: "Taku" }
    });
    expect(resolution.resolved_refs).toContainEqual(expect.objectContaining({
      ref_id: "manager_id",
      field: "manager_id",
      target_collection_id: "contacts",
      target_record_id: "manager"
    }));
    expect(resolution.embed_fields).toContainEqual({
      embed_id: "profile",
      field: "profile",
      value: { role: "owner" }
    });
  });

  it("rejects missing required collection fields on create and patch", async () => {
    const store = await createTempStore();
    const now = nowIso();
    await store.saveCollectionSchema({
      ...collectionSchema("movies"),
      fields: [
        { id: "title", type: "string", required: true },
        { id: "rating", type: "number", required: true }
      ]
    });

    await expect(store.saveCollectionRecord({
      id: "movie_missing_title",
      collection_id: "movies",
      data: { title: "", rating: 5 },
      resource_refs: [],
      created_at: now,
      updated_at: now
    })).rejects.toThrow("collection_required_field:title");
    await store.saveCollectionRecord({
      id: "movie_ok",
      collection_id: "movies",
      data: { title: "七人の侍", rating: 5 },
      resource_refs: [],
      created_at: now,
      updated_at: now
    });
    await expect(store.applyCollectionRecordPatch({
      collectionId: "movies",
      recordId: "movie_ok",
      patch: {
        id: "patch_empty_title",
        record_id: "movie_ok",
        changes: { title: "" },
        source_operation_id: "operation_required_patch",
        created_at: nowIso()
      }
    })).rejects.toThrow("collection_required_field:title");
    await store.close();
  });

  it("persists gateway pairings and inbound message routing state", async () => {
    const store = await createTempStore();
    const now = nowIso();
    const pairing: GatewayPairingRecord = {
      id: createId("pairing"),
      channel: "webhook",
      source_identity: "external-source-1",
      source_label: "External Source",
      status: "pending",
      pairing_code: "ABC123",
      session_key: "webhook:external-source-1:main",
      metadata: { route: "main" },
      requested_at: now,
      expires_at: new Date(Date.parse(now) + 300_000).toISOString(),
      updated_at: now
    };
    const pairingPolicy: GatewayPairingPolicyRecord = {
      id: "gateway_pairing_policy_webhook",
      channel: "webhook",
      status: "enabled",
      trust_mode: "pairing_required",
      allowlist: ["webhook:external-source-1"],
      allowed_tools: ["artifact.create"],
      pairing_ttl_ms: 300_000,
      duplicate_window_ms: 60_000,
      rate_limit_window_ms: 60_000,
      rate_limit_max: 20,
      metadata: { owner: "gateway" },
      created_at: now,
      updated_at: now
    };
    const routingPolicy: GatewayRoutingPolicyRecord = {
      id: "gateway_routing_policy_webhook",
      channel: "webhook",
      status: "enabled",
      session_key_strategy: "account_thread",
      default_route: "main",
      metadata: { owner: "gateway" },
      created_at: now,
      updated_at: now
    };
    const inbound: GatewayInboundMessageRecord = {
      id: createId("gateway_inbound"),
      channel: "webhook",
      source_identity: pairing.source_identity,
      body: "未承認の外部入力",
      status: "blocked",
      trusted: false,
      pairing_id: pairing.id,
      metadata: { trace_id: "trace-1" },
      created_at: now,
      updated_at: now
    };
    const boundary: GatewayBoundaryPolicy = {
      id: createId("gateway_boundary"),
      source_channel: "webhook",
      source_identity: pairing.source_identity,
      session_key: pairing.session_key,
      allowed_tools: ["collection.record.create"],
      mcp_config_refs: [],
      secret_refs: [
        {
          id: createId("secret_ref"),
          source: "env",
          provider: "default",
          key: "WEBHOOK_TOKEN"
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
      allowlist: [`webhook:${pairing.source_identity}`],
      concurrency_lock: {
        scope: "session",
        key: pairing.session_key,
        ttl_ms: 60_000
      },
      metadata: {},
      created_at: now,
      updated_at: now
    };
    const mcpConfig: GatewayMcpConfigRecord = {
      id: createId("gateway_mcp"),
      server_name: "calendar",
      transport: "stdio",
      enabled: true,
      allowed_tools: ["calendar.read"],
      secret_refs: [
        {
          id: "secret_calendar",
          source: "env",
          provider: "calendar",
          key: "CALENDAR_TOKEN"
        }
      ],
      stdio: {
        command: "node",
        args: ["calendar-mcp.js"],
        env: { NODE_ENV: "production" },
        secret_env: { CALENDAR_TOKEN: "secret_calendar" },
        secret_files: [],
        framing: "json_lines",
        initialize: true,
        timeout_ms: 2000
      },
      metadata: { owner: "gateway" },
      created_at: now,
      updated_at: now
    };

    await store.saveGatewayPairingPolicy(pairingPolicy);
    await store.saveGatewayRoutingPolicy(routingPolicy);
    await store.saveGatewayPairing(pairing);
    await store.saveGatewayInboundMessage(inbound);
    await store.saveGatewayBoundaryPolicy(boundary);
    await store.saveGatewayMcpConfig(mcpConfig);
    const acquiredLock = await store.acquireGatewayConcurrencyLock({
      lockKey: pairing.session_key,
      scope: "session",
      policyId: boundary.id,
      ownerRef: { kind: "gateway_inbound", id: inbound.id, uri: `gateway-inbound/${inbound.id}` },
      ttlMs: 60_000,
      now
    });
    const blockedLock = await store.acquireGatewayConcurrencyLock({
      lockKey: pairing.session_key,
      scope: "session",
      policyId: boundary.id,
      ownerRef: { kind: "gateway_inbound", id: "another_inbound", uri: "gateway-inbound/another_inbound" },
      ttlMs: 60_000,
      now
    });
    const releasedLock = await store.releaseGatewayConcurrencyLock(pairing.session_key, now);
    const storedPairingPolicy = await store.getGatewayPairingPolicy("webhook");
    const listedPairingPolicies = await store.listGatewayPairingPolicies({ status: "enabled" });
    const storedRoutingPolicy = await store.getGatewayRoutingPolicy("webhook");
    const listedRoutingPolicies = await store.listGatewayRoutingPolicies({ status: "enabled" });
    const foundPending = await store.findGatewayPairing({
      channel: "webhook",
      sourceIdentity: pairing.source_identity,
      status: "pending"
    });
    const blockedInbound = await store.listGatewayInboundMessages({ status: "blocked" });
    const storedBoundary = await store.getGatewayBoundaryPolicy(boundary.id);
    const listedBoundaries = await store.listGatewayBoundaryPolicies({ sessionKey: pairing.session_key });
    const storedMcpConfig = await store.getGatewayMcpConfig(mcpConfig.id);
    const foundMcpConfig = await store.getGatewayMcpConfigByServerName("calendar");
    const enabledMcpConfigs = await store.listGatewayMcpConfigs({ enabled: true });
    await store.saveGatewayPairing({
      ...pairing,
      status: "approved",
      pairing_code: undefined,
      resolved_at: now,
      updated_at: now
    });
    const approvedPairings = await store.listGatewayPairings("approved");
    const filteredPairings = await store.listGatewayPairings({
      status: "approved",
      channel: "webhook",
      sourceIdentity: pairing.source_identity,
      sessionKey: pairing.session_key,
      limit: 1
    });
    await store.close();

    expect(foundPending).toMatchObject({
      id: pairing.id,
      status: "pending",
      metadata: { route: "main" }
    });
    expect(storedPairingPolicy).toMatchObject({
      id: pairingPolicy.id,
      channel: "webhook",
      trust_mode: "pairing_required",
      allowlist: ["webhook:external-source-1"]
    });
    expect(listedPairingPolicies).toContainEqual(expect.objectContaining({ id: pairingPolicy.id }));
    expect(storedRoutingPolicy).toMatchObject({
      id: routingPolicy.id,
      channel: "webhook",
      session_key_strategy: "account_thread",
      default_route: "main"
    });
    expect(listedRoutingPolicies).toContainEqual(expect.objectContaining({ id: routingPolicy.id }));
    expect(blockedInbound).toContainEqual(expect.objectContaining({
      id: inbound.id,
      status: "blocked",
      trusted: false,
      metadata: { trace_id: "trace-1" }
    }));
    expect(storedBoundary).toMatchObject({
      id: boundary.id,
      source_channel: "webhook",
      source_identity: pairing.source_identity,
      allowed_tools: ["collection.record.create"],
      secret_refs: [{ id: boundary.secret_refs[0]?.id, source: "env", provider: "default", key: "WEBHOOK_TOKEN" }],
      concurrency_lock: { scope: "session", key: pairing.session_key, ttl_ms: 60_000 }
    });
    expect(listedBoundaries).toHaveLength(1);
    expect(storedMcpConfig).toMatchObject({
      id: mcpConfig.id,
      server_name: "calendar",
      transport: "stdio",
      enabled: true,
      allowed_tools: ["calendar.read"],
      secret_refs: [{ id: "secret_calendar", source: "env", provider: "calendar", key: "CALENDAR_TOKEN" }],
      stdio: {
        command: "node",
        secret_env: { CALENDAR_TOKEN: "secret_calendar" }
      }
    });
    expect(foundMcpConfig?.id).toBe(mcpConfig.id);
    expect(enabledMcpConfigs).toContainEqual(expect.objectContaining({ id: mcpConfig.id }));
    expect(acquiredLock.acquired).toBe(true);
    expect(blockedLock).toMatchObject({ acquired: false, lock: { lock_key: pairing.session_key, status: "acquired" } });
    expect(releasedLock).toMatchObject({ lock_key: pairing.session_key, status: "released" });
    expect(approvedPairings).toContainEqual(expect.objectContaining({
      id: pairing.id,
      status: "approved",
      pairing_code: undefined
    }));
    expect(filteredPairings).toEqual([expect.objectContaining({
      id: pairing.id,
      status: "approved",
      source_identity: pairing.source_identity,
      session_key: pairing.session_key
    })]);
  });
});

async function createSessionRecord(store: WorkspaceStore, title: string): Promise<SessionRecord> {
  const settings = await store.getSettings();
  const now = nowIso();
  const session: SessionRecord = {
    id: createId("session"),
    session_key: "web:owner:main",
    title,
    ui_locale: settings.ui_locale,
    output_locale: settings.output_locale,
    created_at: now,
    updated_at: now
  };
  return store.createSession(session);
}

function toolRunRecord(
  run: BackendRunRecord,
  toolCallId: string,
  providerToolName: string,
  actionId: string | undefined,
  status: ToolRunRecord["status"],
  outputSummary: string,
  createdAt: string
): ToolRunRecord {
  return {
    id: createId("toolrun"),
    run_id: run.id,
    session_id: run.session_id,
    tool_call_id: toolCallId,
    provider_tool_name: providerToolName,
    action_id: actionId,
    status,
    input_summary: providerToolName,
    output_summary: outputSummary,
    resource_refs: [],
    created_at: createdAt
  };
}

async function saveUserMessage(store: WorkspaceStore, session: SessionRecord, content: string): Promise<MessageEnvelope> {
  const envelope: MessageEnvelope = {
    id: createId("envelope"),
    source: "web",
    actor_identity: "owner",
    session_key: session.session_key,
    user_intent: content,
    attachments: [],
    input_locale: "ja",
    output_locale: "ja",
    metadata: {},
    received_at: nowIso()
  };
  await store.saveMessage({
    id: createId("message"),
    session_id: session.id,
    role: "user",
    content,
    input_locale: "ja",
    output_locale: "ja",
    envelope,
    created_at: envelope.received_at
  });
  return envelope;
}

async function saveOperationRecord(store: WorkspaceStore, session: SessionRecord, envelopeId: string, operationName: string): Promise<OperationRecord> {
  const now = nowIso();
  const operation: OperationRecord = {
    id: createId("operation"),
    session_id: session.id,
    capability_id: "proposal_workspace",
    operation: operationName,
    actor_identity: "owner",
    instruction_source: "owner_instruction",
    instruction_authority: "owner",
    channel: "web",
    input_hash: envelopeId,
    input_ref: {
      kind: "message",
      id: envelopeId,
      uri: `messages/${envelopeId}`
    },
    target_resource_refs: [],
    proposed_effects: [],
    status: "completed",
    created_at: now,
    updated_at: now
  };
  return store.saveOperation(operation);
}

async function saveArtifactRecord(store: WorkspaceStore, operation: OperationRecord, title: string, content = `# ${title}`): Promise<ArtifactRecord> {
  const id = createId("artifact");
  const uri = await store.writeArtifactContent(id, content);
  const now = nowIso();
  return store.saveArtifactMetadata({
    id,
    title,
    kind: "markdown",
    locale: "ja",
    source_locales: ["ja"],
    file_ref: {
      kind: "artifact",
      id,
      uri,
      label: title
    },
    metadata: {},
    source_operation_id: operation.id,
    created_by: "test",
    created_at: now,
    updated_at: now
  });
}

function skillMarkdown(input: Partial<SkillFrontmatter> & { id: string; state: SkillFrontmatter["state"] }): string {
  const frontmatter: SkillFrontmatter = {
    id: input.id,
    state: input.state,
    title: input.title ?? "Skill",
    description: input.description ?? "Description",
    tags: input.tags ?? [],
    provenance: input.provenance ?? "generated_local",
    trust_level: input.trust_level ?? "generated_local",
    allowed_scopes: input.allowed_scopes ?? ["skill"],
    required_capabilities: input.required_capabilities ?? [],
    schedule_policy: input.schedule_policy ?? {},
    secret_policy: input.secret_policy ?? {},
    last_reviewed_at: input.last_reviewed_at ?? nowIso(),
    owner_pinned: input.owner_pinned ?? false
  };
  return ["---", JSON.stringify(frontmatter, null, 2), "---", "# Body", ""].join("\n");
}

function collectionSchema(id: string): CollectionSchema {
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

function automationJobRecord(patch: Partial<AutomationJobRecord> = {}): AutomationJobRecord {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    id: patch.id ?? createId("automation"),
    title: patch.title ?? "Automation job",
    kind: patch.kind ?? "custom_instruction",
    status: patch.status ?? "enabled",
    schedule: patch.schedule ?? "daily",
    target_instruction: patch.target_instruction ?? "Run automation",
    delivery_target: patch.delivery_target ?? { channel: "activity" },
    next_run_at: patch.next_run_at ?? now,
    last_run_at: patch.last_run_at,
    retry_after_at: patch.retry_after_at,
    locked_until: patch.locked_until,
    failure_count: patch.failure_count ?? 0,
    max_attempts: patch.max_attempts ?? 3,
    last_error: patch.last_error,
    created_at: patch.created_at ?? now,
    updated_at: patch.updated_at ?? now
  };
}

async function saveAuditRecord(store: WorkspaceStore, operation: OperationRecord, inputsSummary: string, outputsSummary: string): Promise<AuditRecord> {
  const audit: AuditRecord = {
    id: createId("audit"),
    actor_identity: "owner",
    operation_id: operation.id,
    capability_id: operation.capability_id,
    instruction_source: operation.instruction_source,
    inputs_summary: inputsSummary,
    outputs_summary: outputsSummary,
    policy_decision_id: createId("policy"),
    affected_resources: [],
    created_at: nowIso()
  };
  return store.saveAuditRecord(audit);
}

async function saveMemoryRecord(
  store: WorkspaceStore,
  envelope: MessageEnvelope,
  state: MemoryFrontmatter["state"],
  content: string
): Promise<MemoryFrontmatter & { file_path: string }> {
  const now = nowIso();
  const frontmatter: MemoryFrontmatter = {
    id: createId("memory"),
    state,
    topic: "preference",
    source: envelope.id,
    source_locale: "ja",
    content_locale: "ja",
    source_kind: "owner_instruction",
    instruction_authority: "owner",
    confidence: 0.7,
    created_by: "test",
    created_at: now,
    updated_at: now,
    related_memories: [],
    conflicts_with: [],
    sensitive_level: "none"
  };
  await store.saveMemory(frontmatter, content);
  const saved = await store.getMemory(frontmatter.id);
  return saved!;
}
