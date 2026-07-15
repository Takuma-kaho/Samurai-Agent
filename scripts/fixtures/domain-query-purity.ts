import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { sql } from "kysely";
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
    ["collection.view.present", { collection_id: "query-purity" }],
    ["skill.view", { skill_id: projectSkill.id, run_id: runId }],
    ["file.read", { path: "query-purity.txt" }],
    ["file.inspect", { path: "query-purity.txt" }],
    ["file.list", { path: "." }],
    ["browser.extract", { url: "data:text/html,%3Ctitle%3EQuery%20purity%3C%2Ftitle%3Eread%20only" }],
    ["curator.snapshot.list", {}],
    ["presentation.plan", { requested_kind: "built_in_surface" }],
    ["generated_surface.export", { surface_id: surfaceId }],
    ["collection.schema.docs", {}],
    ["collection.schema.get", { collection_id: "query-purity" }],
    ["collection.records.list", { collection_id: "query-purity" }]
  ] as const;

  const before = await snapshot();
  await sql.raw("PRAGMA query_only=ON").execute(store.db);
  for (const [query_id, payload] of cases) {
    const result = await runtime.runDomainQuery({ query_id, input_source: "runtime_api", payload });
    assert.equal(result.ok, true, `${query_id} did not execute successfully`);
    assert.deepEqual(await snapshot(), before, `${query_id} changed SQLite or Workspace files`);
  }
  const parallelResults = await Promise.all(cases.map(([query_id, payload]) => runtime.runDomainQuery({ query_id, input_source: "runtime_api", payload })));
  assert.equal(parallelResults.every((result) => result.ok), true);
  assert.deepEqual(await snapshot(), before, "parallel queries changed SQLite or Workspace files");
  await assert.rejects(runtime.runDomainQuery({ query_id: "collection.schema.get", input_source: "runtime_api", payload: { collection_id: "missing" } }));
  assert.deepEqual(await snapshot(), before, "failed query changed SQLite or Workspace files");
  process.stdout.write(`${JSON.stringify({ status: "passed", gates: ["QP02", "QP04", "QP05", "QP06", "QP07", "QP08"], queries: cases.length, sqlite_query_only: true, sqlite_unchanged: true, workspace_files_unchanged: true, parallel_queries: parallelResults.length, failure_pure: true })}\n`);
} finally {
  await runtime.shutdownMcpProcessPool().catch(() => undefined);
  await store.close().catch(() => undefined);
  await rm(root, { recursive: true, force: true });
}
