import {
  ExternalAppConnectionRecordSchema,
  createId,
  nowIso,
  type ExternalAppConnectionRecord,
  type OperationRecord,
  type ResourceRef
} from "@samurai-agent/core-schemas";
import type { ParticipantPrincipal } from "@samurai-agent/room-permissions";
import type { TrustedDomainContext } from "@samurai-agent/domain-operations";
import type { RuntimeWriteResult } from "../../agent-runtime.js";
import { RoomAuthorizationError, type RoomAuthorizationService } from "./room-authorization-service.js";

interface ExternalAppConnectionStore {
  saveExternalAppConnection(record: ExternalAppConnectionRecord): Promise<ExternalAppConnectionRecord>;
  getExternalAppConnection(id: string): Promise<ExternalAppConnectionRecord | undefined>;
  revokeExternalAppConnection(input: { id: string; revokedAt: string; updatedAt?: string }): Promise<ExternalAppConnectionRecord | undefined>;
}

interface ConnectionMutationPort {
  runMutation(input: {
    trustedContext: TrustedDomainContext;
    inputSummary: string;
    operationName: string;
    proposedEffects: string[];
    execute(operation: OperationRecord): Promise<{ resource: ExternalAppConnectionRecord; ref: ResourceRef; summary: string }>;
  }): Promise<RuntimeWriteResult<ExternalAppConnectionRecord>>;
}

/** Domain-facing service for Connection lifecycle. Credentials cannot enter this type. */
export class ExternalAppConnectionDomainService {
  constructor(private readonly dependencies: {
    workspaceId: string;
    store: ExternalAppConnectionStore;
    roomAuthorization: Pick<RoomAuthorizationService, "assertWorkspace" | "assertRoom">;
    mutation: ConnectionMutationPort;
    requestError: (code: "not_found" | "conflict" | "forbidden", message: string) => Error;
  }) {}

  async create(input: {
    context: TrustedDomainContext;
    request: {
      connector_id: string;
      app_id: string;
      delegated_principal: ExternalAppConnectionRecord["delegated_principal"];
      allowed_room_ids: string[];
      ingress_classes: ExternalAppConnectionRecord["ingress_classes"];
      non_secret_metadata: ExternalAppConnectionRecord["non_secret_metadata"];
    };
  }): Promise<RuntimeWriteResult<ExternalAppConnectionRecord>> {
    const management = await this.assertManagementContext(input.context);
    await this.assertDelegatedScopes(management.participant, input.request.delegated_principal, input.request.allowed_room_ids);
    const now = nowIso();
    return this.dependencies.mutation.runMutation({
      trustedContext: input.context,
      inputSummary: `Create external app Connection: ${input.request.connector_id}`,
      operationName: "external_app.connection.create",
      proposedEffects: ["Create a narrowed external app Connection without adding Room membership."],
      execute: async (operation) => {
        const record = ExternalAppConnectionRecordSchema.parse({
          id: createId("external-app-connection"),
          workspace_id: this.dependencies.workspaceId,
          connector_id: input.request.connector_id,
          app_id: input.request.app_id,
          status: "active",
          delegated_principal: input.request.delegated_principal,
          allowed_room_ids: unique(input.request.allowed_room_ids),
          ingress_classes: unique(input.request.ingress_classes),
          non_secret_metadata: input.request.non_secret_metadata,
          created_by: management.createdBy,
          created_at: now,
          updated_at: now
        });
        const saved = await this.dependencies.store.saveExternalAppConnection(record);
        return { resource: saved, ref: connectionRef(saved), summary: `Created external app Connection ${saved.connector_id}.` };
      }
    });
  }

  async updateScope(input: {
    context: TrustedDomainContext;
    request: {
      connection_id: string;
      allowed_room_ids: string[];
      ingress_classes: ExternalAppConnectionRecord["ingress_classes"];
      non_secret_metadata?: ExternalAppConnectionRecord["non_secret_metadata"];
    };
  }): Promise<RuntimeWriteResult<ExternalAppConnectionRecord>> {
    const management = await this.assertManagementContext(input.context);
    const current = await this.dependencies.store.getExternalAppConnection(input.request.connection_id);
    if (!current) throw this.dependencies.requestError("not_found", "external_app_connection_not_found");
    if (current.status !== "active") throw this.dependencies.requestError("conflict", "external_app_connection_revoked");
    await this.assertDelegatedScopes(management.participant, current.delegated_principal, input.request.allowed_room_ids);
    const now = nowIso();
    return this.dependencies.mutation.runMutation({
      trustedContext: input.context,
      inputSummary: `Update external app Connection scope: ${current.connector_id}`,
      operationName: "external_app.connection.update_scope",
      proposedEffects: ["Update external app Connection scopes without changing Room membership."],
      execute: async () => {
        const saved = await this.dependencies.store.saveExternalAppConnection({
          ...current,
          allowed_room_ids: unique(input.request.allowed_room_ids),
          ingress_classes: unique(input.request.ingress_classes),
          ...(input.request.non_secret_metadata ? { non_secret_metadata: input.request.non_secret_metadata } : {}),
          updated_at: now
        });
        return { resource: saved, ref: connectionRef(saved), summary: `Updated external app Connection ${saved.connector_id}.` };
      }
    });
  }

