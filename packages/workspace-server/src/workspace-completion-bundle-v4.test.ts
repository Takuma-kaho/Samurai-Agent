import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "./auth";
import type { WorkspaceServerStore } from "./workspace-server-store";
import {
  readWorkspaceBundleV4Transport,
  verifyWorkspaceBundleV4,
  writeWorkspaceBundleV4Transport,
  WorkspaceBundleV4Service
} from "./workspace-completion-bundle-v4";

const workspaceId = "workspace_bundle_v4_test";
const transferId = "transfer_bundle_v4_test";
const timestamp = "2026-08-22T00:00:00.000Z";
const completionFiles = [
  "configurations.jsonl", "activities.jsonl", "episodes.jsonl", "episode-activities.jsonl",
  "resources.jsonl", "resource-versions.jsonl", "skill-files.jsonl", "policy-approvals.jsonl",
  "attestations.jsonl", "evidence.jsonl", "resource-links.jsonl", "policy-rules.jsonl",
  "policy-change-requests.jsonl", "uses.jsonl", "evaluations.jsonl", "jobs.jsonl",
  "job-attempts.jsonl", "curator-state.jsonl", "curator-snapshots.jsonl", "file-batches.jsonl",
  "file-batch-entries.jsonl", "search-projection.jsonl", "migration-receipts.jsonl",
  "workspace-documents.jsonl", "runtime-activities.jsonl", "automation-jobs.jsonl",
  "automation-runs.jsonl", "runtime-sessions.jsonl", "runtime-messages.jsonl", "redactions.jsonl", "agents.jsonl", "agent-room-permissions.jsonl",
  "connection-descriptors.jsonl"
] as const;
const recordCountKeys = [
  "configurations", "activities", "episodes", "episode_activities", "resources", "resource_versions", "skill_files",
  "policy_approvals", "attestations", "evidence", "resource_links", "policy_rules", "policy_change_requests", "uses",
  "evaluations", "jobs", "job_attempts", "curator_state", "curator_snapshots", "file_batches", "file_batch_entries",
  "search_projection", "migration_receipts", "workspace_documents", "runtime_activities", "runtime_automation_jobs",
  "runtime_automation_runs", "runtime_sessions", "runtime_messages", "redactions", "agents", "agent_room_permissions", "connection_descriptors"
] as const;

