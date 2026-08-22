import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import {
  createId,
  nowIso,
  type BackendEventRecord,
  type CollectionRecord,
  type CollectionSchema,
  type MemoryFrontmatter,
  type SessionRecord,
  type SkillFrontmatter,
  type WikiFrontmatter
} from "../../packages/core-schemas/src";
import { RunLifecycle } from "../../packages/runtime/src/execution/run-lifecycle";
import {
  WorkspaceStore,
  renderFrontmatter
} from "../../packages/workspace-store/src";
import {
  validateWorkspaceResourceOwnership,
  workspaceResourceOwners
} from "../../packages/workspace-store/src/kernel/workspace-resource-catalog";

const roots: string[] = [];
const backendKinds = ["mock", "samurai_native", "claude_code", "codex", "external"] as const;

async function createRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "samurai-workspace-persistence-"));
  roots.push(root);
  return root;
}

function memoryFrontmatter(id: string, state: MemoryFrontmatter["state"] = "active", topic = id): MemoryFrontmatter {
  const now = nowIso();
  return {
    id,
    state,
    topic,
    source: "workspace-persistence-fixture",
    source_locale: "ja",
    content_locale: "ja",
    source_kind: "owner_instruction",
    instruction_authority: "owner",
    confidence: 1,
    created_by: "fixture",
    created_at: now,
    updated_at: now,
    related_memories: [],
    conflicts_with: [],
    sensitive_level: "none"
  };
}

function wikiFrontmatter(id: string, slug: string, title = id): WikiFrontmatter {
  const now = nowIso();
  return {
    id,
    slug,
    title,
    state: "active",
    content_locale: "ja",
    tags: ["fixture"],
    source_refs: [],
    provenance: { kind: "user_authored", summary: "workspace persistence fixture", verified: true },
    created_at: now,
    updated_at: now
  };
}

function skillFrontmatter(id: string, state: SkillFrontmatter["state"] = "active", title = id): SkillFrontmatter {
  return {
    id,
    state,
    title,
    description: `${title} description`,
    tags: ["fixture"],
    provenance: "generated_local",
    trust_level: "generated_local",
    allowed_scopes: ["skill"],
    required_capabilities: [],
    schedule_policy: {},
    secret_policy: {},
    last_reviewed_at: nowIso(),
    owner_pinned: false
  };
}

function skillMarkdown(frontmatter: SkillFrontmatter, body = "# Skill body"): string {
  return ["---", JSON.stringify(frontmatter, null, 2), "---", body, ""].join("\n");
}

function collectionSchema(id: string, version = "1"): CollectionSchema {
  const localized = { ja: id, en: id, zh: id, ko: id, es: id, "pt-BR": id, fr: id, de: id };
  return {
    id,
    version,
    labels: localized,
    descriptions: localized,
    fields: [{ id: "name", type: "string", required: true }],
    refs: [],
    embeds: [],
    derived_fields: [],
    triggers: [],
    actions: [],
    permissions: {}
  };
}

function collectionRecord(id: string, collectionId: string, name: string, version = 1): CollectionRecord & { version: number } {
  const now = nowIso();
  return {
    id,
    collection_id: collectionId,
    version,
    data: { name },
    resource_refs: [],
    created_at: now,
    updated_at: now
  };
}

async function writeWorkspaceFile(root: string, relativePath: string, content: string): Promise<void> {
  const absolutePath = path.join(root, relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content);
}

function managedChangeCount(result: Awaited<ReturnType<WorkspaceStore["synchronizeManagedResources"]>>): number {
  return result.memory.created + result.memory.updated + result.memory.removed
    + result.wiki.created + result.wiki.updated + result.wiki.removed
    + result.skills.created + result.skills.updated + result.skills.removed
    + result.collections.schemas.created + result.collections.schemas.updated + result.collections.schemas.removed
    + result.collections.records.created + result.collections.records.updated + result.collections.records.removed;
}

function assertNoManagedIndexChanges(result: Awaited<ReturnType<WorkspaceStore["synchronizeManagedResources"]>>): void {
  assert.equal(managedChangeCount(result), 0, JSON.stringify(result));
}

