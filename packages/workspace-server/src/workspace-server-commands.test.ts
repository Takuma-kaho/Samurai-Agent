import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { canonicalJson } from "./auth";
import type { WorkspaceServerStore } from "./workspace-server-store";
import { WorkspaceServerCommandService } from "./workspace-server-commands";
import type { WorkspaceBundleV3Manifest } from "./types";

const workspaceId = "workspace_command_bundle";
const sourceOrganizationId = "organization_command_source";
const targetOrganizationId = "organization_command_target";
const accountId = "account_command_owner";

describe("WorkspaceServerCommandService Bundle commands", () => {
  it("exports a verified Bundle and returns public manifest/file metadata", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "samurai-command-bundle-export-"));
    try {
      const store = fakeStore(root);
      const bundles = {
        export: vi.fn(async (_context: unknown, input: { destination: string }) => {
          const manifest = await writeFixture(input.destination);
          return { id: "ledger_bundle", directory: input.destination, manifest };
        })
      };
      const commands = new WorkspaceServerCommandService({
        store,
        bundles: bundles as never,
        files: {} as never
      });

      const result = await commands.exportWorkspaceBundle(
        { accountId, operationId: "operation_command_export", requestId: "request_command_export", organizationId: sourceOrganizationId },
        { organization_id: sourceOrganizationId, workspace_id: workspaceId }
      );

      expect(result).toMatchObject({
        bundle_id: "bundle_operation_command_export",
        workspace_id: workspaceId,
        source_organization_id: sourceOrganizationId,
        schema_version: 26,
        file_count: 12,
        manifest: {
          workspace_id: workspaceId,
          source_organization_id: sourceOrganizationId,
          schema_version: 26
        }
      });
      expect(result.byte_size).toBeGreaterThan(0);
      expect((bundles.export as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]).toMatchObject({
        destination: path.join(root, "exports", workspaceId, "bundle_operation_command_export")
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("restores only a server-managed Bundle and passes the target Organization to import", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "samurai-command-bundle-restore-"));
    try {
      const bundleId = "bundle_operation_command_restore_source";
      const directory = path.join(root, "exports", workspaceId, bundleId);
      const manifest = await writeFixture(directory);
      let importInput: Record<string, unknown> | undefined;
      const bundles = {
        importNew: vi.fn(async (_context: unknown, input: Record<string, unknown>) => {
          importInput = input;
          return { workspaceId: String(input.targetWorkspaceId), manifest };
        })
      };
      const store = fakeStore(root);
      const commands = new WorkspaceServerCommandService({
        store,
        bundles: bundles as never,
        files: {} as never
      });

      const result = await commands.restoreWorkspaceBundle(
        { accountId, operationId: "operation_command_restore", requestId: "request_command_restore" },
        { bundle_id: bundleId, target_organization_id: targetOrganizationId, confirm: true }
      );

      expect(importInput).toMatchObject({
        sourceDirectory: directory,
        targetOrganizationId
      });
      const restoredWorkspaceId = String(importInput?.targetWorkspaceId);
      expect(restoredWorkspaceId).toMatch(/^workspace_restore_[a-f0-9]{40}$/);
      expect(restoredWorkspaceId).not.toBe(workspaceId);
      expect(result).toMatchObject({
        bundle_id: bundleId,
        workspace_id: restoredWorkspaceId,
        source_organization_id: sourceOrganizationId,
        target_organization_id: targetOrganizationId,
        schema_version: 26,
        integrity_hash: manifest.integrity_hash,
        status: "restored"
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects restore confirmation without touching the Store authorization path", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "samurai-command-bundle-confirm-"));
    try {
      const store = fakeStore(root);
      const commands = new WorkspaceServerCommandService({
        store,
        bundles: {} as never,
        files: {} as never
      });

      await expect(commands.restoreWorkspaceBundle(
        { accountId, operationId: "operation_command_restore_confirm", requestId: "request_command_restore_confirm" },
        { bundle_id: "bundle_missing", target_organization_id: targetOrganizationId }
      )).rejects.toThrow("workspace_bundle_restore_confirmation_required");
      expect((store.restoreWorkspaceBundle as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function fakeStore(storageRoot: string): WorkspaceServerStore {
  return {
    storageRoot,
    exportWorkspaceBundle: vi.fn(async () => ({ sourceOrganizationId })),
    restoreWorkspaceBundle: vi.fn(async () => ({ status: "authorized" }))
  } as unknown as WorkspaceServerStore;
}

async function writeFixture(directory: string): Promise<WorkspaceBundleV3Manifest> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const rows: Record<string, string> = {
    "accounts.jsonl": "",
    "rooms.jsonl": "",
    "memberships.jsonl": `${canonicalJson({
      workspace_id: workspaceId,
      account_id: accountId,
      role: "owner",
      state: "active",
      version: 1,
      created_at: "2026-08-31T00:00:00.000Z",
      updated_at: "2026-08-31T00:00:00.000Z",
      revoked_at: null
    })}\n`,
    "room-memberships.jsonl": "",
    "records.jsonl": "",
    "events.jsonl": "",
    "jobs.jsonl": "",
    "operations.jsonl": "",
    "invitations.jsonl": "",
    "audits.jsonl": "",
    "files.jsonl": ""
  };
  const workspace = canonicalJson({
    id: workspaceId,
    name: "Command Bundle",
    organization_id: sourceOrganizationId,
    hosting_mode: "self_host",
    database_placement: "dedicated",
    storage_namespace: `workspaces/${workspaceId}`,
    created_by: accountId,
    version: 1,
    created_at: "2026-08-31T00:00:00.000Z",
    updated_at: "2026-08-31T00:00:00.000Z"
  });
  const files: Record<string, string> = { "workspace.json": workspace, ...rows };
  const hashes = Object.fromEntries(Object.entries(files)
    .map(([name, content]) => [name, createHash("sha256").update(content).digest("hex")] as const)
    .sort(([left], [right]) => left.localeCompare(right)));
  const recordCounts = {
    rooms: 0, memberships: 1, room_memberships: 0, records: 0, events: 0,
    jobs: 0, operations: 0, invitations: 0, audits: 0, files: 0
  };
  const manifest = {
    format_version: 3,
    workspace_id: workspaceId,
    exported_at: "2026-08-31T00:00:00.000Z",
    source: { hosting_mode: "self_host", database_placement: "dedicated", organization_id: sourceOrganizationId },
    source_organization_id: sourceOrganizationId,
    schema_version: 26,
    schema_revision: 26,
    files: hashes,
    record_counts: recordCounts,
    integrity_hash: ""
  } as Record<string, unknown>;
  manifest.integrity_hash = createHash("sha256").update(canonicalJson({
    files: hashes,
    record_counts: recordCounts,
    source: { hosting_mode: "self_host", database_placement: "dedicated", organization_id: sourceOrganizationId },
    schema_version: 26,
    schema_revision: 26
  })).digest("hex");
  for (const [name, content] of Object.entries(files)) await writeFile(path.join(directory, name), content, "utf8");
  await writeFile(path.join(directory, "manifest.json"), canonicalJson(manifest), "utf8");
  return manifest as unknown as WorkspaceBundleV3Manifest;
}
