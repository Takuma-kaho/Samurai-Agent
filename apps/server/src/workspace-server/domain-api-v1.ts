import type { Express, NextFunction, Request, RequestHandler, Response } from "express";
import { createHash } from "node:crypto";
import { Server as SocketServer, type Socket } from "socket.io";
import { z } from "zod";
import {
  ActivityRecordSchema,
  AgentRecordSchema,
  ArtifactRecordSchema,
  ResourceRefSchema,
  RoomRecordSchema,
  type ActivityRecord,
  type JsonValue,
  type ResourceRef
} from "@samurai-agent/core-schemas";
import {
  ActivityIngestRequestSchema,
  DomainApiCatalogSchema,
  DomainApiRequestSchema,
  DomainApiResponseSchema,
  EventReplayPageSchema,
  PublicAgentRecordSchema,
  PublicEventEnvelopeSchema,
  PublicWorkspaceDirectorySchema,
  PublicWorkspaceOrganizationAssociationResultSchema,
  PublicRoomRecordSchema,
  RunControlActionSchema,
  RunControlInputSchema,
  eventPayloadSchemaFor,
  eventCatalog,
  parsePublicEventPayload,
  publicDomainOperationIds,
  publicOperationOutputSchemaFor,
  runControlCatalog,
  runControlRequestSchemaFor,
  schemaForPublicContract,
  type DomainApiResponse,
  type EventReplayPage,
  type PublicEventEnvelope
} from "@samurai-agent/domain-api";
import {
  operationDefinitions,
  type TrustedDomainContext
} from "@samurai-agent/domain-operations";
import {
  WorkspaceServerError,
  type OrganizationRequestContext,
  type WorkspaceRequestContext,
  type WorkspaceServerCommandService,
  type WorkspacePublicEvent,
  type WorkspacePublicEventPage,
  type WorkspaceServerStore
} from "@samurai-agent/workspace-server";
import { PostgresArtifact } from "../adapters/runtime/postgres-artifact";
import { createPostgresChatSessionThroughDomainOperation } from "../adapters/runtime/postgres-session-domain-operation";
import { runPostgresChatTurnThroughDomainOperation } from "../adapters/runtime/postgres-chat-domain-operation";
import { PostgresRuntimeCommandService } from "../adapters/runtime/postgres-runtime-chat";
import { WorkspaceRealtimeGate } from "./realtime";
import { RunControlService } from "./run-control-service";

const v1OperationIds = new Set<string>(publicDomainOperationIds);
const runControlService = new RunControlService();

/** Organization control-plane requests are Account-scoped.  They deliberately
 * do not reuse WorkspaceRequestContext: Organization membership can reveal
 * Workspace metadata, but it never grants Room/Message access. */
export type OrganizationApiRequestContext = OrganizationRequestContext;

/**
 * Organization-owned compatibility operations.  Workspace bundle operations
 * are deliberately kept out of this set so they are advertised and executed
 * through the Workspace API.  The old Organization REST route remains a
 * compatibility alias through `organizationRouteOperationIds` below.
 */
const organizationOperationIds = new Set<string>([
  "organization.list", "organization.view", "organization.create", "organization.patch", "organization.delete",
  "organization.member.list", "organization.member.invite", "organization.member.accept",
  "organization.member.role.change", "organization.member.remove", "organization.member.leave",
  "organization.invitation.list", "organization.invitation.revoke", "organization.invitation.reissue",
  "organization.invitation.extend",
  "organization.workspace.list", "organization.workspace.create", "organization.workspace.member.grant",
  "organization.workspace.member.revoke", "organization.workspace.archive", "organization.workspace.restore",
  "organization.workspace.delete", "workspace.organization.move.preflight", "workspace.organization.move.commit",
  "workspace.organization.move.status"
]);

/** Old `/api/v1/domain/...` and Organization REST callers may still use these
 * IDs.  They share the same command facade, but are not Organization catalog
 * entries and do not make Organization membership a Workspace capability. */
const organizationCompatibilityOperationIds = new Set<string>([
  "workspace.bundle.export", "workspace.bundle.restore"
]);

const organizationRouteOperationIds = new Set<string>([
  ...organizationOperationIds,
  ...organizationCompatibilityOperationIds
]);

/** The Organization catalog exposes only control-plane operations.  Legacy
 * Organization Workspace CRUD routes remain callable, but are not the public
 * Workspace-first contract. */
const organizationCatalogOperationIds = new Set<string>([
  "organization.list", "organization.view", "organization.create", "organization.patch", "organization.delete",
  "organization.member.list", "organization.member.invite", "organization.member.accept",
  "organization.member.role.change", "organization.member.remove", "organization.member.leave",
  "organization.invitation.list", "organization.invitation.revoke", "organization.invitation.reissue",
  "organization.invitation.extend", "organization.workspace.member.grant", "organization.workspace.member.revoke",
  "workspace.organization.move.preflight", "workspace.organization.move.commit", "workspace.organization.move.status"
]);

const organizationCommandIds = new Set<string>([
  "organization.create", "organization.patch", "organization.delete", "organization.member.invite",
  "organization.member.accept", "organization.member.role.change", "organization.member.remove",
  "organization.member.leave", "organization.invitation.revoke", "organization.invitation.reissue",
  "organization.invitation.extend", "organization.workspace.create", "organization.workspace.member.grant",
  "organization.workspace.member.revoke", "organization.workspace.archive", "organization.workspace.restore",
  "organization.workspace.delete", "workspace.organization.move.commit", "workspace.bundle.export",
  "workspace.bundle.restore"
]);

const organizationQueryIds = new Set<string>([
  "organization.list", "organization.view", "organization.member.list", "organization.invitation.list",
  "organization.workspace.list", "workspace.organization.move.preflight", "workspace.organization.move.status"
]);

type V1Dependencies = {
  app: Express;
  io: SocketServer;
  store: WorkspaceServerStore;
  commands: WorkspaceServerCommandService;
  artifacts: PostgresArtifact;
  realtimeGate: WorkspaceRealtimeGate;
  authenticateWorkspace: RequestHandler;
  authenticateAccount: RequestHandler;
  asyncRoute: (handler: (req: Request, res: Response, next: NextFunction) => Promise<void>) => RequestHandler;
  workspaceContext: (req: Request) => Pick<WorkspaceRequestContext, "workspaceId" | "accountId">;
  operationContext: (req: Request) => WorkspaceRequestContext;
  organizationContext: (req: Request, organizationId?: string, options?: { mutation?: boolean }) => OrganizationApiRequestContext;
  requestId: (req: Request) => string;
  runtimeFor: (req: Request) => PostgresRuntimeCommandService;
};

/** Mounts the first public API slice. Transport authentication remains owned by
 * the existing Workspace middleware; this module only adapts trusted context
 * to the shared contract and never accepts actor/authority fields from JSON. */
