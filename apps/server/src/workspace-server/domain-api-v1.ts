import type { Express, NextFunction, Request, RequestHandler, Response } from "express";
import { createHash } from "node:crypto";
import { Server as SocketServer, type Socket } from "socket.io";
import { z } from "zod";
import {
  ActivityRecordSchema,
  AgentRecordSchema,
  ArtifactRecordSchema,
  GeneratedSurfaceDefinitionSchema,
  ResourceRefSchema,
  RoomWorkAssignmentStatusSchema as CoreRoomWorkAssignmentStatusSchema,
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
  PublicAgentBackendRecordSchema,
  PublicAgentRecordSchema,
  PublicEventEnvelopeSchema,
  PublicWorkspaceDirectorySchema,
  PublicWorkspaceOrganizationAssociationResultSchema,
  publicOperationInputSchemaFor,
  PublicRoomRecordSchema,
  PublicRoomWorkResourceRefInputSchema,
  PublicRoomWorkResourceRefSchema,
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
  type GeneratedSurfaceActionRunInput,
  type GeneratedSurfaceCreateInput,
  type GeneratedSurfaceExportInput,
  type GeneratedSurfaceReviseInput,
  type GeneratedSurfaceStateInput,
  type TrustedDomainContext
} from "@samurai-agent/domain-operations";
import { generatedSurfaceCsp, safeGeneratedSurfaceAssetPath } from "@samurai-agent/runtime";
import { parseSurfaceOperation } from "@samurai-agent/ui-protocol";
import {
  WorkspaceCompletionService,
  WorkspaceInteractionRequestService,
  WorkspaceServerError,
  type OrganizationRequestContext,
  type WorkspaceRequestContext,
  type WorkspaceServerCommandService,
  type WorkspacePublicEvent,
  type WorkspacePublicEventPage,
  type WorkspaceInteractionRequest,
  type WorkspaceServerStore
} from "@samurai-agent/workspace-server";
import { PostgresArtifact } from "../adapters/runtime/postgres-artifact";
import { PostgresGeneratedSurface, type GeneratedSurfaceActionTarget } from "../adapters/runtime/postgres-generated-surface";
import { createPostgresChatSessionThroughDomainOperation } from "../adapters/runtime/postgres-session-domain-operation";
import { PostgresRuntimeCommandService } from "../adapters/runtime/postgres-runtime-chat";
import { WorkspaceRealtimeGate } from "./realtime";
import { RunControlService } from "./run-control-service";

const v1OperationIds = new Set<string>(publicDomainOperationIds);
/** Session/turn operations remain callable only by the compatibility path.
 * They are intentionally not included in the normal Workspace catalog. */
const legacyCompatibilityOperationIds = new Set<string>(["session.create", "chat.turn.run"]);
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

const roomWorkCommandIds = new Set<string>([
  "room.work.create",
  "room.work.reply",
  "room.work.comment.create",
  "room.work.comment.apply",
  "room.work.comment.reaction.set",
  "room.default_agent.set",
  "room.work.stop",
  "room.work.assignee.stop",
  "room.work.assignee.reassign",
  "room.work.assignee.delegate",
  "agent.dm.open"
]);

const roomAgentCommandIds = new Set<string>([
  "room.agent.permission.set",
  "room.agent.remove"
]);

const roomWorkQueryIds = new Set<string>(["room.work.list", "room.work.view"]);

/**
 * The persistence package owns SQL and authorization for this aggregate. The
 * Server adapter intentionally keeps this structural until that package
 * publishes the concrete Room-work types; it still calls only named methods
 * and fails closed when a deployment has not migrated yet.
 */
type RoomWorkStoreAdapter = WorkspaceServerStore & {
  /** Compatibility-only bridge: persistence resolves the legacy Session to a
   * Room work mapping atomically (create on first use, reply thereafter). */
  migrateLegacyChatTurn?: (context: WorkspaceRequestContext, input: Record<string, unknown>) => Promise<unknown>;
  createRoomWork?: (context: WorkspaceRequestContext, input: Record<string, unknown>) => Promise<unknown>;
  replyToRoomWork?: (context: WorkspaceRequestContext, input: Record<string, unknown>) => Promise<unknown>;
  createRoomWorkComment?: (context: WorkspaceRequestContext, input: Record<string, unknown>) => Promise<unknown>;
  applyRoomWorkComment?: (context: WorkspaceRequestContext, input: Record<string, unknown>) => Promise<unknown>;
  setRoomWorkCommentReaction?: (context: WorkspaceRequestContext, input: Record<string, unknown>) => Promise<unknown>;
  setRoomDefaultAgent?: (context: WorkspaceRequestContext, input: Record<string, unknown>) => Promise<unknown>;
  setAgentRoomPermission?: (context: WorkspaceRequestContext, input: Record<string, unknown>) => Promise<unknown>;
  removeRoomAgent?: (context: WorkspaceRequestContext, input: Record<string, unknown>) => Promise<unknown>;
  stopRoomWork?: (context: WorkspaceRequestContext, input: Record<string, unknown>) => Promise<unknown>;
  stopRoomWorkAssignee?: (context: WorkspaceRequestContext, input: Record<string, unknown>) => Promise<unknown>;
  reassignRoomWorkAssignee?: (context: WorkspaceRequestContext, input: Record<string, unknown>) => Promise<unknown>;
  delegateRoomWorkAssignee?: (context: WorkspaceRequestContext, input: Record<string, unknown>) => Promise<unknown>;
  openAgentDm?: (context: WorkspaceRequestContext, input: Record<string, unknown>) => Promise<unknown>;
  listRoomWorks?: (context: WorkspaceRequestContext, input: Record<string, unknown>) => Promise<unknown>;
  viewRoomWork?: (context: WorkspaceRequestContext, input: Record<string, unknown>) => Promise<unknown>;
};

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
  generatedSurfaces: PostgresGeneratedSurface;
  interactionRequests: WorkspaceInteractionRequestService;
  realtimeGate: WorkspaceRealtimeGate;
  authenticateWorkspace: RequestHandler;
  authenticateAccount: RequestHandler;
  asyncRoute: (handler: (req: Request, res: Response, next: NextFunction) => Promise<void>) => RequestHandler;
  workspaceContext: (req: Request) => Pick<WorkspaceRequestContext, "workspaceId" | "accountId">;
  operationContext: (req: Request) => WorkspaceRequestContext;
  organizationContext: (req: Request, organizationId?: string, options?: { mutation?: boolean }) => OrganizationApiRequestContext;
  requestId: (req: Request) => string;
  runtimeFor: (req: Request) => PostgresRuntimeCommandService;
  /** Optional injection keeps tests and hosts from constructing a second
   * Completion facade. The fallback is still Server-owned and uses the same
   * Store/RLS boundary when the legacy mount has not supplied it yet. */
  completion?: Pick<WorkspaceCompletionService, "getResourceRefForRoom">;
  backendRegistry: {
    statuses(): readonly AgentBackendStatusProjection[];
  };
};

type WorkspaceEventEmitterDependencies = Pick<V1Dependencies, "io" | "store" | "commands" | "realtimeGate">;

export type WorkspaceInteractionRequestEventAction = "created" | "responded" | "cancelled" | "executing" | "completed" | "failed" | "expired";

export interface WorkspaceInteractionRequestEventOptions {
  actor?: { kind: "human" | "system"; id?: string };
  correlationId?: string;
}

type AgentBackendStatusProjection = {
  id: string;
  kind: string;
  label: string;
  configured: boolean;
  enabled: boolean;
  connection_state: string;
  reason?: string;
};

/** Mounts the first public API slice. Transport authentication remains owned by
 * the existing Workspace middleware; this module only adapts trusted context
 * to the shared contract and never accepts actor/authority fields from JSON. */
