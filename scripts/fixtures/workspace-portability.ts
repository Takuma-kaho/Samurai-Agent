import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { nowIso, stableHash, type CollectionSchema, type MemoryFrontmatter, type SkillFrontmatter } from "../../packages/core-schemas/src/index";
import { WorkspaceStore } from "../../packages/workspace-store/src/index";

const sourceRoot = await mkdtemp(path.join(tmpdir(), "samurai-portability-source-"));
const targetRoot = await mkdtemp(path.join(tmpdir(), "samurai-portability-target-"));
const exportRoot = await mkdtemp(path.join(tmpdir(), "samurai-portability-export-"));
const source = await WorkspaceStore.create({ rootDir: sourceRoot });
const target = await WorkspaceStore.create({ rootDir: targetRoot });
try {
  const now = nowIso();
  await source.createSession({ id: "portable-session", session_key: "web:portable:main", title: "Portable session", ui_locale: "en", output_locale: "ja", created_at: now, updated_at: now });
  const artifactPath = await source.writeArtifactContent("portable-artifact", "# Portable artifact\n");
  await source.saveArtifactMetadata({
    id: "portable-artifact", title: "Portable artifact", kind: "markdown", locale: "en", source_locales: ["en"],
    file_ref: { kind: "artifact", id: "portable-artifact", uri: artifactPath, label: "Portable artifact" }, metadata: {},
    source_operation_id: "portable-operation", created_by: "fixture", created_at: now, updated_at: now
  });
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
  const skill: SkillFrontmatter = {
    id: "portable-skill", state: "project", title: "Portable skill", description: "Portable skill", tags: ["portable"],
    provenance: "user_authored", trust_level: "user_authored", allowed_scopes: ["skill"], required_capabilities: [],
    schedule_policy: {}, secret_policy: {}, last_reviewed_at: now, owner_pinned: true,
    source_refs: [{ kind: "memory", id: memory.id, uri: `memory/active/${memory.id}.md` }]
  };
  await source.saveSkillMarkdown({ state: "project", skillId: skill.id, markdown: `---\n${JSON.stringify(skill, null, 2)}\n---\n# Portable skill\n` });

  const sourceSnapshot = {
    session: await source.getSession("portable-session"),
    artifact: await source.getArtifact("portable-artifact"),
    artifactContent: await source.readArtifactContent("portable-artifact"),
    schema: await source.getCollectionSchema(schema.id),
    record: await source.getCollectionRecord(schema.id, "portable-record"),
    memory: await source.getMemory(memory.id),
    skill: await source.getSkill(skill.id)
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
    skill: await target.getSkill(skill.id)
  };
  assert.equal(stableHash(targetSnapshot), stableHash(sourceSnapshot));
  assert.deepEqual(targetSnapshot.record?.resource_refs, sourceSnapshot.record?.resource_refs);
  assert.deepEqual(targetSnapshot.memory?.source_refs, sourceSnapshot.memory?.source_refs);
  assert.deepEqual(targetSnapshot.skill?.source_refs, sourceSnapshot.skill?.source_refs);

  process.stdout.write(`${JSON.stringify({ status: "passed", source_hash: stableHash(sourceSnapshot), target_hash: stableHash(targetSnapshot), refs_preserved: true, resources: ["session", "artifact", "collection", "memory", "skill"] })}\n`);
} finally {
  await source.close();
  await target.close();
  await Promise.all([sourceRoot, targetRoot, exportRoot].map((root) => rm(root, { recursive: true, force: true })));
}