export function mountDomainApiV1(dependencies: V1Dependencies): void {
  const {
    app, io, store, commands, artifacts, realtimeGate,
    authenticateWorkspace, authenticateAccount, asyncRoute, workspaceContext, operationContext,
    organizationContext, requestId, runtimeFor
  } = dependencies;

  app.get("/api/v1/workspaces/:workspaceId/domain/catalog", authenticateWorkspace, asyncRoute(async (_req, res) => {
    const contracts = operationDefinitions
      .filter((definition) => v1OperationIds.has(definition.id) && !organizationOperationIds.has(definition.id) && definition.sources.includes("runtime_api"))
      .map((definition) => ({
        id: definition.id,
        kind: definition.kind,
        version: definition.version,
        availability: definition.availability,
        input_schema: schemaForPublicContract(definition.input, `${definition.id}.input`),
        output_schema: schemaForPublicContract(
          publicOperationOutputSchemaFor(definition.id, definition.output),
          `${definition.id}.output`
        ),
        idempotency: definition.idempotency,
        concurrency: definition.concurrency,
        sources: [...definition.sources]
      }));
    res.json(DomainApiCatalogSchema.parse({ api_version: "1", contracts, events: eventCatalog, run_controls: runControlCatalog }));
  }));

  mountOrganizationDomainRoutes(dependencies);

  app.post("/api/v1/workspaces/:workspaceId/domain/operations/:operationId", authenticateWorkspace, asyncRoute(async (req, res) => {
    const operationId = pathParam(req, "operationId");
    const request = parseDomainRequest(req.body);
    const definition = operationDefinitions.find((candidate) => candidate.id === operationId);
    if (!definition || definition.kind !== "command" || !v1OperationIds.has(operationId) || !definition.sources.includes("runtime_api")) {
      throw new WorkspaceServerError("domain_operation_not_available", 404, { operation_id: operationId });
    }
    const parsedInput = parseOperationInput(definition, request.input, operationId);
    if (operationId === "workspace.bundle.restore") assertStandaloneBundleOperationInput(parsedInput);
    // The path is the trusted Workspace selector.  Bundle export keeps the
    // Workspace ID optional in the transport body so REST, Desktop, and
    // Browser callers cannot disagree about the authority-bearing value.
    const input = operationId === "workspace.bundle.export"
      ? { ...parsedInput, workspace_id: parsedInput.workspace_id ?? pathParam(req, "workspaceId") }
      : parsedInput;
    const operation = operationContext(req);
    const context = trustedContext(operation, request.context, operationId);
    const result = await executeCommand({ operationId, input, requestContext: request.context, context, req, operation, dependencies });
    const response = apiResponse(req, publicOperationResult(operationId, result.value, operation.accountId), result.replayed);
    res.status(result.replayed ? 200 : 201).json(response);
  }));

  app.post("/api/v1/workspaces/:workspaceId/domain/queries/:queryId", authenticateWorkspace, asyncRoute(async (req, res) => {
    const queryId = pathParam(req, "queryId");
    const request = parseDomainRequest(req.body);
    const definition = operationDefinitions.find((candidate) => candidate.id === queryId);
    if (!definition || definition.kind !== "query" || !v1OperationIds.has(queryId) || !definition.sources.includes("runtime_api")) {
      throw new WorkspaceServerError("domain_query_not_available", 404, { query_id: queryId });
    }
    const input = parseOperationInput(definition, request.input, queryId);
    const context = trustedContext(workspaceContext(req), request.context, undefined, requestId(req));
    const result = await executeQuery(queryId, input, request.context, context, dependencies);
    res.json(apiResponse(req, publicOperationResult(queryId, result), false));
  }));

  app.post("/api/v1/workspaces/:workspaceId/activities", authenticateWorkspace, asyncRoute(async (req, res) => {
    const input = parseActivityRequest(req.body);
    const operation = operationContext(req);
    const activityId = input.activity_id ?? deterministicActivityId(operation.workspaceId, input.context.room_id, input.dedupe_key);
    const now = new Date().toISOString();
    const status = activityStatus(input.outcome);
    const activity = ActivityRecordSchema.parse({
      id: activityId,
      workspace_id: operation.workspaceId,
      room_id: input.context.room_id,
      principal: { kind: "human", participant_id: operation.accountId },
      source: { kind: "native_app" },
      status: "recording",
      idempotency_key: input.dedupe_key,
      source_event_id: input.source_event_id,
      payload_hash: input.payload_hash,
      occurred_at: input.occurred_at,
      instruction_summary: input.instruction_summary,
      verification: input.verification,
      ...(input.backend_run_id ? { backend_run_id: input.backend_run_id } : {}),
      domain_operation_ids: input.domain_operation_ids,
      provenance: { kind: "system", source_id: input.source_event_id, recorded_at: now },
      created_at: now,
      updated_at: now
    });
    const resourceUsage = input.resource_usage.map((usage) => ({ ...usage, activity_id: activityId }));
    const result = await commands.ingestFinalizedRuntimeActivityWithReplay(operation, {
      activity,
      resourceUsage,
      finalization: {
        status,
        ...(input.result_summary ? { resultSummary: input.result_summary } : {}),
        verification: input.verification,
        ...(input.failure ? { failure: input.failure } : {}),
        ...(input.backend_run_id ? { backendRunId: input.backend_run_id } : {}),
        domainOperationIds: input.domain_operation_ids,
        now
      }
    });
    if (!result.replayed) {
      await appendAndEmitPublicEvent(dependencies, operation, {
        eventType: "workspace.activity.ingested",
        roomId: activity.room_id,
        authorizationAction: "execute",
        resources: resourceUsage.map((usage) => usage.resource_ref),
        payload: {
          activity_id: result.activity.id,
          status: result.activity.status,
          source_event_id: input.source_event_id,
          payload_hash: input.payload_hash
        }
      });
    }
    res.status(result.replayed ? 200 : 201).json(apiResponse(req, result.activity, result.replayed));
  }));

  app.post("/api/v1/workspaces/:workspaceId/runs/:runId/actions/:action", authenticateWorkspace, asyncRoute(async (req, res) => {
    const action = RunControlActionSchema.safeParse(pathParam(req, "action"));
    if (!action.success) throw new WorkspaceServerError("run_control_action_invalid", 400);
    const input = parseRunControlRequest(req.body, action.data);
    const operation = operationContext(req);
    const runId = pathParam(req, "runId");
    const execution = await runControlService.execute({
      runtime: runtimeFor(req),
      action: action.data,
      runId,
      roomId: input.context.room_id,
      sessionId: input.context.session_id,
      resumeInput: input.input,
      idempotencyKey: operation.operationId,
      ...(input.input.confirm_unknown === true ? { confirmUnknown: true } : {}),
      onChanged: async ({ action: changedAction, run }) => {
        await appendAndEmitPublicEvent(dependencies, operation, {
          eventType: "workspace.run.changed",
          roomId: run.room_id,
          authorizationAction: "execute",
          resources: [{ kind: "backend_run", id: run.id, uri: `samurai://backend-runs/${run.id}` }],
          payload: { run_id: run.id, status: run.status, action: changedAction }
        });
      }
    });
    res.json(apiResponse(req, execution.result as unknown as JsonValue, execution.replayed));
  }));

  app.get("/api/v1/workspaces/:workspaceId/events", authenticateWorkspace, asyncRoute(async (req, res) => {
    const roomId = optionalQuery(req, "room_id");
    const afterCursor = optionalQuery(req, "after_cursor");
    const limit = queryLimit(req);
    const page = await store.listPublicEvents(workspaceContext(req), {
      ...(roomId ? { roomId } : {}),
      ...(afterCursor ? { afterCursor } : {}),
      ...(limit === undefined ? {} : { limit })
    });
    res.json(toEventReplayPage(page));
  }));

  io.on("connection", (socket) => {
    attachV1SocketHandlers(socket, store, realtimeGate);
  });
}

/**
 * Account-authenticated Organization control-plane API.
 *
 * The Workspace API keeps its existing `/api/v1/workspaces/:workspaceId`
 * boundary. Organization operations are mounted separately so an
 * Organization Owner/Admin cannot accidentally become a Workspace content
 * reader merely by using this API.
 */
function mountOrganizationDomainRoutes(dependencies: V1Dependencies): void {
  const { app, authenticateAccount, asyncRoute } = dependencies;

  const catalog = (_req: Request, res: Response): void => {
    const contracts = operationDefinitions
      .filter((definition) => organizationCatalogOperationIds.has(definition.id) && v1OperationIds.has(definition.id) && definition.sources.includes("runtime_api"))
      .map((definition) => ({
        id: definition.id,
        kind: definition.kind,
        version: definition.version,
        availability: definition.availability,
        input_schema: schemaForPublicContract(definition.input, `${definition.id}.input`),
        output_schema: schemaForPublicContract(
          publicOperationOutputSchemaFor(definition.id, definition.output),
          `${definition.id}.output`
        ),
        idempotency: definition.idempotency,
        concurrency: definition.concurrency,
        sources: [...definition.sources]
      }));
    res.json(DomainApiCatalogSchema.parse({ api_version: "1", contracts, events: eventCatalog, run_controls: runControlCatalog }));
  };

  app.get("/api/v1/domain/catalog", authenticateAccount, asyncRoute(async (req, res) => {
    catalog(req, res);
  }));
  app.get("/api/v1/organizations/:organizationId/domain/catalog", authenticateAccount, asyncRoute(async (req, res) => {
    catalog(req, res);
  }));

  const operationRoute = (withOrganizationIdPath = false) => asyncRoute(async (req, res) => {
    const operationId = pathParam(req, "operationId");
    if (!organizationRouteOperationIds.has(operationId) || !organizationCommandIds.has(operationId)) {
      throw new WorkspaceServerError("domain_operation_not_available", 404, { operation_id: operationId });
    }
    const definition = operationDefinitions.find((candidate) => candidate.id === operationId);
    if (!definition || definition.kind !== "command" || !definition.sources.includes("runtime_api")) {
      throw new WorkspaceServerError("domain_operation_not_available", 404, { operation_id: operationId });
    }
    const request = parseDomainRequest(req.body);
    const input = parseOperationInput(definition, request.input, operationId);
    if (operationId === "workspace.bundle.restore" && !withOrganizationIdPath) assertStandaloneBundleOperationInput(input);
    const organizationIdFromPath = withOrganizationIdPath ? pathParam(req, "organizationId") : undefined;
    const inputOrganizationId = optionalStringField(input, "organization_id");
    if (organizationIdFromPath && inputOrganizationId && inputOrganizationId !== organizationIdFromPath) {
      throw new WorkspaceServerError("organization_id_mismatch", 400);
    }
    const organizationId = organizationIdFromPath ?? inputOrganizationId;
    const operation = dependencies.organizationContext(req, organizationId, { mutation: true });
    const result = operationId === "workspace.bundle.restore" && withOrganizationIdPath
      ? await executeOrganizationBundleRestoreCompatibility({
        organizationId: organizationIdFromPath!,
        bundleId: stringField(input, "bundle_id"),
        // `parseOperationInput` has already validated the literal `true`
        // restore confirmation for this operation.
        confirm: true,
        operation,
        commands: dependencies.commands
      })
      : await executeOrganizationCommandOperation({ operationId, input, operation, commands: dependencies.commands });
    const response = apiResponse(req, publicOperationResult(operationId, result.value, operation.accountId), result.replayed);
    res.status(result.replayed ? 200 : 201).json(response);
  });

  app.post("/api/v1/domain/operations/:operationId", authenticateAccount, operationRoute());
  app.post("/api/v1/organizations/:organizationId/domain/operations/:operationId", authenticateAccount, operationRoute(true));

  const queryRoute = (withOrganizationIdPath = false) => asyncRoute(async (req, res) => {
    const queryId = pathParam(req, "queryId");
    if (!organizationRouteOperationIds.has(queryId) || !organizationQueryIds.has(queryId)) {
      throw new WorkspaceServerError("domain_query_not_available", 404, { query_id: queryId });
    }
    const definition = operationDefinitions.find((candidate) => candidate.id === queryId);
    if (!definition || definition.kind !== "query" || !definition.sources.includes("runtime_api")) {
      throw new WorkspaceServerError("domain_query_not_available", 404, { query_id: queryId });
    }
    const request = parseDomainRequest(req.body);
    const input = parseOperationInput(definition, request.input, queryId);
    const organizationIdFromPath = withOrganizationIdPath ? pathParam(req, "organizationId") : undefined;
    const inputOrganizationId = optionalStringField(input, "organization_id");
    if (organizationIdFromPath && inputOrganizationId && inputOrganizationId !== organizationIdFromPath) {
      throw new WorkspaceServerError("organization_id_mismatch", 400);
    }
    const organizationId = organizationIdFromPath ?? inputOrganizationId;
    const operation = dependencies.organizationContext(req, organizationId, { mutation: false });
    const result = await executeOrganizationQueryOperation({ queryId, input, operation, commands: dependencies.commands });
    res.json(apiResponse(req, publicOperationResult(queryId, result, operation.accountId), false));
  });

  app.post("/api/v1/domain/queries/:queryId", authenticateAccount, queryRoute());
  app.post("/api/v1/organizations/:organizationId/domain/queries/:queryId", authenticateAccount, queryRoute(true));
}

