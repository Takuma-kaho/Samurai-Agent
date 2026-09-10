import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { WorkspaceFileResourceRefSchema } from "@samurai-agent/core-schemas";
import { canonicalJson } from "./auth";
import { assertOpaqueId, assertSafeRelativePath } from "./config";
import { WorkspaceServerError } from "./errors";
import type { WorkspaceSql } from "./postgres";
import type { WorkspaceRequestContext, WorkspaceTransferReceipt } from "./types";
import {
  readWorkspaceTransfer,
  workspaceTransferRetryDestination,
  runExclusiveWorkspaceBundleStaging,
  runExclusiveWorkspaceTransferExport,
  assertWorkspaceBundleTargetOrganizationId,
  verifyWorkspaceBundleV3,
  WORKSPACE_BUNDLE_INCOMING_TTL_MS,
  WORKSPACE_BUNDLE_MAX_BYTES,
  WORKSPACE_BUNDLE_MAX_ENTRIES,
  WORKSPACE_BUNDLE_MAX_ENTRY_BYTES,
  WORKSPACE_BUNDLE_MAX_RECORDS_PER_FILE,
  WorkspaceBundleV3Service
} from "./workspace-bundle-v3";
import { WorkspaceCompletionFileService, type StagedWorkspaceCompletionFileBatch } from "./workspace-completion-files";
import { containsWorkspaceCompletionSecret } from "./workspace-completion-policy";
import { WorkspaceServerStore } from "./workspace-server-store";
import type { WorkspaceCompletionScope } from "./workspace-completion-types";

const manifestName = "manifest.json";
const baseV3Directory = "base-v3";
const completionDirectory = "completion";
const transportFormat = "samurai-workspace-bundle-v4";
const tableFiles = [
  // The maintenance Account is deliberately deployment-local and restricted
  // to exactly one Workspace. Restore never transports its credential or
  // membership; the target owner configures a fresh identity afterward.
  ["workspace_completion_configurations", "configurations.jsonl"],
  ["workspace_completion_activities", "activities.jsonl"],
  ["workspace_completion_episodes", "episodes.jsonl"],
  ["workspace_completion_episode_activities", "episode-activities.jsonl"],
  ["workspace_completion_resources", "resources.jsonl"],
  ["workspace_completion_resource_versions", "resource-versions.jsonl"],
  ["workspace_completion_skill_files", "skill-files.jsonl"],
  ["workspace_completion_policy_approvals", "policy-approvals.jsonl"],
  ["workspace_completion_attestations", "attestations.jsonl"],
  ["workspace_completion_evidence", "evidence.jsonl"],
  ["workspace_completion_resource_links", "resource-links.jsonl"],
  ["workspace_completion_policy_rules", "policy-rules.jsonl"],
  ["workspace_completion_policy_change_requests", "policy-change-requests.jsonl"],
  ["workspace_completion_uses", "uses.jsonl"],
  ["workspace_completion_evaluations", "evaluations.jsonl"],
  ["workspace_completion_jobs", "jobs.jsonl"],
  ["workspace_completion_job_attempts", "job-attempts.jsonl"],
  ["workspace_completion_curator_state", "curator-state.jsonl"],
  ["workspace_completion_curator_snapshots", "curator-snapshots.jsonl"],
  ["workspace_completion_file_batches", "file-batches.jsonl"],
  ["workspace_completion_file_batch_entries", "file-batch-entries.jsonl"],
  ["workspace_completion_search_projection", "search-projection.jsonl"],
  ["workspace_completion_migration_receipts", "migration-receipts.jsonl"],
  ["workspace_completion_workspace_documents", "workspace-documents.jsonl"],
  ["workspace_runtime_automation_jobs", "automation-jobs.jsonl"],
  ["workspace_runtime_automation_runs", "automation-runs.jsonl"],
  // Raw model exchanges are deliberately omitted: their hash/error evidence
  // remains with Job/Attempt, while their text follows local retention and
  // redaction rather than becoming portable Workspace content.
  ["workspace_completion_redactions", "redactions.jsonl"]
] as const;

// Chat sessions and messages are Workspace history, not deployment-local
// runtime state. They live outside the Completion extension's historical table
// list, so keep them as optional files: older V4 Bundles remain verifiable and
// importable while new exports carry the Chat transcript used by the target.
const workspaceChatFiles = [
  ["workspace_runtime_sessions", "runtime-sessions.jsonl"],
  ["workspace_runtime_messages", "runtime-messages.jsonl"]
] as const;

// Completed Runtime history is Workspace-owned evidence. Keep the process
// state out of a Bundle: reservations, live leases, client notifications and
// provider-native sessions are deployment-local and are intentionally absent.
// `workspace_runtime_operations` is also intentionally excluded: its
// idempotency ledger may contain deployment-local tokens.
const workspaceRuntimeHistoryFiles = [
  ["workspace_runtime_runs", "runtime-runs.jsonl"],
  ["workspace_runtime_events", "runtime-events.jsonl"],
  ["workspace_runtime_changes", "runtime-changes.jsonl"],
  ["workspace_runtime_activities", "runtime-activities.jsonl"],
  ["workspace_runtime_resource_usage", "runtime-resource-usage.jsonl"]
] as const;

// Authorization and external-connection state is part of the Workspace
// contract even though it is not a Completion resource. Credentials never
// enter a Bundle; active descriptors are exported as revoked and require
// re-authentication after restore.
const workspaceIdentityFiles = [
  ["workspace_agents", "agents.jsonl"],
  ["workspace_agent_room_permissions", "agent-room-permissions.jsonl"],
  ["workspace_connection_descriptors", "connection-descriptors.jsonl"]
] as const;

// Room-owned human work is portable history, while its execution leases are
// deployment-local. These files are optional when reading an older V4 Bundle;
// new exports always write all seven files, including empty ones.
const workspaceHumanWorkFiles = [
  ["workspace_human_works", "human-works.jsonl"],
  ["workspace_human_work_assignments", "human-work-assignments.jsonl"],
  ["workspace_human_work_instructions", "human-work-instructions.jsonl"],
  ["workspace_human_work_comments", "human-work-comments.jsonl"],
  ["workspace_human_work_comment_reactions", "human-work-comment-reactions.jsonl"],
  ["workspace_human_work_controls", "human-work-controls.jsonl"],
  ["workspace_human_work_launch_reservations", "human-work-launch-reservations.jsonl"]
] as const;

// This map is the compatibility bridge from retired Runtime Sessions to the
// Room work aggregate. It is historical metadata only; it never authorizes a
// new launch or claims a reservation.
const workspaceHumanWorkLegacyFiles = [
  ["workspace_human_work_legacy_sessions", "human-work-legacy-sessions.jsonl"]
] as const;

const workspaceHumanWorkAllFiles = [...workspaceHumanWorkFiles, ...workspaceHumanWorkLegacyFiles] as const;

function safeErrorCode(error: unknown): string {
  if (error instanceof WorkspaceServerError) return error.code;
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && /^[A-Za-z0-9_.:-]+$/.test(code)) return code;
  }
  return "workspace_server_internal_error";
}

export interface WorkspaceBundleV4Manifest {
  format_version: 4;
  workspace_id: string;
  exported_at: string;
  /** Historical raw provenance accepted from old V4 Bundles; new exports omit it. */
  source_organization_id?: string;
  /** DB/schema revision used by the embedded portable snapshot. */
  schema_revision?: number;
  /** Compatibility spelling consumed by the public domain contract. */
  schema_version?: number;
  transfer_id?: string;
  base_v3_integrity_hash: string;
  /** Public Account identities may remain in audit history, but these IDs
   * must have no Workspace/Room membership after restore. */
  excluded_maintenance_account_ids: readonly string[];
  files: Record<string, string>;
  record_counts: Record<string, number>;
  integrity_hash: string;
}

type WorkspaceBundleV3Provenance = {
  source?: { organization_id?: string };
  source_organization_id?: string;
  schema_revision?: number;
  schema_version?: number;
};

export interface ExportWorkspaceBundleV4Result {
  directory: string;
  manifest: WorkspaceBundleV4Manifest;
}

export interface WorkspaceBundleV4Transport {
  format: typeof transportFormat;
  manifest: WorkspaceBundleV4Manifest;
  entries: Array<{ path: string; content_base64: string }>;
}

export interface StageWorkspaceBundleV4Input {
  targetWorkspaceId: string;
  targetWorkspaceName?: string;
  /** Omit to restore a standalone Workspace; attach to an Organization later. */
  targetOrganizationId?: string;
  manifest: WorkspaceBundleV4Manifest;
}

interface IncomingV4BundleMetadata {
  format_version: 1;
  bundle_format: 4;
  account_id: string;
  operation_id: string;
  target_workspace_id: string;
  target_workspace_name?: string;
  target_organization_id?: string;
  manifest: WorkspaceBundleV4Manifest;
  created_at: string;
  expires_at: string;
  received_bytes: number;
  received_entries: number;
  completed?: {
    workspace_id: string;
    manifest: WorkspaceBundleV4Manifest;
    receipt?: WorkspaceTransferReceipt;
    completed_at: string;
  };
}

interface BundleLedgerRow {
  id: string;
  format_version: number | string;
  path: string;
  sha256: string;
  record_counts: Record<string, unknown>;
}

/** Bundle v4 composes a verified v3 Core snapshot with the file-backed
 * completion extension. v3 remains read/import compatible; new exports are
 * always v4. */
export class WorkspaceBundleV4Service {
  private readonly v3: WorkspaceBundleV3Service;
  private readonly files: WorkspaceCompletionFileService;

  constructor(private readonly store: WorkspaceServerStore) {
    this.v3 = new WorkspaceBundleV3Service(store);
    this.files = new WorkspaceCompletionFileService(store.storageRoot);
  }

