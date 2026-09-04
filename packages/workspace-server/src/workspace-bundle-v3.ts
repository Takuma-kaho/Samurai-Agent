import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { ResourceRefSchema } from "@samurai-agent/core-schemas";
import { assertOpaqueId, assertSafeRelativePath } from "./config";
import { assertAccountIdMatchesPublicKey, canonicalJson } from "./auth";
import { WorkspaceServerError } from "./errors";
import type { WorkspaceSql } from "./postgres";
import type { WorkspaceBundleV3Manifest, WorkspaceRequestContext, WorkspaceServerMode, WorkspaceTransferReceipt } from "./types";
import { WorkspaceFileStore } from "./workspace-files";
import { WorkspaceServerStore } from "./workspace-server-store";

/**
 * Provenance was added after the original V3 contract.  Keep the public
 * `WorkspaceBundleV3Manifest` type compatible with older callers while
 * accepting the richer manifest on disk and at the transport boundary.
 */
type WorkspaceBundleV3ManifestWithProvenance = WorkspaceBundleV3Manifest & {
  source: WorkspaceBundleV3Manifest["source"] & { organization_id?: string };
  /** Historical raw provenance accepted when reading old Bundles only. */
  source_organization_id?: string;
  /** Schema revision of the portable snapshot contract. */
  schema_revision?: number;
};

const legacyBundleSchemaRevision = 26;

const manifestFile = "manifest.json";
const workspaceFile = "workspace.json";
const coreJsonlFiles = ["accounts.jsonl", "rooms.jsonl", "memberships.jsonl", "room-memberships.jsonl", "records.jsonl", "events.jsonl", "jobs.jsonl", "operations.jsonl", "invitations.jsonl", "audits.jsonl", "files.jsonl"] as const;
// Bundle v3 remains backward compatible: a Bundle exported before the
// learning loop simply has empty rows for these optional files on import.
const learningJsonlFiles = [
  "learning-activities.jsonl",
  "learning-resources.jsonl",
  "learning-resource-versions.jsonl",
  "learning-evidence.jsonl",
  "learning-resource-links.jsonl",
  "learning-settings.jsonl",
  "learning-jobs.jsonl",
  "learning-job-attempts.jsonl",
  "learning-resource-uses.jsonl"
] as const;
const jsonlFiles = [...coreJsonlFiles, ...learningJsonlFiles] as const;
const credentialFilePath = /(?:^|\/)(?:\.env(?:\..*)?|[^/]*(?:credential|secret|token|private[_-]?key|id_rsa)[^/]*|[^/]+\.(?:pem|key|p12|pfx))$/i;
const credentialText = /-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----|(?:^|[\n{,])\s*["']?(?:password|passphrase|secret|client[_-]?secret|oauth[_-]?client[_-]?secret|private[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|credential|api[_-]?key)["']?\s*[:=]|(?:^|[^A-Za-z0-9])(?:sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[A-Z0-9]{16})(?:$|[^A-Za-z0-9])/i;
const credentialFieldNames = new Set([
  "password", "passphrase", "secret", "clientsecret", "oauthclientsecret", "privatekey", "secretkey",
  "accesstoken", "refreshtoken", "oauthaccesstoken", "oauthrefreshtoken", "authorization", "cookie",
  "credential", "apikey", "apitoken", "bearertoken", "token"
]);
const transportFormat = "samurai-workspace-bundle-v3";
export const WORKSPACE_BUNDLE_MAX_BYTES = 24 * 1024 * 1024;
export const WORKSPACE_BUNDLE_MAX_ENTRY_BYTES = 8 * 1024 * 1024;
export const WORKSPACE_BUNDLE_MAX_ENTRIES = 100_000;
export const WORKSPACE_BUNDLE_MAX_RECORDS_PER_FILE = 100_000;
export const WORKSPACE_BUNDLE_INCOMING_TTL_MS = 60 * 60 * 1000;
// One Server process owns one transfer export at a time. The database still
// validates the final transition, while this avoids two local file writers
// racing over the same private bundle directory.
const transferExportLocks = new Map<string, Promise<void>>();
const bundleStagingLocks = new Map<string, Promise<void>>();

/**
 * A transfer row is retained for auditability across retries. Its monotonic
 * version is therefore the attempt discriminator for the physical Bundle
 * ledger; the first attempt keeps the historical `bundle_<transferId>` ID.
 */
export function workspaceTransferBundleId(transferId: string, version?: number): string {
  const attempt = typeof version === "number" && Number.isSafeInteger(version) && version > 1 ? version : 1;
  return attempt === 1 ? `bundle_${transferId}` : `bundle_${transferId}_attempt_${attempt}`;
}

export function workspaceTransferRetryDestination(destination: string, version?: number): string {
  const attempt = typeof version === "number" && Number.isSafeInteger(version) && version > 1 ? version : 1;
  return attempt === 1 ? path.resolve(destination) : `${path.resolve(destination)}.attempt-${attempt}`;
}

function safeErrorCode(error: unknown): string {
  if (error instanceof WorkspaceServerError) return error.code;
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && /^[A-Za-z0-9_.:-]+$/.test(code)) return code;
  }
  return "workspace_server_internal_error";
}

