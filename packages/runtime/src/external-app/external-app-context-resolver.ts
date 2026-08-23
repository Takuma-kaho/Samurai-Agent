import {
  ConnectorEvidenceSchema,
  SessionRefSchema,
  TrustedWorkspaceContextSchema,
  type ConnectorEvidence,
  type ExternalAppConnectionRecord,
  type ExternalAppIngressClass,
  type SessionRef,
  type TrustedWorkspaceContext
} from "@samurai-agent/core-schemas";
import type { ParticipantPrincipal } from "@samurai-agent/room-permissions";
import { RoomAuthorizationError, type RoomAuthorizationService } from "../commands/services/room-authorization-service.js";

export class ExternalAppContextError extends Error {
  constructor(readonly code: ExternalAppContextErrorCode, message: string = code) {
    super(message);
    this.name = "ExternalAppContextError";
  }
}

export type ExternalAppContextErrorCode =
  | "external_app_connection_not_found"
  | "external_app_connection_revoked"
  | "external_app_connector_mismatch"
  | "external_app_app_mismatch"
  | "external_app_connection_room_scope_denied"
  | "external_app_ingress_class_denied"
  | "external_app_delegated_principal_inactive"
  | "external_app_room_permission_denied"
  | "external_app_requested_room_invalid";

export interface RequestedWorkspaceTarget {
  requested_room_id: string;
  correlation_id: string;
  idempotency_key?: string;
  /** The authenticated Connection selected by OAuth/MCP. */
  connection_id?: string;
  /** App-controlled reference fields only. The server supplies the app_id. */
  session_ref?: RequestedExternalSessionRef;
}

export interface RequestedExternalSessionRef {
  session_id: string;
  turn_id?: string;
  message_id?: string;
}

export interface ResolvedExternalAppContext {
  connection: ExternalAppConnectionRecord;
  participant: Extract<ParticipantPrincipal, { kind: "external_app" }>;
  trustedContext: {
    participant: ParticipantPrincipal;
    roomId: string;
    correlationId: string;
    connectionId: string;
    idempotencyKey?: string;
    externalAllowedRoomIds: readonly string[];
    sessionRef?: SessionRef;
    source: { kind: "external_app"; app_id: string; connector_id: string };
  };
  workspaceContext: TrustedWorkspaceContext;
}

export interface ExternalAppConnectionLookup {
  getExternalAppConnectionByConnector(input: { workspaceId: string; connectorId: string }): Promise<ExternalAppConnectionRecord | undefined>;
  /** Exact Connection lookup is mandatory when the authenticated target names
   * a Connection. Falling back to connector lookup would let a newer or
   * unrelated Connection inherit the request's Room authority. */
  getExternalAppConnection(input: { workspaceId: string; connectionId: string }): Promise<ExternalAppConnectionRecord | undefined>;
}

/**
 * Converts authenticated, secret-free connector evidence into a server-owned
 * Room context. It never writes the Store and never creates a Session.
 */
export class ExternalAppContextResolver {
  constructor(
    private readonly dependencies: {
      workspaceId: string;
      connections: ExternalAppConnectionLookup;
      roomAuthorization: Pick<RoomAuthorizationService, "assertRoom">;
    }
  ) {}

  async resolve(input: {
    evidence: ConnectorEvidence;
    target: RequestedWorkspaceTarget;
    ingressClass: ExternalAppIngressClass;
  }): Promise<ResolvedExternalAppContext> {
    const evidence = ConnectorEvidenceSchema.parse(input.evidence);
    const target = parseRequestedTarget(input.target);
    let connection: ExternalAppConnectionRecord | undefined;
    if (target.connection_id) {
      if (typeof this.dependencies.connections.getExternalAppConnection !== "function") {
        throw new ExternalAppContextError("external_app_connection_not_found");
      }
      connection = await this.dependencies.connections.getExternalAppConnection({
        workspaceId: this.dependencies.workspaceId,
        connectionId: target.connection_id
      });
    } else {
      connection = await this.dependencies.connections.getExternalAppConnectionByConnector({
        workspaceId: this.dependencies.workspaceId,
        connectorId: evidence.connector_id
      });
    }
    if (!connection) throw new ExternalAppContextError("external_app_connection_not_found");
    if (connection.workspace_id !== this.dependencies.workspaceId) throw new ExternalAppContextError("external_app_connection_not_found");
    if (target.connection_id && connection.id !== target.connection_id) throw new ExternalAppContextError("external_app_connection_not_found");
    if (connection.status !== "active") throw new ExternalAppContextError("external_app_connection_revoked");
    if (connection.connector_id !== evidence.connector_id) throw new ExternalAppContextError("external_app_connector_mismatch");
    if (connection.app_id !== evidence.app_id) throw new ExternalAppContextError("external_app_app_mismatch");
    if (!connection.allowed_room_ids.includes(target.requested_room_id)) {
      throw new ExternalAppContextError("external_app_connection_room_scope_denied");
    }
    if (!connection.ingress_classes.includes(input.ingressClass)) {
      throw new ExternalAppContextError("external_app_ingress_class_denied");
    }
    const sessionRef = target.session_ref
      ? SessionRefSchema.parse({ app_id: connection.app_id, ...target.session_ref })
      : undefined;
    const delegatedBy = delegatedParticipant(connection);
    const participant: Extract<ParticipantPrincipal, { kind: "external_app" }> = {
      kind: "external_app",
      appId: connection.app_id,
      connectorId: connection.connector_id,
      delegatedBy
    };
    // This establishes the current authority before any Domain handler. Each
    // operation then rechecks its stricter read/edit/execute requirement.
    try {
      await this.dependencies.roomAuthorization.assertRoom(participant, target.requested_room_id, "read");
    } catch (error) {
      if (error instanceof RoomAuthorizationError && ["workspace_membership_missing", "agent_not_found", "agent_disabled"].includes(error.reason)) {
        throw new ExternalAppContextError("external_app_delegated_principal_inactive");
      }
      throw new ExternalAppContextError("external_app_room_permission_denied");
    }
    const source = { kind: "external_app" as const, app_id: connection.app_id, connector_id: connection.connector_id };
    const workspaceContext = TrustedWorkspaceContextSchema.parse({
      workspace_id: connection.workspace_id,
      room_id: target.requested_room_id,
      connection_id: connection.id,
      principal: {
        kind: "external_app",
        app_id: connection.app_id,
        connector_id: connection.connector_id,
        delegated_by: connection.delegated_principal
      },
      source,
      correlation_id: target.correlation_id,
      ...(sessionRef ? { session_ref: sessionRef } : {})
    });
    return {
      connection,
      participant,
      trustedContext: {
        participant,
        roomId: target.requested_room_id,
        correlationId: target.correlation_id,
        connectionId: connection.id,
        externalAllowedRoomIds: [...connection.allowed_room_ids],
        ...(target.idempotency_key ? { idempotencyKey: target.idempotency_key } : {}),
        ...(sessionRef ? { sessionRef } : {}),
        source
      },
      workspaceContext
    };
  }
}