  async export(context: WorkspaceRequestContext, input: { destination: string; transferId?: string }): Promise<ExportWorkspaceBundleV4Result> {
    const destination = path.resolve(input.destination);
    const staging = path.join(path.dirname(destination), `.${path.basename(destination)}.staging-${randomUUID()}`);
    // A transfer replay can arrive with a new request operation after the
    // original transfer has been recorded. Bind the ledger identity to the
    // transfer itself whenever one is supplied so the replay cannot generate
    // a second Bundle row.
    const transfer = input.transferId
      ? await readWorkspaceTransfer(this.store, context, input.transferId).catch((error) => {
        if (error instanceof WorkspaceServerError && error.code === "workspace_transfer_not_found") return undefined;
        throw error;
      })
      : undefined;
    const bundleId = completionId(
      "bundle_v4",
      context.workspaceId,
      input.transferId ? transferAttemptKey(input.transferId, transfer?.version) : context.operationId
    );
    // Authorization is never skipped just because a previous attempt already
    // created the destination directory.
    await this.assertOwner(context);
    if (await pathExists(destination)) {
      const verified = await verifyWorkspaceBundleV4(destination);
      if (verified.manifest.workspace_id !== context.workspaceId) throw new WorkspaceServerError("workspace_bundle_workspace_mismatch", 409);
      if (input.transferId !== undefined && verified.manifest.transfer_id !== input.transferId) {
        throw new WorkspaceServerError("workspace_transfer_bundle_mismatch", 409);
      }
      await this.recordV4Ledger(context, bundleId, destination, verified.manifest);
      return verified;
    }
    await this.filesRecover(context);
    try {
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await mkdir(staging, { recursive: false, mode: 0o700 });
      const maintenanceAccountIds = await this.readMaintenanceAccountIds(context);
      // This is intentionally the pure portable writer. Calling v3.export()
      // here would create a public ledger entry pointing at staging/base-v3.
      const base = await this.v3.writePortableSnapshot(context, {
        destination: path.join(staging, baseV3Directory),
        includeLegacyLearning: false,
        excludeMembershipAccountIds: maintenanceAccountIds,
        ...(input.transferId ? { transferId: input.transferId } : {})
      });
      // File batch entries are a recovery ledger. During a normal update an
      // old batch can have staged the former live path while its Version now
      // points at `.versions/...`. Export the durable snapshot by the paths
      // each Version actually references, not by stale staging destinations.
      const rows = normalizePortableBatchRows(await this.readCompletionRows(context));
      const identityRows = await this.readWorkspaceIdentityRows(context);
      for (const [table, filename] of tableFiles) {
        await writeJsonl(resolveBundlePath(staging, `${completionDirectory}/${filename}`), rows[table] ?? []);
      }
      for (const [table, filename] of workspaceChatFiles) {
        await writeJsonl(resolveBundlePath(staging, `${completionDirectory}/${filename}`), rows[table] ?? []);
      }
      for (const [table, filename] of workspaceRuntimeHistoryFiles) {
        await writeJsonl(resolveBundlePath(staging, `${completionDirectory}/${filename}`), rows[table] ?? []);
      }
      for (const [table, filename] of workspaceIdentityFiles) {
        await writeJsonl(resolveBundlePath(staging, `${completionDirectory}/${filename}`), identityRows[table] ?? []);
      }
      for (const [table, filename] of workspaceHumanWorkAllFiles) {
        await writeJsonl(resolveBundlePath(staging, `${completionDirectory}/${filename}`), rows[table] ?? []);
      }
      await this.writeCompletionFiles(context, staging, rows);
      await this.writeKnowledgeWikiProjection(staging, rows);
      await this.writeCollectionProjection(staging);
      const files = await hashBundleFiles(staging);
      const recordCounts = Object.fromEntries([
        ...tableFiles.map(([table]) => [portableCountKey(table), (rows[table] ?? []).length] as const),
        ...workspaceChatFiles.map(([table]) => [portableCountKey(table), (rows[table] ?? []).length] as const),
        ...workspaceRuntimeHistoryFiles.map(([table]) => [portableCountKey(table), (rows[table] ?? []).length] as const),
        ...workspaceIdentityFiles.map(([table]) => [portableCountKey(table), (identityRows[table] ?? []).length] as const),
        ...workspaceHumanWorkAllFiles.map(([table]) => [portableCountKey(table), (rows[table] ?? []).length] as const)
      ]);
      const baseProvenance = base.manifest as typeof base.manifest & WorkspaceBundleV3Provenance;
      // A legacy V3 manifest's schema_version is only a compatibility label;
      // promote it to the explicit revision when it is available. Source
      // Organization provenance is intentionally not copied into V4: the
      // portable bundle must not reveal or inherit the source affiliation.
      const schemaRevision = baseProvenance.schema_revision
        ?? baseProvenance.schema_version;
      const manifest = {
        format_version: 4,
        workspace_id: context.workspaceId,
        exported_at: new Date().toISOString(),
        ...(schemaRevision !== undefined ? { schema_revision: schemaRevision, schema_version: schemaRevision } : {}),
        ...(input.transferId ? { transfer_id: input.transferId } : {}),
        base_v3_integrity_hash: base.manifest.integrity_hash,
        excluded_maintenance_account_ids: maintenanceAccountIds.sort(),
        files,
        record_counts: recordCounts,
        integrity_hash: ""
      } satisfies WorkspaceBundleV4Manifest;
      manifest.integrity_hash = hashText(canonicalJson(bundleV4IntegrityPayload(manifest)));
      await writeFile(path.join(staging, manifestName), canonicalJson(manifest), { flag: "wx", mode: 0o600 });
      await rename(staging, destination);
      const verified = await verifyWorkspaceBundleV4(destination);
      const ledgerBundleId = await this.recordV4Ledger(context, bundleId, destination, verified.manifest);
      await this.store.database.withContext(context, async (sql) => {
        await this.store.insertAudit(sql, context, { action: "workspace.bundle.v4.export", subjectKind: "workspace_bundle_v4", subjectId: verified.manifest.integrity_hash, details: { record_counts: verified.manifest.record_counts, bundle_id: ledgerBundleId } });
      });
      return verified;
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  /** Starts the owner-controlled read-only transfer using the V4 exporter. */
  async beginTransfer(context: WorkspaceRequestContext, destination: string): Promise<ExportWorkspaceBundleV4Result & { transferId: string }> {
    await this.assertOwner(context);
    const transferId = context.operationId;
    const requestedDestination = path.resolve(destination);
    const previousTransfer = await readWorkspaceTransfer(this.store, context, transferId).catch((error) => {
      if (error instanceof WorkspaceServerError && error.code === "workspace_transfer_not_found") return undefined;
      throw error;
    });
    const retryingTerminalTransfer = previousTransfer?.state === "failed" || previousTransfer?.state === "rolled_back";
    const begun = await this.store.runTransferIdempotent(context, {
      action: "workspace.transfer.begin",
      input: { transferId, destination: requestedDestination }
    }, async (sql) => {
      await sql.query("SELECT samurai_begin_workspace_transfer($1, $2)", [context.workspaceId, transferId]);
      await this.store.insertAudit(sql, context, {
        action: "workspace.transfer.begin",
        subjectKind: "workspace_transfer",
        subjectId: transferId,
        details: { destination: "portable_bundle_v4" }
      });
      return { transferId };
    });
    if (begun.transferId !== transferId) throw new WorkspaceServerError("workspace_transfer_not_ready", 409);
    return runExclusiveWorkspaceTransferExport(canonicalJson([context.workspaceId, transferId]), async () => {
      const transfer = await readWorkspaceTransfer(this.store, context, transferId);
      if (transfer.state === "exported" && transfer.bundlePath) {
        const verified = await verifyWorkspaceBundleV4(transfer.bundlePath);
        if (verified.manifest.transfer_id !== transferId) throw new WorkspaceServerError("workspace_transfer_bundle_mismatch", 409);
        return { ...verified, transferId };
      }
      if (transfer.state === "failed" || transfer.state === "rolled_back") {
        throw new WorkspaceServerError("workspace_transfer_not_ready", 409);
      }
      const exportDestination = retryingTerminalTransfer && (previousTransfer?.bundlePath || await pathExists(requestedDestination))
        ? workspaceTransferRetryDestination(requestedDestination, transfer.version)
        : requestedDestination;
      try {
        const exported = await this.export(context, { destination: exportDestination, transferId });
        return { ...exported, transferId };
      } catch (error) {
        const resumed = await readWorkspaceTransfer(this.store, context, transferId).catch(() => undefined);
        if (resumed?.state === "exported" && resumed.bundlePath) {
          const verified = await verifyWorkspaceBundleV4(resumed.bundlePath);
          if (verified.manifest.transfer_id !== transferId) throw new WorkspaceServerError("workspace_transfer_bundle_mismatch", 409);
          return { ...verified, transferId };
        }
        await this.store.database.withContext(context, async (sql) => {
          await sql.query("SELECT samurai_fail_workspace_transfer($1, $2, $3)", [
            context.workspaceId,
            transferId,
            error instanceof Error ? error.message.slice(0, 256) : "workspace_bundle_export_failed"
          ]);
          await this.store.insertAudit(sql, context, {
            action: "workspace.transfer.export",
            outcome: "failed",
            subjectKind: "workspace_transfer",
            subjectId: transferId,
            details: { code: error instanceof Error ? error.message.slice(0, 128) : "workspace_bundle_export_failed" }
          });
        }).catch(() => undefined);
        throw error;
      }
    });
  }

  async rollbackTransfer(context: WorkspaceRequestContext, transferId: string): Promise<void> {
    assertOpaqueId(transferId, "workspace_transfer_id_invalid");
    await this.assertOwner(context);
    await this.store.runTransferIdempotent(context, { action: "workspace.transfer.rollback", input: { transferId } }, async (sql) => {
      await sql.query("SELECT samurai_rollback_workspace_transfer($1, $2)", [context.workspaceId, transferId]);
      await this.store.insertAudit(sql, context, { action: "workspace.transfer.rollback", subjectKind: "workspace_transfer", subjectId: transferId });
    });
  }

  async completeTransfer(context: WorkspaceRequestContext, transferId: string): Promise<void> {
    assertOpaqueId(transferId, "workspace_transfer_id_invalid");
    await this.assertOwner(context);
    await this.store.runTransferIdempotent(context, { action: "workspace.transfer.complete", input: { transferId } }, async (sql) => {
      await sql.query("SELECT samurai_complete_workspace_transfer($1, $2)", [context.workspaceId, transferId]);
      await this.store.insertAudit(sql, context, { action: "workspace.transfer.complete", subjectKind: "workspace_transfer", subjectId: transferId });
    });
  }

  async recordTransferReceipt(context: WorkspaceRequestContext, input: {
    transferId: string;
    targetWorkspaceId: string;
    receipt: WorkspaceTransferReceipt;
  }): Promise<void> {
    assertOpaqueId(input.transferId, "workspace_transfer_id_invalid");
    assertOpaqueId(input.targetWorkspaceId, "workspace_id_invalid");
    await this.assertOwner(context);
    await this.store.runTransferIdempotent(context, {
      action: "workspace.transfer.receipt",
      input: { transferId: input.transferId, targetWorkspaceId: input.targetWorkspaceId, receipt: input.receipt }
    }, async (sql) => {
      await sql.query("SELECT samurai_record_workspace_transfer_receipt($1, $2, $3, $4::JSONB)", [
        context.workspaceId,
        input.transferId,
        input.targetWorkspaceId,
        canonicalJson(input.receipt)
      ]);
      await this.store.insertAudit(sql, context, {
        action: "workspace.transfer.receipt",
        subjectKind: "workspace_transfer",
        subjectId: input.transferId,
        details: { target_workspace_id: input.targetWorkspaceId }
      });
    });
  }

  async getTransferBundle(
    context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">,
    transferId: string
  ): Promise<{ directory: string; manifest: WorkspaceBundleV4Manifest }> {
    assertOpaqueId(transferId, "workspace_transfer_id_invalid");
    await this.assertOwner(context);
    const transfer = await readWorkspaceTransfer(this.store, context, transferId);
    if (transfer.state !== "exported" || !transfer.bundlePath) throw new WorkspaceServerError("workspace_transfer_not_ready", 409);
    const verified = await verifyWorkspaceBundleV4(transfer.bundlePath);
    if (verified.manifest.transfer_id !== transferId) throw new WorkspaceServerError("workspace_transfer_bundle_mismatch", 409);
    return { directory: verified.directory, manifest: verified.manifest };
  }

  async getTransferEntry(
    context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">,
    transferId: string,
    entryPath: string
  ): Promise<{ content: Buffer; contentType: string }> {
    const transfer = await this.getTransferBundle(context, transferId);
    assertSafeRelativePath(entryPath);
    const expectedHash = transfer.manifest.files[entryPath];
    if (!expectedHash) throw new WorkspaceServerError("workspace_bundle_v4_entry_not_found", 404);
    const content = await readFile(resolveBundlePath(transfer.directory, entryPath));
    if (hashBytes(content) !== expectedHash) throw new WorkspaceServerError("workspace_bundle_v4_hash_mismatch", 409);
    return { content, contentType: entryPath.endsWith(".json") || entryPath.endsWith(".jsonl") ? "application/json" : "application/octet-stream" };
  }

  /** Restores the v3 core first, then imports the verified completion rows and
   * their staged file batches. PostgreSQL constraints validate every relation
   * before any completion body is renamed into the active file tree. */
  async importNew(context: Pick<WorkspaceRequestContext, "accountId" | "operationId">, input: { sourceDirectory: string; targetWorkspaceId: string; targetWorkspaceName?: string; targetOrganizationId?: string }): Promise<{ workspaceId: string; manifest: WorkspaceBundleV4Manifest; receipt?: WorkspaceTransferReceipt }> {
    assertOpaqueId(input.targetWorkspaceId, "workspace_id_invalid");
    const targetOrganizationId = optionalWorkspaceBundleTargetOrganizationId(input.targetOrganizationId);
    const source = await verifyWorkspaceBundleV4(input.sourceDirectory);
    const imported = await this.v3.importNew(context, {
      sourceDirectory: path.join(source.directory, baseV3Directory), targetWorkspaceId: input.targetWorkspaceId,
      ...(input.targetWorkspaceName ? { targetWorkspaceName: input.targetWorkspaceName } : {}),
      ...(targetOrganizationId ? { targetOrganizationId } : {}),
      beforeActivate: async (targetContext) => {
        await this.importCompletionExtension(targetContext, source);
        // Validate this while V3 still owns a read-only import session. Any
        // failure can then use the same abort path to remove DB and storage.
        await this.assertNoMaintenanceMembership(targetContext, source.manifest.excluded_maintenance_account_ids);
      }
    });
    // v3 can idempotently return an already-active Workspace. That is only a
    // valid v4 retry when its Completion extension was activated in the same
    // restore; never claim a Core-only target is a complete v4 restore.
    const receiptId = completionId("completion_receipt", input.targetWorkspaceId, source.manifest.integrity_hash);
    const extension = await this.store.database.withContext({ workspaceId: input.targetWorkspaceId, accountId: context.accountId }, async (sql) =>
      sql.query<{ id: string }>(
        "SELECT id FROM workspace_completion_migration_receipts WHERE workspace_id = $1 AND id = $2 AND integrity_hash = $3 AND status = 'switched'",
        [input.targetWorkspaceId, receiptId, source.manifest.integrity_hash]
      )
    );
    if (!extension.rows[0]) throw new WorkspaceServerError("workspace_bundle_v4_extension_missing", 409);
    await this.assertNoMaintenanceMembership(
      { workspaceId: input.targetWorkspaceId, accountId: context.accountId },
      source.manifest.excluded_maintenance_account_ids
    );
    // V3 restores the embedded core and therefore returns the base-v3 hash in
    // its receipt. A V4 transfer is recorded against the outer manifest hash,
    // so the receipt sent back to the source must prove the complete V4
    // Bundle. Keep the V3 value only for legacy callers that do not carry a
    // transfer id.
    const receipt = source.manifest.transfer_id
      ? transferReceipt(source.manifest, input.targetWorkspaceId)
      : imported.receipt;
    return {
      workspaceId: imported.workspaceId,
      manifest: source.manifest,
      ...(receipt ? { receipt } : {})
    };
  }

  /**
   * Starts the same V4 import protocol used by the one-shot HTTP transport,
   * but stores entries incrementally so a large Bundle is never held in one
   * request body. The staging directory is not a Workspace and is not passed
   * to PostgreSQL until completeIncomingBundle verifies every hash.
   */
  async stageIncomingBundle(
    context: Pick<WorkspaceRequestContext, "accountId" | "operationId">,
    input: StageWorkspaceBundleV4Input
  ): Promise<void> {
    assertOpaqueId(context.accountId, "account_id_invalid");
    assertOpaqueId(context.operationId, "workspace_operation_id_invalid");
    assertOpaqueId(input.targetWorkspaceId, "workspace_id_invalid");
    assertWorkspaceBundleV4ManifestCandidate(input.manifest);
    const targetOrganizationId = optionalWorkspaceBundleTargetOrganizationId(input.targetOrganizationId);
    const createdAt = new Date();
    const manifestText = canonicalJson(input.manifest);
    if (Buffer.byteLength(manifestText, "utf8") > WORKSPACE_BUNDLE_MAX_BYTES) throw new WorkspaceServerError("workspace_bundle_v4_transport_too_large", 413);
    const root = this.incomingRoot(context);
    const metadata: IncomingV4BundleMetadata = {
      format_version: 1,
      bundle_format: 4,
      account_id: context.accountId,
      operation_id: context.operationId,
      target_workspace_id: input.targetWorkspaceId,
      ...(input.targetWorkspaceName?.trim() ? { target_workspace_name: input.targetWorkspaceName.trim().slice(0, 500) } : {}),
      ...(targetOrganizationId ? { target_organization_id: targetOrganizationId } : {}),
      manifest: input.manifest,
      created_at: createdAt.toISOString(),
      expires_at: new Date(createdAt.getTime() + WORKSPACE_BUNDLE_INCOMING_TTL_MS).toISOString(),
      received_bytes: Buffer.byteLength(manifestText, "utf8"),
      received_entries: 0
    };
    const metadataPath = this.incomingMetadataPath(context);
    if (await pathExists(metadataPath)) {
      const existing = await this.readIncomingMetadata(context);
      if (canonicalJson(incomingV4Request(existing)) !== canonicalJson(incomingV4Request(metadata))) {
        throw new WorkspaceServerError("workspace_import_staging_conflict", 409);
      }
      return;
    }
    let createdRoot = false;
    let wroteMetadata = false;
    try {
      await mkdir(path.dirname(root), { recursive: true, mode: 0o700 });
      await mkdir(root, { recursive: false, mode: 0o700 });
      createdRoot = true;
      await writeFile(path.join(root, manifestName), canonicalJson(input.manifest), { flag: "wx", mode: 0o600 });
      await this.writeIncomingMetadata(context, metadata, false);
      wroteMetadata = true;
    } catch (error) {
      if (createdRoot) await rm(root, { recursive: true, force: true }).catch(() => undefined);
      if (wroteMetadata) await rm(metadataPath, { force: true }).catch(() => undefined);
      if (!await pathExists(metadataPath)) throw error;
      const existing = await this.readIncomingMetadata(context);
      if (canonicalJson(incomingV4Request(existing)) !== canonicalJson(incomingV4Request(metadata))) {
        throw new WorkspaceServerError("workspace_import_staging_conflict", 409);
      }
    }
  }

  async hasIncomingBundle(context: Pick<WorkspaceRequestContext, "accountId" | "operationId">): Promise<boolean> {
    return pathExists(this.incomingMetadataPath(context));
  }

  async putIncomingBundleEntry(
    context: Pick<WorkspaceRequestContext, "accountId" | "operationId">,
    entryPath: string,
    content: Uint8Array
  ): Promise<void> {
    return runExclusiveWorkspaceBundleStaging(canonicalJson([context.accountId, context.operationId]), async () => {
      const metadata = await this.readIncomingMetadata(context);
      if (metadata.completed) throw new WorkspaceServerError("workspace_import_staging_completed", 409);
      assertSafeRelativePath(entryPath);
      const expectedHash = metadata.manifest.files[entryPath];
      if (!expectedHash) throw new WorkspaceServerError("workspace_bundle_v4_entry_not_found", 404);
      if (content.byteLength > WORKSPACE_BUNDLE_MAX_ENTRY_BYTES) throw new WorkspaceServerError("workspace_bundle_v4_entry_too_large", 413);
      if (hashBytes(content) !== expectedHash) throw new WorkspaceServerError("workspace_bundle_v4_hash_mismatch", 400);
      const destination = resolveBundlePath(this.incomingRoot(context), entryPath);
      if (await pathExists(destination)) {
        const existing = await readFile(destination);
        if (hashBytes(existing) !== expectedHash) throw new WorkspaceServerError("workspace_import_staging_conflict", 409);
        return;
      }
      const usage = await measureBundleUsage(this.incomingRoot(context));
      if (usage.entries >= WORKSPACE_BUNDLE_MAX_ENTRIES || usage.bytes + content.byteLength > WORKSPACE_BUNDLE_MAX_BYTES) {
        throw new WorkspaceServerError("workspace_bundle_v4_transport_too_large", 413);
      }
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      let wrote = false;
      try {
        await writeFile(destination, content, { flag: "wx", mode: 0o600 });
        wrote = true;
        const nextUsage = await measureBundleUsage(this.incomingRoot(context));
        assertBundleUsage(nextUsage, "workspace_bundle_v4_transport_too_large");
        await this.writeIncomingMetadata(context, {
          ...metadata,
          received_bytes: nextUsage.bytes,
          received_entries: nextUsage.entries
        }, true);
      } catch (error) {
        if (wrote) await rm(destination, { force: true }).catch(() => undefined);
        throw error;
      }
    });
  }

  async completeIncomingBundle(context: Pick<WorkspaceRequestContext, "accountId" | "operationId">): Promise<{
    workspaceId: string;
    manifest: WorkspaceBundleV4Manifest;
    receipt?: WorkspaceTransferReceipt;
  }> {
    const metadata = await this.readIncomingMetadata(context);
    if (metadata.completed) {
      return {
        workspaceId: metadata.completed.workspace_id,
        manifest: metadata.completed.manifest,
        ...(metadata.completed.receipt ? { receipt: metadata.completed.receipt } : {})
      };
    }
    const root = this.incomingRoot(context);
    await verifyWorkspaceBundleV4(root);
    const imported = await this.importNew(context, {
      sourceDirectory: root,
      targetWorkspaceId: metadata.target_workspace_id,
      ...(metadata.target_workspace_name ? { targetWorkspaceName: metadata.target_workspace_name } : {}),
      targetOrganizationId: metadata.target_organization_id
    });
    await this.writeIncomingMetadata(context, {
      ...metadata,
      completed: {
        workspace_id: imported.workspaceId,
        manifest: imported.manifest,
        ...(imported.receipt ? { receipt: imported.receipt } : {}),
        completed_at: new Date().toISOString()
      }
    }, true);
    await rm(root, { recursive: true, force: true });
    return imported;
  }

  private incomingRoot(context: Pick<WorkspaceRequestContext, "accountId" | "operationId">): string {
    assertOpaqueId(context.accountId, "account_id_invalid");
    assertOpaqueId(context.operationId, "workspace_operation_id_invalid");
    return path.join(this.store.storageRoot, ".incoming-v4", context.accountId, context.operationId);
  }

  private incomingMetadataPath(context: Pick<WorkspaceRequestContext, "accountId" | "operationId">): string {
    return `${this.incomingRoot(context)}.json`;
  }

  private async readIncomingMetadata(context: Pick<WorkspaceRequestContext, "accountId" | "operationId">): Promise<IncomingV4BundleMetadata> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.incomingMetadataPath(context), "utf8"));
    } catch {
      throw new WorkspaceServerError("workspace_import_staging_not_found", 404);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new WorkspaceServerError("workspace_import_staging_invalid", 400);
    const metadata = parsed as Partial<IncomingV4BundleMetadata>;
    if (metadata.format_version !== 1 || metadata.bundle_format !== 4 || metadata.account_id !== context.accountId
      || metadata.operation_id !== context.operationId || typeof metadata.target_workspace_id !== "string" || !metadata.manifest) {
      throw new WorkspaceServerError("workspace_import_staging_invalid", 400);
    }
    assertOpaqueId(metadata.target_workspace_id, "workspace_id_invalid");
    if (metadata.target_organization_id !== undefined) {
      assertWorkspaceBundleTargetOrganizationId(metadata.target_organization_id);
    }
    assertWorkspaceBundleV4ManifestCandidate(metadata.manifest);
    if (metadata.created_at !== undefined && !isValidTimestamp(metadata.created_at)) throw new WorkspaceServerError("workspace_import_staging_invalid", 400);
    if (metadata.expires_at !== undefined && !isValidTimestamp(metadata.expires_at)) throw new WorkspaceServerError("workspace_import_staging_invalid", 400);
    if (metadata.received_bytes !== undefined && (!Number.isSafeInteger(metadata.received_bytes) || metadata.received_bytes < 0 || metadata.received_bytes > WORKSPACE_BUNDLE_MAX_BYTES)) {
      throw new WorkspaceServerError("workspace_import_staging_invalid", 400);
    }
    if (metadata.received_entries !== undefined && (!Number.isSafeInteger(metadata.received_entries) || metadata.received_entries < 0 || metadata.received_entries > WORKSPACE_BUNDLE_MAX_ENTRIES)) {
      throw new WorkspaceServerError("workspace_import_staging_invalid", 400);
    }
    if (!metadata.completed && await incomingV4BundleExpired(this.incomingMetadataPath(context), metadata)) {
      await Promise.all([
        rm(this.incomingRoot(context), { recursive: true, force: true }),
        rm(this.incomingMetadataPath(context), { force: true })
      ]);
      throw new WorkspaceServerError("workspace_import_staging_expired", 410);
    }
    return metadata as IncomingV4BundleMetadata;
  }

  private async writeIncomingMetadata(
    context: Pick<WorkspaceRequestContext, "accountId" | "operationId">,
    metadata: IncomingV4BundleMetadata,
    overwrite: boolean
  ): Promise<void> {
    const target = this.incomingMetadataPath(context);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    if (!overwrite) {
      await writeFile(target, canonicalJson(metadata), { flag: "wx", mode: 0o600 });
      return;
    }
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, canonicalJson(metadata), { flag: "wx", mode: 0o600 });
    await rename(temporary, target);
  }

  private async readCompletionRows(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">): Promise<Record<string, Record<string, unknown>[]>> {
    return this.store.database.withReadSnapshot(context, async (sql) => {
      const values: Record<string, Record<string, unknown>[]> = {};
      for (const [table] of tableFiles) {
        const result = await sql.query<Record<string, unknown>>(`SELECT * FROM ${table} WHERE workspace_id = $1`, [context.workspaceId]);
        values[table] = result.rows.map((row) => portableRuntimeRow(table, row));
      }
      for (const [table] of workspaceChatFiles) {
        const result = await sql.query<Record<string, unknown>>(`SELECT * FROM ${table} WHERE workspace_id = $1`, [context.workspaceId]);
        values[table] = result.rows.map((row) => portableRuntimeRow(table, row));
      }
      for (const [table] of workspaceRuntimeHistoryFiles) {
        const result = await sql.query<Record<string, unknown>>(`SELECT * FROM ${table} WHERE workspace_id = $1`, [context.workspaceId]);
        values[table] = result.rows.map((row) => portableRuntimeRow(table, row));
      }
      for (const [table] of workspaceHumanWorkAllFiles) {
        const select = table === "workspace_human_work_instructions"
          ? `SELECT workspace_id, id, work_id, assignment_id, room_id, version, body,
                    samurai_project_human_work_attachment_refs(workspace_id, room_id, attachment_refs) AS attachment_refs,
                    resource_refs,
                    source_kind, source_comment_id, source_comment_version, state, created_by, created_at
             FROM ${table} WHERE workspace_id = $1`
          : table === "workspace_human_work_comments"
            ? `SELECT workspace_id, id, work_id, room_id, author_account_id, version, body,
                      samurai_project_human_work_attachment_refs(workspace_id, room_id, attachment_refs) AS attachment_refs,
                      created_at
               FROM ${table} WHERE workspace_id = $1`
            : `SELECT * FROM ${table} WHERE workspace_id = $1`;
        const result = await sql.query<Record<string, unknown>>(select, [context.workspaceId]);
        values[table] = result.rows.map((row) => portableRuntimeRow(table, row));
      }
      return values;
    });
  }

  private async readWorkspaceIdentityRows(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">): Promise<Record<string, Record<string, unknown>[]>> {
    return this.store.database.withReadSnapshot(context, async (sql) => {
      const agents = await sql.query<Record<string, unknown>>(
        `SELECT workspace_id, id, display_name, description, role, instructions, backend_id, enabled, status, version,
                created_by, created_at, updated_at
         FROM workspace_agents WHERE workspace_id = $1 ORDER BY id`,
        [context.workspaceId]
      );
      const permissions = await sql.query<Record<string, unknown>>(
        `SELECT permission.workspace_id, permission.room_id, permission.agent_id,
                permission.can_view, permission.can_edit, permission.can_execute, permission.version,
                permission.created_by, permission.created_at, permission.updated_at
         FROM workspace_agent_room_permissions AS permission
         JOIN rooms AS room ON room.workspace_id = permission.workspace_id AND room.id = permission.room_id
         WHERE permission.workspace_id = $1
           AND (room.room_kind <> 'agent_dm' OR room.default_agent_id = permission.agent_id)
         ORDER BY permission.room_id, permission.agent_id`,
        [context.workspaceId]
      );
      const connections = await sql.query<Record<string, unknown>>(
        `SELECT workspace_id, id, agent_id, principal_account_id, connector_id, app_id, status,
                expires_at, revoked_at, allowed_room_ids, room_limit, ingress_classes, version,
                created_by, created_at, updated_at
         FROM workspace_connection_descriptors WHERE workspace_id = $1 ORDER BY id`,
        [context.workspaceId]
      );
      return {
        workspace_agents: agents.rows.map(portableRow),
        workspace_agent_room_permissions: permissions.rows.map(portableRow),
        workspace_connection_descriptors: connections.rows.map((row) => portableConnectionDescriptorRow(portableRow(row)))
      };
    });
  }

  private async writeCompletionFiles(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, root: string, rows: Record<string, Record<string, unknown>[]>): Promise<void> {
    const paths = new Map<string, string>();
    for (const row of rows.workspace_completion_resource_versions ?? []) {
      const relative = stringValue(row.file_path, "workspace_bundle_v4_file_path_invalid");
      const hash = stringValue(row.content_hash, "workspace_bundle_v4_file_hash_invalid");
      rememberFile(paths, relative, hash);
    }
    for (const row of rows.workspace_completion_workspace_documents ?? []) {
      const relative = stringValue(row.file_path, "workspace_bundle_v4_file_path_invalid");
      const hash = stringValue(row.content_hash, "workspace_bundle_v4_file_hash_invalid");
      rememberFile(paths, relative, hash);
    }
    for (const row of rows.workspace_completion_skill_files ?? []) {
      const relative = stringValue(row.file_path, "workspace_bundle_v4_file_path_invalid");
      const hash = stringValue(row.content_hash, "workspace_bundle_v4_file_hash_invalid");
      rememberFile(paths, relative, hash);
    }
    for (const [relative, hash] of paths) {
      const content = await this.files.read(context.workspaceId, relative, hash);
      assertCredentialFree(`completion/files/${relative}`, content);
      const destination = resolveBundlePath(root, `${completionDirectory}/files/${relative}`);
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await writeFile(destination, content, { flag: "wx", mode: 0o600 });
    }
  }

  /**
   * Wiki pages remain the Completion files themselves. These files are a
   * portable, human-readable index so a Bundle can be inspected without
   * knowing the database table layout; restore uses the underlying Resource
   * and file rows and regenerates this projection on the next export.
   */
  private async writeKnowledgeWikiProjection(root: string, rows: Record<string, Record<string, unknown>[]>): Promise<void> {
    const resources = rows.workspace_completion_resources ?? [];
    const versions = rows.workspace_completion_resource_versions ?? [];
    const currentVersions = new Map<string, Record<string, unknown>>();
    for (const resource of resources) {
      if (resource.resource_kind !== "knowledge") continue;
      const version = numberValue(resource.current_confirmed_version ?? resource.current_provisional_version);
      if (version === undefined) continue;
      const current = versions.find((candidate) => candidate.resource_id === resource.id && numberValue(candidate.version) === version);
      if (!current || !isWikiMetadata(recordValue(current.metadata))) continue;
      currentVersions.set(String(resource.id), current);
    }

    const indexLines = [
      "# Knowledge Wiki",
      "",
      "この一覧はBundleから再生成できるKnowledge Wikiの派生インデックスです。",
      "ページ本文の正本は `completion/files/` 内のCompletion Resourceです。",
      ""
    ];
    for (const resource of resources
      .filter((candidate) => typeof candidate.id === "string" && currentVersions.has(candidate.id))
      .sort((left, right) => String(left.id).localeCompare(String(right.id)))) {
      const resourceId = String(resource.id);
      const version = currentVersions.get(resourceId)!;
      const metadata = recordValue(version.metadata);
      const slug = typeof metadata.slug === "string" ? metadata.slug : String(resource.title ?? resource.id);
      const room = resource.scope_kind === "room" ? String(resource.room_id ?? "") : "workspace";
      const pagePath = `pages/${safeProjectionId(resourceId)}.md`;
      const contentPath = String(version.file_path ?? "");
      const content = (await readFile(resolveBundlePath(root, `${completionDirectory}/files/${contentPath}`))).toString("utf8");
      indexLines.push(`- [${markdownLabel(String(resource.title ?? resource.id))}](${pagePath})`);
      indexLines.push(`  - id: ${resourceId}`);
      indexLines.push(`  - room: ${room}`);
      indexLines.push(`  - slug: ${markdownLabel(slug)}`);
      indexLines.push(`  - content: completion/files/${contentPath}`);
      const links = wikiProjectionLinks(content);
      if (links.length > 0) indexLines.push(`  - links: ${links.map((link) => `[[${link}]]`).join(", ")}`);
      indexLines.push("");
      const pageDestination = resolveBundlePath(root, `${completionDirectory}/knowledge-wiki/${pagePath}`);
      await mkdir(path.dirname(pageDestination), { recursive: true, mode: 0o700 });
      await writeFile(pageDestination, content, { flag: "wx", mode: 0o600 });
    }
    const indexDestination = resolveBundlePath(root, `${completionDirectory}/knowledge-wiki/index.md`);
    await mkdir(path.dirname(indexDestination), { recursive: true, mode: 0o700 });
    await writeFile(indexDestination, `${indexLines.join("\n")}\n`, { flag: "wx", mode: 0o600 });
  }

  /** V3 already carries the canonical Collection Markdown files. This small
   * index makes that fact explicit in V4 while keeping no duplicate copy of
   * the editable definitions. */
  private async writeCollectionProjection(root: string): Promise<void> {
    const baseRoot = resolveBundlePath(root, baseV3Directory);
    const collectionFiles: string[] = [];
    try {
      for await (const relative of walkFiles(baseRoot, "files/collections")) {
        if (relative.endsWith(".md")) collectionFiles.push(relative.slice("files/".length));
      }
    } catch (error) {
      if (!(error as NodeJS.ErrnoException).code || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const lines = [
      "# Collections",
      "",
      "Collection定義と編集内容の正本は、V4の`base-v3/files/collections/`に含まれるMarkdownです。",
      ""
    ];
    for (const file of collectionFiles.sort()) lines.push(`- [${file}](../../base-v3/files/${file})`);
    const destination = resolveBundlePath(root, `${completionDirectory}/collections/index.md`);
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, `${lines.join("\n")}\n`, { flag: "wx", mode: 0o600 });
  }

  private async importCompletionExtension(context: WorkspaceRequestContext, source: { directory: string; manifest: WorkspaceBundleV4Manifest }): Promise<void> {
    const rows = await readCompletionBundleRows(source.directory, source.manifest.workspace_id);
    const receiptId = completionId("completion_receipt", context.workspaceId, source.manifest.integrity_hash);
    const existingReceipt = await this.store.database.withContext(context, async (sql) => sql.query<{ id: string }>(
      "SELECT id FROM workspace_completion_migration_receipts WHERE workspace_id = $1 AND id = $2 AND integrity_hash = $3 AND status = 'switched'",
      [context.workspaceId, receiptId, source.manifest.integrity_hash]
    ));
    if (existingReceipt.rows[0]) {
      await this.recoverImportedCommittedBatches(context, source.directory, rows);
      return;
    }
    const batches = await this.stageImportedBatches(context, source.directory, rows);
    let databaseCommitted = false;
    try {
      await this.store.database.withContext(context, async (sql) => {
        await sql.query("SET CONSTRAINTS ALL DEFERRED");
        // V3 creates Rooms before the V4 Agent extension. Agents must exist
        // before their default-Agent FK is restored, while DM Room settings
        // must be applied before specialist ACL rows are imported. The
        // identity importer therefore restores Agents, Room settings, then
        // only the still-effective ACL rows.
        await this.importWorkspaceIdentityRows(context, sql, rows, source.directory);
        const stagedIds = new Set(batches.map((batch) => batch.id));
        for (const header of rows.workspace_completion_file_batches ?? []) {
          const id = stringValue(header.id, "workspace_bundle_v4_batch_invalid");
          if (stagedIds.has(id)) {
            const scope = batchScopeFromPortableHeader(header);
            await sql.query(
              "INSERT INTO workspace_completion_file_batches(workspace_id, id, scope_kind, room_id, status) VALUES ($1, $2, $3, $4, 'db_committed')",
              [context.workspaceId, id, scope.kind, scope.roomId ?? null]
            );
          } else {
            if (header.status !== "rolled_back") throw new WorkspaceServerError("workspace_bundle_v4_batch_invalid", 400);
            await insertPortableStaticRow(sql, "workspace_completion_file_batches", { ...header, workspace_id: context.workspaceId });
          }
        }
        for (const entry of rows.workspace_completion_file_batch_entries ?? []) {
          await insertPortableStaticRow(sql, "workspace_completion_file_batch_entries", { ...entry, workspace_id: context.workspaceId });
        }
        for (const table of importTableOrder) {
          for (const row of rows[table] ?? []) {
            const restored = restorePortableRuntimeHistoryRow(table, row, context.workspaceId);
            await insertPortableRow(sql, table, { ...restored, workspace_id: context.workspaceId });
          }
        }
        await importWorkspaceHumanWorkRows(sql, context, prepareHumanWorkRowsForRestore(rows, context, source.manifest));
        await importWorkspaceLegacySessionRows(sql, context, rows);
        for (const row of rows.workspace_completion_migration_receipts ?? []) {
          await insertMigrationReceipt(sql, { ...row, workspace_id: context.workspaceId });
        }
        const counts = Object.fromEntries(Object.entries(rows).map(([name, values]) => [name, values.length]));
        await sql.query(
          `INSERT INTO workspace_completion_migration_receipts(workspace_id, id, source_format, target_format, counts, integrity_hash, status, created_by)
           VALUES ($1, $2, 'bundle_v4', 'workspace_completion', $3::JSONB, $4, 'switched', $5)`,
          [context.workspaceId, completionId("completion_receipt", context.workspaceId, source.manifest.integrity_hash), canonicalJson(counts), source.manifest.integrity_hash, context.accountId]
        );
      });
      databaseCommitted = true;
      for (const batch of batches) {
        await this.files.finalize(batch);
        await this.store.database.withContext(context, async (sql) => {
          await sql.query("UPDATE workspace_completion_file_batches SET status = 'renamed', updated_at = NOW() WHERE workspace_id = $1 AND id = $2", [context.workspaceId, batch.id]);
        });
      }
    } catch (error) {
      // Once the receipt transaction commits, db_committed headers plus the
      // stable receipt are the recovery ledger. Do not delete their staged
      // files: a later retry with the same transfer/import identity can finish
      // a partially-renamed batch via recoverImportedCommittedBatches. Before
      // commit, however, no DB row can authorize those files, so remove every
      // staged batch and surface cleanup errors instead of hiding them.
      if (!databaseCommitted) {
        const cleanupErrors = (await Promise.all(batches.map(async (batch) => {
          try {
            await this.files.rollback(batch);
            return undefined;
          } catch (cleanupError) {
            return cleanupError;
          }
        }))).filter((cleanupError): cleanupError is unknown => cleanupError !== undefined);
        if (cleanupErrors.length > 0) {
          throw new WorkspaceServerError("workspace_bundle_v4_cleanup_failed", 500, {
            primary_error_code: safeErrorCode(error),
            cleanup_error_code: safeErrorCode(cleanupErrors[0])
          });
        }
      }
      throw error;
    }
  }

  private async recoverImportedCommittedBatches(
    context: WorkspaceRequestContext,
    root: string,
    rows: Record<string, Record<string, unknown>[]>
  ): Promise<void> {
    const pending = await this.store.database.withContext(context, async (sql) => sql.query<{ id: string; scope_kind: string; room_id: string | null }>(
      "SELECT id, scope_kind, room_id FROM workspace_completion_file_batches WHERE workspace_id = $1 AND status = 'db_committed' ORDER BY id",
      [context.workspaceId]
    ));
    const entriesByBatch = new Map<string, Record<string, unknown>[]>();
    for (const row of rows.workspace_completion_file_batch_entries ?? []) {
      const batchId = stringValue(row.batch_id, "workspace_bundle_v4_batch_invalid");
      entriesByBatch.set(batchId, [...(entriesByBatch.get(batchId) ?? []), row]);
    }
    for (const batch of pending.rows) {
      const scope = batch.scope_kind === "workspace" && batch.room_id === null
        ? { kind: "workspace" as const }
        : batch.scope_kind === "room" && batch.room_id
          ? { kind: "room" as const, roomId: batch.room_id }
          : (() => { throw new WorkspaceServerError("workspace_bundle_v4_batch_scope_invalid", 400); })();
      const entries = (entriesByBatch.get(batch.id) ?? []).map((row) => {
        const relative = assertSafeRelativePath(stringValue(row.path, "workspace_bundle_v4_file_path_invalid"));
        const expectedHash = stringValue(row.sha256, "workspace_bundle_v4_file_hash_invalid");
        return { path: relative, expectedHash };
      });
      const resolved = await Promise.all(entries.map(async (entry) => ({
        path: entry.path,
        content: await readFile(resolveBundlePath(root, `${completionDirectory}/files/${entry.path}`)),
        sha256: entry.expectedHash
      })));
      if (resolved.length === 0) throw new WorkspaceServerError("workspace_bundle_v4_batch_entries_missing", 400);
      if (resolved.some((entry) => hashBytes(entry.content) !== entry.sha256)) throw new WorkspaceServerError("workspace_bundle_v4_hash_mismatch", 400);
      await this.files.recover({ workspaceId: context.workspaceId, id: batch.id, scope, entries: resolved });
      await this.store.database.withContext(context, async (sql) => {
        await sql.query("UPDATE workspace_completion_file_batches SET status = 'renamed', updated_at = NOW() WHERE workspace_id = $1 AND id = $2 AND status = 'db_committed'", [context.workspaceId, batch.id]);
      });
    }
  }

  private async importWorkspaceIdentityRows(
    context: WorkspaceRequestContext,
    sql: WorkspaceSql,
    rows: Record<string, Record<string, unknown>[]>,
    baseRoot: string
  ): Promise<void> {
    for (const row of rows.workspace_agents ?? []) {
      await importWorkspaceAgentRow(context, sql, row);
    }
    await this.importWorkspaceRoomSettings(context, sql, baseRoot);
    for (const row of rows.workspace_agent_room_permissions ?? []) {
      await sql.query(
        "SELECT samurai_import_workspace_agent_room_permission($1, $2, $3, $4, $5, $6, $7, $8, $9::TIMESTAMPTZ, $10::TIMESTAMPTZ)",
        [
          context.workspaceId,
          stringValue(row.room_id, "workspace_bundle_agent_permission_room_invalid"),
          stringValue(row.agent_id, "workspace_bundle_agent_permission_agent_invalid"),
          booleanValue(row.can_view, "workspace_bundle_agent_permission_view_invalid"),
          booleanValue(row.can_edit, "workspace_bundle_agent_permission_edit_invalid"),
          booleanValue(row.can_execute, "workspace_bundle_agent_permission_execute_invalid"),
          integerValue(row.version, "workspace_bundle_agent_permission_version_invalid"),
          stringValue(row.created_by, "workspace_bundle_agent_permission_created_by_invalid"),
          timestampValue(row.created_at, "workspace_bundle_agent_permission_created_at_invalid"),
          timestampValue(row.updated_at, "workspace_bundle_agent_permission_updated_at_invalid")
        ]
      );
    }
    for (const row of rows.workspace_connection_descriptors ?? []) {
      await sql.query(
        "SELECT samurai_import_workspace_connection_descriptor($1, $2, $3, $4, $5, $6, $7, $8::TIMESTAMPTZ, $9::TIMESTAMPTZ, $10::TEXT[], $11, $12::TEXT[], $13, $14, $15::TIMESTAMPTZ, $16::TIMESTAMPTZ)",
        [
          context.workspaceId,
          stringValue(row.id, "workspace_bundle_connection_id_invalid"),
          nullableStringValue(row.agent_id, "workspace_bundle_connection_agent_invalid"),
          stringValue(row.principal_account_id, "workspace_bundle_connection_principal_invalid"),
          stringValue(row.connector_id, "workspace_bundle_connection_connector_invalid"),
          stringValue(row.app_id, "workspace_bundle_connection_app_invalid"),
          stringValue(row.status, "workspace_bundle_connection_status_invalid"),
          timestampValue(row.expires_at, "workspace_bundle_connection_expires_at_invalid"),
          nullableTimestampValue(row.revoked_at, "workspace_bundle_connection_revoked_at_invalid"),
          stringArrayValue(row.allowed_room_ids, "workspace_bundle_connection_rooms_invalid"),
          integerValue(row.room_limit, "workspace_bundle_connection_room_limit_invalid"),
          stringArrayValue(row.ingress_classes, "workspace_bundle_connection_ingress_invalid"),
          integerValue(row.version, "workspace_bundle_connection_version_invalid"),
          stringValue(row.created_by, "workspace_bundle_connection_created_by_invalid"),
          timestampValue(row.created_at, "workspace_bundle_connection_created_at_invalid"),
          timestampValue(row.updated_at, "workspace_bundle_connection_updated_at_invalid")
        ]
      );
    }
  }

  private async importWorkspaceRoomSettings(
    context: WorkspaceRequestContext,
    sql: WorkspaceSql,
    baseRoot: string
  ): Promise<void> {
    const rooms = await readJsonl(resolveBundlePath(baseRoot, `${baseV3Directory}/rooms.jsonl`));
    for (const row of rooms) {
      const hasV4RoomSettings = row.room_kind === "agent_dm"
        || row.default_agent_id !== undefined && row.default_agent_id !== null && row.default_agent_id !== ""
        || row.default_agent_version !== undefined && row.default_agent_version !== null && row.default_agent_version !== ""
        || row.dm_account_id !== undefined && row.dm_account_id !== null && row.dm_account_id !== "";
      if (!hasV4RoomSettings) continue;
      const roomKind = row.room_kind === undefined || row.room_kind === null ? "normal" : stringValue(row.room_kind, "workspace_bundle_room_kind_invalid");
      const defaultAgentId = nullableStringValue(row.default_agent_id, "workspace_bundle_room_default_agent_invalid");
      const defaultAgentVersion = row.default_agent_version === undefined || row.default_agent_version === null || row.default_agent_version === ""
        ? null
        : integerValue(row.default_agent_version, "workspace_bundle_room_default_agent_version_invalid");
      await sql.query(
        "SELECT samurai_import_workspace_room_v2($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::TIMESTAMPTZ, $12::TIMESTAMPTZ)",
        [
          context.workspaceId,
          stringValue(row.id, "workspace_bundle_room_id_invalid"),
          nullableStringValue(row.parent_room_id, "workspace_bundle_room_parent_invalid"),
          stringValue(row.name, "workspace_bundle_room_name_invalid"),
          roomKind,
          nullableStringValue(row.dm_account_id, "workspace_bundle_room_dm_account_invalid"),
          defaultAgentId,
          defaultAgentVersion,
          integerValue(row.version, "workspace_bundle_room_version_invalid"),
          stringValue(row.created_by, "workspace_bundle_room_created_by_invalid"),
          timestampValue(row.created_at, "workspace_bundle_room_created_at_invalid"),
          timestampValue(row.updated_at, "workspace_bundle_room_updated_at_invalid")
        ]
      );
    }
  }

  private async stageImportedBatches(context: WorkspaceRequestContext, root: string, rows: Record<string, Record<string, unknown>[]>): Promise<StagedWorkspaceCompletionFileBatch[]> {
    const headers = new Map((rows.workspace_completion_file_batches ?? []).map((row) => [stringValue(row.id, "workspace_bundle_v4_batch_invalid"), row]));
    const entries = new Map<string, Record<string, unknown>[]>();
    for (const row of rows.workspace_completion_file_batch_entries ?? []) {
      const id = stringValue(row.batch_id, "workspace_bundle_v4_batch_invalid");
      const list = entries.get(id) ?? [];
      list.push(row);
      entries.set(id, list);
    }
    const needed = new Set<string>();
    for (const row of rows.workspace_completion_resource_versions ?? []) if (typeof row.file_batch_id === "string") needed.add(row.file_batch_id);
    for (const row of rows.workspace_completion_workspace_documents ?? []) if (typeof row.file_batch_id === "string") needed.add(row.file_batch_id);
    for (const row of rows.workspace_completion_skill_files ?? []) if (typeof row.file_batch_id === "string") needed.add(row.file_batch_id);
    const staged: StagedWorkspaceCompletionFileBatch[] = [];
    const orderedBatchIds = [...needed].sort((left, right) => {
      const leftHeader = headers.get(left);
      const rightHeader = headers.get(right);
      const leftCreated = typeof leftHeader?.created_at === "string" ? leftHeader.created_at : "";
      const rightCreated = typeof rightHeader?.created_at === "string" ? rightHeader.created_at : "";
      return leftCreated.localeCompare(rightCreated) || left.localeCompare(right);
    });
    try {
      for (const batchId of orderedBatchIds) {
        const header = headers.get(batchId);
        if (!header || header.status !== "renamed") throw new WorkspaceServerError("workspace_bundle_v4_batch_invalid", 400);
        const scope = batchScopeFromPortableHeader(header);
        const files = entries.get(batchId);
        if (!files || files.length === 0) throw new WorkspaceServerError("workspace_bundle_v4_batch_entries_missing", 400);
        const stagedFiles: Array<{ path: string; content: Uint8Array }> = [];
        for (const entry of files) {
          const relative = assertSafeRelativePath(stringValue(entry.path, "workspace_bundle_v4_file_path_invalid"));
          const expectedHash = stringValue(entry.sha256, "workspace_bundle_v4_file_hash_invalid");
          const content = await readFile(resolveBundlePath(root, `${completionDirectory}/files/${relative}`));
          if (hashBytes(content) !== expectedHash) throw new WorkspaceServerError("workspace_bundle_v4_hash_mismatch", 400);
          stagedFiles.push({ path: relative, content });
        }
        staged.push(await this.files.stageImported(context.workspaceId, scope, batchId, stagedFiles));
      }
      return staged;
    } catch (error) {
      const cleanupErrors = (await Promise.all(staged.map(async (batch) => {
        try {
          await this.files.rollback(batch);
          return undefined;
        } catch (cleanupError) {
          return cleanupError;
        }
      }))).filter((cleanupError): cleanupError is unknown => cleanupError !== undefined);
      if (cleanupErrors.length > 0) {
        throw new WorkspaceServerError("workspace_bundle_v4_cleanup_failed", 500, {
          primary_error_code: safeErrorCode(error),
          cleanup_error_code: safeErrorCode(cleanupErrors[0])
        });
      }
      throw error;
    }
  }

  private async filesRecover(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">): Promise<void> {
    // An export never treats an interrupted rename as a valid Bundle state.
    const result = await this.store.database.withContext(context, async (sql) => sql.query<{ id: string }>("SELECT id FROM workspace_completion_file_batches WHERE workspace_id = $1 AND status = 'db_committed'", [context.workspaceId]));
    if (result.rows.length > 0) throw new WorkspaceServerError("workspace_completion_file_recovery_required", 503);
  }

  private async assertNoMaintenanceMembership(
    context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">,
    excludedAccountIds: readonly string[]
  ): Promise<void> {
    const result = await this.store.database.withContext(context, async (sql) => {
      const marker = await sql.query<{ exists: boolean }>(
        "SELECT EXISTS(SELECT 1 FROM workspace_completion_maintenance_identities WHERE workspace_id = $1) AS exists",
        [context.workspaceId]
      );
      const memberships = excludedAccountIds.length === 0
        ? { rows: [{ exists: false }] }
        : await sql.query<{ exists: boolean }>(
          `SELECT EXISTS(
             SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND account_id = ANY($2::TEXT[])
             UNION ALL
             SELECT 1 FROM room_members WHERE workspace_id = $1 AND account_id = ANY($2::TEXT[])
           ) AS exists`,
          [context.workspaceId, [...excludedAccountIds]]
        );
      return { marker: marker.rows[0]?.exists === true, memberships: memberships.rows[0]?.exists === true };
    });
    if (result.marker || result.memberships) {
      throw new WorkspaceServerError("workspace_bundle_v4_maintenance_membership_restored", 409);
    }
  }

  private async readMaintenanceAccountIds(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">): Promise<string[]> {
    return this.store.database.withContext(context, async (sql) => {
      const rows = await sql.query<{ account_id: string }>(
        "SELECT account_id FROM workspace_completion_maintenance_identities WHERE workspace_id = $1",
        [context.workspaceId]
      );
      return rows.rows.map((row) => row.account_id);
    });
  }

  private async recordV4Ledger(
    context: WorkspaceRequestContext,
    bundleId: string,
    destination: string,
    manifest: WorkspaceBundleV4Manifest
  ): Promise<string> {
    return this.store.database.withContext(context, async (sql) => {
      // The runtime RLS policy for workspace_bundles is intentionally
      // write-denied. A FOR UPDATE here can therefore hide rows even though
      // they are readable. Use a plain read; the SECURITY DEFINER functions
      // below perform the authoritative lock and state change.
      const finalRows = await sql.query<BundleLedgerRow>(
        `SELECT id, format_version, path, sha256, record_counts
         FROM workspace_bundles WHERE workspace_id = $1 AND path = $2`,
        [context.workspaceId, destination]
      );
      if (finalRows.rows.length > 0) {
        const exact = finalRows.rows.filter((row) => Number(row.format_version) === 4
          && row.sha256 === manifest.integrity_hash
          && canonicalJson(row.record_counts) === canonicalJson(manifest.record_counts));
        if (exact.length === 1 && finalRows.rows.length === 1) return exact[0]!.id;
        throw new WorkspaceServerError("workspace_bundle_v4_ledger_conflict", 409);
      }

      // This read is intentionally non-mutating. A legacy embedded v3 row is
      // repaired only when its v3 hash proves it belongs to the verified v4
      // Bundle about to be recorded. Everything else is left untouched.
      const suspicious = await sql.query<BundleLedgerRow>(
        `SELECT id, format_version, path, sha256, record_counts
         FROM workspace_bundles
         WHERE workspace_id = $1 AND path LIKE '%.staging-%/base-v3'
         ORDER BY id ASC`,
        [context.workspaceId]
      );
      const proven = suspicious.rows.filter((row) => Number(row.format_version) === 3
        && row.sha256 === manifest.base_v3_integrity_hash);
      if (proven.length > 1) {
        throw new WorkspaceServerError("workspace_bundle_v4_legacy_ledger_ambiguous", 409, { count: proven.length });
      }
      if (proven.length === 1) {
        const legacy = proven[0]!;
        await sql.query(
          "SELECT samurai_repair_workspace_bundle_v4_legacy_ledger($1, $2, $3, $4, $5::JSONB, $6)",
          [context.workspaceId, legacy.id, destination, manifest.integrity_hash, canonicalJson(manifest.record_counts), manifest.base_v3_integrity_hash]
        );
        await this.store.insertAudit(sql, context, {
          action: "workspace.bundle.v4.legacy_ledger.repair",
          subjectKind: "workspace_bundle_v4",
          subjectId: legacy.id,
          details: { base_v3_integrity_hash: manifest.base_v3_integrity_hash, integrity_hash: manifest.integrity_hash }
        });
        return legacy.id;
      }
      if (manifest.transfer_id) {
        await sql.query(
          "SELECT samurai_record_workspace_bundle_v4_transfer($1, $2, $3, $4, $5::JSONB, $6)",
          [context.workspaceId, bundleId, destination, manifest.integrity_hash, canonicalJson(manifest.record_counts), manifest.transfer_id]
        );
      } else {
        await sql.query(
          "SELECT samurai_record_workspace_bundle_v4($1, $2, $3, $4, $5::JSONB)",
          [context.workspaceId, bundleId, destination, manifest.integrity_hash, canonicalJson(manifest.record_counts)]
        );
      }
      return bundleId;
    });
  }

  private async assertOwner(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">): Promise<void> {
    await this.store.database.withContext(context, async (sql) => {
      const result = await sql.query<{ allowed: boolean }>("SELECT samurai_can_workspace($1, 'owner') AS allowed", [context.workspaceId]);
      if (result.rows[0]?.allowed !== true) throw new WorkspaceServerError("workspace_bundle_owner_required", 403);
    });
  }
}

