import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import { createHash } from "node:crypto";
import { createServer, type Server as HttpServer } from "node:http";
import { Server as SocketServer } from "socket.io";
import {
  WorkspaceServerError,
  WorkspaceServerStore,
  WorkspaceLearningRunner,
  assertOpaqueId,
  canonicalJson,
  createVerifiedWorkspaceHumanCaller,
  loadWorkspaceServerConfig,
  readWorkspaceBundleV3Transport,
  resolveRequestWorkspaceId,
  verifyAccountSignature,
  type WorkspaceLearningScope,
  type WorkspaceKnowledgeReviewPort,
  type WorkspaceLearningSettings,
  type WorkspaceCompletionResourceKind,
  type WorkspaceCompletionAttestationPort,
  type WorkspaceCompletionPolicyOperation,
  type WorkspaceCompletionScope,
  type WorkspaceCompletionSemanticCuratorPort,
  type WorkspaceRequestContext,
  type WorkspaceServerConfig
} from "@samurai-agent/workspace-server";
import { createWorkspaceServerCore } from "./core";
import { WorkspaceRealtimeGate, roomSocketRoom, workspaceSocketRoom } from "./realtime";

interface AuthenticatedRequest extends Request {
  samurai?: {
    accountId: string;
    requestId: string;
    timestamp: string;
    signature: string;
    canonicalPayloadHash: string;
    publicKey: string;
    signedPayload: {
      method: string;
      path: string;
      workspaceId?: string;
      operationId?: string;
      requestId: string;
      timestamp: string;
      body: unknown;
    };
    workspaceId?: string;
  };
}

export interface WorkspaceServerHttp {
  app: express.Express;
  httpServer: HttpServer;
  io: SocketServer;
  config: WorkspaceServerConfig;
  close(): Promise<void>;
}

/** The host may register narrow review cassettes. No provider client or
 * credential is constructed here, so the Server never gains an implicit
 * external-Agent connection. */
export interface WorkspaceServerHttpOptions {
  reviewPorts?: readonly WorkspaceKnowledgeReviewPort[];
  /** Optional host cassette for the explicitly requested semantic dry-run.
   * It is never created from an HTTP request or enabled by default. */
  semanticCuratorPort?: WorkspaceCompletionSemanticCuratorPort;
  /** Host-only verification cassette. HTTP cannot select this Port or submit
   * a raw attestation result. */
  attestationPort?: WorkspaceCompletionAttestationPort;
}

