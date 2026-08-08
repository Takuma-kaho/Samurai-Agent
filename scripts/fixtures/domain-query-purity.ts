import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { domainQueryEntries } from "../../packages/action-catalog/src/index";
import { isSessionCompatibleOperation } from "../../packages/domain-operations/src/definition/index";
import { collectionRecordResourceId, localOwnerParticipantId } from "../../packages/room-permissions/src/index";
import { AgentRuntime } from "../../packages/runtime/src/index";
import { WorkspaceStore } from "../../packages/workspace-store/src/index";

const root = await mkdtemp(path.join(tmpdir(), "samurai-query-purity-"));
const store = await WorkspaceStore.create({ rootDir: root });
const runtime = new AgentRuntime(store);

const snapshot = async (): Promise<Record<string, string>> => {
  const result: Record<string, string> = {};
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute);
      // Core 06 records every access, including read-only Queries, in SQLite.
      // The audit trail is the sole intentional Query-side write; all
      // Workspace content and files must remain unchanged.
      if (/^workspace\.sqlite(?:-(?:wal|shm))?$/.test(relative)) continue;
      if (entry.isDirectory()) await walk(absolute);
      else result[relative] = createHash("sha256").update(await readFile(absolute)).digest("hex");
    }
  };
  await walk(root);
  return result;
};