async function listSourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const item = path.join(directory, entry.name);
    if (entry.isDirectory()) return listSourceFiles(item);
    return entry.isFile() ? [item] : [];
  }));
  return nested.flat();
}

async function verifyFacadeAndDependencyDirection(): Promise<void> {
  const repositoryRoot = process.cwd();
  const facade = await readFile(path.join(repositoryRoot, "packages/workspace-store/src/workspace-store.ts"), "utf8");
  for (const forbidden of ["node:fs", "node:path", "kysely", "Proxy(", "sql`"]) {
    assert.equal(facade.includes(forbidden), false, `WorkspaceStore facade must not contain ${forbidden}`);
  }

  for (const modulePath of [
    "packages/memory/src/index.ts",
    "packages/artifacts/src/index.ts"
  ]) {
    const source = await readFile(path.join(repositoryRoot, modulePath), "utf8");
    assert.equal(source.includes("WorkspaceStore"), false, `${modulePath} must use a narrow port`);
  }

  const runtimeRoot = path.join(repositoryRoot, "packages/runtime/src");
  const runtimeFiles = (await listSourceFiles(runtimeRoot)).filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"));
  const concreteStoreImports: string[] = [];
  for (const file of runtimeFiles) {
    const source = await readFile(file, "utf8");
    if (/from\s+["'][^"']*workspace-store[^"']*["']/.test(source)) {
      concreteStoreImports.push(path.relative(runtimeRoot, file));
    }
  }
  assert.deepEqual(
    concreteStoreImports.sort(),
    concreteStoreImports.filter((file) => file === "agent-runtime.ts" || file.startsWith(`composition${path.sep}`)).sort(),
    "Only AgentRuntime and composition may depend on the concrete WorkspaceStore."
  );
}

function verifyOwnershipCatalog(store: WorkspaceStore): void {
  const owners = workspaceResourceOwners();
  const declaredTables = owners.flatMap((owner) => owner.sqlite_tables);
  assert.equal(new Set(declaredTables).size, declaredTables.length, "A SQLite table must have one owner.");
  assert.ok(owners.every((owner) => owner.owner && Array.isArray(owner.directories) && Array.isArray(owner.backup_roots)));

  const database = new Database(store.dbPath, { readonly: true });
  try {
    const tableNames = (database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string }>)
      .map((row) => row.name)
      .filter((name) => !name.startsWith("sqlite_"))
      .filter((name) => !name.startsWith("session_search_fts_") && !name.startsWith("session_search_trigram_"));
    assert.deepEqual(validateWorkspaceResourceOwnership(tableNames), { duplicate: [], missing: [] });
  } finally {
    database.close();
  }
}