export async function createWorkspaceServerHttp(
  config = loadWorkspaceServerConfig(),
  options: WorkspaceServerHttpOptions = {}
): Promise<WorkspaceServerHttp> {
  const core = await createWorkspaceServerCore(config, { attestationPort: options.attestationPort });
  const { store, files, bundles, commands, learning, completion, completionJobs, curator, completionMigrations, maintenance } = core;
  const app = express();
  const httpServer = createServer(app);
  const corsOrigins = config.corsOrigins;
  app.disable("x-powered-by");
  app.set("trust proxy", false);
  app.use((_req, res, next) => {
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("cache-control", "no-store");
    next();
  });
  app.use(requestRateGuard({ windowMs: 60_000, limit: config.publicNetwork ? 180 : 600 }));
  app.use(cors({ origin: corsOrigins.length > 0 ? [...corsOrigins] : false, credentials: false }));
  app.use(express.json({ limit: "36mb" }));
  const io = new SocketServer(httpServer, { cors: { origin: corsOrigins.length > 0 ? [...corsOrigins] : false, credentials: false } });
  const realtimeGate = new WorkspaceRealtimeGate();
  const learningRunner = new WorkspaceLearningRunner(learning, options.reviewPorts ?? [], {
    onSettled: async ({ context, job }) => {
      await realtimeGate.run(context.workspaceId, async () => {
        await emitAuthorizedRoomWorkspaceEvent(io, store, { workspaceId: context.workspaceId, roomId: job.roomId, kind: "learning.job.updated" });
      });
    }
  });

  const authenticate = accountAuthenticator(store);
  const authenticateWorkspace = workspaceAuthenticator(store, config);
  // An invitee is authenticated but not a Workspace member yet. The token is
  // the sole authorization for this one route; all other routes require a
  // current membership before reaching the store.
  const authenticateInvitationAcceptance = workspaceAuthenticator(store, config, { requireMembership: false });

  app.get("/api/health", (_req, res) => {
    res.json({
      ok: true,
      storage: "postgresql",
      mode: config.mode,
      ...(config.mode === "self_host" ? { workspace_id: config.selfHostWorkspaceId } : {}),
      rls: "required",
      public_network: config.publicNetwork
    });
  });

  app.post("/api/account/register", asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const accountId = stringField(body, "account_id");
    const publicKey = stringField(body, "public_key");
    const displayName = stringField(body, "display_name");
    const signed = signedHeaders(req);
    if (signed.accountId !== accountId) throw new WorkspaceServerError("account_signature_payload_mismatch", 401);
    verifyAccountSignature({
      signed,
      publicKey,
      payload: { method: req.method, path: req.path, requestId: signed.requestId, timestamp: signed.timestamp, body }
    });
    const account = await commands.registerAccount({ id: accountId, publicKey, displayName });
    res.status(201).json({ account });
  }));

  app.get("/api/account/workspaces", authenticate, asyncRoute(async (req, res) => {
    const accountId = authenticated(req).accountId;
    res.json({ workspaces: await store.listWorkspaces(accountId) });
  }));

  app.post("/api/workspaces", authenticate, asyncRoute(async (req, res) => {
    if (config.mode !== "hosted") throw new WorkspaceServerError("self_host_accepts_one_workspace", 409);
    const body = objectBody(req.body);
    const workspace = await commands.createWorkspace({
      id: stringField(body, "workspace_id"),
      name: stringField(body, "name"),
      ownerAccountId: authenticated(req).accountId,
      operationId: stringHeader(req, "x-samurai-operation-id"),
      hostingMode: "hosted",
      databasePlacement: "shared"
    });
    res.status(201).json(workspace);
  }));

  /** Target-side import: it receives a verified portable Bundle, never a source server path. */
  app.post("/api/workspaces/imports", authenticate, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const targetWorkspaceId = stringField(body, "target_workspace_id");
    const imported = await commands.importWorkspaceBundleTransport({
      accountId: authenticated(req).accountId,
      operationId: stringHeader(req, "x-samurai-operation-id")
    }, {
      transport: body.bundle,
      targetWorkspaceId,
      ...(optionalStringField(body, "target_workspace_name") ? { targetWorkspaceName: optionalStringField(body, "target_workspace_name") } : {})
    });
    res.status(201).json({ workspace_id: imported.workspaceId, manifest: imported.manifest, ...(imported.receipt ? { receipt: imported.receipt } : {}) });
  }));

  /** Chunked target import avoids loading a whole Workspace Bundle into RAM. */
  app.post("/api/workspaces/imports/staging", authenticate, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const operationId = stringHeader(req, "x-samurai-operation-id");
    await commands.stageWorkspaceBundle({ accountId: authenticated(req).accountId, operationId }, {
      targetWorkspaceId: stringField(body, "target_workspace_id"),
      ...(optionalStringField(body, "target_workspace_name") ? { targetWorkspaceName: optionalStringField(body, "target_workspace_name") } : {}),
      manifest: workspaceBundleManifestField(body, "manifest")
    });
    res.status(201).end();
  }));

  app.put("/api/workspaces/imports/staging/:operationId/entries/{*entryPath}", authenticate, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const operationId = pathParam(req, "operationId");
    if (operationId !== stringHeader(req, "x-samurai-operation-id")) throw new WorkspaceServerError("workspace_operation_id_mismatch", 400);
    const content = Buffer.from(base64Field(body, "content_base64"), "base64");
    await commands.writeWorkspaceBundleEntry(
      { accountId: authenticated(req).accountId, operationId },
      wildcardParam(req.params.entryPath),
      content
    );
    res.status(204).end();
  }));

  app.post("/api/workspaces/imports/staging/:operationId/complete", authenticate, asyncRoute(async (req, res) => {
    const operationId = pathParam(req, "operationId");
    if (operationId !== stringHeader(req, "x-samurai-operation-id")) throw new WorkspaceServerError("workspace_operation_id_mismatch", 400);
    const imported = await commands.completeWorkspaceBundleImport({ accountId: authenticated(req).accountId, operationId });
    res.status(201).json({ workspace_id: imported.workspaceId, manifest: imported.manifest, ...(imported.receipt ? { receipt: imported.receipt } : {}) });
  }));

  app.get("/api/workspaces/:workspaceId", authenticateWorkspace, asyncRoute(async (req, res) => {
    res.json({ workspace: await store.getWorkspace(workspaceContext(req)) });
  }));

  app.get("/api/workspaces/:workspaceId/rooms", authenticateWorkspace, asyncRoute(async (req, res) => {
    res.json({ rooms: await store.listRooms(workspaceContext(req)) });
  }));

  app.post("/api/workspaces/:workspaceId/rooms", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const context = workspaceContext(req);
    const result = await realtimeGate.run(context.workspaceId, async () => {
      const created = await commands.createRoom(operationContext(req), {
        id: optionalStringField(body, "room_id"),
        name: stringField(body, "name"),
        ...(optionalStringField(body, "parent_room_id") ? { parentRoomId: optionalStringField(body, "parent_room_id") } : {}),
        expectedWorkspaceVersion: numberField(body, "expected_workspace_version")
      });
      if (!created.replayed) {
        await emitAuthorizedRoomWorkspaceEvent(io, store, { workspaceId: context.workspaceId, roomId: created.room.id, kind: "room.created" });
      }
      return created;
    });
    res.status(result.replayed ? 200 : 201).json({ room: result.room, replayed: result.replayed });
  }));

  app.get("/api/workspaces/:workspaceId/rooms/:roomId/members", authenticateWorkspace, asyncRoute(async (req, res) => {
    res.json({ members: await store.listRoomMembers(workspaceContext(req), pathParam(req, "roomId")) });
  }));

  app.post("/api/workspaces/:workspaceId/rooms/:roomId/parent/preview", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const preview = await store.previewRoomMove(workspaceContext(req), {
      roomId: pathParam(req, "roomId"),
      parentRoomId: nullableStringField(body, "parent_room_id")
    });
    res.json({ preview });
  }));

  app.put("/api/workspaces/:workspaceId/rooms/:roomId/parent", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const context = workspaceContext(req);
    const result = await realtimeGate.run(context.workspaceId, async () => {
      const moved = await commands.moveRoom(operationContext(req), {
        roomId: pathParam(req, "roomId"),
        parentRoomId: nullableStringField(body, "parent_room_id"),
        expectedRoomVersion: numberField(body, "expected_room_version"),
        expectedWorkspaceVersion: numberField(body, "expected_workspace_version")
      });
      if (!moved.replayed) {
        for (const roomId of moved.revalidationRoomIds) {
          await emitAuthorizedRoomWorkspaceEvent(io, store, { workspaceId: context.workspaceId, roomId, kind: "room.moved" });
        }
      }
      return moved;
    });
    res.json({ room: result.room, affected_room_ids: result.affectedRoomIds, replayed: result.replayed });
  }));

  app.post("/api/workspaces/:workspaceId/rooms/:roomId/members/:accountId/preview", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const preview = await store.previewRoomMemberChange(workspaceContext(req), {
      roomId: pathParam(req, "roomId"),
      accountId: pathParam(req, "accountId"),
      role: roleField(body, "role"),
      state: membershipStateField(body, "state")
    });
    res.json({ preview });
  }));

  app.put("/api/workspaces/:workspaceId/members/:accountId", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const memberAccountId = pathParam(req, "accountId");
    const context = workspaceContext(req);
    const result = await realtimeGate.run(context.workspaceId, async () => {
      const changed = await commands.setWorkspaceMember(operationContext(req), {
        accountId: memberAccountId,
        role: roleField(body, "role"),
        state: membershipStateField(body, "state"),
        expectedVersion: numberField(body, "expected_version")
      });
      if (!changed.replayed) {
        await revalidateWorkspaceMemberSockets(io, store, context.workspaceId, memberAccountId);
        for (const roomId of changed.revalidationRoomIds) {
          await emitAuthorizedRoomWorkspaceEvent(io, store, { workspaceId: context.workspaceId, roomId, kind: "room.member.changed" });
        }
      }
      return changed;
    });
    res.json({ member: result.member, replayed: result.replayed });
  }));

  app.put("/api/workspaces/:workspaceId/rooms/:roomId/members/:accountId", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const roomId = pathParam(req, "roomId");
    const memberAccountId = pathParam(req, "accountId");
    const context = workspaceContext(req);
    const result = await realtimeGate.run(context.workspaceId, async () => {
      const changed = await commands.setRoomMember(operationContext(req), {
        roomId,
        accountId: memberAccountId,
        role: roleField(body, "role"),
        state: membershipStateField(body, "state"),
        expectedVersion: numberField(body, "expected_version")
      });
      if (!changed.replayed) {
        for (const affectedRoomId of changed.revalidationRoomIds) {
          await revalidateRoomMemberSockets(io, store, context.workspaceId, affectedRoomId, memberAccountId);
        }
        for (const affectedRoomId of changed.revalidationRoomIds) {
          await emitAuthorizedRoomWorkspaceEvent(io, store, { workspaceId: context.workspaceId, roomId: affectedRoomId, kind: "room.member.changed" });
        }
      }
      return changed;
    });
    res.json({ member: result.member, affected_room_ids: result.affectedRoomIds, replayed: result.replayed });
  }));

  app.post("/api/workspaces/:workspaceId/invitations", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const result = await commands.createInvitation(operationContext(req), {
      ...(optionalStringField(body, "room_id") ? { roomId: optionalStringField(body, "room_id") } : {}),
      workspaceRole: roleField(body, "workspace_role"),
      ...(optionalStringField(body, "room_role") ? { roomRole: roleField(body, "room_role") } : {}),
      expiresAt: stringField(body, "expires_at"),
      expectedWorkspaceVersion: numberField(body, "expected_workspace_version")
    });
    res.status(201).json({
      invitation: result.invitation,
      invite_token: result.token,
      ...(config.publicBaseUrl ? { invite_url: workspaceInvitationLink(config.publicBaseUrl, workspaceContext(req).workspaceId, result.token) } : {})
    });
  }));

  app.post("/api/workspaces/:workspaceId/invitations/accept", authenticateInvitationAcceptance, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const context = operationContext(req);
    const result = await realtimeGate.run(context.workspaceId, async () => {
      const accepted = await commands.acceptInvitation(context, stringField(body, "invite_token"));
      if (!accepted.replayed) {
        for (const roomId of accepted.revalidationRoomIds) {
          await revalidateRoomMemberSockets(io, store, context.workspaceId, roomId, context.accountId);
          await emitAuthorizedRoomWorkspaceEvent(io, store, {
            workspaceId: context.workspaceId,
            roomId,
            kind: "room.member.changed"
          });
        }
      }
      return accepted;
    });
    res.json({ accepted: result.accepted, replayed: result.replayed });
  }));

  app.post("/api/workspaces/:workspaceId/invitations/:invitationId/revoke", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    await commands.revokeInvitation(operationContext(req), pathParam(req, "invitationId"), numberField(body, "expected_version"));
    res.status(204).end();
  }));

  // The old learning projection remains readable while a Workspace is
  // migrated, but cannot become a second write path beside Completion.
  app.use("/api/workspaces/:workspaceId/learning", (req, _res, next) => {
    if (req.method === "POST" || req.method === "PUT" || req.method === "PATCH" || req.method === "DELETE") {
      next(new WorkspaceServerError("workspace_learning_legacy_write_retired", 410));
      return;
    }
    next();
  });

  // Historical read endpoints remain available for migration comparison.
  app.post("/api/workspaces/:workspaceId/learning/activities", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const context = operationContext(req);
    const result = await realtimeGate.run(context.workspaceId, async () => {
      const saved = await learning.ingestActivity(context, {
        ...(optionalStringField(body, "activity_id") ? { id: optionalStringField(body, "activity_id") } : {}),
        roomId: stringField(body, "room_id"),
        groupKey: stringField(body, "group_key"),
        sourceKind: stringField(body, "source_kind"),
        ...(optionalStringField(body, "source_id") ? { sourceId: optionalStringField(body, "source_id") } : {}),
        ...(optionalStringField(body, "correction_of_activity_id") ? { correctionOfActivityId: optionalStringField(body, "correction_of_activity_id") } : {}),
        instructionSummary: stringField(body, "instruction_summary"),
        ...(optionalStringField(body, "result_summary") ? { resultSummary: optionalStringField(body, "result_summary") } : {}),
        outcome: learningOutcomeField(body, "outcome"),
        verificationState: learningVerificationField(body, "verification_state"),
        failureState: learningFailureField(body, "failure_state"),
        ...(body.explicit_remember === undefined ? {} : { explicitRemember: booleanField(body, "explicit_remember") }),
        ...(body.finalized_resource === undefined ? {} : { finalizedResource: booleanField(body, "finalized_resource") }),
        ...(body.reusable_completion === undefined ? {} : { reusableCompletion: booleanField(body, "reusable_completion") }),
        ...(body.payload === undefined ? {} : { payload: learningPayloadField(body, "payload") })
      });
      if (!saved.replayed) {
        await emitAuthorizedRoomWorkspaceEvent(io, store, { workspaceId: context.workspaceId, roomId: saved.activity.roomId, kind: "learning.activity.ingested" });
        if (saved.job) learningRunner.schedule(context, { roomId: saved.activity.roomId });
      }
      return saved;
    });
    res.status(result.replayed ? 200 : 201).json(result);
  }));

  app.get("/api/workspaces/:workspaceId/learning/activities", authenticateWorkspace, asyncRoute(async (req, res) => {
    const roomId = queryString(req, "room_id");
    if (!roomId) throw new WorkspaceServerError("workspace_learning_room_id_required", 400);
    const activities = await learning.listActivities(workspaceContext(req), {
      roomId,
      ...(queryString(req, "group_key") ? { groupKey: queryString(req, "group_key") } : {}),
      ...(queryNumber(req, "limit") ? { limit: queryNumber(req, "limit") } : {})
    });
    res.json({ activities });
  }));

  app.post("/api/workspaces/:workspaceId/learning/activities/:activityId/resource-uses", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const context = operationContext(req);
    const result = await realtimeGate.run(context.workspaceId, async () => {
      const saved = await learning.recordResourceUse(context, {
        ...(optionalStringField(body, "resource_use_id") ? { id: optionalStringField(body, "resource_use_id") } : {}),
        resourceId: stringField(body, "resource_id"),
        resourceVersion: numberField(body, "resource_version"),
        activityId: pathParam(req, "activityId"),
        outcome: learningResourceUseOutcome(body, "outcome"),
        summary: stringField(body, "summary")
      });
      if (!saved.replayed) {
        await emitAuthorizedRoomWorkspaceEvent(io, store, { workspaceId: context.workspaceId, roomId: saved.roomId, kind: "learning.resource.used" });
        if (saved.job) learningRunner.schedule(context, { roomId: saved.roomId });
      }
      return saved;
    });
    res.status(result.replayed ? 200 : 201).json(result);
  }));

  app.post("/api/workspaces/:workspaceId/learning/resources", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const context = operationContext(req);
    const result = await realtimeGate.run(context.workspaceId, async () => {
      const saved = await learning.putResource(context, {
        scope: learningScopeField(body),
        kind: learningResourceKind(stringField(body, "kind")),
        ...(body.is_absolute_rule === undefined ? {} : { isAbsoluteRule: booleanField(body, "is_absolute_rule") }),
        title: stringField(body, "title"),
        content: stringField(body, "content"),
        ...(body.payload === undefined ? {} : { payload: learningPayloadField(body, "payload") }),
        reason: stringField(body, "reason"),
        ...(body.expected_version === undefined ? {} : { expectedVersion: numberField(body, "expected_version") })
      });
      if (!saved.replayed) await emitLearningResourceEvent(io, store, context.workspaceId, saved.resource, "learning.resource.created");
      return saved;
    });
    res.status(result.replayed ? 200 : 201).json(result);
  }));

  app.get("/api/workspaces/:workspaceId/learning/resources", authenticateWorkspace, asyncRoute(async (req, res) => {
    const scope = learningScopeQuery(req);
    const kind = queryString(req, "kind");
    const resources = await learning.listResources(workspaceContext(req), {
      scope,
      ...(kind ? { kind: learningResourceKind(kind) } : {}),
      ...(queryString(req, "include_archived") === "true" ? { includeArchived: true } : {}),
      ...(queryNumber(req, "limit") ? { limit: queryNumber(req, "limit") } : {})
    });
    res.json({ resources });
  }));

  app.get("/api/workspaces/:workspaceId/learning/resources/:resourceId", authenticateWorkspace, asyncRoute(async (req, res) => {
    const context = workspaceContext(req);
    const resourceId = pathParam(req, "resourceId");
    const [resource, versions, evidence] = await Promise.all([
      learning.getResource(context, resourceId),
      learning.listResourceVersions(context, resourceId),
      learning.listEvidence(context, resourceId)
    ]);
    res.json({ resource, versions, evidence });
  }));

  app.put("/api/workspaces/:workspaceId/learning/resources/:resourceId", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const context = operationContext(req);
    const result = await realtimeGate.run(context.workspaceId, async () => {
      const saved = await learning.putResource(context, {
        id: pathParam(req, "resourceId"),
        scope: learningScopeField(body),
        kind: learningResourceKind(stringField(body, "kind")),
        ...(body.is_absolute_rule === undefined ? {} : { isAbsoluteRule: booleanField(body, "is_absolute_rule") }),
        title: stringField(body, "title"),
        content: stringField(body, "content"),
        ...(body.payload === undefined ? {} : { payload: learningPayloadField(body, "payload") }),
        reason: stringField(body, "reason"),
        ...(body.expected_version === undefined ? {} : { expectedVersion: numberField(body, "expected_version") })
      });
      if (!saved.replayed) await emitLearningResourceEvent(io, store, context.workspaceId, saved.resource, "learning.resource.updated");
      return saved;
    });
    res.json(result);
  }));

  app.post("/api/workspaces/:workspaceId/learning/resources/:resourceId/fixed", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const context = operationContext(req);
    const result = await realtimeGate.run(context.workspaceId, async () => {
      const saved = await learning.setResourceFixed(context, {
        resourceId: pathParam(req, "resourceId"), fixed: booleanField(body, "fixed"),
        expectedVersion: numberField(body, "expected_version"), reason: stringField(body, "reason")
      });
      if (!saved.replayed) await emitLearningResourceEvent(io, store, context.workspaceId, saved.resource, "learning.resource.updated");
      return saved;
    });
    res.json(result);
  }));

  app.post("/api/workspaces/:workspaceId/learning/resources/:resourceId/archive", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const context = operationContext(req);
    const result = await realtimeGate.run(context.workspaceId, async () => {
      const saved = await learning.archiveResource(context, {
        resourceId: pathParam(req, "resourceId"), archived: booleanField(body, "archived"),
        expectedVersion: numberField(body, "expected_version"), reason: stringField(body, "reason")
      });
      if (!saved.replayed) await emitLearningResourceEvent(io, store, context.workspaceId, saved.resource, "learning.resource.updated");
      return saved;
    });
    res.json(result);
  }));

  app.post("/api/workspaces/:workspaceId/learning/resources/:resourceId/copy", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const context = operationContext(req);
    const result = await realtimeGate.run(context.workspaceId, async () => {
      const saved = await learning.copyResource(context, {
        resourceId: pathParam(req, "resourceId"), targetScope: learningTargetScopeField(body),
        ...(optionalStringField(body, "target_resource_id") ? { id: optionalStringField(body, "target_resource_id") } : {}),
        expectedVersion: numberField(body, "expected_version"), reason: stringField(body, "reason")
      });
      if (!saved.replayed) await emitLearningResourceEvent(io, store, context.workspaceId, saved.resource, "learning.resource.copied");
      return saved;
    });
    res.status(result.replayed ? 200 : 201).json(result);
  }));

  app.post("/api/workspaces/:workspaceId/learning/resources/:resourceId/move", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const context = operationContext(req);
    // Moving preserves an archived source projection. Notify both Room views,
    // while keeping the source Room identifier out of the target-room event.
    const source = await learning.getResource(workspaceContext(req), pathParam(req, "resourceId"));
    const sourceRoomId = source.scope.kind === "room" ? source.scope.roomId : undefined;
    const result = await realtimeGate.run(context.workspaceId, async () => {
      const saved = await learning.moveResource(context, {
        resourceId: pathParam(req, "resourceId"), targetRoomId: stringField(body, "target_room_id"),
        ...(optionalStringField(body, "target_resource_id") ? { targetResourceId: optionalStringField(body, "target_resource_id") } : {}),
        expectedVersion: numberField(body, "expected_version"), reason: stringField(body, "reason")
      });
      if (!saved.replayed) {
        if (sourceRoomId) {
          await emitAuthorizedRoomWorkspaceEvent(io, store, { workspaceId: context.workspaceId, roomId: sourceRoomId, kind: "learning.resource.moved" });
        }
        await emitLearningResourceEvent(io, store, context.workspaceId, saved.resource, "learning.resource.moved");
      }
      return saved;
    });
    res.json(result);
  }));

  app.post("/api/workspaces/:workspaceId/learning/resources/:resourceId/promote", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const context = operationContext(req);
    const result = await realtimeGate.run(context.workspaceId, async () => {
      const saved = await learning.promoteResource(context, {
        resourceId: pathParam(req, "resourceId"),
        ...(optionalStringField(body, "target_resource_id") ? { id: optionalStringField(body, "target_resource_id") } : {}),
        expectedVersion: numberField(body, "expected_version"), reason: stringField(body, "reason")
      });
      if (!saved.replayed) await emitLearningResourceEvent(io, store, context.workspaceId, saved.resource, "learning.resource.promoted");
      return saved;
    });
    res.status(result.replayed ? 200 : 201).json(result);
  }));

  app.get("/api/workspaces/:workspaceId/learning/search", authenticateWorkspace, asyncRoute(async (req, res) => {
    const roomId = queryString(req, "room_id");
    const query = queryString(req, "q");
    if (!roomId || !query) throw new WorkspaceServerError("workspace_learning_search_input_required", 400);
    res.json({ resources: await learning.searchKnowledge(workspaceContext(req), { roomId, query, ...(queryNumber(req, "limit") ? { limit: queryNumber(req, "limit") } : {}) }) });
  }));

  app.get("/api/workspaces/:workspaceId/learning/settings", authenticateWorkspace, asyncRoute(async (req, res) => {
    const roomId = queryString(req, "room_id");
    if (!roomId) throw new WorkspaceServerError("workspace_learning_room_id_required", 400);
    const layers = await learning.getSettingsLayers(workspaceContext(req), roomId);
    res.json({
      settings: publicLearningSettings(layers.effective),
      ...(layers.workspace ? { workspace_settings: publicLearningSettings(layers.workspace) } : {}),
      ...(layers.room ? { room_settings: publicLearningSettings(layers.room) } : {})
    });
  }));

  app.put("/api/workspaces/:workspaceId/learning/settings", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const context = operationContext(req);
    const result = await realtimeGate.run(context.workspaceId, async () => {
      const scope = learningScopeField(body);
      const saved = await learning.updateSettings(context, {
        scope,
        ...(body.enabled === undefined ? {} : { enabled: booleanField(body, "enabled") }),
        ...(optionalStringField(body, "engine_id") ? { engineId: optionalStringField(body, "engine_id") } : {}),
        ...(optionalStringField(body, "model") ? { model: optionalStringField(body, "model") } : {}),
        ...(optionalStringField(body, "secret_ref") ? { secretRef: optionalStringField(body, "secret_ref") } : {}),
        ...(body.currency_limit === undefined ? {} : { currencyLimit: nonnegativeNumberField(body, "currency_limit") }),
        ...(body.token_limit === undefined ? {} : { tokenLimit: nonnegativeNumberField(body, "token_limit") }),
        ...(body.clear_engine_id === undefined ? {} : { clearEngineId: booleanField(body, "clear_engine_id") }),
        ...(body.clear_model === undefined ? {} : { clearModel: booleanField(body, "clear_model") }),
        ...(body.clear_secret_ref === undefined ? {} : { clearSecretRef: booleanField(body, "clear_secret_ref") }),
        ...(body.clear_currency_limit === undefined ? {} : { clearCurrencyLimit: booleanField(body, "clear_currency_limit") }),
        ...(body.clear_token_limit === undefined ? {} : { clearTokenLimit: booleanField(body, "clear_token_limit") }),
        ...(body.remove_override === undefined ? {} : { removeOverride: booleanField(body, "remove_override") }),
        ...(body.expected_version === undefined ? {} : { expectedVersion: numberField(body, "expected_version") })
      });
      if (!saved.replayed) {
        if (scope.kind === "room") {
          await emitAuthorizedRoomWorkspaceEvent(io, store, { workspaceId: context.workspaceId, roomId: scope.roomId!, kind: "learning.settings.updated" });
          learningRunner.schedule(context, { roomId: scope.roomId });
        } else {
          await emitAuthorizedWorkspaceEvent(io, store, { workspaceId: context.workspaceId, kind: "learning.settings.updated" });
          learningRunner.schedule(context);
        }
      }
      return saved;
    });
    res.json({ settings: publicLearningSettings(result.settings), replayed: result.replayed });
  }));

  app.get("/api/workspaces/:workspaceId/learning/jobs", authenticateWorkspace, asyncRoute(async (req, res) => {
    const roomId = queryString(req, "room_id");
    if (!roomId) throw new WorkspaceServerError("workspace_learning_room_id_required", 400);
    res.json({ jobs: await learning.listJobs(workspaceContext(req), { roomId, ...(queryString(req, "status") ? { status: learningJobStatus(queryString(req, "status")!) } : {}), ...(queryNumber(req, "limit") ? { limit: queryNumber(req, "limit") } : {}) }) });
  }));

  app.get("/api/workspaces/:workspaceId/learning/jobs/:jobId/attempts", authenticateWorkspace, asyncRoute(async (req, res) => {
    res.json({ attempts: await learning.listJobAttempts(workspaceContext(req), pathParam(req, "jobId")) });
  }));

  // Server 04 completion contract. These routes are deliberately separate
  // from the legacy /learning store: they read file-backed bodies only via
  // the Workspace Server Command boundary.
  app.post("/api/workspaces/:workspaceId/completion/activities", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const context = operationContext(req);
    const result = await realtimeGate.run(context.workspaceId, async () => {
      const saved = await commands.ingestCompletionActivity(context, {
        ...(optionalStringField(body, "activity_id") ? { id: optionalStringField(body, "activity_id") } : {}),
        roomId: stringField(body, "room_id"),
        ...(optionalStringField(body, "episode_id") ? { episodeId: optionalStringField(body, "episode_id") } : {}),
        ...(optionalStringField(body, "goal") ? { goal: optionalStringField(body, "goal") } : {}),
        sourceApp: stringField(body, "source_app"),
        ...(optionalStringField(body, "source_id") ? { sourceId: optionalStringField(body, "source_id") } : {}),
        ...(optionalStringField(body, "external_episode_key") ? { externalEpisodeKey: optionalStringField(body, "external_episode_key") } : {}),
        ...(optionalStringField(body, "correction_of_activity_id") ? { correctionOfActivityId: optionalStringField(body, "correction_of_activity_id") } : {}),
        ...(optionalStringField(body, "operation_id") ? { operationId: optionalStringField(body, "operation_id") } : {}),
        instructionSummary: stringField(body, "instruction_summary"),
        ...(optionalStringField(body, "result_summary") ? { resultSummary: optionalStringField(body, "result_summary") } : {}),
        ...(body.changed_resources === undefined ? {} : { changedResources: stringArrayField(body, "changed_resources") }),
        verificationOutcome: completionVerificationField(body, "verification_outcome"),
        failureState: completionFailureField(body, "failure_state"),
        outcome: completionOutcomeField(body, "outcome"),
        ...(body.explicit_remember === undefined ? {} : { explicitRemember: booleanField(body, "explicit_remember") }),
        ...(body.payload === undefined ? {} : { payload: completionPayloadField(body, "payload") }),
        ...(body.session_ref === undefined ? {} : { sessionRef: completionSessionRefField(body, "session_ref") })
      });
      if (!saved.replayed) await emitAuthorizedRoomWorkspaceEvent(io, store, { workspaceId: context.workspaceId, roomId: saved.activity.roomId, kind: "completion.activity.ingested" });
      return saved;
    });
    res.status(result.replayed ? 200 : 201).json(result);
  }));
  app.get("/api/workspaces/:workspaceId/completion/activities/:activityId", authenticateWorkspace, asyncRoute(async (req, res) => {
    res.json({ activity: await completion.getActivity(workspaceContext(req), pathParam(req, "activityId")) });
  }));
  app.get("/api/workspaces/:workspaceId/completion/activities/:activityId/evidence", authenticateWorkspace, asyncRoute(async (req, res) => {
    res.json({ evidence: await completion.listActivityEvidence(workspaceContext(req), pathParam(req, "activityId"), queryNumber(req, "limit")) });
  }));

  app.post("/api/workspaces/:workspaceId/completion/episodes", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const result = await commands.createCompletionEpisode(operationContext(req), {
      ...(optionalStringField(body, "episode_id") ? { id: optionalStringField(body, "episode_id") } : {}),
      roomId: stringField(body, "room_id"), goal: stringField(body, "goal"),
      ...(optionalStringField(body, "source_app") ? { sourceApp: optionalStringField(body, "source_app") } : {}),
      ...(optionalStringField(body, "external_episode_key") ? { externalEpisodeKey: optionalStringField(body, "external_episode_key") } : {}),
      ...(body.session_ref === undefined ? {} : { sessionRef: completionSessionRefField(body, "session_ref") })
    });
    res.status(result.replayed ? 200 : 201).json(result);
  }));

  app.get("/api/workspaces/:workspaceId/completion/episodes/:episodeId", authenticateWorkspace, asyncRoute(async (req, res) => {
    const context = workspaceContext(req);
    const episodeId = pathParam(req, "episodeId");
    const [episode, activities] = await Promise.all([completion.getEpisode(context, episodeId), completion.listEpisodeActivities(context, episodeId, queryNumber(req, "limit"))]);
    res.json({ episode, activities });
  }));
  app.get("/api/workspaces/:workspaceId/completion/episodes/:episodeId/evidence", authenticateWorkspace, asyncRoute(async (req, res) => {
    res.json({ evidence: await completion.listEpisodeEvidence(workspaceContext(req), pathParam(req, "episodeId"), queryNumber(req, "limit")) });
  }));

  app.post("/api/workspaces/:workspaceId/completion/resources", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const context = operationContext(req);
    const result = await realtimeGate.run(context.workspaceId, async () => {
      const saved = await commands.createCompletionResource(context, completionResourceInput(body));
      if (!saved.replayed) await emitCompletionResourceEvent(io, store, context.workspaceId, saved.resource, "completion.resource.created");
      return saved;
    });
    res.status(result.replayed ? 200 : 201).json(result);
  }));

  app.put("/api/workspaces/:workspaceId/completion/resources/:resourceId", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const context = operationContext(req);
    const result = await realtimeGate.run(context.workspaceId, async () => {
      const input = completionResourceInput(body);
      if (input.expectedVersion === undefined) throw new WorkspaceServerError("workspace_completion_resource_version_required", 400);
      const saved = await commands.updateCompletionResource(context, pathParam(req, "resourceId"), input as typeof input & { expectedVersion: number });
      if (!saved.replayed) await emitCompletionResourceEvent(io, store, context.workspaceId, saved.resource, "completion.resource.updated");
      return saved;
    });
    res.json(result);
  }));

  app.get("/api/workspaces/:workspaceId/completion/resources", authenticateWorkspace, asyncRoute(async (req, res) => {
    const kind = queryString(req, "kind");
    const page = await completion.listResourcesPage(workspaceContext(req), {
      ...(queryString(req, "room_id") ? { roomId: queryString(req, "room_id")! } : {}),
      ...(kind ? { kind: completionResourceKind(kind) } : {}),
      ...(queryString(req, "include_archived") === "true" ? { includeArchived: true } : {}),
      ...(queryNumber(req, "limit") ? { limit: queryNumber(req, "limit") } : {}),
      ...(queryString(req, "cursor") ? { cursor: queryString(req, "cursor") } : {})
    });
    res.json({ resources: page.items, ...(page.nextCursor ? { next_cursor: page.nextCursor } : {}) });
  }));

  app.get("/api/workspaces/:workspaceId/completion/resources/:resourceId", authenticateWorkspace, asyncRoute(async (req, res) => {
    const context = workspaceContext(req);
    const resourceId = pathParam(req, "resourceId");
    const [current, versions, evidence] = await Promise.all([
      completion.getResource(context, resourceId),
      completion.listResourceVersions(context, resourceId, queryNumber(req, "versions_limit")),
      completion.listEvidence(context, resourceId, queryNumber(req, "evidence_limit"))
    ]);
    res.json({ resource: current.resource, current_version: current.version, versions, evidence });
  }));

  app.get("/api/workspaces/:workspaceId/completion/resources/:resourceId/body", authenticateWorkspace, asyncRoute(async (req, res) => {
    const version = queryNumber(req, "version");
    res.json(await completion.getResourceBody(workspaceContext(req), pathParam(req, "resourceId"), version));
  }));

  app.post("/api/workspaces/:workspaceId/completion/resources/:resourceId/fixed", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const context = operationContext(req);
    const result = await realtimeGate.run(context.workspaceId, async () => {
      const saved = await commands.setCompletionResourceFixed(context, { resourceId: pathParam(req, "resourceId"), fixed: booleanField(body, "fixed"), expectedVersion: numberField(body, "expected_version"), reason: stringField(body, "reason") });
      if (!saved.replayed) await emitCompletionResourceEvent(io, store, context.workspaceId, saved.resource, "completion.resource.updated");
      return saved;
    });
    res.json(result);
  }));

  app.post("/api/workspaces/:workspaceId/completion/resources/:resourceId/archive", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const context = operationContext(req);
    const result = await realtimeGate.run(context.workspaceId, async () => {
      const saved = await commands.setCompletionResourceArchived(context, { resourceId: pathParam(req, "resourceId"), archived: booleanField(body, "archived"), expectedVersion: numberField(body, "expected_version"), reason: stringField(body, "reason") });
      if (!saved.replayed) await emitCompletionResourceEvent(io, store, context.workspaceId, saved.resource, "completion.resource.updated");
      return saved;
    });
    res.json(result);
  }));

  app.post("/api/workspaces/:workspaceId/completion/resources/:resourceId/redact", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const context = operationContext(req);
    const resource = await completion.getResource(workspaceContext(req), pathParam(req, "resourceId"));
    const result = await realtimeGate.run(context.workspaceId, async () => {
      const saved = await commands.redactCompletionResource(context, { resourceId: pathParam(req, "resourceId"), reason: stringField(body, "reason") });
      if (!saved.replayed) await emitCompletionResourceEvent(io, store, context.workspaceId, resource.resource, "completion.resource.redacted");
      return saved;
    });
    res.json(result);
  }));

  app.post("/api/workspaces/:workspaceId/completion/jobs/raw-outputs/:rawOutputId/redact", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const result = await commands.redactCompletionRawJobOutput(operationContext(req), {
      rawOutputId: pathParam(req, "rawOutputId"), reason: stringField(body, "reason")
    });
    res.json(result);
  }));

  app.post("/api/workspaces/:workspaceId/completion/resources/:resourceId/promote", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const context = operationContext(req);
    const result = await realtimeGate.run(context.workspaceId, async () => {
      const saved = await commands.promoteCompletionCandidate(context, { resourceId: pathParam(req, "resourceId"), expectedVersion: numberField(body, "expected_version"), reason: stringField(body, "reason") });
      if (!saved.replayed) await emitCompletionResourceEvent(io, store, context.workspaceId, saved.resource, "completion.resource.promoted");
      return saved;
    });
    res.json(result);
  }));

  app.post("/api/workspaces/:workspaceId/completion/resources/:resourceId/copy", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const context = operationContext(req);
    const result = await realtimeGate.run(context.workspaceId, async () => {
      const saved = await commands.copyCompletionResource(context, {
        resourceId: pathParam(req, "resourceId"), targetScope: completionTargetScopeField(body),
        ...(optionalStringField(body, "target_resource_id") ? { targetResourceId: optionalStringField(body, "target_resource_id") } : {}),
        expectedVersion: numberField(body, "expected_version"), reason: stringField(body, "reason")
      });
      if (!saved.replayed) await emitCompletionResourceEvent(io, store, context.workspaceId, saved.resource, "completion.resource.copied");
      return saved;
    });
    res.status(result.replayed ? 200 : 201).json(result);
  }));

  app.post("/api/workspaces/:workspaceId/completion/resources/:resourceId/move", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const context = operationContext(req);
    const result = await realtimeGate.run(context.workspaceId, async () => {
      const saved = await commands.moveCompletionResource(context, {
        resourceId: pathParam(req, "resourceId"), targetRoomId: stringField(body, "target_room_id"),
        ...(optionalStringField(body, "target_resource_id") ? { targetResourceId: optionalStringField(body, "target_resource_id") } : {}),
        expectedVersion: numberField(body, "expected_version"), reason: stringField(body, "reason")
      });
      if (!saved.replayed) await emitCompletionResourceEvent(io, store, context.workspaceId, saved.resource, "completion.resource.moved");
      return saved;
    });
    res.status(result.replayed ? 200 : 201).json(result);
  }));

  app.post("/api/workspaces/:workspaceId/completion/resources/:resourceId/promote-to-workspace", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const context = operationContext(req);
    const result = await realtimeGate.run(context.workspaceId, async () => {
      const saved = await commands.promoteCompletionResourceToWorkspace(context, {
        resourceId: pathParam(req, "resourceId"), ...(optionalStringField(body, "target_resource_id") ? { targetResourceId: optionalStringField(body, "target_resource_id") } : {}),
        expectedVersion: numberField(body, "expected_version"), reason: stringField(body, "reason")
      });
      if (!saved.replayed) await emitCompletionResourceEvent(io, store, context.workspaceId, saved.resource, "completion.resource.promoted_to_workspace");
      return saved;
    });
    res.status(result.replayed ? 200 : 201).json(result);
  }));

  app.get("/api/workspaces/:workspaceId/completion/knowledge/search", authenticateWorkspace, asyncRoute(async (req, res) => {
    const roomId = queryString(req, "room_id");
    const query = queryString(req, "q");
    if (!roomId || !query) throw new WorkspaceServerError("workspace_completion_search_input_required", 400);
    const page = await completion.searchKnowledgePage(workspaceContext(req), {
      roomId,
      query,
      ...(queryNumber(req, "limit") ? { limit: queryNumber(req, "limit") } : {}),
      ...(queryString(req, "cursor") ? { cursor: queryString(req, "cursor") } : {})
    });
    res.json({ resources: page.items, ...(page.nextCursor ? { next_cursor: page.nextCursor } : {}) });
  }));

  app.get("/api/workspaces/:workspaceId/completion/skills/search", authenticateWorkspace, asyncRoute(async (req, res) => {
    const roomId = queryString(req, "room_id");
    const query = queryString(req, "q");
    if (!roomId || !query) throw new WorkspaceServerError("workspace_completion_search_input_required", 400);
    const page = await completion.searchSkillsPage(workspaceContext(req), {
      roomId,
      query,
      ...(queryNumber(req, "limit") ? { limit: queryNumber(req, "limit") } : {}),
      ...(queryString(req, "cursor") ? { cursor: queryString(req, "cursor") } : {})
    });
    res.json({ skills: page.items, ...(page.nextCursor ? { next_cursor: page.nextCursor } : {}) });
  }));

  app.get("/api/workspaces/:workspaceId/completion/skills", authenticateWorkspace, asyncRoute(async (req, res) => {
    const roomId = queryString(req, "room_id");
    if (!roomId) throw new WorkspaceServerError("workspace_completion_room_id_required", 400);
    const page = await completion.listSkillsPage(workspaceContext(req), {
      roomId,
      ...(queryNumber(req, "limit") ? { limit: queryNumber(req, "limit") } : {}),
      ...(queryString(req, "cursor") ? { cursor: queryString(req, "cursor") } : {})
    });
    res.json({ skills: page.items, ...(page.nextCursor ? { next_cursor: page.nextCursor } : {}) });
  }));
  app.get("/api/workspaces/:workspaceId/completion/skills/:resourceId/files", authenticateWorkspace, asyncRoute(async (req, res) => {
    res.json({ files: await completion.listSkillFiles(workspaceContext(req), pathParam(req, "resourceId"), queryNumber(req, "version"), queryNumber(req, "limit")) });
  }));
  app.get("/api/workspaces/:workspaceId/completion/skills/:resourceId/files/{*filePath}", authenticateWorkspace, asyncRoute(async (req, res) => {
    const result = await completion.getSkillFile(workspaceContext(req), pathParam(req, "resourceId"), wildcardParam(req.params.filePath), queryNumber(req, "version"));
    res.setHeader("content-type", "application/octet-stream");
    res.setHeader("x-samurai-file-sha256", result.file.contentHash);
    res.send(result.content);
  }));
  app.get("/api/workspaces/:workspaceId/completion/skills/:resourceId", authenticateWorkspace, asyncRoute(async (req, res) => {
    res.json(await completion.getSkillDocument(workspaceContext(req), pathParam(req, "resourceId"), queryNumber(req, "version")));
  }));

  app.post("/api/workspaces/:workspaceId/completion/resources/:resourceId/uses", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const context = operationContext(req);
    const result = await realtimeGate.run(context.workspaceId, async () => {
      const saved = await commands.recordCompletionUse(context, {
        ...(optionalStringField(body, "use_id") ? { id: optionalStringField(body, "use_id") } : {}), resourceId: pathParam(req, "resourceId"),
        resourceVersion: numberField(body, "resource_version"), ...(optionalStringField(body, "activity_id") ? { activityId: optionalStringField(body, "activity_id") } : {}),
        ...(optionalStringField(body, "episode_id") ? { episodeId: optionalStringField(body, "episode_id") } : {}), event: completionUseEventField(body, "event"),
        ...(optionalStringField(body, "outcome") ? { outcome: completionUseOutcomeField(body, "outcome") } : {}),
        ...(optionalStringField(body, "supersedes_use_id") ? { supersedesUseId: optionalStringField(body, "supersedes_use_id") } : {}), summary: stringField(body, "summary")
      });
      if (!saved.replayed) {
        const resource = await completion.getResource(workspaceContext(req), saved.use.resourceId);
        await emitCompletionResourceEvent(io, store, context.workspaceId, resource.resource, "completion.resource.used");
      }
      return saved;
    });
    res.status(result.replayed ? 200 : 201).json(result);
  }));

  app.post("/api/workspaces/:workspaceId/completion/evaluations", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const context = operationContext(req);
    const result = await realtimeGate.run(context.workspaceId, async () => {
      const saved = await commands.recordCompletionEvaluation(context, {
        ...(optionalStringField(body, "evaluation_id") ? { id: optionalStringField(body, "evaluation_id") } : {}), resourceId: stringField(body, "resource_id"), resourceVersion: numberField(body, "resource_version"),
        episodeId: stringField(body, "episode_id"), outcome: completionUseOutcomeField(body, "outcome"),
        ...(optionalStringField(body, "source_activity_id") ? { sourceActivityId: optionalStringField(body, "source_activity_id") } : {}),
        ...(optionalStringField(body, "correction_of_evaluation_id") ? { correctionOfEvaluationId: optionalStringField(body, "correction_of_evaluation_id") } : {})
      });
      if (!saved.replayed) {
        const resource = await completion.getResource(workspaceContext(req), saved.evaluation.resourceId);
        await emitCompletionResourceEvent(io, store, context.workspaceId, resource.resource, "completion.resource.evaluated");
      }
      return saved;
    });
    res.status(result.replayed ? 200 : 201).json(result);
  }));
  app.get("/api/workspaces/:workspaceId/completion/resources/:resourceId/evaluations", authenticateWorkspace, asyncRoute(async (req, res) => {
    res.json(await completion.listEvaluations(workspaceContext(req), {
      resourceId: pathParam(req, "resourceId"),
      ...(queryNumber(req, "version") ? { resourceVersion: queryNumber(req, "version") } : {}),
      ...(queryString(req, "episode_id") ? { episodeId: queryString(req, "episode_id")! } : {}),
      ...(queryNumber(req, "limit") ? { limit: queryNumber(req, "limit") } : {})
    }));
  }));

  app.get("/api/workspaces/:workspaceId/completion/configuration", authenticateWorkspace, asyncRoute(async (req, res) => {
    const roomId = queryString(req, "room_id");
    if (!roomId) throw new WorkspaceServerError("workspace_completion_room_id_required", 400);
    res.json({ configuration: await completion.getEffectiveConfiguration(workspaceContext(req), roomId) });
  }));
  app.get("/api/workspaces/:workspaceId/completion/maintenance", authenticateWorkspace, asyncRoute(async (req, res) => {
    res.json(await maintenance.getIdentity(workspaceContext(req)));
  }));
  app.put("/api/workspaces/:workspaceId/completion/maintenance", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const saved = await commands.configureCompletionMaintenanceIdentity(operationContext(req), { accountId: stringField(body, "account_id") });
    res.json(saved);
  }));
  app.get("/api/workspaces/:workspaceId/completion/migrations/legacy", authenticateWorkspace, asyncRoute(async (req, res) => {
    res.json({ preview: await completionMigrations.previewLegacy(workspaceContext(req)) });
  }));
  app.post("/api/workspaces/:workspaceId/completion/migrations/legacy", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const result = await commands.migrateCompletionLegacy(operationContext(req), {
      ...(body.dry_run === undefined ? {} : { dryRun: booleanField(body, "dry_run") })
    });
    res.json(result);
  }));
  app.put("/api/workspaces/:workspaceId/completion/configuration", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const result = await commands.updateCompletionConfiguration(operationContext(req), {
      scope: completionScopeField(body),
      ...(body.expected_version === undefined ? {} : { expectedVersion: numberField(body, "expected_version") }),
      values: objectField(body, "values")
    });
    res.json(result);
  }));
  app.get("/api/workspaces/:workspaceId/completion/startup-context", authenticateWorkspace, asyncRoute(async (req, res) => {
    const roomId = queryString(req, "room_id");
    const operation = queryString(req, "operation");
    if (!roomId || !operation) throw new WorkspaceServerError("workspace_completion_startup_context_input_required", 400);
    res.json(await completion.getStartupContext(workspaceContext(req), { roomId, operation: completionPolicyOperation(operation) }));
  }));

  app.get("/api/workspaces/:workspaceId/completion/profile", authenticateWorkspace, asyncRoute(async (req, res) => {
    res.json(await completion.getWorkspaceDocument(workspaceContext(req), "profile"));
  }));
  app.put("/api/workspaces/:workspaceId/completion/profile", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    res.json(await commands.writeCompletionWorkspaceDocument(operationContext(req), { kind: "profile", content: stringField(body, "content"), expectedVersion: numberField(body, "expected_version") }));
  }));
  app.get("/api/workspaces/:workspaceId/completion/soul", authenticateWorkspace, asyncRoute(async (req, res) => {
    res.json(await completion.getWorkspaceDocument(workspaceContext(req), "soul"));
  }));
  app.put("/api/workspaces/:workspaceId/completion/soul", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    res.json(await commands.writeCompletionWorkspaceDocument(operationContext(req), { kind: "soul", content: stringField(body, "content"), expectedVersion: numberField(body, "expected_version") }));
  }));

  app.post("/api/workspaces/:workspaceId/completion/policies/requests", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const result = await commands.requestCompletionPolicyChange(operationContext(req), {
      ...(optionalStringField(body, "request_id") ? { id: optionalStringField(body, "request_id") } : {}), roomId: stringField(body, "room_id"), summary: stringField(body, "summary"), proposedRules: body.proposed_rules,
      ...(optionalStringField(body, "source_job_id") ? { sourceJobId: optionalStringField(body, "source_job_id") } : {})
    });
    res.status(result.replayed ? 200 : 201).json(result);
  }));

  app.post("/api/workspaces/:workspaceId/completion/policies", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const result = await commands.applyCompletionPolicy(operationContext(req), {
      ...(optionalStringField(body, "policy_id") ? { id: optionalStringField(body, "policy_id") } : {}), scope: completionScopeField(body), title: stringField(body, "title"), content: stringField(body, "content"),
      rules: body.rules, reason: stringField(body, "reason"),
      ...(body.expected_version === undefined ? {} : { expectedVersion: numberField(body, "expected_version") }),
      ...(body.enabled === undefined ? {} : { enabled: booleanField(body, "enabled") })
    });
    res.status(result.replayed ? 200 : 201).json(result);
  }));
  app.get("/api/workspaces/:workspaceId/completion/policies", authenticateWorkspace, asyncRoute(async (req, res) => {
    const page = await completion.listResourcesPage(workspaceContext(req), {
      ...(queryString(req, "room_id") ? { roomId: queryString(req, "room_id")! } : {}),
      kind: "policy",
      includeArchived: queryString(req, "include_archived") === "true",
      ...(queryNumber(req, "limit") ? { limit: queryNumber(req, "limit") } : {}),
      ...(queryString(req, "cursor") ? { cursor: queryString(req, "cursor") } : {})
    });
    res.json({ policies: page.items, ...(page.nextCursor ? { next_cursor: page.nextCursor } : {}) });
  }));
  app.get("/api/workspaces/:workspaceId/completion/policies/requests", authenticateWorkspace, asyncRoute(async (req, res) => {
    res.json({ requests: await completion.listPolicyChangeRequests(workspaceContext(req), {
      ...(queryString(req, "room_id") ? { roomId: queryString(req, "room_id")! } : {}),
      ...(queryNumber(req, "limit") ? { limit: queryNumber(req, "limit") } : {})
    }) });
  }));
  app.get("/api/workspaces/:workspaceId/completion/policies/:policyId", authenticateWorkspace, asyncRoute(async (req, res) => {
    res.json(await completion.getPolicy(workspaceContext(req), pathParam(req, "policyId")));
  }));
  app.get("/api/workspaces/:workspaceId/completion/policies/:policyId/audit", authenticateWorkspace, asyncRoute(async (req, res) => {
    const policy = await completion.getPolicy(workspaceContext(req), pathParam(req, "policyId"));
    const entries = await store.listAuditEntries(workspaceContext(req), {
      ...(queryNumber(req, "after") !== undefined ? { afterId: queryNumber(req, "after") } : {}),
      ...(queryNumber(req, "limit") ? { limit: queryNumber(req, "limit") } : {}),
      subjectKind: "completion_policy",
      subjectId: policy.resource.id
    });
    res.json({ entries });
  }));

  app.get("/api/workspaces/:workspaceId/completion/jobs", authenticateWorkspace, asyncRoute(async (req, res) => {
    const roomId = queryString(req, "room_id");
    if (!roomId) throw new WorkspaceServerError("workspace_completion_room_id_required", 400);
    const page = await completionJobs.listJobsPage(workspaceContext(req), {
      roomId,
      ...(queryString(req, "status") ? { status: completionJobStatusField(queryString(req, "status")!) } : {}),
      ...(queryNumber(req, "limit") ? { limit: queryNumber(req, "limit") } : {}),
      ...(queryString(req, "cursor") ? { cursor: queryString(req, "cursor") } : {})
    });
    res.json({ jobs: page.items, ...(page.nextCursor ? { next_cursor: page.nextCursor } : {}) });
  }));
  app.get("/api/workspaces/:workspaceId/completion/jobs/:jobId/attempts", authenticateWorkspace, asyncRoute(async (req, res) => {
    res.json({ attempts: await completionJobs.listAttempts(workspaceContext(req), pathParam(req, "jobId"), queryNumber(req, "limit")) });
  }));

  app.get("/api/workspaces/:workspaceId/completion/curator", authenticateWorkspace, asyncRoute(async (req, res) => {
    const roomId = queryString(req, "room_id");
    if (!roomId) throw new WorkspaceServerError("workspace_completion_room_id_required", 400);
    res.json(await curator.getStatus(workspaceContext(req), roomId));
  }));
  app.post("/api/workspaces/:workspaceId/completion/curator/dry-run", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    res.json(await curator.dryRun(workspaceContext(req), stringField(body, "room_id")));
  }));
  app.post("/api/workspaces/:workspaceId/completion/curator/semantic/dry-run", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    if (!options.semanticCuratorPort) throw new WorkspaceServerError("workspace_completion_semantic_curator_unavailable", 503);
    res.json(await curator.runSemantic(operationContext(req), {
      roomId: stringField(body, "room_id"), port: options.semanticCuratorPort, dryRun: true
    }));
  }));
  app.post("/api/workspaces/:workspaceId/completion/curator/run", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    res.json(await curator.runLight(operationContext(req), { roomId: stringField(body, "room_id"), ...(body.dry_run === undefined ? {} : { dryRun: booleanField(body, "dry_run") }) }));
  }));
  app.post("/api/workspaces/:workspaceId/completion/curator/pause", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body); await curator.setPaused(operationContext(req), { roomId: stringField(body, "room_id"), paused: true }); res.status(204).end();
  }));
  app.post("/api/workspaces/:workspaceId/completion/curator/resume", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body); await curator.setPaused(operationContext(req), { roomId: stringField(body, "room_id"), paused: false }); res.status(204).end();
  }));
  app.put("/api/workspaces/:workspaceId/completion/curator/semantic", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    await curator.setSemanticEnabled(operationContext(req), { roomId: stringField(body, "room_id"), enabled: booleanField(body, "enabled") });
    res.status(204).end();
  }));
  app.get("/api/workspaces/:workspaceId/completion/curator/snapshots", authenticateWorkspace, asyncRoute(async (req, res) => {
    const roomId = queryString(req, "room_id"); if (!roomId) throw new WorkspaceServerError("workspace_completion_room_id_required", 400);
    res.json({ snapshots: await curator.listSnapshots(workspaceContext(req), roomId) });
  }));
  app.post("/api/workspaces/:workspaceId/completion/curator/snapshots/:snapshotId/rollback", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body); await curator.rollbackSnapshot(operationContext(req), { roomId: stringField(body, "room_id"), snapshotId: pathParam(req, "snapshotId") }); res.status(204).end();
  }));
  app.get("/api/workspaces/:workspaceId/completion/curator/archives", authenticateWorkspace, asyncRoute(async (req, res) => {
    const roomId = queryString(req, "room_id");
    if (!roomId) throw new WorkspaceServerError("workspace_completion_room_id_required", 400);
    const page = await completion.listArchivedAiResourcesPage(workspaceContext(req), {
      roomId,
      ...(queryNumber(req, "limit") ? { limit: queryNumber(req, "limit") } : {}),
      ...(queryString(req, "cursor") ? { cursor: queryString(req, "cursor") } : {})
    });
    res.json({ archives: page.items, ...(page.nextCursor ? { next_cursor: page.nextCursor } : {}) });
  }));
  app.post("/api/workspaces/:workspaceId/completion/curator/archives/:resourceId/restore", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const roomId = stringField(body, "room_id");
    const context = operationContext(req);
    const result = await realtimeGate.run(context.workspaceId, async () => {
      const current = await completion.getResource(workspaceContext(req), pathParam(req, "resourceId"));
      if (current.resource.scope.kind !== "room" || current.resource.scope.roomId !== roomId
        || current.resource.creationSource !== "ai" || !current.resource.aiManaged || current.resource.lifecycleState !== "archived") {
        throw new WorkspaceServerError("workspace_completion_curator_archive_not_found", 404);
      }
      const saved = await commands.setCompletionResourceArchived(context, {
        resourceId: current.resource.id,
        archived: false,
        expectedVersion: numberField(body, "expected_version"),
        reason: stringField(body, "reason")
      });
      if (!saved.replayed) await emitCompletionResourceEvent(io, store, context.workspaceId, saved.resource, "completion.curator.archive_restored");
      return saved;
    });
    res.json(result);
  }));

  app.get("/api/workspaces/:workspaceId/records", authenticateWorkspace, asyncRoute(async (req, res) => {
    const roomId = queryString(req, "room_id");
    if (!roomId) throw new WorkspaceServerError("workspace_records_room_id_required", 400);
    const records = await store.listRecords(workspaceContext(req), {
      roomId,
      ...(queryString(req, "record_type") ? { recordType: queryString(req, "record_type") } : {}),
      ...(queryNumber(req, "limit") ? { limit: queryNumber(req, "limit") } : {})
    });
    res.json({ records });
  }));

  app.get("/api/workspaces/:workspaceId/records/:recordType/:recordId", authenticateWorkspace, asyncRoute(async (req, res) => {
    const roomId = queryString(req, "room_id");
    if (!roomId) throw new WorkspaceServerError("workspace_record_room_id_required", 400);
    res.json({ record: await store.getRecord(workspaceContext(req), { roomId, recordType: pathParam(req, "recordType"), id: pathParam(req, "recordId") }) });
  }));

  app.put("/api/workspaces/:workspaceId/records/:recordType/:recordId", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const context = workspaceContext(req);
    const result = await realtimeGate.run(context.workspaceId, async () => {
      const saved = await commands.putRecord(operationContext(req), {
        roomId: stringField(body, "room_id"),
        recordType: pathParam(req, "recordType"),
        id: pathParam(req, "recordId"),
        expectedVersion: numberField(body, "expected_version"),
        payload: objectField(body, "payload"),
        ...(optionalStringField(body, "search_text") ? { searchText: optionalStringField(body, "search_text") } : {})
      });
      if (!saved.replayed) await emitAuthorizedRoomWorkspaceEvent(io, store, saved.event);
      return saved;
    });
    res.json(result);
  }));

  app.delete("/api/workspaces/:workspaceId/records/:recordType/:recordId", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const context = workspaceContext(req);
    const result = await realtimeGate.run(context.workspaceId, async () => {
      const deleted = await commands.deleteRecord(operationContext(req), {
        roomId: stringField(body, "room_id"),
        recordType: pathParam(req, "recordType"),
        id: pathParam(req, "recordId"),
        expectedVersion: numberField(body, "expected_version")
      });
      if (!deleted.replayed) await emitAuthorizedRoomWorkspaceEvent(io, store, deleted.event);
      return deleted;
    });
    res.json(result);
  }));

  app.get("/api/workspaces/:workspaceId/search", authenticateWorkspace, asyncRoute(async (req, res) => {
    const query = queryString(req, "q");
    if (!query) throw new WorkspaceServerError("workspace_search_query_required", 400);
    const roomId = queryString(req, "room_id");
    if (!roomId) throw new WorkspaceServerError("workspace_search_room_id_required", 400);
    const records = await store.searchRecords(workspaceContext(req), {
      query,
      roomId,
      ...(queryNumber(req, "limit") ? { limit: queryNumber(req, "limit") } : {})
    });
    res.json({ records });
  }));

  app.get("/api/workspaces/:workspaceId/events", authenticateWorkspace, asyncRoute(async (req, res) => {
    const roomId = queryString(req, "room_id");
    if (!roomId) throw new WorkspaceServerError("workspace_events_room_id_required", 400);
    const events = await store.listEvents(workspaceContext(req), {
      roomId,
      ...(queryNumber(req, "after") !== undefined ? { afterId: queryNumber(req, "after") } : {}),
      ...(queryNumber(req, "limit") ? { limit: queryNumber(req, "limit") } : {})
    });
    res.json({ events });
  }));

  app.get("/api/workspaces/:workspaceId/audit", authenticateWorkspace, asyncRoute(async (req, res) => {
    const entries = await store.listAuditEntries(workspaceContext(req), {
      ...(queryNumber(req, "after") !== undefined ? { afterId: queryNumber(req, "after") } : {}),
      ...(queryNumber(req, "limit") ? { limit: queryNumber(req, "limit") } : {})
    });
    res.json({ entries });
  }));

  app.post("/api/workspaces/:workspaceId/jobs", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const context = workspaceContext(req);
    const result = await realtimeGate.run(context.workspaceId, async () => {
      const saved = await commands.putJob(operationContext(req), {
        roomId: stringField(body, "room_id"),
        ...(optionalStringField(body, "job_id") ? { id: optionalStringField(body, "job_id") } : {}),
        kind: stringField(body, "kind"),
        idempotencyKey: stringField(body, "idempotency_key"),
        ...(body.expected_version === undefined ? {} : { expectedVersion: numberField(body, "expected_version") }),
        ...(optionalStringField(body, "status") ? { status: jobStatusField(body, "status") } : {}),
        payload: objectField(body, "payload")
      });
      if (!saved.replayed) await emitAuthorizedRoomWorkspaceEvent(io, store, saved.event);
      return saved;
    });
    res.status(result.replayed ? 200 : 201).json({ job: result.job, replayed: result.replayed });
  }));

  app.get("/api/workspaces/:workspaceId/files/{*filePath}", authenticateWorkspace, asyncRoute(async (req, res) => {
    const filePath = wildcardParam(req.params.filePath);
    const roomId = queryString(req, "room_id");
    if (!roomId) throw new WorkspaceServerError("workspace_file_room_id_required", 400);
    const read = await files.read(workspaceContext(req), { roomId, path: filePath });
    res.setHeader("content-type", "application/octet-stream");
    res.setHeader("x-samurai-file-version", String(read.file.version));
    res.setHeader("x-samurai-file-sha256", read.file.sha256);
    res.send(read.content);
  }));

  app.put("/api/workspaces/:workspaceId/files/{*filePath}", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const filePath = wildcardParam(req.params.filePath);
    const content = Buffer.from(stringField(body, "content_base64"), "base64");
    if (content.byteLength > 8 * 1024 * 1024) throw new WorkspaceServerError("workspace_file_too_large", 413);
    const context = workspaceContext(req);
    const result = await realtimeGate.run(context.workspaceId, async () => {
      const saved = await commands.writeFile(operationContext(req), {
        roomId: stringField(body, "room_id"),
        path: filePath,
        content,
        expectedVersion: numberField(body, "expected_version")
      });
      if (!saved.replayed) await emitAuthorizedRoomWorkspaceEvent(io, store, saved.event);
      return saved;
    });
    res.json({ file: result.file, event: result.event, replayed: result.replayed });
  }));

  app.post("/api/workspaces/:workspaceId/transfers", authenticateWorkspace, asyncRoute(async (req, res) => {
    const context = operationContext(req);
    const result = await commands.beginTransfer(context);
    res.status(201).json({
      transfer_id: result.transferId,
      manifest: result.manifest,
      bundle_download_path: `/api/workspaces/${encodeURIComponent(context.workspaceId)}/transfers/${encodeURIComponent(result.transferId)}/bundle`
    });
  }));

  app.get("/api/workspaces/:workspaceId/transfers/:transferId/bundle", authenticateWorkspace, asyncRoute(async (req, res) => {
    const context = workspaceContext(req);
    const transferId = pathParam(req, "transferId");
    const transfer = await bundles.getTransferBundle(context, transferId);
    const transport = await readWorkspaceBundleV3Transport(transfer.directory);
    res.setHeader("content-type", "application/vnd.samurai.workspace-bundle-v3+json");
    res.json(transport);
  }));

  app.get("/api/workspaces/:workspaceId/transfers/:transferId/manifest", authenticateWorkspace, asyncRoute(async (req, res) => {
    const transfer = await bundles.getTransferBundle(workspaceContext(req), pathParam(req, "transferId"));
    res.json({ manifest: transfer.manifest });
  }));

  app.get("/api/workspaces/:workspaceId/transfers/:transferId/entries/{*entryPath}", authenticateWorkspace, asyncRoute(async (req, res) => {
    const entry = await bundles.getTransferEntry(workspaceContext(req), pathParam(req, "transferId"), wildcardParam(req.params.entryPath));
    res.setHeader("content-type", entry.contentType);
    res.send(entry.content);
  }));

  app.post("/api/workspaces/:workspaceId/transfers/:transferId/receipt", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    await commands.recordTransferReceipt(operationContext(req), {
      transferId: pathParam(req, "transferId"),
      targetWorkspaceId: stringField(body, "target_workspace_id"),
      receipt: transferReceiptField(body, "receipt")
    });
    res.status(204).end();
  }));

  app.post("/api/workspaces/:workspaceId/transfers/:transferId/rollback", authenticateWorkspace, asyncRoute(async (req, res) => {
    await commands.rollbackTransfer(operationContext(req), pathParam(req, "transferId"));
    res.status(204).end();
  }));

  app.post("/api/workspaces/:workspaceId/transfers/:transferId/complete", authenticateWorkspace, asyncRoute(async (req, res) => {
    await commands.completeTransfer(operationContext(req), pathParam(req, "transferId"));
    res.status(204).end();
  }));

  const socketRateGuard = createRateGuard({ windowMs: 60_000, limit: config.publicNetwork ? 30 : 120 });
  io.use(async (socket, next) => {
    try {
      if (!socketRateGuard(socket.handshake.address || "unknown")) throw new WorkspaceServerError("workspace_rate_limit_exceeded", 429);
      const auth = objectBody(socket.handshake.auth);
      const accountId = stringField(auth, "account_id");
      const requestId = stringField(auth, "request_id");
      const timestamp = stringField(auth, "timestamp");
      const signature = stringField(auth, "signature");
      const workspaceId = resolveRequestWorkspaceId(config, optionalStringField(auth, "workspace_id"));
      const publicKey = await store.getAccountPublicKey(accountId);
      if (!publicKey) throw new WorkspaceServerError("account_not_found", 401);
      verifyAccountSignature({
        signed: { accountId, requestId, timestamp, signature },
        publicKey,
        payload: { method: "SOCKET", path: "/socket.io", workspaceId, requestId, timestamp, body: {} }
      });
      await store.getWorkspace({ workspaceId, accountId });
      await assertNotCompletionMaintenanceIdentity(store, { workspaceId, accountId });
      socket.data.samurai = { workspaceId, accountId };
      next();
    } catch (error) {
      next(error instanceof Error ? error : new Error("socket_authentication_failed"));
    }
  });

  io.on("connection", (socket) => {
    const identity = socket.data.samurai as { workspaceId: string; accountId: string };
    socket.join(workspaceSocketRoom(identity.workspaceId));
    socket.on("workspace:subscribe-room", async (input: unknown, acknowledge?: (result: unknown) => void) => {
      try {
        const body = objectBody(input);
        const roomId = stringField(body, "room_id");
        await realtimeGate.run(identity.workspaceId, async () => {
          await store.assertRoomReadable(identity, roomId);
          socket.join(roomSocketRoom(identity.workspaceId, roomId));
        });
        acknowledge?.({ ok: true });
      } catch (error) {
        acknowledge?.({ ok: false, error: publicError(error) });
      }
    });
    socket.on("workspace:resync", async (input: unknown, acknowledge?: (result: unknown) => void) => {
      try {
        const body = objectBody(input);
        const roomId = stringField(body, "room_id");
        const events = await realtimeGate.run(identity.workspaceId, async () => {
          await store.assertRoomReadable(identity, roomId);
          return store.listEvents(identity, {
            roomId,
            ...(typeof body.after === "number" ? { afterId: body.after } : {})
          });
        });
        acknowledge?.({ ok: true, events });
      } catch (error) {
        acknowledge?.({ ok: false, error: publicError(error) });
      }
    });
  });

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const normalized = normalizeError(error);
    res.status(normalized.status).json({ error: normalized.code, ...(normalized.details ? { details: normalized.details } : {}) });
  });

  return {
    app,
    httpServer,
    io,
    config,
    async close(): Promise<void> {
      await learningRunner.close();
      await new Promise<void>((resolve) => io.close(() => resolve()));
      if (httpServer.listening) {
        await new Promise<void>((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()));
      }
      await core.close();
    }
  };
}