const importTableOrder = [
  "workspace_completion_configurations",
  "workspace_completion_activities",
  "workspace_completion_episodes",
  "workspace_completion_episode_activities",
  "workspace_completion_resources",
  "workspace_completion_resource_versions",
  "workspace_completion_skill_files",
  "workspace_completion_policy_approvals",
  "workspace_completion_attestations",
  "workspace_completion_evidence",
  "workspace_completion_resource_links",
  "workspace_completion_policy_rules",
  "workspace_completion_policy_change_requests",
  "workspace_completion_uses",
  "workspace_completion_evaluations",
  "workspace_completion_jobs",
  "workspace_completion_job_attempts",
  "workspace_completion_curator_state",
  "workspace_completion_curator_snapshots",
  "workspace_completion_search_projection",
  "workspace_completion_workspace_documents",
  "workspace_completion_redactions",
  "workspace_runtime_sessions",
  "workspace_runtime_messages",
  // Runtime history follows its foreign-key graph: runs own events and
  // changes, activities retain their run link, and usage refers to both.
  "workspace_runtime_runs",
  "workspace_runtime_events",
  "workspace_runtime_changes",
  "workspace_runtime_activities",
  "workspace_runtime_resource_usage",
  "workspace_runtime_automation_jobs",
  "workspace_runtime_automation_runs"
] as const;