/** The REST and Domain API v1 routes share this command dispatch. */
export async function executeOrganizationCommandOperation(input: {
  operationId: string;
  input: Record<string, unknown>;
  operation: OrganizationApiRequestContext;
  commands: WorkspaceServerCommandService;
}): Promise<{ value: unknown; replayed: boolean }> {
  const { operationId, input: value, operation, commands } = input;
  if (!organizationCommandIds.has(operationId)) {
    throw new WorkspaceServerError("domain_operation_not_available", 404, { operation_id: operationId });
  }
  switch (operationId) {
    case "organization.create": return normalizeOrganizationCommandResult(await commands.createOrganization(operation, value as Parameters<WorkspaceServerCommandService["createOrganization"]>[1]), "organization");
    case "organization.patch": return normalizeOrganizationCommandResult(await commands.patchOrganization(operation, value as unknown as Parameters<WorkspaceServerCommandService["patchOrganization"]>[1]), "organization");
    case "organization.delete": return normalizeOrganizationCommandResult(await commands.deleteOrganization(operation, value as Parameters<WorkspaceServerCommandService["deleteOrganization"]>[1]), "organization");
    case "organization.member.invite": return normalizeOrganizationCommandResult(await commands.inviteOrganizationMember(operation, value as unknown as Parameters<WorkspaceServerCommandService["inviteOrganizationMember"]>[1]));
    case "organization.member.accept": return normalizeOrganizationCommandResult(await commands.acceptOrganizationInvitation(operation, value as Parameters<WorkspaceServerCommandService["acceptOrganizationInvitation"]>[1]));
    case "organization.member.role.change": return normalizeOrganizationCommandResult(await commands.changeOrganizationMemberRole(operation, value as unknown as Parameters<WorkspaceServerCommandService["changeOrganizationMemberRole"]>[1]), "membership");
    case "organization.member.remove": return normalizeOrganizationCommandResult(await commands.removeOrganizationMember(operation, value as Parameters<WorkspaceServerCommandService["removeOrganizationMember"]>[1]), "membership");
    case "organization.member.leave": return normalizeOrganizationCommandResult(await commands.leaveOrganization(operation, value as Parameters<WorkspaceServerCommandService["leaveOrganization"]>[1]), "membership");
    case "organization.invitation.revoke": return normalizeOrganizationCommandResult(await commands.revokeOrganizationInvitation(operation, value as Parameters<WorkspaceServerCommandService["revokeOrganizationInvitation"]>[1]), "invitation");
    case "organization.invitation.reissue": return normalizeOrganizationCommandResult(await commands.reissueOrganizationInvitation(operation, value as Parameters<WorkspaceServerCommandService["reissueOrganizationInvitation"]>[1]));
    case "organization.invitation.extend": return normalizeOrganizationCommandResult(await commands.extendOrganizationInvitation(operation, value as Parameters<WorkspaceServerCommandService["extendOrganizationInvitation"]>[1]), "invitation");
    case "organization.workspace.create": return normalizeOrganizationCommandResult(await commands.createOrganizationWorkspace(operation, value as Parameters<WorkspaceServerCommandService["createOrganizationWorkspace"]>[1]), "workspace");
    case "organization.workspace.member.grant": return normalizeOrganizationCommandResult(await commands.grantOrganizationWorkspaceMembership(operation, value as Parameters<WorkspaceServerCommandService["grantOrganizationWorkspaceMembership"]>[1]), "membership");
    case "organization.workspace.member.revoke": return normalizeOrganizationCommandResult(await commands.revokeOrganizationWorkspaceMembership(operation, value as Parameters<WorkspaceServerCommandService["revokeOrganizationWorkspaceMembership"]>[1]), "membership");
    case "organization.workspace.archive": return normalizeOrganizationCommandResult(await commands.archiveOrganizationWorkspace(operation, value as Parameters<WorkspaceServerCommandService["archiveOrganizationWorkspace"]>[1]), "workspace");
    case "organization.workspace.restore": return normalizeOrganizationCommandResult(await commands.restoreOrganizationWorkspace(operation, value as Parameters<WorkspaceServerCommandService["restoreOrganizationWorkspace"]>[1]), "workspace");
    case "organization.workspace.delete": return normalizeOrganizationCommandResult(await commands.deleteOrganizationWorkspace(operation, value as Parameters<WorkspaceServerCommandService["deleteOrganizationWorkspace"]>[1]), "workspace");
    case "workspace.organization.move.commit": return normalizeOrganizationCommandResult(await commands.commitWorkspaceOrganizationMove(operation, value as unknown as Parameters<WorkspaceServerCommandService["commitWorkspaceOrganizationMove"]>[1]));
    case "workspace.bundle.export": return normalizeOrganizationCommandResult(await commands.exportWorkspaceBundle(operation, value as Parameters<WorkspaceServerCommandService["exportWorkspaceBundle"]>[1]));
    case "workspace.bundle.restore": return normalizeOrganizationCommandResult(await commands.restoreWorkspaceBundle(operation, value as Parameters<WorkspaceServerCommandService["restoreWorkspaceBundle"]>[1]));
    default: throw new WorkspaceServerError("domain_operation_not_available", 404, { operation_id: operationId });
  }
}

/**
 * Preserve the old Organization restore endpoint without restoring directly
 * into that Organization. The first command creates a standalone Workspace;
 * the second command performs the explicit association. A deterministic
 * derived operation ID makes retries safe while keeping both ledger actions
 * independently visible.
 */
export async function executeOrganizationBundleRestoreCompatibility(input: {
  organizationId: string;
  bundleId: string;
  confirm: true;
  operation: OrganizationApiRequestContext;
  commands: WorkspaceServerCommandService;
}): Promise<{ value: unknown; replayed: boolean }> {
  const standaloneOperation: OrganizationApiRequestContext = {
    accountId: input.operation.accountId,
    operationId: input.operation.operationId,
    requestId: input.operation.requestId
  };
  const restored = await executeOrganizationCommandOperation({
    operationId: "workspace.bundle.restore",
    input: { bundle_id: input.bundleId, confirm: input.confirm },
    operation: standaloneOperation,
    commands: input.commands
  });
  const restoredBody = restored.value && typeof restored.value === "object" && !Array.isArray(restored.value)
    ? restored.value as Record<string, unknown>
    : {};
  const workspaceId = typeof restoredBody.workspace_id === "string" ? restoredBody.workspace_id : undefined;
  if (!workspaceId) throw new WorkspaceServerError("workspace_bundle_restore_result_invalid", 500);

  const attachOperation: OrganizationApiRequestContext = {
    ...input.operation,
    operationId: organizationBundleAttachOperationId(input.operation.operationId, input.organizationId, workspaceId),
    organizationId: input.organizationId
  };
  const attached = await input.commands.attachWorkspaceToOrganization(attachOperation, {
    organizationId: input.organizationId,
    workspaceId,
    confirmGuestMemberships: true
  });
  const value = {
    ...restoredBody,
    target_organization_id: input.organizationId
  };
  return { value, replayed: restored.replayed && attached.replayed };
}

function assertStandaloneBundleOperationInput(input: Record<string, unknown>): void {
  if (Object.prototype.hasOwnProperty.call(input, "target_organization_id")) {
    throw new WorkspaceServerError("workspace_bundle_restore_target_organization_requires_attach", 400);
  }
}

function organizationBundleAttachOperationId(operationId: string, organizationId: string, workspaceId: string): string {
  return `workspace_bundle_restore_attach_${createHash("sha256").update(`${operationId}|${organizationId}|${workspaceId}`).digest("hex").slice(0, 40)}`;
}

export async function executeOrganizationQueryOperation(input: {
  queryId: string;
  input: Record<string, unknown>;
  operation: OrganizationApiRequestContext;
  commands: WorkspaceServerCommandService;
}): Promise<unknown> {
  const { queryId, input: value, operation, commands } = input;
  if (!organizationQueryIds.has(queryId)) {
    throw new WorkspaceServerError("domain_query_not_available", 404, { query_id: queryId });
  }
  switch (queryId) {
    case "organization.list": return commands.listOrganizations(operation, value as Parameters<WorkspaceServerCommandService["listOrganizations"]>[1]);
    case "organization.view": return commands.viewOrganization(operation, stringField(value, "organization_id"));
    case "organization.member.list": return commands.listOrganizationMembers(operation, value as Parameters<WorkspaceServerCommandService["listOrganizationMembers"]>[1]);
    case "organization.invitation.list": return commands.listOrganizationInvitations(operation, value as Parameters<WorkspaceServerCommandService["listOrganizationInvitations"]>[1]);
    case "organization.workspace.list": return commands.listOrganizationWorkspaces(operation, value as Parameters<WorkspaceServerCommandService["listOrganizationWorkspaces"]>[1]);
    case "workspace.organization.move.preflight": return commands.preflightWorkspaceOrganizationMove(operation, value as unknown as Parameters<WorkspaceServerCommandService["preflightWorkspaceOrganizationMove"]>[1]);
    case "workspace.organization.move.status": return commands.getWorkspaceOrganizationMoveStatus(operation, stringField(value, "operation_id"));
    default: throw new WorkspaceServerError("domain_query_not_available", 404, { query_id: queryId });
  }
}