export async function startWorkspaceServer(config = loadWorkspaceServerConfig()): Promise<WorkspaceServerHttp> {
  const server = await createWorkspaceServerHttp(config);
  await new Promise<void>((resolve, reject) => {
    server.httpServer.once("error", reject);
    server.httpServer.listen(config.port, config.bindAddress, () => {
      server.httpServer.off("error", reject);
      resolve();
    });
  });
  console.log(`Samurai Workspace Server listening on http://${config.bindAddress}:${config.port}`);
  return server;
}

function accountAuthenticator(store: WorkspaceServerStore) {
  return asyncRoute(async (req: AuthenticatedRequest, _res: Response, next: NextFunction) => {
    const signed = signedHeaders(req);
    const publicKey = await store.getAccountPublicKey(signed.accountId);
    if (!publicKey) throw new WorkspaceServerError("account_not_found", 401);
    const payload = signedRequestPayload(req);
    verifyAccountSignature({
      signed,
      publicKey,
      payload
    });
    req.samurai = {
      accountId: signed.accountId,
      requestId: signed.requestId,
      timestamp: signed.timestamp,
      signature: signed.signature,
      canonicalPayloadHash: hashCanonicalSignedPayload(payload),
      publicKey,
      signedPayload: payload
    };
    next();
  });
}

