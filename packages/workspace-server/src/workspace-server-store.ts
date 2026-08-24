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
  WorkspaceRecord,
  WorkspaceRecordPayload,
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

/** The durable value of an idempotent operation plus whether this call is a replay. */
export interface IdempotentOperationResult<T> {
  value: T;
  replayed: boolean;
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
    if (options.mode === "self_host" && (!options.selfHostWorkspaceId || !options.selfHostInitialAdminId)) {
      throw new WorkspaceServerError("self_host_initial_admin_required", 500);
    }
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
      if (account.display_name !== input.displayName.trim()) {
        const updated = await sql.query<AccountRow>(
          `UPDATE accounts SET display_name = $2, updated_at = NOW()
           WHERE id = $1
           RETURNING id, public_key, display_name, created_at, updated_at`,
          [input.id, input.displayName.trim()]
        );
        return accountFromRow(updated.rows[0] ?? account);
      }
      return accountFromRow(account);
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

  async createWorkspace(input: CreateWorkspaceInput): Promise<{ workspace: WorkspaceSummary; defaultRoom: WorkspaceRoom }> {
    const workspaceId = input.id ?? operationScopedId("workspace", input.ownerAccountId, input.operationId);
    assertOpaqueId(workspaceId, "workspace_id_invalid");
    assertOpaqueId(input.ownerAccountId, "account_id_invalid");
    assertOpaqueId(input.operationId, "workspace_operation_id_invalid");
    if (!input.name.trim()) throw new WorkspaceServerError("workspace_name_required", 400);
    const mode = input.hostingMode ?? this.mode;
    if (this.mode === "self_host" && workspaceId !== this.selfHostWorkspaceId) {
      throw new WorkspaceServerError("workspace_not_found", 404);
    }
    const roomId = operationScopedId("room", workspaceId, input.operationId);
    return this.runAccountIdempotent(input.ownerAccountId, input.operationId, workspaceId, {
      action: "workspace.create",
      input: { id: workspaceId, name: input.name.trim(), mode, databasePlacement: input.databasePlacement }
    }, async (sql) => {
      try {
        await sql.query("SELECT samurai_create_workspace($1, $2, $3, $4, $5, $6)", [
          workspaceId,
          input.name.trim(),
          mode,
          input.databasePlacement ?? (mode === "self_host" ? "dedicated" : "shared"),
          roomId,
          "General"
        ]);
      } catch (error) {
        if (postgresMessage(error).includes("workspace_id_conflict")) throw new WorkspaceServerError("workspace_id_conflict", 409);
        throw error;
      }
      const workspace = (await sql.query<WorkspaceSummaryRow>(
        `SELECT id, name, state, hosting_mode, storage_namespace, database_placement, version, created_at, updated_at
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
  }

  async listWorkspaces(accountId: string): Promise<WorkspaceSummary[]> {
    assertOpaqueId(accountId, "account_id_invalid");
    return this.database.withContext({ accountId }, async (sql) => {
      const result = await sql.query<WorkspaceSummaryRow>(
        `SELECT w.id, w.name, w.state, w.hosting_mode, w.storage_namespace, w.database_placement, w.version, w.created_at, w.updated_at, m.role
         FROM workspaces AS w
         JOIN workspace_members AS m ON m.workspace_id = w.id
         WHERE m.account_id = $1 AND m.state = 'active'
         ORDER BY w.updated_at DESC`,
        [accountId]
      );
      return result.rows.map(workspaceSummaryFromRow);
    });
  }

  async getWorkspace(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">): Promise<WorkspaceSummary> {
    return this.database.withContext(context, async (sql) => {
      const result = await sql.query<WorkspaceSummaryRow>(
        `SELECT w.id, w.name, w.state, w.hosting_mode, w.storage_namespace, w.database_placement, w.version, w.created_at, w.updated_at, m.role
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
        `SELECT workspace_id, id, display_name, description, backend_id, status, version, created_by, created_at, updated_at
         FROM workspace_agents WHERE workspace_id = $1 ORDER BY created_at, id`,
        [context.workspaceId]
      );
      return result.rows.map(agentFromRow);
    });
  }

  async registerAgent(context: WorkspaceRequestContext, input: RegisterWorkspaceAgentInput): Promise<{ agent: WorkspaceAgent; replayed: boolean }> {
    if (!input.displayName.trim() || input.displayName.trim().length > 200) throw new WorkspaceServerError("workspace_agent_display_name_invalid", 400);
    const backendId = normalizeAgentBackendId(input.backendId);
    const id = input.id ?? operationScopedId("agent", context.workspaceId, context.operationId);
    assertOpaqueId(id, "workspace_agent_id_invalid");
    const result = await this.runIdempotentResult(context, { action: "workspace.agent.register", input: { id, displayName: input.displayName.trim(), description: input.description?.trim() ?? "", backendId } }, async (sql) => {
      await this.assertWorkspaceWritable(sql, context.workspaceId);
      try {
        await sql.query("SELECT samurai_register_workspace_agent($1, $2, $3, $4)", [context.workspaceId, id, input.displayName.trim(), input.description?.trim() ?? ""]);
        if (backendId !== "samurai-native") {
          await sql.query("SELECT samurai_set_workspace_agent_backend($1, $2, $3)", [context.workspaceId, id, backendId]);
        }
      } catch (error) {
        if (postgresMessage(error).includes("duplicate key")) throw new WorkspaceServerError("workspace_agent_id_conflict", 409);
        throw error;
      }
      const saved = await sql.query<AgentRow>(
        `SELECT workspace_id, id, display_name, description, backend_id, status, version, created_by, created_at, updated_at
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
    });
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
      try {
        const moved = await sql.query<{ result: WorkspaceRecordPayload | string }>(
          "SELECT samurai_move_room($1, $2, $3, $4, $5, $6) AS result",
          [context.workspaceId, input.roomId, input.parentRoomId ?? null, input.expectedRoomVersion, input.expectedWorkspaceVersion, context.operationId]
        );
        const result = roomMoveResultPayload(moved.rows[0]?.result);
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
      } catch (error) {
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
    });
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
    });
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
    });
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
      if (!result.rows[0]) throw new WorkspaceServerError("room_not_found_or_access_denied", 404);
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
    action: (sql: WorkspaceSql) => Promise<T>
  ): Promise<T> {
    return (await this.runIdempotentResult(context, request, action)).value;
  }

  /**
   * Internal services that must decide whether to emit an external signal use
   * this instead of guessing from the returned value.  The result itself is
   * still stored exactly once in the operation ledger.
   */
  async runIdempotentResult<T>(
    context: WorkspaceRequestContext,
    request: { action: string; input: unknown },
    action: (sql: WorkspaceSql) => Promise<T>
  ): Promise<IdempotentOperationResult<T>> {
    assertOpaqueId(context.workspaceId, "workspace_id_invalid");
    assertOpaqueId(context.accountId, "account_id_invalid");
    assertOpaqueId(context.operationId, "operation_id_invalid");
    const requestHash = hash(canonicalJson(request));
    let originalFailure: unknown;
    const value = await this.database.withContext(context, async (sql) => {
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
    const saved = await sql.query<EventRow>(
      `INSERT INTO workspace_events(workspace_id, room_id, kind, record_type, record_id, operation_id, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7::JSONB)
       RETURNING id, workspace_id, room_id, kind, record_type, record_id, operation_id, payload, created_at`,
      [context.workspaceId, input.roomId, input.kind, input.recordType ?? null, input.recordId ?? null, context.operationId, canonicalJson(input.payload)]
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

interface WorkspaceSummaryRow {
  id: string;
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
  room_id: string;
  kind: string;
  record_type: string | null;
  record_id: string | null;
  operation_id: string;
  payload: WorkspaceRecordPayload | string;
  created_at: Date | string;
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

function workspaceSummaryFromRow(row: WorkspaceSummaryRow): WorkspaceSummary {
  return {
    id: row.id,
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
    roomId: row.room_id,
    kind: row.kind,
    ...(row.record_type ? { recordType: row.record_type } : {}),
    ...(row.record_id ? { recordId: row.record_id } : {}),
    operationId: row.operation_id,
    payload: jsonObject(row.payload),
    createdAt: iso(row.created_at)
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

function operationScopedId(kind: string, scope: string, operationId: string): string {
  return `${kind}_${createHash("sha256").update(`${kind}|${scope}|${operationId}`).digest("hex").slice(0, 40)}`;
}