export async function verifyWorkspaceBundleV4(directory: string): Promise<ExportWorkspaceBundleV4Result> {
  const root = path.resolve(directory);
  const raw = await readFile(path.join(root, manifestName), "utf8");
  const manifest = JSON.parse(raw) as unknown;
  assertWorkspaceBundleV4ManifestCandidate(manifest);
  const v3 = await verifyWorkspaceBundleV3(resolveBundlePath(root, baseV3Directory));
  if (v3.manifest.workspace_id !== manifest.workspace_id) throw new WorkspaceServerError("workspace_bundle_workspace_mismatch", 400);
  if (v3.manifest.integrity_hash !== manifest.base_v3_integrity_hash) throw new WorkspaceServerError("workspace_bundle_v4_base_mismatch", 400);
  if (v3.manifest.transfer_id !== manifest.transfer_id) throw new WorkspaceServerError("workspace_transfer_bundle_mismatch", 409);
  const baseProvenance = v3.manifest as typeof v3.manifest & WorkspaceBundleV3Provenance;
  const baseOrganizationId = baseProvenance.source_organization_id ?? baseProvenance.source?.organization_id;
  const baseSchemaRevision = baseProvenance.schema_revision
    ?? (baseOrganizationId !== undefined ? baseProvenance.schema_version : undefined);
  // Organization provenance is optional. New exports omit the source
  // Organization entirely; old V4 manifests may still carry the historical
  // raw field and remain verifiable for backwards compatibility.
  if (baseSchemaRevision !== undefined && manifest.schema_revision === undefined) {
    throw new WorkspaceServerError("workspace_bundle_v4_provenance_missing", 400);
  }
  if (manifest.source_organization_id !== undefined
    && (baseOrganizationId === undefined || manifest.source_organization_id !== baseOrganizationId)) {
    throw new WorkspaceServerError("workspace_bundle_v4_provenance_mismatch", 400);
  }
  if (manifest.schema_revision !== undefined && manifest.schema_revision !== baseSchemaRevision) {
    throw new WorkspaceServerError("workspace_bundle_v4_provenance_mismatch", 400);
  }
  if (manifest.schema_version !== undefined && manifest.schema_version !== (baseSchemaRevision ?? baseProvenance.schema_version)) {
    throw new WorkspaceServerError("workspace_bundle_v4_provenance_mismatch", 400);
  }
  assertBundleUsage(await measureBundleUsage(root), "workspace_bundle_v4_transport_too_large");
  const actual = await hashBundleFiles(root);
  if (canonicalJson(actual) !== canonicalJson(manifest.files)) throw new WorkspaceServerError("workspace_bundle_v4_hash_mismatch", 400);
  for (const accountId of manifest.excluded_maintenance_account_ids) assertOpaqueId(accountId, "workspace_bundle_v4_maintenance_account_invalid");
  const expected = hashText(canonicalJson(bundleV4IntegrityPayload(manifest)));
  if (expected !== manifest.integrity_hash) throw new WorkspaceServerError("workspace_bundle_v4_integrity_invalid", 400);
  for (const relative of Object.keys(actual)) {
    const content = await readFile(resolveBundlePath(root, relative));
    assertCredentialFree(relative, content);
  }
  const rows: Record<string, Record<string, unknown>[]> = {};
  for (const [table, filename] of tableFiles) rows[table] = await readJsonl(resolveBundlePath(root, `${completionDirectory}/${filename}`));
  for (const [table, filename] of workspaceChatFiles) {
    rows[table] = await readOptionalJsonl(resolveBundlePath(root, `${completionDirectory}/${filename}`));
  }
  for (const [table, filename] of workspaceRuntimeHistoryFiles) {
    // Activities were already part of the first V4 implementation and remain
    // required. The other history files are additive and optional for older
    // V4 Bundles; new exports include all of them and bind their counts.
    const required = table === "workspace_runtime_activities";
    const key = portableCountKey(table);
    const hasManifestCount = Object.prototype.hasOwnProperty.call(manifest.record_counts, key);
    const hasBundleFile = await pathExists(resolveBundlePath(root, `${completionDirectory}/${filename}`));
    if ((required || hasManifestCount) && !hasBundleFile) {
      throw new WorkspaceServerError("workspace_bundle_v4_required_file_missing", 400);
    }
    rows[table] = required || hasManifestCount || hasBundleFile
      ? await readJsonl(resolveBundlePath(root, `${completionDirectory}/${filename}`))
      : [];
  }
  assertPortableRuntimeHistory(rows, manifest.workspace_id);
  const connections = await readJsonl(resolveBundlePath(root, `${completionDirectory}/connection-descriptors.jsonl`));
  if (connections.some((row) => row.status === "active")) {
    throw new WorkspaceServerError("workspace_bundle_v4_active_connection_forbidden", 400);
  }
  for (const [table, filename] of workspaceIdentityFiles) rows[table] = await readJsonl(resolveBundlePath(root, `${completionDirectory}/${filename}`));
  for (const [table, filename] of workspaceHumanWorkAllFiles) {
    const key = portableCountKey(table);
    const hasManifestCount = Object.prototype.hasOwnProperty.call(manifest.record_counts, key);
    const hasBundleFile = await pathExists(resolveBundlePath(root, `${completionDirectory}/${filename}`));
    if (hasManifestCount && !hasBundleFile) {
      throw new WorkspaceServerError("workspace_bundle_v4_required_file_missing", 400);
    }
    rows[table] = hasManifestCount || hasBundleFile
      ? await readJsonl(resolveBundlePath(root, `${completionDirectory}/${filename}`))
      : [];
  }
  await assertPortableCompletionFileRelations(root, rows);
  // Old v95/v96 exports may carry a parent reply continuation with the
  // post-v107 default `normal` origin.  Apply the same strict compatibility
  // projection used by restore before validating the graph; forged or
  // ambiguous parent edges remain unchanged and are rejected below.
  normalizeLegacyParentContinuationOrigins(rows);
  await assertPortableHumanWorkRelations(root, manifest, rows);
  const countByKey = new Map<string, number>();
  for (const [table] of tableFiles) countByKey.set(portableCountKey(table), rows[table]?.length ?? 0);
  for (const [table, filename] of workspaceChatFiles) {
    // The files were added after the first V4 release. Only require/count
    // them when the manifest or the directory actually contains one.
    const key = portableCountKey(table);
    const hasManifestCount = Object.prototype.hasOwnProperty.call(manifest.record_counts, key);
    const hasBundleFile = await pathExists(resolveBundlePath(root, `${completionDirectory}/${filename}`));
    if (hasManifestCount && !hasBundleFile) {
      throw new WorkspaceServerError("workspace_bundle_v4_required_file_missing", 400);
    }
    if (hasManifestCount || hasBundleFile) {
      countByKey.set(key, rows[table]?.length ?? 0);
    }
  }
  for (const [table, filename] of workspaceRuntimeHistoryFiles) {
    const key = portableCountKey(table);
    const hasManifestCount = Object.prototype.hasOwnProperty.call(manifest.record_counts, key);
    const hasBundleFile = await pathExists(resolveBundlePath(root, `${completionDirectory}/${filename}`));
    if (hasManifestCount || hasBundleFile || table === "workspace_runtime_activities") {
      countByKey.set(key, rows[table]?.length ?? 0);
    }
  }
  for (const [table] of workspaceIdentityFiles) countByKey.set(portableCountKey(table), rows[table]?.length ?? 0);
  for (const [table, filename] of workspaceHumanWorkAllFiles) {
    const key = portableCountKey(table);
    const hasManifestCount = Object.prototype.hasOwnProperty.call(manifest.record_counts, key);
    const hasBundleFile = await pathExists(resolveBundlePath(root, `${completionDirectory}/${filename}`));
    if (hasManifestCount || hasBundleFile) countByKey.set(key, rows[table]?.length ?? 0);
  }
  if (canonicalJson(Object.keys(manifest.record_counts).sort()) !== canonicalJson([...countByKey.keys()].sort())) {
    throw new WorkspaceServerError("workspace_bundle_v4_record_count_mismatch", 400, {
      expected: Object.keys(manifest.record_counts).sort(),
      actual: [...countByKey.keys()].sort()
    });
  }
  for (const [table, count] of Object.entries(manifest.record_counts)) {
    const actualCount = countByKey.get(table);
    if (actualCount === undefined || actualCount !== count) {
      throw new WorkspaceServerError("workspace_bundle_v4_record_count_mismatch", 400);
    }
  }
  return { directory: root, manifest };
}

/** Creates the verified HTTP body used by the standard V4 transfer endpoint. */
export async function readWorkspaceBundleV4Transport(directory: string): Promise<WorkspaceBundleV4Transport> {
  const verified = await verifyWorkspaceBundleV4(directory);
  const entries: WorkspaceBundleV4Transport["entries"] = [];
  let total = 0;
  for (const relativePath of Object.keys(verified.manifest.files).sort()) {
    const content = await readFile(resolveBundlePath(verified.directory, relativePath));
    if (content.byteLength > WORKSPACE_BUNDLE_MAX_ENTRY_BYTES) throw new WorkspaceServerError("workspace_bundle_v4_entry_too_large", 413);
    total += content.byteLength;
    if (entries.length >= WORKSPACE_BUNDLE_MAX_ENTRIES || total > WORKSPACE_BUNDLE_MAX_BYTES) throw new WorkspaceServerError("workspace_bundle_v4_transport_too_large", 413);
    entries.push({ path: relativePath, content_base64: content.toString("base64") });
  }
  return { format: transportFormat, manifest: verified.manifest, entries };
}

