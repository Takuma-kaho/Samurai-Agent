import {
  ExternalIntegrationError,
  RoomBindingSchema,
  type ExternalAppConnectionLookup,
  type ExternalIntegrationAuthContext,
  type ExternalIntegrationStore,
  type ExternalRoomAuthorization,
  type ExternalWorkspaceTarget,
  type RoomBinding
} from "./contracts.js";
import { appendAuditEvent } from "./audit.js";
import { randomBytes } from "node:crypto";

export interface RoomBindingServiceOptions {
  store: ExternalIntegrationStore;
  connections: ExternalAppConnectionLookup;
  authorization: ExternalRoomAuthorization;
  /** Workspace-owned default Room. It is used only once, when a Project has
   * no binding; it never overrides an existing binding. */
  defaultRoomId?: (input: { workspaceId: string; accountId: string; connectionId: string; projectRef: string }) => Promise<string | undefined>;
  now?: () => Date;
  id?: () => string;
}

export interface BindRoomInput {
  auth: ExternalIntegrationAuthContext;
  workspaceId: string;
  accountId: string;
  projectRef: string;
  roomId: string;
  changedBy: string;
  expectedBindingVersion?: number;
  expectedBindingPresent?: boolean;
}

/** Keeps the external project/session binding server-owned and versioned.
 * The room ID in a normal MCP tool argument is never enough to select a Room. */
export class RoomBindingService {
  private readonly now: () => Date;
  private readonly id: () => string;

  constructor(private readonly options: RoomBindingServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.id = options.id ?? (() => `binding_${cryptoRandomId()}`);
  }

  async getBinding(input: { workspaceId: string; connectionId: string; accountId: string; projectRef: string }): Promise<RoomBinding | undefined> {
    const matches = await this.options.store.listRecords("room_binding", {
      workspaceId: input.workspaceId,
      connectionId: input.connectionId,
      accountId: input.accountId,
      projectRef: input.projectRef
    });
    return matches.sort((a, b) => b.binding_version - a.binding_version)[0];
  }

  async requireBinding(input: { workspaceId: string; connectionId: string; accountId: string; projectRef: string }): Promise<RoomBinding> {
    const binding = await this.getBinding(input);
    if (!binding) throw new ExternalIntegrationError("room_binding_required");
    return binding;
  }

  /** Reads a binding only after the current Connection and Room permission
   * have been checked. The raw getBinding method is for internal lookup only. */
  async getAuthorizedBinding(input: { auth: ExternalIntegrationAuthContext; workspaceId: string; projectRef: string }): Promise<RoomBinding> {
    if (input.auth.workspaceId !== input.workspaceId) throw new ExternalIntegrationError("connection_not_found");
    const connection = await this.requireActiveConnection({
      workspaceId: input.workspaceId,
      connectionId: input.auth.connectionId,
      accountId: input.auth.accountId,
      connectorId: input.auth.connectorId,
      appId: input.auth.appId
    });
    const binding = await this.requireBinding({
      workspaceId: input.workspaceId,
      connectionId: input.auth.connectionId,
      accountId: input.auth.accountId,
      projectRef: input.projectRef
    });
    this.assertRoomScope(connection, binding.room_id);
    await this.options.authorization.assertRoom(principalForConnection(connection), binding.room_id, "read");
    return binding;
  }

  /** Returns the existing authorized binding, or creates the Workspace
   * default for this Project exactly once. A first `room.binding.get` must not
   * force a Client to choose a Room manually when the Workspace already has a
   * declared default. */
  async getAuthorizedBindingOrDefault(input: { auth: ExternalIntegrationAuthContext; workspaceId: string; projectRef: string }, signal?: AbortSignal): Promise<RoomBinding> {
    return this.resolveAuthorizedBindingOrDefault(input, signal);
  }

