import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import path from "node:path";
import { assertOpaqueId, assertSafeRelativePath } from "./config";
import { canonicalJson } from "./auth";
import { WorkspaceServerError } from "./errors";
import type { WorkspaceBundleV3Manifest } from "./types";
import { assertCredentialFreeWorkspaceFile, verifyWorkspaceBundleV3 } from "./workspace-bundle-v3";

const legacyFileRoots = ["artifacts", "profile", "memory", "skills", "wiki", "rollback", "collections"] as const;
const sensitiveKey = /(?:password|secret|private[_-]?key|access[_-]?token|refresh[_-]?token|credential|authorization|cookie)/i;
// These are transport/runtime implementation details, not Workspace-owned
// Knowledge or Activity. They are deliberately omitted rather than placed in
// an opaque `legacy_*` record where nobody can reason about their meaning.
const skippedTables = new Set([
  "schema_migrations", "migration_journal", "session_search_fts", "session_search_trigram",
  "domain_command_executions", "run_checkpoints", "workspace_file_transactions", "run_leases",
  "session_run_reservations", "gateway_concurrency_locks", "gateway_sandbox_instances",
  "gateway_sandbox_workspace_syncs", "skill_optimization_locks", "client_events",
  // Sessions belong to the calling Native App; they are intentionally not a
  // required parent of Workspace Knowledge and are not migrated as such.
  "sessions", "messages", "message_presentations",
  // Credential-bearing connection/runtime configuration stays with the old
  // installation and must be reconfigured explicitly at the destination.
  "gateway_pairings", "gateway_mcp_configs", "external_app_connections",
  "external_app_connection_rooms", "external_app_connection_ingress_classes",
  "grants", "room_agents", "agents",
  "agent_workspace_permissions", "resource_access_boundaries", "room_resource_shares",
  "gateway_pairing_policies", "gateway_routing_policies", "gateway_inbound_messages",
  "gateway_boundary_policies", "gateway_deliveries",
  // These rows contain old local settings and plugin runtime state. They can
  // include provider configuration, so they are omitted rather than guessed
  // as portable Knowledge.
  "settings", "plugin_states"
]);

/** Explicit legacy resource mapping. An unlisted table fails migration safely. */
const resourceTableTypes: Readonly<Record<string, string>> = {
  knowledge: "knowledge",
  note: "knowledge",
  wiki_index: "knowledge_wiki",
  memory_index: "memory",
  skill_index: "skill",
  skill_usage: "skill_usage",
  artifacts: "artifact",
  artifact_revisions: "artifact_revision",
  generated_surfaces: "generated_surface",
  generated_surface_revisions: "generated_surface_revision",
  surface_interactions: "surface_interaction",
  collection_schemas: "collection_schema",
  collection_records: "collection_record",
  collection_patches: "collection_patch",
  objectives: "objective",
  work_items: "work_item",
  work_dependencies: "work_dependency",
  workspace_changes: "workspace_change",
  activity_records: "activity",
  resource_usage_records: "resource_usage",
  learning_resource_uses: "learning_resource_use",
  learning_evaluations: "learning_evaluation",
  learning_snapshots: "learning_snapshot",
  learning_resource_versions: "learning_resource_version",
  background_review_changes: "background_review_change",
  learning_job_reports: "learning_job_report",
  curator_state: "curator_state",
  automation_runs: "automation_run",
  automation_jobs: "automation_job",
  policy_decisions: "policy_decision",
  approval_requests: "approval_request",
  rollback_points: "rollback_point",
  backend_runs: "backend_run",
  backend_events: "backend_event",
  tool_runs: "tool_run",
  external_assist_records: "external_assist_record",
  reflection_runs: "reflection_run",
  reflection_suggestions: "reflection_suggestion",
  external_sends: "external_send",
  resource_translations: "resource_translation"
};

export interface CreateBundleFromSqliteInput {
  sourceWorkspaceRoot: string;
  destination: string;
  workspaceId: string;
  ownerAccountId: string;
  workspaceName?: string;
}