/** Materializes and verifies a V4 HTTP transport before it reaches import. */
export async function writeWorkspaceBundleV4Transport(input: { transport: unknown; destination: string }): Promise<{ directory: string; manifest: WorkspaceBundleV4Manifest }> {
  const transport = parseV4Transport(input.transport);
  const destination = path.resolve(input.destination);
  await mkdir(destination, { recursive: false, mode: 0o700 });
  let complete = false;
  try {
    const expected = new Set(Object.keys(transport.manifest.files));
    let total = 0;
    let receivedEntries = 0;
    for (const entry of transport.entries) {
      assertSafeRelativePath(entry.path);
      if (!expected.delete(entry.path)) throw new WorkspaceServerError("workspace_bundle_v4_transport_entry_invalid", 400);
      receivedEntries += 1;
      const content = decodeV4TransportContent(entry.content_base64);
      total += content.byteLength;
      if (receivedEntries > WORKSPACE_BUNDLE_MAX_ENTRIES || total > WORKSPACE_BUNDLE_MAX_BYTES) throw new WorkspaceServerError("workspace_bundle_v4_transport_too_large", 413);
      if (hashBytes(content) !== transport.manifest.files[entry.path]) throw new WorkspaceServerError("workspace_bundle_v4_hash_mismatch", 400);
      const target = resolveBundlePath(destination, entry.path);
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, content, { flag: "wx", mode: 0o600 });
    }
    if (expected.size > 0) throw new WorkspaceServerError("workspace_bundle_v4_required_file_missing", 400);
    await writeFile(path.join(destination, manifestName), canonicalJson(transport.manifest), { flag: "wx", mode: 0o600 });
    const verified = await verifyWorkspaceBundleV4(destination);
    complete = true;
    return verified;
  } finally {
    if (!complete) await rm(destination, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function readCompletionBundleRows(root: string, workspaceId: string): Promise<Record<string, Record<string, unknown>[]>> {
  const rows: Record<string, Record<string, unknown>[]> = {};
  for (const [table, filename] of tableFiles) rows[table] = await readJsonl(resolveBundlePath(root, `${completionDirectory}/${filename}`));
  for (const [table, filename] of workspaceChatFiles) {
    rows[table] = await readOptionalJsonl(resolveBundlePath(root, `${completionDirectory}/${filename}`));
  }
  for (const [table, filename] of workspaceRuntimeHistoryFiles) {
    rows[table] = table === "workspace_runtime_activities"
      ? await readJsonl(resolveBundlePath(root, `${completionDirectory}/${filename}`))
      : await readOptionalJsonl(resolveBundlePath(root, `${completionDirectory}/${filename}`));
  }
  for (const [table, filename] of workspaceIdentityFiles) rows[table] = await readJsonl(resolveBundlePath(root, `${completionDirectory}/${filename}`));
  for (const [table, filename] of workspaceHumanWorkAllFiles) {
    rows[table] = await readOptionalJsonl(resolveBundlePath(root, `${completionDirectory}/${filename}`));
  }
  await assertPortableCompletionFileRelations(root, rows);
  attachLegacyCompletionFileBatches(rows, workspaceId);
  normalizeLegacyParentContinuationOrigins(rows);
  // Keep the import path defensive even if a future caller bypasses the
  // public verifier. The source row `session_ref` remains untouched; only
  // provider-shaped identifiers in Runtime metadata/payload are rejected.
  assertPortableRuntimeHistory(rows, workspaceId);
  return rows;
}

/** The DB row points at the body, while the batch entry and the Bundle file
 * prove that the body actually arrived. Check all three before a restore can
 * insert metadata; otherwise a mismatched hash would look like a successful
 * import until the next read. */
async function assertPortableCompletionFileRelations(
  root: string,
  rows: Record<string, Record<string, unknown>[]>
): Promise<void> {
  const headers = new Map<string, Record<string, unknown>>();
  for (const header of rows.workspace_completion_file_batches ?? []) {
    const id = stringValue(header.id, "workspace_bundle_v4_batch_invalid");
    if (headers.has(id)) throw new WorkspaceServerError("workspace_bundle_v4_batch_invalid", 400);
    if (header.status !== "renamed" && header.status !== "rolled_back") {
      throw new WorkspaceServerError("workspace_bundle_v4_batch_invalid", 400);
    }
    try {
      batchScopeFromPortableHeader(header);
    } catch {
      throw new WorkspaceServerError("workspace_bundle_v4_batch_scope_invalid", 400);
    }
    headers.set(id, header);
  }

  const entries = new Map<string, { sha256: string; size: number }>();
  for (const entry of rows.workspace_completion_file_batch_entries ?? []) {
    const batchId = stringValue(entry.batch_id, "workspace_bundle_v4_batch_invalid");
    const header = headers.get(batchId);
    if (!header) throw new WorkspaceServerError("workspace_bundle_v4_batch_invalid", 400);
    const relative = assertSafeRelativePath(stringValue(entry.path, "workspace_bundle_v4_file_path_invalid"));
    const sha256 = stringValue(entry.sha256, "workspace_bundle_v4_file_hash_invalid");
    if (!/^[a-f0-9]{64}$/.test(sha256)) throw new WorkspaceServerError("workspace_bundle_v4_file_hash_invalid", 400);
    const size = nonNegativeIntegerValue(entry.size, "workspace_bundle_v4_file_size_invalid");
    const key = `${batchId}\u0000${relative}`;
    const previous = entries.get(key);
    if (previous && (previous.sha256 !== sha256 || previous.size !== size)) {
      throw new WorkspaceServerError("workspace_bundle_v4_batch_entry_conflict", 400);
    }
    entries.set(key, { sha256, size });
  }

  for (const [table, fields] of [
    ["workspace_completion_resource_versions", { path: "file_path", hash: "content_hash", size: "content_size" }],
    ["workspace_completion_workspace_documents", { path: "file_path", hash: "content_hash", size: "content_size" }],
    ["workspace_completion_skill_files", { path: "file_path", hash: "content_hash", size: "content_size" }]
  ] as const) {
    for (const row of rows[table] ?? []) {
      const relative = assertSafeRelativePath(stringValue(row[fields.path], "workspace_bundle_v4_file_path_invalid"));
      const sha256 = stringValue(row[fields.hash], "workspace_bundle_v4_file_hash_invalid");
      if (!/^[a-f0-9]{64}$/.test(sha256)) throw new WorkspaceServerError("workspace_bundle_v4_file_hash_invalid", 400);
      const size = nonNegativeIntegerValue(row[fields.size], "workspace_bundle_v4_file_size_invalid");
      if (row.file_batch_id !== undefined && row.file_batch_id !== null) {
        const batchId = stringValue(row.file_batch_id, "workspace_bundle_v4_batch_invalid");
        const header = headers.get(batchId);
        if (!header || header.status !== "renamed") throw new WorkspaceServerError("workspace_bundle_v4_batch_invalid", 400);
        const entry = entries.get(`${batchId}\u0000${relative}`);
        if (!entry || entry.sha256 !== sha256 || entry.size !== size) {
          throw new WorkspaceServerError("workspace_bundle_v4_file_metadata_mismatch", 400, { table, path: relative });
        }
      }
      let content: Buffer;
      try {
        content = await readFile(resolveBundlePath(root, `${completionDirectory}/files/${relative}`));
      } catch {
        throw new WorkspaceServerError("workspace_bundle_v4_file_missing", 400, { path: relative });
      }
      if (content.byteLength !== size || hashBytes(content) !== sha256) {
        throw new WorkspaceServerError("workspace_bundle_v4_file_metadata_mismatch", 400, { table, path: relative });
      }
    }
  }
}

/** Resource versions created before file batches were introduced still have
 * a valid file_path/content_hash but no ledger pointer. Give those legacy
 * rows a deterministic import-only batch so their already verified bodies are
 * restored through the same DB-then-files recovery protocol. */
function attachLegacyCompletionFileBatches(
  rows: Record<string, Record<string, unknown>[]>,
  sourceWorkspaceId: string
): void {
  const resources = new Map<string, Record<string, unknown>>();
  for (const resource of rows.workspace_completion_resources ?? []) {
    if (typeof resource.id === "string") resources.set(resource.id, resource);
  }
  const headers = rows.workspace_completion_file_batches ?? (rows.workspace_completion_file_batches = []);
  const entries = rows.workspace_completion_file_batch_entries ?? (rows.workspace_completion_file_batch_entries = []);
  const headerIds = new Set(headers.map((header) => typeof header.id === "string" ? header.id : ""));
  type LegacyCompletionBatchHeader = Record<string, unknown> & {
    id: string;
    scope_kind: "workspace" | "room";
    room_id: string | null;
    status: "renamed";
    created_at: string;
    updated_at: string;
  };
  const byScope = new Map<string, LegacyCompletionBatchHeader>();
  const entryByKey = new Map(entries.map((entry) => [`${String(entry.batch_id)}\u0000${String(entry.path)}`, entry]));
  const timestamp = new Date().toISOString();

  const scopeForResource = (resourceId: unknown): { kind: "workspace" | "room"; roomId?: string } => {
    const resource = typeof resourceId === "string" ? resources.get(resourceId) : undefined;
    if (!resource || (resource.scope_kind !== "workspace" && resource.scope_kind !== "room")) {
      throw new WorkspaceServerError("workspace_bundle_v4_file_scope_invalid", 400);
    }
    if (resource.scope_kind === "workspace") return { kind: "workspace" };
    if (typeof resource.room_id !== "string" || !resource.room_id) {
      throw new WorkspaceServerError("workspace_bundle_v4_file_scope_invalid", 400);
    }
    return { kind: "room", roomId: resource.room_id };
  };

  const attach = (
    row: Record<string, unknown>,
    scope: { kind: "workspace" | "room"; roomId?: string }
  ): void => {
    if (row.file_batch_id !== undefined && row.file_batch_id !== null) return;
    const relative = assertSafeRelativePath(stringValue(row.file_path, "workspace_bundle_v4_file_path_invalid"));
    const sha256 = stringValue(row.content_hash, "workspace_bundle_v4_file_hash_invalid");
    if (!/^[a-f0-9]{64}$/.test(sha256)) throw new WorkspaceServerError("workspace_bundle_v4_file_hash_invalid", 400);
    const scopeKey = scope.kind === "workspace" ? "workspace" : `room:${scope.roomId}`;
    let header = byScope.get(scopeKey);
    if (!header) {
      const id = completionId("bundle_legacy_file_batch", sourceWorkspaceId, scopeKey);
      if (headerIds.has(id)) throw new WorkspaceServerError("workspace_bundle_v4_batch_id_conflict", 400);
      header = {
        id,
        scope_kind: scope.kind,
        room_id: scope.roomId ?? null,
        status: "renamed",
        created_at: timestamp,
        updated_at: timestamp
      };
      byScope.set(scopeKey, header);
      headerIds.add(id);
      headers.push(header);
    }
    const key = `${header.id}\u0000${relative}`;
    const previous = entryByKey.get(key);
    const size = nonNegativeIntegerValue(row.content_size, "workspace_bundle_v4_file_size_invalid");
    if (previous && (previous.sha256 !== sha256 || String(previous.size) !== String(size))) {
      throw new WorkspaceServerError("workspace_bundle_v4_batch_entry_conflict", 400);
    }
    if (!previous) {
      const entry = { workspace_id: sourceWorkspaceId, batch_id: header.id, path: relative, sha256, size };
      entries.push(entry);
      entryByKey.set(key, entry);
    }
    row.file_batch_id = header.id;
  };

  for (const row of rows.workspace_completion_resource_versions ?? []) {
    if (row.file_batch_id === undefined || row.file_batch_id === null) attach(row, scopeForResource(row.resource_id));
  }
  for (const row of rows.workspace_completion_workspace_documents ?? []) {
    if (row.file_batch_id === undefined || row.file_batch_id === null) attach(row, { kind: "workspace" });
  }
  for (const row of rows.workspace_completion_skill_files ?? []) {
    if (row.file_batch_id === undefined || row.file_batch_id === null) attach(row, scopeForResource(row.resource_id));
  }
}

/**
 * A Completion file batch is an atomic write/recovery record, not an
 * immutable duplicate of every historical path. A later Server update moves
 * the old Version pointer from a live path to `.versions/...`, so exporting
 * the original entry verbatim can ask a restore to validate an old hash at a
 * path now occupied by the newer body. Reconstruct the portable ledger from
 * the DB pointers that form the snapshot's actual source of truth.
 */
function normalizePortableBatchRows(rows: Record<string, Record<string, unknown>[]>): Record<string, Record<string, unknown>[]> {
  const normalized = { ...rows };
  const headers = new Map<string, Record<string, unknown>>();
  for (const header of rows.workspace_completion_file_batches ?? []) {
    headers.set(stringValue(header.id, "workspace_bundle_v4_batch_invalid"), header);
  }
  const entries = new Map<string, Record<string, unknown>>();
  const usedBatchIds = new Set<string>();
  const addReference = (row: Record<string, unknown>, fields: { path: string; hash: string; size: string }) => {
    const batchId = stringValue(row.file_batch_id, "workspace_bundle_v4_batch_invalid");
    const header = headers.get(batchId);
    if (!header || header.status !== "renamed") throw new WorkspaceServerError("workspace_bundle_v4_batch_invalid", 400);
    const filePath = stringValue(row[fields.path], "workspace_bundle_v4_file_path_invalid");
    const hash = stringValue(row[fields.hash], "workspace_bundle_v4_file_hash_invalid");
    const size = row[fields.size];
    if (!(typeof size === "number" || (typeof size === "string" && /^\d+$/.test(size)))) {
      throw new WorkspaceServerError("workspace_bundle_v4_file_size_invalid", 400);
    }
    assertSafeRelativePath(filePath);
    const key = `${batchId}\u0000${filePath}`;
    const previous = entries.get(key);
    if (previous && (previous.sha256 !== hash || String(previous.size) !== String(size))) {
      throw new WorkspaceServerError("workspace_bundle_v4_batch_entry_conflict", 400);
    }
    entries.set(key, { workspace_id: row.workspace_id, batch_id: batchId, path: filePath, sha256: hash, size });
    usedBatchIds.add(batchId);
  };
  for (const row of rows.workspace_completion_resource_versions ?? []) {
    addReference(row, { path: "file_path", hash: "content_hash", size: "content_size" });
  }
  for (const row of rows.workspace_completion_workspace_documents ?? []) {
    addReference(row, { path: "file_path", hash: "content_hash", size: "content_size" });
  }
  for (const row of rows.workspace_completion_skill_files ?? []) {
    addReference(row, { path: "file_path", hash: "content_hash", size: "content_size" });
  }
  const batchIds = [...usedBatchIds].sort((left, right) => {
    const leftHeader = headers.get(left)!;
    const rightHeader = headers.get(right)!;
    const leftCreated = typeof leftHeader.created_at === "string" ? leftHeader.created_at : "";
    const rightCreated = typeof rightHeader.created_at === "string" ? rightHeader.created_at : "";
    return leftCreated.localeCompare(rightCreated) || left.localeCompare(right);
  });
  normalized.workspace_completion_file_batches = batchIds.map((id) => headers.get(id)!);
  normalized.workspace_completion_file_batch_entries = [...entries.values()].sort((left, right) =>
    String(left.batch_id).localeCompare(String(right.batch_id)) || String(left.path).localeCompare(String(right.path))
  );
  return normalized;
}

async function insertPortableRow(sql: WorkspaceSql, table: (typeof importTableOrder)[number], row: Record<string, unknown>): Promise<void> {
  await sql.query(`INSERT INTO ${table} SELECT (jsonb_populate_record(NULL::${table}, $1::JSONB)).*`, [canonicalJson(row)]);
}

async function importWorkspaceHumanWorkRows(
  sql: WorkspaceSql,
  context: Pick<WorkspaceRequestContext, "workspaceId">,
  rows: Record<string, Record<string, unknown>[]>
): Promise<void> {
  const hasRows = workspaceHumanWorkFiles.some(([table]) => (rows[table] ?? []).length > 0);
  if (!hasRows) return;
  const json = (table: (typeof workspaceHumanWorkFiles)[number][0]): string => canonicalJson(rows[table] ?? []);
  await sql.query(
    `SELECT samurai_import_workspace_human_work_v2(
       $1, $2::JSONB, $3::JSONB, $4::JSONB, $5::JSONB, $6::JSONB, $7::JSONB, $8::JSONB
     )`,
    [
      context.workspaceId,
      json("workspace_human_works"),
      json("workspace_human_work_assignments"),
      json("workspace_human_work_instructions"),
      json("workspace_human_work_comments"),
      json("workspace_human_work_comment_reactions"),
      json("workspace_human_work_controls"),
      json("workspace_human_work_launch_reservations")
    ]
  );
  // The legacy import RPC predates dependency edges. Restore them through a
  // separate guarded RPC after all assignments exist, preserving graph
  // relations without making old Bundle files or their import ordering
  // invalid.
  await sql.query(
    "SELECT samurai_restore_human_work_assignment_dependencies($1, $2::JSONB)",
    [context.workspaceId, json("workspace_human_work_assignments")]
  );
  // v107 carries the server-only assignment origin as well.  This keeps
  // delegated children distinct from parent continuations after restore;
  // restored live work remains blocked and never auto-launches.
  await sql.query(
    "SELECT samurai_restore_human_work_assignment_origins($1, $2::JSONB)",
    [context.workspaceId, json("workspace_human_work_assignments")]
  );
}

async function importWorkspaceLegacySessionRows(
  sql: WorkspaceSql,
  context: Pick<WorkspaceRequestContext, "workspaceId">,
  rows: Record<string, Record<string, unknown>[]>
): Promise<void> {
  const mappings = rows.workspace_human_work_legacy_sessions ?? [];
  if (mappings.length === 0) return;
  await sql.query(
    "SELECT samurai_import_workspace_human_work_legacy_sessions($1, $2::JSONB)",
    [context.workspaceId, canonicalJson(mappings)]
  );
}

async function insertMigrationReceipt(sql: WorkspaceSql, row: Record<string, unknown>): Promise<void> {
  await sql.query(
    "INSERT INTO workspace_completion_migration_receipts SELECT (jsonb_populate_record(NULL::workspace_completion_migration_receipts, $1::JSONB)).*",
    [canonicalJson(row)]
  );
}

async function insertPortableStaticRow(
  sql: WorkspaceSql,
  table: "workspace_completion_file_batches" | "workspace_completion_file_batch_entries",
  row: Record<string, unknown>
): Promise<void> {
  await sql.query(`INSERT INTO ${table} SELECT (jsonb_populate_record(NULL::${table}, $1::JSONB)).*`, [canonicalJson(row)]);
}

async function writeJsonl(destination: string, rows: readonly Record<string, unknown>[]): Promise<void> {
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  for (const row of rows) assertPortablePathsFree(row);
  const body = rows.map((row) => canonicalJson(row)).join("\n") + (rows.length ? "\n" : "");
  await writeFile(destination, body, { flag: "wx", mode: 0o600 });
}

async function readJsonl(source: string): Promise<Record<string, unknown>[]> {
  const raw = await readFile(source, "utf8");
  if (!raw) return [];
  if (Buffer.byteLength(raw, "utf8") > WORKSPACE_BUNDLE_MAX_ENTRY_BYTES) throw new WorkspaceServerError("workspace_bundle_v4_entry_too_large", 413);
  const lines = raw.trimEnd().split("\n");
  if (lines.length > WORKSPACE_BUNDLE_MAX_RECORDS_PER_FILE) throw new WorkspaceServerError("workspace_bundle_v4_record_count_too_large", 413);
  return lines.map((line) => {
    try {
      const value = JSON.parse(line) as unknown;
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("row");
      assertPortablePathsFree(value);
      return stripOrganizationIdentifiers(value) as Record<string, unknown>;
    } catch (error) {
      if (error instanceof WorkspaceServerError) throw error;
      throw new WorkspaceServerError("workspace_bundle_v4_jsonl_invalid", 400);
    }
  });
}

async function readOptionalJsonl(source: string): Promise<Record<string, unknown>[]> {
  try {
    return await readJsonl(source);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

const portablePathFieldNames = new Set([
  "path", "filepath", "storage_namespace", "storagenamespace", "working_directory", "workingdirectory",
  "worktree_path", "worktreepath", "absolute_path", "absolutepath", "directory", "directory_path",
  "directorypath", "root_path", "rootpath", "cwd", "home"
]);

function assertPortablePathsFree(value: unknown, fieldName?: string): void {
  if (typeof value === "string") {
    if (fieldName && portablePathFieldNames.has(fieldName.toLowerCase().replace(/[^a-z0-9]/g, ""))
      && isAbsolutePortablePath(value)) {
      throw new WorkspaceServerError("workspace_bundle_v4_absolute_path_forbidden", 400);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertPortablePathsFree(item, fieldName);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    assertPortablePathsFree(nested, key);
  }
}

function isAbsolutePortablePath(value: string): boolean {
  return path.posix.isAbsolute(value)
    || path.win32.isAbsolute(value)
    || /^[A-Za-z]:[\\/]/.test(value)
    || value.startsWith("\\\\")
    || value.startsWith("file:///");
}

async function hashBundleFiles(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for await (const relative of walkFiles(root)) {
    if (relative === manifestName) continue;
    const content = await readFile(resolveBundlePath(root, relative));
    files[relative] = hashBytes(content);
  }
  return Object.fromEntries(Object.entries(files).sort(([left], [right]) => left.localeCompare(right)));
}

async function* walkFiles(root: string, prefix = ""): AsyncGenerator<string> {
  const directory = resolveBundlePath(root, prefix || ".");
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = resolveBundlePath(root, relative);
    const stats = await lstat(absolute);
    if (stats.isSymbolicLink()) throw new WorkspaceServerError("workspace_bundle_v4_symlink_forbidden", 400);
    if (stats.isDirectory()) yield* walkFiles(root, relative);
    else if (stats.isFile()) yield relative;
    else throw new WorkspaceServerError("workspace_bundle_v4_file_invalid", 400);
  }
}

function resolveBundlePath(root: string, relative: string): string {
  const safe = relative === "." ? "." : assertSafeRelativePath(relative);
  const resolved = path.resolve(root, ...safe.split("/"));
  const relativeRoot = path.relative(root, resolved);
  if (relativeRoot === ".." || relativeRoot.startsWith(`..${path.sep}`) || path.isAbsolute(relativeRoot)) throw new WorkspaceServerError("workspace_bundle_v4_path_invalid", 400);
  return resolved;
}

function portableRow(row: Record<string, unknown>): Record<string, unknown> {
  return stripOrganizationIdentifiers(Object.fromEntries(Object.entries(row).map(([key, value]) => [key, portableValue(value)]))) as Record<string, unknown>;
}

function portableRuntimeRow(table: string, row: Record<string, unknown>): Record<string, unknown> {
  const portable = portableRow(row);
  if (table === "workspace_completion_migration_receipts") {
    // A migration receipt remains complete in PostgreSQL, but the portable
    // Bundle must never carry identifiers that were excluded because they
    // matched secret detection.  Keep a count as portable audit evidence.
    return { ...portable, counts: portableMigrationReceiptCounts(portable.counts) };
  }
  if (table === "workspace_runtime_runs") {
    assertPortableRuntimeRun(portable);
    // A provider-native session ID can make a restored Run look resumable.
    // Keep the settled outcome and request idempotency, but force a fresh
    // provider session if the target later starts a new operation. The
    // top-level `session_ref` is a Workspace-owned app/session reference and
    // remains portable; only provider-shaped IDs inside Runtime metadata are
    // removed.
    return {
      ...portable,
      metadata: stripPortableRuntimeProviderIdentifiers(portable.metadata),
      backend_session_id: null
    };
  }
  if (table === "workspace_runtime_events") {
    // Event payloads are historical evidence; provider-native session state is
    // deployment-local and must never be used as a restore credential. Keep
    // artifact evidence and Workspace row `session_id` intact while removing
    // provider/backend/native session, thread, and conversation identifiers
    // from the opaque payload.
    return {
      ...portable,
      payload: stripPortableRuntimeProviderIdentifiers(portable.payload),
      backend_session_id: null
    };
  }
  if (table === "workspace_runtime_automation_jobs") {
    // A bundle never transports a live worker lease or lock owner.
    return { ...portable, locked_until: null, lock_owner_token: null };
  }
  if (table === "workspace_runtime_automation_runs" && portable.status === "started") {
    return {
      ...portable,
      status: "failed",
      error_code: "automation_bundle_restore_interrupted",
      error: "automation_bundle_restore_interrupted",
      completed_at: new Date().toISOString(),
      blocked_at: null
    };
  }
  if (table === "workspace_human_work_assignments") {
    // An assignment's lease/current run can only be meaningful on the source
    // Server. Keep settled result history, but never export a live ownership
    // claim that a target could resume.
    const active = ["queued", "ready", "running", "waiting", "blocked"].includes(String(portable.status));
    return {
      ...portable,
      ...(active ? { current_run_id: null } : {}),
      lease_owner: null,
      lease_expires_at: null
    };
  }
  if (table === "workspace_human_work_launch_reservations") {
    // Reservation rows remain auditable, but their live lease is never
    // portable. Restore converts reserved/claimed rows to cancelled.
    return {
      ...portable,
      lease_owner: null,
      lease_expires_at: null
    };
  }
  if (table === "workspace_human_works") {
    return {
      ...portable,
      completion_criteria: stripPortableRuntimeProviderIdentifiers(portable.completion_criteria)
    };
  }
  if (table === "workspace_human_work_controls") {
    return {
      ...portable,
      details: stripPortableRuntimeProviderIdentifiers(portable.details)
    };
  }
  if (table === "workspace_human_work_instructions" || table === "workspace_human_work_comments") {
    return {
      ...portable,
      attachment_refs: stripPortableRuntimeProviderIdentifiers(portable.attachment_refs)
    };
  }
  return portable;
}

/**
 * A settled Run is portable evidence, not a new executable association.  The
 * database trigger intentionally rejects `metadata.runtime_binding` unless
 * the assignment is currently running; a restored historical assignment is
 * terminal (or explicitly outcome-unknown) and must therefore not be
 * inserted with that live binding.  Keep the verified source binding under a
 * non-executable history key so the evidence remains inspectable without
 * allowing Runtime to resume it.
 */
function restorePortableRuntimeHistoryRow(
  table: string,
  row: Record<string, unknown>,
  targetWorkspaceId: string
): Record<string, unknown> {
  if (table !== "workspace_runtime_runs") return row;
  const metadata = row.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return row;
  const record = metadata as Record<string, unknown>;
  const binding = record.runtime_binding;
  if (binding === undefined) return row;
  const { runtime_binding: _runtimeBinding, ...safeMetadata } = record;
  return {
    ...row,
    metadata: {
      ...safeMetadata,
      historical_runtime_binding: binding,
      restored_workspace_id: targetWorkspaceId
    }
  };
}

const portableRuntimeTerminalStatuses = new Set(["completed", "failed", "cancelled", "outcome_unknown"]);

function assertPortableRuntimeRun(row: Record<string, unknown>, requireBackendSessionAbsent = false): void {
  const settled = row.phase === "settled"
    || (typeof row.status === "string" && portableRuntimeTerminalStatuses.has(row.status));
  if (!settled) throw new WorkspaceServerError("workspace_bundle_v4_runtime_run_unsettled", 409);
  if (requireBackendSessionAbsent && row.backend_session_id !== null && row.backend_session_id !== undefined) {
    throw new WorkspaceServerError("workspace_bundle_v4_backend_session_forbidden", 400);
  }
}

function assertPortableRuntimeHistory(rows: Record<string, Record<string, unknown>[]>, workspaceId: string): void {
  const runs = rows.workspace_runtime_runs ?? [];
  const runIds = new Set(runs.map((row) => row.id).filter((id): id is string => typeof id === "string"));
  for (const run of runs) {
    if (run.workspace_id !== undefined && run.workspace_id !== workspaceId) {
      throw new WorkspaceServerError("workspace_bundle_v4_runtime_history_reference_invalid", 400);
    }
    assertPortableRuntimeRun(run, true);
    assertPortableRuntimeProviderIdentifiersAbsent(run.metadata);
  }
  for (const event of rows.workspace_runtime_events ?? []) {
    if (event.workspace_id !== undefined && event.workspace_id !== workspaceId) {
      throw new WorkspaceServerError("workspace_bundle_v4_runtime_history_reference_invalid", 400);
    }
    if (event.backend_session_id !== null && event.backend_session_id !== undefined) {
      throw new WorkspaceServerError("workspace_bundle_v4_backend_session_forbidden", 400);
    }
    assertPortableRuntimeProviderIdentifiersAbsent(event.payload);
    if (typeof event.run_id !== "string" || !runIds.has(event.run_id)) {
      throw new WorkspaceServerError("workspace_bundle_v4_runtime_history_reference_invalid", 400);
    }
  }
  for (const change of rows.workspace_runtime_changes ?? []) {
    if (change.workspace_id !== undefined && change.workspace_id !== workspaceId) {
      throw new WorkspaceServerError("workspace_bundle_v4_runtime_history_reference_invalid", 400);
    }
    if (typeof change.run_id === "string" && !runIds.has(change.run_id)) {
      throw new WorkspaceServerError("workspace_bundle_v4_runtime_history_reference_invalid", 400);
    }
  }
  const activityIds = new Set((rows.workspace_runtime_activities ?? [])
    .map((row) => row.id)
    .filter((id): id is string => typeof id === "string"));
  for (const activity of rows.workspace_runtime_activities ?? []) {
    if (activity.workspace_id !== undefined && activity.workspace_id !== workspaceId) {
      throw new WorkspaceServerError("workspace_bundle_v4_runtime_history_reference_invalid", 400);
    }
    if (typeof activity.backend_run_id === "string" && !runIds.has(activity.backend_run_id)) {
      throw new WorkspaceServerError("workspace_bundle_v4_runtime_history_reference_invalid", 400);
    }
  }
  const changeIds = new Set((rows.workspace_runtime_changes ?? [])
    .map((row) => row.id)
    .filter((id): id is string => typeof id === "string"));
  for (const usage of rows.workspace_runtime_resource_usage ?? []) {
    if (usage.workspace_id !== undefined && usage.workspace_id !== workspaceId) {
      throw new WorkspaceServerError("workspace_bundle_v4_runtime_history_reference_invalid", 400);
    }
    if (typeof usage.activity_id !== "string" || !activityIds.has(usage.activity_id)
      || (typeof usage.workspace_change_id === "string" && !changeIds.has(usage.workspace_change_id))) {
      throw new WorkspaceServerError("workspace_bundle_v4_runtime_history_reference_invalid", 400);
    }
  }
}

function runtimeHistoryRelationError(): never {
  throw new WorkspaceServerError("workspace_bundle_v4_runtime_history_reference_invalid", 400);
}

function runtimeBindingText(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return runtimeHistoryRelationError();
  return value.trim();
}

function runtimeBindingInteger(value: unknown, minimum: number): number {
  const number = typeof value === "number"
    ? value
    : typeof value === "string" && /^\d+$/.test(value)
      ? Number(value)
      : NaN;
  if (!Number.isSafeInteger(number) || number < minimum) return runtimeHistoryRelationError();
  return number;
}

/**
 * Runtime bindings are executable only while a Work assignment is running.
 * A Bundle may contain their settled evidence, but every source-side
 * Workspace/Room/Work/Assignment/Agent/Backend relation must be proven before
 * the binding is moved to the non-executable historical metadata key during
 * restore.  This keeps a forged binding from becoming silently portable.
 */
function assertPortableRuntimeBindingRelations(
  rows: Record<string, Record<string, unknown>[]>,
  workspaceId: string,
  workById: ReadonlyMap<string, Record<string, unknown>>,
  assignmentById: ReadonlyMap<string, Record<string, unknown>>,
  agentIds: ReadonlySet<string>,
  agentVersions: ReadonlyMap<string, number>,
  agentBackends: ReadonlyMap<string, string>
): void {
  for (const run of rows.workspace_runtime_runs ?? []) {
    const metadata = run.metadata;
    if (metadata === null || metadata === undefined) continue;
    if (typeof metadata !== "object" || Array.isArray(metadata)) runtimeHistoryRelationError();
    const binding = (metadata as Record<string, unknown>).runtime_binding;
    if (binding === undefined) continue;
    if (!binding || typeof binding !== "object" || Array.isArray(binding)) runtimeHistoryRelationError();
    const bindingRecord = binding as Record<string, unknown>;
    const bindingWorkspaceId = runtimeBindingText(bindingRecord.workspace_id);
    const bindingRoomId = runtimeBindingText(bindingRecord.room_id);
    // `portableRuntimeRow` removes provider-shaped session identifiers from
    // opaque metadata. Older V4 exports therefore omit this nested field;
    // when it is present in a future/hand-built bundle, it must still match
    // the Workspace-owned Run session.
    const bindingSessionId = bindingRecord.session_id === undefined
      ? undefined
      : runtimeBindingText(bindingRecord.session_id);
    const bindingAgentId = runtimeBindingText(bindingRecord.agent_id);
    const bindingBackendId = runtimeBindingText(bindingRecord.backend_id);
    const bindingGeneration = runtimeBindingInteger(bindingRecord.generation, 0);
    const bindingAgentVersion = runtimeBindingInteger(bindingRecord.agent_configuration_version, 1);
    if (bindingWorkspaceId !== workspaceId
      || bindingRoomId !== runtimeBindingText(run.room_id)
      || bindingSessionId !== undefined && bindingSessionId !== runtimeBindingText(run.session_id)
      || bindingAgentId !== runtimeBindingText(run.agent_id)
      || bindingBackendId !== runtimeBindingText(run.backend_id)
      || !agentIds.has(bindingAgentId)
      || agentBackends.get(bindingAgentId) !== bindingBackendId
      || agentVersions.get(bindingAgentId)! < bindingAgentVersion) {
      runtimeHistoryRelationError();
    }

    const nestedAgent = bindingRecord.agent;
    if (nestedAgent !== undefined) {
      if (!nestedAgent || typeof nestedAgent !== "object" || Array.isArray(nestedAgent)) runtimeHistoryRelationError();
      const nested = nestedAgent as Record<string, unknown>;
      if (nested.backend_id !== undefined && runtimeBindingText(nested.backend_id) !== bindingBackendId) runtimeHistoryRelationError();
      if (nested.config_version !== undefined && runtimeBindingInteger(nested.config_version, 1) !== bindingAgentVersion) runtimeHistoryRelationError();
    }

    const workId = bindingRecord.work_id === undefined ? undefined : runtimeBindingText(bindingRecord.work_id);
    const assigneeId = bindingRecord.assignee_id === undefined ? undefined : runtimeBindingText(bindingRecord.assignee_id);
    if ((workId === undefined) !== (assigneeId === undefined)) runtimeHistoryRelationError();
    if (workId === undefined || assigneeId === undefined) continue;

    const work = workById.get(workId);
    const assignment = assignmentById.get(assigneeId);
    if (!work || !assignment
      || work.room_id !== bindingRoomId
      || assignment.work_id !== workId
      || assignment.room_id !== bindingRoomId
      || assignment.agent_id !== bindingAgentId
      || runtimeBindingInteger(assignment.agent_version, 1) !== bindingAgentVersion
      || bindingGeneration > runtimeBindingInteger(work.control_generation, 0)) {
      runtimeHistoryRelationError();
    }
    if (bindingRecord.parent_assignee_id !== undefined
      && runtimeBindingText(bindingRecord.parent_assignee_id) !== (assignment.parent_assignment_id ?? undefined)) {
      runtimeHistoryRelationError();
    }
  }
}

const humanWorkTerminalStatuses = new Set(["completed", "failed", "cancelled"]);
const humanAssignmentStatuses = new Set(["queued", "ready", "running", "waiting", "blocked", "completed", "failed", "cancelled", "outcome_unknown"]);

function humanWorkRelationError(): never {
  throw new WorkspaceServerError("workspace_bundle_v4_human_work_relation_invalid", 400);
}

function humanWorkResourceReferenceError(kind: "invalid" | "not_found" | "scope_invalid"): never {
  const status = kind === "not_found" ? 404 : kind === "scope_invalid" ? 409 : 400;
  throw new WorkspaceServerError(`workspace_bundle_v4_human_work_resource_reference_${kind}`, status);
}

function humanWorkId(value: unknown): string {
  if (typeof value !== "string") return humanWorkRelationError();
  try {
    return assertOpaqueId(value, "workspace_bundle_v4_human_work_relation_invalid");
  } catch {
    return humanWorkRelationError();
  }
}

function humanWorkWorkspaceId(row: Record<string, unknown>, workspaceId: string): void {
  if (row.workspace_id !== workspaceId) humanWorkRelationError();
}

function humanWorkTimestamp(value: unknown): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return humanWorkRelationError();
  return value;
}

function humanWorkPositiveInteger(value: unknown): number {
  const number = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(number) || number < 1) return humanWorkRelationError();
  return number;
}

function humanWorkNonNegativeInteger(value: unknown): number {
  const number = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(number) || number < 0) return humanWorkRelationError();
  return number;
}

function humanWorkNullableId(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return humanWorkId(value);
}

function humanWorkArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) return humanWorkRelationError();
  return value;
}

function humanWorkNonEmptyText(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return humanWorkRelationError();
  return value;
}

function humanWorkObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return humanWorkRelationError();
  return value as Record<string, unknown>;
}

function isLegacyUnresolvedAttachmentMarker(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const marker = value as Record<string, unknown>;
  if (marker.kind !== "legacy_unresolved"
    || marker.reason !== "reference_unavailable"
    || !marker.ref || typeof marker.ref !== "object" || Array.isArray(marker.ref)
    || Object.keys(marker).some((key) => !["kind", "reason", "ref"].includes(key))) {
    return false;
  }
  const ref = marker.ref as Record<string, unknown>;
  return !Object.keys(ref).some((key) => !["kind", "id", "uri", "version", "label"].includes(key))
    && Object.values(ref).every((entry) => entry === null || typeof entry === "string");
}

