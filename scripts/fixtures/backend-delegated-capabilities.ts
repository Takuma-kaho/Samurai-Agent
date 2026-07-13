import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ClaudeCodeBackend, CodexBackend, ExternalCliBackend, parseCliOutputEvents } from "../../packages/agent-backends/src/index";

const root = await mkdtemp(path.join(tmpdir(), "samurai-backend-capabilities-"));
try {
  const executable = path.join(root, "backend");
  await writeFile(executable, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(executable, 0o755);
  const codex = new CodexBackend({
    command: executable,
    capabilityProbeResults: [
      { capability_id: "web_search", state: "available", source: "backend_native", mode: "live", probe_version: "codex-fixture-v1", evidence_summary: "A live search event with source URLs completed." },
      { capability_id: "subagent_delegate", state: "misconfigured", source: "backend_native", reason: "model_version_incompatible", probe_version: "codex-fixture-v1", evidence_summary: "The configured model does not support the installed CLI multi-agent protocol." }
    ]
  }).getStatus();
  const claude = new ClaudeCodeBackend({
    command: executable,
    capabilityProbeResults: [
      { capability_id: "web_search", state: "available", source: "backend_native", mode: "live", probe_version: "claude-fixture-v1", evidence_summary: "WebSearch executed in non-interactive mode." },
      { capability_id: "web_fetch", state: "available", source: "backend_native", probe_version: "claude-fixture-v1", evidence_summary: "WebFetch executed in non-interactive mode." },
      { capability_id: "browser_interact", state: "misconfigured", source: "backend_native", reason: "authentication_expired", probe_version: "claude-fixture-v1", evidence_summary: "Chrome connection authentication expired." }
    ]
  }).getStatus();
  const unavailable = new ExternalCliBackend({
    id: "missing",
    kind: "external",
    label: "Missing",
    command: "samurai-definitely-missing-command",
    capabilityProbeResults: [{ capability_id: "web_search", state: "available", source: "backend_native", probe_version: "fixture-v1", evidence_summary: "Stale evidence." }]
  }).getStatus();
  assert.equal(codex.capabilities?.find((item) => item.capability_id === "web_search")?.mode, "live");
  assert.equal(codex.capabilities?.find((item) => item.capability_id === "browser_screenshot")?.state, "unverified");
  assert.equal(claude.capabilities?.find((item) => item.capability_id === "browser_interact")?.reason, "authentication_expired");
  assert.equal(unavailable.capabilities?.find((item) => item.capability_id === "web_search")?.state, "unavailable");

  const searchEvent = parseCliOutputEvents(JSON.stringify({ type: "item.completed", item: { type: "web_search", id: "search-1", mode: "live", sources: [{ url: "https://example.test/source" }] } }))[0];
  const subagentEvent = parseCliOutputEvents(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "agent-1", name: "Agent", input: { description: "Inspect tests" } }] } }))[0];
  assert.deepEqual(searchEvent?.payload.source_urls, ["https://example.test/source"]);
  assert.equal(subagentEvent?.payload.capability_id, "subagent_delegate");
  assert.equal(subagentEvent?.payload.child_task_summary, "Inspect tests");
  process.stdout.write(`${JSON.stringify({ status: "passed", codex_search_mode_and_sources: true, claude_noninteractive_tools: true, subagent_parent_relation: true, unavailable_not_promoted: true, reason_codes_distinct: true })}\n`);
} finally {
  await rm(root, { recursive: true, force: true });
}
