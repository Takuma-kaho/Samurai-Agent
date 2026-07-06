import { describe, expect, it } from "vitest";
import { ActionCatalogEntrySchema, DomainCommandCatalogDiagnosticsReportSchema, PluginManifestSchema, type PluginManifest } from "@samurai-agent/core-schemas";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  PluginRuntimeRegistry,
  actionCatalogEntries,
  createPluginManifestSignaturePayload,
  domainCommandEntries,
  domainCommandOutputRenderKinds,
  getDomainCommandCatalogDiagnostics,
  getDomainCommandForProviderToolName,
  getDomainCommandForSurfaceOperationKind,
  getPluginManifest,
  listActionCatalogEntries,
  listDomainCommandEntries,
  loadPluginManifests,
  pluginManifests
} from "./index";

describe("action catalog", () => {
  it("keeps action discovery separate from policy decisions", () => {
    expect(actionCatalogEntries.length).toBeGreaterThan(4);
    for (const entry of actionCatalogEntries) {
      expect(ActionCatalogEntrySchema.parse(entry)).toEqual(entry);
      expect(entry).not.toHaveProperty("risk");
      expect(entry).not.toHaveProperty("approval");
      expect(entry).not.toHaveProperty("policy");
    }
  });

  it("groups built-in actions through plugin manifests", () => {
    for (const manifest of pluginManifests) {
      expect(PluginManifestSchema.parse(manifest)).toEqual(manifest);
    }
    expect(getPluginManifest("samurai-workspace-core")?.actions.map((entry) => entry.id)).toContain("gateway.inbound.route");
    expect(listActionCatalogEntries("collection").map((entry) => entry.id)).toContain("collection.record.create");
    expect(listActionCatalogEntries("collection").map((entry) => entry.id)).toContain("collection.patch.apply");
    expect(listActionCatalogEntries("collection").map((entry) => entry.id)).toContain("collection.action.run");
  });

  it("maps UI and provider inputs onto the common Domain Command catalog", () => {
    expect(actionCatalogEntries.map((entry) => entry.id).sort()).toEqual(domainCommandEntries.map((entry) => entry.id).sort());
    const standardRenderKinds = new Set(domainCommandOutputRenderKinds);
    for (const entry of domainCommandEntries) {
      expect(entry.output_render_kinds.length, `${entry.id} should declare at least one render kind`).toBeGreaterThan(0);
      expect(entry.output_render_kinds.every((kind) => standardRenderKinds.has(kind)), `${entry.id} should use standard render kinds`).toBe(true);
    }
    expect(getDomainCommandForSurfaceOperationKind("message.submit")?.id).toBe("chat.turn.run");
    expect(getDomainCommandForSurfaceOperationKind("collection.record.patch")?.id).toBe("collection.patch.apply");
    expect(getDomainCommandForSurfaceOperationKind("collection.action.run")?.id).toBe("collection.action.run");
    expect(getDomainCommandForSurfaceOperationKind("chart.request")?.id).toBe("artifact.create");
    expect(getDomainCommandForSurfaceOperationKind("chart.request")?.output_render_kinds).toContain("chart");
    expect(getDomainCommandForProviderToolName("create_artifact")?.id).toBe("artifact.create");
    expect(getDomainCommandForProviderToolName("create_artifact")?.output_render_kinds).toContain("artifact");
    expect(getDomainCommandForProviderToolName("remember_topic")?.id).toBe("memory.topic.create");
    expect(getDomainCommandForProviderToolName("remember_topic")?.output_render_kinds).toEqual(["memory"]);
    expect(getDomainCommandForProviderToolName("request_external_send")?.id).toBe("external.send.prepare");
    expect(getDomainCommandForProviderToolName("request_external_send")?.output_render_kinds).toEqual(["status_timeline"]);
    expect(getDomainCommandForProviderToolName("mcp__samurai__collection_schema_save")?.id).toBe("collection.schema.save");
    expect(getDomainCommandForProviderToolName("mcp__samurai__collection_record_create")?.id).toBe("collection.record.create");
    expect(getDomainCommandForProviderToolName("mcp__samurai__collection_view_present")?.id).toBe("collection.view.present");
    expect(getDomainCommandForProviderToolName("samurai.collection.view.present")?.output_render_kinds).toEqual(["collection", "custom_view"]);
    expect(listDomainCommandEntries("gateway_inbound").map((entry) => entry.id)).toContain("gateway.inbound.route");
    expect(listDomainCommandEntries("automation").map((entry) => entry.id)).toEqual(expect.arrayContaining([
      "chat.turn.run",
      "automation.job.run",
      "automation.memory_review.run"
    ]));
    const artifactActionSchema = actionCatalogEntries.find((entry) => entry.id === "artifact.create")?.output_schema as Record<string, unknown> | undefined;
    expect(artifactActionSchema?.["x-samurai-render-kinds"]).toEqual(["artifact", "form", "table", "chart", "custom_view"]);
  });

  it("self-diagnoses the Domain Command catalog", () => {
    const diagnostics = DomainCommandCatalogDiagnosticsReportSchema.parse(getDomainCommandCatalogDiagnostics());

    expect(diagnostics.ok).toBe(true);
    expect(diagnostics.issues).toEqual([]);
    expect(diagnostics.coverage.commands).toBe(domainCommandEntries.length);
    expect(diagnostics.coverage.action_catalog_entries).toBe(actionCatalogEntries.length);
    expect(diagnostics.coverage.provider_tool_mappings).toBeGreaterThan(0);
    expect(diagnostics.coverage.surface_operation_mappings).toBeGreaterThan(0);
    expect(diagnostics.coverage.render_kinds).toEqual([...domainCommandOutputRenderKinds]);
  });

  it("reports registered plugin action handlers", async () => {
    const registry = new PluginRuntimeRegistry();
    expect(registry.hasRegisteredHandler("collection.action.run")).toBe(false);
    registry.registerHandler("runtime.collection.action.run", async () => ({ status: "completed", output: { ok: true } }));

    expect(registry.hasRegisteredHandler("collection.action.run")).toBe(true);
  });

  it("loads filesystem plugin manifests into action discovery", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-plugin-test-"));
    await mkdir(path.join(root, "plugins", "contacts"), { recursive: true });
    await writeFile(path.join(root, "plugins", "contacts", "plugin.json"), JSON.stringify({
      id: "contacts-plugin",
      name: "Contacts Plugin",
      version: "1.0.0",
      kind: "collection_action",
      actions: [{
        id: "contacts.normalize",
        title: "Normalize contact",
        description: "Normalize a contact record.",
        input_schema: { type: "object" },
        output_schema: { type: "object" },
        resource_kinds: ["collection_record"],
        handler_id: "runtime.collection.action.normalize",
        implementation_target: "runtime",
        ui_display_category: "collection"
      }],
      renderers: [{
        id: "contacts.renderer.card",
        kind: "custom_view",
        renderer: "contacts.card",
        version: "1",
        title: "Contact card",
        description: "Render a contact card.",
        props_schema: { type: "object" },
        fallback_kind: "collection_record",
        category: "collection"
      }],
      resource_kinds: ["collection_record"],
      metadata: { local: true }
    }, null, 2));

    const loaded = await loadPluginManifests(root);

    expect(loaded.issues).toEqual([]);
    expect(loaded.manifests.map((manifest) => manifest.id)).toContain("contacts-plugin");
    expect(loaded.actions.map((action) => action.id)).toContain("contacts.normalize");
    expect(loaded.actions.map((action) => action.id)).toContain("artifact.create");
    expect(loaded.renderers.map((renderer) => renderer.id)).toContain("contacts.renderer.card");
    expect(loaded.bindings.find((binding) => binding.manifest_id === "contacts-plugin")).toMatchObject({
      entrypoint_status: "not_declared",
      action_ids: ["contacts.normalize"],
      renderer_ids: ["contacts.renderer.card"]
    });
  });

  it("executes discovered plugin actions through registered runtime handlers", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-plugin-runtime-test-"));
    await mkdir(path.join(root, ".codex-plugin"), { recursive: true });
    await writeFile(path.join(root, ".codex-plugin", "plugin.json"), JSON.stringify({
      id: "runtime-plugin",
      name: "Runtime Plugin",
      version: "1.0.0",
      kind: "tool",
      actions: [{
        id: "runtime.echo",
        title: "Echo",
        description: "Echo input.",
        input_schema: { type: "object" },
        output_schema: { type: "object" },
        resource_kinds: ["message"],
        handler_id: "runtime.echo.handler",
        implementation_target: "runtime",
        ui_display_category: "custom_view"
      }],
      resource_kinds: ["message"],
      metadata: {}
    }, null, 2));
    const loaded = await loadPluginManifests(root);
    const registry = new PluginRuntimeRegistry(loaded);

    const missing = await registry.executeAction("runtime.echo", { text: "hello" });
    registry.registerHandler("runtime.echo.handler", ({ input, manifest }) => ({
      status: "completed",
      output: { text: input.text, plugin: manifest?.id }
    }));
    const executed = await registry.executeAction("runtime.echo", { text: "hello" });

    expect(missing).toMatchObject({ status: "failed", error: "handler_not_registered" });
    expect(executed).toMatchObject({
      action_id: "runtime.echo",
      handler_id: "runtime.echo.handler",
      status: "completed",
      output: { text: "hello", plugin: "runtime-plugin" }
    });
  });

  it("loads signed filesystem plugin entrypoints into runtime handlers", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-plugin-entrypoint-test-"));
    await mkdir(path.join(root, "plugins", "echo"), { recursive: true });
    const entrypoint = `
export const handlers = {
  "plugin.echo.handler": ({ input }) => ({
    status: "completed",
    output: { text: input.text, source: "entrypoint" }
  })
};
`;
    await writeFile(path.join(root, "plugins", "echo", "entrypoint.mjs"), entrypoint, "utf8");
    const entrypointHash = createHash("sha256").update(entrypoint).digest("hex");
    const manifest: PluginManifest = {
      id: "echo-plugin",
      name: "Echo Plugin",
      version: "1.0.0",
      kind: "tool",
      entrypoint: "entrypoint.mjs",
      actions: [{
        id: "plugin.echo",
        title: "Echo",
        description: "Echo input through a signed plugin entrypoint.",
        input_schema: { type: "object" },
        output_schema: { type: "object" },
        resource_kinds: ["message"],
        handler_id: "plugin.echo.handler",
        implementation_target: "plugin",
        ui_display_category: "custom_view"
      }],
      resource_kinds: ["message"],
      metadata: { entrypoint_sha256: entrypointHash }
    };
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const signature = sign(null, Buffer.from(createPluginManifestSignaturePayload(manifest), "utf8"), privateKey).toString("base64");
    const signedManifest: PluginManifest = {
      ...manifest,
      metadata: {
        ...manifest.metadata,
        plugin_signature: {
          algorithm: "ed25519",
          key_id: "test-key",
          signature
        }
      }
    };
    await writeFile(path.join(root, "plugins", "echo", "plugin.json"), JSON.stringify(signedManifest, null, 2));

    const loaded = await loadPluginManifests(root, {
      trustedSigningKeys: [{
        key_id: "test-key",
        public_key: publicKey.export({ type: "spki", format: "pem" }).toString()
      }]
    });
    const registry = new PluginRuntimeRegistry(loaded);
    const entrypoints = await registry.loadEntrypoints({ importModule: importEntrypointForTest });
    const executed = await registry.executeAction("plugin.echo", { text: "hello" });

    expect(loaded.issues).toEqual([]);
    expect(loaded.bindings.find((binding) => binding.manifest_id === "echo-plugin")).toMatchObject({
      entrypoint_status: "ready",
      signature_status: "trusted",
      expected_entrypoint_sha256: entrypointHash
    });
    expect(entrypoints).toMatchObject({
      loaded: [expect.objectContaining({
        manifest_id: "echo-plugin",
        registered_handler_ids: ["plugin.echo.handler"]
      })],
      issues: []
    });
    expect(registry.listPluginStatuses().find((status) => status.manifest_id === "echo-plugin")).toMatchObject({
      registered_handler_ids: ["plugin.echo.handler"],
      missing_handler_ids: []
    });
    expect(executed).toMatchObject({
      action_id: "plugin.echo",
      handler_id: "plugin.echo.handler",
      status: "completed",
      output: { text: "hello", source: "entrypoint" }
    });
  });
});

async function importEntrypointForTest(specifier: string): Promise<unknown> {
  const source = await readFile(fileURLToPath(specifier), "utf8");
  return import(`data:text/javascript;base64,${Buffer.from(source, "utf8").toString("base64")}`);
}