describe("Workspace Bundle v4 HTTP transport", () => {
  it("round-trips a verified transfer bundle without changing its transfer identity", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "samurai-bundle-v4-"));
    try {
      const source = path.join(root, "source");
      await writeMinimalV4Bundle(source);
      const verified = await verifyWorkspaceBundleV4(source);
      const transport = await readWorkspaceBundleV4Transport(source);
      const restored = await writeWorkspaceBundleV4Transport({
        transport,
        destination: path.join(root, "restored")
      });

      expect(transport.format).toBe("samurai-workspace-bundle-v4");
      expect(restored.manifest.integrity_hash).toBe(verified.manifest.integrity_hash);
      expect(restored.manifest.transfer_id).toBe(transferId);
      expect(restored.manifest).not.toHaveProperty("source_organization_id");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a transport entry whose content does not match the signed manifest hash", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "samurai-bundle-v4-"));
    try {
      const source = path.join(root, "source");
      await writeMinimalV4Bundle(source);
      const transport = await readWorkspaceBundleV4Transport(source);
      transport.entries[0] = { ...transport.entries[0]!, content_base64: Buffer.from("tampered").toString("base64") };

      await expect(writeWorkspaceBundleV4Transport({
        transport,
        destination: path.join(root, "rejected")
      })).rejects.toThrow("workspace_bundle_v4_hash_mismatch");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects migration receipts that expose excluded secret-shaped resource identifiers", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "samurai-bundle-v4-"));
    try {
      const source = path.join(root, "source");
      await writeMinimalV4Bundle(source, {
        migrationReceipts: [{
          workspace_id: workspaceId,
          id: "completion_migration_receipt_test",
          counts: { blocked_secret_resources: ["sk-live-must-not-be-portable"] }
        }]
      });

      await expect(verifyWorkspaceBundleV4(source)).rejects.toThrow("workspace_bundle_v4_secret_forbidden");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accepts portable migration receipts that retain only the filtered count", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "samurai-bundle-v4-"));
    try {
      const source = path.join(root, "source");
      await writeMinimalV4Bundle(source, {
        migrationReceipts: [{
          workspace_id: workspaceId,
          id: "completion_migration_receipt_test",
          counts: { filtered_resource_count: 1 }
        }]
      });

      await expect(verifyWorkspaceBundleV4(source)).resolves.toMatchObject({
        manifest: { format_version: 4 }
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accepts historical source Organization provenance from an old v3 Bundle", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "samurai-bundle-v4-provenance-"));
    try {
      const source = path.join(root, "source");
      await writeMinimalV4Bundle(source, {
        provenance: { sourceOrganizationId: "organization_source", schemaRevision: 78 }
      });

      const verified = await verifyWorkspaceBundleV4(source);
      expect(verified.manifest).toMatchObject({
        source_organization_id: "organization_source",
        schema_revision: 78,
        schema_version: 78
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("round-trips Agent role, instructions, and enabled fields", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "samurai-bundle-v4-agent-"));
    try {
      const source = path.join(root, "source");
      await writeMinimalV4Bundle(source, {
        agents: [{
          workspace_id: workspaceId,
          id: "agent_bundle_test",
          display_name: "Bundle Agent",
          description: "Legacy description",
          role: "researcher",
          instructions: "Use evidence before answering",
          backend_id: "samurai-native",
          enabled: false,
          status: "disabled",
          version: 1,
          created_by: "account_owner",
          created_at: timestamp,
          updated_at: timestamp
        }]
      });
      const transport = await readWorkspaceBundleV4Transport(source);
      const restored = await writeWorkspaceBundleV4Transport({
        transport,
        destination: path.join(root, "restored")
      });
      const restoredAgent = JSON.parse((await readFile(
        path.join(restored.directory, "completion", "agents.jsonl"),
        "utf8"
      )).trim()) as Record<string, unknown>;

      expect(restoredAgent).toMatchObject({
        role: "researcher",
        instructions: "Use evidence before answering",
        enabled: false
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("round-trips Workspace Chat sessions and messages", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "samurai-bundle-v4-chat-"));
    try {
      const source = path.join(root, "source");
      await writeMinimalV4Bundle(source, {
        chatSessions: [{
          workspace_id: workspaceId,
          id: "session_bundle_test",
          session_key: "workspace:portable:thread_bundle_test",
          room_id: "room_bundle_test",
          title: "Portable Chat",
          ui_locale: "ja",
          output_locale: "ja",
          created_at: timestamp,
          updated_at: timestamp
        }],
        chatMessages: [{
          workspace_id: workspaceId,
          id: "message_bundle_test",
          session_id: "session_bundle_test",
          role: "user",
          content: "Keep this Workspace conversation available after restore.",
          input_locale: "ja",
          output_locale: "ja",
          envelope: { input_locale: "ja", output_locale: "ja" },
          created_at: timestamp
        }]
      });

      const verified = await verifyWorkspaceBundleV4(source);
      expect(verified.manifest.record_counts).toMatchObject({ runtime_sessions: 1, runtime_messages: 1 });
      const transport = await readWorkspaceBundleV4Transport(source);
      expect(transport.entries.map((entry) => entry.path)).toEqual(expect.arrayContaining([
        "completion/runtime-sessions.jsonl",
        "completion/runtime-messages.jsonl"
      ]));
      const restored = await writeWorkspaceBundleV4Transport({
        transport,
        destination: path.join(root, "restored")
      });
      const restoredSession = JSON.parse(await readFile(
        path.join(restored.directory, "completion", "runtime-sessions.jsonl"),
        "utf8"
      )) as Record<string, unknown>;
      const restoredMessage = JSON.parse(await readFile(
        path.join(restored.directory, "completion", "runtime-messages.jsonl"),
        "utf8"
      )) as Record<string, unknown>;

      expect(restoredSession).toMatchObject({ id: "session_bundle_test", room_id: "room_bundle_test" });
      expect(restoredMessage).toMatchObject({ id: "message_bundle_test", session_id: "session_bundle_test", role: "user" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns the V4 integrity hash in a transfer receipt", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "samurai-bundle-v4-receipt-"));
    try {
      const source = path.join(root, "source");
      const targetWorkspaceId = "workspace_bundle_v4_import_target";
      await writeMinimalV4Bundle(source);
      const verified = await verifyWorkspaceBundleV4(source);
      const store = {
        storageRoot: root,
        database: {
          withContext: async (_context: unknown, callback: (sql: { query: (query: string) => Promise<{ rows: Record<string, unknown>[] }> }) => Promise<unknown>) => callback({
            query: async (query: string) => {
              if (query.includes("workspace_completion_migration_receipts")) return { rows: [{ id: "completion_receipt" }] };
              if (query.includes("workspace_completion_maintenance_identities")) return { rows: [{ exists: false }] };
              if (query.includes("workspace_members")) return { rows: [{ exists: false }] };
              return { rows: [] };
            }
          })
        }
      } as unknown as WorkspaceServerStore;
      const service = new WorkspaceBundleV4Service(store);
      const internals = service as unknown as {
        v3: { importNew: (context: unknown, input: unknown) => Promise<unknown> }
      };
      internals.v3.importNew = async () => ({
        workspaceId: targetWorkspaceId,
        manifest: {} as never,
        // The embedded V3 restore reports its own hash. V4 must replace this
        // with the outer Bundle hash before the receipt goes back to A.
        receipt: {
          format_version: 1,
          transfer_id: transferId,
          source_workspace_id: workspaceId,
          source_integrity_hash: verified.manifest.base_v3_integrity_hash,
          target_workspace_id: targetWorkspaceId,
          imported_at: timestamp,
          target_integrity_hash: verified.manifest.base_v3_integrity_hash
        }
      });

      const imported = await service.importNew({
        accountId: "account_owner",
        operationId: "operation_bundle_v4_receipt_test"
      }, {
        sourceDirectory: source,
        targetWorkspaceId
      });
      const replayed = await service.importNew({
        accountId: "account_owner",
        operationId: "operation_bundle_v4_receipt_test"
      }, {
        sourceDirectory: source,
        targetWorkspaceId
      });

      expect(imported.receipt).toMatchObject({
        format_version: 1,
        transfer_id: transferId,
        source_workspace_id: workspaceId,
        source_integrity_hash: verified.manifest.integrity_hash,
        target_workspace_id: targetWorkspaceId,
        target_integrity_hash: verified.manifest.integrity_hash
      });
      expect(imported.receipt).toEqual(replayed.receipt);
      expect(imported.receipt?.imported_at).toBe(verified.manifest.exported_at);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("stages a V4 Bundle without a target Organization by default", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "samurai-bundle-v4-target-"));
    try {
      const source = path.join(root, "source");
      await writeMinimalV4Bundle(source);
      const manifest = JSON.parse(await readFile(path.join(source, "manifest.json"), "utf8")) as never;
      const service = new WorkspaceBundleV4Service({ storageRoot: root } as unknown as WorkspaceServerStore);

      await expect(service.stageIncomingBundle({
        accountId: "account_owner",
        operationId: "operation_bundle_v4_target_test"
      }, {
        targetWorkspaceId: workspaceId,
        manifest
      })).resolves.toBeUndefined();

      const metadata = JSON.parse(await readFile(path.join(
        root,
        ".incoming-v4",
        "account_owner",
        "operation_bundle_v4_target_test.json"
      ), "utf8")) as Record<string, unknown>;
      expect(metadata).not.toHaveProperty("target_organization_id");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function writeMinimalV4Bundle(
  root: string,
  input: {
    migrationReceipts?: readonly Record<string, unknown>[];
    agents?: readonly Record<string, unknown>[];
    chatSessions?: readonly Record<string, unknown>[];
    chatMessages?: readonly Record<string, unknown>[];
    provenance?: { sourceOrganizationId: string; schemaRevision: number };
  } = {}
): Promise<void> {
  const base = path.join(root, "base-v3");
  await mkdir(base, { recursive: true, mode: 0o700 });
  const baseFiles: Record<string, string> = {
    "workspace.json": canonicalJson({
      id: workspaceId,
      name: "Bundle v4 test",
      hosting_mode: "self_host",
      database_placement: "dedicated",
      storage_namespace: `workspaces/${workspaceId}`,
      created_by: "account_owner",
      version: 1,
      created_at: timestamp,
      updated_at: timestamp
    }),
    "accounts.jsonl": "",
    "rooms.jsonl": "",
    "memberships.jsonl": `${canonicalJson({
      workspace_id: workspaceId,
      account_id: "account_owner",
      role: "owner",
      state: "active",
      version: 1,
      created_at: timestamp,
      updated_at: timestamp,
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
  const baseHashes = Object.fromEntries(Object.entries(baseFiles).map(([name, content]) => [name, hash(content)]));
  for (const [name, content] of Object.entries(baseFiles)) await writeFile(path.join(base, name), content, "utf8");
  const baseRecordCounts = { rooms: 0, memberships: 1, room_memberships: 0, records: 0, events: 0, jobs: 0, operations: 0, invitations: 0, audits: 0, files: 0 };
  const baseProvenance = input.provenance;
  const baseIntegrityPayload = baseProvenance
    ? {
      files: baseHashes,
      record_counts: baseRecordCounts,
      source: {
        hosting_mode: "self_host",
        database_placement: "dedicated",
        organization_id: baseProvenance.sourceOrganizationId
      },
      schema_version: baseProvenance.schemaRevision,
      schema_revision: baseProvenance.schemaRevision,
      transfer_id: transferId
    }
    : { files: baseHashes, record_counts: baseRecordCounts };
  const baseIntegrityHash = hash(canonicalJson(baseIntegrityPayload));
  await writeFile(path.join(base, "manifest.json"), canonicalJson({
    format_version: 3,
    workspace_id: workspaceId,
    exported_at: timestamp,
    source: {
      hosting_mode: "self_host",
      database_placement: "dedicated",
      ...(baseProvenance ? { organization_id: baseProvenance.sourceOrganizationId } : {})
    },
    schema_version: baseProvenance?.schemaRevision ?? 26,
    ...(baseProvenance ? {
      source_organization_id: baseProvenance.sourceOrganizationId,
      schema_revision: baseProvenance.schemaRevision
    } : {}),
    transfer_id: transferId,
    files: baseHashes,
    record_counts: baseRecordCounts,
    integrity_hash: baseIntegrityHash
  }), "utf8");

  const completionRoot = path.join(root, "completion");
  await mkdir(completionRoot, { recursive: true, mode: 0o700 });
  const migrationReceipts = input.migrationReceipts ?? [];
  const agents = input.agents ?? [];
  const chatSessions = input.chatSessions ?? [];
  const chatMessages = input.chatMessages ?? [];
  for (const file of completionFiles) {
    const rows = file === "migration-receipts.jsonl"
      ? migrationReceipts
      : file === "agents.jsonl"
        ? agents
        : file === "runtime-sessions.jsonl"
          ? chatSessions
          : file === "runtime-messages.jsonl"
            ? chatMessages
            : [];
    const content = rows.map((row) => canonicalJson(row)).join("\n") + (rows.length ? "\n" : "");
    await writeFile(path.join(completionRoot, file), content, { flag: "wx", mode: 0o600 });
  }
  const files = await hashFiles(root);
  const recordCounts = Object.fromEntries(recordCountKeys.map((key) => [
    key,
    key === "migration_receipts"
      ? migrationReceipts.length
      : key === "agents"
        ? agents.length
        : key === "runtime_sessions"
          ? chatSessions.length
          : key === "runtime_messages"
            ? chatMessages.length
            : 0
  ]));
  const v4RecordCounts = recordCounts;
  const v4ManifestBase = {
    format_version: 4,
    workspace_id: workspaceId,
    exported_at: timestamp,
    transfer_id: transferId,
    ...(baseProvenance ? {
      source_organization_id: baseProvenance.sourceOrganizationId,
      schema_revision: baseProvenance.schemaRevision,
      schema_version: baseProvenance.schemaRevision
    } : {}),
    base_v3_integrity_hash: baseIntegrityHash,
    excluded_maintenance_account_ids: [],
    files,
    record_counts: v4RecordCounts,
    integrity_hash: ""
  } as Record<string, unknown>;
  const v4IntegrityPayload = baseProvenance
    ? {
      files,
      record_counts: v4RecordCounts,
      transfer_id: transferId,
      base_v3_integrity_hash: baseIntegrityHash,
      excluded_maintenance_account_ids: [],
      source_organization_id: baseProvenance.sourceOrganizationId,
      schema_revision: baseProvenance.schemaRevision,
      schema_version: baseProvenance.schemaRevision
    }
    : {
      files,
      record_counts: v4RecordCounts,
      transfer_id: transferId,
      base_v3_integrity_hash: baseIntegrityHash,
      excluded_maintenance_account_ids: []
    };
  v4ManifestBase.integrity_hash = hash(canonicalJson(v4IntegrityPayload));
  await writeFile(path.join(root, "manifest.json"), canonicalJson(v4ManifestBase), "utf8");
}

async function hashFiles(root: string, prefix = ""): Promise<Record<string, string>> {
  const directory = path.join(root, prefix);
  const entries = readdir(directory, { withFileTypes: true });
  const result: Record<string, string> = {};
  for (const entry of (await entries).sort((left, right) => left.name.localeCompare(right.name))) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(result, await hashFiles(root, relative));
    else if (!(entry.name === "manifest.json" && prefix === "")) result[relative] = hash((await readFile(path.join(root, relative))).toString("utf8"));
  }
  return Object.fromEntries(Object.entries(result).sort(([left], [right]) => left.localeCompare(right)));
}

async function readFileText(file: string): Promise<string> {
  return (await readFile(file, "utf8"));
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