function workspaceAuthenticator(
  store: WorkspaceServerStore,
  config: WorkspaceServerConfig,
  options: { requireMembership?: boolean } = {}
) {
  return asyncRoute(async (req: AuthenticatedRequest, _res: Response, next: NextFunction) => {
    const signed = signedHeaders(req);
    const headerWorkspaceId = req.header("x-samurai-workspace-id")?.trim();
    const pathWorkspaceId = optionalPathParam(req, "workspaceId");
    if (headerWorkspaceId && pathWorkspaceId && headerWorkspaceId !== pathWorkspaceId) throw new WorkspaceServerError("workspace_id_mismatch", 400);
    const workspaceId = resolveRequestWorkspaceId(config, pathWorkspaceId || headerWorkspaceId);
    const publicKey = await store.getAccountPublicKey(signed.accountId);
    if (!publicKey) throw new WorkspaceServerError("account_not_found", 401);
    const payload = signedRequestPayload(req, workspaceId);
    verifyAccountSignature({
      signed: { accountId: signed.accountId, requestId: signed.requestId, timestamp: signed.timestamp, signature: stringHeader(req, "x-samurai-signature") },
      publicKey,
      payload
    });
    if (options.requireMembership !== false) {
      await store.getWorkspace({ workspaceId, accountId: signed.accountId });
      await assertNotCompletionMaintenanceIdentity(store, { workspaceId, accountId: signed.accountId });
    }
    req.samurai = {
      accountId: signed.accountId,
      requestId: signed.requestId,
      timestamp: signed.timestamp,
      signature: signed.signature,
      canonicalPayloadHash: hashCanonicalSignedPayload(payload),
      publicKey,
      signedPayload: payload,
      workspaceId
    };
    next();
  });
}

