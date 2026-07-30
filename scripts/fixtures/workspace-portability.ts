import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { nowIso, stableHash, type CollectionSchema, type MemoryFrontmatter, type SkillFrontmatter, type WikiFrontmatter } from "../../packages/core-schemas/src/index";
import { WorkspaceStore } from "../../packages/workspace-store/src/index";

const sourceRoot = await mkdtemp(path.join(tmpdir(), "samurai-portability-source-"));
const targetRoot = await mkdtemp(path.join(tmpdir(), "samurai-portability-target-"));
const exportRoot = await mkdtemp(path.join(tmpdir(), "samurai-portability-export-"));
const source = await WorkspaceStore.create({ rootDir: sourceRoot });
const target = await WorkspaceStore.create({ rootDir: targetRoot });
try {
  const now = nowIso();
  await source.createSession({ id: "portable-session", session_key: "web:portable:main", title: "Portable session", ui_locale: "en", output_locale: "ja", created_at: now, updated_at: now });
  await source.patchSettings({ output_locale: "en" });
  await source.saveMessage({ id: "portable-input", session_id: "portable-session", role: "user", content: "Portable request", input_locale: "en", output_locale: "en", created_at: now });
  await source.saveBackendRun({ id: "portable-run", session_id: "portable-session", input_message_id: "portable-input", backend_id: "fixture", backend_kind: "samurai_native", status: "completed", started_at: now, completed_at: now, input_summary: "Portable request", metadata: {} });
  await source.saveBackendEvent({ id: "portable-event", run_id: "portable-run", session_id: "portable-session", event_type: "text_delta", sequence: 1, payload: { text: "Portable event" }, resource_refs: [], created_at: now });
  const artifactPath = await source.writeArtifactContent("portable-artifact", "# Portable artifact\n");
  await source.saveArtifactMetadata({
    id: "portable-artifact", title: "Portable artifact", kind: "markdown", locale: "en", source_locales: ["en"],
    file_ref: { kind: "artifact", id: "portable-artifact", uri: artifactPath, label: "Portable artifact" }, metadata: {},
    source_operation_id: "portable-operation", created_by: "fixture", created_at: now, updated_at: now
  });
  await source.saveWorkspaceChange({ id: "portable-change", run_id: "portable-run", session_id: "portable-session", resource_ref: { kind: "artifact", id: "portable-artifact", uri: artifactPath }, change_type: "artifact_created", summary: "Portable artifact created", created_at: now });
  await source.enqueueGatewayDelivery({ id: "portable-delivery", session_key: "web:portable:main", channel: "webhook", status: "pending", idempotency_key: "portable-delivery", payload: { artifact: "portable-artifact" }, attempt: 0, max_attempts: 3, created_at: now, updated_at: now });
  const schema: CollectionSchema = {
    id: "portable-items", version: "1", labels: { en: "Portable items" }, descriptions: { en: "Portable items" },
    fields: [{ id: "name", type: "string" }, { id: "artifact_id", type: "string" }], refs: [], embeds: [], derived_fields: [], triggers: [], actions: [], views: [], permissions: {}
  };
  await source.saveCollectionSchema(schema);
  await source.saveCollectionRecord({
    id: "portable-record", collection_id: schema.id, version: 1, data: { name: "Portable", artifact_id: "portable-artifact" },
    resource_refs: [{ kind: "artifact", id: "portable-artifact", uri: artifactPath }], created_at: now, updated_at: now
  });
  const memory: MemoryFrontmatter = {
    id: "portable-memory", state: "active", topic: "Portability", source: "fixture", source_locale: "en", content_locale: "en",
    source_kind: "owner_instruction", instruction_authority: "owner", confidence: 1, created_by: "fixture", created_at: now, updated_at: now,
    related_memories: [], conflicts_with: [], sensitive_level: "none", source_refs: [{ kind: "artifact", id: "portable-artifact", uri: artifactPath }]
  };
  await source.saveMemory(memory, "Portable memory body");
  const wiki: WikiFrontmatter = {
    id: "portable-wiki", slug: "portable-wiki", title: "Portable wiki", state: "active", content_locale: "en", tags: ["portable"],
    source_refs: [{ kind: "artifact", id: "portable-artifact", uri: artifactPath }],
    provenance: { kind: "user_authored", summary: "portability fixture", verified: true }, created_at: now, updated_at: now
  };
  await source.saveWikiPage(wiki, "# Portable wiki\n");
  const skill: SkillFrontmatter = {
    id: "portable-skill", state: "project", title: "Portable skill", description: "Portable skill", tags: ["portable"],
    provenance: "user_authored", trust_level: "user_authored", allowed_scopes: ["skill"], required_capabilities: [],
    schedule_policy: {}, secret_policy: {}, last_reviewed_at: now, owner_pinned: true,
    source_refs: [{ kind: "memory", id: memory.id, uri: `memory/active/${memory.id}.md` }]
  };
  await source.saveSkillMarkdown({ state: "project", skillId: skill.id, markdown: `---\n${JSON.stringify(skill, null, 2)}\n---\n# Portable skill\n` });
  await source.saveGeneratedSurfaceRevision({
    definition: {
      id: "portable-surface", state: "ephemeral", session_id: "portable-session", title: "Portable surface", input_data_schema: {}, actions: [],
      capability_manifest: { allowed_domain_commands: [], network_access: "none", workspace_write: "domain_commands_only" }, source_refs: [],
      content_hash: "portable-surface", current_revision_id: "portable-surface-revision", current_revision: 1,
      preview_url: "samurai-surface://portable-surface/portable-surface-revision", fallback_chain: ["text"], created_at: now, updated_at: now
    },
    revision: {
      id: "portable-surface-revision", surface_id: "portable-surface", revision: 1, prompt_fingerprint: "portable-surface", knowledge_refs: [], skill_refs: [],
      html_ref: { kind: "generated_surface_html", id: "portable-surface-revision", uri: "surfaces/portable-surface/portable-surface-revision/index.html" }, asset_refs: [], bundle_hash: "portable-surface",
      validation_report: { valid: true, issues: [], html_bytes: 32, css_bytes: 0, script_bytes: 0, action_count: 0, csp: "default-src 'none'" }, created_at: now
    },
    html: "<!doctype html><p>Portable</p>"
  });

  const sourceSnapshot = {
    session: await source.getSession("portable-session"),
    artifact: await source.getArtifact("portable-artifact"),
    artifactContent: await source.readArtifactContent("portable-artifact"),
    schema: await source.getCollectionSchema(schema.id),
    record: await source.getCollectionRecord(schema.id, "portable-record"),
    memory: await source.getMemory(memory.id),
    wiki: await source.getWiki(wiki.id),
    wikiContent: await source.readWikiContent(wiki.id),
    skill: await source.getSkill(skill.id),
    settings: await source.getSettings(),
    event: await source.listBackendEvents({ runId: "portable-run" }),
    history: await source.listWorkspaceChanges("portable-session"),
    queue: await source.listGatewayDeliveries(),
    surface: await source.getGeneratedSurface("portable-surface"),
    surfaceBundle: await source.readGeneratedSurfaceBundle("portable-surface-revision")
  };
  const exported = await source.exportWorkspaceBundle(exportRoot);
  await target.importWorkspaceBundle(exported.path);
  const targetSnapshot = {
    session: await target.getSession("portable-session"),
    artifact: await target.getArtifact("portable-artifact"),
    artifactContent: await target.readArtifactContent("portable-artifact"),
    schema: await target.getCollectionSchema(schema.id),
    record: await target.getCollectionRecord(schema.id, "portable-record"),
    memory: await target.getMemory(memory.id),
    wiki: await target.getWiki(wiki.id),
    wikiContent: await target.readWikiContent(wiki.id),
    skill: await target.getSkill(skill.id),
    settings: await target.getSettings(),
    event: await target.listBackendEvents({ runId: "portable-run" }),
    history: await target.listWorkspaceChanges("portable-session"),
    queue: await target.listGatewayDeliveries(),
    surface: await target.getGeneratedSurface("portable-surface"),
    surfaceBundle: await target.readGeneratedSurfaceBundle("portable-surface-revision")
  };
  assert.equal(stableHash(targetSnapshot), stableHash(sourceSnapshot));
  assert.deepEqual(targetSnapshot.record?.resource_refs, sourceSnapshot.record?.resource_refs);
  assert.deepEqual(targetSnapshot.memory?.source_refs, sourceSnapshot.memory?.source_refs);
  assert.deepEqual(targetSnapshot.skill?.source_refs, sourceSnapshot.skill?.source_refs);

  process.stdout.write(`${JSON.stringify({ status: "passed", source_hash: stableHash(sourceSnapshot), target_hash: stableHash(targetSnapshot), refs_preserved: true, resources: ["session", "event", "artifact", "surface", "memory", "wiki", "skill", "collection", "settings", "queue", "history"] })}\n`);
} finally {
  await source.close();
  await target.close();
  await Promise.all([sourceRoot, targetRoot, exportRoot].map((root) => rm(root, { recursive: true, force: true })));
}