/**
 * A legacy reply continuation is only meaningful when the delegated branch
 * that produced it has been fully settled.  Keep this check independent of
 * JSONL order and walk the complete delegated subtree: a terminal delegated
 * sibling with a queued/running descendant is still an incomplete snapshot.
 */
function hasSafeDelegatedSiblingSubtree(
  assignments: readonly Record<string, unknown>[],
  child: Record<string, unknown>,
  parentId: string,
  stoppedAssignments: ReadonlySet<string>,
): boolean {
  const siblings = assignments.filter((sibling) =>
    sibling.id !== child.id
    && sibling.work_id === child.work_id
    && sibling.parent_assignment_id === parentId
  );
  if (siblings.length === 0) return false;

  const assignmentById = new Map<string, Record<string, unknown>>();
  for (const assignment of assignments) {
    if (typeof assignment.id === "string") assignmentById.set(assignment.id, assignment);
  }

  const validateSubtree = (root: Record<string, unknown>): boolean => {
    const visited = new Set<string>();
    const pending = [root];
    while (pending.length > 0) {
      const assignment = pending.pop()!;
      const assignmentId = typeof assignment.id === "string" ? assignment.id : undefined;
      if (!assignmentId || visited.has(assignmentId)) return false;
      visited.add(assignmentId);

      if (assignment.work_id !== child.work_id
        || assignment.origin_kind !== "delegated"
        || !humanWorkTerminalStatuses.has(String(assignment.status))
        || isReassignedHumanWorkAssignment(assignment)
        || stoppedAssignments.has(assignmentId)) {
        return false;
      }

      const descendants = assignments.filter((candidate) =>
        candidate.work_id === child.work_id
        && candidate.parent_assignment_id === assignmentId
      );
      for (const descendant of descendants) {
        const descendantId = typeof descendant.id === "string" ? descendant.id : undefined;
        if (!descendantId || assignmentById.get(descendantId) !== descendant) return false;
        pending.push(descendant);
      }
    }
    return true;
  };

  return siblings.every(validateSubtree);
}

function isHumanWorkContinuationInstruction(instruction: Record<string, unknown>): boolean {
  return instruction.source_kind === "reply" || instruction.source_kind === "comment_reflection";
}

function isSyntheticParentContinuationInstruction(instruction: Record<string, unknown>): boolean {
  if (instruction.source_kind !== "reply" || typeof instruction.body !== "string") return false;
  try {
    const body = JSON.parse(instruction.body) as unknown;
    return !!body && typeof body === "object" && !Array.isArray(body)
      && (body as Record<string, unknown>).kind === "parent_continuation";
  } catch {
    return false;
  }
}

/**
 * v95/v96 created reply continuations before assignment origin metadata
 * existed.  Once v107 added the `normal`/`parent_continuation` distinction,
 * those historical rows could be serialized with `origin_kind=normal` even
 * though their parent edge represented a continuation.  Normalize only the
 * narrow, structurally provable legacy shape in memory; the source JSONL is
 * intentionally left unchanged so its historical provenance remains intact.
 *
 * A parent edge by itself is never enough.  The child must have the latest
 * reply instruction for its assignment, share the parent's Work/Room/Agent
 * and Agent version, point to a terminal non-reassigned parent, and have no
 * unsafe sibling (delegated siblings are valid historical evidence). Anything
 * ambiguous remains `normal` and is rejected by the normal relation checks
 * below.
 */
function normalizeLegacyParentContinuationOrigins(rows: Record<string, Record<string, unknown>[]>): void {
  const assignments = rows.workspace_human_work_assignments ?? [];
  const instructions = rows.workspace_human_work_instructions ?? [];
  const works = new Map(
    (rows.workspace_human_works ?? [])
      .filter((work) => typeof work.id === "string")
      .map((work) => [work.id as string, work])
  );
  const assignmentsById = new Map(
    assignments
      .filter((assignment) => typeof assignment.id === "string")
      .map((assignment) => [assignment.id as string, assignment])
  );
  const instructionsByAssignment = new Map<string, Record<string, unknown>[]>();
  for (const instruction of instructions) {
    if (typeof instruction.assignment_id !== "string") continue;
    const existing = instructionsByAssignment.get(instruction.assignment_id) ?? [];
    existing.push(instruction);
    instructionsByAssignment.set(instruction.assignment_id, existing);
  }
  const stoppedAssignments = new Set(
    (rows.workspace_human_work_controls ?? [])
      .filter((control) => control.action === "assignment_stop"
        && ["accepted", "pending", "confirmed", "unconfirmed"].includes(String(control.state)))
      .map((control) => control.assignment_id)
      .filter((assignmentId): assignmentId is string => typeof assignmentId === "string")
  );

  // Before v107 the assignment origin was not serialized.  A delegated
  // sibling can therefore only be recovered from the server-owned shape that
  // created it: a parent edge plus exactly one matching `system` instruction
  // for the same Assignment/Work/Room/version.  Infer this before looking for
  // a continuation so the strict checks below see the same graph as the
  // database.  Do not infer from the instruction body itself; a continuation
  // shaped system payload is an explicit forgery signal and remains rejected.
  for (const sibling of assignments) {
    const siblingId = typeof sibling.id === "string" ? sibling.id : undefined;
    const parentId = typeof sibling.parent_assignment_id === "string" ? sibling.parent_assignment_id : undefined;
    if (!siblingId || !parentId || (sibling.origin_kind !== undefined && sibling.origin_kind !== null)) continue;
    const parent = assignmentsById.get(parentId);
    const work = typeof sibling.work_id === "string" ? works.get(sibling.work_id) : undefined;
    if (!parent || !work
      || parent.work_id !== sibling.work_id
      || parent.room_id !== sibling.room_id
      || String(work.stop_state) !== "none"
      || isReassignedHumanWorkAssignment(parent)
      || isReassignedHumanWorkAssignment(sibling)
      || stoppedAssignments.has(parentId)
      || stoppedAssignments.has(siblingId)
      || Number(sibling.instruction_version) <= Number(parent.instruction_version)
      || Number(sibling.instruction_version) > Number(work.instruction_version)) continue;
    const matchingSystemInstructions = (instructionsByAssignment.get(siblingId) ?? []).filter((instruction) =>
      instruction.work_id === sibling.work_id
      && instruction.room_id === sibling.room_id
      && instruction.assignment_id === siblingId
      && instruction.source_kind === "system"
      && Number(instruction.version) === Number(sibling.instruction_version)
    );
    if (matchingSystemInstructions.length !== 1) continue;
    const body = matchingSystemInstructions[0]!.body;
    if (typeof body === "string") {
      try {
        const parsed = JSON.parse(body) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)
          && (parsed as Record<string, unknown>).kind === "parent_continuation") continue;
      } catch {
        // Delegated instruction bodies are opaque text; only the structured
        // continuation shape above is forbidden.
      }
    }
    sibling.origin_kind = "delegated";
  }

  const candidates = new Set<string>();
  for (const child of assignments) {
    const childId = typeof child.id === "string" ? child.id : undefined;
    const parentId = typeof child.parent_assignment_id === "string" ? child.parent_assignment_id : undefined;
    const originKind = child.origin_kind;
    if (!childId || !parentId || (originKind !== undefined && originKind !== null && originKind !== "normal")) continue;
    const parent = assignmentsById.get(parentId);
    const work = typeof child.work_id === "string" ? works.get(child.work_id) : undefined;
    if (!parent || !work
      || parent.work_id !== child.work_id
      || parent.room_id !== child.room_id
      || parent.agent_id !== child.agent_id
      || Number(parent.agent_version) !== Number(child.agent_version)
      || !humanWorkTerminalStatuses.has(String(parent.status))
      || String(child.status) === "outcome_unknown"
      || isReassignedHumanWorkAssignment(parent)
      || isReassignedHumanWorkAssignment(child)
      || String(work.stop_state) !== "none"
      || stoppedAssignments.has(parentId)
      || stoppedAssignments.has(childId)
      || Number(child.instruction_version) <= Number(parent.instruction_version)
      || Number(child.instruction_version) > Number(work.instruction_version)) continue;
    const continuationInstruction = (instructionsByAssignment.get(childId) ?? []).find((instruction) =>
      instruction.work_id === child.work_id
      && instruction.room_id === child.room_id
      && isHumanWorkContinuationInstruction(instruction)
      && Number(instruction.version) === Number(child.instruction_version));
    if (!continuationInstruction) continue;
    // A historical reply continuation may have a sibling created by the
    // delegation path.  Keep the compatibility projection aligned with the
    // database guard: delegated siblings are expected evidence, while a
    // normal/unknown, reassigned, or stopped sibling keeps the relation
    // ambiguous and fail-closed.
    if (!hasSafeDelegatedSiblingSubtree(assignments, child, parentId, stoppedAssignments)) continue;
    candidates.add(childId);
  }

  // A v95/v96 row may itself be the parent of another legacy reply.  The
  // immediate-child checks above are not enough in that case: an ancestor
  // that was reassigned, explicitly stopped, or is an unproven
  // `normal + parent` edge makes the whole chain ambiguous.  Walk every
  // ancestor before mutating any origin, allowing a normal parent edge only
  // when that ancestor is independently proven to be another reply child.
  const hasSafeParentChain = (child: Record<string, unknown>): boolean => {
    const visited = new Set<string>();
    let current = child;
    while (true) {
      const currentId = typeof current.id === "string" ? current.id : undefined;
      const parentId = typeof current.parent_assignment_id === "string" ? current.parent_assignment_id : undefined;
      if (!currentId || !parentId || visited.has(currentId)) return !parentId;
      visited.add(currentId);
      const parent = assignmentsById.get(parentId);
      const currentWork = typeof current.work_id === "string" ? works.get(current.work_id) : undefined;
      if (!parent
        || !currentWork
        || parent.work_id !== current.work_id
        || parent.room_id !== current.room_id
        || parent.agent_id !== current.agent_id
        || Number(parent.agent_version) !== Number(current.agent_version)
        || !humanWorkTerminalStatuses.has(String(parent.status))
        || String(current.status) === "outcome_unknown"
        || isReassignedHumanWorkAssignment(parent)
        || isReassignedHumanWorkAssignment(current)
        || String(currentWork.stop_state) !== "none"
        || stoppedAssignments.has(parentId)
        || stoppedAssignments.has(currentId)
        || Number(current.instruction_version) <= Number(parent.instruction_version)) return false;

      const currentOrigin = current.origin_kind;
      if (currentOrigin === "normal" || currentOrigin === undefined || currentOrigin === null) {
        // Only the original child and another independently proven legacy
        // reply may retain a parent edge while still marked normal.  An
        // arbitrary ancestor with that shape remains fail-closed.
        if (!candidates.has(currentId)) return false;
        const currentInstruction = (instructionsByAssignment.get(currentId) ?? []).find((instruction) =>
          instruction.work_id === current.work_id
          && instruction.room_id === current.room_id
          && isHumanWorkContinuationInstruction(instruction)
          && Number(instruction.version) === Number(current.instruction_version));
        if (!currentInstruction) return false;
      } else if (currentOrigin === "parent_continuation") {
        const currentInstruction = (instructionsByAssignment.get(currentId) ?? []).find((instruction) =>
          instruction.work_id === current.work_id
          && instruction.room_id === current.room_id
          && isHumanWorkContinuationInstruction(instruction)
          && Number(instruction.version) === Number(current.instruction_version));
        if (!currentInstruction) return false;
      } else if (currentOrigin !== "delegated") {
        return false;
      }
      if (!hasSafeDelegatedSiblingSubtree(assignments, current, parentId, stoppedAssignments)) return false;
      current = parent;
    }
  };
  for (const assignment of assignments) {
    if (typeof assignment.id === "string" && candidates.has(assignment.id) && hasSafeParentChain(assignment)) {
      assignment.origin_kind = "parent_continuation";
    }
  }

}

function isReassignedHumanWorkAssignment(assignment: Record<string, unknown>): boolean {
  const result = assignment.result;
  return !!result && typeof result === "object" && !Array.isArray(result)
    && (result as Record<string, unknown>).reason === "reassigned";
}

/**
 * Validates the Room/Agent/Account graph before an import reaches the
 * SECURITY DEFINER human-work entrypoint. This is intentionally separate from
 * the SQL function: the verifier must reject unknown references in an
 * untrusted Bundle, while the SQL function remains the final RLS-safe guard.
 */