function signedHeaders(req: Request): { accountId: string; requestId: string; timestamp: string; signature: string } {
  return {
    accountId: stringHeader(req, "x-samurai-account-id"),
    requestId: stringHeader(req, "x-samurai-request-id"),
    timestamp: stringHeader(req, "x-samurai-timestamp"),
    signature: stringHeader(req, "x-samurai-signature")
  };
}

function workspaceContext(req: Request): Pick<WorkspaceRequestContext, "workspaceId" | "accountId"> {
  const authenticatedRequest = authenticated(req);
  if (!authenticatedRequest.workspaceId) throw new WorkspaceServerError("workspace_id_required", 400);
  return { workspaceId: authenticatedRequest.workspaceId, accountId: authenticatedRequest.accountId };
}

/** The scheduler's separate Account is intentionally database-only.  Its
 * signing key must not become a second human/Native-App mutation path. */
async function assertNotCompletionMaintenanceIdentity(
  store: WorkspaceServerStore,
  context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">
): Promise<void> {
  const result = await store.database.withContext(context, async (sql) =>
    sql.query<{ allowed: boolean }>("SELECT samurai_is_completion_maintenance_identity($1) AS allowed", [context.workspaceId])
  );
  if (result.rows[0]?.allowed === true) throw new WorkspaceServerError("workspace_completion_maintenance_http_forbidden", 403);
}

