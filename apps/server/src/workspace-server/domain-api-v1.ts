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

type V1Dependencies = {
  app: Express;
  io: SocketServer;
  store: WorkspaceServerStore;
  commands: WorkspaceServerCommandService;
  artifacts: PostgresArtifact;
  realtimeGate: WorkspaceRealtimeGate;
  authenticateWorkspace: RequestHandler;
  asyncRoute: (handler: (req: Request, res: Response, next: NextFunction) => Promise<void>) => RequestHandler;
  workspaceContext: (req: Request) => Pick<WorkspaceRequestContext, "workspaceId" | "accountId">;
  operationContext: (req: Request) => WorkspaceRequestContext;
  requestId: (req: Request) => string;
  runtimeFor: (req: Request) => PostgresRuntimeCommandService;
};

/** Mounts the first public API slice. Transport authentication remains owned by
 * the existing Workspace middleware; this module only adapts trusted context
 * to the shared contract and never accepts actor/authority fields from JSON. */
export function mountDomainApiV1(dependencies: V1Dependencies): void {
  const {
    app, io, store, commands, artifacts, realtimeGate,
    authenticateWorkspace, asyncRoute, workspaceContext, operationContext, requestId, runtimeFor
  } = dependencies;

  app.get("/api/v1/workspaces/:workspaceId/domain/catalog", authenticateWorkspace, asyncRoute(async (_req, res) => {
    const contracts = operationDefinitions
      .filter((definition) => v1OperationIds.has(definition.id) && definition.sources.includes("runtime_api"))
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

  app.post("/api/v1/workspaces/:workspaceId/domain/operations/:operationId", authenticateWorkspace, asyncRoute(async (req, res) => {
    const operationId = pathParam(req, "operationId");
    const request = parseDomainRequest(req.body);
    const definition = operationDefinitions.find((candidate) => candidate.id === operationId);
    if (!definition || definition.kind !== "command" || !v1OperationIds.has(operationId) || !definition.sources.includes("runtime_api")) {
      throw new WorkspaceServerError("domain_operation_not_available", 404, { operation_id: operationId });
    }
    const input = parseOperationInput(definition, request.input, operationId);
    const operation = operationContext(req);
    const context = trustedContext(operation, request.context, operationId);
    const result = await executeCommand({ operationId, input, requestContext: request.context, context, req, operation, dependencies });
    const response = apiResponse(req, publicOperationResult(operationId, result.value), result.replayed);
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

function publicOperationResult(operationId: string, result: JsonValue): JsonValue {
  const definition = operationDefinitions.find((candidate) => candidate.id === operationId);
  if (!definition) throw new WorkspaceServerError("domain_operation_not_available", 404, { operation_id: operationId });
  return publicOperationOutputSchemaFor(operationId, definition.output).parse(result) as JsonValue;
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
