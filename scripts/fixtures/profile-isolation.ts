import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ProfileRegistry, WorkspaceStore } from "../../packages/workspace-store/src/index";

const root = await mkdtemp(path.join(tmpdir(), "samurai-profile-isolation-")); const now = new Date().toISOString();
try {
  const registry = new ProfileRegistry(root); const work = await registry.create({ id: "work", name: "Work", secretRefIds: ["secret-work"] }); const personal = await registry.create({ id: "personal", name: "Personal", secretRefIds: ["secret-personal"] });
  const workStore = await WorkspaceStore.create({ rootDir: work.workspace_root }); const personalStore = await WorkspaceStore.create({ rootDir: personal.workspace_root });
  await seed(workStore, "work"); await seed(personalStore, "personal");
  assert.equal((await workStore.getSession("session-work"))?.title, "work"); assert.equal(await workStore.getSession("session-personal"), undefined);
  assert.equal((await workStore.listMemory()).some((item) => item.id === "memory-personal"), false); assert.equal((await workStore.listSkills()).some((item) => item.id === "skill-personal"), false); assert.equal((await workStore.listAutomationJobs()).some((item) => item.id === "automation-personal"), false);
  await workStore.close(); await personalStore.close();
  await registry.switch("work"); assert.equal((await registry.active())?.id, "work"); await registry.switch("personal"); assert.equal((await registry.active())?.id, "personal");
  const exportDir = path.join(root, "exports"); await (await import("node:fs/promises")).mkdir(exportDir); const exported = await registry.export("work", exportDir); assert.equal(exported.manifest.secret_material_included, false); assert.deepEqual(exported.manifest.profile.secret_ref_ids, ["secret-work"]);
  const imported = await registry.import(exported.export_root, { id: "work-copy", name: "Work copy" }); const importedStore = await WorkspaceStore.create({ rootDir: imported.workspace_root });
  assert.equal((await importedStore.getSession("session-work"))?.title, "work"); assert.equal((await importedStore.listMemory())[0]?.id, "memory-work"); assert.equal((await importedStore.listSkills())[0]?.id, "skill-work"); assert.equal((await importedStore.listAutomationJobs())[0]?.id, "automation-work"); await importedStore.close();
  assert.deepEqual(imported.secret_ref_ids, ["secret-work"]); assert.notEqual(imported.workspace_root, work.workspace_root);
  process.stdout.write(`${JSON.stringify({ status: "passed", profile_count: (await registry.list()).length, cross_profile_leaks: 0, switch_isolated: true, secret_material_exported: false, secret_refs_preserved: true, imported_resources: ["session", "memory", "skill", "automation"] })}\n`);
} finally { await rm(root, { recursive: true, force: true }); }

async function seed(store: WorkspaceStore, scope: string) {
  await store.createSession({ id: `session-${scope}`, session_key: `key-${scope}`, title: scope, ui_locale: "en", output_locale: "en", created_at: now, updated_at: now });
  await store.saveMemory({ id: `memory-${scope}`, state: "active", topic: scope, source: `session-${scope}`, source_locale: "en", content_locale: "en", source_kind: "owner_instruction", instruction_authority: "user", confidence: 1, created_by: "fixture", created_at: now, updated_at: now, related_memories: [], conflicts_with: [], sensitive_level: "none", source_refs: [{ kind: "session", id: `session-${scope}`, uri: `sessions/${scope}` }] }, scope);
  const frontmatter = { id: `skill-${scope}`, state: "project", title: scope, description: scope, tags: [scope], provenance: "fixture", trust_level: "user_authored", allowed_scopes: ["workspace"], required_capabilities: [], schedule_policy: {}, secret_policy: {}, owner_pinned: false, source_refs: [{ kind: "session", id: `session-${scope}`, uri: `sessions/${scope}` }] };
  await store.saveSkillMarkdown({ state: "project", skillId: `skill-${scope}`, markdown: `---\n${JSON.stringify(frontmatter, null, 2)}\n---\n${scope}\n` });
  await store.saveAutomationJob({ id: `automation-${scope}`, title: scope, kind: "custom_instruction", status: "enabled", schedule: "once", target_instruction: scope, delivery_target: {}, failure_count: 0, max_attempts: 3, created_at: now, updated_at: now });
}