/**
 * Read-only bridge for legacy Workspaces. It never opens SQLite writable and
 * never changes the source directory; callers import the resulting Bundle v3
 * only after its hashes and row counts verify.
 */
export async function createWorkspaceBundleV3FromLegacySqlite(input: CreateBundleFromSqliteInput): Promise<{ manifest: WorkspaceBundleV3Manifest; sourceHash: string }> {
  assertOpaqueId(input.workspaceId, "workspace_id_invalid");
  assertOpaqueId(input.ownerAccountId, "account_id_invalid");
  const sourceRoot = path.resolve(input.sourceWorkspaceRoot);
  const sourceDb = path.join(sourceRoot, "workspace.sqlite");
  const beforeHash = hashBytes(await readFile(sourceDb));
  const beforeSourceFingerprint = await legacySourceFingerprint(sourceRoot);
  // Read a private copy so SQLite's WAL/shared-memory handling can never
  // touch the legacy Workspace, even on platforms that update read locks.
  const legacyReadRoot = await copyLegacySqliteReadSource(sourceRoot);
  let database: Database.Database | undefined;
  let legacy: LegacySnapshot | undefined;
  try {
    database = new Database(path.join(legacyReadRoot, "workspace.sqlite"), { readonly: true, fileMustExist: true });
    database.pragma("query_only = ON");
    const integrity = String(database.pragma("integrity_check", { simple: true }));
    if (integrity.toLowerCase() !== "ok") throw new WorkspaceServerError("legacy_sqlite_integrity_failed", 400);
    legacy = readLegacySnapshot(database, input.workspaceId, input.ownerAccountId);
  } finally {
    database?.close();
    await rm(legacyReadRoot, { recursive: true, force: true }).catch(() => undefined);
  }
  if (!legacy) throw new WorkspaceServerError("legacy_sqlite_read_failed", 500);
  const destination = path.resolve(input.destination);
  await mkdir(destination, { recursive: false, mode: 0o700 });
  try {
    const roomId = "legacy-import";
    const now = new Date().toISOString();
    const files = await copyLegacyFiles(sourceRoot, destination, input.workspaceId, roomId, input.ownerAccountId, now);
    const workspace = {
      id: input.workspaceId,
      name: input.workspaceName?.trim() || "Migrated Workspace",
      hosting_mode: "self_host",
      database_placement: "dedicated",
      storage_namespace: `workspaces/${input.workspaceId}`,
      created_by: input.ownerAccountId,
      version: 1,
      created_at: now,
      updated_at: now
    };
    const rooms = ensureReferencedRooms(
      mergeLegacyRooms(input.workspaceId, roomId, now, legacy.rooms, input.ownerAccountId),
      input.workspaceId,
      now,
      input.ownerAccountId,
      [
        ...legacy.records.map((record) => record.room_id),
        ...legacy.jobs.map((job) => job.room_id)
      ]
    );
    // A SQLite Workspace has no portable account public keys. Carrying its
    // raw member IDs forward would make unknown people look authorised at the
    // destination, so only the verified target owner is made active. Other
    // people must be invited after import with a cryptographic identity.
    const memberships = mergeLegacyMemberships(input.workspaceId, input.ownerAccountId, now);
    // A legacy SQLite export cannot prove any old member identity.  The
    // verified target owner therefore becomes the direct owner of every
    // imported Room.  This preserves the data while satisfying the current
    // invariant that every Room has an active owner; it does not recreate or
    // grant access to any unverified legacy person.
    const roomMemberships = mergeLegacyRoomMemberships(
      input.workspaceId,
      input.ownerAccountId,
      rooms.map((room) => String(room.id)),
      now
    );
    const omittedWorkspaceMemberships = legacy.memberships.filter((member) => member.accountId !== input.ownerAccountId).length;
    const omittedRoomMemberships = legacy.roomMemberships.filter(
      (member) => member.accountId !== input.ownerAccountId || member.roomId !== roomId
    ).length;
    if (legacy.excludedTables.length > 0 || omittedWorkspaceMemberships > 0 || omittedRoomMemberships > 0) {
      const payload = {
        kind: "legacy_sqlite_migration_report",
        excluded_tables: legacy.excludedTables.sort(),
        omitted_unverified_workspace_memberships: omittedWorkspaceMemberships,
        omitted_unverified_room_memberships: omittedRoomMemberships
      };
      const payloadText = canonicalJson(payload);
      legacy.records.push({
        workspace_id: input.workspaceId,
        room_id: roomId,
        record_type: "migration_report",
        id: "legacy_sqlite_migration_report",
        version: 1,
        payload,
        search_text: payloadText,
        content_hash: hashText(payloadText),
        created_by: input.ownerAccountId,
        updated_by: input.ownerAccountId,
        created_at: now,
        updated_at: now
      });
    }
    await writeFile(path.join(destination, "workspace.json"), canonicalJson(workspace), { flag: "wx", mode: 0o600 });
    // SQLite-era Workspaces did not carry portable public-key identities.
    // The target owner is already registered before import; other people are
    // deliberately not recreated as active members without a verified key.
    await writeJsonl(destination, "accounts.jsonl", []);
    await writeJsonl(destination, "rooms.jsonl", rooms);
    await writeJsonl(destination, "memberships.jsonl", memberships);
    await writeJsonl(destination, "room-memberships.jsonl", roomMemberships);
    await writeJsonl(destination, "records.jsonl", legacy.records);
    await writeJsonl(destination, "events.jsonl", []);
    await writeJsonl(destination, "jobs.jsonl", legacy.jobs);
    await writeJsonl(destination, "operations.jsonl", []);
    await writeJsonl(destination, "invitations.jsonl", []);
    await writeJsonl(destination, "audits.jsonl", legacy.audits);
    await writeJsonl(destination, "files.jsonl", files);
    const fileHashes = await hashTree(destination);
    const recordCounts = {
      rooms: rooms.length,
      memberships: memberships.length,
      room_memberships: roomMemberships.length,
      records: legacy.records.length,
      events: 0,
      jobs: legacy.jobs.length,
      operations: 0,
      invitations: 0,
      audits: legacy.audits.length,
      files: files.length
    };
    const manifest: WorkspaceBundleV3Manifest = {
      format_version: 3,
      workspace_id: input.workspaceId,
      exported_at: now,
      source: { hosting_mode: "self_host", database_placement: "dedicated" },
      schema_version: 22,
      files: fileHashes,
      record_counts: recordCounts,
      integrity_hash: hashText(canonicalJson({ files: fileHashes, record_counts: recordCounts }))
    };
    await writeFile(path.join(destination, "manifest.json"), canonicalJson(manifest), { flag: "wx", mode: 0o600 });
    const afterHash = hashBytes(await readFile(sourceDb));
    const afterSourceFingerprint = await legacySourceFingerprint(sourceRoot);
    if (afterHash !== beforeHash || afterSourceFingerprint !== beforeSourceFingerprint) {
      throw new WorkspaceServerError("legacy_sqlite_source_changed_during_migration", 409);
    }
    await verifyWorkspaceBundleV3(destination);
    return { manifest, sourceHash: beforeHash };
  } catch (error) {
    await rm(destination, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

interface LegacyRecord {
  workspace_id: string;
  room_id: string;
  record_type: string;
  id: string;
  version: number;
  payload: Record<string, unknown>;
  search_text: string;
  content_hash: string;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
}

interface LegacyRoom {
  id: string;
  name: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

interface LegacyMembership {
  accountId: string;
  role: "owner" | "admin" | "member" | "guest";
  state: "active" | "revoked";
  version: number;
  createdAt: string;
  updatedAt: string;
  revokedAt: string | null;
}

interface LegacyRoomMembership extends LegacyMembership {
  roomId: string;
}

interface LegacyJob {
  workspace_id: string;
  room_id: string;
  id: string;
  kind: string;
  status: "queued" | "running" | "completed" | "failed" | "blocked";
  version: number;
  idempotency_key: string;
  payload: Record<string, unknown>;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
}

interface LegacyAudit {
  workspace_id: string;
  room_id: string | null;
  actor_account_id: string;
  action: string;
  outcome: "completed" | "rejected" | "failed";
  operation_id: string | null;
  subject_kind: string | null;
  subject_id: string | null;
  before_version: number | null;
  after_version: number | null;
  details: Record<string, unknown>;
  created_at: string;
}

interface LegacySnapshot {
  records: LegacyRecord[];
  rooms: LegacyRoom[];
  memberships: LegacyMembership[];
  roomMemberships: LegacyRoomMembership[];
  jobs: LegacyJob[];
  audits: LegacyAudit[];
  excludedTables: string[];
}

function readLegacySnapshot(database: Database.Database, workspaceId: string, ownerAccountId: string): LegacySnapshot {
  const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>;
  const now = new Date().toISOString();
  const snapshot: LegacySnapshot = { records: [], rooms: [], memberships: [], roomMemberships: [], jobs: [], audits: [], excludedTables: [] };
  for (const { name } of tables) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || name.startsWith("sqlite_")) continue;
    if (skippedTables.has(name)) {
      snapshot.excludedTables.push(name);
      continue;
    }
    const quoted = `"${name.replaceAll('"', '""')}"`;
    const sourceRows = database.prepare(`SELECT * FROM ${quoted}`).all() as Array<Record<string, unknown>>;
    if (name === "rooms") {
      sourceRows.forEach((source, index) => snapshot.rooms.push(legacyRoom(source, index, now)));
      continue;
    }
    if (name === "workspace_members") {
      sourceRows.forEach((source, index) => snapshot.memberships.push(legacyMembership(source, index, ownerAccountId, now)));
      continue;
    }
    if (name === "room_members") {
      sourceRows.forEach((source, index) => snapshot.roomMemberships.push(legacyRoomMembership(source, index, ownerAccountId, now)));
      continue;
    }
    if (name === "workspace_jobs") {
      sourceRows.forEach((source, index) => snapshot.jobs.push(legacyJob(source, index, workspaceId, ownerAccountId, now)));
      continue;
    }
    if (name === "audit_records") {
      sourceRows.forEach((source) => snapshot.audits.push(legacyAudit(source, workspaceId, ownerAccountId, now)));
      continue;
    }
    const recordType = resourceTableTypes[name];
    if (!recordType) throw new WorkspaceServerError(`legacy_sqlite_table_unsupported:${name}`, 400);
    sourceRows.forEach((source, index) => {
      const payload = sanitizeLegacyValue(source) as Record<string, unknown>;
      const id = legacyResourceId(source.id, name, index);
      const payloadText = canonicalJson(payload);
      snapshot.records.push({
        workspace_id: workspaceId,
        room_id: legacyRoomId(source.room_id) ?? "legacy-import",
        record_type: recordType,
        id,
        version: 1,
        payload,
        search_text: payloadText.slice(0, 500_000),
        content_hash: hashText(payloadText),
        created_by: ownerAccountId,
        updated_by: ownerAccountId,
        created_at: normalizeLegacyTimestamp(source.created_at, now),
        updated_at: normalizeLegacyTimestamp(source.updated_at, now)
      });
    });
  }
  return snapshot;
}

function legacyRoom(source: Record<string, unknown>, index: number, now: string): LegacyRoom {
  return {
    id: legacyRoomId(source.id) ?? `legacy-room-${index + 1}`,
    name: stringValue(source.name, `Imported room ${index + 1}`).slice(0, 500),
    version: legacyVersion(source.version),
    createdAt: normalizeLegacyTimestamp(source.created_at, now),
    updatedAt: normalizeLegacyTimestamp(source.updated_at, now)
  };
}

function legacyMembership(source: Record<string, unknown>, index: number, ownerAccountId: string, now: string): LegacyMembership {
  return {
    accountId: legacyAccountId(source.account_id ?? source.participant_id ?? source.user_id, ownerAccountId, index),
    role: legacyRole(source.role),
    state: legacyMembershipState(source.state),
    version: legacyVersion(source.version),
    createdAt: normalizeLegacyTimestamp(source.created_at, now),
    updatedAt: normalizeLegacyTimestamp(source.updated_at, now),
    revokedAt: source.revoked_at ? normalizeLegacyTimestamp(source.revoked_at, now) : null
  };
}

function legacyRoomMembership(source: Record<string, unknown>, index: number, ownerAccountId: string, now: string): LegacyRoomMembership {
  return {
    ...legacyMembership(source, index, ownerAccountId, now),
    roomId: legacyRoomId(source.room_id) ?? "legacy-import"
  };
}

function legacyJob(source: Record<string, unknown>, index: number, workspaceId: string, ownerAccountId: string, now: string): LegacyJob {
  const status = source.status;
  return {
    workspace_id: workspaceId,
    room_id: legacyRoomId(source.room_id) ?? "legacy-import",
    id: legacyResourceId(source.id, "workspace_job", index),
    kind: stringValue(source.kind, "legacy_workspace_job").slice(0, 120),
    status: status === "running" || status === "completed" || status === "failed" || status === "blocked" ? status : "queued",
    version: legacyVersion(source.version),
    idempotency_key: opaqueLegacyId(source.idempotency_key, `legacy_job_${index + 1}`),
    payload: sanitizeLegacyValue(source) as Record<string, unknown>,
    // Old actor IDs have no portable public-key proof. Preserve the job's
    // payload and timestamps, while attributing the imported record to the
    // verified target owner instead of creating a phantom identity.
    created_by: ownerAccountId,
    updated_by: ownerAccountId,
    created_at: normalizeLegacyTimestamp(source.created_at, now),
    updated_at: normalizeLegacyTimestamp(source.updated_at, now)
  };
}

function legacyAudit(source: Record<string, unknown>, workspaceId: string, ownerAccountId: string, now: string): LegacyAudit {
  const outcome = source.outcome;
  return {
    workspace_id: workspaceId,
    room_id: legacyRoomId(source.room_id) ?? null,
    actor_account_id: ownerAccountId,
    action: stringValue(source.action ?? source.kind, "legacy.audit_record").slice(0, 160),
    outcome: outcome === "rejected" || outcome === "failed" ? outcome : "completed",
    operation_id: optionalOpaqueLegacyId(source.operation_id) ?? null,
    subject_kind: optionalString(source.subject_kind ?? source.resource_kind),
    subject_id: optionalOpaqueLegacyId(source.subject_id ?? source.resource_id) ?? null,
    before_version: numericOrNull(source.before_version),
    after_version: numericOrNull(source.after_version),
    details: sanitizeLegacyValue(source) as Record<string, unknown>,
    created_at: normalizeLegacyTimestamp(source.created_at, now)
  };
}

function mergeLegacyRooms(workspaceId: string, defaultRoomId: string, now: string, legacyRooms: LegacyRoom[], ownerAccountId: string): Array<Record<string, unknown>> {
  const rooms = new Map<string, Record<string, unknown>>();
  rooms.set(defaultRoomId, { workspace_id: workspaceId, id: defaultRoomId, parent_room_id: null, name: "Imported legacy data", version: 1, created_by: ownerAccountId, created_at: now, updated_at: now });
  for (const room of legacyRooms) {
    rooms.set(room.id, {
      workspace_id: workspaceId,
      id: room.id,
      parent_room_id: null,
      name: room.name,
      version: room.version,
      created_by: ownerAccountId,
      created_at: room.createdAt,
      updated_at: room.updatedAt
    });
  }
  return [...rooms.values()];
}

function ensureReferencedRooms(
  rooms: Array<Record<string, unknown>>,
  workspaceId: string,
  now: string,
  ownerAccountId: string,
  referencedRoomIds: string[]
): Array<Record<string, unknown>> {
  const known = new Set(rooms.map((room) => String(room.id)));
  for (const id of referencedRoomIds) {
    if (known.has(id)) continue;
    rooms.push({ workspace_id: workspaceId, id, parent_room_id: null, name: `Imported room ${id}`, version: 1, created_by: ownerAccountId, created_at: now, updated_at: now });
    known.add(id);
  }
  return rooms;
}

function mergeLegacyMemberships(workspaceId: string, ownerAccountId: string, now: string): Array<Record<string, unknown>> {
  return [{
    workspace_id: workspaceId,
    account_id: ownerAccountId,
    role: "owner",
    state: "active",
    version: 1,
    created_at: now,
    updated_at: now,
    revoked_at: null
  }];
}

function mergeLegacyRoomMemberships(
  workspaceId: string,
  ownerAccountId: string,
  roomIds: readonly string[],
  now: string
): Array<Record<string, unknown>> {
  return roomIds.map((roomId) => ({
    workspace_id: workspaceId,
    room_id: roomId,
    account_id: ownerAccountId,
    role: "owner",
    state: "active",
    version: 1,
    created_at: now,
    updated_at: now,
    revoked_at: null
  }));
}

function legacyResourceId(value: unknown, table: string, index: number): string {
  const candidate = optionalOpaqueLegacyId(value);
  return candidate ?? opaqueLegacyId(`legacy_${table}_${index + 1}`, `legacy_${index + 1}`);
}

function legacyRoomId(value: unknown): string | undefined {
  return optionalOpaqueLegacyId(value);
}

function legacyAccountId(value: unknown, fallback: string, index: number): string {
  return optionalOpaqueLegacyId(value) ?? `${fallback}-legacy-${index + 1}`.slice(0, 120);
}

function optionalOpaqueLegacyId(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const normalized = String(value).trim().replace(/[^A-Za-z0-9._:-]/g, "_").slice(0, 120);
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(normalized) ? normalized : undefined;
}

function opaqueLegacyId(value: unknown, fallback: string): string {
  return optionalOpaqueLegacyId(value) ?? fallback;
}

function legacyRole(value: unknown): "owner" | "admin" | "member" | "guest" {
  return value === "owner" || value === "admin" || value === "guest" ? value : "member";
}

function legacyMembershipState(value: unknown): "active" | "revoked" {
  return value === "revoked" ? "revoked" : "active";
}

function legacyVersion(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1;
}

function numericOrNull(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 160) : null;
}

function sanitizeLegacyValue(value: unknown, key = ""): unknown {
  if (sensitiveKey.test(key)) return undefined;
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Uint8Array) return { encoding: "base64", value: Buffer.from(value).toString("base64") };
  if (Array.isArray(value)) return value.map((item) => sanitizeLegacyValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([nestedKey]) => !sensitiveKey.test(nestedKey))
      .map(([nestedKey, nestedValue]) => [nestedKey, sanitizeLegacyValue(nestedValue, nestedKey)]));
  }
  return String(value);
}

