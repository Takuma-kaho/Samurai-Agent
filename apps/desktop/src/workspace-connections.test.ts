import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  activeWorkspaceConnection,
  clearActiveWorkspaceTarget,
  cutoverWorkspaceTarget,
  getWorkspaceTransfer,
  loadWorkspaceConnectionRegistry,
  migrateWorkspaceConnectionRegistry,
  patchWorkspaceTarget,
  recordWorkspaceTransfer,
  saveWorkspaceConnectionRegistry,
  selectWorkspaceConnection,
  selectWorkspaceTarget,
  upsertWorkspaceConnection,
  upsertWorkspaceTarget,
  workspaceTargetKey
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

    expect(migrated.version).toBe(3);
    expect(migrated.connections).toHaveLength(1);
    expect(migrated.connections[0]).toMatchObject({
      serverUrl: "https://samurai.example.test",
      accountId: "account_owner",
      lastWorkspaceId: "workspace_last",
      credentialRef: "electron-safe-storage://workspace-account/account_owner"
    });
    expect(migrated.connections[0]).not.toHaveProperty("workspaceId");
    expect(migrated.activeTarget).toMatchObject({
      connectionId: migrated.connections[0]!.id,
      workspaceId: "workspace_last"
    });
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

  it("retains separate Workspace candidates on one Server+Account connection", () => {
    const first = upsertWorkspaceConnection({ version: 1, connections: [] }, {
      label: "Company",
      serverUrl: "https://samurai.example.test",
      accountId: "account_owner",
      lastWorkspaceId: "workspace_a",
      lastRoomId: "room_a"
    });
    const second = upsertWorkspaceConnection(first, {
      label: "Company",
      serverUrl: "https://samurai.example.test",
      accountId: "account_owner",
      lastWorkspaceId: "workspace_b",
      lastRoomId: "room_b"
    });
    const connection = second.connections[0]!;

    expect(connection.targets.map((target) => target.workspaceId).sort()).toEqual(["workspace_a", "workspace_b"]);
    expect(second.activeTarget).toEqual({ connectionId: connection.id, workspaceId: "workspace_a" });
    expect(workspaceTargetKey({ connectionId: connection.id, workspaceId: "workspace_a" }))
      .not.toBe(workspaceTargetKey({ connectionId: connection.id, workspaceId: "workspace_b" }));
    expect(selectWorkspaceTarget(second, { connectionId: connection.id, workspaceId: "workspace_b" }).activeTarget)
      .toEqual({ connectionId: connection.id, workspaceId: "workspace_b" });
  });

  it("keeps same Workspace IDs isolated across Server connections", () => {
    const first = upsertWorkspaceConnection({ version: 1, connections: [] }, {
      label: "A",
      serverUrl: "https://a.example.test",
      accountId: "account_owner",
      lastWorkspaceId: "workspace_shared"
    });
    const second = upsertWorkspaceConnection(first, {
      label: "B",
      serverUrl: "https://b.example.test",
      accountId: "account_owner",
      lastWorkspaceId: "workspace_shared"
    });
    expect(second.connections).toHaveLength(2);
    expect(new Set(second.connections.map((connection) => connection.targets[0]?.connectionId))).toHaveProperty("size", 2);
    const targetB = second.connections.find((connection) => connection.serverUrl === "https://b.example.test")!.targets[0]!;
    expect(selectWorkspaceTarget(second, { connectionId: targetB.connectionId, workspaceId: "workspace_shared" }).activeTarget)
      .toEqual({ connectionId: targetB.connectionId, workspaceId: "workspace_shared" });
  });

  it("updates one target's room candidate without changing another target", () => {
    const seeded = upsertWorkspaceConnection({ version: 1, connections: [] }, {
      label: "Company",
      serverUrl: "https://samurai.example.test",
      accountId: "account_owner",
      lastWorkspaceId: "workspace_a",
      lastRoomId: "room_a"
    });
    const connection = seeded.connections[0]!;
    const withSecond = upsertWorkspaceConnection(seeded, {
      label: "Company",
      serverUrl: connection.serverUrl,
      accountId: connection.accountId,
      targets: [{ connectionId: connection.id, workspaceId: "workspace_b", lastRoomId: "room_b" }]
    });
    const patched = patchWorkspaceTarget(withSecond, {
      connectionId: connection.id,
      workspaceId: "workspace_b"
    }, { lastRoomId: "room_b2" });
    const updated = patched.connections[0]!;
    expect(updated.targets.find((target) => target.workspaceId === "workspace_a")?.lastRoomId).toBe("room_a");
    expect(updated.targets.find((target) => target.workspaceId === "workspace_b")?.lastRoomId).toBe("room_b2");
  });

  it("keeps a cutover source for recovery while exposing only the destination target", () => {
    const source = upsertWorkspaceConnection({ version: 1, connections: [] }, {
      label: "Source",
      serverUrl: "https://source.example.test",
      accountId: "account_owner",
      lastWorkspaceId: "workspace_move",
      lastRoomId: "room_move"
    });
    const sourceConnection = source.connections[0]!;
    const withDestination = upsertWorkspaceConnection(source, {
      label: "Destination",
      serverUrl: "https://destination.example.test",
      accountId: "account_owner"
    });
    const destinationConnection = withDestination.connections.find((connection) => connection.serverUrl === "https://destination.example.test")!;
    const selected = selectWorkspaceTarget(withDestination, {
      connectionId: sourceConnection.id,
      workspaceId: "workspace_move"
    });
    const cutover = cutoverWorkspaceTarget(selected, {
      source: { connectionId: sourceConnection.id, workspaceId: "workspace_move" },
      destination: { connectionId: destinationConnection.id, workspaceId: "workspace_move" }
    });

    expect(cutover.activeTarget).toEqual({ connectionId: destinationConnection.id, workspaceId: "workspace_move" });
    expect(cutover.connections.find((connection) => connection.id === sourceConnection.id)?.targets[0]).toMatchObject({
      workspaceId: "workspace_move",
      supersededBy: { connectionId: destinationConnection.id, workspaceId: "workspace_move" }
    });
    expect(cutover.connections.find((connection) => connection.id === destinationConnection.id)?.targets[0]).toMatchObject({
      connectionId: destinationConnection.id,
      workspaceId: "workspace_move"
    });
    expect(() => selectWorkspaceTarget(cutover, {
      connectionId: sourceConnection.id,
      workspaceId: "workspace_move"
    })).toThrow("workspace_target_superseded");
  });

  it("persists a cutover receipt so source completion can resume after restart", async () => {
    const source = upsertWorkspaceConnection({ version: 1, connections: [] }, {
      label: "Source",
      serverUrl: "https://source.example.test",
      accountId: "account_owner",
      lastWorkspaceId: "workspace_move"
    });
    const sourceConnection = source.connections[0]!;
    const withDestination = upsertWorkspaceConnection(source, {
      label: "Destination",
      serverUrl: "https://destination.example.test",
      accountId: "account_owner"
    });
    const destinationConnection = withDestination.connections.find((connection) => connection.serverUrl === "https://destination.example.test")!;
    const transfer = recordWorkspaceTransfer(withDestination, {
      transferId: "transfer_resume_1",
      source: { connectionId: sourceConnection.id, workspaceId: "workspace_move" },
      destination: { connectionId: destinationConnection.id, workspaceId: "workspace_move" },
      state: "cutover",
      workspaceId: "workspace_move",
      integrityHash: "a".repeat(64),
      sourceArchived: false,
      organizationReleased: true,
      receipt: {
        format_version: 1,
        transfer_id: "transfer_resume_1",
        source_workspace_id: "workspace_move",
        source_integrity_hash: "a".repeat(64),
        target_workspace_id: "workspace_move",
        imported_at: "2026-09-02T00:00:00.000Z",
        target_integrity_hash: "a".repeat(64)
      },
      updatedAt: "2026-09-02T00:00:00.000Z"
    });
    const touched = upsertWorkspaceTarget(transfer, {
      connectionId: destinationConnection.id,
      workspaceId: "workspace_move"
    });
    expect(getWorkspaceTransfer(touched, "transfer_resume_1")?.state).toBe("cutover");
    const root = await mkdtemp(path.join(os.tmpdir(), "samurai-transfer-"));
    const file = path.join(root, "connections.json");
    try {
      await saveWorkspaceConnectionRegistry(file, touched);
      const loaded = await loadWorkspaceConnectionRegistry(file);
      expect(getWorkspaceTransfer(loaded, "transfer_resume_1")).toMatchObject({
        state: "cutover",
        sourceArchived: false,
        receipt: {
          transfer_id: "transfer_resume_1",
          source_integrity_hash: "a".repeat(64),
          target_integrity_hash: "a".repeat(64)
        }
      });
      expect(await readFile(file, "utf8")).not.toContain("private");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("clears only a revoked active target and preserves other connection candidates", () => {
    const seeded = upsertWorkspaceConnection({ version: 1, connections: [] }, {
      label: "Company",
      serverUrl: "https://samurai.example.test",
      accountId: "account_owner"
    });
    const connection = seeded.connections[0]!;
    const withFirst = upsertWorkspaceTarget(seeded, {
      connectionId: connection.id,
      workspaceId: "workspace_a"
    });
    const withSecond = upsertWorkspaceConnection(withFirst, {
      label: "Company",
      serverUrl: connection.serverUrl,
      accountId: connection.accountId,
      lastWorkspaceId: "workspace_b"
    });
    const active = selectWorkspaceTarget(withSecond, { connectionId: connection.id, workspaceId: "workspace_a" });
    const cleared = clearActiveWorkspaceTarget(active, { connectionId: connection.id, workspaceId: "workspace_a" });
    expect(cleared.activeTarget).toBeUndefined();
    expect(cleared.activeConnectionId).toBe(connection.id);
    expect(cleared.connections[0]?.targets.map((target) => target.workspaceId).sort()).toEqual(["workspace_a", "workspace_b"]);
  });
});