async function verifyActualWriteOwnership(): Promise<void> {
  const repositoryRoot = process.cwd();
  const workspaceSourceRoot = path.join(repositoryRoot, "packages/workspace-store/src");
  const sourceFiles = (await listSourceFiles(workspaceSourceRoot))
    .filter((file) => file.endsWith(".ts"))
    .filter((file) => !file.endsWith(".test.ts"))
    .filter((file) => !file.includes(`${path.sep}migrations${path.sep}`));
  const sources = new Map(await Promise.all(sourceFiles.map(async (file) => [
    path.relative(workspaceSourceRoot, file),
    await readFile(file, "utf8")
  ] as const)));
  const allowedWriterFiles: Record<string, readonly string[]> = {
    workspace_kernel: [
      "kernel/migration-runner.ts",
      "kernel/session-search-index.ts",
      "transactions/workspace-file-transaction-coordinator.ts"
    ],
    session_execution: [
      "repositories/session-execution-repository.ts",
      "repositories/session-execution-codecs.ts"
    ],
    client_event_queue: ["repositories/client-event-queue-repository.ts"],
    durable_work: ["repositories/durable-work-repository.ts"],
    artifact: ["repositories/artifact-repository.ts"],
    generated_surface: ["repositories/generated-surface-repository.ts"],
    memory: ["repositories/memory-repository.ts"],
    knowledge_wiki: [
      "repositories/knowledge-wiki-repository.ts",
      "transactions/wiki-recovery-handler.ts"
    ],
    skill: [
      "repositories/skill-repository.ts",
      "transactions/skill-recovery-handler.ts"
    ],
    learning: ["repositories/learning-repository.ts"],
    collection: [
      "repositories/collection-repository.ts",
      "transactions/collection-record-recovery-handler.ts",
      "transactions/collection-schema-recovery-handler.ts"
    ],
    automation: [
      "repositories/automation-repository.ts",
      "repositories/external-app-connection-repository.ts"
    ],
    external_integration: ["repositories/external-integration-repository.ts"],
    gateway: ["repositories/gateway-repository.ts"],
    workspace_metadata: ["repositories/workspace-metadata-repository.ts"],
    access_history: ["repositories/access-history-repository.ts"],
    activity_history: ["repositories/activity-history-repository.ts"],
    workspace_job: ["repositories/workspace-job-repository.ts"],
    room_permission: ["repositories/room-permission-repository.ts"],
    room_agent: [
      "repositories/room-agent-repository.ts",
      "repositories/room-permission-repository.ts"
    ]
  };
  const ownerByTable = new Map(
    workspaceResourceOwners().flatMap((owner) => owner.sqlite_tables.map((table) => [table, owner.owner] as const))
  );

  for (const [table, owner] of ownerByTable) {
    const escaped = table.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const builderWrite = new RegExp(`\\b(?:insertInto|updateTable|deleteFrom)\\(\\s*["']${escaped}["']`);
    const sqlWrite = new RegExp(`\\b(?:INSERT\\s+INTO|UPDATE|DELETE\\s+FROM)\\s+${escaped}\\b`, "i");
    const writers = [...sources]
      .filter(([, source]) => builderWrite.test(source) || sqlWrite.test(source))
      .map(([file]) => file)
      .sort();
    assert.ok(writers.length > 0, `No non-migration production writer found for ${table}`);
    assert.deepEqual(
      writers,
      writers.filter((file) => allowedWriterFiles[owner]?.includes(file)).sort(),
      `${table} must be written only by its ${owner} owner`
    );
  }

  const synchronizer = sources.get("repositories/managed-resource-synchronizer.ts") ?? "";
  for (const forbidden of ["Kysely", "WorkspaceDb", "node:fs", "node:path", "selectFrom(", "insertInto(", "updateTable(", "deleteFrom(", "parseMemory", "parseWiki", "parseSkill", "parseCollection"]) {
    assert.equal(synchronizer.includes(forbidden), false, `ManagedResourceSynchronizer must not contain ${forbidden}`);
  }
  const maintenance = sources.get("services/workspace-maintenance-service.ts") ?? "";
  for (const forbidden of ["kysely", "selectFrom(", "insertInto(", "updateTable(", "deleteFrom(", "parseMemory", "parseWiki", "parseSkill", "parseCollection", "artifactFromRow", "collectionRecordFromRow"]) {
    assert.equal(maintenance.includes(forbidden), false, `WorkspaceMaintenanceService must not contain ${forbidden}`);
  }
}

