import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { domainQueryEntries } from "../../packages/action-catalog/src/index";
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
      if (relative.endsWith(".sqlite-shm")) continue;
      if (entry.isDirectory()) await walk(absolute);
      else result[relative] = createHash("sha256").update(await readFile(absolute)).digest("hex");
    }
  };
  await walk(root);
  return result;
};

try {
  const session = await store.createSession({
    id: "query-purity-session",
    session_key: "query-purity-session",
    title: "Query purity",
    ui_locale: "en",
    output_locale: "en",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z"
  });
  const runId = "query-purity-run";
  await store.saveBackendRun({
    id: runId,
    session_id: session.id,
    input_message_id: "query-purity-input",
    backend_id: "query-purity-backend",
    backend_kind: "samurai_native",
    status: "completed",
    started_at: "2026-01-01T00:00:00.000Z",
    completed_at: "2026-01-01T00:00:00.000Z",
    input_summary: "query purity",
    output_summary: "query purity",
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

  const cases = [
    { queryId: "collection.view.present", payload: { collection_id: "query-purity" } },
    // BackendRun identity is Runtime-owned context, never a public Query DTO field.
    { queryId: "skill.view", payload: { skill_id: projectSkill.id }, trusted: { runId } },
    { queryId: "file.read", payload: { path: "query-purity.txt" } },
    { queryId: "file.inspect", payload: { path: "query-purity.txt" } },
    { queryId: "file.list", payload: { path: "." } },
    { queryId: "browser.extract", payload: { url: "data:text/html,%3Ctitle%3EQuery%20purity%3C%2Ftitle%3Eread%20only" } },
    { queryId: "curator.snapshot.list", payload: {} },
    { queryId: "presentation.plan", payload: { requested_kind: "built_in_surface" } },
    { queryId: "generated_surface.export", payload: { surface_id: surfaceId } },
    { queryId: "collection.schema.docs", payload: {} },
    { queryId: "collection.schema.get", payload: { collection_id: "query-purity" } },
    { queryId: "collection.records.list", payload: { collection_id: "query-purity" } },
    { queryId: "collection.search", payload: { collection_id: "query-purity", query: "", limit: 5 } },
    { queryId: "memory.search", payload: { query: "", limit: 5 } },
    { queryId: "session.search", payload: { query: "", limit: 5 } },
    { queryId: "skill.search", payload: { query: "", limit: 5 } },
    { queryId: "wiki.search", payload: { query: "", limit: 5 } }
  ] as const;
  assert.equal(cases.length, domainQueryEntries.length, "query purity must execute every active Query");
  assert.deepEqual(
    [...new Set(cases.map(({ queryId }) => queryId))].sort(),
    domainQueryEntries.map(({ id }) => id).sort(),
    "query purity fixture must cover the canonical Query ID set"
  );

  // Freeze the Workspace adapter at its read boundary. Any Query that tries
  // to call a write-capable Store method must fail, rather than being counted
  // as read-only because a later snapshot happens to hide the write.
  const storeRecord = store as unknown as Record<string, unknown>;
  const blockedWrites: string[] = [];
  for (const method of Object.getOwnPropertyNames(Object.getPrototypeOf(store))) {
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
    const result = await runtime.runRuntimeApiDomainQuery({
      query_id: queryCase.queryId,
      payload: queryCase.payload
    }, queryCase.trusted);
    assert.equal(result.ok, true, `${queryCase.queryId} did not execute successfully`);
    assert.deepEqual(await snapshot(), before, `${queryCase.queryId} changed SQLite or Workspace files`);
  }
  const parallelResults = await Promise.all(cases.map((queryCase) => runtime.runRuntimeApiDomainQuery({
    query_id: queryCase.queryId,
    payload: queryCase.payload
  }, queryCase.trusted)));
  assert.equal(parallelResults.every((result) => result.ok), true);
  assert.deepEqual(await snapshot(), before, "parallel queries changed SQLite or Workspace files");
  await assert.rejects(runtime.runDomainQuery({ query_id: "collection.schema.get", input_source: "runtime_api", payload: { collection_id: "missing" } }));
  assert.deepEqual(await snapshot(), before, "failed query changed SQLite or Workspace files");
  assert.equal(blockedWrites.length, 0, `read-only adapter observed writes: ${blockedWrites.join(",")}`);
  process.stdout.write(`${JSON.stringify({ status: "passed", gates: ["QP02", "QP03", "QP04", "QP05", "QP06", "QP07", "QP08"], queries: cases.length, canonical_query_count: domainQueryEntries.length, sqlite_write_capability_not_exposed: true, filesystem_read_only_adapter: true, sqlite_unchanged: true, workspace_files_unchanged: true, parallel_queries: parallelResults.length, failure_pure: true })}\n`);
} finally {
  await runtime.shutdownMcpProcessPool().catch(() => undefined);
  await store.close().catch(() => undefined);
  await rm(root, { recursive: true, force: true });
}