async function assertPortableHumanWorkRelations(
  root: string,
  manifest: WorkspaceBundleV4Manifest,
  rows: Record<string, Record<string, unknown>[]>
): Promise<void> {
  const baseRoot = resolveBundlePath(root, baseV3Directory);
  let workspace: Record<string, unknown>;
  try {
    workspace = JSON.parse(await readFile(resolveBundlePath(baseRoot, "workspace.json"), "utf8")) as Record<string, unknown>;
  } catch {
    return humanWorkRelationError();
  }
  const baseRooms = await readJsonl(resolveBundlePath(baseRoot, "rooms.jsonl"));
  const baseAccounts = await readJsonl(resolveBundlePath(baseRoot, "accounts.jsonl"));
  const baseMemberships = await readJsonl(resolveBundlePath(baseRoot, "memberships.jsonl"));
  const baseRoomMemberships = await readJsonl(resolveBundlePath(baseRoot, "room-memberships.jsonl"));
  const baseFiles = await readJsonl(resolveBundlePath(baseRoot, "files.jsonl"));
  const workspaceId = manifest.workspace_id;
  const knownAccounts = new Set<string>();
  const ownerId = humanWorkId(workspace.created_by);
  knownAccounts.add(ownerId);
  for (const account of baseAccounts) {
    knownAccounts.add(humanWorkId(account.id));
  }
  for (const membership of [...baseMemberships, ...baseRoomMemberships]) {
    humanWorkWorkspaceId(membership, workspaceId);
    knownAccounts.add(humanWorkId(membership.account_id));
  }
  const roomIds = new Set<string>();
  const roomKinds = new Map<string, string>();
  for (const room of baseRooms) {
    humanWorkWorkspaceId(room, workspaceId);
    const roomId = humanWorkId(room.id);
    if (roomIds.has(roomId)) humanWorkRelationError();
    roomIds.add(roomId);
    const kind = room.room_kind === undefined || room.room_kind === null ? "normal" : String(room.room_kind);
    if (kind !== "normal" && kind !== "agent_dm") humanWorkRelationError();
    roomKinds.set(roomId, kind);
  }
  const explicitMemberships = new Map<string, string>();
  for (const membership of baseRoomMemberships) {
    const roomId = humanWorkId(membership.room_id);
    const accountId = humanWorkId(membership.account_id);
    if (!roomIds.has(roomId) || !knownAccounts.has(accountId)) humanWorkRelationError();
    const key = `${roomId}\u0000${accountId}`;
    if (explicitMemberships.has(key)) humanWorkRelationError();
    explicitMemberships.set(key, String(membership.state));
  }

  const agentIds = new Set<string>();
  const agentVersions = new Map<string, number>();
  const agentBackends = new Map<string, string>();
  for (const agent of rows.workspace_agents ?? []) {
    humanWorkWorkspaceId(agent, workspaceId);
    const agentId = humanWorkId(agent.id);
    if (agentIds.has(agentId)) humanWorkRelationError();
    agentIds.add(agentId);
    agentVersions.set(agentId, humanWorkPositiveInteger(agent.version));
    if (typeof agent.backend_id === "string" && agent.backend_id.trim()) agentBackends.set(agentId, agent.backend_id);
    if (!knownAccounts.has(humanWorkId(agent.created_by))) humanWorkRelationError();
    humanWorkTimestamp(agent.created_at);
    humanWorkTimestamp(agent.updated_at);
  }
  const permissions = new Map<string, Record<string, unknown>>();
  for (const permission of rows.workspace_agent_room_permissions ?? []) {
    humanWorkWorkspaceId(permission, workspaceId);
    const roomId = humanWorkId(permission.room_id);
    const agentId = humanWorkId(permission.agent_id);
    if (!roomIds.has(roomId) || !agentIds.has(agentId)
      || typeof permission.can_view !== "boolean" || typeof permission.can_edit !== "boolean"
      || typeof permission.can_execute !== "boolean" || !knownAccounts.has(humanWorkId(permission.created_by))) {
      humanWorkRelationError();
    }
    humanWorkPositiveInteger(permission.version);
    humanWorkTimestamp(permission.created_at);
    humanWorkTimestamp(permission.updated_at);
    const key = `${roomId}\u0000${agentId}`;
    if (permissions.has(key)) humanWorkRelationError();
    permissions.set(key, permission);
  }
  for (const connection of rows.workspace_connection_descriptors ?? []) {
    humanWorkWorkspaceId(connection, workspaceId);
    const agentId = humanWorkNullableId(connection.agent_id);
    if ((agentId && !agentIds.has(agentId))
      || !knownAccounts.has(humanWorkId(connection.principal_account_id))
      || !knownAccounts.has(humanWorkId(connection.created_by))
      || connection.status === "active"
      || !["revoked", "expired"].includes(String(connection.status))
      || !Array.isArray(connection.allowed_room_ids)
      || connection.allowed_room_ids.some((roomId) => !roomIds.has(humanWorkId(roomId)))
      || humanWorkPositiveInteger(connection.room_limit) < connection.allowed_room_ids.length) {
      humanWorkRelationError();
    }
    humanWorkId(connection.id);
    humanWorkId(connection.connector_id);
    humanWorkId(connection.app_id);
    humanWorkPositiveInteger(connection.version);
    humanWorkTimestamp(connection.expires_at);
    humanWorkTimestamp(connection.created_at);
    humanWorkTimestamp(connection.updated_at);
    if (connection.revoked_at !== null && connection.revoked_at !== undefined) humanWorkTimestamp(connection.revoked_at);
    if (!Array.isArray(connection.ingress_classes) || connection.ingress_classes.some((entry) => typeof entry !== "string" || !entry.trim())) humanWorkRelationError();
  }

  // Room settings are stored in the embedded V3 Rooms file. Old V3/V4 rows
  // omit the additive columns and therefore behave as normal Rooms.
  for (const room of baseRooms) {
    const roomId = humanWorkId(room.id);
    const kind = room.room_kind === undefined || room.room_kind === null ? "normal" : room.room_kind;
    if (kind !== "normal" && kind !== "agent_dm") humanWorkRelationError();
    const agentId = humanWorkNullableId(room.default_agent_id);
    const agentVersion = room.default_agent_version === undefined || room.default_agent_version === null || room.default_agent_version === ""
      ? undefined
      : humanWorkPositiveInteger(room.default_agent_version);
    if ((agentId === undefined) !== (agentVersion === undefined)
      || (agentId !== undefined && !agentIds.has(agentId))
      || (agentId !== undefined && agentVersions.get(agentId)! < agentVersion!)) {
      humanWorkRelationError();
    }
    const dmAccountId = humanWorkNullableId(room.dm_account_id);
    if ((kind === "normal" && dmAccountId !== undefined)
      || (kind === "agent_dm" && (dmAccountId === undefined || agentId === undefined))
      || (dmAccountId !== undefined && !knownAccounts.has(dmAccountId))) {
      humanWorkRelationError();
    }
    if (kind === "agent_dm") {
      if (explicitMemberships.get(`${roomId}\u0000${dmAccountId}`) !== "active") humanWorkRelationError();
      const permission = permissions.get(`${roomId}\u0000${agentId}`);
      if (!permission || permission.can_view !== true || permission.can_execute !== true) humanWorkRelationError();
    }
  }

  const portableFiles = new Map<string, { roomId: string; version: number; sha256: string }>();
  for (const file of baseFiles) {
    humanWorkWorkspaceId(file, workspaceId);
    const filePath = typeof file.path === "string" ? file.path : humanWorkRelationError();
    try {
      assertSafeRelativePath(filePath);
    } catch {
      humanWorkRelationError();
    }
    const roomId = humanWorkId(file.room_id);
    const version = humanWorkPositiveInteger(file.version);
    const sha256 = typeof file.sha256 === "string" && /^[a-f0-9]{64}$/.test(file.sha256)
      ? file.sha256
      : humanWorkRelationError();
    if (!roomIds.has(roomId) || portableFiles.has(filePath)
      || manifest.files[`${baseV3Directory}/files/${filePath}`] !== sha256) {
      humanWorkRelationError();
    }
    portableFiles.set(filePath, { roomId, version, sha256 });
  }

  const completionResources = new Map<string, Record<string, unknown>>();
  for (const resource of rows.workspace_completion_resources ?? []) {
    humanWorkWorkspaceId(resource, workspaceId);
    if (typeof resource.id !== "string" || !/^[a-z][a-z0-9_:-]{0,127}$/.test(resource.id)
      || (resource.resource_kind !== "knowledge" && resource.resource_kind !== "skill" && resource.resource_kind !== "policy")
      || completionResources.has(resource.id)) {
      humanWorkResourceReferenceError("invalid");
    }
    completionResources.set(resource.id, resource);
  }
  const completionResourceVersions = new Map<string, Record<string, unknown>>();
  for (const version of rows.workspace_completion_resource_versions ?? []) {
    humanWorkWorkspaceId(version, workspaceId);
    const resourceId = typeof version.resource_id === "string" ? version.resource_id : "";
    const versionNumber = numberValue(version.version);
    if (!resourceId || versionNumber === undefined || completionResourceVersions.has(`${resourceId}\u0000${versionNumber}`)) {
      humanWorkResourceReferenceError("invalid");
    }
    completionResourceVersions.set(`${resourceId}\u0000${versionNumber}`, version);
  }

  const assertPortableHumanWorkResourceRefs = (value: unknown, roomId: string): void => {
    const entries = value === undefined || value === null ? [] : humanWorkArray(value);
    if (entries.length > 32) humanWorkResourceReferenceError("invalid");
    for (const entry of entries) {
      const ref = humanWorkObject(entry);
      const keys = Object.keys(ref);
      if (keys.some((key) => !["kind", "id", "uri", "version", "label"].includes(key))
        || (ref.kind !== "knowledge" && ref.kind !== "skill")
        || typeof ref.id !== "string" || !/^[a-z][a-z0-9_:-]{0,127}$/.test(ref.id)
        || typeof ref.uri !== "string" || ref.uri.length === 0 || ref.uri.length > 4_096 || ref.uri.includes("\u0000")
        || ref.version !== undefined && (typeof ref.version !== "string" || !/^[1-9][0-9]*$/.test(ref.version))
        || ref.label !== undefined && (typeof ref.label !== "string" || ref.label.length === 0 || ref.label.length > 4_096 || ref.label.includes("\u0000"))) {
        humanWorkResourceReferenceError("invalid");
      }
      const resource = completionResources.get(ref.id);
      if (!resource || resource.resource_kind !== ref.kind || resource.lifecycle_state === "archived") {
        humanWorkResourceReferenceError("not_found");
      }
      if (resource.scope_kind !== "workspace"
        && (resource.scope_kind !== "room" || resource.room_id !== roomId)) {
        humanWorkResourceReferenceError("scope_invalid");
      }
      const currentVersion = numberValue(resource.current_confirmed_version ?? resource.current_provisional_version);
      const versionKey = `${ref.id}\u0000${ref.version ?? currentVersion ?? ""}`;
      const resourceVersion = completionResourceVersions.get(versionKey);
      if (!resourceVersion || resourceVersion.lifecycle_state === "archived"
        || resourceVersion.file_path !== ref.uri
        || ref.label !== undefined && resource.title !== ref.label) {
        humanWorkResourceReferenceError("invalid");
      }
    }
  };

  const assertPortableAttachmentRefs = async (value: unknown, roomId: string): Promise<void> => {
    const entries = humanWorkArray(value);
    if (entries.length > 32) humanWorkRelationError();
    const validRefs = [];
    for (const entry of entries) {
      if (isLegacyUnresolvedAttachmentMarker(entry)) continue;
      const parsed = WorkspaceFileResourceRefSchema.safeParse(entry);
      if (!parsed.success) humanWorkRelationError();
      validRefs.push(parsed.data);
    }
    for (const ref of validRefs) {
      try {
        assertSafeRelativePath(ref.uri);
      } catch {
        humanWorkRelationError();
      }
      const file = portableFiles.get(ref.uri);
      if (!file || file.roomId !== roomId || file.sha256 !== ref.id
        || String(file.version) !== ref.version
        || manifest.files[`${baseV3Directory}/files/${ref.uri}`] !== ref.id) {
        humanWorkRelationError();
      }
      try {
        const content = await readFile(resolveBundlePath(baseRoot, `files/${ref.uri}`));
        if (hashBytes(content) !== file.sha256) humanWorkRelationError();
      } catch {
        humanWorkRelationError();
      }
    }
  };

  const works = rows.workspace_human_works ?? [];
  const workById = new Map<string, Record<string, unknown>>();
  const workOperationIds = new Set<string>();
  for (const work of works) {
    humanWorkWorkspaceId(work, workspaceId);
    const workId = humanWorkId(work.id);
    const roomId = humanWorkId(work.room_id);
    const operationId = humanWorkId(work.operation_id);
    const defaultAgentId = humanWorkId(work.default_agent_id);
    const status = String(work.status);
    const stopState = String(work.stop_state);
    if (workById.has(workId) || workOperationIds.has(operationId)
      || !roomIds.has(roomId) || !knownAccounts.has(humanWorkId(work.requester_account_id))
      || !agentIds.has(defaultAgentId) || !["queued", "running", "waiting", "blocked", "completed", "failed", "cancelled"].includes(status)
      || !["none", "requested", "confirmed", "unconfirmed"].includes(stopState)
      || humanWorkNonEmptyText(work.title).length > 500
      || !humanWorkNonEmptyText(work.objective)
      || humanWorkArray(work.completion_criteria).length > 100
      || humanWorkPositiveInteger(work.default_agent_version) < 1
      || humanWorkPositiveInteger(work.instruction_version) < 1
      || humanWorkNonNegativeInteger(work.control_generation) < 0) {
      humanWorkRelationError();
    }
    humanWorkTimestamp(work.created_at);
    humanWorkTimestamp(work.updated_at);
    assertPortableHumanWorkResourceRefs(work.resource_refs, roomId);
    workById.set(workId, work);
    workOperationIds.add(operationId);
  }

  const assignments = rows.workspace_human_work_assignments ?? [];
  const assignmentById = new Map<string, Record<string, unknown>>();
  for (const assignment of assignments) {
    humanWorkWorkspaceId(assignment, workspaceId);
    const assignmentId = humanWorkId(assignment.id);
    const workId = humanWorkId(assignment.work_id);
    const roomId = humanWorkId(assignment.room_id);
    const parentId = humanWorkNullableId(assignment.parent_assignment_id);
    const originKind = assignment.origin_kind === undefined || assignment.origin_kind === null
      ? undefined
      : String(assignment.origin_kind);
    const dependencyIds = assignment.dependency_assignment_ids === null || assignment.dependency_assignment_ids === undefined
      ? []
      : Array.isArray(assignment.dependency_assignment_ids)
        ? assignment.dependency_assignment_ids.map((value) => humanWorkId(value))
        : humanWorkRelationError();
    const status = String(assignment.status);
    const work = workById.get(workId);
    if (assignmentById.has(assignmentId) || !work || work.room_id !== roomId
      || roomKinds.get(roomId) === "agent_dm" && parentId !== undefined
      || !agentIds.has(humanWorkId(assignment.agent_id)) || !humanAssignmentStatuses.has(status)
      || originKind !== undefined && !["normal", "delegated", "parent_continuation"].includes(originKind)
      || agentVersions.get(humanWorkId(assignment.agent_id))! < humanWorkPositiveInteger(assignment.agent_version)
      || humanWorkPositiveInteger(assignment.agent_version) < 1
      || humanWorkPositiveInteger(assignment.instruction_version) < 1
      || humanWorkNonNegativeInteger(assignment.attempt) < 0
      || typeof assignment.priority !== "number" && typeof assignment.priority !== "string"
      || assignment.lease_owner !== null && assignment.lease_owner !== undefined
      || assignment.lease_expires_at !== null && assignment.lease_expires_at !== undefined) {
      humanWorkRelationError();
    }
    humanWorkNonNegativeInteger(assignment.attempt);
    if (!Number.isSafeInteger(Number(assignment.priority))) humanWorkRelationError();
    if (parentId === assignmentId || new Set(dependencyIds).size !== dependencyIds.length
      || dependencyIds.includes(assignmentId) || dependencyIds.includes(parentId ?? "")) humanWorkRelationError();
    humanWorkTimestamp(assignment.created_at);
    humanWorkTimestamp(assignment.updated_at);
    if (assignment.started_at !== null && assignment.started_at !== undefined) humanWorkTimestamp(assignment.started_at);
    if (assignment.completed_at !== null && assignment.completed_at !== undefined) humanWorkTimestamp(assignment.completed_at);
    if (assignment.current_run_id !== null && assignment.current_run_id !== undefined) humanWorkId(assignment.current_run_id);
    if (assignment.result !== null && assignment.result !== undefined) humanWorkObject(assignment.result);
    assignmentById.set(assignmentId, assignment);
  }
  for (const assignment of assignments) {
    const parentId = humanWorkNullableId(assignment.parent_assignment_id);
    const originKind = assignment.origin_kind === undefined || assignment.origin_kind === null
      ? undefined
      : String(assignment.origin_kind);
    if (parentId) {
      const parent = assignmentById.get(parentId);
      if (!parent || parent.work_id !== assignment.work_id) humanWorkRelationError();
    }
    // Bundles from before v107 omit this server-only field and remain
    // readable; when it is present, however, its parent/Agent relation is
    // part of the restore contract. In particular, a forged continuation
    // cannot inherit an unrelated parent's SessionRef.
    if (originKind === "normal" && parentId) humanWorkRelationError();
    // A missing origin is only compatible with pre-v107 data after the
    // normalization pass has proved the exact delegated/reply structure. Any
    // remaining parent edge is unknown or ambiguous and must fail closed.
    if (originKind === undefined && parentId) humanWorkRelationError();
    if (originKind !== undefined && originKind !== "normal" && !parentId) humanWorkRelationError();
    if (originKind === "parent_continuation" && parentId) {
      const parent = assignmentById.get(parentId);
      if (!parent
        || !["completed", "failed", "cancelled"].includes(String(parent.status))
        || parent.agent_id !== assignment.agent_id
        || Number(parent.agent_version) !== Number(assignment.agent_version)) {
        humanWorkRelationError();
      }
    }
    const dependencyIds = Array.isArray(assignment.dependency_assignment_ids) ? assignment.dependency_assignment_ids : [];
    for (const dependencyId of dependencyIds) {
      const dependency = assignmentById.get(humanWorkId(dependencyId));
      if (!dependency || dependency.work_id !== assignment.work_id || dependency.room_id !== assignment.room_id) humanWorkRelationError();
    }
  }
  assertPortableRuntimeBindingRelations(rows, workspaceId, workById, assignmentById, agentIds, agentVersions, agentBackends);
  const visitingAssignments = new Set<string>();
  const visitedAssignments = new Set<string>();
  const visitAssignment = (assignmentId: string): void => {
    if (visitingAssignments.has(assignmentId)) humanWorkRelationError();
    if (visitedAssignments.has(assignmentId)) return;
    const assignment = assignmentById.get(assignmentId);
    if (!assignment) humanWorkRelationError();
    visitingAssignments.add(assignmentId);
    const parent = humanWorkNullableId(assignment.parent_assignment_id);
    if (parent) visitAssignment(parent);
    const dependencyIds = Array.isArray(assignment.dependency_assignment_ids) ? assignment.dependency_assignment_ids : [];
    for (const dependencyId of dependencyIds) visitAssignment(humanWorkId(dependencyId));
    visitingAssignments.delete(assignmentId);
    visitedAssignments.add(assignmentId);
  };
  for (const assignment of assignments) visitAssignment(humanWorkId(assignment.id));

  const continuationParents = new Set<string>();
  for (const assignment of assignments) {
    if (assignment.origin_kind !== "parent_continuation") continue;
    const parentId = humanWorkNullableId(assignment.parent_assignment_id);
    if (!parentId || continuationParents.has(parentId)) humanWorkRelationError();
    continuationParents.add(parentId);
  }

  const instructions = rows.workspace_human_work_instructions ?? [];
  const instructionById = new Map<string, Record<string, unknown>>();
  const instructionVersions = new Set<string>();
  for (const instruction of instructions) {
    humanWorkWorkspaceId(instruction, workspaceId);
    const instructionId = humanWorkId(instruction.id);
    const workId = humanWorkId(instruction.work_id);
    const roomId = humanWorkId(instruction.room_id);
    const assignmentId = humanWorkNullableId(instruction.assignment_id);
    const sourceCommentId = humanWorkNullableId(instruction.source_comment_id);
    const sourceCommentVersion = instruction.source_comment_version === null || instruction.source_comment_version === undefined
      ? undefined
      : humanWorkPositiveInteger(instruction.source_comment_version);
    const version = humanWorkPositiveInteger(instruction.version);
    const key = `${workId}\u0000${version}`;
    const attachmentRefs = humanWorkArray(instruction.attachment_refs);
    const body = typeof instruction.body === "string" ? instruction.body.trim() : "";
    if (instructionById.has(instructionId) || instructionVersions.has(key)
      || !workById.has(workId) || workById.get(workId)!.room_id !== roomId
      || (assignmentId !== undefined && (!assignmentById.has(assignmentId) || assignmentById.get(assignmentId)!.work_id !== workId || assignmentById.get(assignmentId)!.room_id !== roomId))
      || body.length === 0 && attachmentRefs.length === 0
      || !["request", "reply", "comment_reflection", "system"].includes(String(instruction.source_kind))
      || !["pending", "accepted", "delivered", "applied", "failed"].includes(String(instruction.state))
      || !knownAccounts.has(humanWorkId(instruction.created_by))
      || (sourceCommentId === undefined) !== (sourceCommentVersion === undefined)) {
      humanWorkRelationError();
    }
    humanWorkTimestamp(instruction.created_at);
    assertPortableHumanWorkResourceRefs(instruction.resource_refs, roomId);
    await assertPortableAttachmentRefs(attachmentRefs, roomId);
    instructionById.set(instructionId, instruction);
    instructionVersions.add(key);
  }

  const comments = rows.workspace_human_work_comments ?? [];
  const commentById = new Map<string, Record<string, unknown>>();
  const commentVersions = new Set<string>();
  for (const comment of comments) {
    humanWorkWorkspaceId(comment, workspaceId);
    const commentId = humanWorkId(comment.id);
    const workId = humanWorkId(comment.work_id);
    const roomId = humanWorkId(comment.room_id);
    const version = humanWorkPositiveInteger(comment.version);
    const key = `${workId}\u0000${version}`;
    const attachmentRefs = humanWorkArray(comment.attachment_refs);
    const body = typeof comment.body === "string" ? comment.body.trim() : "";
    if (commentById.has(commentId) || commentVersions.has(key)
      || !workById.has(workId) || workById.get(workId)!.room_id !== roomId
      || !knownAccounts.has(humanWorkId(comment.author_account_id))
      || body.length === 0 && attachmentRefs.length === 0) {
      humanWorkRelationError();
    }
    humanWorkTimestamp(comment.created_at);
    await assertPortableAttachmentRefs(attachmentRefs, roomId);
    commentById.set(commentId, comment);
    commentVersions.add(key);
  }
  for (const instruction of instructions) {
    const commentId = humanWorkNullableId(instruction.source_comment_id);
    if (commentId !== undefined) {
      const comment = commentById.get(commentId);
      if (!comment || comment.work_id !== instruction.work_id || Number(comment.version) !== Number(instruction.source_comment_version)) humanWorkRelationError();
    }
  }

  const reactions = rows.workspace_human_work_comment_reactions ?? [];
  const reactionById = new Set<string>();
  const reactionKeys = new Set<string>();
  for (const reaction of reactions) {
    humanWorkWorkspaceId(reaction, workspaceId);
    const reactionId = humanWorkId(reaction.id);
    const workId = humanWorkId(reaction.work_id);
    const roomId = humanWorkId(reaction.room_id);
    const commentId = humanWorkId(reaction.comment_id);
    const key = `${commentId}\u0000${humanWorkId(reaction.actor_account_id)}\u0000${reaction.reaction}`;
    const comment = commentById.get(commentId);
    if (reactionById.has(reactionId) || reactionKeys.has(key) || !comment
      || comment.work_id !== workId || comment.room_id !== roomId
      || !knownAccounts.has(humanWorkId(reaction.actor_account_id)) || reaction.reaction !== "like"
      || typeof reaction.enabled !== "boolean" || humanWorkPositiveInteger(reaction.version) < 1) {
      humanWorkRelationError();
    }
    humanWorkTimestamp(reaction.created_at);
    humanWorkTimestamp(reaction.updated_at);
    reactionById.add(reactionId);
    reactionKeys.add(key);
  }

  const controls = rows.workspace_human_work_controls ?? [];
  const controlById = new Set<string>();
  const controlOperations = new Set<string>();
  for (const control of controls) {
    humanWorkWorkspaceId(control, workspaceId);
    const controlId = humanWorkId(control.id);
    const workId = humanWorkId(control.work_id);
    const roomId = humanWorkId(control.room_id);
    const assignmentId = humanWorkNullableId(control.assignment_id);
    const operationId = humanWorkId(control.operation_id);
    if (controlById.has(controlId) || controlOperations.has(operationId)
      || !workById.has(workId) || workById.get(workId)!.room_id !== roomId
      || (assignmentId !== undefined && (!assignmentById.has(assignmentId) || assignmentById.get(assignmentId)!.work_id !== workId || assignmentById.get(assignmentId)!.room_id !== roomId))
      || !["stop_request", "stop_confirm", "stop_unconfirmed", "resume", "assignment_stop", "reassign"].includes(String(control.action))
      || !["accepted", "pending", "confirmed", "failed", "unconfirmed"].includes(String(control.state))
      || !knownAccounts.has(humanWorkId(control.actor_account_id))) {
      humanWorkRelationError();
    }
    humanWorkNonNegativeInteger(control.generation);
    humanWorkObject(control.details);
    humanWorkTimestamp(control.created_at);
    humanWorkTimestamp(control.updated_at);
    controlById.add(controlId);
    controlOperations.add(operationId);
  }

  assertPortableParentContinuationRelations(assignments, assignmentById, workById, instructions, controls);

  const reservations = rows.workspace_human_work_launch_reservations ?? [];
  const reservationById = new Set<string>();
  const reservationOperations = new Set<string>();
  for (const reservation of reservations) {
    humanWorkWorkspaceId(reservation, workspaceId);
    const reservationId = humanWorkId(reservation.id);
    const workId = humanWorkId(reservation.work_id);
    const assignmentId = humanWorkId(reservation.assignment_id);
    const roomId = humanWorkId(reservation.room_id);
    const operationId = humanWorkId(reservation.operation_id);
    const status = String(reservation.status);
    const assignment = assignmentById.get(assignmentId);
    if (reservationById.has(reservationId) || reservationOperations.has(operationId)
      || !assignment || assignment.work_id !== workId || assignment.room_id !== roomId
      || !["reserved", "claimed", "released", "cancelled"].includes(status)
      || reservation.lease_owner !== null && reservation.lease_owner !== undefined
      || reservation.lease_expires_at !== null && reservation.lease_expires_at !== undefined
      || (status === "claimed") !== (reservation.claimed_at !== null && reservation.claimed_at !== undefined)
      || (["released", "cancelled"].includes(status) && reservation.released_at === null || ["released", "cancelled"].includes(status) && reservation.released_at === undefined)) {
      humanWorkRelationError();
    }
    humanWorkNonNegativeInteger(reservation.generation);
    humanWorkTimestamp(reservation.scheduled_at);
    humanWorkTimestamp(reservation.created_at);
    humanWorkTimestamp(reservation.updated_at);
    if (reservation.claimed_at !== null && reservation.claimed_at !== undefined) humanWorkTimestamp(reservation.claimed_at);
    if (reservation.released_at !== null && reservation.released_at !== undefined) humanWorkTimestamp(reservation.released_at);
    reservationById.add(reservationId);
    reservationOperations.add(operationId);
  }

  const sessions = new Map<string, Record<string, unknown>>();
  for (const session of rows.workspace_runtime_sessions ?? []) {
    if (session.workspace_id !== workspaceId) humanWorkRelationError();
    const sessionId = humanWorkId(session.id);
    if (sessions.has(sessionId)) humanWorkRelationError();
    sessions.set(sessionId, session);
  }
  const legacyMappings = rows.workspace_human_work_legacy_sessions ?? [];
  const legacyById = new Set<string>();
  const legacyBySession = new Set<string>();
  const legacyByWork = new Set<string>();
  const legacyByOperation = new Set<string>();
  for (const mapping of legacyMappings) {
    humanWorkWorkspaceId(mapping, workspaceId);
    const mappingId = humanWorkId(mapping.id);
    const sessionId = humanWorkId(mapping.legacy_session_id);
    const roomId = humanWorkId(mapping.room_id);
    const workId = humanWorkId(mapping.work_id);
    const operationId = humanWorkId(mapping.operation_id);
    const session = sessions.get(sessionId);
    if (legacyById.has(mappingId) || legacyBySession.has(sessionId) || legacyByWork.has(workId) || legacyByOperation.has(operationId)
      || !session || session.room_id !== roomId || !roomIds.has(roomId) || !workById.has(workId)
      || workById.get(workId)!.room_id !== roomId || !knownAccounts.has(humanWorkId(mapping.created_by))) {
      humanWorkRelationError();
    }
    humanWorkTimestamp(mapping.created_at);
    humanWorkTimestamp(mapping.updated_at);
    legacyById.add(mappingId);
    legacyBySession.add(sessionId);
    legacyByWork.add(workId);
    legacyByOperation.add(operationId);
  }
}

/**
 * Parent continuations are server-owned continuation edges, not arbitrary
 * child assignments. Keep the import verifier aligned with the database
 * guard: an existing continuation must have a terminal, non-reassigned
 * ancestor chain, no active assignment stop, and an unstopped Work. A
 * delegated sibling is required for a synthetic system continuation; a direct
 * user reply/comment continuation may legitimately have no sibling. A second
 * continuation or an untyped sibling makes the snapshot ambiguous. This
 * check never rewrites a `parent_continuation` row.
 */
function assertPortableParentContinuationRelations(
  assignments: readonly Record<string, unknown>[],
  assignmentById: ReadonlyMap<string, Record<string, unknown>>,
  workById: ReadonlyMap<string, Record<string, unknown>>,
  instructions: readonly Record<string, unknown>[],
  controls: readonly Record<string, unknown>[]
): void {
  const activeAssignmentStops = new Set(
    controls
      .filter((control) => control.action === "assignment_stop"
        && ["accepted", "pending", "confirmed", "unconfirmed"].includes(String(control.state)))
      .map((control) => control.assignment_id)
      .filter((assignmentId): assignmentId is string => typeof assignmentId === "string")
  );
  const instructionsByAssignment = new Map<string, Record<string, unknown>[]>();
  for (const instruction of instructions) {
    const assignmentId = instruction.assignment_id;
    if (typeof assignmentId !== "string") continue;
    const current = instructionsByAssignment.get(assignmentId) ?? [];
    current.push(instruction);
    instructionsByAssignment.set(assignmentId, current);
  }
  const continuationParents = new Set<string>();
  const assertParentContinuationInstruction = (assignment: Record<string, unknown>): Record<string, unknown> => {
    const assignmentId = humanWorkId(assignment.id);
    const instruction = (instructionsByAssignment.get(assignmentId) ?? []).find((candidate) =>
      candidate.work_id === assignment.work_id
      && candidate.room_id === assignment.room_id
      && Number(candidate.version) === Number(assignment.instruction_version)
      && isHumanWorkContinuationInstruction(candidate)
    );
    if (!instruction) humanWorkRelationError();
    return instruction;
  };
  const assertChain = (target: Record<string, unknown>): void => {
    const visited = new Set<string>();
    let current = target;
    while (true) {
      const currentId = humanWorkId(current.id);
      const parentId = humanWorkNullableId(current.parent_assignment_id);
      if (!parentId) return;
      if (visited.has(currentId)) humanWorkRelationError();
      visited.add(currentId);
      const parent = assignmentById.get(parentId);
      const work = workById.get(humanWorkId(current.work_id));
      if (!parent || !work
        || parent.work_id !== current.work_id
        || parent.room_id !== current.room_id
        || String(work.stop_state) !== "none"
        || !humanWorkTerminalStatuses.has(String(parent.status))
        || isReassignedHumanWorkAssignment(current)
        || isReassignedHumanWorkAssignment(parent)
        || activeAssignmentStops.has(currentId)
        || activeAssignmentStops.has(parentId)) {
        humanWorkRelationError();
      }
      const currentOrigin = current.origin_kind === undefined || current.origin_kind === null
        ? undefined
        : String(current.origin_kind);
      if (currentId !== humanWorkId(target.id)
        && currentOrigin === "normal") humanWorkRelationError();
      if (currentOrigin === "parent_continuation") {
        const instruction = assertParentContinuationInstruction(current);
        const siblings = assignments.filter((sibling) =>
          sibling.id !== current.id
          && sibling.work_id === current.work_id
          && sibling.parent_assignment_id === parentId
        );
        if ((siblings.length > 0 || isSyntheticParentContinuationInstruction(instruction))
          && !hasSafeDelegatedSiblingSubtree(assignments, current, parentId, activeAssignmentStops)) {
          humanWorkRelationError();
        }
      }
      current = parent;
    }
  };

  for (const assignment of assignments) {
    if (assignment.origin_kind !== "parent_continuation") continue;
    const assignmentId = humanWorkId(assignment.id);
    const parentId = humanWorkNullableId(assignment.parent_assignment_id);
    const work = workById.get(humanWorkId(assignment.work_id));
    if (!parentId || !work || String(work.stop_state) !== "none"
      || continuationParents.has(parentId)
      || isReassignedHumanWorkAssignment(assignment)
      || activeAssignmentStops.has(assignmentId)) {
      humanWorkRelationError();
    }
    continuationParents.add(parentId);
    assertParentContinuationInstruction(assignment);
    assertChain(assignment);
  }
}