function operationContext(req: Request): WorkspaceRequestContext {
  const context = workspaceContext(req);
  const signed = authenticated(req);
  const operationId = assertOpaqueId(stringHeader(req, "x-samurai-operation-id"), "workspace_operation_id_invalid");
  return {
    ...context,
    operationId,
    caller: createVerifiedWorkspaceHumanCaller({
      signed: {
        accountId: signed.accountId,
        requestId: signed.requestId,
        timestamp: signed.timestamp,
        signature: signed.signature
      },
      publicKey: signed.publicKey,
      payload: signed.signedPayload,
      operationId
    })
  };
}

function signedRequestPayload(req: Request, workspaceId?: string): {
  method: string;
  path: string;
  workspaceId?: string;
  operationId?: string;
  requestId: string;
  timestamp: string;
  body: unknown;
} {
  const signed = signedHeaders(req);
  return {
    method: req.method,
    path: req.path,
    ...(workspaceId ? { workspaceId } : {}),
    ...(req.header("x-samurai-operation-id") ? { operationId: stringHeader(req, "x-samurai-operation-id") } : {}),
    requestId: signed.requestId,
    timestamp: signed.timestamp,
    body: req.body ?? {}
  };
}

function hashCanonicalSignedPayload(payload: unknown): string {
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

function authenticated(req: Request): NonNullable<AuthenticatedRequest["samurai"]> {
  const value = (req as AuthenticatedRequest).samurai;
  if (!value) throw new WorkspaceServerError("account_authentication_required", 401);
  return value;
}

async function emitLearningResourceEvent(
  io: SocketServer,
  store: WorkspaceServerStore,
  workspaceId: string,
  resource: { scope: WorkspaceLearningScope },
  kind: string
): Promise<void> {
  if (resource.scope.kind === "room") {
    await emitAuthorizedRoomWorkspaceEvent(io, store, { workspaceId, roomId: resource.scope.roomId!, kind });
    return;
  }
  await emitAuthorizedWorkspaceEvent(io, store, { workspaceId, kind });
}

async function emitCompletionResourceEvent(
  io: SocketServer,
  store: WorkspaceServerStore,
  workspaceId: string,
  resource: { scope: WorkspaceCompletionScope },
  kind: string
): Promise<void> {
  if (resource.scope.kind === "room") {
    await emitAuthorizedRoomWorkspaceEvent(io, store, { workspaceId, roomId: resource.scope.roomId!, kind });
    return;
  }
  await emitAuthorizedWorkspaceEvent(io, store, { workspaceId, kind });
}

/** Workspace-wide events contain no Room identity. Every recipient is still
 * checked at delivery time so a stale socket cannot observe post-revocation
 * configuration or Workspace-scoped Knowledge changes. */
async function emitAuthorizedWorkspaceEvent(
  io: SocketServer,
  store: WorkspaceServerStore,
  event: { workspaceId: string; kind?: string }
): Promise<void> {
  for (const socket of io.sockets.sockets.values()) {
    const identity = socket.data.samurai as { workspaceId?: string; accountId?: string } | undefined;
    if (identity?.workspaceId !== event.workspaceId || !identity.accountId) continue;
    try {
      await store.getWorkspace({ workspaceId: event.workspaceId, accountId: identity.accountId });
      socket.emit("workspace:event", event);
    } catch {
      socket.emit("workspace:access-revoked", { workspaceId: event.workspaceId });
      socket.disconnect(true);
    }
  }
}

/**
 * A Room event is never broadcast to the Workspace as a whole.  A socket is
 * checked again immediately before delivery, inside the same local gate used
 * by hierarchy and membership changes.  This closes the post-commit window
 * where a stale Socket.IO room subscription could otherwise disclose an
 * event after its access was revoked.
 *
 * Hierarchy events also reach directly-authorized Workspace sockets that have
 * not yet joined the new Room channel.  That lets their tree refresh without
 * revealing the Room to parent-only members.
 */
async function emitAuthorizedRoomWorkspaceEvent(
  io: SocketServer,
  store: WorkspaceServerStore,
  event: { workspaceId: string; roomId: string; kind?: string }
): Promise<void> {
  for (const socket of io.sockets.sockets.values()) {
    const identity = socket.data.samurai as { workspaceId?: string; accountId?: string } | undefined;
    if (identity?.workspaceId !== event.workspaceId || !identity.accountId) continue;
    const roomChannel = roomSocketRoom(event.workspaceId, event.roomId);
    const wasSubscribed = socket.rooms.has(roomChannel);
    let delivered = false;
    try {
      delivered = await store.deliverRoomRealtimeIfReadable(
        { workspaceId: event.workspaceId, accountId: identity.accountId },
        event.roomId,
        () => { socket.emit("workspace:event", event); }
      );
    } catch {
      delivered = false;
    }
    if (!delivered) {
      socket.leave(roomChannel);
      // A Socket that never knew this Room must receive no Room identifier.
      // Otherwise a normal hidden-Room update becomes an existence oracle.
      if (wasSubscribed) {
        socket.emit("workspace:room-access-revoked", { workspaceId: event.workspaceId, roomId: event.roomId });
      }
      continue;
    }
  }
}

async function revalidateWorkspaceMemberSockets(io: SocketServer, store: WorkspaceServerStore, workspaceId: string, accountId: string): Promise<void> {
  for (const socket of io.sockets.sockets.values()) {
    const identity = socket.data.samurai as { workspaceId?: string; accountId?: string } | undefined;
    if (identity?.workspaceId !== workspaceId || identity.accountId !== accountId) continue;
    try {
      await store.getWorkspace({ workspaceId, accountId });
    } catch {
      socket.emit("workspace:access-revoked", { workspaceId });
      socket.disconnect(true);
      continue;
    }
    socket.emit("workspace:access-changed", { workspaceId });
    for (const joinedRoom of socket.rooms) {
      const prefix = `workspace:${workspaceId}:room:`;
      if (!joinedRoom.startsWith(prefix)) continue;
      const roomId = joinedRoom.slice(prefix.length);
      try {
        await store.assertRoomReadable({ workspaceId, accountId }, roomId);
      } catch {
        socket.leave(joinedRoom);
        socket.emit("workspace:room-access-revoked", { workspaceId, roomId });
      }
    }
  }
}

async function revalidateRoomMemberSockets(io: SocketServer, store: WorkspaceServerStore, workspaceId: string, roomId: string, accountId: string): Promise<void> {
  for (const socket of io.sockets.sockets.values()) {
    const identity = socket.data.samurai as { workspaceId?: string; accountId?: string } | undefined;
    if (identity?.workspaceId === workspaceId && identity.accountId === accountId) {
      const roomChannel = roomSocketRoom(workspaceId, roomId);
      const wasSubscribed = socket.rooms.has(roomChannel);
      try {
        await store.assertRoomReadable({ workspaceId, accountId }, roomId);
        socket.emit("workspace:room-access-changed", { workspaceId, roomId });
      } catch {
        socket.leave(roomChannel);
        // A connection which was never subscribed must not learn a hidden
        // Room id merely because an old/redundant revoke command is replayed
        // against its membership row.
        if (wasSubscribed) {
          socket.emit("workspace:room-access-revoked", { workspaceId, roomId });
        }
      }
    }
  }
}

function asyncRoute(handler: (req: Request, res: Response, next: NextFunction) => Promise<void>): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => { void handler(req, res, next).catch(next); };
}