function parseRequestedTarget(input: RequestedWorkspaceTarget): RequestedWorkspaceTarget {
  if (!input || typeof input !== "object") throw new ExternalAppContextError("external_app_requested_room_invalid");
  const candidate = input as unknown as Record<string, unknown>;
  const allowed = new Set(["requested_room_id", "correlation_id", "idempotency_key", "connection_id", "session_ref"]);
  if (Object.keys(candidate).some((key) => !allowed.has(key))) throw new ExternalAppContextError("external_app_requested_room_invalid");
  if (typeof candidate.requested_room_id !== "string" || !candidate.requested_room_id.trim()) {
    throw new ExternalAppContextError("external_app_requested_room_invalid");
  }
  if (typeof candidate.correlation_id !== "string" || !candidate.correlation_id.trim()) {
    throw new ExternalAppContextError("external_app_requested_room_invalid");
  }
  if (candidate.idempotency_key !== undefined && (typeof candidate.idempotency_key !== "string" || !candidate.idempotency_key.trim())) {
    throw new ExternalAppContextError("external_app_requested_room_invalid");
  }
  if (candidate.connection_id !== undefined && (typeof candidate.connection_id !== "string" || !candidate.connection_id.trim())) {
    throw new ExternalAppContextError("external_app_requested_room_invalid");
  }
  return {
    requested_room_id: candidate.requested_room_id.trim(),
    correlation_id: candidate.correlation_id.trim(),
    ...(typeof candidate.idempotency_key === "string" ? { idempotency_key: candidate.idempotency_key.trim() } : {}),
    ...(typeof candidate.connection_id === "string" ? { connection_id: candidate.connection_id.trim() } : {}),
    ...(candidate.session_ref === undefined ? {} : { session_ref: parseRequestedSessionRef(candidate.session_ref) })
  };
}

function parseRequestedSessionRef(value: unknown): RequestedExternalSessionRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ExternalAppContextError("external_app_requested_room_invalid");
  }
  const candidate = value as Record<string, unknown>;
  const allowed = new Set(["session_id", "turn_id", "message_id"]);
  if (Object.keys(candidate).some((key) => !allowed.has(key))) {
    throw new ExternalAppContextError("external_app_requested_room_invalid");
  }
  for (const key of ["session_id", "turn_id", "message_id"] as const) {
    if (candidate[key] !== undefined && (typeof candidate[key] !== "string" || !candidate[key].trim() || candidate[key].length > 512)) {
      throw new ExternalAppContextError("external_app_requested_room_invalid");
    }
  }
  if (typeof candidate.session_id !== "string" || !candidate.session_id.trim()) {
    throw new ExternalAppContextError("external_app_requested_room_invalid");
  }
  return {
    session_id: candidate.session_id.trim(),
    ...(typeof candidate.turn_id === "string" ? { turn_id: candidate.turn_id.trim() } : {}),
    ...(typeof candidate.message_id === "string" ? { message_id: candidate.message_id.trim() } : {})
  };
}

function delegatedParticipant(connection: ExternalAppConnectionRecord): Extract<ParticipantPrincipal, { kind: "human" | "agent" }> {
  if (connection.delegated_principal.kind === "human") {
    return { kind: "human", participantId: connection.delegated_principal.participant_id };
  }
  return {
    kind: "agent",
    agentId: connection.delegated_principal.agent_id,
    requestedByParticipantId: connection.delegated_principal.requested_by_participant_id
  };
}
