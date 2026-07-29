import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { nowIso, type CollectionSchema, type MemoryFrontmatter, type SkillFrontmatter } from "../../packages/core-schemas/src/index";
import { WorkspaceStore } from "../../packages/workspace-store/src/index";

const root = await mkdtemp(path.join(tmpdir(), "samurai-workspace-doctor-"));
const store = await WorkspaceStore.create({ rootDir: root });
try {
  const now = nowIso();
  await store.createSession({ id: "doctor-session", session_key: "web:doctor:main", title: "Doctor search fixture", ui_locale: "en", output_locale: "en", created_at: now, updated_at: now });
  const memory: MemoryFrontmatter = {
    id: "doctor-memory", state: "active", topic: "Doctor", source: "fixture", source_locale: "en", content_locale: "en", source_kind: "owner_instruction",
    instruction_authority: "owner", confidence: 1, created_by: "fixture", created_at: now, updated_at: now,
    related_memories: [], conflicts_with: [], sensitive_level: "none"
  };
  await store.saveMemory(memory, "Doctor memory");
  const skill: SkillFrontmatter = {
    id: "doctor-skill", state: "project", title: "Doctor skill", description: "Doctor skill", tags: [], provenance: "user_authored",
    trust_level: "user_authored", allowed_scopes: ["skill"], required_capabilities: [], schedule_policy: {}, secret_policy: {}, owner_pinned: false
  };
  await store.saveSkillMarkdown({ state: "project", skillId: skill.id, markdown: `---\n${JSON.stringify(skill, null, 2)}\n---\n# Doctor skill\n` });
  const schema: CollectionSchema = {
    id: "doctor-items", version: "1", labels: { en: "Doctor items" }, descriptions: { en: "Doctor items" },
    fields: [{ id: "name", type: "string" }], refs: [], embeds: [], derived_fields: [], triggers: [], actions: [], views: [], permissions: {}
  };
  await store.saveCollectionSchema(schema);
  await store.saveCollectionRecord({
    id: "doctor-record", collection_id: schema.id, version: 1, data: { name: "Broken ref" },
    resource_refs: [{ kind: "artifact", id: "missing-artifact", uri: "artifacts/missing-artifact.md" }], created_at: now, updated_at: now
  });

  const database = new Database(store.dbPath);
  try {
    database.prepare("DELETE FROM memory_index WHERE id = ?").run(memory.id);
    database.prepare("DELETE FROM skill_index WHERE id = ?").run(skill.id);
    database.exec("DELETE FROM session_search_fts");
    if (store.getSessionSearchMode() === "fts5_trigram") database.exec("DELETE FROM session_search_trigram");
  } finally {
    database.close();
  }
  await rm(path.join(root, "skills", "archived"), { recursive: true, force: true });

  const before = await store.inspectWorkspace();
  const codes = new Set(before.issues.map((issue) => issue.code));
  for (const code of ["workspace_layout_missing", "memory_file_unindexed", "skill_file_unindexed", "collection_record_broken_ref", "session_search_index_stale"]) {
    assert.ok(codes.has(code), `doctor did not detect ${code}`);
  }
  const repaired = await store.repairWorkspace({ dryRun: false });
  assert.equal(repaired.health.ok, true);
  assert.equal(repaired.health.issues.length, 0);
  assert.deepEqual((await store.getCollectionRecord(schema.id, "doctor-record"))?.resource_refs, []);

  process.stdout.write(`${JSON.stringify({ status: "passed", detected_codes: [...codes].sort(), required_detected: 5, applied: repaired.applied, final_health_ok: repaired.health.ok, final_issue_count: repaired.health.issues.length })}\n`);
} finally {
  await store.close();
  await rm(root, { recursive: true, force: true });
}