  async bind(input: BindRoomInput, signal?: AbortSignal): Promise<RoomBinding> {
    throwIfAborted(signal);
    if (input.auth.accountId !== input.accountId) throw new ExternalIntegrationError("oauth_account_mismatch");
    const connection = await this.requireActiveConnection({
      workspaceId: input.workspaceId,
      connectionId: input.auth.connectionId,
      accountId: input.accountId,
      connectorId: input.auth.connectorId,
      appId: input.auth.appId
    });
    this.assertRoomScope(connection, input.roomId);
    await this.options.authorization.assertRoom(
      principalForConnection(connection),
      input.roomId,
      "manage_settings"
    );

    const current = await this.getBinding({
      workspaceId: input.workspaceId,
      connectionId: input.auth.connectionId,
      accountId: input.accountId,
      projectRef: input.projectRef
    });
    throwIfAborted(signal);
    if (current && input.expectedBindingPresent === false) throw new ExternalIntegrationError("room_binding_version_conflict");
    if (!current && input.expectedBindingPresent === true) throw new ExternalIntegrationError("room_binding_version_conflict");
    if (current && input.expectedBindingVersion !== undefined && current.binding_version !== input.expectedBindingVersion) {
      throw new ExternalIntegrationError("room_binding_version_conflict");
    }
    if (!current && input.expectedBindingVersion !== undefined && input.expectedBindingVersion !== 1) throw new ExternalIntegrationError("room_binding_version_conflict");
    if (!current) {
      throwIfAborted(signal);
      const created = RoomBindingSchema.parse({
        id: this.id(),
        workspace_id: input.workspaceId,
        connection_id: input.auth.connectionId,
        account_id: input.accountId,
        project_ref: input.projectRef,
        room_id: input.roomId,
        binding_version: 1,
        created_at: this.now().toISOString(),
        changed_at: this.now().toISOString(),
        changed_by: input.changedBy
      });
      let saved: RoomBinding;
      try {
        throwIfAborted(signal);
        saved = await this.options.store.createRecord("room_binding", created);
      } catch (error) {
        if (String(error).includes("external_record_exists")) throw new ExternalIntegrationError("room_binding_version_conflict");
        throw error;
      }
      try {
        await appendAuditEvent(this.options.store, { eventType: "room.binding.created", actorId: input.changedBy, workspaceId: input.workspaceId, connectionId: input.auth.connectionId, connectorId: input.auth.connectorId, accountId: input.accountId, resourceType: "room_binding", resourceId: saved.id, data: { project_ref: saved.project_ref, room_id: saved.room_id, binding_version: saved.binding_version } });
      } catch {
        throw new ExternalIntegrationError("mcp_outcome_unknown", "room_binding_audit_outcome_unknown", false);
      }
      return saved;
    }
    const version = await this.options.store.getRecordVersion("room_binding", current.id);
    throwIfAborted(signal);
    if (!version) throw new ExternalIntegrationError("room_binding_version_conflict");
    const expected = input.expectedBindingVersion ?? current.binding_version;
    if (expected !== current.binding_version) throw new ExternalIntegrationError("room_binding_version_conflict");
    const next = RoomBindingSchema.parse({
      ...current,
      room_id: input.roomId,
      binding_version: current.binding_version + 1,
      changed_at: this.now().toISOString(),
      changed_by: input.changedBy
    });
    throwIfAborted(signal);
    if (!await this.options.store.updateRecord("room_binding", current.id, version, next)) {
      throw new ExternalIntegrationError("room_binding_version_conflict");
    }
    try {
      await appendAuditEvent(this.options.store, { eventType: "room.binding.changed", actorId: input.changedBy, workspaceId: input.workspaceId, connectionId: input.auth.connectionId, connectorId: input.auth.connectorId, accountId: input.accountId, resourceType: "room_binding", resourceId: next.id, data: { project_ref: next.project_ref, room_id: next.room_id, binding_version: next.binding_version } });
    } catch {
      throw new ExternalIntegrationError("mcp_outcome_unknown", "room_binding_audit_outcome_unknown", false);
    }
    return next;
  }

