import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import { createServer, type Server as HttpServer } from "node:http";
import { Server as SocketServer } from "socket.io";
import {
  WorkspaceServerError,
  WorkspaceServerStore,
  assertOpaqueId,
  loadWorkspaceServerConfig,
  readWorkspaceBundleV3Transport,
  resolveRequestWorkspaceId,
  verifyAccountSignature,
  type WorkspaceRequestContext,
  type WorkspaceServerConfig
} from "@samurai-agent/workspace-server";
import { createWorkspaceServerCore } from "./core";
import { emitRoomWorkspaceEvent, roomSocketRoom, workspaceSocketRoom } from "./realtime";

interface AuthenticatedRequest extends Request {
  samurai?: { accountId: string; requestId: string; timestamp: string; workspaceId?: string };
}

export interface WorkspaceServerHttp {
  app: express.Express;
  httpServer: HttpServer;
  io: SocketServer;
  config: WorkspaceServerConfig;
  close(): Promise<void>;
}

export async function createWorkspaceServerHttp(config = loadWorkspaceServerConfig()): Promise<WorkspaceServerHttp> {
  const core = await createWorkspaceServerCore(config);
  const { store, files, bundles, commands } = core;
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
    const room = await commands.createRoom(operationContext(req), {
      id: optionalStringField(body, "room_id"),
      name: stringField(body, "name"),
      expectedWorkspaceVersion: numberField(body, "expected_workspace_version")
    });
    res.status(201).json({ room });
  }));

  app.put("/api/workspaces/:workspaceId/members/:accountId", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const memberAccountId = pathParam(req, "accountId");
    const member = await commands.setWorkspaceMember(operationContext(req), {
      accountId: memberAccountId,
      role: roleField(body, "role"),
      state: membershipStateField(body, "state"),
      expectedVersion: numberField(body, "expected_version")
    });
    await revalidateWorkspaceMemberSockets(io, store, workspaceContext(req).workspaceId, memberAccountId);
    res.json({ member });
  }));

  app.put("/api/workspaces/:workspaceId/rooms/:roomId/members/:accountId", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const roomId = pathParam(req, "roomId");
    const memberAccountId = pathParam(req, "accountId");
    const member = await commands.setRoomMember(operationContext(req), {
      roomId,
      accountId: memberAccountId,
      role: roleField(body, "role"),
      state: membershipStateField(body, "state"),
      expectedVersion: numberField(body, "expected_version")
    });
    await revalidateRoomMemberSockets(io, store, workspaceContext(req).workspaceId, roomId, memberAccountId);
    res.json({ member });
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
    const accepted = await commands.acceptInvitation(operationContext(req), stringField(body, "invite_token"));
    res.json({ accepted });
  }));

  app.post("/api/workspaces/:workspaceId/invitations/:invitationId/revoke", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    await commands.revokeInvitation(operationContext(req), pathParam(req, "invitationId"), numberField(body, "expected_version"));
    res.status(204).end();
  }));

  app.get("/api/workspaces/:workspaceId/records", authenticateWorkspace, asyncRoute(async (req, res) => {
    const records = await store.listRecords(workspaceContext(req), {
      ...(queryString(req, "room_id") ? { roomId: queryString(req, "room_id") } : {}),
      ...(queryString(req, "record_type") ? { recordType: queryString(req, "record_type") } : {}),
      ...(queryNumber(req, "limit") ? { limit: queryNumber(req, "limit") } : {})
    });
    res.json({ records });
  }));

  app.get("/api/workspaces/:workspaceId/records/:recordType/:recordId", authenticateWorkspace, asyncRoute(async (req, res) => {
    res.json({ record: await store.getRecord(workspaceContext(req), { recordType: pathParam(req, "recordType"), id: pathParam(req, "recordId") }) });
  }));

  app.put("/api/workspaces/:workspaceId/records/:recordType/:recordId", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const result = await commands.putRecord(operationContext(req), {
      roomId: stringField(body, "room_id"),
      recordType: pathParam(req, "recordType"),
      id: pathParam(req, "recordId"),
      expectedVersion: numberField(body, "expected_version"),
      payload: objectField(body, "payload"),
      ...(optionalStringField(body, "search_text") ? { searchText: optionalStringField(body, "search_text") } : {})
    });
    emitWorkspaceEvent(io, result.event);
    res.json(result);
  }));

  app.delete("/api/workspaces/:workspaceId/records/:recordType/:recordId", authenticateWorkspace, asyncRoute(async (req, res) => {
    const body = objectBody(req.body);
    const result = await commands.deleteRecord(operationContext(req), {
      roomId: stringField(body, "room_id"),
      recordType: pathParam(req, "recordType"),
      id: pathParam(req, "recordId"),
      expectedVersion: numberField(body, "expected_version")
    });
    emitWorkspaceEvent(io, result.event);
    res.json(result);
  }));

  app.get("/api/workspaces/:workspaceId/search", authenticateWorkspace, asyncRoute(async (req, res) => {
    const query = queryString(req, "q");
    if (!query) throw new WorkspaceServerError("workspace_search_query_required", 400);
    const records = await store.searchRecords(workspaceContext(req), {
      query,
      ...(queryString(req, "room_id") ? { roomId: queryString(req, "room_id") } : {}),
      ...(queryNumber(req, "limit") ? { limit: queryNumber(req, "limit") } : {})
    });
    res.json({ records });
  }));

  app.get("/api/workspaces/:workspaceId/events", authenticateWorkspace, asyncRoute(async (req, res) => {
    const events = await store.listEvents(workspaceContext(req), {
      ...(queryString(req, "room_id") ? { roomId: queryString(req, "room_id") } : {}),
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
    const result = await commands.putJob(operationContext(req), {
      roomId: stringField(body, "room_id"),
      ...(optionalStringField(body, "job_id") ? { id: optionalStringField(body, "job_id") } : {}),
      kind: stringField(body, "kind"),
      idempotencyKey: stringField(body, "idempotency_key"),
      ...(body.expected_version === undefined ? {} : { expectedVersion: numberField(body, "expected_version") }),
      ...(optionalStringField(body, "status") ? { status: jobStatusField(body, "status") } : {}),
      payload: objectField(body, "payload")
    });
    emitWorkspaceEvent(io, result.event);
    res.status(201).json({ job: result.job });
  }));

  app.get("/api/workspaces/:workspaceId/files/{*filePath}", authenticateWorkspace, asyncRoute(async (req, res) => {
    const filePath = wildcardParam(req.params.filePath);
    const read = await files.read(workspaceContext(req), filePath);
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
    const result = await commands.writeFile(operationContext(req), {
      roomId: stringField(body, "room_id"),
      path: filePath,
      content,
      expectedVersion: numberField(body, "expected_version")
    });
    emitWorkspaceEvent(io, result.event);
    res.json({ file: result.file, event: result.event });
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
        await store.assertRoomReadable(identity, roomId);
        socket.join(roomSocketRoom(identity.workspaceId, roomId));
        acknowledge?.({ ok: true });
      } catch (error) {
        acknowledge?.({ ok: false, error: publicError(error) });
      }
    });
    socket.on("workspace:resync", async (input: unknown, acknowledge?: (result: unknown) => void) => {
      try {
        const body = objectBody(input);
        const roomId = optionalStringField(body, "room_id");
        if (roomId) await store.assertRoomReadable(identity, roomId);
        const events = await store.listEvents(identity, {
          ...(roomId ? { roomId } : {}),
          ...(typeof body.after === "number" ? { afterId: body.after } : {})
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
    verifyAccountSignature({
      signed,
      publicKey,
      payload: {
        method: req.method,
        path: req.path,
        ...(req.header("x-samurai-operation-id") ? { operationId: stringHeader(req, "x-samurai-operation-id") } : {}),
        requestId: signed.requestId,
        timestamp: signed.timestamp,
        body: req.body ?? {}
      }
    });
    req.samurai = { accountId: signed.accountId, requestId: signed.requestId, timestamp: signed.timestamp };
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
    verifyAccountSignature({
      signed: { accountId: signed.accountId, requestId: signed.requestId, timestamp: signed.timestamp, signature: stringHeader(req, "x-samurai-signature") },
      publicKey,
      payload: {
        method: req.method,
        path: req.path,
        workspaceId,
        ...(req.header("x-samurai-operation-id") ? { operationId: stringHeader(req, "x-samurai-operation-id") } : {}),
        requestId: signed.requestId,
        timestamp: signed.timestamp,
        body: req.body ?? {}
      }
    });
    if (options.requireMembership !== false) {
      await store.getWorkspace({ workspaceId, accountId: signed.accountId });
    }
    req.samurai = { accountId: signed.accountId, requestId: signed.requestId, timestamp: signed.timestamp, workspaceId };
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

function operationContext(req: Request): WorkspaceRequestContext {
  const context = workspaceContext(req);
  return {
    ...context,
    operationId: assertOpaqueId(stringHeader(req, "x-samurai-operation-id"), "workspace_operation_id_invalid")
  };
}

function authenticated(req: Request): NonNullable<AuthenticatedRequest["samurai"]> {
  const value = (req as AuthenticatedRequest).samurai;
  if (!value) throw new WorkspaceServerError("account_authentication_required", 401);
  return value;
}

function emitWorkspaceEvent(io: SocketServer, event: { workspaceId: string; roomId: string }): void {
  emitRoomWorkspaceEvent(io, event);
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
      try {
        await store.assertRoomReadable({ workspaceId, accountId }, roomId);
        socket.emit("workspace:room-access-changed", { workspaceId, roomId });
      } catch {
        socket.leave(roomSocketRoom(workspaceId, roomId));
        socket.emit("workspace:room-access-revoked", { workspaceId, roomId });
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

function numberField(body: Record<string, unknown>, key: string): number {
  const value = body[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new WorkspaceServerError(`${key}_invalid`, 400);
  return value;
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
  if (/permission_denied|owner_permission_required/.test(message)) return new WorkspaceServerError("workspace_permission_denied", 403);
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
