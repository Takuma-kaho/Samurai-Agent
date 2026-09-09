import { createHash, createHmac } from "node:crypto";
import { assertOpaqueId, assertSafeRelativePath } from "./config";
import { assertAccountIdMatchesPublicKey, canonicalJson } from "./auth";
import { WorkspaceServerError } from "./errors";
import { PostgresWorkspaceDatabase, type WorkspaceSql } from "./postgres";
import type {
  WorkspaceAccount,
  AttachWorkspaceToOrganizationInput,
  WorkspaceAgent,
  WorkspaceAgentRoomPermission,
  WorkspaceAuditEntry,
  WorkspaceConnectionDescriptor,
  WorkspaceConnectionStatus,
  WorkspaceEvent,
  WorkspaceExternalRoomAction,
  WorkspaceExternalRoomPrincipal,
  WorkspaceInvitation,
  WorkspaceJob,
  WorkspaceMembershipRole,
  WorkspaceMembershipChangeResult,
  WorkspaceMembership,
  Organization,
  OrganizationInvitation,
  OrganizationInvitationAcceptResult,
  OrganizationInvitationCreateResult,
  OrganizationInvitationWorkspaceGrant,
  OrganizationMembership,
  OrganizationRole,
  OrganizationRequestContext,
  OrganizationWorkspaceMovePreview,
  OrganizationWorkspaceMoveResult,
  OrganizationWorkspaceMembership,
  OrganizationWorkspaceSummary,
  DetachWorkspaceFromOrganizationInput,
  WorkspaceOrganizationAssociationResult,
  WorkspaceRecord,
  WorkspaceRecordPayload,
  WorkspacePublicEvent,
  WorkspacePublicEventPage,
  WorkspaceRequestContext,
  WorkspaceRoom,
  WorkspaceRoomDefaultAgent,
  WorkspaceRoomKind,
  WorkspaceRoomCreateResult,
  WorkspaceAgentDm,
  WorkspaceHumanWork,
  WorkspaceHumanWorkAssignment,
  WorkspaceHumanWorkAssignmentStatus,
  WorkspaceHumanWorkComment,
  WorkspaceHumanWorkControl,
  WorkspaceHumanWorkControlAction,
  WorkspaceHumanWorkControlState,
  WorkspaceHumanWorkCreateResult,
  WorkspaceHumanWorkInstruction,
  WorkspaceHumanWorkInstructionSource,
  WorkspaceHumanWorkInstructionState,
  WorkspaceHumanWorkLegacySession,
  WorkspaceHumanWorkLaunchReservation,
  WorkspaceHumanWorkLaunchReservationStatus,
  WorkspaceHumanWorkReaction,
  WorkspaceHumanWorkStatus,
  WorkspaceHumanWorkStopState,
  WorkspaceHumanWorkView,
  WorkspaceFileResourceRef,
  WorkspaceRoomMemberChangePreview,
  WorkspaceRoomMemberChangeResult,
  WorkspaceRoomMembership,
  WorkspaceRoomMovePreview,
  WorkspaceRoomMoveResult,
  WorkspaceServerMode,
  WorkspaceState,
  WorkspaceSummary
} from "./types";
import { ResourceRefSchema, WorkspaceFileResourceRefSchema, type ResourceRef } from "@samurai-agent/core-schemas";

const roleSet = new Set<WorkspaceMembershipRole>(["owner", "admin", "member", "guest"]);
const workspaceHumanWorkStatusSet = new Set<WorkspaceHumanWorkStatus>(["queued", "running", "waiting", "blocked", "completed", "failed", "cancelled"]);
const recordTypePattern = /^[a-z][a-z0-9_]{0,63}$/;
const maxSearchTextLength = 500_000;
type RoomWorkResourceRef = RoomWorkResourceRefInput & { kind: "knowledge" | "skill"; version: string };

export interface WorkspaceServerStoreOptions {
  database: PostgresWorkspaceDatabase;
  mode: WorkspaceServerMode;
  selfHostWorkspaceId?: string;
  /** The locally configured owner is the only Account that may restore an empty Self-host server. */
  selfHostInitialAdminId?: string;
  storageRoot: string;
  invitationTokenSecret: string;
}

export interface CreateWorkspaceInput {
  id?: string;
  name: string;
  ownerAccountId: string;
  operationId: string;
  hostingMode?: WorkspaceServerMode;
  databasePlacement?: "shared" | "dedicated";
  /** Optional same-Server Organization association. Omit for a standalone Workspace. */
  organizationId?: string;
}

export interface CreateOrganizationInput {
  id?: string;
  name: string;
  icon?: string;
  description?: string;
  accountId: string;
  operationId: string;
}

export interface PatchOrganizationInput {
  name?: string;
  icon?: string | null;
  description?: string | null;
  expectedVersion?: number;
}

export interface ChangeOrganizationMemberRoleInput {
  accountId: string;
  role: OrganizationRole;
  expectedVersion?: number;
}

export interface InviteOrganizationMemberInput {
  targetAccountId?: string;
  target_account_id?: string;
  role: OrganizationRole;
  expiresAt?: string;
  expires_at?: string;
  workspaceGrants?: Array<{
    workspaceId?: string;
    workspace_id?: string;
    workspaceRole?: Exclude<WorkspaceMembershipRole, "owner">;
    role?: Exclude<WorkspaceMembershipRole, "owner">;
    roomId?: string;
    roomRole?: WorkspaceMembershipRole;
  }>;
  workspace_grants?: InviteOrganizationMemberInput["workspaceGrants"];
}

export interface OrganizationWorkspaceMoveInput {
  /** Omit for an attach from the standalone state. */
  sourceOrganizationId?: string;
  /** Omit for a detach to the standalone state. */
  targetOrganizationId?: string;
  workspaceId: string;
  expectedWorkspaceVersion?: number;
  /** A commit must explicitly acknowledge automatic Guest memberships. */
  confirmGuestMemberships?: boolean;
}

export interface PutRecordInput {
  roomId: string;
  recordType: string;
  id: string;
  expectedVersion: number;
  payload: WorkspaceRecordPayload;
  searchText?: string;
}

export interface PutRecordResult {
  record: WorkspaceRecord;
  event: WorkspaceEvent;
  replayed: boolean;
}

export interface PutJobResult {
  job: WorkspaceJob;
  event: WorkspaceEvent;
  replayed: boolean;
}

export interface AppendPublicEventInput {
  eventId?: string;
  eventType: string;
  eventVersion?: string;
  roomId?: string;
  organizationId?: string;
  actor: WorkspacePublicEvent["actor"];
  resources?: ResourceRef[];
  operationId?: string;
  correlationId?: string;
  /** The already-authorized state change that produced this notification. */
  authorizationAction?: "edit" | "execute";
  payload: WorkspaceRecordPayload;
}

/** The durable value of an idempotent operation plus whether this call is a replay. */
export interface IdempotentOperationResult<T> {
  value: T;
  replayed: boolean;
}

type IdempotentOperationOptions = {
  lockRoomHierarchy?: boolean;
  /** Internal transfer-only escape hatch for a failed operation replay. */
  allowFailedTransferReplay?: boolean;
};

// Failed operation replay is deliberately narrower than the transfer action
// namespace.  In particular, export is an implementation detail of begin and
// must not become a second public replay lane with its own idempotency rules.
const transferReplayActions = new Set([
  "workspace.transfer.begin",
  "workspace.transfer.receipt",
  "workspace.transfer.complete",
  "workspace.transfer.rollback"
]);

function isTransferReplayAction(action: string): boolean {
  return transferReplayActions.has(action);
}

function transferIdFromInput(input: unknown): string | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const transferId = (input as Record<string, unknown>).transferId;
  return typeof transferId === "string" && transferId.length > 0 ? transferId : undefined;
}

export interface CreateInvitationResult {
  invitation: WorkspaceInvitation;
  token: string;
}

export interface SetWorkspaceMemberInput {
  accountId: string;
  role: WorkspaceMembershipRole;
  state: "active" | "revoked";
  /** Use 0 when this Account has no membership row yet. */
  expectedVersion: number;
}

export interface SetRoomMemberInput extends SetWorkspaceMemberInput {
  roomId: string;
}

export interface RegisterWorkspaceAgentInput {
  id?: string;
  displayName: string;
  description?: string;
  role?: string;
  instructions?: string;
  enabled?: boolean;
  backendId?: string;
}

export interface SetWorkspaceAgentRoomPermissionInput {
  roomId: string;
  agentId: string;
  canView: boolean;
  canEdit: boolean;
  canExecute: boolean;
  expectedVersion: number;
}

/** Revokes all Room-local Agent capabilities while retaining the permission
 * row and audit history. In-progress assignments are not rewritten. */
export interface RemoveWorkspaceAgentRoomPermissionInput {
  roomId: string;
  agentId: string;
}

/** The three Room-local capabilities that can be granted to an Agent. */
export interface CreateWorkspaceRoomAgentPermissionInput {
  canView: boolean;
  canEdit: boolean;
  canExecute: boolean;
}

/** Optional Agent profile created together with a new Room. */
export interface CreateWorkspaceRoomAgentInput {
  /** Internal callers may supply a stable id; the public operation normally omits it. */
  id?: string;
  name: string;
  role: string;
  instructions: string;
  backendId: string;
  enabled?: boolean;
  permission?: CreateWorkspaceRoomAgentPermissionInput;
}

export interface CreateWorkspaceRoomInput {
  id?: string;
  name: string;
  parentRoomId?: string;
  /**
   * Legacy callers may provide an explicit optimistic version. The public
   * Domain API omits it: the Store resolves the current version inside the
   * idempotent transaction so it never becomes part of the replay hash.
   */
  expectedWorkspaceVersion?: number;
  defaultAgentId?: string;
  defaultAgentVersion?: number;
  kind?: WorkspaceRoomKind;
  /** Only Agent DM creation may set this, and it must equal the caller. */
  dmAccountId?: string;
  /** Create this Agent before the Room and use it as the Room default. */
  newAgent?: CreateWorkspaceRoomAgentInput;
  /** Permission for the selected/default Agent, applied in the same transaction. */
  agentPermission?: CreateWorkspaceRoomAgentPermissionInput;
}

export interface SetRoomDefaultAgentInput {
  roomId: string;
  /** `null` clears a normal Room default; Agent DM defaults are immutable. */
  agentId: string | null;
  expectedVersion?: number;
}

export interface OpenAgentDmInput {
  agentId: string;
}

/**
 * A Room Work ResourceRef is intentionally narrower than the public generic
 * ResourceRef.  URI and label are checked against the server-owned
 * Completion row before persistence; callers cannot use them to select an
 * arbitrary file or cross-Room resource.
 */
export interface RoomWorkResourceRefInput {
  kind: "knowledge" | "skill";
  id: string;
  uri: string;
  version?: string;
  label?: string;
}

export interface CreateRoomWorkInput {
  roomId: string;
  instruction?: string;
  attachments?: WorkspaceFileResourceRef[];
  /** Server-owned Knowledge/Skill references resolved again inside the Store transaction. */
  resourceRefs?: RoomWorkResourceRefInput[];
  /** Optional explicit Agent. Omitted means the persisted Room default. */
  agentId?: string;
  title?: string;
  objective?: string;
  completionCriteria?: unknown[];
  scheduledAt?: string;
}

/**
 * Compatibility-only input for the retired Runtime Session path.  The
 * session identifier is used only to resolve the internal bridge row; it is
 * intentionally absent from all WorkspaceHumanWork DTOs.
 */
export interface MigrateLegacyChatTurnInput {
  roomId: string;
  sessionId: string;
  instruction: string;
  attachments?: WorkspaceFileResourceRef[];
  agentId?: string;
}

export type MigrateLegacyChatTurnValue =
  | { mode: "create"; work: WorkspaceHumanWork; launchReservation: WorkspaceHumanWorkLaunchReservation }
  | { mode: "reply"; instruction: WorkspaceHumanWorkInstruction };

export interface ListRoomWorksInput {
  roomId: string;
  status?: WorkspaceHumanWorkStatus;
  cursor?: string;
  limit?: number;
}

export interface ReplyToRoomWorkInput {
  roomId: string;
  workId: string;
  assigneeId?: string;
  instruction?: string;
  attachments?: WorkspaceFileResourceRef[];
  /** Server-owned Knowledge/Skill references resolved again inside the Store transaction. */
  resourceRefs?: RoomWorkResourceRefInput[];
  expectedVersion?: number;
  expectedGeneration?: number;
}

export interface CreateRoomWorkCommentInput {
  roomId: string;
  workId: string;
  body?: string;
  attachments?: WorkspaceFileResourceRef[];
  expectedVersion?: number;
}

export interface SetRoomWorkCommentReactionInput {
  roomId: string;
  workId: string;
  commentId: string;
  reaction: "like";
  enabled: boolean;
  expectedVersion?: number;
}

export interface ApplyRoomWorkCommentInput {
  roomId: string;
  workId: string;
  commentId: string;
  commentVersion: number;
  assigneeId?: string;
  expectedVersion?: number;
  expectedGeneration?: number;
}

export interface StopRoomWorkInput {
  roomId: string;
  workId: string;
  reason?: string;
  expectedVersion?: number;
  expectedGeneration?: number;
}

export interface StopRoomWorkAssigneeInput extends StopRoomWorkInput {
  assigneeId: string;
}

export interface ReassignRoomWorkAssigneeInput {
  roomId: string;
  workId: string;
  assigneeId: string;
  agentId: string;
  instruction?: string;
  expectedVersion?: number;
  expectedGeneration?: number;
}

export interface DelegateRoomWorkAssigneeInput {
  roomId: string;
  workId: string;
  assigneeId: string;
  agentId: string;
  instruction: string;
  dependencyAssigneeIds?: string[];
  attachments?: ResourceRef[];
  expectedVersion?: number;
  expectedGeneration?: number;
}

/**
 * Server-internal delegation input.  Unlike the public Domain Operation this
 * shape carries only the admitted Runtime Run; SQL derives Work, Room,
 * parent Assignment, requester, Agent, Backend, Session and generation from
 * that trusted binding.
 */
export interface DelegateRoomWorkAssigneeFromRuntimeInput {
  parentRunId: string;
  agentId: string;
  instruction: string;
  dependencyAssigneeIds?: string[];
  attachments?: ResourceRef[];
  expectedGeneration: number;
}

export interface ClaimRoomWorkReservationInput {
  workerId: string;
  leaseMs: number;
  now?: string;
  limit?: number;
  reservationId?: string;
}

export interface SettleRoomWorkAssignmentInput {
  workId?: string;
  assigneeId?: string;
  assignmentId?: string;
  /** The claimed reservation and lease owner are required for a safe settle. */
  reservationId: string;
  leaseOwner: string;
  generation: number;
  status: "completed" | "failed" | "cancelled" | "waiting" | "blocked" | "outcome_unknown";
  result?: WorkspaceRecordPayload;
  runId?: string;
  outputSummary?: string;
  errorCode?: string;
  errorMessage?: string;
  now?: string;
}

export interface UpsertWorkspaceConnectionDescriptorInput {
  id?: string;
  agentId?: string;
  principalAccountId: string;
  connectorId: string;
  appId: string;
  status: WorkspaceConnectionStatus;
  expiresAt: string;
  revokedAt?: string;
  allowedRoomIds?: string[];
  roomLimit?: number;
  ingressClasses?: string[];
  expectedVersion: number;
}

/**
 * PostgreSQL-backed Workspace data service. It deliberately stores every
 * Workspace-owned datum with a Workspace and Room boundary; runtime clients
 * receive only this service, not an unrestricted database connection.
 */
export class WorkspaceServerStore {
  readonly database: PostgresWorkspaceDatabase;
  readonly mode: WorkspaceServerMode;
  readonly selfHostWorkspaceId?: string;
  readonly selfHostInitialAdminId?: string;
  readonly storageRoot: string;
  private readonly invitationTokenSecret: string;

  constructor(options: WorkspaceServerStoreOptions) {
    this.database = options.database;
    this.mode = options.mode;
    this.selfHostWorkspaceId = options.selfHostWorkspaceId;
    this.selfHostInitialAdminId = options.selfHostInitialAdminId;
    this.storageRoot = options.storageRoot;
    this.invitationTokenSecret = options.invitationTokenSecret;
  }

  assertSelfHostInitialAdmin(accountId: string): void {
    if (this.mode !== "self_host") return;
    if (!this.selfHostInitialAdminId || accountId !== this.selfHostInitialAdminId) {
      throw new WorkspaceServerError("self_host_initial_admin_required", 403);
    }
  }

  async registerAccount(input: { id: string; publicKey: string; displayName: string }): Promise<WorkspaceAccount> {
    assertOpaqueId(input.id, "account_id_invalid");
    if (!input.publicKey.trim()) throw new WorkspaceServerError("account_public_key_required", 400);
    if (!input.displayName.trim()) throw new WorkspaceServerError("account_display_name_required", 400);
    assertAccountIdMatchesPublicKey(input.id, input.publicKey);
    return this.database.withContext({ accountId: input.id }, async (sql) => {
      await sql.query(
        `INSERT INTO accounts(id, public_key, display_name)
         VALUES ($1, $2, $3)
         ON CONFLICT (id) DO NOTHING`,
        [input.id, input.publicKey, input.displayName.trim()]
      );
      const result = await sql.query<AccountRow>(
        "SELECT id, public_key, display_name, created_at, updated_at FROM accounts WHERE id = $1",
        [input.id]
      );
      const account = result.rows[0];
      if (!account) throw new WorkspaceServerError("account_registration_failed", 500);
      if (account.public_key !== input.publicKey) throw new WorkspaceServerError("account_public_key_conflict", 409);
      let savedAccount: WorkspaceAccount;
      if (account.display_name !== input.displayName.trim()) {
        const updated = await sql.query<AccountRow>(
          `UPDATE accounts SET display_name = $2, updated_at = NOW()
           WHERE id = $1
           RETURNING id, public_key, display_name, created_at, updated_at`,
          [input.id, input.displayName.trim()]
        );
        savedAccount = accountFromRow(updated.rows[0] ?? account);
      } else {
        savedAccount = accountFromRow(account);
      }
      return savedAccount;
    });
  }

  async getAccountPublicKey(accountId: string): Promise<string | undefined> {
    assertOpaqueId(accountId, "account_id_invalid");
    return this.database.withContext({ accountId }, async (sql) => {
      const result = await sql.query<{ public_key: string }>("SELECT public_key FROM accounts WHERE id = $1 AND status = 'active'", [accountId]);
      return result.rows[0]?.public_key;
    });
  }

  async ensureInitialSelfHostedWorkspace(input: {
    workspaceId: string;
    ownerAccountId: string;
    ownerPublicKey: string;
    ownerDisplayName: string;
    workspaceName?: string;
  }): Promise<{ created: boolean; workspaceId: string; roomId?: string }> {
    if (this.mode !== "self_host" || this.selfHostWorkspaceId !== input.workspaceId) {
      throw new WorkspaceServerError("self_host_workspace_mismatch", 400);
    }
    await this.registerAccount({ id: input.ownerAccountId, publicKey: input.ownerPublicKey, displayName: input.ownerDisplayName });
    const operationId = operationScopedId("selfhost_bootstrap", input.workspaceId, input.ownerAccountId);
    try {
      const created = await this.createWorkspace({
        id: input.workspaceId,
        name: input.workspaceName?.trim() || "Samurai Workspace",
        ownerAccountId: input.ownerAccountId,
        operationId,
        hostingMode: "self_host",
        databasePlacement: "dedicated"
      });
      return { created: true, workspaceId: created.workspace.id, roomId: created.defaultRoom.id };
    } catch (error) {
      if (!(error instanceof WorkspaceServerError) || error.code !== "workspace_id_conflict") throw error;
      await this.getWorkspace({ workspaceId: input.workspaceId, accountId: input.ownerAccountId });
      return { created: false, workspaceId: input.workspaceId };
    }
  }

  /** Organization metadata query. It intentionally does not require a Workspace context. */
  async listOrganizations(context: OrganizationRequestContext, _input: { cursor?: string; limit?: number } = {}): Promise<Organization[]> {
    assertOpaqueId(context.accountId, "account_id_invalid");
    return this.database.withContext({ accountId: context.accountId }, async (sql) => {
      const result = await sql.query<OrganizationRow>(
        `SELECT organization.id, organization.name, organization.icon, organization.description,
                organization.created_by, organization.version, organization.created_at,
                organization.updated_at, organization.deleted_at
           FROM organizations organization
           JOIN organization_members member ON member.organization_id = organization.id
          WHERE member.account_id = $1 AND member.state = 'active' AND organization.deleted_at IS NULL
          ORDER BY organization.updated_at DESC, organization.id`,
        [context.accountId]
      );
      return result.rows.map(organizationFromRow);
    });
  }

  async viewOrganization(context: OrganizationRequestContext, organizationId: string): Promise<Organization> {
    const id = organizationIdFrom(context, organizationId);
    return this.database.withContext({ accountId: context.accountId }, async (sql) => {
      const row = (await sql.query<OrganizationRow>(
        `SELECT id, name, icon, description, created_by, version, created_at, updated_at, deleted_at
           FROM organizations WHERE id = $1 AND deleted_at IS NULL`, [id]
      )).rows[0];
      if (!row) throw new WorkspaceServerError("organization_not_found", 404);
      return organizationFromRow(row);
    });
  }

  async createOrganization(
    context: OrganizationRequestContext,
    input: Omit<CreateOrganizationInput, "accountId" | "operationId"> & { id?: string }
  ): Promise<Organization> {
    assertOpaqueId(context.accountId, "account_id_invalid");
    assertOpaqueId(context.operationId, "organization_operation_id_invalid");
    const name = input.name.trim();
    if (!name || name.length > 200) throw new WorkspaceServerError("organization_name_required", 400);
    const id = input.id?.trim() || operationScopedId("organization", context.accountId, context.operationId);
    assertOpaqueId(id, "organization_id_invalid");
    const result = await this.runOrganizationIdempotentResult(context, undefined, {
      action: "organization.create",
      input: { id, name, icon: input.icon ?? null, description: input.description ?? null }
    }, async (sql) => {
      try {
        await sql.query("SELECT samurai_create_organization($1, $2, $3, $4, $5)", [
          id, name, input.icon ?? null, input.description ?? null, context.operationId
        ]);
      } catch (error) {
        if (postgresMessage(error).includes("organization_id_conflict")) throw new WorkspaceServerError("organization_id_conflict", 409);
        throw error;
      }
      const row = (await sql.query<OrganizationRow>(
        "SELECT id, name, icon, description, created_by, version, created_at, updated_at, deleted_at FROM organizations WHERE id = $1",
        [id]
      )).rows[0];
      if (!row) throw new WorkspaceServerError("organization_creation_failed", 500);
      return organizationFromRow(row);
    });
    return { ...result.value, replayed: result.replayed };
  }

  async patchOrganization(
    context: OrganizationRequestContext,
    input: PatchOrganizationInput & { organizationId?: string; organization_id?: string; expected_version?: number }
  ): Promise<Organization> {
    const id = organizationIdFrom(context, input.organizationId ?? input.organization_id);
    const suppliedExpectedVersion = input.expectedVersion ?? input.expected_version;
    if (suppliedExpectedVersion !== undefined) assertExpectedVersion(suppliedExpectedVersion, "organization_expected_version_invalid", 1);
    if (input.name !== undefined && (!input.name.trim() || input.name.trim().length > 200)) {
      throw new WorkspaceServerError("organization_name_required", 400);
    }
    const result = await this.runOrganizationIdempotentResult(context, id, {
      action: "organization.patch",
      input: {
        id,
        name: input.name ?? null,
        icon: input.icon,
        description: input.description,
        expectedVersion: suppliedExpectedVersion ?? null
      }
    }, async (sql) => {
      const current = (await sql.query<OrganizationRow>(
        `SELECT id, name, icon, description, created_by, version, created_at, updated_at, deleted_at
           FROM organizations WHERE id = $1 AND deleted_at IS NULL`, [id]
      )).rows[0];
      if (!current) throw new WorkspaceServerError("organization_not_found", 404);
      const expectedVersion = suppliedExpectedVersion ?? Number(current.version);
      const name = input.name === undefined ? current.name : input.name.trim();
      // null is an explicit clear operation; undefined retains the current
      // value. The SQL function uses NULL as its compatibility "unchanged"
      // marker, so an explicit clear is represented by an empty string.
      const icon = input.icon === undefined ? null : input.icon ?? "";
      const description = input.description === undefined ? null : input.description ?? "";
      try {
        await sql.query("SELECT samurai_patch_organization($1, $2, $3, $4, $5, $6)", [id, name, icon, description, expectedVersion, context.operationId]);
      } catch (error) {
        throw mapOrganizationPostgresError(error, "organization_patch_failed");
      }
      const row = (await sql.query<OrganizationRow>(
        "SELECT id, name, icon, description, created_by, version, created_at, updated_at, deleted_at FROM organizations WHERE id = $1",
        [id]
      )).rows[0];
      if (!row) throw new WorkspaceServerError("organization_not_found", 404);
      return organizationFromRow(row);
    });
    return { ...result.value, replayed: result.replayed };
  }

  async deleteOrganization(
    context: OrganizationRequestContext,
    input: { organizationId?: string; organization_id?: string; expectedVersion?: number; expected_version?: number; confirm?: true }
  ): Promise<Organization> {
    const id = organizationIdFrom(context, input.organizationId ?? input.organization_id);
    const suppliedExpectedVersion = input.expectedVersion ?? input.expected_version;
    if (suppliedExpectedVersion !== undefined) assertExpectedVersion(suppliedExpectedVersion, "organization_expected_version_invalid", 1);
    const result = await this.runOrganizationIdempotentResult(context, id, { action: "organization.delete", input: { id, confirm: input.confirm ?? true, expectedVersion: suppliedExpectedVersion ?? null } }, async (sql) => {
      const current = (await sql.query<{ version: number | string }>(
        // Organization RLS has a read policy but no general UPDATE policy.
        // Keep this preflight read non-locking; the SECURITY DEFINER delete
        // function owns the authoritative Organization row lock and version
        // check in the same transaction.
        "SELECT version FROM organizations WHERE id = $1 AND deleted_at IS NULL", [id]
      )).rows[0];
      if (!current) throw new WorkspaceServerError("organization_not_found", 404);
      if (suppliedExpectedVersion !== undefined && Number(current.version) !== suppliedExpectedVersion) {
        throw new WorkspaceServerError("organization_version_conflict", 409);
      }
      const expectedVersion = suppliedExpectedVersion ?? Number(current.version);
      try {
        const deleted = (await sql.query<OrganizationRow>(
          `SELECT id, name, icon, description, created_by, version, created_at, updated_at, deleted_at
             FROM samurai_delete_organization_and_return($1, $2, $3)`,
          [id, expectedVersion, context.operationId]
        )).rows[0];
        if (!deleted) throw new WorkspaceServerError("organization_delete_result_not_found", 500);
        return organizationFromRow(deleted);
      } catch (error) {
        throw mapOrganizationPostgresError(error, "organization_delete_failed");
      }
    });
    return { ...result.value, replayed: result.replayed };
  }

  async listOrganizationMembers(
    context: OrganizationRequestContext,
    input: { organizationId?: string; organization_id?: string; includeRemoved?: boolean; include_removed?: boolean; limit?: number } = {}
  ): Promise<OrganizationMembership[]> {
    const id = organizationIdFrom(context, input.organizationId ?? input.organization_id);
    return this.database.withContext({ accountId: context.accountId }, async (sql) => {
      const includeRemoved = input.includeRemoved ?? input.include_removed ?? false;
      const result = await sql.query<OrganizationMembershipRow>(
        `SELECT member.organization_id, member.account_id, member.role, member.state, member.version,
                member.joined_at, member.removed_at, member.created_by, member.updated_by
           FROM organization_members member
          WHERE member.organization_id = $1 AND ($2::BOOLEAN OR member.state = 'active')
          ORDER BY member.joined_at, member.account_id`, [id, includeRemoved]
      );
      return result.rows.map(organizationMembershipFromRow);
    });
  }

  async changeOrganizationMemberRole(
    context: OrganizationRequestContext,
    input: ChangeOrganizationMemberRoleInput & { organizationId?: string; organization_id?: string; target_account_id?: string; expected_version?: number }
  ): Promise<OrganizationMembership> {
    return this.setOrganizationMember(context, input, "active");
  }

  async removeOrganizationMember(
    context: OrganizationRequestContext,
    input: { organizationId?: string; organization_id?: string; accountId?: string; target_account_id?: string; expectedVersion?: number; expected_version?: number }
  ): Promise<OrganizationMembership> {
    const id = organizationIdFrom(context, input.organizationId ?? input.organization_id);
    const accountId = assertOpaqueId(input.accountId ?? input.target_account_id ?? "", "account_id_invalid");
    return this.setOrganizationMember(context, { organizationId: id, accountId, expectedVersion: input.expectedVersion ?? input.expected_version }, "removed");
  }

  async leaveOrganization(
    context: OrganizationRequestContext,
    input: { organizationId?: string; organization_id?: string; expectedVersion?: number; expected_version?: number } = {}
  ): Promise<OrganizationMembership> {
    const id = organizationIdFrom(context, input.organizationId ?? input.organization_id);
    return this.setOrganizationMember(context, { organizationId: id, accountId: context.accountId, expectedVersion: input.expectedVersion ?? input.expected_version }, "removed");
  }

  async inviteOrganizationMember(
    context: OrganizationRequestContext,
    input: InviteOrganizationMemberInput & { organizationId?: string; organization_id?: string; workspace_grants?: InviteOrganizationMemberInput["workspaceGrants"] }
  ): Promise<OrganizationInvitationCreateResult> {
    const id = organizationIdFrom(context, input.organizationId ?? input.organization_id);
    assertOrganizationRole(input.role);
    const suppliedExpiresAt = input.expiresAt ?? input.expires_at;
    if (suppliedExpiresAt !== undefined) {
      const parsedExpiresAt = new Date(suppliedExpiresAt);
      if (!Number.isFinite(parsedExpiresAt.getTime()) || parsedExpiresAt.getTime() <= Date.now()) throw new WorkspaceServerError("organization_invitation_expiry_invalid", 400);
    }
    const token = organizationInvitationToken(this.invitationTokenSecret, context, id);
    const invitationId = operationScopedId("organization_invitation", id, context.operationId);
    const grants = (input.workspaceGrants ?? input.workspace_grants ?? []).map((grant) => {
      const workspaceId = grant.workspaceId ?? grant.workspace_id;
      const workspaceRole = grant.workspaceRole ?? grant.role;
      assertOpaqueId(workspaceId ?? "", "workspace_id_invalid");
      if (!workspaceRole) throw new WorkspaceServerError("organization_invitation_workspace_grant_invalid", 400);
      assertRole(workspaceRole);
      return {
        workspace_id: workspaceId,
        workspace_role: workspaceRole,
        ...(grant.roomId ? { room_id: grant.roomId } : {}),
        ...(grant.roomRole ? { room_role: grant.roomRole } : {})
      };
    });
    const targetAccountId = input.targetAccountId ?? input.target_account_id;
    const result = await this.runOrganizationIdempotentResult(context, id, {
      action: "organization.member.invite",
      input: { id, invitationId, targetAccountId: targetAccountId ?? null, role: input.role, expiresAt: suppliedExpiresAt ?? null, grants }
    }, async (sql) => {
      const expiresAt = new Date(String(suppliedExpiresAt ?? Date.now() + 30 * 24 * 60 * 60 * 1000));
      if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) throw new WorkspaceServerError("organization_invitation_expiry_invalid", 400);
      try {
        await sql.query("SELECT samurai_create_organization_invitation($1, $2, $3, $4, $5, $6, $7, $8::JSONB)", [
          id, invitationId, targetAccountId ?? null, invitationTokenHash(this.invitationTokenSecret, token), input.role,
          expiresAt.toISOString(), context.operationId, canonicalJson(grants)
        ]);
      } catch (error) {
        throw mapOrganizationPostgresError(error, "organization_invitation_create_failed");
      }
      const invitation = await this.selectOrganizationInvitation(sql, id, invitationId);
      if (!invitation) throw new WorkspaceServerError("organization_invitation_creation_failed", 500);
      return { invitation, token, replayed: false };
    });
    // `runOrganizationIdempotentResult` serializes the complete result. Token
    // material exists only in this response and in the operation result held
    // for the same request; it is never included in an Event or invitation row.
    return { ...result.value, replayed: result.replayed };
  }

  async acceptOrganizationInvitation(
    context: OrganizationRequestContext,
    input: { token: string; organizationId?: string; organization_id?: string }
  ): Promise<OrganizationInvitationAcceptResult> {
    if (!input.token || input.token.length > 2_048) throw new WorkspaceServerError("organization_invitation_invalid", 400);
    const id = input.organizationId ?? input.organization_id ?? context.organizationId;
    if (id !== undefined) assertOpaqueId(id, "organization_id_invalid");
    const tokenHash = invitationTokenHash(this.invitationTokenSecret, input.token);
    const result = await this.runOrganizationIdempotentResult(context, id, { action: "organization.member.accept", input: { organizationId: id, tokenHash } }, async (sql) => {
      try {
        const row = (await sql.query<{ result: unknown }>(
          id === undefined
            ? "SELECT samurai_accept_organization_invitation($1, $2) AS result"
            : "SELECT samurai_accept_organization_invitation($1, $2, $3) AS result",
          id === undefined ? [tokenHash, context.operationId] : [id, tokenHash, context.operationId]
        )).rows[0];
        if (!row) throw new WorkspaceServerError("organization_invitation_invalid", 400);
        const value = parseJsonObject(row.result);
        const organizationId = String(value.organization_id ?? id ?? "");
        if (!organizationId) throw new WorkspaceServerError("organization_invitation_invalid", 400);
        const accountId = String(value.account_id ?? context.accountId);
        const role = assertOrganizationRoleValue(value.role);
        // Token-only accepts resolve the Organization inside PostgreSQL. Keep
        // that resolved scope on the operation row so retries/status queries
        // remain auditable without ever storing the raw token.
        if (id === undefined) {
          await sql.query(
            "UPDATE organization_operations SET organization_id = $3 WHERE actor_account_id = $1 AND id = $2",
            [context.accountId, context.operationId, organizationId]
          );
        }
        const membershipRow = (await sql.query<OrganizationMembershipRow>(
          `SELECT organization_id, account_id, role, state, version, joined_at, removed_at, created_by, updated_by
             FROM organization_members WHERE organization_id = $1 AND account_id = $2`, [organizationId, accountId]
        )).rows[0];
        if (!membershipRow) throw new WorkspaceServerError("organization_membership_update_failed", 500);
        const grants = organizationInvitationGrantsFromJson(value.workspace_grants);
        const workspaceGrants: OrganizationWorkspaceMembership[] = [];
        for (const grant of grants) {
          const workspaceRow = (await sql.query<MembershipRow>(
            `SELECT workspace_id, account_id, role, state, version, created_at, updated_at, revoked_at
               FROM workspace_members WHERE workspace_id = $1 AND account_id = $2`, [grant.workspaceId, accountId]
          )).rows[0];
          if (workspaceRow) workspaceGrants.push(organizationWorkspaceMembershipFromRow(workspaceRow, organizationId));
        }
        return { organizationId, accountId, role, membership: organizationMembershipFromRow(membershipRow), workspaceGrants, replayed: false };
      } catch (error) {
        throw mapOrganizationPostgresError(error, "organization_invitation_invalid");
      }
    });
    return { ...result.value, replayed: result.replayed };
  }

  async listOrganizationInvitations(
    context: OrganizationRequestContext,
    input: { organizationId?: string; organization_id?: string; includeResolved?: boolean; include_resolved?: boolean } = {}
  ): Promise<OrganizationInvitation[]> {
    const id = organizationIdFrom(context, input.organizationId ?? input.organization_id);
    return this.database.withContext({ accountId: context.accountId }, async (sql) => {
      const includeResolved = input.includeResolved ?? input.include_resolved ?? false;
      const rows = await sql.query<OrganizationInvitationRow>(
        `SELECT id, organization_id, target_account_id, role, version, expires_at, issued_by,
                created_at, updated_at, revoked_at, accepted_by, accepted_at
           FROM organization_invitations
          WHERE organization_id = $1
            AND ($2::BOOLEAN OR (revoked_at IS NULL AND accepted_at IS NULL AND expires_at > NOW()))
          ORDER BY created_at DESC, id`, [id, includeResolved]
      );
      const invitations: OrganizationInvitation[] = [];
      for (const row of rows.rows) {
        const invitation = await this.selectOrganizationInvitation(sql, id, row.id);
        if (invitation) invitations.push(invitation);
      }
      return invitations;
    });
  }

  async revokeOrganizationInvitation(context: OrganizationRequestContext, input: { organizationId?: string; organization_id?: string; invitationId?: string; invitation_id?: string; expectedVersion?: number; expected_version?: number }): Promise<OrganizationInvitation> {
    const id = organizationIdFrom(context, input.organizationId ?? input.organization_id);
    const invitationId = assertOpaqueId(input.invitationId ?? input.invitation_id ?? "", "organization_invitation_id_invalid");
    const suppliedExpectedVersion = input.expectedVersion ?? input.expected_version;
    if (suppliedExpectedVersion !== undefined) assertExpectedVersion(suppliedExpectedVersion, "organization_invitation_expected_version_invalid", 1);
    const result = await this.runOrganizationIdempotentResult(context, id, { action: "organization.invitation.revoke", input: { id, invitationId, expectedVersion: suppliedExpectedVersion ?? null } }, async (sql) => {
      const current = await this.selectOrganizationInvitation(sql, id, invitationId);
      if (!current) throw new WorkspaceServerError("organization_invitation_not_found", 404);
      const expectedVersion = suppliedExpectedVersion ?? current.version;
      try { await sql.query("SELECT samurai_revoke_organization_invitation($1, $2, $3, $4)", [id, invitationId, expectedVersion, context.operationId]); }
      catch (error) { throw mapOrganizationPostgresError(error, "organization_invitation_revoke_failed"); }
      return {};
    });
    const invitation = await this.getOrganizationInvitation(context, id, invitationId);
    return { ...invitation, replayed: result.replayed };
  }

  async extendOrganizationInvitation(context: OrganizationRequestContext, input: { organizationId?: string; organization_id?: string; invitationId?: string; invitation_id?: string; expiresAt?: string; expires_at?: string; expectedVersion?: number; expected_version?: number }): Promise<OrganizationInvitation> {
    const id = organizationIdFrom(context, input.organizationId ?? input.organization_id);
    const invitationId = assertOpaqueId(input.invitationId ?? input.invitation_id ?? "", "organization_invitation_id_invalid");
    const expiresAt = new Date(input.expiresAt ?? input.expires_at ?? "");
    if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) throw new WorkspaceServerError("organization_invitation_expiry_invalid", 400);
    const suppliedExpectedVersion = input.expectedVersion ?? input.expected_version;
    if (suppliedExpectedVersion !== undefined) assertExpectedVersion(suppliedExpectedVersion, "organization_invitation_expected_version_invalid", 1);
    const result = await this.runOrganizationIdempotentResult(context, id, { action: "organization.invitation.extend", input: { id, invitationId, expiresAt: expiresAt.toISOString(), expectedVersion: suppliedExpectedVersion ?? null } }, async (sql) => {
      const current = await this.selectOrganizationInvitation(sql, id, invitationId);
      if (!current) throw new WorkspaceServerError("organization_invitation_not_found", 404);
      const expectedVersion = suppliedExpectedVersion ?? current.version;
      try { await sql.query("SELECT samurai_extend_organization_invitation($1, $2, $3, $4, $5)", [id, invitationId, expiresAt.toISOString(), expectedVersion, context.operationId]); }
      catch (error) { throw mapOrganizationPostgresError(error, "organization_invitation_extend_failed"); }
      return {};
    });
    const invitation = await this.getOrganizationInvitation(context, id, invitationId);
    return { ...invitation, replayed: result.replayed };
  }

  async reissueOrganizationInvitation(context: OrganizationRequestContext, input: { organizationId?: string; organization_id?: string; invitationId?: string; invitation_id?: string; expectedVersion?: number; expected_version?: number }): Promise<OrganizationInvitationCreateResult> {
    const id = organizationIdFrom(context, input.organizationId ?? input.organization_id);
    const invitationId = assertOpaqueId(input.invitationId ?? input.invitation_id ?? "", "organization_invitation_id_invalid");
    const suppliedExpectedVersion = input.expectedVersion ?? input.expected_version;
    if (suppliedExpectedVersion !== undefined) assertExpectedVersion(suppliedExpectedVersion, "organization_invitation_expected_version_invalid", 1);
    const token = organizationInvitationToken(this.invitationTokenSecret, context, id, invitationId);
    const replacementInvitationId = operationScopedId("organization_invitation", id, `${context.operationId}|replacement`);
    const replacementExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const result = await this.runOrganizationIdempotentResult(context, id, { action: "organization.invitation.reissue", input: { id, invitationId, replacementInvitationId, expectedVersion: suppliedExpectedVersion ?? null } }, async (sql) => {
      const current = await this.selectOrganizationInvitation(sql, id, invitationId);
      if (!current) throw new WorkspaceServerError("organization_invitation_not_found", 404);
      const expectedVersion = suppliedExpectedVersion ?? current.version;
      try { await sql.query("SELECT samurai_reissue_organization_invitation($1, $2, $3, $4, $5, $6, $7)", [id, invitationId, replacementInvitationId, invitationTokenHash(this.invitationTokenSecret, token), replacementExpiresAt, expectedVersion, context.operationId]); }
      catch (error) { throw mapOrganizationPostgresError(error, "organization_invitation_reissue_failed"); }
      const invitation = await this.selectOrganizationInvitation(sql, id, replacementInvitationId);
      if (!invitation) throw new WorkspaceServerError("organization_invitation_reissue_failed", 500);
      return { invitation, token, replayed: false };
    });
    return { ...result.value, replayed: result.replayed };
  }

  async listOrganizationWorkspaces(context: OrganizationRequestContext, input: { organizationId?: string; organization_id?: string; includeDeleted?: boolean; include_deleted?: boolean } = {}): Promise<OrganizationWorkspaceSummary[]> {
    const id = organizationIdFrom(context, input.organizationId ?? input.organization_id);
    return this.database.withContext({ accountId: context.accountId }, async (sql) => {
      const includeDeleted = input.includeDeleted ?? input.include_deleted ?? false;
      const result = await sql.query<OrganizationWorkspaceRow>(
        `SELECT workspace.id, workspace.organization_id, workspace.name, workspace.state, workspace.version,
                workspace.created_at, workspace.updated_at, member.role AS workspace_role
           FROM workspaces workspace
           LEFT JOIN workspace_members member ON member.workspace_id = workspace.id
            AND member.account_id = $2 AND member.state = 'active'
          WHERE workspace.organization_id = $1
            AND ($3::BOOLEAN OR workspace.state <> 'deleted')
          ORDER BY workspace.updated_at DESC, workspace.id`, [id, context.accountId, includeDeleted]
      );
      return result.rows.map(organizationWorkspaceFromRow);
    });
  }

  async preflightWorkspaceOrganizationMove(context: OrganizationRequestContext, input: OrganizationWorkspaceMoveInput & { source_organization_id?: string; target_organization_id?: string; workspace_id?: string; expected_workspace_version?: number }): Promise<OrganizationWorkspaceMovePreview> {
    const sourceId = optionalOrganizationId(input.sourceOrganizationId ?? input.source_organization_id, "organization_id_invalid");
    const targetId = optionalOrganizationId(input.targetOrganizationId ?? input.target_organization_id, "organization_id_invalid");
    if (sourceId === undefined && targetId === undefined) throw new WorkspaceServerError("workspace_organization_move_invalid", 400);
    const workspaceId = input.workspaceId ?? input.workspace_id;
    assertOpaqueId(workspaceId ?? "", "workspace_id_invalid");
    const expectedVersion = input.expectedWorkspaceVersion ?? input.expected_workspace_version;
    const ledgerOrganizationId = sourceId ?? targetId;
    const result = await this.runOrganizationIdempotentResult(context, ledgerOrganizationId, {
      action: "workspace.organization.move.preflight",
      input: { sourceId: sourceId ?? null, targetId: targetId ?? null, workspaceId, expectedVersion: expectedVersion ?? null }
    }, async (sql) => {
      const capability = await sql.query<{ workspace_owner: boolean; source_admin: boolean; target_admin: boolean }>(
        `SELECT
           samurai_can_workspace($3, 'owner') AS workspace_owner,
           CASE WHEN $1::TEXT IS NULL THEN false
                ELSE samurai_can_organization($1, 'admin') END AS source_admin,
           CASE WHEN $2::TEXT IS NULL THEN true
                ELSE samurai_can_organization($2, 'admin') END AS target_admin`,
        [sourceId ?? null, targetId ?? null, workspaceId]
      );
      const workspaceOwner = capability.rows[0]?.workspace_owner === true;
      const sourceAdmin = capability.rows[0]?.source_admin === true;
      const targetAdmin = capability.rows[0]?.target_admin === true;
      // Attach requires both sides to approve: the Workspace owner and the
      // target Organization owner/admin. Detach is intentionally more
      // permissive: either the Workspace owner or the source Organization
      // owner/admin may release it. A same-Server Organization move keeps the
      // two Organization-admin checks explicit.
      const sourceAllowed = sourceId === undefined
        ? workspaceOwner
        : targetId === undefined
          ? workspaceOwner || sourceAdmin
          : sourceAdmin;
      const targetAllowed = targetId === undefined ? true : targetAdmin;
      const workspace = (await sql.query<OrganizationWorkspaceRow>(
        `SELECT id, organization_id, name, state, version, created_at, updated_at
           FROM workspaces WHERE id = $1`, [workspaceId]
      )).rows[0];
      if (!workspace) throw new WorkspaceServerError("workspace_not_found", 404);
      const workspaceVersion = Number(workspace.version);
      const workspaceState = workspace.state;
      if (workspaceState === "read_only" || workspaceState === "deleted") {
        throw new WorkspaceServerError("workspace_organization_move_state_invalid", 409);
      }
      const memberRows = await sql.query<OrganizationWorkspaceMoveMemberRow>(
        "SELECT account_id, role AS current_workspace_role, state FROM workspace_members WHERE workspace_id = $1 AND state = 'active' ORDER BY account_id", [workspaceId]
      );
      const targetMembers = targetId
        ? await sql.query<{ account_id: string; role: OrganizationRole }>(
          "SELECT account_id, role FROM organization_members WHERE organization_id = $1 AND state = 'active' ORDER BY account_id", [targetId]
        )
        : { rows: [] as Array<{ account_id: string; role: OrganizationRole }> };
      const targetRoles = new Map(targetMembers.rows.map((row) => [row.account_id, row.role]));
      const members = memberRows.rows.map((row) => ({
        accountId: row.account_id,
        currentWorkspaceRole: row.current_workspace_role,
        state: row.state,
        ...(targetRoles.has(row.account_id) ? { targetOrganizationRole: targetRoles.get(row.account_id) } : {})
      }));
      const missing = targetId
        ? members.filter((member) => !targetRoles.has(member.accountId)).map((member) => member.accountId)
        : [];
      const versionOk = expectedVersion === undefined || workspaceVersion === expectedVersion;
      const stateOk = workspaceState === "active" || workspaceState === "archived";
      const failureConditions: string[] = [];
      if (!sourceAllowed) {
        failureConditions.push(sourceId === undefined
          ? "workspace_owner_permission_required"
          : targetId === undefined
            ? "workspace_owner_or_organization_admin_permission_required"
            : "organization_admin_permission_required");
      }
      if (!targetAllowed) failureConditions.push("target_organization_admin_permission_required");
      if (workspace.organization_id !== (sourceId ?? null)) failureConditions.push("workspace_organization_move_source_mismatch");
      if (sourceId !== undefined && sourceId === targetId) failureConditions.push("workspace_organization_move_invalid");
      if (!versionOk) failureConditions.push("workspace_version_conflict");
      if (!stateOk) failureConditions.push("workspace_organization_move_state_invalid");
      const allowed = failureConditions.length === 0;
      const reason = failureConditions[0];
      const createdAt = new Date().toISOString();
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
      return {
        allowed,
        ...(reason ? { reason } : {}),
        ...(sourceId ? { sourceOrganizationId: sourceId } : {}),
        ...(targetId ? { targetOrganizationId: targetId } : {}),
        workspaceId,
        workspaceName: workspace.name,
        expectedWorkspaceVersion: workspaceVersion,
        sourceOwner: sourceAllowed,
        targetOwner: targetAllowed,
        members,
        missingTargetMemberships: missing,
        requiresGuestConfirmation: missing.length > 0,
        writeFreezeRequired: true,
        operationId: context.operationId,
        workspaceState,
        failureConditions,
        expiresAt,
        createdAt
      };
    });
    return { ...result.value, operationId: result.value.operationId ?? context.operationId };
  }

  async commitWorkspaceOrganizationMove(context: OrganizationRequestContext, input: OrganizationWorkspaceMoveInput & { source_organization_id?: string; target_organization_id?: string; workspace_id?: string; expected_workspace_version?: number; confirm_guest_membership?: boolean; preflight_id?: string }): Promise<OrganizationWorkspaceMoveResult> {
    const sourceId = optionalOrganizationId(input.sourceOrganizationId ?? input.source_organization_id, "organization_id_invalid");
    const targetId = optionalOrganizationId(input.targetOrganizationId ?? input.target_organization_id, "organization_id_invalid");
    if (sourceId === undefined && targetId === undefined) throw new WorkspaceServerError("workspace_organization_move_invalid", 400);
    const workspaceId = input.workspaceId ?? input.workspace_id;
    assertOpaqueId(workspaceId ?? "", "workspace_id_invalid");
    const suppliedExpectedVersion = input.expectedWorkspaceVersion ?? input.expected_workspace_version;
    if (suppliedExpectedVersion !== undefined) assertExpectedVersion(suppliedExpectedVersion, "workspace_expected_version_invalid", 1);
    const preflightId = assertOpaqueId(input.preflight_id ?? "", "workspace_organization_move_preflight_id_invalid");
    const confirm = input.confirmGuestMemberships ?? input.confirm_guest_membership;
    if (confirm !== true) throw new WorkspaceServerError("workspace_organization_move_guest_confirmation_required", 400);
    const ledgerOrganizationId = sourceId ?? targetId;
    const result = await this.runOrganizationIdempotentResult(context, ledgerOrganizationId, { action: "workspace.organization.move.commit", input: { sourceId: sourceId ?? null, targetId: targetId ?? null, workspaceId, expectedVersion: suppliedExpectedVersion ?? null, preflightId } }, async (sql) => {
      const preflightRow = (await sql.query<{ result: unknown; consumed_at: Date | string | null }>(
        `SELECT result, consumed_at
          FROM organization_operations
          WHERE actor_account_id = $1 AND idempotency_key = $2
            AND organization_id = $3 AND status = 'completed'
            AND consumed_at IS NULL AND result IS NOT NULL
          FOR UPDATE`, [context.accountId, preflightId, ledgerOrganizationId]
      )).rows[0];
      if (!preflightRow) throw new WorkspaceServerError("workspace_organization_move_preflight_invalid", 409);
      const preflight = parseJsonObject(preflightRow.result);
      if (preflight.allowed !== true) throw new WorkspaceServerError("workspace_organization_move_preflight_not_allowed", 409);
      const previewSource = String(preflight.sourceOrganizationId ?? preflight.source_organization_id ?? "");
      const previewTarget = String(preflight.targetOrganizationId ?? preflight.target_organization_id ?? "");
      const previewWorkspace = String(preflight.workspaceId ?? preflight.workspace_id ?? "");
      const previewVersion = Number(preflight.expectedWorkspaceVersion ?? preflight.workspace_version);
      const previewExpiresAt = Date.parse(String(preflight.expiresAt ?? preflight.expires_at ?? ""));
      if (previewSource !== (sourceId ?? "") || previewTarget !== (targetId ?? "") || previewWorkspace !== workspaceId || !Number.isInteger(previewVersion) || previewVersion < 1) {
        throw new WorkspaceServerError("workspace_organization_move_preflight_mismatch", 409);
      }
      if (!Number.isFinite(previewExpiresAt) || previewExpiresAt <= Date.now()) {
        throw new WorkspaceServerError("workspace_organization_move_preflight_expired", 409);
      }
      if (suppliedExpectedVersion !== undefined && suppliedExpectedVersion !== previewVersion) {
        throw new WorkspaceServerError("workspace_organization_move_preflight_version_conflict", 409);
      }
      const expectedVersion = previewVersion;
      try {
        const row = (await sql.query<{ result: unknown }>("SELECT samurai_move_workspace_organization($1, $2, $3, $4, $5) AS result", [sourceId ?? null, targetId ?? null, workspaceId, expectedVersion, context.operationId])).rows[0];
        if (!row) throw new WorkspaceServerError("workspace_organization_move_failed", 500);
        const value = parseJsonObject(row.result);
        const added = Array.isArray(value.added_guest_account_ids) ? value.added_guest_account_ids.filter((item): item is string => typeof item === "string") : [];
        const workspace = (await sql.query<OrganizationWorkspaceRow>("SELECT id, organization_id, name, state, version, created_at, updated_at FROM workspaces WHERE id = $1", [workspaceId])).rows[0];
        if (!workspace) throw new WorkspaceServerError("workspace_not_found", 404);
        await sql.query(
          `UPDATE organization_operations SET consumed_at = NOW(), updated_at = NOW()
             WHERE actor_account_id = $1 AND idempotency_key = $2 AND organization_id = $3 AND consumed_at IS NULL`,
          [context.accountId, preflightId, ledgerOrganizationId]
        );
        return {
          operationId: context.operationId,
          ...(sourceId ? { sourceOrganizationId: sourceId } : {}),
          ...(targetId ? { targetOrganizationId: targetId } : {}),
          workspaceId,
          status: "committed" as const,
          workspace: organizationWorkspaceFromRow(workspace),
          addedGuestAccountIds: added,
          guestMembershipAccountIds: added,
          ...(value.event_id === undefined ? {} : { eventId: String(value.event_id) }),
          committedAt: new Date().toISOString(),
          replayed: false
        };
      } catch (error) { throw mapOrganizationPostgresError(error, "workspace_organization_move_failed"); }
    });
    return { ...result.value, replayed: result.replayed };
  }

  /**
   * Attach a standalone Workspace to an explicit Organization.  This is a
   * separate command from Workspace creation so the normal Workspace API
   * remains usable without an Organization.  PostgreSQL owns the actual
   * authorization, lock ordering, guest-member completion, and Event write.
   */
  async attachWorkspaceToOrganization(
    context: OrganizationRequestContext,
    input: AttachWorkspaceToOrganizationInput & { organization_id?: string; workspace_id?: string; expected_workspace_version?: number; confirm_guest_memberships?: boolean }
  ): Promise<WorkspaceOrganizationAssociationResult> {
    const organizationId = organizationIdFrom(context, input.organizationId ?? input.organization_id);
    const workspaceId = assertOpaqueId(input.workspaceId ?? input.workspace_id ?? "", "workspace_id_invalid");
    const suppliedExpectedVersion = input.expectedWorkspaceVersion ?? input.expected_workspace_version;
    if (suppliedExpectedVersion !== undefined) assertExpectedVersion(suppliedExpectedVersion, "workspace_expected_version_invalid", 1);
    const result = await this.runOrganizationIdempotentResult(context, organizationId, {
      action: "workspace.organization.attach",
      input: { organizationId, workspaceId, expectedVersion: suppliedExpectedVersion ?? null }
    }, async (sql) => {
      await sql.query("SELECT set_config('samurai.workspace_id', $1, true)", [workspaceId]);
      const before = (await sql.query<OrganizationWorkspaceRow>(
        // RLS intentionally has no UPDATE policy for the preflight read. A
        // row lock here can therefore turn a readable Workspace into an empty
        // result; the SECURITY DEFINER move function owns the authoritative
        // lock/version check below.
        "SELECT id, organization_id, name, state, version, created_at, updated_at FROM workspaces WHERE id = $1",
        [workspaceId]
      )).rows[0];
      if (!before) throw new WorkspaceServerError("workspace_not_found", 404);
      if (suppliedExpectedVersion !== undefined && Number(before.version) !== suppliedExpectedVersion) {
        throw new WorkspaceServerError("workspace_version_conflict", 409);
      }
      if (before.organization_id === organizationId) {
        const current = await this.organizationWorkspaceSummary(sql, context.accountId, before);
        return { workspace: current, organizationId, addedGuestAccountIds: [], replayed: false };
      }
      if (before.organization_id !== null) throw new WorkspaceServerError("workspace_organization_already_attached", 409);
      const owner = await sql.query<{ allowed: boolean }>(
        "SELECT samurai_can_workspace($1, 'owner') AS allowed",
        [workspaceId]
      );
      if (owner.rows[0]?.allowed !== true) throw new WorkspaceServerError("workspace_owner_permission_required", 403);
      const expectedVersion = suppliedExpectedVersion ?? Number(before.version);
      try {
        const changed = await sql.query<{ result: unknown }>(
          "SELECT samurai_move_workspace_organization($1, $2, $3, $4, $5) AS result",
          [null, organizationId, workspaceId, expectedVersion, context.operationId]
        );
        const changedRow = changed.rows[0];
        if (!changedRow) throw new WorkspaceServerError("workspace_organization_attach_failed", 500);
        const value = parseJsonObject(changedRow.result);
        const after = (await sql.query<OrganizationWorkspaceRow>(
          "SELECT id, organization_id, name, state, version, created_at, updated_at FROM workspaces WHERE id = $1",
          [workspaceId]
        )).rows[0];
        if (!after) throw new WorkspaceServerError("workspace_not_found", 404);
        const summary = await this.organizationWorkspaceSummary(sql, context.accountId, after);
        const added = arrayOfStrings(value.added_guest_account_ids);
        return {
          workspace: summary,
          organizationId,
          addedGuestAccountIds: added,
          ...(value.event_id === undefined ? {} : { eventId: String(value.event_id) }),
          replayed: false
        };
      } catch (error) {
        throw mapOrganizationPostgresError(error, "workspace_organization_attach_failed");
      }
    });
    return { ...result.value, replayed: result.replayed };
  }

  /** Remove a Workspace from an Organization without changing its content or
   * Workspace memberships.  The returned summary intentionally omits the
   * Organization association once the transition is committed. */
  async detachWorkspaceFromOrganization(
    context: OrganizationRequestContext,
    input: DetachWorkspaceFromOrganizationInput & { organization_id?: string; workspace_id?: string; expected_workspace_version?: number }
  ): Promise<WorkspaceOrganizationAssociationResult> {
    const organizationId = organizationIdFrom(context, input.organizationId ?? input.organization_id);
    const workspaceId = assertOpaqueId(input.workspaceId ?? input.workspace_id ?? "", "workspace_id_invalid");
    const suppliedExpectedVersion = input.expectedWorkspaceVersion ?? input.expected_workspace_version;
    if (suppliedExpectedVersion !== undefined) assertExpectedVersion(suppliedExpectedVersion, "workspace_expected_version_invalid", 1);
    const result = await this.runOrganizationIdempotentResult(context, organizationId, {
      action: "workspace.organization.detach",
      input: { organizationId, workspaceId, expectedVersion: suppliedExpectedVersion ?? null }
    }, async (sql) => {
      await sql.query("SELECT set_config('samurai.workspace_id', $1, true)", [workspaceId]);
      const before = (await sql.query<OrganizationWorkspaceRow>(
        // See attachWorkspaceToOrganization: leave locking and version
        // validation to the SECURITY DEFINER move function under RLS.
        "SELECT id, organization_id, name, state, version, created_at, updated_at FROM workspaces WHERE id = $1",
        [workspaceId]
      )).rows[0];
      if (!before) throw new WorkspaceServerError("workspace_not_found", 404);
      if (suppliedExpectedVersion !== undefined && Number(before.version) !== suppliedExpectedVersion) {
        throw new WorkspaceServerError("workspace_version_conflict", 409);
      }
      if (before.organization_id === null) {
        const current = await this.organizationWorkspaceSummary(sql, context.accountId, before);
        return { workspace: current, addedGuestAccountIds: [], replayed: false };
      }
      if (before.organization_id !== organizationId) throw new WorkspaceServerError("workspace_organization_mismatch", 409);
      const expectedVersion = suppliedExpectedVersion ?? Number(before.version);
      try {
        const changed = await sql.query<{ result: unknown }>(
          "SELECT samurai_move_workspace_organization($1, $2, $3, $4, $5) AS result",
          [organizationId, null, workspaceId, expectedVersion, context.operationId]
        );
        const changedRow = changed.rows[0];
        if (!changedRow) throw new WorkspaceServerError("workspace_organization_detach_failed", 500);
        const value = parseJsonObject(changedRow.result);
        const after = (await sql.query<OrganizationWorkspaceRow>(
          "SELECT id, organization_id, name, state, version, created_at, updated_at FROM workspaces WHERE id = $1",
          [workspaceId]
        )).rows[0];
        if (!after) throw new WorkspaceServerError("workspace_not_found", 404);
        const summary = await this.organizationWorkspaceSummary(sql, context.accountId, after);
        return {
          workspace: summary,
          previousOrganizationId: organizationId,
          addedGuestAccountIds: [],
          ...(value.event_id === undefined ? {} : { eventId: String(value.event_id) }),
          replayed: false
        };
      } catch (error) {
        throw mapOrganizationPostgresError(error, "workspace_organization_detach_failed");
      }
    });
    return { ...result.value, replayed: result.replayed };
  }

  async getWorkspaceOrganizationMoveStatus(context: OrganizationRequestContext, operationId: string): Promise<Record<string, unknown>> {
    assertOpaqueId(operationId, "organization_operation_id_invalid");
    return this.database.withContext({ accountId: context.accountId }, async (sql) => {
      const row = (await sql.query<{ organization_id: string | null; status: string; result: unknown; error_code: string | null; updated_at: Date | string }>(
        "SELECT organization_id, status, result, error_code, updated_at FROM organization_operations WHERE actor_account_id = $1 AND idempotency_key = $2", [context.accountId, operationId]
      )).rows[0];
      if (!row) throw new WorkspaceServerError("organization_operation_not_found", 404);
      const result = row.result === null ? {} : parseJsonObject(row.result);
      const workspace = result.workspace && typeof result.workspace === "object" && !Array.isArray(result.workspace)
        ? result.workspace as Record<string, unknown>
        : {};
      const status = row.status === "completed"
        ? String(result.status ?? "committed")
        : row.status === "failed" ? "failed" : "running";
      const guestMembershipAccountIds = Array.isArray(result.guestMembershipAccountIds)
        ? result.guestMembershipAccountIds.filter((value): value is string => typeof value === "string")
        : Array.isArray(result.addedGuestAccountIds)
          ? result.addedGuestAccountIds.filter((value): value is string => typeof value === "string")
          : [];
      const workspaceId = optionalResultString(result.workspaceId ?? result.workspace_id ?? workspace.workspaceId ?? workspace.id);
      const sourceOrganizationId = optionalResultString(result.sourceOrganizationId ?? result.source_organization_id);
      const targetOrganizationId = optionalResultString(result.targetOrganizationId ?? result.target_organization_id ?? workspace.organizationId ?? workspace.organization_id);
      return {
        operationId,
        ...(workspaceId ? { workspaceId } : {}),
        ...(sourceOrganizationId ? { sourceOrganizationId } : {}),
        ...(targetOrganizationId ? { targetOrganizationId } : {}),
        status,
        guestMembershipAccountIds,
        ...(result.eventId === undefined && result.event_id === undefined ? {} : { eventId: String(result.eventId ?? result.event_id) }),
        ...(result.committedAt === undefined && result.committed_at === undefined ? {} : { committedAt: String(result.committedAt ?? result.committed_at) }),
        ...(row.error_code ? { failureCode: row.error_code } : {}),
        updatedAt: iso(row.updated_at)
      };
    });
  }

  async createOrganizationWorkspace(
    context: OrganizationRequestContext,
    input: { organizationId?: string; organization_id?: string; name: string }
  ): Promise<OrganizationWorkspaceSummary> {
    const organizationId = organizationIdFrom(context, input.organizationId ?? input.organization_id);
    const created = await this.createWorkspace({
      name: input.name,
      ownerAccountId: context.accountId,
      operationId: context.operationId,
      hostingMode: this.mode,
      databasePlacement: this.mode === "self_host" ? "dedicated" : "shared"
    });
    // Organization-scoped creation reuses the ordinary standalone Workspace
    // operation first.  Association is an explicit second operation so the
    // Workspace API never grows an implicit Organization default; the SQL
    // move function then performs the normal Guest completion and association
    // Event atomically.  Reusing the caller operation id in both ledgers makes
    // retries replay both phases.  If the second phase fails, the created
    // Workspace remains a safe standalone Workspace for a later explicit
    // attach rather than leaving a partially-created Organization-owned row.
    const attached = await this.attachWorkspaceToOrganization(context, {
      organizationId,
      workspaceId: created.workspace.id,
      expectedWorkspaceVersion: created.workspace.version
    });
    return { ...attached.workspace, replayed: created.replayed === true || attached.replayed === true };
  }

  async grantOrganizationWorkspaceMembership(
    context: OrganizationRequestContext,
    input: { organizationId?: string; organization_id?: string; workspaceId?: string; workspace_id?: string; accountId?: string; target_account_id?: string; role: WorkspaceMembershipRole }
  ): Promise<OrganizationWorkspaceMembership> {
    return this.setOrganizationWorkspaceMembership(context, input, "active");
  }

  async revokeOrganizationWorkspaceMembership(
    context: OrganizationRequestContext,
    input: { organizationId?: string; organization_id?: string; workspaceId?: string; workspace_id?: string; accountId?: string; target_account_id?: string; role?: WorkspaceMembershipRole; expectedVersion?: number; expected_version?: number }
  ): Promise<OrganizationWorkspaceMembership> {
    const workspaceId = input.workspaceId ?? input.workspace_id;
    const accountId = input.accountId ?? input.target_account_id;
    assertOpaqueId(workspaceId ?? "", "workspace_id_invalid");
    assertOpaqueId(accountId ?? "", "account_id_invalid");
    return this.setOrganizationWorkspaceMembership(context, { ...input, workspaceId, accountId, role: input.role ?? "member" }, "revoked");
  }

  async archiveOrganizationWorkspace(context: OrganizationRequestContext, input: { organizationId?: string; organization_id?: string; workspaceId?: string; workspace_id?: string; expectedVersion?: number; expected_version?: number; confirm?: true }): Promise<OrganizationWorkspaceSummary> {
    return this.setOrganizationWorkspaceLifecycle(context, input, "archived");
  }

  async restoreOrganizationWorkspace(context: OrganizationRequestContext, input: { organizationId?: string; organization_id?: string; workspaceId?: string; workspace_id?: string; expectedVersion?: number; expected_version?: number; confirm?: true }): Promise<OrganizationWorkspaceSummary> {
    return this.setOrganizationWorkspaceLifecycle(context, input, "active");
  }

  async deleteOrganizationWorkspace(context: OrganizationRequestContext, input: { organizationId?: string; organization_id?: string; workspaceId?: string; workspace_id?: string; expectedVersion?: number; expected_version?: number; confirm?: true }): Promise<OrganizationWorkspaceSummary> {
    return this.setOrganizationWorkspaceLifecycle(context, input, "deleted");
  }

  /** Bundle bytes remain in the Bundle service.  Workspace ownership is the
   * authorization boundary; an Organization is optional provenance and, when
   * supplied, is only checked against the Workspace's current association. */
  async exportWorkspaceBundle(context: OrganizationRequestContext, input: { organizationId?: string; organization_id?: string; workspaceId?: string; workspace_id?: string; expectedWorkspaceVersion?: number; expected_workspace_version?: number }): Promise<Record<string, unknown>> {
    const requestedOrganizationId = optionalOrganizationId(
      input.organizationId ?? input.organization_id ?? context.organizationId,
      "organization_id_invalid"
    );
    const workspaceId = assertOpaqueId(input.workspaceId ?? input.workspace_id ?? "", "workspace_id_invalid");
    const workspace = await this.database.withContext({ accountId: context.accountId }, async (sql) => {
      const row = (await sql.query<OrganizationWorkspaceRow>("SELECT id, organization_id, name, state, version, created_at, updated_at FROM workspaces WHERE id = $1", [workspaceId])).rows[0];
      if (!row) throw new WorkspaceServerError("workspace_not_found", 404);
      if (requestedOrganizationId !== undefined && row.organization_id !== requestedOrganizationId) {
        throw new WorkspaceServerError("workspace_bundle_source_organization_mismatch", 409);
      }
      const expectedVersion = input.expectedWorkspaceVersion ?? input.expected_workspace_version;
      if (expectedVersion !== undefined && Number(row.version) !== expectedVersion) throw new WorkspaceServerError("workspace_version_conflict", 409);
      const owner = await sql.query<{ allowed: boolean }>("SELECT samurai_can_workspace($1, 'owner') AS allowed", [workspaceId]);
      if (owner.rows[0]?.allowed !== true) throw new WorkspaceServerError("workspace_owner_permission_required", 403);
      return row;
    });
    return {
      bundleId: `bundle_${context.operationId}`,
      workspaceId,
      ...(workspace.organization_id ? { sourceOrganizationId: workspace.organization_id } : {}),
      workspaceVersion: Number(workspace.version),
      state: workspace.state,
      createdAt: iso(workspace.created_at)
    };
  }

  /** Restore is executed by the Bundle service.  The default target is a
   * standalone Workspace; an explicit target Organization is validated before
   * that service performs file/database work. */
  async restoreWorkspaceBundle(context: OrganizationRequestContext, input: { bundleId?: string; bundle_id?: string; targetOrganizationId?: string; target_organization_id?: string; confirm?: true }): Promise<Record<string, unknown>> {
    const targetOrganizationId = optionalOrganizationId(
      input.targetOrganizationId ?? input.target_organization_id ?? context.organizationId,
      "organization_id_invalid"
    );
    const bundleId = assertOpaqueId(input.bundleId ?? input.bundle_id ?? "", "workspace_bundle_id_invalid");
    if (targetOrganizationId !== undefined) {
      await this.database.withContext({ accountId: context.accountId }, async (sql) => {
        const allowed = await sql.query<{ allowed: boolean }>("SELECT samurai_can_organization($1, 'admin') AS allowed", [targetOrganizationId]);
        if (allowed.rows[0]?.allowed !== true) throw new WorkspaceServerError("organization_admin_permission_required", 403);
      });
    }
    return { bundleId, ...(targetOrganizationId ? { targetOrganizationId } : {}), status: "authorized" };
  }

  async createWorkspace(input: CreateWorkspaceInput): Promise<{ workspace: WorkspaceSummary; defaultRoom: WorkspaceRoom; replayed?: boolean }> {
    const workspaceId = input.id ?? operationScopedId("workspace", input.ownerAccountId, input.operationId);
    assertOpaqueId(workspaceId, "workspace_id_invalid");
    assertOpaqueId(input.ownerAccountId, "account_id_invalid");
    assertOpaqueId(input.operationId, "workspace_operation_id_invalid");
    if (!input.name.trim()) throw new WorkspaceServerError("workspace_name_required", 400);
    const mode = input.hostingMode ?? this.mode;
    const roomId = operationScopedId("room", workspaceId, input.operationId);
    const result = await this.runAccountIdempotentResult(input.ownerAccountId, input.operationId, workspaceId, {
      action: "workspace.create",
      input: {
        id: workspaceId,
        name: input.name.trim(),
        mode,
        ...(input.databasePlacement ? { databasePlacement: input.databasePlacement } : {}),
        organizationId: input.organizationId ?? null
      }
    }, async (sql) => {
      try {
        const values = [
          workspaceId,
          input.name.trim(),
          mode,
          input.databasePlacement ?? (mode === "self_host" ? "dedicated" : "shared"),
          roomId,
          "General"
        ];
        if (input.organizationId) {
          assertOpaqueId(input.organizationId, "organization_id_invalid");
          await sql.query("SELECT samurai_create_workspace($1, $2, $3, $4, $5, $6, $7)", [...values, input.organizationId]);
        } else {
          await sql.query("SELECT samurai_create_workspace($1, $2, $3, $4, $5, $6)", values);
        }
      } catch (error) {
        if (postgresMessage(error).includes("workspace_id_conflict")) throw new WorkspaceServerError("workspace_id_conflict", 409);
        throw error;
      }
      const workspace = (await sql.query<WorkspaceSummaryRow>(
        `SELECT id, organization_id, name, state, hosting_mode, storage_namespace, database_placement, version, created_at, updated_at
         FROM workspaces WHERE id = $1`,
        [workspaceId]
      )).rows[0];
      if (!workspace) throw new WorkspaceServerError("workspace_creation_failed", 500);
      return {
        workspace: workspaceSummaryFromRow({ ...workspace, role: "owner" }),
        defaultRoom: {
          id: roomId,
          workspaceId,
          name: "General",
          version: 1,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }
      };
    });
    return { ...result.value, replayed: result.replayed };
  }

  async listWorkspaces(accountId: string): Promise<WorkspaceSummary[]> {
    assertOpaqueId(accountId, "account_id_invalid");
    return this.database.withContext({ accountId }, async (sql) => {
      const result = await sql.query<WorkspaceSummaryRow>(
        `SELECT w.id, w.organization_id, w.name, w.state, w.hosting_mode, w.storage_namespace, w.database_placement, w.version, w.created_at, w.updated_at, m.role
         FROM workspaces AS w
         JOIN workspace_members AS m ON m.workspace_id = w.id
         WHERE m.account_id = $1 AND m.state = 'active'
         ORDER BY w.updated_at DESC`,
        [accountId]
      );
      return result.rows.map(workspaceSummaryFromRow);
    });
  }

  /**
   * Enumerate active Workspace recovery identities from the server-owned
   * worker context.  The configured self-host Workspace ID is only a
   * bootstrap input; normal recovery must discover every active Workspace.
   */
  async listActiveWorkspaceIds(): Promise<Array<{ workspaceId: string; accountId: string }>> {
    return this.database.withContext({ accountId: "workspace-worker", worker: true }, async (sql) => {
      const result = await sql.query<{ workspace_id: string; account_id: string; hosting_mode: WorkspaceServerMode }>(
        "SELECT workspace_id, account_id, hosting_mode FROM samurai_list_active_workspace_ids()"
      );
      return result.rows
        .filter((row) => row.hosting_mode === this.mode)
        .map((row) => ({ workspaceId: row.workspace_id, accountId: row.account_id }));
    });
  }

  async getWorkspace(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">): Promise<WorkspaceSummary> {
    return this.database.withContext(context, async (sql) => {
      const result = await sql.query<WorkspaceSummaryRow>(
        `SELECT w.id, w.organization_id, w.name, w.state, w.hosting_mode, w.storage_namespace, w.database_placement, w.version, w.created_at, w.updated_at, m.role
         FROM workspaces AS w
         JOIN workspace_members AS m ON m.workspace_id = w.id
         WHERE w.id = $1 AND m.account_id = $2 AND m.state = 'active'`,
        [context.workspaceId, context.accountId]
      );
      const workspace = result.rows[0];
      if (!workspace) throw new WorkspaceServerError("workspace_not_found", 404);
      return workspaceSummaryFromRow(workspace);
    });
  }

  async listRooms(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">): Promise<WorkspaceRoom[]> {
    return this.database.withContext(context, async (sql) => {
      const result = await sql.query<RoomRow>(
        `SELECT workspace_id, id, parent_room_id, name, room_kind, default_agent_id, default_agent_version, dm_account_id, version, created_at, updated_at,
                samurai_can_room(workspace_id, id, 'manage') AS can_manage,
                samurai_can_room(workspace_id, id, 'execute') AS can_execute
         FROM rooms WHERE workspace_id = $1 ORDER BY created_at`,
        [context.workspaceId]
      );
      return result.rows.map(roomFromRow);
    });
  }

  async listAgents(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">): Promise<WorkspaceAgent[]> {
    return this.database.withContext(context, async (sql) => {
      const result = await sql.query<AgentRow>(
        `SELECT workspace_id, id, display_name, description, role, instructions, enabled, backend_id, status, version, created_by, created_at, updated_at
         FROM workspace_agents WHERE workspace_id = $1 ORDER BY created_at, id`,
        [context.workspaceId]
      );
      return result.rows.map(agentFromRow);
    });
  }

  async registerAgent(context: WorkspaceRequestContext, input: RegisterWorkspaceAgentInput): Promise<{ agent: WorkspaceAgent; replayed: boolean }> {
    if (!input.displayName.trim() || input.displayName.trim().length > 200) throw new WorkspaceServerError("workspace_agent_display_name_invalid", 400);
    const backendId = normalizeAgentBackendId(input.backendId);
    const role = input.role?.trim() || "workspace_agent";
    const instructions = input.instructions?.trim() || input.description?.trim() || "Workspace Agent";
    if (role.length > 500 || instructions.length > 20_000) throw new WorkspaceServerError("workspace_agent_input_invalid", 400);
    const id = input.id ?? operationScopedId("agent", context.workspaceId, context.operationId);
    assertOpaqueId(id, "workspace_agent_id_invalid");
    const useV1Profile = input.role !== undefined || input.instructions !== undefined || input.enabled !== undefined;
    const result = await this.runIdempotentResult(context, { action: "workspace.agent.register", input: { id, displayName: input.displayName.trim(), description: input.description?.trim() ?? "", role, instructions, enabled: input.enabled ?? true, backendId } }, async (sql) => {
      await this.assertWorkspaceWritable(sql, context.workspaceId);
      try {
        if (useV1Profile) {
          await sql.query("SELECT samurai_register_workspace_agent_v1($1, $2, $3, $4, $5, $6, $7)", [context.workspaceId, id, input.displayName.trim(), role, instructions, backendId, input.enabled ?? true]);
        } else {
          await sql.query("SELECT samurai_register_workspace_agent($1, $2, $3, $4)", [context.workspaceId, id, input.displayName.trim(), input.description?.trim() ?? ""]);
        }
        if (!useV1Profile && backendId !== "samurai-native") {
          await sql.query("SELECT samurai_set_workspace_agent_backend($1, $2, $3)", [context.workspaceId, id, backendId]);
        }
      } catch (error) {
        if (postgresMessage(error).includes("duplicate key")) throw new WorkspaceServerError("workspace_agent_id_conflict", 409);
        throw error;
      }
      const saved = await sql.query<AgentRow>(
        `SELECT workspace_id, id, display_name, description, role, instructions, enabled, backend_id, status, version, created_by, created_at, updated_at
         FROM workspace_agents WHERE workspace_id = $1 AND id = $2`,
        [context.workspaceId, id]
      );
      const agent = saved.rows[0];
      if (!agent) throw new WorkspaceServerError("workspace_agent_registration_failed", 500);
      const mapped = agentFromRow(agent);
      await this.insertAudit(sql, context, {
        action: "workspace.agent.register",
        subjectKind: "workspace_agent",
        subjectId: mapped.id,
        beforeVersion: 0,
        afterVersion: mapped.version,
        details: { display_name: mapped.displayName, status: mapped.status }
      });
      return mapped;
    });
    return { agent: result.value, replayed: result.replayed };
  }

  async patchRoom(
    context: WorkspaceRequestContext,
    input: { id: string; name: string; expectedVersion?: number }
  ): Promise<{ room: WorkspaceRoom; replayed: boolean }> {
    assertOpaqueId(input.id, "room_id_invalid");
    if (!input.name.trim() || input.name.trim().length > 200) throw new WorkspaceServerError("room_name_required", 400);
    const current = await this.getRoom(context, input.id);
    const expectedVersion = input.expectedVersion ?? current.version;
    assertExpectedVersion(expectedVersion, "room_expected_version_invalid", 1);
    const requestInput = {
      id: input.id,
      name: input.name,
      ...(input.expectedVersion === undefined ? {} : { expectedVersion: input.expectedVersion })
    };
    const result = await this.runIdempotentResult(context, { action: "room.patch", input: requestInput }, async (sql) => {
      try {
        await sql.query("SELECT samurai_patch_room($1, $2, $3, $4)", [context.workspaceId, input.id, input.name.trim(), expectedVersion]);
      } catch (error) {
        if (postgresMessage(error).includes("room_version_conflict")) {
          const latest = await sql.query<{ version: number | string }>("SELECT version FROM rooms WHERE workspace_id = $1 AND id = $2", [context.workspaceId, input.id]);
          throw new WorkspaceServerError("room_version_conflict", 409, { latest_version: latest.rows[0] ? Number(latest.rows[0].version) : null });
        }
        throw error;
      }
      const saved = await sql.query<RoomRow>(
        "SELECT workspace_id, id, parent_room_id, name, room_kind, default_agent_id, default_agent_version, dm_account_id, version, created_at, updated_at FROM rooms WHERE workspace_id = $1 AND id = $2",
        [context.workspaceId, input.id]
      );
      const row = saved.rows[0];
      if (!row) throw new WorkspaceServerError("room_not_available", 404);
      const room = roomFromRow(row);
      await this.insertEvent(sql, context, { roomId: room.id, kind: "room.updated", recordType: "room", recordId: room.id, payload: { version: room.version } });
      await this.insertAudit(sql, context, { action: "room.patch", roomId: room.id, subjectKind: "room", subjectId: room.id, beforeVersion: expectedVersion, afterVersion: room.version });
      return room;
    });
    return { room: result.value, replayed: result.replayed };
  }

  async getRoom(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, roomId: string): Promise<WorkspaceRoom> {
    assertOpaqueId(roomId, "room_id_invalid");
    return this.database.withContext(context, async (sql) => {
      const result = await sql.query<RoomRow>(
        `SELECT workspace_id, id, parent_room_id, name, room_kind, default_agent_id, default_agent_version, dm_account_id, version, created_at, updated_at,
                samurai_can_room(workspace_id, id, 'manage') AS can_manage,
                samurai_can_room(workspace_id, id, 'execute') AS can_execute
         FROM rooms WHERE workspace_id = $1 AND id = $2`,
        [context.workspaceId, roomId]
      );
      const row = result.rows[0];
      if (!row) throw new WorkspaceServerError("room_not_available", 404);
      return roomFromRow(row);
    });
  }

  /** Persist the one Room-level default Agent. It only affects new work; an
   * existing assignment keeps the Agent/version captured at creation time. */
  async setRoomDefaultAgent(
    context: WorkspaceRequestContext,
    input: SetRoomDefaultAgentInput
  ): Promise<WorkspaceRoomDefaultAgent | null> {
    assertOpaqueId(input.roomId, "room_id_invalid");
    if (input.agentId !== null) assertOpaqueId(input.agentId, "workspace_default_agent_id_invalid");
    const current = await this.getRoom(context, input.roomId);
    const expectedVersion = input.expectedVersion ?? current.version;
    assertExpectedVersion(expectedVersion, "room_expected_version_invalid", 1);
    const requestInput = {
      roomId: input.roomId,
      agentId: input.agentId,
      ...(input.expectedVersion === undefined ? {} : { expectedVersion: input.expectedVersion })
    };
    const result = await this.runIdempotentResult(context, { action: "room.default_agent.set", input: requestInput }, async (sql) => {
      try {
        await sql.query(
          "SELECT samurai_set_room_default_agent($1, $2, $3, $4)",
          [context.workspaceId, input.roomId, input.agentId, expectedVersion]
        );
      } catch (error) {
        if (postgresMessage(error).includes("room_version_conflict")) {
          throw await this.roomVersionConflict(sql, context.workspaceId, input.roomId);
        }
        throw mapRoomWorkPostgresError(error, "room_default_agent_update_failed");
      }
      const row = (await sql.query<RoomRow>(
        `SELECT workspace_id, id, parent_room_id, name, room_kind, default_agent_id,
                default_agent_version, dm_account_id, version, created_at, updated_at
         FROM rooms WHERE workspace_id = $1 AND id = $2`,
        [context.workspaceId, input.roomId]
      )).rows[0];
      if (!row) throw new WorkspaceServerError("room_not_available", 404);
      if (!row.default_agent_id || row.default_agent_version === null || row.default_agent_version === undefined) {
        await this.insertEvent(sql, context, {
          roomId: input.roomId,
          kind: "room.default_agent.cleared",
          recordType: "room",
          recordId: input.roomId,
          payload: { version: Number(row.version) }
        });
        await this.insertAudit(sql, context, {
          action: "room.default_agent.set",
          roomId: input.roomId,
          subjectKind: "room",
          subjectId: input.roomId,
          beforeVersion: expectedVersion,
          afterVersion: Number(row.version),
          details: { default_agent_id: null }
        });
        return null;
      }
      const permission = (await sql.query<{ enabled: boolean; can_execute: boolean }>(
        `SELECT agent.enabled, permission.can_execute
         FROM workspace_agents AS agent
         LEFT JOIN workspace_agent_room_permissions AS permission
           ON permission.workspace_id = agent.workspace_id
          AND permission.agent_id = agent.id
          AND permission.room_id = $2
         WHERE agent.workspace_id = $1 AND agent.id = $3`,
        [context.workspaceId, input.roomId, row.default_agent_id]
      )).rows[0];
      const value: WorkspaceRoomDefaultAgent = {
        roomId: input.roomId,
        agentId: row.default_agent_id,
        agentVersion: Number(row.default_agent_version),
        enabled: permission?.enabled === true,
        canExecute: permission?.can_execute === true,
        version: Number(row.version),
        updatedAt: iso(row.updated_at)
      };
      await this.insertEvent(sql, context, {
        roomId: input.roomId,
        kind: "room.default_agent.changed",
        recordType: "room",
        recordId: input.roomId,
        payload: { default_agent_id: value.agentId, default_agent_version: value.agentVersion, version: value.version }
      });
      await this.insertAudit(sql, context, {
        action: "room.default_agent.set",
        roomId: input.roomId,
        subjectKind: "room",
        subjectId: input.roomId,
        beforeVersion: expectedVersion,
        afterVersion: value.version,
        details: { default_agent_id: value.agentId, default_agent_version: value.agentVersion }
      });
      return value;
    });
    // `null` is the legacy Store-level representation for clearing a default
    // Agent; there is no object on which to carry the replay marker.  The
    // public Room operation only accepts an Agent ID, so preserve that
    // existing nullable API while exposing `replayed` for normal updates.
    return result.value === null
      ? null
      : ({ ...result.value, replayed: result.replayed } as WorkspaceRoomDefaultAgent);
  }

  /** Open or retrieve the caller's private Agent DM Room. */
  async openAgentDm(context: WorkspaceRequestContext, input: OpenAgentDmInput): Promise<WorkspaceAgentDm> {
    assertOpaqueId(input.agentId, "workspace_agent_id_invalid");
    const roomId = operationScopedId("agent_dm", `${context.workspaceId}:${context.accountId}:${input.agentId}`, context.operationId);
    const result = await this.runIdempotentResult(context, {
      action: "agent.dm.open",
      input: { agentId: input.agentId }
    }, async (sql) => {
      try {
        const opened = await sql.query<{ result: unknown }>(
          "SELECT samurai_open_agent_dm($1, $2, $3, $4) AS result",
          [context.workspaceId, roomId, input.agentId, context.operationId]
        );
        // The SQL function returns the canonical Room ID.  A DM that already
        // exists belongs to the same Account/Agent pair but was created by a
        // different operation, so its ID is not the operation-scoped
        // candidate above.
        const openedValue = jsonObjectOrEmpty(opened.rows[0]?.result);
        const openedRoomId = typeof openedValue.room_id === "string" && openedValue.room_id.length > 0
          ? openedValue.room_id
          : undefined;
        if (!openedRoomId) throw new WorkspaceServerError("agent_dm_open_failed", 500);
        const row = (await sql.query<RoomRow>(
          `SELECT workspace_id, id, parent_room_id, name, room_kind, default_agent_id,
                  default_agent_version, dm_account_id, version, created_at, updated_at
           FROM rooms WHERE workspace_id = $1 AND id = $2`,
          [context.workspaceId, openedRoomId]
        )).rows[0];
        if (!row || row.room_kind !== "agent_dm" || !row.default_agent_id || row.default_agent_version === null || row.default_agent_version === undefined) {
          throw new WorkspaceServerError("agent_dm_open_failed", 500);
        }
        return {
          workspaceId: row.workspace_id,
          roomId: row.id,
          kind: "agent_dm" as const,
          agentId: row.default_agent_id,
          agentVersion: Number(row.default_agent_version),
          version: Number(row.version),
          createdAt: iso(row.created_at),
          updatedAt: iso(row.updated_at)
        };
      } catch (error) {
        throw mapRoomWorkPostgresError(error, "agent_dm_open_failed");
      }
    });
    return { ...result.value, replayed: result.replayed } as WorkspaceAgentDm;
  }

  /** Create the Room-facing work aggregate and reserve its first launch in one
   * database transaction. The caller never receives or supplies a Session ID. */
  async createRoomWork(context: WorkspaceRequestContext, input: CreateRoomWorkInput): Promise<WorkspaceHumanWorkCreateResult> {
    assertOpaqueId(input.roomId, "room_id_invalid");
    const attachments = normalizeRoomWorkAttachmentRefs(input.attachments);
    const resourceRefs = normalizeRoomWorkResourceRefs(input.resourceRefs);
    const instruction = input.instruction?.trim()
      || (resourceRefs.length > 0 ? "Review the referenced resources." : attachments.length > 0 ? "Review the attached resources." : "");
    if (!instruction) throw new WorkspaceServerError("room_work_instruction_required", 400);
    if (input.title !== undefined && (!input.title.trim() || input.title.trim().length > 200)) {
      throw new WorkspaceServerError("room_work_title_invalid", 400);
    }
    if (input.objective !== undefined && (!input.objective.trim() || input.objective.trim().length > 1_000_000)) {
      throw new WorkspaceServerError("room_work_objective_invalid", 400);
    }
    if (input.agentId) assertOpaqueId(input.agentId, "workspace_agent_id_invalid");
    const room = await this.getRoom(context, input.roomId);
    const agentId = input.agentId ?? room.defaultAgentId;
    if (!agentId) throw new WorkspaceServerError("workspace_room_default_agent_required", 409);
    const title = input.title?.trim() || instruction.slice(0, 200);
    const objective = input.objective?.trim() || instruction;
    const completionCriteria = input.completionCriteria ?? [];
    if (!Array.isArray(completionCriteria)) throw new WorkspaceServerError("room_work_completion_criteria_invalid", 400);
    const scheduledAt = parseDateInput(input.scheduledAt, "room_work_scheduled_at_invalid") ?? new Date();
    const workId = operationScopedId("room_work", `${context.workspaceId}:${input.roomId}`, context.operationId);
    const assignmentId = operationScopedId("room_work_assignment", `${context.workspaceId}:${input.roomId}`, context.operationId);
    const instructionId = operationScopedId("room_work_instruction", `${context.workspaceId}:${input.roomId}`, context.operationId);
    const reservationId = operationScopedId("room_work_reservation", `${context.workspaceId}:${input.roomId}`, context.operationId);
    const requestInput = {
      roomId: input.roomId,
      instruction: input.instruction ?? null,
      attachments,
      ...(input.resourceRefs === undefined ? {} : { resourceRefs }),
      agentId: input.agentId ?? null,
      title: input.title ?? null,
      objective: input.objective ?? null,
      completionCriteria,
      scheduledAt: scheduledAt.toISOString()
    };
    const result = await this.runIdempotentResult(context, { action: "room.work.create", input: requestInput }, async (sql) => {
      await assertRoomWorkAttachmentRefs(sql, context, input.roomId, attachments);
      const canonicalResourceRefs = await resolveRoomWorkResourceRefs(sql, context, input.roomId, resourceRefs);
      const persistedRoom = await this.lockRoomDefaultAgent(sql, context.workspaceId, input.roomId);
      const agent = (await sql.query<{ version: number | string; status: WorkspaceAgent["status"]; enabled: boolean }>(
        `SELECT version, status, enabled FROM workspace_agents
         WHERE workspace_id = $1 AND id = $2`,
        [context.workspaceId, agentId]
      )).rows[0];
      if (!agent || agent.status !== "active" || agent.enabled !== true) {
        throw new WorkspaceServerError("workspace_default_agent_not_available", 409);
      }
      if (!input.agentId && (persistedRoom.default_agent_id !== agentId
        || persistedRoom.default_agent_version === null
        || Number(persistedRoom.default_agent_version) !== Number(agent.version))) {
        throw new WorkspaceServerError("workspace_room_default_agent_changed", 409);
      }
      try {
        await sql.query(
          "SELECT samurai_create_human_work($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::JSONB, $13, $14::JSONB, $15::JSONB, $16, $17)",
          [
            context.workspaceId,
            workId,
            assignmentId,
            instructionId,
            reservationId,
            input.roomId,
            context.accountId,
            agentId,
            Number(agent.version),
            title,
            objective,
            canonicalJson(completionCriteria),
            instruction,
            canonicalJson(attachments),
            canonicalJson(canonicalResourceRefs),
            scheduledAt.toISOString(),
            context.operationId
          ]
        );
      } catch (error) {
        throw mapRoomWorkPostgresError(error, "room_work_creation_failed");
      }
      const work = await this.readHumanWorkAggregate(sql, context.workspaceId, workId, input.roomId);
      const reservation = await this.readHumanWorkReservation(sql, context.workspaceId, reservationId);
      if (!reservation) throw new WorkspaceServerError("room_work_launch_reservation_missing", 500);
      await this.insertAudit(sql, context, {
        action: "room.work.create",
        roomId: input.roomId,
        subjectKind: "room_work",
        subjectId: workId,
        beforeVersion: 0,
        afterVersion: work.instructionVersion,
        details: { assignment_id: assignmentId, agent_id: agentId, reservation_id: reservationId }
      });
      return { work, launchReservation: reservation };
    });
    return { ...result.value, replayed: result.replayed };
  }

  /**
   * Convert one authorized legacy chat turn into the Room-work lifecycle.
   *
   * The legacy Session is only a lookup key for this compatibility lane.  A
   * per-Session advisory lock serializes the first-use decision, while the
   * normal operation ledger makes retries idempotent.  On first use this
   * transaction creates the work, initial instruction, launch reservation,
   * and bridge row together; later turns append an instruction to the
   * already-mapped work without changing its Agent assignment.
   */
  async migrateLegacyChatTurn(
    context: WorkspaceRequestContext,
    input: MigrateLegacyChatTurnInput
  ): Promise<IdempotentOperationResult<MigrateLegacyChatTurnValue>> {
    assertOpaqueId(input.roomId, "room_id_invalid");
    assertOpaqueId(input.sessionId, "legacy_session_id_invalid");
    if (input.agentId) assertOpaqueId(input.agentId, "workspace_agent_id_invalid");
    const attachments = normalizeRoomWorkAttachmentRefs(input.attachments);
    const instruction = input.instruction.trim() || (attachments.length > 0 ? "Review the attached resources." : "");
    if (!instruction) throw new WorkspaceServerError("room_work_instruction_required", 400);
    const title = instruction.slice(0, 200);
    const objective = instruction;
    const scheduledAt = new Date().toISOString();
    const workId = operationScopedId("room_work", `${context.workspaceId}:${input.roomId}`, context.operationId);
    const assignmentId = operationScopedId("room_work_assignment", `${context.workspaceId}:${input.roomId}`, context.operationId);
    const instructionId = operationScopedId("room_work_instruction", `${context.workspaceId}:${input.roomId}`, context.operationId);
    const reservationId = operationScopedId("room_work_reservation", `${context.workspaceId}:${input.roomId}`, context.operationId);
    const legacyMapId = operationScopedId(
      "legacy_session",
      `${context.workspaceId}:${input.roomId}:${input.sessionId}`,
      "binding"
    );
    const requestInput = {
      roomId: input.roomId,
      sessionId: input.sessionId,
      instruction,
      attachments,
      agentId: input.agentId ?? null
    };
    const result = await this.runIdempotentResult(
      context,
      { action: "chat.turn.run.compatibility", input: requestInput },
      async (sql): Promise<MigrateLegacyChatTurnValue> => {
        await assertRoomWorkAttachmentRefs(sql, context, input.roomId, attachments);
        await sql.query(
          "SELECT pg_advisory_xact_lock(hashtextextended('samurai.workspace.human_work.legacy_session:' || $1 || ':' || $2 || ':' || $3, 0))",
          [context.workspaceId, input.roomId, input.sessionId]
        );
        const session = (await sql.query<{ id: string; room_id: string | null }>(
          `SELECT id, room_id FROM workspace_runtime_sessions
           WHERE workspace_id = $1 AND id = $2 AND room_id = $3`,
          [context.workspaceId, input.sessionId, input.roomId]
        )).rows[0];
        if (!session) throw new WorkspaceServerError("legacy_session_not_available", 404);

        const mapping = (await sql.query<LegacySessionMapRow>(
          `SELECT workspace_id, id, legacy_session_id, room_id, work_id, operation_id,
                  created_by, created_at, updated_at
           FROM workspace_human_work_legacy_sessions
           WHERE workspace_id = $1 AND legacy_session_id = $2`,
          [context.workspaceId, input.sessionId]
        )).rows[0];
        if (mapping) {
          if (mapping.room_id !== input.roomId) {
            throw new WorkspaceServerError("legacy_session_room_mismatch", 409);
          }
          const work = await this.readHumanWorkAggregate(sql, context.workspaceId, mapping.work_id, input.roomId);
          const expectedVersion = work.instructionVersion;
          const expectedGeneration = work.controlGeneration;
          assertExpectedVersion(expectedVersion, "room_work_instruction_version_invalid", 1);
          assertExpectedVersion(expectedGeneration, "room_work_generation_invalid", 0);
          try {
            await sql.query(
              "SELECT samurai_append_human_work_instruction($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::JSONB, $11, $12)",
              [
                context.workspaceId,
                instructionId,
                mapping.work_id,
                null,
                instruction,
                expectedVersion,
                "reply",
                null,
                null,
                canonicalJson(attachments),
                expectedGeneration,
                context.operationId
              ]
            );
          } catch (error) {
            throw mapRoomWorkPostgresError(error, "room_work_reply_failed");
          }
          const row = (await sql.query<HumanWorkInstructionRow>(
            `SELECT workspace_id, id, work_id, assignment_id, room_id, version, body, attachment_refs,
                    source_kind, source_comment_id, source_comment_version, state, created_by, created_at
             FROM workspace_human_work_instructions
             WHERE workspace_id = $1 AND id = $2`,
            [context.workspaceId, instructionId]
          )).rows[0];
          if (!row) throw new WorkspaceServerError("room_work_instruction_creation_failed", 500);
          const savedInstruction = humanWorkInstructionFromRow(row);
          await this.insertEvent(sql, context, {
            roomId: input.roomId,
            kind: "room.work.instruction.created",
            recordType: "room_work_instruction",
            recordId: savedInstruction.id,
            payload: { work_id: mapping.work_id, version: savedInstruction.version, source_kind: "reply", legacy_session: true }
          });
          await this.insertAudit(sql, context, {
            action: "chat.turn.run.compatibility",
            roomId: input.roomId,
            subjectKind: "room_work_instruction",
            subjectId: savedInstruction.id,
            beforeVersion: expectedVersion,
            afterVersion: savedInstruction.version,
            details: { work_id: mapping.work_id, legacy_session: true }
          });
          return { mode: "reply", instruction: savedInstruction };
        }

        const persistedRoom = await this.lockRoomDefaultAgent(sql, context.workspaceId, input.roomId);
        const agentId = input.agentId ?? persistedRoom.default_agent_id;
        if (!agentId) throw new WorkspaceServerError("workspace_room_default_agent_required", 409);
        const agent = (await sql.query<{ version: number | string; status: WorkspaceAgent["status"]; enabled: boolean }>(
          `SELECT version, status, enabled FROM workspace_agents
           WHERE workspace_id = $1 AND id = $2`,
          [context.workspaceId, agentId]
        )).rows[0];
        if (!agent || agent.status !== "active" || agent.enabled !== true) {
          throw new WorkspaceServerError("workspace_default_agent_not_available", 409);
        }
        if (!input.agentId && (persistedRoom.default_agent_id !== agentId
          || persistedRoom.default_agent_version === null
          || Number(persistedRoom.default_agent_version) !== Number(agent.version))) {
          throw new WorkspaceServerError("workspace_room_default_agent_changed", 409);
        }
        try {
          await sql.query(
            "SELECT samurai_create_human_work($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::JSONB, $13, $14::JSONB, $15, $16)",
            [
              context.workspaceId,
              workId,
              assignmentId,
              instructionId,
              reservationId,
              input.roomId,
              context.accountId,
              agentId,
              Number(agent.version),
              title,
              objective,
              "[]",
              instruction,
              canonicalJson(attachments),
              scheduledAt,
              context.operationId
            ]
          );
          await sql.query(
            "SELECT samurai_bind_human_work_legacy_session($1, $2, $3, $4, $5, $6)",
            [context.workspaceId, legacyMapId, input.sessionId, input.roomId, workId, context.operationId]
          );
        } catch (error) {
          throw mapRoomWorkPostgresError(error, "room_work_creation_failed");
        }
        const work = await this.readHumanWorkAggregate(sql, context.workspaceId, workId, input.roomId);
        const launchReservation = await this.readHumanWorkReservation(sql, context.workspaceId, reservationId);
        if (!launchReservation) throw new WorkspaceServerError("room_work_launch_reservation_missing", 500);
        await this.insertAudit(sql, context, {
          action: "chat.turn.run.compatibility",
          roomId: input.roomId,
          subjectKind: "room_work",
          subjectId: workId,
          beforeVersion: 0,
          afterVersion: work.instructionVersion,
          details: { assignment_id: assignmentId, agent_id: agentId, reservation_id: reservationId, legacy_session: true }
        });
        return { mode: "create", work, launchReservation };
      }
    );
    return result;
  }

  /** Resolve the internal legacy bridge without returning a public Session DTO. */
  async resolveRoomWorkLegacySession(
    context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">,
    input: { roomId: string; sessionId: string }
  ): Promise<WorkspaceHumanWorkLegacySession | undefined> {
    assertOpaqueId(input.roomId, "room_id_invalid");
    assertOpaqueId(input.sessionId, "legacy_session_id_invalid");
    return this.database.withContext(context, async (sql) => {
      const row = (await sql.query<LegacySessionMapRow>(
        `SELECT workspace_id, id, legacy_session_id, room_id, work_id, operation_id,
                created_by, created_at, updated_at
         FROM workspace_human_work_legacy_sessions
         WHERE workspace_id = $1 AND legacy_session_id = $2 AND room_id = $3`,
        [context.workspaceId, input.sessionId, input.roomId]
      )).rows[0];
      return row ? legacySessionFromRow(row) : undefined;
    });
  }

  async listRoomWorks(
    context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">,
    input: ListRoomWorksInput
  ): Promise<WorkspaceHumanWork[]> {
    assertOpaqueId(input.roomId, "room_id_invalid");
    const limit = boundedLimit(input.limit);
    if (input.status && !workspaceHumanWorkStatusSet.has(input.status)) throw new WorkspaceServerError("room_work_status_invalid", 400);
    return this.database.withContext(context, async (sql) => {
      const rows = await sql.query<HumanWorkRow>(
        `SELECT workspace_id, id, room_id, requester_account_id, default_agent_id,
                default_agent_version, title, objective, completion_criteria, status,
                resource_refs, stop_state, instruction_version, control_generation, operation_id,
                created_at, updated_at
         FROM workspace_human_works
         WHERE workspace_id = $1 AND room_id = $2
           AND ($3::TEXT IS NULL OR status = $3)
         ORDER BY updated_at DESC, id DESC
         LIMIT $4`,
        [context.workspaceId, input.roomId, input.status ?? null, limit]
      );
      const values: WorkspaceHumanWork[] = [];
      for (const row of rows.rows) {
        values.push(await this.readHumanWorkAggregate(sql, context.workspaceId, row.id, row.room_id, row) as WorkspaceHumanWork);
      }
      return values;
    });
  }

  async viewRoomWork(
    context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">,
    input: { roomId: string; workId: string }
  ): Promise<WorkspaceHumanWorkView> {
    assertOpaqueId(input.roomId, "room_id_invalid");
    assertOpaqueId(input.workId, "room_work_id_invalid");
    return this.database.withContext(context, async (sql) => {
      const value = await this.readHumanWorkAggregate(sql, context.workspaceId, input.workId, input.roomId, undefined, true);
      return value as WorkspaceHumanWorkView;
    });
  }

  /** Append an explicit Agent instruction to an existing Room work. */
  async replyToRoomWork(context: WorkspaceRequestContext, input: ReplyToRoomWorkInput): Promise<WorkspaceHumanWorkInstruction> {
    assertOpaqueId(input.roomId, "room_id_invalid");
    assertOpaqueId(input.workId, "room_work_id_invalid");
    if (input.assigneeId) assertOpaqueId(input.assigneeId, "room_work_assignment_id_invalid");
    const attachments = normalizeRoomWorkAttachmentRefs(input.attachments);
    const resourceRefs = normalizeRoomWorkResourceRefs(input.resourceRefs);
    const body = input.instruction?.trim()
      || (resourceRefs.length > 0 ? "Review the referenced resources." : attachments.length > 0 ? "Review the attached resources." : "");
    if (!body) throw new WorkspaceServerError("room_work_instruction_required", 400);
    const instructionId = operationScopedId("room_work_instruction", `${context.workspaceId}:${input.workId}`, context.operationId);
    const requestInput = {
      roomId: input.roomId,
      workId: input.workId,
      assigneeId: input.assigneeId ?? null,
      instruction: input.instruction ?? null,
      attachments,
      ...(input.resourceRefs === undefined ? {} : { resourceRefs }),
      expectedVersion: input.expectedVersion ?? null,
      expectedGeneration: input.expectedGeneration ?? null
    };
    const result = await this.runIdempotentResult(context, { action: "room.work.reply", input: requestInput }, async (sql) => {
      const work = await this.readHumanWorkAggregate(sql, context.workspaceId, input.workId, input.roomId);
      await assertRoomWorkAttachmentRefs(sql, context, input.roomId, attachments);
      const canonicalResourceRefs = await resolveRoomWorkResourceRefs(sql, context, input.roomId, resourceRefs);
      const expectedVersion = input.expectedVersion ?? work.instructionVersion;
      const expectedGeneration = input.expectedGeneration ?? work.controlGeneration;
      assertExpectedVersion(expectedVersion, "room_work_instruction_version_invalid", 1);
      assertExpectedVersion(expectedGeneration, "room_work_generation_invalid", 0);
      try {
        await sql.query(
          "SELECT samurai_append_human_work_instruction($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::JSONB, $11::JSONB, $12, $13)",
          [context.workspaceId, instructionId, input.workId, input.assigneeId ?? null, body, expectedVersion, "reply", null, null, canonicalJson(attachments), canonicalJson(canonicalResourceRefs), expectedGeneration, context.operationId]
        );
      } catch (error) {
        throw mapRoomWorkPostgresError(error, "room_work_reply_failed");
      }
      const row = (await sql.query<HumanWorkInstructionRow>(
        `SELECT workspace_id, id, work_id, assignment_id, room_id, version, body, attachment_refs, resource_refs,
                source_kind, source_comment_id, source_comment_version, state, created_by, created_at
         FROM workspace_human_work_instructions WHERE workspace_id = $1 AND id = $2`,
        [context.workspaceId, instructionId]
      )).rows[0];
      if (!row) throw new WorkspaceServerError("room_work_instruction_creation_failed", 500);
      const instruction = humanWorkInstructionFromRow(row);
      await this.insertEvent(sql, context, {
        roomId: input.roomId,
        kind: "room.work.instruction.created",
        recordType: "room_work_instruction",
        recordId: instruction.id,
        payload: { work_id: input.workId, version: instruction.version, source_kind: "reply" }
      });
      await this.insertAudit(sql, context, {
        action: "room.work.reply",
        roomId: input.roomId,
        subjectKind: "room_work_instruction",
        subjectId: instruction.id,
        beforeVersion: expectedVersion,
        afterVersion: instruction.version,
        details: { work_id: input.workId, assignment_id: input.assigneeId ?? null }
      });
      return instruction;
    });
    return { ...result.value, replayed: result.replayed } as WorkspaceHumanWorkInstruction;
  }

  /** Store human discussion separately from Agent instructions. */
  async createRoomWorkComment(context: WorkspaceRequestContext, input: CreateRoomWorkCommentInput): Promise<WorkspaceHumanWorkComment> {
    assertOpaqueId(input.roomId, "room_id_invalid");
    assertOpaqueId(input.workId, "room_work_id_invalid");
    const attachments = normalizeRoomWorkAttachmentRefs(input.attachments);
    const body = input.body?.trim() ?? "";
    if (!body && attachments.length === 0) throw new WorkspaceServerError("room_work_comment_requires_body_or_attachment", 400);
    const commentId = operationScopedId("room_work_comment", `${context.workspaceId}:${input.workId}`, context.operationId);
    const result = await this.runIdempotentResult(context, {
      action: "room.work.comment.create",
      input: { roomId: input.roomId, workId: input.workId, body, attachments, expectedVersion: input.expectedVersion ?? null }
    }, async (sql) => {
      await this.readHumanWorkAggregate(sql, context.workspaceId, input.workId, input.roomId);
      await assertRoomWorkAttachmentRefs(sql, context, input.roomId, attachments);
      try {
        await sql.query(
          "SELECT samurai_add_human_work_comment($1, $2, $3, $4, $5, $6::JSONB, $7, $8)",
          [context.workspaceId, commentId, input.workId, input.roomId, body, canonicalJson(attachments), input.expectedVersion ?? null, context.operationId]
        );
      } catch (error) {
        throw mapRoomWorkPostgresError(error, "room_work_comment_creation_failed");
      }
      const row = (await sql.query<HumanWorkCommentRow>(
        `SELECT workspace_id, id, work_id, room_id, author_account_id, version, body,
                attachment_refs, created_at
         FROM workspace_human_work_comments WHERE workspace_id = $1 AND id = $2`,
        [context.workspaceId, commentId]
      )).rows[0];
      if (!row) throw new WorkspaceServerError("room_work_comment_creation_failed", 500);
      const comment = humanWorkCommentFromRow(row, 0, []);
      await this.insertEvent(sql, context, {
        roomId: input.roomId,
        kind: "room.work.comment.created",
        recordType: "room_work_comment",
        recordId: comment.id,
        payload: { work_id: input.workId, version: comment.version }
      });
      await this.insertAudit(sql, context, {
        action: "room.work.comment.create",
        roomId: input.roomId,
        subjectKind: "room_work_comment",
        subjectId: comment.id,
        beforeVersion: input.expectedVersion ?? 0,
        afterVersion: comment.version,
        details: { work_id: input.workId, attachment_count: attachments.length }
      });
      return comment;
    });
    return { ...result.value, replayed: result.replayed } as WorkspaceHumanWorkComment;
  }

  /** Persist one human like/unlike row; it never becomes an instruction. */
  async setRoomWorkCommentReaction(context: WorkspaceRequestContext, input: SetRoomWorkCommentReactionInput): Promise<WorkspaceHumanWorkReaction> {
    assertOpaqueId(input.roomId, "room_id_invalid");
    assertOpaqueId(input.workId, "room_work_id_invalid");
    assertOpaqueId(input.commentId, "room_work_comment_id_invalid");
    if (input.reaction !== "like") throw new WorkspaceServerError("room_work_reaction_invalid", 400);
    const reactionId = operationScopedId("room_work_reaction", `${context.workspaceId}:${input.commentId}:${context.accountId}`, context.operationId);
    const result = await this.runIdempotentResult(context, {
      action: "room.work.comment.reaction.set",
      input: { roomId: input.roomId, workId: input.workId, commentId: input.commentId, reaction: input.reaction, enabled: input.enabled, expectedVersion: input.expectedVersion ?? null }
    }, async (sql) => {
      try {
        await sql.query(
          "SELECT samurai_set_human_work_comment_reaction($1, $2, $3, $4, $5, $6, $7, $8, $9)",
          [context.workspaceId, reactionId, input.workId, input.roomId, input.commentId, input.reaction, input.enabled, input.expectedVersion ?? null, context.operationId]
        );
      } catch (error) {
        throw mapRoomWorkPostgresError(error, "room_work_reaction_update_failed");
      }
      const row = (await sql.query<HumanWorkReactionRow>(
        `SELECT workspace_id, id, work_id, room_id, comment_id, actor_account_id, reaction,
                enabled, version, created_at, updated_at
         FROM workspace_human_work_comment_reactions WHERE workspace_id = $1
           AND comment_id = $2 AND actor_account_id = $3 AND reaction = $4`,
        [context.workspaceId, input.commentId, context.accountId, input.reaction]
      )).rows[0];
      if (!row) throw new WorkspaceServerError("room_work_reaction_update_failed", 500);
      const reaction = humanWorkReactionFromRow(row);
      await this.insertEvent(sql, context, {
        roomId: input.roomId,
        kind: "room.work.comment.reaction.changed",
        recordType: "room_work_reaction",
        recordId: reaction.id,
        payload: { work_id: input.workId, comment_id: input.commentId, reaction: reaction.reaction, enabled: reaction.enabled, version: reaction.version }
      });
      await this.insertAudit(sql, context, {
        action: "room.work.comment.reaction.set",
        roomId: input.roomId,
        subjectKind: "room_work_reaction",
        subjectId: reaction.id,
        beforeVersion: input.expectedVersion ?? 0,
        afterVersion: reaction.version,
        details: { work_id: input.workId, comment_id: input.commentId, reaction: reaction.reaction, enabled: reaction.enabled }
      });
      return reaction;
    });
    return { ...result.value, replayed: result.replayed } as WorkspaceHumanWorkReaction;
  }

  /** Apply a server-loaded comment snapshot as an explicit instruction. */
  async applyRoomWorkComment(context: WorkspaceRequestContext, input: ApplyRoomWorkCommentInput): Promise<WorkspaceHumanWorkInstruction> {
    assertOpaqueId(input.roomId, "room_id_invalid");
    assertOpaqueId(input.workId, "room_work_id_invalid");
    assertOpaqueId(input.commentId, "room_work_comment_id_invalid");
    if (input.assigneeId) assertOpaqueId(input.assigneeId, "room_work_assignment_id_invalid");
    assertExpectedVersion(input.commentVersion, "room_work_comment_version_invalid", 1);
    const instructionId = operationScopedId("room_work_instruction", `${context.workspaceId}:${input.workId}`, context.operationId);
    const result = await this.runIdempotentResult(context, {
      action: "room.work.comment.apply",
      input: { roomId: input.roomId, workId: input.workId, commentId: input.commentId, commentVersion: input.commentVersion, assigneeId: input.assigneeId ?? null, expectedVersion: input.expectedVersion ?? null, expectedGeneration: input.expectedGeneration ?? null }
    }, async (sql) => {
      const work = await this.readHumanWorkAggregate(sql, context.workspaceId, input.workId, input.roomId);
      const expectedVersion = input.expectedVersion ?? work.instructionVersion;
      const expectedGeneration = input.expectedGeneration ?? work.controlGeneration;
      assertExpectedVersion(expectedVersion, "room_work_instruction_version_invalid", 1);
      assertExpectedVersion(expectedGeneration, "room_work_generation_invalid", 0);
      const comment = (await sql.query<HumanWorkCommentRow>(
        `SELECT workspace_id, id, work_id, room_id, author_account_id, version, body,
                samurai_project_human_work_attachment_refs(workspace_id, room_id, attachment_refs) AS attachment_refs,
                created_at
         FROM workspace_human_work_comments
         WHERE workspace_id = $1 AND id = $2 AND work_id = $3 AND room_id = $4 AND version = $5`,
        [context.workspaceId, input.commentId, input.workId, input.roomId, input.commentVersion]
      )).rows[0];
      if (!comment) throw new WorkspaceServerError("human_work_comment_snapshot_invalid", 409);
      if (hasLegacyUnresolvedAttachmentMarker(comment.attachment_refs)) {
        throw new WorkspaceServerError("room_work_attachment_reference_unavailable", 409);
      }
      const attachments = normalizeRoomWorkAttachmentRefsForRead(comment.attachment_refs);
      const body = comment.body.trim() || (attachments.length > 0 ? "Review the attached resources." : "");
      if (!body) throw new WorkspaceServerError("human_work_comment_snapshot_invalid", 409);
      await assertRoomWorkAttachmentRefs(sql, context, input.roomId, attachments);
      try {
        await sql.query(
          "SELECT samurai_append_human_work_instruction($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::JSONB, $11, $12)",
          [context.workspaceId, instructionId, input.workId, input.assigneeId ?? null, body, expectedVersion, "comment_reflection", input.commentId, input.commentVersion, canonicalJson(attachments), expectedGeneration, context.operationId]
        );
      } catch (error) {
        throw mapRoomWorkPostgresError(error, "room_work_comment_apply_failed");
      }
      const row = (await sql.query<HumanWorkInstructionRow>(
        `SELECT workspace_id, id, work_id, assignment_id, room_id, version, body, attachment_refs,
                source_kind, source_comment_id, source_comment_version, state, created_by, created_at
         FROM workspace_human_work_instructions WHERE workspace_id = $1 AND id = $2`,
        [context.workspaceId, instructionId]
      )).rows[0];
      if (!row) throw new WorkspaceServerError("room_work_instruction_creation_failed", 500);
      const instruction = humanWorkInstructionFromRow(row);
      await this.insertEvent(sql, context, {
        roomId: input.roomId,
        kind: "room.work.comment.applied",
        recordType: "room_work_instruction",
        recordId: instruction.id,
        payload: { work_id: input.workId, comment_id: input.commentId, comment_version: input.commentVersion, version: instruction.version }
      });
      await this.insertAudit(sql, context, {
        action: "room.work.comment.apply",
        roomId: input.roomId,
        subjectKind: "room_work_instruction",
        subjectId: instruction.id,
        beforeVersion: expectedVersion,
        afterVersion: instruction.version,
        details: { work_id: input.workId, comment_id: input.commentId, comment_version: input.commentVersion }
      });
      return instruction;
    });
    return { ...result.value, replayed: result.replayed } as WorkspaceHumanWorkInstruction;
  }

  async stopRoomWork(context: WorkspaceRequestContext, input: StopRoomWorkInput): Promise<WorkspaceHumanWorkControl> {
    return this.changeRoomWorkControl(context, input, "stop_request");
  }

  async stopRoomWorkAssignee(context: WorkspaceRequestContext, input: StopRoomWorkAssigneeInput): Promise<WorkspaceHumanWorkControl> {
    assertOpaqueId(input.assigneeId, "room_work_assignment_id_invalid");
    return this.changeRoomWorkControl(context, input, "assignment_stop", input.assigneeId);
  }

  /** Explicit terminal confirmation is separate from the initial stop request. */
  async confirmRoomWorkStop(context: WorkspaceRequestContext, input: StopRoomWorkInput): Promise<WorkspaceHumanWorkControl> {
    return this.changeRoomWorkControl(context, input, "stop_confirm");
  }

  /** Record that a stop could not be confirmed because an external run's outcome is unknown. */
  async markRoomWorkStopUnconfirmed(context: WorkspaceRequestContext, input: StopRoomWorkInput): Promise<WorkspaceHumanWorkControl> {
    return this.changeRoomWorkControl(context, input, "stop_unconfirmed");
  }

  private async changeRoomWorkControl(
    context: WorkspaceRequestContext,
    input: StopRoomWorkInput,
    action: WorkspaceHumanWorkControlAction,
    assignmentId?: string
  ): Promise<WorkspaceHumanWorkControl> {
    assertOpaqueId(input.roomId, "room_id_invalid");
    assertOpaqueId(input.workId, "room_work_id_invalid");
    if (input.reason !== undefined && (!input.reason.trim() || input.reason.trim().length > 2_000)) {
      throw new WorkspaceServerError("room_work_control_reason_invalid", 400);
    }
    const controlId = operationScopedId("room_work_control", `${context.workspaceId}:${input.workId}:${action}`, context.operationId);
    const result = await this.runIdempotentResult(context, {
      action: `room.work.${action}`,
      input: { roomId: input.roomId, workId: input.workId, assignmentId: assignmentId ?? null, reason: input.reason ?? null, expectedVersion: input.expectedVersion ?? null, expectedGeneration: input.expectedGeneration ?? null }
    }, async (sql) => {
      const work = await this.readHumanWorkAggregate(sql, context.workspaceId, input.workId, input.roomId);
      const expectedVersion = input.expectedVersion ?? work.instructionVersion;
      const expectedGeneration = input.expectedGeneration ?? work.controlGeneration;
      assertExpectedVersion(expectedVersion, "room_work_instruction_version_invalid", 1);
      assertExpectedVersion(expectedGeneration, "room_work_generation_invalid", 0);
      if (action === "stop_confirm" && work.stopState === "none") {
        throw new WorkspaceServerError("room_work_stop_not_requested", 409);
      }
      try {
        await sql.query(
          "SELECT samurai_control_human_work($1, $2, $3, $4, $5, $6, $7, $8::JSONB)",
          [context.workspaceId, controlId, input.workId, assignmentId ?? null, action, expectedGeneration, context.operationId, canonicalJson({ reason: input.reason?.trim() ?? null, expected_version: expectedVersion })]
        );
      } catch (error) {
        throw mapRoomWorkPostgresError(error, "room_work_control_failed");
      }
      const row = (await sql.query<HumanWorkControlRow>(
        `SELECT workspace_id, id, work_id, assignment_id, room_id, action, state,
                actor_account_id, generation, operation_id, details, created_at, updated_at
         FROM workspace_human_work_controls WHERE workspace_id = $1 AND id = $2`,
        [context.workspaceId, controlId]
      )).rows[0];
      if (!row) throw new WorkspaceServerError("room_work_control_failed", 500);
      const control = humanWorkControlFromRow(row);
      await this.insertEvent(sql, context, {
        roomId: input.roomId,
        kind: "room.work.control.changed",
        recordType: "room_work_control",
        recordId: control.id,
        payload: { work_id: input.workId, action: control.action, state: control.state, generation: control.generation }
      });
      await this.insertAudit(sql, context, {
        action: `room.work.${action}`,
        roomId: input.roomId,
        subjectKind: "room_work_control",
        subjectId: control.id,
        beforeVersion: expectedVersion,
        afterVersion: control.generation,
        details: { work_id: input.workId, assignment_id: assignmentId ?? null, reason: input.reason?.trim() ?? null }
      });
      return control;
    });
    return { ...result.value, replayed: result.replayed } as WorkspaceHumanWorkControl;
  }

  async reassignRoomWorkAssignee(context: WorkspaceRequestContext, input: ReassignRoomWorkAssigneeInput): Promise<WorkspaceHumanWorkAssignment> {
    assertOpaqueId(input.roomId, "room_id_invalid");
    assertOpaqueId(input.workId, "room_work_id_invalid");
    assertOpaqueId(input.assigneeId, "room_work_assignment_id_invalid");
    assertOpaqueId(input.agentId, "workspace_agent_id_invalid");
    const newAssignmentId = operationScopedId("room_work_assignment", `${context.workspaceId}:${input.workId}`, context.operationId);
    const reservationId = operationScopedId("room_work_reservation", `${context.workspaceId}:${input.workId}`, context.operationId);
    const result = await this.runIdempotentResult(context, {
      action: "room.work.assignee.reassign",
      input: { roomId: input.roomId, workId: input.workId, assigneeId: input.assigneeId, agentId: input.agentId, instruction: input.instruction ?? null, expectedVersion: input.expectedVersion ?? null, expectedGeneration: input.expectedGeneration ?? null }
    }, async (sql) => {
      const work = await this.readHumanWorkAggregate(sql, context.workspaceId, input.workId, input.roomId);
      const expectedVersion = input.expectedVersion ?? work.instructionVersion;
      const expectedGeneration = input.expectedGeneration ?? work.controlGeneration;
      assertExpectedVersion(expectedVersion, "room_work_instruction_version_invalid", 1);
      assertExpectedVersion(expectedGeneration, "room_work_generation_invalid", 0);
      const agent = (await sql.query<{ version: number | string }>(
        `SELECT version FROM workspace_agents WHERE workspace_id = $1 AND id = $2`,
        [context.workspaceId, input.agentId]
      )).rows[0];
      if (!agent) throw new WorkspaceServerError("workspace_agent_not_active", 409);
      const latest = work.assignments.find((assignment) => assignment.id === input.assigneeId);
      const latestInstruction = (await sql.query<{ body: string; attachment_refs: unknown }>(
        `SELECT body, attachment_refs FROM workspace_human_work_instructions
         WHERE workspace_id = $1 AND work_id = $2 ORDER BY version DESC LIMIT 1`,
        [context.workspaceId, input.workId]
      )).rows[0];
      const instruction = input.instruction?.trim() || latestInstruction?.body?.trim() || work.objective;
      if (!instruction) throw new WorkspaceServerError("room_work_instruction_required", 400);
      try {
        await sql.query(
          "SELECT samurai_reassign_human_work($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
          [context.workspaceId, input.workId, input.assigneeId, newAssignmentId, input.agentId, Number(agent.version), instruction, reservationId, expectedGeneration, context.operationId]
        );
      } catch (error) {
        throw mapRoomWorkPostgresError(error, "room_work_reassign_failed");
      }
      const row = (await sql.query<HumanWorkAssignmentRow>(
        `SELECT workspace_id, id, work_id, room_id, parent_assignment_id, dependency_assignment_ids, agent_id,
                agent_version, instruction_version, attempt, priority, status, current_run_id,
                result, lease_owner, lease_expires_at, created_at, updated_at, started_at, completed_at
         FROM workspace_human_work_assignments WHERE workspace_id = $1 AND id = $2`,
        [context.workspaceId, newAssignmentId]
      )).rows[0];
      if (!row) throw new WorkspaceServerError("room_work_reassign_failed", 500);
      const assignment = humanWorkAssignmentFromRow(row, expectedGeneration);
      await this.insertEvent(sql, context, {
        roomId: input.roomId,
        kind: "room.work.assignee.reassigned",
        recordType: "room_work_assignment",
        recordId: assignment.id,
        payload: { work_id: input.workId, previous_assignment_id: input.assigneeId, agent_id: assignment.agentId, generation: expectedGeneration }
      });
      await this.insertAudit(sql, context, {
        action: "room.work.assignee.reassign",
        roomId: input.roomId,
        subjectKind: "room_work_assignment",
        subjectId: assignment.id,
        beforeVersion: expectedVersion,
        afterVersion: assignment.instructionVersion,
        details: { work_id: input.workId, previous_assignment_id: input.assigneeId, agent_id: input.agentId, previous_agent_id: latest?.agentId ?? null }
      });
      return assignment;
    });
    return { ...result.value, replayed: result.replayed } as WorkspaceHumanWorkAssignment;
  }

  /**
   * Atomically append a bounded child assignment, its delegated instruction,
   * and the launch reservation.  The SQL function owns all authority checks;
   * this adapter only supplies IDs derived from the trusted operation context
   * and returns the resulting assignment projection.
   */
  async delegateRoomWorkAssignee(context: WorkspaceRequestContext, input: DelegateRoomWorkAssigneeInput): Promise<WorkspaceHumanWorkAssignment> {
    assertOpaqueId(input.roomId, "room_id_invalid");
    assertOpaqueId(input.workId, "room_work_id_invalid");
    assertOpaqueId(input.assigneeId, "room_work_assignment_id_invalid");
    assertOpaqueId(input.agentId, "workspace_agent_id_invalid");
    const instruction = input.instruction.trim();
    if (!instruction) throw new WorkspaceServerError("room_work_instruction_required", 400);
    const dependencies = [...new Set((input.dependencyAssigneeIds ?? []).map((id) => id.trim()).filter(Boolean))];
    for (const id of dependencies) assertOpaqueId(id, "room_work_dependency_assignment_id_invalid");
    const attachments = normalizeRoomWorkAttachmentRefs(input.attachments);
    const childAssignmentId = operationScopedId("room_work_assignment", `${context.workspaceId}:${input.workId}`, context.operationId);
    const instructionId = operationScopedId("room_work_instruction", `${context.workspaceId}:${input.workId}`, context.operationId);
    const reservationId = operationScopedId("room_work_reservation", `${context.workspaceId}:${input.workId}`, context.operationId);
    const result = await this.runIdempotentResult(context, {
      action: "room.work.assignee.delegate",
      input: {
        roomId: input.roomId,
        workId: input.workId,
        assigneeId: input.assigneeId,
        agentId: input.agentId,
        instruction,
        dependencyAssigneeIds: dependencies,
        attachments,
        expectedVersion: input.expectedVersion ?? null,
        expectedGeneration: input.expectedGeneration ?? null
      }
    }, async (sql) => {
      const work = await this.readHumanWorkAggregate(sql, context.workspaceId, input.workId, input.roomId);
      await assertRoomWorkAttachmentRefs(sql, context, input.roomId, attachments);
      const expectedGeneration = input.expectedGeneration ?? work.controlGeneration;
      const expectedVersion = input.expectedVersion ?? work.instructionVersion;
      assertExpectedVersion(expectedVersion, "room_work_instruction_version_invalid", 1);
      assertExpectedVersion(expectedGeneration, "room_work_generation_invalid", 0);
      if (input.expectedGeneration !== undefined && input.expectedGeneration !== work.controlGeneration) {
        throw new WorkspaceServerError("room_work_generation_conflict", 409);
      }
      try {
        await sql.query(
          "SELECT samurai_delegate_human_work($1, $2, $3, $4, $5, $6, $7, $8, $9::JSONB, $10::JSONB, $11, $12, $13)",
          [
            context.workspaceId,
            input.workId,
            input.assigneeId,
            childAssignmentId,
            instructionId,
            reservationId,
            input.agentId,
            instruction,
            canonicalJson(attachments),
            canonicalJson(dependencies),
            expectedGeneration,
            context.operationId,
            null
          ]
        );
      } catch (error) {
        throw mapRoomWorkPostgresError(error, "room_work_delegate_failed");
      }
      const row = (await sql.query<HumanWorkAssignmentRow>(
        `SELECT workspace_id, id, work_id, room_id, parent_assignment_id, dependency_assignment_ids, agent_id,
                agent_version, instruction_version, attempt, priority, status, current_run_id,
                result, lease_owner, lease_expires_at, created_at, updated_at, started_at, completed_at
         FROM workspace_human_work_assignments WHERE workspace_id = $1 AND id = $2`,
        [context.workspaceId, childAssignmentId]
      )).rows[0];
      if (!row) throw new WorkspaceServerError("room_work_delegate_failed", 500);
      const assignment = humanWorkAssignmentFromRow(row, work.controlGeneration);
      await this.insertEvent(sql, context, {
        roomId: input.roomId,
        kind: "room.work.assignee.delegated",
        recordType: "room_work_assignment",
        recordId: assignment.id,
        payload: {
          work_id: input.workId,
          parent_assignment_id: input.assigneeId,
          assignee_id: assignment.id,
          agent_id: assignment.agentId,
          dependency_assignment_ids: dependencies,
          status: assignment.status,
          generation: assignment.generation
        }
      });
      await this.insertAudit(sql, context, {
        action: "room.work.assignee.delegate",
        roomId: input.roomId,
        subjectKind: "room_work_assignment",
        subjectId: assignment.id,
        beforeVersion: expectedVersion,
        afterVersion: assignment.instructionVersion,
        details: {
          work_id: input.workId,
          parent_assignment_id: input.assigneeId,
          agent_id: input.agentId,
          dependency_assignment_ids: dependencies,
          reservation_id: reservationId
        }
      });
      return assignment;
    });
    return { ...result.value, replayed: result.replayed } as WorkspaceHumanWorkAssignment;
  }

  /**
   * Runtime-only delegation entrypoint.  The caller must provide the
   * server-admitted parent Run; Work/Room/parent Assignment/requester and
   * the parent Agent/Backend/Session binding are reconstructed and checked by
   * samurai_delegate_human_work_from_runtime.  No model or public API field
   * can select those associations.
   */
  async delegateRoomWorkAssigneeFromRuntime(
    context: WorkspaceRequestContext,
    input: DelegateRoomWorkAssigneeFromRuntimeInput
  ): Promise<WorkspaceHumanWorkAssignment> {
    assertOpaqueId(input.parentRunId, "backend_run_id_invalid");
    assertOpaqueId(input.agentId, "workspace_agent_id_invalid");
    const instruction = input.instruction.trim();
    if (!instruction) throw new WorkspaceServerError("room_work_instruction_required", 400);
    const dependencies = [...new Set((input.dependencyAssigneeIds ?? []).map((id) => id.trim()).filter(Boolean))];
    for (const id of dependencies) assertOpaqueId(id, "room_work_dependency_assignment_id_invalid");
    assertExpectedVersion(input.expectedGeneration, "room_work_generation_invalid", 0);
    const attachments = normalizeRoomWorkAttachmentRefs(input.attachments);
    const childAssignmentId = operationScopedId("room_work_assignment", context.workspaceId, context.operationId);
    const instructionId = operationScopedId("room_work_instruction", context.workspaceId, context.operationId);
    const reservationId = operationScopedId("room_work_reservation", context.workspaceId, context.operationId);
    const result = await this.runIdempotentResult(context, {
      action: "room.work.assignee.delegate",
      input: {
        trustedParentRunId: input.parentRunId,
        agentId: input.agentId,
        instruction,
        dependencyAssigneeIds: dependencies,
        attachments,
        expectedGeneration: input.expectedGeneration
      }
    }, async (sql) => {
      try {
        await sql.query(
          "SELECT samurai_delegate_human_work_from_runtime($1, $2, $3, $4, $5, $6, $7, $8::JSONB, $9::JSONB, $10, $11)",
          [
            context.workspaceId,
            input.parentRunId,
            childAssignmentId,
            instructionId,
            reservationId,
            input.agentId,
            instruction,
            canonicalJson(attachments),
            canonicalJson(dependencies),
            input.expectedGeneration,
            context.operationId
          ]
        );
      } catch (error) {
        throw mapRoomWorkPostgresError(error, "room_work_runtime_delegate_failed");
      }
      const row = (await sql.query<HumanWorkAssignmentRow>(
        `SELECT workspace_id, id, work_id, room_id, parent_assignment_id, dependency_assignment_ids, agent_id,
                agent_version, instruction_version, attempt, priority, status, current_run_id,
                result, lease_owner, lease_expires_at, created_at, updated_at, started_at, completed_at
         FROM workspace_human_work_assignments WHERE workspace_id = $1 AND id = $2`,
        [context.workspaceId, childAssignmentId]
      )).rows[0];
      if (!row) throw new WorkspaceServerError("room_work_runtime_delegate_failed", 500);
      const assignment = humanWorkAssignmentFromRow(row, input.expectedGeneration);
      await this.insertEvent(sql, context, {
        roomId: row.room_id,
        kind: "room.work.assignee.delegated",
        recordType: "room_work_assignment",
        recordId: assignment.id,
        payload: {
          work_id: assignment.workId,
          parent_assignment_id: assignment.parentAssignmentId ?? null,
          assignee_id: assignment.id,
          agent_id: assignment.agentId,
          dependency_assignment_ids: dependencies,
          status: assignment.status,
          generation: assignment.generation,
          source: "runtime_trusted_binding"
        }
      });
      await this.insertAudit(sql, context, {
        action: "room.work.assignee.delegate",
        roomId: row.room_id,
        subjectKind: "room_work_assignment",
        subjectId: assignment.id,
        afterVersion: assignment.instructionVersion,
        details: {
          work_id: assignment.workId,
          parent_assignment_id: assignment.parentAssignmentId ?? null,
          agent_id: assignment.agentId,
          dependency_assignment_ids: dependencies,
          reservation_id: reservationId,
          parent_run_id: input.parentRunId
        }
      });
      return assignment;
    });
    return { ...result.value, replayed: result.replayed } as WorkspaceHumanWorkAssignment;
  }

  /**
   * Lease one accepted Room-work stop control for the process-owned worker.
   * This does not contact a Backend: it only obtains the durable targets that
   * were associated with the control while the Work row was locked.  Calling
   * Runtime cancellation inside this transaction would make an external
   * process part of the database commit and is deliberately avoided.
   */
  async claimRoomWorkStopDispatch(
    context: WorkspaceRequestContext,
    input: { workerId: string; leaseMs: number; now?: string; limit?: number }
  ): Promise<Record<string, unknown> | undefined> {
    assertOpaqueId(input.workerId, "room_work_worker_id_invalid");
    if (!Number.isSafeInteger(input.leaseMs) || input.leaseMs < 1_000 || input.leaseMs > 86_400_000) {
      throw new WorkspaceServerError("room_work_stop_lease_invalid", 400);
    }
    const now = parseDateInput(input.now, "room_work_stop_now_invalid") ?? new Date();
    const limit = boundedLimit(input.limit ?? 1);
    const leaseExpiresAt = new Date(now.getTime() + input.leaseMs);
    return this.database.withContext(context, async (sql) => {
      const candidates = await sql.query<{ id: string }>(
        `SELECT id
         FROM workspace_human_work_controls
         WHERE workspace_id = $1
           AND action IN ('stop_request', 'assignment_stop')
           AND (
             action = 'assignment_stop'
             OR EXISTS (
               SELECT 1
               FROM workspace_human_works AS work
               WHERE work.workspace_id = workspace_human_work_controls.workspace_id
                 AND work.id = workspace_human_work_controls.work_id
                 AND work.control_generation = workspace_human_work_controls.generation
             )
           )
           AND state IN ('accepted', 'pending', 'unconfirmed')
           AND (
             state <> 'pending'
             OR lease_expires_at IS NULL
             OR lease_expires_at <= $2::TIMESTAMPTZ
             OR lease_owner = $3
           )
         ORDER BY updated_at, id
         LIMIT $4`,
        [context.workspaceId, now.toISOString(), input.workerId, limit]
      );
      for (const candidate of candidates.rows) {
        const operationId = operationScopedId(
          "room_work_stop_dispatch",
          `${context.workspaceId}:${candidate.id}:${input.workerId}`,
          context.operationId
        );
        try {
          const result = await sql.query<{ dispatch: unknown }>(
            "SELECT samurai_claim_human_work_stop_dispatch($1, $2, $3, $4::TIMESTAMPTZ, $5) AS dispatch",
            [context.workspaceId, candidate.id, input.workerId, leaseExpiresAt.toISOString(), operationId]
          );
          const dispatch = jsonObjectOrEmpty(result.rows[0]?.dispatch);
          if (typeof dispatch.control_id === "string" && dispatch.control_id) return dispatch;
        } catch (error) {
          const mapped = mapRoomWorkPostgresError(error, "room_work_stop_dispatch_claim_failed");
          if (mapped instanceof WorkspaceServerError && new Set([
            "room_work_stop_lease_conflict",
            "room_work_stop_not_dispatchable",
            "room_work_stop_control_not_found",
            "room_work_stop_generation_conflict"
          ]).has(mapped.code)) continue;
          throw mapped;
        }
      }
      return undefined;
    });
  }

  /**
   * Persist Runtime terminal evidence against a leased stop control.  SQL
   * validates the Run-to-assignment binding before it changes a Room-work
   * state, so a caller cannot turn an arbitrary external Run into stop proof.
   */
  async reconcileRoomWorkStopDispatch(
    context: WorkspaceRequestContext,
    input: {
      controlId: string;
      workerId: string;
      assignmentId: string;
      runId?: string;
      outcome: "completed" | "failed" | "cancelled" | "outcome_unknown";
    }
  ): Promise<Record<string, unknown>> {
    assertOpaqueId(input.controlId, "room_work_control_id_invalid");
    assertOpaqueId(input.workerId, "room_work_worker_id_invalid");
    assertOpaqueId(input.assignmentId, "room_work_assignment_id_invalid");
    if (input.runId !== undefined) assertOpaqueId(input.runId, "backend_run_id_invalid");
    const operationId = operationScopedId(
      "room_work_stop_reconcile",
      `${context.workspaceId}:${input.controlId}:${input.assignmentId}`,
      context.operationId
    );
    return this.database.withContext(context, async (sql) => {
      try {
        const result = await sql.query<{ reconciliation: unknown }>(
          "SELECT samurai_reconcile_human_work_stop_dispatch($1, $2, $3, $4, $5, $6, $7) AS reconciliation",
          [context.workspaceId, input.controlId, input.workerId, input.assignmentId, input.runId ?? null, input.outcome, operationId]
        );
        const reconciliation = jsonObjectOrEmpty(result.rows[0]?.reconciliation);
        if (!reconciliation.control_id) throw new WorkspaceServerError("room_work_stop_dispatch_reconcile_failed", 500);
        return reconciliation;
      } catch (error) {
        throw mapRoomWorkPostgresError(error, "room_work_stop_dispatch_reconcile_failed");
      }
    });
  }

  /** Claim one due launch reservation atomically; no external execution occurs in this transaction. */
  async claimRoomWorkReservation(
    context: WorkspaceRequestContext,
    input: ClaimRoomWorkReservationInput
  ): Promise<Record<string, unknown> | undefined> {
    assertOpaqueId(input.workerId, "room_work_worker_id_invalid");
    if (!Number.isSafeInteger(input.leaseMs) || input.leaseMs < 1_000 || input.leaseMs > 86_400_000) {
      throw new WorkspaceServerError("room_work_lease_invalid", 400);
    }
    const now = parseDateInput(input.now, "room_work_now_invalid") ?? new Date();
    boundedLimit(input.limit ?? 1);
    return this.database.withContext(context, async (sql) => {
      const leaseExpiresAt = new Date(now.getTime() + input.leaseMs);
      const claimOperationId = operationScopedId(
        "room_work_claim",
        context.workspaceId,
        `${input.reservationId ?? "next"}:${input.workerId}:${now.toISOString()}`
      );
      let claim: Record<string, unknown>;
      let claimPhase: "recovery" | "claim" = "recovery";
      try {
        // A worker can disappear after the claim transaction commits but
        // before Runtime admission. Reconcile one expired claimed token
        // under the same transaction before asking the normal claim function
        // for a new reservation. The SQL function owns the lock order and
        // returns either a fresh-claim marker or a recovery marker; a stop or
        // an already running Run is never treated as a new launch.
        const recoveryResult = await sql.query<{ recovery: unknown }>(
          "SELECT samurai_recover_human_work_launch($1, $2, $3, $4::TIMESTAMPTZ) AS recovery",
          [context.workspaceId, input.reservationId ?? null, input.workerId, leaseExpiresAt.toISOString()]
        );
        const recovery = jsonObjectOrEmpty(recoveryResult.rows[0]?.recovery);
        const recoveryKind = typeof recovery.kind === "string" ? recovery.kind : undefined;
        if (recoveryKind === "skip") {
          // Stop/reassignment won the Work lock. Leave a linked Run for the
          // dedicated stop dispatcher; the launch lane must not reconcile it
          // as a normal work completion.
          return undefined;
        } else if (recoveryKind === "recovery") {
          claim = recovery;
        } else if (recoveryKind === "requeued") {
          const recoveredReservationId = typeof recovery.reservation_id === "string"
            ? recovery.reservation_id
            : undefined;
          if (!recoveredReservationId) return undefined;
          claimPhase = "claim";
          const claimResult = await sql.query<{ claim: unknown }>(
            "SELECT samurai_claim_human_work_launch($1, $2, $3, $4::TIMESTAMPTZ, $5) AS claim",
            [context.workspaceId, recoveredReservationId, input.workerId, leaseExpiresAt.toISOString(), claimOperationId]
          );
          claim = jsonObjectOrEmpty(claimResult.rows[0]?.claim);
        } else if (recoveryKind === "cancelled") {
          return undefined;
        } else {
          claimPhase = "claim";
          const claimResult = await sql.query<{ claim: unknown }>(
            "SELECT samurai_claim_human_work_launch($1, $2, $3, $4::TIMESTAMPTZ, $5) AS claim",
            [context.workspaceId, input.reservationId ?? null, input.workerId, leaseExpiresAt.toISOString(), claimOperationId]
          );
          claim = jsonObjectOrEmpty(claimResult.rows[0]?.claim);
        }
      } catch (error) {
        throw mapRoomWorkPostgresError(error, claimPhase === "recovery"
          ? "room_work_launch_recovery_failed"
          : "room_work_launch_claim_failed");
      }
      const reservationId = typeof claim.reservation_id === "string" ? claim.reservation_id : undefined;
      if (!reservationId) return undefined;
      const claimed = (await sql.query<HumanWorkExecutionRow>(
        `SELECT reservation.workspace_id, reservation.id AS reservation_id, reservation.work_id,
                reservation.assignment_id, reservation.room_id, reservation.generation,
                reservation.scheduled_at, work.control_generation, work.instruction_version,
                assignment.agent_id, assignment.agent_version AS agent_configuration_version,
                assignment.current_run_id,
                assignment.origin_kind,
                CASE WHEN parent_assignment.id IS NOT NULL
                  THEN samurai_human_work_assignment_is_superseded(parent_assignment.workspace_id, parent_assignment.id)
                  ELSE FALSE
                END AS parent_assignment_superseded,
                CASE WHEN parent_session.id IS NOT NULL THEN parent_assignment.id ELSE NULL END AS parent_assignment_id,
                CASE WHEN parent_session.id IS NOT NULL THEN parent_assignment.parent_assignment_id ELSE NULL END AS parent_assignment_parent_id,
                CASE WHEN parent_session.id IS NOT NULL THEN parent_run.backend_id ELSE NULL END AS parent_backend_id,
                CASE WHEN parent_session.id IS NOT NULL THEN parent_run.agent_id ELSE NULL END AS parent_agent_id,
                CASE WHEN parent_session.id IS NOT NULL THEN parent_run.backend_session_id ELSE NULL END AS parent_backend_session_id,
                CASE WHEN parent_session.id IS NOT NULL THEN parent_run.metadata -> 'runtime_binding' ELSE NULL::JSONB END AS parent_runtime_binding,
                parent_session.id AS session_id,
                instruction.body AS instruction,
                work.resource_refs AS work_resource_refs,
                instruction.resource_refs AS resource_refs,
                samurai_project_human_work_attachment_refs(
                  reservation.workspace_id, reservation.room_id, instruction.attachment_refs
                ) AS attachments,
                samurai_human_work_attachment_refs_have_unresolved(
                  reservation.workspace_id, reservation.room_id, instruction.attachment_refs
                ) AS attachments_have_unresolved
         FROM workspace_human_work_launch_reservations AS reservation
         JOIN workspace_human_works AS work ON work.workspace_id = reservation.workspace_id AND work.id = reservation.work_id
         JOIN workspace_human_work_assignments AS assignment ON assignment.workspace_id = reservation.workspace_id AND assignment.id = reservation.assignment_id
         JOIN workspace_agents AS child_agent ON child_agent.workspace_id = assignment.workspace_id AND child_agent.id = assignment.agent_id
         LEFT JOIN workspace_human_work_assignments AS parent_assignment
           ON parent_assignment.workspace_id = assignment.workspace_id
           AND parent_assignment.id = assignment.parent_assignment_id
           AND parent_assignment.work_id = reservation.work_id
           AND parent_assignment.room_id = reservation.room_id
           AND parent_assignment.agent_id = assignment.agent_id
           AND parent_assignment.agent_version = assignment.agent_version
           AND parent_assignment.status IN ('completed', 'failed', 'cancelled')
           AND NOT samurai_human_work_assignment_is_superseded(parent_assignment.workspace_id, parent_assignment.id)
           AND assignment.origin_kind = 'parent_continuation'
         LEFT JOIN workspace_runtime_runs AS parent_run
           ON parent_run.workspace_id = parent_assignment.workspace_id
           AND parent_run.id = parent_assignment.current_run_id
           AND parent_run.room_id = reservation.room_id
           AND parent_run.status IN ('completed', 'failed', 'cancelled')
           AND parent_run.requested_by_participant_id = work.requester_account_id
         LEFT JOIN workspace_runtime_sessions AS parent_session
           ON parent_session.workspace_id = parent_run.workspace_id
           AND parent_session.id = parent_run.session_id
           AND parent_session.room_id = reservation.room_id
           AND jsonb_typeof(parent_run.metadata -> 'runtime_binding') = 'object'
           AND parent_run.metadata -> 'runtime_binding' ->> 'workspace_id' = reservation.workspace_id
           AND parent_run.metadata -> 'runtime_binding' ->> 'room_id' = reservation.room_id
           AND parent_run.metadata -> 'runtime_binding' ->> 'session_id' = parent_run.session_id
           AND parent_run.metadata -> 'runtime_binding' ->> 'work_id' = reservation.work_id
           AND parent_run.metadata -> 'runtime_binding' ->> 'assignee_id' = parent_assignment.id
           AND parent_run.metadata -> 'runtime_binding' ->> 'agent_id' = assignment.agent_id
           AND parent_run.agent_id = assignment.agent_id
           AND parent_run.metadata -> 'runtime_binding' ->> 'backend_id' = child_agent.backend_id
           AND parent_run.backend_id = child_agent.backend_id
           AND (parent_run.metadata -> 'runtime_binding' ->> 'agent_configuration_version') ~ '^[0-9]+$'
           AND (parent_run.metadata -> 'runtime_binding' ->> 'agent_configuration_version')::BIGINT = assignment.agent_version
           AND (parent_run.metadata -> 'runtime_binding' ->> 'generation') ~ '^[0-9]+$'
           AND (parent_run.metadata -> 'runtime_binding' ->> 'generation')::BIGINT = reservation.generation
           AND COALESCE(NULLIF(btrim(parent_run.metadata -> 'runtime_binding' ->> 'parent_assignee_id'), ''), '')
             = COALESCE(parent_assignment.parent_assignment_id, '')
           AND (
             jsonb_typeof(parent_run.metadata -> 'runtime_binding' -> 'agent') IS NULL
             OR jsonb_typeof(parent_run.metadata -> 'runtime_binding' -> 'agent') = 'null'
             OR (
               jsonb_typeof(parent_run.metadata -> 'runtime_binding' -> 'agent') = 'object'
               AND (
                 NULLIF(btrim(parent_run.metadata -> 'runtime_binding' -> 'agent' ->> 'backend_id'), '') IS NULL
                 OR parent_run.metadata -> 'runtime_binding' -> 'agent' ->> 'backend_id' = child_agent.backend_id
               )
               AND (
                 NULLIF(btrim(parent_run.metadata -> 'runtime_binding' -> 'agent' ->> 'config_version'), '') IS NULL
                 OR (
                   (parent_run.metadata -> 'runtime_binding' -> 'agent' ->> 'config_version') ~ '^[0-9]+$'
                   AND (parent_run.metadata -> 'runtime_binding' -> 'agent' ->> 'config_version')::BIGINT = assignment.agent_version
                 )
               )
             )
           )
         LEFT JOIN workspace_human_work_instructions AS instruction
           ON instruction.workspace_id = assignment.workspace_id AND instruction.work_id = assignment.work_id AND instruction.version = assignment.instruction_version
         WHERE reservation.workspace_id = $1
           AND reservation.id = $2
           AND NOT samurai_human_work_assignment_is_superseded(assignment.workspace_id, assignment.id)`,
        [context.workspaceId, reservationId]
      )).rows[0];
      if (!claimed || !claimed.instruction) throw new WorkspaceServerError("room_work_instruction_not_found", 500);
      if (claimed.attachments_have_unresolved === true) {
        const preflight = await sql.query<{ failed: boolean }>(
          "SELECT samurai_fail_human_work_launch_preflight($1, $2, $3, $4, $5, $6, $7) AS failed",
          [
            context.workspaceId,
            claimed.work_id,
            claimed.assignment_id,
            claimed.reservation_id,
            input.workerId,
            Number(claimed.generation),
            "room_work_attachment_reference_unavailable"
          ]
        );
        if (preflight.rows[0]?.failed !== true) {
          throw new WorkspaceServerError("room_work_launch_preflight_failed", 409);
        }
        // The reservation and Assignment are now terminally failed in the
        // same transaction. Returning no launch token prevents a worker from
        // treating an unresolved historical reference as an attachment-free
        // execution, while avoiding the old claim/rollback retry loop.
        return undefined;
      }
      const attachments = normalizeRoomWorkAttachmentRefs(claimed.attachments);
      await assertRoomWorkAttachmentRefs(sql, context, claimed.room_id, attachments);
      let resourceRefs: RoomWorkResourceRef[];
      try {
        resourceRefs = await resolveRoomWorkResourceRefs(
          sql,
          context,
          claimed.room_id,
          normalizeRoomWorkResourceRefs(claimed.resource_refs)
        );
        if (claimed.work_resource_refs !== undefined && claimed.work_resource_refs !== null) {
          await resolveRoomWorkResourceRefs(
            sql,
            context,
            claimed.room_id,
            normalizeRoomWorkResourceRefs(claimed.work_resource_refs)
          );
        }
      } catch (error) {
        const reason = error instanceof WorkspaceServerError
          && (error.code === "room_work_resource_reference_scope_invalid"
            || error.code === "room_work_resource_reference_not_found")
          ? error.code
          : "room_work_resource_reference_invalid";
        const preflight = await sql.query<{ failed: boolean }>(
          "SELECT samurai_fail_human_work_launch_preflight($1, $2, $3, $4, $5, $6, $7) AS failed",
          [
            context.workspaceId,
            claimed.work_id,
            claimed.assignment_id,
            claimed.reservation_id,
            input.workerId,
            Number(claimed.generation),
            reason
          ]
        );
        if (preflight.rows[0]?.failed !== true) {
          throw new WorkspaceServerError("room_work_launch_preflight_failed", 409);
        }
        return undefined;
      }
      // The reservation is the claimed execution token.  Returning the Work
      // generation here would let a stale reservation masquerade as a fresh
      // launch after an individual stop/reassign advanced the Work.
      const generation = Number(claimed.generation);
      const parentContinuation = roomWorkParentContinuation(claimed, generation);
      return {
        workId: claimed.work_id,
        work_id: claimed.work_id,
        assigneeId: claimed.assignment_id,
        assignee_id: claimed.assignment_id,
        assignmentId: claimed.assignment_id,
        assignment_id: claimed.assignment_id,
        roomId: claimed.room_id,
        room_id: claimed.room_id,
        agentId: claimed.agent_id,
        agent_id: claimed.agent_id,
        ...(claimed.agent_configuration_version === null || claimed.agent_configuration_version === undefined ? {} : {
          agentConfigurationVersion: Number(claimed.agent_configuration_version),
          agent_configuration_version: Number(claimed.agent_configuration_version)
        }),
        ...(claimed.current_run_id ? { currentRunId: claimed.current_run_id, current_run_id: claimed.current_run_id } : {}),
        ...(claimed.origin_kind ? { originKind: claimed.origin_kind, origin_kind: claimed.origin_kind } : {}),
        ...(parentContinuation?.sessionId ? { sessionId: parentContinuation.sessionId, session_id: parentContinuation.sessionId } : {}),
        ...(parentContinuation?.parentAssigneeId ? {
          parentAssigneeId: parentContinuation.parentAssigneeId,
          parent_assignee_id: parentContinuation.parentAssigneeId
        } : {}),
        ...(parentContinuation?.continuation ? {
          resumeBackendContinuation: parentContinuation.continuation,
          resume_backend_continuation: parentContinuation.continuation
        } : {}),
        instruction: claimed.instruction,
        attachments,
        resourceRefs,
        generation,
        reservationGeneration: generation,
        reservation_generation: generation,
        version: Number(claimed.instruction_version),
        reservationId: claimed.reservation_id,
        reservation_id: claimed.reservation_id,
        leaseOwner: input.workerId,
        lease_owner: input.workerId,
        leaseExpiresAt: leaseExpiresAt.toISOString(),
        lease_expires_at: leaseExpiresAt.toISOString()
      };
    });
  }

  async claimRoomWorkLaunch(context: WorkspaceRequestContext, input: ClaimRoomWorkReservationInput): Promise<Record<string, unknown> | undefined> {
    return this.claimRoomWorkReservation(context, input);
  }

  /** Settle a claimed assignment after the external Backend outcome is known. */
  async settleRoomWorkAssignment(context: WorkspaceRequestContext, input: SettleRoomWorkAssignmentInput): Promise<Record<string, unknown>> {
    const assignmentId = input.assignmentId ?? input.assigneeId;
    if (!assignmentId) throw new WorkspaceServerError("room_work_assignment_id_required", 400);
    assertOpaqueId(assignmentId, "room_work_assignment_id_invalid");
    assertOpaqueId(input.reservationId, "room_work_reservation_id_invalid");
    assertOpaqueId(input.leaseOwner, "room_work_lease_owner_invalid");
    assertExpectedVersion(input.generation, "room_work_generation_invalid", 0);
    const statuses = new Set<WorkspaceHumanWorkAssignmentStatus>(["completed", "failed", "cancelled", "waiting", "blocked", "outcome_unknown"]);
    if (!statuses.has(input.status)) throw new WorkspaceServerError("room_work_assignment_status_invalid", 400);
    const now = parseDateInput(input.now, "room_work_settle_now_invalid") ?? new Date();
    const result = await this.runIdempotentResult(context, {
      action: "room.work.assignment.settle",
      input: { workId: input.workId ?? null, assigneeId: input.assigneeId ?? null, assignmentId, reservationId: input.reservationId, leaseOwner: input.leaseOwner, generation: input.generation, status: input.status, result: input.result ?? null, runId: input.runId ?? null, outputSummary: input.outputSummary ?? null, errorCode: input.errorCode ?? null, errorMessage: input.errorMessage ?? null, now: now.toISOString() }
    }, async (sql) => {
      const row = (await sql.query<{ workspace_id: string; work_id: string; room_id: string; status: string }>(
        `SELECT workspace_id, work_id, room_id, status FROM workspace_human_work_assignments WHERE workspace_id = $1 AND id = $2`,
        [context.workspaceId, assignmentId]
      )).rows[0];
      if (!row) throw new WorkspaceServerError("human_work_assignment_not_found", 404);
      if (input.workId && input.workId !== row.work_id) throw new WorkspaceServerError("human_work_assignment_scope_invalid", 409);
      const settlePayload = {
        ...(input.result ?? {}),
        ...(input.runId ? { run_id: input.runId } : {}),
        ...(input.outputSummary ? { output_summary: input.outputSummary } : {}),
        ...(input.errorCode ? { error_code: input.errorCode } : {}),
        ...(input.errorMessage ? { error_message: input.errorMessage } : {})
      };
      try {
        await sql.query(
          "SELECT samurai_settle_human_work_assignment($1, $2, $3, $4::JSONB, $5, $6, $7, $8)",
          [context.workspaceId, assignmentId, input.status, canonicalJson(settlePayload), input.leaseOwner, input.generation, input.reservationId, context.operationId]
        );
      } catch (error) {
        throw mapRoomWorkPostgresError(error, "room_work_assignment_settle_failed");
      }
      const assignment = (await sql.query<HumanWorkAssignmentRow>(
        `SELECT workspace_id, id, work_id, room_id, parent_assignment_id, dependency_assignment_ids, agent_id,
                agent_version, instruction_version, attempt, priority, status, current_run_id,
                result, lease_owner, lease_expires_at, created_at, updated_at, started_at, completed_at
         FROM workspace_human_work_assignments WHERE workspace_id = $1 AND id = $2`,
        [context.workspaceId, assignmentId]
      )).rows[0];
      if (!assignment) throw new WorkspaceServerError("room_work_assignment_settle_failed", 500);
      const work = await this.readHumanWorkAggregate(sql, context.workspaceId, assignment.work_id, assignment.room_id);
      const mappedAssignment = humanWorkAssignmentFromRow(assignment, work.controlGeneration);
      await this.insertAudit(sql, context, {
        action: "room.work.assignment.settle",
        roomId: assignment.room_id,
        subjectKind: "room_work_assignment",
        subjectId: assignmentId,
        afterVersion: mappedAssignment.instructionVersion,
        details: { work_id: assignment.work_id, status: input.status, run_id: input.runId ?? null }
      });
      return { workId: assignment.work_id, work_id: assignment.work_id, assignmentId, assignment_id: assignmentId, assigneeId: assignmentId, assignee_id: assignmentId, status: mappedAssignment.status, workStatus: work.status, work_status: work.status, assignment: mappedAssignment, work };
    });
    return result.value;
  }

  async completeRoomWorkReservation(context: WorkspaceRequestContext, input: SettleRoomWorkAssignmentInput): Promise<Record<string, unknown>> {
    return this.settleRoomWorkAssignment(context, input);
  }

  async settleRoomWorkReservation(context: WorkspaceRequestContext, input: SettleRoomWorkAssignmentInput): Promise<Record<string, unknown>> {
    return this.settleRoomWorkAssignment(context, input);
  }

  async patchAgent(
    context: WorkspaceRequestContext,
    input: { id: string; name?: string; role?: string; instructions?: string; enabled?: boolean; expectedVersion?: number }
  ): Promise<{ agent: WorkspaceAgent; replayed: boolean }> {
    assertOpaqueId(input.id, "workspace_agent_id_invalid");
    const current = await this.getAgent(context, input.id);
    const expectedVersion = input.expectedVersion ?? current.version;
    assertExpectedVersion(expectedVersion, "workspace_agent_expected_version_invalid", 1);
    const requestInput = {
      id: input.id,
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.role === undefined ? {} : { role: input.role }),
      ...(input.instructions === undefined ? {} : { instructions: input.instructions }),
      ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
      ...(input.expectedVersion === undefined ? {} : { expectedVersion: input.expectedVersion })
    };
    const result = await this.runIdempotentResult(context, { action: "workspace.agent.patch", input: requestInput }, async (sql) => {
      try {
        await sql.query("SELECT samurai_patch_workspace_agent($1, $2, $3, $4, $5, $6, $7)", [context.workspaceId, input.id, input.name ?? null, input.role ?? null, input.instructions ?? null, input.enabled ?? null, expectedVersion]);
      } catch (error) {
        if (postgresMessage(error).includes("workspace_agent_version_conflict")) {
          const latest = await sql.query<{ version: number | string }>("SELECT version FROM workspace_agents WHERE workspace_id = $1 AND id = $2", [context.workspaceId, input.id]);
          throw new WorkspaceServerError("workspace_agent_version_conflict", 409, { latest_version: latest.rows[0] ? Number(latest.rows[0].version) : null });
        }
        throw error;
      }
      const saved = await sql.query<AgentRow>(
        `SELECT workspace_id, id, display_name, description, role, instructions, enabled, backend_id, status, version, created_by, created_at, updated_at
         FROM workspace_agents WHERE workspace_id = $1 AND id = $2`,
        [context.workspaceId, input.id]
      );
      const row = saved.rows[0];
      if (!row) throw new WorkspaceServerError("workspace_agent_not_active", 404);
      const agent = agentFromRow(row);
      await this.insertAudit(sql, context, { action: "workspace.agent.patch", subjectKind: "workspace_agent", subjectId: agent.id, beforeVersion: expectedVersion, afterVersion: agent.version, details: { enabled: agent.enabled ?? agent.status === "active" } });
      return agent;
    });
    return { agent: result.value, replayed: result.replayed };
  }

  async bindAgentBackend(
    context: WorkspaceRequestContext,
    input: { id: string; backendId: string; expectedVersion?: number }
  ): Promise<{ agent: WorkspaceAgent; replayed: boolean }> {
    assertOpaqueId(input.id, "workspace_agent_id_invalid");
    const backendId = normalizeAgentBackendId(input.backendId);
    const current = await this.getAgent(context, input.id);
    const expectedVersion = input.expectedVersion ?? current.version;
    assertExpectedVersion(expectedVersion, "workspace_agent_expected_version_invalid", 1);
    const requestInput = {
      id: input.id,
      backendId,
      ...(input.expectedVersion === undefined ? {} : { expectedVersion: input.expectedVersion })
    };
    const result = await this.runIdempotentResult(context, { action: "workspace.agent.backend.bind", input: requestInput }, async (sql) => {
      try {
        await sql.query("SELECT samurai_set_workspace_agent_backend_v1($1, $2, $3, $4)", [context.workspaceId, input.id, backendId, expectedVersion]);
      } catch (error) {
        if (postgresMessage(error).includes("workspace_agent_version_conflict")) {
          const latest = await sql.query<{ version: number | string }>("SELECT version FROM workspace_agents WHERE workspace_id = $1 AND id = $2", [context.workspaceId, input.id]);
          throw new WorkspaceServerError("workspace_agent_version_conflict", 409, { latest_version: latest.rows[0] ? Number(latest.rows[0].version) : null });
        }
        throw error;
      }
      const saved = await sql.query<AgentRow>(
        `SELECT workspace_id, id, display_name, description, role, instructions, enabled, backend_id, status, version, created_by, created_at, updated_at
         FROM workspace_agents WHERE workspace_id = $1 AND id = $2`,
        [context.workspaceId, input.id]
      );
      const row = saved.rows[0];
      if (!row) throw new WorkspaceServerError("workspace_agent_not_active", 404);
      const agent = agentFromRow(row);
      await this.insertAudit(sql, context, { action: "workspace.agent.backend.bind", subjectKind: "workspace_agent", subjectId: agent.id, beforeVersion: expectedVersion, afterVersion: agent.version, details: { backend_id: agent.backendId } });
      return agent;
    });
    return { agent: result.value, replayed: result.replayed };
  }

  async getAgent(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, agentId: string): Promise<WorkspaceAgent> {
    assertOpaqueId(agentId, "workspace_agent_id_invalid");
    return this.database.withContext(context, async (sql) => {
      const result = await sql.query<AgentRow>(
        `SELECT workspace_id, id, display_name, description, role, instructions, enabled, backend_id, status, version, created_by, created_at, updated_at
         FROM workspace_agents WHERE workspace_id = $1 AND id = $2`,
        [context.workspaceId, agentId]
      );
      const row = result.rows[0];
      if (!row) throw new WorkspaceServerError("workspace_agent_not_found", 404);
      return agentFromRow(row);
    });
  }

  async listAgentRoomPermissions(
    context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">,
    roomId: string
  ): Promise<WorkspaceAgentRoomPermission[]> {
    assertOpaqueId(roomId, "room_id_invalid");
    return this.database.withContext(context, async (sql) => {
      const allowed = await sql.query<{ allowed: boolean }>(
        "SELECT samurai_can_room($1, $2, 'read') AS allowed",
        [context.workspaceId, roomId]
      );
      if (allowed.rows[0]?.allowed !== true) throw new WorkspaceServerError("room_not_available", 404);
      const result = await sql.query<AgentRoomPermissionRow>(
        `SELECT permission.workspace_id, permission.room_id, permission.agent_id,
                permission.can_view, permission.can_edit, permission.can_execute,
                permission.version, permission.created_by, permission.created_at, permission.updated_at
         FROM workspace_agent_room_permissions AS permission
         JOIN rooms AS room ON room.workspace_id = permission.workspace_id AND room.id = permission.room_id
         WHERE permission.workspace_id = $1 AND permission.room_id = $2
           AND (room.room_kind <> 'agent_dm' OR room.default_agent_id = permission.agent_id)
         ORDER BY permission.agent_id`,
        [context.workspaceId, roomId]
      );
      return result.rows.map(agentRoomPermissionFromRow);
    });
  }

  async setAgentRoomPermission(context: WorkspaceRequestContext, input: SetWorkspaceAgentRoomPermissionInput): Promise<{ permission: WorkspaceAgentRoomPermission; event: WorkspaceEvent; replayed: boolean }> {
    assertOpaqueId(input.roomId, "room_id_invalid");
    assertOpaqueId(input.agentId, "workspace_agent_id_invalid");
    assertExpectedVersion(input.expectedVersion, "workspace_agent_room_permission_expected_version_invalid", 0);
    const result = await this.runIdempotentResult(context, { action: "workspace.agent.room_permission.set", input }, async (sql) => {
      await this.assertWorkspaceWritable(sql, context.workspaceId);
      try {
        await sql.query("SELECT samurai_set_workspace_agent_room_permission($1, $2, $3, $4, $5, $6, $7)", [
          context.workspaceId, input.roomId, input.agentId, input.canView, input.canEdit, input.canExecute, input.expectedVersion
        ]);
      } catch (error) {
        if (postgresMessage(error).includes("workspace_agent_room_permission_version_conflict")) {
          const latest = await sql.query<{ version: number | string }>(
            "SELECT version FROM workspace_agent_room_permissions WHERE workspace_id = $1 AND room_id = $2 AND agent_id = $3",
            [context.workspaceId, input.roomId, input.agentId]
          );
          throw new WorkspaceServerError("workspace_agent_room_permission_version_conflict", 409, { latest_version: latest.rows[0] ? Number(latest.rows[0].version) : null });
        }
        throw error;
      }
      const saved = await sql.query<AgentRoomPermissionRow>(
        `SELECT workspace_id, room_id, agent_id, can_view, can_edit, can_execute, version, created_by, created_at, updated_at
         FROM workspace_agent_room_permissions WHERE workspace_id = $1 AND room_id = $2 AND agent_id = $3`,
        [context.workspaceId, input.roomId, input.agentId]
      );
      const permission = saved.rows[0];
      if (!permission) throw new WorkspaceServerError("workspace_agent_room_permission_update_failed", 500);
      const mapped = agentRoomPermissionFromRow(permission);
      await this.insertAudit(sql, context, {
        roomId: input.roomId,
        action: "workspace.agent.room_permission.set",
        subjectKind: "workspace_agent_room_permission",
        subjectId: `${input.agentId}:${input.roomId}`,
        beforeVersion: input.expectedVersion,
        afterVersion: mapped.version,
        details: { agent_id: input.agentId, room_id: input.roomId, can_view: mapped.canView, can_edit: mapped.canEdit, can_execute: mapped.canExecute }
      });
      const event = await this.insertEvent(sql, context, {
        roomId: input.roomId,
        kind: "workspace.agent.room_permission.changed",
        payload: { agent_id: input.agentId, can_view: mapped.canView, can_edit: mapped.canEdit, can_execute: mapped.canExecute }
      });
      return { permission: mapped, event };
    });
    return { ...result.value, replayed: result.replayed };
  }

  /** Revoke all capabilities for one Agent in one Room without deleting the
   * permission row. The database function keeps the Room/Workspace boundary,
   * rejects removing the current default Agent, and leaves in-progress Work
   * assignments untouched so their historical evidence remains readable. */
  async removeRoomAgent(context: WorkspaceRequestContext, input: RemoveWorkspaceAgentRoomPermissionInput): Promise<{ permission: WorkspaceAgentRoomPermission; event: WorkspaceEvent; replayed: boolean }> {
    assertOpaqueId(input.roomId, "room_id_invalid");
    assertOpaqueId(input.agentId, "workspace_agent_id_invalid");
    const result = await this.runIdempotentResult(context, {
      action: "workspace.agent.room_permission.remove",
      input
    }, async (sql) => {
      await this.assertWorkspaceWritable(sql, context.workspaceId);
      try {
        await sql.query(
          "SELECT samurai_remove_workspace_agent_room_permission($1, $2, $3)",
          [context.workspaceId, input.roomId, input.agentId]
        );
      } catch (error) {
        throw mapRoomWorkPostgresError(error, "workspace_agent_room_permission_remove_failed");
      }
      const saved = await sql.query<AgentRoomPermissionRow>(
        `SELECT workspace_id, room_id, agent_id, can_view, can_edit, can_execute, version, created_by, created_at, updated_at
         FROM workspace_agent_room_permissions WHERE workspace_id = $1 AND room_id = $2 AND agent_id = $3`,
        [context.workspaceId, input.roomId, input.agentId]
      );
      const permission = saved.rows[0];
      if (!permission) throw new WorkspaceServerError("workspace_agent_room_permission_remove_failed", 500);
      const mapped = agentRoomPermissionFromRow(permission);
      await this.insertAudit(sql, context, {
        roomId: input.roomId,
        action: "workspace.agent.room_permission.remove",
        subjectKind: "workspace_agent_room_permission",
        subjectId: `${input.agentId}:${input.roomId}`,
        beforeVersion: Math.max(0, mapped.version - 1),
        afterVersion: mapped.version,
        details: {
          agent_id: input.agentId,
          room_id: input.roomId,
          can_view: false,
          can_edit: false,
          can_execute: false,
          in_progress_assignments_unchanged: true
        }
      });
      const event = await this.insertEvent(sql, context, {
        roomId: input.roomId,
        kind: "workspace.agent.room_permission.removed",
        payload: {
          agent_id: input.agentId,
          can_view: false,
          can_edit: false,
          can_execute: false,
          version: mapped.version
        }
      });
      return { permission: mapped, event };
    });
    return { ...result.value, replayed: result.replayed };
  }

  async listConnectionDescriptors(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">): Promise<WorkspaceConnectionDescriptor[]> {
    return this.database.withContext(context, async (sql) => {
      const result = await sql.query<ConnectionDescriptorRow>(
        `SELECT workspace_id, id, agent_id, principal_account_id, connector_id, app_id, status, expires_at, revoked_at,
                allowed_room_ids, room_limit, ingress_classes, version, created_by, created_at, updated_at
         FROM workspace_connection_descriptors WHERE workspace_id = $1 ORDER BY created_at, id`,
        [context.workspaceId]
      );
      return result.rows.map(connectionDescriptorFromRow);
    });
  }

  /**
   * Server-owned lookup used only by the formal External App ingress. The
   * transport adapter receives the mapped descriptor, never a database
   * handle, and the special integration transaction is kept inside this
   * Workspace boundary.
   */
  async getExternalConnectionDescriptor(input: { workspaceId?: string; id?: string; connectorId?: string }): Promise<WorkspaceConnectionDescriptor | undefined> {
    if (!input.id && (!input.workspaceId || !input.connectorId)) throw new WorkspaceServerError("workspace_external_connection_lookup_invalid", 400);
    return this.database.withContext({
      accountId: "external-integration",
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      externalIntegration: true
    }, async (sql) => {
      const result = input.id
        ? await sql.query<ConnectionDescriptorRow>(
          `SELECT workspace_id, id, agent_id, principal_account_id, connector_id, app_id, status, expires_at, revoked_at,
                  allowed_room_ids, room_limit, ingress_classes, version, created_by, created_at, updated_at
           FROM workspace_connection_descriptors WHERE id = $1 ORDER BY updated_at DESC, workspace_id LIMIT 1`,
          [input.id]
        )
        : await sql.query<ConnectionDescriptorRow>(
          `SELECT workspace_id, id, agent_id, principal_account_id, connector_id, app_id, status, expires_at, revoked_at,
                  allowed_room_ids, room_limit, ingress_classes, version, created_by, created_at, updated_at
           FROM workspace_connection_descriptors WHERE workspace_id = $1 AND connector_id = $2 ORDER BY updated_at DESC, id LIMIT 1`,
          [input.workspaceId, input.connectorId]
        );
      return result.rows[0] ? connectionDescriptorFromRow(result.rows[0]) : undefined;
    });
  }

  /** Returns only the authorization decision; error shaping remains in the
   * formal ingress so it can preserve the external contract. */
  async canExternalRoomAccess(input: {
    workspaceId: string;
    roomId: string;
    principal: WorkspaceExternalRoomPrincipal;
    action: WorkspaceExternalRoomAction;
  }): Promise<boolean> {
    assertOpaqueId(input.workspaceId, "workspace_id_invalid");
    assertOpaqueId(input.roomId, "room_id_invalid");
    const accountId = input.principal.kind === "human" ? input.principal.participantId : input.principal.requestedByParticipantId;
    assertOpaqueId(accountId, "account_id_invalid");
    const action = input.action === "manage_settings" ? "manage" : input.action;
    return this.database.withContext({ accountId, workspaceId: input.workspaceId, externalIntegration: true }, async (sql) => {
      if (input.principal.kind === "human" || input.action === "manage_settings") {
        const result = await sql.query<{ allowed: boolean }>(
          "SELECT samurai_can_room($1, $2, $3) AS allowed",
          [input.workspaceId, input.roomId, action]
        );
        return result.rows[0]?.allowed === true;
      }
      const human = await sql.query<{ allowed: boolean }>(
        "SELECT samurai_can_room($1, $2, 'read') AS allowed",
        [input.workspaceId, input.roomId]
      );
      if (human.rows[0]?.allowed !== true) return false;
      const agent = await sql.query<{ allowed: boolean }>(
        "SELECT samurai_can_agent_room($1, $2, $3, $4) AS allowed",
        [input.workspaceId, input.roomId, input.principal.agentId, action]
      );
      return agent.rows[0]?.allowed === true;
    });
  }

  async upsertConnectionDescriptor(context: WorkspaceRequestContext, input: UpsertWorkspaceConnectionDescriptorInput): Promise<{ descriptor: WorkspaceConnectionDescriptor; replayed: boolean }> {
    assertOpaqueId(input.principalAccountId, "account_id_invalid");
    if (input.agentId) assertOpaqueId(input.agentId, "workspace_agent_id_invalid");
    if (!input.connectorId.trim() || !input.appId.trim()) throw new WorkspaceServerError("workspace_connection_descriptor_identity_invalid", 400);
    const expiresAt = new Date(input.expiresAt);
    if (!Number.isFinite(expiresAt.getTime())) throw new WorkspaceServerError("workspace_connection_descriptor_expiry_invalid", 400);
    const revokedAt = input.revokedAt ? new Date(input.revokedAt) : undefined;
    if (revokedAt && !Number.isFinite(revokedAt.getTime())) throw new WorkspaceServerError("workspace_connection_descriptor_revocation_invalid", 400);
    const allowedRoomIds = [...new Set(input.allowedRoomIds ?? [])];
    for (const roomId of allowedRoomIds) assertOpaqueId(roomId, "workspace_connection_room_id_invalid");
    if (allowedRoomIds.length > 100) throw new WorkspaceServerError("workspace_connection_room_limit_invalid", 400);
    const roomLimit = input.roomLimit ?? Math.max(1, allowedRoomIds.length || 1);
    if (!Number.isSafeInteger(roomLimit) || roomLimit < 1 || roomLimit > 100 || allowedRoomIds.length > roomLimit) throw new WorkspaceServerError("workspace_connection_room_limit_invalid", 400);
    const ingressClasses = [...new Set(input.ingressClasses ?? [])];
    if (ingressClasses.length > 20 || ingressClasses.some((value) => !/^[a-z][a-z0-9_.-]{0,63}$/.test(value))) throw new WorkspaceServerError("workspace_connection_ingress_classes_invalid", 400);
    if (input.status === "active" && expiresAt.getTime() <= Date.now()) throw new WorkspaceServerError("workspace_connection_descriptor_expired", 400);
    if (input.status === "revoked" && !revokedAt) throw new WorkspaceServerError("workspace_connection_descriptor_revocation_required", 400);
    if (input.status !== "revoked" && revokedAt) throw new WorkspaceServerError("workspace_connection_descriptor_revocation_invalid", 400);
    assertExpectedVersion(input.expectedVersion, "workspace_connection_descriptor_expected_version_invalid", 0);
    const id = input.id ?? operationScopedId("connection", context.workspaceId, context.operationId);
    assertOpaqueId(id, "workspace_connection_id_invalid");
    const normalizedInput = {
      id, agentId: input.agentId ?? null, principalAccountId: input.principalAccountId, connectorId: input.connectorId.trim(), appId: input.appId.trim(),
      status: input.status, expiresAt: expiresAt.toISOString(), revokedAt: revokedAt?.toISOString() ?? null,
      allowedRoomIds, roomLimit, ingressClasses, expectedVersion: input.expectedVersion
    };
    const result = await this.runIdempotentResult(context, { action: "workspace.connection_descriptor.upsert", input: normalizedInput }, async (sql) => {
      await this.assertWorkspaceWritable(sql, context.workspaceId);
      try {
        await sql.query("SELECT samurai_upsert_workspace_connection_descriptor($1, $2, $3, $4, $5, $6, $7, $8::TIMESTAMPTZ, $9::TIMESTAMPTZ, $10::TEXT[], $11, $12::TEXT[], $13)", [
          context.workspaceId, id, normalizedInput.agentId, normalizedInput.principalAccountId, normalizedInput.connectorId, normalizedInput.appId,
          normalizedInput.status, normalizedInput.expiresAt, normalizedInput.revokedAt, normalizedInput.allowedRoomIds, normalizedInput.roomLimit, normalizedInput.ingressClasses, normalizedInput.expectedVersion
        ]);
      } catch (error) {
        if (postgresMessage(error).includes("workspace_connection_descriptor_version_conflict")) {
          const latest = await sql.query<{ version: number | string }>("SELECT version FROM workspace_connection_descriptors WHERE workspace_id = $1 AND id = $2", [context.workspaceId, id]);
          throw new WorkspaceServerError("workspace_connection_descriptor_version_conflict", 409, { latest_version: latest.rows[0] ? Number(latest.rows[0].version) : null });
        }
        throw error;
      }
      const saved = await sql.query<ConnectionDescriptorRow>(
        `SELECT workspace_id, id, agent_id, principal_account_id, connector_id, app_id, status, expires_at, revoked_at,
                allowed_room_ids, room_limit, ingress_classes, version, created_by, created_at, updated_at
         FROM workspace_connection_descriptors WHERE workspace_id = $1 AND id = $2`,
        [context.workspaceId, id]
      );
      const descriptor = saved.rows[0];
      if (!descriptor) throw new WorkspaceServerError("workspace_connection_descriptor_update_failed", 500);
      const mapped = connectionDescriptorFromRow(descriptor);
      await this.insertAudit(sql, context, {
        action: "workspace.connection_descriptor.upsert",
        subjectKind: "workspace_connection_descriptor",
        subjectId: id,
        beforeVersion: input.expectedVersion,
        afterVersion: mapped.version,
        details: { connector_id: mapped.connectorId, app_id: mapped.appId, status: mapped.status, expires_at: mapped.expiresAt, revoked_at: mapped.revokedAt ?? null, allowed_room_ids: mapped.allowedRoomIds, room_limit: mapped.roomLimit, ingress_classes: mapped.ingressClasses, agent_id: mapped.agentId ?? null }
      });
      for (const roomId of mapped.allowedRoomIds) {
        await this.insertEvent(sql, context, {
          roomId,
          kind: "workspace.connection_descriptor.changed",
          payload: { connection_id: mapped.id, status: mapped.status, expires_at: mapped.expiresAt, revoked_at: mapped.revokedAt ?? null }
        });
      }
      return mapped;
    });
    return { descriptor: result.value, replayed: result.replayed };
  }

  async listRoomMembers(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, roomId: string): Promise<WorkspaceRoomMembership[]> {
    assertOpaqueId(roomId, "room_id_invalid");
    return this.database.withContext(context, async (sql) => {
      const allowed = await sql.query<{ allowed: boolean }>(
        "SELECT samurai_can_room($1, $2, 'manage') AS allowed",
        [context.workspaceId, roomId]
      );
      if (allowed.rows[0]?.allowed !== true) throw new WorkspaceServerError("room_not_available", 404);
      const result = await sql.query<RoomMembershipRow>(
        `SELECT workspace_id, room_id, account_id, role, state, version, created_at, updated_at, revoked_at
         FROM room_members WHERE workspace_id = $1 AND room_id = $2 ORDER BY created_at, account_id`,
        [context.workspaceId, roomId]
      );
      return result.rows.map(roomMembershipFromRow);
    });
  }

  async createRoom(context: WorkspaceRequestContext, input: CreateWorkspaceRoomInput): Promise<WorkspaceRoomCreateResult> {
    if (!input.name.trim()) throw new WorkspaceServerError("room_name_required", 400);
    if (input.parentRoomId) assertOpaqueId(input.parentRoomId, "room_parent_id_invalid");
    const kind = input.kind ?? "normal";
    if (kind !== "normal" && kind !== "agent_dm") throw new WorkspaceServerError("room_kind_invalid", 400);
    if (input.defaultAgentId) assertOpaqueId(input.defaultAgentId, "workspace_default_agent_id_invalid");
    if (input.dmAccountId) assertOpaqueId(input.dmAccountId, "room_dm_account_id_invalid");
    if (input.defaultAgentVersion !== undefined) assertExpectedVersion(input.defaultAgentVersion, "workspace_default_agent_version_invalid", 1);
    if (kind === "normal" && input.dmAccountId) throw new WorkspaceServerError("room_kind_invalid", 400);
    if (input.defaultAgentId && input.newAgent) {
      throw new WorkspaceServerError("room_default_agent_selection_conflict", 400);
    }
    if (input.defaultAgentVersion !== undefined && !input.defaultAgentId) {
      throw new WorkspaceServerError("room_default_agent_required", 400);
    }
    if (input.agentPermission && !input.defaultAgentId && !input.newAgent) {
      throw new WorkspaceServerError("room_agent_permission_target_required", 400);
    }
    if (input.agentPermission) assertRoomAgentPermission(input.agentPermission);
    const newAgent = input.newAgent;
    if (newAgent) {
      if (!newAgent.name.trim() || newAgent.name.trim().length > 200
        || !newAgent.role.trim() || newAgent.role.trim().length > 500
        || !newAgent.instructions.trim() || newAgent.instructions.trim().length > 20_000) {
        throw new WorkspaceServerError("workspace_agent_input_invalid", 400);
      }
      if (newAgent.permission) assertRoomAgentPermission(newAgent.permission);
      if (input.agentPermission && newAgent.permission
        && !sameRoomAgentPermission(input.agentPermission, newAgent.permission)) {
        throw new WorkspaceServerError("room_agent_permission_conflict", 400);
      }
    }
    if (input.expectedWorkspaceVersion !== undefined) {
      assertExpectedVersion(input.expectedWorkspaceVersion, "workspace_expected_version_invalid", 1);
    }
    const id = input.id ?? operationScopedId("room", context.workspaceId, context.operationId);
    assertOpaqueId(id, "room_id_invalid");
    const newAgentId = newAgent
      ? (newAgent.id ?? operationScopedId("agent", `${context.workspaceId}:room:${id}`, context.operationId))
      : undefined;
    if (newAgentId) assertOpaqueId(newAgentId, "workspace_agent_id_invalid");
    const defaultAgentId = input.defaultAgentId ?? newAgentId;
    const configuredPermission = input.agentPermission ?? newAgent?.permission;
    // A Room default must be executable.  A caller can still create an Agent
    // with a narrower permission in a separate Agent/Room permission command;
    // this guard prevents creating a default that can never launch work.
    if (defaultAgentId && configuredPermission && !configuredPermission.canExecute) {
      throw new WorkspaceServerError("workspace_default_agent_permission_required", 403);
    }
    const requestInput = {
      id,
      name: input.name,
      parentRoomId: input.parentRoomId ?? null,
      defaultAgentId: input.defaultAgentId ?? null,
      defaultAgentVersion: input.defaultAgentVersion ?? null,
      kind,
      dmAccountId: input.dmAccountId ?? null,
      // The Domain API does not expose a Workspace version for Room create.
      // Keep an explicitly supplied legacy version in the hash, but do not
      // manufacture a dynamic internal version here: a retry after the
      // response was lost must replay even when another operation advanced
      // the Workspace version in the meantime.
      ...(input.expectedWorkspaceVersion === undefined ? {} : { expectedWorkspaceVersion: input.expectedWorkspaceVersion }),
      newAgent: newAgent ? {
        id: newAgentId,
        name: newAgent.name.trim(),
        role: newAgent.role.trim(),
        instructions: newAgent.instructions.trim(),
        backendId: normalizeAgentBackendId(newAgent.backendId),
        enabled: newAgent.enabled ?? true,
        ...(newAgent.permission ? { permission: newAgent.permission } : {})
      } : null,
        ...(input.agentPermission ? { agentPermission: input.agentPermission } : {})
    };
    const result = await this.runIdempotentResult(context, { action: "room.create", input: requestInput }, async (sql) => {
      const currentWorkspace = input.expectedWorkspaceVersion === undefined
        ? (await sql.query<{ version: number | string }>(
          "SELECT version FROM workspaces WHERE id = $1", [context.workspaceId]
        )).rows[0]
        : undefined;
      if (input.expectedWorkspaceVersion === undefined && !currentWorkspace) {
        throw new WorkspaceServerError("workspace_not_found", 404);
      }
      const expectedWorkspaceVersion = input.expectedWorkspaceVersion ?? Number(currentWorkspace?.version);
      await this.assertWorkspaceWritable(sql, context.workspaceId);
      if (newAgent && newAgentId) {
        try {
          await sql.query(
            "SELECT samurai_register_workspace_agent_v1($1, $2, $3, $4, $5, $6, $7)",
            [
              context.workspaceId,
              newAgentId,
              newAgent.name.trim(),
              newAgent.role.trim(),
              newAgent.instructions.trim(),
              normalizeAgentBackendId(newAgent.backendId),
              newAgent.enabled ?? true
            ]
          );
        } catch (error) {
          if (postgresMessage(error).includes("duplicate key")) {
            throw new WorkspaceServerError("workspace_agent_id_conflict", 409);
          }
          throw mapRoomWorkPostgresError(error, "workspace_agent_registration_failed");
        }
      }
      try {
        await sql.query("SELECT samurai_create_room($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)", [
          context.workspaceId,
          id,
          input.name.trim(),
          input.parentRoomId ?? null,
          defaultAgentId ?? null,
          input.defaultAgentVersion ?? null,
          kind,
          input.dmAccountId ?? null,
          expectedWorkspaceVersion,
          context.operationId
        ]);
      } catch (error) {
        if (postgresMessage(error).includes("workspace_version_conflict")) {
          throw await this.workspaceVersionConflict(sql, context.workspaceId);
        }
        throw mapRoomWorkPostgresError(error, "room_creation_failed");
      }
      if (defaultAgentId && configuredPermission) {
        const currentPermission = (await sql.query<{ version: number | string }>(
          `SELECT version FROM workspace_agent_room_permissions
           WHERE workspace_id = $1 AND room_id = $2 AND agent_id = $3`,
          [context.workspaceId, id, defaultAgentId]
        )).rows[0];
        try {
          await sql.query(
            "SELECT samurai_set_workspace_agent_room_permission($1, $2, $3, $4, $5, $6, $7)",
            [
              context.workspaceId,
              id,
              defaultAgentId,
              configuredPermission.canView,
              configuredPermission.canEdit,
              configuredPermission.canExecute,
              currentPermission ? Number(currentPermission.version) : 0
            ]
          );
        } catch (error) {
          throw mapRoomWorkPostgresError(error, "workspace_agent_room_permission_update_failed");
        }
      }
      const result = await sql.query<RoomRow>(
        "SELECT workspace_id, id, parent_room_id, name, room_kind, default_agent_id, default_agent_version, dm_account_id, version, created_at, updated_at FROM rooms WHERE workspace_id = $1 AND id = $2",
        [context.workspaceId, id]
      );
      const room = result.rows[0];
      if (!room) throw new WorkspaceServerError("room_creation_failed", 500);
      const mapped = roomFromRow(room);
      await this.insertAudit(sql, context, {
        action: "room.create",
        subjectKind: "room",
        subjectId: mapped.id,
        beforeVersion: 0,
        afterVersion: mapped.version,
        details: {
          workspace_version: expectedWorkspaceVersion,
          parent_room_id: input.parentRoomId ?? null,
          default_agent_id: defaultAgentId ?? null,
          ...(newAgentId ? { new_agent_id: newAgentId } : {}),
          ...(configuredPermission ? { agent_permission: configuredPermission } : {}),
          room_kind: kind
        }
      });
      return mapped;
    }, { lockRoomHierarchy: true });
    return { room: result.value, replayed: result.replayed };
  }

  async previewRoomMove(
    context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">,
    input: { roomId: string; parentRoomId?: string }
  ): Promise<WorkspaceRoomMovePreview> {
    assertOpaqueId(input.roomId, "room_id_invalid");
    if (input.parentRoomId) assertOpaqueId(input.parentRoomId, "room_parent_id_invalid");
    return this.database.withContext(context, async (sql) => {
      const result = await sql.query<{ preview: WorkspaceRecordPayload | string }>(
        "SELECT samurai_preview_room_move($1, $2, $3) AS preview",
        [context.workspaceId, input.roomId, input.parentRoomId ?? null]
      );
      return roomMovePreviewFromPayload(result.rows[0]?.preview);
    });
  }

  async moveRoom(
    context: WorkspaceRequestContext,
    input: { roomId: string; parentRoomId?: string; expectedRoomVersion: number; expectedWorkspaceVersion: number }
  ): Promise<WorkspaceRoomMoveResult> {
    assertOpaqueId(input.roomId, "room_id_invalid");
    if (input.parentRoomId) assertOpaqueId(input.parentRoomId, "room_parent_id_invalid");
    assertExpectedVersion(input.expectedRoomVersion, "room_expected_version_invalid", 1);
    assertExpectedVersion(input.expectedWorkspaceVersion, "workspace_expected_version_invalid", 1);
    const result = await this.runIdempotentResult(context, {
      action: "room.move",
      input: {
        roomId: input.roomId,
        parentRoomId: input.parentRoomId ?? null,
        expectedRoomVersion: input.expectedRoomVersion,
        expectedWorkspaceVersion: input.expectedWorkspaceVersion
      }
    }, async (sql) => {
      await this.assertWorkspaceWritable(sql, context.workspaceId);
      const before = await sql.query<RoomRow>(
        "SELECT workspace_id, id, parent_room_id, name, room_kind, default_agent_id, default_agent_version, dm_account_id, version, created_at, updated_at FROM rooms WHERE workspace_id = $1 AND id = $2",
        [context.workspaceId, input.roomId]
      );
      await sql.query("SAVEPOINT samurai_room_move");
      let moveResult: WorkspaceRecordPayload | string | undefined;
      try {
        const moved = await sql.query<{ result: WorkspaceRecordPayload | string }>(
          "SELECT samurai_move_room($1, $2, $3, $4, $5, $6) AS result",
          [context.workspaceId, input.roomId, input.parentRoomId ?? null, input.expectedRoomVersion, input.expectedWorkspaceVersion, context.operationId]
        );
        moveResult = moved.rows[0]?.result;
      } catch (error) {
        // The guarded SQL function can reject an old Version. PostgreSQL then
        // marks the current transaction failed, so restore this local
        // savepoint before reading the latest Version for the caller.
        await sql.query("ROLLBACK TO SAVEPOINT samurai_room_move");
        await sql.query("RELEASE SAVEPOINT samurai_room_move");
        const message = postgresMessage(error);
        if (message.includes("workspace_version_conflict")) throw await this.workspaceVersionConflict(sql, context.workspaceId);
        if (message.includes("room_version_conflict")) {
          const latest = await sql.query<{ version: number | string }>(
            "SELECT version FROM rooms WHERE workspace_id = $1 AND id = $2",
            [context.workspaceId, input.roomId]
          );
          throw new WorkspaceServerError("room_version_conflict", 409, { latest_version: latest.rows[0] ? Number(latest.rows[0].version) : null });
        }
        throw error;
      }
      await sql.query("RELEASE SAVEPOINT samurai_room_move");
      const result = roomMoveResultPayload(moveResult);
      const selected = await sql.query<RoomRow>(
        "SELECT workspace_id, id, parent_room_id, name, room_kind, default_agent_id, default_agent_version, dm_account_id, version, created_at, updated_at FROM rooms WHERE workspace_id = $1 AND id = $2",
        [context.workspaceId, input.roomId]
      );
      const room = selected.rows[0];
      if (!room) throw new WorkspaceServerError("room_move_failed", 500);
      const mapped = roomFromRow(room);
      await this.insertAudit(sql, context, {
        action: "room.move",
        roomId: input.roomId,
        subjectKind: "room",
        subjectId: input.roomId,
        beforeVersion: before.rows[0] ? Number(before.rows[0].version) : undefined,
        afterVersion: mapped.version,
        details: {
          previous_parent_room_id: before.rows[0]?.parent_room_id ?? null,
          parent_room_id: input.parentRoomId ?? null
        }
      });
      return { room: mapped, affectedRoomIds: result.affectedRoomIds };
    }, { lockRoomHierarchy: true });
    const visibleAffectedRoomIds = await this.visibleRoomIds(
      { workspaceId: context.workspaceId, accountId: context.accountId },
      result.value.affectedRoomIds
    );
    return {
      room: result.value.room,
      affectedRoomIds: visibleAffectedRoomIds,
      revalidationRoomIds: result.value.affectedRoomIds,
      replayed: result.replayed
    };
  }

  async setWorkspaceMember(context: WorkspaceRequestContext, input: SetWorkspaceMemberInput): Promise<WorkspaceMembershipChangeResult> {
    assertOpaqueId(input.accountId, "account_id_invalid");
    assertRole(input.role);
    assertExpectedVersion(input.expectedVersion, "workspace_membership_expected_version_invalid", 0);
    const result = await this.runIdempotentResult(context, { action: "workspace.member.set", input }, async (sql) => {
      const before = await this.selectWorkspaceMember(sql, context.workspaceId, input.accountId);
      try {
        const changed = await sql.query<{ result: WorkspaceRecordPayload | string }>(
          "SELECT samurai_set_workspace_member($1, $2, $3, $4, $5, $6) AS result",
          [context.workspaceId, input.accountId, input.role, input.state, input.expectedVersion, context.operationId]
        );
        const impact = roomMemberChangeResultPayload(changed.rows[0]?.result);
        const member = await this.selectWorkspaceMember(sql, context.workspaceId, input.accountId);
        if (!member) throw new WorkspaceServerError("workspace_membership_update_failed", 500);
        await this.insertAudit(sql, context, {
          action: "workspace.member.set",
          subjectKind: "workspace_member",
          subjectId: input.accountId,
          beforeVersion: before?.version ?? 0,
          afterVersion: member.version,
          details: { role: member.role, state: member.state }
        });
        return { member, affectedRoomIds: impact.affectedRoomIds };
      } catch (error) {
        if (postgresMessage(error).includes("workspace_membership_version_conflict")) {
          throw await this.workspaceMemberVersionConflict(sql, context.workspaceId, input.accountId);
        }
        throw error;
      }
    }, { lockRoomHierarchy: true });
    return {
      member: result.value.member,
      revalidationRoomIds: result.value.affectedRoomIds,
      replayed: result.replayed
    };
  }

  async previewRoomMemberChange(
    context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">,
    input: Pick<SetRoomMemberInput, "roomId" | "accountId" | "role" | "state">
  ): Promise<WorkspaceRoomMemberChangePreview> {
    assertOpaqueId(input.roomId, "room_id_invalid");
    assertOpaqueId(input.accountId, "account_id_invalid");
    assertRole(input.role);
    return this.database.withContext(context, async (sql) => {
      const result = await sql.query<{ preview: WorkspaceRecordPayload | string }>(
        "SELECT samurai_preview_room_member_change($1, $2, $3, $4, $5) AS preview",
        [context.workspaceId, input.roomId, input.accountId, input.role, input.state]
      );
      return roomMemberChangePreviewFromPayload(result.rows[0]?.preview);
    });
  }

  async setRoomMember(context: WorkspaceRequestContext, input: SetRoomMemberInput): Promise<WorkspaceRoomMemberChangeResult> {
    assertOpaqueId(input.roomId, "room_id_invalid");
    assertOpaqueId(input.accountId, "account_id_invalid");
    assertRole(input.role);
    assertExpectedVersion(input.expectedVersion, "room_membership_expected_version_invalid", 0);
    const result = await this.runIdempotentResult(context, { action: "room.member.set", input }, async (sql) => {
      const before = await this.selectRoomMember(sql, context.workspaceId, input.roomId, input.accountId);
      await sql.query("SAVEPOINT samurai_room_member_set");
      let changed: { rows: Array<{ result: WorkspaceRecordPayload | string }> };
      try {
        changed = await sql.query<{ result: WorkspaceRecordPayload | string }>(
          "SELECT samurai_set_room_member_with_impact($1, $2, $3, $4, $5, $6, $7) AS result",
          [context.workspaceId, input.roomId, input.accountId, input.role, input.state, input.expectedVersion, context.operationId]
        );
      } catch (error) {
        // The guarded SQL function can reject an old Version. PostgreSQL then
        // marks the current transaction failed, so restore this local
        // savepoint before reading the latest Version for the caller.
        await sql.query("ROLLBACK TO SAVEPOINT samurai_room_member_set");
        await sql.query("RELEASE SAVEPOINT samurai_room_member_set");
        if (postgresMessage(error).includes("room_membership_version_conflict")) {
          throw await this.roomMemberVersionConflict(sql, context.workspaceId, input.roomId, input.accountId);
        }
        throw error;
      }
      await sql.query("RELEASE SAVEPOINT samurai_room_member_set");
      const impact = roomMemberChangeResultPayload(changed.rows[0]?.result);
      const member = await this.selectRoomMember(sql, context.workspaceId, input.roomId, input.accountId);
      if (!member) throw new WorkspaceServerError("room_membership_update_failed", 500);
      await this.insertAudit(sql, context, {
        action: "room.member.set",
        roomId: input.roomId,
        subjectKind: "room_member",
        subjectId: input.accountId,
        beforeVersion: before?.version ?? 0,
        afterVersion: member.version,
        details: { role: member.role, state: member.state }
      });
      return { member, affectedRoomIds: impact.affectedRoomIds };
    }, { lockRoomHierarchy: true });
    const visibleAffectedRoomIds = await this.visibleRoomIds(
      { workspaceId: context.workspaceId, accountId: context.accountId },
      result.value.affectedRoomIds
    );
    return {
      member: result.value.member,
      affectedRoomIds: visibleAffectedRoomIds,
      revalidationRoomIds: result.value.affectedRoomIds,
      replayed: result.replayed
    };
  }

  async createInvitation(context: WorkspaceRequestContext, input: {
    roomId?: string;
    workspaceRole: WorkspaceMembershipRole;
    roomRole?: WorkspaceMembershipRole;
    expiresAt: string;
    expectedWorkspaceVersion: number;
  }): Promise<CreateInvitationResult> {
    if (input.roomId) assertOpaqueId(input.roomId, "room_id_invalid");
    assertRole(input.workspaceRole);
    if (input.roomRole) assertRole(input.roomRole);
    assertExpectedVersion(input.expectedWorkspaceVersion, "workspace_expected_version_invalid", 1);
    const expiresAt = new Date(input.expiresAt);
    if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
      throw new WorkspaceServerError("workspace_invitation_expiry_invalid", 400);
    }
    const token = invitationToken(this.invitationTokenSecret, context);
    const invitationId = operationScopedId("invite", context.workspaceId, context.operationId);
    const invitation = await this.runIdempotent(context, { action: "workspace.invitation.create", input: { ...input, invitationId } }, async (sql) => {
      await this.assertWorkspaceWritable(sql, context.workspaceId);
      try {
        await sql.query("SELECT samurai_create_workspace_invitation($1, $2, $3, $4, $5, $6, $7::TIMESTAMPTZ, $8)", [
          context.workspaceId,
          invitationId,
          input.roomId ?? null,
          invitationTokenHash(this.invitationTokenSecret, token),
          input.workspaceRole,
          input.roomRole ?? null,
          expiresAt.toISOString(),
          input.expectedWorkspaceVersion
        ]);
      } catch (error) {
        if (postgresMessage(error).includes("workspace_version_conflict")) {
          throw await this.workspaceVersionConflict(sql, context.workspaceId);
        }
        throw error;
      }
      const saved = await sql.query<InvitationRow>(
        `SELECT workspace_id, id, room_id, workspace_role, room_role, version, expires_at, created_at, revoked_at, accepted_at
         FROM workspace_invitations WHERE workspace_id = $1 AND id = $2`,
        [context.workspaceId, invitationId]
      );
      const row = saved.rows[0];
      if (!row) throw new WorkspaceServerError("workspace_invitation_creation_failed", 500);
      const invitation = invitationFromRow(row);
      await this.insertAudit(sql, context, {
        action: "workspace.invitation.create",
        roomId: invitation.roomId,
        subjectKind: "invitation",
        subjectId: invitation.id,
        beforeVersion: 0,
        afterVersion: invitation.version,
        details: { workspace_role: invitation.workspaceRole, room_role: invitation.roomRole ?? null, expires_at: invitation.expiresAt, workspace_version: input.expectedWorkspaceVersion }
      });
      return invitation;
    });
    return { invitation, token };
  }

  async acceptInvitation(context: WorkspaceRequestContext, token: string): Promise<{
    accepted: { workspaceRole: WorkspaceMembershipRole; roomId?: string; roomRole?: WorkspaceMembershipRole; invitationVersion: number };
    /** Internal-only Room ids used by the HTTP/Realtime boundary. */
    revalidationRoomIds: string[];
    replayed: boolean;
  }> {
    if (!token || token.length > 512) throw new WorkspaceServerError("workspace_invitation_invalid", 400);
    const tokenHash = invitationTokenHash(this.invitationTokenSecret, token);
    // An invitee has an Account but is intentionally not a Workspace member
    // yet. Keep this retry ledger at the Account boundary; allowing it in the
    // Workspace operation ledger would let any registered Account create rows
    // in a Workspace it cannot access.
    const result = await this.runAccountIdempotentResult(context.accountId, context.operationId, context.workspaceId, {
      action: "workspace.invitation.accept",
      input: { workspaceId: context.workspaceId, tokenHash }
    }, async (sql) => {
      const result = await sql.query<{ workspace_role: WorkspaceMembershipRole; room_id: string | null; room_role: WorkspaceMembershipRole | null; invitation_version: number | string }>(
        "SELECT workspace_role, room_id, room_role, invitation_version FROM samurai_accept_invitation($1, $2, $3)",
        [context.workspaceId, tokenHash, context.operationId]
      );
      const row = result.rows[0];
      if (!row) throw new WorkspaceServerError("workspace_invitation_invalid", 400);
      const accepted = {
        workspaceRole: row.workspace_role,
        ...(row.room_id ? { roomId: row.room_id } : {}),
        ...(row.room_role ? { roomRole: row.room_role } : {}),
        invitationVersion: Number(row.invitation_version)
      };
      await this.insertAudit(sql, context, {
        action: "workspace.invitation.accept",
        roomId: accepted.roomId,
        subjectKind: "invitation",
        subjectId: "accepted",
        afterVersion: accepted.invitationVersion,
        details: { workspace_role: accepted.workspaceRole, room_role: accepted.roomRole ?? null }
      });
      return accepted;
    });
    return {
      accepted: result.value,
      revalidationRoomIds: result.value.roomId ? [result.value.roomId] : [],
      replayed: result.replayed
    };
  }

  async revokeInvitation(context: WorkspaceRequestContext, invitationId: string, expectedVersion: number): Promise<void> {
    assertOpaqueId(invitationId, "workspace_invitation_id_invalid");
    assertExpectedVersion(expectedVersion, "workspace_invitation_expected_version_invalid", 1);
    return this.runIdempotent(context, { action: "workspace.invitation.revoke", input: { invitationId, expectedVersion } }, async (sql) => {
      try {
        await sql.query("SELECT samurai_revoke_invitation($1, $2, $3)", [context.workspaceId, invitationId, expectedVersion]);
      } catch (error) {
        if (postgresMessage(error).includes("workspace_invitation_version_conflict")) {
          throw await this.invitationVersionConflict(sql, context.workspaceId, invitationId);
        }
        throw error;
      }
      await this.insertAudit(sql, context, {
        action: "workspace.invitation.revoke",
        subjectKind: "invitation",
        subjectId: invitationId,
        beforeVersion: expectedVersion,
        afterVersion: expectedVersion + 1
      });
    });
  }

  async getRecord(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, input: { roomId: string; recordType: string; id: string }): Promise<WorkspaceRecord> {
    assertOpaqueId(input.roomId, "room_id_invalid");
    assertRecordType(input.recordType);
    assertOpaqueId(input.id, "record_id_invalid");
    return this.database.withContext(context, async (sql) => {
      const result = await sql.query<RecordRow>(
        `SELECT workspace_id, room_id, record_type, id, version, payload, content_hash, created_at, updated_at
         FROM workspace_records
         WHERE workspace_id = $1 AND room_id = $2 AND record_type = $3 AND id = $4`,
        [context.workspaceId, input.roomId, input.recordType, input.id]
      );
      const row = result.rows[0];
      if (!row) throw new WorkspaceServerError("workspace_record_not_found", 404);
      return recordFromRow(row);
    });
  }

  /**
   * A normal Knowledge list is Room-scoped.  Workspace-wide reads must be a
   * separately designed explicit operation; they cannot happen because a
   * caller omitted a Room ID.
   */
  async listRecords(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, input: { roomId: string; recordType?: string; limit?: number }): Promise<WorkspaceRecord[]> {
    assertOpaqueId(input.roomId, "room_id_invalid");
    if (input.recordType) assertRecordType(input.recordType);
    const limit = boundedLimit(input.limit);
    return this.database.withContext(context, async (sql) => {
      const result = await sql.query<RecordRow>(
        `SELECT workspace_id, room_id, record_type, id, version, payload, content_hash, created_at, updated_at
         FROM workspace_records
         WHERE workspace_id = $1
           AND room_id = $2
           AND ($3::TEXT IS NOT NULL OR record_type <> 'artifact_transaction')
           AND ($3::TEXT IS NULL OR record_type = $3)
         ORDER BY updated_at DESC
         LIMIT $4`,
        [context.workspaceId, input.roomId, input.recordType ?? null, limit]
      );
      return result.rows.map(recordFromRow);
    });
  }

  async searchRecords(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, input: { query: string; roomId: string; limit?: number }): Promise<WorkspaceRecord[]> {
    if (!input.query.trim()) return [];
    assertOpaqueId(input.roomId, "room_id_invalid");
    const limit = boundedLimit(input.limit);
    return this.database.withContext(context, async (sql) => {
      const result = await sql.query<RecordRow>(
        `SELECT workspace_id, room_id, record_type, id, version, payload, content_hash, created_at, updated_at
         FROM workspace_records
         WHERE workspace_id = $1
           AND search_text ILIKE '%' || $2 || '%'
           AND room_id = $3
           AND record_type <> 'artifact_transaction'
         ORDER BY similarity(search_text, $2) DESC, updated_at DESC
         LIMIT $4`,
        [context.workspaceId, input.query.trim(), input.roomId, limit]
      );
      return result.rows.map(recordFromRow);
    });
  }

  async putRecord(context: WorkspaceRequestContext, input: PutRecordInput): Promise<PutRecordResult> {
    assertOpaqueId(input.roomId, "room_id_invalid");
    assertRecordType(input.recordType);
    assertOpaqueId(input.id, "record_id_invalid");
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) {
      throw new WorkspaceServerError("workspace_record_expected_version_invalid", 400);
    }
    const payloadText = canonicalJson(input.payload);
    const searchText = normalizeSearchText(input.searchText ?? payloadText);
    const result = await this.runIdempotentResult(context, { action: "workspace.record.put", input }, async (sql) => {
      await this.assertWorkspaceWritable(sql, context.workspaceId);
      const existing = await sql.query<{ room_id: string }>(
        `SELECT room_id FROM workspace_records
         WHERE workspace_id = $1 AND record_type = $2 AND id = $3
         FOR UPDATE`,
        [context.workspaceId, input.recordType, input.id]
      );
      if (existing.rows[0] && existing.rows[0].room_id !== input.roomId) {
        throw new WorkspaceServerError("workspace_record_room_change_forbidden", 409);
      }
      const saved = await sql.query<RecordRow>(
        `INSERT INTO workspace_records(
           workspace_id, room_id, record_type, id, version, payload, search_text, content_hash, created_by, updated_by
         ) VALUES ($1, $2, $3, $4, 1, $5::JSONB, $6, $7, $8, $8)
         ON CONFLICT (workspace_id, record_type, id) DO UPDATE SET
           version = workspace_records.version + 1,
           payload = EXCLUDED.payload,
           search_text = EXCLUDED.search_text,
           content_hash = EXCLUDED.content_hash,
           updated_by = EXCLUDED.updated_by,
           updated_at = NOW()
         WHERE workspace_records.version = $9
         RETURNING workspace_id, room_id, record_type, id, version, payload, content_hash, created_at, updated_at`,
        [context.workspaceId, input.roomId, input.recordType, input.id, payloadText, searchText, hash(payloadText), context.accountId, input.expectedVersion]
      );
      const row = saved.rows[0];
      if (!row) await this.throwRecordVersionConflict(sql, context.workspaceId, input.recordType, input.id);
      const record = recordFromRow(row!);
      const event = await this.insertEvent(sql, context, {
        roomId: input.roomId,
        kind: "workspace.record.updated",
        recordType: input.recordType,
        recordId: input.id,
        payload: { version: record.version, content_hash: record.contentHash }
      });
      await this.insertAudit(sql, context, {
        action: "workspace.record.put",
        roomId: input.roomId,
        subjectKind: input.recordType,
        subjectId: input.id,
        beforeVersion: input.expectedVersion,
        afterVersion: record.version,
        details: { content_hash: record.contentHash }
      });
      return { record, event };
    });
    return { ...result.value, replayed: result.replayed };
  }

  async deleteRecord(context: WorkspaceRequestContext, input: { roomId: string; recordType: string; id: string; expectedVersion: number }): Promise<{ event: WorkspaceEvent; replayed: boolean }> {
    assertOpaqueId(input.roomId, "room_id_invalid");
    assertRecordType(input.recordType);
    assertOpaqueId(input.id, "record_id_invalid");
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
      throw new WorkspaceServerError("workspace_record_expected_version_invalid", 400);
    }
    const result = await this.runIdempotentResult(context, { action: "workspace.record.delete", input }, async (sql) => {
      await this.assertWorkspaceWritable(sql, context.workspaceId);
      const deleted = await sql.query<{ id: string }>(
        `DELETE FROM workspace_records
         WHERE workspace_id = $1 AND room_id = $2 AND record_type = $3 AND id = $4 AND version = $5
         RETURNING id`,
        [context.workspaceId, input.roomId, input.recordType, input.id, input.expectedVersion]
      );
      if (!deleted.rows[0]) await this.throwRecordVersionConflict(sql, context.workspaceId, input.recordType, input.id);
      const event = await this.insertEvent(sql, context, {
        roomId: input.roomId,
        kind: "workspace.record.deleted",
        recordType: input.recordType,
        recordId: input.id,
        payload: { version: input.expectedVersion }
      });
      await this.insertAudit(sql, context, {
        action: "workspace.record.delete",
        roomId: input.roomId,
        subjectKind: input.recordType,
        subjectId: input.id,
        beforeVersion: input.expectedVersion,
        afterVersion: input.expectedVersion + 1
      });
      return { event };
    });
    return { ...result.value, replayed: result.replayed };
  }

  async listEvents(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, input: { roomId: string; afterId?: number; limit?: number }): Promise<WorkspaceEvent[]> {
    assertOpaqueId(input.roomId, "room_id_invalid");
    const afterId = input.afterId ?? 0;
    if (!Number.isSafeInteger(afterId) || afterId < 0) throw new WorkspaceServerError("workspace_event_cursor_invalid", 400);
    const limit = boundedLimit(input.limit);
    return this.database.withContext(context, async (sql) => {
      const result = await sql.query<EventRow>(
        `SELECT id, workspace_id, room_id, kind, record_type, record_id, operation_id, payload, created_at
         FROM workspace_events
         WHERE workspace_id = $1 AND id > $2 AND room_id = $3
         ORDER BY id ASC LIMIT $4`,
        [context.workspaceId, afterId, input.roomId, limit]
      );
      return result.rows.map(eventFromRow);
    });
  }

  /** Reads the versioned Event Journal through the same RLS boundary as all Workspace data. */
  async listPublicEvents(
    context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">,
    input: { roomId?: string; afterCursor?: string; limit?: number } = {}
  ): Promise<WorkspacePublicEventPage> {
    if (input.roomId) {
      await this.assertRoomReadable(context, input.roomId);
    }
    const limit = boundedLimit(input.limit);
    return this.database.withContext(context, async (sql) => {
      let afterId = 0;
      if (input.afterCursor) {
        const cursor = await sql.query<{ id: number | string }>(
          "SELECT id FROM workspace_events WHERE workspace_id = $1 AND cursor = $2",
          [context.workspaceId, input.afterCursor]
        );
        if (!cursor.rows[0]) throw new WorkspaceServerError("workspace_event_cursor_invalid", 400);
        afterId = Number(cursor.rows[0].id);
      }
      const result = await sql.query<PublicEventRow>(
        `SELECT id, workspace_id, room_id, kind, record_type, record_id, operation_id, payload, created_at,
                event_id, event_version, actor_kind, actor_id, organization_id, cursor, correlation_id, resources
         FROM workspace_events
         WHERE workspace_id = $1
           AND id > $2
           AND ($3::TEXT IS NULL OR room_id = $3)
         ORDER BY id ASC
         LIMIT $4`,
        [context.workspaceId, afterId, input.roomId ?? null, limit + 1]
      );
      const hasMore = result.rows.length > limit;
      const rows = hasMore ? result.rows.slice(0, limit) : result.rows;
      return {
        events: rows.map(publicEventFromRow),
        ...(hasMore && rows.length > 0 ? { nextCursor: String(rows[rows.length - 1]!.cursor) } : {}),
        hasMore
      };
    });
  }

  /** Appends one public Event after the owning state change has been persisted. */
  async appendPublicEvent(
    context: WorkspaceRequestContext,
    input: AppendPublicEventInput
  ): Promise<{ event: WorkspacePublicEvent; replayed: boolean }> {
    assertOpaqueId(context.workspaceId, "workspace_id_invalid");
    const eventType = input.eventType.trim();
    if (!/^[a-z][a-z0-9._-]{0,127}$/.test(eventType)) throw new WorkspaceServerError("workspace_event_type_invalid", 400);
    const eventVersion = input.eventVersion ?? "1.0";
    if (!/^\d+\.\d+$/.test(eventVersion)) throw new WorkspaceServerError("workspace_event_version_invalid", 400);
    if (input.roomId) assertOpaqueId(input.roomId, "room_id_invalid");
    if (input.organizationId) assertOpaqueId(input.organizationId, "organization_id_invalid");
    if (input.actor.kind !== "system" && !input.actor.id) throw new WorkspaceServerError("workspace_event_actor_invalid", 400);
    if (input.actor.id) assertOpaqueId(input.actor.id, "workspace_event_actor_invalid");
    const eventId = input.eventId ?? `event_${hash(canonicalJson({ workspaceId: context.workspaceId, eventType, roomId: input.roomId ?? null, operationId: input.operationId ?? context.operationId, payload: input.payload })).slice(0, 48)}`;
    assertOpaqueId(eventId, "workspace_event_id_invalid");
    const cursor = `cursor_${hash(`${context.workspaceId}|${eventId}`).slice(0, 48)}`;
    const operationId = input.operationId ?? context.operationId;
    assertOpaqueId(operationId, "operation_id_invalid");
    const resources = input.resources ?? [];
    return this.database.withContext(context, async (sql) => {
      const workspaceScope = await sql.query<{ organization_id: string | null }>(
        "SELECT organization_id FROM workspaces WHERE id = $1", [context.workspaceId]
      );
      if (!workspaceScope.rows[0]) throw new WorkspaceServerError("workspace_not_found", 404);
      // Organization is only Event provenance. Workspace membership and Room
      // authorization were checked above; a standalone Workspace therefore
      // legitimately writes a NULL organization_id. An explicit provenance
      // reference is preserved even after a Workspace is detached or moved;
      // it never participates in the content authorization decision.
      const organizationId = input.organizationId ?? workspaceScope.rows[0].organization_id;
      if (input.roomId) {
        const authorizationAction = input.authorizationAction ?? "edit";
        const allowed = await sql.query<{ allowed: boolean }>(
          "SELECT samurai_can_room($1, $2, $3) AND samurai_workspace_is_writable($1) AS allowed",
          [context.workspaceId, input.roomId, authorizationAction]
        );
        if (allowed.rows[0]?.allowed !== true) throw new WorkspaceServerError("room_not_writable_or_access_denied", 403);
      } else {
        const allowed = await sql.query<{ allowed: boolean }>(
          "SELECT samurai_can_workspace($1, 'admin') AND samurai_workspace_is_writable($1) AS allowed",
          [context.workspaceId]
        );
        if (allowed.rows[0]?.allowed !== true) throw new WorkspaceServerError("workspace_admin_permission_required", 403);
      }
      const saved = await sql.query<PublicEventRow>(
        `INSERT INTO workspace_events(
           workspace_id, room_id, kind, record_type, record_id, operation_id, payload,
           event_id, event_version, actor_kind, actor_id, organization_id, cursor, correlation_id, resources
         ) VALUES ($1, $2, $3, $4, $5, $6, $7::JSONB, $8, $9, $10, $11, $12, $13, $14, $15::JSONB)
         ON CONFLICT (workspace_id, event_id) DO NOTHING
         RETURNING id, workspace_id, room_id, kind, record_type, record_id, operation_id, payload, created_at,
                   event_id, event_version, actor_kind, actor_id, organization_id, cursor, correlation_id, resources`,
        [
          context.workspaceId,
          input.roomId ?? null,
          eventType,
          resources[0]?.kind ?? null,
          resources[0]?.id ?? null,
          operationId,
          canonicalJson(input.payload),
          eventId,
          eventVersion,
          input.actor.kind,
          input.actor.id ?? null,
          organizationId,
          cursor,
          input.correlationId ?? operationId,
          canonicalJson(resources)
        ]
      );
      if (saved.rows[0]) return { event: publicEventFromRow(saved.rows[0]), replayed: false };
      const existing = await sql.query<PublicEventRow>(
        `SELECT id, workspace_id, room_id, kind, record_type, record_id, operation_id, payload, created_at,
                event_id, event_version, actor_kind, actor_id, organization_id, cursor, correlation_id, resources
         FROM workspace_events WHERE workspace_id = $1 AND event_id = $2`,
        [context.workspaceId, eventId]
      );
      const row = existing.rows[0];
      if (!row) throw new WorkspaceServerError("workspace_event_creation_failed", 500);
      const existingEvent = publicEventFromRow(row);
      const requested = {
        eventType,
        eventVersion,
        roomId: input.roomId,
        organizationId,
        actor: input.actor,
        operationId,
        correlationId: input.correlationId ?? operationId,
        payload: input.payload,
        resources
      };
      const stored = {
        eventType: existingEvent.eventType,
        eventVersion: existingEvent.eventVersion,
        roomId: existingEvent.scope.roomId,
        organizationId: existingEvent.scope.organizationId,
        actor: existingEvent.actor,
        operationId: existingEvent.operationId,
        correlationId: existingEvent.correlationId,
        payload: existingEvent.payload,
        resources: existingEvent.resources
      };
      if (canonicalJson(requested) !== canonicalJson(stored)) throw new WorkspaceServerError("workspace_event_idempotency_conflict", 409);
      return { event: existingEvent, replayed: true };
    });
  }

  async putJob(context: WorkspaceRequestContext, input: {
    roomId: string;
    id?: string;
    kind: string;
    idempotencyKey: string;
    expectedVersion?: number;
    status?: WorkspaceJob["status"];
    payload: WorkspaceRecordPayload;
  }): Promise<PutJobResult> {
    assertOpaqueId(input.roomId, "room_id_invalid");
    assertOpaqueId(input.idempotencyKey, "workspace_job_idempotency_key_invalid");
    const id = input.id ?? operationScopedId("job", context.workspaceId, context.operationId);
    assertOpaqueId(id, "workspace_job_id_invalid");
    const expectedVersion = input.expectedVersion ?? 0;
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) throw new WorkspaceServerError("workspace_job_expected_version_invalid", 400);
    const payload = canonicalJson(input.payload);
    const result = await this.runIdempotentResult(context, { action: "workspace.job.put", input: { ...input, id } }, async (sql) => {
      await this.assertWorkspaceWritable(sql, context.workspaceId);
      const saved = await sql.query<JobRow>(
        `INSERT INTO workspace_jobs(workspace_id, room_id, id, kind, status, version, idempotency_key, payload, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, 1, $6, $7::JSONB, $8, $8)
         ON CONFLICT (workspace_id, id) DO UPDATE SET
           status = EXCLUDED.status,
           version = workspace_jobs.version + 1,
           payload = EXCLUDED.payload,
           updated_by = EXCLUDED.updated_by,
           updated_at = NOW()
         WHERE workspace_jobs.version = $9
         RETURNING workspace_id, room_id, id, kind, status, version, idempotency_key, payload, created_at, updated_at`,
        [context.workspaceId, input.roomId, id, input.kind, input.status ?? "queued", input.idempotencyKey, payload, context.accountId, expectedVersion]
      );
      const row = saved.rows[0];
      if (!row) throw new WorkspaceServerError("workspace_job_version_conflict", 409);
      const event = await this.insertEvent(sql, context, {
        roomId: input.roomId,
        kind: "workspace.job.updated",
        payload: { job_id: id, version: Number(row.version), status: row.status }
      });
      const job = jobFromRow(row);
      await this.insertAudit(sql, context, {
        action: "workspace.job.put",
        roomId: input.roomId,
        subjectKind: "workspace_job",
        subjectId: id,
        beforeVersion: expectedVersion,
        afterVersion: job.version,
        details: { status: job.status, kind: job.kind }
      });
      return { job, event };
    });
    return { ...result.value, replayed: result.replayed };
  }

  async assertRoomReadable(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, roomId: string): Promise<void> {
    assertOpaqueId(roomId, "room_id_invalid");
    await this.database.withContext(context, async (sql) => {
      const result = await sql.query<{ id: string }>("SELECT id FROM rooms WHERE workspace_id = $1 AND id = $2", [context.workspaceId, roomId]);
      // This method is used by the public Socket boundary. Missing and
      // unreadable Rooms must have the same externally visible response.
      if (!result.rows[0]) throw new WorkspaceServerError("room_not_available", 404);
    });
  }

  /**
   * Socket delivery takes the shared half of the same PostgreSQL advisory
   * lock used by hierarchy and membership mutations.  The callback must only
   * enqueue a small local Socket.IO message; it must not wait on a remote
   * operation.  This makes the final access check and the enqueue happen
   * before a concurrent revoke can commit, even when two Server processes
   * share the same database.
   */
  async deliverRoomRealtimeIfReadable(
    context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">,
    roomId: string,
    deliver: () => void | Promise<void>
  ): Promise<boolean> {
    assertOpaqueId(roomId, "room_id_invalid");
    return this.database.withContext(context, async (sql) => {
      await sql.query(
        "SELECT pg_advisory_xact_lock_shared(hashtextextended('samurai.workspace.room_hierarchy:' || $1, 0))",
        [context.workspaceId]
      );
      const allowed = await sql.query<{ readable: boolean }>(
        "SELECT samurai_can_room($1, $2, 'read') AS readable",
        [context.workspaceId, roomId]
      );
      if (allowed.rows[0]?.readable !== true) return false;
      await deliver();
      return true;
    });
  }

  /** Checks edit permission before a file body is staged on disk. */
  async assertRoomWritable(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, roomId: string): Promise<void> {
    assertOpaqueId(roomId, "room_id_invalid");
    await this.database.withContext(context, async (sql) => {
      const result = await sql.query<{ writable: boolean }>(
        "SELECT samurai_workspace_is_writable($1) AND samurai_can_room($1, $2, 'edit') AS writable",
        [context.workspaceId, roomId]
      );
      if (result.rows[0]?.writable !== true) throw new WorkspaceServerError("room_not_writable_or_access_denied", 403);
    });
  }

  /** Checks the stronger Room permission used by executable Surface actions. */
  async assertRoomExecutable(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, roomId: string): Promise<void> {
    assertOpaqueId(roomId, "room_id_invalid");
    await this.database.withContext(context, async (sql) => {
      const result = await sql.query<{ executable: boolean }>(
        "SELECT samurai_workspace_is_writable($1) AND samurai_can_room($1, $2, 'execute') AS executable",
        [context.workspaceId, roomId]
      );
      if (result.rows[0]?.executable !== true) throw new WorkspaceServerError("room_not_executable_or_access_denied", 403);
    });
  }

  async getWorkspaceMember(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, accountId: string): Promise<WorkspaceMembership | undefined> {
    assertOpaqueId(accountId, "account_id_invalid");
    return this.database.withContext(context, async (sql) => this.selectWorkspaceMember(sql, context.workspaceId, accountId));
  }

  async getRoomMember(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, roomId: string, accountId: string): Promise<WorkspaceRoomMembership | undefined> {
    assertOpaqueId(roomId, "room_id_invalid");
    assertOpaqueId(accountId, "account_id_invalid");
    return this.database.withContext(context, async (sql) => this.selectRoomMember(sql, context.workspaceId, roomId, accountId));
  }

  async listAuditEntries(
    context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">,
    input: { afterId?: number; limit?: number; subjectKind?: string; subjectId?: string } = {}
  ): Promise<WorkspaceAuditEntry[]> {
    const afterId = input.afterId ?? 0;
    if (!Number.isSafeInteger(afterId) || afterId < 0) throw new WorkspaceServerError("workspace_audit_cursor_invalid", 400);
    if (input.subjectKind !== undefined && (!input.subjectKind.trim() || input.subjectKind.length > 128)) throw new WorkspaceServerError("workspace_audit_subject_invalid", 400);
    if (input.subjectId !== undefined && (!input.subjectId.trim() || input.subjectId.length > 256)) throw new WorkspaceServerError("workspace_audit_subject_invalid", 400);
    const limit = boundedLimit(input.limit);
    return this.database.withContext(context, async (sql) => {
      const result = await sql.query<AuditRow>(
        `SELECT id, workspace_id, room_id, actor_account_id, action, outcome, operation_id, subject_kind, subject_id,
                before_version, after_version, details, created_at
         FROM workspace_audit_entries
         WHERE workspace_id = $1 AND id > $2
           AND ($3::TEXT IS NULL OR subject_kind = $3)
           AND ($4::TEXT IS NULL OR subject_id = $4)
         ORDER BY id ASC LIMIT $5`,
        [context.workspaceId, afterId, input.subjectKind ?? null, input.subjectId ?? null, limit]
      );
      return result.rows.map(auditFromRow);
    });
  }

  /** Used by file and transfer services while they are already inside one RLS transaction. */
  async insertAudit(sql: WorkspaceSql, context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId" | "operationId">, input: {
    action: string;
    outcome?: "completed" | "rejected" | "failed";
    roomId?: string;
    subjectKind?: string;
    subjectId?: string;
    beforeVersion?: number;
    afterVersion?: number;
    details?: WorkspaceRecordPayload;
  }): Promise<void> {
    await sql.query(
      `SELECT samurai_append_workspace_audit(
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::JSONB
       )`,
      [
        context.workspaceId,
        input.roomId ?? null,
        input.action,
        input.outcome ?? "completed",
        context.operationId,
        input.subjectKind ?? null,
        input.subjectId ?? null,
        input.beforeVersion ?? null,
        input.afterVersion ?? null,
        canonicalJson(input.details ?? {})
      ]
    );
  }

  async runIdempotent<T>(
    context: WorkspaceRequestContext,
    request: { action: string; input: unknown },
    action: (sql: WorkspaceSql) => Promise<T>,
    options: IdempotentOperationOptions = {}
  ): Promise<T> {
    return (await this.runIdempotentResult(context, request, action, options)).value;
  }

  /**
   * Replays a failed transfer phase only when the caller opts into this
   * transfer-specific lane. Ordinary idempotent operations retain the
   * terminal `workspace_operation_previously_failed` behavior.
   */
  async runTransferIdempotent<T>(
    context: WorkspaceRequestContext,
    request: { action: string; input: unknown },
    action: (sql: WorkspaceSql) => Promise<T>
  ): Promise<T> {
    return (await this.runTransferIdempotentResult(context, request, action)).value;
  }

  async runTransferIdempotentResult<T>(
    context: WorkspaceRequestContext,
    request: { action: string; input: unknown },
    action: (sql: WorkspaceSql) => Promise<T>
  ): Promise<IdempotentOperationResult<T>> {
    if (!isTransferReplayAction(request.action)) {
      throw new WorkspaceServerError("workspace_transfer_replay_not_allowed", 400);
    }
    return this.runIdempotentResult(context, request, action, { allowFailedTransferReplay: true });
  }

  /**
   * Internal services that must decide whether to emit an external signal use
   * this instead of guessing from the returned value.  The result itself is
   * still stored exactly once in the operation ledger.
   */
  async runIdempotentResult<T>(
    context: WorkspaceRequestContext,
    request: { action: string; input: unknown },
    action: (sql: WorkspaceSql) => Promise<T>,
    options: IdempotentOperationOptions = {}
  ): Promise<IdempotentOperationResult<T>> {
    assertOpaqueId(context.workspaceId, "workspace_id_invalid");
    assertOpaqueId(context.accountId, "account_id_invalid");
    assertOpaqueId(context.operationId, "operation_id_invalid");
    const requestHash = hash(canonicalJson(request));
    let originalFailure: unknown;
    const value = await this.database.withContext(context, async (sql) => {
      if (options.lockRoomHierarchy) {
        // Room hierarchy mutations also lock this key inside their guarded SQL
        // functions. Acquire it before inserting the operation ledger row:
        // that insert holds a workspace foreign-key lock, while the SQL
        // function later locks the Workspace row. Keeping this order prevents
        // a concurrent hierarchy mutation from forming a lock cycle.
        await sql.query(
          "SELECT pg_advisory_xact_lock(hashtextextended('samurai.workspace.room_hierarchy:' || $1, 0))",
          [context.workspaceId]
        );
      }
      const inserted = await sql.query<{ id: string }>(
        `INSERT INTO workspace_operations(workspace_id, id, idempotency_key, actor_account_id, request_hash, status)
         VALUES ($1, $2, $2, $3, $4, 'running')
         ON CONFLICT (workspace_id, idempotency_key) DO NOTHING
         RETURNING id`,
        [context.workspaceId, context.operationId, context.accountId, requestHash]
      );
      if (!inserted.rows[0]) {
        const existing = await sql.query<{ request_hash: string; status: string; result: unknown }>(
          "SELECT request_hash, status, result FROM workspace_operations WHERE workspace_id = $1 AND idempotency_key = $2 FOR UPDATE",
          [context.workspaceId, context.operationId]
        );
        const operation = existing.rows[0];
        if (!operation || operation.request_hash !== requestHash) throw new WorkspaceServerError("workspace_operation_id_reused", 409);
        if (operation.status === "failed") {
          if (!options.allowFailedTransferReplay || !isTransferReplayAction(request.action)) {
            throw new WorkspaceServerError("workspace_operation_previously_failed", 409);
          }
          const retried = await sql.query<{ id: string }>(
            `UPDATE workspace_operations SET status = 'running', result = NULL, error_code = NULL, updated_at = NOW()
             WHERE workspace_id = $1 AND id = $2 AND request_hash = $3 AND status = 'failed'
             RETURNING id`,
            [context.workspaceId, context.operationId, requestHash]
          );
          if (!retried.rows[0]) throw new WorkspaceServerError("workspace_operation_previously_failed", 409);
        } else {
          if (operation.status !== "completed" || operation.result === null) throw new WorkspaceServerError("workspace_operation_in_progress", 409);
          // `begin` completes its operation ledger before the file export. If
          // that later export fails, the transfer is returned to `active` and
          // marked `failed`/`rolled_back` by the transfer SQL function. The
          // same explicit begin operation is then allowed to reopen the
          // ledger, but only while the durable transfer is terminal and the
          // request hash is still identical. A successful transfer remains a
          // normal idempotent replay and is never executed twice.
          const transferId = options.allowFailedTransferReplay && request.action === "workspace.transfer.begin"
            ? transferIdFromInput(request.input)
            : undefined;
          if (!transferId) return { value: operation.result as T, replayed: true };
          const transfer = await sql.query<{ state: string }>(
            // This is a read-only terminal-state probe.  The Workspace
            // transfer table intentionally has no UPDATE policy for the
            // caller, so SELECT ... FOR UPDATE would be filtered by RLS even
            // when the owner can read the row.  The operation row is already
            // locked above and the conditional operation UPDATE below keeps
            // the reopen atomic; the transfer SQL functions remain the
            // authority for their own row lock and state transition.
            "SELECT state FROM workspace_transfers WHERE workspace_id = $1 AND id = $2",
            [context.workspaceId, transferId]
          );
          if (transfer.rows[0]?.state !== "failed" && transfer.rows[0]?.state !== "rolled_back") {
            return { value: operation.result as T, replayed: true };
          }
          const retried = await sql.query<{ id: string }>(
            `UPDATE workspace_operations SET status = 'running', result = NULL, error_code = NULL, updated_at = NOW()
             WHERE workspace_id = $1 AND id = $2 AND request_hash = $3 AND status = 'completed'
             RETURNING id`,
            [context.workspaceId, context.operationId, requestHash]
          );
          if (!retried.rows[0]) throw new WorkspaceServerError("workspace_operation_in_progress", 409);
        }
      }
      // A rejected write can be a PostgreSQL error.  PostgreSQL marks the
      // surrounding transaction as failed in that case, so keep the business
      // action behind a savepoint before recording its durable failed result.
      await sql.query("SAVEPOINT samurai_workspace_operation_action");
      let completed: T;
      try {
        completed = await action(sql);
      } catch (error) {
        await sql.query("ROLLBACK TO SAVEPOINT samurai_workspace_operation_action");
        await sql.query("RELEASE SAVEPOINT samurai_workspace_operation_action");
        const code = operationErrorCode(error);
        await sql.query(
          `UPDATE workspace_operations SET status = 'failed', error_code = $3, updated_at = NOW()
           WHERE workspace_id = $1 AND id = $2`,
          [context.workspaceId, context.operationId, code]
        );
        // Invitation acceptance is the one Workspace mutation that can be
        // attempted before the caller has a membership. Keep its failed
        // operation durable, but do not grant an arbitrary authenticated
        // Account permission to append an audit row to another Workspace.
        if (await this.selectWorkspaceMember(sql, context.workspaceId, context.accountId)) {
          await this.insertAudit(sql, context, {
            action: request.action,
            outcome: error instanceof WorkspaceServerError && error.status < 500 ? "rejected" : "failed",
            subjectKind: "operation",
            subjectId: context.operationId,
            details: { error_code: code }
          });
        }
        originalFailure = error;
        return { value: undefined as T, replayed: false };
      }
      await sql.query("RELEASE SAVEPOINT samurai_workspace_operation_action");
      await sql.query(
        `UPDATE workspace_operations SET status = 'completed', result = $3::JSONB, updated_at = NOW()
         WHERE workspace_id = $1 AND id = $2`,
        [context.workspaceId, context.operationId, canonicalJson(completed === undefined ? {} : completed)]
      );
      return { value: completed, replayed: false };
    });
    if (originalFailure) throw originalFailure;
    return value;
  }

  /** Account-level operations create a Workspace before a Workspace operation ledger exists. */
  async runAccountIdempotent<T>(
    accountId: string,
    operationId: string,
    workspaceId: string,
    request: { action: string; input: unknown },
    action: (sql: WorkspaceSql) => Promise<T>
  ): Promise<T> {
    return (await this.runAccountIdempotentResult(accountId, operationId, workspaceId, request, action)).value;
  }

  /** Account-level counterpart of runIdempotentResult for invitation acceptance. */
  async runAccountIdempotentResult<T>(
    accountId: string,
    operationId: string,
    workspaceId: string,
    request: { action: string; input: unknown },
    action: (sql: WorkspaceSql) => Promise<T>
  ): Promise<IdempotentOperationResult<T>> {
    assertOpaqueId(accountId, "account_id_invalid");
    assertOpaqueId(operationId, "workspace_operation_id_invalid");
    assertOpaqueId(workspaceId, "workspace_id_invalid");
    const requestHash = hash(canonicalJson(request));
    return this.database.withContext({ accountId, workspaceId }, async (sql) => {
      const inserted = await sql.query<{ id: string }>(
        `INSERT INTO account_operations(account_id, id, request_hash, status)
         VALUES ($1, $2, $3, 'running')
         ON CONFLICT (account_id, id) DO NOTHING
         RETURNING id`,
        [accountId, operationId, requestHash]
      );
      if (!inserted.rows[0]) {
        const existing = await sql.query<{ request_hash: string; status: string; result: unknown }>(
          "SELECT request_hash, status, result FROM account_operations WHERE account_id = $1 AND id = $2",
          [accountId, operationId]
        );
        const operation = existing.rows[0];
        if (!operation || operation.request_hash !== requestHash) throw new WorkspaceServerError("workspace_operation_id_reused", 409);
        if (operation.status !== "completed" || operation.result === null) throw new WorkspaceServerError("workspace_operation_in_progress", 409);
        return { value: operation.result as T, replayed: true };
      }
      const value = await action(sql);
      await sql.query(
        `UPDATE account_operations SET status = 'completed', result = $3::JSONB, updated_at = NOW()
         WHERE account_id = $1 AND id = $2`,
        [accountId, operationId, canonicalJson(value === undefined ? {} : value)]
      );
      return { value, replayed: false };
    });
  }

  private async runOrganizationIdempotentResult<T>(
    context: OrganizationRequestContext,
    organizationId: string | undefined,
    request: { action: string; input: unknown },
    action: (sql: WorkspaceSql) => Promise<T>
  ): Promise<IdempotentOperationResult<T>> {
    assertOpaqueId(context.accountId, "account_id_invalid");
    assertOpaqueId(context.operationId, "organization_operation_id_invalid");
    if (organizationId) assertOpaqueId(organizationId, "organization_id_invalid");
    const requestHash = hash(canonicalJson(request));
    let originalFailure: unknown;
    const value = await this.database.withContext({ accountId: context.accountId }, async (sql) => {
      const inserted = await sql.query<{ id: string }>(
        `INSERT INTO organization_operations(actor_account_id, id, organization_id, idempotency_key, request_hash, status)
         VALUES ($1, $2, $3, $2, $4, 'running')
         ON CONFLICT (actor_account_id, idempotency_key) DO NOTHING
         RETURNING id`,
        [context.accountId, context.operationId, organizationId ?? null, requestHash]
      );
      if (!inserted.rows[0]) {
        const existing = await sql.query<{ request_hash: string; status: string; result: unknown }>(
          "SELECT request_hash, status, result FROM organization_operations WHERE actor_account_id = $1 AND idempotency_key = $2",
          [context.accountId, context.operationId]
        );
        const operation = existing.rows[0];
        if (!operation || operation.request_hash !== requestHash) throw new WorkspaceServerError("organization_operation_id_reused", 409);
        if (operation.status === "failed") throw new WorkspaceServerError("organization_operation_previously_failed", 409);
        if (operation.status !== "completed" || operation.result === null) throw new WorkspaceServerError("organization_operation_in_progress", 409);
        return { value: operation.result as T, replayed: true };
      }
      await sql.query("SAVEPOINT samurai_organization_operation_action");
      let completed: T;
      try {
        completed = await action(sql);
      } catch (error) {
        await sql.query("ROLLBACK TO SAVEPOINT samurai_organization_operation_action");
        await sql.query("RELEASE SAVEPOINT samurai_organization_operation_action");
        await sql.query(
          `UPDATE organization_operations SET status = 'failed', error_code = $3, result = $4::JSONB, updated_at = NOW()
           WHERE actor_account_id = $1 AND id = $2`,
          [context.accountId, context.operationId, organizationOperationErrorCode(error), canonicalJson(organizationOperationFailureProjection(request, context.operationId, organizationOperationErrorCode(error)) ?? {})]
        );
        originalFailure = error;
        return { value: undefined as T, replayed: false };
      }
      await sql.query("RELEASE SAVEPOINT samurai_organization_operation_action");
      await sql.query(
        `UPDATE organization_operations SET status = 'completed', organization_id = COALESCE(organization_id, $3), result = $4::JSONB, updated_at = NOW()
         WHERE actor_account_id = $1 AND id = $2`,
        [context.accountId, context.operationId, organizationId ?? null, canonicalJson(stripEphemeralOrganizationSecrets(completed === undefined ? {} : completed))]
      );
      return { value: completed, replayed: false };
    });
    if (originalFailure) throw originalFailure;
    return value;
  }

  private async setOrganizationMember(
    context: OrganizationRequestContext,
    input: { organizationId?: string; organization_id?: string; accountId?: string; target_account_id?: string; role?: OrganizationRole; expectedVersion?: number; expected_version?: number },
    state: "active" | "removed"
  ): Promise<OrganizationMembership> {
    const organizationId = organizationIdFrom(context, input.organizationId ?? input.organization_id);
    const accountId = input.accountId ?? input.target_account_id;
    assertOpaqueId(accountId ?? "", "account_id_invalid");
    if (input.role !== undefined) assertOrganizationRole(input.role);
    const suppliedExpectedVersion = input.expectedVersion ?? input.expected_version;
    if (suppliedExpectedVersion !== undefined) assertExpectedVersion(suppliedExpectedVersion, "organization_membership_expected_version_invalid", 0);
    const result = await this.runOrganizationIdempotentResult(context, organizationId, { action: state === "active" ? "organization.member.role.change" : "organization.member.remove", input: { organizationId, accountId, ...(input.role ? { role: input.role } : {}), state, expectedVersion: suppliedExpectedVersion ?? null } }, async (sql) => {
      const current = (await sql.query<OrganizationMembershipRow>(
        `SELECT organization_id, account_id, role, state, version, joined_at, removed_at, created_by, updated_by
           FROM organization_members WHERE organization_id = $1 AND account_id = $2`, [organizationId, accountId]
      )).rows[0];
      if (!current && state === "removed") throw new WorkspaceServerError("organization_member_not_found", 404);
      const role = input.role ?? current?.role;
      if (!role) throw new WorkspaceServerError("organization_role_invalid", 400);
      const expectedVersion = suppliedExpectedVersion ?? Number(current?.version ?? 0);
      try {
        await sql.query("SELECT samurai_set_organization_member($1, $2, $3, $4, $5, $6)", [organizationId, accountId, role, state, expectedVersion, context.operationId]);
      } catch (error) {
        throw mapOrganizationPostgresError(error, "organization_membership_update_failed");
      }
      const row = (await sql.query<OrganizationMembershipRow>(
        "SELECT organization_id, account_id, role, state, version, joined_at, removed_at, created_by, updated_by FROM organization_members WHERE organization_id = $1 AND account_id = $2", [organizationId, accountId]
      )).rows[0];
      if (!row) throw new WorkspaceServerError("organization_membership_update_failed", 500);
      return organizationMembershipFromRow(row);
    });
    return { ...result.value, replayed: result.replayed };
  }

  private async getOrganizationInvitation(context: OrganizationRequestContext, organizationId: string, invitationId: string): Promise<OrganizationInvitation> {
    return this.database.withContext({ accountId: context.accountId }, async (sql) => {
      const invitation = await this.selectOrganizationInvitation(sql, organizationId, invitationId);
      if (!invitation) throw new WorkspaceServerError("organization_invitation_not_found", 404);
      return invitation;
    });
  }

  private async selectOrganizationInvitation(sql: WorkspaceSql, organizationId: string, invitationId: string): Promise<OrganizationInvitation | undefined> {
    const row = (await sql.query<OrganizationInvitationRow>(
      `SELECT id, organization_id, target_account_id, role, version, expires_at, issued_by,
              created_at, updated_at, revoked_at, accepted_by, accepted_at
         FROM organization_invitations WHERE organization_id = $1 AND id = $2`, [organizationId, invitationId]
    )).rows[0];
    if (!row) return undefined;
    const grants = await sql.query<OrganizationInvitationGrantRow>(
      `SELECT id, organization_id, invitation_id, workspace_id, workspace_role, room_id, room_role
         FROM organization_invitation_workspace_grants WHERE organization_id = $1 AND invitation_id = $2 ORDER BY id`, [organizationId, invitationId]
    );
    return organizationInvitationFromRow(row, grants.rows);
  }

  private async setOrganizationWorkspaceMembership(
    context: OrganizationRequestContext,
    input: { organizationId?: string; organization_id?: string; workspaceId?: string; workspace_id?: string; accountId?: string; target_account_id?: string; role: WorkspaceMembershipRole; expectedVersion?: number; expected_version?: number },
    state: "active" | "revoked"
  ): Promise<OrganizationWorkspaceMembership> {
    const organizationId = organizationIdFrom(context, input.organizationId ?? input.organization_id);
    const workspaceId = input.workspaceId ?? input.workspace_id;
    const accountId = input.accountId ?? input.target_account_id;
    assertOpaqueId(workspaceId ?? "", "workspace_id_invalid");
    assertOpaqueId(accountId ?? "", "account_id_invalid");
    assertRole(input.role);
    const suppliedExpectedVersion = input.expectedVersion ?? input.expected_version;
    if (suppliedExpectedVersion !== undefined) assertExpectedVersion(suppliedExpectedVersion, "workspace_membership_expected_version_invalid", 0);
    const result = await this.runOrganizationIdempotentResult(context, organizationId, { action: state === "active" ? "organization.workspace.member.grant" : "organization.workspace.member.revoke", input: { organizationId, workspaceId, accountId, role: input.role, state, expectedVersion: suppliedExpectedVersion ?? null } }, async (sql) => {
      try {
        await sql.query("SELECT set_config('samurai.workspace_id', $1, true)", [workspaceId]);
        const current = (await sql.query<MembershipRow>(
          "SELECT workspace_id, account_id, role, state, version, created_at, updated_at, revoked_at FROM workspace_members WHERE workspace_id = $1 AND account_id = $2", [workspaceId, accountId]
        )).rows[0];
        if (!current && state === "revoked") throw new WorkspaceServerError("organization_workspace_member_not_found", 404);
        const expectedVersion = suppliedExpectedVersion ?? Number(current?.version ?? 0);
        await sql.query("SELECT samurai_set_organization_workspace_member($1, $2, $3, $4, $5, $6, $7)", [organizationId, workspaceId, accountId, input.role, state, expectedVersion, context.operationId]);
      } catch (error) {
        throw mapOrganizationPostgresError(error, "organization_workspace_membership_update_failed");
      }
      const row = (await sql.query<MembershipRow>(
        "SELECT workspace_id, account_id, role, state, version, created_at, updated_at, revoked_at FROM workspace_members WHERE workspace_id = $1 AND account_id = $2", [workspaceId, accountId]
      )).rows[0];
      if (!row) throw new WorkspaceServerError("organization_workspace_membership_update_failed", 500);
      const createdAt = iso(row.created_at);
      return { id: `${row.workspace_id}:${row.account_id}`, organizationId, workspaceId: row.workspace_id, accountId: row.account_id, role: row.role, state: row.state, version: Number(row.version), joinedAt: createdAt, createdAt, createdBy: row.account_id, updatedAt: iso(row.updated_at), ...(row.revoked_at ? { revokedAt: iso(row.revoked_at) } : {}) };
    });
    return { ...result.value, replayed: result.replayed };
  }

  private async setOrganizationWorkspaceLifecycle(
    context: OrganizationRequestContext,
    input: { organizationId?: string; organization_id?: string; workspaceId?: string; workspace_id?: string; expectedVersion?: number; expected_version?: number; confirm?: true },
    state: "active" | "archived" | "deleted"
  ): Promise<OrganizationWorkspaceSummary> {
    const organizationId = organizationIdFrom(context, input.organizationId ?? input.organization_id);
    const workspaceId = assertOpaqueId(input.workspaceId ?? input.workspace_id ?? "", "workspace_id_invalid");
    const suppliedExpectedVersion = input.expectedVersion ?? input.expected_version;
    if (suppliedExpectedVersion !== undefined) assertExpectedVersion(suppliedExpectedVersion, "workspace_expected_version_invalid", 1);
    if (input.confirm !== true) throw new WorkspaceServerError("workspace_lifecycle_confirmation_required", 400);
    const result = await this.runOrganizationIdempotentResult(context, organizationId, { action: `organization.workspace.${state === "active" ? "restore" : state}`, input: { organizationId, workspaceId, state, expectedVersion: suppliedExpectedVersion ?? null } }, async (sql) => {
      await sql.query("SELECT set_config('samurai.workspace_id', $1, true)", [workspaceId]);
      const current = (await sql.query<{ version: number | string }>(
        "SELECT version FROM workspaces WHERE id = $1 AND organization_id = $2", [workspaceId, organizationId]
      )).rows[0];
      if (!current) throw new WorkspaceServerError("workspace_not_found", 404);
      const expectedVersion = suppliedExpectedVersion ?? Number(current.version);
      try {
        await sql.query("SELECT samurai_set_organization_workspace_lifecycle($1, $2, $3, $4, $5)", [organizationId, workspaceId, state, expectedVersion, context.operationId]);
      } catch (error) {
        throw mapOrganizationPostgresError(error, "workspace_lifecycle_failed");
      }
      const row = (await sql.query<OrganizationWorkspaceRow>("SELECT id, organization_id, name, state, version, created_at, updated_at FROM workspaces WHERE id = $1", [workspaceId])).rows[0];
      if (!row) throw new WorkspaceServerError("workspace_not_found", 404);
      return organizationWorkspaceFromRow(row);
    });
    return { ...result.value, replayed: result.replayed };
  }

  private async organizationWorkspaceSummary(
    sql: WorkspaceSql,
    accountId: string,
    row: OrganizationWorkspaceRow
  ): Promise<OrganizationWorkspaceSummary> {
    const member = await sql.query<{ role: WorkspaceMembershipRole }>(
      `SELECT role FROM workspace_members
       WHERE workspace_id = $1 AND account_id = $2 AND state = 'active'`,
      [row.id, accountId]
    );
    return organizationWorkspaceFromRow({
      ...row,
      workspace_role: member.rows[0]?.role ?? null
    });
  }

  private async readHumanWorkAggregate(
    sql: WorkspaceSql,
    workspaceId: string,
    workId: string,
    roomId: string,
    knownRow?: HumanWorkRow,
    includeDetails = false
  ): Promise<WorkspaceHumanWork | WorkspaceHumanWorkView> {
    const row = knownRow ?? (await sql.query<HumanWorkRow>(
      `SELECT workspace_id, id, room_id, requester_account_id, default_agent_id,
              default_agent_version, title, objective, completion_criteria, status,
              resource_refs, stop_state, instruction_version, control_generation, operation_id,
              created_at, updated_at
       FROM workspace_human_works WHERE workspace_id = $1 AND id = $2`,
      [workspaceId, workId]
    )).rows[0];
    if (!row || row.room_id !== roomId) throw new WorkspaceServerError("human_work_not_found", 404);
    const assignmentRows = await sql.query<HumanWorkAssignmentRow>(
      `SELECT workspace_id, id, work_id, room_id, parent_assignment_id, dependency_assignment_ids, agent_id,
              agent_version, instruction_version, attempt, priority, status, current_run_id,
              result, lease_owner, lease_expires_at, created_at, updated_at, started_at, completed_at
       FROM workspace_human_work_assignments
       WHERE workspace_id = $1 AND work_id = $2 ORDER BY created_at, id`,
      [workspaceId, workId]
    );
    const work = {
      workspaceId: row.workspace_id,
      id: row.id,
      roomId: row.room_id,
      requesterAccountId: row.requester_account_id,
      defaultAgentId: row.default_agent_id,
      defaultAgentVersion: Number(row.default_agent_version),
      title: row.title,
      objective: row.objective,
      completionCriteria: jsonArray(row.completion_criteria),
      resourceRefs: normalizeRoomWorkResourceRefsForRead(row.resource_refs),
      status: row.status,
      stopState: row.stop_state,
      instructionVersion: Number(row.instruction_version),
      controlGeneration: Number(row.control_generation),
      operationId: row.operation_id,
      assignments: assignmentRows.rows.map((assignment) => humanWorkAssignmentFromRow(assignment, Number(row.control_generation))),
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at)
    } as WorkspaceHumanWork & { resourceRefs: RoomWorkResourceRef[] };
    if (!includeDetails) return work;
    // Keep all detail reads on the same transaction-bound PostgreSQL client
    // strictly sequential. `pg` does not support overlapping queries on one
    // client reliably, and parallel calls can also make the RLS snapshot
    // ordering nondeterministic while a Room Work view is assembled.
    const instructionRows = await sql.query<HumanWorkInstructionRow>(
      `SELECT workspace_id, id, work_id, assignment_id, room_id, version, body,
              samurai_project_human_work_attachment_refs(workspace_id, room_id, attachment_refs) AS attachment_refs,
              resource_refs,
              source_kind, source_comment_id, source_comment_version,
              state, created_by, created_at
       FROM workspace_human_work_instructions WHERE workspace_id = $1 AND work_id = $2 ORDER BY version`,
      [workspaceId, workId]
    );
    const commentRows = await sql.query<HumanWorkCommentRow>(
      `SELECT workspace_id, id, work_id, room_id, author_account_id, version, body,
              samurai_project_human_work_attachment_refs(workspace_id, room_id, attachment_refs) AS attachment_refs,
              created_at
       FROM workspace_human_work_comments WHERE workspace_id = $1 AND work_id = $2 ORDER BY version`,
      [workspaceId, workId]
    );
    const controlRows = await sql.query<HumanWorkControlRow>(
      `SELECT workspace_id, id, work_id, assignment_id, room_id, action, state,
              actor_account_id, generation, operation_id, details, created_at, updated_at
       FROM workspace_human_work_controls WHERE workspace_id = $1 AND work_id = $2 ORDER BY created_at, id`,
      [workspaceId, workId]
    );
    const reactionRows = await sql.query<HumanWorkReactionRow>(
      `SELECT workspace_id, id, work_id, room_id, comment_id, actor_account_id,
              reaction, enabled, version, created_at, updated_at
       FROM workspace_human_work_comment_reactions WHERE workspace_id = $1 AND work_id = $2 ORDER BY created_at, id`,
      [workspaceId, workId]
    );
    const reservationRows = await sql.query<HumanWorkReservationRow>(
      `SELECT workspace_id, id, work_id, assignment_id, room_id, generation, status,
              operation_id, scheduled_at, lease_owner, lease_expires_at, claimed_at,
              released_at, created_at, updated_at
       FROM workspace_human_work_launch_reservations WHERE workspace_id = $1 AND work_id = $2 ORDER BY created_at, id`,
      [workspaceId, workId]
    );
    const appliedByComment = new Map<string, string[]>();
    for (const instruction of instructionRows.rows) {
      if (instruction.source_comment_id) {
        const current = appliedByComment.get(instruction.source_comment_id) ?? [];
        current.push(instruction.id);
        appliedByComment.set(instruction.source_comment_id, current);
      }
    }
    const reactionCounts = new Map<string, number>();
    for (const reaction of reactionRows.rows) {
      if (!reaction.enabled) continue;
      reactionCounts.set(reaction.comment_id, (reactionCounts.get(reaction.comment_id) ?? 0) + 1);
    }
    const comments = commentRows.rows.map((comment) => humanWorkCommentFromRow(
      comment,
      reactionCounts.get(comment.id) ?? 0,
      appliedByComment.get(comment.id) ?? []
    ));
    return {
      ...work,
      instructions: instructionRows.rows.map(humanWorkInstructionFromRow),
      comments,
      reactions: reactionRows.rows.map(humanWorkReactionFromRow),
      controls: controlRows.rows.map(humanWorkControlFromRow),
      launchReservations: reservationRows.rows.map(humanWorkReservationFromRow)
    };
  }

  private async readHumanWorkReservation(sql: WorkspaceSql, workspaceId: string, reservationId: string): Promise<WorkspaceHumanWorkLaunchReservation | undefined> {
    const row = (await sql.query<HumanWorkReservationRow>(
      `SELECT workspace_id, id, work_id, assignment_id, room_id, generation, status,
              operation_id, scheduled_at, lease_owner, lease_expires_at, claimed_at,
              released_at, created_at, updated_at
       FROM workspace_human_work_launch_reservations WHERE workspace_id = $1 AND id = $2`,
      [workspaceId, reservationId]
    )).rows[0];
    return row ? humanWorkReservationFromRow(row) : undefined;
  }

  /**
   * Hold the same Room lock as the create function without giving the runtime
   * role UPDATE on Rooms. The lock stays active until the surrounding action
   * transaction finishes, so a default-Agent change cannot race a new Work.
   */
  private async lockRoomDefaultAgent(
    sql: WorkspaceSql,
    workspaceId: string,
    roomId: string
  ): Promise<{ default_agent_id: string | null; default_agent_version: number | string | null }> {
    try {
      const row = (await sql.query<{ default_agent_id: string | null; default_agent_version: number | string | null }>(
        "SELECT default_agent_id, default_agent_version FROM samurai_lock_room_default_agent($1, $2)",
        [workspaceId, roomId]
      )).rows[0];
      if (!row) throw new WorkspaceServerError("room_not_available", 404);
      return row;
    } catch (error) {
      throw mapRoomWorkPostgresError(error, "room_default_agent_lock_failed");
    }
  }

  private async assertWorkspaceWritable(sql: WorkspaceSql, workspaceId: string): Promise<void> {
    const result = await sql.query<{ state: WorkspaceState }>("SELECT state FROM workspaces WHERE id = $1", [workspaceId]);
    const state = result.rows[0]?.state;
    if (!state) throw new WorkspaceServerError("workspace_not_found", 404);
    if (state !== "active") throw new WorkspaceServerError("workspace_read_only", 409);
  }

  private async selectWorkspaceMember(sql: WorkspaceSql, workspaceId: string, accountId: string): Promise<WorkspaceMembership | undefined> {
    const result = await sql.query<MembershipRow>(
      `SELECT workspace_id, account_id, role, state, version, created_at, updated_at, revoked_at
       FROM workspace_members WHERE workspace_id = $1 AND account_id = $2`,
      [workspaceId, accountId]
    );
    return result.rows[0] ? workspaceMembershipFromRow(result.rows[0]) : undefined;
  }

  private async selectRoomMember(sql: WorkspaceSql, workspaceId: string, roomId: string, accountId: string): Promise<WorkspaceRoomMembership | undefined> {
    const result = await sql.query<RoomMembershipRow>(
      `SELECT workspace_id, room_id, account_id, role, state, version, created_at, updated_at, revoked_at
       FROM room_members WHERE workspace_id = $1 AND room_id = $2 AND account_id = $3`,
      [workspaceId, roomId, accountId]
    );
    return result.rows[0] ? roomMembershipFromRow(result.rows[0]) : undefined;
  }

  /** Filter internal cascade ids through Room-management capability before any API response. */
  private async visibleRoomIds(
    context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">,
    roomIds: readonly string[]
  ): Promise<string[]> {
    if (roomIds.length === 0) return [];
    return this.database.withContext(context, async (sql) => {
      const result = await sql.query<{ id: string }>(
        `SELECT id FROM rooms
         WHERE workspace_id = $1 AND id = ANY($2::TEXT[])
           AND samurai_can_room(workspace_id, id, 'manage')
         ORDER BY id`,
        [context.workspaceId, [...new Set(roomIds)]]
      );
      return result.rows.map((row) => row.id);
    });
  }

  private async workspaceVersionConflict(sql: WorkspaceSql, workspaceId: string): Promise<never> {
    const result = await sql.query<{ version: number | string }>("SELECT version FROM workspaces WHERE id = $1", [workspaceId]);
    throw new WorkspaceServerError("workspace_version_conflict", 409, { latest_version: result.rows[0] ? Number(result.rows[0].version) : null });
  }

  private async workspaceMemberVersionConflict(sql: WorkspaceSql, workspaceId: string, accountId: string): Promise<never> {
    const member = await this.selectWorkspaceMember(sql, workspaceId, accountId);
    throw new WorkspaceServerError("workspace_membership_version_conflict", 409, { latest_version: member?.version ?? null });
  }

  private async roomMemberVersionConflict(sql: WorkspaceSql, workspaceId: string, roomId: string, accountId: string): Promise<never> {
    const member = await this.selectRoomMember(sql, workspaceId, roomId, accountId);
    throw new WorkspaceServerError("room_membership_version_conflict", 409, { latest_version: member?.version ?? null });
  }

  private async roomVersionConflict(sql: WorkspaceSql, workspaceId: string, roomId: string): Promise<never> {
    const row = (await sql.query<{ version: number | string }>(
      "SELECT version FROM rooms WHERE workspace_id = $1 AND id = $2",
      [workspaceId, roomId]
    )).rows[0];
    throw new WorkspaceServerError("room_version_conflict", 409, { latest_version: row ? Number(row.version) : null });
  }

  private async invitationVersionConflict(sql: WorkspaceSql, workspaceId: string, invitationId: string): Promise<never> {
    const result = await sql.query<{ version: number | string }>(
      "SELECT version FROM workspace_invitations WHERE workspace_id = $1 AND id = $2",
      [workspaceId, invitationId]
    );
    throw new WorkspaceServerError("workspace_invitation_version_conflict", 409, { latest_version: result.rows[0] ? Number(result.rows[0].version) : null });
  }

  private async throwRecordVersionConflict(sql: WorkspaceSql, workspaceId: string, recordType: string, id: string): Promise<never> {
    const latest = await sql.query<{ version: number }>(
      "SELECT version FROM workspace_records WHERE workspace_id = $1 AND record_type = $2 AND id = $3",
      [workspaceId, recordType, id]
    );
    throw new WorkspaceServerError("workspace_record_version_conflict", 409, {
      latest_version: latest.rows[0] ? Number(latest.rows[0].version) : null
    });
  }

  private async insertEvent(sql: WorkspaceSql, context: WorkspaceRequestContext, input: {
    roomId: string;
    kind: string;
    recordType?: string;
    recordId?: string;
    payload: WorkspaceRecordPayload;
  }): Promise<WorkspaceEvent> {
    const workspace = await sql.query<{ organization_id: string | null }>(
      "SELECT organization_id FROM workspaces WHERE id = $1", [context.workspaceId]
    );
    if (!workspace.rows[0]) throw new WorkspaceServerError("workspace_not_found", 404);
    // Event provenance follows the current association when one exists; a
    // standalone Workspace intentionally keeps this column NULL.
    const organizationId = workspace.rows[0].organization_id;
    const saved = await sql.query<EventRow>(
      `INSERT INTO workspace_events(workspace_id, organization_id, room_id, kind, record_type, record_id, operation_id, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::JSONB)
       RETURNING id, workspace_id, room_id, kind, record_type, record_id, operation_id, payload, created_at`,
      [context.workspaceId, organizationId, input.roomId, input.kind, input.recordType ?? null, input.recordId ?? null, context.operationId, canonicalJson(input.payload)]
    );
    const event = saved.rows[0];
    if (!event) throw new WorkspaceServerError("workspace_event_creation_failed", 500);
    return eventFromRow(event);
  }
}

interface AccountRow {
  id: string;
  public_key: string;
  display_name: string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface OrganizationRow {
  id: string;
  name: string;
  icon: string | null;
  description: string | null;
  created_by: string;
  version: number | string;
  created_at: Date | string;
  updated_at: Date | string;
  deleted_at: Date | string | null;
}

interface OrganizationMembershipRow {
  organization_id: string;
  account_id: string;
  role: OrganizationRole;
  state: "active" | "removed";
  version: number | string;
  joined_at: Date | string;
  removed_at: Date | string | null;
  created_by: string;
  updated_by: string;
}

interface OrganizationInvitationRow {
  id: string;
  organization_id: string;
  target_account_id: string | null;
  role: OrganizationRole;
  version: number | string;
  expires_at: Date | string;
  issued_by: string;
  created_at: Date | string;
  updated_at: Date | string;
  revoked_at: Date | string | null;
  accepted_by: string | null;
  accepted_at: Date | string | null;
}

interface OrganizationInvitationGrantRow {
  id: string;
  organization_id: string;
  invitation_id: string;
  workspace_id: string;
  workspace_role: WorkspaceMembershipRole;
  room_id: string | null;
  room_role: WorkspaceMembershipRole | null;
}

interface OrganizationWorkspaceRow {
  id: string;
  organization_id: string | null;
  name: string;
  state: WorkspaceState;
  version: number | string;
  created_at: Date | string;
  updated_at: Date | string;
  workspace_role?: WorkspaceMembershipRole | null;
}

interface OrganizationWorkspaceMoveMemberRow {
  account_id: string;
  current_workspace_role: WorkspaceMembershipRole;
  state: "active" | "revoked";
}

interface WorkspaceSummaryRow {
  id: string;
  organization_id: string | null;
  name: string;
  state: WorkspaceState;
  hosting_mode: WorkspaceServerMode;
  storage_namespace: string;
  database_placement: "shared" | "dedicated";
  version: number | string;
  role: WorkspaceMembershipRole;
  created_at: Date | string;
  updated_at: Date | string;
}

interface RoomRow {
  workspace_id: string;
  id: string;
  parent_room_id: string | null;
  room_kind?: WorkspaceRoomKind | null;
  default_agent_id?: string | null;
  default_agent_version?: number | string | null;
  dm_account_id?: string | null;
  name: string;
  version: number | string;
  can_manage?: boolean;
  can_execute?: boolean;
  created_at: Date | string;
  updated_at: Date | string;
}

interface HumanWorkRow {
  workspace_id: string;
  id: string;
  room_id: string;
  requester_account_id: string;
  default_agent_id: string;
  default_agent_version: number | string;
  title: string;
  objective: string;
  completion_criteria: unknown;
  resource_refs?: unknown;
  status: WorkspaceHumanWorkStatus;
  stop_state: WorkspaceHumanWorkStopState;
  instruction_version: number | string;
  control_generation: number | string;
  operation_id: string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface HumanWorkAssignmentRow {
  workspace_id: string;
  id: string;
  work_id: string;
  room_id: string;
  parent_assignment_id: string | null;
  dependency_assignment_ids: string[] | null;
  agent_id: string;
  agent_version: number | string;
  instruction_version: number | string;
  attempt: number | string;
  priority: number | string;
  status: WorkspaceHumanWorkAssignmentStatus;
  current_run_id: string | null;
  result: unknown;
  lease_owner: string | null;
  lease_expires_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
  started_at: Date | string | null;
  completed_at: Date | string | null;
}

interface HumanWorkInstructionRow {
  workspace_id: string;
  id: string;
  work_id: string;
  assignment_id: string | null;
  room_id: string;
  version: number | string;
  body: string;
  attachment_refs: unknown;
  resource_refs?: unknown;
  source_kind: WorkspaceHumanWorkInstructionSource;
  source_comment_id: string | null;
  source_comment_version: number | string | null;
  state: WorkspaceHumanWorkInstructionState;
  created_by: string;
  created_at: Date | string;
}

interface HumanWorkCommentRow {
  workspace_id: string;
  id: string;
  work_id: string;
  room_id: string;
  author_account_id: string;
  version: number | string;
  body: string;
  attachment_refs: unknown;
  created_at: Date | string;
}

interface HumanWorkReactionRow {
  workspace_id: string;
  id: string;
  work_id: string;
  room_id: string;
  comment_id: string;
  actor_account_id: string;
  reaction: "like";
  enabled: boolean;
  version: number | string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface HumanWorkControlRow {
  workspace_id: string;
  id: string;
  work_id: string;
  assignment_id: string | null;
  room_id: string;
  action: WorkspaceHumanWorkControlAction;
  state: WorkspaceHumanWorkControlState;
  actor_account_id: string;
  generation: number | string;
  operation_id: string;
  details: unknown;
  created_at: Date | string;
  updated_at: Date | string;
}

interface HumanWorkReservationRow {
  workspace_id: string;
  id: string;
  work_id: string;
  assignment_id: string;
  room_id: string;
  generation: number | string;
  status: WorkspaceHumanWorkLaunchReservationStatus;
  operation_id: string;
  scheduled_at: Date | string;
  lease_owner: string | null;
  lease_expires_at: Date | string | null;
  claimed_at: Date | string | null;
  released_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface LegacySessionMapRow {
  workspace_id: string;
  id: string;
  legacy_session_id: string;
  room_id: string;
  work_id: string;
  operation_id: string;
  created_by: string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface HumanWorkExecutionRow {
  workspace_id: string;
  reservation_id: string;
  work_id: string;
  assignment_id: string;
  room_id: string;
  generation: number | string;
  scheduled_at: Date | string;
  control_generation: number | string;
  instruction_version: number | string;
  agent_id: string;
  agent_configuration_version: number | string | null;
  current_run_id?: string | null;
  origin_kind: "normal" | "delegated" | "parent_continuation" | string | null;
  /** Server SQL filters reassigned parents; mocks may provide this guard directly. */
  parent_assignment_superseded?: boolean | null;
  parent_assignment_id: string | null;
  /** Parent's parent assignment, used to verify nested continuation bindings. */
  parent_assignment_parent_id?: string | null;
  parent_backend_id: string | null;
  parent_agent_id: string | null;
  parent_backend_session_id: string | null;
  parent_runtime_binding: unknown;
  session_id: string | null;
  instruction: string | null;
  resource_refs?: unknown;
  work_resource_refs?: unknown;
  attachments: unknown;
  attachments_have_unresolved: boolean;
}

interface StoredRoomWorkContinuation {
  sessionId: string;
  parentAssigneeId: string;
  continuation?: {
    backendSessionId: string;
    parent: {
      workspaceId: string;
      roomId: string;
      sessionId: string;
      workId: string;
      assigneeId: string;
      agentId: string;
      agentConfigurationVersion: number;
      backendId: string;
      generation: number;
    };
  };
}

interface AgentRow {
  workspace_id: string;
  id: string;
  display_name: string;
  description: string;
  role?: string;
  instructions?: string;
  enabled?: boolean;
  backend_id: string;
  status: WorkspaceAgent["status"];
  version: number | string;
  created_by: string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface AgentRoomPermissionRow {
  workspace_id: string;
  room_id: string;
  agent_id: string;
  can_view: boolean;
  can_edit: boolean;
  can_execute: boolean;
  version: number | string;
  created_by: string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface ConnectionDescriptorRow {
  workspace_id: string;
  id: string;
  agent_id: string | null;
  principal_account_id: string;
  connector_id: string;
  app_id: string;
  status: WorkspaceConnectionDescriptor["status"];
  expires_at: Date | string;
  revoked_at: Date | string | null;
  allowed_room_ids: string[];
  room_limit: number | string;
  ingress_classes: string[];
  version: number | string;
  created_by: string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface RecordRow {
  workspace_id: string;
  room_id: string;
  record_type: string;
  id: string;
  version: number | string;
  payload: WorkspaceRecordPayload | string;
  content_hash: string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface EventRow {
  id: number | string;
  workspace_id: string;
  room_id: string | null;
  kind: string;
  record_type: string | null;
  record_id: string | null;
  operation_id: string;
  payload: WorkspaceRecordPayload | string;
  created_at: Date | string;
}

interface PublicEventRow extends EventRow {
  room_id: string | null;
  event_id: string;
  event_version: string;
  actor_kind: "human" | "agent" | "system";
  actor_id: string | null;
  organization_id: string | null;
  cursor: string;
  correlation_id: string | null;
  resources: unknown;
}

interface JobRow {
  workspace_id: string;
  room_id: string;
  id: string;
  kind: string;
  status: WorkspaceJob["status"];
  version: number | string;
  idempotency_key: string;
  payload: WorkspaceRecordPayload | string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface InvitationRow {
  workspace_id: string;
  id: string;
  room_id: string | null;
  workspace_role: WorkspaceMembershipRole;
  room_role: WorkspaceMembershipRole | null;
  version: number | string;
  expires_at: Date | string;
  created_at: Date | string;
  revoked_at: Date | string | null;
  accepted_at: Date | string | null;
}

interface MembershipRow {
  workspace_id: string;
  account_id: string;
  role: WorkspaceMembershipRole;
  state: "active" | "revoked";
  version: number | string;
  created_at: Date | string;
  updated_at: Date | string;
  revoked_at: Date | string | null;
}

interface RoomMembershipRow extends MembershipRow {
  room_id: string;
}

interface AuditRow {
  id: number | string;
  workspace_id: string;
  room_id: string | null;
  actor_account_id: string;
  action: string;
  outcome: "completed" | "rejected" | "failed";
  operation_id: string | null;
  subject_kind: string | null;
  subject_id: string | null;
  before_version: number | string | null;
  after_version: number | string | null;
  details: WorkspaceRecordPayload | string;
  created_at: Date | string;
}

function accountFromRow(row: AccountRow): WorkspaceAccount {
  return { id: row.id, publicKey: row.public_key, displayName: row.display_name, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) };
}

function organizationIdFrom(context: OrganizationRequestContext, explicit: string | undefined): string {
  const id = explicit ?? context.organizationId;
  assertOpaqueId(id ?? "", "organization_id_invalid");
  return id!;
}

function optionalOrganizationId(value: string | null | undefined, code: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  assertOpaqueId(value, code);
  return value;
}

function assertOrganizationRole(value: string): asserts value is OrganizationRole {
  if (value !== "owner" && value !== "admin" && value !== "member" && value !== "guest") {
    throw new WorkspaceServerError("organization_role_invalid", 400);
  }
}

function assertOrganizationRoleValue(value: unknown): OrganizationRole {
  if (typeof value !== "string") throw new WorkspaceServerError("organization_role_invalid", 500);
  assertOrganizationRole(value);
  return value;
}

function organizationFromRow(row: OrganizationRow): Organization {
  return {
    id: row.id,
    name: row.name,
    ...(row.icon ? { icon: row.icon } : {}),
    ...(row.description ? { description: row.description } : {}),
    createdBy: row.created_by,
    version: Number(row.version),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    ...(row.deleted_at ? { deletedAt: iso(row.deleted_at) } : {})
  };
}

function organizationMembershipFromRow(row: OrganizationMembershipRow): OrganizationMembership {
  return {
    id: `${row.organization_id}:${row.account_id}`,
    organizationId: row.organization_id,
    accountId: row.account_id,
    role: row.role,
    state: row.state,
    version: Number(row.version),
    joinedAt: iso(row.joined_at),
    ...(row.removed_at ? { removedAt: iso(row.removed_at) } : {}),
    createdBy: row.created_by,
    updatedBy: row.updated_by
  };
}

function organizationWorkspaceMembershipFromRow(row: MembershipRow, organizationId: string): OrganizationWorkspaceMembership {
  const joinedAt = iso(row.created_at);
  return {
    id: `${row.workspace_id}:${row.account_id}`,
    organizationId,
    workspaceId: row.workspace_id,
    accountId: row.account_id,
    role: row.role,
    state: row.state,
    version: Number(row.version),
    joinedAt,
    createdAt: joinedAt,
    createdBy: row.account_id,
    updatedAt: iso(row.updated_at),
    ...(row.revoked_at ? { revokedAt: iso(row.revoked_at) } : {})
  };
}

function organizationInvitationFromRow(row: OrganizationInvitationRow, grants: OrganizationInvitationGrantRow[]): OrganizationInvitation {
  return {
    id: row.id,
    organizationId: row.organization_id,
    ...(row.target_account_id ? { targetAccountId: row.target_account_id } : {}),
    role: row.role,
    version: Number(row.version),
    expiresAt: iso(row.expires_at),
    issuedBy: row.issued_by,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    ...(row.revoked_at ? { revokedAt: iso(row.revoked_at) } : {}),
    ...(row.accepted_by ? { acceptedBy: row.accepted_by } : {}),
    ...(row.accepted_at ? { acceptedAt: iso(row.accepted_at) } : {}),
    workspaceGrants: grants.map((grant) => ({
      id: grant.id,
      organizationId: grant.organization_id,
      invitationId: grant.invitation_id,
      workspaceId: grant.workspace_id,
      workspaceRole: grant.workspace_role,
      ...(grant.room_id ? { roomId: grant.room_id } : {}),
      ...(grant.room_role ? { roomRole: grant.room_role } : {})
    }))
  };
}

function organizationInvitationGrantsFromJson(value: unknown): OrganizationInvitationWorkspaceGrant[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const row = item as Record<string, unknown>;
    if (typeof row.id !== "string" || typeof row.organization_id !== "string" || typeof row.invitation_id !== "string" || typeof row.workspace_id !== "string" || typeof row.workspace_role !== "string") return [];
    assertRole(row.workspace_role);
    const result: OrganizationInvitationWorkspaceGrant = {
      id: row.id,
      organizationId: row.organization_id,
      invitationId: row.invitation_id,
      workspaceId: row.workspace_id,
      workspaceRole: row.workspace_role
    };
    if (typeof row.room_id === "string" && row.room_id) result.roomId = row.room_id;
    if (typeof row.room_role === "string" && row.room_role) { assertRole(row.room_role); result.roomRole = row.room_role; }
    return [result];
  });
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new WorkspaceServerError("organization_result_invalid", 500);
  return parsed as Record<string, unknown>;
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function optionalResultString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function organizationWorkspaceFromRow(row: OrganizationWorkspaceRow): OrganizationWorkspaceSummary {
  return {
    ...(row.organization_id ? { organizationId: row.organization_id } : {}),
    workspaceId: row.id,
    name: row.name,
    state: row.state,
    hasAccess: Boolean(row.workspace_role),
    ...(row.workspace_role ? { workspaceRole: row.workspace_role } : {}),
    version: Number(row.version),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

function mapOrganizationPostgresError(error: unknown, _fallback: string): unknown {
  const message = postgresMessage(error);
  const known: Array<[string, string, number]> = [
    ["organization_not_found", "organization_not_found", 404],
    ["organization_member_not_found", "organization_member_not_found", 404],
    ["organization_admin_permission_required", "organization_admin_permission_required", 403],
    ["organization_owner_permission_required", "organization_owner_permission_required", 403],
    ["organization_expected_version_invalid", "organization_expected_version_invalid", 400],
    ["organization_version_conflict", "organization_version_conflict", 409],
    ["organization_last_owner_cannot_be_changed", "organization_last_owner_cannot_be_changed", 409],
    ["organization_membership_version_conflict", "organization_membership_version_conflict", 409],
    ["organization_invitation_not_found", "organization_invitation_not_found", 404],
    ["organization_invitation_version_conflict", "organization_invitation_version_conflict", 409],
    ["organization_invitation_not_available", "organization_invitation_not_available", 409],
    ["organization_invitation_invalid", "organization_invitation_invalid", 400],
    ["organization_invitation_target_mismatch", "organization_invitation_target_mismatch", 403],
    ["organization_invitation_workspace_grant_invalid", "organization_invitation_workspace_grant_invalid", 400],
    ["organization_workspaces_remaining", "organization_workspaces_remaining", 409],
    ["organization_membership_required", "organization_membership_required", 403],
    ["workspace_not_found", "workspace_not_found", 404],
    ["organization_workspace_membership_update_failed", "organization_workspace_membership_update_failed", 409],
    ["organization_workspace_member_not_found", "organization_workspace_member_not_found", 404],
    ["workspace_membership_version_conflict", "workspace_membership_version_conflict", 409],
    ["workspace_owner_permission_required", "workspace_owner_permission_required", 403],
    ["workspace_last_owner_cannot_be_changed", "workspace_last_owner_cannot_be_changed", 409],
    ["workspace_organization_move_source_mismatch", "workspace_organization_move_source_mismatch", 409],
    ["workspace_organization_move_state_invalid", "workspace_organization_move_state_invalid", 409],
    ["workspace_organization_move_invalid", "workspace_organization_move_invalid", 409],
    ["workspace_organization_move_preflight_invalid", "workspace_organization_move_preflight_invalid", 409],
    ["workspace_organization_move_preflight_mismatch", "workspace_organization_move_preflight_mismatch", 409],
    ["workspace_organization_move_preflight_expired", "workspace_organization_move_preflight_expired", 409],
    ["workspace_organization_move_preflight_not_allowed", "workspace_organization_move_preflight_not_allowed", 409],
    ["workspace_organization_move_preflight_version_conflict", "workspace_organization_move_preflight_version_conflict", 409],
    ["workspace_version_conflict", "workspace_version_conflict", 409]
  ];
  const hit = known.find(([needle]) => message.includes(needle));
  if (hit) return new WorkspaceServerError(hit[1], hit[2]);
  return error;
}

function organizationOperationErrorCode(error: unknown): string {
  const code = error instanceof WorkspaceServerError ? error.code : postgresMessage(error).split("\n", 1)[0] || "organization_operation_failed";
  return code.replace(/[^A-Za-z0-9._:-]/g, "_").slice(0, 160) || "organization_operation_failed";
}

/** Keep move status useful after a failed commit without persisting request
 * payloads such as invitation token hashes in the operation ledger. */
function organizationOperationFailureProjection(
  request: { action: string; input: unknown },
  operationId: string,
  failureCode: string
): Record<string, unknown> | undefined {
  if (![
    "workspace.organization.move.commit",
    "workspace.organization.attach",
    "workspace.organization.detach"
  ].includes(request.action)) return undefined;
  const input = request.input && typeof request.input === "object" && !Array.isArray(request.input)
    ? request.input as Record<string, unknown>
    : {};
  const value = (key: string): string | undefined => typeof input[key] === "string" ? input[key] as string : undefined;
  const sourceId = value("sourceId") ?? (request.action === "workspace.organization.detach" ? value("organizationId") : undefined);
  const targetId = value("targetId") ?? (request.action === "workspace.organization.attach" ? value("organizationId") : undefined);
  return {
    operationId,
    ...(value("workspaceId") ? { workspaceId: value("workspaceId") } : {}),
    ...(sourceId ? { sourceOrganizationId: sourceId } : {}),
    ...(targetId ? { targetOrganizationId: targetId } : {}),
    status: "failed",
    guestMembershipAccountIds: [],
    failureCode
  };
}

function stripEphemeralOrganizationSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripEphemeralOrganizationSecrets);
  if (!value || typeof value !== "object") return value;
  const object = value as Record<string, unknown>;
  return Object.fromEntries(Object.entries(object).filter(([key]) => !["token", "one_time_token", "raw_token", "token_hash"].includes(key)).map(([key, item]) => [key, stripEphemeralOrganizationSecrets(item)]));
}

function workspaceSummaryFromRow(row: WorkspaceSummaryRow): WorkspaceSummary {
  return {
    id: row.id,
    ...(row.organization_id ? { organizationId: row.organization_id } : {}),
    name: row.name,
    state: row.state,
    hostingMode: row.hosting_mode,
    storageNamespace: row.storage_namespace,
    databasePlacement: row.database_placement,
    version: Number(row.version),
    role: row.role,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

function roomFromRow(row: RoomRow): WorkspaceRoom {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    ...(row.parent_room_id ? { parentRoomId: row.parent_room_id } : {}),
    kind: row.room_kind ?? "normal",
    ...(row.default_agent_id ? { defaultAgentId: row.default_agent_id } : {}),
    ...(row.default_agent_version === undefined || row.default_agent_version === null ? {} : { defaultAgentVersion: Number(row.default_agent_version) }),
    ...(row.dm_account_id ? { dmAccountId: row.dm_account_id } : {}),
    name: row.name,
    version: Number(row.version),
    ...(row.can_manage === undefined ? {} : { canManage: row.can_manage === true }),
    ...(row.can_execute === undefined ? {} : { canExecute: row.can_execute === true }),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

function humanWorkAssignmentFromRow(row: HumanWorkAssignmentRow, generation: number): WorkspaceHumanWorkAssignment {
  return {
    workspaceId: row.workspace_id,
    id: row.id,
    workId: row.work_id,
    roomId: row.room_id,
    ...(row.parent_assignment_id ? { parentAssignmentId: row.parent_assignment_id } : {}),
    ...(row.dependency_assignment_ids && row.dependency_assignment_ids.length > 0 ? { dependencyAssignmentIds: [...row.dependency_assignment_ids] } : {}),
    agentId: row.agent_id,
    agentVersion: Number(row.agent_version),
    instructionVersion: Number(row.instruction_version),
    attempt: Number(row.attempt),
    priority: Number(row.priority),
    status: row.status,
    ...(row.current_run_id ? { currentRunId: row.current_run_id } : {}),
    ...(row.result === null || row.result === undefined ? {} : { result: jsonObjectOrEmpty(row.result) }),
    ...(row.lease_owner ? { leaseOwner: row.lease_owner } : {}),
    ...(row.lease_expires_at ? { leaseExpiresAt: iso(row.lease_expires_at) } : {}),
    ...(row.started_at ? { startedAt: iso(row.started_at) } : {}),
    ...(row.completed_at ? { completedAt: iso(row.completed_at) } : {}),
    generation,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

function humanWorkInstructionFromRow(row: HumanWorkInstructionRow): WorkspaceHumanWorkInstruction {
  return {
    workspaceId: row.workspace_id,
    id: row.id,
    workId: row.work_id,
    ...(row.assignment_id ? { assignmentId: row.assignment_id } : {}),
    roomId: row.room_id,
    version: Number(row.version),
    body: row.body,
    attachments: normalizeRoomWorkAttachmentRefsForRead(row.attachment_refs),
    resourceRefs: normalizeRoomWorkResourceRefsForRead(row.resource_refs),
    sourceKind: row.source_kind,
    ...(row.source_comment_id ? { sourceCommentId: row.source_comment_id } : {}),
    ...(row.source_comment_version === null || row.source_comment_version === undefined ? {} : { sourceCommentVersion: Number(row.source_comment_version) }),
    state: row.state,
    createdBy: row.created_by,
    createdAt: iso(row.created_at)
  } as WorkspaceHumanWorkInstruction;
}

function humanWorkCommentFromRow(row: HumanWorkCommentRow, reactionCount: number, appliedInstructionIds: string[]): WorkspaceHumanWorkComment {
  return {
    workspaceId: row.workspace_id,
    id: row.id,
    workId: row.work_id,
    roomId: row.room_id,
    authorAccountId: row.author_account_id,
    version: Number(row.version),
    body: row.body,
    attachments: normalizeRoomWorkAttachmentRefsForRead(row.attachment_refs),
    reactionCount,
    appliedInstructionIds,
    createdAt: iso(row.created_at)
  };
}

function humanWorkReactionFromRow(row: HumanWorkReactionRow): WorkspaceHumanWorkReaction {
  return {
    workspaceId: row.workspace_id,
    id: row.id,
    workId: row.work_id,
    roomId: row.room_id,
    commentId: row.comment_id,
    actorAccountId: row.actor_account_id,
    reaction: row.reaction,
    enabled: row.enabled,
    version: Number(row.version),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

function humanWorkControlFromRow(row: HumanWorkControlRow): WorkspaceHumanWorkControl {
  return {
    workspaceId: row.workspace_id,
    id: row.id,
    workId: row.work_id,
    ...(row.assignment_id ? { assignmentId: row.assignment_id } : {}),
    roomId: row.room_id,
    action: row.action,
    state: row.state,
    actorAccountId: row.actor_account_id,
    generation: Number(row.generation),
    operationId: row.operation_id,
    details: jsonObjectOrEmpty(row.details),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

function humanWorkReservationFromRow(row: HumanWorkReservationRow): WorkspaceHumanWorkLaunchReservation {
  return {
    workspaceId: row.workspace_id,
    id: row.id,
    workId: row.work_id,
    assignmentId: row.assignment_id,
    roomId: row.room_id,
    generation: Number(row.generation),
    status: row.status,
    operationId: row.operation_id,
    scheduledAt: iso(row.scheduled_at),
    ...(row.lease_owner ? { leaseOwner: row.lease_owner } : {}),
    ...(row.lease_expires_at ? { leaseExpiresAt: iso(row.lease_expires_at) } : {}),
    ...(row.claimed_at ? { claimedAt: iso(row.claimed_at) } : {}),
    ...(row.released_at ? { releasedAt: iso(row.released_at) } : {}),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

function legacySessionFromRow(row: LegacySessionMapRow): WorkspaceHumanWorkLegacySession {
  return {
    workspaceId: row.workspace_id,
    legacySessionId: row.legacy_session_id,
    roomId: row.room_id,
    workId: row.work_id,
    operationId: row.operation_id,
    createdBy: row.created_by,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

function agentFromRow(row: AgentRow): WorkspaceAgent {
  return {
    workspaceId: row.workspace_id,
    id: row.id,
    displayName: row.display_name,
    description: row.description,
    ...(row.role ? { role: row.role } : {}),
    ...(row.instructions ? { instructions: row.instructions } : {}),
    ...(row.enabled === undefined ? {} : { enabled: row.enabled }),
    backendId: row.backend_id,
    status: row.status,
    version: Number(row.version),
    createdBy: row.created_by,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

function agentRoomPermissionFromRow(row: AgentRoomPermissionRow): WorkspaceAgentRoomPermission {
  return {
    workspaceId: row.workspace_id,
    roomId: row.room_id,
    agentId: row.agent_id,
    canView: row.can_view,
    canEdit: row.can_edit,
    canExecute: row.can_execute,
    version: Number(row.version),
    createdBy: row.created_by,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

function connectionDescriptorFromRow(row: ConnectionDescriptorRow): WorkspaceConnectionDescriptor {
  return {
    workspaceId: row.workspace_id,
    id: row.id,
    ...(row.agent_id ? { agentId: row.agent_id } : {}),
    principalAccountId: row.principal_account_id,
    connectorId: row.connector_id,
    appId: row.app_id,
    status: row.status,
    expiresAt: iso(row.expires_at),
    ...(row.revoked_at ? { revokedAt: iso(row.revoked_at) } : {}),
    allowedRoomIds: [...row.allowed_room_ids],
    roomLimit: Number(row.room_limit),
    ingressClasses: [...row.ingress_classes],
    version: Number(row.version),
    createdBy: row.created_by,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

function recordFromRow(row: RecordRow): WorkspaceRecord {
  return {
    workspaceId: row.workspace_id,
    roomId: row.room_id,
    recordType: row.record_type,
    id: row.id,
    version: Number(row.version),
    payload: jsonObject(row.payload),
    contentHash: row.content_hash,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

function eventFromRow(row: EventRow): WorkspaceEvent {
  return {
    id: Number(row.id),
    workspaceId: row.workspace_id,
    roomId: row.room_id ?? "",
    kind: row.kind,
    ...(row.record_type ? { recordType: row.record_type } : {}),
    ...(row.record_id ? { recordId: row.record_id } : {}),
    operationId: row.operation_id,
    payload: jsonObject(row.payload),
    createdAt: iso(row.created_at)
  };
}

function publicEventFromRow(row: PublicEventRow): WorkspacePublicEvent {
  const resources = Array.isArray(row.resources)
    ? row.resources as ResourceRef[]
    : typeof row.resources === "string"
      ? JSON.parse(row.resources) as ResourceRef[]
      : [];
  return {
    eventId: row.event_id,
    eventType: row.kind,
    eventVersion: row.event_version,
    cursor: row.cursor,
    occurredAt: iso(row.created_at),
    actor: {
      kind: row.actor_kind,
      ...(row.actor_id ? { id: row.actor_id } : {})
    },
    scope: {
      workspaceId: row.workspace_id,
      ...(row.organization_id ? { organizationId: row.organization_id } : {}),
      ...(row.room_id ? { roomId: row.room_id } : {})
    },
    resources,
    ...(row.operation_id ? { operationId: row.operation_id } : {}),
    ...(row.correlation_id ? { correlationId: row.correlation_id } : {}),
    payload: jsonObject(row.payload)
  };
}

function jobFromRow(row: JobRow): WorkspaceJob {
  return {
    workspaceId: row.workspace_id,
    roomId: row.room_id,
    id: row.id,
    kind: row.kind,
    status: row.status,
    version: Number(row.version),
    idempotencyKey: row.idempotency_key,
    payload: jsonObject(row.payload),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

function invitationFromRow(row: InvitationRow): WorkspaceInvitation {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    ...(row.room_id ? { roomId: row.room_id } : {}),
    workspaceRole: row.workspace_role,
    ...(row.room_role ? { roomRole: row.room_role } : {}),
    version: Number(row.version),
    expiresAt: iso(row.expires_at),
    createdAt: iso(row.created_at),
    ...(row.revoked_at ? { revokedAt: iso(row.revoked_at) } : {}),
    ...(row.accepted_at ? { acceptedAt: iso(row.accepted_at) } : {})
  };
}

function workspaceMembershipFromRow(row: MembershipRow): WorkspaceMembership {
  return {
    workspaceId: row.workspace_id,
    accountId: row.account_id,
    role: row.role,
    state: row.state,
    version: Number(row.version),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    ...(row.revoked_at ? { revokedAt: iso(row.revoked_at) } : {})
  };
}

function roomMembershipFromRow(row: RoomMembershipRow): WorkspaceRoomMembership {
  return { ...workspaceMembershipFromRow(row), roomId: row.room_id };
}

function auditFromRow(row: AuditRow): WorkspaceAuditEntry {
  return {
    id: Number(row.id),
    workspaceId: row.workspace_id,
    ...(row.room_id ? { roomId: row.room_id } : {}),
    actorAccountId: row.actor_account_id,
    action: row.action,
    outcome: row.outcome,
    ...(row.operation_id ? { operationId: row.operation_id } : {}),
    ...(row.subject_kind ? { subjectKind: row.subject_kind } : {}),
    ...(row.subject_id ? { subjectId: row.subject_id } : {}),
    ...(row.before_version === null ? {} : { beforeVersion: Number(row.before_version) }),
    ...(row.after_version === null ? {} : { afterVersion: Number(row.after_version) }),
    details: jsonObject(row.details),
    createdAt: iso(row.created_at)
  };
}

function jsonObject(value: WorkspaceRecordPayload | string): WorkspaceRecordPayload {
  if (typeof value === "string") {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new WorkspaceServerError("workspace_json_payload_invalid", 500);
    return parsed as WorkspaceRecordPayload;
  }
  return value;
}

function jsonObjectOrEmpty(value: unknown): WorkspaceRecordPayload {
  if (typeof value === "string") {
    try {
      return jsonObject(value as WorkspaceRecordPayload | string);
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? value as WorkspaceRecordPayload : {};
}

/**
 * The claim query only exposes a parent Session after the SQL join has
 * matched the persisted runtime binding. Keep a second projection check here
 * so a driver/mock returning incomplete JSON cannot turn a provider Session ID
 * into an untrusted continuation candidate.
 */
function roomWorkParentContinuation(
  row: HumanWorkExecutionRow,
  childGeneration: number
): StoredRoomWorkContinuation | undefined {
  const binding = runtimeBindingObject(row.parent_runtime_binding);
  const sessionId = nonEmptyText(row.session_id);
  const parentAssigneeId = nonEmptyText(row.parent_assignment_id);
  if (row.parent_assignment_superseded === true) return undefined;
  const agentId = nonEmptyText(row.agent_id);
  const backendId = nonEmptyText(row.parent_backend_id);
  const parentAgentId = nonEmptyText(row.parent_agent_id);
  const reservationGeneration = integerValue(row.generation);
  // SQL only joins a parent Session for origin_kind=parent_continuation.
  // The column is NOT NULL on every supported schema version. Treat an
  // omitted/null projection as untrusted too; a legacy/mock row must not
  // smuggle a parent Session into a fresh assignment.
  if (row.origin_kind !== "parent_continuation") return undefined;
  const assignmentAgentVersion = row.agent_configuration_version === null || row.agent_configuration_version === undefined
    ? undefined
    : integerValue(row.agent_configuration_version);
  if (!binding || !sessionId || !parentAssigneeId || !agentId || !backendId || !parentAgentId
    || reservationGeneration === undefined || reservationGeneration !== childGeneration
    || assignmentAgentVersion === undefined) return undefined;

  const workspaceId = nonEmptyText(binding.workspace_id);
  const roomId = nonEmptyText(binding.room_id);
  const parentSessionId = nonEmptyText(binding.session_id);
  const workId = nonEmptyText(binding.work_id);
  const bindingAssigneeId = nonEmptyText(binding.assignee_id);
  const bindingAgentId = nonEmptyText(binding.agent_id);
  const bindingBackendId = nonEmptyText(binding.backend_id);
  const bindingGeneration = integerValue(binding.generation);
  const bindingAgentConfigurationVersion = integerValue(binding.agent_configuration_version);
  const rawBindingParentAssigneeId = binding.parent_assignee_id;
  const bindingParentAssigneeId = nonEmptyText(rawBindingParentAssigneeId);
  const rawBindingAgent = binding.agent;
  const bindingAgent = runtimeBindingObject(rawBindingAgent);
  const bindingAgentBackendId = nonEmptyText(bindingAgent?.backend_id);
  const nestedAgentConfigurationVersion = integerValue(bindingAgent?.config_version);
  const parentAssignmentParentId = nonEmptyText(row.parent_assignment_parent_id);
  if (!workspaceId || !roomId || !parentSessionId || !workId || !bindingAssigneeId || !bindingAgentId || !bindingBackendId
    || bindingGeneration === undefined || bindingAgentConfigurationVersion === undefined
    || workspaceId !== row.workspace_id
    || workId !== row.work_id
    || parentSessionId !== sessionId
    || bindingAssigneeId !== parentAssigneeId
    || bindingAgentId !== agentId
    || parentAgentId !== bindingAgentId
    || backendId !== bindingBackendId
    || bindingAgentBackendId !== undefined && bindingAgentBackendId !== bindingBackendId
    || nestedAgentConfigurationVersion !== undefined && nestedAgentConfigurationVersion !== bindingAgentConfigurationVersion
    || roomId !== row.room_id
    || bindingGeneration !== reservationGeneration
    || bindingGeneration !== childGeneration
    || bindingAgentConfigurationVersion !== assignmentAgentVersion
    || rawBindingAgent !== undefined && !bindingAgent
    || row.parent_assignment_parent_id !== undefined
      && (parentAssignmentParentId ?? undefined) !== (bindingParentAssigneeId ?? undefined)
    || row.parent_assignment_parent_id === undefined && rawBindingParentAssigneeId !== undefined) {
    return undefined;
  }

  const base = {
    workspaceId,
    roomId,
    sessionId,
    workId,
    assigneeId: parentAssigneeId,
    agentId: bindingAgentId,
    agentConfigurationVersion: bindingAgentConfigurationVersion,
    backendId: bindingBackendId,
    generation: bindingGeneration
  };
  const backendSessionId = nonEmptyText(row.parent_backend_session_id);
  return {
    sessionId,
    parentAssigneeId,
    ...(backendSessionId ? {
      continuation: {
        backendSessionId,
        parent: base
      }
    } : {})
  };
}

function runtimeBindingObject(value: unknown): Record<string, unknown> | undefined {
  const parsed = typeof value === "string"
    ? (() => {
        try { return JSON.parse(value) as unknown; } catch { return undefined; }
      })()
    : value;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
}

function nonEmptyText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function integerValue(value: unknown): number | undefined {
  const candidate = typeof value === "number"
    ? value
    : typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value) ? Number(value) : undefined;
  return candidate !== undefined && Number.isSafeInteger(candidate) && candidate >= 0 ? candidate : undefined;
}

function jsonArray(value: unknown): unknown[] {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return Array.isArray(value) ? value : [];
}

/**
 * Room Work attachments are server-owned file references, not arbitrary
 * ResourceRef metadata.  Keep this parser strict: dropping malformed entries
 * would make the persisted instruction differ from what the caller asked the
 * Server to execute.
 */
function normalizeRoomWorkAttachmentRefs(value: unknown): WorkspaceFileResourceRef[] {
  const candidate = value === undefined || value === null
    ? []
    : typeof value === "string"
      ? (() => {
          try { return JSON.parse(value) as unknown; } catch { return value; }
      })()
      : value;
  const parsed = WorkspaceFileResourceRefSchema.array().max(32).safeParse(candidate);
  if (!parsed.success) throw new WorkspaceServerError("room_work_attachment_reference_invalid", 400);
  return parsed.data;
}

/**
 * Historical instructions/comments may be projected by PostgreSQL with a
 * `legacy_unresolved` marker when their original file version no longer
 * exists.  The marker is evidence for read/export paths, not a public
 * WorkspaceFileResourceRef, so omit it from the typed DTO without throwing.
 */
function normalizeRoomWorkAttachmentRefsForRead(value: unknown): WorkspaceFileResourceRef[] {
  const candidate = value === undefined || value === null
    ? []
    : typeof value === "string"
      ? (() => {
          try { return JSON.parse(value) as unknown; } catch { return []; }
        })()
      : value;
  if (!Array.isArray(candidate)) return [];
  const visible = candidate.filter((entry) => !isLegacyUnresolvedAttachmentMarker(entry));
  const parsed = WorkspaceFileResourceRefSchema.array().max(32).safeParse(visible);
  return parsed.success ? parsed.data : [];
}

function isLegacyUnresolvedAttachmentMarker(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const marker = value as Record<string, unknown>;
  return marker.kind === "legacy_unresolved"
    && marker.reason === "reference_unavailable"
    && marker.ref !== null
    && typeof marker.ref === "object"
    && !Array.isArray(marker.ref);
}

function hasLegacyUnresolvedAttachmentMarker(value: unknown): boolean {
  const candidate = typeof value === "string"
    ? (() => {
        try { return JSON.parse(value) as unknown; } catch { return undefined; }
      })()
    : value;
  return Array.isArray(candidate) && candidate.some(isLegacyUnresolvedAttachmentMarker);
}

/**
 * Resolve every attachment against the same transaction-bound Workspace/Room.
 * The SQL-side trigger is the final invariant for all writers; this adapter
 * check gives callers a stable error and prevents Work/Comment creation from
 * reaching that trigger with a foreign, stale, or malformed reference.
 */
async function assertRoomWorkAttachmentRefs(
  sql: WorkspaceSql,
  context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">,
  roomId: string,
  refs: readonly ResourceRef[]
): Promise<void> {
  if (refs.length === 0) return;
  const parsed = WorkspaceFileResourceRefSchema.array().max(32).safeParse(refs);
  if (!parsed.success) throw new WorkspaceServerError("room_work_attachment_reference_invalid", 400);
  for (const ref of parsed.data) {
    try {
      assertSafeRelativePath(ref.uri);
    } catch {
      throw new WorkspaceServerError("room_work_attachment_uri_invalid", 400);
    }
  }
  const permission = await sql.query<{ allowed: boolean }>(
    "SELECT samurai_can_room($1, $2, 'read') AS allowed",
    [context.workspaceId, roomId]
  );
  if (permission.rows[0]?.allowed !== true) {
    throw new WorkspaceServerError("room_read_permission_denied", 403);
  }
  const paths = [...new Set(parsed.data.map((ref) => ref.uri))].sort();
  // Workspace File writes use the same advisory key. Holding these locks for
  // the enclosing Work/Comment transaction keeps the DB validation and the
  // guarded insert from accepting a reference immediately before its file is
  // replaced.
  for (const filePath of paths) {
    await sql.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`${context.workspaceId}\u001f${filePath}`]);
  }
  const result = await sql.query<{ path: string; version: number | string; sha256: string }>(
    `SELECT path, version, sha256
       FROM workspace_files
      WHERE workspace_id = $1 AND room_id = $2 AND path = ANY($3::TEXT[])`,
    [context.workspaceId, roomId, paths]
  );
  const files = new Map(result.rows.map((row) => [row.path, row]));
  for (const ref of parsed.data) {
    const file = files.get(ref.uri);
    if (!file) throw new WorkspaceServerError("room_work_attachment_not_found", 404);
    if (file.sha256 !== ref.id) {
      throw new WorkspaceServerError("room_work_attachment_hash_mismatch", 409);
    }
    if (String(file.version) !== ref.version) {
      throw new WorkspaceServerError("room_work_attachment_version_conflict", 409);
    }
  }
}

interface RoomWorkResourceRow {
  workspace_id: string;
  id: string;
  scope_kind: "workspace" | "room" | string;
  room_id: string | null;
  resource_kind: "knowledge" | "skill" | string;
  title: string;
  lifecycle_state: string;
  version: number | string;
  file_path: string;
  version_lifecycle_state: string;
}

/**
 * Parse Room Work refs fail-closed.  The generic ResourceRef parser is used
 * elsewhere for public events and intentionally accepts more kinds; Room
 * Work accepts only server-owned Knowledge/Skill refs and only the documented
 * five keys.
 */
function normalizeRoomWorkResourceRefs(value: unknown): RoomWorkResourceRefInput[] {
  const candidate = value === undefined || value === null
    ? []
    : typeof value === "string"
      ? (() => {
          try { return JSON.parse(value) as unknown; } catch { return value; }
        })()
      : value;
  const parsed = ResourceRefSchema.array().max(32).safeParse(candidate);
  if (!parsed.success) throw new WorkspaceServerError("room_work_resource_reference_invalid", 400);
  return parsed.data.map((entry) => {
    if ((entry.kind !== "knowledge" && entry.kind !== "skill")
      || !isRoomWorkResourceText(entry.id, 512)
      || !/^[a-z][a-z0-9_:-]{0,127}$/.test(entry.id)
      || !isRoomWorkResourceText(entry.uri, 4_096)
      || (entry.version !== undefined && !/^[1-9][0-9]*$/.test(entry.version))
      || (entry.label !== undefined && !isRoomWorkResourceText(entry.label, 4_096))) {
      throw new WorkspaceServerError("room_work_resource_reference_invalid", 400);
    }
    return {
      kind: entry.kind,
      id: entry.id,
      uri: entry.uri,
      ...(entry.version === undefined ? {} : { version: entry.version }),
      ...(entry.label === undefined ? {} : { label: entry.label })
    };
  });
}

function normalizeRoomWorkResourceRefsForRead(value: unknown): RoomWorkResourceRef[] {
  const refs = normalizeRoomWorkResourceRefs(value);
  return refs.map((ref) => {
    if (!ref.version) {
      throw new WorkspaceServerError("room_work_resource_reference_invalid", 500);
    }
    return ref as RoomWorkResourceRef;
  });
}

function isRoomWorkResourceText(value: unknown, maxLength: number): value is string {
  return typeof value === "string"
    && value.trim().length > 0
    && value.length <= maxLength
    && !value.includes("\u0000");
}

/**
 * Resolve refs against the current Workspace/Room and return canonical URI,
 * version, and label values from PostgreSQL.  The caller-provided URI/label
 * can therefore never become the runtime resource selector.
 */
async function resolveRoomWorkResourceRefs(
  sql: WorkspaceSql,
  context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">,
  roomId: string,
  refs: readonly RoomWorkResourceRefInput[]
): Promise<RoomWorkResourceRef[]> {
  const parsedRefs = normalizeRoomWorkResourceRefs(refs);
  if (parsedRefs.length === 0) return [];
  const permission = await sql.query<{ allowed: boolean }>(
    "SELECT samurai_can_room($1, $2, 'read') AS allowed",
    [context.workspaceId, roomId]
  );
  if (permission.rows[0]?.allowed !== true) {
    throw new WorkspaceServerError("room_read_permission_denied", 403);
  }
  const resolved: RoomWorkResourceRef[] = [];
  for (const ref of parsedRefs) {
    const row = (await sql.query<RoomWorkResourceRow>(
      `SELECT resource.workspace_id, resource.id, resource.scope_kind, resource.room_id,
              resource.resource_kind, resource.title, resource.lifecycle_state,
              resource_version.version, resource_version.file_path,
              resource_version.lifecycle_state AS version_lifecycle_state
       FROM workspace_completion_resources AS resource
       JOIN workspace_completion_resource_versions AS resource_version
         ON resource_version.workspace_id = resource.workspace_id
        AND resource_version.resource_id = resource.id
        AND resource_version.version = COALESCE($4::BIGINT, COALESCE(resource.current_confirmed_version, resource.current_provisional_version))
       WHERE resource.workspace_id = $1
         AND resource.id = $2
         AND resource.resource_kind = $3
         AND resource.lifecycle_state <> 'archived'
         AND resource_version.lifecycle_state <> 'archived'`,
      [context.workspaceId, ref.id, ref.kind, ref.version ?? null]
    )).rows[0];
    if (!row) throw new WorkspaceServerError("room_work_resource_reference_not_found", 404);
    if (row.scope_kind !== "workspace"
      && (row.scope_kind !== "room" || row.room_id !== roomId)) {
      throw new WorkspaceServerError("room_work_resource_reference_scope_invalid", 409);
    }
    const version = String(row.version);
    if ((ref.version !== undefined && ref.version !== version)
      || ref.uri !== row.file_path
      || (ref.label !== undefined && ref.label !== row.title)) {
      throw new WorkspaceServerError("room_work_resource_reference_invalid", 400);
    }
    if (row.resource_kind !== ref.kind || row.workspace_id !== context.workspaceId
      || !isRoomWorkResourceText(row.file_path, 4_096)
      || !isRoomWorkResourceText(row.title, 4_096)) {
      throw new WorkspaceServerError("room_work_resource_reference_invalid", 400);
    }
    resolved.push({ kind: ref.kind, id: row.id, uri: row.file_path, version, label: row.title });
  }
  return resolved;
}

function parseDateInput(value: string | undefined, code: string): Date | undefined {
  if (value === undefined) return undefined;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new WorkspaceServerError(code, 400);
  return parsed;
}

function roomMovePreviewFromPayload(value: WorkspaceRecordPayload | string | undefined): WorkspaceRoomMovePreview {
  const payload = requiredJsonObject(value, "room_move_preview_invalid");
  return {
    allowed: payload.allowed === true,
    ...(typeof payload.reason === "string" ? { reason: payload.reason } : {}),
    blockingAccountIds: jsonStringArray(payload.blocking_account_ids),
    requiredAncestorRoomIds: jsonStringArray(payload.required_ancestor_room_ids)
  };
}

function roomMoveResultPayload(value: WorkspaceRecordPayload | string | undefined): { affectedRoomIds: string[] } {
  const payload = requiredJsonObject(value, "room_move_result_invalid");
  return { affectedRoomIds: jsonStringArray(payload.affected_room_ids) };
}

function roomMemberChangePreviewFromPayload(value: WorkspaceRecordPayload | string | undefined): WorkspaceRoomMemberChangePreview {
  const payload = requiredJsonObject(value, "room_member_change_preview_invalid");
  return {
    allowed: payload.allowed === true,
    ...(typeof payload.reason === "string" ? { reason: payload.reason } : {}),
    affectedRoomIds: jsonStringArray(payload.affected_room_ids),
    blockingOwnerRoomIds: jsonStringArray(payload.blocking_owner_room_ids)
  };
}

function roomMemberChangeResultPayload(value: WorkspaceRecordPayload | string | undefined): { affectedRoomIds: string[] } {
  const payload = requiredJsonObject(value, "room_member_change_result_invalid");
  return { affectedRoomIds: jsonStringArray(payload.affected_room_ids) };
}

function requiredJsonObject(value: WorkspaceRecordPayload | string | undefined, code: string): WorkspaceRecordPayload {
  if (value === undefined) throw new WorkspaceServerError(code, 500);
  return jsonObject(value);
}

function jsonStringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new WorkspaceServerError("workspace_json_payload_invalid", 500);
  }
  return value;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function assertRecordType(value: string): void {
  if (!recordTypePattern.test(value)) throw new WorkspaceServerError("workspace_record_type_invalid", 400);
}

function assertRole(value: string): asserts value is WorkspaceMembershipRole {
  if (!roleSet.has(value as WorkspaceMembershipRole)) throw new WorkspaceServerError("workspace_role_invalid", 400);
}

function assertRoomAgentPermission(value: CreateWorkspaceRoomAgentPermissionInput): void {
  if (typeof value.canView !== "boolean" || typeof value.canEdit !== "boolean" || typeof value.canExecute !== "boolean") {
    throw new WorkspaceServerError("room_agent_permission_invalid", 400);
  }
  if ((value.canEdit || value.canExecute) && !value.canView) {
    throw new WorkspaceServerError("room_agent_view_required", 400);
  }
}

function sameRoomAgentPermission(
  left: CreateWorkspaceRoomAgentPermissionInput,
  right: CreateWorkspaceRoomAgentPermissionInput
): boolean {
  return left.canView === right.canView
    && left.canEdit === right.canEdit
    && left.canExecute === right.canExecute;
}

function assertExpectedVersion(value: number, code: string, minimum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum) throw new WorkspaceServerError(code, 400);
}

function normalizeAgentBackendId(value: string | undefined): string {
  const backendId = value?.trim() || "samurai-native";
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(backendId)) {
    throw new WorkspaceServerError("workspace_agent_backend_id_invalid", 400);
  }
  return backendId;
}

function postgresMessage(error: unknown): string {
  return error instanceof Error ? error.message : "";
}

function mapRoomWorkPostgresError(error: unknown, fallback: string): WorkspaceServerError | unknown {
  if (error instanceof WorkspaceServerError) return error;
  const message = postgresMessage(error);
  const known: Array<[string, string, number]> = [
    ["room_not_available", "room_not_available", 404],
    ["human_work_not_found", "human_work_not_found", 404],
    ["human_work_comment_not_found", "room_work_comment_not_found", 404],
    ["human_work_assignment_not_found", "human_work_assignment_not_found", 404],
    ["workspace_agent_not_active", "workspace_agent_not_active", 409],
    ["workspace_default_agent_not_available", "workspace_default_agent_not_available", 409],
    ["workspace_default_agent_version_conflict", "workspace_default_agent_version_conflict", 409],
    ["workspace_default_agent_permission_required", "workspace_default_agent_permission_required", 403],
    ["workspace_admin_permission_required", "workspace_admin_permission_required", 403],
    ["workspace_agent_input_invalid", "workspace_agent_input_invalid", 400],
    ["workspace_agent_room_permission_invalid", "room_agent_permission_invalid", 400],
    ["workspace_agent_room_permission_version_conflict", "room_agent_room_permission_version_conflict", 409],
    ["workspace_agent_not_found", "workspace_agent_not_found", 404],
    ["workspace_default_agent_remove_required", "workspace_default_agent_remove_required", 409],
    ["room_default_agent_lock_input_invalid", "room_default_agent_lock_input_invalid", 400],
    ["room_execute_permission_denied", "room_execute_permission_denied", 403],
    ["room_permission_denied", "room_permission_denied", 403],
    ["human_work_comment_permission_denied", "room_work_comment_permission_denied", 403],
    ["human_work_control_permission_denied", "room_work_control_permission_denied", 403],
    ["human_work_delegate_input_invalid", "room_work_delegate_input_invalid", 400],
    ["human_work_delegate_identity_missing", "room_work_delegate_identity_missing", 403],
    ["human_work_dm_delegation_forbidden", "room_work_dm_delegation_forbidden", 409],
    ["human_work_delegate_operation_conflict", "room_work_delegate_operation_conflict", 409],
    ["human_work_runtime_binding_invalid", "room_work_runtime_binding_invalid", 409],
    ["human_work_parent_continuation_conflict", "room_work_parent_continuation_conflict", 409],
    ["human_work_parent_assignment_not_available", "room_work_parent_assignment_not_available", 409],
    ["human_work_assignment_limit_exceeded", "room_work_assignment_limit_exceeded", 409],
    ["human_work_concurrency_limit_exceeded", "room_work_concurrency_limit_exceeded", 409],
    ["human_work_duration_limit_exceeded", "room_work_duration_limit_exceeded", 409],
    ["human_work_depth_limit_exceeded", "room_work_depth_limit_exceeded", 409],
    ["human_work_dependency_limit_exceeded", "room_work_dependency_limit_exceeded", 409],
    ["human_work_dependency_invalid", "room_work_dependency_invalid", 409],
    ["workspace_bundle_human_work_assignment_dependency_invalid", "workspace_bundle_human_work_assignment_dependency_invalid", 400],
    ["workspace_agent_room_execute_denied", "workspace_agent_room_execute_denied", 403],
    ["human_work_reaction_permission_denied", "room_work_reaction_permission_denied", 403],
    ["human_work_reassign_permission_denied", "room_work_reassign_permission_denied", 403],
    ["human_work_reassign_outcome_unknown", "room_work_reassign_outcome_unknown", 409],
    ["human_work_reassign_stop_required", "room_work_reassign_stop_required", 409],
    ["human_work_reassign_stop_pending", "room_work_reassign_stop_pending", 409],
    ["human_work_assignment_already_reassigned", "room_work_assignment_already_reassigned", 409],
    ["human_work_instruction_version_conflict", "room_work_instruction_version_conflict", 409],
    ["human_work_instruction_target_required", "room_work_instruction_target_required", 409],
    ["human_work_instruction_child_pending", "room_work_instruction_child_pending", 409],
    ["human_work_comment_version_conflict", "room_work_comment_version_conflict", 409],
    ["room_read_permission_denied", "room_read_permission_denied", 403],
    ["human_work_attachment_reference_invalid", "room_work_attachment_reference_invalid", 400],
    ["human_work_attachment_kind_invalid", "room_work_attachment_kind_invalid", 400],
    ["human_work_attachment_not_found", "room_work_attachment_not_found", 404],
    ["human_work_attachment_hash_mismatch", "room_work_attachment_hash_mismatch", 409],
    ["human_work_attachment_version_conflict", "room_work_attachment_version_conflict", 409],
    ["room_work_attachment_reference_unavailable", "room_work_attachment_reference_unavailable", 409],
    ["human_work_resource_reference_invalid", "room_work_resource_reference_invalid", 400],
    ["room_work_resource_reference_invalid", "room_work_resource_reference_invalid", 400],
    ["room_work_resource_reference_scope_invalid", "room_work_resource_reference_scope_invalid", 409],
    ["room_work_resource_reference_not_found", "room_work_resource_reference_not_found", 404],
    ["human_work_reassign_parent_continuation_forbidden", "room_work_reassign_parent_continuation_forbidden", 409],
    ["human_work_reaction_version_conflict", "room_work_reaction_version_conflict", 409],
    ["human_work_control_generation_conflict", "room_work_control_generation_conflict", 409],
    ["human_work_stop_not_confirmed", "room_work_stop_not_confirmed", 409],
    ["human_work_stopped", "room_work_stopped", 409],
    ["human_work_outcome_unknown", "room_work_outcome_unknown", 409],
    ["human_work_assignment_not_terminal", "room_work_assignment_not_terminal", 409],
    ["human_work_assignment_not_stoppable", "human_work_assignment_not_stoppable", 409],
    ["human_work_assignment_not_running", "human_work_assignment_not_running", 409],
    ["human_work_assignment_lease_conflict", "human_work_assignment_lease_conflict", 409],
    ["human_work_execution_admission_closed", "room_work_execution_admission_closed", 409],
    ["human_work_runtime_binding_invalid", "room_work_runtime_binding_invalid", 409],
    ["human_work_stop_claim_input_invalid", "room_work_stop_claim_input_invalid", 400],
    ["human_work_stop_settle_input_invalid", "room_work_stop_settle_input_invalid", 400],
    ["human_work_stop_control_not_found", "room_work_stop_control_not_found", 404],
    ["human_work_stop_not_dispatchable", "room_work_stop_not_dispatchable", 409],
    ["human_work_stop_lease_conflict", "room_work_stop_lease_conflict", 409],
    ["human_work_stop_generation_conflict", "room_work_stop_generation_conflict", 409],
    ["human_work_stop_assignment_scope_invalid", "room_work_stop_assignment_scope_invalid", 409],
    ["human_work_stop_run_evidence_missing", "room_work_stop_run_evidence_missing", 409],
    ["human_work_stop_run_mismatch", "room_work_stop_run_mismatch", 409],
    ["human_work_stop_run_status_mismatch", "room_work_stop_run_status_mismatch", 409],
    ["human_work_run_evidence_missing", "room_work_run_evidence_missing", 409],
    ["human_work_assignment_settle_input_invalid", "human_work_assignment_settle_input_invalid", 400],
    ["human_work_launch_not_available", "human_work_launch_not_available", 409],
    ["human_work_launch_generation_conflict", "human_work_launch_generation_conflict", 409],
    ["human_work_launch_not_found", "human_work_launch_not_found", 404],
    ["human_work_launch_input_invalid", "human_work_launch_input_invalid", 400],
    ["legacy_session_not_available", "legacy_session_not_available", 404],
    ["legacy_session_input_invalid", "legacy_session_input_invalid", 400],
    ["legacy_session_room_mismatch", "legacy_session_room_mismatch", 409],
    ["legacy_session_work_conflict", "legacy_session_work_conflict", 409],
    ["legacy_session_operation_conflict", "legacy_session_operation_conflict", 409],
    ["human_work_operation_conflict", "room_work_operation_conflict", 409],
    ["agent_dm_default_agent_immutable", "agent_dm_default_agent_immutable", 409],
    ["agent_dm_membership_required", "agent_dm_membership_required", 403],
    ["room_kind_invalid", "room_kind_invalid", 400],
    ["workspace_read_only", "workspace_read_only", 409]
  ];
  const hit = known.find(([needle]) => message.includes(needle));
  return hit ? new WorkspaceServerError(hit[1], hit[2]) : new WorkspaceServerError(fallback, 500);
}

function operationErrorCode(error: unknown): string {
  const code = error instanceof WorkspaceServerError ? error.code : postgresMessage(error).split("\n", 1)[0] || "workspace_operation_failed";
  return code.replace(/[^A-Za-z0-9._:-]/g, "_").slice(0, 160) || "workspace_operation_failed";
}

function boundedLimit(value: number | undefined): number {
  const limit = value ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new WorkspaceServerError("workspace_query_limit_invalid", 400);
  return limit;
}

function normalizeSearchText(value: string): string {
  return value.replaceAll("\0", "").slice(0, maxSearchTextLength);
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function invitationTokenHash(secret: string, token: string): string {
  return createHmac("sha256", secret).update("samurai-invitation-hash-v1|").update(token).digest("hex");
}

function invitationToken(secret: string, context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId" | "operationId">): string {
  return createHmac("sha256", secret)
    .update(`samurai-invitation-token-v1|${context.workspaceId}|${context.accountId}|${context.operationId}`)
    .digest("base64url");
}

function organizationInvitationToken(
  secret: string,
  context: Pick<OrganizationRequestContext, "accountId" | "operationId">,
  organizationId: string,
  invitationId?: string
): string {
  return createHmac("sha256", secret)
    .update(`samurai-organization-invitation-token-v1|${organizationId}|${context.accountId}|${context.operationId}|${invitationId ?? ""}`)
    .digest("base64url");
}

function operationScopedId(kind: string, scope: string, operationId: string): string {
  return `${kind}_${createHash("sha256").update(`${kind}|${scope}|${operationId}`).digest("hex").slice(0, 40)}`;
}