export function mountDomainApiV1(dependencies: V1Dependencies): void {
  const {
    app, io, store, commands, artifacts, generatedSurfaces, interactionRequests, realtimeGate,
    authenticateWorkspace, authenticateAccount, asyncRoute, workspaceContext, operationContext,
    organizationContext, requestId, runtimeFor, backendRegistry
  } = dependencies;
  const executionDependencies: V1Dependencies = {
    ...dependencies,
    completion: dependencies.completion ?? new WorkspaceCompletionService(store)
  };

  app.get("/api/v1/workspaces/:workspaceId/domain/catalog", authenticateWorkspace, asyncRoute(async (_req, res) => {
    const contracts = operationDefinitions
      .filter((definition) => v1OperationIds.has(definition.id) && !organizationOperationIds.has(definition.id) && definition.sources.includes("runtime_api"))
      .map((definition) => ({
        id: definition.id,
        kind: definition.kind,
        version: definition.version,
        availability: definition.availability,
        input_schema: schemaForPublicContract(
          publicOperationInputSchemaFor(definition.id, definition.input),
          `${definition.id}.input`
        ),
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

  // Canonical Room-scoped Artifact projection. These routes deliberately
  // carry the Room selector in the signed request and never fall back to a
  // Workspace-wide Artifact lookup.
  app.get("/api/v1/workspaces/:workspaceId/artifacts", authenticateWorkspace, asyncRoute(async (req, res) => {
    const roomId = requireRoomQuery(req, "artifact_room_id_required");
    res.json({ artifacts: await artifacts.list(workspaceContext(req), roomId) });
  }));
  app.get("/api/v1/workspaces/:workspaceId/artifacts/:artifactId", authenticateWorkspace, asyncRoute(async (req, res) => {
    const roomId = requireRoomQuery(req, "artifact_room_id_required");
    res.json(await artifacts.get(workspaceContext(req), roomId, pathParam(req, "artifactId")));
  }));
  app.get("/api/v1/workspaces/:workspaceId/artifacts/:artifactId/revisions", authenticateWorkspace, asyncRoute(async (req, res) => {
    const roomId = requireRoomQuery(req, "artifact_room_id_required");
    res.json({ revisions: await artifacts.listRevisions(workspaceContext(req), roomId, pathParam(req, "artifactId")) });
  }));
  app.get("/api/v1/workspaces/:workspaceId/artifacts/:artifactId/revisions/:revisionId", authenticateWorkspace, asyncRoute(async (req, res) => {
    const roomId = requireRoomQuery(req, "artifact_room_id_required");
    res.json(await artifacts.getRevisionDetail(workspaceContext(req), roomId, pathParam(req, "artifactId"), pathParam(req, "revisionId")));
  }));
  app.get("/api/v1/workspaces/:workspaceId/artifacts/:artifactId/content", authenticateWorkspace, asyncRoute(async (req, res) => {
    const roomId = requireRoomQuery(req, "artifact_room_id_required");
    const revisionId = optionalQuery(req, "revision_id");
    const content = await artifacts.readContent(workspaceContext(req), roomId, pathParam(req, "artifactId"), revisionId);
    res.set("Content-Type", content.mimeType);
    res.set("Content-Length", String(content.bytes.byteLength));
    res.set("X-Content-Encoding", content.encoding);
    res.set("X-Content-Type-Options", "nosniff");
    res.send(content.bytes);
  }));
  app.post("/api/v1/workspaces/:workspaceId/artifacts/surface/operations", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = recordValue(req.body);
    const roomId = requireRoomBody(body, "room_id", "artifact_room_id_required");
    const operation = parseSurfaceOperation(body.operation);
    const context = operationContext(req);
    if (!operation || operation.kind !== "artifact.request" || operation.id !== context.operationId) throw new WorkspaceServerError("artifact_surface_operation_invalid", 400);
    const result = await artifacts.runSurfaceOperation(context, roomId, operation);
    const created = result.result && typeof result.result === "object" && !Array.isArray(result.result)
      ? result.result as Record<string, unknown>
      : undefined;
    const artifact = created?.artifact && typeof created.artifact === "object" && !Array.isArray(created.artifact)
      ? created.artifact as Record<string, unknown>
      : undefined;
    if (artifact && typeof artifact.id === "string") {
      await appendAndEmitPublicEvent(dependencies, context, {
        eventType: "workspace.artifact.changed",
        roomId,
        resources: [resourceRef("artifact", artifact.id, typeof artifact.title === "string" ? artifact.title : artifact.id)],
        authorizationAction: "edit",
        payload: { artifact_id: artifact.id, action: "created" }
      });
    }
    res.status(201).json(result);
  }));

  // Generated Surface read/action routes are the versioned counterpart of
  // the older `/api/workspaces/.../generated-surfaces` compatibility routes.
  app.get("/api/v1/workspaces/:workspaceId/generated-surfaces", authenticateWorkspace, asyncRoute(async (req, res) => {
    const roomId = requireRoomQuery(req, "generated_surface_room_id_required");
    const rows = await commands.listRecords(workspaceContext(req), { roomId, recordType: "generated_surface", limit: 500 });
    const surfaces = rows.map((row) => GeneratedSurfaceDefinitionSchema.parse(row.payload));
    res.json({ surfaces });
  }));
  app.get("/api/v1/workspaces/:workspaceId/generated-surfaces/:surfaceId", authenticateWorkspace, asyncRoute(async (req, res) => {
    const roomId = requireRoomQuery(req, "generated_surface_room_id_required");
    res.json(await generatedSurfaces.detail(workspaceContext(req), roomId, pathParam(req, "surfaceId")));
  }));
  app.get("/api/v1/workspaces/:workspaceId/generated-surfaces/:surfaceId/revisions/:revisionId/bundle", authenticateWorkspace, asyncRoute(async (req, res) => {
    const roomId = requireRoomQuery(req, "generated_surface_room_id_required");
    res.json(await generatedSurfaces.bundle(workspaceContext(req), roomId, pathParam(req, "surfaceId"), pathParam(req, "revisionId")));
  }));
  app.get("/api/v1/workspaces/:workspaceId/generated-surfaces/:surfaceId/export", authenticateWorkspace, asyncRoute(async (req, res) => {
    const roomId = requireRoomQuery(req, "generated_surface_room_id_required");
    const format = optionalQuery(req, "format") === "zip" ? "zip" : "html";
    const revisionId = optionalQuery(req, "revision_id");
    const input = { surface_id: pathParam(req, "surfaceId"), ...(revisionId ? { revision_id: revisionId } : {}), format } as const;
    if (format === "zip") {
      const zip = await generatedSurfaces.createExportZip(workspaceContext(req), roomId, input);
      res.json({ file_name: zip.fileName, content_type: "application/zip", content_base64: zip.content.toString("base64") });
      return;
    }
    const exported = await generatedSurfaces.export(workspaceContext(req), roomId, input);
    const assets = await generatedSurfaces.readAssets(workspaceContext(req), roomId, exported.revision);
    const content = generatedSurfaceDocument(exported.bundle, exported.surface.actions, generatedSurfaceAssetPayload(assets));
    res.json({ file_name: exported.file_name, content_type: "text/html", content_base64: Buffer.from(content, "utf8").toString("base64") });
  }));
  app.post("/api/v1/workspaces/:workspaceId/generated-surfaces/:surfaceId/actions/:actionId/run", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = recordValue(req.body);
    assertOnlyFields(body, ["room_id", "revision_id", "interaction_id", "message_id", "action_payload"], "generated_surface_action_body_invalid");
    const roomId = requireRoomBody(body, "room_id", "generated_surface_room_id_required");
    const operation = operationContext(req);
    const submitted = await submitGeneratedSurfaceAction(dependencies, operation, {
      room_id: roomId,
      surface_id: pathParam(req, "surfaceId"),
      action_id: pathParam(req, "actionId"),
      ...(optionalStringField(body, "revision_id") ? { revision_id: optionalStringField(body, "revision_id") } : {}),
      ...(optionalStringField(body, "interaction_id") ? { interaction_id: optionalStringField(body, "interaction_id") } : {}),
      ...(optionalStringField(body, "message_id") ? { message_id: optionalStringField(body, "message_id") } : {}),
      action_payload: body.action_payload === undefined ? {} : objectField(body, "action_payload")
    });
    if (submitted.kind === "approval_required") {
      res.status(submitted.replayed ? 200 : 202).json({ status: "approval_required", request: submitted.request, replayed: submitted.replayed });
      return;
    }
    await appendAndEmitPublicEvent(dependencies, operation, {
      eventType: "workspace.generated_surface.changed",
      roomId,
      resources: [resourceRef("generated_surface", pathParam(req, "surfaceId"), pathParam(req, "surfaceId"))],
      authorizationAction: "execute",
      payload: { surface_id: pathParam(req, "surfaceId"), action: "action" }
    });
    res.status(201).json(submitted.result);
  }));
  app.get("/api/v1/workspaces/:workspaceId/interaction-requests", authenticateWorkspace, asyncRoute(async (req, res) => {
    const roomId = requireRoomQuery(req, "workspace_interaction_room_id_required");
    const includeResolved = optionalBooleanQuery(req, "include_resolved") ?? false;
    await store.assertRoomReadable(workspaceContext(req), roomId);
    res.json({ requests: await interactionRequests.list(workspaceContext(req), { roomId, includeResolved }) });
  }));
  app.get("/api/v1/workspaces/:workspaceId/interaction-requests/:requestId", authenticateWorkspace, asyncRoute(async (req, res) => {
    const roomId = requireRoomQuery(req, "workspace_interaction_room_id_required");
    await store.assertRoomReadable(workspaceContext(req), roomId);
    res.json({ request: await interactionRequests.get(workspaceContext(req), { roomId, requestId: pathParam(req, "requestId") }) });
  }));
  app.post("/api/v1/workspaces/:workspaceId/interaction-requests/:requestId/respond", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = recordValue(req.body);
    assertOnlyFields(body, ["room_id", "expected_version", "option_id", "values"], "workspace_interaction_request_response_invalid");
    const roomId = requireRoomBody(body, "room_id", "workspace_interaction_room_id_required");
    const operation = operationContext(req);
    await commands.assertRoomExecutable(operation, roomId);
    const response = await interactionRequests.respond(operation, {
      roomId,
      requestId: pathParam(req, "requestId"),
      expectedVersion: numberField(body, "expected_version"),
      optionId: stringField(body, "option_id"),
      ...(body.values === undefined ? {} : { values: objectField(body, "values") })
    });
    if (!response.replayed) await emitInteractionRequestChange(dependencies, operation, response.request, "responded");
    if (response.request.status !== "accepted") {
      res.json({ request: response.request, replayed: response.replayed });
      return;
    }
    const request = await executeAcceptedInteractionRequest(dependencies, req, operation, response.request);
    res.json({ request, replayed: response.replayed });
  }));
  app.post("/api/v1/workspaces/:workspaceId/interaction-requests/:requestId/cancel", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = recordValue(req.body);
    assertOnlyFields(body, ["room_id", "expected_version"], "workspace_interaction_request_cancel_invalid");
    const roomId = requireRoomBody(body, "room_id", "workspace_interaction_room_id_required");
    const operation = operationContext(req);
    await commands.assertRoomExecutable(operation, roomId);
    const result = await interactionRequests.cancel(operation, {
      roomId,
      requestId: pathParam(req, "requestId"),
      expectedVersion: numberField(body, "expected_version")
    });
    if (!result.replayed) await emitInteractionRequestChange(dependencies, operation, result.request, "cancelled");
    res.json({ request: result.request, replayed: result.replayed });
  }));
  app.post("/api/v1/workspaces/:workspaceId/generated-surfaces/:surfaceId/state", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = recordValue(req.body);
    const roomId = requireRoomBody(body, "room_id", "generated_surface_room_id_required");
    const action = stringField(body, "action");
    if (action !== "pin" && action !== "unpin" && action !== "archive") throw new WorkspaceServerError("generated_surface_state_action_invalid", 400);
    const operation = operationContext(req);
    const surface = await generatedSurfaces.state(operation, {
      room_id: roomId,
      surface_id: pathParam(req, "surfaceId"),
      action,
      ...(optionalStringField(body, "interaction_id") ? { interaction_id: optionalStringField(body, "interaction_id") } : {}),
      ...(optionalStringField(body, "message_id") ? { message_id: optionalStringField(body, "message_id") } : {})
    });
    await appendAndEmitPublicEvent(dependencies, operation, {
      eventType: "workspace.generated_surface.changed",
      roomId,
      resources: [resourceRef("generated_surface", surface.id, surface.title)],
      authorizationAction: "edit",
      payload: { surface_id: surface.id, revision_id: surface.current_revision_id, action: "state_changed" }
    });
    res.json(surface);
  }));

  mountOrganizationDomainRoutes(dependencies);

  app.post("/api/v1/workspaces/:workspaceId/domain/operations/:operationId", authenticateWorkspace, asyncRoute(async (req, res) => {
    const operationId = pathParam(req, "operationId");
    const request = parseDomainRequest(req.body);
    const definition = operationDefinitions.find((candidate) => candidate.id === operationId);
    if (!definition || definition.kind !== "command"
      || (!v1OperationIds.has(operationId) && !legacyCompatibilityOperationIds.has(operationId))
      || !definition.sources.includes("runtime_api")) {
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
    const result = await executeCommand({ operationId, input, requestContext: request.context, context, req, operation, dependencies: executionDependencies });
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
  const { commands, artifacts, generatedSurfaces, store, realtimeGate, runtimeFor } = dependencies;
  const { workspaceId, accountId } = operation;
  if (roomWorkCommandIds.has(operationId)) {
    return executeRoomWorkCommand({
      operationId,
      input: value,
      requestContext,
      operation,
      dependencies
    });
  }
  if (roomAgentCommandIds.has(operationId)) {
    return executeRoomAgentCommand({
      operationId,
      input: value,
      requestContext,
      operation,
      dependencies
    });
  }
  if (operationId === "room.create") {
    const newAgent = value.new_agent === undefined ? undefined : recordValue(value.new_agent);
    const roomCreateInput: Record<string, unknown> = {
      name: stringField(value, "name"),
      ...(value.parent_room_id === undefined ? {} : { parentRoomId: stringField(value, "parent_room_id") }),
      ...(value.default_agent_id === undefined ? {} : { defaultAgentId: stringField(value, "default_agent_id") }),
      ...(value.default_agent_version === undefined ? {} : { defaultAgentVersion: numberField(value, "default_agent_version") }),
      ...(newAgent ? {
        newAgent: {
          name: stringField(newAgent, "name"),
          role: stringField(newAgent, "role"),
          instructions: stringField(newAgent, "instructions"),
          backendId: stringField(newAgent, "backend_id"),
          enabled: booleanField(newAgent, "enabled"),
          ...(newAgent.permission === undefined ? {} : { permission: roomAgentPermissionInput(newAgent.permission) })
        }
      } : {}),
      ...(value.agent_permission === undefined ? {} : { agentPermission: roomAgentPermissionInput(value.agent_permission) })
    };
    const result = await realtimeGate.run(workspaceId, () => commands.createRoom(
      operation,
      roomCreateInput as unknown as Parameters<WorkspaceServerCommandService["createRoom"]>[1]
    ));
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
    // Compatibility callers still identify their legacy Session in the
    // request context, but the Store resolves that Session to a Room work
    // mapping atomically. The Runtime is never called from this branch.
    const sessionId = requestContext.session_id;
    const roomId = requestContext.room_id;
    if (!sessionId) throw new WorkspaceServerError("session_id_required", 400);
    if (!roomId) throw new WorkspaceServerError("room_id_required", 400);
    const store = dependencies.store as unknown as RoomWorkStoreAdapter;
    const raw = await invokeRoomWorkStore(store, "migrateLegacyChatTurn", operation, {
      sessionId,
      roomId,
      instruction: stringField(value, "content"),
      attachments: arrayValue(value, "attachments"),
      ...(value.agent_id === undefined ? {} : { agentId: stringField(value, "agent_id") })
    });
    const unwrapped = unwrapStoreResult(raw);
    const migrated = normalizeLegacyChatTurnResult(unwrapped.value);
    if (!unwrapped.replayed) {
      const migrationOperation = migrated.mode === "reply" ? "room.work.reply" : "room.work.create";
      const event = roomWorkEventFor(migrationOperation, roomId, migrated.eventValue, value);
      if (event) await appendAndEmitPublicEvent(dependencies, operation, event);
    }
    return { value: migrated.publicValue, replayed: unwrapped.replayed };
  }
  if (operationId === "artifact.create") {
    const roomId = requireRoom(requestContext);
    const result = await artifacts.create(operation, {
      roomId,
      title: stringField(value, "title"),
      content: contentField(value, "content"),
      ...(value.kind === undefined ? {} : { kind: value.kind as never }),
      ...(value.output_locale === undefined ? {} : { locale: value.output_locale as never }),
      ...(value.input_locale === undefined ? {} : { sourceLocales: [value.input_locale as never] }),
      ...(value.mime_type === undefined ? {} : { mimeType: stringField(value, "mime_type") }),
      ...(value.encoding === undefined ? {} : { encoding: encodingField(value, "encoding") }),
      metadata: objectField(value, "metadata")
    });
    if (!result.replayed) await appendAndEmitPublicEvent(dependencies, operation, { eventType: "workspace.artifact.changed", roomId, resources: [resourceRef("artifact", result.artifact.id, result.artifact.title)], payload: { artifact_id: result.artifact.id, action: "created" } });
    return { value: result as unknown as JsonValue, replayed: result.replayed };
  }
  if (operationId === "artifact.revise") {
    const roomId = requireRoom(requestContext);
    const result = await artifacts.revise(operation, {
      roomId,
      artifactId: stringField(value, "artifact_id"),
      content: revisionContentField(value, "content"),
      ...(value.base_revision_id === undefined ? {} : { baseRevisionId: stringField(value, "base_revision_id") }),
      ...(value.expected_revision === undefined ? {} : { expectedRevision: numberField(value, "expected_revision") }),
      ...(value.editor_source === undefined ? {} : { editorSource: value.editor_source as never }),
      ...(value.change_summary === undefined ? {} : { changeSummary: stringField(value, "change_summary") }),
      ...(value.extension === undefined ? {} : { extension: stringField(value, "extension") }),
      ...(value.mime_type === undefined ? {} : { mimeType: stringField(value, "mime_type") }),
      ...(value.encoding === undefined ? {} : { encoding: encodingField(value, "encoding") }),
      provenance: objectField(value, "provenance")
    });
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
  if (operationId === "generated_surface.create") {
    const roomId = requireRoom(requestContext);
    const result = await generatedSurfaces.create(operation, roomId, value as unknown as GeneratedSurfaceCreateInput);
    if (!result.replayed) await appendAndEmitPublicEvent(dependencies, operation, {
      eventType: "workspace.generated_surface.changed",
      roomId,
      resources: [resourceRef("generated_surface", result.definition.id, result.definition.title), resourceRef("generated_surface_revision", result.revision.id, result.revision.id)],
      authorizationAction: "edit",
      payload: { surface_id: result.definition.id, revision_id: result.revision.id, action: "created" }
    });
    return { value: result as unknown as JsonValue, replayed: result.replayed };
  }
  if (operationId === "generated_surface.revise") {
    const roomId = requireRoom(requestContext);
    const result = await generatedSurfaces.revise(operation, roomId, value as unknown as GeneratedSurfaceReviseInput);
    if (!result.replayed) await appendAndEmitPublicEvent(dependencies, operation, {
      eventType: "workspace.generated_surface.changed",
      roomId,
      resources: [resourceRef("generated_surface", result.definition.id, result.definition.title), resourceRef("generated_surface_revision", result.revision.id, result.revision.id)],
      authorizationAction: "edit",
      payload: { surface_id: result.definition.id, revision_id: result.revision.id, action: "revised" }
    });
    return { value: result as unknown as JsonValue, replayed: result.replayed };
  }
  if (operationId === "generated_surface.action.run") {
    const roomId = requireRoom(requestContext);
    const result = await generatedSurfaces.runAction(operation, {
      ...(value as unknown as GeneratedSurfaceActionRunInput),
      room_id: roomId
    });
    const surfaceId = stringField(value, "surface_id");
    await appendAndEmitPublicEvent(dependencies, operation, {
      eventType: "workspace.generated_surface.changed",
      roomId,
      resources: [resourceRef("generated_surface", surfaceId, surfaceId)],
      authorizationAction: "execute",
      payload: { surface_id: surfaceId, action: "action" }
    });
    const { revisionId: _revisionId, ...publicResult } = result as Record<string, unknown>;
    return { value: publicResult as JsonValue, replayed: false };
  }
  if (operationId === "generated_surface.state") {
    const roomId = requireRoom(requestContext);
    const result = await generatedSurfaces.state(operation, {
      ...(value as unknown as GeneratedSurfaceStateInput),
      room_id: roomId
    });
    await appendAndEmitPublicEvent(dependencies, operation, {
      eventType: "workspace.generated_surface.changed",
      roomId,
      resources: [resourceRef("generated_surface", result.id, result.title)],
      authorizationAction: "edit",
      payload: { surface_id: result.id, revision_id: result.current_revision_id, action: "state_changed" }
    });
    return { value: result as unknown as JsonValue, replayed: false };
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

/**
 * Resolve the public Room Work selectors through the Completion service. The
 * public request intentionally has no URI or label field; those values are
 * read from the current Workspace/Room-authorized immutable version. The
 * Store repeats the same validation inside its transaction, so this adapter
 * check is not the final authorization boundary.
 */
export async function resolveRoomWorkResourceRefs(
  resolver: Pick<WorkspaceCompletionService, "getResourceRefForRoom">,
  context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">,
  roomId: string,
  value: Record<string, unknown>
): Promise<ResourceRef[]> {
  const raw = value.resource_refs === undefined ? [] : value.resource_refs;
  const parsed = PublicRoomWorkResourceRefInputSchema.array().max(32).safeParse(raw);
  if (!parsed.success) throw new WorkspaceServerError("domain_api_resource_refs_invalid", 400);

  const canonical = await Promise.all(parsed.data.map(async (ref) => {
    const resolved = await resolver.getResourceRefForRoom(context, {
      targetRoomId: roomId,
      resourceId: ref.id,
      kind: ref.kind,
      version: ref.version
    });
    const publicRef = PublicRoomWorkResourceRefSchema.safeParse(resolved);
    if (!publicRef.success) throw new WorkspaceServerError("room_work_resource_reference_invalid", 500);
    return publicRef.data;
  }));
  return canonical;
}

/** Store requires a non-empty instruction body. A resource-only public Work
 * therefore gets an explicit, deterministic instruction that describes the
 * user's intent without pretending that Knowledge/Skill refs are file
 * attachments. */
export function roomWorkInstructionForPublicInput(
  value: Record<string, unknown>,
  resourceRefs: readonly ResourceRef[]
): string | undefined {
  if (value.instruction === undefined) {
    return resourceRefs.length > 0 ? "Review the referenced resources." : undefined;
  }
  return stringField(value, "instruction").trim();
}

async function executeRoomWorkCommand(input: {
  operationId: string;
  input: Record<string, unknown>;
  requestContext: { room_id?: string; session_id?: string };
  operation: WorkspaceRequestContext;
  dependencies: V1Dependencies;
}): Promise<{ value: JsonValue; replayed: boolean }> {
  const { operationId, input: value, requestContext, operation, dependencies } = input;
  if (requestContext.session_id) {
    // Room work is the public continuity boundary. A caller must not select a
    // legacy Runtime Session and thereby bypass the work aggregate.
    throw new WorkspaceServerError("room_work_session_id_forbidden", 400);
  }
  const store = dependencies.store as unknown as RoomWorkStoreAdapter;
  const roomId = operationId === "agent.dm.open" ? undefined : requireRoom(requestContext);
  const resourceRefs = operationId === "room.work.create" || operationId === "room.work.reply"
    ? await resolveRoomWorkResourceRefs(
      dependencies.completion ?? new WorkspaceCompletionService(dependencies.store),
      operation,
      roomId!,
      value
    )
    : [];
  const instruction = roomWorkInstructionForPublicInput(value, resourceRefs);
  let raw: unknown;
  switch (operationId) {
    case "room.work.create":
      raw = await invokeRoomWorkStore(store, "createRoomWork", operation, {
        roomId,
        ...(instruction === undefined ? {} : { instruction }),
        attachments: arrayValue(value, "attachments"),
        resourceRefs,
        ...(value.agent_id === undefined ? {} : { agentId: stringField(value, "agent_id") })
      });
      break;
    case "room.work.reply":
      raw = await invokeRoomWorkStore(store, "replyToRoomWork", operation, {
        roomId,
        workId: stringField(value, "work_id"),
        ...(value.assignee_id === undefined ? {} : { assigneeId: stringField(value, "assignee_id") }),
        ...(instruction === undefined ? {} : { instruction }),
        attachments: arrayValue(value, "attachments"),
        resourceRefs,
        ...(numberFieldOptional(value, "expected_version") === undefined ? {} : { expectedVersion: numberFieldOptional(value, "expected_version") }),
        ...(numberFieldOptional(value, "expected_generation") === undefined ? {} : { expectedGeneration: numberFieldOptional(value, "expected_generation") })
      });
      break;
    case "room.work.comment.create":
      raw = await invokeRoomWorkStore(store, "createRoomWorkComment", operation, {
        roomId,
        workId: stringField(value, "work_id"),
        ...(value.body === undefined ? {} : { body: typeof value.body === "string" ? value.body : "" }),
        attachments: arrayValue(value, "attachments"),
        ...(numberFieldOptional(value, "expected_version") === undefined ? {} : { expectedVersion: numberFieldOptional(value, "expected_version") })
      });
      break;
    case "room.work.comment.apply":
      raw = await invokeRoomWorkStore(store, "applyRoomWorkComment", operation, {
        roomId,
        workId: stringField(value, "work_id"),
        commentId: stringField(value, "comment_id"),
        commentVersion: numberField(value, "comment_version"),
        ...(numberFieldOptional(value, "expected_version") === undefined ? {} : { expectedVersion: numberFieldOptional(value, "expected_version") }),
        ...(numberFieldOptional(value, "expected_generation") === undefined ? {} : { expectedGeneration: numberFieldOptional(value, "expected_generation") }),
        ...(value.assignee_id === undefined ? {} : { assigneeId: stringField(value, "assignee_id") })
      });
      break;
    case "room.work.comment.reaction.set":
      raw = await invokeRoomWorkStore(store, "setRoomWorkCommentReaction", operation, {
        roomId,
        workId: stringField(value, "work_id"),
        commentId: stringField(value, "comment_id"),
        reaction: "like",
        enabled: booleanField(value, "enabled"),
        ...(numberFieldOptional(value, "expected_version") === undefined ? {} : { expectedVersion: numberFieldOptional(value, "expected_version") })
      });
      break;
    case "room.default_agent.set":
      raw = await invokeRoomWorkStore(store, "setRoomDefaultAgent", operation, {
        roomId,
        agentId: stringField(value, "agent_id"),
        ...(numberFieldOptional(value, "expected_version") === undefined ? {} : { expectedVersion: numberFieldOptional(value, "expected_version") })
      });
      break;
    case "room.work.stop":
      raw = await invokeRoomWorkStore(store, "stopRoomWork", operation, {
        roomId,
        workId: stringField(value, "work_id"),
        ...(value.reason === undefined ? {} : { reason: stringField(value, "reason") }),
        ...(numberFieldOptional(value, "expected_version") === undefined ? {} : { expectedVersion: numberFieldOptional(value, "expected_version") }),
        ...(numberFieldOptional(value, "expected_generation") === undefined ? {} : { expectedGeneration: numberFieldOptional(value, "expected_generation") })
      });
      break;
    case "room.work.assignee.stop":
      raw = await invokeRoomWorkStore(store, "stopRoomWorkAssignee", operation, {
        roomId,
        workId: stringField(value, "work_id"),
        assigneeId: stringField(value, "assignee_id"),
        ...(value.reason === undefined ? {} : { reason: stringField(value, "reason") }),
        ...(numberFieldOptional(value, "expected_version") === undefined ? {} : { expectedVersion: numberFieldOptional(value, "expected_version") }),
        ...(numberFieldOptional(value, "expected_generation") === undefined ? {} : { expectedGeneration: numberFieldOptional(value, "expected_generation") })
      });
      break;
    case "room.work.assignee.reassign":
      raw = await invokeRoomWorkStore(store, "reassignRoomWorkAssignee", operation, {
        roomId,
        workId: stringField(value, "work_id"),
        assigneeId: stringField(value, "assignee_id"),
        agentId: stringField(value, "agent_id"),
        ...(numberFieldOptional(value, "expected_version") === undefined ? {} : { expectedVersion: numberFieldOptional(value, "expected_version") }),
        ...(numberFieldOptional(value, "expected_generation") === undefined ? {} : { expectedGeneration: numberFieldOptional(value, "expected_generation") })
      });
      break;
    case "room.work.assignee.delegate":
      raw = await invokeRoomWorkStore(store, "delegateRoomWorkAssignee", operation, {
        roomId,
        workId: stringField(value, "work_id"),
        assigneeId: stringField(value, "assignee_id"),
        agentId: stringField(value, "agent_id"),
        instruction: stringField(value, "instruction"),
        dependencyAssigneeIds: arrayValue(value, "dependency_assignee_ids"),
        attachments: arrayValue(value, "attachments"),
        ...(numberFieldOptional(value, "expected_version") === undefined ? {} : { expectedVersion: numberFieldOptional(value, "expected_version") }),
        ...(numberFieldOptional(value, "expected_generation") === undefined ? {} : { expectedGeneration: numberFieldOptional(value, "expected_generation") })
      });
      break;
    case "agent.dm.open":
      raw = await invokeRoomWorkStore(store, "openAgentDm", operation, { agentId: stringField(value, "agent_id") });
      break;
    default:
      throw new WorkspaceServerError("domain_operation_not_available", 404, { operation_id: operationId });
  }
  const normalized = normalizeRoomWorkValue(operationId, unwrapStoreResult(raw).value);
  const replayed = unwrapStoreResult(raw).replayed;
  if (!replayed) {
    const event = roomWorkEventFor(operationId, roomId, normalized, value);
    if (event) await appendAndEmitPublicEvent(dependencies, operation, event);
  }
  return { value: normalized as JsonValue, replayed };
}

async function executeRoomAgentCommand(input: {
  operationId: string;
  input: Record<string, unknown>;
  requestContext: { room_id?: string; session_id?: string };
  operation: WorkspaceRequestContext;
  dependencies: V1Dependencies;
}): Promise<{ value: JsonValue; replayed: boolean }> {
  const { operationId, input: value, requestContext, operation, dependencies } = input;
  if (requestContext.session_id) throw new WorkspaceServerError("room_agent_session_id_forbidden", 400);
  const roomId = requireRoom(requestContext);
  const store = dependencies.store as unknown as RoomWorkStoreAdapter;
  let raw: unknown;
  if (operationId === "room.agent.permission.set") {
    const agentId = stringField(value, "agent_id");
    const current = await dependencies.store.listAgentRoomPermissions(operation, roomId);
    const currentPermission = current.find((permission) => permission.agentId === agentId);
    raw = await invokeRoomAgentStore(store, "setAgentRoomPermission", operation, {
      roomId,
      agentId,
      canView: booleanField(value, "can_view"),
      canEdit: booleanField(value, "can_edit"),
      canExecute: booleanField(value, "can_execute"),
      expectedVersion: currentPermission?.version ?? 0
    });
  } else {
    raw = await invokeRoomAgentStore(store, "removeRoomAgent", operation, {
      roomId,
      agentId: stringField(value, "agent_id")
    });
  }
  const unwrapped = unwrapStoreResult(raw);
  const normalized = roomAgentPermissionRecord(unwrapped.value);
  if (!unwrapped.replayed) {
    const agentEvent = roomAgentPermissionEventFor(operationId, roomId, normalized);
    await appendAndEmitPublicEvent(dependencies, operation, agentEvent);
  }
  return { value: normalized as JsonValue, replayed: unwrapped.replayed };
}

async function invokeRoomAgentStore(
  store: RoomWorkStoreAdapter,
  methodName: "setAgentRoomPermission" | "removeRoomAgent",
  context: WorkspaceRequestContext,
  input: Record<string, unknown>
): Promise<unknown> {
  const method = store[methodName];
  if (typeof method !== "function") throw new WorkspaceServerError("room_agent_store_api_unavailable", 503, { method: methodName });
  return (method as unknown as (context: WorkspaceRequestContext, input: Record<string, unknown>) => Promise<unknown>).call(store, context, input);
}

async function invokeRoomWorkStore(
  store: RoomWorkStoreAdapter,
  methodName: keyof RoomWorkStoreAdapter,
  context: WorkspaceRequestContext,
  input: Record<string, unknown>
): Promise<unknown> {
  const method = store[methodName];
  if (typeof method !== "function") throw new WorkspaceServerError("room_work_store_api_unavailable", 503, { method: String(methodName) });
  return (method as unknown as (context: WorkspaceRequestContext, input: Record<string, unknown>) => Promise<unknown>).call(store, context, input);
}

function unwrapStoreResult(raw: unknown): { value: unknown; replayed: boolean } {
  const body = recordValue(raw);
  if (Object.prototype.hasOwnProperty.call(body, "value")) return { value: body.value, replayed: body.replayed === true };
  if (Object.prototype.hasOwnProperty.call(body, "result")) return { value: body.result, replayed: body.replayed === true };
  return { value: raw, replayed: body.replayed === true };
}

function executeRoomWorkQuery(
  queryId: string,
  input: Record<string, unknown>,
  requestContext: { room_id?: string; session_id?: string },
  operation: WorkspaceRequestContext,
  dependencies: V1Dependencies
): Promise<unknown> {
  if (requestContext.session_id) throw new WorkspaceServerError("room_work_session_id_forbidden", 400);
  const roomId = requireRoom(requestContext);
  const store = dependencies.store as unknown as RoomWorkStoreAdapter;
  if (queryId === "room.work.list") {
    return invokeRoomWorkStore(store, "listRoomWorks", operation, {
      roomId,
      ...(valueString(input, "status") ? { status: valueString(input, "status") } : {}),
      ...(valueString(input, "cursor") ? { cursor: valueString(input, "cursor") } : {}),
      limit: numberValue(input, "limit") ?? 50
    }).then((value) => normalizeRoomWorkValue(queryId, unwrapStoreResult(value).value));
  }
  return invokeRoomWorkStore(store, "viewRoomWork", operation, { roomId, workId: stringField(input, "work_id") })
    .then((value) => normalizeRoomWorkValue(queryId, unwrapStoreResult(value).value));
}

function normalizeRoomWorkValue(operationId: string, value: unknown): unknown {
  if (operationId === "room.work.list") {
    const body = recordValue(value);
    return listValue(value, "works").length > 0 || Array.isArray(value)
      ? listValue(value, "works").map(roomWorkRecord)
      : listValue(body, "room_works").map(roomWorkRecord);
  }
  if (operationId === "room.work.view") return roomWorkViewRecord(value);
  if (operationId === "room.work.create") return roomWorkRecord(value);
  if (operationId === "room.work.reply" || operationId === "room.work.comment.apply") return roomWorkInstructionRecord(value);
  if (operationId === "room.work.comment.create") return roomWorkCommentRecord(value);
  if (operationId === "room.work.comment.reaction.set") return roomWorkReactionRecord(value);
  if (operationId === "room.default_agent.set") return roomDefaultAgentRecord(value);
  if (operationId === "room.work.stop" || operationId === "room.work.assignee.stop") return roomWorkControlRecord(value);
  if (operationId === "room.work.assignee.reassign" || operationId === "room.work.assignee.delegate") return roomWorkAssigneeRecord(value);
  if (operationId === "agent.dm.open") return agentDmRecord(value);
  return value;
}

/** Convert the old chat-turn response to a Session-free compatibility result.
 * The persistence method decides whether this was the first turn (create) or
 * a later turn (reply); neither the mapping nor the legacy Session ID crosses
 * the public response boundary. */
function normalizeLegacyChatTurnResult(value: unknown): {
  mode: "create" | "reply";
  eventValue: unknown;
  publicValue: JsonValue;
} {
  const root = recordValue(value);
  const modeValue = valueString(root, "mode", "action", "migration_action", "migrationAction");
  const instructionValue = root.instruction ?? root.workInstruction ?? root.roomWorkInstruction;
  const workValue = root.work ?? root.roomWork;
  const mode: "create" | "reply" = modeValue === "reply" || (!workValue && instructionValue) ? "reply" : "create";
  const publicValue = compactRecord({
    compatibility: "room_work",
    operation_id: "chat.turn.run",
    mode,
    ...(workValue ? { work: roomWorkRecord(root) } : {}),
    ...(instructionValue ? { instruction: roomWorkInstructionRecord(instructionValue) } : {})
  }) as JsonValue;
  return {
    mode,
    eventValue: mode === "reply" ? instructionValue : workValue ?? root,
    publicValue
  };
}

function roomWorkRecord(value: unknown): Record<string, unknown> {
  const root = recordValue(value);
  const body = nestedRecord(value, "work", "roomWork");
  const assignees = listValue(body.assignees ?? body.assignments, "assignees").map(roomWorkAssigneeRecord);
  const completionCriteria = Array.isArray(body.completion_criteria)
    ? body.completion_criteria
    : Array.isArray(body.completionCriteria) ? body.completionCriteria : [];
  const reservationValues = body.execution_reservations ?? body.executionReservations
    ?? body.launchReservations ?? root.launchReservation ?? root.launch_reservation ?? root.launchReservations;
  const reservations = Array.isArray(reservationValues)
    ? reservationValues
    : reservationValues && typeof reservationValues === "object" ? [reservationValues] : [];
  return compactRecord({
    id: valueString(body, "id", "work_id", "workId"),
    room_id: valueString(body, "room_id", "roomId"),
    kind: "human",
    objective_id: optionalValue(body, "objective_id", "objectiveId"),
    requester_id: valueString(body, "requester_id", "requesterId", "requester_account_id", "requesterAccountId", "created_by", "createdBy"),
    front_agent_id: optionalValue(body, "front_agent_id", "frontAgentId"),
    default_agent_id: valueString(body, "default_agent_id", "defaultAgentId", "agent_id", "agentId"),
    default_agent_version: numberValue(body, "default_agent_version", "defaultAgentVersion"),
    title: valueString(body, "title") || valueString(body, "objective", "instruction"),
    objective: valueString(body, "objective", "instruction"),
    status: publicRoomWorkStatus(valueString(body, "status")),
    stop_state: optionalValue(body, "stop_state", "stopState"),
    completion_criteria: completionCriteria.length > 0 ? completionCriteria : undefined,
    instruction_version: numberValue(body, "instruction_version", "instructionVersion", "current_instruction_version", "currentInstructionVersion") ?? 1,
    generation: numberValue(body, "generation", "control_generation", "controlGeneration") ?? 0,
    version: numberValue(body, "version") ?? 1,
    resource_refs: publicRoomWorkResourceRefs(body),
    assignees,
    execution_reservations: reservations.map(roomWorkExecutionReservationRecord),
    created_at: valueString(body, "created_at", "createdAt"),
    updated_at: valueString(body, "updated_at", "updatedAt")
  });
}

function roomWorkExecutionReservationRecord(value: unknown): Record<string, unknown> {
  const body = nestedRecord(value, "reservation", "executionReservation", "launchReservation", "launch_reservation");
  return compactRecord({
    id: valueString(body, "id", "reservation_id", "reservationId", "launch_reservation_id", "launchReservationId"),
    work_id: valueString(body, "work_id", "workId"),
    assignment_id: valueString(body, "assignment_id", "assignmentId", "assignee_id", "assigneeId"),
    room_id: valueString(body, "room_id", "roomId"),
    generation: numberValue(body, "generation") ?? 1,
    status: valueString(body, "status") || "reserved",
    scheduled_at: valueString(body, "scheduled_at", "scheduledAt"),
    claimed_at: optionalValue(body, "claimed_at", "claimedAt"),
    released_at: optionalValue(body, "released_at", "releasedAt"),
    created_at: valueString(body, "created_at", "createdAt"),
    updated_at: valueString(body, "updated_at", "updatedAt")
  });
}

function roomWorkViewRecord(value: unknown): Record<string, unknown> {
  const root = recordValue(value);
  const body = nestedRecord(value, "view", "workView", "work", "roomWork");
  const base = roomWorkRecord(body);
  const instructions = listValue(body.instructions ?? root.instructions, "instructions").map(roomWorkInstructionRecord);
  const comments = listValue(body.comments ?? root.comments, "comments").map(roomWorkCommentRecord);
  const reactions = listValue(body.reactions ?? root.reactions, "reactions").map(roomWorkReactionRecord);
  const controls = listValue(body.controls ?? root.controls, "controls").map(roomWorkControlRecord);
  return {
    ...base,
    instructions,
    comments,
    reactions,
    controls
  };
}

function publicRoomWorkStatus(value: string): string {
  if (value === "ready") return "queued";
  if (["queued", "running", "waiting", "completed", "failed", "stopping", "cancelled", "outcome_unknown"].includes(value)) return value;
  if (value === "blocked") return "blocked";
  return "queued";
}

function publicRoomWorkInstructionKind(body: Record<string, unknown>): string {
  const value = valueString(body, "kind", "source_kind", "sourceKind");
  if (value === "request") return "initial";
  if (value === "comment_reflection") return "comment_apply";
  if (value === "system") return "delegated";
  if (["initial", "reply", "comment_apply", "delegated"].includes(value)) return value;
  return "reply";
}

function publicRoomWorkInstructionStatus(value: string): string {
  if (["pending", "accepted", "queued", "delivered", "applied", "failed", "rejected"].includes(value)) return value;
  return "accepted";
}

function publicRoomWorkControlAction(value: string): string {
  if (["stop_request", "stop_confirm", "stop_unconfirmed"].includes(value)) return "stop";
  if (value === "assignment_stop") return "assignee.stop";
  if (value === "reassign") return "assignee.reassign";
  if (["stop", "assignee.stop", "assignee.reassign"].includes(value)) return value;
  return "stop";
}

function publicRoomWorkControlStatus(value: string): string {
  if (value === "pending") return "requested";
  if (value === "confirmed") return "completed";
  if (["requested", "accepted", "running", "completed", "failed", "unconfirmed", "rejected"].includes(value)) return value;
  return "accepted";
}

function roomWorkAssigneeRecord(value: unknown): Record<string, unknown> {
  const body = nestedRecord(value, "assignee", "assignment", "workAssignee");
  return compactRecord({
    id: valueString(body, "id", "assignee_id", "assigneeId"),
    work_id: valueString(body, "work_id", "workId"),
    agent_id: valueString(body, "agent_id", "agentId"),
    parent_assignee_id: optionalValue(body, "parent_assignee_id", "parentAssigneeId"),
    status: publicRoomWorkStatus(valueString(body, "status")),
    instruction_version: numberValue(body, "instruction_version", "instructionVersion") ?? 1,
    generation: numberValue(body, "generation", "control_generation", "controlGeneration") ?? 0,
    agent_configuration_version: numberValue(body, "agent_configuration_version", "agentConfigurationVersion", "agent_version", "agentVersion"),
    attempt: numberValue(body, "attempt"),
    version: numberValue(body, "version") ?? 1,
    created_at: valueString(body, "created_at", "createdAt"),
    updated_at: valueString(body, "updated_at", "updatedAt")
  });
}

function roomWorkInstructionRecord(value: unknown): Record<string, unknown> {
  const body = nestedRecord(value, "instruction", "workInstruction");
  const createdAt = valueString(body, "created_at", "createdAt");
  return compactRecord({
    id: valueString(body, "id", "instruction_id", "instructionId"),
    work_id: valueString(body, "work_id", "workId"),
    assignee_id: optionalValue(body, "assignee_id", "assigneeId", "assignment_id", "assignmentId"),
    kind: publicRoomWorkInstructionKind(body),
    instruction: valueString(body, "instruction", "content", "body"),
    attachments: Array.isArray(body.attachments)
      ? body.attachments
      : Array.isArray(body.attachment_refs) ? body.attachment_refs
        : Array.isArray(body.attachmentRefs) ? body.attachmentRefs : [],
    resource_refs: publicRoomWorkResourceRefs(body),
    version: numberValue(body, "version") ?? 1,
    generation: numberValue(body, "generation") ?? 0,
    status: publicRoomWorkInstructionStatus(valueString(body, "status", "state")),
    created_by: valueString(body, "created_by", "createdBy", "author_id", "authorId"),
    source_comment_id: optionalValue(body, "source_comment_id", "sourceCommentId"),
    created_at: createdAt,
    updated_at: valueString(body, "updated_at", "updatedAt") || createdAt
  });
}

/** Project only canonical Completion refs. Any malformed persisted ref is a
 * server invariant failure; silently dropping it would make the public Work
 * view disagree with the instruction actually stored and executed. */
function publicRoomWorkResourceRefs(body: Record<string, unknown>): ResourceRef[] {
  const raw = body.resource_refs ?? body.resourceRefs;
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new WorkspaceServerError("room_work_resource_reference_invalid", 500);
  const projected = raw.map((value) => {
    const entry = recordValue(value);
    return compactRecord({
      kind: valueString(entry, "kind"),
      id: valueString(entry, "id", "resource_id", "resourceId"),
      uri: valueString(entry, "uri"),
      version: typeof entry.version === "number" && Number.isSafeInteger(entry.version)
        ? String(entry.version)
        : optionalValue(entry, "version"),
      label: optionalValue(entry, "label")
    });
  });
  const parsed = PublicRoomWorkResourceRefSchema.array().max(32).safeParse(projected);
  if (!parsed.success) throw new WorkspaceServerError("room_work_resource_reference_invalid", 500);
  return parsed.data;
}

function roomWorkCommentRecord(value: unknown): Record<string, unknown> {
  const body = nestedRecord(value, "comment", "workComment");
  const createdAt = valueString(body, "created_at", "createdAt");
  return compactRecord({
    id: valueString(body, "id", "comment_id", "commentId"),
    work_id: valueString(body, "work_id", "workId"),
    author_id: valueString(body, "author_id", "authorId", "author_account_id", "authorAccountId", "created_by", "createdBy"),
    body: typeof body.body === "string" ? body.body : "",
    attachments: Array.isArray(body.attachments) ? body.attachments : Array.isArray(body.attachment_refs) ? body.attachment_refs : [],
    version: numberValue(body, "version") ?? 1,
    reaction_count: numberValue(body, "reaction_count", "reactionCount"),
    applied_instruction_ids: Array.isArray(body.applied_instruction_ids)
      ? body.applied_instruction_ids
      : Array.isArray(body.appliedInstructionIds) ? body.appliedInstructionIds : [],
    created_at: createdAt,
    updated_at: valueString(body, "updated_at", "updatedAt") || createdAt
  });
}

function roomWorkReactionRecord(value: unknown): Record<string, unknown> {
  const body = nestedRecord(value, "reaction", "workReaction");
  return compactRecord({
    id: valueString(body, "id", "reaction_id", "reactionId"),
    work_id: valueString(body, "work_id", "workId"),
    comment_id: valueString(body, "comment_id", "commentId"),
    reaction: valueString(body, "reaction") || "like",
    enabled: typeof body.enabled === "boolean" ? body.enabled : false,
    version: numberValue(body, "version") ?? 1,
    created_at: valueString(body, "created_at", "createdAt"),
    updated_at: valueString(body, "updated_at", "updatedAt")
  });
}

function roomDefaultAgentRecord(value: unknown): Record<string, unknown> {
  const body = nestedRecord(value, "default_agent", "defaultAgent", "roomDefaultAgent");
  return compactRecord({
    room_id: valueString(body, "room_id", "roomId"),
    agent_id: valueString(body, "agent_id", "agentId"),
    agent_version: numberValue(body, "agent_version", "agentVersion") ?? 1,
    enabled: typeof body.enabled === "boolean" ? body.enabled : true,
    can_execute: typeof body.can_execute === "boolean" ? body.can_execute : body.canExecute !== false,
    version: numberValue(body, "version") ?? 1,
    updated_at: valueString(body, "updated_at", "updatedAt")
  });
}

function roomAgentPermissionRecord(value: unknown): Record<string, unknown> {
  const body = nestedRecord(value, "permission", "agentRoomPermission", "roomAgentPermission");
  const roomId = valueString(body, "room_id", "roomId");
  const agentId = valueString(body, "agent_id", "agentId");
  const canView = typeof body.can_view === "boolean" ? body.can_view : body.canView === true;
  const canEdit = typeof body.can_edit === "boolean" ? body.can_edit : body.canEdit === true;
  const canExecute = typeof body.can_execute === "boolean" ? body.can_execute : body.canExecute === true;
  return compactRecord({
    id: valueString(body, "id") || `room_agent:${roomId}:${agentId}`,
    room_id: roomId,
    agent_id: agentId,
    can_view: canView,
    can_edit: canEdit,
    can_execute: canExecute,
    version: numberValue(body, "version") ?? 1,
    created_by: valueString(body, "created_by", "createdBy"),
    created_at: valueString(body, "created_at", "createdAt"),
    updated_at: valueString(body, "updated_at", "updatedAt"),
    removed: !canView && !canEdit && !canExecute
  });
}

function roomMemberListRecord(value: unknown): Record<string, unknown> {
  const body = recordValue(value);
  const humans = listValue(body, "humans").map((entry) => {
    const member = recordValue(entry);
    return compactRecord({
      id: valueString(member, "id") || `room_member:${valueString(member, "room_id", "roomId")}:${valueString(member, "account_id", "accountId")}`,
      room_id: valueString(member, "room_id", "roomId"),
      account_id: valueString(member, "account_id", "accountId"),
      role: valueString(member, "role") || "member",
      state: valueString(member, "state") || "active",
      version: numberValue(member, "version") ?? 1,
      created_at: valueString(member, "created_at", "createdAt"),
      updated_at: valueString(member, "updated_at", "updatedAt"),
      ...(valueString(member, "revoked_at", "revokedAt") ? { revoked_at: valueString(member, "revoked_at", "revokedAt") } : {})
    });
  });
  const agents = listValue(body, "agents").map(roomAgentPermissionRecord);
  return { humans, agents };
}

function roomAgentPermissionEventFor(
  operationId: string,
  roomId: string,
  value: Record<string, unknown>
): {
  eventType: string;
  roomId: string;
  resources: ResourceRef[];
  authorizationAction: "edit";
  payload: Record<string, unknown>;
} {
  const agentId = valueString(value, "agent_id");
  return {
    eventType: "workspace.room_agent.changed",
    roomId,
    resources: [resourceRef("room", roomId, roomId), resourceRef("room_agent", `${roomId}:${agentId}`, agentId)],
    authorizationAction: "edit",
    payload: {
      room_id: roomId,
      agent_id: agentId,
      action: operationId === "room.agent.remove" ? "removed" : value.removed === true ? "removed" : "permission_changed",
      can_view: value.can_view === true,
      can_edit: value.can_edit === true,
      can_execute: value.can_execute === true,
      ...(numberValue(value, "version") === undefined ? {} : { version: numberValue(value, "version") })
    }
  };
}

function roomWorkControlRecord(value: unknown): Record<string, unknown> {
  const body = nestedRecord(value, "control", "workControl");
  // Stop dispatch evidence remains internal to the persistence control, but
  // these two compact fields are part of the public Room-work projection: the
  // Native App must distinguish a request that is still pending from an
  // unconfirmed external outcome. Do not expose runner leases, raw backend
  // diagnostics, or provider data from `details`.
  const details = recordValue(body.details);
  const unconfirmedAssigneeIds = Array.isArray(details.unconfirmed_assignee_ids)
    ? details.unconfirmed_assignee_ids
    : Array.isArray(details.unconfirmedAssigneeIds) ? details.unconfirmedAssigneeIds : [];
  return compactRecord({
    id: valueString(body, "id", "control_id", "controlId"),
    operation_id: optionalValue(body, "operation_id", "operationId"),
    work_id: valueString(body, "work_id", "workId"),
    assignee_id: optionalValue(body, "assignee_id", "assigneeId", "assignment_id", "assignmentId"),
    target_agent_id: optionalValue(body, "target_agent_id", "targetAgentId"),
    action: publicRoomWorkControlAction(valueString(body, "action")),
    status: publicRoomWorkControlStatus(valueString(body, "status", "state")),
    generation: numberValue(body, "generation") ?? 0,
    version: numberValue(body, "version") ?? 1,
    terminal_status: optionalValue(body, "terminal_status", "terminalStatus")
      ?? optionalValue(details, "terminal_status", "terminalStatus"),
    unconfirmed_assignee_ids: Array.isArray(body.unconfirmed_assignee_ids)
      ? body.unconfirmed_assignee_ids
      : Array.isArray(body.unconfirmedAssigneeIds) ? body.unconfirmedAssigneeIds : unconfirmedAssigneeIds,
    created_at: valueString(body, "created_at", "createdAt"),
    updated_at: valueString(body, "updated_at", "updatedAt"),
    completed_at: optionalValue(body, "completed_at", "completedAt")
  });
}

function agentDmRecord(value: unknown): Record<string, unknown> {
  const body = nestedRecord(value, "dm", "agentDm", "agent_dm");
  const roomId = valueString(body, "room_id", "roomId");
  return compactRecord({
    // The persistence projection uses the private Room ID as the DM record
    // identity; no Runtime Session ID is exposed here.
    id: valueString(body, "id", "dm_id", "dmId") || roomId,
    room_id: roomId,
    workspace_id: valueString(body, "workspace_id", "workspaceId"),
    kind: "agent_dm",
    agent_id: valueString(body, "agent_id", "agentId", "default_agent_id", "defaultAgentId"),
    agent_version: numberValue(body, "agent_version", "agentVersion") ?? 1,
    version: numberValue(body, "version") ?? 1,
    created_at: valueString(body, "created_at", "createdAt"),
    updated_at: valueString(body, "updated_at", "updatedAt")
  });
}

export function roomWorkEventFor(
  operationId: string,
  roomId: string | undefined,
  value: unknown,
  input: Record<string, unknown>
): {
  eventType: string;
  roomId?: string;
  resources: ResourceRef[];
  authorizationAction: "edit" | "execute";
  payload: Record<string, unknown>;
} | undefined {
  const body = recordValue(value);
  const workId = valueString(body, "work_id", "workId", "id") || optionalStringField(input, "work_id");
  const effectiveRoomId = roomId || valueString(body, "room_id", "roomId");
  const workResourceRefs = operationId === "room.work.create" || operationId === "room.work.reply"
    ? publicRoomWorkResourceRefs(body)
    : [];
  const resourceList = effectiveRoomId
    ? [resourceRef("room", effectiveRoomId, effectiveRoomId), ...(workId ? [resourceRef("room_work", workId, workId)] : []), ...workResourceRefs]
    : [];
  if (operationId === "room.default_agent.set") {
    const agentId = valueString(body, "agent_id", "agentId") || optionalStringField(input, "agent_id");
    if (!effectiveRoomId || !agentId) return undefined;
    return {
      eventType: "workspace.room_default_agent.changed",
      roomId: effectiveRoomId,
      resources: [resourceRef("room", effectiveRoomId, effectiveRoomId), resourceRef("agent", agentId, agentId)],
      authorizationAction: "edit",
      payload: {
        room_id: effectiveRoomId,
        agent_id: agentId,
        ...(numberValue(body, "agent_version", "agentVersion") === undefined ? {} : { agent_version: numberValue(body, "agent_version", "agentVersion") }),
        ...(numberValue(body, "version") === undefined ? {} : { version: numberValue(body, "version") })
      }
    };
  }
  if (operationId === "agent.dm.open") {
    const agentId = valueString(body, "agent_id", "agentId") || optionalStringField(input, "agent_id");
    if (!effectiveRoomId || !agentId) return undefined;
    return {
      eventType: "workspace.agent_dm.changed",
      roomId: effectiveRoomId,
      resources: [resourceRef("room", effectiveRoomId, effectiveRoomId), resourceRef("agent", agentId, agentId)],
      authorizationAction: "execute",
      payload: { room_id: effectiveRoomId, agent_id: agentId, action: "opened", ...(numberValue(body, "version") === undefined ? {} : { version: numberValue(body, "version") }) }
    };
  }
  if (!effectiveRoomId || !workId) return undefined;
  if (operationId === "room.work.comment.create" || operationId === "room.work.comment.apply" || operationId === "room.work.comment.reaction.set") {
    const commentId = operationId === "room.work.comment.apply"
      ? valueString(body, "source_comment_id", "sourceCommentId", "comment_id", "commentId") || optionalStringField(input, "comment_id")
      : valueString(body, "comment_id", "commentId", "id") || optionalStringField(input, "comment_id");
    if (!commentId) return undefined;
    const action = operationId === "room.work.comment.create" ? "created" : operationId === "room.work.comment.apply" ? "applied" : "reaction_changed";
    return {
      eventType: "workspace.room_work.comment.changed",
      roomId: effectiveRoomId,
      resources: [...resourceList, resourceRef("room_work_comment", commentId, commentId)],
      authorizationAction: operationId === "room.work.comment.apply" ? "execute" : "edit",
      payload: { room_id: effectiveRoomId, work_id: workId, comment_id: commentId, action, ...(numberValue(body, "version") === undefined ? {} : { version: numberValue(body, "version") }) }
    };
  }
  if (operationId === "room.work.assignee.stop" || operationId === "room.work.assignee.reassign" || operationId === "room.work.assignee.delegate") {
    const assigneeId = valueString(body, "assignee_id", "assigneeId", "id") || optionalStringField(input, "assignee_id");
    if (!assigneeId) return undefined;
    const action = operationId === "room.work.assignee.stop" ? "stopped" : operationId === "room.work.assignee.reassign" ? "reassigned" : "delegated";
    const parentAssigneeId = valueString(body, "parent_assignee_id", "parentAssigneeId") || optionalStringField(input, "assignee_id");
    // A stop operation returns a control receipt whose `status` is the
    // control lifecycle (for example `accepted` or `completed`).  The
    // assignee event's optional `status` is instead the assignment lifecycle,
    // so only publish values accepted by the assignment schema.  In
    // particular, never project the stop receipt's `accepted` as an
    // assignment status.
    const assignmentStatus = action === "stopped"
      ? undefined
      : CoreRoomWorkAssignmentStatusSchema.safeParse(valueString(body, "status"));
    return {
      eventType: "workspace.room_work.assignee.changed",
      roomId: effectiveRoomId,
      resources: [...resourceList, resourceRef("room_work_assignee", assigneeId, assigneeId)],
      authorizationAction: "execute",
      payload: { room_id: effectiveRoomId, work_id: workId, assignee_id: assigneeId, action, ...(action === "delegated" && parentAssigneeId ? { parent_assignee_id: parentAssigneeId } : {}), ...(valueString(body, "agent_id", "agentId") ? { agent_id: valueString(body, "agent_id", "agentId") } : {}), ...(assignmentStatus?.success ? { status: assignmentStatus.data } : {}), ...(numberValue(body, "generation") === undefined ? {} : { generation: numberValue(body, "generation") }), ...(numberValue(body, "version") === undefined ? {} : { version: numberValue(body, "version") }) }
    };
  }
  const action = operationId === "room.work.create" ? "created" : operationId === "room.work.reply" ? "replied" : operationId === "room.work.stop" ? "stopped" : "updated";
  const status = eventRoomWorkStatus(valueString(body, "status"));
  return {
    eventType: "workspace.room_work.changed",
    roomId: effectiveRoomId,
    resources: resourceList,
    authorizationAction: "execute",
    payload: { room_id: effectiveRoomId, work_id: workId, action, ...(status ? { status } : {}), ...(numberValue(body, "generation") === undefined ? {} : { generation: numberValue(body, "generation") }), ...(numberValue(body, "version") === undefined ? {} : { version: numberValue(body, "version") }) }
  };
}

/** An instruction or control receipt has its own lifecycle state (for example
 * `pending` or `confirmed`); it must never be published as the Work status. */
function eventRoomWorkStatus(value: string): string | undefined {
  return ["queued", "running", "waiting", "blocked", "completed", "failed", "stopping", "cancelled", "outcome_unknown"].includes(value)
    ? value
    : undefined;
}

async function executeQuery(
  queryId: string,
  input: Record<string, unknown>,
  requestContext: { room_id?: string; session_id?: string },
  context: TrustedDomainContext,
  dependencies: V1Dependencies
): Promise<JsonValue> {
  const { store, artifacts, generatedSurfaces } = dependencies;
  if (roomWorkQueryIds.has(queryId)) {
    return await executeRoomWorkQuery(queryId, input, requestContext, {
      workspaceId: context.workspaceId,
      accountId: context.actorId,
      operationId: context.idempotencyKey ?? context.correlationId
    }, dependencies) as JsonValue;
  }
  if (queryId === "room.list") return (await store.listRooms({ workspaceId: context.workspaceId, accountId: context.actorId })).map(roomRecord) as unknown as JsonValue;
  if (queryId === "room.view") return roomRecord(await store.getRoom({ workspaceId: context.workspaceId, accountId: context.actorId }, stringField(input, "id")));
  if (queryId === "room.member.list") {
    const roomId = requireRoom(requestContext);
    const operation = { workspaceId: context.workspaceId, accountId: context.actorId };
    const [humans, agents] = await Promise.all([
      store.listRoomMembers(operation, roomId),
      store.listAgentRoomPermissions(operation, roomId)
    ]);
    return roomMemberListRecord({ humans, agents }) as JsonValue;
  }
  if (queryId === "agent.backend.list") {
    return dependencies.backendRegistry.statuses().map(publicAgentBackendRecord) as unknown as JsonValue;
  }
  if (queryId === "agent.list") return (await store.listAgents({ workspaceId: context.workspaceId, accountId: context.actorId })).map(agentRecord) as unknown as JsonValue;
  if (queryId === "agent.view") return agentRecord(await store.getAgent({ workspaceId: context.workspaceId, accountId: context.actorId }, stringField(input, "id")));
  const roomId = requireRoom(requestContext);
  if (queryId === "artifact.list") return await artifacts.list({ workspaceId: context.workspaceId, accountId: context.actorId }, roomId) as unknown as JsonValue;
  if (queryId === "artifact.view") return await artifacts.get({ workspaceId: context.workspaceId, accountId: context.actorId }, roomId, stringField(input, "id")) as unknown as JsonValue;
  if (queryId === "generated_surface.export") {
    return await generatedSurfaces.export({ workspaceId: context.workspaceId, accountId: context.actorId }, roomId, input as unknown as GeneratedSurfaceExportInput) as unknown as JsonValue;
  }
  throw new WorkspaceServerError("domain_query_not_available", 404, { query_id: queryId });
}

type SubmittedGeneratedSurfaceAction =
  | { kind: "executed"; result: Record<string, unknown> }
  | { kind: "approval_required"; request: WorkspaceInteractionRequest; replayed: boolean };

async function submitGeneratedSurfaceAction(
  dependencies: V1Dependencies,
  operation: WorkspaceRequestContext,
  input: Parameters<PostgresGeneratedSurface["prepareAction"]>[1]
): Promise<SubmittedGeneratedSurfaceAction> {
  const prepared = await dependencies.generatedSurfaces.prepareAction(operation, input);
  if (!prepared.action.requires_confirmation) {
    return { kind: "executed", result: await dependencies.generatedSurfaces.runAction(operation, input) };
  }
  const created = await dependencies.interactionRequests.create(operation, {
    roomId: prepared.target.room_id,
    kind: "approval",
    surfaceId: prepared.target.surface_id,
    revisionId: prepared.target.revision_id,
    actionTarget: prepared.target as unknown as Record<string, JsonValue>,
    title: `${prepared.surface.title}: ${prepared.action.label}`,
    summary: "このSurface操作は、現在の対象版とRoom権限を再確認してから実行されます。",
    options: [
      { id: "approve", label: "実行を許可", decision: "approve" },
      { id: "deny", label: "実行しない", decision: "deny" }
    ]
  });
  if (!created.replayed) await emitInteractionRequestChange(dependencies, operation, created.request, "created");
  return { kind: "approval_required", request: created.request, replayed: created.replayed };
}

/**
 * Runs one accepted durable request. The caller never supplies a command,
 * revision, payload, or backend input at this point: every value comes from
 * the persisted request through `claimExecution`.
 */
async function executeAcceptedInteractionRequest(
  dependencies: V1Dependencies,
  req: Request,
  responseOperation: WorkspaceRequestContext,
  accepted: WorkspaceInteractionRequest
): Promise<WorkspaceInteractionRequest> {
  const ownerId = "workspace-server-interaction-executor";
  const claimContext = interactionServerContext(responseOperation, accepted.id, "claim");
  let executionOperationId = interactionExecutionOperationId(responseOperation.workspaceId, accepted.id, "initial");
  let claim = await dependencies.interactionRequests.claimExecution(claimContext, {
    roomId: accepted.roomId,
    requestId: accepted.id,
    expectedVersion: accepted.version,
    ownerId,
    executionOperationId
  });
  if (Date.parse(claim.claim.leaseUntil) <= Date.now()) {
    executionOperationId = interactionExecutionOperationId(responseOperation.workspaceId, accepted.id, `recovery:${claim.request.version}`);
    claim = await dependencies.interactionRequests.recoverExecution(
      interactionServerContext(responseOperation, accepted.id, "recover"),
      {
        roomId: accepted.roomId,
        requestId: accepted.id,
        expectedVersion: claim.request.version,
        ownerId,
        executionOperationId
      }
    );
  }
  if (!claim.replayed) await emitInteractionRequestChange(dependencies, claimContext, claim.request, "executing");

  const executionContext = { ...responseOperation, operationId: claim.claim.executionOperationId };
  // The response was authorized before it was persisted. Recheck again at
  // execution time so a later Room permission revoke cannot be reused.
  try {
    await dependencies.commands.assertRoomExecutable(executionContext, claim.request.roomId);
  } catch (error) {
    // A permission revoke is an execution-admission failure, not a transient
    // `executing` state. Settle it through the same owned claim so it cannot
    // be retried later without a new, explicitly created request.
    return settleFailedAcceptedInteractionRequest(dependencies, executionContext, claim, ownerId, error);
  }
  if (claim.request.kind === "approval") {
    let result: Record<string, unknown>;
    try {
      const target = claim.executionTarget.actionTarget as unknown as GeneratedSurfaceActionTarget;
      result = await dependencies.generatedSurfaces.executeActionTarget(executionContext, target);
    } catch (error) {
      return settleFailedAcceptedInteractionRequest(dependencies, executionContext, claim, ownerId, error);
    }
    const settled = await dependencies.interactionRequests.settleExecution(
      interactionServerContext(executionContext, claim.request.id, "settle"),
      {
        roomId: claim.request.roomId,
        requestId: claim.request.id,
        expectedVersion: claim.request.version,
        ownerId,
        executionOperationId: claim.claim.executionOperationId,
        status: "completed",
        summary: "Generated Surface action completed."
      }
    );
    if (!settled.replayed) {
      await emitInteractionRequestChange(dependencies, executionContext, settled.request, "completed");
      const surfaceId = claim.executionTarget.surfaceId;
      if (surfaceId) {
        await appendAndEmitPublicEvent(dependencies, executionContext, {
          eventType: "workspace.generated_surface.changed",
          roomId: claim.request.roomId,
          resources: [resourceRef("generated_surface", surfaceId, surfaceId)],
          authorizationAction: "execute",
          payload: { surface_id: surfaceId, revision_id: claim.executionTarget.revisionId, action: "action" }
        });
      }
    }
    // The interaction record and target result were persisted by the adapter.
    // Keep this assignment explicit: confirmation result values do not come
    // from a renderer-provided boolean or payload.
    void result;
    return settled.request;
  }

  const runId = claim.executionTarget.runId;
  let execution: Awaited<ReturnType<RunControlService["execute"]>>;
  try {
    if (!runId || !isJsonObject(claim.executionInput)) {
      throw new WorkspaceServerError("workspace_interaction_backend_input_invalid", 409);
    }
    execution = await runControlService.execute({
      runtime: dependencies.runtimeFor(req),
      action: "resume",
      runId,
      roomId: claim.request.roomId,
      resumeInput: claim.executionInput,
      idempotencyKey: claim.claim.executionOperationId,
      onChanged: async ({ action, run }) => {
        await appendAndEmitPublicEvent(dependencies, executionContext, {
          eventType: "workspace.run.changed",
          roomId: run.room_id,
          authorizationAction: "execute",
          resources: [resourceRef("backend_run", run.id, run.id)],
          payload: { run_id: run.id, status: run.status, action }
        });
      }
    });
  } catch (error) {
    return settleFailedAcceptedInteractionRequest(dependencies, executionContext, claim, ownerId, error);
  }
  const settled = await dependencies.interactionRequests.settleExecution(
    interactionServerContext(executionContext, claim.request.id, "settle"),
    {
      roomId: claim.request.roomId,
      requestId: claim.request.id,
      expectedVersion: claim.request.version,
      ownerId,
      executionOperationId: claim.claim.executionOperationId,
      status: "completed",
      summary: "Backend input delivered to the current Run."
    }
  );
  if (!settled.replayed) await emitInteractionRequestChange(dependencies, executionContext, settled.request, "completed");
  void execution;
  return settled.request;
}

/**
 * Only failures from the side-effect boundary may settle a request as failed.
 * A later event-delivery or settlement failure must leave the durable request
 * intact for idempotent recovery instead of rewriting a completed action.
 */
async function settleFailedAcceptedInteractionRequest(
  dependencies: V1Dependencies,
  executionContext: WorkspaceRequestContext,
  claim: { request: WorkspaceInteractionRequest; claim: { executionOperationId: string } },
  ownerId: string,
  error: unknown
): Promise<WorkspaceInteractionRequest> {
  const settled = await dependencies.interactionRequests.settleExecution(
    interactionServerContext(executionContext, claim.request.id, "settle-failed"),
    {
      roomId: claim.request.roomId,
      requestId: claim.request.id,
      expectedVersion: claim.request.version,
      ownerId,
      executionOperationId: claim.claim.executionOperationId,
      status: "failed",
      summary: "The Server could not execute the approved request.",
      errorCode: publicInteractionErrorCode(error)
    }
  );
  if (!settled.replayed) await emitInteractionRequestChange(dependencies, executionContext, settled.request, "failed");
  return settled.request;
}

export async function emitInteractionRequestChange(
  dependencies: WorkspaceEventEmitterDependencies,
  context: WorkspaceRequestContext,
  request: WorkspaceInteractionRequest,
  action: WorkspaceInteractionRequestEventAction,
  options: WorkspaceInteractionRequestEventOptions = {}
): Promise<void> {
  const resources: ResourceRef[] = [
    resourceRef("interaction_request", request.id, request.title),
    resourceRef("room", request.roomId, request.roomId)
  ];
  if (request.runId) resources.push(resourceRef("backend_run", request.runId, request.runId));
  if (request.surfaceId) resources.push(resourceRef("generated_surface", request.surfaceId, request.surfaceId));
  if (request.revisionId) resources.push(resourceRef("generated_surface_revision", request.revisionId, request.revisionId));
  await appendAndEmitPublicEvent(dependencies, context, {
    eventType: "workspace.interaction_request.changed",
    roomId: request.roomId,
    resources,
    authorizationAction: "execute",
    ...(options.actor ? { actor: options.actor } : {}),
    ...(options.correlationId ? { correlationId: options.correlationId } : {}),
    payload: { request_id: request.id, kind: request.kind, status: request.status, action }
  });
}

function interactionServerContext(context: WorkspaceRequestContext, requestId: string, phase: string): WorkspaceRequestContext {
  return {
    ...context,
    operationId: `interaction_${createHash("sha256").update(`${context.workspaceId}|${requestId}|${context.operationId}|${phase}`).digest("hex").slice(0, 48)}`
  };
}

function interactionExecutionOperationId(workspaceId: string, requestId: string, attempt: string): string {
  return `interaction_execution_${createHash("sha256").update(`${workspaceId}|${requestId}|${attempt}`).digest("hex").slice(0, 48)}`;
}

function publicInteractionErrorCode(error: unknown): string {
  return error instanceof WorkspaceServerError ? error.code : "workspace_interaction_execution_failed";
}

function isJsonObject(value: unknown): value is Record<string, JsonValue> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function appendAndEmitPublicEvent(
  dependencies: WorkspaceEventEmitterDependencies,
  context: WorkspaceRequestContext,
  input: {
    eventType: string;
    roomId?: string;
    resources?: ResourceRef[];
    authorizationAction?: "edit" | "execute";
    actor?: { kind: "human" | "system"; id?: string };
    correlationId?: string;
    payload: Record<string, unknown>;
  }
): Promise<void> {
  const saved = await dependencies.commands.appendPublicEvent(context, {
    eventType: input.eventType,
    roomId: input.roomId,
    actor: input.actor ?? { kind: "human", id: context.accountId },
    ...(input.resources ? { resources: input.resources } : {}),
    ...(input.authorizationAction ? { authorizationAction: input.authorizationAction } : {}),
    operationId: context.operationId,
    correlationId: input.correlationId ?? (context.caller?.kind === "human" ? context.caller.requestId : context.operationId),
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

export async function emitAuthorizedV1Event(io: SocketServer, store: WorkspaceServerStore, event: WorkspacePublicEvent): Promise<void> {
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
  const parsed = publicOperationInputSchemaFor(operationId, definition.input).safeParse(value);
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
  if (operationId === "chat.turn.run") {
    return normalizeLegacyChatTurnResult(result).publicValue;
  }
  const outputSchema = publicOperationOutputSchemaFor(operationId, definition.output);
  const alreadyPublic = outputSchema.safeParse(result);
  if (alreadyPublic.success) return alreadyPublic.data as JsonValue;
  const projected = organizationRouteOperationIds.has(operationId)
    ? normalizeOrganizationValue(operationId, result, accountId)
    : roomWorkCommandIds.has(operationId) || roomWorkQueryIds.has(operationId)
      ? normalizeRoomWorkValue(operationId, result)
      : roomAgentCommandIds.has(operationId)
        ? roomAgentPermissionRecord(result)
        : operationId === "room.member.list"
          ? roomMemberListRecord(result)
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

function arrayValue(value: Record<string, unknown>, key: string): unknown[] {
  return Array.isArray(value[key]) ? value[key] : [];
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/**
 * Interaction mutations deliberately accept a closed request shape.  In
 * particular, accepting a legacy `confirmed` flag by silently ignoring it
 * would make it look as though an untrusted renderer can approve an action.
 */
function assertOnlyFields(value: Record<string, unknown>, allowed: readonly string[], code: string): void {
  const allowedFields = new Set(allowed);
  if (Object.keys(value).some((field) => !allowedFields.has(field))) throw new WorkspaceServerError(code, 400);
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

function roomRecord(room: {
  id: string;
  workspaceId: string;
  parentRoomId?: string;
  name: string;
  kind?: "normal" | "agent_dm";
  defaultAgentId?: string;
  defaultAgentVersion?: number;
  version: number;
  canManage?: boolean;
  canExecute?: boolean;
  createdAt: string;
  updatedAt: string;
}): JsonValue {
  return PublicRoomRecordSchema.parse({
    id: room.id,
    workspace_id: room.workspaceId,
    ...(room.parentRoomId ? { parent_room_id: room.parentRoomId } : {}),
    name: room.name,
    ...(room.kind ? { kind: room.kind } : {}),
    ...(room.defaultAgentId ? { default_agent_id: room.defaultAgentId } : {}),
    ...(room.defaultAgentVersion === undefined ? {} : { default_agent_version: room.defaultAgentVersion }),
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

/**
 * Keep the backend registry host-owned. Only the explicitly documented
 * availability projection crosses the public Domain API boundary; metadata,
 * credentials, paths, capabilities, and diagnostics never do.
 */
export function publicAgentBackendRecord(status: AgentBackendStatusProjection): JsonValue {
  const reason = safeBackendReason(status.reason);
  return PublicAgentBackendRecordSchema.parse({
    id: status.id,
    kind: status.kind,
    label: status.label,
    configured: status.configured,
    enabled: status.enabled,
    connection_state: status.connection_state,
    ...(reason ? { reason } : {})
  });
}

function safeBackendReason(reason: string | undefined): string | undefined {
  if (!reason || reason.length > 256 || !/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(reason)) return undefined;
  return reason;
}

function resourceRef(kind: string, id: string, label: string): ResourceRef {
  return ResourceRefSchema.parse({ kind, id, uri: `samurai://${kind}/${id}`, label });
}

function pathParam(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== "string" || !value.trim()) throw new WorkspaceServerError(`${name}_required`, 400);
  return value;
}

function requireRoomQuery(req: Request, code: string): string {
  const roomId = optionalQuery(req, "room_id");
  if (!roomId) throw new WorkspaceServerError(code, 400);
  return roomId;
}

function requireRoomBody(value: Record<string, unknown>, name: string, code: string): string {
  const roomId = optionalStringField(value, name);
  if (!roomId) throw new WorkspaceServerError(code, 400);
  return roomId;
}

function optionalQuery(req: Request, name: string): string | undefined {
  const value = req.query[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new WorkspaceServerError(`${name}_invalid`, 400);
  return value;
}

function optionalBooleanQuery(req: Request, name: string): boolean | undefined {
  const value = optionalQuery(req, name);
  if (value === undefined) return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new WorkspaceServerError(`${name}_invalid`, 400);
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

function stringField(value: Record<string, unknown>, name: string): string {
  if (typeof value[name] !== "string" || !value[name].trim()) throw new WorkspaceServerError(`${name}_required`, 400);
  return value[name] as string;
}

function contentField(value: Record<string, unknown>, name: string): string | Uint8Array | Record<string, JsonValue> | JsonValue[] {
  if (typeof value[name] === "string") return value[name] as string;
  if (Array.isArray(value[name]) && value[name].every((item) => typeof item === "number" && Number.isInteger(item) && item >= 0 && item <= 255)) {
    return Uint8Array.from(value[name] as number[]);
  }
  if (Array.isArray(value[name])) return value[name] as JsonValue[];
  if (value[name] && typeof value[name] === "object") return value[name] as Record<string, JsonValue>;
  throw new WorkspaceServerError(`${name}_invalid`, 400);
}

function revisionContentField(value: Record<string, unknown>, name: string): string | Uint8Array {
  const content = contentField(value, name);
  if (typeof content === "string" || content instanceof Uint8Array) return content;
  throw new WorkspaceServerError(`${name}_invalid`, 400);
}

function encodingField(value: Record<string, unknown>, name: string): "utf8" | "binary" {
  if (value[name] !== "utf8" && value[name] !== "binary") throw new WorkspaceServerError(`${name}_invalid`, 400);
  return value[name];
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

function roomAgentPermissionInput(value: unknown): Record<string, boolean> {
  const body = recordValue(value);
  return {
    canView: booleanField(body, "can_view"),
    canEdit: booleanField(body, "can_edit"),
    canExecute: booleanField(body, "can_execute")
  };
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

function generatedSurfaceDocument(
  bundle: { html: string; css?: string; script?: string },
  actions: Array<{ id: string }> = [],
  assets: Array<{ path: string; content_base64: string; mime_type: string }> = []
): string {
  const bridge = JSON.stringify({ actions: actions.map((action) => action.id) }).replace(/</g, "\\u003c");
  const html = inlineGeneratedSurfaceAssets(bundle.html, assets);
  const css = (bundle.css ?? "").replace(/<\/style/gi, "<\\/style");
  const script = (bundle.script ?? "").replace(/<\/script/gi, "<\\/script");
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${generatedSurfaceCsp}"><style>${css}</style></head><body>${html}<script>${script}</script><script>window.samuraiGeneratedSurface=${bridge};window.dispatchSamuraiAction=function(actionId,payload){window.parent.postMessage({type:"samurai.generated_surface.action",action_id:actionId,payload:payload||{}},"*")};</script></body></html>`;
}

function generatedSurfaceAssetPayload(assets: Array<{ path: string; content: Buffer; mime_type: string }>): Array<{ path: string; content_base64: string; mime_type: string }> {
  return assets.map((asset) => ({ path: asset.path, content_base64: asset.content.toString("base64"), mime_type: asset.mime_type }));
}

function inlineGeneratedSurfaceAssets(source: string, assets: Array<{ path: string; content_base64: string; mime_type: string }>): string {
  const dataByPath = new Map<string, string>();
  for (const asset of assets) {
    const safePath = safeGeneratedSurfaceAssetPath(asset.path);
    if (!safePath) continue;
    const dataUrl = `data:${asset.mime_type};base64,${asset.content_base64}`;
    dataByPath.set(safePath, dataUrl);
    dataByPath.set(`assets/${safePath}`, dataUrl);
  }
  const replaceReference = (reference: string): string => dataByPath.get(reference.trim().replace(/^\.\//, "")) ?? reference;
  return source
    .replace(/((?:src|href)\s*=\s*["'])([^"']+)(["'])/gi, (_match, prefix: string, reference: string, suffix: string) => `${prefix}${replaceReference(reference)}${suffix}`)
    .replace(/(url\(\s*["']?)([^"')]+)(["']?\s*\))/gi, (_match, prefix: string, reference: string, suffix: string) => `${prefix}${replaceReference(reference)}${suffix}`);
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