function normalizeOrganizationCommandResult(raw: unknown, envelopeKey?: string): { value: unknown; replayed: boolean } {
  const body = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : undefined;
  const replayed = body?.replayed === true;
  if (body && envelopeKey && body[envelopeKey] !== undefined) return { value: body[envelopeKey], replayed };
  if (body && body.result !== undefined) return { value: body.result, replayed };
  return { value: raw, replayed };
}

async function executeCommand(input: {
  operationId: string;
  input: Record<string, unknown>;
  requestContext: { room_id?: string; session_id?: string };
  context: TrustedDomainContext;
  req: Request;
  operation: WorkspaceRequestContext;
  dependencies: V1Dependencies;
}): Promise<{ value: JsonValue; replayed: boolean }> {
  const { operationId, input: value, requestContext, context, req, operation, dependencies } = input;
  const { commands, artifacts, store, realtimeGate, runtimeFor } = dependencies;
  const { workspaceId, accountId } = operation;
  if (operationId === "room.create") {
    const workspace = await store.getWorkspace({ workspaceId, accountId });
    const result = await realtimeGate.run(workspaceId, () => commands.createRoom(operation, {
      name: stringField(value, "name"),
      expectedWorkspaceVersion: workspace.version
    }));
    if (!result.replayed) await appendAndEmitPublicEvent(dependencies, operation, { eventType: "workspace.room.changed", roomId: result.room.id, resources: [resourceRef("room", result.room.id, result.room.name)], payload: { room_id: result.room.id, action: "created" } });
    return { value: roomRecord(result.room), replayed: result.replayed };
  }
  if (operationId === "room.patch") {
    const result = await commands.patchRoom(operation, { id: stringField(value, "id"), name: stringField(value, "name"), ...(numberFieldOptional(value, "expected_version") === undefined ? {} : { expectedVersion: numberFieldOptional(value, "expected_version") }) });
    if (!result.replayed) await appendAndEmitPublicEvent(dependencies, operation, { eventType: "workspace.room.changed", roomId: result.room.id, resources: [resourceRef("room", result.room.id, result.room.name)], payload: { room_id: result.room.id, action: "patched" } });
    return { value: roomRecord(result.room), replayed: result.replayed };
  }
  if (operationId === "agent.create") {
    const result = await commands.registerAgent(operation, {
      displayName: stringField(value, "name"),
      role: stringField(value, "role"),
      instructions: stringField(value, "instructions"),
      backendId: stringField(value, "backend_id"),
      enabled: value.enabled === undefined ? true : booleanField(value, "enabled")
    });
    if (!result.replayed) await appendAndEmitPublicEvent(dependencies, operation, { eventType: "workspace.agent.changed", resources: [resourceRef("agent", result.agent.id, result.agent.displayName)], payload: { agent_id: result.agent.id, action: "created" } });
    return { value: agentRecord(result.agent), replayed: result.replayed };
  }
  if (operationId === "agent.patch") {
    const result = await commands.patchAgent(operation, {
      id: stringField(value, "id"),
      ...(value.name === undefined ? {} : { name: stringField(value, "name") }),
      ...(value.role === undefined ? {} : { role: stringField(value, "role") }),
      ...(value.instructions === undefined ? {} : { instructions: stringField(value, "instructions") }),
      ...(value.enabled === undefined ? {} : { enabled: booleanField(value, "enabled") }),
      ...(numberFieldOptional(value, "expected_version") === undefined ? {} : { expectedVersion: numberFieldOptional(value, "expected_version") })
    });
    if (!result.replayed) await appendAndEmitPublicEvent(dependencies, operation, { eventType: "workspace.agent.changed", resources: [resourceRef("agent", result.agent.id, result.agent.displayName)], payload: { agent_id: result.agent.id, action: "patched" } });
    return { value: agentRecord(result.agent), replayed: result.replayed };
  }
  if (operationId === "agent.backend.bind") {
    const result = await commands.bindAgentBackend(operation, { id: stringField(value, "id"), backendId: stringField(value, "backend_id"), ...(numberFieldOptional(value, "expected_version") === undefined ? {} : { expectedVersion: numberFieldOptional(value, "expected_version") }) });
    if (!result.replayed) await appendAndEmitPublicEvent(dependencies, operation, { eventType: "workspace.agent.changed", resources: [resourceRef("agent", result.agent.id, result.agent.displayName)], payload: { agent_id: result.agent.id, action: "backend_bound" } });
    return { value: agentRecord(result.agent), replayed: result.replayed };
  }
  if (operationId === "session.create") {
    const roomId = requestContext.room_id;
    if (!roomId) throw new WorkspaceServerError("room_id_required", 400);
    const suppliedRoomId = value.room_id;
    if (suppliedRoomId !== undefined && suppliedRoomId !== roomId) throw new WorkspaceServerError("domain_context_mismatch", 400);
    const runtime = runtimeFor(req);
    const session = await createPostgresChatSessionThroughDomainOperation(runtime, {
      workspaceId, accountId, operationId: operation.operationId,
      input: { ...value, room_id: roomId }
    });
    return { value: session as unknown as JsonValue, replayed: false };
  }
  if (operationId === "chat.turn.run") {
    if (!context.sessionId) throw new WorkspaceServerError("session_id_required", 400);
    const runtime = runtimeFor(req);
    const result = await runPostgresChatTurnThroughDomainOperation(runtime, {
      workspaceId, accountId, sessionId: context.sessionId, idempotencyKey: operation.operationId, input: value
    });
    if (!result.backendRun.room_id) throw new WorkspaceServerError("runtime_run_room_missing", 409);
    if (result.backendRun.status !== "queued" && !result.backendRun.completed_at) {
      // An in-flight result is still a durable Run admission, not a success claim.
    }
    const replayed = isReplayResult(result);
    if (!replayed) await appendAndEmitPublicEvent(dependencies, operation, {
      eventType: "workspace.run.changed",
      roomId: result.backendRun.room_id,
      authorizationAction: "execute",
      resources: [{ kind: "backend_run", id: result.backendRun.id, uri: `samurai://backend-runs/${result.backendRun.id}` }],
      payload: { run_id: result.backendRun.id, status: result.backendRun.status, action: "started" }
    });
    const { replayed: _replayed, ...publicResult } = result;
    return { value: publicResult as unknown as JsonValue, replayed };
  }
  if (operationId === "artifact.create") {
    const roomId = requireRoom(requestContext);
    const result = await artifacts.create(operation, { roomId, title: stringField(value, "title"), content: stringField(value, "content"), ...(value.kind === undefined ? {} : { kind: value.kind as never }), ...(value.output_locale === undefined ? {} : { locale: value.output_locale as never }), ...(value.input_locale === undefined ? {} : { sourceLocales: [value.input_locale as never] }), metadata: objectField(value, "metadata") });
    if (!result.replayed) await appendAndEmitPublicEvent(dependencies, operation, { eventType: "workspace.artifact.changed", roomId, resources: [resourceRef("artifact", result.artifact.id, result.artifact.title)], payload: { artifact_id: result.artifact.id, action: "created" } });
    return { value: result as unknown as JsonValue, replayed: result.replayed };
  }
  if (operationId === "artifact.revise") {
    const roomId = requireRoom(requestContext);
    const result = await artifacts.revise(operation, { roomId, artifactId: stringField(value, "artifact_id"), content: stringField(value, "content"), ...(value.base_revision_id === undefined ? {} : { baseRevisionId: stringField(value, "base_revision_id") }), ...(value.expected_revision === undefined ? {} : { expectedRevision: numberField(value, "expected_revision") }), ...(value.editor_source === undefined ? {} : { editorSource: value.editor_source as never }), ...(value.change_summary === undefined ? {} : { changeSummary: stringField(value, "change_summary") }), ...(value.extension === undefined ? {} : { extension: stringField(value, "extension") }), provenance: objectField(value, "provenance") });
    if (!result.replayed) await appendAndEmitPublicEvent(dependencies, operation, { eventType: "workspace.artifact.changed", roomId, resources: [resourceRef("artifact", result.artifact.id, result.artifact.title)], payload: { artifact_id: result.artifact.id, revision_id: result.revision.id, action: "revised" } });
    return { value: result as unknown as JsonValue, replayed: result.replayed };
  }
  if (operationId === "artifact.restore_revision") {
    const roomId = requireRoom(requestContext);
    const result = await artifacts.restoreRevision(operation, { roomId, artifactId: stringField(value, "artifact_id"), revisionId: stringField(value, "revision_id"), ...(value.base_revision_id === undefined ? {} : { baseRevisionId: stringField(value, "base_revision_id") }), ...(value.expected_revision === undefined ? {} : { expectedRevision: numberField(value, "expected_revision") }), ...(value.change_summary === undefined ? {} : { changeSummary: stringField(value, "change_summary") }) });
    if (!result.replayed) await appendAndEmitPublicEvent(dependencies, operation, { eventType: "workspace.artifact.changed", roomId, resources: [resourceRef("artifact", result.artifact.id, result.artifact.title)], payload: { artifact_id: result.artifact.id, revision_id: result.revision.id, action: "restored" } });
    return { value: result as unknown as JsonValue, replayed: result.replayed };
  }
  if (operationId === "artifact.repair") {
    const roomId = requireRoom(requestContext);
    const result = await artifacts.repair(operation, { roomId, artifactId: stringField(value, "artifact_id") });
    if (!result.replayed && result.repair.repaired) await appendAndEmitPublicEvent(dependencies, operation, { eventType: "workspace.artifact.changed", roomId, resources: [resourceRef("artifact", result.artifact.id, result.artifact.title)], payload: { artifact_id: result.artifact.id, action: "repaired" } });
    return { value: result as unknown as JsonValue, replayed: result.replayed };
  }
  if (operationId === "workspace.bundle.export") {
    const result = await commands.exportWorkspaceBundle(
      operation as unknown as Parameters<WorkspaceServerCommandService["exportWorkspaceBundle"]>[0],
      value as Parameters<WorkspaceServerCommandService["exportWorkspaceBundle"]>[1]
    );
    const normalized = normalizeOrganizationCommandResult(result);
    return { value: normalized.value as JsonValue, replayed: normalized.replayed };
  }
  if (operationId === "workspace.bundle.restore") {
    const result = await commands.restoreWorkspaceBundle(
      operation as unknown as Parameters<WorkspaceServerCommandService["restoreWorkspaceBundle"]>[0],
      value as Parameters<WorkspaceServerCommandService["restoreWorkspaceBundle"]>[1]
    );
    const normalized = normalizeOrganizationCommandResult(result);
    return { value: normalized.value as JsonValue, replayed: normalized.replayed };
  }
  throw new WorkspaceServerError("domain_operation_not_available", 404, { operation_id: operationId });
}