async function verifyCompatibilityApi(store: WorkspaceStore, session: SessionRecord): Promise<void> {
  const settings = await store.getSettings();
  assert.equal(settings.memory_capture_mode, "auto");

  await store.createSession(session);
  const message = await store.saveMessage({
    id: "message-api",
    session_id: session.id,
    role: "user",
    content: "before update",
    input_locale: "ja",
    output_locale: "ja",
    created_at: nowIso()
  });
  const updatedMessage = await store.updateMessageContent(message.id, "after update");
  assert.equal(updatedMessage?.content, "after update");
  assert.equal((await store.listSessions()).some((item) => item.id === session.id), true);

  const memory = memoryFrontmatter("memory-api", "active", "API memory");
  await store.saveMemory(memory, "API memory content");
  await store.replaceMemoryContent(memory.id, "API memory changed");
  assert.equal(await store.readMemoryContent(memory.id), "API memory changed");

  const wiki = wikiFrontmatter("wiki-api", "api-page", "API Wiki");
  await store.saveWikiPage(wiki, "API wiki content");
  await store.updateWikiPage({ id: wiki.id, title: "API Wiki updated", content: "API wiki changed" });
  assert.equal((await store.getWiki(wiki.id))?.title, "API Wiki updated");
  assert.equal(await store.readWikiContent(wiki.id), "API wiki changed");

  const skill = skillFrontmatter("skill-api", "project", "API Skill");
  await store.saveSkillMarkdown({ state: "project", skillId: skill.id, markdown: skillMarkdown(skill, "API skill content") });
  await store.replaceSkillContent(skill.id, "API skill changed");
  assert.match(await store.readSkillMarkdown(skill.id) ?? "", /API skill changed/);

  const schema = collectionSchema("collection-api");
  await store.saveCollectionSchema(schema);
  await store.saveCollectionRecord(collectionRecord("record-api", schema.id, "API record"));
  const storedRecord = await store.getCollectionRecord(schema.id, "record-api");
  assert.equal(storedRecord?.data.name, "API record");

  // Re-reading through the filesystem parser proves that the public writers
  // and the new automatic synchronizer share one file contract.
  assertNoManagedIndexChanges(await store.synchronizeManagedResources());
}

async function verifyManualResourceLifecycle(store: WorkspaceStore): Promise<void> {
  const root = store.rootDir;
  const memory = memoryFrontmatter("memory-managed", "active", "Managed memory");
  const wiki = wikiFrontmatter("wiki-managed", "managed-page", "Managed Wiki");
  const skill = skillFrontmatter("skill-managed", "active", "Managed Skill");
  const schema = collectionSchema("collection-managed");
  const record = collectionRecord("record-managed", schema.id, "Managed record");
  const paths = {
    memory: path.join("memory", "active", `${memory.id}.md`),
    wiki: path.join("wiki", "pages", `${wiki.slug}.md`),
    skill: path.join("skills", "active", `${skill.id}.md`),
    schema: path.join("collections", schema.id, "schema.json"),
    record: path.join("collections", schema.id, "records", `${record.id}.json`)
  };

  await Promise.all([
    writeWorkspaceFile(root, paths.memory, `${renderFrontmatter(memory)}\nManaged memory body\n`),
    writeWorkspaceFile(root, paths.wiki, `${renderFrontmatter(wiki)}\nManaged wiki body\n`),
    writeWorkspaceFile(root, paths.skill, skillMarkdown(skill, "Managed skill body")),
    writeWorkspaceFile(root, paths.schema, `${JSON.stringify(schema, null, 2)}\n`),
    writeWorkspaceFile(root, paths.record, `${JSON.stringify(record, null, 2)}\n`)
  ]);

  const created = await store.synchronizeManagedResources();
  assert.equal(created.memory.created, 1);
  assert.equal(created.wiki.created, 1);
  assert.equal(created.skills.created, 1);
  assert.equal(created.collections.schemas.created, 1);
  assert.equal(created.collections.records.created, 1);
  assertNoManagedIndexChanges(await store.synchronizeManagedResources());

  const nextMemory = { ...memory, topic: "Managed memory updated", updated_at: nowIso() };
  const nextWiki = { ...wiki, title: "Managed Wiki updated", updated_at: nowIso() };
  const nextSkill = { ...skill, title: "Managed Skill updated", last_reviewed_at: nowIso() };
  const nextSchema = collectionSchema(schema.id, "2");
  const nextRecord = { ...record, version: 2, data: { name: "Managed record updated" }, updated_at: nowIso() };
  await Promise.all([
    writeWorkspaceFile(root, paths.memory, `${renderFrontmatter(nextMemory)}\nManaged memory updated body\n`),
    writeWorkspaceFile(root, paths.wiki, `${renderFrontmatter(nextWiki)}\nManaged wiki updated body\n`),
    writeWorkspaceFile(root, paths.skill, skillMarkdown(nextSkill, "Managed skill updated body")),
    writeWorkspaceFile(root, paths.schema, `${JSON.stringify(nextSchema, null, 2)}\n`),
    writeWorkspaceFile(root, paths.record, `${JSON.stringify(nextRecord, null, 2)}\n`)
  ]);
  const updated = await store.synchronizeManagedResources();
  assert.equal(updated.memory.updated, 1);
  assert.equal(updated.wiki.updated, 1);
  assert.equal(updated.skills.updated, 1);
  assert.equal(updated.collections.schemas.updated, 1);
  assert.equal(updated.collections.records.updated, 1);
  assert.equal((await store.getMemory(memory.id))?.topic, nextMemory.topic);
  assert.equal((await store.getWiki(wiki.id))?.title, nextWiki.title);
  assert.equal((await store.getSkill(skill.id))?.title, nextSkill.title);
  assert.equal((await store.getCollectionRecord(schema.id, record.id))?.data.name, "Managed record updated");

  await Promise.all(Object.values(paths).map((relativePath) => rm(path.join(root, relativePath), { force: true })));
  const removed = await store.synchronizeManagedResources();
  assert.equal(removed.memory.removed, 1);
  assert.equal(removed.wiki.removed, 1);
  assert.equal(removed.skills.removed, 1);
  assert.equal(removed.collections.schemas.removed, 1);
  assert.equal(removed.collections.records.removed, 1);
}