/**
 * Produces the target-side projection for the guarded import function. A
 * Bundle can contain an in-flight source snapshot, but its target must start
 * with no runnable work, no current run, and no claimable reservation.
 */
function prepareHumanWorkRowsForRestore(
  rows: Record<string, Record<string, unknown>[]>,
  context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">,
  manifest: WorkspaceBundleV4Manifest
): Record<string, Record<string, unknown>[]> {
  const prepared = { ...rows };
  const works = (rows.workspace_human_works ?? []).map((row) => ({ ...row }));
  const assignments = (rows.workspace_human_work_assignments ?? []).map((row) => ({ ...row }));
  const reservations = (rows.workspace_human_work_launch_reservations ?? []).map((row) => ({ ...row }));
  const controls = (rows.workspace_human_work_controls ?? []).map((row) => ({ ...row }));
  for (const work of works) {
    const sourceStatus = String(work.status);
    const sourceStopState = work.stop_state;
    if (sourceStatus !== "queued" && sourceStatus !== "running") continue;
    work.status = "blocked";
    work.stop_state = "unconfirmed";
    const generation = Number(work.control_generation);
    const nextGeneration = Number.isSafeInteger(generation) && generation >= 0 ? generation + 1 : 1;
    work.control_generation = nextGeneration;
    if (controls.some((control) => control.work_id === work.id && control.action === "stop_unconfirmed")) continue;
    const restoredAt = typeof work.updated_at === "string" ? work.updated_at : new Date().toISOString();
    controls.push({
      workspace_id: context.workspaceId,
      id: completionId("restore_stop_unconfirmed", manifest.workspace_id, `${manifest.integrity_hash}:${String(work.id)}`),
      work_id: work.id,
      assignment_id: null,
      room_id: work.room_id,
      action: "stop_unconfirmed",
      state: "unconfirmed",
      actor_account_id: context.accountId,
      generation: nextGeneration,
      operation_id: completionId("restore_stop_operation", manifest.workspace_id, `${manifest.integrity_hash}:${String(work.id)}`),
      details: {
        reason: "workspace_bundle_restore_interrupted",
        source_status: sourceStatus,
        source_stop_state: sourceStopState
      },
      created_at: restoredAt,
      updated_at: restoredAt
    });
  }
  for (const assignment of assignments) {
    if (!["queued", "ready", "running"].includes(String(assignment.status))) continue;
    assignment.status = "waiting";
    assignment.current_run_id = null;
    assignment.lease_owner = null;
    assignment.lease_expires_at = null;
  }
  for (const reservation of reservations) {
    if (!["reserved", "claimed"].includes(String(reservation.status))) continue;
    reservation.status = "cancelled";
    reservation.lease_owner = null;
    reservation.lease_expires_at = null;
    reservation.claimed_at = null;
    reservation.released_at = reservation.released_at
      ?? reservation.updated_at
      ?? reservation.created_at
      ?? new Date().toISOString();
  }
  prepared.workspace_human_works = works;
  prepared.workspace_human_work_assignments = assignments;
  prepared.workspace_human_work_launch_reservations = reservations;
  prepared.workspace_human_work_controls = controls;
  return prepared;
}

/**
 * Opaque provider payloads must never decide whether a restored Runtime can
 * resume an external conversation. Normalize only the established provider
 * key shapes, so provider handles are excluded without deleting unrelated
 * Workspace-specific metadata. Canonical Workspace `session_id` /
 * `session_ref` columns are handled separately and remain portable.
 */
function isPortableRuntimeProviderIdentifierKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (normalized === "sessionid" || normalized === "threadid" || normalized === "conversationid") return true;
  return /^(?:(?:provider|backend|native|codex|claude|gemini|openai|anthropic|google|vertex|azure|ollama|external|remote))+(?:session|thread|conversation)(?:id|ref)?$/.test(normalized);
}

function stripPortableRuntimeProviderIdentifiers(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripPortableRuntimeProviderIdentifiers);
  if (!value || typeof value !== "object" || value instanceof Date) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !isPortableRuntimeProviderIdentifierKey(key))
      .map(([key, nested]) => [key, stripPortableRuntimeProviderIdentifiers(nested)])
  );
}

function assertPortableRuntimeProviderIdentifiersAbsent(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) assertPortableRuntimeProviderIdentifiersAbsent(item);
    return;
  }
  if (!value || typeof value !== "object" || value instanceof Date) return;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (isPortableRuntimeProviderIdentifierKey(key)) {
      throw new WorkspaceServerError("workspace_bundle_v4_provider_identifier_forbidden", 400);
    }
    assertPortableRuntimeProviderIdentifiersAbsent(nested);
  }
}

function portableMigrationReceiptCounts(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const counts = value as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(counts, "blocked_secret_resources")) return counts;
  const { blocked_secret_resources: blocked, ...portable } = counts;
  return {
    ...portable,
    filtered_resource_count: Array.isArray(blocked) ? blocked.length : 0
  };
}

function portableConnectionDescriptorRow(row: Record<string, unknown>): Record<string, unknown> {
  if (row.status !== "active") return row;
  // A descriptor without its credential must never remain executable after a
  // restore. Preserve the metadata but force an explicit re-authentication.
  return {
    ...row,
    status: "revoked",
    revoked_at: row.revoked_at ?? row.updated_at
  };
}

function portableValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(portableValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, portableValue(child)]));
  return value;
}

const organizationIdentifierKeyNames = new Set([
  "organizationid", "sourceorganizationid", "targetorganizationid",
  "organizationids", "sourceorganizationids", "targetorganizationids",
  "orgid", "sourceorgid", "targetorgid", "orgids", "sourceorgids", "targetorgids"
]);

function isOrganizationIdentifierKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return organizationIdentifierKeyNames.has(normalized);
}

function stripOrganizationIdentifiers(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripOrganizationIdentifiers);
  if (!value || typeof value !== "object" || value instanceof Date) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !isOrganizationIdentifierKey(key))
      .map(([key, nested]) => [key, stripOrganizationIdentifiers(nested)])
  );
}

function rememberFile(paths: Map<string, string>, relative: string, hash: string): void {
  assertSafeRelativePath(relative);
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new WorkspaceServerError("workspace_bundle_v4_file_hash_invalid", 400);
  const current = paths.get(relative);
  if (current && current !== hash) throw new WorkspaceServerError("workspace_bundle_v4_file_path_conflict", 400);
  paths.set(relative, hash);
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function isWikiMetadata(value: Record<string, unknown>): boolean {
  const legacy = recordValue(value.legacy_source);
  return value.wiki === true || legacy.resource_kind === "wiki";
}

function numberValue(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

function safeProjectionId(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9._:-]/g, "_");
  return normalized || "page";
}

function markdownLabel(value: string): string {
  return value.replace(/[\r\n\[\]]/g, " ").trim() || "Untitled";
}

function wikiProjectionLinks(content: string): string[] {
  return [...content.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g)]
    .map((match) => match[1]?.trim())
    .filter((value): value is string => Boolean(value))
    .sort();
}

function assertCredentialFree(relative: string, content: Uint8Array): void {
  if (/(?:^|\/)(?:\.env(?:\..*)?|[^/]*(?:credential|secret|token|private[_-]?key|id_rsa)[^/]*|[^/]+\.(?:pem|key|p12|pfx))$/i.test(relative) || containsWorkspaceCompletionSecret(Buffer.from(content).toString("utf8"))) {
    throw new WorkspaceServerError("workspace_bundle_v4_secret_forbidden", 400);
  }
}

function stringValue(value: unknown, code: string): string {
  if (typeof value !== "string" || !value) throw new WorkspaceServerError(code, 400);
  return value;
}

function nullableStringValue(value: unknown, code: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  return stringValue(value, code);
}

function timestampValue(value: unknown, code: string): string {
  const result = stringValue(value, code);
  if (!Number.isFinite(new Date(result).getTime())) throw new WorkspaceServerError(code, 400);
  return result;
}

function nullableTimestampValue(value: unknown, code: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  return timestampValue(value, code);
}

function integerValue(value: unknown, code: string): number {
  const result = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(result) || result < 1) throw new WorkspaceServerError(code, 400);
  return result;
}

function nonNegativeIntegerValue(value: unknown, code: string): number {
  const result = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(result) || result < 0) throw new WorkspaceServerError(code, 400);
  return result;
}

function booleanValue(value: unknown, code: string): boolean {
  if (typeof value !== "boolean") throw new WorkspaceServerError(code, 400);
  return value;
}

function stringArrayValue(value: unknown, code: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim())) {
    throw new WorkspaceServerError(code, 400);
  }
  return [...value];
}

function batchScopeFromPortableHeader(header: Record<string, unknown>): WorkspaceCompletionScope {
  const kind = header.scope_kind;
  const roomId = header.room_id;
  if (kind === "workspace" && (roomId === null || roomId === undefined)) return { kind: "workspace" };
  if (kind === "room" && typeof roomId === "string" && roomId) return { kind: "room", roomId };
  throw new WorkspaceServerError("workspace_bundle_v4_batch_scope_invalid", 400);
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hashBytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertWorkspaceBundleV4ManifestCandidate(value: unknown): asserts value is WorkspaceBundleV4Manifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WorkspaceServerError("workspace_bundle_v4_manifest_invalid", 400);
  }
  const manifest = value as Partial<WorkspaceBundleV4Manifest>;
  if (manifest.format_version !== 4 || typeof manifest.workspace_id !== "string"
    || typeof manifest.base_v3_integrity_hash !== "string"
    || !manifest.files || typeof manifest.files !== "object" || Array.isArray(manifest.files)
    || !manifest.record_counts || typeof manifest.record_counts !== "object" || Array.isArray(manifest.record_counts)
    || !Array.isArray(manifest.excluded_maintenance_account_ids)
    || manifest.excluded_maintenance_account_ids.some((id) => typeof id !== "string")
    || typeof manifest.integrity_hash !== "string") {
    throw new WorkspaceServerError("workspace_bundle_v4_manifest_invalid", 400);
  }
  assertOpaqueId(manifest.workspace_id, "workspace_bundle_workspace_id_invalid");
  if (manifest.source_organization_id !== undefined) {
    assertWorkspaceBundleTargetOrganizationId(manifest.source_organization_id);
  }
  if (manifest.schema_revision !== undefined
    && (!Number.isSafeInteger(manifest.schema_revision) || manifest.schema_revision < 1)) {
    throw new WorkspaceServerError("workspace_bundle_v4_manifest_invalid", 400);
  }
  if (manifest.schema_version !== undefined
    && (!Number.isSafeInteger(manifest.schema_version) || manifest.schema_version < 1)) {
    throw new WorkspaceServerError("workspace_bundle_v4_manifest_invalid", 400);
  }
  if (manifest.schema_revision !== undefined && manifest.schema_version !== undefined
    && manifest.schema_revision !== manifest.schema_version) {
    throw new WorkspaceServerError("workspace_bundle_v4_manifest_invalid", 400);
  }
  if (!/^[a-f0-9]{64}$/.test(manifest.base_v3_integrity_hash) || !/^[a-f0-9]{64}$/.test(manifest.integrity_hash)) {
    throw new WorkspaceServerError("workspace_bundle_v4_manifest_invalid", 400);
  }
  if (manifest.transfer_id !== undefined) assertOpaqueId(manifest.transfer_id, "workspace_transfer_id_invalid");
  if (Object.keys(manifest.files).length > WORKSPACE_BUNDLE_MAX_ENTRIES || Object.keys(manifest.record_counts).length > WORKSPACE_BUNDLE_MAX_ENTRIES) {
    throw new WorkspaceServerError("workspace_bundle_v4_manifest_invalid", 413);
  }
  for (const [relativePath, hash] of Object.entries(manifest.files)) {
    assertSafeRelativePath(relativePath);
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new WorkspaceServerError("workspace_bundle_v4_manifest_invalid", 400);
  }
  for (const count of Object.values(manifest.record_counts)) {
    if (!Number.isSafeInteger(count) || count < 0 || count > WORKSPACE_BUNDLE_MAX_RECORDS_PER_FILE) throw new WorkspaceServerError("workspace_bundle_v4_manifest_invalid", 400);
  }
}

function isValidTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

async function incomingV4BundleExpired(metadataPath: string, metadata: Partial<IncomingV4BundleMetadata>): Promise<boolean> {
  const expiresAt = typeof metadata.expires_at === "string"
    ? Date.parse(metadata.expires_at)
    : typeof metadata.created_at === "string"
      ? Date.parse(metadata.created_at) + WORKSPACE_BUNDLE_INCOMING_TTL_MS
      : Number.NaN;
  if (Number.isFinite(expiresAt)) return expiresAt <= Date.now();
  try {
    const stats = await lstat(metadataPath);
    return stats.mtimeMs + WORKSPACE_BUNDLE_INCOMING_TTL_MS <= Date.now();
  } catch {
    return true;
  }
}

interface BundleUsage {
  bytes: number;
  entries: number;
}

async function measureBundleUsage(root: string): Promise<BundleUsage> {
  let bytes = 0;
  let entries = 0;
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = path.relative(root, path.join(directory, entry.name)).split(path.sep).join("/");
      const absolute = resolveBundlePath(root, relative);
      const stats = await lstat(absolute);
      if (stats.isSymbolicLink()) throw new WorkspaceServerError("workspace_bundle_v4_symlink_forbidden", 400);
      if (stats.isDirectory()) {
        await visit(absolute);
      } else if (stats.isFile()) {
        // The manifest is transport metadata, not one of the uploaded
        // Workspace entries. Counting it would make a manifest with exactly
        // MAX_ENTRIES legitimate files impossible to stage.
        if (relative === manifestName) continue;
        entries += 1;
        bytes += stats.size;
        if (entries > WORKSPACE_BUNDLE_MAX_ENTRIES || bytes > WORKSPACE_BUNDLE_MAX_BYTES) throw new WorkspaceServerError("workspace_bundle_v4_transport_too_large", 413);
      } else {
        throw new WorkspaceServerError("workspace_bundle_v4_file_invalid", 400);
      }
    }
  };
  await visit(root);
  return { bytes, entries };
}

function assertBundleUsage(usage: BundleUsage, code: string): void {
  if (usage.entries > WORKSPACE_BUNDLE_MAX_ENTRIES || usage.bytes > WORKSPACE_BUNDLE_MAX_BYTES) throw new WorkspaceServerError(code, 413);
}

function incomingV4Request(metadata: IncomingV4BundleMetadata): Record<string, unknown> {
  return {
    format_version: metadata.format_version,
    bundle_format: metadata.bundle_format,
    account_id: metadata.account_id,
    operation_id: metadata.operation_id,
    target_workspace_id: metadata.target_workspace_id,
    ...(metadata.target_workspace_name ? { target_workspace_name: metadata.target_workspace_name } : {}),
    ...(metadata.target_organization_id ? { target_organization_id: metadata.target_organization_id } : {}),
    manifest: metadata.manifest
  };
}

function bundleV4IntegrityPayload(manifest: WorkspaceBundleV4Manifest): Record<string, unknown> {
  const base = {
    files: manifest.files,
    record_counts: manifest.record_counts,
    ...(manifest.transfer_id ? { transfer_id: manifest.transfer_id } : {}),
    base_v3_integrity_hash: manifest.base_v3_integrity_hash,
    excluded_maintenance_account_ids: [...manifest.excluded_maintenance_account_ids].sort()
  };
  if (manifest.source_organization_id === undefined
    && manifest.schema_revision === undefined
    && manifest.schema_version === undefined) {
    return base;
  }
  return {
    ...base,
    ...(manifest.source_organization_id ? { source_organization_id: manifest.source_organization_id } : {}),
    ...(manifest.schema_revision !== undefined ? { schema_revision: manifest.schema_revision } : {}),
    ...(manifest.schema_version !== undefined ? { schema_version: manifest.schema_version } : {})
  };
}

function portableCountKey(table: string): string {
  return table.startsWith("workspace_completion_")
    ? table.slice("workspace_completion_".length)
    : table.startsWith("workspace_")
      ? table.slice("workspace_".length)
      : table;
}

function parseV4Transport(value: unknown): WorkspaceBundleV4Transport {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WorkspaceServerError("workspace_bundle_v4_transport_invalid", 400);
  const candidate = value as Partial<WorkspaceBundleV4Transport>;
  if (candidate.format !== transportFormat || !candidate.manifest || !Array.isArray(candidate.entries)) {
    throw new WorkspaceServerError("workspace_bundle_v4_transport_invalid", 400);
  }
  if (candidate.entries.length > WORKSPACE_BUNDLE_MAX_ENTRIES) throw new WorkspaceServerError("workspace_bundle_v4_transport_too_large", 413);
  if (typeof candidate.manifest !== "object" || Array.isArray(candidate.manifest)) {
    throw new WorkspaceServerError("workspace_bundle_v4_transport_invalid", 400);
  }
  assertWorkspaceBundleV4ManifestCandidate(candidate.manifest);
  const paths = new Set<string>();
  return {
    format: transportFormat,
    manifest: candidate.manifest,
    entries: candidate.entries.map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry) || typeof entry.path !== "string" || typeof entry.content_base64 !== "string" || paths.has(entry.path)) {
        throw new WorkspaceServerError("workspace_bundle_v4_transport_entry_invalid", 400);
      }
      paths.add(entry.path);
      return { path: entry.path, content_base64: entry.content_base64 };
    })
  };
}

function decodeV4TransportContent(value: string): Buffer {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new WorkspaceServerError("workspace_bundle_v4_transport_entry_invalid", 400);
  }
  const maxEncodedLength = Math.ceil(WORKSPACE_BUNDLE_MAX_ENTRY_BYTES / 3) * 4;
  if (value.length > maxEncodedLength) throw new WorkspaceServerError("workspace_bundle_v4_entry_too_large", 413);
  const content = Buffer.from(value, "base64");
  if (content.toString("base64") !== value) throw new WorkspaceServerError("workspace_bundle_v4_transport_entry_invalid", 400);
  if (content.byteLength > WORKSPACE_BUNDLE_MAX_ENTRY_BYTES) throw new WorkspaceServerError("workspace_bundle_v4_entry_too_large", 413);
  return content;
}

async function importWorkspaceAgentRow(
  context: WorkspaceRequestContext,
  sql: WorkspaceSql,
  row: Record<string, unknown>
): Promise<void> {
  const valuesByName: Record<string, unknown> = {
    target_workspace_id: context.workspaceId,
    target_agent_id: stringValue(row.id, "workspace_bundle_agent_id_invalid"),
    target_display_name: stringValue(row.display_name, "workspace_bundle_agent_display_name_invalid"),
    target_description: typeof row.description === "string" ? row.description : "",
    // V4 rows from before the v1 Agent contract receive the same safe defaults
    // as the schema migration. New rows round-trip all three canonical fields.
    target_role: stringValue(row.role ?? "workspace_agent", "workspace_bundle_agent_role_invalid"),
    target_instructions: stringValue(
      row.instructions ?? (typeof row.description === "string" && row.description.trim() ? row.description : "Workspace Agent"),
      "workspace_bundle_agent_instructions_invalid"
    ),
    target_backend_id: stringValue(row.backend_id, "workspace_bundle_agent_backend_invalid"),
    target_enabled: row.enabled === undefined ? row.status !== "disabled" : booleanValue(row.enabled, "workspace_bundle_agent_enabled_invalid"),
    target_status: stringValue(row.status, "workspace_bundle_agent_status_invalid"),
    target_version: integerValue(row.version, "workspace_bundle_agent_version_invalid"),
    target_created_by: stringValue(row.created_by, "workspace_bundle_agent_created_by_invalid"),
    target_created_at: timestampValue(row.created_at, "workspace_bundle_agent_created_at_invalid"),
    target_updated_at: timestampValue(row.updated_at, "workspace_bundle_agent_updated_at_invalid")
  };
  // The original V4 schema exposed a ten-argument import function. Resolve
  // the installed function by argument names so a migrated target can import
  // role/instructions/enabled while an older target keeps accepting legacy
  // Bundles until its schema is upgraded.
  const functions = await sql.query<{ pronargs: number | string; proargnames: string[] | null }>(
    `SELECT p.pronargs, p.proargnames
       FROM pg_proc AS p
       JOIN pg_namespace AS n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'samurai_import_workspace_agent'
      ORDER BY p.pronargs DESC
      LIMIT 1`
  );
  const functionRow = functions.rows[0];
  const argumentCount = Number(functionRow?.pronargs ?? 0);
  if (argumentCount <= 10) {
    const legacyValues = [
      valuesByName.target_workspace_id,
      valuesByName.target_agent_id,
      valuesByName.target_display_name,
      valuesByName.target_description,
      valuesByName.target_backend_id,
      valuesByName.target_status,
      valuesByName.target_version,
      valuesByName.target_created_by,
      valuesByName.target_created_at,
      valuesByName.target_updated_at
    ];
    await sql.query(
      "SELECT samurai_import_workspace_agent($1, $2, $3, $4, $5, $6, $7, $8, $9::TIMESTAMPTZ, $10::TIMESTAMPTZ)",
      legacyValues
    );
    return;
  }
  const names = Array.isArray(functionRow?.proargnames) ? functionRow.proargnames : [];
  const fallbackNames = [
    "target_workspace_id", "target_agent_id", "target_display_name", "target_description",
    "target_role", "target_instructions", "target_backend_id", "target_enabled", "target_status",
    "target_version", "target_created_by", "target_created_at", "target_updated_at"
  ];
  const values = Array.from({ length: argumentCount }, (_, index) => {
    const name = names[index] ?? fallbackNames[index];
    const value = name ? valuesByName[name.toLowerCase()] : undefined;
    if (value !== undefined) return value;
    throw new WorkspaceServerError("workspace_bundle_agent_schema_invalid", 400);
  });
  await sql.query(
    `SELECT samurai_import_workspace_agent(${values.map((_, index) => `$${index + 1}`).join(", ")})`,
    values
  );
}

function completionId(prefix: string, workspaceId: string, input: string): string {
  return `${prefix}_${hashText(`${workspaceId}:${input}`).slice(0, 40)}`;
}

function transferAttemptKey(transferId: string, version?: number): string {
  const attempt = typeof version === "number" && Number.isSafeInteger(version) && version > 1 ? version : 1;
  return attempt === 1 ? transferId : `${transferId}:${attempt}`;
}

function transferReceipt(manifest: WorkspaceBundleV4Manifest, targetWorkspaceId: string, importedAt?: string): WorkspaceTransferReceipt {
  if (!manifest.transfer_id) throw new WorkspaceServerError("workspace_transfer_receipt_invalid", 400);
  return {
    format_version: 1,
    transfer_id: manifest.transfer_id,
    source_workspace_id: manifest.workspace_id,
    source_integrity_hash: manifest.integrity_hash,
    target_workspace_id: targetWorkspaceId,
    imported_at: importedAt ?? manifest.exported_at,
    target_integrity_hash: manifest.integrity_hash
  };
}

function optionalWorkspaceBundleTargetOrganizationId(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return assertWorkspaceBundleTargetOrganizationId(value);
}

async function pathExists(value: string): Promise<boolean> {
  return lstat(value).then(() => true).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? false : Promise.reject(error));
}