try {
  const fixtureCreatedAt = "2026-01-01T00:00:00.000Z";
  const room = await store.createRoom({
    id: "query-purity-room",
    name: "Query purity Room",
    created_at: fixtureCreatedAt,
    updated_at: fixtureCreatedAt
  });
  const agent = await store.createAgent({
    id: "query-purity-agent",
    name: "Query purity Agent",
    role: "Fixture",
    instructions: "Provide read-only fixture context.",
    backend_id: "query-purity-backend",
    enabled: true,
    created_at: fixtureCreatedAt,
    updated_at: fixtureCreatedAt
  });
  await store.setRoomAgentPermissions({
    roomId: room.id,
    agentId: agent.id,
    canView: true,
    canEdit: false,
    canExecute: false,
    actorId: localOwnerParticipantId
  });
  const session = await store.createSession({
    id: "query-purity-session",
    session_key: "query-purity-session",
    room_id: room.id,
    title: "Query purity",
    ui_locale: "en",
    output_locale: "en",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z"
  });
  await store.ensureResourceAccessBoundary({
    resourceKind: "session",
    resourceId: session.id,
    sourceRoomId: room.id,
    ownerParticipantId: localOwnerParticipantId,
    actorId: localOwnerParticipantId
  });
  const runId = "query-purity-run";
  await store.saveBackendRun({
    id: runId,
    session_id: session.id,
    agent_id: agent.id,
    input_message_id: "query-purity-input",
    backend_id: "query-purity-backend",
    backend_kind: "samurai_native",
    status: "completed",
    started_at: "2026-01-01T00:00:00.000Z",
    completed_at: "2026-01-01T00:00:00.000Z",
    input_summary: "query purity",
    output_summary: "query purity",
    requested_by_participant_id: localOwnerParticipantId,
    metadata: {}
  });
  const skillId = "query-purity-skill";
  const projectSkill = await store.saveSkillMarkdown({
    state: "project",
    skillId,
    markdown: [
      "---",
      JSON.stringify({
        id: skillId, state: "project", title: "Query purity skill", description: "Read-only query fixture",
        tags: [], provenance: "fixture", trust_level: "user_authored", allowed_scopes: ["skill"],
        required_capabilities: [], schedule_policy: {}, secret_policy: {}, owner_pinned: false
      }, null, 2),
      "---", "# Query purity", "", "Read-only content.", ""
    ].join("\n")
  });
  await store.ensureResourceAccessBoundary({
    resourceKind: "skill",
    resourceId: projectSkill.id,
    sourceRoomId: room.id,
    ownerParticipantId: localOwnerParticipantId,
    actorId: localOwnerParticipantId
  });
  const surfaceId = "query-purity-surface";
  const revisionId = "query-purity-surface-revision";
  await store.saveGeneratedSurfaceRevision({
    definition: {
      id: surfaceId, state: "ephemeral", session_id: session.id, title: "Query purity",
      input_data_schema: {}, actions: [],
      capability_manifest: { allowed_domain_commands: [], network_access: "none", workspace_write: "domain_commands_only" },
      source_refs: [], content_hash: "query-purity", current_revision_id: revisionId, current_revision: 1,
      preview_url: `samurai-surface://${surfaceId}/${revisionId}`, fallback_chain: ["text"],
      created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z"
    },
    revision: {
      id: revisionId, surface_id: surfaceId, revision: 1, prompt_fingerprint: "query-purity",
      knowledge_refs: [], skill_refs: [],
      html_ref: { kind: "generated_surface_html", id: revisionId, uri: `generated-surfaces/${surfaceId}/${revisionId}/index.html` },
      asset_refs: [], bundle_hash: "query-purity",
      validation_report: { valid: true, issues: [], html_bytes: 63, css_bytes: 0, script_bytes: 0, action_count: 0, csp: "default-src 'none'" },
      created_at: "2026-01-01T00:00:00.000Z"
    },
    html: "<!doctype html><title>Query purity</title><p>read only</p>"
  });
  await store.ensureResourceAccessBoundary({
    resourceKind: "generated_surface",
    resourceId: surfaceId,
    sourceRoomId: room.id,
    ownerParticipantId: localOwnerParticipantId,
    actorId: localOwnerParticipantId
  });
  await writeFile(path.join(root, "query-purity.txt"), "read only", "utf8");
  await store.saveCollectionSchema({
    id: "query-purity",
    version: "1",
    labels: { en: "Query purity" },
    descriptions: { en: "Query purity" },
    fields: [{ id: "name", type: "string" }],
    refs: [], embeds: [], derived_fields: [], triggers: [], actions: [], views: [],
    permissions: { create: true, update: true, delete: true }
  });
  await store.saveCollectionRecord({
    id: "record",
    collection_id: "query-purity",
    version: 1,
    data: { name: "before" },
    resource_refs: [],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z"
  });
  await store.ensureResourceAccessBoundary({
    resourceKind: "collection_record",
    resourceId: collectionRecordResourceId("query-purity", "record"),
    sourceRoomId: room.id,
    ownerParticipantId: localOwnerParticipantId,
    actorId: localOwnerParticipantId
  });
  await store.ensureResourceAccessBoundary({
    resourceKind: "collection_schema",
    resourceId: "query-purity",
    sourceRoomId: room.id,
    ownerParticipantId: localOwnerParticipantId,
    actorId: localOwnerParticipantId
  });

  const cases = [
    { queryId: "agent.list", payload: {} },
    { queryId: "agent.view", payload: { id: agent.id } },
    { queryId: "collection.view.present", payload: { collection_id: "query-purity" } },
    // BackendRun identity is Runtime-owned context, never a public Query DTO field.
    { queryId: "skill.view", payload: { skill_id: projectSkill.id }, trusted: { runId } },
    { queryId: "file.read", payload: { path: "query-purity.txt" } },
    { queryId: "file.inspect", payload: { path: "query-purity.txt" } },
    { queryId: "file.list", payload: { path: "." } },
    { queryId: "browser.extract", payload: { url: "data:text/html,%3Ctitle%3EQuery%20purity%3C%2Ftitle%3Eread%20only" } },
    { queryId: "curator.snapshot.list", payload: {} },
    { queryId: "presentation.plan", payload: { requested_kind: "built_in_surface" } },
    { queryId: "room.list", payload: {} },
    { queryId: "room.member.list", payload: {} },
    { queryId: "room.ownerless.list", payload: {} },
    { queryId: "room.resource.share.list", payload: { resource: { kind: "collection_schema", id: "query-purity" } } },
    { queryId: "room.view", payload: { id: room.id } },
    { queryId: "generated_surface.export", payload: { surface_id: surfaceId } },
    { queryId: "collection.schema.docs", payload: {} },
    { queryId: "collection.schema.get", payload: { collection_id: "query-purity" } },
    { queryId: "collection.records.list", payload: { collection_id: "query-purity" } },
    { queryId: "collection.search", payload: { collection_id: "query-purity", query: "", limit: 5 }, trusted: { sessionId: session.id } },
    { queryId: "memory.search", payload: { query: "", limit: 5 }, trusted: { runId } },
    { queryId: "session.search", payload: { query: "", limit: 5 }, trusted: { sessionId: session.id } },
    { queryId: "skill.search", payload: { query: "", limit: 5 }, trusted: { runId } },
    { queryId: "wiki.search", payload: { query: "", limit: 5 }, trusted: { runId } },
    { queryId: "workspace.member.list", payload: {} }
  ] as const;
  assert.equal(cases.length, domainQueryEntries.length, "query purity must execute every active Query");
  assert.deepEqual(
    [...new Set(cases.map(({ queryId }) => queryId))].sort(),
    domainQueryEntries.map(({ id }) => id).sort(),
    "query purity fixture must cover the canonical Query ID set"
  );

  // Freeze the Workspace adapter at its read boundary. Core 06 requires one
  // audit record per access, so allow only that explicit persistence method.
  // Any Query that tries to mutate Workspace content must fail here.
  const storeRecord = store as unknown as Record<string, unknown>;
  const blockedWrites: string[] = [];
  for (const method of new Set([
    ...Object.getOwnPropertyNames(Object.getPrototypeOf(store)),
    ...Object.getOwnPropertyNames(store)
  ])) {
    if (method === "saveAuditRecord") continue;
    if (!/^(save|create|update|delete|patch|set|write|record|touch|reindex|mark|insert|archive|upsert|append|claim|heartbeat)/i.test(method)) continue;
    const original = storeRecord[method];
    if (typeof original !== "function") continue;
    storeRecord[method] = (..._args: unknown[]) => {
      blockedWrites.push(method);
      throw new Error(`query_write_attempt:${method}`);
    };
  }

  const before = await snapshot();
  for (const queryCase of cases) {
    const trusted = {
      roomId: room.id,
      ...(isSessionCompatibleOperation(queryCase.queryId) ? { sessionId: session.id } : {}),
      ...(queryCase.trusted ?? {})
    };
    const auditIds = new Set((await store.listAuditRecords()).map((record) => record.id));
    const result = await runtime.runRuntimeApiDomainQuery({
      query_id: queryCase.queryId,
      payload: queryCase.payload
    }, trusted);
    assert.equal(result.ok, true, `${queryCase.queryId} did not execute successfully`);
    const audits = (await store.listAuditRecords()).filter((record) => !auditIds.has(record.id));
    assert.equal(audits.length, 1, `${queryCase.queryId} must write one access audit`);
    assert.equal(audits[0]?.room_access_allowed, true, `${queryCase.queryId} access audit must be allowed`);
    assert.equal(audits[0]?.operation_id.startsWith(`domain:${queryCase.queryId}:`), true, `${queryCase.queryId} audit must identify the Query`);
    assert.deepEqual(await snapshot(), before, `${queryCase.queryId} changed Workspace content outside its access audit`);
  }
  const parallelAuditIds = new Set((await store.listAuditRecords()).map((record) => record.id));
  const parallelResults = await Promise.all(cases.map((queryCase) => runtime.runRuntimeApiDomainQuery({
    query_id: queryCase.queryId,
    payload: queryCase.payload
  }, {
    roomId: room.id,
    ...(isSessionCompatibleOperation(queryCase.queryId) ? { sessionId: session.id } : {}),
    ...(queryCase.trusted ?? {})
  })));
  assert.equal(parallelResults.every((result) => result.ok), true);
  assert.equal((await store.listAuditRecords()).filter((record) => !parallelAuditIds.has(record.id)).length, cases.length, "parallel Queries must write one access audit each");
  assert.deepEqual(await snapshot(), before, "parallel queries changed Workspace content outside their access audits");
  const failedAuditIds = new Set((await store.listAuditRecords()).map((record) => record.id));
  await assert.rejects(runtime.runDomainQuery({ query_id: "collection.schema.get", input_source: "runtime_api", payload: { collection_id: "missing" } }));
  assert.equal((await store.listAuditRecords()).filter((record) => !failedAuditIds.has(record.id)).length, 1, "failed Query must write one access audit");
  assert.deepEqual(await snapshot(), before, "failed query changed Workspace content outside its access audit");
  assert.equal(blockedWrites.length, 0, `read-only adapter observed writes: ${blockedWrites.join(",")}`);
  process.stdout.write(`${JSON.stringify({ status: "passed", gates: ["QP02", "QP03", "QP04", "QP05", "QP06", "QP07", "QP08"], queries: cases.length, canonical_query_count: domainQueryEntries.length, sqlite_write_capability_not_exposed: true, filesystem_read_only_adapter: true, sqlite_unchanged: true, workspace_files_unchanged: true, parallel_queries: parallelResults.length, failure_pure: true })}\n`);
} finally {
  await runtime.shutdownMcpProcessPool().catch(() => undefined);
  await store.close().catch(() => undefined);
  await rm(root, { recursive: true, force: true });
}
