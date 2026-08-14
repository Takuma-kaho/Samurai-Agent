import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertOpaqueId, assertSafeRelativePath } from "./config";
import { assertAccountIdMatchesPublicKey, canonicalJson } from "./auth";
import { WorkspaceServerError } from "./errors";
import type { WorkspaceSql } from "./postgres";
import type { WorkspaceBundleV3Manifest, WorkspaceRequestContext, WorkspaceServerMode, WorkspaceTransferReceipt } from "./types";
import { WorkspaceFileStore } from "./workspace-files";
import { WorkspaceServerStore } from "./workspace-server-store";

const manifestFile = "manifest.json";
const workspaceFile = "workspace.json";
const jsonlFiles = ["accounts.jsonl", "rooms.jsonl", "memberships.jsonl", "room-memberships.jsonl", "records.jsonl", "events.jsonl", "jobs.jsonl", "operations.jsonl", "invitations.jsonl", "audits.jsonl", "files.jsonl"] as const;
const credentialFilePath = /(?:^|\/)(?:\.env(?:\..*)?|[^/]*(?:credential|secret|token|private[_-]?key|id_rsa)[^/]*|[^/]+\.(?:pem|key|p12|pfx))$/i;
const credentialText = /-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----|(?:^|[\n{,])\s*["']?(?:password|passphrase|secret|private[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|credential|api[_-]?key)["']?\s*[:=]|(?:^|[^A-Za-z0-9])(?:sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[A-Z0-9]{16})(?:$|[^A-Za-z0-9])/i;
const credentialFieldNames = new Set([
  "password", "passphrase", "secret", "privatekey", "accesstoken", "refreshtoken",
  "authorization", "cookie", "credential", "apikey", "token"
]);
const transportFormat = "samurai-workspace-bundle-v3";
// One Server process owns one transfer export at a time. The database still
// validates the final transition, while this avoids two local file writers
// racing over the same private bundle directory.
const transferExportLocks = new Map<string, Promise<void>>();

const portableSchema: Readonly<Record<string, { required: readonly string[]; allowed: readonly string[] }>> = {
  [workspaceFile]: {
    required: ["id", "name", "hosting_mode", "database_placement", "storage_namespace", "created_by", "version", "created_at", "updated_at"],
    allowed: ["id", "name", "hosting_mode", "database_placement", "storage_namespace", "created_by", "version", "created_at", "updated_at"]
  },
  "accounts.jsonl": {
    required: ["id", "public_key", "display_name", "created_at", "updated_at"],
    allowed: ["id", "public_key", "display_name", "status", "created_at", "updated_at"]
  },
  "rooms.jsonl": {
    required: ["workspace_id", "id", "name", "version", "created_by", "created_at", "updated_at"],
    // parent_room_id is optional so a pre-hierarchy Bundle restores all of
    // its Rooms directly under the Workspace.
    allowed: ["workspace_id", "id", "parent_room_id", "name", "version", "created_by", "created_at", "updated_at"]
  },
  "memberships.jsonl": {
    required: ["workspace_id", "account_id", "role", "state", "version", "created_at", "updated_at", "revoked_at"],
    allowed: ["workspace_id", "account_id", "role", "state", "version", "created_at", "updated_at", "revoked_at"]
  },
  "room-memberships.jsonl": {
    required: ["workspace_id", "room_id", "account_id", "role", "state", "version", "created_at", "updated_at", "revoked_at"],
    allowed: ["workspace_id", "room_id", "account_id", "role", "state", "version", "created_at", "updated_at", "revoked_at"]
  },
  "records.jsonl": {
    required: ["workspace_id", "room_id", "record_type", "id", "version", "payload", "search_text", "content_hash", "created_by", "updated_by", "created_at", "updated_at"],
    allowed: ["workspace_id", "room_id", "record_type", "id", "version", "payload", "search_text", "content_hash", "created_by", "updated_by", "created_at", "updated_at"]
  },
  "events.jsonl": {
    required: ["source_event_id", "workspace_id", "room_id", "kind", "record_type", "record_id", "operation_id", "payload", "created_at"],
    allowed: ["source_event_id", "workspace_id", "room_id", "kind", "record_type", "record_id", "operation_id", "payload", "created_at"]
  },
  "jobs.jsonl": {
    required: ["workspace_id", "room_id", "id", "kind", "status", "version", "idempotency_key", "payload", "created_by", "updated_by", "created_at", "updated_at"],
    allowed: ["workspace_id", "room_id", "id", "kind", "status", "version", "idempotency_key", "payload", "created_by", "updated_by", "created_at", "updated_at"]
  },
  "operations.jsonl": { required: [], allowed: [] },
  "invitations.jsonl": {
    required: ["workspace_id", "id", "room_id", "workspace_role", "room_role", "created_by", "expires_at", "revoked_at", "accepted_by", "accepted_at", "version", "created_at"],
    allowed: ["workspace_id", "id", "room_id", "workspace_role", "room_role", "created_by", "expires_at", "revoked_at", "accepted_by", "accepted_at", "version", "created_at"]
  },
  "audits.jsonl": {
    required: ["source_audit_id", "workspace_id", "room_id", "actor_account_id", "action", "outcome", "operation_id", "subject_kind", "subject_id", "before_version", "after_version", "details", "created_at"],
    allowed: ["source_audit_id", "workspace_id", "room_id", "actor_account_id", "action", "outcome", "operation_id", "subject_kind", "subject_id", "before_version", "after_version", "details", "created_at"]
  },
  "files.jsonl": {
    required: ["workspace_id", "room_id", "path", "version", "sha256", "size", "created_by", "updated_by", "created_at", "updated_at"],
    allowed: ["workspace_id", "room_id", "path", "version", "sha256", "size", "created_by", "updated_by", "created_at", "updated_at"]
  }
};

export interface ExportWorkspaceBundleInput {
  destination: string;
  transferId?: string;
}

export interface ExportWorkspaceBundleResult {
  id: string;
  directory: string;
  manifest: WorkspaceBundleV3Manifest;
}

export interface ImportWorkspaceBundleInput {
  sourceDirectory: string;
  targetWorkspaceId: string;
  targetWorkspaceName?: string;
}

export interface StageWorkspaceBundleInput {
  targetWorkspaceId: string;
  targetWorkspaceName?: string;
  manifest: WorkspaceBundleV3Manifest;
}

/**
 * The HTTP transfer format is a single JSON document, not a server-local
 * directory path. It holds the exact verified Bundle files as base64 content.
 */
export interface WorkspaceBundleV3Transport {
  format: typeof transportFormat;
  manifest: WorkspaceBundleV3Manifest;
  entries: Array<{ path: string; content_base64: string }>;
}

/** A portable directory bundle: JSONL rows plus readable Workspace files, never a database image. */
export class WorkspaceBundleV3Service {
  private readonly files: WorkspaceFileStore;

  constructor(private readonly store: WorkspaceServerStore) {
    this.files = new WorkspaceFileStore(store);
  }

  async export(context: WorkspaceRequestContext, input: ExportWorkspaceBundleInput): Promise<ExportWorkspaceBundleResult> {
    await assertWorkspaceOwner(this.store, context);
    const bundleId = input.transferId ? `bundle_${input.transferId}` : `bundle_${randomUUID()}`;
    const destination = path.resolve(input.destination);
    const staging = path.join(path.dirname(destination), `.${path.basename(destination)}.staging-${randomUUID()}`);
    let createdStaging = false;
    try {
      const generated = await pathExists(destination)
        ? await verifyWorkspaceBundleV3(destination)
        : await (async () => {
          await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
          await mkdir(staging, { recursive: false, mode: 0o700 });
          createdStaging = true;
          const written = await this.writeStableBundleDirectory(context, staging, input.transferId);
          try {
            await rename(staging, destination);
            createdStaging = false;
            return written;
          } catch (error) {
            if (!isExistingDestinationError(error)) throw error;
            await rm(staging, { recursive: true, force: true }).catch(() => undefined);
            createdStaging = false;
            return verifyWorkspaceBundleV3(destination);
          }
        })();
      if (generated.manifest.workspace_id !== context.workspaceId) throw new WorkspaceServerError("workspace_bundle_workspace_mismatch", 409);
      await this.store.database.withContext(context, async (sql) => {
        await sql.query("SELECT samurai_record_workspace_bundle($1, $2, $3, $4, $5::JSONB, $6)", [
          context.workspaceId,
          bundleId,
          destination,
          generated.manifest.integrity_hash,
          canonicalJson(generated.manifest.record_counts),
          input.transferId ?? null
        ]);
        await this.store.insertAudit(sql, context, {
          action: input.transferId ? "workspace.transfer.export" : "workspace.bundle.export",
          subjectKind: "workspace_bundle",
          subjectId: bundleId,
          details: { integrity_hash: generated.manifest.integrity_hash, ...(input.transferId ? { transfer_id: input.transferId } : {}) }
        });
      });
      return { id: bundleId, directory: destination, manifest: generated.manifest };
    } catch (error) {
      if (createdStaging) await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Marks the source read-only before export. If export fails, the source is
   * immediately returned to active so no user data is stranded.
   */
  async beginTransfer(context: WorkspaceRequestContext, destination: string): Promise<ExportWorkspaceBundleResult & { transferId: string }> {
    await assertWorkspaceOwner(this.store, context);
    const transferId = context.operationId;
    const begun = await this.store.runIdempotent(context, {
      action: "workspace.transfer.begin",
      input: { transferId, destination: path.resolve(destination) }
    }, async (sql) => {
      await sql.query("SELECT samurai_begin_workspace_transfer($1, $2)", [context.workspaceId, transferId]);
      await this.store.insertAudit(sql, context, {
        action: "workspace.transfer.begin",
        subjectKind: "workspace_transfer",
        subjectId: transferId,
        details: { destination: "portable_bundle" }
      });
      return { transferId };
    });
    // A second request with the same operation ID must resume the same
    // transfer. Do not run another state-changing operation ledger entry.
    if (begun.transferId !== transferId) throw new WorkspaceServerError("workspace_transfer_not_ready", 409);
    return runExclusiveTransferExport(canonicalJson([context.workspaceId, transferId]), async () => {
      const transfer = await readTransfer(this.store, context, transferId);
      if (transfer.state === "exported" && transfer.bundlePath) {
        const verified = await verifyWorkspaceBundleV3(transfer.bundlePath);
        return { id: `bundle_${transferId}`, directory: transfer.bundlePath, manifest: verified.manifest, transferId };
      }
      if (transfer.state === "failed" || transfer.state === "rolled_back") {
        throw new WorkspaceServerError("workspace_transfer_not_ready", 409);
      }
      try {
        // Export is part of the original transfer operation. It deliberately
        // does not open a nested idempotency ledger using the same ID.
        const exported = await this.exportPreparedTransfer(context, { destination, transferId });
        return { ...exported, transferId };
      } catch (error) {
        // If another process completed the durable DB transition while this
        // process was racing for the destination directory, prefer that
        // verified result instead of incorrectly failing the transfer.
        const resumed = await readTransfer(this.store, context, transferId).catch(() => undefined);
        if (resumed?.state === "exported" && resumed.bundlePath) {
          const verified = await verifyWorkspaceBundleV3(resumed.bundlePath);
          return { id: `bundle_${transferId}`, directory: resumed.bundlePath, manifest: verified.manifest, transferId };
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

  private async exportPreparedTransfer(
    context: WorkspaceRequestContext,
    input: ExportWorkspaceBundleInput & { transferId: string }
  ): Promise<ExportWorkspaceBundleResult> {
    const bundleId = `bundle_${input.transferId}`;
    const destination = path.resolve(input.destination);
    const staging = path.join(path.dirname(destination), `.${path.basename(destination)}.staging-${randomUUID()}`);
    let createdStaging = false;
    try {
      const generated = await pathExists(destination)
        ? await verifyWorkspaceBundleV3(destination)
        : await (async () => {
          await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
          await mkdir(staging, { recursive: false, mode: 0o700 });
          createdStaging = true;
          const written = await this.writeStableBundleDirectory(context, staging, input.transferId);
          try {
            await rename(staging, destination);
            createdStaging = false;
            return written;
          } catch (error) {
            if (!isExistingDestinationError(error)) throw error;
            await rm(staging, { recursive: true, force: true }).catch(() => undefined);
            createdStaging = false;
            return verifyWorkspaceBundleV3(destination);
          }
        })();
      if (generated.manifest.workspace_id !== context.workspaceId) throw new WorkspaceServerError("workspace_bundle_workspace_mismatch", 409);
      await this.store.database.withContext(context, async (sql) => {
        await sql.query("SELECT samurai_record_workspace_bundle($1, $2, $3, $4, $5::JSONB, $6)", [
          context.workspaceId,
          bundleId,
          destination,
          generated.manifest.integrity_hash,
          canonicalJson(generated.manifest.record_counts),
          input.transferId
        ]);
        await this.store.insertAudit(sql, context, {
          action: "workspace.transfer.export",
          subjectKind: "workspace_bundle",
          subjectId: bundleId,
          details: { integrity_hash: generated.manifest.integrity_hash, transfer_id: input.transferId }
        });
      });
      return { id: bundleId, directory: destination, manifest: generated.manifest };
    } catch (error) {
      if (createdStaging) await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  async rollbackTransfer(context: WorkspaceRequestContext, transferId: string): Promise<void> {
    assertOpaqueId(transferId, "workspace_transfer_id_invalid");
    await assertWorkspaceOwner(this.store, context);
    await this.store.runIdempotent(context, { action: "workspace.transfer.rollback", input: { transferId } }, async (sql) => {
      await sql.query("SELECT samurai_rollback_workspace_transfer($1, $2)", [context.workspaceId, transferId]);
      await this.store.insertAudit(sql, context, {
        action: "workspace.transfer.rollback",
        subjectKind: "workspace_transfer",
        subjectId: transferId
      });
    });
  }

  async completeTransfer(context: WorkspaceRequestContext, transferId: string): Promise<void> {
    assertOpaqueId(transferId, "workspace_transfer_id_invalid");
    await assertWorkspaceOwner(this.store, context);
    await this.store.runIdempotent(context, { action: "workspace.transfer.complete", input: { transferId } }, async (sql) => {
      await sql.query("SELECT samurai_complete_workspace_transfer($1, $2)", [context.workspaceId, transferId]);
      await this.store.insertAudit(sql, context, {
        action: "workspace.transfer.complete",
        subjectKind: "workspace_transfer",
        subjectId: transferId
      });
    });
  }

  async recordTransferReceipt(context: WorkspaceRequestContext, input: {
    transferId: string;
    targetWorkspaceId: string;
    receipt: WorkspaceTransferReceipt;
  }): Promise<void> {
    assertOpaqueId(input.transferId, "workspace_transfer_id_invalid");
    assertOpaqueId(input.targetWorkspaceId, "workspace_id_invalid");
    await assertWorkspaceOwner(this.store, context);
    await this.store.runIdempotent(context, {
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
  ): Promise<{ directory: string; manifest: WorkspaceBundleV3Manifest }> {
    assertOpaqueId(transferId, "workspace_transfer_id_invalid");
    await assertWorkspaceOwner(this.store, context);
    const transfer = await readTransfer(this.store, context, transferId);
    if (transfer.state !== "exported" || !transfer.bundlePath) throw new WorkspaceServerError("workspace_transfer_not_ready", 409);
    const verified = await verifyWorkspaceBundleV3(transfer.bundlePath);
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
    if (!expectedHash) throw new WorkspaceServerError("workspace_bundle_v3_entry_not_found", 404);
    const content = await readFile(resolveBundlePath(transfer.directory, entryPath));
    if (hashBytes(content) !== expectedHash) throw new WorkspaceServerError("workspace_bundle_v3_hash_mismatch", 409);
    return { content, contentType: entryPath.endsWith(".json") || entryPath.endsWith(".jsonl") ? "application/json" : "application/octet-stream" };
  }

  /**
   * Starts a target-side file staging area. It is not a Workspace and does not
   * touch PostgreSQL until every signed entry is present and verified.
   */
  async stageIncomingBundle(context: Pick<WorkspaceRequestContext, "accountId" | "operationId">, input: StageWorkspaceBundleInput): Promise<void> {
    assertOpaqueId(context.accountId, "account_id_invalid");
    assertOpaqueId(context.operationId, "workspace_operation_id_invalid");
    assertOpaqueId(input.targetWorkspaceId, "workspace_id_invalid");
    assertBundleManifestCandidate(input.manifest);
    const root = this.incomingRoot(context.accountId, context.operationId);
    const metadata: IncomingBundleMetadata = {
      format_version: 1,
      account_id: context.accountId,
      operation_id: context.operationId,
      target_workspace_id: input.targetWorkspaceId,
      ...(input.targetWorkspaceName?.trim() ? { target_workspace_name: input.targetWorkspaceName.trim().slice(0, 500) } : {}),
      manifest: input.manifest
    };
    const metadataPath = this.incomingMetadataPath(context.accountId, context.operationId);
    if (await pathExists(metadataPath)) {
      const existing = await this.readIncomingMetadata(context);
      if (canonicalJson(incomingMetadataRequest(existing)) !== canonicalJson(incomingMetadataRequest(metadata))) {
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
      await writeFile(path.join(root, manifestFile), canonicalJson(input.manifest), { flag: "wx", mode: 0o600 });
      await this.writeIncomingMetadata(context, metadata, { overwrite: false });
      wroteMetadata = true;
    } catch (error) {
      if (createdRoot) {
        await rm(root, { recursive: true, force: true }).catch(() => undefined);
      }
      if (wroteMetadata) await rm(metadataPath, { force: true }).catch(() => undefined);
      if (!await pathExists(metadataPath)) throw error;
      const existing = await this.readIncomingMetadata(context);
      if (canonicalJson(incomingMetadataRequest(existing)) !== canonicalJson(incomingMetadataRequest(metadata))) {
        throw new WorkspaceServerError("workspace_import_staging_conflict", 409);
      }
    }
  }

  async putIncomingBundleEntry(context: Pick<WorkspaceRequestContext, "accountId" | "operationId">, entryPath: string, content: Uint8Array): Promise<void> {
    const metadata = await this.readIncomingMetadata(context);
    if (metadata.completed) throw new WorkspaceServerError("workspace_import_staging_completed", 409);
    assertSafeRelativePath(entryPath);
    const expectedHash = metadata.manifest.files[entryPath];
    if (!expectedHash) throw new WorkspaceServerError("workspace_bundle_v3_entry_not_found", 404);
    if (content.byteLength > 8 * 1024 * 1024) throw new WorkspaceServerError("workspace_bundle_v3_entry_too_large", 413);
    if (hashBytes(content) !== expectedHash) throw new WorkspaceServerError("workspace_bundle_v3_hash_mismatch", 400);
    const root = this.incomingRoot(context.accountId, context.operationId);
    const destination = resolveBundlePath(root, entryPath);
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    try {
      await writeFile(destination, content, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await readFile(destination);
      if (hashBytes(existing) !== expectedHash) throw new WorkspaceServerError("workspace_import_staging_conflict", 409);
    }
  }

  async completeIncomingBundle(context: Pick<WorkspaceRequestContext, "accountId" | "operationId">): Promise<{
    workspaceId: string;
    manifest: WorkspaceBundleV3Manifest;
    receipt?: WorkspaceTransferReceipt;
  }> {
    const metadata = await this.readIncomingMetadata(context);
    if (metadata.completed) return completionResult(metadata.completed);
    const root = this.incomingRoot(context.accountId, context.operationId);
    await verifyWorkspaceBundleV3(root);
    try {
      const imported = await this.importNew(context, {
        sourceDirectory: root,
        targetWorkspaceId: metadata.target_workspace_id,
        ...(metadata.target_workspace_name ? { targetWorkspaceName: metadata.target_workspace_name } : {})
      });
      await this.writeIncomingMetadata(context, {
        ...metadata,
        completed: {
          workspace_id: imported.workspaceId,
          manifest: imported.manifest,
          ...(imported.receipt ? { receipt: imported.receipt } : {}),
          completed_at: new Date().toISOString()
        }
      }, { overwrite: true });
      await rm(root, { recursive: true, force: true });
      return imported;
    } catch (error) {
      // Keep the verified staging area for an operator retry or explicit
      // diagnosis. It never becomes an active Workspace by itself.
      throw error;
    }
  }

  /** Imports into a new read-only Workspace, validates its files/counts, then activates it. */
  async importNew(context: Pick<WorkspaceRequestContext, "accountId" | "operationId">, input: ImportWorkspaceBundleInput): Promise<{
    workspaceId: string;
    manifest: WorkspaceBundleV3Manifest;
    receipt?: WorkspaceTransferReceipt;
  }> {
    assertOpaqueId(input.targetWorkspaceId, "workspace_id_invalid");
    if (this.store.mode === "self_host") {
      if (input.targetWorkspaceId !== this.store.selfHostWorkspaceId) {
        throw new WorkspaceServerError("workspace_not_found", 404);
      }
      // An empty Self-host server is a recovery target, not an unclaimed
      // Hosted-style Workspace. Registering an Account must never be enough
      // to take ownership of it.
      this.store.assertSelfHostInitialAdmin(context.accountId);
    }
    const source = await verifyWorkspaceBundleV3(input.sourceDirectory);
    const sourceWorkspace = await readJsonObject(path.join(source.directory, workspaceFile));
    const sourceWorkspaceVersion = Number(sourceWorkspace.version ?? 1);
    if (!Number.isSafeInteger(sourceWorkspaceVersion) || sourceWorkspaceVersion < 1) {
      throw new WorkspaceServerError("workspace_bundle_v3_manifest_invalid", 400);
    }
    const targetContext: WorkspaceRequestContext = { ...context, workspaceId: input.targetWorkspaceId };
    const importId = `import_${randomUUID()}`;
    const stagingRoot = path.join(this.store.storageRoot, ".imports", `import_${randomUUID()}`);
    const finalRoot = path.join(this.store.storageRoot, "workspaces", input.targetWorkspaceId);
    const existingWorkspace = await this.store.getWorkspace(targetContext).then(() => true).catch((error) => {
      if (error instanceof WorkspaceServerError && error.code === "workspace_not_found") return false;
      throw error;
    });
    if (existingWorkspace) {
      try {
        await assertImportedBundleMatches(this.store, targetContext, source.manifest);
        await verifyImportedWorkspace(this.store, targetContext, source.manifest, source.directory);
        return {
          workspaceId: input.targetWorkspaceId,
          manifest: source.manifest,
          ...(source.manifest.transfer_id ? { receipt: transferReceipt(source.manifest, input.targetWorkspaceId) } : {})
        };
      } catch {
        throw new WorkspaceServerError("workspace_import_target_exists", 409);
      }
    }
    if (await pathExists(finalRoot)) throw new WorkspaceServerError("workspace_import_target_exists", 409);
    let importSessionStarted = false;
    let finalRootCreated = false;
    try {
      await copyBundleFilesToStaging(source.directory, stagingRoot, source.manifest.files);
      await mkdir(path.dirname(finalRoot), { recursive: true, mode: 0o700 });
      await rename(stagingRoot, finalRoot);
      finalRootCreated = true;
      await this.store.database.withContext({ ...targetContext, importId }, async (sql) => {
        await sql.query("SELECT samurai_start_workspace_import($1, $2, $3, $4, $5, $6)", [
          input.targetWorkspaceId,
          input.targetWorkspaceName?.trim() || "Imported Workspace",
          this.store.mode,
          this.store.mode === "self_host" ? "dedicated" : "shared",
          importId,
          sourceWorkspaceVersion
        ]);
        await importSnapshot(sql, {
          sourceDirectory: source.directory,
          targetWorkspaceId: input.targetWorkspaceId,
          targetWorkspaceName: input.targetWorkspaceName,
          ownerAccountId: context.accountId,
          mode: this.store.mode
        });
        await sql.query("SELECT samurai_record_import_bundle($1, $2, $3, $4, $5::JSONB)", [
          input.targetWorkspaceId,
          importId,
          `portable://bundle-v3/${source.manifest.integrity_hash}`,
          source.manifest.integrity_hash,
          canonicalJson(source.manifest.record_counts)
        ]);
      });
      importSessionStarted = true;
      await verifyImportedWorkspace(this.store, targetContext, source.manifest, source.directory);
      await this.store.database.withContext({ ...targetContext, importId }, async (sql) => {
        await sql.query("SELECT samurai_complete_workspace_import($1, $2, $3)", [input.targetWorkspaceId, importId, source.manifest.integrity_hash]);
        await this.store.insertAudit(sql, targetContext, {
          action: "workspace.bundle.import",
          subjectKind: "workspace_bundle",
          subjectId: source.manifest.integrity_hash,
          details: { source_workspace_id: source.manifest.workspace_id, ...(source.manifest.transfer_id ? { transfer_id: source.manifest.transfer_id } : {}) }
        });
      });
      return {
        workspaceId: input.targetWorkspaceId,
        manifest: source.manifest,
        ...(source.manifest.transfer_id ? { receipt: transferReceipt(source.manifest, input.targetWorkspaceId) } : {})
      };
    } catch (error) {
      if (importSessionStarted) {
        await this.store.database.withContext({ ...targetContext, importId }, async (sql) => {
          await sql.query("SELECT samurai_abort_workspace_import($1, $2)", [input.targetWorkspaceId, importId]);
        }).catch(() => undefined);
      }
      if (finalRootCreated) await rm(finalRoot, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    } finally {
      await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async readSnapshot(context: WorkspaceRequestContext): Promise<WorkspaceSnapshot> {
    return this.store.database.withReadSnapshot(context, async (sql) => {
      const workspace = await sql.query<Record<string, unknown>>("SELECT id, name, hosting_mode, database_placement, storage_namespace, created_by, version, created_at, updated_at FROM workspaces WHERE id = $1", [context.workspaceId]);
      const accounts = await sql.query<Record<string, unknown>>("SELECT id, public_key, display_name, status, created_at, updated_at FROM samurai_list_workspace_account_identities($1) ORDER BY id", [context.workspaceId]);
      const rooms = await sql.query<Record<string, unknown>>("SELECT workspace_id, id, parent_room_id, name, version, created_by, created_at, updated_at FROM rooms WHERE workspace_id = $1 ORDER BY id", [context.workspaceId]);
      const memberships = await sql.query<Record<string, unknown>>("SELECT workspace_id, account_id, role, state, version, created_at, updated_at, revoked_at FROM workspace_members WHERE workspace_id = $1 ORDER BY account_id", [context.workspaceId]);
      const roomMemberships = await sql.query<Record<string, unknown>>("SELECT workspace_id, room_id, account_id, role, state, version, created_at, updated_at, revoked_at FROM room_members WHERE workspace_id = $1 ORDER BY room_id, account_id", [context.workspaceId]);
      const records = await sql.query<Record<string, unknown>>("SELECT workspace_id, room_id, record_type, id, version, payload, search_text, content_hash, created_by, updated_by, created_at, updated_at FROM workspace_records WHERE workspace_id = $1 ORDER BY record_type, id", [context.workspaceId]);
      const events = await sql.query<Record<string, unknown>>("SELECT id AS source_event_id, workspace_id, room_id, kind, record_type, record_id, operation_id, payload, created_at FROM workspace_events WHERE workspace_id = $1 ORDER BY id", [context.workspaceId]);
      const jobs = await sql.query<Record<string, unknown>>("SELECT workspace_id, room_id, id, kind, status, version, idempotency_key, payload, created_by, updated_by, created_at, updated_at FROM workspace_jobs WHERE workspace_id = $1 ORDER BY id", [context.workspaceId]);
      // Idempotency results may contain a one-time invite token. The ledger is
      // intentionally not portable; immutable events/audits preserve history.
      const operations = { rows: [] as Record<string, unknown>[] };
      const invitations = await sql.query<Record<string, unknown>>("SELECT workspace_id, id, room_id, workspace_role, room_role, created_by, expires_at, revoked_at, accepted_by, accepted_at, version, created_at FROM workspace_invitations WHERE workspace_id = $1 ORDER BY id", [context.workspaceId]);
      const audits = await sql.query<Record<string, unknown>>("SELECT id AS source_audit_id, workspace_id, room_id, actor_account_id, action, outcome, operation_id, subject_kind, subject_id, before_version, after_version, details, created_at FROM workspace_audit_entries WHERE workspace_id = $1 ORDER BY id", [context.workspaceId]);
      const files = await sql.query<Record<string, unknown>>("SELECT workspace_id, room_id, path, version, sha256, size, created_by, updated_by, created_at, updated_at FROM workspace_files WHERE workspace_id = $1 ORDER BY path", [context.workspaceId]);
      const workspaceRow = workspace.rows[0];
      if (!workspaceRow) throw new WorkspaceServerError("workspace_not_found", 404);
      return {
        workspace: workspaceRow,
        accounts: accounts.rows,
        rooms: rooms.rows,
        memberships: memberships.rows,
        roomMemberships: roomMemberships.rows,
        records: records.rows,
        events: events.rows,
        jobs: jobs.rows,
        operations: operations.rows,
        invitations: invitations.rows,
        audits: audits.rows,
        files: files.rows
      };
    });
  }

  /**
   * A regular backup does not freeze its Workspace. Read the database again
   * after copying files and retry a bounded number of times if it changed, so
   * the completed Bundle is one coherent point rather than mixed revisions.
   */
  private async writeStableBundleDirectory(
    context: WorkspaceRequestContext,
    directory: string,
    transferId?: string
  ): Promise<{ manifest: WorkspaceBundleV3Manifest }> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const snapshot = await this.readSnapshot(context);
      try {
        const written = await writeBundleDirectory({
          directory,
          workspaceId: context.workspaceId,
          mode: this.store.mode,
          snapshot,
          files: this.files,
          context,
          ...(transferId ? { transferId } : {})
        });
        const current = await this.readSnapshot(context);
        if (snapshotFingerprint(snapshot) === snapshotFingerprint(current)) return written;
      } catch (error) {
        if (!isTransientBundleSnapshotError(error)) throw error;
      }
      await rm(directory, { recursive: true, force: true });
      if (attempt < 2) await mkdir(directory, { recursive: false, mode: 0o700 });
    }
    throw new WorkspaceServerError("workspace_bundle_snapshot_conflict", 409);
  }

  private incomingRoot(accountId: string, operationId: string): string {
    assertOpaqueId(accountId, "account_id_invalid");
    assertOpaqueId(operationId, "workspace_operation_id_invalid");
    return path.join(this.store.storageRoot, ".incoming", accountId, operationId);
  }

  private incomingMetadataPath(accountId: string, operationId: string): string {
    assertOpaqueId(accountId, "account_id_invalid");
    assertOpaqueId(operationId, "workspace_operation_id_invalid");
    return path.join(this.store.storageRoot, ".incoming", accountId, `${operationId}.json`);
  }

  private async readIncomingMetadata(context: Pick<WorkspaceRequestContext, "accountId" | "operationId">): Promise<IncomingBundleMetadata> {
    assertOpaqueId(context.accountId, "account_id_invalid");
    assertOpaqueId(context.operationId, "workspace_operation_id_invalid");
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.incomingMetadataPath(context.accountId, context.operationId), "utf8"));
    } catch {
      throw new WorkspaceServerError("workspace_import_staging_not_found", 404);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new WorkspaceServerError("workspace_import_staging_invalid", 400);
    const metadata = parsed as Partial<IncomingBundleMetadata>;
    if (metadata.format_version !== 1 || metadata.account_id !== context.accountId || metadata.operation_id !== context.operationId
      || typeof metadata.target_workspace_id !== "string" || !metadata.manifest) {
      throw new WorkspaceServerError("workspace_import_staging_invalid", 400);
    }
    assertOpaqueId(metadata.target_workspace_id, "workspace_id_invalid");
    assertBundleManifestCandidate(metadata.manifest);
    if (metadata.completed !== undefined) assertIncomingCompletion(metadata.completed, metadata.target_workspace_id, metadata.manifest);
    return metadata as IncomingBundleMetadata;
  }

  private async writeIncomingMetadata(
    context: Pick<WorkspaceRequestContext, "accountId" | "operationId">,
    metadata: IncomingBundleMetadata,
    options: { overwrite: boolean }
  ): Promise<void> {
    const target = this.incomingMetadataPath(context.accountId, context.operationId);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    if (!options.overwrite) {
      await writeFile(target, canonicalJson(metadata), { flag: "wx", mode: 0o600 });
      return;
    }
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, canonicalJson(metadata), { flag: "wx", mode: 0o600 });
    await rename(temporary, target);
  }
}

interface IncomingBundleMetadata {
  format_version: 1;
  account_id: string;
  operation_id: string;
  target_workspace_id: string;
  target_workspace_name?: string;
  manifest: WorkspaceBundleV3Manifest;
  completed?: IncomingBundleCompletion;
}

interface IncomingBundleCompletion {
  workspace_id: string;
  manifest: WorkspaceBundleV3Manifest;
  receipt?: WorkspaceTransferReceipt;
  completed_at: string;
}

function incomingMetadataRequest(metadata: Pick<IncomingBundleMetadata, "format_version" | "account_id" | "operation_id" | "target_workspace_id" | "target_workspace_name" | "manifest">): Record<string, unknown> {
  return {
    format_version: metadata.format_version,
    account_id: metadata.account_id,
    operation_id: metadata.operation_id,
    target_workspace_id: metadata.target_workspace_id,
    ...(metadata.target_workspace_name ? { target_workspace_name: metadata.target_workspace_name } : {}),
    manifest: metadata.manifest
  };
}

function assertIncomingCompletion(value: unknown, targetWorkspaceId: string, manifest: WorkspaceBundleV3Manifest): asserts value is IncomingBundleCompletion {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WorkspaceServerError("workspace_import_staging_invalid", 400);
  const completion = value as Partial<IncomingBundleCompletion>;
  if (completion.workspace_id !== targetWorkspaceId || !completion.manifest
    || canonicalJson(completion.manifest) !== canonicalJson(manifest)
    || typeof completion.completed_at !== "string" || !Number.isFinite(new Date(completion.completed_at).getTime())) {
    throw new WorkspaceServerError("workspace_import_staging_invalid", 400);
  }
  if (completion.receipt !== undefined) {
    const receipt = completion.receipt as Partial<WorkspaceTransferReceipt>;
    if (receipt.format_version !== 1 || receipt.target_workspace_id !== targetWorkspaceId
      || receipt.source_workspace_id !== manifest.workspace_id || receipt.source_integrity_hash !== manifest.integrity_hash
      || receipt.target_integrity_hash !== manifest.integrity_hash || receipt.transfer_id !== manifest.transfer_id) {
      throw new WorkspaceServerError("workspace_import_staging_invalid", 400);
    }
  }
}

function completionResult(completion: IncomingBundleCompletion): {
  workspaceId: string;
  manifest: WorkspaceBundleV3Manifest;
  receipt?: WorkspaceTransferReceipt;
} {
  return {
    workspaceId: completion.workspace_id,
    manifest: completion.manifest,
    ...(completion.receipt ? { receipt: completion.receipt } : {})
  };
}

async function assertImportedBundleMatches(
  store: WorkspaceServerStore,
  context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">,
  manifest: WorkspaceBundleV3Manifest
): Promise<void> {
  const result = await store.database.withContext(context, async (sql) => sql.query<{ sha256: string }>(
    "SELECT sha256 FROM workspace_bundles WHERE workspace_id = $1 AND sha256 = $2",
    [context.workspaceId, manifest.integrity_hash]
  ));
  if (!result.rows[0]) throw new WorkspaceServerError("workspace_import_target_exists", 409);
}

async function runExclusiveTransferExport<T>(key: string, action: () => Promise<T>): Promise<T> {
  const previous = transferExportLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const completion = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.catch(() => undefined).then(() => completion);
  transferExportLocks.set(key, queued);
  await previous.catch(() => undefined);
  try {
    return await action();
  } finally {
    release();
    if (transferExportLocks.get(key) === queued) transferExportLocks.delete(key);
  }
}

function isExistingDestinationError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "EEXIST" || code === "ENOTEMPTY";
}

function isTransientBundleSnapshotError(error: unknown): boolean {
  if (error instanceof WorkspaceServerError) {
    return error.code === "workspace_file_hash_mismatch" || error.code === "workspace_file_not_found";
  }
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function snapshotFingerprint(snapshot: WorkspaceSnapshot): string {
  // JSON serialization normalizes PostgreSQL Date values before canonical
  // sorting, so a timestamp change cannot be hidden as an empty object.
  return hashText(canonicalJson(JSON.parse(JSON.stringify(snapshot))));
}

async function readTransfer(
  store: WorkspaceServerStore,
  context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">,
  transferId: string
): Promise<{ state: string; bundlePath?: string }> {
  return store.database.withContext(context, async (sql) => {
    const result = await sql.query<{ state: string; bundle_path: string | null }>(
      "SELECT state, bundle_path FROM workspace_transfers WHERE workspace_id = $1 AND id = $2",
      [context.workspaceId, transferId]
    );
    const row = result.rows[0];
    if (!row) throw new WorkspaceServerError("workspace_transfer_not_found", 404);
    return { state: row.state, ...(row.bundle_path ? { bundlePath: row.bundle_path } : {}) };
  });
}

interface WorkspaceSnapshot {
  workspace: Record<string, unknown>;
  accounts: Record<string, unknown>[];
  rooms: Record<string, unknown>[];
  memberships: Record<string, unknown>[];
  roomMemberships: Record<string, unknown>[];
  records: Record<string, unknown>[];
  events: Record<string, unknown>[];
  jobs: Record<string, unknown>[];
  operations: Record<string, unknown>[];
  invitations: Record<string, unknown>[];
  audits: Record<string, unknown>[];
  files: Record<string, unknown>[];
}

async function writeBundleDirectory(input: {
  directory: string;
  workspaceId: string;
  mode: WorkspaceServerMode;
  snapshot: WorkspaceSnapshot;
  files: WorkspaceFileStore;
  context: WorkspaceRequestContext;
  transferId?: string;
}): Promise<{ manifest: WorkspaceBundleV3Manifest }> {
  const dataFiles: Array<[string, unknown]> = [
    [workspaceFile, input.snapshot.workspace],
    ["accounts.jsonl", input.snapshot.accounts],
    ["rooms.jsonl", input.snapshot.rooms],
    ["memberships.jsonl", input.snapshot.memberships],
    ["room-memberships.jsonl", input.snapshot.roomMemberships],
    ["records.jsonl", input.snapshot.records],
    ["events.jsonl", input.snapshot.events],
    ["jobs.jsonl", input.snapshot.jobs],
    ["operations.jsonl", input.snapshot.operations],
    ["invitations.jsonl", input.snapshot.invitations],
    ["audits.jsonl", input.snapshot.audits],
    ["files.jsonl", input.snapshot.files]
  ];
  for (const [file, payload] of dataFiles) {
    const contents = Array.isArray(payload) ? payload.map((row) => canonicalJson(row)).join("\n") + (payload.length > 0 ? "\n" : "") : canonicalJson(payload);
    await writeFile(path.join(input.directory, file), contents, { flag: "wx", mode: 0o600 });
  }
  for (const row of input.snapshot.files) {
    const filePath = String(row.path ?? "");
    const roomId = String(row.room_id ?? "");
    assertSafeRelativePath(filePath);
    assertOpaqueId(roomId, "room_id_invalid");
    const read = await input.files.read(input.context, { roomId, path: filePath });
    const destination = resolveBundlePath(input.directory, `files/${filePath}`);
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    assertCredentialFreeWorkspaceFile(`files/${filePath}`, read.content);
    await writeFile(destination, read.content, { flag: "wx", mode: 0o600 });
  }
  const hashes = await hashBundleFiles(input.directory, false);
  const recordCounts = {
    rooms: input.snapshot.rooms.length,
    memberships: input.snapshot.memberships.length,
    room_memberships: input.snapshot.roomMemberships.length,
    records: input.snapshot.records.length,
    events: input.snapshot.events.length,
    jobs: input.snapshot.jobs.length,
    operations: input.snapshot.operations.length,
    invitations: input.snapshot.invitations.length,
    audits: input.snapshot.audits.length,
    files: input.snapshot.files.length
  };
  const source = input.snapshot.workspace;
  const manifest: WorkspaceBundleV3Manifest = {
    format_version: 3,
    workspace_id: input.workspaceId,
    exported_at: new Date().toISOString(),
    source: {
      hosting_mode: String(source.hosting_mode) as WorkspaceServerMode,
      database_placement: String(source.database_placement) as "shared" | "dedicated"
    },
    schema_version: 22,
    ...(input.transferId ? { transfer_id: input.transferId } : {}),
    files: hashes,
    record_counts: recordCounts,
    integrity_hash: hashText(canonicalJson({ files: hashes, record_counts: recordCounts }))
  };
  await writeFile(path.join(input.directory, manifestFile), canonicalJson(manifest), { flag: "wx", mode: 0o600 });
  return { manifest };
}

export async function verifyWorkspaceBundleV3(directory: string): Promise<{ directory: string; manifest: WorkspaceBundleV3Manifest }> {
  const root = path.resolve(directory);
  const manifestRaw = await readFile(path.join(root, manifestFile), "utf8");
  const manifest = JSON.parse(manifestRaw) as WorkspaceBundleV3Manifest;
  if (!manifest || manifest.format_version !== 3 || !manifest.files || !manifest.record_counts) throw new WorkspaceServerError("workspace_bundle_v3_manifest_invalid", 400);
  assertOpaqueId(manifest.workspace_id, "workspace_bundle_workspace_id_invalid");
  if (manifest.source?.hosting_mode !== "hosted" && manifest.source?.hosting_mode !== "self_host") throw new WorkspaceServerError("workspace_bundle_v3_manifest_invalid", 400);
  if (manifest.source?.database_placement !== "shared" && manifest.source?.database_placement !== "dedicated") throw new WorkspaceServerError("workspace_bundle_v3_manifest_invalid", 400);
  if (manifest.schema_version !== undefined && (!Number.isSafeInteger(manifest.schema_version) || manifest.schema_version < 1)) {
    throw new WorkspaceServerError("workspace_bundle_v3_manifest_invalid", 400);
  }
  if (manifest.transfer_id !== undefined) assertOpaqueId(manifest.transfer_id, "workspace_transfer_id_invalid");
  const actual = await hashBundleFiles(root, false);
  if (canonicalJson(actual) !== canonicalJson(manifest.files)) throw new WorkspaceServerError("workspace_bundle_v3_hash_mismatch", 400);
  if (manifest.integrity_hash !== hashText(canonicalJson({ files: manifest.files, record_counts: manifest.record_counts }))) {
    throw new WorkspaceServerError("workspace_bundle_v3_integrity_hash_mismatch", 400);
  }
  const expected = new Set([workspaceFile, ...jsonlFiles]);
  for (const file of Object.keys(actual)) {
    if (file !== workspaceFile && !jsonlFiles.includes(file as (typeof jsonlFiles)[number]) && !file.startsWith("files/")) {
      throw new WorkspaceServerError("workspace_bundle_v3_unexpected_file", 400);
    }
    expected.delete(file);
  }
  if (expected.size > 0) throw new WorkspaceServerError("workspace_bundle_v3_required_file_missing", 400);
  const rowsByFile = new Map<string, Record<string, unknown>[]>();
  for (const file of [workspaceFile, ...jsonlFiles]) {
    const rows = await assertPortableJsonFile(path.join(root, file), file);
    rowsByFile.set(file, rows);
  }
  assertPortableBundleRelations(manifest, rowsByFile);
  for (const file of Object.keys(actual).filter((item) => item.startsWith("files/"))) {
    assertCredentialFreeWorkspaceFile(file, await readFile(resolveBundlePath(root, file)));
  }
  return { directory: root, manifest };
}

/** Creates the portable HTTP body only after the on-disk Bundle verifies. */
export async function readWorkspaceBundleV3Transport(directory: string): Promise<WorkspaceBundleV3Transport> {
  const verified = await verifyWorkspaceBundleV3(directory);
  const entries: WorkspaceBundleV3Transport["entries"] = [];
  let total = 0;
  for (const relativePath of Object.keys(verified.manifest.files).sort()) {
    const content = await readFile(resolveBundlePath(verified.directory, relativePath));
    total += content.byteLength;
    if (total > 24 * 1024 * 1024) throw new WorkspaceServerError("workspace_bundle_v3_transport_too_large", 413);
    entries.push({ path: relativePath, content_base64: content.toString("base64") });
  }
  return { format: transportFormat, manifest: verified.manifest, entries };
}

/** Materializes an uploaded transport into a private directory, then verifies every hash. */
export async function writeWorkspaceBundleV3Transport(input: { transport: unknown; destination: string }): Promise<{ directory: string; manifest: WorkspaceBundleV3Manifest }> {
  const transport = parseTransport(input.transport);
  const destination = path.resolve(input.destination);
  await mkdir(destination, { recursive: false, mode: 0o700 });
  let complete = false;
  try {
    const expected = new Set(Object.keys(transport.manifest.files));
    let total = 0;
    for (const entry of transport.entries) {
      assertSafeRelativePath(entry.path);
      if (!expected.delete(entry.path)) throw new WorkspaceServerError("workspace_bundle_v3_transport_entry_invalid", 400);
      const content = decodeTransportContent(entry.content_base64);
      total += content.byteLength;
      if (total > 24 * 1024 * 1024) throw new WorkspaceServerError("workspace_bundle_v3_transport_too_large", 413);
      if (hashBytes(content) !== transport.manifest.files[entry.path]) throw new WorkspaceServerError("workspace_bundle_v3_hash_mismatch", 400);
      const target = resolveBundlePath(destination, entry.path);
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, content, { flag: "wx", mode: 0o600 });
    }
    if (expected.size > 0) throw new WorkspaceServerError("workspace_bundle_v3_required_file_missing", 400);
    await writeFile(path.join(destination, manifestFile), canonicalJson(transport.manifest), { flag: "wx", mode: 0o600 });
    const verified = await verifyWorkspaceBundleV3(destination);
    complete = true;
    return verified;
  } finally {
    if (!complete) await rm(destination, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function assertCredentialFreeWorkspaceFile(relativePath: string, content: Uint8Array): void {
  assertSafeRelativePath(relativePath);
  if (!relativePath.startsWith("files/") || credentialFilePath.test(relativePath)) {
    throw new WorkspaceServerError("workspace_bundle_v3_contains_credential", 400);
  }
  const text = Buffer.from(content).toString("utf8");
  if (!text.includes("\0") && credentialText.test(text)) {
    throw new WorkspaceServerError("workspace_bundle_v3_contains_credential", 400);
  }
}

async function importSnapshot(sql: WorkspaceSql, input: {
  sourceDirectory: string;
  targetWorkspaceId: string;
  targetWorkspaceName?: string;
  ownerAccountId: string;
  mode: WorkspaceServerMode;
}): Promise<void> {
  for (const row of await readJsonl(path.join(input.sourceDirectory, "accounts.jsonl"))) {
    const accountId = String(row.id);
    // The receiving operator was authenticated locally before import starts.
    // A historical source snapshot must never disable or replace that local
    // identity while it is the only account able to finish the import.
    if (accountId === input.ownerAccountId) continue;
    const publicKey = String(row.public_key);
    assertAccountIdMatchesPublicKey(accountId, publicKey);
    await sql.query("SELECT samurai_import_workspace_account_identity($1, $2, $3, $4, $5)", [
      input.targetWorkspaceId,
      accountId,
      publicKey,
      String(row.display_name ?? accountId).slice(0, 500),
      String(row.status ?? "active")
    ]);
  }
  const memberships = await readJsonl(path.join(input.sourceDirectory, "memberships.jsonl"));
  for (const row of memberships) {
    // The target-side owner is created by the import session itself. Do not
    // let an old source membership revoke or downgrade the person importing.
    if (row.account_id === input.ownerAccountId) continue;
    await sql.query(
      "SELECT samurai_import_workspace_member($1, $2, $3, $4, $5, $6::TIMESTAMPTZ, $7::TIMESTAMPTZ, $8::TIMESTAMPTZ)",
      [input.targetWorkspaceId, String(row.account_id), String(row.role), String(row.state), Number(row.version ?? 1), String(row.created_at), String(row.updated_at), row.revoked_at ? String(row.revoked_at) : null]
    );
  }
  const rooms = await readJsonl(path.join(input.sourceDirectory, "rooms.jsonl"));
  for (const row of rooms) {
    await sql.query(
      "SELECT samurai_import_workspace_room($1, $2, $3, $4, $5, $6, $7::TIMESTAMPTZ, $8::TIMESTAMPTZ)",
      [
        input.targetWorkspaceId,
        String(row.id),
        row.parent_room_id ? String(row.parent_room_id) : null,
        String(row.name),
        Number(row.version),
        String(row.created_by ?? input.ownerAccountId),
        String(row.created_at),
        String(row.updated_at)
      ]
    );
  }
  const roomMemberships = await readJsonl(path.join(input.sourceDirectory, "room-memberships.jsonl"));
  for (const row of roomMemberships) {
    await sql.query(
      "SELECT samurai_import_workspace_room_member($1, $2, $3, $4, $5, $6, $7::TIMESTAMPTZ, $8::TIMESTAMPTZ, $9::TIMESTAMPTZ)",
      [
        input.targetWorkspaceId,
        String(row.room_id),
        String(row.account_id),
        String(row.role),
        String(row.state),
        Number(row.version ?? 1),
        String(row.created_at),
        String(row.updated_at),
        row.revoked_at ? String(row.revoked_at) : null
      ]
    );
  }
  // Validation happens while the target is still read-only.  Completion calls
  // the same guard again immediately before activation.
  await sql.query("SELECT samurai_validate_workspace_room_hierarchy($1)", [input.targetWorkspaceId]);
  for (const [file, table, columns] of [
    ["records.jsonl", "workspace_records", ["room_id", "record_type", "id", "version", "payload", "search_text", "content_hash", "created_by", "updated_by", "created_at", "updated_at"]],
    ["events.jsonl", "workspace_events", ["source_event_id", "room_id", "kind", "record_type", "record_id", "operation_id", "payload", "created_at"]],
    ["jobs.jsonl", "workspace_jobs", ["room_id", "id", "kind", "status", "version", "idempotency_key", "payload", "created_by", "updated_by", "created_at", "updated_at"]],
    ["files.jsonl", "workspace_files", ["room_id", "path", "version", "sha256", "size", "created_by", "updated_by", "created_at", "updated_at"]]
  ] as const) {
    const rows = await readJsonl(path.join(input.sourceDirectory, file));
    for (const row of rows) {
      const placeholders = columns.map((_, index) => `$${index + 2}`).join(", ");
      const values = columns.map((column) => jsonColumnValue(row[column]));
      const sqlColumns = ["workspace_id", ...columns].join(", ");
      await sql.query(`INSERT INTO ${table}(${sqlColumns}) VALUES ($1, ${placeholders})`, [input.targetWorkspaceId, ...values]);
    }
  }
  // Invite tokens are intentionally excluded from Bundle v3. Historical rows
  // survive, but an unaccepted source invitation is revoked on import because
  // it cannot be safely replayed under the target server's signing secret.
  for (const row of await readJsonl(path.join(input.sourceDirectory, "invitations.jsonl"))) {
    const id = String(row.id);
    const historicalState = row.accepted_at ? "accepted" : row.revoked_at ? "revoked" : "revoked";
    await sql.query(
      `INSERT INTO workspace_invitations(
         workspace_id, id, room_id, token_hash, workspace_role, room_role, created_by,
         expires_at, revoked_at, accepted_by, accepted_at, version, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::TIMESTAMPTZ, $9::TIMESTAMPTZ, $10, $11::TIMESTAMPTZ, $12, $13::TIMESTAMPTZ)`,
      [
        input.targetWorkspaceId,
        id,
        row.room_id ? String(row.room_id) : null,
        `imported_${hashText(`${input.targetWorkspaceId}|${id}`)}`,
        String(row.workspace_role),
        row.room_role ? String(row.room_role) : null,
        String(row.created_by ?? input.ownerAccountId),
        String(row.expires_at ?? new Date().toISOString()),
        historicalState === "accepted" ? null : (row.revoked_at ? String(row.revoked_at) : new Date().toISOString()),
        row.accepted_by ? String(row.accepted_by) : null,
        row.accepted_at ? String(row.accepted_at) : null,
        Number(row.version ?? 1),
        String(row.created_at ?? new Date().toISOString())
      ]
    );
  }
  for (const row of await readJsonl(path.join(input.sourceDirectory, "audits.jsonl"))) {
    await sql.query(
      `SELECT samurai_import_workspace_audit(
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::JSONB, $12::TIMESTAMPTZ
       )`,
      [
        input.targetWorkspaceId,
        row.room_id ? String(row.room_id) : null,
        String(row.actor_account_id ?? input.ownerAccountId),
        String(row.action),
        String(row.outcome),
        row.operation_id ? String(row.operation_id) : null,
        row.subject_kind ? String(row.subject_kind) : null,
        row.subject_id ? String(row.subject_id) : null,
        row.before_version === null || row.before_version === undefined ? null : Number(row.before_version),
        row.after_version === null || row.after_version === undefined ? null : Number(row.after_version),
        canonicalJson(row.details && typeof row.details === "object" ? row.details : {}),
        String(row.created_at ?? new Date().toISOString())
      ]
    );
  }
}

async function verifyImportedWorkspace(
  store: WorkspaceServerStore,
  context: WorkspaceRequestContext,
  manifest: WorkspaceBundleV3Manifest,
  sourceDirectory: string
): Promise<void> {
  await assertWorkspaceOwner(store, context);
  const counts = await store.database.withContext(context, async (sql) => {
    const rows = await Promise.all([
      count(sql, "rooms", context.workspaceId), count(sql, "workspace_members", context.workspaceId), count(sql, "room_members", context.workspaceId), count(sql, "workspace_records", context.workspaceId), count(sql, "workspace_events", context.workspaceId),
      count(sql, "workspace_jobs", context.workspaceId), count(sql, "workspace_operations", context.workspaceId), count(sql, "workspace_invitations", context.workspaceId), count(sql, "workspace_audit_entries", context.workspaceId), count(sql, "workspace_files", context.workspaceId)
    ]);
    return { rooms: rows[0], memberships: rows[1], room_memberships: rows[2], records: rows[3], events: rows[4], jobs: rows[5], operations: rows[6], invitations: rows[7], audits: rows[8], files: rows[9] };
  });
  // The importer is guaranteed an active Owner membership on the target. If
  // they were not a member in the source, that adds exactly one local row.
  // Import completion also appends a local audit event, so audit history must
  // contain every source row rather than be byte-for-byte identical.
  const sourceMemberships = await readJsonl(path.join(sourceDirectory, "memberships.jsonl"));
  const expectedMemberships = (manifest.record_counts.memberships ?? 0)
    + (sourceMemberships.some((row) => row.account_id === context.accountId) ? 0 : 1);
  const expected = { ...manifest.record_counts, memberships: expectedMemberships };
  const countsMatch = Object.entries(expected).every(([name, expectedCount]) => {
    const actual = counts[name as keyof typeof counts];
    return name === "audits" ? actual >= expectedCount : actual === expectedCount;
  });
  if (!countsMatch) throw new WorkspaceServerError("workspace_import_count_mismatch", 400);
  const files = new WorkspaceFileStore(store);
  const metadata = await store.database.withContext(context, async (sql) => {
    const result = await sql.query<{ room_id: string; path: string; sha256: string }>("SELECT room_id, path, sha256 FROM workspace_files WHERE workspace_id = $1", [context.workspaceId]);
    return result.rows;
  });
  for (const file of metadata) {
    const read = await files.read(context, { roomId: file.room_id, path: file.path });
    if (read.file.sha256 !== file.sha256) throw new WorkspaceServerError("workspace_import_file_hash_mismatch", 400);
  }
}

async function assertWorkspaceOwner(store: WorkspaceServerStore, context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">): Promise<void> {
  await store.database.withContext(context, async (sql) => {
    const result = await sql.query<{ allowed: boolean }>("SELECT samurai_can_workspace($1, 'owner') AS allowed", [context.workspaceId]);
    if (result.rows[0]?.allowed !== true) throw new WorkspaceServerError("workspace_owner_permission_required", 403);
  });
}

async function count(sql: WorkspaceSql, table: string, workspaceId: string): Promise<number> {
  const result = await sql.query<{ count: string }>(`SELECT COUNT(*)::TEXT AS count FROM ${table} WHERE workspace_id = $1`, [workspaceId]);
  return Number(result.rows[0]?.count ?? 0);
}


async function copyBundleFilesToStaging(source: string, stagingRoot: string, hashes: Record<string, string>): Promise<void> {
  await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
  for (const [relativePath, expectedHash] of Object.entries(hashes)) {
    if (!relativePath.startsWith("files/")) continue;
    const sourcePath = resolveBundlePath(source, relativePath);
    const content = await readFile(sourcePath);
    if (hashBytes(content) !== expectedHash) throw new WorkspaceServerError("workspace_bundle_v3_hash_mismatch", 400);
    const target = resolveBundlePath(stagingRoot, relativePath);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, content, { flag: "wx", mode: 0o600 });
  }
}

async function hashBundleFiles(root: string, includeManifest: boolean): Promise<Record<string, string>> {
  const files = await listRegularFiles(root);
  const output: Record<string, string> = {};
  for (const relative of files) {
    if (!includeManifest && relative === manifestFile) continue;
    output[relative] = hashBytes(await readFile(resolveBundlePath(root, relative)));
  }
  return Object.fromEntries(Object.entries(output).sort(([left], [right]) => left.localeCompare(right)));
}

async function listRegularFiles(root: string): Promise<string[]> {
  const visit = async (directory: string, prefix: string): Promise<string[]> => {
    const names = await readdir(directory);
    const entries: string[] = [];
    for (const name of names.sort()) {
      const relative = prefix ? `${prefix}/${name}` : name;
      const full = path.join(directory, name);
      const info = await lstat(full);
      if (info.isDirectory()) entries.push(...await visit(full, relative));
      else if (info.isFile()) entries.push(relative);
      else throw new WorkspaceServerError("workspace_bundle_v3_file_type_invalid", 400);
    }
    return entries;
  };
  return (await visit(root, "")).sort();
}

function resolveBundlePath(root: string, relative: string): string {
  assertSafeRelativePath(relative);
  const resolved = path.resolve(root, ...relative.split("/"));
  const offset = path.relative(root, resolved);
  if (offset === ".." || offset.startsWith(`..${path.sep}`) || path.isAbsolute(offset)) throw new WorkspaceServerError("workspace_bundle_v3_path_invalid", 400);
  return resolved;
}

async function assertPortableJsonFile(file: string, relativeFile: string): Promise<Record<string, unknown>[]> {
  const schema = portableSchema[relativeFile];
  if (!schema) throw new WorkspaceServerError("workspace_bundle_v3_schema_invalid", 400);
  const text = await readFile(file, "utf8");
  const rows = relativeFile.endsWith(".jsonl") ? text.split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [JSON.parse(text)];
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new WorkspaceServerError("workspace_bundle_v3_schema_invalid", 400);
    const record = row as Record<string, unknown>;
    assertExactPortableFields(record, schema);
    assertCredentialFree(record);
  }
  return rows as Record<string, unknown>[];
}

function assertCredentialFree(value: unknown): void {
  if (typeof value === "string") {
    if (credentialText.test(value)) throw new WorkspaceServerError("workspace_bundle_v3_contains_credential", 400);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertCredentialFree(item);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (credentialFieldNames.has(key.toLowerCase().replace(/[^a-z0-9]/g, ""))) {
      throw new WorkspaceServerError("workspace_bundle_v3_contains_credential", 400);
    }
    assertCredentialFree(nested);
  }
}

function assertExactPortableFields(value: Record<string, unknown>, schema: { required: readonly string[]; allowed: readonly string[] }): void {
  const allowed = new Set(schema.allowed);
  if (Object.keys(value).some((key) => !allowed.has(key)) || schema.required.some((key) => !(key in value))) {
    throw new WorkspaceServerError("workspace_bundle_v3_schema_invalid", 400);
  }
}

function assertPortableBundleRelations(manifest: WorkspaceBundleV3Manifest, rowsByFile: Map<string, Record<string, unknown>[]>): void {
  const workspace = rowsByFile.get(workspaceFile)?.[0];
  if (workspace?.id !== manifest.workspace_id) throw new WorkspaceServerError("workspace_bundle_workspace_mismatch", 400);
  const sourceOwnerAccountId = opaquePortableValue(workspace?.created_by, "workspace_bundle_v3_schema_invalid");
  const accountIds = new Set<string>();
  const accountStates = new Map<string, "active" | "disabled">();
  for (const account of rowsByFile.get("accounts.jsonl") ?? []) {
    const accountId = opaquePortableValue(account.id, "workspace_bundle_v3_schema_invalid");
    const publicKey = account.public_key;
    if (typeof publicKey !== "string") throw new WorkspaceServerError("workspace_bundle_v3_schema_invalid", 400);
    assertAccountIdMatchesPublicKey(accountId, publicKey);
    if (accountIds.has(accountId)) throw new WorkspaceServerError("workspace_bundle_v3_relation_invalid", 400);
    if (account.status !== undefined && account.status !== "active" && account.status !== "disabled") {
      throw new WorkspaceServerError("workspace_bundle_v3_schema_invalid", 400);
    }
    accountIds.add(accountId);
    accountStates.set(accountId, account.status === "disabled" ? "disabled" : "active");
  }
  // A legacy SQLite migration can safely preserve only its configured local
  // owner because old rows have no portable public-key identity. Every other
  // principal must be proven by accounts.jsonl.
  const knownAccountIds = new Set([...accountIds, sourceOwnerAccountId]);
  const memberAccountIds = new Set<string>();
  const workspaceMembershipStates = new Map<string, "active" | "revoked">();
  let activeWorkspaceOwnerCount = 0;
  for (const row of rowsByFile.get("memberships.jsonl") ?? []) {
    const accountId = opaquePortableValue(row.account_id, "workspace_bundle_v3_relation_invalid");
    if (!knownAccountIds.has(accountId) || memberAccountIds.has(accountId)
      || (row.state !== "active" && row.state !== "revoked")) {
      throw new WorkspaceServerError("workspace_bundle_v3_relation_invalid", 400);
    }
    if (row.state === "active" && accountStates.get(accountId) === "disabled") {
      throw new WorkspaceServerError("workspace_bundle_v3_relation_invalid", 400);
    }
    memberAccountIds.add(accountId);
    workspaceMembershipStates.set(accountId, row.state);
    if (row.state === "active" && row.role === "owner") activeWorkspaceOwnerCount += 1;
  }
  if (activeWorkspaceOwnerCount === 0) throw new WorkspaceServerError("workspace_bundle_v3_relation_invalid", 400);
  const roomIds = new Set<string>();
  const parentRoomIds = new Map<string, string | undefined>();
  for (const row of rowsByFile.get("rooms.jsonl") ?? []) {
    const roomId = opaquePortableValue(row.id, "workspace_bundle_v3_relation_invalid");
    const createdBy = opaquePortableValue(row.created_by, "workspace_bundle_v3_relation_invalid");
    if (roomIds.has(roomId) || !knownAccountIds.has(createdBy)) {
      throw new WorkspaceServerError("workspace_bundle_v3_relation_invalid", 400);
    }
    roomIds.add(roomId);
    if (row.parent_room_id !== undefined && row.parent_room_id !== null) {
      parentRoomIds.set(roomId, opaquePortableValue(row.parent_room_id, "workspace_bundle_v3_relation_invalid"));
    }
  }
  for (const [roomId, parentRoomId] of parentRoomIds) {
    if (!parentRoomId || parentRoomId === roomId || !roomIds.has(parentRoomId)) {
      throw new WorkspaceServerError("workspace_bundle_v3_relation_invalid", 400);
    }
  }
  // Iterative walk keeps valid, intentionally deep Room trees from consuming
  // the JavaScript call stack during Restore verification.
  for (const startingRoomId of roomIds) {
    const visited = new Set<string>();
    let roomId: string | undefined = startingRoomId;
    while (roomId) {
      if (visited.has(roomId)) throw new WorkspaceServerError("workspace_bundle_v3_relation_invalid", 400);
      visited.add(roomId);
      roomId = parentRoomIds.get(roomId);
    }
  }
  const roomMembershipStates = new Map<string, string>();
  for (const row of rowsByFile.get("room-memberships.jsonl") ?? []) {
    const roomId = opaquePortableValue(row.room_id, "workspace_bundle_v3_relation_invalid");
    const accountId = opaquePortableValue(row.account_id, "workspace_bundle_v3_relation_invalid");
    const key = roomId + "\u0000" + accountId;
    roomMembershipStates.set(key, String(row.state));
  }
  const roomMembershipKeys = new Set<string>();
  const activeRoomOwnerCounts = new Map<string, number>();
  for (const row of rowsByFile.get("room-memberships.jsonl") ?? []) {
    const roomId = opaquePortableValue(row.room_id, "workspace_bundle_v3_relation_invalid");
    const accountId = opaquePortableValue(row.account_id, "workspace_bundle_v3_relation_invalid");
    const key = `${roomId}\u0000${accountId}`;
    if (!roomIds.has(roomId) || !memberAccountIds.has(accountId) || roomMembershipKeys.has(key)) {
      throw new WorkspaceServerError("workspace_bundle_v3_relation_invalid", 400);
    }
    roomMembershipKeys.add(key);
    if (row.state === "active") {
      if (workspaceMembershipStates.get(accountId) !== "active" || accountStates.get(accountId) === "disabled") {
        throw new WorkspaceServerError("workspace_bundle_v3_relation_invalid", 400);
      }
      if (row.role === "owner") {
        activeRoomOwnerCounts.set(roomId, (activeRoomOwnerCounts.get(roomId) ?? 0) + 1);
      }
      let ancestorRoomId = parentRoomIds.get(roomId);
      while (ancestorRoomId) {
        if (roomMembershipStates.get(ancestorRoomId + "\u0000" + accountId) !== "active") {
          throw new WorkspaceServerError("workspace_bundle_v3_relation_invalid", 400);
        }
        ancestorRoomId = parentRoomIds.get(ancestorRoomId);
      }
    }
  }
  for (const roomId of roomIds) {
    if ((activeRoomOwnerCounts.get(roomId) ?? 0) === 0) {
      throw new WorkspaceServerError("workspace_bundle_v3_relation_invalid", 400);
    }
  }
  for (const [file, actorColumns] of [
    ["records.jsonl", ["room_id", "created_by", "updated_by"]],
    ["jobs.jsonl", ["room_id", "created_by", "updated_by"]],
    ["files.jsonl", ["room_id", "created_by", "updated_by"]]
  ] as const) {
    for (const row of rowsByFile.get(file) ?? []) {
      const roomId = opaquePortableValue(row[actorColumns[0]], "workspace_bundle_v3_relation_invalid");
      const createdBy = opaquePortableValue(row[actorColumns[1]], "workspace_bundle_v3_relation_invalid");
      const updatedBy = opaquePortableValue(row[actorColumns[2]], "workspace_bundle_v3_relation_invalid");
      if (!roomIds.has(roomId) || !knownAccountIds.has(createdBy) || !knownAccountIds.has(updatedBy)) {
        throw new WorkspaceServerError("workspace_bundle_v3_relation_invalid", 400);
      }
    }
  }
  for (const row of rowsByFile.get("events.jsonl") ?? []) {
    if (!roomIds.has(opaquePortableValue(row.room_id, "workspace_bundle_v3_relation_invalid"))) {
      throw new WorkspaceServerError("workspace_bundle_v3_relation_invalid", 400);
    }
  }
  for (const row of rowsByFile.get("invitations.jsonl") ?? []) {
    const roomId = row.room_id === null ? undefined : opaquePortableValue(row.room_id, "workspace_bundle_v3_relation_invalid");
    const createdBy = opaquePortableValue(row.created_by, "workspace_bundle_v3_relation_invalid");
    const acceptedBy = row.accepted_by === null ? undefined : opaquePortableValue(row.accepted_by, "workspace_bundle_v3_relation_invalid");
    if ((roomId && !roomIds.has(roomId)) || !knownAccountIds.has(createdBy) || (acceptedBy && !knownAccountIds.has(acceptedBy))) {
      throw new WorkspaceServerError("workspace_bundle_v3_relation_invalid", 400);
    }
  }
  for (const row of rowsByFile.get("audits.jsonl") ?? []) {
    const roomId = row.room_id === null ? undefined : opaquePortableValue(row.room_id, "workspace_bundle_v3_relation_invalid");
    const actorAccountId = opaquePortableValue(row.actor_account_id, "workspace_bundle_v3_relation_invalid");
    if ((roomId && !roomIds.has(roomId)) || !knownAccountIds.has(actorAccountId)) {
      throw new WorkspaceServerError("workspace_bundle_v3_relation_invalid", 400);
    }
  }
  const counts: Record<string, number> = {
    rooms: rowsByFile.get("rooms.jsonl")?.length ?? 0,
    memberships: rowsByFile.get("memberships.jsonl")?.length ?? 0,
    room_memberships: rowsByFile.get("room-memberships.jsonl")?.length ?? 0,
    records: rowsByFile.get("records.jsonl")?.length ?? 0,
    events: rowsByFile.get("events.jsonl")?.length ?? 0,
    jobs: rowsByFile.get("jobs.jsonl")?.length ?? 0,
    operations: rowsByFile.get("operations.jsonl")?.length ?? 0,
    invitations: rowsByFile.get("invitations.jsonl")?.length ?? 0,
    audits: rowsByFile.get("audits.jsonl")?.length ?? 0,
    files: rowsByFile.get("files.jsonl")?.length ?? 0
  };
  if (canonicalJson(counts) !== canonicalJson(manifest.record_counts)) {
    throw new WorkspaceServerError("workspace_bundle_v3_record_count_mismatch", 400);
  }
  if (counts.operations !== 0) throw new WorkspaceServerError("workspace_bundle_v3_operations_not_portable", 400);
  for (const file of ["rooms.jsonl", "memberships.jsonl", "room-memberships.jsonl", "records.jsonl", "events.jsonl", "jobs.jsonl", "invitations.jsonl", "audits.jsonl", "files.jsonl"] as const) {
    for (const row of rowsByFile.get(file) ?? []) {
      if (row.workspace_id !== manifest.workspace_id) throw new WorkspaceServerError("workspace_bundle_workspace_mismatch", 400);
    }
  }
  const metadataPaths = new Set<string>();
  for (const row of rowsByFile.get("files.jsonl") ?? []) {
    if (typeof row.path !== "string" || typeof row.sha256 !== "string") throw new WorkspaceServerError("workspace_bundle_v3_schema_invalid", 400);
    assertSafeRelativePath(row.path);
    const bundlePath = `files/${row.path}`;
    if (metadataPaths.has(bundlePath) || manifest.files[bundlePath] !== row.sha256) {
      throw new WorkspaceServerError("workspace_bundle_v3_file_metadata_mismatch", 400);
    }
    metadataPaths.add(bundlePath);
  }
  for (const bundlePath of Object.keys(manifest.files).filter((path) => path.startsWith("files/"))) {
    if (!metadataPaths.has(bundlePath)) throw new WorkspaceServerError("workspace_bundle_v3_file_metadata_mismatch", 400);
  }
}

function opaquePortableValue(value: unknown, code: string): string {
  if (typeof value !== "string") throw new WorkspaceServerError(code, 400);
  return assertOpaqueId(value, code);
}

async function readJsonl(file: string): Promise<Record<string, unknown>[]> {
  const text = await readFile(file, "utf8");
  return text.split("\n").filter(Boolean).map((line) => {
    const parsed = JSON.parse(line) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new WorkspaceServerError("workspace_bundle_v3_jsonl_invalid", 400);
    return parsed as Record<string, unknown>;
  });
}

async function readJsonObject(file: string): Promise<Record<string, unknown>> {
  const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new WorkspaceServerError("workspace_bundle_v3_json_invalid", 400);
  return parsed as Record<string, unknown>;
}

function jsonColumnValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "object") return canonicalJson(value);
  return value;
}

async function pathExists(target: string): Promise<boolean> {
  return lstat(target).then(() => true).catch(() => false);
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hashBytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function parseTransport(value: unknown): WorkspaceBundleV3Transport {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WorkspaceServerError("workspace_bundle_v3_transport_invalid", 400);
  const candidate = value as Partial<WorkspaceBundleV3Transport>;
  if (candidate.format !== transportFormat || !candidate.manifest || !Array.isArray(candidate.entries)) {
    throw new WorkspaceServerError("workspace_bundle_v3_transport_invalid", 400);
  }
  if (typeof candidate.manifest !== "object" || Array.isArray(candidate.manifest)
    || !(candidate.manifest as WorkspaceBundleV3Manifest).files
    || typeof (candidate.manifest as WorkspaceBundleV3Manifest).files !== "object"
    || Array.isArray((candidate.manifest as WorkspaceBundleV3Manifest).files)) {
    throw new WorkspaceServerError("workspace_bundle_v3_transport_invalid", 400);
  }
  const paths = new Set<string>();
  const entries = candidate.entries.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new WorkspaceServerError("workspace_bundle_v3_transport_entry_invalid", 400);
    const pathValue = (entry as { path?: unknown }).path;
    const content = (entry as { content_base64?: unknown }).content_base64;
    if (typeof pathValue !== "string" || typeof content !== "string" || !pathValue || paths.has(pathValue)) {
      throw new WorkspaceServerError("workspace_bundle_v3_transport_entry_invalid", 400);
    }
    paths.add(pathValue);
    return { path: pathValue, content_base64: content };
  });
  return { format: transportFormat, manifest: candidate.manifest as WorkspaceBundleV3Manifest, entries };
}

function assertBundleManifestCandidate(manifest: WorkspaceBundleV3Manifest): void {
  if (!manifest || manifest.format_version !== 3 || typeof manifest.workspace_id !== "string"
    || !manifest.source || !manifest.files || typeof manifest.files !== "object" || Array.isArray(manifest.files)
    || !manifest.record_counts || typeof manifest.record_counts !== "object" || Array.isArray(manifest.record_counts)
    || typeof manifest.integrity_hash !== "string") {
    throw new WorkspaceServerError("workspace_bundle_v3_manifest_invalid", 400);
  }
  assertOpaqueId(manifest.workspace_id, "workspace_bundle_workspace_id_invalid");
  if (manifest.source.hosting_mode !== "hosted" && manifest.source.hosting_mode !== "self_host") throw new WorkspaceServerError("workspace_bundle_v3_manifest_invalid", 400);
  if (manifest.source.database_placement !== "shared" && manifest.source.database_placement !== "dedicated") throw new WorkspaceServerError("workspace_bundle_v3_manifest_invalid", 400);
  if (!/^[a-f0-9]{64}$/.test(manifest.integrity_hash)) throw new WorkspaceServerError("workspace_bundle_v3_manifest_invalid", 400);
  for (const [relativePath, hash] of Object.entries(manifest.files)) {
    assertSafeRelativePath(relativePath);
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new WorkspaceServerError("workspace_bundle_v3_manifest_invalid", 400);
  }
  for (const count of Object.values(manifest.record_counts)) {
    if (!Number.isSafeInteger(count) || count < 0) throw new WorkspaceServerError("workspace_bundle_v3_manifest_invalid", 400);
  }
}

function decodeTransportContent(value: string): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new WorkspaceServerError("workspace_bundle_v3_transport_entry_invalid", 400);
  }
  return Buffer.from(value, "base64");
}

function transferReceipt(manifest: WorkspaceBundleV3Manifest, targetWorkspaceId: string): WorkspaceTransferReceipt {
  if (!manifest.transfer_id) throw new WorkspaceServerError("workspace_transfer_receipt_invalid", 400);
  return {
    format_version: 1,
    transfer_id: manifest.transfer_id,
    source_workspace_id: manifest.workspace_id,
    source_integrity_hash: manifest.integrity_hash,
    target_workspace_id: targetWorkspaceId,
    imported_at: new Date().toISOString(),
    target_integrity_hash: manifest.integrity_hash
  };
}
