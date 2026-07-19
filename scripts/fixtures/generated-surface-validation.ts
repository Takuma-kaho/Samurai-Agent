import assert from "node:assert/strict";
import { SurfaceGenerationRequestSchema, type GeneratedSurfaceActionDeclaration } from "../../packages/core-schemas/src/index";
import { buildGeneratedSurfaceRevision, generatedSurfaceCsp, parseGeneratedSurfaceOutput, validateGeneratedSurfaceBundle } from "../../packages/runtime/src/presentation/generated-surface";

const request = SurfaceGenerationRequestSchema.parse({
  id: "surface-request", session_id: "surface-session", user_intent: "タスクを更新する独自操作面",
  source_resource_refs: [], allowed_domain_commands: ["collection.patch.apply"], selected_knowledge_refs: [], selected_skill_refs: [],
  client_capabilities: { generated_surface: true }, expected_lifetime: "session", fallback_chain: ["built_in_surface", "artifact", "text"],
  created_at: "2026-07-11T00:00:00.000Z"
});
const actions: GeneratedSurfaceActionDeclaration[] = [{
  id: "complete", label: "Complete", command_id: "collection.patch.apply",
  input_schema: { type: "object" }, payload_template: {}, requires_confirmation: false
}];
const validBundle = {
  title: "Task controls",
  html: '<main><button type="button" data-action-id="complete">Complete</button></main>',
  css: "main { display: grid; gap: 8px; }",
  script: "document.addEventListener('click', event => { const id = event.target.dataset.actionId; if (id) parent.postMessage({type:'surface.action', action_id:id}, '*'); });",
  actions
};
const valid = validateGeneratedSurfaceBundle(request, validBundle);
assert.equal(valid.valid, true);
assert.equal(valid.csp, generatedSurfaceCsp);
const built = buildGeneratedSurfaceRevision({ request, bundle: validBundle, now: "2026-07-11T00:00:00.000Z" });
assert.equal(built.definition.current_revision, 1);
assert.equal(built.revision.validation_report.valid, true);
const benchmarkTasks = Array.from({ length: 30 }, (_, index) => ({
  name: `workspace-task-${index + 1}`,
  bundle: { ...validBundle, title: `Task control ${index + 1}`, html: `<main><h1>Task ${index + 1}</h1><button type="button" data-action-id="complete">Complete</button></main>`, css: `main { display: grid; gap: ${8 + index % 4}px; }` }
}));
const benchmarkReports = benchmarkTasks.map((task) => validateGeneratedSurfaceBundle(request, task.bundle));
const generatedTasks = benchmarkReports.filter((report) => report.valid).length;
assert.ok(generatedTasks / benchmarkTasks.length >= 0.9);
assert.equal(benchmarkReports.every((report) => report.issues.length === 0), true);

const invalidCases = [
  { code: "surface_html_forbidden_element", bundle: { ...validBundle, html: "<iframe src='x'></iframe>" } },
  { code: "surface_html_inline_handler", bundle: { ...validBundle, html: "<button onclick='x()'>x</button>" } },
  { code: "surface_external_url", bundle: { ...validBundle, html: "<img src='https://example.com/x.png'>" } },
  { code: "surface_script_forbidden_capability", bundle: { ...validBundle, script: "fetch('/secret')" } },
  { code: "surface_html_too_large", bundle: { ...validBundle, html: "x".repeat(200_001) } },
  { code: "surface_action_not_allowed", bundle: { ...validBundle, actions: [{ ...actions[0], command_id: "workspace.delete" }] } },
  { code: "surface_action_duplicate", bundle: { ...validBundle, actions: [actions[0], actions[0]] } }
];
for (const item of invalidCases) {
  const report = validateGeneratedSurfaceBundle(request, item.bundle);
  assert.equal(report.valid, false);
  assert.ok(report.issues.some((issue) => issue.code === item.code));
  assert.equal(report.fallback, "built_in_surface");
}
assert.equal(parseGeneratedSurfaceOutput({ wrong: true }), undefined);
assert.deepEqual(parseGeneratedSurfaceOutput({ custom_view: validBundle })?.title, validBundle.title);

process.stdout.write(`${JSON.stringify({ status: "passed", benchmark_tasks: benchmarkTasks.length, generated_tasks: generatedTasks, generation_success_rate: generatedTasks / benchmarkTasks.length, schema_action_validation_rate: benchmarkReports.filter((report) => report.valid && report.issues.length === 0).length / benchmarkTasks.length, valid_bundle: true, csp: generatedSurfaceCsp, invalid_cases: invalidCases.map((item) => item.code), malformed_fallback: true, fallback_chain: request.fallback_chain, revision_hash: built.revision.bundle_hash })}\n`);