  async resolveTarget(input: {
    auth: ExternalIntegrationAuthContext;
    workspaceId: string;
    projectRef: string;
    externalSessionId: string;
    sessionRef?: unknown;
  }, signal?: AbortSignal): Promise<ExternalWorkspaceTarget> {
    throwIfAborted(signal);
    const binding = await this.resolveAuthorizedBindingOrDefault({
      auth: input.auth,
      workspaceId: input.workspaceId,
      projectRef: input.projectRef
    }, signal);
    return {
      workspaceId: input.workspaceId,
      roomId: binding.room_id,
      projectRef: input.projectRef,
      accountId: input.auth.accountId,
      connectionId: input.auth.connectionId,
      connectorId: input.auth.connectorId,
      appId: input.auth.appId,
      bindingVersion: binding.binding_version,
      externalSessionId: input.externalSessionId,
      ...(input.sessionRef ? { sessionRef: input.sessionRef as ExternalWorkspaceTarget["sessionRef"] } : {})
    };
  }

  private async resolveAuthorizedBindingOrDefault(input: { auth: ExternalIntegrationAuthContext; workspaceId: string; projectRef: string }, signal?: AbortSignal): Promise<RoomBinding> {
    throwIfAborted(signal);
    try {
      return await this.getAuthorizedBinding(input);
    } catch (error) {
      if (!(error instanceof ExternalIntegrationError) || error.code !== "room_binding_required" || !this.options.defaultRoomId) throw error;
    }

    const defaultRoomId = await this.options.defaultRoomId({
      workspaceId: input.workspaceId,
      accountId: input.auth.accountId,
      connectionId: input.auth.connectionId,
      projectRef: input.projectRef
    });
    throwIfAborted(signal);
    if (!defaultRoomId) throw new ExternalIntegrationError("room_binding_required");
    const connection = await this.requireActiveConnection({
      workspaceId: input.workspaceId,
      connectionId: input.auth.connectionId,
      accountId: input.auth.accountId,
      connectorId: input.auth.connectorId,
      appId: input.auth.appId
    });
    this.assertRoomScope(connection, defaultRoomId);
    await this.options.authorization.assertRoom(principalForConnection(connection), defaultRoomId, "read");

    const current = await this.getBinding({
      workspaceId: input.workspaceId,
      connectionId: input.auth.connectionId,
      accountId: input.auth.accountId,
      projectRef: input.projectRef
    });
    throwIfAborted(signal);
    if (current) {
      this.assertRoomScope(connection, current.room_id);
      await this.options.authorization.assertRoom(principalForConnection(connection), current.room_id, "read");
      return current;
    }

    const now = this.now().toISOString();
    const created = RoomBindingSchema.parse({
      id: this.id(),
      workspace_id: input.workspaceId,
      connection_id: input.auth.connectionId,
      account_id: input.auth.accountId,
      project_ref: input.projectRef,
      room_id: defaultRoomId,
      binding_version: 1,
      created_at: now,
      changed_at: now,
      changed_by: input.auth.accountId
    });
    try {
      throwIfAborted(signal);
      const saved = await this.options.store.createRecord("room_binding", created);
      try {
        await appendAuditEvent(this.options.store, {
          eventType: "room.binding.default_created",
          actorId: input.auth.accountId,
          workspaceId: input.workspaceId,
          connectionId: input.auth.connectionId,
          connectorId: input.auth.connectorId,
          accountId: input.auth.accountId,
          resourceType: "room_binding",
          resourceId: saved.id,
          data: { project_ref: saved.project_ref, room_id: saved.room_id, binding_version: saved.binding_version }
        });
      } catch {
        throw new ExternalIntegrationError("mcp_outcome_unknown", "room_binding_default_audit_outcome_unknown", false);
      }
      return saved;
    } catch (error) {
      // Another first request may have created the binding concurrently. Use
      // the committed binding; never replace it with the default silently.
      if (!String(error).includes("external_record_exists")) throw error;
      const raced = await this.getBinding({
        workspaceId: input.workspaceId,
        connectionId: input.auth.connectionId,
        accountId: input.auth.accountId,
        projectRef: input.projectRef
      });
      if (!raced) throw new ExternalIntegrationError("room_binding_version_conflict");
      this.assertRoomScope(connection, raced.room_id);
      await this.options.authorization.assertRoom(principalForConnection(connection), raced.room_id, "read");
      return raced;
    }
  }