  async revoke(input: { context: TrustedDomainContext; connectionId: string }): Promise<RuntimeWriteResult<ExternalAppConnectionRecord>> {
    await this.assertManagementContext(input.context);
    const current = await this.dependencies.store.getExternalAppConnection(input.connectionId);
    if (!current) throw this.dependencies.requestError("not_found", "external_app_connection_not_found");
    const now = nowIso();
    return this.dependencies.mutation.runMutation({
      trustedContext: input.context,
      inputSummary: `Revoke external app Connection: ${current.connector_id}`,
      operationName: "external_app.connection.revoke",
      proposedEffects: ["Revoke external app Connection ingress."],
      execute: async () => {
        const saved = await this.dependencies.store.revokeExternalAppConnection({ id: current.id, revokedAt: now, updatedAt: now });
        if (!saved) throw this.dependencies.requestError("not_found", "external_app_connection_not_found");
        return { resource: saved, ref: connectionRef(saved), summary: `Revoked external app Connection ${saved.connector_id}.` };
      }
    });
  }

  private async assertManagementContext(context: TrustedDomainContext): Promise<{
    createdBy: ExternalAppConnectionRecord["created_by"];
    participant: Exclude<ParticipantPrincipal, { kind: "system" | "external_app" }>;
  }> {
    const participant = context.participant;
    if (!participant || participant.kind === "system" || participant.kind === "external_app") {
      throw this.dependencies.requestError("forbidden", "external_app_connection_direct_principal_required");
    }
    try {
      await this.dependencies.roomAuthorization.assertWorkspace(participant, "manage_settings");
    } catch (error) {
      if (error instanceof RoomAuthorizationError) {
        throw this.dependencies.requestError("forbidden", `external_app_connection_management_denied:${error.reason}`);
      }
      throw error;
    }
    return { createdBy: toDelegatedPrincipal(participant), participant };
  }

  private async assertDelegatedScopes(
    manager: Exclude<ParticipantPrincipal, { kind: "system" | "external_app" }>,
    principal: ExternalAppConnectionRecord["delegated_principal"],
    roomIds: string[]
  ): Promise<void> {
    const delegated = participantFromDelegated(principal);
    for (const roomId of unique(roomIds)) {
      // A Workspace manager cannot broaden a Connection into a Room they
      // cannot currently inspect. The delegated principal is checked too;
      // Connection creation never creates either membership.
      try {
        await this.dependencies.roomAuthorization.assertRoom(manager, roomId, "read");
        await this.dependencies.roomAuthorization.assertRoom(delegated, roomId, "read");
      } catch (error) {
        if (error instanceof RoomAuthorizationError) {
          throw this.dependencies.requestError("forbidden", `external_app_connection_scope_room_access_denied:${error.reason}`);
        }
        throw error;
      }
    }
  }
}

function connectionRef(record: ExternalAppConnectionRecord): ResourceRef {
  return { kind: "external_app_connection", id: record.id, uri: `external-app-connections/${record.id}`, label: record.connector_id };
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function toDelegatedPrincipal(principal: Exclude<ParticipantPrincipal, { kind: "system" | "external_app" }>): ExternalAppConnectionRecord["created_by"] {
  if (principal.kind === "human") return { kind: "human", participant_id: principal.participantId };
  return { kind: "agent", agent_id: principal.agentId, requested_by_participant_id: principal.requestedByParticipantId };
}

function participantFromDelegated(principal: ExternalAppConnectionRecord["delegated_principal"]): Exclude<ParticipantPrincipal, { kind: "system" | "external_app" }> {
  if (principal.kind === "human") return { kind: "human", participantId: principal.participant_id };
  return { kind: "agent", agentId: principal.agent_id, requestedByParticipantId: principal.requested_by_participant_id };
}