async function verifyScanFailureKeepsIndex(store: WorkspaceStore): Promise<void> {
  const current = await store.getMemory("memory-api");
  assert.ok(current);
  const root = store.rootDir;
  const memoryDirectory = path.join(root, "memory");
  const heldDirectory = path.join(root, "memory-fixture-held");
  await rename(memoryDirectory, heldDirectory);
  await writeFile(memoryDirectory, "not a directory");
  try {
    const result = await store.reindexMemory();
    assert.equal(result.created + result.updated + result.removed, 0);
    assert.ok(result.errors.some((issue) => issue.file_path === "memory"));
    assert.equal((await store.getMemory("memory-api"))?.id, current.id);
  } finally {
    await rm(memoryDirectory, { force: true });
    await rename(heldDirectory, memoryDirectory);
  }
}

async function verifyStartupSynchronization(store: WorkspaceStore): Promise<WorkspaceStore> {
  const startupMemory = memoryFrontmatter("memory-startup", "active", "Startup synchronization");
  await writeWorkspaceFile(
    store.rootDir,
    path.join("memory", "active", `${startupMemory.id}.md`),
    `${renderFrontmatter(startupMemory)}\nStartup synchronization body\n`
  );
  const root = store.rootDir;
  await store.close();
  const reopened = await WorkspaceStore.create({ rootDir: root });
  assert.equal((await reopened.getMemory(startupMemory.id))?.topic, startupMemory.topic);
  return reopened;
}

