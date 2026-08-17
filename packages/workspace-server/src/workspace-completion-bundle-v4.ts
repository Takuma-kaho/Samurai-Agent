import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { canonicalJson } from "./auth";
import { assertOpaqueId, assertSafeRelativePath } from "./config";
import { WorkspaceServerError } from "./errors";
import type { WorkspaceSql } from "./postgres";
import type { WorkspaceRequestContext } from "./types";
import { verifyWorkspaceBundleV3, WorkspaceBundleV3Service } from "./workspace-bundle-v3";
import { WorkspaceCompletionFileService, type StagedWorkspaceCompletionFileBatch } from "./workspace-completion-files";
import { containsWorkspaceCompletionSecret } from "./workspace-completion-policy";
import { WorkspaceServerStore } from "./workspace-server-store";
import type { WorkspaceCompletionScope } from "./workspace-completion-types";

const manifestName = "manifest.json";
const baseV3Directory = "base-v3";
const completionDirectory = "completion";
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
  // Raw model exchanges are deliberately omitted: their hash/error evidence
  // remains with Job/Attempt, while their text follows local retention and
  // redaction rather than becoming portable Workspace content.
  ["workspace_completion_redactions", "redactions.jsonl"]
] as const;

export interface WorkspaceBundleV4Manifest {
  format_version: 4;
  workspace_id: string;
  exported_at: string;
  base_v3_integrity_hash: string;
  /** Public Account identities may remain in audit history, but these IDs
   * must have no Workspace/Room membership after restore. */
  excluded_maintenance_account_ids: readonly string[];
  files: Record<string, string>;
  record_counts: Record<string, number>;
  integrity_hash: string;
}

export interface ExportWorkspaceBundleV4Result {
  directory: string;
  manifest: WorkspaceBundleV4Manifest;
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

  async export(context: WorkspaceRequestContext, input: { destination: string }): Promise<ExportWorkspaceBundleV4Result> {
    const destination = path.resolve(input.destination);
    const staging = path.join(path.dirname(destination), `.${path.basename(destination)}.staging-${randomUUID()}`);
    const bundleId = completionId("bundle_v4", context.workspaceId, context.operationId);
    // Authorization is never skipped just because a previous attempt already
    // created the destination directory.
    await this.assertOwner(context);
    if (await pathExists(destination)) {
      const verified = await verifyWorkspaceBundleV4(destination);
      if (verified.manifest.workspace_id !== context.workspaceId) throw new WorkspaceServerError("workspace_bundle_workspace_mismatch", 409);
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
        excludeMembershipAccountIds: maintenanceAccountIds
      });
      // File batch entries are a recovery ledger. During a normal update an
      // old batch can have staged the former live path while its Version now
      // points at `.versions/...`. Export the durable snapshot by the paths
      // each Version actually references, not by stale staging destinations.
      const rows = normalizePortableBatchRows(await this.readCompletionRows(context));
      for (const [table, filename] of tableFiles) {
        await writeJsonl(resolveBundlePath(staging, `${completionDirectory}/${filename}`), rows[table] ?? []);
      }
      await this.writeCompletionFiles(context, staging, rows);
      const files = await hashBundleFiles(staging);
      const recordCounts = Object.fromEntries(tableFiles.map(([table]) => [table.replace("workspace_completion_", ""), (rows[table] ?? []).length]));
      const manifest: WorkspaceBundleV4Manifest = {
        format_version: 4,
        workspace_id: context.workspaceId,
        exported_at: new Date().toISOString(),
        base_v3_integrity_hash: base.manifest.integrity_hash,
        excluded_maintenance_account_ids: maintenanceAccountIds.sort(),
        files,
        record_counts: recordCounts,
        integrity_hash: hashText(canonicalJson({ files, record_counts: recordCounts, base_v3_integrity_hash: base.manifest.integrity_hash, excluded_maintenance_account_ids: maintenanceAccountIds.sort() }))
      };
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

