import cors from "cors";
import express from "express";
import type { Express } from "express";
import { createServer } from "node:http";
import type { Server as HttpServer } from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Server as SocketServer } from "socket.io";
import { supportedLocales, type SettingsRecord, type SupportedLocale } from "@samurai-agent/core-schemas";
import { AgentRuntime, RuntimeRequestError } from "@samurai-agent/runtime";
import type { RuntimeEventSink } from "@samurai-agent/ui-protocol";
import { WorkspaceStore } from "@samurai-agent/workspace-store";

const defaultPort = 4317;

export interface CreateApiServerOptions {
  workspaceDataDir?: string;
}

export interface ApiServer {
  app: Express;
  httpServer: HttpServer;
  io: SocketServer;
  store: WorkspaceStore;
  runtime: AgentRuntime;
}

export async function createApiServer(options: CreateApiServerOptions = {}): Promise<ApiServer> {
  const workspaceDataDir = options.workspaceDataDir ?? process.env.WORKSPACE_DATA_DIR ?? fileURLToPath(new URL("../../../workspace-data", import.meta.url));
  const store = await WorkspaceStore.create({ rootDir: workspaceDataDir });
  const app = express();
  const httpServer = createServer(app);
  const io = new SocketServer(httpServer, {
    cors: {
      origin: true
    }
  });

  const emit: RuntimeEventSink = async (name, payload) => {
    io.emit(name, payload);
  };
  const runtime = new AgentRuntime(store, emit);

  app.use(cors());
  app.use(express.json({ limit: "2mb" }));

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.post("/api/chat/sessions", async (req, res, next) => {
    try {
      const settings = await store.getSettings();
      const session = await runtime.createSession({
        title: typeof req.body?.title === "string" ? req.body.title : undefined,
        ui_locale: asSupportedLocale(req.body?.ui_locale) ?? settings.ui_locale,
        output_locale: asSupportedLocale(req.body?.output_locale) ?? settings.output_locale
      });
      res.status(201).json(session);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/chat/sessions", async (_req, res, next) => {
    try {
      res.json(await store.listSessions());
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/chat/sessions/:sessionId", async (req, res, next) => {
    try {
      const session = await store.getSession(req.params.sessionId);
      if (!session) {
        res.status(404).json({ error: "session_not_found" });
        return;
      }
      const [messages, operations, artifacts, auditRecords, memory, activity] = await Promise.all([
        store.listMessages(session.id),
        store.listOperations(session.id),
        store.listArtifactsForSession(session.id),
        store.listAuditRecords(),
        store.listMemoryForSession(session.id),
        store.readActivityInputs().then((inputs) => import("@samurai-agent/audit").then(({ buildActivityInboxItems }) => buildActivityInboxItems(inputs)))
      ]);
      res.json({ session, messages, operations, artifacts, auditRecords, memory, activity });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/chat/sessions/:sessionId/messages", async (req, res, next) => {
    try {
      const content = typeof req.body?.content === "string" ? req.body.content.trim() : "";
      if (!content) {
        res.status(400).json({ error: "content_required" });
        return;
      }
      const result = await runtime.runChatTurn({
        sessionId: req.params.sessionId,
        content,
        input_locale: asSupportedLocale(req.body?.input_locale),
        output_locale: asSupportedLocale(req.body?.output_locale),
        metadata: isRecord(req.body?.metadata) ? req.body.metadata : {}
      });
      res.status(201).json(result);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/search", async (req, res, next) => {
    try {
      const query = typeof req.query.q === "string" ? req.query.q : "";
      res.json(await store.search(query));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/artifacts/:id", async (req, res, next) => {
    try {
      const artifact = await store.getArtifact(req.params.id);
      if (!artifact) {
        res.status(404).json({ error: "artifact_not_found" });
        return;
      }
      const [content, operation, auditRecords] = await Promise.all([
        store.readArtifactContent(req.params.id),
        store.getOperation(artifact.source_operation_id),
        store.listAuditRecordsForOperation(artifact.source_operation_id)
      ]);
      res.json({ artifact, content, operation, auditRecords });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/audit", async (_req, res, next) => {
    try {
      const [auditRecords, operations, policyDecisions, approvalRequests, rollbackPoints] = await Promise.all([
        store.listAuditRecords(),
        store.listOperations(),
        store.listPolicyDecisions(),
        store.listApprovalRequests(),
        store.listRollbackPoints()
      ]);
      res.json({ auditRecords, operations, policyDecisions, approvalRequests, rollbackPoints });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/activity", async (_req, res, next) => {
    try {
      const { buildActivityInboxItems } = await import("@samurai-agent/audit");
      res.json(buildActivityInboxItems(await store.readActivityInputs()));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/memory", async (_req, res, next) => {
    try {
      res.json(await store.listMemory());
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/memory/:id", async (req, res, next) => {
    try {
      const memory = await store.getMemory(req.params.id);
      if (!memory) {
        res.status(404).json({ error: "memory_not_found" });
        return;
      }
      const content = await store.readMemoryContent(req.params.id);
      res.json({ memory, content });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/memory/:id/archive", async (req, res, next) => {
    try {
      const sessionId = typeof req.body?.session_id === "string" ? req.body.session_id : "";
      if (!sessionId) {
        res.status(400).json({ error: "session_id_required" });
        return;
      }
      const result = await runtime.archiveMemory({
        memoryId: req.params.id,
        sessionId,
        actorIdentity: "owner",
        decidedBy: typeof req.body?.decided_by === "string" ? req.body.decided_by : "owner"
      });
      res.json(archiveMemoryPayload(result));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/settings", async (_req, res, next) => {
    try {
      res.json(await store.getSettings());
    } catch (error) {
      next(error);
    }
  });

  app.patch("/api/settings", async (req, res, next) => {
    try {
      const patch: Partial<SettingsRecord> = {};
      if (req.body?.theme === "light" || req.body?.theme === "dark" || req.body?.theme === "system") {
        patch.theme = req.body.theme;
      }
      const uiLocale = asSupportedLocale(req.body?.ui_locale);
      const outputLocale = asSupportedLocale(req.body?.output_locale);
      if (uiLocale) {
        patch.ui_locale = uiLocale;
      }
      if (outputLocale) {
        patch.output_locale = outputLocale;
      }
      const settings = await store.patchSettings(patch);
      io.emit("settings.updated", settings);
      res.json(settings);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/approval-requests/:id/approve", async (req, res, next) => {
    try {
      const result = await runtime.approveRequest(req.params.id, typeof req.body?.decided_by === "string" ? req.body.decided_by : "owner");
      res.json(approvalLifecyclePayload(result));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/approval-requests/:id/deny", async (req, res, next) => {
    try {
      const result = await runtime.denyRequest(
        req.params.id,
        typeof req.body?.decided_by === "string" ? req.body.decided_by : "owner",
        typeof req.body?.reason === "string" ? req.body.reason : "Denied by owner."
      );
      res.json(approvalLifecyclePayload(result));
    } catch (error) {
      next(error);
    }
  });

  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error instanceof RuntimeRequestError) {
      const status = error.code === "not_found" ? 404 : error.code === "forbidden" ? 403 : 409;
      res.status(status).json({
        error: error.code,
        message: error.message,
        ...(error.payload ? runtimeErrorPayload(error.payload) : {})
      });
      return;
    }

    console.error(error);
    res.status(500).json({
      error: "internal_error",
      message: error instanceof Error ? error.message : "Unknown error"
    });
  });

  return { app, httpServer, io, store, runtime };
}

export async function startServer(port = Number(process.env.PORT ?? defaultPort)): Promise<ApiServer> {
  const server = await createApiServer();
  await new Promise<void>((resolve) => {
    server.httpServer.listen(port, "127.0.0.1", resolve);
  });
  console.log(`Samurai Agent API listening on http://127.0.0.1:${port}`);
  return server;
}

function asSupportedLocale(value: unknown): SupportedLocale | undefined {
  return typeof value === "string" && supportedLocales.includes(value as SupportedLocale) ? (value as SupportedLocale) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function approvalLifecyclePayload(result: Awaited<ReturnType<AgentRuntime["approveRequest"]>>) {
  return {
    approvalRequest: result.approvalRequest,
    operation: result.operation,
    auditRecord: result.auditRecord,
    activity: result.activity
  };
}

function archiveMemoryPayload(result: Awaited<ReturnType<AgentRuntime["archiveMemory"]>>) {
  return {
    memory: result.memory,
    content: result.content,
    operation: result.operation,
    auditRecord: result.auditRecord,
    ...(result.rollbackPoint ? { rollbackPoint: result.rollbackPoint } : {}),
    activity: result.activity,
    changed: result.changed,
    ...(result.warning ? { warning: result.warning } : {})
  };
}

function runtimeErrorPayload(payload: NonNullable<RuntimeRequestError["payload"]>) {
  if ("approvalRequest" in payload) {
    return approvalLifecyclePayload(payload);
  }
  return archiveMemoryPayload(payload);
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === entry) {
  await startServer();
}