async function copyLegacyFiles(sourceRoot: string, destination: string, workspaceId: string, roomId: string, ownerAccountId: string, now: string): Promise<Array<Record<string, unknown>>> {
  const metadata: Array<Record<string, unknown>> = [];
  for (const root of legacyFileRoots) {
    const source = path.join(sourceRoot, root);
    const exists = await lstat(source).then((entry) => entry.isDirectory()).catch(() => false);
    if (!exists) continue;
    await copyDirectory(source, path.join(destination, "files", root), root, metadata, workspaceId, roomId, ownerAccountId, now);
  }
  return metadata;
}

async function copyLegacySqliteReadSource(sourceRoot: string): Promise<string> {
  const staging = await mkdtemp(path.join(tmpdir(), "samurai-legacy-sqlite-"));
  try {
    let copiedDatabase = false;
    for (const name of ["workspace.sqlite", "workspace.sqlite-wal", "workspace.sqlite-shm", "workspace.sqlite-journal"]) {
      const source = path.join(sourceRoot, name);
      const info = await lstat(source).catch(() => undefined);
      if (!info) continue;
      if (!info.isFile()) throw new WorkspaceServerError("legacy_sqlite_source_file_type_invalid", 400);
      await copyFile(source, path.join(staging, name));
      if (name === "workspace.sqlite") copiedDatabase = true;
    }
    if (!copiedDatabase) throw new WorkspaceServerError("legacy_sqlite_read_failed", 400);
    return staging;
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

/** SQLite may keep recent writes in sidecar files, so hash the complete source state. */
async function legacySourceFingerprint(sourceRoot: string): Promise<string> {
  const entries: Record<string, string> = {};
  for (const name of ["workspace.sqlite", "workspace.sqlite-wal", "workspace.sqlite-shm", "workspace.sqlite-journal"]) {
    const file = path.join(sourceRoot, name);
    const info = await lstat(file).catch(() => undefined);
    if (!info) continue;
    if (!info.isFile()) throw new WorkspaceServerError("legacy_sqlite_source_file_type_invalid", 400);
    entries[name] = hashBytes(await readFile(file));
  }
  return hashText(canonicalJson(entries));
}

async function copyDirectory(
  source: string,
  destination: string,
  relative: string,
  metadata: Array<Record<string, unknown>>,
  workspaceId: string,
  roomId: string,
  ownerAccountId: string,
  now: string
): Promise<void> {
  await mkdir(destination, { recursive: true, mode: 0o700 });
  for (const name of (await readdir(source)).sort()) {
    const sourceChild = path.join(source, name);
    const targetChild = path.join(destination, name);
    const childRelative = `${relative}/${name}`;
    const info = await lstat(sourceChild);
    if (info.isDirectory()) {
      await copyDirectory(sourceChild, targetChild, childRelative, metadata, workspaceId, roomId, ownerAccountId, now);
      continue;
    }
    if (!info.isFile()) throw new WorkspaceServerError("legacy_workspace_file_type_invalid", 400);
    assertSafeRelativePath(childRelative);
    const content = await readFile(sourceChild);
    assertCredentialFreeWorkspaceFile(`files/${childRelative}`, content);
    await copyFile(sourceChild, targetChild, 0);
    metadata.push({
      workspace_id: workspaceId,
      room_id: roomId,
      path: childRelative,
      version: 1,
      sha256: hashBytes(content),
      size: content.byteLength,
      created_by: ownerAccountId,
      updated_by: ownerAccountId,
      created_at: now,
      updated_at: now
    });
  }
}

async function writeJsonl(destination: string, file: string, rows: readonly unknown[]): Promise<void> {
  const text = rows.map((row) => canonicalJson(row)).join("\n") + (rows.length ? "\n" : "");
  await writeFile(path.join(destination, file), text, { flag: "wx", mode: 0o600 });
}

async function hashTree(root: string): Promise<Record<string, string>> {
  const files = await listFiles(root);
  const hashes: Record<string, string> = {};
  for (const file of files) {
    if (file === "manifest.json") continue;
    hashes[file] = hashBytes(await readFile(path.join(root, ...file.split("/"))));
  }
  return Object.fromEntries(Object.entries(hashes).sort(([left], [right]) => left.localeCompare(right)));
}

async function listFiles(root: string, prefix = ""): Promise<string[]> {
  const output: string[] = [];
  for (const name of (await readdir(path.join(root, ...prefix.split("/").filter(Boolean)))).sort()) {
    const relative = prefix ? `${prefix}/${name}` : name;
    const full = path.join(root, ...relative.split("/"));
    const info = await lstat(full);
    if (info.isDirectory()) output.push(...await listFiles(root, relative));
    else if (info.isFile()) output.push(relative);
    else throw new WorkspaceServerError("workspace_bundle_v3_file_type_invalid", 400);
  }
  return output;
}

function normalizeLegacyTimestamp(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : fallback;
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hashBytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