function requestRateGuard(options: { windowMs: number; limit: number }): (req: Request, res: Response, next: NextFunction) => void {
  const allow = createRateGuard(options);
  return (req, _res, next) => {
    if (!allow(req.ip || req.socket.remoteAddress || "unknown")) {
      next(new WorkspaceServerError("workspace_rate_limit_exceeded", 429));
      return;
    }
    next();
  };
}

function createRateGuard(options: { windowMs: number; limit: number }): (key: string) => boolean {
  const entries = new Map<string, { startedAt: number; count: number }>();
  return (key) => {
    const now = Date.now();
    if (entries.size > 10_000) {
      for (const [entryKey, entry] of entries) if (now - entry.startedAt >= options.windowMs) entries.delete(entryKey);
    }
    const existing = entries.get(key);
    if (!existing || now - existing.startedAt >= options.windowMs) {
      entries.set(key, { startedAt: now, count: 1 });
      return true;
    }
    existing.count += 1;
    return existing.count <= options.limit;
  };
}

function objectBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WorkspaceServerError("request_body_invalid", 400);
  return value as Record<string, unknown>;
}

function objectField(body: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = body[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WorkspaceServerError(`${key}_required`, 400);
  return value as Record<string, unknown>;
}

function workspaceBundleManifestField(body: Record<string, unknown>, key: string): {
  format_version: 3;
  workspace_id: string;
  exported_at: string;
  source: { hosting_mode: "hosted" | "self_host"; database_placement: "shared" | "dedicated" };
  schema_version?: number;
  transfer_id?: string;
  files: Record<string, string>;
  record_counts: Record<string, number>;
  integrity_hash: string;
} {
  const value = objectField(body, key);
  const source = objectField(value, "source");
  const files = objectField(value, "files");
  const recordCounts = objectField(value, "record_counts");
  const formatVersion = numberField(value, "format_version");
  if (formatVersion !== 3 || source.hosting_mode !== "hosted" && source.hosting_mode !== "self_host"
    || source.database_placement !== "shared" && source.database_placement !== "dedicated") {
    throw new WorkspaceServerError("workspace_bundle_v3_manifest_invalid", 400);
  }
  const normalizedFiles: Record<string, string> = {};
  for (const [path, hash] of Object.entries(files)) {
    if (typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)) throw new WorkspaceServerError("workspace_bundle_v3_manifest_invalid", 400);
    normalizedFiles[path] = hash;
  }
  const normalizedCounts: Record<string, number> = {};
  for (const [name, count] of Object.entries(recordCounts)) {
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) throw new WorkspaceServerError("workspace_bundle_v3_manifest_invalid", 400);
    normalizedCounts[name] = count;
  }
  const schemaVersion = value.schema_version;
  if (schemaVersion !== undefined && (typeof schemaVersion !== "number" || !Number.isSafeInteger(schemaVersion) || schemaVersion < 1)) {
    throw new WorkspaceServerError("workspace_bundle_v3_manifest_invalid", 400);
  }
  const transferId = optionalStringField(value, "transfer_id");
  return {
    format_version: 3,
    workspace_id: stringField(value, "workspace_id"),
    exported_at: stringField(value, "exported_at"),
    source: { hosting_mode: source.hosting_mode, database_placement: source.database_placement },
    ...(schemaVersion === undefined ? {} : { schema_version: schemaVersion }),
    ...(transferId ? { transfer_id: transferId } : {}),
    files: normalizedFiles,
    record_counts: normalizedCounts,
    integrity_hash: stringField(value, "integrity_hash")
  };
}

function base64Field(body: Record<string, unknown>, key: string): string {
  const value = stringField(body, key);
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new WorkspaceServerError(`${key}_invalid`, 400);
  }
  return value;
}

function stringField(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || !value.trim()) throw new WorkspaceServerError(`${key}_required`, 400);
  return value.trim();
}

function optionalStringField(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new WorkspaceServerError(`${key}_invalid`, 400);
  return value.trim();
}

/** A move must state its destination explicitly; null means Workspace root. */
function nullableStringField(body: Record<string, unknown>, key: string): string | undefined {
  if (!(key in body)) throw new WorkspaceServerError(`${key}_required`, 400);
  const value = body[key];
  if (value === null) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new WorkspaceServerError(`${key}_invalid`, 400);
  return value.trim();
}

