import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  activeWorkspaceConnection,
  loadWorkspaceConnectionRegistry,
  migrateWorkspaceConnectionRegistry,
  saveWorkspaceConnectionRegistry,
  selectWorkspaceConnection,
  upsertWorkspaceConnection
} from "./workspace-connections";

describe("Desktop Workspace connections", () => {
  it("stores server URL, Account, and a last-Workspace candidate without a private key", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "samurai-connections-"));
    const file = path.join(root, "connections.json");
    try {
      const registry = upsertWorkspaceConnection({ version: 1, connections: [] }, {
        label: "Company",
        serverUrl: "https://samurai.example.test/",
        workspaceId: "workspace_company",
        accountId: "account_owner",
        credentialRef: "keychain://samurai/company",
        ...({ privateKey: "not-persisted" } as object)
      });
      await saveWorkspaceConnectionRegistry(file, registry);
      const loaded = await loadWorkspaceConnectionRegistry(file);
      const raw = await readFile(file, "utf8");

      expect(activeWorkspaceConnection(selectWorkspaceConnection(loaded, loaded.connections[0]!.id))?.serverUrl).toBe("https://samurai.example.test");
      expect(raw).toContain("keychain://samurai/company");
      expect(raw).not.toContain("not-persisted");
      expect((await stat(file)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses raw credentials in the connection registry", () => {
    expect(() => upsertWorkspaceConnection({ version: 1, connections: [] }, {
      label: "Unsafe",
      serverUrl: "https://samurai.example.test",
      workspaceId: "workspace_company",
      accountId: "account_owner",
      credentialRef: ["-----BEGIN", "PRIVATE KEY-----"].join(" ")
    })).toThrow("workspace_connection_credential_ref_invalid");
  });

  it("accepts plain HTTP only for a local Self-host Server", () => {
    const base = { label: "Local", workspaceId: "workspace_home", accountId: "account_owner" };
    expect(() => upsertWorkspaceConnection({ version: 1, connections: [] }, {
      ...base,
      serverUrl: "http://127.0.0.1:4317"
    })).not.toThrow();
    expect(() => upsertWorkspaceConnection({ version: 1, connections: [] }, {
      ...base,
      serverUrl: "http://samurai.example.test"
    })).toThrow("workspace_connection_server_url_invalid");
    expect(() => upsertWorkspaceConnection({ version: 1, connections: [] }, {
      ...base,
      serverUrl: "https://user:password@samurai.example.test"
    })).toThrow("workspace_connection_server_url_invalid");
  });

  it("keeps an existing protected-key reference when the same connection is saved again", () => {
    const initial = upsertWorkspaceConnection({ version: 1, connections: [] }, {
      label: "Company",
      serverUrl: "https://samurai.example.test",
      workspaceId: "workspace_company",
      accountId: "account_owner",
      credentialRef: "electron-safe-storage://workspace-account/account_owner"
    });
    const updated = upsertWorkspaceConnection(initial, {
      label: "Company renamed",
      serverUrl: "https://samurai.example.test",
      workspaceId: "workspace_company",
      accountId: "account_owner"
    });

    expect(updated.connections).toHaveLength(1);
    expect(updated.connections[0]?.credentialRef).toBe("electron-safe-storage://workspace-account/account_owner");
  });

  it("migrates legacy Workspace-scoped rows into one Server+Account candidate", () => {
    const migrated = migrateWorkspaceConnectionRegistry({
      version: 1,
      activeConnectionId: "legacy_b",
      connections: [
        {
          id: "legacy_a",
          label: "Old A",
          serverUrl: "https://samurai.example.test",
          workspaceId: "workspace_old",
          accountId: "account_owner",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z"
        },
        {
          id: "legacy_b",
          label: "Old B",
          serverUrl: "https://samurai.example.test/",
          workspaceId: "workspace_last",
          accountId: "account_owner",
          credentialRef: "electron-safe-storage://workspace-account/account_owner",
          createdAt: "2026-01-02T00:00:00.000Z",
          updatedAt: "2026-01-02T00:00:00.000Z"
        }
      ]
    });

    expect(migrated.version).toBe(2);
    expect(migrated.connections).toHaveLength(1);
    expect(migrated.connections[0]).toMatchObject({
      serverUrl: "https://samurai.example.test",
      accountId: "account_owner",
      lastWorkspaceId: "workspace_last",
      credentialRef: "electron-safe-storage://workspace-account/account_owner"
    });
    expect(migrated.connections[0]).not.toHaveProperty("workspaceId");
  });

  it("coalesces a later save for the same Server+Account without copying permissions", () => {
    const first = upsertWorkspaceConnection({ version: 1, connections: [] }, {
      label: "Company",
      serverUrl: "https://samurai.example.test",
      accountId: "account_owner",
      lastOrganizationId: "organization_a",
      lastWorkspaceId: "workspace_a"
    });
    const second = upsertWorkspaceConnection(first, {
      label: "Company",
      serverUrl: "https://samurai.example.test",
      accountId: "account_owner",
      lastOrganizationId: "organization_b",
      lastWorkspaceId: "workspace_b",
      lastRoomId: "room_b"
    });

    expect(second.connections).toHaveLength(1);
    expect(second.connections[0]).toMatchObject({
      lastOrganizationId: "organization_b",
      lastWorkspaceId: "workspace_b",
      lastRoomId: "room_b"
    });
    expect(second.connections[0]).not.toHaveProperty("permissions");
    expect(second.connections[0]).not.toHaveProperty("organizationRole");
  });
});
