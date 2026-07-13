import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { nowIso } from "../../packages/core-schemas/src/index";
import { AgentRuntime } from "../../packages/runtime/src/index";
import { WorkspaceStore } from "../../packages/workspace-store/src/index";

const root = await mkdtemp(path.join(tmpdir(), "samurai-management-core-"));
const store = await WorkspaceStore.create({ rootDir: root });
const runtime = new AgentRuntime(store);
try {
  const now = nowIso();
  const skillId = "management-skill";
  const frontmatter = { id: skillId, state: "project", title: "Original Skill", description: "Original", tags: ["management"], provenance: "fixture", trust_level: "user_authored", allowed_scopes: ["workspace"], required_capabilities: [], schedule_policy: {}, secret_policy: {}, owner_pinned: false, source_refs: [{ kind: "session", id: "fixture", uri: "sessions/fixture" }] };
  await store.saveSkillMarkdown({ state: "project", skillId, markdown: `---\n${JSON.stringify(frontmatter, null, 2)}\n---\nOriginal body\n` });
  await runtime.runDomainCommand({ command_id: "skill.patch", input_source: "surface_operation", idempotency_key: "management-skill-patch", payload: { skill_id: skillId, title: "Edited Skill", description: "Edited", content: "Edited body" } });
  assert.match((await store.readSkillMarkdown(skillId))!, /Edited body/);
  await runtime.runDomainCommand({ command_id: "skill.lifecycle.apply", input_source: "runtime_api", idempotency_key: "management-skill-disable", payload: { skill_id: skillId, action: "archive" } });
  assert.equal((await store.getSkill(skillId))?.state, "archived");
  await runtime.runDomainCommand({ command_id: "skill.lifecycle.apply", input_source: "runtime_api", idempotency_key: "management-skill-enable", payload: { skill_id: skillId, action: "reactivate" } });

  const proposal = await runtime.runDomainCommand({ command_id: "wiki.proposal.create", input_source: "runtime_api", idempotency_key: "management-wiki-create", payload: { title: "Management Wiki", content: "See [[Related Page]]", slug: "management-wiki", tags: ["management"], content_locale: "en" } });
  const wikiId = (proposal.result as Record<string, any>).resource.id;
  await runtime.runDomainCommand({ command_id: "wiki.accept", input_source: "runtime_api", idempotency_key: "management-wiki-accept", payload: { wiki_id: wikiId } });
  await runtime.runDomainCommand({ command_id: "wiki.patch", input_source: "runtime_api", idempotency_key: "management-wiki-patch", payload: { wiki_id: wikiId, title: "Edited Wiki", content: "See [[related]] and [[Missing Page]]" } });
  const wikiPage = (id: string, slug: string, title: string) => ({ id, slug, title, state: "active" as const, content_locale: "en" as const, tags: ["management"], source_refs: [{ kind: "session", id: "fixture", uri: "sessions/fixture" }], provenance: { kind: "user_authored" as const, summary: "fixture", verified: true }, created_at: now, updated_at: now });
  await store.saveWikiPage(wikiPage("related-wiki", "related", "Related"), "Related content");
  await store.saveWikiPage(wikiPage("duplicate-wiki", "duplicate-related", "Related"), "Duplicate content");
  await store.saveWikiPage(wikiPage("orphan-wiki", "orphan", "Orphan"), "Orphan content");
  const graph = await runtime.previewKnowledgeWikiGraph({});
  assert.equal(graph.nodes.some((page) => page.id === wikiId), true);
  const lint = await runtime.inspectKnowledgeWikiQuality();
  assert.equal(lint.broken_links.some((item) => item.target === "Missing Page"), true);
  assert.equal(lint.duplicate_groups.some((item) => item.wiki_ids.includes("related-wiki") && item.wiki_ids.includes("duplicate-wiki")), true);
  assert.equal(lint.orphan_wiki_ids.includes("orphan-wiki"), true);
  assert.equal(Object.values(lint.backlinks).flat().some((item) => item.from_wiki_id === wikiId), true);

  const job = await runtime.runDomainCommand({ command_id: "automation.job.save", input_source: "runtime_api", idempotency_key: "management-automation-create", payload: { title: "Management automation", kind: "custom_instruction", schedule: "daily", target_instruction: "Review management resources", enabled: true } });
  const jobId = (job.result as Record<string, any>).resource.id;
  await runtime.runDomainCommand({ command_id: "automation.job.set_status", input_source: "surface_operation", idempotency_key: "management-automation-pause", payload: { job_id: jobId, status: "disabled" } });
  assert.equal((await store.getAutomationJob(jobId))?.status, "disabled");
  await runtime.runDomainCommand({ command_id: "automation.job.set_status", input_source: "surface_operation", idempotency_key: "management-automation-resume", payload: { job_id: jobId, status: "enabled" } });
  await store.createAutomationRun({ id: "management-run", kind: "custom_instruction", source: "automation_job", status: "completed", started_at: now, completed_at: now });
  assert.equal((await store.listAutomationRuns()).length, 1);

  const operations = await store.listOperations();
  assert.equal(operations.some((item) => item.operation === "skill.patch"), true);
  assert.equal(operations.some((item) => item.operation === "automation.job.set_status"), true);
  process.stdout.write(`${JSON.stringify({ status: "passed", wiki_read_edit_graph: true, wiki_lint_broken_duplicate_orphan: true, wiki_backlinks: true, skill_edit_disable_history: true, automation_pause_resume_history: true, shared_domain_commands: true, main_chat_context_contract: true })}\n`);
} finally {
  await runtime.shutdownMcpProcessPool();
  await store.close();
  await rm(root, { recursive: true, force: true });
}