  /** Restores the v3 core first, then imports the verified completion rows and
   * their staged file batches. PostgreSQL constraints validate every relation
   * before any completion body is renamed into the active file tree. */
  async importNew(context: Pick<WorkspaceRequestContext, "accountId" | "operationId">, input: { sourceDirectory: string; targetWorkspaceId: string; targetWorkspaceName?: string }): Promise<{ workspaceId: string; manifest: WorkspaceBundleV4Manifest }> {
    assertOpaqueId(input.targetWorkspaceId, "workspace_id_invalid");
    const source = await verifyWorkspaceBundleV4(input.sourceDirectory);
    const imported = await this.v3.importNew(context, {
      sourceDirectory: path.join(source.directory, baseV3Directory), targetWorkspaceId: input.targetWorkspaceId,
      ...(input.targetWorkspaceName ? { targetWorkspaceName: input.targetWorkspaceName } : {}),
      beforeActivate: async (targetContext) => this.importCompletionExtension(targetContext, source)
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
    const maintenance = await this.store.database.withContext({ workspaceId: input.targetWorkspaceId, accountId: context.accountId }, async (sql) => {
      const marker = await sql.query<{ exists: boolean }>(
        "SELECT EXISTS(SELECT 1 FROM workspace_completion_maintenance_identities WHERE workspace_id = $1) AS exists",
        [input.targetWorkspaceId]
      );
      const memberships = source.manifest.excluded_maintenance_account_ids.length === 0
        ? { rows: [{ exists: false }] }
        : await sql.query<{ exists: boolean }>(
          `SELECT EXISTS(
             SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND account_id = ANY($2::TEXT[])
             UNION ALL
             SELECT 1 FROM room_members WHERE workspace_id = $1 AND account_id = ANY($2::TEXT[])
           ) AS exists`,
          [input.targetWorkspaceId, [...source.manifest.excluded_maintenance_account_ids]]
        );
      return { marker: marker.rows[0]?.exists === true, memberships: memberships.rows[0]?.exists === true };
    });
    if (maintenance.marker || maintenance.memberships) {
      throw new WorkspaceServerError("workspace_bundle_v4_maintenance_membership_restored", 409);
    }
    return { workspaceId: imported.workspaceId, manifest: source.manifest };
  }

  private async readCompletionRows(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">): Promise<Record<string, Record<string, unknown>[]>> {
    return this.store.database.withReadSnapshot(context, async (sql) => {
      const values: Record<string, Record<string, unknown>[]> = {};
      for (const [table] of tableFiles) {
        const result = await sql.query<Record<string, unknown>>(`SELECT * FROM ${table} WHERE workspace_id = $1`, [context.workspaceId]);
        values[table] = result.rows.map(portableRow);
      }
      return values;
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

  private async importCompletionExtension(context: WorkspaceRequestContext, source: { directory: string; manifest: WorkspaceBundleV4Manifest }): Promise<void> {
    const rows = await readCompletionBundleRows(source.directory);
    const batches = await this.stageImportedBatches(context, source.directory, rows);
    try {
      await this.store.database.withContext(context, async (sql) => {
        await sql.query("SET CONSTRAINTS ALL DEFERRED");
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
          for (const row of rows[table] ?? []) await insertPortableRow(sql, table, { ...row, workspace_id: context.workspaceId });
        }
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
      for (const batch of batches) {
        await this.files.finalize(batch);
        await this.store.database.withContext(context, async (sql) => {
          await sql.query("UPDATE workspace_completion_file_batches SET status = 'renamed', updated_at = NOW() WHERE workspace_id = $1 AND id = $2", [context.workspaceId, batch.id]);
        });
      }
    } catch (error) {
      await Promise.all(batches.map((batch) => this.files.rollback(batch).catch(() => undefined)));
      throw error;
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
  }

  private async filesRecover(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">): Promise<void> {
    // An export never treats an interrupted rename as a valid Bundle state.
    const result = await this.store.database.withContext(context, async (sql) => sql.query<{ id: string }>("SELECT id FROM workspace_completion_file_batches WHERE workspace_id = $1 AND status = 'db_committed'", [context.workspaceId]));
    if (result.rows.length > 0) throw new WorkspaceServerError("workspace_completion_file_recovery_required", 503);
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
      // A retry after rename must find the real v4 destination first. This
      // also makes a previous verified repair idempotent without creating a
      // second ledger row for the same Bundle.
      const finalRows = await sql.query<BundleLedgerRow>(
        `SELECT id, format_version, path, sha256, record_counts
         FROM workspace_bundles WHERE workspace_id = $1 AND path = $2 FOR UPDATE`,
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
         ORDER BY id ASC FOR UPDATE`,
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
      await sql.query(
        "SELECT samurai_record_workspace_bundle_v4($1, $2, $3, $4, $5::JSONB)",
        [context.workspaceId, bundleId, destination, manifest.integrity_hash, canonicalJson(manifest.record_counts)]
      );
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
  "workspace_completion_redactions"
] as const;

export async function verifyWorkspaceBundleV4(directory: string): Promise<ExportWorkspaceBundleV4Result> {
  const root = path.resolve(directory);
  const raw = await readFile(path.join(root, manifestName), "utf8");
  const manifest = JSON.parse(raw) as WorkspaceBundleV4Manifest;
  if (!manifest || manifest.format_version !== 4 || typeof manifest.workspace_id !== "string" || !manifest.files || !manifest.record_counts
    || !Array.isArray(manifest.excluded_maintenance_account_ids) || manifest.excluded_maintenance_account_ids.some((id) => typeof id !== "string")
    || typeof manifest.integrity_hash !== "string") {
    throw new WorkspaceServerError("workspace_bundle_v4_manifest_invalid", 400);
  }
  assertOpaqueId(manifest.workspace_id, "workspace_bundle_workspace_id_invalid");
  const v3 = await verifyWorkspaceBundleV3(resolveBundlePath(root, baseV3Directory));
  if (v3.manifest.integrity_hash !== manifest.base_v3_integrity_hash) throw new WorkspaceServerError("workspace_bundle_v4_base_mismatch", 400);
  const actual = await hashBundleFiles(root);
  if (canonicalJson(actual) !== canonicalJson(manifest.files)) throw new WorkspaceServerError("workspace_bundle_v4_hash_mismatch", 400);
  for (const accountId of manifest.excluded_maintenance_account_ids) assertOpaqueId(accountId, "workspace_bundle_v4_maintenance_account_invalid");
  const expected = hashText(canonicalJson({
    files: manifest.files,
    record_counts: manifest.record_counts,
    base_v3_integrity_hash: manifest.base_v3_integrity_hash,
    excluded_maintenance_account_ids: [...manifest.excluded_maintenance_account_ids].sort()
  }));
  if (expected !== manifest.integrity_hash) throw new WorkspaceServerError("workspace_bundle_v4_integrity_invalid", 400);
  for (const relative of Object.keys(actual)) {
    const content = await readFile(resolveBundlePath(root, relative));
    assertCredentialFree(relative, content);
  }
  for (const [, filename] of tableFiles) await readJsonl(resolveBundlePath(root, `${completionDirectory}/${filename}`));
  return { directory: root, manifest };
}

async function readCompletionBundleRows(root: string): Promise<Record<string, Record<string, unknown>[]>> {
  const rows: Record<string, Record<string, unknown>[]> = {};
  for (const [table, filename] of tableFiles) rows[table] = await readJsonl(resolveBundlePath(root, `${completionDirectory}/${filename}`));
  return rows;
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
  const body = rows.map((row) => canonicalJson(row)).join("\n") + (rows.length ? "\n" : "");
  await writeFile(destination, body, { flag: "wx", mode: 0o600 });
}

async function readJsonl(source: string): Promise<Record<string, unknown>[]> {
  const raw = await readFile(source, "utf8");
  if (!raw) return [];
  return raw.trimEnd().split("\n").map((line) => {
    try {
      const value = JSON.parse(line) as unknown;
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("row");
      return value as Record<string, unknown>;
    } catch {
      throw new WorkspaceServerError("workspace_bundle_v4_jsonl_invalid", 400);
    }
  });
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
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, portableValue(value)]));
}

function portableValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(portableValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, portableValue(child)]));
  return value;
}

function rememberFile(paths: Map<string, string>, relative: string, hash: string): void {
  assertSafeRelativePath(relative);
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new WorkspaceServerError("workspace_bundle_v4_file_hash_invalid", 400);
  const current = paths.get(relative);
  if (current && current !== hash) throw new WorkspaceServerError("workspace_bundle_v4_file_path_conflict", 400);
  paths.set(relative, hash);
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

function completionId(prefix: string, workspaceId: string, input: string): string {
  return `${prefix}_${hashText(`${workspaceId}:${input}`).slice(0, 40)}`;
}

async function pathExists(value: string): Promise<boolean> {
  return lstat(value).then(() => true).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? false : Promise.reject(error));
}