async function executeQuery(
  queryId: string,
  input: Record<string, unknown>,
  requestContext: { room_id?: string; session_id?: string },
  context: TrustedDomainContext,
  dependencies: V1Dependencies
): Promise<JsonValue> {
  const { store, artifacts } = dependencies;
  if (queryId === "room.list") return (await store.listRooms({ workspaceId: context.workspaceId, accountId: context.actorId })).map(roomRecord) as unknown as JsonValue;
  if (queryId === "room.view") return roomRecord(await store.getRoom({ workspaceId: context.workspaceId, accountId: context.actorId }, stringField(input, "id")));
  if (queryId === "agent.list") return (await store.listAgents({ workspaceId: context.workspaceId, accountId: context.actorId })).map(agentRecord) as unknown as JsonValue;
  if (queryId === "agent.view") return agentRecord(await store.getAgent({ workspaceId: context.workspaceId, accountId: context.actorId }, stringField(input, "id")));
  const roomId = requireRoom(requestContext);
  if (queryId === "artifact.list") return await artifacts.list({ workspaceId: context.workspaceId, accountId: context.actorId }, roomId) as unknown as JsonValue;
  if (queryId === "artifact.view") return await artifacts.get({ workspaceId: context.workspaceId, accountId: context.actorId }, roomId, stringField(input, "id")) as unknown as JsonValue;
  throw new WorkspaceServerError("domain_query_not_available", 404, { query_id: queryId });
}

async function appendAndEmitPublicEvent(
  dependencies: V1Dependencies,
  context: WorkspaceRequestContext,
  input: {
    eventType: string;
    roomId?: string;
    resources?: ResourceRef[];
    authorizationAction?: "edit" | "execute";
    payload: Record<string, unknown>;
  }
): Promise<void> {
  const saved = await dependencies.commands.appendPublicEvent(context, {
    eventType: input.eventType,
    roomId: input.roomId,
    actor: { kind: "human", id: context.accountId },
    ...(input.resources ? { resources: input.resources } : {}),
    ...(input.authorizationAction ? { authorizationAction: input.authorizationAction } : {}),
    operationId: context.operationId,
    correlationId: context.caller?.kind === "human" ? context.caller.requestId : context.operationId,
    payload: eventPayloadSchemaFor(input.eventType).parse(input.payload) as Record<string, unknown>
  });
  if (saved.replayed) return;
  await dependencies.realtimeGate.run(context.workspaceId, async () => {
    await emitAuthorizedV1Event(dependencies.io, dependencies.store, saved.event);
  });
}

function attachV1SocketHandlers(socket: Socket, store: WorkspaceServerStore, realtimeGate: WorkspaceRealtimeGate): void {
  const identity = socket.data.samurai as { workspaceId: string; accountId: string };
  socket.on("workspace:v1:subscribe", async (input: unknown, acknowledge?: (result: unknown) => void) => {
    try {
      const body = objectInput(input);
      const roomId = optionalString(body, "room_id");
      await realtimeGate.run(identity.workspaceId, async () => {
        if (roomId) {
          await store.assertRoomReadable(identity, roomId);
          socket.join(v1RoomSocketRoom(identity.workspaceId, roomId));
        } else {
          await store.getWorkspace(identity);
          socket.join(v1WorkspaceSocketRoom(identity.workspaceId));
        }
      });
      acknowledge?.({ ok: true });
    } catch (error) {
      acknowledge?.({ ok: false, error: safeSocketError(error) });
    }
  });
  socket.on("workspace:v1:resync", async (input: unknown, acknowledge?: (result: unknown) => void) => {
    try {
      const body = objectInput(input);
      const roomId = optionalString(body, "room_id");
      const afterCursor = optionalString(body, "after_cursor");
      const limit = body.limit === undefined ? undefined : numberField(body, "limit");
      const page = await realtimeGate.run(identity.workspaceId, () => store.listPublicEvents(identity, {
        ...(roomId ? { roomId } : {}),
        ...(afterCursor ? { afterCursor } : {}),
        ...(limit === undefined ? {} : { limit })
      }));
      acknowledge?.({ ok: true, ...toEventReplayPage(page) });
    } catch (error) {
      acknowledge?.({ ok: false, error: safeSocketError(error) });
    }
  });
}

async function emitAuthorizedV1Event(io: SocketServer, store: WorkspaceServerStore, event: WorkspacePublicEvent): Promise<void> {
  const envelope = toEventEnvelope(event);
  const subscribedSocketIds = new Set<string>();
  if (event.scope.roomId) {
    for (const room of [v1WorkspaceSocketRoom(event.scope.workspaceId), v1RoomSocketRoom(event.scope.workspaceId, event.scope.roomId)]) {
      for (const socketId of io.sockets.adapter.rooms.get(room) ?? []) subscribedSocketIds.add(socketId);
    }
  } else {
    for (const socketId of io.sockets.adapter.rooms.get(v1WorkspaceSocketRoom(event.scope.workspaceId)) ?? []) subscribedSocketIds.add(socketId);
  }
  for (const socketId of subscribedSocketIds) {
    const socket = io.sockets.sockets.get(socketId);
    if (!socket) continue;
    const identity = socket.data.samurai as { workspaceId?: string; accountId?: string } | undefined;
    if (identity?.workspaceId !== event.scope.workspaceId || !identity.accountId) continue;
    try {
      if (event.scope.roomId) {
        const delivered = await store.deliverRoomRealtimeIfReadable(
          { workspaceId: event.scope.workspaceId, accountId: identity.accountId },
          event.scope.roomId,
          () => { socket.emit("workspace:v1:event", envelope); }
        );
        if (!delivered) socket.leave(v1RoomSocketRoom(event.scope.workspaceId, event.scope.roomId));
      } else {
        await store.getWorkspace({ workspaceId: event.scope.workspaceId, accountId: identity.accountId });
        socket.emit("workspace:v1:event", envelope);
      }
    } catch {
      socket.disconnect(true);
    }
  }
}

function parseDomainRequest(value: unknown): { context: { room_id?: string; session_id?: string }; input: JsonValue } {
  const parsed = DomainApiRequestSchema.safeParse(value);
  if (!parsed.success) throw new WorkspaceServerError("domain_api_request_invalid", 400, { issue: safeIssue(parsed.error.issues[0]) });
  return parsed.data;
}

function parseActivityRequest(value: unknown) {
  const parsed = ActivityIngestRequestSchema.safeParse(value);
  if (!parsed.success) throw new WorkspaceServerError("activity_ingest_invalid", 400, { issue: safeIssue(parsed.error.issues[0]) });
  return parsed.data;
}

function parseRunControlRequest(value: unknown, action: z.infer<typeof RunControlActionSchema>) {
  const common = RunControlInputSchema.safeParse(value);
  if (!common.success) throw new WorkspaceServerError("run_control_request_invalid", 400, { issue: safeIssue(common.error.issues[0]) });
  const parsed = runControlRequestSchemaFor(action).safeParse(common.data);
  if (!parsed.success) throw new WorkspaceServerError("run_control_request_invalid", 400, { issue: safeIssue(parsed.error.issues[0]) });
  return common.data;
}

function parseOperationInput(definition: (typeof operationDefinitions)[number], value: JsonValue, operationId: string): Record<string, unknown> {
  const parsed = definition.input.safeParse(value);
  if (!parsed.success || !parsed.data || typeof parsed.data !== "object" || Array.isArray(parsed.data)) {
    throw new WorkspaceServerError("domain_api_input_invalid", 400, { operation_id: operationId, issue: safeIssue(parsed.success ? undefined : parsed.error.issues[0]) });
  }
  return parsed.data as Record<string, unknown>;
}

function trustedContext(
  base: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">,
  selection: { room_id?: string; session_id?: string },
  operationId?: string,
  correlationId = "domain_api"
): TrustedDomainContext {
  return {
    inputSource: "runtime_api",
    workspaceId: base.workspaceId,
    actorId: base.accountId,
    correlationId,
    ...(operationId ? { idempotencyKey: operationId } : {}),
    ...(selection.room_id ? { roomId: selection.room_id } : {}),
    ...(selection.session_id ? { sessionId: selection.session_id } : {})
  };
}

