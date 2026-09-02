import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "./auth";
import {
  readWorkspaceBundleV4Transport,
  verifyWorkspaceBundleV4,
  writeWorkspaceBundleV4Transport
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
  "automation-runs.jsonl", "redactions.jsonl", "agents.jsonl", "agent-room-permissions.jsonl",
  "connection-descriptors.jsonl"
] as const;
const recordCountKeys = [
  "configurations", "activities", "episodes", "episode_activities", "resources", "resource_versions", "skill_files",
  "policy_approvals", "attestations", "evidence", "resource_links", "policy_rules", "policy_change_requests", "uses",
  "evaluations", "jobs", "job_attempts", "curator_state", "curator_snapshots", "file_batches", "file_batch_entries",
  "search_projection", "migration_receipts", "workspace_documents", "runtime_activities", "runtime_automation_jobs",
  "runtime_automation_runs", "redactions", "agents", "agent_room_permissions", "connection_descriptors"
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

  it("carries source Organization provenance from the embedded v3 Bundle", async () => {
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
});

async function writeMinimalV4Bundle(
  root: string,
  input: {
    migrationReceipts?: readonly Record<string, unknown>[];
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
  for (const file of completionFiles) {
    const content = file === "migration-receipts.jsonl"
      ? migrationReceipts.map((row) => canonicalJson(row)).join("\n") + (migrationReceipts.length ? "\n" : "")
      : "";
    await writeFile(path.join(completionRoot, file), content, { flag: "wx", mode: 0o600 });
  }
  const files = await hashFiles(root);
  const recordCounts = Object.fromEntries(recordCountKeys.map((key) => [
    key,
    key === "migration_receipts" ? migrationReceipts.length : 0
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
