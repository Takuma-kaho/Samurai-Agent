import { describe, expect, it } from "vitest";
import {
  ConnectorRegistry,
  MemoryExternalIntegrationStore,
  sampleConnectorAdapter,
  sampleConnectorManifest,
  verifyConnectorContract
} from "./index.js";

describe("third-party Connector contract kit", () => {
  it("accepts a Store-independent sample Adapter and keeps its Installation Workspace-scoped", async () => {
    const verified = verifyConnectorContract({
      manifest: sampleConnectorManifest,
      adapter: sampleConnectorAdapter,
      hookFixture: { event_id: "sample-1", session_id: "session-1", occurred_at: "2026-08-17T00:00:00.000Z" }
    });
    expect(verified.event).toMatchObject({ connector_id: "sample_connector", external_session_id: "session-1", verification: "not_run" });

    const registry = new ConnectorRegistry({
      store: new MemoryExternalIntegrationStore(),
      samuraiVersion: "0.1.0",
      now: () => new Date("2026-08-17T00:00:00.000Z"),
      id: () => "sample-installation"
    });
    await registry.registerManifest(sampleConnectorManifest);
    await registry.install({ workspaceId: "workspace-a", connectorId: "sample_connector", version: "1.0.0" });
    await expect(registry.getCapabilities({ workspaceId: "workspace-b", connectorId: "sample_connector" })).rejects.toMatchObject({ code: "connector_disabled" });
    await registry.setEnabled("sample-installation", false);
    await registry.registerManifest({
      ...sampleConnectorManifest,
      version: "2.0.0",
      package_checksum: "sha256:sample-connector-v2"
    });
    await expect(registry.setEnabled("sample-installation", true)).rejects.toMatchObject({ code: "connector_version_unsupported" });
  });

  it("rejects a Connector whose declared identity differs from its normalized Activity", () => {
    expect(() => verifyConnectorContract({
      manifest: sampleConnectorManifest,
      adapter: { ...sampleConnectorAdapter, connectorId: "other_connector" },
      hookFixture: {}
    })).toThrow("connector_adapter_id_mismatch");
  });

  it("keeps concurrent first installs to one enabled Workspace installation", async () => {
    let nextId = 0;
    const registry = new ConnectorRegistry({
      store: new MemoryExternalIntegrationStore(),
      samuraiVersion: "0.1.0",
      id: () => `sample-installation-${++nextId}`
    });
    await registry.registerManifest(sampleConnectorManifest);
    const installations = await Promise.all([
      registry.install({ workspaceId: "workspace-race", connectorId: "sample_connector", version: "1.0.0" }),
      registry.install({ workspaceId: "workspace-race", connectorId: "sample_connector", version: "1.0.0" })
    ]);
    expect(new Set(installations.map((installation) => installation.id))).toEqual(new Set([installations[0]!.id]));
    expect((await registry.listInstallations({ workspaceId: "workspace-race", connectorId: "sample_connector" })).filter((installation) => installation.enabled)).toHaveLength(1);
  });

  it("rejects a Connector manifest with a non-SemVer version", async () => {
    const registry = new ConnectorRegistry({
      store: new MemoryExternalIntegrationStore(),
      samuraiVersion: "0.1.0"
    });
    await expect(registry.registerManifest({
      ...sampleConnectorManifest,
      version: "release-latest"
    })).rejects.toMatchObject({ code: "connector_version_unsupported" });
  });
});
