import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { canonicalJson } from "./auth";
import type { WorkspaceServerStore } from "./workspace-server-store";
import { WorkspaceServerCommandService } from "./workspace-server-commands";
import type { WorkspaceBundleV3Manifest } from "./types";
import type { WorkspaceBundleV4Manifest } from "./workspace-completion-bundle-v4";

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

  it("exports a standalone Workspace without requiring Organization provenance", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "samurai-command-bundle-standalone-export-"));
    try {
      const store = fakeStore(root, { sourceOrganizationId: undefined });
      const bundles = {
        export: vi.fn(async (_context: unknown, input: { destination: string }) => {
          const manifest = await writeFixture(input.destination, { sourceOrganizationId: undefined });
          return { id: "ledger_standalone_bundle", directory: input.destination, manifest };
        })
      };
      const commands = new WorkspaceServerCommandService({
        store,
        bundles: bundles as never,
        files: {} as never
      });

      const result = await commands.exportWorkspaceBundle(
        { accountId, operationId: "operation_command_standalone_export", requestId: "request_command_standalone_export" },
        { workspace_id: workspaceId }
      );

      expect(result).toMatchObject({
        bundle_id: "bundle_operation_command_standalone_export",
        workspace_id: workspaceId,
        schema_version: 26
      });
      expect(result).not.toHaveProperty("source_organization_id");
      expect(result.manifest).not.toHaveProperty("source_organization_id");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("allows an Organization-scoped export when a verified V4 manifest omits source Organization", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "samurai-command-bundle-v4-attached-export-"));
    try {
      const store = fakeStore(root);
      const completionBundles = {
        export: vi.fn(async (_context: unknown, input: { destination: string }) => {
          const manifest = await writeV4Fixture(input.destination);
          return { directory: input.destination, manifest };
        })
      };
      const commands = new WorkspaceServerCommandService({
        store,
        bundles: {} as never,
        completionBundles: completionBundles as never,
        files: {} as never
      });

      const result = await commands.exportWorkspaceBundle(
        { accountId, operationId: "operation_command_v4_attached_export", requestId: "request_command_v4_attached_export", organizationId: sourceOrganizationId },
        { organization_id: sourceOrganizationId, workspace_id: workspaceId }
      );

      expect(store.exportWorkspaceBundle).toHaveBeenCalledWith(
        expect.objectContaining({ accountId, organizationId: sourceOrganizationId }),
        expect.objectContaining({ organization_id: sourceOrganizationId, workspace_id: workspaceId })
      );
      expect(result).toMatchObject({
        bundle_id: "bundle_operation_command_v4_attached_export",
        workspace_id: workspaceId,
        schema_version: 26
      });
      expect(result).not.toHaveProperty("source_organization_id");
      expect(result.manifest).not.toHaveProperty("source_organization_id");
      const onDiskManifest = JSON.parse(await readFile(
        path.join(root, "exports", workspaceId, "bundle_operation_command_v4_attached_export", "manifest.json"),
        "utf8"
      )) as Record<string, unknown>;
      expect(onDiskManifest).not.toHaveProperty("source_organization_id");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("restores a standalone Workspace by default and exposes the explicit Facade operations", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "samurai-command-bundle-standalone-restore-"));
    try {
      const bundleId = "bundle_operation_command_standalone_restore_source";
      const directory = path.join(root, "exports", workspaceId, bundleId);
      const manifest = await writeFixture(directory, { sourceOrganizationId: undefined });
      let importInput: Record<string, unknown> | undefined;
      const attach = vi.fn(async () => ({ workspace: {}, addedGuestAccountIds: [], replayed: false }));
      const detach = vi.fn(async () => ({ workspace: {}, addedGuestAccountIds: [], replayed: false }));
      const bundles = {
        importNew: vi.fn(async (_context: unknown, input: Record<string, unknown>) => {
          importInput = input;
          return { workspaceId: String(input.targetWorkspaceId), manifest };
        })
      };
      const store = fakeStore(root, { sourceOrganizationId: undefined, attach, detach });
      const commands = new WorkspaceServerCommandService({
        store,
        bundles: bundles as never,
        files: {} as never
      });

      const result = await commands.restoreWorkspaceBundle(
        { accountId, operationId: "operation_command_standalone_restore", requestId: "request_command_standalone_restore" },
        { bundle_id: bundleId, confirm: true }
      );

      expect(importInput).toBeDefined();
      expect(importInput).not.toHaveProperty("targetOrganizationId");
      expect(result).not.toHaveProperty("target_organization_id");
      expect(result).toMatchObject({ status: "restored", workspace_id: expect.stringMatching(/^workspace_restore_[a-f0-9]{40}$/) });

      const context = { accountId, operationId: "operation_command_association", requestId: "request_command_association" };
      const associationInput = { organizationId: targetOrganizationId, workspaceId };
      await commands.attachWorkspaceToOrganization(context, associationInput);
      await commands.detachWorkspaceFromOrganization(context, associationInput);
      expect(attach).toHaveBeenCalledWith(context, associationInput);
      expect(detach).toHaveBeenCalledWith(context, associationInput);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function fakeStore(storageRoot: string, options: {
  sourceOrganizationId?: string;
  attach?: ReturnType<typeof vi.fn>;
  detach?: ReturnType<typeof vi.fn>;
} = { sourceOrganizationId }): WorkspaceServerStore {
  return {
    storageRoot,
    exportWorkspaceBundle: vi.fn(async () => options.sourceOrganizationId === undefined
      ? {}
      : { sourceOrganizationId: options.sourceOrganizationId }),
    restoreWorkspaceBundle: vi.fn(async () => ({ status: "authorized" })),
    attachWorkspaceToOrganization: options.attach ?? vi.fn(async () => ({ workspace: {}, addedGuestAccountIds: [], replayed: false })),
    detachWorkspaceFromOrganization: options.detach ?? vi.fn(async () => ({ workspace: {}, addedGuestAccountIds: [], replayed: false }))
  } as unknown as WorkspaceServerStore;
}

async function writeFixture(directory: string, options: { sourceOrganizationId?: string } = { sourceOrganizationId }): Promise<WorkspaceBundleV3Manifest> {
  const fixtureSourceOrganizationId = options.sourceOrganizationId;
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
    ...(fixtureSourceOrganizationId ? { organization_id: fixtureSourceOrganizationId } : {}),
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
  const source = {
    hosting_mode: "self_host",
    database_placement: "dedicated",
    ...(fixtureSourceOrganizationId ? { organization_id: fixtureSourceOrganizationId } : {})
  };
  const manifest = {
    format_version: 3,
    workspace_id: workspaceId,
    exported_at: "2026-08-31T00:00:00.000Z",
    source,
    ...(fixtureSourceOrganizationId ? { source_organization_id: fixtureSourceOrganizationId } : {}),
    schema_version: 26,
    schema_revision: 26,
    files: hashes,
    record_counts: recordCounts,
    integrity_hash: ""
  } as Record<string, unknown>;
  manifest.integrity_hash = createHash("sha256").update(canonicalJson({
    files: hashes,
    record_counts: recordCounts,
    source,
    schema_version: 26,
    schema_revision: 26
  })).digest("hex");
  for (const [name, content] of Object.entries(files)) await writeFile(path.join(directory, name), content, "utf8");
  await writeFile(path.join(directory, "manifest.json"), canonicalJson(manifest), "utf8");
  return manifest as unknown as WorkspaceBundleV3Manifest;
}

async function writeV4Fixture(directory: string): Promise<WorkspaceBundleV4Manifest> {
  const base = await writeFixture(path.join(directory, "base-v3"), { sourceOrganizationId: undefined });
  const completionDirectory = path.join(directory, "completion");
  const files = [
    "configurations.jsonl", "activities.jsonl", "episodes.jsonl", "episode-activities.jsonl",
    "resources.jsonl", "resource-versions.jsonl", "skill-files.jsonl", "policy-approvals.jsonl",
    "attestations.jsonl", "evidence.jsonl", "resource-links.jsonl", "policy-rules.jsonl",
    "policy-change-requests.jsonl", "uses.jsonl", "evaluations.jsonl", "jobs.jsonl",
    "job-attempts.jsonl", "curator-state.jsonl", "curator-snapshots.jsonl", "file-batches.jsonl",
    "file-batch-entries.jsonl", "search-projection.jsonl", "migration-receipts.jsonl",
    "workspace-documents.jsonl", "runtime-activities.jsonl", "automation-jobs.jsonl",
    "automation-runs.jsonl", "redactions.jsonl", "agents.jsonl", "agent-room-permissions.jsonl",
    "connection-descriptors.jsonl"
  ] as const;
  await mkdir(completionDirectory, { recursive: true, mode: 0o700 });
  for (const file of files) await writeFile(path.join(completionDirectory, file), "", { flag: "wx", mode: 0o600 });
  const hashes = await hashFilesRecursively(directory);
  const recordCounts = Object.fromEntries([
    "configurations", "activities", "episodes", "episode_activities", "resources", "resource_versions",
    "skill_files", "policy_approvals", "attestations", "evidence", "resource_links", "policy_rules",
    "policy_change_requests", "uses", "evaluations", "jobs", "job_attempts", "curator_state",
    "curator_snapshots", "file_batches", "file_batch_entries", "search_projection", "migration_receipts",
    "workspace_documents", "runtime_activities", "runtime_automation_jobs", "runtime_automation_runs",
    "redactions", "agents", "agent_room_permissions", "connection_descriptors"
  ].map((key) => [key, 0] as const));
  const manifest = {
    format_version: 4,
    workspace_id: workspaceId,
    exported_at: "2026-08-31T00:00:00.000Z",
    schema_revision: 26,
    schema_version: 26,
    base_v3_integrity_hash: base.integrity_hash,
    excluded_maintenance_account_ids: [],
    files: hashes,
    record_counts: recordCounts,
    integrity_hash: ""
  } satisfies WorkspaceBundleV4Manifest;
  manifest.integrity_hash = createHash("sha256").update(canonicalJson({
    files: hashes,
    record_counts: recordCounts,
    base_v3_integrity_hash: base.integrity_hash,
    excluded_maintenance_account_ids: [],
    schema_revision: 26,
    schema_version: 26
  })).digest("hex");
  await writeFile(path.join(directory, "manifest.json"), canonicalJson(manifest), { flag: "wx", mode: 0o600 });
  return manifest;
}

async function hashFilesRecursively(root: string, prefix = ""): Promise<Record<string, string>> {
  const directory = path.join(root, prefix);
  const entries = await readdir(directory, { withFileTypes: true });
  const files: Record<string, string> = {};
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      Object.assign(files, await hashFilesRecursively(root, relative));
    } else if (entry.isFile() && relative !== "manifest.json") {
      files[relative] = createHash("sha256").update(await readFile(path.join(root, relative))).digest("hex");
    }
  }
  return Object.fromEntries(Object.entries(files).sort(([left], [right]) => left.localeCompare(right)));
}