function apiResponse(req: Request, result: JsonValue, replayed: boolean): DomainApiResponse {
  return DomainApiResponseSchema.parse({ api_version: "1", request_id: requestIdFromRequest(req), result, replayed });
}

export function publicOperationResult(operationId: string, result: unknown, accountId?: string): JsonValue {
  const definition = operationDefinitions.find((candidate) => candidate.id === operationId);
  if (!definition) throw new WorkspaceServerError("domain_operation_not_available", 404, { operation_id: operationId });
  const outputSchema = publicOperationOutputSchemaFor(operationId, definition.output);
  const alreadyPublic = outputSchema.safeParse(result);
  if (alreadyPublic.success) return alreadyPublic.data as JsonValue;
  const projected = organizationRouteOperationIds.has(operationId)
    ? normalizeOrganizationValue(operationId, result, accountId)
    : result;
  return outputSchema.parse(projected) as JsonValue;
}

/** Normalize the account directory once for every transport.  The Store uses
 * camelCase internal records; this projection is the stable snake_case API
 * contract and intentionally excludes storage paths and Room content. */
export function publicWorkspaceDirectory(value: unknown, accountId?: string): JsonValue {
  const body = recordValue(value);
  const workspaces = listValue(value, "workspaces").map((entry) => workspaceSummaryRecord(entry, accountId));
  const errors = Array.isArray(body.errors)
    ? body.errors.map((entry) => {
      const error = recordValue(entry);
      return compactRecord({
        connection_id: optionalValue(error, "connection_id", "connectionId"),
        code: valueString(error, "code") || "workspace_directory_request_failed",
        message: valueString(error, "message") || "Workspace directory request failed."
      });
    })
    : undefined;
  return PublicWorkspaceDirectorySchema.parse({
    workspaces,
    ...(errors ? { errors } : {})
  }) as JsonValue;
}

/** Normalize the explicit Organization association result.  This helper is
 * shared by REST and Domain API callers so attach/detach cannot drift in
 * field naming or accidentally expose Workspace content. */
export function publicWorkspaceOrganizationAssociationResult(value: unknown, accountId?: string): JsonValue {
  const body = recordValue(value);
  return PublicWorkspaceOrganizationAssociationResultSchema.parse(compactRecord({
    workspace: workspaceRecord(body.workspace ?? value, accountId),
    organization_id: optionalValue(body, "organization_id", "organizationId"),
    previous_organization_id: optionalValue(body, "previous_organization_id", "previousOrganizationId"),
    added_guest_account_ids: Array.isArray(body.added_guest_account_ids)
      ? body.added_guest_account_ids
      : Array.isArray(body.addedGuestAccountIds) ? body.addedGuestAccountIds : [],
    event_id: optionalValue(body, "event_id", "eventId")
  })) as JsonValue;
}

/** Project only the restart-safe transfer checkpoints.  Bundle paths, raw
 * receipts, and any credential-shaped fields are intentionally not copied
 * from the Store result into the public response. */
export function publicWorkspaceTransferStatus(value: unknown): JsonValue {
  const body = recordValue(value);
  const transferId = valueString(body, "transfer_id", "transferId", "id");
  const state = valueString(body, "state");
  const sourceWorkspaceState = valueString(body, "source_workspace_state", "sourceWorkspaceState");
  const transferStates = new Set([
    "preparing", "exported", "imported", "committed", "rolled_back", "failed",
    "restoring", "verified", "cutover", "source_retained", "source_deleted"
  ]);
  const workspaceStates = new Set(["active", "read_only", "archived", "deleted"]);
  if (!transferId || !transferStates.has(state) || !workspaceStates.has(sourceWorkspaceState)) {
    throw new WorkspaceServerError("workspace_transfer_status_invalid", 500);
  }
  return {
    transfer_id: transferId,
    state,
    source_integrity_hash: nullableSha256(body, "source_integrity_hash", "sourceIntegrityHash", "bundle_hash", "bundleHash"),
    target_integrity_hash: nullableSha256(body, "target_integrity_hash", "targetIntegrityHash"),
    target_workspace_id: optionalValue(body, "target_workspace_id", "targetWorkspaceId") ?? null,
    receipt_present: booleanValue(body, "receipt_present", "receiptPresent"),
    source_workspace_state: sourceWorkspaceState,
    source_archived: sourceWorkspaceState === "archived" || sourceWorkspaceState === "deleted"
  } as JsonValue;
}

/**
 * Convert the internal camelCase Core projection to the snake_case public
 * contract.  The adapter accepts an already-public value too; this keeps the
 * transport stable while Core implementations migrate from internal records.
 */
function normalizeOrganizationValue(operationId: string, value: unknown, accountId?: string): unknown {
  switch (operationId) {
    case "organization.list": return listValue(value, "organizations").map((entry) => organizationRecord(entry));
    case "organization.view": return organizationRecord(value);
    case "organization.create":
    case "organization.patch":
    case "organization.delete": return organizationRecord(value);
    case "organization.member.list": return listValue(value, "members").map((entry) => membershipRecord(entry));
    case "organization.member.invite":
    case "organization.invitation.reissue": return invitationIssueResult(value);
    case "organization.member.accept": {
      const body = recordValue(value);
      const organizationId = valueString(body, "organization_id", "organizationId");
      const acceptedAccountId = valueString(body, "account_id", "accountId") || accountId;
      return {
        membership: membershipRecord(body.membership ?? {
          id: valueString(body, "membership_id", "membershipId") || `${valueString(body, "organization_id", "organizationId")}:${valueString(body, "account_id", "accountId")}`,
          organization_id: organizationId,
          account_id: acceptedAccountId,
          role: valueString(body, "role") || "member",
          state: "active",
          version: numberValue(body, "version") ?? 1,
          joined_at: valueString(body, "joined_at", "joinedAt") || new Date().toISOString(),
          created_by: valueString(body, "created_by", "createdBy") || acceptedAccountId,
          updated_by: valueString(body, "updated_by", "updatedBy") || acceptedAccountId,
          updated_at: valueString(body, "updated_at", "updatedAt") || new Date().toISOString()
        }),
        workspace_grants: listValue(body.workspace_grants ?? body.workspaceGrants, "workspace_grants").map((entry) => workspaceMembershipRecord({
          ...recordValue(entry),
          organization_id: valueString(recordValue(entry), "organization_id", "organizationId") || organizationId,
          account_id: valueString(recordValue(entry), "account_id", "accountId") || acceptedAccountId,
          version: numberValue(recordValue(entry), "version") ?? 1
        }, { organizationId, accountId: acceptedAccountId }))
      };
    }
    case "organization.member.role.change":
    case "organization.member.remove":
    case "organization.member.leave": return membershipRecord(value);
    case "organization.invitation.list": return listValue(value, "invitations").map(invitationRecord);
    case "organization.invitation.revoke":
    case "organization.invitation.extend": return invitationRecord(value);
    case "organization.workspace.list": return listValue(value, "workspaces").map((entry) => workspaceRecord(entry, accountId));
    case "organization.workspace.create":
    case "organization.workspace.archive":
    case "organization.workspace.restore":
    case "organization.workspace.delete": return workspaceRecord(value, accountId);
    case "organization.workspace.member.grant":
    case "organization.workspace.member.revoke": return workspaceMembershipRecord(value);
    case "workspace.organization.move.preflight": return workspaceMovePreflight(value);
    case "workspace.organization.move.commit": return workspaceMoveResult(value);
    case "workspace.organization.move.status": return workspaceMoveStatus(value);
    case "workspace.bundle.export": return workspaceBundleExportResult(value);
    case "workspace.bundle.restore": return workspaceBundleRestoreResult(value);
    default: return value;
  }
}

function organizationRecord(value: unknown): Record<string, unknown> {
  const body = nestedRecord(value, "organization");
  const deletedAt = optionalValue(body, "deleted_at", "deletedAt");
  const state = stringValue(body, "status", "state");
  return compactRecord({
    id: valueString(body, "id", "organization_id", "organizationId"),
    name: valueString(body, "name"),
    icon: optionalValue(body, "icon"),
    description: optionalValue(body, "description"),
    status: state === "deleted" || deletedAt ? "deleted" : "active",
    version: numberValue(body, "version"),
    created_by: valueString(body, "created_by", "createdBy"),
    created_at: valueString(body, "created_at", "createdAt"),
    updated_at: valueString(body, "updated_at", "updatedAt"),
    deleted_at: deletedAt
  });
}

function membershipRecord(value: unknown, fallback: { organizationId?: string; accountId?: string } = {}): Record<string, unknown> {
  const body = nestedRecord(value, "membership", "member");
  const organizationId = valueString(body, "organization_id", "organizationId") || fallback.organizationId || "";
  const accountId = valueString(body, "account_id", "accountId") || fallback.accountId || "";
  const state = stringValue(body, "state");
  const joinedAt = valueString(body, "joined_at", "joinedAt");
  const updatedAt = valueString(body, "updated_at", "updatedAt", "removed_at", "removedAt") || joinedAt || new Date().toISOString();
  return compactRecord({
    id: valueString(body, "id") || `${organizationId}:${accountId}`,
    organization_id: organizationId,
    account_id: accountId,
    role: valueString(body, "role") || "member",
    state: state === "removed" || state === "revoked" ? "removed" : "active",
    version: numberValue(body, "version") ?? 1,
    joined_at: joinedAt || updatedAt,
    removed_at: optionalValue(body, "removed_at", "removedAt"),
    created_by: valueString(body, "created_by", "createdBy") || accountId,
    updated_by: optionalValue(body, "updated_by", "updatedBy"),
    display_name: optionalValue(body, "display_name", "displayName"),
    updated_at: updatedAt
  });
}