function numberField(body: Record<string, unknown>, key: string): number {
  const value = body[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new WorkspaceServerError(`${key}_invalid`, 400);
  return value;
}

function booleanField(body: Record<string, unknown>, key: string): boolean {
  const value = body[key];
  if (typeof value !== "boolean") throw new WorkspaceServerError(`${key}_invalid`, 400);
  return value;
}

function nonnegativeNumberField(body: Record<string, unknown>, key: string): number {
  const value = body[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new WorkspaceServerError(`${key}_invalid`, 400);
  return value;
}

function learningPayloadField(body: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = objectField(body, key);
  const text = JSON.stringify(value);
  if (text.length > 200_000 || /(?:-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----|\bsk-[A-Za-z0-9]{20,}\b|\bghp_[A-Za-z0-9]{30,}\b|\bAKIA[A-Z0-9]{16}\b)/.test(text)) {
    throw new WorkspaceServerError("workspace_learning_secret_content_forbidden", 400);
  }
  return value;
}

function learningScopeField(body: Record<string, unknown>): WorkspaceLearningScope {
  const kind = stringField(body, "scope_kind");
  if (kind === "workspace") return { kind };
  if (kind === "room") return { kind, roomId: stringField(body, "room_id") };
  throw new WorkspaceServerError("scope_kind_invalid", 400);
}

function learningTargetScopeField(body: Record<string, unknown>): WorkspaceLearningScope {
  const kind = stringField(body, "target_scope_kind");
  if (kind === "workspace") return { kind };
  if (kind === "room") return { kind, roomId: stringField(body, "target_room_id") };
  throw new WorkspaceServerError("target_scope_kind_invalid", 400);
}

function learningScopeQuery(req: Request): WorkspaceLearningScope {
  const kind = queryString(req, "scope_kind");
  if (kind === "workspace") return { kind };
  if (kind === "room") {
    const roomId = queryString(req, "room_id");
    if (!roomId) throw new WorkspaceServerError("workspace_learning_room_id_required", 400);
    return { kind, roomId };
  }
  throw new WorkspaceServerError("scope_kind_required", 400);
}

function learningResourceKind(value: string): "knowledge" | "memory" | "skill" | "workspace_rule" {
  if (value === "memory" || value === "workspace_rule") throw new WorkspaceServerError("workspace_learning_legacy_write_retired", 410);
  if (value === "knowledge" || value === "skill") return value;
  throw new WorkspaceServerError("workspace_learning_resource_kind_invalid", 400);
}

function learningOutcomeField(body: Record<string, unknown>, key: string): "completed" | "failed" | "cancelled" | "outcome_unknown" {
  const value = stringField(body, key);
  if (value === "completed" || value === "failed" || value === "cancelled" || value === "outcome_unknown") return value;
  throw new WorkspaceServerError(`${key}_invalid`, 400);
}

function learningResourceUseOutcome(body: Record<string, unknown>, key: string): "confirmed_success" | "confirmed_failure" | "unknown" {
  const value = stringField(body, key);
  if (value === "confirmed_success" || value === "confirmed_failure" || value === "unknown") return value;
  throw new WorkspaceServerError(`${key}_invalid`, 400);
}

function learningVerificationField(body: Record<string, unknown>, key: string): "confirmed" | "failed" | "not_run" | "unknown" {
  const value = stringField(body, key);
  if (value === "confirmed" || value === "failed" || value === "not_run" || value === "unknown") return value;
  throw new WorkspaceServerError(`${key}_invalid`, 400);
}

function learningFailureField(body: Record<string, unknown>, key: string): "none" | "resolved" | "unresolved" {
  const value = stringField(body, key);
  if (value === "none" || value === "resolved" || value === "unresolved") return value;
  throw new WorkspaceServerError(`${key}_invalid`, 400);
}

function learningJobStatus(value: string): "queued" | "running" | "completed" | "failed" | "blocked" {
  if (value === "queued" || value === "running" || value === "completed" || value === "failed" || value === "blocked") return value;
  throw new WorkspaceServerError("status_invalid", 400);
}

function completionScopeField(body: Record<string, unknown>): WorkspaceCompletionScope {
  const kind = stringField(body, "scope_kind");
  if (kind === "workspace") return { kind };
  if (kind === "room") return { kind, roomId: stringField(body, "room_id") };
  throw new WorkspaceServerError("workspace_completion_scope_invalid", 400);
}

function completionTargetScopeField(body: Record<string, unknown>): WorkspaceCompletionScope {
  const kind = stringField(body, "target_scope_kind");
  if (kind === "workspace") return { kind };
  if (kind === "room") return { kind, roomId: stringField(body, "target_room_id") };
  throw new WorkspaceServerError("workspace_completion_target_scope_invalid", 400);
}

function completionResourceKind(value: string): WorkspaceCompletionResourceKind {
  if (value === "knowledge" || value === "skill" || value === "policy") return value;
  throw new WorkspaceServerError("workspace_completion_resource_kind_invalid", 400);
}

function completionResourceInput(body: Record<string, unknown>) {
  const kind = completionResourceKind(stringField(body, "kind"));
  if (kind === "policy") throw new WorkspaceServerError("workspace_completion_policy_apply_required", 400);
  const scope = completionScopeField(body);
  return {
    ...(optionalStringField(body, "resource_id") ? { id: optionalStringField(body, "resource_id") } : {}),
    scope,
    kind,
    ...(kind === "knowledge" ? { knowledgeKind: completionKnowledgeKind(stringField(body, "knowledge_kind")) } : {}),
    title: stringField(body, "title"),
    content: stringField(body, "content"),
    metadata: completionPayloadField(body, "metadata"),
    reason: stringField(body, "reason"),
    ...(body.expected_version === undefined ? {} : { expectedVersion: numberField(body, "expected_version") }),
    ...(body.ai_managed === undefined ? {} : { aiManaged: booleanField(body, "ai_managed") }),
    ...(kind === "skill" && body.support_files !== undefined ? { supportFiles: completionSkillSupportFilesField(body) } : {})
  };
}

function completionKnowledgeKind(value: string): "fact" | "decision" | "explanation" | "experience_rule" {
  if (value === "fact" || value === "decision" || value === "explanation" || value === "experience_rule") return value;
  throw new WorkspaceServerError("workspace_completion_knowledge_kind_invalid", 400);
}

function completionPayloadField(body: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = objectField(body, key);
  if (JSON.stringify(value).length > 200_000) throw new WorkspaceServerError("workspace_completion_payload_invalid", 400);
  return value;
}

function completionSkillSupportFilesField(body: Record<string, unknown>): Array<{ path: string; content: Buffer }> {
  const value = body.support_files;
  if (!Array.isArray(value) || value.length > 99) throw new WorkspaceServerError("workspace_completion_skill_support_files_invalid", 400);
  return value.map((entry) => {
    const file = objectField(entry, "support_file");
    const content = Buffer.from(base64Field(file, "content_base64"), "base64");
    if (content.byteLength > 8 * 1024 * 1024) throw new WorkspaceServerError("workspace_completion_skill_support_files_invalid", 413);
    return { path: stringField(file, "path"), content };
  });
}

function completionSessionRefField(body: Record<string, unknown>, key: string): { appId: string; sessionId?: string; turnId?: string; messageId?: string; resumeUrl?: string } {
  const value = objectField(body, key);
  return {
    appId: stringField(value, "app_id"),
    ...(optionalStringField(value, "session_id") ? { sessionId: optionalStringField(value, "session_id") } : {}),
    ...(optionalStringField(value, "turn_id") ? { turnId: optionalStringField(value, "turn_id") } : {}),
    ...(optionalStringField(value, "message_id") ? { messageId: optionalStringField(value, "message_id") } : {}),
    ...(optionalStringField(value, "resume_url") ? { resumeUrl: optionalStringField(value, "resume_url") } : {})
  };
}

function stringArrayField(body: Record<string, unknown>, key: string): string[] {
  const value = body[key];
  if (!Array.isArray(value) || value.length > 100 || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new WorkspaceServerError(`${key}_invalid`, 400);
  }
  return value.map((item) => item.trim());
}

function completionOutcomeField(body: Record<string, unknown>, key: string): "completed" | "failed" | "cancelled" | "unknown" {
  const value = stringField(body, key);
  if (value === "completed" || value === "failed" || value === "cancelled" || value === "unknown") return value;
  throw new WorkspaceServerError(`${key}_invalid`, 400);
}

function completionVerificationField(body: Record<string, unknown>, key: string): "confirmed" | "failed" | "not_run" | "unknown" {
  const value = stringField(body, key);
  if (value === "confirmed" || value === "failed" || value === "not_run" || value === "unknown") return value;
  throw new WorkspaceServerError(`${key}_invalid`, 400);
}

function completionFailureField(body: Record<string, unknown>, key: string): "none" | "resolved" | "unresolved" {
  const value = stringField(body, key);
  if (value === "none" || value === "resolved" || value === "unresolved") return value;
  throw new WorkspaceServerError(`${key}_invalid`, 400);
}

function completionUseEventField(body: Record<string, unknown>, key: string): "selected" | "body_loaded" | "support_loaded" | "actually_used" | "outcome" | "correction" {
  const value = stringField(body, key);
  if (value === "selected" || value === "body_loaded" || value === "support_loaded" || value === "actually_used" || value === "outcome" || value === "correction") return value;
  throw new WorkspaceServerError(`${key}_invalid`, 400);
}

function completionUseOutcomeField(body: Record<string, unknown>, key: string): "confirmed_success" | "confirmed_failure" | "unknown" {
  const value = stringField(body, key);
  if (value === "confirmed_success" || value === "confirmed_failure" || value === "unknown") return value;
  throw new WorkspaceServerError(`${key}_invalid`, 400);
}

function completionJobStatusField(value: string): "queued" | "running" | "completed" | "failed" | "blocked" {
  if (value === "queued" || value === "running" || value === "completed" || value === "failed" || value === "blocked") return value;
  throw new WorkspaceServerError("status_invalid", 400);
}

function completionPolicyOperation(value: string): WorkspaceCompletionPolicyOperation {
  if (["activity.ingest", "resource.create", "resource.update", "resource.archive", "resource.copy", "resource.move", "resource.promote", "file.import", "curator.apply", "external.send", "policy.apply", "membership.change"].includes(value)) {
    return value as WorkspaceCompletionPolicyOperation;
  }
  throw new WorkspaceServerError("workspace_completion_policy_operation_invalid", 400);
}

function publicLearningSettings(settings: WorkspaceLearningSettings): Omit<WorkspaceLearningSettings, "secretRef"> {
  const { secretRef: _secretRef, ...publicSettings } = settings;
  return publicSettings;
}

function roleField(body: Record<string, unknown>, key: string): "owner" | "admin" | "member" | "guest" {
  const role = stringField(body, key);
  if (role === "owner" || role === "admin" || role === "member" || role === "guest") return role;
  throw new WorkspaceServerError(`${key}_invalid`, 400);
}

function membershipStateField(body: Record<string, unknown>, key: string): "active" | "revoked" {
  const state = stringField(body, key);
  if (state === "active" || state === "revoked") return state;
  throw new WorkspaceServerError(`${key}_invalid`, 400);
}

function transferReceiptField(body: Record<string, unknown>, key: string): {
  format_version: 1;
  transfer_id: string;
  source_workspace_id: string;
  source_integrity_hash: string;
  target_workspace_id: string;
  imported_at: string;
  target_integrity_hash: string;
} {
  const value = objectField(body, key);
  const formatVersion = numberField(value, "format_version");
  if (formatVersion !== 1) throw new WorkspaceServerError("workspace_transfer_receipt_invalid", 400);
  const importedAt = stringField(value, "imported_at");
  if (!Number.isFinite(new Date(importedAt).getTime())) throw new WorkspaceServerError("workspace_transfer_receipt_invalid", 400);
  const sourceIntegrityHash = sha256Field(value, "source_integrity_hash");
  const targetIntegrityHash = sha256Field(value, "target_integrity_hash");
  if (sourceIntegrityHash !== targetIntegrityHash) throw new WorkspaceServerError("workspace_transfer_receipt_invalid", 400);
  return {
    format_version: 1,
    transfer_id: stringField(value, "transfer_id"),
    source_workspace_id: stringField(value, "source_workspace_id"),
    source_integrity_hash: sourceIntegrityHash,
    target_workspace_id: stringField(value, "target_workspace_id"),
    imported_at: importedAt,
    target_integrity_hash: targetIntegrityHash
  };
}

function sha256Field(body: Record<string, unknown>, key: string): string {
  const value = stringField(body, key);
  if (!/^[a-f0-9]{64}$/.test(value)) throw new WorkspaceServerError("workspace_transfer_receipt_invalid", 400);
  return value;
}

function workspaceInvitationLink(serverUrl: string, workspaceId: string, token: string): string {
  const link = new URL("samurai://workspace-invite");
  link.searchParams.set("server", serverUrl);
  link.searchParams.set("workspace_id", workspaceId);
  link.searchParams.set("token", token);
  return link.toString();
}

function jobStatusField(body: Record<string, unknown>, key: string): "queued" | "running" | "completed" | "failed" | "blocked" {
  const status = stringField(body, key);
  if (status === "queued" || status === "running" || status === "completed" || status === "failed" || status === "blocked") return status;
  throw new WorkspaceServerError(`${key}_invalid`, 400);
}

function stringHeader(req: Request, name: string): string {
  const value = req.header(name)?.trim();
  if (!value) throw new WorkspaceServerError(`${name.replaceAll("-", "_")}_required`, 401);
  return value;
}

function queryString(req: Request, key: string): string | undefined {
  const value = req.query[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function queryNumber(req: Request, key: string): number | undefined {
  const value = queryString(req, key);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new WorkspaceServerError(`${key}_invalid`, 400);
  return parsed;
}

function wildcardParam(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value.join("/") : value;
  if (!raw) throw new WorkspaceServerError("workspace_file_path_required", 400);
  return raw;
}

function pathParam(req: Request, key: string): string {
  const value = optionalPathParam(req, key);
  if (!value) throw new WorkspaceServerError(`${key}_required`, 400);
  return value;
}

function optionalPathParam(req: Request, key: string): string | undefined {
  const value = req.params[key];
  if (Array.isArray(value)) return value.length === 1 ? value[0] : undefined;
  return typeof value === "string" && value ? value : undefined;
}

function normalizeError(error: unknown): WorkspaceServerError {
  if (error instanceof WorkspaceServerError) return error;
  const message = error instanceof Error ? error.message : "workspace_server_internal_error";
  // Missing and inaccessible Rooms deliberately share one public response.
  // Never let an endpoint reveal whether a private Room id happens to exist.
  if (/room_(?:not_available|parent_not_available|not_found_or_access_denied)/.test(message)) {
    return new WorkspaceServerError("room_not_available", 404);
  }
  const conflictCode = message.match(/(?:room_(?:parent_membership_required|move_parent_membership_required|hierarchy_cycle|last_owner_cannot_be_removed|membership_version_conflict|version_conflict)|workspace_(?:membership_version_conflict|last_owner_cannot_be_revoked|record_room_change_forbidden|file_room_change_forbidden|account_not_active))/)?.[0];
  if (conflictCode) return new WorkspaceServerError(conflictCode, 409);
  if (/room_membership_invalid/.test(message)) return new WorkspaceServerError("room_membership_invalid", 400);
  if (/workspace_admin_permission_required/.test(message)) return new WorkspaceServerError("workspace_admin_permission_required", 403);
  if (/workspace_owner_permission_required/.test(message)) return new WorkspaceServerError("workspace_owner_permission_required", 403);
  if (/workspace_permission_denied/.test(message)) return new WorkspaceServerError("workspace_permission_denied", 403);
  if (/workspace_membership_required/.test(message)) return new WorkspaceServerError("workspace_membership_required", 409);
  if (/permission_denied|owner_permission_required|admin_permission_required/.test(message)) return new WorkspaceServerError("workspace_permission_denied", 403);
  if (/invitation_invalid|membership_invalid/.test(message)) return new WorkspaceServerError("workspace_request_rejected", 400);
  if (/version_conflict|read_only|transfer_not_ready|transfer_source_not_active|transfer_receipt_invalid/.test(message)) {
    return new WorkspaceServerError("workspace_update_conflict", 409);
  }
  if (/not_found/.test(message)) return new WorkspaceServerError("workspace_request_not_found", 404);
  return new WorkspaceServerError("workspace_server_internal_error", 500);
}

function publicError(error: unknown): { error: string; details?: Record<string, unknown> } {
  const normalized = normalizeError(error);
  return { error: normalized.code, ...(normalized.details ? { details: normalized.details } : {}) };
}
