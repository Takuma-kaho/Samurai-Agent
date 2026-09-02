import { createHash, createHmac } from "node:crypto";
import { assertOpaqueId } from "./config";
import { assertAccountIdMatchesPublicKey, canonicalJson } from "./auth";
import { WorkspaceServerError } from "./errors";
import { PostgresWorkspaceDatabase, type WorkspaceSql } from "./postgres";
import type {
  WorkspaceAccount,
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
  WorkspaceRecord,
  WorkspaceRecordPayload,
  WorkspacePublicEvent,
  WorkspacePublicEventPage,
  WorkspaceRequestContext,
  WorkspaceRoom,
  WorkspaceRoomCreateResult,
  WorkspaceRoomMemberChangePreview,
  WorkspaceRoomMemberChangeResult,
  WorkspaceRoomMembership,
  WorkspaceRoomMovePreview,
  WorkspaceRoomMoveResult,
  WorkspaceServerMode,
  WorkspaceState,
  WorkspaceSummary
} from "./types";
import type { ResourceRef } from "@samurai-agent/core-schemas";

const roleSet = new Set<WorkspaceMembershipRole>(["owner", "admin", "member", "guest"]);
const recordTypePattern = /^[a-z][a-z0-9_]{0,63}$/;
const maxSearchTextLength = 500_000;

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
  /** Organization that owns the new Workspace. Omit to use the caller's default Organization. */
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
  sourceOrganizationId: string;
  targetOrganizationId: string;
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
};

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
      // Keep the compatibility Organization only for Accounts that have no
      // active Organization membership.  An invited member must not acquire a
      // second implicit Organization merely by registering its Account.
      const membership = await sql.query<{ has_membership: boolean }>(
        `SELECT EXISTS(
           SELECT 1 FROM organization_members
           WHERE account_id = $1 AND state = 'active'
         ) AS has_membership`, [input.id]
      );
      if (membership.rows[0]?.has_membership !== true) {
        await sql.query(
          `SELECT samurai_create_organization(
            'org_' || md5('samurai.legacy.organization|' || $1),
            COALESCE(NULLIF(btrim($2), ''), 'Account') || ' Organization',
            NULL, NULL,
            'organization_bootstrap_' || md5($1)
          )`, [input.id, input.displayName.trim()]
        );
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
        "SELECT version FROM organizations WHERE id = $1 AND deleted_at IS NULL FOR UPDATE", [id]
      )).rows[0];
      if (!current) throw new WorkspaceServerError("organization_not_found", 404);
      if (suppliedExpectedVersion !== undefined && Number(current.version) !== suppliedExpectedVersion) {
        throw new WorkspaceServerError("organization_version_conflict", 409);
      }
      try {
        await sql.query("SELECT samurai_delete_organization($1, $2)", [id, context.operationId]);
      } catch (error) {
        throw mapOrganizationPostgresError(error, "organization_delete_failed");
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
    const sourceId = organizationIdFrom(context, input.sourceOrganizationId ?? input.source_organization_id);
    const targetId = organizationIdFrom(context, input.targetOrganizationId ?? input.target_organization_id);
    const workspaceId = input.workspaceId ?? input.workspace_id;
    assertOpaqueId(workspaceId ?? "", "workspace_id_invalid");
    const expectedVersion = input.expectedWorkspaceVersion ?? input.expected_workspace_version;
    const result = await this.runOrganizationIdempotentResult(context, sourceId, {
      action: "workspace.organization.move.preflight",
      input: { sourceId, targetId, workspaceId, expectedVersion: expectedVersion ?? null }
    }, async (sql) => {
      const capability = await sql.query<{ source_owner: boolean; target_owner: boolean }>(
        "SELECT samurai_can_organization($1, 'owner') AS source_owner, samurai_can_organization($2, 'owner') AS target_owner", [sourceId, targetId]
      );
      const sourceOwner = capability.rows[0]?.source_owner === true;
      const targetOwner = capability.rows[0]?.target_owner === true;
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
      const targetMembers = await sql.query<{ account_id: string; role: OrganizationRole }>(
        "SELECT account_id, role FROM organization_members WHERE organization_id = $1 AND state = 'active' ORDER BY account_id", [targetId]
      );
      const targetRoles = new Map(targetMembers.rows.map((row) => [row.account_id, row.role]));
      const members = memberRows.rows.map((row) => ({
        accountId: row.account_id,
        currentWorkspaceRole: row.current_workspace_role,
        state: row.state,
        ...(targetRoles.has(row.account_id) ? { targetOrganizationRole: targetRoles.get(row.account_id) } : {})
      }));
      const missing = members.filter((member) => !targetRoles.has(member.accountId)).map((member) => member.accountId);
      const versionOk = expectedVersion === undefined || workspaceVersion === expectedVersion;
      const stateOk = workspaceState === "active" || workspaceState === "archived";
      const failureConditions: string[] = [];
      if (!sourceOwner) failureConditions.push("organization_owner_permission_required");
      if (!targetOwner) failureConditions.push("target_organization_owner_permission_required");
      if (workspace.organization_id !== sourceId) failureConditions.push("workspace_organization_move_source_mismatch");
      if (sourceId === targetId) failureConditions.push("workspace_organization_move_invalid");
      if (!versionOk) failureConditions.push("workspace_version_conflict");
      if (!stateOk) failureConditions.push("workspace_organization_move_state_invalid");
      const allowed = failureConditions.length === 0;
      const reason = failureConditions[0];
      const createdAt = new Date().toISOString();
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
      return {
        allowed,
        ...(reason ? { reason } : {}),
        sourceOrganizationId: sourceId,
        targetOrganizationId: targetId,
        workspaceId,
        workspaceName: workspace.name,
        expectedWorkspaceVersion: workspaceVersion,
        sourceOwner,
        targetOwner,
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
    const sourceId = organizationIdFrom(context, input.sourceOrganizationId ?? input.source_organization_id);
    const targetId = organizationIdFrom(context, input.targetOrganizationId ?? input.target_organization_id);
    const workspaceId = input.workspaceId ?? input.workspace_id;
    assertOpaqueId(workspaceId ?? "", "workspace_id_invalid");
    const suppliedExpectedVersion = input.expectedWorkspaceVersion ?? input.expected_workspace_version;
    if (suppliedExpectedVersion !== undefined) assertExpectedVersion(suppliedExpectedVersion, "workspace_expected_version_invalid", 1);
    const preflightId = assertOpaqueId(input.preflight_id ?? "", "workspace_organization_move_preflight_id_invalid");
    const confirm = input.confirmGuestMemberships ?? input.confirm_guest_membership;
    if (confirm !== true) throw new WorkspaceServerError("workspace_organization_move_guest_confirmation_required", 400);
    const result = await this.runOrganizationIdempotentResult(context, sourceId, { action: "workspace.organization.move.commit", input: { sourceId, targetId, workspaceId, expectedVersion: suppliedExpectedVersion ?? null, preflightId } }, async (sql) => {
      const preflightRow = (await sql.query<{ result: unknown; consumed_at: Date | string | null }>(
        `SELECT result, consumed_at
           FROM organization_operations
          WHERE actor_account_id = $1 AND idempotency_key = $2
            AND organization_id = $3 AND status = 'completed'
            AND consumed_at IS NULL AND result IS NOT NULL
          FOR UPDATE`, [context.accountId, preflightId, sourceId]
      )).rows[0];
      if (!preflightRow) throw new WorkspaceServerError("workspace_organization_move_preflight_invalid", 409);
      const preflight = parseJsonObject(preflightRow.result);
      if (preflight.allowed !== true) throw new WorkspaceServerError("workspace_organization_move_preflight_not_allowed", 409);
      const previewSource = String(preflight.sourceOrganizationId ?? preflight.source_organization_id ?? "");
      const previewTarget = String(preflight.targetOrganizationId ?? preflight.target_organization_id ?? "");
      const previewWorkspace = String(preflight.workspaceId ?? preflight.workspace_id ?? "");
      const previewVersion = Number(preflight.expectedWorkspaceVersion ?? preflight.workspace_version);
      const previewExpiresAt = Date.parse(String(preflight.expiresAt ?? preflight.expires_at ?? ""));
      if (previewSource !== sourceId || previewTarget !== targetId || previewWorkspace !== workspaceId || !Number.isInteger(previewVersion) || previewVersion < 1) {
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
        const row = (await sql.query<{ result: unknown }>("SELECT samurai_move_workspace_organization($1, $2, $3, $4, $5) AS result", [sourceId, targetId, workspaceId, expectedVersion, context.operationId])).rows[0];
        if (!row) throw new WorkspaceServerError("workspace_organization_move_failed", 500);
        const value = parseJsonObject(row.result);
        const added = Array.isArray(value.added_guest_account_ids) ? value.added_guest_account_ids.filter((item): item is string => typeof item === "string") : [];
        const workspace = (await sql.query<OrganizationWorkspaceRow>("SELECT id, organization_id, name, state, version, created_at, updated_at FROM workspaces WHERE id = $1", [workspaceId])).rows[0];
        if (!workspace) throw new WorkspaceServerError("workspace_not_found", 404);
        await sql.query(
          `UPDATE organization_operations SET consumed_at = NOW(), updated_at = NOW()
             WHERE actor_account_id = $1 AND idempotency_key = $2 AND organization_id = $3 AND consumed_at IS NULL`,
          [context.accountId, preflightId, sourceId]
        );
        return {
          operationId: context.operationId,
          sourceOrganizationId: sourceId,
          targetOrganizationId: targetId,
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
      return {
        operationId,
        workspaceId: String(result.workspaceId ?? result.workspace_id ?? workspace.workspaceId ?? workspace.id ?? "unknown"),
        sourceOrganizationId: String(result.sourceOrganizationId ?? result.source_organization_id ?? row.organization_id ?? "unknown"),
        targetOrganizationId: String(result.targetOrganizationId ?? result.target_organization_id ?? workspace.organizationId ?? workspace.organization_id ?? "unknown"),
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
      id: operationScopedId("workspace", organizationId, context.operationId),
      name: input.name,
      ownerAccountId: context.accountId,
      operationId: context.operationId,
      hostingMode: this.mode,
      databasePlacement: this.mode === "self_host" ? "dedicated" : "shared",
      organizationId
    });
    return { ...organizationWorkspaceFromSummary(created.workspace, organizationId), replayed: created.replayed };
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

  /** Bundle bytes remain in the Bundle service; this metadata operation keeps
   * Organization authorization and source ownership explicit for callers. */
  async exportWorkspaceBundle(context: OrganizationRequestContext, input: { organizationId?: string; organization_id?: string; workspaceId?: string; workspace_id?: string; expectedWorkspaceVersion?: number; expected_workspace_version?: number }): Promise<Record<string, unknown>> {
    const organizationId = organizationIdFrom(context, input.organizationId ?? input.organization_id);
    const workspaceId = assertOpaqueId(input.workspaceId ?? input.workspace_id ?? "", "workspace_id_invalid");
    const workspace = await this.database.withContext({ accountId: context.accountId }, async (sql) => {
      const row = (await sql.query<OrganizationWorkspaceRow>("SELECT id, organization_id, name, state, version, created_at, updated_at FROM workspaces WHERE id = $1 AND organization_id = $2", [workspaceId, organizationId])).rows[0];
      if (!row) throw new WorkspaceServerError("workspace_not_found", 404);
      const expectedVersion = input.expectedWorkspaceVersion ?? input.expected_workspace_version;
      if (expectedVersion !== undefined && Number(row.version) !== expectedVersion) throw new WorkspaceServerError("workspace_version_conflict", 409);
      const owner = await sql.query<{ allowed: boolean }>("SELECT samurai_can_workspace($1, 'owner') AS allowed", [workspaceId]);
      if (owner.rows[0]?.allowed !== true) throw new WorkspaceServerError("workspace_owner_permission_required", 403);
      return row;
    });
    return { bundleId: `bundle_${context.operationId}`, workspaceId, sourceOrganizationId: organizationId, workspaceVersion: Number(workspace.version), state: workspace.state, createdAt: iso(workspace.created_at) };
  }

  /** Restore is executed by the Bundle service; this method validates the
   * selected target Organization before that service performs file/database work. */
  async restoreWorkspaceBundle(context: OrganizationRequestContext, input: { bundleId?: string; bundle_id?: string; targetOrganizationId?: string; target_organization_id?: string; confirm?: true }): Promise<Record<string, unknown>> {
    const targetOrganizationId = organizationIdFrom(context, input.targetOrganizationId ?? input.target_organization_id);
    const bundleId = assertOpaqueId(input.bundleId ?? input.bundle_id ?? "", "workspace_bundle_id_invalid");
    await this.database.withContext({ accountId: context.accountId }, async (sql) => {
      const allowed = await sql.query<{ allowed: boolean }>("SELECT samurai_can_organization($1, 'admin') AS allowed", [targetOrganizationId]);
      if (allowed.rows[0]?.allowed !== true) throw new WorkspaceServerError("organization_admin_permission_required", 403);
    });
    return { bundleId, targetOrganizationId, status: "authorized" };
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
      input: { id: workspaceId, name: input.name.trim(), mode, databasePlacement: input.databasePlacement, organizationId: input.organizationId ?? null }
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
        `SELECT workspace_id, id, parent_room_id, name, version, created_at, updated_at,
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
        "SELECT workspace_id, id, parent_room_id, name, version, created_at, updated_at FROM rooms WHERE workspace_id = $1 AND id = $2",
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
        `SELECT workspace_id, id, parent_room_id, name, version, created_at, updated_at,
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
        `SELECT workspace_id, room_id, agent_id, can_view, can_edit, can_execute, version, created_by, created_at, updated_at
         FROM workspace_agent_room_permissions WHERE workspace_id = $1 AND room_id = $2 ORDER BY agent_id`,
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

  async createRoom(context: WorkspaceRequestContext, input: { id?: string; name: string; parentRoomId?: string; expectedWorkspaceVersion: number }): Promise<WorkspaceRoomCreateResult> {
    if (!input.name.trim()) throw new WorkspaceServerError("room_name_required", 400);
    if (input.parentRoomId) assertOpaqueId(input.parentRoomId, "room_parent_id_invalid");
    assertExpectedVersion(input.expectedWorkspaceVersion, "workspace_expected_version_invalid", 1);
    const id = input.id ?? operationScopedId("room", context.workspaceId, context.operationId);
    assertOpaqueId(id, "room_id_invalid");
    const result = await this.runIdempotentResult(context, { action: "room.create", input: { id, name: input.name, parentRoomId: input.parentRoomId ?? null, expectedWorkspaceVersion: input.expectedWorkspaceVersion } }, async (sql) => {
      await this.assertWorkspaceWritable(sql, context.workspaceId);
      try {
        await sql.query("SELECT samurai_create_room($1, $2, $3, $4, $5, $6)", [context.workspaceId, id, input.name.trim(), input.parentRoomId ?? null, input.expectedWorkspaceVersion, context.operationId]);
      } catch (error) {
        if (postgresMessage(error).includes("workspace_version_conflict")) {
          throw await this.workspaceVersionConflict(sql, context.workspaceId);
        }
        throw error;
      }
      const result = await sql.query<RoomRow>(
        "SELECT workspace_id, id, parent_room_id, name, version, created_at, updated_at FROM rooms WHERE workspace_id = $1 AND id = $2",
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
        details: { workspace_version: input.expectedWorkspaceVersion, parent_room_id: input.parentRoomId ?? null }
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
        "SELECT workspace_id, id, parent_room_id, name, version, created_at, updated_at FROM rooms WHERE workspace_id = $1 AND id = $2",
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
        "SELECT workspace_id, id, parent_room_id, name, version, created_at, updated_at FROM rooms WHERE workspace_id = $1 AND id = $2",
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
      try {
        const changed = await sql.query<{ result: WorkspaceRecordPayload | string }>(
          "SELECT samurai_set_room_member_with_impact($1, $2, $3, $4, $5, $6, $7) AS result",
          [context.workspaceId, input.roomId, input.accountId, input.role, input.state, input.expectedVersion, context.operationId]
        );
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
      } catch (error) {
        if (postgresMessage(error).includes("room_membership_version_conflict")) {
          throw await this.roomMemberVersionConflict(sql, context.workspaceId, input.roomId, input.accountId);
        }
        throw error;
      }
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
      const workspaceScope = await sql.query<{ organization_id: string }>(
        "SELECT organization_id FROM workspaces WHERE id = $1", [context.workspaceId]
      );
      const organizationId = workspaceScope.rows[0]?.organization_id;
      if (!organizationId) throw new WorkspaceServerError("workspace_not_found", 404);
      if (input.organizationId && input.organizationId !== organizationId) {
        throw new WorkspaceServerError("workspace_event_organization_mismatch", 409);
      }
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
          "SELECT request_hash, status, result FROM workspace_operations WHERE workspace_id = $1 AND idempotency_key = $2",
          [context.workspaceId, context.operationId]
        );
        const operation = existing.rows[0];
        if (!operation || operation.request_hash !== requestHash) throw new WorkspaceServerError("workspace_operation_id_reused", 409);
        if (operation.status === "failed") throw new WorkspaceServerError("workspace_operation_previously_failed", 409);
        if (operation.status !== "completed" || operation.result === null) throw new WorkspaceServerError("workspace_operation_in_progress", 409);
        return { value: operation.result as T, replayed: true };
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

  private async getOrganizationMember(context: OrganizationRequestContext, organizationId: string, accountId: string): Promise<OrganizationMembership> {
    assertOpaqueId(accountId, "account_id_invalid");
    return this.database.withContext({ accountId: context.accountId }, async (sql) => {
      const row = (await sql.query<OrganizationMembershipRow>(
        `SELECT organization_id, account_id, role, state, version, joined_at, removed_at, created_by, updated_by
           FROM organization_members WHERE organization_id = $1 AND account_id = $2`, [organizationId, accountId]
      )).rows[0];
      if (!row) throw new WorkspaceServerError("organization_member_not_found", 404);
      return organizationMembershipFromRow(row);
    });
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
    const workspace = await sql.query<{ organization_id: string }>(
      "SELECT organization_id FROM workspaces WHERE id = $1", [context.workspaceId]
    );
    const organizationId = workspace.rows[0]?.organization_id;
    if (!organizationId) throw new WorkspaceServerError("workspace_not_found", 404);
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
  organization_id: string;
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
  organization_id?: string;
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
  name: string;
  version: number | string;
  can_manage?: boolean;
  can_execute?: boolean;
  created_at: Date | string;
  updated_at: Date | string;
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

function organizationWorkspaceFromRow(row: OrganizationWorkspaceRow): OrganizationWorkspaceSummary {
  return {
    organizationId: row.organization_id,
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

function organizationWorkspaceFromSummary(row: WorkspaceSummary, organizationId: string): OrganizationWorkspaceSummary {
  return {
    organizationId,
    workspaceId: row.id,
    name: row.name,
    state: row.state,
    hasAccess: true,
    workspaceRole: row.role,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function mapOrganizationPostgresError(error: unknown, _fallback: string): unknown {
  const message = postgresMessage(error);
  const known: Array<[string, string, number]> = [
    ["organization_not_found", "organization_not_found", 404],
    ["organization_member_not_found", "organization_member_not_found", 404],
    ["organization_admin_permission_required", "organization_admin_permission_required", 403],
    ["organization_owner_permission_required", "organization_owner_permission_required", 403],
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
  if (request.action !== "workspace.organization.move.commit") return undefined;
  const input = request.input && typeof request.input === "object" && !Array.isArray(request.input)
    ? request.input as Record<string, unknown>
    : {};
  const value = (key: string): string | undefined => typeof input[key] === "string" ? input[key] as string : undefined;
  return {
    operationId,
    workspaceId: value("workspaceId") ?? "unknown",
    sourceOrganizationId: value("sourceId") ?? "unknown",
    targetOrganizationId: value("targetId") ?? "unknown",
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
    name: row.name,
    version: Number(row.version),
    ...(row.can_manage === undefined ? {} : { canManage: row.can_manage === true }),
    ...(row.can_execute === undefined ? {} : { canExecute: row.can_execute === true }),
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
