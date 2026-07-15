import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DomainCommandInputSource } from "../../packages/action-catalog/src/index";
import { AgentRuntime } from "../../packages/runtime/src/index";
import { WorkspaceStore } from "../../packages/workspace-store/src/index";

const root = await mkdtemp(path.join(tmpdir(), "samurai-command-parity-"));
const store = await WorkspaceStore.create({ rootDir: root });
const runtime = new AgentRuntime(store);
const at = "2026-01-01T00:00:00.000Z";
const sources: DomainCommandInputSource[] = ["runtime_api", "surface_operation", "provider_tool_call", "scheduled_context", "generated_surface"];

const normalize = (command: any) => {
  const result = command.result;
  return {
    validation: { version: result.resource.version, data: result.resource.data },
    change: { operation: result.operation.operation, status: result.operation.status, before: result.before.data, after: result.resource.data },
    history: {
      operation: result.operation.operation,
      status: result.operation.status,
      rollback: Boolean(result.operation.rollback_point_id)
    },
    render: command.render_specs.map((spec: any) => ({ kind: spec.kind, priority: spec.priority, state: spec.state, ref_kinds: spec.resource_refs.map((ref: any) => ref.kind) }))
  };
};

try {
  await store.saveCollectionSchema({ id: "parity", version: "1", labels: { en: "Parity" }, descriptions: { en: "Parity" }, fields: [{ id: "name", type: "string" }, { id: "score", type: "number" }, { id: "done", type: "boolean" }], refs: [], embeds: [], derived_fields: [], triggers: [], actions: [], views: [], permissions: { update: true } });
  const cases = Array.from({ length: 10 }, (_, index) => ({ name: `updated-${index}`, score: index + 1, done: index % 2 === 0 }));
  for (let caseIndex = 0; caseIndex < cases.length; caseIndex += 1) {
    const outputs = [];
    for (const source of sources) {
      const recordId = `record-${caseIndex}-${source}`;
      await store.saveCollectionRecord({ id: recordId, collection_id: "parity", version: 1, data: { name: "before", score: 0, done: false }, resource_refs: [], created_at: at, updated_at: at });
      outputs.push(normalize(await runtime.runDomainCommand({ command_id: "collection.patch.apply", input_source: source, idempotency_key: `parity-${caseIndex}-${source}`, payload: { collection_id: "parity", record_id: recordId, expected_version: 1, changes: cases[caseIndex] } })));
    }
    for (const output of outputs.slice(1)) assert.deepEqual(output, outputs[0], `entrance parity failed for case ${caseIndex}`);
  }
  const executions = await store.listDomainCommandExecutions();
  for (const source of sources) assert.equal(executions.filter((item) => item.input_source === source && item.command_id === "collection.patch.apply").length, 10);
  process.stdout.write(`${JSON.stringify({ status: "passed", gates: ["IN02"], representative_operations: 10, entrances: sources.length, executions: 50, validation_equal: true, change_equal: true, history_equal: true, render_equal: true })}\n`);
} finally {
  await runtime.shutdownMcpProcessPool().catch(() => undefined);
  await store.close();
  await rm(root, { recursive: true, force: true });
}
