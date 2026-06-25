import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  createId,
  nowIso,
  type ArtifactRecord,
  type AuditRecord,
  type CollectionSchema,
  type MemoryFrontmatter,
  type MessageEnvelope,
  type OperationRecord,
  type PolicyDecisionRecord,
  type SessionRecord,
  type SkillFrontmatter,
  type WikiFrontmatter
} from "@samurai-agent/core-schemas";
import { WorkspaceStore } from "./index";

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
    await store.close();

    expect(settings).toMatchObject({
      memory_capture_mode: "suggest",
      knowledge_wiki_capture_mode: "suggest",
      skill_capture_mode: "suggest",
      external_provider_role: "assistive"
    });
    expect(sessions[0]?.title).toBe("Store test");
  });

  it("writes artifact content to filesystem", async () => {
    const store = await createTempStore();
    const artifactId = createId("artifact");
    await store.writeArtifactContent(artifactId, "# Hello");
    await store.close();

    expect(artifactId.startsWith("artifact_")).toBe(true);
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
    await store.db
      .insertInto("messages")
      .values({
        id: createId("message"),
        session_id: session.id,
        role: "user",
        content: "broken",
        input_locale: "ja",
        output_locale: "ja",
        envelope_json: "{not-json",
        created_at: nowIso()
      })
      .execute();

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
    const listed = await store.listSkills();
    const raw = await store.readSkillMarkdown("skill_store");
    await store.close();

    expect(saved.file_path).toBe(path.join("skills", "candidate", "skill_store.md"));
    expect(listed.map((skill) => skill.id)).toContain("skill_store");
    expect(raw).toContain("Store skill");
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
    expect(reindex).toEqual({ active: 1, total: 1 });
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
    expect(notes[0]?.content).toBe("補助メモ");
    expect(run.session_id).toBeUndefined();
    expect(updatedRun.session_id).toBe("session_1");
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