async function settleTurnAndVerifySynchronization(store: WorkspaceStore, session: SessionRecord, kind: typeof backendKinds[number]): Promise<string> {
  const now = nowIso();
  const runId = createId("run");
  const memory = memoryFrontmatter(`memory-after-${kind}`, "active", `After ${kind}`);
  await writeWorkspaceFile(
    store.rootDir,
    path.join("memory", "active", `${memory.id}.md`),
    `${renderFrontmatter(memory)}\nMemory discovered after ${kind} settlement\n`
  );
  const envelope = {
    id: createId("envelope"),
    source: "web" as const,
    actor_identity: "owner",
    session_key: session.session_key,
    user_intent: "chat" as const,
    attachments: [],
    input_locale: "ja",
    output_locale: "ja",
    metadata: {},
    received_at: now
  };
  const admitted = await store.admitTurn({
    session,
    binding: { id: `fixture-${kind}`, kind },
    request: {
      sessionId: session.id,
      content: `Complete ${kind}`,
      envelope,
      idempotencyKey: `fixture-${kind}-${runId}`,
      metadata: {}
    },
    requestHash: `hash-${kind}-${runId}`,
    runId,
    now
  });
  const running = { ...admitted.run, status: "running" as const, phase: "external_running" as const };
  await store.commitCore02RunTransition({ expectedRun: admitted.run, nextRun: running });
  const reservation = await store.getSessionRunReservation({ runId });
  assert.ok(reservation);
  const decision = new RunLifecycle(() => now).decide(running, {
    type: "completed",
    evidence: { kind: "completed", source: "canonical_event" }
  });
  const terminalEvent: BackendEventRecord = {
    id: `terminal-event-${runId}`,
    run_id: runId,
    session_id: session.id,
    event_type: "run_completed",
    sequence: 1,
    attempt_no: 1,
    source_event_id: `terminal-source-${runId}`,
    payload: { terminal_evidence: { kind: "completed", source: "canonical_event" } },
    resource_refs: [],
    created_at: now
  };
  const settled = await store.commitTurnSettlement({
    expectedRun: running,
    nextRun: { ...running, status: "completed", phase: "settled", completed_at: now },
    terminalEvent,
    outputSourceId: `message:${runId}:output`,
    decision,
    attemptNo: 1,
    sourceIdentity: { sourceEventId: terminalEvent.source_event_id },
    terminalEvidence: { kind: "completed", source: "canonical_event" },
    diagnostic: { code: "completed_without_output", message: "Fixture terminal settlement." },
    reservation
  });
  assert.equal(settled.status, "completed");
  assert.equal((await store.getSessionRunReservation({ runId }))?.status, "released");
  assert.equal((await store.getMemory(memory.id))?.topic, memory.topic);
  return runId;
}

async function verifyBackendAgnosticPostTurnSynchronization(store: WorkspaceStore, session: SessionRecord): Promise<void> {
  for (const kind of backendKinds) {
    await settleTurnAndVerifySynchronization(store, session, kind);
  }
  assert.equal((await store.listWorkspaceChanges(session.id)).length, 0, "Index synchronization must not manufacture Workspace changes.");
}