const portableSchema: Readonly<Record<string, { required: readonly string[]; allowed: readonly string[] }>> = {
  [workspaceFile]: {
    required: ["id", "name", "hosting_mode", "database_placement", "storage_namespace", "created_by", "version", "created_at", "updated_at"],
    // organization_id was emitted by older Organization-aware exports. It is
    // accepted for backwards compatibility, but new exports omit it from the
    // portable Workspace row and keep provenance only in the manifest.
    allowed: ["id", "name", "organization_id", "hosting_mode", "database_placement", "storage_namespace", "created_by", "version", "created_at", "updated_at"]
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
    // Public Event columns were added after the first V3 bundles. Keep them
    // optional on input so old bundles remain importable; new exports always
    // include the complete public Event projection.
    allowed: ["source_event_id", "workspace_id", "room_id", "kind", "record_type", "record_id", "operation_id", "payload", "created_at", "event_id", "event_version", "actor_kind", "actor_id", "organization_id", "cursor", "correlation_id", "resources"]
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
  },
  "learning-activities.jsonl": {
    required: ["workspace_id", "room_id", "id", "group_key", "principal_account_id", "source_kind", "source_id", "correction_of_activity_id", "instruction_summary", "result_summary", "outcome", "verification_state", "failure_state", "explicit_remember", "payload", "created_at", "finalized_at"],
    allowed: ["workspace_id", "room_id", "id", "group_key", "principal_account_id", "source_kind", "source_id", "correction_of_activity_id", "instruction_summary", "result_summary", "outcome", "verification_state", "failure_state", "explicit_remember", "payload", "created_at", "finalized_at"]
  },
  "learning-resources.jsonl": {
    required: ["workspace_id", "id", "scope_kind", "room_id", "resource_kind", "state", "is_absolute_rule", "ai_update_locked", "title", "content", "payload", "version", "created_by", "updated_by", "archived_at", "created_at", "updated_at"],
    allowed: ["workspace_id", "id", "scope_kind", "room_id", "resource_kind", "state", "is_absolute_rule", "ai_update_locked", "confidence", "source_job_id", "source_attempt_id", "title", "content", "payload", "version", "created_by", "updated_by", "archived_at", "created_at", "updated_at"]
  },
  "learning-resource-versions.jsonl": {
    required: ["workspace_id", "id", "resource_id", "version", "change_kind", "scope_kind", "room_id", "state", "ai_update_locked", "title", "content", "payload", "content_hash", "reason", "actor_account_id", "created_at"],
    allowed: ["workspace_id", "id", "resource_id", "version", "change_kind", "scope_kind", "room_id", "state", "ai_update_locked", "confidence", "source_job_id", "source_attempt_id", "title", "content", "payload", "content_hash", "reason", "actor_account_id", "created_at"]
  },
  "learning-evidence.jsonl": {
    required: ["workspace_id", "id", "resource_id", "resource_version", "activity_id", "kind", "summary", "created_at"],
    allowed: ["workspace_id", "id", "resource_id", "resource_version", "activity_id", "kind", "summary", "created_at"]
  },
  "learning-resource-links.jsonl": {
    required: ["workspace_id", "id", "from_resource_id", "to_resource_id", "relation", "created_at"],
    allowed: ["workspace_id", "id", "from_resource_id", "to_resource_id", "relation", "created_at"]
  },
  "learning-settings.jsonl": {
    // SecretRef is intentionally not portable. The target operator chooses a
    // local engine secret after restore.
    required: ["workspace_id", "id", "scope_kind", "room_id", "enabled", "engine_id", "model", "currency_limit", "token_limit", "currency_used", "tokens_used", "version", "updated_by", "updated_at"],
    allowed: ["workspace_id", "id", "scope_kind", "room_id", "enabled", "engine_id", "model", "currency_limit", "token_limit", "currency_used", "tokens_used", "currency_reserved", "tokens_reserved", "version", "updated_by", "updated_at"]
  },
  "learning-jobs.jsonl": {
    required: ["workspace_id", "room_id", "id", "kind", "status", "priority", "group_key", "high_watermark_activity_id", "next_run_at", "attempt_count", "max_attempts", "lease_owner", "lease_expires_at", "heartbeat_at", "blocked_reason", "engine_id", "model", "created_by", "updated_by", "created_at", "updated_at", "completed_at"],
    allowed: ["workspace_id", "room_id", "id", "kind", "status", "priority", "group_key", "high_watermark_activity_id", "next_run_at", "attempt_count", "max_attempts", "lease_owner", "lease_expires_at", "heartbeat_at", "blocked_reason", "engine_id", "model", "created_by", "updated_by", "created_at", "updated_at", "completed_at"]
  },
  "learning-job-attempts.jsonl": {
    required: ["workspace_id", "id", "job_id", "attempt_no", "worker_id", "engine_id", "model", "status", "input_hash", "output_hash", "output", "error_code", "currency_used", "tokens_used", "started_at", "completed_at"],
    allowed: ["workspace_id", "id", "job_id", "attempt_no", "worker_id", "engine_id", "model", "status", "input_hash", "output_hash", "output", "error_code", "currency_used", "tokens_used", "reserved_currency", "reserved_tokens", "started_at", "completed_at"]
  },
  "learning-resource-uses.jsonl": {
    required: ["workspace_id", "id", "resource_id", "resource_version", "activity_id", "outcome", "summary", "created_at"],
    allowed: ["workspace_id", "id", "resource_id", "resource_version", "activity_id", "outcome", "supersedes_use_id", "summary", "created_at"]
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

/** A v4 Bundle embeds this portable data without creating a separate public
 * v3 ledger row. Filtering happens while the snapshot is projected, before
 * hashes are calculated; callers must never rewrite a completed manifest. */
export interface WritePortableWorkspaceBundleSnapshotInput {
  destination: string;
  includeLegacyLearning?: boolean;
  excludeMembershipAccountIds?: readonly string[];
  transferId?: string;
}

export interface ImportWorkspaceBundleInput {
  sourceDirectory: string;
  targetWorkspaceId: string;
  targetWorkspaceName?: string;
  /** Optional explicit target Organization; omission restores standalone and
   * never infers one from a deployment-wide Self-host setting. */
  targetOrganizationId?: string;
  /** A newer Bundle format can add rows while the v3 target is still
   * read-only and its short-lived import capability is active.  The callback
   * runs only after the verified v3 snapshot is present, and before the
   * Workspace becomes active; a failure takes the normal abort path. */
  beforeActivate?: (context: WorkspaceRequestContext & { importId: string }) => Promise<void>;
}

export interface StageWorkspaceBundleInput {
  targetWorkspaceId: string;
  targetWorkspaceName?: string;
  targetOrganizationId?: string;
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

  async writePortableSnapshot(
    context: WorkspaceRequestContext,
    input: WritePortableWorkspaceBundleSnapshotInput
  ): Promise<{ directory: string; manifest: WorkspaceBundleV3Manifest }> {
    await assertWorkspaceOwner(this.store, context);
    const destination = path.resolve(input.destination);
    if (await pathExists(destination)) throw new WorkspaceServerError("workspace_bundle_destination_exists", 409);
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await mkdir(destination, { recursive: false, mode: 0o700 });
    try {
      const written = await this.writeStableBundleDirectory(context, destination, input.transferId, {
        includeLegacyLearning: input.includeLegacyLearning !== false,
        excludeMembershipAccountIds: input.excludeMembershipAccountIds ?? []
      });
      return { directory: destination, manifest: written.manifest };
    } catch (error) {
      await rm(destination, { recursive: true, force: true }).catch(() => undefined);
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
    const requestedDestination = path.resolve(destination);
    // Capture the previous physical path before the resume function clears the
    // current attempt's ledger fields. If that path still exists, a retry must
    // never reinterpret it as the new Bundle; use a sibling attempt directory.
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
        details: { destination: "portable_bundle" }
      });
      return { transferId };
    });
    // A second request with the same operation ID must resume the same
    // transfer. Do not run another state-changing operation ledger entry.
    if (begun.transferId !== transferId) throw new WorkspaceServerError("workspace_transfer_not_ready", 409);
    return runExclusiveWorkspaceTransferExport(canonicalJson([context.workspaceId, transferId]), async () => {
      const transfer = await readWorkspaceTransfer(this.store, context, transferId);
      if (transfer.state === "exported" && transfer.bundlePath) {
        const verified = await verifyWorkspaceBundleV3(transfer.bundlePath);
        return { id: workspaceTransferBundleId(transferId, transfer.version), directory: transfer.bundlePath, manifest: verified.manifest, transferId };
      }
      if (transfer.state === "failed" || transfer.state === "rolled_back") throw new WorkspaceServerError("workspace_transfer_not_ready", 409);
      const exportDestination = retryingTerminalTransfer && (previousTransfer?.bundlePath || await pathExists(requestedDestination))
        ? workspaceTransferRetryDestination(requestedDestination, transfer.version)
        : requestedDestination;
      const bundleId = workspaceTransferBundleId(transferId, transfer.version);
      try {
        // Export is part of the original transfer operation. It deliberately
        // does not open a nested idempotency ledger using the same ID.
        const exported = await this.exportPreparedTransfer(context, { destination: exportDestination, transferId, bundleId });
        return { ...exported, transferId };
      } catch (error) {
        // If another process completed the durable DB transition while this
        // process was racing for the destination directory, prefer that
        // verified result instead of incorrectly failing the transfer.
        const resumed = await readWorkspaceTransfer(this.store, context, transferId).catch(() => undefined);
        if (resumed?.state === "exported" && resumed.bundlePath) {
          const verified = await verifyWorkspaceBundleV3(resumed.bundlePath);
          return { id: workspaceTransferBundleId(transferId, resumed.version), directory: resumed.bundlePath, manifest: verified.manifest, transferId };
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
    input: ExportWorkspaceBundleInput & { transferId: string; bundleId?: string }
  ): Promise<ExportWorkspaceBundleResult> {
    const bundleId = input.bundleId ?? workspaceTransferBundleId(input.transferId);
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
    await this.store.runTransferIdempotent(context, { action: "workspace.transfer.rollback", input: { transferId } }, async (sql) => {
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
    await this.store.runTransferIdempotent(context, { action: "workspace.transfer.complete", input: { transferId } }, async (sql) => {
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
  ): Promise<{ directory: string; manifest: WorkspaceBundleV3Manifest }> {
    assertOpaqueId(transferId, "workspace_transfer_id_invalid");
    await assertWorkspaceOwner(this.store, context);
    const transfer = await readWorkspaceTransfer(this.store, context, transferId);
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
    const targetOrganizationId = optionalWorkspaceBundleTargetOrganizationId(input.targetOrganizationId);
    assertBundleManifestCandidate(input.manifest);
    const createdAt = new Date();
    const manifestText = canonicalJson(input.manifest);
    assertBundleManifestSize(manifestText, "workspace_bundle_v3_transport_too_large");
    const root = this.incomingRoot(context.accountId, context.operationId);
    const metadata: IncomingBundleMetadata = {
      format_version: 1,
      account_id: context.accountId,
      operation_id: context.operationId,
      target_workspace_id: input.targetWorkspaceId,
      ...(input.targetWorkspaceName?.trim() ? { target_workspace_name: input.targetWorkspaceName.trim().slice(0, 500) } : {}),
      ...(targetOrganizationId ? { target_organization_id: targetOrganizationId } : {}),
      manifest: input.manifest,
      created_at: createdAt.toISOString(),
      expires_at: new Date(createdAt.getTime() + WORKSPACE_BUNDLE_INCOMING_TTL_MS).toISOString(),
      received_bytes: Buffer.byteLength(manifestText),
      received_entries: 0
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
      await writeFile(path.join(root, manifestFile), manifestText, { flag: "wx", mode: 0o600 });
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
    return runExclusiveWorkspaceBundleStaging(canonicalJson([context.accountId, context.operationId]), async () => {
      const metadata = await this.readIncomingMetadata(context);
      if (metadata.completed) throw new WorkspaceServerError("workspace_import_staging_completed", 409);
      assertSafeRelativePath(entryPath);
      const expectedHash = metadata.manifest.files[entryPath];
      if (!expectedHash) throw new WorkspaceServerError("workspace_bundle_v3_entry_not_found", 404);
      if (content.byteLength > WORKSPACE_BUNDLE_MAX_ENTRY_BYTES) throw new WorkspaceServerError("workspace_bundle_v3_entry_too_large", 413);
      if (hashBytes(content) !== expectedHash) throw new WorkspaceServerError("workspace_bundle_v3_hash_mismatch", 400);
      const root = this.incomingRoot(context.accountId, context.operationId);
      const destination = resolveBundlePath(root, entryPath);
      if (await pathExists(destination)) {
        const existing = await readFile(destination);
        if (hashBytes(existing) !== expectedHash) throw new WorkspaceServerError("workspace_import_staging_conflict", 409);
        return;
      }
      const usage = await measureBundleUsage(root);
      if (usage.entries >= WORKSPACE_BUNDLE_MAX_ENTRIES || usage.bytes + content.byteLength > WORKSPACE_BUNDLE_MAX_BYTES) {
        throw new WorkspaceServerError("workspace_bundle_v3_transport_too_large", 413);
      }
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      let wrote = false;
      try {
        await writeFile(destination, content, { flag: "wx", mode: 0o600 });
        wrote = true;
        const nextUsage = await measureBundleUsage(root);
        assertBundleUsage(nextUsage, "workspace_bundle_v3_transport_too_large");
        await this.writeIncomingMetadata(context, {
          ...metadata,
          received_bytes: nextUsage.bytes,
          received_entries: nextUsage.entries
        }, { overwrite: true });
      } catch (error) {
        if (wrote) await rm(destination, { force: true }).catch(() => undefined);
        throw error;
      }
    });
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
        targetOrganizationId: metadata.target_organization_id,
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
    const targetOrganizationId = optionalWorkspaceBundleTargetOrganizationId(input.targetOrganizationId);
    // Check the target Organization before reading or creating the target
    // Workspace. The import SQL function repeats this check inside the
    // transaction, but the explicit service check also covers idempotent
    // retries that find an already-created target Workspace.
    if (targetOrganizationId) await assertTargetOrganizationAdmin(this.store, context.accountId, targetOrganizationId);
    const source = await verifyWorkspaceBundleV3(input.sourceDirectory);
    const sourceWorkspace = await readJsonObject(path.join(source.directory, workspaceFile));
    const sourceWorkspaceVersion = Number(sourceWorkspace.version ?? 1);
    if (!Number.isSafeInteger(sourceWorkspaceVersion) || sourceWorkspaceVersion < 1) {
      throw new WorkspaceServerError("workspace_bundle_v3_manifest_invalid", 400);
    }
    const targetContext: WorkspaceRequestContext = { ...context, workspaceId: input.targetWorkspaceId };
    // Restore retries belong to the same operation/transfer.  A random
    // session id made a failed replay look like a new import and could leave
    // an old session/receipt disconnected from the next attempt.  Derive the
    // short-lived SQL capability from the verified Bundle identity instead so
    // every retry uses one durable import id without ever duplicating rows.
    const importId = stableWorkspaceImportId(input.targetWorkspaceId, source.manifest, context.operationId);
    const stagingRoot = path.join(this.store.storageRoot, ".imports", `import_${randomUUID()}`);
    const finalRoot = path.join(this.store.storageRoot, "workspaces", input.targetWorkspaceId);
    const existingWorkspace = await this.store.getWorkspace(targetContext).then(() => true).catch((error) => {
      if (error instanceof WorkspaceServerError && error.code === "workspace_not_found") return false;
      throw error;
    });
    if (existingWorkspace) {
      await assertImportedBundleMatches(this.store, targetContext, source.manifest, targetOrganizationId);
      const recovery = await this.store.database.withContext(targetContext, async (sql) => {
        const workspace = await sql.query<{ state: string }>(
          "SELECT state FROM workspaces WHERE id = $1",
          [input.targetWorkspaceId]
        );
        const session = await sql.query<{ id: string }>(
          `SELECT id FROM workspace_import_sessions
           WHERE workspace_id = $1 AND account_id = $2 AND state = 'writing'
           ORDER BY created_at DESC, id DESC LIMIT 1`,
          [input.targetWorkspaceId, context.accountId]
        );
        return { state: workspace.rows[0]?.state, importId: session.rows[0]?.id };
      });
      if (recovery.state === "active") {
        await assertTargetWorkspaceOrganization(this.store, targetContext, targetOrganizationId);
        await verifyImportedWorkspace(this.store, targetContext, source.manifest, source.directory);
        return {
          workspaceId: input.targetWorkspaceId,
          manifest: source.manifest,
          ...(source.manifest.transfer_id ? { receipt: transferReceipt(source.manifest, input.targetWorkspaceId) } : {})
        };
      }
      if (recovery.state !== "read_only" || !recovery.importId) {
        throw new WorkspaceServerError("workspace_import_recovery_required", 409);
      }
      const recoveryContext = { ...targetContext, importId: recovery.importId };
      let recoverySessionOpened = false;
      try {
        await this.store.database.withContext(recoveryContext, async (sql) => {
          await sql.query("SELECT samurai_reopen_workspace_import($1, $2, $3)", [input.targetWorkspaceId, recovery.importId, source.manifest.integrity_hash]);
        });
        recoverySessionOpened = true;
        await verifyImportedWorkspace(this.store, targetContext, source.manifest, source.directory);
        if (input.beforeActivate) await input.beforeActivate(recoveryContext);
        await this.store.database.withContext(recoveryContext, async (sql) => {
          await sql.query("SELECT samurai_complete_workspace_import($1, $2, $3)", [input.targetWorkspaceId, recovery.importId, source.manifest.integrity_hash]);
        });
      } catch (error) {
        // A resumed import owns the target Workspace and its storage root. If
        // verification, an extension finalize, or activation fails after the
        // reopen committed, use the same capability to remove every DB row
        // (including V4 receipts) and then remove the target files.  Keeping
        // this path equivalent to a first-attempt failure makes a retry safe.
        if (!recoverySessionOpened) throw error;
        let abortError: unknown;
        try {
          await this.store.database.withContext(recoveryContext, async (sql) => {
            await sql.query("SELECT samurai_abort_workspace_import($1, $2)", [input.targetWorkspaceId, recovery.importId]);
          });
        } catch (cleanupError) {
          abortError = cleanupError;
        }
        if (abortError) {
          throw new WorkspaceServerError("workspace_import_abort_failed", 500, {
            primary_error_code: safeErrorCode(error),
            cleanup_error_code: safeErrorCode(abortError)
          });
        }
        try {
          await rm(finalRoot, { recursive: true, force: true });
        } catch (cleanupError) {
          throw new WorkspaceServerError("workspace_import_cleanup_failed", 500, {
            primary_error_code: safeErrorCode(error),
            cleanup_error_code: safeErrorCode(cleanupError)
          });
        }
        throw error;
      }
      return {
        workspaceId: input.targetWorkspaceId,
        manifest: source.manifest,
        ...(source.manifest.transfer_id ? { receipt: transferReceipt(source.manifest, input.targetWorkspaceId) } : {})
      };
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
        await startWorkspaceImport(sql, {
          targetWorkspaceId: input.targetWorkspaceId,
          workspaceName: input.targetWorkspaceName?.trim() || "Imported Workspace",
          mode: this.store.mode,
          databasePlacement: this.store.mode === "self_host" ? "dedicated" : "shared",
          importId,
          sourceWorkspaceVersion,
          ...(targetOrganizationId ? { targetOrganizationId } : {})
        });
        await importSnapshot(sql, {
          sourceDirectory: source.directory,
          targetWorkspaceId: input.targetWorkspaceId,
          targetWorkspaceName: input.targetWorkspaceName,
          ownerAccountId: context.accountId,
          mode: this.store.mode,
          ...(targetOrganizationId ? { targetOrganizationId } : {})
        });
        await sql.query("SELECT samurai_record_import_bundle($1, $2, $3, $4, $5::JSONB)", [
          input.targetWorkspaceId,
          importId,
          `portable://bundle-v3/${source.manifest.integrity_hash}`,
          source.manifest.integrity_hash,
          canonicalJson(source.manifest.record_counts)
        ]);
      });
      // The import transaction committed; later verification/completion may
      // fail and must use the guarded database abort path.
      importSessionStarted = true;
      if (input.beforeActivate) await input.beforeActivate({ ...targetContext, importId });
      await verifyImportedWorkspace(this.store, targetContext, source.manifest, source.directory);
      await this.store.database.withContext({ ...targetContext, importId }, async (sql) => {
        await sql.query("SELECT samurai_complete_workspace_import($1, $2, $3)", [input.targetWorkspaceId, importId, source.manifest.integrity_hash]);
        await this.store.insertAudit(sql, targetContext, {
          action: "workspace.bundle.import",
          subjectKind: "workspace_bundle",
          subjectId: source.manifest.integrity_hash,
          details: {
            source_workspace_id: source.manifest.workspace_id,
            ...(source.manifest.transfer_id ? { transfer_id: source.manifest.transfer_id } : {})
          }
        });
      });
      return {
        workspaceId: input.targetWorkspaceId,
        manifest: source.manifest,
        ...(source.manifest.transfer_id ? { receipt: transferReceipt(source.manifest, input.targetWorkspaceId) } : {})
      };
    } catch (error) {
      let abortFailed = false;
      let abortError: unknown;
      if (importSessionStarted) {
        try {
          await this.store.database.withContext({ ...targetContext, importId }, async (sql) => {
            await sql.query("SELECT samurai_abort_workspace_import($1, $2)", [input.targetWorkspaceId, importId]);
          });
        } catch (cleanupError) {
          abortFailed = true;
          abortError = cleanupError;
        }
      }
      // Do not remove the files if database cleanup failed: keeping them is
      // the only recoverable evidence for a partially imported Workspace.
      let fileCleanupError: unknown;
      if (!abortFailed && finalRootCreated) {
        try {
          await rm(finalRoot, { recursive: true, force: true });
        } catch (cleanupError) {
          fileCleanupError = cleanupError;
        }
      }
      if (abortFailed) {
        throw new WorkspaceServerError("workspace_import_abort_failed", 500, {
          primary_error_code: safeErrorCode(error),
          cleanup_error_code: safeErrorCode(abortError)
        });
      }
      if (fileCleanupError) {
        throw new WorkspaceServerError("workspace_import_cleanup_failed", 500, {
          primary_error_code: safeErrorCode(error),
          cleanup_error_code: safeErrorCode(fileCleanupError)
        });
      }
      throw error;
    } finally {
      await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async readSnapshot(
    context: WorkspaceRequestContext,
    options: { includeLegacyLearning?: boolean; excludeMembershipAccountIds?: readonly string[] } = {}
  ): Promise<WorkspaceSnapshot> {
    return this.store.database.withReadSnapshot(context, async (sql) => {
      const workspace = await sql.query<Record<string, unknown>>("SELECT id, name, organization_id, hosting_mode, database_placement, storage_namespace, created_by, version, created_at, updated_at FROM workspaces WHERE id = $1", [context.workspaceId]);
      // Keep the migration level in the manifest so a restore can be
      // diagnosed against the source schema.  Older test fixtures/databases
      // may not expose this table; the historical V3 value remains a safe
      // compatibility fallback until the dedicated migration is applied.
      const schema = await sql.query<{ revision: number | string | null }>(
        "SELECT MAX(version)::TEXT AS revision FROM samurai_server_schema_migrations"
      );
      const accounts = await sql.query<Record<string, unknown>>("SELECT id, public_key, display_name, status, created_at, updated_at FROM samurai_list_workspace_account_identities($1) ORDER BY id", [context.workspaceId]);
      const rooms = await sql.query<Record<string, unknown>>("SELECT workspace_id, id, parent_room_id, name, version, created_by, created_at, updated_at FROM rooms WHERE workspace_id = $1 ORDER BY id", [context.workspaceId]);
      const memberships = await sql.query<Record<string, unknown>>("SELECT workspace_id, account_id, role, state, version, created_at, updated_at, revoked_at FROM workspace_members WHERE workspace_id = $1 ORDER BY account_id", [context.workspaceId]);
      const roomMemberships = await sql.query<Record<string, unknown>>("SELECT workspace_id, room_id, account_id, role, state, version, created_at, updated_at, revoked_at FROM room_members WHERE workspace_id = $1 ORDER BY room_id, account_id", [context.workspaceId]);
      const records = await sql.query<Record<string, unknown>>("SELECT workspace_id, room_id, record_type, id, version, payload, search_text, content_hash, created_by, updated_by, created_at, updated_at FROM workspace_records WHERE workspace_id = $1 ORDER BY record_type, id", [context.workspaceId]);
      const events = await sql.query<Record<string, unknown>>("SELECT id AS source_event_id, workspace_id, room_id, kind, record_type, record_id, operation_id, payload, created_at, event_id, event_version, actor_kind, actor_id, organization_id, cursor, correlation_id, resources FROM workspace_events WHERE workspace_id = $1 ORDER BY id", [context.workspaceId]);
      const jobs = await sql.query<Record<string, unknown>>("SELECT workspace_id, room_id, id, kind, status, version, idempotency_key, payload, created_by, updated_by, created_at, updated_at FROM workspace_jobs WHERE workspace_id = $1 ORDER BY id", [context.workspaceId]);
      // Idempotency results may contain a one-time invite token. The ledger is
      // intentionally not portable; immutable events/audits preserve history.
      const operations = { rows: [] as Record<string, unknown>[] };
      const invitations = await sql.query<Record<string, unknown>>("SELECT workspace_id, id, room_id, workspace_role, room_role, created_by, expires_at, revoked_at, accepted_by, accepted_at, version, created_at FROM workspace_invitations WHERE workspace_id = $1 ORDER BY id", [context.workspaceId]);
      const audits = await sql.query<Record<string, unknown>>("SELECT id AS source_audit_id, workspace_id, room_id, actor_account_id, action, outcome, operation_id, subject_kind, subject_id, before_version, after_version, details, created_at FROM workspace_audit_entries WHERE workspace_id = $1 ORDER BY id", [context.workspaceId]);
      const files = await sql.query<Record<string, unknown>>("SELECT workspace_id, room_id, path, version, sha256, size, created_by, updated_by, created_at, updated_at FROM workspace_files WHERE workspace_id = $1 ORDER BY path", [context.workspaceId]);
      const learningActivities = await sql.query<Record<string, unknown>>("SELECT workspace_id, room_id, id, group_key, principal_account_id, source_kind, source_id, correction_of_activity_id, instruction_summary, result_summary, outcome, verification_state, failure_state, explicit_remember, payload, created_at, finalized_at FROM workspace_learning_activities WHERE workspace_id = $1 ORDER BY finalized_at, id", [context.workspaceId]);
      const learningResources = await sql.query<Record<string, unknown>>("SELECT workspace_id, id, scope_kind, room_id, resource_kind, state, is_absolute_rule, ai_update_locked, confidence, source_job_id, source_attempt_id, title, content, payload, version, created_by, updated_by, archived_at, created_at, updated_at FROM workspace_learning_resources WHERE workspace_id = $1 ORDER BY id", [context.workspaceId]);
      const learningResourceVersions = await sql.query<Record<string, unknown>>("SELECT workspace_id, id, resource_id, version, change_kind, scope_kind, room_id, state, ai_update_locked, confidence, source_job_id, source_attempt_id, title, content, payload, content_hash, reason, actor_account_id, created_at FROM workspace_learning_resource_versions WHERE workspace_id = $1 ORDER BY resource_id, version", [context.workspaceId]);
      const learningEvidence = await sql.query<Record<string, unknown>>("SELECT workspace_id, id, resource_id, resource_version, activity_id, kind, summary, created_at FROM workspace_learning_evidence WHERE workspace_id = $1 ORDER BY id", [context.workspaceId]);
      const learningResourceLinks = await sql.query<Record<string, unknown>>("SELECT workspace_id, id, from_resource_id, to_resource_id, relation, created_at FROM workspace_learning_resource_links WHERE workspace_id = $1 ORDER BY id", [context.workspaceId]);
      // SecretRef is deliberately omitted from portable data.
      const learningSettings = await sql.query<Record<string, unknown>>("SELECT workspace_id, id, scope_kind, room_id, enabled, engine_id, model, currency_limit, token_limit, currency_used, tokens_used, currency_reserved, tokens_reserved, version, updated_by, updated_at FROM workspace_learning_settings WHERE workspace_id = $1 ORDER BY id", [context.workspaceId]);
      const learningJobs = await sql.query<Record<string, unknown>>("SELECT workspace_id, room_id, id, kind, status, priority, group_key, high_watermark_activity_id, next_run_at, attempt_count, max_attempts, lease_owner, lease_expires_at, heartbeat_at, blocked_reason, engine_id, model, created_by, updated_by, created_at, updated_at, completed_at FROM workspace_learning_jobs WHERE workspace_id = $1 ORDER BY id", [context.workspaceId]);
      const learningJobAttempts = await sql.query<Record<string, unknown>>("SELECT workspace_id, id, job_id, attempt_no, worker_id, engine_id, model, status, input_hash, output_hash, output, error_code, currency_used, tokens_used, reserved_currency, reserved_tokens, started_at, completed_at FROM workspace_learning_job_attempts WHERE workspace_id = $1 ORDER BY job_id, attempt_no", [context.workspaceId]);
      const learningResourceUses = await sql.query<Record<string, unknown>>("SELECT workspace_id, id, resource_id, resource_version, activity_id, outcome, supersedes_use_id, summary, created_at FROM workspace_learning_resource_uses WHERE workspace_id = $1 ORDER BY id", [context.workspaceId]);
      const workspaceRow = workspace.rows[0];
      if (!workspaceRow) throw new WorkspaceServerError("workspace_not_found", 404);
      const excludedMemberships = new Set(options.excludeMembershipAccountIds ?? []);
      const includeLegacyLearning = options.includeLegacyLearning !== false;
      return {
        workspace: workspaceRow,
        schemaRevision: normalizeSchemaRevision(schema.rows[0]?.revision),
        accounts: accounts.rows,
        rooms: rooms.rows,
        memberships: memberships.rows.filter((row) => !excludedMemberships.has(String(row.account_id ?? ""))),
        roomMemberships: roomMemberships.rows.filter((row) => !excludedMemberships.has(String(row.account_id ?? ""))),
        records: records.rows,
        events: events.rows,
        jobs: jobs.rows,
        operations: operations.rows,
        invitations: invitations.rows,
        audits: audits.rows,
        files: files.rows,
        learningActivities: includeLegacyLearning ? learningActivities.rows : [],
        learningResources: includeLegacyLearning ? learningResources.rows : [],
        learningResourceVersions: includeLegacyLearning ? learningResourceVersions.rows : [],
        learningEvidence: includeLegacyLearning ? learningEvidence.rows : [],
        learningResourceLinks: includeLegacyLearning ? learningResourceLinks.rows : [],
        learningSettings: includeLegacyLearning ? learningSettings.rows : [],
        learningJobs: includeLegacyLearning ? learningJobs.rows : [],
        learningJobAttempts: includeLegacyLearning ? learningJobAttempts.rows : [],
        learningResourceUses: includeLegacyLearning ? learningResourceUses.rows : []
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
    transferId?: string,
    projection: { includeLegacyLearning?: boolean; excludeMembershipAccountIds?: readonly string[] } = {}
  ): Promise<{ manifest: WorkspaceBundleV3Manifest }> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const snapshot = await this.readSnapshot(context, projection);
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
        const current = await this.readSnapshot(context, projection);
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
    if (metadata.created_at !== undefined && !isValidTimestamp(metadata.created_at)) {
      throw new WorkspaceServerError("workspace_import_staging_invalid", 400);
    }
    if (metadata.expires_at !== undefined && !isValidTimestamp(metadata.expires_at)) {
      throw new WorkspaceServerError("workspace_import_staging_invalid", 400);
    }
    if (metadata.received_bytes !== undefined
      && (!Number.isSafeInteger(metadata.received_bytes) || metadata.received_bytes < 0 || metadata.received_bytes > WORKSPACE_BUNDLE_MAX_BYTES)) {
      throw new WorkspaceServerError("workspace_import_staging_invalid", 400);
    }
    if (metadata.received_entries !== undefined
      && (!Number.isSafeInteger(metadata.received_entries) || metadata.received_entries < 0 || metadata.received_entries > WORKSPACE_BUNDLE_MAX_ENTRIES)) {
      throw new WorkspaceServerError("workspace_import_staging_invalid", 400);
    }
    if (metadata.completed !== undefined) assertIncomingCompletion(metadata.completed, metadata.target_workspace_id, metadata.manifest);
    const normalized = metadata as IncomingBundleMetadata;
    if (!normalized.completed && await incomingBundleExpired(this.incomingMetadataPath(context.accountId, context.operationId), normalized)) {
      await this.clearIncomingBundle(context);
      throw new WorkspaceServerError("workspace_import_staging_expired", 410);
    }
    return normalized;
  }

  private async clearIncomingBundle(context: Pick<WorkspaceRequestContext, "accountId" | "operationId">): Promise<void> {
    await Promise.all([
      rm(this.incomingRoot(context.accountId, context.operationId), { recursive: true, force: true }),
      rm(this.incomingMetadataPath(context.accountId, context.operationId), { force: true })
    ]);
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
  /** Required for new staged imports; optional while reading old metadata. */
  target_organization_id?: string;
  manifest: WorkspaceBundleV3Manifest;
  created_at?: string;
  expires_at?: string;
  received_bytes?: number;
  received_entries?: number;
  completed?: IncomingBundleCompletion;
}

interface IncomingBundleCompletion {
  workspace_id: string;
  manifest: WorkspaceBundleV3Manifest;
  receipt?: WorkspaceTransferReceipt;
  completed_at: string;
}

function incomingMetadataRequest(metadata: Pick<IncomingBundleMetadata, "format_version" | "account_id" | "operation_id" | "target_workspace_id" | "target_workspace_name" | "target_organization_id" | "manifest">): Record<string, unknown> {
  return {
    format_version: metadata.format_version,
    account_id: metadata.account_id,
    operation_id: metadata.operation_id,
    target_workspace_id: metadata.target_workspace_id,
    ...(metadata.target_workspace_name ? { target_workspace_name: metadata.target_workspace_name } : {}),
    ...(metadata.target_organization_id ? { target_organization_id: metadata.target_organization_id } : {}),
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
  manifest: WorkspaceBundleV3Manifest,
  targetOrganizationId?: string
): Promise<void> {
  const result = await store.database.withContext(context, async (sql) => {
    const bundle = await sql.query<{ sha256: string }>(
      "SELECT sha256 FROM workspace_bundles WHERE workspace_id = $1 AND sha256 = $2",
      [context.workspaceId, manifest.integrity_hash]
    );
    if (!bundle.rows[0]) return { bundle: false, organizationId: undefined };
    const workspace = await sql.query<{ organization_id: string | null }>(
      "SELECT organization_id FROM workspaces WHERE id = $1",
      [context.workspaceId]
    );
    return { bundle: true, organizationId: workspace.rows[0]?.organization_id ?? undefined };
  });
  if (!result.bundle) throw new WorkspaceServerError("workspace_import_target_exists", 409);
  if (result.organizationId !== targetOrganizationId
    && (result.organizationId !== undefined || targetOrganizationId !== undefined)) {
    throw new WorkspaceServerError("workspace_import_target_organization_mismatch", 409);
  }
}

async function assertTargetWorkspaceOrganization(
  store: WorkspaceServerStore,
  context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">,
  targetOrganizationId?: string
): Promise<void> {
  const result = await store.database.withContext(context, async (sql) => sql.query<{ organization_id: string | null }>(
    "SELECT organization_id FROM workspaces WHERE id = $1",
    [context.workspaceId]
  ));
  const organizationId = result.rows[0]?.organization_id;
  const normalizedOrganizationId = organizationId ?? undefined;
  if (normalizedOrganizationId !== targetOrganizationId
    && (normalizedOrganizationId !== undefined || targetOrganizationId !== undefined)) {
    throw new WorkspaceServerError("workspace_import_target_organization_mismatch", 409);
  }
}

async function assertTargetOrganizationAdmin(
  store: WorkspaceServerStore,
  accountId: string,
  targetOrganizationId: string
): Promise<void> {
  const result = await store.database.withContext({ accountId }, async (sql) => sql.query<{ allowed: boolean }>(
    "SELECT samurai_can_organization($1, 'admin') AS allowed",
    [targetOrganizationId]
  ));
  if (result.rows[0]?.allowed !== true) {
    throw new WorkspaceServerError("organization_admin_permission_required", 403);
  }
}

export async function runExclusiveWorkspaceTransferExport<T>(key: string, action: () => Promise<T>): Promise<T> {
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

export async function runExclusiveWorkspaceBundleStaging<T>(key: string, action: () => Promise<T>): Promise<T> {
  const previous = bundleStagingLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const completion = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.catch(() => undefined).then(() => completion);
  bundleStagingLocks.set(key, queued);
  await previous.catch(() => undefined);
  try {
    return await action();
  } finally {
    release();
    if (bundleStagingLocks.get(key) === queued) bundleStagingLocks.delete(key);
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
  return hashText(canonicalBundleJson(snapshot));
}

function normalizeSchemaRevision(value: unknown): number {
  const revision = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isSafeInteger(revision) && revision > 0 ? revision : legacyBundleSchemaRevision;
}

function optionalOpaqueId(value: unknown, code: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new WorkspaceServerError(code, 400);
  return assertOpaqueId(value, code);
}

function sourceManifestOrganizationId(manifest: WorkspaceBundleV3Manifest): string | undefined {
  const candidate = manifest as WorkspaceBundleV3ManifestWithProvenance;
  const nested = optionalOpaqueId(candidate.source?.organization_id, "organization_id_invalid");
  const topLevel = optionalOpaqueId(candidate.source_organization_id, "organization_id_invalid");
  if (nested && topLevel && nested !== topLevel) {
    throw new WorkspaceServerError("workspace_bundle_v3_manifest_invalid", 400);
  }
  return topLevel ?? nested;
}

function bundleV3IntegrityPayload(manifest: WorkspaceBundleV3Manifest): Record<string, unknown> {
  const candidate = manifest as WorkspaceBundleV3ManifestWithProvenance;
  const sourceOrganizationId = sourceManifestOrganizationId(manifest);
  // The first V3 contract hashed only file names/counts. Preserve that exact
  // formula for old bundles; provenance-bearing manifests use a distinct
  // payload so those fields cannot be edited without invalidating the hash.
  if (candidate.schema_revision === undefined && sourceOrganizationId === undefined) {
    return { files: manifest.files, record_counts: manifest.record_counts };
  }
  return {
    files: manifest.files,
    record_counts: manifest.record_counts,
    source: {
      hosting_mode: manifest.source.hosting_mode,
      database_placement: manifest.source.database_placement,
      ...(sourceOrganizationId ? { organization_id: sourceOrganizationId } : {})
    },
    ...(manifest.schema_version !== undefined ? { schema_version: manifest.schema_version } : {}),
    ...(candidate.schema_revision !== undefined ? { schema_revision: candidate.schema_revision } : {}),
    ...(manifest.transfer_id ? { transfer_id: manifest.transfer_id } : {})
  };
}

/** PostgreSQL returns TIMESTAMPTZ columns as Date instances. Bundle JSON must
 * preserve them as ISO strings; canonicalJson alone would see a Date as an
 * object with no enumerable fields and serialize it as {}. */
function canonicalBundleJson(value: unknown): string {
  return canonicalJson(normalizeBundleJson(value));
}

function normalizeBundleJson(value: unknown): unknown {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw new WorkspaceServerError("workspace_bundle_v3_snapshot_value_invalid", 500);
    return value.toISOString();
  }
  if (Array.isArray(value)) return value.map(normalizeBundleJson);
  if (value && typeof value === "object") {
    const normalized: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      normalized[key] = normalizeBundleJson(nested);
    }
    return normalized;
  }
  return value;
}

export async function readWorkspaceTransfer(
  store: WorkspaceServerStore,
  context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">,
  transferId: string
): Promise<{ state: string; bundlePath?: string; version?: number }> {
  return store.database.withContext(context, async (sql) => {
    const result = await sql.query<{ state: string; bundle_path: string | null; version: number | string | null }>(
      "SELECT state, bundle_path, version FROM workspace_transfers WHERE workspace_id = $1 AND id = $2",
      [context.workspaceId, transferId]
    );
    const row = result.rows[0];
    if (!row) throw new WorkspaceServerError("workspace_transfer_not_found", 404);
    const version = typeof row.version === "number" ? row.version : typeof row.version === "string" ? Number(row.version) : undefined;
    return {
      state: row.state,
      ...(row.bundle_path ? { bundlePath: row.bundle_path } : {}),
      ...(version !== undefined && Number.isSafeInteger(version) && version > 0 ? { version } : {})
    };
  });
}

interface WorkspaceSnapshot {
  workspace: Record<string, unknown>;
  schemaRevision: number;
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
  learningActivities: Record<string, unknown>[];
  learningResources: Record<string, unknown>[];
  learningResourceVersions: Record<string, unknown>[];
  learningEvidence: Record<string, unknown>[];
  learningResourceLinks: Record<string, unknown>[];
  learningSettings: Record<string, unknown>[];
  learningJobs: Record<string, unknown>[];
  learningJobAttempts: Record<string, unknown>[];
  learningResourceUses: Record<string, unknown>[];
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
  // Organization is not part of the portable Workspace identity. Do not make
  // the restored Workspace inherit source membership or provenance.
  const portableWorkspace = portableWorkspaceRow(input.snapshot.workspace);
  const portableEvents = input.snapshot.events.map(portableEventRow);
  const dataFiles: Array<[string, unknown]> = [
    [workspaceFile, portableWorkspace],
    ["accounts.jsonl", input.snapshot.accounts],
    ["rooms.jsonl", input.snapshot.rooms],
    ["memberships.jsonl", input.snapshot.memberships],
    ["room-memberships.jsonl", input.snapshot.roomMemberships],
    ["records.jsonl", input.snapshot.records],
    ["events.jsonl", portableEvents],
    ["jobs.jsonl", input.snapshot.jobs],
    ["operations.jsonl", input.snapshot.operations],
    ["invitations.jsonl", input.snapshot.invitations],
    ["audits.jsonl", input.snapshot.audits.map(portableAuditRow)],
    ["files.jsonl", input.snapshot.files],
    ["learning-activities.jsonl", input.snapshot.learningActivities],
    ["learning-resources.jsonl", input.snapshot.learningResources],
    ["learning-resource-versions.jsonl", input.snapshot.learningResourceVersions],
    ["learning-evidence.jsonl", input.snapshot.learningEvidence],
    ["learning-resource-links.jsonl", input.snapshot.learningResourceLinks],
    ["learning-settings.jsonl", input.snapshot.learningSettings],
    ["learning-jobs.jsonl", input.snapshot.learningJobs],
    ["learning-job-attempts.jsonl", input.snapshot.learningJobAttempts],
    ["learning-resource-uses.jsonl", input.snapshot.learningResourceUses]
  ];
  for (const [file, payload] of dataFiles) {
    // A portable Bundle never carries Organization affiliation.  Apply the
    // same recursive filter to arbitrary JSON payloads (including Event and
    // audit details), not only to the known top-level columns.
    const portablePayload = stripOrganizationIdentifiers(payload);
    // Validate the generated projection before it becomes part of the
    // Bundle. This keeps server-local absolute paths out of exports as well
    // as rejecting them on a later import/verification pass.
    if (Array.isArray(portablePayload)) {
      for (const row of portablePayload) assertPortablePathsFree(row);
    } else {
      assertPortablePathsFree(portablePayload);
    }
    const contents = Array.isArray(portablePayload)
      ? portablePayload.map((row) => canonicalBundleJson(row)).join("\n") + (portablePayload.length > 0 ? "\n" : "")
      : canonicalBundleJson(portablePayload);
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
    files: input.snapshot.files.length,
    learning_activities: input.snapshot.learningActivities.length,
    learning_resources: input.snapshot.learningResources.length,
    learning_resource_versions: input.snapshot.learningResourceVersions.length,
    learning_evidence: input.snapshot.learningEvidence.length,
    learning_resource_links: input.snapshot.learningResourceLinks.length,
    learning_settings: input.snapshot.learningSettings.length,
    learning_jobs: input.snapshot.learningJobs.length,
    learning_job_attempts: input.snapshot.learningJobAttempts.length,
    learning_resource_uses: input.snapshot.learningResourceUses.length
  };
  const source = input.snapshot.workspace;
  const schemaRevision = input.snapshot.schemaRevision;
  const manifest = {
    format_version: 3,
    workspace_id: input.workspaceId,
    exported_at: new Date().toISOString(),
    source: {
      hosting_mode: String(source.hosting_mode) as WorkspaceServerMode,
      database_placement: String(source.database_placement) as "shared" | "dedicated"
    },
    // `schema_version` is retained for older readers. New readers use the
    // explicit revision field. Source Organization provenance is intentionally
    // omitted: a restore must not reveal or inherit the source affiliation.
    schema_version: schemaRevision,
    schema_revision: schemaRevision,
    ...(input.transferId ? { transfer_id: input.transferId } : {}),
    files: hashes,
    record_counts: recordCounts,
    integrity_hash: ""
  } satisfies WorkspaceBundleV3ManifestWithProvenance;
  manifest.integrity_hash = hashText(canonicalJson(bundleV3IntegrityPayload(manifest)));
  await writeFile(path.join(input.directory, manifestFile), canonicalJson(manifest), { flag: "wx", mode: 0o600 });
  return { manifest };
}

function portableWorkspaceRow(row: Record<string, unknown>): Record<string, unknown> {
  return stripOrganizationIdentifiers(row) as Record<string, unknown>;
}

function portableEventRow(row: Record<string, unknown>): Record<string, unknown> {
  return stripOrganizationIdentifiers(row) as Record<string, unknown>;
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

function portableAuditRow(row: Record<string, unknown>): Record<string, unknown> {
  const portable = stripOrganizationIdentifiers(row) as Record<string, unknown>;
  const subjectKind = typeof portable.subject_kind === "string" ? portable.subject_kind.toLowerCase() : "";
  // An Organization subject ID is itself an affiliation even when the key is
  // not present in the nested details. Keep the historical audit action but
  // remove the identifier before exporting or restoring it.
  if (subjectKind.includes("organization")) return { ...portable, subject_id: null };
  return portable;
}

export async function verifyWorkspaceBundleV3(directory: string): Promise<{ directory: string; manifest: WorkspaceBundleV3Manifest }> {
  const root = path.resolve(directory);
  const manifestRaw = await readFile(path.join(root, manifestFile), "utf8");
  const manifest = JSON.parse(manifestRaw) as WorkspaceBundleV3ManifestWithProvenance;
  if (!manifest || manifest.format_version !== 3 || !manifest.files || !manifest.record_counts) throw new WorkspaceServerError("workspace_bundle_v3_manifest_invalid", 400);
  assertOpaqueId(manifest.workspace_id, "workspace_bundle_workspace_id_invalid");
  if (manifest.source?.hosting_mode !== "hosted" && manifest.source?.hosting_mode !== "self_host") throw new WorkspaceServerError("workspace_bundle_v3_manifest_invalid", 400);
  if (manifest.source?.database_placement !== "shared" && manifest.source?.database_placement !== "dedicated") throw new WorkspaceServerError("workspace_bundle_v3_manifest_invalid", 400);
  if (manifest.schema_version !== undefined && (!Number.isSafeInteger(manifest.schema_version) || manifest.schema_version < 1)) {
    throw new WorkspaceServerError("workspace_bundle_v3_manifest_invalid", 400);
  }
  if (manifest.schema_revision !== undefined && (!Number.isSafeInteger(manifest.schema_revision) || manifest.schema_revision < 1)) {
    throw new WorkspaceServerError("workspace_bundle_v3_manifest_invalid", 400);
  }
  if (manifest.schema_version !== undefined && manifest.schema_revision !== undefined
    && manifest.schema_version !== manifest.schema_revision) {
    throw new WorkspaceServerError("workspace_bundle_v3_manifest_invalid", 400);
  }
  const sourceOrganizationId = sourceManifestOrganizationId(manifest);
  if (manifest.source_organization_id !== undefined && !sourceOrganizationId) {
    throw new WorkspaceServerError("workspace_bundle_v3_manifest_invalid", 400);
  }
  if (manifest.transfer_id !== undefined) assertOpaqueId(manifest.transfer_id, "workspace_transfer_id_invalid");
  if (Object.keys(manifest.files).length > WORKSPACE_BUNDLE_MAX_ENTRIES) throw new WorkspaceServerError("workspace_bundle_v3_manifest_invalid", 413);
  assertBundleUsage(await measureBundleUsage(root), "workspace_bundle_v3_transport_too_large");
  const actual = await hashBundleFiles(root, false);
  if (canonicalJson(actual) !== canonicalJson(manifest.files)) throw new WorkspaceServerError("workspace_bundle_v3_hash_mismatch", 400);
  if (manifest.integrity_hash !== hashText(canonicalJson(bundleV3IntegrityPayload(manifest)))) {
    throw new WorkspaceServerError("workspace_bundle_v3_integrity_hash_mismatch", 400);
  }
  const expected = new Set([workspaceFile, ...coreJsonlFiles]);
  for (const file of Object.keys(actual)) {
    if (file !== workspaceFile && !jsonlFiles.includes(file as (typeof jsonlFiles)[number]) && !file.startsWith("files/")) {
      throw new WorkspaceServerError("workspace_bundle_v3_unexpected_file", 400);
    }
    expected.delete(file);
  }
  if (expected.size > 0) throw new WorkspaceServerError("workspace_bundle_v3_required_file_missing", 400);
  const rowsByFile = new Map<string, Record<string, unknown>[]>();
  for (const file of [workspaceFile, ...jsonlFiles]) {
    const rows = learningJsonlFiles.includes(file as (typeof learningJsonlFiles)[number]) && !actual[file]
      ? []
      : await assertPortableJsonFile(path.join(root, file), file);
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
    if (content.byteLength > WORKSPACE_BUNDLE_MAX_ENTRY_BYTES) throw new WorkspaceServerError("workspace_bundle_v3_entry_too_large", 413);
    total += content.byteLength;
    if (total > WORKSPACE_BUNDLE_MAX_BYTES) throw new WorkspaceServerError("workspace_bundle_v3_transport_too_large", 413);
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
      if (total > WORKSPACE_BUNDLE_MAX_BYTES) throw new WorkspaceServerError("workspace_bundle_v3_transport_too_large", 413);
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
  targetOrganizationId?: string;
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
  await importWorkspaceEvents(sql, input.targetWorkspaceId, input.targetOrganizationId, await readJsonl(path.join(input.sourceDirectory, "events.jsonl")));
  // Learning data is part of the Workspace's portable history.  It is kept
  // separate from generic records so Restore cannot accidentally turn a
  // historical note into executable state.  A running job has no portable
  // process lease, so it is deliberately returned to the queue.
  for (const [file, table, columns] of [
    ["learning-activities.jsonl", "workspace_learning_activities", ["room_id", "id", "group_key", "principal_account_id", "source_kind", "source_id", "correction_of_activity_id", "instruction_summary", "result_summary", "outcome", "verification_state", "failure_state", "explicit_remember", "payload", "created_at", "finalized_at"]],
    ["learning-resources.jsonl", "workspace_learning_resources", ["id", "scope_kind", "room_id", "resource_kind", "state", "is_absolute_rule", "ai_update_locked", "confidence", "source_job_id", "source_attempt_id", "title", "content", "payload", "version", "created_by", "updated_by", "archived_at", "created_at", "updated_at"]],
    ["learning-resource-versions.jsonl", "workspace_learning_resource_versions", ["id", "resource_id", "version", "change_kind", "scope_kind", "room_id", "state", "ai_update_locked", "confidence", "source_job_id", "source_attempt_id", "title", "content", "payload", "content_hash", "reason", "actor_account_id", "created_at"]],
    ["learning-evidence.jsonl", "workspace_learning_evidence", ["id", "resource_id", "resource_version", "activity_id", "kind", "summary", "created_at"]],
    ["learning-resource-links.jsonl", "workspace_learning_resource_links", ["id", "from_resource_id", "to_resource_id", "relation", "created_at"]],
    // secret_ref is intentionally not present in portable data.
    ["learning-settings.jsonl", "workspace_learning_settings", ["id", "scope_kind", "room_id", "enabled", "engine_id", "model", "currency_limit", "token_limit", "currency_used", "tokens_used", "version", "updated_by", "updated_at"]],
    ["learning-resource-uses.jsonl", "workspace_learning_resource_uses", ["id", "resource_id", "resource_version", "activity_id", "outcome", "supersedes_use_id", "summary", "created_at"]]
  ] as const) {
    const rows = await readOptionalJsonl(path.join(input.sourceDirectory, file));
    for (const row of rows) {
      const placeholders = columns.map((_, index) => `$${index + 2}`).join(", ");
      const values = columns.map((column) => jsonColumnValue(row[column]));
      const sqlColumns = ["workspace_id", ...columns].join(", ");
      await sql.query(`INSERT INTO ${table}(${sqlColumns}) VALUES ($1, ${placeholders})`, [input.targetWorkspaceId, ...values]);
    }
  }
  for (const row of await readOptionalJsonl(path.join(input.sourceDirectory, "learning-jobs.jsonl"))) {
    const wasRunning = row.status === "running";
    await sql.query(
      `INSERT INTO workspace_learning_jobs(
         workspace_id, room_id, id, kind, status, priority, group_key,
         high_watermark_activity_id, next_run_at, attempt_count, max_attempts,
         lease_owner, lease_expires_at, heartbeat_at, blocked_reason, engine_id,
         model, created_by, updated_by, created_at, updated_at, completed_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9::TIMESTAMPTZ, $10, $11,
         NULL, NULL, NULL, $12, $13, $14, $15, $16, $17::TIMESTAMPTZ,
         $18::TIMESTAMPTZ, $19::TIMESTAMPTZ
       )`,
      [
        input.targetWorkspaceId,
        String(row.room_id),
        String(row.id),
        String(row.kind),
        wasRunning ? "queued" : String(row.status),
        String(row.priority),
        String(row.group_key),
        String(row.high_watermark_activity_id),
        wasRunning ? new Date().toISOString() : String(row.next_run_at),
        Number(row.attempt_count),
        Number(row.max_attempts),
        wasRunning ? null : (row.blocked_reason === null || row.blocked_reason === undefined ? null : String(row.blocked_reason)),
        row.engine_id === null || row.engine_id === undefined ? null : String(row.engine_id),
        row.model === null || row.model === undefined ? null : String(row.model),
        String(row.created_by),
        String(row.updated_by),
        String(row.created_at),
        String(row.updated_at),
        wasRunning ? null : (row.completed_at === null || row.completed_at === undefined ? null : String(row.completed_at))
      ]
    );
  }
  for (const row of await readOptionalJsonl(path.join(input.sourceDirectory, "learning-job-attempts.jsonl"))) {
    const wasRunning = row.status === "running";
    await sql.query(
      `INSERT INTO workspace_learning_job_attempts(
         workspace_id, id, job_id, attempt_no, worker_id, engine_id, model,
         status, input_hash, output_hash, output, error_code, currency_used,
         tokens_used, reserved_currency, reserved_tokens, started_at, completed_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::JSONB, $12, $13,
         $14, $15, $16, $17::TIMESTAMPTZ, $18::TIMESTAMPTZ
       )`,
      [
        input.targetWorkspaceId,
        String(row.id),
        String(row.job_id),
        Number(row.attempt_no),
        String(row.worker_id),
        row.engine_id === null || row.engine_id === undefined ? null : String(row.engine_id),
        row.model === null || row.model === undefined ? null : String(row.model),
        wasRunning ? "failed" : String(row.status),
        String(row.input_hash),
        row.output_hash === null || row.output_hash === undefined ? null : String(row.output_hash),
        jsonColumnValue(row.output),
        wasRunning ? "workspace_learning_restore_interrupted" : (row.error_code === null || row.error_code === undefined ? null : String(row.error_code)),
        Number(row.currency_used),
        Number(row.tokens_used),
        wasRunning ? 0 : Number(row.reserved_currency ?? 0),
        wasRunning ? 0 : Number(row.reserved_tokens ?? 0),
        String(row.started_at),
        wasRunning ? new Date().toISOString() : (row.completed_at === null || row.completed_at === undefined ? null : String(row.completed_at))
      ]
    );
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
    const portableAudit = portableAuditRow(row);
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
        portableAudit.subject_kind ? String(portableAudit.subject_kind) : null,
        portableAudit.subject_id ? String(portableAudit.subject_id) : null,
        row.before_version === null || row.before_version === undefined ? null : Number(row.before_version),
        row.after_version === null || row.after_version === undefined ? null : Number(row.after_version),
        canonicalJson(portableAudit.details && typeof portableAudit.details === "object" ? portableAudit.details : {}),
        String(row.created_at ?? new Date().toISOString())
      ]
    );
  }
}

const workspaceEventBaseColumns = [
  "source_event_id", "room_id", "kind", "record_type", "record_id", "operation_id", "payload", "created_at"
] as const;
const workspaceEventPublicColumns = [
  "event_id", "event_version", "actor_kind", "actor_id", "organization_id", "cursor", "correlation_id", "resources"
] as const;

async function importWorkspaceEvents(
  sql: WorkspaceSql,
  targetWorkspaceId: string,
  targetOrganizationId: string | undefined,
  rows: Record<string, unknown>[]
): Promise<void> {
  for (const row of rows) {
    // Public columns are optional only for backwards compatibility with
    // older V3 bundles. Omitting them lets the database apply safe defaults;
    // Organization scope is deliberately omitted for standalone restores.
    const columns = [...workspaceEventBaseColumns] as string[];
    const values = workspaceEventBaseColumns.map((column) => jsonColumnValue(row[column]));
    for (const column of workspaceEventPublicColumns) {
      // Event scope follows the restored Workspace's target Organization.
      // A source value is provenance only and must never carry source-tenant
      // visibility into the target.
      if (column === "organization_id") {
        if (targetOrganizationId !== undefined) {
          columns.push(column);
          values.push(targetOrganizationId);
        }
        continue;
      }
      if (!(column in row)) continue;
      columns.push(column);
      values.push(jsonColumnValue(row[column]));
    }
    const placeholders = columns.map((_, index) => `$${index + 2}`).join(", ");
    await sql.query(
      `INSERT INTO workspace_events(workspace_id, ${columns.join(", ")}) VALUES ($1, ${placeholders})`,
      [targetWorkspaceId, ...values]
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
    // WorkspaceSql is one PostgreSQL client and transaction.  Keep its
    // queries ordered: Promise.all overlaps client.query calls and made the
    // bundle verification timing-dependent.
    const tables = [
      "rooms", "workspace_members", "room_members", "workspace_records", "workspace_events",
      "workspace_jobs", "workspace_operations", "workspace_invitations", "workspace_audit_entries", "workspace_files",
      "workspace_learning_activities", "workspace_learning_resources", "workspace_learning_resource_versions", "workspace_learning_evidence", "workspace_learning_resource_links", "workspace_learning_settings", "workspace_learning_jobs", "workspace_learning_job_attempts", "workspace_learning_resource_uses"
    ] as const;
    const rows: number[] = [];
    for (const table of tables) rows.push(await count(sql, table, context.workspaceId));
    const countAt = (index: number): number => rows[index] ?? 0;
    return {
      rooms: countAt(0), memberships: countAt(1), room_memberships: countAt(2), records: countAt(3), events: countAt(4), jobs: countAt(5), operations: countAt(6), invitations: countAt(7), audits: countAt(8), files: countAt(9),
      learning_activities: countAt(10), learning_resources: countAt(11), learning_resource_versions: countAt(12), learning_evidence: countAt(13), learning_resource_links: countAt(14), learning_settings: countAt(15), learning_jobs: countAt(16), learning_job_attempts: countAt(17), learning_resource_uses: countAt(18)
    };
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
  if (Buffer.byteLength(text, "utf8") > WORKSPACE_BUNDLE_MAX_ENTRY_BYTES) throw new WorkspaceServerError("workspace_bundle_v3_entry_too_large", 413);
  const lines = relativeFile.endsWith(".jsonl") ? text.split("\n").filter(Boolean) : [text];
  if (lines.length > WORKSPACE_BUNDLE_MAX_RECORDS_PER_FILE) throw new WorkspaceServerError("workspace_bundle_v3_record_count_too_large", 413);
  const rows = lines.map((line) => JSON.parse(line));
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new WorkspaceServerError("workspace_bundle_v3_schema_invalid", 400);
    const record = row as Record<string, unknown>;
    assertExactPortableFields(record, schema);
    if (relativeFile === "events.jsonl") assertPortableEventFields(record);
    assertCredentialFree(record);
    assertPortablePathsFree(record);
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

const portablePathFieldNames = new Set([
  "path", "filepath", "storage_namespace", "storagenamespace", "working_directory", "workingdirectory",
  "worktree_path", "worktreepath", "absolute_path", "absolutepath", "directory", "directory_path",
  "directorypath", "root_path", "rootpath", "cwd", "home"
]);

function assertPortablePathsFree(value: unknown, fieldName?: string): void {
  if (typeof value === "string") {
    if (fieldName && portablePathFieldNames.has(fieldName.toLowerCase().replace(/[^a-z0-9]/g, ""))
      && isAbsolutePortablePath(value)) {
      throw new WorkspaceServerError("workspace_bundle_v3_absolute_path_forbidden", 400);
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

function assertExactPortableFields(value: Record<string, unknown>, schema: { required: readonly string[]; allowed: readonly string[] }): void {
  const allowed = new Set(schema.allowed);
  if (Object.keys(value).some((key) => !allowed.has(key)) || schema.required.some((key) => !(key in value))) {
    throw new WorkspaceServerError("workspace_bundle_v3_schema_invalid", 400);
  }
}

function assertPortableEventFields(row: Record<string, unknown>): void {
  if (row.room_id !== null && typeof row.room_id !== "string") {
    throw new WorkspaceServerError("workspace_bundle_v3_schema_invalid", 400);
  }
  for (const field of ["event_id", "event_version", "cursor"] as const) {
    if (row[field] !== undefined && typeof row[field] !== "string") {
      throw new WorkspaceServerError("workspace_bundle_v3_schema_invalid", 400);
    }
  }
  if (row.event_id !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(row.event_id as string)) {
    throw new WorkspaceServerError("workspace_bundle_v3_schema_invalid", 400);
  }
  if (row.event_version !== undefined && !/^\d+\.\d+$/.test(row.event_version as string)) {
    throw new WorkspaceServerError("workspace_bundle_v3_schema_invalid", 400);
  }
  if (row.cursor !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(row.cursor as string)) {
    throw new WorkspaceServerError("workspace_bundle_v3_schema_invalid", 400);
  }
  if (row.actor_kind !== undefined && !["human", "agent", "system"].includes(row.actor_kind as string)) {
    throw new WorkspaceServerError("workspace_bundle_v3_schema_invalid", 400);
  }
  for (const field of ["actor_id", "organization_id", "correlation_id"] as const) {
    if (row[field] !== undefined && row[field] !== null && typeof row[field] !== "string") {
      throw new WorkspaceServerError("workspace_bundle_v3_schema_invalid", 400);
    }
    if (row[field] !== undefined && row[field] !== null && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(row[field] as string)) {
      throw new WorkspaceServerError("workspace_bundle_v3_schema_invalid", 400);
    }
  }
  if (row.resources !== undefined && !ResourceRefSchema.array().max(100).safeParse(row.resources).success) {
    throw new WorkspaceServerError("workspace_bundle_v3_schema_invalid", 400);
  }
}

function assertPortableBundleRelations(manifest: WorkspaceBundleV3Manifest, rowsByFile: Map<string, Record<string, unknown>[]>): void {
  const workspace = rowsByFile.get(workspaceFile)?.[0];
  if (workspace?.id !== manifest.workspace_id) throw new WorkspaceServerError("workspace_bundle_workspace_mismatch", 400);
  const workspaceOrganizationId = optionalOpaqueId(workspace?.organization_id, "workspace_bundle_v3_schema_invalid");
  const manifestOrganizationId = sourceManifestOrganizationId(manifest);
  if (workspaceOrganizationId && manifestOrganizationId && workspaceOrganizationId !== manifestOrganizationId) {
    throw new WorkspaceServerError("workspace_bundle_v3_relation_invalid", 400);
  }
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
  // A legacy local-store migration can safely preserve only its configured local
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
    if (row.room_id !== null && !roomIds.has(opaquePortableValue(row.room_id, "workspace_bundle_v3_relation_invalid"))) {
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
  const learningActivities = new Map<string, Record<string, unknown>>();
  for (const row of rowsByFile.get("learning-activities.jsonl") ?? []) {
    const activityId = opaquePortableValue(row.id, "workspace_bundle_v3_relation_invalid");
    const roomId = opaquePortableValue(row.room_id, "workspace_bundle_v3_relation_invalid");
    const principalAccountId = opaquePortableValue(row.principal_account_id, "workspace_bundle_v3_relation_invalid");
    if (learningActivities.has(activityId) || !roomIds.has(roomId) || !knownAccountIds.has(principalAccountId)) {
      throw new WorkspaceServerError("workspace_bundle_v3_relation_invalid", 400);
    }
    learningActivities.set(activityId, row);
  }
  for (const row of learningActivities.values()) {
    if (row.correction_of_activity_id !== null && row.correction_of_activity_id !== undefined) {
      const correctionId = opaquePortableValue(row.correction_of_activity_id, "workspace_bundle_v3_relation_invalid");
      const original = learningActivities.get(correctionId);
      if (!original || original.room_id !== row.room_id) throw new WorkspaceServerError("workspace_bundle_v3_relation_invalid", 400);
    }
  }
  const assertLearningScope = (scopeKind: unknown, roomId: unknown): void => {
    if (scopeKind === "workspace") {
      if (roomId !== null) throw new WorkspaceServerError("workspace_bundle_v3_relation_invalid", 400);
      return;
    }
    if (scopeKind !== "room" || typeof roomId !== "string" || !roomIds.has(opaquePortableValue(roomId, "workspace_bundle_v3_relation_invalid"))) {
      throw new WorkspaceServerError("workspace_bundle_v3_relation_invalid", 400);
    }
  };
  const learningResources = new Map<string, Record<string, unknown>>();
  for (const row of rowsByFile.get("learning-resources.jsonl") ?? []) {
    const resourceId = opaquePortableValue(row.id, "workspace_bundle_v3_relation_invalid");
    const createdBy = opaquePortableValue(row.created_by, "workspace_bundle_v3_relation_invalid");
    const updatedBy = opaquePortableValue(row.updated_by, "workspace_bundle_v3_relation_invalid");
    assertLearningScope(row.scope_kind, row.room_id);
    if (learningResources.has(resourceId) || !knownAccountIds.has(createdBy) || !knownAccountIds.has(updatedBy)
      || !["knowledge", "memory", "skill", "workspace_rule"].includes(String(row.resource_kind))
      || !["active", "provisional", "archived", "conflict"].includes(String(row.state))
      || (row.resource_kind === "workspace_rule") !== (row.is_absolute_rule === true)
      || (row.resource_kind === "workspace_rule" && row.scope_kind !== "workspace")
      || (row.confidence !== undefined && row.confidence !== null && (!Number.isFinite(Number(row.confidence)) || Number(row.confidence) < 0 || Number(row.confidence) > 1))
      || (row.state === "provisional" && (typeof row.source_job_id !== "string" || typeof row.source_attempt_id !== "string" || row.confidence === null || row.confidence === undefined))) {
      throw new WorkspaceServerError("workspace_bundle_v3_relation_invalid", 400);
    }
    learningResources.set(resourceId, row);
  }
  const learningResourceVersions = new Map<string, Record<string, unknown>>();
  for (const row of rowsByFile.get("learning-resource-versions.jsonl") ?? []) {
    const resourceId = opaquePortableValue(row.resource_id, "workspace_bundle_v3_relation_invalid");
    const actorAccountId = opaquePortableValue(row.actor_account_id, "workspace_bundle_v3_relation_invalid");
    const version = Number(row.version);
    const versionKey = `${resourceId}\u0000${version}`;
    const resource = learningResources.get(resourceId);
    const expectedContentHash = typeof row.title === "string" && typeof row.content === "string" && row.payload && typeof row.payload === "object" && !Array.isArray(row.payload)
      ? hashText(canonicalJson({ title: row.title, content: row.content, payload: row.payload }))
      : undefined;
    assertLearningScope(row.scope_kind, row.room_id);
    if (!resource || !knownAccountIds.has(actorAccountId) || !Number.isSafeInteger(version) || version < 1 || learningResourceVersions.has(versionKey)
      || row.scope_kind !== resource.scope_kind || row.room_id !== resource.room_id
      || !["active", "provisional", "archived", "conflict"].includes(String(row.state))
      || (row.confidence !== undefined && row.confidence !== null && (!Number.isFinite(Number(row.confidence)) || Number(row.confidence) < 0 || Number(row.confidence) > 1))
      || (row.state === "provisional" && (typeof row.source_job_id !== "string" || typeof row.source_attempt_id !== "string" || row.confidence === null || row.confidence === undefined))
      || row.content_hash !== expectedContentHash) {
      throw new WorkspaceServerError("workspace_bundle_v3_relation_invalid", 400);
    }
    learningResourceVersions.set(versionKey, row);
  }
  for (const [resourceId, resource] of learningResources) {
    const currentVersion = Number(resource.version);
    const current = learningResourceVersions.get(`${resourceId}\u0000${currentVersion}`);
    if (!Number.isSafeInteger(currentVersion) || currentVersion < 1 || !current
      || current.scope_kind !== resource.scope_kind || current.room_id !== resource.room_id
      || current.state !== resource.state || current.ai_update_locked !== resource.ai_update_locked
      || Number(current.confidence ?? -1) !== Number(resource.confidence ?? -1)
      || (current.source_job_id ?? null) !== (resource.source_job_id ?? null)
      || (current.source_attempt_id ?? null) !== (resource.source_attempt_id ?? null)
      || current.title !== resource.title || current.content !== resource.content
      || canonicalJson(current.payload) !== canonicalJson(resource.payload)) {
      throw new WorkspaceServerError("workspace_bundle_v3_relation_invalid", 400);
    }
    for (let version = 1; version <= currentVersion; version += 1) {
      if (!learningResourceVersions.has(`${resourceId}\u0000${version}`)) {
        throw new WorkspaceServerError("workspace_bundle_v3_relation_invalid", 400);
      }
    }
  }
  for (const row of rowsByFile.get("learning-evidence.jsonl") ?? []) {
    const resourceId = opaquePortableValue(row.resource_id, "workspace_bundle_v3_relation_invalid");
    const resource = learningResources.get(resourceId);
    const version = Number(row.resource_version);
    const humanEdit = row.kind === "human_edit";
    const activityId = row.activity_id === null || row.activity_id === undefined ? undefined : opaquePortableValue(row.activity_id, "workspace_bundle_v3_relation_invalid");
    const activity = activityId ? learningActivities.get(activityId) : undefined;
    if (!resource || !learningResourceVersions.has(`${resourceId}\u0000${version}`)
      || (humanEdit !== !activityId)
      || (!humanEdit && (!activity || (resource.scope_kind === "room" && resource.room_id !== activity.room_id)))) {
      throw new WorkspaceServerError("workspace_bundle_v3_relation_invalid", 400);
    }
  }
  for (const row of rowsByFile.get("learning-resource-links.jsonl") ?? []) {
    const fromResourceId = opaquePortableValue(row.from_resource_id, "workspace_bundle_v3_relation_invalid");
    const toResourceId = opaquePortableValue(row.to_resource_id, "workspace_bundle_v3_relation_invalid");
    if (!learningResources.has(fromResourceId) || !learningResources.has(toResourceId) || fromResourceId === toResourceId
      || !["conflicts", "copied_from", "moved_from", "promoted_from", "derived_from"].includes(String(row.relation))) {
      throw new WorkspaceServerError("workspace_bundle_v3_relation_invalid", 400);
    }
  }
  const learningSettings = new Set<string>();
  for (const row of rowsByFile.get("learning-settings.jsonl") ?? []) {
    const settingsId = learningSettingsIdValue(row.id, "workspace_bundle_v3_relation_invalid");
    const updatedBy = opaquePortableValue(row.updated_by, "workspace_bundle_v3_relation_invalid");
    const roomId = row.scope_kind === "room" ? opaquePortableValue(row.room_id, "workspace_bundle_v3_relation_invalid") : undefined;
    const scopeKey = row.scope_kind === "workspace" ? "workspace" : `room:${roomId}`;
    assertLearningScope(row.scope_kind, row.room_id);
    if (learningSettings.has(scopeKey) || !knownAccountIds.has(updatedBy) || !settingsId
      || settingsId !== scopeKey || typeof row.enabled !== "boolean" || Number(row.currency_used) < 0 || Number(row.tokens_used) < 0) {
      throw new WorkspaceServerError("workspace_bundle_v3_relation_invalid", 400);
    }
    learningSettings.add(scopeKey);
  }
  const learningJobs = new Map<string, Record<string, unknown>>();
  for (const row of rowsByFile.get("learning-jobs.jsonl") ?? []) {
    const jobId = opaquePortableValue(row.id, "workspace_bundle_v3_relation_invalid");
    const roomId = opaquePortableValue(row.room_id, "workspace_bundle_v3_relation_invalid");
    const activityId = opaquePortableValue(row.high_watermark_activity_id, "workspace_bundle_v3_relation_invalid");
    const createdBy = opaquePortableValue(row.created_by, "workspace_bundle_v3_relation_invalid");
    const updatedBy = opaquePortableValue(row.updated_by, "workspace_bundle_v3_relation_invalid");
    const isRunning = row.status === "running";
    const hasLease = typeof row.lease_owner === "string" && typeof row.lease_expires_at === "string" && typeof row.heartbeat_at === "string";
    if (learningJobs.has(jobId) || !roomIds.has(roomId) || !knownAccountIds.has(createdBy) || !knownAccountIds.has(updatedBy)
      || !learningActivities.has(activityId) || learningActivities.get(activityId)?.room_id !== roomId
      || !["review", "curator"].includes(String(row.kind)) || !["queued", "running", "completed", "failed", "blocked"].includes(String(row.status))
      || !["normal", "high"].includes(String(row.priority)) || isRunning !== hasLease
      || (row.status === "blocked" && typeof row.blocked_reason !== "string")) {
      throw new WorkspaceServerError("workspace_bundle_v3_relation_invalid", 400);
    }
    learningJobs.set(jobId, row);
  }
  const learningAttempts = new Map<string, Record<string, unknown>>();
  for (const row of rowsByFile.get("learning-job-attempts.jsonl") ?? []) {
    const attemptId = opaquePortableValue(row.id, "workspace_bundle_v3_relation_invalid");
    const jobId = opaquePortableValue(row.job_id, "workspace_bundle_v3_relation_invalid");
    if (learningAttempts.has(attemptId) || !learningJobs.has(jobId) || !["running", "completed", "failed", "blocked"].includes(String(row.status))
      || Number(row.reserved_currency ?? 0) < 0 || Number(row.reserved_tokens ?? 0) < 0) {
      throw new WorkspaceServerError("workspace_bundle_v3_relation_invalid", 400);
    }
    learningAttempts.set(attemptId, row);
  }
  for (const row of [...learningResources.values(), ...learningResourceVersions.values()]) {
    const sourceJobId = row.source_job_id === null || row.source_job_id === undefined ? undefined : opaquePortableValue(row.source_job_id, "workspace_bundle_v3_relation_invalid");
    const sourceAttemptId = row.source_attempt_id === null || row.source_attempt_id === undefined ? undefined : opaquePortableValue(row.source_attempt_id, "workspace_bundle_v3_relation_invalid");
    if ((sourceJobId === undefined) !== (sourceAttemptId === undefined)
      || (sourceJobId && (!learningJobs.has(sourceJobId) || !learningAttempts.has(sourceAttemptId!) || learningAttempts.get(sourceAttemptId!)?.job_id !== sourceJobId))) {
      throw new WorkspaceServerError("workspace_bundle_v3_relation_invalid", 400);
    }
  }
  const learningUses = new Map<string, Record<string, unknown>>();
  for (const row of rowsByFile.get("learning-resource-uses.jsonl") ?? []) {
    const useId = opaquePortableValue(row.id, "workspace_bundle_v3_relation_invalid");
    const resourceId = opaquePortableValue(row.resource_id, "workspace_bundle_v3_relation_invalid");
    const activityId = opaquePortableValue(row.activity_id, "workspace_bundle_v3_relation_invalid");
    const resource = learningResources.get(resourceId);
    const activity = learningActivities.get(activityId);
    const version = Number(row.resource_version);
    if (learningUses.has(useId) || !resource || !activity || !learningResourceVersions.has(`${resourceId}\u0000${version}`)
      || (resource.scope_kind === "room" && resource.room_id !== activity.room_id)
      || !["confirmed_success", "confirmed_failure", "unknown"].includes(String(row.outcome))) {
      throw new WorkspaceServerError("workspace_bundle_v3_relation_invalid", 400);
    }
    learningUses.set(useId, row);
  }
  const correctedUseIds = new Set<string>();
  for (const row of learningUses.values()) {
    if (row.supersedes_use_id === null || row.supersedes_use_id === undefined) continue;
    const supersedesUseId = opaquePortableValue(row.supersedes_use_id, "workspace_bundle_v3_relation_invalid");
    const prior = learningUses.get(supersedesUseId);
    if (correctedUseIds.has(supersedesUseId) || !prior || prior.outcome !== "unknown" || prior.resource_id !== row.resource_id || prior.resource_version !== row.resource_version || prior.activity_id !== row.activity_id || row.outcome === "unknown") {
      throw new WorkspaceServerError("workspace_bundle_v3_relation_invalid", 400);
    }
    correctedUseIds.add(supersedesUseId);
  }
  const allCounts: Record<string, number> = {
    rooms: rowsByFile.get("rooms.jsonl")?.length ?? 0,
    memberships: rowsByFile.get("memberships.jsonl")?.length ?? 0,
    room_memberships: rowsByFile.get("room-memberships.jsonl")?.length ?? 0,
    records: rowsByFile.get("records.jsonl")?.length ?? 0,
    events: rowsByFile.get("events.jsonl")?.length ?? 0,
    jobs: rowsByFile.get("jobs.jsonl")?.length ?? 0,
    operations: rowsByFile.get("operations.jsonl")?.length ?? 0,
    invitations: rowsByFile.get("invitations.jsonl")?.length ?? 0,
    audits: rowsByFile.get("audits.jsonl")?.length ?? 0,
    files: rowsByFile.get("files.jsonl")?.length ?? 0,
    learning_activities: rowsByFile.get("learning-activities.jsonl")?.length ?? 0,
    learning_resources: rowsByFile.get("learning-resources.jsonl")?.length ?? 0,
    learning_resource_versions: rowsByFile.get("learning-resource-versions.jsonl")?.length ?? 0,
    learning_evidence: rowsByFile.get("learning-evidence.jsonl")?.length ?? 0,
    learning_resource_links: rowsByFile.get("learning-resource-links.jsonl")?.length ?? 0,
    learning_settings: rowsByFile.get("learning-settings.jsonl")?.length ?? 0,
    learning_jobs: rowsByFile.get("learning-jobs.jsonl")?.length ?? 0,
    learning_job_attempts: rowsByFile.get("learning-job-attempts.jsonl")?.length ?? 0,
    learning_resource_uses: rowsByFile.get("learning-resource-uses.jsonl")?.length ?? 0
  };
  const requiredCountNames = ["rooms", "memberships", "room_memberships", "records", "events", "jobs", "operations", "invitations", "audits", "files"];
  const learningCountNames = ["learning_activities", "learning_resources", "learning_resource_versions", "learning_evidence", "learning_resource_links", "learning_settings", "learning_jobs", "learning_job_attempts", "learning_resource_uses"];
  if (requiredCountNames.some((name) => !(name in manifest.record_counts))
    || learningCountNames.some((name) => (allCounts[name] ?? 0) > 0 && !(name in manifest.record_counts))
    || Object.entries(manifest.record_counts).some(([name, value]) => !(name in allCounts) || !Number.isSafeInteger(value) || value < 0)) {
    throw new WorkspaceServerError("workspace_bundle_v3_record_count_mismatch", 400);
  }
  const counts = Object.fromEntries(Object.keys(manifest.record_counts).map((name) => [name, allCounts[name]]));
  if (canonicalJson(counts) !== canonicalJson(manifest.record_counts)) {
    throw new WorkspaceServerError("workspace_bundle_v3_record_count_mismatch", 400);
  }
  if (allCounts.operations !== 0) throw new WorkspaceServerError("workspace_bundle_v3_operations_not_portable", 400);
  for (const file of ["rooms.jsonl", "memberships.jsonl", "room-memberships.jsonl", "records.jsonl", "events.jsonl", "jobs.jsonl", "invitations.jsonl", "audits.jsonl", "files.jsonl", ...learningJsonlFiles] as const) {
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

/** Settings rows are keyed by their scope. A Room id itself is opaque (up to
 * 128 characters), so its readable `room:` key can be five characters longer
 * than a generic opaque id without becoming an arbitrary identifier. */
function learningSettingsIdValue(value: unknown, code: string): string {
  if (value === "workspace") return value;
  if (typeof value !== "string" || !value.startsWith("room:")) throw new WorkspaceServerError(code, 400);
  assertOpaqueId(value.slice("room:".length), code);
  return value;
}

async function readJsonl(file: string): Promise<Record<string, unknown>[]> {
  const text = await readFile(file, "utf8");
  return text.split("\n").filter(Boolean).map((line) => {
    const parsed = JSON.parse(line) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new WorkspaceServerError("workspace_bundle_v3_jsonl_invalid", 400);
    return parsed as Record<string, unknown>;
  });
}

async function readOptionalJsonl(file: string): Promise<Record<string, unknown>[]> {
  try {
    return await readJsonl(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function readJsonObject(file: string): Promise<Record<string, unknown>> {
  const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new WorkspaceServerError("workspace_bundle_v3_json_invalid", 400);
  return parsed as Record<string, unknown>;
}

function jsonColumnValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "object") return canonicalJson(stripOrganizationIdentifiers(value));
  return value;
}

export function assertWorkspaceBundleTargetOrganizationId(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new WorkspaceServerError("workspace_bundle_target_organization_required", 400);
  }
  return assertOpaqueId(value.trim(), "organization_id_invalid");
}

/**
 * A Workspace restore is standalone by default. Keep the historical strict
 * assertion above for Organization-scoped callers, while Bundle staging and
 * import treat the target Organization as an explicit optional override.
 */
function optionalWorkspaceBundleTargetOrganizationId(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return assertWorkspaceBundleTargetOrganizationId(value);
}

interface WorkspaceImportStartInput {
  targetWorkspaceId: string;
  workspaceName: string;
  mode: WorkspaceServerMode;
  databasePlacement: "shared" | "dedicated";
  importId: string;
  sourceWorkspaceVersion: number;
  targetOrganizationId?: string;
}

/**
 * The Organization migration extends the import function without making old
 * V3 bundles unreadable. Resolve the installed function signature first so a
 * server upgraded before the migration can still report the normal schema
 * readiness error instead of guessing an Organization or bypassing RLS.
 */
async function startWorkspaceImport(sql: WorkspaceSql, input: WorkspaceImportStartInput): Promise<void> {
  const functions = await sql.query<{ pronargs: number | string; proargnames: string[] | null }>(
    `SELECT p.pronargs, p.proargnames
       FROM pg_proc AS p
       JOIN pg_namespace AS n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'samurai_start_workspace_import'
      ORDER BY p.pronargs DESC
      LIMIT 1`
  );
  const functionRow = functions.rows[0];
  const argumentCount = Number(functionRow?.pronargs ?? 0);
  const legacyValues = [
    input.targetWorkspaceId,
    input.workspaceName,
    input.mode,
    input.databasePlacement,
    input.importId,
    input.sourceWorkspaceVersion
  ];
  if (argumentCount >= 7) {
    const names = Array.isArray(functionRow?.proargnames) ? functionRow.proargnames : [];
    const fallbackValues = [...legacyValues, input.targetOrganizationId ?? null];
    const values = Array.from({ length: argumentCount }, (_, index) => {
      const name = names[index]?.toLowerCase() ?? "";
      if (name.includes("organization")) return input.targetOrganizationId ?? null;
      if (name.includes("version")) return input.sourceWorkspaceVersion;
      if (name.includes("workspace") && name.includes("name")) return input.workspaceName;
      if (name.includes("workspace")) return input.targetWorkspaceId;
      if (name.includes("hosting") || name.includes("mode")) return input.mode;
      if (name.includes("placement")) return input.databasePlacement;
      if (name.includes("import") || name.includes("session")) return input.importId;
      return fallbackValues[index];
    });
    await sql.query(
      `SELECT samurai_start_workspace_import(${values.map((_, index) => `$${index + 1}`).join(", ")})`,
      values
    );
    return;
  }
  await sql.query("SELECT samurai_start_workspace_import($1, $2, $3, $4, $5, $6)", legacyValues);
}

async function pathExists(target: string): Promise<boolean> {
  return lstat(target).then(() => true).catch(() => false);
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableWorkspaceImportId(
  targetWorkspaceId: string,
  manifest: WorkspaceBundleV3Manifest,
  operationId: string
): string {
  // Prefer the transfer identity when present so a resend from another
  // request operation still resumes the same import. A non-transfer Bundle
  // remains scoped to its restore operation and cannot collide with an
  // unrelated manual restore of the same snapshot.
  const replayIdentity = manifest.transfer_id ?? operationId;
  return `import_${hashText(canonicalJson([targetWorkspaceId, replayIdentity, manifest.integrity_hash]))}`;
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
  if (candidate.entries.length > WORKSPACE_BUNDLE_MAX_ENTRIES) {
    throw new WorkspaceServerError("workspace_bundle_v3_transport_too_large", 413);
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
  const candidate = manifest as WorkspaceBundleV3ManifestWithProvenance;
  sourceManifestOrganizationId(manifest);
  if (manifest.schema_version !== undefined
    && (!Number.isSafeInteger(manifest.schema_version) || manifest.schema_version < 1)) {
    throw new WorkspaceServerError("workspace_bundle_v3_manifest_invalid", 400);
  }
  if (candidate.schema_revision !== undefined
    && (!Number.isSafeInteger(candidate.schema_revision) || candidate.schema_revision < 1)) {
    throw new WorkspaceServerError("workspace_bundle_v3_manifest_invalid", 400);
  }
  if (manifest.schema_version !== undefined && candidate.schema_revision !== undefined
    && manifest.schema_version !== candidate.schema_revision) {
    throw new WorkspaceServerError("workspace_bundle_v3_manifest_invalid", 400);
  }
  if (!/^[a-f0-9]{64}$/.test(manifest.integrity_hash)) throw new WorkspaceServerError("workspace_bundle_v3_manifest_invalid", 400);
  for (const [relativePath, hash] of Object.entries(manifest.files)) {
    assertSafeRelativePath(relativePath);
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new WorkspaceServerError("workspace_bundle_v3_manifest_invalid", 400);
  }
  for (const count of Object.values(manifest.record_counts)) {
    if (!Number.isSafeInteger(count) || count < 0) throw new WorkspaceServerError("workspace_bundle_v3_manifest_invalid", 400);
  }
}

function assertBundleManifestSize(manifestText: string, errorCode: string): void {
  if (Buffer.byteLength(manifestText, "utf8") > WORKSPACE_BUNDLE_MAX_BYTES) {
    throw new WorkspaceServerError(errorCode, 413);
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
    const children = await readdir(directory, { withFileTypes: true });
    for (const child of children) {
      const target = path.join(directory, child.name);
      const relative = path.relative(root, target).split(path.sep).join("/");
      if (child.isDirectory()) {
        await visit(target);
        continue;
      }
      const details = await lstat(target);
      if (details.isSymbolicLink() || !details.isFile()) {
        throw new WorkspaceServerError("workspace_bundle_v3_entry_invalid", 400);
      }
      // The manifest is transport metadata, not one of the uploaded
      // Workspace entries. Counting it would make a manifest with exactly
      // MAX_ENTRIES legitimate files impossible to stage.
      if (relative === manifestFile) continue;
      entries += 1;
      bytes += details.size;
      if (entries > WORKSPACE_BUNDLE_MAX_ENTRIES || bytes > WORKSPACE_BUNDLE_MAX_BYTES) return;
    }
  };
  await visit(root);
  return { bytes, entries };
}

function assertBundleUsage(usage: BundleUsage, errorCode: string): void {
  if (usage.entries > WORKSPACE_BUNDLE_MAX_ENTRIES || usage.bytes > WORKSPACE_BUNDLE_MAX_BYTES) {
    throw new WorkspaceServerError(errorCode, 413);
  }
}

function isValidTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

async function incomingBundleExpired(metadataPath: string, metadata: IncomingBundleMetadata): Promise<boolean> {
  const expiresAt = metadata.expires_at
    ? Date.parse(metadata.expires_at)
    : metadata.created_at
      ? Date.parse(metadata.created_at) + WORKSPACE_BUNDLE_INCOMING_TTL_MS
      : Number.NaN;
  if (Number.isFinite(expiresAt)) return expiresAt <= Date.now();
  try {
    const details = await stat(metadataPath);
    return details.mtimeMs + WORKSPACE_BUNDLE_INCOMING_TTL_MS <= Date.now();
  } catch {
    return true;
  }
}

function decodeTransportContent(value: string): Buffer {
  const maxEncodedLength = Math.ceil(WORKSPACE_BUNDLE_MAX_ENTRY_BYTES / 3) * 4;
  if (value.length > maxEncodedLength) throw new WorkspaceServerError("workspace_bundle_v3_entry_too_large", 413);
  if (!isBase64Syntax(value)) throw new WorkspaceServerError("workspace_bundle_v3_transport_entry_invalid", 400);
  const content = Buffer.from(value, "base64");
  if (content.toString("base64") !== value) throw new WorkspaceServerError("workspace_bundle_v3_transport_entry_invalid", 400);
  if (content.byteLength > WORKSPACE_BUNDLE_MAX_ENTRY_BYTES) throw new WorkspaceServerError("workspace_bundle_v3_entry_too_large", 413);
  return content;
}

function isBase64Syntax(value: string): boolean {
  if (value.length % 4 !== 0) return false;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const dataLength = value.length - padding;
  for (let index = 0; index < dataLength; index += 1) {
    const code = value.charCodeAt(index);
    if (!((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a) || (code >= 0x30 && code <= 0x39) || code === 0x2b || code === 0x2f)) {
      return false;
    }
  }
  return true;
}

function transferReceipt(manifest: WorkspaceBundleV3Manifest, targetWorkspaceId: string): WorkspaceTransferReceipt {
  if (!manifest.transfer_id) throw new WorkspaceServerError("workspace_transfer_receipt_invalid", 400);
  return {
    format_version: 1,
    transfer_id: manifest.transfer_id,
    source_workspace_id: manifest.workspace_id,
    source_integrity_hash: manifest.integrity_hash,
    target_workspace_id: targetWorkspaceId,
    // A receipt may be reconstructed after a response-loss retry. Deriving
    // this value from the verified immutable manifest keeps the complete
    // receipt byte-for-byte stable without relying on process-local time.
    imported_at: manifest.exported_at,
    target_integrity_hash: manifest.integrity_hash
  };
}