function invitationIssueResult(value: unknown): Record<string, unknown> {
  const body = recordValue(value);
  return compactRecord({
    invitation: invitationRecord(body.invitation ?? value),
    one_time_token: optionalValue(body, "one_time_token", "oneTimeToken", "token")
  });
}

function invitationRecord(value: unknown): Record<string, unknown> {
  const body = nestedRecord(value, "invitation");
  const revokedAt = optionalValue(body, "revoked_at", "revokedAt");
  const acceptedAt = optionalValue(body, "accepted_at", "acceptedAt");
  const explicitStatus = stringValue(body, "status", "state");
  const expiresAt = valueString(body, "expires_at", "expiresAt");
  const status = explicitStatus === "accepted" || explicitStatus === "revoked" || explicitStatus === "expired"
    ? explicitStatus
    : acceptedAt ? "accepted" : revokedAt ? "revoked" : (expiresAt && Date.parse(expiresAt) <= Date.now() ? "expired" : "pending");
  return compactRecord({
    id: valueString(body, "id", "invitation_id", "invitationId"),
    organization_id: valueString(body, "organization_id", "organizationId"),
    target_account_id: optionalValue(body, "target_account_id", "targetAccountId", "recipient_account_id"),
    role: valueString(body, "role") || "member",
    status,
    expires_at: expiresAt,
    accepted_at: acceptedAt,
    revoked_at: revokedAt,
    issued_by: valueString(body, "issued_by", "issuedBy"),
    version: numberValue(body, "version"),
    created_at: valueString(body, "created_at", "createdAt"),
    updated_at: valueString(body, "updated_at", "updatedAt")
  });
}

function workspaceRecord(value: unknown, accountId?: string): Record<string, unknown> {
  const body = nestedRecord(value, "workspace");
  const state = stringValue(body, "state");
  return compactRecord({
    id: valueString(body, "id", "workspace_id", "workspaceId"),
    organization_id: optionalValue(body, "organization_id", "organizationId"),
    name: valueString(body, "name"),
    state: state === "archived" || state === "deleted" ? state : "active",
    version: numberValue(body, "version"),
    created_by: valueString(body, "created_by", "createdBy", "owner_account_id", "ownerAccountId") || accountId,
    created_at: valueString(body, "created_at", "createdAt"),
    updated_at: valueString(body, "updated_at", "updatedAt"),
    deleted_at: optionalValue(body, "deleted_at", "deletedAt"),
    can_access: booleanValue(body, "can_access", "canAccess", "has_access", "hasAccess"),
    role: optionalValue(body, "role", "workspace_role", "workspaceRole")
  });
}

function workspaceSummaryRecord(value: unknown, accountId?: string): Record<string, unknown> {
  const body = nestedRecord(value, "workspace");
  const state = stringValue(body, "state");
  const role = optionalValue(body, "role", "workspace_role", "workspaceRole");
  const access = optionalValue(body, "access")
    ?? (typeof body.can_access === "boolean" ? (body.can_access ? "granted" : "none") : undefined)
    ?? (typeof body.hasAccess === "boolean" ? (body.hasAccess ? "granted" : "none") : role ? "granted" : undefined);
  return compactRecord({
    id: valueString(body, "id", "workspace_id", "workspaceId"),
    organization_id: optionalValue(body, "organization_id", "organizationId"),
    name: valueString(body, "name"),
    state: state === "archived" || state === "deleted" || state === "read_only" ? state : "active",
    version: numberValue(body, "version") ?? 0,
    hosting_mode: optionalValue(body, "hosting_mode", "hostingMode"),
    database_placement: optionalValue(body, "database_placement", "databasePlacement"),
    role,
    access,
    created_by: optionalValue(body, "created_by", "createdBy", "owner_account_id", "ownerAccountId") ?? accountId,
    created_at: optionalValue(body, "created_at", "createdAt"),
    updated_at: optionalValue(body, "updated_at", "updatedAt")
  });
}

function workspaceMembershipRecord(value: unknown, fallback: { organizationId?: string; accountId?: string } = {}): Record<string, unknown> {
  const body = nestedRecord(value, "membership", "workspaceMembership");
  const organizationId = optionalValue(body, "organization_id", "organizationId") ?? fallback.organizationId;
  const workspaceId = valueString(body, "workspace_id", "workspaceId");
  const accountId = valueString(body, "account_id", "accountId") || fallback.accountId || "";
  const joinedAt = valueString(body, "joined_at", "joinedAt") || new Date().toISOString();
  return compactRecord({
    id: valueString(body, "id") || `${workspaceId}:${accountId}`,
    organization_id: organizationId,
    workspace_id: workspaceId,
    account_id: accountId,
    role: valueString(body, "role", "workspace_role", "workspaceRole") || "guest",
    state: stringValue(body, "state") === "revoked" ? "revoked" : "active",
    version: numberValue(body, "version") ?? 1,
    joined_at: joinedAt,
    revoked_at: optionalValue(body, "revoked_at", "revokedAt"),
    created_by: valueString(body, "created_by", "createdBy") || accountId,
    updated_by: optionalValue(body, "updated_by", "updatedBy"),
    updated_at: valueString(body, "updated_at", "updatedAt") || joinedAt
  });
}

function workspaceMovePreflight(value: unknown): Record<string, unknown> {
  const body = recordValue(value);
  const members = listValue(body.members ?? body.existing_members, "members");
  const missingIds = new Set(listValue(body.missing_target_memberships ?? body.missingTargetMemberships, "missing_target_memberships").map((entry) => typeof entry === "string" ? entry : valueString(recordValue(entry), "account_id", "accountId")));
  const mapMember = (entry: unknown, forceGuest: boolean): Record<string, unknown> => {
    const member = recordValue(entry);
    const accountId = valueString(member, "account_id", "accountId");
    return compactRecord({
      account_id: accountId,
      workspace_role: valueString(member, "workspace_role", "current_workspace_role", "currentWorkspaceRole", "role") || "guest",
      target_organization_role: optionalValue(member, "target_organization_role", "targetOrganizationRole"),
      will_add_as_guest: forceGuest || missingIds.has(accountId)
    });
  };
  const existing = members.filter((entry) => !missingIds.has(valueString(recordValue(entry), "account_id", "accountId"))).map((entry) => mapMember(entry, false));
  const missing = members.filter((entry) => missingIds.has(valueString(recordValue(entry), "account_id", "accountId"))).map((entry) => mapMember(entry, true));
  for (const accountId of missingIds) if (!missing.some((entry) => entry.account_id === accountId)) missing.push({ account_id: accountId, workspace_role: "guest", will_add_as_guest: true });
  return compactRecord({
    operation_id: valueString(body, "operation_id", "operationId"),
    source_organization_id: optionalValue(body, "source_organization_id", "sourceOrganizationId"),
    target_organization_id: optionalValue(body, "target_organization_id", "targetOrganizationId"),
    workspace_id: valueString(body, "workspace_id", "workspaceId"),
    workspace_version: numberValue(body, "workspace_version", "workspaceVersion", "expected_workspace_version", "expectedWorkspaceVersion"),
    workspace_state: valueString(body, "workspace_state", "workspaceState", "state") || "active",
    existing_members: existing,
    missing_members: missing,
    requires_guest_confirmation: booleanValue(body, "requires_guest_confirmation", "requiresGuestConfirmation"),
    write_blocked: typeof body.write_blocked === "boolean"
      ? body.write_blocked
      : typeof body.writeBlocked === "boolean" ? body.writeBlocked : body.allowed === false,
    failure_conditions: listValue(body.failure_conditions ?? body.failureConditions, "failure_conditions").filter((entry): entry is string => typeof entry === "string"),
    expires_at: valueString(body, "expires_at", "expiresAt"),
    created_at: valueString(body, "created_at", "createdAt")
  });
}

function workspaceMoveResult(value: unknown): Record<string, unknown> {
  const body = recordValue(value);
  const workspace = recordValue(body.workspace);
  return compactRecord({
    operation_id: valueString(body, "operation_id", "operationId"),
    workspace_id: valueString(body, "workspace_id", "workspaceId") || valueString(workspace, "id", "workspace_id", "workspaceId"),
    source_organization_id: optionalValue(body, "source_organization_id", "sourceOrganizationId"),
    target_organization_id: optionalValue(body, "target_organization_id", "targetOrganizationId") ?? optionalValue(workspace, "organization_id", "organizationId"),
    status: valueString(body, "status") || "committed",
    guest_membership_account_ids: listValue(body.guest_membership_account_ids ?? body.added_guest_account_ids ?? body.addedGuestAccountIds, "guest_membership_account_ids").filter((entry): entry is string => typeof entry === "string"),
    event_id: optionalValue(body, "event_id", "eventId"),
    committed_at: optionalValue(body, "committed_at", "committedAt"),
    failure_code: optionalValue(body, "failure_code", "failureCode")
  });
}

function workspaceMoveStatus(value: unknown): Record<string, unknown> {
  const body = recordValue(value);
  return { ...workspaceMoveResult(body), updated_at: valueString(body, "updated_at", "updatedAt") };
}