async function verifyDuplicatesAndInvalidFiles(store: WorkspaceStore, session: SessionRecord): Promise<void> {
  const root = store.rootDir;
  const duplicateMemoryId = "memory-duplicate";
  const duplicateWikiId = "wiki-duplicate";
  const duplicateSkillId = "skill-duplicate";
  const duplicateCollectionId = "collection-duplicate";
  const duplicateRecordId = "record-duplicate";
  const collection = collectionSchema(duplicateCollectionId);
  const record = collectionRecord(duplicateRecordId, duplicateCollectionId, "A record");
  const preservedFiles = {
    invalidMemory: path.join("memory", "active", "invalid-memory.md"),
    invalidWiki: path.join("wiki", "pages", "invalid-wiki.md"),
    invalidSkill: path.join("skills", "active", "invalid-skill.md"),
    invalidCollection: path.join("collections", "invalid", "schema.json")
  };
  await Promise.all([
    writeWorkspaceFile(root, path.join("memory", "active", `${duplicateMemoryId}.md`), `${renderFrontmatter(memoryFrontmatter(duplicateMemoryId, "active", "A memory"))}\nA\n`),
    writeWorkspaceFile(root, path.join("memory", "archived", `${duplicateMemoryId}.md`), `${renderFrontmatter(memoryFrontmatter(duplicateMemoryId, "archived", "Z memory"))}\nZ\n`),
    writeWorkspaceFile(root, path.join("wiki", "pages", "a.md"), `${renderFrontmatter(wikiFrontmatter(duplicateWikiId, "a", "A wiki"))}\nA\n`),
    writeWorkspaceFile(root, path.join("wiki", "pages", "z.md"), `${renderFrontmatter(wikiFrontmatter(duplicateWikiId, "z", "Z wiki"))}\nZ\n`),
    writeWorkspaceFile(root, path.join("skills", "active", `${duplicateSkillId}.md`), skillMarkdown(skillFrontmatter(duplicateSkillId, "active", "A skill"), "A")),
    writeWorkspaceFile(root, path.join("skills", "project", `${duplicateSkillId}.md`), skillMarkdown(skillFrontmatter(duplicateSkillId, "project", "Z skill"), "Z")),
    writeWorkspaceFile(root, path.join("collections", "a", "schema.json"), `${JSON.stringify(collection, null, 2)}\n`),
    writeWorkspaceFile(root, path.join("collections", "z", "schema.json"), `${JSON.stringify(collection, null, 2)}\n`),
    writeWorkspaceFile(root, path.join("collections", "a", "records", `${duplicateRecordId}.json`), `${JSON.stringify(record, null, 2)}\n`),
    writeWorkspaceFile(root, path.join("collections", "z", "records", `${duplicateRecordId}.json`), `${JSON.stringify({ ...record, data: { name: "Z record" } }, null, 2)}\n`),
    writeWorkspaceFile(root, preservedFiles.invalidMemory, "not valid memory\n"),
    writeWorkspaceFile(root, preservedFiles.invalidWiki, "not valid wiki\n"),
    writeWorkspaceFile(root, preservedFiles.invalidSkill, "not valid skill\n"),
    writeWorkspaceFile(root, preservedFiles.invalidCollection, "{not valid json\n")
  ]);
  const before = await Promise.all(Object.values(preservedFiles).map((file) => readFile(path.join(root, file), "utf8")));

  const first = await store.synchronizeManagedResources();
  assert.ok(first.memory.errors.length >= 2);
  assert.ok(first.wiki.errors.length >= 2);
  assert.ok(first.skills.errors.length >= 2);
  assert.ok(first.collections.schemas.errors.length >= 2);
  assert.ok(first.collections.records.errors.length >= 1);
  assert.equal((await store.getMemory(duplicateMemoryId))?.topic, "A memory");
  assert.equal((await store.getWiki(duplicateWikiId))?.title, "A wiki");
  assert.equal((await store.getSkill(duplicateSkillId))?.title, "A skill");
  assert.equal((await store.getCollectionSchema(duplicateCollectionId))?.file_path, path.join("collections", "a", "schema.json"));
  assert.equal((await store.getCollectionRecord(duplicateCollectionId, duplicateRecordId))?.data.name, "A record");
  const after = await Promise.all(Object.values(preservedFiles).map((file) => readFile(path.join(root, file), "utf8")));
  assert.deepEqual(after, before, "Synchronization must not rewrite or remove source files.");
  assertNoManagedIndexChanges(await store.synchronizeManagedResources());

  const runId = await settleTurnAndVerifySynchronization(store, session, "mock");
  assert.equal((await store.getBackendRun(runId))?.status, "completed");
  assert.ok((await store.listBackendEvents({ runId })).some((event) => event.event_type === "host_post_turn_failed"));
}

async function main(): Promise<void> {
  await verifyFacadeAndDependencyDirection();
  await verifyActualWriteOwnership();
  const root = await createRoot();
  let store = await WorkspaceStore.create({ rootDir: root });
  try {
    verifyOwnershipCatalog(store);
    const session: SessionRecord = {
      id: "session-workspace-persistence",
      session_key: "web:owner:workspace-persistence",
      title: "Workspace persistence",
      ui_locale: "ja",
      output_locale: "ja",
      created_at: nowIso(),
      updated_at: nowIso()
    };
    await verifyCompatibilityApi(store, session);
    await verifyManualResourceLifecycle(store);
    await verifyScanFailureKeepsIndex(store);
    store = await verifyStartupSynchronization(store);
    await verifyBackendAgnosticPostTurnSynchronization(store, session);
    await verifyDuplicatesAndInvalidFiles(store, session);
    process.stdout.write(`${JSON.stringify({
      status: "passed",
      ownership_catalog: true,
      actual_write_ownership: true,
      facade_and_dependency_direction: true,
      compatibility_api: true,
      managed_resource_add_update_delete: true,
      managed_resource_duplicates_invalid_and_idempotent: true,
      post_turn_sync_failure_keeps_settlement: true,
      scan_failure_keeps_index: true,
      startup_synchronization: true,
      backend_kinds: backendKinds,
      terminal_settlement_synchronization: true
    })}\n`);
  } finally {
    await store.close().catch(() => undefined);
  }
}

try {
  await main();
} finally {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
}
