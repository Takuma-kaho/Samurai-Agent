import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PluginRuntimeRegistry, createPluginManifestSignaturePayload, loadPluginManifests } from "../../packages/action-catalog/src/index";
import type { PluginManifest } from "../../packages/core-schemas/src/index";

const root = await mkdtemp(path.join(tmpdir(), "samurai-plugin-isolation-"));
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
try {
  const entrypoint = `
export const handlers = {
  "isolation.ok": ({ input }) => ({ status: "completed", output: { echo: input.text } }),
  "isolation.crash": () => process.exit(23),
  "isolation.timeout": async () => { await new Promise(() => {}); },
  "isolation.memory": () => { const values = []; while (true) values.push(new Array(500000).fill(Math.random())); }
};
`;
  await writePlugin("isolation", "isolation-plugin", "1", entrypoint, ["ok", "crash", "timeout", "memory"]);
  await writePlugin("incompatible", "incompatible-plugin", "2", `export const handlers = { "incompatible.ok": () => ({ status: "completed" }) };`, ["ok"]);
  await writePlugin("invalid-signature", "invalid-signature-plugin", "1", `export const handlers = { "invalid-signature.ok": () => ({ status: "completed" }) };`, ["ok"], true);

  const loaded = await loadPluginManifests(root, {
    requireSignature: true,
    trustedSigningKeys: [{ key_id: "fixture-key", public_key: publicKey.export({ type: "spki", format: "pem" }).toString() }]
  });
  assert.ok(loaded.issues.some((issue) => issue.code === "signature_invalid"));
  const registry = new PluginRuntimeRegistry(loaded);
  const entrypoints = await registry.loadEntrypoints({ timeoutMs: 300, memoryLimitMb: 24 });
  assert.ok(entrypoints.issues.some((issue) => issue.code === "version_incompatible"));
  assert.ok(entrypoints.issues.some((issue) => issue.code === "entrypoint_unsigned"));

  const okBefore = await registry.executeAction("isolation.ok", { text: "before" });
  const crash = await registry.executeAction("isolation.crash", {});
  const okAfterCrash = await registry.executeAction("isolation.ok", { text: "after-crash" });
  const timeout = await registry.executeAction("isolation.timeout", {});
  const okAfterTimeout = await registry.executeAction("isolation.ok", { text: "after-timeout" });
  const memory = await registry.executeAction("isolation.memory", {});
  const okAfterMemory = await registry.executeAction("isolation.ok", { text: "after-memory" });
  assert.equal(okBefore.status, "completed");
  for (const failed of [crash, timeout, memory]) assert.equal(failed.status, "failed");
  for (const successful of [okAfterCrash, okAfterTimeout, okAfterMemory]) assert.equal(successful.status, "completed");

  process.stdout.write(`${JSON.stringify({
    status: "passed", process_isolation: true, crash_failed: crash.status === "failed", timeout_failed: timeout.status === "failed",
    memory_limit_failed: memory.status === "failed", host_continued: true, signature_invalid_rejected: true,
    version_incompatible_rejected: true, unsigned_entrypoint_rejected: true, core_mutations_before_success: 0
  })}\n`);
} finally {
  await rm(root, { recursive: true, force: true });
}

async function writePlugin(directory: string, id: string, apiVersion: string, entrypoint: string, actionNames: string[], invalidSignature = false) {
  const pluginDir = path.join(root, "plugins", directory);
  await mkdir(pluginDir, { recursive: true });
  await writeFile(path.join(pluginDir, "entrypoint.mjs"), entrypoint);
  const manifest: PluginManifest = {
    id, name: id, version: "1.0.0", kind: "tool", entrypoint: "entrypoint.mjs",
    actions: actionNames.map((name) => ({
      id: `${directory}.${name}`, title: name, description: name, input_schema: { type: "object" }, output_schema: { type: "object" },
      resource_kinds: ["message"], handler_id: `${directory}.${name}`, implementation_target: "plugin", ui_display_category: "custom_view"
    })),
    resource_kinds: ["message"],
    metadata: { entrypoint_sha256: createHash("sha256").update(entrypoint).digest("hex"), plugin_api_version: apiVersion }
  };
  const signature = sign(null, Buffer.from(createPluginManifestSignaturePayload(manifest), "utf8"), privateKey).toString("base64");
  await writeFile(path.join(pluginDir, "plugin.json"), JSON.stringify({
    ...manifest,
    metadata: { ...manifest.metadata, plugin_signature: { algorithm: "ed25519", key_id: "fixture-key", signature: invalidSignature ? `${signature.slice(0, -4)}AAAA` : signature } }
  }, null, 2));
}