function workspaceBundleExportResult(value: unknown): Record<string, unknown> {
  const body = recordValue(value);
  const manifest = recordValue(body.manifest);
  return compactRecord({
    bundle_id: valueString(body, "bundle_id", "bundleId", "id"),
    workspace_id: valueString(body, "workspace_id", "workspaceId"),
    source_organization_id: optionalValue(body, "source_organization_id", "sourceOrganizationId"),
    schema_version: numberValue(body, "schema_version", "schemaVersion", "format_version"),
    integrity_hash: valueString(body, "integrity_hash", "integrityHash", "sha256"),
    file_count: numberValue(body, "file_count", "fileCount"),
    byte_size: numberValue(body, "byte_size", "byteSize"),
    manifest: compactRecord({
      schema_version: numberValue(manifest, "schema_version", "schemaVersion"),
      workspace_id: valueString(manifest, "workspace_id", "workspaceId"),
      source_organization_id: optionalValue(manifest, "source_organization_id", "sourceOrganizationId"),
      integrity_hash: valueString(manifest, "integrity_hash", "integrityHash", "sha256"),
      record_counts: recordValue(manifest.record_counts ?? manifest.recordCounts)
    }),
    created_at: valueString(body, "created_at", "createdAt")
  });
}

function workspaceBundleRestoreResult(value: unknown): Record<string, unknown> {
  const body = recordValue(value);
  return compactRecord({
    bundle_id: valueString(body, "bundle_id", "bundleId", "id"),
    workspace_id: valueString(body, "workspace_id", "workspaceId"),
    source_organization_id: optionalValue(body, "source_organization_id", "sourceOrganizationId"),
    target_organization_id: optionalValue(body, "target_organization_id", "targetOrganizationId"),
    schema_version: numberValue(body, "schema_version", "schemaVersion", "format_version"),
    integrity_hash: valueString(body, "integrity_hash", "integrityHash", "sha256"),
    status: valueString(body, "status") || "restored",
    restored_at: valueString(body, "restored_at", "restoredAt", "created_at", "createdAt"),
    event_id: optionalValue(body, "event_id", "eventId"),
    failure_code: optionalValue(body, "failure_code", "failureCode")
  });
}

function listValue(value: unknown, key: string): unknown[] {
  if (Array.isArray(value)) return value;
  const body = recordValue(value);
  return Array.isArray(body[key]) ? body[key] : [];
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function nestedRecord(value: unknown, ...keys: string[]): Record<string, unknown> {
  const body = recordValue(value);
  for (const key of keys) {
    const nested = body[key];
    if (nested && typeof nested === "object" && !Array.isArray(nested)) return nested as Record<string, unknown>;
  }
  return body;
}

function valueString(body: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) if (typeof body[key] === "string" && body[key].trim()) return body[key] as string;
  return "";
}

function optionalValue(body: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) if (body[key] !== undefined && body[key] !== null && body[key] !== "") return body[key];
  return undefined;
}

function numberValue(body: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) if (typeof body[key] === "number" && Number.isFinite(body[key])) return body[key] as number;
  return undefined;
}

function nullableSha256(body: Record<string, unknown>, ...keys: string[]): string | null {
  const value = valueString(body, ...keys);
  return /^[a-f0-9]{64}$/.test(value) ? value : null;
}

function booleanValue(body: Record<string, unknown>, ...keys: string[]): boolean {
  for (const key of keys) if (typeof body[key] === "boolean") return body[key] as boolean;
  return false;
}

function stringValue(body: Record<string, unknown>, ...keys: string[]): string {
  return valueString(body, ...keys);
}

function compactRecord(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function toEventReplayPage(page: WorkspacePublicEventPage): EventReplayPage {
  return EventReplayPageSchema.parse({
    events: page.events.map(toEventEnvelope),
    ...(page.nextCursor ? { next_cursor: page.nextCursor } : {}),
    has_more: page.hasMore
  });
}

function toEventEnvelope(event: WorkspacePublicEvent): PublicEventEnvelope {
  return PublicEventEnvelopeSchema.parse({
    event_id: event.eventId,
    event_type: event.eventType,
    event_version: event.eventVersion,
    cursor: event.cursor,
    occurred_at: event.occurredAt,
    actor: event.actor,
    scope: {
      workspace_id: event.scope.workspaceId,
      ...(event.scope.organizationId ? { organization_id: event.scope.organizationId } : {}),
      ...(event.scope.roomId ? { room_id: event.scope.roomId } : {})
    },
    resources: event.resources,
    ...(event.operationId ? { operation_id: event.operationId } : {}),
    ...(event.correlationId ? { correlation_id: event.correlationId } : {}),
    payload: parsePublicEventPayload(event.eventType, event.payload)
  });
}

function roomRecord(room: { id: string; workspaceId: string; parentRoomId?: string; name: string; version: number; canManage?: boolean; canExecute?: boolean; createdAt: string; updatedAt: string }): JsonValue {
  return PublicRoomRecordSchema.parse({
    id: room.id,
    workspace_id: room.workspaceId,
    ...(room.parentRoomId ? { parent_room_id: room.parentRoomId } : {}),
    name: room.name,
    version: room.version,
    ...(room.canManage === undefined ? {} : { can_manage: room.canManage }),
    ...(room.canExecute === undefined ? {} : { can_execute: room.canExecute }),
    created_at: room.createdAt,
    updated_at: room.updatedAt
  });
}

function agentRecord(agent: { workspaceId: string; id: string; displayName: string; description: string; role?: string; instructions?: string; backendId: string; enabled?: boolean; status: string; version: number; createdBy: string; createdAt: string; updatedAt: string }): JsonValue {
  return PublicAgentRecordSchema.parse({
    id: agent.id,
    workspace_id: agent.workspaceId,
    name: agent.displayName,
    description: agent.description,
    role: agent.role ?? "workspace_agent",
    instructions: agent.instructions ?? agent.displayName,
    backend_id: agent.backendId,
    enabled: agent.enabled ?? agent.status === "active",
    status: agent.status,
    version: agent.version,
    created_by: agent.createdBy,
    created_at: agent.createdAt,
    updated_at: agent.updatedAt
  });
}

function resourceRef(kind: string, id: string, label: string): ResourceRef {
  return ResourceRefSchema.parse({ kind, id, uri: `samurai://${kind}/${id}`, label });
}

function pathParam(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== "string" || !value.trim()) throw new WorkspaceServerError(`${name}_required`, 400);
  return value;
}

function optionalQuery(req: Request, name: string): string | undefined {
  const value = req.query[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new WorkspaceServerError(`${name}_invalid`, 400);
  return value;
}

function queryLimit(req: Request): number | undefined {
  const value = optionalQuery(req, "limit");
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 500) throw new WorkspaceServerError("limit_invalid", 400);
  return parsed;
}

function requireRoom(context: { room_id?: string }): string {
  if (!context.room_id) throw new WorkspaceServerError("room_id_required", 400);
  return context.room_id;
}

function activityStatus(outcome: "completed" | "failed" | "cancelled" | "unknown" | "not_run"): Exclude<ActivityRecord["status"], "recording"> {
  if (outcome === "completed") return "completed";
  if (outcome === "failed") return "failed";
  if (outcome === "cancelled") return "cancelled";
  return "outcome_unknown";
}

function deterministicActivityId(workspaceId: string, roomId: string, dedupeKey: string): string {
  return `activity_${createHash("sha256").update(`${workspaceId}|${roomId}|${dedupeKey}`).digest("hex").slice(0, 48)}`;
}

function isReplayResult(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && (value as { replayed?: unknown }).replayed === true);
}

function stringField(value: Record<string, unknown>, name: string): string {
  if (typeof value[name] !== "string" || !value[name].trim()) throw new WorkspaceServerError(`${name}_required`, 400);
  return value[name] as string;
}

function optionalStringField(value: Record<string, unknown>, name: string): string | undefined {
  if (value[name] === undefined || value[name] === null) return undefined;
  if (typeof value[name] !== "string" || !value[name].trim()) throw new WorkspaceServerError(`${name}_invalid`, 400);
  return value[name] as string;
}

function numberField(value: Record<string, unknown>, name: string): number {
  const field = value[name];
  if (typeof field !== "number" || !Number.isSafeInteger(field)) throw new WorkspaceServerError(`${name}_invalid`, 400);
  return field;
}

function numberFieldOptional(value: Record<string, unknown>, name: string): number | undefined {
  return value[name] === undefined ? undefined : numberField(value, name);
}

function booleanField(value: Record<string, unknown>, name: string): boolean {
  if (typeof value[name] !== "boolean") throw new WorkspaceServerError(`${name}_invalid`, 400);
  return value[name] as boolean;
}

function objectField(value: Record<string, unknown>, name: string): Record<string, JsonValue> {
  if (value[name] === undefined) return {};
  if (!value[name] || typeof value[name] !== "object" || Array.isArray(value[name])) throw new WorkspaceServerError(`${name}_invalid`, 400);
  return value[name] as Record<string, JsonValue>;
}

function objectInput(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WorkspaceServerError("socket_input_invalid", 400);
  return value as Record<string, unknown>;
}

function optionalString(value: Record<string, unknown>, name: string): string | undefined {
  if (value[name] === undefined || value[name] === null) return undefined;
  if (typeof value[name] !== "string" || !value[name].trim()) throw new WorkspaceServerError(`${name}_invalid`, 400);
  return value[name] as string;
}

function safeIssue(issue: { path?: PropertyKey[]; message?: string } | undefined): Record<string, string> {
  return { path: issue?.path?.map(String).join(".") ?? "", message: issue?.message ?? "invalid" };
}

function safeSocketError(error: unknown): { code: string } {
  return { code: error instanceof WorkspaceServerError ? error.code : "workspace_request_rejected" };
}

function requestIdFromRequest(req: Request): string {
  const samurai = (req as Request & { samurai?: { requestId?: string } }).samurai;
  return samurai?.requestId ?? req.header("x-samurai-request-id") ?? "unknown";
}

function v1WorkspaceSocketRoom(workspaceId: string): string {
  return `workspace:v1:${workspaceId}`;
}

function v1RoomSocketRoom(workspaceId: string, roomId: string): string {
  return `workspace:v1:${workspaceId}:room:${roomId}`;
}