  async assertTargetCurrent(target: ExternalWorkspaceTarget): Promise<RoomBinding> {
    const connection = await this.requireActiveConnection({
      workspaceId: target.workspaceId,
      connectionId: target.connectionId,
      accountId: target.accountId,
      connectorId: target.connectorId,
      appId: target.appId
    });
    const current = await this.requireBinding({
      workspaceId: target.workspaceId,
      connectionId: target.connectionId,
      accountId: target.accountId,
      projectRef: target.projectRef
    });
    this.assertRoomScope(connection, current.room_id);
    await this.options.authorization.assertRoom(principalForConnection(connection), current.room_id, "read");
    if (current.binding_version !== target.bindingVersion || current.room_id !== target.roomId) {
      throw new ExternalIntegrationError("external_session_restart_required");
    }
    return current;
  }

  /** Returns the current binding version for a mutation precondition. Version
   * 1 is the initial, not-yet-bound sentinel; the first bind consumes it. */
  async currentBindingVersion(target: ExternalWorkspaceTarget): Promise<number> {
    const connection = await this.requireActiveConnection({
      workspaceId: target.workspaceId,
      connectionId: target.connectionId,
      accountId: target.accountId,
      connectorId: target.connectorId,
      appId: target.appId
    });
    const current = await this.getBinding({
      workspaceId: target.workspaceId,
      connectionId: target.connectionId,
      accountId: target.accountId,
      projectRef: target.projectRef
    });
    if (!current) return 1;
    this.assertRoomScope(connection, current.room_id);
    await this.options.authorization.assertRoom(principalForConnection(connection), current.room_id, "read");
    return current.binding_version;
  }

  private async requireActiveConnection(input: {
    workspaceId: string;
    connectionId: string;
    accountId: string;
    connectorId: string;
    appId: string;
  }): Promise<NonNullable<Awaited<ReturnType<ExternalAppConnectionLookup["getExternalAppConnection"]>>>> {
    const connection = await this.options.connections.getExternalAppConnection(input.connectionId);
    if (!connection || connection.workspace_id !== input.workspaceId) throw new ExternalIntegrationError("connection_not_found");
    if (connection.status !== "active") throw new ExternalIntegrationError("connection_revoked");
    if (connection.connector_id !== input.connectorId || connection.app_id !== input.appId) throw new ExternalIntegrationError("connection_revoked");
    const delegatedAccountId = connection.delegated_principal.kind === "human"
      ? connection.delegated_principal.participant_id
      : connection.delegated_principal.requested_by_participant_id;
    if (delegatedAccountId !== input.accountId) {
      throw new ExternalIntegrationError("oauth_account_mismatch");
    }
    return connection;
  }

  private assertRoomScope(connection: NonNullable<Awaited<ReturnType<ExternalAppConnectionLookup["getExternalAppConnection"]>>>, roomId: string): void {
    if (!connection.allowed_room_ids.includes(roomId)) throw new ExternalIntegrationError("room_binding_room_denied");
  }
}

function principalForConnection(connection: Awaited<ReturnType<ExternalAppConnectionLookup["getExternalAppConnection"]>>): {
  kind: "human" | "agent";
  participantId?: string;
  agentId?: string;
  requestedByParticipantId?: string;
} {
  if (!connection) throw new ExternalIntegrationError("connection_not_found");
  if (connection.delegated_principal.kind === "human") {
    return {
      kind: "human",
      participantId: connection.delegated_principal.participant_id,
      requestedByParticipantId: connection.delegated_principal.requested_by_participant_id
    };
  }
  return {
    kind: "agent",
    agentId: connection.delegated_principal.agent_id,
    requestedByParticipantId: connection.delegated_principal.requested_by_participant_id
  };
}

function cryptoRandomId(): string {
  return randomBytes(16).toString("hex");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new ExternalIntegrationError("mcp_cancelled", "mcp_request_cancelled_before_write", true);
}
