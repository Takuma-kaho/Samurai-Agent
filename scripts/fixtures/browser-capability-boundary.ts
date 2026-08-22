import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentRuntime, type BrowserAdapter } from "../../packages/runtime/src/index";
import { WorkspaceStore } from "../../packages/workspace-store/src/index";

const root = await mkdtemp(path.join(tmpdir(), "samurai-browser-boundary-"));
const store = await WorkspaceStore.create({ rootDir: root });
const calls: string[] = [];
const adapter: BrowserAdapter = {
  id: "fixture-browser",
  async interact(input) {
    calls.push(`${input.action}:${input.selector ?? ""}:${input.value ?? ""}`);
    return { url: input.url, title: "Fixture page", text: "Interaction complete" };
  },
  async screenshot() {
    calls.push("screenshot");
    return { bytes: Uint8Array.from([137, 80, 78, 71]), mime_type: "image/png", width: 1, height: 1 };
  }
};
const runtime = new AgentRuntime(store, undefined, undefined, undefined, undefined, undefined, { browserAdapter: adapter });
try {
  const screenshot = await runtime.runBrowserAction({ operation: "browser.screenshot", url: "https://example.test", output_path: "browser/fixture.png" });
  assert.equal(screenshot.resource.adapter_id, adapter.id);
  assert.equal(screenshot.resource.mime_type, "image/png");
  assert.deepEqual([...await readFile(path.join(root, "browser/fixture.png"))], [137, 80, 78, 71]);

  const interaction = await runtime.runBrowserAction({ operation: "browser.interact", url: "https://example.test", action: "input", selector: "#query", value: "samurai" });
  assert.equal(interaction.resource.text, "Interaction complete");

  const snapshot = await runtime.runBrowserAction({ operation: "browser.download_to_workspace", url: "data:text/html,<main>Snapshot only</main>", output_path: "browser/snapshot.txt" });
  assert.equal(snapshot.resource.snapshot_kind, "html_snapshot");
  assert.equal(snapshot.resource.screenshot_ref, undefined);

  const noAdapterRoot = await mkdtemp(path.join(tmpdir(), "samurai-browser-no-adapter-"));
  const noAdapterStore = await WorkspaceStore.create({ rootDir: noAdapterRoot });
  const noAdapter = new AgentRuntime(noAdapterStore);
  await assert.rejects(noAdapter.runBrowserAction({ operation: "browser.screenshot", url: "https://example.test" }), /browser_screenshot_adapter_unavailable/);
  await assert.rejects(noAdapter.runBrowserAction({ operation: "browser.interact", url: "https://example.test", action: "click", selector: "button" }), /browser_interact_adapter_unavailable/);
  await noAdapter.shutdownMcpProcessPool();
  await noAdapterStore.close();
  await rm(noAdapterRoot, { recursive: true, force: true });

  process.stdout.write(`${JSON.stringify({ status: "passed", real_screenshot_bytes: true, interact: calls.includes("input:#query:samurai"), html_snapshot_distinct: true, unavailable_explicit: true })}\n`);
} finally {
  await runtime.shutdownMcpProcessPool();
  await store.close();
  await rm(root, { recursive: true, force: true });
}
